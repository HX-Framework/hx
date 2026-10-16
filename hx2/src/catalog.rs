//! The tiered discovery catalog (src/catalog.ts), for the parent transcripts
//! the hot path uploads.
//!
//! The complete windowed inventory stays in memory; a tier decides which
//! entries are re-statted each tick (hot: every tick; warm: every 5 s; cold:
//! every 60 s, staggered). A per-tick directory pass catches creations,
//! deletions and renames within one tick. With file events armed (fsevents.rs)
//! the full polling sweep runs only every SAFETY_SWEEP_MS as the safety net,
//! and the ticks between re-check only the paths events named.
//!
//! The inventory keeps DISCOVERY order, as the TypeScript client's Maps do:
//! a pass hands files to the upload pool in the order the catalog lists them,
//! and which files a pass reaches first is visible to a gateway that is
//! refusing them (the two-file rule stops the pass after two failures).
//! A re-admitted path goes to the end, exactly where a `Map` puts it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;

use crate::fsevents::FileEventSource;
use crate::fsutil::{basename, dirname, join, readdir_safe, stat_safe};
use crate::json::Json;
use crate::roots::{claude_projects_dir, roots_signature, ResolvedRoots};
use crate::sources::{DiscoveredFile, RECENT_WINDOW_MS};

const HOT_AGE_MS: f64 = 5.0 * 60_000.0;
const WARM_AGE_MS: f64 = 48.0 * 60.0 * 60_000.0;
const WARM_STAT_INTERVAL_MS: f64 = 5_000.0;
const COLD_STAT_INTERVAL_MS: f64 = 60_000.0;
const TRACKER_MAX_AGE_MS: f64 = 7.0 * 24.0 * 60.0 * 60_000.0;
const TRACKER_PARSE_CACHE: usize = 512;
pub const SAFETY_SWEEP_MS: f64 = 60_000.0;
pub const HINT_CAP: usize = 10_000;

struct FileEntry {
    file: DiscoveredFile,
    last_stat_ms: f64,
    session_id: String,
}

struct ExcludedEntry {
    source: &'static str,
    root_dir: String,
    last_stat_ms: f64,
    session_id: String,
}

struct DirInfo {
    mtime_ms: f64,
    aged: bool,
}

struct TrackerRecord {
    mtime_ms: f64,
    pid: Option<i64>,
    session_id: Option<String>,
    started_at: Option<f64>,
}

#[derive(Default)]
struct HintBox {
    set: HashSet<String>,
    overflow: bool,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Counters {
    pub full_sweeps: u64,
    pub hinted_sweeps: u64,
    pub hints: u64,
}

/// Deterministic per-path stagger in [0, interval): a 31-hash over the
/// path's UTF-16 units in JavaScript's int32 arithmetic.
fn stagger_for(p: &str, interval: f64) -> f64 {
    let mut h: i32 = 0;
    for c in p.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(c as i32);
    }
    ((h as i64).abs() % (interval as i64)) as f64
}

fn pid_alive(pid: i64) -> bool {
    // SAFETY: signal 0 only probes the process.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if r == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

pub struct DiscoveryCatalog {
    roots_sig: String,
    parents: IndexMap<String, FileEntry>,
    excluded: IndexMap<String, ExcludedEntry>,
    dirs: IndexMap<String, DirInfo>,
    tracker_cache: IndexMap<String, TrackerRecord>,
    live_session_ids: HashSet<String>,
    want_events: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    events: Option<FileEventSource>,
    events_failed: Arc<AtomicBool>,
    hints: Arc<Mutex<HintBox>>,
    last_full_sweep_ms: f64,
    pub counters: Counters,
    /// Moves every time a sweep ran or paths were adopted: a tick whose
    /// catalog, state and settings generations all stand still has the same
    /// files to hand to the pool as the last one.
    pub generation: u64,
}

impl Default for DiscoveryCatalog {
    fn default() -> Self {
        Self::new()
    }
}

impl DiscoveryCatalog {
    pub fn new() -> DiscoveryCatalog {
        DiscoveryCatalog {
            roots_sig: String::new(),
            parents: IndexMap::new(),
            excluded: IndexMap::new(),
            dirs: IndexMap::new(),
            tracker_cache: IndexMap::new(),
            live_session_ids: HashSet::new(),
            want_events: None,
            events: None,
            events_failed: Arc::new(AtomicBool::new(false)),
            hints: Arc::new(Mutex::new(HintBox::default())),
            last_full_sweep_ms: f64::NEG_INFINITY,
            counters: Counters::default(),
            generation: 0,
        }
    }

    fn reset(&mut self) {
        self.roots_sig.clear();
        self.parents.clear();
        self.excluded.clear();
        self.dirs.clear();
        self.live_session_ids.clear();
        self.events = None;
        let mut h = self.hints.lock().unwrap_or_else(|e| e.into_inner());
        h.set.clear();
        h.overflow = false;
        drop(h);
        self.last_full_sweep_ms = f64::NEG_INFINITY;
        self.generation += 1;
    }

    // ── File events ───────────────────────────────────────────────────────

    /// Ask for file events (the long-running loop only); armed at the next sweep.
    pub fn enable_file_events(&mut self, log: Arc<dyn Fn(&str) + Send + Sync>) {
        self.want_events = Some(log);
    }

    pub fn disable_file_events(&mut self) {
        self.want_events = None;
        self.events = None;
    }

    pub fn events_armed(&self) -> bool {
        self.events.is_some()
    }

    fn arm_events(&mut self, roots: &ResolvedRoots) {
        self.events = None;
        let log = match &self.want_events {
            Some(l) => l.clone(),
            None => return,
        };
        if self.events_failed.load(Ordering::SeqCst) {
            return;
        }
        let hints = self.hints.clone();
        let on_hint: Arc<dyn Fn(PathBuf) + Send + Sync> = Arc::new(move |p: PathBuf| {
            let mut h = hints.lock().unwrap_or_else(|e| e.into_inner());
            if h.set.len() >= HINT_CAP {
                h.overflow = true;
                return;
            }
            h.set.insert(p.to_string_lossy().into_owned());
        });
        let failed = self.events_failed.clone();
        let on_failure: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |reason: String| {
            if failed.swap(true, Ordering::SeqCst) {
                return;
            }
            log(&format!("[hx] file events unavailable ({}); polling the file tree every tick", reason));
        });
        if let Some(src) = FileEventSource::arm(roots, on_hint, on_failure) {
            self.events = Some(src);
        }
    }

    /// The complete windowed parent inventory.
    pub fn list_files(&self) -> Vec<DiscoveredFile> {
        self.parents.values().map(|e| e.file.clone()).collect()
    }

    /// Take ownership of paths the slow sweep reached and the walk did not.
    pub fn adopt(&mut self, files: &[DiscoveredFile], now_ms: f64) -> usize {
        let mut adopted = 0;
        for f in files {
            if now_ms - f.mtime_ms > RECENT_WINDOW_MS {
                continue;
            }
            if self.parents.contains_key(&f.path) || self.excluded.contains_key(&f.path) {
                continue;
            }
            self.insert_parent(&f.path, f.size, f.mtime_ms, f.source, &f.root_dir, now_ms);
            if let Some(e) = self.parents.get_mut(&f.path) {
                e.last_stat_ms = now_ms;
            }
            adopted += 1;
        }
        if adopted > 0 {
            self.generation += 1;
        }
        adopted
    }

    pub fn sweep(&mut self, roots: &ResolvedRoots, now_ms: f64) {
        if let Some(e) = &self.events {
            if e.has_failed() {
                self.events = None;
            }
        }
        let sig = roots_signature(roots);
        if sig != self.roots_sig {
            self.reset();
            self.roots_sig = sig;
            self.events_failed.store(false, Ordering::SeqCst);
            self.arm_events(roots);
        } else if self.want_events.is_some() && self.events.is_none() && !self.events_failed.load(Ordering::SeqCst) {
            self.arm_events(roots);
        }
        let overflow = self.hints.lock().unwrap_or_else(|e| e.into_inner()).overflow;
        let full = self.events.is_none() || overflow || now_ms - self.last_full_sweep_ms >= SAFETY_SWEEP_MS;
        if full {
            {
                let mut h = self.hints.lock().unwrap_or_else(|e| e.into_inner());
                h.set.clear();
                h.overflow = false;
            }
            self.last_full_sweep_ms = now_ms;
            self.counters.full_sweeps += 1;
            if let Some(e) = &self.events {
                let failed = self.events_failed.clone();
                let log = self.want_events.clone();
                let on_failure: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |reason: String| {
                    if failed.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    if let Some(l) = &log {
                        l(&format!("[hx] file events unavailable ({}); polling the file tree every tick", reason));
                    }
                });
                e.rearm(&on_failure);
            }
            self.tracker_pass(roots, now_ms);
            self.claude_dir_pass(roots, now_ms);
            self.file_stat_pass(now_ms);
            self.excluded_stat_pass(now_ms);
            self.generation += 1;
            return;
        }
        let hinted: Vec<String> = {
            let mut h = self.hints.lock().unwrap_or_else(|e| e.into_inner());
            if h.set.is_empty() {
                return;
            }
            let v: Vec<String> = h.set.drain().collect();
            v
        };
        self.counters.hinted_sweeps += 1;
        self.counters.hints += hinted.len() as u64;
        self.hinted_sweep(roots, hinted, now_ms);
        self.generation += 1;
    }

    // ── Hinted sweep ──────────────────────────────────────────────────────

    fn hinted_sweep(&mut self, roots: &ResolvedRoots, hinted: Vec<String>, now_ms: f64) {
        let mut parents_due: Vec<String> = Vec::new();
        let mut excluded_due: Vec<String> = Vec::new();
        let mut claude_dirs_due: Vec<(String, String)> = Vec::new();
        let mut trackers_due = false;
        let root_of_claude_dir = |dir_path: &str| -> Option<String> {
            for r in &roots.claude {
                let projects = claude_projects_dir(&r.config_dir);
                if dir_path.starts_with(&format!("{}/", projects)) {
                    return Some(r.config_dir.clone());
                }
            }
            None
        };
        for p in hinted {
            if self.parents.contains_key(&p) {
                parents_due.push(p);
                continue;
            }
            if self.excluded.contains_key(&p) {
                excluded_due.push(p);
                continue;
            }
            // Walk up to the nearest directory the catalog knows.
            let mut claimed = false;
            let mut d = p.clone();
            loop {
                if self.dirs.contains_key(&d) {
                    if let Some(root) = root_of_claude_dir(&d) {
                        if !claude_dirs_due.iter().any(|(x, _)| *x == d) {
                            claude_dirs_due.push((d.clone(), root));
                        }
                    }
                    claimed = true;
                    break;
                }
                let up = dirname(&d);
                if up == d {
                    break;
                }
                d = up;
            }
            if claimed {
                continue;
            }
            for r in &roots.claude {
                let projects = claude_projects_dir(&r.config_dir);
                let prefix = format!("{}/", projects);
                if p.starts_with(&prefix) {
                    let name = p[prefix.len()..].split('/').next().unwrap_or("").to_string();
                    if !name.is_empty() && !name.starts_with('.') && name != "memory" {
                        let dir = join(&projects, &name);
                        if !claude_dirs_due.iter().any(|(x, _)| *x == dir) {
                            claude_dirs_due.push((dir, r.config_dir.clone()));
                        }
                    }
                    claimed = true;
                    break;
                }
                let sessions = join(&r.config_dir, "sessions");
                if p == sessions || p.starts_with(&format!("{}/", sessions)) {
                    trackers_due = true;
                    claimed = true;
                    break;
                }
            }
            let _ = claimed;
        }
        if trackers_due {
            self.tracker_pass(roots, now_ms);
        }
        for (dir_path, root_dir) in claude_dirs_due {
            let st = stat_safe(Path::new(&dir_path));
            let m = match st {
                Some(s) if s.is_dir => Some(s.mtime_ms),
                _ => None,
            };
            self.apply_claude_dir_stat(&dir_path, &root_dir, m, now_ms);
        }
        if !parents_due.is_empty() {
            self.stat_parents(&parents_due, now_ms);
        }
        if !excluded_due.is_empty() {
            self.stat_excluded(&excluded_due, now_ms);
        }
    }

    // ── Liveness ──────────────────────────────────────────────────────────

    fn is_live(&self, session_id: &str) -> bool {
        self.live_session_ids.contains(session_id)
    }

    fn tracker_pass(&mut self, roots: &ResolvedRoots, now_ms: f64) {
        self.live_session_ids.clear();
        for root in &roots.claude {
            let dir = join(&root.config_dir, "sessions");
            let names: Vec<String> = readdir_safe(Path::new(&dir)).into_iter().filter(|f| f.ends_with(".json")).collect();
            for f in names {
                let p = join(&dir, &f);
                let st = match stat_safe(Path::new(&p)) {
                    Some(s) if !s.is_dir => s,
                    _ => continue,
                };
                let needs_parse = match self.tracker_cache.get(&p) {
                    Some(rec) => rec.mtime_ms != st.mtime_ms,
                    None => true,
                };
                if needs_parse {
                    let mut rec = TrackerRecord { mtime_ms: st.mtime_ms, pid: None, session_id: None, started_at: None };
                    if let Ok(raw) = fs::read_to_string(&p) {
                        if let Ok(parsed) = Json::parse(&raw) {
                            rec.pid = parsed.get_f64("pid").map(|v| v as i64);
                            rec.session_id = parsed.get_string("sessionId");
                            rec.started_at = parsed.get_f64("startedAt");
                        }
                    }
                    if self.tracker_cache.len() >= TRACKER_PARSE_CACHE {
                        let drop_n = self.tracker_cache.len() / 2;
                        let keys: Vec<String> = self.tracker_cache.keys().take(drop_n).cloned().collect();
                        for k in keys {
                            self.tracker_cache.shift_remove(&k);
                        }
                    }
                    self.tracker_cache.insert(p.clone(), rec);
                }
                let rec = match self.tracker_cache.get(&p) {
                    Some(r) => r,
                    None => continue,
                };
                let (sid, pid) = match (&rec.session_id, rec.pid) {
                    (Some(s), Some(pid)) => (s.clone(), pid),
                    _ => continue,
                };
                if let Some(started) = rec.started_at {
                    if now_ms - started > TRACKER_MAX_AGE_MS {
                        continue;
                    }
                }
                if pid_alive(pid) {
                    self.live_session_ids.insert(sid);
                }
            }
        }
    }

    // ── Dir passes ────────────────────────────────────────────────────────

    fn claude_dir_pass(&mut self, roots: &ResolvedRoots, now_ms: f64) {
        for root in &roots.claude {
            let projects = claude_projects_dir(&root.config_dir);
            let mut seen: HashSet<String> = HashSet::new();
            let mut candidates: Vec<String> = Vec::new();
            for name in readdir_safe(Path::new(&projects)) {
                if name.starts_with('.') || name == "memory" {
                    continue;
                }
                let dir_path = join(&projects, &name);
                seen.insert(dir_path.clone());
                candidates.push(dir_path);
            }
            for dir_path in candidates {
                let st = match stat_safe(Path::new(&dir_path)) {
                    Some(s) if s.is_dir => s,
                    _ => continue,
                };
                self.apply_claude_dir_stat(&dir_path, &root.config_dir, Some(st.mtime_ms), now_ms);
            }
            let prefix = format!("{}/", projects);
            let gone: Vec<String> = self.dirs.keys().filter(|d| d.starts_with(&prefix) && !seen.contains(*d)).cloned().collect();
            for dir_path in gone {
                self.drop_dir_members(&dir_path);
                self.dirs.shift_remove(&dir_path);
            }
        }
    }

    fn apply_claude_dir_stat(&mut self, dir_path: &str, root_dir: &str, mtime: Option<f64>, now_ms: f64) {
        let known_mtime = self.dirs.get(dir_path).map(|d| (d.mtime_ms, d.aged));
        let mtime_ms = match mtime {
            Some(m) => m,
            None => {
                if known_mtime.is_some() {
                    self.drop_dir_members(dir_path);
                    self.dirs.shift_remove(dir_path);
                }
                return;
            }
        };
        if now_ms - mtime_ms > RECENT_WINDOW_MS {
            if let Some((_, aged)) = known_mtime {
                if !aged {
                    self.drop_dir_members(dir_path);
                }
            }
            self.dirs.insert(dir_path.to_string(), DirInfo { mtime_ms, aged: true });
            return;
        }
        let changed = match known_mtime {
            Some((m, _)) => m != mtime_ms,
            None => true,
        };
        if changed {
            self.dirs.insert(dir_path.to_string(), DirInfo { mtime_ms, aged: false });
            self.readdir_claude_dir(dir_path, root_dir, now_ms);
        }
    }

    fn drop_dir_members(&mut self, dir_path: &str) {
        let prefix = format!("{}/", dir_path);
        self.parents.retain(|p, _| !p.starts_with(&prefix));
        self.excluded.retain(|p, _| !p.starts_with(&prefix));
        self.dirs.retain(|d, _| !(d == dir_path || d.starts_with(&prefix)));
    }

    fn readdir_claude_dir(&mut self, dir_path: &str, root_dir: &str, now_ms: f64) {
        let names = readdir_safe(Path::new(dir_path));
        let mut present: HashSet<String> = HashSet::new();
        let mut new_files: Vec<String> = Vec::new();
        for name in names {
            let p = join(dir_path, &name);
            present.insert(p.clone());
            if name.ends_with(".jsonl") {
                if !self.parents.contains_key(&p) && !self.excluded.contains_key(&p) {
                    new_files.push(p);
                }
                continue;
            }
            // Session-artifact directories (child lanes) are the next card's work.
        }
        for p in new_files {
            let st = match stat_safe(Path::new(&p)) {
                Some(s) if !s.is_dir => s,
                _ => continue,
            };
            if st.size > 0 && now_ms - st.mtime_ms <= RECENT_WINDOW_MS {
                self.insert_parent(&p, st.size, st.mtime_ms, "claude", root_dir, now_ms);
            } else {
                let sid = basename(&p, ".jsonl");
                self.excluded.insert(
                    p.clone(),
                    ExcludedEntry { source: "claude", root_dir: root_dir.to_string(), last_stat_ms: now_ms - stagger_for(&p, COLD_STAT_INTERVAL_MS), session_id: sid },
                );
            }
        }
        // Deletions and renames inside this dir drop now.
        let gone: Vec<String> = self.parents.keys().filter(|p| dirname(p) == dir_path && !present.contains(*p)).cloned().collect();
        for p in gone {
            self.parents.shift_remove(&p);
        }
        let gone: Vec<String> = self.excluded.keys().filter(|p| dirname(p) == dir_path && !present.contains(*p)).cloned().collect();
        for p in gone {
            self.excluded.shift_remove(&p);
        }
    }

    fn insert_parent(&mut self, p: &str, size: u64, mtime_ms: f64, source: &'static str, root_dir: &str, now_ms: f64) {
        let sid = if source == "claude" { basename(p, ".jsonl") } else { String::new() };
        self.parents.insert(
            p.to_string(),
            FileEntry {
                file: DiscoveredFile { path: p.to_string(), size, mtime_ms, source, root_dir: root_dir.to_string() },
                last_stat_ms: now_ms - stagger_for(p, COLD_STAT_INTERVAL_MS),
                session_id: sid,
            },
        );
    }

    // ── File stat pass (tiers) ────────────────────────────────────────────

    fn tier_interval(&self, e: &FileEntry, now_ms: f64) -> f64 {
        let age = now_ms - e.file.mtime_ms;
        if age <= HOT_AGE_MS || self.is_live(&e.session_id) {
            return 0.0;
        }
        if age <= WARM_AGE_MS {
            return WARM_STAT_INTERVAL_MS;
        }
        COLD_STAT_INTERVAL_MS
    }

    fn file_stat_pass(&mut self, now_ms: f64) {
        let due: Vec<String> = self
            .parents
            .iter()
            .filter(|(_, e)| {
                let interval = self.tier_interval(e, now_ms);
                interval == 0.0 || now_ms - e.last_stat_ms >= interval
            })
            .map(|(p, _)| p.clone())
            .collect();
        self.stat_parents(&due, now_ms);
    }

    fn stat_parents(&mut self, due: &[String], now_ms: f64) {
        for p in due {
            let (source, root_dir, session_id) = match self.parents.get(p) {
                Some(e) => (e.file.source, e.file.root_dir.clone(), e.session_id.clone()),
                None => continue,
            };
            let st = stat_safe(Path::new(p));
            if let Some(e) = self.parents.get_mut(p) {
                e.last_stat_ms = now_ms;
            }
            match st {
                None => {
                    self.parents.shift_remove(p);
                }
                Some(s) if s.is_dir => {
                    self.parents.shift_remove(p);
                }
                Some(s) if s.size == 0 => {
                    self.parents.shift_remove(p);
                    self.excluded.insert(p.clone(), ExcludedEntry { source, root_dir, last_stat_ms: now_ms, session_id });
                }
                Some(s) if now_ms - s.mtime_ms > RECENT_WINDOW_MS => {
                    self.parents.shift_remove(p);
                    self.excluded.insert(p.clone(), ExcludedEntry { source, root_dir, last_stat_ms: now_ms, session_id });
                }
                Some(s) => {
                    if let Some(e) = self.parents.get_mut(p) {
                        e.file.size = s.size;
                        e.file.mtime_ms = s.mtime_ms;
                    }
                }
            }
        }
    }

    fn excluded_stat_pass(&mut self, now_ms: f64) {
        let due: Vec<String> = self
            .excluded
            .iter()
            .filter(|(_, e)| {
                let live = !e.session_id.is_empty() && self.is_live(&e.session_id);
                live || now_ms - e.last_stat_ms >= COLD_STAT_INTERVAL_MS
            })
            .map(|(p, _)| p.clone())
            .collect();
        self.stat_excluded(&due, now_ms);
    }

    fn stat_excluded(&mut self, due: &[String], now_ms: f64) {
        for p in due {
            let (source, root_dir) = match self.excluded.get(p) {
                Some(e) => (e.source, e.root_dir.clone()),
                None => continue,
            };
            let st = match stat_safe(Path::new(p)) {
                Some(s) if !s.is_dir => s,
                _ => {
                    self.excluded.shift_remove(p);
                    continue;
                }
            };
            if let Some(e) = self.excluded.get_mut(p) {
                e.last_stat_ms = now_ms;
            }
            if st.size > 0 && now_ms - st.mtime_ms <= RECENT_WINDOW_MS {
                self.excluded.shift_remove(p);
                self.insert_parent(p, st.size, st.mtime_ms, source, &root_dir, now_ms);
                if let Some(e) = self.parents.get_mut(p) {
                    e.last_stat_ms = now_ms;
                }
            }
        }
    }
}
