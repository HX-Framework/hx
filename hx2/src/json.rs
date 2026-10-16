//! JSON with JavaScript's semantics: `JSON.parse` and `JSON.stringify` as the
//! client uses them.
//!
//! Objects keep insertion order and an assignment to an existing key keeps
//! its position (so `state.json` is laid out as the client lays it out).
//! Strings are UTF-16 code units (js.rs), so a `\ud83d` escape in a transcript
//! line parses to the lone surrogate `JSON.parse` yields, and is written back
//! as `\ud83d` the way `JSON.stringify` writes it. Numbers are doubles and
//! print the JavaScript way.

use std::collections::HashMap;
use std::fmt::Write as _;

use crate::js::{js, lossy, num_to_string, JsStr};

/// An object with few keys (a file entry, a request body) finds a key by a
/// linear scan; one past INDEX_FROM keys (the `files` registry, the
/// destination registry) carries a hash index beside its entries. Thousands
/// of small objects without an index each is what keeps the state small.
const INDEX_FROM: usize = 9;

#[derive(Clone, Debug, Default)]
pub struct OMap {
    entries: Vec<(String, Json)>,
    index: Option<HashMap<String, usize>>,
}

impl OMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(n: usize) -> Self {
        OMap { entries: Vec::with_capacity(n), index: None }
    }

    fn position(&self, k: &str) -> Option<usize> {
        match &self.index {
            Some(ix) => ix.get(k).copied(),
            None => self.entries.iter().position(|(key, _)| key.as_str() == k),
        }
    }

    pub fn get(&self, k: &str) -> Option<&Json> {
        self.position(k).map(|i| &self.entries[i].1)
    }

    pub fn get_mut(&mut self, k: &str) -> Option<&mut Json> {
        match self.position(k) {
            Some(i) => Some(&mut self.entries[i].1),
            None => None,
        }
    }

    pub fn contains(&self, k: &str) -> bool {
        self.position(k).is_some()
    }

    /// `obj[k] = v`: an existing key keeps its position.
    pub fn set(&mut self, k: &str, v: Json) {
        if let Some(i) = self.position(k) {
            self.entries[i].1 = v;
            return;
        }
        self.entries.push((k.to_string(), v));
        let n = self.entries.len();
        if let Some(ix) = self.index.as_mut() {
            ix.insert(k.to_string(), n - 1);
        } else if n >= INDEX_FROM {
            self.index = Some(self.entries.iter().enumerate().map(|(i, (key, _))| (key.clone(), i)).collect());
        }
    }

    /// `delete obj[k]`.
    pub fn remove(&mut self, k: &str) -> Option<Json> {
        let i = self.position(k)?;
        let (_, v) = self.entries.remove(i);
        if let Some(ix) = self.index.as_mut() {
            ix.remove(k);
            for (_, idx) in ix.iter_mut() {
                if *idx > i {
                    *idx -= 1;
                }
            }
        }
        Some(v)
    }

    /// Give back the slack a parse or a build left in the entry vector.
    pub fn shrink_to_fit(&mut self) {
        self.entries.shrink_to_fit();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Json)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&String, &mut Json)> {
        self.entries.iter_mut().map(|(k, v)| (&*k, v))
    }

    pub fn keys(&self) -> Vec<String> {
        self.entries.iter().map(|(k, _)| k.clone()).collect()
    }

    /// Replace the value at a key in place, or append it.
    pub fn entry_or_insert_with(&mut self, k: &str, make: impl FnOnce() -> Json) -> &mut Json {
        if !self.contains(k) {
            self.set(k, make());
        }
        self.get_mut(k).expect("just inserted")
    }
}

#[derive(Clone, Debug)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(JsStr),
    Arr(Vec<Json>),
    Obj(OMap),
}

impl Json {
    pub fn obj() -> Json {
        Json::Obj(OMap::new())
    }

    pub fn str(s: &str) -> Json {
        Json::Str(js(s))
    }

    pub fn num(v: f64) -> Json {
        Json::Num(v)
    }

    pub fn opt_str(s: Option<&str>) -> Json {
        match s {
            Some(s) => Json::str(s),
            None => Json::Null,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    pub fn as_str(&self) -> Option<&[u16]> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    /// A string value as UTF-8 (lossy), or None for any other type.
    pub fn as_string(&self) -> Option<String> {
        self.as_str().map(lossy)
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(v) => Some(*v),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_obj(&self) -> Option<&OMap> {
        match self {
            Json::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn as_obj_mut(&mut self) -> Option<&mut OMap> {
        match self {
            Json::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&Vec<Json>> {
        match self {
            Json::Arr(a) => Some(a),
            _ => None,
        }
    }

    /// `value[k]` on an object; None for a missing key or a non-object.
    pub fn get(&self, k: &str) -> Option<&Json> {
        self.as_obj().and_then(|o| o.get(k))
    }

    /// `typeof value[k] === "string"` as the string.
    pub fn get_string(&self, k: &str) -> Option<String> {
        self.get(k).and_then(|v| v.as_string())
    }

    pub fn get_f64(&self, k: &str) -> Option<f64> {
        self.get(k).and_then(|v| v.as_f64())
    }

    /// Set a key on an object value (no-op on other types).
    pub fn set(&mut self, k: &str, v: Json) {
        if let Json::Obj(o) = self {
            o.set(k, v);
        }
    }

    pub fn remove(&mut self, k: &str) {
        if let Json::Obj(o) = self {
            o.remove(k);
        }
    }

    /// JavaScript truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            Json::Null => false,
            Json::Bool(b) => *b,
            Json::Num(v) => *v != 0.0 && !v.is_nan(),
            Json::Str(s) => !s.is_empty(),
            Json::Arr(_) | Json::Obj(_) => true,
        }
    }

    /// `String(value)`.
    pub fn to_js_string(&self) -> JsStr {
        match self {
            Json::Null => js("null"),
            Json::Bool(b) => js(if *b { "true" } else { "false" }),
            Json::Num(v) => js(&num_to_string(*v)),
            Json::Str(s) => s.clone(),
            Json::Arr(a) => {
                let mut out: JsStr = Vec::new();
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(b',' as u16);
                    }
                    if !v.is_null() {
                        out.extend(v.to_js_string());
                    }
                }
                out
            }
            Json::Obj(_) => js("[object Object]"),
        }
    }

    pub fn parse(text: &str) -> Result<Json, ()> {
        let mut p = Parser { b: text.as_bytes(), i: 0 };
        p.ws();
        let v = p.value(0)?;
        p.ws();
        if p.i != p.b.len() {
            return Err(());
        }
        Ok(v)
    }

    /// `JSON.stringify(value)`.
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        write_value(&mut out, self, None, 0);
        out
    }

    /// `JSON.stringify(value)` into a buffer sized from the last result, so a
    /// multi-megabyte snapshot is not grown by doubling.
    pub fn stringify_with_capacity(&self, cap: usize) -> String {
        let mut out = String::with_capacity(cap);
        write_value(&mut out, self, None, 0);
        out
    }

    /// `JSON.stringify(value, null, 2)`.
    pub fn stringify_pretty(&self) -> String {
        let mut out = String::new();
        write_value(&mut out, self, Some(2), 0);
        out
    }
}

// ── Parser ──────────────────────────────────────────────────────────────────

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn value(&mut self, depth: usize) -> Result<Json, ()> {
        if depth > 512 {
            return Err(());
        }
        match self.peek().ok_or(())? {
            b'{' => self.object(depth),
            b'[' => self.array(depth),
            b'"' => Ok(Json::Str(self.string()?)),
            b't' => self.literal("true", Json::Bool(true)),
            b'f' => self.literal("false", Json::Bool(false)),
            b'n' => self.literal("null", Json::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(()),
        }
    }

    fn literal(&mut self, word: &str, v: Json) -> Result<Json, ()> {
        let w = word.as_bytes();
        if self.b.len() >= self.i + w.len() && &self.b[self.i..self.i + w.len()] == w {
            self.i += w.len();
            Ok(v)
        } else {
            Err(())
        }
    }

    fn number(&mut self) -> Result<Json, ()> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.i += 1;
            }
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.i += 1;
                }
            }
            _ => return Err(()),
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(());
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.i += 1;
            }
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(());
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.i += 1;
            }
        }
        let text = std::str::from_utf8(&self.b[start..self.i]).map_err(|_| ())?;
        let v: f64 = text.parse().map_err(|_| ())?;
        Ok(Json::Num(v))
    }

    fn hex4(&mut self) -> Result<u16, ()> {
        if self.i + 4 > self.b.len() {
            return Err(());
        }
        let mut v: u16 = 0;
        for k in 0..4 {
            let c = self.b[self.i + k];
            let d = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => return Err(()),
            };
            v = (v << 4) | d as u16;
        }
        self.i += 4;
        Ok(v)
    }

    fn string(&mut self) -> Result<JsStr, ()> {
        // Opening quote.
        self.i += 1;
        let mut out: JsStr = Vec::new();
        loop {
            let c = self.peek().ok_or(())?;
            match c {
                b'"' => {
                    self.i += 1;
                    out.shrink_to_fit();
                    return Ok(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = self.peek().ok_or(())?;
                    self.i += 1;
                    match e {
                        b'"' => out.push(0x22),
                        b'\\' => out.push(0x5C),
                        b'/' => out.push(0x2F),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0C),
                        b'n' => out.push(0x0A),
                        b'r' => out.push(0x0D),
                        b't' => out.push(0x09),
                        b'u' => out.push(self.hex4()?),
                        _ => return Err(()),
                    }
                }
                c if c < 0x20 => return Err(()),
                c if c < 0x80 => {
                    out.push(c as u16);
                    self.i += 1;
                }
                _ => {
                    // A multi-byte UTF-8 sequence; the input is valid UTF-8.
                    let len = if c >= 0xF0 {
                        4
                    } else if c >= 0xE0 {
                        3
                    } else {
                        2
                    };
                    if self.i + len > self.b.len() {
                        return Err(());
                    }
                    let s = std::str::from_utf8(&self.b[self.i..self.i + len]).map_err(|_| ())?;
                    out.extend(s.encode_utf16());
                    self.i += len;
                }
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, ()> {
        self.i += 1;
        let mut out = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            out.shrink_to_fit();
            return Ok(Json::Arr(out));
        }
        loop {
            self.ws();
            out.push(self.value(depth + 1)?);
            self.ws();
            match self.peek() {
                Some(b',') => {
                    self.i += 1;
                }
                Some(b']') => {
                    self.i += 1;
                    out.shrink_to_fit();
                    return Ok(Json::Arr(out));
                }
                _ => return Err(()),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, ()> {
        self.i += 1;
        let mut out = OMap::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            out.shrink_to_fit();
            return Ok(Json::Obj(out));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(());
            }
            let key = self.string()?;
            self.ws();
            if self.peek() != Some(b':') {
                return Err(());
            }
            self.i += 1;
            self.ws();
            let v = self.value(depth + 1)?;
            out.set(&lossy(&key), v);
            self.ws();
            match self.peek() {
                Some(b',') => {
                    self.i += 1;
                }
                Some(b'}') => {
                    self.i += 1;
                    out.shrink_to_fit();
                    return Ok(Json::Obj(out));
                }
                _ => return Err(()),
            }
        }
    }
}

// ── Serializer ──────────────────────────────────────────────────────────────

/// A JavaScript string the way `JSON.stringify` writes it: a run of plain
/// ASCII goes out in one piece, the rest character by character.
pub fn write_js_string(out: &mut String, s: &[u16]) {
    out.push('"');
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if plain_ascii(c) {
            let start = i;
            while i < s.len() && plain_ascii(s[i]) {
                i += 1;
            }
            // Every unit in the run is one ASCII byte, so the string stays UTF-8.
            unsafe {
                out.as_mut_vec().extend(s[start..i].iter().map(|&u| u as u8));
            }
            continue;
        }
        match c {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0C => out.push_str("\\f"),
            0x0A => out.push_str("\\n"),
            0x0D => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            c if c < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c);
            }
            0xD800..=0xDBFF => {
                if i + 1 < s.len() && (0xDC00..=0xDFFF).contains(&s[i + 1]) {
                    let cp = 0x10000 + (((c - 0xD800) as u32) << 10) + (s[i + 1] - 0xDC00) as u32;
                    if let Some(ch) = char::from_u32(cp) {
                        out.push(ch);
                    }
                    i += 1;
                } else {
                    let _ = write!(out, "\\u{:04x}", c);
                }
            }
            0xDC00..=0xDFFF => {
                let _ = write!(out, "\\u{:04x}", c);
            }
            _ => {
                if let Some(ch) = char::from_u32(c as u32) {
                    out.push(ch);
                }
            }
        }
        i += 1;
    }
    out.push('"');
}

/// Printable ASCII that `JSON.stringify` writes as is.
#[inline]
fn plain_ascii(c: u16) -> bool {
    (0x20..0x7F).contains(&c) && c != 0x22 && c != 0x5C
}

/// An object key, which is UTF-8 here: plain ASCII goes out as is, anything
/// else through the string writer.
fn write_js_key(out: &mut String, k: &str) {
    if k.bytes().all(|b| (0x20..0x7F).contains(&b) && b != b'"' && b != b'\\') {
        out.push('"');
        out.push_str(k);
        out.push('"');
    } else {
        write_js_string(out, &js(k));
    }
}

/// A number the way `JSON.stringify` prints it; the integers that fill the
/// state (offsets, sizes, millisecond stamps) and the fractional mtimes take
/// direct paths.
pub fn write_num(out: &mut String, n: f64) {
    if n == 0.0 {
        out.push('0');
    } else if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
        let _ = write!(out, "{}", n as i64);
    } else if (1e-6..1e21).contains(&n.abs()) {
        let _ = write!(out, "{}", n);
    } else {
        out.push_str(&num_to_string(n));
    }
}

fn newline(out: &mut String, indent: Option<usize>, level: usize) {
    if let Some(n) = indent {
        out.push('\n');
        for _ in 0..level * n {
            out.push(' ');
        }
    }
}

fn write_value(out: &mut String, v: &Json, indent: Option<usize>, level: usize) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Num(n) => write_num(out, *n),
        Json::Str(s) => write_js_string(out, s),
        Json::Arr(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, level + 1);
                write_value(out, item, indent, level + 1);
            }
            newline(out, indent, level);
            out.push(']');
        }
        Json::Obj(o) => {
            if o.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            let mut first = true;
            for (k, item) in o.iter() {
                if !first {
                    out.push(',');
                }
                first = false;
                newline(out, indent, level + 1);
                write_js_key(out, k);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent, level + 1);
            }
            newline(out, indent, level);
            out.push('}');
        }
    }
}

/// Build an object from (key, value) pairs in order.
pub fn obj(pairs: Vec<(&str, Json)>) -> Json {
    let mut o = OMap::with_capacity(pairs.len());
    for (k, v) in pairs {
        o.set(k, v);
    }
    Json::Obj(o)
}

/// `dropNulls`: an object without its null entries (uploader.ts).
pub fn drop_nulls(v: &Json) -> Json {
    let mut out = OMap::new();
    if let Json::Obj(o) = v {
        for (k, item) in o.iter() {
            if !item.is_null() {
                out.set(k, item.clone());
            }
        }
    }
    Json::Obj(out)
}
