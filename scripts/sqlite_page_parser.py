"""
Direct SQLite page parser that reads pages sequentially from a gzip stream.
No APSW, no SQLite library — just raw binary page format parsing.

Usage:
    parser = SQLitePageParser(gz_path)
    for page_num, page_type, page_data in parser.iter_pages():
        ...
    schema = parser.parse_schema()
"""

import struct
import os
import time
from typing import Iterator, Optional


class SQLitePageParser:
    def __init__(self, gz_path: str, parallelization: int = 0):
        from rapidgzip import RapidgzipFile
        self.gz_path = gz_path
        self.gz = RapidgzipFile(gz_path, parallelization=parallelization or os.cpu_count())
        self.page_size = 0
        self.reserved_size = 0
        self.usable_size = 0
        self.page_count = 0
        self.text_encoding = 1
        self._seq_buf = bytearray()
        self._seq_buf_pos = 0
        self._sequential_mode = False
        self._seq_file_pos = 0
        self._read_header()

    def _read_header(self):
        header = self._read_exact(100)
        if header[:16] != b"SQLite format 3\x00":
            raise ValueError(f"Not a SQLite database: {header[:16]}")
        ps = struct.unpack(">H", header[16:18])[0]
        self.page_size = 65536 if ps == 1 else ps
        self.reserved_size = header[20]
        self.usable_size = self.page_size - self.reserved_size
        cc = struct.unpack(">I", header[24:28])[0]
        vfs_size = struct.unpack(">I", header[28:32])[0]
        vf = struct.unpack(">I", header[92:96])[0]
        if vfs_size != 0 and cc == vf:
            self.page_count = vfs_size
        else:
            self.gz.seek(0, 2)
            total = self.gz.tell()
            self.page_count = total // self.page_size
        self.text_encoding = struct.unpack(">I", header[56:60])[0]

    def build_index(self):
        t0 = time.time()
        self.gz.seek(0, 2)
        print(f"Index built in {time.time()-t0:.1f}s", flush=True)

    def enable_sequential_mode(self):
        self._sequential_mode = True

    def seek_to_beginning(self):
        self.gz.seek(0)
        self._seq_buf = bytearray()
        self._seq_buf_pos = 0
        self._seq_file_pos = 0

    def read_sequential_page(self) -> bytes:
        ps = self.page_size
        if self._seq_buf_pos + ps <= len(self._seq_buf):
            page = bytes(self._seq_buf[self._seq_buf_pos:self._seq_buf_pos + ps])
            self._seq_buf_pos += ps
            self._seq_file_pos += ps
            return page

        remaining = ps
        page = bytearray()

        if self._seq_buf_pos < len(self._seq_buf):
            page.extend(self._seq_buf[self._seq_buf_pos:])
            remaining -= len(self._seq_buf) - self._seq_buf_pos

        CHUNK = 4 * 1024 * 1024
        while remaining > 0:
            to_read = max(CHUNK, remaining)
            chunk = self.gz.read(to_read)
            if not chunk:
                page.extend(b"\x00" * remaining)
                break
            if len(chunk) >= remaining:
                page.extend(chunk[:remaining])
                self._seq_buf = bytearray(chunk)
                self._seq_buf_pos = remaining
                remaining = 0
            else:
                page.extend(chunk)
                remaining -= len(chunk)

        self._seq_file_pos += ps
        return bytes(page)

    def _read_exact(self, n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            chunk = self.gz.read(n - len(buf))
            if not chunk:
                if len(buf) == 0:
                    raise EOFError("Unexpected end of stream")
                buf.extend(b"\x00" * (n - len(buf)))
                break
            buf.extend(chunk)
        return bytes(buf)

    def read_page(self, page_num: int) -> bytes:
        if self._sequential_mode:
            raise RuntimeError("read_page() is not available in sequential mode")
        offset = (page_num - 1) * self.page_size
        self.gz.seek(offset)
        buf = bytearray()
        remaining = self.page_size
        while remaining > 0:
            chunk = self.gz.read(remaining)
            if not chunk:
                buf.extend(b"\x00" * remaining)
                break
            buf.extend(chunk)
            remaining -= len(chunk)
        return bytes(buf)

    def close(self):
        try:
            self.gz.close()
        except Exception:
            pass


def decode_varint_inline(data: bytes, offset: int) -> tuple:
    result = 0
    for i in range(9):
        if offset + i >= len(data):
            return (result, i + 1)
        b = data[offset + i]
        if i == 8:
            result = (result << 8) | b
            return (result, 9)
        result = (result << 7) | (b & 0x7F)
        if (b & 0x80) == 0:
            return (result, i + 1)
    return (result, 9)


def serial_type_size(st: int) -> int:
    if st == 0 or st == 8 or st == 9:
        return 0
    if st == 1:
        return 1
    if st == 2:
        return 2
    if st == 3:
        return 3
    if st == 4:
        return 4
    if st == 5:
        return 6
    if st == 6 or st == 7:
        return 8
    if st >= 12 and st % 2 == 0:
        return (st - 12) // 2
    if st >= 13 and st % 2 == 1:
        return (st - 13) // 2
    return 0


def decode_serial_value(data: bytes, offset: int, st: int, encoding: int) -> tuple:
    sz = serial_type_size(st)
    if st == 0:
        return (None, offset)
    if st == 8:
        return (0, offset)
    if st == 9:
        return (1, offset)
    if st == 7:
        val = struct.unpack(">d", data[offset:offset+8])[0]
        return (val, offset + 8)
    if st in (1, 2, 3, 4, 5, 6):
        val = int.from_bytes(data[offset:offset+sz], byteorder="big", signed=True)
        return (val, offset + sz)
    if st >= 13 and st % 2 == 1:
        raw = data[offset:offset+sz]
        if encoding == 1:
            return (raw.decode("utf-8"), offset + sz)
        elif encoding == 2:
            return (raw.decode("utf-16-le"), offset + sz)
        elif encoding == 3:
            return (raw.decode("utf-16-be"), offset + sz)
        return (raw, offset + sz)
    if st >= 12 and st % 2 == 0:
        return (data[offset:offset+sz], offset + sz)
    return (None, offset)


def compute_local_payload_size(payload_size: int, U: int) -> int:
    X = U - 35
    M = ((U - 12) * 32 // 255) - 23
    if payload_size <= X:
        return payload_size
    K = M + ((payload_size - M) % (U - 4))
    if K <= X:
        return K
    return M


def parse_schema(parser: SQLitePageParser) -> dict:
    entries = _collect_schema_entries(parser, 1, set())

    tables = {}
    for e in entries:
        if e["type"] == "table" and e["name"] and not e["name"].startswith("sqlite_"):
            cols = parse_create_table(e["sql"])
            tables[e["name"]] = {
                "rootpage": e["rootpage"],
                "columns": cols,
                "ncols": len(cols),
                "sql": e["sql"],
            }
    return tables


def _collect_schema_entries(parser: SQLitePageParser, page_num: int, visited: set) -> list:
    if page_num in visited or page_num < 1:
        return []
    visited.add(page_num)

    page_data = parser.read_page(page_num)
    bt_offset = 100 if page_num == 1 else 0

    if len(page_data) <= bt_offset:
        return []

    page_type = page_data[bt_offset]

    if page_type == 13:
        return _parse_leaf_schema_page(parser, page_data, bt_offset, page_num)
    elif page_type == 5:
        return _parse_interior_schema_page(parser, page_data, bt_offset, page_num, visited)
    else:
        return []


def _parse_leaf_schema_page(parser: SQLitePageParser, page_data: bytes, bt_offset: int, page_num: int) -> list:
    cell_count = struct.unpack(">H", page_data[bt_offset+3:bt_offset+5])[0]
    ptr_array_start = bt_offset + 8
    entries = []

    for i in range(cell_count):
        if ptr_array_start + i*2 + 2 > len(page_data):
            break
        cell_ptr = struct.unpack(">H", page_data[ptr_array_start + i*2:ptr_array_start + i*2 + 2])[0]
        if cell_ptr >= len(page_data):
            continue
        offset = cell_ptr
        payload_size, vsz = decode_varint_inline(page_data, offset)
        offset += vsz
        rowid, vsz = decode_varint_inline(page_data, offset)
        offset += vsz
        U = parser.usable_size
        local_size = compute_local_payload_size(payload_size, U)
        if offset + local_size > len(page_data):
            continue
        payload = bytes(page_data[offset:offset+local_size])
        if local_size < payload_size:
            if offset + local_size + 4 > len(page_data):
                continue
            ovfl_page = struct.unpack(">I", page_data[offset+local_size:offset+local_size+4])[0]
            full_payload = bytearray(payload)
            remaining = payload_size - local_size
            while ovfl_page != 0 and remaining > 0:
                ovfl_data = parser.read_page(ovfl_page)
                next_page = struct.unpack(">I", ovfl_data[0:4])[0]
                chunk = min(remaining, U - 4)
                full_payload.extend(ovfl_data[4:4+chunk])
                remaining -= chunk
                ovfl_page = next_page
            payload = bytes(full_payload)

        values = decode_record(payload, parser.text_encoding)
        entries.append({
            "type": values[0] if len(values) > 0 else None,
            "name": values[1] if len(values) > 1 else None,
            "tbl_name": values[2] if len(values) > 2 else None,
            "rootpage": values[3] if len(values) > 3 else None,
            "sql": values[4] if len(values) > 4 else None,
        })

    return entries


def _parse_interior_schema_page(parser: SQLitePageParser, page_data: bytes, bt_offset: int, page_num: int, visited: set) -> list:
    cell_count = struct.unpack(">H", page_data[bt_offset+3:bt_offset+5])[0]
    ptr_array_start = bt_offset + 12

    right_most_page = struct.unpack(">I", page_data[bt_offset+8:bt_offset+12])[0]

    entries = []

    for i in range(cell_count):
        if ptr_array_start + i*2 + 2 > len(page_data):
            break
        cell_ptr = struct.unpack(">H", page_data[ptr_array_start + i*2:ptr_array_start + i*2 + 2])[0]
        if cell_ptr + 4 > len(page_data):
            continue
        left_child_page = struct.unpack(">I", page_data[cell_ptr:cell_ptr+4])[0]
        entries.extend(_collect_schema_entries(parser, left_child_page, visited))

    entries.extend(_collect_schema_entries(parser, right_most_page, visited))

    return entries


def parse_create_table(sql: str) -> list:
    start = sql.index("(")
    end = sql.rindex(")")
    body = sql[start+1:end]
    columns = []
    depth = 0
    current = []
    for ch in body:
        if ch == "(":
            depth += 1
            current.append(ch)
        elif ch == ")":
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            columns.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
    if current:
        columns.append("".join(current).strip())

    result = []
    for col_def in columns:
        upper = col_def.upper().lstrip()
        if upper.startswith(("PRIMARY KEY", "UNIQUE", "CHECK", "FOREIGN KEY", "CONSTRAINT")):
            continue
        parts = col_def.split()
        col_name = parts[0].strip('"[]`') if parts else ""
        is_ipk = "INTEGER" in upper and "PRIMARY" in upper and "KEY" in upper
        result.append((col_name, is_ipk))
    return result


def decode_record(payload: bytes, encoding: int) -> list:
    offset = 0
    header_length, vsz = decode_varint_inline(payload, offset)
    offset += vsz
    header_end = header_length
    serial_types = []
    while offset < header_end:
        st, vsz = decode_varint_inline(payload, offset)
        serial_types.append(st)
        offset += vsz

    body_offset = header_end
    values = []
    for st in serial_types:
        val, body_offset = decode_serial_value(payload, body_offset, st, encoding)
        values.append(val)
    return values


def parse_leaf_table_cells(page_data: bytes, bt_offset: int, U: int, encoding: int,
                            page_reader, ring_buffer: dict = None,
                            pending_overflows: dict = None) -> list:
    page_type = page_data[bt_offset]
    if page_type != 13:
        return []

    cell_count = struct.unpack(">H", page_data[bt_offset+3:bt_offset+5])[0]
    if cell_count == 0 or cell_count > len(page_data) // 4:
        return []

    ptr_array_start = bt_offset + 8
    min_valid_ptr = ptr_array_start + cell_count * 2
    if min_valid_ptr >= len(page_data):
        return []

    results = []

    for i in range(cell_count):
        cell_ptr = struct.unpack(">H", page_data[ptr_array_start + i*2:ptr_array_start + i*2 + 2])[0]
        if cell_ptr < min_valid_ptr or cell_ptr >= len(page_data):
            continue
        offset = cell_ptr
        payload_size, vsz = decode_varint_inline(page_data, offset)
        offset += vsz
        rowid, vsz = decode_varint_inline(page_data, offset)
        offset += vsz

        local_size = compute_local_payload_size(payload_size, U)

        if local_size >= payload_size:
            payload = bytes(page_data[offset:offset+local_size])
        else:
            ovfl_page_num = struct.unpack(">I", page_data[offset+local_size:offset+local_size+4])[0]
            payload = bytearray(page_data[offset:offset+local_size])
            remaining = payload_size - local_size
            current_ovfl = ovfl_page_num
            overflow_resolved = True
            while current_ovfl != 0 and remaining > 0:
                if ring_buffer is not None and current_ovfl in ring_buffer:
                    ovfl_data = ring_buffer[current_ovfl]
                    next_page = struct.unpack(">I", ovfl_data[0:4])[0]
                    chunk = min(remaining, U - 4)
                    payload.extend(ovfl_data[4:4+chunk])
                    remaining -= chunk
                    current_ovfl = next_page
                else:
                    overflow_resolved = False
                    break
            if not overflow_resolved:
                results.append((rowid, ncols, None, None, None, ovfl_page_num, payload_size))
                continue
            payload = bytes(payload)

        header_length, hvsz = decode_varint_inline(payload, 0)
        ncols = 0
        h_off = hvsz
        serial_types = []
        while h_off < header_length:
            st, stvsz = decode_varint_inline(payload, h_off)
            serial_types.append(st)
            h_off += stvsz
            ncols += 1

        results.append((rowid, ncols, serial_types, payload, header_length, True))

    return results


def classify_record(ncols: int, serial_types: list,
                    tracks_ncols: int = 11, lyrics_ncols: int = 12) -> str:
    if ncols < 8:
        return "skip"
    if ncols == tracks_ncols:
        return "tracks"
    if ncols == lyrics_ncols:
        return "lyrics"
    if ncols < tracks_ncols and ncols != lyrics_ncols:
        return "tracks"
    if ncols < lyrics_ncols and ncols != tracks_ncols:
        return "lyrics"
    if ncols >= 8:
        st7 = serial_types[7] if len(serial_types) > 7 else 0
        if st7 == 7:
            return "tracks"
        if st7 in (0, 8, 9):
            return "lyrics"
    raise ValueError(f"Cannot classify record: ncols={ncols}, types={serial_types}")


class RingBuffer:
    def __init__(self, capacity: int = 1024):
        self.capacity = capacity
        self._buf = {}

    def put(self, page_num: int, page_data: bytes):
        if len(self._buf) >= self.capacity:
            oldest = next(iter(self._buf))
            del self._buf[oldest]
        self._buf[page_num] = page_data

    def get(self, page_num: int) -> Optional[bytes]:
        return self._buf.get(page_num)

    def __getitem__(self, page_num: int) -> bytes:
        return self._buf[page_num]

    def __contains__(self, page_num: int) -> bool:
        return page_num in self._buf

    def __len__(self) -> int:
        return len(self._buf)
