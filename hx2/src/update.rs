//! `hx update` (src/update.ts): the newest binary from the gateway's download
//! proxy, its SHA-256 checked, swapped in over this binary's path, and the
//! daemon restarted when it is loaded. hx2 updates from its own channel: the
//! assets named after the binary (`hx2-version`, `hx2-<os>-<arch>.gz` and
//! `.sha256`), so a renamed `hx` binary updates from hx's again.

use std::fs;
use std::io::Read;
use std::path::Path;

use crate::daemon_state::{get_daemon_ops, node_platform};
use crate::json::{obj, Json};
use crate::net::{assert_secure_fetch_url, request_manual, resolve_url, NetError, Response};
use crate::service::{exec_path, Consent};

/// A download or unpack can take a while; this is the per-read deadline.
const DOWNLOAD_TIMEOUT_MS: u64 = 300_000;
const MAX_REDIRECTS: usize = 5;

pub struct UpdateProgress {
    /// "download" | "unpack" | "verify"
    pub phase: &'static str,
    pub pct: f64,
    pub received: Option<u64>,
    pub total: Option<u64>,
}

impl UpdateProgress {
    /// `{ phase, pct, received?, total? }`, the event the UI streams.
    pub fn to_json(&self) -> Json {
        let mut o = obj(vec![("phase", Json::str(self.phase)), ("pct", Json::num(self.pct))]);
        if let Some(r) = self.received {
            o.set("received", Json::num(r as f64));
        }
        if let Some(t) = self.total {
            o.set("total", Json::num(t as f64));
        }
        o
    }
}

pub struct UpdateResult {
    pub asset: String,
    pub sha256: Option<String>,
    pub daemon_restarted: bool,
    pub already_latest: bool,
    pub local_version: String,
    pub remote_version: Option<String>,
}

/// `parseStableSemver`: X.Y.Z after a trim.
fn parse_stable_semver(v: &str) -> Option<(u64, u64, u64)> {
    let t = v.trim();
    let parts: Vec<&str> = t.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    Some((parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?))
}

/// `isRemoteNewer`: a valid remote strictly newer than the local version.
pub fn is_remote_newer(local: &str, remote: Option<&str>) -> bool {
    match (parse_stable_semver(local), remote.and_then(parse_stable_semver)) {
        (Some(l), Some(r)) => r > l,
        _ => false,
    }
}

fn label() -> String {
    format!("{} update", crate::bin_name())
}

/// `secureFetch`: redirects followed by hand, every hop's scheme checked, the
/// client naming itself in its User-Agent.
fn secure_fetch(url: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<Response, String> {
    let mut current = url.to_string();
    let mut hop = 0usize;
    loop {
        assert_secure_fetch_url(&current, &label()).map_err(|e| e.message())?;
        let res = request_manual(&label(), "GET", &current, &[], DOWNLOAD_TIMEOUT_MS, &mut *progress).map_err(|e: NetError| e.message())?;
        let location = if (300..400).contains(&res.status) { res.header("location").map(|l| l.to_string()) } else { None };
        let location = match location {
            Some(l) => l,
            None => return Ok(res),
        };
        if hop >= MAX_REDIRECTS {
            return Err(format!("{}: too many redirects fetching {}", label(), url));
        }
        current = resolve_url(&current, &location);
        hop += 1;
    }
}

fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let res = secure_fetch(url, &mut |_, _| {})?;
    if !res.ok() {
        return Err(format!("GET {} → {} {}", url, res.status, res.status_text));
    }
    Ok(res.body)
}

/// `fetchRemoteVersion`: the release's advertised version, or None on any failure.
fn fetch_remote_version(download_base: &str) -> Option<String> {
    let res = secure_fetch(&format!("{}/{}-version", download_base, crate::bin_name()), &mut |_, _| {}).ok()?;
    if !res.ok() {
        return None;
    }
    let raw = res.text().trim().to_string();
    parse_stable_semver(&raw).map(|_| raw)
}

/// `assertSha`: the decompressed bytes against the sibling `.sha256`.
fn assert_sha(asset: &str, bin: &[u8], sha_text: &str) -> Result<String, String> {
    let expected = sha_text.split_whitespace().next().unwrap_or("").to_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        let excerpt: String = sha_text.chars().take(200).collect();
        return Err(format!("malformed sha256 for {}: {}", asset, excerpt));
    }
    let actual = crate::crypto::sha256_hex(bin);
    if actual != expected {
        return Err(format!("checksum mismatch for {}: expected {}, got {}", asset, expected, actual));
    }
    Ok(actual)
}

/// `gunzipSync`: every member of a gzip stream.
fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    flate2::read::MultiGzDecoder::new(bytes).read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn detect_target() -> Result<String, String> {
    let os = match node_platform() {
        "darwin" => "darwin",
        "linux" => "linux",
        "win32" => "windows",
        other => return Err(format!("{}: unsupported OS {}", label(), other)),
    };
    let arch = match crate::connect::node_arch() {
        "x64" => "x64",
        "arm64" => "arm64",
        other => return Err(format!("{}: unsupported arch {}", label(), other)),
    };
    Ok(format!("{}-{}", os, arch))
}

/// Remove `<bin>.new.*` and `<bin>.old.*` left by an earlier run.
fn sweep_stale_temp_files(bin_path: &Path) {
    let dir = match bin_path.parent() {
        Some(d) => d,
        None => return,
    };
    let base = bin_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let prefixes = [format!("{}.new.", base), format!("{}.old.", base)];
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if prefixes.iter().any(|p| name.starts_with(p.as_str())) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}

/// `installBinary`: an exclusive staging file at an unpredictable name, then
/// one rename (POSIX); on Windows the running binary is parked aside first.
fn install_binary(bytes: &[u8], target: &Path) -> Result<(), String> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(|e| crate::fsutil::node_error(&e, "mkdir", dir))?;
    sweep_stale_temp_files(target);
    let tmp = std::path::PathBuf::from(format!("{}.new.{}", target.to_string_lossy(), crate::crypto::random_uuid()));
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o755);
        }
        let mut f = opts.open(&tmp).map_err(|e| crate::fsutil::node_error(&e, "open", &tmp))?;
        std::io::Write::write_all(&mut f, bytes).map_err(|e| crate::fsutil::node_error(&e, "write", &tmp))?;
    }
    #[cfg(unix)]
    crate::fsutil::chmod(&tmp, 0o755);
    let swap = || -> Result<(), String> {
        if cfg!(windows) {
            let base = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let mut parked = std::env::temp_dir().join(format!("{}.old.{}", base, crate::crypto::random_uuid()));
            let mut moved_aside = false;
            match fs::rename(target, &parked) {
                Ok(()) => moved_aside = true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    parked = std::path::PathBuf::from(format!("{}.old.{}", target.to_string_lossy(), crate::crypto::random_uuid()));
                    fs::rename(target, &parked).map_err(|e| crate::fsutil::node_rename_error(&e, target, &parked))?;
                    moved_aside = true;
                }
            }
            if let Err(e) = fs::rename(&tmp, target) {
                if moved_aside {
                    let _ = fs::rename(&parked, target);
                }
                return Err(crate::fsutil::node_rename_error(&e, &tmp, target));
            }
            let _ = fs::remove_file(&parked);
            Ok(())
        } else {
            fs::rename(&tmp, target).map_err(|e| crate::fsutil::node_rename_error(&e, &tmp, target))
        }
    };
    if let Err(e) = swap() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn sha256_of_file(path: &Path) -> Option<String> {
    fs::read(path).ok().map(|b| crate::crypto::sha256_hex(&b))
}

/// `runUpdate`.
pub fn run_update(gateway_base_url: &str, log: &dyn Fn(&str), on_progress: &mut dyn FnMut(&UpdateProgress)) -> Result<UpdateResult, String> {
    let name = crate::bin_name();
    let bin_path = exec_path();
    let download_base = format!("{}/download", gateway_base_url.trim_end_matches('/'));
    assert_secure_fetch_url(&download_base, &label()).map_err(|e| e.message())?;
    let target = detect_target()?;
    let asset = format!("{}-{}", name, target);
    let local_version = crate::HX_VERSION.to_string();
    let latest = |remote: Option<String>| UpdateResult { asset: asset.clone(), sha256: None, daemon_restarted: false, already_latest: true, local_version: local_version.clone(), remote_version: remote };

    let remote_version = fetch_remote_version(&download_base);
    if let Some(r) = &remote_version {
        if !is_remote_newer(&local_version, Some(r)) {
            return Ok(latest(remote_version.clone()));
        }
    }

    let bin_url = format!("{}/{}.gz", download_base, asset);
    let sha_url = format!("{}/{}.sha256", download_base, asset);
    let gz = {
        let mut cb = |received: u64, total: u64| {
            let pct = if total > 0 { ((received as f64 * 85.0) / total as f64).floor().min(85.0) } else { 0.0 };
            on_progress(&UpdateProgress { phase: "download", pct, received: Some(received), total: Some(total) });
        };
        let res = secure_fetch(&bin_url, &mut cb)?;
        if !res.ok() {
            return Err(format!("GET {} → {} {}", bin_url, res.status, res.status_text));
        }
        res.body
    };
    on_progress(&UpdateProgress { phase: "unpack", pct: 90.0, received: None, total: None });
    let bin_bytes = gunzip(&gz)?;
    drop(gz);
    let sha_text = String::from_utf8_lossy(&fetch_bytes(&sha_url)?).trim().to_string();
    on_progress(&UpdateProgress { phase: "verify", pct: 96.0, received: None, total: None });
    let actual = assert_sha(&asset, &bin_bytes, &sha_text)?;
    on_progress(&UpdateProgress { phase: "verify", pct: 100.0, received: None, total: None });

    if sha256_of_file(Path::new(&bin_path)).as_deref() == Some(actual.as_str()) {
        return Ok(latest(remote_version));
    }

    install_binary(&bin_bytes, Path::new(&bin_path))?;
    log(&format!("installed → {}", bin_path));

    if cfg!(windows) {
        let svc_asset = format!("{}-svc", asset);
        let dir = Path::new(&bin_path).parent().unwrap_or_else(|| Path::new("."));
        let svc_target = dir.join(format!("{}-svc.exe", name));
        let svc_gz = fetch_bytes(&format!("{}/{}.gz", download_base, svc_asset))?;
        let svc_bytes = gunzip(&svc_gz)?;
        let svc_sha = String::from_utf8_lossy(&fetch_bytes(&format!("{}/{}.sha256", download_base, svc_asset))?).trim().to_string();
        assert_sha(&svc_asset, &svc_bytes, &svc_sha)?;
        install_binary(&svc_bytes, &svc_target)?;
        log(&format!("installed → {}", svc_target.to_string_lossy()));
    }

    let ops = get_daemon_ops();
    let before = ops.state();
    let mut daemon_restarted = false;
    if before.loaded {
        log(&format!("restarting daemon (was {})", match before.pid {
            Some(p) if p != 0 => format!("pid {}", p),
            _ => "loaded but idle".to_string(),
        }));
        if let Err(msg) = ops.restart(&bin_path, Consent::Denied) {
            let after = ops.state();
            let next = match (after.loaded, after.pid) {
                (true, Some(pid)) => format!("the previous version is still running (pid {}); run `{} restart` to load the new binary.", pid, name),
                _ => format!("the daemon is not running; run `{} start` to launch the new binary.", name),
            };
            return Err(format!("binary installed at {}, but the daemon failed to restart: {}\n{}", bin_path, msg, next));
        }
        daemon_restarted = true;
    }
    Ok(UpdateResult { asset, sha256: Some(actual), daemon_restarted, already_latest: false, local_version, remote_version })
}

/// `checkForUpdate`: the cheap check the UI asks for.
pub fn check_for_update(gateway_base_url: &str) -> Result<Json, String> {
    let download_base = format!("{}/download", gateway_base_url.trim_end_matches('/'));
    assert_secure_fetch_url(&download_base, &format!("{} update check", crate::bin_name())).map_err(|e| e.message())?;
    let latest = fetch_remote_version(&download_base);
    Ok(obj(vec![
        ("current", Json::str(crate::HX_VERSION)),
        ("latest", Json::opt_str(latest.as_deref())),
        ("updateAvailable", Json::Bool(is_remote_newer(crate::HX_VERSION, latest.as_deref()))),
    ]))
}

/// `hx update [--local]`: the bar on stderr, the summary on stdout.
pub fn cmd_update(name: &str, args: &[String]) -> Result<i32, String> {
    let gateway = crate::connect::require_gateway_url(name, args);
    let mut bar = crate::progress::ProgressBar::new();
    let mut seen: Vec<&'static str> = Vec::new();
    let mut pulse_frame: i64 = 0;
    let mut bar_closed = false;
    let crumb_download = format!("Downloading {}…", name);
    let r = {
        let mut on_progress = |ev: &UpdateProgress| {
            if seen.is_empty() {
                bar.hide_cursor();
            }
            if !seen.contains(&ev.phase) {
                seen.push(ev.phase);
                let crumb = match ev.phase {
                    "download" => crumb_download.as_str(),
                    "unpack" => "Unpacking…",
                    _ => "Verifying…",
                };
                bar.status(crumb);
            }
            let label = match ev.phase {
                "download" => "Downloading",
                "unpack" => "Unpacking",
                _ => "Verifying",
            };
            if ev.phase == "download" && ev.total.unwrap_or(0) == 0 {
                bar.pulse(label, pulse_frame);
                pulse_frame += 1;
            } else {
                bar.draw(ev.pct, label);
            }
            if ev.phase == "verify" && ev.pct >= 100.0 {
                bar.end();
                bar.show_cursor();
                bar_closed = true;
            }
        };
        run_update(&gateway, &|m: &str| crate::logger::say(m), &mut on_progress)
    };
    let r = match r {
        Ok(r) => r,
        Err(e) => {
            if !seen.is_empty() && !bar_closed {
                bar.clear_line();
            }
            bar.show_cursor();
            return Err(e);
        }
    };
    bar.show_cursor();
    if r.already_latest {
        crate::logger::say(&format!("{} is already on the latest version (v{}). Nothing to do. 🎉", name, r.local_version));
        return Ok(0);
    }
    let sha_note = match &r.sha256 {
        Some(s) => format!(", sha256 {}…", &s[..12.min(s.len())]),
        None => String::new(),
    };
    crate::logger::say(&format!("{} updated to latest ({}{}).", name, r.asset, sha_note));
    if r.daemon_restarted {
        crate::logger::say("daemon restarted.");
    }
    crate::logger::say(&format!("{} version: {}", name, r.remote_version.unwrap_or(r.local_version)));
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_compare() {
        assert!(is_remote_newer("78.0.0", Some("78.0.1")));
        assert!(!is_remote_newer("78.0.0", Some("78.0.0")));
        assert!(!is_remote_newer("78.0.0", Some("not-a-version")));
        assert!(!is_remote_newer("78.0.0", None));
        assert!(is_remote_newer("9.0.0", Some("10.0.0")));
    }

    #[test]
    fn sha_check() {
        let sha = crate::crypto::sha256_hex(b"abc");
        assert_eq!(assert_sha("hx2-linux-x64", b"abc", &format!("{}  hx2-linux-x64", sha)).unwrap(), sha);
        assert!(assert_sha("a", b"abc", "nope").unwrap_err().starts_with("malformed sha256 for a: nope"));
    }
}
