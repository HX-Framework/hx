//! The versioned attribution sweep the daemon runs on every start (src/reattribute.ts).

use crate::config::HxConfig;
use crate::fsutil::now_ms;
use crate::json::{obj, Json};
use crate::net::{Gateway, NetError};
use crate::roots::resolve_data_roots;
use crate::settings::read_settings;
use crate::sources::{discover_claude_files, discover_codex_files, read_head};
use crate::state::Store;

pub const DETECTION_VERSION: f64 = 2.0;
const BATCH_SIZE: usize = 100;

#[derive(Clone, Copy, Debug, Default)]
pub struct SweepSummary {
    pub scanned: usize,
    pub sent: usize,
    pub attributed: usize,
    pub unresolved: usize,
    pub skipped: usize,
}

struct Pending {
    item: Json,
    entry: Json,
}

/// `runReattributeSweep`: report the repo slug or the cwd of every uploaded
/// session the current detection version has not covered yet.
pub fn run_reattribute_sweep(cfg: &HxConfig, store: &Store, gw: &Gateway, log: &dyn Fn(&str), force: bool) -> Result<SweepSummary, NetError> {
    let mut summary = SweepSummary::default();
    let roots = resolve_data_roots(&read_settings());
    let now = now_ms();
    let mut files = discover_claude_files(&roots.claude, None, now);
    files.extend(discover_codex_files(&roots.codex, true, None, now));
    let mut pending: Vec<Pending> = Vec::new();

    let flush = |pending: &mut Vec<Pending>, summary: &mut SweepSummary| -> Result<(), NetError> {
        if pending.is_empty() {
            return Ok(());
        }
        let batch: Vec<Pending> = pending.drain(..).collect();
        let results = gw.reattribute_sessions(batch.iter().map(|p| p.item.clone()).collect())?;
        for p in batch {
            let fam = p.item.get_string("family").unwrap_or_default();
            let sid = p.item.get_string("sessionId").unwrap_or_default();
            let status = results
                .iter()
                .find(|r| r.get_string("family").as_deref() == Some(fam.as_str()) && r.get_string("sessionId").as_deref() == Some(sid.as_str()))
                .and_then(|r| r.get_string("status"));
            if status.as_deref() == Some("attributed") {
                summary.attributed += 1;
            } else {
                summary.unresolved += 1;
            }
            summary.sent += 1;
            let mut entry = p.entry;
            entry.set("attributionVersion", Json::num(DETECTION_VERSION));
            store.upsert_file_state(entry).map_err(NetError::Other)?;
        }
        Ok(())
    };

    for file in &files {
        let mut f = match store.file(&file.path) {
            Some(f) => f,
            None => continue,
        };
        let has_offsets = f.get("offsets").and_then(|o| o.as_obj()).map(|o| !o.is_empty()).unwrap_or(false);
        if !has_offsets {
            continue;
        }
        if !force && f.get_f64("attributionVersion").unwrap_or(0.0) >= DETECTION_VERSION {
            summary.skipped += 1;
            continue;
        }
        summary.scanned += 1;
        let head = read_head(&file.path, file.source, true);
        // FIRST-SIGHT slug wins; the fresh walk only fills gaps (`??`).
        let cached_slug: Option<String> = f.get("repoSlug").filter(|v| !v.is_null()).and_then(|v| v.as_string());
        let repo_slug: Option<String> = cached_slug.clone().or_else(|| head.repo_slug.clone());
        // RAW cwd wins for evidence (`??`).
        let cwd: Option<String> = head.cwd_string().or_else(|| f.get("cwd").filter(|v| !v.is_null()).and_then(|v| v.as_string()));
        let cached_is_nullish = f.get("repoSlug").map(|v| v.is_null()).unwrap_or(true);
        if cached_is_nullish {
            if let Some(s) = &repo_slug {
                f.set("repoSlug", Json::str(s));
            }
        }
        let withhold_cwd = cfg.evidence_upload == Some(false);
        let send_cwd = !withhold_cwd && cwd.as_deref().map(|c| !c.is_empty()).unwrap_or(false);
        if repo_slug.is_none() && !send_cwd && !withhold_cwd {
            f.set("attributionVersion", Json::num(DETECTION_VERSION));
            store.upsert_file_state(f).map_err(NetError::Other)?;
            summary.unresolved += 1;
            continue;
        }
        let mut item = obj(vec![
            ("family", Json::str(&f.get_string("family").unwrap_or_default())),
            ("sessionId", Json::str(&f.get_string("sessionId").unwrap_or_default())),
        ]);
        if let Some(s) = &repo_slug {
            item.set("repoSlug", Json::str(s));
        }
        if send_cwd {
            item.set("cwd", Json::str(cwd.as_deref().unwrap_or("")));
        }
        if withhold_cwd {
            item.set("withholdCwd", Json::Bool(true));
        }
        pending.push(Pending { item, entry: f });
        if pending.len() >= BATCH_SIZE {
            flush(&mut pending, &mut summary)?;
        }
    }
    flush(&mut pending, &mut summary)?;

    if summary.sent > 0 || summary.scanned > 0 {
        log(&format!(
            "[reattribute] v{}: {} reported ({} attributed), {} unresolved, {} already current",
            crate::js::num_to_string(DETECTION_VERSION),
            summary.sent,
            summary.attributed,
            summary.unresolved,
            summary.skipped
        ));
    }
    Ok(summary)
}
