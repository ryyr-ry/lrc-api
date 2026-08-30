//! Room file writer: per-room records stream to gzip-compressed
//! `.recs` files during the join (each spill is an independent gzip
//! member). finalize() concatenates gzip(header) + recs members +
//! gzip(tail) into `.json.gz`; gzip members concatenate into a valid
//! single stream, so rooms can decompress the file in one pass.
//!
//! Final room file format (identical to the Python generator, gzipped):
//! {
//!   "room_id": N,
//!   "dump_key": "...",
//!   "expected_count": C,
//!   "records": [ ... ]
//! }

use flate2::write::GzEncoder;
use flate2::Compression;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Write};

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
    recs_open: bool,
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

    fn flush_room_buffer(&mut self, room_id: u32) {
        let dir = self.dir.clone();
        let state = self.rooms.get_mut(&room_id).unwrap();
        if state.buffer.is_empty() {
            return;
        }
        let path = format!("{}/room-{:04}.recs", dir, room_id);
        // Append one independent gzip member per spill.
        let out_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .expect("append recs file");
        let mut enc = GzEncoder::new(out_file, Compression::default());
        enc.write_all(&state.buffer).expect("write recs member");
        enc.finish().expect("finish recs member");
        self.total_buffered -= state.buffer.len();
        state.buffer.clear();
        state.buffer.shrink_to_fit();
        state.recs_open = true;
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
        self.flush_room_buffer(largest_id);
    }

    pub fn write_record(&mut self, room_id: u32, json_bytes: &[u8]) {
        self.total_records += 1;
        self.total_json_bytes += json_bytes.len() as u64;

        let state = self.rooms.entry(room_id).or_insert_with(|| RoomState {
            buffer: Vec::with_capacity(1024 * 1024),
            count: 0,
            recs_open: false,
        });

        if state.count > 0 {
            state.buffer.push(b',');
        }
        state.buffer.extend_from_slice(json_bytes);
        state.count += 1;
        self.total_buffered += json_bytes.len() + 1;

        if state.buffer.len() >= ROOM_BUFFER_LIMIT {
            self.flush_room_buffer(room_id);
        } else if self.total_buffered > GLOBAL_BUFFER_CAP {
            self.spill_largest();
        }
    }

    /// Finalize all rooms into `.json.gz`: gzip(header) + recs members
    /// + gzip(tail), then delete each `.recs`.
    pub fn finalize(&mut self) -> Vec<RoomFileInfo> {
        let mut infos = Vec::new();
        let room_ids: Vec<u32> = {
            let mut ids: Vec<u32> = self.rooms.keys().copied().collect();
            ids.sort_unstable();
            ids
        };

        for room_id in room_ids {
            let state = self.rooms.get_mut(&room_id).unwrap();
            if state.count == 0 {
                continue;
            }
            self.flush_room_buffer(room_id);
            let state = self.rooms.get_mut(&room_id).unwrap();

            let recs_path = format!("{}/room-{:04}.recs", self.dir, room_id);
            let json_path = format!("{}/room-{:04}.json.gz", self.dir, room_id);

            {
                let out_file = File::create(&json_path).expect("create room json.gz");

                // gzip member 1: header. GzEncoder::finish() returns
                // the underlying file, keeping one handle open for the
                // whole concatenation.
                let mut enc = GzEncoder::new(out_file, Compression::default());
                let header = format!(
                    "{{\"room_id\":{},\"dump_key\":{},\"expected_count\":{},\"records\":[",
                    room_id,
                    json_string(&self.dump_key),
                    state.count
                );
                enc.write_all(header.as_bytes()).expect("write header");
                let mut out = enc.finish().expect("finish header member");

                // recs members are already valid gzip members; copy raw.
                let mut recs = File::open(&recs_path).expect("open recs");
                let mut chunk = vec![0u8; 4 << 20];
                loop {
                    let n = recs.read(&mut chunk).expect("read recs");
                    if n == 0 {
                        break;
                    }
                    out.write_all(&chunk[..n]).expect("copy recs");
                }
                drop(recs);

                // gzip member 3: tail on the same file handle.
                let mut enc_tail = GzEncoder::new(out, Compression::default());
                enc_tail.write_all(b"]}").expect("write tail");
                enc_tail.finish().expect("finish tail member");
            }
            std::fs::remove_file(&recs_path).ok();

            let size = std::fs::metadata(&json_path).map(|m| m.len()).unwrap_or(0);
            infos.push(RoomFileInfo {
                name: format!("room-{:04}.json.gz", room_id),
                size,
                record_count: state.count,
                room_id,
            });

            state.buffer.clear();
            state.count = 0;
            state.recs_open = false;
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