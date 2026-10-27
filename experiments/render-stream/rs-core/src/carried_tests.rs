//! W11a property tests for render-stream/11's carried set (render-stream-11.md "Properties").
//!
//! A small /11 test encoder writes random state sequences (textures whose hashes leave and
//! return, static and dynamic meshes, transitions, shape and body changes, AABB-only re-sends,
//! stale-coalesce repeats) and a simulated hub serves them to several connections at once. Each
//! connection joins late, skips snapshots (credit window 2 and coalescing make a connection's next
//! base an older snapshot), resyncs (a full transaction after patches) and reconnects (a new
//! stream). The hub keeps no per-connection carried set: before a target T on a connection whose
//! previous transaction was B it sends exactly inline(T) \ inline(B), in table order (decision 2).
//!
//! * **L1**: every connection's validator accepts every record the hub sends it.
//! * **L2**: after every transaction, the validator's C is inline(T), its names(S) is the model's
//!   names(T) in table order, `pruned`/`released` are inline(B) \ names(T) and names(B) \ names(T),
//!   and `check_fetch` refuses exactly the inline-sized names.
//!
//! Folding and stale-coalesce act at apply, never at accept (L1), so the validator sees the
//! same record sequence whatever a receiver later applies; the skip pattern is the part of
//! window 2 that reaches the wire. Seeds are fixed, the generator is a xorshift64*.

use crate::payload::{GRM1_MAGIC, GRT1_MAGIC};
use crate::state::Hash;
use crate::validate::{names_in_table_order, Accepted, Options, Validator};
use crate::wire;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt::Write as _;
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

fn record(meta: &str, blocks: &[&[u8]]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    body.extend_from_slice(meta.as_bytes());
    body.extend_from_slice(&(blocks.len() as u32).to_le_bytes());
    for b in blocks {
        body.extend_from_slice(&(b.len() as u32).to_le_bytes());
        body.extend_from_slice(b);
    }
    let mut out = (body.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(&body);
    out
}

fn texture_payload(k: usize, side: u32) -> Vec<u8> {
    let n = (side * side * 4) as usize;
    let meta = format!(
        "{{\"type\":\"texture-2d\",\"format\":\"RGBA8\",\"width\":{side},\"height\":{side},\"mipmaps\":false,\"data_bytes\":{n}}}"
    );
    let mut out = GRT1_MAGIC.to_vec();
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(meta.as_bytes());
    out.extend_from_slice(&(n as u32).to_le_bytes());
    out.extend((0..n).map(|i| (i as u8).wrapping_mul(7) ^ (k as u8)));
    out
}

/// A coloured triangle (format 33554440: colour, 3 vertices, no index): 24 + 12 data bytes.
const MESH_FORMAT: i64 = 33554440;
const BODY_BYTES: usize = 40 + 24 + 12;

fn mesh_body(seed: u64) -> Vec<u8> {
    let mut out = vec![0u8; 40];
    out.extend((0..36).map(|i| (seed as u8).wrapping_add((i as u8).wrapping_mul(13))));
    out
}

fn mesh_payload(k: usize) -> Vec<u8> {
    let meta = format!(
        "{{\"type\":\"mesh-surface\",\"primitive\":\"triangles\",\"format\":{MESH_FORMAT},\"vertex_count\":3,\"index_count\":0,\"vertex_bytes\":24,\"attribute_bytes\":12,\"skin_bytes\":0,\"index_bytes\":0}}"
    );
    let mut out = GRM1_MAGIC.to_vec();
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(meta.as_bytes());
    out.extend_from_slice(&mesh_body(1000 + k as u64));
    out
}

struct Pools {
    textures: Vec<(Vec<u8>, Hash, u32)>,
    meshes: Vec<(Vec<u8>, Hash)>,
}

impl Pools {
    fn new() -> Pools {
        // Eight small textures (inline everywhere) and three large ones (out-of-band when the
        // session is mixed), so hashes are shared, leave and return.
        let textures = (0..11)
            .map(|k| {
                let side = if k < 8 { 4 } else { 16 };
                let p = texture_payload(k, side);
                let h = wire::sha256(&p);
                (p, h, side)
            })
            .collect();
        let meshes = (0..4)
            .map(|k| {
                let p = mesh_payload(k);
                let h = wire::sha256(&p);
                (p, h)
            })
            .collect();
        Pools { textures, meshes }
    }
}

#[derive(Clone, PartialEq, Debug)]
enum Kind {
    Static(usize),
    /// `seed` is the body serial; `surfaces` the shape (1 or 2 triangles).
    Dynamic {
        seed: u64,
        surfaces: usize,
    },
}

#[derive(Clone, Debug)]
struct MeshS {
    version: i64,
    kind: Kind,
    aabb: u32,
}

#[derive(Clone, Debug, Default)]
struct Snap {
    seq: i64,
    textures: BTreeMap<u32, (i64, usize)>,
    meshes: BTreeMap<u32, MeshS>,
}

/// names(S) in table order, with each payload's length.
fn names(s: &Snap, p: &Pools) -> Vec<(Hash, usize)> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (_, k) in s.textures.values() {
        let (b, h, _) = &p.textures[*k];
        if seen.insert(*h) {
            out.push((*h, b.len()));
        }
    }
    for m in s.meshes.values() {
        if let Kind::Static(k) = m.kind {
            let (b, h) = &p.meshes[k];
            if seen.insert(*h) {
                out.push((*h, b.len()));
            }
        }
    }
    out
}

fn inline_set(s: &Snap, p: &Pools, inline_max: usize) -> Vec<Hash> {
    names(s, p)
        .into_iter()
        .filter(|(_, n)| *n <= inline_max)
        .map(|(h, _)| h)
        .collect()
}

fn snapshots(rng: &mut Rng, n: usize, pools: &Pools) -> Vec<Snap> {
    let mut s = Snap::default();
    let (mut next_tex, mut next_mesh, mut serial) = (1u32, 1u32, 1u64);
    for _ in 0..3 {
        s.textures.insert(
            next_tex,
            (1, rng.below(pools.textures.len() as u64) as usize),
        );
        next_tex += 1;
    }
    s.meshes.insert(
        next_mesh,
        MeshS {
            version: 1,
            kind: Kind::Static(0),
            aabb: 0,
        },
    );
    next_mesh += 1;
    let mut out = Vec::with_capacity(n);
    for seq in 1..=n as i64 {
        s.seq = seq;
        // seq 1 as generated; later ones: 0 mutations is a stale-coalesce repeat.
        let mutations = if seq == 1 { 0 } else { rng.below(4) };
        for _ in 0..mutations {
            let tex_ids: Vec<u32> = s.textures.keys().copied().collect();
            let mesh_ids: Vec<u32> = s.meshes.keys().copied().collect();
            let pick = |rng: &mut Rng, ids: &[u32]| ids[rng.below(ids.len() as u64) as usize];
            match rng.below(10) {
                0 | 1 => {
                    // A texture's image changes: its old hash may leave, a new one may return.
                    let id = pick(rng, &tex_ids);
                    let e = s.textures.get_mut(&id).unwrap();
                    e.0 += 1;
                    e.1 = rng.below(pools.textures.len() as u64) as usize;
                }
                2 => {
                    s.textures.insert(
                        next_tex,
                        (1, rng.below(pools.textures.len() as u64) as usize),
                    );
                    next_tex += 1;
                }
                3 if tex_ids.len() > 1 => {
                    s.textures.remove(&pick(rng, &tex_ids));
                }
                4 => {
                    let kind = if rng.chance(50) {
                        Kind::Static(rng.below(pools.meshes.len() as u64) as usize)
                    } else {
                        serial += 1;
                        Kind::Dynamic {
                            seed: serial,
                            surfaces: 1 + rng.below(2) as usize,
                        }
                    };
                    s.meshes.insert(
                        next_mesh,
                        MeshS {
                            version: 1,
                            kind,
                            aabb: 0,
                        },
                    );
                    next_mesh += 1;
                }
                5 if mesh_ids.len() > 1 => {
                    s.meshes.remove(&pick(rng, &mesh_ids));
                }
                6 if !mesh_ids.is_empty() => {
                    // Static: a new payload, or the transition to dynamic. Dynamic: new bytes of
                    // the same shape, or a shape change.
                    let m = s.meshes.get_mut(&pick(rng, &mesh_ids)).unwrap();
                    m.version += 1;
                    serial += 1;
                    m.kind = match m.kind {
                        Kind::Static(_) if rng.chance(50) => {
                            Kind::Static(rng.below(pools.meshes.len() as u64) as usize)
                        }
                        Kind::Static(_) => Kind::Dynamic {
                            seed: serial,
                            surfaces: 1,
                        },
                        Kind::Dynamic { surfaces, .. } => Kind::Dynamic {
                            seed: serial,
                            surfaces: if rng.chance(30) {
                                3 - surfaces
                            } else {
                                surfaces
                            },
                        },
                    };
                }
                7 if !mesh_ids.is_empty() => {
                    // Custom AABB only: the entry is re-sent with equal bytes (u8 null).
                    let m = s.meshes.get_mut(&pick(rng, &mesh_ids)).unwrap();
                    m.version += 1;
                    m.aabb += 1;
                }
                _ => {}
            }
        }
        out.push(s.clone());
    }
    out
}

/// The hub's encoder: the records inline(T) \ inline(B) in table order, then T as a full or as
/// a patch against B. `u8` is non-null for a full, a new entry, the transition from static, a
/// shape change, or a body serial that moved since B.
/// `seq` is the connection's own transaction counter (seqs are consecutive per stream; P3-SP's
/// re-stamp), the snapshot's `seq` its frame.
fn encode(
    seq: i64,
    t: &Snap,
    b: Option<&Snap>,
    full: bool,
    null_unsupported: bool,
    p: &Pools,
    inline_max: usize,
) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let held: HashSet<Hash> = b
        .map(|b| inline_set(b, p, inline_max).into_iter().collect())
        .unwrap_or_default();
    let mut payloads: BTreeMap<Hash, &[u8]> = BTreeMap::new();
    for (bytes, h, _) in &p.textures {
        payloads.insert(*h, bytes);
    }
    for (bytes, h) in &p.meshes {
        payloads.insert(*h, bytes);
    }
    for h in inline_set(t, p, inline_max) {
        if held.contains(&h) {
            continue;
        }
        let bytes = payloads[&h];
        let meta = format!(
            "{{\"type\":\"resource\",\"hash\":\"{}\",\"bytes\":{},\"blocks\":[{{\"name\":\"payload\",\"type\":\"u8\",\"count\":{}}}]}}",
            h.to_hex(),
            bytes.len(),
            bytes.len()
        );
        out.push(record(&meta, &[bytes]));
    }
    let patch = !full && b.is_some();
    let base = if patch { b } else { None };
    let mut textures = String::new();
    for (id, (version, k)) in &t.textures {
        if base.is_some_and(|b| b.textures.get(id) == Some(&(*version, *k))) {
            continue;
        }
        let (bytes, h, side) = &p.textures[*k];
        if !textures.is_empty() {
            textures.push(',');
        }
        write!(
            textures,
            "{{\"id\":{id},\"origin\":\"created\",\"adopted_content\":null,\"kind\":\"image\",\"status\":\"ok\",\"reason\":null,\"version\":{version},\"hash\":\"{}\",\"format\":\"RGBA8\",\"source_format\":null,\"width\":{side},\"height\":{side},\"mipmaps\":false,\"payload_bytes\":{},\"variants\":[],\"canvas\":null}}",
            h.to_hex(),
            bytes.len()
        )
        .unwrap();
    }
    let (mut meshes, mut mesh_f32, mut mesh_u8) = (String::new(), Vec::new(), Vec::new());
    for (id, m) in &t.meshes {
        let old = base.and_then(|b| b.meshes.get(id));
        if old.is_some_and(|o| o.version == m.version) {
            continue;
        }
        let f = mesh_f32.len() / 4;
        for x in [0.0f32, 0.0, 0.0, m.aabb as f32, m.aabb as f32, 0.0] {
            mesh_f32.extend_from_slice(&x.to_le_bytes());
        }
        if !meshes.is_empty() {
            meshes.push(',');
        }
        let (u8_at, surfaces) = match &m.kind {
            Kind::Static(k) => {
                let (bytes, h) = &p.meshes[*k];
                (
                    "null".to_string(),
                    format!(
                        "{{\"hash\":\"{}\",\"payload_bytes\":{},\"primitive\":\"triangles\",\"format\":{MESH_FORMAT},\"vertex_count\":3,\"index_count\":0}}",
                        h.to_hex(),
                        bytes.len()
                    ),
                )
            }
            Kind::Dynamic { seed, surfaces } => {
                let held = match old.map(|o| &o.kind) {
                    Some(Kind::Dynamic {
                        seed: s0,
                        surfaces: n0,
                    }) => s0 == seed && n0 == surfaces,
                    _ => false,
                };
                let u8_at = if held {
                    "null".to_string()
                } else {
                    let at = mesh_u8.len();
                    for k in 0..*surfaces {
                        mesh_u8.extend_from_slice(&mesh_body(seed * 4 + k as u64));
                    }
                    at.to_string()
                };
                let one = format!(
                    "{{\"hash\":null,\"payload_bytes\":{BODY_BYTES},\"primitive\":\"triangles\",\"format\":{MESH_FORMAT},\"vertex_count\":3,\"index_count\":0}}"
                );
                (u8_at, vec![one; *surfaces].join(","))
            }
        };
        write!(
            meshes,
            "{{\"id\":{id},\"origin\":\"created\",\"adopted_content\":null,\"status\":\"ok\",\"reason\":null,\"version\":{},\"f\":{f},\"u8\":{u8_at},\"surfaces\":[{surfaces}]}}",
            m.version
        )
        .unwrap();
    }
    let removed = |a: Vec<u32>| {
        a.iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",")
    };
    let (rm_tex, rm_mesh) = match base {
        Some(b) => (
            removed(
                b.textures
                    .keys()
                    .filter(|i| !t.textures.contains_key(i))
                    .copied()
                    .collect(),
            ),
            removed(
                b.meshes
                    .keys()
                    .filter(|i| !t.meshes.contains_key(i))
                    .copied()
                    .collect(),
            ),
        ),
        None => (String::new(), String::new()),
    };
    let canvas_f32: Vec<u8> = if patch {
        vec![]
    } else {
        [1.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0]
            .iter()
            .flat_map(|x| x.to_le_bytes())
            .collect()
    };
    let canvases = if patch {
        ""
    } else {
        "{\"id\":1,\"origin\":\"root-query\",\"role\":\"root\",\"attached\":true,\"layer\":0,\"sublayer\":0,\"items\":[]}"
    };
    let meta = format!(
        "{{\"type\":\"transaction\",\"seq\":{seq},\"frame\":{frame},\"encoding\":\"{enc}\",\"base_seq\":{base_seq},\"status\":\"ok\",\"failures\":[],\"unsupported\":{unsup},\"default_texture_filter\":\"nearest\",\"default_texture_repeat\":\"disabled\",\"removed_canvases\":[],\"removed_items\":[],\"removed_textures\":[{rm_tex}],\"removed_meshes\":[{rm_mesh}],\"removed_shaders\":[],\"removed_materials\":[],\"canvases\":[{canvases}],\"items\":[],\"textures\":[{textures}],\"meshes\":[{meshes}],\"shaders\":[],\"materials\":[],\"blocks\":[{{\"name\":\"item_f32\",\"type\":\"f32\",\"count\":0}},{{\"name\":\"canvas_f32\",\"type\":\"f32\",\"count\":{nc}}},{{\"name\":\"cmd_f32\",\"type\":\"f32\",\"count\":0}},{{\"name\":\"cmd_i32\",\"type\":\"i32\",\"count\":0}},{{\"name\":\"mesh_f32\",\"type\":\"f32\",\"count\":{nm}}},{{\"name\":\"param_f64\",\"type\":\"f64\",\"count\":0}},{{\"name\":\"backbuffer_f32\",\"type\":\"f32\",\"count\":0}},{{\"name\":\"mesh_u8\",\"type\":\"u8\",\"count\":{nu}}},{{\"name\":\"mm_f32\",\"type\":\"f32\",\"count\":0}}]}}",
        frame = t.seq,
        enc = if patch { "patch" } else { "full" },
        base_seq = if base.is_some() {
            (seq - 1).to_string()
        } else {
            "null".to_string()
        },
        unsup = if patch && null_unsupported { "null" } else { "[]" },
        nc = canvas_f32.len() / 4,
        nm = mesh_f32.len() / 4,
        nu = mesh_u8.len(),
    );
    let empty: &[u8] = &[];
    out.push(record(
        &meta,
        &[
            empty,
            &canvas_f32,
            empty,
            empty,
            &mesh_f32,
            empty,
            empty,
            &mesh_u8,
            empty,
        ],
    ));
    out
}

/// golden-11's inline session, its stream re-declared `patch` and (`mixed`) its delivery mixed.
fn session(inline_max: Option<usize>) -> Vec<u8> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-11");
    let data = std::fs::read(dir.join("inline.rs11")).unwrap();
    let rec = wire::split_records(&data, 11).unwrap()[0]
        .bytes(&data)
        .to_vec();
    let meta_len = wire::le_u32(&rec, 4) as usize;
    let mut meta = std::str::from_utf8(&rec[8..8 + meta_len])
        .unwrap()
        .to_string();
    let edit = |meta: &mut String, a: &str, b: &str| {
        assert_eq!(meta.matches(a).count(), 1, "{a}");
        *meta = meta.replace(a, b);
    };
    edit(
        &mut meta,
        "\"transport\":\"file\",\"encoding\":\"full\"",
        "\"transport\":\"file\",\"encoding\":\"patch\"",
    );
    if let Some(n) = inline_max {
        edit(
            &mut meta,
            "\"delivery\":\"inline\",\"inline_max_bytes\":16777216",
            &format!("\"delivery\":\"mixed\",\"inline_max_bytes\":{n}"),
        );
        edit(&mut meta, "\"fetch\":\"none\"", "\"fetch\":\"directory\"");
    }
    let rest = &rec[8 + meta_len..];
    let mut out = Vec::new();
    out.extend_from_slice(&((4 + meta.len() + rest.len()) as u32).to_le_bytes());
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(meta.as_bytes());
    out.extend_from_slice(rest);
    out
}

struct Conn {
    seq: i64,
    v: Option<Validator>,
    base: Option<usize>,
    offset: usize,
}

/// What a hub run exercised, summed over its connections.
#[derive(Default, Debug)]
struct Seen {
    txs: usize,
    records: usize,
    /// Transactions that pruned a hash out of C.
    pruned: usize,
    /// Records of a hash this connection's stream had carried before (a return).
    returns: usize,
    /// Dynamic bodies carried, and dynamic entries re-sent with a null `u8`.
    bodies: usize,
    held: usize,
}

/// One hub run.
fn hub(seed: u64, inline_max: Option<usize>) -> Seen {
    let mut rng = Rng(seed);
    let pools = Pools::new();
    let snaps = snapshots(&mut rng, 80, &pools);
    let limit = inline_max.unwrap_or(16_777_216);
    let session = session(inline_max);
    let mut conns: Vec<Conn> = (0..4)
        .map(|_| Conn {
            seq: 0,
            v: None,
            base: None,
            offset: 0,
        })
        .collect();
    let mut seen = Seen::default();
    let mut ever: Vec<HashSet<Hash>> = vec![HashSet::new(); conns.len()];
    let mut stray = Rng(seed ^ 0x5eed);
    for (ti, t) in snaps.iter().enumerate() {
        for (ci, c) in conns.iter_mut().enumerate() {
            // Late join, then reconnects (a new stream: C = ∅ on both ends).
            if c.v.is_none() || rng.chance(4) {
                if c.v.is_some() || ci == 0 || rng.chance(25) {
                    c.v = Some(Validator::new(&session, 8, Options::new(11)).unwrap());
                    c.base = None;
                    c.seq = 0;
                    ever[ci].clear();
                    c.offset = 8 + session.len();
                } else {
                    continue;
                }
            }
            // A credit-limited or coalescing connection skips snapshots (its next base is older).
            if c.base.is_some() && rng.chance(35) {
                continue;
            }
            let full = c.base.is_none() || rng.chance(10);
            let b = c.base.map(|i| &snaps[i]);
            c.seq += 1;
            let records = encode(c.seq, t, b, full, rng.chance(50), &pools, limit);
            let v = c.v.as_mut().unwrap();
            let names_b: Vec<Hash> = b
                .map(|b| names(b, &pools).into_iter().map(|x| x.0).collect())
                .unwrap_or_default();
            let inline_b: Vec<Hash> = b.map(|b| inline_set(b, &pools, limit)).unwrap_or_default();
            let n = records.len();
            for (k, r) in records.iter().enumerate() {
                let got = v.accept(r, c.offset).unwrap_or_else(|e| {
                    panic!("seed {seed} snapshot {ti} conn {ci} record {k}/{n}: {e}")
                });
                c.offset += r.len();
                if k + 1 < n {
                    let Accepted::Resource { hash } = got else {
                        panic!("not a resource");
                    };
                    seen.records += 1;
                    if !ever[ci].insert(hash) {
                        seen.returns += 1;
                    }
                } else {
                    assert_eq!(got, Accepted::Transaction);
                }
            }
            seen.txs += 1;
            seen.pruned += !v.pruned().is_empty() as usize;
            seen.bodies += v.dynamic_bodies().len();
            seen.held += v
                .delta()
                .meshes_upserted
                .iter()
                .filter(|id| {
                    v.state().meshes[id].is_dynamic()
                        && !v.dynamic_bodies().iter().any(|b| b.mesh == **id)
                })
                .count();
            c.base = Some(ti);
            // L2: C = inline(T); names(S) is the model's, in table order.
            let model: Vec<Hash> = names(t, &pools).into_iter().map(|x| x.0).collect();
            assert_eq!(
                names_in_table_order(v.state()),
                model,
                "seed {seed} snapshot {ti}"
            );
            assert_eq!(v.names_len(), model.len());
            let c_set: BTreeSet<[u8; 32]> = v.carried().map(|h| h.0).collect();
            let want: BTreeSet<[u8; 32]> =
                inline_set(t, &pools, limit).iter().map(|h| h.0).collect();
            assert_eq!(
                c_set, want,
                "seed {seed} snapshot {ti} conn {ci}: C != inline(T)"
            );
            // pruned = inline(B) \ names(T), released = names(B) \ names(T).
            let model_set: HashSet<Hash> = model.iter().copied().collect();
            let mut released: Vec<Hash> = names_b
                .iter()
                .filter(|h| !model_set.contains(h))
                .copied()
                .collect();
            released.sort_by(|a, b| a.0.cmp(&b.0));
            let mut pruned: Vec<Hash> = inline_b
                .iter()
                .filter(|h| !model_set.contains(h))
                .copied()
                .collect();
            pruned.sort_by(|a, b| a.0.cmp(&b.0));
            assert_eq!(
                v.released(),
                released.as_slice(),
                "seed {seed} snapshot {ti}: released"
            );
            assert_eq!(
                v.pruned(),
                pruned.as_slice(),
                "seed {seed} snapshot {ti}: pruned"
            );
            // Decision 9: an inline-sized name is never fetched; an out-of-band one may be.
            for (h, len) in names(t, &pools) {
                assert_eq!(v.check_fetch(&h).is_err(), len <= limit, "check_fetch");
            }
            let mut other = [0u8; 32];
            for b in other.iter_mut() {
                *b = stray.next() as u8;
            }
            assert!(v.check_fetch(&Hash(other)).is_ok());
            // Dynamic bodies: one per surface of each entry the transaction carried bytes for.
            for body in v.dynamic_bodies() {
                assert_eq!(body.len, BODY_BYTES);
                assert!(v.state().meshes[&body.mesh].is_dynamic());
            }
        }
    }
    seen
}

#[test]
fn l1_l2_hub_connections_from_different_bases() {
    let mut all = Seen::default();
    for seed in 1..=24u64 {
        for inline_max in [None, Some(600)] {
            let s = hub(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1, inline_max);
            all.txs += s.txs;
            all.records += s.records;
            all.pruned += s.pruned;
            all.returns += s.returns;
            all.bodies += s.bodies;
            all.held += s.held;
        }
    }
    eprintln!("carried-set hub: {all:?}");
    // Floors against a generator that stopped exercising a rule.
    assert!(
        all.txs > 5000
            && all.records > 1000
            && all.pruned > 500
            && all.returns > 200
            && all.bodies > 1000
            && all.held > 100,
        "{all:?}"
    );
}

#[test]
fn early_prune_sabotage_fails_the_hub() {
    // Decision 10: pruning before a transaction's checks drops the records it brings.
    let pools = Pools::new();
    let mut rng = Rng(7);
    let snaps = snapshots(&mut rng, 4, &pools);
    let session = session(None);
    let mut v = Validator::new(
        &session,
        8,
        Options {
            early_prune: true,
            ..Options::new(11)
        },
    )
    .unwrap();
    let mut err = None;
    for r in encode(1, &snaps[0], None, true, false, &pools, 1 << 24) {
        if let Err(e) = v.accept(&r, 0) {
            err = Some(e.code);
            break;
        }
    }
    assert_eq!(err, Some("resource-missing"));
}

#[test]
fn a_record_while_carried_is_a_duplicate_and_a_returning_hash_is_not() {
    // Re-sending a record while its hash is in C is resource-duplicate; once a state without it
    // has pruned it, the same record is legal again (L2's "inline(T) \ inline(B)").
    let pools = Pools::new();
    let mut a = Snap {
        seq: 1,
        ..Snap::default()
    };
    a.textures.insert(1, (1, 0));
    let mut b = a.clone();
    b.seq = 2;
    b.textures.insert(1, (2, 1));
    let mut c = a.clone();
    c.seq = 3;
    c.textures.insert(1, (3, 0));
    let session = session(None);
    let mut v = Validator::new(&session, 8, Options::new(11)).unwrap();
    for r in encode(1, &a, None, true, false, &pools, 1 << 24) {
        v.accept(&r, 0).unwrap();
    }
    // A failed accept changes nothing, so the stream continues after it.
    let again = encode(1, &a, None, true, false, &pools, 1 << 24);
    assert_eq!(
        v.accept(&again[0], 0).unwrap_err().code,
        "resource-duplicate"
    );
    for r in encode(2, &b, Some(&a), false, true, &pools, 1 << 24) {
        v.accept(&r, 0).unwrap();
    }
    assert_eq!(v.pruned(), &[pools.textures[0].1]);
    for r in encode(3, &c, Some(&b), false, true, &pools, 1 << 24) {
        v.accept(&r, 0).unwrap();
    }
    assert!(v.is_carried(&pools.textures[0].1));
    assert!(!v.is_carried(&pools.textures[1].1));
}
