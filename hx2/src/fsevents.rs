//! File events as hints for the discovery catalog (src/fs-events.ts): one
//! recursive watch per data-root directory; every event names a path the
//! catalog re-checks on its next tick. Nothing an event says is believed
//! without the same stat the polling sweep would have made.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::roots::{claude_projects_dir, codex_archived_dir, codex_sessions_dir, ResolvedRoots};

/// The directories the client reads transcripts, lanes and trackers from.
pub fn event_dirs_for(roots: &ResolvedRoots) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for r in &roots.claude {
        out.push(PathBuf::from(claude_projects_dir(&r.config_dir)));
        out.push(Path::new(&r.config_dir).join("sessions"));
    }
    for r in &roots.codex {
        out.push(PathBuf::from(codex_sessions_dir(&r.config_dir)));
        out.push(PathBuf::from(codex_archived_dir(&r.config_dir)));
    }
    out
}

pub struct FileEventSource {
    watcher: Mutex<RecommendedWatcher>,
    watched: Mutex<Vec<PathBuf>>,
    missing: Mutex<Vec<PathBuf>>,
    failed: Arc<Mutex<Option<String>>>,
}

impl FileEventSource {
    /// Watch every directory of the roots, recursively. None (with the reason
    /// reported through `on_failure`) when a directory cannot be watched.
    pub fn arm(roots: &ResolvedRoots, on_hint: Arc<dyn Fn(PathBuf) + Send + Sync>, on_failure: Arc<dyn Fn(String) + Send + Sync>) -> Option<FileEventSource> {
        let failed: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let failed_cb = failed.clone();
        let on_failure_cb = on_failure.clone();
        let watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| match res {
            Ok(ev) => {
                for p in ev.paths {
                    on_hint(p);
                }
            }
            Err(e) => {
                let mut f = failed_cb.lock().unwrap_or_else(|x| x.into_inner());
                if f.is_none() {
                    let reason = format!("{}", e);
                    *f = Some(reason.clone());
                    on_failure_cb(reason);
                }
            }
        });
        let watcher = match watcher {
            Ok(w) => w,
            Err(e) => {
                on_failure(format!("watcher: {}", e));
                return None;
            }
        };
        let src = FileEventSource { watcher: Mutex::new(watcher), watched: Mutex::new(Vec::new()), missing: Mutex::new(Vec::new()), failed };
        for dir in event_dirs_for(roots) {
            if !src.arm_one(&dir, &on_failure) {
                return None;
            }
        }
        Some(src)
    }

    fn arm_one(&self, dir: &Path, on_failure: &Arc<dyn Fn(String) + Send + Sync>) -> bool {
        if !dir.exists() {
            let mut m = self.missing.lock().unwrap_or_else(|e| e.into_inner());
            if !m.iter().any(|d| d == dir) {
                m.push(dir.to_path_buf());
            }
            return true;
        }
        let r = self.watcher.lock().unwrap_or_else(|e| e.into_inner()).watch(dir, RecursiveMode::Recursive);
        match r {
            Ok(()) => {
                self.watched.lock().unwrap_or_else(|e| e.into_inner()).push(dir.to_path_buf());
                self.missing.lock().unwrap_or_else(|e| e.into_inner()).retain(|d| d != dir);
                true
            }
            Err(e) => {
                on_failure(format!("{}: {}", dir.to_string_lossy(), e));
                false
            }
        }
    }

    /// Retry the directories that were missing — a root that appeared since.
    pub fn rearm(&self, on_failure: &Arc<dyn Fn(String) + Send + Sync>) {
        if self.failed.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
            return;
        }
        let missing: Vec<PathBuf> = self.missing.lock().unwrap_or_else(|e| e.into_inner()).clone();
        for dir in missing {
            let _ = self.arm_one(&dir, on_failure);
        }
    }

    pub fn has_failed(&self) -> bool {
        self.failed.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }
}
