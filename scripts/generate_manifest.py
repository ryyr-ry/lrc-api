#!/usr/bin/env python3
"""
Generate manifest from LRCLIB SQLite DB via RapidgzipFile + APSW VFS.
Scans tracks + lyrics, computes JSON chunk sizes, writes manifest.json.
No disk decompression. Single pass through the DB.

Output: manifest.json with per-file metadata and track_id lists.
"""

import os
import sys
import json
import time
import struct
import apsw
from rapidgzip import RapidgzipFile

GZIP_PATH = sys.argv[1]
OUTPUT_PATH = sys.argv[2] if len(sys.argv) > 2 else "manifest.json"
CONFIG_TS_PATH = sys.argv[3] if len(sys.argv) > 3 else "src/config.ts"
MAX_FILE_SIZE = 18 * 1024 * 1024  # 18 MiB
FILES_PER_ROOM = 4


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


def chunk_index(artist, track, num_chunks):
    key = (normalize(artist) + " " + normalize(track)).encode("utf-8")
    h = 0x811c9dc5
    for b in key:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h % num_chunks


def build_record_json(row):
    """Build JSON string for a single record and return (json_str, track_id)."""
    track_id = row[0]
    name = row[1] or ""
    artist_name = row[2] or ""
    album_name = row[3] or ""
    duration = row[4] if row[4] is not None else 0
    instrumental = bool(row[8]) if row[8] is not None else False
    plain_lyrics = row[9]
    synced_lyrics = row[10]
    lyricsfile = row[11]

    rec = {
        "id": track_id,
        "name": name,
        "trackName": name,
        "artistName": artist_name,
        "albumName": album_name,
        "duration": duration,
        "instrumental": instrumental,
        "plainLyrics": plain_lyrics,
        "syncedLyrics": synced_lyrics,
        "lyricsfile": lyricsfile,
        "nameLower": normalize(name),
        "artistNameLower": normalize(artist_name),
        "albumNameLower": normalize(album_name),
    }
    return json.dumps(rec, ensure_ascii=False), track_id


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

    # First pass: count tracks to determine chunk count
    # We know from inspection: 32,254,478 tracks, 32,680,034 lyrics
    # We need to determine num_chunks based on total JSON size
    # Strategy: stream through all records, accumulate into chunks

    print("\n=== PASS 1: Scanning tracks + lyrics ===", flush=True)
    t1 = time.time()

    # We'll do a single JOIN query streaming
    # tracks.last_lyrics_id -> lyrics.id
    # This gives us one row per track with its current lyrics

    # First, estimate total JSON size from a sample
    sample_count = 100
    sample_size = 0
    count = 0
    for row in cur.execute("""
        SELECT t.id, t.name, t.artist_name, t.album_name, t.duration,
               t.last_lyrics_id,
               l.instrumental, l.has_lyricsfile,
               l.plain_lyrics, l.synced_lyrics, l.lyricsfile
        FROM tracks t
        LEFT JOIN lyrics l ON t.last_lyrics_id = l.id
        LIMIT 100
    """):
        json_str, _ = build_record_json(row)
        sample_size += len(json_str.encode("utf-8"))
        count += 1

    avg_record_size = sample_size / count if count > 0 else 0
    print(f"Sample: {count} records, avg {avg_record_size:.0f} bytes/record", flush=True)

    # Reset cursor - need a fresh query for full scan
    # With immutable=1, we can't reset. We need a new connection or
    # just use the known count from inspection
    # Actually APSW allows multiple cursors on one connection
    cur2 = conn.cursor()

    # We know from inspection: 32,254,478 tracks
    # Estimate total JSON size
    estimated_total = 32254478 * avg_record_size
    print(f"Estimated total JSON: {estimated_total} ({estimated_total/1073741824:.2f} GiB)", flush=True)

    # Determine num_chunks (each chunk room = 4 files * 18 MB = 72 MiB)
    # We want each room's total data to be ~72 MiB
    room_target = 72 * 1024 * 1024  # 72 MiB
    num_rooms = max(1, int(estimated_total / room_target))
    # Round up to be safe
    num_rooms = ((num_rooms + 99) // 100) * 100  # round to nearest 100
    print(f"Estimated rooms: {num_rooms}", flush=True)

    # Now stream all records and build manifest
    # We assign each record to chunk = hash(artist + track) % num_rooms
    # Within each chunk, we accumulate into 18 MB files (4 files per room)

    # For manifest, we need to know:
    # 1. Total number of files
    # 2. Each file's name and size
    # 3. Each file's track_id list (for FUSE read)

    # But we can't hold all records in memory. We do it in two sub-passes:
    # Sub-pass A: Assign records to rooms, record track_ids per room
    # Sub-pass B: For each room, compute file boundaries

    # Actually, we need to know the JSON size of each record to determine
    # file boundaries. So we need to compute JSON for each record anyway.

    # Strategy: stream through all records, assign to rooms,
    # and for each room, accumulate records until 18 MB, then start new file.
    # We only store track_ids and per-file byte sizes in memory.

    # room_files: { room_index: [ { "name": ..., "size": ..., "track_ids": [...] }, ... ] }
    room_files = {}  # room_idx -> list of file dicts
    current_file = {}  # room_idx -> current accumulating file dict
    current_size = {}  # room_idx -> current file byte size

    total_records = 0
    total_json_bytes = 0

    for row in cur2.execute("""
        SELECT t.id, t.name, t.artist_name, t.album_name, t.duration,
               t.last_lyrics_id,
               l.instrumental, l.has_lyricsfile,
               l.plain_lyrics, l.synced_lyrics, l.lyricsfile
        FROM tracks t
        LEFT JOIN lyrics l ON t.last_lyrics_id = l.id
        ORDER BY t.id
    """):
        json_str, track_id = build_record_json(row)
        json_bytes = len(json_str.encode("utf-8"))

        artist = row[2] or ""
        name = row[1] or ""
        room_idx = chunk_index(artist, name, num_rooms)

        if room_idx not in room_files:
            room_files[room_idx] = []
            current_file[room_idx] = {
                "name": f"chunk-{room_idx}-0.json",
                "size": 0,
                "track_ids": [],
            }
            current_size[room_idx] = 0
            room_files[room_idx].append(current_file[room_idx])

        # Check if current file is full
        if current_size[room_idx] + json_bytes > MAX_FILE_SIZE:
            file_count = len(room_files[room_idx])
            if file_count >= FILES_PER_ROOM:
                # Overflow: force append to last file even if over 18 MB
                current_file[room_idx]["track_ids"].append(track_id)
                current_file[room_idx]["size"] += json_bytes
                current_size[room_idx] += json_bytes
            else:
                new_file = {
                    "name": f"chunk-{room_idx}-{file_count}.json",
                    "size": 0,
                    "track_ids": [],
                }
                current_file[room_idx] = new_file
                current_size[room_idx] = 0
                room_files[room_idx].append(new_file)
                current_file[room_idx]["track_ids"].append(track_id)
                current_file[room_idx]["size"] += json_bytes
                current_size[room_idx] += json_bytes
        else:
            current_file[room_idx]["track_ids"].append(track_id)
            current_file[room_idx]["size"] += json_bytes
            current_size[room_idx] += json_bytes

        total_records += 1
        total_json_bytes += json_bytes

        if total_records % 200000 == 0:
            print(f"  scanned: {total_records} ({time.time()-t1:.1f}s)", flush=True)

    scan_time = time.time() - t1
    print(f"\nScan done: {total_records} records in {scan_time:.1f}s", flush=True)
    print(f"Total JSON: {total_json_bytes} ({total_json_bytes/1073741824:.2f} GiB)", flush=True)

    # Build flat file list
    files = []
    for room_idx in sorted(room_files.keys()):
        for f in room_files[room_idx]:
            files.append(f)

    # Count rooms with more than FILES_PER_ROOM files
    overflow_rooms = sum(1 for r in room_files.values() if len(r) > FILES_PER_ROOM)

    manifest = {
        "total_records": total_records,
        "total_json_bytes": total_json_bytes,
        "total_files": len(files),
        "files_per_room": FILES_PER_ROOM,
        "total_rooms": len(room_files),
        "num_chunks": num_rooms,
        "max_file_size": MAX_FILE_SIZE,
        "avg_record_size": avg_record_size,
        "scan_time_s": scan_time,
        "overflow_rooms": overflow_rooms,
        "files": files,
    }

    with open(OUTPUT_PATH, "w") as f:
        json.dump(manifest, f, separators=(",", ":"))

    config_path = os.path.join(os.path.dirname(OUTPUT_PATH), "config.json")
    config = {
        "totalRooms": len(room_files),
        "filesPerRoom": FILES_PER_ROOM,
        "totalFiles": len(files),
        "numChunks": num_rooms,
    }
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)

    ts_config_dir = os.path.dirname(CONFIG_TS_PATH)
    os.makedirs(ts_config_dir, exist_ok=True)
    with open(CONFIG_TS_PATH, "w") as f:
        f.write("// AUTO-GENERATED by scripts/generate_manifest.py. Do not edit manually.\n")
        f.write(f"export const TOTAL_ROOMS = {len(room_files)};\n")
        f.write(f"export const FILES_PER_ROOM = {FILES_PER_ROOM};\n")
        f.write(f"export const TOTAL_FILES = {len(files)};\n")
        f.write(f"export const NUM_CHUNKS = {num_rooms};\n")
    print(f"  config.ts written to {CONFIG_TS_PATH}", flush=True)

    print(f"\nManifest: {len(files)} files, {len(room_files)} rooms", flush=True)
    print(f"Overflow rooms (> {FILES_PER_ROOM} files): {overflow_rooms}", flush=True)
    print(f"Written to {OUTPUT_PATH}", flush=True)

    conn.close()
    gz.close()


if __name__ == "__main__":
    main()
