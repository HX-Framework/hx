//! The daemon's log files (src/daemon.ts): rotation of stdout.log and
//! stderr.log, `hx logs`, and the tee that writes them on Windows, where no
//! service manager redirects the daemon's output.
//!
//! On macOS and Linux the service manager opens the log O_APPEND and holds
//! the descriptor, so rotation copies the tail to `<log>.1` and truncates the
//! live file in place; the writer's next line lands at offset 0. Rotation
//! runs while this process holds the stdout and stderr locks, so none of the
//! daemon's own lines falls between the copy and the truncate.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::service::{stderr_log, stdout_log};

pub const LOG_MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const LOG_KEEP: u32 = 2;
const LOG_CHECK_INTERVAL_MS: u64 = 60_000;
const LOG_CHECK_BYTES: u64 = 1024 * 1024;
const LOG_COPY_CHUNK: usize = 1024 * 1024;

/// `<log>.1`, `<log>.2`, …
fn rotated(path: &Path, generation: u32) -> PathBuf {
    PathBuf::from(format!("{}.{}", path.to_string_lossy(), generation))
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// The offset of the first line that starts at or after `offset` (looking at
/// most 64 KiB ahead; a longer line is cut where `offset` falls).
fn line_start_at_or_after(f: &mut File, offset: u64) -> u64 {
    if offset == 0 {
        return 0;
    }
    let mut buf = vec![0u8; 64 * 1024];
    if f.seek(SeekFrom::Start(offset - 1)).is_err() {
        return offset;
    }
    let n = f.read(&mut buf).unwrap_or(0);
    match buf[..n].iter().position(|&b| b == b'\n') {
        Some(nl) => offset + nl as u64,
        None => offset,
    }
}

/// Copy the last `max_bytes` of `src` to `dst` from a line boundary, in two
/// passes (the second picks up what was appended during the first).
fn copy_log_tail(src: &Path, dst: &Path, max_bytes: u64) -> std::io::Result<()> {
    let mut input = File::open(src)?;
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut out = opts.open(dst)?;
    let mut end = input.metadata()?.len();
    let mut pos = line_start_at_or_after(&mut input, end.saturating_sub(max_bytes));
    let mut buf = vec![0u8; LOG_COPY_CHUNK];
    for _pass in 0..2 {
        if pos >= end {
            break;
        }
        input.seek(SeekFrom::Start(pos))?;
        while pos < end {
            let want = ((end - pos) as usize).min(buf.len());
            let n = input.read(&mut buf[..want])?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
            pos += n as u64;
        }
        end = input.metadata()?.len();
    }
    Ok(())
}

/// `rotateLogFile`: when `path` is over `max_bytes`, copy its tail to
/// `<log>.1`, shift older copies up, truncate the live file. Never fails.
pub fn rotate_log_file(path: &Path, max_bytes: u64, keep: u32) -> bool {
    if file_size(path) <= max_bytes {
        return false;
    }
    let tmp = PathBuf::from(format!("{}.tmp", rotated(path, 1).to_string_lossy()));
    let cut = (|| -> std::io::Result<()> {
        if keep > 0 {
            copy_log_tail(path, &tmp, max_bytes)?;
        }
        OpenOptions::new().write(true).open(path)?.set_len(0)
    })();
    if cut.is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    if keep > 0 {
        let mut g = keep;
        while g > 1 {
            let _ = fs::rename(rotated(path, g - 1), rotated(path, g));
            g -= 1;
        }
        let _ = fs::rename(&tmp, rotated(path, 1));
    }
    true
}

// ── The Windows tee ─────────────────────────────────────────────────────────

/// Log files this process writes itself (the Windows tee).
fn held() -> &'static Mutex<Vec<(PathBuf, Option<File>)>> {
    static HELD: OnceLock<Mutex<Vec<(PathBuf, Option<File>)>>> = OnceLock::new();
    HELD.get_or_init(|| Mutex::new(Vec::new()))
}

fn open_append(path: &Path) -> Option<File> {
    OpenOptions::new().append(true).create(true).open(path).ok()
}

/// `teeStdioToLogs`: Windows only. Task Scheduler redirects nothing, and the
/// windowless service build has no console, so the daemon writes its own log.
pub fn tee_stdio_to_logs() {
    if !cfg!(windows) {
        return;
    }
    let _ = fs::create_dir_all(crate::home::hx_dir());
    let mut h = held().lock().unwrap_or_else(|e| e.into_inner());
    for path in [stdout_log(), stderr_log()] {
        if let Some(f) = open_append(&path) {
            h.push((path, Some(f)));
        }
    }
}

/// Mirror a stdout (`err` false) or stderr write into the held log, if any.
pub fn tee_write(err: bool, bytes: &[u8]) {
    let target = if err { stderr_log() } else { stdout_log() };
    let mut h = held().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, Some(f))) = h.iter_mut().find(|(p, _)| *p == target) {
        let _ = f.write_all(bytes);
    }
}

fn holds(path: &Path) -> bool {
    held().lock().unwrap_or_else(|e| e.into_inner()).iter().any(|(p, f)| p == path && f.is_some())
}

/// `rotateOwnLog`: a held log is closed around the rotation and reopened.
fn rotate_own_log(path: &Path) -> bool {
    if !holds(path) {
        return rotate_log_file(path, LOG_MAX_BYTES, LOG_KEEP);
    }
    if file_size(path) <= LOG_MAX_BYTES {
        return false;
    }
    let mut h = held().lock().unwrap_or_else(|e| e.into_inner());
    let slot = h.iter_mut().find(|(p, _)| p == path);
    if let Some((_, f)) = slot {
        *f = None;
        let r = rotate_log_file(path, LOG_MAX_BYTES, LOG_KEEP);
        *f = open_append(path);
        return r;
    }
    false
}

// ── Rotation in the daemon ──────────────────────────────────────────────────

/// Is descriptor `fd` open on the regular file at `path` (same device and inode)?
#[cfg(unix)]
fn fd_writes_file(fd: i32, path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: fstat on a descriptor this process owns; the struct is zeroed first.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } != 0 {
        return false;
    }
    let on_disk = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    (st.st_mode & libc::S_IFMT) == libc::S_IFREG && st.st_dev as u64 == on_disk.dev() && st.st_ino as u64 == on_disk.ino()
}

#[cfg(not(unix))]
fn fd_writes_file(_fd: i32, _path: &Path) -> bool {
    false
}

/// The daemon logs this process writes: the files its stdout / stderr point
/// at, or the ones the Windows tee holds.
fn logs_this_process_writes() -> Vec<PathBuf> {
    [stdout_log(), stderr_log()].into_iter().filter(|p| holds(p) || fd_writes_file(1, p) || fd_writes_file(2, p)).collect()
}

struct Rotation {
    log: Box<dyn Fn(&str) + Send + Sync>,
    written: AtomicU64,
    checking: AtomicBool,
}

fn rotation() -> &'static OnceLock<Arc<Rotation>> {
    static R: OnceLock<Arc<Rotation>> = OnceLock::new();
    &R
}

/// One rotation check over every log this process writes, with the stdout
/// and stderr locks held so no line of this process lands mid-rotation.
fn check(r: &Rotation) {
    if r.checking.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut rotated_names: Vec<String> = Vec::new();
    {
        let _out = std::io::stdout().lock();
        let _err = std::io::stderr().lock();
        for path in logs_this_process_writes() {
            if rotate_own_log(&path) {
                rotated_names.push(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            }
        }
    }
    r.checking.store(false, Ordering::SeqCst);
    let mb = crate::js::math_round(LOG_MAX_BYTES as f64 / (1024.0 * 1024.0)) as u64;
    for name in rotated_names {
        (r.log)(&format!("[hx] rotated {} (over {} MB); earlier lines are in {}.1", name, mb, name));
    }
}

/// `startLogRotation`: rotate now, once a minute, and after every MiB of this
/// process's own output. Does nothing in a process that writes neither log.
pub fn start_log_rotation(log: Box<dyn Fn(&str) + Send + Sync>) {
    if rotation().get().is_some() {
        return;
    }
    if logs_this_process_writes().is_empty() {
        return;
    }
    let r = Arc::new(Rotation { log, written: AtomicU64::new(0), checking: AtomicBool::new(false) });
    if rotation().set(r.clone()).is_err() {
        return;
    }
    check(&r);
    std::thread::Builder::new()
        .name("hx-log-rotation".to_string())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(LOG_CHECK_INTERVAL_MS));
            check(&r);
        })
        .ok();
}

/// Count `n` bytes of this process's output; past a MiB, check the logs.
/// Called by every stdout and stderr write of the logger.
pub fn note_written(n: usize) {
    if let Some(r) = rotation().get() {
        let total = r.written.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
        if total >= LOG_CHECK_BYTES && !r.checking.load(Ordering::SeqCst) {
            r.written.store(0, Ordering::Relaxed);
            check(r);
        }
    }
}

// ── hx logs ─────────────────────────────────────────────────────────────────

/// `lines.slice(-count)` for a JavaScript number `count`.
fn js_tail<T: Clone>(items: &[T], count: f64) -> Vec<T> {
    let n = items.len() as f64;
    let k = -count.trunc();
    let start = if k < 0.0 { (n + k).max(0.0) } else { k.min(n) };
    items[start as usize..].to_vec()
}

/// `lastLinesOf`: the last `count` lines of a file from at most `max_bytes`
/// of its end, and its size.
fn last_lines_of(path: &Path, count: f64, max_bytes: u64) -> (Vec<String>, u64) {
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return (Vec::new(), 0),
    };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    if count <= 0.0 || count.is_nan() {
        return (Vec::new(), size);
    }
    let start = size.saturating_sub(max_bytes);
    let from = if start > 0 { start - 1 } else { 0 };
    let mut buf = Vec::with_capacity((size - from) as usize);
    if f.seek(SeekFrom::Start(from)).is_ok() {
        let _ = f.take(size - from).read_to_end(&mut buf);
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    if lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    (js_tail(&lines, count), size)
}

/// `recentLogLines`: the last `count` lines, continuing into `<log>.1` when
/// the live file was rotated recently and holds fewer.
pub fn recent_log_lines(path: &Path, count: f64, max_bytes: Option<u64>) -> (Vec<String>, u64) {
    let max = max_bytes.unwrap_or_else(|| (1024u64 * 1024).max((count.max(0.0) * 512.0) as u64));
    let (live, size) = last_lines_of(path, count, max);
    if live.len() as f64 >= count {
        return (live, size);
    }
    let (older, _) = last_lines_of(&rotated(path, 1), count - live.len() as f64, max);
    let mut all = older;
    all.extend(live);
    (all, size)
}

const TAIL_POLL_MS: u64 = 250;

/// `tailLogs`: the last `lines_back` lines of each log, then everything
/// appended, until Ctrl+C.
pub fn tail_logs(lines_back: f64) -> Result<(), String> {
    fs::create_dir_all(crate::home::hx_dir()).map_err(|e| crate::fsutil::node_error(&e, "mkdir", crate::home::hx_dir()))?;
    let files = [stdout_log(), stderr_log()];
    for p in &files {
        OpenOptions::new().append(true).create(true).open(p).map_err(|e| crate::fsutil::node_error(&e, "open", p))?;
    }
    let mut offsets: Vec<u64> = Vec::new();
    let stdout = std::io::stdout();
    for p in &files {
        let (lines, size) = recent_log_lines(p, lines_back, None);
        offsets.push(size);
        if !lines.is_empty() {
            let mut h = stdout.lock();
            let _ = h.write_all(format!("{}\n", lines.join("\n")).as_bytes());
            let _ = h.flush();
        }
    }
    let stopped = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    let _ = signal_hook::flag::register(signal_hook::consts::signal::SIGINT, stopped.clone());
    // Windows: Bun's SIGINT is Ctrl+C in the console (crate::daemon does the same).
    #[cfg(windows)]
    {
        let flag = stopped.clone();
        let _ = crate::platform::on_ctrl_c(Box::new(move || flag.store(true, Ordering::SeqCst)));
    }
    while !stopped.load(Ordering::SeqCst) {
        for (i, p) in files.iter().enumerate() {
            let mut f = match File::open(p) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let size = match f.metadata() {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            let prev = offsets[i];
            if size < prev {
                offsets[i] = 0;
                continue;
            }
            if size == prev {
                continue;
            }
            let mut buf = Vec::with_capacity((size - prev) as usize);
            if f.seek(SeekFrom::Start(prev)).is_ok() {
                let _ = (&mut f).take(size - prev).read_to_end(&mut buf);
            }
            if !buf.is_empty() {
                let mut h = stdout.lock();
                let _ = h.write_all(&buf);
                let _ = h.flush();
            }
            offsets[i] = prev + buf.len() as u64;
        }
        std::thread::sleep(std::time::Duration::from_millis(TAIL_POLL_MS));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_tail_matches_slice() {
        let v = vec![1, 2, 3];
        assert_eq!(js_tail(&v, 2.0), vec![2, 3]);
        assert_eq!(js_tail(&v, 5.0), vec![1, 2, 3]);
        assert_eq!(js_tail(&v, 1.5), vec![3]);
        // slice(-0.5) is slice(0): every item.
        assert_eq!(js_tail(&v, 0.5), vec![1, 2, 3]);
    }
}
