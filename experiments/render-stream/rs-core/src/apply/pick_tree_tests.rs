//! `Applier::pick_tree`,
//! Godot 4.5.1's GUI pick order (`Viewport::gui_find_control`), over hand-built states. Each test
//! names the Godot rule it reproduces; the sabotages must each change an answer.

use super::overrides::{OverrideSabotage, PickOrder, HIT_IGNORE, HIT_INPUT, OVERRIDE_FLOATS};
use super::*;
use crate::state::*;

const CANVAS: Id = 1;
const OVER: Id = 2;
const UNDER: Id = 3;

fn at(x: f32, y: f32) -> Xform {
    [1.0, 0.0, 0.0, 1.0, x, y]
}

/// An item at `xform` under `parent`, drawing `draw` (a rect in its own space) if any, with a
/// custom rect (a Control's `Rect2(0, size)`) if `size` is set.
fn node(
    id: Id,
    parent: Parent,
    draw_index: i64,
    xform: Xform,
    draw: Option<[f32; 4]>,
    size: Option<[f32; 2]>,
) -> Item {
    Item {
        id,
        origin: Origin::Created,
        parent: Some(parent),
        children: Vec::new(),
        visible: true,
        draw_index,
        z_index: 0,
        z_relative: true,
        behind: false,
        clip: false,
        custom_rect: size.is_some(),
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
        xform,
        modulate: [1.0; 4],
        self_modulate: [1.0; 4],
        custom_rect_rect: size.map_or([0.0; 4], |[w, h]| [0.0, 0.0, w, h]),
        commands: Commands {
            list: draw
                .map(|r| {
                    vec![Command::Rect {
                        aa: false,
                        rect: r,
                        color: [0.5, 0.25, 1.0, 1.0],
                    }]
                })
                .unwrap_or_default(),
            ..Commands::default()
        },
    }
}

fn in_item(id: Id) -> Parent {
    Parent {
        kind: ParentKind::Item,
        id,
    }
}

fn in_canvas(id: Id) -> Parent {
    Parent {
        kind: ParentKind::Canvas,
        id,
    }
}

/// A Control: drawn over its whole rect when `drawn`, else drawing nothing.
fn control(
    id: Id,
    parent: Parent,
    draw_index: i64,
    xform: Xform,
    size: [f32; 2],
    drawn: bool,
) -> Item {
    let draw = drawn.then_some([0.0, 0.0, size[0], size[1]]);
    node(id, parent, draw_index, xform, draw, Some(size))
}

/// A state from items; every parent's `children` and every canvas's `items` are filled in the
/// order given. Canvases: `CANVAS` (layer 0) always, `OVER` (layer 1) and `UNDER` (layer -1) when
/// an item names them.
fn state(items: Vec<Item>) -> ResolvedState {
    let mut s = ResolvedState::empty(13);
    for (cid, layer) in [(CANVAS, 0), (OVER, 1), (UNDER, -1)] {
        let roots: Vec<Id> = items
            .iter()
            .filter(|it| it.parent == Some(in_canvas(cid)))
            .map(|it| it.id)
            .collect();
        if cid != CANVAS && roots.is_empty() {
            continue;
        }
        s.canvases.insert(
            cid,
            Canvas {
                id: cid,
                origin: Origin::RootQuery,
                root: cid == CANVAS,
                attached: true,
                layer,
                sublayer: 0,
                items: roots,
                xform: geom::IDENTITY,
                modulate: [1.0; 4],
            },
        );
    }
    let ids: Vec<(Id, Option<Parent>)> = items.iter().map(|it| (it.id, it.parent)).collect();
    for it in items {
        s.items.insert(it.id, it);
    }
    for (id, parent) in ids {
        if let Some(p) = parent.filter(|p| p.kind == ParentKind::Item) {
            s.items.get_mut(&p.id).unwrap().children.push(id);
        }
    }
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

fn applier() -> Applier {
    Applier::new(Viewport {
        width: 640,
        height: 360,
        clear: [0.0, 0.0, 0.0, 1.0],
        global_xform: geom::IDENTITY,
        cull_mask: 0xffff_ffff,
        format: Format::Rgb10A2,
    })
}

/// An applier that applied `s`, with `filters` stated and `order` chosen.
fn applied(s: &ResolvedState, filters: &[(Id, u8)], order: Option<PickOrder>) -> Applier {
    applied_with(s, filters, order, OverrideSabotage::default())
}

fn applied_with(
    s: &ResolvedState,
    filters: &[(Id, u8)],
    order: Option<PickOrder>,
    sabotage: OverrideSabotage,
) -> Applier {
    let mut b = applier();
    b.ov_sabotage = sabotage;
    let (ids, fs): (Vec<u32>, Vec<u8>) = filters.iter().copied().unzip();
    b.set_hit_filters(&ids, &fs).unwrap();
    if let Some(o) = order {
        b.set_pick_order(o);
    }
    b.apply(s, &full_delta(s), &PayloadStore::default());
    b
}

const STOP: u8 = HIT_INPUT;
const IGN: u8 = HIT_IGNORE;

// ---------------------------------------------------------------- the STS2 hand card (`Hitbox`)

/// STS2's hand card: `Card` (an IGNORE Control) holds drawn items with no node (no filter: the
/// card's art, made straight through the RenderingServer) and, last, `Hitbox`, a STOP Control
/// that draws nothing. Behind it all a full-screen PASS `Back`.
const BACK: Id = 10;
const CARD: Id = 11;
const ART: Id = 12;
const GLOW: Id = 13;
const HITBOX: Id = 14;

fn hand_card() -> (ResolvedState, Vec<(Id, u8)>) {
    let s = state(vec![
        control(
            BACK,
            in_canvas(CANVAS),
            0,
            geom::IDENTITY,
            [640.0, 360.0],
            true,
        ),
        control(
            CARD,
            in_canvas(CANVAS),
            1,
            at(100.0, 100.0),
            [120.0, 160.0],
            false,
        ),
        node(
            ART,
            in_item(CARD),
            0,
            geom::IDENTITY,
            Some([0.0, 0.0, 120.0, 160.0]),
            None,
        ),
        node(
            GLOW,
            in_item(CARD),
            0,
            geom::IDENTITY,
            Some([-10.0, -10.0, 140.0, 180.0]),
            None,
        ),
        control(
            HITBOX,
            in_item(CARD),
            0,
            at(10.0, 10.0),
            [100.0, 140.0],
            false,
        ),
    ]);
    // Couch's statements: role widgets STOP, every other node IGNORE, items with no node unstated.
    let filters = vec![(BACK, STOP), (CARD, IGN), (HITBOX, STOP)];
    (s, filters)
}

#[test]
fn an_undrawn_hitbox_over_drawn_nodeless_items_is_found() {
    // Godot: Hitbox (the card's last child, STOP, rect 110..210 x 110..250) answers first; the
    // no-node items are no Controls; Card is IGNORE; outside the Hitbox, Back.
    let (s, f) = hand_card();
    let tree = applied(&s, &f, Some(PickOrder::Tree));
    assert_eq!(tree.pick(&s, 150.0, 180.0), Some(HITBOX));
    assert_eq!(
        tree.pick(&s, 105.0, 105.0),
        Some(BACK),
        "on the art, outside the hitbox"
    );
    assert_eq!(tree.pick(&s, 400.0, 300.0), Some(BACK));
    // HIT1's draw order answers the drawn art (no filter: "counts as drawn").
    let drawn = applied(&s, &f, None);
    assert_eq!(drawn.pick(&s, 150.0, 180.0), Some(GLOW));
    // `pick-no-rect`: the drawn content rect only; Hitbox draws nothing, so it is never found.
    let no_rect = applied_with(
        &s,
        &f,
        Some(PickOrder::Tree),
        OverrideSabotage {
            pick_no_rect: true,
            ..Default::default()
        },
    );
    assert_eq!(
        no_rect.pick(&s, 150.0, 180.0),
        Some(BACK),
        "pick-no-rect not caught"
    );
}

// ------------------------------------------------------------------ z_index and show_behind_parent

const ZHIGH: Id = 20;
const ZLOW: Id = 21;
const BPARENT: Id = 22;
const BCHILD: Id = 23;

fn z_and_behind() -> (ResolvedState, Vec<(Id, u8)>) {
    let mut zhigh = control(
        ZHIGH,
        in_canvas(CANVAS),
        0,
        at(0.0, 0.0),
        [80.0, 80.0],
        true,
    );
    zhigh.z_index = 5;
    let zlow = control(
        ZLOW,
        in_canvas(CANVAS),
        1,
        at(40.0, 0.0),
        [80.0, 80.0],
        true,
    );
    let bparent = control(
        BPARENT,
        in_canvas(CANVAS),
        2,
        at(200.0, 0.0),
        [100.0, 80.0],
        true,
    );
    let mut bchild = control(
        BCHILD,
        in_item(BPARENT),
        0,
        at(20.0, 20.0),
        [60.0, 40.0],
        true,
    );
    bchild.behind = true;
    let s = state(vec![zhigh, zlow, bparent, bchild]);
    let f = vec![(ZHIGH, STOP), (ZLOW, STOP), (BPARENT, STOP), (BCHILD, STOP)];
    (s, f)
}

#[test]
fn z_index_and_show_behind_parent_do_not_change_the_pick() {
    // Godot ignores z_index (the later sibling ZLow answers where they overlap, though ZHigh is
    // drawn over it) and show_behind_parent (children before their parent: BChild, though drawn
    // under BParent).
    let (s, f) = z_and_behind();
    let tree = applied(&s, &f, Some(PickOrder::Tree));
    assert_eq!(tree.pick(&s, 60.0, 40.0), Some(ZLOW));
    assert_eq!(tree.pick(&s, 20.0, 40.0), Some(ZHIGH));
    assert_eq!(tree.pick(&s, 250.0, 40.0), Some(BCHILD));
    assert_eq!(tree.pick(&s, 205.0, 5.0), Some(BPARENT));
    let drawn = applied(&s, &f, None);
    assert_eq!(drawn.pick(&s, 60.0, 40.0), Some(ZHIGH));
    assert_eq!(drawn.pick(&s, 250.0, 40.0), Some(BPARENT));
    // `pick-draw-order`: HIT1's reading under "tree".
    let sab = applied_with(
        &s,
        &f,
        Some(PickOrder::Tree),
        OverrideSabotage {
            pick_draw_order: true,
            ..Default::default()
        },
    );
    assert_eq!(
        sab.pick(&s, 60.0, 40.0),
        Some(ZHIGH),
        "pick-draw-order not caught (z)"
    );
    assert_eq!(
        sab.pick(&s, 250.0, 40.0),
        Some(BPARENT),
        "pick-draw-order not caught (behind)"
    );
}

#[test]
fn draw_index_ties_put_the_later_sibling_first() {
    // A tie keeps the state's (append) order, the later item on top: the walk draws it last, and
    // the pick tries it first.
    let a = control(30, in_canvas(CANVAS), 4, geom::IDENTITY, [50.0, 50.0], true);
    let b = control(31, in_canvas(CANVAS), 4, geom::IDENTITY, [50.0, 50.0], true);
    let s = state(vec![a, b]);
    let f = [(30, STOP), (31, STOP)];
    assert_eq!(
        applied(&s, &f, Some(PickOrder::Tree)).pick(&s, 10.0, 10.0),
        Some(31)
    );
    assert_eq!(applied(&s, &f, None).pick(&s, 10.0, 10.0), Some(31));
}

// --------------------------------------------------------------------- IGNORE overlays and decor

#[test]
fn ignore_overlays_and_decoration_are_passed_through() {
    // A full-screen IGNORE overlay (drawn last, a transparent shader rect) and a Node2D decor
    // item with no filter (drawn over the button) are never the answer; the button is.
    const BUTTON: Id = 40;
    const DECOR: Id = 41;
    const VEIL: Id = 42;
    let s = state(vec![
        control(
            BUTTON,
            in_canvas(CANVAS),
            0,
            at(100.0, 100.0),
            [80.0, 30.0],
            true,
        ),
        node(
            DECOR,
            in_canvas(CANVAS),
            1,
            at(90.0, 90.0),
            Some([0.0, 0.0, 60.0, 60.0]),
            None,
        ),
        control(
            VEIL,
            in_canvas(CANVAS),
            2,
            geom::IDENTITY,
            [640.0, 360.0],
            true,
        ),
    ]);
    let f = [(BUTTON, STOP), (VEIL, IGN)];
    let tree = applied(&s, &f, Some(PickOrder::Tree));
    assert_eq!(tree.pick(&s, 120.0, 110.0), Some(BUTTON));
    assert_eq!(
        tree.pick(&s, 95.0, 95.0),
        None,
        "decor and veil only: nothing takes input"
    );
    // HIT1 answers the unstated decor (counts as drawn).
    assert_eq!(applied(&s, &f, None).pick(&s, 120.0, 110.0), Some(DECOR));
}

// ---------------------------------------------------------------------------------- clip_contents

#[test]
fn a_clipping_control_prunes_its_children_outside_its_rect() {
    const CLIP: Id = 50;
    const KID: Id = 51;
    const BEHIND: Id = 52;
    let mut clip = control(
        CLIP,
        in_canvas(CANVAS),
        1,
        at(100.0, 100.0),
        [80.0, 80.0],
        true,
    );
    clip.clip = true;
    let s = state(vec![
        control(
            BEHIND,
            in_canvas(CANVAS),
            0,
            at(100.0, 100.0),
            [200.0, 80.0],
            true,
        ),
        clip,
        control(KID, in_item(CLIP), 0, at(60.0, 0.0), [80.0, 40.0], true),
    ]);
    let f = [(CLIP, IGN), (KID, STOP), (BEHIND, STOP)];
    let tree = applied(&s, &f, Some(PickOrder::Tree));
    assert_eq!(tree.pick(&s, 170.0, 110.0), Some(KID), "inside the clip");
    assert_eq!(
        tree.pick(&s, 220.0, 110.0),
        Some(BEHIND),
        "outside the clip"
    );
    // An IGNORE clipping Control still clips (Godot tests `has_point` before any filter).
    let sab = applied_with(
        &s,
        &f,
        Some(PickOrder::Tree),
        OverrideSabotage {
            pick_no_clip: true,
            ..Default::default()
        },
    );
    assert_eq!(
        sab.pick(&s, 220.0, 110.0),
        Some(KID),
        "pick-no-clip not caught"
    );
}

// ------------------------------------------------------------------- canvas layers and top level

#[test]
fn canvas_layers_order_the_roots_top_first() {
    // CanvasLayer 1 is tried before the viewport's canvas, CanvasLayer -1 after it.
    let s = state(vec![
        control(
            60,
            in_canvas(CANVAS),
            0,
            at(100.0, 0.0),
            [100.0, 100.0],
            true,
        ),
        control(61, in_canvas(OVER), 0, at(150.0, 0.0), [100.0, 100.0], true),
        control(62, in_canvas(UNDER), 0, at(50.0, 0.0), [250.0, 100.0], true),
    ]);
    let f = [(60, STOP), (61, STOP), (62, STOP)];
    let tree = applied(&s, &f, Some(PickOrder::Tree));
    assert_eq!(tree.pick(&s, 170.0, 50.0), Some(61));
    assert_eq!(tree.pick(&s, 120.0, 50.0), Some(60));
    assert_eq!(tree.pick(&s, 60.0, 50.0), Some(62));
    assert_eq!(tree.pick(&s, 280.0, 50.0), Some(62));
    assert_eq!(tree.pick(&s, 320.0, 50.0), None);
}

#[test]
fn a_top_level_control_is_a_canvas_root_raised_after_its_parent() {
    // A `top_level` Control's RS parent is the canvas and its draw index is raised after the
    // root it sits in, so it is tried before that root's whole subtree, as Godot tries it (a
    // GUI root later in tree order than the root holding it).
    const ROOT: Id = 70;
    const LATE: Id = 71;
    const TOP: Id = 72;
    let s = state(vec![
        control(
            ROOT,
            in_canvas(CANVAS),
            0,
            geom::IDENTITY,
            [640.0, 360.0],
            false,
        ),
        control(
            LATE,
            in_item(ROOT),
            5,
            at(100.0, 100.0),
            [100.0, 100.0],
            true,
        ),
        control(
            TOP,
            in_canvas(CANVAS),
            1,
            at(150.0, 150.0),
            [100.0, 100.0],
            true,
        ),
    ]);
    let f = [(ROOT, IGN), (LATE, STOP), (TOP, STOP)];
    assert_eq!(
        applied(&s, &f, Some(PickOrder::Tree)).pick(&s, 170.0, 170.0),
        Some(TOP)
    );
}

// -------------------------------------------------------------- visibility, transforms, modulate

#[test]
fn hidden_and_singular_items_prune_their_subtrees() {
    const UNDER_IT: Id = 80;
    const HIDDEN: Id = 81;
    const HKID: Id = 82;
    const FLAT: Id = 83;
    const FKID: Id = 84;
    let mut hidden = control(
        HIDDEN,
        in_canvas(CANVAS),
        1,
        at(0.0, 0.0),
        [100.0, 100.0],
        true,
    );
    hidden.visible = false;
    let flat = control(
        FLAT,
        in_canvas(CANVAS),
        2,
        [1.0, 0.0, 0.0, 0.0, 200.0, 0.0],
        [100.0, 100.0],
        true,
    );
    let s = state(vec![
        control(
            UNDER_IT,
            in_canvas(CANVAS),
            0,
            geom::IDENTITY,
            [400.0, 100.0],
            true,
        ),
        hidden,
        control(
            HKID,
            in_item(HIDDEN),
            0,
            geom::IDENTITY,
            [100.0, 100.0],
            true,
        ),
        flat,
        control(FKID, in_item(FLAT), 0, geom::IDENTITY, [100.0, 100.0], true),
    ]);
    let f = [
        (UNDER_IT, STOP),
        (HIDDEN, STOP),
        (HKID, STOP),
        (FLAT, STOP),
        (FKID, STOP),
    ];
    let tree = applied(&s, &f, Some(PickOrder::Tree));
    assert_eq!(
        tree.pick(&s, 50.0, 50.0),
        Some(UNDER_IT),
        "hidden prunes its visible child"
    );
    assert_eq!(
        tree.pick(&s, 250.0, 0.0),
        Some(UNDER_IT),
        "a singular transform prunes"
    );
}

#[test]
fn a_rotated_control_is_tested_in_its_own_space() {
    // 45 degrees about its origin at (200, 100): the AABB's corner (200 - 60, 110) is outside.
    let c = std::f32::consts::FRAC_1_SQRT_2;
    let rot = control(
        90,
        in_canvas(CANVAS),
        1,
        [c, c, -c, c, 200.0, 100.0],
        [80.0, 80.0],
        true,
    );
    let s = state(vec![
        control(
            91,
            in_canvas(CANVAS),
            0,
            geom::IDENTITY,
            [640.0, 360.0],
            false,
        ),
        rot,
    ]);
    let f = [(90, STOP), (91, STOP)];
    let tree = applied(&s, &f, Some(PickOrder::Tree));
    assert_eq!(tree.pick(&s, 200.0, 150.0), Some(90));
    assert_eq!(tree.pick(&s, 145.0, 110.0), Some(91));
}

#[test]
fn a_transparent_control_is_still_picked() {
    // Godot's picking ignores modulate: a Control at alpha 0 (which the walk culls) answers.
    let mut ghost = control(
        100,
        in_canvas(CANVAS),
        1,
        at(10.0, 10.0),
        [50.0, 50.0],
        true,
    );
    ghost.modulate = [1.0, 1.0, 1.0, 0.0];
    let s = state(vec![
        control(
            101,
            in_canvas(CANVAS),
            0,
            geom::IDENTITY,
            [100.0, 100.0],
            true,
        ),
        ghost,
    ]);
    let f = [(100, STOP), (101, STOP)];
    assert_eq!(
        applied(&s, &f, Some(PickOrder::Tree)).pick(&s, 30.0, 30.0),
        Some(100)
    );
    assert_eq!(applied(&s, &f, None).pick(&s, 30.0, 30.0), Some(101));
}

#[test]
fn overrides_move_and_hide_the_tree_pick_as_drawn() {
    // TAG2: an override moves Card by (200, 0): the Hitbox is found where it is drawn, and the
    // inverse maps the point back to the game's spot. A hidden override prunes the subtree.
    let (s, f) = hand_card();
    let mut b = applied(&s, &f, Some(PickOrder::Tree));
    let mut vals = Vec::with_capacity(OVERRIDE_FLOATS);
    vals.extend_from_slice(&[1.0, 0.0, 0.0, 1.0, 200.0, 0.0]);
    vals.extend_from_slice(&[1.0; 4]);
    vals.extend_from_slice(&[1.0, 0.0]);
    b.set_overrides(&[CARD], &vals).unwrap();
    b.refresh_overrides(&s, &PayloadStore::default());
    assert_eq!(b.pick(&s, 350.0, 180.0), Some(HITBOX));
    assert_eq!(b.pick(&s, 150.0, 180.0), Some(BACK));
    assert_eq!(
        b.to_game(&s, 350.0, 180.0),
        Some((Some(HITBOX), [150.0, 180.0]))
    );
    vals[10] = 0.0;
    b.set_overrides(&[CARD], &vals).unwrap();
    b.refresh_overrides(&s, &PayloadStore::default());
    assert_eq!(b.pick(&s, 350.0, 180.0), Some(BACK));
}

// ------------------------------------------------------------------- ID-D8: no flip by default

#[test]
fn the_default_order_is_hit1s_reading_everywhere() {
    // Without `set_pick_order` every point answers what `Drawn` does, which is HIT1's code; and
    // `Tree` with no filters is the bare hit test (no item is known to take input).
    let (s, f) = z_and_behind();
    let default = applied(&s, &f, None);
    let drawn = applied(&s, &f, Some(PickOrder::Drawn));
    let tree = applied(&s, &f, Some(PickOrder::Tree));
    let mut differs = 0;
    for gy in 0..16 {
        for gx in 0..24 {
            let (x, y) = (gx as f32 * 13.0 + 6.5, gy as f32 * 6.0 + 3.0);
            assert_eq!(default.pick(&s, x, y), drawn.pick(&s, x, y), "({x}, {y})");
            differs += usize::from(default.pick(&s, x, y) != tree.pick(&s, x, y));
        }
    }
    assert!(
        differs > 0,
        "the grid must reach a point where the orders differ"
    );
    let bare = applied(&s, &[], Some(PickOrder::Tree));
    assert_eq!(bare.pick(&s, 60.0, 40.0), bare.hit_test(60.0, 40.0));
    assert_eq!(bare.pick(&s, 60.0, 40.0), Some(ZHIGH));
    assert_eq!(default.pick_order(), PickOrder::Drawn);
}

#[test]
fn the_order_survives_a_coding_resync() {
    let (s, f) = z_and_behind();
    let mut old = applied(&s, &f, Some(PickOrder::Tree));
    let mut fresh = applier();
    fresh.inherit_overrides(&mut old);
    fresh.apply(&s, &full_delta(&s), &PayloadStore::default());
    assert_eq!(fresh.pick_order(), PickOrder::Tree);
    assert_eq!(fresh.pick(&s, 60.0, 40.0), Some(ZLOW));
    assert!(PickOrder::from_code(2).is_err());
    assert_eq!(PickOrder::from_code(1), Ok(PickOrder::Tree));
}
