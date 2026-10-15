//! D7's applier: the resolved state to `gsw-canvas-draw-list`'s packed list, in O(changed) where
//! the change allows it (D29, Q14b).
//!
//! The walk is `RendererCanvasCull::_cull_canvas_item` (renderer_canvas_cull.cpp:293-482) without
//! y-sort, canvas groups, repeat and visibility notifiers (none reach the wire as supported):
//! canvases by `(layer, sublayer)`, children by `draw_index`, `draw_behind_parent` children before
//! their parent, per-z lists concatenated in z order, `modulate` composed down the tree with
//! `self_modulate` last, `visible`, the cull mask, the 0.007 alpha cut, and the clip as Godot's
//! integer scissor (`clip-derive.ts`'s rules: the rounded AABB of the transformed item rect
//! intersected with the clip owner's). Items are not culled against the viewport: Godot's
//! `global_rect` test only skips items that draw nothing on screen, and drawing them is pixel-exact.
//!
//! Three paths, chosen per transaction from what changed:
//! - nothing structural: item rows only (a transform or modulate change moves the subtree's rows),
//!   and an item whose re-lowered content keeps its shape overwrites its own vertex range;
//! - structural (order, visibility, z, clip, materials, textures, a content change of shape): the
//!   walk re-runs over the state and the index buffer and draw table are rebuilt; vertices stay in
//!   each item's slab range, so only changed items' vertices move.

pub mod geom;
pub mod lower;
pub mod payloads;

use crate::state::{
    BlendMode, Canvas, EntryStatus, Filter, Id, Item, LightMode, Repeat, ResolvedState,
    TextureKind, TxDelta,
};
use geom::{Rect, Xform};
use gsw_canvas_draw_list::{
    Blend, Draw, DrawList, Format, Item as Row, Sampler, Target, DRAW_SCISSOR, WHITE_TEXTURE,
};
use lower::{LDraw, Lowered, TexRef};
use payloads::{MeshGeometry, PayloadStore};
use std::collections::{BTreeMap, HashMap};

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

/// Per-apply counters (one frame).
#[derive(Clone, Debug, Default)]
pub struct ApplyStats {
    pub structural: bool,
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
    pub vertex_count: u32,
    pub index_count: u32,
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
}

#[derive(Clone, Copy, Debug)]
struct Attach {
    item: Id,
    z: i32,
    scissor: Option<[i32; 4]>,
    blend: Blend,
}

struct TexRes {
    hash: crate::state::Hash,
    width: u32,
    height: u32,
}

/// The applier: owns the packed list it fills.
pub struct Applier {
    pub list: DrawList,
    viewport: Viewport,
    items: HashMap<Id, ItemRec>,
    free_rows: Vec<u32>,
    resident: HashMap<Id, TexRes>,
    attach: Vec<Attach>,
    vertex_holes: u32,
    /// The canvas, material, shader and canvas-texture entries the last walk used: a full
    /// transaction re-lists every entry, so changes are found by comparison, not by presence.
    canvases: HashMap<Id, Canvas>,
    materials: HashMap<Id, crate::state::Material>,
    shaders: HashMap<Id, crate::state::Shader>,
    canvas_textures: HashMap<Id, crate::state::Texture>,
    pub shortcut_totals: BTreeMap<&'static str, u64>,
    pub stats: ApplyStats,
    first: bool,
}

/// The texture and mesh tables as the lowering sees them.
struct TableView<'a> {
    state: &'a ResolvedState,
    payloads: &'a PayloadStore,
}

impl<'a> TableView<'a> {
    /// The image entry a texture id draws from (itself, or a canvas texture's diffuse).
    fn image(&self, id: Id) -> Option<&'a crate::state::Texture> {
        let t = self.state.textures.get(&id)?;
        let img = match t.kind {
            TextureKind::Image => t,
            TextureKind::Canvas => {
                if t.status != EntryStatus::Ok {
                    return None;
                }
                self.state.textures.get(&t.canvas.as_ref()?.diffuse?)?
            }
            TextureKind::Placeholder => return None,
        };
        (img.kind == TextureKind::Image && img.status == EntryStatus::Ok && img.hash.is_some())
            .then_some(img)
    }
}

impl lower::Tables for TableView<'_> {
    fn texture_size(&self, id: Id) -> Option<(u32, u32, bool)> {
        let img = self.image(id)?;
        self.payloads
            .textures
            .contains_key(img.hash.as_ref()?)
            .then_some((img.width as u32, img.height as u32, img.mipmaps))
    }
    fn mesh(&self, id: Id) -> Option<(Vec<&MeshGeometry>, Rect)> {
        let m = self.state.meshes.get(&id)?;
        if m.status != EntryStatus::Ok {
            return None;
        }
        let mut surfaces = Vec::with_capacity(m.surfaces.len());
        let mut aabb: Option<[f32; 6]> = None;
        for s in &m.surfaces {
            let g = self.payloads.meshes.get(&s.hash)?;
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
            surfaces.push(g);
        }
        let c = m.custom_aabb;
        let rect = if c.iter().any(|v| *v != 0.0) {
            [c[0], c[1], c[3], c[4]]
        } else {
            let a = aabb.unwrap_or([0.0; 6]);
            [a[0], a[1], a[3], a[4]]
        };
        Some((surfaces, rect))
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
        };
        Applier {
            list: DrawList::new(target),
            viewport,
            items: HashMap::new(),
            free_rows: Vec::new(),
            resident: HashMap::new(),
            attach: Vec::new(),
            vertex_holes: 0,
            canvases: HashMap::new(),
            materials: HashMap::new(),
            shaders: HashMap::new(),
            canvas_textures: HashMap::new(),
            shortcut_totals: BTreeMap::new(),
            stats: ApplyStats::default(),
            first: true,
        }
    }

    pub fn viewport(&self) -> &Viewport {
        &self.viewport
    }

    /// After a lost and restored context: re-send every array and every resident texture.
    pub fn context_restored(&mut self, payloads: &PayloadStore) {
        self.list.dirty.all = true;
        self.list.dirty.draws = true;
        let ids: Vec<(Id, crate::state::Hash)> =
            self.resident.iter().map(|(id, r)| (*id, r.hash)).collect();
        for (id, hash) in ids {
            if let Some(px) = payloads.textures.get(&hash) {
                self.list.upload_texture(id, px.width, px.height, &px.rgba);
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
        let lowered = lower::lower(&it.commands, tables);
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

    /// Bring residency in line with the texture table: upload new image versions whose pixels are
    /// present, free what left or stopped being drawable. Returns the ids whose drawn size changed.
    fn sync_textures(
        &mut self,
        state: &ResolvedState,
        delta: &TxDelta,
        payloads: &PayloadStore,
    ) -> Vec<Id> {
        let mut resized = Vec::new();
        let candidates: Vec<Id> = if self.first {
            state.textures.keys().copied().collect()
        } else {
            delta.textures_upserted.clone()
        };
        for id in candidates {
            let Some(t) = state.textures.get(&id) else {
                continue;
            };
            let drawable = t.kind == TextureKind::Image && t.status == EntryStatus::Ok;
            match (drawable, t.hash) {
                (true, Some(hash)) => {
                    let same = self.resident.get(&id).is_some_and(|r| r.hash == hash);
                    if same {
                        continue;
                    }
                    let Some(px) = payloads.textures.get(&hash) else {
                        continue;
                    };
                    let old = self.resident.insert(
                        id,
                        TexRes {
                            hash,
                            width: px.width,
                            height: px.height,
                        },
                    );
                    if old.map(|o| (o.width, o.height)) != Some((px.width, px.height)) {
                        resized.push(id);
                    }
                    self.list.upload_texture(id, px.width, px.height, &px.rgba);
                    self.stats.texture_uploads += 1;
                    self.stats.texture_upload_bytes += px.rgba.len() as u64;
                }
                _ => {
                    if self.resident.remove(&id).is_some() {
                        self.list.free_texture(id);
                        self.stats.texture_frees += 1;
                        resized.push(id);
                    }
                }
            }
        }
        for id in &delta.textures_removed {
            if self.resident.remove(id).is_some() {
                self.list.free_texture(*id);
                self.stats.texture_frees += 1;
                resized.push(*id);
            }
        }
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
        let tables = TableView { state, payloads };
        let mut structural = self.first || delta.defaults_changed;
        // Materials, shaders and canvas textures decide blends and samplers: a real change re-walks.
        for id in &delta.materials_removed {
            structural |= self.materials.remove(id).is_some();
        }
        for id in &delta.shaders_removed {
            structural |= self.shaders.remove(id).is_some();
        }
        for id in &delta.textures_removed {
            structural |= self.canvas_textures.remove(id).is_some();
        }
        let mats: Vec<Id> = if self.first {
            state.materials.keys().copied().collect()
        } else {
            delta.materials_upserted.clone()
        };
        for id in mats {
            if let Some(m) = state.materials.get(&id) {
                if self.materials.get(&id) != Some(m) {
                    self.materials.insert(id, m.clone());
                    structural = true;
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
                if self.shaders.get(&id) != Some(sh) {
                    self.shaders.insert(id, sh.clone());
                    structural = true;
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
                    structural = true;
                }
            }
        }
        let resized = self.sync_textures(state, delta, payloads);
        if !resized.is_empty() {
            structural = true;
        }

        // Removed items.
        for id in &delta.items_removed {
            if let Some(rec) = self.items.remove(id) {
                self.free_rows.push(rec.row);
                self.vertex_holes += rec.vcap;
                structural = true;
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
                    };
                    Self::place_vertices(&mut self.list, &mut rec, &mut self.vertex_holes);
                    self.items.insert(id, rec);
                    structural = true;
                }
                true => {
                    let content_changed = self.items[&id].content_version != it.content_version;
                    if content_changed {
                        let (lowered, tex_sizes, mesh_versions) = self.lower_item(it, &tables);
                        self.stats.relowered += 1;
                        let rec = self.items.get_mut(&id).unwrap();
                        let same =
                            lowered.same_shape(&rec.lowered) && lowered.rect == rec.lowered.rect;
                        rec.lowered = lowered;
                        rec.tex_sizes = tex_sizes;
                        rec.mesh_versions = mesh_versions;
                        rec.content_version = it.content_version;
                        let moved_range =
                            Self::place_vertices(&mut self.list, rec, &mut self.vertex_holes);
                        if same && !moved_range {
                            self.stats.relowered_in_place += 1;
                        } else {
                            structural = true;
                        }
                    }
                    let rec = self.items.get_mut(&id).unwrap();
                    if rec.key != key {
                        rec.key = key;
                        structural = true;
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

        // Dependencies: texture sizes and mesh versions an existing lowering used.
        let dep_mesh_changed =
            !delta.meshes_upserted.is_empty() || !delta.meshes_removed.is_empty();
        if !resized.is_empty() || dep_mesh_changed {
            let stale: Vec<Id> =
                self.items
                    .iter()
                    .filter(|(_, rec)| {
                        rec.tex_sizes.iter().any(|(t, s)| {
                            resized.contains(t) || lower::Tables::texture_size(&tables, *t) != *s
                        }) || rec.mesh_versions.iter().any(|(m, v)| {
                            state.meshes.get(m).map(|e| e.version).unwrap_or(-1) != *v
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
                structural = true;
            }
        }

        // Canvases: order facts re-walk; a transform or modulate change moves the canvas's rows.
        let mut moved_canvases: Vec<Id> = Vec::new();
        for id in &delta.canvases_removed {
            structural |= self.canvases.remove(id).is_some();
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
                    self.canvases.insert(id, c.clone());
                    structural = true;
                }
            }
        }

        if self.vertex_holes as usize > self.list.vertices.len() / 2 && self.vertex_holes > 4096 {
            self.compact();
            structural = true;
        }

        if !structural {
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
                    structural = true;
                    break;
                }
            }
        }
        if structural {
            self.walk(state);
            self.assemble(state);
        }
        self.first = false;
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
        for rec in self.items.values_mut() {
            rec.visited = false;
        }
        let mut canvases: Vec<&Canvas> = state.canvases.values().filter(|c| c.attached).collect();
        canvases.sort_by_key(|c| (c.layer, c.sublayer, c.id));
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
            for child in order {
                self.cull(state, child, &canvas_xf, None, WHITE, 0, None, canvas.id);
            }
            // Per-z lists concatenated in z order; within a z, attach order (a stable sort).
            self.attach[start..].sort_by_key(|a| a.z);
        }
        // Rows of every visited item.
        let ids: Vec<Id> = self.items.keys().copied().collect();
        for id in ids {
            self.write_row(state, id);
        }
    }

    fn sorted_children(&mut self, state: &ResolvedState, children: &[Id]) -> Vec<Id> {
        let mut order: Vec<(i64, Id)> = children
            .iter()
            .filter_map(|c| state.items.get(c).map(|it| (it.draw_index, *c)))
            .collect();
        order.sort_by_key(|(d, _)| *d);
        if order.windows(2).any(|w| w[0].0 == w[1].0) {
            self.note(ApplyShortcut::TieAppendOrder.as_str(), 1);
        }
        order.into_iter().map(|(_, c)| c).collect()
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
        if it.clip {
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
        let (blend, unshaded, light_only) = self.material_of(state, owner.unwrap_or(id));
        let children = self.sorted_children(state, &it.children);
        for &c in &children {
            if state.items.get(&c).is_some_and(|ci| ci.behind) {
                self.cull(state, c, &final_xf, own_clip, modulate, z, owner, canvas);
            }
        }
        if let Some(rec) = self.items.get_mut(&id) {
            rec.visited = true;
            rec.final_xform = final_xf;
            rec.child_modulate = modulate;
            rec.canvas = canvas;
            rec.unshaded = unshaded;
            rec.canvas_modulate = if unshaded {
                WHITE
            } else {
                state
                    .canvases
                    .get(&canvas)
                    .map(|c| c.modulate)
                    .unwrap_or(WHITE)
            };
            if !rec.lowered.draws.is_empty() && !light_only {
                let scissor =
                    own_clip.map(|r| [r[0] as i32, r[1] as i32, r[2] as i32, r[3] as i32]);
                self.attach.push(Attach {
                    item: id,
                    z: z as i32,
                    scissor,
                    blend,
                });
            }
        }
        for &c in &children {
            if !state.items.get(&c).is_some_and(|ci| ci.behind) {
                self.cull(state, c, &final_xf, own_clip, modulate, z, owner, canvas);
            }
        }
    }

    /// The effective material's blend, and whether it is unshaded or light-only (gate5_5-design.md
    /// D7; no lights reach the wire, so `normal` draws unlit and `light_only` draws nothing).
    fn material_of(&mut self, state: &ResolvedState, owner: Id) -> (Blend, bool, bool) {
        let Some(mid) = state.items.get(&owner).and_then(|it| it.material) else {
            return (Blend::Mix, false, false);
        };
        let Some(m) = state.materials.get(&mid) else {
            return (Blend::Mix, false, false);
        };
        if m.status != EntryStatus::Ok {
            self.note(ApplyShortcut::MaterialUnsupportedDefault.as_str(), 1);
            return (Blend::Mix, false, false);
        }
        let Some(sid) = m.shader else {
            return (Blend::Mix, false, false);
        };
        let Some(s) = state.shaders.get(&sid) else {
            return (Blend::Mix, false, false);
        };
        if s.status != EntryStatus::Ok {
            self.note(ApplyShortcut::MaterialUnsupportedDefault.as_str(), 1);
            return (Blend::Mix, false, false);
        }
        match &s.builtin {
            Some(b) => {
                let blend = match b.blend_mode {
                    BlendMode::Mix => Blend::Mix,
                    BlendMode::Add => Blend::Add,
                    BlendMode::Sub => Blend::Sub,
                    BlendMode::Mul => Blend::Mul,
                    BlendMode::PremulAlpha => Blend::PremulAlpha,
                    BlendMode::Disabled => Blend::Disabled,
                };
                (
                    blend,
                    b.light_mode == LightMode::Unshaded,
                    b.light_mode == LightMode::LightOnly,
                )
            }
            None => {
                self.note(ApplyShortcut::ShaderBuiltin.as_str(), 1);
                (Blend::Mix, false, false)
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
                        if !self.resident.contains_key(&gpu) {
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
                    program: 0,
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
        if it.clip {
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
        if let Some(rec) = self.items.get_mut(&id) {
            rec.final_xform = final_xf;
            rec.child_modulate = modulate;
            rec.canvas_modulate = if rec.unshaded {
                WHITE
            } else {
                state
                    .canvases
                    .get(&rec.canvas)
                    .map(|c| c.modulate)
                    .unwrap_or(WHITE)
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
mod tests;
