# SQLite Binary File Format Specification for Direct Page Parser

> Reference document for implementing a sequential .sqlite3 file parser
> that reads from a gzip stream without using any SQLite library.
> Source: https://www.sqlite.org/fileformat2.html (authoritative)

---

## 1. Database Header (First 100 Bytes)

The first 100 bytes of the database file comprise the header. All multi-byte
fields are **big-endian**. Page 1 is always a table b-tree page, and these 100
bytes occupy the beginning of page 1.

### 1.1 Header Field Map

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 16 | Magic string | `"SQLite format 3\0"` (hex: `53 51 4c 69 74 65 20 66 6f 72 6d 61 74 20 33 00`) |
| 16 | 2 | Page size | Big-endian uint16. Power of 2, 512..32768. Value **1** means 65536. |
| 18 | 1 | File format write version | 1 = legacy (rollback journal); 2 = WAL |
| 19 | 1 | File format read version | 1 = legacy; 2 = WAL |
| 20 | 1 | Reserved space per page | Bytes of unused reserved space at end of each page. Usually 0. |
| 21 | 1 | Max embedded payload fraction | Must be 64 |
| 22 | 1 | Min embedded payload fraction | Must be 32 |
| 23 | 1 | Leaf payload fraction | Must be 32 |
| 24 | 4 | File change counter | Incremented on each modification+unlock |
| 28 | 4 | In-header database size | Page count. Valid only if non-zero AND matches change counter at offset 24 == version-valid-for at offset 92 |
| 32 | 4 | First freelist trunk page | 0 if no freelist |
| 36 | 4 | Total freelist pages | Count of pages on freelist |
| 40 | 4 | Schema cookie | Incremented on schema change |
| 44 | 4 | Schema format number | 1, 2, 3, or 4 (4 is current default) |
| 48 | 4 | Default page cache size | Suggested cache size in pages |
| 52 | 4 | Largest root b-tree page | Non-zero = auto/incremental vacuum mode (ptrmap pages exist) |
| 56 | 4 | Text encoding | 1 = UTF-8, 2 = UTF-16le, 3 = UTF-16be |
| 60 | 4 | User version | Set via `PRAGMA user_version` |
| 64 | 4 | Incremental vacuum mode | Non-zero = incremental vacuum |
| 68 | 4 | Application ID | Set via `PRAGMA application_id` |
| 72 | 20 | Reserved | Must be zero |
| 92 | 4 | version-valid-for | Change counter value when version number was stored |
| 96 | 4 | SQLITE_VERSION_NUMBER | Version of SQLite that last modified the file |

### 1.2 Key Derived Values

```
page_size     = read_uint16_be(header, 16)
if page_size == 1: page_size = 65536
reserved_size = read_uint8(header, 20)
usable_size   = page_size - reserved_size    # U
page_count    = read_uint32_be(header, 28)    # if valid; else file_size / page_size
text_encoding = read_uint32_be(header, 56)    # 1=UTF-8, 2=UTF-16le, 3=UTF-16be
```

### 1.3 Page Size Special Case

The value 65536 does not fit in a 2-byte uint16. When offset 16 contains
`0x00 0x01` (big-endian 1), the page size is **65536**.

### 1.4 Validating In-Header Database Size

The in-header size at offset 28 is valid only if:
1. It is non-zero, AND
2. The 4-byte change counter at offset 24 equals the 4-byte
   version-valid-for number at offset 92.

If invalid, fall back to `file_size / page_size`.

---

## 2. Page Types and Their Binary Layouts

Every page in the database has exactly one use:

| Page Type | Type Byte | Name |
|-----------|-----------|------|
| 2 (0x02) | Interior index b-tree page |
| 5 (0x05) | Interior table b-tree page |
| 10 (0x0a) | Leaf index b-tree page |
| 13 (0x0d) | Leaf table b-tree page |
| (no type byte) | Overflow page (payload spill) |
| (no type byte) | Freelist trunk page |
| (no type byte) | Freelist leaf page (empty, no content) |
| (no type byte) | Pointer map (ptrmap) page |

**Type bytes only appear in b-tree pages.** Overflow pages, freelist
pages, and ptrmap pages have no type byte — they are identified by
context (pointed to by other structures).

### 2.1 Page Numbering

- Pages are numbered starting from **1**.
- Page 1 is always a table b-tree page (the schema table root).
- Page 1 contains the 100-byte database header at its start, so its
  b-tree header begins at offset 100.
- All other b-tree pages have their b-tree header at offset 0 of the page.
- Maximum page number: 4,294,967,294 (2^32 - 2).

### 2.2 Page Region Layout (B-tree Pages)

A b-tree page is divided into regions in this order:

```
+----------------------------------+
| Database header (100 bytes)      |  <- Page 1 ONLY
+----------------------------------+
| B-tree page header (8 or 12 bytes)|
+----------------------------------+
| Cell pointer array               |  <- K × 2-byte offsets
+----------------------------------+
| Unallocated space                |
+----------------------------------+
| Cell content area                |  <- Cells grow downward
+----------------------------------+
| Reserved region                  |  <- reserved_size bytes (usually 0)
+----------------------------------+
```

---

## 3. B-tree Page Header Format

The b-tree page header immediately follows the 100-byte database header
on page 1, or starts at offset 0 on all other pages.

### 3.1 Header Fields

| Offset (within header) | Size | Field | Notes |
|-------------------------|------|-------|-------|
| 0 | 1 | Page type flag | 2, 5, 10, or 13 |
| 1 | 2 | First freeblock offset | 0 if no freeblocks. Big-endian. |
| 3 | 2 | Cell count | Number of cells on this page. Big-endian. |
| 5 | 2 | Cell content area start | Byte offset from start of page. 0 means 65536. Big-endian. |
| 7 | 1 | Fragmented free bytes | Total bytes in fragments within cell content area |
| 8 | 4 | Right-most pointer | **Interior pages only** (types 2 and 5). Omitted on leaf pages. |

### 3.2 Header Sizes

- **Leaf pages** (types 10, 13): **8 bytes**
- **Interior pages** (types 2, 5): **12 bytes** (includes right-most pointer)

### 3.3 Page 1 Special Case

On page 1, the b-tree header starts at **offset 100** (after the database
header). The cell pointer array starts at offset 100 + 8 (or 100 + 12 if
interior). All offsets in the cell pointer array are relative to the **start
of the page** (byte 0), not relative to the header.

### 3.4 Cell Pointer Array

Immediately follows the b-tree page header. Contains `K` entries, where K
is the cell count from the header. Each entry is a **2-byte big-endian
unsigned integer** giving the byte offset of the cell within the page.

```
cell_ptr[i] = read_uint16_be(page, header_size + i * 2)  for i in 0..K-1
```

The cell pointers are in **key order** (smallest key first, largest key
last).

### 3.5 Cell Content Area

Cells are stored from the end of the page backward. The "cell content area
start" (header offset 5) gives the offset of the first byte of cell content.
Everything between the end of the cell pointer array and the cell content
area start is unallocated space.

If the page has no cells (possible only for a root page of an empty table),
the cell content area start equals `page_size - reserved_size`. If
page_size is 65536 and reserved_size is 0, this value would be 65536 which
cannot fit in a uint16, so **0 is used instead**.

### 3.6 Freeblocks

A freeblock identifies unallocated space within the cell content area.
Structure (4-byte header):

| Offset | Size | Description |
|--------|------|-------------|
| 0 | 2 | Offset of next freeblock (0 if last in chain) |
| 2 | 2 | Size of this freeblock (including this 4-byte header) |

Freeblocks are chained in order of increasing offset. The first freeblock
offset is in the b-tree page header at offset 1.

### 3.7 Usable Page Size

```
U = page_size - reserved_size
```

All cell content, headers, and pointer arrays must fit within `U` bytes.
The minimum U is 480.

---

## 4. Cell Formats for Each Page Type

### 4.1 Table B-Tree Leaf Cell (Page Type 13 / 0x0d)

This is the most important cell type for data extraction.

```
+-------------------------------+
| varint: payload length (P)    |  Total bytes of payload, including overflow
+-------------------------------+
| varint: rowid (integer key)  |  64-bit signed integer
+-------------------------------+
| payload (initial portion)     |  min(P, local_payload_size) bytes
+-------------------------------+
| uint32_be: overflow page (4)  |  Omitted if all payload fits on page
+-------------------------------+
```

### 4.2 Table B-Tree Interior Cell (Page Type 5 / 0x05)

```
+-------------------------------+
| uint32_be: left child page    |  4-byte page number of left child
+-------------------------------+
| varint: key (rowid)           |  Integer key (no payload on interior pages)
+-------------------------------+
```

### 4.3 Index B-Tree Leaf Cell (Page Type 10 / 0x0a)

```
+-------------------------------+
| varint: payload length (P)    |  Total bytes of key payload
+-------------------------------+
| payload (initial portion)     |  min(P, local_payload_size) bytes
+-------------------------------+
| uint32_be: overflow page (4)  |  Omitted if all payload fits on page
+-------------------------------+
```

### 4.4 Index B-Tree Interior Cell (Page Type 2 / 0x02)

```
+-------------------------------+
| uint32_be: left child page    |  4-byte page number
+-------------------------------+
| varint: payload length (P)    |  Total bytes of key payload
+-------------------------------+
| payload (initial portion)     |  min(P, local_payload_size) bytes
+-------------------------------+
| uint32_be: overflow page (4)  |  Omitted if all payload fits on page
+-------------------------------+
```

### 4.5 Summary Table

| Element | Table Leaf (0x0d) | Table Interior (0x05) | Index Leaf (0x0a) | Index Interior (0x02) |
|---------|:-:|:-:|:-:|:-:|
| 4-byte left child page | | Yes | | Yes |
| varint payload length | Yes | | Yes | Yes |
| varint rowid | Yes | Yes | | |
| byte array payload | Yes | | Yes | Yes |
| 4-byte overflow page | Yes | | Yes | Yes |

---

## 5. Varint Encoding

A varint encodes a 64-bit two's-complement integer in 1 to 9 bytes.

### 5.1 Encoding Rules

- Each byte uses the **high bit (0x80)** as a continuation flag.
- For bytes 1-8: the lower 7 bits are payload.
- If the high bit is **set**, another byte follows.
- If the high bit is **clear**, this is the last byte.
- The **9th byte** (if reached) uses **all 8 bits** as payload (no
  continuation bit needed — 9 bytes is the maximum).

### 5.2 Bit Layout

```
Byte 1: [1][b6 b5 b4 b3 b2 b1 b0]  <- bits 6..0 of value
Byte 2: [1][b13 b12 b11 b10 b9 b8 b7]  <- bits 13..7
Byte 3: [1][b20 ... b14]
  ...
Byte 8: [1][b55 ... b49]
Byte 9: [b63 b62 ... b56]  <- ALL 8 bits used, no continuation bit
```

### 5.3 Decoding Pseudocode

```python
def decode_varint(data, offset):
    """Returns (value, bytes_consumed). value is a 64-bit signed integer."""
    result = 0
    for i in range(9):
        byte = data[offset + i]
        if i == 8:
            # 9th byte: all 8 bits are payload
            result = (result << 8) | byte
            return (result, 9)
        else:
            # Bytes 1-8: lower 7 bits are payload
            result = (result << 7) | (byte & 0x7F)
            if (byte & 0x80) == 0:
                return (result, i + 1)
    return (result, 9)

# The result is a 64-bit two's-complement signed integer.
# If the top bit (bit 63) is set, the value is negative:
def to_signed_64(val):
    if val & (1 << 63):
        return val - (1 << 64)
    return val
```

### 5.4 Examples

| Value | Varint bytes (hex) |
|-------|---------------------|
| 0 | `00` |
| 1 | `01` |
| 127 | `7F` |
| 128 | `81 00` |
| 255 | `81 7F` |
| 16383 | `FF 7F` |
| 16384 | `81 80 00` |
| 2097151 | `FF FF 7F` |

---

## 6. Record (Payload) Format

The payload of a table b-tree leaf cell (or index b-tree key) is encoded
in "record format". A record contains a header followed by a body.

### 6.1 Record Header

```
+-------------------------------+
| varint: header length (H)     |  Total header size including this varint
+-------------------------------+
| varint: serial type [0]       |
+-------------------------------+
| varint: serial type [1]       |
+-------------------------------+
| ...                           |
+-------------------------------+
| varint: serial type [N-1]     |
+-------------------------------+
```

The header length varint gives the total number of bytes in the header,
**including itself**. The remaining `H - sizeof(header_length_varint)` bytes
contain serial type varints, one per column.

### 6.2 Serial Type Codes

| Serial Type | Content Size | Meaning |
|-------------|-------------|---------|
| 0 | 0 | NULL |
| 1 | 1 | 8-bit two's-complement integer |
| 2 | 2 | Big-endian 16-bit two's-complement integer |
| 3 | 3 | Big-endian 24-bit two's-complement integer |
| 4 | 4 | Big-endian 32-bit two's-complement integer |
| 5 | 6 | Big-endian 48-bit two's-complement integer |
| 6 | 8 | Big-endian 64-bit two's-complement integer |
| 7 | 8 | Big-endian IEEE 754-2008 64-bit float |
| 8 | 0 | Integer value 0 (schema format 4+ only) |
| 9 | 0 | Integer value 1 (schema format 4+ only) |
| 10, 11 | variable | Reserved for internal use (never in valid DB) |
| N >= 12, even | (N-12)/2 | BLOB of (N-12)/2 bytes |
| N >= 13, odd | (N-13)/2 | TEXT of (N-13)/2 bytes in DB text encoding |

### 6.3 Record Body

The body immediately follows the header. Each column's value occupies
exactly `content_size` bytes as determined by its serial type. The values
are in the same order as the serial type varints in the header.

For serial types 0, 8, 9, 12, and 13: the value occupies **0 bytes** in
the body (NULL, 0, 1, empty BLOB, empty string respectively).

### 6.4 Integer Decoding

```python
def decode_integer(data, offset, size):
    """Decode big-endian two's-complement integer of given size."""
    value = int.from_bytes(data[offset:offset+size], byteorder='big', signed=True)
    return value

# Special cases:
# serial_type 1 -> size=1,  int8
# serial_type 2 -> size=2,  int16
# serial_type 3 -> size=3,  int24
# serial_type 4 -> size=4,  int32
# serial_type 5 -> size=6,  int48
# serial_type 6 -> size=8,  int64
# serial_type 8 -> value=0, no bytes consumed
# serial_type 9 -> value=1, no bytes consumed
```

### 6.5 Float Decoding

```python
import struct

def decode_float(data, offset):
    """Decode IEEE 754-2008 64-bit float (big-endian)."""
    return struct.unpack('>d', data[offset:offset+8])[0]
```

### 6.6 Text Decoding

```python
def decode_text(data, offset, length, encoding):
    """Decode text according to database text encoding."""
    raw = data[offset:offset+length]
    if encoding == 1:    # UTF-8
        return raw.decode('utf-8')
    elif encoding == 2:  # UTF-16le
        return raw.decode('utf-16-le')
    elif encoding == 3:  # UTF-16be
        return raw.decode('utf-16-be')
```

### 6.7 BLOB Decoding

```python
def decode_blob(data, offset, length):
    return data[offset:offset+length]  # raw bytes, no conversion
```

### 6.8 Full Record Decoding Pseudocode

```python
def decode_record(payload, encoding):
    """Decode a complete record from payload bytes."""
    offset = 0

    # 1. Read header length varint
    header_length, varint_size = decode_varint(payload, offset)
    header_end = header_length
    offset += varint_size

    # 2. Read serial types
    serial_types = []
    while offset < header_end:
        st, vsz = decode_varint(payload, offset)
        serial_types.append(st)
        offset += vsz

    # 3. Read body values
    # offset is now at header_end (start of body)
    body_offset = header_end
    values = []
    for st in serial_types:
        value, body_offset = decode_value(payload, body_offset, st, encoding)
        values.append(value)

    return values

def decode_value(data, offset, serial_type, encoding):
    if serial_type == 0:
        return (None, offset)
    elif serial_type == 1:
        return (decode_integer(data, offset, 1), offset + 1)
    elif serial_type == 2:
        return (decode_integer(data, offset, 2), offset + 2)
    elif serial_type == 3:
        return (decode_integer(data, offset, 3), offset + 3)
    elif serial_type == 4:
        return (decode_integer(data, offset, 4), offset + 4)
    elif serial_type == 5:
        return (decode_integer(data, offset, 6), offset + 6)
    elif serial_type == 6:
        return (decode_integer(data, offset, 8), offset + 8)
    elif serial_type == 7:
        return (decode_float(data, offset), offset + 8)
    elif serial_type == 8:
        return (0, offset)
    elif serial_type == 9:
        return (1, offset)
    elif serial_type >= 12 and serial_type % 2 == 0:
        length = (serial_type - 12) // 2
        return (decode_blob(data, offset, length), offset + length)
    elif serial_type >= 13 and serial_type % 2 == 1:
        length = (serial_type - 13) // 2
        return (decode_text(data, offset, length, encoding), offset + length)
    else:
        raise ValueError(f"Unknown serial type: {serial_type}")
```

---

## 7. Overflow Page Handling

When a cell's payload exceeds the available space on the b-tree page,
the excess spills onto overflow pages forming a linked list.

### 7.1 Overflow Threshold Computation

Let:
- `U` = usable page size = page_size - reserved_size
- `P` = total payload size (from the cell's payload length varint)

**For table b-tree leaf pages (type 13):**

```
X = U - 35                          # max payload stored without overflow
M = ((U - 12) * 32 / 255) - 23     # min payload stored before spilling
K = M + ((P - M) % (U - 4))        # candidate for local storage
```

**For index b-tree pages (types 2, 10):**

```
X = ((U - 12) * 64 / 255) - 23     # max payload stored without overflow
M = ((U - 12) * 32 / 255) - 23     # same as table leaf
K = M + ((P - M) % (U - 4))        # same formula
```

**Decision logic (all page types with payload):**

```python
def compute_local_payload_size(P, U, is_table_leaf):
    if is_table_leaf:
        X = U - 35
    else:
        X = ((U - 12) * 64 / 255) - 23
    M = ((U - 12) * 32 / 255) - 23

    if P <= X:
        local = P                    # all payload fits, no overflow
    else:
        K = M + ((P - M) % (U - 4))
        if K <= X:
            local = K
        else:
            local = M               # minimum must be stored locally

    return local
```

All arithmetic is **integer arithmetic** (floor division).

### 7.2 Overflow Page Format

Each overflow page:

```
+-------------------------------+
| uint32_be: next page number   |  0 if this is the last page in chain
+-------------------------------+
| overflow data                 |  usable_size - 4 bytes of payload data
+-------------------------------+
| reserved region               |  reserved_size bytes (usually 0)
+-------------------------------+
```

**Data capacity per overflow page**: `U - 4` bytes (usable size minus
the 4-byte next-page pointer).

### 7.3 Overflow Chain Traversal

```python
def read_full_payload(page_data, local_payload, local_size, total_payload_size, page_reader):
    """
    Assemble the complete payload from local data + overflow chain.
    page_reader(page_number) -> page bytes (for random access)
    """
    payload = bytearray(local_payload[:local_size])
    remaining = total_payload_size - local_size

    # Read the overflow page number from the cell (4 bytes after local payload)
    overflow_page = read_uint32_be(page_data, cell_offset_after_local_payload)

    while overflow_page != 0 and remaining > 0:
        ovfl_page = page_reader(overflow_page)
        next_page = read_uint32_be(ovfl_page, 0)
        chunk_size = min(remaining, usable_size - 4)
        payload.extend(ovfl_page[4:4 + chunk_size])
        remaining -= chunk_size
        overflow_page = next_page

    return bytes(payload)
```

### 7.4 Sequential Stream Considerations

For a sequential gzip stream where random access is not available:

1. **Read all pages in order** from page 1 to page N.
2. **Buffer overflow pages** when encountered, or defer cell processing.
3. Alternative: Read the entire file into memory first (decompress
   gzip), then use random access by page number:
   `page_data = decompressed_data[(page_num - 1) * page_size : page_num * page_size]`

Since the total file is likely small (a lyrics database), decompressing
fully into memory is the simplest approach and enables random access for
overflow chains.

---

## 8. Schema Table (sqlite_schema / sqlite_master)

### 8.1 Location

- The schema table is always at **page 1** (root page = 1).
- Page 1 is always a **table b-tree** page.
- On page 1, the b-tree header starts at **offset 100** (after the
  100-byte database header).

### 8.2 Schema Table Structure

The schema table is structured as if created by:

```sql
CREATE TABLE sqlite_schema(
  type text,       -- 'table', 'index', 'view', 'trigger'
  name text,       -- object name
  tbl_name text,   -- associated table name
  rootpage integer,-- root page number (0/NULL for views, triggers, virtual tables)
  sql text         -- CREATE statement text (normalized)
);
```

### 8.3 Reading the Schema

```python
def parse_schema(decompressed_data, page_size, reserved_size, encoding):
    """Parse page 1 to extract all table/index schema entries."""
    entries = []

    # Page 1 b-tree header starts at offset 100
    page1 = decompressed_data[0:page_size]
    bt_header_offset = 100

    page_type = page1[bt_header_offset]
    cell_count = read_uint16_be(page1, bt_header_offset + 3)

    # Cell pointer array starts at bt_header_offset + header_size
    is_interior = page_type in (2, 5)
    header_size = 12 if is_interior else 8
    ptr_array_start = bt_header_offset + header_size

    # If page 1 is an interior page, we need to traverse child pages
    # (rare for small databases — usually page 1 is a leaf page, type 13)

    if page_type == 13:
        for i in range(cell_count):
            cell_offset = read_uint16_be(page1, ptr_array_start + i * 2)
            record = read_table_leaf_cell(page1, cell_offset, page_size,
                                           reserved_size, decompressed_data)
            # record = [type, name, tbl_name, rootpage, sql]
            entries.append({
                'type': record[0],
                'name': record[1],
                'tbl_name': record[2],
                'rootpage': record[3],
                'sql': record[4],
            })
    elif page_type == 5:
        # Interior page: follow child pointers + right-most pointer
        # This requires traversing child pages (see section 9)
        pass

    return entries
```

### 8.4 Finding Table Root Pages

For the target database with tables `tracks` and `lyrics`:

```python
schema = parse_schema(data, page_size, reserved_size, encoding)

for entry in schema:
    if entry['type'] == 'table' and entry['name'] == 'tracks':
        tracks_root_page = entry['rootpage']  # e.g., 2
        tracks_sql = entry['sql']              # CREATE TABLE statement
    elif entry['type'] == 'table' and entry['name'] == 'lyrics':
        lyrics_root_page = entry['rootpage']   # e.g., 3
        lyrics_sql = entry['sql']
```

### 8.5 Parsing CREATE TABLE for Column Order

The `sql` column in sqlite_schema contains the normalized CREATE TABLE
statement. To determine column order, parse the column definitions:

```sql
CREATE TABLE tracks(
  id INTEGER PRIMARY KEY,
  name TEXT,
  artist_name TEXT,
  album_name TEXT,
  duration INTEGER,
  last_lyrics_id INTEGER
)
```

**Important**: When a table has `INTEGER PRIMARY KEY`, that column
aliases the rowid. In the record, that column appears as **NULL**
(serial type 0), and the actual value is the **rowid** (the b-tree key).

```python
def parse_column_order(create_sql):
    """
    Parse CREATE TABLE statement to get column names and order.
    Returns list of (column_name, is_integer_primary_key).
    """
    # Extract the column definitions between the outermost parentheses
    # This is a simplified parser; real SQL parsing is more complex
    # but for well-formed CREATE TABLE statements this suffices.

    start = create_sql.index('(')
    # Find matching close paren (naive: last paren in string)
    end = create_sql.rindex(')')
    body = create_sql[start+1:end]

    columns = []
    # Split by commas, but handle commas inside parens (e.g., DECIMAL(10,5))
    depth = 0
    current = []
    for char in body:
        if char == '(':
            depth += 1
            current.append(char)
        elif char == ')':
            depth -= 1
            current.append(char)
        elif char == ',' and depth == 0:
            columns.append(''.join(current).strip())
            current = []
        else:
            current.append(char)
    if current:
        columns.append(''.join(current).strip())

    result = []
    for col_def in columns:
        # Skip table-level constraints (PRIMARY KEY, UNIQUE, CHECK, FOREIGN KEY, CONSTRAINT)
        upper = col_def.upper().lstrip()
        if upper.startswith(('PRIMARY KEY', 'UNIQUE', 'CHECK',
                            'FOREIGN KEY', 'CONSTRAINT')):
            continue

        # First token is the column name
        parts = col_def.split()
        col_name = parts[0].strip('"[]`')
        is_ipk = 'INTEGER' in upper and 'PRIMARY' in upper and 'KEY' in upper
        result.append((col_name, is_ipk))

    return result

# For tracks table:
# columns = [
#   ('id', True),            # INTEGER PRIMARY KEY -> stored as rowid, record has NULL
#   ('name', False),
#   ('artist_name', False),
#   ('album_name', False),
#   ('duration', False),
#   ('last_lyrics_id', False),
# ]

# When decoding a record, the 'id' column will have serial type 0 (NULL).
# The actual id value is the rowid from the cell.
```

### 8.6 Handling INTEGER PRIMARY KEY in Records

When a column is `INTEGER PRIMARY KEY`:
- The record stores **NULL** (serial type 0) for that column.
- The actual value is the **rowid** (the b-tree key from the cell).

```python
def extract_row(columns, record_values, rowid):
    """Map record values to column names, substituting rowid for IPK."""
    result = {}
    for i, (col_name, is_ipk) in enumerate(columns):
        if is_ipk:
            result[col_name] = rowid
        elif i < len(record_values):
            result[col_name] = record_values[i]
        else:
            # Record may have fewer values than columns (ALTER TABLE ADD COLUMN)
            result[col_name] = None  # use default value
    return result
```

---

## 9. B-tree Traversal (Sequential Access)

For a sequential gzip stream parser, the simplest approach is:

1. Decompress the entire gzip stream into memory.
2. Access pages by offset: `page_data = buf[(page_num - 1) * page_size : page_num * page_size]`

### 9.1 Reading a Table B-tree (All Rows)

```python
def read_table_btree(buf, root_page_num, page_size, reserved_size, encoding):
    """Read all rows from a table b-tree starting at root_page_num."""
    rows = []
    _traverse_table_btree(buf, root_page_num, page_size, reserved_size,
                          encoding, rows)
    return rows

def _traverse_table_btree(buf, page_num, page_size, reserved_size,
                           encoding, rows):
    U = page_size - reserved_size
    page = buf[(page_num - 1) * page_size : page_num * page_size]

    # On page 1, b-tree header starts at offset 100
    bt_offset = 100 if page_num == 1 else 0

    page_type = page[bt_offset]
    cell_count = read_uint16_be(page, bt_offset + 3)

    is_interior = page_type in (2, 5)
    header_size = 12 if is_interior else 8
    ptr_array_start = bt_offset + header_size

    if page_type == 13:  # Leaf table page
        for i in range(cell_count):
            cell_ptr = read_uint16_be(page, ptr_array_start + i * 2)
            rowid, record_data = read_table_leaf_cell(
                buf, page, cell_ptr, page_size, U, reserved_size)
            values = decode_record(record_data, encoding)
            rows.append((rowid, values))

    elif page_type == 5:  # Interior table page
        for i in range(cell_count):
            cell_ptr = read_uint16_be(page, ptr_array_start + i * 2)
            child_page = read_uint32_be(page, cell_ptr)
            _traverse_table_btree(buf, child_page, page_size,
                                  reserved_size, encoding, rows)
        # Right-most pointer
        rightmost = read_uint32_be(page, bt_offset + 8)
        _traverse_table_btree(buf, rightmost, page_size,
                              reserved_size, encoding, rows)

    else:
        raise ValueError(f"Unexpected page type {page_type} on page {page_num}")
```

### 9.2 Reading a Table Leaf Cell with Overflow

```python
def read_table_leaf_cell(buf, page, cell_offset, page_size, U, reserved_size):
    """Read a table b-tree leaf cell. Returns (rowid, full_payload_bytes)."""
    offset = cell_offset

    # 1. Payload length (varint)
    payload_size, vsz = decode_varint(page, offset)
    offset += vsz

    # 2. Rowid (varint)
    rowid, vsz = decode_varint(page, offset)
    offset += vsz

    # 3. Compute local payload size
    X = U - 35
    M = ((U - 12) * 32 // 255) - 23

    if payload_size <= X:
        local_size = payload_size
    else:
        K = M + ((payload_size - M) % (U - 4))
        if K <= X:
            local_size = K
        else:
            local_size = M

    # 4. Read local payload
    local_payload = page[offset : offset + local_size]
    offset += local_size

    # 5. Handle overflow
    if local_size < payload_size:
        # Read 4-byte overflow page number
        overflow_page = read_uint32_be(page, offset)
        full_payload = bytearray(local_payload)
        remaining = payload_size - local_size

        while overflow_page != 0 and remaining > 0:
            ovfl = buf[(overflow_page - 1) * page_size : overflow_page * page_size]
            next_page = read_uint32_be(ovfl, 0)
            chunk = min(remaining, U - 4)
            full_payload.extend(ovfl[4 : 4 + chunk])
            remaining -= chunk
            overflow_page = next_page

        return (rowid, bytes(full_payload))
    else:
        return (rowid, bytes(local_payload))
```

---

## 10. Freelist Pages

Unused pages are tracked on a freelist. For a read-only parser, freelist
pages can be **skipped** — they contain no useful data.

### 10.1 Freelist Trunk Page Format

```
+-----------------------------------+
| uint32_be: next trunk page (0=last)|
+-----------------------------------+
| uint32_be: leaf count (L)          |
+-----------------------------------+
| uint32_be: leaf page [0]           |
+-----------------------------------+
| uint32_be: leaf page [1]           |
+-----------------------------------+
| ...                                |
+-----------------------------------+
| uint32_be: leaf page [L-1]         |
+-----------------------------------+
```

Freelist leaf pages contain no information and can be ignored.

### 10.2 Header Fields

- Offset 32 (4 bytes): First freelist trunk page number (0 = no freelist)
- Offset 36 (4 bytes): Total number of freelist pages

---

## 11. Pointer Map (Ptrmap) Pages

Ptrmap pages exist only when auto-vacuum or incremental-vacuum is enabled
(offset 52 in header is non-zero).

### 11.1 Ptrmap Page Location

- First ptrmap page is **page 2** (when enabled).
- `J = U / 5` entries per ptrmap page.
- Ptrmap page B covers pages B+1 through B+J.
- Next ptrmap page is at B+J+1.

### 11.2 Ptrmap Entry Format (5 bytes each)

| Offset | Size | Description |
|--------|------|-------------|
| 0 | 1 | Page type: 1=root, 2=freelist, 3=overflow first, 4=overflow chain, 5=non-root btree |
| 1 | 4 | Parent page number (big-endian) |

For a read-only parser, ptrmap pages can be **skipped** if you are
traversing b-trees from their root pages.

---

## 12. Complete Parser Pseudocode

### 12.1 Main Entry Point

```python
def parse_sqlite_file(gzip_stream):
    """Parse a .sqlite3 file from a gzip stream."""
    import gzip
    data = gzip.decompress(gzip_stream.read())

    # --- Parse database header ---
    magic = data[0:16]
    assert magic == b'SQLite format 3\x00', "Not a SQLite database"

    page_size = read_uint16_be(data, 16)
    if page_size == 1:
        page_size = 65536

    reserved_size = data[20]
    U = page_size - reserved_size
    encoding = read_uint32_be(data, 56)

    # Validate in-header page count
    change_counter = read_uint32_be(data, 24)
    version_valid_for = read_uint32_be(data, 92)
    in_header_size = read_uint32_be(data, 28)

    if in_header_size != 0 and change_counter == version_valid_for:
        page_count = in_header_size
    else:
        page_count = len(data) // page_size

    # --- Parse schema (page 1) ---
    schema = parse_schema(data, page_size, reserved_size, encoding)

    # --- Find table root pages ---
    tables = {}
    for entry in schema:
        if entry['type'] == 'table' and not entry['name'].startswith('sqlite_'):
            columns = parse_column_order(entry['sql'])
            tables[entry['name']] = {
                'rootpage': entry['rootpage'],
                'columns': columns,
                'sql': entry['sql'],
            }

    # --- Read each table ---
    results = {}
    for table_name, info in tables.items():
        rows = read_table_btree(data, info['rootpage'], page_size,
                                reserved_size, encoding)
        # Map record values to column names
        mapped = []
        for rowid, values in rows:
            row = extract_row(info['columns'], values, rowid)
            mapped.append(row)
        results[table_name] = mapped

    return results

def read_uint16_be(data, offset):
    return (data[offset] << 8) | data[offset + 1]

def read_uint32_be(data, offset):
    return (data[offset] << 24) | (data[offset+1] << 16) | \
           (data[offset+2] << 8) | data[offset+3]
```

### 12.2 Expected Output for Target Database

```python
results = parse_sqlite_file(gzip_stream)

# results['tracks'] = [
#   {'id': 1, 'name': '...', 'artist_name': '...', 'album_name': '...',
#    'duration': 123, 'last_lyrics_id': 5},
#   ...
# ]

# results['lyrics'] = [
#   {'id': 1, 'instrumental': 0, 'plain_lyrics': '...',
#    'synced_lyrics': '...', 'lyricsfile': b'...'},
#   ...
# ]
```

---

## 13. Edge Cases and Gotchas

### 13.1 INTEGER PRIMARY KEY

If a column is declared `INTEGER PRIMARY KEY`, it becomes an alias for
the rowid. In the record, that column position stores **NULL** (serial
type 0). The actual value must be read from the cell's rowid varint.

### 13.2 REAL Affinity Optimization

If a column has REAL affinity and its value can be represented as an
integer (no fractional part, fits in int64), SQLite stores it as an
integer serial type to save space. When reading, convert back to float
if the column has REAL affinity.

### 13.3 ALTER TABLE ADD COLUMN

Records may have fewer values than the table has columns (after
`ALTER TABLE ... ADD COLUMN`). Missing trailing values should use the
column's default value (or NULL if no default).

### 13.4 Page 1 Interior Page

Page 1 is usually a leaf page for small databases, but can be an
interior page for large schemas. When interior, it has 100 fewer bytes
available, potentially holding only 1 key (the minimum is normally 2).

### 13.5 Empty Page Cell Content Offset

If cell count is 0 and page size is 65536 with 0 reserved bytes, the
cell content area start field is **0** (meaning 65536).

### 13.6 Overflow Page Capacity

Each overflow page holds `U - 4` bytes of data (the first 4 bytes are
the next-page pointer). For a 4096-byte page with 0 reserved: `4096 - 4 = 4092` bytes per overflow page.

### 13.7 Text Encoding

Text encoding is database-wide (set at creation, cannot be changed).
For this database, it is most likely **UTF-8** (encoding value 1).

### 13.8 Schema Format 4

Serial types 8 and 9 (integer 0 and integer 1, occupying 0 bytes in the
body) are only valid in schema format 4+. Most modern databases use
format 4.

### 13.9 Lock-Byte Page

For databases larger than 1,073,741,824 bytes (~1GB), one page is
reserved as a lock-byte page (at offset 1,073,741,824). This page
should be skipped. For the target lyrics database, this is unlikely
to be relevant.

### 13.10 WITHOUT ROWID Tables

If a table is created with `WITHOUT ROWID`, it uses an **index b-tree**
(page types 2/10) instead of a table b-tree (page types 5/13). The key
is a record of primary key columns followed by remaining columns. There
is no rowid. For the target database, `tracks` and `lyrics` are
standard rowid tables, so this does not apply.

---

## 14. Quick Reference: Byte-Level Layout

### 14.1 Database Header (100 bytes at file start)

```
Offset  Size  Field
0       16    Magic: "SQLite format 3\0"
16      2     Page size (BE uint16; 1 = 65536)
18      1     Write version (1=legacy, 2=WAL)
19      1     Read version (1=legacy, 2=WAL)
20      1     Reserved bytes per page
21      1     Max payload fraction (64)
22      1     Min payload fraction (32)
23      1     Leaf payload fraction (32)
24      4     File change counter (BE)
28      4     Page count (BE; may be 0 = invalid)
32      4     First freelist trunk page (BE)
36      4     Freelist page count (BE)
40      4     Schema cookie (BE)
44      4     Schema format (BE; 1-4)
48      4     Suggested cache size (BE)
52      4     Largest root page / auto-vacuum (BE)
56      4     Text encoding (BE; 1=UTF8, 2=UTF16le, 3=UTF16be)
60      4     User version (BE)
64      4     Incremental vacuum (BE)
68      4     Application ID (BE)
72      20    Reserved (zeros)
92      4     Version-valid-for (BE)
96      4     SQLITE_VERSION_NUMBER (BE)
```

### 14.2 B-tree Page Header (8 or 12 bytes)

```
Offset  Size  Field
0       1     Page type (2, 5, 10, 13)
1       2     First freeblock offset (BE; 0=none)
3       2     Cell count (BE)
5       2     Cell content area start (BE; 0=65536)
7       1     Fragmented free bytes
8       4     Right-most pointer (BE; interior pages only)
```

### 14.3 Cell Pointer Array

```
Offset  Size  Field
0       2     Cell pointer [0] (BE; offset within page)
2       2     Cell pointer [1]
...
```

### 14.4 Table Leaf Cell (type 13)

```
Offset  Size      Field
0       varint    Payload length (P)
?       varint    Rowid
?       P_local   Payload (initial portion)
?       4         Overflow page number (if P > local)
```

### 14.5 Record Format

```
Offset  Size      Field
0       varint    Header length (H; includes this varint)
?       varint    Serial type [0]
?       varint    Serial type [1]
...
?       varies    Value [0] (body)
?       varies    Value [1]
...
```

### 14.6 Overflow Page

```
Offset  Size  Field
0       4     Next overflow page (BE; 0 = last)
4       U-4   Overflow data
```

### 14.7 Serial Type Quick Reference

```
Type  Size  Meaning
0     0     NULL
1     1     int8
2     2     int16 BE
3     3     int24 BE
4     4     int32 BE
5     6     int48 BE
6     8     int64 BE
7     8     float64 BE (IEEE 754)
8     0     integer 0
9     0     integer 1
>=12  (N-12)/2   BLOB
>=13  (N-13)/2   TEXT (in DB encoding)
```

---

## 15. Implementation Checklist

- [ ] Read and validate 16-byte magic string
- [ ] Parse 100-byte database header (page_size, reserved_size, encoding, page_count)
- [ ] Implement varint decoder (1-9 bytes, big-endian, 7-bit chunks)
- [ ] Implement record decoder (header + serial types + body values)
- [ ] Implement table leaf cell reader (payload varint + rowid varint + payload + overflow)
- [ ] Implement overflow chain reader (4-byte next-page pointer + data)
- [ ] Implement table interior cell reader (4-byte child + rowid varint)
- [ ] Implement b-tree traversal (recursive: interior -> leaf)
- [ ] Parse page 1 schema table (offset 100 for b-tree header)
- [ ] Parse CREATE TABLE SQL for column order and IPK detection
- [ ] Map record values to columns (substitute rowid for INTEGER PRIMARY KEY)
- [ ] Handle REAL affinity integer-to-float conversion
- [ ] Handle missing trailing columns (ALTER TABLE ADD COLUMN)
- [ ] Handle empty pages (cell content area = 0 means 65536)
- [ ] Skip freelist pages, ptrmap pages, lock-byte page
