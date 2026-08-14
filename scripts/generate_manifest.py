#!/usr/bin/env python3
"""
Generate manifest and zstd-compressed chunk files from LRCLIB SQLite DB.

Two-pass sequential scan (no JOIN) to avoid random access through gzip.
Pass 1: Scan tracks -> metadata + room assignment + lyrics mapping
Pass 2: Scan lyrics -> construct records -> write to zstd chunk files

Output:
  - manifest.json: file list with uncompressed sizes (for FUSE)
  - src/config.ts: TOTAL_ROOMS, TOTAL_FILES
  - chunk-{room}-{part}.json.zst files in chunk directory
"""

import os
import sys
import json
import time
import struct
import array
import unicodedata
import shutil
import apsw
import zstandard
from rapidgzip import RapidgzipFile

try:
    import orjson
    HAVE_ORJSON = True
except ImportError:
    HAVE_ORJSON = False

GZIP_PATH = sys.argv[1]
MANIFEST_PATH = sys.argv[2] if len(sys.argv) > 2 else "manifest.json"
CONFIG_TS_PATH = sys.argv[3] if len(sys.argv) > 3 else "src/config.ts"
CHUNK_DIR = sys.argv[4] if len(sys.argv) > 4 else "chunks"

MAX_FILE_SIZE = 18 * 1024 * 1024
ZSTD_LEVEL = 3
KNOWN_TRACK_COUNT = 32254478
ESTIMATED_TOTAL_JSON = 218552162543


class GzipVFSFile:
    def __init__(self, gz_file, db_size):
        self._gz = gz_file
        self._size = db_size
        self._level = apsw.SQLITE_LOCK_NONE

    def xRead(self, amount, offset):
        self._gz.seek(offset)
        data = self._gz.read(amount)
        if len(data) < amount:
            data += b"\x00" * (amount - len(data))
        return data

    def xFileSize(self):
        return self._size

    def xClose(self):
        pass

    def xLock(self, level):
        self._level = level

    def xUnlock(self, level):
        self._level = level

    def xCheckReservedLock(self):
        return False

    def xSync(self, flags):
        return True

    def xSectorSize(self):
        return 4096

    def xDeviceCharacteristics(self):
        return apsw.SQLITE_IOCAP_IMMUTABLE

    def xTruncate(self, newsize):
        pass

    def xWrite(self, data, offset):
        pass

    def xFileControl(self, op, ptr):
        return False

    def xShmMap(self, *a):
        raise apsw.IOError("Shared memory not supported")

    def xShmBarrier(self):
        pass

    def xShmUnmap(self):
        pass


class GzipVFS(apsw.VFS):
    def __init__(self, gz_file, db_size, name="gzipvfs"):
        self._gz = gz_file
        self._size = db_size
        self.vfs_name = name
        super().__init__(name, base="")

    def xOpen(self, name, flags):
        return GzipVFSFile(self._gz, self._size)

    def xDelete(self, name, syncdir):
        pass

    def xAccess(self, name, flags):
        return True

    def xFullPathname(self, name):
        return name

    def xSleep(self, us):
        time.sleep(us / 1e6)
        return True

    def xCurrentTime(self):
        return time.time() / 86400.0 + 2440587.5

    def xGetLastError(self):
        return (0, "")

    def xDlError(self):
        return ""

    def xRandomness(self, n):
        return os.urandom(n)


def normalize(text):
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", text).lower()
    for c in "`~!@#$%^&*()_|+-=?;:\",.<>{}[]\\/\x00\n":
        s = s.replace(c, " ")
    s = s.replace("'", "").replace("\u2019", "")
    return " ".join(s.split())


def fnv1a_hash(key_bytes):
    h = 0x811c9dc5
    for b in key_bytes:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def dumps_json(obj):
    if HAVE_ORJSON:
        return orjson.dumps(obj)
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class RoomWriter:
    """Writes records to zstd-compressed chunk files for one room."""

    __slots__ = ("room_idx", "chunk_dir", "part", "handle", "compressor",
                 "uncompressed_size", "record_count", "files")

    def __init__(self, room_idx, chunk_dir):
        self.room_idx = room_idx
        self.chunk_dir = chunk_dir
        self.part = 0
        self.handle = None
        self.compressor = None
        self.uncompressed_size = 0
        self.record_count = 0
        self.files = []

    def _open_new_file(self):
        path = os.path.join(self.chunk_dir, f"chunk-{self.room_idx}-{self.part}.json.zst")
        self.handle = open(path, "wb")
        cctx = zstandard.ZstdCompressor(level=ZSTD_LEVEL)
        self.compressor = cctx.stream_writer(self.handle)
        self.compressor.write(b"[")
        self.uncompressed_size = 1
        self.record_count = 0

    def write_record(self, json_bytes):
        if self.compressor is None:
            self._open_new_file()

        if self.record_count > 0:
            self.compressor.write(b",")
            self.uncompressed_size += 1

        self.compressor.write(json_bytes)
        self.uncompressed_size += len(json_bytes)
        self.record_count += 1

        if self.uncompressed_size >= MAX_FILE_SIZE:
            self._close_current_file()

    def _close_current_file(self):
        if self.compressor is None:
            return
        self.compressor.write(b"]")
        self.uncompressed_size += 1
        self.compressor.close()
        self.handle = None
        self.files.append({
            "name": f"chunk-{self.room_idx}-{self.part}.json",
            "size": self.uncompressed_size,
        })
        self.compressor = None
        self.part += 1

    def flush(self):
        if self.compressor is not None:
            self._close_current_file()


def main():
    print(f"Opening: {GZIP_PATH}", flush=True)
    t0 = time.time()
    gz = RapidgzipFile(GZIP_PATH, parallelization=os.cpu_count())

    header = gz.read(100)
    if header[:16] != b"SQLite format 3\x00":
        print(f"ERROR: Not SQLite. Header: {header[:16]}", flush=True)
        sys.exit(1)

    page_size = struct.unpack(">H", header[16:18])[0]
    if page_size == 1:
        page_size = 65536
    page_count = struct.unpack(">I", header[28:32])[0]
    db_size = page_size * page_count
    print(f"DB size: {db_size} ({db_size/1073741824:.2f} GiB)", flush=True)

    gz.seek(0)
    vfs = GzipVFS(gz, db_size)
    conn = apsw.Connection(
        "file:dummy?immutable=1",
        vfs=vfs.vfs_name,
        flags=apsw.SQLITE_OPEN_READONLY | apsw.SQLITE_OPEN_URI,
    )
    cur = conn.cursor()
    cur2 = conn.cursor()

    shutil.rmtree(CHUNK_DIR, ignore_errors=True)
    os.makedirs(CHUNK_DIR, exist_ok=True)

    room_target = 72 * 1024 * 1024
    num_rooms = max(1, int(ESTIMATED_TOTAL_JSON / room_target))
    num_rooms = ((num_rooms + 99) // 100) * 100
    num_rooms = num_rooms * 2
    print(f"Estimated rooms: {num_rooms}", flush=True)

    max_track_id = KNOWN_TRACK_COUNT
    track_names = [None] * (max_track_id + 1)
    track_artists = [None] * (max_track_id + 1)
    track_albums = [None] * (max_track_id + 1)
    track_durations = array.array("d", [0.0] * (max_track_id + 1))
    track_name_lower = [None] * (max_track_id + 1)
    track_artist_lower = [None] * (max_track_id + 1)
    track_album_lower = [None] * (max_track_id + 1)
    track_room_idx = array.array("I", [0] * (max_track_id + 1))
    track_matched = bytearray(max_track_id + 1)

    lyrics_to_track = {}
    null_lyrics_track_ids = []

    print("\n=== PASS 1: Scanning tracks (sequential) ===", flush=True)
    t1 = time.time()
    track_count = 0
    for row in cur.execute(
        "SELECT id, name, artist_name, album_name, duration, last_lyrics_id FROM tracks ORDER BY id"
    ):
        track_id = row[0]
        if track_id > max_track_id:
            extend = track_id - max_track_id
            track_names.extend([None] * extend)
            track_artists.extend([None] * extend)
            track_albums.extend([None] * extend)
            track_durations.extend([0.0] * extend)
            track_name_lower.extend([None] * extend)
            track_artist_lower.extend([None] * extend)
            track_album_lower.extend([None] * extend)
            track_room_idx.extend([0] * extend)
            track_matched.extend(bytearray(extend))
            max_track_id = track_id

        name = row[1] or ""
        artist = row[2] or ""
        album = row[3] or ""
        duration = row[4] if row[4] is not None else 0.0
        last_lyrics_id = row[5]

        nl = normalize(name)
        al = normalize(artist)
        bl = normalize(album)

        track_names[track_id] = name
        track_artists[track_id] = artist
        track_albums[track_id] = album
        track_durations[track_id] = duration
        track_name_lower[track_id] = nl
        track_artist_lower[track_id] = al
        track_album_lower[track_id] = bl

        room_idx = fnv1a_hash((al + " " + nl).encode("utf-8")) % num_rooms
        track_room_idx[track_id] = room_idx

        if last_lyrics_id is not None:
            if last_lyrics_id in lyrics_to_track:
                lyrics_to_track[last_lyrics_id].append(track_id)
            else:
                lyrics_to_track[last_lyrics_id] = [track_id]
        else:
            null_lyrics_track_ids.append(track_id)

        track_count += 1
        if track_count % 500000 == 0:
            print(f"  tracks: {track_count} ({time.time()-t1:.1f}s)", flush=True)

    print(f"Pass 1 done: {track_count} tracks in {time.time()-t1:.1f}s", flush=True)
    print(f"  NULL last_lyrics_id: {len(null_lyrics_track_ids)}", flush=True)

    room_writers = {}
    total_records = 0
    total_json_bytes = 0

    print("\n=== Writing null-lyrics tracks ===", flush=True)
    t_null = time.time()
    for track_id in null_lyrics_track_ids:
        room_idx = track_room_idx[track_id]
        rw = room_writers.get(room_idx)
        if rw is None:
            rw = RoomWriter(room_idx, CHUNK_DIR)
            room_writers[room_idx] = rw

        rec = {
            "id": track_id,
            "name": track_names[track_id],
            "trackName": track_names[track_id],
            "artistName": track_artists[track_id],
            "albumName": track_albums[track_id],
            "duration": track_durations[track_id],
            "instrumental": False,
            "plainLyrics": None,
            "syncedLyrics": None,
            "lyricsfile": None,
            "nameLower": track_name_lower[track_id],
            "artistNameLower": track_artist_lower[track_id],
            "albumNameLower": track_album_lower[track_id],
        }
        jb = dumps_json(rec)
        rw.write_record(jb)
        track_matched[track_id] = 1
        total_records += 1
        total_json_bytes += len(jb)
    print(f"  Null-lyrics written: {len(null_lyrics_track_ids)} ({time.time()-t_null:.1f}s)", flush=True)
    del null_lyrics_track_ids

    print("\n=== PASS 2: Scanning lyrics (sequential) ===", flush=True)
    t2 = time.time()
    lyrics_count = 0
    matched_count = 0
    for row in cur2.execute(
        "SELECT id, instrumental, plain_lyrics, synced_lyrics, lyricsfile FROM lyrics ORDER BY id"
    ):
        lyrics_id = row[0]
        instrumental = bool(row[1]) if row[1] is not None else False
        plain_lyrics = row[2]
        synced_lyrics = row[3]
        lyricsfile = row[4]

        track_ids = lyrics_to_track.get(lyrics_id)
        if not track_ids:
            lyrics_count += 1
            if lyrics_count % 500000 == 0:
                print(f"  lyrics: {lyrics_count} ({time.time()-t2:.1f}s)", flush=True)
            continue

        for track_id in track_ids:
            if track_id > max_track_id or track_names[track_id] is None:
                continue

            room_idx = track_room_idx[track_id]
            rw = room_writers.get(room_idx)
            if rw is None:
                rw = RoomWriter(room_idx, CHUNK_DIR)
                room_writers[room_idx] = rw

            rec = {
                "id": track_id,
                "name": track_names[track_id],
                "trackName": track_names[track_id],
                "artistName": track_artists[track_id],
                "albumName": track_albums[track_id],
                "duration": track_durations[track_id],
                "instrumental": instrumental,
                "plainLyrics": plain_lyrics,
                "syncedLyrics": synced_lyrics,
                "lyricsfile": lyricsfile,
                "nameLower": track_name_lower[track_id],
                "artistNameLower": track_artist_lower[track_id],
                "albumNameLower": track_album_lower[track_id],
            }
            jb = dumps_json(rec)
            rw.write_record(jb)
            track_matched[track_id] = 1
            total_records += 1
            total_json_bytes += len(jb)
            matched_count += 1

        lyrics_count += 1
        if lyrics_count % 500000 == 0:
            print(f"  lyrics: {lyrics_count} ({time.time()-t2:.1f}s)", flush=True)

    print(f"Pass 2 done: {lyrics_count} lyrics in {time.time()-t2:.1f}s", flush=True)
    print(f"  matched tracks: {matched_count}", flush=True)

    del lyrics_to_track

    print("\n=== Writing unmatched tracks ===", flush=True)
    t_unm = time.time()
    unmatched_count = 0
    for track_id in range(1, max_track_id + 1):
        if track_names[track_id] is not None and not track_matched[track_id]:
            room_idx = track_room_idx[track_id]
            rw = room_writers.get(room_idx)
            if rw is None:
                rw = RoomWriter(room_idx, CHUNK_DIR)
                room_writers[room_idx] = rw

            rec = {
                "id": track_id,
                "name": track_names[track_id],
                "trackName": track_names[track_id],
                "artistName": track_artists[track_id],
                "albumName": track_albums[track_id],
                "duration": track_durations[track_id],
                "instrumental": False,
                "plainLyrics": None,
                "syncedLyrics": None,
                "lyricsfile": None,
                "nameLower": track_name_lower[track_id],
                "artistNameLower": track_artist_lower[track_id],
                "albumNameLower": track_album_lower[track_id],
            }
            jb = dumps_json(rec)
            rw.write_record(jb)
            total_records += 1
            total_json_bytes += len(jb)
            unmatched_count += 1
    print(f"  Unmatched: {unmatched_count} ({time.time()-t_unm:.1f}s)", flush=True)

    del track_names, track_artists, track_albums, track_durations
    del track_name_lower, track_artist_lower, track_album_lower
    del track_room_idx, track_matched

    print("\n=== Flushing room writers ===", flush=True)
    t_flush = time.time()
    all_files = []
    for room_idx in sorted(room_writers.keys()):
        rw = room_writers[room_idx]
        rw.flush()
        all_files.extend(rw.files)
    del room_writers
    print(f"  Flushed in {time.time()-t_flush:.1f}s", flush=True)

    print(f"\nTotal records: {total_records}", flush=True)
    print(f"Total JSON: {total_json_bytes} ({total_json_bytes/1073741824:.2f} GiB)", flush=True)
    print(f"Chunk files: {len(all_files)}", flush=True)
    print(f"Rooms with data: {sum(1 for f in all_files)}", flush=True)

    oversized = sum(1 for f in all_files if f["size"] > 20 * 1024 * 1024)
    if oversized > 0:
        print(f"WARNING: {oversized} files exceed 20 MB!", flush=True)
        max_size = max(f["size"] for f in all_files)
        print(f"  Max file size: {max_size} bytes ({max_size/1048576:.2f} MB)", flush=True)

    manifest = {
        "total_records": total_records,
        "total_json_bytes": total_json_bytes,
        "total_files": len(all_files),
        "total_rooms": num_rooms,
        "files": all_files,
    }

    with open(MANIFEST_PATH, "wb") as f:
        if HAVE_ORJSON:
            f.write(orjson.dumps(manifest))
        else:
            f.write(json.dumps(manifest, separators=(",", ":")).encode("utf-8"))

    ts_config_dir = os.path.dirname(CONFIG_TS_PATH)
    os.makedirs(ts_config_dir, exist_ok=True)
    with open(CONFIG_TS_PATH, "w") as f:
        f.write("// AUTO-GENERATED by scripts/generate_manifest.py. Do not edit manually.\n")
        f.write(f"export const TOTAL_ROOMS = {num_rooms};\n")
        f.write(f"export const TOTAL_FILES = {len(all_files)};\n")
    print(f"  config.ts written to {CONFIG_TS_PATH}", flush=True)
    print(f"  Total time: {time.time()-t0:.1f}s", flush=True)

    conn.close()
    gz.close()


if __name__ == "__main__":
    main()
