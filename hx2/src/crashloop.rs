//! Crash-loop backoff for the long-running daemon (src/crash-loop.ts): a run
//! marker, a record of abnormal exits, and the wait before the first pass.

use std::fs;
use std::path::{Path, PathBuf};

use crate::fsutil::{now_ms, write_file_0600};
use crate::home::hx_dir;
use crate::json::{obj, Json};

pub const CRASH_LOOP_EXITS: usize = 3;
pub const CRASH_LOOP_WINDOW_MS: f64 = 30.0 * 60_000.0;
pub const CRASH_LOOP_FIRST_DELAY_MS: f64 = 60_000.0;
pub const CRASH_LOOP_MAX_DELAY_MS: f64 = 30.0 * 60_000.0;
const KEEP_EXITS_MS: f64 = 24.0 * 60.0 * 60_000.0;
const KEEP_EXITS_MAX: usize = 50;

pub const RUN_MARKER_FILE: &str = "watch-run.json";
pub const EXITS_FILE: &str = "watch-exits.json";

#[derive(Clone, Debug)]
pub struct AbnormalExit {
    pub pid: i64,
    pub at_ms: f64,
    pub eff_at_ms: f64,
    pub reason: String,
}

pub struct WatchRun {
    pub delay_ms: f64,
    pub recent_exits: usize,
    pub previous: Option<AbnormalExit>,
    pub marker_path: PathBuf,
    pub marker: Json,
    pid: i64,
    stopped: std::sync::atomic::AtomicBool,
}

fn pid_alive(pid: i64) -> bool {
    // SAFETY: kill with signal 0 only probes the process.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if r == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn read_marker(path: &Path) -> Option<Json> {
    let raw = fs::read_to_string(path).ok()?;
    let m = Json::parse(&raw).ok()?;
    let pid = m.get_f64("pid")?;
    if pid.fract() != 0.0 || pid <= 0.0 {
        return None;
    }
    m.get_f64("startedAtMs")?;
    Some(m)
}

fn write_json(path: &Path, value: &Json) {
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.to_string_lossy(), std::process::id()));
    if write_file_0600(&tmp, value.stringify().as_bytes()).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

/// Pure: the wait before the first pass, given the exits and the effective now.
pub fn crash_loop_delay_ms(exits: &[AbnormalExit], eff_now_ms: f64) -> (f64, usize) {
    let recent = exits.iter().filter(|e| e.eff_at_ms > eff_now_ms - CRASH_LOOP_WINDOW_MS).count();
    if recent < CRASH_LOOP_EXITS {
        return (0.0, recent);
    }
    let delay = (CRASH_LOOP_FIRST_DELAY_MS * 2f64.powi((recent - CRASH_LOOP_EXITS) as i32)).min(CRASH_LOOP_MAX_DELAY_MS);
    (delay, recent)
}

/// Start-of-run bookkeeping: count the previous run if it ended abnormally,
/// decide the backoff, write this run's marker.
pub fn begin_watch_run() -> WatchRun {
    let dir = hx_dir();
    let now = now_ms();
    let pid = std::process::id() as i64;
    let marker_path = dir.join(RUN_MARKER_FILE);
    let exits_path = dir.join(EXITS_FILE);

    let mut waited_ms = 0.0;
    let mut exits: Vec<AbnormalExit> = Vec::new();
    if let Ok(raw) = fs::read_to_string(&exits_path) {
        if let Ok(f) = Json::parse(&raw) {
            if let Some(w) = f.get_f64("waitedMs") {
                if w >= 0.0 {
                    waited_ms = w;
                }
            }
            if let Some(list) = f.get("exits").and_then(|e| e.as_arr()) {
                for e in list {
                    if let (Some(at), Some(eff), Some(reason)) = (e.get_f64("atMs"), e.get_f64("effAtMs"), e.get_string("reason")) {
                        exits.push(AbnormalExit { pid: e.get_f64("pid").unwrap_or(0.0) as i64, at_ms: at, eff_at_ms: eff, reason });
                    }
                }
            }
        }
    }
    let mut previous: Option<AbnormalExit> = None;
    if let Some(old) = read_marker(&marker_path) {
        let old_pid = old.get_f64("pid").unwrap_or(0.0) as i64;
        if old_pid == pid || !pid_alive(old_pid) {
            let at = old.get_f64("endedAtMs").unwrap_or(now);
            let reason = old.get_string("endedBy").unwrap_or_else(|| "ended without a clean shutdown (a crash or a signal)".to_string());
            let p = AbnormalExit { pid: old_pid, at_ms: at, eff_at_ms: at - waited_ms, reason };
            exits.push(p.clone());
            previous = Some(p);
        }
    }
    let eff_now = now - waited_ms;
    exits.retain(|e| e.eff_at_ms > eff_now - KEEP_EXITS_MS);
    if exits.len() > KEEP_EXITS_MAX {
        let drop_n = exits.len() - KEEP_EXITS_MAX;
        exits.drain(..drop_n);
    }
    let (delay_ms, recent) = crash_loop_delay_ms(&exits, eff_now);
    waited_ms += delay_ms;
    if previous.is_some() || delay_ms > 0.0 {
        let list: Vec<Json> = exits
            .iter()
            .map(|e| obj(vec![("pid", Json::num(e.pid as f64)), ("atMs", Json::num(e.at_ms)), ("effAtMs", Json::num(e.eff_at_ms)), ("reason", Json::str(&e.reason))]))
            .collect();
        write_json(&exits_path, &obj(vec![("waitedMs", Json::num(waited_ms)), ("exits", Json::Arr(list))]));
    }
    let marker = obj(vec![("pid", Json::num(pid as f64)), ("startedAtMs", Json::num(now))]);
    write_json(&marker_path, &marker);
    WatchRun { delay_ms, recent_exits: recent, previous, marker_path, marker, pid, stopped: std::sync::atomic::AtomicBool::new(false) }
}

impl WatchRun {
    /// A deliberate stop: removes this run's marker. Idempotent.
    pub fn mark_clean_stop(&self) {
        if self.stopped.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        if let Some(m) = read_marker(&self.marker_path) {
            if m.get_f64("pid").unwrap_or(0.0) as i64 == self.pid {
                let _ = fs::remove_file(&self.marker_path);
            }
        }
    }

    /// The `exit` handler's half: keep the marker and record why.
    pub fn mark_exit(&self, code: i32) {
        if self.stopped.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let m = match read_marker(&self.marker_path) {
            Some(m) => m,
            None => return,
        };
        if m.get_f64("pid").unwrap_or(0.0) as i64 != self.pid || m.get("endedBy").is_some() {
            return;
        }
        let mut next = m.clone();
        next.set("endedBy", Json::str(&if code != 0 { format!("exit code {}", code) } else { "exited without a stop request".to_string() }));
        next.set("endedAtMs", Json::num(now_ms()));
        write_json(&self.marker_path, &next);
    }

    /// The one line a start logs about the previous run and the backoff.
    pub fn describe(&self) -> Option<String> {
        let window = format!("{} min", crate::js::num_to_string(CRASH_LOOP_WINDOW_MS / 60_000.0));
        if self.delay_ms > 0.0 {
            let why = match &self.previous {
                Some(p) => format!(" (previous run: {})", p.reason),
                None => String::new(),
            };
            return Some(format!(
                "[hx] crash loop: {} abnormal exits in the last {}{}; backing off {} min before the first pass",
                self.recent_exits,
                window,
                why,
                crate::js::num_to_string(crate::js::math_round(self.delay_ms / 60_000.0))
            ));
        }
        if let Some(p) = &self.previous {
            return Some(format!(
                "[hx] warning: the previous run (pid {}) ended abnormally: {}; {} abnormal exit{} in the last {}",
                p.pid,
                p.reason,
                self.recent_exits,
                if self.recent_exits == 1 { "" } else { "s" },
                window
            ));
        }
        None
    }
}
