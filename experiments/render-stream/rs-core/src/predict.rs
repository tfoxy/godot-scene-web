//! render-stream/13's predicted blocks (render-stream-13.md "As built (W13a): the wire"; the
//! reference codec is `protocol/golden-13/make_golden.py`, `code_blocks`, `History`, `advance`).
//!
//! /13 is /12 plus the magic `GRSD`, a `predict_check` transaction key and three predicted blocks:
//! `mesh_u8`, `mesh_f32` and `mm_f32` travel as residuals against the stream's two previous
//! transactions (H1 = R(T−1), H2 = R(T−2), reset by a full). This module holds both ends: the
//! prediction state R and its [`History`], the block coder ([`code_blocks`], forward or inverse),
//! the per-record un-predictor the validator calls ([`unpredict_record`]) and the /12 ↔ /13
//! transcoders ([`to13`], [`to12`]).
//!
//! History entries are reference-counted (`Arc`): a patch's R(T) starts as a clone of R(T−1)'s
//! maps (one pointer per id), and only the units T carries are copied.

use crate::coding::Xxh64;
use crate::meta::{self, DecodeBufs, Decoded, MeshMeta, TxMeta};
use crate::state::{EntryStatus, Id, Primitive};
use crate::validate::{IdHasher, Options, Validator};
use crate::wire::{self, BlockRange, Error, MAGIC_LEN};
use std::collections::HashMap;
use std::hash::BuildHasherDefault;
use std::sync::Arc;

type Map<V> = HashMap<Id, V, BuildHasherDefault<IdHasher>>;

/// Transaction block indices of the three predicted blocks.
pub const MESH_F32: usize = 4;
pub const MESH_U8: usize = 7;
pub const MM_F32: usize = 8;

/// The `predict_check` key as it sits in a canonical /13 transaction meta, right before
/// `,"blocks":[`: `,"predict_check":"` + 16 lowercase hex digits + `"`.
pub const CHECK_KEY: &[u8] = b",\"predict_check\":\"";
pub const CHECK_BYTES: usize = 18 + 16 + 1;
pub const BLOCKS_MARK: &[u8] = b",\"blocks\":[";

const PROTOCOL_12: &[u8] = b"\"protocol\":\"render-stream/12\"";
const PROTOCOL_13: &[u8] = b"\"protocol\":\"render-stream/13\"";

type Shape = (Primitive, i64, i64, i64);

/// One mesh's bodies in R: its surface shapes and their bodies, concatenated.
#[derive(PartialEq, Debug)]
pub struct Bodies {
    shape: Vec<Shape>,
    bytes: Vec<u8>,
    /// End offset of each surface's body in `bytes`.
    ends: Vec<usize>,
}

impl Bodies {
    fn surface(&self, k: usize) -> &[u8] {
        let start = if k == 0 { 0 } else { self.ends[k - 1] };
        &self.bytes[start..self.ends[k]]
    }
    fn same_shape(&self, e: &MeshMeta) -> bool {
        self.shape.len() == e.surfaces.len()
            && self
                .shape
                .iter()
                .zip(&e.surfaces)
                .all(|(a, s)| *a == (s.primitive, s.format, s.vertex_count, s.index_count))
    }
}

/// One multimesh's buffer in R.
#[derive(PartialEq, Debug)]
pub struct MmBuf {
    instances: i64,
    stride: u64,
    bytes: Vec<u8>,
}

/// R(T): the prediction state after a transaction.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct PredState {
    body: Map<Arc<Bodies>>,
    aabb: Map<[u8; 24]>,
    mm: Map<Arc<MmBuf>>,
}

impl PredState {
    pub fn is_empty(&self) -> bool {
        self.body.is_empty() && self.aabb.is_empty() && self.mm.is_empty()
    }
    /// (bodies, AABBs, buffers) held.
    pub fn counts(&self) -> (usize, usize, usize) {
        (self.body.len(), self.aabb.len(), self.mm.len())
    }
}

/// One end's prediction history: H1 = R(T−1), H2 = R(T−2), reset by a full.
#[derive(Default, Debug)]
pub struct History {
    h1: PredState,
    h2: PredState,
    empty: PredState,
    /// During [`History::accept`]: the outgoing H2's bodies and buffers, which R(T) reuses when
    /// nothing else holds them (so a steady stream allocates nothing). Empty between calls.
    spare: PredState,
}

impl History {
    /// (H1, H2) to code a transaction against. `stale` is the encoder sabotage `predict-stale`
    /// (predict from H2 as if it were H1, first order); `no_reset` the decoder sabotage
    /// `no-predict-reset` (a full predicts like a patch).
    pub fn refs(&self, full: bool, stale: bool, no_reset: bool) -> (&PredState, &PredState) {
        if full && !no_reset {
            (&self.empty, &self.empty)
        } else if stale {
            (&self.h2, &self.empty)
        } else {
            (&self.h1, &self.h2)
        }
    }

    /// Advances the history past an accepted transaction, from its /12 (reconstructed) blocks.
    pub fn accept(&mut self, tx: &TxMeta, b: Blocks<'_>, no_reset: bool, sc: &mut Scratch) {
        let full = tx.is_full() && !no_reset;
        // R(T) takes the outgoing H2's tables (their allocations), its entries moved to `spare`.
        let mut r = std::mem::take(&mut self.h2);
        std::mem::swap(&mut r.body, &mut self.spare.body);
        std::mem::swap(&mut r.mm, &mut self.spare.mm);
        if full {
            r.aabb.clear();
        } else {
            r.body.clone_from(&self.h1.body);
            r.aabb.clone_from(&self.h1.aabb);
            r.mm.clone_from(&self.h1.mm);
        }
        advance(&mut r, tx, b, sc, &mut self.spare);
        self.spare.body.clear();
        self.spare.mm.clear();
        if full {
            self.h2 = std::mem::replace(&mut self.h1, r);
            self.h2.body.clear();
            self.h2.aabb.clear();
            self.h2.mm.clear();
        } else {
            self.h2 = std::mem::replace(&mut self.h1, r);
        }
    }

    pub fn h1(&self) -> &PredState {
        &self.h1
    }
    pub fn h2(&self) -> &PredState {
        &self.h2
    }
}

/// The three predicted blocks of one transaction.
#[derive(Clone, Copy)]
pub struct Blocks<'a> {
    pub mesh_f32: &'a [u8],
    pub mesh_u8: &'a [u8],
    pub mm_f32: &'a [u8],
}

pub struct BlocksMut<'a> {
    pub mesh_f32: &'a mut [u8],
    pub mesh_u8: &'a mut [u8],
    pub mm_f32: &'a mut [u8],
}

/// One predicted unit (what the reference's `trace` lists): the block, the entry id and the
/// order (0 raw, 1 first order, 2 second order).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Unit {
    pub block: &'static str,
    pub id: Id,
    pub order: u8,
}

/// Reusable per-transaction storage.
#[derive(Default)]
pub struct Scratch {
    surfs: Vec<Surf>,
    f32u: Vec<(Id, usize)>,
    mmu: Vec<(Id, i64, u64, usize)>,
    words: Vec<u8>,
}

// --------------------------------------------------------------------------- word arithmetic

#[inline]
fn ord(u: u32) -> u32 {
    // u ^ 0x80000000 when u < 2^31, else !u (branch-free).
    u ^ (((u as i32 >> 31) as u32) | 0x8000_0000)
}

#[inline]
fn unord(o: u32) -> u32 {
    // o ^ 0x80000000 when o >= 2^31, else !o (branch-free).
    o ^ (((!o as i32 >> 31) as u32) | 0x8000_0000)
}

#[inline]
fn zz(d: u32) -> u32 {
    (d << 1) ^ (((d as i32) >> 31) as u32)
}

#[inline]
fn unzz(u: u32) -> u32 {
    (u >> 1) ^ 0u32.wrapping_sub(u & 1)
}

/// The residual of word `v` against `b` (H1) and `p` (H2).
#[inline]
pub fn residual(v: u32, b: Option<u32>, p: Option<u32>) -> u32 {
    match (b, p) {
        (None, _) => v,
        (Some(b), None) => zz(ord(v).wrapping_sub(ord(b))),
        (Some(b), Some(p)) => zz(ord(v)
            .wrapping_sub(ord(b).wrapping_mul(2))
            .wrapping_add(ord(p))),
    }
}

/// [`residual`]'s inverse.
#[inline]
pub fn unresidual(r: u32, b: Option<u32>, p: Option<u32>) -> u32 {
    match (b, p) {
        (None, _) => r,
        (Some(b), None) => unord(unzz(r).wrapping_add(ord(b))),
        (Some(b), Some(p)) => unord(
            unzz(r)
                .wrapping_add(ord(b).wrapping_mul(2))
                .wrapping_sub(ord(p)),
        ),
    }
}

#[inline]
fn le32(d: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]])
}

#[inline]
fn put32(d: &mut [u8], at: usize, v: u32) {
    d[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

/// Byte-plane transpose of a word stream: byte j of word k goes to j·n + k.
pub fn transpose4(src: &[u8], dst: &mut [u8]) {
    let n = src.len() / 4;
    for k in 0..n {
        for j in 0..4 {
            dst[j * n + k] = src[4 * k + j];
        }
    }
}

pub fn untranspose4(src: &[u8], dst: &mut [u8]) {
    let n = src.len() / 4;
    for k in 0..n {
        for j in 0..4 {
            dst[4 * k + j] = src[j * n + k];
        }
    }
}

// --------------------------------------------------------------------------- layouts

/// One carried surface body in `mesh_u8` (its entry is `tx.meshes[entry]`).
#[derive(Clone, Copy, Debug)]
struct Surf {
    start: usize,
    n: usize,
    col: usize,
    uv: usize,
    /// geometry, positions, colours, UVs, skin, indices
    sizes: [usize; 6],
}

/// `u8_layout`: the carried surfaces in entry then surface order, or `false` when `mesh_u8`'s
/// offset rule fails (pass-through).
fn u8_layout(tx: &TxMeta, u8_len: usize, out: &mut Vec<Surf>) -> bool {
    out.clear();
    let mut run: u64 = 0;
    for e in &tx.meshes {
        let Some(at) = e.u8 else { continue };
        if at != run {
            return false;
        }
        for s in &e.surfaces {
            if s.payload_bytes < 0
                || crate::payload::mesh_body_bytes(s.format, s.vertex_count, s.index_count)
                    != s.payload_bytes as u128
            {
                return false;
            }
            let [pos, attr, skin, idx] =
                crate::payload::expected_mesh_buffer_bytes(s.format, s.vertex_count, s.index_count);
            let n = s.vertex_count as usize;
            let col = if s.format & crate::payload::ARRAY_FORMAT_COLOR != 0 {
                4
            } else {
                0
            };
            let uv = if s.format & crate::payload::ARRAY_FORMAT_TEX_UV != 0 {
                8
            } else {
                0
            };
            debug_assert_eq!(attr as usize, n * (col + uv));
            out.push(Surf {
                start: run as usize,
                n,
                col,
                uv,
                sizes: [
                    40,
                    pos as usize,
                    n * col,
                    n * uv,
                    skin as usize,
                    idx as usize,
                ],
            });
            run = match run.checked_add(s.payload_bytes as u64) {
                Some(r) => r,
                None => return false,
            };
        }
    }
    run == u8_len as u64
}

/// `f32_layout`: (mesh id, float offset) of the AABB units, or `false` (pass-through).
fn f32_layout(tx: &TxMeta, n_floats: usize, out: &mut Vec<(Id, usize)>) -> bool {
    out.clear();
    let mut run: u64 = 0;
    for e in &tx.meshes {
        let Some(f) = e.f else { continue };
        if f != run {
            return false;
        }
        out.push((e.id, run as usize));
        run += 6;
    }
    run == n_floats as u64
}

/// `mm_layout`: (multimesh id, instances, stride, float offset) of the buffer units, or `false`.
fn mm_layout(tx: &TxMeta, n_floats: usize, out: &mut Vec<(Id, i64, u64, usize)>) -> bool {
    out.clear();
    let mut run: u64 = 0;
    for e in &tx.multimeshes {
        if let Some(a) = e.aabb_f {
            if a != run {
                return false;
            }
            run += 6;
        }
        if let Some(b) = e.buffer_f {
            if b != run || e.instances < 0 {
                return false;
            }
            out.push((e.id, e.instances, e.stride(), run as usize));
            run = match run.checked_add(e.buffer_floats()) {
                Some(r) if r <= n_floats as u64 => r,
                _ => return false,
            };
        }
    }
    run == n_floats as u64
}

fn is_dynamic(e: &MeshMeta) -> bool {
    e.status == EntryStatus::Ok
        && !e.surfaces.is_empty()
        && e.surfaces.iter().all(|s| s.hash.is_none())
}

fn order(base: bool, prev: bool) -> u8 {
    if !base {
        0
    } else if !prev {
        1
    } else {
        2
    }
}

// --------------------------------------------------------------------------- R(T)

/// `advance`: R(T) from R(T−1) (or ∅, the caller's choice) and T's /12 blocks.
/// Bodies and buffers come from `spare` (by id) when nothing else holds them.
fn advance(r: &mut PredState, tx: &TxMeta, b: Blocks<'_>, sc: &mut Scratch, spare: &mut PredState) {
    let layout = u8_layout(tx, b.mesh_u8.len(), &mut sc.surfs);
    let mut si = 0;
    for e in &tx.meshes {
        let mut carried = None;
        if layout && e.u8.is_some() {
            let surfs = &sc.surfs[si..si + e.surfaces.len()];
            si += e.surfaces.len();
            if let Some(first) = surfs.first() {
                let base = first.start;
                let mut slot = spare.body.remove(&e.id);
                let fresh = match slot.as_mut().and_then(Arc::get_mut) {
                    Some(x) => {
                        x.shape.clear();
                        x.bytes.clear();
                        x.ends.clear();
                        None
                    }
                    None => Some(Bodies {
                        shape: Vec::with_capacity(surfs.len()),
                        bytes: Vec::new(),
                        ends: Vec::with_capacity(surfs.len()),
                    }),
                };
                let mut arc = match fresh {
                    Some(f) => Arc::new(f),
                    None => slot.take().unwrap(),
                };
                let x = Arc::get_mut(&mut arc).unwrap();
                let mut end = 0;
                for s in surfs {
                    end = s.start + s.sizes.iter().sum::<usize>() - base;
                    x.ends.push(end);
                }
                x.shape.extend(
                    e.surfaces
                        .iter()
                        .map(|s| (s.primitive, s.format, s.vertex_count, s.index_count)),
                );
                x.bytes.extend_from_slice(&b.mesh_u8[base..base + end]);
                carried = Some(arc);
            }
        }
        if is_dynamic(e) {
            if e.u8.is_some() {
                match carried {
                    Some(c) => {
                        r.body.insert(e.id, c);
                    }
                    None => {
                        r.body.remove(&e.id);
                    }
                }
            }
        } else {
            r.body.remove(&e.id);
        }
        match e.f {
            Some(f) if (4 * f as u128 + 24) <= b.mesh_f32.len() as u128 => {
                let o = 4 * f as usize;
                let mut a = [0u8; 24];
                a.copy_from_slice(&b.mesh_f32[o..o + 24]);
                r.aabb.insert(e.id, a);
            }
            _ => {
                r.aabb.remove(&e.id);
            }
        }
    }
    for id in &tx.removed_meshes {
        let id = *id as Id;
        r.body.remove(&id);
        r.aabb.remove(&id);
    }
    for e in &tx.multimeshes {
        if e.status != EntryStatus::Ok {
            r.mm.remove(&e.id);
        } else if let Some(bf) = e.buffer_f {
            let o = 4 * bf as u128;
            let n = 4 * e.buffer_floats() as u128;
            if e.instances >= 0 && o + n <= b.mm_f32.len() as u128 {
                let (o, n) = (o as usize, n as usize);
                let mut slot = spare.mm.remove(&e.id);
                let buf = match slot.as_mut().and_then(Arc::get_mut) {
                    Some(x) => {
                        x.instances = e.instances;
                        x.stride = e.stride();
                        x.bytes.clear();
                        x.bytes.extend_from_slice(&b.mm_f32[o..o + n]);
                        slot.unwrap()
                    }
                    None => Arc::new(MmBuf {
                        instances: e.instances,
                        stride: e.stride(),
                        bytes: b.mm_f32[o..o + n].to_vec(),
                    }),
                };
                r.mm.insert(e.id, buf);
            } else {
                r.mm.remove(&e.id);
            }
        }
    }
    for id in &tx.removed_multimeshes {
        r.mm.remove(&(*id as Id));
    }
}

// --------------------------------------------------------------------------- coding

fn code_u8(
    tx: &TxMeta,
    src: &[u8],
    dst: &mut [u8],
    h1: &PredState,
    h2: &PredState,
    inverse: bool,
    surfs: &mut Vec<Surf>,
    trace: &mut Option<&mut Vec<Unit>>,
) {
    if !u8_layout(tx, src.len(), surfs) {
        dst.copy_from_slice(src);
        return;
    }
    let mut tot = [0usize; 6];
    for s in surfs.iter() {
        for i in 0..6 {
            tot[i] += s.sizes[i];
        }
    }
    let mut start = [0usize; 6];
    for i in 1..6 {
        start[i] = start[i - 1] + tot[i - 1];
    }
    let mut cur = [0usize; 6];
    let mut si = 0;
    for e in &tx.meshes {
        if e.u8.is_none() {
            continue;
        }
        let count = e.surfaces.len();
        let base = h1.body.get(&e.id).filter(|b| b.same_shape(e));
        let prev = base.and(h2.body.get(&e.id).filter(|b| b.same_shape(e)));
        if count > 0 {
            if let Some(t) = trace.as_deref_mut() {
                t.push(Unit {
                    block: "mesh_u8",
                    id: e.id,
                    order: order(base.is_some(), prev.is_some()),
                });
            }
        }
        for k in 0..count {
            let s = surfs[si + k];
            let bb = base.map(|b| b.surface(k));
            let pb = prev.map(|b| b.surface(k));
            let attr = 40 + 8 * s.n;
            let stride = s.col + s.uv;
            let tail = attr + s.n * stride;
            let col = s.col;
            let at = |i: usize| (start[i], tot[i] / 4, cur[i] / 4);
            // Geometry and positions: contiguous words; UVs: two words per vertex at the
            // attribute stride, after the colour.
            word_part(
                src,
                dst,
                s.start,
                at(0),
                s.sizes[0] / 4,
                |w| 4 * w,
                bb,
                pb,
                inverse,
            );
            word_part(
                src,
                dst,
                s.start,
                at(1),
                s.sizes[1] / 4,
                |w| 40 + 4 * w,
                bb,
                pb,
                inverse,
            );
            word_part(
                src,
                dst,
                s.start,
                at(3),
                s.sizes[3] / 4,
                |w| attr + (w >> 1) * stride + col + 4 * (w & 1),
                bb,
                pb,
                inverse,
            );
            // Colours (four bytes per vertex at the stride), skin, indices: XOR with H1.
            let c0 = start[2] + cur[2];
            if col > 0 {
                for k in 0..s.n {
                    let bo = attr + k * stride;
                    xor_run(
                        src,
                        dst,
                        s.start + bo,
                        c0 + 4 * k,
                        4,
                        bb.map(|b| &b[bo..bo + 4]),
                        inverse,
                    );
                }
            }
            let bo = tail;
            xor_run(
                src,
                dst,
                s.start + bo,
                start[4] + cur[4],
                s.sizes[4],
                bb.map(|b| &b[bo..bo + s.sizes[4]]),
                inverse,
            );
            let bo = tail + s.sizes[4];
            xor_run(
                src,
                dst,
                s.start + bo,
                start[5] + cur[5],
                s.sizes[5],
                bb.map(|b| &b[bo..bo + s.sizes[5]]),
                inverse,
            );
            for i in 0..6 {
                cur[i] += s.sizes[i];
            }
        }
        si += count;
    }
}

/// One word part of a surface body: `count` words at body offsets `off(w)` (body at `o` of the
/// plain block), stream words `g0..` of the transposed stream of `n` words at `cs`.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn word_part(
    src: &[u8],
    dst: &mut [u8],
    o: usize,
    (cs, n, g0): (usize, usize, usize),
    count: usize,
    off: impl Fn(usize) -> usize,
    bb: Option<&[u8]>,
    pb: Option<&[u8]>,
    inverse: bool,
) {
    if count == 0 {
        return;
    }
    let at = |j: usize| cs + j * n + g0;
    if inverse {
        // The four byte planes of the stream's words, read in step.
        let (q0, q1, q2, q3) = (
            &src[at(0)..at(0) + count],
            &src[at(1)..at(1) + count],
            &src[at(2)..at(2) + count],
            &src[at(3)..at(3) + count],
        );
        let r = |w: usize| u32::from_le_bytes([q0[w], q1[w], q2[w], q3[w]]);
        match (bb, pb) {
            (None, _) => {
                for w in 0..count {
                    put32(dst, o + off(w), r(w));
                }
            }
            (Some(b), None) => {
                for w in 0..count {
                    let bo = off(w);
                    put32(
                        dst,
                        o + bo,
                        unord(unzz(r(w)).wrapping_add(ord(le32(b, bo)))),
                    );
                }
            }
            (Some(b), Some(p)) => {
                for w in 0..count {
                    let bo = off(w);
                    let v = unord(
                        unzz(r(w))
                            .wrapping_add(ord(le32(b, bo)).wrapping_mul(2))
                            .wrapping_sub(ord(le32(p, bo))),
                    );
                    put32(dst, o + bo, v);
                }
            }
        }
    } else {
        let (_, rest) = dst.split_at_mut(at(0));
        let (q0, rest) = rest.split_at_mut(n);
        let (q1, rest) = rest.split_at_mut(n);
        let (q2, rest) = rest.split_at_mut(n);
        let (q0, q1, q2, q3) = (
            &mut q0[..count],
            &mut q1[..count],
            &mut q2[..count],
            &mut rest[..count],
        );
        let mut put = |w: usize, v: u32| {
            let b = v.to_le_bytes();
            q0[w] = b[0];
            q1[w] = b[1];
            q2[w] = b[2];
            q3[w] = b[3];
        };
        match (bb, pb) {
            (None, _) => {
                for w in 0..count {
                    put(w, le32(src, o + off(w)));
                }
            }
            (Some(b), None) => {
                for w in 0..count {
                    let bo = off(w);
                    put(w, zz(ord(le32(src, o + bo)).wrapping_sub(ord(le32(b, bo)))));
                }
            }
            (Some(b), Some(p)) => {
                for w in 0..count {
                    let bo = off(w);
                    put(
                        w,
                        zz(ord(le32(src, o + bo))
                            .wrapping_sub(ord(le32(b, bo)).wrapping_mul(2))
                            .wrapping_add(ord(le32(p, bo)))),
                    );
                }
            }
        }
    }
}

/// `len` plain bytes at `plain_at` against coded bytes at `coded_at`, XORed with `base`.
#[inline(always)]
fn xor_run(
    src: &[u8],
    dst: &mut [u8],
    plain_at: usize,
    coded_at: usize,
    len: usize,
    base: Option<&[u8]>,
    inverse: bool,
) {
    let (from, to) = if inverse {
        (
            &src[coded_at..coded_at + len],
            &mut dst[plain_at..plain_at + len],
        )
    } else {
        (
            &src[plain_at..plain_at + len],
            &mut dst[coded_at..coded_at + len],
        )
    };
    match base {
        None => to.copy_from_slice(from),
        Some(b) => {
            for ((t, f), x) in to.iter_mut().zip(from).zip(b) {
                *t = f ^ x;
            }
        }
    }
}

// --------------------------------------------------------------------------- un-predict
//
// The decoder's half of the block coder, written for the validator's per-transaction path. Each
// transposed word stream is first untransposed whole into scratch (one pass over the stream, in
// fixed blocks the compiler vectorizes); every surface body is then written straight into the
// output block from those words, H1's and H2's bodies and the plain streams, with no
// per-surface storage. The word kernels are const-generic over the unit's order (0 raw, 1 first,
// 2 second): the mod-2^32 arithmetic is branch-free.

#[inline(always)]
fn unres<const M: u8>(r: u32, b: u32, p: u32) -> u32 {
    match M {
        0 => r,
        1 => unord(unzz(r).wrapping_add(ord(b))),
        _ => unord(
            unzz(r)
                .wrapping_add(ord(b).wrapping_mul(2))
                .wrapping_sub(ord(p)),
        ),
    }
}

/// Word `i` of a little-endian word slice.
#[inline(always)]
fn word(d: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(d[4 * i..4 * i + 4].try_into().unwrap())
}

/// The four byte planes of a transposed word stream of `nw` words at `at`.
#[inline(always)]
fn planes(src: &[u8], at: usize, nw: usize) -> [&[u8]; 4] {
    [
        &src[at..at + nw],
        &src[at + nw..at + 2 * nw],
        &src[at + 2 * nw..at + 3 * nw],
        &src[at + 3 * nw..at + 4 * nw],
    ]
}

/// The delta swap of the bits of `a` at `s` above `m` with the bits of `b` at `m`.
#[inline(always)]
fn swap_bits(a: &mut u64, b: &mut u64, s: u32, m: u64) {
    let t = ((*a >> s) ^ *b) & m;
    *b ^= t;
    *a ^= t << s;
}

/// `out` (`4·n` bytes): the `n` words whose byte planes are `q`. Eight words at a time, as two
/// 4×4 byte transposes in 64-bit registers (delta swaps of bytes, then of byte pairs).
fn untranspose_words(q: [&[u8]; 4], out: &mut [u8]) {
    const M8: u64 = 0x00FF_00FF_00FF_00FF;
    const M16: u64 = 0x0000_FFFF_0000_FFFF;
    const LO: u64 = 0xFFFF_FFFF;
    let n = out.len() / 4;
    let (q0, q1, q2, q3) = (&q[0][..n], &q[1][..n], &q[2][..n], &q[3][..n]);
    let full = n - n % 8;
    for (w, o) in (0..full)
        .step_by(8)
        .zip(out[..4 * full].chunks_exact_mut(32))
    {
        let ld = |p: &[u8]| u64::from_le_bytes(p[w..w + 8].try_into().unwrap());
        // Byte k of x_j is byte j of word k (k < 4; word 4 + k in the high half).
        let (mut x0, mut x1, mut x2, mut x3) = (ld(q0), ld(q1), ld(q2), ld(q3));
        swap_bits(&mut x0, &mut x1, 8, M8);
        swap_bits(&mut x2, &mut x3, 8, M8);
        swap_bits(&mut x0, &mut x2, 16, M16);
        swap_bits(&mut x1, &mut x3, 16, M16);
        // Now the low half of x_j is word j, the high half word 4 + j.
        let y = [
            x0 & LO | x1 << 32,
            x2 & LO | x3 << 32,
            x0 >> 32 | x1 & !LO,
            x2 >> 32 | x3 & !LO,
        ];
        for (k, v) in y.iter().enumerate() {
            o[8 * k..8 * k + 8].copy_from_slice(&v.to_le_bytes());
        }
    }
    for w in full..n {
        out[4 * w..4 * w + 4].copy_from_slice(&[q0[w], q1[w], q2[w], q3[w]]);
    }
}

/// Four words from 16 bytes.
#[inline(always)]
fn ld4(d: &[u8], at: usize) -> [u32; 4] {
    let d: &[u8; 16] = d[at..at + 16].try_into().unwrap();
    [word(d, 0), word(d, 1), word(d, 2), word(d, 3)]
}

/// [`unres`] on four lanes.
#[inline(always)]
fn unres4<const M: u8>(r: [u32; 4], b: [u32; 4], p: [u32; 4]) -> [u32; 4] {
    let mut o = [0u32; 4];
    for i in 0..4 {
        o[i] = unres::<M>(r[i], b[i], p[i]);
    }
    o
}

#[inline(always)]
fn st4(d: &mut [u8], at: usize, v: [u32; 4]) {
    let d: &mut [u8; 16] = (&mut d[at..at + 16]).try_into().unwrap();
    for i in 0..4 {
        d[4 * i..4 * i + 4].copy_from_slice(&v[i].to_le_bytes());
    }
}

/// `out = unres(r, b, p)` word by word (`b` and `p` read only at orders `M` that use them). Four
/// words at a time; a run that is not a multiple of four ends with a block overlapping the one
/// before (each output word depends only on its inputs, so the overlap rewrites equal words).
#[inline(always)]
fn unres_words<const M: u8>(r: &[u8], b: &[u8], p: &[u8], out: &mut [u8]) {
    let n = out.len() / 4;
    let r = &r[..4 * n];
    if M == 0 {
        out[..4 * n].copy_from_slice(r);
        return;
    }
    let b = &b[..4 * n];
    let p = if M >= 2 { &p[..4 * n] } else { b };
    if n < 4 {
        for w in 0..n {
            let v = unres::<M>(word(r, w), word(b, w), word(p, w));
            out[4 * w..4 * w + 4].copy_from_slice(&v.to_le_bytes());
        }
        return;
    }
    let mut at = 0;
    loop {
        let v = unres4::<M>(ld4(r, at), ld4(b, at), ld4(p, at));
        st4(out, at, v);
        if at + 16 == 4 * n {
            break;
        }
        at = (at + 16).min(4 * n - 16);
    }
}

/// `out = from ^ base`, or a copy of `from` when `base` is empty (an absent base).
#[inline(always)]
fn unxor(from: &[u8], base: &[u8], out: &mut [u8]) {
    let from = &from[..out.len()];
    if base.is_empty() {
        out.copy_from_slice(from);
    } else {
        let base = &base[..out.len()];
        for ((t, f), x) in out.iter_mut().zip(from).zip(base) {
            *t = f ^ x;
        }
    }
}

/// The interleaved attribute section of `n` vertices (a colour, then two UV words: 12 bytes a
/// vertex) from `cols` (XOR H1's colours) and the untransposed UV words `uv`.
#[inline(always)]
fn unpredict_attr<const M: u8>(cols: &[u8], uv: &[u8], b: &[u8], p: &[u8], out: &mut [u8]) {
    let n = out.len() / 12;
    let (cols, uv) = (&cols[..4 * n], &uv[..8 * n]);
    if M == 0 {
        for ((o, c), u) in out
            .chunks_exact_mut(12)
            .zip(cols.chunks_exact(4))
            .zip(uv.chunks_exact(8))
        {
            o[..4].copy_from_slice(c);
            o[4..].copy_from_slice(u);
        }
        return;
    }
    let b = &b[..12 * n];
    let p = if M >= 2 { &p[..12 * n] } else { b };
    // Two vertices (four UV words) at a time, the last pair overlapping when `n` is odd.
    let pair = |k: usize, out: &mut [u8]| {
        let (o, v) = (12 * k, 8 * k);
        let bw = [
            word(b, 3 * k + 1),
            word(b, 3 * k + 2),
            word(b, 3 * k + 4),
            word(b, 3 * k + 5),
        ];
        let pw = [
            word(p, 3 * k + 1),
            word(p, 3 * k + 2),
            word(p, 3 * k + 4),
            word(p, 3 * k + 5),
        ];
        let u = unres4::<M>(ld4(uv, v), bw, pw);
        let c0 = word(cols, k) ^ word(b, 3 * k);
        let c1 = word(cols, k + 1) ^ word(b, 3 * k + 3);
        let o: &mut [u8; 24] = (&mut out[o..o + 24]).try_into().unwrap();
        for (i, x) in [c0, u[0], u[1], c1, u[2], u[3]].into_iter().enumerate() {
            o[4 * i..4 * i + 4].copy_from_slice(&x.to_le_bytes());
        }
    };
    if n == 1 {
        let c = word(cols, 0) ^ word(b, 0);
        let u0 = unres::<M>(word(uv, 0), word(b, 1), word(p, 1));
        let u1 = unres::<M>(word(uv, 1), word(b, 2), word(p, 2));
        for (i, x) in [c, u0, u1].into_iter().enumerate() {
            out[4 * i..4 * i + 4].copy_from_slice(&x.to_le_bytes());
        }
        return;
    }
    let mut k = 0;
    loop {
        pair(k, out);
        if k + 2 == n {
            break;
        }
        k = (k + 2).min(n - 2);
    }
}

/// `x[a..b]`, or `x` itself when empty (an absent base).
#[inline(always)]
fn part(x: &[u8], a: usize, b: usize) -> &[u8] {
    if x.is_empty() {
        x
    } else {
        &x[a..b]
    }
}

/// One surface body `out` (layout `s`): `geo`, `pos` and `uv` are its untransposed words,
/// `cols`, `skin`, `idx` its plain stream bytes, `bb` and `pb` H1's and H2's bodies (empty when
/// absent).
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn unpredict_surface<const M: u8>(
    s: &Surf,
    [geo, pos, cols, uv, skin, idx]: [&[u8]; 6],
    bb: &[u8],
    pb: &[u8],
    out: &mut [u8],
) {
    let n = s.n;
    let stride = s.col + s.uv;
    let pe = 40 + s.sizes[1];
    let ae = pe + n * stride;
    let se = ae + s.sizes[4];
    let (o_geo, rest) = out.split_at_mut(40);
    let (o_pos, rest) = rest.split_at_mut(s.sizes[1]);
    let (o_attr, rest) = rest.split_at_mut(n * stride);
    let (o_skin, o_idx) = rest.split_at_mut(s.sizes[4]);
    unres_words::<M>(geo, part(bb, 0, 40), part(pb, 0, 40), o_geo);
    unres_words::<M>(pos, part(bb, 40, pe), part(pb, 40, pe), o_pos);
    let (ab, ap) = (part(bb, pe, ae), part(pb, pe, ae));
    match (s.col, s.uv) {
        (0, 0) => {}
        (_, 0) => unxor(cols, ab, o_attr),
        (0, _) => unres_words::<M>(uv, ab, ap, o_attr),
        _ => unpredict_attr::<M>(cols, uv, ab, ap, o_attr),
    }
    unxor(skin, part(bb, ae, se), o_skin);
    unxor(idx, part(bb, se, se + s.sizes[5]), o_idx);
}

/// [`code_u8`]'s inverse, straight from the six streams into `dst`.
fn unpredict_u8(
    tx: &TxMeta,
    src: &[u8],
    dst: &mut [u8],
    h1: &PredState,
    h2: &PredState,
    surfs: &mut Vec<Surf>,
    words: &mut Vec<u8>,
    trace: &mut Option<&mut Vec<Unit>>,
) {
    if !u8_layout(tx, src.len(), surfs) {
        dst.copy_from_slice(src);
        return;
    }
    let mut tot = [0usize; 6];
    for s in surfs.iter() {
        for i in 0..6 {
            tot[i] += s.sizes[i];
        }
    }
    let mut start = [0usize; 6];
    for i in 1..6 {
        start[i] = start[i - 1] + tot[i - 1];
    }
    // The three word streams, untransposed: geometry, positions, UVs.
    let need = tot[0] + tot[1] + tot[3];
    if words.len() < need {
        words.resize(need, 0);
    }
    {
        let (w0, rest) = words[..need].split_at_mut(tot[0]);
        let (w1, w3) = rest.split_at_mut(tot[1]);
        for (i, w) in [(0, w0), (1, w1), (3, w3)] {
            untranspose_words(planes(src, start[i], tot[i] / 4), w);
        }
    }
    let wstart = [0, tot[0], 0, tot[0] + tot[1], 0, 0];
    let mut cur = [0usize; 6];
    let mut si = 0;
    for e in &tx.meshes {
        if e.u8.is_none() {
            continue;
        }
        let count = e.surfaces.len();
        let base = h1.body.get(&e.id).filter(|b| b.same_shape(e));
        let prev = base.and(h2.body.get(&e.id).filter(|b| b.same_shape(e)));
        let m = order(base.is_some(), prev.is_some());
        if count > 0 {
            if let Some(t) = trace.as_deref_mut() {
                t.push(Unit {
                    block: "mesh_u8",
                    id: e.id,
                    order: m,
                });
            }
        }
        for (k, s) in surfs[si..si + count].iter().enumerate() {
            let len: usize = s.sizes.iter().sum();
            let out = &mut dst[s.start..s.start + len];
            let bb = base.map_or(&[][..], |b| b.surface(k));
            let pb = prev.map_or(&[][..], |b| b.surface(k));
            let at = |i: usize| -> &[u8] {
                let w = matches!(i, 0 | 1 | 3);
                let (d, o) = if w {
                    (&words[..], wstart[i])
                } else {
                    (src, start[i])
                };
                &d[o + cur[i]..o + cur[i] + s.sizes[i]]
            };
            let streams = [at(0), at(1), at(2), at(3), at(4), at(5)];
            match m {
                0 => unpredict_surface::<0>(s, streams, bb, pb, out),
                1 => unpredict_surface::<1>(s, streams, bb, pb, out),
                _ => unpredict_surface::<2>(s, streams, bb, pb, out),
            }
            for i in 0..6 {
                cur[i] += s.sizes[i];
            }
        }
        si += count;
    }
}

/// [`code_words`]'s inverse: the transposed block `src` into `dst`, each unit's words (float
/// offset, float count, H1 words, H2 words; in offset order, disjoint) un-predicted on the way.
fn unpredict_words<'h>(
    src: &[u8],
    dst: &mut [u8],
    words: &mut Vec<u8>,
    units: impl Iterator<Item = (usize, usize, Option<&'h [u8]>, Option<&'h [u8]>)>,
) {
    let nw = src.len() / 4;
    if words.len() < 4 * nw {
        words.resize(4 * nw, 0);
    }
    let words = &mut words[..4 * nw];
    untranspose_words(planes(src, 0, nw), words);
    let mut at = 0;
    for (off, n, b, p) in units {
        let Some(b) = b else { continue };
        dst[4 * at..4 * off].copy_from_slice(&words[4 * at..4 * off]);
        let (r, out) = (
            &words[4 * off..4 * (off + n)],
            &mut dst[4 * off..4 * (off + n)],
        );
        match p {
            None => unres_words::<1>(r, b, &[], out),
            Some(p) => unres_words::<2>(r, b, p, out),
        }
        at = off + n;
    }
    dst[4 * at..4 * nw].copy_from_slice(&words[4 * at..4 * nw]);
}

/// `mesh_f32` / `mm_f32`: residual words in place of each unit's words, the block transposed.
/// `units` are (float offset, float count, H1 words, H2 words).
fn code_words(
    src: &[u8],
    dst: &mut [u8],
    units: &[(usize, usize, Option<&[u8]>, Option<&[u8]>)],
    inverse: bool,
    words: &mut Vec<u8>,
) {
    if inverse {
        untranspose4(src, dst);
        for &(off, n, b, p) in units {
            if b.is_none() {
                continue;
            }
            for w in 0..n {
                let at = 4 * (off + w);
                let v = unresidual(
                    le32(dst, at),
                    b.map(|x| le32(x, 4 * w)),
                    p.map(|x| le32(x, 4 * w)),
                );
                put32(dst, at, v);
            }
        }
    } else {
        words.clear();
        words.extend_from_slice(src);
        for &(off, n, b, p) in units {
            if b.is_none() {
                continue;
            }
            for w in 0..n {
                let at = 4 * (off + w);
                let r = residual(
                    le32(words, at),
                    b.map(|x| le32(x, 4 * w)),
                    p.map(|x| le32(x, 4 * w)),
                );
                put32(words, at, r);
            }
        }
        transpose4(words, dst);
    }
}

/// `code_blocks`: predicts (`inverse` false: /12 → /13) or un-predicts (/13 → /12) the three
/// blocks of one transaction against (H1, H2). `dst` has `src`'s lengths. `trace` collects the
/// units in the reference's order (mesh_u8, mesh_f32, mm_f32).
pub fn code_blocks(
    tx: &TxMeta,
    src: Blocks<'_>,
    dst: BlocksMut<'_>,
    h1: &PredState,
    h2: &PredState,
    inverse: bool,
    sc: &mut Scratch,
    mut trace: Option<&mut Vec<Unit>>,
) {
    if inverse {
        unpredict_blocks(tx, src, dst, h1, h2, sc, trace);
        return;
    }
    code_u8(
        tx,
        src.mesh_u8,
        dst.mesh_u8,
        h1,
        h2,
        inverse,
        &mut sc.surfs,
        &mut trace,
    );
    // mesh_f32
    if f32_layout(tx, src.mesh_f32.len() / 4, &mut sc.f32u) {
        let units: Vec<_> = sc
            .f32u
            .iter()
            .map(|&(id, off)| {
                let b = h1.aabb.get(&id).map(|a| &a[..]);
                let p = b.and(h2.aabb.get(&id).map(|a| &a[..]));
                if let Some(t) = trace.as_deref_mut() {
                    t.push(Unit {
                        block: "mesh_f32",
                        id,
                        order: order(b.is_some(), p.is_some()),
                    });
                }
                (off, 6, b, p)
            })
            .collect();
        code_words(src.mesh_f32, dst.mesh_f32, &units, inverse, &mut sc.words);
    } else {
        dst.mesh_f32.copy_from_slice(src.mesh_f32);
    }
    // mm_f32
    if mm_layout(tx, src.mm_f32.len() / 4, &mut sc.mmu) {
        let units: Vec<_> = sc
            .mmu
            .iter()
            .map(|&(id, instances, stride, off)| {
                let same = |m: &&Arc<MmBuf>| m.instances == instances && m.stride == stride;
                let b = h1.mm.get(&id).filter(same).map(|m| &m.bytes[..]);
                let p = b.and(h2.mm.get(&id).filter(same).map(|m| &m.bytes[..]));
                if let Some(t) = trace.as_deref_mut() {
                    t.push(Unit {
                        block: "mm_f32",
                        id,
                        order: order(b.is_some(), p.is_some()),
                    });
                }
                (off, instances as usize * stride as usize, b, p)
            })
            .collect();
        code_words(src.mm_f32, dst.mm_f32, &units, inverse, &mut sc.words);
    } else {
        dst.mm_f32.copy_from_slice(src.mm_f32);
    }
}

/// [`code_blocks`] with `inverse`: no per-transaction allocation.
fn unpredict_blocks(
    tx: &TxMeta,
    src: Blocks<'_>,
    dst: BlocksMut<'_>,
    h1: &PredState,
    h2: &PredState,
    sc: &mut Scratch,
    mut trace: Option<&mut Vec<Unit>>,
) {
    unpredict_u8(
        tx,
        src.mesh_u8,
        dst.mesh_u8,
        h1,
        h2,
        &mut sc.surfs,
        &mut sc.words,
        &mut trace,
    );
    if f32_layout(tx, src.mesh_f32.len() / 4, &mut sc.f32u) {
        let trace = &mut trace;
        let units = sc.f32u.iter().map(|&(id, off)| {
            let b = h1.aabb.get(&id).map(|a| &a[..]);
            let p = b.and(h2.aabb.get(&id).map(|a| &a[..]));
            if let Some(t) = trace.as_deref_mut() {
                t.push(Unit {
                    block: "mesh_f32",
                    id,
                    order: order(b.is_some(), p.is_some()),
                });
            }
            (off, 6, b, p)
        });
        unpredict_words(src.mesh_f32, dst.mesh_f32, &mut sc.words, units);
    } else {
        dst.mesh_f32.copy_from_slice(src.mesh_f32);
    }
    if mm_layout(tx, src.mm_f32.len() / 4, &mut sc.mmu) {
        let trace = &mut trace;
        let units = sc.mmu.iter().map(|&(id, instances, stride, off)| {
            let same = |m: &&Arc<MmBuf>| m.instances == instances && m.stride == stride;
            let b = h1.mm.get(&id).filter(same).map(|m| &m.bytes[..]);
            let p = b.and(h2.mm.get(&id).filter(same).map(|m| &m.bytes[..]));
            if let Some(t) = trace.as_deref_mut() {
                t.push(Unit {
                    block: "mm_f32",
                    id,
                    order: order(b.is_some(), p.is_some()),
                });
            }
            (off, instances as usize * stride as usize, b, p)
        });
        unpredict_words(src.mm_f32, dst.mm_f32, &mut sc.words, units);
    } else {
        dst.mm_f32.copy_from_slice(src.mm_f32);
    }
}

/// `predict_check`'s value: XXH64 (seed 0) of /12's `mesh_f32` ‖ `mesh_u8` ‖ `mm_f32`.
pub fn check(b: Blocks<'_>) -> u64 {
    let mut h = Xxh64::new(0);
    h.update(b.mesh_f32);
    h.update(b.mesh_u8);
    h.update(b.mm_f32);
    h.digest()
}

/// 16 lowercase hex digits.
pub fn check_hex(v: u64) -> String {
    format!("{v:016x}")
}

// --------------------------------------------------------------------------- records

fn block<'r>(record: &'r [u8], blocks: &[BlockRange], i: usize) -> &'r [u8] {
    blocks
        .get(i)
        .map(|b| &record[b.start..b.start + b.len])
        .unwrap_or(&[])
}

/// The three predicted blocks of a record.
pub fn blocks_of<'r>(record: &'r [u8], blocks: &[BlockRange]) -> Blocks<'r> {
    Blocks {
        mesh_f32: block(record, blocks, MESH_F32),
        mesh_u8: block(record, blocks, MESH_U8),
        mm_f32: block(record, blocks, MM_F32),
    }
}

/// Mutable views of the three predicted blocks of `record` (a transaction record with at least
/// nine blocks: `mesh_f32` before `mesh_u8` before `mm_f32`).
pub fn blocks_of_mut<'r>(record: &'r mut [u8], blocks: &[BlockRange]) -> BlocksMut<'r> {
    let (f, u, m) = (blocks[MESH_F32], blocks[MESH_U8], blocks[MM_F32]);
    let (head, rest) = record.split_at_mut(u.start);
    let (mesh_u8, tail) = rest.split_at_mut(u.len);
    let m0 = m.start - (u.start + u.len);
    BlocksMut {
        mesh_f32: &mut head[f.start..f.start + f.len],
        mesh_u8,
        mm_f32: &mut tail[m0..m0 + m.len],
    }
}

/// The position of `,"blocks":[` in a transaction meta (the last key; its value holds no such
/// text).
fn blocks_mark(meta: &[u8]) -> Option<usize> {
    meta.windows(BLOCKS_MARK.len())
        .rposition(|w| w == BLOCKS_MARK)
}

/// A record with meta `meta` and the body (block count and blocks) `body`.
fn make_record(out: &mut Vec<u8>, meta_parts: &[&[u8]], body: &[u8]) {
    let meta_len: usize = meta_parts.iter().map(|p| p.len()).sum();
    out.extend_from_slice(&((4 + meta_len + body.len()) as u32).to_le_bytes());
    out.extend_from_slice(&(meta_len as u32).to_le_bytes());
    for p in meta_parts {
        out.extend_from_slice(p);
    }
    out.extend_from_slice(body);
}

/// The validator's /13 step: writes into `plain` the /12 record equivalent to the /13 transaction
/// `record` (its meta without `predict_check`, its three predicted blocks un-predicted against
/// (H1, H2)), shifts `blocks` to index `plain`, and returns `(declared, computed)` check values.
/// `tx` is the record's checked meta (`predict_check` present).
pub fn unpredict_record(
    record: &[u8],
    tx: &TxMeta,
    blocks: &mut [BlockRange],
    h1: &PredState,
    h2: &PredState,
    sc: &mut Scratch,
    plain: &mut Vec<u8>,
) -> Result<(u64, u64), Error> {
    let meta_len = wire::le_u32(record, 4) as usize;
    let meta = &record[8..8 + meta_len];
    let declared = tx.predict_check;
    let cut = blocks_mark(meta)
        .filter(|&i| i >= CHECK_BYTES && meta[i - CHECK_BYTES..].starts_with(CHECK_KEY))
        .map(|i| 8 + i - CHECK_BYTES);
    let (Some(cut), Some(declared)) = (cut, declared) else {
        return Err(Error::new(
            "meta-schema",
            "a render-stream/13 transaction meta has no \"predict_check\" right before \"blocks\"",
        ));
    };
    // `plain` keeps its allocation and is overwritten in place: every byte but `mesh_u8`'s from
    // the record, and `mesh_u8` (written whole by the un-predictor, pass-through included) not
    // copied at all.
    let u = blocks[MESH_U8];
    plain.resize(record.len() - CHECK_BYTES, 0);
    plain[..cut].copy_from_slice(&record[..cut]);
    plain[cut..u.start - CHECK_BYTES].copy_from_slice(&record[cut + CHECK_BYTES..u.start]);
    plain[u.start + u.len - CHECK_BYTES..].copy_from_slice(&record[u.start + u.len..]);
    let rl = plain.len() as u32 - 4;
    plain[0..4].copy_from_slice(&rl.to_le_bytes());
    plain[4..8].copy_from_slice(&((meta_len - CHECK_BYTES) as u32).to_le_bytes());
    let src = blocks_of(record, blocks);
    for b in blocks.iter_mut() {
        b.start -= CHECK_BYTES;
    }
    let dst = blocks_of_mut(plain, blocks);
    code_blocks(tx, src, dst, h1, h2, true, sc, None);
    let computed = check(blocks_of(plain, blocks));
    Ok((declared, computed))
}

/// The /13 record of the /12 transaction `record` (predicted against (H1, H2)).
pub fn predict_record(
    record: &[u8],
    tx: &TxMeta,
    blocks: &[BlockRange],
    h1: &PredState,
    h2: &PredState,
    sc: &mut Scratch,
    trace: Option<&mut Vec<Unit>>,
    out: &mut Vec<u8>,
) {
    let meta_len = wire::le_u32(record, 4) as usize;
    let meta = &record[8..8 + meta_len];
    let i = blocks_mark(meta).expect("a transaction meta has \"blocks\"");
    let hex = check_hex(check(blocks_of(record, blocks)));
    let at = out.len();
    make_record(
        out,
        &[&meta[..i], CHECK_KEY, hex.as_bytes(), b"\"", &meta[i..]],
        &record[8 + meta_len..],
    );
    let shifted: Vec<BlockRange> = blocks
        .iter()
        .map(|b| BlockRange {
            start: b.start + CHECK_BYTES,
            len: b.len,
        })
        .collect();
    let src = blocks_of(record, blocks);
    let dst = blocks_of_mut(&mut out[at..], &shifted);
    code_blocks(tx, src, dst, h1, h2, false, sc, trace);
}

// --------------------------------------------------------------------------- transcode

/// A session record with its `protocol` swapped (`from` → `to`, first occurrence).
fn swap_protocol(record: &[u8], from: &[u8], to: &[u8], out: &mut Vec<u8>) -> Result<(), Error> {
    let meta_len = wire::le_u32(record, 4) as usize;
    let meta = &record[8..8 + meta_len];
    let Some(i) = meta.windows(from.len()).position(|w| w == from) else {
        return Err(Error::new(
            "meta-schema",
            "the session record's protocol is not the input version's",
        ));
    };
    make_record(
        out,
        &[&meta[..i], to, &meta[i + from.len()..]],
        &record[8 + meta_len..],
    );
    Ok(())
}

/// Replaces the canonical integer after `key` in `meta` (first occurrence) by `f(old)`.
fn edit_int(meta: &[u8], key: &[u8], f: impl FnOnce(i64) -> Option<i64>) -> Vec<u8> {
    let Some(i) = meta.windows(key.len()).position(|w| w == key) else {
        return meta.to_vec();
    };
    let s = i + key.len();
    let mut e = s;
    if meta.get(e) == Some(&b'-') {
        e += 1;
    }
    while meta.get(e).is_some_and(|c| c.is_ascii_digit()) {
        e += 1;
    }
    let Some(old) = std::str::from_utf8(&meta[s..e])
        .ok()
        .and_then(|t| t.parse::<i64>().ok())
    else {
        return meta.to_vec();
    };
    let Some(new) = f(old) else {
        return meta.to_vec();
    };
    let mut out = meta[..s].to_vec();
    out.extend_from_slice(new.to_string().as_bytes());
    out.extend_from_slice(&meta[e..]);
    out
}

/// `_fix_end`: `stats.bytes_total` moves by the size change; `stats.max_record_bytes` becomes
/// the output's own maximum when the input's was its own.
fn fix_end(record: &[u8], out_lens: &[usize], in_lens: &[usize], out: &mut Vec<u8>) {
    let meta_len = wire::le_u32(record, 4) as usize;
    let meta = &record[8..8 + meta_len];
    let delta = out_lens.iter().sum::<usize>() as i64 - in_lens.iter().sum::<usize>() as i64;
    let meta = edit_int(meta, b"\"bytes_total\":", |b| Some(b + delta));
    let in_max = in_lens.iter().max().copied();
    let out_max = out_lens.iter().max().copied();
    let meta = edit_int(&meta, b"\"max_record_bytes\":", |m| {
        match (in_max, out_max) {
            (Some(i), Some(o)) if m == i as i64 => Some(o as i64),
            _ => None,
        }
    });
    make_record(out, &[&meta], &record[8 + meta_len..]);
}

/// Per-transaction units a transcode predicted.
#[derive(Clone, Debug, PartialEq)]
pub struct TxTrace {
    pub seq: i64,
    pub units: Vec<Unit>,
}

/// `to13`: transcodes a /12 recording to /13 (the encoder). The input is validated first (its
/// first error is returned). `stale` is the encoder sabotage `predict-stale`.
pub fn to13(
    data12: &[u8],
    stale: bool,
    mut trace: Option<&mut Vec<TxTrace>>,
) -> Result<Vec<u8>, Error> {
    crate::validate::validate_recording(data12, Options::new(12))?;
    let spans = wire::split_records(data12, 12)?;
    let mut out = wire::magic(13).to_vec();
    out.reserve(data12.len() + 64 * spans.len());
    let (mut in_lens, mut out_lens) = (Vec::new(), Vec::new());
    let mut hist = History::default();
    let mut sc = Scratch::default();
    let mut bufs = DecodeBufs::default();
    let mut tx = TxMeta::default();
    for span in &spans {
        let rec = span.bytes(data12);
        let at = out.len();
        match meta::decode_record(rec, span.offset, 12, &mut bufs, &mut tx)? {
            Decoded::Session(_) => swap_protocol(rec, PROTOCOL_12, PROTOCOL_13, &mut out)?,
            Decoded::Transaction => {
                let (h1, h2) = hist.refs(tx.is_full(), stale, false);
                let mut units = Vec::new();
                predict_record(
                    rec,
                    &tx,
                    &bufs.blocks,
                    h1,
                    h2,
                    &mut sc,
                    trace.is_some().then_some(&mut units),
                    &mut out,
                );
                if let Some(t) = trace.as_deref_mut() {
                    t.push(TxTrace { seq: tx.seq, units });
                }
                hist.accept(&tx, blocks_of(rec, &bufs.blocks), false, &mut sc);
            }
            Decoded::End(_) => fix_end(rec, &out_lens, &in_lens, &mut out),
            Decoded::Resource(_) => out.extend_from_slice(rec),
        }
        out_lens.push(out.len() - at);
        in_lens.push(rec.len());
    }
    Ok(out)
}

/// `to12`: transcodes a /13 recording to /12 (the decoder: the validator's
/// [`Validator::plain_record`]). The input is validated as it goes (its first error is returned).
/// `no_reset` is the decoder sabotage `no-predict-reset`.
pub fn to12(data13: &[u8], no_reset: bool) -> Result<Vec<u8>, Error> {
    let spans = wire::split_records(data13, 13)?;
    let first = spans
        .first()
        .ok_or_else(|| Error::new("missing-session", "the recording has no records"))?;
    let opts = Options {
        no_predict_reset: no_reset,
        ..Options::new(13)
    };
    let mut v = Validator::new(first.bytes(data13), first.offset, opts)?;
    let mut out = wire::magic(12).to_vec();
    out.reserve(data13.len());
    swap_protocol(first.bytes(data13), PROTOCOL_13, PROTOCOL_12, &mut out)?;
    let mut out_lens = vec![out.len() - MAGIC_LEN];
    let mut in_lens = vec![first.bytes(data13).len()];
    for span in &spans[1..] {
        let rec = span.bytes(data13);
        let at = out.len();
        match v.accept(rec, span.offset)? {
            crate::validate::Accepted::Transaction => {
                out.extend_from_slice(v.plain_record().expect("a /13 transaction's plain record"))
            }
            crate::validate::Accepted::End => fix_end(rec, &out_lens, &in_lens, &mut out),
            crate::validate::Accepted::Resource { .. } => out.extend_from_slice(rec),
        }
        out_lens.push(out.len() - at);
        in_lens.push(rec.len());
    }
    v.finish()?;
    Ok(out)
}

/// Units by order (raw, first, second) over a trace.
pub fn order_counts(trace: &[TxTrace]) -> [usize; 3] {
    let mut c = [0usize; 3];
    for t in trace {
        for u in &t.units {
            c[u.order as usize] += 1;
        }
    }
    c
}
