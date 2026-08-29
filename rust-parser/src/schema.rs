//! Schema parsing: walk sqlite_master to find tracks/lyrics CREATE TABLE.
//!
//! The Python implementation uses random-access reads on the gzip stream
//! (via RapidgzipFile). Here the supplier reopens the gzip file and
//! decompresses forward when the requested page is behind the current
//! position. Schema pages are few, so reopens are cheap.

use crate::sqlite::{decode_record, decode_varint};
use flate2::read::GzDecoder;
use std::collections::{HashMap, HashSet};
use std::io::Read;

#[derive(Debug)]
pub struct TableDef {
    pub rootpage: u32,
    pub columns: Vec<String>,
    pub sql: String,
}

pub fn parse_create_table(sql: &str) -> Vec<String> {
    let start = match sql.find('(') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let end = match sql.rfind(')') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let body = &sql[start + 1..end];

    let mut columns = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for ch in body.chars() {
        match ch {
            '(' => {
                depth += 1;
                current.push(ch);
            }
            ')' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => {
                columns.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        columns.push(current.trim().to_string());
    }

    let mut result = Vec::new();
    for col_def in columns {
        let upper = col_def.trim_start().to_uppercase();
        if upper.starts_with("PRIMARY KEY")
            || upper.starts_with("UNIQUE")
            || upper.starts_with("CHECK")
            || upper.starts_with("FOREIGN KEY")
            || upper.starts_with("CONSTRAINT")
        {
            continue;
        }
        let parts: Vec<&str> = col_def.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }
        let col_name = parts[0].trim_matches(|c| c == '"' || c == '[' || c == ']' || c == '`');
        result.push(col_name.to_string());
    }
    result
}

pub fn parse_schema(
    gz_path: &str,
    page_size: usize,
    usable_size: usize,
    text_encoding: u32,
) -> HashMap<String, TableDef> {
    let mut tables = HashMap::new();
    let mut visited = HashSet::new();
    collect_schema_pages(
        gz_path, page_size, usable_size, text_encoding, 1, &mut visited, &mut tables,
    );
    tables
}

fn read_page_at(
    gz_path: &str,
    page_size: usize,
    target: u32,
) -> Option<Vec<u8>> {
    let file = std::fs::File::open(gz_path).ok()?;
    let mut gz = GzDecoder::new(std::io::BufReader::new(file));
    let mut page = vec![0u8; page_size];
    for _ in 1..target {
        match gz.read_exact(&mut page) {
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    match gz.read_exact(&mut page) {
        Ok(_) => Some(page),
        Err(_) => None,
    }
}

fn collect_schema_pages(
    gz_path: &str,
    page_size: usize,
    usable_size: usize,
    text_encoding: u32,
    page_num: u32,
    visited: &mut HashSet<u32>,
    tables: &mut HashMap<String, TableDef>,
) {
    if page_num < 1 || visited.contains(&page_num) {
        return;
    }
    visited.insert(page_num);

    let page_data = match read_page_at(gz_path, page_size, page_num) {
        Some(p) => p,
        None => return,
    };
    let bt_offset = if page_num == 1 { 100 } else { 0 };
    if page_data.len() <= bt_offset {
        return;
    }
    let page_type = page_data[bt_offset];

    if page_type == 13 {
        parse_schema_leaf(
            gz_path,
            &page_data,
            bt_offset,
            page_size,
            usable_size,
            text_encoding,
            visited,
            tables,
        );
    } else if page_type == 5 {
        parse_schema_interior(
            gz_path,
            &page_data,
            bt_offset,
            page_size,
            usable_size,
            text_encoding,
            visited,
            tables,
        );
    }
}

fn parse_schema_leaf(
    gz_path: &str,
    page_data: &[u8],
    bt_offset: usize,
    page_size: usize,
    usable_size: usize,
    text_encoding: u32,
    visited: &mut HashSet<u32>,
    tables: &mut HashMap<String, TableDef>,
) {
    if bt_offset + 5 > page_data.len() {
        return;
    }
    let cell_count =
        u16::from_be_bytes([page_data[bt_offset + 3], page_data[bt_offset + 4]]) as usize;
    let ptr_array_start = bt_offset + 8;

    for i in 0..cell_count {
        let ptr_off = ptr_array_start + i * 2;
        if ptr_off + 2 > page_data.len() {
            break;
        }
        let cell_ptr =
            u16::from_be_bytes([page_data[ptr_off], page_data[ptr_off + 1]]) as usize;
        if cell_ptr >= page_data.len() {
            continue;
        }
        let (payload_size, vsz) = decode_varint(page_data, cell_ptr);
        let payload_size = payload_size as usize;
        let (_, vsz2) = decode_varint(page_data, cell_ptr + vsz);
        let body_off = cell_ptr + vsz + vsz2;
        let local_size = crate::sqlite::compute_local_payload_size(payload_size, usable_size);
        if body_off + local_size > page_data.len() {
            continue;
        }
        let mut payload = page_data[body_off..body_off + local_size].to_vec();
        if local_size < payload_size {
            if body_off + local_size + 4 > page_data.len() {
                continue;
            }
            let mut ovfl = u32::from_be_bytes([
                page_data[body_off + local_size],
                page_data[body_off + local_size + 1],
                page_data[body_off + local_size + 2],
                page_data[body_off + local_size + 3],
            ]);
            let mut remaining = payload_size - local_size;
            while ovfl != 0 && remaining > 0 {
                let Some(ovfl_data) = read_page_at(gz_path, page_size, ovfl) else {
                    break;
                };
                if ovfl_data.len() < 4 {
                    break;
                }
                let next = u32::from_be_bytes([
                    ovfl_data[0],
                    ovfl_data[1],
                    ovfl_data[2],
                    ovfl_data[3],
                ]);
                let chunk = remaining.min(usable_size - 4);
                let take = chunk.min(ovfl_data.len() - 4);
                payload.extend_from_slice(&ovfl_data[4..4 + take]);
                remaining -= take;
                ovfl = next;
            }
        }

        let Some(record) = decode_record(payload) else {
            continue;
        };
        let values = decode_record_values(&record, text_encoding);
        if values.len() < 5 {
            continue;
        }
        let type_val = match &values[0] {
            crate::sqlite::SerialValue::Text(s) => s.clone(),
            _ => continue,
        };
        let name_val = match &values[1] {
            crate::sqlite::SerialValue::Text(s) => s.clone(),
            _ => continue,
        };
        let rootpage_val = match values[3] {
            crate::sqlite::SerialValue::Int(i) => i as u32,
            _ => continue,
        };
        let sql_val = match &values[4] {
            crate::sqlite::SerialValue::Text(s) => s.clone(),
            _ => continue,
        };

        if type_val == "table" && !name_val.starts_with("sqlite_") {
            let columns = parse_create_table(&sql_val);
            tables.insert(
                name_val.clone(),
                TableDef {
                    rootpage: rootpage_val,
                    columns,
                    sql: sql_val,
                },
            );
        }
    }
}

fn parse_schema_interior(
    gz_path: &str,
    page_data: &[u8],
    bt_offset: usize,
    page_size: usize,
    usable_size: usize,
    text_encoding: u32,
    visited: &mut HashSet<u32>,
    tables: &mut HashMap<String, TableDef>,
) {
    if bt_offset + 12 > page_data.len() {
        return;
    }
    let cell_count =
        u16::from_be_bytes([page_data[bt_offset + 3], page_data[bt_offset + 4]]) as usize;
    let right_most = u32::from_be_bytes([
        page_data[bt_offset + 8],
        page_data[bt_offset + 9],
        page_data[bt_offset + 10],
        page_data[bt_offset + 11],
    ]);
    let ptr_array_start = bt_offset + 12;

    let mut children = Vec::new();
    for i in 0..cell_count {
        let ptr_off = ptr_array_start + i * 2;
        if ptr_off + 2 > page_data.len() {
            break;
        }
        let cell_ptr =
            u16::from_be_bytes([page_data[ptr_off], page_data[ptr_off + 1]]) as usize;
        if cell_ptr + 4 > page_data.len() {
            continue;
        }
        let child = u32::from_be_bytes([
            page_data[cell_ptr],
            page_data[cell_ptr + 1],
            page_data[cell_ptr + 2],
            page_data[cell_ptr + 3],
        ]);
        children.push(child);
    }
    children.push(right_most);

    for child in children {
        collect_schema_pages(
            gz_path,
            page_size,
            usable_size,
            text_encoding,
            child,
            visited,
            tables,
        );
    }
}

/// Decode all record values for schema rows.
pub fn decode_record_values(
    record: &crate::sqlite::DecodedCell,
    _text_encoding: u32,
) -> Vec<crate::sqlite::SerialValue> {
    let mut values = Vec::with_capacity(record.ncols);
    let mut body_off = record.header_length;
    for &st in &record.serial_types {
        let (val, next) = crate::sqlite::decode_serial_value(&record.payload, body_off, st);
        body_off = next;
        values.push(val);
    }
    values
}