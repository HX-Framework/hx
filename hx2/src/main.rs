//! hx2 — the hx client's daemon in Rust (HX2 program, M3 + M4).
//!
//! The binary prints its own file name (`hx2`, or `hx` once renamed) wherever
//! the TypeScript client prints `hx`. This build carries the daemon and its
//! maintenance commands: `watch` (long-running and `--once`, with the `--local`
//! tee), `tick`, `status` (`--detailed`), `doctor sync`, `backfill`,
//! `reattribute`, `retry`. The service, pairing, update and ui commands are the
//! next card's work.

mod activity;
mod artifacts;
mod catalog;
mod ccd;
mod ccd_leveldb;
mod ccd_prefs;
mod children;
mod codex_titles;
mod commands;
mod config;
mod crashloop;
mod daemon;
mod daemon_state;
mod diagnostics;
mod fsevents;
mod fsutil;
mod home;
mod js;
mod json;
mod ledger;
mod logger;
mod mirror;
mod net;
mod orgnames;
mod parse;
mod pathnorm;
mod probe;
mod reattribute;
mod report;
mod roots;
mod route;
mod settings;
mod sidecars;
mod sources;
mod state;
mod title_sync;
mod watch;
mod watchdog;

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, OnceLock};

use crate::commands::{flag, has_flag};
use crate::logger::{say, Logger};

pub const HX_VERSION: &str = env!("CARGO_PKG_VERSION");

static BIN_NAME: OnceLock<String> = OnceLock::new();

/// The name this binary goes by, for every message that names the command.
pub fn bin_name() -> &'static str {
    BIN_NAME.get().map(|s| s.as_str()).unwrap_or("hx2")
}

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

/// `hx watch [--once] [--only <path>] [--local]`.
fn cmd_watch(name: &str, args: &[String]) {
    let cfg = commands::ensure_config(name);
    let local_cfg = if has_flag(args, "local") { Some(commands::ensure_local_config(name)) } else { None };
    let one_shot = args.iter().any(|a| a == "--once" || a == "-1");
    let only = flag(args, "only");
    let opts = watch::WatchOptions { only, one_shot, chunk_limit_bytes: None, chunk_growth: false };
    let beat = Arc::new(AtomicU64::new(0));
    let store = state::Store::load("main");
    let ctx = Arc::new(watch::Ctx::new(cfg, store, Logger::new(true, ""), name, beat.clone()));
    let local_ctx = local_cfg.map(|lc| {
        let store = state::Store::load("local");
        Arc::new(watch::Ctx::new(lc, store, Logger::new(true, "[local] "), name, beat.clone()))
    });
    if one_shot {
        // Both lanes run concurrently, as cli.ts's Promise.all starts them.
        let local_thread = local_ctx.map(|lctx| {
            let o = opts.clone();
            std::thread::Builder::new().name("hx-local-lane".to_string()).spawn(move || watch::start_watch(lctx, o, None)).ok()
        });
        watch::start_watch(ctx, opts, None);
        if let Some(Some(t)) = local_thread {
            let _ = t.join();
        }
        return;
    }
    // The long-running loop: the run marker and the crash-loop backoff, the
    // signal thread, the freeze and memory watchdog on its own thread.
    let run = Arc::new(crashloop::begin_watch_run());
    daemon::set_run(run.clone());
    let (hooks, local_hooks) = daemon::install_signal_thread(ctx.clone(), local_ctx.clone(), run.clone());
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
    let wd_limits = Arc::new(wd);
    let reload = wd_limits.clone();
    std::thread::Builder::new()
        .name("hx-watchdog-reload".to_string())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            reload.set_limits(watchdog::resolve_watchdog_limits(&settings::read_settings()));
        })
        .ok();
    let local_thread = local_ctx.map(|lctx| {
        let o = opts.clone();
        let h = local_hooks;
        std::thread::Builder::new().name("hx-local-lane".to_string()).spawn(move || watch::start_watch(lctx, o, h)).ok()
    });
    watch::start_watch(ctx, opts, Some(hooks));
    if let Some(Some(t)) = local_thread {
        let _ = t.join();
    }
}

fn exit_with_code(code: i32) {
    if code != 0 {
        std::process::exit(code);
    }
}

fn main() {
    // glibc opens a malloc arena per thread that allocates; the upload pool's
    // workers come and go every pass, and every arena holds on to memory it
    // freed. Two arenas are plenty for this daemon.
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        const M_ARENA_MAX: libc::c_int = -8;
        libc::mallopt(M_ARENA_MAX, 2);
    }
    home::ensure_hx_home();
    let name = binary_name();
    let _ = BIN_NAME.set(name.clone());
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str());
    // cli.ts: `main().catch((err) => { log(`error: ${err.message}`); process.exit(1); })`.
    let result: Result<i32, String> = match cmd {
        Some("--version") | Some("-v") | Some("version") => {
            say(&format!("{} version: {}", name, HX_VERSION));
            Ok(0)
        }
        Some("watch") => {
            cmd_watch(&name, &args);
            Ok(0)
        }
        Some("tick") => commands::cmd_tick(&name, &args).map(|_| 0),
        Some("backfill") => {
            commands::cmd_backfill(&name);
            Ok(0)
        }
        Some("reattribute") => commands::cmd_reattribute(&name, args.iter().any(|a| a == "--force")).map(|_| 0),
        Some("status") => commands::cmd_status(&name, &args),
        Some("doctor") => commands::cmd_doctor(&name, &args),
        Some("retry") => commands::cmd_retry(&name, &args),
        None | Some("--help") | Some("-h") | Some("help") => {
            help(&name);
            Ok(0)
        }
        Some(other) => {
            let known = ["connect", "login", "disconnect", "logout", "start", "stop", "restart", "logs", "ui", "update", "uninstall"];
            if known.contains(&other) {
                say(&format!("{}: `{}` is not available in this build.", name, other));
                std::process::exit(64);
            }
            say(&format!("unknown command: {}", other));
            say(&format!("run `{} help` for the full list.", name));
            std::process::exit(64);
        }
    };
    match result {
        Ok(code) => exit_with_code(code),
        Err(msg) => {
            say(&format!("error: {}", msg));
            std::process::exit(1);
        }
    }
}
