//! A minimal leveldb reader (src/ccd-leveldb.ts): enough to recover a
//! Chromium Local Storage value after the write-ahead log has compacted into
//! Snappy-compressed `.ldb` tables. The database is never opened. Two readers:
//! `LeveldbScan` hands back every `.log` whole and every decompressed data
//! block of every `.ldb`, newest file name first, for a caller's substring
//! scan; `LeveldbKeyReader` collects the records of chosen keys with their
//! sequence numbers, so the newest write of a key wins whatever file it is in.
//! Anything unexpected yields nothing, as the client's does.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::fsutil::stat_safe;

/// The raw Snappy block format (not the framed stream). `Err` on any
/// malformed input, where the client throws.
pub fn snappy_decompress(input: &[u8]) -> Result<Vec<u8>, ()> {
    let mut pos = 0usize;
    let mut len: u64 = 0;
    let mut shift = 0u32;
    loop {
        if pos >= input.len() {
            break;
        }
        let b = input[pos];
        pos += 1;
        len |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift > 35 {
            return Err(());
        }
    }
    let len = len as usize;
    let mut out: Vec<u8> = Vec::with_capacity(len);
    while pos < input.len() {
        let tag = input[pos];
        pos += 1;
        let kind = tag & 0x03;
        if kind == 0 {
            let mut lit_len = (tag >> 2) as usize;
            if lit_len < 60 {
                lit_len += 1;
            } else {
                let extra = lit_len - 59;
                let mut v: u64 = 0;
                for i in 0..extra {
                    let b = *input.get(pos).ok_or(())? as u64;
                    pos += 1;
                    v |= b << (8 * i);
                }
                lit_len = (v as u32) as usize + 1;
            }
            let end = pos + lit_len;
            if end > input.len() {
                // `input.copy(out, outPos, pos, pos + litLen)` copies what is there.
                out.extend_from_slice(&input[pos..]);
                pos = input.len();
            } else {
                out.extend_from_slice(&input[pos..end]);
                pos = end;
            }
        } else {
            let copy_len: usize;
            let offset: usize;
            if kind == 1 {
                copy_len = (((tag >> 2) & 0x07) as usize) + 4;
                let lo = *input.get(pos).ok_or(())? as usize;
                pos += 1;
                offset = (((tag >> 5) as usize) << 8) | lo;
            } else if kind == 2 {
                copy_len = ((tag >> 2) as usize) + 1;
                let a = *input.get(pos).ok_or(())? as usize;
                let b = *input.get(pos + 1).ok_or(())? as usize;
                pos += 2;
                offset = a | (b << 8);
            } else {
                copy_len = ((tag >> 2) as usize) + 1;
                let a = *input.get(pos).ok_or(())? as u32;
                let b = *input.get(pos + 1).ok_or(())? as u32;
                let c = *input.get(pos + 2).ok_or(())? as u32;
                let d = *input.get(pos + 3).ok_or(())? as u32;
                pos += 4;
                offset = (a | (b << 8) | (c << 16) | (d << 24)) as usize;
            }
            if offset > out.len() || offset == 0 {
                return Err(());
            }
            let mut from = out.len() - offset;
            for _ in 0..copy_len {
                let b = out[from];
                out.push(b);
                from += 1;
            }
        }
    }
    Ok(out)
}

const SST_MAGIC_LO: u32 = 0x8b80fb57;
const SST_MAGIC_HI: u32 = 0xdb477524;

fn read_u32_le(buf: &[u8], at: usize) -> Option<u32> {
    if at + 4 > buf.len() {
        return None;
    }
    Some(u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]))
}

fn read_varint(buf: &[u8], mut pos: usize) -> Result<(u64, usize), ()> {
    let mut v: u64 = 0;
    let mut shift = 0u32;
    while pos < buf.len() {
        let b = buf[pos];
        pos += 1;
        v |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Ok((v & 0xffff_ffff, pos));
        }
        shift += 7;
        if shift > 35 {
            break;
        }
    }
    Err(())
}

fn read_block(file: &[u8], offset: usize, size: usize) -> Result<Vec<u8>, ()> {
    if offset + size > file.len() {
        return Err(());
    }
    let raw = &file[offset..offset + size];
    let compression = file.get(offset + size).copied();
    if compression == Some(1) {
        return snappy_decompress(raw);
    }
    Ok(raw.to_vec())
}

/// The decompressed data blocks of an SSTable, or nothing when it cannot be parsed.
fn ldb_data_blocks(file: &[u8]) -> Vec<Vec<u8>> {
    match ldb_data_blocks_inner(file) {
        Ok(b) => b,
        Err(()) => Vec::new(),
    }
}

fn ldb_data_blocks_inner(file: &[u8]) -> Result<Vec<Vec<u8>>, ()> {
    if file.len() < 48 {
        return Ok(Vec::new());
    }
    let footer = &file[file.len() - 48..];
    if read_u32_le(footer, 40) != Some(SST_MAGIC_LO) || read_u32_le(footer, 44) != Some(SST_MAGIC_HI) {
        return Ok(Vec::new());
    }
    let (_, p) = read_varint(footer, 0)?;
    let (_, p) = read_varint(footer, p)?;
    let (off, p) = read_varint(footer, p)?;
    let (size, _) = read_varint(footer, p)?;
    let index_block = read_block(file, off as usize, size as usize)?;
    if index_block.len() < 4 {
        return Err(());
    }
    let num_restarts = read_u32_le(&index_block, index_block.len() - 4).ok_or(())? as usize;
    let entries_end = index_block.len().checked_sub(4 + num_restarts * 4).ok_or(())?;
    let mut blocks: Vec<Vec<u8>> = Vec::new();
    let mut q = 0usize;
    while q < entries_end {
        let (_, q1) = read_varint(&index_block, q)?;
        let (non_shared, q2) = read_varint(&index_block, q1)?;
        let (value_len, q3) = read_varint(&index_block, q2)?;
        let v_start = q3 + non_shared as usize;
        q = v_start + value_len as usize;
        let (d_off, hp) = read_varint(&index_block, v_start)?;
        let (d_size, _) = read_varint(&index_block, hp)?;
        if let Ok(b) = read_block(file, d_off as usize, d_size as usize) {
            blocks.push(b);
        }
    }
    Ok(blocks)
}

/// Every scannable buffer of a Local Storage leveldb directory, newest file
/// first: a `.log` whole, an `.ldb` as its decompressed data blocks. The
/// buffers are produced lazily, one file at a time, so a scan that finds what
/// it needs in the newest file reads nothing else.
pub struct LeveldbScan {
    dir: String,
    files: Vec<String>,
    next_file: usize,
    pending: std::collections::VecDeque<Vec<u8>>,
}

impl LeveldbScan {
    pub fn new(dir: &str) -> LeveldbScan {
        let mut files: Vec<String> = match fs::read_dir(dir) {
            Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|f| f.ends_with(".log") || f.ends_with(".ldb")).collect(),
            Err(_) => Vec::new(),
        };
        // `.sort().reverse()`: by UTF-16 code units, newest name first.
        files.sort_by(|a, b| {
            let ka: Vec<u16> = a.encode_utf16().collect();
            let kb: Vec<u16> = b.encode_utf16().collect();
            kb.cmp(&ka)
        });
        LeveldbScan { dir: dir.to_string(), files, next_file: 0, pending: std::collections::VecDeque::new() }
    }
}

impl Iterator for LeveldbScan {
    type Item = Vec<u8>;

    fn next(&mut self) -> Option<Vec<u8>> {
        loop {
            if let Some(b) = self.pending.pop_front() {
                return Some(b);
            }
            if self.next_file >= self.files.len() {
                return None;
            }
            let f = self.files[self.next_file].clone();
            self.next_file += 1;
            let buf = match fs::read(Path::new(&self.dir).join(&f)) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if f.ends_with(".log") {
                return Some(buf);
            }
            for b in ldb_data_blocks(&buf) {
                self.pending.push_back(b);
            }
        }
    }
}

// ── Records: the newest write of a key (readLeveldbKeys) ────────────────────
//
// Claude Desktop rewrites its whole sidebar state on every change, so one key
// has many records, in the write-ahead log and in the tables compacted from
// older logs. leveldb tells them apart by sequence number, never by file: the
// live `.log` has a lower number than the table flushed from the log before
// it, and within a `.log` the first match of a key is its oldest write. So
// every record of the wanted keys is collected with its sequence number and
// the highest wins; a deletion that wins means the key is gone. A log record
// is reassembled from its fragments, and its checksums are verified when it
// holds a wanted key. A table never changes once written, so its records are
// cached by name, size and mtime, and it is read one block at a time.

const LOG_BLOCK: usize = 32_768;
const LOG_HEADER: usize = 7;
// Fragment types: a whole record, or its first, middle (3) and last pieces.
const LOG_FULL: u8 = 1;
const LOG_FIRST: u8 = 2;
const LOG_LAST: u8 = 4;
const TYPE_DELETION: u8 = 0;
const TYPE_VALUE: u8 = 1;

/// One record of a key the caller asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct LeveldbRecord {
    /// The user key's bytes.
    pub key: Vec<u8>,
    /// leveldb's sequence number: the higher, the newer.
    pub seq: u64,
    /// A value (true) or a deletion (false).
    pub live: bool,
    /// The file's name in the leveldb directory.
    pub file: String,
    /// A table's data block offset, or the offset of a log record's first fragment.
    pub block: u64,
    /// A table's data block size; None for a log record.
    pub block_size: Option<u64>,
    /// The value's start and length inside the decoded block or record.
    pub at: usize,
    pub len: usize,
}

const CRC32C_TABLE: [u32; 256] = {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0x82f6_3b78 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
};

/// leveldb's masked CRC32C of a log fragment: its type byte, then its data.
fn log_fragment_crc(kind: u8, data: &[u8]) -> u32 {
    let mut c: u32 = !0;
    c = CRC32C_TABLE[((c ^ kind as u32) & 0xff) as usize] ^ (c >> 8);
    for &b in data {
        c = CRC32C_TABLE[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    let crc = !c;
    ((crc >> 15) | (crc << 17)).wrapping_add(0xa282_ead8)
}

struct LogFragment {
    pos: usize,
    crc: u32,
    kind: u8,
    start: usize,
    end: usize,
}

struct LogRecord<'a> {
    start: usize,
    data: Cow<'a, [u8]>,
    frags: Vec<LogFragment>,
}

/// The complete logical records of a write-ahead log from `pos` (a fragment
/// boundary), each with its fragments. A record leveldb would not have
/// written (a zero run, damage) drops the rest of its 32 KiB block, as
/// leveldb's reader does; a record cut off by the end of the file is a write
/// still in progress and ends the walk.
struct LogRecords<'a> {
    buf: &'a [u8],
    pos: usize,
    pending: Option<Vec<LogFragment>>,
}

impl<'a> LogRecords<'a> {
    fn new(buf: &'a [u8], from: usize) -> LogRecords<'a> {
        LogRecords { buf, pos: from, pending: None }
    }
}

impl<'a> Iterator for LogRecords<'a> {
    type Item = LogRecord<'a>;

    fn next(&mut self) -> Option<LogRecord<'a>> {
        let buf = self.buf;
        while self.pos < buf.len() {
            let left = LOG_BLOCK - (self.pos % LOG_BLOCK);
            if left < LOG_HEADER {
                self.pos += left;
                continue;
            }
            if self.pos + LOG_HEADER > buf.len() {
                return None;
            }
            let at = self.pos;
            let crc = u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
            let len = u16::from_le_bytes([buf[at + 4], buf[at + 5]]) as usize;
            let kind = buf[at + 6];
            if !(LOG_FULL..=LOG_LAST).contains(&kind) || LOG_HEADER + len > left {
                self.pending = None;
                self.pos += left;
                continue;
            }
            if at + LOG_HEADER + len > buf.len() {
                return None;
            }
            let frag = LogFragment { pos: at, crc, kind, start: at + LOG_HEADER, end: at + LOG_HEADER + len };
            self.pos = frag.end;
            if kind == LOG_FULL {
                self.pending = None;
                let data = Cow::Borrowed(&buf[frag.start..frag.end]);
                return Some(LogRecord { start: frag.pos, data, frags: vec![frag] });
            }
            if kind == LOG_FIRST {
                self.pending = Some(vec![frag]);
                continue;
            }
            if let Some(p) = self.pending.as_mut() {
                p.push(frag);
                if kind == LOG_LAST {
                    let frags = self.pending.take().unwrap_or_default();
                    let mut data: Vec<u8> = Vec::with_capacity(frags.iter().map(|f| f.end - f.start).sum());
                    for f in &frags {
                        data.extend_from_slice(&buf[f.start..f.end]);
                    }
                    let start = frags.first().map(|f| f.pos).unwrap_or(0);
                    return Some(LogRecord { start, data: Cow::Owned(data), frags });
                }
            }
        }
        None
    }
}

/// The wanted keys' records in one write-ahead log: each record is a write
/// batch (sequence, count, then puts and deletes), entry i at sequence + i.
fn log_file_records(buf: &[u8], file: &str, matches: &dyn Fn(&[u8]) -> bool) -> Vec<LeveldbRecord> {
    let mut out: Vec<LeveldbRecord> = Vec::new();
    for rec in LogRecords::new(buf, 0) {
        let d: &[u8] = &rec.data;
        if d.len() < 12 {
            continue;
        }
        let seq0 = u64::from_le_bytes([d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]]);
        let count = u32::from_le_bytes([d[8], d[9], d[10], d[11]]) as u64;
        let mut found: Vec<LeveldbRecord> = Vec::new();
        let mut p = 12usize;
        let mut i = 0u64;
        while i < count && p < d.len() {
            let tag = d[p];
            p += 1;
            if tag != TYPE_VALUE && tag != TYPE_DELETION {
                break;
            }
            let (klen, q) = match read_varint(d, p) {
                Ok(v) => v,
                Err(()) => break,
            };
            let klen = klen as usize;
            let key_at = q;
            p = q + klen;
            let (mut at, mut len) = (0usize, 0usize);
            if tag == TYPE_VALUE {
                let (vlen, q) = match read_varint(d, p) {
                    Ok(v) => v,
                    Err(()) => break,
                };
                len = vlen as usize;
                at = q;
                p = q + len;
            }
            if p > d.len() {
                break;
            }
            let key = &d[key_at..key_at + klen];
            if matches(key) {
                found.push(LeveldbRecord { key: key.to_vec(), seq: seq0.wrapping_add(i), live: tag == TYPE_VALUE, file: file.to_string(), block: rec.start as u64, block_size: None, at, len });
            }
            i += 1;
        }
        if !found.is_empty() && rec.frags.iter().all(|f| log_fragment_crc(f.kind, &buf[f.start..f.end]) == f.crc) {
            out.extend(found);
        }
    }
    out
}

/// A data block's bytes from its on-disk form (`size` bytes, then the type
/// byte): Snappy-decompressed when the type says so.
fn decode_block(raw: &[u8], size: usize) -> Result<Vec<u8>, ()> {
    if raw.len() < size + 1 {
        return Err(());
    }
    if raw[size] == 1 {
        return snappy_decompress(&raw[..size]);
    }
    Ok(raw[..size].to_vec())
}

/// The wanted keys' records of one data block. Its keys are leveldb INTERNAL
/// keys: the user key, then 8 bytes of (sequence << 8 | type) little-endian.
fn block_records(block: &[u8], offset: usize, size: usize, file: &str, matches: &dyn Fn(&[u8]) -> bool, key: &mut Vec<u8>, out: &mut Vec<LeveldbRecord>) {
    if block.len() < 4 {
        return;
    }
    let restarts = match read_u32_le(block, block.len() - 4) {
        Some(n) => n as usize,
        None => return,
    };
    let end = match restarts.checked_mul(4).and_then(|r| block.len().checked_sub(4 + r)) {
        Some(e) => e,
        None => return,
    };
    key.clear();
    let mut q = 0usize;
    while q < end {
        let (shared, q1) = match read_varint(block, q) {
            Ok(v) => v,
            Err(()) => return,
        };
        let (non_shared, q2) = match read_varint(block, q1) {
            Ok(v) => v,
            Err(()) => return,
        };
        let (vlen, q3) = match read_varint(block, q2) {
            Ok(v) => v,
            Err(()) => return,
        };
        let (shared, non_shared, vlen) = (shared as usize, non_shared as usize, vlen as usize);
        if shared > key.len() || q3 + non_shared + vlen > end {
            return;
        }
        key.truncate(shared);
        key.extend_from_slice(&block[q3..q3 + non_shared]);
        let at = q3 + non_shared;
        q = at + vlen;
        if key.len() < 8 {
            continue;
        }
        let ulen = key.len() - 8;
        if !matches(&key[..ulen]) {
            continue;
        }
        let t = &key[ulen..];
        let tag = u64::from_le_bytes([t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7]]);
        let kind = (tag & 0xff) as u8;
        if kind != TYPE_VALUE && kind != TYPE_DELETION {
            continue;
        }
        out.push(LeveldbRecord { key: key[..ulen].to_vec(), seq: tag >> 8, live: kind == TYPE_VALUE, file: file.to_string(), block: offset as u64, block_size: Some(size as u64), at, len: vlen });
    }
}

/// The wanted keys' records in one table of `file_len` bytes, read through
/// `read(offset, len)` one block at a time. None when a read fails (the file
/// moved under the read); no records when it has no valid footer (a table
/// still being written, or not a table) or its index does not parse.
fn table_records(file_len: usize, read: &mut dyn FnMut(usize, usize) -> Option<Vec<u8>>, file: &str, matches: &dyn Fn(&[u8]) -> bool) -> Option<Vec<LeveldbRecord>> {
    let mut out: Vec<LeveldbRecord> = Vec::new();
    if file_len < 48 {
        return Some(out);
    }
    let footer = read(file_len - 48, 48)?;
    if read_u32_le(&footer, 40) != Some(SST_MAGIC_LO) || read_u32_le(&footer, 44) != Some(SST_MAGIC_HI) {
        return Some(out);
    }
    let handles = (|| -> Result<Option<Vec<(usize, usize)>>, ()> {
        let (_, p) = read_varint(&footer, 0)?;
        let (_, p) = read_varint(&footer, p)?;
        let (off, p) = read_varint(&footer, p)?;
        let (size, _) = read_varint(&footer, p)?;
        let (off, size) = (off as usize, size as usize);
        if off + size + 1 > file_len {
            return Ok(Some(Vec::new()));
        }
        let raw = match read(off, size + 1) {
            Some(r) => r,
            None => return Ok(None),
        };
        let index = decode_block(&raw, size)?;
        if index.len() < 4 {
            return Ok(Some(Vec::new()));
        }
        let restarts = read_u32_le(&index, index.len() - 4).ok_or(())? as usize;
        let end = restarts.checked_mul(4).and_then(|r| index.len().checked_sub(4 + r)).ok_or(())?;
        let mut handles: Vec<(usize, usize)> = Vec::new();
        let mut q = 0usize;
        while q < end {
            let (_, q1) = read_varint(&index, q)?;
            let (non_shared, q2) = read_varint(&index, q1)?;
            let (value_len, q3) = read_varint(&index, q2)?;
            let v_start = q3 + non_shared as usize;
            q = v_start + value_len as usize;
            let (d_off, hp) = read_varint(&index, v_start)?;
            let (d_size, _) = read_varint(&index, hp)?;
            handles.push((d_off as usize, d_size as usize));
        }
        Ok(Some(handles))
    })();
    let handles = match handles {
        Ok(Some(h)) => h,
        Ok(None) => return None,
        Err(()) => return Some(out),
    };
    let mut key: Vec<u8> = Vec::with_capacity(256);
    for (off, size) in handles {
        if off + size + 1 > file_len {
            continue;
        }
        let raw = read(off, size + 1)?;
        let block = match decode_block(&raw, size) {
            Ok(b) => b,
            Err(()) => continue,
        };
        block_records(&block, off, size, file, matches, &mut key, &mut out);
    }
    Some(out)
}

/// Read `len` bytes at `offset` of an open file.
fn read_at(f: &mut fs::File, offset: usize, len: usize) -> Option<Vec<u8>> {
    f.seek(SeekFrom::Start(offset as u64)).ok()?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// Chromium Local Storage keys, `_<origin>\0\x01<name>`, of the names given,
/// under any origin (Claude Desktop builds have used file:// and
/// https://claude.ai).
pub fn local_storage_key_matches(names: &[Vec<u8>], key: &[u8]) -> bool {
    if key.len() < 3 || key[0] != b'_' {
        return false;
    }
    let z = match key.iter().position(|&b| b == 0) {
        Some(z) => z,
        None => return false,
    };
    if z < 1 || key.get(z + 1) != Some(&1u8) {
        return false;
    }
    let tail = &key[z + 2..];
    names.iter().any(|n| n.as_slice() == tail)
}

/// The name part of a Local Storage key matched above.
pub fn local_storage_key_name(key: &[u8]) -> &[u8] {
    match key.iter().position(|&b| b == 0) {
        Some(z) => key.get(z + 2..).unwrap_or(&[]),
        None => key,
    }
}

/// Is record `a` newer than `b`? The sequence number decides; two records
/// with the same number (only a hand-made store has them) go to the file whose
/// name sorts later, then to the later position in it.
pub fn is_newer_record(a: &LeveldbRecord, b: &LeveldbRecord) -> bool {
    if a.seq != b.seq {
        return a.seq > b.seq;
    }
    if a.file != b.file {
        return a.file > b.file;
    }
    a.block > b.block
}

/// The records of the matching keys across a Local Storage leveldb directory,
/// with per-file caches. One instance per directory.
pub struct LeveldbKeyReader {
    pub dir: String,
    /// Whether the last `newest()` read every file it listed. False when files
    /// kept vanishing through three reads, or the directory could not be
    /// listed: what it returned may be missing the newest write.
    pub complete: bool,
    names: Vec<Vec<u8>>,
    files: HashMap<String, (String, Vec<LeveldbRecord>)>,
}

impl LeveldbKeyReader {
    pub fn new(dir: &str, names: &[&str]) -> LeveldbKeyReader {
        LeveldbKeyReader { dir: dir.to_string(), complete: true, names: names.iter().map(|n| n.as_bytes().to_vec()).collect(), files: HashMap::new() }
    }

    /// The newest record of every matching key (a deletion included), in the
    /// order the keys were first met. A file that vanishes mid-read means a
    /// compaction moved the records: the whole read runs again, up to three
    /// times.
    pub fn newest(&mut self) -> Vec<LeveldbRecord> {
        let mut records: Vec<LeveldbRecord> = Vec::new();
        self.complete = false;
        let mut attempt = 0;
        while attempt < 3 && !self.complete {
            let (got, complete) = self.read_once();
            records = got;
            self.complete = complete;
            attempt += 1;
        }
        let mut best: Vec<LeveldbRecord> = Vec::new();
        let mut slot: HashMap<Vec<u8>, usize> = HashMap::new();
        for r in records {
            match slot.get(&r.key) {
                Some(&i) => {
                    if is_newer_record(&r, &best[i]) {
                        best[i] = r;
                    }
                }
                None => {
                    slot.insert(r.key.clone(), best.len());
                    best.push(r);
                }
            }
        }
        best
    }

    fn read_once(&mut self) -> (Vec<LeveldbRecord>, bool) {
        let mut names: Vec<String> = match fs::read_dir(&self.dir) {
            Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|f| f.ends_with(".log") || f.ends_with(".ldb")).collect(),
            Err(e) => {
                // No directory is no store; a directory that cannot be listed
                // is a read that failed.
                self.files.clear();
                return (Vec::new(), e.kind() == std::io::ErrorKind::NotFound);
            }
        };
        names.sort();
        let wanted = self.names.clone();
        let matches = move |k: &[u8]| local_storage_key_matches(&wanted, k);
        let mut records: Vec<LeveldbRecord> = Vec::new();
        let mut present: HashSet<String> = HashSet::new();
        let mut complete = true;
        for name in &names {
            let p = Path::new(&self.dir).join(name);
            let st = match stat_safe(&p) {
                Some(s) => s,
                None => {
                    complete = false;
                    continue;
                }
            };
            let stamp = format!("{}:{}", st.size, st.mtime_ms);
            present.insert(name.clone());
            if let Some((s, recs)) = self.files.get(name) {
                if *s == stamp {
                    records.extend(recs.iter().cloned());
                    continue;
                }
            }
            let found = if name.ends_with(".log") {
                match fs::read(&p) {
                    Ok(buf) => log_file_records(&buf, name, &matches),
                    Err(_) => {
                        complete = false;
                        continue;
                    }
                }
            } else {
                let got = fs::File::open(&p).ok().and_then(|mut f| {
                    let len = f.metadata().ok()?.len() as usize;
                    table_records(len, &mut |off, n| read_at(&mut f, off, n), name, &matches)
                });
                match got {
                    Some(r) => r,
                    None => {
                        complete = false;
                        continue;
                    }
                }
            };
            records.extend(found.iter().cloned());
            self.files.insert(name.clone(), (stamp, found));
        }
        self.files.retain(|k, _| present.contains(k));
        (records, complete)
    }
}

/// The value of a live record, or None when its file changed or vanished.
pub fn read_leveldb_value(dir: &str, rec: &LeveldbRecord) -> Option<Vec<u8>> {
    if !rec.live {
        return None;
    }
    let p = Path::new(dir).join(&rec.file);
    match rec.block_size {
        Some(size) => {
            let mut f = fs::File::open(&p).ok()?;
            let raw = read_at(&mut f, rec.block as usize, size as usize + 1)?;
            let block = decode_block(&raw, size as usize).ok()?;
            block.get(rec.at..rec.at + rec.len).map(|v| v.to_vec())
        }
        None => {
            let buf = fs::read(&p).ok()?;
            let r = LogRecords::new(&buf, rec.block as usize).next()?;
            if r.start != rec.block as usize {
                return None;
            }
            r.data.get(rec.at..rec.at + rec.len).map(|v| v.to_vec())
        }
    }
}

/// A Local Storage value as JSON text for `Json::parse`: a leading 1 means
/// Latin-1, 0 means UTF-16LE (Chromium's two encodings); anything else is not
/// such a value. A lone surrogate, which only a JSON string can hold, is
/// written as its `\u` escape, which parses to the same code unit.
pub fn decode_local_storage_value(v: &[u8]) -> Option<String> {
    match v.first() {
        Some(1) => Some(v[1..].iter().map(|&b| b as char).collect()),
        Some(0) => {
            let units = v[1..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]]));
            let mut out = String::with_capacity(v.len() / 2);
            for r in char::decode_utf16(units) {
                match r {
                    Ok(c) => out.push(c),
                    Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
                }
            }
            Some(out)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varint(mut v: u64, out: &mut Vec<u8>) {
        while v >= 0x80 {
            out.push((v as u8 & 0x7f) | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }

    fn ls_key(origin: &str, name: &str) -> Vec<u8> {
        let mut k = format!("_{}", origin).into_bytes();
        k.extend_from_slice(&[0, 1]);
        k.extend_from_slice(name.as_bytes());
        k
    }

    fn latin1(text: &str) -> Vec<u8> {
        let mut v = vec![1u8];
        v.extend(text.chars().map(|c| c as u8));
        v
    }

    /// A log framed as leveldb's writer frames it (32 KiB blocks, first/middle/last fragments).
    fn build_log(batches: &[(u64, Vec<(Vec<u8>, Option<Vec<u8>>)>)]) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        let mut block_offset = 0usize;
        for (seq, entries) in batches {
            let mut body: Vec<u8> = Vec::new();
            body.extend_from_slice(&seq.to_le_bytes());
            body.extend_from_slice(&(entries.len() as u32).to_le_bytes());
            for (k, v) in entries {
                match v {
                    Some(v) => {
                        body.push(1);
                        varint(k.len() as u64, &mut body);
                        body.extend_from_slice(k);
                        varint(v.len() as u64, &mut body);
                        body.extend_from_slice(v);
                    }
                    None => {
                        body.push(0);
                        varint(k.len() as u64, &mut body);
                        body.extend_from_slice(k);
                    }
                }
            }
            let mut left = body.len();
            let mut ptr = 0usize;
            let mut begin = true;
            loop {
                let leftover = LOG_BLOCK - block_offset;
                if leftover < LOG_HEADER {
                    out.extend(std::iter::repeat(0u8).take(leftover));
                    block_offset = 0;
                }
                let avail = LOG_BLOCK - block_offset - LOG_HEADER;
                let n = left.min(avail);
                let end = left == n;
                let kind: u8 = if begin && end { 1 } else if begin { 2 } else if end { 4 } else { 3 };
                let data = &body[ptr..ptr + n];
                out.extend_from_slice(&log_fragment_crc(kind, data).to_le_bytes());
                out.extend_from_slice(&(n as u16).to_le_bytes());
                out.push(kind);
                out.extend_from_slice(data);
                block_offset += LOG_HEADER + n;
                ptr += n;
                left -= n;
                begin = false;
                if left == 0 {
                    break;
                }
            }
        }
        out
    }

    /// A table of one uncompressed data block per entry, sorted as leveldb sorts internal keys.
    fn build_table(entries: &[(Vec<u8>, u64, Option<Vec<u8>>)]) -> Vec<u8> {
        let mut sorted: Vec<&(Vec<u8>, u64, Option<Vec<u8>>)> = entries.iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
        let mut file: Vec<u8> = Vec::new();
        let mut index: Vec<u8> = Vec::new();
        let mut index_restarts: Vec<u32> = Vec::new();
        let write_block = |file: &mut Vec<u8>, raw: &[u8]| -> (u64, u64) {
            let off = file.len() as u64;
            file.extend_from_slice(raw);
            file.push(0);
            file.extend_from_slice(&[0, 0, 0, 0]);
            (off, raw.len() as u64)
        };
        for (k, seq, v) in sorted {
            let mut ikey = k.clone();
            ikey.extend_from_slice(&((seq << 8) | if v.is_some() { 1 } else { 0 }).to_le_bytes());
            let value = v.clone().unwrap_or_default();
            let mut block: Vec<u8> = Vec::new();
            varint(0, &mut block);
            varint(ikey.len() as u64, &mut block);
            varint(value.len() as u64, &mut block);
            block.extend_from_slice(&ikey);
            block.extend_from_slice(&value);
            block.extend_from_slice(&0u32.to_le_bytes());
            block.extend_from_slice(&1u32.to_le_bytes());
            let (off, size) = write_block(&mut file, &block);
            index_restarts.push(index.len() as u32);
            let mut handle: Vec<u8> = Vec::new();
            varint(off, &mut handle);
            varint(size, &mut handle);
            varint(0, &mut index);
            varint(ikey.len() as u64, &mut index);
            varint(handle.len() as u64, &mut index);
            index.extend_from_slice(&ikey);
            index.extend_from_slice(&handle);
        }
        for r in &index_restarts {
            index.extend_from_slice(&r.to_le_bytes());
        }
        index.extend_from_slice(&(index_restarts.len() as u32).to_le_bytes());
        let mut meta: Vec<u8> = Vec::new();
        meta.extend_from_slice(&0u32.to_le_bytes());
        meta.extend_from_slice(&1u32.to_le_bytes());
        let (moff, msize) = write_block(&mut file, &meta);
        let (ioff, isize) = write_block(&mut file, &index);
        let mut footer: Vec<u8> = Vec::new();
        varint(moff, &mut footer);
        varint(msize, &mut footer);
        varint(ioff, &mut footer);
        varint(isize, &mut footer);
        footer.resize(40, 0);
        footer.extend_from_slice(&SST_MAGIC_LO.to_le_bytes());
        footer.extend_from_slice(&SST_MAGIC_HI.to_le_bytes());
        file.extend_from_slice(&footer);
        file
    }

    struct Dir(std::path::PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn store(tag: &str, files: &[(&str, Vec<u8>)]) -> Dir {
        let d = std::env::temp_dir().join(format!("hx2-ldb-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        for (name, bytes) in files {
            fs::write(d.join(name), bytes).unwrap();
        }
        Dir(d)
    }

    fn newest_value(d: &Dir) -> Option<Option<String>> {
        let dir = d.0.to_string_lossy().into_owned();
        let recs = LeveldbKeyReader::new(&dir, &["dframe-store"]).newest();
        let rec = recs.first()?;
        if !rec.live {
            return Some(None);
        }
        let raw = read_leveldb_value(&dir, rec)?;
        Some(decode_local_storage_value(&raw))
    }

    #[test]
    fn the_newest_write_wins_whatever_file_it_is_in() {
        let k = ls_key("https://claude.ai", "dframe-store");
        let d = store(
            "files",
            &[
                ("000006.log", build_log(&[(30, vec![(k.clone(), Some(latin1("v3")))])])),
                ("000007.ldb", build_table(&[(k.clone(), 20, Some(latin1("v2")))])),
                ("000008.ldb", build_table(&[(k.clone(), 10, Some(latin1("v1")))])),
            ],
        );
        assert_eq!(newest_value(&d), Some(Some("v3".to_string())));
    }

    #[test]
    fn within_a_log_the_later_batch_and_within_a_table_the_highest_sequence() {
        let k = ls_key("https://claude.ai", "dframe-store");
        let other = ls_key("https://claude.ai", "branch-status-cache");
        let d = store("log", &[("000003.log", build_log(&[(1, vec![(k.clone(), Some(latin1("old")))]), (2, vec![(other.clone(), Some(latin1("x"))), (k.clone(), Some(latin1("new")))])]))]);
        assert_eq!(newest_value(&d), Some(Some("new".to_string())));
        let d2 = store("table", &[("000004.ldb", build_table(&[(k.clone(), 5, Some(latin1("five"))), (k.clone(), 9, Some(latin1("nine"))), (other, 7, Some(latin1("o")))]))]);
        assert_eq!(newest_value(&d2), Some(Some("nine".to_string())));
    }

    #[test]
    fn a_deletion_that_wins_hides_older_values() {
        let k = ls_key("https://claude.ai", "dframe-store");
        let d = store("del", &[("000004.ldb", build_table(&[(k.clone(), 5, Some(latin1("five")))])), ("000005.log", build_log(&[(6, vec![(k.clone(), None)])]))]);
        assert_eq!(newest_value(&d), Some(None));
    }

    #[test]
    fn a_value_over_32_kib_reads_whole_and_a_torn_or_damaged_batch_does_not() {
        let k = ls_key("https://claude.ai", "dframe-store");
        let big = format!("{}end", "x".repeat(100_000));
        let d = store("big", &[("000003.log", build_log(&[(1, vec![(ls_key("https://claude.ai", "other"), Some(latin1(&"y".repeat(30_000))))]), (2, vec![(k.clone(), Some(latin1(&big)))])]))]);
        assert_eq!(newest_value(&d), Some(Some(big)));

        let whole = build_log(&[(1, vec![(k.clone(), Some(latin1("complete")))]), (2, vec![(k.clone(), Some(latin1(&"z".repeat(50_000))))])]);
        let torn = store("torn", &[("000003.log", whole[..whole.len() - 100].to_vec())]);
        assert_eq!(newest_value(&torn), Some(Some("complete".to_string())));

        let mut damaged = build_log(&[(1, vec![(k.clone(), Some(latin1("good")))]), (2, vec![(k.clone(), Some(latin1("damaged")))])]);
        let n = damaged.len();
        damaged[n - 2] ^= 0xff;
        let bad = store("crc", &[("000003.log", damaged)]);
        assert_eq!(newest_value(&bad), Some(Some("good".to_string())));
    }

    #[test]
    fn keys_under_any_origin_and_both_value_encodings() {
        let names = vec![b"dframe-store".to_vec(), b"frame-store".to_vec()];
        assert!(local_storage_key_matches(&names, &ls_key("https://claude.ai", "dframe-store")));
        assert!(local_storage_key_matches(&names, &ls_key("file://", "frame-store")));
        assert!(!local_storage_key_matches(&names, &ls_key("https://claude.ai", "dframe-store.backup.v1")));
        assert!(!local_storage_key_matches(&names, b"META:https://claude.ai"));
        assert_eq!(local_storage_key_name(&ls_key("file://", "frame-store")), b"frame-store");
        assert_eq!(decode_local_storage_value(&latin1("Caf\u{e9}")), Some("Caf\u{e9}".to_string()));
        let wide = "Group \u{2192} \u{65e5}\u{672c}";
        let mut v = vec![0u8];
        for u in wide.encode_utf16() {
            v.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_local_storage_value(&v), Some(wide.to_string()));
        let mut lone = vec![0u8];
        for u in [b'"' as u16, 0xd800, b'"' as u16] {
            lone.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_local_storage_value(&lone), Some("\"\\ud800\"".to_string()));
        assert_eq!(decode_local_storage_value(b"{}"), None);
    }
}
