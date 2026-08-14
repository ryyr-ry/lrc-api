#!/usr/bin/env python3
"""
Generate manifest from LRCLIB SQLite DB via RapidgzipFile + APSW VFS.

Two-pass sequential scan (no JOIN) to avoid random access through gzip.
Pass 1: sequential scan of tracks -> in-memory metadata + room assignment + lyrics mapping
Pass 2: sequential scan of lyrics -> merge with track metadata, compute JSON size, finalize file boundaries

Key optimizations vs previous version:
  - Pass 1 pre-computes normalize() and room_idx, avoiding 2x normalize calls in Pass 2
  - Pass 1 accumulates per-record JSON size (no lyrics fields yet)
  - Pass 2 adds only the delta from lyrics fields (plain, synced, lyricsfile, instrumental)
  - 19 MB cap instead of 18 MB (stay under 20 MB with margin)
  - 6200 rooms (2x) to halve overflow risk, each room ~33 MB / 2 files
  - orjson for 2-5x faster serialization
  - Files per room is soft (overflow creates extra files, no data loss)
"""

import os
import sys
import json
import time
import struct
import array
import apsw
from rapidgzip import RapidgzipFile

try:
    import orjson
    HAVE_ORJSON = True
except ImportError:
    HAVE_ORJSON = False

GZIP_PATH = sys.argv[1]
OUTPUT_PATH = sys.argv[2] if len(sys.argv) > 2 else "manifest.json"
CONFIG_TS_PATH = sys.argv[3] if len(sys.argv) > 3 else "src/config.ts"

MAX_FILE_SIZE = 19 * 1024 * 1024  # 19 MiB (stay under 20 MB PartyKit limit)
FILES_PER_ROOM_SOFT = 4          # soft target, overflow creates extra files
JSON_ARRAY_OVERHEAD = 2          # "[" + "]"
JSON_COMMA = 1                   # "," between items with compact separators
KNOWN_TRACK_COUNT = 32254478
KNOWN_LYRICS_COUNT = 32680034


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
    import unicodedata
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


class RoomState:
    __slots__ = ("files", "current_file", "current_size", "file_count")

    def __init__(self, room_idx):
        f = {"name": f"chunk-{room_idx}-0.json", "size": JSON_ARRAY_OVERHEAD, "track_ids": []}
        self.files = [f]
        self.current_file = f
        self.current_size = JSON_ARRAY_OVERHEAD
        self.file_count = 1

    def add(self, track_id, json_size):
        comma = JSON_COMMA if self.current_file["track_ids"] else 0
        record_bytes = json_size + comma

        if self.current_size + record_bytes > MAX_FILE_SIZE:
            new_idx = self.file_count
            f = {
                "name": f"chunk-{self.room_idx}-{new_idx}.json",
                "size": JSON_ARRAY_OVERHEAD,
                "track_ids": [],
            }
            self.files.append(f)
            self.current_file = f
            self.current_size = JSON_ARRAY_OVERHEAD
            self.file_count += 1
            self.current_file["track_ids"].append(track_id)
            self.current_file["size"] += json_size
            self.current_size += json_size
        else:
            self.current_file["track_ids"].append(track_id)
            self.current_file["size"] += record_bytes
            self.current_size += record_bytes


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

    max_track_id = KNOWN_TRACK_COUNT

    # Pre-allocate arrays for track metadata
    # Each track: name, artist, album (strings), duration (float), name_lower, artist_lower, album_lower (strings)
    track_names = [None] * (max_track_id + 1)
    track_artists = [None] * (max_track_id + 1)
    track_albums = [None] * (max_track_id + 1)
    track_durations = array.array("d", [0.0] * (max_track_id + 1))
    track_name_lower = [None] * (max_track_id + 1)
    track_artist_lower = [None] * (max_track_id + 1)
    track_album_lower = [None] * (max_track_id + 1)
    track_room_idx = array.array("I", [0] * (max_track_id + 1))  # unsigned 32-bit
    track_base_json_bytes = array.array("I", [0] * (max_track_id + 1))  # base JSON size without lyrics fields
    track_matched = bytearray(max_track_id + 1)

    # lyrics_id -> list of track_ids
    lyrics_to_track = {}
    null_lyrics_track_ids = []

    # Estimate rooms: 203 GiB / 19 MB per file / 4 files per room
    # But with 2x rooms, each room gets ~2 files -> less overflow risk
    # 203 GiB / (19 MB * 2) = ~5600 rooms
    estimated_total = 218552162543  # from previous run
    room_target = MAX_FILE_SIZE * FILES_PER_ROOM_SOFT
    num_rooms = max(1, int(estimated_total / room_target))
    # Round up to nearest 100
    num_rooms = ((num_rooms + 99) // 100) * 100
    # Use 2x rooms to reduce per-room data size and overflow risk
    num_rooms = num_rooms * 2
    print(f"Estimated rooms: {num_rooms} (2x to reduce overflow)", flush=True)

    # Initialize rooms
    rooms = [RoomState(i) for i in range(num_rooms)]
    # Set room_idx on each (needed for add() to name new files)
    for i, r in enumerate(rooms):
        r.room_idx = i

    print("\n=== PASS 1: Scanning tracks (sequential) ===", flush=True)
    t1 = time.time()
    track_count = 0
    for row in cur.execute(
        "SELECT id, name, artist_name, album_name, duration, last_lyrics_id FROM tracks ORDER BY id"
    ):
        track_id = row[0]
        if track_id > max_track_id:
            # Extend arrays
            extend = track_id - max_track_id
            track_names.extend([None] * extend)
            track_artists.extend([None] * extend)
            track_albums.extend([None] * extend)
            track_durations.extend([0.0] * extend)
            track_name_lower.extend([None] * extend)
            track_artist_lower.extend([None] * extend)
            track_album_lower.extend([None] * extend)
            track_room_idx.extend([0] * extend)
            track_base_json_bytes.extend([0] * extend)
            track_matched.extend(bytearray(extend))
            max_track_id = track_id

        name = row[1] or ""
        artist = row[2] or ""
        album = row[3] or ""
        duration = row[4] if row[4] is not None else 0.0
        last_lyrics_id = row[5]

        name_lower = normalize(name)
        artist_lower = normalize(artist)
        album_lower = normalize(album)

        track_names[track_id] = name
        track_artists[track_id] = artist
        track_albums[track_id] = album
        track_durations[track_id] = duration
        track_name_lower[track_id] = name_lower
        track_artist_lower[track_id] = artist_lower
        track_album_lower[track_id] = album_lower

        room_idx = fnv1a_hash((artist_lower + " " + name_lower).encode("utf-8")) % num_rooms
        track_room_idx[track_id] = room_idx

        # Compute base JSON size (record without lyrics fields)
        # We'll add lyrics fields in Pass 2
        # Base record has: id, name, trackName, artistName, albumName, duration,
        #   instrumental(false), plainLyrics(null), syncedLyrics(null), lyricsfile(null),
        #   nameLower, artistNameLower, albumNameLower
        base_rec = {
            "id": track_id,
            "name": name,
            "trackName": name,
            "artistName": artist,
            "albumName": album,
            "duration": duration,
            "instrumental": False,
            "plainLyrics": None,
            "syncedLyrics": None,
            "lyricsfile": None,
            "nameLower": name_lower,
            "artistNameLower": artist_lower,
            "albumNameLower": album_lower,
        }
        base_bytes = len(dumps_json(base_rec))
        track_base_json_bytes[track_id] = base_bytes

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
    print(f"  multi-track lyrics: {sum(1 for v in lyrics_to_track.values() if len(v) > 1)}", flush=True)

    # Add null-lyrics tracks to manifest immediately (base JSON is their final JSON)
    total_records = 0
    total_json_bytes = 0
    for track_id in null_lyrics_track_ids:
        room_idx = track_room_idx[track_id]
        json_size = track_base_json_bytes[track_id]
        rooms[room_idx].add(track_id, json_size)
        total_records += 1
        total_json_bytes += json_size
    print(f"  NULL-lyrics tracks added: {len(null_lyrics_track_ids)}", flush=True)

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

            name = track_names[track_id]
            artist = track_artists[track_id]
            album = track_albums[track_id]
            duration = track_durations[track_id]
            name_lower = track_name_lower[track_id]
            artist_lower = track_artist_lower[track_id]
            album_lower = track_album_lower[track_id]
            room_idx = track_room_idx[track_id]
            base_bytes = track_base_json_bytes[track_id]

            # Compute delta: replace null fields with actual lyrics
            # Instead of re-serializing the whole record, estimate the delta
            # Base had: "plainLyrics":null,"syncedLyrics":null,"lyricsfile":null
            # Now: "plainLyrics":"...","syncedLyrics":"...","lyricsfile":"..."
            # The delta is: (serialized actual values) - (serialized null values)
            # "plainLyrics":null = 16 bytes, "syncedLyrics":null = 18 bytes, "lyricsfile":null = 16 bytes
            # "instrumental":false = 18 bytes -> "instrumental":true = 17 bytes (delta -1)

            # Simplest correct approach: serialize the full record
            rec = {
                "id": track_id,
                "name": name,
                "trackName": name,
                "artistName": artist,
                "albumName": album,
                "duration": duration,
                "instrumental": instrumental,
                "plainLyrics": plain_lyrics,
                "syncedLyrics": synced_lyrics,
                "lyricsfile": lyricsfile,
                "nameLower": name_lower,
                "artistNameLower": artist_lower,
                "albumNameLower": album_lower,
            }
            json_size = len(dumps_json(rec))

            rooms[room_idx].add(track_id, json_size)
            track_matched[track_id] = 1
            total_records += 1
            total_json_bytes += json_size
            matched_count += 1

        lyrics_count += 1
        if lyrics_count % 500000 == 0:
            print(f"  lyrics: {lyrics_count} ({time.time()-t2:.1f}s)", flush=True)

    print(f"Pass 2 done: {lyrics_count} lyrics in {time.time()-t2:.1f}s", flush=True)
    print(f"  matched tracks: {matched_count}", flush=True)

    # Add unmatched tracks (last_lyrics_id pointing to missing lyrics)
    unmatched_count = 0
    for track_id in range(1, max_track_id + 1):
        if track_names[track_id] is not None and not track_matched[track_id]:
            room_idx = track_room_idx[track_id]
            json_size = track_base_json_bytes[track_id]
            rooms[room_idx].add(track_id, json_size)
            total_records += 1
            total_json_bytes += json_size
            unmatched_count += 1
    print(f"  unmatched tracks added: {unmatched_count}", flush=True)

    # Free memory
    del track_names, track_artists, track_albums, track_durations
    del track_name_lower, track_artist_lower, track_album_lower
    del track_room_idx, track_base_json_bytes, track_matched
    del lyrics_to_track, null_lyrics_track_ids

    print(f"\nTotal records: {total_records}", flush=True)
    print(f"Total JSON: {total_json_bytes} ({total_json_bytes/1073741824:.2f} GiB)", flush=True)

    # Build flat file list
    files = []
    overflow_rooms = 0
    max_files_in_room = 0
    for room in rooms:
        if len(room.files) > FILES_PER_ROOM_SOFT:
            overflow_rooms += 1
        if len(room.files) > max_files_in_room:
            max_files_in_room = len(room.files)
        for f in room.files:
            files.append(f)

    print(f"Manifest: {len(files)} files, {num_rooms} rooms", flush=True)
    print(f"Overflow rooms (> {FILES_PER_ROOM_SOFT} files): {overflow_rooms}", flush=True)
    print(f"Max files in a room: {max_files_in_room}", flush=True)

    # Verify no file exceeds 20 MB
    oversized = sum(1 for f in files if f["size"] > 20 * 1024 * 1024)
    if oversized > 0:
        print(f"WARNING: {oversized} files exceed 20 MB!", flush=True)
        max_size = max(f["size"] for f in files)
        print(f"  Max file size: {max_size} bytes ({max_size/1048576:.2f} MB)", flush=True)

    manifest = {
        "total_records": total_records,
        "total_json_bytes": total_json_bytes,
        "total_files": len(files),
        "files_per_room": FILES_PER_ROOM_SOFT,
        "total_rooms": num_rooms,
        "num_chunks": num_rooms,
        "max_file_size": MAX_FILE_SIZE,
        "overflow_rooms": overflow_rooms,
        "files": files,
    }

    with open(OUTPUT_PATH, "wb") as f:
        if HAVE_ORJSON:
            f.write(orjson.dumps(manifest))
        else:
            f.write(json.dumps(manifest, separators=(",", ":")).encode("utf-8"))

    ts_config_dir = os.path.dirname(CONFIG_TS_PATH)
    os.makedirs(ts_config_dir, exist_ok=True)
    with open(CONFIG_TS_PATH, "w") as f:
        f.write("// AUTO-GENERATED by scripts/generate_manifest.py. Do not edit manually.\n")
        f.write(f"export const TOTAL_ROOMS = {num_rooms};\n")
        f.write(f"export const FILES_PER_ROOM = {FILES_PER_ROOM_SOFT};\n")
        f.write(f"export const TOTAL_FILES = {len(files)};\n")
        f.write(f"export const NUM_CHUNKS = {num_rooms};\n")
    print(f"  config.ts written to {CONFIG_TS_PATH}", flush=True)
    print(f"  Total time: {time.time()-t0:.1f}s", flush=True)

    conn.close()
    gz.close()


if __name__ == "__main__":
    main()
