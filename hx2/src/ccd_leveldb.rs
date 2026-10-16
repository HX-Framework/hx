//! A minimal leveldb reader (src/ccd-leveldb.ts): enough to recover a
//! Chromium Local Storage value after the write-ahead log has compacted into
//! Snappy-compressed `.ldb` tables. The database is never opened; every
//! `.log` is handed back whole and every data block of every `.ldb` is
//! decompressed and handed back raw, newest file first, for the caller's
//! substring scan. Anything unexpected yields nothing, as the client's does.

use std::fs;
use std::path::Path;

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
