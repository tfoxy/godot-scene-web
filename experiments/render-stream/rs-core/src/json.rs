//! A strict, fast JSON reader for render-stream meta text (render-stream-0.md "Canonical JSON").
//!
//! It parses the full JSON grammar exactly as `JSON.parse` accepts it, into an arena of nodes
//! (no `HashMap`, no per-key `String`): a string is a slice of the source unless it carries an
//! escape, in which case it is decoded once into a shared byte buffer. Alongside the parse it
//! tracks whether the text is exactly what `JSON.stringify(JSON.parse(text))` would print, so the
//! decoder can report `meta-noncanonical` with the TypeScript decoder's precedence (schema first,
//! canonical form after) from a single pass:
//!
//! * no whitespace between tokens;
//! * every number spelled as ECMAScript `Number::toString` spells its value (`-0` is not, `1.0`
//!   is not, `1e21` is spelled `1e+21`);
//! * every escape one `JSON.stringify` emits (`\"`, `\\`, `\b \f \n \r \t`, `\u00xx` in lowercase
//!   for other control characters, `\udxxx` for a lone surrogate);
//! * no duplicate keys (the schema layer detects these, see [`Doc::note_duplicates`]: `JSON.parse`
//!   keeps the first key's position and the last value, and the reprint then differs).
//!
//! A JSON object's key order as `JSON.stringify` prints it also moves array-index keys (`"0"`,
//! `"17"`) first; every render-stream object has a fixed key list with no such key, so a text with
//! one always fails its schema check before canonical form is judged, and this reader does not
//! model that reordering.
//!
//! Strings are WTF-8: a lone `\udxxx` escape decodes to its three-byte generalized UTF-8 form, so
//! every string `JSON.parse` accepts has a byte form here; [`Doc::as_str`] is `None` for those.

use std::cmp::Ordering;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Null,
    Bool,
    Num,
    Str,
    Arr,
    Obj,
}

/// A node of a parsed [`Doc`].
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub struct Value(u32);

#[derive(Clone, Copy, Debug)]
struct Node {
    kind: Kind,
    /// Bool: the value. Str: the bytes live in `strbuf` (decoded escapes), not the source.
    flag: bool,
    start: u32,
    len: u32,
    num: f64,
}

#[derive(Clone, Copy)]
struct Frame {
    obj: bool,
    scratch_start: u32,
}

/// Reusable parse storage: hand it back with [`Doc::into_buffers`] to parse the next text without
/// allocating.
#[derive(Default)]
pub struct Buffers {
    nodes: Vec<Node>,
    links: Vec<Value>,
    strbuf: Vec<u8>,
    stack: Vec<Frame>,
    scratch: Vec<Value>,
}

pub struct Doc<'s> {
    src: &'s [u8],
    b: Buffers,
    root: Value,
    canonical: bool,
}

pub struct ParseError {
    pub message: String,
    pub buffers: Buffers,
}

struct P<'s> {
    src: &'s [u8],
    pos: usize,
    b: Buffers,
    canonical: bool,
}

#[inline]
fn is_ws(c: u8) -> bool {
    c == b' ' || c == b'\t' || c == b'\n' || c == b'\r'
}

/// The high bit of every byte of `v` (little-endian) that ends a fast string scan: `"`, `\`, a
/// control byte (< 0x20) or a non-ASCII byte. The lowest flagged byte is exact (borrows only run
/// upward from a true match).
#[inline]
fn stop_mask(v: u64) -> u64 {
    const ONES: u64 = 0x0101_0101_0101_0101;
    const HIGH: u64 = 0x8080_8080_8080_8080;
    let q = v ^ (ONES * b'"' as u64);
    let b = v ^ (ONES * b'\\' as u64);
    let zero_q = q.wrapping_sub(ONES) & !q;
    let zero_b = b.wrapping_sub(ONES) & !b;
    let control = v.wrapping_sub(ONES * 0x20) & !v;
    (zero_q | zero_b | control | v) & HIGH
}

#[inline]
fn hex_val(c: u8) -> Option<(u32, bool)> {
    match c {
        b'0'..=b'9' => Some(((c - b'0') as u32, true)),
        b'a'..=b'f' => Some(((c - b'a' + 10) as u32, true)),
        b'A'..=b'F' => Some(((c - b'A' + 10) as u32, false)),
        _ => None,
    }
}

fn push_utf8(out: &mut Vec<u8>, cp: u32) {
    // Generalized UTF-8: surrogate code points encode as three bytes like any other BMP value.
    if cp < 0x80 {
        out.push(cp as u8);
    } else if cp < 0x800 {
        out.push(0xC0 | (cp >> 6) as u8);
        out.push(0x80 | (cp & 0x3F) as u8);
    } else if cp < 0x10000 {
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

impl<'s> P<'s> {
    fn err(&self, what: &str) -> String {
        format!("{what} at position {}", self.pos)
    }

    #[inline]
    fn peek(&self) -> Option<u8> {
        self.src.get(self.pos).copied()
    }

    #[inline]
    fn skip_ws(&mut self) {
        let start = self.pos;
        while self.pos < self.src.len() && is_ws(self.src[self.pos]) {
            self.pos += 1;
        }
        if self.pos != start {
            self.canonical = false;
        }
    }

    fn node(&mut self, kind: Kind, flag: bool, start: u32, len: u32, num: f64) -> Value {
        let id = self.b.nodes.len() as u32;
        self.b.nodes.push(Node {
            kind,
            flag,
            start,
            len,
            num,
        });
        Value(id)
    }

    fn hex4(&mut self, at: usize) -> Result<(u32, bool), String> {
        if at + 4 > self.src.len() {
            return Err(self.err("Bad Unicode escape"));
        }
        let mut v = 0u32;
        let mut lower = true;
        for k in 0..4 {
            let (d, l) = hex_val(self.src[at + k]).ok_or_else(|| self.err("Bad Unicode escape"))?;
            v = v * 16 + d;
            lower &= l;
        }
        Ok((v, lower))
    }

    /// At an opening quote; returns the string node.
    fn string(&mut self) -> Result<Value, String> {
        self.pos += 1;
        let start = self.pos;
        let src = self.src;
        let mut i = start;
        let mut non_ascii = false;
        // Fast scan for the common no-escape case: eight bytes at a time until a quote, a
        // backslash, a control byte or a non-ASCII byte.
        loop {
            while i + 8 <= src.len() {
                let v = u64::from_le_bytes(src[i..i + 8].try_into().unwrap());
                if stop_mask(v) != 0 {
                    i += (stop_mask(v).trailing_zeros() / 8) as usize;
                    break;
                }
                i += 8;
            }
            let Some(&c) = src.get(i) else {
                self.pos = i;
                return Err(self.err("Unterminated string"));
            };
            if c == b'"' {
                if non_ascii && std::str::from_utf8(&src[start..i]).is_err() {
                    self.pos = start;
                    return Err(self.err("Invalid UTF-8 in string"));
                }
                self.pos = i + 1;
                return Ok(self.node(Kind::Str, false, start as u32, (i - start) as u32, 0.0));
            }
            if c == b'\\' {
                break;
            }
            if c < 0x20 {
                self.pos = i;
                return Err(self.err("Bad control character in string literal"));
            }
            non_ascii |= c >= 0x80;
            i += 1;
        }
        // Escaped: decode into strbuf.
        let out_start = self.b.strbuf.len();
        self.b.strbuf.extend_from_slice(&src[start..i]);
        let raw_start = start;
        loop {
            let Some(&c) = src.get(i) else {
                self.pos = i;
                return Err(self.err("Unterminated string"));
            };
            match c {
                b'"' => {
                    // Escapes are ASCII, so the raw source slice is valid UTF-8 exactly when its
                    // unescaped characters are.
                    if non_ascii && std::str::from_utf8(&src[raw_start..i]).is_err() {
                        self.pos = raw_start;
                        return Err(self.err("Invalid UTF-8 in string"));
                    }
                    self.pos = i + 1;
                    let len = self.b.strbuf.len() - out_start;
                    return Ok(self.node(Kind::Str, true, out_start as u32, len as u32, 0.0));
                }
                b'\\' => {
                    let Some(&e) = src.get(i + 1) else {
                        self.pos = i;
                        return Err(self.err("Unterminated string"));
                    };
                    let simple = match e {
                        b'"' => Some((b'"', true)),
                        b'\\' => Some((b'\\', true)),
                        b'/' => Some((b'/', false)),
                        b'b' => Some((0x08, true)),
                        b'f' => Some((0x0c, true)),
                        b'n' => Some((b'\n', true)),
                        b'r' => Some((b'\r', true)),
                        b't' => Some((b'\t', true)),
                        _ => None,
                    };
                    if let Some((byte, canon)) = simple {
                        self.b.strbuf.push(byte);
                        self.canonical &= canon;
                        i += 2;
                        continue;
                    }
                    if e != b'u' {
                        self.pos = i;
                        return Err(self.err("Bad escaped character"));
                    }
                    let (u, lower) = self.hex4(i + 2)?;
                    i += 6;
                    if (0xD800..0xDC00).contains(&u)
                        && src.get(i) == Some(&b'\\')
                        && src.get(i + 1) == Some(&b'u')
                    {
                        if let Ok((lo, _)) = self.hex4(i + 2) {
                            if (0xDC00..0xE000).contains(&lo) {
                                let cp = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
                                push_utf8(&mut self.b.strbuf, cp);
                                // JSON.stringify prints a paired surrogate raw.
                                self.canonical = false;
                                i += 6;
                                continue;
                            }
                        }
                    }
                    push_utf8(&mut self.b.strbuf, u);
                    let canon = if (0xD800..0xE000).contains(&u) {
                        lower
                    } else {
                        u < 0x20 && !matches!(u, 0x08 | 0x09 | 0x0a | 0x0c | 0x0d) && lower
                    };
                    self.canonical &= canon;
                }
                c if c < 0x20 => {
                    self.pos = i;
                    return Err(self.err("Bad control character in string literal"));
                }
                c => {
                    non_ascii |= c >= 0x80;
                    self.b.strbuf.push(c);
                    i += 1;
                }
            }
        }
    }

    fn number(&mut self) -> Result<Value, String> {
        let src = self.src;
        let start = self.pos;
        let mut i = start;
        let neg = src.get(i) == Some(&b'-');
        if neg {
            i += 1;
        }
        let int_start = i;
        match src.get(i) {
            Some(b'0') => i += 1,
            Some(b'1'..=b'9') => {
                while matches!(src.get(i), Some(b'0'..=b'9')) {
                    i += 1;
                }
            }
            _ => {
                self.pos = i;
                return Err(self.err("No number after minus sign"));
            }
        }
        let int_end = i;
        let mut plain = true;
        if src.get(i) == Some(&b'.') {
            plain = false;
            i += 1;
            let d = i;
            while matches!(src.get(i), Some(b'0'..=b'9')) {
                i += 1;
            }
            if i == d {
                self.pos = i;
                return Err(self.err("Unterminated fractional number"));
            }
        }
        if matches!(src.get(i), Some(b'e' | b'E')) {
            plain = false;
            i += 1;
            if matches!(src.get(i), Some(b'+' | b'-')) {
                i += 1;
            }
            let d = i;
            while matches!(src.get(i), Some(b'0'..=b'9')) {
                i += 1;
            }
            if i == d {
                self.pos = i;
                return Err(self.err("Exponent part is missing a number"));
            }
        }
        self.pos = i;
        let text = &src[start..i];
        let value;
        if plain && int_end - int_start <= 15 {
            let mut v: i64 = 0;
            for &c in &src[int_start..int_end] {
                v = v * 10 + (c - b'0') as i64;
            }
            value = if neg { -(v as f64) } else { v as f64 };
            if neg && v == 0 {
                self.canonical = false;
            }
        } else {
            // SAFETY-free: the bytes are ASCII digits, sign, '.', 'e', 'E', '+', '-'.
            let s = std::str::from_utf8(text).map_err(|_| self.err("Bad number"))?;
            value = s.parse::<f64>().map_err(|_| self.err("Bad number"))?;
            if self.canonical {
                let mut buf = NumBuf::new();
                buf.js(value);
                if buf.as_bytes() != text {
                    self.canonical = false;
                }
            }
        }
        Ok(self.node(Kind::Num, false, 0, 0, value))
    }

    fn literal(&mut self, word: &[u8], kind: Kind, flag: bool) -> Result<Value, String> {
        if self.src.len() >= self.pos + word.len()
            && &self.src[self.pos..self.pos + word.len()] == word
        {
            self.pos += word.len();
            Ok(self.node(kind, flag, 0, 0, 0.0))
        } else {
            Err(self.err("Unexpected token"))
        }
    }

    fn close(&mut self, frame: Frame) -> Value {
        let start = self.b.links.len() as u32;
        let s = frame.scratch_start as usize;
        let n = self.b.scratch.len() - s;
        self.b.links.extend_from_slice(&self.b.scratch[s..]);
        self.b.scratch.truncate(s);
        if frame.obj {
            self.node(Kind::Obj, false, start, (n / 2) as u32, 0.0)
        } else {
            self.node(Kind::Arr, false, start, n as u32, 0.0)
        }
    }

    /// After `{` or `,` inside an object: a key and its colon.
    fn key(&mut self) -> Result<(), String> {
        if self.peek() != Some(b'"') {
            return Err(self.err("Expected double-quoted property name"));
        }
        let k = self.string()?;
        self.b.scratch.push(k);
        self.skip_ws();
        if self.peek() != Some(b':') {
            return Err(self.err("Expected ':' after property name"));
        }
        self.pos += 1;
        Ok(())
    }

    fn run(&mut self) -> Result<Value, String> {
        'value: loop {
            self.skip_ws();
            let mut v = match self.peek() {
                Some(b'{') => {
                    self.pos += 1;
                    let frame = Frame {
                        obj: true,
                        scratch_start: self.b.scratch.len() as u32,
                    };
                    self.skip_ws();
                    if self.peek() == Some(b'}') {
                        self.pos += 1;
                        self.close(frame)
                    } else {
                        self.b.stack.push(frame);
                        self.key()?;
                        continue 'value;
                    }
                }
                Some(b'[') => {
                    self.pos += 1;
                    let frame = Frame {
                        obj: false,
                        scratch_start: self.b.scratch.len() as u32,
                    };
                    self.skip_ws();
                    if self.peek() == Some(b']') {
                        self.pos += 1;
                        self.close(frame)
                    } else {
                        self.b.stack.push(frame);
                        continue 'value;
                    }
                }
                Some(b'"') => self.string()?,
                Some(b't') => self.literal(b"true", Kind::Bool, true)?,
                Some(b'f') => self.literal(b"false", Kind::Bool, false)?,
                Some(b'n') => self.literal(b"null", Kind::Null, false)?,
                Some(b'-' | b'0'..=b'9') => self.number()?,
                Some(_) => return Err(self.err("Unexpected token")),
                None => return Err(self.err("Unexpected end of JSON input")),
            };
            loop {
                let Some(&frame) = self.b.stack.last() else {
                    self.skip_ws();
                    if self.pos != self.src.len() {
                        return Err(self.err("Unexpected non-whitespace character after JSON"));
                    }
                    return Ok(v);
                };
                self.b.scratch.push(v);
                self.skip_ws();
                match self.peek() {
                    Some(b',') => {
                        self.pos += 1;
                        if frame.obj {
                            self.skip_ws();
                            self.key()?;
                        }
                        continue 'value;
                    }
                    Some(b'}') if frame.obj => {
                        self.pos += 1;
                        self.b.stack.pop();
                        v = self.close(frame);
                    }
                    Some(b']') if !frame.obj => {
                        self.pos += 1;
                        self.b.stack.pop();
                        v = self.close(frame);
                    }
                    Some(_) => {
                        return Err(self.err(if frame.obj {
                            "Expected ',' or '}' after property value"
                        } else {
                            "Expected ',' or ']' after array element"
                        }))
                    }
                    None => return Err(self.err("Unexpected end of JSON input")),
                }
            }
        }
    }
}

impl<'s> Doc<'s> {
    #[allow(clippy::result_large_err)]
    pub fn parse(src: &'s [u8]) -> Result<Doc<'s>, ParseError> {
        Doc::parse_with(src, Buffers::default())
    }

    #[allow(clippy::result_large_err)]
    pub fn parse_with(src: &'s [u8], mut b: Buffers) -> Result<Doc<'s>, ParseError> {
        b.nodes.clear();
        b.links.clear();
        b.strbuf.clear();
        b.stack.clear();
        b.scratch.clear();
        let mut p = P {
            src,
            pos: 0,
            b,
            canonical: true,
        };
        match p.run() {
            Ok(root) => Ok(Doc {
                src,
                b: p.b,
                root,
                canonical: p.canonical,
            }),
            Err(message) => Err(ParseError {
                message,
                buffers: p.b,
            }),
        }
    }

    pub fn into_buffers(self) -> Buffers {
        self.b
    }

    pub fn root(&self) -> Value {
        self.root
    }

    /// Whether the text is `JSON.stringify` of its own parse, as far as the lexical layer can tell
    /// (see the module docs; duplicate keys are the schema layer's to report).
    pub fn lexically_canonical(&self) -> bool {
        self.canonical
    }

    #[inline]
    fn n(&self, v: Value) -> &Node {
        &self.b.nodes[v.0 as usize]
    }

    #[inline]
    pub fn kind(&self, v: Value) -> Kind {
        self.n(v).kind
    }

    #[inline]
    pub fn is_null(&self, v: Value) -> bool {
        self.n(v).kind == Kind::Null
    }

    #[inline]
    pub fn as_bool(&self, v: Value) -> Option<bool> {
        let n = self.n(v);
        (n.kind == Kind::Bool).then_some(n.flag)
    }

    #[inline]
    pub fn as_num(&self, v: Value) -> Option<f64> {
        let n = self.n(v);
        (n.kind == Kind::Num).then_some(n.num)
    }

    /// The string's bytes (WTF-8), or None if `v` is not a string.
    #[inline]
    pub fn str_bytes(&self, v: Value) -> Option<&[u8]> {
        let n = self.n(v);
        if n.kind != Kind::Str {
            return None;
        }
        let (s, l) = (n.start as usize, n.len as usize);
        Some(if n.flag {
            &self.b.strbuf[s..s + l]
        } else {
            &self.src[s..s + l]
        })
    }

    /// The string, or None if `v` is not a string or holds a lone surrogate.
    pub fn as_str(&self, v: Value) -> Option<&str> {
        std::str::from_utf8(self.str_bytes(v)?).ok()
    }

    #[inline]
    pub fn arr(&self, v: Value) -> Option<&[Value]> {
        let n = self.n(v);
        if n.kind != Kind::Arr {
            return None;
        }
        Some(&self.b.links[n.start as usize..(n.start + n.len) as usize])
    }

    /// An object's entries as flattened `[key, value, key, value, ...]`, in source order,
    /// duplicates included.
    #[inline]
    pub fn obj(&self, v: Value) -> Option<&[Value]> {
        let n = self.n(v);
        if n.kind != Kind::Obj {
            return None;
        }
        Some(&self.b.links[n.start as usize..(n.start + 2 * n.len) as usize])
    }

    /// `obj[key]` with `JSON.parse`'s duplicate semantics (the last value wins).
    pub fn get(&self, obj: Value, key: &str) -> Option<Value> {
        let e = self.obj(obj)?;
        let mut found = None;
        for pair in e.chunks_exact(2) {
            if self.str_bytes(pair[0]) == Some(key.as_bytes()) {
                found = Some(pair[1]);
            }
        }
        found
    }

    /// `Object.keys(obj)` after `JSON.parse`'s duplicate collapse, with each key's final value:
    /// `(key node, value node)` in first-occurrence order. Returns whether any key repeated.
    pub fn dedup_entries(&self, obj: Value, out: &mut Vec<(Value, Value)>) -> bool {
        out.clear();
        let mut dups = false;
        if let Some(e) = self.obj(obj) {
            for pair in e.chunks_exact(2) {
                let k = self.str_bytes(pair[0]);
                if let Some(slot) = out.iter_mut().find(|(ok, _)| self.str_bytes(*ok) == k) {
                    slot.1 = pair[1];
                    dups = true;
                } else {
                    out.push((pair[0], pair[1]));
                }
            }
        }
        dups
    }

    /// The node as a `serde_json::Value` (a slow path for decoded-form dumps). Lone surrogates
    /// become U+FFFD; duplicate keys keep the last value.
    pub fn to_serde(&self, v: Value) -> serde_json::Value {
        use serde_json::Value as J;
        match self.kind(v) {
            Kind::Null => J::Null,
            Kind::Bool => J::Bool(self.n(v).flag),
            Kind::Num => {
                let x = self.n(v).num;
                if x.fract() == 0.0 && x.abs() < 9007199254740992.0 {
                    J::from(x as i64)
                } else {
                    serde_json::Number::from_f64(x)
                        .map(J::Number)
                        .unwrap_or(J::Null)
                }
            }
            Kind::Str => {
                J::String(String::from_utf8_lossy(self.str_bytes(v).unwrap()).into_owned())
            }
            Kind::Arr => J::Array(
                self.arr(v)
                    .unwrap()
                    .iter()
                    .map(|&c| self.to_serde(c))
                    .collect(),
            ),
            Kind::Obj => {
                let mut map = serde_json::Map::new();
                let mut entries = Vec::new();
                self.dedup_entries(v, &mut entries);
                for (k, val) in entries {
                    let key = String::from_utf8_lossy(self.str_bytes(k).unwrap()).into_owned();
                    map.insert(key, self.to_serde(val));
                }
                J::Object(map)
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Number formatting: ECMAScript Number::toString (and JSON.stringify's `null` for non-finite).

/// A small stack buffer for one formatted number.
pub struct NumBuf {
    buf: [u8; 40],
    len: usize,
}

impl Default for NumBuf {
    fn default() -> Self {
        NumBuf::new()
    }
}

impl std::fmt::Write for NumBuf {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        let b = s.as_bytes();
        if self.len + b.len() > self.buf.len() {
            return Err(std::fmt::Error);
        }
        self.buf[self.len..self.len + b.len()].copy_from_slice(b);
        self.len += b.len();
        Ok(())
    }
}

impl NumBuf {
    pub fn new() -> NumBuf {
        NumBuf {
            buf: [0; 40],
            len: 0,
        }
    }
    pub fn as_bytes(&self) -> &[u8] {
        &self.buf[..self.len]
    }
    #[inline]
    fn push(&mut self, c: u8) {
        self.buf[self.len] = c;
        self.len += 1;
    }
    fn push_int(&mut self, mut v: u64) {
        let mut tmp = [0u8; 20];
        let mut n = 0;
        loop {
            tmp[n] = b'0' + (v % 10) as u8;
            n += 1;
            v /= 10;
            if v == 0 {
                break;
            }
        }
        for k in (0..n).rev() {
            self.push(tmp[k]);
        }
    }

    /// `JSON.stringify(x)` for a number: ECMAScript Number::toString, `null` when not finite.
    pub fn js(&mut self, x: f64) {
        self.len = 0;
        if !x.is_finite() {
            for &c in b"null" {
                self.push(c);
            }
            return;
        }
        if x == 0.0 {
            self.push(b'0');
            return;
        }
        if x < 0.0 {
            self.push(b'-');
        }
        let a = x.abs();
        if a.fract() == 0.0 && a < 9007199254740992.0 {
            self.push_int(a as u64);
            return;
        }
        // Shortest round-trip digits via core's `{:e}` (shortest mode).
        let mut digits = [0u8; 20];
        let (mut k, mut ev) = sci_digits(a, None, &mut digits);
        // ECMAScript breaks an exact tie in the last digit toward the even digit; core's shortest
        // mode rounds it up. A tie needs the exact decimal expansion of `a` to be exactly one digit
        // longer than the shortest: then take the correctly rounded (ties-to-even) k digits, if
        // they still round-trip.
        if tie_possible(a, k as i32, ev + 1) {
            let mut alt = [0u8; 20];
            let (k2, ev2) = sci_digits(a, Some(k - 1), &mut alt);
            let mut text = NumBuf::new();
            let mantissa = std::str::from_utf8(&alt[..k2]).unwrap();
            let _ = std::fmt::write(
                &mut text,
                format_args!("{}e{}", mantissa, ev2 - k2 as i32 + 1),
            );
            let back = std::str::from_utf8(text.as_bytes())
                .ok()
                .and_then(|t| t.parse::<f64>().ok());
            if back == Some(a) {
                digits = alt;
                k = k2;
                ev = ev2;
            }
        }
        let k = k as i32;
        let n = ev + 1;
        if k <= n && n <= 21 {
            for &c in &digits[..k as usize] {
                self.push(c);
            }
            for _ in 0..(n - k) {
                self.push(b'0');
            }
        } else if 0 < n && n <= 21 {
            for &c in &digits[..n as usize] {
                self.push(c);
            }
            self.push(b'.');
            for &c in &digits[n as usize..k as usize] {
                self.push(c);
            }
        } else if -6 < n && n <= 0 {
            self.push(b'0');
            self.push(b'.');
            for _ in 0..(-n) {
                self.push(b'0');
            }
            for &c in &digits[..k as usize] {
                self.push(c);
            }
        } else {
            self.push(digits[0]);
            if k > 1 {
                self.push(b'.');
                for &c in &digits[1..k as usize] {
                    self.push(c);
                }
            }
            self.push(b'e');
            let e1 = n - 1;
            self.push(if e1 >= 0 { b'+' } else { b'-' });
            self.push_int(e1.unsigned_abs() as u64);
        }
    }
}

/// `a` (finite, positive) in scientific notation: its significant digits into `out` (trailing
/// zeros trimmed) and its decimal exponent. `precision`: core's exact mode with that many
/// fractional digits (ties to even); None: shortest round-trip mode.
fn sci_digits(a: f64, precision: Option<usize>, out: &mut [u8; 20]) -> (usize, i32) {
    let mut e = NumBuf::new();
    let _ = match precision {
        Some(p) => std::fmt::write(&mut e, format_args!("{:.*e}", p, a)),
        None => std::fmt::write(&mut e, format_args!("{:e}", a)),
    };
    let s = e.as_bytes();
    let epos = s.iter().position(|&c| c == b'e').unwrap();
    let mut k = 0;
    for &c in &s[..epos] {
        if c != b'.' {
            out[k] = c;
            k += 1;
        }
    }
    while k > 1 && out[k - 1] == b'0' {
        k -= 1;
    }
    let exp_text = &s[epos + 1..];
    let (neg, digits) = if exp_text[0] == b'-' {
        (true, &exp_text[1..])
    } else {
        (false, exp_text)
    };
    let mut ev: i32 = 0;
    for &c in digits {
        ev = ev * 10 + (c - b'0') as i32;
    }
    (k, if neg { -ev } else { ev })
}

/// Whether `a`'s exact decimal expansion has exactly `k + 1` significant digits (so the shortest
/// `k` digits may sit on an exact tie). `n` is the decimal exponent with `a = 0.d1d2... * 10^n`.
fn tie_possible(a: f64, k: i32, n: i32) -> bool {
    let bits = a.to_bits();
    let exp = ((bits >> 52) & 0x7ff) as i32;
    let mant = bits & ((1u64 << 52) - 1);
    let (m, q) = if exp == 0 {
        (mant, -1074)
    } else {
        (mant | 1 << 52, exp - 1075)
    };
    if m == 0 {
        return false;
    }
    let tz = m.trailing_zeros() as i32;
    let q = q + tz;
    if q >= 0 {
        // An integer >= 2^53 (smaller ones never reach here): rare, check exactly.
        return true;
    }
    n - q == k + 1
}

/// Appends `JSON.stringify(x)` for a number to `out`.
#[inline]
pub fn write_number(out: &mut Vec<u8>, x: f64) {
    if x.fract() == 0.0 && x.abs() < 9007199254740992.0 && x != 0.0 {
        let mut buf = NumBuf::new();
        if x < 0.0 {
            buf.push(b'-');
        }
        buf.push_int(x.abs() as u64);
        out.extend_from_slice(buf.as_bytes());
        return;
    }
    let mut buf = NumBuf::new();
    buf.js(x);
    out.extend_from_slice(buf.as_bytes());
}

/// Appends an integer as `JSON.stringify` prints the number with that value.
#[inline]
pub fn write_int(out: &mut Vec<u8>, v: i64) {
    if v.unsigned_abs() < 9007199254740992 {
        let mut buf = NumBuf::new();
        if v < 0 {
            buf.push(b'-');
        }
        buf.push_int(v.unsigned_abs());
        out.extend_from_slice(buf.as_bytes());
    } else {
        write_number(out, v as f64);
    }
}

/// Appends `JSON.stringify(s)` for a WTF-8 string.
pub fn write_string(out: &mut Vec<u8>, s: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    let mut i = 0;
    let mut run = 0;
    while i < s.len() {
        let c = s[i];
        let esc: Option<&[u8]> = match c {
            b'"' => Some(b"\\\""),
            b'\\' => Some(b"\\\\"),
            0x08 => Some(b"\\b"),
            0x0c => Some(b"\\f"),
            b'\n' => Some(b"\\n"),
            b'\r' => Some(b"\\r"),
            b'\t' => Some(b"\\t"),
            _ => None,
        };
        if let Some(e) = esc {
            out.extend_from_slice(&s[run..i]);
            out.extend_from_slice(e);
            i += 1;
            run = i;
        } else if c < 0x20 {
            out.extend_from_slice(&s[run..i]);
            out.extend_from_slice(b"\\u00");
            out.push(HEX[(c >> 4) as usize]);
            out.push(HEX[(c & 15) as usize]);
            i += 1;
            run = i;
        } else if c == 0xED && i + 2 < s.len() && s[i + 1] >= 0xA0 {
            // A generalized-UTF-8 lone surrogate: JSON.stringify escapes it.
            out.extend_from_slice(&s[run..i]);
            let cp = ((c as u32 & 0x0F) << 12)
                | ((s[i + 1] as u32 & 0x3F) << 6)
                | (s[i + 2] as u32 & 0x3F);
            out.extend_from_slice(b"\\u");
            for sh in [12, 8, 4, 0] {
                out.push(HEX[((cp >> sh) & 15) as usize]);
            }
            i += 3;
            run = i;
        } else {
            i += 1;
        }
    }
    out.extend_from_slice(&s[run..]);
    out.push(b'"');
}

/// UTF-16 code units of a WTF-8 string.
fn utf16_units(s: &[u8]) -> impl Iterator<Item = u16> + '_ {
    let mut i = 0;
    let mut pending: Option<u16> = None;
    std::iter::from_fn(move || {
        if let Some(p) = pending.take() {
            return Some(p);
        }
        if i >= s.len() {
            return None;
        }
        let c = s[i] as u32;
        let (cp, w) = if c < 0x80 {
            (c, 1)
        } else if c < 0xE0 {
            (((c & 0x1F) << 6) | (s[i + 1] as u32 & 0x3F), 2)
        } else if c < 0xF0 {
            (
                ((c & 0x0F) << 12) | ((s[i + 1] as u32 & 0x3F) << 6) | (s[i + 2] as u32 & 0x3F),
                3,
            )
        } else {
            (
                ((c & 0x07) << 18)
                    | ((s[i + 1] as u32 & 0x3F) << 12)
                    | ((s[i + 2] as u32 & 0x3F) << 6)
                    | (s[i + 3] as u32 & 0x3F),
                4,
            )
        };
        i += w;
        if cp >= 0x10000 {
            let v = cp - 0x10000;
            pending = Some((0xDC00 + (v & 0x3FF)) as u16);
            Some((0xD800 + (v >> 10)) as u16)
        } else {
            Some(cp as u16)
        }
    })
}

/// JavaScript's `<` order on strings (UTF-16 code units), for WTF-8 bytes.
pub fn js_cmp(a: &[u8], b: &[u8]) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        return a.cmp(b);
    }
    utf16_units(a).cmp(utf16_units(b))
}

/// `String.prototype.length` of a WTF-8 string.
pub fn js_len(s: &[u8]) -> usize {
    if s.is_ascii() {
        s.len()
    } else {
        utf16_units(s).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js(x: f64) -> String {
        let mut b = NumBuf::new();
        b.js(x);
        String::from_utf8(b.as_bytes().to_vec()).unwrap()
    }

    #[test]
    fn number_to_string() {
        assert_eq!(js(0.0), "0");
        assert_eq!(js(-0.0), "0");
        assert_eq!(js(1.0), "1");
        assert_eq!(js(-17.0), "-17");
        assert_eq!(js(0.1f32 as f64), "0.10000000149011612");
        assert_eq!(js(1e21), "1e+21");
        assert_eq!(js(1e20), "100000000000000000000");
        assert_eq!(js(123456789012345680000.0), "123456789012345680000");
        assert_eq!(js(1e-6), "0.000001");
        assert_eq!(js(1e-7), "1e-7");
        assert_eq!(js(1.5e-7), "1.5e-7");
        assert_eq!(js(2f64.powi(60)), "1152921504606847000");
        assert_eq!(js(f64::NAN), "null");
        assert_eq!(js(1.25), "1.25");
        assert_eq!(js(66.86331176757812), "66.86331176757812");
        assert_eq!(js(2.5e-7), "2.5e-7");
        assert_eq!(js(-1.5e300), "-1.5e+300");
        assert_eq!(js(5e-324), "5e-324");
        assert_eq!(js(1.7976931348623157e308), "1.7976931348623157e+308");
    }

    fn canon(text: &str) -> bool {
        Doc::parse(text.as_bytes())
            .ok()
            .unwrap()
            .lexically_canonical()
    }

    #[test]
    fn parse_and_canonical() {
        assert!(canon(
            r#"{"a":[1,2,{"b":null}],"c":"x\ny","d":true,"e":-3.5}"#
        ));
        assert!(!canon(r#"{"a": 1}"#));
        assert!(!canon(r#"{"a":1.0}"#));
        assert!(!canon(r#"{"a":-0}"#));
        assert!(!canon(r#"{"a":"\/"}"#));
        assert!(!canon(r#"{"a":"\u0041"}"#));
        assert!(canon(r#"{"a":"\u001f"}"#));
        assert!(!canon(r#"{"a":"\u001F"}"#));
        assert!(!canon(r#"{"a":"\u000a"}"#));
        assert!(canon(r#"{"a":"\ud800"}"#));
        assert!(!canon(r#"{"a":"\ud83d\ude00"}"#));
        assert!(!canon(r#"{"a":1E5}"#));
        assert!(canon(r#"[1e+21,1.5e-7,0.000001]"#));
        for bad in [
            "",
            "01",
            "[1,]",
            "{\"a\"}",
            "{\"a\":1,}",
            "[1 2]",
            "\"\\x\"",
            "tru",
            "-",
            "1.",
            "1e",
            "[]]",
        ] {
            assert!(Doc::parse(bad.as_bytes()).is_err(), "{bad}");
        }
        let d = Doc::parse(br#"{"a":1,"b":2,"a":3}"#).ok().unwrap();
        assert_eq!(d.as_num(d.get(d.root(), "a").unwrap()), Some(3.0));
        let mut e = Vec::new();
        assert!(d.dedup_entries(d.root(), &mut e));
        assert_eq!(e.len(), 2);
    }

    #[test]
    fn strings() {
        let d = Doc::parse(br#"["a\"b\\c\u00e9\ud83d\ude00","\ud800"]"#)
            .ok()
            .unwrap();
        let a = d.arr(d.root()).unwrap();
        assert_eq!(d.as_str(a[0]), Some("a\"b\\c\u{e9}\u{1F600}"));
        assert_eq!(d.as_str(a[1]), None);
        let mut out = Vec::new();
        write_string(&mut out, d.str_bytes(a[1]).unwrap());
        assert_eq!(out, br#""\ud800""#);
        assert_eq!(
            js_cmp("\u{ffff}".as_bytes(), "\u{1F600}".as_bytes()),
            Ordering::Greater
        );
    }
}
