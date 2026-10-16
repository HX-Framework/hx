//! JavaScript string and number semantics.
//!
//! The TypeScript client measures, cuts and trims text in UTF-16 code units
//! (`.length`, `.slice`, `.trim`), and `JSON.stringify` formats numbers the
//! JavaScript way (`1` for `1.0`, the shortest round-trip digits otherwise).
//! Every byte the gateway stores or compares that passes through such an
//! operation has to come out identical, so strings that flow into request
//! bodies are kept as UTF-16 code units here and converted to UTF-8 only at
//! the edge (json.rs), where a lone surrogate is written the way
//! `JSON.stringify` writes it.

pub type JsStr = Vec<u16>;

/// A Rust string as UTF-16 code units.
pub fn js(s: &str) -> JsStr {
    s.encode_utf16().collect()
}

/// UTF-16 code units as a Rust string; a lone surrogate becomes U+FFFD, which
/// is what `Buffer.from(s, "utf8").toString("utf8")` does in the client.
pub fn lossy(s: &[u16]) -> String {
    String::from_utf16_lossy(s)
}

/// `\s` of a JavaScript regular expression and the set `String.prototype.trim` removes.
pub fn is_space(c: u16) -> bool {
    matches!(
        c,
        0x09 | 0x0A
            | 0x0B
            | 0x0C
            | 0x0D
            | 0x20
            | 0xA0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

pub fn trim(s: &[u16]) -> &[u16] {
    let mut a = 0;
    let mut b = s.len();
    while a < b && is_space(s[a]) {
        a += 1;
    }
    while b > a && is_space(s[b - 1]) {
        b -= 1;
    }
    &s[a..b]
}

/// `s.slice(start, end)` for non-negative indices, clamped like JavaScript.
pub fn slice(s: &[u16], start: usize, end: usize) -> &[u16] {
    let end = end.min(s.len());
    let start = start.min(end);
    &s[start..end]
}

pub fn eq_str(s: &[u16], lit: &str) -> bool {
    let mut it = lit.encode_utf16();
    for &c in s {
        match it.next() {
            Some(d) if d == c => {}
            _ => return false,
        }
    }
    it.next().is_none()
}

pub fn starts_with(s: &[u16], prefix: &str) -> bool {
    let p = js(prefix);
    s.len() >= p.len() && s[..p.len()] == p[..]
}

pub fn ends_with(s: &[u16], suffix: &str) -> bool {
    let p = js(suffix);
    s.len() >= p.len() && s[s.len() - p.len()..] == p[..]
}

pub fn contains(s: &[u16], needle: &str) -> bool {
    index_of(s, &js(needle)).is_some()
}

pub fn index_of(s: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if needle.len() > s.len() {
        return None;
    }
    (0..=s.len() - needle.len()).find(|&i| &s[i..i + needle.len()] == needle)
}

pub fn last_index_of_unit(s: &[u16], c: u16) -> Option<usize> {
    s.iter().rposition(|&x| x == c)
}

/// `s.split("\n")`: every piece, empty ones included.
pub fn split_unit(s: &[u16], c: u16) -> Vec<&[u16]> {
    s.split(|&x| x == c).collect()
}

pub fn concat(parts: &[&[u16]]) -> JsStr {
    let mut out = Vec::with_capacity(parts.iter().map(|p| p.len()).sum());
    for p in parts {
        out.extend_from_slice(p);
    }
    out
}

/// `s.replace(/\s+/g, " ")`.
pub fn collapse_spaces(s: &[u16]) -> JsStr {
    let mut out = Vec::with_capacity(s.len());
    let mut in_space = false;
    for &c in s {
        if is_space(c) {
            if !in_space {
                out.push(0x20);
                in_space = true;
            }
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `Number.prototype.toString` / `JSON.stringify` for a finite number.
pub fn num_to_string(v: f64) -> String {
    if v.is_nan() || v.is_infinite() {
        return "null".to_string();
    }
    if v == 0.0 {
        return "0".to_string();
    }
    if v.fract() == 0.0 && v.abs() < 1e21 {
        return format!("{}", v as i128);
    }
    format!("{}", v)
}

/// `Math.round`: halves round toward positive infinity.
pub fn math_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// `String(x).padStart(2, "0")` for a small non-negative integer.
pub fn pad2(n: u32) -> String {
    format!("{:02}", n)
}
