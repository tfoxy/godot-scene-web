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
    let tri = |dx: f32| {
        geometry(
            vec![[dx, 0.0], [10.0 + dx, 0.0], [dx, 10.0]],
            None,
            None,
            None,
        )
    };
    let mut m = TxMotion::default();
    dynamic_mesh(
        &mut m,
        &P,
        &st,
        7,
        Some(&tri(0.0)),
        &tri(0.5),
        [2, 3].into_iter(),
    );
    // 0.5 local × add_mesh 0.5 × item 4, as animation content; the hidden user does not count.
    assert!((m.anim_px - 1.0).abs() < 1e-6, "{}", m.anim_px);
    assert_eq!((m.changes, m.max_px), (0, 0.0));
    let mut m = TxMotion::default();
    dynamic_mesh(&mut m, &P, &st, 7, None, &tri(0.5), [3].into_iter());
    assert_eq!(m, TxMotion::default());
    dynamic_mesh(&mut m, &P, &st, 7, None, &tri(0.5), [2].into_iter());
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
                for (mesh, surface, old) in &store.dynamic.moved {
                    reported += 1;
                    let new = store.dynamic.get(*mesh).expect("held").surfaces[*surface as usize]
                        .as_ref()
                        .expect("body");
                    if old.as_ref().is_some_and(|o| !body_delta(o, new).reshaped) {
                        compared += 1;
                    }
                }
                ingested(&mut m, &P, &v, &store);
                assert!(!m.max_px.is_nan() && !m.anim_px.is_nan());
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
    let flashed = geometry(pos.clone(), col(0.5), uv(1.0), idx(2));
    dynamic_mesh(&mut m, &P, &st, 7, Some(&base), &flashed, [2].into_iter());
    assert_eq!((m.changes, m.anim_color), (0, 0.5));
    let mut m = TxMotion::default();
    let swapped = geometry(pos, col(1.0), uv(0.5), idx(2));
    dynamic_mesh(&mut m, &P, &st, 7, Some(&base), &swapped, [2].into_iter());
    assert_eq!(m.changes, Change::RESHAPE);
}

/// A dynamic mesh a multimesh or particles entry draws moves through instances the measure does
/// not follow: any change of its body wakes.
#[test]
fn fixb_a_body_drawn_by_a_multimesh_or_particles_wakes() {
    let tri = |dx: f32| {
        geometry(
            vec![[dx, 0.0], [10.0 + dx, 0.0], [dx, 10.0]],
            None,
            None,
            None,
        )
    };
    let (a, b) = (tri(0.0), tri(0.01));
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
    dynamic_mesh(&mut m, &P, &st, 7, Some(&a), &b, std::iter::empty());
    assert_eq!(m.changes, Change::RESHAPE);
    let mut m = TxMotion::default();
    dynamic_mesh(&mut m, &P, &st, 8, Some(&a), &b, std::iter::empty());
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
    let tri = |dx: f32| {
        geometry(
            vec![[dx, 0.0], [10.0 + dx, 0.0], [dx, 10.0]],
            None,
            None,
            None,
        )
    };
    dynamic_mesh(
        &mut m,
        &P,
        &st,
        7,
        Some(&tri(0.0)),
        &tri(0.01),
        [2].into_iter(),
    );
    assert_eq!(m.changes, Change::VIEWPORT);
}

// ---- animation content: multimesh instances, emitters, static geometry, faint and off screen

fn static_mesh(id: Id, hash: u8) -> Mesh {
    let mut m = dyn_mesh(id, 3);
    m.surfaces[0].hash = Some(Hash([hash; 32]));
    m.surfaces[0].body_sha256 = None;
    m
}

/// A CPU-particles-like multimesh (2D, colours and custom data, `instances` of them) drawn by
/// item 2 with `material` (none: the default shader), and its mesh 7.
fn particles_scene(instances: i64, material: Option<Id>) -> ResolvedState {
    let mut user = entry(
        2,
        canvas_parent(),
        Commands {
            list: vec![Command::Multimesh {
                multimesh: 3,
                tex: None,
            }],
            ..Commands::default()
        },
    );
    user.material = material;
    let mut st = state(vec![user], IDENTITY);
    st.meshes.insert(7, static_mesh(7, 9));
    st.multimeshes.insert(3, multimesh_entry(instances));
    st
}

fn multimesh_entry(instances: i64) -> Multimesh {
    Multimesh {
        id: 3,
        origin: Origin::Created,
        status: EntryStatus::Ok,
        reason: None,
        version: 1,
        mesh: Some(7),
        format: MultimeshFormat::D2,
        colors: true,
        custom: true,
        instances,
        visible: -1,
        custom_aabb: Some([0.0; 6]),
        buffer_sha256: Some(Hash([1; 32])),
    }
}

/// One instance of a 2D multimesh buffer with colours and custom data (16 floats): scale `s`
/// at `(x, y)`, colour `c`, custom `d`.
fn inst(s: f32, x: f32, y: f32, c: [f32; 4], d: [f32; 4]) -> Vec<f32> {
    let mut f = vec![s, 0.0, 0.0, x, 0.0, s, 0.0, y];
    f.extend(c);
    f.extend(d);
    f
}

fn instances_motion(st: &ResolvedState, old: &[f32], new: &[f32]) -> TxMotion {
    let mut m = TxMotion::default();
    // The mesh reaches 10 px from its origin.
    multimesh_buffer(
        &mut m,
        &P,
        st,
        3,
        Some(old),
        new,
        Some(10.0),
        [2].into_iter(),
    );
    m
}

#[test]
fn version_only_entries_change_nothing() {
    let old = static_mesh(7, 9);
    let mut new = old.clone();
    new.version = 5;
    let mut m = TxMotion::default();
    assert!(!mesh(&mut m, Some(&old), Some(&new)));
    assert_eq!(m, TxMotion::default());
    let old = multimesh_entry(4);
    let mut new = old.clone();
    new.version = 9;
    multimesh(&mut m, Some(&old), Some(&new));
    assert_eq!(m, TxMotion::default());
}

#[test]
fn a_multimesh_buffer_is_unmeasured_until_the_receiver_measures_it_and_its_config_is_a_resource() {
    let old = multimesh_entry(4);
    let mut buffer = old.clone();
    buffer.version = 2;
    buffer.buffer_sha256 = Some(Hash([2; 32]));
    let mut m = TxMotion::default();
    multimesh(&mut m, Some(&old), Some(&buffer));
    assert_eq!(m.changes, Change::UNMEASURED);
    // Amount (a reallocation), visible count, mesh, a new or freed multimesh: resource changes.
    for change in [
        |e: &mut Multimesh| e.instances = 5,
        |e: &mut Multimesh| e.visible = 2,
        |e: &mut Multimesh| e.mesh = Some(8),
        |e: &mut Multimesh| e.status = EntryStatus::Freed,
    ] {
        let mut new = buffer.clone();
        change(&mut new);
        let mut m = TxMotion::default();
        multimesh(&mut m, Some(&old), Some(&new));
        assert_eq!(m.changes & Change::RESOURCE, Change::RESOURCE, "{new:?}");
    }
    let mut m = TxMotion::default();
    multimesh(&mut m, None, Some(&old));
    assert_eq!(m.changes, Change::RESOURCE);
}

#[test]
fn ambient_particle_ticks_are_animation_within_their_drift() {
    let st = particles_scene(2, None);
    let white = [1.0, 1.0, 1.0, 0.8];
    let old = [
        inst(1.0, 100.0, 100.0, white, [0.0, 0.2, 0.0, 1.0]),
        inst(2.0, 300.0, 200.0, white, [0.0, 0.5, 0.0, 1.0]),
    ]
    .concat();
    let new = [
        inst(1.0, 101.5, 100.0, white, [0.0, 0.21, 0.0, 1.0]),
        inst(
            2.02,
            300.0,
            202.0,
            [1.0, 1.0, 1.0, 0.79],
            [0.0, 0.51, 0.0, 1.0],
        ),
    ]
    .concat();
    let m = instances_motion(&st, &old, &new);
    assert_eq!((m.changes, m.max_px, m.color_step), (0, 0.0, 0.0));
    // 2 px of translation plus 0.02 of scale times the 10 px reach; the faster mote's 1.5 px.
    assert!((m.anim_px - 2.2).abs() < 1e-4, "{m:?}");
    assert!((m.anim_color - 0.01).abs() < 1e-6, "{m:?}");
}

#[test]
fn a_faint_respawn_is_ambient_and_a_visible_pop_is_not() {
    let st = particles_scene(1, None);
    let faint = [1.0, 1.0, 1.0, 2.0 / 255.0];
    // Died faded out at one end of the screen, respawned faded in at the other.
    let m = instances_motion(
        &st,
        &inst(1.0, 20.0, 20.0, faint, [0.0; 4]),
        &inst(1.0, 580.0, 780.0, faint, [0.0; 4]),
    );
    assert_eq!(m.anim_px, 0.0, "{m:?}");
    assert!(m.anim_color <= FAINT_ALPHA);
    // Respawned at full opacity: it pops in, a colour step of the whole fade.
    let m = instances_motion(
        &st,
        &inst(1.0, 20.0, 20.0, faint, [0.0; 4]),
        &inst(1.0, 580.0, 780.0, [1.0; 4], [0.0; 4]),
    );
    assert!(m.anim_color > 0.9, "{m:?}");
    // What appeared lies within its 10 px reach.
    assert!((m.anim_px - 10.0).abs() < 1e-4, "{m:?}");
    // A zero-area (inactive) particle that becomes active and visible pops in the same way.
    let m = instances_motion(
        &st,
        &inst(0.0, 0.0, 0.0, [0.0; 4], [0.0; 4]),
        &inst(1.0, 300.0, 300.0, [1.0; 4], [0.0; 4]),
    );
    assert!((m.anim_px - 10.0).abs() < 1e-4, "{m:?}");
    // Under an additive blend a dark particle reaches no pixel: it is faint at full alpha.
    let mut st = particles_scene(1, Some(4));
    add_builtin(&mut st, 4, BlendMode::Add, false);
    let dark = [0.01, 0.01, 0.01, 1.0];
    let m = instances_motion(
        &st,
        &inst(1.0, 20.0, 20.0, dark, [0.0; 4]),
        &inst(1.0, 580.0, 780.0, dark, [0.0; 4]),
    );
    assert_eq!(m.anim_px, 0.0, "{m:?}");
}

#[test]
fn an_off_screen_particle_moves_invisibly() {
    let st = particles_scene(1, None);
    let m = instances_motion(
        &st,
        &inst(1.0, -500.0, 100.0, [1.0; 4], [0.0; 4]),
        &inst(1.0, -100.0, 100.0, [1.0; 4], [0.0; 4]),
    );
    assert_eq!((m.anim_px, m.anim_color), (0.0, 0.0));
}

#[test]
fn custom_data_a_material_reads_and_an_unmeasurable_buffer_wake() {
    let mut st = particles_scene(1, Some(4));
    add_builtin(&mut st, 4, BlendMode::Mix, true);
    let a = inst(1.0, 100.0, 100.0, [1.0; 4], [0.0, 0.0, 0.0, 1.0]);
    let b = inst(1.0, 100.0, 100.0, [1.0; 4], [0.0, 0.0, 0.5, 1.0]);
    assert_eq!(instances_motion(&st, &a, &b).changes, Change::RESHAPE);
    // No material: custom data drives nothing.
    let st = particles_scene(1, None);
    assert_eq!(instances_motion(&st, &a, &b), TxMotion::default());
    // Another length, no previous buffer, an unknown mesh reach.
    let two = [a.clone(), a.clone()].concat();
    assert_eq!(instances_motion(&st, &a, &two).changes, Change::RESHAPE);
    let mut m = TxMotion::default();
    multimesh_buffer(&mut m, &P, &st, 3, None, &a, Some(10.0), [2].into_iter());
    assert_eq!(m.changes, Change::RESHAPE);
    let mut m = TxMotion::default();
    multimesh_buffer(&mut m, &P, &st, 3, Some(&a), &b, None, [2].into_iter());
    assert_eq!(m.changes, Change::RESHAPE);
}

#[test]
fn a_mesh_reach_needs_every_static_payload() {
    let st = particles_scene(1, None);
    let g = geometry(vec![[-3.0, -4.0], [3.0, 0.0], [0.0, 1.0]], None, None, None);
    let held = |h: &Hash| (*h == Hash([9; 32])).then_some(&g);
    assert_eq!(mesh_reach(&st, 7, held), Some(5.0));
    assert_eq!(mesh_reach(&st, 7, |_| None), None);
    assert_eq!(mesh_reach(&st, 8, held), None);
}

fn add_builtin(st: &mut ResolvedState, material: Id, blend: BlendMode, particles_animation: bool) {
    st.shaders.insert(
        material,
        Shader {
            id: material,
            origin: Origin::Created,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            mode: Some(ShaderMode::CanvasItem),
            source: None,
            hash: None,
            payload_bytes: 0,
            builtin: Some(Builtin {
                blend_mode: blend,
                light_mode: LightMode::Normal,
                particles_animation,
            }),
            process: None,
            uses: Vec::new(),
            default_textures: Vec::new(),
        },
    );
    st.materials.insert(
        material,
        Material {
            id: material,
            origin: Origin::Created,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            shader: Some(material),
            params: Vec::new(),
        },
    );
}

fn emitter() -> Particles {
    let mut floats = vec![0.0f32; 31];
    // An identity emission transform (basis rows, then origin).
    floats[16] = 1.0;
    floats[20] = 1.0;
    floats[24] = 1.0;
    Particles {
        id: 5,
        origin: Origin::Created,
        status: EntryStatus::Ok,
        reason: None,
        version: 1,
        mode: ParticlesMode::D2,
        emitting: true,
        amount: 16,
        one_shot: false,
        fixed_fps: 30,
        interpolate: true,
        fractional_delta: true,
        local: false,
        draw_order: ParticlesDrawOrder::Index,
        transform_align: ParticlesTransformAlign::Disabled,
        trails: false,
        trail_poses: 0,
        seed: 7,
        restarts: 0,
        emits: 0,
        process_requests: 0,
        process_material: Some(6),
        draw_passes: vec![None],
        subemitter: None,
        floats: Some(ParticleFloats::from_wire(&floats)),
    }
}

fn emitter_scene() -> ResolvedState {
    let user = entry(
        2,
        canvas_parent(),
        Commands {
            list: vec![Command::Particles {
                particles: 5,
                tex: None,
            }],
            ..Commands::default()
        },
    );
    let mut st = state(vec![user], IDENTITY);
    st.particles.insert(5, emitter());
    st
}

fn emitter_motion(st: &ResolvedState, old: &Particles, new: &Particles) -> TxMotion {
    let mut m = TxMotion::default();
    particles(&mut m, &P, st, Some(old), Some(new), [2].into_iter());
    m
}

#[test]
fn an_emitter_s_per_tick_inputs_are_ambient_and_bounded_by_its_motion() {
    let st = emitter_scene();
    let old = emitter();
    let mut new = old.clone();
    new.version = 2;
    assert_eq!(emitter_motion(&st, &old, &new), TxMotion::default());
    // The emitter's node drifted by 0.6 px: where new particles spawn moves by as much.
    new.floats.as_mut().unwrap().emission_transform[9] = 0.6;
    let m = emitter_motion(&st, &old, &new);
    assert_eq!(m.changes, 0);
    assert!((m.max_px - 0.6).abs() < 1e-6, "{m:?}");
    // Its velocity moves particles unless the process material inherits none of it.
    let mut fast = new.clone();
    fast.floats.as_mut().unwrap().emitter_velocity = [36.0, 0.0, 0.0];
    assert_eq!(emitter_motion(&st, &old, &fast).changes, Change::RESOURCE);
    let mut st = st;
    add_builtin(&mut st, 6, BlendMode::Mix, false);
    let process = st.shaders.get_mut(&6).unwrap();
    process.builtin = None;
    process.process = Some(empty_process_builtin());
    st.materials.get_mut(&6).unwrap().params = vec![Param {
        name: "inherit_velocity_ratio".into(),
        ty: VariantType::ALL[3],
        value: ParamValue::Scalar(0.0),
    }];
    assert_eq!(emitter_motion(&st, &old, &fast).changes, 0);
}

#[test]
fn an_emitter_s_restart_toggle_amount_config_or_arrival_wakes() {
    let st = emitter_scene();
    let old = emitter();
    let changes: [fn(&mut Particles); 8] = [
        |e| e.emitting = false,
        |e| e.restarts = 1,
        |e| e.amount = 32,
        |e| e.emits = 1,
        |e| e.seed = 8,
        |e| e.process_material = Some(9),
        |e| e.floats.as_mut().unwrap().lifetime = 2.0,
        |e| e.floats.as_mut().unwrap().speed_scale = 2.0,
    ];
    for change in changes {
        let mut new = old.clone();
        change(&mut new);
        assert_eq!(
            emitter_motion(&st, &old, &new).changes,
            Change::RESOURCE,
            "{new:?}"
        );
    }
    let mut m = TxMotion::default();
    particles(&mut m, &P, &st, None, Some(&old), [2].into_iter());
    assert_eq!(m.changes, Change::RESOURCE);
    let mut m = TxMotion::default();
    particles(&mut m, &P, &st, Some(&old), None, std::iter::empty());
    assert_eq!(m.changes, Change::RESOURCE);
}

fn empty_process_builtin() -> ProcessBuiltin {
    ProcessBuiltin {
        emission_shape: EmissionShape::Point,
        particle_flags: Vec::new(),
        textures: Vec::new(),
        color_ramp: false,
        color_initial_ramp: false,
        alpha_curve: false,
        emission_curve: false,
        velocity_limit_curve: false,
        orbit_velocity_curve_xyz: false,
        emission_color_texture: false,
        sub_emitter: SubEmitterMode::ALL[0],
        attractor: false,
        collision: CollisionMode::ALL[0],
        collision_scale: false,
        turbulence: false,
    }
}

#[test]
fn a_static_mesh_with_new_payloads_is_measured_by_the_receiver_and_a_new_layout_is_a_resource() {
    let old = static_mesh(7, 9);
    let new = static_mesh(7, 10);
    let mut m = TxMotion::default();
    assert!(mesh(&mut m, Some(&old), Some(&new)));
    assert_eq!(m.changes, Change::UNMEASURED);
    let mut other = new.clone();
    other.surfaces[0].vertex_count = 4;
    let mut m = TxMotion::default();
    assert!(!mesh(&mut m, Some(&old), Some(&other)));
    assert_eq!(m.changes, Change::RESOURCE);
}

#[test]
fn a_flipbook_is_recognised_from_its_second_loop() {
    let mut f = MeshFrames::default();
    let (a, b, c) = ([Hash([1; 32])], [Hash([2; 32])], [Hash([3; 32])]);
    assert!(!f.swap(7, &a, &b));
    assert!(!f.swap(7, &b, &c));
    assert!(f.swap(7, &c, &a), "a returns");
    assert!(f.swap(7, &a, &b));
    assert!(!f.swap(8, &a, &b), "per mesh");
    // A frame swap (other UVs) is animation once recognised, content before.
    let mut st = state(vec![], IDENTITY);
    st.items.insert(
        2,
        entry(
            2,
            canvas_parent(),
            Commands {
                list: vec![Command::Mesh {
                    mesh: 7,
                    tex: Some(3),
                    transform: IDENTITY,
                    modulate: [1.0; 4],
                }],
                ..Commands::default()
            },
        ),
    );
    let pos = vec![[10.0, 10.0], [50.0, 10.0], [10.0, 50.0]];
    let uv = |u: f32| Some(vec![[u, 0.0], [u + 0.1, 0.0], [u, 0.1]]);
    let (f0, f1) = (
        geometry(pos.clone(), None, uv(0.0), None),
        geometry(pos, None, uv(0.5), None),
    );
    let mut m = TxMotion::default();
    geometry_change(&mut m, &P, &st, 7, Some(&f0), &f1, false, [2].into_iter());
    assert_eq!(m.changes, Change::RESHAPE);
    let mut m = TxMotion::default();
    geometry_change(&mut m, &P, &st, 7, Some(&f0), &f1, true, [2].into_iter());
    assert_eq!(m, TxMotion::default());
}

#[test]
fn a_body_part_off_screen_or_faint_moves_invisibly_and_one_that_pops_in_is_seen() {
    let mut st = state(vec![], IDENTITY);
    st.items.insert(
        2,
        entry(
            2,
            canvas_parent(),
            Commands {
                list: vec![Command::Mesh {
                    mesh: 7,
                    tex: Some(3),
                    transform: IDENTITY,
                    modulate: [1.0; 4],
                }],
                ..Commands::default()
            },
        ),
    );
    let tri = |x: f32, y: f32, a: f32| {
        geometry(
            vec![[x, y], [x + 20.0, y], [x, y + 20.0]],
            Some(vec![[1.0, 1.0, 1.0, a]; 3]),
            None,
            None,
        )
    };
    let run = |a: &crate::apply::payloads::MeshGeometry,
               b: &crate::apply::payloads::MeshGeometry| {
        let mut m = TxMotion::default();
        dynamic_mesh(&mut m, &P, &st, 7, Some(a), b, [2].into_iter());
        m
    };
    // Parked off screen, then snapped back on screen transparent (a loop restart): invisible.
    let m = run(&tri(100.0, 2000.0, 1.0), &tri(100.0, 100.0, 0.0));
    assert_eq!((m.anim_px, m.anim_color), (0.0, 0.0), "{m:?}");
    // Transparent on both sides, however far it went.
    let m = run(&tri(10.0, 10.0, 0.0), &tri(500.0, 700.0, 0.0));
    assert_eq!(m.anim_px, 0.0, "{m:?}");
    // Faded in where it was within one transaction: a colour step.
    let m = run(&tri(10.0, 10.0, 0.0), &tri(10.0, 10.0, 1.0));
    assert_eq!(m.anim_color, 1.0, "{m:?}");
    // Moved on screen from off it: no more than its own on-screen size.
    let m = run(&tri(100.0, 2000.0, 1.0), &tri(100.0, 100.0, 1.0));
    assert!((m.anim_px - 0.5 * 800f32.sqrt()).abs() < 1e-3, "{m:?}");
    // Visible on both sides: its full displacement.
    let m = run(&tri(100.0, 100.0, 1.0), &tri(100.0, 400.0, 1.0));
    assert_eq!(m.anim_px, 300.0, "{m:?}");
}

#[test]
fn an_item_s_own_colour_is_its_modulate_times_its_self_modulate() {
    let mut old = entry(2, canvas_parent(), rect([0.0, 0.0, 10.0, 10.0]));
    old.self_modulate = [1.0, 1.0, 1.0, 0.5];
    let mut new = old.clone();
    new.modulate[3] = 0.9;
    let st = state(vec![new.clone()], IDENTITY);
    // 0.1 of modulate alpha shows as 0.05 through a half-transparent self_modulate.
    assert!((measure(&st, &old, &new, false).color_step - 0.05).abs() < 1e-6);
    // With children the modulate reaches them as is.
    old.children = vec![9];
    new.children = vec![9];
    assert!((measure(&st, &old, &new, false).color_step - 0.1).abs() < 1e-6);
}

// ---- gate fix round 2

/// A body whose 2D positions, colours and UVs are equal but whose custom attributes (read by a
/// canvas_item vertex shader) or skin buffer changed is not comparable as motion.
#[test]
fn fix5_custom_attributes_and_skin_are_not_motion() {
    use crate::apply::payloads::{ARRAY_FORMAT_COLOR, ARRAY_FORMAT_CUSTOM0};
    let body = |custom: u8, skin: u8| {
        let mut g = geometry(
            vec![[0.0, 0.0], [10.0, 0.0], [0.0, 10.0]],
            Some(vec![[1.0; 4]; 3]),
            None,
            None,
        );
        g.layout.format = ARRAY_FORMAT_COLOR | ARRAY_FORMAT_CUSTOM0;
        // Per vertex: RGBA8, then CUSTOM0 as four bytes.
        g.buffers[1] = (0..3)
            .flat_map(|_| [255, 255, 255, 255, custom, 0, 0, 0])
            .collect();
        g.buffers[2] = vec![skin; 24];
        g.layout.buffer_bytes = [0, g.buffers[1].len(), g.buffers[2].len(), 0];
        g
    };
    let base = body(1, 0);
    assert!(!body_delta(&base, &body(1, 0)).reshaped);
    assert!(body_delta(&base, &body(2, 0)).reshaped, "CUSTOM0 changed");
    assert!(body_delta(&base, &body(1, 9)).reshaped, "skin changed");
    let mut st = state(vec![], IDENTITY);
    st.items.insert(
        2,
        entry(
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
        ),
    );
    let mut m = TxMotion::default();
    dynamic_mesh(
        &mut m,
        &P,
        &st,
        7,
        Some(&base),
        &body(2, 0),
        [2].into_iter(),
    );
    assert_eq!(m.changes, Change::RESHAPE);
}

/// A multimesh instance's colour step is what a pixel receives: premultiplied under a material
/// that scales by alpha.
#[test]
fn fix6_instance_colour_steps_are_premultiplied() {
    let st = particles_scene(1, None);
    let m = instances_motion(
        &st,
        &inst(1.0, 100.0, 100.0, [1.0, 1.0, 1.0, 0.1], [0.0; 4]),
        &inst(1.0, 100.0, 100.0, [0.0, 0.0, 0.0, 0.1], [0.0; 4]),
    );
    assert!((m.anim_color - 0.1).abs() < 1e-6, "{m:?}");
}

/// A custom AABB is the item's culling rect: alone it wakes; with the geometry it moves as
/// animation through the users.
#[test]
fn fix7_a_custom_aabb_change_wakes_alone_and_moves_with_its_geometry() {
    let old = static_mesh(7, 9);
    let mut aabb_only = old.clone();
    aabb_only.custom_aabb = [0.0, 0.0, 0.0, 10.0, 10.0, 0.0];
    let mut m = TxMotion::default();
    assert!(!mesh(&mut m, Some(&old), Some(&aabb_only)));
    assert_eq!(m.changes, Change::RESOURCE);
    let mut st = state(vec![], IDENTITY);
    let mut user = entry(
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
    user.xform = [2.0, 0.0, 0.0, 2.0, 0.0, 0.0];
    st.items.insert(2, user);
    let mut a = old.clone();
    a.custom_aabb = [0.0, 0.0, 0.0, 10.0, 10.0, 0.0];
    let mut b = static_mesh(7, 10);
    b.custom_aabb = [3.0, 0.0, 0.0, 10.0, 10.0, 0.0];
    // On screen on both sides: the item is drawn either way, nothing visible changes.
    let mut m = TxMotion::default();
    mesh_bounds(&mut m, &P, &st, &a, &b, [2].into_iter());
    assert_eq!((m.changes, m.anim_px), (0, 0.0));
    // The rect sizes a clipping item's copy: its edges moving count.
    st.items.get_mut(&2).unwrap().clip = true;
    let mut m = TxMotion::default();
    mesh_bounds(&mut m, &P, &st, &a, &b, [2].into_iter());
    assert_eq!((m.changes, m.anim_px), (0, 6.0));
    // Under a canvas group owner: the rect merges into what the group copies, so it counts too.
    st.items.get_mut(&2).unwrap().clip = false;
    let mut owner = entry(5, canvas_parent(), Commands::default());
    owner.canvas_group = Some(CanvasGroup {
        mode: CanvasGroupMode::ALL[0],
        clear_margin: 5.0,
        fit_empty: false,
        fit_margin: 0.0,
        blur_mipmaps: false,
    });
    owner.children = vec![2];
    st.items.insert(5, owner);
    st.items.get_mut(&2).unwrap().parent = Some(Parent {
        kind: ParentKind::Item,
        id: 5,
    });
    let mut m = TxMotion::default();
    mesh_bounds(&mut m, &P, &st, &a, &b, [2].into_iter());
    assert_eq!((m.changes, m.anim_px), (0, 6.0));
    st.items.get_mut(&5).unwrap().canvas_group = None;
    // Culled after (moved off screen): what it drew vanishes.
    let mut far = b.clone();
    far.custom_aabb = [1000.0, 0.0, 0.0, 10.0, 10.0, 0.0];
    let mut m = TxMotion::default();
    mesh_bounds(&mut m, &P, &st, &a, &far, [2].into_iter());
    assert_eq!((m.changes, m.anim_px), (0, 2000.0));
    // Set on one side only: unbounded without the geometry's own box.
    let mut m = TxMotion::default();
    mesh_bounds(&mut m, &P, &st, &old, &b, [2].into_iter());
    assert_eq!(m.changes, Change::RESOURCE);
}

/// A mesh id freed and created anew does not inherit the frames the old mesh showed.
#[test]
fn fix8_a_forgotten_mesh_recognises_no_frame() {
    let mut f = MeshFrames::default();
    let (a, b) = ([Hash([1; 32])], [Hash([2; 32])]);
    f.swap(7, &a, &b);
    assert!(f.swap(7, &b, &a));
    f.forget(7);
    assert!(!f.swap(7, &b, &a));
}
