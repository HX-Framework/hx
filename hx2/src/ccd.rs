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

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use indexmap::{IndexMap, IndexSet};

use crate::fsutil::{join, readdir_safe, stat_safe, write_atomic_0600};
use crate::home::{homedir, hx_dir};
use crate::js::{js, trim, JsStr};
use crate::json::{obj, Json, OMap};

pub const CCD_REFRESH_TTL_MS: f64 = 20_000.0;
pub const CCD_FULL_STAT_INTERVAL_MS: f64 = 60_000.0;
pub const CCD_INDEX_SAVE_INTERVAL_MS: f64 = 10.0 * 60_000.0;
const CCD_INDEX_FORMAT: f64 = 1.0;

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

#[derive(Clone, Debug)]
pub struct CcdSessionMeta {
    pub ccd_session_id: String,
    pub cli_session_id: Option<String>,
    pub title: Option<JsStr>,
    /// "user" | "ai"
    pub title_source: Option<&'static str>,
    pub is_archived: bool,
    pub last_activity_at: f64,
}

impl CcdSessionMeta {
    fn to_json(&self) -> Json {
        obj(vec![
            ("ccdSessionId", Json::str(&self.ccd_session_id)),
            ("cliSessionId", Json::opt_str(self.cli_session_id.as_deref())),
            ("title", match &self.title {
                Some(t) => Json::Str(t.clone()),
                None => Json::Null,
            }),
            ("titleSource", Json::opt_str(self.title_source)),
            ("isArchived", Json::Bool(self.is_archived)),
            ("lastActivityAt", Json::num(self.last_activity_at)),
        ])
    }

    /// A saved record: `ccdSessionId` a string and `cliSessionId` null or a string.
    fn from_saved(v: &Json) -> Option<CcdSessionMeta> {
        if v.as_obj().is_none() {
            return None;
        }
        let ccd_session_id = v.get_string("ccdSessionId")?;
        let cli_session_id = match v.get("cliSessionId") {
            Some(Json::Null) => None,
            Some(Json::Str(s)) => Some(crate::js::lossy(s)),
            _ => return None,
        };
        Some(CcdSessionMeta {
            ccd_session_id,
            cli_session_id,
            title: match v.get("title") {
                Some(Json::Str(s)) => Some(s.clone()),
                _ => None,
            },
            title_source: match v.get_string("titleSource").as_deref() {
                Some("user") => Some("user"),
                Some("ai") => Some("ai"),
                _ => None,
            },
            is_archived: matches!(v.get("isArchived"), Some(Json::Bool(true))),
            last_activity_at: v.get_f64("lastActivityAt").unwrap_or(0.0),
        })
    }
}

struct IndexedFile {
    size: f64,
    mtime_ms: f64,
    record: Option<CcdSessionMeta>,
}

struct OrgDirListing {
    mtime_ms: f64,
    files: Vec<String>,
}

struct CcdIndex {
    dir: Option<String>,
    index: IndexMap<String, IndexedFile>,
    org_dirs: IndexMap<String, OrgDirListing>,
    records: Arc<Vec<CcdSessionMeta>>,
    version: u64,
    last_refresh_ms: f64,
    last_full_stat_ms: f64,
    by_cli: Option<(u64, Arc<HashMap<String, CcdSessionMeta>>)>,
    load_done: bool,
    saved_version: u64,
    last_save_ms: f64,
}

fn index() -> &'static Mutex<CcdIndex> {
    static INDEX: OnceLock<Mutex<CcdIndex>> = OnceLock::new();
    INDEX.get_or_init(|| {
        Mutex::new(CcdIndex {
            dir: ccd_sessions_dir(),
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
        })
    })
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

fn read_session_file(file_path: &str) -> Option<CcdSessionMeta> {
    let raw = fs::read(file_path).ok()?;
    let d = Json::parse(&String::from_utf8_lossy(&raw)).ok()?;
    if d.as_obj().is_none() {
        return None;
    }
    let ccd_session_id = d.get_string("sessionId")?;
    let title = match d.get("title") {
        Some(Json::Str(s)) if !trim(s).is_empty() => Some(s.clone()),
        _ => None,
    };
    Some(CcdSessionMeta {
        ccd_session_id,
        cli_session_id: d.get_string("cliSessionId"),
        title,
        title_source: match d.get_string("titleSource").as_deref() {
            Some("user") => Some("user"),
            Some("ai") => Some("ai"),
            _ => None,
        },
        is_archived: matches!(d.get("isArchived"), Some(Json::Bool(true))),
        last_activity_at: d.get_f64("lastActivityAt").unwrap_or(0.0),
    })
}

impl CcdIndex {
    fn reset(&mut self) {
        self.index.clear();
        self.org_dirs.clear();
        self.records = Arc::new(Vec::new());
        self.by_cli = None;
    }

    fn rebuild_records(&mut self) {
        let next: Vec<CcdSessionMeta> = self.index.values().filter_map(|e| e.record.clone()).collect();
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
        let saved = match Json::parse(&String::from_utf8_lossy(&raw)) {
            Ok(v) => v,
            Err(_) => return,
        };
        if saved.get_f64("v") != Some(CCD_INDEX_FORMAT) {
            return;
        }
        let dirs = match saved.get("dirs").and_then(|d| d.as_obj()) {
            Some(d) => d.clone(),
            None => return,
        };
        let files = match saved.get("files").and_then(|f| f.as_obj()) {
            Some(f) => f.clone(),
            None => return,
        };
        let under = format!("{}{}", dir, crate::fsutil::SEP);
        for (d, listing) in dirs.iter() {
            if !d.starts_with(&under) {
                continue;
            }
            let mtime = match listing.get_f64("mtimeMs") {
                Some(m) => m,
                None => continue,
            };
            let list = match listing.get("files").and_then(|f| f.as_arr()) {
                Some(l) => l,
                None => continue,
            };
            let names: Vec<String> = list.iter().filter_map(|f| f.as_string()).collect();
            self.org_dirs.insert(d.clone(), OrgDirListing { mtime_ms: mtime, files: names });
        }
        for (p, f) in files.iter() {
            if !p.starts_with(&under) {
                continue;
            }
            let (size, mtime) = match (f.get_f64("size"), f.get_f64("mtimeMs")) {
                (Some(s), Some(m)) => (s, m),
                _ => continue,
            };
            let record = f.get("record").and_then(CcdSessionMeta::from_saved);
            self.index.insert(p.clone(), IndexedFile { size, mtime_ms: mtime, record });
        }
        if self.index.is_empty() && self.org_dirs.is_empty() {
            return;
        }
        self.rebuild_records();
        self.version = 1;
        self.saved_version = 1;
        self.last_full_stat_ms = f64::NEG_INFINITY;
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
        let seen: IndexSet<String> = dirs.iter().cloned().collect();
        let mut to_stat: IndexSet<String> = IndexSet::new();
        for d in &dirs {
            let st = stat_safe(Path::new(d));
            let known_mtime = self.org_dirs.get(d).map(|k| k.mtime_ms);
            match st {
                Some(s) if s.is_dir => {
                    if let Some(km) = known_mtime {
                        if km == s.mtime_ms {
                            if full_stat {
                                if let Some(k) = self.org_dirs.get(d) {
                                    for p in &k.files {
                                        to_stat.insert(p.clone());
                                    }
                                }
                            }
                            continue;
                        }
                    }
                    let present: Vec<String> = readdir_safe(Path::new(d)).into_iter().filter(|f| is_session_file(f)).map(|f| join(d, &f)).collect();
                    if let Some(k) = self.org_dirs.get(d) {
                        let gone: Vec<String> = k.files.iter().filter(|p| !present.contains(p)).cloned().collect();
                        for p in gone {
                            if self.index.shift_remove(&p).is_some() {
                                changed = true;
                            }
                        }
                    }
                    self.org_dirs.insert(d.clone(), OrgDirListing { mtime_ms: s.mtime_ms, files: present.clone() });
                    for p in present {
                        to_stat.insert(p);
                    }
                }
                _ => {
                    if let Some(k) = self.org_dirs.shift_remove(d) {
                        for p in &k.files {
                            if self.index.shift_remove(p).is_some() {
                                changed = true;
                            }
                        }
                    }
                }
            }
        }
        let vanished: Vec<String> = self.org_dirs.keys().filter(|d| !seen.contains(*d)).cloned().collect();
        for d in vanished {
            if let Some(k) = self.org_dirs.shift_remove(&d) {
                for p in &k.files {
                    if self.index.shift_remove(p).is_some() {
                        changed = true;
                    }
                }
            }
        }
        for p in to_stat {
            match stat_safe(Path::new(&p)) {
                Some(s) if !s.is_dir => {
                    let same = self.index.get(&p).map(|k| k.size == s.size as f64 && k.mtime_ms == s.mtime_ms).unwrap_or(false);
                    if same {
                        continue;
                    }
                    let record = read_session_file(&p);
                    self.index.insert(p.clone(), IndexedFile { size: s.size as f64, mtime_ms: s.mtime_ms, record });
                    changed = true;
                }
                _ => {
                    if self.index.shift_remove(&p).is_some() {
                        changed = true;
                    }
                }
            }
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

    fn saved_json(&self, now_ms: f64) -> Json {
        let mut dirs = OMap::with_capacity(self.org_dirs.len());
        for (d, listing) in &self.org_dirs {
            dirs.set(d, obj(vec![("mtimeMs", Json::num(listing.mtime_ms)), ("files", Json::Arr(listing.files.iter().map(|f| Json::str(f)).collect()))]));
        }
        let mut files = OMap::with_capacity(self.index.len());
        for (p, f) in &self.index {
            files.set(
                p,
                obj(vec![
                    ("size", Json::num(f.size)),
                    ("mtimeMs", Json::num(f.mtime_ms)),
                    ("record", match &f.record {
                        Some(r) => r.to_json(),
                        None => Json::Null,
                    }),
                ]),
            );
        }
        obj(vec![("v", Json::num(CCD_INDEX_FORMAT)), ("savedAtMs", Json::num(now_ms)), ("dirs", Json::Obj(dirs)), ("files", Json::Obj(files))])
    }
}

/// Bring the index up to date if it is older than the TTL (or `force`); returns its version.
pub fn refresh_ccd_index(now_ms: f64, force: bool) -> u64 {
    index().lock().unwrap_or_else(|e| e.into_inner()).refresh(now_ms, force)
}

/// Every record (archived included), at most CCD_REFRESH_TTL_MS stale.
pub fn read_ccd_recents_cached(now_ms: f64) -> Arc<Vec<CcdSessionMeta>> {
    let mut g = index().lock().unwrap_or_else(|e| e.into_inner());
    g.refresh(now_ms, false);
    g.records.clone()
}

/// cliSessionId → Claude Desktop metadata, rebuilt only when the records changed.
pub fn get_ccd_recents_by_cli_id(now_ms: f64) -> Arc<HashMap<String, CcdSessionMeta>> {
    let mut g = index().lock().unwrap_or_else(|e| e.into_inner());
    let version = g.refresh(now_ms, false);
    if let Some((v, map)) = &g.by_cli {
        if *v == version {
            return map.clone();
        }
    }
    let mut by_cli: HashMap<String, CcdSessionMeta> = HashMap::new();
    for r in g.records.iter() {
        if let Some(cli) = &r.cli_session_id {
            by_cli.insert(cli.clone(), r.clone());
        }
    }
    let map = Arc::new(by_cli);
    g.by_cli = Some((version, map.clone()));
    map
}

/// Write the index if it changed since the last save; `force` skips the
/// interval (the daemon's parting flush, the end of a one-shot pass).
pub fn save_ccd_index_if_changed(now_ms: f64, force: bool) -> bool {
    let mut g = index().lock().unwrap_or_else(|e| e.into_inner());
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
    let text = g.saved_json(now_ms).stringify();
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if write_atomic_0600(&file, text.as_bytes()).is_err() {
        return false;
    }
    g.saved_version = g.version;
    g.last_save_ms = now_ms;
    true
}

/// The title string a Claude Desktop record carries, as text (for logs).
#[allow(dead_code)]
pub fn title_text(meta: &CcdSessionMeta) -> Option<String> {
    meta.title.as_ref().map(|t| crate::js::lossy(t))
}

#[allow(dead_code)]
pub fn js_title(s: &str) -> JsStr {
    js(s)
}

#[cfg(test)]
mod tests {
    use super::ccd_app_dir_win32;

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
