//! Codex's own session title from `~/.codex/state_<N>.sqlite` (src/codex-titles.ts).
//!
//! The title never travels in the rollout the daemon ingests; it lives in the
//! `threads` table of Codex's state database (`id`, `title`, and since
//! migration 0041 `name`, the user's rename). A `name` wins over the auto
//! `title`; both are trimmed and an empty one is no title. Read-only and never
//! failing: an absent database, a locked or corrupt file, an older schema or a
//! Codex too old for the table all read as "no title". A database Codex has
//! closed (no `-wal` file) is opened immutable (`open_codex_state_db`). The
//! id → title map is cached per Codex home until the database or its `-wal`
//! sidecar changes, or a short TTL lapses, so a pass over many sessions opens
//! the database once.

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
pub fn state_db_path(codex_home: &str) -> Option<String> {
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

/// A SQLite URI that opens `p` read-only and ignores any WAL.
pub fn immutable_db_uri(p: &str) -> String {
    let mut u = p.replace('\\', "/");
    let b = u.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/' {
        u = format!("/{}", u);
    }
    let u = u.replace('%', "%25").replace('?', "%3f").replace('#', "%23");
    format!("file:{}?immutable=1", u)
}

/// Codex's app-server closes the database when idle, and the last close
/// deletes the -wal and -shm files; a read-only connection cannot open a WAL
/// database in that state, so with no -wal file the database is opened
/// immutable (everything is in the main file then). The sections reader
/// (codex_sections.rs) opens it the same way.
pub fn open_codex_state_db(db_path: &str) -> rusqlite::Result<Connection> {
    if Path::new(&format!("{}-wal", db_path)).exists() {
        return Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX);
    }
    Connection::open_with_flags(
        immutable_db_uri(db_path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
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
    let conn = match open_codex_state_db(&db_path) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("hx2-codex-titles-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn builds_the_immutable_uri() {
        assert_eq!(immutable_db_uri("/a b/c%d?e#f.sqlite"), "file:/a b/c%25d%3fe%23f.sqlite?immutable=1");
        assert_eq!(immutable_db_uri("C:\\Users\\x\\.codex\\state_5.sqlite"), "file:/C:/Users/x/.codex/state_5.sqlite?immutable=1");
    }

    /// Codex's last close checkpoints the WAL and deletes both files; a plain
    /// read-only open then fails with "unable to open database file".
    #[test]
    fn reads_a_wal_database_whose_wal_is_gone() {
        let h = home("idle");
        let p = join(&h, "state_5.sqlite");
        {
            let conn = Connection::open(&p).unwrap();
            conn.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT); INSERT INTO threads (id, title, name) VALUES ('s1', 'From the main file', NULL);").unwrap();
            let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0)).unwrap();
            conn.execute("INSERT INTO threads (id, title, name) VALUES ('s2', 'auto', 'Checkpointed')", []).unwrap();
            let _: (i64, i64, i64) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        }
        for f in [format!("{}-wal", p), format!("{}-shm", p)] {
            let _ = fs::remove_file(f);
        }
        let s1 = read_codex_title(&h, "s1").expect("a title from the main file");
        assert_eq!((s1.title, s1.source), (js("From the main file"), "ai"));
        let s2 = read_codex_title(&h, "s2").expect("the checkpointed rename");
        assert_eq!((s2.title, s2.source), (js("Checkpointed"), "user"));
        let _ = fs::remove_dir_all(&h);
    }
}
