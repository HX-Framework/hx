//! Stdout lines, stamped the way the watch lanes stamp them (cli.ts `stamped`).
//! Every line also counts toward the daemon's log rotation and, on Windows,
//! goes into the log file the daemon writes itself (logs.rs).

use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::fsutil::now_ms;

pub struct Logger {
    stamped: bool,
    prefix: String,
    out: Mutex<()>,
    last_log_ms: AtomicU64,
}

impl Logger {
    pub fn new(stamped: bool, prefix: &str) -> Logger {
        Logger { stamped, prefix: prefix.to_string(), out: Mutex::new(()), last_log_ms: AtomicU64::new(now_ms() as u64) }
    }

    /// `YYYY-MM-DD HH:MM:SS` in the process's local time zone.
    pub fn stamp() -> String {
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
    }

    pub fn log(&self, msg: &str) {
        self.last_log_ms.store(now_ms() as u64, Ordering::Relaxed);
        // cli.ts: `localLog(msg)` is `log("[local] " + msg)` and the watch lanes
        // wrap it as `stamped(localLog)`, so the prefix comes BEFORE the stamp.
        let line = if self.stamped { format!("{}{} {}\n", self.prefix, Logger::stamp(), msg) } else { format!("{}{}\n", self.prefix, msg) };
        {
            let _g = self.out.lock().unwrap_or_else(|e| e.into_inner());
            write_stdout(line.as_bytes());
        }
        crate::logs::note_written(line.len());
    }

    pub fn last_log_ms(&self) -> f64 {
        self.last_log_ms.load(Ordering::Relaxed) as f64
    }
}

fn write_stdout(bytes: &[u8]) {
    let stdout = std::io::stdout();
    let mut h = stdout.lock();
    crate::logs::tee_write(false, bytes);
    let _ = h.write_all(bytes);
    let _ = h.flush();
}

/// Plain, unstamped stdout line (the CLI's `log`).
pub fn say(msg: &str) {
    let line = format!("{}\n", msg);
    write_stdout(line.as_bytes());
    crate::logs::note_written(line.len());
}
