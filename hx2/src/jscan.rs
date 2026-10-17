//! JSON read without building a tree, accepting exactly what `JSON.parse`
//! accepts.
//!
//! The Claude Desktop index reads two kinds of JSON a lot: the session
//! files (six fields out of a file that can run to hundreds of kilobytes,
//! 36,000 of them on a long-lived machine) and its own saved index (one
//! entry per session file). Both are scanned once here: what the client
//! does not keep is checked and skipped, what it keeps is decoded straight
//! into its compact form.
//!
//! The input is the file's bytes. The client reads a file as UTF-8 text
//! before parsing it, so an ill-formed sequence inside a string decodes to
//! U+FFFD the way `String::from_utf8_lossy` decodes it, and one outside a
//! string is a syntax error either way. Strings decode to WTF-8 (wtf8.rs).
//! Nested values are skipped with a stack of their own, so no nesting depth
//! `JSON.parse` takes is refused here.

use crate::wtf8;

/// A value's type, and its content where the client keeps it.
pub enum Val {
    Null,
    Bool(bool),
    Num(f64),
    /// WTF-8.
    Str(Vec<u8>),
    Arr,
    Obj,
}

pub struct Scanner<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Scanner<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Scanner { b, i: 0 }
    }

    fn ws(&mut self) {
        while let Some(&c) = self.b.get(self.i) {
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                self.i += 1;
            } else {
                break;
            }
        }
    }

    /// The next byte after whitespace.
    pub fn peek(&mut self) -> Option<u8> {
        self.ws();
        self.b.get(self.i).copied()
    }

    /// Nothing but whitespace left.
    pub fn at_end(&mut self) -> bool {
        self.ws();
        self.i == self.b.len()
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn literal(&mut self, word: &[u8]) -> Result<(), ()> {
        if self.b.len() >= self.i + word.len() && &self.b[self.i..self.i + word.len()] == word {
            self.i += word.len();
            Ok(())
        } else {
            Err(())
        }
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

    /// The string at the cursor, decoded into `out` as WTF-8.
    pub fn string_into(&mut self, out: &mut Vec<u8>) -> Result<(), ()> {
        if self.peek() != Some(b'"') {
            return Err(());
        }
        self.i += 1;
        loop {
            let start = self.i;
            while let Some(&c) = self.b.get(self.i) {
                if c == b'"' || c == b'\\' || c < 0x20 {
                    break;
                }
                self.i += 1;
            }
            if self.i > start {
                // A run ends at an ASCII byte, which no well-formed sequence
                // contains: decoding run by run is decoding the whole text.
                let seg = &self.b[start..self.i];
                match std::str::from_utf8(seg) {
                    Ok(_) => out.extend_from_slice(seg),
                    Err(_) => out.extend_from_slice(String::from_utf8_lossy(seg).as_bytes()),
                }
            }
            match self.b.get(self.i).copied() {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(());
                }
                Some(b'\\') => {
                    let e = *self.b.get(self.i + 1).ok_or(())?;
                    self.i += 2;
                    let unit: u16 = match e {
                        b'"' => 0x22,
                        b'\\' => 0x5C,
                        b'/' => 0x2F,
                        b'b' => 0x08,
                        b'f' => 0x0C,
                        b'n' => 0x0A,
                        b'r' => 0x0D,
                        b't' => 0x09,
                        b'u' => self.hex4()?,
                        _ => return Err(()),
                    };
                    wtf8::push_unit(out, unit);
                }
                _ => return Err(()),
            }
        }
    }

    fn skip_string(&mut self) -> Result<(), ()> {
        self.i += 1;
        loop {
            let c = *self.b.get(self.i).ok_or(())?;
            match c {
                b'"' => {
                    self.i += 1;
                    return Ok(());
                }
                b'\\' => {
                    let e = *self.b.get(self.i + 1).ok_or(())?;
                    self.i += 2;
                    match e {
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {}
                        b'u' => {
                            self.hex4()?;
                        }
                        _ => return Err(()),
                    }
                }
                c if c < 0x20 => return Err(()),
                _ => self.i += 1,
            }
        }
    }

    fn at(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn digit(&self) -> bool {
        matches!(self.at(), Some(b'0'..=b'9'))
    }

    fn skip_number(&mut self) -> Result<(), ()> {
        if self.at() == Some(b'-') {
            self.i += 1;
        }
        match self.at() {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                while self.digit() {
                    self.i += 1;
                }
            }
            _ => return Err(()),
        }
        if self.at() == Some(b'.') {
            self.i += 1;
            if !self.digit() {
                return Err(());
            }
            while self.digit() {
                self.i += 1;
            }
        }
        if matches!(self.at(), Some(b'e') | Some(b'E')) {
            self.i += 1;
            if matches!(self.at(), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            if !self.digit() {
                return Err(());
            }
            while self.digit() {
                self.i += 1;
            }
        }
        Ok(())
    }

    /// The number at the cursor (a double, as `JSON.parse` reads it).
    fn number(&mut self) -> Result<f64, ()> {
        let start = self.i;
        self.skip_number()?;
        let text = std::str::from_utf8(&self.b[start..self.i]).map_err(|_| ())?;
        text.parse::<f64>().map_err(|_| ())
    }

    fn key_colon(&mut self) -> Result<(), ()> {
        if self.peek() != Some(b'"') {
            return Err(());
        }
        self.skip_string()?;
        if !self.eat(b':') {
            return Err(());
        }
        Ok(())
    }

    /// Check and skip the value at the cursor.
    pub fn skip_value(&mut self) -> Result<(), ()> {
        // The closing byte of every container the walk is inside.
        let mut stack: Vec<u8> = Vec::new();
        loop {
            match self.peek().ok_or(())? {
                b'{' => {
                    self.i += 1;
                    if !self.eat(b'}') {
                        stack.push(b'}');
                        self.key_colon()?;
                        continue;
                    }
                }
                b'[' => {
                    self.i += 1;
                    if !self.eat(b']') {
                        stack.push(b']');
                        continue;
                    }
                }
                b'"' => self.skip_string()?,
                b't' => self.literal(b"true")?,
                b'f' => self.literal(b"false")?,
                b'n' => self.literal(b"null")?,
                b'-' | b'0'..=b'9' => self.skip_number()?,
                _ => return Err(()),
            }
            // A value ended: close the containers it ends, or go on to the
            // next item of the innermost one.
            loop {
                let close = match stack.last() {
                    None => return Ok(()),
                    Some(&c) => c,
                };
                if self.eat(b',') {
                    if close == b'}' {
                        self.key_colon()?;
                    }
                    break;
                }
                if self.eat(close) {
                    stack.pop();
                    continue;
                }
                return Err(());
            }
        }
    }

    /// The value at the cursor: a scalar or a string with its content, an
    /// object or an array checked, skipped, and reported by type only.
    pub fn val(&mut self) -> Result<Val, ()> {
        match self.peek().ok_or(())? {
            b'"' => {
                let mut s = Vec::new();
                self.string_into(&mut s)?;
                Ok(Val::Str(s))
            }
            b't' => self.literal(b"true").map(|_| Val::Bool(true)),
            b'f' => self.literal(b"false").map(|_| Val::Bool(false)),
            b'n' => self.literal(b"null").map(|_| Val::Null),
            b'-' | b'0'..=b'9' => self.number().map(Val::Num),
            b'{' => self.skip_value().map(|_| Val::Obj),
            b'[' => self.skip_value().map(|_| Val::Arr),
            _ => Err(()),
        }
    }

    /// Walk the object at the cursor: `each(scanner, key)` runs for every
    /// member, in the file's order, with the cursor on the member's value,
    /// and must consume that value.
    pub fn object<F>(&mut self, mut each: F) -> Result<(), ()>
    where
        F: FnMut(&mut Scanner<'a>, &[u8]) -> Result<(), ()>,
    {
        if !self.eat(b'{') {
            return Err(());
        }
        if self.eat(b'}') {
            return Ok(());
        }
        let mut key: Vec<u8> = Vec::new();
        loop {
            key.clear();
            self.string_into(&mut key)?;
            if !self.eat(b':') {
                return Err(());
            }
            each(self, key.as_slice())?;
            if self.eat(b',') {
                continue;
            }
            if self.eat(b'}') {
                return Ok(());
            }
            return Err(());
        }
    }

    /// Walk the array at the cursor: `each(scanner)` runs with the cursor on
    /// every element, and must consume it.
    pub fn array<F>(&mut self, mut each: F) -> Result<(), ()>
    where
        F: FnMut(&mut Scanner<'a>) -> Result<(), ()>,
    {
        if !self.eat(b'[') {
            return Err(());
        }
        if self.eat(b']') {
            return Ok(());
        }
        loop {
            each(self)?;
            if self.eat(b',') {
                continue;
            }
            if self.eat(b']') {
                return Ok(());
            }
            return Err(());
        }
    }
}

/// Is `text` one JSON document, as `JSON.parse` would take it?
#[cfg(test)]
pub fn is_json(text: &[u8]) -> bool {
    let mut s = Scanner::new(text);
    s.skip_value().is_ok() && s.at_end()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::Json;

    #[test]
    fn accepts_and_refuses_what_the_tree_parser_does() {
        let cases: &[&str] = &[
            "{}", "[]", "0", "-0", "1.5e-7", "1E+21", "\"a\"", "true", "false", "null",
            " { \"a\" : [ 1 , 2 , { \"b\" : null } ] } ",
            "{\"a\":\"\\ud83d\\ude00\\u0041\\n\\/\"}",
            "[[[[[[[[[[[]]]]]]]]]]]",
            "", " ", "{", "}", "[1,]", "{\"a\":1,}", "{\"a\"}", "{a:1}", "01", "1.", ".5", "-", "1e", "+1",
            "\"\\x\"", "\"\\u12\"", "\"a\nb\"", "tru", "nul", "[1 2]", "{\"a\":1 \"b\":2}", "{} {}", "\u{feff}{}",
            "{\"a\":1}x",
        ];
        for c in cases {
            assert_eq!(is_json(c.as_bytes()), Json::parse(c).is_ok(), "{:?}", c);
        }
    }

    #[test]
    fn takes_any_depth() {
        let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
        assert!(is_json(deep.as_bytes()));
        assert!(!is_json(format!("{}{}", "[".repeat(1000), "]".repeat(999)).as_bytes()));
    }

    #[test]
    fn decodes_strings_to_wtf8() {
        let mut s = Scanner::new(b"\"a\\u00e9\\ud83d\\ude00\\ud800 \xff\"");
        let mut out = Vec::new();
        s.string_into(&mut out).unwrap();
        assert_eq!(crate::wtf8::to_units(&out), vec![0x61, 0xE9, 0xD83D, 0xDE00, 0xD800, 0x20, 0xFFFD]);
    }

    #[test]
    fn walks_members_in_order() {
        let mut s = Scanner::new(b"{\"a\":1,\"b\":[true,\"x\"],\"a\":{\"c\":null}}");
        let mut seen: Vec<(String, &'static str)> = Vec::new();
        s.object(|s, k| {
            let kind = match s.val()? {
                Val::Num(_) => "num",
                Val::Arr => "arr",
                Val::Obj => "obj",
                _ => "other",
            };
            seen.push((String::from_utf8(k.to_vec()).unwrap(), kind));
            Ok(())
        })
        .unwrap();
        assert!(s.at_end());
        assert_eq!(seen, vec![("a".to_string(), "num"), ("b".to_string(), "arr"), ("a".to_string(), "obj")]);
    }
}
