//! File system helpers with the numbers the TypeScript client sees.

use std::fs;
use std::io::Write;
#[cfg(unix)]
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

#[cfg(unix)]
pub fn mtime_ms_of(m: &fs::Metadata) -> f64 {
    (m.mtime() as f64) * 1000.0 + (m.mtime_nsec() as f64) / 1_000_000.0
}

/// Windows keeps the time in 100 ns steps since 1601; libuv turns it into
/// seconds and nanoseconds since 1970, and Bun's mtimeMs adds them up as
/// above.
#[cfg(windows)]
pub fn mtime_ms_of(m: &fs::Metadata) -> f64 {
    let ms = |d: std::time::Duration| (d.as_secs() as f64) * 1000.0 + (d.subsec_nanos() as f64) / 1_000_000.0;
    match m.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => ms(d),
            Err(e) => -ms(e.duration()),
        },
        Err(_) => 0.0,
    }
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

/// Owner read and write for a file this client creates. Windows has no mode
/// bits: Node applies a mode there only as the read-only attribute, which
/// 0o600 leaves off, so the file is created as any other.
fn mode_0600(o: &mut fs::OpenOptions) -> &mut fs::OpenOptions {
    #[cfg(unix)]
    o.mode(0o600);
    o
}

/// `writeFile(path, text, { mode: 0o600 })`: created with the mode, truncated when present.
pub fn write_file_0600(p: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = mode_0600(fs::OpenOptions::new().write(true).create(true).truncate(true)).open(p)?;
    f.write_all(bytes)?;
    Ok(())
}

/// `appendFile(path, text, { mode: 0o600 })`.
pub fn append_file_0600(p: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = mode_0600(fs::OpenOptions::new().append(true).create(true)).open(p)?;
    f.write_all(bytes)?;
    Ok(())
}

/// Atomic write: `<path>.tmp` with mode 0600, then rename over the target.
pub fn write_atomic_0600(p: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = PathBuf::from(format!("{}.tmp", p.to_string_lossy()));
    write_file_0600(&tmp, bytes)?;
    fs::rename(&tmp, p)
}

#[cfg(unix)]
pub fn chmod(p: &Path, mode: u32) {
    let _ = fs::set_permissions(p, fs::Permissions::from_mode(mode));
}

/// `fs.chmod` on Windows sets the read-only attribute when the owner write
/// bit is off and clears it when it is on (libuv); nothing else applies.
#[cfg(windows)]
pub fn chmod(p: &Path, mode: u32) {
    if let Ok(m) = fs::metadata(p) {
        let mut perms = m.permissions();
        perms.set_readonly(mode & 0o200 == 0);
        let _ = fs::set_permissions(p, perms);
    }
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

/// The platform's path separator, `path.sep`.
pub const SEP: &str = std::path::MAIN_SEPARATOR_STR;

/// `path.isAbsolute`.
pub fn is_absolute(p: &str) -> bool {
    #[cfg(windows)]
    {
        crate::winpath::is_absolute(p)
    }
    #[cfg(not(windows))]
    {
        p.starts_with('/')
    }
}

/// `path.relative(from, to)`; on Windows `path.win32.relative`.
#[cfg(windows)]
pub fn relative(from: &str, to: &str) -> String {
    crate::winpath::relative(from, to)
}

/// `path.relative(from, to)` for absolute POSIX paths.
#[cfg(not(windows))]
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

/// `path.resolve(base, target)`; on Windows `path.win32.resolve`.
#[cfg(windows)]
pub fn resolve(base: &str, target: &str) -> String {
    crate::winpath::resolve(&[base, target])
}

/// `path.resolve(base, target)` for POSIX: absolute target wins, else join and
/// collapse `.` and `..` segments lexically.
#[cfg(not(windows))]
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

/// The `E…` name and the text Node prints for an errno, for the messages the
/// client logs when a write fails (`EACCES: permission denied, open '…'`).
#[cfg(unix)]
fn errno_name_text(code: i32) -> (String, String) {
    let known: &[(i32, &str, &str)] = &[
        (libc::EPERM, "EPERM", "operation not permitted"),
        (libc::ENOENT, "ENOENT", "no such file or directory"),
        (libc::EIO, "EIO", "i/o error"),
        (libc::EBADF, "EBADF", "bad file descriptor"),
        (libc::EACCES, "EACCES", "permission denied"),
        (libc::EBUSY, "EBUSY", "resource busy or locked"),
        (libc::EEXIST, "EEXIST", "file already exists"),
        (libc::EXDEV, "EXDEV", "cross-device link not permitted"),
        (libc::ENOTDIR, "ENOTDIR", "not a directory"),
        (libc::EISDIR, "EISDIR", "illegal operation on a directory"),
        (libc::EINVAL, "EINVAL", "invalid argument"),
        (libc::EMFILE, "EMFILE", "too many open files"),
        (libc::ENOSPC, "ENOSPC", "no space left on device"),
        (libc::EROFS, "EROFS", "read-only file system"),
        (libc::ENAMETOOLONG, "ENAMETOOLONG", "name too long"),
        (libc::ENOTEMPTY, "ENOTEMPTY", "directory not empty"),
        (libc::ELOOP, "ELOOP", "too many symbolic links encountered"),
    ];
    for (c, name, text) in known {
        if *c == code {
            return (name.to_string(), text.to_string());
        }
    }
    (format!("E{}", code), std::io::Error::from_raw_os_error(code).to_string().to_lowercase())
}

/// On Windows a failed call carries a Win32 error code. The runtime turns it
/// into an errno the way libuv's uv_translate_sys_error does, then prints that
/// errno's name and text as on POSIX; a code with no errno is UNKNOWN.
#[cfg(windows)]
fn errno_name_text(code: i32) -> (String, String) {
    let name = match code as u32 {
        2 | 3 | 15 | 123 | 161 | 203 | 267 | 4392 | 126 => "ENOENT",
        5 | 1314 => "EPERM",
        998 | 740 | 1920 => "EACCES",
        32 | 33 | 231 => "EBUSY",
        80 | 183 => "EEXIST",
        145 => "ENOTEMPTY",
        17 => "EXDEV",
        39 | 112 | 82 | 255 | 1100 => "ENOSPC",
        19 => "EROFS",
        4 => "EMFILE",
        206 => "ENAMETOOLONG",
        6 | 1004 => "EBADF",
        87 | 122 | 13 | 1464 => "EINVAL",
        1 => "EISDIR",
        1921 => "ELOOP",
        23 | 31 | 110 | 156 | 205 | 1101 | 1102 | 1103 | 1104 | 1106 | 1111 | 1117 | 1129 | 1165 | 1166 | 1393 => "EIO",
        _ => return ("UNKNOWN".to_string(), "unknown error".to_string()),
    };
    let text = match name {
        "ENOENT" => "no such file or directory",
        "EPERM" => "operation not permitted",
        "EACCES" => "permission denied",
        "EBUSY" => "resource busy or locked",
        "EEXIST" => "file already exists",
        "ENOTEMPTY" => "directory not empty",
        "EXDEV" => "cross-device link not permitted",
        "ENOSPC" => "no space left on device",
        "EROFS" => "read-only file system",
        "EMFILE" => "too many open files",
        "ENAMETOOLONG" => "name too long",
        "EBADF" => "bad file descriptor",
        "EINVAL" => "invalid argument",
        "EISDIR" => "illegal operation on a directory",
        "ELOOP" => "too many symbolic links encountered",
        _ => "i/o error",
    };
    (name.to_string(), text.to_string())
}

/// A failed file operation the way the TypeScript runtime reports it:
/// `EACCES: permission denied, open '/path'`.
pub fn node_error(e: &std::io::Error, syscall: &str, path: &Path) -> String {
    match e.raw_os_error() {
        Some(code) => {
            let (name, text) = errno_name_text(code);
            format!("{}: {}, {} '{}'", name, text, syscall, path.to_string_lossy())
        }
        None => format!("{}, {} '{}'", e, syscall, path.to_string_lossy()),
    }
}

/// `rename` failures name both paths: `ENOENT: no such file or directory, rename '/a' -> '/b'`.
pub fn node_rename_error(e: &std::io::Error, from: &Path, to: &Path) -> String {
    match e.raw_os_error() {
        Some(code) => {
            let (name, text) = errno_name_text(code);
            format!("{}: {}, rename '{}' -> '{}'", name, text, from.to_string_lossy(), to.to_string_lossy())
        }
        None => format!("{}, rename '{}' -> '{}'", e, from.to_string_lossy(), to.to_string_lossy()),
    }
}

/// `writeFile(path, text, { mode: 0o600 })` with the runtime's error text.
pub fn write_file_0600_node(p: &Path, bytes: &[u8]) -> Result<(), String> {
    write_file_0600(p, bytes).map_err(|e| node_error(&e, "open", p))
}

/// `appendFile(path, text, { mode: 0o600 })` with the runtime's error text.
pub fn append_file_0600_node(p: &Path, bytes: &[u8]) -> Result<(), String> {
    append_file_0600(p, bytes).map_err(|e| node_error(&e, "open", p))
}

/// The tmp-then-rename write with the runtime's error text for whichever step failed.
pub fn write_atomic_0600_node(p: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = PathBuf::from(format!("{}.tmp", p.to_string_lossy()));
    write_file_0600(&tmp, bytes).map_err(|e| node_error(&e, "open", &tmp))?;
    fs::rename(&tmp, p).map_err(|e| node_rename_error(&e, &tmp, p))
}

#[cfg(target_os = "macos")]
extern "C" {
    /// malloc/malloc.h: hand freed pages back to the system (every zone when NULL).
    fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
}

/// Hand the allocator's freed pages back to the system after work that
/// allocated: the catch-up's read buffers, the snapshot text and the saved
/// Claude Desktop index's load must not sit in the daemon's resident size
/// for the rest of the day. The allocator keeps them otherwise; nothing the
/// servers see changes.
pub fn release_freed_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::malloc_trim(0);
    }
    #[cfg(target_os = "macos")]
    unsafe {
        malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
    }
}
