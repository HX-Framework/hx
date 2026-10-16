//! `~/.let/hx`: where every file the client owns lives (src/hx-home.ts).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static HOME: OnceLock<PathBuf> = OnceLock::new();
static HX_DIR: OnceLock<PathBuf> = OnceLock::new();

/// `os.homedir()`: $HOME when set, else the password database. On Windows
/// %USERPROFILE%, else the user's profile directory, as libuv reads it.
pub fn homedir() -> &'static Path {
    HOME.get_or_init(|| {
        #[cfg(windows)]
        {
            if let Some(h) = std::env::var_os("USERPROFILE") {
                return PathBuf::from(h);
            }
            #[allow(deprecated)]
            let profile = std::env::home_dir();
            return profile.unwrap_or_else(|| PathBuf::from("C:\\"));
        }
        #[cfg(not(windows))]
        {
            if let Ok(h) = std::env::var("HOME") {
                if !h.is_empty() {
                    return PathBuf::from(h);
                }
            }
            passwd_home().unwrap_or_else(|| PathBuf::from("/"))
        }
    })
}

#[cfg(not(windows))]
fn passwd_home() -> Option<PathBuf> {
    // SAFETY: getpwuid returns a pointer to static storage; we copy the
    // directory string out before returning.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_dir.is_null() {
            return None;
        }
        let dir = std::ffi::CStr::from_ptr((*pw).pw_dir).to_string_lossy().into_owned();
        Some(PathBuf::from(dir))
    }
}

pub fn hx_dir() -> &'static Path {
    HX_DIR.get_or_init(|| homedir().join(".let").join("hx"))
}

pub fn hx_dir_str() -> String {
    hx_dir().to_string_lossy().into_owned()
}

/// Move `~/.hx` to `~/.let/hx` once, then make sure the directory exists —
/// what importing hx-home.ts does in every command of the TypeScript client.
pub fn ensure_hx_home() {
    let dir = hx_dir();
    let legacy = homedir().join(".hx");
    if !dir.exists() && legacy.exists() {
        let _ = fs::create_dir_all(homedir().join(".let"));
        let _ = fs::rename(&legacy, dir);
    }
    let _ = fs::create_dir_all(dir);
    #[cfg(windows)]
    harden_windows_acl(dir);
}

/// hx-home.ts `hardenWindowsAcl`: narrow `~/.let/hx` to its owner once, with
/// icacls. Creating the marker is the check, so two processes never both run
/// it, and a failed icacls removes the marker so the next run tries again.
#[cfg(windows)]
fn harden_windows_acl(dir: &Path) {
    let user = match std::env::var("USERNAME") {
        Ok(u) if !u.is_empty() => u,
        _ => return,
    };
    let marker = dir.join(".acl-v1");
    if fs::OpenOptions::new().write(true).create_new(true).open(&marker).is_err() {
        return;
    }
    let ok = std::process::Command::new("icacls")
        .arg(dir)
        .args(["/inheritance:r", "/grant:r", &format!("{}:(OI)(CI)F", user)])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        let _ = fs::remove_file(&marker);
    }
}
