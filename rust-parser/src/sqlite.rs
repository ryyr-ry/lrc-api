//! Direct SQLite page format parsing.
//!
//! Reads pages sequentially from a gzip-decompressed stream. No SQLite
//! library involved. Mirrors scripts/sqlite_page_parser.py exactly.

use std::collections::HashMap;

pub const PAGE_TABLE_LEAF: u8 = 13;
pub const PAGE_TABLE_INTERIOR: u8 = 5;

#[derive(Debug)]
pub struct Schema {
    pub tracks_rootpage: u32,
    pub lyrics_rootpage: u32,
    pub tracks_columns: Vec<String>,
    pub lyrics_columns: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DecodedCell {
    pub rowid: u64,
    pub ncols: usize,
    pub serial_types: Vec<u64>,
    pub payload: Vec<u8>,
    pub header_length: usize,
}

#[derive(Debug, Clone)]
pub struct PendingOverflow {
    pub rowid: u64,
    pub ovfl_page: u32,
    pub total_payload_size: usize,
    /// Length of the local payload stored in the spill file.
    pub local_len: usize,
    /// Offset of local_payload within the spill file.
    pub spill_offset: u64,
    pub local_payload: Vec<u8>,
    pub resolved: bool,
}

pub fn decode_varint(data: &[u8], offset: usize) -> (u64, usize) {
    let mut result: u64 = 0;
    for i in 0..9 {
        if offset + i >= data.len() {
            return (result, i + 1);
        }
        let b = data[offset + i];
        if i == 8 {
            result = (result << 8) | b as u64;
            return (result, 9);
        }
        result = (result << 7) | (b & 0x7F) as u64;
        if b & 0x80 == 0 {
            return (result, i + 1);
        }
    }
    (result, 9)
}

pub fn serial_type_size(st: u64) -> usize {
    match st {
        0 | 8 | 9 => 0,
        1 => 1,
        2 => 2,
        3 => 3,
        4 => 4,
        5 => 6,
        6 | 7 => 8,
        _ if st >= 12 && st % 2 == 0 => ((st - 12) / 2) as usize,
        _ if st >= 13 && st % 2 == 1 => ((st - 13) / 2) as usize,
        _ => 0,
    }
}

/// Decode a serial value into a UTF-8 string for TEXT columns.
/// Returns None for NULL; ints/floats are returned as decimal strings
/// only when needed (duration, ids). We decode to an owned Vec<u8>
/// plus a kind tag to keep the hot path allocation-free.
#[derive(Debug, Clone, PartialEq)]
pub enum SerialValue {
    Null,
    Int(i64),
    Float(f64),
    Text(String),
    Blob(Vec<u8>),
}

pub fn decode_serial_value(data: &[u8], offset: usize, st: u64) -> (SerialValue, usize) {
    let sz = serial_type_size(st);
    if offset.checked_add(sz).map_or(true, |end| end > data.len()) {
        return (SerialValue::Null, offset);
    }
    match st {
        0 => (SerialValue::Null, offset),
        8 => (SerialValue::Int(0), offset),
        9 => (SerialValue::Int(1), offset),
        7 => {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&data[offset..offset + 8]);
            (SerialValue::Float(f64::from_be_bytes(bytes)), offset + 8)
        }
        1..=6 => {
            let mut val: i64 = 0;
            for i in 0..sz {
                val = (val << 8) | data[offset + i] as i64;
            }
            (SerialValue::Int(val), offset + sz)
        }
        _ if st >= 13 && st % 2 == 1 => {
            let raw = &data[offset..offset + sz];
            let text = String::from_utf8_lossy(raw).into_owned();
            (SerialValue::Text(text), offset + sz)
        }
        _ if st >= 12 && st % 2 == 0 => {
            (SerialValue::Blob(data[offset..offset + sz].to_vec()), offset + sz)
        }
        _ => (SerialValue::Null, offset),
    }
}

/// Compute the local payload size (SQLite's spill-to-overflow rule).
pub fn compute_local_payload_size(payload_size: usize, usable_size: usize) -> usize {
    let u = usable_size;
    let x = u - 35;
    let m = ((u - 12) * 32 / 255) - 23;
    if payload_size <= x {
        return payload_size;
    }
    let k = m + ((payload_size - m) % (u - 4));
    if k <= x {
        k
    } else {
        m
    }
}

/// Parse all leaf-table cells from a type-13 page.
/// Returns cells whose payload is fully local, plus a list of pending
/// overflow records (resolved against the ring buffer by the caller).
pub fn parse_leaf_table_cells(
    page_data: &[u8],
    bt_offset: usize,
    usable_size: usize,
    ring_buffer: &RingBuffer,
) -> (Vec<DecodedCell>, Vec<PendingOverflow>) {
    if page_data.len() <= bt_offset || page_data[bt_offset] != PAGE_TABLE_LEAF {
        return (Vec::new(), Vec::new());
    }

    let cell_count = u16::from_be_bytes([
        page_data[bt_offset + 3],
        page_data[bt_offset + 4],
    ]) as usize;
    if cell_count == 0 || cell_count > page_data.len() / 4 {
        return (Vec::new(), Vec::new());
    }

    let ptr_array_start = bt_offset + 8;
    let min_valid_ptr = ptr_array_start + cell_count * 2;
    if min_valid_ptr >= page_data.len() {
        return (Vec::new(), Vec::new());
    }

    let mut cells = Vec::with_capacity(cell_count);
    let mut pending = Vec::new();

    for i in 0..cell_count {
        let ptr_off = ptr_array_start + i * 2;
        if ptr_off + 2 > page_data.len() {
            break;
        }
        let cell_ptr = u16::from_be_bytes([page_data[ptr_off], page_data[ptr_off + 1]]) as usize;
        if cell_ptr < min_valid_ptr || cell_ptr >= page_data.len() {
            continue;
        }

        let (payload_size, vsz) = decode_varint(page_data, cell_ptr);
        let payload_size = payload_size as usize;
        let (rowid, vsz2) = decode_varint(page_data, cell_ptr + vsz);
        let body_off = cell_ptr + vsz + vsz2;

        let local_size = compute_local_payload_size(payload_size, usable_size);

        if local_size >= payload_size {
            if body_off + local_size > page_data.len() {
                continue;
            }
            let payload = page_data[body_off..body_off + local_size].to_vec();
            if let Some(mut cell) = decode_record(payload) {
                cell.rowid = rowid;
                cells.push(cell);
            }
        } else {
            if body_off + local_size + 4 > page_data.len() {
                continue;
            }
            let local_payload = page_data[body_off..body_off + local_size].to_vec();
            let ovfl_page = u32::from_be_bytes([
                page_data[body_off + local_size],
                page_data[body_off + local_size + 1],
                page_data[body_off + local_size + 2],
                page_data[body_off + local_size + 3],
            ]);

            // Try to resolve the overflow chain from the ring buffer now.
            let mut payload = local_payload.clone();
            let mut remaining = payload_size - local_size;
            let mut current = ovfl_page;
            let mut resolved = true;
            while current != 0 && remaining > 0 {
                match ring_buffer.get(current) {
                    Some(ovfl_data) => {
                        if ovfl_data.len() < 4 {
                            resolved = false;
                            break;
                        }
                        let next_page = u32::from_be_bytes([
                            ovfl_data[0],
                            ovfl_data[1],
                            ovfl_data[2],
                            ovfl_data[3],
                        ]);
                        let chunk = remaining.min(usable_size - 4);
                        let avail = ovfl_data.len() - 4;
                        let take = chunk.min(avail);
                        payload.extend_from_slice(&ovfl_data[4..4 + take]);
                        remaining -= take;
                        current = next_page;
                    }
                    None => {
                        resolved = false;
                        break;
                    }
                }
            }

            if resolved && remaining == 0 {
                if let Some(mut cell) = decode_record(payload) {
                    cell.rowid = rowid;
                    cells.push(cell);
                }
            } else {
                let local_len = local_payload.len();
                pending.push(PendingOverflow {
                    rowid,
                    ovfl_page,
                    total_payload_size: payload_size,
                    local_len,
                    spill_offset: 0,
                    local_payload,
                    resolved: false,
                });
            }
        }
    }

    (cells, pending)
}

/// Decode a record payload (varint header + serial types + body).
pub fn decode_record(payload: Vec<u8>) -> Option<DecodedCell> {
    if payload.len() < 2 {
        return None;
    }
    let (header_length, hvsz) = decode_varint(&payload, 0);
    let header_length = header_length as usize;
    if header_length < hvsz || header_length > payload.len() {
        return None;
    }

    let mut serial_types = Vec::new();
    let mut off = hvsz;
    while off < header_length {
        let (st, stvsz) = decode_varint(&payload, off);
        serial_types.push(st);
        off += stvsz;
    }
    let ncols = serial_types.len();
    let _ = off;
    Some(DecodedCell {
        rowid: 0,
        ncols,
        serial_types,
        payload,
        header_length,
    })
}

/// A ring buffer of recently seen pages keyed by page number.
pub struct RingBuffer {
    capacity: usize,
    order: std::collections::VecDeque<u32>,
    pages: HashMap<u32, Vec<u8>>,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Self {
        RingBuffer {
            capacity,
            order: std::collections::VecDeque::with_capacity(capacity),
            pages: HashMap::with_capacity(capacity),
        }
    }

    pub fn put(&mut self, page_num: u32, page_data: Vec<u8>) {
        if self.order.len() >= self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.pages.remove(&oldest);
            }
        }
        self.order.push_back(page_num);
        self.pages.insert(page_num, page_data);
    }

    pub fn get(&self, page_num: u32) -> Option<&Vec<u8>> {
        self.pages.get(&page_num)
    }

    pub fn contains(&self, page_num: u32) -> bool {
        self.pages.contains_key(&page_num)
    }
}

/// Parse the database header (first 100 bytes).
pub fn parse_db_header(header: &[u8]) -> Option<(usize, usize, u64, u32)> {
    if header.len() < 100 || &header[0..16] != b"SQLite format 3\x00" {
        return None;
    }
    let raw_ps = u16::from_be_bytes([header[16], header[17]]) as usize;
    let page_size = if raw_ps == 1 { 65536 } else { raw_ps };
    let reserved = header[20] as usize;
    let usable = page_size - reserved;
    let page_count = u32::from_be_bytes([header[28], header[29], header[30], header[31]]) as u64;
    let encoding = u32::from_be_bytes([header[56], header[57], header[58], header[59]]);
    Some((page_size, usable, page_count, encoding))
}


#[cfg(test)]
mod debug_tests {
    use super::*;

    #[test]
    fn debug_parse_page() {
        use flate2::read::GzDecoder;
        use std::io::Read;
        let file = std::fs::File::open("/tmp/opencode/test_small.sqlite3.gz").unwrap();
        let mut gz = GzDecoder::new(file);
        let mut all = Vec::new();
        gz.read_to_end(&mut all).unwrap();
        println!("total decompressed: {}", all.len());
        let page = &all[4096..8192]; // page 2
        println!("page2 type: {:x}", page[0]);
        let cell_count = u16::from_be_bytes([page[3], page[4]]) as usize;
        println!("page2 cell_count: {}", cell_count);
        let ring = RingBuffer::new(4);
        let (cells, pending) = parse_leaf_table_cells(page, 0, 4096, &ring);
        println!("cells parsed: {} pending: {}", cells.len(), pending.len());
        for c in &cells {
            println!("  cell rowid={} ncols={}", c.rowid, c.ncols);
        }
    }
}
