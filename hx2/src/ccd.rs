//! Claude Code Desktop's per-session metadata files (src/ccd.ts):
//! `<app data>/claude-code-sessions/<accountId>/<orgId>/local_<uuid>.json`,
//! read into an incremental index that a refresh brings up to date by
//! statting the org directories first (Claude Desktop writes by rename, so a
//! creation or rewrite bumps the parent's mtime), re-listing only the ones
//! that moved and re-reading only the files whose (size, mtime) moved. A
//! full per-file stat runs at most once a minute as the safety net. The
//! index is saved across restarts as `~/.let/hx/ccd-index.json` and loaded
//! before the first refresh, which is then a full stat.
//!
//! The index is process-wide, as the client's module state is: both tee
//! lanes read the same store.
//!
//! A long-lived machine has 35,000 or more session files, so the index is
//! kept compact: a record is its three strings in one WTF-8 buffer (wtf8.rs)
//! and its flags; a path is its directory, interned, and its file name,
//! shared between the index and the directory's listing; a record is shared
//! between the index, the record list and the cli-id lookup. The session
//! files and the saved index are read by scanning (jscan.rs), not into a
//! JSON tree, and the saved index is written straight into its text. Every
//! byte of that text is what the client writes for the same index: the
//! harness compares the two files entry by entry.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use indexmap::{IndexMap, IndexSet};

use crate::fsutil::{join, readdir_safe, stat_safe, write_atomic_0600};
use crate::home::{homedir, hx_dir};
use crate::js::JsStr;
use crate::jscan::{Scanner, Val};
use crate::json::write_num;
use crate::wtf8;

pub const CCD_REFRESH_TTL_MS: f64 = 20_000.0;
pub const CCD_FULL_STAT_INTERVAL_MS: f64 = 60_000.0;
pub const CCD_INDEX_SAVE_INTERVAL_MS: f64 = 10.0 * 60_000.0;

/// Claude Desktop's per-user data directory, where it ships.
pub fn ccd_app_dir() -> Option<String> {
    if cfg!(target_os = "macos") {
        return Some(homedir().join("Library").join("Application Support").join("Claude").to_string_lossy().into_owned());
    }
    None
}

/// `<app data>/claude-code-sessions`.
pub fn ccd_sessions_dir() -> Option<String> {
    ccd_app_dir().map(|r| join(&r, "claude-code-sessions"))
}

/// `<app data>/Local Storage/leveldb`.
pub fn ccd_leveldb_dir() -> Option<String> {
    ccd_app_dir().map(|r| join(&join(&r, "Local Storage"), "leveldb"))
}

// ── Records ─────────────────────────────────────────────────────────────────

const HAS_CLI: u8 = 1;
const HAS_TITLE: u8 = 2;
const ARCHIVED: u8 = 4;
const SOURCE_USER: u8 = 8;
const SOURCE_AI: u8 = 16;

/// One session's metadata (`CcdSessionMeta` in ccd.ts): `ccdSessionId`,
/// `cliSessionId` and `title` one after another in one WTF-8 buffer, so a
/// record costs one allocation for its text.
#[derive(Debug)]
pub struct CcdSessionMeta {
    text: Box<[u8]>,
    cli_at: u32,
    title_at: u32,
    flags: u8,
    last_activity_at: f64,
}

impl CcdSessionMeta {
    fn new(ccd: &[u8], cli: Option<&[u8]>, title: Option<&[u8]>, title_source: Option<&'static str>, is_archived: bool, last_activity_at: f64) -> Self {
        let mut text = Vec::with_capacity(ccd.len() + cli.map_or(0, |c| c.len()) + title.map_or(0, |t| t.len()));
        text.extend_from_slice(ccd);
        let cli_at = text.len() as u32;
        if let Some(c) = cli {
            text.extend_from_slice(c);
        }
        let title_at = text.len() as u32;
        if let Some(t) = title {
            text.extend_from_slice(t);
        }
        let mut flags = 0u8;
        if cli.is_some() {
            flags |= HAS_CLI;
        }
        if title.is_some() {
            flags |= HAS_TITLE;
        }
        if is_archived {
            flags |= ARCHIVED;
        }
        match title_source {
            Some("user") => flags |= SOURCE_USER,
            Some("ai") => flags |= SOURCE_AI,
            _ => {}
        }
        CcdSessionMeta { text: text.into_boxed_slice(), cli_at, title_at, flags, last_activity_at }
    }

    /// `ccdSessionId`, WTF-8.
    pub fn ccd_session_id(&self) -> &[u8] {
        &self.text[..self.cli_at as usize]
    }

    /// `cliSessionId`, WTF-8; None for null.
    pub fn cli_session_id(&self) -> Option<&[u8]> {
        if self.flags & HAS_CLI != 0 {
            Some(&self.text[self.cli_at as usize..self.title_at as usize])
        } else {
            None
        }
    }

    /// `title`, WTF-8; None for null.
    pub fn title(&self) -> Option<&[u8]> {
        if self.flags & HAS_TITLE != 0 {
            Some(&self.text[self.title_at as usize..])
        } else {
            None
        }
    }

    /// "user" | "ai"
    pub fn title_source(&self) -> Option<&'static str> {
        if self.flags & SOURCE_USER != 0 {
            Some("user")
        } else if self.flags & SOURCE_AI != 0 {
            Some("ai")
        } else {
            None
        }
    }

    #[allow(dead_code)]
    pub fn is_archived(&self) -> bool {
        self.flags & ARCHIVED != 0
    }

    #[allow(dead_code)]
    pub fn last_activity_at(&self) -> f64 {
        self.last_activity_at
    }

    /// The title as the client holds it, in UTF-16 code units.
    pub fn title_units(&self) -> Option<JsStr> {
        self.title().map(wtf8::to_units)
    }

    /// `ccdSessionId` as the client holds it, in UTF-16 code units.
    pub fn ccd_session_id_units(&self) -> JsStr {
        wtf8::to_units(self.ccd_session_id())
    }

    /// The record as `JSON.stringify` writes the client's object.
    fn write_json(&self, out: &mut String) {
        out.push_str("{\"ccdSessionId\":");
        wtf8::write_json(out, self.ccd_session_id());
        out.push_str(",\"cliSessionId\":");
        match self.cli_session_id() {
            Some(c) => wtf8::write_json(out, c),
            None => out.push_str("null"),
        }
        out.push_str(",\"title\":");
        match self.title() {
            Some(t) => wtf8::write_json(out, t),
            None => out.push_str("null"),
        }
        out.push_str(",\"titleSource\":");
        match self.title_source() {
            Some(s) => {
                out.push('"');
                out.push_str(s);
                out.push('"');
            }
            None => out.push_str("null"),
        }
        out.push_str(if self.is_archived() { ",\"isArchived\":true" } else { ",\"isArchived\":false" });
        out.push_str(",\"lastActivityAt\":");
        write_num(out, self.last_activity_at);
        out.push('}');
    }
}

fn title_source_of(b: &[u8]) -> Option<&'static str> {
    match b {
        b"user" => Some("user"),
        b"ai" => Some("ai"),
        _ => None,
    }
}

/// `readSessionFile`: the record of one session file, or None where the
/// client's is null (unreadable, not JSON, not an object, no string
/// `sessionId`). For a key that appears twice the last value counts, as in
/// `JSON.parse`.
fn read_session_file(file_path: &str) -> Option<CcdSessionMeta> {
    let raw = fs::read(file_path).ok()?;
    session_record(&raw)
}

fn session_record(raw: &[u8]) -> Option<CcdSessionMeta> {
    let mut s = Scanner::new(raw);
    // Anything but an object (a parse error included) is a null record.
    if s.peek() != Some(b'{') {
        return None;
    }
    let mut fields: [Option<Val>; 6] = Default::default();
    s.object(|s, key| {
        let slot = match key {
            b"sessionId" => 0,
            b"cliSessionId" => 1,
            b"title" => 2,
            b"titleSource" => 3,
            b"isArchived" => 4,
            b"lastActivityAt" => 5,
            _ => return s.skip_value(),
        };
        fields[slot] = Some(s.val()?);
        Ok(())
    })
    .ok()?;
    if !s.at_end() {
        return None;
    }
    let [sid, cli, title, source, archived, last] = fields;
    let ccd = match sid {
        Some(Val::Str(b)) => b,
        _ => return None,
    };
    let cli = match cli {
        Some(Val::Str(b)) => Some(b),
        _ => None,
    };
    // `typeof d.title === "string" && d.title.trim() ? d.title : null`
    let title = match title {
        Some(Val::Str(b)) if wtf8::has_non_space(&b) => Some(b),
        _ => None,
    };
    let source = match source {
        Some(Val::Str(b)) => title_source_of(&b),
        _ => None,
    };
    let last = match last {
        Some(Val::Num(n)) => n,
        _ => 0.0,
    };
    Some(CcdSessionMeta::new(&ccd, cli.as_deref(), title.as_deref(), source, matches!(archived, Some(Val::Bool(true))), last))
}

// ── Paths ───────────────────────────────────────────────────────────────────

/// The directory part of a path with no "/" in it.
const NO_DIR: u32 = u32::MAX;

/// A path in the index: its directory, interned (a store has a handful),
/// and its file name, shared between the index and the directory's listing.
/// WTF-8, because a saved index can name any string.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PathKey {
    dir: u32,
    name: Arc<[u8]>,
}

/// Every directory a path in the index has named, by number.
#[derive(Default)]
struct DirTable {
    dirs: IndexSet<Box<[u8]>>,
}

impl DirTable {
    fn intern(&mut self, d: &[u8]) -> u32 {
        if let Some(i) = self.dirs.get_index_of(d) {
            return i as u32;
        }
        self.dirs.insert_full(Box::from(d)).0 as u32
    }

    fn get(&self, id: u32) -> &[u8] {
        &self.dirs[id as usize]
    }

    /// A whole path, split at its last "/".
    fn split(&mut self, full: &[u8]) -> PathKey {
        match full.iter().rposition(|&c| c == b'/') {
            Some(at) => PathKey { dir: self.intern(&full[..at]), name: Arc::from(&full[at + 1..]) },
            None => PathKey { dir: NO_DIR, name: Arc::from(full) },
        }
    }

    /// The path as the operating system is handed it.
    fn path_string(&self, k: &PathKey) -> String {
        let name = wtf8::lossy(&k.name);
        if k.dir == NO_DIR {
            return name.into_owned();
        }
        let dir = wtf8::lossy(self.get(k.dir));
        let mut s = String::with_capacity(dir.len() + 1 + name.len());
        s.push_str(&dir);
        s.push('/');
        s.push_str(&name);
        s
    }

    /// The path as `JSON.stringify` writes it. A surrogate pair cannot
    /// straddle the "/", so the escapes of the two parts are the escapes of
    /// the whole.
    fn write_json(&self, out: &mut String, k: &PathKey) {
        out.push('"');
        if k.dir != NO_DIR {
            wtf8::write_json_body(out, self.get(k.dir));
            out.push('/');
        }
        wtf8::write_json_body(out, &k.name);
        out.push('"');
    }
}

// ── The index ───────────────────────────────────────────────────────────────

struct IndexedFile {
    size: f64,
    mtime_ms: f64,
    record: Option<Arc<CcdSessionMeta>>,
}

struct OrgDirListing {
    mtime_ms: f64,
    /// The `local_*.json` files present at `mtime_ms`.
    files: Vec<PathKey>,
}

/// `cliSessionId` → record, as the client's Map from `getCcdRecentsByCliId`
/// holds it: a record without a cli id, or with an empty one, is not in it,
/// and the last record with an id wins. Sorted by the id (a stable sort, so
/// that last record stays last among its equals).
pub struct CcdByCli {
    sorted: Vec<Arc<CcdSessionMeta>>,
}

impl CcdByCli {
    fn build(records: &[Arc<CcdSessionMeta>]) -> CcdByCli {
        let mut sorted: Vec<Arc<CcdSessionMeta>> = records.iter().filter(|r| r.cli_session_id().map_or(false, |c| !c.is_empty())).cloned().collect();
        sorted.sort_by(|a, b| a.cli_session_id().cmp(&b.cli_session_id()));
        CcdByCli { sorted }
    }

    /// The record for a CLI session id.
    pub fn get(&self, cli: &str) -> Option<&Arc<CcdSessionMeta>> {
        let key = Some(cli.as_bytes());
        let end = self.sorted.partition_point(|r| r.cli_session_id() <= key);
        let r = self.sorted.get(end.checked_sub(1)?)?;
        if r.cli_session_id() == key {
            Some(r)
        } else {
            None
        }
    }
}

struct CcdIndex {
    dir: Option<String>,
    paths: DirTable,
    index: IndexMap<PathKey, IndexedFile>,
    /// Keyed by the org directory's number in `paths`.
    org_dirs: IndexMap<u32, OrgDirListing>,
    records: Arc<Vec<Arc<CcdSessionMeta>>>,
    version: u64,
    last_refresh_ms: f64,
    last_full_stat_ms: f64,
    by_cli: Option<(u64, Arc<CcdByCli>)>,
    load_done: bool,
    saved_version: u64,
    last_save_ms: f64,
    /// The saved file's size, to size the next save's buffer.
    last_save_len: usize,
}

fn global() -> MutexGuard<'static, CcdIndex> {
    static INDEX: OnceLock<Mutex<CcdIndex>> = OnceLock::new();
    INDEX
        .get_or_init(|| {
            Mutex::new(CcdIndex {
                dir: ccd_sessions_dir(),
                paths: DirTable::default(),
                index: IndexMap::new(),
                org_dirs: IndexMap::new(),
                records: Arc::new(Vec::new()),
                version: 0,
                last_refresh_ms: f64::NEG_INFINITY,
                last_full_stat_ms: f64::NEG_INFINITY,
                by_cli: None,
                load_done: false,
                saved_version: 0,
                last_save_ms: f64::NEG_INFINITY,
                last_save_len: 0,
            })
        })
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn is_session_file(name: &str) -> bool {
    name.starts_with("local_") && name.ends_with(".json")
}

/// `<store>/<accountId>/<orgId>` for every account and org on disk.
fn list_org_dirs(dir: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let accounts = match fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>(),
        Err(_) => return out,
    };
    for acc in accounts {
        if acc.starts_with('.') {
            continue;
        }
        let acc_path = join(dir, &acc);
        for org in readdir_safe(Path::new(&acc_path)) {
            if org.starts_with('.') {
                continue;
            }
            out.push(join(&acc_path, &org));
        }
    }
    out
}

impl CcdIndex {
    fn reset(&mut self) {
        self.index.clear();
        self.org_dirs.clear();
        self.records = Arc::new(Vec::new());
        self.by_cli = None;
    }

    fn rebuild_records(&mut self) {
        let next: Vec<Arc<CcdSessionMeta>> = self.index.values().filter_map(|e| e.record.clone()).collect();
        self.records = Arc::new(next);
    }

    fn index_path(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|_| hx_dir().join("ccd-index.json"))
    }

    /// Populate the maps from the saved file, once per process.
    fn load_saved_index(&mut self) {
        if self.load_done {
            return;
        }
        self.load_done = true;
        let (file, dir) = match (self.index_path(), self.dir.clone()) {
            (Some(f), Some(d)) => (f, d),
            _ => return,
        };
        let raw = match fs::read(&file) {
            Ok(b) => b,
            Err(_) => return,
        };
        let under = format!("{}/", dir);
        let saved = match parse_saved_index(&raw, under.as_bytes(), &mut self.paths) {
            Some(s) => s,
            None => return,
        };
        // The maps are empty here: the load comes before the first refresh.
        for (id, listing) in saved.dirs {
            if let Some(l) = listing {
                self.org_dirs.insert(id, l);
            }
        }
        for (p, f) in saved.files {
            if let Some(f) = f {
                self.index.insert(p, f);
            }
        }
        if self.index.is_empty() && self.org_dirs.is_empty() {
            return;
        }
        self.index.shrink_to_fit();
        self.rebuild_records();
        self.version = 1;
        self.saved_version = 1;
        self.last_full_stat_ms = f64::NEG_INFINITY;
        self.last_save_len = raw.len();
    }

    fn refresh_now(&mut self, now_ms: f64, full_stat: bool) {
        let dir = match self.dir.clone() {
            Some(d) => d,
            None => {
                if !self.index.is_empty() || !self.org_dirs.is_empty() {
                    self.reset();
                    self.version += 1;
                }
                self.last_refresh_ms = now_ms;
                return;
            }
        };
        let mut changed = false;
        let dirs = list_org_dirs(&dir);
        let mut seen: HashSet<u32> = HashSet::with_capacity(dirs.len());
        let mut to_stat: IndexSet<PathKey> = IndexSet::new();
        // Paths the directory pass drops, taken out of the index in one sweep
        // before the file pass (the client deletes them as it goes; nothing
        // between the two passes reads the index).
        let mut gone: HashSet<PathKey> = HashSet::new();
        for d in &dirs {
            let id = self.paths.intern(d.as_bytes());
            seen.insert(id);
            match stat_safe(Path::new(d)) {
                Some(s) if s.is_dir => {
                    if let Some(k) = self.org_dirs.get(&id) {
                        if k.mtime_ms == s.mtime_ms {
                            if full_stat {
                                for p in &k.files {
                                    to_stat.insert(p.clone());
                                }
                            }
                            continue;
                        }
                    }
                    let present: Vec<PathKey> = readdir_safe(Path::new(d)).into_iter().filter(|f| is_session_file(f)).map(|f| PathKey { dir: id, name: Arc::from(f.as_bytes()) }).collect();
                    if let Some(k) = self.org_dirs.get(&id) {
                        let present_set: HashSet<&PathKey> = present.iter().collect();
                        for p in &k.files {
                            if !present_set.contains(p) {
                                gone.insert(p.clone());
                            }
                        }
                    }
                    for p in &present {
                        to_stat.insert(p.clone());
                    }
                    self.org_dirs.insert(id, OrgDirListing { mtime_ms: s.mtime_ms, files: present });
                }
                _ => {
                    if let Some(k) = self.org_dirs.shift_remove(&id) {
                        gone.extend(k.files);
                    }
                }
            }
        }
        // An account or org dir that vanished takes its files with it.
        let vanished: Vec<u32> = self.org_dirs.keys().copied().filter(|d| !seen.contains(d)).collect();
        for d in vanished {
            if let Some(k) = self.org_dirs.shift_remove(&d) {
                gone.extend(k.files);
            }
        }
        if !gone.is_empty() {
            let before = self.index.len();
            self.index.retain(|k, _| !gone.contains(k));
            if self.index.len() != before {
                changed = true;
            }
        }
        let mut missing: HashSet<PathKey> = HashSet::new();
        for p in to_stat {
            let full = self.paths.path_string(&p);
            match stat_safe(Path::new(&full)) {
                Some(s) if !s.is_dir => {
                    let size = s.size as f64;
                    if let Some(k) = self.index.get(&p) {
                        if k.size == size && k.mtime_ms == s.mtime_ms {
                            continue;
                        }
                    }
                    let record = read_session_file(&full).map(Arc::new);
                    // An existing path keeps its place, as in a JavaScript Map.
                    self.index.insert(p, IndexedFile { size, mtime_ms: s.mtime_ms, record });
                    changed = true;
                }
                _ => {
                    if self.index.contains_key(&p) {
                        missing.insert(p);
                        changed = true;
                    }
                }
            }
        }
        if !missing.is_empty() {
            self.index.retain(|k, _| !missing.contains(k));
        }
        if full_stat {
            self.last_full_stat_ms = now_ms;
        }
        self.last_refresh_ms = now_ms;
        if changed {
            self.version += 1;
            self.rebuild_records();
        }
    }

    fn refresh(&mut self, now_ms: f64, force: bool) -> u64 {
        self.load_saved_index();
        if !force && now_ms - self.last_refresh_ms < CCD_REFRESH_TTL_MS {
            return self.version;
        }
        let full_stat = force || now_ms - self.last_full_stat_ms >= CCD_FULL_STAT_INTERVAL_MS;
        self.refresh_now(now_ms, full_stat);
        self.version
    }

    /// The saved index's text: `JSON.stringify({ v, savedAtMs, dirs, files })`
    /// of the client's maps, written in one pass.
    fn saved_text(&self, now_ms: f64) -> String {
        let mut out = String::with_capacity(self.last_save_len + self.last_save_len / 16 + 4096);
        out.push_str("{\"v\":1,\"savedAtMs\":");
        write_num(&mut out, now_ms);
        out.push_str(",\"dirs\":{");
        for (i, (id, listing)) in self.org_dirs.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            wtf8::write_json(&mut out, self.paths.get(*id));
            out.push_str(":{\"mtimeMs\":");
            write_num(&mut out, listing.mtime_ms);
            out.push_str(",\"files\":[");
            for (j, p) in listing.files.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                self.paths.write_json(&mut out, p);
            }
            out.push_str("]}");
        }
        out.push_str("},\"files\":{");
        for (i, (p, f)) in self.index.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            self.paths.write_json(&mut out, p);
            out.push_str(":{\"size\":");
            write_num(&mut out, f.size);
            out.push_str(",\"mtimeMs\":");
            write_num(&mut out, f.mtime_ms);
            out.push_str(",\"record\":");
            match &f.record {
                Some(r) => r.write_json(&mut out),
                None => out.push_str("null"),
            }
            out.push('}');
        }
        out.push_str("}}");
        out
    }
}

// ── The saved index, read ───────────────────────────────────────────────────

/// What `loadSavedIndex` takes from a saved file: every entry under the
/// store in the file's order, first place and last value for a path that
/// appears twice (as an object `JSON.parse` builds), None where the client
/// skips the entry.
struct SavedIndex {
    dirs: IndexMap<u32, Option<OrgDirListing>>,
    files: IndexMap<PathKey, Option<IndexedFile>>,
}

/// None where the client takes nothing from the file: not JSON, `v` not 1,
/// or `dirs` or `files` not objects (an array passes `typeof`, and gives no
/// entry under the store).
fn parse_saved_index(raw: &[u8], under: &[u8], paths: &mut DirTable) -> Option<SavedIndex> {
    let mut s = Scanner::new(raw);
    if s.peek() != Some(b'{') {
        return None;
    }
    let mut v_is_one = false;
    let mut dirs: Option<IndexMap<u32, Option<OrgDirListing>>> = None;
    let mut files: Option<IndexMap<PathKey, Option<IndexedFile>>> = None;
    s.object(|s, key| match key {
        b"v" => {
            v_is_one = matches!(s.val()?, Val::Num(n) if n == 1.0);
            Ok(())
        }
        b"dirs" => {
            dirs = saved_dirs(s, under, paths)?;
            Ok(())
        }
        b"files" => {
            files = saved_files(s, under, paths)?;
            Ok(())
        }
        _ => s.skip_value(),
    })
    .ok()?;
    if !s.at_end() || !v_is_one {
        return None;
    }
    Some(SavedIndex { dirs: dirs?, files: files? })
}

/// An object's or an array's entries under the store; None for any other value.
fn saved_dirs(s: &mut Scanner<'_>, under: &[u8], paths: &mut DirTable) -> Result<Option<IndexMap<u32, Option<OrgDirListing>>>, ()> {
    match s.peek() {
        Some(b'{') => {}
        Some(b'[') => return s.skip_value().map(|_| Some(IndexMap::new())),
        _ => return s.skip_value().map(|_| None),
    }
    let mut out: IndexMap<u32, Option<OrgDirListing>> = IndexMap::new();
    s.object(|s, key| {
        if !key.starts_with(under) {
            return s.skip_value();
        }
        let listing = saved_listing(s, paths)?;
        out.insert(paths.intern(key), listing);
        Ok(())
    })?;
    Ok(Some(out))
}

/// `{ mtimeMs: number, files: array }`, the array's strings kept.
fn saved_listing(s: &mut Scanner<'_>, paths: &mut DirTable) -> Result<Option<OrgDirListing>, ()> {
    if s.peek() != Some(b'{') {
        return s.skip_value().map(|_| None);
    }
    let mut mtime: Option<f64> = None;
    let mut files: Option<Vec<PathKey>> = None;
    s.object(|s, key| match key {
        b"mtimeMs" => {
            mtime = match s.val()? {
                Val::Num(n) => Some(n),
                _ => None,
            };
            Ok(())
        }
        b"files" => {
            if s.peek() != Some(b'[') {
                files = None;
                return s.skip_value();
            }
            let mut list: Vec<PathKey> = Vec::new();
            let mut buf: Vec<u8> = Vec::new();
            s.array(|s| {
                if s.peek() != Some(b'"') {
                    return s.skip_value();
                }
                buf.clear();
                s.string_into(&mut buf)?;
                list.push(paths.split(&buf));
                Ok(())
            })?;
            files = Some(list);
            Ok(())
        }
        _ => s.skip_value(),
    })?;
    Ok(match (mtime, files) {
        (Some(mtime_ms), Some(files)) => Some(OrgDirListing { mtime_ms, files }),
        _ => None,
    })
}

fn saved_files(s: &mut Scanner<'_>, under: &[u8], paths: &mut DirTable) -> Result<Option<IndexMap<PathKey, Option<IndexedFile>>>, ()> {
    match s.peek() {
        Some(b'{') => {}
        Some(b'[') => return s.skip_value().map(|_| Some(IndexMap::new())),
        _ => return s.skip_value().map(|_| None),
    }
    let mut out: IndexMap<PathKey, Option<IndexedFile>> = IndexMap::new();
    s.object(|s, key| {
        if !key.starts_with(under) {
            return s.skip_value();
        }
        let entry = saved_file(s)?;
        out.insert(paths.split(key), entry);
        Ok(())
    })?;
    Ok(Some(out))
}

/// `{ size: number, mtimeMs: number, record }`.
fn saved_file(s: &mut Scanner<'_>) -> Result<Option<IndexedFile>, ()> {
    if s.peek() != Some(b'{') {
        return s.skip_value().map(|_| None);
    }
    let mut size: Option<f64> = None;
    let mut mtime: Option<f64> = None;
    let mut record: Option<CcdSessionMeta> = None;
    s.object(|s, key| match key {
        b"size" => {
            size = match s.val()? {
                Val::Num(n) => Some(n),
                _ => None,
            };
            Ok(())
        }
        b"mtimeMs" => {
            mtime = match s.val()? {
                Val::Num(n) => Some(n),
                _ => None,
            };
            Ok(())
        }
        b"record" => {
            record = saved_record(s)?;
            Ok(())
        }
        _ => s.skip_value(),
    })?;
    Ok(match (size, mtime) {
        (Some(size), Some(mtime_ms)) => Some(IndexedFile { size, mtime_ms, record: record.map(Arc::new) }),
        _ => None,
    })
}

/// `isSavedRecord`: an object whose `ccdSessionId` is a string and whose
/// `cliSessionId` is null or a string, read the way the client writes one.
fn saved_record(s: &mut Scanner<'_>) -> Result<Option<CcdSessionMeta>, ()> {
    if s.peek() != Some(b'{') {
        return s.skip_value().map(|_| None);
    }
    let mut fields: [Option<Val>; 6] = Default::default();
    s.object(|s, key| {
        let slot = match key {
            b"ccdSessionId" => 0,
            b"cliSessionId" => 1,
            b"title" => 2,
            b"titleSource" => 3,
            b"isArchived" => 4,
            b"lastActivityAt" => 5,
            _ => return s.skip_value(),
        };
        fields[slot] = Some(s.val()?);
        Ok(())
    })?;
    let [ccd, cli, title, source, archived, last] = fields;
    let ccd = match ccd {
        Some(Val::Str(b)) => b,
        _ => return Ok(None),
    };
    let cli = match cli {
        Some(Val::Str(b)) => Some(b),
        Some(Val::Null) => None,
        _ => return Ok(None),
    };
    let title = match title {
        Some(Val::Str(b)) => Some(b),
        _ => None,
    };
    let source = match source {
        Some(Val::Str(b)) => title_source_of(&b),
        _ => None,
    };
    let last = match last {
        Some(Val::Num(n)) => n,
        _ => 0.0,
    };
    Ok(Some(CcdSessionMeta::new(&ccd, cli.as_deref(), title.as_deref(), source, matches!(archived, Some(Val::Bool(true))), last)))
}

// ── The API ─────────────────────────────────────────────────────────────────

/// Bring the index up to date if it is older than the TTL (or `force`); returns its version.
pub fn refresh_ccd_index(now_ms: f64, force: bool) -> u64 {
    global().refresh(now_ms, force)
}

/// Every record (archived included), at most CCD_REFRESH_TTL_MS stale.
pub fn read_ccd_recents_cached(now_ms: f64) -> Arc<Vec<Arc<CcdSessionMeta>>> {
    let mut g = global();
    g.refresh(now_ms, false);
    g.records.clone()
}

/// cliSessionId → Claude Desktop metadata, rebuilt only when the records changed.
pub fn get_ccd_recents_by_cli_id(now_ms: f64) -> Arc<CcdByCli> {
    let mut g = global();
    let version = g.refresh(now_ms, false);
    if let Some((v, map)) = &g.by_cli {
        if *v == version {
            return map.clone();
        }
    }
    let map = Arc::new(CcdByCli::build(&g.records));
    g.by_cli = Some((version, map.clone()));
    map
}

/// Write the index if it changed since the last save; `force` skips the
/// interval (the daemon's parting flush, the end of a one-shot pass).
pub fn save_ccd_index_if_changed(now_ms: f64, force: bool) -> bool {
    let mut g = global();
    let file = match (g.index_path(), g.dir.clone()) {
        (Some(f), Some(_)) => f,
        _ => return false,
    };
    if g.version == g.saved_version {
        return false;
    }
    if !force && now_ms - g.last_save_ms < CCD_INDEX_SAVE_INTERVAL_MS {
        return false;
    }
    if g.index.is_empty() && g.org_dirs.is_empty() {
        return false;
    }
    let text = g.saved_text(now_ms);
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if write_atomic_0600(&file, text.as_bytes()).is_err() {
        return false;
    }
    g.saved_version = g.version;
    g.last_save_ms = now_ms;
    g.last_save_len = text.len();
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_from(text: &str, under: &str) -> CcdIndex {
        let mut idx = CcdIndex {
            dir: Some(under.trim_end_matches('/').to_string()),
            paths: DirTable::default(),
            index: IndexMap::new(),
            org_dirs: IndexMap::new(),
            records: Arc::new(Vec::new()),
            version: 0,
            last_refresh_ms: f64::NEG_INFINITY,
            last_full_stat_ms: f64::NEG_INFINITY,
            by_cli: None,
            load_done: true,
            saved_version: 0,
            last_save_ms: f64::NEG_INFINITY,
            last_save_len: 0,
        };
        let saved = parse_saved_index(text.as_bytes(), under.as_bytes(), &mut idx.paths).expect("loads");
        for (id, l) in saved.dirs {
            if let Some(l) = l {
                idx.org_dirs.insert(id, l);
            }
        }
        for (p, f) in saved.files {
            if let Some(f) = f {
                idx.index.insert(p, f);
            }
        }
        idx.rebuild_records();
        idx
    }

    /// What JSON.stringify writes for the record readSessionFile builds.
    fn record_json(raw: &str) -> Option<String> {
        session_record(raw.as_bytes()).map(|r| {
            let mut s = String::new();
            r.write_json(&mut s);
            s
        })
    }

    const SAVED: &str = concat!(
        "{\"v\":1,\"savedAtMs\":1792180673041,\"dirs\":{\"/s/acct/org\":{\"mtimeMs\":1767603780128.4883,\"files\":[\"/s/acct/org/local_b.json\",\"/s/acct/org/local_a.json\"]}},",
        "\"files\":{\"/s/acct/org/local_a.json\":{\"size\":273,\"mtimeMs\":1767603600104.731,\"record\":{\"ccdSessionId\":\"local_a\",\"cliSessionId\":\"57be05c1\",\"title\":\"Pipeline \\\"review\\\" \\ud83d\\ude00 \\ud800\",\"titleSource\":\"user\",\"isArchived\":false,\"lastActivityAt\":1767607200000}},",
        "\"/s/acct/org/local_b.json\":{\"size\":280,\"mtimeMs\":1767603660112.65,\"record\":{\"ccdSessionId\":\"local_b\",\"cliSessionId\":null,\"title\":null,\"titleSource\":null,\"isArchived\":true,\"lastActivityAt\":0.5}},",
        "\"/s/acct/org/local_c.json\":{\"size\":2,\"mtimeMs\":1767603720120.569,\"record\":null}}}"
    );

    #[test]
    fn a_saved_index_is_written_back_byte_for_byte() {
        let idx = index_from(SAVED, "/s/");
        // The JSON.stringify of the same object, with this save's clock.
        let want = SAVED.replace("\"savedAtMs\":1792180673041", "\"savedAtMs\":1792180679999").replace("\\ud83d\\ude00", "😀");
        assert_eq!(idx.saved_text(1_792_180_679_999.0), want);
        assert_eq!(idx.records.len(), 2);
    }

    #[test]
    fn loading_follows_the_client_on_odd_files() {
        let under = "/s/";
        let mut paths = DirTable::default();
        for bad in ["", "[]", "null", "{\"v\":2,\"dirs\":{},\"files\":{}}", "{\"v\":1,\"dirs\":{}}", "{\"v\":1,\"dirs\":0,\"files\":{}}", "{\"v\":1,\"dirs\":\"x\",\"files\":{}}", "{\"v\":1,\"dirs\":{},\"files\":{} ", "{\"v\":1,\"dirs\":{},\"files\":{}} x"] {
            assert!(!parse_saved_index(bad.as_bytes(), under.as_bytes(), &mut paths).map(|s| !s.dirs.is_empty() || !s.files.is_empty()).unwrap_or(false), "{:?}", bad);
        }
        assert!(parse_saved_index(b"{\"v\":1,\"dirs\":{},\"files\":{} ", under.as_bytes(), &mut paths).is_none());
        // Arrays pass `typeof` and give no entries; paths outside the store
        // and entries of the wrong shape are skipped; the last of a
        // duplicated path counts, in the first one's place.
        let text = "{\"files\":{\"/s/a/local_1.json\":{\"size\":1,\"mtimeMs\":2,\"record\":null},\"/elsewhere/local_2.json\":{\"size\":1,\"mtimeMs\":2,\"record\":null},\"/s/a/local_3.json\":{\"size\":\"1\",\"mtimeMs\":2},\"/s/a/local_4.json\":{\"size\":4,\"mtimeMs\":4,\"record\":{\"ccdSessionId\":\"x\"}},\"/s/a/local_1.json\":{\"size\":9,\"mtimeMs\":9,\"record\":{\"ccdSessionId\":\"y\",\"cliSessionId\":null}}},\"dirs\":[],\"v\":1.0}";
        let saved = parse_saved_index(text.as_bytes(), under.as_bytes(), &mut paths).expect("loads");
        assert!(saved.dirs.is_empty());
        let kept: Vec<(String, f64, bool)> = saved.files.iter().filter_map(|(k, v)| v.as_ref().map(|f| (paths.path_string(k), f.size, f.record.is_some()))).collect();
        assert_eq!(kept, vec![("/s/a/local_1.json".to_string(), 9.0, true), ("/s/a/local_4.json".to_string(), 4.0, false)]);
    }

    #[test]
    fn a_session_file_reads_as_read_session_file_reads_it() {
        assert_eq!(
            record_json("{\"sessionId\":\"local_x\",\"cliSessionId\":\"c\",\"title\":\"T\",\"titleSource\":\"ai\",\"isArchived\":true,\"lastActivityAt\":5,\"cwd\":\"/w\",\"messages\":[{\"a\":[1,2,{}]}]}").as_deref(),
            Some("{\"ccdSessionId\":\"local_x\",\"cliSessionId\":\"c\",\"title\":\"T\",\"titleSource\":\"ai\",\"isArchived\":true,\"lastActivityAt\":5}")
        );
        // Wrong types fall back the way the client's typeof checks do; a
        // blank title is null; the last of a duplicated key counts.
        assert_eq!(
            record_json("{\"sessionId\":\"a\",\"sessionId\":\"local_y\",\"cliSessionId\":5,\"title\":\" \\u3000 \",\"titleSource\":\"robot\",\"isArchived\":\"true\",\"lastActivityAt\":\"9\"}").as_deref(),
            Some("{\"ccdSessionId\":\"local_y\",\"cliSessionId\":null,\"title\":null,\"titleSource\":null,\"isArchived\":false,\"lastActivityAt\":0}")
        );
        assert_eq!(record_json("{\"cliSessionId\":\"c\"}"), None);
        assert_eq!(record_json("[{\"sessionId\":\"x\"}]"), None);
        assert_eq!(record_json("{\"sessionId\":\"x\"} trailing"), None);
        assert_eq!(record_json("{\"sessionId\":\"x\",}"), None);
    }

    #[test]
    fn by_cli_keeps_the_last_record_per_id() {
        let r = |ccd: &str, cli: Option<&str>| Arc::new(CcdSessionMeta::new(ccd.as_bytes(), cli.map(|c| c.as_bytes()), None, None, false, 0.0));
        let records = vec![r("local_1", Some("b")), r("local_2", Some("a")), r("local_3", Some("b")), r("local_4", Some("")), r("local_5", None)];
        let m = CcdByCli::build(&records);
        assert_eq!(m.get("b").map(|x| x.ccd_session_id().to_vec()), Some(b"local_3".to_vec()));
        assert_eq!(m.get("a").map(|x| x.ccd_session_id().to_vec()), Some(b"local_2".to_vec()));
        assert!(m.get("").is_none());
        assert!(m.get("c").is_none());
    }
}
