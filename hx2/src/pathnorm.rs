//! Path normalization and canonical comparison (src/pathnorm.ts).

use crate::fsutil::normalize_posix;
use crate::home::homedir;

pub fn is_darwin() -> bool {
    cfg!(target_os = "macos")
}

/// Canonical comparison key: lowercased on macOS, the identity on Linux.
pub fn path_key(p: &str) -> String {
    if is_darwin() {
        p.to_lowercase()
    } else {
        p.to_string()
    }
}

fn trim_key(k: &str) -> &str {
    k.trim_end_matches('/')
}

pub fn same_path(a: &str, b: &str) -> bool {
    trim_key(&path_key(a)) == trim_key(&path_key(b))
}

/// Is `child` at or under `parent`? Boundary-aware; an empty or root-only parent matches nothing.
pub fn is_path_prefix(parent: &str, child: &str) -> bool {
    let pk = path_key(parent);
    let p = trim_key(&pk);
    if p.is_empty() {
        return false;
    }
    let ck = path_key(child);
    let c = trim_key(&ck);
    c == p || c.starts_with(&format!("{}/", p))
}

/// Replace a leading home directory with `~`.
pub fn collapse_home(p: &str) -> String {
    let home = homedir().to_string_lossy().into_owned();
    if !is_path_prefix(&home, p) {
        return p.to_string();
    }
    format!("~{}", &p[home.len().min(p.len())..])
}

/// `normalizeDataDir`: trim, expand `~`, require absolute, normalize, strip trailing separators.
pub fn normalize_data_dir(raw: &str) -> Option<String> {
    let mut p = raw.trim().to_string();
    if p.is_empty() || p.contains('\0') || p.contains('\r') || p.contains('\n') {
        return None;
    }
    let home = homedir().to_string_lossy().into_owned();
    if p == "~" {
        p = home;
    } else if let Some(rest) = p.strip_prefix("~/") {
        p = format!("{}/{}", home, rest);
    }
    if !p.starts_with('/') {
        return None;
    }
    let mut n = normalize_posix(&p);
    while n.len() > 1 && n.ends_with('/') {
        n.pop();
    }
    Some(n)
}
