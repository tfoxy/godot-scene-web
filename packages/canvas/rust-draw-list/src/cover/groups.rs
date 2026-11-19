//! Restrict a canvas group's work to pixels its composite can show. This runs on the assembled
//! table, applying its edits after cover compaction. It changes only scissors and copy regions; clears
//! retain their full-target semantics. Group ranges come from the producer's group bookkeeping,
//! including owners with custom materials (which cannot themselves be optimized here).

use super::{CoverFacts, PxRect, FAR};
use crate::{
    Blend, Draw, DrawList, ScreenOp, ScreenOpKind, BUILTIN_PROGRAM, DRAW_GROUP_CLIP,
    DRAW_GROUP_COMPOSITE, DRAW_INSTANCED, DRAW_SCISSOR, DRAW_TO_BACK_BUFFER,
};
use std::ops::Range;

/// One non-nested back-buffer group, in the producer's assembled draw table. The composite can
/// contain several draws. Nested owners drawn plainly inside an open group are not separate
/// ranges. An executor needs no new state: the walk writes ordinary draw scissors and Copy ops.
#[derive(Clone, Debug)]
pub struct GroupRange {
    /// First back-buffer draw (or the first composite draw when there are no children).
    pub first: usize,
    /// All draws of the owner that close the group, excluding its pre-owner back-buffer pass.
    pub composite: Range<usize>,
}

#[derive(Default)]
struct Geometry {
    // Every indexed position and its row transform: no texture or UV facts are needed for a
    // quad bound. Checking these values also handles row-only movement and vertex animation.
    inputs: Vec<[f32; 8]>,
    rect: Option<PxRect>,
}

impl Geometry {
    fn bounds(
        &mut self,
        list: &DrawList,
        range: Range<usize>,
        facts: &impl CoverFacts,
    ) -> Option<PxRect> {
        let result = self.compute_bounds(list, range, facts);
        if result.is_none() {
            self.rect = None;
        }
        result
    }

    fn compute_bounds(
        &mut self,
        list: &DrawList,
        range: Range<usize>,
        facts: &impl CoverFacts,
    ) -> Option<PxRect> {
        let mut at = 0;
        let mut same = self.rect.is_some();
        for d in list.draws.get(range)? {
            if d.flags & DRAW_INSTANCED != 0
                || (d.program != BUILTIN_PROGRAM && facts.program(d.program - 1).vertex_stage)
            {
                self.rect = None;
                return None;
            }
            let end = d.first_index.checked_add(d.index_count)? as usize;
            for &ix in list.indices.get(d.first_index as usize..end)? {
                let v = list.vertices.get(ix as usize)?;
                let x = list.items.get(v.item as usize)?.xform;
                // Use the same bounded-coordinate rule as the cover walk, keeping the one-pixel
                // outward guard wider than transform rounding and rasterizer snapping.
                if super::far(&x, None, v.pos) {
                    self.rect = None;
                    return None;
                }
                let input = [v.pos[0], v.pos[1], x[0], x[1], x[2], x[3], x[4], x[5]];
                if self.inputs.get(at) != Some(&input) {
                    same = false;
                    if at == self.inputs.len() {
                        self.inputs.push(input);
                    } else {
                        self.inputs[at] = input;
                    }
                }
                at += 1;
            }
        }
        same &= at == self.inputs.len();
        self.inputs.truncate(at);
        if same {
            return self.rect;
        }
        if at == 0 {
            self.rect = None;
            return None;
        }
        let mut bounds = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for v in &self.inputs {
            let p = super::place(&[v[2], v[3], v[4], v[5], v[6], v[7]], None, [v[0], v[1]]);
            if p.iter().any(|x| !x.is_finite() || x.abs() > FAR * 4.0) {
                self.rect = None;
                return None;
            }
            bounds[0] = bounds[0].min(p[0]);
            bounds[1] = bounds[1].min(p[1]);
            bounds[2] = bounds[2].max(p[0]);
            bounds[3] = bounds[3].max(p[1]);
        }
        self.rect = Some(PxRect {
            x0: bounds[0].floor() as i32 - 1,
            y0: bounds[1].floor() as i32 - 1,
            x1: bounds[2].ceil() as i32 + 1,
            y1: bounds[3].ceil() as i32 + 1,
        });
        self.rect
    }
}

#[derive(Clone, PartialEq)]
struct Patch<T> {
    at: usize,
    before: T,
    after: T,
}

/// Reusable facts and reversible edits over an assembled table. Restore before the producer
/// changes that table; prepare/apply after final item rows are written. Restore edits on the
/// compacted table before undoing cover compaction. Equal results do not dirty the table on an
/// otherwise unchanged frame.
#[derive(Default)]
pub struct GroupWalk {
    geometry: Vec<Geometry>,
    draws: Vec<Patch<Draw>>,
    ops: Vec<Patch<ScreenOp>>,
    next_draws: Vec<Patch<Draw>>,
    next_ops: Vec<Patch<ScreenOp>>,
    applied: bool,
}

fn xywh(r: PxRect) -> [i32; 4] {
    [r.x0, r.y0, (r.x1 - r.x0).max(0), (r.y1 - r.y0).max(0)]
}

impl GroupWalk {
    pub fn restore(&mut self, list: &mut DrawList) {
        if !self.applied {
            return;
        }
        for p in &self.draws {
            list.draws[p.at] = p.before;
        }
        for p in &self.ops {
            list.screen_ops[p.at] = p.before;
        }
        self.applied = false;
    }

    /// Compute edits, failing closed for every unknown group, geometry or program fact.
    pub fn prepare(
        &mut self,
        list: &DrawList,
        groups: &[GroupRange],
        facts: &impl CoverFacts,
        on: bool,
    ) {
        assert!(
            !self.applied,
            "restore group edits before preparing the next table"
        );
        self.next_draws.clear();
        self.next_ops.clear();
        self.geometry.resize_with(groups.len(), Geometry::default);
        if !on {
            return;
        }
        let target = PxRect::xywh([0, 0, list.target.width as i32, list.target.height as i32]);
        let mut bounds = Vec::with_capacity(groups.len());
        let mut openings = Vec::with_capacity(groups.len());
        for (g, memo) in groups.iter().zip(&mut self.geometry) {
            bounds.push(memo.bounds(list, g.composite.clone(), facts));
            openings.push(list.screen_ops.iter().rposition(|op| {
                op.before as usize == g.first
                    && matches!(op.kind, ScreenOpKind::Copy | ScreenOpKind::Clear)
            }));
        }
        // Back-buffer leftovers must not be observable by a later composite outside its own
        // rewritten region. Unknown bounds also fail this gate for every preceding group.
        let mut later_safe = true;
        for (i, g) in groups.iter().enumerate().rev() {
            let opening = openings[i].map(|at| (at, list.screen_ops[at]));
            let region = opening.map(|(_, op)| {
                if op.kind == ScreenOpKind::Clear {
                    target
                } else {
                    PxRect::xywh(op.region)
                }
            });
            let within = match (bounds[i], region) {
                (Some(_), Some(r)) => g
                    .composite
                    .clone()
                    .all(|d| r.contains(&super::draw_bounds(list, d, facts))),
                _ => false,
            };
            let safe_after = later_safe;
            later_safe &= within;
            let (Some(bbox), Some(region), Some((op_at, op))) = (bounds[i], region, opening) else {
                continue;
            };
            if !safe_after
                || !within
                || g.first > g.composite.start
                || g.composite.is_empty()
                || g.composite.end > list.draws.len()
                || !g.composite.clone().all(|d| {
                    let d = &list.draws[d];
                    d.program == BUILTIN_PROGRAM
                        && d.flags & (DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE) != 0
                        && matches!(
                            Blend::from_u32(d.blend),
                            Some(Blend::Mix | Blend::Add | Blend::Sub)
                        )
                })
                || list.draws[g.first..g.composite.start]
                    .iter()
                    .any(|d| d.flags & DRAW_TO_BACK_BUFFER == 0)
                || list.screen_ops.iter().enumerate().any(|(at, o)| {
                    at != op_at
                        && o.before as usize >= g.first
                        && (o.before as usize) < g.composite.end
                })
                || op.mipmaps
            {
                continue;
            }
            // A partial copy does not make an arbitrary SCREEN_TEXTURE read safe. Require a
            // full overwrite before any later screen reader or mip generation can see leftovers.
            let mut rewritten = false;
            let mut safe = true;
            let mut ops = list
                .screen_ops
                .iter()
                .filter(|o| o.before as usize >= g.composite.end)
                .peekable();
            for d in g.composite.end..list.draws.len() {
                while let Some(o) = ops.next_if(|o| o.before as usize <= d) {
                    if o.kind == ScreenOpKind::Clear
                        || (o.kind == ScreenOpKind::Copy
                            && !openings.iter().any(|at| {
                                at.is_some_and(|at| list.screen_ops[at].before == o.before)
                            })
                            && PxRect::xywh(o.region).contains(&target))
                    {
                        rewritten = true;
                    }
                    if !rewritten && (o.kind == ScreenOpKind::Mipmaps || o.mipmaps) {
                        safe = false;
                    }
                }
                let draw = &list.draws[d];
                if !rewritten
                    && draw.flags & DRAW_TO_BACK_BUFFER == 0
                    && draw.program != BUILTIN_PROGRAM
                    && facts.program(draw.program - 1).reads_screen
                {
                    safe = false;
                    break;
                }
            }
            if !safe {
                continue;
            }
            let visible = bbox.intersect(&target).intersect(&region);
            for at in g.first..g.composite.end {
                let before = list.draws[at];
                let rect = if before.flags & DRAW_SCISSOR != 0 {
                    visible.intersect(&PxRect::xywh(before.scissor))
                } else {
                    visible
                };
                let after = Draw {
                    flags: before.flags | DRAW_SCISSOR,
                    scissor: xywh(rect),
                    ..before
                };
                if before != after {
                    self.next_draws.push(Patch { at, before, after });
                }
            }
            if op.kind == ScreenOpKind::Copy {
                let after = ScreenOp {
                    region: xywh(visible),
                    ..op
                };
                if op != after {
                    self.next_ops.push(Patch {
                        at: op_at,
                        before: op,
                        after,
                    });
                }
            }
        }
    }

    /// Apply the prepared edits after optional cover compaction. Only scissor state and Copy
    /// regions are transferred: compaction's operation flags and draw ordering remain intact.
    pub fn apply_compacted(
        &mut self,
        list: &mut DrawList,
        kept: Option<(&[bool], &[bool])>,
    ) -> bool {
        if self.next_draws.is_empty() && self.next_ops.is_empty() {
            return self.apply(list);
        }
        fn mapping(kept: &[bool]) -> Vec<Option<usize>> {
            let mut next = 0;
            kept.iter()
                .map(|&keep| {
                    if keep {
                        let at = next;
                        next += 1;
                        Some(at)
                    } else {
                        None
                    }
                })
                .collect()
        }
        let (draw_map, op_map) = kept
            .map(|(d, o)| (mapping(d), mapping(o)))
            .unwrap_or_default();
        self.next_draws.retain_mut(|p| {
            if kept.is_some() {
                let Some(at) = draw_map.get(p.at).copied().flatten() else {
                    return false;
                };
                p.at = at;
            }
            let before = list.draws[p.at];
            p.after = Draw {
                scissor: p.after.scissor,
                flags: before.flags | DRAW_SCISSOR,
                ..before
            };
            p.before = before;
            p.before != p.after
        });
        self.next_ops.retain_mut(|p| {
            if kept.is_some() {
                let Some(at) = op_map.get(p.at).copied().flatten() else {
                    return false;
                };
                p.at = at;
            }
            let before = list.screen_ops[p.at];
            p.after = ScreenOp {
                region: p.after.region,
                ..before
            };
            p.before = before;
            p.before != p.after
        });
        self.apply(list)
    }

    /// Restore only the edited fields in a clone for diagnostics without changing this memo.
    pub fn restore_copy(&self, list: &mut DrawList) {
        if self.applied {
            for p in &self.draws {
                list.draws[p.at] = p.before;
            }
            for p in &self.ops {
                list.screen_ops[p.at] = p.before;
            }
        }
    }

    pub fn apply(&mut self, list: &mut DrawList) -> bool {
        let changed = self.draws != self.next_draws || self.ops != self.next_ops;
        std::mem::swap(&mut self.draws, &mut self.next_draws);
        std::mem::swap(&mut self.ops, &mut self.next_ops);
        for p in &self.draws {
            list.draws[p.at] = p.after;
        }
        for p in &self.ops {
            list.screen_ops[p.at] = p.after;
        }
        self.applied = true;
        changed
    }
}
