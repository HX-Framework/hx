//! `~/.let/hx`: where every file the client owns lives (src/hx-home.ts).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static HOME: OnceLock<PathBuf> = OnceLock::new();
static HX_DIR: OnceLock<PathBuf> = OnceLock::new();

/// `os.homedir()`: $HOME when set, else the password database.
pub fn homedir() -> &'static Path {
    HOME.get_or_init(|| {
        if let Ok(h) = std::env::var("HOME") {
            if !h.is_empty() {
                return PathBuf::from(h);
            }
        }
        passwd_home().unwrap_or_else(|| PathBuf::from("/"))
    })
}

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
}
