//! Pairing and unpairing (src/connect.ts and cli.ts): `hx connect` and its
//! `--local` tee, the device-code flow (`/devices/code`, `/devices/poll`),
//! the pairing-code card, the device id, `hx disconnect`, and the start or
//! restart of the background service a connect ends with.

use std::fs;
use std::io::{BufRead, Write};

use crate::commands::{effective_roots_for_cli, ensure_config, flag, has_flag};
use crate::config::{local_config_path, read_config, read_config_raw, read_local_config, write_config_json, write_local_config_json, HxConfig};
use crate::daemon_state::{get_daemon_ops, DaemonOps, DaemonState};
use crate::home::hx_dir;
use crate::js::lossy;
use crate::json::{obj, Json};
use crate::logger::say;
use crate::net::{assert_secure_fetch_url, request, Gateway};
use crate::report::compute_sync_snapshot;
use crate::service::{exec_path, slot_runs_other_client, Consent};
use crate::settings::{is_paused, read_settings};
use crate::state::Store;

/// The single-origin dev gateway that `pnpm dev` mounts at localhost:9000.
pub const LOCAL_GATEWAY_URL: &str = "http://localhost:9000/workbench/_api/hx-gateway";

/// How long a best-effort disconnect waits on the gateway.
const DISCONNECT_TIMEOUT_MS: u64 = 8000;

/// fetch has no deadline of its own; the pairing calls get a generous one.
const PAIRING_TIMEOUT_MS: u64 = 300_000;

// ── The machine ─────────────────────────────────────────────────────────────

/// `os.hostname()`.
pub fn os_hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: gethostname writes at most buf.len() bytes into buf.
        let r = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if r == 0 {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            return String::from_utf8_lossy(&buf[..end]).into_owned();
        }
        String::new()
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
}

/// `os.userInfo().username`.
pub fn os_username() -> String {
    #[cfg(unix)]
    {
        // SAFETY: getpwuid returns static storage; the name is copied out.
        unsafe {
            let pw = libc::getpwuid(libc::getuid());
            if !pw.is_null() && !(*pw).pw_name.is_null() {
                return std::ffi::CStr::from_ptr((*pw).pw_name).to_string_lossy().into_owned();
            }
        }
        std::env::var("USER").unwrap_or_default()
    }
    #[cfg(not(unix))]
    {
        std::env::var("USERNAME").unwrap_or_default()
    }
}

/// Node's `os.arch()` for this build.
pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "arm" => "arm",
        other => other,
    }
}

#[cfg(unix)]
fn fd_is_tty(fd: i32) -> bool {
    // SAFETY: isatty only inspects the descriptor.
    unsafe { libc::isatty(fd) == 1 }
}

#[cfg(not(unix))]
fn fd_is_tty(_fd: i32) -> bool {
    false
}

pub fn stdout_is_tty() -> bool {
    fd_is_tty(1)
}

pub fn stderr_is_tty() -> bool {
    fd_is_tty(2)
}

pub fn stdin_is_tty() -> bool {
    fd_is_tty(0)
}

/// `/utf-?8/i.test(LC_ALL ?? LC_CTYPE ?? LANG ?? "")`: the first defined variable decides.
pub fn is_utf8_locale() -> bool {
    let v = std::env::var("LC_ALL").ok().or_else(|| std::env::var("LC_CTYPE").ok()).or_else(|| std::env::var("LANG").ok()).unwrap_or_default().to_lowercase();
    v.contains("utf8") || v.contains("utf-8")
}

// ── The device id ───────────────────────────────────────────────────────────

/// `ensureDeviceId`: the stable per-machine id, generated once (device-id
/// survives `hx disconnect`; only `hx uninstall --purge` removes it).
pub fn ensure_device_id() -> Result<String, String> {
    let path = hx_dir().join("device-id");
    if path.exists() {
        if let Ok(existing) = fs::read_to_string(&path) {
            let t = existing.trim();
            if !t.is_empty() {
                return Ok(t.to_string());
            }
        }
    }
    let id = crate::crypto::random_uuid();
    fs::create_dir_all(hx_dir()).map_err(|e| crate::fsutil::node_error(&e, "mkdir", hx_dir()))?;
    crate::fsutil::write_atomic_0600_node(&path, id.as_bytes())?;
    Ok(id)
}

// ── Browser ─────────────────────────────────────────────────────────────────

fn is_wsl() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    fs::read_to_string("/proc/version").map(|v| v.to_lowercase().contains("microsoft")).unwrap_or(false)
}

/// `Bun.which(cmd) !== null`: an executable of that name on PATH.
fn has_command(cmd: &str) -> bool {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(cmd);
        match fs::metadata(&candidate) {
            Ok(m) if m.is_file() => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    m.permissions().mode() & 0o111 != 0
                }
                #[cfg(not(unix))]
                {
                    true
                }
            }
            _ => false,
        }
    })
}

/// `browserCommandFor`.
fn browser_command() -> &'static str {
    if cfg!(target_os = "macos") {
        return "open";
    }
    if cfg!(windows) {
        return "explorer";
    }
    let wsl = is_wsl();
    if wsl && has_command("wslview") {
        return "wslview";
    }
    if wsl {
        return "explorer.exe";
    }
    "xdg-open"
}

/// `openBrowser`: best-effort, http(s) only, the URL as one argument.
pub fn open_browser(url: &str) {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return;
    }
    let mut cmd = std::process::Command::new(browser_command());
    cmd.arg(url).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid between fork and exec, as spawn({ detached: true }) does.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    if let Ok(child) = cmd.spawn() {
        std::thread::spawn(move || {
            let mut child = child;
            let _ = child.wait();
        });
    }
}

// ── The pairing-code card ───────────────────────────────────────────────────

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn pad_end(s: &str, w: usize) -> String {
    let l = utf16_len(s);
    if l >= w {
        s.to_string()
    } else {
        format!("{}{}", s, " ".repeat(w - l))
    }
}

/// `renderPairingCard`: the boxed card the installer lifts the code out of.
pub fn render_pairing_card(user_code: &str, approve_host: &str, tty: bool, utf8: bool) -> Vec<String> {
    let dim = if tty { "\x1b[2m" } else { "" };
    let acc = if tty { "\x1b[1m\x1b[38;5;39m" } else { "" };
    let rst = if tty { "\x1b[0m" } else { "" };
    let (tl, tr, bl, br, hr, vr) = if utf8 { ("╭", "╮", "╰", "╯", "─", "│") } else { ("+", "+", "+", "+", "-", "|") };
    let rows = [("Pairing code", user_code, true), ("Workbench", approve_host, false)];
    let label_w = rows.iter().map(|r| utf16_len(r.0)).max().unwrap_or(0);
    let value_w = rows.iter().map(|r| utf16_len(r.1)).max().unwrap_or(0);
    let inner = 3 + label_w + 3 + value_w + 3;
    let edge = |l: &str, r: &str| format!("  {}{}{}{}{}", dim, l, hr.repeat(inner), r, rst);
    let gap = format!("  {}{}{}{}{}{}{}", dim, vr, rst, " ".repeat(inner), dim, vr, rst);
    let mut out = vec![edge(tl, tr), gap.clone()];
    for (label, value, accent) in rows {
        let v = if accent { format!("{}{}{}", acc, pad_end(value, value_w), rst) } else { pad_end(value, value_w) };
        out.push(format!("  {}{}{}   {}{}{}   {}   {}{}{}", dim, vr, rst, dim, pad_end(label, label_w), rst, v, dim, vr, rst));
    }
    out.push(gap);
    out.push(edge(bl, br));
    out
}

/// `new URL(url).host`: the authority without userinfo, lowercased, the
/// scheme's default port dropped; the input itself when it is not a URL.
pub fn host_of(url: &str) -> String {
    let (scheme, rest) = match url.split_once("://") {
        Some(x) => x,
        None => return url.to_string(),
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = rest[..end].rsplit('@').next().unwrap_or("").to_lowercase();
    if authority.is_empty() {
        return url.to_string();
    }
    let default_port = match scheme.to_lowercase().as_str() {
        "https" => ":443",
        "http" => ":80",
        _ => "",
    };
    if !default_port.is_empty() && authority.ends_with(default_port) && !authority.ends_with("]") {
        return authority[..authority.len() - default_port.len()].to_string();
    }
    authority
}

// ── The device-code flow ────────────────────────────────────────────────────

/// A JSON value as a template literal would print it (`${v}`).
fn js_text(v: Option<&Json>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(x) => lossy(&x.to_js_string()),
    }
}

/// `connect()`: ask for a device code, show the card, open the approve page,
/// poll until approved, save the connection.
pub fn run_device_code_flow(name: &str, gateway_base_url: &str, device_name_flag: Option<String>, local: bool) -> Result<(), String> {
    let device_name = device_name_flag.unwrap_or_else(|| format!("{} ({})", os_hostname(), os_username()));
    let device_id = ensure_device_id()?;
    assert_secure_fetch_url(gateway_base_url, &format!("{} connect", name)).map_err(|e| e.message())?;
    let body = obj(vec![
        ("deviceName", Json::str(&device_name)),
        ("deviceId", Json::str(&device_id)),
        ("os", Json::str(crate::daemon_state::node_platform())),
        ("arch", Json::str(node_arch())),
    ]);
    let headers = vec![("content-type", "application/json".to_string())];
    let code_res = request("device-code", "POST", &format!("{}/devices/code", gateway_base_url), &headers, Some(body.stringify().as_bytes()), PAIRING_TIMEOUT_MS)
        .map_err(|e| e.message())?;
    if !code_res.ok() {
        return Err(format!("device-code request failed: {} {}", code_res.status, code_res.text()));
    }
    let code = Json::parse(&code_res.text()).map_err(|_| "JSON Parse error: Unrecognized token".to_string())?;
    let tty = stdout_is_tty();
    let utf8 = is_utf8_locale();
    let user_code = js_text(code.get("userCode"));
    let complete = js_text(code.get("verificationUriComplete"));
    say("");
    say("  Opening your browser to approve this device…");
    say("");
    for line in render_pairing_card(&user_code, &host_of(&complete), tty, utf8) {
        say(&line);
    }
    say("");
    say("  Check the code matches what your browser shows, then approve there.");
    say("");
    say("  Browser didn't open? Visit:");
    say(&format!("    {}", complete));
    say("");
    say("  Waiting for approval… (Ctrl+C to cancel)");

    open_browser(&complete);

    let expires_in = code.get_f64("expiresIn").unwrap_or(f64::NAN);
    let interval = code.get_f64("interval").unwrap_or(f64::NAN);
    let deadline = crate::fsutil::now_ms() + expires_in * 1000.0;
    let device_code = code.get("deviceCode").cloned().unwrap_or(Json::Null);
    let poll_body = {
        let mut b = Json::obj();
        // `{ deviceCode: code.deviceCode }`: an absent field is dropped by JSON.stringify.
        if code.get("deviceCode").is_some() {
            b.set("deviceCode", device_code);
        }
        b.stringify()
    };
    while crate::fsutil::now_ms() < deadline {
        let wait = interval * 1000.0;
        if wait.is_finite() && wait > 0.0 {
            std::thread::sleep(std::time::Duration::from_millis(wait as u64));
        }
        let poll = request("device-poll", "POST", &format!("{}/devices/poll", gateway_base_url), &headers, Some(poll_body.as_bytes()), PAIRING_TIMEOUT_MS)
            .map_err(|e| e.message())?;
        if poll.status == 410 {
            return Err("device code expired before approval".to_string());
        }
        if poll.status == 202 {
            continue;
        }
        if !poll.ok() {
            return Err(format!("poll failed: {} {}", poll.status, poll.text()));
        }
        let data = Json::parse(&poll.text()).map_err(|_| "JSON Parse error: Unrecognized token".to_string())?;
        if data.get_string("status").as_deref() == Some("approved") {
            let final_name = match data.get("deviceName").and_then(|v| v.as_str()) {
                Some(s) if !crate::js::trim(s).is_empty() => lossy(crate::js::trim(s)),
                _ => device_name.clone(),
            };
            let mut cfg = Json::obj();
            cfg.set("gatewayBaseUrl", Json::str(gateway_base_url));
            if let Some(t) = data.get("accessToken") {
                cfg.set("accessToken", t.clone());
            }
            if let Some(u) = data.get("userId") {
                cfg.set("userId", u.clone());
            }
            cfg.set("deviceName", Json::str(&final_name));
            if local {
                write_local_config_json(&cfg)?;
            } else {
                write_config_json(&cfg)?;
            }
            let grn = if tty { "\x1b[32m" } else { "" };
            let rst = if tty { "\x1b[0m" } else { "" };
            let mark = if utf8 { "✓ " } else { "" };
            say("");
            say(&format!("  {}{}Connected as \"{}\".{}", grn, mark, final_name, rst));
            return Ok(());
        }
    }
    Err("connect timed out".to_string())
}

// ── The service a connect starts ────────────────────────────────────────────

/// `resolveDotfileConsent`: only the container shell hook edits dotfiles,
/// and it asks first.
pub fn resolve_dotfile_consent(ops: &DaemonOps, args: &[String]) -> Consent {
    if !ops.needs_dotfile_consent() {
        return Consent::Granted;
    }
    if ops.dotfiles_wired() {
        return Consent::Granted;
    }
    if has_flag(args, "yes") || args.iter().any(|a| a == "-y") {
        return Consent::Granted;
    }
    if !stdin_is_tty() {
        return Consent::Denied;
    }
    let name = crate::bin_name();
    say("");
    say(&format!("To keep running after this container restarts, {} adds one line to", name));
    say("~/.bashrc and ~/.profile so it relaunches whenever a bash shell starts.");
    print!("Allow {} to edit those files? [Y/n] ", name);
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    let _ = std::io::stdin().lock().read_line(&mut answer);
    let ans = answer.trim().to_lowercase();
    if ans.is_empty() || ans == "y" || ans == "yes" {
        Consent::Granted
    } else {
        Consent::Denied
    }
}

/// `reportStarted`.
pub fn report_started(ops: &DaemonOps, ds: &DaemonState, consent: Consent) {
    let name = crate::bin_name();
    let pid = match ds.pid {
        Some(p) if p != 0 => format!(", pid {}", p),
        _ => String::new(),
    };
    say(&format!("{} started ({}{}).", name, ops.manager_name, pid));
    if ops.needs_dotfile_consent() && consent == Consent::Denied {
        say("");
        say(&format!("{} is running now, but WON'T restart with the container. To persist it,", name));
        say("add this line to ~/.bashrc and ~/.profile:");
        say("  [ -f \"$HOME/.let/hx/bootstrap.sh\" ] && . \"$HOME/.let/hx/bootstrap.sh\"");
        say(&format!("or re-run `{} start` and allow the edit.", name));
    }
}

/// `autoStartDaemon`: bring up, or kick, the background mirror after a connect.
///
/// hx2 differs from the TypeScript client in one place, decided by the HX2
/// program for the shared service slot: when the slot's definition runs hx,
/// a connect moves it to hx2 (installs this binary's definition), which is
/// how a device joins hx2 (`install-hx2.sh` ends with `hx2 connect`). An
/// hx-only device never reaches that branch.
pub fn auto_start_daemon(args: &[String], token_refreshed: bool) {
    let name = crate::bin_name();
    let bin_path = exec_path();
    let attempt = || -> Result<(), String> {
        let ops = get_daemon_ops();
        let before = ops.state();
        let other = if before.loaded { slot_runs_other_client(&ops) } else { None };
        if !before.loaded || other.is_some() {
            let consent = resolve_dotfile_consent(&ops, args);
            if other.is_some() {
                // Moving the slot: stop the other client first. A container's
                // install alone leaves a supervisor that is already running.
                ops.stop()?;
            }
            ops.install(&bin_path, consent)?;
            let after = ops.state();
            report_started(&ops, &after, consent);
            say(&format!("  status: {} status   logs: {} logs   stop: {} stop", name, name, name));
            return Ok(());
        }
        let settings = read_settings();
        let store = Store::load("main");
        let (roots, _) = effective_roots_for_cli(&store, &settings);
        let snap = compute_sync_snapshot(&store, None, Some(&roots));
        let behind = !is_paused(&settings, crate::fsutil::now_ms()) && snap.done < snap.total;
        let remaining = snap.total.saturating_sub(snap.done);
        if token_refreshed || behind {
            let consent = resolve_dotfile_consent(&ops, args);
            ops.restart(&bin_path, consent)?;
            if behind {
                say(&format!("{} restarted ({}) — resuming sync ({} session{} left).", name, ops.manager_name, remaining, if remaining == 1 { "" } else { "s" }));
            } else {
                say(&format!("{} restarted ({}).", name, ops.manager_name));
            }
        } else {
            say(&format!("{} is running ({}) — sync up to date.", name, ops.manager_name));
        }
        Ok(())
    };
    if let Err(msg) = attempt() {
        say("");
        say("note: could not (re)start the background service:");
        say(&format!("  {}", msg));
        say(&format!("fix that and run `{} start`, or run `{} watch` to mirror in this terminal.", name, name));
    }
}

// ── The commands ────────────────────────────────────────────────────────────

/// `requireGatewayUrl`: `--local`, else the saved gateway, else exit 2.
pub fn require_gateway_url(name: &str, args: &[String]) -> String {
    if has_flag(args, "local") {
        return LOCAL_GATEWAY_URL.to_string();
    }
    match read_config() {
        Some(c) if !c.gateway_base_url.is_empty() => c.gateway_base_url,
        _ => {
            say(&format!("No gateway configured. Reinstall {} from your let.ai workbench,", name));
            say("or pass --local to use the local dev gateway.");
            std::process::exit(2);
        }
    }
}

fn gateway_for(cfg: &HxConfig) -> Gateway {
    Gateway { base_url: cfg.gateway_base_url.clone(), token: cfg.access_token.clone().unwrap_or_else(|| "undefined".to_string()) }
}

/// `{...existing, deviceName, email}`: a key whose value is undefined drops
/// out, as JSON.stringify drops it.
fn set_or_drop(raw: &mut Json, key: &str, value: Option<&str>) {
    match value {
        Some(v) => raw.set(key, Json::str(v)),
        None => raw.remove(key),
    }
}

/// `hx connect [--no-start] [--device-name <name>] [--local]`.
pub fn cmd_connect(name: &str, args: &[String]) -> Result<i32, String> {
    if has_flag(args, "local") {
        return cmd_connect_local(name, args);
    }
    let gateway_base_url = require_gateway_url(name, args);
    let no_start = args.iter().any(|a| a == "--no-start");
    if let Some(existing) = read_config() {
        if existing.access_token.is_some() && existing.gateway_base_url == gateway_base_url {
            let who = gateway_for(&existing).whoami().map_err(|e| e.message())?;
            if who.ok {
                let raw = read_config_raw().unwrap_or_else(Json::obj);
                let cached_name = raw.get_string("deviceName");
                let cached_email = raw.get_string("email");
                let device_name = who.device_name.clone().or_else(|| cached_name.clone());
                let email = who.email.clone().or_else(|| cached_email.clone());
                if device_name != cached_name || email != cached_email {
                    let mut next = raw.clone();
                    set_or_drop(&mut next, "deviceName", device_name.as_deref());
                    set_or_drop(&mut next, "email", email.as_deref());
                    write_config_json(&next)?;
                }
                say(&format!("This device is already connected as \"{}\".", device_name.as_deref().unwrap_or("undefined")));
                say(&format!("Run `{} disconnect` first if you want to reconnect it.", name));
                if !no_start {
                    auto_start_daemon(args, false);
                }
                return Ok(0);
            }
            if who.unauthorized {
                say("This device's previous connection was revoked — reconnecting.");
            }
        }
    }
    run_device_code_flow(name, &gateway_base_url, flag(args, "device-name"), false)?;
    if no_start {
        return Ok(0);
    }
    auto_start_daemon(args, true);
    Ok(0)
}

/// `hx connect --local`: pair the additive local-dev tee (config.local.json).
fn cmd_connect_local(name: &str, args: &[String]) -> Result<i32, String> {
    if let Some(existing) = read_local_config() {
        if existing.access_token.is_some() {
            let who = gateway_for(&existing).whoami().map_err(|e| e.message())?;
            if who.ok {
                let device_name = who.device_name.clone().or_else(|| existing.device_name.clone());
                say(&format!("This device is already connected to the local dev gateway as \"{}\".", device_name.as_deref().unwrap_or("undefined")));
                say(&format!("Run `{} disconnect --local` first if you want to reconnect it.", name));
                return Ok(0);
            }
            if who.unauthorized {
                say("This device's local connection was revoked — reconnecting.");
            }
        }
    }
    let gateway_base_url = match flag(args, "local-port") {
        Some(p) if !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()) => format!("http://localhost:{}/workbench/_api/hx-gateway", p),
        _ => LOCAL_GATEWAY_URL.to_string(),
    };
    run_device_code_flow(name, &gateway_base_url, flag(args, "device-name"), true)?;
    say("");
    say(&format!("Local tee ready: `{} watch --local` and `{} tick --local` now mirror", name, name));
    say(&format!("sessions to {} in addition to the regular gateway.", gateway_base_url));
    Ok(0)
}

/// POST /devices/disconnect with the bearer, bounded, errors swallowed.
fn notify_disconnect(cfg: &HxConfig) {
    let name = crate::bin_name();
    if assert_secure_fetch_url(&cfg.gateway_base_url, &format!("{} disconnect", name)).is_err() {
        return;
    }
    let headers = vec![("authorization", format!("Bearer {}", cfg.access_token.clone().unwrap_or_else(|| "undefined".to_string())))];
    let _ = request("disconnect", "POST", &format!("{}/devices/disconnect", cfg.gateway_base_url), &headers, Some(&[]), DISCONNECT_TIMEOUT_MS);
}

/// `disconnectDevice`: revoke at the gateway (best-effort) and keep only the
/// gateway URL in config.json. False when there was nothing to disconnect.
pub fn disconnect_device() -> Result<bool, String> {
    let cfg = read_config();
    if let Some(c) = &cfg {
        if c.access_token.is_some() {
            notify_disconnect(c);
        }
    }
    let base = match &cfg {
        Some(c) if !c.gateway_base_url.is_empty() => c.gateway_base_url.clone(),
        _ => return Ok(false),
    };
    write_config_json(&obj(vec![("gatewayBaseUrl", Json::str(&base))]))?;
    Ok(true)
}

/// `hx disconnect [--local]`.
pub fn cmd_disconnect(args: &[String]) -> Result<i32, String> {
    if has_flag(args, "local") {
        let cfg = match read_local_config() {
            Some(c) if c.access_token.is_some() => c,
            _ => {
                say("Local tee was not connected.");
                return Ok(0);
            }
        };
        notify_disconnect(&cfg);
        let _ = fs::remove_file(local_config_path());
        say("Local tee disconnected.");
        return Ok(0);
    }
    let disconnected = disconnect_device()?;
    say(if disconnected { "Disconnected." } else { "Was not connected." });
    Ok(0)
}

/// `hx start`: install and run the background service. When the shared slot
/// runs the other client, this is the command that moves the device: the
/// other client is stopped first, so a container's running supervisor is
/// replaced too.
pub fn cmd_start(name: &str, args: &[String]) -> Result<i32, String> {
    ensure_config(name);
    let ops = get_daemon_ops();
    let consent = resolve_dotfile_consent(&ops, args);
    let other = slot_runs_other_client(&ops);
    if other.is_some() {
        ops.stop()?;
    }
    ops.install(&exec_path(), consent)?;
    if let Some(o) = other {
        say(&format!("Moved the background service from {} to {}.", o, name));
    }
    let ds = ops.state();
    report_started(&ops, &ds, consent);
    say(&format!("logs:   {} logs", name));
    say(&format!("status: {} status", name));
    Ok(0)
}

fn forced_stop_note() -> String {
    format!("The daemon did not exit within {} s of SIGTERM, so it was killed with SIGKILL.", crate::service::STOP_GRACE_SECONDS)
}

/// `hx stop`.
pub fn cmd_stop(name: &str) -> Result<i32, String> {
    let ops = get_daemon_ops();
    let other = slot_runs_other_client(&ops);
    let r = ops.stop()?;
    if let Some(o) = other {
        // The slot runs the other client: stopping keeps it there; `start`
        // would move it.
        if r.was_running {
            say(&format!("{} stopped ({}). Run `{} start` to resume it, or `{} start` to move this device to {}.", o, ops.manager_name, o, name, name));
            if r.forced {
                say(&forced_stop_note());
            }
        } else {
            say(&format!("{} is not running — nothing to stop. Run `{} start` to start it, or `{} start` to move this device to {}.", o, o, name, name));
        }
        return Ok(0);
    }
    if r.was_running {
        say(&format!("{} stopped ({}). Run `{} start` to resume.", name, ops.manager_name, name));
        if r.forced {
            say(&forced_stop_note());
        }
    } else {
        say(&format!("{} is not running — nothing to stop. Run `{} start` to start it.", name, name));
    }
    Ok(0)
}

/// `hx restart`: stop, then install. A slot that runs the other client is
/// left alone: `start` is the command that moves a device.
pub fn cmd_restart(name: &str, args: &[String]) -> Result<i32, String> {
    ensure_config(name);
    let ops = get_daemon_ops();
    if let Some(o) = slot_runs_other_client(&ops) {
        say(&format!("{} runs the background service on this device, so {} left it alone.", o, name));
        say(&format!("Run `{} restart` to restart it, or `{} start` to move this device to {}.", o, name, name));
        return Ok(0);
    }
    let consent = resolve_dotfile_consent(&ops, args);
    let r = ops.stop()?;
    ops.install(&exec_path(), consent)?;
    say(&format!("{} restarted ({}).", name, ops.manager_name));
    if r.forced {
        say(&forced_stop_note());
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_card_matches_the_golden() {
        let lines = render_pairing_card("HXAB-CD23", "127.0.0.1:48621", false, true);
        assert_eq!(lines[0], format!("  ╭{}╮", "─".repeat(36)));
        assert_eq!(lines[1], format!("  │{}│", " ".repeat(36)));
        assert_eq!(lines[2], "  │   Pairing code   HXAB-CD23         │");
        assert_eq!(lines[3], "  │   Workbench      127.0.0.1:48621   │");
        assert_eq!(lines[5], format!("  ╰{}╯", "─".repeat(36)));
    }

    #[test]
    fn hosts_of_urls() {
        assert_eq!(host_of("http://127.0.0.1:48621/approve?code=X"), "127.0.0.1:48621");
        assert_eq!(host_of("https://Let.AI:443/x"), "let.ai");
        assert_eq!(host_of("not a url"), "not a url");
    }
}
