//! `motion` unit tests over hand-built entries and states, plus the validator's commit hook over
//! the /15 goldens.

use super::*;
use crate::apply::geom::IDENTITY;
use crate::state::*;

const P: MotionParams = MotionParams {
    global: IDENTITY,
    size: [600.0, 800.0],
};

fn entry(id: Id, parent: Parent, commands: Commands) -> Item {
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
        xform: IDENTITY,
        modulate: [1.0; 4],
        self_modulate: [1.0; 4],
        custom_rect_rect: [0.0; 4],
        commands,
    }
}

fn canvas_parent() -> Parent {
    Parent {
        kind: ParentKind::Canvas,
        id: 1,
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
        xform: IDENTITY,
        modulate: [1.0; 4],
    }
}

fn rect(r: [f32; 4]) -> Commands {
    Commands {
        list: vec![Command::TextureRect {
            tex: Some(3),
            tile: false,
            transpose: false,
            rect: r,
            modulate: [1.0; 4],
        }],
        ..Commands::default()
    }
}

/// A spine-like triangle array: 3 points, their colours, UVs and indices.
fn tris(points: [f32; 6], alpha: f32, uvs: [f32; 6]) -> Commands {
    let mut f32s = points.to_vec();
    for _ in 0..3 {
        f32s.extend_from_slice(&[1.0, 1.0, 1.0, alpha]);
    }
    f32s.extend_from_slice(&uvs);
    Commands {
        list: vec![Command::TriangleArray {
            tex: Some(3),
            count: 3,
            points: Span { start: 0, len: 3 },
            colors: Span { start: 6, len: 3 },
            uvs: Span { start: 18, len: 3 },
            indices: Span { start: 0, len: 3 },
        }],
        f32s,
        i32s: vec![0, 1, 2],
    }
}

fn state(items: Vec<Item>, canvas_xform: Xform) -> ResolvedState {
    let mut s = ResolvedState::empty(15);
    let mut c = root();
    c.xform = canvas_xform;
    for it in items {
        if it.parent.map(|p| p.kind) == Some(ParentKind::Canvas) {
            c.items.push(it.id);
        }
        s.items.insert(it.id, it);
    }
    s.canvases.insert(1, c);
    s
}

fn measure(st: &ResolvedState, old: &Item, new: &Item, sent: bool) -> TxMotion {
    let mut m = TxMotion::default();
    item(&mut m, &P, st, Some(old), Some(new), sent);
    m
}

#[test]
fn a_sub_pixel_drift_is_sub_pixel_and_nothing_else() {
    let old = entry(2, canvas_parent(), rect([0.0, 0.0, 2400.0, 1080.0]));
    let mut new = old.clone();
    new.xform[4] += 0.01;
    let st = state(vec![new.clone()], IDENTITY);
    let m = measure(&st, &old, &new, false);
    assert_eq!(m.changes, 0);
    assert!((m.max_px - 0.01).abs() < 1e-6, "{}", m.max_px);
    assert_eq!(m.color_step, 0.0);
}

#[test]
fn a_translation_goes_through_the_parent_chain_and_the_stretch() {
    let mut parent = entry(2, canvas_parent(), Commands::default());
    parent.xform = [2.0, 0.0, 0.0, 2.0, 50.0, 0.0];
    parent.children = vec![3];
    let old = entry(
        3,
        Parent {
            kind: ParentKind::Item,
            id: 2,
        },
        rect([0.0, 0.0, 10.0, 10.0]),
    );
    let mut new = old.clone();
    new.xform[4] += 0.5;
    let st = state(vec![parent, new.clone()], [1.5, 0.0, 0.0, 1.5, 0.0, 0.0]);
    let p = MotionParams {
        global: [2.0, 0.0, 0.0, 2.0, 0.0, 0.0],
        size: [600.0, 800.0],
    };
    let mut m = TxMotion::default();
    item(&mut m, &p, &st, Some(&old), Some(&new), false);
    // 0.5 × item parent 2 × canvas 1.5 × stretch 2.
    assert!((m.max_px - 3.0).abs() < 1e-5, "{}", m.max_px);
}

#[test]
fn a_leaf_rotation_is_bounded_by_its_own_extent_and_a_parent_s_by_the_reach() {
    let old = entry(2, canvas_parent(), rect([-10.0, -10.0, 20.0, 20.0]));
    let mut new = old.clone();
    let a = 0.01f32;
    new.xform = [a.cos(), a.sin(), -a.sin(), a.cos(), 0.0, 0.0];
    let st = state(vec![new.clone()], IDENTITY);
    let leaf = measure(&st, &old, &new, false);
    // The corner at distance 10√2 moves by about 0.01 × 14.1.
    assert!(leaf.max_px > 0.13 && leaf.max_px < 0.15, "{}", leaf.max_px);
    let mut parent_old = old.clone();
    parent_old.children = vec![9];
    let mut parent_new = new.clone();
    parent_new.children = vec![9];
    let st = state(vec![parent_new.clone()], IDENTITY);
    let parent = measure(&st, &parent_old, &parent_new, false);
    // Its children may reach anywhere on screen: 0.01 × 1000.
    assert!(
        parent.max_px > 9.9 && parent.max_px < 10.1,
        "{}",
        parent.max_px
    );
}

#[test]
fn a_singular_transform_is_unbounded() {
    let mut old = entry(2, canvas_parent(), rect([0.0, 0.0, 1.0, 1.0]));
    old.children = vec![9];
    old.xform = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    let mut new = old.clone();
    new.xform = IDENTITY;
    let st = state(vec![new.clone()], IDENTITY);
    assert_eq!(measure(&st, &old, &new, false).max_px, f32::INFINITY);
}

#[test]
fn structure_visibility_and_appearance_are_changes() {
    let old = entry(2, canvas_parent(), rect([0.0, 0.0, 1.0, 1.0]));
    let st = state(vec![old.clone()], IDENTITY);
    let mut m = TxMotion::default();
    item(&mut m, &P, &st, None, Some(&old), true);
    assert_eq!(m.changes, Change::STRUCTURE);
    let mut m = TxMotion::default();
    item(&mut m, &P, &st, Some(&old), None, false);
    assert_eq!(m.changes, Change::STRUCTURE);

    let mut hidden = old.clone();
    hidden.visible = false;
    assert_eq!(
        measure(&st, &old, &hidden, false).changes,
        Change::VISIBILITY
    );
    let mut reordered = old.clone();
    reordered.draw_index += 1;
    assert_eq!(
        measure(&st, &old, &reordered, false).changes,
        Change::STRUCTURE
    );
    let mut material = old.clone();
    material.material = Some(4);
    assert_eq!(
        measure(&st, &old, &material, false).changes,
        Change::APPEARANCE
    );
    let mut clipped = old.clone();
    clipped.clip = true;
    assert_eq!(
        measure(&st, &old, &clipped, false).changes,
        Change::APPEARANCE
    );
    // Culling only: not a change.
    let mut culled = old.clone();
    culled.custom_rect_rect = [1.0, 2.0, 3.0, 4.0];
    assert_eq!(measure(&st, &old, &culled, false), TxMotion::default());
}

#[test]
fn a_hidden_item_changes_nothing() {
    let mut old = entry(2, canvas_parent(), rect([0.0, 0.0, 1.0, 1.0]));
    old.visible = false;
    let mut new = old.clone();
    new.xform[4] = 500.0;
    new.material = Some(9);
    new.commands = rect([0.0, 0.0, 5.0, 5.0]);
    let st = state(vec![new.clone()], IDENTITY);
    assert_eq!(measure(&st, &old, &new, true), TxMotion::default());
}

#[test]
fn modulate_steps_are_colour_steps() {
    let old = entry(2, canvas_parent(), rect([0.0, 0.0, 1.0, 1.0]));
    let mut new = old.clone();
    new.modulate[3] = 0.9;
    new.self_modulate[0] = 0.98;
    let st = state(vec![new.clone()], IDENTITY);
    let m = measure(&st, &old, &new, false);
    assert_eq!(m.changes, 0);
    assert!((m.color_step - 0.1).abs() < 1e-6);
    assert_eq!(m.max_px, 0.0);
}

#[test]
fn a_moving_vertex_list_is_motion_scaled_to_screen() {
    let uvs = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let mut old = entry(
        2,
        canvas_parent(),
        tris([0.0, 0.0, 10.0, 0.0, 0.0, 10.0], 1.0, uvs),
    );
    old.xform = [3.0, 0.0, 0.0, 3.0, 0.0, 0.0];
    let mut new = old.clone();
    new.commands = tris([0.0, 0.0, 10.0, 0.25, 0.0, 10.0], 0.99, uvs);
    let st = state(vec![new.clone()], IDENTITY);
    let m = measure(&st, &old, &new, true);
    assert_eq!(m.changes, 0);
    assert!((m.max_px - 0.75).abs() < 1e-5, "{}", m.max_px);
    assert!((m.color_step - 0.01).abs() < 1e-6);
}

#[test]
fn another_shape_texture_or_uv_is_content() {
    let uvs = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let base = tris([0.0, 0.0, 10.0, 0.0, 0.0, 10.0], 1.0, uvs);
    let old = entry(2, canvas_parent(), base.clone());
    let st = state(vec![old.clone()], IDENTITY);
    let mut uv = old.clone();
    uv.commands = tris(
        [0.0, 0.0, 10.0, 0.0, 0.0, 10.0],
        1.0,
        [0.5, 0.0, 1.0, 0.0, 0.0, 1.0],
    );
    assert_eq!(measure(&st, &old, &uv, true).changes, Change::CONTENT);
    let mut tex = old.clone();
    tex.commands = rect([0.0, 0.0, 1.0, 1.0]);
    assert_eq!(measure(&st, &old, &tex, true).changes, Change::CONTENT);
    let mut swapped = old.clone();
    if let Command::TriangleArray { tex, .. } = &mut swapped.commands.list[0] {
        *tex = Some(4);
    }
    assert_eq!(measure(&st, &old, &swapped, true).changes, Change::CONTENT);
    let mut longer = old.clone();
    longer
        .commands
        .list
        .push(Command::ClipIgnore { ignore: true });
    assert_eq!(measure(&st, &old, &longer, true).changes, Change::CONTENT);
    // Commands that moved into the new entry unchanged are not compared.
    let mut head_only = old.clone();
    head_only.commands = Commands::default();
    assert_eq!(measure(&st, &head_only, &old, false).changes, 0);
}

#[test]
fn text_glyph_regions_are_content_and_their_position_is_motion() {
    let glyph = |x: f32, src: [f32; 4]| Commands {
        list: vec![Command::TextureRectRegion {
            tex: Some(5),
            transpose: false,
            clip_uv: true,
            rect: [x, 0.0, 8.0, 12.0],
            src,
            modulate: [1.0; 4],
        }],
        ..Commands::default()
    };
    let old = entry(2, canvas_parent(), glyph(0.0, [0.0, 0.0, 8.0, 12.0]));
    let st = state(vec![old.clone()], IDENTITY);
    let mut moved = old.clone();
    moved.commands = glyph(4.0, [0.0, 0.0, 8.0, 12.0]);
    let m = measure(&st, &old, &moved, true);
    assert_eq!((m.changes, m.max_px), (0, 4.0));
    let mut retyped = old.clone();
    retyped.commands = glyph(0.0, [8.0, 0.0, 8.0, 12.0]);
    assert_eq!(measure(&st, &old, &retyped, true).changes, Change::CONTENT);
}

#[test]
fn a_canvas_moves_and_restructures() {
    let old = root();
    let mut new = root();
    new.xform[5] = 0.2;
    new.modulate[1] = 0.5;
    let st = ResolvedState::empty(15);
    let mut m = TxMotion::default();
    canvas(&mut m, &P, &st, Some(&old), Some(&new));
    assert!((m.max_px - 0.2).abs() < 1e-6);
    assert_eq!(m.color_step, 0.5);
    assert_eq!(m.changes, 0);
    new.items.push(4);
    canvas(&mut m, &P, &st, Some(&old), Some(&new));
    assert_eq!(m.changes, Change::STRUCTURE);
}

fn dyn_mesh(id: Id, vertices: i64) -> Mesh {
    Mesh {
        id,
        origin: Origin::Created,
        adopted_content: None,
        status: EntryStatus::Ok,
        reason: None,
        version: 1,
        custom_aabb: [0.0; 6],
        surfaces: vec![MeshSurface {
            hash: None,
            body_sha256: Some(Hash([1; 32])),
            payload_bytes: 100,
            primitive: Primitive::Triangles,
            format: 1,
            vertex_count: vertices,
            index_count: 0,
        }],
    }
}

#[test]
fn a_dynamic_body_is_not_a_resource_change_but_its_shape_is() {
    let old = dyn_mesh(7, 4);
    let mut body = old.clone();
    body.surfaces[0].body_sha256 = Some(Hash([2; 32]));
    let mut m = TxMotion::default();
    mesh(&mut m, Some(&old), Some(&body));
    assert_eq!(m.changes, 0);
    mesh(&mut m, Some(&old), Some(&dyn_mesh(7, 5)));
    assert_eq!(m.changes, Change::RESOURCE);
    let mut m = TxMotion::default();
    mesh(&mut m, None, Some(&old));
    assert_eq!(m.changes, Change::RESOURCE);
}

#[test]
fn positions_delta_is_the_largest_vertex_move() {
    assert_eq!(
        positions_delta(&[[0.0, 0.0], [1.0, 1.0]], &[[0.0, 0.0], [4.0, 5.0]]),
        5.0
    );
    assert_eq!(
        positions_delta(&[[0.0, 0.0]], &[[0.0, 0.0], [1.0, 1.0]]),
        f32::INFINITY
    );
}

#[test]
fn a_dynamic_body_moves_through_its_visible_users() {
    let mesh_cmd = |mesh: Id| Commands {
        list: vec![Command::Mesh {
            mesh,
            tex: Some(3),
            transform: [0.5, 0.0, 0.0, 0.5, 0.0, 0.0],
            modulate: [1.0; 4],
        }],
        ..Commands::default()
    };
    let mut a = entry(2, canvas_parent(), mesh_cmd(7));
    a.xform = [4.0, 0.0, 0.0, 4.0, 0.0, 0.0];
    let mut hidden = entry(3, canvas_parent(), mesh_cmd(7));
    hidden.visible = false;
    hidden.xform = [100.0, 0.0, 0.0, 100.0, 0.0, 0.0];
    let st = state(vec![a, hidden], IDENTITY);
    let mut m = TxMotion::default();
    dynamic_mesh(
        &mut m,
        &P,
        &st,
        7,
        BodyDelta {
            px: 0.5,
            color: 0.0,
            reshaped: false,
        },
        [2, 3].into_iter(),
    );
    // 0.5 local × add_mesh 0.5 × item 4; the hidden user does not count.
    assert!((m.max_px - 1.0).abs() < 1e-6, "{}", m.max_px);
    assert_eq!(m.changes, 0);
    let mut m = TxMotion::default();
    dynamic_mesh(&mut m, &P, &st, 7, BodyDelta::NEW, [3].into_iter());
    assert_eq!(m, TxMotion::default());
    dynamic_mesh(&mut m, &P, &st, 7, BodyDelta::NEW, [2].into_iter());
    assert_eq!(m.changes, Change::RESHAPE);
}

#[test]
fn commands_extent_reaches_the_farthest_corner() {
    assert_eq!(commands_extent(&rect([0.0, 0.0, 3.0, 4.0])), Some(5.0));
    let m = Commands {
        list: vec![Command::SetTransform {
            transform: IDENTITY,
        }],
        ..Commands::default()
    };
    assert_eq!(commands_extent(&m), None);
}

/// The commit hook over a real recording: the session's full transaction is all new, every later
/// one measured, and nothing is measured while off.
#[test]
fn the_validator_measures_each_committed_transaction() {
    use crate::validate::{Accepted, DigestPolicy, Options, Validator};
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../protocol/golden-15");
    let data = std::fs::read(format!("{dir}/patch.rs15")).expect("golden-15/patch.rs15");
    let records = crate::wire::split_records(&data, 15).expect("records");
    let opts = Options {
        version: 15,
        digest: DigestPolicy::Never,
        verify_payload_hashes: true,
        early_prune: false,
        no_predict_reset: false,
        item_meta: Default::default(),
    };
    let first = records[0];
    let mut v = Validator::new(first.bytes(&data), first.offset, opts.clone()).expect("session");
    let mut off = Validator::new(first.bytes(&data), first.offset, opts).expect("session");
    v.set_motion(Some(P));
    assert_eq!(v.motion(), Some(&TxMotion::default()));
    let mut seen = Vec::new();
    for r in &records[1..] {
        let a = v.accept(r.bytes(&data), r.offset).expect("accept");
        off.accept(r.bytes(&data), r.offset).expect("accept");
        assert!(off.motion().is_none());
        if matches!(a, Accepted::Transaction) {
            seen.push((v.delta().full, *v.motion().expect("on")));
        }
    }
    assert!(seen.len() >= 2, "{seen:?}");
    for (full, m) in &seen {
        if *full {
            assert_eq!(m.changes, Change::FULL, "{m:?}");
        } else {
            assert_eq!(m.changes & Change::FULL, 0, "{m:?}");
        }
    }
    assert!(seen[0].0, "a recording starts with a full");
    assert!(
        seen.iter()
            .any(|(full, m)| !full && *m != TxMotion::default()),
        "a patch of the golden changes something: {seen:?}"
    );
}

/// The dynamic mesh half over golden-11's dynamic bodies: each replaced body reports how far it
/// moved (only while measuring), and the receiver maps it to the screen through its users.
#[test]
fn dynamic_bodies_report_their_displacement_only_while_measuring() {
    use crate::apply::payloads::PayloadStore;
    use crate::validate::{Accepted, Options, Validator};
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../protocol/golden-11");
    let data = std::fs::read(format!("{dir}/inline.rs11")).expect("golden-11/inline.rs11");
    let spans = crate::wire::split_records(&data, 11).expect("records");
    for measure in [false, true] {
        let mut v = Validator::new(spans[0].bytes(&data), spans[0].offset, Options::new(11))
            .expect("session");
        v.set_motion(Some(P));
        let mut store = PayloadStore::default();
        store.dynamic.measure = measure;
        let (mut reported, mut compared) = (0, 0);
        for span in &spans[1..] {
            let rec = span.bytes(&data);
            if let Accepted::Transaction = v.accept(rec, span.offset).expect("accept") {
                let bodies = store.accept_transaction(&v, rec).expect("ingest");
                assert_eq!(
                    store.dynamic.moved.len(),
                    if measure { bodies as usize } else { 0 }
                );
                let mut m = *v.motion().expect("on");
                for &(mesh, d) in &store.dynamic.moved {
                    reported += 1;
                    if !d.reshaped {
                        compared += 1;
                    }
                    dynamic_mesh(&mut m, &P, v.state(), mesh, d, v.mesh_users(mesh));
                }
                assert!(!m.max_px.is_nan());
            }
        }
        if measure {
            assert!(reported >= 3, "{reported}");
            assert!(
                compared >= 1,
                "a body replaced one of the same vertex count: {compared}"
            );
        } else {
            assert_eq!(reported, 0);
        }
    }
}

// ---- gate fix round: regressions

/// A clipping item's custom rect is its clip rect: resizing it changes what is drawn.
#[test]
fn fix2_a_clipping_custom_rect_change_is_appearance() {
    let mut old = entry(2, canvas_parent(), Commands::default());
    old.custom_rect = true;
    old.clip = true;
    old.custom_rect_rect = [0.0, 0.0, 100.0, 100.0];
    old.children = vec![9];
    let mut new = old.clone();
    new.custom_rect_rect = [0.0, 0.0, 100.0, 60.0];
    let st = state(vec![new.clone()], IDENTITY);
    assert_eq!(
        measure(&st, &old, &new, false).changes & Change::APPEARANCE,
        Change::APPEARANCE
    );
}

/// A primitive after `add_set_transform` moves through that transform.
#[test]
fn fix4_a_set_transform_scales_the_commands_after_it() {
    let list = |x: f32| Commands {
        list: vec![
            Command::SetTransform {
                transform: [4.0, 0.0, 0.0, 4.0, 0.0, 0.0],
            },
            Command::Rect {
                aa: false,
                rect: [x, 0.0, 1.0, 1.0],
                color: [1.0; 4],
            },
        ],
        ..Commands::default()
    };
    let old = entry(2, canvas_parent(), list(0.0));
    let mut new = old.clone();
    new.commands = list(0.5);
    let st = state(vec![new.clone()], IDENTITY);
    let m = measure(&st, &old, &new, true);
    assert!((m.max_px - 2.0).abs() < 1e-5, "{}", m.max_px);
}

/// A non-leaf item turning under a non-uniform parent: the screen moves by the conjugated change
/// (`‖P·dA·A⁻¹·P⁻¹‖`), up to 10× the parent-space one under a 10:1 parent.
#[test]
fn fixb_a_non_uniform_parent_conjugates_the_linear_change() {
    let mut parent = entry(2, canvas_parent(), Commands::default());
    parent.xform = [10.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    parent.children = vec![3];
    let mut old = entry(
        3,
        Parent {
            kind: ParentKind::Item,
            id: 2,
        },
        Commands::default(),
    );
    old.children = vec![9];
    let mut new = old.clone();
    let a = 0.01f32;
    new.xform = [a.cos(), a.sin(), -a.sin(), a.cos(), 0.0, 0.0];
    let st = state(vec![parent, new.clone()], IDENTITY);
    // ‖P·dR·P⁻¹‖ ≈ 10 × 0.01, at the farthest corner 1000 px away.
    let m = measure(&st, &old, &new, false);
    assert!(m.max_px > 99.0 && m.max_px < 101.0, "{}", m.max_px);
}

/// A parent turning about an origin far off screen sweeps what is on screen by the angle times
/// that distance, not times the diagonal.
#[test]
fn fixb_an_off_screen_origin_reaches_by_its_distance() {
    let mut old = entry(2, canvas_parent(), Commands::default());
    old.children = vec![9];
    old.xform[4] = 5000.0;
    let mut new = old.clone();
    let a = 0.01f32;
    new.xform = [a.cos(), a.sin(), -a.sin(), a.cos(), 5000.0, 0.0];
    let st = state(vec![new.clone()], IDENTITY);
    // The farthest corner of a 600x800 viewport from (5000, 0) is (0, 800): 5063.6 px.
    let m = measure(&st, &old, &new, false);
    assert!(m.max_px > 50.0 && m.max_px < 51.5, "{}", m.max_px);
}

fn sub_viewport(id: Id, canvas: Id) -> ViewportSurface {
    ViewportSurface {
        id,
        origin: Origin::Created,
        parent: Some(0),
        active: true,
        active_seq: 1,
        size: [256, 256],
        transparent: false,
        update: ViewportUpdate::Always,
        once_seq: 0,
        clear: ViewportClear::Always,
        clear_seq: 0,
        disable_2d: false,
        renders_3d: false,
        hdr_2d: false,
        msaa_2d: 0,
        canvas_cull_mask: 1,
        default_texture_filter: Filter::Linear,
        default_texture_repeat: Repeat::Disabled,
        snap_2d: [false, false],
        canvases: vec![ViewportCanvas {
            canvas,
            layer: 0,
            sublayer: 0,
        }],
        global_xform: IDENTITY,
        canvas_xforms: vec![IDENTITY],
    }
}

/// Content of a canvas a sub-viewport draws is shown through that viewport's texture at a scale
/// the measure does not follow: any change of it wakes.
#[test]
fn fixb_sub_viewport_content_changes_wake() {
    let sub = Parent {
        kind: ParentKind::Canvas,
        id: 5,
    };
    let old = entry(2, sub, rect([0.0, 0.0, 10.0, 10.0]));
    let mut new = old.clone();
    new.xform[4] += 0.01;
    let mut st = state(vec![new.clone()], IDENTITY);
    let mut c = root();
    c.id = 5;
    c.root = false;
    c.attached = false;
    c.items = vec![2];
    st.canvases.insert(5, c);
    st.viewports.insert(7, sub_viewport(7, 5));
    let m = measure(&st, &old, &new, false);
    assert_ne!(m.changes, 0, "{m:?}");
}

#[test]
fn fix1_a_viewport_added_or_removed_is_structure_and_a_change_appearance() {
    let v = sub_viewport(7, 5);
    let mut m = TxMotion::default();
    viewport(&mut m, None, Some(&v));
    assert_eq!(m.changes, Change::STRUCTURE);
    let mut m = TxMotion::default();
    viewport(&mut m, Some(&v), None);
    assert_eq!(m.changes, Change::STRUCTURE);
    let mut resized = v.clone();
    resized.size = [128, 128];
    let mut m = TxMotion::default();
    viewport(&mut m, Some(&v), Some(&resized));
    assert_eq!(m.changes, Change::APPEARANCE);
}

/// The commit hook over golden-16's viewport recording: the viewport table's changes are
/// classified (the build broke on the /16 undo entry before).
#[test]
fn fix1_the_validator_classifies_viewport_changes() {
    use crate::validate::{Accepted, DigestPolicy, Options, Validator};
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../protocol/golden-16");
    let data = std::fs::read(format!("{dir}/viewports.rs16")).expect("golden-16/viewports.rs16");
    let records = crate::wire::split_records(&data, 16).expect("records");
    let opts = Options {
        version: 16,
        digest: DigestPolicy::Never,
        verify_payload_hashes: true,
        early_prune: false,
        no_predict_reset: false,
        item_meta: Default::default(),
    };
    let first = records[0];
    let mut v = Validator::new(first.bytes(&data), first.offset, opts).expect("session");
    v.set_motion(Some(P));
    let mut patches = Vec::new();
    for r in &records[1..] {
        if let Accepted::Transaction = v.accept(r.bytes(&data), r.offset).expect("accept") {
            if !v.delta().full {
                patches.push((v.state().viewports.len(), *v.motion().expect("on")));
            }
        }
    }
    assert!(!patches.is_empty());
    assert!(
        patches.iter().any(|(_, m)| m.changes
            & (Change::STRUCTURE | Change::APPEARANCE | Change::VIEWPORT)
            != 0),
        "{patches:?}"
    );
}

/// Off a clipping item, a custom rect only culls: its edges moving is motion, not a change.
#[test]
fn fix2_a_culling_custom_rect_moves_as_motion() {
    let mut old = entry(2, canvas_parent(), Commands::default());
    old.custom_rect = true;
    old.custom_rect_rect = [0.0, 0.0, 100.0, 100.0];
    let mut new = old.clone();
    new.custom_rect_rect = [0.0, 0.0, 100.25, 100.0];
    let st = state(vec![new.clone()], IDENTITY);
    let m = measure(&st, &old, &new, false);
    assert_eq!(m.changes, 0);
    assert!((m.max_px - 0.25).abs() < 1e-5, "{}", m.max_px);
}

fn geometry(
    positions: Vec<[f32; 2]>,
    colors: Option<Vec<[f32; 4]>>,
    uvs: Option<Vec<[f32; 2]>>,
    indices: Option<Vec<u32>>,
) -> crate::apply::payloads::MeshGeometry {
    let n = positions.len();
    crate::apply::payloads::MeshGeometry {
        primitive: Primitive::Triangles,
        positions,
        colors,
        uvs,
        indices,
        aabb: [0.0; 6],
        layout: crate::apply::payloads::MeshLayout {
            primitive: Primitive::Triangles,
            format: 1,
            vertex_count: n,
            index_count: 0,
            buffer_bytes: [0; 4],
            aabb_bits: [0; 6],
            uv_scale_bits: [0; 4],
        },
        buffers: Default::default(),
    }
}

#[test]
fn fix3_a_body_s_colours_uvs_and_indices_are_seen() {
    let pos = vec![[0.0, 0.0], [10.0, 0.0], [0.0, 10.0]];
    let col = |a: f32| Some(vec![[1.0, 1.0, 1.0, a]; 3]);
    let uv = |u: f32| Some(vec![[0.0, 0.0], [u, 0.0], [0.0, 1.0]]);
    let idx = |k: u32| Some(vec![0, 1, k]);
    let base = geometry(pos.clone(), col(1.0), uv(1.0), idx(2));
    // A slot colour flash: a colour step, no reshape.
    let flash = body_delta(&base, &geometry(pos.clone(), col(0.5), uv(1.0), idx(2)));
    assert_eq!((flash.color, flash.reshaped), (0.5, false));
    // An attachment swap (other UVs) and a draw-order change (other indices) are not motion.
    assert!(body_delta(&base, &geometry(pos.clone(), col(1.0), uv(0.5), idx(2))).reshaped);
    assert!(body_delta(&base, &geometry(pos.clone(), col(1.0), uv(1.0), idx(0))).reshaped);
    assert!(body_delta(&base, &geometry(pos.clone(), None, uv(1.0), idx(2))).reshaped);
    let moved = body_delta(
        &base,
        &geometry(
            vec![[0.0, 0.0], [10.0, 3.0], [0.0, 14.0]],
            col(1.0),
            uv(1.0),
            idx(2),
        ),
    );
    assert_eq!((moved.px, moved.reshaped), (4.0, false));
    // Through a visible user: the colour step counts, a reshape is a change.
    let mut st = state(vec![], IDENTITY);
    let user = entry(
        2,
        canvas_parent(),
        Commands {
            list: vec![Command::Mesh {
                mesh: 7,
                tex: None,
                transform: IDENTITY,
                modulate: [1.0; 4],
            }],
            ..Commands::default()
        },
    );
    st.items.insert(2, user);
    let mut m = TxMotion::default();
    dynamic_mesh(&mut m, &P, &st, 7, flash, [2].into_iter());
    assert_eq!((m.changes, m.color_step), (0, 0.5));
    let mut m = TxMotion::default();
    let swap = body_delta(&base, &geometry(pos, col(1.0), uv(0.5), idx(2)));
    dynamic_mesh(&mut m, &P, &st, 7, swap, [2].into_iter());
    assert_eq!(m.changes, Change::RESHAPE);
}

/// A dynamic mesh a multimesh or particles entry draws moves through instances the measure does
/// not follow: any change of its body wakes.
#[test]
fn fixb_a_body_drawn_by_a_multimesh_or_particles_wakes() {
    let small = BodyDelta {
        px: 0.01,
        color: 0.0,
        reshaped: false,
    };
    let mut st = state(vec![], IDENTITY);
    st.multimeshes.insert(
        3,
        Multimesh {
            id: 3,
            origin: Origin::Created,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            mesh: Some(7),
            format: MultimeshFormat::ALL[0],
            colors: false,
            custom: false,
            instances: 4,
            visible: -1,
            custom_aabb: Some([0.0; 6]),
            buffer_sha256: None,
        },
    );
    let mut m = TxMotion::default();
    dynamic_mesh(&mut m, &P, &st, 7, small, std::iter::empty());
    assert_eq!(m.changes, Change::RESHAPE);
    let mut m = TxMotion::default();
    dynamic_mesh(&mut m, &P, &st, 8, small, std::iter::empty());
    assert_eq!(m, TxMotion::default());
}

/// A dynamic body drawn inside a sub-viewport wakes.
#[test]
fn fixb_a_body_drawn_in_a_sub_viewport_wakes() {
    let sub = Parent {
        kind: ParentKind::Canvas,
        id: 5,
    };
    let user = entry(
        2,
        sub,
        Commands {
            list: vec![Command::Mesh {
                mesh: 7,
                tex: None,
                transform: IDENTITY,
                modulate: [1.0; 4],
            }],
            ..Commands::default()
        },
    );
    let mut st = state(vec![user], IDENTITY);
    let mut c = root();
    c.id = 5;
    c.root = false;
    c.attached = false;
    c.items = vec![2];
    st.canvases.insert(5, c);
    st.viewports.insert(7, sub_viewport(7, 5));
    let mut m = TxMotion::default();
    let d = BodyDelta {
        px: 0.01,
        color: 0.0,
        reshaped: false,
    };
    dynamic_mesh(&mut m, &P, &st, 7, d, [2].into_iter());
    assert_eq!(m.changes, Change::VIEWPORT);
}
