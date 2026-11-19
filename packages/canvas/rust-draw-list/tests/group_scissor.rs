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
fn fixture() -> (DrawList, Vec<GroupRange>) {
    let mut list = DrawList::default();
    list.target.width = 100;
    list.target.height = 80;
    list.items.push(Item {
        xform: [1., 0., 0., 1., 0., 0.],
        modulate: [1.; 4],
        ..Item::default()
    });
    quad(
        &mut list,
        [0., 0., 100., 80.],
        DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS,
    );
    quad(&mut list, [20.25, 10.5, 30., 20.], DRAW_GROUP_CLIP);
    list.screen_ops.push(ScreenOp {
        before: 0,
        kind: ScreenOpKind::Copy,
        region: [0, 0, 100, 80],
        mipmaps: false,
        sample_mips: false,
    });
    (
        list,
        vec![GroupRange {
            first: 0,
            composite: 1..2,
        }],
    )
}
fn run(list: &mut DrawList, groups: &[GroupRange]) -> GroupWalk {
    let mut walk = GroupWalk::default();
    walk.prepare(list, groups, &Facts, true);
    walk.apply(list);
    walk
}
fn unchanged(mut list: DrawList, groups: &[GroupRange]) {
    let original = (list.draws.clone(), list.screen_ops.clone());
    run(&mut list, groups);
    assert_eq!((list.draws, list.screen_ops), original);
}
#[test]
fn overhang_scissored_and_copy_shrunk_outward() {
    let (mut list, groups) = fixture();
    run(&mut list, &groups);
    assert_eq!(list.screen_ops[0].region, [19, 9, 33, 23]);
    for d in &list.draws {
        assert_ne!(d.flags & DRAW_SCISSOR, 0);
        assert_eq!(d.scissor, [19, 9, 33, 23]);
    }
}
#[test]
fn intersects_child_scissor_and_retains_empty_scissor() {
    for (own, expected) in [
        ([25, 15, 50, 50], [25, 15, 27, 17]),
        ([80, 60, 5, 5], [80, 60, 0, 0]),
    ] {
        let (mut list, groups) = fixture();
        list.draws[0].flags |= DRAW_SCISSOR;
        list.draws[0].scissor = own;
        run(&mut list, &groups);
        assert_eq!(list.draws[0].scissor, expected);
        assert_ne!(list.draws[0].flags & DRAW_SCISSOR, 0);
    }
}
#[test]
fn transparent_group_scissors_quad_and_keeps_full_clear() {
    let (mut list, groups) = fixture();
    list.draws[1].flags = DRAW_GROUP_COMPOSITE;
    list.screen_ops[0].kind = ScreenOpKind::Clear;
    run(&mut list, &groups);
    assert_eq!(list.draws[0].scissor, [19, 9, 33, 23]);
    assert_eq!(list.draws[1].scissor, [19, 9, 33, 23]);
    assert_eq!(list.screen_ops[0].region, [0, 0, 100, 80]);
}
#[test]
fn only_mix_add_sub_composites_qualify() {
    for blend in [Blend::Mul, Blend::PremulAlpha, Blend::Disabled] {
        let (mut list, groups) = fixture();
        list.draws[1].blend = blend as u32;
        unchanged(list, &groups);
    }
    for blend in [Blend::Mix, Blend::Add, Blend::Sub] {
        let (mut list, groups) = fixture();
        list.draws[1].blend = blend as u32;
        run(&mut list, &groups);
        assert_ne!(list.draws[0].flags & DRAW_SCISSOR, 0);
    }
}
#[test]
fn mipmaps_op_or_copy_mipmaps_disables_group() {
    let (mut list, groups) = fixture();
    list.screen_ops.push(ScreenOp {
        before: 1,
        kind: ScreenOpKind::Mipmaps,
        ..list.screen_ops[0]
    });
    list.draws[1].flags |= DRAW_SCREEN_OPS;
    unchanged(list, &groups);
    let (mut list, groups) = fixture();
    list.screen_ops[0].mipmaps = true;
    unchanged(list, &groups);
}
#[test]
fn later_screen_reader_without_own_full_copy_disables_group() {
    for copy in [None, Some([0, 0, 50, 40])] {
        let (mut list, groups) = fixture();
        quad(&mut list, [0., 0., 10., 10.], 0);
        list.draws[2].program = 1;
        if let Some(region) = copy {
            list.screen_ops.push(ScreenOp {
                before: 2,
                region,
                ..list.screen_ops[0]
            });
            list.draws[2].flags |= DRAW_SCREEN_OPS;
        }
        unchanged(list, &groups);
    }
}
#[test]
fn later_reader_with_full_copy_is_safe() {
    let (mut list, groups) = fixture();
    quad(&mut list, [0., 0., 10., 10.], DRAW_SCREEN_OPS);
    list.draws[2].program = 1;
    list.screen_ops.push(ScreenOp {
        before: 2,
        ..list.screen_ops[0]
    });
    run(&mut list, &groups);
    assert_eq!(list.screen_ops[0].region, [19, 9, 33, 23]);
    assert_eq!(list.screen_ops[1].region, [0, 0, 100, 80]);
}
#[test]
fn later_composite_outside_own_region_disables_earlier_group() {
    let (mut list, mut groups) = fixture();
    quad(
        &mut list,
        [0., 0., 100., 80.],
        DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS,
    );
    quad(&mut list, [60., 40., 20., 20.], DRAW_GROUP_CLIP);
    groups.push(GroupRange {
        first: 2,
        composite: 3..4,
    });
    list.screen_ops.push(ScreenOp {
        before: 2,
        region: [0, 0, 10, 10],
        ..list.screen_ops[0]
    });
    unchanged(list, &groups);
}
#[test]
fn later_group_copy_cannot_stand_in_for_screen_readers_own_copy() {
    let (mut list, mut groups) = fixture();
    quad(
        &mut list,
        [0., 0., 100., 80.],
        DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS,
    );
    quad(&mut list, [60., 40., 20., 20.], DRAW_GROUP_CLIP);
    groups.push(GroupRange {
        first: 2,
        composite: 3..4,
    });
    list.screen_ops.push(ScreenOp {
        before: 2,
        ..list.screen_ops[0]
    });
    quad(&mut list, [0., 0., 100., 80.], 0);
    list.draws[4].program = 1;
    unchanged(list, &groups);
}
#[test]
fn custom_composite_with_unknown_vertex_stage_disables_earlier_group() {
    let (mut list, mut groups) = fixture();
    quad(
        &mut list,
        [0., 0., 100., 80.],
        DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS,
    );
    quad(&mut list, [60., 40., 20., 20.], 0);
    list.draws[3].program = 1;
    groups.push(GroupRange {
        first: 2,
        composite: 3..4,
    });
    list.screen_ops.push(ScreenOp {
        before: 2,
        ..list.screen_ops[0]
    });
    unchanged(list, &groups);
}
#[test]
fn multiple_owner_draws_share_union_and_pre_owner_is_scissored() {
    let (mut list, mut groups) = fixture();
    list.draws[1].flags = DRAW_TO_BACK_BUFFER;
    quad(&mut list, [20., 10., 10., 10.], DRAW_GROUP_CLIP);
    quad(&mut list, [40., 20., 10., 10.], DRAW_GROUP_CLIP);
    groups[0].composite = 2..4;
    run(&mut list, &groups);
    assert!(list.draws.iter().all(|d| d.scissor == [19, 9, 32, 22]));
    assert_eq!(list.screen_ops[0].region, [19, 9, 32, 22]);
}
#[test]
fn restores_originals_and_recomputes_animated_vertices_and_rows() {
    let (mut list, groups) = fixture();
    let original = (list.draws.clone(), list.screen_ops.clone());
    let mut walk = run(&mut list, &groups);
    walk.restore(&mut list);
    assert_eq!((list.draws.clone(), list.screen_ops.clone()), original);
    walk.prepare(&list, &groups, &Facts, true);
    assert!(!walk.apply(&mut list));
    walk.restore(&mut list);
    list.items[0].xform[4] = 3.;
    walk.prepare(&list, &groups, &Facts, true);
    assert!(walk.apply(&mut list));
    assert_eq!(list.draws[0].scissor, [22, 9, 33, 23]);
    walk.restore(&mut list);
    for v in &mut list.vertices[4..] {
        v.pos[1] += 2.;
    }
    walk.prepare(&list, &groups, &Facts, true);
    assert!(walk.apply(&mut list));
    assert_eq!(list.draws[0].scissor, [22, 11, 33, 23]);
    walk.restore(&mut list);
    walk.prepare(&list, &groups, &Facts, false);
    assert!(walk.apply(&mut list));
    assert_eq!((list.draws, list.screen_ops), original);
}
#[test]
fn invalid_and_extreme_geometry_falls_back_without_panicking() {
    for position in [f32::NAN, f32::INFINITY, 1.0e20] {
        let (mut list, groups) = fixture();
        list.vertices[4].pos[0] = position;
        unchanged(list, &groups);
    }
    let (mut list, groups) = fixture();
    list.draws[1].first_index = u32::MAX;
    unchanged(list, &groups);
}

#[test]
fn fill_totals_account_for_group_scissors_and_copy_shrink() {
    use gsw_canvas_draw_list::fill::{account, Class, FillOptions};
    let (mut list, groups) = fixture();
    let before = account(&list, &FillOptions::default());
    run(&mut list, &groups);
    let after = account(&list, &FillOptions::default());
    assert_eq!(before.px[Class::ToBackBuffer as usize], 8000.0);
    assert!((after.px[Class::ToBackBuffer as usize] - 759.0).abs() < 1.0e-9);
    assert_eq!(after.px[Class::Copy as usize], 759.0);
    assert_eq!(
        before.px[Class::GroupComposite as usize],
        after.px[Class::GroupComposite as usize]
    );
    assert_eq!(
        before.px[Class::BackBufferClear as usize],
        after.px[Class::BackBufferClear as usize]
    );
}
