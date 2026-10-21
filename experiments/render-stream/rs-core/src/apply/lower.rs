//! Lowering: one item's resolved commands to item-local triangles (gate7-design.md Q5's lowering
//! table, G7x "Scope"). Every op ports Godot 4.5.1's own construction (`renderer_canvas_cull.cpp`
//! `canvas_item_add_*`, `rasterizer_canvas_gles3.cpp` `_record_item_commands`, `canvas.glsl`), so
//! the vertex counts are the engine's; the slice's approximations are named in [`Shortcut`] and
//! never drop a draw of the four bench inputs.
//!
//! Positions are item-local with the item's draw transform (`add_set_transform`, and an
//! `add_mesh`'s own transform) applied on the CPU, so the executor needs only the item's row.
//! Colours are straight; the item modulate multiplies them in the shader.

use super::geom::{self, Rect, Xform};
use super::payloads::MeshGeometry;
use crate::state::{Axis, Command, Commands, Id, Primitive};
use gsw_canvas_draw_list::Vertex;

/// What a lowered draw samples.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum TexRef {
    /// The white texel (an untextured op, or `tex: null`, Godot's default canvas texture).
    White,
    /// A wire texture-table id, resolved to a resident GPU texture at assembly.
    Wire(Id),
}

/// One lowered draw: an index range of the item's own arrays and the state the op fixes.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct LDraw {
    pub first_index: u32,
    pub index_count: u32,
    pub tex: TexRef,
    /// `add_texture_rect` with `tile`: Godot forces repeat for that rect.
    pub force_repeat: bool,
    /// Drawn between `add_clip_ignore(true)` and `(false)`: the item's scissor is dropped (D10).
    pub clip_ignored: bool,
    /// `add_msdf_texture_rect_region` (G7tm): `[px_range, outline]` as Godot's GLES3 renderer
    /// stores them per instance (rasterizer_canvas_gles3.cpp:999-1004), drawn with
    /// `gsw_canvas_draw_list::DRAW_MSDF`.
    pub msdf: Option<[f32; 2]>,
}

/// The slice's typed approximations and skips (G7x "Scope": every shortcut is listed). Each
/// lowering that takes one counts it, so evidence can say where and how often.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
pub enum Shortcut {
    /// Antialiased rect/line/polyline/circle: the base geometry is drawn, the feather fringe is not.
    /// G7t lowers every feather as the engine builds it; this never fires since.
    AaFeatherOmitted,
    /// GL lines and points (width < 0 lines, polylines and multilines, 2-point primitives, mesh
    /// `lines`/`line_strip`/`points` surfaces) drawn as 1-px quads. G7t measured them inside gate
    /// 5b's thin-line band (D13) with every decided pixel exact, so this is counted, not typed.
    HairlineAsQuads,
    /// Nine-patch `tile`/`tile_fit` axes drawn as `stretch`: only past [`MAX_NINE_PATCH_CELLS`]
    /// tiles (G7t lowers the tile modes as repeated quads).
    NinePatchTileAsStretch,
    /// A mesh surface whose primitive is not triangles/triangle strip: not drawn (typed). G7t
    /// lowers lines and points as hairline quads; this never fires since.
    MeshPrimitiveSkipped,
    /// A texture with mipmaps: level 0 only.
    MipmapsLevel0,
    /// A command whose texture cannot be drawn (unsupported, placeholder, freed, or a canvas
    /// texture without an image diffuse): not drawn, as the wire's derived unsupported entry says.
    TextureUnavailableSkipped,
    /// An `unsupported` command: nothing to draw (the wire already typed it).
    UnsupportedCommand,
    /// An `add_mesh` naming a mesh that is unsupported, freed or has no payload: not drawn.
    MeshUnavailableSkipped,
}

impl Shortcut {
    pub fn as_str(self) -> &'static str {
        match self {
            Shortcut::AaFeatherOmitted => "slice-aa-feather-omitted",
            Shortcut::HairlineAsQuads => "slice-hairline-as-quads",
            Shortcut::NinePatchTileAsStretch => "slice-ninepatch-tile-as-stretch",
            Shortcut::MeshPrimitiveSkipped => "slice-mesh-primitive-skipped",
            Shortcut::MipmapsLevel0 => "slice-mipmaps-level0",
            Shortcut::TextureUnavailableSkipped => "texture-unavailable-skipped",
            Shortcut::UnsupportedCommand => "unsupported-command",
            Shortcut::MeshUnavailableSkipped => "mesh-unavailable-skipped",
        }
    }
    /// Whether the shortcut means a command is not drawn at all (a typed skip, for
    /// `draw-count-parity`), rather than drawn approximately.
    pub fn is_skip(self) -> bool {
        matches!(
            self,
            Shortcut::MeshPrimitiveSkipped
                | Shortcut::TextureUnavailableSkipped
                | Shortcut::UnsupportedCommand
                | Shortcut::MeshUnavailableSkipped
        )
    }
}

/// The largest number of nine-patch cells (tiles per axis multiplied) lowered as quads; a tiling
/// past it draws its middle as `stretch` and counts [`Shortcut::NinePatchTileAsStretch`].
pub const MAX_NINE_PATCH_CELLS: usize = 16384;

/// Receiver sabotages that act on the lowering (gate7-design.md Q5 "Sabotages"): the native
/// receiver's, defined as the former GDScript applier (`rs_applier.gd`, removed in G7gd) defines them, plus G7t's GSW-only `polygon-winding`.
/// Each exists only to fail a check.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LowerSabotage {
    /// Native `drop-msdf` (G4e2): every `add_msdf_texture_rect_region` is skipped, untyped.
    pub drop_msdf: bool,
    /// Native `ignore-set-transform` (G5d): every `add_set_transform` is skipped.
    pub ignore_set_transform: bool,
    /// Native `ignore-clip-ignore` (G5d): every `add_clip_ignore` is skipped.
    pub ignore_clip_ignore: bool,
    /// Native `ignore-nine-patch-axis` (G5g): every nine-patch axis draws as `stretch`.
    pub ignore_nine_patch_axis: bool,
    /// GSW-only `polygon-winding` (G7t): `add_polygon` is lowered as a triangle fan over the
    /// reversed contour instead of the engine's ear clipping, which covers the wrong area of any
    /// concave polygon.
    pub polygon_winding: bool,
    /// GSW-only `msdf-px-range` (G7tm): every MSDF draw takes half the wire's `px_range`, so its
    /// coverage ramps over twice the screen distance (glyph edges blur, thin strokes fade).
    pub msdf_px_range: bool,
}

/// One item's lowered content: valid until its `content_version` or a dependency changes.
#[derive(Clone, Debug, Default)]
pub struct Lowered {
    pub verts: Vec<Vertex>,
    pub idx: Vec<u32>,
    pub draws: Vec<LDraw>,
    /// `Item::get_rect` (renderer_canvas_render.cpp:36-132) of this content, before the custom
    /// rect rule (the caller applies `custom_rect`).
    pub rect: Rect,
    pub shortcuts: Vec<(Shortcut, u32)>,
    /// Wire texture ids whose size the UVs depend on (re-lower when one changes size).
    pub texture_deps: Vec<Id>,
    /// Wire mesh ids whose geometry was used (re-lower when one changes version).
    pub mesh_deps: Vec<Id>,
}

impl Lowered {
    fn note(&mut self, s: Shortcut) {
        if let Some(e) = self.shortcuts.iter_mut().find(|(k, _)| *k == s) {
            e.1 += 1;
        } else {
            self.shortcuts.push((s, 1));
        }
    }
    /// The same shape: equal vertex and index counts and the same draws (state and ranges), so a
    /// re-lowered item can overwrite its vertices in place with no index or draw change.
    pub fn same_shape(&self, other: &Lowered) -> bool {
        self.verts.len() == other.verts.len() && self.idx == other.idx && self.draws == other.draws
    }
}

/// How a command's texture draws (the native receiver's rules, `rs_applier.gd` "Textures"):
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TexDraw {
    /// An `ok` image with its pixels, or an `ok` placeholder (the engine's 4×4 checker,
    /// `texture_storage.cpp` `texture_2d_placeholder`), possibly as a canvas texture's diffuse:
    /// width, height, mipmaps.
    Sized(u32, u32, bool),
    /// Drawn with `RID()`, Godot's white default texture: a `freed` tombstone, or a canvas texture
    /// whose diffuse is unset, freed or not drawable.
    White,
    /// Not drawn: an id the table does not hold, or an `unsupported` entry (the wire types it).
    Skip,
}

/// What the lowering may ask of the texture and mesh tables.
pub trait Tables {
    /// How a texture-table id draws ([`TexDraw`]).
    fn texture_draw(&self, id: Id) -> TexDraw;
    /// The drawable size of a texture-table id, with whether it has mipmaps; `None` unless
    /// [`Tables::texture_draw`] is `Sized`.
    fn texture_size(&self, id: Id) -> Option<(u32, u32, bool)> {
        match self.texture_draw(id) {
            TexDraw::Sized(w, h, m) => Some((w, h, m)),
            _ => None,
        }
    }
    /// The surfaces of a drawable mesh (`ok`, every payload present), with its `mesh_get_aabb`
    /// rect; `None` when it cannot be drawn.
    fn mesh(&self, id: Id) -> Option<(Vec<&MeshGeometry>, Rect)>;
}

struct Builder<'a> {
    out: Lowered,
    xf: Option<Xform>,
    ignoring: bool,
    rect: Option<Rect>,
    tables: &'a dyn Tables,
    /// G7o3: the last texture asked of the tables and how it draws (a text item's glyphs share
    /// one atlas; the tables do not change during a lowering).
    tex_memo: Option<(Id, TexDraw)>,
}

impl<'a> Builder<'a> {
    fn point(&self, p: [f32; 2]) -> [f32; 2] {
        match &self.xf {
            Some(t) => geom::xform_point(t, p),
            None => p,
        }
    }

    fn add_rect_bounds(&mut self, r: Rect) {
        let r = match &self.xf {
            Some(t) => geom::xform_rect(t, &r),
            None => r,
        };
        self.rect = Some(match self.rect {
            Some(prev) => geom::merge(&prev, &r),
            None => r,
        });
    }

    /// Start a draw, or extend the last one when it is this command's continuation with equal
    /// state (keeps one LDraw per op part).
    fn begin(&mut self, tex: TexRef, force_repeat: bool) -> usize {
        let first = self.out.idx.len() as u32;
        self.out.draws.push(LDraw {
            first_index: first,
            index_count: 0,
            tex,
            force_repeat,
            clip_ignored: self.ignoring,
            msdf: None,
        });
        self.out.draws.len() - 1
    }

    fn end(&mut self, d: usize) {
        let n = self.out.idx.len() as u32 - self.out.draws[d].first_index;
        self.out.draws[d].index_count = n;
        if n == 0 {
            self.out.draws.pop();
        }
    }

    fn vertex(&mut self, pos: [f32; 2], uv: [f32; 2], color: [f32; 4]) -> u32 {
        let p = self.point(pos);
        self.out.verts.push(Vertex {
            pos: p,
            uv,
            color,
            item: 0,
        });
        self.out.verts.len() as u32 - 1
    }

    /// Godot's rect quad (canvas.glsl, `vertex_base` order 0:(0,0) 1:(0,1) 2:(1,1) 3:(1,0), triangles
    /// (0,1,2) and (3,0,2)): `vertex = dst.xy + |dst.zw| · flip(base)`, `uv = src.xy + |src.zw| ·
    /// (transpose ? base.yx : base.xy)`.
    fn quad(&mut self, dst: [f32; 4], src: [f32; 4], transpose: bool, color: [f32; 4]) {
        let base = [[0.0f32, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]];
        let flip = [src[2] < 0.0, src[3] < 0.0];
        let first = self.out.verts.len() as u32;
        for b in base {
            let bx = if flip[0] { 1.0 - b[0] } else { b[0] };
            let by = if flip[1] { 1.0 - b[1] } else { b[1] };
            let pos = [dst[0] + dst[2].abs() * bx, dst[1] + dst[3].abs() * by];
            let t = if transpose { [b[1], b[0]] } else { b };
            let uv = [src[0] + src[2].abs() * t[0], src[1] + src[3].abs() * t[1]];
            self.vertex(pos, uv, color);
        }
        self.out
            .idx
            .extend_from_slice(&[first, first + 1, first + 2, first + 3, first, first + 2]);
    }

    /// `quad` with `CANVAS_RECT_CLIP_UV` (canvas.glsl:593-596): the UV is clamped to the source
    /// rect inset by half a texel. The clamp is piecewise linear along each axis (constant, linear,
    /// constant), so the quad is split at the parameters where the UV meets the inset bounds and
    /// each cell's vertices carry the clamped UV: linear interpolation then reproduces the clamp.
    fn quad_clip_uv(
        &mut self,
        dst: [f32; 4],
        src: [f32; 4],
        transpose: bool,
        color: [f32; 4],
        half: [f32; 2],
    ) {
        let flip = [src[2] < 0.0, src[3] < 0.0];
        let size = [src[2].abs(), src[3].abs()];
        let lo = [src[0] + half[0], src[1] + half[1]];
        let hi = [src[0] + size[0] - half[0], src[1] + size[1] - half[1]];
        // Breakpoints of the quad parameter along each base axis: base axis a drives UV component
        // `c = a` (or the other one when transposed).
        let breaks = |a: usize| -> Vec<f32> {
            let c = if transpose { 1 - a } else { a };
            let mut v = vec![0.0f32];
            if size[c] > 0.0 && size[c] > 2.0 * half[c] {
                v.push(half[c] / size[c]);
                v.push(1.0 - half[c] / size[c]);
            }
            v.push(1.0);
            v.dedup();
            v
        };
        let (bx, by) = (breaks(0), breaks(1));
        let uv_at = |b: [f32; 2]| -> [f32; 2] {
            let t = if transpose { [b[1], b[0]] } else { b };
            let u = [src[0] + size[0] * t[0], src[1] + size[1] * t[1]];
            [
                u[0].clamp(lo[0], hi[0].max(lo[0])),
                u[1].clamp(lo[1], hi[1].max(lo[1])),
            ]
        };
        let pos_at = |b: [f32; 2]| -> [f32; 2] {
            let fx = if flip[0] { 1.0 - b[0] } else { b[0] };
            let fy = if flip[1] { 1.0 - b[1] } else { b[1] };
            [dst[0] + dst[2].abs() * fx, dst[1] + dst[3].abs() * fy]
        };
        for i in 0..bx.len() - 1 {
            for j in 0..by.len() - 1 {
                let first = self.out.verts.len() as u32;
                for b in [
                    [bx[i], by[j]],
                    [bx[i], by[j + 1]],
                    [bx[i + 1], by[j + 1]],
                    [bx[i + 1], by[j]],
                ] {
                    self.vertex(pos_at(b), uv_at(b), color);
                }
                self.out.idx.extend_from_slice(&[
                    first,
                    first + 1,
                    first + 2,
                    first + 3,
                    first,
                    first + 2,
                ]);
            }
        }
    }

    /// A Godot `CommandPrimitive` of 4 points: triangles (0,1,2) and (0,2,3)
    /// (rasterizer_canvas_gles3.cpp TYPE_PRIMITIVE); 3 points: one triangle.
    fn primitive(&mut self, points: &[[f32; 2]], colors: &[[f32; 4]], uvs: &[[f32; 2]]) {
        let first = self.out.verts.len() as u32;
        for (i, p) in points.iter().enumerate() {
            let c = colors.get(i).copied().unwrap_or([1.0; 4]);
            let uv = uvs.get(i).copied().unwrap_or([0.0, 0.0]);
            self.vertex(*p, uv, c);
        }
        match points.len() {
            3 => self
                .out
                .idx
                .extend_from_slice(&[first, first + 1, first + 2]),
            4 => self.out.idx.extend_from_slice(&[
                first,
                first + 1,
                first + 2,
                first,
                first + 2,
                first + 3,
            ]),
            _ => {}
        }
        self.add_rect_bounds(geom::points_box(points.iter().copied()));
    }

    /// A GLES3 polygon buffer (`request_polygon`, rasterizer_canvas_gles3.cpp:2427-2575): colours per
    /// vertex only when there is exactly one per point, else one colour for all (`colors[0]` when
    /// there is exactly one, white otherwise); uvs only when there is one per point, else (0, 0).
    /// `indices` (already cut to the drawn count) or, when empty, every vertex in order; `strip`
    /// draws a triangle strip.
    fn polygon(
        &mut self,
        points: &[[f32; 2]],
        colors: &[[f32; 4]],
        uvs: &[[f32; 2]],
        indices: &[u32],
        strip: bool,
    ) {
        let first = self.out.verts.len() as u32;
        let n = points.len();
        let per_vertex = colors.len() == n;
        let uniform = if colors.len() == 1 {
            colors[0]
        } else {
            [1.0; 4]
        };
        let with_uv = uvs.len() == n;
        // G7o4: one reservation per polygon (a mesh surface is thousands of vertices).
        self.out.verts.reserve(n);
        for (i, p) in points.iter().enumerate() {
            let c = if per_vertex { colors[i] } else { uniform };
            let uv = if with_uv { uvs[i] } else { [0.0, 0.0] };
            self.vertex(*p, uv, c);
        }
        // The draw order: `indices`, or (none given) every vertex in order (G7o3: not copied).
        let sequential = indices.is_empty();
        let len = if sequential { n } else { indices.len() };
        let order = |k: usize| if sequential { k as u32 } else { indices[k] };
        self.out
            .idx
            .reserve(if strip { 3 * len.saturating_sub(2) } else { len });
        if strip {
            for k in 2..len {
                // GL triangle-strip winding does not affect coverage (no culling).
                self.out.idx.extend_from_slice(&[
                    first + order(k - 2),
                    first + order(k - 1),
                    first + order(k),
                ]);
            }
        } else {
            let whole = len / 3 * 3;
            if sequential {
                self.out.idx.extend((0..whole as u32).map(|i| first + i));
            } else {
                self.out
                    .idx
                    .extend(indices[..whole].iter().map(|i| first + i));
            }
        }
    }

    /// Feather quads, each one 4-point `CommandPrimitive` of its own (colours through binary16,
    /// [`geom::godot_half4`]), each counted in `Item::get_rect` as the engine's separate command.
    fn feathers(&mut self, quads: &[geom::Feather]) {
        for (points, colors) in quads {
            let c = colors.map(geom::godot_half4);
            self.primitive(points, &c, &[]);
        }
    }

    /// A GL point of size 1 (`RS::PRIMITIVE_POINTS`): the unit square centred on it.
    fn point_quad(&mut self, p: [f32; 2], c: [f32; 4]) {
        let first = self.out.verts.len() as u32;
        for d in [[-0.5f32, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]] {
            self.vertex([p[0] + d[0], p[1] + d[1]], [0.0, 0.0], c);
        }
        self.out
            .idx
            .extend_from_slice(&[first, first + 1, first + 2, first, first + 2, first + 3]);
    }

    /// A width-1 quad along a hairline segment: GL line rasterization stands in as the 1-px quad
    /// centred on the segment (Q5; G7t measured it inside gate 5b's thin-line band).
    fn hairline(&mut self, a: [f32; 2], b: [f32; 2], ca: [f32; 4], cb: [f32; 4]) {
        let d = geom::normalized([b[0] - a[0], b[1] - a[1]]);
        let t = [d[1] * 0.5, -d[0] * 0.5];
        let first = self.out.verts.len() as u32;
        self.vertex([a[0] + t[0], a[1] + t[1]], [0.0, 0.0], ca);
        self.vertex([a[0] - t[0], a[1] - t[1]], [0.0, 0.0], ca);
        self.vertex([b[0] - t[0], b[1] - t[1]], [0.0, 0.0], cb);
        self.vertex([b[0] + t[0], b[1] + t[1]], [0.0, 0.0], cb);
        self.out
            .idx
            .extend_from_slice(&[first, first + 1, first + 2, first, first + 2, first + 3]);
    }

    fn uv_scale(&mut self, tex: Option<Id>) -> Option<(TexRef, [f32; 2])> {
        match tex {
            None => Some((TexRef::White, [1.0, 1.0])),
            Some(id) => {
                if !self.out.texture_deps.contains(&id) {
                    self.out.texture_deps.push(id);
                }
                let draw = match self.tex_memo {
                    Some((t, d)) if t == id => d,
                    _ => {
                        let d = self.tables.texture_draw(id);
                        self.tex_memo = Some((id, d));
                        d
                    }
                };
                let (w, h, mip) = match draw {
                    TexDraw::Sized(w, h, mip) => (w, h, mip),
                    TexDraw::White => return Some((TexRef::White, [1.0, 1.0])),
                    TexDraw::Skip => return None,
                };
                if mip {
                    self.out.note(Shortcut::MipmapsLevel0);
                }
                // _prepare_canvas_texture: texpixel_size = 1.0 / float(size).
                Some((TexRef::Wire(id), [1.0 / w as f32, 1.0 / h as f32]))
            }
        }
    }
}

fn mul4(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]]
}

/// G7o3: the span's points (or uvs) in place, no copy.
fn pairs(c: &Commands, span: crate::state::Span) -> &[[f32; 2]] {
    c.pairs(span).as_chunks::<2>().0
}

/// G7o3: the span's colours in place, no copy.
fn quads(c: &Commands, span: crate::state::Span) -> &[[f32; 4]] {
    c.quads(span).as_chunks::<4>().0
}

#[derive(Clone, Copy)]
struct Region {
    tex: Option<Id>,
    transpose: bool,
    /// `CANVAS_RECT_CLIP_UV`: UVs clamped half a texel inside the source rect.
    clip_uv: bool,
    rect: [f32; 4],
    src: [f32; 4],
    modulate: [f32; 4],
    /// `[px_range, outline]` of an MSDF rect (G7tm), else `None`.
    msdf: Option<[f32; 2]>,
}

/// `canvas_item_add_texture_rect_region` (renderer_canvas_cull.cpp:1610-1649) and its GLES3 rect
/// (TYPE_RECT with `CANVAS_RECT_REGION`): flips from negative sizes of either rect (XOR), the
/// source scaled by `texpixel_size`, transpose swapping the destination size.
fn region(b: &mut Builder<'_>, r: Region) {
    let Some((texref, px)) = b.uv_scale(r.tex) else {
        // Item::get_rect still counts the command's rect (the clip rect does not depend on the
        // texture): sizes made positive, transposed.
        let mut dst = [r.rect[0], r.rect[1], r.rect[2].abs(), r.rect[3].abs()];
        if r.transpose {
            dst.swap(2, 3);
        }
        b.add_rect_bounds(dst);
        b.out.note(Shortcut::TextureUnavailableSkipped);
        return;
    };
    let mut dst = r.rect;
    let mut s = r.src;
    let mut flip_h = false;
    let mut flip_v = false;
    if dst[2] < 0.0 {
        flip_h = true;
        dst[2] = -dst[2];
    }
    if s[2] < 0.0 {
        flip_h = !flip_h;
        s[2] = -s[2];
    }
    if dst[3] < 0.0 {
        flip_v = true;
        dst[3] = -dst[3];
    }
    if s[3] < 0.0 {
        flip_v = !flip_v;
        s[3] = -s[3];
    }
    if r.transpose {
        dst.swap(2, 3);
    }
    b.add_rect_bounds(dst);
    let d = b.begin(texref, false);
    // An MSDF rect keeps the flag with Godot's default white texture too: the GLES3 renderer
    // sets INSTANCE_FLAGS_USE_MSDF whatever the texture (rasterizer_canvas_gles3.cpp:999).
    b.out.draws[d].msdf = r.msdf;
    if texref == TexRef::White {
        b.quad(dst, [0.0, 0.0, 1.0, 1.0], false, r.modulate);
    } else {
        let mut src = [s[0] * px[0], s[1] * px[1], s[2] * px[0], s[3] * px[1]];
        if flip_h {
            src[2] = -src[2];
        }
        if flip_v {
            src[3] = -src[3];
        }
        if r.clip_uv {
            b.quad_clip_uv(
                dst,
                src,
                r.transpose,
                r.modulate,
                [px[0] * 0.5, px[1] * 0.5],
            );
        } else {
            b.quad(dst, src, r.transpose, r.modulate);
        }
    }
    b.end(d);
}

/// One nine-patch axis region: `(start, end, frac_start, frac_end, is_middle)`.
type NpRegion = (f32, f32, f32, f32, bool);

/// The regions of one nine-patch axis as `map_ninepatch_axis` maps it (canvas.glsl:521-558):
/// `(start, end, frac_start, frac_end, is_middle)` in draw pixels and source fractions, empty
/// regions omitted. `pixel < margin_begin` is the begin region, `pixel >= draw_size - margin_end`
/// the end region, the rest the middle. The map is linear inside each region except where a tile
/// mode wraps, so a `tile` or `tile_fit` middle is cut into one region per period (the period
/// `tex_size - margins` texels for `tile`; `src_area / scale` pixels for `tile_fit`), each with the
/// unwrapped linear map of its own period. `None` when the tiling needs more than `max_tiles`
/// regions (the caller then draws `stretch` and counts it).
fn ninepatch_regions(
    draw_size: f32,
    tex_pixel_size: f32,
    margin_begin: f32,
    margin_end: f32,
    axis: Axis,
    max_tiles: usize,
) -> Option<Vec<NpRegion>> {
    let tex_size = 1.0 / tex_pixel_size;
    let b1 = margin_begin.min(draw_size);
    let b2 = b1.max(draw_size - margin_end);
    let left = |p: f32| p * tex_pixel_size;
    let right = |p: f32| (tex_size - (draw_size - p)) * tex_pixel_size;
    let mut out = Vec::with_capacity(3);
    if b1 > 0.0 {
        out.push((0.0, b1, left(0.0), left(b1), false));
    }
    if b2 > b1 {
        let src_area = draw_size - margin_begin - margin_end;
        let dst_area = tex_size - margin_begin - margin_end;
        match axis {
            Axis::Stretch => {
                let middle = |p: f32| {
                    let ratio = (p - margin_begin) / src_area;
                    (margin_begin + ratio * dst_area) * tex_pixel_size
                };
                out.push((b1, b2, middle(b1), middle(b2), true));
            }
            Axis::Tile => {
                // ofs = mod(pixel - margin_begin, dst_area): period `dst_area` pixels.
                if dst_area > 0.0 {
                    let n = ((b2 - b1) / dst_area).ceil().max(1.0) as usize;
                    if n > max_tiles {
                        return None;
                    }
                    for k in 0..n {
                        let base = margin_begin + k as f32 * dst_area;
                        let s = base.max(b1);
                        let e = (base + dst_area).min(b2);
                        if e <= s {
                            continue;
                        }
                        let map = |p: f32| (margin_begin + (p - base)) * tex_pixel_size;
                        out.push((s, e, map(s), map(e), true));
                    }
                }
            }
            Axis::TileFit => {
                let scale = (src_area / dst_area.max(0.000_000_1) + 0.5)
                    .floor()
                    .max(1.0);
                if scale as usize > max_tiles {
                    return None;
                }
                let n = scale as usize;
                for k in 0..n {
                    // ratio = mod((pixel - margin_begin) / src_area * scale, 1): tile k covers
                    // ratio·scale in [k, k + 1).
                    let s = (margin_begin + k as f32 * src_area / scale).max(b1);
                    let e = if k + 1 == n {
                        b2
                    } else {
                        (margin_begin + (k + 1) as f32 * src_area / scale).min(b2)
                    };
                    if e <= s {
                        continue;
                    }
                    let map = |p: f32| {
                        let r = (p - margin_begin) / src_area * scale - k as f32;
                        (margin_begin + r * dst_area) * tex_pixel_size
                    };
                    out.push((s, e, map(s), map(e), true));
                }
            }
        }
    }
    if draw_size > b2 {
        out.push((b2, draw_size, right(b2), right(draw_size), false));
    }
    Some(out)
}

/// Lower one item's commands.
pub fn lower(commands: &Commands, tables: &dyn Tables) -> Lowered {
    lower_with(commands, tables, LowerSabotage::default())
}

/// The triangle fan of `polygon-winding` (G7t's lowering sabotage): the reversed contour fanned
/// from its first point.
fn reversed_fan(n: usize) -> Vec<u32> {
    let order: Vec<u32> = (0..n as u32).rev().collect();
    let mut out = Vec::with_capacity(3 * n.saturating_sub(2));
    for k in 1..n.saturating_sub(1) {
        out.extend_from_slice(&[order[0], order[k], order[k + 1]]);
    }
    out
}

/// [`lower`] under the lowering sabotages.
pub fn lower_with(commands: &Commands, tables: &dyn Tables, sab: LowerSabotage) -> Lowered {
    lower_reusing(commands, tables, sab, Lowered::default())
}

/// [`lower_with`] into `spare`'s buffers (G7o3: a re-lowering reuses the lowering it replaces, so
/// it allocates only when it outgrows it). The result does not depend on `spare`'s contents.
pub fn lower_reusing(
    commands: &Commands,
    tables: &dyn Tables,
    sab: LowerSabotage,
    mut spare: Lowered,
) -> Lowered {
    spare.verts.clear();
    spare.idx.clear();
    spare.draws.clear();
    spare.rect = [0.0; 4];
    spare.shortcuts.clear();
    spare.texture_deps.clear();
    spare.mesh_deps.clear();
    let mut b = Builder {
        out: spare,
        xf: None,
        ignoring: false,
        rect: None,
        tables,
        tex_memo: None,
    };
    for cmd in &commands.list {
        match cmd {
            Command::SetTransform { transform } => {
                // TYPE_TRANSFORM replaces (never composes) the draw transform for later commands.
                if !sab.ignore_set_transform {
                    b.xf = Some(*transform);
                }
            }
            Command::ClipIgnore { ignore } => {
                if !sab.ignore_clip_ignore {
                    b.ignoring = *ignore
                }
            }
            Command::Unsupported { .. } => b.out.note(Shortcut::UnsupportedCommand),
            Command::Rect { aa, rect, color } => {
                // TYPE_RECT untextured: dst normalized to a positive size, src (0,0,1,1).
                let mut dst = *rect;
                if dst[2] < 0.0 {
                    dst[0] += dst[2];
                    dst[2] = -dst[2];
                }
                if dst[3] < 0.0 {
                    dst[1] += dst[3];
                    dst[3] = -dst[3];
                }
                let d = b.begin(TexRef::White, false);
                b.quad(dst, [0.0, 0.0, 1.0, 1.0], false, *color);
                b.add_rect_bounds(dst);
                if *aa {
                    // canvas_item_add_rect's eight feather primitives, from the rect as given.
                    b.feathers(&geom::rect_feathers(*rect, *color));
                }
                b.end(d);
            }
            Command::TextureRect {
                tex,
                tile,
                transpose,
                rect,
                modulate,
            } => {
                let Some((texref, px)) = b.uv_scale(*tex) else {
                    let mut r = [rect[0], rect[1], rect[2].abs(), rect[3].abs()];
                    if *transpose {
                        r.swap(2, 3);
                    }
                    b.add_rect_bounds(r);
                    b.out.note(Shortcut::TextureUnavailableSkipped);
                    continue;
                };
                // canvas_item_add_texture_rect (renderer_canvas_cull.cpp:1513-1542): flips from
                // negative sizes, tile = a region of the rect's own size with repeat forced,
                // transpose swaps the rect size.
                let mut r = *rect;
                let flip_h = r[2] < 0.0;
                let flip_v = r[3] < 0.0;
                r[2] = r[2].abs();
                r[3] = r[3].abs();
                if *transpose {
                    r.swap(2, 3);
                }
                b.add_rect_bounds(r);
                let d = b.begin(texref, *tile);
                if texref == TexRef::White {
                    b.quad(r, [0.0, 0.0, 1.0, 1.0], false, *modulate);
                } else {
                    let mut src = if *tile {
                        [0.0, 0.0, rect[2].abs() * px[0], rect[3].abs() * px[1]]
                    } else {
                        [0.0, 0.0, 1.0, 1.0]
                    };
                    if flip_h {
                        src[2] = -src[2];
                    }
                    if flip_v {
                        src[3] = -src[3];
                    }
                    b.quad(r, src, *transpose, *modulate);
                }
                b.end(d);
            }
            Command::TextureRectRegion {
                tex,
                transpose,
                clip_uv,
                rect,
                src,
                modulate,
            } => {
                region(
                    &mut b,
                    Region {
                        tex: *tex,
                        transpose: *transpose,
                        clip_uv: *clip_uv,
                        rect: *rect,
                        src: *src,
                        modulate: *modulate,
                        msdf: None,
                    },
                );
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
                    // The native `drop-msdf` sabotage skips it. Item::get_rect still counts the
                    // command's rect, and the texture stays a dependency (it is named, so it is
                    // resident: the native census).
                    b.add_rect_bounds([rect[0], rect[1], rect[2].abs(), rect[3].abs()]);
                    if let Some(id) = tex {
                        if !b.out.texture_deps.contains(id) {
                            b.out.texture_deps.push(*id);
                        }
                    }
                    continue;
                }
                // canvas_item_add_msdf_texture_rect_region (renderer_canvas_cull.cpp:1544-1576):
                // a TYPE_RECT with CANVAS_RECT_REGION | CANVAS_RECT_MSDF, the flips of a region,
                // no transpose and no clip-uv, `outline = (float)outline_size / scale / 4.0` and
                // `px_range` as sent. The f32 quotient by `scale` is rounded once; the quotient
                // by 4.0 is in double and exact, so it is the f32 quotient too.
                let outline_f = (*outline as f32) / *scale / 4.0;
                let px = if sab.msdf_px_range {
                    *px_range * 0.5
                } else {
                    *px_range
                };
                region(
                    &mut b,
                    Region {
                        tex: *tex,
                        transpose: false,
                        clip_uv: false,
                        rect: *rect,
                        src: *src,
                        modulate: *modulate,
                        msdf: Some([px, outline_f]),
                    },
                );
            }
            Command::NinePatch {
                tex,
                rect,
                source,
                margins,
                x_axis,
                y_axis,
                draw_center,
                modulate,
            } => {
                let Some((texref, px)) = b.uv_scale(*tex) else {
                    b.add_rect_bounds(*rect);
                    b.out.note(Shortcut::TextureUnavailableSkipped);
                    continue;
                };
                let (x_axis, y_axis) = if sab.ignore_nine_patch_axis {
                    (Axis::Stretch, Axis::Stretch)
                } else {
                    (*x_axis, *y_axis)
                };
                b.add_rect_bounds(*rect);
                // TYPE_NINEPATCH: src normalized by texpixel_size and the mapping's pixel size
                // 1/source.size when a source is given, else the whole texture (white: 1×1).
                let (src, tps) = if texref == TexRef::White {
                    ([0.0, 0.0, 1.0, 1.0], [1.0, 1.0])
                } else if *source != [0.0; 4] {
                    (
                        [
                            source[0] * px[0],
                            source[1] * px[1],
                            source[2] * px[0],
                            source[3] * px[1],
                        ],
                        [1.0 / source[2], 1.0 / source[3]],
                    )
                } else {
                    ([0.0, 0.0, 1.0, 1.0], px)
                };
                let w = rect[2].abs();
                let h = rect[3].abs();
                let axes = |axis_x: Axis, axis_y: Axis, cap: usize| {
                    let xs = ninepatch_regions(w, tps[0], margins[0], margins[2], axis_x, cap)?;
                    let ys = ninepatch_regions(h, tps[1], margins[1], margins[3], axis_y, cap)?;
                    (xs.len() * ys.len() <= MAX_NINE_PATCH_CELLS).then_some((xs, ys))
                };
                let (xs, ys) = match axes(x_axis, y_axis, MAX_NINE_PATCH_CELLS) {
                    Some(r) => r,
                    None => {
                        b.out.note(Shortcut::NinePatchTileAsStretch);
                        axes(Axis::Stretch, Axis::Stretch, 1).unwrap_or_default()
                    }
                };
                let d = b.begin(texref, false);
                for &(y0, y1, v0, v1, ym) in &ys {
                    for &(x0, x1, u0, u1, xm) in &xs {
                        if xm && ym && !*draw_center {
                            continue;
                        }
                        let first = b.out.verts.len() as u32;
                        // Corners in canvas.glsl's vertex_base order: (0,0) (0,1) (1,1) (1,0).
                        for (cx, cy, u, v) in [
                            (x0, y0, u0, v0),
                            (x0, y1, u0, v1),
                            (x1, y1, u1, v1),
                            (x1, y0, u1, v0),
                        ] {
                            let pos = [rect[0] + cx, rect[1] + cy];
                            let uv = [u * src[2] + src[0], v * src[3] + src[1]];
                            b.vertex(pos, uv, *modulate);
                        }
                        b.out.idx.extend_from_slice(&[
                            first,
                            first + 1,
                            first + 2,
                            first + 3,
                            first,
                            first + 2,
                        ]);
                    }
                }
                b.end(d);
            }
            Command::Line {
                aa,
                from,
                to,
                colour,
                width,
            } => {
                // canvas_item_add_line: one CommandPrimitive (colours through binary16), then
                // eight feather primitives when antialiased.
                let (pts, n) = geom::line_points(*from, *to, *width);
                let c = geom::godot_half4(*colour);
                let d = b.begin(TexRef::White, false);
                if n == 4 {
                    b.primitive(&pts, &[c; 4], &[]);
                } else {
                    b.out.note(Shortcut::HairlineAsQuads);
                    b.hairline(*from, *to, c, c);
                    b.add_rect_bounds(geom::points_box([*from, *to]));
                }
                if *aa {
                    b.feathers(&geom::line_feathers(*from, *to, *width, *colour));
                }
                b.end(d);
            }
            Command::Polyline {
                aa,
                width,
                points,
                colors,
            } => {
                let pts = pairs(commands, *points);
                let cols = quads(commands, *colors);
                if pts.len() < 2 {
                    continue;
                }
                let d = b.begin(TexRef::White, false);
                if *width >= 0.0 && *aa {
                    // The middle strip with its open-end feathers, then the left and right
                    // feather strips (three CommandPolygons, in allocation order).
                    for (strip, strip_colors) in geom::polyline_aa(&pts, &cols, *width) {
                        b.polygon(&strip, &strip_colors, &[], &[], true);
                        b.add_rect_bounds(geom::points_box(strip.iter().copied()));
                    }
                } else if *width >= 0.0 {
                    let (strip, strip_colors) = geom::polyline_strip(&pts, &cols, *width);
                    b.polygon(&strip, &strip_colors, &[], &[], true);
                    b.add_rect_bounds(geom::points_box(strip.iter().copied()));
                } else {
                    // RS::PRIMITIVE_LINE_STRIP: one colour, one per point, or held to the last.
                    b.out.note(Shortcut::HairlineAsQuads);
                    let held: Vec<[f32; 4]> = (0..pts.len())
                        .map(|i| {
                            if cols.len() == 1 {
                                cols[0]
                            } else {
                                cols.get(i.min(cols.len().saturating_sub(1)))
                                    .copied()
                                    .unwrap_or([1.0; 4])
                            }
                        })
                        .collect();
                    for i in 1..pts.len() {
                        b.hairline(pts[i - 1], pts[i], held[i - 1], held[i]);
                    }
                    b.add_rect_bounds(geom::points_box(pts.iter().copied()));
                }
                b.end(d);
            }
            Command::Multiline {
                aa,
                width,
                points,
                colors,
            } => {
                let pts = pairs(commands, *points);
                let cols = quads(commands, *colors);
                let d = b.begin(TexRef::White, false);
                for seg in 0..pts.len() / 2 {
                    let c = if cols.len() == 1 {
                        cols[0]
                    } else {
                        cols.get(seg).copied().unwrap_or([1.0; 4])
                    };
                    let (from, to) = (pts[2 * seg], pts[2 * seg + 1]);
                    if *width >= 0.0 {
                        // canvas_item_add_multiline with width >= 0 is one add_line per segment.
                        let (q, _) = geom::line_points(from, to, *width);
                        b.primitive(&q, &[geom::godot_half4(c); 4], &[]);
                        if *aa {
                            b.feathers(&geom::line_feathers(from, to, *width, c));
                        }
                    } else {
                        b.out.note(Shortcut::HairlineAsQuads);
                        b.hairline(from, to, c, c);
                    }
                }
                if *width < 0.0 {
                    b.add_rect_bounds(geom::points_box(pts.iter().copied()));
                }
                b.end(d);
            }
            Command::Circle {
                aa,
                position,
                radius,
                colour,
            } => {
                let (pts, idx) = geom::circle(*position, *radius);
                let d = b.begin(TexRef::White, false);
                b.polygon(&pts, &[*colour], &[], &idx, false);
                b.add_rect_bounds(geom::points_box(pts.iter().copied()));
                if *aa {
                    // The feather: a triangle strip CommandPolygon with per-vertex colours.
                    let (fp, fc) = geom::circle_feather(*position, *radius, *colour);
                    b.polygon(&fp, &fc, &[], &[], true);
                    b.add_rect_bounds(geom::points_box(fp.iter().copied()));
                }
                b.end(d);
            }
            Command::Primitive {
                tex,
                points,
                colors,
                uvs,
            } => {
                let pts = pairs(commands, *points);
                if pts.is_empty() || pts.len() > 4 {
                    continue;
                }
                let Some((texref, _)) = b.uv_scale(*tex) else {
                    b.add_rect_bounds(geom::points_box(pts.iter().copied()));
                    b.out.note(Shortcut::TextureUnavailableSkipped);
                    continue;
                };
                let cols = quads(commands, *colors);
                let uv = pairs(commands, *uvs);
                // canvas_item_add_primitive: a missing colour is colors[0] (white when none);
                // TYPE_PRIMITIVE carries it as binary16.
                let held: Vec<[f32; 4]> = (0..pts.len())
                    .map(|i| {
                        geom::godot_half4(cols.get(i).or(cols.first()).copied().unwrap_or([1.0; 4]))
                    })
                    .collect();
                let held_uv: Vec<[f32; 2]> = (0..pts.len())
                    .map(|i| uv.get(i).copied().unwrap_or([0.0, 0.0]))
                    .collect();
                let d = b.begin(texref, false);
                if pts.len() >= 3 {
                    b.primitive(&pts, &held, &held_uv);
                } else if pts.len() == 2 {
                    b.out.note(Shortcut::HairlineAsQuads);
                    b.hairline(pts[0], pts[1], held[0], held[1]);
                    b.add_rect_bounds(geom::points_box(pts.iter().copied()));
                } else {
                    b.out.note(Shortcut::HairlineAsQuads);
                    b.point_quad(pts[0], held[0]);
                    b.add_rect_bounds(geom::points_box(pts.iter().copied()));
                }
                b.end(d);
            }
            Command::Polygon {
                tex,
                points,
                colors,
                uvs,
            } => {
                let pts = pairs(commands, *points);
                // canvas_item_add_polygon: Geometry2D::triangulate_polygon; a failure adds nothing.
                let Some(mut idx) = geom::triangulate_polygon(&pts) else {
                    continue;
                };
                if sab.polygon_winding {
                    idx = reversed_fan(pts.len());
                }
                let Some((texref, _)) = b.uv_scale(*tex) else {
                    b.add_rect_bounds(geom::points_box(pts.iter().copied()));
                    b.out.note(Shortcut::TextureUnavailableSkipped);
                    continue;
                };
                let d = b.begin(texref, false);
                b.polygon(
                    &pts,
                    &quads(commands, *colors),
                    &pairs(commands, *uvs),
                    &idx,
                    false,
                );
                b.end(d);
                b.add_rect_bounds(geom::points_box(pts.iter().copied()));
            }
            Command::TriangleArray {
                tex,
                count,
                points,
                colors,
                uvs,
                indices,
            } => {
                let pts = pairs(commands, *points);
                if pts.is_empty() {
                    continue;
                }
                let ints = commands.ints(*indices);
                // Polygon::create: count = p_count < 0 ? indices.size : p_count·3, refused (no
                // draw, Rect2() rect) when it exceeds the indices.
                let drawn = if *count < 0 {
                    ints.len()
                } else {
                    (*count as usize).saturating_mul(3)
                };
                if drawn > ints.len() {
                    b.add_rect_bounds([0.0; 4]);
                    continue;
                }
                let Some((texref, _)) = b.uv_scale(*tex) else {
                    b.add_rect_bounds(geom::points_box(pts.iter().copied()));
                    b.out.note(Shortcut::TextureUnavailableSkipped);
                    continue;
                };
                let idx: Vec<u32> = ints[..drawn].iter().map(|&i| i.max(0) as u32).collect();
                let d = b.begin(texref, false);
                b.polygon(
                    &pts,
                    &quads(commands, *colors),
                    &pairs(commands, *uvs),
                    &idx,
                    false,
                );
                b.end(d);
                b.add_rect_bounds(geom::points_box(pts.iter().copied()));
            }
            Command::Mesh {
                mesh,
                tex,
                transform,
                modulate,
            } => {
                if !b.out.mesh_deps.contains(mesh) {
                    b.out.mesh_deps.push(*mesh);
                }
                let Some((surfaces, aabb)) = tables.mesh(*mesh) else {
                    b.out.note(Shortcut::MeshUnavailableSkipped);
                    continue;
                };
                let Some((texref, _)) = b.uv_scale(*tex) else {
                    b.out.note(Shortcut::TextureUnavailableSkipped);
                    continue;
                };
                // get_rect: mesh_get_aabb through the draw transform only (not the command's).
                b.add_rect_bounds(aabb);
                let saved = b.xf;
                b.xf = Some(match &saved {
                    Some(d) => geom::mul(d, transform),
                    None => *transform,
                });
                let d = b.begin(texref, false);
                let mut cols_buf: Vec<[f32; 4]> = Vec::new();
                for s in surfaces {
                    let n = s.positions.len();
                    // GLES3 TYPE_MESH: modulation = base_color · modulate times the colour attribute.
                    // G7o3: without a colour attribute, one colour (what `polygon` makes of one
                    // per vertex or of a single one alike), and the arrays borrowed, not copied.
                    let cols: &[[f32; 4]] = match &s.colors {
                        Some(c) => {
                            cols_buf.clear();
                            cols_buf.extend(c.iter().map(|c| mul4(*c, *modulate)));
                            &cols_buf
                        }
                        None => std::slice::from_ref(modulate),
                    };
                    let uvs: &[[f32; 2]] = s.uvs.as_deref().unwrap_or(&[]);
                    let idx: &[u32] = s.indices.as_deref().unwrap_or(&[]);
                    match s.primitive {
                        Primitive::Triangles => b.polygon(&s.positions, cols, uvs, idx, false),
                        Primitive::TriangleStrip => b.polygon(&s.positions, cols, uvs, idx, true),
                        // GL_LINES, GL_LINE_STRIP and GL_POINTS (size 1): the hairline quads.
                        Primitive::Lines | Primitive::LineStrip | Primitive::Points => {
                            b.out.note(Shortcut::HairlineAsQuads);
                            let order: Vec<usize> = if idx.is_empty() {
                                (0..n).collect()
                            } else {
                                idx.iter().map(|&i| i as usize).filter(|&i| i < n).collect()
                            };
                            let at = |i: usize| {
                                let c = if s.colors.is_some() {
                                    cols[i]
                                } else {
                                    *modulate
                                };
                                (s.positions[i], c)
                            };
                            match s.primitive {
                                Primitive::Points => {
                                    for &i in &order {
                                        let (p, c) = at(i);
                                        b.point_quad(p, c);
                                    }
                                }
                                Primitive::Lines => {
                                    for pair in order.chunks_exact(2) {
                                        let ((p0, c0), (p1, c1)) = (at(pair[0]), at(pair[1]));
                                        b.hairline(p0, p1, c0, c1);
                                    }
                                }
                                _ => {
                                    for w in order.windows(2) {
                                        let ((p0, c0), (p1, c1)) = (at(w[0]), at(w[1]));
                                        b.hairline(p0, p1, c0, c1);
                                    }
                                }
                            }
                        }
                    }
                }
                b.end(d);
                b.xf = saved;
            }
        }
    }
    b.out.rect = b.rect.unwrap_or([0.0; 4]);
    b.out
}
