#!/usr/bin/env python3
"""
Generate manifest and zstd-compressed chunk files from LRCLIB SQLite DB.
Uses direct SQLite page parsing (no APSW) for sequential gzip reading.

Single-pass extraction of tracks and lyrics via page-format parsing.
lyrics text is spilled to a zstd-compressed temp file, then read back
to join with tracks metadata and write chunk files.
"""

import os
import sys
import time
import struct
import array
import unicodedata
import zstandard

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sqlite_page_parser import (
    SQLitePageParser, decode_varint_inline, serial_type_size,
    decode_serial_value, compute_local_payload_size, parse_schema,
    parse_leaf_table_cells, classify_record, RingBuffer,
)

try:
    import orjson
    HAVE_ORJSON = True
except ImportError:
    import json
    HAVE_ORJSON = False

GZIP_PATH = sys.argv[1]
MANIFEST_PATH = sys.argv[2] if len(sys.argv) > 2 else "manifest.json"
CONFIG_TS_PATH = sys.argv[3] if len(sys.argv) > 3 else "src/config.ts"
CHUNK_DIR = sys.argv[4] if len(sys.argv) > 4 else "chunks"
LYRICS_TEMP_PATH = "/tmp/lyrics_temp.zst"

MAX_FILE_SIZE = 18 * 1024 * 1024
ZSTD_LEVEL = 3
KNOWN_TRACK_COUNT = 32254478
KNOWN_LYRICS_COUNT = 32680034
SEP = b"\x01"

_PUNCT_TABLE = str.maketrans({
    "`": " ", "~": " ", "!": " ", "@": " ", "#": " ", "$": " ", "%": " ",
    "^": " ", "&": " ", "*": " ", "(": " ", ")": " ", "_": " ", "|": " ",
    "+": " ", "-": " ", "=": " ", "?": " ", ";": " ", ":": " ", '"': " ",
    ",": " ", ".": " ", "<": " ", ">": " ", "{": " ", "}": " ", "[": " ",
    "]": " ", "\\": " ", "/": " ", "\0": " ", "\n": " ",
    "'": None, "\u2019": None,
})


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


def decode_tracks_record(payload, header_length, encoding, tracks_col_names):
    """Decode only needed columns from a tracks record.
    Needed: name(1), artist_name(2), album_name(3), duration(7), last_lyrics_id(8)
    Skip: id(0, IPK), name_lower(4), artist_name_lower(5), album_name_lower(6), created_at(9), updated_at(10)
    """
    h_off = 0
    header_len, hvsz = decode_varint_inline(payload, h_off)
    h_off += hvsz

    serial_types = []
    while h_off < header_length:
        st, stvsz = decode_varint_inline(payload, h_off)
        serial_types.append(st)
        h_off += stvsz

    name = None
    artist = None
    album = None
    dur = 0.0
    last_lid = None

    body_off = header_length
    ncols = len(serial_types)

    needed = {1: "name", 2: "artist_name", 3: "album_name", 7: "duration", 8: "last_lyrics_id"}

    for ci in range(ncols):
        st = serial_types[ci]
        sz = serial_type_size(st)

        if ci in needed:
            val, body_off = decode_serial_value(payload, body_off, st, encoding)
            col = needed[ci]
            if val is not None:
                if col == "name":
                    name = val
                elif col == "artist_name":
                    artist = val
                elif col == "album_name":
                    album = val
                elif col == "duration":
                    dur = val
                elif col == "last_lyrics_id":
                    last_lid = val
        else:
            body_off += sz

    if name is None:
        name = ""
    if artist is None:
        artist = ""
    if album is None:
        album = ""

    return name, artist, album, dur, last_lid


def decode_lyrics_record(payload, header_length, encoding, lyrics_col_names):
    """Decode only needed columns from a lyrics record.
    Needed: plain_lyrics(1), synced_lyrics(2), lyricsfile(3), instrumental(8)
    Skip: id(0, IPK), track_id(4), has_plain_lyrics(5), has_synced_lyrics(6), has_lyricsfile(7), source(9), created_at(10), updated_at(11)
    """
    h_off = 0
    header_len, hvsz = decode_varint_inline(payload, h_off)
    h_off += hvsz

    serial_types = []
    while h_off < header_length:
        st, stvsz = decode_varint_inline(payload, h_off)
        serial_types.append(st)
        h_off += stvsz

    plain = None
    synced = None
    lfile = None
    instrumental = False

    body_off = header_length
    ncols = len(serial_types)

    needed = {1: "plain_lyrics", 2: "synced_lyrics", 3: "lyricsfile", 8: "instrumental"}

    for ci in range(ncols):
        st = serial_types[ci]
        sz = serial_type_size(st)

        if ci in needed:
            val, body_off = decode_serial_value(payload, body_off, st, encoding)
            col = needed[ci]
            if val is not None:
                if col == "plain_lyrics":
                    plain = val
                elif col == "synced_lyrics":
                    synced = val
                elif col == "lyricsfile":
                    lfile = val
                elif col == "instrumental":
                    instrumental = bool(val)
        else:
            body_off += sz

    return plain, synced, lfile, instrumental


def write_track_record(tid, name, artist, album, dur, instrumental,
                        plain, synced, lfile, _norm, _dumps, room_writers, CHUNK_DIR,
                        total_records, total_json_bytes):
    rec = {
        "id": tid, "name": name, "trackName": name,
        "artistName": artist, "albumName": album, "duration": dur,
        "instrumental": instrumental, "plainLyrics": plain,
        "syncedLyrics": synced, "lyricsfile": lfile,
        "nameLower": _norm(name), "artistNameLower": _norm(artist), "albumNameLower": _norm(album),
    }
    jb = _dumps(rec)
    ridx = fnv1a_hash((_norm(artist) + " " + _norm(name)).encode("utf-8")) % _NUM_ROOMS
    rw = room_writers.get(ridx)
    if rw is None:
        rw = RoomWriter(ridx, CHUNK_DIR)
        room_writers[ridx] = rw
    rw.write_record(jb)
    return total_records + 1, total_json_bytes + len(jb), ridx


def main():
    _normalize = normalize
    _fnv = fnv1a_hash
    _dumps = dumps_json

    print(f"Opening: {GZIP_PATH}", flush=True)
    t0 = time.time()

    parser = SQLitePageParser(GZIP_PATH, parallelization=os.cpu_count())

    print(f"DB size: {parser.page_size * parser.page_count} "
          f"({parser.page_size * parser.page_count / 1073741824:.2f} GiB)", flush=True)
    print(f"Page size: {parser.page_size}, Pages: {parser.page_count}, "
          f"Encoding: {parser.text_encoding}", flush=True)

    print("Building gzip block offset index (seek to end)...", flush=True)
    t_idx = time.time()
    parser.build_index()
    print(f"Index built in {time.time() - t_idx:.1f}s", flush=True)

    print("Parsing schema from page 1...", flush=True)
    tables = parse_schema(parser)
    if "tracks" not in tables or "lyrics" not in tables:
        print(f"ERROR: Could not find tracks/lyrics tables. Found: {list(tables.keys())}", flush=True)
        sys.exit(1)

    tracks_ncols = tables["tracks"]["ncols"]
    lyrics_ncols = tables["lyrics"]["ncols"]
    tracks_col_names = [c[0] for c in tables["tracks"]["columns"]]
    lyrics_col_names = [c[0] for c in tables["lyrics"]["columns"]]
    print(f"  tracks: {tracks_ncols} columns, root page {tables['tracks']['rootpage']}", flush=True)
    print(f"  lyrics: {lyrics_ncols} columns, root page {tables['lyrics']['rootpage']}", flush=True)

    db_size = parser.page_size * parser.page_count
    estimated_total_json = int(db_size * 0.94)
    room_target = 72 * 1024 * 1024
    num_rooms = max(1, int(estimated_total_json / room_target))
    num_rooms = ((num_rooms + 99) // 100) * 100
    print(f"\nEstimated rooms: {num_rooms}", flush=True)

    if num_rooms > 65535:
        print(f"ERROR: num_rooms ({num_rooms}) exceeds Uint16Array max (65535).", flush=True)
        sys.exit(1)

    chunks_per_agg = 72
    num_aggregators_raw = max(6, (num_rooms + chunks_per_agg - 1) // chunks_per_agg)
    num_aggregators = ((num_aggregators_raw + 5) // 6) * 6
    num_supers = 10
    print(f"  aggregators: {num_aggregators} (chunks_per_agg={chunks_per_agg})", flush=True)
    print(f"  supers: {num_supers}", flush=True)

    global _NUM_ROOMS
    _NUM_ROOMS = num_rooms

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

    lyrics_offset = array.array("Q", [0] * (max_lid + 1))
    lyrics_compressed_len = array.array("Q", [0] * (max_lid + 1))
    lyrics_instrumental = bytearray(max_lid + 1)

    null_ids = []

    import shutil
    shutil.rmtree(CHUNK_DIR, ignore_errors=True)
    os.makedirs(CHUNK_DIR, exist_ok=True)

    lyrics_zctx = zstandard.ZstdCompressor(level=ZSTD_LEVEL)
    lyrics_temp_file = open(LYRICS_TEMP_PATH, "wb")
    lyrics_temp_offset = 0

    ring_buffer = RingBuffer(capacity=8192)
    pending_overflows = []
    pending_by_ovfl_page = {}
    PENDING_SPILL_PATH = "/tmp/pending_overflows.bin"
    pending_spill_file = open(PENDING_SPILL_PATH, "wb")
    pending_spill_read = None

    parser.enable_sequential_mode()

    print("\n=== Sequential page scan (single pass) ===", flush=True)
    t1 = time.time()
    tc = 0
    lc = 0
    overflow_seeks = 0
    U = parser.usable_size
    encoding = parser.text_encoding
    page_size = parser.page_size
    total_pages = parser.page_count

    parser.seek_to_beginning()

    page_num = 1
    while page_num <= total_pages:
        page_data = parser.read_sequential_page()
        ring_buffer.put(page_num, page_data)

        bt_offset = 100 if page_num == 1 else 0
        if len(page_data) <= bt_offset:
            page_num += 1
            continue

        page_type = page_data[bt_offset]

        if page_type == 13:
            cells = parse_leaf_table_cells(
                page_data, bt_offset, U, encoding,
                None,
                ring_buffer
            )

            for cell in cells:
                resolved = cell[5] if len(cell) >= 6 else True
                if not resolved:
                    rowid = cell[0]
                    local_payload = cell[3]
                    ovfl_page_num = cell[6]
                    total_payload_size = cell[7]
                    local_size = cell[8]
                    file_offset = pending_spill_file.tell()
                    pending_spill_file.write(struct.pack("<QIII", rowid, ovfl_page_num, total_payload_size, local_size))
                    pending_spill_file.write(local_payload)
                    idx = len(pending_overflows)
                    pending_overflows.append((rowid, ovfl_page_num, total_payload_size, local_size, file_offset, 0))
                    if ovfl_page_num not in pending_by_ovfl_page:
                        pending_by_ovfl_page[ovfl_page_num] = []
                    pending_by_ovfl_page[ovfl_page_num].append(idx)
                    continue

                rowid, ncols, serial_types, payload, header_length, _ = cell[:6]
                table = classify_record(ncols, serial_types, tracks_ncols, lyrics_ncols)

                if table == "skip":
                    continue

                if table == "tracks":
                    tid = rowid
                    if tid > max_tid:
                        ext = tid - max_tid
                        str_offsets.extend([0] * ext)
                        str_lens.extend([0] * ext)
                        durations.extend([0.0] * ext)
                        room_indices.extend([0] * ext)
                        matched.extend(bytearray(ext))
                        next_track.extend([0] * ext)
                        max_tid = tid

                    name, artist, album, dur, last_lid = decode_tracks_record(
                        payload, header_length, encoding, tracks_col_names
                    )

                    entry = name.encode("utf-8") + SEP + artist.encode("utf-8") + SEP + album.encode("utf-8")
                    str_offsets[tid] = len(string_data)
                    string_data.extend(entry)
                    str_lens[tid] = len(entry)
                    durations[tid] = dur

                    nl = _normalize(name)
                    al = _normalize(artist)
                    room_indices[tid] = _fnv((al + " " + nl).encode("utf-8")) % num_rooms

                    if last_lid is not None:
                        if last_lid >= len(lyrics_first):
                            lyrics_first.extend([0] * (last_lid - len(lyrics_first) + 1))
                        next_track[tid] = lyrics_first[last_lid]
                        lyrics_first[last_lid] = tid
                    else:
                        null_ids.append(tid)

                    tc += 1
                    if tc % 1000000 == 0:
                        print(f"  tracks: {tc} ({time.time()-t1:.1f}s)", flush=True)

                elif table == "lyrics":
                    lid = rowid
                    if lid >= len(lyrics_offset):
                        ext = lid - len(lyrics_offset) + 1
                        lyrics_offset.extend([0] * ext)
                        lyrics_compressed_len.extend([0] * ext)
                        lyrics_instrumental.extend(bytearray(ext))
                    if lid >= len(lyrics_first):
                        ext = lid - len(lyrics_first) + 1
                        lyrics_first.extend([0] * ext)

                    plain, synced, lfile, instrumental = decode_lyrics_record(
                        payload, header_length, encoding, lyrics_col_names
                    )

                    lyrics_instrumental[lid] = 1 if instrumental else 0

                    rec_bytes = bytearray()
                    if plain is not None:
                        rec_bytes.extend(str(plain).encode("utf-8"))
                    rec_bytes.append(0x00)
                    if synced is not None:
                        rec_bytes.extend(str(synced).encode("utf-8"))
                    rec_bytes.append(0x00)
                    if lfile is not None:
                        rec_bytes.extend(str(lfile).encode("utf-8"))
                    rec_bytes.append(0x00)

                    compressed = lyrics_zctx.compress(bytes(rec_bytes))
                    lyrics_offset[lid] = lyrics_temp_offset
                    lyrics_compressed_len[lid] = len(compressed)
                    lyrics_temp_file.write(compressed)
                    lyrics_temp_offset += len(compressed)

                    lc += 1
                    if lc % 1000000 == 0:
                        print(f"  lyrics: {lc} ({time.time()-t1:.1f}s)", flush=True)

        if page_num in pending_by_ovfl_page:
            if pending_spill_read is None:
                pending_spill_read = open(PENDING_SPILL_PATH, "rb")
            for idx in pending_by_ovfl_page[page_num]:
                rowid, ovfl_page_num, total_payload_size, local_size, file_offset, status = pending_overflows[idx]
                if status == 1:
                    continue
                pending_spill_read.seek(file_offset)
                hdr = pending_spill_read.read(20)
                _r, _o, _t, _l = struct.unpack("<QIII", hdr)
                local_payload = pending_spill_read.read(local_size)
                payload = bytearray(local_payload)
                remaining = total_payload_size - local_size
                current_ovfl = ovfl_page_num
                chain_ok = True
                while current_ovfl != 0 and remaining > 0:
                    if current_ovfl in ring_buffer:
                        ovfl_data = ring_buffer[current_ovfl]
                    elif current_ovfl == page_num:
                        ovfl_data = page_data
                    else:
                        chain_ok = False
                        break
                    next_page = struct.unpack(">I", ovfl_data[0:4])[0]
                    chunk = min(remaining, U - 4)
                    payload.extend(ovfl_data[4:4+chunk])
                    remaining -= chunk
                    current_ovfl = next_page
                if chain_ok and remaining <= 0:
                    payload = bytes(payload)
                    header_length, hvsz = decode_varint_inline(payload, 0)
                    h_off = hvsz
                    serial_types = []
                    ncols = 0
                    while h_off < header_length:
                        st, stvsz = decode_varint_inline(payload, h_off)
                        serial_types.append(st)
                        h_off += stvsz
                        ncols += 1
                    table = classify_record(ncols, serial_types, tracks_ncols, lyrics_ncols)
                    if table == "tracks":
                        tid = rowid
                        if tid > max_tid:
                            ext = tid - max_tid
                            str_offsets.extend([0] * ext)
                            str_lens.extend([0] * ext)
                            durations.extend([0.0] * ext)
                            room_indices.extend([0] * ext)
                            matched.extend(bytearray(ext))
                            next_track.extend([0] * ext)
                            max_tid = tid
                        if str_lens[tid] > 0:
                            pending_overflows[idx] = (rowid, ovfl_page_num, total_payload_size, local_size, file_offset, 1)
                            continue
                        name, artist, album, dur, last_lid = decode_tracks_record(
                            payload, header_length, encoding, tracks_col_names
                        )
                        entry = name.encode("utf-8") + SEP + artist.encode("utf-8") + SEP + album.encode("utf-8")
                        str_offsets[tid] = len(string_data)
                        string_data.extend(entry)
                        str_lens[tid] = len(entry)
                        durations[tid] = dur
                        nl = _normalize(name)
                        al = _normalize(artist)
                        room_indices[tid] = _fnv((al + " " + nl).encode("utf-8")) % num_rooms
                        if last_lid is not None:
                            if last_lid >= len(lyrics_first):
                                lyrics_first.extend([0] * (last_lid - len(lyrics_first) + 1))
                            next_track[tid] = lyrics_first[last_lid]
                            lyrics_first[last_lid] = tid
                        else:
                            null_ids.append(tid)
                        tc += 1
                        pending_overflows[idx] = (rowid, ovfl_page_num, total_payload_size, local_size, file_offset, 1)
                    elif table == "lyrics":
                        lid = rowid
                        if lid >= len(lyrics_offset):
                            ext = lid - len(lyrics_offset) + 1
                            lyrics_offset.extend([0] * ext)
                            lyrics_compressed_len.extend([0] * ext)
                            lyrics_instrumental.extend(bytearray(ext))
                        if lid >= len(lyrics_first):
                            ext = lid - len(lyrics_first) + 1
                            lyrics_first.extend([0] * ext)
                        if lyrics_compressed_len[lid] > 0:
                            pending_overflows[idx] = (rowid, ovfl_page_num, total_payload_size, local_size, file_offset, 1)
                            continue
                        plain, synced, lfile, instrumental = decode_lyrics_record(
                            payload, header_length, encoding, lyrics_col_names
                        )
                        lyrics_instrumental[lid] = 1 if instrumental else 0
                        rec_bytes = bytearray()
                        if plain is not None:
                            rec_bytes.extend(str(plain).encode("utf-8"))
                        rec_bytes.append(0x00)
                        if synced is not None:
                            rec_bytes.extend(str(synced).encode("utf-8"))
                        rec_bytes.append(0x00)
                        if lfile is not None:
                            rec_bytes.extend(str(lfile).encode("utf-8"))
                        rec_bytes.append(0x00)
                        compressed = lyrics_zctx.compress(bytes(rec_bytes))
                        lyrics_offset[lid] = lyrics_temp_offset
                        lyrics_compressed_len[lid] = len(compressed)
                        lyrics_temp_file.write(compressed)
                        lyrics_temp_offset += len(compressed)
                        lc += 1
                        pending_overflows[idx] = (rowid, ovfl_page_num, total_payload_size, local_size, file_offset, 1)

        page_num += 1
        if page_num % 100000 == 0:
            print(f"  pages: {page_num}/{parser.page_count} ({time.time()-t1:.1f}s)", flush=True)

    print(f"Scan done: {tc} tracks, {lc} lyrics in {time.time()-t1:.1f}s", flush=True)
    unresolved = [po for po in pending_overflows if po[5] == 0]
    print(f"  Pending overflows: {len(pending_overflows)} (resolved in-pass: {len(pending_overflows) - len(unresolved)}, unresolved: {len(unresolved)})", flush=True)

    lyrics_temp_file.close()
    pending_spill_file.close()
    if pending_spill_read is not None:
        pending_spill_read.close()
    parser.close()

    print(f"  lyrics temp file: {lyrics_temp_offset} bytes ({lyrics_temp_offset/1073741824:.2f} GiB)", flush=True)

    if unresolved:
        print(f"\n=== Pass 2: Resolving {len(unresolved)} unresolved overflows via seek ===", flush=True)
        t_ov = time.time()
        from rapidgzip import RapidgzipFile
        gz_fix = RapidgzipFile(GZIP_PATH, parallelization=os.cpu_count())
        gz_fix.seek(0, 2)
        page_size_fix = page_size
        U_fix = U
        spill_read = open(PENDING_SPILL_PATH, "rb")
        lyrics_temp_file2 = open(LYRICS_TEMP_PATH, "ab")
        resolved = 0
        for (rowid, ovfl_page_num, total_payload_size, local_size, file_offset, _status) in unresolved:
            spill_read.seek(file_offset)
            hdr = spill_read.read(20)
            _r, _o, _t, _l = struct.unpack("<QIII", hdr)
            local_payload = spill_read.read(local_size)

            payload = bytearray(local_payload)
            remaining = total_payload_size - local_size
            current_ovfl = ovfl_page_num
            while current_ovfl != 0 and remaining > 0:
                off_fix = (current_ovfl - 1) * page_size_fix
                gz_fix.seek(off_fix)
                ovfl_raw = gz_fix.read(page_size_fix)
                next_page = struct.unpack(">I", ovfl_raw[0:4])[0]
                chunk = min(remaining, U_fix - 4)
                payload.extend(ovfl_raw[4:4+chunk])
                remaining -= chunk
                current_ovfl = next_page
            payload = bytes(payload)

            header_length, hvsz = decode_varint_inline(payload, 0)
            h_off = hvsz
            serial_types = []
            ncols = 0
            while h_off < header_length:
                st, stvsz = decode_varint_inline(payload, h_off)
                serial_types.append(st)
                h_off += stvsz
                ncols += 1

            table = classify_record(ncols, serial_types, tracks_ncols, lyrics_ncols)
            if table == "skip":
                continue

            if table == "tracks":
                tid = rowid
                if tid <= max_tid and str_lens[tid] > 0:
                    continue
                name, artist, album, dur, last_lid = decode_tracks_record(
                    payload, header_length, encoding, tracks_col_names
                )
                entry = name.encode("utf-8") + SEP + artist.encode("utf-8") + SEP + album.encode("utf-8")
                str_offsets[tid] = len(string_data)
                string_data.extend(entry)
                str_lens[tid] = len(entry)
                durations[tid] = dur
                nl = _normalize(name)
                al = _normalize(artist)
                room_indices[tid] = _fnv((al + " " + nl).encode("utf-8")) % num_rooms
                if last_lid is not None:
                    if last_lid >= len(lyrics_first):
                        lyrics_first.extend([0] * (last_lid - len(lyrics_first) + 1))
                    next_track[tid] = lyrics_first[last_lid]
                    lyrics_first[last_lid] = tid
                else:
                    null_ids.append(tid)
                tc += 1
                resolved += 1
            elif table == "lyrics":
                lid = rowid
                if lid >= len(lyrics_offset):
                    ext = lid - len(lyrics_offset) + 1
                    lyrics_offset.extend([0] * ext)
                    lyrics_compressed_len.extend([0] * ext)
                    lyrics_instrumental.extend(bytearray(ext))
                if lid >= len(lyrics_first):
                    ext = lid - len(lyrics_first) + 1
                    lyrics_first.extend([0] * ext)
                if lyrics_compressed_len[lid] > 0:
                    continue
                plain, synced, lfile, instrumental = decode_lyrics_record(
                    payload, header_length, encoding, lyrics_col_names
                )
                lyrics_instrumental[lid] = 1 if instrumental else 0
                rec_bytes = bytearray()
                if plain is not None:
                    rec_bytes.extend(str(plain).encode("utf-8"))
                rec_bytes.append(0x00)
                if synced is not None:
                    rec_bytes.extend(str(synced).encode("utf-8"))
                rec_bytes.append(0x00)
                if lfile is not None:
                    rec_bytes.extend(str(lfile).encode("utf-8"))
                rec_bytes.append(0x00)
                compressed = lyrics_zctx.compress(bytes(rec_bytes))
                lyrics_offset[lid] = lyrics_temp_offset
                lyrics_compressed_len[lid] = len(compressed)
                lyrics_temp_file2.write(compressed)
                lyrics_temp_offset += len(compressed)
                lc += 1
                resolved += 1

        lyrics_temp_file2.close()
        print(f"  Resolved {resolved}/{len(unresolved)} in {time.time()-t_ov:.1f}s", flush=True)
        gz_fix.close()
        spill_read.close()
        del pending_overflows
        del unresolved
        os.remove(PENDING_SPILL_PATH)

    print("\n=== Writing null-lyrics tracks ===", flush=True)
    t_null = time.time()

    room_writers = {}
    total_records = 0
    total_json_bytes = 0

    for tid in null_ids:
        ridx = room_indices[tid]
        rw = room_writers.get(ridx)
        if rw is None:
            rw = RoomWriter(ridx, CHUNK_DIR)
            room_writers[ridx] = rw
        start = str_offsets[tid]
        raw = bytes(string_data[start:start + str_lens[tid]])
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
            "nameLower": _normalize(name), "artistNameLower": _normalize(artist), "albumNameLower": _normalize(album),
        }
        jb = _dumps(rec)
        rw.write_record(jb)
        matched[tid] = 1
        total_records += 1
        total_json_bytes += len(jb)
    print(f"  Null-lyrics: {len(null_ids)} ({time.time()-t_null:.1f}s)", flush=True)
    del null_ids

    print("\n=== Reading back lyrics and joining with tracks ===", flush=True)
    t2 = time.time()

    lyrics_zdctx = zstandard.ZstdDecompressor()
    lyrics_read_fh = open(LYRICS_TEMP_PATH, "rb")
    mc = 0

    for lid in range(1, max_lid + 1):
        if lid >= len(lyrics_offset) or lyrics_compressed_len[lid] == 0:
            continue

        off = lyrics_offset[lid]
        clen = lyrics_compressed_len[lid]
        lyrics_read_fh.seek(off)
        compressed_chunk = lyrics_read_fh.read(clen)
        decompressed = lyrics_zdctx.decompress(compressed_chunk)

        parts = decompressed.split(b"\x00")
        plain = parts[0].decode("utf-8", errors="replace") if parts[0] else None
        synced = parts[1].decode("utf-8", errors="replace") if len(parts) > 1 and parts[1] else None
        lfile = parts[2].decode("utf-8", errors="replace") if len(parts) > 2 and parts[2] else None
        instrumental = bool(lyrics_instrumental[lid])

        tid = lyrics_first[lid] if lid < len(lyrics_first) else 0
        while tid != 0:
            if tid <= max_tid and str_lens[tid] > 0 and not matched[tid]:
                ridx = room_indices[tid]
                rw = room_writers.get(ridx)
                if rw is None:
                    rw = RoomWriter(ridx, CHUNK_DIR)
                    room_writers[ridx] = rw

                start = str_offsets[tid]
                raw = bytes(string_data[start:start + str_lens[tid]])
                tparts = raw.split(SEP)
                name = tparts[0].decode("utf-8")
                artist = tparts[1].decode("utf-8")
                album = tparts[2].decode("utf-8")
                dur = durations[tid]

                rec = {
                    "id": tid, "name": name, "trackName": name,
                    "artistName": artist, "albumName": album, "duration": dur,
                    "instrumental": instrumental, "plainLyrics": plain,
                    "syncedLyrics": synced, "lyricsfile": lfile,
                    "nameLower": _normalize(name), "artistNameLower": _normalize(artist), "albumNameLower": _normalize(album),
                }
                jb = _dumps(rec)
                rw.write_record(jb)
                matched[tid] = 1
                total_records += 1
                total_json_bytes += len(jb)
                mc += 1

            tid = next_track[tid]

    print(f"Lyrics join done: {mc} matched in {time.time()-t2:.1f}s", flush=True)

    lyrics_read_fh.close()
    os.remove(LYRICS_TEMP_PATH)
    print(f"  Removed lyrics temp file", flush=True)

    del lyrics_first, next_track, lyrics_offset, lyrics_compressed_len, lyrics_instrumental

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
            raw = bytes(string_data[start:start + str_lens[tid]])
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
                "nameLower": _normalize(name), "artistNameLower": _normalize(artist), "albumNameLower": _normalize(album),
            }
            jb = _dumps(rec)
            rw.write_record(jb)
            total_records += 1
            total_json_bytes += len(jb)
            uc += 1
    print(f"  Unmatched: {uc} ({time.time()-t_unm:.1f}s)", flush=True)

    del string_data, str_offsets, str_lens, durations, matched

    print("\n=== Writing id-to-chunk index files ===", flush=True)
    t_idx2 = time.time()
    INDEX_PART_U16S = (16 * 1024 * 1024) // 2
    index_total_u16s = max_tid + 1
    num_index_parts = (index_total_u16s + INDEX_PART_U16S - 1) // INDEX_PART_U16S
    index_files = []
    index_cctx = zstandard.ZstdCompressor(level=ZSTD_LEVEL)
    for part in range(num_index_parts):
        start_u16 = part * INDEX_PART_U16S
        end_u16 = min(start_u16 + INDEX_PART_U16S, index_total_u16s)
        chunk_arr = array.array("H", room_indices[start_u16:end_u16])
        raw_bytes = chunk_arr.tobytes()
        part_name = f"index-{part}.bin"
        zst_path = os.path.join(CHUNK_DIR, part_name + ".zst")
        with open(zst_path, "wb") as f:
            f.write(index_cctx.compress(raw_bytes))
        index_files.append({
            "name": part_name,
            "size": len(raw_bytes),
        })
    print(f"  Index files: {len(index_files)} ({time.time()-t_idx2:.1f}s)", flush=True)

    del room_indices

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

    all_files.extend(index_files)
    print(f"Total files (chunks + index): {len(all_files)}", flush=True)

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
        f.write(f"export const NUM_CHUNKS = {num_rooms};\n")
        f.write(f"export const NUM_AGGREGATORS = {num_aggregators};\n")
        f.write(f"export const CHUNKS_PER_AGG = {chunks_per_agg};\n")
        f.write(f"export const NUM_SUPERS = {num_supers};\n")
        f.write(f"export const INDEX_FILES = {num_index_parts};\n")
    print(f"  config.ts written to {CONFIG_TS_PATH}", flush=True)
    print(f"  Total time: {time.time()-t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
