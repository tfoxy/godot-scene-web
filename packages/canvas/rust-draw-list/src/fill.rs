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
//! hides. [`crate::damage`] plans the regions an exact partial redraw must repaint.

use crate::{
    Blend, DrawList, ScreenOpKind, BUILTIN_PROGRAM, DRAW_GROUP_CLIP, DRAW_GROUP_COMPOSITE,
    DRAW_INSTANCED, DRAW_MSDF, DRAW_SCISSOR, DRAW_TO_BACK_BUFFER, DRAW_UNTEXTURED, SCREEN_TEXTURE,
    WHITE_TEXTURE,
};

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
    /// Dead group-cell rejected fragments: builtin, item-space program, instanced. Also
    /// included in depth_rejected_px; excluded from colour fill. Independent of shader cost.
    pub group_rejected_px: [f64; 3],
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

/// Account a partial replay by class, in device pixels. Target draws, clear and present use
/// `regions`; back-buffer producer draws use `back_regions`. Screen operations disable the draw
/// scissor in the executor, so copies, whole back-buffer clears and mip chains are counted once
/// at their full operation extents. Region sets must each be disjoint, as a damage plan guarantees.
pub fn account_partial(
    list: &DrawList,
    opts: &FillOptions,
    regions: &[[i32; 4]],
    back_regions: &[[i32; 4]],
) -> [f64; CLASSES] {
    let mut px = [0.; CLASSES];
    if regions.is_empty() {
        return px;
    }
    let full = account(
        list,
        &FillOptions {
            clip: None,
            ..opts.clone()
        },
    );
    for class in [Class::Copy, Class::BackBufferClear, Class::Mipmaps] {
        px[class as usize] = full.px[class as usize];
    }
    for region in regions {
        let report = account(
            list,
            &FillOptions {
                clip: Some(*region),
                ..opts.clone()
            },
        );
        for class in [
            Class::Clear,
            Class::Opaque,
            Class::Blended,
            Class::ScreenReader,
            Class::Program,
            Class::GroupComposite,
            Class::Present,
        ] {
            px[class as usize] += report.px[class as usize];
        }
    }
    for region in back_regions {
        let report = account(
            list,
            &FillOptions {
                clip: Some(*region),
                ..opts.clone()
            },
        );
        px[Class::ToBackBuffer as usize] += report.px[Class::ToBackBuffer as usize];
    }
    px
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
    for group in &list.group_cells {
        for &rect in &group.rects {
            r.depth_prepass_px += rect_px(intersect(rect, view));
        }
    }
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
        let mut rejecting: Vec<[f64; 4]> = level.map_or_else(Vec::new, |l| {
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
        if to_back {
            for group in &list.group_cells {
                if !group.draws.contains(&d) {
                    continue;
                }
                for &rect in &group.rects {
                    let q = intersect(rect, clip);
                    if q[2] > 0 && q[3] > 0 {
                        rejecting.push([
                            q[0] as f64,
                            q[1] as f64,
                            (q[0] + q[2]) as f64,
                            (q[1] + q[3]) as f64,
                        ]);
                    }
                }
            }
        }
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
                if to_back {
                    let kind = if draw.flags & DRAW_INSTANCED != 0 {
                        2
                    } else if draw.program != BUILTIN_PROGRAM {
                        1
                    } else {
                        0
                    };
                    r.group_rejected_px[kind] += rejected;
                }
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
}
