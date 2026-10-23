//! `hx uninstall [--purge]` (src/uninstall.ts): the service, the binary
//! (`~/.let/bin/<name>`), on Windows the service build, the Apps & features
//! entry and the PATH entry, and with --purge `~/.let/hx`.
//!
//! hx and hx2 share `~/.let/bin` and the service slot, so hx2 leaves alone
//! what belongs to hx: a slot whose definition runs hx is not removed
//! (unless --purge removes the state it would run on), and on Windows the
//! PATH entry stays while hx's binary is still in that directory.

use std::fs;
use std::path::{Path, PathBuf};

use crate::daemon_state::get_daemon_ops;
use crate::home::{homedir, hx_dir};
use crate::logger::say;
use crate::service::{slot_runs_other_client, spawn_ignore};

fn bin_dir() -> PathBuf {
    homedir().join(".let").join("bin")
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{}.exe", name)
    } else {
        name.to_string()
    }
}

/// Remove a file that may be the executable this process runs from: POSIX
/// unlinks it; Windows renames it into %TEMP% (a mapped image cannot be
/// deleted) and deletes it when it can.
fn remove_binary(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    match fs::remove_file(path) {
        Ok(()) => return Ok(true),
        Err(e) => {
            if !cfg!(windows) {
                return Err(crate::fsutil::node_error(&e, "unlink", path));
            }
        }
    }
    let base = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut parked = std::env::temp_dir().join(format!("{}.old.{}", base, crate::crypto::random_uuid()));
    if fs::rename(path, &parked).is_err() {
        parked = PathBuf::from(format!("{}.old.{}", path.to_string_lossy(), crate::crypto::random_uuid()));
        fs::rename(path, &parked).map_err(|e| crate::fsutil::node_rename_error(&e, path, &parked))?;
    }
    let _ = fs::remove_file(&parked);
    Ok(true)
}

/// Drop `~/.let/bin` from the user's PATH in the registry (Windows).
fn remove_windows_path_entry() {
    let dir = bin_dir().to_string_lossy().into_owned();
    let ps = format!(
        "$d='{}';$p=[Environment]::GetEnvironmentVariable('Path','User');if ($p) {{ $n=($p -split ';' | Where-Object {{ $_ -and $_.TrimEnd('\\') -ne $d.TrimEnd('\\') }}) -join ';';[Environment]::SetEnvironmentVariable('Path',$n,'User') }}",
        dir.replace('\'', "''")
    );
    let r = spawn_ignore("powershell", &["-NoProfile", "-NonInteractive", "-Command", &ps]);
    if r.ok() {
        say(&format!("removed {} from PATH (new terminals only)", dir));
    } else {
        say(&format!("warning: could not remove {} from your PATH; remove it by hand", dir));
    }
}

/// `hx uninstall [--purge]`.
pub fn cmd_uninstall(name: &str, args: &[String]) -> Result<i32, String> {
    let purge = crate::commands::has_flag(args, "purge");
    let bin_path = bin_dir().join(exe(name));
    let svc_bin = bin_dir().join(format!("{}-svc.exe", name));

    let mut daemon_removed = false;
    let ops = get_daemon_ops();
    match slot_runs_other_client(&ops) {
        Some(other) if !purge => {
            say(&format!("left the background service alone: it runs {}", other));
        }
        _ => match ops.uninstall() {
            Ok(()) => {
                daemon_removed = true;
                say(&format!("removed daemon ({})", ops.manager_name));
            }
            Err(e) => say(&format!("warning: daemon teardown failed: {}", e)),
        },
    }

    let mut binary_removed = false;
    let targets: Vec<PathBuf> = if cfg!(windows) { vec![bin_path.clone(), svc_bin] } else { vec![bin_path.clone()] };
    for target in &targets {
        if !target.exists() {
            if *target == bin_path {
                say(&format!("binary not found at {}; skipping", target.to_string_lossy()));
            }
            continue;
        }
        match remove_binary(target) {
            Ok(_) => {
                if *target == bin_path {
                    binary_removed = true;
                }
                say(&format!("removed binary: {}", target.to_string_lossy()));
            }
            Err(e) => say(&format!("warning: could not remove binary at {}: {}", target.to_string_lossy(), e)),
        }
    }

    if cfg!(windows) {
        let _ = spawn_ignore("reg", &["delete", &format!("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}", name), "/f"]);
        // ~/.let/bin is shared with the other client: keep it on PATH while
        // that client's binary is still there.
        let other = if name == "hx2" { "hx" } else { "hx2" };
        if bin_dir().join(exe(other)).exists() {
            say(&format!("kept {} on PATH: {} is still installed there", bin_dir().to_string_lossy(), other));
        } else {
            remove_windows_path_entry();
        }
    }

    let mut config_purged = false;
    if purge && hx_dir().exists() {
        match fs::remove_dir_all(hx_dir()) {
            Ok(()) => {
                config_purged = true;
                say(&format!("purged {}", hx_dir().to_string_lossy()));
            }
            Err(e) => say(&format!("warning: could not purge {}: {}", hx_dir().to_string_lossy(), crate::fsutil::node_error(&e, "rm", hx_dir()))),
        }
    }

    say("");
    say(&format!("{} uninstalled.", name));
    say(&format!("  daemon removed: {}", if daemon_removed { "yes" } else { "no (or wasn't loaded)" }));
    say(&format!("  binary removed: {}", if binary_removed { bin_path.to_string_lossy().into_owned() } else { "no (not found)".to_string() }));
    say(&format!(
        "  config purged:  {}",
        if config_purged {
            "yes"
        } else if purge {
            "no (HX dir not found)"
        } else {
            "skipped — pass --purge to also remove ~/.let/hx/"
        }
    ));
    if !cfg!(windows) {
        say("");
        say("If you'd like to clean up your shell-rc PATH entry, look for the");
        say(&format!("\"Added by {} installer\" line and remove it.", name));
    }
    Ok(0)
}
