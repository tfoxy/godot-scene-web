//! Applier unit tests over hand-built resolved states (no decoder, no GPU).

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
        use_identity_transform: false,
        content_version: 1,
        xform: geom::IDENTITY,
        modulate: [1.0; 4],
        self_modulate: [1.0; 4],
        custom_rect_rect: [0.0; 4],
        commands,
    }
}

fn rect_cmds(r: [f32; 4], c: [f32; 4]) -> Commands {
    Commands {
        list: vec![Command::Rect {
            aa: false,
            rect: r,
            color: c,
        }],
        ..Commands::default()
    }
}

fn root() -> Canvas {
    Canvas {
        id: 1,
        origin: Origin::RootQuery,
        root: true,
        attached: true,
        layer: 0,
        sublayer: 0,
        items: Vec::new(),
        xform: geom::IDENTITY,
        modulate: [1.0; 4],
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

fn state_with(items: Vec<Item>) -> ResolvedState {
    let mut s = ResolvedState::empty(6);
    let mut c = root();
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

const ON_ROOT: Parent = Parent {
    kind: ParentKind::Canvas,
    id: 1,
};

#[test]
fn two_rects_paint_in_draw_index_order_and_merge() {
    let s = state_with(vec![
        item(
            1,
            ON_ROOT,
            rect_cmds([0.0, 0.0, 4.0, 4.0], [1.0, 0.0, 0.0, 1.0]),
        ),
        item(
            2,
            ON_ROOT,
            rect_cmds([2.0, 2.0, 4.0, 4.0], [0.0, 1.0, 0.0, 1.0]),
        ),
    ]);
    let mut a = Applier::new(viewport());
    let store = PayloadStore::default();
    let st = a.apply(&s, &full_delta(&s), &store).clone();
    assert!(st.structural);
    assert_eq!(st.lowered_draws, 2);
    assert_eq!(st.emitted_draws, 2);
    assert_eq!(st.expected_calls, 1, "adjacent white-texel MIX draws merge");
    assert_eq!(a.list.vertices.len(), 8);
    assert_eq!(a.list.indices.len(), 12);
    // Paint order: item 1's quad then item 2's.
    assert_eq!(
        a.list.vertices[a.list.indices[0] as usize].color,
        [1.0, 0.0, 0.0, 1.0]
    );
    assert_eq!(
        a.list.vertices[a.list.indices[6] as usize].color,
        [0.0, 1.0, 0.0, 1.0]
    );
}

#[test]
fn transform_only_patch_moves_one_row_and_no_vertex() {
    let mut s = state_with(vec![
        item(1, ON_ROOT, rect_cmds([0.0, 0.0, 4.0, 4.0], [1.0; 4])),
        item(2, ON_ROOT, rect_cmds([0.0, 0.0, 4.0, 4.0], [1.0; 4])),
    ]);
    let mut a = Applier::new(viewport());
    let store = PayloadStore::default();
    a.apply(&s, &full_delta(&s), &store);
    a.list.consumed();
    s.items.get_mut(&2).unwrap().xform = [1.0, 0.0, 0.0, 1.0, 5.0, 3.0];
    let delta = TxDelta {
        items_upserted: vec![2],
        ..TxDelta::default()
    };
    let st = a.apply(&s, &delta, &store).clone();
    assert!(!st.structural);
    assert_eq!(st.rows_written, 1);
    assert!(a.list.dirty.vertices.is_empty());
    assert!(a.list.dirty.indices.is_empty());
    assert!(!a.list.dirty.draws);
    assert_eq!(a.list.dirty.items.total(), 1);
    let row = a.list.items[a.items[&2].row as usize];
    assert_eq!(row.xform, [1.0, 0.0, 0.0, 1.0, 5.0, 3.0]);
}

#[test]
fn same_shape_content_change_rewrites_vertices_in_place() {
    let mut s = state_with(vec![item(
        1,
        ON_ROOT,
        rect_cmds([0.0, 0.0, 4.0, 4.0], [1.0; 4]),
    )]);
    let mut a = Applier::new(viewport());
    let store = PayloadStore::default();
    a.apply(&s, &full_delta(&s), &store);
    a.list.consumed();
    let it = s.items.get_mut(&1).unwrap();
    it.commands = rect_cmds([0.0, 0.0, 4.0, 4.0], [0.0, 0.0, 1.0, 1.0]);
    it.content_version = 2;
    let delta = TxDelta {
        items_upserted: vec![1],
        items_commands: vec![1],
        ..TxDelta::default()
    };
    let st = a.apply(&s, &delta, &store).clone();
    assert!(!st.structural);
    assert_eq!(st.relowered_in_place, 1);
    assert_eq!(a.list.dirty.vertices.total(), 4);
    assert!(a.list.dirty.indices.is_empty());
}

#[test]
fn behind_child_draws_before_parent_and_z_orders_items() {
    let mut parent = item(
        1,
        ON_ROOT,
        rect_cmds([0.0, 0.0, 4.0, 4.0], [1.0, 0.0, 0.0, 1.0]),
    );
    parent.children = vec![2, 3];
    let mut behind = item(
        2,
        Parent {
            kind: ParentKind::Item,
            id: 1,
        },
        rect_cmds([0.0, 0.0, 2.0, 2.0], [0.0, 1.0, 0.0, 1.0]),
    );
    behind.behind = true;
    let mut high = item(
        3,
        Parent {
            kind: ParentKind::Item,
            id: 1,
        },
        rect_cmds([0.0, 0.0, 1.0, 1.0], [0.0, 0.0, 1.0, 1.0]),
    );
    high.z_index = 1;
    let low = item(
        4,
        ON_ROOT,
        rect_cmds([0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 0.0, 1.0]),
    );
    let s = state_with(vec![parent, behind, high, low]);
    let mut a = Applier::new(viewport());
    a.apply(&s, &full_delta(&s), &PayloadStore::default());
    let colors: Vec<[f32; 4]> = a
        .list
        .draws
        .iter()
        .map(|d| a.list.vertices[a.list.indices[d.first_index as usize] as usize].color)
        .collect();
    // z 0: behind (green), parent (red), item 4 (yellow); z 1: item 3 (blue).
    assert_eq!(
        colors,
        vec![
            [0.0, 1.0, 0.0, 1.0],
            [1.0, 0.0, 0.0, 1.0],
            [1.0, 1.0, 0.0, 1.0],
            [0.0, 0.0, 1.0, 1.0]
        ]
    );
}

#[test]
fn clip_is_the_rounded_scissor_of_the_item_rect() {
    let mut clipper = item(1, ON_ROOT, rect_cmds([0.4, 0.6, 10.2, 5.0], [1.0; 4]));
    clipper.clip = true;
    clipper.children = vec![2];
    clipper.xform = [1.0, 0.0, 0.0, 1.0, 3.0, 2.0];
    let child = item(
        2,
        Parent {
            kind: ParentKind::Item,
            id: 1,
        },
        rect_cmds([0.0, 0.0, 40.0, 40.0], [1.0; 4]),
    );
    let s = state_with(vec![clipper, child]);
    let mut a = Applier::new(viewport());
    a.apply(&s, &full_delta(&s), &PayloadStore::default());
    for d in &a.list.draws {
        assert_eq!(d.flags & DRAW_SCISSOR, DRAW_SCISSOR);
        assert_eq!(d.scissor, [3, 3, 10, 5]);
    }
}

#[test]
fn invisible_subtree_and_alpha_cut_draw_nothing() {
    let mut hidden = item(1, ON_ROOT, rect_cmds([0.0, 0.0, 4.0, 4.0], [1.0; 4]));
    hidden.visible = false;
    let mut faint = item(2, ON_ROOT, rect_cmds([0.0, 0.0, 4.0, 4.0], [1.0; 4]));
    faint.modulate = [1.0, 1.0, 1.0, 0.005];
    let s = state_with(vec![hidden, faint]);
    let mut a = Applier::new(viewport());
    let st = a
        .apply(&s, &full_delta(&s), &PayloadStore::default())
        .clone();
    assert_eq!(st.emitted_draws, 0);
}

#[test]
fn texture_region_uses_texpixel_size_and_flips() {
    let mut s = state_with(vec![item(
        1,
        ON_ROOT,
        Commands {
            list: vec![Command::TextureRectRegion {
                tex: Some(5),
                transpose: false,
                clip_uv: false,
                rect: [10.0, 4.0, -8.0, 8.0],
                src: [8.0, 0.0, 8.0, 16.0],
                modulate: [1.0; 4],
            }],
            ..Commands::default()
        },
    )]);
    let hash = Hash([7; 32]);
    s.textures.insert(
        5,
        Texture {
            id: 5,
            origin: Origin::Created,
            adopted_content: None,
            kind: TextureKind::Image,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            hash: Some(hash),
            format: Some("RGBA8".into()),
            source_format: None,
            width: 16,
            height: 16,
            mipmaps: false,
            payload_bytes: 100,
            variants: Vec::new(),
            canvas: None,
        },
    );
    let mut store = PayloadStore::default();
    store.textures.insert(
        hash,
        payloads::TexturePixels {
            width: 16,
            height: 16,
            rgba: vec![255; 16 * 16 * 4],
            format: "RGBA8".into(),
            mipmaps: false,
            data_len: 16 * 16 * 4,
            compressed: None,
            half: None,
        },
    );
    let mut a = Applier::new(viewport());
    let st = a.apply(&s, &full_delta(&s), &store).clone();
    assert_eq!(st.texture_uploads, 1);
    assert_eq!(a.list.texture_ops.len(), 1);
    assert_eq!(a.list.draws[0].texture, 5);
    // Flip H keeps the position (sizes made positive in place): base (0,0) lands at the right edge, u = 0.5.
    let v0 = a.list.vertices[0];
    assert_eq!(v0.pos, [18.0, 4.0]);
    assert_eq!(v0.uv, [0.5, 0.0]);
    let v2 = a.list.vertices[2];
    assert_eq!(v2.pos, [10.0, 12.0]);
    assert_eq!(v2.uv, [1.0, 1.0]);
}

#[test]
fn custom_rect_off_screen_hides_on_screen_content_and_moving_on_screen_rewalks() {
    // _attach_canvas_item_for_draw: the item's global rect (here its custom rect) must touch the
    // viewport for the item to draw, whatever its commands cover (gate 3's `cull` region).
    let mut it = item(1, ON_ROOT, rect_cmds([0.0, 0.0, 8.0, 8.0], [1.0; 4]));
    it.custom_rect = true;
    it.custom_rect_rect = [-100.0, 0.0, 10.0, 10.0];
    let mut s = state_with(vec![it]);
    let mut a = Applier::new(viewport());
    let store = PayloadStore::default();
    a.apply(&s, &full_delta(&s), &store);
    a.list.consumed();
    assert!(a.list.draws.is_empty());
    // Touching the viewport's edge counts (Rect2::intersects with borders).
    s.items.get_mut(&1).unwrap().xform = [1.0, 0.0, 0.0, 1.0, 90.0, 0.0];
    let delta = TxDelta {
        items_upserted: vec![1],
        ..TxDelta::default()
    };
    let st = a.apply(&s, &delta, &store).clone();
    assert!(st.structural, "coming on screen re-walks");
    assert_eq!(a.list.draws.len(), 1);
}

#[test]
fn clip_uv_splits_the_quad_where_the_uv_meets_the_half_texel_inset() {
    let mut cmds = Commands::default();
    cmds.list.push(Command::TextureRectRegion {
        tex: Some(5),
        transpose: false,
        clip_uv: true,
        rect: [0.0, 0.0, 32.0, 32.0],
        src: [4.0, 0.0, 8.0, 8.0],
        modulate: [1.0; 4],
    });
    let mut s = state_with(vec![item(1, ON_ROOT, cmds)]);
    let hash = Hash([7; 32]);
    s.textures.insert(
        5,
        Texture {
            id: 5,
            origin: Origin::Created,
            adopted_content: None,
            kind: TextureKind::Image,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            hash: Some(hash),
            format: Some("RGBA8".into()),
            source_format: None,
            width: 16,
            height: 16,
            mipmaps: false,
            payload_bytes: 100,
            variants: Vec::new(),
            canvas: None,
        },
    );
    let mut store = PayloadStore::default();
    store.textures.insert(
        hash,
        payloads::TexturePixels {
            width: 16,
            height: 16,
            rgba: vec![255; 16 * 16 * 4],
            format: "RGBA8".into(),
            mipmaps: false,
            data_len: 16 * 16 * 4,
            compressed: None,
            half: None,
        },
    );
    let mut a = Applier::new(viewport());
    a.apply(&s, &full_delta(&s), &store);
    // 3 × 3 cells of 4 vertices; UVs clamped to [4.5, 11.5] / 16 and [0.5, 7.5] / 16.
    assert_eq!(a.list.vertices.len(), 36);
    let (lo, hi) = (4.5 / 16.0, 11.5 / 16.0);
    for v in &a.list.vertices {
        assert!(v.uv[0] >= lo - 1e-7 && v.uv[0] <= hi + 1e-7, "{:?}", v.uv);
        assert!(v.uv[1] >= 0.5 / 16.0 - 1e-7 && v.uv[1] <= 7.5 / 16.0 + 1e-7);
    }
    // The cut is where the uv reaches the inset: half a texel of 8 is 1/16 of the 32-px rect.
    assert!(a.list.vertices.iter().any(|v| (v.pos[0] - 2.0).abs() < 1e-5));
    assert!(a.list.vertices.iter().any(|v| (v.pos[0] - 30.0).abs() < 1e-5));
}
