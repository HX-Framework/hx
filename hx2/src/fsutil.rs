//! File system helpers with the numbers the TypeScript client sees.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug)]
pub struct StatInfo {
    pub size: u64,
    /// Bun's `stat().mtimeMs`: seconds × 1000 plus nanoseconds / 1e6, as a double.
    pub mtime_ms: f64,
    pub is_dir: bool,
    pub is_file: bool,
}

pub fn mtime_ms_of(m: &fs::Metadata) -> f64 {
    (m.mtime() as f64) * 1000.0 + (m.mtime_nsec() as f64) / 1_000_000.0
}

/// `statSafe`: follows symlinks; None on any error.
pub fn stat_safe(p: &Path) -> Option<StatInfo> {
    let m = fs::metadata(p).ok()?;
    Some(StatInfo { size: m.len(), mtime_ms: mtime_ms_of(&m), is_dir: m.is_dir(), is_file: m.is_file() })
}

/// `readdirSafe`: entry names in directory order; empty on any error.
pub fn readdir_safe(p: &Path) -> Vec<String> {
    match fs::read_dir(p) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
        Err(_) => Vec::new(),
    }
}

/// `Date.now()` in milliseconds.
pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

pub fn exists(p: &Path) -> bool {
    fs::metadata(p).is_ok()
}

/// `writeFile(path, text, { mode: 0o600 })`: created with the mode, truncated when present.
pub fn write_file_0600(p: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(p)?;
    f.write_all(bytes)?;
    Ok(())
}

/// `appendFile(path, text, { mode: 0o600 })`.
pub fn append_file_0600(p: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = fs::OpenOptions::new().append(true).create(true).mode(0o600).open(p)?;
    f.write_all(bytes)?;
    Ok(())
}

/// Atomic write: `<path>.tmp` with mode 0600, then rename over the target.
pub fn write_atomic_0600(p: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = PathBuf::from(format!("{}.tmp", p.to_string_lossy()));
    write_file_0600(&tmp, bytes)?;
    fs::rename(&tmp, p)
}

pub fn chmod(p: &Path, mode: u32) {
    let _ = fs::set_permissions(p, fs::Permissions::from_mode(mode));
}

/// `path.dirname`.
pub fn dirname(p: &str) -> String {
    match Path::new(p).parent() {
        Some(parent) => {
            let s = parent.to_string_lossy().into_owned();
            if s.is_empty() {
                ".".to_string()
            } else {
                s
            }
        }
        None => p.to_string(),
    }
}

/// `path.basename(p, ext)`.
pub fn basename(p: &str, ext: &str) -> String {
    let name = Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !ext.is_empty() && name.ends_with(ext) && name.len() > ext.len() {
        name[..name.len() - ext.len()].to_string()
    } else {
        name
    }
}

pub fn join(a: &str, b: &str) -> String {
    Path::new(a).join(b).to_string_lossy().into_owned()
}

/// `path.relative(from, to)` for absolute POSIX paths.
pub fn relative(from: &str, to: &str) -> String {
    let f: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let t: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let mut common = 0;
    while common < f.len() && common < t.len() && f[common] == t[common] {
        common += 1;
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in common..f.len() {
        parts.push("..".to_string());
    }
    for seg in &t[common..] {
        parts.push((*seg).to_string());
    }
    parts.join("/")
}

/// `path.resolve(base, target)` for POSIX: absolute target wins, else join and
/// collapse `.` and `..` segments lexically.
pub fn resolve(base: &str, target: &str) -> String {
    let joined = if target.starts_with('/') { target.to_string() } else { format!("{}/{}", base, target) };
    normalize_posix(&joined)
}

/// `path.normalize` for an absolute POSIX path (no trailing slash kept).
pub fn normalize_posix(p: &str) -> String {
    let absolute = p.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if !out.is_empty() && *out.last().unwrap() != ".." {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let body = out.join("/");
    if absolute {
        format!("/{}", body)
    } else if body.is_empty() {
        ".".to_string()
    } else {
        body
    }
}
