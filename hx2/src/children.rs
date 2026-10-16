//! Child execution lanes (watch.ts): the subagent and workflow-agent
//! transcripts under a session's artifact dir, uploaded through the agent
//! endpoints with the parent's identity, elected one uploader per lane, and
//! the workflow-run sidecars (script + journal) behind their mtime gate and
//! retry backoff.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::artifacts::read_agent_meta;
use crate::fsutil::{basename, exists, now_ms, stat_safe};
use crate::js::{js_locale_compare, JsStr};
use crate::json::{obj, Json, OMap};
use crate::mirror::{read_text_file, sha1_hex};
use crate::net::{agent_commit_body, put_chunk, NetError};
use crate::parse::summarise_chunk;
use crate::sources::{discover_claude_children, read_head, DiscoveredChildFile, DiscoveredWorkflowRun};
use crate::report::note_shadowed;
use crate::state::{fs_min_offset, FILE_BACKOFF_CAP_MS};
use crate::watch::{read_slice, trim_at_last_newline, Ctx, WatchOptions, DEFAULT_CHUNK_LIMIT, FILE_RETRY_BASE_MS};

/// How long child uploads pause after a wholesale rejection (404/401/403).
pub const CHILD_ENDPOINT_RETRY_MS: f64 = 10.0 * 60_000.0;

#[derive(Clone, Debug, PartialEq)]
pub struct ChildParentIdentity {
    pub family: String,
    pub session_id: String,
}

/// Map Claude's on-disk artifact-directory id to the parent identity hx
/// sends: the parent FileState's basename → (family, sessionId). Conflicting
/// basenames are omitted; child entries are excluded.
pub fn build_child_parent_index(state: &Json) -> HashMap<String, ChildParentIdentity> {
    let mut index: HashMap<String, ChildParentIdentity> = HashMap::new();
    let mut ambiguous: HashSet<String> = HashSet::new();
    if let Some(files) = state.get("files").and_then(|f| f.as_obj()) {
        for (_, file) in files.iter() {
            let path = file.get_string("path").unwrap_or_default();
            if !path.ends_with(".jsonl") {
                continue;
            }
            if path.split('/').any(|seg| seg == "subagents") {
                continue;
            }
            let artifact_session_id = basename(&path, ".jsonl");
            if artifact_session_id.starts_with("rollout-") {
                continue;
            }
            if ambiguous.contains(&artifact_session_id) {
                continue;
            }
            let identity = ChildParentIdentity { family: file.get_string("family").unwrap_or_default(), session_id: file.get_string("sessionId").unwrap_or_default() };
            if let Some(existing) = index.get(&artifact_session_id) {
                if *existing != identity {
                    index.remove(&artifact_session_id);
                    ambiguous.insert(artifact_session_id);
                    continue;
                }
            }
            index.insert(artifact_session_id, identity);
        }
    }
    index
}

/// Repair a persisted child identity after learning its canonical parent;
/// None when nothing changes. A session-id change replays from zero.
pub fn reconcile_child_parent(child: &Json, parent: Option<&ChildParentIdentity>) -> Option<Json> {
    let parent = parent?;
    let session_changed = child.get_string("sessionId").unwrap_or_default() != parent.session_id;
    if !session_changed && child.get_string("family").unwrap_or_default() == parent.family {
        return None;
    }
    let mut next = child.clone();
    next.set("family", Json::str(&parent.family));
    next.set("sessionId", Json::str(&parent.session_id));
    if session_changed {
        next.set("offsets", Json::obj());
        next.set("lastUploadAtMs", Json::num(0.0));
    }
    next.remove("consecutiveFailures");
    next.remove("nextAttemptAtMs");
    next.remove("skipReason");
    if session_changed {
        next.remove("healCount");
        next.remove("healPausedUntilMs");
    }
    Some(next)
}

fn lane_key(c: &DiscoveredChildFile) -> String {
    format!("{}:{}:{}", c.parent_session_id, c.agent_id, c.run_id.clone().unwrap_or_default())
}

pub struct LanePlan {
    pub next_map: OMap,
    pub reset_paths: Vec<String>,
    pub changed: bool,
}

/// `planChildLaneResets`: remember each lane's winner; on a flip (or a
/// contested first sighting) the new winner re-uploads from zero.
pub fn plan_child_lane_resets(elected: &[DiscoveredChildFile], prev: &OMap, contested: &HashSet<String>) -> LanePlan {
    let mut next_map = prev.clone();
    let mut reset_paths: Vec<String> = Vec::new();
    let mut changed = false;
    for c in elected {
        let lane = lane_key(c);
        let before = next_map.get(&lane).and_then(|v| v.as_string());
        if before.as_deref() == Some(c.path.as_str()) {
            continue;
        }
        if before.is_some() || contested.contains(&lane) {
            reset_paths.push(c.path.clone());
        }
        next_map.set(&lane, Json::str(&c.path));
        changed = true;
    }
    LanePlan { next_map, reset_paths, changed }
}

/// `childNeedsPass`: the parent-file gate, applied to a lane.
pub fn child_needs_pass(c: &DiscoveredChildFile, fs: Option<&Json>) -> bool {
    let fs = match fs {
        Some(f) => f,
        None => return true,
    };
    if fs.get("skipReason").map(|v| v.truthy()).unwrap_or(false) {
        return true;
    }
    if fs.get("consecutiveFailures").is_some() || fs.get("nextAttemptAtMs").is_some() {
        return true;
    }
    if c.size as f64 != fs_min_offset(fs) {
        return true;
    }
    if fs.get_f64("lastMtimeMs") != Some(c.mtime_ms) {
        return true;
    }
    false
}

/// Lanes with more than one discovered candidate this tick.
pub fn contested_child_lanes(children: &[DiscoveredChildFile]) -> HashSet<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for c in children {
        *counts.entry(lane_key(c)).or_insert(0) += 1;
    }
    counts.into_iter().filter(|(_, n)| *n > 1).map(|(k, _)| k).collect()
}

/// `electChildUploaders`: newest mtime wins (tie: largest, then the path's
/// collation order); losers are shadowed and announced once per process.
pub fn elect_child_uploaders(children: &[DiscoveredChildFile], log: Option<&dyn Fn(&str)>) -> Vec<DiscoveredChildFile> {
    let mut by_key: Vec<(String, Vec<DiscoveredChildFile>)> = Vec::new();
    for c in children {
        let key = lane_key(c);
        match by_key.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1.push(c.clone()),
            None => by_key.push((key, vec![c.clone()])),
        }
    }
    let mut active: Vec<DiscoveredChildFile> = Vec::new();
    for (_, mut list) in by_key {
        list.sort_by(|a, b| {
            b.mtime_ms
                .partial_cmp(&a.mtime_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.size.cmp(&a.size))
                .then_with(|| js_locale_compare(&a.path, &b.path))
        });
        let winner = list.remove(0);
        if let Some(log) = log {
            for twin in &list {
                if note_shadowed(&twin.path) {
                    log(&format!("[hx] {} shadows {} (same child lane); not uploading the twin", twin.path, winner.path));
                }
            }
        }
        active.push(winner);
    }
    active
}

// ── The child backfill (backfill.ts) ────────────────────────────────────────

fn select_child_backfill(all: Vec<DiscoveredChildFile>, state: &Json) -> Vec<DiscoveredChildFile> {
    all.into_iter()
        .filter(|c| match state.get("files").and_then(|m| m.get(&c.path)) {
            Some(fs) => fs_min_offset(fs) < c.size as f64,
            None => true,
        })
        .collect()
}

/// Unwindowed child discovery plus owed-ness selection; only the runs of
/// sessions whose lanes were rescued come along.
pub fn discover_child_backfill(roots: &[crate::roots::DataRoot], state: &Json, now: f64) -> (Vec<DiscoveredChildFile>, Vec<DiscoveredWorkflowRun>) {
    let (children, runs) = discover_claude_children(roots, None, now);
    let owed = select_child_backfill(children, state);
    let owed_sessions: HashSet<String> = owed.iter().map(|c| c.parent_session_id.clone()).collect();
    let runs: Vec<DiscoveredWorkflowRun> = runs.into_iter().filter(|r| owed_sessions.contains(&r.parent_session_id)).collect();
    (owed, runs)
}

pub struct ChildMerge {
    pub children: Vec<DiscoveredChildFile>,
    pub runs: Vec<DiscoveredWorkflowRun>,
    pub added: Vec<DiscoveredChildFile>,
}

/// `mergeChildBackfill`: lanes merged by path; runs merged fill-missing on
/// BOTH paths (the live walk's value wins).
pub fn merge_child_backfill(children: Vec<DiscoveredChildFile>, runs: Vec<DiscoveredWorkflowRun>, swept_children: Vec<DiscoveredChildFile>, swept_runs: Vec<DiscoveredWorkflowRun>) -> ChildMerge {
    let mut seen: HashSet<String> = children.iter().map(|c| c.path.clone()).collect();
    let mut added: Vec<DiscoveredChildFile> = Vec::new();
    for c in swept_children {
        if seen.contains(&c.path) {
            continue;
        }
        seen.insert(c.path.clone());
        added.push(c);
    }
    let mut merged_runs: Vec<DiscoveredWorkflowRun> = runs;
    for r in swept_runs {
        match merged_runs.iter_mut().find(|m| m.parent_session_id == r.parent_session_id && m.run_id == r.run_id) {
            None => merged_runs.push(r),
            Some(existing) => {
                if r.journal_path.is_some() && existing.journal_path.is_none() {
                    existing.journal_path = r.journal_path.clone();
                }
                if r.script_path.is_some() && existing.script_path.is_none() {
                    existing.script_path = r.script_path.clone();
                    existing.script_name = r.script_name.clone();
                }
                existing.mtime_ms = existing.mtime_ms.max(r.mtime_ms);
            }
        }
    }
    let mut all_children = children;
    all_children.extend(added.iter().cloned());
    ChildMerge { children: all_children, runs: merged_runs, added }
}

// ── Workflow sidecars: the mtime gate and the retry backoff ────────────────

#[derive(Clone, Copy, Debug)]
pub struct WorkflowLane {
    /// The run mtime the sidecar was last hashed at (-1: never).
    pub hashed_mtime_ms: f64,
    pub consecutive_failures: f64,
    pub next_attempt_at_ms: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WorkflowPlan {
    Sync,
    SkipBackoff,
    SkipUnchanged,
}

pub fn plan_workflow_sync(lane: Option<&WorkflowLane>, run_mtime_ms: f64, now_ms: f64) -> WorkflowPlan {
    let lane = match lane {
        Some(l) => l,
        None => return WorkflowPlan::Sync,
    };
    if lane.next_attempt_at_ms > now_ms {
        return WorkflowPlan::SkipBackoff;
    }
    if lane.consecutive_failures == 0.0 && lane.hashed_mtime_ms == run_mtime_ms {
        return WorkflowPlan::SkipUnchanged;
    }
    WorkflowPlan::Sync
}

pub fn workflow_lane_after_failure(lane: Option<&WorkflowLane>, now_ms: f64) -> WorkflowLane {
    let n = lane.map(|l| l.consecutive_failures).unwrap_or(0.0) + 1.0;
    let delay = (FILE_RETRY_BASE_MS * 2f64.powf(n - 1.0)).min(FILE_BACKOFF_CAP_MS);
    WorkflowLane { hashed_mtime_ms: lane.map(|l| l.hashed_mtime_ms).unwrap_or(-1.0), consecutive_failures: n, next_attempt_at_ms: now_ms + delay }
}

/// `latchChildLanePause`: a wholesale rejection (404 missing endpoints,
/// 401/403 front-door auth) pauses the lane for CHILD_ENDPOINT_RETRY_MS.
pub fn latch_child_lane_pause(ctx: &Ctx, err: &NetError) -> bool {
    let h = match err.http() {
        Some(h) => h,
        None => return false,
    };
    if h.status != 404 && h.status != 401 && h.status != 403 {
        return false;
    }
    *ctx.child_pause_until.lock().unwrap_or_else(|e| e.into_inner()) = now_ms() + CHILD_ENDPOINT_RETRY_MS;
    let msg = if h.status == 404 { "[hx] gateway has no child-lane endpoints yet; pausing child uploads".to_string() } else { format!("[hx] child-lane uploads rejected ({}); pausing", h.status) };
    ctx.log(&msg);
    true
}

fn opt_js(s: &Option<JsStr>) -> Json {
    match s {
        Some(v) => Json::Str(v.clone()),
        None => Json::Null,
    }
}

fn short_id(sid: &str) -> String {
    sid.chars().take(8).collect()
}

/// `ingestChildOne`: upload fresh bytes for one child-lane transcript.
pub fn ingest_child_one(ctx: &Ctx, child: &DiscoveredChildFile, index: &HashMap<String, ChildParentIdentity>, opts: &WatchOptions) -> Result<bool, NetError> {
    let st = match stat_safe(Path::new(&child.path)) {
        Some(s) => s,
        None => return Ok(false),
    };
    let parent = index.get(&child.parent_session_id);
    let fstate = match ctx.store.file(&child.path) {
        None => {
            let seeded = obj(vec![
                ("path", Json::str(&child.path)),
                ("family", Json::str(parent.map(|p| p.family.as_str()).unwrap_or("claude-cli"))),
                ("sessionId", Json::str(parent.map(|p| p.session_id.as_str()).unwrap_or(child.parent_session_id.as_str()))),
                ("offsets", Json::obj()),
                ("lastMtimeMs", Json::num(st.mtime_ms)),
                ("lastUploadAtMs", Json::num(0.0)),
            ]);
            ctx.store.upsert_file_state(seeded.clone()).map_err(NetError::Other)?;
            seeded
        }
        Some(existing) => match reconcile_child_parent(&existing, parent) {
            Some(reconciled) => {
                ctx.store.upsert_file_state(reconciled.clone()).map_err(NetError::Other)?;
                reconciled
            }
            None => existing,
        },
    };
    let child_offset = fs_min_offset(&fstate) as u64;
    if st.size <= child_offset {
        if fstate.get_f64("lastMtimeMs") != Some(st.mtime_ms) {
            ctx.store.touch_mtime(&child.path, st.mtime_ms).map_err(NetError::Other)?;
        }
        return Ok(false);
    }
    let family = fstate.get_string("family").unwrap_or_default();
    let session_id = fstate.get_string("sessionId").unwrap_or_default();
    let want = (st.size - child_offset).min(opts.chunk_limit_bytes.unwrap_or(DEFAULT_CHUNK_LIMIT));
    let slice = read_slice(&child.path, child_offset, want).map_err(|e| NetError::Other(e.to_string()))?;
    let (trimmed, end_offset) = trim_at_last_newline(slice, child_offset);
    if trimmed.is_empty() {
        return Ok(false);
    }
    let replace = child_offset == 0;
    let append = ctx.gw.request_agent_append_url(&family, &session_id, &child.agent_id, trimmed.len() as u64)?;
    put_chunk(&append.get_string("uploadUrl").unwrap_or_default(), &trimmed)?;
    let text = String::from_utf8_lossy(&trimmed).into_owned();
    let summary = summarise_chunk(&text);
    let meta = read_agent_meta(child.meta_path.as_deref());
    let head = read_head(&child.path, "claude", true);
    let is_workflow = child.run_id.as_ref().map(|r| !r.is_empty()).unwrap_or(false)
        || meta.as_ref().and_then(|m| m.agent_type.as_ref()).and_then(|v| v.as_string()).as_deref() == Some("workflow-subagent");
    let kind = if is_workflow { "workflow_agent" } else { "subagent" };
    let meta_field = |pick: fn(&crate::artifacts::AgentMeta) -> Option<Json>| -> Json { meta.as_ref().and_then(pick).unwrap_or(Json::Null) };
    let commit_meta = obj(vec![
        ("kind", Json::str(kind)),
        ("runId", Json::opt_str(child.run_id.as_deref())),
        ("toolUseId", meta_field(|m| m.tool_use_id.clone())),
        ("agentType", meta_field(|m| m.agent_type.clone())),
        ("label", meta_field(|m| m.description.clone())),
        ("worktreePath", meta_field(|m| m.worktree_path.clone())),
        ("cwd", opt_js(&head.cwd)),
        ("gitBranch", opt_js(&head.git_branch)),
        ("eventCount", Json::num(summary.event_count as f64)),
        ("lastActivityAt", opt_js(&summary.last_activity_at)),
    ]);
    // `vaultOrgId: append.vaultOrgId` — absent on a gateway that predates
    // per-session routing (dropped from the body), null for let.ai.
    let vault_field: Option<Json> = append.get("vaultOrgId").cloned();
    let body = agent_commit_body(&family, &session_id, &child.agent_id, &append.get_string("chunkId").unwrap_or_default(), replace, vault_field, commit_meta);
    ctx.gw.commit_agent_chunk(&body)?;
    let vault_key: Option<String> = append.get("vaultOrgId").and_then(|v| v.as_string());
    ctx.store.set_offset_for(&child.path, vault_key.as_deref(), end_offset as f64, st.mtime_ms).map_err(NetError::Other)?;
    ctx.log(&format!(
        "  [agent] {}…/{}… (+{}B{})",
        short_id(&session_id),
        short_id(&child.agent_id),
        trimmed.len(),
        match &child.run_id {
            Some(r) if !r.is_empty() => format!(", {}", r),
            _ => String::new(),
        }
    ));
    Ok(true)
}

/// `syncWorkflowRun`: the run's script + journal, whole-file, hash-gated.
pub fn sync_workflow_run(ctx: &Ctx, run: &DiscoveredWorkflowRun, index: &HashMap<String, ChildParentIdentity>) -> Result<(), NetError> {
    let parent = index.get(&run.parent_session_id);
    let family = parent.map(|p| p.family.clone()).unwrap_or_else(|| "claude-cli".to_string());
    let session_id = parent.map(|p| p.session_id.clone()).unwrap_or_else(|| run.parent_session_id.clone());
    let journal = run.journal_path.as_deref().and_then(read_text_file_default);
    let script = run.script_path.as_deref().and_then(read_text_file_default);
    let journal_truthy = journal.as_ref().map(|s| !s.is_empty()).unwrap_or(false);
    let script_truthy = script.as_ref().map(|s| !s.is_empty()).unwrap_or(false);
    if !journal_truthy && !script_truthy {
        return Ok(());
    }
    let key = format!("{}:{}:wf:{}", family, session_id, run.run_id);
    let hash = sha1_hex(&format!("{}\n--journal--\n{}", script.clone().unwrap_or_default(), journal.clone().unwrap_or_default()));
    if ctx.store.get_artifact_hash(&key).as_deref() == Some(hash.as_str()) {
        return Ok(());
    }
    let args = obj(vec![
        ("family", Json::str(&family)),
        ("sessionId", Json::str(&session_id)),
        ("runId", Json::str(&run.run_id)),
        ("scriptName", Json::opt_str(run.script_name.as_deref())),
        ("script", Json::opt_str(script.as_deref())),
        ("journal", Json::opt_str(journal.as_deref())),
    ]);
    ctx.gw.upload_workflow_run(&args)?;
    ctx.store.set_artifact_hash(&key, &hash).map_err(NetError::Other)?;
    ctx.log(&format!("  [workflow] {}…/{}", short_id(&session_id), run.run_id));
    Ok(())
}

/// `readTextFile(p)` with artifacts.ts's default size cap.
fn read_text_file_default(p: &str) -> Option<String> {
    read_text_file(p, crate::mirror::TEXT_FILE_MAX_BYTES)
}

/// Whether a path is still on disk (collectBehind, the child-lane counts).
pub fn on_disk(p: &str) -> bool {
    exists(Path::new(p))
}
