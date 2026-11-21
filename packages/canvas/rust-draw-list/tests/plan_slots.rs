use gsw_canvas_draw_list::{plan::*, *};
fn list(textures: &[u32]) -> DrawList {
    DrawList {
        draws: textures
            .iter()
            .enumerate()
            .map(|(i, &texture)| Draw {
                first_index: i as u32 * 3,
                index_count: 3,
                texture,
                ..Default::default()
            })
            .collect(),
        indices: (0..textures.len() as u32 * 3).collect(),
        vertices: vec![Vertex::default(); textures.len() * 3],
        ..Default::default()
    }
}
fn plan(l: &DrawList) -> (Vec<Call>, PlanCounts) {
    let mut out = Vec::new();
    let n = plan_calls_with_options(
        l,
        PlanOptions { texture_slots: 4 },
        |_| true,
        |_| true,
        &mut out,
    );
    (out, n)
}
#[test]
fn four_pairs_join_and_fifth_breaks() {
    let (c, n) = plan(&list(&[1, 2, 3, 4, 1, 5]));
    assert_eq!(c.len(), 2);
    assert_eq!(n.merged, 4);
    assert_eq!(n.breaks.texture, 1);
    assert_eq!(c[0].slots, [(1, 0), (2, 0), (3, 0), (4, 0)]);
    assert_eq!(c[1].slots, [(5, 0), (2, 0), (3, 0), (4, 0)]);
}
#[test]
fn slots_stay_sticky_across_state_breaks() {
    let mut l = list(&[1, 2, 2, 3]);
    l.draws[2].blend = Blend::Add as u32;
    l.draws[3].blend = Blend::Add as u32;
    let (c, n) = plan(&l);
    assert_eq!(c.len(), 2);
    assert_eq!(n.breaks.blend, 1);
    assert_eq!(
        c[1].slots,
        [(3, 0), (2, 0), (WHITE_TEXTURE, 0), (WHITE_TEXTURE, 0)]
    );
}
#[test]
fn untextured_can_join_a_full_table() {
    let mut l = list(&[1, 2, 3, 4, 0]);
    l.draws[4].flags = DRAW_UNTEXTURED;
    assert_eq!(plan(&l).0.len(), 1);
}
#[test]
fn sampler_is_part_of_pair() {
    let mut l = list(&[1, 1, 1, 1, 1]);
    for (i, d) in l.draws.iter_mut().enumerate() {
        d.sampler = i as u32;
    }
    let (c, n) = plan(&l);
    assert_eq!(c.len(), 2);
    assert_eq!(n.breaks.sampler, 1);
}
#[test]
fn msdf_and_scissor_still_break() {
    for (flag, params) in [
        (DRAW_MSDF, false),
        (DRAW_MSDF, true),
        (DRAW_SCISSOR, false),
        (DRAW_SCISSOR, true),
    ] {
        let mut l = list(&[1, 2]);
        l.draws[1].flags = flag;
        if params {
            l.draws[0].flags = flag;
            l.draws[1].msdf = [2.0, 1.0];
            l.draws[1].scissor = [0, 0, 2, 2];
        }
        let (c, n) = plan(&l);
        assert_eq!(c.len(), 2);
        assert_eq!(
            n.breaks.msdf_flag
                + n.breaks.msdf_params
                + n.breaks.scissor_flag
                + n.breaks.scissor_rect,
            1
        );
    }
}
#[test]
fn custom_group_and_instanced_draws_keep_single_texture_rule() {
    for (program, flags) in [
        (1, 0),
        (0, DRAW_GROUP_CLIP),
        (0, DRAW_GROUP_COMPOSITE),
        (0, DRAW_INSTANCED),
    ] {
        let mut l = list(&[1, 2]);
        l.bindings.push(Binding::default());
        for d in &mut l.draws {
            d.program = program;
            d.flags = flags;
        }
        assert_eq!(plan(&l).0.len(), 2);
    }
}
#[test]
fn index_depth_and_screen_boundaries_still_break() {
    let mut l = list(&[1, 2]);
    l.indices.push(0);
    l.draws[1].first_index += 1;
    assert_eq!(plan(&l).1.breaks.index_gap, 1);
    let mut l = list(&[1, 2]);
    l.draws[1].flags = DRAW_SCREEN_OPS;
    assert_eq!(plan(&l).1.breaks.screen_ops, 1);
    let mut l = list(&[1, 2]);
    l.depth_tiles.push(DepthTile {
        rect: [0, 0, 8, 8],
        level: 1,
    });
    l.depth_draws.push(DepthDraw { draw: 0, level: 0 });
    assert_eq!(plan(&l).1.breaks.depth_level, 1);
}
#[test]
fn group_cell_boundaries_still_break() {
    let mut l = list(&[1, 2, 3]);
    l.group_cells.push(GroupCells {
        draws: 0..1,
        rects: vec![[0, 0, 8, 8]],
    });
    let (c, n) = plan(&l);
    assert_eq!(c.len(), 2);
    assert_eq!(n.breaks.group_cells, 1);
}
#[test]
fn shared_vertex_conflict_replans_whole_list_with_one_slot() {
    let mut l = list(&[1, 2]);
    l.indices[3] = 0;
    let mut c = Vec::new();
    let mut stream = vec![9; 6];
    let mut dirty = Vec::new();
    let n = plan_calls_with_slots(
        &l,
        PlanOptions { texture_slots: 4 },
        |_| true,
        |_| true,
        &mut c,
        &mut stream,
        &mut dirty,
    );
    let mut single = Vec::new();
    let k1 = plan_calls(&l, |_| true, |_| true, &mut single);
    assert_eq!(c, single);
    assert_eq!(n.slot_fallbacks, 1);
    assert_eq!(n.breaks, k1.breaks);
    assert_eq!(stream, vec![0; 6]);
    assert_eq!(dirty, vec![0..6]);
}
#[test]
fn stream_changes_are_exact_and_allocation_is_reused() {
    let mut l = list(&[1, 2, 3]);
    let mut c = Vec::new();
    let mut stream = Vec::new();
    let mut dirty = Vec::new();
    let opts = PlanOptions { texture_slots: 4 };
    plan_calls_with_slots(
        &l,
        opts,
        |_| true,
        |_| true,
        &mut c,
        &mut stream,
        &mut dirty,
    );
    assert_eq!(stream, [0, 0, 0, 1, 1, 1, 2, 2, 2]);
    assert_eq!(dirty, vec![0..9]);
    let ptr = stream.as_ptr();
    plan_calls_with_slots(
        &l,
        opts,
        |_| true,
        |_| true,
        &mut c,
        &mut stream,
        &mut dirty,
    );
    assert!(dirty.is_empty());
    assert_eq!(ptr, stream.as_ptr());
    let old = stream.clone();
    l.draws[1].texture = 1;
    plan_calls_with_slots(
        &l,
        opts,
        |_| true,
        |_| true,
        &mut c,
        &mut stream,
        &mut dirty,
    );
    assert_eq!(stream, [0, 0, 0, 0, 0, 0, 1, 1, 1]);
    assert_eq!(dirty, vec![3..9]);
    let changed: Vec<_> = old
        .iter()
        .zip(&stream)
        .enumerate()
        .filter_map(|(i, (a, b))| (a != b).then_some(i))
        .collect();
    assert_eq!(changed, dirty.iter().cloned().flatten().collect::<Vec<_>>());
    l.draws.clear();
    l.vertices.truncate(2);
    plan_calls_with_slots(
        &l,
        opts,
        |_| true,
        |_| true,
        &mut c,
        &mut stream,
        &mut dirty,
    );
    assert_eq!(stream, [0, 0]);
    assert!(dirty.is_empty());
}
#[test]
fn dirty_ranges_preserve_gaps_and_new_zero_bytes() {
    let l = list(&[1, 2, 3]);
    let mut c = Vec::new();
    let mut stream = vec![0, 9, 0, 1, 9, 1, 2, 2];
    let mut dirty = Vec::new();
    plan_calls_with_slots(
        &l,
        PlanOptions { texture_slots: 4 },
        |_| true,
        |_| true,
        &mut c,
        &mut stream,
        &mut dirty,
    );
    assert_eq!(dirty, vec![1..2, 4..5, 8..9]);
}
#[test]
fn single_slot_and_ineligible_vertices_are_zero() {
    let mut l = list(&[1, 2, 3]);
    l.bindings.push(Binding::default());
    l.draws[1].program = 1;
    let mut c = Vec::new();
    let mut stream = vec![4; 9];
    let mut dirty = Vec::new();
    plan_calls_with_slots(
        &l,
        PlanOptions { texture_slots: 4 },
        |_| true,
        |_| true,
        &mut c,
        &mut stream,
        &mut dirty,
    );
    assert_eq!(&stream[3..6], &[0, 0, 0]);
    let n = plan_calls_with_slots(
        &l,
        PlanOptions::default(),
        |_| true,
        |_| true,
        &mut c,
        &mut stream,
        &mut dirty,
    );
    assert_eq!(stream, vec![0; 9]);
    assert_eq!(n.slot_fallbacks, 0);
}
