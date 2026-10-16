//! Codex's own session title from `~/.codex/state_<N>.sqlite` (src/codex-titles.ts).
//!
//! The title never travels in the rollout the daemon ingests; it lives in the
//! `threads` table of Codex's state database (`id`, `title`, and since
//! migration 0041 `name`, the user's rename). A `name` wins over the auto
//! `title`; both are trimmed and an empty one is no title. Read-only and never
//! failing: an absent database, a locked or corrupt file, an older schema or a
//! Codex too old for the table all read as "no title". The id → title map is
//! cached per Codex home until the database or its `-wal` sidecar changes, or
//! a short TTL lapses, so a pass over many sessions opens the database once.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use rusqlite::{Connection, OpenFlags};

use crate::fsutil::{join, now_ms, stat_safe};
use crate::js::{js, trim, JsStr};

#[derive(Clone, Debug)]
pub struct CodexTitle {
    pub title: JsStr,
    /// "user" | "ai"
    pub source: &'static str,
}

const TTL_MS: f64 = 10_000.0;

struct Cached {
    at_ms: f64,
    fp: String,
    map: HashMap<String, CodexTitle>,
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Newest `state_<N>.sqlite` under a Codex home, or None.
fn state_db_path(codex_home: &str) -> Option<String> {
    let entries = fs::read_dir(codex_home).ok()?;
    let mut best: Option<(u64, String)> = None;
    for e in entries.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().into_owned();
        let rest = match name.strip_prefix("state_") {
            Some(r) => r,
            None => continue,
        };
        let digits = match rest.strip_suffix(".sqlite") {
            Some(d) => d,
            None => continue,
        };
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        // `Number(m[1])`: a run of digits, as a double.
        let n: u64 = digits.parse::<f64>().map(|v| v as u64).unwrap_or(0);
        let better = match &best {
            Some((bn, _)) => n > *bn,
            None => true,
        };
        if better {
            best = Some((n, join(codex_home, &name)));
        }
    }
    best.map(|(_, p)| p)
}

/// `${size}:${Math.trunc(mtimeMs)}` of the database and its -wal sidecar.
fn fingerprint(db_path: &str) -> String {
    let part = |p: &str| -> String {
        match stat_safe(Path::new(p)) {
            Some(s) => format!("{}:{}", s.size, s.mtime_ms.trunc() as i64),
            None => "-".to_string(),
        }
    };
    let db = part(db_path);
    if db == "-" {
        return "absent".to_string();
    }
    format!("{}|{}", db, part(&format!("{}-wal", db_path)))
}

/// A user rename beats the auto title; both trimmed, an empty one rejected.
fn pick(name: Option<&str>, title: Option<&str>) -> Option<CodexTitle> {
    if let Some(n) = name {
        let t = trim(&js(n)).to_vec();
        if !t.is_empty() {
            return Some(CodexTitle { title: t, source: "user" });
        }
    }
    if let Some(t) = title {
        let t = trim(&js(t)).to_vec();
        if !t.is_empty() {
            return Some(CodexTitle { title: t, source: "ai" });
        }
    }
    None
}

fn text_of(v: rusqlite::types::ValueRef<'_>) -> Option<String> {
    match v {
        rusqlite::types::ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        _ => None,
    }
}

/// Every thread's title from a Codex home's state database; empty on any failure.
fn load_map(codex_home: &str) -> HashMap<String, CodexTitle> {
    let mut out: HashMap<String, CodexTitle> = HashMap::new();
    let db_path = match state_db_path(codex_home) {
        Some(p) => p,
        None => return out,
    };
    let conn = match Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) {
        Ok(c) => c,
        Err(_) => return out,
    };
    // `name` (migration 0041) is absent on older schemas: try with it, then
    // without, rather than introspecting.
    let queries: [(&str, bool); 2] = [("SELECT id, name, title FROM threads", true), ("SELECT id, title FROM threads", false)];
    for (sql, with_name) in queries {
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let mut rows = match stmt.query([]) {
            Ok(r) => r,
            Err(_) => return out,
        };
        loop {
            let row = match rows.next() {
                Ok(Some(r)) => r,
                Ok(None) => break,
                Err(_) => break,
            };
            let id = match row.get_ref(0).ok().and_then(text_of) {
                Some(id) => id,
                None => continue,
            };
            let (name, title) = if with_name {
                (row.get_ref(1).ok().and_then(text_of), row.get_ref(2).ok().and_then(text_of))
            } else {
                (None, row.get_ref(1).ok().and_then(text_of))
            };
            if let Some(t) = pick(name.as_deref(), title.as_deref()) {
                out.insert(id, t);
            }
        }
        return out;
    }
    out
}

/// Codex's own name for a session id, or None when Codex has none.
pub fn read_codex_title(codex_home: &str, session_id: &str) -> Option<CodexTitle> {
    if session_id.is_empty() {
        return None;
    }
    let now = now_ms();
    let fp = match state_db_path(codex_home) {
        Some(p) => fingerprint(&p),
        None => "absent".to_string(),
    };
    let mut c = cache().lock().unwrap_or_else(|e| e.into_inner());
    let fresh = match c.get(codex_home) {
        Some(hit) => now - hit.at_ms < TTL_MS && hit.fp == fp,
        None => false,
    };
    if !fresh {
        let map = load_map(codex_home);
        c.insert(codex_home.to_string(), Cached { at_ms: now, fp, map });
    }
    c.get(codex_home).and_then(|hit| hit.map.get(session_id).cloned())
}
