//! Strings the way JavaScript holds them, stored as WTF-8.
//!
//! A JavaScript string is UTF-16 code units, and a `\ud83d` escape in a JSON
//! file gives `JSON.parse` a string with a lone surrogate in it. WTF-8 is
//! UTF-8 for every well-formed string, with a lone surrogate kept as the
//! three bytes UTF-8 would give its code point: one byte per ASCII character
//! instead of the two a `Vec<u16>` takes, and every string still converts
//! back to exactly the code units `JSON.parse` produced, so it is written
//! back the way `JSON.stringify` writes it.

use std::borrow::Cow;
use std::fmt::Write as _;

use crate::js::{is_space, JsStr};

/// Append one code point, a lone surrogate included, as generalized UTF-8.
fn push_code_point(out: &mut Vec<u8>, cp: u32) {
    if cp < 0x80 {
        out.push(cp as u8);
    } else if cp < 0x800 {
        out.push(0xC0 | (cp >> 6) as u8);
        out.push(0x80 | (cp & 0x3F) as u8);
    } else if cp < 0x1_0000 {
        out.push(0xE0 | (cp >> 12) as u8);
        out.push(0x80 | ((cp >> 6) & 0x3F) as u8);
        out.push(0x80 | (cp & 0x3F) as u8);
    } else {
        out.push(0xF0 | (cp >> 18) as u8);
        out.push(0x80 | ((cp >> 12) & 0x3F) as u8);
        out.push(0x80 | ((cp >> 6) & 0x3F) as u8);
        out.push(0x80 | (cp & 0x3F) as u8);
    }
}

/// Append one UTF-16 code unit. A low surrogate right after a lone high one
/// joins it into the pair's code point: in JavaScript the two units are one
/// character.
pub fn push_unit(out: &mut Vec<u8>, unit: u16) {
    let u = unit as u32;
    if (0xDC00..=0xDFFF).contains(&u) {
        let n = out.len();
        if n >= 3 && out[n - 3] == 0xED && (0xA0..=0xAF).contains(&out[n - 2]) {
            let high = 0xD000 | (((out[n - 2] & 0x3F) as u32) << 6) | ((out[n - 1] & 0x3F) as u32);
            out.truncate(n - 3);
            push_code_point(out, 0x1_0000 + ((high - 0xD800) << 10) + (u - 0xDC00));
            return;
        }
    }
    push_code_point(out, u);
}

/// UTF-16 code units as WTF-8.
pub fn from_units(units: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(units.len());
    for &u in units {
        push_unit(&mut out, u);
    }
    out
}

fn cont(b: &[u8], i: usize) -> u32 {
    b.get(i).map(|&x| (x & 0x3F) as u32).unwrap_or(0)
}

/// The code points of a WTF-8 string, surrogates included.
struct CodePoints<'a> {
    b: &'a [u8],
    i: usize,
}

impl Iterator for CodePoints<'_> {
    type Item = u32;

    fn next(&mut self) -> Option<u32> {
        let (b, i) = (self.b, self.i);
        let c = *b.get(i)? as u32;
        let (cp, len) = if c < 0x80 {
            (c, 1)
        } else if c < 0xE0 {
            (((c & 0x1F) << 6) | cont(b, i + 1), 2)
        } else if c < 0xF0 {
            (((c & 0x0F) << 12) | (cont(b, i + 1) << 6) | cont(b, i + 2), 3)
        } else {
            (((c & 0x07) << 18) | (cont(b, i + 1) << 12) | (cont(b, i + 2) << 6) | cont(b, i + 3), 4)
        };
        self.i = i + len;
        Some(cp)
    }
}

fn code_points(b: &[u8]) -> CodePoints<'_> {
    CodePoints { b, i: 0 }
}

/// WTF-8 as UTF-16 code units.
pub fn to_units(b: &[u8]) -> JsStr {
    let mut out = Vec::with_capacity(b.len());
    for cp in code_points(b) {
        if cp >= 0x1_0000 {
            let v = cp - 0x1_0000;
            out.push(0xD800 + (v >> 10) as u16);
            out.push(0xDC00 + (v & 0x3FF) as u16);
        } else {
            out.push(cp as u16);
        }
    }
    out
}

/// WTF-8 as a Rust string: as it is when well-formed, a lone surrogate
/// becoming U+FFFD, which is what encoding the JavaScript string as UTF-8
/// (a path handed to the operating system, say) does.
pub fn lossy(b: &[u8]) -> Cow<'_, str> {
    match std::str::from_utf8(b) {
        Ok(s) => Cow::Borrowed(s),
        Err(_) => Cow::Owned(String::from_utf16_lossy(&to_units(b))),
    }
}

/// `s.trim() !== ""`: the string holds a character `String.prototype.trim` keeps.
pub fn has_non_space(b: &[u8]) -> bool {
    code_points(b).any(|cp| cp > 0xFFFF || !is_space(cp as u16))
}

fn push_utf8(out: &mut String, seg: &[u8]) {
    match std::str::from_utf8(seg) {
        Ok(s) => out.push_str(s),
        Err(_) => out.push_str(&String::from_utf8_lossy(seg)),
    }
}

/// The inside of the quotes `JSON.stringify` writes for a string: `"`, `\`
/// and the control characters escaped (the short forms where JSON has them,
/// `\u00xx` otherwise), a lone surrogate as `\udxxx`, everything else as it
/// is.
pub fn write_json_body(out: &mut String, b: &[u8]) {
    let mut run = 0;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let surrogate = c == 0xED && b.get(i + 1).map_or(false, |&n| n >= 0xA0);
        if c >= 0x20 && c != b'"' && c != b'\\' && !surrogate {
            i += 1;
            continue;
        }
        push_utf8(out, &b[run..i]);
        if surrogate {
            let unit = 0xD000 | (cont(b, i + 1) << 6) | cont(b, i + 2);
            let _ = write!(out, "\\u{:04x}", unit);
            i = (i + 3).min(b.len());
        } else {
            match c {
                b'"' => out.push_str("\\\""),
                b'\\' => out.push_str("\\\\"),
                0x08 => out.push_str("\\b"),
                0x0C => out.push_str("\\f"),
                0x0A => out.push_str("\\n"),
                0x0D => out.push_str("\\r"),
                0x09 => out.push_str("\\t"),
                _ => {
                    let _ = write!(out, "\\u{:04x}", c);
                }
            }
            i += 1;
        }
        run = i;
    }
    push_utf8(out, &b[run..]);
}

/// A string as `JSON.stringify` writes it, quotes included.
pub fn write_json(out: &mut String, b: &[u8]) {
    out.push('"');
    write_json_body(out, b);
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::js;
    use crate::json::write_js_string;

    fn json_of_units(units: &[u16]) -> String {
        let mut s = String::new();
        write_js_string(&mut s, units);
        s
    }

    #[test]
    fn round_trips_every_kind_of_unit() {
        let cases: Vec<Vec<u16>> = vec![
            js("plain ascii"),
            js("café — 日本語 😀"),
            vec![0xD83D],                 // lone high surrogate
            vec![0xDE00],                 // lone low surrogate
            vec![0xDE00, 0xD83D],         // low then high: two lone ones
            vec![0x61, 0xD83D, 0xDE00],   // a pair from separate units
            vec![0xD83D, 0x61, 0xDE00],   // a high and a low split by a letter
            vec![0x00, 0x1F, 0x22, 0x5C, 0x7F, 0x2028],
        ];
        for units in cases {
            let w = from_units(&units);
            assert_eq!(to_units(&w), units);
            let mut out = String::new();
            write_json(&mut out, &w);
            assert_eq!(out, json_of_units(&units), "JSON of {:?}", units);
        }
    }

    #[test]
    fn a_pair_built_unit_by_unit_is_utf8() {
        let mut w = Vec::new();
        push_unit(&mut w, 0xD83D);
        push_unit(&mut w, 0xDE00);
        assert_eq!(std::str::from_utf8(&w).unwrap(), "😀");
    }

    #[test]
    fn lossy_turns_a_lone_surrogate_into_one_replacement_character() {
        assert_eq!(lossy(&from_units(&[0x61, 0xD800, 0x62])), "a\u{FFFD}b");
        assert!(matches!(lossy(b"local_abc"), Cow::Borrowed("local_abc")));
    }

    #[test]
    fn trim_follows_javascript() {
        assert!(!has_non_space(b""));
        assert!(!has_non_space(" \t\n\u{00A0}\u{FEFF}\u{3000}".as_bytes()));
        assert!(has_non_space(" x ".as_bytes()));
        assert!(has_non_space(&from_units(&[0x20, 0xD800])));
    }

    #[test]
    fn escapes_what_json_stringify_escapes() {
        let mut out = String::new();
        write_json(&mut out, "a\"b\\c\u{8}\u{c}\n\r\t\u{1}\u{7f}é".as_bytes());
        assert_eq!(out, "\"a\\\"b\\\\c\\b\\f\\n\\r\\t\\u0001\u{7f}é\"");
    }
}
