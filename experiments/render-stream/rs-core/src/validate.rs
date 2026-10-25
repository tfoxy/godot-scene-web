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
use crate::prof;
use crate::state::*;
use crate::wire::{self, F32s, F64s, I32s, MAGIC_LEN};
use std::collections::{BTreeSet, HashMap};
use std::hash::{BuildHasherDefault, Hasher};

pub use crate::wire::Error;

/// D31: who computes each record's SHA-256.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DigestPolicy {
    /// `accept` hashes every accepted record.
    Inline,
    /// `accept` records `None`; the caller fills digests later with `set_record_digest`.
    Deferred,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Options {
    /// The protocol version, 2 to 6.
    pub version: u8,
    pub digest: DigestPolicy,
    /// Verify a resource record's payload against its declared hash (`resource-hash`). `false` is
    /// the `skip-payload-hash` sabotage only.
    pub verify_payload_hashes: bool,
}

impl Options {
    pub fn new(version: u8) -> Options {
        Options {
            version,
            digest: DigestPolicy::Inline,
            verify_payload_hashes: true,
        }
    }
}

/// What an accepted record was.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Accepted {
    Resource { hash: Hash },
    Transaction,
    End,
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
    eff: Option<Id>,
    mat_unsup: bool,
}

#[derive(Default)]
struct Index {
    tex: FastMap<Id, TexIdx>,
    mesh: FastMap<Id, EntryStatus>,
    shader_texs: FastMap<Id, Vec<Id>>,
    mat: FastMap<Id, MatIdx>,
    canvas: FastMap<Id, (bool, bool, (i64, i64))>,
    item: FastMap<Id, ItemIdx>,
    claims: BTreeSet<(PKey, Id)>,
    tex_users: BTreeSet<(Id, Id)>,
    mesh_users: BTreeSet<(Id, Id)>,
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
}

impl Dirty {
    fn clear(&mut self) {
        self.canvases.clear();
        self.items.clear();
        self.textures.clear();
        self.meshes.clear();
        self.shaders.clear();
        self.materials.clear();
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
}

impl Removed {
    fn clear(&mut self) {
        self.canvases.clear();
        self.items.clear();
        self.textures.clear();
        self.meshes.clear();
        self.shaders.clear();
        self.materials.clear();
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

// ------------------------------------------------------------------------------------- validator

pub struct Validator {
    opts: Options,
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
    end_seen: bool,
    digests: Vec<Option<Hash>>,
    // per-record scratch
    bufs: DecodeBufs,
    tx: TxMeta,
    undo: Vec<Undo>,
    /// Recycled item buffers (replaced entries, after commit).
    item_pool: Vec<Item>,
    old_defaults: (Filter, Repeat),
    dirty: Dirty,
    removed: Removed,
    /// Per tx entry: it was absent from the previous state (canvases, items, textures, meshes,
    /// shaders, materials).
    was_new: [Vec<bool>; 6],
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

fn blank_item() -> Item {
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
            (2..=10).contains(&opts.version),
            "render-stream version 2..=10"
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
            let logical = [v.logical_size[0] as f64, v.logical_size[1] as f64];
            let presentation = v.presentation_size.unwrap_or(v.logical_size);
            let visible_matches = visible == logical;
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
        let digest = match opts.digest {
            DigestPolicy::Inline => Some(wire::record_sha256(session_record)),
            DigestPolicy::Deferred => None,
        };
        Ok(Validator {
            opts,
            session,
            snap_declared,
            state: ResolvedState::empty(opts.version),
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
            end_seen: false,
            digests: vec![digest],
            bufs,
            tx,
            undo: Vec::new(),
            item_pool: Vec::new(),
            old_defaults: (Filter::Nearest, Repeat::Disabled),
            dirty: Dirty::default(),
            removed: Removed::default(),
            was_new: Default::default(),
        })
    }

    pub fn options(&self) -> Options {
        self.opts
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
        let accepted = match decoded {
            Decoded::Session(_) => {
                return Err(Error::new(
                    "duplicate-session",
                    format!("a second session record at offset {offset}"),
                ))
            }
            Decoded::Resource(r) => self.accept_resource(record, offset, r)?,
            Decoded::Transaction => self.accept_transaction(record, offset)?,
            Decoded::End(e) => self.accept_end(e)?,
        };
        let t = prof::start();
        let digest = match self.opts.digest {
            DigestPolicy::Inline => Some(wire::record_sha256(record)),
            DigestPolicy::Deferred => None,
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
        if self.carried.contains_key(&r.hash) {
            return Err(Error::new(
                "resource-duplicate",
                format!(
                    "record at offset {offset}: hash {} already carried earlier in this stream",
                    r.hash.to_hex()
                ),
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
        if e.transactions != self.tx_count {
            return Err(Error::new(
                "end-count-mismatch",
                format!(
                    "end record says {} transactions, but {} were seen",
                    e.transactions, self.tx_count
                ),
            ));
        }
        let s = e.stats;
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

    fn accept_transaction(&mut self, record: &[u8], offset: usize) -> Result<Accepted, Error> {
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
        let bl = [blk(0), blk(1), blk(2), blk(3), blk(4), blk(5), blk(6)];
        self.apply(bl);
        self.reindex_dirty();
        prof::add(prof::RESOLVE, t);
        let t = prof::start();
        let result = self.post_checks(offset);
        if let Err(e) = result {
            self.rollback();
            return Err(e);
        }
        self.commit();
        prof::add(prof::POST_CHECKS, t);
        self.bytes_total += record.len() as u64;
        self.max_record_bytes = self.max_record_bytes.max(record.len() as u64);
        Ok(Accepted::Transaction)
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
        if tx.seq != self.prev_seq + 1 {
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
                if matches!(c.op, Op::Unsupported | Op::ClipIgnore) {
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

    /// `checkPatchRules`.
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
    fn apply(&mut self, bl: [&[u8]; 7]) {
        let v = self.opts.version;
        let tx = &self.tx;
        let st = &mut self.state;
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
                let mat = Material {
                    id: m.id,
                    origin: m.origin,
                    status: m.status,
                    reason: m.reason,
                    version: m.version,
                    shader: m.shader,
                    params: m
                        .params
                        .of(&tx.params)
                        .iter()
                        .map(|p| lift_param(p, param_f64))
                        .collect(),
                };
                if st
                    .materials
                    .get(&m.id)
                    .is_some_and(|old| material_identical(old, &mat))
                {
                    self.was_new[5].push(false);
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
                        Some(old) => Some(std::mem::replace(old, item)),
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
                if st.meshes.get(&m.id).is_some_and(|old| {
                    old.origin == m.origin
                        && old.adopted_content == m.adopted_content
                        && old.status == m.status
                        && old.reason == m.reason
                        && old.version == m.version
                        && bits_eq(&old.custom_aabb, &custom_aabb)
                        && old.surfaces == m.surfaces
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
                    surfaces: m.surfaces.clone(),
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
            }
        }
        self.reindex(false);
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
                    ix.n_ops -= o.ops.len();
                } else {
                    carried.tex_refs = o.tex_refs;
                    carried.tex_ids = o.tex_ids;
                    carried.meshes = o.meshes;
                    carried.ops = o.ops;
                }
                if new_item.is_none() {
                    ix.n_tex_unsup -= o.tex_unsup.len();
                    ix.n_mesh_unsup -= o.mesh_unsup as usize;
                    ix.n_mat_unsup -= o.mat_unsup as usize;
                    if let Some(e) = o.eff {
                        ix.eff_users.remove(&(e, id));
                    }
                    // Children that inherit through this item see a different chain now.
                    eff_work.extend(users(&ix.claims, item_key(id)));
                } else {
                    carried.tex_unsup = o.tex_unsup;
                    carried.mesh_unsup = o.mesh_unsup;
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
                e.ops.clear();
                for (k, c) in it.commands.list.iter().enumerate() {
                    if let (Some(t), Some(m)) = (c.tex(), rs_method(c)) {
                        e.tex_refs.push((t, m));
                    }
                    if let Command::Mesh { mesh, .. } = c {
                        e.meshes.push(*mesh);
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
                for &t in &e.tex_ids {
                    ix.tex_users.insert((t, id));
                }
                for &m in &e.meshes {
                    ix.mesh_users.insert((m, id));
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
        self.check_invariants()?;
        self.check_delivery(offset)?;
        self.check_adoption(offset)?;
        self.check_versions(offset)?;
        self.check_resources(offset)?;
        self.check_id_reuse(offset)
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
        let mut declared_stack = false;
        let mut declared_snap = false;
        let actual_stack = v >= 6 && ix.stack_ties > 0;
        for e in &tx.unsupported {
            let op = &*e.op;
            let Some(item) = e.item else {
                if item_level {
                    return Err(mm(format!(
                        "session-level entry {op} follows an item-level entry"
                    )));
                }
                if e.reason == "canvas-light" && op != "canvas_light_attach_to_canvas" {
                    return Err(mm(format!(
                        "canvas-light entry names op {op}, expected canvas_light_attach_to_canvas"
                    )));
                }
                if v >= 6 && e.reason == "extra-canvas" {
                    return Err(mm(format!(
                        "extra-canvas entry (op {op}) is never valid at /6 (a canvas attached to the root viewport is supported)"
                    )));
                }
                match e.reason {
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
            match e.reason {
                "unsupported-op"
                | "unknown-texture"
                | "canvas-texture-headless"
                | "unknown-mesh"
                | "skinned-geometry" => {
                    let cmds = &st.items[&id].commands.list;
                    let actual = x
                        .ops
                        .iter()
                        .find_map(|&(k, reason)| match &cmds[k as usize] {
                            Command::Unsupported { name, .. } if &**name == op => Some(reason),
                            _ => None,
                        });
                    if actual != Some(e.reason) {
                        return Err(mm(format!(
                            "{} entry ({item}, {op}) has no matching command",
                            e.reason
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
        let missing = |what: String, h: &Hash, pb: i64| {
            Error::new(
                "resource-missing",
                format!(
                    "record at offset {offset}: {what}'s hash {} (payload_bytes {pb} <= inline_max_bytes {inline_max}) never arrived as a resource record",
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
                if s.payload_bytes > inline_max {
                    continue;
                }
                match self.carried.get(&s.hash) {
                    None => {
                        return Err(missing(
                            format!("mesh {}'s surface", m.id),
                            &s.hash,
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
                                    s.hash.to_hex(),
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
        st.unsupported = tx
            .unsupported
            .drain(..)
            .map(|u| UnsupportedEntry {
                op: u.op,
                item: u.item.map(|i| i as Id),
                reason: u.reason,
            })
            .collect();
        st.unknown_items = tx.unknown_items;

        for t in &tx.textures {
            self.last_texture.insert(t.id, t.clone());
        }
        for m in &tx.meshes {
            self.last_mesh.insert(m.id, st.meshes[&m.id].clone());
        }
        for s in &tx.shaders {
            self.last_shader.insert(s.id, s.clone());
        }
        for m in &tx.materials {
            self.last_material.insert(m.id, st.materials[&m.id].clone());
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
        let r = &self.removed;
        d.canvases_removed.extend(&r.canvases);
        d.items_removed.extend(&r.items);
        d.textures_removed.extend(&r.textures);
        d.meshes_removed.extend(&r.meshes);
        d.shaders_removed.extend(&r.shaders);
        d.materials_removed.extend(&r.materials);
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
        // Recycle the replaced items' buffers.
        for u in self.undo.drain(..) {
            if let Undo::Item(_, Some(it), _) = u {
                if self.item_pool.len() < 4096 {
                    self.item_pool.push(it);
                }
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
        for v in (2..=6u8).chain([10]) {
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
