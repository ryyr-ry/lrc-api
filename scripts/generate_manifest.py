#!/usr/bin/env python3
"""
Generate manifest from LRCLIB SQLite DB via RapidgzipFile + APSW VFS.

Two-pass sequential scan (no JOIN) to avoid random access through gzip.
Pass 1: sequential scan of tracks -> build in-memory metadata + lyrics mapping
Pass 2: sequential scan of lyrics -> merge with track metadata, build JSON, assign to chunks
"""

import os
import sys
import json
import time
import struct
import array
import apsw
from rapidgzip import RapidgzipFile

GZIP_PATH = sys.argv[1]
OUTPUT_PATH = sys.argv[2] if len(sys.argv) > 2 else "manifest.json"
CONFIG_TS_PATH = sys.argv[3] if len(sys.argv) > 3 else "src/config.ts"
MAX_FILE_SIZE = 18 * 1024 * 1024
FILES_PER_ROOM = 4
JSON_ARRAY_OVERHEAD = 2
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


def chunk_index_from_normalized(artist_lower, name_lower, num_chunks):
    key = (artist_lower + " " + name_lower).encode("utf-8")
    h = 0x811c9dc5
    for b in key:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h % num_chunks


def build_record_dict(track_id, name, artist, album, duration,
                       instrumental, plain, synced, lyricsfile,
                       name_lower, artist_lower, album_lower):
    return {
        "id": track_id,
        "name": name,
        "trackName": name,
        "artistName": artist,
        "albumName": album,
        "duration": duration,
        "instrumental": instrumental,
        "plainLyrics": plain,
        "syncedLyrics": synced,
        "lyricsfile": lyricsfile,
        "nameLower": name_lower,
        "artistNameLower": artist_lower,
        "albumNameLower": album_lower,
    }


def record_json_bytes(rec):
    return len(json.dumps(rec, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def add_to_manifest(rec, json_size, room_files, current_file, current_size, num_rooms):
    room_idx = chunk_index_from_normalized(
        rec["artistNameLower"], rec["nameLower"], num_rooms
    )

    record_bytes_in_array = json_size + (1 if current_file[room_idx]["track_ids"] else 0)

    if current_size[room_idx] + record_bytes_in_array > MAX_FILE_SIZE:
        file_count = len(room_files[room_idx])
        if file_count >= FILES_PER_ROOM:
            current_file[room_idx]["track_ids"].append(rec["id"])
            current_file[room_idx]["size"] += record_bytes_in_array
            current_size[room_idx] += record_bytes_in_array
        else:
            new_file = {
                "name": f"chunk-{room_idx}-{file_count}.json",
                "size": JSON_ARRAY_OVERHEAD,
                "track_ids": [],
            }
            current_file[room_idx] = new_file
            current_size[room_idx] = JSON_ARRAY_OVERHEAD
            room_files[room_idx].append(new_file)
            current_file[room_idx]["track_ids"].append(rec["id"])
            current_file[room_idx]["size"] += json_size
            current_size[room_idx] += json_size
    else:
        current_file[room_idx]["track_ids"].append(rec["id"])
        current_file[room_idx]["size"] += record_bytes_in_array
        current_size[room_idx] += record_bytes_in_array


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
    max_lyrics_id = KNOWN_LYRICS_COUNT

    track_names = [None] * (max_track_id + 1)
    track_artists = [None] * (max_track_id + 1)
    track_albums = [None] * (max_track_id + 1)
    track_durations = array.array("d", [0.0] * (max_track_id + 1))
    track_matched = bytearray(max_track_id + 1)

    lyrics_to_track = {}
    lyrics_to_tracks_multi = {}
    null_lyrics_track_ids = []

    print("\n=== PASS 1: Scanning tracks (sequential) ===", flush=True)
    t1 = time.time()
    track_count = 0
    for row in cur.execute(
        "SELECT id, name, artist_name, album_name, duration, last_lyrics_id FROM tracks ORDER BY id"
    ):
        track_id = row[0]
        if track_id > max_track_id:
            track_names.extend([None] * (track_id - max_track_id))
            track_artists.extend([None] * (track_id - max_track_id))
            track_albums.extend([None] * (track_id - max_track_id))
            track_durations.extend([0.0] * (track_id - max_track_id))
            track_matched.extend(bytearray(track_id - max_track_id))
            max_track_id = track_id

        track_names[track_id] = row[1] or ""
        track_artists[track_id] = row[2] or ""
        track_albums[track_id] = row[3] or ""
        track_durations[track_id] = row[4] if row[4] is not None else 0.0
        last_lyrics_id = row[5]

        if last_lyrics_id is not None:
            if last_lyrics_id in lyrics_to_track:
                existing = lyrics_to_track.pop(last_lyrics_id)
                lyrics_to_tracks_multi[last_lyrics_id] = [existing, track_id]
            elif last_lyrics_id in lyrics_to_tracks_multi:
                lyrics_to_tracks_multi[last_lyrics_id].append(track_id)
            else:
                lyrics_to_track[last_lyrics_id] = track_id
        else:
            null_lyrics_track_ids.append(track_id)

        track_count += 1
        if track_count % 500000 == 0:
            print(f"  tracks: {track_count} ({time.time()-t1:.1f}s)", flush=True)

    print(f"Pass 1 done: {track_count} tracks in {time.time()-t1:.1f}s", flush=True)
    print(f"  NULL last_lyrics_id: {len(null_lyrics_track_ids)}", flush=True)
    print(f"  multi-track lyrics: {len(lyrics_to_tracks_multi)}", flush=True)

    avg_record_size = 7253
    estimated_total = track_count * avg_record_size
    print(f"Estimated total JSON: {estimated_total} ({estimated_total/1073741824:.2f} GiB)", flush=True)

    room_target = 72 * 1024 * 1024
    num_rooms = max(1, int(estimated_total / room_target))
    num_rooms = ((num_rooms + 99) // 100) * 100
    print(f"Estimated rooms: {num_rooms}", flush=True)

    room_files = {}
    current_file = {}
    current_size = {}

    for i in range(num_rooms):
        room_files[i] = []
        current_file[i] = {
            "name": f"chunk-{i}-0.json",
            "size": JSON_ARRAY_OVERHEAD,
            "track_ids": [],
        }
        current_size[i] = JSON_ARRAY_OVERHEAD
        room_files[i].append(current_file[i])

    total_records = 0
    total_json_bytes = 0

    print("\n  Adding NULL-lyrics tracks to manifest...", flush=True)
    for track_id in null_lyrics_track_ids:
        name = track_names[track_id]
        artist = track_artists[track_id]
        album = track_albums[track_id]
        duration = track_durations[track_id]
        name_lower = normalize(name)
        artist_lower = normalize(artist)
        album_lower = normalize(album)
        rec = build_record_dict(
            track_id, name, artist, album, duration,
            False, None, None, None,
            name_lower, artist_lower, album_lower
        )
        json_size = record_json_bytes(rec)
        add_to_manifest(rec, json_size, room_files, current_file, current_size, num_rooms)
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

        track_ids = None
        if lyrics_id in lyrics_to_track:
            track_ids = [lyrics_to_track[lyrics_id]]
        elif lyrics_id in lyrics_to_tracks_multi:
            track_ids = lyrics_to_tracks_multi[lyrics_id]

        if track_ids:
            for track_id in track_ids:
                if track_id > max_track_id or track_names[track_id] is None:
                    continue
                name = track_names[track_id]
                artist = track_artists[track_id]
                album = track_albums[track_id]
                duration = track_durations[track_id]
                name_lower = normalize(name)
                artist_lower = normalize(artist)
                album_lower = normalize(album)
                rec = build_record_dict(
                    track_id, name, artist, album, duration,
                    instrumental, plain_lyrics, synced_lyrics, lyricsfile,
                    name_lower, artist_lower, album_lower
                )
                json_size = record_json_bytes(rec)
                add_to_manifest(rec, json_size, room_files, current_file, current_size, num_rooms)
                track_matched[track_id] = 1
                total_records += 1
                total_json_bytes += json_size
                matched_count += 1

        lyrics_count += 1
        if lyrics_count % 500000 == 0:
            print(f"  lyrics: {lyrics_count} ({time.time()-t2:.1f}s)", flush=True)

    print(f"Pass 2 done: {lyrics_count} lyrics in {time.time()-t2:.1f}s", flush=True)
    print(f"  matched tracks: {matched_count}", flush=True)

    print("\n  Adding unmatched tracks (last_lyrics_id pointing to missing lyrics)...", flush=True)
    unmatched_count = 0
    for track_id in range(1, max_track_id + 1):
        if track_names[track_id] is not None and not track_matched[track_id]:
            name = track_names[track_id]
            artist = track_artists[track_id]
            album = track_albums[track_id]
            duration = track_durations[track_id]
            name_lower = normalize(name)
            artist_lower = normalize(artist)
            album_lower = normalize(album)
            rec = build_record_dict(
                track_id, name, artist, album, duration,
                False, None, None, None,
                name_lower, artist_lower, album_lower
            )
            json_size = record_json_bytes(rec)
            add_to_manifest(rec, json_size, room_files, current_file, current_size, num_rooms)
            total_records += 1
            total_json_bytes += json_size
            unmatched_count += 1
    print(f"  unmatched tracks added: {unmatched_count}", flush=True)

    del track_names, track_artists, track_albums, track_durations
    del track_matched, lyrics_to_track, lyrics_to_tracks_multi, null_lyrics_track_ids

    print(f"\nTotal records: {total_records}", flush=True)
    print(f"Total JSON: {total_json_bytes} ({total_json_bytes/1073741824:.2f} GiB)", flush=True)

    files = []
    for room_idx in sorted(room_files.keys()):
        for f in room_files[room_idx]:
            files.append(f)

    overflow_rooms = sum(1 for r in room_files.values() if len(r) > FILES_PER_ROOM)

    manifest = {
        "total_records": total_records,
        "total_json_bytes": total_json_bytes,
        "total_files": len(files),
        "files_per_room": FILES_PER_ROOM,
        "total_rooms": num_rooms,
        "num_chunks": num_rooms,
        "max_file_size": MAX_FILE_SIZE,
        "avg_record_size": avg_record_size,
        "overflow_rooms": overflow_rooms,
        "files": files,
    }

    with open(OUTPUT_PATH, "w") as f:
        json.dump(manifest, f, separators=(",", ":"))

    ts_config_dir = os.path.dirname(CONFIG_TS_PATH)
    os.makedirs(ts_config_dir, exist_ok=True)
    with open(CONFIG_TS_PATH, "w") as f:
        f.write("// AUTO-GENERATED by scripts/generate_manifest.py. Do not edit manually.\n")
        f.write(f"export const TOTAL_ROOMS = {num_rooms};\n")
        f.write(f"export const FILES_PER_ROOM = {FILES_PER_ROOM};\n")
        f.write(f"export const TOTAL_FILES = {len(files)};\n")
        f.write(f"export const NUM_CHUNKS = {num_rooms};\n")
    print(f"  config.ts written to {CONFIG_TS_PATH}", flush=True)

    print(f"\nManifest: {len(files)} files, {num_rooms} rooms", flush=True)
    print(f"Overflow rooms (> {FILES_PER_ROOM} files): {overflow_rooms}", flush=True)
    print(f"Written to {OUTPUT_PATH}", flush=True)
    print(f"Total time: {time.time()-t0:.1f}s", flush=True)

    conn.close()
    gz.close()


if __name__ == "__main__":
    main()
