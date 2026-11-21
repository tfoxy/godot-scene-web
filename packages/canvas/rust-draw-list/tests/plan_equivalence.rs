use gsw_canvas_draw_list::plan::{BreakCounts, drawable, plan_calls};
use gsw_canvas_draw_list::*;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LegacyCall {
    draw: u32,
    first_index: u32,
    index_count: u32,
    texture_draw: u32,
    depth: Option<u32>,
    bounds: [i32; 4],
}
#[derive(Default)]
struct LegacyCounts {
    merged: u32,
    skipped: u32,
}
fn legacy_plan_calls(
    list: &DrawList,
    known_texture: impl Fn(u32) -> bool,
    known_binding: impl Fn(u32) -> bool,
    out: &mut Vec<LegacyCall>,
) -> LegacyCounts {
    out.clear();
    let mut counts = LegacyCounts::default();
    // The current run's state (`merged`): its texture and sampler are its first textured draw's.
    let mut run: Option<Draw> = None;
    let mut group = None;
    for (i, draw) in list.draws.iter().enumerate() {
        if draw.index_count == 0 {
            continue;
        }
        if !drawable(draw, list.indices.len(), &known_texture, &known_binding) {
            counts.skipped += 1;
            run = None;
            continue;
        }
        let depth = gsw_canvas_draw_list::depth_level(list, i as u32);
        // A merged call must stay inside one fact range: its first draw selects depth testing.
        let next_group = list.group_cells.iter().position(|g| g.draws.contains(&i));
        if group != next_group {
            run = None;
            group = next_group;
        }
        run = Some(match (run, out.last_mut()) {
            (Some(r), Some(call)) if call.depth == depth && mergeable(&r, draw) => {
                call.index_count += draw.index_count;
                if r.flags & DRAW_UNTEXTURED != 0 && draw.flags & DRAW_UNTEXTURED == 0 {
                    call.texture_draw = i as u32;
                }
                counts.merged += 1;
                merged(&r, draw)
            }
            _ => {
                out.push(LegacyCall {
                    draw: i as u32,
                    first_index: draw.first_index,
                    index_count: draw.index_count,
                    texture_draw: i as u32,
                    depth,
                    bounds: [0; 4],
                });
                *draw
            }
        });
    }
    counts
}

#[test]
fn single_slot_matches_original_planner_on_generated_lists() {
    let mut seed = 0x73d1_u64;
    for _ in 0..1000 {
        let mut rand = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 32) as u32
        };
        let mut l = DrawList::default();
        l.bindings.resize(4, Binding::default());
        let mut index = 0;
        for i in 0..80 {
            let mut d = if i > 0 && rand() % 3 == 0 {
                *l.draws.last().unwrap()
            } else {
                Draw {
                    texture: rand() % 5,
                    sampler: rand() % 3,
                    blend: rand() % 7,
                    program: rand() % 5,
                    flags: [
                        0,
                        DRAW_UNTEXTURED,
                        DRAW_MSDF,
                        DRAW_SCISSOR,
                        DRAW_INSTANCED,
                        DRAW_SCREEN_OPS,
                        DRAW_TO_BACK_BUFFER,
                        DRAW_GROUP_CLIP,
                        DRAW_GROUP_COMPOSITE,
                        256,
                    ][(rand() % 10) as usize],
                    scissor: [0, 0, (rand() % 4) as i32, 4],
                    msdf: [(rand() % 3) as f32, 0.0],
                    ..Draw::default()
                }
            };
            d.first_index = index + u32::from(rand() % 11 == 0);
            d.index_count = if rand() % 9 == 0 { 0 } else { 3 };
            index = d.first_index + d.index_count;
            l.draws.push(d);
            if rand() % 4 == 0 {
                l.depth_draws.push(DepthDraw {
                    draw: i,
                    level: rand() % 3,
                });
            }
        }
        l.depth_tiles.push(DepthTile {
            rect: [0, 0, 8, 8],
            level: 3,
        });
        l.group_cells = vec![
            GroupCells {
                draws: 20..40,
                rects: vec![[0, 0, 8, 8]],
            },
            GroupCells {
                draws: 40..60,
                rects: vec![[8, 0, 8, 8]],
            },
        ];
        l.indices.resize(index.saturating_sub(1) as usize, 0);
        let mut old = Vec::new();
        let mut new = Vec::new();
        let a = legacy_plan_calls(&l, |t| t != 4, |p| p != 4, &mut old);
        let b = plan_calls(&l, |t| t != 4, |p| p != 4, &mut new);
        assert_eq!((a.merged, a.skipped), (b.merged, b.skipped));
        assert_eq!(old.len(), new.len());
        for (a, b) in old.iter().zip(&new) {
            assert_eq!(
                (
                    a.draw,
                    a.first_index,
                    a.index_count,
                    a.texture_draw,
                    a.depth,
                    a.bounds
                ),
                (
                    b.draw,
                    b.first_index,
                    b.index_count,
                    b.texture_draw,
                    b.depth,
                    b.bounds
                )
            );
            let d = &l.draws[b.texture_draw as usize];
            assert_eq!(b.slots[0], (d.texture, d.sampler));
            assert_eq!(b.slots[1..], [(WHITE_TEXTURE, 0); 3]);
        }
    }
}

#[test]
fn break_order_and_equal_binding_subset() {
    let mut l = DrawList {
        indices: vec![0; 9],
        bindings: vec![Binding::default(); 2],
        ..Default::default()
    };
    l.draws = vec![
        Draw {
            index_count: 3,
            program: 1,
            ..Default::default()
        },
        Draw {
            first_index: 3,
            index_count: 3,
            program: 2,
            ..Default::default()
        },
        Draw {
            first_index: 6,
            index_count: 3,
            program: 1,
            texture: 9,
            blend: 1,
            ..Default::default()
        },
    ];
    let mut calls = Vec::new();
    let n = plan_calls(&l, |_| true, |_| true, &mut calls);
    assert_eq!(
        n.breaks,
        BreakCounts {
            program: 1,
            program_equal_bindings: 1,
            texture: 1,
            ..Default::default()
        }
    );
}

// Keep the original executor cases here as well as at its compatibility re-export.
mod original_cases {
    use gsw_canvas_draw_list::plan::*;
    use gsw_canvas_draw_list::*;
    fn draw(first: u32, count: u32) -> Draw {
        Draw {
            first_index: first,
            index_count: count,
            ..Draw::default()
        }
    }

    fn list(draws: Vec<Draw>, indices: usize) -> DrawList {
        DrawList {
            draws,
            indices: vec![0; indices],
            ..DrawList::default()
        }
    }

    fn expected_slots(list: &DrawList, draw: usize) -> [(u32, u32); 4] {
        let mut slots = [(WHITE_TEXTURE, 0); 4];
        let d = &list.draws[draw];
        slots[0] = (d.texture, d.sampler);
        slots
    }

    #[test]
    fn plan_merges_adjacent_equal_state_only_and_agrees_with_merged_draw_count() {
        let a = draw(0, 6);
        let b = draw(6, 6);
        let c = Draw {
            texture: 2,
            ..draw(12, 3)
        };
        let d = Draw {
            texture: 2,
            ..draw(15, 3)
        };
        let e = draw(18, 6); // white again: a new call, never merged back into `a`'s
        let l = list(vec![a, b, c, d, e], 24);
        let mut out = Vec::new();
        let counts = plan_calls(&l, |_| true, |_| false, &mut out);
        assert_eq!(out.len(), l.merged_draw_count());
        assert_eq!(
            out,
            vec![
                Call {
                    draw: 0,
                    first_index: 0,
                    index_count: 12,
                    texture_draw: 0,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 0),
                },
                Call {
                    draw: 2,
                    first_index: 12,
                    index_count: 6,
                    texture_draw: 2,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 2),
                },
                Call {
                    draw: 4,
                    first_index: 18,
                    index_count: 6,
                    texture_draw: 4,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 4),
                },
            ]
        );
        assert_eq!(
            counts,
            PlanCounts {
                merged: 2,
                skipped: 0,
                breaks: gsw_canvas_draw_list::plan::BreakCounts {
                    texture: 2,
                    ..Default::default()
                },
                ..Default::default()
            }
        );
    }

    #[test]
    fn plan_never_merges_draws_of_different_depth_levels() {
        let mut l = list(vec![draw(0, 6), draw(6, 6), draw(12, 6), draw(18, 6)], 24);
        l.depth_tiles = vec![gsw_canvas_draw_list::DepthTile {
            rect: [0, 0, 32, 32],
            level: 1,
        }];
        // Draws 0 and 1 at level 0, draw 2 untested, draw 3 at level 0 again.
        l.depth_draws = [0, 1, 3]
            .map(|d| gsw_canvas_draw_list::DepthDraw { draw: d, level: 0 })
            .to_vec();
        let mut out = Vec::new();
        plan_calls(&l, |_| true, |_| true, &mut out);
        let calls: Vec<(u32, u32, Option<u32>)> = out
            .iter()
            .map(|c| (c.draw, c.index_count, c.depth))
            .collect();
        assert_eq!(calls, [(0, 12, Some(0)), (2, 6, None), (3, 6, Some(0))]);
        assert_eq!(out.len(), l.merged_draw_count());
        // Without tiles nothing is tested: one call.
        l.depth_tiles.clear();
        plan_calls(&l, |_| true, |_| true, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].depth, None);
        assert_eq!(l.merged_draw_count(), 1);
    }

    #[test]
    fn plan_never_merges_across_state_scissor_or_a_gap() {
        let a = draw(0, 3);
        let gap = draw(6, 3); // does not touch `a`
        let sampler = Draw {
            sampler: Sampler::LINEAR,
            ..draw(9, 3)
        };
        let blend = Draw {
            blend: Blend::Add as u32,
            sampler: Sampler::LINEAR,
            ..draw(12, 3)
        };
        let s1 = Draw {
            flags: DRAW_SCISSOR,
            scissor: [0, 0, 4, 4],
            ..draw(15, 3)
        };
        let s2 = Draw {
            flags: DRAW_SCISSOR,
            scissor: [0, 0, 4, 5],
            ..draw(18, 3)
        };
        let s3 = Draw {
            flags: DRAW_SCISSOR,
            scissor: [0, 0, 4, 5],
            ..draw(21, 3)
        };
        let l = list(vec![a, gap, sampler, blend, s1, s2, s3], 24);
        let mut out = Vec::new();
        let counts = plan_calls(&l, |_| true, |_| false, &mut out);
        assert_eq!(out.len(), 6);
        assert_eq!(out.len(), l.merged_draw_count());
        assert_eq!(counts.merged, 1);
        assert_eq!(
            out[5],
            Call {
                draw: 5,
                first_index: 18,
                index_count: 6,
                texture_draw: 5,
                depth: None,
                bounds: [0; 4],
                slots: expected_slots(&l, 5),
            }
        );
    }

    #[test]
    fn plan_skips_undrawable_draws_and_ends_their_run() {
        let a = draw(0, 3);
        let unknown_texture = Draw {
            texture: 7,
            ..draw(3, 3)
        };
        let b = draw(6, 3);
        let bad_blend = Draw {
            blend: 99,
            ..draw(9, 3)
        };
        let out_of_range = draw(12, 6); // indices end at 15
        let empty = draw(15, 0);
        let program = Draw {
            program: 3,
            ..draw(12, 3)
        };
        let l = list(
            vec![
                a,
                unknown_texture,
                b,
                bad_blend,
                out_of_range,
                empty,
                program,
            ],
            15,
        );
        let mut out = Vec::new();
        let counts = plan_calls(&l, |id| id == 2, |_| false, &mut out);
        assert_eq!(
            counts,
            PlanCounts {
                merged: 0,
                skipped: 4,
                breaks: gsw_canvas_draw_list::plan::BreakCounts {
                    undrawable: 4,
                    ..Default::default()
                },
                ..Default::default()
            }
        );
        assert_eq!(
            out,
            vec![
                Call {
                    draw: 0,
                    first_index: 0,
                    index_count: 3,
                    texture_draw: 0,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 0),
                },
                Call {
                    draw: 2,
                    first_index: 6,
                    index_count: 3,
                    texture_draw: 2,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 2),
                }
            ]
        );
    }

    #[test]
    fn untextured_draws_join_a_textured_run_and_the_call_binds_its_texture() {
        let w = |first| Draw {
            flags: DRAW_UNTEXTURED,
            ..draw(first, 3)
        };
        let t = |first, texture| Draw {
            texture,
            sampler: Sampler::LINEAR,
            ..draw(first, 3)
        };
        // W W A W A | B W: the first run binds A (draw 2), the second B (draw 5).
        let l = list(
            vec![w(0), w(3), t(6, 2), w(9), t(12, 2), t(15, 3), w(18)],
            21,
        );
        let mut out = Vec::new();
        let counts = plan_calls(&l, |_| true, |_| false, &mut out);
        assert_eq!(out.len(), l.merged_draw_count());
        assert_eq!(
            out,
            vec![
                Call {
                    draw: 0,
                    first_index: 0,
                    index_count: 15,
                    texture_draw: 2,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 2),
                },
                Call {
                    draw: 5,
                    first_index: 15,
                    index_count: 6,
                    texture_draw: 5,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 5),
                },
            ]
        );
        assert_eq!(counts.merged, 5);
        // An all-untextured run names its own first draw.
        let l = list(vec![w(0), w(3)], 6);
        plan_calls(&l, |_| true, |_| false, &mut out);
        assert_eq!(out[0].texture_draw, 0);
        assert_eq!(out[0].index_count, 6);
    }

    #[test]
    fn an_empty_draw_does_not_end_a_run() {
        let l = list(vec![draw(0, 3), draw(3, 0), draw(3, 3)], 6);
        let mut out = Vec::new();
        plan_calls(&l, |_| true, |_| false, &mut out);
        assert_eq!(
            out,
            vec![Call {
                draw: 0,
                first_index: 0,
                index_count: 6,
                texture_draw: 0,
                depth: None,
                bounds: [0; 4],
                slots: expected_slots(&l, 0),
            }]
        );
        assert_eq!(l.merged_draw_count(), 1);
    }
}
