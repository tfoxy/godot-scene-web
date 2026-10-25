//! The Godot applier, in Rust: the former GDScript applier (`rs_applier.gd`, removed in G7gd)'s reconciliation of a RESOLVED state with
//! the receiver's own mirror of what it last sent to the RenderingServer, emitting the same
//! RenderingServer calls in the same order (`ops.rs`) and the same statistics Dictionary
//! (`apply_state()`'s return value, `vt.rs`). The C++ shim executes the calls as ptrcalls.
//!
//! Every rule, ordering and sabotage below is rs_applier.gd's; read its class documentation for
//! the why. What differs is the cost model (gate7-design.md D29, D34): rs_applier.gd re-walks the
//! whole resolved state every transaction, this planner visits only what the accepted
//! transactions touched since the last apply (`Touched`, the union of `TxDelta`s), plus the few
//! things whose RenderingServer argument depends on another resource's residency (an item's
//! material RID, `rid` instance parameters). The small resource tables (shaders, materials) are
//! still walked whole. `full_scan` turns every delta shortcut off; the tests hold the two modes'
//! call streams equal over real recordings.
//!
//! Floats are compared as rs_applier.gd compares PackedFloat32Arrays (IEEE `==`: -0 equals 0, NaN
//! never equals itself), and a parameter value as its JSON text compares (bit for bit).

use crate::ops::{Op, OpBuf, RidRef};
use crate::vt::{gd, Vt};
use render_stream_core::delivery::DeliveryPrefs;
use render_stream_core::payload::{self, MeshPayload, TexturePayload};
use render_stream_core::state::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// RS_RECEIVER_SABOTAGE values the applier implements (receiver.gd keeps the I/O ones).
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Sabotage {
    pub reupload: bool,
    pub ignore_clip: bool,
    pub clip_before_clear: bool,
    pub drop_msdf: bool,
    pub ignore_set_transform: bool,
    pub ignore_clip_ignore: bool,
    pub ignore_nine_patch_axis: bool,
    pub drop_mesh_surface: bool,
    pub stale_mesh: bool,
    pub refuse_canvas_texture: bool,
    pub ignore_material: bool,
    pub ignore_canvas_modulate: bool,
    pub stale_param: bool,
    pub stale_texture: bool,
    pub ignore_canvas_stacking: bool,
    /// P3-ST: a back-buffer copy before every screen-reading item (`canvas_item_set_copy_to_backbuffer`
    /// on each item whose own material's shader uses `screen_texture`) -- the copy taken at the
    /// wrong time; GLES3 takes one per canvas, before the first reader.
    pub screen_copy_per_reader: bool,
    /// P3-VX: every `varying` of a shader's code made `flat` before `shader_set_code`
    /// (`render_stream_core::apply::programs::flat_varyings`): vertex outputs not interpolated.
    pub vertex_flat_varyings: bool,
    /// CG1 (render-stream-10.md "Receivers"): never issue `canvas_item_set_canvas_group_mode`, so
    /// a group owner draws as a plain item (its children unclipped, nothing composited).
    pub drop_canvas_group: bool,
    /// CG1: issue every wire `copy_to_backbuffer` with `Rect2()` (the rect dropped), so the
    /// engine copies the whole target instead of the region.
    pub full_backbuffer_copy: bool,
}

impl Sabotage {
    pub fn parse(name: &str) -> Sabotage {
        let mut s = Sabotage::default();
        match name {
            "reupload" => s.reupload = true,
            "ignore-clip" => s.ignore_clip = true,
            "clip-before-clear" => s.clip_before_clear = true,
            "drop-msdf" => s.drop_msdf = true,
            "ignore-set-transform" => s.ignore_set_transform = true,
            "ignore-clip-ignore" => s.ignore_clip_ignore = true,
            "ignore-nine-patch-axis" => s.ignore_nine_patch_axis = true,
            "drop-mesh-surface" => s.drop_mesh_surface = true,
            "stale-mesh" => s.stale_mesh = true,
            "refuse-canvas-texture" => s.refuse_canvas_texture = true,
            "ignore-material" => s.ignore_material = true,
            "ignore-canvas-modulate" => s.ignore_canvas_modulate = true,
            "stale-param" => s.stale_param = true,
            "stale-texture" => s.stale_texture = true,
            "ignore-canvas-stacking" => s.ignore_canvas_stacking = true,
            "screen-copy-per-reader" => s.screen_copy_per_reader = true,
            "vertex-flat-varyings" => s.vertex_flat_varyings = true,
            "drop-canvas-group" => s.drop_canvas_group = true,
            "full-backbuffer-copy" => s.full_backbuffer_copy = true,
            _ => {}
        }
        s
    }
}

/// What the transactions accepted since the last apply touched (the union of their `TxDelta`s:
/// upserted and removed ids alike).
#[derive(Default, Debug, Clone)]
pub struct Touched {
    pub canvases: BTreeSet<Id>,
    pub items: BTreeSet<Id>,
    pub textures: BTreeSet<Id>,
    pub meshes: BTreeSet<Id>,
    pub shaders: BTreeSet<Id>,
    pub materials: BTreeSet<Id>,
}

impl Touched {
    pub fn merge(&mut self, d: &TxDelta) {
        self.canvases
            .extend(d.canvases_upserted.iter().chain(&d.canvases_removed));
        self.items
            .extend(d.items_upserted.iter().chain(&d.items_removed));
        self.textures
            .extend(d.textures_upserted.iter().chain(&d.textures_removed));
        self.meshes
            .extend(d.meshes_upserted.iter().chain(&d.meshes_removed));
        self.shaders
            .extend(d.shaders_upserted.iter().chain(&d.shaders_removed));
        self.materials
            .extend(d.materials_upserted.iter().chain(&d.materials_removed));
    }
    pub fn clear(&mut self) {
        *self = Touched::default();
    }
}

/// A withheld shader's code from the operator-local library (RsResourceCache.library_code()).
#[derive(Clone, Debug)]
pub enum Library {
    Ok(String),
    Missing(String),
}

/// The payloads one apply may read: provided (verified, decodable) raw payloads by hash, and the
/// library results by hash text.
pub struct Payloads<'a> {
    pub provided: &'a HashMap<Hash, Vec<u8>>,
    pub library: &'a HashMap<String, Library>,
    /// The stream's wire version: from /8 a texture payload may be a float format (D9).
    pub version: u8,
}

impl Payloads<'_> {
    fn texture(&self, h: &Hash) -> Result<TexturePayload<'_>, String> {
        let bytes = self.provided.get(h).ok_or_else(|| missing(h))?;
        payload::decode_texture_v(bytes, self.version)
            .map_err(|e| format!("resource-invalid: {} {}", h.to_hex(), e))
    }
    /// G8ku (texture-delivery-design.md Q6 "Native receiver"): a `uastc` variant's KTX2, checked
    /// against its entry's shape (`ktx2-shape`; the transcode is the engine's), as a
    /// TexturePayload whose `format` is "KTX2" and whose `data` is the whole file: the executor
    /// hands it to `Image.load_ktx_from_buffer` (D14) instead of `Image.create_from_data`.
    fn ktx2(&self, h: &Hash, e: &Texture) -> Result<TexturePayload<'_>, String> {
        let bytes = self.provided.get(h).ok_or_else(|| missing(h))?;
        let k = payload::decode_ktx2(bytes)
            .map_err(|e| format!("resource-invalid: {} {}", h.to_hex(), e))?;
        payload::check_ktx2_shape(&k, "uastc", e.width, e.height, e.mipmaps)
            .map_err(|e| format!("resource-invalid: {} {}", h.to_hex(), e))?;
        Ok(TexturePayload {
            format: "KTX2".to_string(),
            width: k.width,
            height: k.height,
            mipmaps: k.levels > 1,
            data: bytes,
        })
    }
    fn mesh(&self, h: &Hash) -> Result<MeshPayload<'_>, String> {
        let bytes = self.provided.get(h).ok_or_else(|| missing(h))?;
        payload::decode_mesh(bytes).map_err(|e| format!("resource-invalid: {} {}", h.to_hex(), e))
    }
    fn shader(&self, h: &Hash) -> Result<&str, String> {
        let bytes = self.provided.get(h).ok_or_else(|| missing(h))?;
        payload::decode_shader(bytes)
            .map(|p| p.code)
            .map_err(|e| format!("resource-invalid: {} {}", h.to_hex(), e))
    }
}

fn missing(h: &Hash) -> String {
    format!(
        "resource-unavailable: payload {} was not provided before apply",
        h.to_hex()
    )
}

/// G8ku: the image-format code of a KTX2 payload in a texture op (rs_core_ext.cpp make_image calls
/// `Image.load_ktx_from_buffer` for it). Outside Godot's `Image.Format` range (0..38).
pub const KTX2_FORMAT: i32 = 1000;

/// `IMAGE_FORMATS` (rs_texture_payload.gd): Image.Format for the six permitted formats and, from
/// /8, the eight float formats (G8f, `core/io/image.h:75-114`), and from /9 the block formats a
/// `block` variant may carry (G8kp: the payload decoder admits them only at /9), else -1
/// (make_image() returns null).
fn image_format(name: &str) -> i32 {
    match name {
        "DXT1" => 17,
        "DXT3" => 18,
        "DXT5" => 19,
        "RGTC_R" => 20,
        "RGTC_RG" => 21,
        "BPTC_RGBA" => 22,
        "ETC" => 25,
        "ETC2_R11" => 26,
        "ETC2_R11S" => 27,
        "ETC2_RG11" => 28,
        "ETC2_RG11S" => 29,
        "ETC2_RGB8" => 30,
        "ETC2_RGBA8" => 31,
        "ETC2_RGB8A1" => 32,
        "ASTC_4x4" => 35,
        "ASTC_8x8" => 37,
        "L8" => 0,
        "LA8" => 1,
        "R8" => 2,
        "RG8" => 3,
        "RGB8" => 4,
        "RGBA8" => 5,
        "RF" => 8,
        "RGF" => 9,
        "RGBF" => 10,
        "RGBAF" => 11,
        "RH" => 12,
        "RGH" => 13,
        "RGBH" => 14,
        "RGBAH" => 15,
        // G8ku: not an Image.Format: the executor transcodes the KTX2 file in `data` (KTX2_FORMAT).
        "KTX2" => KTX2_FORMAT,
        _ => -1,
    }
}

fn filter_index(f: Filter) -> u32 {
    Filter::ALL.iter().position(|x| *x == f).unwrap() as u32
}
fn repeat_index(r: Repeat) -> u32 {
    Repeat::ALL.iter().position(|x| *x == r).unwrap() as u32
}
fn axis_index(a: Axis) -> u32 {
    match a {
        Axis::Stretch => 0,
        Axis::Tile => 1,
        Axis::TileFit => 2,
    }
}
fn primitive_index(p: Primitive) -> u32 {
    Primitive::ALL.iter().position(|x| *x == p).unwrap() as u32
}

const WHITE: [f32; 4] = [1.0, 1.0, 1.0, 1.0];
const IDENTITY: [f32; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// PackedFloat32Array `==`.
#[inline]
fn feq(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x == y)
}

/// Bit-for-bit, as the wire compares block floats (so a NaN margin is not re-issued every apply).
fn canvas_group_eq(a: &Option<CanvasGroup>, b: &Option<CanvasGroup>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => {
            x.mode == y.mode
                && x.clear_margin.to_bits() == y.clear_margin.to_bits()
                && x.fit_empty == y.fit_empty
                && x.fit_margin.to_bits() == y.fit_margin.to_bits()
                && x.blur_mipmaps == y.blur_mipmaps
        }
        _ => false,
    }
}

fn rect_bits_eq(a: &Option<[f32; 4]>, b: &Option<[f32; 4]>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => x.iter().zip(y).all(|(p, q)| p.to_bits() == q.to_bits()),
        _ => false,
    }
}

// ----------------------------------------------------------------------------------- mirror

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Container {
    Canvas(Id),
    Item(Id),
}

fn container_of(p: &Option<Parent>) -> Option<Container> {
    p.map(|p| match p.kind {
        ParentKind::Canvas => Container::Canvas(p.id),
        ParentKind::Item => Container::Item(p.id),
    })
}

#[derive(Debug)]
struct CanvasM {
    rid: RidRef,
    owned: bool,
    children: Vec<Id>,
    attached: bool,
    layer: i64,
    sublayer: i64,
    xform: [f32; 6],
    modulate: [f32; 4],
}

#[derive(Clone, Debug, PartialEq)]
enum ParamKey {
    /// `rid`: the serial of the texture RID last sent (0 for RID()).
    Rid(u64),
    /// Anything else: the type and the resolved value, compared bit for bit.
    Val(VariantType, ParamBits),
}

#[derive(Clone, Debug, PartialEq)]
enum ParamBits {
    Nil,
    Tex(Id),
    Nums(Vec<u64>, u32),
}

fn param_bits(v: &ParamValue) -> ParamBits {
    match v {
        ParamValue::Nil => ParamBits::Nil,
        ParamValue::Tex(id) => ParamBits::Tex(*id),
        ParamValue::Scalar(x) => ParamBits::Nums(vec![x.to_bits()], 0),
        ParamValue::Flat(xs) => ParamBits::Nums(xs.iter().map(|x| x.to_bits()).collect(), 1),
        ParamValue::Nested { components, values } => {
            ParamBits::Nums(values.iter().map(|x| x.to_bits()).collect(), 2 + components)
        }
    }
}

#[derive(Debug)]
struct ItemM {
    handle: u32,
    parent: Option<Container>,
    children: Vec<Id>,
    xform: [f32; 6],
    modulate: [f32; 4],
    self_modulate: [f32; 4],
    custom_rect_floats: [f32; 4],
    custom_rect: bool,
    visible: bool,
    clip: bool,
    visibility_layer: i64,
    z_index: i64,
    z_relative: bool,
    behind: bool,
    draw_index: i64,
    texture_filter: Filter,
    texture_repeat: Repeat,
    content_version: i64,
    material_wire: Option<Id>,
    material_rid: Option<u32>,
    /// The back-buffer copy this receiver last set on the item (`None`: disabled): the wire's
    /// /10 `copy_to_backbuffer`, or the `screen-copy-per-reader` sabotage's `Rect2()` copy.
    copy_to_backbuffer: Option<[f32; 4]>,
    /// The /10 canvas-group state this receiver last set on the item (`None`: disabled).
    canvas_group: Option<CanvasGroup>,
    /// P3-ST (gate5_5-design.md "Refused materials"): the effective material reads the screen but
    /// is refused, so the item's own commands are not replayed.
    screen_skip: bool,
    use_parent_material: bool,
    instance_params: Vec<(Box<str>, ParamKey)>,
    /// G8kf: the textures whose draw commands this item's last replay skipped as undrawable
    /// (`unsupported-texture`), mirrored in `Planner::skipped_items`.
    skipped_tex: Vec<Id>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TexKind {
    Image,
    Placeholder,
    Canvas,
}

#[derive(Debug)]
struct TexM {
    handle: u32,
    serial: u64,
    kind: TexKind,
    hash: Option<Hash>,
    format: Box<str>,
    width: i64,
    height: i64,
    mipmaps: bool,
    canvas_version: i64,
    /// P3-CT: the serial of the diffuse texture RID the last `canvas_texture_set_channel` bound
    /// (0: none, or `RID()`).
    canvas_diffuse_serial: u64,
    /// G8ku (D6 `keep`): the entry version the resident image was uploaded for.
    version: i64,
}

#[derive(Clone, Debug, PartialEq)]
struct Layout {
    primitive: Primitive,
    format: i64,
    vertex_count: i64,
    index_count: i64,
    lens: [usize; 4],
    aabb: [u32; 6],
    uv_scale: [u32; 4],
}

fn layout_of(p: &MeshPayload) -> Layout {
    Layout {
        primitive: p.primitive,
        format: p.format,
        vertex_count: p.vertex_count,
        index_count: p.index_count,
        lens: [
            p.vertex_data.len(),
            p.attribute_data.len(),
            p.skin_data.len(),
            p.index_data.len(),
        ],
        aabb: p.aabb.map(f32::to_bits),
        uv_scale: p.uv_scale.map(f32::to_bits),
    }
}

/// One surface as last built: what `cache.decoded(hash)` gives rs_applier.gd.
#[derive(Clone, Debug)]
struct SurfaceBytes {
    layout: Layout,
    aabb: [f32; 6],
    uv_scale: [f32; 4],
    bufs: [Vec<u8>; 4],
}

impl SurfaceBytes {
    fn of(p: &MeshPayload) -> SurfaceBytes {
        SurfaceBytes {
            layout: layout_of(p),
            aabb: p.aabb,
            uv_scale: p.uv_scale,
            bufs: [
                p.vertex_data.to_vec(),
                p.attribute_data.to_vec(),
                p.skin_data.to_vec(),
                p.index_data.to_vec(),
            ],
        }
    }
    fn data_bytes(&self) -> i64 {
        self.bufs.iter().map(|b| b.len() as i64).sum()
    }
}

#[derive(Debug)]
struct MeshM {
    handle: u32,
    hashes: Vec<Hash>,
    layouts: Vec<Layout>,
    surfaces: Vec<SurfaceBytes>,
    custom_aabb: Option<[f32; 6]>,
}

#[derive(Debug)]
struct ShaderM {
    handle: u32,
    hash: Option<Hash>,
    /// "<name>/<index>" -> (name, index, texture serial), in insertion order.
    defaults: Vec<(String, Box<str>, i64, u64)>,
}

#[derive(Debug)]
struct MaterialM {
    handle: u32,
    shader: Option<u32>,
    params: Vec<(Box<str>, ParamKey)>,
}

/// What one item names (for residency): its commands' textures and `rid` instance parameters, its
/// add_mesh meshes and its own material.
#[derive(Clone, Default, Debug, PartialEq)]
struct Named {
    textures: Vec<Id>,
    meshes: Vec<Id>,
    material: Option<Id>,
    rid_params: bool,
}

fn named_of(item: &Item, version: u8) -> Named {
    let mut n = Named::default();
    for c in &item.commands.list {
        if let Some(t) = c.tex() {
            n.textures.push(t);
        }
        if let Command::Mesh { mesh, .. } = c {
            n.meshes.push(*mesh);
        }
    }
    if version >= 5 {
        for p in &item.instance_params {
            if p.ty == VariantType::Rid {
                if let ParamValue::Tex(t) = p.value {
                    n.textures.push(t);
                    n.rid_params = true;
                }
            }
        }
        n.material = item.material;
    }
    n.textures.sort_unstable();
    n.textures.dedup();
    n.meshes.sort_unstable();
    n.meshes.dedup();
    n
}

/// The naming change the touched items make, before it is committed.
#[derive(Default)]
struct Sync {
    items: Vec<(Id, Option<Named>)>,
    tex: HashMap<Id, i64>,
    mesh: HashMap<Id, i64>,
    mat: HashMap<Id, i64>,
}

/// What needed() returns: payload hashes in rs_applier.gd's order, and which are meshes and
/// shaders; plus (Rust only) the `withheld` shader hashes whose library code the apply needs.
#[derive(Default, Debug, Clone)]
pub struct Needed {
    pub hashes: Vec<Hash>,
    pub texture_ids: Vec<Id>,
    pub mesh_hashes: Vec<Hash>,
    pub shader_hashes: Vec<Hash>,
    /// G8ku: the hashes D3 chose a `uastc` variant for (KTX2 payloads, `<hash>.ktx2` on disk).
    pub ktx2_hashes: Vec<Hash>,
    pub library: Vec<String>,
}

/// One apply's counters, for the stats Dictionary.
#[derive(Default)]
struct Counters {
    created: i64,
    freed: i64,
    reparented: i64,
    replayed: i64,
    msdf: i64,
    geometry: i64,
    mesh_commands: i64,
    skipped: i64,
    skipped_mesh: i64,
    tex_created: i64,
    tex_updated: i64,
    tex_replaced: i64,
    tex_freed: i64,
    upload_bytes: i64,
    meshes_created: i64,
    meshes_rebuilt: i64,
    meshes_freed: i64,
    surface_updates: i64,
    mesh_upload_bytes: i64,
    // material_resources, in rs_applier.gd's key order
    shaders_created: i64,
    shader_code_sets: i64,
    shaders_freed: i64,
    default_texture_sets: i64,
    materials_created: i64,
    materials_freed: i64,
    material_shader_sets: i64,
    param_sets: i64,
    instance_param_sets: i64,
    material_sets: i64,
    use_parent_material_sets: i64,
    modulate_sets: i64,
    canvases_created: i64,
    canvas_attach: i64,
    canvas_stacking_sets: i64,
    /// CG1: `canvas_item_set_canvas_group_mode` and `canvas_item_set_copy_to_backbuffer` calls.
    canvas_group_sets: i64,
    backbuffer_copy_sets: i64,
}

struct Upload {
    id: Id,
    hash: Option<Hash>,
    op: &'static str,
    data_bytes: i64,
    /// G8kp (texture-delivery-design.md D3): the encoding D3 chose (`decoded` or `block`), written
    /// to `uploads[]` at /9 only, so every older stream's report is unchanged.
    encoding: Option<&'static str>,
}

struct MeshUpload {
    id: Id,
    op: &'static str,
    surfaces: Vec<i64>,
    buffers: Vec<&'static str>,
    bytes: i64,
}

struct UnsupportedCommand {
    item: Id,
    name: String,
    reason: &'static str,
}

struct SkippedShader {
    id: Id,
    hash: String,
    reason: &'static str,
    detail: String,
}

// ----------------------------------------------------------------------------------- planner

#[derive(Default)]
pub struct Planner {
    pub sab: Sabotage,
    /// Turns every delta shortcut off (rs_applier.gd's O(state) walk), for the equivalence tests.
    pub full_scan: bool,
    pub rs_calls: i64,
    pub created_rids: i64,
    pub freed_by_apply: i64,
    pub disposed_frees: i64,
    pub touched: Touched,
    /// G8kp (texture-delivery-design.md D3): which payload of an ok image texture is fetched and
    /// uploaded. The default is `decoded` alone, exactly the base hash, as before /9.
    pub delivery: DeliveryPrefs,
    version: u8,
    canvases: BTreeMap<Id, CanvasM>,
    items: BTreeMap<Id, ItemM>,
    textures: BTreeMap<Id, TexM>,
    meshes: BTreeMap<Id, MeshM>,
    shaders: BTreeMap<Id, ShaderM>,
    materials: BTreeMap<Id, MaterialM>,
    root_xform: Option<[f32; 6]>,
    root_modulate: [f32; 4],
    default_filter: Option<Filter>,
    default_repeat: Option<Repeat>,
    next_handle: [u32; 6],
    next_serial: u64,
    // naming, as of the last apply
    named: HashMap<Id, Named>,
    tex_count: HashMap<Id, i64>,
    mesh_count: HashMap<Id, i64>,
    mat_count: HashMap<Id, i64>,
    mat_items: HashMap<Id, BTreeSet<Id>>,
    rid_param_items: BTreeSet<Id>,
    mattex: BTreeSet<Id>,
    /// P3-CT: the texture ids whose entry was a canvas texture as of the last apply.
    canvas_ids: BTreeSet<Id>,
    /// G8kf (render-stream-9.md "Texture reasons"): texture id -> the items whose last replay
    /// skipped a command naming it as undrawable. When an apply uploads that texture (a
    /// `delivery-pending` entry returning as `ok`), those items replay their content, since no
    /// item entry changed to make a delta apply visit them.
    skipped_items: BTreeMap<Id, BTreeSet<Id>>,
    /// The undrawable texture ids texture_for() met since the last take (replay is `&self`).
    tex_skips: std::cell::RefCell<Vec<Id>>,
}

fn bump(map: &mut HashMap<Id, i64>, id: Id, by: i64) {
    *map.entry(id).or_insert(0) += by;
}

fn count(map: &HashMap<Id, i64>, id: Id) -> i64 {
    map.get(&id).copied().unwrap_or(0)
}

impl Planner {
    pub fn new() -> Planner {
        Planner {
            root_modulate: WHITE,
            ..Planner::default()
        }
    }

    fn handle(&mut self, kind: usize) -> u32 {
        let h = self.next_handle[kind];
        self.next_handle[kind] += 1;
        h
    }

    fn serial(&mut self) -> u64 {
        self.next_serial += 1;
        self.next_serial
    }

    /// `begin_session()`: clear colour, canvas 1 (the viewport's own canvas), its transform and the
    /// cull mask. `version` is the stream's (it selects the /5 and /6 fields).
    pub fn begin_session(
        &mut self,
        ops: &mut OpBuf,
        version: u8,
        clear: [f32; 4],
        root_xform: [f32; 6],
        cull_mask: i64,
    ) {
        self.version = version;
        let ops_before = ops.rs_calls;
        ops.op(Op::SetDefaultClearColor, 1);
        ops.fs(&clear);
        self.canvases.insert(
            1,
            CanvasM {
                rid: RidRef::RootCanvas,
                owned: false,
                children: Vec::new(),
                attached: false,
                layer: 0,
                sublayer: 0,
                xform: IDENTITY,
                modulate: WHITE,
            },
        );
        self.root_xform = Some(root_xform);
        ops.op(Op::ViewportSetCanvasTransform, 1);
        ops.rid(RidRef::RootCanvas);
        ops.fs(&root_xform);
        ops.op(Op::ViewportSetCanvasCullMask, 1);
        ops.i64(cull_mask);
        self.rs_calls += (ops.rs_calls - ops_before) as i64;
        self.touched.clear();
    }

    pub fn root_canvas_xform(&self) -> Vec<f32> {
        self.root_xform.map(|x| x.to_vec()).unwrap_or_default()
    }
    pub fn owned_rids(&self) -> i64 {
        (self.items.len()
            + self.textures.len()
            + self.meshes.len()
            + self.shaders.len()
            + self.materials.len()
            + self.canvases.values().filter(|c| c.owned).count()) as i64
    }
    pub fn resident(&self) -> [i64; 5] {
        [
            self.items.len() as i64,
            self.textures.len() as i64,
            self.meshes.len() as i64,
            self.shaders.len() as i64,
            self.materials.len() as i64,
        ]
    }

    // ------------------------------------------------------------------------- naming

    fn sync(&self, st: &ResolvedState) -> Sync {
        let mut s = Sync::default();
        let ids: Vec<Id> = if self.full_scan {
            self.named
                .keys()
                .copied()
                .chain(st.items.keys().copied())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        } else {
            self.touched.items.iter().copied().collect()
        };
        for id in ids {
            let new = st.items.get(&id).map(|i| named_of(i, self.version));
            let old = self.named.get(&id);
            if old == new.as_ref() {
                continue;
            }
            if let Some(o) = old {
                for &t in &o.textures {
                    bump(&mut s.tex, t, -1);
                }
                for &m in &o.meshes {
                    bump(&mut s.mesh, m, -1);
                }
                if let Some(m) = o.material {
                    bump(&mut s.mat, m, -1);
                }
            }
            if let Some(n) = &new {
                for &t in &n.textures {
                    bump(&mut s.tex, t, 1);
                }
                for &m in &n.meshes {
                    bump(&mut s.mesh, m, 1);
                }
                if let Some(m) = n.material {
                    bump(&mut s.mat, m, 1);
                }
            }
            s.items.push((id, new));
        }
        s
    }

    /// `_named_material_ids()`: the `ok` materials some item names as its own material.
    fn named_materials(&self, st: &ResolvedState, s: &Sync) -> BTreeSet<Id> {
        let mut out = BTreeSet::new();
        for id in self.mat_count.keys().chain(s.mat.keys()) {
            if count(&self.mat_count, *id) + count(&s.mat, *id) > 0
                && st
                    .materials
                    .get(id)
                    .is_some_and(|m| m.status == EntryStatus::Ok)
            {
                out.insert(*id);
            }
        }
        out
    }

    /// `_named_shader_ids()`.
    fn named_shaders(st: &ResolvedState, mats: &BTreeSet<Id>) -> BTreeSet<Id> {
        let mut out = BTreeSet::new();
        for m in mats {
            if let Some(sid) = st.materials[m].shader {
                if st
                    .shaders
                    .get(&sid)
                    .is_some_and(|s| s.status == EntryStatus::Ok)
                {
                    out.insert(sid);
                }
            }
        }
        out
    }

    /// The textures the named materials' `rid` parameters and their shaders' default textures name.
    fn material_textures(
        st: &ResolvedState,
        mats: &BTreeSet<Id>,
        shaders: &BTreeSet<Id>,
    ) -> BTreeSet<Id> {
        let mut out = BTreeSet::new();
        for m in mats {
            for p in &st.materials[m].params {
                if p.ty == VariantType::Rid {
                    if let ParamValue::Tex(t) = p.value {
                        out.insert(t);
                    }
                }
            }
        }
        for s in shaders {
            for d in &st.shaders[s].default_textures {
                out.insert(d.tex);
            }
        }
        out
    }

    /// P3-CT: the diffuses of the named `ok` canvas textures (named by an item, or through
    /// `named_now`, the named materials' textures). A canvas texture draws its diffuse, so the
    /// diffuse is named through it although no command names it (render-stream-2.md "Texture").
    fn canvas_diffuses(
        &self,
        st: &ResolvedState,
        s: &Sync,
        named_now: &BTreeSet<Id>,
    ) -> BTreeSet<Id> {
        let named =
            |x: Id| count(&self.tex_count, x) + count(&s.tex, x) > 0 || named_now.contains(&x);
        let mut out = BTreeSet::new();
        for &c in self.canvas_ids.iter().chain(self.touched.textures.iter()) {
            let Some(e) = st.textures.get(&c) else {
                continue;
            };
            if e.kind != TextureKind::Canvas || e.status != EntryStatus::Ok || !named(c) {
                continue;
            }
            if let Some(d) = e.canvas.as_ref().and_then(|ct| ct.diffuse) {
                out.insert(d);
            }
        }
        out
    }

    /// The textures an apply of `st` names besides the items' own commands: the named materials'
    /// (`material_textures`) and the named canvas textures' diffuses (`canvas_diffuses`).
    fn indirect_textures(
        &self,
        st: &ResolvedState,
        s: &Sync,
        mats: &BTreeSet<Id>,
        shaders: &BTreeSet<Id>,
    ) -> BTreeSet<Id> {
        let mut out = Self::material_textures(st, mats, shaders);
        let diffuses = self.canvas_diffuses(st, s, &out);
        out.extend(diffuses);
        out
    }

    /// The named textures and meshes an apply must look at, ascending: every named one under
    /// full_scan (or a sabotage that keeps residency stale on purpose), else those newly named
    /// or whose entry a transaction touched.
    fn candidates(
        &self,
        st: &ResolvedState,
        s: &Sync,
        mattex_now: &BTreeSet<Id>,
    ) -> (Vec<Id>, Vec<Id>) {
        let tex_now =
            |x: Id| count(&self.tex_count, x) + count(&s.tex, x) > 0 || mattex_now.contains(&x);
        let tex_last = |x: Id| count(&self.tex_count, x) > 0 || self.mattex.contains(&x);
        let all_tex = self.full_scan || self.sab.reupload || self.sab.stale_texture;
        let mut tex = BTreeSet::new();
        if all_tex {
            for &x in self
                .tex_count
                .keys()
                .chain(s.tex.keys())
                .chain(mattex_now.iter())
            {
                if tex_now(x) {
                    tex.insert(x);
                }
            }
        } else {
            for &x in self
                .touched
                .textures
                .iter()
                .chain(s.tex.keys())
                .chain(mattex_now.iter())
            {
                if tex_now(x) && (self.touched.textures.contains(&x) || !tex_last(x)) {
                    tex.insert(x);
                }
            }
        }
        let mesh_now = |x: Id| count(&self.mesh_count, x) + count(&s.mesh, x) > 0;
        let all_mesh = self.full_scan || self.sab.stale_mesh || self.sab.drop_mesh_surface;
        let mut mesh = BTreeSet::new();
        if all_mesh {
            for &x in self.mesh_count.keys().chain(s.mesh.keys()) {
                if mesh_now(x) {
                    mesh.insert(x);
                }
            }
        } else {
            for &x in self.touched.meshes.iter().chain(s.mesh.keys()) {
                if mesh_now(x)
                    && (self.touched.meshes.contains(&x) || count(&self.mesh_count, x) == 0)
                {
                    mesh.insert(x);
                }
            }
        }
        let _ = st;
        (tex.into_iter().collect(), mesh.into_iter().collect())
    }

    fn commit(&mut self, s: Sync, mattex_now: BTreeSet<Id>) {
        for (id, v) in s.tex {
            bump(&mut self.tex_count, id, v);
            if self.tex_count[&id] == 0 {
                self.tex_count.remove(&id);
            }
        }
        for (id, v) in s.mesh {
            bump(&mut self.mesh_count, id, v);
            if self.mesh_count[&id] == 0 {
                self.mesh_count.remove(&id);
            }
        }
        for (id, v) in s.mat {
            bump(&mut self.mat_count, id, v);
            if self.mat_count[&id] == 0 {
                self.mat_count.remove(&id);
            }
        }
        for (id, new) in s.items {
            if let Some(old) = self.named.get(&id) {
                if let Some(m) = old.material {
                    if let Some(set) = self.mat_items.get_mut(&m) {
                        set.remove(&id);
                        if set.is_empty() {
                            self.mat_items.remove(&m);
                        }
                    }
                }
            }
            self.rid_param_items.remove(&id);
            match new {
                Some(n) => {
                    if let Some(m) = n.material {
                        self.mat_items.entry(m).or_default().insert(id);
                    }
                    if n.rid_params {
                        self.rid_param_items.insert(id);
                    }
                    self.named.insert(id, n);
                }
                None => {
                    self.named.remove(&id);
                }
            }
        }
        self.mattex = mattex_now;
    }

    // ------------------------------------------------------------------------- needed

    /// `needed()`: the payloads an apply of `st` reads that are not resident with that content.
    pub fn needed(&self, st: &ResolvedState) -> Needed {
        let s = self.sync(st);
        let mats = self.named_materials(st, &s);
        let shaders = Self::named_shaders(st, &mats);
        let mattex_now = self.indirect_textures(st, &s, &mats, &shaders);
        let (tex, mesh) = self.candidates(st, &s, &mattex_now);
        let mut out = Needed::default();
        let mut seen: BTreeSet<Hash> = BTreeSet::new();
        for sid in &shaders {
            let e = &st.shaders[sid];
            let current = self.shaders.get(sid).is_some_and(|m| m.hash == e.hash);
            if e.source == Some(ShaderSource::Withheld) && !current {
                out.library
                    .push(e.hash.map(|h| h.to_hex()).unwrap_or_default());
            }
            if e.source != Some(ShaderSource::Payload) {
                continue;
            }
            let Some(h) = e.hash else { continue };
            if current {
                continue;
            }
            if seen.insert(h) {
                out.hashes.push(h);
                out.shader_hashes.push(h);
            }
        }
        for mid in &mesh {
            let Some(e) = st.meshes.get(mid) else {
                continue;
            };
            if e.status != EntryStatus::Ok {
                continue;
            }
            for (k, surf) in e.surfaces.iter().enumerate() {
                if self
                    .meshes
                    .get(mid)
                    .is_some_and(|m| m.hashes.get(k) == Some(&surf.hash))
                {
                    continue;
                }
                if seen.insert(surf.hash) {
                    out.hashes.push(surf.hash);
                    out.mesh_hashes.push(surf.hash);
                }
            }
        }
        for tid in &tex {
            let Some(e) = st.textures.get(tid) else {
                continue;
            };
            if e.kind != TextureKind::Image || e.status != EntryStatus::Ok {
                continue;
            }
            let Some(sel) = self.delivery.select(e) else {
                continue;
            };
            let h = sel.hash;
            let same = self.textures.get(tid).is_some_and(|t| {
                t.kind == TexKind::Image
                    && (t.hash == Some(h)
                        || t.hash.is_some_and(|r| self.delivery.keeps(e, r, t.version)))
            });
            if same && !self.sab.reupload {
                continue;
            }
            out.texture_ids.push(*tid);
            if seen.insert(h) {
                out.hashes.push(h);
                if sel.encoding == "uastc" {
                    out.ktx2_hashes.push(h);
                }
            }
        }
        out
    }

    // ------------------------------------------------------------------------- apply

    fn texture_rid(&self, st: &ResolvedState, id: Id) -> (RidRef, u64) {
        match (st.textures.get(&id), self.textures.get(&id)) {
            (Some(e), Some(t)) if e.status == EntryStatus::Ok => {
                (RidRef::Texture(t.handle), t.serial)
            }
            _ => (RidRef::None, 0),
        }
    }

    /// `_texture_for()`: (drawable, RID, reason when not drawable).
    fn texture_for(&self, st: &ResolvedState, tex: Option<Id>) -> (bool, RidRef, &'static str) {
        let answer = self.texture_for_inner(st, tex);
        if !answer.0 {
            if let Some(id) = tex {
                self.tex_skips.borrow_mut().push(id);
            }
        }
        answer
    }

    fn texture_for_inner(&self, st: &ResolvedState, tex: Option<Id>) -> (bool, RidRef, &'static str) {
        let Some(id) = tex else {
            return (true, RidRef::None, "");
        };
        let Some(e) = st.textures.get(&id) else {
            return (false, RidRef::None, "unsupported-texture");
        };
        if e.status == EntryStatus::Freed {
            return (true, RidRef::None, "");
        }
        let Some(t) = self.textures.get(&id) else {
            return (false, RidRef::None, "unsupported-texture");
        };
        if e.status != EntryStatus::Ok {
            return (false, RidRef::None, "unsupported-texture");
        }
        if self.sab.refuse_canvas_texture && e.kind == TextureKind::Canvas {
            return (false, RidRef::None, "canvas-texture-headless");
        }
        (true, RidRef::Texture(t.handle), "")
    }

    fn container_rid(&self, c: Option<Container>) -> RidRef {
        match c {
            None => RidRef::None,
            Some(Container::Canvas(id)) => self.canvases[&id].rid,
            Some(Container::Item(id)) => RidRef::Item(self.items[&id].handle),
        }
    }

    fn children_of(&mut self, c: Container) -> Option<&mut Vec<Id>> {
        match c {
            Container::Canvas(id) => self.canvases.get_mut(&id).map(|c| &mut c.children),
            Container::Item(id) => self.items.get_mut(&id).map(|i| &mut i.children),
        }
    }

    /// The parameter's Variant (vt) and its comparison key (`_param_variant`, `_param_key`).
    fn param(&self, st: &ResolvedState, p: &Param) -> (Vt, ParamKey) {
        let mut v = Vt::new();
        let key = if p.ty == VariantType::Rid {
            let (rid, serial) = match &p.value {
                ParamValue::Tex(t) => self.texture_rid(st, *t),
                _ => (RidRef::None, 0),
            };
            if matches!(p.value, ParamValue::Nil) {
                v.nil();
            } else {
                v.rid(rid);
            }
            ParamKey::Rid(serial)
        } else {
            write_param_variant(&mut v, p);
            ParamKey::Val(p.ty, param_bits(&p.value))
        };
        (v, key)
    }

    /// `apply_state()`: reconciles the RenderingServer with `st`, writing the calls to `ops` and
    /// the statistics Dictionary to `stats`. Every payload needed() named must be in `payloads`.
    pub fn apply(
        &mut self,
        st: &ResolvedState,
        payloads: &Payloads,
        ops: &mut OpBuf,
        stats: &mut Vt,
    ) -> Result<(), String> {
        let ops_before = ops.rs_calls;
        let mut c = Counters::default();
        let mut uploads: Vec<Upload> = Vec::new();
        let mut mesh_uploads: Vec<MeshUpload> = Vec::new();
        let mut unsupported: Vec<UnsupportedCommand> = Vec::new();
        let mut skipped_shaders: Vec<SkippedShader> = Vec::new();
        let v5 = self.version >= 5;

        let s = self.sync(st);
        let mats_now = self.named_materials(st, &s);
        let shaders_now = Self::named_shaders(st, &mats_now);
        let mattex_now = self.indirect_textures(st, &s, &mats_now, &shaders_now);
        let (tex_cands, mesh_cands) = self.candidates(st, &s, &mattex_now);
        let touched = std::mem::take(&mut self.touched);
        for &id in &touched.textures {
            if st
                .textures
                .get(&id)
                .is_some_and(|e| e.kind == TextureKind::Canvas)
            {
                self.canvas_ids.insert(id);
            } else {
                self.canvas_ids.remove(&id);
            }
        }
        let mut extra_items: BTreeSet<Id> = s.items.iter().map(|(id, _)| *id).collect();
        self.commit(s, mattex_now);
        let mut tex_rid_changed = false;
        let mut canvas_bind: BTreeSet<Id> = BTreeSet::new();

        // Textures: free what left the table or became a tombstone, then the named ones.
        let free_tex: Vec<Id> = if self.full_scan {
            self.textures.keys().copied().collect()
        } else {
            touched
                .textures
                .iter()
                .copied()
                .filter(|id| self.textures.contains_key(id))
                .collect()
        };
        for id in free_tex {
            let gone = st
                .textures
                .get(&id)
                .is_none_or(|e| e.status == EntryStatus::Freed);
            if !gone {
                continue;
            }
            let t = self.textures.remove(&id).unwrap();
            ops.op(Op::FreeRid, 1);
            ops.rid(RidRef::Texture(t.handle));
            self.freed_by_apply += 1;
            c.tex_freed += 1;
            tex_rid_changed = true;
        }
        for id in tex_cands {
            let Some(e) = st.textures.get(&id) else {
                continue;
            };
            if e.status != EntryStatus::Ok {
                continue;
            }
            match e.kind {
                TextureKind::Placeholder => {
                    if self
                        .textures
                        .get(&id)
                        .is_some_and(|t| t.kind == TexKind::Placeholder)
                    {
                        continue;
                    }
                    if let Some(t) = self.textures.get_mut(&id) {
                        let h = t.handle;
                        t.kind = TexKind::Placeholder;
                        t.hash = None;
                        ops.op(Op::TextureReplaceWithPlaceholder, 2);
                        ops.rid(RidRef::Texture(h));
                        c.tex_replaced += 1;
                    } else {
                        let h = self.handle(2);
                        let serial = self.serial();
                        ops.op(Op::Texture2dPlaceholderCreate, 1);
                        ops.u(h);
                        self.textures.insert(
                            id,
                            TexM {
                                handle: h,
                                serial,
                                kind: TexKind::Placeholder,
                                hash: None,
                                format: "".into(),
                                width: 0,
                                height: 0,
                                mipmaps: false,
                                canvas_version: -1,
                                canvas_diffuse_serial: 0,
                                version: -1,
                            },
                        );
                        self.created_rids += 1;
                        c.tex_created += 1;
                        tex_rid_changed = true;
                    }
                    uploads.push(Upload {
                        id,
                        hash: None,
                        op: "placeholder",
                        data_bytes: 0,
                        encoding: None,
                    });
                }
                TextureKind::Canvas => {
                    if !self.textures.contains_key(&id) {
                        let h = self.handle(2);
                        let serial = self.serial();
                        ops.op(Op::CanvasTextureCreate, 1);
                        ops.u(h);
                        self.textures.insert(
                            id,
                            TexM {
                                handle: h,
                                serial,
                                kind: TexKind::Canvas,
                                hash: None,
                                format: "".into(),
                                width: 0,
                                height: 0,
                                mipmaps: false,
                                canvas_version: -1,
                                canvas_diffuse_serial: 0,
                                version: -1,
                            },
                        );
                        self.created_rids += 1;
                        c.tex_created += 1;
                        tex_rid_changed = true;
                        uploads.push(Upload {
                            id,
                            hash: None,
                            op: "canvas",
                            data_bytes: 0,
                            encoding: None,
                        });
                    }
                    // P3-CT: bound after the loop, once this apply's images exist (a diffuse
                    // can be created in the same apply under a higher id).
                    canvas_bind.insert(id);
                }
                TextureKind::Image => {
                    // G8kp: D3's choice (the base `decoded` hash unless a usable variant wins).
                    let Some(chosen) = self.delivery.select(e) else {
                        continue;
                    };
                    let hash = chosen.hash;
                    let encoding = (self.version >= 9).then_some(chosen.encoding);
                    let resident = self.textures.get(&id);
                    // D6 (G8ku): `keep` holds any payload of the current version (a variant
                    // appearing at an equal version is not refetched); `upgrade` switches.
                    if resident.is_some_and(|t| {
                        t.kind == TexKind::Image
                            && (t.hash == Some(hash)
                                || t.hash.is_some_and(|r| self.delivery.keeps(e, r, t.version)))
                    }) && !self.sab.reupload
                    {
                        if let Some(t) = self.textures.get_mut(&id) {
                            t.version = e.version;
                        }
                        continue;
                    }
                    if self.sab.stale_texture
                        && resident
                            .is_some_and(|t| t.kind == TexKind::Image && &*t.format == "RGBA8")
                    {
                        continue;
                    }
                    let p = if chosen.encoding == "uastc" {
                        payloads.ktx2(&hash, e)?
                    } else {
                        payloads.texture(&hash)?
                    };
                    let image = |ops: &mut OpBuf| {
                        ops.u(image_format(&p.format) as u32);
                        ops.i64(p.width);
                        ops.i64(p.height);
                        ops.b(p.mipmaps);
                        ops.bytes(p.data);
                    };
                    let op_name;
                    match resident {
                        None => {
                            let h = self.handle(2);
                            let serial = self.serial();
                            ops.op(Op::Texture2dCreate, 1);
                            ops.u(h);
                            image(ops);
                            self.textures.insert(
                                id,
                                TexM {
                                    handle: h,
                                    serial,
                                    kind: TexKind::Image,
                                    hash: None,
                                    format: "".into(),
                                    width: 0,
                                    height: 0,
                                    mipmaps: false,
                                    canvas_version: -1,
                                    canvas_diffuse_serial: 0,
                                    version: -1,
                                },
                            );
                            self.created_rids += 1;
                            c.tex_created += 1;
                            tex_rid_changed = true;
                            op_name = "create";
                        }
                        Some(t) => {
                            let h = t.handle;
                            if t.kind == TexKind::Image
                                && *t.format == *p.format
                                && t.width == p.width
                                && t.height == p.height
                                && t.mipmaps == p.mipmaps
                            {
                                ops.op(Op::Texture2dUpdate, 1);
                                ops.rid(RidRef::Texture(h));
                                image(ops);
                                c.tex_updated += 1;
                                op_name = "update";
                            } else {
                                ops.op(Op::TextureReplaceWithImage, 2);
                                ops.rid(RidRef::Texture(h));
                                image(ops);
                                c.tex_replaced += 1;
                                op_name = "replace";
                            }
                        }
                    }
                    let t = self.textures.get_mut(&id).unwrap();
                    t.kind = TexKind::Image;
                    t.hash = Some(hash);
                    t.format = p.format.as_str().into();
                    t.width = p.width;
                    t.height = p.height;
                    t.mipmaps = p.mipmaps;
                    t.version = e.version;
                    c.upload_bytes += p.data.len() as i64;
                    uploads.push(Upload {
                        id,
                        hash: Some(hash),
                        op: op_name,
                        data_bytes: p.data.len() as i64,
                        encoding,
                    });
                }
            }
        }
        // P3-CT: bind each canvas texture looked at, and (when a texture RID appeared) each one
        // whose diffuse RID differs from the one it bound: a diffuse named only through its
        // canvas texture is created after the canvas texture's own entry was first applied.
        if tex_rid_changed {
            canvas_bind.extend(self.canvas_ids.iter().copied());
        }
        for id in canvas_bind {
            let (Some(e), Some(t)) = (st.textures.get(&id), self.textures.get(&id)) else {
                continue;
            };
            if e.kind != TextureKind::Canvas
                || e.status != EntryStatus::Ok
                || t.kind != TexKind::Canvas
            {
                continue;
            }
            let info = e
                .canvas
                .as_ref()
                .expect("a canvas texture carries `canvas`");
            let (diffuse, serial) = info
                .diffuse
                .and_then(|d| self.textures.get(&d))
                .map(|d| (RidRef::Texture(d.handle), d.serial))
                .unwrap_or((RidRef::None, 0));
            let rebind = serial != 0 && serial != t.canvas_diffuse_serial;
            if t.canvas_version == e.version && !rebind {
                continue;
            }
            let h = t.handle;
            ops.op(Op::CanvasTextureSetChannel, 1);
            ops.rid(RidRef::Texture(h));
            ops.u(0); // CANVAS_TEXTURE_CHANNEL_DIFFUSE
            ops.rid(diffuse);
            ops.op(Op::CanvasTextureSetFilter, 1);
            ops.rid(RidRef::Texture(h));
            ops.u(filter_index(info.filter));
            ops.op(Op::CanvasTextureSetRepeat, 1);
            ops.rid(RidRef::Texture(h));
            ops.u(repeat_index(info.repeat));
            let t = self.textures.get_mut(&id).unwrap();
            t.canvas_version = e.version;
            t.canvas_diffuse_serial = serial;
        }

        // Meshes.
        self.apply_meshes(
            st,
            payloads,
            ops,
            &mut c,
            &mut mesh_uploads,
            &touched,
            &mesh_cands,
        )?;

        // Shaders, then materials.
        let mut mat_rid_changed: BTreeSet<Id> = BTreeSet::new();
        self.apply_shaders(
            st,
            payloads,
            ops,
            &mut c,
            &mut skipped_shaders,
            &touched,
            &shaders_now,
        )?;
        self.apply_materials(st, ops, &mut c, &mats_now, &mut mat_rid_changed);

        // The root viewport's defaults.
        if self.default_filter != Some(st.default_texture_filter) {
            ops.op(Op::ViewportSetDefaultFilter, 1);
            ops.u(filter_index(st.default_texture_filter));
            self.default_filter = Some(st.default_texture_filter);
        }
        if self.default_repeat != Some(st.default_texture_repeat) {
            ops.op(Op::ViewportSetDefaultRepeat, 1);
            ops.u(repeat_index(st.default_texture_repeat));
            self.default_repeat = Some(st.default_texture_repeat);
        }

        // 2. Free vanished items, then vanished canvases other than 1.
        let mut dirty: BTreeSet<Container> = BTreeSet::new();
        let free_items: Vec<Id> = if self.full_scan {
            self.items.keys().copied().collect()
        } else {
            touched
                .items
                .iter()
                .copied()
                .filter(|id| self.items.contains_key(id))
                .collect()
        };
        for id in free_items {
            if st.items.contains_key(&id) {
                continue;
            }
            let gone = self.items.remove(&id).unwrap();
            ops.op(Op::FreeRid, 1);
            ops.rid(RidRef::Item(gone.handle));
            c.freed += 1;
            self.freed_by_apply += 1;
            if let Some(p) = gone.parent {
                if let Some(list) = self.children_of(p) {
                    if let Some(at) = list.iter().position(|x| *x == id) {
                        list.remove(at);
                    }
                    dirty.insert(p);
                }
            }
            for child in gone.children {
                if let Some(ch) = self.items.get_mut(&child) {
                    ch.parent = None;
                    extra_items.insert(child);
                }
            }
        }
        let free_canvases: Vec<Id> = if self.full_scan {
            self.canvases.keys().copied().collect()
        } else {
            touched
                .canvases
                .iter()
                .copied()
                .filter(|id| self.canvases.contains_key(id))
                .collect()
        };
        for id in free_canvases {
            if id == 1 || st.canvases.contains_key(&id) {
                continue;
            }
            let gone = self.canvases.remove(&id).unwrap();
            ops.op(Op::FreeRid, 1);
            ops.rid(gone.rid);
            c.freed += 1;
            self.freed_by_apply += 1;
            for child in gone.children {
                if let Some(ch) = self.items.get_mut(&child) {
                    ch.parent = None;
                    extra_items.insert(child);
                }
            }
        }

        // 3. Create new canvases; 3b. attach, stack, transform and modulate the non-root ones;
        // then create new items.
        let canvas_ids: Vec<Id> = if self.full_scan {
            st.canvases.keys().copied().collect()
        } else {
            touched
                .canvases
                .iter()
                .copied()
                .filter(|id| st.canvases.contains_key(id))
                .collect()
        };
        for &id in &canvas_ids {
            if self.canvases.contains_key(&id) {
                continue;
            }
            let h = self.handle(1);
            ops.op(Op::CanvasCreate, 1);
            ops.u(h);
            self.canvases.insert(
                id,
                CanvasM {
                    rid: RidRef::Canvas(h),
                    owned: true,
                    children: Vec::new(),
                    attached: false,
                    layer: 0,
                    sublayer: 0,
                    xform: IDENTITY,
                    modulate: WHITE,
                },
            );
            c.created += 1;
            self.created_rids += 1;
            c.canvases_created += 1;
        }
        for &id in &canvas_ids {
            if id == 1 {
                continue;
            }
            self.apply_canvas(id, &st.canvases[&id], ops, &mut c);
        }
        let item_ids: BTreeSet<Id> = if self.full_scan {
            st.items.keys().copied().collect()
        } else {
            touched
                .items
                .iter()
                .chain(extra_items.iter())
                .copied()
                .filter(|id| st.items.contains_key(id))
                .collect()
        };
        let mut fresh: BTreeSet<Id> = BTreeSet::new();
        for &id in &item_ids {
            if self.items.contains_key(&id) {
                continue;
            }
            let h = self.handle(0);
            ops.op(Op::CanvasItemCreate, 1);
            ops.u(h);
            self.items.insert(
                id,
                ItemM {
                    handle: h,
                    parent: None,
                    children: Vec::new(),
                    xform: [0.0; 6],
                    modulate: [0.0; 4],
                    self_modulate: [0.0; 4],
                    custom_rect_floats: [0.0; 4],
                    custom_rect: false,
                    visible: true,
                    clip: false,
                    visibility_layer: 0,
                    z_index: 0,
                    z_relative: true,
                    behind: false,
                    draw_index: 0,
                    texture_filter: Filter::Default,
                    texture_repeat: Repeat::Default,
                    content_version: -1,
                    material_wire: None,
                    material_rid: None,
                    copy_to_backbuffer: None,
                    canvas_group: None,
                    screen_skip: false,
                    use_parent_material: false,
                    instance_params: Vec::new(),
                    skipped_tex: Vec::new(),
                },
            );
            fresh.insert(id);
            c.created += 1;
            self.created_rids += 1;
        }

        // 4. Parent pass, in id order.
        for &id in &item_ids {
            let wire = container_of(&st.items[&id].parent);
            let current = self.items[&id].parent;
            if wire == current {
                continue;
            }
            let rid = RidRef::Item(self.items[&id].handle);
            let parent_rid = self.container_rid(wire);
            ops.op(Op::ItemSetParent, 1);
            ops.rid(rid);
            ops.rid(parent_rid);
            c.reparented += 1;
            if let Some(old) = current {
                if let Some(list) = self.children_of(old) {
                    if let Some(at) = list.iter().position(|x| *x == id) {
                        list.remove(at);
                    }
                }
                dirty.insert(old);
            }
            self.items.get_mut(&id).unwrap().parent = wire;
            if let Some(new) = wire {
                if let Some(list) = self.children_of(new) {
                    list.push(id);
                }
                dirty.insert(new);
            }
        }

        // 5. Order pass: canvases then items, ascending.
        let mut containers: BTreeSet<Container> = dirty;
        if self.full_scan {
            containers.extend(st.canvases.keys().map(|id| Container::Canvas(*id)));
            containers.extend(st.items.keys().map(|id| Container::Item(*id)));
        } else {
            containers.extend(canvas_ids.iter().map(|id| Container::Canvas(*id)));
            containers.extend(item_ids.iter().map(|id| Container::Item(*id)));
        }
        for key in containers {
            let wire: &[Id] = match key {
                Container::Canvas(id) => match st.canvases.get(&id) {
                    Some(c) => &c.items,
                    None => continue,
                },
                Container::Item(id) => match st.items.get(&id) {
                    Some(i) => &i.children,
                    None => continue,
                },
            };
            let current = self.children_of(key).unwrap();
            let shared = current.len().min(wire.len());
            let mut first = (0..shared).find(|&i| current[i] != wire[i]);
            if first.is_none() && current.len() != wire.len() {
                first = Some(shared);
            }
            let Some(first) = first else { continue };
            let container_rid = self.container_rid(Some(key));
            for &child in &wire[first..] {
                let child_rid = RidRef::Item(self.items[&child].handle);
                ops.op(Op::ItemSetParent, 1);
                ops.rid(child_rid);
                ops.rid(container_rid);
                c.reparented += 1;
                let current = self.children_of(key).unwrap();
                if let Some(at) = current.iter().position(|x| *x == child) {
                    current.remove(at);
                }
                current.push(child);
            }
        }

        // 6. Setters and 7. content (clip after content), for the items to visit.
        let mut visit: BTreeSet<Id> = item_ids;
        if v5 && !self.full_scan {
            for m in &mat_rid_changed {
                if let Some(set) = self.mat_items.get(m) {
                    visit.extend(set.iter().copied().filter(|id| st.items.contains_key(id)));
                }
            }
            if tex_rid_changed {
                visit.extend(
                    self.rid_param_items
                        .iter()
                        .copied()
                        .filter(|id| st.items.contains_key(id)),
                );
            }
        }
        // G8kf: an item that skipped a command for an undrawable texture replays once an apply
        // uploads that texture.
        let mut forced: BTreeSet<Id> = BTreeSet::new();
        if !self.skipped_items.is_empty() {
            for up in &uploads {
                if let Some(items) = self.skipped_items.get(&up.id) {
                    for item in items {
                        if self.items.contains_key(item) && st.items.contains_key(item) {
                            forced.insert(*item);
                        }
                    }
                }
            }
            visit.extend(forced.iter().copied());
        }
        for id in visit {
            self.apply_item(
                st,
                id,
                fresh.contains(&id),
                forced.contains(&id),
                ops,
                &mut c,
                &mut unsupported,
            );
        }

        // 8. Canvas 1 transform; 9. canvas 1 modulate.
        let root = &st.canvases[&1];
        if self.root_xform.is_none_or(|x| !feq(&x, &root.xform)) {
            ops.op(Op::ViewportSetCanvasTransform, 1);
            ops.rid(RidRef::RootCanvas);
            ops.fs(&root.xform);
            self.root_xform = Some(root.xform);
        }
        if v5 && !feq(&root.modulate, &self.root_modulate) {
            if !self.sab.ignore_canvas_modulate {
                ops.op(Op::CanvasSetModulate, 1);
                ops.rid(RidRef::RootCanvas);
                ops.fs(&root.modulate);
                c.modulate_sets += 1;
            }
            self.root_modulate = root.modulate;
        }

        let calls = (ops.rs_calls - ops_before) as i64;
        self.rs_calls += calls;
        write_stats(
            stats,
            &c,
            calls,
            &unsupported,
            &uploads,
            &mesh_uploads,
            &skipped_shaders,
        );
        Ok(())
    }

    fn apply_canvas(&mut self, id: Id, wire: &Canvas, ops: &mut OpBuf, c: &mut Counters) {
        let sab_stacking = self.sab.ignore_canvas_stacking;
        let v5 = self.version >= 5;
        let st = self.canvases.get_mut(&id).unwrap();
        let rid = st.rid;
        if wire.attached && !st.attached {
            ops.op(Op::ViewportAttachCanvas, 1);
            ops.rid(rid);
            c.canvas_attach += 1;
            st.attached = true;
            st.layer = 0;
            st.sublayer = 0;
            st.xform = IDENTITY;
        } else if !wire.attached && st.attached {
            ops.op(Op::ViewportRemoveCanvas, 1);
            ops.rid(rid);
            c.canvas_attach += 1;
            st.attached = false;
        }
        if st.attached {
            if (wire.layer != st.layer || wire.sublayer != st.sublayer) && !sab_stacking {
                ops.op(Op::ViewportSetCanvasStacking, 1);
                ops.rid(rid);
                ops.i64(wire.layer);
                ops.i64(wire.sublayer);
                c.canvas_stacking_sets += 1;
                st.layer = wire.layer;
                st.sublayer = wire.sublayer;
            }
            if !feq(&wire.xform, &st.xform) {
                ops.op(Op::ViewportSetCanvasTransform, 1);
                ops.rid(rid);
                ops.fs(&wire.xform);
                st.xform = wire.xform;
            }
        }
        if v5 && !feq(&wire.modulate, &st.modulate) {
            ops.op(Op::CanvasSetModulate, 1);
            ops.rid(rid);
            ops.fs(&wire.modulate);
            st.modulate = wire.modulate;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_meshes(
        &mut self,
        st: &ResolvedState,
        payloads: &Payloads,
        ops: &mut OpBuf,
        c: &mut Counters,
        uploads: &mut Vec<MeshUpload>,
        touched: &Touched,
        cands: &[Id],
    ) -> Result<(), String> {
        let free: Vec<Id> = if self.full_scan {
            self.meshes.keys().copied().collect()
        } else {
            touched
                .meshes
                .iter()
                .copied()
                .filter(|id| self.meshes.contains_key(id))
                .collect()
        };
        for id in free {
            let gone = st
                .meshes
                .get(&id)
                .is_none_or(|e| e.status == EntryStatus::Freed);
            if !gone {
                continue;
            }
            let m = self.meshes.remove(&id).unwrap();
            ops.op(Op::FreeRid, 1);
            ops.rid(RidRef::Mesh(m.handle));
            self.freed_by_apply += 1;
            c.meshes_freed += 1;
            uploads.push(MeshUpload {
                id,
                op: "free",
                surfaces: vec![],
                buffers: vec![],
                bytes: 0,
            });
        }
        for &id in cands {
            let Some(e) = st.meshes.get(&id) else {
                continue;
            };
            if e.status != EntryStatus::Ok {
                continue;
            }
            let wire_hashes: Vec<Hash> = e.surfaces.iter().map(|s| s.hash).collect();
            let mut decoded: Vec<SurfaceBytes> = Vec::with_capacity(wire_hashes.len());
            for (k, h) in wire_hashes.iter().enumerate() {
                let kept = self
                    .meshes
                    .get(&id)
                    .filter(|m| m.hashes.get(k) == Some(h))
                    .and_then(|m| m.surfaces.get(k))
                    .cloned();
                match kept {
                    Some(s) => decoded.push(s),
                    None => decoded.push(SurfaceBytes::of(&payloads.mesh(h)?)),
                }
            }
            let layouts: Vec<Layout> = decoded.iter().map(|s| s.layout.clone()).collect();
            let custom_aabb = e.custom_aabb;
            let rebuild = match self.meshes.get(&id) {
                None => true,
                Some(m) => m.layouts != layouts,
            };
            if rebuild {
                let op_name = if !self.meshes.contains_key(&id) {
                    let h = self.handle(3);
                    ops.op(Op::MeshCreate, 1);
                    ops.u(h);
                    self.created_rids += 1;
                    self.meshes.insert(
                        id,
                        MeshM {
                            handle: h,
                            hashes: vec![],
                            layouts: vec![],
                            surfaces: vec![],
                            custom_aabb: None,
                        },
                    );
                    c.meshes_created += 1;
                    "create"
                } else {
                    let h = self.meshes[&id].handle;
                    ops.op(Op::MeshClear, 1);
                    ops.rid(RidRef::Mesh(h));
                    c.meshes_rebuilt += 1;
                    "rebuild"
                };
                let h = self.meshes[&id].handle;
                let mut added = Vec::new();
                let mut built = 0i64;
                for (k, s) in decoded.iter().enumerate() {
                    if self.sab.drop_mesh_surface && k == 1 {
                        continue;
                    }
                    ops.op(Op::MeshAddSurface, 1);
                    ops.rid(RidRef::Mesh(h));
                    ops.u(primitive_index(s.layout.primitive));
                    ops.i64(s.layout.format);
                    ops.i64(s.layout.vertex_count);
                    ops.i64(s.layout.index_count);
                    ops.fs(&s.aabb);
                    ops.fs(&s.uv_scale);
                    for b in &s.bufs {
                        ops.bytes(b);
                    }
                    added.push(k as i64);
                    built += s.data_bytes();
                }
                let m = self.meshes.get_mut(&id).unwrap();
                m.hashes = wire_hashes;
                m.layouts = layouts;
                m.surfaces = decoded;
                c.mesh_upload_bytes += built;
                uploads.push(MeshUpload {
                    id,
                    op: op_name,
                    surfaces: added,
                    buffers: vec![],
                    bytes: built,
                });
                let differs = m.custom_aabb.is_none_or(|a| !feq(&a, &custom_aabb));
                if op_name == "create" || differs {
                    m.custom_aabb = Some(custom_aabb);
                    ops.op(Op::MeshSetCustomAabb, 1);
                    ops.rid(RidRef::Mesh(h));
                    ops.fs(&custom_aabb);
                    if op_name == "rebuild" {
                        uploads.push(MeshUpload {
                            id,
                            op: "custom_aabb",
                            surfaces: vec![],
                            buffers: vec![],
                            bytes: 0,
                        });
                    }
                }
                continue;
            }
            let h = self.meshes[&id].handle;
            for (k, wh) in wire_hashes.iter().enumerate() {
                if self.meshes[&id].hashes[k] == *wh {
                    continue;
                }
                if self.sab.stale_mesh {
                    continue;
                }
                if self.sab.drop_mesh_surface && k == 1 {
                    let m = self.meshes.get_mut(&id).unwrap();
                    m.hashes[k] = *wh;
                    m.surfaces[k] = decoded[k].clone();
                    continue;
                }
                let mut changed = Vec::new();
                let mut surface_bytes = 0i64;
                const NAMES: [&str; 4] = ["vertex", "attribute", "skin", "index"];
                for (b, name) in NAMES.iter().enumerate() {
                    let new = &decoded[k].bufs[b];
                    if self.meshes[&id].surfaces[k].bufs[b] == *new {
                        continue;
                    }
                    ops.op(Op::MeshSurfaceUpdateRegion, 1);
                    ops.rid(RidRef::Mesh(h));
                    ops.u(b as u32);
                    ops.u(k as u32);
                    ops.bytes(new);
                    c.surface_updates += 1;
                    changed.push(*name);
                    surface_bytes += new.len() as i64;
                }
                let m = self.meshes.get_mut(&id).unwrap();
                m.hashes[k] = *wh;
                m.surfaces[k] = decoded[k].clone();
                c.mesh_upload_bytes += surface_bytes;
                uploads.push(MeshUpload {
                    id,
                    op: "update",
                    surfaces: vec![k as i64],
                    buffers: changed,
                    bytes: surface_bytes,
                });
            }
            let m = self.meshes.get_mut(&id).unwrap();
            if m.custom_aabb.is_none_or(|a| !feq(&a, &custom_aabb)) {
                m.custom_aabb = Some(custom_aabb);
                ops.op(Op::MeshSetCustomAabb, 1);
                ops.rid(RidRef::Mesh(h));
                ops.fs(&custom_aabb);
                uploads.push(MeshUpload {
                    id,
                    op: "custom_aabb",
                    surfaces: vec![],
                    buffers: vec![],
                    bytes: 0,
                });
            }
        }
        Ok(())
    }

    fn free_shader(&mut self, id: Id, ops: &mut OpBuf, c: &mut Counters) {
        let s = self.shaders.remove(&id).unwrap();
        ops.op(Op::FreeRid, 1);
        ops.rid(RidRef::Shader(s.handle));
        self.freed_by_apply += 1;
        c.shaders_freed += 1;
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_shaders(
        &mut self,
        st: &ResolvedState,
        payloads: &Payloads,
        ops: &mut OpBuf,
        c: &mut Counters,
        skipped: &mut Vec<SkippedShader>,
        touched: &Touched,
        named: &BTreeSet<Id>,
    ) -> Result<(), String> {
        let free: Vec<Id> = if self.full_scan {
            self.shaders.keys().copied().collect()
        } else {
            touched
                .shaders
                .iter()
                .copied()
                .filter(|id| self.shaders.contains_key(id))
                .collect()
        };
        for id in free {
            let gone = st
                .shaders
                .get(&id)
                .is_none_or(|e| e.status != EntryStatus::Ok);
            if gone {
                self.free_shader(id, ops, c);
            }
        }
        for &id in named {
            let e = &st.shaders[&id];
            let hash = e.hash;
            let current = self.shaders.get(&id).is_some_and(|s| s.hash == hash);
            let mut code: &str = "";
            if !current && e.source == Some(ShaderSource::Payload) {
                let h =
                    hash.ok_or_else(|| format!("resource-invalid: shader {id} names no payload"))?;
                code = payloads.shader(&h)?;
            } else if !current && e.source == Some(ShaderSource::Withheld) {
                let key = hash.map(|h| h.to_hex()).unwrap_or_default();
                match payloads.library.get(&key) {
                    Some(Library::Ok(text)) => code = text.as_str(),
                    other => {
                        let detail = match other {
                            Some(Library::Missing(d)) => d.clone(),
                            _ => "the library result was not provided before apply".into(),
                        };
                        skipped.push(SkippedShader {
                            id,
                            hash: key,
                            reason: "shader-withheld",
                            detail,
                        });
                        if self.shaders.contains_key(&id) {
                            self.free_shader(id, ops, c);
                        }
                        continue;
                    }
                }
            }
            if !self.shaders.contains_key(&id) {
                let h = self.handle(4);
                ops.op(Op::ShaderCreate, 1);
                ops.u(h);
                self.created_rids += 1;
                self.shaders.insert(
                    id,
                    ShaderM {
                        handle: h,
                        hash: None,
                        defaults: vec![],
                    },
                );
                c.shaders_created += 1;
            }
            let h = self.shaders[&id].handle;
            if self.shaders[&id].hash != hash {
                ops.op(Op::ShaderSetCode, 1);
                ops.rid(RidRef::Shader(h));
                if self.sab.vertex_flat_varyings {
                    let flat = render_stream_core::apply::programs::flat_varyings(code);
                    ops.bytes(flat.as_bytes());
                } else {
                    ops.bytes(code.as_bytes());
                }
                self.shaders.get_mut(&id).unwrap().hash = hash;
                c.shader_code_sets += 1;
            }
            let mut wanted: BTreeSet<String> = BTreeSet::new();
            for d in &e.default_textures {
                let key = format!("{}/{}", d.name, d.index);
                wanted.insert(key.clone());
                let (rid, serial) = self.texture_rid(st, d.tex);
                let sh = self.shaders.get_mut(&id).unwrap();
                if let Some(entry) = sh.defaults.iter_mut().find(|x| x.0 == key) {
                    if entry.3 == serial {
                        continue;
                    }
                    entry.3 = serial;
                } else {
                    sh.defaults.push((key, d.name.clone(), d.index, serial));
                }
                ops.op(Op::ShaderSetDefaultTexture, 1);
                ops.rid(RidRef::Shader(h));
                ops.bytes(d.name.as_bytes());
                ops.rid(rid);
                ops.i64(d.index);
                c.default_texture_sets += 1;
            }
            let stale: Vec<(Box<str>, i64)> = self.shaders[&id]
                .defaults
                .iter()
                .filter(|x| !wanted.contains(&x.0))
                .map(|x| (x.1.clone(), x.2))
                .collect();
            for (name, index) in stale {
                ops.op(Op::ShaderSetDefaultTexture, 1);
                ops.rid(RidRef::Shader(h));
                ops.bytes(name.as_bytes());
                ops.rid(RidRef::None);
                ops.i64(index);
                let sh = self.shaders.get_mut(&id).unwrap();
                sh.defaults.retain(|x| !(x.1 == name && x.2 == index));
                c.default_texture_sets += 1;
            }
        }
        Ok(())
    }

    fn apply_materials(
        &mut self,
        st: &ResolvedState,
        ops: &mut OpBuf,
        c: &mut Counters,
        named: &BTreeSet<Id>,
        rid_changed: &mut BTreeSet<Id>,
    ) {
        let resident: Vec<Id> = self.materials.keys().copied().collect();
        for id in resident {
            let gone = st
                .materials
                .get(&id)
                .is_none_or(|e| e.status != EntryStatus::Ok);
            if !gone {
                continue;
            }
            let m = self.materials.remove(&id).unwrap();
            ops.op(Op::FreeRid, 1);
            ops.rid(RidRef::Material(m.handle));
            self.freed_by_apply += 1;
            c.materials_freed += 1;
            rid_changed.insert(id);
        }
        for &id in named {
            let e = &st.materials[&id];
            let is_new = !self.materials.contains_key(&id);
            if is_new {
                let h = self.handle(5);
                ops.op(Op::MaterialCreate, 1);
                ops.u(h);
                self.created_rids += 1;
                self.materials.insert(
                    id,
                    MaterialM {
                        handle: h,
                        shader: None,
                        params: vec![],
                    },
                );
                c.materials_created += 1;
                rid_changed.insert(id);
            }
            let h = self.materials[&id].handle;
            let shader = e
                .shader
                .and_then(|s| self.shaders.get(&s))
                .map(|s| s.handle);
            if shader != self.materials[&id].shader {
                ops.op(Op::MaterialSetShader, 1);
                ops.rid(RidRef::Material(h));
                ops.rid(shader.map(RidRef::Shader).unwrap_or(RidRef::None));
                self.materials.get_mut(&id).unwrap().shader = shader;
                c.material_shader_sets += 1;
            }
            if self.sab.stale_param && !is_new {
                continue;
            }
            let mut wanted: BTreeSet<&str> = BTreeSet::new();
            for p in &e.params {
                wanted.insert(&p.name);
                let (variant, key) = self.param(st, p);
                let m = self.materials.get_mut(&id).unwrap();
                if let Some(entry) = m.params.iter_mut().find(|x| x.0 == p.name) {
                    if entry.1 == key {
                        continue;
                    }
                    entry.1 = key;
                } else {
                    m.params.push((p.name.clone(), key));
                }
                ops.op(Op::MaterialSetParam, 1);
                ops.rid(RidRef::Material(h));
                ops.bytes(p.name.as_bytes());
                ops.bytes(&variant.out);
                c.param_sets += 1;
            }
            let stale: Vec<Box<str>> = self.materials[&id]
                .params
                .iter()
                .filter(|x| !wanted.contains(&*x.0))
                .map(|x| x.0.clone())
                .collect();
            for name in stale {
                ops.op(Op::MaterialSetParam, 1);
                ops.rid(RidRef::Material(h));
                ops.bytes(name.as_bytes());
                ops.bytes(&[crate::vt::T_NIL]);
                self.materials
                    .get_mut(&id)
                    .unwrap()
                    .params
                    .retain(|x| x.0 != name);
                c.param_sets += 1;
            }
        }
    }

    fn apply_item(
        &mut self,
        st: &ResolvedState,
        id: Id,
        is_new: bool,
        force_content: bool,
        ops: &mut OpBuf,
        c: &mut Counters,
        unsupported: &mut Vec<UnsupportedCommand>,
    ) {
        let wire = &st.items[&id];
        let sab = self.sab;
        let v5 = self.version >= 5;
        let me = self.items.get_mut(&id).unwrap();
        let rid = RidRef::Item(me.handle);
        if is_new || !feq(&wire.xform, &me.xform) {
            ops.op(Op::ItemSetTransform, 1);
            ops.rid(rid);
            ops.fs(&wire.xform);
            me.xform = wire.xform;
        }
        if is_new || !feq(&wire.modulate, &me.modulate) {
            ops.op(Op::ItemSetModulate, 1);
            ops.rid(rid);
            ops.fs(&wire.modulate);
            me.modulate = wire.modulate;
        }
        if is_new || !feq(&wire.self_modulate, &me.self_modulate) {
            ops.op(Op::ItemSetSelfModulate, 1);
            ops.rid(rid);
            ops.fs(&wire.self_modulate);
            me.self_modulate = wire.self_modulate;
        }
        if is_new || wire.visible != me.visible {
            ops.op(Op::ItemSetVisible, 1);
            ops.rid(rid);
            ops.b(wire.visible);
            me.visible = wire.visible;
        }
        let apply_clip = |me: &mut ItemM, ops: &mut OpBuf| {
            if is_new || wire.clip != me.clip {
                ops.op(Op::ItemSetClip, 1);
                ops.rid(rid);
                ops.b(if sab.ignore_clip { false } else { wire.clip });
                me.clip = wire.clip;
            }
        };
        if sab.clip_before_clear {
            apply_clip(me, ops);
        }
        if is_new
            || wire.custom_rect != me.custom_rect
            || !feq(&wire.custom_rect_rect, &me.custom_rect_floats)
        {
            ops.op(Op::ItemSetCustomRect, 1);
            ops.rid(rid);
            ops.b(wire.custom_rect);
            ops.fs(&wire.custom_rect_rect);
            me.custom_rect = wire.custom_rect;
            me.custom_rect_floats = wire.custom_rect_rect;
        }
        let layer = wire.visibility_layer as i64;
        if is_new || layer != me.visibility_layer {
            ops.op(Op::ItemSetVisibilityLayer, 1);
            ops.rid(rid);
            ops.i64(layer);
            me.visibility_layer = layer;
        }
        if is_new || wire.z_index != me.z_index {
            ops.op(Op::ItemSetZIndex, 1);
            ops.rid(rid);
            ops.i64(wire.z_index);
            me.z_index = wire.z_index;
        }
        if is_new || wire.z_relative != me.z_relative {
            ops.op(Op::ItemSetZRelative, 1);
            ops.rid(rid);
            ops.b(wire.z_relative);
            me.z_relative = wire.z_relative;
        }
        if is_new || wire.behind != me.behind {
            ops.op(Op::ItemSetDrawBehindParent, 1);
            ops.rid(rid);
            ops.b(wire.behind);
            me.behind = wire.behind;
        }
        if is_new || wire.draw_index != me.draw_index {
            ops.op(Op::ItemSetDrawIndex, 1);
            ops.rid(rid);
            ops.i64(wire.draw_index);
            me.draw_index = wire.draw_index;
        }
        if wire.texture_filter != me.texture_filter {
            ops.op(Op::ItemSetDefaultFilter, 1);
            ops.rid(rid);
            ops.u(filter_index(wire.texture_filter));
            me.texture_filter = wire.texture_filter;
        }
        if wire.texture_repeat != me.texture_repeat {
            ops.op(Op::ItemSetDefaultRepeat, 1);
            ops.rid(rid);
            ops.u(repeat_index(wire.texture_repeat));
            me.texture_repeat = wire.texture_repeat;
        }
        if v5 {
            // _apply_item_material
            let mut material_rid: Option<u32> = None;
            let mut reason = "";
            if let Some(m) = wire.material {
                if let Some(mm) = self.materials.get(&m) {
                    material_rid = Some(mm.handle);
                } else if st.materials.contains_key(&m) {
                    reason = "unsupported-material";
                } else {
                    reason = "unknown-material";
                }
            }
            let instance: Vec<(Vt, ParamKey)> = wire
                .instance_params
                .iter()
                .map(|p| self.param(st, p))
                .collect();
            let me = self.items.get_mut(&id).unwrap();
            let wire_changed = wire.material != me.material_wire;
            if !reason.is_empty() && wire_changed {
                unsupported.push(UnsupportedCommand {
                    item: id,
                    name: "canvas_item_set_material".into(),
                    reason,
                });
            }
            me.material_wire = wire.material;
            if material_rid != me.material_rid {
                if !sab.ignore_material {
                    ops.op(Op::ItemSetMaterial, 1);
                    ops.rid(rid);
                    ops.rid(material_rid.map(RidRef::Material).unwrap_or(RidRef::None));
                    c.material_sets += 1;
                }
                me.material_rid = material_rid;
            }
            if wire.use_parent_material != me.use_parent_material {
                ops.op(Op::ItemSetUseParentMaterial, 1);
                ops.rid(rid);
                ops.b(wire.use_parent_material);
                me.use_parent_material = wire.use_parent_material;
                c.use_parent_material_sets += 1;
            }
            let mut wanted: BTreeSet<&str> = BTreeSet::new();
            for (p, (variant, key)) in wire.instance_params.iter().zip(instance) {
                wanted.insert(&p.name);
                if let Some(entry) = me.instance_params.iter_mut().find(|x| x.0 == p.name) {
                    if entry.1 == key {
                        continue;
                    }
                    entry.1 = key;
                } else {
                    me.instance_params.push((p.name.clone(), key));
                }
                ops.op(Op::ItemSetInstanceParam, 1);
                ops.rid(rid);
                ops.bytes(p.name.as_bytes());
                ops.bytes(&variant.out);
                c.instance_param_sets += 1;
            }
            let stale: Vec<Box<str>> = me
                .instance_params
                .iter()
                .filter(|x| !wanted.contains(&*x.0))
                .map(|x| x.0.clone())
                .collect();
            for name in stale {
                ops.op(Op::ItemSetInstanceParam, 1);
                ops.rid(rid);
                ops.bytes(name.as_bytes());
                ops.bytes(&[crate::vt::T_NIL]);
                me.instance_params.retain(|x| x.0 != name);
                c.instance_param_sets += 1;
            }
        }

        // CG1 (render-stream-10.md "Receivers"): re-issue the item's back-buffer state whenever it
        // differs from what this receiver last set; its own Godot does the rest.
        let v10 = self.version >= 10;
        let me = self.items.get_mut(&id).unwrap();
        let group = if v10 && !sab.drop_canvas_group {
            wire.canvas_group
        } else {
            None
        };
        if !canvas_group_eq(&group, &me.canvas_group) {
            // RS's defaults for a disabled call (the engine frees the state, the rest is unused).
            let (mode, clear_margin, fit_empty, fit_margin, blur_mipmaps) = match &group {
                Some(g) => (
                    g.mode_value(),
                    g.clear_margin,
                    g.fit_empty,
                    g.fit_margin,
                    g.blur_mipmaps,
                ),
                None => (0, 5.0, false, 0.0, false),
            };
            ops.op(Op::ItemSetCanvasGroupMode, 1);
            ops.rid(rid);
            ops.i64(mode);
            ops.f(clear_margin);
            ops.b(fit_empty);
            ops.f(fit_margin);
            ops.b(blur_mipmaps);
            me.canvas_group = group;
            c.canvas_group_sets += 1;
        }
        let mut copy = if v10 {
            wire.copy_to_backbuffer.map(|r| {
                if sab.full_backbuffer_copy {
                    [0.0; 4]
                } else {
                    r
                }
            })
        } else {
            None
        };
        // P3-ST's `screen-copy-per-reader` sabotage: a full-target copy on each item whose own
        // material reads the screen, only where the wire sets no copy of its own.
        if sab.screen_copy_per_reader && v5 && copy.is_none() {
            let reads_screen = wire
                .material
                .and_then(|m| st.materials.get(&m))
                .and_then(|m| m.shader)
                .and_then(|s| st.shaders.get(&s))
                .is_some_and(|s| s.uses.contains(&ShaderUse::ScreenTexture));
            if reads_screen {
                copy = Some([0.0; 4]);
            }
        }
        if !rect_bits_eq(&copy, &me.copy_to_backbuffer) {
            ops.op(Op::ItemSetCopyToBackbuffer, 1);
            ops.rid(rid);
            ops.b(copy.is_some());
            ops.fs(&copy.unwrap_or([0.0; 4]));
            me.copy_to_backbuffer = copy;
            c.backbuffer_copy_sets += 1;
        }

        // P3-ST: a refused screen reader draws nothing (drawn plain it would cover what it reads).
        let screen_skip = v5 && self.refused_screen_reader(st, id);
        let skip_changed = screen_skip != self.items[&id].screen_skip;
        self.items.get_mut(&id).unwrap().screen_skip = screen_skip;
        let me_version = self.items[&id].content_version;
        if is_new || force_content || skip_changed || wire.content_version != me_version {
            if !is_new {
                ops.op(Op::ItemClear, 1);
                ops.rid(rid);
                if !sab.clip_before_clear {
                    self.items.get_mut(&id).unwrap().clip = false;
                }
            }
            // G8kf: forget the textures the last replay skipped, replay, remember the new ones.
            for tex in std::mem::take(&mut self.items.get_mut(&id).unwrap().skipped_tex) {
                if let Some(set) = self.skipped_items.get_mut(&tex) {
                    set.remove(&id);
                    if set.is_empty() {
                        self.skipped_items.remove(&tex);
                    }
                }
            }
            self.tex_skips.borrow_mut().clear();
            if !screen_skip {
                self.replay(st, id, rid, &wire.commands, ops, c, unsupported);
            }
            let mut skipped: Vec<Id> = std::mem::take(&mut *self.tex_skips.borrow_mut());
            skipped.sort_unstable();
            skipped.dedup();
            for tex in &skipped {
                self.skipped_items.entry(*tex).or_default().insert(id);
            }
            let me = self.items.get_mut(&id).unwrap();
            me.skipped_tex = skipped;
            me.content_version = wire.content_version;
        }
        if !sab.clip_before_clear {
            let me = self.items.get_mut(&id).unwrap();
            apply_clip(me, ops);
        }
    }

    /// P3-ST: whether `id`'s effective material (its own, or an ancestor's while
    /// `use_parent_material` holds) is one this receiver did not create -- refused on the wire --
    /// and its shader reads the screen texture.
    fn refused_screen_reader(&self, st: &ResolvedState, id: Id) -> bool {
        let mut item = &st.items[&id];
        let mut hops = 0;
        while item.use_parent_material && hops < 4096 {
            match item.parent.as_ref() {
                Some(p) if p.kind == ParentKind::Item => match st.items.get(&p.id) {
                    Some(parent) => item = parent,
                    None => break,
                },
                _ => break,
            }
            hops += 1;
        }
        let Some(mid) = item.material else {
            return false;
        };
        let Some(m) = st.materials.get(&mid) else {
            return false;
        };
        let Some((sid, shader)) = m.shader.and_then(|s| st.shaders.get(&s).map(|e| (s, e))) else {
            return false;
        };
        if !shader.uses.contains(&ShaderUse::ScreenTexture) {
            return false;
        }
        // Refused: the material or its shader is unsupported on the wire, or this receiver made
        // no code for it (a withheld shader without the library).
        m.status != EntryStatus::Ok
            || shader.status != EntryStatus::Ok
            || !self.materials.contains_key(&mid)
            || !self.shaders.get(&sid).is_some_and(|x| x.hash.is_some())
    }

    #[allow(clippy::too_many_arguments)]
    fn replay(
        &self,
        st: &ResolvedState,
        id: Id,
        rid: RidRef,
        cmds: &Commands,
        ops: &mut OpBuf,
        c: &mut Counters,
        unsupported: &mut Vec<UnsupportedCommand>,
    ) {
        let sab = self.sab;
        for cmd in &cmds.list {
            let op_name = cmd.op();
            match cmd {
                Command::Rect { aa, rect, color } => {
                    ops.op(Op::AddRect, 1);
                    ops.rid(rid);
                    ops.fs(rect);
                    ops.fs(color);
                    ops.b(*aa);
                    c.replayed += 1;
                }
                Command::TextureRect {
                    tex,
                    tile,
                    transpose,
                    rect,
                    modulate,
                } => {
                    let (ok, t, reason) = self.texture_for(st, *tex);
                    if !ok {
                        c.skipped += 1;
                        unsupported.push(UnsupportedCommand {
                            item: id,
                            name: format!("canvas_item_{op_name}"),
                            reason,
                        });
                        continue;
                    }
                    ops.op(Op::AddTextureRect, 1);
                    ops.rid(rid);
                    ops.fs(rect);
                    ops.rid(t);
                    ops.b(*tile);
                    ops.fs(modulate);
                    ops.b(*transpose);
                    c.replayed += 1;
                }
                Command::TextureRectRegion {
                    tex,
                    transpose,
                    clip_uv,
                    rect,
                    src,
                    modulate,
                } => {
                    let (ok, t, reason) = self.texture_for(st, *tex);
                    if !ok {
                        c.skipped += 1;
                        unsupported.push(UnsupportedCommand {
                            item: id,
                            name: format!("canvas_item_{op_name}"),
                            reason,
                        });
                        continue;
                    }
                    ops.op(Op::AddTextureRectRegion, 1);
                    ops.rid(rid);
                    ops.fs(rect);
                    ops.rid(t);
                    ops.fs(src);
                    ops.fs(modulate);
                    ops.b(*transpose);
                    ops.b(*clip_uv);
                    c.replayed += 1;
                }
                Command::MsdfTextureRectRegion {
                    tex,
                    outline,
                    rect,
                    src,
                    modulate,
                    px_range,
                    scale,
                } => {
                    if sab.drop_msdf {
                        continue;
                    }
                    let (ok, t, reason) = self.texture_for(st, *tex);
                    if !ok {
                        c.skipped += 1;
                        unsupported.push(UnsupportedCommand {
                            item: id,
                            name: format!("canvas_item_{op_name}"),
                            reason,
                        });
                        continue;
                    }
                    ops.op(Op::AddMsdfTextureRectRegion, 1);
                    ops.rid(rid);
                    ops.fs(rect);
                    ops.rid(t);
                    ops.fs(src);
                    ops.fs(modulate);
                    ops.i64(*outline);
                    ops.f(*px_range);
                    ops.f(*scale);
                    c.replayed += 1;
                    c.msdf += 1;
                }
                Command::Line { .. }
                | Command::Polyline { .. }
                | Command::Multiline { .. }
                | Command::Circle { .. }
                | Command::Primitive { .. }
                | Command::Polygon { .. }
                | Command::TriangleArray { .. }
                | Command::NinePatch { .. }
                | Command::SetTransform { .. }
                | Command::ClipIgnore { .. } => {
                    if matches!(cmd, Command::SetTransform { .. }) && sab.ignore_set_transform {
                        continue;
                    }
                    if matches!(cmd, Command::ClipIgnore { .. }) && sab.ignore_clip_ignore {
                        continue;
                    }
                    let mut geometry_tex = RidRef::None;
                    let textured = matches!(
                        cmd,
                        Command::Primitive { .. }
                            | Command::Polygon { .. }
                            | Command::TriangleArray { .. }
                            | Command::NinePatch { .. }
                    );
                    if textured {
                        let (ok, t, reason) = self.texture_for(st, cmd.tex());
                        if !ok {
                            c.skipped += 1;
                            unsupported.push(UnsupportedCommand {
                                item: id,
                                name: format!("canvas_item_{op_name}"),
                                reason,
                            });
                            continue;
                        }
                        geometry_tex = t;
                    }
                    replay_geometry(ops, rid, cmd, cmds, geometry_tex, sab);
                    c.replayed += 1;
                    c.geometry += 1;
                }
                Command::Mesh {
                    mesh,
                    tex,
                    transform,
                    modulate,
                } => {
                    let reason = match st.meshes.get(mesh) {
                        None => "unknown-mesh",
                        Some(m) if m.status == EntryStatus::Freed => "mesh-freed",
                        Some(m) if m.status != EntryStatus::Ok => "unsupported-mesh",
                        Some(_) if !self.meshes.contains_key(mesh) => "mesh-not-resident",
                        Some(_) => "",
                    };
                    if !reason.is_empty() {
                        c.skipped_mesh += 1;
                        unsupported.push(UnsupportedCommand {
                            item: id,
                            name: "canvas_item_add_mesh".into(),
                            reason,
                        });
                        continue;
                    }
                    let (ok, t, reason) = self.texture_for(st, *tex);
                    if !ok {
                        c.skipped += 1;
                        unsupported.push(UnsupportedCommand {
                            item: id,
                            name: "canvas_item_add_mesh".into(),
                            reason,
                        });
                        continue;
                    }
                    ops.op(Op::AddMesh, 1);
                    ops.rid(rid);
                    ops.rid(RidRef::Mesh(self.meshes[mesh].handle));
                    ops.fs(transform);
                    ops.fs(modulate);
                    ops.rid(t);
                    c.replayed += 1;
                    c.mesh_commands += 1;
                }
                Command::Unsupported { name, reason } => {
                    c.skipped += 1;
                    unsupported.push(UnsupportedCommand {
                        item: id,
                        name: name.to_string(),
                        reason: reason.as_str(),
                    });
                }
            }
        }
    }

    /// `dispose()`: frees every RID this planner created (items, owned canvases, textures, meshes,
    /// materials, shaders), puts canvas 1's modulate back to white, forgets all state.
    pub fn dispose(&mut self, ops: &mut OpBuf) -> i64 {
        let mut n = 0i64;
        let ops_before = ops.rs_calls;
        let items = std::mem::take(&mut self.items);
        for m in items.values() {
            ops.op(Op::FreeRid, 1);
            ops.rid(RidRef::Item(m.handle));
            n += 1;
        }
        let canvases = std::mem::take(&mut self.canvases);
        for m in canvases.values() {
            if m.owned {
                ops.op(Op::FreeRid, 1);
                ops.rid(m.rid);
                n += 1;
            }
        }
        let textures = std::mem::take(&mut self.textures);
        for m in textures.values() {
            ops.op(Op::FreeRid, 1);
            ops.rid(RidRef::Texture(m.handle));
            n += 1;
        }
        let meshes = std::mem::take(&mut self.meshes);
        for m in meshes.values() {
            ops.op(Op::FreeRid, 1);
            ops.rid(RidRef::Mesh(m.handle));
            n += 1;
        }
        let materials = std::mem::take(&mut self.materials);
        for m in materials.values() {
            ops.op(Op::FreeRid, 1);
            ops.rid(RidRef::Material(m.handle));
            n += 1;
        }
        let shaders = std::mem::take(&mut self.shaders);
        for m in shaders.values() {
            ops.op(Op::FreeRid, 1);
            ops.rid(RidRef::Shader(m.handle));
            n += 1;
        }
        if !feq(&self.root_modulate, &WHITE) && !self.sab.ignore_canvas_modulate {
            ops.op(Op::CanvasSetModulate, 1);
            ops.rid(RidRef::RootCanvas);
            ops.fs(&WHITE);
        }
        self.root_modulate = WHITE;
        self.root_xform = None;
        self.default_filter = None;
        self.default_repeat = None;
        self.named.clear();
        self.tex_count.clear();
        self.mesh_count.clear();
        self.mat_count.clear();
        self.mat_items.clear();
        self.rid_param_items.clear();
        self.mattex.clear();
        self.canvas_ids.clear();
        self.skipped_items.clear();
        self.tex_skips.borrow_mut().clear();
        self.touched.clear();
        self.rs_calls += (ops.rs_calls - ops_before) as i64;
        self.disposed_frees = n;
        n
    }
}

/// `_replay_geometry()`: one /4 immediate-geometry or command-list-state command.
fn replay_geometry(
    ops: &mut OpBuf,
    rid: RidRef,
    cmd: &Command,
    cmds: &Commands,
    tex: RidRef,
    sab: Sabotage,
) {
    match cmd {
        Command::Line {
            aa,
            from,
            to,
            colour,
            width,
        } => {
            ops.op(Op::AddLine, 1);
            ops.rid(rid);
            ops.fs(from);
            ops.fs(to);
            ops.fs(colour);
            ops.f(*width);
            ops.b(*aa);
        }
        Command::Polyline {
            aa,
            width,
            points,
            colors,
        }
        | Command::Multiline {
            aa,
            width,
            points,
            colors,
        } => {
            let op = if matches!(cmd, Command::Polyline { .. }) {
                Op::AddPolyline
            } else {
                Op::AddMultiline
            };
            ops.op(op, 1);
            ops.rid(rid);
            ops.farray(cmds.pairs(*points), 2);
            ops.farray(cmds.quads(*colors), 4);
            ops.f(*width);
            ops.b(*aa);
        }
        Command::Circle {
            aa,
            position,
            radius,
            colour,
        } => {
            ops.op(Op::AddCircle, 1);
            ops.rid(rid);
            ops.fs(position);
            ops.f(*radius);
            ops.fs(colour);
            ops.b(*aa);
        }
        Command::Primitive {
            points,
            colors,
            uvs,
            ..
        }
        | Command::Polygon {
            points,
            colors,
            uvs,
            ..
        } => {
            let op = if matches!(cmd, Command::Primitive { .. }) {
                Op::AddPrimitive
            } else {
                Op::AddPolygon
            };
            ops.op(op, 1);
            ops.rid(rid);
            ops.farray(cmds.pairs(*points), 2);
            ops.farray(cmds.quads(*colors), 4);
            ops.farray(cmds.pairs(*uvs), 2);
            ops.rid(tex);
        }
        Command::TriangleArray {
            count,
            points,
            colors,
            uvs,
            indices,
            ..
        } => {
            ops.op(Op::AddTriangleArray, 1);
            ops.rid(rid);
            ops.iarray(cmds.ints(*indices));
            ops.farray(cmds.pairs(*points), 2);
            ops.farray(cmds.quads(*colors), 4);
            ops.farray(cmds.pairs(*uvs), 2);
            ops.rid(tex);
            ops.i64(*count);
        }
        Command::NinePatch {
            rect,
            source,
            margins,
            x_axis,
            y_axis,
            draw_center,
            modulate,
            ..
        } => {
            let (x, y) = if sab.ignore_nine_patch_axis {
                (Axis::Stretch, Axis::Stretch)
            } else {
                (*x_axis, *y_axis)
            };
            ops.op(Op::AddNinePatch, 1);
            ops.rid(rid);
            ops.fs(rect);
            ops.fs(source);
            ops.rid(tex);
            ops.fs(margins);
            ops.u(axis_index(x));
            ops.u(axis_index(y));
            ops.b(*draw_center);
            ops.fs(modulate);
        }
        Command::SetTransform { transform } => {
            ops.op(Op::AddSetTransform, 1);
            ops.rid(rid);
            ops.fs(transform);
        }
        Command::ClipIgnore { ignore } => {
            ops.op(Op::AddClipIgnore, 1);
            ops.rid(rid);
            ops.b(*ignore);
        }
        _ => unreachable!("not a geometry command"),
    }
}

/// `_param_variant()` for every type but `rid`: the exact Variant the host's engine received.
fn write_param_variant(v: &mut Vt, p: &Param) {
    use VariantType as T;
    let vals: Vec<f64> = match &p.value {
        ParamValue::Nil => {
            v.nil();
            return;
        }
        ParamValue::Tex(_) => {
            v.nil();
            return;
        }
        ParamValue::Scalar(x) => vec![*x],
        ParamValue::Flat(xs) => xs.clone(),
        ParamValue::Nested { values, .. } => values.clone(),
    };
    let ints = |n: usize| -> Vec<i64> { vals.iter().take(n).map(|x| *x as i64).collect() };
    let f = |n: usize| -> Vec<f64> { vals.iter().take(n).copied().collect() };
    match p.ty {
        T::Nil | T::Rid => v.nil(),
        T::Bool => v.bool(vals[0] != 0.0),
        T::Int => v.int(vals[0] as i64),
        T::Float => v.float(vals[0]),
        T::Vector2 => v.math_f(gd::VECTOR2, &f(2)),
        T::Vector2i => v.math_i(gd::VECTOR2I, &ints(2)),
        T::Rect2 => v.math_f(gd::RECT2, &f(4)),
        T::Rect2i => v.math_i(gd::RECT2I, &ints(4)),
        T::Vector3 => v.math_f(gd::VECTOR3, &f(3)),
        T::Vector3i => v.math_i(gd::VECTOR3I, &ints(3)),
        T::Transform2d => v.math_f(gd::TRANSFORM2D, &f(6)),
        T::Vector4 => v.math_f(gd::VECTOR4, &f(4)),
        T::Vector4i => v.math_i(gd::VECTOR4I, &ints(4)),
        T::Plane => v.math_f(gd::PLANE, &f(4)),
        T::Quaternion => v.math_f(gd::QUATERNION, &f(4)),
        T::Aabb => v.math_f(gd::AABB, &f(6)),
        T::Basis => v.math_f(gd::BASIS, &f(9)),
        T::Transform3d => v.math_f(gd::TRANSFORM3D, &f(12)),
        T::Projection => v.math_f(gd::PROJECTION, &f(16)),
        T::Color => v.math_f(gd::COLOR, &f(4)),
        T::PackedInt32Array => {
            let xs: Vec<i64> = vals.iter().map(|x| *x as i64).collect();
            v.packed_i(gd::PACKED_INT32_ARRAY, &xs)
        }
        T::PackedInt64Array => {
            let xs: Vec<i64> = vals.iter().map(|x| *x as i64).collect();
            v.packed_i(gd::PACKED_INT64_ARRAY, &xs)
        }
        T::PackedFloat32Array => v.packed_f(gd::PACKED_FLOAT32_ARRAY, vals.len(), &vals),
        T::PackedFloat64Array => v.packed_f(gd::PACKED_FLOAT64_ARRAY, vals.len(), &vals),
        T::PackedVector2Array => v.packed_f(gd::PACKED_VECTOR2_ARRAY, vals.len() / 2, &vals),
        T::PackedVector3Array => v.packed_f(gd::PACKED_VECTOR3_ARRAY, vals.len() / 3, &vals),
        T::PackedVector4Array => v.packed_f(gd::PACKED_VECTOR4_ARRAY, vals.len() / 4, &vals),
        T::PackedColorArray => v.packed_f(gd::PACKED_COLOR_ARRAY, vals.len() / 4, &vals),
    }
}

fn int_dict(v: &mut Vt, entries: &[(&str, i64)]) {
    v.dict(entries.len());
    for (k, x) in entries {
        v.key(k);
        v.int(*x);
    }
}

/// apply_state()'s return Dictionary, in its key order. `item_calls` and `param_calls` (test
/// instrumentation of rs_applier.gd) are empty here.
fn write_stats(
    v: &mut Vt,
    c: &Counters,
    rs_calls: i64,
    unsupported: &[UnsupportedCommand],
    uploads: &[Upload],
    mesh_uploads: &[MeshUpload],
    skipped: &[SkippedShader],
) {
    v.dict(18);
    v.key("created");
    v.int(c.created);
    v.key("freed");
    v.int(c.freed);
    v.key("reparented");
    v.int(c.reparented);
    v.key("commands_replayed");
    v.int(c.replayed);
    v.key("rs_calls");
    v.int(rs_calls);
    v.key("unsupported_commands");
    v.array(unsupported.len());
    for u in unsupported {
        v.dict(3);
        v.key("item");
        v.int(u.item as i64);
        v.key("name");
        v.str(&u.name);
        v.key("reason");
        v.str(u.reason);
    }
    v.key("resources");
    int_dict(
        v,
        &[
            ("created", c.tex_created),
            ("updated", c.tex_updated),
            ("replaced", c.tex_replaced),
            ("freed", c.tex_freed),
            ("upload_bytes", c.upload_bytes),
            ("skipped_commands", c.skipped),
        ],
    );
    v.key("uploads");
    v.array(uploads.len());
    for u in uploads {
        v.dict(if u.encoding.is_some() { 5 } else { 4 });
        v.key("id");
        v.int(u.id as i64);
        v.key("hash");
        v.opt_str(u.hash.map(|h| h.to_hex()).as_deref());
        v.key("op");
        v.str(u.op);
        v.key("data_bytes");
        v.int(u.data_bytes);
        if let Some(e) = u.encoding {
            v.key("encoding");
            v.str(e);
        }
    }
    v.key("item_calls");
    v.array(0);
    v.key("msdf_commands");
    v.int(c.msdf);
    v.key("geometry_commands");
    v.int(c.geometry);
    v.key("mesh_commands");
    v.int(c.mesh_commands);
    v.key("mesh_resources");
    int_dict(
        v,
        &[
            ("meshes_created", c.meshes_created),
            ("meshes_rebuilt", c.meshes_rebuilt),
            ("meshes_freed", c.meshes_freed),
            ("surface_updates", c.surface_updates),
            ("mesh_upload_bytes", c.mesh_upload_bytes),
            ("skipped_mesh_commands", c.skipped_mesh),
        ],
    );
    v.key("mesh_uploads");
    v.array(mesh_uploads.len());
    for u in mesh_uploads {
        v.dict(5);
        v.key("id");
        v.int(u.id as i64);
        v.key("op");
        v.str(u.op);
        v.key("surfaces");
        v.array(u.surfaces.len());
        for s in &u.surfaces {
            v.int(*s);
        }
        v.key("buffers");
        v.array(u.buffers.len());
        for b in &u.buffers {
            v.str(b);
        }
        v.key("bytes");
        v.int(u.bytes);
    }
    v.key("material_resources");
    int_dict(
        v,
        &[
            ("shaders_created", c.shaders_created),
            ("shader_code_sets", c.shader_code_sets),
            ("shaders_freed", c.shaders_freed),
            ("default_texture_sets", c.default_texture_sets),
            ("materials_created", c.materials_created),
            ("materials_freed", c.materials_freed),
            ("material_shader_sets", c.material_shader_sets),
            ("param_sets", c.param_sets),
            ("instance_param_sets", c.instance_param_sets),
            ("material_sets", c.material_sets),
            ("use_parent_material_sets", c.use_parent_material_sets),
            ("modulate_sets", c.modulate_sets),
        ],
    );
    v.key("skipped_shaders");
    v.array(skipped.len());
    for s in skipped {
        v.dict(4);
        v.key("id");
        v.int(s.id as i64);
        v.key("hash");
        v.str(&s.hash);
        v.key("reason");
        v.str(s.reason);
        v.key("detail");
        v.str(&s.detail);
    }
    v.key("param_calls");
    v.array(0);
    v.key("canvas_resources");
    int_dict(
        v,
        &[
            ("canvases_created", c.canvases_created),
            ("canvas_attach", c.canvas_attach),
            ("canvas_stacking_sets", c.canvas_stacking_sets),
            ("canvas_group_sets", c.canvas_group_sets),
            ("backbuffer_copy_sets", c.backbuffer_copy_sets),
        ],
    );
}
