//! Freeze and memory watchdog for `hx watch`, on its own thread (src/watchdog.ts).
//!
//! The working threads add to a beat counter; this thread wakes every CHECK_MS,
//! and when the counter has not moved for `freeze_seconds`, or the process's
//! resident size is over `memory_ceiling_mb`, it records the reason in the run
//! marker, appends one line to stderr.log and ends the process with SIGKILL,
//! so the service manager starts a fresh daemon. The resident size is read
//! from /proc on Linux; on other platforms only the freeze check runs in this
//! build.
//!
//! What counts as a beat. hx beats from a one-second timer on its event loop,
//! and that loop keeps running while hx awaits a timer, a file read or a
//! fetch, so only code that never yields stops it. Here a thread blocks in
//! that same work instead, so the work beats for itself: the crash-loop
//! backoff once a second, the Claude Desktop index once per file, and a
//! network call holds a `NetworkWait` for as long as it blocks. Without that,
//! hx2 read every such wait of a minute as a freeze. On 2026-10-24 a Mac's
//! daemon was killed three times in ten minutes, each time after it asked the
//! gateway for a session's route and before it asked for the upload URL, the
//! stretch in which it refreshes the Claude Desktop index. From then on each
//! start served a backoff of one minute or more, the backoff itself tripped
//! the freeze limit, and that kill was the next abnormal exit. The daemon
//! uploaded nothing for days.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::fsutil::{append_file_0600, now_ms, write_file_0600};
use crate::json::Json;
use crate::settings::{tuning_value, HxSettings};

pub const FREEZE_SECONDS_DEFAULT: f64 = 60.0;
pub const FREEZE_SECONDS_MIN: f64 = 10.0;
pub const MEMORY_CEILING_MB_DEFAULT: f64 = 1536.0;
pub const MEMORY_CEILING_MB_MIN: f64 = 512.0;
const CHECK_MS: u64 = 250;
/// How long past its own deadline a network call still counts as waiting.
const NETWORK_WAIT_GRACE_MS: u64 = 15_000;

/// Beats from any thread, added to the `Watchdog`'s own counter.
static PROCESS_BEAT: AtomicU64 = AtomicU64::new(0);
/// Threads blocked in a network call right now.
static NETWORK_WAITS: AtomicUsize = AtomicUsize::new(0);
/// The latest moment (ms since the epoch) a blocked network call may still be
/// waiting: the last block it sent or received, plus its timeout, plus
/// NETWORK_WAIT_GRACE_MS. It only moves forward.
static NETWORK_WAIT_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

/// One beat from the calling thread, for work that runs long on purpose.
pub fn beat() {
    PROCESS_BEAT.fetch_add(1, Ordering::Relaxed);
}

/// Held for as long as a thread is blocked in a network call; see `network_wait`.
#[must_use = "the wait lasts as long as the guard is held"]
pub struct NetworkWait {
    timeout_ms: u64,
}

/// The calling thread is about to block in a network call in which no single
/// wait outlasts `timeout_ms` (its socket timeouts). Until the guard drops,
/// the watchdog reads the process as waiting, not frozen, as long as the call
/// has sent or received something within its timeout plus
/// NETWORK_WAIT_GRACE_MS. A long upload that keeps moving never trips the
/// freeze limit; a call stuck past its own deadline still does.
pub fn network_wait(timeout_ms: u64) -> NetworkWait {
    NETWORK_WAITS.fetch_add(1, Ordering::SeqCst);
    let wait = NetworkWait { timeout_ms };
    wait.progress();
    wait
}

impl NetworkWait {
    /// A block was sent or received: the wait starts over.
    pub fn progress(&self) {
        let until = now_ms() as u64 + self.timeout_ms + NETWORK_WAIT_GRACE_MS;
        NETWORK_WAIT_UNTIL_MS.fetch_max(until, Ordering::SeqCst);
        beat();
    }
}

impl Drop for NetworkWait {
    fn drop(&mut self) {
        NETWORK_WAITS.fetch_sub(1, Ordering::SeqCst);
        beat();
    }
}

fn network_waiting(now: u64) -> bool {
    NETWORK_WAITS.load(Ordering::SeqCst) > 0 && now < NETWORK_WAIT_UNTIL_MS.load(Ordering::SeqCst)
}

fn total_beats(own: &AtomicU64) -> u64 {
    own.load(Ordering::Relaxed).wrapping_add(PROCESS_BEAT.load(Ordering::Relaxed))
}

#[derive(Clone, Copy, Debug)]
pub struct WatchdogLimits {
    pub freeze_seconds: f64,
    pub memory_ceiling_mb: f64,
}

fn resolve_limit(raw: Option<&Json>, fallback: f64, floor: f64) -> f64 {
    match raw.and_then(|v| v.as_f64()) {
        Some(v) if v.is_finite() => {
            if v <= 0.0 {
                0.0
            } else {
                crate::js::math_round(v).max(floor)
            }
        }
        _ => fallback,
    }
}

pub fn resolve_watchdog_limits(settings: &HxSettings) -> WatchdogLimits {
    WatchdogLimits {
        freeze_seconds: resolve_limit(tuning_value(settings, "freezeSeconds"), FREEZE_SECONDS_DEFAULT, FREEZE_SECONDS_MIN),
        memory_ceiling_mb: resolve_limit(tuning_value(settings, "memoryCeilingMb"), MEMORY_CEILING_MB_DEFAULT, MEMORY_CEILING_MB_MIN),
    }
}

/// Resident set size in bytes, where this build can read it.
pub fn rss_bytes() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(statm) = fs::read_to_string("/proc/self/statm") {
            let mut it = statm.split_whitespace();
            let _size = it.next();
            if let Some(resident) = it.next().and_then(|v| v.parse::<u64>().ok()) {
                // SAFETY: sysconf has no preconditions.
                let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
                let page = if page > 0 { page as u64 } else { 4096 };
                return resident * page;
            }
        }
        0
    }
    #[cfg(not(target_os = "linux"))]
    {
        0
    }
}

pub struct Watchdog {
    beat: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    limits: Arc<Mutex<WatchdogLimits>>,
}

impl Watchdog {
    pub fn beat(&self) {
        self.beat.fetch_add(1, Ordering::Relaxed);
    }

    pub fn beat_handle(&self) -> Arc<AtomicU64> {
        self.beat.clone()
    }

    pub fn set_limits(&self, limits: WatchdogLimits) {
        *self.limits.lock().unwrap_or_else(|e| e.into_inner()) = limits;
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Start the watchdog thread. `marker` is this run's marker (crashloop.rs).
pub fn start_watchdog_thread(limits: WatchdogLimits, log_path: PathBuf, marker: Option<(PathBuf, Json)>) -> Watchdog {
    let beat = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let limits = Arc::new(Mutex::new(limits));
    let wd = Watchdog { beat: beat.clone(), stop: stop.clone(), limits: limits.clone() };
    let pid = std::process::id();
    std::thread::Builder::new()
        .name("hx-watchdog".to_string())
        .spawn(move || {
            let mut last_beat = total_beats(&beat);
            let mut stale_checks: u64 = 0;
            loop {
                std::thread::sleep(Duration::from_millis(CHECK_MS));
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                let b = total_beats(&beat);
                if b != last_beat || network_waiting(now_ms() as u64) {
                    last_beat = b;
                    stale_checks = 0;
                } else {
                    stale_checks += 1;
                }
                let l = *limits.lock().unwrap_or_else(|e| e.into_inner());
                let quiet_ms = stale_checks * CHECK_MS;
                let rss = rss_bytes();
                let rss_mb = crate::js::math_round(rss as f64 / 1048576.0);
                let quiet_seconds = (quiet_ms / 1000) as u64;
                let trip: Option<(String, String)> = if l.memory_ceiling_mb > 0.0 && rss > 0 && rss_mb > l.memory_ceiling_mb {
                    let what = format!("rss {} MB is over the memory limit of {} MB", crate::js::num_to_string(rss_mb), crate::js::num_to_string(l.memory_ceiling_mb));
                    let also = format!("the event loop last ran {} s ago", quiet_seconds);
                    Some((what, also))
                } else if l.freeze_seconds > 0.0 && (quiet_ms as f64) >= l.freeze_seconds * 1000.0 {
                    let what = format!("the event loop has not run for {} s (freeze limit {} s)", quiet_seconds, crate::js::num_to_string(l.freeze_seconds));
                    let also = format!("rss {} MB", crate::js::num_to_string(rss_mb));
                    Some((what, also))
                } else {
                    None
                };
                let (what, also) = match trip {
                    Some(t) => t,
                    None => continue,
                };
                let line = format!("{} [hx] watchdog: killing pid {} with SIGKILL: {}; {}", stamp(), pid, what, also);
                let reason = format!("killed by the watchdog: {}", what);
                if let Some((path, content)) = &marker {
                    let mut m = content.clone();
                    m.set("endedBy", Json::str(&reason));
                    m.set("endedAtMs", Json::num(now_ms()));
                    let tmp = PathBuf::from(format!("{}.{}.watchdog.tmp", path.to_string_lossy(), pid));
                    if write_file_0600(&tmp, m.stringify().as_bytes()).is_ok() {
                        let _ = fs::rename(&tmp, path);
                    }
                }
                let _ = append_file_0600(&log_path, format!("{}\n", line).as_bytes());
                crate::platform::kill_self_hard(pid);
                std::process::abort();
            }
        })
        .ok();
    wd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_network_wait_counts_as_waiting_until_its_timeout_and_grace_pass() {
        let wait = network_wait(1_000);
        let now = now_ms() as u64;
        assert!(network_waiting(now));
        // Long past the deadline and the grace, the same wait reads as a freeze.
        assert!(!network_waiting(now + 1_000 + NETWORK_WAIT_GRACE_MS + 3_600_000));
        drop(wait);
    }

    #[test]
    fn a_beat_from_any_thread_moves_the_count_the_watchdog_reads() {
        let own = AtomicU64::new(0);
        let before = total_beats(&own);
        std::thread::spawn(beat).join().unwrap();
        assert_ne!(total_beats(&own), before);
    }
}
