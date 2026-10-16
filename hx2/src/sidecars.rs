//! Sidecar artifacts (watch.ts syncArtifacts / backfillArtifacts): a
//! session's task set and plan file, whole-file and content-hash-gated.

use crate::artifacts::{list_task_session_ids, order_tasks_dirs, read_plan_file, read_plan_for_jsonl, read_task_set};
use crate::fsutil::{basename, now_ms};
use crate::json::Json;
use crate::mirror::sha1_hex;
use crate::net::NetError;
use crate::parse::find_plan_path_in_text;
use crate::roots::{claude_tasks_dir, resolve_data_roots, ResolvedRoots};
use crate::settings::read_settings;
use crate::sources::{discover_claude_files, read_head, RECENT_WINDOW_MS};
use crate::watch::Ctx;

fn short_id(sid: &str) -> String {
    sid.chars().take(8).collect()
}

/// Tasks dirs in probe order: the live transcript's own root first.
pub fn order_tasks_dirs_for(roots: &ResolvedRoots, preferred_root_dir: Option<&str>) -> Vec<String> {
    let dirs: Vec<String> = roots.claude.iter().map(|r| claude_tasks_dir(&r.config_dir)).collect();
    order_tasks_dirs(dirs, preferred_root_dir.map(claude_tasks_dir))
}

/// After a session's transcript chunk lands, sync its sidecars: the whole
/// tasks set, and the plan this chunk introduced. Both hash-gated.
pub fn sync_artifacts(ctx: &Ctx, fstate: &Json, chunk_text: &str, preferred_root_dir: Option<&str>) -> Result<(), NetError> {
    let settings = read_settings();
    let tasks_dirs = order_tasks_dirs_for(&resolve_data_roots(&settings), preferred_root_dir);
    let family = fstate.get_string("family").unwrap_or_default();
    let session_id = fstate.get_string("sessionId").unwrap_or_default();
    if let Some(tasks) = read_task_set(&session_id, &tasks_dirs) {
        if !tasks.is_empty() {
            let key = format!("{}:{}:tasks", family, session_id);
            let hash = sha1_hex(&Json::Arr(tasks.clone()).stringify());
            if ctx.store.get_artifact_hash(&key).as_deref() != Some(hash.as_str()) {
                let count = tasks.len();
                ctx.gw.upload_tasks(&family, &session_id, tasks)?;
                ctx.store.set_artifact_hash(&key, &hash).map_err(NetError::Other)?;
                ctx.log(&format!("  [tasks] {}… ({})", short_id(&session_id), count));
            }
        }
    }
    if let Some(plan_path) = find_plan_path_in_text(chunk_text) {
        if let Some((plan_file_path, content)) = read_plan_file(&plan_path) {
            let key = format!("{}:{}:plan", family, session_id);
            let hash = sha1_hex(&content);
            if ctx.store.get_artifact_hash(&key).as_deref() != Some(hash.as_str()) {
                ctx.gw.upload_plan(&family, &session_id, &plan_file_path, &content)?;
                ctx.store.set_artifact_hash(&key, &hash).map_err(NetError::Other)?;
                ctx.log(&format!("  [plan] {}…", short_id(&session_id)));
            }
        }
    }
    Ok(())
}

struct SessionInfo {
    family: String,
    path: String,
    root_dir: String,
    mtime_ms: f64,
}

/// `backfillArtifacts`: tasks (+ plans) for every tasks dir already on disk;
/// returns (task sets, plans, failed).
pub fn backfill_artifacts(ctx: &Ctx) -> (u64, u64, u64) {
    let settings = read_settings();
    let roots = resolve_data_roots(&settings);
    let tasks_dirs: Vec<String> = roots.claude.iter().map(|r| claude_tasks_dir(&r.config_dir)).collect();
    let session_ids = list_task_session_ids(&tasks_dirs);
    if session_ids.is_empty() {
        ctx.log("[hx] no tasks dirs to backfill under the watched roots");
        return (0, 0, 0);
    }
    // sessionId → the newest Claude log of that session.
    let claude = discover_claude_files(&roots.claude, Some(RECENT_WINDOW_MS), now_ms());
    let mut by_id: Vec<(String, SessionInfo)> = Vec::new();
    for f in &claude {
        let head = read_head(&f.path, f.source, true);
        let sid = head.session_id.clone().unwrap_or_else(|| basename(&f.path, ".jsonl"));
        let info = SessionInfo { family: head.family.clone(), path: f.path.clone(), root_dir: f.root_dir.clone(), mtime_ms: f.mtime_ms };
        match by_id.iter_mut().find(|(k, _)| *k == sid) {
            Some(slot) => {
                if f.mtime_ms > slot.1.mtime_ms {
                    slot.1 = info;
                }
            }
            None => by_id.push((sid, info)),
        }
    }
    let mut tasks_n = 0u64;
    let mut plans_n = 0u64;
    let mut failed = 0u64;
    for sid in &session_ids {
        let info = by_id.iter().find(|(k, _)| k == sid).map(|(_, i)| i);
        let family = info.map(|i| i.family.clone()).unwrap_or_else(|| "claude-cli".to_string());
        let tasks_result: Result<(), NetError> = (|| {
            let tasks = read_task_set(sid, &order_tasks_dirs_for(&roots, info.map(|i| i.root_dir.as_str())));
            if let Some(tasks) = tasks {
                if !tasks.is_empty() {
                    let count = tasks.len();
                    let hash = sha1_hex(&Json::Arr(tasks.clone()).stringify());
                    ctx.gw.upload_tasks(&family, sid, tasks)?;
                    ctx.store.set_artifact_hash(&format!("{}:{}:tasks", family, sid), &hash).map_err(NetError::Other)?;
                    tasks_n += 1;
                    ctx.log(&format!("  [tasks] {}… ({})", short_id(sid), count));
                }
            }
            Ok(())
        })();
        if let Err(e) = tasks_result {
            failed += 1;
            ctx.log(&format!("  [error] tasks {}: {}", short_id(sid), e.message()));
        }
        if let Some(info) = info {
            let plan_result: Result<(), NetError> = (|| {
                if let Some((plan_file_path, content)) = read_plan_for_jsonl(&info.path) {
                    ctx.gw.upload_plan(&family, sid, &plan_file_path, &content)?;
                    ctx.store.set_artifact_hash(&format!("{}:{}:plan", info.family, sid), &sha1_hex(&content)).map_err(NetError::Other)?;
                    plans_n += 1;
                    ctx.log(&format!("  [plan] {}…", short_id(sid)));
                }
                Ok(())
            })();
            if let Err(e) = plan_result {
                failed += 1;
                ctx.log(&format!("  [error] plan {}: {}", short_id(sid), e.message()));
            }
        }
    }
    ctx.log(&format!("[hx] backfill done: {} task sets, {} plans ({} failed)", tasks_n, plans_n, failed));
    (tasks_n, plans_n, failed)
}
