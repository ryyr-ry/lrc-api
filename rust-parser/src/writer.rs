//! Room file writer: incremental per-room buffering with part-file
//! spill. Never holds more than ~32MB per room in memory.
//!
//! Final room file format (identical to the Python generator):
//! {
//!   "room_id": N,
//!   "dump_key": "...",
//!   "expected_count": C,
//!   "records": [ ... ]
//! }

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

const ROOM_BUFFER_LIMIT: usize = 32 * 1024 * 1024;
const GLOBAL_BUFFER_CAP: usize = 512 * 1024 * 1024;

pub struct RoomWriter {
    dir: String,
    dump_key: String,
    rooms: HashMap<u32, RoomState>,
    total_buffered: usize,
    pub file_count: usize,
    pub total_records: u64,
    pub total_json_bytes: u64,
}

struct RoomState {
    buffer: Vec<u8>,
    count: u64,
    part_idx: u32,
}

impl RoomWriter {
    pub fn new(dir: &str, dump_key: &str) -> Self {
        std::fs::create_dir_all(dir).expect("create room dir");
        RoomWriter {
            dir: dir.to_string(),
            dump_key: dump_key.to_string(),
            rooms: HashMap::new(),
            total_buffered: 0,
            file_count: 0,
            total_records: 0,
            total_json_bytes: 0,
        }
    }

    fn spill_largest(&mut self) {
        let mut largest_id = 0u32;
        let mut largest_len = 0usize;
        for (id, st) in self.rooms.iter() {
            if st.buffer.len() > largest_len {
                largest_len = st.buffer.len();
                largest_id = *id;
            }
        }
        if largest_len == 0 {
            return;
        }
        let dir = self.dir.clone();
        let st = self.rooms.get_mut(&largest_id).unwrap();
        let part_path = format!("{}/room-{:04}.part{:03}", dir, largest_id, st.part_idx);
        let mut f = BufWriter::new(File::create(&part_path).expect("create part file"));
        f.write_all(&st.buffer).expect("write part");
        f.flush().expect("flush part");
        self.total_buffered -= st.buffer.len();
        st.buffer.clear();
        st.buffer.shrink_to_fit();
        st.part_idx += 1;
    }

    pub fn write_record(&mut self, room_id: u32, json_bytes: &[u8]) {
        self.total_records += 1;
        self.total_json_bytes += json_bytes.len() as u64;

        let state = self.rooms.entry(room_id).or_insert_with(|| RoomState {
            buffer: Vec::with_capacity(1024 * 1024),
            count: 0,
            part_idx: 0,
        });

        if state.count > 0 {
            state.buffer.push(b',');
        }
        state.buffer.extend_from_slice(json_bytes);
        state.count += 1;
        self.total_buffered += json_bytes.len() + 1;

        if state.buffer.len() >= ROOM_BUFFER_LIMIT {
            let dir = self.dir.clone();
            let part_path = format!("{}/room-{:04}.part{:03}", dir, room_id, state.part_idx);
            let mut f = BufWriter::new(File::create(&part_path).expect("create part file"));
            f.write_all(&state.buffer).expect("write part");
            f.flush().expect("flush part");
            self.total_buffered -= state.buffer.len();
            state.buffer.clear();
            state.buffer.shrink_to_fit();
            state.part_idx += 1;
        } else if self.total_buffered > GLOBAL_BUFFER_CAP {
            self.spill_largest();
        }
    }

    /// Finalize all rooms: write header + parts + tail per room.
    pub fn finalize(&mut self) -> Vec<RoomFileInfo> {
        let mut infos = Vec::new();
        let room_ids: Vec<u32> = {
            let mut ids: Vec<u32> = self.rooms.keys().copied().collect();
            ids.sort_unstable();
            ids
        };

        for room_id in room_ids {
            let state = self.rooms.get_mut(&room_id).unwrap();
            let path = format!("{}/room-{:04}.json", self.dir, room_id);
            let mut f = BufWriter::new(File::create(&path).expect("create room file"));

            let header = format!(
                "{{\"room_id\":{},\"dump_key\":{},\"expected_count\":{},\"records\":[",
                room_id,
                json_string(&self.dump_key),
                state.count
            );
            f.write_all(header.as_bytes()).expect("write header");
            f.flush().expect("flush header");

            // If there are parts on disk, append them (the first part
            // starts directly; later parts continue after the final
            // comma already present in the previous part).
            for p in 0..state.part_idx {
                let part_path = format!("{}/room-{:04}.part{:03}", self.dir, room_id, p);
                let mut part = File::open(&part_path).expect("open part");
                std::io::copy(&mut part, &mut f).expect("copy part");
                drop(part);
                std::fs::remove_file(&part_path).ok();
            }
            if !state.buffer.is_empty() {
                f.write_all(&state.buffer).expect("write tail buffer");
            }
            f.write_all(b"]}").expect("write tail");
            f.flush().expect("flush room");

            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            infos.push(RoomFileInfo {
                name: format!("room-{:04}.json", room_id),
                size,
                record_count: state.count,
                room_id,
            });

            state.buffer.clear();
            state.count = 0;
            state.part_idx = 0;
        }
        self.file_count = infos.len();
        infos
    }
}

pub struct RoomFileInfo {
    pub name: String,
    pub size: u64,
    pub record_count: u64,
    pub room_id: u32,
}

pub fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Write index bins (track id -> room id) as raw little-endian uint16.
/// This is what the index room loads with Uint16Array.
pub fn write_index_bins(
    dir: &str,
    room_indices: &[u32],
    part_u16s: usize,
) -> Vec<IndexFileInfo> {
    let mut infos = Vec::new();
    let total = room_indices.len();
    let num_parts = (total + part_u16s - 1) / part_u16s;
    for part in 0..num_parts {
        let start = part * part_u16s;
        let end = (start + part_u16s).min(total);
        let path = format!("{}/index-{}.bin", dir, part);
        let mut f = BufWriter::new(File::create(&path).expect("create index file"));
        for &rid in &room_indices[start..end] {
            let v = rid.min(65535) as u16;
            f.write_all(&v.to_le_bytes()).expect("write index");
        }
        f.flush().expect("flush index");
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        infos.push(IndexFileInfo {
            name: format!("index-{}.bin", part),
            size,
        });
    }
    infos
}

pub struct IndexFileInfo {
    pub name: String,
    pub size: u64,
}

/// Write config.ts.
pub fn write_config_ts(
    path: &str,
    num_rooms: u32,
    rooms_per_release: u32,
    release_tags: &[String],
    num_supers: u32,
    num_subs: u32,
    num_aggregators: u32,
    chunks_per_agg: u32,
    subs_per_super: u32,
    num_index_parts: u32,
) {
    let mut f = BufWriter::new(File::create(path).expect("create config.ts"));
    writeln!(
        f,
        "// AUTO-GENERATED by scripts/generate_manifest.py. Do not edit manually."
    )
    .unwrap();
    writeln!(f, "export const TOTAL_ROOMS = {};", num_rooms).unwrap();
    writeln!(f, "export const ROOMS_PER_RELEASE = {};", rooms_per_release).unwrap();
    writeln!(
        f,
        "export const RELEASE_BASE_URL = \"https://github.com/ryyr-ry/lrc-api/releases/download\";"
    )
    .unwrap();
    writeln!(f, "export const RELEASE_TAGS = [").unwrap();
    for tag in release_tags {
        writeln!(f, "  \"{}\",", tag).unwrap();
    }
    writeln!(f, "];").unwrap();
    writeln!(f, "export const NUM_SUPERS = {};", num_supers).unwrap();
    writeln!(f, "export const NUM_SUBS = {};", num_subs).unwrap();
    writeln!(f, "export const NUM_AGGREGATORS = {};", num_aggregators).unwrap();
    writeln!(f, "export const CHUNKS_PER_AGG = {};", chunks_per_agg).unwrap();
    writeln!(f, "export const SUBS_PER_SUPER = {};", subs_per_super).unwrap();
    writeln!(f, "export const INDEX_FILES = {};", num_index_parts).unwrap();
    writeln!(f, "export const GENERATION_HOURS = 3;").unwrap();
    writeln!(f, "export const NUM_GENERATIONS = 8;").unwrap();
    writeln!(f, "export const WARM_NEXT_FRACTION = 0.833;").unwrap();
    writeln!(f, "export const LOAD_MAX_ATTEMPTS = 5;").unwrap();
    writeln!(f, "export const LOAD_RETRY_BASE_DELAY_MS = 2000;").unwrap();
    writeln!(f, "export const VERSION = \"0.2.0\";").unwrap();
    writeln!(
        f,
        "export const DB_LIST_URL = \"https://lrclib-db-dumps.bu3nnyut4y9jfkdg.workers.dev/\";"
    )
    .unwrap();
    writeln!(f, "export const WARM_CRON_NAME = \"warm\";").unwrap();
    f.flush().unwrap();
}