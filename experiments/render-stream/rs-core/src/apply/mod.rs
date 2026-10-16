//! D7's applier: the resolved state to `gsw-canvas-draw-list`'s packed list, in O(changed) where
//! the change allows it (D29, Q14b).
//!
//! The walk is `RendererCanvasCull::_cull_canvas_item` (renderer_canvas_cull.cpp:293-482) without
//! y-sort, canvas groups, repeat and visibility notifiers (none reach the wire as supported):
//! canvases by `(layer, sublayer)`, children by `draw_index`, `draw_behind_parent` children before
//! their parent, per-z lists concatenated in z order, `modulate` composed down the tree with
//! `self_modulate` last, `visible`, the cull mask, the 0.007 alpha cut, and the clip as Godot's
//! integer scissor (`clip-derive.ts`'s rules: the rounded AABB of the transformed item rect
//! intersected with the clip owner's). An item is attached only when its global rect (custom rect, else
//! content rect) touches the viewport, borders included (`_attach_canvas_item_for_draw`; G7a: a custom
//! rect off screen hides on-screen content, gate 3's `cull` region).
//!
//! Three paths, chosen per transaction from what changed:
//! - nothing structural: item rows only (a transform or modulate change moves the subtree's rows),
//!   and an item whose re-lowered content keeps its shape overwrites its own vertex range;
//! - structural (order, visibility, z, clip, materials, textures, a content change of shape): the
//!   walk re-runs over the state and the index buffer and draw table are rebuilt; vertices stay in
//!   each item's slab range, so only changed items' vertices move.

pub mod geom;
pub mod lower;
pub mod material_residency;
pub mod meshes;
pub mod payloads;
pub mod programs;
pub mod residency;

use crate::state::{
    BlendMode, Canvas, EntryStatus, Filter, Hash, Id, Item, LightMode, Param, Repeat,
    ResolvedState, ShaderSource, TextureKind, TxDelta,
};
use geom::{Rect, Xform};
use gsw_canvas_draw_list::{
    Binding, Blend, Draw, DrawList, Format, Item as Row, Sampler, SamplerUniform, Target, Uniform,
    DRAW_SCISSOR, WHITE_TEXTURE,
};
use lower::{LDraw, Lowered, TexRef};
use payloads::{MeshGeometry, PayloadStore};
use programs::{ProgramEntry, ProgramInfo};
use std::collections::{BTreeMap, HashMap, HashSet};

/// The root viewport as the applier draws it.
#[derive(Clone, Copy, Debug)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    /// Straight RGBA (the session's `clear_color` block).
    pub clear: [f32; 4],
    /// Applied before every canvas transform (the stretch, identity when the presentation size
    /// equals the logical size).
    pub global_xform: Xform,
    /// `viewport.canvas_cull_mask`.
    pub cull_mask: u32,
    pub format: Format,
}

/// Receiver sabotages that live in the applier (gate7-design.md Q5 "Sabotages", G7a): each one exists
/// only to fail a check, and each is defined on the applied state so the native receiver's
/// predicted (shot, region) sets apply unchanged.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ApplySabotage {
    /// Native `ignore-clip`: every item draws unclipped.
    pub ignore_clip: bool,
    /// Native `clip-before-clear` (gate3-design.md G3b): an item's clip is set only when the wire
    /// value changes, and a content change of the item resets it to unclipped.
    pub clip_before_clear: bool,
    /// Native `reupload`: every named image is uploaded again at every transaction.
    pub reupload: bool,
    /// Native `stale-texture` (G6a): a resident RGBA8 image keeps its first payload.
    pub stale_texture: bool,
    /// Native `ignore-material`: no item gets its material (mix blend, shaded).
    pub ignore_material: bool,
    /// Native `ignore-canvas-modulate`: the root canvas's modulate is never applied.
    pub ignore_canvas_modulate: bool,
    /// Native `ignore-canvas-stacking`: canvases keep creation (id) order, layers ignored.
    pub ignore_canvas_stacking: bool,
    /// GSW-only `ignore-z`: each canvas draws in `draw_index` walk order, never per z.
    pub ignore_z: bool,
    /// Native `stale-param` (G55e): a material's parameters are the ones it had when it became
    /// resident (named by an item); later changes never reach its uniforms.
    pub stale_param: bool,
    /// GSW-only `blend-swap` (G7s): every effective `add` blend draws `sub` and every `sub` draws
    /// `add`.
    pub blend_swap: bool,
    /// The sabotages that act on the lowering (G7t: `drop-msdf`, `ignore-set-transform`,
    /// `ignore-clip-ignore`, `ignore-nine-patch-axis`, `polygon-winding`).
    pub lower: lower::LowerSabotage,
    /// The sabotages that act on mesh residency (G7t: native `drop-mesh-surface`, `stale-mesh`).
    pub mesh: meshes::MeshSabotage,
}

/// A shader the applier draws without its code this transaction, first time per (shader, hash):
/// `applied.json` `unsupported[]` `{seq, item: null, name: "shader_set_code", reason, shader}`.
#[derive(Clone, PartialEq, Debug)]
pub struct ShaderRefusal {
    pub shader: Id,
    pub hash: Hash,
    pub reason: &'static str,
    pub detail: Box<str>,
}

/// What one binding slot draws: the effective material, the canvas whose modulate it takes after
/// the program, the item when the program has instance uniforms, and the code's hash.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct BindingKey {
    pub material: Id,
    pub canvas: Id,
    pub item: Option<Id>,
    pub hash: Hash,
}

/// Applier-level typed shortcuts beyond the lowering's (G7x "Scope").
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
pub enum ApplyShortcut {
    /// A custom `ShaderMaterial` draws with the builtin program (`slice-shader-builtin`, G7s).
    ShaderBuiltin,
    /// An unsupported material, or one naming an unsupported shader: drawn with the default
    /// material.
    MaterialUnsupportedDefault,
    /// Sibling (or canvas) ties: drawn in wire append order (Godot's sort is unstable; the wire
    /// declares `draw-index-tie` / `canvas-stacking-tie`).
    TieAppendOrder,
    /// A draw whose texture had no resident pixels at assembly: not drawn.
    TextureNotResident,
}

impl ApplyShortcut {
    pub fn as_str(self) -> &'static str {
        match self {
            ApplyShortcut::ShaderBuiltin => "slice-shader-builtin",
            ApplyShortcut::MaterialUnsupportedDefault => "slice-material-unsupported-default",
            ApplyShortcut::TieAppendOrder => "slice-tie-append-order",
            ApplyShortcut::TextureNotResident => "texture-not-resident-skipped",
        }
    }
}

/// Why a transaction took the structural path (bits of [`ApplyStats::why`]).
pub struct Why;
impl Why {
    pub const FIRST: u32 = 1;
    pub const DEFAULTS: u32 = 1 << 1;
    pub const MATERIAL: u32 = 1 << 2;
    pub const TEXTURE_SIZE: u32 = 1 << 3;
    pub const ITEM_REMOVED: u32 = 1 << 4;
    pub const ITEM_ADDED: u32 = 1 << 5;
    pub const CONTENT_SHAPE: u32 = 1 << 6;
    pub const ORDER_KEY: u32 = 1 << 7;
    pub const DEPENDENCY: u32 = 1 << 8;
    pub const CANVAS: u32 = 1 << 9;
    pub const COMPACT: u32 = 1 << 10;
    pub const MOVE_FALLBACK: u32 = 1 << 11;
    pub const NAMES: [&'static str; 12] = [
        "first",
        "defaults",
        "material",
        "texture-size",
        "item-removed",
        "item-added",
        "content-shape",
        "order-key",
        "dependency",
        "canvas",
        "compact",
        "move-fallback",
    ];
}

/// Per-apply counters (one frame).
#[derive(Clone, Debug, Default)]
pub struct ApplyStats {
    pub structural: bool,
    /// Why the walk ran ([`Why`] bits; 0 when it did not).
    pub why: u32,
    /// The transaction re-assembled the index buffer and draw table without re-walking.
    pub reassembled: bool,
    /// Native diagnostics only (`rs-core-check apply-bench`): the walk's and the assembly's time.
    pub walk_us: f64,
    pub assemble_us: f64,
    pub relowered: u32,
    pub relowered_in_place: u32,
    pub rows_written: u32,
    pub attached_items: u32,
    /// Lowered draws of the attached items (what the frame should paint).
    pub lowered_draws: u32,
    /// Lowered draws not emitted because their texture was not resident (typed).
    pub assembly_skips: u32,
    /// Draws in the packed list.
    pub emitted_draws: u32,
    /// Draw calls an executor that merges adjacent equal-state draws issues.
    pub expected_calls: u32,
    pub texture_uploads: u32,
    pub texture_upload_bytes: u64,
    pub texture_frees: u32,
    /// Items plus non-root canvases this transaction created and freed (applied.json's
    /// `transactions[].created` / `freed`).
    pub created: u32,
    pub freed: u32,
    /// Non-root canvases created (`resources.canvases_created`).
    pub canvases_created: u32,
    /// Commands of the items whose content was (re)lowered (`commands_replayed`), and of those the
    /// MSDF and mesh ones (`msdf_commands`, `mesh_commands`).
    pub commands_replayed: u32,
    pub msdf_commands: u32,
    pub mesh_commands: u32,
    pub vertex_count: u32,
    pub index_count: u32,
    /// Item-space program bindings live after this transaction, and how many changed.
    pub bindings: u32,
    pub bindings_changed: u32,
}

#[derive(Clone, PartialEq, Debug)]
struct StructKey {
    parent: Option<crate::state::Parent>,
    children: Vec<Id>,
    visible: bool,
    draw_index: i64,
    z_index: i64,
    z_relative: bool,
    behind: bool,
    clip: bool,
    custom_rect: bool,
    custom_rect_rect: [f32; 4],
    visibility_layer: u32,
    texture_filter: Filter,
    texture_repeat: Repeat,
    material: Option<Id>,
    use_parent_material: bool,
}

impl StructKey {
    fn of(it: &Item) -> Self {
        StructKey {
            parent: it.parent,
            children: it.children.clone(),
            visible: it.visible,
            draw_index: it.draw_index,
            z_index: it.z_index,
            z_relative: it.z_relative,
            behind: it.behind,
            clip: it.clip,
            custom_rect: it.custom_rect,
            custom_rect_rect: it.custom_rect_rect,
            visibility_layer: it.visibility_layer,
            texture_filter: it.texture_filter,
            texture_repeat: it.texture_repeat,
            material: it.material,
            use_parent_material: it.use_parent_material,
        }
    }
}

type MaterialKey = (EntryStatus, Option<Id>);
/// A custom shader's hash decides its program (blend, light mode, binding), so code changes walk.
type ShaderKey = (EntryStatus, Option<crate::state::Builtin>, Option<Hash>);

/// The effective material of an item as the walk sees it (gate5_5-design.md D7, G7s).
#[derive(Clone, Copy, Debug)]
struct MaterialEff {
    blend: Blend,
    unshaded: bool,
    light_only: bool,
    /// A custom shader drawn as an item-space program: (material, code hash).
    program: Option<(Id, Hash)>,
}

const NO_MATERIAL: MaterialEff = MaterialEff {
    blend: Blend::Mix,
    unshaded: false,
    light_only: false,
    program: None,
};

/// The texture sizes a lowering read (id, drawable size and mipmaps).
type TexSizes = Vec<(Id, Option<(u32, u32, bool)>)>;

struct ItemRec {
    row: u32,
    content_version: i64,
    lowered: Lowered,
    vstart: u32,
    vcap: u32,
    key: StructKey,
    xform: [f32; 6],
    modulate: [f32; 4],
    self_modulate: [f32; 4],
    /// Texture sizes and mesh versions the lowering used.
    tex_sizes: TexSizes,
    mesh_versions: Vec<(Id, i64)>,
    // The last walk's results.
    visited: bool,
    final_xform: Xform,
    /// The modulate handed to children (`modulate * parent's`).
    child_modulate: [f32; 4],
    /// The canvas modulate this item's row multiplies in (white for unshaded materials).
    canvas_modulate: [f32; 4],
    /// The canvas the item was walked under, and whether its material is unshaded.
    canvas: Id,
    unshaded: bool,
    /// Drawn with an item-space program: the canvas modulate is the binding's, not the row's.
    program_bound: bool,
    /// `clip-before-clear` sabotage: the clip the native receiver last sent, and the one in effect.
    clip_shadow: bool,
    clip_eff: bool,
    /// The last walk's scissor for this item (its own or its clip owner's), rounded.
    scissor: Option<Rect>,
    /// The last walk found its global rect touching the viewport (attached when it draws).
    on_screen: bool,
}

#[derive(Clone, Copy, Debug)]
struct Attach {
    item: Id,
    z: i32,
    scissor: Option<[i32; 4]>,
    blend: Blend,
    /// `Draw::program`: 0, or a binding slot + 1.
    program: u32,
}

/// The applier: owns the packed list it fills.
pub struct Applier {
    pub list: DrawList,
    viewport: Viewport,
    items: HashMap<Id, ItemRec>,
    free_rows: Vec<u32>,
    /// Resident textures, native semantics (`residency`); the GPU holds the `ok` images.
    resident: HashMap<Id, residency::Resident>,
    names: residency::Names,
    /// The texture ids `prepare` chose for this transaction.
    pending: std::collections::BTreeSet<Id>,
    prepared: bool,
    /// This transaction's texture accounting.
    pub account: residency::TextureAccount,
    pub sabotage: ApplySabotage,
    attach: Vec<Attach>,
    vertex_holes: u32,
    /// The canvas, material, shader and canvas-texture entries the last walk used: a full
    /// transaction re-lists every entry, so changes are found by comparison, not by presence.
    canvases: HashMap<Id, Canvas>,
    /// Only what the walk reads (status and shader; status and builtin): a parameter or code
    /// change re-walks nothing (G7a: hd-patch animates a material parameter every frame).
    materials: HashMap<Id, MaterialKey>,
    shaders: HashMap<Id, ShaderKey>,
    canvas_textures: HashMap<Id, crate::state::Texture>,
    pub shortcut_totals: BTreeMap<&'static str, u64>,
    pub stats: ApplyStats,
    first: bool,
    /// G7s: the adapter's program (or refusal) per custom shader code hash.
    programs: HashMap<Hash, ProgramEntry>,
    programs_dirty: bool,
    /// Live binding slots by key, each slot's key, and the free slots.
    binding_slots: HashMap<BindingKey, u32>,
    binding_keys: Vec<Option<BindingKey>>,
    free_slots: Vec<u32>,
    /// Keys the last walk attached (the rest are released after it).
    walk_keys: HashSet<BindingKey>,
    /// This transaction's new shader refusals (the adapter drains them into `unsupported[]`).
    pub shader_refusals: Vec<ShaderRefusal>,
    refusals_reported: HashSet<(Id, Hash)>,
    /// `stale-param`: each resident material's parameters as they were when it became resident.
    stale_params: HashMap<Id, Vec<Param>>,
    /// Binding slots whose values changed in this transaction (`shader-param-parity` evidence).
    pub bindings_changed: Vec<u32>,
    /// The native receiver's shader/material residency, for applied.json's /5 counters.
    material_residency: material_residency::MaterialResidency,
    pub material_counts: material_residency::MaterialCounts,
    /// Mesh residency (G7t), and this transaction's `mesh_uploads` rows in `meshes.uploads`.
    pub meshes: meshes::MeshResidency,
}

/// The texture and mesh tables as the lowering sees them.
struct TableView<'a> {
    state: &'a ResolvedState,
    payloads: &'a PayloadStore,
    meshes: &'a meshes::MeshResidency,
}

impl TableView<'_> {
    /// An `ok` image with pixels, or an `ok` placeholder: how it draws.
    fn drawable(&self, t: &crate::state::Texture) -> lower::TexDraw {
        use lower::TexDraw;
        match (t.status, t.kind) {
            (EntryStatus::Freed, _) => TexDraw::White,
            (EntryStatus::Unsupported, _) => TexDraw::Skip,
            (EntryStatus::Ok, TextureKind::Placeholder) => TexDraw::Sized(4, 4, false),
            (EntryStatus::Ok, TextureKind::Image) => match t.hash {
                Some(h) if self.payloads.textures.contains_key(&h) => {
                    TexDraw::Sized(t.width as u32, t.height as u32, t.mipmaps)
                }
                _ => TexDraw::Skip,
            },
            (EntryStatus::Ok, TextureKind::Canvas) => TexDraw::Skip,
        }
    }
}

impl lower::Tables for TableView<'_> {
    fn texture_draw(&self, id: Id) -> lower::TexDraw {
        use lower::TexDraw;
        let Some(t) = self.state.textures.get(&id) else {
            return TexDraw::Skip;
        };
        if t.kind == TextureKind::Canvas && t.status == EntryStatus::Ok {
            // A canvas texture draws its diffuse; RID() (unset, freed, not drawable) is white.
            return match t
                .canvas
                .as_ref()
                .and_then(|c| c.diffuse)
                .and_then(|d| self.state.textures.get(&d))
            {
                Some(d) if d.kind != TextureKind::Canvas => match self.drawable(d) {
                    TexDraw::Skip => TexDraw::White,
                    other => other,
                },
                _ => TexDraw::White,
            };
        }
        self.drawable(t)
    }
    fn mesh(&self, id: Id) -> Option<(Vec<&MeshGeometry>, Rect)> {
        let m = self.state.meshes.get(&id)?;
        if m.status != EntryStatus::Ok {
            return None;
        }
        // The resident surfaces (G7t: native residency, so the mesh sabotages act on pixels).
        let (surfaces, custom) = self.meshes.drawn(id, self.payloads)?;
        let mut aabb: Option<[f32; 6]> = None;
        for g in &surfaces {
            // MeshStorage::mesh_get_aabb: the surfaces' AABBs merged (AABB::merge).
            aabb = Some(match aabb {
                None => g.aabb,
                Some(a) => {
                    let lo = [
                        a[0].min(g.aabb[0]),
                        a[1].min(g.aabb[1]),
                        a[2].min(g.aabb[2]),
                    ];
                    let hi = [
                        (a[0] + a[3]).max(g.aabb[0] + g.aabb[3]),
                        (a[1] + a[4]).max(g.aabb[1] + g.aabb[4]),
                        (a[2] + a[5]).max(g.aabb[2] + g.aabb[5]),
                    ];
                    [
                        lo[0],
                        lo[1],
                        lo[2],
                        hi[0] - lo[0],
                        hi[1] - lo[1],
                        hi[2] - lo[2],
                    ]
                }
            });
        }
        let c = custom;
        let rect = if c.iter().any(|v| *v != 0.0) {
            [c[0], c[1], c[3], c[4]]
        } else {
            let a = aabb.unwrap_or([0.0; 6]);
            [a[0], a[1], a[3], a[4]]
        };
        Some((surfaces, rect))
    }
}

/// A canvas's modulate (white under the `ignore-canvas-modulate` sabotage for the root canvas,
/// which is the only canvas the native receiver's `canvas_set_modulate` skip touches).
fn canvas_modulate(state: &ResolvedState, canvas: Id, ignore_root: bool) -> [f32; 4] {
    match state.canvases.get(&canvas) {
        Some(c) if c.root && ignore_root => WHITE,
        Some(c) => c.modulate,
        None => WHITE,
    }
}

fn mul4(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]]
}

const WHITE: [f32; 4] = [1.0; 4];
const Z_MIN: i64 = -4096;
const Z_MAX: i64 = 4096;

fn sampler_bits(filter: Filter, repeat: Repeat, force_repeat: bool) -> u32 {
    let linear = matches!(
        filter,
        Filter::Linear | Filter::LinearMipmaps | Filter::LinearMipmapsAnisotropic
    );
    let wrap = if force_repeat {
        Sampler::REPEAT
    } else {
        match repeat {
            Repeat::Enabled => Sampler::REPEAT,
            Repeat::Mirror => Sampler::MIRROR,
            _ => Sampler::CLAMP,
        }
    };
    (if linear { Sampler::LINEAR } else { 0 }) | wrap
}

impl Applier {
    pub fn new(viewport: Viewport) -> Self {
        let target = Target {
            width: viewport.width,
            height: viewport.height,
            format: viewport.format,
            clear: viewport.clear,
            // The root viewport is Godot's non-transparent render target (D7; G7s: blends keep
            // its alpha, mul and disabled draw straight colour, rasterizer_canvas_gles3.cpp:742-798).
            opaque: true,
        };
        Applier {
            list: DrawList::new(target),
            viewport,
            items: HashMap::new(),
            free_rows: Vec::new(),
            resident: HashMap::new(),
            names: residency::Names::default(),
            pending: Default::default(),
            prepared: false,
            account: Default::default(),
            sabotage: ApplySabotage::default(),
            attach: Vec::new(),
            vertex_holes: 0,
            canvases: HashMap::new(),
            materials: HashMap::new(),
            shaders: HashMap::new(),
            canvas_textures: HashMap::new(),
            shortcut_totals: BTreeMap::new(),
            stats: ApplyStats::default(),
            first: true,
            programs: HashMap::new(),
            programs_dirty: false,
            binding_slots: HashMap::new(),
            binding_keys: Vec::new(),
            free_slots: Vec::new(),
            walk_keys: HashSet::new(),
            shader_refusals: Vec::new(),
            refusals_reported: HashSet::new(),
            stale_params: HashMap::new(),
            bindings_changed: Vec::new(),
            material_residency: Default::default(),
            material_counts: Default::default(),
            meshes: meshes::MeshResidency::default(),
        }
    }

    /// G7s: register what draws custom shader code `hash` (its item-space program, or a typed
    /// refusal). Takes effect at the next `apply`.
    pub fn set_program(&mut self, hash: Hash, entry: ProgramEntry) {
        if self.programs.get(&hash) != Some(&entry) {
            self.programs.insert(hash, entry);
            self.programs_dirty = true;
        }
    }

    pub fn program_entry(&self, hash: &Hash) -> Option<&ProgramEntry> {
        self.programs.get(hash)
    }

    /// The custom shaders the named materials name that have no program entry yet: (shader id,
    /// code hash, source), ascending by id (`_named_shader_ids`). Call after [`Applier::prepare`];
    /// the adapter transpiles each (payload code from the store, `withheld` code from its
    /// library) and calls [`Applier::set_program`] before `apply`.
    pub fn pending_shaders(&self, state: &ResolvedState) -> Vec<(Id, Hash, ShaderSource)> {
        let mut out = Vec::new();
        for sid in self.names.named_shaders(state) {
            let Some(s) = state.shaders.get(&sid) else {
                continue;
            };
            if s.builtin.is_some() {
                continue;
            }
            let (Some(hash), Some(source)) = (s.hash, s.source) else {
                continue;
            };
            if !self.programs.contains_key(&hash) {
                out.push((sid, hash, source));
            }
        }
        out
    }

    /// The key binding slot `slot` draws (None: free).
    pub fn binding_key(&self, slot: u32) -> Option<BindingKey> {
        self.binding_keys.get(slot as usize).copied().flatten()
    }

    pub fn viewport(&self) -> &Viewport {
        &self.viewport
    }

    /// The last walk's paint order (diagnostics and the `ordering-model` test): each attached
    /// item with its final transform and composed modulate, in draw order.
    pub fn paint_order(&self) -> Vec<(Id, Xform, [f32; 4])> {
        self.attach
            .iter()
            .filter_map(|a| {
                let rec = self.items.get(&a.item)?;
                let row = self.list.items.get(rec.row as usize)?;
                Some((a.item, row.xform, row.modulate))
            })
            .collect()
    }

    /// Every item's current lowering (G7t's `lowering-parity`: the vertex arrays compared with
    /// make_expected.py's hand lowering), by id.
    pub fn lowered_items(&self) -> Vec<(Id, &Lowered)> {
        let mut out: Vec<(Id, &Lowered)> =
            self.items.iter().map(|(id, r)| (*id, &r.lowered)).collect();
        out.sort_by_key(|(id, _)| *id);
        out
    }

    /// Each visited item's scissor (`clip-parity`): `Some(rect)` as `[x0, y0, x1, y1)` when it or
    /// an ancestor clips, `None` when nothing clips it; unvisited items are absent.
    pub fn scissors(&self) -> Vec<(Id, Option<[i32; 4]>)> {
        let mut out: Vec<(Id, Option<[i32; 4]>)> = self
            .items
            .iter()
            .filter(|(_, r)| r.visited)
            .map(|(id, r)| {
                (
                    *id,
                    r.scissor.map(|c| {
                        [
                            c[0] as i32,
                            c[1] as i32,
                            (c[0] + c[2]) as i32,
                            (c[1] + c[3]) as i32,
                        ]
                    }),
                )
            })
            .collect();
        out.sort_by_key(|(id, _)| *id);
        out
    }

    /// After a lost and restored context: re-send every array and every resident texture.
    /// G7l: the objects this applier retains, `[items, non-root canvases, resident textures,
    /// resident meshes, resident shaders, resident materials]` (the GSW receiver's analogue of
    /// the RIDs a native applier owns, for a reconnect's dispose evidence).
    pub fn retained(&self) -> [usize; 6] {
        let (shaders, materials) = self.material_residency.resident_counts();
        [
            self.items.len(),
            self.canvases.values().filter(|c| !c.root).count(),
            self.resident.len(),
            self.meshes.resident_count(),
            shaders,
            materials,
        ]
    }

    pub fn context_restored(&mut self, payloads: &PayloadStore) {
        self.list.dirty.all = true;
        self.list.dirty.draws = true;
        for (id, r) in &self.resident {
            if r.kind == TextureKind::Placeholder {
                self.list
                    .upload_texture(*id, 4, 4, &residency::placeholder_checker());
            }
        }
        let ids: Vec<(Id, crate::state::Hash)> = self
            .resident
            .iter()
            .filter_map(|(id, r)| r.hash.map(|h| (*id, h)))
            .collect();
        for (id, hash) in ids {
            if let Some(px) = payloads.textures.get(&hash) {
                self.list.upload_texture(id, px.width, px.height, &px.rgba);
            }
        }
    }

    fn count_commands(&mut self, it: &Item) {
        self.stats.commands_replayed += it.commands.list.len() as u32;
        for c in &it.commands.list {
            match c {
                crate::state::Command::MsdfTextureRectRegion { .. } => {
                    self.stats.msdf_commands += 1
                }
                crate::state::Command::Mesh { .. } => self.stats.mesh_commands += 1,
                _ => {}
            }
        }
    }

    fn note(&mut self, s: &'static str, n: u64) {
        *self.shortcut_totals.entry(s).or_insert(0) += n;
    }

    fn alloc_row(&mut self) -> u32 {
        if let Some(r) = self.free_rows.pop() {
            r
        } else {
            self.list.items.push(Row::default());
            self.list.items.len() as u32 - 1
        }
    }

    /// Writes `lowered`'s vertices for `id` into its slab range (in place when it fits), returning
    /// whether the range moved.
    fn place_vertices(list: &mut DrawList, rec: &mut ItemRec, holes: &mut u32) -> bool {
        let n = rec.lowered.verts.len() as u32;
        let moved = n > rec.vcap;
        if moved {
            *holes += rec.vcap;
            rec.vstart = list.vertices.len() as u32;
            rec.vcap = n;
            list.vertices.extend_from_slice(&rec.lowered.verts);
        } else {
            let start = rec.vstart as usize;
            list.vertices[start..start + n as usize].copy_from_slice(&rec.lowered.verts);
        }
        let row = rec.row;
        for v in &mut list.vertices[rec.vstart as usize..(rec.vstart + n) as usize] {
            v.item = row;
        }
        if n > 0 {
            list.dirty.vertices.add(rec.vstart, rec.vstart + n);
        }
        moved
    }

    /// Re-pack every item's vertices contiguously (when the slab's holes outgrow its use).
    fn compact(&mut self) {
        let mut verts = Vec::with_capacity(self.list.vertices.len() - self.vertex_holes as usize);
        let mut ids: Vec<Id> = self.items.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            let rec = self.items.get_mut(&id).unwrap();
            let n = rec.lowered.verts.len();
            let start = rec.vstart as usize;
            let new_start = verts.len() as u32;
            verts.extend_from_slice(&self.list.vertices[start..start + n]);
            rec.vstart = new_start;
            rec.vcap = n as u32;
        }
        self.list.vertices = verts;
        self.vertex_holes = 0;
        self.list.dirty.all = true;
    }

    fn lower_item(
        &mut self,
        it: &Item,
        tables: &TableView<'_>,
    ) -> (Lowered, TexSizes, Vec<(Id, i64)>) {
        let lowered = lower::lower_with(&it.commands, tables, self.sabotage.lower);
        for (s, n) in &lowered.shortcuts {
            *self.shortcut_totals.entry(s.as_str()).or_insert(0) += u64::from(*n);
        }
        let tex_sizes = lowered
            .texture_deps
            .iter()
            .map(|id| (*id, lower::Tables::texture_size(tables, *id)))
            .collect();
        let mesh_versions = lowered
            .mesh_deps
            .iter()
            .map(|id| {
                (
                    *id,
                    tables.state.meshes.get(id).map(|m| m.version).unwrap_or(-1),
                )
            })
            .collect();
        (lowered, tex_sizes, mesh_versions)
    }

    /// Step 2's half of the applier (Q14c): update the named textures from the accepted
    /// transaction and choose which textures this transaction looks at. Must run once between
    /// `accept` and `apply` (`apply` runs it itself when the adapter did not).
    pub fn prepare(&mut self, state: &ResolvedState, delta: &TxDelta) {
        self.names.update(state, delta, self.first);
        self.pending = residency::candidates(
            &mut self.names,
            state,
            delta,
            self.first,
            self.sabotage.reupload,
        );
        self.prepared = true;
    }

    /// The payload hashes this transaction needs that `store` does not hold, in the native
    /// receiver's order (shaders of named materials, meshes, then named textures by id): Q14c's
    /// needed set. Call after [`Applier::prepare`].
    pub fn needed(
        &self,
        state: &ResolvedState,
        delta: &TxDelta,
        store: &PayloadStore,
        out: &mut Vec<crate::state::Hash>,
    ) {
        out.clear();
        let push = |h: crate::state::Hash, out: &mut Vec<crate::state::Hash>| {
            if !store.has(&h) && !out.contains(&h) {
                out.push(h);
            }
        };
        for sid in self.names.named_payload_shaders(state) {
            if let Some(h) = state.shaders.get(&sid).and_then(|s| s.hash) {
                push(h, out);
            }
        }
        let meshes: Vec<Id> = if self.first {
            state.meshes.keys().copied().collect()
        } else {
            delta.meshes_upserted.clone()
        };
        for id in meshes {
            if let Some(m) = state.meshes.get(&id) {
                if m.status == EntryStatus::Ok {
                    for s in &m.surfaces {
                        push(s.hash, out);
                    }
                }
            }
        }
        for id in &self.pending {
            if let Some(t) = state.textures.get(id) {
                if t.kind == TextureKind::Image && t.status == EntryStatus::Ok {
                    if let Some(h) = t.hash {
                        push(h, out);
                    }
                }
            }
        }
    }

    /// Bring residency in line with the texture table, the native receiver's way (`residency`):
    /// free what left the table or became a tombstone, then create, update or replace each chosen
    /// named texture. Returns the ids whose drawable size changed.
    fn sync_textures(
        &mut self,
        state: &ResolvedState,
        delta: &TxDelta,
        payloads: &PayloadStore,
    ) -> Vec<Id> {
        use residency::{Resident, Upload};
        let mut resized = Vec::new();
        // Frees first, ascending (`rs_applier.gd` walks the resident ids sorted).
        let mut gone: Vec<Id> = if self.first {
            self.resident.keys().copied().collect()
        } else {
            delta
                .textures_removed
                .iter()
                .chain(delta.textures_upserted.iter())
                .copied()
                .collect()
        };
        gone.sort_unstable();
        gone.dedup();
        for id in gone {
            let is_gone = state
                .textures
                .get(&id)
                .is_none_or(|t| t.status == EntryStatus::Freed);
            if !is_gone {
                continue;
            }
            if let Some(r) = self.resident.remove(&id) {
                if matches!(r.kind, TextureKind::Image | TextureKind::Placeholder) {
                    self.list.free_texture(id);
                    self.stats.texture_frees += 1;
                }
                self.account.freed += 1;
                resized.push(id);
            }
        }
        let pending = std::mem::take(&mut self.pending);
        for &id in &pending {
            let Some(t) = state.textures.get(&id) else {
                continue;
            };
            if t.status != EntryStatus::Ok {
                continue;
            }
            match t.kind {
                TextureKind::Placeholder => {
                    if self
                        .resident
                        .get(&id)
                        .is_some_and(|r| r.kind == TextureKind::Placeholder)
                    {
                        continue;
                    }
                    let placeholder = Resident {
                        kind: TextureKind::Placeholder,
                        hash: None,
                        format: String::new(),
                        width: 0,
                        height: 0,
                        mipmaps: false,
                    };
                    match self.resident.insert(id, placeholder) {
                        Some(_) => self.account.replaced += 1,
                        None => self.account.created += 1,
                    }
                    self.list
                        .upload_texture(id, 4, 4, &residency::placeholder_checker());
                    self.stats.texture_uploads += 1;
                    self.stats.texture_upload_bytes += 64;
                    resized.push(id);
                    self.account.uploads.push(Upload {
                        id,
                        hash: None,
                        op: "placeholder",
                        data_bytes: 0,
                    });
                }
                TextureKind::Canvas => {
                    if self.resident.contains_key(&id) {
                        continue;
                    }
                    self.resident.insert(
                        id,
                        Resident {
                            kind: TextureKind::Canvas,
                            hash: None,
                            format: String::new(),
                            width: 0,
                            height: 0,
                            mipmaps: false,
                        },
                    );
                    self.account.created += 1;
                    self.account.uploads.push(Upload {
                        id,
                        hash: None,
                        op: "canvas",
                        data_bytes: 0,
                    });
                }
                TextureKind::Image => {
                    let Some(hash) = t.hash else {
                        continue;
                    };
                    let old = self.resident.get(&id).cloned();
                    let same = old
                        .as_ref()
                        .is_some_and(|r| r.kind == TextureKind::Image && r.hash == Some(hash));
                    if same && !self.sabotage.reupload {
                        continue;
                    }
                    if self.sabotage.stale_texture
                        && old
                            .as_ref()
                            .is_some_and(|r| r.kind == TextureKind::Image && r.format == "RGBA8")
                    {
                        continue;
                    }
                    let Some(px) = payloads.textures.get(&hash) else {
                        continue;
                    };
                    let op = match &old {
                        None => {
                            self.account.created += 1;
                            "create"
                        }
                        Some(r)
                            if r.kind == TextureKind::Image
                                && r.format == px.format
                                && r.width == px.width
                                && r.height == px.height
                                && r.mipmaps == px.mipmaps =>
                        {
                            self.account.updated += 1;
                            "update"
                        }
                        Some(_) => {
                            self.account.replaced += 1;
                            "replace"
                        }
                    };
                    if old.as_ref().map(|o| (o.kind, o.width, o.height))
                        != Some((TextureKind::Image, px.width, px.height))
                    {
                        resized.push(id);
                    }
                    self.resident.insert(
                        id,
                        Resident {
                            kind: TextureKind::Image,
                            hash: Some(hash),
                            format: px.format.clone(),
                            width: px.width,
                            height: px.height,
                            mipmaps: px.mipmaps,
                        },
                    );
                    self.list.upload_texture(id, px.width, px.height, &px.rgba);
                    self.stats.texture_uploads += 1;
                    self.stats.texture_upload_bytes += px.rgba.len() as u64;
                    self.account.upload_bytes += px.data_len as u64;
                    self.account.uploads.push(Upload {
                        id,
                        hash: Some(hash),
                        op,
                        data_bytes: px.data_len as u64,
                    });
                }
            }
        }
        self.pending = pending;
        resized
    }

    /// Apply the last accepted transaction (`state`, `delta`) to the packed list. `payloads` must
    /// hold every hash the state needs (the adapter blocks `apply` until `needed` is empty).
    pub fn apply(
        &mut self,
        state: &ResolvedState,
        delta: &TxDelta,
        payloads: &PayloadStore,
    ) -> &ApplyStats {
        self.stats = ApplyStats::default();
        self.account = Default::default();
        self.shader_refusals.clear();
        self.bindings_changed.clear();
        if !self.prepared {
            self.prepare(state, delta);
        }
        self.prepared = false;
        // Mesh residency first (the lowering draws the resident surfaces): the native receiver
        // applies meshes before it replays commands (`rs_applier.gd` step 3b).
        let mut mesh_res = std::mem::take(&mut self.meshes);
        mesh_res.sabotage = self.sabotage.mesh;
        {
            let items: Vec<Id> = if self.first {
                state.items.keys().copied().collect()
            } else {
                delta.items_upserted.clone()
            };
            mesh_res.sync(state, &items, &delta.items_removed, self.first, payloads);
        }
        let tables = TableView {
            state,
            payloads,
            meshes: &mesh_res,
        };
        let mut why = if self.first { Why::FIRST } else { 0 };
        if delta.defaults_changed {
            why |= Why::DEFAULTS;
        }
        // Materials, shaders and canvas textures decide blends and samplers: a real change re-walks.
        for id in &delta.materials_removed {
            if self.materials.remove(id).is_some() {
                why |= Why::MATERIAL;
            }
        }
        for id in &delta.shaders_removed {
            if self.shaders.remove(id).is_some() {
                why |= Why::MATERIAL;
            }
        }
        for id in &delta.textures_removed {
            if self.canvas_textures.remove(id).is_some() {
                why |= Why::MATERIAL;
            }
        }
        let mats: Vec<Id> = if self.first {
            state.materials.keys().copied().collect()
        } else {
            delta.materials_upserted.clone()
        };
        for id in mats {
            if let Some(m) = state.materials.get(&id) {
                let key = (m.status, m.shader);
                if self.materials.get(&id) != Some(&key) {
                    self.materials.insert(id, key);
                    why |= Why::MATERIAL;
                }
            }
        }
        let shs: Vec<Id> = if self.first {
            state.shaders.keys().copied().collect()
        } else {
            delta.shaders_upserted.clone()
        };
        for id in shs {
            if let Some(sh) = state.shaders.get(&id) {
                let key = (sh.status, sh.builtin.clone(), sh.hash);
                if self.shaders.get(&id) != Some(&key) {
                    self.shaders.insert(id, key);
                    why |= Why::MATERIAL;
                }
            }
        }
        let texs: Vec<Id> = if self.first {
            state.textures.keys().copied().collect()
        } else {
            delta.textures_upserted.clone()
        };
        for id in texs {
            if let Some(t) = state.textures.get(&id) {
                if t.kind == TextureKind::Canvas && self.canvas_textures.get(&id) != Some(t) {
                    self.canvas_textures.insert(id, t.clone());
                    why |= Why::MATERIAL;
                }
            }
        }
        let resized = self.sync_textures(state, delta, payloads);
        if !resized.is_empty() {
            why |= Why::TEXTURE_SIZE;
        }
        // G7s: a program registered or replaced decides blends, light modes and bindings.
        if std::mem::take(&mut self.programs_dirty) {
            why |= Why::MATERIAL;
        }
        self.note_shader_refusals(state);
        {
            let named_materials = self.names.named_materials(state);
            let named_shaders = self.names.named_shaders(state);
            let programs = &self.programs;
            self.material_counts = self.material_residency.apply(
                state,
                delta,
                self.first,
                &named_materials,
                &named_shaders,
                |_, hash| {
                    matches!(
                        programs.get(&hash),
                        Some(ProgramEntry::Refused {
                            reason: "shader-withheld",
                            ..
                        })
                    )
                },
                self.sabotage.stale_param,
            );
        }
        if self.sabotage.stale_param {
            let named = self.names.named_materials(state);
            self.stale_params.retain(|mid, _| named.contains(mid));
            for mid in named {
                if let Some(m) = state.materials.get(&mid) {
                    self.stale_params
                        .entry(mid)
                        .or_insert_with(|| m.params.clone());
                }
            }
        }

        // Removed items.
        for id in &delta.items_removed {
            if let Some(rec) = self.items.remove(id) {
                self.free_rows.push(rec.row);
                self.vertex_holes += rec.vcap;
                self.stats.freed += 1;
                why |= Why::ITEM_REMOVED;
            }
        }
        if self.first {
            // A fresh applier adopts whatever the state holds.
            let stale: Vec<Id> = self
                .items
                .keys()
                .filter(|id| !state.items.contains_key(id))
                .copied()
                .collect();
            for id in stale {
                let rec = self.items.remove(&id).unwrap();
                self.free_rows.push(rec.row);
            }
        }

        // Upserted items: classify.
        let upserted: Vec<Id> = if self.first {
            state.items.keys().copied().collect()
        } else {
            delta.items_upserted.clone()
        };
        let mut moved: Vec<Id> = Vec::new();
        let mut content_walk = false;
        for id in upserted {
            let Some(it) = state.items.get(&id) else {
                continue;
            };
            let key = StructKey::of(it);
            match self.items.contains_key(&id) {
                false => {
                    let (lowered, tex_sizes, mesh_versions) = self.lower_item(it, &tables);
                    self.stats.relowered += 1;
                    let row = self.alloc_row();
                    let mut rec = ItemRec {
                        row,
                        content_version: it.content_version,
                        lowered,
                        vstart: 0,
                        vcap: 0,
                        key,
                        xform: it.xform,
                        modulate: it.modulate,
                        self_modulate: it.self_modulate,
                        tex_sizes,
                        mesh_versions,
                        visited: false,
                        final_xform: geom::IDENTITY,
                        child_modulate: WHITE,
                        canvas_modulate: WHITE,
                        canvas: 0,
                        unshaded: false,
                        program_bound: false,
                        clip_shadow: it.clip,
                        clip_eff: it.clip,
                        scissor: None,
                        on_screen: false,
                    };
                    Self::place_vertices(&mut self.list, &mut rec, &mut self.vertex_holes);
                    self.items.insert(id, rec);
                    self.stats.created += 1;
                    self.count_commands(it);
                    why |= Why::ITEM_ADDED;
                }
                true => {
                    let content_changed = self.items[&id].content_version != it.content_version;
                    {
                        // clip-before-clear's model (fixtures/gate3/make_expected.py
                        // `receiver_clip`): a wire change sets the clip, a content change clears it.
                        let rec = self.items.get_mut(&id).unwrap();
                        let before = rec.clip_eff;
                        if it.clip != rec.clip_shadow {
                            rec.clip_shadow = it.clip;
                            rec.clip_eff = it.clip;
                        }
                        if content_changed {
                            rec.clip_eff = false;
                        }
                        if self.sabotage.clip_before_clear && rec.clip_eff != before {
                            why |= Why::ORDER_KEY;
                        }
                    }
                    if content_changed {
                        self.count_commands(it);
                        let (lowered, tex_sizes, mesh_versions) = self.lower_item(it, &tables);
                        self.stats.relowered += 1;
                        let rec = self.items.get_mut(&id).unwrap();
                        let same =
                            lowered.same_shape(&rec.lowered) && lowered.rect == rec.lowered.rect;
                        // The walk reads an item's content only for its clip rect (a clipping
                        // item without a custom rect) and whether it draws at all; any other
                        // change of shape needs only the index buffer and draw table re-assembled.
                        if (it.clip && !it.custom_rect && lowered.rect != rec.lowered.rect)
                            || lowered.draws.is_empty() != rec.lowered.draws.is_empty()
                        {
                            content_walk = true;
                        }
                        rec.lowered = lowered;
                        rec.tex_sizes = tex_sizes;
                        rec.mesh_versions = mesh_versions;
                        rec.content_version = it.content_version;
                        let moved_range =
                            Self::place_vertices(&mut self.list, rec, &mut self.vertex_holes);
                        if same && !moved_range {
                            self.stats.relowered_in_place += 1;
                        } else {
                            why |= Why::CONTENT_SHAPE;
                        }
                    }
                    let rec = self.items.get_mut(&id).unwrap();
                    if rec.key != key {
                        rec.key = key;
                        why |= Why::ORDER_KEY;
                    }
                    if rec.xform != it.xform
                        || rec.modulate != it.modulate
                        || rec.self_modulate != it.self_modulate
                    {
                        rec.xform = it.xform;
                        rec.modulate = it.modulate;
                        rec.self_modulate = it.self_modulate;
                        moved.push(id);
                    }
                }
            }
        }

        // Dependencies: texture sizes and mesh versions an existing lowering used, and the meshes
        // whose resident geometry changed.
        let dep_mesh_changed = !delta.meshes_upserted.is_empty()
            || !delta.meshes_removed.is_empty()
            || !mesh_res.changed.is_empty();
        if !resized.is_empty() || dep_mesh_changed {
            let stale: Vec<Id> = self
                .items
                .iter()
                .filter(|(_, rec)| {
                    rec.tex_sizes.iter().any(|(t, s)| {
                        resized.contains(t) || lower::Tables::texture_size(&tables, *t) != *s
                    }) || rec.mesh_versions.iter().any(|(m, v)| {
                        state.meshes.get(m).map(|e| e.version).unwrap_or(-1) != *v
                            || mesh_res.changed.contains(m)
                    })
                })
                .map(|(id, _)| *id)
                .collect();
            for id in stale {
                let Some(it) = state.items.get(&id) else {
                    continue;
                };
                let (lowered, tex_sizes, mesh_versions) = self.lower_item(it, &tables);
                self.stats.relowered += 1;
                let rec = self.items.get_mut(&id).unwrap();
                rec.lowered = lowered;
                rec.tex_sizes = tex_sizes;
                rec.mesh_versions = mesh_versions;
                Self::place_vertices(&mut self.list, rec, &mut self.vertex_holes);
                why |= Why::DEPENDENCY;
            }
        }

        // Canvases: order facts re-walk; a transform or modulate change moves the canvas's rows.
        let mut moved_canvases: Vec<Id> = Vec::new();
        for id in &delta.canvases_removed {
            if self.canvases.remove(id).is_some() {
                self.stats.freed += 1;
                why |= Why::CANVAS;
            }
        }
        let cans: Vec<Id> = if self.first {
            state.canvases.keys().copied().collect()
        } else {
            delta.canvases_upserted.clone()
        };
        for id in cans {
            let Some(c) = state.canvases.get(&id) else {
                continue;
            };
            match self.canvases.get(&id) {
                Some(old) if old == c => {}
                Some(old)
                    if old.attached == c.attached
                        && old.layer == c.layer
                        && old.sublayer == c.sublayer
                        && old.items == c.items
                        && old.root == c.root =>
                {
                    moved_canvases.push(id);
                    self.canvases.insert(id, c.clone());
                }
                _ => {
                    if self.canvases.insert(id, c.clone()).is_none() && !c.root {
                        self.stats.created += 1;
                        self.stats.canvases_created += 1;
                    }
                    why |= Why::CANVAS;
                }
            }
        }

        if self.vertex_holes as usize > self.list.vertices.len() / 2 && self.vertex_holes > 4096 {
            self.compact();
            why |= Why::COMPACT;
        }

        if why == 0 {
            // Rows only: a moved canvas moves its top-level items' subtrees.
            let mut roots: Vec<Id> = Vec::new();
            for c in &moved_canvases {
                if let Some(canvas) = state.canvases.get(c) {
                    roots.extend(canvas.items.iter().copied());
                }
            }
            roots.extend(moved);
            for id in roots {
                if !self.move_subtree(state, id) {
                    // A clip or the alpha cut changed with the move: fall back to the walk.
                    why |= Why::MOVE_FALLBACK;
                    break;
                }
            }
        }
        self.stats.why = why;
        // Content changes of shape alone keep the walk's results (attach list, rows): only the
        // index buffer and the draw table are re-assembled (G7a's incremental structural apply).
        let walk = why & !Why::CONTENT_SHAPE != 0 || content_walk;
        if why != 0 {
            #[cfg(not(target_arch = "wasm32"))]
            let t0 = std::time::Instant::now();
            if walk {
                self.walk(state);
            } else {
                self.stats.reassembled = true;
            }
            #[cfg(not(target_arch = "wasm32"))]
            let t1 = std::time::Instant::now();
            self.assemble(state);
            #[cfg(not(target_arch = "wasm32"))]
            {
                self.stats.walk_us = (t1 - t0).as_secs_f64() * 1e6;
                self.stats.assemble_us = t1.elapsed().as_secs_f64() * 1e6;
            }
        }
        self.refresh_bindings(state);
        self.first = false;
        self.meshes = mesh_res;
        self.stats.vertex_count = self.list.vertices.len() as u32;
        self.stats.index_count = self.list.indices.len() as u32;
        self.stats.emitted_draws = self.list.draws.len() as u32;
        self.stats.expected_calls = self.list.merged_draw_count() as u32;
        &self.stats
    }

    // ------------------------------------------------------------------------------- the walk

    fn walk(&mut self, state: &ResolvedState) {
        self.stats.structural = true;
        self.attach.clear();
        self.walk_keys.clear();
        for rec in self.items.values_mut() {
            rec.visited = false;
        }
        let mut canvases: Vec<&Canvas> = state.canvases.values().filter(|c| c.attached).collect();
        if self.sabotage.ignore_canvas_stacking {
            canvases.sort_by_key(|c| c.id);
        } else {
            canvases.sort_by_key(|c| (c.layer, c.sublayer, c.id));
        }
        if canvases
            .windows(2)
            .any(|w| (w[0].layer, w[0].sublayer) == (w[1].layer, w[1].sublayer))
        {
            self.note(ApplyShortcut::TieAppendOrder.as_str(), 1);
        }
        let vp = self.viewport;
        for canvas in canvases {
            let start = self.attach.len();
            let canvas_xf = geom::mul(&vp.global_xform, &canvas.xform);
            let order = self.sorted_children(state, &canvas.items);
            for &child in order.iter() {
                self.cull(state, child, &canvas_xf, None, WHITE, 0, None, canvas.id);
            }
            // Per-z lists concatenated in z order; within a z, attach order (a stable sort).
            if !self.sabotage.ignore_z {
                self.attach[start..].sort_by_key(|a| a.z);
            }
        }
        // Rows of every visited item.
        let ids: Vec<Id> = self
            .items
            .iter()
            .filter(|(_, r)| r.visited)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.write_row(state, id);
        }
        // Binding slots no attached item uses any more are released.
        let gone: Vec<BindingKey> = self
            .binding_slots
            .keys()
            .filter(|k| !self.walk_keys.contains(k))
            .copied()
            .collect();
        for key in gone {
            if let Some(slot) = self.binding_slots.remove(&key) {
                self.binding_keys[slot as usize] = None;
                self.list.set_binding(slot, Binding::default());
                self.free_slots.push(slot);
                // A released slot is logged too (program 0): its values no longer draw.
                self.bindings_changed.push(slot);
            }
        }
    }

    /// The binding slot of `key`, allocated on first use (a walk-time call).
    fn binding_slot(&mut self, key: BindingKey) -> u32 {
        self.walk_keys.insert(key);
        if let Some(slot) = self.binding_slots.get(&key) {
            return *slot;
        }
        let slot = self.free_slots.pop().unwrap_or_else(|| {
            self.binding_keys.push(None);
            self.binding_keys.len() as u32 - 1
        });
        self.binding_keys[slot as usize] = Some(key);
        self.binding_slots.insert(key, slot);
        slot
    }

    /// Typed refusals: the first time each named custom shader (id, hash) is drawn without its
    /// code (receiver.gd `_withheld_reported`, once per shader and hash).
    fn note_shader_refusals(&mut self, state: &ResolvedState) {
        for sid in self.names.named_shaders(state) {
            let Some(hash) = state.shaders.get(&sid).and_then(|s| s.hash) else {
                continue;
            };
            if let Some(ProgramEntry::Refused { reason, detail }) = self.programs.get(&hash) {
                if self.refusals_reported.insert((sid, hash)) {
                    self.shader_refusals.push(ShaderRefusal {
                        shader: sid,
                        hash,
                        reason,
                        detail: detail.clone(),
                    });
                }
            }
        }
    }

    /// Every live binding's values from the current state (`Binding`'s contract): the program's
    /// uniforms from the material's parameters (its instance uniforms from the item's), its
    /// samplers from a texture parameter, else the shader's default texture, else white, and the
    /// canvas modulate unless the code is unshaded. Only slots whose values differ are dirtied.
    fn refresh_bindings(&mut self, state: &ResolvedState) {
        let mut live = 0u32;
        for slot in 0..self.binding_keys.len() as u32 {
            let Some(key) = self.binding_keys[slot as usize] else {
                continue;
            };
            live += 1;
            let Some(ProgramEntry::Ready(info)) = self.programs.get(&key.hash) else {
                continue;
            };
            let binding = self.binding_of(state, &key, info);
            if self.list.set_binding(slot, binding) {
                self.bindings_changed.push(slot);
            }
        }
        self.stats.bindings = live;
        self.stats.bindings_changed = self.bindings_changed.len() as u32;
    }

    fn binding_of(&self, state: &ResolvedState, key: &BindingKey, info: &ProgramInfo) -> Binding {
        let material = state.materials.get(&key.material);
        let params: &[Param] = if self.sabotage.stale_param {
            self.stale_params
                .get(&key.material)
                .map(|p| p.as_slice())
                .unwrap_or(&[])
        } else {
            material.map(|m| m.params.as_slice()).unwrap_or(&[])
        };
        let instance: &[Param] = key
            .item
            .and_then(|i| state.items.get(&i))
            .map(|it| it.instance_params.as_slice())
            .unwrap_or(&[]);
        let uniforms = info
            .uniforms
            .iter()
            .map(|d| Uniform {
                name: d.name.clone(),
                value: programs::uniform_value(
                    d,
                    programs::param(if d.instance { instance } else { params }, &d.name),
                ),
            })
            .collect();
        let shader = material
            .and_then(|m| m.shader)
            .and_then(|s| state.shaders.get(&s));
        let samplers = info
            .samplers
            .iter()
            .map(|s| {
                let wire = match programs::param(params, &s.name).map(|p| &p.value) {
                    Some(crate::state::ParamValue::Tex(t)) => Some(*t),
                    _ => shader.and_then(|sh| {
                        sh.default_textures
                            .iter()
                            .find(|d| *d.name == *s.name && d.index == 0)
                            .map(|d| d.tex)
                    }),
                };
                // A canvas texture samples its diffuse; anything not resident is Godot's
                // default (white, the only default the transpiler admits).
                let gpu = wire
                    .map(|t| match state.textures.get(&t) {
                        Some(e) if e.kind == TextureKind::Canvas => {
                            e.canvas.as_ref().and_then(|c| c.diffuse).unwrap_or(0)
                        }
                        _ => t,
                    })
                    .filter(|g| {
                        self.resident.get(g).is_some_and(|r| {
                            matches!(r.kind, TextureKind::Image | TextureKind::Placeholder)
                        })
                    })
                    .unwrap_or(WHITE_TEXTURE);
                let linear = s.linear.unwrap_or(true);
                let repeat = s.repeat.unwrap_or(false);
                SamplerUniform {
                    name: s.name.clone(),
                    texture: gpu,
                    sampler: (if linear { Sampler::LINEAR } else { 0 })
                        | if repeat {
                            Sampler::REPEAT
                        } else {
                            Sampler::CLAMP
                        },
                }
            })
            .collect();
        let post_modulate = if info.light == LightMode::Unshaded {
            WHITE
        } else {
            canvas_modulate(state, key.canvas, self.sabotage.ignore_canvas_modulate)
        };
        Binding {
            program: info.program,
            post_modulate,
            uniforms,
            samplers,
        }
    }

    /// `children` in draw order: as listed when their `draw_index`es already increase strictly (the
    /// common case: no allocation), else sorted by `draw_index` (ties keep list order, typed).
    fn sorted_children<'s>(
        &mut self,
        state: &'s ResolvedState,
        children: &'s [Id],
    ) -> std::borrow::Cow<'s, [Id]> {
        let mut last = i64::MIN;
        let mut in_order = true;
        for c in children {
            match state.items.get(c) {
                Some(it) if it.draw_index > last => last = it.draw_index,
                _ => {
                    in_order = false;
                    break;
                }
            }
        }
        if in_order {
            return std::borrow::Cow::Borrowed(children);
        }
        let mut order: Vec<(i64, Id)> = children
            .iter()
            .filter_map(|c| state.items.get(c).map(|it| (it.draw_index, *c)))
            .collect();
        order.sort_by_key(|(d, _)| *d);
        if order.windows(2).any(|w| w[0].0 == w[1].0) {
            self.note(ApplyShortcut::TieAppendOrder.as_str(), 1);
        }
        std::borrow::Cow::Owned(order.into_iter().map(|(_, c)| c).collect())
    }

    #[allow(clippy::too_many_arguments)]
    fn cull(
        &mut self,
        state: &ResolvedState,
        id: Id,
        parent_xf: &Xform,
        clip: Option<Rect>,
        parent_modulate: [f32; 4],
        z: i64,
        material_owner: Option<Id>,
        canvas: Id,
    ) {
        let Some(it) = state.items.get(&id) else {
            return;
        };
        if !it.visible || it.visibility_layer & self.viewport.cull_mask == 0 {
            return;
        }
        let modulate = mul4(it.modulate, parent_modulate);
        if modulate[3] < 0.007 {
            return;
        }
        let final_xf = geom::mul(parent_xf, &it.xform);
        let mut own_clip = clip;
        let clips = if self.sabotage.ignore_clip {
            false
        } else if self.sabotage.clip_before_clear {
            self.items.get(&id).is_some_and(|r| r.clip_eff)
        } else {
            it.clip
        };
        if clips {
            let rect = if it.custom_rect {
                it.custom_rect_rect
            } else {
                self.items
                    .get(&id)
                    .map(|r| r.lowered.rect)
                    .unwrap_or([0.0; 4])
            };
            let global = geom::xform_rect(&final_xf, &rect);
            let vp = [
                0.0,
                0.0,
                self.viewport.width as f32,
                self.viewport.height as f32,
            ];
            let fc = geom::intersect(&clip.unwrap_or(vp), &global);
            if fc[2] < 0.5 || fc[3] < 0.5 {
                return;
            }
            own_clip = Some([
                geom::round_half_away(fc[0]),
                geom::round_half_away(fc[1]),
                geom::round_half_away(fc[2]),
                geom::round_half_away(fc[3]),
            ]);
        }
        let z = if it.z_relative {
            (z + it.z_index).clamp(Z_MIN, Z_MAX)
        } else {
            it.z_index
        };
        let owner = if it.use_parent_material && material_owner.is_some() {
            material_owner
        } else {
            Some(id)
        };
        let eff = self.material_of(state, owner.unwrap_or(id));
        let MaterialEff {
            blend,
            unshaded,
            light_only,
            ..
        } = eff;
        let children = self.sorted_children(state, &it.children);
        for &c in children.iter() {
            if state.items.get(&c).is_some_and(|ci| ci.behind) {
                self.cull(state, c, &final_xf, own_clip, modulate, z, owner, canvas);
            }
        }
        // An item-space program takes the canvas modulate after its code (the binding's
        // `post_modulate`), so its row carries none.
        let draws_something = self
            .items
            .get(&id)
            .is_some_and(|r| !r.lowered.draws.is_empty());
        let program = match eff.program {
            Some((material, hash)) if draws_something && !light_only => {
                let instanced = matches!(
                    self.programs.get(&hash),
                    Some(ProgramEntry::Ready(info)) if info.has_instance_uniforms()
                );
                1 + self.binding_slot(BindingKey {
                    material,
                    canvas,
                    item: instanced.then_some(id),
                    hash,
                })
            }
            _ => 0,
        };
        if let Some(rec) = self.items.get_mut(&id) {
            rec.visited = true;
            rec.scissor = own_clip;
            rec.final_xform = final_xf;
            rec.child_modulate = modulate;
            rec.canvas = canvas;
            rec.unshaded = unshaded;
            rec.program_bound = eff.program.is_some();
            rec.canvas_modulate = if unshaded || rec.program_bound {
                WHITE
            } else {
                canvas_modulate(state, canvas, self.sabotage.ignore_canvas_modulate)
            };
            // _attach_canvas_item_for_draw: an item is drawn only when its global rect (the custom
            // rect, else its content's) touches the viewport rect, borders included
            // (renderer_canvas_cull.cpp:247; gate 3's `cull` region).
            let rect = if it.custom_rect {
                it.custom_rect_rect
            } else {
                rec.lowered.rect
            };
            let vp = [
                0.0,
                0.0,
                self.viewport.width as f32,
                self.viewport.height as f32,
            ];
            rec.on_screen = geom::intersects_inclusive(&vp, &geom::xform_rect(&final_xf, &rect));
            if !rec.lowered.draws.is_empty() && !light_only && rec.on_screen {
                let scissor =
                    own_clip.map(|r| [r[0] as i32, r[1] as i32, r[2] as i32, r[3] as i32]);
                self.attach.push(Attach {
                    item: id,
                    z: z as i32,
                    scissor,
                    blend,
                    program,
                });
            }
        }
        for &c in children.iter() {
            if !state.items.get(&c).is_some_and(|ci| ci.behind) {
                self.cull(state, c, &final_xf, own_clip, modulate, z, owner, canvas);
            }
        }
    }

    /// The effective material's blend, and whether it is unshaded or light-only (gate5_5-design.md
    /// D7; no lights reach the wire, so `normal` draws unlit and `light_only` draws nothing).
    fn material_of(&mut self, state: &ResolvedState, owner: Id) -> MaterialEff {
        let mut eff = self.material_unswapped(state, owner);
        if self.sabotage.blend_swap {
            eff.blend = match eff.blend {
                Blend::Add => Blend::Sub,
                Blend::Sub => Blend::Add,
                other => other,
            };
        }
        eff
    }

    fn material_unswapped(&mut self, state: &ResolvedState, owner: Id) -> MaterialEff {
        if self.sabotage.ignore_material {
            return NO_MATERIAL;
        }
        let Some(mid) = state.items.get(&owner).and_then(|it| it.material) else {
            return NO_MATERIAL;
        };
        let Some(m) = state.materials.get(&mid) else {
            return NO_MATERIAL;
        };
        if m.status != EntryStatus::Ok {
            self.note(ApplyShortcut::MaterialUnsupportedDefault.as_str(), 1);
            return NO_MATERIAL;
        }
        let Some(sid) = m.shader else {
            return NO_MATERIAL;
        };
        let Some(s) = state.shaders.get(&sid) else {
            return NO_MATERIAL;
        };
        if s.status != EntryStatus::Ok {
            self.note(ApplyShortcut::MaterialUnsupportedDefault.as_str(), 1);
            return NO_MATERIAL;
        }
        let blend_of = |b: BlendMode| match b {
            BlendMode::Mix => Blend::Mix,
            BlendMode::Add => Blend::Add,
            BlendMode::Sub => Blend::Sub,
            BlendMode::Mul => Blend::Mul,
            BlendMode::PremulAlpha => Blend::PremulAlpha,
            BlendMode::Disabled => Blend::Disabled,
        };
        if let Some(b) = &s.builtin {
            return MaterialEff {
                blend: blend_of(b.blend_mode),
                unshaded: b.light_mode == LightMode::Unshaded,
                light_only: b.light_mode == LightMode::LightOnly,
                program: None,
            };
        }
        // G7s: a custom shader draws as its item-space program; a refused one (transpile,
        // compile, or withheld code without a library) as no material, like the native
        // receiver's shaderless material; one the adapter never registered with the builtin
        // program (`slice-shader-builtin`, typed `gsw-shader-builtin`).
        match s.hash.and_then(|h| self.programs.get(&h).map(|e| (h, e))) {
            Some((hash, ProgramEntry::Ready(info))) => MaterialEff {
                blend: blend_of(info.blend),
                unshaded: info.light == LightMode::Unshaded,
                light_only: info.light == LightMode::LightOnly,
                program: Some((mid, hash)),
            },
            Some((_, ProgramEntry::Refused { .. })) => NO_MATERIAL,
            None => {
                self.note(ApplyShortcut::ShaderBuiltin.as_str(), 1);
                NO_MATERIAL
            }
        }
    }

    fn write_row(&mut self, state: &ResolvedState, id: Id) {
        let Some(rec) = self.items.get(&id) else {
            return;
        };
        if !rec.visited {
            return;
        }
        let Some(it) = state.items.get(&id) else {
            return;
        };
        let modulate = mul4(
            mul4(rec.child_modulate, it.self_modulate),
            rec.canvas_modulate,
        );
        let row = Row {
            xform: rec.final_xform,
            modulate,
            flags: 0,
            reserved: 0,
        };
        let r = rec.row;
        if self.list.items[r as usize] != row {
            self.list.items[r as usize] = row;
            self.list.dirty.items.add(r, r + 1);
            self.stats.rows_written += 1;
        }
    }

    // ------------------------------------------------------------------------------- assembly

    fn assemble(&mut self, state: &ResolvedState) {
        self.list.indices.clear();
        self.list.draws.clear();
        let default_filter = state.default_texture_filter;
        let default_repeat = state.default_texture_repeat;
        let mut lowered_draws = 0u32;
        let mut skips = 0u32;
        let mut attached = 0u32;
        for a in &self.attach {
            let Some(rec) = self.items.get(&a.item) else {
                continue;
            };
            let Some(it) = state.items.get(&a.item) else {
                continue;
            };
            attached += 1;
            let item_filter = if it.texture_filter == Filter::Default {
                default_filter
            } else {
                it.texture_filter
            };
            let item_repeat = if it.texture_repeat == Repeat::Default {
                default_repeat
            } else {
                it.texture_repeat
            };
            for ld in &rec.lowered.draws {
                lowered_draws += 1;
                let LDraw {
                    first_index,
                    index_count,
                    tex,
                    force_repeat,
                    clip_ignored,
                } = *ld;
                let (texture, filter, repeat) = match tex {
                    TexRef::White => (WHITE_TEXTURE, item_filter, item_repeat),
                    TexRef::Wire(tid) => {
                        // A canvas texture draws its diffuse with its own filter/repeat when set.
                        let (gpu, f, r) = match state.textures.get(&tid) {
                            Some(t) if t.kind == TextureKind::Canvas => {
                                let ct = t.canvas.as_ref();
                                let diffuse = ct.and_then(|c| c.diffuse).unwrap_or(0);
                                let f = ct
                                    .map(|c| c.filter)
                                    .filter(|f| *f != Filter::Default)
                                    .unwrap_or(item_filter);
                                let r = ct
                                    .map(|c| c.repeat)
                                    .filter(|r| *r != Repeat::Default)
                                    .unwrap_or(item_repeat);
                                (diffuse, f, r)
                            }
                            _ => (tid, item_filter, item_repeat),
                        };
                        if !self.resident.get(&gpu).is_some_and(|r| {
                            matches!(r.kind, TextureKind::Image | TextureKind::Placeholder)
                        }) {
                            skips += 1;
                            continue;
                        }
                        (gpu, f, r)
                    }
                };
                let first = self.list.indices.len() as u32;
                let base = rec.vstart;
                self.list.indices.extend(
                    rec.lowered.idx[first_index as usize..(first_index + index_count) as usize]
                        .iter()
                        .map(|i| base + i),
                );
                let scissor = if clip_ignored { None } else { a.scissor };
                self.list.draws.push(Draw {
                    first_index: first,
                    index_count,
                    texture,
                    sampler: sampler_bits(filter, repeat, force_repeat),
                    blend: a.blend as u32,
                    program: a.program,
                    scissor: scissor.unwrap_or([0; 4]),
                    flags: if scissor.is_some() { DRAW_SCISSOR } else { 0 },
                });
            }
        }
        if skips > 0 {
            self.note(ApplyShortcut::TextureNotResident.as_str(), u64::from(skips));
        }
        self.stats.lowered_draws = lowered_draws;
        self.stats.assembly_skips = skips;
        self.stats.attached_items = attached;
        self.list.dirty.indices.clear();
        let n = self.list.indices.len() as u32;
        if n > 0 {
            self.list.dirty.indices.add(0, n);
        }
        self.list.dirty.draws = true;
    }

    // ------------------------------------------------------------------------------- rows-only

    /// Recompute the rows of `id`'s subtree after a transform or modulate change. Returns false
    /// when the change needs the walk (a clipping item in the subtree, or the alpha cut flips).
    fn move_subtree(&mut self, state: &ResolvedState, id: Id) -> bool {
        let Some(it) = state.items.get(&id) else {
            return true;
        };
        let Some(rec) = self.items.get(&id) else {
            return true;
        };
        if !rec.visited {
            // Not drawn now; the change matters only once it becomes visible (structural then).
            return true;
        }
        let (parent_xf, parent_mod) = match it.parent {
            Some(p) if p.kind == crate::state::ParentKind::Item => match self.items.get(&p.id) {
                Some(pr) if pr.visited => (pr.final_xform, pr.child_modulate),
                _ => return true,
            },
            Some(p) => match state.canvases.get(&p.id) {
                Some(c) => (geom::mul(&self.viewport.global_xform, &c.xform), WHITE),
                None => return true,
            },
            None => return true,
        };
        self.move_rec(state, id, &parent_xf, parent_mod)
    }

    fn move_rec(
        &mut self,
        state: &ResolvedState,
        id: Id,
        parent_xf: &Xform,
        parent_mod: [f32; 4],
    ) -> bool {
        let Some(it) = state.items.get(&id) else {
            return true;
        };
        if !it.visible || it.visibility_layer & self.viewport.cull_mask == 0 {
            return true;
        }
        if it.clip && !self.sabotage.ignore_clip {
            return false;
        }
        let modulate = mul4(it.modulate, parent_mod);
        let was_visited = self.items.get(&id).is_some_and(|r| r.visited);
        if (modulate[3] < 0.007) == was_visited {
            // Crossing the alpha cut changes what draws.
            return false;
        }
        if !was_visited {
            return true;
        }
        let final_xf = geom::mul(parent_xf, &it.xform);
        if let Some(rec) = self.items.get(&id) {
            let rect = if it.custom_rect {
                it.custom_rect_rect
            } else {
                rec.lowered.rect
            };
            let vp = [
                0.0,
                0.0,
                self.viewport.width as f32,
                self.viewport.height as f32,
            ];
            if geom::intersects_inclusive(&vp, &geom::xform_rect(&final_xf, &rect)) != rec.on_screen
            {
                // Moving on or off screen changes what is attached: the walk decides.
                return false;
            }
        }
        let ignore_canvas_modulate = self.sabotage.ignore_canvas_modulate;
        if let Some(rec) = self.items.get_mut(&id) {
            rec.final_xform = final_xf;
            rec.child_modulate = modulate;
            rec.canvas_modulate = if rec.unshaded || rec.program_bound {
                WHITE
            } else {
                canvas_modulate(state, rec.canvas, ignore_canvas_modulate)
            };
        }
        self.write_row(state, id);
        for c in it.children.clone() {
            if !self.move_rec(state, c, &final_xf, modulate) {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod g7t_tests;
#[cfg(test)]
mod ordering_model;
#[cfg(test)]
mod tests;
