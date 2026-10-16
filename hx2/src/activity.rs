//! The local upload journal the UI charts (src/activity.ts). Best-effort.

use std::fs;
use std::io::{Read, Seek, SeekFrom};

use crate::fsutil::{append_file_0600, write_atomic_0600};
use crate::home::hx_dir;
use crate::json::{obj, Json};

pub fn append_activity(at_ms: f64, session_id: &str, family: &str, bytes: u64, dest: &str) {
    let entry = obj(vec![
        ("at", Json::num(at_ms)),
        ("sessionId", Json::str(session_id)),
        ("family", Json::str(family)),
        ("bytes", Json::num(bytes as f64)),
        ("dest", Json::str(dest)),
    ]);
    let line = format!("{}\n", entry.stringify());
    let _ = append_file_0600(&hx_dir().join("activity.jsonl"), line.as_bytes());
}

const TRIM_AT_BYTES: u64 = 2 * 1024 * 1024;
const TRIM_KEEP_BYTES: u64 = 1024 * 1024;

/// Cap the journal: over ~2 MB, keep the last ~1 MB from a line boundary.
pub fn trim_activity() {
    let path = hx_dir().join("activity.jsonl");
    let mut f = match fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let size = match f.metadata() {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    if size <= TRIM_AT_BYTES {
        return;
    }
    let start = size - TRIM_KEEP_BYTES;
    if f.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut buf = Vec::with_capacity(TRIM_KEEP_BYTES as usize);
    if f.read_to_end(&mut buf).is_err() {
        return;
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let aligned = match text.find('\n') {
        Some(i) => text[i + 1..].to_string(),
        None => String::new(),
    };
    let _ = write_atomic_0600(&path, aligned.as_bytes());
}
