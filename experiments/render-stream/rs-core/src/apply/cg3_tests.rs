//! CG3: canvas groups and back-buffer copies in the applier (hand-built /10 states; the order and
//! operations GLES3's `canvas_render_items` makes, rasterizer_canvas_gles3.cpp:409-540).

use super::*;
use crate::state::*;

fn item(id: Id, parent: Parent, commands: Commands) -> Item {
    Item {
        id,
        origin: Origin::Created,
        parent: Some(parent),
        children: Vec::new(),
        visible: true,
        draw_index: id as i64,
        z_index: 0,
        z_relative: true,
        behind: false,
        clip: false,
        custom_rect: false,
        visibility_layer: 1,
        texture_filter: Filter::Default,
        texture_repeat: Repeat::Default,
        material: None,
        use_parent_material: false,
        instance_params: Vec::new(),
        canvas_group: None,
        copy_to_backbuffer: None,
        content_version: 1,
        xform: geom::IDENTITY,
        modulate: [1.0; 4],
        self_modulate: [1.0; 4],
        custom_rect_rect: [0.0; 4],
        commands,
    }
}

fn rect_cmds(r: [f32; 4]) -> Commands {
    Commands {
        list: vec![Command::Rect {
            aa: false,
            rect: r,
            color: [1.0; 4],
        }],
        ..Commands::default()
    }
}

fn group(mode: CanvasGroupMode) -> CanvasGroup {
    CanvasGroup {
        mode,
        clear_margin: 5.0,
        fit_empty: false,
        fit_margin: 0.0,
        blur_mipmaps: false,
    }
}

fn state_with(items: Vec<Item>) -> ResolvedState {
    let mut s = ResolvedState::empty(10);
    let mut c = Canvas {
        id: 1,
        origin: Origin::RootQuery,
        root: true,
        attached: true,
        layer: 0,
        sublayer: 0,
        items: Vec::new(),
        xform: geom::IDENTITY,
        modulate: [1.0; 4],
    };
    for it in items {
        if it.parent.map(|p| p.kind) == Some(ParentKind::Canvas) {
            c.items.push(it.id);
        }
        s.items.insert(it.id, it);
    }
    s.canvases.insert(1, c);
    s
}

fn full_delta(s: &ResolvedState) -> TxDelta {
    TxDelta {
        full: true,
        canvases_upserted: s.canvases.keys().copied().collect(),
        items_upserted: s.items.keys().copied().collect(),
        items_commands: s.items.keys().copied().collect(),
        ..TxDelta::default()
    }
}

fn viewport() -> Viewport {
    Viewport {
        width: 64,
        height: 32,
        clear: [0.2, 0.2, 0.4, 1.0],
        global_xform: geom::IDENTITY,
        cull_mask: 0xffff_ffff,
        format: Format::Rgb10A2,
    }
}

const ON_ROOT: Parent = Parent {
    kind: ParentKind::Canvas,
    id: 1,
};
const fn under(id: Id) -> Parent {
    Parent {
        kind: ParentKind::Item,
        id,
    }
}

/// The first vertex's position of each draw (which item drew it).
fn firsts(a: &Applier) -> Vec<[f32; 2]> {
    a.list
        .draws
        .iter()
        .map(|d| a.list.vertices[a.list.indices[d.first_index as usize] as usize].pos)
        .collect()
}

/// HP-bar shaped: a clip-only mask (2) over a fill (3) and a clip-and-draw fill without children
/// (4), then a rect-mode BackBufferCopy (5, no commands) and a plain item (6).
fn hp_bar() -> ResolvedState {
    let mut mask = item(2, ON_ROOT, rect_cmds([10.0, 4.0, 20.0, 10.0]));
    mask.canvas_group = Some(group(CanvasGroupMode::ClipOnly));
    mask.children = vec![3, 4];
    let fill = item(3, under(2), rect_cmds([8.0, 2.0, 18.0, 14.0]));
    let mut fore = item(4, under(2), rect_cmds([9.0, 2.0, 29.0, 14.0]));
    fore.canvas_group = Some(group(CanvasGroupMode::ClipAndDraw));
    let mut copy = item(5, ON_ROOT, Commands::default());
    copy.copy_to_backbuffer = Some([40.5, 0.0, 16.9, 8.0]);
    let plain = item(6, ON_ROOT, rect_cmds([40.0, 0.0, 4.0, 4.0]));
    state_with(vec![mask, fill, fore, copy, plain])
}

#[test]
fn clip_group_draws_its_range_into_the_back_buffer_then_the_mask_through_the_clip_program() {
    let s = hp_bar();
    let mut a = Applier::new(viewport());
    a.apply(&s, &full_delta(&s), &PayloadStore::default());
    // The mask's subtree first (all of it before the owner), then the owner, then item 6.
    assert_eq!(
        firsts(&a),
        vec![[8.0, 2.0], [9.0, 2.0], [10.0, 4.0], [40.0, 0.0]]
    );
    let flags: Vec<u32> = a
        .list
        .draws
        .iter()
        .map(|d| d.flags & !DRAW_UNTEXTURED)
        .collect();
    // The range opens with the group's copy; the clip-and-draw child with no children is drawn
    // plainly inside the open group.
    assert_eq!(flags[0], DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS);
    assert_eq!(flags[1], DRAW_TO_BACK_BUFFER);
    assert_eq!(flags[2], DRAW_GROUP_CLIP);
    assert_eq!(a.list.draws[2].program, BUILTIN_PROGRAM);
    // The copy after the group: its own rect, truncated; drawn before item 6.
    assert_eq!(flags[3], DRAW_SCREEN_OPS);
    let ops: Vec<(u32, ScreenOpKind, [i32; 4])> = a
        .list
        .screen_ops
        .iter()
        .map(|o| (o.before, o.kind, o.region))
        .collect();
    // The group rect: the owner's [10,4,20,10] merged with the range's [8,2,30,14], grown by the
    // clear margin 5 and clamped to the 64x32 target; the copy's [40.5,0,16.9,8] truncated.
    assert_eq!(
        ops,
        vec![
            (0, ScreenOpKind::Copy, [3, 0, 40, 21]),
            (3, ScreenOpKind::Copy, [40, 0, 16, 8]),
        ]
    );
    // The two back-buffer draws merge; nothing merges across a target, program or operation.
    assert_eq!(a.list.merged_draw_count(), 3);
}

#[test]
fn drop_canvas_group_draws_the_tree_plainly_and_full_backbuffer_copy_copies_everything() {
    let s = hp_bar();
    let mut a = Applier::new(viewport());
    a.sabotage.drop_canvas_group = true;
    a.sabotage.full_backbuffer_copy = true;
    a.apply(&s, &full_delta(&s), &PayloadStore::default());
    // Parent before its children again, nothing in the back buffer.
    assert_eq!(
        firsts(&a),
        vec![[10.0, 4.0], [8.0, 2.0], [9.0, 2.0], [40.0, 0.0]]
    );
    assert!(a.list.draws[..3]
        .iter()
        .all(|d| d.flags & !DRAW_UNTEXTURED == 0));
    assert_eq!(a.list.screen_ops.len(), 1);
    assert_eq!(a.list.screen_ops[0].region, [0, 0, 64, 32]);
}

#[test]
fn transparent_fit_empty_group_clears_draws_and_composites_a_synthesized_rect() {
    let mut owner = item(2, ON_ROOT, Commands::default());
    owner.xform = [1.0, 0.0, 0.0, 1.0, 20.0, 4.0];
    owner.canvas_group = Some(CanvasGroup {
        mode: CanvasGroupMode::Transparent,
        clear_margin: 12.0,
        fit_empty: true,
        fit_margin: 6.0,
        blur_mipmaps: true,
    });
    owner.children = vec![3, 4];
    let a1 = item(3, under(2), rect_cmds([0.0, 0.0, 8.0, 8.0]));
    let a2 = item(4, under(2), rect_cmds([4.0, 4.0, 8.0, 8.0]));
    let s = state_with(vec![owner, a1, a2]);
    let mut a = Applier::new(viewport());
    a.apply(&s, &full_delta(&s), &PayloadStore::default());
    let flags: Vec<u32> = a
        .list
        .draws
        .iter()
        .map(|d| d.flags & !DRAW_UNTEXTURED)
        .collect();
    assert_eq!(
        flags,
        vec![
            DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS,
            DRAW_TO_BACK_BUFFER,
            DRAW_GROUP_COMPOSITE | DRAW_SCREEN_OPS
        ]
    );
    let kinds: Vec<(u32, ScreenOpKind)> = a
        .list
        .screen_ops
        .iter()
        .map(|o| (o.before, o.kind))
        .collect();
    assert_eq!(
        kinds,
        vec![(0, ScreenOpKind::Clear), (2, ScreenOpKind::Mipmaps)]
    );
    // The mip chain's region: the union [20,4,12,12] grown by 6 then by 12, [2,-14,48,48],
    // clamped to the 64x32 target.
    assert_eq!(a.list.screen_ops[1].region, [2, 0, 48, 32]);
    // The synthesized rect: the union grown by fit_margin, in the owner's space (white).
    let d = a.list.draws[2];
    assert_eq!(d.texture, WHITE_TEXTURE);
    let corners: Vec<[f32; 2]> = a.list.indices[d.first_index as usize..][..6]
        .iter()
        .map(|i| a.list.vertices[*i as usize].pos)
        .collect();
    assert!(corners.contains(&[-6.0, -6.0]) && corners.contains(&[18.0, 18.0]));
}

#[test]
fn a_state_only_mode_change_rewalks() {
    let mut owner = item(2, ON_ROOT, rect_cmds([0.0, 0.0, 8.0, 8.0]));
    owner.children = vec![3];
    let child = item(3, under(2), rect_cmds([2.0, 2.0, 8.0, 8.0]));
    let mut s = state_with(vec![owner, child]);
    let mut a = Applier::new(viewport());
    a.apply(&s, &full_delta(&s), &PayloadStore::default());
    assert!(a.list.screen_ops.is_empty());
    s.items.get_mut(&2).unwrap().canvas_group = Some(group(CanvasGroupMode::ClipOnly));
    let delta = TxDelta {
        items_upserted: vec![2],
        ..TxDelta::default()
    };
    let st = a.apply(&s, &delta, &PayloadStore::default()).clone();
    assert!(st.structural);
    assert_eq!(a.list.screen_ops.len(), 1);
    assert_eq!(a.list.draws[1].flags & !DRAW_UNTEXTURED, DRAW_GROUP_CLIP);
}

#[test]
fn a_clip_only_owner_without_an_open_group_draws_nothing() {
    // A clip-only sprite with no children has no range: GLES3 skips it (skip_item).
    let mut owner = item(2, ON_ROOT, rect_cmds([0.0, 0.0, 8.0, 8.0]));
    owner.canvas_group = Some(group(CanvasGroupMode::ClipOnly));
    let s = state_with(vec![owner]);
    let mut a = Applier::new(viewport());
    a.apply(&s, &full_delta(&s), &PayloadStore::default());
    assert!(a.list.draws.is_empty());
}
