//! The long-running daemon's process plumbing: the run marker, the watchdog
//! thread, SIGTERM/SIGINT (fold the journal, then end the way the default
//! handler would), and the exit paths that record why the run ended.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(unix)]
use signal_hook::consts::signal::{SIGINT, SIGTERM};
#[cfg(unix)]
use signal_hook::iterator::Signals;

#[cfg(unix)]
use crate::ccd::save_ccd_index_if_changed;
use crate::crashloop::WatchRun;
#[cfg(unix)]
use crate::fsutil::now_ms;
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

/// Install the signal thread for the daemon. On SIGTERM every lane's journal
/// is folded into its snapshot, the Claude Desktop index is saved, and the
/// signal is re-raised with the default handler, so the process ends by
/// SIGTERM exactly as the TypeScript daemon does; on SIGINT the loop logs,
/// folds and exits 0 (cmdWatch's handler). Returns the hooks of the main lane
/// and of the `--local` lane when one runs.
#[cfg(unix)]
pub fn install_signal_thread(ctx: Arc<Ctx>, local: Option<Arc<Ctx>>, run: Arc<WatchRun>) -> (DaemonHooks, Option<DaemonHooks>) {
    let stop_requested = Arc::new(AtomicBool::new(false));
    let hooks = DaemonHooks { stop_requested: stop_requested.clone() };
    let local_hooks = local.as_ref().map(|_| DaemonHooks { stop_requested: stop_requested.clone() });
    let mut signals = match Signals::new([SIGTERM, SIGINT]) {
        Ok(s) => s,
        Err(_) => return (hooks, local_hooks),
    };
    std::thread::Builder::new()
        .name("hx-signals".to_string())
        .spawn(move || {
            for sig in signals.forever() {
                run.mark_clean_stop();
                stop_requested.store(true, Ordering::SeqCst);
                if sig == SIGINT {
                    ctx.log.log("\n[hx] stopping…");
                }
                // The parting flush of every armed lane (state.ts installSignalFlush
                // and registerPartingFlush): checkpoint, then the Claude Desktop index.
                let _ = ctx.store.checkpoint_state();
                if let Some(l) = &local {
                    let _ = l.store.checkpoint_state();
                }
                save_ccd_index_if_changed(now_ms(), true);
                if sig == SIGINT {
                    std::process::exit(0);
                }
                // SIGTERM: let the default action end the process.
                let _ = signal_hook::low_level::emulate_default_handler(sig);
                std::process::exit(143);
            }
        })
        .ok();
    (hooks, local_hooks)
}

/// Windows: Bun turns Ctrl+C in the console into SIGINT and never delivers
/// SIGTERM, and state.ts installs no signal flush there (installSignalFlush
/// returns on win32). Ctrl+C runs hookWatchRunToProcess's clean-stop mark and
/// cmdWatch's handler: log, stop both lanes, checkpoint both scopes, exit 0.
/// The Claude Desktop index is not saved on the way out, because the client's
/// parting flush never runs on Windows. The windowless service build has no
/// console, so nothing reaches it.
#[cfg(windows)]
pub fn install_signal_thread(ctx: Arc<Ctx>, local: Option<Arc<Ctx>>, run: Arc<WatchRun>) -> (DaemonHooks, Option<DaemonHooks>) {
    let stop_requested = Arc::new(AtomicBool::new(false));
    let hooks = DaemonHooks { stop_requested: stop_requested.clone() };
    let local_hooks = local.as_ref().map(|_| DaemonHooks { stop_requested: stop_requested.clone() });
    let _ = crate::platform::on_ctrl_c(Box::new(move || {
        run.mark_clean_stop();
        stop_requested.store(true, Ordering::SeqCst);
        ctx.log.log("\n[hx] stopping…");
        let _ = ctx.store.checkpoint_state();
        if let Some(l) = &local {
            let _ = l.store.checkpoint_state();
        }
        std::process::exit(0);
    }));
    (hooks, local_hooks)
}
