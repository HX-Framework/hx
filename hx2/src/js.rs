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

/// `(n / 2^exp).toFixed(digits)` for a non-negative integer `n`: the
/// quotient is exact as a double (a power of two divides exactly), and
/// `toFixed` picks the nearest decimal, the larger one on a tie.
pub fn to_fixed_div_pow2(n: u64, exp: u32, digits: u32) -> String {
    let scale: u128 = 10u128.pow(digits);
    let q: u128 = (n as u128) * scale;
    let denom: u128 = 1u128 << exp;
    let r = (2 * q + denom) / (2 * denom);
    let int = r / scale;
    let frac = r % scale;
    if digits == 0 {
        format!("{}", int)
    } else {
        format!("{}.{:0width$}", int, frac, width = digits as usize)
    }
}

/// `x.toFixed(digits)` for a finite double: half away from zero on the
/// scaled value, the way the specification's "larger n" rule reads for the
/// magnitudes this client prints (rates, sizes).
pub fn to_fixed(x: f64, digits: u32) -> String {
    if !x.is_finite() {
        return num_to_string(x);
    }
    let neg = x < 0.0;
    let scale = 10f64.powi(digits as i32);
    let r = ((x.abs() * scale) + 0.5).floor() as i128;
    let s = 10i128.pow(digits);
    let body = if digits == 0 { format!("{}", r) } else { format!("{}.{:0width$}", r / s, r % s, width = digits as usize) };
    if neg && r != 0 {
        format!("-{}", body)
    } else {
        body
    }
}

/// `n.toLocaleString("en-US")` for an integral number: thousands separators.
pub fn to_locale_string_int(n: f64) -> String {
    if !n.is_finite() || n.fract() != 0.0 {
        return num_to_string(n);
    }
    let neg = n < 0.0;
    let digits = format!("{}", n.abs() as i128);
    let mut out = String::new();
    let len = digits.len();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if neg {
        format!("-{}", out)
    } else {
        out
    }
}

/// `a.localeCompare(b)` as the default collator orders the names this client
/// sorts (file names, "family:sessionId" keys): letters compare without
/// case first, a lowercase letter before its uppercase twin on a tie.
pub fn js_locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let la: Vec<char> = a.chars().flat_map(|c| c.to_lowercase()).collect();
    let lb: Vec<char> = b.chars().flat_map(|c| c.to_lowercase()).collect();
    match la.cmp(&lb) {
        std::cmp::Ordering::Equal => {
            // Tertiary: lowercase first.
            let ta: Vec<u8> = a.chars().map(|c| if c.is_uppercase() { 1 } else { 0 }).collect();
            let tb: Vec<u8> = b.chars().map(|c| if c.is_uppercase() { 1 } else { 0 }).collect();
            ta.cmp(&tb)
        }
        o => o,
    }
}

const MONTHS_SHORT: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// `new Date(ms).toISOString()`: milliseconds, UTC.
pub fn iso_string(ms: f64) -> String {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms.trunc() as i64);
    match dt {
        Some(d) => d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        None => "Invalid Date".to_string(),
    }
}

/// `new Date(ms).toISOString().slice(0, 10)`.
pub fn iso_date(ms: f64) -> String {
    let s = iso_string(ms);
    s.chars().take(10).collect()
}

/// `Intl.DateTimeFormat("en", { month: "short", day: "numeric"[, year: "numeric"] })`
/// over a (year, month, day): "Oct 16" or "Oct 16, 2026".
pub fn en_month_day(year: i32, month: u32, day: u32, with_year: bool) -> String {
    let m = MONTHS_SHORT[((month.max(1) - 1) % 12) as usize];
    if with_year {
        format!("{} {}, {}", m, day, year)
    } else {
        format!("{} {}", m, day)
    }
}

/// `new Date(ms)` in the process's local time zone.
pub fn local_datetime(ms: f64) -> Option<chrono::DateTime<chrono::Local>> {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ms.trunc() as i64).single()
}

/// `new Date(ms).toLocaleString()` under en-US: "10/16/2026, 9:12:34 PM".
pub fn to_locale_string_en_us(ms: f64) -> String {
    use chrono::{Datelike, Timelike};
    let d = match local_datetime(ms) {
        Some(d) => d,
        None => return "Invalid Date".to_string(),
    };
    let (pm, h12) = d.hour12();
    format!("{}/{}/{}, {}:{:02}:{:02} {}", d.month(), d.day(), d.year(), h12, d.minute(), d.second(), if pm { "PM" } else { "AM" })
}

/// `new Date(ms).toLocaleTimeString()` under en-US: "9:12:34 PM".
pub fn to_locale_time_string_en_us(ms: f64) -> String {
    use chrono::Timelike;
    let d = match local_datetime(ms) {
        Some(d) => d,
        None => return "Invalid Date".to_string(),
    };
    let (pm, h12) = d.hour12();
    format!("{}:{:02}:{:02} {}", h12, d.minute(), d.second(), if pm { "PM" } else { "AM" })
}
