//! Node's `path.win32`: the normalize, isAbsolute, join, resolve and relative
//! the TypeScript client calls through the ambient `path` module on Windows,
//! so hx2 spells a Windows path exactly as the client does. Pure string
//! functions, ported from Node's lib/path.js: they compile and are tested on
//! every platform, and only the Windows build calls them.
#![cfg_attr(not(windows), allow(dead_code))]

fn is_sep(c: u8) -> bool {
    c == b'/' || c == b'\\'
}

fn is_device_root(c: u8) -> bool {
    c.is_ascii_alphabetic()
}

/// Node's `normalizeString` with `\` as the separator: collapse `.`, `..` and
/// repeated separators. Works on bytes; every byte it compares is ASCII, so a
/// slice boundary never splits a UTF-8 sequence.
fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let b = path.as_bytes();
    let n = b.len();
    let mut res = String::new();
    let mut last_segment_length: usize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code: u8 = 0;
    let mut i: usize = 0;
    while i <= n {
        if i < n {
            code = b[i];
        } else if is_sep(code) {
            break;
        } else {
            code = b'/';
        }
        if is_sep(code) {
            if last_slash == i as isize - 1 || dots == 1 {
                // NOOP
            } else if dots == 2 {
                let rb = res.as_bytes();
                if res.len() < 2 || last_segment_length != 2 || rb[rb.len() - 1] != b'.' || rb[rb.len() - 2] != b'.' {
                    if res.len() > 2 {
                        match res.rfind('\\') {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(idx) => {
                                res.truncate(idx);
                                let last = res.rfind('\\').map(|x| x as isize).unwrap_or(-1);
                                last_segment_length = (res.len() as isize - 1 - last) as usize;
                            }
                        }
                        last_slash = i as isize;
                        dots = 0;
                        i += 1;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i as isize;
                        dots = 0;
                        i += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if res.is_empty() {
                        res.push_str("..");
                    } else {
                        res.push_str("\\..");
                    }
                    last_segment_length = 2;
                }
            } else {
                let seg = &path[(last_slash + 1) as usize..i];
                if res.is_empty() {
                    res = seg.to_string();
                } else {
                    res.push('\\');
                    res.push_str(seg);
                }
                last_segment_length = i - (last_slash + 1) as usize;
            }
            last_slash = i as isize;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

/// `path.win32.normalize`.
pub fn normalize(path: &str) -> String {
    let b = path.as_bytes();
    let len = b.len();
    if len == 0 {
        return ".".to_string();
    }
    let code = b[0];
    if len == 1 {
        return if code == b'/' { "\\".to_string() } else { path.to_string() };
    }
    let mut root_end = 0usize;
    let mut device: Option<String> = None;
    let mut is_absolute = false;
    if is_sep(code) {
        // Possible UNC root; a leading separator is absolute either way.
        is_absolute = true;
        if is_sep(b[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep(b[j]) {
                j += 1;
            }
            if j < len && j != last {
                let first_part = &path[last..j];
                last = j;
                while j < len && is_sep(b[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(b[j]) {
                        j += 1;
                    }
                    if j == len {
                        // A UNC root alone.
                        return format!("\\\\{}\\{}\\", first_part, &path[last..]);
                    }
                    if j != last {
                        device = Some(format!("\\\\{}\\{}", first_part, &path[last..j]));
                        root_end = j;
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else if is_device_root(code) && b[1] == b':' {
        device = Some(path[..2].to_string());
        root_end = 2;
        if len > 2 && is_sep(b[2]) {
            is_absolute = true;
            root_end = 3;
        }
    }
    let mut tail = if root_end < len { normalize_string(&path[root_end..], !is_absolute) } else { String::new() };
    if tail.is_empty() && !is_absolute {
        tail = ".".to_string();
    }
    if !tail.is_empty() && is_sep(b[len - 1]) {
        tail.push('\\');
    }
    match device {
        None => {
            if is_absolute {
                format!("\\{}", tail)
            } else {
                tail
            }
        }
        Some(d) => {
            if is_absolute {
                format!("{}\\{}", d, tail)
            } else {
                format!("{}{}", d, tail)
            }
        }
    }
}

/// `path.win32.isAbsolute`.
pub fn is_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    if b.is_empty() {
        return false;
    }
    is_sep(b[0]) || (b.len() > 2 && is_device_root(b[0]) && b[1] == b':' && is_sep(b[2]))
}

/// `path.win32.join`.
pub fn join(parts: &[&str]) -> String {
    let non_empty: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    let first_part = match non_empty.first() {
        Some(f) => *f,
        None => return ".".to_string(),
    };
    let mut joined = non_empty.join("\\");
    // Make sure the joined path does not start with two separators, which
    // normalize would read as a UNC root, unless the first part is one.
    let fb = first_part.as_bytes();
    let mut needs_replace = true;
    let mut slash_count = 0usize;
    if is_sep(fb[0]) {
        slash_count += 1;
        if fb.len() > 1 && is_sep(fb[1]) {
            slash_count += 1;
            if fb.len() > 2 {
                if is_sep(fb[2]) {
                    slash_count += 1;
                } else {
                    needs_replace = false;
                }
            }
        }
    }
    if needs_replace {
        let jb = joined.as_bytes();
        while slash_count < jb.len() && is_sep(jb[slash_count]) {
            slash_count += 1;
        }
        if slash_count >= 2 {
            joined = format!("\\{}", &joined[slash_count..]);
        }
    }
    normalize(&joined)
}

/// `path.win32.resolve`, with the process's current directory and the
/// per-drive current directories (`=C:` in the environment) Node reads.
pub fn resolve(parts: &[&str]) -> String {
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    resolve_with(parts, &cwd, |device| std::env::var(format!("={}", device)).ok())
}

/// `resolve` with the current directories given, for the tests.
pub fn resolve_with(parts: &[&str], cwd: &str, drive_cwd: impl Fn(&str) -> Option<String>) -> String {
    let mut resolved_device = String::new();
    let mut resolved_tail = String::new();
    let mut resolved_absolute = false;
    let mut i = parts.len() as isize - 1;
    while i >= -1 {
        let path: String = if i >= 0 {
            let p = parts[i as usize];
            if p.is_empty() {
                i -= 1;
                continue;
            }
            p.to_string()
        } else if resolved_device.is_empty() {
            cwd.to_string()
        } else {
            // A drive letter without an absolute path: that drive's current
            // directory, else the process's, else the drive's root.
            let p = drive_cwd(&resolved_device).filter(|v| !v.is_empty()).unwrap_or_else(|| cwd.to_string());
            let pb = p.as_bytes();
            let other_drive = p.get(..2).map(|d| d.to_lowercase()) != Some(resolved_device.to_lowercase()) && pb.get(2) == Some(&b'\\');
            if other_drive {
                format!("{}\\", resolved_device)
            } else {
                p
            }
        };
        let b = path.as_bytes();
        let len = b.len();
        let mut root_end = 0usize;
        let mut device = String::new();
        let mut is_absolute = false;
        let code = b.first().copied().unwrap_or(0);
        if len == 1 {
            if is_sep(code) {
                root_end = 1;
                is_absolute = true;
            }
        } else if len > 1 && is_sep(code) {
            is_absolute = true;
            if is_sep(b[1]) {
                let mut j = 2;
                let mut last = j;
                while j < len && !is_sep(b[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    let first_part = &path[last..j];
                    last = j;
                    while j < len && is_sep(b[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !is_sep(b[j]) {
                            j += 1;
                        }
                        if j == len || j != last {
                            device = format!("\\\\{}\\{}", first_part, &path[last..j]);
                            root_end = j;
                        }
                    }
                }
            } else {
                root_end = 1;
            }
        } else if len > 1 && is_device_root(code) && b[1] == b':' {
            device = path[..2].to_string();
            root_end = 2;
            if len > 2 && is_sep(b[2]) {
                is_absolute = true;
                root_end = 3;
            }
        }
        if !device.is_empty() {
            if !resolved_device.is_empty() {
                if device.to_lowercase() != resolved_device.to_lowercase() {
                    // Another device: not applicable.
                    i -= 1;
                    continue;
                }
            } else {
                resolved_device = device;
            }
        }
        if resolved_absolute {
            if !resolved_device.is_empty() {
                break;
            }
        } else {
            resolved_tail = format!("{}\\{}", &path[root_end..], resolved_tail);
            resolved_absolute = is_absolute;
            if is_absolute && !resolved_device.is_empty() {
                break;
            }
        }
        i -= 1;
    }
    let tail = normalize_string(&resolved_tail, !resolved_absolute);
    if resolved_absolute {
        format!("{}\\{}", resolved_device, tail)
    } else {
        let s = format!("{}{}", resolved_device, tail);
        if s.is_empty() {
            ".".to_string()
        } else {
            s
        }
    }
}

/// `path.win32.relative`.
pub fn relative(from: &str, to: &str) -> String {
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    relative_with(from, to, &cwd)
}

/// `relative` with the current directory given, for the tests.
pub fn relative_with(from: &str, to: &str, cwd: &str) -> String {
    if from == to {
        return String::new();
    }
    let no_drive_cwd = |_: &str| None;
    let from_orig = resolve_with(&[from], cwd, no_drive_cwd);
    let to_orig = resolve_with(&[to], cwd, no_drive_cwd);
    if from_orig == to_orig {
        return String::new();
    }
    if from_orig.to_lowercase() == to_orig.to_lowercase() {
        return String::new();
    }
    // Node compares the lowercased strings and slices the original ones. The
    // walk below lowercases ASCII only, which keeps every byte where it was,
    // so each slice of the original lands on a character boundary.
    let from_l = from_orig.to_ascii_lowercase();
    let to_l = to_orig.to_ascii_lowercase();
    let fb = from_l.as_bytes();
    let tb = to_l.as_bytes();
    let mut from_start = 0usize;
    while from_start < fb.len() && fb[from_start] == b'\\' {
        from_start += 1;
    }
    let mut from_end = fb.len();
    while from_end > from_start + 1 && fb[from_end - 1] == b'\\' {
        from_end -= 1;
    }
    let from_len = from_end - from_start;
    let mut to_start = 0usize;
    while to_start < tb.len() && tb[to_start] == b'\\' {
        to_start += 1;
    }
    let mut to_end = tb.len();
    while to_end > to_start + 1 && tb[to_end - 1] == b'\\' {
        to_end -= 1;
    }
    let to_len = to_end - to_start;
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0usize;
    while i < length {
        let fc = fb[from_start + i];
        if fc != tb[to_start + i] {
            break;
        } else if fc == b'\\' {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    if i != length {
        if last_common_sep == -1 {
            return to_orig;
        }
    } else {
        if to_len > length {
            if tb[to_start + i] == b'\\' {
                // `from` is the exact base path of `to`.
                return to_orig[to_start + i + 1..].to_string();
            }
            if i == 2 {
                // `from` is the device root.
                return to_orig[to_start + i..].to_string();
            }
        }
        if from_len > length {
            if fb[from_start + i] == b'\\' {
                // `to` is the exact base path of `from`.
                last_common_sep = i as isize;
            } else if i == 2 {
                // `to` is the device root.
                last_common_sep = 3;
            }
        }
        if last_common_sep == -1 {
            last_common_sep = 0;
        }
    }
    let mut out = String::new();
    let mut k = from_start as isize + last_common_sep + 1;
    while k <= from_end as isize {
        let ku = k as usize;
        if ku == from_end || fb[ku] == b'\\' {
            out.push_str(if out.is_empty() { ".." } else { "\\.." });
        }
        k += 1;
    }
    let mut to_start = (to_start as isize + last_common_sep) as usize;
    if !out.is_empty() {
        return format!("{}{}", out, &to_orig[to_start..to_end]);
    }
    if to_orig.as_bytes().get(to_start) == Some(&b'\\') {
        to_start += 1;
    }
    to_orig[to_start..to_end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values from Node's own test suite (test/parallel/test-path-*.js).

    #[test]
    fn normalize_matches_node() {
        let cases = [
            ("./fixtures///b/../b/c.js", "fixtures\\b\\c.js"),
            ("/foo/../../../bar", "\\bar"),
            ("a//b//../b", "a\\b"),
            ("a//b//./c", "a\\b\\c"),
            ("a//b//.", "a\\b"),
            ("//server/share/dir/file.ext", "\\\\server\\share\\dir\\file.ext"),
            ("/a/b/c/../../../x/y/z", "\\x\\y\\z"),
            ("C:", "C:."),
            ("C:..\\abc", "C:..\\abc"),
            ("C:..\\..\\abc\\..\\def", "C:..\\..\\def"),
            ("C:\\.", "C:\\"),
            ("file:stream", "file:stream"),
            ("bar\\foo..\\..\\", "bar\\"),
            ("bar\\foo..\\..", "bar"),
            ("bar\\foo..\\..\\baz", "bar\\baz"),
            ("bar\\foo..\\", "bar\\foo..\\"),
            ("bar\\foo..", "bar\\foo.."),
            ("..\\foo..\\..\\..\\bar", "..\\..\\bar"),
            ("..\\...\\..\\.\\...\\..\\..\\bar", "..\\..\\bar"),
            ("../../../foo/../../../bar", "..\\..\\..\\..\\..\\bar"),
            ("../../../foo/../../../bar/../../", "..\\..\\..\\..\\..\\..\\"),
            ("../foobar/barfoo/foo/../../../bar/../../", "..\\..\\"),
            ("../.../../foobar/../../../bar/../../baz", "..\\..\\..\\..\\baz"),
            ("foo/bar\\baz", "foo\\bar\\baz"),
            ("C:/Users/Me/AppData/Roaming/", "C:\\Users\\Me\\AppData\\Roaming\\"),
        ];
        for (input, want) in cases {
            assert_eq!(normalize(input), want, "normalize({:?})", input);
        }
    }

    #[test]
    fn is_absolute_matches_node() {
        for p in ["/", "//", "//server", "//server/file", "\\\\server\\file", "\\\\server", "\\\\", "c:\\", "c:/", "C:\\Users\\"] {
            assert!(is_absolute(p), "{:?} is absolute", p);
        }
        for p in ["", "c", "c:", "directory/directory", "directory\\directory"] {
            assert!(!is_absolute(p), "{:?} is relative", p);
        }
    }

    #[test]
    fn join_matches_node() {
        let cases: [(&[&str], &str); 16] = [
            (&["//foo/bar"], "\\\\foo\\bar\\"),
            (&["\\/foo/bar"], "\\\\foo\\bar\\"),
            (&["\\\\foo/bar"], "\\\\foo\\bar\\"),
            (&["//foo", "bar"], "\\\\foo\\bar\\"),
            (&["//foo/", "bar"], "\\\\foo\\bar\\"),
            (&["//foo", "/bar"], "\\\\foo\\bar\\"),
            (&["//foo", "", "bar"], "\\\\foo\\bar\\"),
            (&["", "//foo", "bar"], "\\\\foo\\bar\\"),
            (&["//", "foo/bar"], "\\foo\\bar"),
            (&["//", "/foo/bar"], "\\foo\\bar"),
            (&["\\\\", "/", "/foo/bar"], "\\foo\\bar"),
            (&["//"], "\\"),
            (&["c:"], "c:."),
            (&["c:.", "file"], "c:file"),
            (&["c:", "/"], "c:\\"),
            (&["C:\\Users\\Me", ".let", "hx"], "C:\\Users\\Me\\.let\\hx"),
        ];
        for (parts, want) in cases {
            assert_eq!(join(parts), want, "join({:?})", parts);
        }
        assert_eq!(join(&["C:\\Users\\Me\\AppData\\Roaming", "Claude"]), "C:\\Users\\Me\\AppData\\Roaming\\Claude");
        assert_eq!(join(&[]), ".");
    }

    #[test]
    fn resolve_matches_node() {
        let cwd = "C:\\cwd";
        let none = |_: &str| None;
        let cases: [(&[&str], &str); 10] = [
            (&["c:/blah\\blah", "d:/games", "c:../a"], "c:\\blah\\a"),
            (&["c:/ignore", "d:\\a/b\\c/d", "\\e.exe"], "d:\\e.exe"),
            (&["c:/ignore", "c:/some/file"], "c:\\some\\file"),
            (&["d:/ignore", "d:some/dir//"], "d:\\ignore\\some\\dir"),
            (&["//server/share", "..", "relative\\"], "\\\\server\\share\\relative"),
            (&["c:/", "//"], "c:\\"),
            (&["c:/", "//dir"], "c:\\dir"),
            (&["c:/", "//server/share"], "\\\\server\\share\\"),
            (&["c:/", "//server//share"], "\\\\server\\share\\"),
            (&["c:/", "///some//dir"], "c:\\some\\dir"),
        ];
        for (parts, want) in cases {
            assert_eq!(resolve_with(parts, cwd, none), want, "resolve({:?})", parts);
        }
        assert_eq!(resolve_with(&["C:\\repo\\wt", "../main/.git/worktrees/wt"], cwd, none), "C:\\repo\\main\\.git\\worktrees\\wt");
        assert_eq!(resolve_with(&["C:\\repo\\wt", "C:/repo/main/.git/worktrees/wt"], cwd, none), "C:\\repo\\main\\.git\\worktrees\\wt");
        assert_eq!(resolve_with(&["C:\\repo\\.git\\worktrees\\wt", "../.."], cwd, none), "C:\\repo\\.git");
        assert_eq!(resolve_with(&["relative"], cwd, none), "C:\\cwd\\relative");
    }

    #[test]
    fn relative_matches_node() {
        let cwd = "C:\\cwd";
        let cases = [
            ("c:/blah\\blah", "d:/games", "d:\\games"),
            ("c:/aaaa/bbbb", "c:/aaaa", ".."),
            ("c:/aaaa/bbbb", "c:/cccc", "..\\..\\cccc"),
            ("c:/aaaa/bbbb", "c:/aaaa/bbbb", ""),
            ("c:/aaaa/bbbb", "c:/aaaa/cccc", "..\\cccc"),
            ("c:/aaaa/", "c:/aaaa/cccc", "cccc"),
            ("c:/", "c:\\aaaa\\bbbb", "aaaa\\bbbb"),
            ("c:/aaaa/bbbb", "d:\\", "d:\\"),
            ("c:/AaAa/bbbb", "c:/aaaa/bbbb", ""),
            ("c:/aaaaa/", "c:/aaaa/cccc", "..\\aaaa\\cccc"),
            ("C:\\foo\\bar\\baz\\quux", "C:\\", "..\\..\\..\\.."),
            ("C:\\foo\\test", "C:\\foo\\test\\bar\\package.json", "bar\\package.json"),
            ("C:\\foo\\bar\\baz-quux", "C:\\foo\\bar\\baz", "..\\baz"),
            ("C:\\foo\\bar\\baz", "C:\\foo\\bar\\baz-quux", "..\\baz-quux"),
            ("\\\\foo\\bar", "\\\\foo\\bar\\baz", "baz"),
            ("\\\\foo\\bar\\baz", "\\\\foo\\bar", ".."),
            ("\\\\foo\\bar\\baz-quux", "\\\\foo\\bar\\baz", "..\\baz"),
            ("\\\\foo\\bar\\baz", "\\\\foo\\bar\\baz-quux", "..\\baz-quux"),
            ("C:\\baz-quux", "C:\\baz", "..\\baz"),
            ("C:\\baz", "C:\\baz-quux", "..\\baz-quux"),
            ("\\\\foo\\baz-quux", "\\\\foo\\baz", "..\\baz"),
            ("\\\\foo\\baz", "\\\\foo\\baz-quux", "..\\baz-quux"),
            ("C:\\baz", "\\\\foo\\bar\\baz", "\\\\foo\\bar\\baz"),
            ("\\\\foo\\bar\\baz", "C:\\baz", "C:\\baz"),
            ("C:\\Users\\Me", "C:\\Users\\Me\\.claude\\projects\\p\\s.jsonl", ".claude\\projects\\p\\s.jsonl"),
        ];
        for (from, to, want) in cases {
            assert_eq!(relative_with(from, to, cwd), want, "relative({:?}, {:?})", from, to);
        }
    }
}
