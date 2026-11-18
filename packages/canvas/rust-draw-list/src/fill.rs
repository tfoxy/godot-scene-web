//! Fill accounting: how many pixels one execution of a [`DrawList`] touches, per kind of pass.
//!
//! A diagnostic, never on an executor's path: a caller asks for it (a native replay tool, or a
//! debug export) and pays for one walk over the list's triangles. It models what the canvas-items
//! executor issues for the list, in its order: the target clear, every draw (its triangles after
//! the item transform, and the instance transform of an instanced draw, clipped to its scissor
//! and the target), every [`ScreenOp`] before the draw it names, and the present. Areas are
//! fragment counts (a triangle's clipped area, so overlapping triangles of one draw count twice);
//! a clear, a copy or the present counts its whole region.
//!
//! Beside the areas it counts the target render passes a tile-based GPU sees: every switch from
//! the target to the back buffer (a copy, a clear, a mip chain or an open group's draws) ends the
//! target's pass, and the next target draw starts a new one that must load the target's tiles
//! again. A coarse coverage grid gives the layers per pixel and the fragments a later opaque draw
//! hides. [`signature`] and [`damage`] compare two lists for the area a damage-limited redraw
//! would have to repaint.

use crate::{
    Blend, DrawList, ScreenOpKind, BUILTIN_PROGRAM, DRAW_GROUP_CLIP, DRAW_GROUP_COMPOSITE,
    DRAW_INSTANCED, DRAW_MSDF, DRAW_SCISSOR, DRAW_TO_BACK_BUFFER, DRAW_UNTEXTURED, SCREEN_TEXTURE,
    WHITE_TEXTURE,
};
use std::collections::HashMap;

/// What one pass is, for [`FillReport::px`] and [`FillReport::count`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
    /// The target's clear at the start of the frame.
    Clear = 0,
    /// A draw into the target that writes every fragment opaquely: [`Blend::Disabled`], or a mix
    /// draw of the builtin program whose texture is opaque (or white) and whose vertex colours and
    /// item modulate are opaque.
    Opaque = 1,
    /// Every other draw into the target through the builtin program (blended).
    Blended = 2,
    /// A draw into the target through an item-space program that samples [`SCREEN_TEXTURE`].
    ScreenReader = 3,
    /// A draw into the target through any other item-space program.
    Program = 4,
    /// An open canvas group's draw, into the back buffer ([`DRAW_TO_BACK_BUFFER`]).
    ToBackBuffer = 5,
    /// A group owner's draw through the clip-children or canvas-group program
    /// ([`DRAW_GROUP_CLIP`], [`DRAW_GROUP_COMPOSITE`]).
    GroupComposite = 6,
    /// A [`ScreenOpKind::Copy`]: the region, target to back buffer.
    Copy = 7,
    /// A [`ScreenOpKind::Clear`]: the whole back buffer.
    BackBufferClear = 8,
    /// The gaussian mip chain of a copy or a [`ScreenOpKind::Mipmaps`]: every level below 0 of
    /// the region (about a third of it).
    Mipmaps = 9,
    /// The target's blit (or present draw) to the canvas.
    Present = 10,
}

pub const CLASSES: usize = 11;

impl Class {
    pub const ALL: [Class; CLASSES] = [
        Class::Clear,
        Class::Opaque,
        Class::Blended,
        Class::ScreenReader,
        Class::Program,
        Class::ToBackBuffer,
        Class::GroupComposite,
        Class::Copy,
        Class::BackBufferClear,
        Class::Mipmaps,
        Class::Present,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Class::Clear => "clear",
            Class::Opaque => "opaque",
            Class::Blended => "blended",
            Class::ScreenReader => "screen-reader",
            Class::Program => "program",
            Class::ToBackBuffer => "to-back-buffer",
            Class::GroupComposite => "group-composite",
            Class::Copy => "copy",
            Class::BackBufferClear => "back-buffer-clear",
            Class::Mipmaps => "mipmaps",
            Class::Present => "present",
        }
    }
}

/// What the list alone cannot say.
#[derive(Clone, Debug, Default)]
pub struct FillOptions<'a> {
    /// Coverage grid cell edge in target pixels (0: 8).
    pub cell: u32,
    /// A draw covering at least this fraction of the target is listed in [`FillReport::large`]
    /// (0: 0.25).
    pub large_fraction: f64,
    /// Texture ids whose every texel is opaque (a mix draw of one may be [`Class::Opaque`]).
    pub opaque_textures: Option<&'a std::collections::HashSet<u32>>,
    /// Draw indices whose sampled texels are all opaque (the caller looked at the texels inside
    /// the draw's uv bounds): such a mix draw of the builtin program with opaque vertex colours and
    /// modulate is [`Class::Opaque`] even when its texture as a whole is not.
    pub opaque_draws: Option<&'a std::collections::HashSet<u32>>,
    /// Binding slots (0-based) whose program samples the screen (a draw through one is
    /// [`Class::ScreenReader`] even when its binding names no screen sampler).
    pub screen_slots: Option<&'a [bool]>,
    /// Count only fragments inside this `[x, y, w, h]` (a damage-limited redraw's scissor); a
    /// clear, a copy and the present are clipped to it too.
    pub clip: Option<[i32; 4]>,
}

/// One draw covering a large share of the target.
#[derive(Clone, Debug, PartialEq)]
pub struct LargeDraw {
    /// Index in [`DrawList::draws`].
    pub draw: u32,
    pub class: Class,
    /// Fragments.
    pub px: f64,
    /// Its screen bounds `[x0, y0, x1, y1]` (clipped).
    pub bounds: [f32; 4],
    pub blend: u32,
    pub program: u32,
    pub texture: u32,
    /// The item modulate's alpha of its first vertex's item.
    pub alpha: f32,
}

/// One back-buffer operation, as counted.
#[derive(Clone, Debug, PartialEq)]
pub struct OpFill {
    pub before: u32,
    pub kind: ScreenOpKind,
    pub region: [i32; 4],
    pub px: f64,
}

/// [`account`]'s result.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FillReport {
    pub width: u32,
    pub height: u32,
    /// Pixels touched per [`Class`] (index by `Class as usize`).
    pub px: [f64; CLASSES],
    /// Draws or operations per [`Class`].
    pub count: [u32; CLASSES],
    /// Target render passes as a tiler sees them (1 + every return to the target after
    /// back-buffer work).
    pub target_passes: u32,
    /// Back-buffer render passes (each maximal run of back-buffer work).
    pub back_buffer_passes: u32,
    /// Back-buffer passes that start with a whole clear (they need no load).
    pub back_buffer_cleared_passes: u32,
    pub large: Vec<LargeDraw>,
    pub ops: Vec<OpFill>,
    /// Layers per covered grid sample of the target (draws into it, the clear excluded).
    pub layers_mean: f64,
    pub layers_p50: u32,
    pub layers_p95: u32,
    pub layers_max: u32,
    /// Fragments into the target that a later [`Class::Opaque`] draw covers (grid estimate).
    pub hidden_px: f64,
    /// Draws whose every triangle is clipped away.
    pub empty_draws: u32,
    /// [`DrawList::depth_tiles`]: fragments the executor's depth test rejects (taken out of
    /// their draw's class above), and the depth-only pre-pass that draws the tiles (in no class:
    /// untextured fragments that write no colour).
    pub depth_rejected_px: f64,
    pub depth_prepass_px: f64,
}

impl FillReport {
    pub fn total(&self) -> f64 {
        self.px.iter().sum()
    }
    pub fn screen(&self) -> f64 {
        f64::from(self.width) * f64::from(self.height)
    }
}

/// The screen position of item-local `p` under item transform `x` (Godot columns) after the
/// instance transform `inst` (Godot's buffer layout), if any.
#[inline]
fn place(x: &[f32; 6], inst: Option<&[f32; 8]>, p: [f32; 2]) -> [f64; 2] {
    let (mut px, mut py) = (f64::from(p[0]), f64::from(p[1]));
    if let Some(i) = inst {
        let (ix, iy) = (
            f64::from(i[0]) * px + f64::from(i[1]) * py + f64::from(i[3]),
            f64::from(i[4]) * px + f64::from(i[5]) * py + f64::from(i[7]),
        );
        (px, py) = (ix, iy);
    }
    [
        f64::from(x[0]) * px + f64::from(x[2]) * py + f64::from(x[4]),
        f64::from(x[1]) * px + f64::from(x[3]) * py + f64::from(x[5]),
    ]
}

/// The area of triangle `t` inside the axis-aligned `[x0, y0, x1, y1]`: Sutherland–Hodgman
/// against the four edges, then the shoelace formula.
fn clipped_area(t: &[[f64; 2]; 3], r: [f64; 4]) -> f64 {
    let mut poly: Vec<[f64; 2]> = t.to_vec();
    let mut next: Vec<[f64; 2]> = Vec::with_capacity(8);
    // (axis, bound, keep >= bound)
    for (axis, bound, ge) in [
        (0usize, r[0], true),
        (0, r[2], false),
        (1, r[1], true),
        (1, r[3], false),
    ] {
        next.clear();
        let inside = |p: &[f64; 2]| {
            if ge {
                p[axis] >= bound
            } else {
                p[axis] <= bound
            }
        };
        for i in 0..poly.len() {
            let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
            let (ia, ib) = (inside(&a), inside(&b));
            if ia {
                next.push(a);
            }
            if ia != ib {
                let s = (bound - a[axis]) / (b[axis] - a[axis]);
                next.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
            }
        }
        std::mem::swap(&mut poly, &mut next);
        if poly.len() < 3 {
            return 0.0;
        }
    }
    let mut a = 0.0;
    for i in 0..poly.len() {
        let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
        a += p[0] * q[1] - q[0] * p[1];
    }
    (a * 0.5).abs()
}

fn intersect(a: [i32; 4], b: [i32; 4]) -> [i32; 4] {
    let (x0, y0) = (a[0].max(b[0]), a[1].max(b[1]));
    let (x1, y1) = (
        (a[0] + a[2]).min(b[0] + b[2]),
        (a[1] + a[3]).min(b[1] + b[3]),
    );
    [x0, y0, (x1 - x0).max(0), (y1 - y0).max(0)]
}

fn rect_px(r: [i32; 4]) -> f64 {
    f64::from(r[2].max(0)) * f64::from(r[3].max(0))
}

/// Every triangle of draw `d` in screen space (instanced draws once per instance), with the
/// item index of its first vertex.
fn for_each_triangle(list: &DrawList, d: usize, mut f: impl FnMut([[f64; 2]; 3], u32)) {
    let draw = &list.draws[d];
    let first = draw.first_index as usize;
    let end = (first + draw.index_count as usize).min(list.indices.len());
    let instances: Vec<Option<[f32; 8]>> = if draw.flags & DRAW_INSTANCED != 0 {
        match list.instanced.binary_search_by_key(&(d as u32), |r| r.draw) {
            Ok(i) => {
                let r = list.instanced[i];
                let from = r.first as usize;
                let to = (from + r.count as usize).min(list.instances.len());
                list.instances[from.min(to)..to]
                    .iter()
                    .map(|x| Some(x.xform))
                    .collect()
            }
            Err(_) => Vec::new(),
        }
    } else {
        vec![None]
    };
    for inst in &instances {
        let mut k = first;
        while k + 3 <= end {
            let mut tri = [[0.0; 2]; 3];
            let mut item = 0;
            let mut ok = true;
            for (j, slot) in tri.iter_mut().enumerate() {
                let Some(v) = list.vertices.get(list.indices[k + j] as usize) else {
                    ok = false;
                    break;
                };
                if j == 0 {
                    item = v.item;
                }
                let x = list
                    .items
                    .get(v.item as usize)
                    .map(|r| r.xform)
                    .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
                *slot = place(&x, inst.as_ref(), v.pos);
            }
            if ok {
                f(tri, item);
            }
            k += 3;
        }
    }
}

/// Whether draw `d` writes every fragment opaquely into the target (see [`Class::Opaque`]).
fn opaque_draw(list: &DrawList, d: usize, opts: &FillOptions) -> bool {
    let draw = &list.draws[d];
    match Blend::from_u32(draw.blend) {
        Some(Blend::Disabled) => return true,
        Some(Blend::Mix) => {}
        _ => return false,
    }
    if draw.program != BUILTIN_PROGRAM || draw.flags & (DRAW_TO_BACK_BUFFER | DRAW_MSDF) != 0 {
        return false;
    }
    let textured_opaque = draw.flags & DRAW_UNTEXTURED != 0
        || draw.texture == WHITE_TEXTURE
        || opts
            .opaque_textures
            .is_some_and(|s| s.contains(&draw.texture))
        || opts.opaque_draws.is_some_and(|s| s.contains(&(d as u32)));
    if !textured_opaque {
        return false;
    }
    let first = draw.first_index as usize;
    let end = (first + draw.index_count as usize).min(list.indices.len());
    list.indices[first..end].iter().all(|&i| {
        list.vertices.get(i as usize).is_some_and(|v| {
            v.color[3] >= 1.0
                && list
                    .items
                    .get(v.item as usize)
                    .is_some_and(|it| it.modulate[3] >= 1.0)
        })
    })
}

fn class_of(list: &DrawList, d: usize, opts: &FillOptions) -> Class {
    let draw = &list.draws[d];
    if draw.flags & DRAW_TO_BACK_BUFFER != 0 {
        return Class::ToBackBuffer;
    }
    if draw.program == BUILTIN_PROGRAM && draw.flags & (DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE) != 0
    {
        return Class::GroupComposite;
    }
    if draw.program != BUILTIN_PROGRAM {
        let slot = (draw.program - 1) as usize;
        let screen = opts
            .screen_slots
            .and_then(|s| s.get(slot).copied())
            .unwrap_or(false)
            || list
                .bindings
                .get(slot)
                .is_some_and(|b| b.samplers.iter().any(|s| s.texture == SCREEN_TEXTURE));
        return if screen {
            Class::ScreenReader
        } else {
            Class::Program
        };
    }
    if opaque_draw(list, d, opts) {
        Class::Opaque
    } else {
        Class::Blended
    }
}

/// Counts what executing `list` touches (see the module docs).
pub fn account(list: &DrawList, opts: &FillOptions) -> FillReport {
    let (w, h) = (list.target.width, list.target.height);
    let whole = [0, 0, w as i32, h as i32];
    let view = opts.clip.map_or(whole, |c| intersect(c, whole));
    let mut r = FillReport {
        width: w,
        height: h,
        ..FillReport::default()
    };
    let cell = if opts.cell == 0 { 8 } else { opts.cell };
    let large = if opts.large_fraction > 0.0 {
        opts.large_fraction
    } else {
        0.25
    };
    let (gw, gh) = (w.div_ceil(cell) as usize, h.div_ceil(cell) as usize);
    // Per grid sample: target layers, and the last draw index that covered it opaquely.
    let mut layers = vec![0u32; gw * gh];
    let mut last_opaque = vec![u32::MAX; gw * gh];
    // Per draw, the samples it covered (target draws only), for the hidden-fragment pass.
    let mut covered: Vec<(u32, Vec<u32>)> = Vec::new();

    r.px[Class::Clear as usize] += rect_px(view);
    r.count[Class::Clear as usize] += 1;
    r.target_passes = 1;
    // Where the executor is drawing: false the target, true the back buffer.
    let mut in_back = false;
    let enter_back = |r: &mut FillReport, in_back: &mut bool, cleared: bool| {
        if !*in_back {
            r.back_buffer_passes += 1;
            if cleared {
                r.back_buffer_cleared_passes += 1;
            }
            *in_back = true;
        }
    };
    // The depth tiles, as the executor draws them before the first draw.
    let depth = !list.depth_tiles.is_empty() && !list.depth_draws.is_empty();
    let depth_end = crate::cover::tiles::window_end(list);
    if depth {
        for t in &list.depth_tiles {
            r.depth_prepass_px += rect_px(intersect(t.rect, view));
        }
    }
    let mut next_op = 0usize;
    for d in 0..list.draws.len() {
        while let Some(op) = list.screen_ops.get(next_op) {
            if op.before as usize > d {
                break;
            }
            next_op += 1;
            let region = intersect(op.region, view);
            let (class, px) = match op.kind {
                ScreenOpKind::Copy => (Class::Copy, rect_px(region)),
                ScreenOpKind::Clear => (Class::BackBufferClear, rect_px(view)),
                ScreenOpKind::Mipmaps => (Class::Mipmaps, rect_px(region) / 3.0),
            };
            enter_back(&mut r, &mut in_back, op.kind == ScreenOpKind::Clear);
            r.px[class as usize] += px;
            r.count[class as usize] += 1;
            if op.kind == ScreenOpKind::Copy && op.mipmaps {
                r.px[Class::Mipmaps as usize] += rect_px(region) / 3.0;
                r.count[Class::Mipmaps as usize] += 1;
            }
            r.ops.push(OpFill {
                before: op.before,
                kind: op.kind,
                region: op.region,
                px,
            });
        }
        let draw = &list.draws[d];
        if draw.index_count == 0 {
            continue;
        }
        let class = class_of(list, d, opts);
        let to_back = class == Class::ToBackBuffer;
        if to_back {
            enter_back(&mut r, &mut in_back, false);
        } else if in_back {
            in_back = false;
            r.target_passes += 1;
        }
        let clip = if draw.flags & DRAW_SCISSOR != 0 {
            intersect(draw.scissor, view)
        } else {
            view
        };
        let cr = [
            f64::from(clip[0]),
            f64::from(clip[1]),
            f64::from(clip[0] + clip[2]),
            f64::from(clip[1] + clip[3]),
        ];
        // Tiles above the draw's depth level reject its fragments there.
        let level = if depth && d < depth_end && crate::cover::tiles::testable(list, d) {
            crate::depth_level(list, d as u32)
        } else {
            None
        };
        let rejecting: Vec<[f64; 4]> = level.map_or_else(Vec::new, |l| {
            list.depth_tiles
                .iter()
                .filter(|t| t.level > l)
                .map(|t| intersect(t.rect, clip))
                .filter(|q| q[2] > 0 && q[3] > 0)
                .map(|q| {
                    [
                        f64::from(q[0]),
                        f64::from(q[1]),
                        f64::from(q[0] + q[2]),
                        f64::from(q[1] + q[3]),
                    ]
                })
                .collect()
        });
        let mut px = 0.0;
        let mut bounds = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        let mut alpha = 1.0;
        let mut first_item = true;
        let mut samples: Vec<u32> = Vec::new();
        if clip[2] > 0 && clip[3] > 0 {
            for_each_triangle(list, d, |t, item| {
                if first_item {
                    alpha = list.items.get(item as usize).map_or(1.0, |i| i.modulate[3]);
                    first_item = false;
                }
                let a = clipped_area(&t, cr);
                if a <= 0.0 {
                    return;
                }
                let rejected: f64 = rejecting.iter().map(|q| clipped_area(&t, *q)).sum();
                r.depth_rejected_px += rejected;
                px += a - rejected;
                let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
                for p in &t {
                    x0 = x0.min(p[0]);
                    y0 = y0.min(p[1]);
                    x1 = x1.max(p[0]);
                    y1 = y1.max(p[1]);
                }
                let (x0, y0) = (x0.max(cr[0]), y0.max(cr[1]));
                let (x1, y1) = (x1.min(cr[2]), y1.min(cr[3]));
                bounds = [
                    bounds[0].min(x0 as f32),
                    bounds[1].min(y0 as f32),
                    bounds[2].max(x1 as f32),
                    bounds[3].max(y1 as f32),
                ];
                if to_back {
                    return;
                }
                // Grid samples at cell centres inside the triangle.
                let c = f64::from(cell);
                let gx0 = ((x0 / c - 0.5).ceil().max(0.0)) as usize;
                let gy0 = ((y0 / c - 0.5).ceil().max(0.0)) as usize;
                let gx1 = (((x1 / c - 0.5).floor()) as i64).min(gw as i64 - 1);
                let gy1 = (((y1 / c - 0.5).floor()) as i64).min(gh as i64 - 1);
                if gx1 < 0 || gy1 < 0 {
                    return;
                }
                let edge = |a: [f64; 2], b: [f64; 2], p: [f64; 2]| {
                    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
                };
                let area2 = edge(t[0], t[1], t[2]);
                if area2 == 0.0 {
                    return;
                }
                for gy in gy0..=gy1 as usize {
                    for gx in gx0..=gx1 as usize {
                        let p = [(gx as f64 + 0.5) * c, (gy as f64 + 0.5) * c];
                        let (e0, e1, e2) = (
                            edge(t[0], t[1], p),
                            edge(t[1], t[2], p),
                            edge(t[2], t[0], p),
                        );
                        let inside = if area2 > 0.0 {
                            e0 >= 0.0 && e1 >= 0.0 && e2 >= 0.0
                        } else {
                            e0 <= 0.0 && e1 <= 0.0 && e2 <= 0.0
                        };
                        if inside {
                            samples.push((gy * gw + gx) as u32);
                        }
                    }
                }
            });
        }
        if px <= 0.0 {
            r.empty_draws += 1;
            continue;
        }
        r.px[class as usize] += px;
        r.count[class as usize] += 1;
        if !to_back {
            samples.sort_unstable();
            samples.dedup();
            for &s in &samples {
                layers[s as usize] += 1;
                if class == Class::Opaque {
                    last_opaque[s as usize] = d as u32;
                }
            }
            covered.push((d as u32, samples));
        }
        if px >= large * r.screen() {
            r.large.push(LargeDraw {
                draw: d as u32,
                class,
                px,
                bounds,
                blend: draw.blend,
                program: draw.program,
                texture: draw.texture,
                alpha,
            });
        }
    }
    // Operations after the last draw still run (an executor runs them only before a draw, so
    // they are not counted).
    r.px[Class::Present as usize] += rect_px(view);
    r.count[Class::Present as usize] += 1;

    let cell_px = f64::from(cell) * f64::from(cell);
    for (d, samples) in &covered {
        let hidden = samples
            .iter()
            .filter(|&&s| last_opaque[s as usize] != u32::MAX && last_opaque[s as usize] > *d)
            .count();
        r.hidden_px += hidden as f64 * cell_px;
    }
    let mut lv: Vec<u32> = layers.iter().copied().filter(|&l| l > 0).collect();
    if !lv.is_empty() {
        lv.sort_unstable();
        r.layers_mean = lv.iter().map(|&l| f64::from(l)).sum::<f64>() / lv.len() as f64;
        r.layers_p50 = lv[lv.len() / 2];
        r.layers_p95 = lv[(lv.len() * 95 / 100).min(lv.len() - 1)];
        r.layers_max = *lv.last().unwrap_or(&0);
    }
    r
}

/// One draw's identity for [`damage`]: a hash of everything that decides its pixels (its state,
/// its screen-space vertices, colours and uvs, its item modulate, its binding's values, its
/// textures' revisions and, when its program reads the time, the shader time) and its bounds.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct DrawSig {
    pub hash: u64,
    /// `[x0, y0, x1, y1]`, unclipped by the scissor but clipped to the target; empty when the
    /// draw has no area.
    pub bounds: [f32; 4],
}

/// FNV-1a over 64-bit words.
struct Fnv(u64);
impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn u(&mut self, v: u64) {
        for b in v.to_le_bytes() {
            self.0 ^= u64::from(b);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }
    fn f(&mut self, v: f32) {
        self.u(u64::from(v.to_bits()));
    }
}

/// Every draw's [`DrawSig`] in paint order, plus one per screen operation (hashed with the
/// draw it precedes). `revisions` maps texture ids to a counter the caller bumps on every
/// upload; `time_slots` names the binding slots whose program reads the time.
pub fn signature(
    list: &DrawList,
    revisions: &HashMap<u32, u32>,
    time_slots: &[bool],
) -> Vec<DrawSig> {
    let (w, h) = (list.target.width as f32, list.target.height as f32);
    let mut out = Vec::with_capacity(list.draws.len() + list.screen_ops.len());
    let mut next_op = 0usize;
    for (d, draw) in list.draws.iter().enumerate() {
        while let Some(op) = list.screen_ops.get(next_op) {
            if op.before as usize > d {
                break;
            }
            next_op += 1;
            let mut f = Fnv::new();
            f.u(0x5c);
            f.u(op.kind as u64);
            for v in op.region {
                f.u(v as u64);
            }
            f.u(u64::from(op.mipmaps) | u64::from(op.sample_mips) << 1);
            let r = op.region;
            out.push(DrawSig {
                hash: f.0,
                bounds: [
                    r[0] as f32,
                    r[1] as f32,
                    (r[0] + r[2]) as f32,
                    (r[1] + r[3]) as f32,
                ],
            });
        }
        let mut f = Fnv::new();
        f.u(u64::from(draw.texture));
        f.u(u64::from(
            revisions.get(&draw.texture).copied().unwrap_or(0),
        ));
        f.u(u64::from(draw.sampler));
        f.u(u64::from(draw.blend));
        f.u(u64::from(draw.program));
        f.u(u64::from(draw.flags));
        if draw.flags & DRAW_SCISSOR != 0 {
            for v in draw.scissor {
                f.u(v as u64);
            }
        }
        f.f(draw.msdf[0]);
        f.f(draw.msdf[1]);
        if draw.program != BUILTIN_PROGRAM {
            let slot = (draw.program - 1) as usize;
            if let Some(b) = list.bindings.get(slot) {
                f.u(u64::from(b.program));
                for c in b.post_modulate {
                    f.f(c);
                }
                for u in &b.uniforms {
                    match &u.value {
                        crate::UniformValue::Float(v) => v.iter().for_each(|x| f.f(*x)),
                        crate::UniformValue::Int(v) => v.iter().for_each(|x| f.u(*x as u64)),
                    }
                }
                for s in &b.samplers {
                    f.u(u64::from(s.texture));
                    f.u(u64::from(revisions.get(&s.texture).copied().unwrap_or(0)));
                }
            }
            if time_slots.get(slot).copied().unwrap_or(false) {
                f.f(list.shader_time);
            }
        }
        let mut bounds = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        let mut any = false;
        for_each_triangle(list, d, |t, item| {
            any = true;
            for p in &t {
                f.u(p[0].to_bits());
                f.u(p[1].to_bits());
                bounds = [
                    bounds[0].min(p[0] as f32),
                    bounds[1].min(p[1] as f32),
                    bounds[2].max(p[0] as f32),
                    bounds[3].max(p[1] as f32),
                ];
            }
            if let Some(it) = list.items.get(item as usize) {
                it.modulate.iter().for_each(|c| f.f(*c));
            }
        });
        // Colours and uvs of the indexed vertices.
        let first = draw.first_index as usize;
        let end = (first + draw.index_count as usize).min(list.indices.len());
        for &i in &list.indices[first..end] {
            if let Some(v) = list.vertices.get(i as usize) {
                v.uv.iter().chain(v.color.iter()).for_each(|c| f.f(*c));
            }
        }
        if draw.flags & DRAW_SCISSOR != 0 {
            let s = draw.scissor;
            bounds = [
                bounds[0].max(s[0] as f32),
                bounds[1].max(s[1] as f32),
                bounds[2].min((s[0] + s[2]) as f32),
                bounds[3].min((s[1] + s[3]) as f32),
            ];
        }
        bounds = [
            bounds[0].max(0.0),
            bounds[1].max(0.0),
            bounds[2].min(w),
            bounds[3].min(h),
        ];
        if !any || bounds[2] <= bounds[0] || bounds[3] <= bounds[1] {
            bounds = [0.0; 4];
        }
        out.push(DrawSig { hash: f.0, bounds });
    }
    out
}

/// What changed between two frames' signatures.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Damage {
    /// Draws (and operations) present in only one of the two frames.
    pub changed: u32,
    /// The union rectangle of their bounds, `[x, y, w, h]` (integer, outward), or `None`.
    pub rect: Option<[i32; 4]>,
    /// Pixels of the grid cells their bounds touch (a multi-rectangle damage region).
    pub cells_px: f64,
}

/// The draws one of `a` and `b` has and the other lacks (a multiset difference of hashes), with
/// their bounds unioned.
pub fn damage(a: &[DrawSig], b: &[DrawSig], width: u32, height: u32, cell: u32) -> Damage {
    let mut count: HashMap<u64, i32> = HashMap::new();
    for s in a {
        *count.entry(s.hash).or_default() += 1;
    }
    for s in b {
        *count.entry(s.hash).or_default() -= 1;
    }
    let cell = if cell == 0 { 32 } else { cell };
    let (gw, gh) = (
        width.div_ceil(cell) as usize,
        height.div_ceil(cell) as usize,
    );
    let mut cells = vec![false; gw * gh];
    let mut out = Damage::default();
    let mut u = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    let mut take = |s: &DrawSig, out: &mut Damage| {
        out.changed += 1;
        let b = s.bounds;
        if b[2] <= b[0] || b[3] <= b[1] {
            return;
        }
        u = [
            u[0].min(b[0]),
            u[1].min(b[1]),
            u[2].max(b[2]),
            u[3].max(b[3]),
        ];
        let c = cell as f32;
        let (x0, y0) = ((b[0] / c) as usize, (b[1] / c) as usize);
        let (x1, y1) = (
            (((b[2] / c).ceil() as usize).min(gw)),
            (((b[3] / c).ceil() as usize).min(gh)),
        );
        for gy in y0..y1 {
            for gx in x0..x1 {
                cells[gy * gw + gx] = true;
            }
        }
    };
    let mut left = count.clone();
    for s in a {
        let n = left.get_mut(&s.hash).expect("counted");
        if *n > 0 {
            *n -= 1;
            take(s, &mut out);
        }
    }
    for s in b {
        let n = left.get_mut(&s.hash).expect("counted");
        if *n < 0 {
            *n += 1;
            take(s, &mut out);
        }
    }
    if u[2] > u[0] && u[3] > u[1] {
        let (x0, y0) = (u[0].floor() as i32, u[1].floor() as i32);
        let (x1, y1) = (u[2].ceil() as i32, u[3].ceil() as i32);
        out.rect = Some([x0, y0, x1 - x0, y1 - y0]);
    }
    let c = f64::from(cell);
    for gy in 0..gh {
        for gx in 0..gw {
            if cells[gy * gw + gx] {
                let cw = (c).min(f64::from(width) - gx as f64 * c);
                let ch = (c).min(f64::from(height) - gy as f64 * c);
                out.cells_px += cw * ch;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Draw, Item, ScreenOp, Target, Vertex, DRAW_SCREEN_OPS};

    /// A list on a 100×50 target with one axis-aligned quad per `rects` entry (`[x, y, w, h]`,
    /// item-local, under an identity item), each its own draw with `flags`.
    fn list(rects: &[([f32; 4], u32, f32)]) -> DrawList {
        let mut l = DrawList::new(Target {
            width: 100,
            height: 50,
            ..Target::default()
        });
        for (k, (r, flags, alpha)) in rects.iter().enumerate() {
            l.items.push(Item {
                xform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                modulate: [1.0, 1.0, 1.0, *alpha],
                ..Item::default()
            });
            let base = l.vertices.len() as u32;
            for (x, y) in [
                (r[0], r[1]),
                (r[0] + r[2], r[1]),
                (r[0] + r[2], r[1] + r[3]),
                (r[0], r[1] + r[3]),
            ] {
                l.vertices.push(Vertex {
                    pos: [x, y],
                    uv: [0.0, 0.0],
                    color: [1.0; 4],
                    item: k as u32,
                });
            }
            let first = l.indices.len() as u32;
            l.indices.extend([0, 1, 2, 0, 2, 3].map(|i| base + i));
            l.draws.push(Draw {
                first_index: first,
                index_count: 6,
                texture: WHITE_TEXTURE,
                flags: *flags | DRAW_UNTEXTURED,
                ..Draw::default()
            });
        }
        l
    }

    #[test]
    fn clipped_area_of_a_triangle() {
        let t = [[0.0, 0.0], [10.0, 0.0], [0.0, 10.0]];
        assert_eq!(clipped_area(&t, [0.0, 0.0, 100.0, 100.0]), 50.0);
        // The 5×5 corner square lies wholly inside the triangle.
        assert_eq!(clipped_area(&t, [0.0, 0.0, 5.0, 5.0]), 25.0);
        assert_eq!(clipped_area(&t, [20.0, 20.0, 30.0, 30.0]), 0.0);
    }

    #[test]
    fn counts_clear_draws_and_present() {
        // A full-screen opaque quad, then a translucent half-screen one, half off the target.
        let l = list(&[
            ([0.0, 0.0, 100.0, 50.0], 0, 1.0),
            ([50.0, 0.0, 100.0, 50.0], 0, 0.5),
        ]);
        let r = account(&l, &FillOptions::default());
        assert_eq!(r.px[Class::Clear as usize], 5000.0);
        assert_eq!(r.px[Class::Opaque as usize], 5000.0);
        assert_eq!(r.px[Class::Blended as usize], 2500.0);
        assert_eq!(r.px[Class::Present as usize], 5000.0);
        assert_eq!(r.total(), 17500.0);
        assert_eq!(r.target_passes, 1);
        assert_eq!(r.large.len(), 2);
        // The only opaque draw is the first, so nothing is hidden.
        assert_eq!(r.hidden_px, 0.0);
        assert_eq!(r.layers_max, 2);
    }

    #[test]
    fn a_later_opaque_draw_hides_earlier_fragments() {
        let l = list(&[
            ([0.0, 0.0, 48.0, 48.0], 0, 0.5),
            ([0.0, 0.0, 100.0, 50.0], 0, 1.0),
        ]);
        let r = account(&l, &FillOptions::default());
        // 6×6 cells of 8 px under the 48×48 quad.
        assert_eq!(r.hidden_px, 36.0 * 64.0);
    }

    #[test]
    fn scissor_and_group_passes() {
        let mut l = list(&[
            ([0.0, 0.0, 100.0, 50.0], 0, 1.0),
            (
                [0.0, 0.0, 100.0, 50.0],
                DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS,
                1.0,
            ),
            ([10.0, 10.0, 20.0, 20.0], DRAW_GROUP_COMPOSITE, 1.0),
            ([0.0, 0.0, 100.0, 50.0], DRAW_SCISSOR | DRAW_SCREEN_OPS, 1.0),
        ]);
        l.draws[3].scissor = [0, 0, 10, 10];
        l.screen_ops.push(ScreenOp {
            before: 1,
            kind: ScreenOpKind::Clear,
            region: [0, 0, 100, 50],
            mipmaps: false,
            sample_mips: false,
        });
        l.screen_ops.push(ScreenOp {
            before: 3,
            kind: ScreenOpKind::Copy,
            region: [0, 0, 40, 25],
            mipmaps: false,
            sample_mips: false,
        });
        let r = account(&l, &FillOptions::default());
        assert_eq!(r.px[Class::BackBufferClear as usize], 5000.0);
        assert_eq!(r.px[Class::ToBackBuffer as usize], 5000.0);
        assert_eq!(r.px[Class::GroupComposite as usize], 400.0);
        assert_eq!(r.px[Class::Copy as usize], 1000.0);
        assert_eq!(r.px[Class::Opaque as usize], 5100.0);
        // target, (clear + group draws), target (composite), (copy), target.
        assert_eq!(r.target_passes, 3);
        assert_eq!(r.back_buffer_passes, 2);
        assert_eq!(r.back_buffer_cleared_passes, 1);
        // A damage-limited view counts only inside it.
        let r = account(
            &l,
            &FillOptions {
                clip: Some([0, 0, 10, 10]),
                ..FillOptions::default()
            },
        );
        assert_eq!(r.px[Class::Clear as usize], 100.0);
        assert_eq!(r.px[Class::GroupComposite as usize], 0.0);
    }

    #[test]
    fn damage_is_the_changed_draws() {
        let a = list(&[
            ([0.0, 0.0, 100.0, 50.0], 0, 1.0),
            ([10.0, 10.0, 5.0, 5.0], 0, 1.0),
        ]);
        let mut b = a.clone();
        let none = HashMap::new();
        let same = damage(
            &signature(&a, &none, &[]),
            &signature(&b, &none, &[]),
            100,
            50,
            32,
        );
        assert_eq!(same, Damage::default());
        // Move the small quad by 10 px: its old and new bounds.
        b.items[1].xform[4] = 10.0;
        let d = damage(
            &signature(&a, &none, &[]),
            &signature(&b, &none, &[]),
            100,
            50,
            32,
        );
        assert_eq!(d.changed, 2);
        assert_eq!(d.rect, Some([10, 10, 15, 5]));
        assert_eq!(d.cells_px, 32.0 * 32.0);
        // A texture revision damages its draws.
        let mut rev = HashMap::new();
        rev.insert(WHITE_TEXTURE, 1);
        let d = damage(
            &signature(&a, &none, &[]),
            &signature(&a, &rev, &[]),
            100,
            50,
            32,
        );
        assert_eq!(d.changed, 4);
        // A draw through a time-reading program slot changes with the shader time only.
        let mut p = a.clone();
        p.bindings.push(crate::Binding {
            program: 7,
            post_modulate: [1.0; 4],
            uniforms: Vec::new(),
            samplers: Vec::new(),
        });
        p.draws[1].program = 1;
        let mut q = p.clone();
        q.shader_time = 1.5;
        let sig = |l: &DrawList, t: &[bool]| signature(l, &none, t);
        assert_eq!(
            damage(&sig(&p, &[false]), &sig(&q, &[false]), 100, 50, 32).changed,
            0
        );
        let d = damage(&sig(&p, &[true]), &sig(&q, &[true]), 100, 50, 32);
        assert_eq!(d.changed, 2);
        assert_eq!(d.rect, Some([10, 10, 5, 5]));
    }
}
