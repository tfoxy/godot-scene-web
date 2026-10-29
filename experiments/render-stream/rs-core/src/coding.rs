//! render-stream/11's live transport coding (W11t; render-stream-11.md "Transport: base-prefix
//! zstd" and "As built (W11t)"): the receiver half, shared by every receiver (GSW's wasm, the
//! native receiver and the web export through `rs-core-capi`).
//!
//! A connection whose hello offered `live_coding` and whose host accepted it receives every binary
//! message coded, the first (magic + session) included:
//!
//! - **plain-coded**: one zstd frame, no dictionary. Resource records, the session message and the
//!   end record.
//! - **transaction**: an envelope, a zstd skippable frame (magic [`ENVELOPE_MAGIC`], 16 bytes of
//!   content: the transaction's `seq` and the `base_seq` its frame is coded against, u64le each,
//!   0 for none), then one zstd frame. With a base, the frame's history is the raw bytes of the
//!   base transaction's uncoded message (zstd `refPrefix`). A full transaction has base 0.
//!
//! Every frame has its content size and an XXH64 content checksum. The checksum is what turns a
//! wrong prefix into an error here instead of garbage at the record parser. A message whose base is
//! not retained, whose checksum differs, or that does not decode, is `coding`, and the decoder then
//! skips every based transaction until a full one (the receiver sends `resync` for [`seq`]).
//!
//! The host's base for T is the last transaction it sent on the connection, so the decoder keeps
//! the uncoded message of each transaction it decoded until a later message's base moves past it:
//! one at window 1, two at window 2, never more than [`MAX_BASES`].
//!
//! [`seq`]: LiveDecoder::seq

use crate::wire::Error;
use ruzstd::decoding::{BlockDecodingStrategy, Dictionary, FrameDecoder};

/// The envelope's zstd skippable-frame magic (0x184D2A50 + 0xB), little-endian on the wire.
pub const ENVELOPE_MAGIC: u32 = 0x184D_2A5B;
/// A zstd frame's magic.
pub const ZSTD_MAGIC: u32 = 0xFD2F_B528;
/// The envelope's length: magic, u32 content length (16), seq, base_seq.
pub const ENVELOPE_LEN: usize = 24;
/// The most bases a decoder keeps (window 2 needs two; one more absorbs a host that is a message
/// ahead of the receiver's retention at a resync).
pub const MAX_BASES: usize = 3;

/// The `live_coding` hello value of a receiver that keeps bases (its preference order).
pub const OFFER_BASE: &str = "zstd-base,zstd";
/// The `live_coding` hello value of a receiver that keeps no bases.
pub const OFFER_PLAIN: &str = "zstd";

/// A formatted zstd dictionary with entropy tables (made by zstd 1.5.7's trainer), repeat offsets
/// 1, 4, 8 and no content, id 1. ruzstd 0.9.1 has no public raw-content constructor, so a base is
/// this template with `dict_content` set to the base's bytes, forced onto a frame that names no
/// dictionary: what zstd's `refPrefix` is to a decoder. A prefixed frame never reads the tables
/// (libzstd starts a `refPrefix` frame with no entropy repeat state); a frame that did would fail
/// its checksum.
const PREFIX_TEMPLATE: [u8; 117] = [
    0x37, 0xa4, 0x30, 0xec, 0x01, 0x00, 0x00, 0x00, 0x18, 0x10, 0xe0, 0x0a, 0x95, 0x0e, 0xff, 0xff,
    0xff, 0xff, 0x7b, 0xf9, 0xf7, 0x7f, 0x6f, 0xdb, 0x7b, 0x4b, 0x99, 0x52, 0x62, 0x2e, 0xc0, 0xa7,
    0x05, 0xb3, 0x03, 0x00, 0x00, 0x00, 0xa8, 0x8d, 0x02, 0xb1, 0xf9, 0xf0, 0x01, 0x00, 0x04, 0xa0,
    0x80, 0x01, 0x01, 0x07, 0x4e, 0x5e, 0xce, 0xc2, 0x5c, 0x8c, 0x43, 0x00, 0x00, 0x00, 0x18, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x92, 0x04, 0x00, 0x00, 0x40,
    0x90, 0x86, 0x0d, 0x00, 0x00, 0x00, 0xe4, 0x0e, 0xb2, 0x18, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00,
    0x00, 0x08, 0x00, 0x00, 0x00,
];
const PREFIX_DICT_ID: u32 = 1;

/// What [`LiveDecoder::decode`] made of one message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// An uncoded connection: the message is its own bytes (byte for byte today's path).
    Plain,
    /// Decoded: [`LiveDecoder::output`] holds the uncoded message until the next call.
    Decoded,
    /// A based transaction after a `coding` error, before the full transaction the resync forces:
    /// not decoded (its base chain is gone), not to be applied or acked.
    Skipped,
}

/// Running totals, for the receivers' evidence.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub messages: u64,
    pub prefixed: u64,
    pub skipped: u64,
    pub errors: u64,
    pub coded_bytes: u64,
    pub decoded_bytes: u64,
}

pub struct LiveDecoder {
    keep_bases: bool,
    max_bytes: u64,
    /// Decided by the first message: `GRS` magic -> uncoded, a zstd frame -> coded.
    coded: Option<bool>,
    bases: Vec<(u64, Vec<u8>)>,
    spare: Vec<Vec<u8>>,
    awaiting_full: bool,
    frame: FrameDecoder,
    out: Vec<u8>,
    /// Index into `bases` of the transaction just decoded (its output), or None for `out`.
    out_base: Option<usize>,
    seq: u64,
    base_seq: u64,
    pub stats: Stats,
    /// A receiver sabotage (tests): the next based message decodes against its retained base plus
    /// one byte, which shifts every match into the prefix (a flipped byte that no match reads
    /// would decode correctly).
    pub sabotage_wrong_prefix: bool,
}

fn le_u32(d: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]])
}

fn le_u64(d: &[u8], at: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[at..at + 8]);
    u64::from_le_bytes(b)
}

fn coding(detail: impl Into<String>) -> Error {
    Error::new("coding", detail)
}

impl LiveDecoder {
    /// `keep_bases`: the receiver offered `zstd-base` (it keeps bases); otherwise a based message
    /// is `coding`. `max_bytes`: the largest uncoded message it accepts (its hello's
    /// `inbound_buffer_bytes`); a frame declaring more is `coding` before anything is allocated.
    pub fn new(keep_bases: bool, max_bytes: u64) -> LiveDecoder {
        let mut frame = FrameDecoder::new();
        frame.set_max_window_size(max_bytes.max(1 << 20));
        LiveDecoder {
            keep_bases,
            max_bytes,
            coded: None,
            bases: Vec::new(),
            spare: Vec::new(),
            awaiting_full: false,
            frame,
            out: Vec::new(),
            out_base: None,
            seq: 0,
            base_seq: 0,
            stats: Stats::default(),
            sabotage_wrong_prefix: false,
        }
    }

    /// Whether the connection turned out coded (None before its first message).
    pub fn coded(&self) -> Option<bool> {
        self.coded
    }

    /// The last message's envelope `seq` (0: not a transaction). After a `coding` error on a
    /// transaction this is the seq to `resync`.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// The last message's envelope `base_seq` (0: none).
    pub fn base_seq(&self) -> u64 {
        self.base_seq
    }

    /// The seqs of the bases kept, oldest first.
    pub fn retained(&self) -> Vec<u64> {
        self.bases.iter().map(|(s, _)| *s).collect()
    }

    pub fn retained_bytes(&self) -> usize {
        self.bases.iter().map(|(_, b)| b.len()).sum()
    }

    pub fn awaiting_full(&self) -> bool {
        self.awaiting_full
    }

    /// The uncoded message of the last [`Outcome::Decoded`].
    pub fn output(&self) -> &[u8] {
        match self.out_base {
            Some(i) => &self.bases[i].1,
            None => &self.out,
        }
    }

    /// Forgets every base (a new connection on the same decoder).
    pub fn reset(&mut self) {
        while let Some((_, b)) = self.bases.pop() {
            self.spare.push(b);
        }
        self.coded = None;
        self.awaiting_full = false;
        self.out_base = None;
        self.seq = 0;
        self.base_seq = 0;
    }

    /// Decodes one WebSocket message. On `Err` (code `coding`) the decoder is awaiting a full
    /// transaction; when [`seq`](Self::seq) is non-zero the receiver resyncs it, otherwise (a
    /// non-transaction message) the stream cannot continue.
    pub fn decode(&mut self, msg: &[u8]) -> Result<Outcome, Error> {
        self.out_base = None;
        self.seq = 0;
        self.base_seq = 0;
        let starts_coded = msg.len() >= 4 && matches!(le_u32(msg, 0), ZSTD_MAGIC | ENVELOPE_MAGIC);
        let coded = *self.coded.get_or_insert(starts_coded);
        if !coded {
            if starts_coded {
                return Err(self.fail(coding(
                    "a coded message on a connection whose first message was uncoded",
                )));
            }
            return Ok(Outcome::Plain);
        }
        if !starts_coded {
            return Err(self.fail(coding(format!(
                "an uncoded message ({} bytes) on a coded connection",
                msg.len()
            ))));
        }
        self.stats.messages += 1;
        self.stats.coded_bytes += msg.len() as u64;
        if le_u32(msg, 0) == ZSTD_MAGIC {
            // plain-coded: a record that is not a transaction, the session, or the end.
            let mut out = std::mem::take(&mut self.out);
            let r = self.run(msg, None, &mut out);
            self.out = out;
            r.map_err(|e| self.fail(e))?;
            self.stats.decoded_bytes += self.out.len() as u64;
            return Ok(Outcome::Decoded);
        }
        if msg.len() < ENVELOPE_LEN || le_u32(msg, 4) != 16 {
            return Err(self.fail(coding(
                "the transaction envelope is not a 16-byte skippable frame",
            )));
        }
        let seq = le_u64(msg, 8);
        let base_seq = le_u64(msg, 16);
        self.seq = seq;
        self.base_seq = base_seq;
        if seq == 0 || base_seq >= seq {
            return Err(self.fail(coding(format!(
                "envelope seq {seq} base_seq {base_seq}: a transaction's seq is >= 1 and its base is older"
            ))));
        }
        let frame = &msg[ENVELOPE_LEN..];
        if base_seq != 0 && self.awaiting_full {
            self.stats.skipped += 1;
            return Ok(Outcome::Skipped);
        }
        let mut out = self.spare.pop().unwrap_or_default();
        let result = if base_seq == 0 {
            self.run(frame, None, &mut out)
        } else if !self.keep_bases {
            Err(coding(format!(
                "seq {seq} is coded against base {base_seq}, but this receiver keeps no bases"
            )))
        } else {
            match self.bases.iter().position(|(s, _)| *s == base_seq) {
                None => Err(coding(format!(
                    "seq {seq} is coded against base {base_seq}, which is not retained (retained: {:?})",
                    self.retained()
                ))),
                Some(i) => {
                    let base = std::mem::take(&mut self.bases[i].1);
                    let r = if self.sabotage_wrong_prefix {
                        let mut wrong = base.clone();
                        wrong.push(0);
                        self.sabotage_wrong_prefix = false;
                        self.run(frame, Some(&wrong), &mut out)
                    } else {
                        self.run(frame, Some(&base), &mut out)
                    };
                    self.bases[i].1 = base;
                    r
                }
            }
        };
        if let Err(e) = result {
            self.spare.push(out);
            return Err(self.fail(e));
        }
        if base_seq != 0 {
            self.stats.prefixed += 1;
        }
        self.stats.decoded_bytes += out.len() as u64;
        self.awaiting_full = false;
        // The host's base moved to this message's base (or to this full transaction itself):
        // every older base is past.
        let floor = if base_seq != 0 { base_seq } else { seq };
        let mut i = 0;
        while i < self.bases.len() {
            if self.bases[i].0 < floor || self.bases[i].0 >= seq {
                let (_, b) = self.bases.remove(i);
                self.spare.push(b);
            } else {
                i += 1;
            }
        }
        if !self.keep_bases {
            self.spare.push(std::mem::take(&mut self.out));
            self.out = out;
            return Ok(Outcome::Decoded);
        }
        while self.bases.len() >= MAX_BASES {
            let (_, b) = self.bases.remove(0);
            self.spare.push(b);
        }
        self.bases.push((seq, out));
        self.spare.truncate(2);
        self.out_base = Some(self.bases.len() - 1);
        Ok(Outcome::Decoded)
    }

    fn fail(&mut self, e: Error) -> Error {
        self.stats.errors += 1;
        self.awaiting_full = true;
        e
    }

    /// One zstd frame, exactly, into `out`.
    fn run(&mut self, frame: &[u8], base: Option<&[u8]>, out: &mut Vec<u8>) -> Result<(), Error> {
        out.clear();
        if frame.len() < 4 || le_u32(frame, 0) != ZSTD_MAGIC {
            return Err(coding("no zstd frame where one is expected"));
        }
        let mut input = frame;
        self.frame
            .init(&mut input)
            .map_err(|e| coding(format!("zstd frame header: {e}")))?;
        let size = self.frame.content_size();
        if size == 0 {
            return Err(coding("the zstd frame declares no content size"));
        }
        if size > self.max_bytes {
            return Err(coding(format!(
                "the zstd frame declares {size} bytes, over this receiver's {}",
                self.max_bytes
            )));
        }
        if let Some(base) = base {
            let mut dict = Dictionary::decode_dict(&PREFIX_TEMPLATE)
                .map_err(|e| coding(format!("prefix template: {e}")))?;
            dict.id = PREFIX_DICT_ID;
            dict.dict_content = base.to_vec();
            dict.offset_hist = [1, 4, 8];
            self.frame
                .add_dict(dict)
                .map_err(|e| coding(format!("prefix: {e}")))?;
            self.frame
                .force_dict(PREFIX_DICT_ID)
                .map_err(|e| coding(format!("prefix: {e}")))?;
        }
        out.reserve(size as usize);
        loop {
            self.frame
                .decode_blocks(&mut input, BlockDecodingStrategy::All)
                .map_err(|e| coding(format!("zstd block: {e}")))?;
            self.frame
                .collect_to_writer(&mut *out)
                .map_err(|e| coding(format!("zstd drain: {e}")))?;
            if out.len() as u64 > size {
                return Err(coding("the zstd frame decodes past its content size"));
            }
            if self.frame.is_finished() {
                break;
            }
        }
        self.frame
            .collect_to_writer(&mut *out)
            .map_err(|e| coding(format!("zstd drain: {e}")))?;
        if base.is_some() {
            // Drop the base copy the decoder holds (only the decode buffer needed it).
            if let Ok(mut empty) = Dictionary::decode_dict(&PREFIX_TEMPLATE) {
                empty.id = PREFIX_DICT_ID;
                let _ = self.frame.add_dict(empty);
            }
        }
        if out.len() as u64 != size {
            return Err(coding(format!(
                "the zstd frame decodes to {} bytes, its header declares {size}",
                out.len()
            )));
        }
        if !input.is_empty() {
            return Err(coding(format!(
                "{} bytes follow the zstd frame (a message is one frame)",
                input.len()
            )));
        }
        let Some(stored) = self.frame.get_checksum_from_data() else {
            return Err(coding("the zstd frame carries no content checksum"));
        };
        let computed = xxh64(out, 0) as u32;
        if stored != computed {
            return Err(coding(format!(
                "content checksum {stored:08x} differs from the decoded bytes' {computed:08x} (a wrong prefix?)"
            )));
        }
        Ok(())
    }
}

// --------------------------------------------------------------------------- XXH64 (zstd's checksum)

const P1: u64 = 0x9E37_79B1_85EB_CA87;
const P2: u64 = 0xC2B2_AE3D_27D4_EB4F;
const P3: u64 = 0x1656_67B1_9E37_79F9;
const P4: u64 = 0x85EB_CA77_C2B2_AE63;
const P5: u64 = 0x27D4_EB2F_1656_67C5;

#[inline]
fn round(acc: u64, lane: u64) -> u64 {
    acc.wrapping_add(lane.wrapping_mul(P2))
        .rotate_left(31)
        .wrapping_mul(P1)
}

#[inline]
fn merge(acc: u64, v: u64) -> u64 {
    (acc ^ round(0, v)).wrapping_mul(P1).wrapping_add(P4)
}

/// XXH64 (zstd's frame checksum is its low 32 bits, seed 0).
pub fn xxh64(data: &[u8], seed: u64) -> u64 {
    let len = data.len();
    let mut p = 0usize;
    let mut h: u64;
    if len >= 32 {
        let mut v1 = seed.wrapping_add(P1).wrapping_add(P2);
        let mut v2 = seed.wrapping_add(P2);
        let mut v3 = seed;
        let mut v4 = seed.wrapping_sub(P1);
        while p + 32 <= len {
            v1 = round(v1, le_u64(data, p));
            v2 = round(v2, le_u64(data, p + 8));
            v3 = round(v3, le_u64(data, p + 16));
            v4 = round(v4, le_u64(data, p + 24));
            p += 32;
        }
        h = v1
            .rotate_left(1)
            .wrapping_add(v2.rotate_left(7))
            .wrapping_add(v3.rotate_left(12))
            .wrapping_add(v4.rotate_left(18));
        h = merge(h, v1);
        h = merge(h, v2);
        h = merge(h, v3);
        h = merge(h, v4);
    } else {
        h = seed.wrapping_add(P5);
    }
    h = h.wrapping_add(len as u64);
    while p + 8 <= len {
        h ^= round(0, le_u64(data, p));
        h = h.rotate_left(27).wrapping_mul(P1).wrapping_add(P4);
        p += 8;
    }
    if p + 4 <= len {
        h ^= (le_u32(data, p) as u64).wrapping_mul(P1);
        h = h.rotate_left(23).wrapping_mul(P2).wrapping_add(P3);
        p += 4;
    }
    while p < len {
        h ^= (data[p] as u64).wrapping_mul(P5);
        h = h.rotate_left(11).wrapping_mul(P1);
        p += 1;
    }
    h ^= h >> 33;
    h = h.wrapping_mul(P2);
    h ^= h >> 29;
    h = h.wrapping_mul(P3);
    h ^= h >> 32;
    h
}

/// Streaming XXH64: `update` over any split of the input, then `digest`, equals [`xxh64`] over
/// the concatenation (W13a: render-stream/13's `predict_check` hashes three blocks that are not
/// contiguous in a record).
#[derive(Clone)]
pub struct Xxh64 {
    v: [u64; 4],
    buf: [u8; 32],
    buf_len: usize,
    total: u64,
    seed: u64,
}

impl Xxh64 {
    pub fn new(seed: u64) -> Xxh64 {
        Xxh64 {
            v: [
                seed.wrapping_add(P1).wrapping_add(P2),
                seed.wrapping_add(P2),
                seed,
                seed.wrapping_sub(P1),
            ],
            buf: [0; 32],
            buf_len: 0,
            total: 0,
            seed,
        }
    }

    #[inline]
    fn stripe(v: &mut [u64; 4], d: &[u8], p: usize) {
        v[0] = round(v[0], le_u64(d, p));
        v[1] = round(v[1], le_u64(d, p + 8));
        v[2] = round(v[2], le_u64(d, p + 16));
        v[3] = round(v[3], le_u64(d, p + 24));
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total += data.len() as u64;
        if self.buf_len > 0 {
            let take = (32 - self.buf_len).min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len < 32 {
                return;
            }
            let buf = self.buf;
            Self::stripe(&mut self.v, &buf, 0);
            self.buf_len = 0;
        }
        let stripes = data.chunks_exact(32);
        let rest = stripes.remainder();
        let mut v = self.v;
        for c in stripes {
            let c: &[u8; 32] = c.try_into().unwrap();
            let lane = |k: usize| u64::from_le_bytes(c[8 * k..8 * k + 8].try_into().unwrap());
            v[0] = round(v[0], lane(0));
            v[1] = round(v[1], lane(1));
            v[2] = round(v[2], lane(2));
            v[3] = round(v[3], lane(3));
        }
        self.v = v;
        self.buf[..rest.len()].copy_from_slice(rest);
        self.buf_len = rest.len();
    }

    pub fn digest(&self) -> u64 {
        let [v1, v2, v3, v4] = self.v;
        let mut h = if self.total >= 32 {
            let mut h = v1
                .rotate_left(1)
                .wrapping_add(v2.rotate_left(7))
                .wrapping_add(v3.rotate_left(12))
                .wrapping_add(v4.rotate_left(18));
            h = merge(h, v1);
            h = merge(h, v2);
            h = merge(h, v3);
            merge(h, v4)
        } else {
            self.seed.wrapping_add(P5)
        };
        h = h.wrapping_add(self.total);
        let data = &self.buf[..self.buf_len];
        let len = data.len();
        let mut p = 0;
        while p + 8 <= len {
            h ^= round(0, le_u64(data, p));
            h = h.rotate_left(27).wrapping_mul(P1).wrapping_add(P4);
            p += 8;
        }
        if p + 4 <= len {
            h ^= (le_u32(data, p) as u64).wrapping_mul(P1);
            h = h.rotate_left(23).wrapping_mul(P2).wrapping_add(P3);
            p += 4;
        }
        while p < len {
            h ^= (data[p] as u64).wrapping_mul(P5);
            h = h.rotate_left(11).wrapping_mul(P1);
            p += 1;
        }
        h ^= h >> 33;
        h = h.wrapping_mul(P2);
        h ^= h >> 29;
        h = h.wrapping_mul(P3);
        h ^= h >> 32;
        h
    }
}

/// Splits a coded-message file (u32le length, then the message, repeated: what the capture's
/// `rs_live_coding_tool` and the live legs' clients write) into its messages.
pub fn split_messages(data: &[u8]) -> Result<Vec<&[u8]>, Error> {
    let mut out = Vec::new();
    let mut p = 0usize;
    while p < data.len() {
        if p + 4 > data.len() {
            return Err(Error::new("truncated", format!("message length at {p}")));
        }
        let n = le_u32(data, p) as usize;
        if p + 4 + n > data.len() {
            return Err(Error::new(
                "truncated",
                format!("message at {p} declares {n} bytes"),
            ));
        }
        out.push(&data[p + 4..p + 4 + n]);
        p += 4 + n;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden(name: &str) -> (Vec<u8>, Vec<Vec<u8>>) {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-11");
        let coded = std::fs::read(dir.join("coding").join(format!("{name}.coded"))).unwrap();
        let rec = std::fs::read(dir.join(format!("{name}.rs11"))).unwrap();
        let spans = crate::wire::split_records(&rec, 11).unwrap();
        let mut expected = Vec::new();
        for (i, span) in spans.iter().enumerate() {
            expected.push(if i == 0 {
                rec[..span.offset + span.byte_length].to_vec()
            } else {
                span.bytes(&rec).to_vec()
            });
        }
        (coded, expected)
    }

    /// The wire-level pin: golden-11/coding/*.coded is what the capture's encoder (zstd 1.5.7,
    /// rs_live_coding_tool; its ctests hold it byte for byte) makes of golden-11's recordings, and
    /// rs-core decodes each message back to exactly the recording's.
    #[test]
    fn golden_coded_messages_decode_to_the_recordings() {
        for name in ["full", "patch", "inline"] {
            let (coded, expected) = golden(name);
            let messages = split_messages(&coded).unwrap();
            assert_eq!(messages.len(), expected.len(), "{name}");
            let mut d = LiveDecoder::new(true, 1 << 24);
            for (i, m) in messages.iter().enumerate() {
                assert_eq!(d.decode(m).unwrap(), Outcome::Decoded, "{name} {i}");
                assert_eq!(d.output(), &expected[i][..], "{name} message {i}");
                assert!(d.retained().len() <= 2);
            }
            assert_eq!(d.coded(), Some(true));
            assert_eq!(d.stats.prefixed > 0, name == "patch", "{name}");
        }
    }

    #[test]
    fn golden_sabotages_are_coding_then_skipped() {
        let (coded, _) = golden("patch");
        let messages = split_messages(&coded).unwrap();
        let based = |m: &[u8]| le_u32(m, 0) == ENVELOPE_MAGIC && le_u64(m, 16) != 0;
        let first = messages.iter().position(|m| based(m)).unwrap();
        // drop-base: the first based message never arrives, so the next names a missing base.
        let mut d = LiveDecoder::new(true, 1 << 24);
        let mut err = None;
        for (i, m) in messages.iter().enumerate() {
            if i == first {
                continue;
            }
            if let Err(e) = d.decode(m) {
                err = Some((e, d.seq()));
                break;
            }
        }
        let (e, seq) = err.expect("a dropped base is detected");
        assert_eq!(e.code, "coding");
        assert!(e.detail.contains("not retained"), "{}", e.detail);
        assert!(seq > 0 && d.awaiting_full());
        // wrong-prefix: the checksum catches it.
        let mut d = LiveDecoder::new(true, 1 << 24);
        for (i, m) in messages.iter().enumerate() {
            if i == first {
                d.sabotage_wrong_prefix = true;
                let e = d.decode(m).unwrap_err();
                assert_eq!(e.code, "coding");
                assert!(e.detail.contains("checksum"), "{}", e.detail);
                break;
            }
            d.decode(m).unwrap();
        }
        // A receiver that keeps no bases refuses a based message.
        let mut d = LiveDecoder::new(false, 1 << 24);
        for m in &messages[..first] {
            d.decode(m).unwrap();
        }
        assert_eq!(d.decode(messages[first]).unwrap_err().code, "coding");
        // A frame declaring more than the receiver accepts.
        let mut d = LiveDecoder::new(true, 64);
        assert_eq!(d.decode(messages[0]).unwrap_err().code, "coding");
    }

    #[test]
    fn xxh64_reference_values() {
        // xxHash's published XXH64 values for seed 0.
        assert_eq!(xxh64(b"", 0), 0xEF46_DB37_51D8_E999);
        assert_eq!(xxh64(b"a", 0), 0xD24E_C4F1_A98C_6E5B);
        assert_eq!(xxh64(b"abc", 0), 0x44BC_2CF5_AD77_0999);
    }

    #[test]
    fn streaming_xxh64_equals_one_shot_over_any_split() {
        let data: Vec<u8> = (0..300u32).map(|i| (i * 131 + 7) as u8).collect();
        for len in [0usize, 1, 3, 4, 7, 8, 31, 32, 33, 63, 64, 65, 100, 300] {
            let d = &data[..len];
            let want = xxh64(d, 0);
            for a in 0..=len.min(40) {
                for b in [a, (a + len) / 2, len] {
                    if b < a {
                        continue;
                    }
                    let mut h = Xxh64::new(0);
                    h.update(&d[..a]);
                    h.update(&d[a..b]);
                    h.update(&d[b..]);
                    assert_eq!(h.digest(), want, "len {len} split {a}/{b}");
                }
            }
        }
    }

    #[test]
    fn template_parses_with_start_offsets() {
        let d = Dictionary::decode_dict(&PREFIX_TEMPLATE).unwrap();
        assert_eq!(d.id, PREFIX_DICT_ID);
        assert_eq!(d.offset_hist, [1, 4, 8]);
        assert!(d.dict_content.is_empty());
    }

    #[test]
    fn uncoded_connection_passes_through() {
        let mut d = LiveDecoder::new(true, 1 << 24);
        let mut session = crate::wire::magic(11).to_vec();
        session.extend_from_slice(&[4, 0, 0, 0, 1, 2, 3, 4]);
        assert_eq!(d.decode(&session).unwrap(), Outcome::Plain);
        assert_eq!(d.decode(&[4, 0, 0, 0, 9, 9, 9, 9]).unwrap(), Outcome::Plain);
        assert_eq!(d.coded(), Some(false));
        // A coded message after an uncoded first one is refused.
        let mut env = ENVELOPE_MAGIC.to_le_bytes().to_vec();
        env.extend_from_slice(&[0u8; 20]);
        assert_eq!(d.decode(&env).unwrap_err().code, "coding");
    }

    #[test]
    fn malformed_envelopes_are_coding() {
        let mut d = LiveDecoder::new(true, 1 << 24);
        let mut env = ENVELOPE_MAGIC.to_le_bytes().to_vec();
        env.extend_from_slice(&16u32.to_le_bytes());
        env.extend_from_slice(&5u64.to_le_bytes());
        env.extend_from_slice(&4u64.to_le_bytes());
        // base 4 is not retained
        let e = d.decode(&env).unwrap_err();
        assert_eq!(e.code, "coding");
        assert_eq!(d.seq(), 5);
        assert!(d.awaiting_full());
        // while awaiting a full transaction, based ones are skipped
        assert_eq!(d.decode(&env).unwrap(), Outcome::Skipped);
        // base >= seq
        let mut bad = env.clone();
        bad[16..24].copy_from_slice(&5u64.to_le_bytes());
        assert_eq!(d.decode(&bad).unwrap_err().code, "coding");
        // an uncoded message on a coded connection
        assert_eq!(
            d.decode(&[4, 0, 0, 0, 1, 2, 3, 4]).unwrap_err().code,
            "coding"
        );
    }
}
