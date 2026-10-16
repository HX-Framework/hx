//! `~/.let/hx/state.json` and its offsets journal (src/state.ts).
//!
//! The state is kept as the JSON object the TypeScript client keeps, mutated
//! in place like a JavaScript object, so the snapshot on disk has the same
//! shape, the same compact encoding and the same numbers. A durable mutation
//! appends one line to `state.journal.jsonl`; the snapshot is rewritten at a
//! checkpoint (the journal's size or age bound inside the daemon, every exit
//! that is not a kill, and the end of every one-shot pass). Every reader
//! replays the journal over the snapshot.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use crate::fsutil::{exists, now_ms, write_atomic_0600, write_file_0600, append_file_0600};
use crate::home::hx_dir;
use crate::json::{obj, Json, OMap};
use crate::net::Blocker;
use crate::roots::{root_json, ResolvedRoots};

pub const FILE_BACKOFF_CAP_MS: f64 = 30.0 * 60_000.0;
pub const HEAL_MAX_CONSECUTIVE: f64 = 3.0;
pub const HEAL_PAUSE_MS: f64 = 6.0 * 60.0 * 60_000.0;
pub const CHECKPOINT_INTERVAL_MS: f64 = 10.0 * 60_000.0;
pub const CHECKPOINT_JOURNAL_BYTES: u64 = 4 * 1024 * 1024;
/// The least time between two coalesced snapshot writes. The TypeScript
/// client's mutators wait for the queued write, so its upload pool runs at
/// the pace of its own snapshot rewrites; hx2's mutators do not wait, and this
/// gap bounds how often the writer thread rewrites a multi-megabyte file
/// while a catch-up changes the state thousands of times a second. The
/// snapshot on disk is at most this far behind the state in memory, and
/// every committed offset is in the journal before the next step regardless.
const SNAPSHOT_WRITE_GAP_MS: u64 = 100;
const DELETED_SESSION_RETENTION_MS: f64 = 60.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// Stable per-destination state key: null (the let.ai bucket) → "letai".
pub fn dest_key(vault_org_id: Option<&str>) -> String {
    vault_org_id.map(|s| s.to_string()).unwrap_or_else(|| "letai".to_string())
}

// ── FileState helpers over the JSON entry ───────────────────────────────────

pub fn fs_str(f: &Json, key: &str) -> Option<String> {
    f.get_string(key)
}

pub fn fs_num(f: &Json, key: &str) -> Option<f64> {
    f.get_f64(key)
}

pub fn fs_has(f: &Json, key: &str) -> bool {
    f.get(key).is_some()
}

/// The `offsets` map as (destKey, offset) pairs.
pub fn fs_offsets(f: &Json) -> Vec<(String, f64)> {
    match f.get("offsets").and_then(|o| o.as_obj()) {
        Some(o) => o.iter().filter_map(|(k, v)| v.as_f64().map(|n| (k.clone(), n))).collect(),
        None => Vec::new(),
    }
}

pub fn fs_offset_for(f: &Json, vault_org_id: Option<&str>) -> f64 {
    let k = dest_key(vault_org_id);
    fs_offsets(f).into_iter().find(|(key, _)| *key == k).map(|(_, v)| v).unwrap_or(0.0)
}

/// Lowest committed offset across all known destinations (0 if none yet).
pub fn fs_min_offset(f: &Json) -> f64 {
    let mut min = f64::INFINITY;
    let mut any = false;
    if let Some(o) = f.get("offsets").and_then(|o| o.as_obj()) {
        for (_, v) in o.iter() {
            if let Some(n) = v.as_f64() {
                any = true;
                if n < min {
                    min = n;
                }
            }
        }
    }
    if any {
        min
    } else {
        0.0
    }
}

/// `migrateFileState`: a persisted entry in the per-destination shape.
pub fn migrate_file_state(s: &Json) -> Json {
    let mut out = OMap::new();
    let copy = |out: &mut OMap, key: &str| {
        if let Some(v) = s.get(key) {
            out.set(key, v.clone());
        }
    };
    copy(&mut out, "path");
    copy(&mut out, "family");
    copy(&mut out, "sessionId");
    let offsets = match s.get("offsets") {
        Some(o) if o.as_obj().is_some() => o.clone(),
        _ => match s.get("offset").and_then(|v| v.as_f64()) {
            Some(n) => obj(vec![("letai", Json::num(n))]),
            None => Json::obj(),
        },
    };
    out.set("offsets", offsets);
    copy(&mut out, "lastMtimeMs");
    copy(&mut out, "lastUploadAtMs");
    copy(&mut out, "repoSlug");
    copy(&mut out, "cwd");
    copy(&mut out, "attributionVersion");
    copy(&mut out, "titleSyncVersion");
    copy(&mut out, "lastKnownSize");
    copy(&mut out, "consecutiveFailures");
    copy(&mut out, "nextAttemptAtMs");
    copy(&mut out, "skipReason");
    copy(&mut out, "blocker");
    copy(&mut out, "healCount");
    copy(&mut out, "healPausedUntilMs");
    Json::Obj(out)
}

// ── The store ───────────────────────────────────────────────────────────────

struct Inner {
    state: Json,
    coalesced: bool,
    dirty_all: bool,
    dirty_files: BTreeSet<String>,
    dirty_dests: BTreeSet<String>,
    dirty_artifacts: BTreeSet<String>,
    dirty_chunk_caps: BTreeSet<String>,
    dirty_deleted: bool,
    journal_bytes: u64,
    last_checkpoint_ms: f64,
}

impl Inner {
    fn is_dirty(&self) -> bool {
        self.dirty_all
            || !self.dirty_files.is_empty()
            || !self.dirty_dests.is_empty()
            || !self.dirty_artifacts.is_empty()
            || !self.dirty_chunk_caps.is_empty()
            || self.dirty_deleted
    }

    fn clear_dirty(&mut self) {
        self.dirty_all = false;
        self.dirty_files.clear();
        self.dirty_dests.clear();
        self.dirty_artifacts.clear();
        self.dirty_chunk_caps.clear();
        self.dirty_deleted = false;
    }
}

enum Mark {
    All,
    File(String),
    Dest(String),
    Dests(Vec<String>),
    Artifact(String),
    ChunkCap(String),
    DeletedSessions,
}

pub struct Store {
    state_path: PathBuf,
    journal_path: PathBuf,
    inner: Mutex<Inner>,
    /// Serializes every disk operation: snapshot writes, journal appends, checkpoints.
    io: Mutex<()>,
    /// A whole-snapshot write is wanted (flush-through mode). One writer thread
    /// serves it, and every mutation that lands while a write is in flight is
    /// included in the next one — the TypeScript client's queued write, where
    /// concurrent callers piggyback on the write already scheduled.
    persist_requested: Mutex<bool>,
    persist_cv: Condvar,
    /// One snapshot text is built at a time: the writer thread and `drain`.
    write_lock: Mutex<()>,
    /// Bumped by every checkpoint, so a coalesced write serialized before a
    /// checkpoint is not written over the newer snapshot the checkpoint left.
    checkpoint_gen: AtomicU64,
    /// The last snapshot's length, the capacity hint for the next one.
    last_snapshot_len: AtomicUsize,
    /// Moves on every mutation of the state (see `generation`).
    mutations: AtomicU64,
}

fn apply_journal_entry(state: &mut Json, e: &Json) -> bool {
    let t = match e.get_string("t") {
        Some(t) => t,
        None => return false,
    };
    match t.as_str() {
        "file" => {
            let path = match e.get_string("path") {
                Some(p) if !p.is_empty() => p,
                _ => return false,
            };
            let st = match e.get("state") {
                Some(s) if s.as_obj().is_some() => s,
                _ => return false,
            };
            let migrated = migrate_file_state(st);
            if let Some(files) = state.as_obj_mut().and_then(|o| o.get_mut("files")) {
                files.set(&path, migrated);
            }
            true
        }
        "dest" => {
            let key = match e.get_string("key") {
                Some(k) if !k.is_empty() => k,
                _ => return false,
            };
            let record = match e.get("record") {
                Some(r) if r.truthy() => r.clone(),
                _ => return false,
            };
            ensure_obj(state, "destinations").set(&key, record);
            true
        }
        "artifact" => {
            let key = match e.get_string("key") {
                Some(k) if !k.is_empty() => k,
                _ => return false,
            };
            let hash = match e.get("hash") {
                Some(Json::Str(_)) => e.get("hash").cloned().unwrap_or(Json::Null),
                _ => return false,
            };
            ensure_obj(state, "artifacts").set(&key, hash);
            true
        }
        "chunkCap" => {
            let key = match e.get_string("key") {
                Some(k) if !k.is_empty() => k,
                _ => return false,
            };
            let cap = match e.get("cap") {
                Some(Json::Num(_)) => e.get("cap").cloned().unwrap_or(Json::Null),
                _ => return false,
            };
            ensure_obj(state, "chunkCaps").set(&key, cap);
            true
        }
        "deletedSessions" => {
            let map = match e.get("map") {
                Some(m) if m.as_obj().is_some() => m.clone(),
                _ => return false,
            };
            state.set("deletedSessions", map);
            true
        }
        _ => false,
    }
}

/// `(state[key] ??= {})`
fn ensure_obj<'a>(state: &'a mut Json, key: &str) -> &'a mut Json {
    let o = state.as_obj_mut().expect("state is an object");
    if !o.get(key).map(|v| v.as_obj().is_some()).unwrap_or(false) {
        o.set(key, Json::obj());
    }
    o.get_mut(key).expect("present")
}

fn seed_destinations_from_blockers(state: &mut Json) {
    if state.get("destinations").is_some() {
        return;
    }
    let mut reports: Vec<DestinationReport> = Vec::new();
    let mut earliest = now_ms();
    if let Some(files) = state.get("files").and_then(|f| f.as_obj()) {
        for (_, f) in files.iter() {
            let blocker = match f.get("blocker") {
                Some(b) if b.truthy() => b,
                _ => continue,
            };
            if let Some(first) = blocker.get_f64("firstSeenAtMs") {
                if first < earliest {
                    earliest = first;
                }
            }
            if let Some(dests) = blocker.get("destinations").and_then(|d| d.as_arr()) {
                for d in dests {
                    let id = match d.get_string("vaultOrgId") {
                        Some(id) => id,
                        None => continue,
                    };
                    let key = dest_key(Some(&id));
                    reports.retain(|r| dest_key(r.vault_org_id.as_deref()) != key);
                    reports.push(DestinationReport {
                        vault_org_id: Some(id),
                        status: "held",
                        org_name: d.get_string("orgName"),
                        org_slug: d.get_string("orgSlug"),
                        last_seen_at: d.get_string("lastSeenAt"),
                    });
                }
            }
        }
    }
    if reports.is_empty() {
        return;
    }
    apply_destination_reports(state, &reports, earliest);
}

#[derive(Clone, Debug)]
pub struct DestinationReport {
    pub vault_org_id: Option<String>,
    /// "ready" | "held"
    pub status: &'static str,
    pub org_name: Option<String>,
    pub org_slug: Option<String>,
    pub last_seen_at: Option<String>,
}

/// `applyDestinationReports`: fold the gateway's destination set into the registry.
fn apply_destination_reports(state: &mut Json, reports: &[DestinationReport], now: f64) -> bool {
    if reports.is_empty() {
        return false;
    }
    let registry = ensure_obj(state, "destinations");
    let mut changed = false;
    for r in reports {
        let key = dest_key(r.vault_org_id.as_deref());
        let prev = registry.get(&key).cloned();
        let prev_status = prev.as_ref().and_then(|p| p.get_string("status"));
        let pick = |field: &str, fresh: &Option<String>| -> Json {
            match fresh {
                Some(v) => Json::str(v),
                None => prev.as_ref().and_then(|p| p.get(field)).filter(|v| !v.is_null()).cloned().unwrap_or(Json::Null),
            }
        };
        let org_name = pick("orgName", &r.org_name);
        let org_slug = pick("orgSlug", &r.org_slug);
        let last_seen_at = pick("lastSeenAt", &r.last_seen_at);
        let held_since: Option<f64> = if r.status == "held" {
            if prev_status.as_deref() == Some("held") {
                prev.as_ref().and_then(|p| p.get_f64("heldSinceMs"))
            } else {
                Some(now)
            }
        } else {
            None
        };
        let mut next = obj(vec![
            ("vaultOrgId", Json::opt_str(r.vault_org_id.as_deref())),
            ("status", Json::str(r.status)),
            ("orgName", org_name.clone()),
            ("orgSlug", org_slug.clone()),
            ("lastSeenAt", last_seen_at.clone()),
        ]);
        if let Some(h) = held_since {
            next.set("heldSinceMs", Json::num(h));
        }
        next.set("observedAtMs", Json::num(now));
        let same = match &prev {
            Some(p) => {
                p.get_string("status").as_deref() == Some(r.status)
                    && json_eq(p.get("orgName"), Some(&org_name))
                    && json_eq(p.get("orgSlug"), Some(&org_slug))
                    && json_eq(p.get("lastSeenAt"), Some(&last_seen_at))
                    && p.get_f64("heldSinceMs") == held_since
            }
            None => false,
        };
        if same {
            if let Some(p) = registry.as_obj_mut().and_then(|o| o.get_mut(&key)) {
                p.set("observedAtMs", Json::num(now));
            }
            continue;
        }
        registry.set(&key, next);
        changed = true;
    }
    changed
}

fn json_eq(a: Option<&Json>, b: Option<&Json>) -> bool {
    let norm = |v: Option<&Json>| -> String {
        match v {
            None | Some(Json::Null) => "null".to_string(),
            Some(x) => x.stringify(),
        }
    };
    norm(a) == norm(b)
}

impl Store {
    /// `loadState`: the snapshot, then the journal replayed over it. The
    /// returned store owns a writer thread for the coalesced snapshot writes.
    pub fn load(scope: &str) -> Arc<Store> {
        let (snapshot, journal) = if scope == "local" { ("state.local.json", "state.local.journal.jsonl") } else { ("state.json", "state.journal.jsonl") };
        let state_path = hx_dir().join(snapshot);
        let journal_path = hx_dir().join(journal);
        let mut state = match fs::read_to_string(&state_path) {
            Ok(raw) => match Json::parse(&raw) {
                Ok(v) if v.as_obj().is_some() => v,
                _ => obj(vec![("files", Json::obj())]),
            },
            Err(_) => obj(vec![("files", Json::obj())]),
        };
        if !state.get("files").map(|f| f.truthy()).unwrap_or(false) {
            state.set("files", Json::obj());
        }
        // Upgrade legacy single-offset entries to the per-destination shape.
        let migrated: Vec<(String, Json)> = state
            .get("files")
            .and_then(|f| f.as_obj())
            .map(|o| o.iter().map(|(k, v)| (k.clone(), migrate_file_state(v))).collect())
            .unwrap_or_default();
        if let Some(files) = state.as_obj_mut().and_then(|o| o.get_mut("files")) {
            for (k, v) in migrated {
                files.set(&k, v);
            }
        }
        let journal_text = fs::read_to_string(&journal_path).unwrap_or_default();
        for line in journal_text.split('\n') {
            if line.is_empty() {
                continue;
            }
            if let Ok(e) = Json::parse(line) {
                apply_journal_entry(&mut state, &e);
            }
        }
        seed_destinations_from_blockers(&mut state);
        let store = Arc::new(Store {
            state_path,
            journal_path,
            inner: Mutex::new(Inner {
                state,
                coalesced: false,
                dirty_all: false,
                dirty_files: BTreeSet::new(),
                dirty_dests: BTreeSet::new(),
                dirty_artifacts: BTreeSet::new(),
                dirty_chunk_caps: BTreeSet::new(),
                dirty_deleted: false,
                journal_bytes: journal_text.len() as u64,
                last_checkpoint_ms: now_ms(),
            }),
            io: Mutex::new(()),
            persist_requested: Mutex::new(false),
            persist_cv: Condvar::new(),
            write_lock: Mutex::new(()),
            checkpoint_gen: AtomicU64::new(0),
            last_snapshot_len: AtomicUsize::new(0),
            mutations: AtomicU64::new(0),
        });
        let writer = store.clone();
        std::thread::Builder::new()
            .name("hx-state-writer".to_string())
            .spawn(move || {
                let gap = std::time::Duration::from_millis(SNAPSHOT_WRITE_GAP_MS);
                let mut last_write: Option<std::time::Instant> = None;
                loop {
                    {
                        let mut wanted = writer.persist_requested.lock().unwrap_or_else(|e| e.into_inner());
                        while !*wanted {
                            wanted = writer.persist_cv.wait(wanted).unwrap_or_else(|e| e.into_inner());
                        }
                    }
                    if let Some(t) = last_write {
                        let since = t.elapsed();
                        if since < gap {
                            std::thread::sleep(gap - since);
                        }
                    }
                    last_write = Some(std::time::Instant::now());
                    writer.write_requested_snapshot();
                }
            })
            .ok();
        store
    }

    /// One coalesced snapshot write. The request is cleared first, so a
    /// mutation that lands during the write is served by the next one; the
    /// text is built off the disk lock, and a checkpoint that wrote a newer
    /// snapshot in the meantime makes this write unnecessary.
    fn write_requested_snapshot(&self) {
        let _w = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let gen = {
            let mut wanted = self.persist_requested.lock().unwrap_or_else(|e| e.into_inner());
            if !*wanted {
                return;
            }
            *wanted = false;
            self.checkpoint_gen.load(Ordering::SeqCst)
        };
        let text = self.serialize();
        let _io = self.io.lock().unwrap_or_else(|e| e.into_inner());
        if self.checkpoint_gen.load(Ordering::SeqCst) != gen {
            return;
        }
        if self.write_snapshot(&text).is_err() {
            let _ = self.write_snapshot(&text);
        }
    }

    /// Finish any snapshot write still wanted — a one-shot process calls this
    /// before it exits, so its last bookkeeping is on disk the way the
    /// TypeScript client's awaited writes are.
    pub fn drain(&self) {
        self.write_requested_snapshot();
    }

    pub fn journal_path(&self) -> &PathBuf {
        &self.journal_path
    }

    /// Read the state under the lock.
    pub fn read<R>(&self, f: impl FnOnce(&Json) -> R) -> R {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(&g.state)
    }

    /// Mutate the state in place without persisting (callers persist explicitly).
    pub fn mutate<R>(&self, f: impl FnOnce(&mut Json) -> R) -> R {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.mutations.fetch_add(1, Ordering::Relaxed);
        f(&mut g.state)
    }

    /// How many times the state was mutated since the load: a tick compares
    /// it with the last tick's to know whether anything it decides on moved.
    pub fn generation(&self) -> u64 {
        self.mutations.load(Ordering::Relaxed)
    }

    pub fn file(&self, path: &str) -> Option<Json> {
        self.read(|s| s.get("files").and_then(|f| f.get(path)).cloned())
    }

    pub fn arm_coalesced(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).coalesced = true;
    }

    pub fn disarm_coalesced(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).coalesced = false;
    }

    // ── Disk ────────────────────────────────────────────────────────────────

    fn serialize(&self) -> String {
        let last = self.last_snapshot_len.load(Ordering::Relaxed);
        let text = self.read(|s| s.stringify_with_capacity(last + last / 8 + 1024));
        self.last_snapshot_len.store(text.len(), Ordering::Relaxed);
        text
    }

    fn write_snapshot(&self, text: &str) -> std::io::Result<()> {
        let _ = fs::create_dir_all(hx_dir());
        write_atomic_0600(&self.state_path, text.as_bytes())
    }

    /// Ask the writer thread for a whole-snapshot write; concurrent requests
    /// collapse into one write that carries every mutation made so far.
    fn schedule_persist(&self) {
        let mut wanted = self.persist_requested.lock().unwrap_or_else(|e| e.into_inner());
        *wanted = true;
        self.persist_cv.notify_one();
    }

    fn mark(&self, inner: &mut Inner, mark: Mark) {
        match mark {
            Mark::All => inner.dirty_all = true,
            Mark::File(p) => {
                inner.dirty_files.insert(p);
            }
            Mark::Dest(k) => {
                inner.dirty_dests.insert(k);
            }
            Mark::Dests(ks) => {
                for k in ks {
                    inner.dirty_dests.insert(k);
                }
            }
            Mark::Artifact(k) => {
                inner.dirty_artifacts.insert(k);
            }
            Mark::ChunkCap(k) => {
                inner.dirty_chunk_caps.insert(k);
            }
            Mark::DeletedSessions => inner.dirty_deleted = true,
        }
    }

    /// `persistOrMark`: whole snapshot now (flush-through), or a dirty mark (coalesced).
    fn persist_or_mark(&self, mark: Mark) {
        let coalesced = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if g.coalesced {
                self.mark(&mut g, mark);
                true
            } else {
                false
            }
        };
        if !coalesced {
            self.schedule_persist();
        }
    }

    fn append_journal_lines(&self, entries: &[Json]) -> std::io::Result<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut text = String::new();
        for e in entries {
            text.push_str(&e.stringify());
            text.push('\n');
        }
        let _g = self.io.lock().unwrap_or_else(|e| e.into_inner());
        let _ = fs::create_dir_all(hx_dir());
        let r = append_file_0600(&self.journal_path, text.as_bytes()).or_else(|_| append_file_0600(&self.journal_path, text.as_bytes()));
        if r.is_ok() {
            self.inner.lock().unwrap_or_else(|e| e.into_inner()).journal_bytes += text.len() as u64;
        }
        r
    }

    /// `journalThrough`: append the records now, in both modes, and drop their dirty marks.
    fn journal_through(&self, entries: Vec<Json>) {
        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            for e in &entries {
                match e.get_string("t").as_deref() {
                    Some("file") => {
                        if let Some(p) = e.get_string("path") {
                            g.dirty_files.remove(&p);
                        }
                    }
                    Some("dest") => {
                        if let Some(k) = e.get_string("key") {
                            g.dirty_dests.remove(&k);
                        }
                    }
                    Some("artifact") => {
                        if let Some(k) = e.get_string("key") {
                            g.dirty_artifacts.remove(&k);
                        }
                    }
                    Some("chunkCap") => {
                        if let Some(k) = e.get_string("key") {
                            g.dirty_chunk_caps.remove(&k);
                        }
                    }
                    _ => g.dirty_deleted = false,
                }
            }
        }
        let _ = self.append_journal_lines(&entries);
    }

    fn file_entry_line(&self, path: &str) -> Option<Json> {
        let st = self.file(path)?;
        Some(obj(vec![("t", Json::str("file")), ("path", Json::str(path)), ("state", st)]))
    }

    fn checkpoint_due_locked(&self, g: &Inner) -> bool {
        if g.journal_bytes == 0 {
            return false;
        }
        if !g.coalesced {
            return true;
        }
        g.journal_bytes >= CHECKPOINT_JOURNAL_BYTES || now_ms() - g.last_checkpoint_ms >= CHECKPOINT_INTERVAL_MS
    }

    /// Write the snapshot and empty the journal, as one step.
    fn checkpoint(&self) -> std::io::Result<()> {
        let _g = self.io.lock().unwrap_or_else(|e| e.into_inner());
        *self.persist_requested.lock().unwrap_or_else(|e| e.into_inner()) = false;
        let text = self.serialize();
        if self.write_snapshot(&text).is_err() {
            self.write_snapshot(&text)?;
        }
        self.checkpoint_gen.fetch_add(1, Ordering::SeqCst);
        let bytes = self.inner.lock().unwrap_or_else(|e| e.into_inner()).journal_bytes;
        if bytes > 0 || exists(&self.journal_path) {
            write_file_0600(&self.journal_path, b"")?;
        }
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.journal_bytes = 0;
        g.last_checkpoint_ms = now_ms();
        Ok(())
    }

    /// The journal lines for every dirty record, read from the live state.
    fn collect_dirty_entries(&self, g: &Inner) -> Vec<Json> {
        let mut out = Vec::new();
        for p in &g.dirty_files {
            if let Some(f) = g.state.get("files").and_then(|f| f.get(p)) {
                out.push(obj(vec![("t", Json::str("file")), ("path", Json::str(p)), ("state", f.clone())]));
            }
        }
        for k in &g.dirty_dests {
            if let Some(r) = g.state.get("destinations").and_then(|d| d.get(k)) {
                out.push(obj(vec![("t", Json::str("dest")), ("key", Json::str(k)), ("record", r.clone())]));
            }
        }
        for k in &g.dirty_artifacts {
            if let Some(h) = g.state.get("artifacts").and_then(|a| a.get(k)) {
                out.push(obj(vec![("t", Json::str("artifact")), ("key", Json::str(k)), ("hash", h.clone())]));
            }
        }
        for k in &g.dirty_chunk_caps {
            if let Some(c) = g.state.get("chunkCaps").and_then(|a| a.get(k)) {
                out.push(obj(vec![("t", Json::str("chunkCap")), ("key", Json::str(k)), ("cap", c.clone())]));
            }
        }
        if g.dirty_deleted {
            let map = g.state.get("deletedSessions").cloned().unwrap_or_else(Json::obj);
            out.push(obj(vec![("t", Json::str("deletedSessions")), ("map", map)]));
        }
        out
    }

    /// `flushStateIfDirty`: dirty records become journal lines (a pending
    /// whole-state mutation becomes a checkpoint), then the journal is folded
    /// when a checkpoint is due.
    pub fn flush_if_dirty(&self) -> Result<(), String> {
        let (all, entries, due) = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if g.dirty_all {
                g.clear_dirty();
                (true, Vec::new(), false)
            } else {
                let entries = self.collect_dirty_entries(&g);
                g.clear_dirty();
                let due = self.checkpoint_due_locked(&g);
                (false, entries, due)
            }
        };
        if all {
            return self.checkpoint().map_err(|e| {
                self.inner.lock().unwrap_or_else(|x| x.into_inner()).dirty_all = true;
                e.to_string()
            });
        }
        if !entries.is_empty() {
            if let Err(e) = self.append_journal_lines(&entries) {
                let mut g = self.inner.lock().unwrap_or_else(|x| x.into_inner());
                for en in &entries {
                    match en.get_string("t").as_deref() {
                        Some("file") => {
                            if let Some(p) = en.get_string("path") {
                                g.dirty_files.insert(p);
                            }
                        }
                        Some("dest") => {
                            if let Some(k) = en.get_string("key") {
                                g.dirty_dests.insert(k);
                            }
                        }
                        Some("artifact") => {
                            if let Some(k) = en.get_string("key") {
                                g.dirty_artifacts.insert(k);
                            }
                        }
                        Some("chunkCap") => {
                            if let Some(k) = en.get_string("key") {
                                g.dirty_chunk_caps.insert(k);
                            }
                        }
                        _ => g.dirty_deleted = true,
                    }
                }
                return Err(e.to_string());
            }
        }
        let due_now = due || self.read_due();
        if due_now {
            self.checkpoint().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn read_due(&self) -> bool {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.checkpoint_due_locked(&g)
    }

    /// `checkpointState`: fold everything into the snapshot now.
    pub fn checkpoint_state(&self) -> Result<(), String> {
        let pending = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let pending = g.is_dirty() || g.journal_bytes > 0;
            g.clear_dirty();
            pending
        };
        if !pending {
            return Ok(());
        }
        self.checkpoint().map_err(|e| e.to_string())
    }

    /// Whether the daemon's flush timer has work.
    pub fn state_flush_due(&self) -> bool {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.is_dirty() || self.checkpoint_due_locked(&g)
    }

    // ── Mutators ────────────────────────────────────────────────────────────

    /// `upsertFileState`.
    pub fn upsert_file_state(&self, entry: Json) {
        let path = entry.get_string("path").unwrap_or_default();
        self.mutate(|s| ensure_obj(s, "files").set(&path, entry));
        self.persist_or_mark(Mark::File(path));
    }

    /// `setOffsetFor`: journaled before returning, in both modes.
    pub fn set_offset_for(&self, path: &str, vault_org_id: Option<&str>, offset: f64, mtime_ms: f64) {
        let key = dest_key(vault_org_id);
        let now = now_ms();
        let found = self.mutate(|s| {
            let f = match s.as_obj_mut().and_then(|o| o.get_mut("files")).and_then(|f| f.as_obj_mut()).and_then(|f| f.get_mut(path)) {
                Some(f) => f,
                None => return false,
            };
            ensure_obj(f, "offsets").set(&key, Json::num(offset));
            f.set("lastMtimeMs", Json::num(mtime_ms));
            f.set("lastUploadAtMs", Json::num(now));
            true
        });
        if !found {
            return;
        }
        if let Some(line) = self.file_entry_line(path) {
            self.journal_through(vec![line]);
        }
    }

    /// `reconcileDestinations`: add missing keys at zero, drop departed ones.
    pub fn reconcile_destinations(&self, path: &str, active_keys: &[String]) {
        let changed = self.mutate(|s| {
            let f = match s.as_obj_mut().and_then(|o| o.get_mut("files")).and_then(|f| f.as_obj_mut()).and_then(|f| f.get_mut(path)) {
                Some(f) => f,
                None => return false,
            };
            let offsets = ensure_obj(f, "offsets");
            let mut changed = false;
            for k in active_keys {
                if offsets.get(k).is_none() {
                    offsets.set(k, Json::num(0.0));
                    changed = true;
                }
            }
            let present: Vec<String> = offsets.as_obj().map(|o| o.keys()).unwrap_or_default();
            for k in present {
                if !active_keys.contains(&k) {
                    offsets.remove(&k);
                    changed = true;
                }
            }
            changed
        });
        if changed {
            self.persist_or_mark(Mark::File(path.to_string()));
        }
    }

    /// `touchMtime`.
    pub fn touch_mtime(&self, path: &str, mtime_ms: f64) {
        let found = self.mutate(|s| match s.as_obj_mut().and_then(|o| o.get_mut("files")).and_then(|f| f.as_obj_mut()).and_then(|f| f.get_mut(path)) {
            Some(f) => {
                f.set("lastMtimeMs", Json::num(mtime_ms));
                true
            }
            None => false,
        });
        if found {
            self.persist_or_mark(Mark::File(path.to_string()));
        }
    }

    /// `benchFileProbe`: a fixed pause without touching the failure streak.
    pub fn bench_file_probe(&self, path: &str, delay_ms: f64) {
        let now = now_ms();
        let found = self.mutate(|s| match s.as_obj_mut().and_then(|o| o.get_mut("files")).and_then(|f| f.as_obj_mut()).and_then(|f| f.get_mut(path)) {
            Some(f) => {
                f.set("nextAttemptAtMs", Json::num(now + delay_ms));
                true
            }
            None => false,
        });
        if found {
            self.persist_or_mark(Mark::File(path.to_string()));
        }
    }

    /// `recordFileFailure`: returns the chosen delay in ms.
    pub fn record_file_failure(&self, path: &str, base_ms: f64, skip_reason: Option<&str>, blocker: Option<&Blocker>) -> f64 {
        let now = now_ms();
        let delay = self.mutate(|s| {
            let f = match s.as_obj_mut().and_then(|o| o.get_mut("files")).and_then(|f| f.as_obj_mut()).and_then(|f| f.get_mut(path)) {
                Some(f) => f,
                None => return 0.0,
            };
            let n = f.get_f64("consecutiveFailures").unwrap_or(0.0) + 1.0;
            f.set("consecutiveFailures", Json::num(n));
            let delay = (base_ms * 2f64.powf(n - 1.0)).min(FILE_BACKOFF_CAP_MS);
            f.set("nextAttemptAtMs", Json::num(now + delay));
            match skip_reason {
                Some(r) => f.set("skipReason", Json::str(r)),
                None => f.remove("skipReason"),
            }
            match blocker {
                Some(b) => {
                    let same_reason = f.get("blocker").and_then(|x| x.get_string("reason")).as_deref() == Some(b.reason.as_str());
                    let first_seen = if same_reason { f.get("blocker").and_then(|x| x.get_f64("firstSeenAtMs")).unwrap_or(now) } else { now };
                    let mut bj = obj(vec![
                        ("reason", Json::str(&b.reason)),
                        ("destinations", Json::Arr(b.destinations.iter().map(|d| d.to_json()).collect())),
                    ]);
                    bj.set("firstSeenAtMs", Json::num(first_seen));
                    bj.set("lastSeenAtMs", Json::num(now));
                    f.set("blocker", bj);
                }
                None => f.remove("blocker"),
            }
            delay
        });
        self.persist_or_mark(Mark::File(path.to_string()));
        delay
    }

    /// `recordHeal`: returns the streak length.
    pub fn record_heal(&self, path: &str) -> f64 {
        let now = now_ms();
        let n = self.mutate(|s| {
            let f = match s.as_obj_mut().and_then(|o| o.get_mut("files")).and_then(|f| f.as_obj_mut()).and_then(|f| f.get_mut(path)) {
                Some(f) => f,
                None => return 0.0,
            };
            let n = f.get_f64("healCount").unwrap_or(0.0) + 1.0;
            f.set("healCount", Json::num(n));
            if n >= HEAL_MAX_CONSECUTIVE {
                f.set("healPausedUntilMs", Json::num(now + HEAL_PAUSE_MS));
            }
            n
        });
        self.persist_or_mark(Mark::File(path.to_string()));
        n
    }

    /// `clearHeal`: journaled when it changes anything.
    pub fn clear_heal(&self, path: &str) {
        let changed = self.mutate(|s| {
            let f = match s.as_obj_mut().and_then(|o| o.get_mut("files")).and_then(|f| f.as_obj_mut()).and_then(|f| f.get_mut(path)) {
                Some(f) => f,
                None => return false,
            };
            if f.get("healCount").is_none() && f.get("healPausedUntilMs").is_none() {
                return false;
            }
            f.remove("healCount");
            f.remove("healPausedUntilMs");
            true
        });
        if changed {
            if let Some(line) = self.file_entry_line(path) {
                self.journal_through(vec![line]);
            }
        }
    }

    /// `clearFileFailure`: journaled when it changes anything.
    pub fn clear_file_failure(&self, path: &str) {
        let changed = self.mutate(|s| {
            let f = match s.as_obj_mut().and_then(|o| o.get_mut("files")).and_then(|f| f.as_obj_mut()).and_then(|f| f.get_mut(path)) {
                Some(f) => f,
                None => return false,
            };
            if f.get("consecutiveFailures").is_none() && f.get("nextAttemptAtMs").is_none() && f.get("skipReason").is_none() && f.get("blocker").is_none() {
                return false;
            }
            f.remove("consecutiveFailures");
            f.remove("nextAttemptAtMs");
            f.remove("skipReason");
            f.remove("blocker");
            true
        });
        if changed {
            if let Some(line) = self.file_entry_line(path) {
                self.journal_through(vec![line]);
            }
        }
    }

    /// `clearGenericBackoffs`: drop non-hold backoffs; returns the count.
    pub fn clear_generic_backoffs(&self) -> usize {
        let files = self.mutate(|s| {
            let mut n = 0;
            if let Some(files) = s.as_obj_mut().and_then(|o| o.get_mut("files")).and_then(|f| f.as_obj_mut()) {
                for (_, f) in files.iter_mut() {
                    if f.get("skipReason").is_some() {
                        continue;
                    }
                    if f.get("consecutiveFailures").is_none() && f.get("nextAttemptAtMs").is_none() {
                        continue;
                    }
                    n += 1;
                    f.remove("consecutiveFailures");
                    f.remove("nextAttemptAtMs");
                    f.remove("blocker");
                }
            }
            n
        });
        if files > 0 {
            self.persist_or_mark(Mark::All);
        }
        files
    }

    /// `pruneStrandedOffsets`: returns (keys, files) dropped.
    pub fn prune_stranded_offsets(&self) -> (usize, usize) {
        let pruned = self.mutate(|s| {
            if s.get("destinations").is_none() {
                return (0, 0);
            }
            let mut ever_written: BTreeSet<String> = BTreeSet::new();
            let registry_keys: BTreeSet<String> = s.get("destinations").and_then(|d| d.as_obj()).map(|o| o.keys().into_iter().collect()).unwrap_or_default();
            if let Some(files) = s.get("files").and_then(|f| f.as_obj()) {
                for (_, f) in files.iter() {
                    for (k, off) in fs_offsets(f) {
                        if off > 0.0 {
                            ever_written.insert(k);
                        }
                    }
                }
            }
            let mut keys = 0;
            let mut nfiles = 0;
            if let Some(files) = s.as_obj_mut().and_then(|o| o.get_mut("files")).and_then(|f| f.as_obj_mut()) {
                for (path, f) in files.iter_mut() {
                    let dead: Vec<String> = fs_offsets(f)
                        .into_iter()
                        .filter(|(k, off)| k != "letai" && *off == 0.0 && !ever_written.contains(k) && !registry_keys.contains(k))
                        .map(|(k, _)| k)
                        .collect();
                    if dead.is_empty() || exists(std::path::Path::new(path)) {
                        continue;
                    }
                    if let Some(offsets) = f.as_obj_mut().and_then(|o| o.get_mut("offsets")) {
                        for k in &dead {
                            offsets.remove(k);
                        }
                    }
                    keys += dead.len();
                    nfiles += 1;
                }
            }
            (keys, nfiles)
        });
        if pruned.0 > 0 {
            let _ = self.checkpoint();
        }
        pruned
    }

    /// `recordDestinations`.
    pub fn record_destinations(&self, reports: &[DestinationReport]) {
        let now = now_ms();
        let changed = self.mutate(|s| apply_destination_reports(s, reports, now));
        if changed {
            self.persist_or_mark(Mark::Dests(reports.iter().map(|r| dest_key(r.vault_org_id.as_deref())).collect()));
        }
    }

    /// `recordDestinationUploadError`.
    pub fn record_destination_upload_error(&self, key: &str, code: &str) {
        let now = now_ms();
        self.mutate(|s| {
            let registry = ensure_obj(s, "destinations");
            let existing = registry.get(key).cloned();
            let mut record = match existing {
                Some(r) => r,
                None => {
                    let vault = if key == "letai" { Json::Null } else { Json::str(key) };
                    let mut r = obj(vec![("vaultOrgId", vault), ("status", Json::str("ready"))]);
                    r.set("observedAtMs", Json::num(now));
                    r
                }
            };
            let n = record.get_f64("consecutiveErrors").unwrap_or(0.0) + 1.0;
            record.set("consecutiveErrors", Json::num(n));
            record.set("lastErrorCode", Json::str(code));
            record.set("lastErrorAtMs", Json::num(now));
            if record.get("failingSinceMs").is_none() {
                record.set("failingSinceMs", Json::num(now));
            }
            registry.set(key, record);
        });
        self.persist_or_mark(Mark::Dest(key.to_string()));
    }

    /// `clearDestinationUploadError`: journaled when it ends a failure run.
    pub fn clear_destination_upload_error(&self, key: &str) {
        let record = self.mutate(|s| {
            let r = s.as_obj_mut().and_then(|o| o.get_mut("destinations")).and_then(|d| d.as_obj_mut()).and_then(|d| d.get_mut(key))?;
            if r.get("consecutiveErrors").is_none() {
                return None;
            }
            r.remove("consecutiveErrors");
            r.remove("lastErrorCode");
            r.remove("lastErrorAtMs");
            r.remove("failingSinceMs");
            Some(r.clone())
        });
        if let Some(r) = record {
            self.journal_through(vec![obj(vec![("t", Json::str("dest")), ("key", Json::str(key)), ("record", r)])]);
        }
    }

    pub fn deleted_session_key(family: &str, session_id: &str) -> String {
        format!("{}:{}", family, session_id)
    }

    /// `recordDeletedSession`.
    pub fn record_deleted_session(&self, family: &str, session_id: &str) {
        let now = now_ms();
        let key = Store::deleted_session_key(family, session_id);
        self.mutate(|s| {
            let map = ensure_obj(s, "deletedSessions");
            if !map.get(&key).map(|v| v.truthy()).unwrap_or(false) {
                map.set(&key, Json::num(now));
            }
            let cutoff = now - DELETED_SESSION_RETENTION_MS;
            let expired: Vec<String> = map
                .as_obj()
                .map(|o| o.iter().filter(|(_, v)| v.as_f64().map(|at| at < cutoff).unwrap_or(false)).map(|(k, _)| k.clone()).collect())
                .unwrap_or_default();
            for k in expired {
                map.remove(&k);
            }
        });
        self.persist_or_mark(Mark::DeletedSessions);
    }

    /// `isDeletedSession` over a state value.
    pub fn is_deleted_session(state: &Json, family: &str, session_id: &str) -> bool {
        let map = match state.get("deletedSessions").and_then(|m| m.as_obj()) {
            Some(m) => m,
            None => return false,
        };
        if map.get(&Store::deleted_session_key(family, session_id)).map(|v| v.truthy()).unwrap_or(false) {
            return true;
        }
        let suffix = format!(":{}", session_id);
        map.iter().any(|(k, _)| k.ends_with(&suffix))
    }

    pub fn get_chunk_cap(&self, key: &str) -> Option<f64> {
        self.read(|s| s.get("chunkCaps").and_then(|c| c.get_f64(key)))
    }

    pub fn set_chunk_cap(&self, key: &str, cap: f64) {
        self.mutate(|s| ensure_obj(s, "chunkCaps").set(key, Json::num(cap)));
        self.persist_or_mark(Mark::ChunkCap(key.to_string()));
    }

    pub fn get_artifact_hash(&self, key: &str) -> Option<String> {
        self.read(|s| s.get("artifacts").and_then(|a| a.get_string(key)))
    }

    pub fn set_artifact_hash(&self, key: &str, hash: &str) {
        self.mutate(|s| ensure_obj(s, "artifacts").set(key, Json::str(hash)));
        self.persist_or_mark(Mark::Artifact(key.to_string()));
    }

    /// `stampEffectiveRoots`: a checkpoint, so a failure is loud.
    pub fn stamp_effective_roots(&self, roots: &ResolvedRoots) -> Result<(), String> {
        let now = now_ms();
        self.mutate(|s| {
            let stamp = obj(vec![
                ("claude", Json::Arr(roots.claude.iter().map(root_json).collect())),
                ("codex", Json::Arr(roots.codex.iter().map(root_json).collect())),
                ("resolvedAtMs", Json::num(now)),
            ]);
            s.set("effectiveRoots", stamp);
        });
        self.checkpoint().map_err(|e| e.to_string())
    }

    /// `persistState`: after in-place whole-state mutations.
    pub fn persist_state(&self) {
        self.persist_or_mark(Mark::All);
    }
}
