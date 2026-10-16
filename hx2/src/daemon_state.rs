//! Whether the background service is installed and running (src/daemon.ts,
//! the `state()` half of each backend). The CLI's `status`, `tick`, `retry`
//! and `reattribute` read it; installing, stopping and restarting the service
//! ride the next card.
//!
//! macOS asks launchd for the `ai.let.hx-vision` job. Linux asks the systemd
//! user manager when it is reachable, else reads the container shell hook's
//! files under `~/.let/hx` (bootstrap.sh, disabled, watch.pid), else has no
//! manager at all.

use std::fs;
use std::process::{Command, Stdio};

use crate::home::hx_dir;

pub const LAUNCHD_LABEL: &str = "ai.let.hx-vision";
pub const SYSTEMD_UNIT_NAME: &str = "hx-vision.service";

#[derive(Clone, Copy, Debug)]
pub struct DaemonState {
    pub loaded: bool,
    pub pid: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Launchd,
    Systemd,
    ShellHook,
    None,
}

pub struct DaemonOps {
    kind: Kind,
    /// "launchd" | "systemd (user)" | "shell hook (container)" | "Task Scheduler" | "none"
    pub manager_name: &'static str,
}

/// Run a command with no input, capturing its output. None when it could not be launched.
fn run(cmd: &str, args: &[&str]) -> Option<(bool, String)> {
    let out = Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output().ok()?;
    Some((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned()))
}

fn ok(cmd: &str, args: &[&str]) -> bool {
    run(cmd, args).map(|(ok, _)| ok).unwrap_or(false)
}

pub fn get_daemon_ops() -> DaemonOps {
    if cfg!(target_os = "macos") {
        return DaemonOps { kind: Kind::Launchd, manager_name: "launchd" };
    }
    if cfg!(target_os = "linux") {
        // systemd user services need a reachable user manager: a cheap read
        // tells, and a missing `systemctl` fails the same way.
        if ok("systemctl", &["--user", "show-environment"]) {
            return DaemonOps { kind: Kind::Systemd, manager_name: "systemd (user)" };
        }
        if ok("bash", &["-c", "exit 0"]) && ok("sh", &["-c", "command -v setsid >/dev/null 2>&1"]) {
            return DaemonOps { kind: Kind::ShellHook, manager_name: "shell hook (container)" };
        }
        return DaemonOps { kind: Kind::None, manager_name: "none" };
    }
    DaemonOps { kind: Kind::None, manager_name: "none" }
}

fn digits_after(text: &str, marker: &str) -> Option<i64> {
    let at = text.find(marker)?;
    let rest = &text[at + marker.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<i64>().ok()
}

fn mac_state() -> DaemonState {
    match run("launchctl", &["list", LAUNCHD_LABEL]) {
        Some((true, out)) => {
            // launchctl prints a plist fragment with `"PID" = N;` while the job runs.
            let pid = out.find("\"PID\"").and_then(|i| {
                let rest = &out[i + 5..];
                let rest = rest.trim_start();
                let rest = rest.strip_prefix('=')?;
                let rest = rest.trim_start();
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if digits.is_empty() {
                    None
                } else {
                    digits.parse::<i64>().ok()
                }
            });
            DaemonState { loaded: true, pid }
        }
        _ => DaemonState { loaded: false, pid: None },
    }
}

fn linux_state() -> DaemonState {
    let loaded = ok("systemctl", &["--user", "is-enabled", SYSTEMD_UNIT_NAME]);
    match run("systemctl", &["--user", "show", SYSTEMD_UNIT_NAME, "--property=MainPID"]) {
        Some((true, out)) => {
            let pid = digits_after(&out, "MainPID=").unwrap_or(0);
            DaemonState { loaded, pid: if pid > 0 { Some(pid) } else { None } }
        }
        _ => DaemonState { loaded, pid: None },
    }
}

/// The supervisor's pid from watch.pid; only a pid above 1 counts.
fn read_watch_pid() -> Option<i64> {
    let raw = fs::read_to_string(hx_dir().join("watch.pid")).ok()?;
    let n: i64 = raw.trim().parse().ok()?;
    if n > 1 {
        Some(n)
    } else {
        None
    }
}

/// Alive and not a zombie, read from /proc.
fn proc_alive(pid: i64) -> bool {
    let stat = match fs::read_to_string(format!("/proc/{}/stat", pid)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let after = match stat.rfind(')') {
        Some(i) => &stat[i + 1..],
        None => return false,
    };
    let state = after.trim().chars().next();
    !matches!(state, Some('Z') | Some('X') | Some('x') | None)
}

fn shell_hook_state() -> DaemonState {
    let dir = hx_dir();
    let loaded = dir.join("bootstrap.sh").exists() && !dir.join("disabled").exists();
    let pid = read_watch_pid().filter(|p| proc_alive(*p));
    DaemonState { loaded, pid }
}

impl DaemonOps {
    pub fn state(&self) -> DaemonState {
        match self.kind {
            Kind::Launchd => mac_state(),
            Kind::Systemd => linux_state(),
            Kind::ShellHook => shell_hook_state(),
            Kind::None => DaemonState { loaded: false, pid: None },
        }
    }

    pub fn has_manager(&self) -> bool {
        self.kind != Kind::None
    }
}
