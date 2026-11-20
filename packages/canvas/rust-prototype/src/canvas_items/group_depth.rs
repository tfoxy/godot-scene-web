//! One depth mask per back-buffer pass. A copy/clear starts a pass; a clear, mipmap operation
//! or target draw ends it. Color-only copies within merged work retain the same depth mask.
//! Producers that combine groups must keep their scissored domains disjoint, so one group's
//! dead cells cannot reject another group's visible fragments.
use gsw_canvas_draw_list::{
    DRAW_TO_BACK_BUFFER, DepthTile, DrawList, MAX_DEPTH_LEVEL, ScreenOp, ScreenOpKind,
};
use std::ops::Range;

pub(super) struct GroupDepthPass {
    pub tiles: Vec<DepthTile>,
    ranges: Vec<Range<usize>>,
    draws: Range<usize>,
}

#[derive(Default)]
pub(super) struct GroupDepth {
    pending: bool,
    pass: Option<GroupDepthPass>,
}

impl GroupDepth {
    pub fn screen_op(&mut self, kind: ScreenOpKind) {
        self.pass = None;
        self.pending = matches!(kind, ScreenOpKind::Copy | ScreenOpKind::Clear);
    }

    /// Return whether an operation ends the current mask. Merged groups retain their own
    /// color copies among the children; a color-only blit leaves depth unchanged.
    pub fn operation(&mut self, op: &ScreenOp) -> bool {
        if color_copy(op)
            && self
                .pass
                .as_ref()
                .is_some_and(|pass| pass.draws.contains(&(op.before as usize)))
        {
            return false;
        }
        self.screen_op(op.kind);
        true
    }

    /// Consume the opening once, even when depth is unavailable. A restored context starts
    /// with fresh objects and the next execution plans from its own copy/clear operations.
    pub fn begin(
        &mut self,
        list: &DrawList,
        first: usize,
        supported: bool,
    ) -> Option<&[DepthTile]> {
        if !std::mem::take(&mut self.pending) || !supported {
            return None;
        }
        let pass = GroupDepthPass::plan(list, first);
        if pass.tiles.is_empty() {
            return None;
        }
        self.pass = Some(pass);
        Some(&self.pass.as_ref().unwrap().tiles)
    }

    pub fn tests(&self, draw: usize) -> bool {
        self.pass.as_ref().is_some_and(|pass| pass.tests(draw))
    }

    pub fn end(&mut self) {
        self.pending = false;
        self.pass = None;
    }
}

impl GroupDepthPass {
    pub fn plan(list: &DrawList, first: usize) -> Self {
        let next_op = list
            .screen_ops
            .iter()
            .filter(|op| op.before as usize > first && !color_copy(op))
            .map(|op| op.before as usize)
            .min()
            .unwrap_or(list.draws.len());
        let end = (first..next_op.min(list.draws.len()))
            .find(|&i| list.draws[i].flags & DRAW_TO_BACK_BUFFER == 0)
            .unwrap_or(next_op.min(list.draws.len()));
        let mut pass = Self {
            tiles: Vec::new(),
            ranges: Vec::new(),
            draws: first..end,
        };
        for group in &list.group_cells {
            if group.draws.start < end && group.draws.end > first && group.draws.end <= end {
                pass.ranges.push(group.draws.clone());
                pass.tiles.extend(group.rects.iter().map(|&rect| DepthTile {
                    rect,
                    level: MAX_DEPTH_LEVEL,
                }));
            }
        }
        pass
    }

    pub fn tests(&self, draw: usize) -> bool {
        self.ranges.iter().any(|range| range.contains(&draw))
    }
}

fn color_copy(op: &ScreenOp) -> bool {
    op.kind == ScreenOpKind::Copy && !op.mipmaps && !op.sample_mips
}

/// The window depth of tile level `level` (`2·level` steps of `1 / (2·(MAX_DEPTH_LEVEL + 1))`)
/// and of a draw tested at `level` (`2·level + 1` steps), in NDC. A tested draw passes `GREATER`
/// exactly where every tile is at its level or below; the half-step gap is 32 steps of a 16-bit
/// depth buffer, so rounding never decides.
pub(super) fn depth_ndc(level: u32, draw: bool) -> f32 {
    let steps = 2 * level.min(MAX_DEPTH_LEVEL) + u32::from(draw);
    let window = f64::from(steps) / f64::from(2 * (MAX_DEPTH_LEVEL + 1));
    (2.0 * window - 1.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas_items::plan_calls;
    use gsw_canvas_draw_list::{DRAW_SCISSOR, DRAW_UNTEXTURED, Draw, GroupCells, ScreenOp};

    fn fixture(two: bool) -> DrawList {
        let mut list = DrawList::default();
        // Two pre-owner/child pairs, followed by their composites. The pairs have disjoint
        // scissored domains, as a producer combining groups into one back-buffer pass requires.
        let count = if two { 4 } else { 2 };
        for i in 0..count {
            list.draws.push(Draw {
                first_index: i * 3,
                index_count: 3,
                flags: DRAW_TO_BACK_BUFFER | DRAW_SCISSOR | DRAW_UNTEXTURED,
                scissor: [if i < 2 { 0 } else { 32 }, 0, 32, 16],
                ..Draw::default()
            });
        }
        list.draws.push(Draw {
            first_index: count * 3,
            index_count: 3,
            ..Draw::default()
        });
        list.indices.resize((count as usize + 1) * 3, 0);
        list.group_cells.push(GroupCells {
            draws: 0..2,
            rects: vec![[0, 0, 16, 16]],
        });
        if two {
            list.group_cells.push(GroupCells {
                draws: 2..4,
                rects: vec![[48, 0, 16, 16]],
            });
        }
        list.screen_ops.push(ScreenOp {
            before: 0,
            kind: ScreenOpKind::Copy,
            region: [0, 0, 64, 16],
            mipmaps: false,
            sample_mips: false,
        });
        list
    }

    // A pixel oracle for the shared pass planner: rasterize whole-pixel rectangles into a
    // 16-bit depth buffer, then issue pre-owner/child fragments at z=0 with GREATER and no
    // depth writes. This is a native planning test; it does not create a WebGL context.
    fn pixels(list: &DrawList, supported: bool) -> (Vec<u8>, Vec<u8>, usize) {
        let mut state = GroupDepth::default();
        let mut depth = vec![0u16; 64 * 16];
        let mut bb = vec![3; depth.len()];
        let mut target = bb.clone();
        let mut prepasses = 0;
        let mut op = 0;
        for (i, draw) in list.draws.iter().enumerate() {
            while op < list.screen_ops.len() && list.screen_ops[op].before as usize <= i {
                state.operation(&list.screen_ops[op]);
                op += 1;
            }
            if draw.flags & DRAW_TO_BACK_BUFFER == 0 {
                state.end();
                assert!(!state.tests(i));
                // The final owner exposes only the live halves; background survives its holes.
                for y in 0..16 {
                    for x in 0..64 {
                        if (16..32).contains(&x) || (32..48).contains(&x) {
                            target[y * 64 + x] = bb[y * 64 + x];
                        }
                    }
                }
                continue;
            }
            if let Some(tiles) = state.begin(list, i, supported) {
                prepasses += 1;
                depth.fill(0);
                for tile in tiles {
                    let [x, y, w, h] = tile.rect;
                    let z = (((depth_ndc(tile.level, false) + 1.0) * 0.5) * 65535.0).round() as u16;
                    for py in y..y + h {
                        for px in x..x + w {
                            depth[py as usize * 64 + px as usize] = z;
                        }
                    }
                }
            }
            let [x, y, w, h] = draw.scissor;
            for py in y..y + h {
                for px in x..x + w {
                    let at = py as usize * 64 + px as usize;
                    if !state.tests(i) || 32768 > depth[at] {
                        bb[at] = 10 + i as u8;
                    }
                }
            }
        }
        (bb, target, prepasses)
    }

    #[test]
    fn cells_reject_pre_owner_and_children_preserving_target_pixels() {
        let list = fixture(false);
        let (bb, target, n) = pixels(&list, true);
        let (full_bb, full_target, _) = pixels(&list, false);
        assert_eq!(n, 1);
        assert_eq!(target, full_target);
        assert_eq!(&bb[..16], &[3; 16]);
        assert_eq!(&full_bb[..16], &[11; 16]);
        assert_eq!(&bb[16..32], &[11; 16]);
    }

    #[test]
    fn two_disjoint_groups_share_one_prepass() {
        let mut list = fixture(true);
        // C6 keeps one Copy at the start of each hoisted group's children. There are two
        // composites after all four back-buffer draws, with no target draw between the copies.
        list.screen_ops[0].region = [0, 0, 32, 16];
        list.screen_ops.push(ScreenOp {
            before: 2,
            region: [32, 0, 32, 16],
            ..list.screen_ops[0]
        });
        list.draws.push(list.draws[4]);
        let (bb, target, n) = pixels(&list, true);
        assert_eq!(n, 1);
        assert_eq!(target, pixels(&list, false).1);
        assert_eq!(&bb[..16], &[3; 16]);
        assert_eq!(&bb[48..64], &[3; 16]);
        assert_eq!(&bb[16..32], &[11; 16]);
        assert_eq!(&bb[32..48], &[13; 16]);
    }

    #[test]
    fn merged_list_keeps_both_groups_cells_across_the_second_copy() {
        use gsw_canvas_draw_list::cover::{
            CoverFacts, ProgramFacts,
            groups::{GroupRange, GroupWalk},
        };
        use gsw_canvas_draw_list::{
            DRAW_GROUP_CLIP, DRAW_SCREEN_OPS, Item, Vertex, opacity::Opacity,
        };
        struct Facts(Opacity);
        impl CoverFacts for Facts {
            fn opacity(&self, id: u32) -> Option<&Opacity> {
                (id == 1).then_some(&self.0)
            }
            fn program(&self, _: u32) -> ProgramFacts {
                ProgramFacts::UNKNOWN
            }
        }
        let facts = Facts(Opacity::from_rgba8(16, 16, &[0; 16 * 16 * 4]));
        let mut list = DrawList::default();
        list.target.width = 128;
        list.target.height = 32;
        list.items.push(Item {
            xform: [1., 0., 0., 1., 0., 0.],
            modulate: [1.; 4],
            ..Item::default()
        });
        let mut groups = Vec::new();
        for x in [0., 80.] {
            let base = list.vertices.len() as u32;
            for uv in [[0., 0.], [1., 0.], [1., 1.], [0., 1.]] {
                list.vertices.push(Vertex {
                    pos: [x + uv[0] * 48., uv[1] * 32.],
                    uv,
                    color: [1.; 4],
                    ..Vertex::default()
                });
            }
            let first_index = list.indices.len() as u32;
            list.indices.extend([0, 1, 2, 0, 2, 3].map(|i| i + base));
            let first = list.draws.len();
            let draw = Draw {
                first_index,
                index_count: 6,
                texture: 1,
                ..Draw::default()
            };
            list.draws.push(Draw {
                flags: DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS,
                ..draw
            });
            list.draws.push(Draw {
                flags: DRAW_GROUP_CLIP,
                ..draw
            });
            groups.push(GroupRange {
                first,
                composite: first + 1..first + 2,
            });
            list.screen_ops.push(ScreenOp {
                before: first as u32,
                kind: ScreenOpKind::Copy,
                region: [0, 0, 128, 32],
                mipmaps: false,
                sample_mips: false,
            });
        }
        let mut walk = GroupWalk::default();
        walk.prepare(&list, &groups, &facts, true);
        walk.apply(&mut list);
        let plain = list.clone();
        assert_eq!(plain.group_cells.len(), 2);
        assert!(walk.merge(&mut list, &facts, true));
        assert!(walk.check_merge(&plain, &list));
        assert_eq!(
            list.screen_ops
                .iter()
                .map(|op| op.before)
                .collect::<Vec<_>>(),
            [0, 1]
        );
        let mut state = GroupDepth::default();
        assert!(state.operation(&list.screen_ops[0]));
        let rects = list
            .group_cells
            .iter()
            .map(|g| g.rects.len())
            .sum::<usize>();
        assert!(rects >= 2);
        assert_eq!(state.begin(&list, 0, true).unwrap().len(), rects);
        assert!(state.tests(0) && state.tests(1));
        assert!(!state.operation(&list.screen_ops[1]));
        assert!(state.begin(&list, 1, true).is_none());
        assert!(state.tests(0) && state.tests(1));
        assert!(!state.tests(2) && !state.tests(3));
        state.end();
        assert!(!state.tests(0));
    }

    #[test]
    fn unavailable_depth_ignores_cells() {
        let mut list = fixture(true);
        let with_facts = pixels(&list, false);
        list.group_cells.clear();
        assert_eq!(with_facts, pixels(&list, true));
        assert_eq!(with_facts.2, 0);
    }

    #[test]
    fn copy_clear_and_fresh_context_rebuild_the_pass() {
        let list = fixture(true);
        let mut state = GroupDepth::default();
        assert!(state.begin(&list, 0, true).is_none());
        for kind in [ScreenOpKind::Copy, ScreenOpKind::Clear] {
            state.screen_op(kind);
            assert_eq!(state.begin(&list, 0, true).unwrap().len(), 2);
            assert!(state.begin(&list, 2, true).is_none());
            assert!(state.tests(0) && state.tests(3));
            state.end();
            assert!(!state.tests(0));
        }
        // No cached pass or pending opening survives context recreation.
        state = GroupDepth::default();
        assert!(state.begin(&list, 0, true).is_none());
        state.screen_op(ScreenOpKind::Copy);
        assert_eq!(state.begin(&list, 0, true).unwrap().len(), 2);
        state.screen_op(ScreenOpKind::Mipmaps);
        assert!(!state.tests(0));
        assert!(state.begin(&list, 0, true).is_none());
    }

    #[test]
    fn ops_and_target_draws_bound_masks_and_ranges() {
        let mut list = fixture(true);
        for (kind, mipmaps, sample_mips) in [
            (ScreenOpKind::Clear, false, false),
            (ScreenOpKind::Mipmaps, false, false),
            (ScreenOpKind::Copy, true, false),
            (ScreenOpKind::Copy, false, true),
        ] {
            let op = ScreenOp {
                before: 2,
                kind,
                mipmaps,
                sample_mips,
                ..list.screen_ops[0]
            };
            list.screen_ops.push(op);
            let mut state = GroupDepth::default();
            state.operation(&list.screen_ops[0]);
            assert_eq!(state.begin(&list, 0, true).unwrap().len(), 1);
            assert!(state.operation(&op));
            assert!(!state.tests(0));
            list.screen_ops.pop();
        }
        list.screen_ops.push(ScreenOp {
            before: 2,
            kind: ScreenOpKind::Clear,
            ..list.screen_ops[0]
        });
        let pass = GroupDepthPass::plan(&list, 0);
        assert_eq!(pass.tiles.len(), 1);
        assert!(pass.tests(0) && pass.tests(1));
        assert!(!pass.tests(2));
        assert_eq!(GroupDepthPass::plan(&list, 2).tiles.len(), 1);
        list.screen_ops.pop();
        list.draws[2].flags = 0;
        assert_eq!(GroupDepthPass::plan(&list, 0).tiles.len(), 1);
    }

    #[test]
    fn planner_does_not_merge_across_fact_ranges() {
        let mut list = fixture(false);
        list.group_cells[0].draws = 1..2;
        let mut calls = Vec::new();
        plan_calls(&list, |_| true, |_| true, &mut calls);
        assert_eq!(calls.iter().map(|c| c.draw).collect::<Vec<_>>(), [0, 1, 2]);
        list.group_cells.clear();
        plan_calls(&list, |_| true, |_| true, &mut calls);
        assert_eq!(calls.iter().map(|c| c.draw).collect::<Vec<_>>(), [0, 2]);
    }
}
