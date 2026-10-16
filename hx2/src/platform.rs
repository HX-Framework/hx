//! The operating-system calls whose POSIX and Windows forms differ, kept in
//! one place: the process probe behind `process.kill(pid, 0)`, ending this
//! process the way SIGKILL does, whether stdout is a terminal, telling a
//! directory from a file a read failed on, and Ctrl+C in a Windows console.
//! On Windows each one does what Bun does there, which is libuv's uv_kill and
//! uv_guess_handle.

use std::path::Path;

/// What `process.kill(pid, 0)` reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PidProbe {
    /// The call succeeded: the process runs.
    Alive,
    /// ESRCH: there is no such process.
    Gone,
    /// EPERM: the process runs and belongs to someone else.
    NotPermitted,
    /// Any other error.
    Other,
}

#[cfg(unix)]
pub fn probe_pid(pid: i64) -> PidProbe {
    // SAFETY: signal 0 only probes the process.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if r == 0 {
        return PidProbe::Alive;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => PidProbe::Gone,
        Some(libc::EPERM) => PidProbe::NotPermitted,
        _ => PidProbe::Other,
    }
}

/// libuv maps ERROR_ACCESS_DENIED and ERROR_PRIVILEGE_NOT_HELD to EPERM.
#[cfg(windows)]
fn translate_probe_error(err: Option<i32>) -> PidProbe {
    match err.map(|e| e as u32) {
        Some(win::ERROR_ACCESS_DENIED) | Some(win::ERROR_PRIVILEGE_NOT_HELD) => PidProbe::NotPermitted,
        _ => PidProbe::Other,
    }
}

#[cfg(windows)]
pub fn probe_pid(pid: i64) -> PidProbe {
    use win::*;
    let translate = translate_probe_error;
    // SAFETY: plain Win32 calls on a handle this function opens and closes.
    unsafe {
        let handle = if pid == 0 { GetCurrentProcess() } else { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | SYNCHRONIZE, 0, pid as u32) };
        if handle.is_null() {
            let err = std::io::Error::last_os_error().raw_os_error();
            if err.map(|e| e as u32) == Some(ERROR_INVALID_PARAMETER) {
                return PidProbe::Gone;
            }
            return translate(err);
        }
        let mut status: u32 = 0;
        let probe = if GetExitCodeProcess(handle, &mut status) == 0 {
            translate(std::io::Error::last_os_error().raw_os_error())
        } else if status != STILL_ACTIVE {
            PidProbe::Gone
        } else {
            match WaitForSingleObject(handle, 0) {
                WAIT_OBJECT_0 => PidProbe::Gone,
                WAIT_TIMEOUT => PidProbe::Alive,
                _ => translate(std::io::Error::last_os_error().raw_os_error()),
            }
        };
        CloseHandle(handle);
        probe
    }
}

/// End this process at once, the way the watchdog's SIGKILL does. Windows
/// has no SIGKILL: Bun's `process.kill(pid, "SIGKILL")` there terminates the
/// process with exit code 1.
pub fn kill_self_hard(pid: u32) {
    #[cfg(unix)]
    // SAFETY: ending our own process.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
    #[cfg(windows)]
    // SAFETY: ending our own process.
    unsafe {
        let _ = pid;
        win::TerminateProcess(win::GetCurrentProcess(), 1);
    }
}

/// `process.stdout.isTTY`.
pub fn stdout_is_tty() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: isatty only inspects the descriptor.
        unsafe { libc::isatty(1) == 1 }
    }
    #[cfg(windows)]
    {
        // libuv's uv_guess_handle: a TTY is a character device with a console mode.
        // SAFETY: queries on the standard output handle, which this process does not own.
        unsafe {
            let h = win::GetStdHandle(win::STD_OUTPUT_HANDLE);
            if h.is_null() || h as isize == -1 {
                return false;
            }
            let mut mode: u32 = 0;
            win::GetFileType(h) == win::FILE_TYPE_CHAR && win::GetConsoleMode(h, &mut mode) != 0
        }
    }
}

/// Did reading `path` fail because it is a directory? The TypeScript runtime
/// reports EISDIR on every platform. POSIX says so itself; Windows refuses to
/// open a directory as a file with "access denied", so there the answer is
/// whether `path` is a directory.
pub fn is_dir_read_error(e: &std::io::Error, path: &Path) -> bool {
    #[cfg(unix)]
    {
        let _ = path;
        e.raw_os_error() == Some(libc::EISDIR)
    }
    #[cfg(windows)]
    {
        let _ = e;
        std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
    }
}

#[cfg(windows)]
static CTRL_C: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>> = std::sync::OnceLock::new();

#[cfg(windows)]
unsafe extern "system" fn console_ctrl(kind: u32) -> win::BOOL {
    if kind != win::CTRL_C_EVENT {
        // Ctrl+Break, closing the console, log off, shut down: the default
        // handler ends the process, as it does under Bun with no listener.
        return 0;
    }
    match CTRL_C.get() {
        Some(f) => {
            f();
            1
        }
        None => 0,
    }
}

/// Run `f` when Ctrl+C reaches this process's console, Bun's SIGINT on
/// Windows. Windows calls it on a thread of its own. False when it could not
/// be installed.
#[cfg(windows)]
pub fn on_ctrl_c(f: Box<dyn Fn() + Send + Sync>) -> bool {
    if CTRL_C.set(f).is_err() {
        return false;
    }
    // SAFETY: registers a handler that lives for the whole process.
    unsafe { win::SetConsoleCtrlHandler(Some(console_ctrl), 1) != 0 }
}

#[cfg(windows)]
#[allow(non_snake_case, clippy::upper_case_acronyms)]
mod win {
    pub type HANDLE = *mut core::ffi::c_void;
    pub type BOOL = i32;
    pub type HandlerRoutine = unsafe extern "system" fn(u32) -> BOOL;

    pub const PROCESS_TERMINATE: u32 = 0x0001;
    pub const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    pub const SYNCHRONIZE: u32 = 0x0010_0000;
    pub const ERROR_ACCESS_DENIED: u32 = 5;
    pub const ERROR_INVALID_PARAMETER: u32 = 87;
    pub const ERROR_PRIVILEGE_NOT_HELD: u32 = 1314;
    pub const STILL_ACTIVE: u32 = 259;
    pub const WAIT_OBJECT_0: u32 = 0;
    pub const WAIT_TIMEOUT: u32 = 258;
    pub const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    pub const FILE_TYPE_CHAR: u32 = 0x0002;
    pub const CTRL_C_EVENT: u32 = 0;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn OpenProcess(desired_access: u32, inherit_handle: BOOL, process_id: u32) -> HANDLE;
        pub fn GetCurrentProcess() -> HANDLE;
        pub fn GetExitCodeProcess(process: HANDLE, exit_code: *mut u32) -> BOOL;
        pub fn WaitForSingleObject(handle: HANDLE, milliseconds: u32) -> u32;
        pub fn CloseHandle(handle: HANDLE) -> BOOL;
        pub fn TerminateProcess(process: HANDLE, exit_code: u32) -> BOOL;
        pub fn GetStdHandle(std_handle: u32) -> HANDLE;
        pub fn GetFileType(file: HANDLE) -> u32;
        pub fn GetConsoleMode(console: HANDLE, mode: *mut u32) -> BOOL;
        pub fn SetConsoleCtrlHandler(handler: Option<HandlerRoutine>, add: BOOL) -> BOOL;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_this_process_as_alive() {
        assert_eq!(probe_pid(std::process::id() as i64), PidProbe::Alive);
    }

    #[test]
    fn probes_a_finished_child_as_gone() {
        // A child that has exited and been waited for no longer exists.
        let exe = std::env::current_exe().expect("test binary path");
        let mut child = std::process::Command::new(exe)
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn the test binary");
        let pid = child.id() as i64;
        child.wait().expect("wait for the child");
        drop(child);
        assert_eq!(probe_pid(pid), PidProbe::Gone);
    }

    #[test]
    fn tells_a_directory_from_a_file() {
        let dir = std::env::temp_dir().join(format!("hx2-platform-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create the test directory");
        let e = std::fs::read_to_string(&dir).expect_err("reading a directory fails");
        assert!(is_dir_read_error(&e, &dir));
        let missing = dir.join("missing");
        let e = std::fs::read_to_string(&missing).expect_err("reading a missing file fails");
        assert!(!is_dir_read_error(&e, &missing));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
