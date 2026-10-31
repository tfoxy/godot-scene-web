//! The incremental recording validator (`createRecordingValidator` in `render-stream-2.ts`), with
//! the resolve engine (`applyTransaction`) and the resolved-state invariants
//! (`checkResolvedInvariants`, `checkPatchRules`, the version/resource/id-reuse sweeps) made
//! delta-driven (gate7-design.md D29):
//!
//! * a patch mutates the retained [`ResolvedState`] in place, logging every replaced entry, so a
//!   failed `accept` rolls back exactly and leaves the state as it was;
//! * every invariant the TypeScript re-checks over the whole state each transaction is answered
//!   here from maintained indexes (claims per container, reverse references from commands, canvas
//!   textures, materials and shaders, draw-index tie groups, per-item derived unsupported entries,
//!   root and stacking counts, max ids), touching only what the transaction changed. Previous state
//!   was valid, so a violation can only involve a changed entry; each check enumerates exactly
//!   those, and reports the violator the TypeScript would report first (lowest id).
//!
//! A full transaction rebuilds the state and the indexes from its own entries (it carries them
//! all), which is O(transaction), as is everything a patch costs.
//!
//! # Deviations from the TypeScript decoder
//!
//! The first error's code is the TypeScript's for every input either accepts; these inputs, none
//! of which a capture emits, are judged differently:
//!
//! * an id outside `0..=u32::MAX` (state.rs's `Id`), or any integer outside `i64`, fails the
//!   integer check of the field it appears in (`meta-schema`, or that field's self-coded code),
//!   where the TypeScript accepts any integral double (a negative item id, say) and may report a
//!   later, semantic code or nothing;
//! * a string state.rs holds (a failure detail, an unsupported op or command name, a texture
//!   format, a param or default-texture name) carrying a lone `\udxxx` escape fails that field's
//!   check; the TypeScript accepts it;
//! * `trailing-bytes` is reported by the `accept` after the end record, not by the end record's
//!   own (it cannot know that more follows); a whole-recording run reports the same first code;
//! * error details (the text after the code) are this crate's own, naming the lowest-id violator.
//!
//! After a failed `accept` nothing has changed (the TypeScript validator may already have advanced
//! its last-seen tables; it is never fed again after an error).

use crate::meta::{self, CmdMeta, DecodeBufs, Decoded, EndMeta, Op, ResourceMeta, Session, TxMeta};
use crate::payload::{self, PayloadKind};
use crate::item_meta;
use crate::prof;
use crate::state::*;
use crate::wire::{self, F32s, F64s, I32s, MAGIC_LEN};
use std::collections::{BTreeSet, HashMap};
use std::hash::{BuildHasherDefault, Hasher};

pub use crate::item_meta::{ItemMetaAsk, ItemMetaRecord, ItemMetaRequest, ItemMetaTable};
pub use crate::wire::Error;

/// D31: who computes each record's SHA-256.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DigestPolicy {
    /// `accept` hashes every accepted record.
    Inline,
    /// `accept` records `None`; the caller fills digests later with `set_record_digest`.
    Deferred,
    /// PH2: `accept` records `None` and nobody fills it: a live client that never reads a record
    /// digest (`@godot-scene-web/render-stream-client`). Every check is unchanged: the resource
    /// payload hash (`resource-hash`, still SHA-256: it is compared with the host's), seq/base
    /// rules, W11t's checksum and /13's `predict-check`. The dynamic mesh body and multimesh
    /// buffer digests stay too, as state identity (no-op detection, `mesh-version`,
    /// `multimesh-version`), but as a cheaper 256-bit identity than SHA-256 (`fast_identity`):
    /// they are only compared with each other.
    Never,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Options {
    /// The protocol version, 2 to 13.
    pub version: u8,
    pub digest: DigestPolicy,
    /// Verify a resource record's payload against its declared hash (`resource-hash`). `false` is
    /// the `skip-payload-hash` sabotage only.
    pub verify_payload_hashes: bool,
    /// /11 sabotage `early-prune` (render-stream-11.md decision 10): prune C to the base state's
    /// names when a transaction arrives, before resolving and checking it. `false` always, except
    /// in the sabotage.
    pub early_prune: bool,
    /// /13 decoder sabotage `no-predict-reset` (render-stream-13.md "Sabotages"): a full does not
    /// reset the prediction history (it is un-predicted against H1 and H2 like a patch). `false`
    /// always, except in the sabotage.
    pub no_predict_reset: bool,
    /// TAG1 (client-extensions-design.md §2.4, /13 only): what the stream's viewer asked for.
    /// `Unknown` (the default: a recording) accepts and validates `item_meta` records; `NotAsked`
    /// refuses them (`item-meta-unexpected`); `Asked` checks each grant against the request.
    pub item_meta: ItemMetaAsk,
}

impl Options {
    pub fn new(version: u8) -> Options {
        Options {
            version,
            digest: DigestPolicy::Inline,
            verify_payload_hashes: true,
            early_prune: false,
            no_predict_reset: false,
            item_meta: ItemMetaAsk::Unknown,
        }
    }
}

/// What an accepted record was. After `Transaction` at /11, [`Validator::pruned`] and
/// [`Validator::released`] name the hashes the transaction dropped, and
/// [`Validator::dynamic_bodies`] locates its dynamic mesh bodies in the record.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Accepted {
    Resource { hash: Hash },
    Transaction,
    End,
    /// TAG1: an `item_meta` record, held ([`Validator::item_meta_pending`]) until the transaction
    /// it describes is accepted, which then updates [`Validator::item_meta`]. Nothing to apply.
    ItemMeta,
}

// ------------------------------------------------------------------------------------- id hashing

#[derive(Default, Clone, Copy)]
pub struct IdHasher(u64);

impl Hasher for IdHasher {
    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(5) ^ b as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }
    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.0 = (self.0.rotate_left(5) ^ i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.0 = (self.0.rotate_left(5) ^ i).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
    #[inline]
    fn write_i64(&mut self, i: i64) {
        self.write_u64(i as u64);
    }
}

type FastMap<K, V> = HashMap<K, V, BuildHasherDefault<IdHasher>>;

// ------------------------------------------------------------------------------------- indexes

/// A container key: canvas `id` or item `id | 1 << 32`.
type PKey = u64;

#[inline]
fn pkey(p: &Parent) -> PKey {
    match p.kind {
        ParentKind::Canvas => p.id as u64,
        ParentKind::Item => p.id as u64 | 1 << 32,
    }
}
#[inline]
fn canvas_key(id: Id) -> PKey {
    id as u64
}
#[inline]
fn item_key(id: Id) -> PKey {
    id as u64 | 1 << 32
}

/// `RS_METHOD_FOR_OP`: the RenderingServer method a tex-bearing op names in a derived entry.
const RS_METHODS: &[&str] = &[
    "canvas_item_add_texture_rect",
    "canvas_item_add_texture_rect_region",
    "canvas_item_add_msdf_texture_rect_region",
    "canvas_item_add_primitive",
    "canvas_item_add_polygon",
    "canvas_item_add_triangle_array",
    "canvas_item_add_nine_patch",
    "canvas_item_add_mesh",
    // /11 (PM1): `add_multimesh`'s `tex` follows the texture rules of every op with a `tex`.
    "canvas_item_add_multimesh",
    // /12 (PM5): `add_particles`' `tex` likewise.
    "canvas_item_add_particles",
];

fn rs_method(cmd: &Command) -> Option<u8> {
    Some(match cmd {
        Command::TextureRect { .. } => 0,
        Command::TextureRectRegion { .. } => 1,
        Command::MsdfTextureRectRegion { .. } => 2,
        Command::Primitive { .. } => 3,
        Command::Polygon { .. } => 4,
        Command::TriangleArray { .. } => 5,
        Command::NinePatch { .. } => 6,
        Command::Mesh { .. } => 7,
        Command::Multimesh { .. } => 8,
        Command::Particles { .. } => 9,
        _ => return None,
    })
}

#[derive(Clone, Debug)]
struct TexIdx {
    status: EntryStatus,
    diffuse: Option<Id>,
    /// The texture makes a tex-bearing command derive `unsupported-texture` (it is unsupported, or
    /// a canvas texture whose diffuse is).
    u: bool,
}

#[derive(Clone, Debug)]
struct MatIdx {
    shader: Option<Id>,
    texs: Vec<Id>,
    /// An item whose effective material this is derives `unsupported-material`.
    unsup: bool,
}

#[derive(Clone, Debug, Default)]
struct ItemIdx {
    parent: Option<PKey>,
    draw_index: i64,
    drawing: bool,
    material: Option<Id>,
    upm: bool,
    /// Distinct (tex, RS method) pairs of the item's tex-bearing commands, sorted.
    tex_refs: Vec<(Id, u8)>,
    /// Distinct texture ids of those, sorted.
    tex_ids: Vec<Id>,
    /// Distinct mesh ids of the item's add_mesh commands, sorted.
    meshes: Vec<Id>,
    /// Distinct unsupported command names: (first command index, derived reason).
    ops: Vec<(u32, &'static str)>,
    /// Derived `unsupported-texture` methods, sorted.
    tex_unsup: Vec<u8>,
    mesh_unsup: bool,
    /// /11: distinct multimesh ids of the item's add_multimesh commands, sorted.
    mms: Vec<Id>,
    /// /11: an add_multimesh names an `unsupported` multimesh (`unsupported-multimesh`).
    mm_unsup: bool,
    /// /12: distinct particles ids of the item's add_particles commands, sorted.
    pts: Vec<Id>,
    /// /12: an add_particles names an `unsupported` emitter (`unsupported-particles`).
    pt_unsup: bool,
    eff: Option<Id>,
    mat_unsup: bool,
}

#[derive(Default)]
struct Index {
    tex: FastMap<Id, TexIdx>,
    mesh: FastMap<Id, EntryStatus>,
    /// /11: each resolved multimesh's status.
    mm: FastMap<Id, EntryStatus>,
    /// /12: each resolved particles entry's status.
    pt: FastMap<Id, EntryStatus>,
    shader_texs: FastMap<Id, Vec<Id>>,
    mat: FastMap<Id, MatIdx>,
    canvas: FastMap<Id, (bool, bool, (i64, i64))>,
    item: FastMap<Id, ItemIdx>,
    claims: BTreeSet<(PKey, Id)>,
    tex_users: BTreeSet<(Id, Id)>,
    mesh_users: BTreeSet<(Id, Id)>,
    /// /11: (multimesh, item) for every add_multimesh.
    mm_users: BTreeSet<(Id, Id)>,
    /// /12: (particles, item) for every add_particles.
    pt_users: BTreeSet<(Id, Id)>,
    mat_users: BTreeSet<(Id, Id)>,
    eff_users: BTreeSet<(Id, Id)>,
    diffuse_users: BTreeSet<(Id, Id)>,
    shader_users: BTreeSet<(Id, Id)>,
    mat_tex_users: BTreeSet<(Id, Id)>,
    shader_tex_users: BTreeSet<(Id, Id)>,
    groups: FastMap<(PKey, i64), BTreeSet<Id>>,
    tie_groups: usize,
    root_count: usize,
    stack_groups: FastMap<(i64, i64), u32>,
    stack_ties: usize,
    n_ops: usize,
    n_tex_unsup: usize,
    n_mesh_unsup: usize,
    n_mm_unsup: usize,
    n_pt_unsup: usize,
    n_mat_unsup: usize,
    /// Containers whose claim set changed in the last reindex.
    touched: Vec<PKey>,
}

fn users<'a, K: Copy + Ord>(set: &'a BTreeSet<(K, Id)>, k: K) -> impl Iterator<Item = Id> + 'a {
    set.range((k, 0)..=(k, Id::MAX)).map(|&(_, u)| u)
}

fn sorted_dedup<T: Ord>(v: &mut Vec<T>) {
    v.sort_unstable();
    v.dedup();
}

impl Index {
    fn group_add(&mut self, p: PKey, di: i64, id: Id) {
        let g = self.groups.entry((p, di)).or_default();
        if g.insert(id) && g.len() == 2 {
            self.tie_groups += 1;
        }
    }
    fn group_remove(&mut self, p: PKey, di: i64, id: Id) {
        if let Some(g) = self.groups.get_mut(&(p, di)) {
            if g.remove(&id) {
                if g.len() == 1 {
                    self.tie_groups -= 1;
                }
                if g.is_empty() {
                    self.groups.remove(&(p, di));
                }
            }
        }
    }
    fn stack_add(&mut self, k: (i64, i64)) {
        let n = self.stack_groups.entry(k).or_insert(0);
        *n += 1;
        if *n == 2 {
            self.stack_ties += 1;
        }
    }
    fn stack_remove(&mut self, k: (i64, i64)) {
        if let Some(n) = self.stack_groups.get_mut(&k) {
            *n -= 1;
            if *n == 1 {
                self.stack_ties -= 1;
            }
            if *n == 0 {
                self.stack_groups.remove(&k);
            }
        }
    }
    /// The item is the smallest drawing id of a draw-index tie group (invariant 9).
    fn is_tie_item(&self, id: Id) -> bool {
        let Some(e) = self.item.get(&id) else {
            return false;
        };
        let Some(p) = e.parent else { return false };
        if !e.drawing {
            return false;
        }
        self.groups
            .get(&(p, e.draw_index))
            .is_some_and(|g| g.len() >= 2 && g.first() == Some(&id))
    }
}

/// The ids a transaction touched, to reindex (and, on failure, to reindex back).
#[derive(Default)]
struct Dirty {
    canvases: Vec<Id>,
    /// (id, whether the item's commands were replaced)
    items: Vec<(Id, bool)>,
    textures: Vec<Id>,
    meshes: Vec<Id>,
    shaders: Vec<Id>,
    materials: Vec<Id>,
    multimeshes: Vec<Id>,
    particles: Vec<Id>,
}

impl Dirty {
    fn clear(&mut self) {
        self.canvases.clear();
        self.items.clear();
        self.textures.clear();
        self.meshes.clear();
        self.shaders.clear();
        self.materials.clear();
        self.multimeshes.clear();
        self.particles.clear();
    }
}

/// Ids a transaction removed (a patch's removed lists, or a full transaction's dropped ids).
#[derive(Default)]
struct Removed {
    canvases: Vec<Id>,
    items: Vec<Id>,
    textures: Vec<Id>,
    meshes: Vec<Id>,
    shaders: Vec<Id>,
    materials: Vec<Id>,
    multimeshes: Vec<Id>,
    particles: Vec<Id>,
}

impl Removed {
    fn clear(&mut self) {
        self.canvases.clear();
        self.items.clear();
        self.textures.clear();
        self.meshes.clear();
        self.shaders.clear();
        self.materials.clear();
        self.multimeshes.clear();
        self.particles.clear();
    }
}

enum Undo {
    Canvas(Id, Option<Canvas>),
    /// The previous item, and whether its commands moved into the new entry.
    Item(Id, Option<Item>, bool),
    Texture(Id, Option<Texture>),
    Mesh(Id, Option<Mesh>),
    Shader(Id, Option<Shader>),
    Material(Id, Option<Material>),
    Multimesh(Id, Option<Multimesh>),
    Particles(Id, Option<Particles>),
}

/// A resource payload's decoded shape, for `resource-payload`.
#[derive(Clone, Debug)]
enum Carried {
    Texture {
        format: String,
        width: i64,
        height: i64,
        mipmaps: bool,
        len: i64,
    },
    Mesh {
        primitive: Primitive,
        format: i64,
        vertex_count: i64,
        index_count: i64,
        len: i64,
    },
    Shader {
        len: i64,
    },
    /// /9: a `render-stream-texture/ktx2` payload (a delivery variant).
    Ktx2 {
        shape: payload::Ktx2Payload,
        len: i64,
    },
}

impl Carried {
    fn len(&self) -> i64 {
        match self {
            Carried::Texture { len, .. }
            | Carried::Mesh { len, .. }
            | Carried::Shader { len }
            | Carried::Ktx2 { len, .. } => *len,
        }
    }
}

/// /11: how often the resolved state names a hash (render-stream-11.md "Definitions"): `all`
/// counts names(S), `required` the non-variant names with `payload_bytes <= inline_max_bytes`.
#[derive(Clone, Copy, Default, Debug)]
struct NameRc {
    all: i64,
    required: i64,
}

/// One /11 dynamic mesh surface's body in the last accepted transaction record: bytes
/// `start..start + len` of the record `accept` was given (inside its `mesh_u8` block).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct BodyRef {
    pub mesh: Id,
    pub surface: u32,
    pub start: usize,
    pub len: usize,
}

/// Calls `f(hash, required)` for each name a table entry contributes to names(S): an `ok` image
/// texture's hash (required when inline-sized) and each variant's (never required).
fn texture_names(t: &Texture, inline_max: i64, f: &mut impl FnMut(Hash, bool)) {
    if t.kind != TextureKind::Image || t.status != EntryStatus::Ok {
        return;
    }
    if let Some(h) = t.hash {
        f(h, t.payload_bytes <= inline_max);
    }
    for v in &t.variants {
        f(v.hash, false);
    }
}

/// An `ok` mesh's static surfaces (a dynamic surface has no hash and no name).
fn mesh_names(m: &Mesh, inline_max: i64, f: &mut impl FnMut(Hash, bool)) {
    if m.status != EntryStatus::Ok {
        return;
    }
    for s in &m.surfaces {
        if let Some(h) = s.hash {
            f(h, s.payload_bytes <= inline_max);
        }
    }
}

/// An `ok` shader whose source is `payload`.
fn shader_names(s: &Shader, inline_max: i64, f: &mut impl FnMut(Hash, bool)) {
    if s.status != EntryStatus::Ok || s.source != Some(ShaderSource::Payload) {
        return;
    }
    if let Some(h) = s.hash {
        f(h, s.payload_bytes <= inline_max);
    }
}

/// names(S) in **table order** (render-stream-11.md decision 2): textures by id (each texture's
/// `hash`, then its variants in list order), then meshes by id (static surfaces in order), then
/// shaders by id, each hash at its first occurrence. The records a /11 host sends before a target
/// T on a connection whose previous transaction was B are this list of T minus inline(B).
pub fn names_in_table_order(st: &ResolvedState) -> Vec<Hash> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut add = |h: Hash, _: bool| {
        if seen.insert(h) {
            out.push(h);
        }
    };
    for t in st.textures.values() {
        texture_names(t, 0, &mut add);
    }
    for m in st.meshes.values() {
        mesh_names(m, 0, &mut add);
    }
    for s in st.shaders.values() {
        shader_names(s, 0, &mut add);
    }
    out
}

/// /11 (PM1): one multimesh buffer in the last accepted transaction record: `floats` f32s
/// (`instances × stride`, little-endian) from byte `start` of the record `accept` was given
/// (inside its `mm_f32` block), for an entry with a non-null `buffer_f`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct MmBufferRef {
    pub multimesh: Id,
    pub start: usize,
    pub floats: usize,
}

impl MmBufferRef {
    /// The buffer's bytes in `record` (the record given to `accept`).
    pub fn bytes<'r>(&self, record: &'r [u8]) -> &'r [u8] {
        &record[self.start..self.start + 4 * self.floats]
    }
}

/// The JSON fields of a multimesh entry other than its two offsets (rule 9's "any JSON value"),
/// for `multimesh-version`'s pre-resolve half.
fn mm_fields_equal(a: &Multimesh, b: &meta::MultimeshMeta) -> bool {
    a.origin == b.origin
        && a.status == b.status
        && a.reason == b.reason
        && a.mesh == b.mesh
        && a.format == b.format
        && a.colors == b.colors
        && a.custom == b.custom
        && a.instances == b.instances
        && a.visible == b.visible
}

fn mm_floats_equal(a: &Multimesh, b: &Multimesh) -> bool {
    let aabb = match (&a.custom_aabb, &b.custom_aabb) {
        (Some(x), Some(y)) => bits_eq(x, y),
        (None, None) => true,
        _ => false,
    };
    aabb && a.buffer_sha256 == b.buffer_sha256
}

/// /12: the JSON fields of a particles entry other than `f` (render-stream-12.md "`version`"),
/// for `particles-version`'s pre-resolve half.
fn pt_fields_equal(a: &Particles, b: &meta::ParticlesMeta) -> bool {
    a.origin == b.origin
        && a.status == b.status
        && a.reason == b.reason
        && a.mode == b.mode
        && a.emitting == b.emitting
        && a.amount == b.amount
        && a.one_shot == b.one_shot
        && a.fixed_fps == b.fixed_fps
        && a.interpolate == b.interpolate
        && a.fractional_delta == b.fractional_delta
        && a.local == b.local
        && a.draw_order == b.draw_order
        && a.transform_align == b.transform_align
        && a.trails == b.trails
        && a.trail_poses == b.trail_poses
        && a.seed == b.seed
        && a.restarts == b.restarts
        && a.emits == b.emits
        && a.process_requests == b.process_requests
        && a.process_material == b.process_material
        && a.draw_passes == b.draw_passes
        && a.subemitter == b.subemitter
}

/// /12: the floats' half (by bit pattern; `None` only on `freed`).
fn pt_floats_equal(a: &Particles, b: &Particles) -> bool {
    match (&a.floats, &b.floats) {
        (Some(x), Some(y)) => x.bits_eq(y),
        (None, None) => true,
        _ => false,
    }
}

fn same_shape(a: &MeshSurface, b: &MeshSurface) -> bool {
    a.primitive == b.primitive
        && a.format == b.format
        && a.vertex_count == b.vertex_count
        && a.index_count == b.index_count
}

// ------------------------------------------------------------------------------------- validator

pub struct Validator {
    opts: Options,
    /// W11c receiver sabotage `no-prune` ([`Validator::set_no_prune`]).
    no_prune: bool,
    /// PH2 sabotage `ph2-skip-body-digest` ([`Validator::set_skip_body_digests`]): a dynamic mesh
    /// body gets no digest, so a changed body resolves equal to the old one. It shows that the
    /// body digests are state identity, which [`DigestPolicy::Never`] must keep.
    skip_body_digests: bool,
    /// W11d: the transport skipped transactions since the last accepted one
    /// ([`Validator::transport_skip`]); cleared by the full transaction that ends it.
    skipping: bool,
    /// W11d: the transactions skipped so far (the seq gaps transport skips ended), which the end
    /// record's count includes.
    skipped_tx: i64,
    session: Session,
    snap_declared: bool,
    state: ResolvedState,
    delta: TxDelta,
    idx: Index,
    bytes_total: u64,
    max_record_bytes: u64,
    tx_count: i64,
    full_count: i64,
    patch_count: i64,
    resource_records: i64,
    resource_bytes: i64,
    prev_seq: i64,
    prev_frame: Option<i64>,
    /// canvas, item, texture, mesh, shader, material
    max_id: [i64; 6],
    carried: HashMap<Hash, Carried>,
    /// P3-SP: the last accepted resource record's verified payload. Every caller takes it right
    /// after `accept` returns `Accepted::Resource` (into its own store), so the validator keeps one
    /// payload, not every inline payload of the stream (which grew with the session: every mesh
    /// pose of a game's animation).
    last_inline: Option<(Hash, Vec<u8>)>,
    last_texture: FastMap<Id, Texture>,
    last_mesh: FastMap<Id, Mesh>,
    last_shader: FastMap<Id, Shader>,
    last_material: FastMap<Id, Material>,
    /// /11: each multimesh's resolved entry the last time a transaction carried it.
    last_multimesh: FastMap<Id, Multimesh>,
    /// /12: each particles entry's resolved entry the last time a transaction carried it.
    last_particles: FastMap<Id, Particles>,
    end_seen: bool,
    digests: Vec<Option<Hash>>,
    // per-record scratch
    bufs: DecodeBufs,
    tx: TxMeta,
    undo: Vec<Undo>,
    /// Recycled item buffers (replaced entries, after commit).
    item_pool: Vec<Item>,
    /// PH2: recycled material buffers (replaced entries after commit, and unchanged rebuilds), so
    /// a material whose parameters change every transaction resolves without reallocating them.
    material_pool: Vec<Material>,
    old_defaults: (Filter, Repeat),
    /// P3-TM: the transaction's `shader_time` value, read in `apply`, committed with it.
    shader_time: Option<f64>,
    dirty: Dirty,
    removed: Removed,
    /// Per tx entry: it was absent from the previous state (canvases, items, textures, meshes,
    /// shaders, materials).
    was_new: [Vec<bool>; 6],
    // ---- /11 (render-stream-11.md "Resource retention"); empty below /11.
    /// Reference counts of names(S) for the newest accepted state, updated from each delta.
    names: HashMap<Hash, NameRc>,
    /// The resource records accepted since the previous transaction (`resource-unnamed`).
    since_tx: Vec<Hash>,
    /// Scratch: the current transaction's change to `names`, from its undo log.
    names_delta: HashMap<Hash, NameRc>,
    /// The hashes the last transaction pruned out of C, ascending.
    pruned: Vec<Hash>,
    /// The hashes that left names(S) at the last transaction (so left C ∪ names(S)), ascending.
    released: Vec<Hash>,
    /// The last transaction's dynamic mesh bodies, in entry and surface order.
    bodies: Vec<BodyRef>,
    /// PM1: the last transaction's multimesh buffers, in entry order.
    mm_buffers: Vec<MmBufferRef>,
    /// PM1 rule 8: the session's `features.ops` lists `add_multimesh`.
    mm_op_declared: bool,
    /// PM5: the last transaction's `particle_emits`, in list order, with their floats.
    pt_emits: Vec<ParticleEmit>,
    /// render-stream-12.md "Session record": the session's `features.ops` lists `add_particles`.
    pt_op_declared: bool,
    /// `content-version-stable` (WB): the first patch item whose commands equal the base's under
    /// a moved `content_version`, found while resolving.
    cv_stable: Option<Id>,
    // ---- /13 (render-stream-13.md "As built (W13a)"); unused below /13.
    /// The prediction history (H1, H2), advanced by each accepted transaction.
    history: crate::predict::History,
    pred_scratch: crate::predict::Scratch,
    /// The last accepted record is a /13 transaction whose /12 record
    /// ([`Validator::plain_record`]) the prediction history holds.
    plain_ok: bool,
    // ---- TAG1 (client-extensions-design.md §2.4); empty unless the stream has item_meta records.
    /// The identity table as of the newest accepted transaction.
    item_meta: ItemMetaTable,
    /// The accepted `item_meta` record awaiting its transaction.
    item_meta_pending: Option<Box<ItemMetaRecord>>,
}

fn where_(seq: i64) -> String {
    format!("transaction seq {seq}")
}

/// statesEqual's number comparison: both rounded to float32, then compared as JSON text (so
/// -0 == 0 and every non-finite value prints `null`).
#[inline]
fn fround_eq(a: f64, b: f64) -> bool {
    let (x, y) = (a as f32, b as f32);
    x == y || (!x.is_finite() && !y.is_finite())
}
#[inline]
fn ieq(a: i64, b: i64) -> bool {
    a == b || fround_eq(a as f64, b as f64)
}
fn feq(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(&x, &y)| fround_eq(x as f64, y as f64))
}

fn texture_states_equal(a: &Texture, b: &Texture) -> bool {
    texture_core_equal(a, b) && variants_equal(&a.variants, &b.variants)
}

fn variant_equal(x: &TextureVariant, y: &TextureVariant) -> bool {
    x.encoding == y.encoding
        && x.hash == y.hash
        && ieq(x.payload_bytes, y.payload_bytes)
        && x.format == y.format
        && x.params == y.params
}

fn variants_equal(a: &[TextureVariant], b: &[TextureVariant]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| variant_equal(x, y))
}

/// render-stream-9.md (texture-delivery-design.md D6): at an equal version `variants` may grow --
/// every earlier variant stays identical and more may appear -- and nothing else changes.
fn variants_only_grew(prev: &Texture, cur: &Texture) -> bool {
    prev.status != EntryStatus::Freed
        && cur.status != EntryStatus::Freed
        && texture_core_equal(prev, cur)
        && prev.variants.iter().all(|p| {
            cur.variants
                .iter()
                .any(|c| c.encoding == p.encoding && variant_equal(p, c))
        })
}

/// Everything in a texture entry but its `variants`.
fn texture_core_equal(a: &Texture, b: &Texture) -> bool {
    ieq(a.id as i64, b.id as i64)
        && a.origin == b.origin
        && a.adopted_content == b.adopted_content
        && a.source_format == b.source_format
        && a.kind == b.kind
        && a.status == b.status
        && a.reason == b.reason
        && ieq(a.version, b.version)
        && a.hash == b.hash
        && a.format == b.format
        && ieq(a.width, b.width)
        && ieq(a.height, b.height)
        && a.mipmaps == b.mipmaps
        && ieq(a.payload_bytes, b.payload_bytes)
        && match (&a.canvas, &b.canvas) {
            (None, None) => true,
            (Some(x), Some(y)) => {
                x.filter == y.filter
                    && x.repeat == y.repeat
                    && match (x.diffuse, y.diffuse) {
                        (None, None) => true,
                        (Some(p), Some(q)) => ieq(p as i64, q as i64),
                        _ => false,
                    }
            }
            _ => false,
        }
}

fn mesh_states_equal(a: &Mesh, b: &Mesh) -> bool {
    ieq(a.id as i64, b.id as i64)
        && a.origin == b.origin
        && a.adopted_content == b.adopted_content
        && a.status == b.status
        && a.reason == b.reason
        && ieq(a.version, b.version)
        && feq(&a.custom_aabb, &b.custom_aabb)
        && a.surfaces.len() == b.surfaces.len()
        && a.surfaces.iter().zip(&b.surfaces).all(|(x, y)| {
            x.hash == y.hash
                && x.body_sha256 == y.body_sha256
                && ieq(x.payload_bytes, y.payload_bytes)
                && x.primitive == y.primitive
                && ieq(x.format, y.format)
                && ieq(x.vertex_count, y.vertex_count)
                && ieq(x.index_count, y.index_count)
        })
}

fn opt_id_eq(a: Option<Id>, b: Option<Id>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => ieq(x as i64, y as i64),
        _ => false,
    }
}

fn shader_states_equal(a: &Shader, b: &Shader) -> bool {
    ieq(a.id as i64, b.id as i64)
        && a.origin == b.origin
        && a.status == b.status
        && a.reason == b.reason
        && ieq(a.version, b.version)
        && a.mode == b.mode
        && a.source == b.source
        && a.hash == b.hash
        && ieq(a.payload_bytes, b.payload_bytes)
        && a.builtin == b.builtin
        && a.uses == b.uses
        && a.default_textures.len() == b.default_textures.len()
        && a.default_textures
            .iter()
            .zip(&b.default_textures)
            .all(|(x, y)| {
                x.name == y.name && ieq(x.index, y.index) && ieq(x.tex as i64, y.tex as i64)
            })
}

fn param_value_eq(a: &ParamValue, b: &ParamValue) -> bool {
    let fe = |x: &[f64], y: &[f64]| {
        x.len() == y.len() && x.iter().zip(y).all(|(&p, &q)| fround_eq(p, q))
    };
    match (a, b) {
        (ParamValue::Nil, ParamValue::Nil) => true,
        (ParamValue::Tex(x), ParamValue::Tex(y)) => ieq(*x as i64, *y as i64),
        (ParamValue::Scalar(x), ParamValue::Scalar(y)) => fround_eq(*x, *y),
        (ParamValue::Flat(x), ParamValue::Flat(y)) => fe(x, y),
        (
            ParamValue::Nested {
                components: c,
                values: x,
            },
            ParamValue::Nested {
                components: d,
                values: y,
            },
        ) => c == d && fe(x, y),
        // A non-finite scalar and a nil both print `null`.
        (ParamValue::Nil, ParamValue::Scalar(x)) | (ParamValue::Scalar(x), ParamValue::Nil) => {
            !(*x as f32).is_finite()
        }
        _ => false,
    }
}

fn material_states_equal(a: &Material, b: &Material) -> bool {
    ieq(a.id as i64, b.id as i64)
        && a.origin == b.origin
        && a.status == b.status
        && a.reason == b.reason
        && ieq(a.version, b.version)
        && opt_id_eq(a.shader, b.shader)
        && a.params.len() == b.params.len()
        && a.params
            .iter()
            .zip(&b.params)
            .all(|(x, y)| x.name == y.name && x.ty == y.ty && param_value_eq(&x.value, &y.value))
}

/// `textureEntryFieldErrors`.
fn texture_entry_error(t: &Texture) -> Option<&'static str> {
    use EntryStatus::*;
    use TextureKind::*;
    let blank = t.hash.is_none()
        && t.format.is_none()
        && t.width == 0
        && t.height == 0
        && !t.mipmaps
        && t.payload_bytes == 0;
    if t.status == Freed {
        if !blank || t.canvas.is_some() || t.reason.is_some() {
            return Some("a \"freed\" entry must have hash/format/canvas/reason null and width/height/payload_bytes 0, mipmaps false");
        }
        return None;
    }
    match t.kind {
        Image => {
            if t.canvas.is_some() {
                return Some("kind \"image\" must have canvas null");
            }
            if t.status == Ok {
                if t.hash.is_none()
                    || t.format.is_none()
                    || t.width < 1
                    || t.height < 1
                    || t.payload_bytes < 1
                    || t.reason.is_some()
                {
                    return Some("kind \"image\" status \"ok\" needs a hex hash, a format, width/height >= 1, payload_bytes >= 1 and reason null");
                }
            } else if t.hash.is_some() || t.payload_bytes != 0 || t.reason.is_none() {
                return Some("kind \"image\" status \"unsupported\" needs hash null, payload_bytes 0 and a non-null reason");
            }
            None
        }
        Placeholder => {
            if !blank || t.canvas.is_some() {
                return Some("kind \"placeholder\" must have hash/format/canvas null and width/height/payload_bytes 0, mipmaps false");
            }
            if t.status == Ok && t.reason.is_some() {
                return Some("kind \"placeholder\" status \"ok\" must have reason null");
            }
            if t.status == Unsupported && t.reason.is_none() {
                return Some(
                    "kind \"placeholder\" status \"unsupported\" must have a non-null reason",
                );
            }
            None
        }
        Canvas => {
            if !blank || t.canvas.is_none() {
                return Some("kind \"canvas\" must have hash/format null, width/height/payload_bytes 0, mipmaps false, and a non-null canvas");
            }
            if t.status == Ok && t.reason.is_some() {
                return Some("kind \"canvas\" status \"ok\" must have reason null");
            }
            if t.status == Unsupported && t.reason.is_none() {
                return Some("kind \"canvas\" status \"unsupported\" must have a non-null reason");
            }
            None
        }
    }
}

/// `meshEntryFieldErrors`.
fn mesh_entry_error(m: &Mesh) -> Option<&'static str> {
    match m.status {
        EntryStatus::Freed => (m.reason.is_some() || !m.surfaces.is_empty())
            .then_some("a \"freed\" entry must have reason null and surfaces []"),
        EntryStatus::Unsupported => (m.reason.is_none() || !m.surfaces.is_empty())
            .then_some("an \"unsupported\" entry needs a non-null reason and surfaces []"),
        EntryStatus::Ok => m
            .reason
            .is_some()
            .then_some("an \"ok\" entry must have reason null"),
    }
}

/// PH2: the dynamic mesh body and multimesh buffer digests under [`DigestPolicy::Never`]. They
/// are state identity only (no-op detection, `mesh-version`, `multimesh-version`): compared with
/// each other, never with a host's hash, and never written out by a client. So a 256-bit identity
/// far cheaper than SHA-256 in wasm serves: two XXH64 lanes seeded apart, the length, and a tag
/// (a different value from the SHA-256 of the same bytes, so the two never mix).
fn fast_identity(bytes: &[u8]) -> Hash {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&crate::coding::xxh64(bytes, 0).to_le_bytes());
    out[8..16].copy_from_slice(&crate::coding::xxh64(bytes, 0x9e37_79b9_7f4a_7c15).to_le_bytes());
    out[16..24].copy_from_slice(&(bytes.len() as u64).to_le_bytes());
    out[24..].copy_from_slice(b"ph2-xxh\0");
    Hash(out)
}

/// PH2: `*dst = src.iter().map(|p| lift_param(p, f64b)).collect()`, reusing `dst`'s parameter
/// list, each name that is already the same, and each packed value's floats.
fn lift_params_into(dst: &mut Vec<Param>, src: &[meta::ParamMeta], f64b: F64s) {
    dst.truncate(src.len());
    for (d, p) in dst.iter_mut().zip(src) {
        if d.name != p.name {
            d.name = p.name.clone();
        }
        d.ty = p.ty;
        lift_value_into(&mut d.value, p, f64b);
    }
    for p in &src[dst.len()..] {
        dst.push(lift_param(p, f64b));
    }
}

/// [`lift_param`]'s value, into `dst` (reusing its floats when it holds a vector).
fn lift_value_into(dst: &mut ParamValue, p: &meta::ParamMeta, f64b: F64s) {
    let comps = p.ty.components() as usize;
    let f = p.f as usize;
    let fill = |v: &mut Vec<f64>, n: usize| {
        v.clear();
        v.extend((f..f + n).map(|i| f64b.get(i)));
    };
    match p.ty {
        VariantType::Nil => *dst = ParamValue::Nil,
        VariantType::Rid => *dst = ParamValue::Tex(p.tex.unwrap_or(0)),
        t if t.is_packed() => {
            let n = p.n as usize * comps;
            let mut flat = match std::mem::replace(dst, ParamValue::Nil) {
                ParamValue::Flat(v) | ParamValue::Nested { values: v, .. } => v,
                _ => Vec::new(),
            };
            fill(&mut flat, n);
            *dst = if comps == 1 {
                ParamValue::Flat(flat)
            } else {
                ParamValue::Nested {
                    components: comps as u32,
                    values: flat,
                }
            };
        }
        _ => {
            if comps == 1 {
                *dst = ParamValue::Scalar(f64b.get(f));
            } else {
                let mut flat = match std::mem::replace(dst, ParamValue::Nil) {
                    ParamValue::Flat(v) | ParamValue::Nested { values: v, .. } => v,
                    _ => Vec::new(),
                };
                fill(&mut flat, comps);
                *dst = ParamValue::Flat(flat);
            }
        }
    }
}

fn lift_param(p: &meta::ParamMeta, f64b: F64s) -> Param {
    let comps = p.ty.components() as usize;
    let f = p.f as usize;
    let value = match p.ty {
        VariantType::Nil => ParamValue::Nil,
        VariantType::Rid => ParamValue::Tex(p.tex.unwrap_or(0)),
        t if t.is_packed() => {
            let n = p.n as usize * comps;
            let flat: Vec<f64> = (f..f + n).map(|i| f64b.get(i)).collect();
            if comps == 1 {
                ParamValue::Flat(flat)
            } else {
                ParamValue::Nested {
                    components: comps as u32,
                    values: flat,
                }
            }
        }
        _ => {
            if comps == 1 {
                ParamValue::Scalar(f64b.get(f))
            } else {
                ParamValue::Flat((f..f + comps).map(|i| f64b.get(i)).collect())
            }
        }
    };
    Param {
        name: p.name.clone(),
        ty: p.ty,
        value,
    }
}

/// `liftCommand` for one item's commands, into `out`.
fn lift_commands(cmds: &[CmdMeta], fb: F32s, ib: I32s, out: &mut Commands) {
    out.list.clear();
    out.f32s.clear();
    out.i32s.clear();
    out.list.reserve(cmds.len());
    for c in cmds {
        let f = c.f as usize;
        let span = |out: &mut Commands, at: usize, elems: u64, width: usize| -> Span {
            let start = out.f32s.len() as u32;
            fb.extend_into(at, elems as usize * width, &mut out.f32s);
            Span {
                start,
                len: elems as u32,
            }
        };
        let cmd = match c.op {
            Op::Rect => Command::Rect {
                aa: c.b1,
                rect: fb.arr(f),
                color: fb.arr(f + 4),
            },
            Op::TextureRect => Command::TextureRect {
                tex: c.tex,
                tile: c.b1,
                transpose: c.b2,
                rect: fb.arr(f),
                modulate: fb.arr(f + 4),
            },
            Op::TextureRectRegion => Command::TextureRectRegion {
                tex: c.tex,
                transpose: c.b1,
                clip_uv: c.b2,
                rect: fb.arr(f),
                src: fb.arr(f + 4),
                modulate: fb.arr(f + 8),
            },
            Op::Msdf => Command::MsdfTextureRectRegion {
                tex: c.tex,
                outline: c.outline,
                rect: fb.arr(f),
                src: fb.arr(f + 4),
                modulate: fb.arr(f + 8),
                px_range: fb.get(f + 12),
                scale: fb.get(f + 13),
            },
            Op::Line => Command::Line {
                aa: c.b1,
                from: fb.arr(f),
                to: fb.arr(f + 2),
                colour: fb.arr(f + 4),
                width: fb.get(f + 8),
            },
            Op::Polyline | Op::Multiline => {
                let width = fb.get(f);
                let points = span(out, f + 1, c.n, 2);
                let colors = span(out, f + 1 + 2 * c.n as usize, c.colors, 4);
                if c.op == Op::Polyline {
                    Command::Polyline {
                        aa: c.b1,
                        width,
                        points,
                        colors,
                    }
                } else {
                    Command::Multiline {
                        aa: c.b1,
                        width,
                        points,
                        colors,
                    }
                }
            }
            Op::Circle => Command::Circle {
                aa: c.b1,
                position: fb.arr(f),
                radius: fb.get(f + 2),
                colour: fb.arr(f + 3),
            },
            Op::Primitive | Op::Polygon | Op::TriangleArray => {
                let points = span(out, f, c.n, 2);
                let at = f + 2 * c.n as usize;
                let colors = span(out, at, c.colors, 4);
                let uvs = span(out, at + 4 * c.colors as usize, c.uvs, 2);
                match c.op {
                    Op::Primitive => Command::Primitive {
                        tex: c.tex,
                        points,
                        colors,
                        uvs,
                    },
                    Op::Polygon => Command::Polygon {
                        tex: c.tex,
                        points,
                        colors,
                        uvs,
                    },
                    _ => {
                        let start = out.i32s.len() as u32;
                        ib.extend_into(c.i as usize, c.indices as usize, &mut out.i32s);
                        let indices = Span {
                            start,
                            len: c.indices as u32,
                        };
                        Command::TriangleArray {
                            tex: c.tex,
                            count: c.count,
                            points,
                            colors,
                            uvs,
                            indices,
                        }
                    }
                }
            }
            Op::NinePatch => Command::NinePatch {
                tex: c.tex,
                rect: fb.arr(f),
                source: fb.arr(f + 4),
                margins: fb.arr(f + 8),
                x_axis: c.x_axis,
                y_axis: c.y_axis,
                draw_center: c.b1,
                modulate: fb.arr(f + 12),
            },
            Op::Mesh => Command::Mesh {
                mesh: c.mesh,
                tex: c.tex,
                transform: fb.arr(f),
                modulate: fb.arr(f + 6),
            },
            Op::SetTransform => Command::SetTransform {
                transform: fb.arr(f),
            },
            Op::ClipIgnore => Command::ClipIgnore { ignore: c.b1 },
            Op::Multimesh => Command::Multimesh {
                multimesh: c.mesh,
                tex: c.tex,
            },
            Op::Particles => Command::Particles {
                particles: c.mesh,
                tex: c.tex,
            },
            Op::Unsupported => Command::Unsupported {
                name: c.name.clone().unwrap_or_default(),
                reason: c.reason,
            },
        };
        out.list.push(cmd);
    }
}

fn walk_eff(st: &ResolvedState, id: Id) -> Option<Id> {
    let mut cur = id;
    let limit = st.items.len() + 1;
    for _ in 0..limit {
        let it = st.items.get(&cur)?;
        if !it.use_parent_material {
            return it.material;
        }
        match it.parent {
            Some(Parent {
                kind: ParentKind::Item,
                id: p,
            }) if st.items.contains_key(&p) => cur = p,
            _ => return it.material,
        }
    }
    st.items.get(&cur).and_then(|i| i.material)
}

fn compute_u(st: &ResolvedState, id: Id) -> bool {
    let Some(t) = st.textures.get(&id) else {
        return false;
    };
    if t.status == EntryStatus::Unsupported {
        return true;
    }
    t.kind == TextureKind::Canvas
        && t.canvas
            .as_ref()
            .and_then(|c| c.diffuse)
            .and_then(|d| st.textures.get(&d))
            .is_some_and(|d| d.status == EntryStatus::Unsupported)
}

fn tex_unsupported(st: &ResolvedState, id: Id) -> bool {
    st.textures
        .get(&id)
        .is_some_and(|t| t.status == EntryStatus::Unsupported)
}

fn compute_mat_unsup(st: &ResolvedState, id: Id) -> bool {
    let Some(m) = st.materials.get(&id) else {
        return false;
    };
    let mut unsup = m.status == EntryStatus::Unsupported;
    if !unsup {
        if let Some(s) = m.shader.and_then(|s| st.shaders.get(&s)) {
            if s.status == EntryStatus::Unsupported {
                unsup = true;
            }
            if s.default_textures
                .iter()
                .any(|d| tex_unsupported(st, d.tex))
            {
                unsup = true;
            }
        }
    }
    unsup
        || m.params.iter().any(|p| {
            p.ty == VariantType::Rid
                && matches!(p.value, ParamValue::Tex(t) if tex_unsupported(st, t))
        })
}

// ------------------------------------------------------------------------------------- identity

/// Float arrays equal bit for bit (so -0 differs from 0, and a NaN equals only its own bits).
#[inline]
fn bits_eq(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

#[inline]
fn bit_eq(a: f32, b: f32) -> bool {
    a.to_bits() == b.to_bits()
}

pub(crate) fn blank_item() -> Item {
    Item {
        id: 0,
        origin: Origin::Created,
        parent: None,
        children: Vec::new(),
        visible: false,
        draw_index: 0,
        z_index: 0,
        z_relative: false,
        behind: false,
        clip: false,
        custom_rect: false,
        visibility_layer: 0,
        texture_filter: Filter::Default,
        texture_repeat: Repeat::Default,
        material: None,
        use_parent_material: false,
        instance_params: Vec::new(),
        canvas_group: None,
        copy_to_backbuffer: None,
        use_identity_transform: false,
        content_version: 0,
        xform: [0.0; 6],
        modulate: [0.0; 4],
        self_modulate: [0.0; 4],
        custom_rect_rect: [0.0; 4],
        commands: Commands::default(),
    }
}

fn params_identical(a: &[Param], b: &[Param]) -> bool {
    let f = |x: &[f64], y: &[f64]| {
        x.len() == y.len() && x.iter().zip(y).all(|(p, q)| p.to_bits() == q.to_bits())
    };
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            x.name == y.name
                && x.ty == y.ty
                && match (&x.value, &y.value) {
                    (ParamValue::Nil, ParamValue::Nil) => true,
                    (ParamValue::Tex(p), ParamValue::Tex(q)) => p == q,
                    (ParamValue::Scalar(p), ParamValue::Scalar(q)) => p.to_bits() == q.to_bits(),
                    (ParamValue::Flat(p), ParamValue::Flat(q)) => f(p, q),
                    (
                        ParamValue::Nested {
                            components: c,
                            values: p,
                        },
                        ParamValue::Nested {
                            components: e,
                            values: q,
                        },
                    ) => c == e && f(p, q),
                    _ => false,
                }
        })
}

fn material_identical(a: &Material, b: &Material) -> bool {
    a.id == b.id
        && a.origin == b.origin
        && a.status == b.status
        && a.reason == b.reason
        && a.version == b.version
        && a.shader == b.shader
        && params_identical(&a.params, &b.params)
}

/// Every item field but `commands`, bit for bit.
fn item_head_identical(a: &Item, b: &Item) -> bool {
    a.id == b.id
        && a.origin == b.origin
        && a.parent == b.parent
        && a.children == b.children
        && a.visible == b.visible
        && a.draw_index == b.draw_index
        && a.z_index == b.z_index
        && a.z_relative == b.z_relative
        && a.behind == b.behind
        && a.clip == b.clip
        && a.custom_rect == b.custom_rect
        && a.visibility_layer == b.visibility_layer
        && a.texture_filter == b.texture_filter
        && a.texture_repeat == b.texture_repeat
        && a.material == b.material
        && a.use_parent_material == b.use_parent_material
        && a.content_version == b.content_version
        && bits_eq(&a.xform, &b.xform)
        && bits_eq(&a.modulate, &b.modulate)
        && bits_eq(&a.self_modulate, &b.self_modulate)
        && bits_eq(&a.custom_rect_rect, &b.custom_rect_rect)
        && params_identical(&a.instance_params, &b.instance_params)
        && canvas_group_identical(&a.canvas_group, &b.canvas_group)
        && a.use_identity_transform == b.use_identity_transform
        && match (&a.copy_to_backbuffer, &b.copy_to_backbuffer) {
            (None, None) => true,
            (Some(x), Some(y)) => bits_eq(x, y),
            _ => false,
        }
}

fn canvas_group_identical(a: &Option<CanvasGroup>, b: &Option<CanvasGroup>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => {
            x.mode == y.mode
                && bit_eq(x.clear_margin, y.clear_margin)
                && x.fit_empty == y.fit_empty
                && bit_eq(x.fit_margin, y.fit_margin)
                && x.blur_mipmaps == y.blur_mipmaps
        }
        _ => false,
    }
}

fn command_identical(x: &Command, y: &Command) -> bool {
    use Command as C;
    match (x, y) {
        (
            C::Rect { aa, rect, color },
            C::Rect {
                aa: a2,
                rect: r2,
                color: c2,
            },
        ) => aa == a2 && bits_eq(rect, r2) && bits_eq(color, c2),
        (
            C::TextureRect {
                tex,
                tile,
                transpose,
                rect,
                modulate,
            },
            C::TextureRect {
                tex: t2,
                tile: i2,
                transpose: p2,
                rect: r2,
                modulate: m2,
            },
        ) => {
            tex == t2 && tile == i2 && transpose == p2 && bits_eq(rect, r2) && bits_eq(modulate, m2)
        }
        (
            C::TextureRectRegion {
                tex,
                transpose,
                clip_uv,
                rect,
                src,
                modulate,
            },
            C::TextureRectRegion {
                tex: t2,
                transpose: p2,
                clip_uv: c2,
                rect: r2,
                src: s2,
                modulate: m2,
            },
        ) => {
            tex == t2
                && transpose == p2
                && clip_uv == c2
                && bits_eq(rect, r2)
                && bits_eq(src, s2)
                && bits_eq(modulate, m2)
        }
        (
            C::MsdfTextureRectRegion {
                tex,
                outline,
                rect,
                src,
                modulate,
                px_range,
                scale,
            },
            C::MsdfTextureRectRegion {
                tex: t2,
                outline: o2,
                rect: r2,
                src: s2,
                modulate: m2,
                px_range: p2,
                scale: c2,
            },
        ) => {
            tex == t2
                && outline == o2
                && bits_eq(rect, r2)
                && bits_eq(src, s2)
                && bits_eq(modulate, m2)
                && bit_eq(*px_range, *p2)
                && bit_eq(*scale, *c2)
        }
        (
            C::Line {
                aa,
                from,
                to,
                colour,
                width,
            },
            C::Line {
                aa: a2,
                from: f2,
                to: t2,
                colour: c2,
                width: w2,
            },
        ) => {
            aa == a2
                && bits_eq(from, f2)
                && bits_eq(to, t2)
                && bits_eq(colour, c2)
                && bit_eq(*width, *w2)
        }
        (
            C::Polyline {
                aa,
                width,
                points,
                colors,
            },
            C::Polyline {
                aa: a2,
                width: w2,
                points: p2,
                colors: c2,
            },
        )
        | (
            C::Multiline {
                aa,
                width,
                points,
                colors,
            },
            C::Multiline {
                aa: a2,
                width: w2,
                points: p2,
                colors: c2,
            },
        ) => aa == a2 && bit_eq(*width, *w2) && points == p2 && colors == c2,
        (
            C::Circle {
                aa,
                position,
                radius,
                colour,
            },
            C::Circle {
                aa: a2,
                position: p2,
                radius: r2,
                colour: c2,
            },
        ) => aa == a2 && bits_eq(position, p2) && bit_eq(*radius, *r2) && bits_eq(colour, c2),
        (
            C::Primitive {
                tex,
                points,
                colors,
                uvs,
            },
            C::Primitive {
                tex: t2,
                points: p2,
                colors: c2,
                uvs: u2,
            },
        )
        | (
            C::Polygon {
                tex,
                points,
                colors,
                uvs,
            },
            C::Polygon {
                tex: t2,
                points: p2,
                colors: c2,
                uvs: u2,
            },
        ) => tex == t2 && points == p2 && colors == c2 && uvs == u2,
        (
            C::TriangleArray {
                tex,
                count,
                points,
                colors,
                uvs,
                indices,
            },
            C::TriangleArray {
                tex: t2,
                count: n2,
                points: p2,
                colors: c2,
                uvs: u2,
                indices: i2,
            },
        ) => tex == t2 && count == n2 && points == p2 && colors == c2 && uvs == u2 && indices == i2,
        (
            C::NinePatch {
                tex,
                rect,
                source,
                margins,
                x_axis,
                y_axis,
                draw_center,
                modulate,
            },
            C::NinePatch {
                tex: t2,
                rect: r2,
                source: s2,
                margins: g2,
                x_axis: x2,
                y_axis: y2,
                draw_center: d2,
                modulate: m2,
            },
        ) => {
            tex == t2
                && bits_eq(rect, r2)
                && bits_eq(source, s2)
                && bits_eq(margins, g2)
                && x_axis == x2
                && y_axis == y2
                && draw_center == d2
                && bits_eq(modulate, m2)
        }
        (
            C::Mesh {
                mesh,
                tex,
                transform,
                modulate,
            },
            C::Mesh {
                mesh: e2,
                tex: t2,
                transform: f2,
                modulate: m2,
            },
        ) => mesh == e2 && tex == t2 && bits_eq(transform, f2) && bits_eq(modulate, m2),
        (C::SetTransform { transform }, C::SetTransform { transform: t2 }) => {
            bits_eq(transform, t2)
        }
        (C::ClipIgnore { ignore }, C::ClipIgnore { ignore: i2 }) => ignore == i2,
        (
            C::Multimesh { multimesh, tex },
            C::Multimesh {
                multimesh: m2,
                tex: t2,
            },
        ) => multimesh == m2 && tex == t2,
        (
            C::Particles { particles, tex },
            C::Particles {
                particles: p2,
                tex: t2,
            },
        ) => particles == p2 && tex == t2,
        (
            C::Unsupported { name, reason },
            C::Unsupported {
                name: n2,
                reason: r2,
            },
        ) => name == n2 && reason == r2,
        _ => false,
    }
}

/// Two command lists bit for bit (spans address equal arenas, so they compare as positions).
fn commands_identical(a: &Commands, b: &Commands) -> bool {
    a.list.len() == b.list.len()
        && a.i32s == b.i32s
        && bits_eq(&a.f32s, &b.f32s)
        && a.list
            .iter()
            .zip(&b.list)
            .all(|(x, y)| command_identical(x, y))
}

impl Validator {
    /// `createRecordingValidator`'s session step: decodes the session record and checks
    /// `missing-session`, `root-canvas` and (/6) `viewport-entry`'s host-size rule.
    pub fn new(session_record: &[u8], offset: usize, opts: Options) -> Result<Validator, Error> {
        assert!(
            (2..=wire::LATEST).contains(&opts.version),
            "render-stream version 2..=13"
        );
        let mut bufs = DecodeBufs::default();
        let mut tx = TxMeta::default();
        let decoded =
            meta::decode_record(session_record, offset, opts.version, &mut bufs, &mut tx)?;
        let session = match decoded {
            Decoded::Session(s) => *s,
            other => {
                let ty = match other {
                    Decoded::Transaction => "transaction",
                    Decoded::Resource(_) => "resource",
                    Decoded::End(_) => "end",
                    Decoded::ItemMeta(_) => "item_meta",
                    Decoded::Session(_) => "session",
                };
                return Err(Error::new(
                    "missing-session",
                    format!("the first record has type \"{ty}\""),
                ));
            }
        };
        if session.viewport.root_canvas != 1 {
            return Err(Error::new(
                "root-canvas",
                format!(
                    "session.viewport.root_canvas is {}, not 1",
                    session.viewport.root_canvas
                ),
            ));
        }
        if opts.version >= 6 {
            let v = &session.viewport;
            let visible = [
                session.host_visible_rect[2] as f64,
                session.host_visible_rect[3] as f64,
            ];
            let presentation = v.presentation_size.unwrap_or(v.logical_size);
            // PRES-A (gate6-design.md "Amendment (PRES-A)"): the visible size the stretch gives
            // the presentation; the logical size unless expand/keep_width/keep_height widen it.
            let expected_visible = crate::meta::stretch_visible_size(
                &v.stretch,
                v.logical_size,
                presentation,
            );
            let visible_matches = visible == expected_visible;
            let expected = if v.host_window_size == presentation && visible_matches {
                "match"
            } else if !visible_matches {
                "degenerate-visible"
            } else {
                "degenerate-window"
            };
            if v.host_size_status != expected {
                return Err(Error::new(
                    "viewport-entry",
                    format!(
                        "session.viewport.host_size_status is \"{}\", expected \"{expected}\" from host_window_size/presentation_size/host_visible_rect",
                        v.host_size_status
                    ),
                ));
            }
        }
        let snap_declared =
            opts.version >= 6 && session.viewport.snap_2d.is_some_and(|(t, v)| t || v);
        let mm_op_declared =
            opts.version >= 11 && session.features.ops.iter().any(|o| o == "add_multimesh");
        let pt_op_declared =
            opts.version >= 12 && session.features.ops.iter().any(|o| o == "add_particles");
        let digest = match opts.digest {
            DigestPolicy::Inline => Some(wire::record_sha256(session_record)),
            DigestPolicy::Deferred | DigestPolicy::Never => None,
        };
        let version = opts.version;
        Ok(Validator {
            opts,
            no_prune: false,
            skip_body_digests: false,
            skipping: false,
            skipped_tx: 0,
            session,
            snap_declared,
            state: ResolvedState::empty(version),
            delta: TxDelta::default(),
            idx: Index::default(),
            bytes_total: (MAGIC_LEN + session_record.len()) as u64,
            max_record_bytes: session_record.len() as u64,
            tx_count: 0,
            full_count: 0,
            patch_count: 0,
            resource_records: 0,
            resource_bytes: 0,
            prev_seq: 0,
            prev_frame: None,
            max_id: [0; 6],
            carried: HashMap::new(),
            last_inline: None,
            last_texture: FastMap::default(),
            last_mesh: FastMap::default(),
            last_shader: FastMap::default(),
            last_material: FastMap::default(),
            last_multimesh: FastMap::default(),
            last_particles: FastMap::default(),
            end_seen: false,
            digests: vec![digest],
            bufs,
            tx,
            undo: Vec::new(),
            item_pool: Vec::new(),
            material_pool: Vec::new(),
            old_defaults: (Filter::Nearest, Repeat::Disabled),
            shader_time: None,
            dirty: Dirty::default(),
            removed: Removed::default(),
            was_new: Default::default(),
            names: HashMap::new(),
            since_tx: Vec::new(),
            names_delta: HashMap::new(),
            pruned: Vec::new(),
            released: Vec::new(),
            bodies: Vec::new(),
            mm_buffers: Vec::new(),
            mm_op_declared,
            pt_emits: Vec::new(),
            pt_op_declared,
            cv_stable: None,
            history: Default::default(),
            pred_scratch: Default::default(),
            plain_ok: false,
            item_meta: ItemMetaTable::default(),
            item_meta_pending: None,
        })
    }

    pub fn options(&self) -> &Options {
        &self.opts
    }

    /// TAG1: the identity table (grant, strings, rows) as of the newest accepted transaction.
    pub fn item_meta(&self) -> &ItemMetaTable {
        &self.item_meta
    }

    /// TAG1: the accepted `item_meta` record awaiting its transaction, if any.
    pub fn item_meta_pending(&self) -> Option<&ItemMetaRecord> {
        self.item_meta_pending.as_deref()
    }

    /// TAG1: forget the `item_meta` record awaiting its transaction, for a receiver that drops
    /// that transaction unaccepted (W13c/W13d's held patches after a `predict-check` resync). A
    /// `full` record comes again before the full transaction that ends the resync.
    pub fn discard_item_meta_pending(&mut self) {
        self.item_meta_pending = None;
    }
    pub fn session(&self) -> &Session {
        &self.session
    }
    /// The resolved state after the last accepted transaction.
    pub fn state(&self) -> &ResolvedState {
        &self.state
    }
    /// What the last accepted transaction changed.
    pub fn delta(&self) -> &TxDelta {
        &self.delta
    }
    /// The verified payload of the last accepted resource record, when it carried `hash` (P3-SP:
    /// only the last one is kept; read it right after `accept` returns `Accepted::Resource`).
    pub fn inline_payload(&self, hash: &Hash) -> Option<&[u8]> {
        match &self.last_inline {
            Some((h, v)) if h == hash => Some(v.as_slice()),
            _ => None,
        }
    }
    /// D31: one digest per accepted record, session first (`None` under `Deferred` until set).
    pub fn record_digests(&self) -> &[Option<Hash>] {
        &self.digests
    }
    pub fn set_record_digest(&mut self, index: usize, h: Hash) {
        self.digests[index] = Some(h);
    }
    pub fn transactions(&self) -> i64 {
        self.tx_count
    }
    pub fn end_seen(&self) -> bool {
        self.end_seen
    }

    /// /11: the hashes the last accepted transaction pruned out of C (C ← C ∩ names(S)),
    /// ascending. Empty below /11, and after a resource or end record.
    pub fn pruned(&self) -> &[Hash] {
        &self.pruned
    }
    /// /11: the hashes that left names(S) at the last accepted transaction, ascending. Since
    /// C ⊆ names(S) after every transaction, these are exactly the hashes that left
    /// C ∪ names(S_n); a receiver's retention set H also holds names(S_d), which it keeps itself.
    /// [`Validator::pruned`] is a subset.
    pub fn released(&self) -> &[Hash] {
        &self.released
    }
    /// /11: whether `hash` is in the carried set C right now (records accepted since the last
    /// transaction included).
    pub fn is_carried(&self, hash: &Hash) -> bool {
        self.opts.version >= 11 && self.carried.contains_key(hash)
    }
    /// /11: the carried set C (unordered).
    pub fn carried(&self) -> impl Iterator<Item = &Hash> + '_ {
        self.carried.keys().filter(move |_| self.opts.version >= 11)
    }
    /// /11: |C|.
    pub fn carried_len(&self) -> usize {
        if self.opts.version >= 11 {
            self.carried.len()
        } else {
            0
        }
    }
    /// /11: whether the newest accepted state names `hash` (names(S), variants included).
    pub fn names_contains(&self, hash: &Hash) -> bool {
        self.names.contains_key(hash)
    }
    /// /11: |names(S)| of the newest accepted state.
    pub fn names_len(&self) -> usize {
        self.names.len()
    }
    /// /11: the last accepted transaction's dynamic mesh bodies (byte ranges of the record given
    /// to `accept`), for each mesh entry with a non-null `u8`, in entry then surface order.
    pub fn dynamic_bodies(&self) -> &[BodyRef] {
        &self.bodies
    }
    /// /11 (PM1): the last accepted transaction's multimesh buffers (byte ranges of the record
    /// given to `accept`), for each multimesh entry with a non-null `buffer_f`, in entry order.
    /// An `ok` entry of [`ResolvedState::multimeshes`] absent from this list kept its floats
    /// ("the floats you hold"). Empty after a resource or end record.
    pub fn multimesh_buffers(&self) -> &[MmBufferRef] {
        &self.mm_buffers
    }
    /// /12 (PM5, render-stream-12.md "Receivers"): the last accepted transaction's
    /// `particle_emits`, in list order, with their floats. A receiver applies each emitter's
    /// configuration, then a restart if `restarts` moved, then these. Empty after a resource or
    /// end record, and below /12.
    pub fn particle_emits(&self) -> &[ParticleEmit] {
        &self.pt_emits
    }

    /// /13 (render-stream-13.md "As built (W13a)"): the last accepted transaction as its /12
    /// record: the meta without `predict_check`, the three predicted blocks reconstructed. Every
    /// byte range this validator reports for that transaction ([`Validator::dynamic_bodies`],
    /// [`Validator::multimesh_buffers`]) indexes this record, not the /13 one `accept` was given,
    /// so a /13 receiver feeds it to its /12 path unchanged. `None` below /13, after a resource
    /// or end record, and after a transaction refused past its meta (like `dynamic_bodies`, it
    /// is meaningless after any failed accept).
    pub fn plain_record(&self) -> Option<&[u8]> {
        if self.plain_ok {
            self.history.plain()
        } else {
            None
        }
    }

    /// The bytes the last accepted record's block ranges index: [`Validator::plain_record`] after
    /// a /13 transaction, else `record` itself (the record given to `accept`). What a receiver
    /// passes to `DynamicMeshes::ingest` and friends at every version.
    pub fn record_view<'a>(&'a self, record: &'a [u8]) -> &'a [u8] {
        self.plain_record().unwrap_or(record)
    }

    /// /13: the prediction history (H1, H2) after the last accepted transaction.
    pub fn prediction_history(&self) -> &crate::predict::History {
        &self.history
    }

    /// render-stream-11.md decision 9, `inline-fetch-zero`: may a /11 receiver GET `hash` over
    /// HTTP now? Refused when `hash` is a non-variant name of the newest accepted state, or is in
    /// C, with `payload_bytes <= inline_max_bytes` (such a hash always arrives inline). Below /11
    /// every fetch is allowed.
    pub fn check_fetch(&self, hash: &Hash) -> Result<(), Error> {
        if self.opts.version < 11 {
            return Ok(());
        }
        let inline_max = self.session.resources.inline_max_bytes;
        let named = self.names.get(hash).is_some_and(|n| n.required > 0);
        let carried = self
            .carried
            .get(hash)
            .is_some_and(|c| c.len() <= inline_max);
        if named || carried {
            return Err(Error::new(
                "inline-fetch-zero",
                format!(
                    "hash {} is {} with payload_bytes <= inline_max_bytes {inline_max}: a /11 receiver never fetches it",
                    hash.to_hex(),
                    if named {
                        "named by the newest accepted state"
                    } else {
                        "carried"
                    }
                ),
            ));
        }
        Ok(())
    }

    /// W11c receiver sabotage `no-prune` (render-stream-11.md, the W11c row): this receiver keeps
    /// C lifelong at /11, as a /10 receiver does, so a hash that returns is refused
    /// `resource-duplicate` when the host re-carries it. names(S) and [`Validator::released`] are
    /// kept as usual; [`Validator::pruned`] stays empty.
    pub fn set_no_prune(&mut self, on: bool) {
        self.no_prune = on;
    }

    /// W13d: the /13 decoder sabotage `no-predict-reset` ([`Options::no_predict_reset`]) set after
    /// the session, as a receiver names its sabotage once the session record opened its core.
    /// Takes effect from the next transaction.
    pub fn set_no_predict_reset(&mut self, on: bool) {
        self.opts.no_predict_reset = on;
    }

    /// PH2 sabotage `ph2-skip-body-digest`: dynamic mesh bodies resolve without a digest.
    pub fn set_skip_body_digests(&mut self, on: bool) {
        self.skip_body_digests = on;
    }

    /// W11d (render-stream-11.md "As built (W11d)"): the transport skipped one or more
    /// transactions (W11t's `coding` resync: a based message whose base is missing or that does
    /// not decode, and every based one after it until the full transaction the resync forces).
    /// The records that preceded them were accepted, but the states they named never were, so
    /// until the next transaction, which must be full: its seq may jump; `resource-duplicate`
    /// does not refuse a hash already in C (the host computed its records against a skipped
    /// base, which may have pruned it); `resource-unnamed` does not apply to those records; and
    /// after it C is pruned to names(S) whole, not by the delta (a skipped record may name
    /// nothing). C is then inline(S), the host's set (L1 holds again from there). Below /11 it
    /// only allows the seq jump.
    pub fn transport_skip(&mut self) {
        self.skipping = true;
        // TAG1: a pending item_meta record described a transaction the transport skipped.
        self.item_meta_pending = None;
    }

    /// W11d: whether a transport skip awaits its full transaction.
    pub fn skipping(&self) -> bool {
        self.skipping
    }

    /// `finish()`: the end-of-stream verdict.
    pub fn finish(&self) -> Result<(), Error> {
        if self.end_seen {
            Ok(())
        } else {
            Err(Error::new(
                "recording-incomplete",
                "the recording ends without an end record",
            ))
        }
    }

    /// Validates and applies one record (`record` includes its u32 length prefix; `offset` is its
    /// place in the recording, for messages). On an error nothing changes.
    pub fn accept(&mut self, record: &[u8], offset: usize) -> Result<Accepted, Error> {
        if self.end_seen {
            return Err(Error::new(
                "trailing-bytes",
                format!("data follows the end record (record at offset {offset})"),
            ));
        }
        // TAG1: the ask and an orphan are judged from the canonical meta's prefix, before the
        // record's own schema (an unasked viewer is told `item-meta-unexpected` whatever it holds).
        if self.opts.version >= 13
            && record.len() >= 8 + item_meta::PREFIX.len()
            && wire::le_u32(record, 4) as usize >= item_meta::PREFIX.len()
            && &record[8..8 + item_meta::PREFIX.len()] == item_meta::PREFIX
        {
            self.item_meta_precheck(offset)?;
        }
        let t = prof::start();
        let decoded = meta::decode_record(
            record,
            offset,
            self.opts.version,
            &mut self.bufs,
            &mut self.tx,
        );
        prof::add(prof::META, t);
        let decoded = decoded?;
        self.plain_ok = false;
        if self.opts.version >= 11 {
            self.pruned.clear();
            self.released.clear();
            self.bodies.clear();
            self.mm_buffers.clear();
            self.pt_emits.clear();
        }
        let accepted = match decoded {
            Decoded::Session(_) => {
                return Err(Error::new(
                    "duplicate-session",
                    format!("a second session record at offset {offset}"),
                ))
            }
            Decoded::Resource(r) => {
                self.item_meta_orphan(offset, "a resource record")?;
                self.accept_resource(record, offset, r)?
            }
            Decoded::Transaction if self.opts.version >= 13 => {
                self.accept_transaction13(record, offset)?
            }
            Decoded::Transaction => self.accept_transaction(record, offset, record.len())?,
            Decoded::End(e) => {
                self.item_meta_orphan(offset, "the end record")?;
                self.accept_end(e)?
            }
            Decoded::ItemMeta(r) => self.accept_item_meta(record, offset, r)?,
        };
        let t = prof::start();
        let digest = match self.opts.digest {
            DigestPolicy::Inline => Some(wire::record_sha256(record)),
            DigestPolicy::Deferred | DigestPolicy::Never => None,
        };
        prof::add(prof::RECORD_DIGEST, t);
        self.digests.push(digest);
        Ok(accepted)
    }

    fn accept_resource(
        &mut self,
        record: &[u8],
        offset: usize,
        r: ResourceMeta,
    ) -> Result<Accepted, Error> {
        if self.carried.contains_key(&r.hash) && !self.skipping {
            // /11: "h ∈ C" (C is pruned after every transaction); /2-/10: ever carried. W11d:
            // after a transport skip the host may re-carry a hash a skipped transaction pruned.
            return Err(Error::new(
                "resource-duplicate",
                if self.opts.version >= 11 {
                    format!(
                        "record at offset {offset}: hash {} is still carried (in C)",
                        r.hash.to_hex()
                    )
                } else {
                    format!(
                        "record at offset {offset}: hash {} already carried earlier in this stream",
                        r.hash.to_hex()
                    )
                },
            ));
        }
        let b = self.bufs.blocks[0];
        let bytes = &record[b.start..b.start + b.len];
        let len = b.len as i64;
        let carried = match payload::payload_kind(bytes, self.opts.version) {
            PayloadKind::Shader => {
                payload::decode_shader(bytes)?;
                Carried::Shader { len }
            }
            PayloadKind::Mesh => {
                let m = payload::decode_mesh(bytes)?;
                Carried::Mesh {
                    primitive: m.primitive,
                    format: m.format,
                    vertex_count: m.vertex_count,
                    index_count: m.index_count,
                    len,
                }
            }
            PayloadKind::Ktx2 => Carried::Ktx2 {
                shape: payload::decode_ktx2(bytes)?,
                len,
            },
            PayloadKind::Texture => {
                let t = payload::decode_texture_v(bytes, self.opts.version)?;
                Carried::Texture {
                    format: t.format,
                    width: t.width,
                    height: t.height,
                    mipmaps: t.mipmaps,
                    len,
                }
            }
        };
        if self.opts.verify_payload_hashes {
            let actual = wire::sha256(bytes);
            if actual != r.hash {
                return Err(Error::new(
                    "resource-hash",
                    format!(
                        "record at offset {offset}: payload sha256 {} disagrees with declared hash {}",
                        actual.to_hex(),
                        r.hash.to_hex()
                    ),
                ));
            }
        }
        self.carried.insert(r.hash, carried);
        if self.opts.version >= 11 {
            self.since_tx.push(r.hash);
        }
        // P3-SP: reuse the last payload's buffer (one allocation per growth, not per record).
        let mut buf = self.last_inline.take().map(|(_, v)| v).unwrap_or_default();
        buf.clear();
        buf.extend_from_slice(bytes);
        self.last_inline = Some((r.hash, buf));
        self.resource_records += 1;
        self.resource_bytes += r.bytes;
        self.bytes_total += record.len() as u64;
        self.max_record_bytes = self.max_record_bytes.max(record.len() as u64);
        Ok(Accepted::Resource { hash: r.hash })
    }

    fn accept_end(&mut self, e: EndMeta) -> Result<Accepted, Error> {
        // /11 `resource-unnamed` (decision 6): no record may follow the last transaction.
        if let Some(h) = self.since_tx.first() {
            return Err(Error::new(
                "resource-unnamed",
                format!(
                    "the resource record for hash {} follows the last transaction (no transaction names it)",
                    h.to_hex()
                ),
            ));
        }
        // W11d: transactions a transport skip never let the validator see count too; their bytes
        // and kinds are unknown, so the end stats are not checked after one.
        if e.transactions != self.tx_count + self.skipped_tx {
            return Err(Error::new(
                "end-count-mismatch",
                format!(
                    "end record says {} transactions, but {} were seen",
                    e.transactions, self.tx_count
                ),
            ));
        }
        let s = e.stats;
        if self.skipped_tx > 0 {
            self.end_seen = true;
            return Ok(Accepted::End);
        }
        if s[0] as u64 != self.bytes_total
            || s[0] < 0
            || s[4] as u64 != self.max_record_bytes
            || s[4] < 0
            || s[5] != self.full_count
            || s[6] != self.patch_count
            || s[7] != self.resource_records
            || s[8] != self.resource_bytes
            || s[5].checked_add(s[6]) != Some(e.transactions)
        {
            return Err(Error::new(
                "end-stats-mismatch",
                "end record stats disagree with the recording",
            ));
        }
        self.end_seen = true;
        Ok(Accepted::End)
    }

    // --------------------------------------------------------------------------------- transaction

    /// /13: un-predict the three blocks against (H1, H2) into the plain /12 record,
    /// `predict-check`, then every /12 rule on that record ([`Self::accept_transaction`]), then
    /// R(T). Nothing changes on an error.
    fn accept_transaction13(&mut self, record: &[u8], offset: usize) -> Result<Accepted, Error> {
        // TAG1: one branch for a stream without item_meta records.
        if self.item_meta_pending.is_some() || self.item_meta.grant.is_some() {
            self.item_meta_form(offset)?;
        }
        let t = prof::start();
        let no_reset = self.opts.no_predict_reset;
        // W13p: the plain record is written into a buffer the history recycles, and kept there
        // (the bodies it carries are read in place as H1 and H2).
        let mut plain = self.history.take_plain();
        let (h1, h2) = self.history.refs(self.tx.is_full(), false, no_reset);
        let r = crate::predict::unpredict_record(
            record,
            &self.tx,
            &mut self.bufs.blocks,
            h1,
            h2,
            &mut self.pred_scratch,
            &mut plain,
        );
        prof::add(prof::PRE_CHECKS, t);
        let r = match r {
            Ok((declared, computed)) if declared == computed => {
                self.accept_transaction(&plain, offset, record.len())
            }
            Ok((declared, computed)) => Err(Error::new(
                "predict-check",
                format!(
                    "record at offset {offset}, {}: predict_check {:016x}, the reconstructed blocks hash to {:016x}",
                    where_(self.tx.seq),
                    declared,
                    computed
                ),
            )),
            Err(e) => Err(e),
        };
        if r.is_ok() {
            self.history.accept_plain(
                &self.tx,
                plain,
                &self.bufs.blocks,
                no_reset,
                &mut self.pred_scratch,
            );
            self.plain_ok = true;
        } else {
            self.history.return_plain(plain);
        }
        r
    }

    fn accept_transaction(
        &mut self,
        record: &[u8],
        offset: usize,
        wire_len: usize,
    ) -> Result<Accepted, Error> {
        if self.opts.early_prune {
            // Sabotage `early-prune`: C ← C ∩ names(S_base) before this transaction is resolved,
            // which drops the records it brings.
            let names = &self.names;
            self.carried.retain(|h, _| names.contains_key(h));
        }
        let t = prof::start();
        let pre = self.pre_checks(offset);
        prof::add(prof::PRE_CHECKS, t);
        pre?;
        let t = prof::start();
        let blocks = &self.bufs.blocks;
        let blk = |i: usize| -> &[u8] {
            blocks
                .get(i)
                .map(|b| &record[b.start..b.start + b.len])
                .unwrap_or(&[])
        };
        let bl = [
            blk(0),
            blk(1),
            blk(2),
            blk(3),
            blk(4),
            blk(5),
            blk(6),
            blk(7),
            blk(8),
            blk(9),
        ];
        let u8_start = blocks.get(7).map(|b| b.start).unwrap_or(0);
        let mm_start = blocks.get(8).map(|b| b.start).unwrap_or(0);
        self.apply(bl, u8_start, mm_start);
        self.reindex_dirty();
        prof::add(prof::RESOLVE, t);
        let t = prof::start();
        let mut result = self.post_checks(offset);
        if result.is_ok() && self.item_meta_pending.is_some() {
            // TAG1 `item-meta-id`: judged on the target state, so after this transaction applied
            // (and rolled back with it).
            result = self.item_meta_ids(offset);
        }
        if let Err(e) = result {
            self.rollback();
            return Err(e);
        }
        self.commit();
        if self.item_meta_pending.is_some() || !self.item_meta.rows.is_empty() {
            self.item_meta_commit();
        }
        prof::add(prof::POST_CHECKS, t);
        self.bytes_total += wire_len as u64;
        self.max_record_bytes = self.max_record_bytes.max(wire_len as u64);
        Ok(Accepted::Transaction)
    }

    // -------------------------------------------------------------------------------- item_meta

    /// TAG1 rules 1 and 2, before the record is decoded.
    fn item_meta_precheck(&self, offset: usize) -> Result<(), Error> {
        if self.opts.item_meta == ItemMetaAsk::NotAsked {
            return Err(Error::new(
                "item-meta-unexpected",
                format!("record at offset {offset}: an item_meta record on a stream whose viewer did not ask for one"),
            ));
        }
        if self.item_meta_pending.is_some() {
            return Err(Error::new(
                "item-meta-orphan",
                format!("record at offset {offset}: an item_meta record follows an item_meta record, not a transaction"),
            ));
        }
        Ok(())
    }

    /// TAG1: a record while an `item_meta` record awaits its transaction.
    fn item_meta_orphan(&self, offset: usize, what: &str) -> Result<(), Error> {
        if self.item_meta_pending.is_some() {
            return Err(Error::new(
                "item-meta-orphan",
                format!("record at offset {offset}: {what} follows an item_meta record, not a transaction"),
            ));
        }
        Ok(())
    }

    /// TAG1 rules 3-5 on a decoded record (its record-local schema already held), then it waits
    /// for its transaction. Nothing changes on an error.
    fn accept_item_meta(
        &mut self,
        record: &[u8],
        offset: usize,
        r: Box<ItemMetaRecord>,
    ) -> Result<Accepted, Error> {
        let err = |code: &'static str, d: String| {
            Error::new(code, format!("record at offset {offset}: {d}"))
        };
        if let (ItemMetaAsk::Asked(req), Some(g)) = (&self.opts.item_meta, &r.grant) {
            if !g.within(req) {
                return Err(err(
                    "item-meta-schema",
                    format!(
                        "the grant {} is not within the request {}",
                        g.to_json(),
                        req.to_json()
                    ),
                ));
            }
        }
        if !r.full {
            let Some(g) = self.item_meta.grant.as_ref() else {
                return Err(err(
                    "item-meta-form",
                    "a delta item_meta record before any full one granted".into(),
                ));
            };
            item_meta::check_rows(&r.items, g).map_err(|d| err("item-meta-schema", d))?;
            let size = self.item_meta.strings.len() as u64;
            if r.strings_from != size {
                return Err(err(
                    "item-meta-string",
                    format!(
                        "a delta's strings_from is {}, the table holds {size} strings",
                        r.strings_from
                    ),
                ));
            }
            item_meta::check_indices(&r.items, g, size + r.strings.len() as u64)
                .map_err(|d| err("item-meta-string", d))?;
        }
        self.item_meta_pending = Some(r);
        self.bytes_total += record.len() as u64;
        self.max_record_bytes = self.max_record_bytes.max(record.len() as u64);
        Ok(Accepted::ItemMeta)
    }

    /// TAG1: the transaction's form against the record before it (`item-meta-form`), or its
    /// absence before a full on a granted stream (`item-meta-missing`).
    fn item_meta_form(&self, offset: usize) -> Result<(), Error> {
        let full = self.tx.is_full();
        let at = format!("record at offset {offset}, {}", where_(self.tx.seq));
        match &self.item_meta_pending {
            Some(p) if p.full != full => Err(Error::new(
                "item-meta-form",
                format!(
                    "{at}: a {} item_meta record precedes a {} transaction",
                    if p.full { "full" } else { "delta" },
                    if full { "full" } else { "patch" }
                ),
            )),
            None if full && self.item_meta.grant.is_some() => Err(Error::new(
                "item-meta-missing",
                format!("{at}: a full transaction on a granted stream without a full item_meta record before it"),
            )),
            _ => Ok(()),
        }
    }

    /// TAG1 `item-meta-id`: every pending row names an item of the (applied) target state.
    fn item_meta_ids(&self, offset: usize) -> Result<(), Error> {
        let Some(p) = &self.item_meta_pending else {
            return Ok(());
        };
        match p.items.iter().find(|(id, _)| !self.state.items.contains_key(id)) {
            Some((id, _)) => Err(Error::new(
                "item-meta-id",
                format!(
                    "record at offset {offset}, {}: the item_meta record before it has a row for item {id}, which its target state does not hold",
                    where_(self.tx.seq)
                ),
            )),
            None => Ok(()),
        }
    }

    /// TAG1: after a committed transaction, its record into the table, then the rows of the
    /// items it removed dropped.
    fn item_meta_commit(&mut self) {
        let t = &mut self.item_meta;
        if let Some(p) = self.item_meta_pending.take() {
            let p = *p;
            if p.full {
                t.grant = p.grant;
                t.strings = p.strings;
                t.rows.clear();
            } else {
                t.strings.extend(p.strings);
            }
            t.rows.extend(p.items);
        }
        if !t.rows.is_empty() {
            for id in &self.delta.items_removed {
                t.rows.remove(id);
            }
        }
    }

    /// Everything `accept` checks before `applyTransaction`, in order.
    fn pre_checks(&mut self, offset: usize) -> Result<(), Error> {
        let tx = &self.tx;
        let v = self.opts.version;
        let schema =
            |d: String| Error::new("meta-schema", format!("record at offset {offset}: {d}"));
        if tx.unknown_items.is_some() != self.session.unknown_item_skip {
            return Err(schema(
                "\"unknown_items\" must be present exactly when the session declares unknown_item_policy \"skip\"".into(),
            ));
        }
        // PM1 rule 8: an add_multimesh needs a session whose features.ops lists it.
        if v >= 11 && !self.mm_op_declared && tx.cmds.iter().any(|c| c.op == Op::Multimesh) {
            return Err(schema(
                "an add_multimesh command in a session whose features.ops lacks \"add_multimesh\"".into(),
            ));
        }
        // render-stream-12.md "Session record": the particles keys, `particle_emits`, `pt_f32` and
        // add_particles need a session whose features.ops lists add_particles.
        if v >= 12 && !self.pt_op_declared {
            let what = if !tx.particles.is_empty() {
                Some("a \"particles\" key")
            } else if !tx.removed_particles.is_empty() {
                Some("a \"removed_particles\" key")
            } else if !tx.particle_emits.is_empty() {
                Some("a \"particle_emits\" key")
            } else if tx.blocks.len() > meta::PT_F32_BLOCK {
                Some("a \"pt_f32\" block")
            } else if tx.cmds.iter().any(|c| c.op == Op::Particles) {
                Some("an add_particles command")
            } else {
                None
            };
            if let Some(what) = what {
                return Err(schema(format!(
                    "{what} in a session whose features.ops lacks \"add_particles\""
                )));
            }
        }
        // checkIdOrdering / checkIdListAscendingNoDup, in the TypeScript's concatenation order.
        let ordering = |label: &str, ids: &mut dyn Iterator<Item = i64>| -> Result<(), Error> {
            let mut prev: Option<i64> = None;
            for id in ids {
                if let Some(p) = prev {
                    if id == p {
                        return Err(Error::new(
                            "duplicate-id",
                            format!("record at offset {offset}: {label} id {id} repeats"),
                        ));
                    }
                    if id < p {
                        return Err(schema(format!("{label} are not sorted by id ascending")));
                    }
                }
                prev = Some(id);
            }
            Ok(())
        };
        let ascending = |label: &str, ids: &[i64]| -> Result<(), Error> {
            if ids.windows(2).any(|w| w[1] <= w[0]) {
                return Err(schema(format!("{label} is not strictly ascending")));
            }
            Ok(())
        };
        ordering("canvases", &mut tx.canvases.iter().map(|c| c.id as i64))?;
        ordering("items", &mut tx.items.iter().map(|c| c.id as i64))?;
        ordering("textures", &mut tx.textures.iter().map(|c| c.id as i64))?;
        ascending("removed_canvases", &tx.removed_canvases)?;
        ascending("removed_items", &tx.removed_items)?;
        ascending("removed_textures", &tx.removed_textures)?;
        if v >= 4 {
            ordering("meshes", &mut tx.meshes.iter().map(|c| c.id as i64))?;
            ascending("removed_meshes", &tx.removed_meshes)?;
        }
        if v >= 5 {
            ordering("shaders", &mut tx.shaders.iter().map(|c| c.id as i64))?;
            ordering("materials", &mut tx.materials.iter().map(|c| c.id as i64))?;
            ascending("removed_shaders", &tx.removed_shaders)?;
            ascending("removed_materials", &tx.removed_materials)?;
        }
        if v >= 11 {
            ordering("multimeshes", &mut tx.multimeshes.iter().map(|c| c.id as i64))?;
            ascending("removed_multimeshes", &tx.removed_multimeshes)?;
        }
        if v >= 12 {
            ordering("particles", &mut tx.particles.iter().map(|c| c.id as i64))?;
            ascending("removed_particles", &tx.removed_particles)?;
        }
        // W11d: after a transport skip ([`Validator::transport_skip`]) the next transaction is
        // the full one the resync forces, at any later seq.
        let skipped = self.skipping && tx.is_full() && tx.seq > self.prev_seq;
        if skipped {
            self.skipped_tx += tx.seq - self.prev_seq - 1;
        }
        if tx.seq != self.prev_seq + 1 && !skipped {
            return Err(Error::new(
                "seq-gap",
                format!(
                    "record at offset {offset}: seq {}, expected {}",
                    tx.seq,
                    self.prev_seq + 1
                ),
            ));
        }
        self.check_patch_rules(offset)?;
        let tx = &self.tx;
        if let Some(p) = self.prev_frame {
            if tx.frame <= p {
                return Err(Error::new(
                    "frame-order",
                    format!(
                        "record at offset {offset}: frame {} does not increase from {p}",
                        tx.frame
                    ),
                ));
            }
        }
        // cmd-offset / cmd-int-offset / mesh-offset / param-offset.
        let mut running = 0u64;
        let mut running_int = 0u64;
        for it in &tx.items {
            let Some(r) = it.commands else { continue };
            for c in r.of(&tx.cmds) {
                if matches!(
                    c.op,
                    Op::Unsupported | Op::ClipIgnore | Op::Multimesh | Op::Particles
                ) {
                    continue;
                }
                if c.f != running {
                    return Err(Error::new(
                        "cmd-offset",
                        format!(
                            "record at offset {offset}: {} f={}, expected {running}",
                            c.op.as_str(),
                            c.f
                        ),
                    ));
                }
                running = running.saturating_add(c.float_count());
                if c.op == Op::TriangleArray {
                    if c.i != running_int {
                        return Err(Error::new(
                            "cmd-int-offset",
                            format!(
                                "record at offset {offset}: {} i={}, expected {running_int}",
                                c.op.as_str(),
                                c.i
                            ),
                        ));
                    }
                    running_int = running_int.saturating_add(c.indices);
                }
            }
        }
        let mut mesh_floats = 0u64;
        if v >= 4 {
            for m in &tx.meshes {
                let Some(f) = m.f else { continue };
                if f != mesh_floats {
                    return Err(Error::new(
                        "mesh-offset",
                        format!(
                            "record at offset {offset}: mesh {} f={f}, expected {mesh_floats}",
                            m.id
                        ),
                    ));
                }
                mesh_floats += 6;
            }
        }
        let mut param_floats = 0u64;
        if v >= 5 {
            let mut check = |p: &meta::ParamMeta,
                             wherein: &dyn Fn() -> String|
             -> Result<(), Error> {
                if p.f != param_floats {
                    return Err(Error::new(
                        "param-offset",
                        format!("record at offset {offset}: {} param \"{}\" f={}, expected {param_floats}", wherein(), p.name, p.f),
                    ));
                }
                param_floats =
                    param_floats.saturating_add(p.n.saturating_mul(p.ty.components() as u64));
                Ok(())
            };
            for m in &tx.materials {
                for p in m.params.of(&tx.params) {
                    check(p, &|| format!("material {}", m.id))?;
                }
            }
            for it in &tx.items {
                for p in it.instance_params.of(&tx.params) {
                    check(p, &|| format!("item {} instance", it.id))?;
                }
            }
        }
        // P3-TM (render-stream-10.md "Shader time"): the host's shader time is param_f64's last
        // float, after the materials' and the items' instance parameters.
        if let Some(f) = tx.shader_time_f {
            if f != param_floats {
                return Err(Error::new(
                    "shader-time",
                    format!("record at offset {offset}: shader_time f={f}, expected {param_floats}"),
                ));
            }
            param_floats += 1;
        }
        // backbuffer-offset (render-stream-10.md "Transaction blocks").
        let mut backbuffer_floats = 0u64;
        if v >= 10 {
            for it in &tx.items {
                let slots = [
                    ("canvas_group", it.canvas_group.map(|g| g.f), 2u64),
                    ("copy_to_backbuffer", it.copy_to_backbuffer, 4u64),
                ];
                for (key, f, n) in slots {
                    let Some(f) = f else { continue };
                    if f != backbuffer_floats {
                        return Err(Error::new(
                            "backbuffer-offset",
                            format!(
                                "record at offset {offset}: item {} {key} f={f}, expected {backbuffer_floats}",
                                it.id
                            ),
                        ));
                    }
                    backbuffer_floats += n;
                }
            }
        }
        let stride: u64 = if v >= 5 { 10 } else { 6 };
        let count = |i: usize| tx.blocks.get(i).map(|b| b.count);
        if v >= 11 {
            self.check_dynamic_meshes(offset)?;
            self.check_multimeshes(offset)?;
        }
        if v >= 12 {
            self.check_particles(offset)?;
        }
        let expected_canvas = stride * tx.canvases.len() as u64;
        if count(1) != Some(expected_canvas) {
            let code = if v >= 5 {
                "canvas-offset"
            } else {
                "block-count"
            };
            return Err(Error::new(
                code,
                format!(
                    "record at offset {offset}: block \"canvas_f32\" declares count {}, expected {expected_canvas}",
                    count(1).unwrap_or(0)
                ),
            ));
        }
        let mut expected: Vec<(usize, u64)> = vec![(0, 18 * tx.items.len() as u64), (2, running)];
        if v >= 4 {
            expected.push((3, running_int));
            expected.push((4, mesh_floats));
        }
        if v >= 5 {
            expected.push((5, param_floats));
        }
        if v >= 10 {
            expected.push((6, backbuffer_floats));
        }
        for (i, n) in expected {
            if count(i) != Some(n) {
                return Err(Error::new(
                    if i == 6 {
                        "backbuffer-offset"
                    } else {
                        "block-count"
                    },
                    format!(
                        "record at offset {offset}: block \"{}\" declares count {}, expected {n}",
                        meta::TRANSACTION_BLOCK_NAMES[i],
                        count(i).unwrap_or(0)
                    ),
                ));
            }
        }
        let expected_status = if tx.failures.is_empty() {
            TxStatus::Ok
        } else {
            TxStatus::CaptureFailure
        };
        if tx.status != Some(expected_status) {
            return Err(schema(format!(
                "status \"{}\" disagrees with failures.length {}",
                tx.status.map(|s| s.as_str()).unwrap_or("?"),
                tx.failures.len()
            )));
        }
        Ok(())
    }

    /// /11 (render-stream-11.md "Dynamic mesh surfaces", decision 4): per mesh entry
    /// `mesh-dynamic`, then `mesh-u8-offset` over the entries and `mesh_u8`'s count, then
    /// `payload-size` on each body; then `mm-offset` (decision 3: no multimesh entry claims a
    /// float until PM1). Runs against the base state (before resolving).
    fn check_dynamic_meshes(&self, offset: usize) -> Result<(), Error> {
        let tx = &self.tx;
        let full = tx.is_full();
        let md = |d: String| Error::new("mesh-dynamic", format!("record at offset {offset}: {d}"));
        for m in &tx.meshes {
            let n_dyn = m.surfaces.iter().filter(|s| s.hash.is_none()).count();
            if m.status != EntryStatus::Ok {
                if m.u8.is_some() {
                    return Err(md(format!(
                        "mesh {} is \"{}\" but carries a non-null u8",
                        m.id,
                        m.status.as_str()
                    )));
                }
                if n_dyn > 0 {
                    return Err(md(format!(
                        "mesh {} is \"{}\" but has a dynamic (hash null) surface",
                        m.id,
                        m.status.as_str()
                    )));
                }
                continue;
            }
            if n_dyn > 0 && n_dyn < m.surfaces.len() {
                return Err(md(format!(
                    "mesh {} mixes static and dynamic surfaces",
                    m.id
                )));
            }
            if n_dyn == 0 {
                if m.u8.is_some() {
                    return Err(md(format!(
                        "mesh {} is static (or has no surface) but carries a non-null u8",
                        m.id
                    )));
                }
                continue;
            }
            if m.u8.is_none() {
                // "The bytes you hold": only in a patch whose base entry was already dynamic,
                // with the same surface count and shapes.
                let held = !full
                    && self.state.meshes.get(&m.id).is_some_and(|old| {
                        old.is_dynamic()
                            && old.surfaces.len() == m.surfaces.len()
                            && old
                                .surfaces
                                .iter()
                                .zip(&m.surfaces)
                                .all(|(a, b)| same_shape(a, b))
                    });
                if !held {
                    return Err(md(format!(
                        "dynamic mesh {} has a null u8, but {}",
                        m.id,
                        if full {
                            "the transaction is full"
                        } else {
                            "its base entry is not a dynamic mesh of the same shape"
                        }
                    )));
                }
            }
        }
        let mut running = 0u64;
        for m in &tx.meshes {
            let Some(at) = m.u8 else { continue };
            if at != running {
                return Err(Error::new(
                    "mesh-u8-offset",
                    format!(
                        "record at offset {offset}: mesh {} u8={at}, expected {running}",
                        m.id
                    ),
                ));
            }
            for s in &m.surfaces {
                running = running.saturating_add(s.payload_bytes as u64);
            }
        }
        let u8_count = tx.blocks.get(7).map(|b| b.count).unwrap_or(0);
        if u8_count != running {
            return Err(Error::new(
                "mesh-u8-offset",
                format!(
                    "record at offset {offset}: block \"mesh_u8\" declares count {u8_count}, the meshes' bodies total {running}"
                ),
            ));
        }
        for m in &tx.meshes {
            if m.status != EntryStatus::Ok {
                continue;
            }
            for (k, s) in m.surfaces.iter().enumerate() {
                if s.hash.is_some() {
                    continue;
                }
                let need = payload::mesh_body_bytes(s.format, s.vertex_count, s.index_count);
                if need != s.payload_bytes as u128 {
                    return Err(Error::new(
                        "payload-size",
                        format!(
                            "record at offset {offset}: mesh {} surface {k}'s body is payload_bytes {}, its shape needs {need}",
                            m.id, s.payload_bytes
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    /// /11 (render-stream-11.md "As built (PM1)" rules 2-5): per multimesh entry
    /// `multimesh-entry` (its shape, then the `buffer_f` rule), then `multimesh-version` (the JSON
    /// fields against the entry the last transaction carrying it resolved to), then `mm-offset`
    /// over the entries and `mm_f32`'s count. Runs against the base state (before resolving),
    /// after the mesh rules. `multimesh-ref` runs on the resolved state (`check_invariants`).
    fn check_multimeshes(&self, offset: usize) -> Result<(), Error> {
        let tx = &self.tx;
        let full = tx.is_full();
        let me = |id: Id, d: &str| {
            Error::new(
                "multimesh-entry",
                format!("record at offset {offset}: multimesh {id}: {d}"),
            )
        };
        for m in &tx.multimeshes {
            let shape = match m.status {
                EntryStatus::Ok => {
                    if m.reason.is_some() {
                        Some("an \"ok\" entry has a non-null reason")
                    } else if m.format != MultimeshFormat::D2 {
                        Some("an \"ok\" entry's format is not \"2d\"")
                    } else if m.aabb_f.is_none() {
                        Some("an \"ok\" entry has a null aabb_f")
                    } else if m.visible > m.instances {
                        Some("an \"ok\" entry's visible exceeds its instances")
                    } else {
                        None
                    }
                }
                EntryStatus::Unsupported => {
                    if m.reason.is_none() {
                        Some("an \"unsupported\" entry has a null reason")
                    } else if m.aabb_f.is_none() {
                        Some("an \"unsupported\" entry has a null aabb_f")
                    } else if m.buffer_f.is_some() {
                        Some("an \"unsupported\" entry has a non-null buffer_f")
                    } else {
                        None
                    }
                }
                EntryStatus::Freed => {
                    if m.reason.is_some()
                        || m.mesh.is_some()
                        || m.format != MultimeshFormat::D2
                        || m.colors
                        || m.custom
                        || m.instances != 0
                        || m.visible != -1
                        || m.aabb_f.is_some()
                        || m.buffer_f.is_some()
                    {
                        Some("a \"freed\" entry must be {reason: null, mesh: null, format: \"2d\", colors: false, custom: false, instances: 0, visible: -1, aabb_f: null, buffer_f: null}")
                    } else {
                        None
                    }
                }
            };
            if let Some(d) = shape {
                return Err(me(m.id, d));
            }
            // Rule 3: a null buffer_f on an `ok` entry means "the floats you hold", legal only in a
            // patch whose base entry is `ok` with the same instances, format, colors and custom.
            if m.status == EntryStatus::Ok && m.buffer_f.is_none() {
                let held = !full
                    && self.state.multimeshes.get(&m.id).is_some_and(|b| {
                        b.status == EntryStatus::Ok
                            && b.instances == m.instances
                            && b.format == m.format
                            && b.colors == m.colors
                            && b.custom == m.custom
                    });
                if !held {
                    return Err(me(
                        m.id,
                        &format!(
                            "an \"ok\" entry has a null buffer_f, but {}",
                            if full {
                                "the transaction is full"
                            } else if !self.state.multimeshes.contains_key(&m.id) {
                                "the entry is new to the table"
                            } else {
                                "its base entry is not \"ok\" with the same instances, format, colors and custom"
                            }
                        ),
                    ));
                }
            }
        }
        for m in &tx.multimeshes {
            if let Some(p) = self.last_multimesh.get(&m.id) {
                if m.version < p.version || (m.version == p.version && !mm_fields_equal(p, m)) {
                    return Err(Error::new(
                        "multimesh-version",
                        format!(
                            "record at offset {offset}: multimesh {}'s version {} {} (earlier entry: version {})",
                            m.id,
                            m.version,
                            if m.version < p.version {
                                "decreased"
                            } else {
                                "did not move, but the entry changed"
                            },
                            p.version
                        ),
                    ));
                }
            }
        }
        let mut running = 0u64;
        for m in &tx.multimeshes {
            for (key, at, n) in [
                ("aabb_f", m.aabb_f, 6u64),
                ("buffer_f", m.buffer_f, m.buffer_floats()),
            ] {
                let Some(at) = at else { continue };
                if at != running {
                    return Err(Error::new(
                        "mm-offset",
                        format!(
                            "record at offset {offset}: multimesh {} {key}={at}, expected {running}",
                            m.id
                        ),
                    ));
                }
                running = running.saturating_add(n);
            }
        }
        let mm = tx.blocks.get(8).map(|b| b.count).unwrap_or(0);
        if mm != running {
            return Err(Error::new(
                "mm-offset",
                format!(
                    "record at offset {offset}: block \"mm_f32\" declares count {mm}, the multimesh entries claim {running}"
                ),
            ));
        }
        Ok(())
    }

    /// `checkPatchRules`.
    /// /12 (render-stream-12.md "Validators: rule changes"): per particles entry
    /// `particles-entry` (shape), then `particles-version` (the JSON fields against the entry the
    /// last transaction carrying it resolved to), then `particle-emits` over the emit list, then
    /// `pt-offset` over the entries, the emits and `pt_f32`'s count. Runs against the base state
    /// (before resolving); the float half of `particles-version` and `particles-ref` run on the
    /// resolved state.
    fn check_particles(&self, offset: usize) -> Result<(), Error> {
        let tx = &self.tx;
        let full = tx.is_full();
        let pe = |id: Id, d: &str| {
            Error::new(
                "particles-entry",
                format!("record at offset {offset}: particles {id}: {d}"),
            )
        };
        for p in &tx.particles {
            let shape = match p.status {
                EntryStatus::Ok => {
                    if p.reason.is_some() {
                        Some("an \"ok\" entry has a non-null reason")
                    } else if p.mode != ParticlesMode::D2 {
                        Some("an \"ok\" entry's mode is not \"2d\"")
                    } else if p.f.is_none() {
                        Some("an \"ok\" entry has a null f")
                    } else {
                        None
                    }
                }
                EntryStatus::Unsupported => {
                    if p.reason.is_none() {
                        Some("an \"unsupported\" entry has a null reason")
                    } else if p.f.is_none() {
                        Some("an \"unsupported\" entry has a null f")
                    } else {
                        None
                    }
                }
                EntryStatus::Freed => {
                    if p.reason.is_some()
                        || p.f.is_some()
                        || p.process_material.is_some()
                        || !p.draw_passes.is_empty()
                        || p.subemitter.is_some()
                    {
                        Some("a \"freed\" entry must be {reason: null, process_material: null, draw_passes: [], subemitter: null, f: null}")
                    } else {
                        None
                    }
                }
            };
            let shape = shape.or_else(|| {
                (p.trail_poses > 0 && !p.trails).then_some("trail_poses > 0 needs trails true")
            });
            if let Some(d) = shape {
                return Err(pe(p.id, d));
            }
        }
        for p in &tx.particles {
            if let Some(q) = self.last_particles.get(&p.id) {
                if p.version < q.version || (p.version == q.version && !pt_fields_equal(q, p)) {
                    return Err(Error::new(
                        "particles-version",
                        format!(
                            "record at offset {offset}: particles {}'s version {} {} (earlier entry: version {})",
                            p.id,
                            p.version,
                            if p.version < q.version {
                                "decreased"
                            } else {
                                "did not move, but the entry changed"
                            },
                            q.version
                        ),
                    ));
                }
            }
        }
        // particle-emits: each element names an `ok` or `unsupported` entry of the resolved table
        // (the transaction's own entry, else the base's kept one), with `restarts` at most the
        // entry's, and per emitter at most `emits` - the base's `emits` elements.
        if !tx.particle_emits.is_empty() {
            let em = |d: String| {
                Error::new(
                    "particle-emits",
                    format!("record at offset {offset}: {d}"),
                )
            };
            let base = &self.state.particles;
            let mut counts: FastMap<Id, i64> = FastMap::default();
            for e in &tx.particle_emits {
                let listed = tx.particles.iter().find(|p| p.id == e.particles);
                let removed = tx
                    .removed_particles
                    .binary_search(&(e.particles as i64))
                    .is_ok();
                let target = match listed {
                    Some(p) => Some((p.status, p.restarts, p.emits)),
                    None if full || removed => None,
                    None => base
                        .get(&e.particles)
                        .map(|b| (b.status, b.restarts, b.emits)),
                };
                let Some((_, restarts, emits)) =
                    target.filter(|t| t.0 != EntryStatus::Freed)
                else {
                    return Err(em(format!(
                        "an emit names particles {}, which is not an \"ok\" or \"unsupported\" entry",
                        e.particles
                    )));
                };
                if e.restarts > restarts {
                    return Err(em(format!(
                        "an emit on particles {} has restarts {}, over the entry's {restarts}",
                        e.particles, e.restarts
                    )));
                }
                let base_emits = if full {
                    0
                } else {
                    base.get(&e.particles).map_or(0, |b| b.emits)
                };
                let n = counts.entry(e.particles).or_insert(0);
                *n += 1;
                if *n > emits - base_emits {
                    return Err(em(format!(
                        "particles {} lists {} emits, over its emits {emits} - the base's {base_emits}",
                        e.particles, *n
                    )));
                }
            }
        }
        // pt-offset.
        let po = |d: String| Error::new("pt-offset", format!("record at offset {offset}: {d}"));
        let mut running = 0u64;
        for p in &tx.particles {
            let Some(f) = p.f else { continue };
            if f != running {
                return Err(po(format!(
                    "particles {} f={f}, expected {running}",
                    p.id
                )));
            }
            running = running.saturating_add(p.float_count());
        }
        for (i, e) in tx.particle_emits.iter().enumerate() {
            if e.f != running {
                return Err(po(format!(
                    "particle_emits[{i}] f={}, expected {running}",
                    e.f
                )));
            }
            running = running.saturating_add(PARTICLE_EMIT_FLOATS);
        }
        match tx.blocks.get(meta::PT_F32_BLOCK) {
            None if running > 0 => Err(po(format!(
                "the particles claim {running} floats, but there is no \"pt_f32\" block"
            ))),
            None => Ok(()),
            Some(b) if b.count == 0 => Err(po(
                "block \"pt_f32\" is empty (an empty block is the absent block)".into(),
            )),
            Some(b) if b.count != running => Err(po(format!(
                "block \"pt_f32\" declares count {}, the particles claim {running}",
                b.count
            ))),
            Some(_) => Ok(()),
        }
    }

    fn check_patch_rules(&self, offset: usize) -> Result<(), Error> {
        let tx = &self.tx;
        let st = &self.state;
        let v = self.opts.version;
        let e = |code: &'static str, d: String| {
            Error::new(code, format!("record at offset {offset}: {d}"))
        };
        if tx.is_full() {
            if tx.base_seq.is_some()
                || !tx.removed_canvases.is_empty()
                || !tx.removed_items.is_empty()
                || !tx.removed_textures.is_empty()
                || (v >= 4 && !tx.removed_meshes.is_empty())
                || (v >= 5 && (!tx.removed_shaders.is_empty() || !tx.removed_materials.is_empty()))
                || !tx.removed_multimeshes.is_empty()
                || !tx.removed_particles.is_empty()
            {
                return Err(e(
                    "patch-encoding",
                    "a full transaction carries a non-null base_seq or a non-empty removed list"
                        .into(),
                ));
            }
            return Ok(());
        }
        if self.session.stream.encoding == Encoding::Full {
            return Err(e(
                "patch-encoding",
                "a patch transaction in a stream whose session says encoding \"full\"".into(),
            ));
        }
        if self.tx_count == 0 {
            return Err(e(
                "patch-base",
                "the stream's first transaction is a patch".into(),
            ));
        }
        if tx.base_seq != Some(self.prev_seq) {
            return Err(e(
                "patch-base",
                format!(
                    "base_seq {} is not the previous transaction's seq {}",
                    tx.base_seq.map(|b| b.to_string()).unwrap_or("null".into()),
                    self.prev_seq
                ),
            ));
        }
        // Removed lists are strictly ascending (checked above), so "removed twice" cannot occur.
        fn absent<T>(
            label: &str,
            ids: &[i64],
            map: &crate::state::IdTable<T>,
        ) -> Option<String> {
            ids.iter()
                .find(|&&id| u32::try_from(id).map_or(true, |i| !map.contains_key(&i)))
                .map(|id| format!("removed {label} {id} is absent from the base"))
        }
        fn both(
            label: &str,
            removed: &[i64],
            present: &mut dyn Iterator<Item = Id>,
        ) -> Option<String> {
            if removed.is_empty() {
                return None;
            }
            for id in present {
                if removed.binary_search(&(id as i64)).is_ok() {
                    return Some(format!("{label} {id} is both removed and present"));
                }
            }
            None
        }
        let pr = |d: Option<String>| -> Result<(), Error> {
            d.map_or(Ok(()), |d| Err(e("patch-removed", d)))
        };
        pr(absent("canvas", &tx.removed_canvases, &st.canvases))?;
        pr(absent("item", &tx.removed_items, &st.items))?;
        pr(absent("texture", &tx.removed_textures, &st.textures))?;
        pr(both(
            "canvas",
            &tx.removed_canvases,
            &mut tx.canvases.iter().map(|c| c.id),
        ))?;
        pr(both(
            "item",
            &tx.removed_items,
            &mut tx.items.iter().map(|c| c.id),
        ))?;
        pr(both(
            "texture",
            &tx.removed_textures,
            &mut tx.textures.iter().map(|c| c.id),
        ))?;
        if v >= 4 {
            pr(absent("mesh", &tx.removed_meshes, &st.meshes))?;
            pr(both(
                "mesh",
                &tx.removed_meshes,
                &mut tx.meshes.iter().map(|c| c.id),
            ))?;
        }
        if v >= 5 {
            pr(absent("shader", &tx.removed_shaders, &st.shaders))?;
            pr(both(
                "shader",
                &tx.removed_shaders,
                &mut tx.shaders.iter().map(|c| c.id),
            ))?;
            pr(absent("material", &tx.removed_materials, &st.materials))?;
            pr(both(
                "material",
                &tx.removed_materials,
                &mut tx.materials.iter().map(|c| c.id),
            ))?;
        }
        if v >= 11 {
            pr(absent(
                "multimesh",
                &tx.removed_multimeshes,
                &st.multimeshes,
            ))?;
            pr(both(
                "multimesh",
                &tx.removed_multimeshes,
                &mut tx.multimeshes.iter().map(|c| c.id),
            ))?;
        }
        if v >= 12 {
            pr(absent("particles", &tx.removed_particles, &st.particles))?;
            pr(both(
                "particles",
                &tx.removed_particles,
                &mut tx.particles.iter().map(|c| c.id),
            ))?;
        }
        for it in &tx.items {
            if it.commands.is_none() {
                match st.items.get(&it.id) {
                    None => {
                        return Err(e(
                            "patch-commands",
                            format!("item {} is new but carries commands:null", it.id),
                        ))
                    }
                    Some(b) if b.content_version != it.content_version => {
                        return Err(e(
                            "patch-commands",
                            format!(
                                "item {}'s content_version changed but it carries commands:null",
                                it.id
                            ),
                        ))
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }

    // --------------------------------------------------------------------------------- apply

    /// `applyTransaction`, in place for both encodings: every replaced or removed entry is logged in
    /// `undo`. A full transaction removes the previous ids it omits; an entry bitwise identical to
    /// the one it replaces (most of a full transaction) is left in place and not marked dirty, so
    /// a full transaction costs what it changes beyond reading it.
    /// `u8_start`: where `mesh_u8` (`bl[7]`) starts in the record, for [`BodyRef`]s; `mm_start`
    /// where `mm_f32` (`bl[8]`) starts, for [`MmBufferRef`]s.
    /// `bl[9]` is /12's optional `pt_f32` (empty when absent).
    fn apply(&mut self, bl: [&[u8]; 10], u8_start: usize, mm_start: usize) {
        let v = self.opts.version;
        // PH2: under `DigestPolicy::Never` the body digests are a cheaper identity.
        let body_digest = if self.opts.digest == DigestPolicy::Never {
            fast_identity
        } else {
            wire::sha256
        };
        let tx = &self.tx;
        let st = &mut self.state;
        self.cv_stable = None;
        self.bodies.clear();
        self.mm_buffers.clear();
        self.pt_emits.clear();
        let mesh_u8 = bl[7];
        self.undo.clear();
        self.dirty.clear();
        self.removed.clear();
        for w in self.was_new.iter_mut() {
            w.clear();
        }
        self.old_defaults = (st.default_texture_filter, st.default_texture_repeat);
        let (item_f32, canvas_f32, cmd_f32, cmd_i32, mesh_f32, param_f64) = (
            F32s(bl[0]),
            F32s(bl[1]),
            F32s(bl[2]),
            I32s(bl[3]),
            F32s(bl[4]),
            F64s(bl[5]),
        );
        let backbuffer_f32 = F32s(bl[6]);
        self.shader_time = tx.shader_time_f.map(|f| param_f64.get(f as usize));
        let stride = if v >= 5 { 10 } else { 6 };

        let r = &mut self.removed;
        if tx.is_full() {
            // The previous ids the full transaction omits (both sides ascending).
            fn omitted(
                prev: impl Iterator<Item = Id>,
                now: impl Iterator<Item = Id>,
                out: &mut Vec<Id>,
            ) {
                let mut now = now.peekable();
                for id in prev {
                    while now.peek().is_some_and(|&n| n < id) {
                        now.next();
                    }
                    if now.peek() != Some(&id) {
                        out.push(id);
                    }
                }
            }
            omitted(
                st.canvases.keys().copied(),
                tx.canvases.iter().map(|c| c.id),
                &mut r.canvases,
            );
            omitted(
                st.items.keys().copied(),
                tx.items.iter().map(|c| c.id),
                &mut r.items,
            );
            omitted(
                st.textures.keys().copied(),
                tx.textures.iter().map(|c| c.id),
                &mut r.textures,
            );
            omitted(
                st.meshes.keys().copied(),
                tx.meshes.iter().map(|c| c.id),
                &mut r.meshes,
            );
            omitted(
                st.shaders.keys().copied(),
                tx.shaders.iter().map(|c| c.id),
                &mut r.shaders,
            );
            omitted(
                st.materials.keys().copied(),
                tx.materials.iter().map(|c| c.id),
                &mut r.materials,
            );
            omitted(
                st.multimeshes.keys().copied(),
                tx.multimeshes.iter().map(|c| c.id),
                &mut r.multimeshes,
            );
            omitted(
                st.particles.keys().copied(),
                tx.particles.iter().map(|c| c.id),
                &mut r.particles,
            );
        } else {
            r.canvases
                .extend(tx.removed_canvases.iter().map(|&i| i as Id));
            r.items.extend(tx.removed_items.iter().map(|&i| i as Id));
            r.textures
                .extend(tx.removed_textures.iter().map(|&i| i as Id));
            r.meshes.extend(tx.removed_meshes.iter().map(|&i| i as Id));
            r.shaders
                .extend(tx.removed_shaders.iter().map(|&i| i as Id));
            r.materials
                .extend(tx.removed_materials.iter().map(|&i| i as Id));
            r.multimeshes
                .extend(tx.removed_multimeshes.iter().map(|&i| i as Id));
            r.particles
                .extend(tx.removed_particles.iter().map(|&i| i as Id));
        }
        let d = &mut self.dirty;
        let undo = &mut self.undo;
        for &id in &r.canvases {
            undo.push(Undo::Canvas(id, st.canvases.remove(&id)));
            d.canvases.push(id);
        }
        for &id in &r.items {
            undo.push(Undo::Item(id, st.items.remove(&id), false));
            d.items.push((id, true));
        }
        for &id in &r.textures {
            undo.push(Undo::Texture(id, st.textures.remove(&id)));
            d.textures.push(id);
        }
        for &id in &r.meshes {
            undo.push(Undo::Mesh(id, st.meshes.remove(&id)));
            d.meshes.push(id);
        }
        for &id in &r.shaders {
            undo.push(Undo::Shader(id, st.shaders.remove(&id)));
            d.shaders.push(id);
        }
        for &id in &r.materials {
            undo.push(Undo::Material(id, st.materials.remove(&id)));
            d.materials.push(id);
        }
        for &id in &r.multimeshes {
            undo.push(Undo::Multimesh(id, st.multimeshes.remove(&id)));
            d.multimeshes.push(id);
        }
        for &id in &r.particles {
            undo.push(Undo::Particles(id, st.particles.remove(&id)));
            d.particles.push(id);
        }

        for (i, c) in tx.canvases.iter().enumerate() {
            let (layer, sublayer) = c.layer.unwrap_or((0, 0));
            let xform: [f32; 6] = canvas_f32.arr(i * stride);
            let modulate: [f32; 4] = if stride == 10 {
                canvas_f32.arr(i * stride + 6)
            } else {
                [1.0; 4]
            };
            let items = c.items.of(&tx.ids);
            if let Some(old) = st.canvases.get(&c.id) {
                if old.origin == c.origin
                    && old.root == c.root
                    && old.attached == c.attached
                    && old.layer == layer
                    && old.sublayer == sublayer
                    && old.items == items
                    && bits_eq(&old.xform, &xform)
                    && bits_eq(&old.modulate, &modulate)
                {
                    self.was_new[0].push(false);
                    continue;
                }
            }
            let canvas = Canvas {
                id: c.id,
                origin: c.origin,
                root: c.root,
                attached: c.attached,
                layer,
                sublayer,
                items: items.to_vec(),
                xform,
                modulate,
            };
            let prev = st.canvases.insert(c.id, canvas);
            self.was_new[0].push(prev.is_none());
            undo.push(Undo::Canvas(c.id, prev));
            d.canvases.push(c.id);
        }
        if v >= 5 {
            for m in &tx.materials {
                // PH2: built into a recycled entry (its parameter names and floats reused).
                let mut mat = self.material_pool.pop().unwrap_or_else(|| Material {
                    id: 0,
                    origin: Origin::Created,
                    status: EntryStatus::Ok,
                    reason: None,
                    version: 0,
                    shader: None,
                    params: Vec::new(),
                });
                mat.id = m.id;
                mat.origin = m.origin;
                mat.status = m.status;
                mat.reason = m.reason;
                mat.version = m.version;
                mat.shader = m.shader;
                lift_params_into(&mut mat.params, m.params.of(&tx.params), param_f64);
                if st
                    .materials
                    .get(&m.id)
                    .is_some_and(|old| material_identical(old, &mat))
                {
                    self.was_new[5].push(false);
                    if self.material_pool.len() < 1024 {
                        self.material_pool.push(mat);
                    }
                    continue;
                }
                let prev = st.materials.insert(m.id, mat);
                self.was_new[5].push(prev.is_none());
                undo.push(Undo::Material(m.id, prev));
                d.materials.push(m.id);
            }
        }
        for (i, it) in tx.items.iter().enumerate() {
            let base = 18 * i;
            let mut item = self.item_pool.pop().unwrap_or_else(blank_item);
            item.id = it.id;
            item.origin = it.origin;
            item.parent = it.parent;
            item.children.clear();
            item.children.extend_from_slice(it.children.of(&tx.ids));
            item.visible = it.visible;
            item.draw_index = it.draw_index;
            item.z_index = it.z_index;
            item.z_relative = it.z_relative;
            item.behind = it.behind;
            item.clip = it.clip;
            item.custom_rect = it.custom_rect;
            item.visibility_layer = it.visibility_layer;
            item.texture_filter = it.texture_filter;
            item.texture_repeat = it.texture_repeat;
            item.material = it.material;
            item.use_parent_material = it.use_parent_material;
            item.instance_params.clear();
            item.instance_params.extend(
                it.instance_params
                    .of(&tx.params)
                    .iter()
                    .map(|p| lift_param(p, param_f64)),
            );
            item.canvas_group = it.canvas_group.map(|g| {
                let [clear_margin, fit_margin] = backbuffer_f32.arr::<2>(g.f as usize);
                CanvasGroup {
                    mode: g.mode,
                    clear_margin,
                    fit_empty: g.fit_empty,
                    fit_margin,
                    blur_mipmaps: g.blur_mipmaps,
                }
            });
            item.copy_to_backbuffer = it
                .copy_to_backbuffer
                .map(|f| backbuffer_f32.arr::<4>(f as usize));
            item.use_identity_transform = it.use_identity_transform;
            item.content_version = it.content_version;
            item.xform = item_f32.arr(base);
            item.modulate = item_f32.arr(base + 6);
            item.self_modulate = item_f32.arr(base + 10);
            item.custom_rect_rect = item_f32.arr(base + 14);
            match it.commands {
                Some(r) => {
                    lift_commands(r.of(&tx.cmds), cmd_f32, cmd_i32, &mut item.commands);
                    // G7o3: one B-tree search (compare, then replace in place).
                    let prev = match st.items.get_mut(&it.id) {
                        Some(old)
                            if item_head_identical(old, &item)
                                && commands_identical(&old.commands, &item.commands) =>
                        {
                            self.item_pool.push(item);
                            self.was_new[1].push(false);
                            continue;
                        }
                        Some(old) => {
                            // WB `content-version-stable` (/11, decision 7): a patch re-sends a
                            // list equal to the base's only under the base's content_version.
                            if v >= 11
                                && !tx.is_full()
                                && self.cv_stable.is_none()
                                && old.content_version != item.content_version
                                && commands_identical(&old.commands, &item.commands)
                            {
                                self.cv_stable = Some(it.id);
                            }
                            Some(std::mem::replace(old, item))
                        }
                        None => {
                            st.items.insert(it.id, item);
                            None
                        }
                    };
                    self.was_new[1].push(prev.is_none());
                    undo.push(Undo::Item(it.id, prev, false));
                    d.items.push((it.id, true));
                }
                None => {
                    // The previous commands carry over (an absent item gets none).
                    item.commands.list.clear();
                    item.commands.f32s.clear();
                    item.commands.i32s.clear();
                    // G7o3: one B-tree search, and replaced in place (a remove and an insert
                    // shift the node's large values twice).
                    let (prev, moved) = match st.items.get_mut(&it.id) {
                        Some(old) if item_head_identical(old, &item) => {
                            self.item_pool.push(item);
                            self.was_new[1].push(false);
                            continue;
                        }
                        Some(slot) => {
                            std::mem::swap(&mut item.commands, &mut slot.commands);
                            (Some(std::mem::replace(slot, item)), true)
                        }
                        None => {
                            st.items.insert(it.id, item);
                            (None, false)
                        }
                    };
                    self.was_new[1].push(prev.is_none());
                    undo.push(Undo::Item(it.id, prev, moved));
                    d.items.push((it.id, false));
                }
            }
        }
        for t in &tx.textures {
            if st.textures.get(&t.id) == Some(t) {
                self.was_new[2].push(false);
                continue;
            }
            let prev = st.textures.insert(t.id, t.clone());
            self.was_new[2].push(prev.is_none());
            undo.push(Undo::Texture(t.id, prev));
            d.textures.push(t.id);
        }
        if v >= 4 {
            for m in &tx.meshes {
                let custom_aabb = m.f.map(|f| mesh_f32.arr(f as usize)).unwrap_or([0.0; 6]);
                // /11 (render-stream-11.md "Resolution"): a dynamic surface carries its body's
                // digest; a non-null `u8` replaces every body, a null one keeps the base's.
                let dynamic = v >= 11
                    && m.status == EntryStatus::Ok
                    && m.surfaces.iter().any(|s| s.hash.is_none());
                let mut surfaces_buf;
                let surfaces: &[MeshSurface] = if dynamic {
                    surfaces_buf = m.surfaces.clone();
                    match m.u8 {
                        Some(at) => {
                            let mut p = at as usize;
                            for (k, s) in surfaces_buf.iter_mut().enumerate() {
                                let n = s.payload_bytes as usize;
                                let body = mesh_u8.get(p..p + n).unwrap_or(&[]);
                                s.body_sha256 =
                                    (!self.skip_body_digests).then(|| body_digest(body));
                                self.bodies.push(BodyRef {
                                    mesh: m.id,
                                    surface: k as u32,
                                    start: u8_start + p,
                                    len: n,
                                });
                                p += n;
                            }
                        }
                        None => {
                            if let Some(old) = st.meshes.get(&m.id) {
                                for (s, o) in surfaces_buf.iter_mut().zip(&old.surfaces) {
                                    s.body_sha256 = o.body_sha256;
                                }
                            }
                        }
                    }
                    &surfaces_buf
                } else {
                    &m.surfaces
                };
                if st.meshes.get(&m.id).is_some_and(|old| {
                    old.origin == m.origin
                        && old.adopted_content == m.adopted_content
                        && old.status == m.status
                        && old.reason == m.reason
                        && old.version == m.version
                        && bits_eq(&old.custom_aabb, &custom_aabb)
                        && old.surfaces == surfaces
                }) {
                    self.was_new[3].push(false);
                    continue;
                }
                let mesh = Mesh {
                    id: m.id,
                    origin: m.origin,
                    adopted_content: m.adopted_content,
                    status: m.status,
                    reason: m.reason,
                    version: m.version,
                    custom_aabb,
                    surfaces: surfaces.to_vec(),
                };
                let prev = st.meshes.insert(m.id, mesh);
                self.was_new[3].push(prev.is_none());
                undo.push(Undo::Mesh(m.id, prev));
                d.meshes.push(m.id);
            }
        }
        if v >= 5 {
            for s in &tx.shaders {
                if st.shaders.get(&s.id) == Some(s) {
                    self.was_new[4].push(false);
                    continue;
                }
                let prev = st.shaders.insert(s.id, s.clone());
                self.was_new[4].push(prev.is_none());
                undo.push(Undo::Shader(s.id, prev));
                d.shaders.push(s.id);
            }
        }
        // PM1 (render-stream-11.md "As built (PM1)" rule 10): an `ok` entry's buffer digest comes
        // from `mm_f32` when `buffer_f` is non-null, else from the base entry (rule 3 guarantees
        // it is `ok` with the same shape); `custom_aabb` is null only on `freed`.
        if v >= 11 {
            let mm_f32 = F32s(bl[8]);
            for m in &tx.multimeshes {
                let custom_aabb = m.aabb_f.map(|f| mm_f32.arr::<6>(f as usize));
                let buffer_sha256 = if m.status != EntryStatus::Ok {
                    None
                } else if let Some(at) = m.buffer_f {
                    let n = m.buffer_floats() as usize;
                    let at = at as usize;
                    let bytes = bl[8].get(4 * at..4 * (at + n)).unwrap_or(&[]);
                    self.mm_buffers.push(MmBufferRef {
                        multimesh: m.id,
                        start: mm_start + 4 * at,
                        floats: n,
                    });
                    Some(body_digest(bytes))
                } else {
                    st.multimeshes.get(&m.id).and_then(|o| o.buffer_sha256)
                };
                let mm = Multimesh {
                    id: m.id,
                    origin: m.origin,
                    status: m.status,
                    reason: m.reason,
                    version: m.version,
                    mesh: m.mesh,
                    format: m.format,
                    colors: m.colors,
                    custom: m.custom,
                    instances: m.instances,
                    visible: m.visible,
                    custom_aabb,
                    buffer_sha256,
                };
                if st.multimeshes.get(&m.id).is_some_and(|old| {
                    old.version == mm.version
                        && old.buffer_sha256 == mm.buffer_sha256
                        && mm_floats_equal(old, &mm)
                        && mm_fields_equal(old, m)
                }) {
                    continue;
                }
                let prev = st.multimeshes.insert(m.id, mm);
                undo.push(Undo::Multimesh(m.id, prev));
                d.multimeshes.push(m.id);
            }
        }
        // PM5 (render-stream-12.md "Particles table", "The emit list"): every listed `ok` or
        // `unsupported` entry carries its floats at `f` in `pt_f32`; `freed` carries none. The emit
        // list is the transaction's, kept for [`Validator::particle_emits`].
        if v >= 12 {
            let pt_f32 = F32s(bl[9]);
            let slice = |at: u64, n: u64| -> Vec<f32> {
                (at..at + n).map(|i| pt_f32.get(i as usize)).collect()
            };
            for p in &tx.particles {
                let floats = p
                    .f
                    .map(|at| ParticleFloats::from_wire(&slice(at, p.float_count())));
                let pt = Particles {
                    id: p.id,
                    origin: p.origin,
                    status: p.status,
                    reason: p.reason,
                    version: p.version,
                    mode: p.mode,
                    emitting: p.emitting,
                    amount: p.amount,
                    one_shot: p.one_shot,
                    fixed_fps: p.fixed_fps,
                    interpolate: p.interpolate,
                    fractional_delta: p.fractional_delta,
                    local: p.local,
                    draw_order: p.draw_order,
                    transform_align: p.transform_align,
                    trails: p.trails,
                    trail_poses: p.trail_poses,
                    seed: p.seed,
                    restarts: p.restarts,
                    emits: p.emits,
                    process_requests: p.process_requests,
                    process_material: p.process_material,
                    draw_passes: p.draw_passes.clone(),
                    subemitter: p.subemitter,
                    floats,
                };
                if st.particles.get(&p.id).is_some_and(|old| *old == pt) {
                    continue;
                }
                let prev = st.particles.insert(p.id, pt);
                undo.push(Undo::Particles(p.id, prev));
                d.particles.push(p.id);
            }
            for e in &tx.particle_emits {
                let f = slice(e.f, PARTICLE_EMIT_FLOATS);
                self.pt_emits
                    .push(ParticleEmit::from_wire(e.particles, e.restarts, e.flags, &f));
            }
        }
        st.default_texture_filter = tx.default_texture_filter.unwrap_or(Filter::Nearest);
        st.default_texture_repeat = tx.default_texture_repeat.unwrap_or(Repeat::Disabled);
    }

    fn rollback(&mut self) {
        let st = &mut self.state;
        (st.default_texture_filter, st.default_texture_repeat) = self.old_defaults;
        while let Some(u) = self.undo.pop() {
            match u {
                Undo::Canvas(id, prev) => {
                    match prev {
                        Some(p) => st.canvases.insert(id, p),
                        None => st.canvases.remove(&id),
                    };
                }
                Undo::Item(id, prev, moved) => {
                    let cur = st.items.remove(&id);
                    if let Some(mut p) = prev {
                        if moved {
                            if let Some(c) = cur {
                                p.commands = c.commands;
                            }
                        }
                        st.items.insert(id, p);
                    }
                }
                Undo::Texture(id, prev) => {
                    match prev {
                        Some(p) => st.textures.insert(id, p),
                        None => st.textures.remove(&id),
                    };
                }
                Undo::Mesh(id, prev) => {
                    match prev {
                        Some(p) => st.meshes.insert(id, p),
                        None => st.meshes.remove(&id),
                    };
                }
                Undo::Shader(id, prev) => {
                    match prev {
                        Some(p) => st.shaders.insert(id, p),
                        None => st.shaders.remove(&id),
                    };
                }
                Undo::Material(id, prev) => {
                    match prev {
                        Some(p) => st.materials.insert(id, p),
                        None => st.materials.remove(&id),
                    };
                }
                Undo::Multimesh(id, prev) => {
                    match prev {
                        Some(p) => st.multimeshes.insert(id, p),
                        None => st.multimeshes.remove(&id),
                    };
                }
                Undo::Particles(id, prev) => {
                    match prev {
                        Some(p) => st.particles.insert(id, p),
                        None => st.particles.remove(&id),
                    };
                }
            }
        }
        self.reindex(false);
        self.bodies.clear();
        self.mm_buffers.clear();
        self.pt_emits.clear();
    }

    fn reindex_dirty(&mut self) {
        self.reindex(false);
    }

    /// Brings the indexes up to date for the dirty ids. `all`: the indexes start empty and every
    /// id is dirty (no propagation needed).
    fn reindex(&mut self, all: bool) {
        let st = &self.state;
        let v = self.opts.version;
        let ix = &mut self.idx;
        let d = &self.dirty;
        ix.touched.clear();

        // Canvases: root count, stacking groups.
        for &id in &d.canvases {
            if let Some((root, attached, layer)) = ix.canvas.remove(&id) {
                if root {
                    ix.root_count -= 1;
                }
                if attached && v >= 6 {
                    ix.stack_remove(layer);
                }
            }
            if let Some(c) = st.canvases.get(&id) {
                let layer = (c.layer, c.sublayer);
                if c.root {
                    ix.root_count += 1;
                }
                if c.attached && v >= 6 {
                    ix.stack_add(layer);
                }
                ix.canvas.insert(id, (c.root, c.attached, layer));
            }
        }

        // Textures.
        let mut status_changed: Vec<Id> = Vec::new();
        let mut u_check: Vec<Id> = Vec::new();
        let mut u_changed: Vec<Id> = Vec::new();
        for &id in &d.textures {
            let old = ix.tex.remove(&id);
            if let Some(df) = old.as_ref().and_then(|o| o.diffuse) {
                ix.diffuse_users.remove(&(df, id));
            }
            let old_status = old.as_ref().map(|o| o.status);
            let old_u = old.as_ref().is_some_and(|o| o.u);
            match st.textures.get(&id) {
                Some(t) => {
                    let diffuse = t.canvas.as_ref().and_then(|c| c.diffuse);
                    if let Some(df) = diffuse {
                        ix.diffuse_users.insert((df, id));
                    }
                    ix.tex.insert(
                        id,
                        TexIdx {
                            status: t.status,
                            diffuse,
                            u: old_u,
                        },
                    );
                    if old_status != Some(t.status) {
                        status_changed.push(id);
                    }
                    u_check.push(id);
                }
                None => {
                    if old_status.is_some() {
                        status_changed.push(id);
                    }
                    if old_u {
                        u_changed.push(id);
                    }
                }
            }
        }
        if !all {
            for &t in &status_changed {
                u_check.extend(users(&ix.diffuse_users, t));
            }
        }
        for &t in &u_check {
            let nu = compute_u(st, t);
            if let Some(e) = ix.tex.get_mut(&t) {
                if e.u != nu {
                    e.u = nu;
                    u_changed.push(t);
                }
            }
        }

        // Meshes.
        let mut mesh_changed: Vec<Id> = Vec::new();
        for &id in &d.meshes {
            let old = ix.mesh.remove(&id);
            let new = st.meshes.get(&id).map(|m| m.status);
            if let Some(s) = new {
                ix.mesh.insert(id, s);
            }
            if old != new {
                mesh_changed.push(id);
            }
        }
        // Multimeshes (/11).
        let mut mm_changed: Vec<Id> = Vec::new();
        for &id in &d.multimeshes {
            let old = ix.mm.remove(&id);
            let new = st.multimeshes.get(&id).map(|m| m.status);
            if let Some(s) = new {
                ix.mm.insert(id, s);
            }
            if old != new {
                mm_changed.push(id);
            }
        }
        // Particles (/12).
        let mut pt_changed: Vec<Id> = Vec::new();
        for &id in &d.particles {
            let old = ix.pt.remove(&id);
            let new = st.particles.get(&id).map(|p| p.status);
            if let Some(s) = new {
                ix.pt.insert(id, s);
            }
            if old != new {
                pt_changed.push(id);
            }
        }

        // Shaders and materials (/5).
        let mut mat_check: Vec<Id> = Vec::new();
        let mut mat_changed: Vec<Id> = Vec::new();
        if v >= 5 {
            for &id in &d.shaders {
                if let Some(old) = ix.shader_texs.remove(&id) {
                    for t in old {
                        ix.shader_tex_users.remove(&(t, id));
                    }
                }
                if let Some(s) = st.shaders.get(&id) {
                    let mut texs: Vec<Id> = s.default_textures.iter().map(|d| d.tex).collect();
                    sorted_dedup(&mut texs);
                    for &t in &texs {
                        ix.shader_tex_users.insert((t, id));
                    }
                    ix.shader_texs.insert(id, texs);
                }
                if !all {
                    mat_check.extend(users(&ix.shader_users, id));
                }
            }
            for &id in &d.materials {
                let old = ix.mat.remove(&id);
                let old_unsup = old.as_ref().is_some_and(|o| o.unsup);
                if let Some(o) = old {
                    if let Some(s) = o.shader {
                        ix.shader_users.remove(&(s, id));
                    }
                    for t in o.texs {
                        ix.mat_tex_users.remove(&(t, id));
                    }
                }
                match st.materials.get(&id) {
                    Some(m) => {
                        let mut texs: Vec<Id> = m
                            .params
                            .iter()
                            .filter_map(|p| match p.value {
                                ParamValue::Tex(t) if p.ty == VariantType::Rid => Some(t),
                                _ => None,
                            })
                            .collect();
                        sorted_dedup(&mut texs);
                        if let Some(s) = m.shader {
                            ix.shader_users.insert((s, id));
                        }
                        for &t in &texs {
                            ix.mat_tex_users.insert((t, id));
                        }
                        ix.mat.insert(
                            id,
                            MatIdx {
                                shader: m.shader,
                                texs,
                                unsup: old_unsup,
                            },
                        );
                        mat_check.push(id);
                    }
                    None => {
                        if old_unsup {
                            mat_changed.push(id);
                        }
                    }
                }
            }
            if !all {
                for &t in &status_changed {
                    mat_check.extend(users(&ix.mat_tex_users, t));
                    let shaders: Vec<Id> = users(&ix.shader_tex_users, t).collect();
                    for s in shaders {
                        mat_check.extend(users(&ix.shader_users, s));
                    }
                }
            }
            for &m in &mat_check {
                let nu = compute_mat_unsup(st, m);
                if let Some(e) = ix.mat.get_mut(&m) {
                    if e.unsup != nu {
                        e.unsup = nu;
                        mat_changed.push(m);
                    }
                }
            }
        }

        // Items: local parts.
        let mut texu_check: Vec<Id> = Vec::new();
        let mut meshu_check: Vec<Id> = Vec::new();
        let mut eff_work: Vec<Id> = Vec::new();
        let mut matu_check: Vec<Id> = Vec::new();
        for &(id, cmds_changed) in &d.items {
            // G7o3: taken out in place and written back (a remove and an insert leave hash-table
            // tombstones that force rehashes).
            let old = ix.item.get_mut(&id).map(std::mem::take);
            let had_old = old.is_some();
            let new_item = st.items.get(&id);
            let mut carried = ItemIdx::default();
            // G7o3: a claim, draw-index group or material use the item keeps is left in place
            // (removing and re-inserting the same entry is a no-op on the index).
            let new_parent = new_item.and_then(|n| n.parent.as_ref().map(pkey));
            let new_group = new_item.and_then(|n| {
                let drawing = !n.commands.list.is_empty() || !n.children.is_empty();
                new_parent.filter(|_| drawing).map(|p| (p, n.draw_index))
            });
            let new_material = new_item.and_then(|n| n.material);
            let (mut keep_claim, mut keep_group, mut keep_material) = (false, false, false);
            if let Some(o) = old {
                let old_group = o.parent.filter(|_| o.drawing).map(|p| (p, o.draw_index));
                if let Some(p) = o.parent {
                    keep_claim = new_parent == Some(p);
                    if !keep_claim {
                        ix.claims.remove(&(p, id));
                    }
                }
                if let Some((p, di)) = old_group {
                    keep_group = new_group == old_group;
                    if !keep_group {
                        ix.group_remove(p, di, id);
                    }
                }
                if let Some(m) = o.material {
                    keep_material = new_material == Some(m);
                    if !keep_material {
                        ix.mat_users.remove(&(m, id));
                    }
                }
                let same_parent = new_item.is_some_and(|n| n.parent.as_ref().map(pkey) == o.parent);
                if !same_parent {
                    if let Some(p) = o.parent {
                        ix.touched.push(p);
                    }
                }
                if cmds_changed || new_item.is_none() {
                    for &t in &o.tex_ids {
                        ix.tex_users.remove(&(t, id));
                    }
                    for &m in &o.meshes {
                        ix.mesh_users.remove(&(m, id));
                    }
                    for &m in &o.mms {
                        ix.mm_users.remove(&(m, id));
                    }
                    for &p in &o.pts {
                        ix.pt_users.remove(&(p, id));
                    }
                    ix.n_ops -= o.ops.len();
                } else {
                    carried.tex_refs = o.tex_refs;
                    carried.tex_ids = o.tex_ids;
                    carried.meshes = o.meshes;
                    carried.mms = o.mms;
                    carried.pts = o.pts;
                    carried.ops = o.ops;
                }
                if new_item.is_none() {
                    ix.n_tex_unsup -= o.tex_unsup.len();
                    ix.n_mesh_unsup -= o.mesh_unsup as usize;
                    ix.n_mm_unsup -= o.mm_unsup as usize;
                    ix.n_pt_unsup -= o.pt_unsup as usize;
                    ix.n_mat_unsup -= o.mat_unsup as usize;
                    if let Some(e) = o.eff {
                        ix.eff_users.remove(&(e, id));
                    }
                    // Children that inherit through this item see a different chain now.
                    eff_work.extend(users(&ix.claims, item_key(id)));
                } else {
                    carried.tex_unsup = o.tex_unsup;
                    carried.mesh_unsup = o.mesh_unsup;
                    carried.mm_unsup = o.mm_unsup;
                    carried.pt_unsup = o.pt_unsup;
                    carried.eff = o.eff;
                    carried.mat_unsup = o.mat_unsup;
                    if !same_parent {
                        if let Some(p) = new_item.and_then(|n| n.parent.as_ref()) {
                            ix.touched.push(pkey(p));
                        }
                    }
                }
            } else if let Some(p) = new_item.and_then(|n| n.parent.as_ref()) {
                ix.touched.push(pkey(p));
                if !all {
                    // A new item may complete an inheritance chain for existing children.
                    eff_work.extend(users(&ix.claims, item_key(id)));
                }
            }
            let Some(it) = new_item else {
                if had_old {
                    ix.item.remove(&id);
                }
                continue;
            };
            let mut e = carried;
            e.parent = it.parent.as_ref().map(pkey);
            e.draw_index = it.draw_index;
            e.drawing = !it.commands.list.is_empty() || !it.children.is_empty();
            e.material = it.material;
            e.upm = it.use_parent_material;
            if cmds_changed || !had_old {
                e.tex_refs.clear();
                e.tex_ids.clear();
                e.meshes.clear();
                e.mms.clear();
                e.pts.clear();
                e.ops.clear();
                for (k, c) in it.commands.list.iter().enumerate() {
                    if let (Some(t), Some(m)) = (c.tex(), rs_method(c)) {
                        e.tex_refs.push((t, m));
                    }
                    if let Command::Mesh { mesh, .. } = c {
                        e.meshes.push(*mesh);
                    }
                    if let Command::Multimesh { multimesh, .. } = c {
                        e.mms.push(*multimesh);
                    }
                    if let Command::Particles { particles, .. } = c {
                        e.pts.push(*particles);
                    }
                    if let Command::Unsupported { name, reason } = c {
                        let commands = &it.commands.list;
                        if !e.ops.iter().any(|&(j, _)| matches!(&commands[j as usize], Command::Unsupported { name: n, .. } if n == name)) {
                            e.ops.push((k as u32, reason.as_str()));
                        }
                    }
                }
                sorted_dedup(&mut e.tex_refs);
                e.tex_ids.extend(e.tex_refs.iter().map(|&(t, _)| t));
                e.tex_ids.dedup();
                sorted_dedup(&mut e.meshes);
                sorted_dedup(&mut e.mms);
                sorted_dedup(&mut e.pts);
                for &t in &e.tex_ids {
                    ix.tex_users.insert((t, id));
                }
                for &m in &e.meshes {
                    ix.mesh_users.insert((m, id));
                }
                for &m in &e.mms {
                    ix.mm_users.insert((m, id));
                }
                for &p in &e.pts {
                    ix.pt_users.insert((p, id));
                }
                ix.n_ops += e.ops.len();
            }
            if let Some(p) = e.parent {
                if !keep_claim {
                    ix.claims.insert((p, id));
                }
                if e.drawing && !keep_group {
                    ix.group_add(p, e.draw_index, id);
                }
            }
            if let Some(m) = e.material {
                if !keep_material {
                    ix.mat_users.insert((m, id));
                }
            }
            ix.item.insert(id, e);
            texu_check.push(id);
            meshu_check.push(id);
            eff_work.push(id);
        }

        // Items: derived unsupported-texture.
        if !all {
            for &t in &u_changed {
                texu_check.extend(users(&ix.tex_users, t));
            }
        }
        for &id in &texu_check {
            let Some(e) = ix.item.get(&id) else { continue };
            let mut methods: Vec<u8> = e
                .tex_refs
                .iter()
                .filter(|&&(t, _)| ix.tex.get(&t).is_some_and(|x| x.u))
                .map(|&(_, m)| m)
                .collect();
            sorted_dedup(&mut methods);
            let e = ix.item.get_mut(&id).unwrap();
            if methods != e.tex_unsup {
                ix.n_tex_unsup = ix.n_tex_unsup + methods.len() - e.tex_unsup.len();
                e.tex_unsup = methods;
            }
        }
        // unsupported-mesh.
        if !all {
            for &m in &mesh_changed {
                meshu_check.extend(users(&ix.mesh_users, m));
            }
        }
        for &id in &meshu_check {
            let Some(e) = ix.item.get(&id) else { continue };
            let nu = e
                .meshes
                .iter()
                .any(|m| ix.mesh.get(m) == Some(&EntryStatus::Unsupported));
            let e = ix.item.get_mut(&id).unwrap();
            if nu != e.mesh_unsup {
                if nu {
                    ix.n_mesh_unsup += 1;
                } else {
                    ix.n_mesh_unsup -= 1;
                }
                e.mesh_unsup = nu;
            }
        }
        // unsupported-multimesh (/11): the items meshu_check visits, plus the users of every
        // multimesh whose status changed.
        // unsupported-particles (/12): likewise, with the users of every emitter whose status
        // changed.
        let mut ptu_check = if v >= 12 { meshu_check.clone() } else { Vec::new() };
        if v >= 11 {
            let mut mmu_check = meshu_check;
            if !all {
                for &m in &mm_changed {
                    mmu_check.extend(users(&ix.mm_users, m));
                }
            }
            for &id in &mmu_check {
                let Some(e) = ix.item.get(&id) else { continue };
                let nu = e
                    .mms
                    .iter()
                    .any(|m| ix.mm.get(m) == Some(&EntryStatus::Unsupported));
                let e = ix.item.get_mut(&id).unwrap();
                if nu != e.mm_unsup {
                    if nu {
                        ix.n_mm_unsup += 1;
                    } else {
                        ix.n_mm_unsup -= 1;
                    }
                    e.mm_unsup = nu;
                }
            }
        }
        if v >= 12 {
            if !all {
                for &p in &pt_changed {
                    ptu_check.extend(users(&ix.pt_users, p));
                }
            }
            for &id in &ptu_check {
                let Some(e) = ix.item.get(&id) else { continue };
                let nu = e
                    .pts
                    .iter()
                    .any(|p| ix.pt.get(p) == Some(&EntryStatus::Unsupported));
                let e = ix.item.get_mut(&id).unwrap();
                if nu != e.pt_unsup {
                    if nu {
                        ix.n_pt_unsup += 1;
                    } else {
                        ix.n_pt_unsup -= 1;
                    }
                    e.pt_unsup = nu;
                }
            }
        }
        // Effective materials and unsupported-material (/5).
        if v >= 5 {
            while let Some(id) = eff_work.pop() {
                let Some(e) = ix.item.get(&id) else { continue };
                let ne = walk_eff(st, id);
                if ne == e.eff {
                    if all {
                        matu_check.push(id);
                    }
                    continue;
                }
                if let Some(o) = e.eff {
                    ix.eff_users.remove(&(o, id));
                }
                if let Some(n) = ne {
                    ix.eff_users.insert((n, id));
                }
                ix.item.get_mut(&id).unwrap().eff = ne;
                matu_check.push(id);
                if !all {
                    for c in users(&ix.claims, item_key(id)) {
                        if ix.item.get(&c).is_some_and(|x| x.upm) {
                            eff_work.push(c);
                        }
                    }
                }
            }
            if !all {
                for &m in &mat_changed {
                    matu_check.extend(users(&ix.eff_users, m));
                }
            }
            for &id in &matu_check {
                let Some(e) = ix.item.get(&id) else { continue };
                let nu = e.eff.and_then(|m| ix.mat.get(&m)).is_some_and(|m| m.unsup);
                let e = ix.item.get_mut(&id).unwrap();
                if nu != e.mat_unsup {
                    if nu {
                        ix.n_mat_unsup += 1;
                    } else {
                        ix.n_mat_unsup -= 1;
                    }
                    e.mat_unsup = nu;
                }
            }
        }
    }

    // --------------------------------------------------------------------------------- checks

    /// Everything `accept` checks after `applyTransaction`, in order.
    fn post_checks(&mut self, offset: usize) -> Result<(), Error> {
        if let Some(id) = self.cv_stable {
            return Err(Error::new(
                "content-version-stable",
                format!("record at offset {offset}: item {id}'s commands equal the base's, but its content_version moved"),
            ));
        }
        self.check_shader_time(offset)?;
        self.check_invariants()?;
        self.check_delivery(offset)?;
        self.check_adoption(offset)?;
        self.check_versions(offset)?;
        self.check_resources(offset)?;
        self.check_unnamed(offset)?;
        self.check_id_reuse(offset)
    }

    /// /11: computes the transaction's change to names(S) from its undo log (each changed or
    /// removed entry's old names out, its new names in: O(delta)) into `names_delta`, then checks
    /// `resource-unnamed`: every record accepted since the previous transaction is in names(S).
    fn check_unnamed(&mut self, offset: usize) -> Result<(), Error> {
        if self.opts.version < 11 {
            return Ok(());
        }
        let inline_max = self.session.resources.inline_max_bytes;
        let delta = &mut self.names_delta;
        delta.clear();
        let st = &self.state;
        let mut add = |h: Hash, required: bool, by: i64| {
            let e = delta.entry(h).or_default();
            e.all += by;
            if required {
                e.required += by;
            }
        };
        let mut ids: [Vec<Id>; 3] = Default::default();
        for u in &self.undo {
            match u {
                Undo::Texture(id, prev) => {
                    if let Some(p) = prev {
                        texture_names(p, inline_max, &mut |h, r| add(h, r, -1));
                    }
                    ids[0].push(*id);
                }
                Undo::Mesh(id, prev) => {
                    if let Some(p) = prev {
                        mesh_names(p, inline_max, &mut |h, r| add(h, r, -1));
                    }
                    ids[1].push(*id);
                }
                Undo::Shader(id, prev) => {
                    if let Some(p) = prev {
                        shader_names(p, inline_max, &mut |h, r| add(h, r, -1));
                    }
                    ids[2].push(*id);
                }
                _ => {}
            }
        }
        for v in ids.iter_mut() {
            sorted_dedup(v);
        }
        for id in &ids[0] {
            if let Some(t) = st.textures.get(id) {
                texture_names(t, inline_max, &mut |h, r| add(h, r, 1));
            }
        }
        for id in &ids[1] {
            if let Some(m) = st.meshes.get(id) {
                mesh_names(m, inline_max, &mut |h, r| add(h, r, 1));
            }
        }
        for id in &ids[2] {
            if let Some(s) = st.shaders.get(id) {
                shader_names(s, inline_max, &mut |h, r| add(h, r, 1));
            }
        }
        // W11d: the records before a transport skip named skipped states (transport_skip).
        let since_tx: &[Hash] = if self.skipping { &[] } else { &self.since_tx };
        for h in since_tx {
            let now = self.names.get(h).map_or(0, |n| n.all)
                + self.names_delta.get(h).map_or(0, |n| n.all);
            if now <= 0 {
                return Err(Error::new(
                    "resource-unnamed",
                    format!(
                        "record at offset {offset}: the resource record for hash {} is not named by this transaction's resolved state",
                        h.to_hex()
                    ),
                ));
            }
        }
        Ok(())
    }

    /// /11: names(S) ← names(S) + delta, then the prune C ← C ∩ names(S). Every hash of C was
    /// named by the base or brought by a record that S names (`resource-unnamed`), so a hash
    /// leaves C exactly when its count drops to zero here.
    fn commit_names(&mut self) {
        self.since_tx.clear();
        for (h, d) in self.names_delta.drain() {
            if d.all == 0 && d.required == 0 {
                continue;
            }
            let e = self.names.entry(h).or_default();
            e.all += d.all;
            e.required += d.required;
            if e.all <= 0 {
                self.names.remove(&h);
                self.released.push(h);
                if !self.no_prune && self.carried.remove(&h).is_some() {
                    self.pruned.push(h);
                }
            }
        }
        if self.skipping && !self.no_prune {
            // W11d (transport_skip): a record of a skipped transaction may name nothing S names,
            // so C is pruned to names(S) whole once, here.
            let names = &self.names;
            let (released, pruned) = (&mut self.released, &mut self.pruned);
            self.carried.retain(|h, _| {
                let keep = names.contains_key(h);
                if !keep {
                    released.push(*h);
                    pruned.push(*h);
                }
                keep
            });
        }
        self.released.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        self.released.dedup();
        self.pruned.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    }

    /// P3-TM (render-stream-10.md "Shader time"; `shader-time`): a /10 transaction carries
    /// `shader_time` exactly when its resolved state holds an `ok` shader whose `uses` names
    /// `time`.
    fn check_shader_time(&self, offset: usize) -> Result<(), Error> {
        if self.opts.version < 10 {
            return Ok(());
        }
        let reads = self
            .state
            .shaders
            .values()
            .any(|s| s.status == EntryStatus::Ok && s.uses.contains(&ShaderUse::Time));
        if reads != self.tx.shader_time_f.is_some() {
            return Err(Error::new(
                "shader-time",
                format!(
                    "record at offset {offset}: \"shader_time\" must be present exactly when the state holds an ok shader that uses time (it reads: {reads})"
                ),
            ));
        }
        Ok(())
    }

    /// `checkDeliveryInvariants` (render-stream-9.md "Texture entries"; `delivery-entry`): variants
    /// sit only on an ok image; they are sorted by encoding with at most one each; every one is an
    /// encoding the session's mode offers; a `block` variant carries a block format and null
    /// params; a Basis variant carries null format and params that start with the session's
    /// encoder; no variant repeats a hash of its entry; and a block format is never the base
    /// payload of an ok entry (legal only as a variant). Over what the transaction carries.
    fn check_delivery(&self, offset: usize) -> Result<(), Error> {
        if self.opts.version < 9 {
            return Ok(());
        }
        let Some(delivery) = &self.session.resources.texture_delivery else {
            return Ok(());
        };
        for t in &self.tx.textures {
            let err = |msg: String| {
                Error::new(
                    "delivery-entry",
                    format!("record at offset {offset}: texture {}: {msg}", t.id),
                )
            };
            let ok_image = t.kind == TextureKind::Image && t.status == EntryStatus::Ok;
            if let Some(f) = t.format.as_deref().filter(|f| ok_image && payload::block_format(f).is_some()) {
                return Err(err(format!(
                    "the base payload format {f} is a block format (legal only as a variant)"
                )));
            }
            if !t.variants.is_empty() && !ok_image {
                return Err(err("only an \"ok\" image entry carries variants".into()));
            }
            let mut previous: Option<usize> = None;
            let mut hashes: Vec<Hash> = t.hash.into_iter().collect();
            for v in &t.variants {
                let order = VariantEncoding::ALL.iter().position(|&e| e == v.encoding).unwrap();
                let name = v.encoding.as_str();
                if previous.is_some_and(|p| order <= p) {
                    return Err(err(format!(
                        "variants are not sorted by encoding with at most one each ({name})"
                    )));
                }
                previous = Some(order);
                if !meta::mode_offers(delivery.mode, v.encoding) {
                    return Err(err(format!(
                        "a {name} variant, but the session's mode \"{}\" does not offer it",
                        delivery.mode
                    )));
                }
                if v.payload_bytes < 1 {
                    return Err(err(format!("a {name} variant has payload_bytes 0")));
                }
                if hashes.contains(&v.hash) {
                    return Err(err(format!("a {name} variant repeats a hash of the same entry")));
                }
                hashes.push(v.hash);
                if v.encoding == VariantEncoding::Block {
                    match v.format.as_deref() {
                        Some(f) if payload::block_format(f).is_some() => {}
                        other => {
                            return Err(err(format!(
                                "a block variant's format {} is not a block format",
                                other.unwrap_or("null")
                            )))
                        }
                    }
                    if v.params.is_some() {
                        return Err(err("a block variant has params".into()));
                    }
                } else {
                    if v.format.is_some() {
                        return Err(err(format!("a {name} variant has a format")));
                    }
                    let Some(encoder) = &delivery.encoder else {
                        return Err(err(format!(
                            "a {name} variant, but the session declares no encoder"
                        )));
                    };
                    let prefixed = v
                        .params
                        .as_deref()
                        .is_some_and(|p| p.starts_with(&format!("{encoder}/")));
                    if !prefixed {
                        return Err(err(format!(
                            "a {name} variant's params do not start with the declared encoder {encoder}"
                        )));
                    }
                }
            }
        }
        Ok(())
    }

    /// `checkAdoptionInvariants` (render-stream-8.md "Resource tables"; `adoption-entry`,
    /// `decode-entry`), over what the transaction carries: an "adopted" origin on any canvas, item,
    /// texture, mesh, shader or material needs a session that declares `adoption`, and a texture's
    /// `source_format` is non-null only on an "ok" image whose payload format differs from it, in
    /// a session whose `resources.decode` is "engine". Any entry an earlier transaction carried
    /// was checked then, so this is the whole-state check TypeScript runs.
    fn check_adoption(&self, offset: usize) -> Result<(), Error> {
        if self.opts.version < 8 {
            return Ok(());
        }
        let tx = &self.tx;
        let e = |code: &'static str, msg: String| {
            Error::new(code, format!("record at offset {offset}: {msg}"))
        };
        if self.session.adoption.is_none() {
            let adopted = |what: &str, id: Id| {
                e(
                    "adoption-entry",
                    format!("{what} {id} has origin \"adopted\", but the session declares no adoption"),
                )
            };
            for c in &tx.canvases {
                if c.origin == Origin::Adopted {
                    return Err(adopted("canvas", c.id));
                }
            }
            for i in &tx.items {
                if i.origin == Origin::Adopted {
                    return Err(adopted("item", i.id));
                }
            }
            for t in &tx.textures {
                if t.origin == Origin::Adopted {
                    return Err(adopted("texture", t.id));
                }
            }
            for m in &tx.meshes {
                if m.origin == Origin::Adopted {
                    return Err(adopted("mesh", m.id));
                }
            }
            for s in &tx.shaders {
                if s.origin == Origin::Adopted {
                    return Err(adopted("shader", s.id));
                }
            }
            for m in &tx.materials {
                if m.origin == Origin::Adopted {
                    return Err(adopted("material", m.id));
                }
            }
            for p in &tx.particles {
                if p.origin == Origin::Adopted {
                    return Err(adopted("particles", p.id));
                }
            }
        }
        let decode_engine = self.session.resources.decode == Some("engine");
        for t in &tx.textures {
            let Some(source) = &t.source_format else {
                continue;
            };
            if t.kind != TextureKind::Image || t.status != EntryStatus::Ok {
                return Err(e(
                    "decode-entry",
                    format!("texture {}: source_format needs an \"ok\" image entry", t.id),
                ));
            }
            if t.format.as_deref() == Some(&**source) {
                return Err(e(
                    "decode-entry",
                    format!(
                        "texture {}: source_format equals the payload format {source}",
                        t.id
                    ),
                ));
            }
            if !decode_engine {
                return Err(e(
                    "decode-entry",
                    format!(
                        "texture {} declares source_format {source}, but the session's resources.decode is not \"engine\"",
                        t.id
                    ),
                ));
            }
        }
        Ok(())
    }

    /// `checkResolvedInvariants`, over what the transaction touched.
    fn check_invariants(&mut self) -> Result<(), Error> {
        let tx = &self.tx;
        let st = &self.state;
        let ix = &self.idx;
        let d = &self.dirty;
        let r = &self.removed;
        let v = self.opts.version;
        let w = where_(tx.seq);
        let first = |mut c: Vec<Id>| -> Option<Id> {
            c.sort_unstable();
            c.first().copied()
        };

        for t in &tx.textures {
            if let Some(msg) = texture_entry_error(t) {
                return Err(Error::new(
                    "texture-entry",
                    format!("{w}: texture {}: {msg}", t.id),
                ));
            }
        }
        for m in &tx.meshes {
            if let Some(msg) = mesh_entry_error(&st.meshes[&m.id]) {
                return Err(Error::new(
                    "mesh-entry",
                    format!("{w}: mesh {}: {msg}", m.id),
                ));
            }
        }
        for s in &tx.shaders {
            if (s.status == EntryStatus::Ok) != s.reason.is_none() {
                return Err(Error::new(
                    "shader-entry",
                    format!(
                        "{w}: shader {}: \"reason\" must be null exactly for status \"ok\"",
                        s.id
                    ),
                ));
            }
        }
        for m in &tx.materials {
            if (m.status == EntryStatus::Ok) != m.reason.is_none() {
                return Err(Error::new(
                    "material-entry",
                    format!(
                        "{w}: material {}: \"reason\" must be null exactly for status \"ok\"",
                        m.id
                    ),
                ));
            }
        }
        if v >= 5 {
            let mut bad: Vec<Id> = tx
                .materials
                .iter()
                .filter(|m| m.shader.is_some_and(|s| !st.shaders.contains_key(&s)))
                .map(|m| m.id)
                .collect();
            for &s in &r.shaders {
                bad.extend(users(&ix.shader_users, s));
            }
            if let Some(m) = first(bad) {
                let s = st.materials[&m].shader.unwrap_or(0);
                return Err(Error::new(
                    "shader-ref",
                    format!("{w}: material {m} names shader {s}, which has no entry"),
                ));
            }
            let mut bad: Vec<Id> = tx
                .items
                .iter()
                .filter(|i| i.material.is_some_and(|m| !st.materials.contains_key(&m)))
                .map(|i| i.id)
                .collect();
            for &m in &r.materials {
                bad.extend(users(&ix.mat_users, m));
            }
            if let Some(i) = first(bad) {
                let m = st.items[&i].material.unwrap_or(0);
                return Err(Error::new(
                    "material-ref",
                    format!("{w}: item {i} names material {m}, which has no entry"),
                ));
            }
        }
        if ix.root_count != 1 || !st.canvases.get(&1).is_some_and(|c| c.root) {
            return Err(Error::new(
                "root-canvas",
                format!("{w}: expected exactly one canvas with role \"root\" and id 1"),
            ));
        }
        // dangling-parent
        let exists = |p: &Parent| match p.kind {
            ParentKind::Canvas => st.canvases.contains_key(&p.id),
            ParentKind::Item => st.items.contains_key(&p.id),
        };
        let mut bad: Vec<Id> = tx
            .items
            .iter()
            .filter(|i| i.parent.as_ref().is_some_and(|p| !exists(p)))
            .map(|i| i.id)
            .collect();
        for &c in &r.canvases {
            bad.extend(users(&ix.claims, canvas_key(c)));
        }
        for &i in &r.items {
            bad.extend(users(&ix.claims, item_key(i)));
        }
        if let Some(i) = first(bad) {
            let p = st.items[&i].parent.unwrap();
            return Err(Error::new(
                "dangling-parent",
                format!(
                    "{w}: item {i} names parent {}:{}, which does not exist",
                    p.kind.as_str(),
                    p.id
                ),
            ));
        }
        // child-list-mismatch: canvases first, then items, lowest id first.
        let mut keys: Vec<PKey> =
            Vec::with_capacity(tx.canvases.len() + tx.items.len() + ix.touched.len());
        keys.extend(tx.canvases.iter().map(|c| canvas_key(c.id)));
        keys.extend(tx.items.iter().map(|i| item_key(i.id)));
        keys.extend(&ix.touched);
        sorted_dedup(&mut keys);
        let mut scratch: Vec<Id> = Vec::new();
        for &k in &keys {
            let id = k as Id;
            let declared: &[Id] = if k >> 32 == 0 {
                match st.canvases.get(&id) {
                    Some(c) => &c.items,
                    None => continue,
                }
            } else {
                match st.items.get(&id) {
                    Some(i) => &i.children,
                    None => continue,
                }
            };
            // G7o3: the declared list, sorted, must be the claims (ascending, distinct) exactly:
            // the same count, all claimed, no duplicate; one range walk, no lookup per child.
            scratch.clear();
            scratch.extend_from_slice(declared);
            scratch.sort_unstable();
            let ok = scratch
                .iter()
                .copied()
                .eq(ix.claims.range((k, 0)..=(k, Id::MAX)).map(|&(_, c)| c));
            if !ok {
                let what = if k >> 32 == 0 {
                    format!("canvas {id}'s items[]")
                } else {
                    format!("item {id}'s children[]")
                };
                return Err(Error::new(
                    "child-list-mismatch",
                    format!("{w}: {what} disagrees with items' parent fields"),
                ));
            }
        }
        // parent-cycle: a new cycle runs through an item whose parent changed (or a new item).
        let mut ok_set: std::collections::HashSet<Id, BuildHasherDefault<IdHasher>> =
            Default::default();
        let mut path: Vec<Id> = Vec::new();
        let mut starts: Vec<Id> = d
            .items
            .iter()
            .map(|&(i, _)| i)
            .filter(|i| st.items.contains_key(i))
            .collect();
        starts.sort_unstable();
        for &start in &starts {
            path.clear();
            let mut cur = start;
            loop {
                if ok_set.contains(&cur) {
                    break;
                }
                path.push(cur);
                let next = match st.items[&cur].parent {
                    Some(Parent {
                        kind: ParentKind::Item,
                        id,
                    }) if st.items.contains_key(&id) => id,
                    _ => break,
                };
                if path.contains(&next) || path.len() > st.items.len() {
                    return Err(Error::new(
                        "parent-cycle",
                        format!("{w}: following parent links revisits item {next}"),
                    ));
                }
                cur = next;
            }
            ok_set.extend(path.iter().copied());
        }
        // texture-ref
        let mut bad: Vec<Id> = Vec::new();
        for &(i, cmds_changed) in &d.items {
            if !cmds_changed {
                continue;
            }
            if let Some(e) = ix.item.get(&i) {
                if e.tex_ids.iter().any(|t| !st.textures.contains_key(t)) {
                    bad.push(i);
                }
            }
        }
        for &t in &r.textures {
            bad.extend(users(&ix.tex_users, t));
        }
        if let Some(i) = first(bad) {
            let (op, t) = st.items[&i]
                .commands
                .list
                .iter()
                .find_map(|c| {
                    c.tex()
                        .filter(|t| !st.textures.contains_key(t))
                        .map(|t| (c.op(), t))
                })
                .unwrap_or(("?", 0));
            return Err(Error::new(
                "texture-ref",
                format!("{w}: item {i}'s {op} names texture {t}, which has no entry"),
            ));
        }
        let mut bad: Vec<Id> = Vec::new();
        let diffuse_ok = |t: Id| {
            st.textures
                .get(&t)
                .is_some_and(|x| matches!(x.kind, TextureKind::Image | TextureKind::Placeholder))
        };
        for t in &tx.textures {
            if let Some(df) = t.canvas.as_ref().and_then(|c| c.diffuse) {
                if !diffuse_ok(df) {
                    bad.push(t.id);
                }
            }
            if t.kind == TextureKind::Canvas {
                bad.extend(users(&ix.diffuse_users, t.id));
            }
        }
        for &t in &r.textures {
            bad.extend(users(&ix.diffuse_users, t));
        }
        if let Some(t) = first(bad) {
            let df = st.textures[&t]
                .canvas
                .as_ref()
                .and_then(|c| c.diffuse)
                .unwrap_or(0);
            return Err(Error::new(
                "texture-ref",
                match st.textures.get(&df) {
                    None => format!("{w}: canvas texture {t}'s diffuse names texture {df}, which has no entry"),
                    Some(x) => format!(
                        "{w}: canvas texture {t}'s diffuse names texture {df}, whose kind is \"{}\" (must be image or placeholder)",
                        x.kind.as_str()
                    ),
                },
            ));
        }
        // mesh-ref
        let mut bad: Vec<Id> = Vec::new();
        for &(i, cmds_changed) in &d.items {
            if !cmds_changed {
                continue;
            }
            if let Some(e) = ix.item.get(&i) {
                if e.meshes.iter().any(|m| !st.meshes.contains_key(m)) {
                    bad.push(i);
                }
            }
        }
        for &m in &r.meshes {
            bad.extend(users(&ix.mesh_users, m));
        }
        if let Some(i) = first(bad) {
            let m = ix.item[&i]
                .meshes
                .iter()
                .copied()
                .find(|m| !st.meshes.contains_key(m))
                .unwrap_or(0);
            return Err(Error::new(
                "mesh-ref",
                format!("{w}: item {i}'s add_mesh names mesh {m}, which has no entry"),
            ));
        }
        // multimesh-ref (/11, render-stream-11.md "As built (PM1)" rule 6).
        if v >= 11 {
            let mut bad: Vec<Id> = Vec::new();
            for &(i, cmds_changed) in &d.items {
                if !cmds_changed {
                    continue;
                }
                if let Some(e) = ix.item.get(&i) {
                    if e.mms.iter().any(|m| !st.multimeshes.contains_key(m)) {
                        bad.push(i);
                    }
                }
            }
            for &m in &r.multimeshes {
                bad.extend(users(&ix.mm_users, m));
            }
            if let Some(i) = first(bad) {
                let m = ix.item[&i]
                    .mms
                    .iter()
                    .copied()
                    .find(|m| !st.multimeshes.contains_key(m))
                    .unwrap_or(0);
                return Err(Error::new(
                    "multimesh-ref",
                    format!(
                        "{w}: item {i}'s add_multimesh names multimesh {m}, which has no entry"
                    ),
                ));
            }
            // A multimesh's mesh names an entry of the resolved mesh table (any status): the
            // entries this transaction carried, and every entry when a mesh left the table.
            let dangling = |mm: &Multimesh| mm.mesh.filter(|x| !st.meshes.contains_key(x));
            let found = if r.meshes.is_empty() {
                tx.multimeshes
                    .iter()
                    .find_map(|m| dangling(&st.multimeshes[&m.id]).map(|x| (m.id, x)))
            } else {
                st.multimeshes
                    .values()
                    .find_map(|m| dangling(m).map(|x| (m.id, x)))
            };
            if let Some((id, mesh)) = found {
                return Err(Error::new(
                    "multimesh-ref",
                    format!("{w}: multimesh {id} names mesh {mesh}, which has no entry"),
                ));
            }
        }
        // particles-ref (/12, render-stream-12.md "References"): every add_particles names a
        // resolved particles entry (any status); every entry's process material, draw passes and
        // subemitter name resolved entries.
        if v >= 12 {
            let mut bad: Vec<Id> = Vec::new();
            for &(i, cmds_changed) in &d.items {
                if !cmds_changed {
                    continue;
                }
                if let Some(e) = ix.item.get(&i) {
                    if e.pts.iter().any(|p| !st.particles.contains_key(p)) {
                        bad.push(i);
                    }
                }
            }
            for &p in &r.particles {
                bad.extend(users(&ix.pt_users, p));
            }
            if let Some(i) = first(bad) {
                let p = ix.item[&i]
                    .pts
                    .iter()
                    .copied()
                    .find(|p| !st.particles.contains_key(p))
                    .unwrap_or(0);
                return Err(Error::new(
                    "particles-ref",
                    format!("{w}: item {i}'s add_particles names particles {p}, which has no entry"),
                ));
            }
            let dangling = |p: &Particles| -> Option<String> {
                if let Some(m) = p.process_material.filter(|x| !st.materials.contains_key(x)) {
                    return Some(format!("process material {m}"));
                }
                if let Some(m) = p
                    .draw_passes
                    .iter()
                    .flatten()
                    .find(|x| !st.meshes.contains_key(x))
                {
                    return Some(format!("draw pass mesh {m}"));
                }
                p.subemitter
                    .filter(|x| !st.particles.contains_key(x))
                    .map(|x| format!("subemitter particles {x}"))
            };
            let whole = !(r.materials.is_empty() && r.meshes.is_empty() && r.particles.is_empty());
            let found = if whole {
                st.particles
                    .values()
                    .find_map(|p| dangling(p).map(|x| (p.id, x)))
            } else {
                tx.particles
                    .iter()
                    .find_map(|p| dangling(&st.particles[&p.id]).map(|x| (p.id, x)))
            };
            if let Some((id, what)) = found {
                return Err(Error::new(
                    "particles-ref",
                    format!("{w}: particles {id} names {what}, which has no entry"),
                ));
            }
        }
        self.check_unsupported(&w)
    }

    /// The declared `unsupported[]` list against the maintained derived entries.
    #[allow(clippy::collapsible_match)]
    fn check_unsupported(&self, w: &str) -> Result<(), Error> {
        let tx = &self.tx;
        let st = &self.state;
        let ix = &self.idx;
        let v = self.opts.version;
        let mm = |d: String| Error::new("unsupported-mismatch", format!("{w}: {d}"));
        let mut last_item: i64 = -1;
        let mut last_op: &[u8] = b"";
        let mut item_level = false;
        let (mut d_ops, mut d_ties, mut d_tex, mut d_mesh, mut d_mat) =
            (0usize, 0usize, 0usize, 0usize, 0usize);
        let mut d_mm = 0usize;
        let mut d_pt = 0usize;
        let mut declared_stack = false;
        let mut declared_snap = false;
        let actual_stack = v >= 6 && ix.stack_ties > 0;
        // WB (/11): a patch's null `unsupported` resolves to the base's list, which must still
        // hold for the new state.
        let entries: Box<dyn Iterator<Item = (&str, Option<i64>, &'static str)>> =
            if tx.unsupported_null {
                Box::new(
                    st.unsupported
                        .iter()
                        .map(|u| (&*u.op, u.item.map(|i| i as i64), u.reason)),
                )
            } else {
                Box::new(tx.unsupported.iter().map(|u| (&*u.op, u.item, u.reason)))
            };
        for (op, item, reason) in entries {
            let Some(item) = item else {
                if item_level {
                    return Err(mm(format!(
                        "session-level entry {op} follows an item-level entry"
                    )));
                }
                if reason == "canvas-light" && op != "canvas_light_attach_to_canvas" {
                    return Err(mm(format!(
                        "canvas-light entry names op {op}, expected canvas_light_attach_to_canvas"
                    )));
                }
                if v >= 6 && reason == "extra-canvas" {
                    return Err(mm(format!(
                        "extra-canvas entry (op {op}) is never valid at /6 (a canvas attached to the root viewport is supported)"
                    )));
                }
                match reason {
                    "canvas-stacking-tie" => {
                        if op != "viewport_set_canvas_stacking" {
                            return Err(mm(format!("canvas-stacking-tie entry names op {op}, expected viewport_set_canvas_stacking")));
                        }
                        if !actual_stack {
                            return Err(mm("canvas-stacking-tie entry does not correspond to two attached canvases sharing (layer, sublayer)".into()));
                        }
                        declared_stack = true;
                    }
                    "canvas-repeat" => {
                        if op != "canvas_set_item_mirroring" && op != "canvas_set_item_repeat" {
                            return Err(mm(format!(
                                "canvas-repeat entry names op {op}, expected canvas_set_item_mirroring or canvas_set_item_repeat"
                            )));
                        }
                    }
                    "canvas-follow-viewport" => {
                        if op != "canvas_set_parent" {
                            return Err(mm(format!("canvas-follow-viewport entry names op {op}, expected canvas_set_parent")));
                        }
                    }
                    "global-canvas-transform" => {
                        if op != "viewport_set_global_canvas_transform" {
                            return Err(mm(format!(
                                "global-canvas-transform entry names op {op}, expected viewport_set_global_canvas_transform"
                            )));
                        }
                    }
                    "snap-2d" => {
                        if op != "viewport_set_snap_2d_transforms_to_pixel"
                            && op != "viewport_set_snap_2d_vertices_to_pixel"
                        {
                            return Err(mm(format!("snap-2d entry names op {op}, expected a viewport_set_snap_2d_*_to_pixel setter")));
                        }
                        if !self.snap_declared {
                            return Err(mm(
                                "snap-2d entry present while the session declares no snap_2d flag"
                                    .into(),
                            ));
                        }
                        declared_snap = true;
                    }
                    _ => {}
                }
                continue;
            };
            item_level = true;
            let id = u32::try_from(item)
                .ok()
                .filter(|i| st.items.contains_key(i));
            let Some(id) = id else {
                return Err(Error::new(
                    "dangling-parent",
                    format!("{w}: unsupported entry names item {item}, which does not exist"),
                ));
            };
            if item < last_item
                || (item == last_item
                    && crate::json::js_cmp(op.as_bytes(), last_op) != std::cmp::Ordering::Greater)
            {
                return Err(mm(format!(
                    "unsupported entry ({item}, {op}) is out of order or repeated"
                )));
            }
            last_item = item;
            last_op = op.as_bytes();
            let x = &ix.item[&id];
            match reason {
                "unsupported-op"
                | "unknown-texture"
                | "canvas-texture-headless"
                | "unknown-mesh"
                | "skinned-geometry"
                | "unknown-multimesh"
                | "unknown-particles" => {
                    let cmds = &st.items[&id].commands.list;
                    let actual = x
                        .ops
                        .iter()
                        .find_map(|&(k, reason)| match &cmds[k as usize] {
                            Command::Unsupported { name, .. } if &**name == op => Some(reason),
                            _ => None,
                        });
                    if actual != Some(reason) {
                        return Err(mm(format!(
                            "{} entry ({item}, {op}) has no matching command",
                            reason
                        )));
                    }
                    d_ops += 1;
                }
                "draw-index-tie" => {
                    if op != "canvas_item_set_draw_index" {
                        return Err(mm(format!(
                            "draw-index-tie entry for item {item} names op {op}, expected canvas_item_set_draw_index"
                        )));
                    }
                    if !ix.is_tie_item(id) {
                        return Err(mm(format!("draw-index-tie entry for item {item} does not correspond to an actual tie")));
                    }
                    d_ties += 1;
                }
                "unsupported-state" => {
                    if v >= 5 && op == "canvas_item_set_material" {
                        return Err(mm(format!(
                            "unsupported-state entry for item {item} names canvas_item_set_material, which /5 decoders reject (superseded by unsupported-material/unknown-material)"
                        )));
                    }
                    if op != "canvas_item_set_material" && op != "canvas_item_attach_skeleton" {
                        return Err(mm(format!(
                            "unsupported-state entry for item {item} names {op}, expected canvas_item_set_material or canvas_item_attach_skeleton"
                        )));
                    }
                }
                "unsupported-texture" => {
                    let m = RS_METHODS.iter().position(|&m| m == op).map(|m| m as u8);
                    if !m.is_some_and(|m| x.tex_unsup.contains(&m)) {
                        return Err(mm(format!(
                            "unsupported-texture entry ({item}, {op}) does not correspond to a command naming an unsupported texture"
                        )));
                    }
                    d_tex += 1;
                }
                "unsupported-mesh" => {
                    if !(op == "canvas_item_add_mesh" && x.mesh_unsup) {
                        return Err(mm(format!(
                            "unsupported-mesh entry ({item}, {op}) does not correspond to an add_mesh naming an unsupported mesh"
                        )));
                    }
                    d_mesh += 1;
                }
                "unsupported-multimesh" => {
                    if !(op == "canvas_item_add_multimesh" && x.mm_unsup) {
                        return Err(mm(format!(
                            "unsupported-multimesh entry ({item}, {op}) does not correspond to an add_multimesh naming an unsupported multimesh"
                        )));
                    }
                    d_mm += 1;
                }
                "unsupported-particles" => {
                    if !(op == "canvas_item_add_particles" && x.pt_unsup) {
                        return Err(mm(format!(
                            "unsupported-particles entry ({item}, {op}) does not correspond to an add_particles naming an unsupported emitter"
                        )));
                    }
                    d_pt += 1;
                }
                "unsupported-material" => {
                    if op != "canvas_item_set_material" {
                        return Err(mm(format!(
                            "unsupported-material entry for item {item} names {op}, expected canvas_item_set_material"
                        )));
                    }
                    if !x.mat_unsup {
                        return Err(mm(format!(
                            "unsupported-material entry ({item}, {op}) does not correspond to an item whose effective material is unsupported"
                        )));
                    }
                    d_mat += 1;
                }
                "unknown-material" => {
                    if op != "canvas_item_set_material" {
                        return Err(mm(format!(
                            "unknown-material entry for item {item} names {op}, expected canvas_item_set_material"
                        )));
                    }
                    if v >= 5 && st.items[&id].material.is_some() {
                        return Err(mm(format!("unknown-material entry for item {item}, whose resolved material is non-null")));
                    }
                }
                "param-type" => {
                    if op != "canvas_item_set_instance_shader_parameter" {
                        return Err(mm(format!(
                            "param-type entry for item {item} names {op}, expected canvas_item_set_instance_shader_parameter"
                        )));
                    }
                }
                _ => {}
            }
        }
        if d_ops != ix.n_ops {
            return Err(mm(
                "an unsupported command has no matching unsupported[] entry".into(),
            ));
        }
        if d_ties != ix.tie_groups {
            return Err(mm(
                "items tie on draw_index, but no draw-index-tie entry is declared".into(),
            ));
        }
        if d_tex != ix.n_tex_unsup {
            return Err(mm("a tex-bearing command names an unsupported texture, with no unsupported-texture entry".into()));
        }
        if d_mesh != ix.n_mesh_unsup {
            return Err(mm(
                "an add_mesh command names an unsupported mesh, with no unsupported-mesh entry"
                    .into(),
            ));
        }
        if d_mm != ix.n_mm_unsup {
            return Err(mm(
                "an add_multimesh command names an unsupported multimesh, with no unsupported-multimesh entry"
                    .into(),
            ));
        }
        if d_pt != ix.n_pt_unsup {
            return Err(mm(
                "an add_particles command names an unsupported emitter, with no unsupported-particles entry"
                    .into(),
            ));
        }
        if v >= 5 && d_mat != ix.n_mat_unsup {
            return Err(mm(
                "an item's effective material is unsupported, with no unsupported-material entry"
                    .into(),
            ));
        }
        if actual_stack && !declared_stack {
            return Err(mm(
                "two attached canvases share (layer, sublayer), but no canvas-stacking-tie entry is declared".into(),
            ));
        }
        if self.snap_declared && !declared_snap {
            return Err(mm(
                "the session declares a snap_2d flag, but this transaction has no snap-2d entry"
                    .into(),
            ));
        }
        Ok(())
    }

    /// texture-version / mesh-version / shader-version / material-version.
    fn check_versions(&self, offset: usize) -> Result<(), Error> {
        let tx = &self.tx;
        let st = &self.state;
        let e = |code: &'static str, what: &str, id: Id| {
            Error::new(
                code,
                format!("record at offset {offset}: {what} {id}'s version/content is inconsistent with its earlier entry"),
            )
        };
        for t in &tx.textures {
            if let Some(p) = self.last_texture.get(&t.id) {
                let regressed = t.version < p.version
                    || (t.version == p.version
                        && !texture_states_equal(p, t)
                        && !variants_only_grew(p, t)
                        && (p.status == EntryStatus::Freed || t.status != EntryStatus::Freed));
                if regressed {
                    return Err(e("texture-version", "texture", t.id));
                }
            }
        }
        for m in &tx.meshes {
            let cur = &st.meshes[&m.id];
            if let Some(p) = self.last_mesh.get(&m.id) {
                let regressed = cur.version < p.version
                    || (cur.version == p.version
                        && !mesh_states_equal(p, cur)
                        && (p.status == EntryStatus::Freed || cur.status != EntryStatus::Freed));
                if regressed {
                    return Err(e("mesh-version", "mesh", m.id));
                }
            }
        }
        // PM1: the floats' half of `multimesh-version` (the JSON half ran before resolving): at an
        // unmoved version the custom AABB and the buffer's digest are the earlier entry's.
        for m in &tx.multimeshes {
            if let Some(p) = self.last_multimesh.get(&m.id) {
                let cur = &st.multimeshes[&m.id];
                if cur.version == p.version && !mm_floats_equal(p, cur) {
                    return Err(Error::new(
                        "multimesh-version",
                        format!("record at offset {offset}: multimesh {}'s custom AABB or buffer changed, but its version {} did not move", m.id, cur.version),
                    ));
                }
            }
        }
        // PM5: the floats' half of `particles-version` (render-stream-12.md "`version`"): at an
        // unmoved version every float is the earlier entry's, by bit pattern.
        for p in &tx.particles {
            if let Some(q) = self.last_particles.get(&p.id) {
                let cur = &st.particles[&p.id];
                if cur.version == q.version && !pt_floats_equal(q, cur) {
                    return Err(Error::new(
                        "particles-version",
                        format!("record at offset {offset}: particles {}'s floats changed, but its version {} did not move", p.id, cur.version),
                    ));
                }
            }
        }
        for s in &tx.shaders {
            if let Some(p) = self.last_shader.get(&s.id) {
                if s.version < p.version || (s.version == p.version && !shader_states_equal(p, s)) {
                    return Err(e("shader-version", "shader", s.id));
                }
            }
        }
        for m in &tx.materials {
            let cur = &st.materials[&m.id];
            if let Some(p) = self.last_material.get(&m.id) {
                if cur.version < p.version
                    || (cur.version == p.version && !material_states_equal(p, cur))
                {
                    return Err(e("material-version", "material", m.id));
                }
            }
        }
        Ok(())
    }

    /// resource-missing / resource-payload: only an entry this transaction carries can newly fail.
    fn check_resources(&self, offset: usize) -> Result<(), Error> {
        let tx = &self.tx;
        let inline_max = self.session.resources.inline_max_bytes;
        let tail = if self.opts.version >= 11 {
            "is not in the carried set C"
        } else {
            "never arrived as a resource record"
        };
        let missing = |what: String, h: &Hash, pb: i64| {
            Error::new(
                "resource-missing",
                format!(
                    "record at offset {offset}: {what}'s hash {} (payload_bytes {pb} <= inline_max_bytes {inline_max}) {tail}",
                    h.to_hex()
                ),
            )
        };
        for t in &tx.textures {
            if t.kind != TextureKind::Image || t.status != EntryStatus::Ok {
                continue;
            }
            let Some(h) = t.hash else { continue };
            if t.payload_bytes > inline_max {
                continue;
            }
            match self.carried.get(&h) {
                None => return Err(missing(format!("texture {}", t.id), &h, t.payload_bytes)),
                Some(Carried::Texture {
                    format,
                    width,
                    height,
                    mipmaps,
                    len,
                }) => {
                    if t.format.as_deref() != Some(format.as_str())
                        || *width != t.width
                        || *height != t.height
                        || *mipmaps != t.mipmaps
                        || *len != t.payload_bytes
                    {
                        return Err(Error::new(
                            "resource-payload",
                            format!(
                                "record at offset {offset}: the resource for hash {} decodes as {format} {width}x{height}, texture {} declares {} {}x{}",
                                h.to_hex(),
                                t.id,
                                t.format.as_deref().unwrap_or("null"),
                                t.width,
                                t.height
                            ),
                        ));
                    }
                }
                Some(_) => {}
            }
            // render-stream-9.md: a variant's payload, when this stream carries it, has the
            // entry's shape. Variants are never required to arrive as resource records.
            for v in &t.variants {
                let Some(carried) = self.carried.get(&v.hash) else {
                    continue;
                };
                let bad = |msg: String| {
                    Error::new(
                        "resource-payload",
                        format!("record at offset {offset}: {msg}"),
                    )
                };
                if v.encoding == VariantEncoding::Block {
                    let ok = matches!(carried, Carried::Texture { format, width, height, mipmaps, len }
                        if v.format.as_deref() == Some(format.as_str())
                            && *width == t.width
                            && *height == t.height
                            && *mipmaps == t.mipmaps
                            && *len == v.payload_bytes);
                    if !ok {
                        return Err(bad(format!(
                            "the resource for block variant {} of texture {} is not a {} {}x{} GRT1 payload of {} bytes",
                            v.hash.to_hex(),
                            t.id,
                            v.format.as_deref().unwrap_or("null"),
                            t.width,
                            t.height,
                            v.payload_bytes
                        )));
                    }
                } else {
                    let Carried::Ktx2 { shape, len } = carried else {
                        return Err(bad(format!(
                            "the resource for {} variant {} of texture {} is not a KTX2 file",
                            v.encoding.as_str(),
                            v.hash.to_hex(),
                            t.id
                        )));
                    };
                    payload::check_ktx2_shape(shape, v.encoding.as_str(), t.width, t.height, t.mipmaps)
                        .map_err(|e| {
                            Error::new(
                                e.code,
                                format!("{} (record at offset {offset}, texture {})", e, t.id),
                            )
                        })?;
                    if *len != v.payload_bytes {
                        return Err(Error::new(
                            "ktx2-shape",
                            format!(
                                "record at offset {offset}: texture {}'s {} variant declares {} bytes, the file has {len}",
                                t.id,
                                v.encoding.as_str(),
                                v.payload_bytes
                            ),
                        ));
                    }
                }
            }
        }
        for m in &tx.meshes {
            if m.status != EntryStatus::Ok {
                continue;
            }
            for s in &m.surfaces {
                // /11: a dynamic surface has no payload hash (its body is in `mesh_u8`).
                let Some(sh) = s.hash else { continue };
                if s.payload_bytes > inline_max {
                    continue;
                }
                match self.carried.get(&sh) {
                    None => {
                        return Err(missing(
                            format!("mesh {}'s surface", m.id),
                            &sh,
                            s.payload_bytes,
                        ))
                    }
                    Some(Carried::Mesh {
                        primitive,
                        format,
                        vertex_count,
                        index_count,
                        len,
                    }) => {
                        if *primitive != s.primitive
                            || *format != s.format
                            || *vertex_count != s.vertex_count
                            || *index_count != s.index_count
                            || *len != s.payload_bytes
                        {
                            return Err(Error::new(
                                "resource-payload",
                                format!(
                                    "record at offset {offset}: the resource for hash {} decodes as {} vertex_count {vertex_count}, mesh {} declares {} vertex_count {}",
                                    sh.to_hex(),
                                    primitive.as_str(),
                                    m.id,
                                    s.primitive.as_str(),
                                    s.vertex_count
                                ),
                            ));
                        }
                    }
                    Some(_) => {}
                }
            }
        }
        for s in &tx.shaders {
            if s.status != EntryStatus::Ok || s.source != Some(ShaderSource::Payload) {
                continue;
            }
            let Some(h) = s.hash else { continue };
            if s.payload_bytes > inline_max {
                continue;
            }
            match self.carried.get(&h) {
                None => return Err(missing(format!("shader {}", s.id), &h, s.payload_bytes)),
                Some(Carried::Shader { len }) if *len != s.payload_bytes => {
                    return Err(Error::new(
                        "resource-payload",
                        format!(
                            "record at offset {offset}: the resource for hash {} is {len} bytes, shader {} declares payload_bytes {}",
                            h.to_hex(),
                            s.id,
                            s.payload_bytes
                        ),
                    ))
                }
                Some(_) => {}
            }
        }
        Ok(())
    }

    /// id-reused, against the previous transaction's ids.
    fn check_id_reuse(&self, offset: usize) -> Result<(), Error> {
        let tx = &self.tx;
        let v = self.opts.version;
        let lists: [(&str, Vec<Id>); 6] = [
            ("canvas", tx.canvases.iter().map(|c| c.id).collect()),
            ("item", tx.items.iter().map(|c| c.id).collect()),
            ("texture", tx.textures.iter().map(|c| c.id).collect()),
            ("mesh", tx.meshes.iter().map(|c| c.id).collect()),
            ("shader", tx.shaders.iter().map(|c| c.id).collect()),
            ("material", tx.materials.iter().map(|c| c.id).collect()),
        ];
        for (k, (kind, ids)) in lists.iter().enumerate() {
            if k == 3 && v < 4 || k >= 4 && v < 5 {
                continue;
            }
            for (j, &id) in ids.iter().enumerate() {
                if self.was_new[k][j] && id as i64 <= self.max_id[k] {
                    return Err(Error::new(
                        "id-reused",
                        format!("record at offset {offset}: {kind} id {id} reappears after not being in the previous transaction"),
                    ));
                }
            }
        }
        Ok(())
    }

    // --------------------------------------------------------------------------------- commit

    fn commit(&mut self) {
        let tx = &mut self.tx;
        let st = &mut self.state;
        let full = tx.is_full();
        st.seq = tx.seq;
        st.frame = tx.frame;
        st.encoding = tx.encoding();
        st.status = tx.status.unwrap_or(TxStatus::Ok);
        st.failures = std::mem::take(&mut tx.failures);
        // WB (/11): a patch's null `unsupported` keeps the base's list.
        if !tx.unsupported_null {
            st.unsupported = tx
                .unsupported
                .drain(..)
                .map(|u| UnsupportedEntry {
                    op: u.op,
                    item: u.item.map(|i| i as Id),
                    reason: u.reason,
                })
                .collect();
        }
        st.unknown_items = tx.unknown_items;
        st.shader_time = self.shader_time;

        for t in &tx.textures {
            self.last_texture.insert(t.id, t.clone());
        }
        // PH2: the earlier entries are overwritten in place (no per-transaction reallocation).
        for m in &tx.meshes {
            let cur = &st.meshes[&m.id];
            match self.last_mesh.get_mut(&m.id) {
                Some(e) => e.assign_from(cur),
                None => {
                    self.last_mesh.insert(m.id, cur.clone());
                }
            }
        }
        for s in &tx.shaders {
            self.last_shader.insert(s.id, s.clone());
        }
        for m in &tx.materials {
            let cur = &st.materials[&m.id];
            match self.last_material.get_mut(&m.id) {
                Some(e) => e.assign_from(cur),
                None => {
                    self.last_material.insert(m.id, cur.clone());
                }
            }
        }
        for m in &tx.multimeshes {
            self.last_multimesh
                .insert(m.id, st.multimeshes[&m.id].clone());
        }
        for p in &tx.particles {
            self.last_particles
                .insert(p.id, st.particles[&p.id].clone());
        }
        let maxes = [
            tx.canvases.iter().map(|c| c.id).max(),
            tx.items.iter().map(|c| c.id).max(),
            tx.textures.iter().map(|c| c.id).max(),
            tx.meshes.iter().map(|c| c.id).max(),
            tx.shaders.iter().map(|c| c.id).max(),
            tx.materials.iter().map(|c| c.id).max(),
        ];
        for (k, m) in maxes.iter().enumerate() {
            if let Some(m) = m {
                self.max_id[k] = self.max_id[k].max(*m as i64);
            }
        }

        let d = &mut self.delta;
        d.clear();
        d.seq = tx.seq;
        d.full = full;
        d.canvases_upserted.extend(tx.canvases.iter().map(|c| c.id));
        d.items_upserted.extend(tx.items.iter().map(|c| c.id));
        d.items_commands.extend(
            tx.items
                .iter()
                .filter(|i| full || i.commands.is_some())
                .map(|i| i.id),
        );
        d.textures_upserted.extend(tx.textures.iter().map(|c| c.id));
        d.meshes_upserted.extend(tx.meshes.iter().map(|c| c.id));
        d.shaders_upserted.extend(tx.shaders.iter().map(|c| c.id));
        d.materials_upserted
            .extend(tx.materials.iter().map(|c| c.id));
        d.multimeshes_upserted
            .extend(tx.multimeshes.iter().map(|c| c.id));
        d.particles_upserted
            .extend(tx.particles.iter().map(|c| c.id));
        let r = &self.removed;
        d.canvases_removed.extend(&r.canvases);
        d.items_removed.extend(&r.items);
        d.textures_removed.extend(&r.textures);
        d.meshes_removed.extend(&r.meshes);
        d.shaders_removed.extend(&r.shaders);
        d.materials_removed.extend(&r.materials);
        d.multimeshes_removed.extend(&r.multimeshes);
        d.particles_removed.extend(&r.particles);
        d.defaults_changed =
            self.old_defaults != (st.default_texture_filter, st.default_texture_repeat);

        self.prev_seq = tx.seq;
        self.prev_frame = Some(tx.frame);
        self.tx_count += 1;
        if full {
            self.full_count += 1;
        } else {
            self.patch_count += 1;
        }
        if self.opts.version >= 11 {
            self.commit_names();
        }
        self.skipping = false;
        // Recycle the replaced items' and materials' buffers.
        for u in self.undo.drain(..) {
            match u {
                Undo::Item(_, Some(it), _) if self.item_pool.len() < 4096 => {
                    self.item_pool.push(it);
                }
                Undo::Material(_, Some(m)) if self.material_pool.len() < 1024 => {
                    self.material_pool.push(m);
                }
                _ => {}
            }
        }
    }
}

/// `validateRecording()`: the first error of a whole recording, or Ok.
pub fn validate_recording(data: &[u8], opts: Options) -> Result<(), Error> {
    let records = wire::split_records(data, opts.version)?;
    let Some(first) = records.first() else {
        return Err(Error::new(
            "missing-session",
            "the recording has no records",
        ));
    };
    let mut v = Validator::new(first.bytes(data), first.offset, opts)?;
    for r in &records[1..] {
        v.accept(r.bytes(data), r.offset)?;
    }
    v.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn protocol_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol")
    }

    /// Every entry `TxDelta` does not name is unchanged; every named one is where it says.
    fn check_delta(prev: &ResolvedState, next: &ResolvedState, d: &TxDelta) {
        fn side<T: PartialEq + std::fmt::Debug>(
            what: &str,
            prev: &crate::state::IdTable<T>,
            next: &crate::state::IdTable<T>,
            up: &[Id],
            rm: &[Id],
        ) {
            assert!(
                up.windows(2).all(|w| w[0] < w[1]),
                "{what} upserted ascending"
            );
            assert!(
                rm.windows(2).all(|w| w[0] < w[1]),
                "{what} removed ascending"
            );
            for id in rm {
                assert!(
                    prev.contains_key(id) && !next.contains_key(id),
                    "{what} {id} removed"
                );
            }
            for id in up {
                assert!(next.contains_key(id), "{what} {id} upserted");
            }
            for (id, v) in next {
                if up.binary_search(id).is_err() {
                    assert_eq!(prev.get(id), Some(v), "{what} {id} unchanged");
                }
            }
            for id in prev.keys() {
                if rm.binary_search(id).is_err() {
                    assert!(next.contains_key(id), "{what} {id} kept");
                }
            }
        }
        side(
            "canvas",
            &prev.canvases,
            &next.canvases,
            &d.canvases_upserted,
            &d.canvases_removed,
        );
        side(
            "item",
            &prev.items,
            &next.items,
            &d.items_upserted,
            &d.items_removed,
        );
        side(
            "texture",
            &prev.textures,
            &next.textures,
            &d.textures_upserted,
            &d.textures_removed,
        );
        side(
            "mesh",
            &prev.meshes,
            &next.meshes,
            &d.meshes_upserted,
            &d.meshes_removed,
        );
        side(
            "shader",
            &prev.shaders,
            &next.shaders,
            &d.shaders_upserted,
            &d.shaders_removed,
        );
        side(
            "material",
            &prev.materials,
            &next.materials,
            &d.materials_upserted,
            &d.materials_removed,
        );
        side(
            "multimesh",
            &prev.multimeshes,
            &next.multimeshes,
            &d.multimeshes_upserted,
            &d.multimeshes_removed,
        );
        side(
            "particles",
            &prev.particles,
            &next.particles,
            &d.particles_upserted,
            &d.particles_removed,
        );
        for id in &d.items_upserted {
            if d.items_commands.binary_search(id).is_err() {
                assert_eq!(
                    prev.items[id].commands, next.items[id].commands,
                    "item {id} commands kept"
                );
            }
        }
        assert_eq!(
            d.defaults_changed,
            (prev.default_texture_filter, prev.default_texture_repeat)
                != (next.default_texture_filter, next.default_texture_repeat)
        );
    }

    fn run_with_delta_check(data: &[u8], version: u8) -> usize {
        let records = wire::split_records(data, version).unwrap();
        let mut v = Validator::new(
            records[0].bytes(data),
            records[0].offset,
            Options::new(version),
        )
        .unwrap();
        let mut prev = v.state().clone();
        let mut n = 0;
        for r in &records[1..] {
            if v.accept(r.bytes(data), r.offset).unwrap() == Accepted::Transaction {
                check_delta(&prev, v.state(), v.delta());
                prev = v.state().clone();
                n += 1;
            }
        }
        v.finish().unwrap();
        n
    }

    #[test]
    fn goldens_pass() {
        let dir = protocol_dir();
        let read = |rel: &str| std::fs::read(dir.join(rel)).ok();
        let checks = crate::goldens::run_all(&read, None, crate::goldens::GoldenOptions::default());
        let failed: Vec<_> = checks
            .iter()
            .filter(|c| !c.ok)
            .map(|c| format!("{} ({})", c.name, c.detail))
            .collect();
        assert!(checks.len() > 500, "{} checks", checks.len());
        assert!(failed.is_empty(), "{failed:#?}");
    }

    #[test]
    fn skip_payload_hash_sabotage_is_caught() {
        let dir = protocol_dir();
        let read = |rel: &str| std::fs::read(dir.join(rel)).ok();
        let opts = crate::goldens::GoldenOptions {
            verify_payload_hashes: false,
            ..Default::default()
        };
        let checks = crate::goldens::run_golden(2, &read, opts);
        let failed: Vec<_> = checks
            .iter()
            .filter(|c| !c.ok)
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert!(failed[0].contains("invalid/resource-hash.rs2"));
    }

    #[test]
    fn delta_names_every_change_in_the_goldens() {
        let dir = protocol_dir();
        for v in (2..=6u8).chain([10, 11]) {
            for f in ["full", "patch", "inline"] {
                let data = std::fs::read(dir.join(format!("golden-{v}/{f}.rs{v}"))).unwrap();
                assert!(run_with_delta_check(&data, v) > 0);
            }
        }
    }

    /// The gate 7 bench inputs, when present (build artifacts, not in the repository).
    #[test]
    fn delta_names_every_change_in_real_recordings() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../artifacts/render-stream/gate7/g7x/inputs");
        for p in [
            "pace/capture/recording-patch.rs2",
            "scene/capture/recording-patch.rs2",
            "hd/capture/recording-patch.rs2",
        ] {
            let Ok(data) = std::fs::read(root.join(p)) else {
                continue;
            };
            let v = wire::version_of_magic(&data).unwrap();
            assert!(run_with_delta_check(&data, v) > 0);
        }
    }

    /// Replaces a record's meta text, keeping its blocks.
    fn with_meta(rec: &[u8], meta: &str) -> Vec<u8> {
        let meta_len = wire::le_u32(rec, 4) as usize;
        let rest = &rec[8 + meta_len..];
        let mut out = Vec::new();
        out.extend_from_slice(&((4 + meta.len() + rest.len()) as u32).to_le_bytes());
        out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        out.extend_from_slice(meta.as_bytes());
        out.extend_from_slice(rest);
        out
    }

    fn meta_of(rec: &[u8]) -> &str {
        let meta_len = wire::le_u32(rec, 4) as usize;
        std::str::from_utf8(&rec[8..8 + meta_len]).unwrap()
    }

    #[test]
    fn failed_accept_leaves_state_untouched() {
        // Before every transaction of golden-6's patch and full streams, a copy with a broken
        // unsupported list (rejected after apply, so the rollback runs): the stream must then
        // resolve exactly as the clean one.
        for f in ["patch", "full"] {
            let data = std::fs::read(protocol_dir().join(format!("golden-6/{f}.rs6"))).unwrap();
            let records = wire::split_records(&data, 6).unwrap();
            let resolve = |broken_at: Option<usize>| -> Vec<String> {
                let mut v = Validator::new(records[0].bytes(&data), 8, Options::new(6)).unwrap();
                let mut out = Vec::new();
                for (i, r) in records.iter().enumerate().skip(1) {
                    let rec = r.bytes(&data);
                    if Some(i) == broken_at {
                        let broken = meta_of(rec).replacen(
                            "\"unsupported\":[",
                            "\"unsupported\":[{\"op\":\"x\",\"item\":1,\"reason\":\"draw-index-tie\"},",
                            1,
                        );
                        let err = v.accept(&with_meta(rec, &broken), r.offset).unwrap_err();
                        assert_eq!(err.code, "unsupported-mismatch", "{err}");
                    }
                    if v.accept(rec, r.offset).unwrap() == Accepted::Transaction {
                        out.push(crate::canon::transaction_json(v.state()));
                    }
                }
                out
            };
            let clean = resolve(None);
            for (target, r) in records.iter().enumerate().skip(1) {
                if meta_of(r.bytes(&data)).starts_with("{\"type\":\"transaction\"") {
                    assert_eq!(
                        resolve(Some(target)),
                        clean,
                        "{f}: rejected copy before record {target}"
                    );
                }
            }
        }
    }

    #[test]
    fn parent_cycle_is_reported() {
        // golden-6 full.rs6's first transaction with two items made each other's parent, their
        // child lists kept consistent.
        let data = std::fs::read(protocol_dir().join("golden-6/full.rs6")).unwrap();
        let records = wire::split_records(&data, 6).unwrap();
        let mut v = Validator::new(records[0].bytes(&data), 8, Options::new(6)).unwrap();
        let rec = records[1].bytes(&data);
        let mut meta: serde_json::Value = serde_json::from_str(meta_of(rec)).unwrap();
        // Two items under canvases become each other's parent and child.
        let pair: Vec<(u64, u64)> = meta["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|it| it["parent"]["kind"] == "canvas")
            .map(|it| {
                (
                    it["id"].as_u64().unwrap(),
                    it["parent"]["id"].as_u64().unwrap(),
                )
            })
            .take(2)
            .collect();
        assert_eq!(pair.len(), 2, "two items under canvases");
        let ((x, cx), (p, cp)) = (pair[0], pair[1]);
        for it in meta["items"].as_array_mut().unwrap() {
            if it["id"] == x {
                it["parent"] = serde_json::json!({"kind": "item", "id": p});
                it["children"].as_array_mut().unwrap().push(p.into());
            }
            if it["id"] == p {
                it["parent"] = serde_json::json!({"kind": "item", "id": x});
                it["children"].as_array_mut().unwrap().push(x.into());
            }
        }
        for c in meta["canvases"].as_array_mut().unwrap() {
            if c["id"] == cx || c["id"] == cp {
                c["items"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|i| *i != x && *i != p);
            }
        }
        let err = v
            .accept(&with_meta(rec, &meta.to_string()), records[1].offset)
            .unwrap_err();
        assert_eq!(err.code, "parent-cycle", "{err}");
    }
}
