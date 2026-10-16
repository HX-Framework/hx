//! Path normalization and canonical comparison (src/pathnorm.ts).

use crate::fsutil::normalize_posix;
use crate::home::homedir;

/// How a platform spells one directory several ways: Windows folds the
/// separator and the case, macOS the case, Linux nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fold {
    Windows,
    Darwin,
    Exact,
}

const HOST: Fold = if cfg!(windows) {
    Fold::Windows
} else if cfg!(target_os = "macos") {
    Fold::Darwin
} else {
    Fold::Exact
};

/// Canonical comparison key: separators folded to `/` and lowercased on
/// Windows, lowercased on macOS, the identity on Linux.
pub fn path_key(p: &str) -> String {
    path_key_for(p, HOST)
}

fn path_key_for(p: &str, fold: Fold) -> String {
    match fold {
        Fold::Windows => p.replace('\\', "/").to_lowercase(),
        Fold::Darwin => p.to_lowercase(),
        Fold::Exact => p.to_string(),
    }
}

fn trim_key(k: &str) -> &str {
    k.trim_end_matches('/')
}

pub fn same_path(a: &str, b: &str) -> bool {
    same_path_for(a, b, HOST)
}

fn same_path_for(a: &str, b: &str, fold: Fold) -> bool {
    trim_key(&path_key_for(a, fold)) == trim_key(&path_key_for(b, fold))
}

/// Is `child` at or under `parent`? Boundary-aware; an empty or root-only parent matches nothing.
pub fn is_path_prefix(parent: &str, child: &str) -> bool {
    is_path_prefix_for(parent, child, HOST)
}

fn is_path_prefix_for(parent: &str, child: &str, fold: Fold) -> bool {
    let pk = path_key_for(parent, fold);
    let p = trim_key(&pk);
    if p.is_empty() {
        return false;
    }
    let ck = path_key_for(child, fold);
    let c = trim_key(&ck);
    c == p || c.starts_with(&format!("{}/", p))
}

/// Replace a leading home directory with `~`.
pub fn collapse_home(p: &str) -> String {
    collapse_home_for(p, &homedir().to_string_lossy(), HOST)
}

fn collapse_home_for(p: &str, home: &str, fold: Fold) -> String {
    if !is_path_prefix_for(home, p, fold) {
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
    if cfg!(windows) {
        return normalize_data_dir_win32(&p, &home);
    }
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

/// The same funnel under `path.win32`: `~/` still expands (with join), and a
/// trailing `\` is a separator to strip as well as `/`.
fn normalize_data_dir_win32(trimmed: &str, home: &str) -> Option<String> {
    let p = if trimmed == "~" {
        home.to_string()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        crate::winpath::join(&[home, rest])
    } else {
        trimmed.to_string()
    };
    if !crate::winpath::is_absolute(&p) {
        return None;
    }
    let mut n = crate::winpath::normalize(&p);
    while n.len() > 1 && (n.ends_with('/') || n.ends_with('\\')) {
        n.pop();
    }
    Some(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    // src/pathnorm.test.ts, case for case.

    #[test]
    fn path_key_per_platform() {
        assert_eq!(path_key_for("/home/me/Work", Fold::Exact), "/home/me/Work");
        assert_eq!(path_key_for("/home/me/a\\b", Fold::Exact), "/home/me/a\\b");
        assert_eq!(path_key_for("C:\\Users\\Me\\Proj", Fold::Windows), "c:/users/me/proj");
        assert_eq!(path_key_for("C:/Users/Me/Proj", Fold::Windows), "c:/users/me/proj");
        assert_eq!(path_key_for("/Users/Me/Work", Fold::Darwin), "/users/me/work");
        assert_eq!(path_key_for("/Users/Me/a\\b", Fold::Darwin), "/users/me/a\\b");
    }

    #[test]
    fn same_path_per_platform() {
        assert!(same_path_for("C:\\Users\\Me", "c:\\Users\\Me", Fold::Windows));
        assert!(same_path_for("C:\\Users\\Me", "C:/Users/Me/", Fold::Windows));
        assert!(!same_path_for("/home/me/Work", "/home/me/work", Fold::Exact));
    }

    #[test]
    fn is_path_prefix_per_platform() {
        assert!(is_path_prefix_for("C:\\Users\\Me", "C:\\Users\\Me\\proj", Fold::Windows));
        assert!(is_path_prefix_for("~\\Desktop", "~\\Desktop\\app", Fold::Windows));
        assert!(!is_path_prefix_for("~/a", "~/ab", Fold::Exact));
        assert!(!is_path_prefix_for("C:\\Users\\Me", "C:\\Users\\Median", Fold::Windows));
        assert!(is_path_prefix_for("~/a", "~/a", Fold::Exact));
        assert!(is_path_prefix_for("~/a/", "~/a", Fold::Exact));
        assert!(!is_path_prefix_for("", "~/anything", Fold::Exact));
        assert!(!is_path_prefix_for("/", "/anything", Fold::Exact));
    }

    #[test]
    fn collapse_home_per_platform() {
        assert_eq!(collapse_home_for("C:\\Users\\Me\\Desktop", "C:\\Users\\Me", Fold::Windows), "~\\Desktop");
        assert_eq!(collapse_home_for("c:\\Users\\Me\\Desktop", "C:\\Users\\Me", Fold::Windows), "~\\Desktop");
        assert_eq!(collapse_home_for("/home/me/MyApp", "/home/me", Fold::Exact), "~/MyApp");
        assert_eq!(collapse_home_for("/home/bobby/x", "/home/bob", Fold::Exact), "/home/bobby/x");
        assert_eq!(collapse_home_for("/opt/data", "/home/me", Fold::Exact), "/opt/data");
    }

    #[test]
    fn normalize_data_dir_on_windows() {
        let home = "C:\\Users\\Me";
        assert_eq!(normalize_data_dir_win32("~/data", home).as_deref(), Some("C:\\Users\\Me\\data"));
        assert_eq!(normalize_data_dir_win32("~", home).as_deref(), Some("C:\\Users\\Me"));
        assert_eq!(normalize_data_dir_win32("D:/work/claude/", home).as_deref(), Some("D:\\work\\claude"));
        assert_eq!(normalize_data_dir_win32("D:\\a\\.\\b\\..\\c\\", home).as_deref(), Some("D:\\a\\c"));
        assert_eq!(normalize_data_dir_win32("relative\\path", home), None);
        assert_eq!(normalize_data_dir_win32("C:relative", home), None);
    }
}
