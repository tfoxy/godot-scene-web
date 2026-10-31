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
//! W13r ("As built (W13r)"): each predicted block travels as zero runs over its coded bytes
//! ([`zr_encode`], [`zr_decode`]: `zr-length`, `zr-noncanonical`), expanded into
//! [`Scratch`] before the un-predict reads it.
//!
//! The history keeps each unit's last two writes ([`History`]): advancing touches only the units a
//! transaction carries or drops, and each write reuses the storage of the one it supersedes.

use crate::coding::Xxh64;
use crate::meta::{self, DecodeBufs, Decoded, MeshMeta, TxMeta};
use crate::state::{EntryStatus, Id, Primitive};
use crate::validate::{IdHasher, Options, Validator};
use crate::wire::{self, BlockRange, Error, MAGIC_LEN};
use std::collections::HashMap;
use std::hash::BuildHasherDefault;

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

/// `Bodies::rec` of bodies held in `Bodies::bytes`.
const OWNED: u32 = u32::MAX;

/// One mesh's bodies in R: its surface shapes and their bodies, concatenated, either in place in
/// a plain record the [`History`] retains (`rec`, `gen`, `at`) or in `bytes`
/// ([`History::bodies`] resolves them).
#[derive(Debug)]
pub struct Bodies {
    shape: Vec<Shape>,
    /// End offset of each surface's body.
    ends: Vec<usize>,
    bytes: Vec<u8>,
    /// The retained record ([`History`]'s `recs` index) holding the bodies at `at`, or [`OWNED`].
    rec: u32,
    /// That record's generation (the time of the transaction it is).
    gen: u64,
    at: usize,
}

impl Default for Bodies {
    fn default() -> Self {
        Bodies {
            shape: Vec::new(),
            ends: Vec::new(),
            bytes: Vec::new(),
            rec: OWNED,
            gen: NEVER,
            at: 0,
        }
    }
}

impl Bodies {
    fn len(&self) -> usize {
        self.ends.last().copied().unwrap_or(0)
    }
    /// Surface `k`'s body, of the bodies `all` ([`History::bodies`]).
    fn surface<'a>(&self, all: &'a [u8], k: usize) -> &'a [u8] {
        let start = if k == 0 { 0 } else { self.ends[k - 1] };
        &all[start..self.ends[k]]
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
#[derive(Default, PartialEq, Debug)]
pub struct MmBuf {
    instances: i64,
    stride: u64,
    bytes: Vec<u8>,
}

/// A [`Ver`] never written.
const NEVER: u64 = u64::MAX;

/// One value of a unit, written by the transaction at time `t` (`live` false: dropped there).
/// `v` keeps its storage when dropped or superseded, for a later write to reuse.
#[derive(Debug)]
struct Ver<V> {
    t: u64,
    live: bool,
    v: V,
}

/// A unit's last two writes, `new` after `old`. R at time x is the newest write at or before x,
/// and H1 and H2 only ever look at the last two times, so two writes are all R needs: a write
/// at T reuses the storage of the older one (whose value no view can reach any more).
#[derive(Debug)]
struct Slot<V> {
    new: Ver<V>,
    old: Ver<V>,
}

impl<V: Default> Slot<V> {
    fn fresh() -> Self {
        let never = || Ver {
            t: NEVER,
            live: false,
            v: V::default(),
        };
        Slot {
            new: never(),
            old: never(),
        }
    }

    /// The unit's value in R(x).
    #[inline]
    fn at(&self, x: u64) -> Option<&V> {
        let w = if self.new.t <= x {
            &self.new
        } else if self.old.t <= x {
            &self.old
        } else {
            return None;
        };
        w.live.then_some(&w.v)
    }

    /// The write at time `t` (the last one again when T already wrote this unit).
    #[inline]
    fn write(&mut self, t: u64) -> &mut Ver<V> {
        if self.new.t != t {
            std::mem::swap(&mut self.new, &mut self.old);
            self.new.t = t;
        }
        &mut self.new
    }
}

/// Ids below this index a [`Track`]'s slots directly; larger ones go through a hash map.
const DENSE_IDS: usize = 1 << 16;

/// One kind of unit (bodies, AABBs or buffers) across R's last two times: a slab of slots,
/// indexed by id. A removed slot keeps its storage for the next unit that needs one.
#[derive(Debug)]
struct Track<V> {
    slots: Vec<(Id, Slot<V>)>,
    /// Unused entries of `slots`.
    free: Vec<u32>,
    /// id → slot index + 1 (0: none), for ids below [`DENSE_IDS`].
    dense: Vec<u32>,
    /// id → slot index, for the rest.
    sparse: Map<u32>,
    /// Units dropped at the current time and at the one before: once absent from both H1 and
    /// H2, a slot is removed.
    dropped: Vec<Id>,
    dropped_before: Vec<Id>,
}

impl<V> Default for Track<V> {
    fn default() -> Self {
        Track {
            slots: Vec::new(),
            free: Vec::new(),
            dense: Vec::new(),
            sparse: Map::default(),
            dropped: Vec::new(),
            dropped_before: Vec::new(),
        }
    }
}

impl<V: Default> Track<V> {
    #[inline]
    fn index(&self, id: Id) -> Option<usize> {
        if (id as usize) < DENSE_IDS {
            match self.dense.get(id as usize) {
                Some(&i) if i > 0 => Some(i as usize - 1),
                _ => None,
            }
        } else {
            self.sparse.get(&id).map(|&i| i as usize)
        }
    }

    #[inline]
    fn get(&self, id: Id) -> Option<&Slot<V>> {
        self.index(id).map(|i| &self.slots[i].1)
    }

    /// Unit `id`'s slot, made (fresh, or a removed one's storage) when it has none.
    #[inline]
    fn slot(&mut self, id: Id) -> &mut Slot<V> {
        let i = match self.index(id) {
            Some(i) => i,
            None => self.insert(id),
        };
        &mut self.slots[i].1
    }

    #[cold]
    fn insert(&mut self, id: Id) -> usize {
        let i = match self.free.pop() {
            Some(i) => {
                let (sid, s) = &mut self.slots[i as usize];
                *sid = id;
                s.new.t = NEVER;
                s.old.t = NEVER;
                i as usize
            }
            None => {
                self.slots.push((id, Slot::fresh()));
                self.slots.len() - 1
            }
        };
        if (id as usize) < DENSE_IDS {
            if self.dense.len() <= id as usize {
                self.dense.resize(id as usize + 1, 0);
            }
            self.dense[id as usize] = i as u32 + 1;
        } else {
            self.sparse.insert(id, i as u32);
        }
        i
    }

    fn remove(&mut self, id: Id) {
        let Some(i) = self.index(id) else { return };
        if (id as usize) < DENSE_IDS {
            self.dense[id as usize] = 0;
        } else {
            self.sparse.remove(&id);
        }
        let s = &mut self.slots[i].1;
        s.new.t = NEVER;
        s.old.t = NEVER;
        self.free.push(i as u32);
    }

    /// The storage of unit `id`'s new value at time `t`.
    #[inline]
    fn set(&mut self, id: Id, t: u64) -> &mut V {
        let w = self.slot(id).write(t);
        w.live = true;
        &mut w.v
    }

    /// Drops unit `id` at time `t`.
    #[inline]
    fn drop_at(&mut self, id: Id, t: u64) {
        let Some(i) = self.index(id) else { return };
        let s = &mut self.slots[i].1;
        if s.new.live {
            s.write(t).live = false;
            self.dropped.push(id);
        }
    }

    /// After time `t`'s writes: removes the slots of units dropped at `t − 1` and not written
    /// since (absent from R(t) and R(t − 1)).
    fn prune(&mut self, t: u64) {
        let mut dropped = std::mem::take(&mut self.dropped_before);
        for &id in &dropped {
            if let Some(s) = self.get(id) {
                if s.new.t.wrapping_add(1) == t && !s.new.live {
                    self.remove(id);
                }
            }
        }
        dropped.clear();
        self.dropped_before = std::mem::replace(&mut self.dropped, dropped);
    }

    /// Removes every slot (a full), keeping their storage.
    fn clear(&mut self) {
        let ids: Vec<Id> = self.live_ids().collect();
        for id in ids {
            self.remove(id);
        }
        self.dropped.clear();
        self.dropped_before.clear();
    }

    fn live_ids(&self) -> impl Iterator<Item = Id> + '_ {
        self.slots
            .iter()
            .filter(|(_, s)| s.new.t != NEVER)
            .map(|(id, _)| *id)
    }

    fn live_at(&self, x: Option<u64>) -> impl Iterator<Item = (Id, &V)> {
        self.slots
            .iter()
            .filter_map(move |(id, s)| Some((*id, s.at(x?)?)))
    }

    fn len_at(&self, x: Option<u64>) -> usize {
        self.live_at(x).count()
    }
}

impl<V: Default> Track<V> {
    fn same_at(
        &self,
        x: Option<u64>,
        other: &Track<V>,
        y: Option<u64>,
        eq: impl Fn(&V, &V) -> bool,
    ) -> bool {
        self.len_at(x) == other.len_at(y)
            && self.live_at(x).all(|(id, v)| {
                y.and_then(|y| other.get(id)?.at(y))
                    .is_some_and(|w| eq(v, w))
            })
    }
}

/// R at one time of a [`History`] (H1, H2 or ∅): what a transaction is coded against.
#[derive(Clone, Copy)]
pub struct PredState<'a> {
    h: &'a History,
    /// The time; `None` is ∅.
    at: Option<u64>,
}

impl PredState<'_> {
    pub fn is_empty(&self) -> bool {
        self.counts() == (0, 0, 0)
    }
    /// (bodies, AABBs, buffers) held.
    pub fn counts(&self) -> (usize, usize, usize) {
        (
            self.h.body.len_at(self.at),
            self.h.aabb.len_at(self.at),
            self.h.mm.len_at(self.at),
        )
    }
}

impl PartialEq for PredState<'_> {
    fn eq(&self, o: &Self) -> bool {
        let bodies = |a: &Bodies, b: &Bodies| {
            a.shape == b.shape && a.ends == b.ends && self.h.bodies(a) == o.h.bodies(b)
        };
        self.h.body.same_at(self.at, &o.h.body, o.at, bodies)
            && self.h.aabb.same_at(self.at, &o.h.aabb, o.at, |a, b| a == b)
            && self.h.mm.same_at(self.at, &o.h.mm, o.at, |a, b| a == b)
    }
}

impl std::fmt::Debug for PredState<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PredState {{ at: {:?}, counts: {:?} }}", self.at, self.counts())
    }
}

/// (H1's, H2's) value of unit `id` in `track`: one lookup when both read the same history. H2's
/// is only looked up when H1 has one (every caller predicts to second order only from a first).
#[inline]
fn pair<'a, V: Default>(
    h1: PredState<'a>,
    h2: PredState<'a>,
    track: impl Fn(&'a History) -> &'a Track<V>,
    id: Id,
) -> (Option<&'a V>, Option<&'a V>) {
    let Some(x1) = h1.at else {
        return (None, None);
    };
    let Some(s) = track(h1.h).get(id) else {
        return (None, None);
    };
    let Some(b) = s.at(x1) else {
        return (None, None);
    };
    let p = match h2.at {
        None => None,
        Some(x2) if std::ptr::eq(h1.h, h2.h) => s.at(x2),
        Some(x2) => track(h2.h).get(id).and_then(|s| s.at(x2)),
    };
    (Some(b), p)
}

/// A plain record a [`History`] retains: bodies of the units its transaction carried stay in
/// place in it.
#[derive(Debug)]
struct Rec {
    /// The transaction's time, or [`NEVER`] for a free buffer.
    gen: u64,
    buf: Vec<u8>,
    /// The units whose bodies were set from it.
    ids: Vec<Id>,
}

/// One end's prediction history: H1 = R(T−1), H2 = R(T−2), reset by a full.
///
/// Each unit keeps its last two writes (a [`Slot`]), so advancing to R(T) touches only the units
/// T carries or drops: nothing is cloned per transaction, and in a steady stream every write
/// reuses the storage of the write it supersedes (no allocation). The validator's path
/// ([`History::take_plain`], [`History::accept_plain`]) copies no body either: the plain records
/// rotate through the history, and bodies are read in place in the last two (a unit's bodies
/// move into owned storage only when an older record they sit in is recycled).
#[derive(Default, Debug)]
pub struct History {
    /// The time of R(T−1) (transactions accepted; 0 before the first).
    now: u64,
    body: Track<Bodies>,
    aabb: Track<[u8; 24]>,
    mm: Track<MmBuf>,
    recs: Vec<Rec>,
}

impl History {
    /// (H1, H2) to code a transaction against. `stale` is the encoder sabotage `predict-stale`
    /// (predict from H2 as if it were H1, first order); `no_reset` the decoder sabotage
    /// `no-predict-reset` (a full predicts like a patch).
    pub fn refs(&self, full: bool, stale: bool, no_reset: bool) -> (PredState<'_>, PredState<'_>) {
        let empty = PredState { h: self, at: None };
        if full && !no_reset {
            (empty, empty)
        } else if stale {
            (self.h2(), empty)
        } else {
            (self.h1(), self.h2())
        }
    }

    /// Advances the history past an accepted transaction, from its /12 (reconstructed) blocks.
    pub fn accept(&mut self, tx: &TxMeta, b: Blocks<'_>, no_reset: bool, sc: &mut Scratch) {
        let t = self.now + 1;
        if tx.is_full() && !no_reset {
            // R(full) starts from ∅, and H2 = ∅ after it: every slot goes, so every unit's
            // first write is at `t` and nothing reads as present before it.
            self.body.clear();
            self.aabb.clear();
            self.mm.clear();
        }
        advance(
            (&mut self.body, &mut self.aabb, &mut self.mm),
            t,
            tx,
            b,
            sc,
            None,
        );
        self.finish(t);
    }

    fn finish(&mut self, t: u64) {
        self.body.prune(t);
        self.aabb.prune(t);
        self.mm.prune(t);
        self.now = t;
    }

    /// Bodies' bytes.
    #[inline]
    fn bodies<'a>(&'a self, b: &'a Bodies) -> &'a [u8] {
        if b.rec == OWNED {
            &b.bytes
        } else {
            let r = &self.recs[b.rec as usize];
            debug_assert_eq!(r.gen, b.gen);
            &r.buf[b.at..b.at + b.len()]
        }
    }

    /// A buffer for the next transaction's plain record (the validator's /13 path), to give back
    /// to [`History::accept_plain`] or [`History::return_plain`]. It is a free one, or the
    /// oldest record no unit of R(T−1) or R(T−2) was set from in that transaction: the bodies of
    /// units still reading it move into owned storage first.
    pub fn take_plain(&mut self) -> Vec<u8> {
        let now = self.now;
        let evictable = |r: &Rec| r.gen == NEVER || r.gen.saturating_add(1) < now;
        let pick = self
            .recs
            .iter()
            .enumerate()
            .filter(|(_, r)| evictable(r))
            .min_by_key(|(_, r)| (r.gen != NEVER, r.buf.capacity() == 0, r.gen))
            .map(|(i, _)| i);
        let Some(i) = pick else {
            return Vec::new();
        };
        if self.recs[i].gen != NEVER {
            self.release(i);
        }
        std::mem::take(&mut self.recs[i].buf)
    }

    /// Moves the bodies still read in place in record `i` into owned storage; frees it.
    #[cold]
    fn release(&mut self, i: usize) {
        let Rec { gen, buf, ids } = &mut self.recs[i];
        for id in ids.drain(..) {
            let Some(k) = self.body.index(id) else { continue };
            let slot = &mut self.body.slots[k].1;
            for w in [&mut slot.new, &mut slot.old] {
                let x = &mut w.v;
                if x.rec == i as u32 && x.gen == *gen {
                    let len = x.len();
                    x.bytes.clear();
                    x.bytes.extend_from_slice(&buf[x.at..x.at + len]);
                    x.rec = OWNED;
                }
            }
        }
        *gen = NEVER;
    }

    /// Takes back a buffer from [`History::take_plain`] whose transaction was not accepted.
    pub fn return_plain(&mut self, buf: Vec<u8>) {
        self.store(NEVER, buf);
    }

    fn store(&mut self, gen: u64, buf: Vec<u8>) -> usize {
        let i = match self
            .recs
            .iter()
            .position(|r| r.gen == NEVER && r.buf.capacity() == 0)
        {
            Some(i) => i,
            None => {
                self.recs.push(Rec {
                    gen: NEVER,
                    buf: Vec::new(),
                    ids: Vec::new(),
                });
                self.recs.len() - 1
            }
        };
        let r = &mut self.recs[i];
        r.gen = gen;
        r.buf = buf;
        r.ids.clear();
        i
    }

    /// [`History::accept`] for the validator: `plain` is the accepted transaction's plain /12
    /// record (from [`History::take_plain`]) and `blocks` its block ranges. The history keeps it
    /// ([`History::plain`]) and reads the carried bodies in place.
    pub fn accept_plain(
        &mut self,
        tx: &TxMeta,
        plain: Vec<u8>,
        blocks: &[BlockRange],
        no_reset: bool,
        sc: &mut Scratch,
    ) {
        let t = self.now + 1;
        if tx.is_full() && !no_reset {
            self.body.clear();
            self.aabb.clear();
            self.mm.clear();
        }
        let i = self.store(t, plain);
        let at = blocks.get(MESH_U8).map_or(0, |b| b.start);
        let Rec { buf, ids, .. } = &mut self.recs[i];
        advance(
            (&mut self.body, &mut self.aabb, &mut self.mm),
            t,
            tx,
            blocks_of(buf, blocks),
            sc,
            Some((i as u32, at, ids)),
        );
        self.finish(t);
    }

    /// The plain record of the last transaction when it came through
    /// [`History::accept_plain`].
    pub fn plain(&self) -> Option<&[u8]> {
        self.recs
            .iter()
            .find(|r| r.gen == self.now && r.gen != NEVER)
            .map(|r| r.buf.as_slice())
    }

    pub fn h1(&self) -> PredState<'_> {
        PredState {
            h: self,
            at: Some(self.now),
        }
    }
    pub fn h2(&self) -> PredState<'_> {
        PredState {
            h: self,
            at: self.now.checked_sub(1),
        }
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
    /// W13r: the three predicted blocks' W13a coded bytes (`mesh_f32`, `mesh_u8`, `mm_f32`):
    /// expanded from the zero runs (decoder, every byte written) or the coder's output before
    /// the runs are formed (encoder).
    coded: [Vec<u8>; 3],
}

// --------------------------------------------------------------------------- zero runs (W13r)

/// Whether an error code is a /13 coding failure a live receiver resyncs with reason `coding`
/// (render-stream-13.md "Decoding and check order", "As built (W13r)"): `predict-check`,
/// `zr-length`, `zr-noncanonical`. The transaction applied nothing.
pub fn is_coding_error(code: &str) -> bool {
    matches!(code, "predict-check" | "zr-length" | "zr-noncanonical")
}

/// The minimum zero run the compact residual elides (render-stream-13.md "As built (W13r)").
pub const ZR_MIN: usize = 4;

/// W13r's writer sabotages (make_golden.py `zr_sabotage`): `Overrun` makes the first zero run of
/// a transaction one zero too long; `ShortRun` elides its first 3-byte zero run as a token.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum ZrSabotage {
    #[default]
    None,
    Overrun,
    ShortRun,
}

fn put_uvarint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

/// `zr_encode`: appends the canonical tokens of `c` to `out` (`sabotage` as make_golden.py's).
pub fn zr_encode(c: &[u8], sabotage: ZrSabotage, out: &mut Vec<u8>) {
    let n = c.len();
    let mut short_done = false;
    let mut extra = (sabotage == ZrSabotage::Overrun) as u64;
    // The token being built: its zero run and where its literal starts.
    let mut first = true;
    let (mut zeros, mut lit) = (0usize, 0usize);
    let mut k = 0;
    while k < n {
        if c[k] != 0 {
            k += 1;
            continue;
        }
        let mut j = k;
        while j < n && c[j] == 0 {
            j += 1;
        }
        let run = j - k;
        if run >= ZR_MIN || (sabotage == ZrSabotage::ShortRun && !short_done && run == 3) {
            short_done |= run == 3;
            // Close the open token (the first one only when it has a literal).
            if !first || k > 0 {
                put_uvarint(out, zeros as u64);
                put_uvarint(out, (k - lit) as u64);
                out.extend_from_slice(&c[lit..k]);
            }
            first = false;
            zeros = run + extra as usize;
            extra = 0;
            lit = j;
        }
        k = j;
    }
    if !first || n > 0 {
        put_uvarint(out, zeros as u64);
        put_uvarint(out, (n - lit) as u64);
        out.extend_from_slice(&c[lit..n]);
    }
}

/// The canonical tokens of `c` with `sabotage` applied when it changes them: `(tokens, acted)`.
fn zr_encode_sabotaged(c: &[u8], sabotage: ZrSabotage, out: &mut Vec<u8>) -> bool {
    let at = out.len();
    zr_encode(c, ZrSabotage::None, out);
    if sabotage == ZrSabotage::None {
        return false;
    }
    let mut bad = Vec::new();
    zr_encode(c, sabotage, &mut bad);
    if bad[..] == out[at..] {
        return false;
    }
    out.truncate(at);
    out.extend_from_slice(&bad);
    true
}

/// One uvarint of `s` at `*p`: `(value, minimal)`, or `None` when it runs past the stream or has
/// more than 10 bytes (`zr-length`). A value past 2^64 saturates (it passes any length).
#[inline(always)]
fn read_uvarint(s: &[u8], p: &mut usize) -> Option<(u64, bool)> {
    // Almost every count is below 128: one byte.
    match s.get(*p) {
        Some(&b) if b < 0x80 => {
            *p += 1;
            Some((b as u64, true))
        }
        Some(_) => read_uvarint_long(s, p),
        None => None,
    }
}

#[cold]
fn read_uvarint_long(s: &[u8], p: &mut usize) -> Option<(u64, bool)> {
    let start = *p;
    let mut v: u64 = 0;
    let mut shift = 0u32;
    loop {
        if *p >= s.len() || *p - start >= 10 {
            return None;
        }
        let b = s[*p];
        *p += 1;
        let bits = (b & 0x7f) as u64;
        if shift < 64 {
            if shift > 0 && bits >> (64 - shift) != 0 {
                v = u64::MAX;
            } else if v != u64::MAX {
                v |= bits << shift;
            }
        } else if bits != 0 {
            v = u64::MAX;
        }
        shift += 7;
        if b & 0x80 == 0 {
            return Some((v, *p - start == 1 || b != 0));
        }
    }
}

/// Whether `lit` holds a run of [`ZR_MIN`] (4) zero bytes: 8 bytes a step on an exact zero-byte
/// mask, branch-free, carrying the zero bytes that end a step into the next.
#[inline]
fn has_zero_run(lit: &[u8]) -> bool {
    const LO7: u64 = 0x7f7f_7f7f_7f7f_7f7f;
    const HI: u64 = 0x8080_8080_8080_8080;
    let mut carry = 0u32; // zero bytes ending the previous step
    let mut found = false;
    let mut chunks = lit.chunks_exact(8);
    for c in &mut chunks {
        let w = u64::from_le_bytes(c.try_into().unwrap());
        // The high bit of each byte of `z` is set exactly where `w`'s byte is zero.
        let z = !(((w & LO7).wrapping_add(LO7)) | w | LO7);
        let nz = !z & HI; // the high bit of each nonzero byte
        found |= (z & (z >> 8) & (z >> 16) & (z >> 24)) != 0;
        found |= carry + nz.trailing_zeros() / 8 >= ZR_MIN as u32;
        carry = nz.leading_zeros() / 8;
    }
    let mut run = carry as usize;
    for &b in chunks.remainder() {
        run = if b == 0 { run + 1 } else { 0 };
        found |= run >= ZR_MIN;
    }
    found
}

/// `zr_decode`: replaces `out` by the `len` plain bytes of the token stream `s` (its storage
/// reused, every byte written). `zr-length` when the stream does not cover exactly `len`,
/// whatever else is wrong; else `zr-noncanonical` at the first token that breaks the canonical
/// form. `what` labels messages.
pub fn zr_decode(
    s: &[u8],
    len: usize,
    out: &mut Vec<u8>,
    what: &dyn Fn() -> String,
) -> Result<(), Error> {
    if out.len() < len {
        out.resize(len, 0);
    } else {
        out.truncate(len);
    }
    zr_expand(s, out, what)
}

/// [`zr_decode`] into `out`, whose length is the plain length: writes every byte.
fn zr_expand(s: &[u8], out: &mut [u8], what: &dyn Fn() -> String) -> Result<(), Error> {
    let len = out.len();
    let short = |why: &str| Error::new("zr-length", format!("{}: {why}", what()));
    let mut p = 0usize;
    let mut at = 0usize;
    let mut i = 0usize;
    let mut bad: Option<(usize, &'static str)> = None;
    while at < len {
        let room = (len - at) as u64;
        let (z, ok_z) =
            read_uvarint(s, &mut p).ok_or_else(|| short("a uvarint runs past the token stream"))?;
        if z > room {
            return Err(short("a zero run passes the plain length"));
        }
        let (n, ok_n) =
            read_uvarint(s, &mut p).ok_or_else(|| short("a uvarint runs past the token stream"))?;
        if n > room - z {
            return Err(short("a literal passes the plain length"));
        }
        let (z, n) = (z as usize, n as usize);
        if n > s.len() - p {
            return Err(short("a literal runs past the token stream"));
        }
        let lit = &s[p..p + n];
        p += n;
        let last = z + n == len - at;
        if bad.is_none() {
            let why = if !(ok_z && ok_n) {
                Some("a uvarint is not minimal")
            } else if (z > 0 && z < ZR_MIN) || (z == 0 && i > 0) {
                Some("a zero run shorter than the minimum")
            } else if n == 0 && (z == 0 || !last) {
                Some("an empty literal")
            } else if z > 0 && lit.first() == Some(&0) {
                Some("a literal starts with a zero byte")
            } else if !last && lit.last() == Some(&0) {
                Some("a literal ends with a zero byte before a zero run")
            } else if n >= ZR_MIN && has_zero_run(lit) {
                Some("a literal holds a run of the minimum zero bytes")
            } else {
                None
            };
            bad = why.map(|w| (i, w));
        }
        out[at..at + z].fill(0);
        at += z;
        if n <= 8 && at + 8 <= len && p - n + 8 <= s.len() {
            // A short literal as one word (a wasm memory.copy per token costs more than its
            // bytes): the bytes past it are written again by the tokens that cover them.
            out[at..at + 8].copy_from_slice(&s[p - n..p - n + 8]);
        } else {
            out[at..at + n].copy_from_slice(lit);
        }
        at += n;
        i += 1;
    }
    if p != s.len() {
        return Err(short("bytes follow once the plain length is covered"));
    }
    if let Some((i, why)) = bad {
        return Err(Error::new(
            "zr-noncanonical",
            format!("{}: token {i}: {why}", what()),
        ));
    }
    Ok(())
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
            let parts =
                crate::payload::expected_mesh_buffer_bytes(s.format, s.vertex_count, s.index_count);
            // `mesh_body_bytes`, from the same parts.
            if s.payload_bytes < 0 || 40 + parts.iter().sum::<u128>() != s.payload_bytes as u128 {
                return false;
            }
            let [pos, attr, skin, idx] = parts;
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

/// `advance`: R(T) (time `t`) from R(T−1) (or ∅: [`History::accept`] cleared it) and T's /12
/// blocks. Units T does not carry or drop keep their slots untouched. With `rec` (the retained
/// record index, where `b.mesh_u8` starts in it, and its unit list), carried bodies are read in
/// place there; without, they are copied.
fn advance(
    (body, aabb, mm): (&mut Track<Bodies>, &mut Track<[u8; 24]>, &mut Track<MmBuf>),
    t: u64,
    tx: &TxMeta,
    b: Blocks<'_>,
    sc: &mut Scratch,
    mut rec: Option<(u32, usize, &mut Vec<Id>)>,
) {
    let layout = u8_layout(tx, b.mesh_u8.len(), &mut sc.surfs);
    let mut si = 0;
    for e in &tx.meshes {
        let mut surfs: &[Surf] = &[];
        if layout && e.u8.is_some() {
            surfs = &sc.surfs[si..si + e.surfaces.len()];
            si += e.surfaces.len();
        }
        if !is_dynamic(e) {
            body.drop_at(e.id, t);
        } else if e.u8.is_some() {
            match surfs.first() {
                Some(first) => {
                    let x = body.set(e.id, t);
                    x.shape.clear();
                    x.ends.clear();
                    let base = first.start;
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
                    match rec.as_mut() {
                        Some((i, at, ids)) => {
                            x.rec = *i;
                            x.gen = t;
                            x.at = *at + base;
                            ids.push(e.id);
                        }
                        None => {
                            x.rec = OWNED;
                            x.bytes.clear();
                            x.bytes.extend_from_slice(&b.mesh_u8[base..base + end]);
                        }
                    }
                }
                None => body.drop_at(e.id, t),
            }
        }
        match e.f {
            Some(f) if (4 * f as u128 + 24) <= b.mesh_f32.len() as u128 => {
                let o = 4 * f as usize;
                aabb.set(e.id, t).copy_from_slice(&b.mesh_f32[o..o + 24]);
            }
            _ => aabb.drop_at(e.id, t),
        }
    }
    for id in &tx.removed_meshes {
        let id = *id as Id;
        body.drop_at(id, t);
        aabb.drop_at(id, t);
    }
    for e in &tx.multimeshes {
        if e.status != EntryStatus::Ok {
            mm.drop_at(e.id, t);
        } else if let Some(bf) = e.buffer_f {
            let o = 4 * bf as u128;
            let n = 4 * e.buffer_floats() as u128;
            if e.instances >= 0 && o + n <= b.mm_f32.len() as u128 {
                let (o, n) = (o as usize, n as usize);
                let x = mm.set(e.id, t);
                x.instances = e.instances;
                x.stride = e.stride();
                x.bytes.clear();
                x.bytes.extend_from_slice(&b.mm_f32[o..o + n]);
            } else {
                mm.drop_at(e.id, t);
            }
        }
    }
    for id in &tx.removed_multimeshes {
        mm.drop_at(*id as Id, t);
    }
}

// --------------------------------------------------------------------------- coding

fn code_u8(
    tx: &TxMeta,
    src: &[u8],
    dst: &mut [u8],
    h1: PredState<'_>,
    h2: PredState<'_>,
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
        let (b1, b2) = pair(h1, h2, |h| &h.body, e.id);
        let base = b1.filter(|b| b.same_shape(e));
        let prev = base.and(b2.filter(|b| b.same_shape(e)));
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
            let bb = base.map(|b| b.surface(h1.h.bodies(b), k));
            let pb = prev.map(|b| b.surface(h2.h.bodies(b), k));
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

/// `out` (`4·n` bytes): the `n` words whose byte planes are `q`. Sixteen words at a time as
/// byte then byte-pair interleaves of 128-bit vectors where the target has them (wasm `simd128`,
/// x86-64's baseline SSE2), the rest (and every word elsewhere) by [`untranspose_words_u64`].
#[inline]
fn untranspose_words(q: [&[u8]; 4], out: &mut [u8]) {
    let done = lanes::untranspose16(q, out);
    if done < out.len() / 4 {
        untranspose_words_u64(
            [&q[0][done..], &q[1][done..], &q[2][done..], &q[3][done..]],
            &mut out[4 * done..],
        );
    }
}

/// [`untranspose_words`] eight words at a time, as two 4×4 byte transposes in 64-bit registers
/// (delta swaps of bytes, then of byte pairs).
fn untranspose_words_u64(q: [&[u8]; 4], out: &mut [u8]) {
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
#[cfg(test)]
fn ld4(d: &[u8], at: usize) -> [u32; 4] {
    let d: &[u8; 16] = d[at..at + 16].try_into().unwrap();
    [word(d, 0), word(d, 1), word(d, 2), word(d, 3)]
}

/// [`unres`] on four lanes.
#[cfg(test)]
fn unres4<const M: u8>(r: [u32; 4], b: [u32; 4], p: [u32; 4]) -> [u32; 4] {
    lanes::to_arr(unres_l::<M>(
        lanes::from_arr(r),
        lanes::from_arr(b),
        lanes::from_arr(p),
    ))
}

/// [`unres`] on a vector of four words.
#[inline(always)]
fn unres_l<const M: u8>(r: lanes::L, b: lanes::L, p: lanes::L) -> lanes::L {
    use lanes::*;
    let sign = splat(0x8000_0000);
    let ord = |u: L| xor(u, or(sar31(u), sign));
    let unord = |o: L| xor(o, or(sar31(not(o)), sign));
    let unzz = |u: L| xor(shr1(u), sub(splat(0), and(u, splat(1))));
    match M {
        0 => r,
        1 => unord(add(unzz(r), ord(b))),
        _ => {
            let ob = ord(b);
            unord(sub(add(unzz(r), add(ob, ob)), ord(p)))
        }
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
        let v = unres_l::<M>(lanes::ld(r, at), lanes::ld(b, at), lanes::ld(p, at));
        lanes::st(out, at, v);
        if at + 16 == 4 * n {
            break;
        }
        at = (at + 16).min(4 * n - 16);
    }
}

/// `out = from ^ base`, or a copy of `from` when `base` is empty (an absent base). Sixteen bytes
/// at a time, a run that is not a multiple of sixteen ending with a block overlapping the one
/// before (`out` is neither input, so the overlap rewrites equal bytes).
#[inline(always)]
fn unxor(from: &[u8], base: &[u8], out: &mut [u8]) {
    let n = out.len();
    let from = &from[..n];
    if base.is_empty() {
        out.copy_from_slice(from);
        return;
    }
    let base = &base[..n];
    if n >= 16 {
        let mut at = 0;
        loop {
            lanes::st(out, at, lanes::xor(lanes::ld(from, at), lanes::ld(base, at)));
            if at + 16 == n {
                break;
            }
            at = (at + 16).min(n - 16);
        }
    } else if n >= 8 {
        let x = |at: usize| {
            u64::from_le_bytes(from[at..at + 8].try_into().unwrap())
                ^ u64::from_le_bytes(base[at..at + 8].try_into().unwrap())
        };
        let (lo, hi) = (x(0), x(n - 8));
        out[n - 8..].copy_from_slice(&hi.to_le_bytes());
        out[..8].copy_from_slice(&lo.to_le_bytes());
    } else {
        for ((t, f), x) in out.iter_mut().zip(from).zip(base) {
            *t = f ^ x;
        }
    }
}

/// The interleaved attribute section of `n` vertices (a colour, then two UV words: 12 bytes a
/// vertex) from `cols` (XOR H1's colours) and the untransposed UV words `uv`. Four vertices
/// (three vectors) at a time: the residuals are interleaved in registers, then each lane XORed (a
/// colour) or un-residualed (a UV word) by a fixed lane mask; the last `n mod 4` vertices word by
/// word.
#[inline(always)]
fn unpredict_attr<const M: u8>(cols: &[u8], uv: &[u8], b: &[u8], p: &[u8], out: &mut [u8]) {
    let n = out.len() / 12;
    let (cols, uv) = (&cols[..4 * n], &uv[..8 * n]);
    let (b, p) = if M == 0 {
        (&[][..], &[][..])
    } else {
        let b = &b[..12 * n];
        (b, if M >= 2 { &p[..12 * n] } else { b })
    };
    // Four vertices are words c u v c | u v c u | v c u v: the colour lanes of each vector.
    const C: u32 = u32::MAX;
    let masks = [
        lanes::from_arr([C, 0, 0, C]),
        lanes::from_arr([0, 0, C, 0]),
        lanes::from_arr([0, C, 0, 0]),
    ];
    let groups = n / 4;
    for g in 0..groups {
        let r3 = lanes::attr3(
            lanes::ld(cols, 16 * g),
            lanes::ld(uv, 32 * g),
            lanes::ld(uv, 32 * g + 16),
        );
        for v in 0..3 {
            let at = 48 * g + 16 * v;
            let r = r3[v];
            if M == 0 {
                lanes::st(out, at, r);
                continue;
            }
            let (bb, pp) = (lanes::ld(b, at), lanes::ld(p, at));
            let u = unres_l::<M>(r, bb, pp);
            let x = lanes::xor(r, bb);
            // u where the mask is clear, x where it is set.
            lanes::st(out, at, lanes::xor(u, lanes::and(masks[v], lanes::xor(x, u))));
        }
    }
    for k in 4 * groups..n {
        let (w, c, u0, u1) = (3 * k, word(cols, k), word(uv, 2 * k), word(uv, 2 * k + 1));
        let v = if M == 0 {
            [c, u0, u1]
        } else {
            [
                c ^ word(b, w),
                unres::<M>(u0, word(b, w + 1), word(p, w + 1)),
                unres::<M>(u1, word(b, w + 2), word(p, w + 2)),
            ]
        };
        for (i, x) in v.into_iter().enumerate() {
            out[4 * (w + i)..4 * (w + i) + 4].copy_from_slice(&x.to_le_bytes());
        }
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
    h1: PredState<'_>,
    h2: PredState<'_>,
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
        let (b1, b2) = pair(h1, h2, |h| &h.body, e.id);
        let base = b1.filter(|b| b.same_shape(e));
        let prev = base.and(b2.filter(|b| b.same_shape(e)));
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
            let bb = base.map_or(&[][..], |b| b.surface(h1.h.bodies(b), k));
            let pb = prev.map_or(&[][..], |b| b.surface(h2.h.bodies(b), k));
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
    h1: PredState<'_>,
    h2: PredState<'_>,
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
                let (b, p) = pair(h1, h2, |h| &h.aabb, id);
                let (b, p) = (b.map(|a| &a[..]), p.map(|a| &a[..]));
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
                let same = |m: &&MmBuf| m.instances == instances && m.stride == stride;
                let (b, p) = pair(h1, h2, |h| &h.mm, id);
                let b = b.filter(same).map(|m| &m.bytes[..]);
                let p = b.and(p.filter(same).map(|m| &m.bytes[..]));
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
    h1: PredState<'_>,
    h2: PredState<'_>,
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
            let (b, p) = pair(h1, h2, |h| &h.aabb, id);
            let (b, p) = (b.map(|a| &a[..]), p.map(|a| &a[..]));
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
            let same = |m: &&MmBuf| m.instances == instances && m.stride == stride;
            let (b, p) = pair(h1, h2, |h| &h.mm, id);
            let b = b.filter(same).map(|m| &m.bytes[..]);
            let p = b.and(p.filter(same).map(|m| &m.bytes[..]));
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

// --------------------------------------------------------------------------- lanes
//
// Four 32-bit lanes, as one 128-bit vector where the target has one: wasm32 built with `simd128`
// (scripts/build-rs-core.sh and the render-stream client's build-web.sh enable it) and x86-64
// (SSE2 is its baseline). Elsewhere (the emscripten side module, aarch64) four plain words, which
// the compiler vectorizes when it can. Every path computes the same words.

mod lanes {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    mod imp {
        use core::arch::wasm32::*;
        pub type L = v128;

        #[inline(always)]
        pub fn ld(d: &[u8], at: usize) -> L {
            let a: &[u8; 16] = d[at..at + 16].try_into().unwrap();
            // SAFETY: 16 readable bytes; wasm loads need no alignment.
            unsafe { v128_load(a.as_ptr().cast()) }
        }
        #[inline(always)]
        pub fn st(d: &mut [u8], at: usize, v: L) {
            let a: &mut [u8; 16] = (&mut d[at..at + 16]).try_into().unwrap();
            // SAFETY: 16 writable bytes; wasm stores need no alignment.
            unsafe { v128_store(a.as_mut_ptr().cast(), v) }
        }
        #[inline(always)]
        pub fn from_arr(a: [u32; 4]) -> L {
            u32x4(a[0], a[1], a[2], a[3])
        }
        #[cfg(test)]
        pub fn to_arr(v: L) -> [u32; 4] {
            [
                u32x4_extract_lane::<0>(v),
                u32x4_extract_lane::<1>(v),
                u32x4_extract_lane::<2>(v),
                u32x4_extract_lane::<3>(v),
            ]
        }
        #[inline(always)]
        pub fn splat(x: u32) -> L {
            u32x4_splat(x)
        }
        #[inline(always)]
        pub fn add(a: L, b: L) -> L {
            i32x4_add(a, b)
        }
        #[inline(always)]
        pub fn sub(a: L, b: L) -> L {
            i32x4_sub(a, b)
        }
        #[inline(always)]
        pub fn xor(a: L, b: L) -> L {
            v128_xor(a, b)
        }
        #[inline(always)]
        pub fn or(a: L, b: L) -> L {
            v128_or(a, b)
        }
        #[inline(always)]
        pub fn and(a: L, b: L) -> L {
            v128_and(a, b)
        }
        #[inline(always)]
        pub fn not(a: L) -> L {
            v128_not(a)
        }
        /// Each lane's sign bit, smeared (arithmetic shift right by 31).
        #[inline(always)]
        pub fn sar31(a: L) -> L {
            i32x4_shr(a, 31)
        }
        #[inline(always)]
        pub fn shr1(a: L) -> L {
            u32x4_shr(a, 1)
        }

        /// Four vertices' attribute words `c u v c | u v c u | v c u v` from their colours
        /// `c` and their UV words `u0` (vertices 0, 1) and `u1` (2, 3).
        #[inline(always)]
        pub fn attr3(c: L, u0: L, u1: L) -> [L; 3] {
            let t = i32x4_shuffle::<2, 3, 4, 4>(u0, u1);
            [
                i32x4_shuffle::<0, 4, 5, 1>(c, u0),
                i32x4_shuffle::<0, 1, 6, 2>(t, c),
                i32x4_shuffle::<1, 7, 2, 3>(u1, c),
            ]
        }

        /// The first `16·⌊n/16⌋` of the `n` words whose byte planes are `q` into `out`; returns
        /// how many words it wrote.
        #[inline]
        pub fn untranspose16(q: [&[u8]; 4], out: &mut [u8]) -> usize {
            let n = out.len() / 4;
            let full = n - n % 16;
            let mut w = 0;
            while w < full {
                let (a, b, c, d) = (ld(q[0], w), ld(q[1], w), ld(q[2], w), ld(q[3], w));
                // Bytes j of words w.. as pairs (q0 q1) and (q2 q3), then the pairs joined.
                let ab_lo = u8x16_shuffle::<0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23>(a, b);
                let ab_hi =
                    u8x16_shuffle::<8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31>(a, b);
                let cd_lo = u8x16_shuffle::<0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23>(c, d);
                let cd_hi =
                    u8x16_shuffle::<8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31>(c, d);
                let o = 4 * w;
                st(out, o, u16x8_shuffle::<0, 8, 1, 9, 2, 10, 3, 11>(ab_lo, cd_lo));
                st(out, o + 16, u16x8_shuffle::<4, 12, 5, 13, 6, 14, 7, 15>(ab_lo, cd_lo));
                st(out, o + 32, u16x8_shuffle::<0, 8, 1, 9, 2, 10, 3, 11>(ab_hi, cd_hi));
                st(out, o + 48, u16x8_shuffle::<4, 12, 5, 13, 6, 14, 7, 15>(ab_hi, cd_hi));
                w += 16;
            }
            full
        }
    }

    #[cfg(target_arch = "x86_64")]
    #[allow(unused_unsafe)]
    mod imp {
        use core::arch::x86_64::*;
        pub type L = __m128i;

        #[inline(always)]
        pub fn ld(d: &[u8], at: usize) -> L {
            let a: &[u8; 16] = d[at..at + 16].try_into().unwrap();
            // SAFETY: 16 readable bytes; loadu needs no alignment; SSE2 is x86-64's baseline.
            unsafe { _mm_loadu_si128(a.as_ptr().cast()) }
        }
        #[inline(always)]
        pub fn st(d: &mut [u8], at: usize, v: L) {
            let a: &mut [u8; 16] = (&mut d[at..at + 16]).try_into().unwrap();
            // SAFETY: 16 writable bytes; storeu needs no alignment.
            unsafe { _mm_storeu_si128(a.as_mut_ptr().cast(), v) }
        }
        #[inline(always)]
        pub fn from_arr(a: [u32; 4]) -> L {
            unsafe { _mm_set_epi32(a[3] as i32, a[2] as i32, a[1] as i32, a[0] as i32) }
        }
        #[cfg(test)]
        pub fn to_arr(v: L) -> [u32; 4] {
            let mut b = [0u8; 16];
            st(&mut b, 0, v);
            let w = |i: usize| u32::from_le_bytes(b[4 * i..4 * i + 4].try_into().unwrap());
            [w(0), w(1), w(2), w(3)]
        }
        #[inline(always)]
        pub fn splat(x: u32) -> L {
            unsafe { _mm_set1_epi32(x as i32) }
        }
        #[inline(always)]
        pub fn add(a: L, b: L) -> L {
            unsafe { _mm_add_epi32(a, b) }
        }
        #[inline(always)]
        pub fn sub(a: L, b: L) -> L {
            unsafe { _mm_sub_epi32(a, b) }
        }
        #[inline(always)]
        pub fn xor(a: L, b: L) -> L {
            unsafe { _mm_xor_si128(a, b) }
        }
        #[inline(always)]
        pub fn or(a: L, b: L) -> L {
            unsafe { _mm_or_si128(a, b) }
        }
        #[inline(always)]
        pub fn and(a: L, b: L) -> L {
            unsafe { _mm_and_si128(a, b) }
        }
        #[inline(always)]
        pub fn not(a: L) -> L {
            unsafe { _mm_xor_si128(a, _mm_set1_epi32(-1)) }
        }
        #[inline(always)]
        pub fn sar31(a: L) -> L {
            unsafe { _mm_srai_epi32::<31>(a) }
        }
        #[inline(always)]
        pub fn shr1(a: L) -> L {
            unsafe { _mm_srli_epi32::<1>(a) }
        }

        /// As the wasm `attr3`, with SSE's two-source float shuffles (lane moves only).
        #[inline(always)]
        pub fn attr3(c: L, u0: L, u1: L) -> [L; 3] {
            // _MM_SHUFFLE(d, c, b, a): lanes a, b of the first operand, c, d of the second.
            const fn sh(a: i32, b: i32, c: i32, d: i32) -> i32 {
                a | b << 2 | c << 4 | d << 6
            }
            unsafe {
                let (cf, u0f, u1f) = (_mm_castsi128_ps(c), _mm_castsi128_ps(u0), _mm_castsi128_ps(u1));
                // [c0 u0 c1 v0] -> [c0 u0 v0 c1]
                let o0 = _mm_shuffle_epi32::<{ sh(0, 1, 3, 2) }>(_mm_unpacklo_epi32(c, u0));
                // [c2 c2 u2 u2], then [u1 v1 c2 u2]
                let s1 = _mm_shuffle_ps::<{ sh(2, 2, 0, 0) }>(cf, u1f);
                let o1 = _mm_shuffle_ps::<{ sh(2, 3, 0, 2) }>(u0f, s1);
                // [v2 v2 c3 c3], then [v2 c3 u3 v3]
                let s2 = _mm_shuffle_ps::<{ sh(1, 1, 3, 3) }>(u1f, cf);
                let o2 = _mm_shuffle_ps::<{ sh(0, 2, 2, 3) }>(s2, u1f);
                [o0, _mm_castps_si128(o1), _mm_castps_si128(o2)]
            }
        }

        /// As the wasm `untranspose16`, with SSE2's unpacks.
        #[inline]
        pub fn untranspose16(q: [&[u8]; 4], out: &mut [u8]) -> usize {
            let n = out.len() / 4;
            let full = n - n % 16;
            let mut w = 0;
            while w < full {
                let (a, b, c, d) = (ld(q[0], w), ld(q[1], w), ld(q[2], w), ld(q[3], w));
                let (ab_lo, ab_hi, cd_lo, cd_hi) = unsafe {
                    (
                        _mm_unpacklo_epi8(a, b),
                        _mm_unpackhi_epi8(a, b),
                        _mm_unpacklo_epi8(c, d),
                        _mm_unpackhi_epi8(c, d),
                    )
                };
                let o = 4 * w;
                unsafe {
                    st(out, o, _mm_unpacklo_epi16(ab_lo, cd_lo));
                    st(out, o + 16, _mm_unpackhi_epi16(ab_lo, cd_lo));
                    st(out, o + 32, _mm_unpacklo_epi16(ab_hi, cd_hi));
                    st(out, o + 48, _mm_unpackhi_epi16(ab_hi, cd_hi));
                }
                w += 16;
            }
            full
        }
    }

    #[cfg(not(any(
        all(target_arch = "wasm32", target_feature = "simd128"),
        target_arch = "x86_64"
    )))]
    use scalar as imp;

    /// The portable lanes (also what the tests hold the vector paths to).
    #[cfg(any(
        test,
        not(any(
            all(target_arch = "wasm32", target_feature = "simd128"),
            target_arch = "x86_64"
        ))
    ))]
    #[cfg_attr(test, allow(dead_code))]
    pub(super) mod scalar {
        pub type L = [u32; 4];

        #[inline(always)]
        fn map(a: L, f: impl Fn(u32) -> u32) -> L {
            [f(a[0]), f(a[1]), f(a[2]), f(a[3])]
        }
        #[inline(always)]
        fn zip(a: L, b: L, f: impl Fn(u32, u32) -> u32) -> L {
            [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2]), f(a[3], b[3])]
        }
        #[inline(always)]
        pub fn ld(d: &[u8], at: usize) -> L {
            let d: &[u8; 16] = d[at..at + 16].try_into().unwrap();
            let w = |i: usize| u32::from_le_bytes(d[4 * i..4 * i + 4].try_into().unwrap());
            [w(0), w(1), w(2), w(3)]
        }
        #[inline(always)]
        pub fn st(d: &mut [u8], at: usize, v: L) {
            let d: &mut [u8; 16] = (&mut d[at..at + 16]).try_into().unwrap();
            for i in 0..4 {
                d[4 * i..4 * i + 4].copy_from_slice(&v[i].to_le_bytes());
            }
        }
        #[inline(always)]
        pub fn from_arr(a: [u32; 4]) -> L {
            a
        }
        #[cfg(test)]
        pub fn to_arr(v: L) -> [u32; 4] {
            v
        }
        #[inline(always)]
        pub fn splat(x: u32) -> L {
            [x; 4]
        }
        #[inline(always)]
        pub fn add(a: L, b: L) -> L {
            zip(a, b, u32::wrapping_add)
        }
        #[inline(always)]
        pub fn sub(a: L, b: L) -> L {
            zip(a, b, u32::wrapping_sub)
        }
        #[inline(always)]
        pub fn xor(a: L, b: L) -> L {
            zip(a, b, |x, y| x ^ y)
        }
        #[inline(always)]
        pub fn or(a: L, b: L) -> L {
            zip(a, b, |x, y| x | y)
        }
        #[inline(always)]
        pub fn and(a: L, b: L) -> L {
            zip(a, b, |x, y| x & y)
        }
        #[inline(always)]
        pub fn not(a: L) -> L {
            map(a, |x| !x)
        }
        #[inline(always)]
        pub fn sar31(a: L) -> L {
            map(a, |x| ((x as i32) >> 31) as u32)
        }
        #[inline(always)]
        pub fn shr1(a: L) -> L {
            map(a, |x| x >> 1)
        }

        #[inline(always)]
        pub fn attr3(c: L, u0: L, u1: L) -> [L; 3] {
            [
                [c[0], u0[0], u0[1], c[1]],
                [u0[2], u0[3], c[2], u1[0]],
                [u1[1], c[3], u1[2], u1[3]],
            ]
        }

        /// No vector unit: `untranspose_words_u64` does every word.
        #[inline(always)]
        pub fn untranspose16(_q: [&[u8]; 4], _out: &mut [u8]) -> usize {
            0
        }
    }

    pub use imp::*;
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

/// The plain length (descriptor `count` × width) of each predicted block of `tx`, in
/// `[mesh_f32, mesh_u8, mm_f32]` order (0 for a block the meta does not list).
fn plain_lens(tx: &TxMeta) -> [usize; 3] {
    let len = |i: usize| {
        tx.blocks
            .get(i)
            .map(|d| (d.count * d.ty.width()) as usize)
            .unwrap_or(0)
    };
    [len(MESH_F32), len(MESH_U8), len(MM_F32)]
}

const PREDICTED: [(usize, &str); 3] = [(MESH_F32, "mesh_f32"), (MESH_U8, "mesh_u8"), (MM_F32, "mm_f32")];

/// The predicted slot (0, 1, 2) of block index `i`, if it is one.
fn predicted_slot(i: usize) -> Option<usize> {
    match i {
        MESH_F32 => Some(0),
        MESH_U8 => Some(1),
        MM_F32 => Some(2),
        _ => None,
    }
}

/// The validator's /13 step: writes into `plain` the /12 record equivalent to the /13 transaction
/// `record` (its meta without `predict_check`; its three predicted blocks' zero runs expanded
/// (W13r: `zr-length`, `zr-noncanonical`, blocks in descriptor order) and un-predicted against
/// (H1, H2)), sets `blocks` to index `plain`, and returns `(declared, computed)` check values.
/// `tx` is the record's checked meta (`predict_check` present). On an error `blocks` is
/// unchanged.
pub fn unpredict_record(
    record: &[u8],
    tx: &TxMeta,
    blocks: &mut [BlockRange],
    h1: PredState<'_>,
    h2: PredState<'_>,
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
    // W13r: the zero runs, expanded into the buffers the un-predict reads.
    let lens = plain_lens(tx);
    let mut coded = std::mem::take(&mut sc.coded);
    for (slot, &(i, name)) in PREDICTED.iter().enumerate() {
        let r = zr_decode(block(record, blocks, i), lens[slot], &mut coded[slot], &|| {
            format!("transaction seq {}: {name}", tx.seq)
        });
        if let Err(e) = r {
            sc.coded = coded;
            return Err(e);
        }
    }
    // `plain` keeps its allocation: the meta without the check, every other block copied with its
    // length prefix, each predicted block's prefix its plain length and its bytes written whole
    // by the un-predictor (pass-through included).
    // Sized once and overwritten in place (W13p: no zeroing in the steady state).
    let body = 8 + meta_len;
    let head = cut + (body + 4 - cut - CHECK_BYTES);
    let total = head
        + blocks
            .iter()
            .enumerate()
            .map(|(i, b)| 4 + predicted_slot(i).map_or(b.len, |slot| lens[slot]))
            .sum::<usize>();
    plain.resize(total, 0);
    plain[..cut].copy_from_slice(&record[..cut]);
    plain[cut..head].copy_from_slice(&record[cut + CHECK_BYTES..body + 4]);
    let mut at = head;
    for (i, b) in blocks.iter_mut().enumerate() {
        match predicted_slot(i) {
            Some(slot) => {
                plain[at..at + 4].copy_from_slice(&(lens[slot] as u32).to_le_bytes());
                *b = BlockRange {
                    start: at + 4,
                    len: lens[slot],
                };
            }
            None => {
                plain[at..at + 4 + b.len].copy_from_slice(&record[b.start - 4..b.start + b.len]);
                b.start = at + 4;
            }
        }
        at += 4 + b.len;
    }
    let rl = plain.len() as u32 - 4;
    plain[0..4].copy_from_slice(&rl.to_le_bytes());
    plain[4..8].copy_from_slice(&((meta_len - CHECK_BYTES) as u32).to_le_bytes());
    let src = Blocks {
        mesh_f32: &coded[0],
        mesh_u8: &coded[1],
        mm_f32: &coded[2],
    };
    let dst = blocks_of_mut(plain, blocks);
    code_blocks(tx, src, dst, h1, h2, true, sc, None);
    sc.coded = coded;
    let computed = check(blocks_of(plain, blocks));
    Ok((declared, computed))
}

/// The /13 record of the /12 transaction `record` (predicted against (H1, H2), then its
/// predicted blocks as zero runs; `zr` a W13r writer sabotage, acting on the first block it
/// changes).
pub fn predict_record(
    record: &[u8],
    tx: &TxMeta,
    blocks: &[BlockRange],
    h1: PredState<'_>,
    h2: PredState<'_>,
    sc: &mut Scratch,
    trace: Option<&mut Vec<Unit>>,
    zr: ZrSabotage,
    out: &mut Vec<u8>,
) {
    let meta_len = wire::le_u32(record, 4) as usize;
    let meta = &record[8..8 + meta_len];
    let i = blocks_mark(meta).expect("a transaction meta has \"blocks\"");
    let src = blocks_of(record, blocks);
    let hex = check_hex(check(src));
    let mut coded = std::mem::take(&mut sc.coded);
    for (c, b) in coded.iter_mut().zip([src.mesh_f32, src.mesh_u8, src.mm_f32]) {
        c.clear();
        c.resize(b.len(), 0);
    }
    {
        let [f, u, m] = &mut coded;
        let dst = BlocksMut {
            mesh_f32: f,
            mesh_u8: u,
            mm_f32: m,
        };
        code_blocks(tx, src, dst, h1, h2, false, sc, trace);
    }
    let at = out.len();
    out.extend_from_slice(&[0; 8]);
    out.extend_from_slice(&meta[..i]);
    out.extend_from_slice(CHECK_KEY);
    out.extend_from_slice(hex.as_bytes());
    out.push(b'"');
    out.extend_from_slice(&meta[i..]);
    let new_meta_len = out.len() - at - 8;
    let body = 8 + meta_len;
    out.extend_from_slice(&record[body..body + 4]);
    let mut sabotage = zr;
    for (k, b) in blocks.iter().enumerate() {
        match predicted_slot(k) {
            Some(slot) => {
                let len_at = out.len();
                out.extend_from_slice(&[0; 4]);
                if zr_encode_sabotaged(&coded[slot], sabotage, out) {
                    sabotage = ZrSabotage::None;
                }
                let n = (out.len() - len_at - 4) as u32;
                out[len_at..len_at + 4].copy_from_slice(&n.to_le_bytes());
            }
            None => out.extend_from_slice(&record[b.start - 4..b.start + b.len]),
        }
    }
    let rl = (out.len() - at - 4) as u32;
    out[at..at + 4].copy_from_slice(&rl.to_le_bytes());
    out[at + 4..at + 8].copy_from_slice(&(new_meta_len as u32).to_le_bytes());
    sc.coded = coded;
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
    trace: Option<&mut Vec<TxTrace>>,
) -> Result<Vec<u8>, Error> {
    to13_with(data12, stale, ZrSabotage::None, trace)
}

/// [`to13`] with a W13r writer sabotage (`zr-overrun`, `zr-short-run`) on every transaction.
pub fn to13_with(
    data12: &[u8],
    stale: bool,
    zr: ZrSabotage,
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
                    zr,
                    &mut out,
                );
                if let Some(t) = trace.as_deref_mut() {
                    t.push(TxTrace { seq: tx.seq, units });
                }
                hist.accept(&tx, blocks_of(rec, &bufs.blocks), false, &mut sc);
            }
            Decoded::End(_) => fix_end(rec, &out_lens, &in_lens, &mut out),
            Decoded::Resource(_) => out.extend_from_slice(rec),
            // A /12 decode never yields an item_meta record (an unknown type below /13).
            Decoded::ItemMeta(_) => unreachable!("item_meta at /12"),
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
            // TAG1: /12 has no item_meta record; dropped, and the end record's bytes_total and
            // max_record_bytes follow (`fix_end` over the output's record lengths).
            crate::validate::Accepted::ItemMeta => {}
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

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(seed: u64, n: usize) -> Vec<u8> {
        let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let edge = [0u32, 1, 0x7FFF_FFFF, 0x8000_0000, 0x8000_0001, 0xFFFF_FFFF];
        (0..n)
            .map(|i| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                if i % 4 == 0 && x % 5 == 0 {
                    // Sometimes an edge word's low byte (the rest follows from x).
                    edge[(x as usize / 5) % edge.len()] as u8
                } else {
                    x as u8
                }
            })
            .collect()
    }

    /// W13r: zero runs round-trip on sparse buffers of every small length, the encoder's output
    /// is canonical (the decoder accepts it), and both sabotages are refused with their codes.
    #[test]
    fn zero_runs_round_trip_and_sabotages_fail() {
        for n in 0..=200usize {
            for density in [1u64, 3, 9] {
                let mut x = (n as u64 + 1) * 0x9E37_79B9 + density;
                let c: Vec<u8> = (0..n)
                    .map(|_| {
                        x ^= x << 13;
                        x ^= x >> 7;
                        x ^= x << 17;
                        if x % 10 < density { (x >> 8) as u8 | 1 } else { 0 }
                    })
                    .collect();
                let naive = c.windows(ZR_MIN).any(|w| w.iter().all(|&b| b == 0));
                assert_eq!(has_zero_run(&c), naive, "n {n} density {density}");
                let mut s = Vec::new();
                zr_encode(&c, ZrSabotage::None, &mut s);
                let mut out = vec![7u8; 3];
                zr_decode(&s, n, &mut out, &|| "t".into()).unwrap();
                assert_eq!(out, c, "n {n}");
                // Into a reused buffer of other bytes: every byte is written.
                let mut z = vec![0xa5u8; n + 16];
                zr_decode(&s, n, &mut z, &|| "t".into()).unwrap();
                assert_eq!(z, c, "n {n} (reused)");
                for (sab, code) in [
                    (ZrSabotage::Overrun, "zr-length"),
                    (ZrSabotage::ShortRun, "zr-noncanonical"),
                ] {
                    let mut bad = Vec::new();
                    if zr_encode_sabotaged(&c, sab, &mut bad) {
                        let e = zr_decode(&bad, n, &mut out, &|| "t".into()).unwrap_err();
                        assert_eq!(e.code, code, "n {n} {sab:?}");
                    } else {
                        assert_eq!(bad, s);
                    }
                }
            }
        }
    }

    /// The vector untranspose (16 words a step, then the u64 path) is the byte-plane inverse.
    #[test]
    fn untranspose_words_matches_the_reference() {
        for n in 0..=67usize {
            let words = bytes(n as u64 + 1, 4 * n);
            let mut coded = vec![0u8; 4 * n];
            transpose4(&words, &mut coded);
            let mut out = vec![0u8; 4 * n];
            untranspose_words(planes(&coded, 0, n), &mut out);
            assert_eq!(out, words, "n {n}");
            let mut out2 = vec![0u8; 4 * n];
            untranspose_words_u64(planes(&coded, 0, n), &mut out2);
            assert_eq!(out2, words, "n {n} (u64)");
        }
    }

    /// The lanes' un-residual (vector where the target has one) equals the scalar word one, and
    /// the portable lanes do too.
    #[test]
    fn unres_lanes_match_the_scalar_words() {
        let edge = [0u32, 1, 2, 0x7FFF_FFFF, 0x8000_0000, 0x8000_0001, 0xFFFF_FFFE, 0xFFFF_FFFF];
        let mut all: Vec<u32> = edge.to_vec();
        let r = bytes(7, 4 * 4096);
        all.extend((0..4096).map(|i| word(&r, i)));
        let n = all.len();
        for i in 0..n {
            let pick = |k: usize| all[(i * 7 + k * 13) % n];
            let (r, b, p) = ([pick(0), pick(1), pick(2), pick(3)], [pick(4), all[i], pick(5), pick(6)], [pick(7), pick(8), all[(i + 1) % n], pick(9)]);
            let want1: Vec<u32> = (0..4).map(|k| unres::<1>(r[k], b[k], p[k])).collect();
            let want2: Vec<u32> = (0..4).map(|k| unres::<2>(r[k], b[k], p[k])).collect();
            assert_eq!(unres4::<1>(r, b, p).to_vec(), want1);
            let raw: Vec<u8> = r.iter().flat_map(|w| w.to_le_bytes()).collect();
            assert_eq!(ld4(&raw, 0), r);
            assert_eq!(unres4::<2>(r, b, p).to_vec(), want2);
            for k in 0..4 {
                assert_eq!(want1[k], unresidual(r[k], Some(b[k]), None));
                assert_eq!(want2[k], unresidual(r[k], Some(b[k]), Some(p[k])));
            }
            use lanes::scalar as s;
            let ord = |u: s::L| s::xor(u, s::or(s::sar31(u), s::splat(0x8000_0000)));
            let unord = |o: s::L| s::xor(o, s::or(s::sar31(s::not(o)), s::splat(0x8000_0000)));
            let unzz = |u: s::L| s::xor(s::shr1(u), s::sub(s::splat(0), s::and(u, s::splat(1))));
            assert_eq!(unord(s::add(unzz(r), ord(b))).to_vec(), want1);
        }
    }

    /// The attribute interleave (vector where the target has one) equals the portable one.
    #[test]
    fn attr3_interleaves_colours_and_uvs() {
        let (c, u0, u1) = ([10, 11, 12, 13], [20, 21, 22, 23], [24, 25, 26, 27]);
        let want = [[10, 20, 21, 11], [22, 23, 12, 24], [25, 13, 26, 27]];
        let got = lanes::attr3(lanes::from_arr(c), lanes::from_arr(u0), lanes::from_arr(u1));
        for v in 0..3 {
            let mut b = [0u8; 16];
            lanes::st(&mut b, 0, got[v]);
            assert_eq!(ld4(&b, 0), want[v], "vector {v}");
        }
        assert_eq!(lanes::scalar::attr3(c, u0, u1), want);
    }

    /// `unres_words` over every run length (the overlapping last block included).
    #[test]
    fn unres_words_matches_the_scalar_words() {
        for n in 0..=41usize {
            let (r, b, p) = (bytes(3 * n as u64 + 1, 4 * n), bytes(3 * n as u64 + 2, 4 * n), bytes(3 * n as u64 + 3, 4 * n));
            for m in 0..3u8 {
                let mut out = vec![0u8; 4 * n];
                match m {
                    0 => unres_words::<0>(&r, &b, &p, &mut out),
                    1 => unres_words::<1>(&r, &b, &p, &mut out),
                    _ => unres_words::<2>(&r, &b, &p, &mut out),
                }
                for w in 0..n {
                    let want = match m {
                        0 => word(&r, w),
                        1 => unres::<1>(word(&r, w), word(&b, w), 0),
                        _ => unres::<2>(word(&r, w), word(&b, w), word(&p, w)),
                    };
                    assert_eq!(word(&out, w), want, "n {n} order {m} word {w}");
                }
            }
        }
    }
}
