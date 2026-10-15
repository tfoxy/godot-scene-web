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
}

/// The slice's typed approximations and skips (G7x "Scope": every shortcut is listed). Each
/// lowering that takes one counts it, so evidence can say where and how often.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
pub enum Shortcut {
    /// Antialiased rect/line/polyline/circle: the base geometry is drawn, the feather fringe is not.
    AaFeatherOmitted,
    /// width < 0 lines and polylines: 1-px quads, not GL line rasterization (`gsw-hairline`, G7t).
    HairlineAsQuads,
    /// `add_texture_rect_region` with `clip_uv`: the UV clamp is not applied.
    ClipUvIgnored,
    /// Nine-patch `tile`/`tile_fit` axes drawn as `stretch`.
    NinePatchTileAsStretch,
    /// `add_msdf_texture_rect_region`: drawn as a plain texture region (`gsw-msdf`, G7t).
    MsdfAsPlain,
    /// A mesh surface whose primitive is not triangles/triangle strip: not drawn (typed).
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
            Shortcut::ClipUvIgnored => "slice-clip-uv-ignored",
            Shortcut::NinePatchTileAsStretch => "slice-ninepatch-tile-as-stretch",
            Shortcut::MsdfAsPlain => "slice-msdf-as-plain",
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

/// What the lowering may ask of the texture and mesh tables.
pub trait Tables {
    /// The drawable size of a texture-table id (an `ok` image, or a canvas texture's `ok` image
    /// diffuse), with whether it has mipmaps; `None` when it cannot be drawn.
    fn texture_size(&self, id: Id) -> Option<(u32, u32, bool)>;
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
        for (i, p) in points.iter().enumerate() {
            let c = if per_vertex { colors[i] } else { uniform };
            let uv = if with_uv { uvs[i] } else { [0.0, 0.0] };
            self.vertex(*p, uv, c);
        }
        let order: Vec<u32> = if indices.is_empty() {
            (0..n as u32).collect()
        } else {
            indices.to_vec()
        };
        if strip {
            for k in 2..order.len() {
                // GL triangle-strip winding does not affect coverage (no culling).
                self.out.idx.extend_from_slice(&[
                    first + order[k - 2],
                    first + order[k - 1],
                    first + order[k],
                ]);
            }
        } else {
            let whole = order.len() / 3 * 3;
            self.out
                .idx
                .extend(order[..whole].iter().map(|i| first + i));
        }
    }

    /// A width-1 quad along a hairline segment (Q5: hairlines are 1-px quads, typed `gsw-hairline`).
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
                let (w, h, mip) = self.tables.texture_size(id)?;
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

fn pairs(c: &Commands, span: crate::state::Span) -> Vec<[f32; 2]> {
    c.pairs(span)
        .chunks_exact(2)
        .map(|p| [p[0], p[1]])
        .collect()
}

fn quads(c: &Commands, span: crate::state::Span) -> Vec<[f32; 4]> {
    c.quads(span)
        .chunks_exact(4)
        .map(|p| [p[0], p[1], p[2], p[3]])
        .collect()
}

#[derive(Clone, Copy)]
struct Region {
    tex: Option<Id>,
    transpose: bool,
    rect: [f32; 4],
    src: [f32; 4],
    modulate: [f32; 4],
}

/// `canvas_item_add_texture_rect_region` (renderer_canvas_cull.cpp:1610-1649) and its GLES3 rect
/// (TYPE_RECT with `CANVAS_RECT_REGION`): flips from negative sizes of either rect (XOR), the
/// source scaled by `texpixel_size`, transpose swapping the destination size.
fn region(b: &mut Builder<'_>, r: Region) {
    let Some((texref, px)) = b.uv_scale(r.tex) else {
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
        b.quad(dst, src, r.transpose, r.modulate);
    }
    b.end(d);
}

/// The three regions of one nine-patch axis in `map_ninepatch_axis`'s `stretch` mode
/// (canvas.glsl): `(start, end, frac_start, frac_end, is_middle)` in draw pixels and source
/// fractions, empty regions omitted. `pixel < margin_begin` is the begin region, `pixel >=
/// draw_size - margin_end` the end region, the rest the middle.
fn ninepatch_regions(
    draw_size: f32,
    tex_pixel_size: f32,
    margin_begin: f32,
    margin_end: f32,
) -> Vec<(f32, f32, f32, f32, bool)> {
    let tex_size = 1.0 / tex_pixel_size;
    let b1 = margin_begin.min(draw_size);
    let b2 = b1.max(draw_size - margin_end);
    let left = |p: f32| p * tex_pixel_size;
    let right = |p: f32| (tex_size - (draw_size - p)) * tex_pixel_size;
    let middle = |p: f32| {
        let ratio = (p - margin_begin) / (draw_size - margin_begin - margin_end);
        (margin_begin + ratio * (tex_size - margin_begin - margin_end)) * tex_pixel_size
    };
    let mut out = Vec::with_capacity(3);
    if b1 > 0.0 {
        out.push((0.0, b1, left(0.0), left(b1), false));
    }
    if b2 > b1 {
        out.push((b1, b2, middle(b1), middle(b2), true));
    }
    if draw_size > b2 {
        out.push((b2, draw_size, right(b2), right(draw_size), false));
    }
    out
}

/// Lower one item's commands.
pub fn lower(commands: &Commands, tables: &dyn Tables) -> Lowered {
    let mut b = Builder {
        out: Lowered::default(),
        xf: None,
        ignoring: false,
        rect: None,
        tables,
    };
    for cmd in &commands.list {
        match cmd {
            Command::SetTransform { transform } => {
                // TYPE_TRANSFORM replaces (never composes) the draw transform for later commands.
                b.xf = Some(*transform);
            }
            Command::ClipIgnore { ignore } => b.ignoring = *ignore,
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
                b.end(d);
                b.add_rect_bounds(dst);
                if *aa {
                    b.out.note(Shortcut::AaFeatherOmitted);
                }
            }
            Command::TextureRect {
                tex,
                tile,
                transpose,
                rect,
                modulate,
            } => {
                let Some((texref, px)) = b.uv_scale(*tex) else {
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
                if *clip_uv {
                    b.out.note(Shortcut::ClipUvIgnored);
                }
                region(
                    &mut b,
                    Region {
                        tex: *tex,
                        transpose: *transpose,
                        rect: *rect,
                        src: *src,
                        modulate: *modulate,
                    },
                );
            }
            Command::MsdfTextureRectRegion {
                tex,
                rect,
                src,
                modulate,
                ..
            } => {
                b.out.note(Shortcut::MsdfAsPlain);
                region(
                    &mut b,
                    Region {
                        tex: *tex,
                        transpose: false,
                        rect: *rect,
                        src: *src,
                        modulate: *modulate,
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
                    b.out.note(Shortcut::TextureUnavailableSkipped);
                    continue;
                };
                if *x_axis != Axis::Stretch || *y_axis != Axis::Stretch {
                    b.out.note(Shortcut::NinePatchTileAsStretch);
                }
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
                let xs = ninepatch_regions(w, tps[0], margins[0], margins[2]);
                let ys = ninepatch_regions(h, tps[1], margins[1], margins[3]);
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
                let (pts, n) = geom::line_points(*from, *to, *width);
                let d = b.begin(TexRef::White, false);
                if n == 4 {
                    b.primitive(&pts, &[*colour; 4], &[]);
                } else {
                    b.out.note(Shortcut::HairlineAsQuads);
                    b.hairline(*from, *to, *colour, *colour);
                    b.add_rect_bounds(geom::points_box([*from, *to]));
                }
                b.end(d);
                if *aa {
                    b.out.note(Shortcut::AaFeatherOmitted);
                }
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
                if *width >= 0.0 {
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
                if *aa {
                    b.out.note(Shortcut::AaFeatherOmitted);
                }
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
                        b.primitive(&q, &[c; 4], &[]);
                    } else {
                        b.out.note(Shortcut::HairlineAsQuads);
                        b.hairline(from, to, c, c);
                    }
                }
                if *width < 0.0 {
                    b.add_rect_bounds(geom::points_box(pts.iter().copied()));
                }
                b.end(d);
                if *aa {
                    b.out.note(Shortcut::AaFeatherOmitted);
                }
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
                b.end(d);
                b.add_rect_bounds(geom::points_box(pts.iter().copied()));
                if *aa {
                    b.out.note(Shortcut::AaFeatherOmitted);
                }
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
                    b.out.note(Shortcut::TextureUnavailableSkipped);
                    continue;
                };
                let cols = quads(commands, *colors);
                let uv = pairs(commands, *uvs);
                // canvas_item_add_primitive: a missing colour is colors[0] (white when none).
                let held: Vec<[f32; 4]> = (0..pts.len())
                    .map(|i| cols.get(i).or(cols.first()).copied().unwrap_or([1.0; 4]))
                    .collect();
                let held_uv: Vec<[f32; 2]> = (0..pts.len())
                    .map(|i| uv.get(i).copied().unwrap_or([0.0, 0.0]))
                    .collect();
                let d = b.begin(texref, false);
                if pts.len() >= 3 {
                    b.primitive(&pts, &held, &held_uv);
                } else {
                    b.out.note(Shortcut::HairlineAsQuads);
                    let last = pts.len() - 1;
                    b.hairline(pts[0], pts[last], held[0], held[last]);
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
                let Some(idx) = geom::triangulate_polygon(&pts) else {
                    continue;
                };
                let Some((texref, _)) = b.uv_scale(*tex) else {
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
                for s in surfaces {
                    let n = s.positions.len();
                    // GLES3 TYPE_MESH: modulation = base_color · modulate times the colour attribute.
                    let cols: Vec<[f32; 4]> = match &s.colors {
                        Some(c) => c.iter().map(|c| mul4(*c, *modulate)).collect(),
                        None => vec![*modulate; n],
                    };
                    let uvs = s.uvs.clone().unwrap_or_default();
                    let idx = s.indices.clone().unwrap_or_default();
                    match s.primitive {
                        Primitive::Triangles => b.polygon(&s.positions, &cols, &uvs, &idx, false),
                        Primitive::TriangleStrip => {
                            b.polygon(&s.positions, &cols, &uvs, &idx, true)
                        }
                        _ => b.out.note(Shortcut::MeshPrimitiveSkipped),
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
