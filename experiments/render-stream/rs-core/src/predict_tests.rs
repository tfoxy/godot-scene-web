//! W13a property tests for render-stream/13's predicted blocks (render-stream-13.md "As built
//! (W13a)"): a random model of dynamic meshes (shapes, shape changes, pauses, removals, status
//! changes), AABBs and multimesh buffers (instance-count and stride changes) runs through the
//! encoder's and the decoder's [`History`] side by side, with random fulls and offset rules
//! broken now and then (pass-through). After every transaction decode(encode(T)) = T, the
//! check values agree, and the two histories are equal. Float words include NaNs, ±0, infinities
//! and binade crossings. Seeds are fixed; the generator is a xorshift64*.

use crate::coding::xxh64;
use crate::meta::{MeshMeta, MultimeshMeta, TxMeta};
use crate::predict::{
    check, check_hex, code_blocks, residual, unresidual, Blocks, BlocksMut, History, Scratch, Unit,
};
use crate::state::{EntryStatus, Hash, Id, MeshSurface, MultimeshFormat, Origin, Primitive};
use crate::validate::{Accepted, Options, Validator};
use crate::wire;
use std::collections::BTreeMap;
use std::path::PathBuf;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

const SPECIALS: &[u32] = &[
    0x7FC0_0000, // quiet NaN
    0xFFC0_0001, // negative NaN with a payload
    0x7F80_0001, // signalling NaN
    0x8000_0000, // -0.0
    0x0000_0000, // +0.0
    0x7F80_0000, // +inf
    0xFF80_0000, // -inf
    0x3F80_0000, // 1.0
    0x3F7F_FFFF, // 0.99999994 (the binade below 1.0)
    0x0080_0000, // the smallest normal
    0x007F_FFFF, // the largest subnormal
    0x8000_0001, // the smallest negative subnormal
    0x7F7F_FFFF, // f32::MAX
    0xFF7F_FFFF, // f32::MIN
];

/// A word that moved from `w`: kept, a small step, a special word, or random bits.
fn moved(rng: &mut Rng, w: u32) -> u32 {
    match rng.below(100) {
        0..=29 => w,
        30..=79 => {
            let f = f32::from_bits(w);
            let step = (rng.below(2001) as f32 - 1000.0) / 256.0;
            let g = if f.is_finite() { f + step } else { step };
            g.to_bits()
        }
        80..=91 => SPECIALS[rng.below(SPECIALS.len() as u64) as usize],
        _ => rng.next() as u32,
    }
}

/// (format, vertex_count, index_count) surface shapes.
const SHAPES: &[(i64, i64, i64)] = &[
    // colour + UV + index, 2D: a quad
    ((1 << 25) | (1 << 3) | (1 << 4) | (1 << 12), 4, 6),
    // UV only: a triangle
    ((1 << 25) | (1 << 4), 3, 0),
    // UV + bones + weights + index: skinned
    (
        (1 << 25) | (1 << 4) | (1 << 10) | (1 << 11) | (1 << 12),
        5,
        9,
    ),
    // 8 bone weights, colour, no UV
    (
        (1 << 25) | (1 << 3) | (1 << 10) | (1 << 11) | (1 << 27),
        6,
        0,
    ),
    // positions only, many vertices
    (1 << 25, 40, 0),
    // W13p: colour + UV + index at vertex counts that leave 1, 2 and 3 vertices after the
    // un-predictor's four-vertex groups, and index runs past 16 bytes
    ((1 << 25) | (1 << 3) | (1 << 4) | (1 << 12), 13, 33),
    ((1 << 25) | (1 << 3) | (1 << 4) | (1 << 12), 7, 15),
    ((1 << 25) | (1 << 3) | (1 << 4) | (1 << 12), 2, 3),
];

fn body_len(s: usize) -> usize {
    let (f, n, i) = SHAPES[s];
    crate::payload::mesh_body_bytes(f, n, i) as usize
}

fn random_body(rng: &mut Rng, s: usize) -> Vec<u8> {
    (0..body_len(s)).map(|_| rng.next() as u8).collect()
}

/// A body that moved: float-ish words move (every aligned word, whatever part it is in; byte
/// parts then just see changed bytes), the rest kept or re-rolled.
fn moved_body(rng: &mut Rng, b: &[u8]) -> Vec<u8> {
    let mut out = b.to_vec();
    for w in 0..out.len() / 4 {
        let v = u32::from_le_bytes(out[4 * w..4 * w + 4].try_into().unwrap());
        out[4 * w..4 * w + 4].copy_from_slice(&moved(rng, v).to_le_bytes());
    }
    out
}

struct MeshModel {
    dynamic: bool,
    shape: Vec<usize>,
    bodies: Vec<Vec<u8>>,
    aabb: [u32; 6],
    version: i64,
}

struct MmModel {
    ok: bool,
    instances: i64,
    colors: bool,
    custom: bool,
    buf: Vec<u32>,
    aabb: [u32; 6],
}

impl MmModel {
    fn stride(&self) -> usize {
        8 + 4 * self.colors as usize + 4 * self.custom as usize
    }
}

fn surface(s: usize, hash: Option<Hash>) -> MeshSurface {
    let (format, vertex_count, index_count) = SHAPES[s];
    MeshSurface {
        hash,
        body_sha256: None,
        payload_bytes: body_len(s) as i64,
        primitive: Primitive::Triangles,
        format,
        vertex_count,
        index_count,
    }
}

fn mesh_entry(id: Id, m: &MeshModel, f: Option<u64>, u8: Option<u64>) -> MeshMeta {
    MeshMeta {
        id,
        origin: Origin::Created,
        adopted_content: None,
        status: EntryStatus::Ok,
        reason: None,
        version: m.version,
        f,
        u8,
        surfaces: m
            .shape
            .iter()
            .enumerate()
            .map(|(k, &s)| {
                surface(
                    s,
                    (!m.dynamic).then(|| Hash([(id as u8).wrapping_add(k as u8); 32])),
                )
            })
            .collect(),
    }
}

#[derive(Default)]
struct Seen {
    txs: usize,
    fulls: usize,
    orders: [usize; 3],
    pass_through: usize,
}

/// One transaction: its meta and its three /12 blocks.
struct Tx {
    meta: TxMeta,
    mesh_f32: Vec<u8>,
    mesh_u8: Vec<u8>,
    mm_f32: Vec<u8>,
}

fn generate(
    rng: &mut Rng,
    seq: i64,
    meshes: &mut BTreeMap<Id, MeshModel>,
    mms: &mut BTreeMap<Id, MmModel>,
    seen: &mut Seen,
) -> Tx {
    let full = seq == 1 || rng.chance(12);
    let mut tx = TxMeta {
        seq,
        frame: seq,
        encoding: Some(if full {
            crate::state::Encoding::Full
        } else {
            crate::state::Encoding::Patch
        }),
        ..TxMeta::default()
    };
    let (mut mesh_f32, mut mesh_u8, mut mm_f32) = (Vec::new(), Vec::new(), Vec::new());
    // Removals and arrivals.
    for id in 1..=7 as Id {
        if meshes.contains_key(&id) {
            if !full && rng.chance(6) {
                meshes.remove(&id);
                tx.removed_meshes.push(id as i64);
            }
        } else if rng.chance(20) {
            let n = 1 + rng.below(3) as usize;
            let shape: Vec<usize> = (0..n)
                .map(|_| rng.below(SHAPES.len() as u64) as usize)
                .collect();
            let bodies = shape.iter().map(|&s| random_body(rng, s)).collect();
            let aabb = std::array::from_fn(|_| (rng.below(4096) as f32 / 8.0).to_bits());
            meshes.insert(
                id,
                MeshModel {
                    dynamic: !rng.chance(15),
                    shape,
                    bodies,
                    aabb,
                    version: 1,
                },
            );
        }
    }
    for (&id, m) in meshes.iter_mut() {
        let carry = full || rng.chance(55);
        if !carry {
            continue; // a pause: H keeps its value
        }
        if rng.chance(4) {
            // A non-ok entry: drops the history's bodies and AABB.
            tx.meshes.push(MeshMeta {
                status: EntryStatus::Unsupported,
                reason: Some("mesh-format"),
                surfaces: vec![],
                ..mesh_entry(id, m, None, None)
            });
            continue;
        }
        m.version += 1;
        if rng.chance(5) {
            m.dynamic = !m.dynamic;
        }
        let mut send_bodies = full || !m.dynamic || rng.chance(75);
        if m.dynamic && rng.chance(10) {
            // A shape change: one surface changes shape, or a surface is added or dropped.
            match rng.below(3) {
                0 => {
                    let k = rng.below(m.shape.len() as u64) as usize;
                    m.shape[k] = rng.below(SHAPES.len() as u64) as usize;
                    m.bodies[k] = random_body(rng, m.shape[k]);
                }
                1 => {
                    let s = rng.below(SHAPES.len() as u64) as usize;
                    m.shape.push(s);
                    m.bodies.push(random_body(rng, s));
                }
                _ if m.shape.len() > 1 => {
                    m.shape.pop();
                    m.bodies.pop();
                }
                _ => {}
            }
            send_bodies = true;
        }
        let u8_at = if m.dynamic && send_bodies {
            let at = mesh_u8.len() as u64;
            for b in m.bodies.iter_mut() {
                *b = moved_body(rng, b);
                mesh_u8.extend_from_slice(b);
            }
            Some(at)
        } else {
            None
        };
        let f = if full || rng.chance(80) {
            for w in m.aabb.iter_mut() {
                *w = moved(rng, *w);
            }
            let at = mesh_f32.len() as u64 / 4;
            for w in m.aabb {
                mesh_f32.extend_from_slice(&w.to_le_bytes());
            }
            Some(at)
        } else {
            None
        };
        tx.meshes.push(mesh_entry(id, m, f, u8_at));
    }
    // Multimeshes.
    for id in 1..=4 as Id {
        if mms.contains_key(&id) {
            if !full && rng.chance(6) {
                mms.remove(&id);
                tx.removed_multimeshes.push(id as i64);
            }
        } else if rng.chance(25) {
            let instances = rng.below(6) as i64;
            let (colors, custom) = (rng.chance(50), rng.chance(30));
            let mut m = MmModel {
                ok: true,
                instances,
                colors,
                custom,
                buf: vec![],
                aabb: [0; 6],
            };
            m.buf = (0..instances as usize * m.stride())
                .map(|_| (rng.below(1000) as f32).to_bits())
                .collect();
            mms.insert(id, m);
        }
    }
    for (&id, m) in mms.iter_mut() {
        if !(full || rng.chance(60)) {
            continue;
        }
        if rng.chance(5) {
            m.ok = !m.ok;
        }
        let mut changed = false;
        if rng.chance(15) {
            m.instances = rng.below(6) as i64;
            changed = true;
        }
        if rng.chance(5) {
            m.colors = !m.colors;
            changed = true;
        }
        if changed {
            m.buf = (0..m.instances as usize * m.stride())
                .map(|_| (rng.below(1000) as f32).to_bits())
                .collect();
        }
        let aabb_f = if m.ok && rng.chance(30) {
            let at = mm_f32.len() as u64 / 4;
            for w in m.aabb.iter_mut() {
                *w = moved(rng, *w);
                mm_f32.extend_from_slice(&w.to_le_bytes());
            }
            Some(at)
        } else {
            None
        };
        let buffer_f = if m.ok && (full || changed || rng.chance(70)) {
            let at = mm_f32.len() as u64 / 4;
            for w in m.buf.iter_mut() {
                *w = moved(rng, *w);
                mm_f32.extend_from_slice(&w.to_le_bytes());
            }
            Some(at)
        } else {
            None
        };
        tx.multimeshes.push(MultimeshMeta {
            id,
            origin: Origin::Created,
            status: if m.ok {
                EntryStatus::Ok
            } else {
                EntryStatus::Freed
            },
            reason: None,
            version: 1,
            mesh: None,
            format: MultimeshFormat::D2,
            colors: m.colors,
            custom: m.custom,
            instances: if m.ok { m.instances } else { 0 },
            visible: -1,
            aabb_f,
            buffer_f,
        });
    }
    // Now and then an offset rule does not hold: that block passes through.
    if rng.chance(5) {
        seen.pass_through += 1;
        match rng.below(3) {
            0 => {
                if let Some(e) = tx.meshes.iter_mut().find(|e| e.u8.is_some()) {
                    e.u8 = e.u8.map(|x| x + 1);
                }
            }
            1 => {
                if let Some(e) = tx.meshes.iter_mut().find(|e| e.f.is_some()) {
                    e.f = e.f.map(|x| x + 1);
                }
            }
            _ => {
                if let Some(e) = tx.multimeshes.iter_mut().find(|e| e.buffer_f.is_some()) {
                    e.buffer_f = e.buffer_f.map(|x| x + 1);
                }
            }
        }
    }
    if full {
        seen.fulls += 1;
    }
    Tx {
        meta: tx,
        mesh_f32,
        mesh_u8,
        mm_f32,
    }
}

fn blocks(t: &Tx) -> Blocks<'_> {
    Blocks {
        mesh_f32: &t.mesh_f32,
        mesh_u8: &t.mesh_u8,
        mm_f32: &t.mm_f32,
    }
}

const MESH_F32_I: usize = crate::predict::MESH_F32;
const MESH_U8_I: usize = crate::predict::MESH_U8;
const MM_F32_I: usize = crate::predict::MM_F32;

fn run(seed: u64, n: usize) -> Seen {
    let mut rng = Rng(seed);
    let (mut meshes, mut mms) = (BTreeMap::new(), BTreeMap::new());
    let (mut enc, mut dec) = (History::default(), History::default());
    let (mut se, mut sd) = (Scratch::default(), Scratch::default());
    // W13p: a third end on the validator's path (plain records retained, bodies read in place).
    let (mut rec, mut sr) = (History::default(), Scratch::default());
    let mut seen = Seen::default();
    for seq in 1..=n as i64 {
        let t = generate(&mut rng, seq, &mut meshes, &mut mms, &mut seen);
        let full = t.meta.is_full();
        // Encode.
        let (mut cf, mut cu, mut cm) = (
            vec![0u8; t.mesh_f32.len()],
            vec![0u8; t.mesh_u8.len()],
            vec![0u8; t.mm_f32.len()],
        );
        let mut units: Vec<Unit> = Vec::new();
        let (h1, h2) = enc.refs(full, false, false);
        code_blocks(
            &t.meta,
            blocks(&t),
            BlocksMut {
                mesh_f32: &mut cf,
                mesh_u8: &mut cu,
                mm_f32: &mut cm,
            },
            h1,
            h2,
            false,
            &mut se,
            Some(&mut units),
        );
        if full {
            assert!(
                units.iter().all(|u| u.order == 0),
                "seed {seed} seq {seq}: a full predicts nothing"
            );
        }
        for u in &units {
            seen.orders[u.order as usize] += 1;
        }
        // Decode.
        let (mut pf, mut pu, mut pm) = (
            vec![0u8; cf.len()],
            vec![0u8; cu.len()],
            vec![0u8; cm.len()],
        );
        let (d1, d2) = dec.refs(full, false, false);
        code_blocks(
            &t.meta,
            Blocks {
                mesh_f32: &cf,
                mesh_u8: &cu,
                mm_f32: &cm,
            },
            BlocksMut {
                mesh_f32: &mut pf,
                mesh_u8: &mut pu,
                mm_f32: &mut pm,
            },
            d1,
            d2,
            true,
            &mut sd,
            None,
        );
        assert!(
            pf == t.mesh_f32,
            "seed {seed} seq {seq}: mesh_f32 round trip"
        );
        assert!(pu == t.mesh_u8, "seed {seed} seq {seq}: mesh_u8 round trip");
        assert!(pm == t.mm_f32, "seed {seed} seq {seq}: mm_f32 round trip");
        assert_eq!(
            check(Blocks {
                mesh_f32: &pf,
                mesh_u8: &pu,
                mm_f32: &pm
            }),
            check(blocks(&t))
        );
        {
            // The plain record: three predicted blocks between filler, at their block indices.
            let parts: [&[u8]; 3] = [&t.mesh_f32, &t.mesh_u8, &t.mm_f32];
            let mut ranges = vec![crate::wire::BlockRange { start: 0, len: 0 }; 9];
            if rng.chance(10) {
                // A transaction that fails after un-predicting: its buffer goes back.
                let mut buf = rec.take_plain();
                buf.clear();
                buf.extend_from_slice(&[0xEE; 64]);
                rec.return_plain(buf);
            }
            let mut buf = rec.take_plain();
            buf.clear();
            buf.extend_from_slice(&[7u8; 13]);
            let (d1, d2) = rec.refs(full, false, false);
            let at = buf.len();
            buf.resize(at + cf.len() + 5 + cu.len() + 3 + cm.len(), 0xAB);
            let starts = [at, at + cf.len() + 5, at + cf.len() + 5 + cu.len() + 3];
            for (k, i) in [MESH_F32_I, MESH_U8_I, MM_F32_I].into_iter().enumerate() {
                ranges[i] = crate::wire::BlockRange {
                    start: starts[k],
                    len: parts[k].len(),
                };
            }
            let dst = crate::predict::blocks_of_mut(&mut buf, &ranges);
            code_blocks(
                &t.meta,
                Blocks {
                    mesh_f32: &cf,
                    mesh_u8: &cu,
                    mm_f32: &cm,
                },
                dst,
                d1,
                d2,
                true,
                &mut sr,
                None,
            );
            let got = crate::predict::blocks_of(&buf, &ranges);
            assert!(
                got.mesh_f32 == &t.mesh_f32[..] && got.mesh_u8 == &t.mesh_u8[..] && got.mm_f32 == &t.mm_f32[..],
                "seed {seed} seq {seq}: retained-record round trip"
            );
            let keep = buf.clone();
            rec.accept_plain(&t.meta, buf, &ranges, false, &mut sr);
            assert!(rec.plain() == Some(&keep[..]), "seed {seed} seq {seq}: plain kept");
        }
        enc.accept(&t.meta, blocks(&t), false, &mut se);
        dec.accept(
            &t.meta,
            Blocks {
                mesh_f32: &pf,
                mesh_u8: &pu,
                mm_f32: &pm,
            },
            false,
            &mut sd,
        );
        assert!(enc.h1() == dec.h1(), "seed {seed} seq {seq}: H1 differs");
        assert!(enc.h2() == dec.h2(), "seed {seed} seq {seq}: H2 differs");
        assert!(enc.h1() == rec.h1(), "seed {seed} seq {seq}: retained H1 differs");
        assert!(enc.h2() == rec.h2(), "seed {seed} seq {seq}: retained H2 differs");
        if full {
            assert!(
                enc.h2().is_empty(),
                "seed {seed} seq {seq}: a full resets H2"
            );
        }
        seen.txs += 1;
    }
    seen
}

#[test]
fn random_streams_round_trip_with_equal_histories() {
    let mut total = Seen::default();
    for seed in 1..=24u64 {
        let s = run(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1, 120);
        total.txs += s.txs;
        total.fulls += s.fulls;
        total.pass_through += s.pass_through;
        for i in 0..3 {
            total.orders[i] += s.orders[i];
        }
    }
    eprintln!(
        "predict property: {} transactions, {} fulls, {} pass-through, units by order {:?}",
        total.txs, total.fulls, total.pass_through, total.orders
    );
    assert!(total.orders.iter().all(|&n| n > 500), "{:?}", total.orders);
    assert!(total.fulls > 100 && total.pass_through > 50);
}

#[test]
fn word_order_is_the_reference_mapping() {
    // ord(u) = u ^ 0x80000000 when u < 2^31, else ~u; unordered its inverse.
    let mut rng = Rng(77);
    let mut words: Vec<u32> = SPECIALS.to_vec();
    words.extend([0, 1, 0x7FFF_FFFF, 0x8000_0000, 0xFFFF_FFFF]);
    words.extend((0..1000).map(|_| rng.next() as u32));
    for u in words {
        let want = if u < 0x8000_0000 { u ^ 0x8000_0000 } else { !u };
        // residual against a zero base word (ord(0) = 0x80000000) is zz(ord(u) - 0x80000000).
        let d = want.wrapping_sub(0x8000_0000);
        let zz = (d << 1) ^ (((d as i32) >> 31) as u32);
        assert_eq!(residual(u, Some(0), None), zz, "{u:08x}");
        assert_eq!(unresidual(zz, Some(0), None), u, "{u:08x}");
    }
}

#[test]
fn special_words_round_trip_at_every_order() {
    let mut rng = Rng(0x1234_5678);
    let mut words: Vec<u32> = SPECIALS.to_vec();
    words.extend((0..64).map(|_| rng.next() as u32));
    for &v in &words {
        assert_eq!(unresidual(residual(v, None, None), None, None), v);
        for &b in &words {
            let r = residual(v, Some(b), None);
            assert_eq!(unresidual(r, Some(b), None), v, "{v:08x} {b:08x}");
            for &p in &words {
                let r = residual(v, Some(b), Some(p));
                assert_eq!(
                    unresidual(r, Some(b), Some(p)),
                    v,
                    "{v:08x} {b:08x} {p:08x}"
                );
            }
        }
    }
    // A pause predicts zero motion; -0.0 and +0.0 are one step apart, as are the two sides of a
    // binade boundary.
    assert_eq!(
        residual(0x3F80_0000, Some(0x3F80_0000), Some(0x3F80_0000)),
        0
    );
    assert_eq!(residual(0x3F80_0000, Some(0x3F80_0000), None), 0);
    assert_eq!(residual(0x0000_0000, Some(0x8000_0000), None), 2);
    assert_eq!(residual(0x8000_0000, Some(0x0000_0000), None), 1);
    assert_eq!(residual(0x3F80_0000, Some(0x3F7F_FFFF), None), 2);
    assert_eq!(residual(0x7FC0_0000, Some(0x7FC0_0000), None), 0);
}

#[test]
fn xxh64_hex_matches_the_reference() {
    assert_eq!(check_hex(xxh64(b"", 0)), "ef46db3751d8e999");
    assert_eq!(check_hex(xxh64(b"a", 0)), "d24ec4f1a98c6e5b");
    // predict_check over three empty blocks is xxh64("").
    assert_eq!(
        check_hex(check(Blocks {
            mesh_f32: &[],
            mesh_u8: &[],
            mm_f32: &[]
        })),
        "ef46db3751d8e999"
    );
    assert_eq!(
        check(Blocks {
            mesh_f32: b"a",
            mesh_u8: &[],
            mm_f32: &[]
        }),
        check(Blocks {
            mesh_f32: &[],
            mesh_u8: &[],
            mm_f32: b"a"
        })
    );
}

fn golden(rel: &str) -> Vec<u8> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol");
    std::fs::read(dir.join(rel)).unwrap()
}

/// What a /12 receiver reads out of each accepted transaction: dynamic body bytes and multimesh
/// buffer bytes, through `record_view`.
fn receiver_view(data: &[u8], version: u8) -> Vec<(i64, Vec<Vec<u8>>, Vec<Vec<u8>>)> {
    let spans = wire::split_records(data, version).unwrap();
    let mut v =
        Validator::new(spans[0].bytes(data), spans[0].offset, Options::new(version)).unwrap();
    let mut out = Vec::new();
    for s in &spans[1..] {
        let rec = s.bytes(data);
        if v.accept(rec, s.offset).unwrap() == Accepted::Transaction {
            assert_eq!(v.plain_record().is_some(), version >= 13);
            let view = v.record_view(rec);
            let bodies = v
                .dynamic_bodies()
                .iter()
                .map(|b| view[b.start..b.start + b.len].to_vec())
                .collect();
            let mm = v
                .multimesh_buffers()
                .iter()
                .map(|b| b.bytes(view).to_vec())
                .collect();
            out.push((v.state().seq, bodies, mm));
        } else {
            assert!(v.plain_record().is_none());
        }
    }
    out
}

#[test]
fn a_13_receiver_sees_the_12_bytes() {
    for (f13, f12) in [
        ("golden-13/predict.rs13", "golden-13/predict.rs12"),
        ("golden-13/patch.rs13", "golden-12/patch.rs12"),
    ] {
        let a = receiver_view(&golden(f13), 13);
        let b = receiver_view(&golden(f12), 12);
        if f13.contains("predict") {
            assert!(a.iter().any(|t| !t.1.is_empty()) && a.iter().any(|t| !t.2.is_empty()));
        }
        assert!(a == b, "{f13}");
    }
}

#[test]
fn transcoders_match_the_goldens_and_refuse_invalid_input() {
    let p12 = golden("golden-13/predict.rs12");
    let p13 = golden("golden-13/predict.rs13");
    assert!(crate::predict::to13(&p12, false, None).unwrap() == p13);
    assert!(crate::predict::to12(&p13, false).unwrap() == p12);
    assert!(
        crate::predict::to13(&p12, true, None).unwrap()
            == golden("golden-13/invalid/predict-stale.rs13")
    );
    assert_eq!(
        crate::predict::to12(&p13, true).unwrap_err().code,
        "predict-check"
    );
    assert_eq!(
        crate::predict::to12(&golden("golden-13/invalid/predict-check-u8.rs13"), false)
            .unwrap_err()
            .code,
        "predict-check"
    );
    assert_eq!(
        crate::predict::to13(&p13, false, None).unwrap_err().code,
        "bad-magic"
    );
    assert_eq!(
        crate::predict::to13(
            &golden("golden-12/invalid/pt-offset-wrong.rs12"),
            false,
            None
        )
        .unwrap_err()
        .code,
        "pt-offset"
    );
}

/// The /13 extra per transaction, by phase: `unpredict_record` (the plain record, the
/// un-prediction and `predict_check`) and `History::accept` (R(T)), the two steps a /13 accept
/// adds to /12's, plus the block coder alone run again warm on the same transaction. Run with
/// `RS13_BENCH=<recording.rs13> cargo test --release --lib predict_phase_bench -- --ignored
/// --nocapture`.
#[test]
#[ignore]
fn predict_phase_bench() {
    use std::time::Instant;
    let Ok(path) = std::env::var("RS13_BENCH") else {
        eprintln!("RS13_BENCH is not set");
        return;
    };
    let us = |a: Instant, b: Instant| (b - a).as_secs_f64() * 1e6;
    let data = std::fs::read(path).unwrap();
    let spans = wire::split_records(&data, 13).unwrap();
    let mut bufs = crate::meta::DecodeBufs::default();
    let mut tx = TxMeta::default();
    let (mut un, mut acc, mut warm) = (Vec::new(), Vec::new(), Vec::new());
    let mut shape = Vec::new();
    for _ in 0..3 {
        let mut hist = History::default();
        let mut sc = Scratch::default();
        let mut again = Vec::new();
        for s in &spans {
            let rec = s.bytes(&data);
            let d = crate::meta::decode_record(rec, s.offset, 13, &mut bufs, &mut tx).unwrap();
            if !matches!(d, crate::meta::Decoded::Transaction) {
                continue;
            }
            let coded = bufs.blocks.clone();
            let t0 = Instant::now();
            // The validator's path (W13p): the plain record rotates through the history.
            let mut plain = hist.take_plain();
            let (h1, h2) = hist.refs(tx.is_full(), false, false);
            let (declared, computed) = crate::predict::unpredict_record(
                rec,
                &tx,
                &mut bufs.blocks,
                h1,
                h2,
                &mut sc,
                &mut plain,
            )
            .unwrap();
            let t1 = Instant::now();
            assert_eq!(declared, computed);
            again.clone_from(&plain);
            let w0 = Instant::now();
            for _ in 0..4 {
                let dst = crate::predict::blocks_of_mut(&mut again, &bufs.blocks);
                let src = crate::predict::blocks_of(rec, &coded);
                code_blocks(&tx, src, dst, h1, h2, true, &mut sc, None);
            }
            let w1 = Instant::now();
            assert!(again == plain);
            let u8_len = crate::predict::blocks_of(&plain, &bufs.blocks).mesh_u8.len();
            let a0 = Instant::now();
            hist.accept_plain(&tx, plain, &bufs.blocks, false, &mut sc);
            let a1 = Instant::now();
            un.push(us(t0, t1));
            warm.push(us(w0, w1) / 4.0);
            acc.push(us(a0, a1));
            let carried = tx.meshes.iter().filter(|e| e.u8.is_some());
            shape.push((
                carried.clone().map(|e| e.surfaces.len()).sum::<usize>(),
                carried
                    .flat_map(|e| &e.surfaces)
                    .map(|s| s.vertex_count)
                    .sum::<i64>(),
                u8_len,
            ));
        }
    }
    shape.sort();
    eprintln!(
        "median transaction (surfaces, vertices, mesh_u8 bytes): {:?}",
        shape[shape.len() / 2]
    );
    let both: Vec<f64> = un.iter().zip(&acc).map(|(a, b)| a + b).collect();
    for (name, mut v) in [
        ("unpredict_record", un),
        ("History::accept", acc),
        ("both", both),
        ("warm code_blocks", warm),
    ] {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let at = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
        eprintln!(
            "{name:<17} p50 {:>7.1} us  p95 {:>7.1} us",
            at(0.5),
            at(0.95)
        );
    }
}
