//! Record framing (render-stream-0.md "Record framing", -2.md "the u8 block type", -4.md "Block
//! type i32", -5.md "Block type f64"): the per-version magic, splitting a recording into records,
//! the u32 length prefixes, and little-endian block reads. Mirrors `splitRecords()`/`decodeRecord()`
//! in `scripts/lib/render-stream-2.ts`, error code for error code.

use crate::state::Hash;
use sha2::{Digest, Sha256};
use std::fmt;

/// A decode or validation failure: `code` is the protocol's error code (`meta-schema`,
/// `cmd-offset`, ...), the part of the TypeScript error string before `": "`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub code: &'static str,
    pub detail: String,
}

impl Error {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Error {
        Error {
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for Error {}

pub const MAGIC_LEN: usize = 8;

/// `GRS<version>\r\n\x1a\n`, the version as one uppercase hex digit (render-stream-10.md "File
/// layout": /10 is `GRSA`; render-stream-11.md: /11 is `GRSB`; render-stream-12.md: /12 is `GRSC`).
pub fn magic(version: u8) -> [u8; 8] {
    let digit = if version < 10 {
        b'0' + version
    } else {
        b'A' + (version - 10)
    };
    [0x47, 0x52, 0x53, digit, 0x0d, 0x0a, 0x1a, 0x0a]
}

/// The protocol version (2 to 12) whose magic `data` starts with.
pub fn version_of_magic(data: &[u8]) -> Option<u8> {
    if data.len() < MAGIC_LEN {
        return None;
    }
    let v = match data[3] {
        d @ b'0'..=b'9' => d - b'0',
        d @ b'A'..=b'F' => d - b'A' + 10,
        _ => return None,
    };
    if (2..=12).contains(&v) && data[..MAGIC_LEN] == magic(v) {
        Some(v)
    } else {
        None
    }
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

/// One record's place in a recording: `byte_length` includes the u32 `record_len` prefix.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct RecordSpan {
    pub offset: usize,
    pub byte_length: usize,
}

impl RecordSpan {
    pub fn bytes<'a>(&self, data: &'a [u8]) -> &'a [u8] {
        &data[self.offset..self.offset + self.byte_length]
    }
}

#[inline]
pub fn le_u32(d: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]])
}

#[inline]
pub fn le_f32(d: &[u8], at: usize) -> f32 {
    f32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]])
}

#[inline]
pub fn le_i32(d: &[u8], at: usize) -> i32 {
    i32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]])
}

#[inline]
pub fn le_f64(d: &[u8], at: usize) -> f64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[at..at + 8]);
    f64::from_le_bytes(b)
}

/// `splitRecords()`: `bad-magic` or `truncated`.
pub fn split_records(data: &[u8], version: u8) -> Result<Vec<RecordSpan>, Error> {
    let expected = magic(version);
    if data.len() < MAGIC_LEN || data[..MAGIC_LEN] != expected {
        let got = hex(&data[..data.len().min(MAGIC_LEN)]);
        return Err(Error::new(
            "bad-magic",
            format!("expected {}, got {}", hex(&expected), got),
        ));
    }
    let mut records = Vec::new();
    let mut pos = MAGIC_LEN;
    while pos < data.len() {
        if pos + 4 > data.len() {
            return Err(Error::new(
                "truncated",
                format!("record_len prefix at offset {pos} runs past the end of the input"),
            ));
        }
        let byte_length = 4 + le_u32(data, pos) as usize;
        if pos + byte_length > data.len() {
            return Err(Error::new(
                "truncated",
                format!(
                    "record at offset {pos} declares {byte_length} bytes but only {} remain",
                    data.len() - pos
                ),
            ));
        }
        records.push(RecordSpan {
            offset: pos,
            byte_length,
        });
        pos += byte_length;
    }
    Ok(records)
}

/// SHA-256 of `bytes` (a whole record, or a payload).
pub fn sha256(bytes: &[u8]) -> Hash {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    Hash(out)
}

/// D31's record digest: the SHA-256 of the whole record, `record_len` prefix included.
pub fn record_sha256(record: &[u8]) -> Hash {
    sha256(record)
}

/// The framing header of one record: its declared `record_len` and its meta bytes.
pub struct Frame<'a> {
    pub record_len: u32,
    pub meta: &'a [u8],
    /// The position right after the meta (where `block_count` starts).
    pub body: usize,
}

/// `decodeRecord()`'s first two `truncated` checks. `offset` is the record's offset in the
/// recording, for messages only.
pub fn frame(record: &[u8], offset: usize) -> Result<Frame<'_>, Error> {
    if record.len() < 8 {
        return Err(Error::new(
            "truncated",
            format!("record at offset {offset} is shorter than its framing header"),
        ));
    }
    let record_len = le_u32(record, 0);
    let meta_len = le_u32(record, 4) as usize;
    if 8 + meta_len > record.len() {
        return Err(Error::new(
            "truncated",
            format!(
                "meta at offset {} runs past the end of the record",
                offset + 8
            ),
        ));
    }
    Ok(Frame {
        record_len,
        meta: &record[8..8 + meta_len],
        body: 8 + meta_len,
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BlockType {
    F32,
    U8,
    I32,
    F64,
}

impl BlockType {
    pub fn parse(text: &[u8]) -> Option<BlockType> {
        match text {
            b"f32" => Some(BlockType::F32),
            b"u8" => Some(BlockType::U8),
            b"i32" => Some(BlockType::I32),
            b"f64" => Some(BlockType::F64),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            BlockType::F32 => "f32",
            BlockType::U8 => "u8",
            BlockType::I32 => "i32",
            BlockType::F64 => "f64",
        }
    }
    pub fn width(self) -> u64 {
        match self {
            BlockType::F32 | BlockType::I32 => 4,
            BlockType::F64 => 8,
            BlockType::U8 => 1,
        }
    }
}

/// One checked block descriptor from a meta's `blocks` list.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct BlockDesc {
    pub ty: BlockType,
    pub count: u64,
}

/// A block's bytes within its record.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct BlockRange {
    pub start: usize,
    pub len: usize,
}

/// `decodeRecord()`'s block framing, after the meta checks: `truncated`, `record-length`,
/// `block-length`. `names` labels messages only.
pub fn read_blocks(
    record: &[u8],
    frame: &Frame<'_>,
    descs: &[BlockDesc],
    names: &dyn Fn(usize) -> String,
    offset: usize,
    out: &mut Vec<BlockRange>,
) -> Result<(), Error> {
    out.clear();
    let mut pos = frame.body;
    if pos + 4 > record.len() {
        return Err(Error::new(
            "truncated",
            format!(
                "block_count at offset {} runs past the end of the record",
                offset + pos
            ),
        ));
    }
    let block_count = le_u32(record, pos) as usize;
    pos += 4;
    if block_count != descs.len() {
        return Err(Error::new(
            "record-length",
            format!(
                "record at offset {offset}: block_count {block_count} != meta.blocks.length {}",
                descs.len()
            ),
        ));
    }
    for (i, d) in descs.iter().enumerate() {
        if pos + 4 > record.len() {
            return Err(Error::new(
                "truncated",
                format!(
                    "block {i} length prefix at offset {} runs past the end of the record",
                    offset + pos
                ),
            ));
        }
        let block_len = le_u32(record, pos) as u64;
        pos += 4;
        let expected = d.count.checked_mul(d.ty.width());
        if expected != Some(block_len) {
            return Err(Error::new(
                "block-length",
                format!(
                    "record at offset {offset} block \"{}\" declares count {} ({} bytes) but carries {block_len} bytes",
                    names(i),
                    d.count,
                    expected.map(|e| e.to_string()).unwrap_or_else(|| "too many".into())
                ),
            ));
        }
        let len = block_len as usize;
        if pos + len > record.len() {
            return Err(Error::new(
                "truncated",
                format!(
                    "block {i} payload at offset {} runs past the end of the record",
                    offset + pos
                ),
            ));
        }
        out.push(BlockRange { start: pos, len });
        pos += len;
    }
    if pos != record.len() || 4 + frame.record_len as usize != record.len() {
        return Err(Error::new(
            "record-length",
            format!(
                "record at offset {offset}: decoded {pos} bytes but the record is {} bytes",
                record.len()
            ),
        ));
    }
    Ok(())
}

/// A little-endian f32 block, read in place (unaligned).
#[derive(Clone, Copy)]
pub struct F32s<'a>(pub &'a [u8]);

impl<'a> F32s<'a> {
    #[inline]
    pub fn len(&self) -> usize {
        self.0.len() / 4
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    #[inline]
    pub fn get(&self, i: usize) -> f32 {
        le_f32(self.0, 4 * i)
    }
    #[inline]
    pub fn arr<const N: usize>(&self, at: usize) -> [f32; N] {
        // One bounds check for the whole run, then fixed-size little-endian reads.
        let bytes = &self.0[4 * at..4 * (at + N)];
        let mut out = [0f32; N];
        for (o, c) in out.iter_mut().zip(bytes.chunks_exact(4)) {
            *o = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        }
        out
    }
    /// Appends floats `[at, at + n)` to `out`.
    #[inline]
    pub fn extend_into(&self, at: usize, n: usize, out: &mut Vec<f32>) {
        let bytes = &self.0[4 * at..4 * (at + n)];
        out.extend(
            bytes
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])),
        );
    }
}

/// A little-endian i32 block, read in place.
#[derive(Clone, Copy)]
pub struct I32s<'a>(pub &'a [u8]);

impl<'a> I32s<'a> {
    #[inline]
    pub fn len(&self) -> usize {
        self.0.len() / 4
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    #[inline]
    pub fn get(&self, i: usize) -> i32 {
        le_i32(self.0, 4 * i)
    }
    #[inline]
    pub fn extend_into(&self, at: usize, n: usize, out: &mut Vec<i32>) {
        let bytes = &self.0[4 * at..4 * (at + n)];
        out.extend(
            bytes
                .chunks_exact(4)
                .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]])),
        );
    }
}

/// A little-endian f64 block, read in place.
#[derive(Clone, Copy)]
pub struct F64s<'a>(pub &'a [u8]);

impl<'a> F64s<'a> {
    #[inline]
    pub fn len(&self) -> usize {
        self.0.len() / 8
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    #[inline]
    pub fn get(&self, i: usize) -> f64 {
        le_f64(self.0, 8 * i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magic_round_trip() {
        for v in 2..=12 {
            assert_eq!(version_of_magic(&magic(v)), Some(v));
        }
        assert_eq!(&magic(10)[..4], b"GRSA");
        assert_eq!(&magic(11)[..4], b"GRSB");
        assert_eq!(&magic(12)[..4], b"GRSC");
        assert_eq!(version_of_magic(&magic(13)), None);
        assert_eq!(version_of_magic(b"GRS6"), None);
    }

    #[test]
    fn split_errors() {
        assert_eq!(split_records(b"nope", 6).unwrap_err().code, "bad-magic");
        let mut d = magic(6).to_vec();
        d.extend_from_slice(&[9, 0]);
        assert_eq!(split_records(&d, 6).unwrap_err().code, "truncated");
        let mut d = magic(6).to_vec();
        d.extend_from_slice(&[9, 0, 0, 0, 1]);
        assert_eq!(split_records(&d, 6).unwrap_err().code, "truncated");
        assert_eq!(split_records(&magic(6), 6).unwrap(), vec![]);
    }
}
