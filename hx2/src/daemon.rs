//! The long-running daemon's process plumbing: the run marker, the watchdog
//! thread, SIGTERM/SIGINT (fold the journal, then end the way the default
//! handler would), and the exit paths that record why the run ended.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use signal_hook::consts::signal::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

use crate::crashloop::WatchRun;
use crate::watch::{Ctx, DaemonHooks};

static RUN: OnceLock<Mutex<Option<Arc<WatchRun>>>> = OnceLock::new();

fn run_slot() -> &'static Mutex<Option<Arc<WatchRun>>> {
    RUN.get_or_init(|| Mutex::new(None))
}

pub fn set_run(run: Arc<WatchRun>) {
    *run_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(run);
}

/// End the process with `code`, recording it in the run marker first.
pub fn exit_with(code: i32) -> ! {
    if let Some(run) = run_slot().lock().unwrap_or_else(|e| e.into_inner()).clone() {
        run.mark_exit(code);
    }
    std::process::exit(code)
}

/// Install the signal thread for the daemon. On SIGTERM the journal is folded
/// into the snapshot and the signal is re-raised with the default handler, so
/// the process ends by SIGTERM exactly as the TypeScript daemon does; on SIGINT
/// the loop logs, folds and exits 0 (cmdWatch's handler).
pub fn install_signal_thread(ctx: Arc<Ctx>, run: Arc<WatchRun>) -> DaemonHooks {
    let stop_requested = Arc::new(AtomicBool::new(false));
    let hooks = DaemonHooks { stop_requested: stop_requested.clone() };
    let mut signals = match Signals::new([SIGTERM, SIGINT]) {
        Ok(s) => s,
        Err(_) => return hooks,
    };
    std::thread::Builder::new()
        .name("hx-signals".to_string())
        .spawn(move || {
            for sig in signals.forever() {
                run.mark_clean_stop();
                stop_requested.store(true, Ordering::SeqCst);
                if sig == SIGINT {
                    ctx.log.log("\n[hx] stopping…");
                    let _ = ctx.store.checkpoint_state();
                    std::process::exit(0);
                }
                // SIGTERM: fold, then let the default action end the process.
                let _ = ctx.store.checkpoint_state();
                let _ = signal_hook::low_level::emulate_default_handler(sig);
                std::process::exit(143);
            }
        })
        .ok();
    hooks
}
