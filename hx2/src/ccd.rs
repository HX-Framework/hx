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
//! and its flags, each id that is a canonical UUID packed to its 16 bytes; a
//! path is its directory, interned, and its file name (`local_<uuid>.json`
//! packed the same way), shared between the index and the directory's
//! listing; a record is shared between the index, the record list and the
//! cli-id lookup. The session files and the saved index are read by
//! scanning (jscan.rs), not into a JSON tree, the saved index from the file
//! mapped into memory, and it is written straight into its text. Every byte
//! of that text is what the client writes for the same index: the harness
//! compares the two files entry by entry.

use std::borrow::Cow;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use indexmap::{IndexMap, IndexSet};

use crate::fsutil::{join, readdir_safe, release_freed_memory, stat_safe, write_atomic_0600};
use crate::home::{homedir, hx_dir};
use crate::js::JsStr;
use crate::jscan::{Scanner, Val};
use crate::json::write_num;
use crate::wtf8;

pub const CCD_REFRESH_TTL_MS: f64 = 20_000.0;
pub const CCD_FULL_STAT_INTERVAL_MS: f64 = 60_000.0;
pub const CCD_INDEX_SAVE_INTERVAL_MS: f64 = 10.0 * 60_000.0;

/// Claude Desktop's per-user data directory, where it ships: under
/// `~/Library/Application Support` on macOS and %APPDATA% (Roaming) on
/// Windows, else nowhere.
pub fn ccd_app_dir() -> Option<String> {
    if cfg!(target_os = "macos") {
        return Some(homedir().join("Library").join("Application Support").join("Claude").to_string_lossy().into_owned());
    }
    if cfg!(windows) {
        return Some(ccd_app_dir_win32(std::env::var("APPDATA").ok().as_deref(), &homedir().to_string_lossy()));
    }
    None
}

/// `winPath.join(env.APPDATA || winPath.join(home, "AppData", "Roaming"), "Claude")`:
/// %APPDATA% is Roaming, and its canonical place stands in when it is unset.
fn ccd_app_dir_win32(appdata: Option<&str>, home: &str) -> String {
    let roaming = match appdata.filter(|v| !v.is_empty()) {
        Some(a) => a.to_string(),
        None => crate::winpath::join(&[home, "AppData", "Roaming"]),
    };
    crate::winpath::join(&[&roaming, "Claude"])
}

/// `<app data>/claude-code-sessions`.
pub fn ccd_sessions_dir() -> Option<String> {
    ccd_app_dir().map(|r| join(&r, "claude-code-sessions"))
}

/// `<app data>/Local Storage/leveldb`.
pub fn ccd_leveldb_dir() -> Option<String> {
    ccd_app_dir().map(|r| join(&join(&r, "Local Storage"), "leveldb"))
}

// ── Ids ─────────────────────────────────────────────────────────────────────

/// A canonical UUID — 8-4-4-4-12 lowercase hex digits, the way Claude Desktop
/// and Claude Code write every session id — as its 16 bytes. Only that one
/// spelling is packed, so unpacking gives the same text back, two packed ids
/// are equal exactly when their texts are, and they order as their texts do
/// (a lowercase hex digit sorts as its value).
type Uuid = [u8; 16];

const SESSION_PREFIX: &[u8] = b"local_";
const SESSION_SUFFIX: &[u8] = b".json";
const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

fn parse_uuid(b: &[u8]) -> Option<Uuid> {
    if b.len() != 36 {
        return None;
    }
    let mut out = [0u8; 16];
    let (mut i, mut j) = (0, 0);
    while i < 36 {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            if b[i] != b'-' {
                return None;
            }
            i += 1;
            continue;
        }
        out[j] = (hex_digit(b[i])? << 4) | hex_digit(b[i + 1])?;
        i += 2;
        j += 1;
    }
    Some(out)
}

fn push_uuid(out: &mut Vec<u8>, u: &Uuid) {
    for (k, byte) in u.iter().enumerate() {
        if k == 4 || k == 6 || k == 8 || k == 10 {
            out.push(b'-');
        }
        out.push(HEX[(byte >> 4) as usize]);
        out.push(HEX[(byte & 0xF) as usize]);
    }
}

fn uuid_text(u: &Uuid) -> [u8; 36] {
    let mut v = Vec::with_capacity(36);
    push_uuid(&mut v, u);
    let mut out = [0u8; 36];
    out.copy_from_slice(&v);
    out
}

/// An id as the index compares it: packed when it is a canonical UUID (with
/// the `local_` prefix for a Claude Desktop id), else its text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IdKey<'a> {
    Uuid(Uuid),
    Text(&'a [u8]),
}

/// The key of a `ccdSessionId` text.
pub fn ccd_id_key(b: &[u8]) -> IdKey<'_> {
    if b.len() == SESSION_PREFIX.len() + 36 && b.starts_with(SESSION_PREFIX) {
        if let Some(u) = parse_uuid(&b[SESSION_PREFIX.len()..]) {
            return IdKey::Uuid(u);
        }
    }
    IdKey::Text(b)
}

/// The key of a `cliSessionId` text.
fn cli_id_key(b: &[u8]) -> IdKey<'_> {
    match parse_uuid(b) {
        Some(u) => IdKey::Uuid(u),
        None => IdKey::Text(b),
    }
}

/// Two cli-id keys in the order of their texts.
fn cmp_cli(a: &IdKey<'_>, b: &IdKey<'_>) -> std::cmp::Ordering {
    match (a, b) {
        (IdKey::Uuid(x), IdKey::Uuid(y)) => x.cmp(y),
        (IdKey::Text(x), IdKey::Text(y)) => x.cmp(y),
        (IdKey::Uuid(x), IdKey::Text(y)) => uuid_text(x)[..].cmp(*y),
        (IdKey::Text(x), IdKey::Uuid(y)) => (*x).cmp(&uuid_text(y)[..]),
    }
}

// ── Records ─────────────────────────────────────────────────────────────────

const HAS_CLI: u16 = 1;
const HAS_TITLE: u16 = 2;
const ARCHIVED: u16 = 4;
const SOURCE_USER: u16 = 8;
const SOURCE_AI: u16 = 16;
/// `ccdSessionId` is `local_` and a canonical UUID, held as its 16 bytes.
const CCD_PACKED: u16 = 32;
/// `cliSessionId` is a canonical UUID, held as its 16 bytes.
const CLI_PACKED: u16 = 64;
const HAS_PARENT: u16 = 128;
/// `parentId` is `local_` and a canonical UUID, held as its 16 bytes.
const PARENT_PACKED: u16 = 256;

/// One session's metadata (`CcdSessionMeta` in ccd.ts): `ccdSessionId`,
/// `cliSessionId`, `parentId` and `title` one after another in one WTF-8
/// buffer, each id packed to 16 bytes when it is a canonical UUID, so a
/// record costs one small allocation for its text.
#[derive(Debug)]
pub struct CcdSessionMeta {
    text: Box<[u8]>,
    cli_at: u32,
    parent_at: u32,
    title_at: u32,
    flags: u16,
    last_activity_at: f64,
}

impl CcdSessionMeta {
    #[allow(clippy::too_many_arguments)]
    fn new(ccd: &[u8], cli: Option<&[u8]>, title: Option<&[u8]>, title_source: Option<&'static str>, is_archived: bool, last_activity_at: f64, parent: Option<&[u8]>) -> Self {
        let mut flags = 0u16;
        let ccd_key = ccd_id_key(ccd);
        let cli_key = cli.map(cli_id_key);
        let parent_key = parent.map(ccd_id_key);
        let len_of = |k: &IdKey<'_>| match k {
            IdKey::Uuid(_) => 16,
            IdKey::Text(t) => t.len(),
        };
        let mut text = Vec::with_capacity(len_of(&ccd_key) + cli_key.as_ref().map_or(0, len_of) + parent_key.as_ref().map_or(0, len_of) + title.map_or(0, |t| t.len()));
        match ccd_key {
            IdKey::Uuid(u) => {
                text.extend_from_slice(&u);
                flags |= CCD_PACKED;
            }
            IdKey::Text(t) => text.extend_from_slice(t),
        }
        let cli_at = text.len() as u32;
        if let Some(k) = cli_key {
            flags |= HAS_CLI;
            match k {
                IdKey::Uuid(u) => {
                    text.extend_from_slice(&u);
                    flags |= CLI_PACKED;
                }
                IdKey::Text(t) => text.extend_from_slice(t),
            }
        }
        let parent_at = text.len() as u32;
        if let Some(k) = parent_key {
            flags |= HAS_PARENT;
            match k {
                IdKey::Uuid(u) => {
                    text.extend_from_slice(&u);
                    flags |= PARENT_PACKED;
                }
                IdKey::Text(t) => text.extend_from_slice(t),
            }
        }
        let title_at = text.len() as u32;
        if let Some(t) = title {
            text.extend_from_slice(t);
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
        CcdSessionMeta { text: text.into_boxed_slice(), cli_at, parent_at, title_at, flags, last_activity_at }
    }

    fn packed(b: &[u8]) -> Uuid {
        let mut u = [0u8; 16];
        u.copy_from_slice(b);
        u
    }

    /// The key of `ccdSessionId`, without unpacking it.
    pub fn ccd_key(&self) -> IdKey<'_> {
        let raw = &self.text[..self.cli_at as usize];
        if self.flags & CCD_PACKED != 0 {
            IdKey::Uuid(Self::packed(raw))
        } else {
            IdKey::Text(raw)
        }
    }

    /// The key of `cliSessionId`, without unpacking it; None for null.
    fn cli_key(&self) -> Option<IdKey<'_>> {
        if self.flags & HAS_CLI == 0 {
            return None;
        }
        let raw = &self.text[self.cli_at as usize..self.parent_at as usize];
        Some(if self.flags & CLI_PACKED != 0 { IdKey::Uuid(Self::packed(raw)) } else { IdKey::Text(raw) })
    }

    /// The key of `parentId`, without unpacking it; None for null.
    pub fn parent_key(&self) -> Option<IdKey<'_>> {
        if self.flags & HAS_PARENT == 0 {
            return None;
        }
        let raw = &self.text[self.parent_at as usize..self.title_at as usize];
        Some(if self.flags & PARENT_PACKED != 0 { IdKey::Uuid(Self::packed(raw)) } else { IdKey::Text(raw) })
    }

    /// `parentId`, WTF-8; None for null.
    pub fn parent_id(&self) -> Option<Cow<'_, [u8]>> {
        Some(match self.parent_key()? {
            IdKey::Uuid(u) => {
                let mut v = Vec::with_capacity(SESSION_PREFIX.len() + 36);
                v.extend_from_slice(SESSION_PREFIX);
                push_uuid(&mut v, &u);
                Cow::Owned(v)
            }
            IdKey::Text(t) => Cow::Borrowed(t),
        })
    }

    /// `parentId` as the client holds it, in UTF-16 code units.
    pub fn parent_id_units(&self) -> Option<JsStr> {
        self.parent_id().map(|p| wtf8::to_units(&p))
    }

    /// `if (r.cliSessionId)`: a cli id that is there and not empty.
    pub fn has_cli_id(&self) -> bool {
        match self.cli_key() {
            Some(IdKey::Uuid(_)) => true,
            Some(IdKey::Text(t)) => !t.is_empty(),
            None => false,
        }
    }

    /// `ccdSessionId`, WTF-8.
    pub fn ccd_session_id(&self) -> Cow<'_, [u8]> {
        match self.ccd_key() {
            IdKey::Uuid(u) => {
                let mut v = Vec::with_capacity(SESSION_PREFIX.len() + 36);
                v.extend_from_slice(SESSION_PREFIX);
                push_uuid(&mut v, &u);
                Cow::Owned(v)
            }
            IdKey::Text(t) => Cow::Borrowed(t),
        }
    }

    /// `cliSessionId`, WTF-8; None for null.
    pub fn cli_session_id(&self) -> Option<Cow<'_, [u8]>> {
        Some(match self.cli_key()? {
            IdKey::Uuid(u) => Cow::Owned(uuid_text(&u).to_vec()),
            IdKey::Text(t) => Cow::Borrowed(t),
        })
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
        wtf8::to_units(&self.ccd_session_id())
    }

    /// `cliSessionId` as the client holds it, in UTF-16 code units.
    pub fn cli_session_id_units(&self) -> Option<JsStr> {
        self.cli_session_id().map(|c| wtf8::to_units(&c))
    }

    /// The record as `JSON.stringify` writes the client's object.
    fn write_json(&self, out: &mut String) {
        out.push_str("{\"ccdSessionId\":");
        wtf8::write_json(out, &self.ccd_session_id());
        out.push_str(",\"cliSessionId\":");
        match self.cli_session_id() {
            Some(c) => wtf8::write_json(out, &c),
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
        out.push_str(",\"parentId\":");
        match self.parent_id() {
            Some(p) => wtf8::write_json(out, &p),
            None => out.push_str("null"),
        }
        out.push('}');
    }
}

/// `!value` in JavaScript, for a value `JSON.parse` gives: false, null, 0
/// and "" are falsy, and so is a key that is not there.
fn js_truthy(v: &Option<Val>) -> bool {
    match v {
        None | Some(Val::Null) => false,
        Some(Val::Bool(b)) => *b,
        Some(Val::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(Val::Str(s)) => !s.is_empty(),
        Some(Val::Arr) | Some(Val::Obj) => true,
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
    // `spawnedFrom.sessionId` when a string, and `spawnedFrom.sideSession === true`.
    let mut spawned_id: Option<Vec<u8>> = None;
    let mut spawned_side = false;
    let mut detached: Option<Val> = None;
    s.object(|s, key| {
        let slot = match key {
            b"sessionId" => 0,
            b"cliSessionId" => 1,
            b"title" => 2,
            b"titleSource" => 3,
            b"isArchived" => 4,
            b"lastActivityAt" => 5,
            b"spawnedFrom" => {
                // The last `spawnedFrom` counts, as in JSON.parse; an array or
                // any other value names no parent.
                spawned_id = None;
                spawned_side = false;
                if s.peek() != Some(b'{') {
                    return s.skip_value();
                }
                return s.object(|s, k| match k {
                    b"sessionId" => {
                        spawned_id = match s.val()? {
                            Val::Str(b) => Some(b),
                            _ => None,
                        };
                        Ok(())
                    }
                    b"sideSession" => {
                        spawned_side = matches!(s.val()?, Val::Bool(true));
                        Ok(())
                    }
                    _ => s.skip_value(),
                });
            }
            b"lineageDetached" => {
                detached = Some(s.val()?);
                return Ok(());
            }
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
    // A side session whose lineage is not detached: the session it is drawn under.
    let parent = match spawned_id {
        Some(p) if spawned_side && !p.is_empty() && !js_truthy(&detached) => Some(p),
        _ => None,
    };
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
    Some(CcdSessionMeta::new(&ccd, cli.as_deref(), title.as_deref(), source, matches!(archived, Some(Val::Bool(true))), last, parent.as_deref()))
}

// ── Paths ───────────────────────────────────────────────────────────────────

/// The directory part of a path with no separator in it.
const NO_DIR: u32 = u32::MAX;

/// The separator `path.join` puts between a directory and a name: the
/// client builds every path in the index with it, so the saved index holds
/// `\` on Windows.
const SEP: u8 = if cfg!(windows) { b'\\' } else { b'/' };

/// A file name in the index: `local_<uuid>.json` with a canonical UUID
/// packed to its 16 bytes, any other name as its WTF-8 text, shared between
/// the index and its directory's listing (a saved index can name any string).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Name {
    Session(Uuid),
    Other(Arc<[u8]>),
}

impl Name {
    fn of(b: &[u8]) -> Name {
        let n = SESSION_PREFIX.len();
        if b.len() == n + 36 + SESSION_SUFFIX.len() && b.starts_with(SESSION_PREFIX) && b.ends_with(SESSION_SUFFIX) {
            if let Some(u) = parse_uuid(&b[n..n + 36]) {
                return Name::Session(u);
            }
        }
        Name::Other(Arc::from(b))
    }

    fn push_to(&self, out: &mut Vec<u8>) {
        match self {
            Name::Session(u) => {
                out.extend_from_slice(SESSION_PREFIX);
                push_uuid(out, u);
                out.extend_from_slice(SESSION_SUFFIX);
            }
            Name::Other(b) => out.extend_from_slice(b),
        }
    }
}

/// A path in the index: its directory, interned (a store has a handful),
/// and its file name.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PathKey {
    dir: u32,
    name: Name,
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

    /// A whole path, split at its last separator.
    fn split(&mut self, full: &[u8]) -> PathKey {
        match full.iter().rposition(|&c| c == SEP) {
            Some(at) => PathKey { dir: self.intern(&full[..at]), name: Name::of(&full[at + 1..]) },
            None => PathKey { dir: NO_DIR, name: Name::of(full) },
        }
    }

    /// The whole path, WTF-8.
    fn path_bytes(&self, k: &PathKey, out: &mut Vec<u8>) {
        out.clear();
        if k.dir != NO_DIR {
            out.extend_from_slice(self.get(k.dir));
            out.push(SEP);
        }
        k.name.push_to(out);
    }

    /// The path as the operating system is handed it.
    fn path_string(&self, k: &PathKey) -> String {
        let mut b = Vec::new();
        self.path_bytes(k, &mut b);
        wtf8::lossy(&b).into_owned()
    }

    /// The path as `JSON.stringify` writes it; `scratch` is a buffer to reuse.
    fn write_json(&self, out: &mut String, k: &PathKey, scratch: &mut Vec<u8>) {
        self.path_bytes(k, scratch);
        wtf8::write_json(out, scratch);
    }
}

// ── The saved file's bytes ──────────────────────────────────────────────────

/// The saved index's bytes for one parse. Where the platform can, they are
/// the file mapped read-only: its tens of megabytes on a long-lived machine
/// are then the file's own clean pages, gone the moment the map is, never a
/// heap buffer the allocator may keep after the load. hx and hx2 replace the
/// file by writing a temporary one and renaming it, never in place, so the
/// mapped file cannot shrink under the parse.
enum SavedBytes {
    #[cfg(unix)]
    Mapped { ptr: *mut libc::c_void, len: usize },
    Read(Vec<u8>),
}

impl SavedBytes {
    fn open(path: &Path) -> Option<SavedBytes> {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            if let Ok(f) = fs::File::open(path) {
                if let Ok(m) = f.metadata() {
                    let len = m.len() as usize;
                    if m.is_file() && len > 0 {
                        // SAFETY: a fresh read-only private mapping of an open
                        // file; unmapped once, in drop.
                        let ptr = unsafe { libc::mmap(std::ptr::null_mut(), len, libc::PROT_READ, libc::MAP_PRIVATE, f.as_raw_fd(), 0) };
                        if ptr != libc::MAP_FAILED {
                            return Some(SavedBytes::Mapped { ptr, len });
                        }
                    }
                }
            }
        }
        fs::read(path).ok().map(SavedBytes::Read)
    }

    fn bytes(&self) -> &[u8] {
        match self {
            #[cfg(unix)]
            // SAFETY: the mapping is `len` readable bytes until drop.
            SavedBytes::Mapped { ptr, len } => unsafe { std::slice::from_raw_parts(*ptr as *const u8, *len) },
            SavedBytes::Read(v) => v.as_slice(),
        }
    }
}

impl Drop for SavedBytes {
    fn drop(&mut self) {
        match self {
            #[cfg(unix)]
            // SAFETY: the mapping made in open, unmapped once.
            SavedBytes::Mapped { ptr, len } => unsafe {
                libc::munmap(*ptr, *len);
            },
            SavedBytes::Read(_) => {}
        }
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
        let mut sorted: Vec<Arc<CcdSessionMeta>> = records.iter().filter(|r| r.has_cli_id()).cloned().collect();
        sorted.sort_by(|a, b| match (a.cli_key(), b.cli_key()) {
            (Some(x), Some(y)) => cmp_cli(&x, &y),
            _ => std::cmp::Ordering::Equal,
        });
        CcdByCli { sorted }
    }

    /// The record for a CLI session id.
    pub fn get(&self, cli: &str) -> Option<&Arc<CcdSessionMeta>> {
        let q = cli_id_key(cli.as_bytes());
        let end = self.sorted.partition_point(|r| r.cli_key().map_or(true, |k| cmp_cli(&k, &q) != std::cmp::Ordering::Greater));
        let r = self.sorted.get(end.checked_sub(1)?)?;
        if r.cli_key().map_or(false, |k| cmp_cli(&k, &q) == std::cmp::Ordering::Equal) {
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
        let bytes = match SavedBytes::open(&file) {
            Some(b) => b,
            None => return,
        };
        let under = format!("{}{}", dir, SEP as char);
        let saved = parse_saved_index(bytes.bytes(), under.as_bytes(), &mut self.paths);
        let len = bytes.bytes().len();
        drop(bytes);
        if let Some(saved) = saved {
            self.adopt_saved(saved, len);
        }
        // The load's scratch — the parse's maps, the strings it decoded —
        // goes back to the system now, not whenever the allocator gets to it.
        release_freed_memory();
    }

    /// The parsed saved index as this process's index. The maps are empty
    /// here: the load comes before the first refresh.
    fn adopt_saved(&mut self, saved: SavedIndex, len: usize) {
        for (id, listing) in saved.dirs {
            if let Some(l) = listing {
                self.org_dirs.insert(id, l);
            }
        }
        let n = saved.files.values().filter(|f| f.is_some()).count();
        let mut index: IndexMap<PathKey, IndexedFile> = IndexMap::with_capacity(n);
        for (p, f) in saved.files {
            if let Some(f) = f {
                index.insert(p, f);
            }
        }
        self.index = index;
        if self.index.is_empty() && self.org_dirs.is_empty() {
            return;
        }
        self.rebuild_records();
        self.version = 1;
        self.saved_version = 1;
        self.last_full_stat_ms = f64::NEG_INFINITY;
        self.last_save_len = len;
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
        // A store can hold tens of thousands of files, read under the index
        // lock every upload waits on; each directory and file beats, as hx's
        // awaited reads let its event loop beat (watchdog.rs).
        for d in &dirs {
            crate::watchdog::beat();
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
                    let mut present: Vec<PathKey> = readdir_safe(Path::new(d)).into_iter().filter(|f| is_session_file(f)).map(|f| PathKey { dir: id, name: Name::of(f.as_bytes()) }).collect();
                    present.shrink_to_fit();
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
            crate::watchdog::beat();
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

    /// `fresh` skips the TTL but keeps the dir-mtime gate; `force` also
    /// re-stats every file.
    fn refresh(&mut self, now_ms: f64, force: bool, fresh: bool) -> u64 {
        self.load_saved_index();
        if !force && !fresh && now_ms - self.last_refresh_ms < CCD_REFRESH_TTL_MS {
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
        let mut scratch: Vec<u8> = Vec::new();
        out.push_str("{\"v\":2,\"savedAtMs\":");
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
                self.paths.write_json(&mut out, p, &mut scratch);
            }
            out.push_str("]}");
        }
        out.push_str("},\"files\":{");
        for (i, (p, f)) in self.index.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            self.paths.write_json(&mut out, p, &mut scratch);
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

/// None where the client takes nothing from the file: not JSON, `v` not 2 (each record's `parentId` came with format 2),
/// or `dirs` or `files` not objects (an array passes `typeof`, and gives no
/// entry under the store).
fn parse_saved_index(raw: &[u8], under: &[u8], paths: &mut DirTable) -> Option<SavedIndex> {
    let mut s = Scanner::new(raw);
    if s.peek() != Some(b'{') {
        return None;
    }
    let mut v_ok = false;
    let mut dirs: Option<IndexMap<u32, Option<OrgDirListing>>> = None;
    let mut files: Option<IndexMap<PathKey, Option<IndexedFile>>> = None;
    s.object(|s, key| match key {
        b"v" => {
            v_ok = matches!(s.val()?, Val::Num(n) if n == 2.0);
            Ok(())
        }
        b"dirs" => {
            dirs = saved_dirs(s, under, paths)?;
            Ok(())
        }
        b"files" => {
            // A saved entry is a few hundred bytes: size the map once.
            files = saved_files(s, under, paths, raw.len() / 512)?;
            Ok(())
        }
        _ => s.skip_value(),
    })
    .ok()?;
    if !s.at_end() || !v_ok {
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
            list.shrink_to_fit();
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

fn saved_files(s: &mut Scanner<'_>, under: &[u8], paths: &mut DirTable, capacity: usize) -> Result<Option<IndexMap<PathKey, Option<IndexedFile>>>, ()> {
    match s.peek() {
        Some(b'{') => {}
        Some(b'[') => return s.skip_value().map(|_| Some(IndexMap::new())),
        _ => return s.skip_value().map(|_| None),
    }
    let mut out: IndexMap<PathKey, Option<IndexedFile>> = IndexMap::with_capacity(capacity);
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
    let mut fields: [Option<Val>; 7] = Default::default();
    s.object(|s, key| {
        let slot = match key {
            b"ccdSessionId" => 0,
            b"cliSessionId" => 1,
            b"title" => 2,
            b"titleSource" => 3,
            b"isArchived" => 4,
            b"lastActivityAt" => 5,
            b"parentId" => 6,
            _ => return s.skip_value(),
        };
        fields[slot] = Some(s.val()?);
        Ok(())
    })?;
    let [ccd, cli, title, source, archived, last, parent] = fields;
    let parent = match parent {
        Some(Val::Str(b)) => Some(b),
        _ => None,
    };
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
    Ok(Some(CcdSessionMeta::new(&ccd, cli.as_deref(), title.as_deref(), source, matches!(archived, Some(Val::Bool(true))), last, parent.as_deref())))
}

// ── The API ─────────────────────────────────────────────────────────────────

/// Bring the index up to date if it is older than the TTL (or `force`); returns its version.
#[allow(dead_code)]
pub fn refresh_ccd_index(now_ms: f64, force: bool) -> u64 {
    global().refresh(now_ms, force, false)
}

/// `refreshCcdIndex(nowMs, { fresh: true })`: skip the TTL, keep the
/// dir-mtime gate (only the directories that moved are re-listed).
pub fn refresh_ccd_index_fresh(now_ms: f64) -> u64 {
    global().refresh(now_ms, false, true)
}

/// `ccdRecordsInScope`: the records of one account's sessions, the files
/// under `<store>/<accountId>/<orgId>/` for a scope key `<accountId>/<orgId>`,
/// as of the index's last refresh. A key that is not exactly two plain path
/// segments names no account.
pub fn ccd_records_in_scope(scope_key: &str) -> Vec<Arc<CcdSessionMeta>> {
    let g = global();
    let dir = match g.dir.as_ref() {
        Some(d) => d.clone(),
        None => return Vec::new(),
    };
    let parts: Vec<&str> = scope_key.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains('\\')) {
        return Vec::new();
    }
    let org = join(&join(&dir, parts[0]), parts[1]);
    let id = match g.paths.dirs.get_index_of(org.as_bytes()) {
        Some(i) => i as u32,
        None => return Vec::new(),
    };
    g.index.iter().filter(|(k, _)| k.dir == id).filter_map(|(_, f)| f.record.clone()).collect()
}

/// Every record (archived included), at most CCD_REFRESH_TTL_MS stale.
pub fn read_ccd_recents_cached(now_ms: f64) -> Arc<Vec<Arc<CcdSessionMeta>>> {
    let mut g = global();
    g.refresh(now_ms, false, false);
    g.records.clone()
}

/// cliSessionId → Claude Desktop metadata, rebuilt only when the records changed.
pub fn get_ccd_recents_by_cli_id(now_ms: f64) -> Arc<CcdByCli> {
    let mut g = global();
    let version = g.refresh(now_ms, false, false);
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

    /// A test path with the platform's separator, as `path.join` writes it.
    fn os_path(s: &str) -> String {
        s.replace('/', &(SEP as char).to_string())
    }

    /// `os_path` inside JSON text, where a backslash is written escaped.
    fn os_path_json(s: &str) -> String {
        if SEP == b'/' {
            s.to_string()
        } else {
            s.replace('/', "\\\\")
        }
    }

    fn index_from(text: &str, under: &str) -> CcdIndex {
        let mut idx = CcdIndex {
            dir: Some(under.trim_end_matches(SEP as char).to_string()),
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
        "{\"v\":2,\"savedAtMs\":1792180673041,\"dirs\":{\"/s/acct/org\":{\"mtimeMs\":1767603780128.4883,\"files\":[\"/s/acct/org/local_b.json\",\"/s/acct/org/local_a.json\"]}},",
        "\"files\":{\"/s/acct/org/local_a.json\":{\"size\":273,\"mtimeMs\":1767603600104.731,\"record\":{\"ccdSessionId\":\"local_a\",\"cliSessionId\":\"57be05c1\",\"title\":\"Pipeline \\\"review\\\" \\ud83d\\ude00 \\ud800\",\"titleSource\":\"user\",\"isArchived\":false,\"lastActivityAt\":1767607200000,\"parentId\":\"local_p\"}},",
        "\"/s/acct/org/local_b.json\":{\"size\":280,\"mtimeMs\":1767603660112.65,\"record\":{\"ccdSessionId\":\"local_b\",\"cliSessionId\":null,\"title\":null,\"titleSource\":null,\"isArchived\":true,\"lastActivityAt\":0.5,\"parentId\":null}},",
        "\"/s/acct/org/local_c.json\":{\"size\":2,\"mtimeMs\":1767603720120.569,\"record\":null}}}"
    );

    #[test]
    fn a_saved_index_is_written_back_byte_for_byte() {
        let saved = os_path_json(SAVED);
        let idx = index_from(&saved, &os_path("/s/"));
        // The JSON.stringify of the same object, with this save's clock.
        let want = saved.replace("\"savedAtMs\":1792180673041", "\"savedAtMs\":1792180679999").replace("\\ud83d\\ude00", "😀");
        assert_eq!(idx.saved_text(1_792_180_679_999.0), want);
        assert_eq!(idx.records.len(), 2);
    }

    #[test]
    fn loading_follows_the_client_on_odd_files() {
        let under = os_path("/s/");
        let mut paths = DirTable::default();
        for bad in ["", "[]", "null", "{\"v\":1,\"dirs\":{},\"files\":{}}", "{\"v\":2,\"dirs\":{}}", "{\"v\":2,\"dirs\":0,\"files\":{}}", "{\"v\":2,\"dirs\":\"x\",\"files\":{}}", "{\"v\":2,\"dirs\":{},\"files\":{} ", "{\"v\":2,\"dirs\":{},\"files\":{}} x"] {
            assert!(!parse_saved_index(bad.as_bytes(), under.as_bytes(), &mut paths).map(|s| !s.dirs.is_empty() || !s.files.is_empty()).unwrap_or(false), "{:?}", bad);
        }
        assert!(parse_saved_index(b"{\"v\":2,\"dirs\":{},\"files\":{} ", under.as_bytes(), &mut paths).is_none());
        // Format 1, from before records carried their parent, is not loaded.
        assert!(parse_saved_index(b"{\"v\":1,\"dirs\":{},\"files\":{}}", under.as_bytes(), &mut paths).is_none());
        // Arrays pass `typeof` and give no entries; paths outside the store
        // and entries of the wrong shape are skipped; the last of a
        // duplicated path counts, in the first one's place.
        let text = os_path_json("{\"files\":{\"/s/a/local_1.json\":{\"size\":1,\"mtimeMs\":2,\"record\":null},\"/elsewhere/local_2.json\":{\"size\":1,\"mtimeMs\":2,\"record\":null},\"/s/a/local_3.json\":{\"size\":\"1\",\"mtimeMs\":2},\"/s/a/local_4.json\":{\"size\":4,\"mtimeMs\":4,\"record\":{\"ccdSessionId\":\"x\"}},\"/s/a/local_1.json\":{\"size\":9,\"mtimeMs\":9,\"record\":{\"ccdSessionId\":\"y\",\"cliSessionId\":null}}},\"dirs\":[],\"v\":2.0}");
        let saved = parse_saved_index(text.as_bytes(), under.as_bytes(), &mut paths).expect("loads");
        assert!(saved.dirs.is_empty());
        let kept: Vec<(String, f64, bool)> = saved.files.iter().filter_map(|(k, v)| v.as_ref().map(|f| (paths.path_string(k), f.size, f.record.is_some()))).collect();
        assert_eq!(kept, vec![(os_path("/s/a/local_1.json"), 9.0, true), (os_path("/s/a/local_4.json"), 4.0, false)]);
    }

    #[test]
    fn a_session_file_reads_as_read_session_file_reads_it() {
        assert_eq!(
            record_json("{\"sessionId\":\"local_x\",\"cliSessionId\":\"c\",\"title\":\"T\",\"titleSource\":\"ai\",\"isArchived\":true,\"lastActivityAt\":5,\"cwd\":\"/w\",\"messages\":[{\"a\":[1,2,{}]}]}").as_deref(),
            Some("{\"ccdSessionId\":\"local_x\",\"cliSessionId\":\"c\",\"title\":\"T\",\"titleSource\":\"ai\",\"isArchived\":true,\"lastActivityAt\":5,\"parentId\":null}")
        );
        // Wrong types fall back the way the client's typeof checks do; a
        // blank title is null; the last of a duplicated key counts.
        assert_eq!(
            record_json("{\"sessionId\":\"a\",\"sessionId\":\"local_y\",\"cliSessionId\":5,\"title\":\" \\u3000 \",\"titleSource\":\"robot\",\"isArchived\":\"true\",\"lastActivityAt\":\"9\"}").as_deref(),
            Some("{\"ccdSessionId\":\"local_y\",\"cliSessionId\":null,\"title\":null,\"titleSource\":null,\"isArchived\":false,\"lastActivityAt\":0,\"parentId\":null}")
        );
        // A side session names its parent; a detached lineage, a spawn that
        // is not a side session, or a sessionId that is not a string do not.
        let parent = |extra: &str| -> Option<String> {
            let j = record_json(&format!("{{\"sessionId\":\"local_s\"{}}}", extra))?;
            let at = j.find("\"parentId\":")? + "\"parentId\":".len();
            Some(j[at..j.len() - 1].to_string())
        };
        assert_eq!(parent(",\"spawnedFrom\":{\"sessionId\":\"local_p\",\"taskId\":\"t\",\"sideSession\":true}").as_deref(), Some("\"local_p\""));
        assert_eq!(parent(",\"spawnedFrom\":{\"sessionId\":\"local_p\",\"sideSession\":true},\"lineageDetached\":true").as_deref(), Some("null"));
        assert_eq!(parent(",\"spawnedFrom\":{\"sessionId\":\"local_p\",\"sideSession\":true},\"lineageDetached\":0").as_deref(), Some("\"local_p\""));
        assert_eq!(parent(",\"spawnedFrom\":{\"sessionId\":\"local_p\",\"sideSession\":true},\"lineageDetached\":\"yes\"").as_deref(), Some("null"));
        assert_eq!(parent(",\"spawnedFrom\":{\"sessionId\":\"local_p\",\"taskId\":\"t\"}").as_deref(), Some("null"));
        assert_eq!(parent(",\"spawnedFrom\":{\"sessionId\":5,\"sideSession\":true}").as_deref(), Some("null"));
        assert_eq!(parent(",\"spawnedFrom\":{\"sessionId\":\"\",\"sideSession\":true}").as_deref(), Some("null"));
        assert_eq!(parent(",\"spawnedFrom\":[{\"sessionId\":\"local_p\",\"sideSession\":true}]").as_deref(), Some("null"));
        // The last of a duplicated key counts, inside spawnedFrom and around it.
        assert_eq!(parent(",\"spawnedFrom\":{\"sessionId\":\"local_p\",\"sideSession\":true,\"sideSession\":false}").as_deref(), Some("null"));
        assert_eq!(parent(",\"spawnedFrom\":{\"sessionId\":\"local_p\",\"sideSession\":true},\"spawnedFrom\":null").as_deref(), Some("null"));
        assert_eq!(record_json("{\"cliSessionId\":\"c\"}"), None);
        assert_eq!(record_json("[{\"sessionId\":\"x\"}]"), None);
        assert_eq!(record_json("{\"sessionId\":\"x\"} trailing"), None);
        assert_eq!(record_json("{\"sessionId\":\"x\",}"), None);
    }

    #[test]
    fn the_saved_file_is_read_whole() {
        let dir = std::env::temp_dir().join(format!("hx2-ccd-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("ccd-index.json");
        fs::write(&p, SAVED).unwrap();
        assert_eq!(SavedBytes::open(&p).map(|b| b.bytes().to_vec()), Some(SAVED.as_bytes().to_vec()));
        fs::write(&p, "").unwrap();
        assert_eq!(SavedBytes::open(&p).map(|b| b.bytes().len()), Some(0));
        assert!(SavedBytes::open(&dir.join("absent.json")).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn packed_ids_and_names_give_their_text_back() {
        let canon = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
        // Canonical: packed. Anything else — upper case, braces, no dashes,
        // a wrong length, a lone surrogate — stays as its text.
        let others = ["0F1E2D3C-4B5A-6978-8A9B-0C1D2E3F4A5B", "{0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b}", "0f1e2d3c4b5a69788a9b0c1d2e3f4a5b", "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5", "0f1e2d3c-4b5a-6978-8a9b_0c1d2e3f4a5b", ""];
        let ccd = format!("local_{}", canon);
        let r = CcdSessionMeta::new(ccd.as_bytes(), Some(canon.as_bytes()), Some(b"T"), Some("ai"), false, 1.0, None);
        assert!(matches!(r.ccd_key(), IdKey::Uuid(_)) && matches!(r.cli_key(), Some(IdKey::Uuid(_))));
        assert_eq!(&*r.ccd_session_id(), ccd.as_bytes());
        assert_eq!(r.cli_session_id().as_deref(), Some(canon.as_bytes()));
        assert_eq!(r.text.len(), 16 + 16 + 1);
        for o in others {
            let ccd_o = format!("local_{}", o);
            let r = CcdSessionMeta::new(ccd_o.as_bytes(), Some(o.as_bytes()), None, None, false, 0.0, None);
            assert!(matches!(r.ccd_key(), IdKey::Text(_)) && matches!(r.cli_key(), Some(IdKey::Text(_))), "{}", o);
            assert_eq!(&*r.ccd_session_id(), ccd_o.as_bytes());
            assert_eq!(r.cli_session_id().as_deref(), Some(o.as_bytes()));
        }
        let lone = crate::wtf8::from_units(&[0x6C, 0xD800]);
        let r = CcdSessionMeta::new(&lone, None, None, None, false, 0.0, None);
        assert_eq!(&*r.ccd_session_id(), lone.as_slice());
        // A parent id packs as the session id does, between the cli id and the title.
        let r = CcdSessionMeta::new(ccd.as_bytes(), Some(b"c"), Some(b"T"), None, false, 0.0, Some(ccd.as_bytes()));
        assert!(matches!(r.parent_key(), Some(IdKey::Uuid(_))));
        assert_eq!(r.parent_id().as_deref(), Some(ccd.as_bytes()));
        assert_eq!((r.cli_session_id().as_deref(), r.title()), (Some(&b"c"[..]), Some(&b"T"[..])));
        let r = CcdSessionMeta::new(b"local_x", None, None, None, false, 0.0, Some(b"local_p"));
        assert_eq!(r.parent_id().as_deref(), Some(&b"local_p"[..]));
        // File names.
        let mut paths = DirTable::default();
        for name in [format!("local_{}.json", canon), format!("local_{}.json", others[0]), "local_x.json".to_string(), "notes.txt".to_string()] {
            let full = os_path(&format!("/s/a/o/{}", name));
            let k = paths.split(full.as_bytes());
            assert_eq!(matches!(k.name, Name::Session(_)), name.contains(canon), "{}", name);
            assert_eq!(paths.path_string(&k), full);
        }
    }

    #[test]
    fn packed_ids_order_as_their_text() {
        let ids = ["00000000-0000-0000-0000-000000000000", "0000000a-0000-0000-0000-000000000000", "00000009-ffff-ffff-ffff-ffffffffffff", "a0000000-0000-0000-0000-000000000000", "9fffffff-ffff-ffff-ffff-ffffffffffff", "0000000A-0000-0000-0000-000000000000", "0000", "zz", "-"];
        for a in ids {
            for b in ids {
                assert_eq!(cmp_cli(&cli_id_key(a.as_bytes()), &cli_id_key(b.as_bytes())), a.as_bytes().cmp(b.as_bytes()), "{} {}", a, b);
            }
        }
    }

    #[test]
    fn by_cli_keeps_the_last_record_per_id() {
        let r = |ccd: &str, cli: Option<&str>| Arc::new(CcdSessionMeta::new(ccd.as_bytes(), cli.map(|c| c.as_bytes()), None, None, false, 0.0, None));
        let records = vec![r("local_1", Some("b")), r("local_2", Some("a")), r("local_3", Some("b")), r("local_4", Some("")), r("local_5", None)];
        let m = CcdByCli::build(&records);
        assert_eq!(m.get("b").map(|x| x.ccd_session_id().to_vec()), Some(b"local_3".to_vec()));
        assert_eq!(m.get("a").map(|x| x.ccd_session_id().to_vec()), Some(b"local_2".to_vec()));
        assert!(m.get("").is_none());
        assert!(m.get("c").is_none());
    }

    // src/ccd.test.ts: ccdAppDir on win32.

    #[test]
    fn finds_claude_desktop_under_appdata_on_windows() {
        assert_eq!(ccd_app_dir_win32(Some("C:\\Users\\me\\AppData\\Roaming"), "C:\\Users\\me"), "C:\\Users\\me\\AppData\\Roaming\\Claude");
    }

    #[test]
    fn falls_back_to_the_roaming_path_when_appdata_is_unset() {
        assert_eq!(ccd_app_dir_win32(None, "C:\\Users\\me"), "C:\\Users\\me\\AppData\\Roaming\\Claude");
        assert_eq!(ccd_app_dir_win32(Some(""), "C:\\Users\\me"), "C:\\Users\\me\\AppData\\Roaming\\Claude");
    }
}
