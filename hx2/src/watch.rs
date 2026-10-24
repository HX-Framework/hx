//! The watcher (src/watch.ts): `hx watch`, long-running and one-shot.
//!
//! Per-file upload pipeline: read bytes from `offset → EOF`, request a signed
//! PUT URL per destination, PUT the chunk (cut at the last newline, or the
//! whole window when it has none), POST the commit, bump the offset. A tiered
//! catalog (catalog.rs) tells each 1.5 s tick which files moved; the daemon
//! takes file events as hints and keeps the full sweep as a 60 s safety net.
//! After the parents, a pass uploads the child lanes and the workflow
//! sidecars (children.rs) and the task/plan sidecars (sidecars.rs).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use crate::activity::{append_activity, trim_activity};
use crate::catalog::DiscoveryCatalog;
use crate::ccd::{get_ccd_recents_by_cli_id, save_ccd_index_if_changed, CcdSessionMeta};
use crate::children::{
    build_child_parent_index, child_needs_pass, contested_child_lanes, discover_child_backfill, elect_child_uploaders, ingest_child_one, latch_child_lane_pause,
    merge_child_backfill, plan_child_lane_resets, plan_workflow_sync, reconcile_child_parent, sync_workflow_run, workflow_lane_after_failure, WorkflowLane, WorkflowPlan,
};
use crate::codex_titles::{read_codex_title, CodexTitle};
use crate::config::HxConfig;
use crate::fsutil::{basename, node_error, now_ms, relative, release_freed_memory, stat_safe};
use crate::home::homedir;
use crate::js::{math_round, num_to_string, to_locale_time_string_en_us, JsStr};
use crate::json::{obj, Json, OMap};
use crate::logger::Logger;
use crate::mirror::{sync_group_mirror, sync_team_mirror};
use crate::net::{put_chunk, vault_blocker_from_destinations, Blocker, Gateway, HxHttpError, NetError};
use crate::orgnames::remember_org_names;
use crate::parse::{summarise_chunk, ChunkSummary};
use crate::pathnorm::collapse_home;
use crate::reattribute::run_reattribute_sweep;
use crate::report::{elect_uploaders, filter_watched, owed_summary, should_skip_entry, snapshot_from, SyncSnapshot};
use crate::roots::{invalidate_roots_memo, resolve_data_roots, roots_signature, DataRoot, ResolvedRoots};
use crate::route::{resolve_route_shared, RouteCache, RouteMode};
use crate::settings::{is_paused, read_settings, tuning_int, tuning_value, HxSettings};
use crate::sidecars::sync_artifacts;
use crate::sources::{
    derive_fallback_title, discover_claude_children, discover_claude_files, discover_codex_files, read_head, seeded_cwd, DiscoveredChildFile, DiscoveredFile,
    DiscoveredWorkflowRun, HeadMeta, RECENT_WINDOW_MS,
};
use crate::state::{dest_key, fs_min_offset, fs_offset_for, DestinationReport, Store};
use crate::title_sync::run_title_sync_sweep;

pub const FAST_POLL_MS: f64 = 1_500.0;
const UPLOAD_BACKOFF_BASE_MS: f64 = 5_000.0;
const UPLOAD_BACKOFF_MAX_MS: f64 = 5.0 * 60_000.0;
pub const FILE_RETRY_BASE_MS: f64 = 30_000.0;
const SESSION_SKIP_RETRY_BASE_MS: f64 = 20_000.0;
const PASS_BYTE_BUDGET: u64 = 64 * 1024 * 1024;
const FILE_CONCURRENCY_DEFAULT: usize = 4;
const CHILD_CONCURRENCY_DEFAULT: usize = 4;
const MAX_GROWN_CHUNK: u64 = 32 * 1024 * 1024;
const UPLOAD_BYTES_CAP: u64 = 64 * 1024 * 1024;
const DRAIN_ROUNDS_BACKSTOP: usize = 1024;
const HEARTBEAT_MS: f64 = 60_000.0;
const MIRROR_SYNC_MS: f64 = 20_000.0;
const SYNC_REPORT_MIN_MS: f64 = 1_500.0;
const SYNC_PROGRESS_MIN_MS: f64 = 1_000.0;
const VERIFY_INTERVAL_MS: f64 = 30.0 * 60_000.0;
const VERIFY_BATCH: usize = 1_000;
const STUCK_LOG_INTERVAL_MS: f64 = 30.0 * 60_000.0;
pub const DEFAULT_CHUNK_LIMIT: u64 = 4 * 1024 * 1024;
/// Chunks one backfilled child lane may send within a single pass.
const SWEPT_LANE_MAX_CHUNKS: usize = 16;
const BACKFILL_INTERVAL_MS: f64 = 60.0 * 60_000.0;
const STATE_FLUSH_MS: f64 = 5_000.0;
const PERF_LOG_MS: f64 = 60.0 * 60_000.0;
const RESTAMP_INTERVAL_MS: f64 = 10.0 * 60_000.0;
pub const WATCHDOG_DEFAULT_MINUTES: f64 = 10.0;
pub const WATCHDOG_MIN_MINUTES: f64 = 2.0;
const WATCHDOG_CHECK_MS: f64 = 30_000.0;
pub const WATCHDOG_EXIT_CODE: i32 = 70;

#[derive(Clone, Debug, Default)]
pub struct WatchOptions {
    pub only: Option<String>,
    pub chunk_limit_bytes: Option<u64>,
    pub one_shot: bool,
    pub chunk_growth: bool,
}

/// Everything the loop shares across its passes and threads.
pub struct Ctx {
    pub cfg: HxConfig,
    pub gw: Gateway,
    pub store: Arc<Store>,
    pub log: Logger,
    pub name: String,
    /// The upload lane: "main" or "local" (the `--local` tee).
    pub scope: &'static str,
    pub routes: RouteCache,
    pub catalog: Mutex<DiscoveryCatalog>,
    self_heal: Mutex<Option<bool>>,
    backfill_last: Mutex<HashMap<String, f64>>,
    grown_chunk: Mutex<HashMap<String, u64>>,
    chunk_cap_logged: Mutex<HashSet<String>>,
    /// Child uploads paused until this time after a wholesale rejection.
    pub child_pause_until: Mutex<f64>,
    /// Per workflow run: the mtime gate and the retry backoff.
    pub workflow_lanes: Mutex<HashMap<String, WorkflowLane>>,
    pub beat: Arc<AtomicU64>,
    pub last_log_ms: Arc<AtomicU64>,
    /// What the last pass saw and decided (see `tick_once`).
    tick_cache: Mutex<Option<TickCache>>,
}

/// What a pass hands to the pool is a function of the catalog, the state
/// and the settings alone (the gate reads no clock), so a pass that pooled
/// nothing while all three stand still would pool nothing again: the next
/// tick reuses its snapshot instead of walking every file. The TypeScript
/// client walks them every tick; how often hx2 looks is its own business,
/// the uploads and the reports are the same. A workflow lane sitting out a
/// retry backoff bounds the reuse in time (`quiet_until`).
struct TickCache {
    catalog_gen: u64,
    store_gen: u64,
    settings_sig: String,
    snapshot: SyncSnapshot,
    pooled_empty: bool,
    quiet_until: f64,
}

/// The settings a pass decides on, as one string to compare across ticks.
fn tick_settings_signature(s: &HxSettings, roots: &ResolvedRoots) -> String {
    let mut sig = String::new();
    sig.push_str(if s.personal_sync { "p1|" } else { "p0|" });
    sig.push_str(&roots_signature(roots));
    sig.push('|');
    for ex in &s.excluded_folders {
        sig.push_str(&ex.family);
        sig.push(':');
        sig.push_str(&ex.cwd);
        sig.push(';');
    }
    sig.push('|');
    for r in &s.exclude_rules {
        sig.push_str(r);
        sig.push(';');
    }
    sig.push('|');
    if let Some(t) = &s.tuning {
        sig.push_str(&t.stringify());
    }
    sig
}

impl Ctx {
    pub fn new(cfg: HxConfig, store: Arc<Store>, log: Logger, name: &str, beat: Arc<AtomicU64>) -> Ctx {
        let gw = Gateway { base_url: cfg.gateway_base_url.clone(), token: cfg.access_token.clone().unwrap_or_default() };
        let scope = cfg.scope;
        Ctx {
            cfg,
            gw,
            store,
            log,
            name: name.to_string(),
            scope,
            routes: RouteCache::new(),
            catalog: Mutex::new(DiscoveryCatalog::new()),
            self_heal: Mutex::new(None),
            backfill_last: Mutex::new(HashMap::new()),
            grown_chunk: Mutex::new(HashMap::new()),
            chunk_cap_logged: Mutex::new(HashSet::new()),
            child_pause_until: Mutex::new(0.0),
            workflow_lanes: Mutex::new(HashMap::new()),
            beat,
            last_log_ms: Arc::new(AtomicU64::new(now_ms() as u64)),
            tick_cache: Mutex::new(None),
        }
    }

    pub fn log(&self, msg: &str) {
        self.last_log_ms.store(now_ms() as u64, Ordering::Relaxed);
        self.log.log(msg);
    }

    fn beat(&self) {
        self.beat.fetch_add(1, Ordering::Relaxed);
    }
}

// ── Byte semaphore (upload-scheduler.ts) ────────────────────────────────────

struct ByteSemaphore {
    cap: u64,
    used: Mutex<u64>,
    cv: Condvar,
}

impl ByteSemaphore {
    fn new(cap: u64) -> ByteSemaphore {
        ByteSemaphore { cap, used: Mutex::new(0), cv: Condvar::new() }
    }

    fn acquire(&self, n_raw: u64) -> u64 {
        let n = n_raw.min(self.cap);
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        while *used + n > self.cap {
            used = self.cv.wait(used).unwrap_or_else(|e| e.into_inner());
        }
        *used += n;
        n
    }

    fn release(&self, n: u64) {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        *used = used.saturating_sub(n);
        drop(used);
        self.cv.notify_all();
    }
}

/// The process-global in-flight chunk-buffer budget, shared across the tee lanes.
fn upload_semaphore() -> &'static ByteSemaphore {
    static SEMAPHORE: OnceLock<ByteSemaphore> = OnceLock::new();
    SEMAPHORE.get_or_init(|| ByteSemaphore::new(UPLOAD_BYTES_CAP))
}

// ── Progress reports (watch.ts reportSync) ──────────────────────────────────

/// One progress report: its answer counts as contact with the gateway, its
/// failure is logged (`sendSyncStatus(...).then(...).catch(...)`).
fn send_sync_report(ctx: &Ctx, last_contact: &Mutex<f64>, snap: SyncSnapshot) {
    match ctx.gw.send_sync_status(snap.total, snap.done, snap.total_bytes) {
        Ok(()) => *last_contact.lock().unwrap_or_else(|e| e.into_inner()) = now_ms(),
        Err(e) => ctx.log(&format!("[hx] sync-status error: {}", e.message())),
    }
}

/// The progress reports still waiting for their answer. Each one runs on a
/// thread of its own, as the TypeScript client's `void sendSyncStatus(...)`
/// leaves its fetch running while the pass carries on.
#[derive(Default)]
struct ReportsInFlight {
    count: Mutex<usize>,
    settled: Condvar,
}

/// A report on its way; dropping it settles the report.
struct ReportInFlight(Arc<ReportsInFlight>);

impl ReportsInFlight {
    fn start(self: &Arc<Self>) -> ReportInFlight {
        *self.count.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        ReportInFlight(self.clone())
    }

    /// Until every report sent so far has its answer or its error. Each one
    /// is bounded by its own deadline.
    fn wait(&self) {
        let mut count = self.count.lock().unwrap_or_else(|e| e.into_inner());
        while *count > 0 {
            count = self.settled.wait(count).unwrap_or_else(|e| e.into_inner());
        }
    }
}

impl Drop for ReportInFlight {
    fn drop(&mut self) {
        let mut count = self.0.count.lock().unwrap_or_else(|e| e.into_inner());
        *count -= 1;
        if *count == 0 {
            self.0.settled.notify_all();
        }
    }
}

/// `runPool`: workers dequeue from the same ordered list; a stop flag ends
/// dequeueing for every lane. A worker that returns false ends ITS lane
/// only — the TypeScript lane whose worker threw rejects and stops while
/// the other lanes keep dequeueing (with `uploadConcurrency: 1` the pass
/// ends at the first throw).
fn run_pool<T: Sync>(items: &[T], limit: usize, worker: &(dyn Fn(&T) -> bool + Sync), stopped: &AtomicBool) {
    if items.is_empty() {
        return;
    }
    let lanes = limit.clamp(1, items.len());
    let next = AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..lanes {
            s.spawn(|| loop {
                if stopped.load(Ordering::SeqCst) {
                    return;
                }
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= items.len() {
                    return;
                }
                if !worker(&items[i]) {
                    return;
                }
            });
        }
    });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn short_id(sid: &str) -> String {
    sid.chars().take(8).collect()
}

pub fn read_slice(path: &str, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    let mut f = fs::File::open(path)?;
    f.seek(SeekFrom::Start(start))?;
    let mut out = vec![0u8; len as usize];
    let mut filled = 0usize;
    while filled < out.len() {
        let n = f.read(&mut out[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    out.truncate(filled);
    Ok(out)
}

/// Trim a buffer at the last newline so no jsonl line is split across chunks.
pub fn trim_at_last_newline(mut buf: Vec<u8>, start_offset: u64) -> (Vec<u8>, u64) {
    match buf.iter().rposition(|&b| b == 0x0A) {
        None => {
            let end = start_offset + buf.len() as u64;
            (buf, end)
        }
        Some(last_nl) => {
            buf.truncate(last_nl + 1);
            let end = start_offset + last_nl as u64 + 1;
            (buf, end)
        }
    }
}

/// `logStuck`: once per kind of reason per file per interval (module state in
/// the TypeScript client, so the lanes share it).
pub fn log_stuck(ctx: &Ctx, path: &str, key: &str, message: &str, now: f64) {
    static STUCK: OnceLock<Mutex<HashMap<String, (String, f64)>>> = OnceLock::new();
    {
        let mut m = STUCK.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner());
        if let Some((reason, at)) = m.get(path) {
            if reason == key && now - at < STUCK_LOG_INTERVAL_MS {
                return;
            }
        }
        m.insert(path.to_string(), (key.to_string(), now));
    }
    ctx.log(&format!("  [stuck] {}: {}", path, message));
}

fn describe_skip(reason: &str) -> &'static str {
    match reason {
        "vault_offline" => "session vault temporarily unavailable",
        "vault_home_unreachable" => "session's home fortress not connected",
        _ => "session store unreachable",
    }
}

/// `uploadErrorCode`: the status plus the storage provider's `<Code>`, if any.
fn upload_error_code(err: &HxHttpError) -> String {
    if let Some(start) = err.message.find("<Code>") {
        let rest = &err.message[start + 6..];
        if let Some(end) = rest.find("</Code>") {
            let code = &rest[..end];
            if !code.is_empty() && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return format!("{} {}", err.status, code);
            }
        }
    }
    err.status.to_string()
}

/// `ensureFileState`: the seeded entry for a discovered file.
fn ensure_file_state(ctx: &Ctx, file: &DiscoveredFile) -> Result<Json, String> {
    if let Some(mut existing) = ctx.store.file(&file.path) {
        if existing.get("cwd").is_none() {
            let head = read_head(&file.path, file.source, true);
            existing.set("cwd", Json::str(&seeded_cwd(&head, &file.path)));
            existing.set("repoSlug", Json::opt_str(head.repo_slug.as_deref()));
            ctx.store.upsert_file_state(existing.clone())?;
        }
        let size = file.size as f64;
        if existing.get_f64("lastMtimeMs") != Some(file.mtime_ms) || existing.get_f64("lastKnownSize") != Some(size) {
            existing.set("lastMtimeMs", Json::num(file.mtime_ms));
            existing.set("lastKnownSize", Json::num(size));
            ctx.store.upsert_file_state(existing.clone())?;
        }
        return Ok(existing);
    }
    let head = read_head(&file.path, file.source, true);
    let session_id = head.session_id.clone().unwrap_or_else(|| basename(&file.path, ".jsonl"));
    let seeded = obj(vec![
        ("path", Json::str(&file.path)),
        ("family", Json::str(&head.family)),
        ("sessionId", Json::str(&session_id)),
        ("cwd", Json::str(&seeded_cwd(&head, &file.path))),
        ("repoSlug", Json::opt_str(head.repo_slug.as_deref())),
        ("offsets", Json::obj()),
        ("lastKnownSize", Json::num(file.size as f64)),
        ("lastMtimeMs", Json::num(file.mtime_ms)),
        ("lastUploadAtMs", Json::num(0.0)),
    ]);
    ctx.store.upsert_file_state(seeded.clone())?;
    Ok(seeded)
}

// ── Backfill (backfill.ts) ──────────────────────────────────────────────────

fn backfill_due(ctx: &Ctx, lane: &str, now: f64) -> bool {
    let m = ctx.backfill_last.lock().unwrap_or_else(|e| e.into_inner());
    match m.get(lane) {
        Some(last) => now - last >= BACKFILL_INTERVAL_MS,
        None => true,
    }
}

fn mark_backfill_run(ctx: &Ctx, lane: &str, now: f64) {
    ctx.backfill_last.lock().unwrap_or_else(|e| e.into_inner()).insert(lane.to_string(), now);
}

fn select_backfill(all: Vec<DiscoveredFile>, state: &Json) -> Vec<DiscoveredFile> {
    all.into_iter()
        .filter(|f| match state.get("files").and_then(|m| m.get(&f.path)) {
            Some(fs) => fs_min_offset(fs) < f.size as f64,
            None => true,
        })
        .collect()
}

// ── Routes ──────────────────────────────────────────────────────────────────

struct UploadRoute {
    gw: Gateway,
    fortress: bool,
    attributed_org_ids: Option<Vec<String>>,
}

fn upload_config_for(ctx: &Ctx, repo_slug: Option<&str>) -> UploadRoute {
    let repo = match repo_slug {
        Some(r) if ctx.cfg.access_token.is_some() => r,
        _ => return UploadRoute { gw: Gateway { base_url: ctx.gw.base_url.clone(), token: ctx.gw.token.clone() }, fortress: false, attributed_org_ids: None },
    };
    let route = resolve_route_shared(repo, &ctx.gw, &ctx.routes);
    let attributed = route.attributed_org_ids.clone();
    match route.mode {
        RouteMode::FortressDirect { gateway_url, token, .. } => UploadRoute { gw: Gateway { base_url: gateway_url, token }, fortress: true, attributed_org_ids: attributed },
        RouteMode::Cloud => UploadRoute { gw: Gateway { base_url: ctx.gw.base_url.clone(), token: ctx.gw.token.clone() }, fortress: false, attributed_org_ids: attributed },
    }
}

// ── ingestOne ───────────────────────────────────────────────────────────────

enum IngestError {
    /// This session's own store is temporarily unavailable (SessionUpstreamUnavailable).
    Upstream { reason: String, blocker: Option<Blocker> },
    Http(HxHttpError),
    Other(String),
}

impl IngestError {
    fn message(&self) -> String {
        match self {
            IngestError::Upstream { reason, .. } => format!("session store unavailable ({})", reason),
            IngestError::Http(e) => e.message.clone(),
            IngestError::Other(m) => m.clone(),
        }
    }
}

/// `classifyUpstreamError`: a per-session unavailability, or None to leave the error alone.
fn classify_upstream_error(err: &NetError, fortress: bool) -> Option<IngestError> {
    match err {
        NetError::Http(e) => {
            if let Some(reason) = e.vault_block_reason() {
                return Some(IngestError::Upstream { reason: reason.to_string(), blocker: e.blocker.clone() });
            }
            if fortress && e.server_unavailable() {
                return Some(IngestError::Upstream { reason: "store_unreachable".to_string(), blocker: None });
            }
            None
        }
        NetError::Other(_) | NetError::Timeout(_) => {
            if fortress {
                Some(IngestError::Upstream { reason: "store_unreachable".to_string(), blocker: None })
            } else {
                None
            }
        }
    }
}

fn net_to_ingest(err: NetError, fortress: bool) -> IngestError {
    if let Some(u) = classify_upstream_error(&err, fortress) {
        return u;
    }
    match err {
        NetError::Http(e) => IngestError::Http(e),
        NetError::Other(m) | NetError::Timeout(m) => IngestError::Other(m),
    }
}

struct UploadStep {
    vault_org_id: Option<String>,
    chunk_id: String,
    upload_url: String,
    replace: bool,
}

/// `planFanout`: one upload per ready destination (or the single legacy step).
fn plan_fanout(append: &Json, fstate: &Json) -> Vec<UploadStep> {
    match append.get("destinations").and_then(|d| d.as_arr()) {
        None => {
            let vault = append.get_string("vaultOrgId");
            vec![UploadStep {
                replace: fs_offset_for(fstate, vault.as_deref()) == 0.0,
                vault_org_id: vault,
                chunk_id: append.get_string("chunkId").unwrap_or_default(),
                upload_url: append.get_string("uploadUrl").unwrap_or_default(),
            }]
        }
        Some(list) => list
            .iter()
            .filter(|d| d.get_string("status").as_deref() == Some("ready"))
            .map(|d| {
                let vault = d.get_string("vaultOrgId");
                UploadStep {
                    replace: fs_offset_for(fstate, vault.as_deref()) == 0.0,
                    vault_org_id: vault,
                    chunk_id: d.get_string("chunkId").unwrap_or_default(),
                    upload_url: d.get_string("uploadUrl").unwrap_or_default(),
                }
            })
            .collect(),
    }
}

fn chunk_size_for(ctx: &Ctx, vault_org_id: Option<&str>, fortress: bool, opts: &WatchOptions) -> u64 {
    let base = opts.chunk_limit_bytes.unwrap_or(DEFAULT_CHUNK_LIMIT);
    if !opts.chunk_growth || fortress || vault_org_id.is_some() {
        return base;
    }
    let dk = dest_key(vault_org_id);
    let learned = ctx.store.get_chunk_cap(&dk).map(|c| c as u64);
    let grown = ctx.grown_chunk.lock().unwrap_or_else(|e| e.into_inner()).get(&dk).copied().unwrap_or(DEFAULT_CHUNK_LIMIT);
    let hard_cap = opts.chunk_limit_bytes.unwrap_or(u64::MAX);
    grown.min(learned.unwrap_or(u64::MAX)).min(MAX_GROWN_CHUNK).min(hard_cap)
}

fn opt_js(s: &Option<JsStr>) -> Json {
    match s {
        Some(v) => Json::Str(v.clone()),
        None => Json::Null,
    }
}

struct TitleMeta {
    title: Option<JsStr>,
    title_source: Option<&'static str>,
}

/// `deriveTitleMeta`: Claude Desktop's title, else the chunk's, else Codex's,
/// else the rollout head's; a synthesized label on a from-zero upload.
fn derive_title_meta(summary: &ChunkSummary, head: &HeadMeta, step_offset: u64, ccd: Option<&CcdSessionMeta>, codex: Option<&CodexTitle>) -> TitleMeta {
    let ccd_title: Option<JsStr> = ccd.and_then(|m| m.title_units()).filter(|t| !t.is_empty());
    let mut title: Option<JsStr> = ccd_title
        .clone()
        .or_else(|| summary.title.clone())
        .or_else(|| codex.map(|c| c.title.clone()))
        .or_else(|| head.title.clone());
    let mut source: Option<&'static str> = if ccd_title.is_some() {
        ccd.and_then(|m| m.title_source())
    } else if summary.title.is_some() {
        summary.title_source
    } else if codex.is_some() {
        codex.map(|c| c.source)
    } else if head.title.is_some() {
        Some("ai")
    } else {
        None
    };
    let falsy = title.as_ref().map(|t| t.is_empty()).unwrap_or(true);
    if falsy && step_offset == 0 {
        if let Some(derived) = derive_fallback_title(summary.first_user_text.as_deref(), head.cwd.as_deref(), head.repo_slug.as_deref()) {
            title = Some(derived);
            source = Some("fallback");
        }
    }
    TitleMeta { title, title_source: source }
}

fn ingest_one(ctx: &Ctx, file: &DiscoveredFile, opts: &WatchOptions) -> Result<bool, IngestError> {
    let st = match stat_safe(Path::new(&file.path)) {
        Some(s) => s,
        None => return Ok(false),
    };
    let fresh = DiscoveredFile { path: file.path.clone(), size: st.size, mtime_ms: st.mtime_ms, source: file.source, root_dir: file.root_dir.clone() };
    let fstate = ensure_file_state(ctx, &fresh).map_err(IngestError::Other)?;
    let base_offset = fs_min_offset(&fstate);
    let held = fstate.get("skipReason").map(|v| v.truthy()).unwrap_or(false);
    if (st.size as f64) <= base_offset && !held {
        if fstate.get_f64("lastMtimeMs") != Some(st.mtime_ms) {
            ctx.store.touch_mtime(&file.path, st.mtime_ms).map_err(IngestError::Other)?;
        }
        return Ok(false);
    }

    let head = read_head(&file.path, file.source, true);
    let family = fstate.get_string("family").unwrap_or_default();
    let session_id = fstate.get_string("sessionId").unwrap_or_default();

    // FIRST-SIGHT cache wins over the live walk; the walk only fills a null.
    let cached_slug: Option<String> = fstate.get("repoSlug").filter(|v| !v.is_null()).and_then(|v| v.as_string());
    let repo_slug: Option<String> = cached_slug.clone().or_else(|| head.repo_slug.clone());
    if cached_slug.is_none() && head.repo_slug.is_some() {
        if let Some(mut f) = ctx.store.file(&file.path) {
            f.set("repoSlug", Json::opt_str(head.repo_slug.as_deref()));
            ctx.store.upsert_file_state(f).map_err(IngestError::Other)?;
        }
    }

    let route = upload_config_for(ctx, repo_slug.as_deref());
    let upload_gw = &route.gw;
    if let Some(ids) = &route.attributed_org_ids {
        let attributed = !ids.is_empty();
        if let Some(mut f) = ctx.store.file(&file.path) {
            if f.get("attributed").and_then(|a| a.as_bool()) != Some(attributed) {
                f.set("attributed", Json::Bool(attributed));
                ctx.store.upsert_file_state(f).map_err(IngestError::Other)?;
            }
        }
    }

    // Claude Desktop's title and group id, and Codex's own title: byte-independent, resolved once.
    let ccd_meta: Option<Arc<CcdSessionMeta>> = get_ccd_recents_by_cli_id(now_ms()).get(&session_id).cloned();
    let codex_title: Option<CodexTitle> = if file.source == "codex" { read_codex_title(&file.root_dir, &session_id) } else { None };

    let mut any_progress = false;
    let mut last_unavailable: Option<HxHttpError> = None;
    let mut held_blocker: Option<Blocker> = None;
    let mut artifact_text: Option<String> = None;
    let mut unavailable_dests: HashSet<String> = HashSet::new();
    let mut sent_by_dest: HashMap<String, u64> = HashMap::new();
    let mut slice_summaries: HashMap<String, (u64, ChunkSummary)> = HashMap::new();
    let now_label = |v: Option<&str>| v.map(|s| s.to_string()).unwrap_or_else(|| "let.ai".to_string());
    let open_err = |e: std::io::Error| NetError::Other(node_error(&e, "open", Path::new(&file.path)));
    let drain: Result<(), NetError> = (|| {
        for _round in 0..DRAIN_ROUNDS_BACKSTOP {
            ctx.beat();
            let live = ctx.store.file(&file.path).unwrap_or_else(|| fstate.clone());
            let byte_count = st.size.saturating_sub(fs_min_offset(&live) as u64);
            let append = upload_gw.request_append_url(&family, &session_id, byte_count, repo_slug.as_deref())?;
            held_blocker = vault_blocker_from_destinations(append.get("destinations"));
            if let Some(list) = append.get("destinations").and_then(|d| d.as_arr()) {
                let keys: Vec<String> = list.iter().map(|d| dest_key(d.get_string("vaultOrgId").as_deref())).collect();
                ctx.store.reconcile_destinations(&file.path, &keys).map_err(NetError::Other)?;
                let reports: Vec<DestinationReport> = list
                    .iter()
                    .map(|d| DestinationReport {
                        vault_org_id: d.get_string("vaultOrgId"),
                        status: if d.get_string("status").as_deref() == Some("held") { "held" } else { "ready" },
                        org_name: d.get("orgName").and_then(|v| v.as_string()),
                        org_slug: d.get("orgSlug").and_then(|v| v.as_string()),
                        last_seen_at: d.get("lastSeenAt").and_then(|v| v.as_string()),
                    })
                    .collect();
                ctx.store.record_destinations(&reports).map_err(NetError::Other)?;
            }
            let live = ctx.store.file(&file.path).unwrap_or_else(|| fstate.clone());
            let steps: Vec<UploadStep> = plan_fanout(&append, &live)
                .into_iter()
                .filter(|s| {
                    let dk = dest_key(s.vault_org_id.as_deref());
                    !unavailable_dests.contains(&dk) && sent_by_dest.get(&dk).copied().unwrap_or(0) < PASS_BYTE_BUDGET
                })
                .collect();
            let mut round_progress = false;
            for step in &steps {
                let dk = dest_key(step.vault_org_id.as_deref());
                let live = ctx.store.file(&file.path).unwrap_or_else(|| fstate.clone());
                let step_offset = fs_offset_for(&live, step.vault_org_id.as_deref()) as u64;
                let chunk_size = chunk_size_for(ctx, step.vault_org_id.as_deref(), route.fortress, opts);
                let budget_left = PASS_BYTE_BUDGET.saturating_sub(sent_by_dest.get(&dk).copied().unwrap_or(0));
                let want = st.size.saturating_sub(step_offset).min(chunk_size).min(budget_left);
                if want == 0 {
                    continue;
                }
                let held = upload_semaphore().acquire(want);
                let result: Result<(), NetError> = (|| {
                    let slice = read_slice(&file.path, step_offset, want).map_err(open_err)?;
                    let (mut trimmed, mut end_offset) = trim_at_last_newline(slice, step_offset);
                    if trimmed.is_empty() {
                        return Ok(());
                    }
                    let cache_key = format!("{}:{}", step_offset, want);
                    let summary = match slice_summaries.get(&cache_key) {
                        Some((end, s)) if *end == end_offset => s.clone(),
                        _ => {
                            let s = summarise_chunk(&String::from_utf8_lossy(&trimmed));
                            slice_summaries.insert(cache_key.clone(), (end_offset, s.clone()));
                            s
                        }
                    };
                    let mut summary = summary;
                    let base_chunk = opts.chunk_limit_bytes.unwrap_or(DEFAULT_CHUNK_LIMIT).min(DEFAULT_CHUNK_LIMIT);
                    if let Err(grow_err) = put_chunk(&step.upload_url, &trimmed) {
                        if !opts.chunk_growth || chunk_size <= base_chunk {
                            return Err(grow_err);
                        }
                        // Growth probe: retry in place at the last-good rung.
                        let last_good = base_chunk.max(chunk_size / 2);
                        let shrunk_want = st.size.saturating_sub(step_offset).min(last_good);
                        let shrunk_slice = read_slice(&file.path, step_offset, shrunk_want).map_err(open_err)?;
                        let (shrunk, shrunk_end) = trim_at_last_newline(shrunk_slice, step_offset);
                        if shrunk.is_empty() {
                            return Err(grow_err);
                        }
                        put_chunk(&step.upload_url, &shrunk)?;
                        trimmed = shrunk;
                        end_offset = shrunk_end;
                        summary = summarise_chunk(&String::from_utf8_lossy(&trimmed));
                        slice_summaries.insert(format!("{}:{}", step_offset, shrunk_want), (end_offset, summary.clone()));
                        ctx.grown_chunk.lock().unwrap_or_else(|e| e.into_inner()).insert(dk.clone(), last_good);
                        let size_shaped = match grow_err.http() {
                            Some(h) => {
                                h.status == 413
                                    || (h.status >= 400
                                        && h.status < 500
                                        && ["EntityTooLarge", "MaxMessageLength", "PayloadTooLarge", "RequestEntityTooLarge", "TooBig"].iter().any(|n| h.message.to_lowercase().contains(&n.to_lowercase())))
                            }
                            None => false,
                        };
                        if size_shaped {
                            ctx.store.set_chunk_cap(&dk, last_good as f64).map_err(NetError::Other)?;
                            let fresh = ctx.chunk_cap_logged.lock().unwrap_or_else(|e| e.into_inner()).insert(dk.clone());
                            if fresh {
                                ctx.log(&format!("[hx] chunk size settled at {} MB for {}", num_to_string(math_round(last_good as f64 / (1024.0 * 1024.0))), dk));
                            }
                        }
                    }
                    let tm = derive_title_meta(&summary, &head, step_offset, ccd_meta.as_deref(), codex_title.as_ref());
                    let cwd_meta: Json = if ctx.cfg.evidence_upload == Some(false) { Json::Null } else { opt_js(&head.cwd) };
                    let meta = obj(vec![
                        ("sourcePath", Json::str(&file.path)),
                        ("title", opt_js(&tm.title)),
                        ("titleSource", Json::opt_str(tm.title_source)),
                        ("ccdSessionId", ccd_meta.as_ref().map(|m| Json::Str(m.ccd_session_id_units())).unwrap_or(Json::Null)),
                        ("cwd", cwd_meta),
                        ("gitBranch", opt_js(&head.git_branch)),
                        ("repoSlug", Json::opt_str(repo_slug.as_deref())),
                        ("entrypoint", opt_js(&head.entrypoint)),
                        ("originator", opt_js(&head.originator)),
                        ("modelProvider", opt_js(&head.model_provider)),
                        ("lastUserText", opt_js(&summary.last_user_text)),
                        ("lastAssistantText", opt_js(&summary.last_assistant_text)),
                        ("eventCount", Json::num(summary.event_count as f64)),
                        ("userTextCount", Json::num(summary.user_text_count as f64)),
                        ("assistantCount", Json::num(summary.assistant_count as f64)),
                        ("lastActivityAt", opt_js(&summary.last_activity_at)),
                    ]);
                    let body = crate::net::commit_body(&family, &session_id, &step.chunk_id, step.replace, step.vault_org_id.as_deref(), meta);
                    let commit = upload_gw.commit_chunk(&body)?;
                    let total_bytes = commit.get_f64("totalBytes").unwrap_or(-1.0);
                    let self_heal = *ctx.self_heal.lock().unwrap_or_else(|e| e.into_inner());
                    let diverged = !route.fortress && self_heal == Some(true) && step.vault_org_id.is_none() && total_bytes != end_offset as f64;
                    let live = ctx.store.file(&file.path).unwrap_or_else(|| fstate.clone());
                    let heal_paused_until = live.get_f64("healPausedUntilMs").unwrap_or(0.0);
                    if diverged && heal_paused_until > now_ms() {
                        ctx.store.set_offset_for(&file.path, step.vault_org_id.as_deref(), end_offset as f64, st.mtime_ms).map_err(NetError::Other)?;
                    } else if diverged {
                        let streak = ctx.store.record_heal(&file.path).map_err(NetError::Other)?;
                        ctx.log(&format!(
                            "  [heal] {}… canonical {}B ≠ uploaded {}B — re-uploading from zero",
                            short_id(&session_id),
                            num_to_string(total_bytes),
                            end_offset
                        ));
                        let after = ctx.store.file(&file.path).unwrap_or_else(|| fstate.clone());
                        if after.get_f64("healPausedUntilMs").unwrap_or(0.0) > now_ms() {
                            ctx.log(&format!("  [heal] {}… diverged {}x in a row — pausing self-heal for this file", short_id(&session_id), num_to_string(streak)));
                        }
                        ctx.store.set_offset_for(&file.path, step.vault_org_id.as_deref(), 0.0, st.mtime_ms).map_err(NetError::Other)?;
                    } else {
                        ctx.store.set_offset_for(&file.path, step.vault_org_id.as_deref(), end_offset as f64, st.mtime_ms).map_err(NetError::Other)?;
                        if step_offset > 0 && live.get("healCount").is_some() {
                            ctx.store.clear_heal(&file.path).map_err(NetError::Other)?;
                        }
                    }
                    if artifact_text.is_none() {
                        artifact_text = Some(String::from_utf8_lossy(&trimmed).into_owned());
                    }
                    ctx.store.clear_destination_upload_error(&dk).map_err(NetError::Other)?;
                    any_progress = true;
                    round_progress = true;
                    *sent_by_dest.entry(dk.clone()).or_insert(0) += trimmed.len() as u64;
                    if opts.chunk_growth && !route.fortress && step.vault_org_id.is_none() && want == chunk_size {
                        let learned = ctx.store.get_chunk_cap(&dk).map(|c| c as u64).unwrap_or(u64::MAX);
                        let next = (chunk_size * 2).min(MAX_GROWN_CHUNK).min(learned);
                        let mut g = ctx.grown_chunk.lock().unwrap_or_else(|e| e.into_inner());
                        if next > g.get(&dk).copied().unwrap_or(DEFAULT_CHUNK_LIMIT) {
                            g.insert(dk.clone(), next);
                        }
                    }
                    ctx.log(&format!(
                        "  {} (+{}B → {}, {}, {}…)",
                        relative(&homedir().to_string_lossy(), &file.path),
                        trimmed.len(),
                        now_label(step.vault_org_id.as_deref()),
                        family,
                        short_id(&session_id)
                    ));
                    append_activity(now_ms(), &session_id, &family, trimmed.len() as u64, &dk);
                    Ok(())
                })();
                upload_semaphore().release(held);
                if let Err(err) = result {
                    if let Some(h) = err.http() {
                        if h.server_unavailable() {
                            last_unavailable = Some(h.clone());
                            unavailable_dests.insert(dk.clone());
                            ctx.log(&format!("  [hx] destination {} unavailable ({}); will retry", now_label(step.vault_org_id.as_deref()), h.status));
                            continue;
                        }
                        // `.catch(() => {})`: a failed latch write never masks the upload error.
                        let _ = ctx.store.record_destination_upload_error(&dk, &upload_error_code(h));
                    }
                    return Err(err);
                }
            }
            if !round_progress {
                break;
            }
            let live = ctx.store.file(&file.path).unwrap_or_else(|| fstate.clone());
            let remaining = steps.iter().any(|s| {
                let dk = dest_key(s.vault_org_id.as_deref());
                !unavailable_dests.contains(&dk) && (fs_offset_for(&live, s.vault_org_id.as_deref()) as u64) < st.size && sent_by_dest.get(&dk).copied().unwrap_or(0) < PASS_BYTE_BUDGET
            });
            if !remaining {
                break;
            }
        }
        Ok(())
    })();
    if let Err(err) = drain {
        return Err(net_to_ingest(err, route.fortress));
    }

    if !any_progress {
        if let Some(u) = last_unavailable {
            return Err(net_to_ingest(NetError::Http(u), route.fortress));
        }
        if let Some(hb) = held_blocker {
            return Err(IngestError::Upstream { reason: hb.reason.clone(), blocker: Some(hb) });
        }
        return Ok(false);
    }
    // Best-effort sidecar sync — a failure must never fail the transcript.
    if let Some(text) = &artifact_text {
        let live = ctx.store.file(&file.path).unwrap_or_else(|| fstate.clone());
        if let Err(e) = sync_artifacts(ctx, &live, text, Some(&file.root_dir)) {
            ctx.log(&format!("  [artifacts] {}…: {}", short_id(&session_id), e.message()));
        }
    }
    if let Some(hb) = held_blocker {
        return Err(IngestError::Upstream { reason: hb.reason.clone(), blocker: Some(hb) });
    }
    Ok(true)
}

// ── tickOnce ────────────────────────────────────────────────────────────────

pub struct TickResult {
    pub uploaded: u64,
    pub failed: u64,
    pub snapshot: SyncSnapshot,
}

pub fn tick_once(ctx: &Ctx, opts: &WatchOptions, on_progress: &(dyn Fn(SyncSnapshot) + Sync)) -> Result<TickResult, String> {
    let settings = read_settings();
    let roots = resolve_data_roots(&settings);
    let legacy_sweep = tuning_value(&settings, "sweep").and_then(|v| v.as_string()).as_deref() == Some("legacy") || std::env::var("HX_SWEEP").ok().as_deref() == Some("legacy");
    let now = now_ms();
    let cat_gen = if legacy_sweep {
        0
    } else {
        let mut c = ctx.catalog.lock().unwrap_or_else(|e| e.into_inner());
        c.sweep(&roots, now);
        c.generation
    };
    ctx.beat();
    let store_gen = ctx.store.generation();
    let settings_sig = tick_settings_signature(&settings, &roots);
    let parent_lane = ctx.scope.to_string();
    let child_lane = format!("{}:children", ctx.scope);
    let child_paused = now < *ctx.child_pause_until.lock().unwrap_or_else(|e| e.into_inner());
    let log_fn = |m: &str| ctx.log(m);
    // Nothing moved since the last pass, which pooled nothing: the same
    // snapshot, no per-file work (TickCache).
    if !legacy_sweep && opts.only.is_none() && !child_paused && !backfill_due(ctx, &parent_lane, now) && !backfill_due(ctx, &child_lane, now) {
        let cached = {
            let cache = ctx.tick_cache.lock().unwrap_or_else(|e| e.into_inner());
            match &*cache {
                Some(c) if c.pooled_empty && c.catalog_gen == cat_gen && c.store_gen == store_gen && c.settings_sig == settings_sig && now < c.quiet_until => Some(c.snapshot),
                _ => None,
            }
        };
        if let Some(snapshot) = cached {
            ctx.store.flush_if_dirty()?;
            save_ccd_index_if_changed(now_ms(), opts.one_shot);
            on_progress(snapshot);
            return Ok(TickResult { uploaded: 0, failed: 0, snapshot });
        }
    }
    let mut files: Vec<DiscoveredFile> = if legacy_sweep {
        let mut v = discover_claude_files(&roots.claude, Some(RECENT_WINDOW_MS), now);
        v.extend(discover_codex_files(&roots.codex, true, Some(RECENT_WINDOW_MS), now));
        v
    } else {
        ctx.catalog.lock().unwrap_or_else(|e| e.into_inner()).list_files()
    };
    if let Some(only) = &opts.only {
        files.retain(|f| f.path == *only);
    }

    // The unwindowed sweep: once on start, then hourly.
    if opts.only.is_none() && backfill_due(ctx, &parent_lane, now) {
        mark_backfill_run(ctx, &parent_lane, now);
        let owed = ctx.store.read(|state| {
            let mut all = discover_claude_files(&roots.claude, None, now);
            all.extend(discover_codex_files(&roots.codex, true, None, now));
            select_backfill(all, state)
        });
        if !owed.is_empty() {
            let seen: HashSet<String> = files.iter().map(|f| f.path.clone()).collect();
            let added: Vec<DiscoveredFile> = owed.into_iter().filter(|f| !seen.contains(&f.path)).collect();
            if !added.is_empty() {
                let unseen = ctx.store.read(|state| added.iter().filter(|f| state.get("files").and_then(|m| m.get(&f.path)).is_none()).count());
                ctx.log(&format!(
                    "[hx] backfill: {} session{} the live sweep did not reach still owe bytes ({} never ingested) — queueing",
                    added.len(),
                    if added.len() == 1 { "" } else { "s" },
                    unseen
                ));
                let adopted = if legacy_sweep { 0 } else { ctx.catalog.lock().unwrap_or_else(|e| e.into_inner()).adopt(&added, now) };
                files.extend(added);
                if adopted > 0 {
                    ctx.log(&format!("[hx] backfill: {} adopted into the live sweep", adopted));
                }
            } else {
                ctx.log("[hx] backfill: swept, every owed session was already queued this pass — nothing to add");
            }
        } else {
            ctx.log("[hx] backfill: nothing on disk still owes bytes");
        }
    }

    // Seed-then-elect: every file with no state entry is seeded before
    // election; an unreadable or unwritable seed is left for ingestOne's own
    // error taxonomy (`.catch(() => {})`).
    let unseeded: Vec<DiscoveredFile> = ctx.store.read(|state| files.iter().filter(|f| state.get("files").and_then(|m| m.get(&f.path)).is_none()).cloned().collect());
    for f in &unseeded {
        ctx.beat();
        let _ = ensure_file_state(ctx, f);
    }
    let files: Vec<DiscoveredFile> = {
        let elected = ctx.store.read(|state| elect_uploaders(files, state, Some(&log_fn)));
        ctx.store.read(|state| filter_watched(elected, state, &settings))
    };
    on_progress(ctx.store.read(|state| snapshot_from(&files, state)));

    let eff_opts = WatchOptions { chunk_growth: matches!(tuning_value(&settings, "chunkGrowth"), Some(Json::Bool(true))), ..opts.clone() };
    let file_concurrency = tuning_int(&settings, "uploadConcurrency", FILE_CONCURRENCY_DEFAULT);
    let child_concurrency = tuning_int(&settings, "childConcurrency", CHILD_CONCURRENCY_DEFAULT);

    let uploaded = AtomicU64::new(0);
    let failed = AtomicU64::new(0);
    let gateway_unavailable_files: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
    let stop_pass = AtomicBool::new(false);
    let personal_sync = settings.personal_sync;

    // One file of the pass. A state write that fails (an unwritable store)
    // ends the pass the way the TypeScript client's awaited write does: the
    // error is the pass's error, logged by the loop as `[hx] tick error`.
    let process_parent = |f: &DiscoveredFile| -> Result<(), String> {
        ctx.beat();
        let now = now_ms();
        let pending = ctx.store.file(&f.path);
        if let Some(p) = &pending {
            if let Some(next) = p.get_f64("nextAttemptAtMs") {
                if next != 0.0 && next > now {
                    let mins = math_round((next - now) / 60_000.0);
                    let skip = p.get_string("skipReason").filter(|s| !s.is_empty());
                    log_stuck(
                        ctx,
                        &f.path,
                        &format!("backoff:{}", skip.clone().unwrap_or_default()),
                        &format!(
                            "waiting out a retry backoff for another {} min ({} consecutive failures{})",
                            num_to_string(mins),
                            num_to_string(p.get_f64("consecutiveFailures").unwrap_or(0.0)),
                            skip.map(|s| format!(", {}", s)).unwrap_or_default()
                        ),
                        now,
                    );
                    return Ok(());
                }
            }
        }
        let attributed_unknown = pending.as_ref().map(|p| p.get("attributed").is_none()).unwrap_or(true);
        if pending.is_none() || (!personal_sync && attributed_unknown) {
            let mut seeded = match &pending {
                Some(p) => p.clone(),
                None => ensure_file_state(ctx, f)?,
            };
            let seeded_slug = seeded.get("repoSlug").filter(|v| !v.is_null()).and_then(|v| v.as_string()).filter(|s| !s.is_empty());
            if !personal_sync && seeded_slug.is_some() && seeded.get("attributed").is_none() && ctx.cfg.access_token.is_some() {
                let r = resolve_route_shared(seeded_slug.as_deref().unwrap_or(""), &ctx.gw, &ctx.routes);
                if let Some(ids) = r.attributed_org_ids {
                    seeded.set("attributed", Json::Bool(!ids.is_empty()));
                    ctx.store.upsert_file_state(seeded.clone())?;
                }
            }
            if should_skip_entry(&settings, &seeded) {
                let attributed = match seeded.get("attributed").and_then(|a| a.as_bool()) {
                    Some(true) => "true",
                    Some(false) => "false",
                    None => "undefined",
                };
                log_stuck(
                    ctx,
                    &f.path,
                    "excluded",
                    &format!(
                        "excluded by settings — personalSync={}, repoSlug={}, attributed={}",
                        settings.personal_sync,
                        seeded_slug.unwrap_or_else(|| "null".to_string()),
                        attributed
                    ),
                    now,
                );
                return Ok(());
            }
        }
        if let Some(entry) = ctx.store.file(&f.path) {
            let family = entry.get_string("family").unwrap_or_default();
            let sid = entry.get_string("sessionId").unwrap_or_default();
            if ctx.store.read(|s| Store::is_deleted_session(s, &family, &sid)) {
                log_stuck(ctx, &f.path, "deleted", "session was permanently deleted on the server — it will never upload again", now);
                return Ok(());
            }
        }
        match ingest_one(ctx, f, &eff_opts) {
            Ok(did) => {
                if did {
                    uploaded.fetch_add(1, Ordering::SeqCst);
                } else if pending.is_some() {
                    if let Some(after) = ctx.store.file(&f.path) {
                        if after.get("lastKnownSize").is_some() && fs_min_offset(&after) < f.size as f64 {
                            log_stuck(
                                ctx,
                                &f.path,
                                "no-plan",
                                &format!("owes bytes but the gateway planned no upload for it — {}. The destination may no longer exist.", owed_summary(&after, f.size)),
                                now_ms(),
                            );
                        }
                    }
                }
                if let Some(p) = &pending {
                    if p.get("consecutiveFailures").is_some() || p.get("nextAttemptAtMs").is_some() {
                        ctx.store.clear_file_failure(&f.path)?;
                    }
                }
            }
            Err(err) => {
                failed.fetch_add(1, Ordering::SeqCst);
                ctx.log(&format!("  [error] {}: {}", f.path, err.message()));
                match err {
                    IngestError::Upstream { reason, blocker } => {
                        if let Some(b) = &blocker {
                            let names: Vec<(String, Option<String>)> = b.destinations.iter().map(|d| (d.vault_org_id.clone(), d.org_name.clone())).collect();
                            remember_org_names(&names);
                        }
                        let delay = ctx.store.record_file_failure(&f.path, SESSION_SKIP_RETRY_BASE_MS, Some(&reason), blocker.as_ref())?;
                        ctx.log(&format!("  [hx] {}; retrying {} in {}s", describe_skip(&reason), basename(&f.path, ""), num_to_string(math_round(delay / 1000.0))));
                    }
                    IngestError::Http(h) if h.session_deleted() => {
                        if let Some(entry) = ctx.store.file(&f.path) {
                            let family = entry.get_string("family").unwrap_or_default();
                            let sid = entry.get_string("sessionId").unwrap_or_default();
                            ctx.store.record_deleted_session(&family, &sid)?;
                            ctx.store.clear_file_failure(&f.path)?;
                            ctx.log(&format!("  [hx] {}… permanently deleted on the server — uploads stopped (local file kept)", short_id(&sid)));
                        }
                    }
                    IngestError::Http(h) if h.server_unavailable() => {
                        let count = {
                            let mut g = gateway_unavailable_files.lock().unwrap_or_else(|e| e.into_inner());
                            g.insert(f.path.clone());
                            g.len()
                        };
                        if count >= 2 {
                            if !stop_pass.swap(true, Ordering::SeqCst) {
                                ctx.log(&format!("  [hx] gateway unavailable ({}) on {} files; pausing this pass", h.status, count));
                            }
                            return Ok(());
                        }
                        ctx.store.bench_file_probe(&f.path, FILE_RETRY_BASE_MS)?;
                        ctx.log(&format!("  [hx] 5xx ({}) on one file; probing another before pausing the pass", h.status));
                    }
                    _ => {
                        ctx.store.record_file_failure(&f.path, FILE_RETRY_BASE_MS, None, None)?;
                    }
                }
            }
        }
        Ok(())
    };

    // The parent-file gate: pool only files with something to do.
    let pooled: Vec<DiscoveredFile> = if legacy_sweep {
        files.clone()
    } else {
        ctx.store.read(|state| {
            files
                .iter()
                .filter(|f| {
                    let fs = match state.get("files").and_then(|m| m.get(&f.path)) {
                        Some(fs) => fs,
                        None => return true,
                    };
                    if fs.get("skipReason").map(|v| v.truthy()).unwrap_or(false) {
                        return true;
                    }
                    if fs.get("consecutiveFailures").is_some() || fs.get("nextAttemptAtMs").is_some() {
                        return true;
                    }
                    if fs.get("cwd").is_none() {
                        return true;
                    }
                    if !personal_sync && fs.get("attributed").is_none() {
                        return true;
                    }
                    if f.size as f64 != fs_min_offset(fs) {
                        return true;
                    }
                    if fs.get_f64("lastMtimeMs") != Some(f.mtime_ms) {
                        return true;
                    }
                    false
                })
                .cloned()
                .collect()
        })
    };
    let first_error: Mutex<Option<String>> = Mutex::new(None);
    let last_progress = Mutex::new(now_ms());
    let worker = |f: &DiscoveredFile| -> bool {
        if let Err(e) = process_parent(f) {
            let mut fe = first_error.lock().unwrap_or_else(|x| x.into_inner());
            if fe.is_none() {
                *fe = Some(e);
            }
            // The lane that threw is done; the others finish their items.
            return false;
        }
        let mut lp = last_progress.lock().unwrap_or_else(|e| e.into_inner());
        if now_ms() - *lp >= SYNC_PROGRESS_MIN_MS {
            *lp = now_ms();
            drop(lp);
            on_progress(ctx.store.read(|state| snapshot_from(&files, state)));
        }
        true
    };
    run_pool(&pooled, file_concurrency, &worker, &stop_pass);
    // runPool rejects with the first lane's error once the lanes still
    // running have finished their items, which the scoped pool above did.
    if let Some(e) = first_error.into_inner().unwrap_or_else(|x| x.into_inner()) {
        return Err(e);
    }

    // Child lanes + workflow sidecars (Claude only). After the parent pass so
    // a brand-new session's parent commit lands first.
    let mut children_quiet = true;
    let mut quiet_until = f64::INFINITY;
    let pause_until = *ctx.child_pause_until.lock().unwrap_or_else(|e| e.into_inner());
    if opts.only.is_none() && now_ms() >= pause_until {
        let outcome: Result<(), String> = (|| {
            let index = ctx.store.read(build_child_parent_index);
            let mut swept_lanes: HashSet<String> = HashSet::new();
            let (mut children, mut runs): (Vec<DiscoveredChildFile>, Vec<DiscoveredWorkflowRun>) = if legacy_sweep {
                discover_claude_children(&roots.claude, Some(RECENT_WINDOW_MS), now_ms())
            } else {
                ctx.catalog.lock().unwrap_or_else(|e| e.into_inner()).list_children()
            };
            // The child sweep, on its own hourly lane (catalog only).
            if !legacy_sweep && backfill_due(ctx, &child_lane, now_ms()) {
                mark_backfill_run(ctx, &child_lane, now_ms());
                let (swept_children, swept_runs) = ctx.store.read(|state| discover_child_backfill(&roots.claude, state, now_ms()));
                let merged = merge_child_backfill(children, runs, swept_children, swept_runs);
                if !merged.added.is_empty() {
                    let unseen = ctx.store.read(|state| merged.added.iter().filter(|c| state.get("files").and_then(|m| m.get(&c.path)).is_none()).count());
                    ctx.log(&format!(
                        "[hx] child backfill: {} lane{} the live sweep did not reach still owe bytes ({} never ingested) — queueing",
                        merged.added.len(),
                        if merged.added.len() == 1 { "" } else { "s" },
                        unseen
                    ));
                } else {
                    ctx.log("[hx] child backfill: swept, no lane outside the live sweep owes bytes");
                }
                for c in &merged.added {
                    swept_lanes.insert(c.path.clone());
                }
                let at = now_ms();
                {
                    let mut cat = ctx.catalog.lock().unwrap_or_else(|e| e.into_inner());
                    for c in &merged.added {
                        cat.adopt_session_dir(c, at);
                    }
                }
                children = merged.children;
                runs = merged.runs;
            }
            let elected = elect_child_uploaders(&children, Some(&log_fn));
            let contested = contested_child_lanes(&children);
            let prev: OMap = ctx.store.read(|state| state.get("childUploaders").and_then(|m| m.as_obj()).cloned().unwrap_or_else(OMap::new));
            let plan = plan_child_lane_resets(&elected, &prev, &contested);
            if plan.changed {
                for p in &plan.reset_paths {
                    let mut reset_offsets = false;
                    ctx.store.mutate(|state| {
                        if let Some(fs) = state.as_obj_mut().and_then(|o| o.get_mut("files")).and_then(|f| f.as_obj_mut()).and_then(|f| f.get_mut(p)) {
                            let has_offsets = fs.get("offsets").and_then(|o| o.as_obj()).map(|o| !o.is_empty()).unwrap_or(false);
                            if has_offsets {
                                fs.set("offsets", Json::obj());
                                reset_offsets = true;
                            }
                            fs.remove("consecutiveFailures");
                            fs.remove("nextAttemptAtMs");
                            fs.remove("skipReason");
                        }
                    });
                    if reset_offsets {
                        ctx.log(&format!("[hx] child lane uploader switched — re-uploading {} from zero", basename(p, "")));
                    }
                }
                let next_map = plan.next_map.clone();
                ctx.store.mutate(|state| state.set("childUploaders", Json::Obj(next_map)));
                ctx.store.persist_state()?;
            }
            // Identity repair for EVERY elected lane, pooled or not.
            for c in &elected {
                let current = match ctx.store.file(&c.path) {
                    Some(x) => x,
                    None => continue,
                };
                if let Some(reconciled) = reconcile_child_parent(&current, index.get(&c.parent_session_id)) {
                    ctx.store.upsert_file_state(reconciled)?;
                }
            }
            let pooled_children: Vec<DiscoveredChildFile> = if legacy_sweep {
                elected.clone()
            } else {
                ctx.store.read(|state| elected.iter().filter(|c| child_needs_pass(c, state.get("files").and_then(|m| m.get(&c.path)))).cloned().collect())
            };
            if !pooled_children.is_empty() {
                children_quiet = false;
            }
            let stop_children = AtomicBool::new(false);
            let child_error: Mutex<Option<String>> = Mutex::new(None);
            let process_child = |c: &DiscoveredChildFile| -> Result<(), String> {
                ctx.beat();
                let pending = ctx.store.file(&c.path);
                if let Some(p) = &pending {
                    if let Some(next) = p.get_f64("nextAttemptAtMs") {
                        if next != 0.0 && next > now_ms() {
                            return Ok(());
                        }
                    }
                }
                let family = pending.as_ref().and_then(|p| p.get_string("family")).unwrap_or_default();
                let sid = pending.as_ref().and_then(|p| p.get_string("sessionId")).unwrap_or_else(|| c.parent_session_id.clone());
                if ctx.store.read(|s| Store::is_deleted_session(s, &family, &sid)) {
                    return Ok(());
                }
                let attempt: Result<(), NetError> = (|| {
                    let did = ingest_child_one(ctx, c, &index, opts)?;
                    if did {
                        uploaded.fetch_add(1, Ordering::SeqCst);
                    }
                    // Drain a rescued lane in place, bounded; the extra chunks do not count as uploads.
                    if did && swept_lanes.contains(&c.path) {
                        for _ in 1..SWEPT_LANE_MAX_CHUNKS {
                            if stop_children.load(Ordering::SeqCst) {
                                break;
                            }
                            if !ingest_child_one(ctx, c, &index, opts)? {
                                break;
                            }
                        }
                    }
                    Ok(())
                })();
                match attempt {
                    Ok(()) => {
                        if let Some(p) = &pending {
                            if p.get("consecutiveFailures").is_some() || p.get("nextAttemptAtMs").is_some() {
                                ctx.store.clear_file_failure(&c.path)?;
                            }
                        }
                    }
                    Err(err) => {
                        failed.fetch_add(1, Ordering::SeqCst);
                        ctx.log(&format!("  [error] {}: {}", c.path, err.message()));
                        if let Some(h) = err.http() {
                            if h.session_deleted() {
                                let fam = if family.is_empty() { "claude-cli".to_string() } else { family.clone() };
                                ctx.store.record_deleted_session(&fam, &sid)?;
                                ctx.store.clear_file_failure(&c.path)?;
                                return Ok(());
                            }
                            if h.vault_offline() {
                                ctx.store.record_file_failure(&c.path, SESSION_SKIP_RETRY_BASE_MS, Some(h.vault_block_reason().unwrap_or("vault_offline")), h.blocker.as_ref())?;
                                return Ok(());
                            }
                        }
                        if latch_child_lane_pause(ctx, &err) {
                            stop_children.store(true, Ordering::SeqCst);
                            return Ok(());
                        }
                        if err.http().map(|h| h.server_unavailable()).unwrap_or(false) {
                            stop_children.store(true, Ordering::SeqCst);
                            return Ok(());
                        }
                        ctx.store.record_file_failure(&c.path, FILE_RETRY_BASE_MS, None, None)?;
                    }
                }
                Ok(())
            };
            let child_worker = |c: &DiscoveredChildFile| -> bool {
                if let Err(e) = process_child(c) {
                    let mut ce = child_error.lock().unwrap_or_else(|x| x.into_inner());
                    if ce.is_none() {
                        *ce = Some(e);
                    }
                    return false;
                }
                true
            };
            run_pool(&pooled_children, child_concurrency, &child_worker, &stop_children);
            if let Some(e) = child_error.into_inner().unwrap_or_else(|x| x.into_inner()) {
                return Err(e);
            }
            for r in &runs {
                let lane_key = format!("{}:{}", r.parent_session_id, r.run_id);
                let lane = ctx.workflow_lanes.lock().unwrap_or_else(|e| e.into_inner()).get(&lane_key).copied();
                match plan_workflow_sync(lane.as_ref(), r.mtime_ms, now_ms()) {
                    WorkflowPlan::SkipUnchanged => continue,
                    WorkflowPlan::SkipBackoff => {
                        if let Some(l) = &lane {
                            quiet_until = quiet_until.min(l.next_attempt_at_ms);
                        }
                        continue;
                    }
                    WorkflowPlan::Sync => {
                        children_quiet = false;
                        match sync_workflow_run(ctx, r, &index) {
                            Ok(()) => {
                                ctx.workflow_lanes
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .insert(lane_key, WorkflowLane { hashed_mtime_ms: r.mtime_ms, consecutive_failures: 0.0, next_attempt_at_ms: 0.0 });
                            }
                            Err(e) => {
                                ctx.workflow_lanes.lock().unwrap_or_else(|x| x.into_inner()).insert(lane_key, workflow_lane_after_failure(lane.as_ref(), now_ms()));
                                if latch_child_lane_pause(ctx, &e) {
                                    break;
                                }
                                ctx.log(&format!("  [error] workflow {}: {}", r.run_id, e.message()));
                            }
                        }
                    }
                }
            }
            Ok(())
        })();
        if let Err(e) = outcome {
            ctx.log(&format!("[hx] child discovery error: {}", e));
            children_quiet = false;
        }
    } else if opts.only.is_none() {
        // Paused: the lanes are tried again once the pause lapses.
        quiet_until = quiet_until.min(pause_until);
    }

    // Flush point: end of every pass. The Claude Desktop index saves on the
    // same beat: forced in a one-shot pass, interval-gated in the daemon.
    ctx.store.flush_if_dirty()?;
    save_ccd_index_if_changed(now_ms(), opts.one_shot);
    let snapshot = ctx.store.read(|state| snapshot_from(&files, state));
    on_progress(snapshot);
    let uploaded_n = uploaded.load(Ordering::SeqCst);
    let failed_n = failed.load(Ordering::SeqCst);
    if !legacy_sweep && opts.only.is_none() {
        // The generations are the ones read before this pass touched anything,
        // so a mutation made by the pass itself sends the next tick the long way.
        *ctx.tick_cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(TickCache {
            catalog_gen: cat_gen,
            store_gen,
            settings_sig,
            snapshot,
            pooled_empty: pooled.is_empty() && uploaded_n == 0 && failed_n == 0 && children_quiet,
            quiet_until,
        });
    }
    Ok(TickResult { uploaded: uploaded_n, failed: failed_n, snapshot })
}

// ── The canonical audit ─────────────────────────────────────────────────────

fn audit_canonicals(ctx: &Ctx, opts: &WatchOptions) -> Result<(), NetError> {
    if *ctx.self_heal.lock().unwrap_or_else(|e| e.into_inner()) == Some(false) {
        return Ok(());
    }
    let roots = resolve_data_roots(&read_settings());
    let now = now_ms();
    // UNWINDOWED: the question does not expire after 30 days.
    let mut files = discover_claude_files(&roots.claude, None, now);
    files.extend(discover_codex_files(&roots.codex, true, None, now));
    if let Some(only) = &opts.only {
        files.retain(|f| f.path == *only);
    }
    let files = ctx.store.read(|state| elect_uploaders(files, state, None));
    let candidates: Vec<(String, Json)> = ctx.store.read(|state| {
        files
            .iter()
            .filter_map(|f| {
                let fs = state.get("files").and_then(|m| m.get(&f.path))?;
                let family = fs.get_string("family").unwrap_or_default();
                let sid = fs.get_string("sessionId").unwrap_or_default();
                if fs_offset_for(fs, None) > 0.0 && !Store::is_deleted_session(state, &family, &sid) {
                    Some((f.path.clone(), fs.clone()))
                } else {
                    None
                }
            })
            .collect()
    });
    if candidates.is_empty() {
        return Ok(());
    }
    let mut healed = 0;
    for batch in candidates.chunks(VERIFY_BATCH) {
        ctx.beat();
        let items: Vec<Json> = batch
            .iter()
            .map(|(_, fs)| {
                obj(vec![
                    ("family", Json::str(&fs.get_string("family").unwrap_or_default())),
                    ("sessionId", Json::str(&fs.get_string("sessionId").unwrap_or_default())),
                    ("byteCount", Json::num(fs_offset_for(fs, None))),
                ])
            })
            .collect();
        let results = match ctx.gw.verify_sessions(items) {
            Ok(r) => r,
            Err(e) => {
                if e.http().map(|h| h.status == 404).unwrap_or(false) {
                    *ctx.self_heal.lock().unwrap_or_else(|x| x.into_inner()) = Some(false);
                    ctx.log("[hx] gateway has no sessions/verify; canonical self-heal disabled");
                    return Ok(());
                }
                return Err(e);
            }
        };
        *ctx.self_heal.lock().unwrap_or_else(|x| x.into_inner()) = Some(true);
        for (path, fs) in batch {
            let family = fs.get_string("family").unwrap_or_default();
            let sid = fs.get_string("sessionId").unwrap_or_default();
            let r = results.iter().find(|r| r.get_string("family").as_deref() == Some(family.as_str()) && r.get_string("sessionId").as_deref() == Some(sid.as_str()));
            let status = r.and_then(|r| r.get_string("status"));
            if status.as_deref() == Some("deleted") {
                ctx.store.record_deleted_session(&family, &sid).map_err(NetError::Other)?;
                ctx.log(&format!("[hx] {}… was permanently deleted on the server — uploads stopped (local file kept)", short_id(&sid)));
                continue;
            }
            if status.as_deref() != Some("divergent") {
                continue;
            }
            if fs.get_f64("healPausedUntilMs").unwrap_or(0.0) > now_ms() {
                continue;
            }
            healed += 1;
            ctx.store.record_heal(path).map_err(NetError::Other)?;
            let store_bytes = r.and_then(|r| r.get_f64("storeBytes")).unwrap_or(0.0);
            ctx.log(&format!(
                "  [heal] {}… canonical {}B ≠ uploaded {}B — re-uploading from zero",
                short_id(&sid),
                num_to_string(store_bytes),
                num_to_string(fs_offset_for(fs, None))
            ));
            ctx.store.set_offset_for(path, None, 0.0, fs.get_f64("lastMtimeMs").unwrap_or(0.0)).map_err(NetError::Other)?;
        }
    }
    if healed > 0 {
        ctx.log(&format!("[hx] canonical audit: re-uploading {} diverged session(s)", healed));
    }
    Ok(())
}

// ── Perf line, watchdog verdict ─────────────────────────────────────────────

#[derive(Default)]
struct Perf {
    passes: u64,
    pass_ms: Vec<f64>,
    uploads: u64,
    flushes: u64,
    sweeps: u64,
    hints: u64,
}

fn format_perf_line(perf: &Perf) -> String {
    let mut sorted = perf.pass_ms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let at = |q: f64| -> f64 {
        if sorted.is_empty() {
            0.0
        } else {
            let idx = ((q * sorted.len() as f64).floor() as usize).min(sorted.len() - 1);
            math_round(sorted[idx])
        }
    };
    let max = sorted.last().copied().unwrap_or(0.0);
    format!(
        "[hx] perf: passes={} passMs p50={} p95={} max={} uploads={} stateFlushes={} sweeps={} hints={}",
        perf.passes,
        num_to_string(at(0.5)),
        num_to_string(at(0.95)),
        num_to_string(math_round(max)),
        perf.uploads,
        perf.flushes,
        perf.sweeps,
        perf.hints
    )
}

pub fn resolve_watchdog_ms(settings: &HxSettings) -> f64 {
    let from_env = std::env::var("HX_WATCHDOG_MINUTES").ok().filter(|v| !v.trim().is_empty());
    let raw: Option<f64> = match from_env {
        Some(v) => v.trim().parse::<f64>().ok(),
        None => tuning_value(settings, "watchdogMinutes").and_then(|v| v.as_f64()),
    };
    let minutes = match raw {
        Some(m) if m.is_finite() => m,
        _ => WATCHDOG_DEFAULT_MINUTES,
    };
    if minutes <= 0.0 {
        return 0.0;
    }
    minutes.max(WATCHDOG_MIN_MINUTES) * 60_000.0
}

fn describe_roots(r: &ResolvedRoots) -> String {
    let one = |d: &DataRoot| format!("{}{}", collapse_home(&d.config_dir), if d.origin == "default" { String::new() } else { format!(" [{}]", d.origin) });
    r.claude.iter().chain(r.codex.iter()).map(one).collect::<Vec<_>>().join(", ")
}

/// What `stop()` leaves behind, and the hooks the signal thread needs.
pub struct DaemonHooks {
    pub stop_requested: Arc<AtomicBool>,
}

/// `startWatch`: the whole loop. Returns after one pass for a one-shot run, or
/// when the daemon is asked to stop.
pub fn start_watch(ctx: Arc<Ctx>, opts: WatchOptions, hooks: Option<DaemonHooks>) {
    let settings0 = read_settings();
    ctx.log(&format!("[hx] watching data roots: {}", describe_roots(&resolve_data_roots(&settings0))));
    ctx.log(&format!("[hx] poll interval {}ms; gateway {}", num_to_string(FAST_POLL_MS), ctx.cfg.gateway_base_url));
    trim_activity();

    if !opts.one_shot {
        ctx.store.arm_coalesced();
        let logger = ctx.clone();
        let log_fn: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |m: &str| logger.log(m));
        ctx.catalog.lock().unwrap_or_else(|e| e.into_inner()).enable_file_events(log_fn);
    }

    // Best-effort (a try/catch in startWatch): an unreadable state file surfaces through the normal pass.
    if let Ok((keys, nfiles)) = ctx.store.prune_stranded_offsets() {
        if keys > 0 {
            ctx.log(&format!(
                "[hx] dropped {} offset key{} for unknown destinations across {} session{} no longer on disk",
                keys,
                if keys == 1 { "" } else { "s" },
                nfiles,
                if nfiles == 1 { "" } else { "s" }
            ));
        }
        if let Ok(dropped) = ctx.store.clear_generic_backoffs() {
            if dropped > 0 {
                ctx.log(&format!("[hx] cleared {} stale retry backoff{} on start", dropped, if dropped == 1 { "" } else { "s" }));
            }
        }
    }

    let mut last_roots_sig = String::new();
    let mut last_stamp_at = 0.0f64;
    let mut stamp_failure_logged = false;
    // Gated to the main lane's persistent daemon: one-shot runs and the
    // `--local` tee run with an arbitrary shell env and must not overwrite it.
    let publish_roots = |settings: &HxSettings, last_sig: &mut String, last_at: &mut f64, failure_logged: &mut bool| {
        if opts.one_shot || ctx.scope != "main" {
            return;
        }
        let roots = resolve_data_roots(settings);
        let sig = roots_signature(&roots);
        if sig == *last_sig && now_ms() - *last_at < RESTAMP_INTERVAL_MS {
            return;
        }
        let changed = !last_sig.is_empty() && sig != *last_sig;
        match ctx.store.stamp_effective_roots(&roots) {
            Ok(()) => {
                *last_sig = sig;
                *last_at = now_ms();
                *failure_logged = false;
                if changed {
                    ctx.log(&format!("[hx] watch roots updated: {}", describe_roots(&roots)));
                }
            }
            Err(e) => {
                if !*failure_logged {
                    *failure_logged = true;
                    ctx.log(&format!("[hx] couldn't persist watch roots (will keep retrying): {}", e));
                }
            }
        }
    };

    // Shared with the report threads, which record a report's answer as contact.
    let last_contact = Arc::new(Mutex::new(0.0f64));
    let last_sync_sig = Mutex::new(String::new());
    let last_sync_sent = Mutex::new(0.0f64);
    let reports = Arc::new(ReportsInFlight::default());
    let report_sync = |snap: SyncSnapshot| {
        let sig = format!("{}/{}/{}", snap.done, snap.total, snap.total_bytes);
        {
            let mut last = last_sync_sig.lock().unwrap_or_else(|e| e.into_inner());
            if *last == sig {
                return;
            }
            let caught_up = snap.total > 0 && snap.done >= snap.total;
            let now = now_ms();
            let mut sent = last_sync_sent.lock().unwrap_or_else(|e| e.into_inner());
            if !caught_up && now - *sent < SYNC_REPORT_MIN_MS {
                return;
            }
            *last = sig;
            *sent = now;
        }
        // Sent without waiting for the answer: the pass goes on to its uploads.
        let in_flight = reports.start();
        let (report_ctx, report_contact) = (ctx.clone(), last_contact.clone());
        let spawned = std::thread::Builder::new().name("hx-sync-status".to_string()).spawn(move || {
            send_sync_report(&report_ctx, &report_contact, snap);
            drop(in_flight);
        });
        if spawned.is_err() {
            // No thread to be had: send the report on this thread and wait for it.
            send_sync_report(&ctx, &last_contact, snap);
        }
    };

    let pass_busy = AtomicBool::new(false);
    let pass_started = Mutex::new(0.0f64);
    let mut watchdog_limit_ms = resolve_watchdog_ms(&settings0);
    let mut upload_backoff_ms = 0.0f64;
    let mut pause_uploads_until = 0.0f64;
    let mut was_paused = false;
    let mut perf = Perf::default();

    let mut run = |watchdog_limit_ms: &mut f64, upload_backoff_ms: &mut f64, pause_uploads_until: &mut f64, was_paused: &mut bool, perf: &mut Perf| {
        if pass_busy.swap(true, Ordering::SeqCst) {
            return;
        }
        *pass_started.lock().unwrap_or_else(|e| e.into_inner()) = now_ms();
        // Every tick observes the root set fresh: a mirror or audit timer
        // must not leave the sub-tick memo warm across a tick boundary.
        invalidate_roots_memo();
        let pass_start = now_ms();
        let settings = read_settings();
        *watchdog_limit_ms = resolve_watchdog_ms(&settings);
        publish_roots(&settings, &mut last_roots_sig, &mut last_stamp_at, &mut stamp_failure_logged);
        let mut skip = false;
        let mut did_work = false;
        if now_ms() < *pause_uploads_until {
            skip = true;
        } else if is_paused(&settings, now_ms()) {
            if !*was_paused {
                *was_paused = true;
                let until = settings.pause.and_then(|p| p).filter(|ms| *ms != 0.0);
                let suffix = match until {
                    Some(ms) => format!(" until {}", to_locale_time_string_en_us(ms)),
                    None => " until resumed".to_string(),
                };
                ctx.log(&format!("[hx] sync paused{}", suffix));
            }
            skip = true;
        }
        if !skip {
            if *was_paused {
                *was_paused = false;
                ctx.log("[hx] sync resumed");
            }
            match tick_once(&ctx, &opts, &report_sync) {
                Ok(r) => {
                    perf.uploads += r.uploaded;
                    if r.uploaded > 0 || r.failed > 0 {
                        did_work = true;
                        if r.uploaded > 0 {
                            *last_contact.lock().unwrap_or_else(|e| e.into_inner()) = now_ms();
                        }
                        ctx.log(&format!("[hx] tick uploaded={} failed={}", r.uploaded, r.failed));
                    }
                    if r.uploaded == 0 && r.failed > 0 {
                        *upload_backoff_ms = if *upload_backoff_ms > 0.0 { (*upload_backoff_ms * 2.0).min(UPLOAD_BACKOFF_MAX_MS) } else { UPLOAD_BACKOFF_BASE_MS };
                        *pause_uploads_until = now_ms() + *upload_backoff_ms;
                        ctx.log(&format!("[hx] uploads not progressing; backing off {}s", num_to_string(math_round(*upload_backoff_ms / 1000.0))));
                    } else if *upload_backoff_ms > 0.0 {
                        *upload_backoff_ms = 0.0;
                        *pause_uploads_until = 0.0;
                        ctx.log("[hx] uploads recovered; resuming normal cadence");
                    }
                }
                Err(e) => ctx.log(&format!("[hx] tick error: {}", e)),
            }
        }
        perf.passes += 1;
        perf.pass_ms.push(now_ms() - pass_start);
        pass_busy.store(false, Ordering::SeqCst);
        if did_work || perf.passes == 1 {
            release_freed_memory();
        }
    };

    let beat_gateway = || {
        if now_ms() - *last_contact.lock().unwrap_or_else(|e| e.into_inner()) < HEARTBEAT_MS {
            return;
        }
        match ctx.gw.send_heartbeat() {
            Ok(()) => *last_contact.lock().unwrap_or_else(|e| e.into_inner()) = now_ms(),
            Err(e) => ctx.log(&format!("[hx] heartbeat error: {}", e.message())),
        }
    };

    let audit = || {
        if pass_busy.swap(true, Ordering::SeqCst) {
            return;
        }
        *pass_started.lock().unwrap_or_else(|e| e.into_inner()) = now_ms();
        if let Err(e) = audit_canonicals(&ctx, &opts) {
            ctx.log(&format!("[hx] canonical audit error: {}", e.message()));
        }
        pass_busy.store(false, Ordering::SeqCst);
    };

    let log_fn = |m: &str| ctx.log(m);

    audit();
    run(&mut watchdog_limit_ms, &mut upload_backoff_ms, &mut pause_uploads_until, &mut was_paused, &mut perf);
    // If nothing but the first pass's progress reports can have reached the
    // gateway, their answers decide whether the first beat goes out, so the
    // beat waits for them. The TypeScript client gets the same outcome without
    // waiting: its first beat runs after the pass's file work, and by then the
    // report sent at the pass's start has its answer. (The harness's
    // readonly-state pass uploads nothing, and neither client beats after it.)
    if now_ms() - *last_contact.lock().unwrap_or_else(|e| e.into_inner()) >= HEARTBEAT_MS {
        reports.wait();
    }
    beat_gateway();
    sync_group_mirror(&ctx.store, &ctx.gw, &log_fn);
    sync_team_mirror(&ctx.store, &ctx.gw, &log_fn);
    if let Err(e) = run_reattribute_sweep(&ctx.cfg, &ctx.store, &ctx.gw, &log_fn, false) {
        ctx.log(&format!("[hx] attribution sweep error: {}", e.message()));
    }
    // One-shot codex title backfill (title-sync.ts) — no-ops when every codex
    // file already carries the current TITLE_SYNC_VERSION stamp.
    if let Err(e) = run_title_sync_sweep(&ctx.cfg, &ctx.store, &ctx.gw, &log_fn, false) {
        ctx.log(&format!("[hx] title sweep error: {}", e.message()));
    }
    release_freed_memory();
    if opts.one_shot {
        // Every write the pass asked for is on disk before the process exits,
        // and every progress report has its answer: the TypeScript process
        // stays alive until its pending fetches settle.
        reports.wait();
        ctx.store.drain();
        return;
    }
    let hooks = match hooks {
        Some(h) => h,
        None => return,
    };

    // Timers, on the daemon's clock.
    let start = now_ms();
    let mut next_tick = start + FAST_POLL_MS;
    let mut next_beat = start + HEARTBEAT_MS;
    let mut next_mirror = start + MIRROR_SYNC_MS;
    let mut next_audit = start + VERIFY_INTERVAL_MS;
    let mut next_flush = start + STATE_FLUSH_MS;
    let mut next_perf = start + PERF_LOG_MS;
    let mut next_watchdog = start + WATCHDOG_CHECK_MS;
    let mut flush_failure_logged = false;
    let mut sweeps_seen = 0u64;
    let mut hints_seen = 0u64;
    loop {
        if hooks.stop_requested.load(Ordering::SeqCst) {
            break;
        }
        ctx.beat.fetch_add(1, Ordering::Relaxed);
        let now = now_ms();
        if now >= next_tick {
            run(&mut watchdog_limit_ms, &mut upload_backoff_ms, &mut pause_uploads_until, &mut was_paused, &mut perf);
            while next_tick <= now_ms() {
                next_tick += FAST_POLL_MS;
            }
        }
        if now >= next_beat {
            beat_gateway();
            while next_beat <= now_ms() {
                next_beat += HEARTBEAT_MS;
            }
        }
        if now >= next_mirror {
            sync_group_mirror(&ctx.store, &ctx.gw, &log_fn);
            sync_team_mirror(&ctx.store, &ctx.gw, &log_fn);
            while next_mirror <= now_ms() {
                next_mirror += MIRROR_SYNC_MS;
            }
        }
        if now >= next_audit {
            audit();
            while next_audit <= now_ms() {
                next_audit += VERIFY_INTERVAL_MS;
            }
        }
        if now >= next_flush {
            if ctx.store.state_flush_due() {
                perf.flushes += 1;
                match ctx.store.flush_if_dirty() {
                    Ok(()) => flush_failure_logged = false,
                    Err(e) => {
                        if !flush_failure_logged {
                            flush_failure_logged = true;
                            ctx.log(&format!("[hx] state flush error: {} (will keep retrying)", e));
                        }
                    }
                }
            }
            while next_flush <= now_ms() {
                next_flush += STATE_FLUSH_MS;
            }
        }
        if now >= next_perf {
            if perf.passes > 0 {
                let counters = ctx.catalog.lock().unwrap_or_else(|e| e.into_inner()).counters;
                perf.sweeps = counters.full_sweeps - sweeps_seen;
                perf.hints = counters.hints - hints_seen;
                sweeps_seen = counters.full_sweeps;
                hints_seen = counters.hints;
                ctx.log(&format_perf_line(&perf));
                perf = Perf::default();
            }
            while next_perf <= now_ms() {
                next_perf += PERF_LOG_MS;
            }
        }
        if now >= next_watchdog {
            let busy = pass_busy.load(Ordering::SeqCst);
            let started = *pass_started.lock().unwrap_or_else(|e| e.into_inner());
            let last_log = ctx.last_log_ms.load(Ordering::Relaxed) as f64;
            let now2 = now_ms();
            let busy_for = if busy { now2 - started } else { 0.0 };
            let quiet_for = now2 - last_log;
            if watchdog_limit_ms > 0.0 && busy && busy_for >= watchdog_limit_ms && quiet_for >= watchdog_limit_ms {
                ctx.log(&format!(
                    "[hx] watchdog: a pass has been running for {} min with no log line for {} min (limit {} min); exiting {} so the service manager restarts the daemon",
                    num_to_string(math_round(busy_for / 60_000.0)),
                    num_to_string(math_round(quiet_for / 60_000.0)),
                    num_to_string(math_round(watchdog_limit_ms / 60_000.0)),
                    WATCHDOG_EXIT_CODE
                ));
                let _ = ctx.store.checkpoint_state();
                crate::daemon::exit_with(WATCHDOG_EXIT_CODE);
            }
            while next_watchdog <= now_ms() {
                next_watchdog += WATCHDOG_CHECK_MS;
            }
        }
        let next_due = [next_tick, next_beat, next_mirror, next_audit, next_flush, next_perf, next_watchdog].iter().cloned().fold(f64::INFINITY, f64::min);
        let wait = (next_due - now_ms()).clamp(1.0, 500.0);
        std::thread::sleep(Duration::from_millis(wait as u64));
    }

    // stop(): close events, a parting checkpoint, the index saved once more,
    // back to flush-through.
    ctx.catalog.lock().unwrap_or_else(|e| e.into_inner()).disable_file_events();
    let _ = ctx.store.checkpoint_state();
    save_ccd_index_if_changed(now_ms(), true);
    ctx.store.disarm_coalesced();
    ctx.store.drain();
}
