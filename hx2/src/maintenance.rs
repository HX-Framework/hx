//! Daemon-maintenance actions shared by the CLI and the `hx ui` server
//! (src/maintenance.ts). Each keeps the state.json single-writer contract: an
//! installed daemon is stopped before its state is changed and brought back
//! right after.

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use crate::config::HxConfig;
use crate::daemon_state::get_daemon_ops;
use crate::json::{obj, Json};
use crate::logger::Logger;
use crate::service::{exec_path, Consent};
use crate::state::Store;
use crate::watch::{tick_once, Ctx, WatchOptions};

/// `daemonAction`: start (install), stop or restart, then the state the UI shows.
pub fn daemon_action(action: &str, consent: Consent) -> Result<Json, String> {
    let ops = get_daemon_ops();
    match action {
        "stop" => {
            ops.stop()?;
        }
        "restart" => ops.restart(&exec_path(), consent)?,
        _ => ops.install(&exec_path(), consent)?,
    }
    let ds = ops.state();
    Ok(obj(vec![
        ("managerName", Json::str(ops.manager_name)),
        ("loaded", Json::Bool(ds.loaded)),
        ("pid", ds.pid.map(|p| Json::num(p as f64)).unwrap_or(Json::Null)),
    ]))
}

pub struct RetryResult {
    pub sessions: usize,
    pub files: usize,
    pub restarted: bool,
    /// The foreground pass when the daemon was not loaded: (uploaded, failed).
    pub pass: Option<(u64, u64)>,
}

impl RetryResult {
    /// `{ ...cleared, restarted, pass? }` as the UI receives it.
    pub fn to_json(&self) -> Json {
        let mut o = obj(vec![("files", Json::num(self.files as f64)), ("sessions", Json::num(self.sessions as f64)), ("restarted", Json::Bool(self.restarted))]);
        if let Some((uploaded, failed)) = self.pass {
            o.set("pass", obj(vec![("uploaded", Json::num(uploaded as f64)), ("failed", Json::num(failed as f64))]));
        }
        o
    }
}

/// `retryBlocked`: stop a loaded daemon, release the holds (`all` also clears
/// every failure backoff), then bring the same service back; a stopped client
/// gets one foreground pass instead.
pub fn retry_blocked(cfg: HxConfig, consent: Consent, all: bool, log: Logger, name: &str) -> Result<RetryResult, String> {
    let ops = get_daemon_ops();
    let before = ops.state();
    if before.loaded {
        ops.stop()?;
    }
    let fresh = Store::load("main");
    let (files, sessions) = if all { fresh.clear_all_failures()? } else { fresh.clear_blocked_failures()? };
    if before.loaded {
        fresh.drain();
        ops.install(&exec_path(), consent)?;
        return Ok(RetryResult { sessions, files, restarted: true, pass: None });
    }
    let ctx = Ctx::new(cfg, fresh, log, name, Arc::new(AtomicU64::new(0)));
    let pass = tick_once(&ctx, &WatchOptions { only: None, one_shot: true, chunk_limit_bytes: None, chunk_growth: false }, &|_| {});
    ctx.store.drain();
    let pass = pass?;
    Ok(RetryResult { sessions, files, restarted: false, pass: Some((pass.uploaded, pass.failed)) })
}
