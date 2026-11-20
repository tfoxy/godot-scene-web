use gsw_canvas_draw_list::cover::{
    groups::{GroupRange, GroupWalk},
    CoverFacts, ProgramFacts,
};
use gsw_canvas_draw_list::opacity::Opacity;
use gsw_canvas_draw_list::*;

struct Facts;
impl CoverFacts for Facts {
    fn opacity(&self, _: u32) -> Option<&Opacity> {
        None
    }
    fn program(&self, _: u32) -> ProgramFacts {
        ProgramFacts::UNKNOWN
    }
    fn max_texture_side(&self) -> u32 {
        4096
    }
}

fn quad(list: &mut DrawList, rect: [f32; 4], flags: u32) {
    let base = list.vertices.len() as u32;
    for [x, y] in [[0., 0.], [1., 0.], [1., 1.], [0., 1.]] {
        list.vertices.push(Vertex {
            pos: [rect[0] + x * rect[2], rect[1] + y * rect[3]],
            color: [1.; 4],
            ..Vertex::default()
        });
    }
    let first_index = list.indices.len() as u32;
    list.indices.extend([0, 1, 2, 0, 2, 3].map(|i| i + base));
    list.draws.push(Draw {
        first_index,
        index_count: 6,
        flags,
        blend: Blend::Mix as u32,
        ..Draw::default()
    });
}
fn fixture(xs: &[f32]) -> (DrawList, Vec<GroupRange>) {
    let mut list = DrawList::default();
    list.target.width = 200;
    list.target.height = 100;
    list.items.push(Item {
        xform: [1., 0., 0., 1., 0., 0.],
        modulate: [1.; 4],
        ..Item::default()
    });
    let mut groups = Vec::new();
    for &x in xs {
        let first = list.draws.len();
        quad(
            &mut list,
            [0., 0., 200., 100.],
            DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS,
        );
        quad(&mut list, [x, 10., 10., 10.], DRAW_GROUP_CLIP);
        groups.push(GroupRange {
            first,
            composite: first + 1..first + 2,
        });
        list.screen_ops.push(ScreenOp {
            before: first as u32,
            kind: ScreenOpKind::Copy,
            region: [0, 0, 200, 100],
            mipmaps: false,
            sample_mips: false,
        });
    }
    (list, groups)
}
fn run(list: &mut DrawList, groups: &[GroupRange]) -> GroupWalk {
    let mut walk = GroupWalk::default();
    walk.prepare(list, groups, &Facts, true);
    walk.apply(list);
    walk.merge(list, &Facts, true);
    walk
}
fn passes(list: &DrawList) -> (u32, u32) {
    let r = gsw_canvas_draw_list::fill::account(list, &Default::default());
    (r.back_buffer_passes, r.target_passes)
}
#[test]
fn three_disjoint_groups_share_one_back_buffer_pass() {
    let (mut list, groups) = fixture(&[10., 40., 70.]);
    assert_eq!(passes(&list), (3, 4));
    let original = list.clone();
    let mut walk = run(&mut list, &groups);
    assert_eq!(passes(&list), (1, 2));
    let target: Vec<_> = list
        .draws
        .iter()
        .filter(|d| d.flags & DRAW_TO_BACK_BUFFER == 0)
        .map(|d| d.first_index)
        .collect();
    assert_eq!(target, vec![6, 18, 30]);
    walk.restore(&mut list);
    assert_eq!(list.draws, original.draws);
    assert_eq!(list.screen_ops, original.screen_ops);
}

#[test]
fn overlap_stops_only_that_greedy_run() {
    // The second case has disjoint quads, but their outward-rounded regions overlap.
    for xs in [[10., 15., 70.], [10., 21., 70.]] {
        let (mut list, groups) = fixture(&xs);
        run(&mut list, &groups);
        assert_eq!(passes(&list), (2, 3));
    }
    let (mut list, groups) = fixture(&[10., 15., 18.]);
    run(&mut list, &groups);
    assert_eq!(passes(&list), (3, 4));
}

fn insert_target(list: &mut DrawList, groups: &mut [GroupRange], at: usize, rect: [f32; 4]) {
    quad(list, rect, 0);
    let d = list.draws.pop().unwrap();
    list.draws.insert(at, d);
    for op in &mut list.screen_ops {
        if op.before as usize >= at {
            op.before += 1;
        }
    }
    for g in groups {
        if g.first >= at {
            g.first += 1;
        }
        if g.composite.start >= at {
            g.composite = g.composite.start + 1..g.composite.end + 1;
        }
    }
}

#[test]
fn target_hit_stops_run_and_target_miss_keeps_all_target_draws_in_order() {
    for (rect, expected) in [([70., 10., 5., 5.], (2, 3)), ([120., 10., 5., 5.], (1, 2))] {
        let (mut list, mut groups) = fixture(&[10., 40., 70.]);
        insert_target(&mut list, &mut groups, 2, rect);
        let target: Vec<_> = list
            .draws
            .iter()
            .filter(|d| d.flags & DRAW_TO_BACK_BUFFER == 0)
            .map(|d| d.first_index)
            .collect();
        run(&mut list, &groups);
        assert_eq!(passes(&list), expected);
        assert_eq!(
            list.draws
                .iter()
                .filter(|d| d.flags & DRAW_TO_BACK_BUFFER == 0)
                .map(|d| d.first_index)
                .collect::<Vec<_>>(),
            target
        );
    }
}

#[test]
fn transparent_and_ungated_groups_break_a_run() {
    for transparent in [false, true] {
        let (mut list, groups) = fixture(&[10., 40., 70.]);
        if transparent {
            list.screen_ops[1].kind = ScreenOpKind::Clear;
            list.draws[3].flags = DRAW_GROUP_COMPOSITE;
        } else {
            list.draws[3].blend = Blend::Mul as u32;
        }
        run(&mut list, &groups);
        assert_eq!(passes(&list), (3, 4));
    }
}

#[test]
fn screen_reader_and_mipmaps_inside_span_break_a_run() {
    for mipmaps in [false, true] {
        let (mut list, mut groups) = fixture(&[10., 40., 70.]);
        insert_target(&mut list, &mut groups, 2, [120., 10., 5., 5.]);
        if mipmaps {
            list.screen_ops.insert(
                1,
                ScreenOp {
                    before: 2,
                    kind: ScreenOpKind::Mipmaps,
                    ..list.screen_ops[0]
                },
            );
            list.draws[2].flags |= DRAW_SCREEN_OPS;
        } else {
            list.draws[2].program = 1; // Unknown means it may read SCREEN_TEXTURE.
        }
        run(&mut list, &groups);
        // The last two groups may still merge, after the barrier.
        assert_eq!(passes(&list), if mipmaps { (3, 4) } else { (2, 3) });
    }
}

#[test]
fn child_screen_reader_blocks_hoisting_even_when_its_write_is_disjoint() {
    let (mut list, groups) = fixture(&[10., 40., 70.]);
    list.draws[2].program = 1;
    run(&mut list, &groups);
    assert_eq!(passes(&list), (3, 4));
}

#[test]
fn instance_ranges_flags_group_ranges_and_restore_copy_follow_the_permutation() {
    let (mut list, groups) = fixture(&[10., 40., 70.]);
    for at in [0, 2, 4] {
        list.draws[at].flags |= DRAW_INSTANCED;
        list.instanced.push(InstancedDraw {
            draw: at as u32,
            first: at as u32 * 10,
            count: 1,
        });
    }
    let original = list.clone();
    let mut walk = run(&mut list, &groups);
    assert_eq!(
        list.instanced
            .iter()
            .map(|r| (r.draw, r.first))
            .collect::<Vec<_>>(),
        vec![(0, 0), (1, 20), (2, 40)]
    );
    for (at, g) in walk.work().iter().enumerate() {
        assert_eq!(g.back_buffer, at..at + 1);
        assert_eq!(g.composite, at + 3..at + 4);
    }
    for (at, d) in list.draws.iter().enumerate() {
        assert_eq!(
            d.flags & DRAW_SCREEN_OPS != 0,
            list.screen_ops.iter().any(|op| op.before as usize == at)
        );
    }
    let mut plain = list.clone();
    walk.restore_copy(&mut plain);
    assert_eq!(plain.draws, original.draws);
    assert_eq!(plain.screen_ops, original.screen_ops);
    assert_eq!(plain.instanced, original.instanced);
    walk.restore(&mut list);
    walk.prepare(&list, &groups, &Facts, true);
    assert!(!walk.apply(&mut list));
    assert!(!walk.merge(&mut list, &Facts, true));
    walk.restore(&mut list);
    walk.prepare(&list, &groups, &Facts, true);
    walk.apply(&mut list);
    assert!(walk.merge(&mut list, &Facts, false));
    assert_eq!(passes(&list), (3, 4));
}

#[test]
fn permutation_checker_rejects_changed_draw_fields_and_remapped_indices() {
    let (mut list, groups) = fixture(&[10., 40., 70.]);
    list.draws[2].flags |= DRAW_INSTANCED;
    list.instanced.push(InstancedDraw {
        draw: 2,
        first: 4,
        count: 1,
    });
    let mut walk = GroupWalk::default();
    walk.prepare(&list, &groups, &Facts, true);
    walk.apply(&mut list);
    let before = list.clone();
    walk.merge(&mut list, &Facts, true);
    assert!(walk.check_merge(&before, &list));
    for field in 0..5 {
        let mut wrong = list.clone();
        match field {
            0 => wrong.draws[1].scissor[0] += 1,
            1 => wrong.draws[1].flags ^= DRAW_SCREEN_OPS,
            2 => wrong.screen_ops[1].before += 1,
            3 => wrong.screen_ops[1].region[0] += 1,
            _ => wrong.instanced[0].draw += 1,
        }
        assert!(!walk.check_merge(&before, &wrong), "field {field}");
    }
    let mut restored = list.clone();
    walk.restore_merge_copy(&mut restored);
    assert_eq!(format!("{restored:?}"), format!("{before:?}"));
}
