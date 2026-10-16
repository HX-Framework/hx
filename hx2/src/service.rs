//! The background service (src/daemon.ts): install, start, stop, restart and
//! uninstall on launchd, systemd, the container shell hook and Task
//! Scheduler; the templates of the three definitions; and the running
//! daemon's check that its installed definition is the current template.
//!
//! Every definition is byte-identical to the TypeScript client's apart from
//! the binary's path, under the same label (`ai.let.hx-vision`): hx and hx2
//! share one service slot, so only one of them runs at a time. The managed
//! note inside each file keeps hx's wording for that reason.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::daemon_state::{linux_state, mac_state, proc_alive, read_watch_pid, win_state, DaemonOps, DaemonState, Kind, LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, WIN_TASK_NAME};
use crate::home::{homedir, hx_dir};

/// How long a stop waits after SIGTERM before it sends SIGKILL.
pub const STOP_GRACE_SECONDS: u64 = 5;
/// nice(3) value for the daemon on macOS and Linux.
const SERVICE_NICE: u32 = 10;
/// Seconds between two spawns of the daemon by its service manager.
const RESPAWN_DELAY_SEC: u32 = 60;
const START_LIMIT_BURST: u32 = 5;
const START_LIMIT_INTERVAL_SEC: u32 = 600;
const MEMORY_HIGH: &str = "1G";
const MEMORY_MAX: &str = "2G";
const MEMORY_SWAP_MAX: &str = "512M";

/// The first line of every definition. It names hx on purpose: the files are
/// byte-identical between hx and hx2 apart from the binary's path.
const MANAGED_NOTE: &str = "Managed by hx. hx start, hx update and the hx daemon rewrite this file, so local edits do not last.";

/// Whether the shell-hook backend may edit ~/.bashrc and ~/.profile.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Consent {
    Granted,
    Denied,
}

pub struct StopResult {
    pub was_running: bool,
    pub forced: bool,
}

/// Where the service manager sends the daemon's stdout and stderr.
pub struct LogPaths {
    pub stdout: String,
    pub stderr: String,
}

pub fn stdout_log() -> PathBuf {
    hx_dir().join("stdout.log")
}

pub fn stderr_log() -> PathBuf {
    hx_dir().join("stderr.log")
}

fn daemon_logs() -> LogPaths {
    LogPaths { stdout: stdout_log().to_string_lossy().into_owned(), stderr: stderr_log().to_string_lossy().into_owned() }
}

pub fn launchd_plist_path() -> PathBuf {
    homedir().join("Library").join("LaunchAgents").join(format!("{}.plist", LAUNCHD_LABEL))
}

pub fn systemd_unit_path() -> PathBuf {
    homedir().join(".config").join("systemd").join("user").join(SYSTEMD_UNIT_NAME)
}

fn bootstrap_path() -> PathBuf {
    hx_dir().join("bootstrap.sh")
}

fn watch_pid_path() -> PathBuf {
    hx_dir().join("watch.pid")
}

fn watch_lock_path() -> PathBuf {
    hx_dir().join("watch.lock")
}

fn disabled_flag_path() -> PathBuf {
    hx_dir().join("disabled")
}

fn hook_dotfiles() -> [PathBuf; 2] {
    [homedir().join(".bashrc"), homedir().join(".profile")]
}

const HOOK_BEGIN: &str = "# >>> hx >>>";
const HOOK_END: &str = "# <<< hx <<<";

fn p(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ── Child processes ─────────────────────────────────────────────────────────

/// What `spawnSync` returns: the exit code (None when a signal ended it), the
/// captured output, and the launch error when the command could not start.
pub struct Spawned {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

impl Spawned {
    pub fn ok(&self) -> bool {
        self.error.is_none() && self.code == Some(0)
    }
}

/// Node's `spawnSync <file> <code>` message for a command that could not start.
fn launch_error(cmd: &str, e: &std::io::Error) -> String {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT".to_string(),
        std::io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        _ => e.to_string(),
    };
    format!("spawnSync {} {}", cmd, code)
}

/// `spawnSync(cmd, args, { stdio: "pipe" })`.
pub fn spawn_sync(cmd: &str, args: &[&str]) -> Spawned {
    match Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output() {
        Ok(out) => Spawned {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            error: None,
        },
        Err(e) => Spawned { code: None, stdout: String::new(), stderr: String::new(), error: Some(launch_error(cmd, &e)) },
    }
}

/// `spawnSync(cmd, args, { stdio: "ignore" })`.
pub fn spawn_ignore(cmd: &str, args: &[&str]) -> Spawned {
    match Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(st) => Spawned { code: st.code(), stdout: String::new(), stderr: String::new(), error: None },
        Err(e) => Spawned { code: None, stdout: String::new(), stderr: String::new(), error: Some(launch_error(cmd, &e)) },
    }
}

/// `spawnSync(cmd, args, { stdio: "ignore", timeout })`: the child is sent
/// SIGTERM when the timeout runs out, and reaped.
pub fn spawn_ignore_timeout(cmd: &str, args: &[&str], timeout_ms: u64) -> Spawned {
    let mut child = match Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(c) => c,
        Err(e) => return Spawned { code: None, stdout: String::new(), stderr: String::new(), error: Some(launch_error(cmd, &e)) },
    };
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return Spawned { code: st.code(), stdout: String::new(), stderr: String::new(), error: None },
            Ok(None) => {}
            Err(_) => break,
        }
        if Instant::now() >= deadline {
            terminate(child.id() as i64);
            let st = child.wait().ok();
            return Spawned { code: st.and_then(|s| s.code()), stdout: String::new(), stderr: String::new(), error: Some(format!("spawnSync {} ETIMEDOUT", cmd)) };
        }
        sleep_ms(20);
    }
    let st = child.wait().ok();
    Spawned { code: st.and_then(|s| s.code()), stdout: String::new(), stderr: String::new(), error: None }
}

/// Run a command with no input, capturing its output: (exit 0, stdout, stderr).
/// None when it could not be launched.
pub fn run_capture(cmd: &str, args: &[&str]) -> Option<(bool, String, String)> {
    let r = spawn_sync(cmd, args);
    if r.error.is_some() {
        return None;
    }
    Some((r.ok(), r.stdout, r.stderr))
}

/// `failureDetail`: the launch error, else stderr, else stdout, else the exit.
pub fn failure_detail(r: &Spawned) -> String {
    if let Some(e) = &r.error {
        return e.clone();
    }
    let stderr = r.stderr.trim();
    let stdout = r.stdout.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    match r.code {
        Some(c) => format!("exit {}", c),
        None => "exit unknown".to_string(),
    }
}

/// `runOrThrow`.
pub fn run_or_throw(cmd: &str, args: &[&str]) -> Result<(), String> {
    let r = spawn_sync(cmd, args);
    if !r.ok() {
        return Err(format!("{} {} failed: {}", cmd, args.join(" "), failure_detail(&r)));
    }
    Ok(())
}

pub fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn now() -> Instant {
    Instant::now()
}

// ── Process signals ─────────────────────────────────────────────────────────

/// kill(pid, 0): ESRCH means gone; EPERM means alive and someone else's.
#[cfg(unix)]
fn posix_pid_alive(pid: i64) -> bool {
    // SAFETY: kill with signal 0 sends nothing; it only checks the pid.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if r == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn posix_pid_alive(pid: i64) -> bool {
    win_pid_alive(pid)
}

#[cfg(unix)]
fn signal(pid: i64, sig: libc::c_int) -> bool {
    // SAFETY: plain kill(2); a negative pid names a process group.
    unsafe { libc::kill(pid as libc::pid_t, sig) == 0 }
}

#[cfg(unix)]
fn kill_hard(pid: i64) {
    let _ = signal(pid, libc::SIGKILL);
}

#[cfg(not(unix))]
fn kill_hard(pid: i64) {
    let _ = spawn_ignore("taskkill", &["/F", "/PID", &pid.to_string()]);
}

/// SIGTERM, the default kill signal of `spawnSync`'s timeout.
#[cfg(unix)]
fn terminate(pid: i64) {
    let _ = signal(pid, libc::SIGTERM);
}

#[cfg(not(unix))]
fn terminate(pid: i64) {
    let _ = spawn_ignore("taskkill", &["/PID", &pid.to_string()]);
}

/// Windows has no zombie state, so a process the system still lists is alive.
fn win_pid_alive(pid: i64) -> bool {
    let filter = format!("PID eq {}", pid);
    match run_capture("tasklist", &["/FI", &filter, "/NH", "/FO", "CSV"]) {
        Some((_, out, _)) => out.contains(&format!("\"{}\"", pid)),
        None => false,
    }
}

/// `awaitExitOrKill`: wait up to `grace_ms` for `pid` to exit, then SIGKILL it
/// and wait up to 2 s more. Returns whether the SIGKILL was needed.
pub fn await_exit_or_kill(pid: i64, grace_ms: u64) -> bool {
    let deadline = now() + Duration::from_millis(grace_ms);
    while posix_pid_alive(pid) {
        if now() >= deadline {
            kill_hard(pid);
            let kill_deadline = now() + Duration::from_millis(2000);
            while posix_pid_alive(pid) && now() < kill_deadline {
                sleep_ms(50);
            }
            return true;
        }
        sleep_ms(100);
    }
    false
}

// ── Files ───────────────────────────────────────────────────────────────────

fn mkdir_p(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| crate::fsutil::node_error(&e, "mkdir", dir))
}

fn write_text(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| crate::fsutil::node_error(&e, "open", path))
}

/// `writeIfChanged`: a plain write (a symlinked definition stays a symlink),
/// skipped when the file already holds exactly `content`.
fn write_if_changed(path: &Path, content: &str) -> Result<bool, String> {
    if let Ok(current) = fs::read_to_string(path) {
        if current == content {
            return Ok(false);
        }
    }
    write_text(path, content)?;
    Ok(true)
}

fn unlink_quiet(path: &Path) {
    let _ = fs::remove_file(path);
}

/// `clearCrashHistory`: a person asked for a start, so the daemon they start
/// begins at once instead of serving out a crash-loop backoff.
fn clear_crash_history() {
    unlink_quiet(&hx_dir().join(crate::crashloop::EXITS_FILE));
}

// ── macOS / launchd ─────────────────────────────────────────────────────────

fn mac_target() -> String {
    format!("gui/{}", current_uid())
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: getuid cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}

/// `launchctl bootout` returns before launchd has finished tearing the job down.
fn wait_until_unloaded(max_ms: u64) {
    let deadline = now() + Duration::from_millis(max_ms);
    while mac_state().loaded && now() < deadline {
        sleep_ms(100);
    }
}

/// The bootout→bootstrap race surfaces as a transient I/O or in-progress error.
fn transient_bootstrap(detail: &str) -> bool {
    let d = detail.to_lowercase();
    if d.contains("input/output error") || d.contains("operation already in progress") || d.contains("operation now in progress") {
        return true;
    }
    let mut rest = d.as_str();
    while let Some(i) = rest.find("bootstrap failed: ") {
        let after = &rest[i + "bootstrap failed: ".len()..];
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        let next = after[digits.len()..].chars().next();
        let boundary = next.map(|c| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(true);
        if boundary && matches!(digits.as_str(), "5" | "37" | "125") {
            return true;
        }
        rest = after;
    }
    false
}

fn bootstrap_with_retry(target: &str, plist: &Path) -> Result<(), String> {
    let backoff_ms = [150u64, 300, 600, 1000, 2000];
    let plist_s = p(plist);
    let mut last_detail = String::new();
    for attempt in 0..=backoff_ms.len() {
        let r = spawn_sync("launchctl", &["bootstrap", target, &plist_s]);
        if r.ok() {
            return Ok(());
        }
        last_detail = failure_detail(&r);
        if attempt == backoff_ms.len() || !transient_bootstrap(&last_detail) {
            break;
        }
        sleep_ms(backoff_ms[attempt]);
    }
    Err(format!("launchctl bootstrap {} {} failed: {}", target, plist_s, last_detail))
}

/// Unload the job (if loaded) and load it again from the plist on disk: the
/// only way launchd picks up a changed plist.
fn reload_launchd_job(target: &str) -> Result<(), String> {
    let running = mac_state().pid;
    let service = format!("{}/{}", target, LAUNCHD_LABEL);
    let _ = spawn_ignore("launchctl", &["bootout", &service]);
    if let Some(pid) = running {
        await_exit_or_kill(pid, STOP_GRACE_SECONDS * 1000);
    }
    wait_until_unloaded(2000);
    // Enable BEFORE bootstrap: `hx stop` disables the service, and
    // bootstrapping a disabled service fails with "Bootstrap failed: 119".
    run_or_throw("launchctl", &["enable", &service])?;
    bootstrap_with_retry(target, &launchd_plist_path())
}

fn mac_install(bin_path: &str) -> Result<(), String> {
    let plist = launchd_plist_path();
    mkdir_p(plist.parent().expect("LaunchAgents dir"))?;
    mkdir_p(hx_dir())?;
    write_text(&plist, &render_plist(bin_path, &daemon_logs()))?;
    reload_launchd_job(&mac_target())
}

fn mac_restart(bin_path: &str) -> Result<(), String> {
    let plist = launchd_plist_path();
    mkdir_p(plist.parent().expect("LaunchAgents dir"))?;
    mkdir_p(hx_dir())?;
    let changed = write_if_changed(&plist, &render_plist(bin_path, &daemon_logs()))?;
    let target = mac_target();
    if mac_state().loaded && !changed {
        // In-place restart: launchd kills the running instance (SIGTERM, then
        // SIGKILL after the plist's ExitTimeOut) and respawns it from the
        // same plist, at the binary's (atomically swapped) path.
        run_or_throw("launchctl", &["kickstart", "-k", &format!("{}/{}", target, LAUNCHD_LABEL)])
    } else {
        reload_launchd_job(&target)
    }
}

fn mac_uninstall() -> Result<(), String> {
    let _ = spawn_ignore("launchctl", &["bootout", &format!("{}/{}", mac_target(), LAUNCHD_LABEL)]);
    let plist = launchd_plist_path();
    if plist.exists() {
        fs::remove_file(&plist).map_err(|e| crate::fsutil::node_error(&e, "unlink", &plist))?;
    }
    Ok(())
}

fn mac_start() -> Result<(), String> {
    run_or_throw("launchctl", &["kickstart", "-k", &format!("{}/{}", mac_target(), LAUNCHD_LABEL)])
}

fn mac_stop() -> Result<StopResult, String> {
    let target = mac_target();
    let service = format!("{}/{}", target, LAUNCHD_LABEL);
    // Disable first so the stop sticks across the next login.
    let _ = spawn_ignore("launchctl", &["disable", &service]);
    let before = mac_state();
    if !before.loaded {
        return Ok(StopResult { was_running: false, forced: false });
    }
    let r = spawn_sync("launchctl", &["bootout", &service]);
    // bootout sends SIGTERM and returns at once; a frozen daemon ignores it.
    let forced = match before.pid {
        Some(pid) => await_exit_or_kill(pid, STOP_GRACE_SECONDS * 1000),
        None => false,
    };
    wait_until_unloaded(2000);
    if mac_state().loaded {
        return Err(format!("launchctl bootout {} failed: {}", service, failure_detail(&r)));
    }
    Ok(StopResult { was_running: true, forced })
}

// ── Linux / systemd ─────────────────────────────────────────────────────────

/// `reset-failed` also zeroes the unit's start-rate counter.
fn clear_start_limit() {
    let _ = spawn_ignore("systemctl", &["--user", "reset-failed", SYSTEMD_UNIT_NAME]);
}

/// Is any process of the unit still up? `ActiveState` answers for a unit
/// whose stop job waits on a process that ignores SIGTERM.
fn systemd_unit_running() -> bool {
    let r = spawn_sync("systemctl", &["--user", "show", SYSTEMD_UNIT_NAME, "--property=ActiveState"]);
    if !r.ok() {
        return false;
    }
    let state = r.stdout.split("ActiveState=").nth(1).map(|s| s.split_whitespace().next().unwrap_or("").to_string()).unwrap_or_default();
    matches!(state.as_str(), "active" | "activating" | "deactivating" | "reloading")
}

fn systemd_install(bin_path: &str) -> Result<(), String> {
    let unit = systemd_unit_path();
    mkdir_p(unit.parent().expect("systemd user dir"))?;
    mkdir_p(hx_dir())?;
    let changed = write_if_changed(&unit, &render_systemd_unit(bin_path, &daemon_logs()))?;
    run_or_throw("systemctl", &["--user", "daemon-reload"])?;
    clear_start_limit();
    run_or_throw("systemctl", &["--user", "enable", SYSTEMD_UNIT_NAME])?;
    run_or_throw("systemctl", &["--user", if changed { "restart" } else { "start" }, SYSTEMD_UNIT_NAME])
}

fn systemd_restart(bin_path: &str) -> Result<(), String> {
    let unit = systemd_unit_path();
    mkdir_p(unit.parent().expect("systemd user dir"))?;
    mkdir_p(hx_dir())?;
    write_text(&unit, &render_systemd_unit(bin_path, &daemon_logs()))?;
    run_or_throw("systemctl", &["--user", "daemon-reload"])?;
    clear_start_limit();
    run_or_throw("systemctl", &["--user", "restart", SYSTEMD_UNIT_NAME])
}

fn systemd_uninstall() -> Result<(), String> {
    let _ = spawn_ignore("systemctl", &["--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
    let unit = systemd_unit_path();
    if unit.exists() {
        fs::remove_file(&unit).map_err(|e| crate::fsutil::node_error(&e, "unlink", &unit))?;
    }
    let _ = spawn_ignore("systemctl", &["--user", "daemon-reload"]);
    Ok(())
}

fn systemd_start() -> Result<(), String> {
    run_or_throw("systemctl", &["--user", "start", SYSTEMD_UNIT_NAME])
}

fn systemd_stop() -> Result<StopResult, String> {
    let before = linux_state();
    let _ = spawn_ignore("systemctl", &["--user", "disable", SYSTEMD_UNIT_NAME]);
    let _ = spawn_ignore_timeout("systemctl", &["--user", "stop", SYSTEMD_UNIT_NAME], STOP_GRACE_SECONDS * 1000);
    let mut forced = false;
    if systemd_unit_running() {
        forced = true;
        let _ = spawn_ignore("systemctl", &["--user", "kill", "--signal=SIGKILL", SYSTEMD_UNIT_NAME]);
        let deadline = now() + Duration::from_millis(2000);
        while systemd_unit_running() && now() < deadline {
            sleep_ms(100);
        }
    }
    if systemd_unit_running() {
        return Err(format!("systemctl --user stop {} failed: unit still running", SYSTEMD_UNIT_NAME));
    }
    Ok(StopResult { was_running: before.pid.is_some(), forced })
}

// ── Linux / container (shell hook) ──────────────────────────────────────────

/// POSIX single-quote a string so it can't break out of the generated script.
pub fn shquote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn hook_source_line() -> String {
    let b = shquote(&p(&bootstrap_path()));
    format!("[ -f {} ] && . {}", b, b)
}

/// The launcher hx writes to bootstrap.sh (src/daemon.ts renderBootstrap).
pub fn render_bootstrap(bin_path: &str) -> String {
    let cfg = shquote(&p(&hx_dir().join("config.json")));
    let disabled = shquote(&p(&disabled_flag_path()));
    let pid = shquote(&p(&watch_pid_path()));
    let lock = shquote(&p(&watch_lock_path()));
    let bin = shquote(bin_path);
    let logf = shquote(&p(&stdout_log()));
    let lp = format!(
        "if command -v flock >/dev/null 2>&1; then exec 9> {}; flock -n 9 || exit 0; fi; echo $$ > {}; while true; do {} watch >> {} 2>&1; sleep 5; done",
        lock, pid, bin, logf
    );
    let mut s = String::new();
    s.push_str("# Managed by hx — do not edit. Regenerated by `hx start` / `hx update`.\n");
    s.push_str("# True only when $1 is a live, non-zombie process. `kill -0` alone reports a\n");
    s.push_str("# zombie (dead-but-unreaped, common under a non-reaping container PID 1) as\n");
    s.push_str("# alive, which would wedge the relaunch below — so check /proc state directly.\n");
    s.push_str("__hx_alive() {\n");
    s.push_str("  [ -n \"$1\" ] || return 1\n");
    s.push_str("  __st=$(cat /proc/\"$1\"/stat 2>/dev/null) || return 1\n");
    s.push_str("  __st=${__st##*) }   # strip through the last \") \" → \"<state> <ppid> ...\"\n");
    s.push_str("  case ${__st%% *} in Z|X|x|\"\") return 1 ;; *) return 0 ;; esac\n");
    s.push_str("}\n");
    s.push_str("__hx_boot() {\n");
    s.push_str(&format!("  [ -f {} ] || return          # not connected → nothing to mirror\n", cfg));
    s.push_str(&format!("  [ -f {} ] && return      # `hx stop` set this flag\n", disabled));
    s.push_str(&format!("  [ -x {} ] || return\n", bin));
    s.push_str(&format!("  __hx_alive \"$(cat {} 2>/dev/null)\" && return   # already running\n", pid));
    s.push_str(&format!("  setsid sh -c {} >/dev/null 2>&1 &\n", shquote(&lp)));
    s.push_str("}\n");
    s.push_str("__hx_boot; unset -f __hx_boot __hx_alive; unset __st\n");
    s
}

pub fn dotfiles_wired() -> bool {
    hook_dotfiles().iter().any(|f| fs::read_to_string(f).map(|c| c.contains(HOOK_BEGIN)).unwrap_or(false))
}

/// Append the hx marker block, unless already present.
pub fn insert_hook_block(content: &str) -> String {
    if content.contains(HOOK_BEGIN) {
        return content.to_string();
    }
    format!("{}\n{}\n{}\n{}\n", content, HOOK_BEGIN, hook_source_line(), HOOK_END)
}

/// Remove every hx marker block and the newlines around it (one "\n" stays).
pub fn strip_hook_block(content: &str) -> String {
    let mut out = String::new();
    let mut rest = content;
    loop {
        let begin = match rest.find(HOOK_BEGIN) {
            Some(b) => b,
            None => break,
        };
        let end_rel = match rest[begin..].find(HOOK_END) {
            Some(e) => e,
            None => break,
        };
        let mut start = begin;
        if start > 0 && rest.as_bytes()[start - 1] == b'\n' {
            start -= 1;
        }
        let mut stop = begin + end_rel + HOOK_END.len();
        if rest.as_bytes().get(stop) == Some(&b'\n') {
            stop += 1;
        }
        out.push_str(&rest[..start]);
        out.push('\n');
        rest = &rest[stop..];
    }
    out.push_str(rest);
    out
}

fn wire_dotfiles() -> Result<(), String> {
    for f in hook_dotfiles() {
        let cur = fs::read_to_string(&f).unwrap_or_default();
        let next = insert_hook_block(&cur);
        if next != cur {
            write_text(&f, &next)?;
        }
    }
    Ok(())
}

fn unwire_dotfiles() -> Result<(), String> {
    for f in hook_dotfiles() {
        let cur = match fs::read_to_string(&f) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !cur.contains(HOOK_BEGIN) {
            continue;
        }
        write_text(&f, &strip_hook_block(&cur))?;
    }
    Ok(())
}

/// Run bootstrap.sh once, now, and wait briefly for the supervisor's pidfile.
fn launch_now() {
    let _ = spawn_ignore("sh", &[&p(&bootstrap_path())]);
    let deadline = now() + Duration::from_millis(2000);
    while now() < deadline {
        if let Some(pid) = read_watch_pid() {
            if proc_alive(pid) {
                return;
            }
        }
        sleep_ms(50);
    }
}

/// Kill the supervisor's whole process group, escalating to SIGKILL.
/// Returns whether it was running.
fn kill_watch() -> bool {
    let pid = match read_watch_pid() {
        Some(p) => p,
        None => return false,
    };
    let was_running = proc_alive(pid);
    #[cfg(unix)]
    {
        let _ = signal(-pid, libc::SIGTERM);
        let deadline = now() + Duration::from_millis(1500);
        while proc_alive(pid) && now() < deadline {
            sleep_ms(100);
        }
        let _ = signal(-pid, libc::SIGKILL);
    }
    sleep_ms(100);
    was_running
}

fn hook_install(bin_path: &str, consent: Consent) -> Result<(), String> {
    mkdir_p(hx_dir())?;
    write_text(&bootstrap_path(), &render_bootstrap(bin_path))?;
    unlink_quiet(&disabled_flag_path());
    if consent == Consent::Granted {
        wire_dotfiles()?;
    }
    launch_now();
    Ok(())
}

fn hook_restart(bin_path: &str, consent: Consent) -> Result<(), String> {
    mkdir_p(hx_dir())?;
    write_text(&bootstrap_path(), &render_bootstrap(bin_path))?;
    unlink_quiet(&disabled_flag_path());
    if consent == Consent::Granted {
        wire_dotfiles()?;
    }
    kill_watch();
    unlink_quiet(&watch_pid_path());
    launch_now();
    Ok(())
}

fn hook_uninstall() -> Result<(), String> {
    kill_watch();
    unlink_quiet(&watch_pid_path());
    unlink_quiet(&watch_lock_path());
    unlink_quiet(&disabled_flag_path());
    unlink_quiet(&bootstrap_path());
    unwire_dotfiles()
}

fn hook_start() -> Result<(), String> {
    unlink_quiet(&disabled_flag_path());
    launch_now();
    Ok(())
}

fn hook_stop() -> Result<StopResult, String> {
    write_text(&disabled_flag_path(), "")?;
    let was_running = kill_watch();
    if let Some(after) = read_watch_pid() {
        if proc_alive(after) {
            return Err(format!("{} background process (pid {}) survived stop", crate::bin_name(), after));
        }
    }
    unlink_quiet(&watch_pid_path());
    Ok(StopResult { was_running, forced: false })
}

// ── Windows / Task Scheduler ────────────────────────────────────────────────

/// The windowless service build the scheduled task runs, beside the CLI
/// binary (`hx2-svc.exe` next to `hx2.exe`); the CLI binary itself when the
/// service build is absent.
pub fn windows_service_binary(bin_path: &str) -> String {
    let dir = match bin_path.rfind(['\\', '/']) {
        Some(i) => &bin_path[..i],
        None => ".",
    };
    let candidate = format!("{}\\{}-svc.exe", dir, crate::bin_name());
    if Path::new(&candidate).exists() {
        candidate
    } else {
        bin_path.to_string()
    }
}

/// `DOMAIN\user` when the domain is known, else the bare username.
fn windows_user_id() -> String {
    let user = std::env::var("USERNAME").ok().filter(|u| !u.is_empty()).unwrap_or_else(crate::connect::os_username);
    match std::env::var("USERDOMAIN").ok().filter(|d| !d.is_empty()) {
        Some(domain) => format!("{}\\{}", domain, user),
        None => user,
    }
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn unescape_xml(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// The task definition (src/daemon.ts renderTaskXml).
pub fn render_task_xml(bin_path: &str, user_id: &str) -> String {
    let u = escape_xml(user_id);
    let mut s = String::new();
    s.push_str("<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n");
    s.push_str("<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n");
    s.push_str("  <RegistrationInfo>\n");
    s.push_str("    <Description>hx-vision session mirror</Description>\n");
    s.push_str("  </RegistrationInfo>\n");
    s.push_str("  <Triggers>\n");
    s.push_str("    <LogonTrigger>\n");
    s.push_str("      <Enabled>true</Enabled>\n");
    s.push_str(&format!("      <UserId>{}</UserId>\n", u));
    s.push_str("    </LogonTrigger>\n");
    s.push_str("    <TimeTrigger>\n");
    s.push_str("      <StartBoundary>2024-01-01T00:00:00</StartBoundary>\n");
    s.push_str("      <Enabled>true</Enabled>\n");
    s.push_str("      <Repetition>\n");
    s.push_str("        <Interval>PT5M</Interval>\n");
    s.push_str("        <StopAtDurationEnd>false</StopAtDurationEnd>\n");
    s.push_str("      </Repetition>\n");
    s.push_str("    </TimeTrigger>\n");
    s.push_str("  </Triggers>\n");
    s.push_str("  <Principals>\n");
    s.push_str("    <Principal id=\"Author\">\n");
    s.push_str(&format!("      <UserId>{}</UserId>\n", u));
    s.push_str("      <LogonType>InteractiveToken</LogonType>\n");
    s.push_str("      <RunLevel>LeastPrivilege</RunLevel>\n");
    s.push_str("    </Principal>\n");
    s.push_str("  </Principals>\n");
    s.push_str("  <Settings>\n");
    s.push_str("    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n");
    s.push_str("    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n");
    s.push_str("    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n");
    s.push_str("    <AllowHardTerminate>true</AllowHardTerminate>\n");
    s.push_str("    <StartWhenAvailable>true</StartWhenAvailable>\n");
    s.push_str("    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n");
    s.push_str("    <IdleSettings>\n");
    s.push_str("      <StopOnIdleEnd>false</StopOnIdleEnd>\n");
    s.push_str("      <RestartOnIdle>false</RestartOnIdle>\n");
    s.push_str("    </IdleSettings>\n");
    s.push_str("    <AllowStartOnDemand>true</AllowStartOnDemand>\n");
    s.push_str("    <Enabled>true</Enabled>\n");
    s.push_str("    <Hidden>false</Hidden>\n");
    s.push_str("    <RunOnlyIfIdle>false</RunOnlyIfIdle>\n");
    s.push_str("    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n");
    s.push_str("    <Priority>7</Priority>\n");
    s.push_str("  </Settings>\n");
    s.push_str("  <Actions Context=\"Author\">\n");
    s.push_str("    <Exec>\n");
    s.push_str(&format!("      <Command>{}</Command>\n", escape_xml(bin_path)));
    s.push_str("      <Arguments>watch</Arguments>\n");
    s.push_str("    </Exec>\n");
    s.push_str("  </Actions>\n");
    s.push_str("</Task>\n");
    s
}

/// Write the task XML where schtasks can read it: UTF-16LE with a BOM.
fn write_task_xml(xml: &str) -> Result<PathBuf, String> {
    let target = hx_dir().join(format!("task-{}.xml", std::process::id()));
    let mut buf: Vec<u8> = vec![0xff, 0xfe];
    for u in xml.encode_utf16() {
        buf.extend_from_slice(&u.to_le_bytes());
    }
    fs::write(&target, buf).map_err(|e| crate::fsutil::node_error(&e, "open", &target))?;
    Ok(target)
}

/// (Re)register the task at `bin_path`, bounce any instance still running the
/// previous definition, and start it.
fn win_register(bin_path: &str) -> Result<(), String> {
    mkdir_p(hx_dir())?;
    let exe = windows_service_binary(bin_path);
    let xml_path = write_task_xml(&render_task_xml(&exe, &windows_user_id()))?;
    let r = run_or_throw("schtasks", &["/Create", "/TN", WIN_TASK_NAME, "/XML", &p(&xml_path), "/F"]);
    unlink_quiet(&xml_path);
    r?;
    win_kill(8000);
    run_or_throw("schtasks", &["/Run", "/TN", WIN_TASK_NAME])
}

fn wait_for_win_pid(max_ms: u64) -> DaemonState {
    let deadline = now() + Duration::from_millis(max_ms);
    let mut last = win_state();
    while last.pid.is_none() && now() < deadline {
        sleep_ms(200);
        last = win_state();
    }
    last
}

/// Stop the running instance and wait for it to be gone: `schtasks /End`,
/// then `taskkill /F /T` by the pid the scheduler reports.
fn win_kill(max_ms: u64) -> DaemonState {
    let before = win_state();
    let _ = spawn_ignore("schtasks", &["/End", "/TN", WIN_TASK_NAME]);
    if let Some(pid) = before.pid {
        let _ = spawn_ignore("taskkill", &["/F", "/T", "/PID", &pid.to_string()]);
        let deadline = now() + Duration::from_millis(max_ms);
        while win_pid_alive(pid) && now() < deadline {
            sleep_ms(100);
        }
    }
    win_state()
}

fn win_restart(bin_path: &str) -> Result<(), String> {
    win_register(bin_path)?;
    if wait_for_win_pid(5000).pid.is_none() {
        return Err(format!(
            "scheduled task {} was (re)registered but no process appeared; check Task Scheduler history for the task's last result.",
            WIN_TASK_NAME
        ));
    }
    Ok(())
}

fn win_uninstall() -> Result<(), String> {
    win_kill(8000);
    let _ = spawn_ignore("schtasks", &["/Delete", "/TN", WIN_TASK_NAME, "/F"]);
    Ok(())
}

fn win_start() -> Result<(), String> {
    run_or_throw("schtasks", &["/Change", "/TN", WIN_TASK_NAME, "/ENABLE"])?;
    run_or_throw("schtasks", &["/Run", "/TN", WIN_TASK_NAME])
}

fn win_stop() -> Result<StopResult, String> {
    let before = win_state();
    let _ = spawn_ignore("schtasks", &["/Change", "/TN", WIN_TASK_NAME, "/DISABLE"]);
    let after = win_kill(8000);
    if let Some(pid) = after.pid {
        return Err(format!("{} background process (pid {}) survived stop", crate::bin_name(), pid));
    }
    Ok(StopResult { was_running: before.pid.is_some(), forced: false })
}

// ── The operations ──────────────────────────────────────────────────────────

impl DaemonOps {
    /// True when install()/restart() may edit the user's shell dotfiles.
    pub fn needs_dotfile_consent(&self) -> bool {
        self.kind == Kind::ShellHook
    }

    pub fn dotfiles_wired(&self) -> bool {
        self.kind == Kind::ShellHook && dotfiles_wired()
    }

    /// Install (or re-install) and start the service at `bin_path`.
    pub fn install(&self, bin_path: &str, consent: Consent) -> Result<(), String> {
        clear_crash_history();
        match self.kind {
            Kind::Launchd => mac_install(bin_path),
            Kind::Systemd => systemd_install(bin_path),
            Kind::ShellHook => hook_install(bin_path, consent),
            Kind::TaskScheduler => win_register(bin_path),
            Kind::None => Err(self.unsupported.clone()),
        }
    }

    /// Restart the installed service so it re-execs the binary at its path.
    pub fn restart(&self, bin_path: &str, consent: Consent) -> Result<(), String> {
        clear_crash_history();
        match self.kind {
            Kind::Launchd => mac_restart(bin_path),
            Kind::Systemd => systemd_restart(bin_path),
            Kind::ShellHook => hook_restart(bin_path, consent),
            Kind::TaskScheduler => win_restart(bin_path),
            Kind::None => Err(self.unsupported.clone()),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        clear_crash_history();
        match self.kind {
            Kind::Launchd => mac_start(),
            Kind::Systemd => systemd_start(),
            Kind::ShellHook => hook_start(),
            Kind::TaskScheduler => win_start(),
            Kind::None => Err(self.unsupported.clone()),
        }
    }

    /// Stop the service and keep it stopped until a start. Errors when the
    /// service survived the stop.
    pub fn stop(&self) -> Result<StopResult, String> {
        match self.kind {
            Kind::Launchd => mac_stop(),
            Kind::Systemd => systemd_stop(),
            Kind::ShellHook => hook_stop(),
            Kind::TaskScheduler => win_stop(),
            Kind::None => Err(self.unsupported.clone()),
        }
    }

    pub fn uninstall(&self) -> Result<(), String> {
        match self.kind {
            Kind::Launchd => mac_uninstall(),
            Kind::Systemd => systemd_uninstall(),
            Kind::ShellHook => hook_uninstall(),
            Kind::TaskScheduler => win_uninstall(),
            Kind::None => Ok(()),
        }
    }

    /// The binary the installed definition runs, as written in it, if any.
    pub fn slot_binary(&self) -> Option<String> {
        match self.kind {
            Kind::Launchd => fs::read_to_string(launchd_plist_path()).ok().and_then(|c| definition_bin_path(ServiceKind::Launchd, &c)),
            Kind::Systemd => fs::read_to_string(systemd_unit_path()).ok().and_then(|c| definition_bin_path(ServiceKind::Systemd, &c)),
            Kind::ShellHook => fs::read_to_string(bootstrap_path()).ok().and_then(|c| bootstrap_bin_path(&c)),
            Kind::TaskScheduler => {
                // The program of the task's first action, from the scheduler's COM service.
                let r = spawn_sync("powershell", &["-NoProfile", "-NonInteractive", "-Command", WIN_TASK_BINARY_PS]);
                let out = r.stdout.trim();
                if !r.ok() || out.is_empty() {
                    return None;
                }
                Some(out.to_string())
            }
            Kind::None => None,
        }
    }
}

/// What `slot_binary` asks Task Scheduler (src/daemon.ts WIN_TASK_BINARY_PS).
const WIN_TASK_BINARY_PS: &str = "$ErrorActionPreference='SilentlyContinue'; $svc = New-Object -ComObject Schedule.Service; $svc.Connect(); $t = $svc.GetFolder('\\').GetTask('hx-vision'); if ($t) { ($t.Definition.Actions | Select-Object -First 1).Path }";

/// The client a binary path belongs to: "hx2" for `hx2`, `hx2.exe` or
/// `hx2-svc.exe`, "hx" for `hx`, `hx.exe` or `hx-svc.exe`, else None.
pub fn client_of_binary(path: &str) -> Option<&'static str> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    let stem = stem.strip_suffix("-svc").unwrap_or(stem);
    match stem {
        "hx2" => Some("hx2"),
        "hx" => Some("hx"),
        _ => None,
    }
}

/// The other client's binary when the service slot's definition runs it,
/// else None (src/daemon.ts `slotRunsHx2`, seen from this client's side).
pub fn slot_other_binary(ops: &DaemonOps) -> Option<String> {
    let bin = ops.slot_binary()?;
    let client = client_of_binary(&bin)?;
    let mine = client_of_binary(crate::bin_name()).unwrap_or("hx2");
    if client != mine {
        Some(bin)
    } else {
        None
    }
}

/// The other client when the service slot's definition runs it, else None.
/// Only `start` (and `connect`, which is how a device joins hx2) moves such a
/// slot; every other command leaves it alone and says so, as hx 77.13.0 does
/// for a slot that runs hx2.
pub fn slot_runs_other_client(ops: &DaemonOps) -> Option<&'static str> {
    slot_other_binary(ops).and_then(|b| client_of_binary(&b))
}

/// The binary path inside a bootstrap.sh: the `[ -x '<bin>' ] || return` line.
fn bootstrap_bin_path(content: &str) -> Option<String> {
    for line in content.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("[ -x ") {
            let end = rest.find(" ] || return")?;
            return Some(unshquote(&rest[..end]));
        }
    }
    None
}

/// Undo `shquote`.
fn unshquote(s: &str) -> String {
    let inner = s.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')).unwrap_or(s);
    inner.replace("'\\''", "'")
}

// ── Templates ───────────────────────────────────────────────────────────────

/// The LaunchAgent plist (src/daemon.ts renderPlist).
pub fn render_plist(bin_path: &str, logs: &LogPaths) -> String {
    let env_block = format!("      <key>PATH</key><string>{}</string>", escape_xml("/usr/local/bin:/usr/bin:/bin"));
    let mut s = String::new();
    s.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    s.push_str("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n");
    s.push_str(&format!("<!-- {} -->\n", MANAGED_NOTE));
    s.push_str("<plist version=\"1.0\">\n");
    s.push_str("  <dict>\n");
    s.push_str(&format!("    <key>Label</key><string>{}</string>\n", LAUNCHD_LABEL));
    s.push_str("    <key>ProgramArguments</key>\n");
    s.push_str("    <array>\n");
    s.push_str(&format!("      <string>{}</string>\n", escape_xml(bin_path)));
    s.push_str("      <string>watch</string>\n");
    s.push_str("    </array>\n");
    s.push_str("    <key>RunAtLoad</key><true/>\n");
    s.push_str("    <key>KeepAlive</key>\n");
    s.push_str("    <dict>\n");
    s.push_str("      <key>SuccessfulExit</key><false/>\n");
    s.push_str("    </dict>\n");
    s.push_str(&format!("    <key>ThrottleInterval</key><integer>{}</integer>\n", RESPAWN_DELAY_SEC));
    s.push_str(&format!("    <key>ExitTimeOut</key><integer>{}</integer>\n", STOP_GRACE_SECONDS));
    s.push_str("    <key>ProcessType</key><string>Background</string>\n");
    s.push_str("    <key>LowPriorityBackgroundIO</key><true/>\n");
    s.push_str(&format!("    <key>Nice</key><integer>{}</integer>\n", SERVICE_NICE));
    s.push_str(&format!("    <key>StandardOutPath</key><string>{}</string>\n", escape_xml(&logs.stdout)));
    s.push_str(&format!("    <key>StandardErrorPath</key><string>{}</string>\n", escape_xml(&logs.stderr)));
    s.push_str("    <key>EnvironmentVariables</key>\n");
    s.push_str("    <dict>\n");
    s.push_str(&env_block);
    s.push('\n');
    s.push_str("    </dict>\n");
    s.push_str("  </dict>\n");
    s.push_str("</plist>\n");
    s
}

/// The systemd --user unit (src/daemon.ts renderSystemdUnit).
pub fn render_systemd_unit(bin_path: &str, logs: &LogPaths) -> String {
    let mut s = String::new();
    s.push_str(&format!("# {}\n", MANAGED_NOTE));
    s.push_str(&format!("# To override a setting, use a drop-in: systemctl --user edit {}\n", SYSTEMD_UNIT_NAME));
    s.push_str("[Unit]\n");
    s.push_str("Description=hx-vision session mirror\n");
    s.push_str("After=network-online.target\n");
    s.push_str(&format!("StartLimitIntervalSec={}\n", START_LIMIT_INTERVAL_SEC));
    s.push_str(&format!("StartLimitBurst={}\n", START_LIMIT_BURST));
    s.push('\n');
    s.push_str("[Service]\n");
    s.push_str("Type=simple\n");
    s.push_str(&format!("ExecStart={} watch\n", bin_path));
    s.push_str("Restart=always\n");
    s.push_str(&format!("RestartSec={}\n", RESPAWN_DELAY_SEC));
    s.push_str(&format!("TimeoutStopSec={}\n", STOP_GRACE_SECONDS));
    s.push_str(&format!("Nice={}\n", SERVICE_NICE));
    s.push_str("IOSchedulingClass=idle\n");
    s.push_str("CPUWeight=20\n");
    s.push_str(&format!("MemoryHigh={}\n", MEMORY_HIGH));
    s.push_str(&format!("MemoryMax={}\n", MEMORY_MAX));
    s.push_str(&format!("MemorySwapMax={}\n", MEMORY_SWAP_MAX));
    s.push_str(&format!("StandardOutput=append:{}\n", logs.stdout));
    s.push_str(&format!("StandardError=append:{}\n", logs.stderr));
    s.push('\n');
    s.push_str("[Install]\n");
    s.push_str("WantedBy=default.target\n");
    s
}

// ── Keeping the installed definition current ────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ServiceKind {
    Launchd,
    Systemd,
}

/// The service manager that started this process as hx's service.
pub fn service_manager_of() -> Option<ServiceKind> {
    if cfg!(target_os = "macos") {
        // launchd sets XPC_SERVICE_NAME to the job's label for every process it spawns.
        return if std::env::var("XPC_SERVICE_NAME").ok().as_deref() == Some(LAUNCHD_LABEL) { Some(ServiceKind::Launchd) } else { None };
    }
    if cfg!(target_os = "linux") {
        let cgroup = fs::read_to_string("/proc/self/cgroup").ok()?;
        let suffix = format!("/{}", SYSTEMD_UNIT_NAME);
        return if cgroup.split('\n').any(|l| l.trim_end().ends_with(&suffix)) { Some(ServiceKind::Systemd) } else { None };
    }
    None
}

/// `definitionBinPath`: the binary an installed definition runs.
pub fn definition_bin_path(kind: ServiceKind, content: &str) -> Option<String> {
    match kind {
        ServiceKind::Launchd => {
            // <key>ProgramArguments</key>\s*<array>\s*<string>([^<]*)</string>
            let i = content.find("<key>ProgramArguments</key>")?;
            let rest = content[i + "<key>ProgramArguments</key>".len()..].trim_start_matches(|c: char| c.is_whitespace());
            let rest = rest.strip_prefix("<array>")?.trim_start_matches(|c: char| c.is_whitespace());
            let rest = rest.strip_prefix("<string>")?;
            let end = rest.find('<')?;
            if !rest[end..].starts_with("</string>") {
                return None;
            }
            Some(unescape_xml(&rest[..end]))
        }
        ServiceKind::Systemd => {
            // ^ExecStart=(.+) watch$ (multiline)
            for line in content.split('\n') {
                if let Some(rest) = line.strip_prefix("ExecStart=") {
                    if let Some(bin) = rest.strip_suffix(" watch") {
                        if !bin.is_empty() {
                            return Some(bin.to_string());
                        }
                    }
                }
            }
            None
        }
    }
}

pub enum DefinitionPlan {
    Current,
    Rewrite(String),
    Skip(String),
}

/// `planDefinitionUpdate`.
pub fn plan_definition_update(kind: ServiceKind, installed: &str, running_bin: &str, logs: &LogPaths) -> DefinitionPlan {
    let bin = match definition_bin_path(kind, installed) {
        Some(b) => b,
        None => return DefinitionPlan::Skip("no binary path found in it".to_string()),
    };
    if !same_file(&bin, running_bin) {
        return DefinitionPlan::Skip(format!("it runs {}, not this binary ({})", bin, running_bin));
    }
    // Render with the path exactly as the definition spells it.
    let next = match kind {
        ServiceKind::Launchd => render_plist(&bin, logs),
        ServiceKind::Systemd => render_systemd_unit(&bin, logs),
    };
    if next == installed {
        DefinitionPlan::Current
    } else {
        DefinitionPlan::Rewrite(next)
    }
}

/// Same file on disk, following symlinks; falls back to comparing the paths.
fn same_file(a: &str, b: &str) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

const RELOAD_RETRY_MS: f64 = 60.0 * 60_000.0;

fn reload_marker_path() -> PathBuf {
    hx_dir().join("service-reload.json")
}

/// True when the marker records a reload to exactly `next` less than an hour ago.
pub fn reloaded_recently(marker: Option<&str>, next: &str, now_ms: f64) -> bool {
    let m = match marker.and_then(|t| crate::json::Json::parse(t).ok()) {
        Some(m) => m,
        None => return false,
    };
    let sha = crate::crypto::sha256_hex(next.as_bytes());
    let same = m.get_string("sha256").as_deref() == Some(sha.as_str());
    match m.get("at") {
        Some(crate::json::Json::Num(at)) => same && now_ms >= *at && now_ms - at < RELOAD_RETRY_MS,
        _ => false,
    }
}

/// The process's own binary, as `process.execPath` names it: absolute, with
/// symlinks resolved (what /proc/self/exe reads on Linux).
pub fn exec_path() -> String {
    match std::env::current_exe() {
        Ok(p) => fs::canonicalize(&p).unwrap_or(p).to_string_lossy().into_owned(),
        Err(_) => std::env::args().next().unwrap_or_default(),
    }
}

#[derive(PartialEq)]
pub enum Reconcile {
    Current,
    Reloading,
    Skipped,
}

/// `reconcileServiceDefinition`: bring the installed definition up to this
/// binary's template and have the service manager load it.
pub fn reconcile_service_definition(log: &dyn Fn(&str)) -> Reconcile {
    let kind = match service_manager_of() {
        Some(k) => k,
        None => return Reconcile::Skipped,
    };
    let path = match kind {
        ServiceKind::Launchd => launchd_plist_path(),
        ServiceKind::Systemd => systemd_unit_path(),
    };
    let installed = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Reconcile::Skipped,
    };
    let path_s = p(&path);
    let next = match plan_definition_update(kind, &installed, &exec_path(), &daemon_logs()) {
        DefinitionPlan::Current => return Reconcile::Current,
        DefinitionPlan::Skip(reason) => {
            log(&format!("[hx] left the service definition {} as it is: {}", path_s, reason));
            return Reconcile::Skipped;
        }
        DefinitionPlan::Rewrite(next) => next,
    };
    let marker = fs::read_to_string(reload_marker_path()).ok();
    if reloaded_recently(marker.as_deref(), &next, crate::fsutil::now_ms()) {
        log(&format!("[hx] the service definition {} changed back after a reload less than an hour ago; not reloading again yet", path_s));
        return Reconcile::Skipped;
    }
    let attempt = || -> Result<(), String> {
        write_text(&path, &next)?;
        let marker = crate::json::obj(vec![
            ("sha256", crate::json::Json::str(&crate::crypto::sha256_hex(next.as_bytes()))),
            ("at", crate::json::Json::num(crate::fsutil::now_ms())),
        ]);
        write_mode_0600(&reload_marker_path(), marker.stringify().as_bytes())?;
        log(&format!("[hx] updated the service definition {} to this version; reloading the service", path_s));
        match kind {
            ServiceKind::Launchd => reload_launchd_from_job(),
            ServiceKind::Systemd => reload_systemd_from_unit(),
        }
    };
    match attempt() {
        Ok(()) => Reconcile::Reloading,
        Err(e) => {
            log(&format!("[hx] could not update the service definition {}: {}", path_s, e));
            Reconcile::Skipped
        }
    }
}

/// `writeFile(path, text, { mode: 0o600 })`: the mode applies when the file is created.
fn write_mode_0600(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path).map_err(|e| crate::fsutil::node_error(&e, "open", path))?;
    std::io::Write::write_all(&mut f, bytes).map_err(|e| crate::fsutil::node_error(&e, "write", path))
}

/// Reload the LaunchAgent from inside its own job: `<this binary> restart` in
/// its own session, which outlives the bootout, writing to the daemon's own
/// log descriptors.
fn reload_launchd_from_job() -> Result<(), String> {
    let mut cmd = Command::new(exec_path());
    cmd.arg("restart").stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid in the child between fork and exec, as
        // spawn({ detached: true }) does.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    let child = cmd.spawn().map_err(|e| launch_error(&exec_path(), &e))?;
    // Reap it whenever it ends; this process is about to be stopped anyway.
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
}

/// Reload the systemd unit from inside it: daemon-reload, then a queued
/// restart the manager performs itself.
fn reload_systemd_from_unit() -> Result<(), String> {
    run_or_throw("systemctl", &["--user", "daemon-reload"])?;
    let r = spawn_sync("systemctl", &["--user", "--no-block", "restart", SYSTEMD_UNIT_NAME]);
    // A death by signal (the stop reaching systemctl in this cgroup) is not a failure.
    if r.error.is_some() || (r.code.is_some() && r.code != Some(0)) {
        return Err(format!("systemctl --user --no-block restart {} failed: {}", SYSTEMD_UNIT_NAME, failure_detail(&r)));
    }
    Ok(())
}

/// How long a daemon that asked its service manager to reload it waits.
pub const SERVICE_RELOAD_WAIT_MS: u64 = 20_000;

#[cfg(test)]
mod tests {
    use super::*;

    /// The definitions are byte-identical to the TypeScript client's: the
    /// expected text is the client's own snapshot file.
    fn snapshot(name: &str) -> String {
        let snap = include_str!("../../src/__snapshots__/daemon.test.ts.snap");
        let head = format!("exports[`{}`] = `\n\"", name);
        let start = snap.find(&head).expect("snapshot present") + head.len();
        let end = snap[start..].find("\"\n`;").expect("snapshot end") + start;
        snap[start..end].replace("\\\\", "\\")
    }

    #[test]
    fn plist_matches_the_typescript_snapshot() {
        let logs = LogPaths { stdout: "/Users/me/.let/hx/stdout.log".to_string(), stderr: "/Users/me/.let/hx/stderr.log".to_string() };
        assert_eq!(render_plist("/Users/me/.let/bin/hx", &logs), snapshot("launchd: plist matches the snapshot 1"));
    }

    #[test]
    fn systemd_unit_matches_the_typescript_snapshot() {
        let logs = LogPaths { stdout: "/home/me/.let/hx/stdout.log".to_string(), stderr: "/home/me/.let/hx/stderr.log".to_string() };
        assert_eq!(render_systemd_unit("/home/me/.let/bin/hx", &logs), snapshot("systemd: unit matches the snapshot 1"));
    }

    #[test]
    fn task_xml_matches_the_typescript_snapshot() {
        assert_eq!(render_task_xml("C:\\Users\\me\\.let\\bin\\hx-svc.exe", "CORP\\me"), snapshot("windows: background priority matches the snapshot 1"));
    }

    /// Against the TypeScript client's own renderings for the same binary,
    /// under the same HOME (harness/run/service-defs.ts; the CI build job
    /// sets HX2_TS_SERVICE_DEFS). Skipped without it.
    #[test]
    fn definitions_match_the_typescript_client() {
        let dir = match std::env::var("HX2_TS_SERVICE_DEFS") {
            Ok(d) => PathBuf::from(d),
            Err(_) => return,
        };
        let read = |n: &str| fs::read_to_string(dir.join(n)).unwrap_or_else(|_| panic!("{} rendered by the TypeScript client", n));
        let bin = "/home/me/.let/bin/hx2";
        assert_eq!(render_plist(bin, &daemon_logs()), read("plist"));
        assert_eq!(render_systemd_unit(bin, &daemon_logs()), read("unit"));
        assert_eq!(render_bootstrap(bin), read("bootstrap"));
        assert_eq!(render_task_xml("C:\\Users\\me\\.let\\bin\\hx2-svc.exe", "CORP\\me"), read("task"));
    }

    #[test]
    fn definition_paths_round_trip() {
        let logs = LogPaths { stdout: "/o".to_string(), stderr: "/e".to_string() };
        assert_eq!(definition_bin_path(ServiceKind::Launchd, &render_plist("/a & b/hx2", &logs)).as_deref(), Some("/a & b/hx2"));
        assert_eq!(definition_bin_path(ServiceKind::Systemd, &render_systemd_unit("/x/hx2", &logs)).as_deref(), Some("/x/hx2"));
        assert_eq!(bootstrap_bin_path(&render_bootstrap("/it's/hx2")).as_deref(), Some("/it's/hx2"));
    }

    #[test]
    fn clients_by_binary_name() {
        assert_eq!(client_of_binary("/Users/me/.let/bin/hx2"), Some("hx2"));
        assert_eq!(client_of_binary("C:\\Users\\me\\.let\\bin\\hx-svc.exe"), Some("hx"));
        assert_eq!(client_of_binary("/usr/local/bin/hx"), Some("hx"));
        assert_eq!(client_of_binary("/opt/other"), None);
    }

    #[test]
    fn hook_block_round_trip() {
        let wired = insert_hook_block("export A=1\n");
        assert!(wired.contains(HOOK_BEGIN));
        assert_eq!(insert_hook_block(&wired), wired);
        assert_eq!(strip_hook_block(&wired), "export A=1\n\n");
    }

    #[test]
    fn transient_bootstrap_errors() {
        assert!(transient_bootstrap("Bootstrap failed: 5: Input/output error"));
        assert!(transient_bootstrap("Bootstrap failed: 37: Operation already in progress"));
        assert!(!transient_bootstrap("Bootstrap failed: 119: Service is disabled"));
        assert!(!transient_bootstrap("Bootstrap failed: 50"));
    }
}
