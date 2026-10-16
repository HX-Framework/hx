//! hx2 — the hx client's hot path in Rust (HX2 program, M3).
//!
//! The binary prints its own file name (`hx2`, or `hx` once renamed) wherever
//! the TypeScript client prints `hx`. This build carries `watch` (the daemon
//! and its one-shot pass) for Claude Code transcripts; the other commands and
//! the other sources ride the later cards of the program.

mod activity;
mod catalog;
mod config;
mod crashloop;
mod daemon;
mod fsevents;
mod fsutil;
mod home;
mod js;
mod json;
mod logger;
mod mirror;
mod net;
mod orgnames;
mod parse;
mod pathnorm;
mod reattribute;
mod roots;
mod route;
mod settings;
mod sources;
mod state;
mod watch;
mod watchdog;

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use crate::logger::{say, Logger};

pub const HX_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The name this binary goes by: its own file name when it starts with `hx`, else `hx2`.
fn binary_name() -> String {
    let from_exe = std::env::current_exe().ok().and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()));
    let from_argv = std::env::args().next().and_then(|a| std::path::Path::new(&a).file_stem().map(|s| s.to_string_lossy().into_owned()));
    for cand in [from_exe, from_argv].into_iter().flatten() {
        if cand == "hx" || cand == "hx2" {
            return cand;
        }
    }
    "hx2".to_string()
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let long = format!("--{}", name);
    if let Some(i) = args.iter().position(|a| *a == long) {
        if let Some(v) = args.get(i + 1) {
            if !v.is_empty() {
                return Some(v.clone());
            }
        }
    }
    let prefix = format!("--{}=", name);
    args.iter().find_map(|a| a.strip_prefix(&prefix).map(|v| v.to_string()))
}

fn help(name: &str) {
    say(&format!("{} — laptop daemon for hx-vision", name));
    say("");
    say("Setup:");
    say("  connect    Approve this device + start the background mirror");
    say("  start      Install + run as a background service (run by connect)");
    say("  stop       Pause the background service");
    say("  restart    Reload + restart the background service");
    say("  status     Show connection status, link quality and sync health");
    say("             --detailed  Full ledger + why anything is waiting (--json too)");
    say("  logs       Tail the daemon's stdout / stderr");
    say("  ui         Open the local HX Client UI (http://localhost:8000; --port, --no-open)");
    say("");
    say("Maintenance:");
    say("  backfill   Upload tasks + plans for sessions already on disk");
    say("  reattribute  Re-detect + report repo attribution for uploaded sessions");
    say("  retry --blocked  Release Fortress-held sessions and retry immediately");
    say("  retry --all      Also clear every retry backoff (after a fixed incident)");
    say(&format!("  update     Fetch the latest {} binary and restart the daemon", name));
    say("  disconnect Forget the device token");
    say("  uninstall  Remove daemon + binary (pass --purge to also remove ~/.let/hx/)");
    say("");
    say("Foreground (debug):");
    say("  watch      Run the mirror in this terminal (Ctrl+C to stop)");
    say("  tick       Run a single upload pass and exit");
    say("");
    say("  --local    connect/watch/tick: ALSO mirror sessions to the local dev");
    say("             gateway (http://localhost:9000); update: fetch from it");
    say(&format!("  --version  Print {} version", name));
}

fn cmd_watch(name: &str, args: &[String]) {
    let cfg = match config::read_config() {
        Some(c) if c.access_token.is_some() => c,
        _ => {
            say(&format!("Not connected. Run `{} connect` first.", name));
            std::process::exit(2);
        }
    };
    if args.iter().any(|a| a == "--local") {
        say(&format!("Local tee is not connected. Run `{} connect --local` first.", name));
        std::process::exit(2);
    }
    let one_shot = args.iter().any(|a| a == "--once" || a == "-1");
    let only = flag(args, "only");
    let opts = watch::WatchOptions { only, one_shot, chunk_limit_bytes: None, chunk_growth: false };
    let log = Logger::new(true, "");
    let beat = Arc::new(AtomicU64::new(0));
    let store = state::Store::load("main");
    let ctx = Arc::new(watch::Ctx::new(cfg, store, log, name, beat.clone()));
    if one_shot {
        watch::start_watch(ctx, opts, None);
        return;
    }
    // The long-running loop: the run marker and the crash-loop backoff, the
    // signal thread, the freeze and memory watchdog on its own thread.
    let run = Arc::new(crashloop::begin_watch_run());
    daemon::set_run(run.clone());
    let hooks = daemon::install_signal_thread(ctx.clone(), run.clone());
    let settings = settings::read_settings();
    let wd = watchdog::start_watchdog_thread(
        watchdog::resolve_watchdog_limits(&settings),
        home::hx_dir().join("stderr.log"),
        Some((run.marker_path.clone(), run.marker.clone())),
    );
    let beat_handle = wd.beat_handle();
    {
        // Every working thread beats through the context; the watchdog reads this counter.
        let ctx_beat = ctx.beat.clone();
        std::thread::Builder::new()
            .name("hx-beat".to_string())
            .spawn(move || {
                let mut last = 0u64;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    let b = ctx_beat.load(std::sync::atomic::Ordering::Relaxed);
                    if b != last {
                        last = b;
                        beat_handle.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            })
            .ok();
    }
    if let Some(line) = run.describe() {
        ctx.log(&line);
    }
    if run.delay_ms > 0.0 {
        std::thread::sleep(std::time::Duration::from_millis(run.delay_ms as u64));
    }
    // Reload the watchdog limits from settings every 30 s while the loop runs.
    {
        let wd_limits = Arc::new(wd);
        let reload = wd_limits.clone();
        std::thread::Builder::new()
            .name("hx-watchdog-reload".to_string())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(30));
                reload.set_limits(watchdog::resolve_watchdog_limits(&settings::read_settings()));
            })
            .ok();
        watch::start_watch(ctx, opts, Some(hooks));
    }
}

fn main() {
    home::ensure_hx_home();
    let name = binary_name();
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str());
    match cmd {
        Some("--version") | Some("-v") | Some("version") => say(&format!("{} version: {}", name, HX_VERSION)),
        Some("watch") => cmd_watch(&name, &args),
        None | Some("--help") | Some("-h") | Some("help") => help(&name),
        Some(other) => {
            let known = [
                "connect", "login", "tick", "backfill", "reattribute", "status", "doctor", "retry", "disconnect", "logout", "start", "stop", "restart", "logs", "ui", "update", "uninstall",
            ];
            if known.contains(&other) {
                say(&format!("{}: `{}` is not available in this build.", name, other));
                std::process::exit(64);
            }
            say(&format!("unknown command: {}", other));
            say(&format!("run `{} help` for the full list.", name));
            std::process::exit(64);
        }
    }
}
