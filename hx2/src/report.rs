//! The sync snapshot and the sync report (watch.ts): election, the settings
//! filter, what the daemon posts as progress, and what `hx status` and
//! `hx doctor sync` describe.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::diagnostics::{ChildLanes, SyncBehindEntry, SyncReport, SyncSkippedEntry};
use crate::fsutil::{exists, now_ms};
use crate::json::{obj, Json};
use crate::ledger::{build_ledger, ever_written_keys, reportable_offset, LedgerFile};
use crate::orgnames::read_org_names;
use crate::roots::{is_under_roots, resolve_data_roots, DataRoot, ResolvedRoots};
use crate::settings::{read_settings, should_skip_file, FileSyncIdentity, HxSettings};
use crate::sources::{discover_claude_files, discover_codex_files, DiscoveredFile, RECENT_WINDOW_MS};
use crate::state::{fs_min_offset, fs_offsets, Store};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SyncSnapshot {
    pub total: u64,
    pub done: u64,
    pub total_bytes: u64,
}

/// Shadowed-twin log dedupe: each hidden path is announced once per process
/// (watch.ts loggedShadowed, shared by the parent and child elections and
/// by every lane).
pub fn note_shadowed(path: &str) -> bool {
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(HashSet::new())).lock().unwrap_or_else(|e| e.into_inner()).insert(path.to_string())
}

/// `shouldSkipFile` over a state entry.
pub fn should_skip_entry(settings: &HxSettings, fs: &Json) -> bool {
    let family = fs.get_string("family").unwrap_or_default();
    let cwd = fs.get_string("cwd");
    let repo_slug: Option<Option<String>> = match fs.get("repoSlug") {
        None => None,
        Some(Json::Null) => Some(None),
        Some(v) => Some(v.as_string()),
    };
    let attributed = fs.get("attributed").and_then(|a| a.as_bool());
    let id = FileSyncIdentity { family: &family, cwd: cwd.as_deref(), repo_slug: repo_slug.as_ref().map(|r| r.as_deref()), attributed };
    should_skip_file(settings, &id)
}

/// `filterWatched`: drop files the settings keep local and tombstoned sessions.
pub fn filter_watched(files: Vec<DiscoveredFile>, state: &Json, settings: &HxSettings) -> Vec<DiscoveredFile> {
    // With no tombstone and settings that keep nothing local, every file stays.
    let has_deleted = state.get("deletedSessions").and_then(|m| m.as_obj()).map(|m| !m.is_empty()).unwrap_or(false);
    let settings_can_skip = !settings.personal_sync || !settings.excluded_folders.is_empty() || !settings.exclude_rules.is_empty();
    if !has_deleted && !settings_can_skip {
        return files;
    }
    files
        .into_iter()
        .filter(|f| {
            let fs = match state.get("files").and_then(|m| m.get(&f.path)) {
                Some(fs) => fs,
                None => return true,
            };
            let family = fs.get_string("family").unwrap_or_default();
            let sid = fs.get_string("sessionId").unwrap_or_default();
            if Store::is_deleted_session(state, &family, &sid) {
                return false;
            }
            !should_skip_entry(settings, fs)
        })
        .collect()
}

/// `electUploaders`: one uploader per canonical, newest mtime wins (tie:
/// largest); the twins are announced once per process when `log` is given.
pub fn elect_uploaders(files: Vec<DiscoveredFile>, state: &Json, log: Option<&dyn Fn(&str)>) -> Vec<DiscoveredFile> {
    let mut by_key: Vec<(String, Vec<DiscoveredFile>)> = Vec::new();
    let mut key_index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut active: Vec<DiscoveredFile> = Vec::new();
    for f in files {
        let fs = match state.get("files").and_then(|m| m.get(&f.path)) {
            Some(fs) => fs,
            None => {
                active.push(f);
                continue;
            }
        };
        let key = format!("{}:{}", fs.get_string("family").unwrap_or_default(), fs.get_string("sessionId").unwrap_or_default());
        let i = *key_index.entry(key.clone()).or_insert_with(|| {
            by_key.push((key.clone(), Vec::new()));
            by_key.len() - 1
        });
        by_key[i].1.push(f);
    }
    for (_, mut list) in by_key {
        list.sort_by(|a, b| b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(std::cmp::Ordering::Equal).then(b.size.cmp(&a.size)));
        let winner = list.remove(0);
        if let Some(log) = log {
            for twin in &list {
                if note_shadowed(&twin.path) {
                    log(&format!("[hx] {} shadows {} (same session); not uploading the twin", twin.path, winner.path));
                }
            }
        }
        active.push(winner);
    }
    active
}

/// `snapshotFrom`: done = the least-current real destination caught up and
/// no hold latched; totalBytes covers every file.
pub fn snapshot_from(files: &[DiscoveredFile], state: &Json) -> SyncSnapshot {
    let ever = ever_written_keys(state);
    let mut done = 0u64;
    let mut total_bytes = 0u64;
    for f in files {
        let fs = state.get("files").and_then(|m| m.get(&f.path));
        let offset = fs.map(|e| reportable_offset(e, state, &ever)).unwrap_or(0.0);
        let held = fs.and_then(|e| e.get("skipReason")).map(|v| v.truthy()).unwrap_or(false);
        if offset >= f.size as f64 && !held {
            done += 1;
        }
        total_bytes += f.size;
    }
    SyncSnapshot { total: files.len() as u64, done, total_bytes }
}

/// `computeSyncSnapshot`: a one-shot catch-up snapshot over the windowed discovery.
pub fn compute_sync_snapshot(store: &Store, only: Option<&str>, roots_override: Option<&ResolvedRoots>) -> SyncSnapshot {
    let settings = read_settings();
    let resolved;
    let roots = match roots_override {
        Some(r) => r,
        None => {
            resolved = resolve_data_roots(&settings);
            &resolved
        }
    };
    let now = now_ms();
    let mut files = discover_claude_files(&roots.claude, Some(RECENT_WINDOW_MS), now);
    files.extend(discover_codex_files(&roots.codex, true, Some(RECENT_WINDOW_MS), now));
    if let Some(only) = only {
        files.retain(|f| f.path == only);
    }
    store.read(|state| snapshot_from(&filter_watched(elect_uploaders(files, state, None), state, &settings), state))
}

/// `collectSkipped`: the still-on-disk sessions waiting on an unavailable store.
pub fn collect_skipped(files: &[DiscoveredFile], state: &Json) -> Vec<SyncSkippedEntry> {
    let discovered: HashSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
    let mut out: Vec<SyncSkippedEntry> = Vec::new();
    if let Some(map) = state.get("files").and_then(|m| m.as_obj()) {
        for (p, fs) in map.iter() {
            let reason = match fs.get("skipReason") {
                Some(v) if v.truthy() => crate::js::lossy(&v.to_js_string()),
                _ => continue,
            };
            if !discovered.contains(p.as_str()) {
                continue;
            }
            out.push(SyncSkippedEntry {
                path: p.clone(),
                family: fs.get_string("family").unwrap_or_default(),
                session_id: fs.get_string("sessionId").unwrap_or_default(),
                reason,
                next_attempt_at_ms: fs.get_f64("nextAttemptAtMs"),
                blocker: fs.get("blocker").cloned(),
            });
        }
    }
    out
}

/// `collectBehind`: never-finished uploads whose file left discovery, split
/// into behind (under a watched root) and unwatched (distinct sessions under
/// no current root).
pub fn collect_behind(state: &Json, discovered: &HashSet<String>, live_sessions: &HashSet<String>, roots: &[DataRoot]) -> (Vec<SyncBehindEntry>, usize) {
    let mut behind: Vec<SyncBehindEntry> = Vec::new();
    let mut behind_sessions: HashSet<String> = HashSet::new();
    let mut unwatched_sessions: HashSet<String> = HashSet::new();
    if let Some(map) = state.get("files").and_then(|m| m.as_obj()) {
        for (p, fs) in map.iter() {
            if discovered.contains(p) {
                continue;
            }
            let family = fs.get_string("family").unwrap_or_default();
            let sid = fs.get_string("sessionId").unwrap_or_default();
            if Store::is_deleted_session(state, &family, &sid) {
                continue;
            }
            let session_key = format!("{}:{}", family, sid);
            if live_sessions.contains(&session_key) {
                continue;
            }
            let last_known = match fs.get_f64("lastKnownSize") {
                Some(n) => n,
                None => continue,
            };
            let uploaded = fs_min_offset(fs);
            if uploaded >= last_known {
                continue;
            }
            if !is_under_roots(p, roots) {
                unwatched_sessions.insert(session_key);
                continue;
            }
            behind_sessions.insert(session_key);
            behind.push(SyncBehindEntry { path: p.clone(), session_id: sid, uploaded, last_known_size: last_known, source_gone: !exists(Path::new(p)) });
        }
    }
    for key in &behind_sessions {
        unwatched_sessions.remove(key);
    }
    (behind, unwatched_sessions.len())
}

fn attributed_text(fs: Option<&Json>) -> String {
    match fs.and_then(|f| f.get("attributed")) {
        Some(v) => crate::js::lossy(&v.to_js_string()),
        None => "undefined".to_string(),
    }
}

/// `computeSyncReport`: UNWINDOWED discovery, election, the settings filter
/// with its reasons, the gaps, the child-lane counts and the ledger.
pub fn compute_sync_report(store: &Store, roots_override: Option<&ResolvedRoots>) -> Result<SyncReport, String> {
    let settings = read_settings();
    let resolved;
    let roots = match roots_override {
        Some(r) => r,
        None => {
            resolved = resolve_data_roots(&settings);
            &resolved
        }
    };
    let now = now_ms();
    let mut all = discover_claude_files(&roots.claude, None, now);
    all.extend(discover_codex_files(&roots.codex, true, None, now));
    Ok(store.read(|state| compute_sync_report_from(state, roots, all, &settings)))
}

/// `computeSyncReport(roots, injected)`: the report over files a caller has
/// already discovered (the `hx ui` server's cached sweep) and a given state.
pub fn compute_sync_report_from(state: &Json, roots: &ResolvedRoots, all: Vec<DiscoveredFile>, settings: &HxSettings) -> SyncReport {
    let org_names = read_org_names();
    let settings = settings.clone();
    let report = (|state: &Json| {
        let discovered: HashSet<String> = all.iter().map(|f| f.path.clone()).collect();
        let mut live_sessions: HashSet<String> = HashSet::new();
        for f in &all {
            if let Some(fs) = state.get("files").and_then(|m| m.get(&f.path)) {
                live_sessions.insert(format!("{}:{}", fs.get_string("family").unwrap_or_default(), fs.get_string("sessionId").unwrap_or_default()));
            }
        }
        let all_roots: Vec<DataRoot> = roots.claude.iter().chain(roots.codex.iter()).cloned().collect();
        let (behind, unwatched) = collect_behind(state, &discovered, &live_sessions, &all_roots);
        let pre_filter = elect_uploaders(all.clone(), state, None);
        let elected = filter_watched(pre_filter.clone(), state, &settings);
        let kept: HashSet<&str> = elected.iter().map(|f| f.path.as_str()).collect();
        let excluded: Vec<Json> = pre_filter
            .iter()
            .filter(|f| !kept.contains(f.path.as_str()))
            .map(|f| {
                let fs = state.get("files").and_then(|m| m.get(&f.path));
                let family = fs.and_then(|x| x.get_string("family"));
                let sid = fs.and_then(|x| x.get_string("sessionId"));
                let cwd = fs.and_then(|x| x.get_string("cwd"));
                let folder_hit = settings.excluded_folders.iter().any(|e| Some(e.family.as_str()) == family.as_deref() && Some(e.cwd.as_str()) == cwd.as_deref());
                let reason = match fs {
                    None => "no state entry".to_string(),
                    Some(x) => {
                        if Store::is_deleted_session(state, family.as_deref().unwrap_or(""), sid.as_deref().unwrap_or("")) {
                            "deleted on the server (tombstoned)".to_string()
                        } else if folder_hit {
                            format!("excluded folder {}", cwd.clone().unwrap_or_else(|| "?".to_string()))
                        } else if !settings.exclude_rules.is_empty() && cwd.as_ref().map(|c| !c.is_empty()).unwrap_or(false) {
                            format!("matched an exclude rule (cwd {})", cwd.clone().unwrap_or_default())
                        } else {
                            let slug = match x.get("repoSlug") {
                                Some(v) if !v.is_null() => crate::js::lossy(&v.to_js_string()),
                                _ => "null".to_string(),
                            };
                            format!("personal-sync gate: personalSync={}, repoSlug={}, attributed={}", settings.personal_sync, slug, attributed_text(fs))
                        }
                    }
                };
                let nullish = |v: Option<&Json>| match v {
                    None | Some(Json::Null) => Json::Null,
                    Some(x) => x.clone(),
                };
                obj(vec![
                    ("path", Json::str(&f.path)),
                    ("family", Json::str(family.as_deref().unwrap_or("unknown"))),
                    ("sessionId", Json::str(sid.as_deref().unwrap_or("unknown"))),
                    ("repoSlug", nullish(fs.and_then(|x| x.get("repoSlug")))),
                    ("cwd", nullish(fs.and_then(|x| x.get("cwd")))),
                    ("attributed", nullish(fs.and_then(|x| x.get("attributed")))),
                    ("reason", Json::str(&reason)),
                ])
            })
            .collect();
        let mut file_gone = 0u64;
        let mut on_disk_undiscovered = 0u64;
        let mut child = ChildLanes::default();
        if let Some(map) = state.get("files").and_then(|m| m.as_obj()) {
            for (p, fs) in map.iter() {
                if p.contains("/subagents/") || p.contains("/workflows/") {
                    child.tracked += 1;
                    let here = exists(Path::new(p));
                    if here {
                        child.on_disk += 1;
                    } else {
                        child.gone += 1;
                    }
                    if here {
                        if let Some(last_known) = fs.get_f64("lastKnownSize") {
                            if fs_min_offset(fs) < last_known {
                                child.owing += 1;
                                child.owed_bytes += last_known - fs_min_offset(fs);
                            }
                        }
                    }
                    continue;
                }
                if discovered.contains(p) {
                    continue;
                }
                if exists(Path::new(p)) {
                    on_disk_undiscovered += 1;
                } else {
                    file_gone += 1;
                }
            }
        }
        let snapshot = snapshot_from(&elected, state);
        let skipped = collect_skipped(&elected, state);
        let incomplete: HashSet<&str> = behind.iter().map(|b| b.session_id.as_str()).collect();
        let ledger_files: Vec<LedgerFile> = elected.iter().map(|f| LedgerFile { path: f.path.clone(), size: f.size, mtime_ms: f.mtime_ms }).collect();
        let ledger = build_ledger(&ledger_files, state, incomplete.len() as u64, now_ms(), &org_names);
        SyncReport {
            snapshot_total: snapshot.total,
            snapshot_done: snapshot.done,
            snapshot_total_bytes: snapshot.total_bytes,
            behind,
            skipped,
            ledger,
            excluded,
            undiscovered_file_gone: file_gone,
            undiscovered_on_disk: on_disk_undiscovered,
            child_lanes: child,
            unwatched: unwatched as u64,
        }
    })(state);
    report
}

/// The offsets of a file entry as the stuck line prints them: `key at off/size`.
pub fn owed_summary(fs: &Json, size: u64) -> String {
    let owed: Vec<String> = fs_offsets(fs)
        .into_iter()
        .filter(|(_, v)| size as f64 - v > 0.0)
        .map(|(k, v)| format!("{} at {}/{}", k, crate::js::num_to_string(v), size))
        .collect();
    if owed.is_empty() {
        "no destinations recorded".to_string()
    } else {
        owed.join(", ")
    }
}
