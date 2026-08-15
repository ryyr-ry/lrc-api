#!/usr/bin/env python3
"""
Generate manifest and zstd-compressed chunk files from LRCLIB SQLite DB.

Two-pass sequential scan (no JOIN) to avoid random access through gzip.
Pass 1: Scan tracks -> packed string buffer + array-based lyrics mapping
Pass 2: Scan lyrics -> construct records -> write to zstd chunk files

Memory optimizations vs previous version:
  - Single bytearray for all string data (eliminates Python str overhead ~49B/obj)
  - array.array linked list for lyrics mapping (260 MB vs 2-3 GB dict)
  - No normalized string storage (compute on-the-fly with str.translate)
  - str.translate for normalize() (5x faster than multiple replace() calls)
  - Total memory: ~3.5 GB (vs ~15 GB previous)
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
KNOWN_LYRICS_COUNT = 32680034
ESTIMATED_TOTAL_JSON = 218552162543
SEP = b"\x01"

_PUNCT_TABLE = str.maketrans({
    "`": " ", "~": " ", "!": " ", "@": " ", "#": " ", "$": " ", "%": " ",
    "^": " ", "&": " ", "*": " ", "(": " ", ")": " ", "_": " ", "|": " ",
    "+": " ", "-": " ", "=": " ", "?": " ", ";": " ", ":": " ", '"': " ",
    ",": " ", ".": " ", "<": " ", ">": " ", "{": " ", "}": " ", "[": " ",
    "]": " ", "\\": " ", "/": " ", "\0": " ", "\n": " ",
    "'": None, "\u2019": None,
})


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
    s = s.translate(_PUNCT_TABLE)
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
    _normalize = normalize
    _fnv = fnv1a_hash
    _dumps = dumps_json

    print(f"Opening: {GZIP_PATH}", flush=True)
    t0 = time.time()
    gz = RapidgzipFile(GZIP_PATH, parallelization=os.cpu_count())

    try:
        _main_body(gz, t0, _normalize, _fnv, _dumps)
    finally:
        try:
            gz.close()
        except Exception:
            pass


def _main_body(gz, t0, _normalize, _fnv, _dumps):

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
    print(f"Estimated rooms: {num_rooms}", flush=True)

    chunks_per_agg = 72
    num_aggregators_raw = max(6, (num_rooms + chunks_per_agg - 1) // chunks_per_agg)
    num_aggregators = ((num_aggregators_raw + 5) // 6) * 6
    num_supers = 10
    print(f"  aggregators: {num_aggregators} (chunks_per_agg={chunks_per_agg})", flush=True)
    print(f"  supers: {num_supers}", flush=True)

    max_tid = KNOWN_TRACK_COUNT
    max_lid = KNOWN_LYRICS_COUNT + 100000

    string_data = bytearray()
    str_offsets = array.array("I", [0] * (max_tid + 1))
    str_lens = array.array("I", [0] * (max_tid + 1))
    durations = array.array("d", [0.0] * (max_tid + 1))
    room_indices = array.array("I", [0] * (max_tid + 1))
    matched = bytearray(max_tid + 1)
    lyrics_first = array.array("I", [0] * (max_lid + 1))
    next_track = array.array("I", [0] * (max_tid + 1))

    null_ids = []

    print("\n=== PASS 1: Scanning tracks (sequential) ===", flush=True)
    t1 = time.time()
    tc = 0
    for row in cur.execute(
        "SELECT id, name, artist_name, album_name, duration, last_lyrics_id FROM tracks ORDER BY id"
    ):
        tid = row[0]
        if tid > max_tid:
            ext = tid - max_tid
            str_offsets.extend([0] * ext)
            str_lens.extend([0] * ext)
            durations.extend([0.0] * ext)
            room_indices.extend([0] * ext)
            matched.extend(bytearray(ext))
            next_track.extend([0] * ext)
            max_tid = tid

        name = row[1] or ""
        artist = row[2] or ""
        album = row[3] or ""

        entry = name.encode("utf-8") + SEP + artist.encode("utf-8") + SEP + album.encode("utf-8")
        str_offsets[tid] = len(string_data)
        string_data.extend(entry)
        str_lens[tid] = len(entry)

        durations[tid] = row[4] if row[4] is not None else 0.0

        nl = _normalize(name)
        al = _normalize(artist)
        room_indices[tid] = _fnv((al + " " + nl).encode("utf-8")) % num_rooms

        lid = row[5]
        if lid is not None:
            if lid >= len(lyrics_first):
                lyrics_first.extend([0] * (lid - len(lyrics_first) + 1))
            next_track[tid] = lyrics_first[lid]
            lyrics_first[lid] = tid
        else:
            null_ids.append(tid)

        tc += 1
        if tc % 1000000 == 0:
            print(f"  tracks: {tc} ({time.time()-t1:.1f}s)", flush=True)

    print(f"Pass 1 done: {tc} tracks in {time.time()-t1:.1f}s", flush=True)
    print(f"  NULL last_lyrics_id: {len(null_ids)}", flush=True)

    room_writers = {}
    total_records = 0
    total_json_bytes = 0

    print("\n=== Writing null-lyrics tracks ===", flush=True)
    t_null = time.time()
    _str_data = string_data
    _str_off = str_offsets
    _str_len = str_lens
    _dur = durations
    _ri = room_indices
    _norm = _normalize

    for tid in null_ids:
        ridx = _ri[tid]
        rw = room_writers.get(ridx)
        if rw is None:
            rw = RoomWriter(ridx, CHUNK_DIR)
            room_writers[ridx] = rw

        start = _str_off[tid]
        raw = _str_data[start:start + _str_len[tid]]
        parts = raw.split(SEP)
        name = parts[0].decode("utf-8")
        artist = parts[1].decode("utf-8")
        album = parts[2].decode("utf-8")
        dur = _dur[tid]

        rec = {
            "id": tid, "name": name, "trackName": name,
            "artistName": artist, "albumName": album, "duration": dur,
            "instrumental": False, "plainLyrics": None, "syncedLyrics": None,
            "lyricsfile": None,
            "nameLower": _norm(name), "artistNameLower": _norm(artist), "albumNameLower": _norm(album),
        }
        jb = _dumps(rec)
        rw.write_record(jb)
        matched[tid] = 1
        total_records += 1
        total_json_bytes += len(jb)
    print(f"  Null-lyrics: {len(null_ids)} ({time.time()-t_null:.1f}s)", flush=True)
    del null_ids

    print("\n=== PASS 2: Scanning lyrics (sequential) ===", flush=True)
    t2 = time.time()
    lc = 0
    mc = 0
    for row in cur2.execute(
        "SELECT id, instrumental, plain_lyrics, synced_lyrics, lyricsfile FROM lyrics ORDER BY id"
    ):
        lid = row[0]
        instrumental = bool(row[1]) if row[1] is not None else False
        plain = row[2]
        synced = row[3]
        lfile = row[4]

        tid = lyrics_first[lid] if lid < len(lyrics_first) else 0
        while tid != 0:
            if tid <= max_tid and str_lens[tid] > 0:
                ridx = room_indices[tid]
                rw = room_writers.get(ridx)
                if rw is None:
                    rw = RoomWriter(ridx, CHUNK_DIR)
                    room_writers[ridx] = rw

                start = str_offsets[tid]
                raw = string_data[start:start + str_lens[tid]]
                parts = raw.split(SEP)
                name = parts[0].decode("utf-8")
                artist = parts[1].decode("utf-8")
                album = parts[2].decode("utf-8")
                dur = durations[tid]

                rec = {
                    "id": tid, "name": name, "trackName": name,
                    "artistName": artist, "albumName": album, "duration": dur,
                    "instrumental": instrumental, "plainLyrics": plain,
                    "syncedLyrics": synced, "lyricsfile": lfile,
                    "nameLower": _norm(name), "artistNameLower": _norm(artist), "albumNameLower": _norm(album),
                }
                jb = _dumps(rec)
                rw.write_record(jb)
                matched[tid] = 1
                total_records += 1
                total_json_bytes += len(jb)
                mc += 1

            tid = next_track[tid]

        lc += 1
        if lc % 1000000 == 0:
            print(f"  lyrics: {lc} ({time.time()-t2:.1f}s)", flush=True)

    print(f"Pass 2 done: {lc} lyrics in {time.time()-t2:.1f}s", flush=True)
    print(f"  matched tracks: {mc}", flush=True)

    del lyrics_first, next_track

    print("\n=== Writing unmatched tracks ===", flush=True)
    t_unm = time.time()
    uc = 0
    for tid in range(1, max_tid + 1):
        if str_lens[tid] > 0 and not matched[tid]:
            ridx = room_indices[tid]
            rw = room_writers.get(ridx)
            if rw is None:
                rw = RoomWriter(ridx, CHUNK_DIR)
                room_writers[ridx] = rw

            start = str_offsets[tid]
            raw = string_data[start:start + str_lens[tid]]
            parts = raw.split(SEP)
            name = parts[0].decode("utf-8")
            artist = parts[1].decode("utf-8")
            album = parts[2].decode("utf-8")
            dur = durations[tid]

            rec = {
                "id": tid, "name": name, "trackName": name,
                "artistName": artist, "albumName": album, "duration": dur,
                "instrumental": False, "plainLyrics": None, "syncedLyrics": None,
                "lyricsfile": None,
                "nameLower": _norm(name), "artistNameLower": _norm(artist), "albumNameLower": _norm(album),
            }
            jb = _dumps(rec)
            rw.write_record(jb)
            total_records += 1
            total_json_bytes += len(jb)
            uc += 1
    print(f"  Unmatched: {uc} ({time.time()-t_unm:.1f}s)", flush=True)

    del string_data, str_offsets, str_lens, durations, room_indices, matched

    print("\n=== Flushing room writers ===", flush=True)
    t_flush = time.time()
    all_files = []
    for ridx in sorted(room_writers.keys()):
        rw = room_writers[ridx]
        rw.flush()
        all_files.extend(rw.files)
    del room_writers
    print(f"  Flushed in {time.time()-t_flush:.1f}s", flush=True)

    print(f"\nTotal records: {total_records}", flush=True)
    print(f"Total JSON: {total_json_bytes} ({total_json_bytes/1073741824:.2f} GiB)", flush=True)
    print(f"Chunk files: {len(all_files)}", flush=True)

    oversized = sum(1 for f in all_files if f["size"] > 20 * 1024 * 1024)
    if oversized > 0:
        print(f"WARNING: {oversized} files exceed 20 MB!", flush=True)
        mx = max(f["size"] for f in all_files)
        print(f"  Max: {mx} bytes ({mx/1048576:.2f} MB)", flush=True)

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

    ts_dir = os.path.dirname(CONFIG_TS_PATH)
    os.makedirs(ts_dir, exist_ok=True)
    with open(CONFIG_TS_PATH, "w") as f:
        f.write("// AUTO-GENERATED by scripts/generate_manifest.py. Do not edit manually.\n")
        f.write(f"export const TOTAL_ROOMS = {num_rooms};\n")
        f.write(f"export const TOTAL_FILES = {len(all_files)};\n")
        f.write(f"export const FILES_PER_ROOM = 4;\n")
        f.write(f"export const NUM_CHUNKS = {num_rooms};\n")
        f.write(f"export const NUM_AGGREGATORS = {num_aggregators};\n")
        f.write(f"export const CHUNKS_PER_AGG = {chunks_per_agg};\n")
        f.write(f"export const NUM_SUPERS = {num_supers};\n")
    print(f"  config.ts written to {CONFIG_TS_PATH}", flush=True)
    print(f"  Total time: {time.time()-t0:.1f}s", flush=True)

    conn.close()


if __name__ == "__main__":
    main()
