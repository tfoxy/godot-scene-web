//! Dead owner-alpha cells. The caller has already checked the shared group gates.
use super::{GroupRange, PxRect};
use crate::{
    cover::CoverFacts, DrawList, GroupCells, Sampler, DRAW_GROUP_CLIP, DRAW_GROUP_COMPOSITE,
    DRAW_MSDF, DRAW_UNTEXTURED, ITEM_UNTEXTURED,
};
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct Cells {
    memo: HashMap<u64, Memo>,
    inputs: Vec<u32>,
    used: Vec<u64>,
    /// Number of cell classifications, for checking memo invalidation.
    pub classified: u64,
}
struct Memo {
    inputs: Vec<u32>,
    rects: Vec<[i32; 4]>,
}
struct Triangle<'a> {
    p: [[f64; 2]; 3],
    uv: [[f64; 2]; 3],
    det: f64,
    alpha: &'a crate::alpha::AlphaTable,
    sampler: u32,
}
impl Cells {
    pub fn begin(&mut self) {
        self.used.clear();
    }
    pub fn finish(&mut self) {
        self.memo.retain(|key, _| self.used.contains(key));
    }

    pub fn prepare(
        &mut self,
        list: &DrawList,
        g: &GroupRange,
        rect: PxRect,
        facts: &impl CoverFacts,
    ) -> Option<GroupCells> {
        if g.first == g.composite.start || rect.x0 >= rect.x1 || rect.y0 >= rect.y1 {
            return None;
        }
        self.inputs.clear();
        self.inputs.extend([
            rect.x0 as u32,
            rect.y0 as u32,
            rect.x1 as u32,
            rect.y1 as u32,
        ]);
        let mut key = 0xcbf29ce484222325u64;
        let mut hash = |n: u32| {
            key = (key ^ u64::from(n)).wrapping_mul(0x100000001b3);
        };
        // Content identity survives compaction and culling changes. It is only a lookup key:
        // every input is compared below, including geometry, rows and texture revision.
        for d in list.draws.get(g.composite.clone())? {
            if d.flags & (DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE) != DRAW_GROUP_CLIP
                || d.flags & (DRAW_MSDF | DRAW_UNTEXTURED) != 0
                || d.index_count % 3 != 0
            {
                return None;
            }
            let opacity = facts.opacity(d.texture)?;
            let max = facts.max_texture_side();
            if max != 0 && (opacity.width() > max || opacity.height() > max) {
                return None;
            }
            self.inputs.extend([
                d.texture,
                d.index_count,
                d.sampler,
                opacity.id() as u32,
                (opacity.id() >> 32) as u32,
            ]);
            hash(d.texture);
            hash(d.index_count);
            let end = d.first_index.checked_add(d.index_count)? as usize;
            for &ix in list.indices.get(d.first_index as usize..end)? {
                let v = list.vertices.get(ix as usize)?;
                let row = list.items.get(v.item as usize)?;
                if row.flags & ITEM_UNTEXTURED != 0 || !v.uv.iter().all(|x| x.is_finite()) {
                    return None;
                }
                self.inputs.extend(v.pos.map(f32::to_bits));
                self.inputs.extend(v.uv.map(f32::to_bits));
                self.inputs.extend(row.xform.map(f32::to_bits));
                for n in v.uv.map(f32::to_bits) {
                    hash(n);
                }
            }
        }
        // Several owners may share the same texture, indices and UVs in one frame.
        // Include their full verified input in the lookup so they cannot evict each other.
        for &n in &self.inputs {
            hash(n);
        }
        self.used.push(key);
        if let Some(m) = self.memo.get(&key).filter(|m| m.inputs == self.inputs) {
            return (!m.rects.is_empty()).then(|| GroupCells {
                draws: g.first..g.composite.start,
                rects: m.rects.clone(),
            });
        }
        let mut triangles = Vec::new();
        for d in &list.draws[g.composite.clone()] {
            let alpha = facts.opacity(d.texture)?.nonzero()?;
            for indices in list.indices
                [d.first_index as usize..(d.first_index + d.index_count) as usize]
                .chunks_exact(3)
            {
                let mut p = [[0.; 2]; 3];
                let mut uv = [[0.; 2]; 3];
                for (i, &ix) in indices.iter().enumerate() {
                    let v = &list.vertices[ix as usize];
                    p[i] = super::super::place(&list.items[v.item as usize].xform, None, v.pos);
                    uv[i] = v.uv.map(f64::from);
                }
                let det = cross(sub(p[1], p[0]), sub(p[2], p[0]));
                // Ill-conditioned inverses cannot prove a dead footprint.
                if !det.is_finite() || det.abs() < 1e-8 {
                    return None;
                }
                triangles.push(Triangle {
                    p,
                    uv,
                    det,
                    alpha,
                    sampler: d.sampler,
                });
            }
        }
        let affine = Affine::shared(&triangles);
        let mut rects: Vec<[i32; 4]> = Vec::new();
        let mut open: Vec<(i32, i32, usize)> = Vec::new();
        let mut next = Vec::new();
        let mut poly = Vec::with_capacity(8);
        let mut scratch = Vec::with_capacity(8);
        let x_start = rect.x0.div_euclid(16) * 16;
        let y_start = rect.y0.div_euclid(16) * 16;
        let block_x = rect.x0.div_euclid(64) * 64;
        let mut block_y = i32::MIN;
        let mut blocks = Vec::new();
        for y in (y_start..rect.y1).step_by(16) {
            let by = y.div_euclid(64) * 64;
            if block_y != by {
                block_y = by;
                blocks.clear();
                for bx in (block_x..rect.x1).step_by(64) {
                    self.classified += 1;
                    let cell = [
                        bx.max(rect.x0) as f64 - 0.5,
                        by.max(rect.y0) as f64 - 0.5,
                        (bx + 64).min(rect.x1) as f64 + 0.5,
                        (by + 64).min(rect.y1) as f64 + 0.5,
                    ];
                    blocks.push(affine.as_ref().map_or_else(
                        || {
                            triangles
                                .iter()
                                .any(|t| t.live(cell, &mut poly, &mut scratch))
                        },
                        |a| a.live(cell),
                    ));
                }
            }
            next.clear();
            let (y0, y1) = (y.max(rect.y0), (y + 16).min(rect.y1));
            let mut run = None;
            for x in (x_start..rect.x1).step_by(16) {
                let (x0, x1) = (x.max(rect.x0), (x + 16).min(rect.x1));
                let cell = [
                    x0 as f64 - 0.5,
                    y0 as f64 - 0.5,
                    x1 as f64 + 0.5,
                    y1 as f64 + 0.5,
                ];
                let live = if blocks[((x - block_x) / 64) as usize] {
                    self.classified += 1;
                    affine.as_ref().map_or_else(
                        || {
                            triangles
                                .iter()
                                .any(|t| t.live(cell, &mut poly, &mut scratch))
                        },
                        |a| a.live(cell),
                    )
                } else {
                    false
                };
                if !live {
                    run.get_or_insert(x0);
                }
                if (live || x1 == rect.x1) && run.is_some() {
                    let start = run.take().unwrap();
                    let end = if live { x0 } else { x1 };
                    let at = if let Some(o) = open.iter().find(|o| o.0 == start && o.1 == end) {
                        rects[o.2][3] = y1 - rects[o.2][1];
                        o.2
                    } else {
                        rects.push([start, y0, end - start, y1 - y0]);
                        rects.len() - 1
                    };
                    next.push((start, end, at));
                }
            }
            std::mem::swap(&mut open, &mut next);
        }
        self.memo.insert(
            key,
            Memo {
                inputs: self.inputs.clone(),
                rects: rects.clone(),
            },
        );
        (!rects.is_empty()).then(|| GroupCells {
            draws: g.first..g.composite.start,
            rects,
        })
    }
}
fn sub(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}
fn cross(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
impl Triangle<'_> {
    fn live(&self, cell: [f64; 4], poly: &mut Vec<[f64; 2]>, scratch: &mut Vec<[f64; 2]>) -> bool {
        super::super::clip_poly(&self.p, cell, poly, scratch);
        if poly.is_empty() {
            return false;
        }
        let mut lo = [f64::INFINITY; 2];
        let mut hi = [f64::NEG_INFINITY; 2];
        for &p in poly.iter() {
            let rel = sub(p, self.p[0]);
            let a = cross(rel, sub(self.p[2], self.p[0])) / self.det;
            let b = cross(sub(self.p[1], self.p[0]), rel) / self.det;
            for k in 0..2 {
                let v = self.uv[0][k]
                    + a * (self.uv[1][k] - self.uv[0][k])
                    + b * (self.uv[2][k] - self.uv[0][k]);
                lo[k] = lo[k].min(v);
                hi[k] = hi[k].max(v);
            }
        }
        footprint_live(self.alpha, self.sampler, lo, hi)
    }
}

/// One affine map for a whole owner. The un-clipped cell bbox contains every clipped
/// triangle footprint. Its intersection with the owner's UV extent remains conservative.
struct Affine<'a> {
    map: [[f64; 3]; 2],
    error: [f64; 2],
    screen: [f64; 4],
    uv: [f64; 4],
    alpha: &'a crate::alpha::AlphaTable,
    sampler: u32,
}
impl<'a> Affine<'a> {
    fn shared(ts: &[Triangle<'a>]) -> Option<Self> {
        // Only the two triangles of a quad use this shortcut. A lone triangle and
        // arbitrary meshes keep the tighter polygon path (including outside-triangle cells).
        if ts.len() != 2 {
            return None;
        }
        let mut points = Vec::with_capacity(4);
        for p in ts.iter().flat_map(|t| t.p) {
            if !points.contains(&p) {
                points.push(p);
            }
        }
        if points.len() != 4 {
            return None;
        }
        let t = ts.first()?;
        let a = sub(t.p[1], t.p[0]);
        let b = sub(t.p[2], t.p[0]);
        let map = std::array::from_fn(|k| {
            let u = t.uv[1][k] - t.uv[0][k];
            let v = t.uv[2][k] - t.uv[0][k];
            let dx = (u * b[1] - v * a[1]) / t.det;
            let dy = (v * a[0] - u * b[0]) / t.det;
            [dx, dy, t.uv[0][k] - dx * t.p[0][0] - dy * t.p[0][1]]
        });
        let mut out = Self {
            map,
            error: [1e-10; 2],
            screen: [
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ],
            uv: [
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ],
            alpha: t.alpha,
            sampler: t.sampler,
        };
        for t in ts {
            if !std::ptr::eq(t.alpha, out.alpha) || t.sampler != out.sampler {
                return None;
            }
            for (&p, uv) in t.p.iter().zip(t.uv) {
                for k in 0..2 {
                    let mapped = map[k][0] * p[0] + map[k][1] * p[1] + map[k][2];
                    let error = (mapped - uv[k]).abs();
                    if !error.is_finite() || error > 1e-7 {
                        return None;
                    }
                    // The difference of two affine maps inside a triangle is a convex
                    // combination of its vertex differences. Bound it, never assume equality.
                    out.error[k] = out.error[k].max(error + 1e-10);
                    out.screen[k] = out.screen[k].min(p[k]);
                    out.screen[k + 2] = out.screen[k + 2].max(p[k]);
                    out.uv[k] = out.uv[k].min(uv[k]);
                    out.uv[k + 2] = out.uv[k + 2].max(uv[k]);
                }
            }
        }
        Some(out)
    }
    fn live(&self, cell: [f64; 4]) -> bool {
        if cell[0] > self.screen[2]
            || cell[2] < self.screen[0]
            || cell[1] > self.screen[3]
            || cell[3] < self.screen[1]
        {
            return false;
        }
        let mut lo = [0.; 2];
        let mut hi = [0.; 2];
        for k in 0..2 {
            let [dx, dy, c] = self.map[k];
            let (x0, x1) = if dx >= 0. {
                (cell[0], cell[2])
            } else {
                (cell[2], cell[0])
            };
            let (y0, y1) = if dy >= 0. {
                (cell[1], cell[3])
            } else {
                (cell[3], cell[1])
            };
            lo[k] = (dx * x0 + dy * y0 + c - self.error[k]).max(self.uv[k]);
            hi[k] = (dx * x1 + dy * y1 + c + self.error[k]).min(self.uv[k + 2]);
            if lo[k] > hi[k] {
                return false;
            }
        }
        footprint_live(self.alpha, self.sampler, lo, hi)
    }
}
fn footprint_live(
    alpha: &crate::alpha::AlphaTable,
    sampler: u32,
    lo: [f64; 2],
    hi: [f64; 2],
) -> bool {
    let mut spans = [(0, 0); 2];
    for (k, size) in [alpha.width, alpha.height].into_iter().enumerate() {
        // Bilinear footprint plus interpolation error. Clamp samples the edge texel even
        // wholly outside the texture. A wrapping footprint crossing a border stays live.
        let a = (lo[k] * size as f64 - 1.5 - 1e-7).floor();
        let b = (hi[k] * size as f64 + 1.5 + 1e-7).ceil();
        if !a.is_finite() || !b.is_finite() {
            return true;
        }
        if sampler & Sampler::WRAP_MASK != Sampler::CLAMP && (a < 0. || b >= size as f64) {
            return true;
        }
        spans[k] = (
            a.clamp(0., (size - 1) as f64) as u32,
            b.clamp(0., (size - 1) as f64) as u32,
        );
    }
    alpha.any(spans[0].0, spans[1].0, spans[0].1, spans[1].1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cover::ProgramFacts, opacity::Opacity, Draw, Item, Vertex};
    struct Facts(Opacity);
    impl CoverFacts for Facts {
        fn opacity(&self, _: u32) -> Option<&Opacity> {
            Some(&self.0)
        }
        fn program(&self, _: u32) -> ProgramFacts {
            ProgramFacts::UNKNOWN
        }
    }
    #[test]
    fn memo_holds_and_recomputes_each_changed_input() {
        let mut l = DrawList::default();
        l.items.push(Item {
            xform: [1., 0., 0., 1., 0., 0.],
            ..Item::default()
        });
        for pos in [[0., 0.], [128., 0.], [0., 128.]] {
            l.vertices.push(Vertex {
                pos,
                uv: [pos[0] / 128., pos[1] / 128.],
                ..Vertex::default()
            });
        }
        l.indices.extend([0, 1, 2]);
        l.draws.extend([
            Draw::default(),
            Draw {
                flags: DRAW_GROUP_CLIP,
                index_count: 3,
                ..Draw::default()
            },
        ]);
        let rect = PxRect::xywh([0, 0, 128, 128]);
        let g = GroupRange {
            first: 0,
            composite: 1..2,
        };
        let rgba = vec![0; 128 * 128 * 4];
        let mut f = Facts(Opacity::from_rgba8(128, 128, &rgba));
        let mut c = Cells::default();
        c.prepare(&l, &g, rect, &f).unwrap();
        let n = c.classified;
        c.prepare(&l, &g, rect, &f).unwrap();
        assert_eq!(c.classified, n);
        for change in 0..5 {
            match change {
                0 => l.vertices[0].pos[0] += 0.25,
                1 => l.vertices[0].uv[0] += 0.01,
                2 => l.items[0].xform[4] += 0.25,
                3 => f = Facts(Opacity::from_rgba8(128, 128, &rgba)),
                4 => l.draws[1].sampler = Sampler::LINEAR,
                _ => unreachable!(),
            }
            let old = c.classified;
            c.prepare(&l, &g, rect, &f).unwrap();
            assert!(c.classified > old, "change {change}");
            let new = c.classified;
            c.prepare(&l, &g, rect, &f).unwrap();
            assert_eq!(c.classified, new);
        }
    }
    #[test]
    fn owners_sharing_texture_and_uv_do_not_evict_each_other() {
        let mut l = DrawList::default();
        l.items.push(Item {
            xform: [1., 0., 0., 1., 0., 0.],
            ..Item::default()
        });
        for pos in [[0., 0.], [128., 0.], [0., 128.]] {
            l.vertices.push(Vertex {
                pos,
                uv: [pos[0] / 128., pos[1] / 128.],
                ..Vertex::default()
            });
        }
        l.indices.extend([0, 1, 2]);
        l.draws.extend([
            Draw::default(),
            Draw {
                flags: DRAW_GROUP_CLIP,
                index_count: 3,
                ..Draw::default()
            },
        ]);
        let g = GroupRange {
            first: 0,
            composite: 1..2,
        };
        let f = Facts(Opacity::from_rgba8(128, 128, &vec![0; 128 * 128 * 4]));
        let mut c = Cells::default();
        for pass in 0..2 {
            let before = c.classified;
            c.begin();
            for x in [0., 128.] {
                l.items[0].xform[4] = x;
                c.prepare(&l, &g, PxRect::xywh([x as i32, 0, 128, 128]), &f)
                    .unwrap();
            }
            c.finish();
            if pass == 1 {
                assert_eq!(
                    c.classified, before,
                    "each owner's memo must survive the other owner"
                );
            }
        }
    }
}
