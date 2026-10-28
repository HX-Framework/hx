//! The Codex title backfill sweep (src/title-sync.ts): once per file per
//! TITLE_SYNC_VERSION, on daemon start, Codex's own name for every uploaded
//! rollout is pushed through POST /sessions/retitle, to the destinations the
//! bytes actually went to.

use crate::codex_titles::read_codex_title;
use crate::config::HxConfig;
use crate::fsutil::now_ms;
use crate::js::{num_to_string, slice};
use crate::json::{obj, Json};
use crate::net::{Gateway, NetError};
use crate::roots::resolve_data_roots;
use crate::settings::read_settings;
use crate::sources::discover_codex_files;
use crate::state::Store;

/// 2 (78.0.6): before it, the reader could not open Codex's database while
/// Codex had it closed (no -wal file), so a sweep at such a start found no
/// titles and stamped every file as having none.
pub const TITLE_SYNC_VERSION: f64 = 2.0;
const BATCH_SIZE: usize = 100;
const TITLE_MAX_LEN: usize = 1024;

/// The destinations this file's bytes were uploaded to: offset keys with a
/// non-zero offset, `letai` as the null destination.
fn codex_destinations(fstate: &Json) -> Vec<Json> {
    let mut out: Vec<Json> = Vec::new();
    if let Some(o) = fstate.get("offsets").and_then(|o| o.as_obj()) {
        for (k, v) in o.iter() {
            if v.as_f64().unwrap_or(0.0) > 0.0 {
                out.push(if k == "letai" { Json::Null } else { Json::str(k) });
            }
        }
    }
    out
}

struct Pending {
    item: Json,
    entry: Json,
}

/// `runTitleSyncSweep`; `_cfg` is unused today, kept for the call's shape.
pub fn run_title_sync_sweep(_cfg: &HxConfig, store: &Store, gw: &Gateway, log: &dyn Fn(&str), force: bool) -> Result<(), NetError> {
    let mut scanned = 0usize;
    let mut sent = 0usize;
    let mut queued = 0usize;
    let mut no_title = 0usize;
    let mut skipped = 0usize;
    let roots = resolve_data_roots(&read_settings());
    let files = discover_codex_files(&roots.codex, true, None, now_ms());
    let mut pending: Vec<Pending> = Vec::new();

    let flush = |pending: &mut Vec<Pending>, sent: &mut usize, queued: &mut usize| -> Result<(), NetError> {
        if pending.is_empty() {
            return Ok(());
        }
        let batch: Vec<Pending> = pending.drain(..).collect();
        let results = gw.retitle_sessions(batch.iter().map(|p| p.item.clone()).collect())?;
        for p in batch {
            let fam = p.item.get_string("family").unwrap_or_default();
            let sid = p.item.get_string("sessionId").unwrap_or_default();
            let status = results
                .iter()
                .find(|r| r.get_string("family").as_deref() == Some(fam.as_str()) && r.get_string("sessionId").as_deref() == Some(sid.as_str()))
                .and_then(|r| r.get_string("status"));
            if status.as_deref() == Some("queued") {
                *queued += 1;
            }
            *sent += 1;
            let mut entry = p.entry;
            entry.set("titleSyncVersion", Json::num(TITLE_SYNC_VERSION));
            store.upsert_file_state(entry).map_err(NetError::Other)?;
        }
        Ok(())
    };

    for file in &files {
        let mut f = match store.file(&file.path) {
            Some(f) => f,
            None => continue,
        };
        let destinations = codex_destinations(&f);
        if destinations.is_empty() {
            continue;
        }
        if !force && f.get_f64("titleSyncVersion").unwrap_or(0.0) >= TITLE_SYNC_VERSION {
            skipped += 1;
            continue;
        }
        scanned += 1;
        let session_id = f.get_string("sessionId").unwrap_or_default();
        let title = match read_codex_title(&file.root_dir, &session_id) {
            Some(t) => t,
            None => {
                f.set("titleSyncVersion", Json::num(TITLE_SYNC_VERSION));
                store.upsert_file_state(f).map_err(NetError::Other)?;
                no_title += 1;
                continue;
            }
        };
        let item = obj(vec![
            ("family", Json::str(&f.get_string("family").unwrap_or_default())),
            ("sessionId", Json::str(&session_id)),
            ("title", Json::Str(slice(&title.title, 0, TITLE_MAX_LEN).to_vec())),
            ("titleSource", Json::str(title.source)),
            ("destinations", Json::Arr(destinations)),
        ]);
        pending.push(Pending { item, entry: f });
        if pending.len() >= BATCH_SIZE {
            flush(&mut pending, &mut sent, &mut queued)?;
        }
    }
    flush(&mut pending, &mut sent, &mut queued)?;

    if sent > 0 || scanned > 0 {
        log(&format!(
            "[retitle] v{}: {} reported ({} queued), {} no-name, {} already current",
            num_to_string(TITLE_SYNC_VERSION),
            sent,
            queued,
            no_title,
            skipped
        ));
    }
    Ok(())
}
