//! The tiered discovery catalog (src/catalog.ts): the parent transcripts
//! (Claude and Codex) and the child lanes the daemon uploads.
//!
//! The complete windowed inventory stays in memory; a tier decides which
//! entries are re-statted each tick (hot: every tick; warm: every 5 s; cold:
//! every 60 s, staggered). A per-tick directory pass catches creations,
//! deletions and renames within one tick; session-artifact dirs are walked
//! at the parent's heat. With file events armed (fsevents.rs) the full
//! polling sweep runs only every SAFETY_SWEEP_MS as the safety net, and the
//! ticks between re-check only the paths events named.
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

use indexmap::{IndexMap, IndexSet};

use crate::fsevents::FileEventSource;
use crate::fsutil::{basename, dirname, join, readdir_safe, stat_safe, SEP};
use crate::json::Json;
use crate::roots::{claude_projects_dir, codex_archived_dir, codex_sessions_dir, roots_signature, ResolvedRoots};
use crate::sources::{scan_session_artifacts, session_dir_of_lane, DiscoveredChildFile, DiscoveredFile, DiscoveredWorkflowRun, RECENT_WINDOW_MS};

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
    /// Claude session id (jsonl basename); empty for codex.
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

/// Per-codex-dir listing and the dir mtime it was taken at.
struct CodexListing {
    files: IndexSet<String>,
    dirs: IndexSet<String>,
    mtime_ms: f64,
    aged: bool,
}

struct ChildEntry {
    child: DiscoveredChildFile,
    #[allow(dead_code)]
    last_seen_ms: f64,
}

struct SessionDirEntry {
    session_dir: String,
    session_id: String,
    root_dir: String,
    last_walk_ms: f64,
}

struct TrackerRecord {
    mtime_ms: f64,
    pid: Option<i64>,
    session_id: Option<String>,
    started_at: Option<f64>,
}

#[derive(Default)]
struct HintBox {
    set: IndexSet<String>,
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
    crate::platform::probe_pid(pid) != crate::platform::PidProbe::Gone
}

pub struct DiscoveryCatalog {
    roots_sig: String,
    parents: IndexMap<String, FileEntry>,
    excluded: IndexMap<String, ExcludedEntry>,
    children: IndexMap<String, ChildEntry>,
    /// Per-session-dir UNMERGED workflow runs; `list_children` merges on demand.
    runs_by_dir: IndexMap<String, Vec<DiscoveredWorkflowRun>>,
    /// Claude PROJECT dirs with their last dir mtime.
    dirs: IndexMap<String, DirInfo>,
    codex_listings: IndexMap<String, CodexListing>,
    session_dirs: IndexMap<String, SessionDirEntry>,
    tracker_cache: IndexMap<String, TrackerRecord>,
    live_session_ids: HashSet<String>,
    /// Sessions promoted hot by observed child movement, per contributing dir.
    child_hot_sessions: HashSet<String>,
    child_movement_dirs: HashMap<String, HashSet<String>>,
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
            children: IndexMap::new(),
            runs_by_dir: IndexMap::new(),
            dirs: IndexMap::new(),
            codex_listings: IndexMap::new(),
            session_dirs: IndexMap::new(),
            tracker_cache: IndexMap::new(),
            live_session_ids: HashSet::new(),
            child_hot_sessions: HashSet::new(),
            child_movement_dirs: HashMap::new(),
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
        self.children.clear();
        self.runs_by_dir.clear();
        self.dirs.clear();
        self.codex_listings.clear();
        self.session_dirs.clear();
        self.live_session_ids.clear();
        self.child_hot_sessions.clear();
        self.child_movement_dirs.clear();
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

    /// The complete windowed parent inventory (Claude and Codex).
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

    /// Register a rescued lane's session-artifact dir so the child pass keeps
    /// walking it (what keeps lane election stable). In-window lanes only.
    pub fn adopt_session_dir(&mut self, lane: &DiscoveredChildFile, now_ms: f64) {
        if now_ms - lane.mtime_ms > RECENT_WINDOW_MS {
            return;
        }
        let session_dir = match session_dir_of_lane(&lane.path) {
            Some(d) => d,
            None => return,
        };
        if self.session_dirs.contains_key(&session_dir) {
            return;
        }
        self.session_dirs.insert(
            session_dir.clone(),
            SessionDirEntry { session_dir, session_id: lane.parent_session_id.clone(), root_dir: lane.root_dir.clone(), last_walk_ms: 0.0 },
        );
    }

    /// The child-lane inventory: every child, and the runs merged across
    /// dirs and roots with the fill-missing rules the full walk applies.
    pub fn list_children(&self) -> (Vec<DiscoveredChildFile>, Vec<DiscoveredWorkflowRun>) {
        let mut runs: Vec<DiscoveredWorkflowRun> = Vec::new();
        for dir_runs in self.runs_by_dir.values() {
            for r in dir_runs {
                match runs.iter_mut().find(|m| m.parent_session_id == r.parent_session_id && m.run_id == r.run_id) {
                    None => runs.push(r.clone()),
                    Some(existing) => {
                        if r.journal_path.is_some() && existing.journal_path.is_none() {
                            existing.journal_path = r.journal_path.clone();
                        }
                        if r.script_path.is_some() {
                            existing.script_path = r.script_path.clone();
                            existing.script_name = r.script_name.clone();
                        }
                        existing.mtime_ms = existing.mtime_ms.max(r.mtime_ms);
                    }
                }
            }
        }
        (self.children.values().map(|e| e.child.clone()).collect(), runs)
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
            self.codex_dir_pass(roots, now_ms);
            self.file_stat_pass(now_ms);
            self.excluded_stat_pass(now_ms);
            self.child_pass(now_ms);
            self.generation += 1;
            return;
        }
        let hinted: Vec<String> = {
            let mut h = self.hints.lock().unwrap_or_else(|e| e.into_inner());
            if h.set.is_empty() {
                return;
            }
            let v: Vec<String> = h.set.drain(..).collect();
            v
        };
        self.counters.hinted_sweeps += 1;
        self.counters.hints += hinted.len() as u64;
        self.hinted_sweep(roots, hinted, now_ms);
        self.generation += 1;
    }

    // ── Hinted sweep: only what events named ──────────────────────────────

    fn hinted_sweep(&mut self, roots: &ResolvedRoots, hinted: Vec<String>, now_ms: f64) {
        let mut parents_due: Vec<String> = Vec::new();
        let mut excluded_due: Vec<String> = Vec::new();
        let mut session_dirs_due: IndexSet<String> = IndexSet::new();
        let mut claude_dirs_due: IndexMap<String, String> = IndexMap::new();
        let mut new_project_dirs: IndexMap<String, String> = IndexMap::new();
        let mut codex_due: IndexMap<String, String> = IndexMap::new();
        let mut trackers_due = false;
        let root_of_claude_dir = |dir_path: &str| -> Option<String> {
            for r in &roots.claude {
                let projects = claude_projects_dir(&r.config_dir);
                if dir_path.starts_with(&format!("{}{}", projects, SEP)) {
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
                if self.session_dirs.contains_key(&d) {
                    session_dirs_due.insert(d.clone());
                    claimed = true;
                    break;
                }
                if self.dirs.contains_key(&d) {
                    if let Some(root) = root_of_claude_dir(&d) {
                        claude_dirs_due.insert(d.clone(), root);
                    }
                    claimed = true;
                    break;
                }
                if self.codex_listings.contains_key(&d) {
                    claimed = true;
                    codex_due.insert(d.clone(), String::new());
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
            // Under nothing known: a new project dir, a tracker, a codex dir, or noise.
            for r in &roots.claude {
                let projects = claude_projects_dir(&r.config_dir);
                let prefix = format!("{}{}", projects, SEP);
                if p.starts_with(&prefix) {
                    let name = p[prefix.len()..].split(SEP).next().unwrap_or("").to_string();
                    if !name.is_empty() && !name.starts_with('.') && name != "memory" {
                        new_project_dirs.insert(join(&projects, &name), r.config_dir.clone());
                    }
                    claimed = true;
                    break;
                }
                let sessions = join(&r.config_dir, "sessions");
                if p == sessions || p.starts_with(&format!("{}{}", sessions, SEP)) {
                    trackers_due = true;
                    claimed = true;
                    break;
                }
            }
            if claimed {
                continue;
            }
            'codex: for r in &roots.codex {
                for base in [codex_sessions_dir(&r.config_dir), codex_archived_dir(&r.config_dir)] {
                    if p == base || p.starts_with(&format!("{}{}", base, SEP)) {
                        codex_due.insert(base, r.config_dir.clone());
                        break 'codex;
                    }
                }
            }
        }
        // Resolve the root of a known codex listing dir from the roots.
        let pending: Vec<String> = codex_due.iter().filter(|(_, r)| r.is_empty()).map(|(d, _)| d.clone()).collect();
        for d in pending {
            codex_due.shift_remove(&d);
            for r in &roots.codex {
                for base in [codex_sessions_dir(&r.config_dir), codex_archived_dir(&r.config_dir)] {
                    if d == base || d.starts_with(&format!("{}{}", base, SEP)) {
                        codex_due.insert(base, r.config_dir.clone());
                    }
                }
            }
        }

        if trackers_due {
            self.tracker_pass(roots, now_ms);
        }
        let dirs_to_apply: Vec<(String, String)> = claude_dirs_due.into_iter().chain(new_project_dirs).collect();
        for (dir_path, root_dir) in dirs_to_apply {
            let m = match stat_safe(Path::new(&dir_path)) {
                Some(s) if s.is_dir => Some(s.mtime_ms),
                _ => None,
            };
            self.apply_claude_dir_stat(&dir_path, &root_dir, m, now_ms);
        }
        for (base, root_dir) in codex_due {
            self.codex_walk(&base, &root_dir, now_ms, true);
        }
        if !parents_due.is_empty() {
            self.stat_parents(&parents_due, now_ms);
        }
        if !excluded_due.is_empty() {
            self.stat_excluded(&excluded_due, now_ms);
        }
        for d in session_dirs_due {
            if self.session_dirs.contains_key(&d) {
                self.walk_session_dir(&d, now_ms);
            }
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

    // ── Dir passes (creations / deletions / renames land here, ≤1 tick) ───

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
            let prefix = format!("{}{}", projects, SEP);
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

    /// Forget a dir and everything under it.
    fn drop_dir_members(&mut self, dir_path: &str) {
        let prefix = format!("{}{}", dir_path, SEP);
        self.parents.retain(|p, _| !p.starts_with(&prefix));
        self.excluded.retain(|p, _| !p.starts_with(&prefix));
        self.children.retain(|p, _| !p.starts_with(&prefix));
        self.runs_by_dir.retain(|p, _| !(p == dir_path || p.starts_with(&prefix)));
        self.dirs.retain(|d, _| !(d == dir_path || d.starts_with(&prefix)));
        self.codex_listings.retain(|d, _| !(d == dir_path || d.starts_with(&prefix)));
        let gone: Vec<(String, String)> = self
            .session_dirs
            .iter()
            .filter(|(p, _)| *p == dir_path || p.starts_with(&prefix))
            .map(|(p, sd)| (p.clone(), sd.session_id.clone()))
            .collect();
        for (p, sid) in gone {
            self.session_dirs.shift_remove(&p);
            self.release_child_movement(&sid, &p);
        }
    }

    /// Remove one dir's movement contribution; the session stays promoted
    /// only while SOME of its dirs still shows movement.
    fn release_child_movement(&mut self, session_id: &str, session_dir: &str) {
        let mut remove = false;
        if let Some(dirs) = self.child_movement_dirs.get_mut(session_id) {
            dirs.remove(session_dir);
            if dirs.is_empty() {
                remove = true;
            }
        }
        if remove {
            self.child_movement_dirs.remove(session_id);
        }
        if !self.child_movement_dirs.contains_key(session_id) {
            self.child_hot_sessions.remove(session_id);
        }
    }

    fn readdir_claude_dir(&mut self, dir_path: &str, root_dir: &str, now_ms: f64) {
        let names = readdir_safe(Path::new(dir_path));
        let mut present: HashSet<String> = HashSet::new();
        let mut new_files: Vec<String> = Vec::new();
        let mut new_dirs: Vec<(String, String)> = Vec::new();
        for name in names {
            let p = join(dir_path, &name);
            present.insert(p.clone());
            if name.ends_with(".jsonl") {
                if !self.parents.contains_key(&p) && !self.excluded.contains_key(&p) {
                    new_files.push(p);
                }
                continue;
            }
            if name.starts_with('.') {
                continue;
            }
            if !self.session_dirs.contains_key(&p) {
                new_dirs.push((p, name));
            }
        }
        for p in new_files {
            let st = match stat_safe(Path::new(&p)) {
                Some(s) if !s.is_dir => s,
                _ => continue,
            };
            if st.size > 0 && now_ms - st.mtime_ms <= RECENT_WINDOW_MS {
                self.insert_parent(&p, st.size, st.mtime_ms, "claude", root_dir, now_ms);
            } else {
                // Exists but not admissible (size 0, or its own mtime beyond
                // the window): the excluded lane keeps watching it.
                let sid = basename(&p, ".jsonl");
                self.excluded.insert(
                    p.clone(),
                    ExcludedEntry { source: "claude", root_dir: root_dir.to_string(), last_stat_ms: now_ms - stagger_for(&p, COLD_STAT_INTERVAL_MS), session_id: sid },
                );
            }
        }
        for (p, name) in new_dirs {
            match stat_safe(Path::new(&p)) {
                Some(s) if s.is_dir => {
                    self.session_dirs.insert(p.clone(), SessionDirEntry { session_dir: p, session_id: name, root_dir: root_dir.to_string(), last_walk_ms: 0.0 });
                }
                _ => {}
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
        let gone: Vec<(String, String)> = self
            .session_dirs
            .iter()
            .filter(|(p, _)| dirname(p) == dir_path && !present.contains(*p))
            .map(|(p, sd)| (p.clone(), sd.session_id.clone()))
            .collect();
        for (p, sid) in gone {
            self.session_dirs.shift_remove(&p);
            self.release_child_movement(&sid, &p);
            self.drop_dir_members(&p);
        }
    }

    fn codex_dir_pass(&mut self, roots: &ResolvedRoots, now_ms: f64) {
        for root in &roots.codex {
            for base in [codex_sessions_dir(&root.config_dir), codex_archived_dir(&root.config_dir)] {
                self.codex_walk(&base, &root.config_dir, now_ms, true);
            }
        }
    }

    /// Mirror of the pruned codex recursion, with per-file stats replaced by
    /// catalog admission (new files); known files ride the tiers. Each walked
    /// dir presence-diffs its direct member files, and known subdirs that
    /// vanished from the listing drop with their members.
    fn codex_walk(&mut self, dir: &str, root_dir: &str, now_ms: f64, is_root: bool) {
        let st = match stat_safe(Path::new(dir)) {
            Some(s) if s.is_dir => s,
            _ => {
                if self.codex_listings.contains_key(dir) {
                    self.drop_dir_members(dir);
                }
                return;
            }
        };
        if !is_root && now_ms - st.mtime_ms > RECENT_WINDOW_MS {
            let known_not_aged = self.codex_listings.get(dir).map(|k| !k.aged).unwrap_or(false);
            if known_not_aged {
                self.drop_dir_members(dir);
            }
            self.codex_listings.insert(dir.to_string(), CodexListing { files: IndexSet::new(), dirs: IndexSet::new(), mtime_ms: st.mtime_ms, aged: true });
            return;
        }
        let needs_list = match self.codex_listings.get(dir) {
            Some(l) => l.mtime_ms != st.mtime_ms || l.aged,
            None => true,
        };
        if needs_list {
            let mut present_files: IndexSet<String> = IndexSet::new();
            let mut present_dirs: IndexSet<String> = IndexSet::new();
            if let Ok(rd) = fs::read_dir(dir) {
                for e in rd.filter_map(|e| e.ok()) {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let full = join(dir, &name);
                    let ft = match e.file_type() {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    if ft.is_file() && name.starts_with("rollout-") && name.ends_with(".jsonl") {
                        present_files.insert(full.clone());
                        if !self.parents.contains_key(&full) && !self.excluded.contains_key(&full) {
                            let fst = match stat_safe(Path::new(&full)) {
                                Some(s) if !s.is_dir => s,
                                _ => continue,
                            };
                            if fst.size > 0 && now_ms - fst.mtime_ms <= RECENT_WINDOW_MS {
                                self.insert_parent(&full, fst.size, fst.mtime_ms, "codex", root_dir, now_ms);
                            } else {
                                self.excluded.insert(
                                    full.clone(),
                                    ExcludedEntry { source: "codex", root_dir: root_dir.to_string(), last_stat_ms: now_ms - stagger_for(&full, COLD_STAT_INTERVAL_MS), session_id: String::new() },
                                );
                            }
                        }
                    } else if ft.is_dir() {
                        present_dirs.insert(full);
                    }
                }
            }
            let (gone_files, gone_dirs): (Vec<String>, Vec<String>) = match self.codex_listings.get(dir) {
                Some(prev) => (
                    prev.files.iter().filter(|p| !present_files.contains(*p)).cloned().collect(),
                    prev.dirs.iter().filter(|d| !present_dirs.contains(*d)).cloned().collect(),
                ),
                None => (Vec::new(), Vec::new()),
            };
            for p in gone_files {
                self.parents.shift_remove(&p);
                self.excluded.shift_remove(&p);
            }
            for d in gone_dirs {
                self.drop_dir_members(&d);
            }
            self.codex_listings.insert(dir.to_string(), CodexListing { files: present_files, dirs: present_dirs, mtime_ms: st.mtime_ms, aged: false });
        }
        let subdirs: Vec<String> = self.codex_listings.get(dir).map(|l| l.dirs.iter().cloned().collect()).unwrap_or_default();
        for d in subdirs {
            self.codex_walk(&d, root_dir, now_ms, false);
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
        if age <= HOT_AGE_MS || self.is_live(&e.session_id) || self.child_hot_sessions.contains(&e.session_id) {
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

    // ── Children (walk cadence by parent heat) ────────────────────────────

    fn child_pass(&mut self, now_ms: f64) {
        // One hot-parent index per pass — sessionId → newest claude-parent mtime.
        let mut parent_mtime: HashMap<String, f64> = HashMap::new();
        for e in self.parents.values() {
            if e.session_id.is_empty() {
                continue;
            }
            let slot = parent_mtime.entry(e.session_id.clone()).or_insert(f64::NEG_INFINITY);
            if e.file.mtime_ms > *slot {
                *slot = e.file.mtime_ms;
            }
        }
        let due: Vec<String> = self
            .session_dirs
            .iter()
            .filter(|(_, sd)| {
                let parent_hot = now_ms - parent_mtime.get(&sd.session_id).copied().unwrap_or(0.0) <= HOT_AGE_MS;
                let hot = self.is_live(&sd.session_id) || parent_hot || self.child_hot_sessions.contains(&sd.session_id);
                let due_at = if hot { 0.0 } else { WARM_STAT_INTERVAL_MS };
                now_ms - sd.last_walk_ms >= due_at
            })
            .map(|(p, _)| p.clone())
            .collect();
        for key in due {
            self.walk_session_dir(&key, now_ms);
        }
    }

    /// Walk one session-artifact dir and fold the result into the catalog.
    fn walk_session_dir(&mut self, key: &str, now_ms: f64) {
        let (session_dir, session_id, root_dir) = match self.session_dirs.get_mut(key) {
            Some(sd) => {
                sd.last_walk_ms = now_ms;
                (sd.session_dir.clone(), sd.session_id.clone(), sd.root_dir.clone())
            }
            None => return,
        };
        let mut walk_children: Vec<DiscoveredChildFile> = Vec::new();
        let mut walk_runs: Vec<DiscoveredWorkflowRun> = Vec::new();
        scan_session_artifacts(&session_dir, &session_id, &root_dir, now_ms, &mut walk_children, &mut walk_runs, RECENT_WINDOW_MS);

        // Child movement promotes the parent to hot; a walked-and-quiet
        // subtree ends the promotion.
        let mut movement = false;
        for c in &walk_children {
            match self.children.get(&c.path) {
                Some(prev) if prev.child.mtime_ms == c.mtime_ms && prev.child.size == c.size => {}
                _ => {
                    movement = true;
                    break;
                }
            }
        }
        if !movement {
            let run_fp = |rs: &[DiscoveredWorkflowRun]| -> String {
                let mut parts: Vec<String> = rs
                    .iter()
                    .map(|r| format!("{}:{}:{}:{}", r.run_id, r.mtime_ms, r.journal_path.clone().unwrap_or_default(), r.script_path.clone().unwrap_or_default()))
                    .collect();
                parts.sort();
                parts.join("|")
            };
            let prev_fp = run_fp(self.runs_by_dir.get(&session_dir).map(|v| v.as_slice()).unwrap_or(&[]));
            if prev_fp != run_fp(&walk_runs) {
                movement = true;
            }
        }
        if movement {
            self.child_movement_dirs.entry(session_id.clone()).or_default().insert(session_dir.clone());
            self.child_hot_sessions.insert(session_id.clone());
        } else {
            self.release_child_movement(&session_id, &session_dir);
        }

        // The walk is authoritative for its own subtree: replace it wholesale.
        let prefix = format!("{}{}", session_dir, SEP);
        let walked: HashSet<String> = walk_children.iter().map(|c| c.path.clone()).collect();
        self.children.retain(|p, _| !(p.starts_with(&prefix) && !walked.contains(p)));
        for c in walk_children {
            self.children.insert(c.path.clone(), ChildEntry { child: c, last_seen_ms: now_ms });
        }
        if walk_runs.is_empty() {
            self.runs_by_dir.shift_remove(&session_dir);
        } else {
            self.runs_by_dir.insert(session_dir, walk_runs);
        }
    }
}
