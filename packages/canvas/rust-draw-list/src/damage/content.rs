use super::{signature::Hash, DamageFacts};
use crate::cover::{self, CoverFacts, ProgramFacts, PxRect};
use crate::{Draw, DrawList, InstancedDraw, Ranges, DRAW_INSTANCED, DRAW_SCISSOR, DRAW_SCREEN_OPS};

pub(super) struct Content {
    draw: Draw,
    instanced: Option<InstancedDraw>,
    vertices: (u32, u32),
    items: (u32, u32),
    pub(super) hash: Hash,
    bounds: PxRect,
    clip: PxRect,
}
#[derive(Default)]
pub(super) struct ContentCache {
    pub draws: Vec<Content>,
    target: Option<[u32; 9]>,
}
fn hits(ranges: &Ranges, span: (u32, u32)) -> bool {
    span.0 < span.1
        && ranges
            .as_slice()
            .iter()
            .any(|&(a, b)| a < span.1 && span.0 < b)
}
fn instance(list: &DrawList, d: usize) -> Option<InstancedDraw> {
    (list.draws[d].flags & DRAW_INSTANCED != 0)
        .then(|| {
            list.instanced
                .binary_search_by_key(&(d as u32), |r| r.draw)
                .ok()
                .map(|i| list.instanced[i])
        })
        .flatten()
}
impl ContentCache {
    pub fn update(&mut self, list: &DrawList) {
        let t = list.target;
        let target = [
            t.width,
            t.height,
            t.format as u32,
            t.clear[0].to_bits(),
            t.clear[1].to_bits(),
            t.clear[2].to_bits(),
            t.clear[3].to_bits(),
            u32::from(t.opaque),
            t.surface,
        ];
        if self.target != Some(target) || list.dirty.all {
            self.draws.clear();
        }
        self.target = Some(target);
        self.draws.truncate(list.draws.len());
        for d in 0..list.draws.len() {
            let draw = list.draws[d];
            let instanced = instance(list, d);
            let stale = self.draws.get(d).is_none_or(|c| {
                c.draw != draw
                    || c.instanced != instanced
                    || hits(
                        &list.dirty.indices,
                        (
                            draw.first_index,
                            draw.first_index.saturating_add(draw.index_count),
                        ),
                    )
                    || hits(&list.dirty.vertices, c.vertices)
                    || hits(&list.dirty.items, c.items)
                    || instanced.is_some_and(|r| {
                        hits(
                            &list.dirty.instances,
                            (r.first, r.first.saturating_add(r.count)),
                        )
                    })
            });
            if stale {
                let c = Content::new(list, d, instanced);
                if d == self.draws.len() {
                    self.draws.push(c);
                } else {
                    self.draws[d] = c;
                }
            }
        }
    }
}
// Program readiness and vertex-stage facts can change without a list upload. Cache only the
// geometry bounds, then select the conservative clip for a vertex program each frame.
struct GeometryFacts;
impl CoverFacts for GeometryFacts {
    fn opacity(&self, _: u32) -> Option<&crate::opacity::Opacity> {
        None
    }
    fn program(&self, _: u32) -> ProgramFacts {
        ProgramFacts {
            reads_screen: false,
            vertex_stage: false,
            alpha: None,
        }
    }
}
impl Content {
    pub fn bounds(&self, facts: &impl DamageFacts) -> PxRect {
        if self.draw.program != 0 && facts.program(self.draw.program - 1).vertex_stage {
            self.clip
        } else {
            self.bounds
        }
    }

    fn new(list: &DrawList, d: usize, instanced: Option<InstancedDraw>) -> Self {
        let draw = list.draws[d];
        let mut h = Hash::new();
        h.word(0xd0);
        for v in [
            draw.texture,
            draw.sampler,
            draw.blend,
            draw.program,
            draw.flags & !DRAW_SCREEN_OPS,
            draw.msdf[0].to_bits(),
            draw.msdf[1].to_bits(),
        ] {
            h.word(u64::from(v));
        }
        if draw.flags & DRAW_SCISSOR != 0 {
            for v in draw.scissor {
                h.word(v as u64);
            }
        }
        let from = (draw.first_index as usize).min(list.indices.len());
        let to = (from + draw.index_count as usize).min(list.indices.len());
        let indices = &list.indices[from..to];
        let base = indices.iter().copied().min().unwrap_or(0);
        let end = indices
            .iter()
            .copied()
            .max()
            .map_or(base, |v| v.saturating_add(1));
        h.word(indices.len() as u64);
        for &i in indices {
            h.word(u64::from(i - base));
        }
        let mut rows = indices.to_vec();
        rows.sort_unstable();
        rows.dedup();
        let mut item_hashes = std::collections::BTreeMap::new();
        let mut items = (u32::MAX, 0);
        // The full vertex span is conservative, including unreferenced rows in its gaps.
        for v in list
            .vertices
            .get((base as usize).min(list.vertices.len())..(end as usize).min(list.vertices.len()))
            .unwrap_or(&[])
        {
            items.0 = items.0.min(v.item);
            items.1 = items.1.max(v.item.saturating_add(1));
        }
        for i in rows {
            if let Some(v) = list.vertices.get(i as usize) {
                h.word(1);
                h.bytes(bytemuck::cast_slice(&v.pos));
                h.bytes(bytemuck::cast_slice(&v.uv));
                h.bytes(bytemuck::cast_slice(&v.color));
                let item = item_hashes.entry(v.item).or_insert_with(|| {
                    let mut row = Hash::new();
                    if let Some(item) = list.items.get(v.item as usize) {
                        row.word(1);
                        row.bytes(bytemuck::bytes_of(item));
                    } else {
                        row.word(0);
                    }
                    row.0
                });
                h.word(*item);
            } else {
                h.word(0);
            }
        }
        if draw.flags & DRAW_INSTANCED != 0 {
            if let Some(r) = instanced {
                let from = (r.first as usize).min(list.instances.len());
                let to = (from + r.count as usize).min(list.instances.len());
                h.bytes(bytemuck::cast_slice(&list.instances[from..to]));
            } else {
                h.word(0);
            }
        }
        Self {
            draw,
            instanced,
            vertices: (base, end),
            items,
            hash: h,
            bounds: cover::draw_bounds(list, d, &GeometryFacts),
            clip: if draw.flags & DRAW_SCISSOR != 0 {
                PxRect::xywh(draw.scissor).intersect(&PxRect::xywh([
                    0,
                    0,
                    list.target.width as i32,
                    list.target.height as i32,
                ]))
            } else {
                PxRect::xywh([0, 0, list.target.width as i32, list.target.height as i32])
            },
        }
    }
}
