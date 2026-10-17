//! Which service manager runs the background service, and whether it is
//! loaded and running (src/daemon.ts: `getDaemonOps` and every backend's
//! `state()`). Installing, starting, stopping and removing the service are in
//! service.rs.
//!
//! macOS asks launchd for the `ai.let.hx-vision` job. Linux asks the systemd
//! user manager when it is reachable, else reads the container shell hook's
//! files under `~/.let/hx` (bootstrap.sh, disabled, watch.pid), else has no
//! manager at all. Windows asks Task Scheduler for the `hx-vision` task.

use std::fs;

use crate::home::hx_dir;
use crate::service::run_capture;

pub const LAUNCHD_LABEL: &str = "ai.let.hx-vision";
pub const SYSTEMD_UNIT_NAME: &str = "hx-vision.service";
pub const WIN_TASK_NAME: &str = "hx-vision";

#[derive(Clone, Copy, Debug)]
pub struct DaemonState {
    pub loaded: bool,
    pub pid: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Kind {
    Launchd,
    Systemd,
    ShellHook,
    TaskScheduler,
    None,
}

pub struct DaemonOps {
    pub(crate) kind: Kind,
    /// "launchd" | "systemd (user)" | "shell hook (container)" | "Task Scheduler" | "none"
    pub manager_name: &'static str,
    /// What every operation of the unsupported backend throws.
    pub(crate) unsupported: String,
}

fn ok(cmd: &str, args: &[&str]) -> bool {
    run_capture(cmd, args).map(|(ok, _, _)| ok).unwrap_or(false)
}

/// Node's `os.platform()` for this build.
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

pub fn get_daemon_ops() -> DaemonOps {
    let name = crate::bin_name();
    let default_unsupported = format!("{} daemon mode is not yet supported on {}. Use `{} watch` to run in a terminal.", name, node_platform(), name);
    if cfg!(target_os = "macos") {
        return DaemonOps { kind: Kind::Launchd, manager_name: "launchd", unsupported: default_unsupported };
    }
    if cfg!(target_os = "linux") {
        // systemd user services need a reachable user manager: a cheap read
        // tells, and a missing `systemctl` fails the same way.
        if ok("systemctl", &["--user", "show-environment"]) {
            return DaemonOps { kind: Kind::Systemd, manager_name: "systemd (user)", unsupported: default_unsupported };
        }
        if ok("bash", &["-c", "exit 0"]) && ok("sh", &["-c", "command -v setsid >/dev/null 2>&1"]) {
            return DaemonOps { kind: Kind::ShellHook, manager_name: "shell hook (container)", unsupported: default_unsupported };
        }
        let msg = format!(
            "{} can't run in the background here: no systemd user session, and no bash + setsid to hook into. Run `{} watch` to mirror in the foreground instead.",
            name, name
        );
        return DaemonOps { kind: Kind::None, manager_name: "none", unsupported: msg };
    }
    if cfg!(windows) {
        return DaemonOps { kind: Kind::TaskScheduler, manager_name: "Task Scheduler", unsupported: default_unsupported };
    }
    DaemonOps { kind: Kind::None, manager_name: "none", unsupported: default_unsupported }
}

/// `launchctl list ai.let.hx-vision`: loaded when it answers, the pid from
/// the `"PID" = N;` line while the job runs.
pub(crate) fn mac_state() -> DaemonState {
    match run_capture("launchctl", &["list", LAUNCHD_LABEL]) {
        Some((true, out, _)) => {
            let pid = out.find("\"PID\"").and_then(|i| {
                let rest = out[i + 5..].trim_start();
                let rest = rest.strip_prefix('=')?.trim_start();
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if digits.is_empty() || !rest[digits.len()..].starts_with(';') {
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

fn digits_after(text: &str, marker: &str) -> Option<i64> {
    let at = text.find(marker)?;
    let rest = &text[at + marker.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<i64>().ok()
}

pub(crate) fn linux_state() -> DaemonState {
    let loaded = ok("systemctl", &["--user", "is-enabled", SYSTEMD_UNIT_NAME]);
    match run_capture("systemctl", &["--user", "show", SYSTEMD_UNIT_NAME, "--property=MainPID"]) {
        Some((true, out, _)) => {
            let pid = digits_after(&out, "MainPID=").unwrap_or(0);
            DaemonState { loaded, pid: if pid > 0 { Some(pid) } else { None } }
        }
        _ => DaemonState { loaded, pid: None },
    }
}

/// The supervisor's pid from watch.pid; only a pid above 1 counts (a group
/// kill of `-1` would signal every process).
pub(crate) fn read_watch_pid() -> Option<i64> {
    let raw = fs::read_to_string(hx_dir().join("watch.pid")).ok()?;
    let n: f64 = raw.trim().parse().ok()?;
    if n.fract() == 0.0 && n > 1.0 && n < 4_294_967_296.0 {
        Some(n as i64)
    } else {
        None
    }
}

/// Alive and not a zombie, read from /proc.
pub(crate) fn proc_alive(pid: i64) -> bool {
    let stat = match fs::read_to_string(format!("/proc/{}/stat", pid)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let after = match stat.rfind(')') {
        Some(i) => &stat[i + 1..],
        None => return false,
    };
    let state = after.trim().chars().next();
    !matches!(state, Some('Z') | Some('X') | Some('x'))
}

pub(crate) fn shell_hook_state() -> DaemonState {
    let dir = hx_dir();
    let loaded = dir.join("bootstrap.sh").exists() && !dir.join("disabled").exists();
    let pid = read_watch_pid().filter(|p| proc_alive(*p));
    DaemonState { loaded, pid }
}

/// The Task Scheduler state probe: the task's state, then the pid of its
/// running instance, from the scheduler's COM service (never `schtasks
/// /Query`, whose labels are localized).
pub(crate) const WIN_STATE_PS: &str = "$ErrorActionPreference='SilentlyContinue'; $svc = New-Object -ComObject Schedule.Service; $svc.Connect(); $t = $svc.GetFolder('\\').GetTask('hx-vision'); if (-not $t) { 'Absent'; ''; exit }; switch ($t.State) { 1 {'Disabled'} 2 {'Ready'} 3 {'Ready'} 4 {'Running'} default {'Unknown'} }; $enginePid = ($t.GetInstances(0) | Select-Object -First 1).EnginePID; if ($enginePid) { \"$enginePid\" } else { '' }";

/// `parseWinState`: a disabled task reads as not loaded, as a disabled systemd unit does.
pub(crate) fn parse_win_state(stdout: &str) -> DaemonState {
    let lines: Vec<&str> = stdout.split('\n').map(|l| l.trim()).collect();
    let state = lines.first().copied().unwrap_or("");
    if state.is_empty() || state == "Absent" {
        return DaemonState { loaded: false, pid: None };
    }
    let pid = lines.get(1).and_then(|l| l.parse::<f64>().ok()).filter(|p| p.fract() == 0.0 && *p > 0.0).map(|p| p as i64);
    DaemonState { loaded: state != "Disabled", pid }
}

pub(crate) fn win_state() -> DaemonState {
    match run_capture("powershell", &["-NoProfile", "-NonInteractive", "-Command", WIN_STATE_PS]) {
        Some((true, out, _)) => parse_win_state(&out),
        _ => DaemonState { loaded: false, pid: None },
    }
}

impl DaemonOps {
    pub fn state(&self) -> DaemonState {
        match self.kind {
            Kind::Launchd => mac_state(),
            Kind::Systemd => linux_state(),
            Kind::ShellHook => shell_hook_state(),
            Kind::TaskScheduler => win_state(),
            Kind::None => DaemonState { loaded: false, pid: None },
        }
    }

    pub fn has_manager(&self) -> bool {
        self.kind != Kind::None
    }
}
