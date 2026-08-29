//! LRCLIB room file generator (Rust).
//!
//! Replaces scripts/generate_manifest.py with a much faster
//! implementation. Usage:
//!
//!   lrc-room-generator <db.gz> <manifest.json> <config.ts> <rooms-dir> <dump-key>
//!
//! Disk timeline (145 GB runner, ~127 GB free after cleanup):
//!   T0: gzip 46 GB on disk
//!   T1: scan: gzip 46 GB + lyrics zstd temp (grows to ~19 GB)
//!   T2: scan done: gzip DELETED, lyrics temp ~19 GB
//!   T3: join: lyrics temp 19 GB + room files (grow to ~88 GB) = 107 GB peak
//!   T4: lyrics temp deleted, room files ~88 GB
//!   T5: upload deletes each release group after upload
//!
//! Memory design (16 GB runner):
//!   - track metadata (name/artist/album): ~1.3 GB total
//!   - room indices, matched bitmap, linked lists: ~1 GB
//!   - lyrics never held in memory: streamed to a zstd temp file during
//!     the scan and read back sequentially during the join
//!   - per-room buffers spill to part files at 32 MB

mod partition;
mod schema;
mod sqlite;
mod writer;

use flate2::read::GzDecoder;
use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};

const KNOWN_TRACK_COUNT: u64 = 32_254_478;
const KNOWN_LYRICS_COUNT: u64 = 32_680_034;
const ROOM_TARGET_JSON_BYTES: u64 = 48 * 1024 * 1024;
const RING_PAGES: usize = 65_536; // 256 MB at 4 KiB pages
const INDEX_PART_U16S: usize = (16 * 1024 * 1024) / 2;
const LYRICS_TEMP: &str = "/tmp/lyrics_temp.zst";

#[derive(Debug)]
struct TrackMeta {
    name: String,
    artist: String,
    album: String,
    duration: f64,
    last_lid: Option<u64>,
}

#[derive(Debug)]
struct LyricsMeta {
    plain: Option<String>,
    synced: Option<String>,
    lyricsfile: Option<String>,
    instrumental: bool,
}

struct ColumnMap {
    name_idx: Option<usize>,
    artist_idx: Option<usize>,
    album_idx: Option<usize>,
    duration_idx: Option<usize>,
    last_lid_idx: Option<usize>,
}

struct LyricsColumnMap {
    plain_idx: Option<usize>,
    synced_idx: Option<usize>,
    lyricsfile_idx: Option<usize>,
    instrumental_idx: Option<usize>,
}

fn build_tracks_map(columns: &[String]) -> ColumnMap {
    let mut m = ColumnMap {
        name_idx: None,
        artist_idx: None,
        album_idx: None,
        duration_idx: None,
        last_lid_idx: None,
    };
    for (i, c) in columns.iter().enumerate() {
        match c.as_str() {
            "name" => m.name_idx = Some(i),
            "artist_name" => m.artist_idx = Some(i),
            "album_name" => m.album_idx = Some(i),
            "duration" => m.duration_idx = Some(i),
            "last_lyrics_id" => m.last_lid_idx = Some(i),
            _ => {}
        }
    }
    m
}

fn build_lyrics_map(columns: &[String]) -> LyricsColumnMap {
    let mut m = LyricsColumnMap {
        plain_idx: None,
        synced_idx: None,
        lyricsfile_idx: None,
        instrumental_idx: None,
    };
    for (i, c) in columns.iter().enumerate() {
        match c.as_str() {
            "plain_lyrics" => m.plain_idx = Some(i),
            "synced_lyrics" => m.synced_idx = Some(i),
            "lyricsfile" => m.lyricsfile_idx = Some(i),
            "instrumental" => m.instrumental_idx = Some(i),
            _ => {}
        }
    }
    m
}

fn decode_tracks(record: &sqlite::DecodedCell, map: &ColumnMap) -> TrackMeta {
    let mut name = String::new();
    let mut artist = String::new();
    let mut album = String::new();
    let mut duration = 0.0f64;
    let mut last_lid = None;

    let mut body_off = record.header_length;
    for (ci, &st) in record.serial_types.iter().enumerate() {
        let (val, next) = sqlite::decode_serial_value(&record.payload, body_off, st);
        body_off = next;
        if Some(ci) == map.name_idx {
            if let sqlite::SerialValue::Text(t) = val {
                name = t;
            }
        } else if Some(ci) == map.artist_idx {
            if let sqlite::SerialValue::Text(t) = val {
                artist = t;
            }
        } else if Some(ci) == map.album_idx {
            if let sqlite::SerialValue::Text(t) = val {
                album = t;
            }
        } else if Some(ci) == map.duration_idx {
            match val {
                sqlite::SerialValue::Float(f) => duration = f,
                sqlite::SerialValue::Int(i) => duration = i as f64,
                _ => {}
            }
        } else if Some(ci) == map.last_lid_idx {
            if let sqlite::SerialValue::Int(i) = val {
                last_lid = Some(i as u64);
            }
        }
    }

    TrackMeta {
        name,
        artist,
        album,
        duration,
        last_lid,
    }
}

fn decode_lyrics(record: &sqlite::DecodedCell, map: &LyricsColumnMap) -> LyricsMeta {
    let mut plain = None;
    let mut synced = None;
    let mut lyricsfile = None;
    let mut instrumental = false;

    let mut body_off = record.header_length;
    for (ci, &st) in record.serial_types.iter().enumerate() {
        let (val, next) = sqlite::decode_serial_value(&record.payload, body_off, st);
        body_off = next;
        if Some(ci) == map.plain_idx {
            if let sqlite::SerialValue::Text(t) = val {
                plain = Some(t);
            }
        } else if Some(ci) == map.synced_idx {
            if let sqlite::SerialValue::Text(t) = val {
                synced = Some(t);
            }
        } else if Some(ci) == map.lyricsfile_idx {
            if let sqlite::SerialValue::Text(t) = val {
                lyricsfile = Some(t);
            }
        } else if Some(ci) == map.instrumental_idx {
            instrumental = matches!(val, sqlite::SerialValue::Int(1));
        }
    }

    LyricsMeta {
        plain,
        synced,
        lyricsfile,
        instrumental,
    }
}

fn lyrics_to_bytes(ly: &LyricsMeta) -> Vec<u8> {
    // NUL-separated: plain \0 synced \0 lyricsfile \0 (matches Python)
    let mut out = Vec::new();
    if let Some(p) = &ly.plain {
        out.extend_from_slice(p.as_bytes());
    }
    out.push(0);
    if let Some(s) = &ly.synced {
        out.extend_from_slice(s.as_bytes());
    }
    out.push(0);
    if let Some(l) = &ly.lyricsfile {
        out.extend_from_slice(l.as_bytes());
    }
    out.push(0);
    out
}

fn build_record_json(tid: u64, meta: &TrackMeta, lyrics: Option<&LyricsMeta>) -> Vec<u8> {
    let norm_name = partition::prepare_input(&meta.name);
    let norm_artist = partition::prepare_input(&meta.artist);
    let norm_album = partition::prepare_input(&meta.album);

    let mut out = Vec::with_capacity(512);
    out.extend_from_slice(b"{\"id\":");
    out.extend_from_slice(tid.to_string().as_bytes());
    out.extend_from_slice(b",\"name\":");
    out.extend_from_slice(writer::json_string(&meta.name).as_bytes());
    out.extend_from_slice(b",\"trackName\":");
    out.extend_from_slice(writer::json_string(&meta.name).as_bytes());
    out.extend_from_slice(b",\"artistName\":");
    out.extend_from_slice(writer::json_string(&meta.artist).as_bytes());
    out.extend_from_slice(b",\"albumName\":");
    out.extend_from_slice(writer::json_string(&meta.album).as_bytes());
    out.extend_from_slice(b",\"duration\":");
    out.extend_from_slice(meta.duration.to_string().as_bytes());
    out.extend_from_slice(b",\"instrumental\":");
    if let Some(l) = lyrics {
        out.extend_from_slice(if l.instrumental { b"true" } else { b"false" });
    } else {
        out.extend_from_slice(b"false");
    }
    out.extend_from_slice(b",\"plainLyrics\":");
    match lyrics.and_then(|l| l.plain.as_ref()) {
        Some(s) => out.extend_from_slice(writer::json_string(s).as_bytes()),
        None => out.extend_from_slice(b"null"),
    }
    out.extend_from_slice(b",\"syncedLyrics\":");
    match lyrics.and_then(|l| l.synced.as_ref()) {
        Some(s) => out.extend_from_slice(writer::json_string(s).as_bytes()),
        None => out.extend_from_slice(b"null"),
    }
    out.extend_from_slice(b",\"lyricsfile\":");
    match lyrics.and_then(|l| l.lyricsfile.as_ref()) {
        Some(s) => out.extend_from_slice(writer::json_string(s).as_bytes()),
        None => out.extend_from_slice(b"null"),
    }
    out.extend_from_slice(b",\"nameLower\":");
    out.extend_from_slice(writer::json_string(&norm_name).as_bytes());
    out.extend_from_slice(b",\"artistNameLower\":");
    out.extend_from_slice(writer::json_string(&norm_artist).as_bytes());
    out.extend_from_slice(b",\"albumNameLower\":");
    out.extend_from_slice(writer::json_string(&norm_album).as_bytes());
    out.extend_from_slice(b"}");
    out
}

#[allow(clippy::too_many_arguments)]
fn process_assembled(
    payload: &[u8],
    rowid: u64,
    tracks_ncols: usize,
    lyrics_ncols: usize,
    tracks_map: &ColumnMap,
    lyrics_map: &LyricsColumnMap,
    max_tid: &mut usize,
    max_lid: &mut usize,
    track_names: &mut Vec<String>,
    track_artists: &mut Vec<String>,
    track_albums: &mut Vec<String>,
    track_durations: &mut Vec<f64>,
    room_indices: &mut Vec<u32>,
    next_track: &mut Vec<u32>,
    matched: &mut Vec<u8>,
    lyrics_first: &mut Vec<u32>,
    null_ids: &mut Vec<u32>,
    lyrics_offset: &mut Vec<u64>,
    lyrics_compressed_len: &mut Vec<u64>,
    lyrics_instrumental: &mut Vec<u8>,
    lyrics_temp_offset: &mut u64,
    num_rooms: u32,
    tc: &mut u64,
    lc: &mut u64,
) -> bool {
    let Some(mut cell) = sqlite::decode_record(payload.to_vec()) else {
        return false;
    };
    cell.rowid = rowid;
    if cell.ncols == tracks_ncols {
        let t = cell.rowid as usize;
        if t > *max_tid {
            let new_len = t + 1;
            track_names.resize(new_len, String::new());
            track_artists.resize(new_len, String::new());
            track_albums.resize(new_len, String::new());
            track_durations.resize(new_len, 0.0);
            room_indices.resize(new_len, 0);
            next_track.resize(new_len, 0);
            matched.resize(new_len, 0);
            *max_tid = t;
        }
        let meta = decode_tracks(&cell, tracks_map);
        track_names[t] = meta.name.clone();
        track_artists[t] = meta.artist.clone();
        track_albums[t] = meta.album.clone();
        track_durations[t] = meta.duration;
        room_indices[t] = partition::hash_partition(&meta.artist, &meta.name, num_rooms);
        if let Some(lid) = meta.last_lid {
            let l = lid as usize;
            if l > *max_lid {
                let new_len = l + 1;
                lyrics_first.resize(new_len, 0);
                lyrics_offset.resize(new_len, 0);
                lyrics_compressed_len.resize(new_len, 0);
                lyrics_instrumental.resize(new_len, 0);
                *max_lid = l;
            }
            next_track[t] = lyrics_first[l];
            lyrics_first[l] = t as u32;
        } else {
            null_ids.push(t as u32);
        }
        *tc += 1;
        true
    } else if cell.ncols == lyrics_ncols {
        let l = cell.rowid as usize;
        if l > *max_lid {
            let new_len = l + 1;
            lyrics_first.resize(new_len, 0);
            lyrics_offset.resize(new_len, 0);
            lyrics_compressed_len.resize(new_len, 0);
            lyrics_instrumental.resize(new_len, 0);
            *max_lid = l;
        }
        let meta = decode_lyrics(&cell, lyrics_map);
        lyrics_instrumental[l] = if meta.instrumental { 1 } else { 0 };
        let raw = lyrics_to_bytes(&meta);
        let compressed =
            zstd::stream::encode_all(raw.as_slice(), 3).expect("compress lyrics");
        lyrics_offset[l] = *lyrics_temp_offset;
        lyrics_compressed_len[l] = compressed.len() as u64;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(LYRICS_TEMP)
            .expect("append lyrics temp");
        f.write_all(&compressed).expect("append lyrics");
        *lyrics_temp_offset += compressed.len() as u64;
        *lc += 1;
        true
    } else {
        false
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 6 {
        eprintln!(
            "usage: {} <db.gz> <manifest.json> <config.ts> <rooms-dir> <dump-key>",
            args[0]
        );
        std::process::exit(1);
    }
    let gz_path = &args[1];
    let manifest_path = &args[2];
    let config_ts_path = &args[3];
    let chunk_dir = &args[4];
    let dump_key = &args[5];

    let t0 = std::time::Instant::now();

    // --- header ---
    let file = std::fs::File::open(gz_path).expect("open gzip");
    let mut gz = GzDecoder::new(BufReader::with_capacity(1 << 20, file));
    let mut header = [0u8; 100];
    gz.read_exact(&mut header).expect("read header");
    let (page_size, usable_size, page_count, text_encoding) =
        sqlite::parse_db_header(&header).expect("parse header");
    eprintln!(
        "DB: page_size={} usable={} pages={} encoding={}",
        page_size, usable_size, page_count, text_encoding
    );

    // --- schema ---
    let tables = schema::parse_schema(gz_path, page_size, usable_size, text_encoding);
    let tracks = tables.get("tracks").expect("tracks table");
    let lyrics_tbl = tables.get("lyrics").expect("lyrics table");
    let tracks_map = build_tracks_map(&tracks.columns);
    let lyrics_map = build_lyrics_map(&lyrics_tbl.columns);
    let tracks_ncols = tracks.columns.len();
    let lyrics_ncols = lyrics_tbl.columns.len();
    eprintln!(
        "tracks: {} cols (root {}), lyrics: {} cols (root {})",
        tracks_ncols, tracks.rootpage, lyrics_ncols, lyrics_tbl.rootpage
    );

    // --- sizing ---
    let db_size = page_size as u64 * page_count;
    let estimated_total_json = (db_size as f64 * 0.94) as u64;
    let mut num_rooms = std::cmp::max(1, (estimated_total_json / ROOM_TARGET_JSON_BYTES) as u32);
    num_rooms = ((num_rooms + 99) / 100) * 100;
    eprintln!("rooms: {}", num_rooms);

    let chunks_per_agg: u32 = 50;
    let num_aggregators = std::cmp::max(1, (num_rooms + chunks_per_agg - 1) / chunks_per_agg);
    let num_supers: u32 = 2;
    let subs_per_super: u32 = 4;
    let num_subs = std::cmp::max(1, (num_aggregators + subs_per_super - 1) / subs_per_super);
    let num_aggregators = num_subs * subs_per_super;

    let rooms_per_release: u32 = 900;
    let num_releases = (num_rooms + rooms_per_release - 1) / rooms_per_release;
    let release_tags: Vec<String> = (0..num_releases)
        .map(|i| format!("rooms-{}-r{}", chrono_date(), i))
        .collect();

    // --- scan structures ---
    let mut max_tid = KNOWN_TRACK_COUNT as usize;
    let mut max_lid = (KNOWN_LYRICS_COUNT + 100_000) as usize;

    let mut track_names: Vec<String> = vec![String::new(); max_tid + 1];
    let mut track_artists: Vec<String> = vec![String::new(); max_tid + 1];
    let mut track_albums: Vec<String> = vec![String::new(); max_tid + 1];
    let mut track_durations: Vec<f64> = vec![0.0; max_tid + 1];
    let mut room_indices: Vec<u32> = vec![0; max_tid + 1];
    let mut matched: Vec<u8> = vec![0; max_tid + 1];
    let mut next_track: Vec<u32> = vec![0; max_tid + 1];
    let mut lyrics_first: Vec<u32> = vec![0; max_lid + 1];
    let mut null_ids: Vec<u32> = Vec::new();
    let mut lyrics_offset: Vec<u64> = vec![0; max_lid + 1];
    let mut lyrics_compressed_len: Vec<u64> = vec![0; max_lid + 1];
    let mut lyrics_instrumental: Vec<u8> = vec![0; max_lid + 1];

    macro_rules! grow_tid {
        ($tid:expr) => {{
            let t = $tid as usize;
            if t > max_tid {
                let new_len = t + 1;
                track_names.resize(new_len, String::new());
                track_artists.resize(new_len, String::new());
                track_albums.resize(new_len, String::new());
                track_durations.resize(new_len, 0.0);
                room_indices.resize(new_len, 0);
                matched.resize(new_len, 0);
                next_track.resize(new_len, 0);
                max_tid = t;
            }
            t
        }};
    }

    macro_rules! grow_lid {
        ($lid:expr) => {{
            let l = $lid as usize;
            if l > max_lid {
                let new_len = l + 1;
                lyrics_first.resize(new_len, 0);
                lyrics_offset.resize(new_len, 0);
                lyrics_compressed_len.resize(new_len, 0);
                lyrics_instrumental.resize(new_len, 0);
                max_lid = l;
            }
            l
        }};
    }

    // lyrics zstd spill: each record is an independent zstd frame written
    // sequentially; lengths are recorded for the join phase read-back.
    let lyrics_temp_file =
        std::fs::File::create(LYRICS_TEMP).expect("create lyrics temp");
    let mut lyrics_writer = BufWriter::with_capacity(1 << 20, lyrics_temp_file);
    let mut lyrics_temp_offset: u64 = 0;

    let mut ring = sqlite::RingBuffer::new(RING_PAGES);
    let mut pending: Vec<sqlite::PendingOverflow> = Vec::new();
    // Overflow local payloads spill to disk; only metadata stays in
    // memory (Python's pending_overflows.bin equivalent).
    let pending_spill_path = "/tmp/pending_overflows.bin";
    let pending_spill_file =
        std::fs::File::create(pending_spill_path).expect("create pending spill");
    let mut pending_spill = BufWriter::with_capacity(1 << 20, pending_spill_file);

    // --- sequential scan ---
    eprintln!("scanning {} pages...", page_count);
    // Reopen the gzip and keep the 100-byte DB header as the prefix of
    // page 1. The scan must not skip the header separately, or every
    // subsequent page boundary shifts by 100 bytes.
    let mut gz = GzDecoder::new(BufReader::with_capacity(
        1 << 20,
        std::fs::File::open(gz_path).expect("reopen gzip"),
    ));
    let mut header_prefix = [0u8; 100];
    gz.read_exact(&mut header_prefix).expect("skip header");

    let mut tc: u64 = 0;
    let mut lc: u64 = 0;
    let mut overflow_pending_count: u64 = 0;

    let mut page_buffer: Vec<u8> = Vec::with_capacity(page_size);
    let mut page_num: u32 = 1;
    let mut first_page = true;
    while page_num as u64 <= page_count {
        if first_page {
            // Page 1: prepend the header we already consumed.
            page_buffer.resize(page_size, 0);
            page_buffer[..100].copy_from_slice(&header_prefix);
            match gz.read_exact(&mut page_buffer[100..]) {
                Ok(_) => {}
                Err(_) => break,
            }
            first_page = false;
        } else {
            page_buffer.resize(page_size, 0);
            match gz.read_exact(&mut page_buffer) {
                Ok(_) => {}
                Err(_) => break,
            }
        }

        ring.put(page_num, page_buffer.clone());

        let bt_offset = if page_num == 1 { 100 } else { 0 };
        if page_buffer.len() <= bt_offset {
            page_num += 1;
            continue;
        }
        let page_type = page_buffer[bt_offset];

        if page_type == sqlite::PAGE_TABLE_LEAF {
            let (cells, mut unresolved) =
                sqlite::parse_leaf_table_cells(&page_buffer, bt_offset, usable_size, &ring);
            for cell in cells {
                if cell.ncols == tracks_ncols {
                    let tid = cell.rowid;
                    let tidx = grow_tid!(tid);
                    let meta = decode_tracks(&cell, &tracks_map);
                    track_names[tidx] = meta.name.clone();
                    track_artists[tidx] = meta.artist.clone();
                    track_albums[tidx] = meta.album.clone();
                    track_durations[tidx] = meta.duration;
                    let ridx = partition::hash_partition(&meta.artist, &meta.name, num_rooms);
                    room_indices[tidx] = ridx;

                    if let Some(lid) = meta.last_lid {
                        let lidx = grow_lid!(lid);
                        next_track[tidx] = lyrics_first[lidx];
                        lyrics_first[lidx] = tid as u32;
                    } else {
                        null_ids.push(tid as u32);
                    }
                    tc += 1;
                } else if cell.ncols == lyrics_ncols {
                    let lid = cell.rowid;
                    let lidx = grow_lid!(lid);
                    let meta = decode_lyrics(&cell, &lyrics_map);
                    lyrics_instrumental[lidx] = if meta.instrumental { 1 } else { 0 };
                    let raw = lyrics_to_bytes(&meta);
                    let compressed = zstd::stream::encode_all(raw.as_slice(), 3)
                        .expect("compress lyrics");
                    lyrics_offset[lidx] = lyrics_temp_offset;
                    lyrics_compressed_len[lidx] = compressed.len() as u64;
                    lyrics_writer
                        .write_all(&compressed)
                        .expect("write lyrics temp");
                    lyrics_temp_offset += compressed.len() as u64;
                    lc += 1;
                }
            }
            let new_pending_start = pending.len();
            pending.append(&mut unresolved);
            // Spill local payloads of new pending entries to disk and
            // drop them from memory.
            for p in pending.iter_mut().skip(new_pending_start) {
                let off = pending_spill.stream_position().expect("spill pos");
                p.spill_offset = off;
                pending_spill.write_all(&p.local_payload).expect("spill payload");
                p.local_payload.clear();
                p.local_payload.shrink_to_fit();
            }
            overflow_pending_count = pending.len() as u64;
        }

        page_num += 1;
        if page_num % 5_000_000 == 0 {
            eprintln!(
                "  pages {}/{} ({}s) tracks={} lyrics={} pending={}",
                page_num,
                page_count,
                t0.elapsed().as_secs(),
                tc,
                lc,
                overflow_pending_count
            );
        }
    }

    eprintln!(
        "scan done: tracks={} lyrics={} pending_overflows={} ({:.1}s)",
        tc,
        lc,
        pending.len(),
        t0.elapsed().as_secs()
    );

    lyrics_writer.flush().expect("flush lyrics temp");
    drop(lyrics_writer);
    eprintln!("lyrics temp: {} bytes", lyrics_temp_offset);

    // --- Pass 2: resolve pending overflows with one sequential sweep ---
    // Chains are assembled via a waiting map: when a chain's page
    // arrives in the sweep, its data is kept until the chain resolves.
    // Chains whose pages were already swept are resolved from the ring
    // buffer when possible, else reported unresolved.
    if !pending.is_empty() {
        eprintln!("pass 2: resolving {} pending overflows", pending.len());
        pending.sort_by_key(|p| p.ovfl_page);

        // chain state: (spill_offset, total_size, local_len, next_page, resolved)
        struct ChainState {
            spill_offset: u64,
            total_size: usize,
            local_len: usize,
            next_page: u32,
            rowid: u64,
            resolved: bool,
        }
        let mut chains: Vec<ChainState> = pending
            .iter()
            .map(|p| ChainState {
                spill_offset: p.spill_offset,
                total_size: p.total_payload_size,
                local_len: p.local_payload.len(),
                next_page: p.ovfl_page,
                rowid: p.rowid,
                resolved: false,
            })
            .collect();

        // waiting: page -> chain indices that need this page's data
        let mut waiting: HashMap<u32, Vec<usize>> = HashMap::new();
        for (i, c) in chains.iter().enumerate() {
            if c.next_page != 0 && c.local_len < c.total_size {
                waiting.entry(c.next_page).or_default().push(i);
            }
        }

        let spill_reader_file =
            std::fs::File::open(pending_spill_path).expect("open pending spill");
        let mut spill_reader = BufReader::with_capacity(1 << 20, spill_reader_file);

        // assembled payload buffer per chain (only while being resolved)
        let mut assembled: Vec<Option<Vec<u8>>> = vec![None; chains.len()];

        let mut gz2 = GzDecoder::new(BufReader::with_capacity(
            1 << 20,
            std::fs::File::open(gz_path).expect("reopen gzip for pass 2"),
        ));
        let mut header_prefix2 = [0u8; 100];
        gz2.read_exact(&mut header_prefix2).ok();
        let mut resolved = 0usize;
        let mut page = vec![0u8; page_size];
        for pn in 1..=page_count as u32 {
            if pn == 1 {
                page[..100].copy_from_slice(&header_prefix2);
                match gz2.read_exact(&mut page[100..]) {
                    Ok(_) => {}
                    Err(_) => break,
                }
            } else {
                match gz2.read_exact(&mut page) {
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            ring.put(pn, page.clone());

            if let Some(idxs) = waiting.remove(&pn) {
                for &i in &idxs {
                    if chains[i].resolved {
                        continue;
                    }
                    // Ensure the local payload is loaded into assembled.
                    if assembled[i].is_none() {
                        let mut local = vec![0u8; chains[i].local_len];
                        spill_reader
                            .seek(SeekFrom::Start(chains[i].spill_offset))
                            .ok();
                        spill_reader.read_exact(&mut local).ok();
                        assembled[i] = Some(local);
                    }
                    let mut buf = assembled[i].take().unwrap();
                    let mut remaining = chains[i].total_size - buf.len();
                    let mut current = chains[i].next_page;
                    let mut chain_ok = true;
                    let mut sweep = 0usize;
                    while current != 0 && remaining > 0 && sweep < 8 {
                        let data = match ring.get(current) {
                            Some(d) => d,
                            None => {
                                // Not in ring: if this page is still
                                // ahead, keep waiting.
                                chain_ok = false;
                                break;
                            }
                        };
                        let next = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                        let chunk = remaining.min(usable_size - 4);
                        let take = chunk.min(data.len() - 4);
                        buf.extend_from_slice(&data[4..4 + take]);
                        remaining -= take;
                        current = next;
                        sweep += 1;
                    }
                    if chain_ok && remaining == 0 {
                        // Fully assembled. Process the record.
                        if process_assembled(
                            &buf,
                            chains[i].rowid,
                            tracks_ncols,
                            lyrics_ncols,
                            &tracks_map,
                            &lyrics_map,
                            &mut max_tid,
                            &mut max_lid,
                            &mut track_names,
                            &mut track_artists,
                            &mut track_albums,
                            &mut track_durations,
                            &mut room_indices,
                            &mut next_track,
                            &mut matched,
                            &mut lyrics_first,
                            &mut null_ids,
                            &mut lyrics_offset,
                            &mut lyrics_compressed_len,
                            &mut lyrics_instrumental,
                            &mut lyrics_temp_offset,
                            num_rooms,
                            &mut tc,
                            &mut lc,
                        ) {
                            chains[i].resolved = true;
                            resolved += 1;
                        }
                        assembled[i] = None;
                    } else {
                        // Keep the buffer and wait for the next page.
                        assembled[i] = Some(buf);
                        // remaining pages are still ahead; re-register on
                        // the NEXT page of the chain if we know it.
                        if !chain_ok {
                            // We broke because current page not in ring;
                            // re-add this chain to waiting for that page.
                            waiting.entry(current).or_default().push(i);
                        } else {
                            // chain exhausted pages but remaining > 0:
                            // chain broken; mark unresolved forever.
                            assembled[i] = None;
                        }
                    }
                }
            }
        }
        eprintln!(
            "pass 2 done: resolved {}/{} ({:.1}s)",
            resolved,
            pending.len(),
            t0.elapsed().as_secs()
        );
    }

    // Delete the gzip NOW to reclaim 46 GB before the join phase.
    std::fs::remove_file(gz_path).ok();
    std::fs::remove_file(pending_spill_path).ok();
    eprintln!("gzip and pending spill deleted");

    // --- join and write rooms ---
    eprintln!("writing rooms...");
    let mut room_writer = writer::RoomWriter::new(chunk_dir, dump_key);

    // Null-lyrics tracks first.
    for &tid in &null_ids {
        let tid = tid as usize;
        let meta = TrackMeta {
            name: track_names[tid].clone(),
            artist: track_artists[tid].clone(),
            album: track_albums[tid].clone(),
            duration: track_durations[tid],
            last_lid: None,
        };
        let json = build_record_json(tid as u64, &meta, None);
        let ridx = room_indices[tid];
        room_writer.write_record(ridx, &json);
        matched[tid] = 1;
    }
    eprintln!("null-lyrics written: {}", null_ids.len());

    // Lyrics join: sequential read-back of the zstd temp file.
    let lyrics_temp_reader = std::fs::File::open(LYRICS_TEMP).expect("open lyrics temp");
    let mut lyrics_reader = BufReader::with_capacity(1 << 20, lyrics_temp_reader);
    let mut mc: u64 = 0;
    for lid in 1..max_lid {
        if lyrics_compressed_len[lid] == 0 {
            continue;
        }
        let off = lyrics_offset[lid];
        let clen = lyrics_compressed_len[lid] as usize;
        lyrics_reader.seek(SeekFrom::Start(off)).ok();
        let mut compressed = vec![0u8; clen];
        lyrics_reader.read_exact(&mut compressed).ok();
        let raw = zstd::stream::decode_all(compressed.as_slice()).expect("decompress lyrics");
        let ly = parse_lyrics_bytes(&raw);
        let instrumental = lyrics_instrumental[lid] == 1;

        let mut tid = lyrics_first[lid];
        while tid != 0 {
            let t = tid as usize;
            if t <= max_tid && !track_names[t].is_empty() && matched[t] == 0 {
                let meta = TrackMeta {
                    name: track_names[t].clone(),
                    artist: track_artists[t].clone(),
                    album: track_albums[t].clone(),
                    duration: track_durations[t],
                    last_lid: Some(lid as u64),
                };
                let json = build_record_json(t as u64, &meta, Some(&LyricsMeta {
                    plain: ly.0.clone(),
                    synced: ly.1.clone(),
                    lyricsfile: ly.2.clone(),
                    instrumental,
                }));
                let ridx = room_indices[t];
                room_writer.write_record(ridx, &json);
                matched[t] = 1;
                mc += 1;
            }
            tid = next_track[t];
        }
    }

    // Unmatched tracks.
    let mut uc: u64 = 0;
    for t in 1..=max_tid {
        if !track_names[t].is_empty() && matched[t] == 0 {
            let meta = TrackMeta {
                name: track_names[t].clone(),
                artist: track_artists[t].clone(),
                album: track_albums[t].clone(),
                duration: track_durations[t],
                last_lid: None,
            };
            let json = build_record_json(t as u64, &meta, None);
            let ridx = room_indices[t];
            room_writer.write_record(ridx, &json);
            uc += 1;
        }
    }
    eprintln!(
        "join done: matched={} unmatched={} total={} ({:.1}s)",
        mc,
        uc,
        room_writer.total_records,
        t0.elapsed().as_secs()
    );

    // Delete the lyrics temp file after the join.
    std::fs::remove_file(LYRICS_TEMP).ok();

    let room_infos = room_writer.finalize();
    eprintln!("rooms written: {}", room_infos.len());

    // --- index bins ---
    let room_indices_slice: Vec<u32> = room_indices[..=max_tid].to_vec();
    let index_infos = writer::write_index_bins(chunk_dir, &room_indices_slice, INDEX_PART_U16S);

    // --- manifest ---
    let num_index_parts = index_infos.len() as u32;
    let manifest: HashMap<String, serde_json::Value> = {
        let mut m = HashMap::new();
        m.insert(
            "dump_key".to_string(),
            serde_json::Value::String(dump_key.to_string()),
        );
        m.insert(
            "generated_at".to_string(),
            serde_json::Value::String(chrono_now()),
        );
        m.insert(
            "total_records".to_string(),
            serde_json::Value::Number(room_writer.total_records.into()),
        );
        m.insert(
            "total_json_bytes".to_string(),
            serde_json::Value::Number(room_writer.total_json_bytes.into()),
        );
        m.insert(
            "total_files".to_string(),
            serde_json::Value::Number(((room_infos.len() + index_infos.len()) as u64).into()),
        );
        m.insert(
            "total_rooms".to_string(),
            serde_json::Value::Number(num_rooms.into()),
        );
        m.insert(
            "rooms_per_release".to_string(),
            serde_json::Value::Number(rooms_per_release.into()),
        );
        m.insert(
            "num_releases".to_string(),
            serde_json::Value::Number(num_releases.into()),
        );
        m.insert(
            "release_tags".to_string(),
            serde_json::Value::Array(
                release_tags
                    .iter()
                    .map(|t| serde_json::Value::String(t.clone()))
                    .collect(),
            ),
        );
        m.insert(
            "num_index_parts".to_string(),
            serde_json::Value::Number(num_index_parts.into()),
        );
        m.insert(
            "num_supers".to_string(),
            serde_json::Value::Number(num_supers.into()),
        );
        m.insert(
            "num_aggregators".to_string(),
            serde_json::Value::Number(num_aggregators.into()),
        );
        m.insert(
            "chunks_per_agg".to_string(),
            serde_json::Value::Number(chunks_per_agg.into()),
        );
        m.insert(
            "files".to_string(),
            serde_json::Value::Array(
                room_infos
                    .iter()
                    .map(|i| {
                        serde_json::json!({
                            "name": i.name,
                            "size": i.size,
                            "record_count": i.record_count,
                        })
                    })
                    .chain(index_infos.iter().map(|i| {
                        serde_json::json!({
                            "name": i.name,
                            "size": i.size,
                        })
                    }))
                    .collect(),
            ),
        );
        m
    };
    let manifest_json = serde_json::to_vec_pretty(&manifest).expect("serialize manifest");
    std::fs::write(manifest_path, manifest_json).expect("write manifest");

    writer::write_config_ts(
        config_ts_path,
        num_rooms,
        rooms_per_release,
        &release_tags,
        num_supers,
        num_subs,
        num_aggregators,
        chunks_per_agg,
        subs_per_super,
        num_index_parts,
    );

    eprintln!("total time: {:.1}s", t0.elapsed().as_secs());
}

/// Parse the NUL-separated lyrics spill format.
fn parse_lyrics_bytes(raw: &[u8]) -> (Option<String>, Option<String>, Option<String>) {
    let parts: Vec<&[u8]> = raw.split(|&b| b == 0).collect();
    let plain = if parts.is_empty() || parts[0].is_empty() {
        None
    } else {
        Some(String::from_utf8_lossy(parts[0]).into_owned())
    };
    let synced = if parts.len() > 1 && !parts[1].is_empty() {
        Some(String::from_utf8_lossy(parts[1]).into_owned())
    } else {
        None
    };
    let lfile = if parts.len() > 2 && !parts[2].is_empty() {
        Some(String::from_utf8_lossy(parts[2]).into_owned())
    } else {
        None
    };
    (plain, synced, lfile)
}

fn chrono_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let days = secs / 86400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{:04}{:02}{:02}", y, m, d)
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let days = secs / 86400;
    let rem = secs % 86400;
    let (y, mo, d) = civil_from_days(days as i64);
    let h = rem / 3600;
    let mi = (rem % 3600) / 60;
    let s = rem % 60;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as i64;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as i64;
    (if m <= 2 { y + 1 } else { y }, m, d)
}