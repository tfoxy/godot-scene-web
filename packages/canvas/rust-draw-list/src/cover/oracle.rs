//! A pixel-level oracle for the cover walk: what each target pixel's final value depends on,
//! per pixel, so a culled list can be compared with the full one without a GPU.
//!
//! Diagnostic only (tests and `rs-core-check`), never on an executor's path. It simulates one
//! execution of the list at pixel centres with hashes instead of colours: every pixel holds a hash
//! of its colour's history and one of its alpha's, the back buffer one per texel. A draw at a
//! pixel either overwrites it (a cover whose state allows it, the centre and eight points
//! [`MARGIN`] around it each inside one of its triangles, so the shared edges of a mesh are
//! watertight as a rasterizer draws them, and, for a blended cover, every texel its filter reads
//! there opaque, checked texel by texel) or blends into it (any other touch, the centre within
//! [`MARGIN`] of a triangle): blending folds the draw's identity into the old hash. A draw's
//! identity hashes everything that decides its colour (state, screen-space vertices, colours,
//! texture coordinates, item modulate, binding values, instances) and, for a screen reader, the
//! back buffer it reads and the mip state it samples with. Copies, clears and mip chains move
//! hashes between the target and the back buffer as the executor moves texels.
//!
//! A triangle whose every fragment provably leaves its pixel as it was (a source of
//! `(0, 0, 0, 0)` under a blend that keeps the destination, restated from the executor's arithmetic
//! per triangle in `silent`) touches nothing.
//!
//! Two lists paint the same pixels when their final hashes are equal everywhere: the geometry
//! here (rasterizing every triangle, the texels per pixel) is independent of the walk's
//! rectangles, so a walk that drops something a pixel still depends on shows up as a mismatch.

use super::{CoverFacts, PxRect, MARGIN};
use crate::{
    Blend, DrawList, ScreenOpKind, BUILTIN_PROGRAM, DRAW_GROUP_CLIP, DRAW_GROUP_COMPOSITE,
    DRAW_INSTANCED, DRAW_MSDF, DRAW_SCISSOR, DRAW_SCREEN_OPS, DRAW_TO_BACK_BUFFER, DRAW_UNTEXTURED,
    WHITE_TEXTURE,
};

/// Every target pixel's colour and alpha history hash after one execution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Provenance {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u64>,
    pub alpha: Vec<u64>,
}

impl Provenance {
    /// Pixels whose colour or alpha history differs from `other`'s (all of them when the sizes
    /// differ).
    pub fn mismatches(&self, other: &Provenance) -> usize {
        if (self.width, self.height) != (other.width, other.height) {
            return self.rgb.len().max(other.rgb.len());
        }
        self.rgb
            .iter()
            .zip(&other.rgb)
            .zip(self.alpha.iter().zip(&other.alpha))
            .filter(|((a, b), (c, d))| a != b || c != d)
            .count()
    }
}

#[inline]
fn mix(mut h: u64, v: u64) -> u64 {
    // FNV-1a over the word's bytes, then a final avalanche.
    for b in v.to_le_bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h ^ (h >> 29)
}

fn mixf(h: u64, v: f32) -> u64 {
    mix(h, u64::from(v.to_bits()))
}

/// The hash of `vals` folded from a fixed seed.
fn hash_of(vals: &[u64]) -> u64 {
    vals.iter().fold(0xcbf2_9ce4_8422_2325, |h, &v| mix(h, v))
}

/// Every triangle of draw `d` in screen space with its vertices' texture coordinates.
/// One triangle: screen positions and texture coordinates.
type Tri = ([[f64; 2]; 3], [[f32; 2]; 3]);

fn triangles(list: &DrawList, d: usize, silent: &[bool]) -> Vec<Tri> {
    let draw = &list.draws[d];
    let range = super::index_range(list, draw);
    let mut out = Vec::new();
    let insts: Vec<Option<[f32; 8]>> = if draw.flags & DRAW_INSTANCED != 0 {
        match list.instanced.binary_search_by_key(&(d as u32), |r| r.draw) {
            Ok(i) => {
                let r = list.instanced[i];
                let from = (r.first as usize).min(list.instances.len());
                let to = (from + r.count as usize).min(list.instances.len());
                list.instances[from..to]
                    .iter()
                    .map(|x| Some(x.xform))
                    .collect()
            }
            Err(_) => Vec::new(),
        }
    } else {
        vec![None]
    };
    for inst in &insts {
        for (k, t) in list.indices[range.clone()].chunks_exact(3).enumerate() {
            if silent.get(k) == Some(&true) {
                continue;
            }
            let mut p = [[0.0; 2]; 3];
            let mut uv = [[0.0f32; 2]; 3];
            let mut ok = true;
            for j in 0..3 {
                let Some(v) = list.vertices.get(t[j] as usize) else {
                    ok = false;
                    break;
                };
                let x = list
                    .items
                    .get(v.item as usize)
                    .map_or(super::IDENTITY, |r| r.xform);
                p[j] = super::place(&x, inst.as_ref(), v.pos);
                uv[j] = v.uv;
            }
            if ok {
                out.push((p, uv));
            }
        }
    }
    out
}

/// The walk's no-op rule ([`super::noop`]), restated per triangle `t` (three indices) of draw `d`
/// from the executor's arithmetic: whether every fragment it makes leaves its pixel as it was. Its
/// source must be `(0, 0, 0, 0)` under mix, premultiplied alpha, add or sub (each then keeps the
/// destination's colour and alpha on either kind of target). The builtin program's alpha is the
/// interpolated vertex alpha times the flat modulate alpha (of the triangle's last vertex's row;
/// all three rows are asked), its colour premultiplied by it except under premultiplied alpha
/// outside a group draw; a program's alpha is its own times its post-modulate alpha, the former
/// known only as a uniform's value ([`super::ProgramFacts::alpha`]).
fn silent(list: &DrawList, d: usize, facts: &impl CoverFacts, t: &[u32]) -> bool {
    let draw = &list.draws[d];
    let group = draw.program == BUILTIN_PROGRAM
        && draw.flags & (DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE) != 0;
    let premultiplied = match Blend::from_u32(draw.blend) {
        Some(Blend::Mix | Blend::Add | Blend::Sub) => true,
        Some(Blend::PremulAlpha) => group,
        _ => return false,
    };
    if draw.program != BUILTIN_PROGRAM {
        let Some(b) = list.bindings.get(draw.program as usize - 1) else {
            return false;
        };
        let own = facts.program(draw.program - 1).alpha.and_then(|a| {
            match &b.uniforms.get(usize::from(a.uniform))?.value {
                crate::UniformValue::Float(v) => v.get(usize::from(a.component)).copied(),
                crate::UniformValue::Int(_) => None,
            }
        });
        return premultiplied && (b.post_modulate[3] == 0.0 || own == Some(0.0));
    }
    let mut vs = Vec::with_capacity(3);
    let mut mods = Vec::with_capacity(3);
    for &i in t {
        let Some(v) = list.vertices.get(i as usize) else {
            return false;
        };
        let Some(r) = list.items.get(v.item as usize) else {
            return false;
        };
        vs.push(v.color);
        mods.push(r.modulate);
    }
    let alpha0 = vs.iter().all(|c| c[3] == 0.0) || mods.iter().all(|m| m[3] == 0.0);
    let rgb0 = premultiplied
        || vs.iter().all(|c| c[..3] == [0.0; 3])
        || mods.iter().all(|m| m[..3] == [0.0; 3]);
    alpha0 && rgb0
}

/// Draw `d`'s identity (see the module docs), without the back buffer it may read.
fn identity(list: &DrawList, d: usize) -> u64 {
    let draw = &list.draws[d];
    let mut h = 0x9e37_79b9_7f4a_7c15u64;
    // The binding's slot number is the producer's bookkeeping (two producers of the same frame may
    // number slots differently): what it binds is hashed below.
    for v in [
        draw.texture,
        draw.sampler,
        draw.blend,
        u32::from(draw.program != BUILTIN_PROGRAM),
        draw.flags & !DRAW_SCREEN_OPS,
    ] {
        h = mix(h, u64::from(v));
    }
    if draw.flags & DRAW_SCISSOR != 0 {
        for v in draw.scissor {
            h = mix(h, v as u64);
        }
    }
    h = mixf(mixf(h, draw.msdf[0]), draw.msdf[1]);
    if draw.program != BUILTIN_PROGRAM {
        if let Some(b) = list.bindings.get(draw.program as usize - 1) {
            h = mix(h, u64::from(b.program));
            for c in b.post_modulate {
                h = mixf(h, c);
            }
            for u in &b.uniforms {
                match &u.value {
                    crate::UniformValue::Float(v) => v.iter().for_each(|x| h = mixf(h, *x)),
                    crate::UniformValue::Int(v) => v.iter().for_each(|x| h = mix(h, *x as u64)),
                }
            }
            for s in &b.samplers {
                h = mix(mix(h, u64::from(s.texture)), u64::from(s.sampler));
            }
        }
        h = mixf(h, list.shader_time);
    }
    let range = super::index_range(list, draw);
    for &i in &list.indices[range] {
        if let Some(v) = list.vertices.get(i as usize) {
            for c in v.pos.iter().chain(&v.uv).chain(&v.color) {
                h = mixf(h, *c);
            }
            if let Some(r) = list.items.get(v.item as usize) {
                for c in r.xform.iter().chain(&r.modulate) {
                    h = mixf(h, *c);
                }
                h = mix(h, u64::from(r.flags));
            }
        }
    }
    if draw.flags & DRAW_INSTANCED != 0 {
        if let Ok(i) = list.instanced.binary_search_by_key(&(d as u32), |r| r.draw) {
            let r = list.instanced[i];
            let from = (r.first as usize).min(list.instances.len());
            let to = (from + r.count as usize).min(list.instances.len());
            for inst in &list.instances[from..to] {
                for c in inst.xform.iter().chain(&inst.color).chain(&inst.custom) {
                    h = mixf(h, *c);
                }
            }
        }
    }
    h
}

/// Whether draw `d`'s state lets it overwrite (the walk's state rule, restated), and whether its
/// texels need checking.
fn overwrite_state(list: &DrawList, d: usize, facts: &impl CoverFacts) -> Option<bool> {
    let draw = &list.draws[d];
    if draw.program != BUILTIN_PROGRAM
        || draw.flags
            & (DRAW_TO_BACK_BUFFER
                | DRAW_MSDF
                | DRAW_INSTANCED
                | DRAW_GROUP_CLIP
                | DRAW_GROUP_COMPOSITE)
            != 0
    {
        return None;
    }
    match Blend::from_u32(draw.blend)? {
        Blend::Disabled => Some(false),
        Blend::Mix | Blend::PremulAlpha => {
            let range = super::index_range(list, draw);
            let solid = list.indices[range].iter().all(|&i| {
                list.vertices.get(i as usize).is_some_and(|v| {
                    v.color[3] >= 1.0
                        && list
                            .items
                            .get(v.item as usize)
                            .is_some_and(|r| r.modulate[3] >= 1.0)
                })
            });
            if !solid {
                return None;
            }
            let white = draw.flags & DRAW_UNTEXTURED != 0 || draw.texture == WHITE_TEXTURE;
            if !white && facts.opacity(draw.texture).is_none() {
                return None;
            }
            Some(!white)
        }
        _ => None,
    }
}

/// Whether every texel the draw's sampler reads at texture coordinate `uv` is opaque, the
/// texture held reduced by `k` ([`crate::downscale_factor`]): a reduced texel is then the
/// alpha-weighted mean of a `k`x`k` block, counted opaque when the whole block is.
fn texels_opaque(o: &crate::opacity::Opacity, sampler: u32, uv: [f64; 2], k: u32) -> bool {
    let (rw, rh) = crate::downscaled_size(o.width(), o.height(), k);
    let size = [rw, rh];
    let mut span = [(0i64, 0i64); 2];
    for k in 0..2 {
        let s = uv[k] * f64::from(size[k]);
        span[k] = if sampler & crate::Sampler::LINEAR != 0 {
            (
                (s - 0.5 - super::UV_EPS).floor() as i64,
                (s - 0.5 + super::UV_EPS).floor() as i64 + 1,
            )
        } else {
            (
                (s - super::UV_EPS).floor() as i64,
                (s + super::UV_EPS).floor() as i64,
            )
        };
    }
    let wrap = sampler & crate::Sampler::WRAP_MASK;
    let fix = |t: i64, n: u32| -> i64 {
        let n = i64::from(n);
        match wrap {
            crate::Sampler::CLAMP => t.clamp(0, n - 1),
            crate::Sampler::REPEAT => t.rem_euclid(n),
            _ => {
                let m = t.rem_euclid(2 * n);
                if m < n {
                    m
                } else {
                    2 * n - 1 - m
                }
            }
        }
    };
    let k = i64::from(k);
    let (w, h) = (i64::from(o.width()), i64::from(o.height()));
    for ty in span[1].0..=span[1].1 {
        for tx in span[0].0..=span[0].1 {
            let (x, y) = (k * fix(tx, size[0]), k * fix(ty, size[1]));
            if !o.region(x, y, (x + k - 1).min(w - 1), (y + k - 1).min(h - 1)) {
                return false;
            }
        }
    }
    true
}

/// Simulates `list` (see the module docs).
pub fn provenance(list: &DrawList, facts: &impl CoverFacts) -> Provenance {
    let (w, h) = (list.target.width as usize, list.target.height as usize);
    let target = PxRect {
        x0: 0,
        y0: 0,
        x1: w as i32,
        y1: h as i32,
    };
    let opaque = list.target.opaque;
    let mut rgb = vec![1u64; w * h];
    let mut alpha = vec![2u64; w * h];
    let mut back = vec![3u64; w * h];
    let mut mips = 4u64;
    let mut sample_mips = false;
    // Per pixel of the current draw's bounds: 0 untouched, 1 touched, 2 overwritten.
    let mut state: Vec<u16> = Vec::new();
    // The depth tiles (`DrawList::depth_tiles`) as an executor that honours them sees them: per
    // pixel the highest tile level, valid until the depth window ends; a listed draw there leaves
    // every pixel whose level exceeds its own untouched.
    let depth_end = super::tiles::window_end(list);
    let mut depth = Vec::new();
    if !list.depth_tiles.is_empty() && !list.depth_draws.is_empty() {
        depth = vec![0u32; w * h];
        for t in &list.depth_tiles {
            let r = PxRect::xywh(t.rect).intersect(&target);
            for y in r.y0.max(0)..r.y1 {
                for x in r.x0.max(0)..r.x1 {
                    let i = y as usize * w + x as usize;
                    depth[i] = depth[i].max(t.level);
                }
            }
        }
    }
    let mut next_op = 0usize;
    for d in 0..list.draws.len() {
        while let Some(op) = list.screen_ops.get(next_op) {
            if op.before as usize > d {
                break;
            }
            next_op += 1;
            let r = PxRect::xywh(op.region).intersect(&target);
            match op.kind {
                ScreenOpKind::Copy => {
                    let mut region_hash = 5u64;
                    for y in r.y0.max(0)..r.y1 {
                        for x in r.x0.max(0)..r.x1 {
                            let i = y as usize * w + x as usize;
                            back[i] = mix(rgb[i], alpha[i]);
                            region_hash = mix(region_hash, back[i]);
                        }
                    }
                    if op.mipmaps && !r.is_empty() {
                        mips = mix(mips, region_hash);
                    }
                }
                ScreenOpKind::Clear => back.iter_mut().for_each(|b| *b = 6),
                ScreenOpKind::Mipmaps => {
                    let mut region_hash = 7u64;
                    for y in r.y0.max(0)..r.y1 {
                        for x in r.x0.max(0)..r.x1 {
                            region_hash = mix(region_hash, back[y as usize * w + x as usize]);
                        }
                    }
                    if !r.is_empty() {
                        mips = mix(mips, region_hash);
                    }
                }
            }
            sample_mips = op.sample_mips;
        }
        let draw = &list.draws[d];
        if draw.index_count == 0 {
            continue;
        }
        let silent_tris: Vec<bool> = list.indices[super::index_range(list, draw)]
            .chunks_exact(3)
            .map(|t| silent(list, d, facts, t))
            .collect();
        if silent_tris.iter().all(|s| *s) {
            // Nothing it makes changes a pixel (whatever it reads).
            continue;
        }
        let vertex_stage =
            draw.program != BUILTIN_PROGRAM && facts.program(draw.program - 1).vertex_stage;
        let tris = triangles(list, d, &silent_tris);
        // The pixels any triangle may touch, within the scissor and the target (computed here, not
        // with the walk's bounds, so the two stay independent).
        let clip = super::clip_rect(list, draw);
        let bounds = if vertex_stage {
            clip
        } else {
            let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for (p, _) in &tris {
                for q in p {
                    x0 = x0.min(q[0]);
                    y0 = y0.min(q[1]);
                    x1 = x1.max(q[0]);
                    y1 = y1.max(q[1]);
                }
            }
            if x0 > x1 {
                continue;
            }
            if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) {
                clip
            } else {
                PxRect {
                    x0: (x0 - 1.0).floor().max(-1.0e9) as i32,
                    y0: (y0 - 1.0).floor().max(-1.0e9) as i32,
                    x1: (x1 + 1.0).ceil().min(1.0e9) as i32,
                    y1: (y1 + 1.0).ceil().min(1.0e9) as i32,
                }
                .intersect(&clip)
            }
        };
        if bounds.is_empty() {
            continue;
        }
        let mut id = identity(list, d);
        let reads_screen = draw.program != BUILTIN_PROGRAM
            && facts.program(draw.program - 1).reads_screen
            && draw.flags & DRAW_TO_BACK_BUFFER == 0;
        if reads_screen {
            id = mix(mix(mix(id, hash_of(&back)), mips), u64::from(sample_mips));
        }
        let per_pixel_back = draw.program == BUILTIN_PROGRAM
            && draw.flags & (DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE) != 0;
        let bw = (bounds.x1 - bounds.x0) as usize;
        let bh = (bounds.y1 - bounds.y0) as usize;
        state.clear();
        state.resize(bw * bh, if vertex_stage { 1 } else { 0 });
        if !vertex_stage {
            let over = overwrite_state(list, d, facts);
            let opacity = facts.opacity(draw.texture);
            let reduce = opacity.map_or(1, |o| {
                crate::downscale_factor(o.width(), o.height(), facts.max_texture_side())
            });
            // Per pixel: bit 0 touched; bits 1..=9 the centre and eight points MARGIN around it
            // lie in some triangle (closed); bit 10 a triangle holding the centre found its
            // texels opaque, bit 11 one found them not.
            const SAMPLES: [[f64; 2]; 9] = [
                [0.0, 0.0],
                [-MARGIN, 0.0],
                [MARGIN, 0.0],
                [0.0, -MARGIN],
                [0.0, MARGIN],
                [-MARGIN, -MARGIN],
                [MARGIN, -MARGIN],
                [-MARGIN, MARGIN],
                [MARGIN, MARGIN],
            ];
            for &(p, uv) in &tris {
                let a2 = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1])
                    - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
                if a2 == 0.0 || !a2.is_finite() {
                    continue;
                }
                let s = a2.signum();
                // Signed distances to the three edges, positive inside.
                let edges: Vec<([f64; 2], [f64; 2], f64)> = (0..3)
                    .map(|k| {
                        let (a, b) = (p[k], p[(k + 1) % 3]);
                        let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
                        (a, b, len)
                    })
                    .collect();
                let dist = |q: [f64; 2]| -> f64 {
                    edges
                        .iter()
                        .map(|(a, b, len)| {
                            s * ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]))
                                / len
                        })
                        .fold(f64::MAX, f64::min)
                };
                let tx0 = p.iter().map(|q| q[0]).fold(f64::MAX, f64::min);
                let tx1 = p.iter().map(|q| q[0]).fold(f64::MIN, f64::max);
                let ty0 = p.iter().map(|q| q[1]).fold(f64::MAX, f64::min);
                let ty1 = p.iter().map(|q| q[1]).fold(f64::MIN, f64::max);
                let x0 = ((tx0 - 1.5 * MARGIN - 0.5).ceil() as i64).max(i64::from(bounds.x0));
                let x1 = ((tx1 + 1.5 * MARGIN - 0.5).floor() as i64).min(i64::from(bounds.x1) - 1);
                let y0 = ((ty0 - 1.5 * MARGIN - 0.5).ceil() as i64).max(i64::from(bounds.y0));
                let y1 = ((ty1 + 1.5 * MARGIN - 0.5).floor() as i64).min(i64::from(bounds.y1) - 1);
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        let q = [x as f64 + 0.5, y as f64 + 0.5];
                        let dq = dist(q);
                        // The diagonal samples reach MARGIN·√2 past the centre.
                        if dq < -1.5 * MARGIN {
                            continue;
                        }
                        let k = (y - i64::from(bounds.y0)) as usize * bw
                            + (x - i64::from(bounds.x0)) as usize;
                        let mut bits = u16::from(dq >= -MARGIN);
                        if over.is_some() {
                            for (j, o) in SAMPLES.iter().enumerate() {
                                if dist([q[0] + o[0], q[1] + o[1]]) >= -1e-9 {
                                    bits |= 2 << j;
                                }
                            }
                            if over == Some(true) && dq >= -1e-9 {
                                let ok = opacity.is_some_and(|o| {
                                    let w1 = ((q[0] - p[0][0]) * (p[2][1] - p[0][1])
                                        - (q[1] - p[0][1]) * (p[2][0] - p[0][0]))
                                        / a2;
                                    let w2 = ((p[1][0] - p[0][0]) * (q[1] - p[0][1])
                                        - (p[1][1] - p[0][1]) * (q[0] - p[0][0]))
                                        / a2;
                                    let w0 = 1.0 - w1 - w2;
                                    let u = |c: usize| {
                                        w0 * f64::from(uv[0][c])
                                            + w1 * f64::from(uv[1][c])
                                            + w2 * f64::from(uv[2][c])
                                    };
                                    texels_opaque(o, draw.sampler, [u(0), u(1)], reduce)
                                });
                                bits |= if ok { 1 << 10 } else { 1 << 11 };
                            }
                        }
                        state[k] |= bits;
                    }
                }
            }
            for st in state.iter_mut() {
                let samples = (*st >> 1) & 0x1ff == 0x1ff;
                let texels = over == Some(false) || (*st & (1 << 10) != 0 && *st & (1 << 11) == 0);
                *st = if *st & 1 == 0 {
                    0
                } else if over.is_some() && samples && texels {
                    2
                } else {
                    1
                };
            }
        }
        let to_back = draw.flags & DRAW_TO_BACK_BUFFER != 0;
        let disabled = Blend::from_u32(draw.blend) == Some(Blend::Disabled);
        let depth_level = if depth.is_empty() || d >= depth_end || !super::tiles::testable(list, d)
        {
            None
        } else {
            crate::depth_level(list, d as u32)
        };
        for y in 0..bh {
            for x in 0..bw {
                let st = state[y * bw + x];
                if st == 0 {
                    continue;
                }
                let i = (bounds.y0 as usize + y) * w + bounds.x0 as usize + x;
                if depth_level.is_some_and(|l| depth[i] > l) {
                    // Rejected by the depth test.
                    continue;
                }
                let mut id = id;
                if per_pixel_back {
                    id = mix(id, back[i]);
                }
                if to_back {
                    back[i] = mix(mix(back[i], id), u64::from(st));
                    continue;
                }
                match (st, opaque) {
                    (2, true) => {
                        rgb[i] = mix(9, id);
                        if disabled {
                            alpha[i] = mix(10, id);
                        }
                    }
                    (2, false) => {
                        rgb[i] = mix(9, id);
                        alpha[i] = mix(10, id);
                    }
                    (_, true) => {
                        rgb[i] = mix(rgb[i], id);
                        if disabled {
                            alpha[i] = mix(alpha[i], id);
                        }
                    }
                    (_, false) => {
                        let (c, a) = (rgb[i], alpha[i]);
                        rgb[i] = mix(mix(c, a), id);
                        alpha[i] = mix(mix(a, c), id);
                    }
                }
            }
        }
    }
    Provenance {
        width: w as u32,
        height: h as u32,
        rgb,
        alpha,
    }
}
