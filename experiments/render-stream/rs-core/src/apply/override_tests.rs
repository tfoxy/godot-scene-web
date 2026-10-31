//! TAG2 (client-extensions-design.md §3.2, §6): the override table in the applier. The oracle is
//! the game making the same change: a base state plus an override paints exactly what the
//! variant state paints (`paint_digest`), through the walk, the rows-only path and the redraw
//! path; each sabotage must be caught.

use super::overrides::{OverrideSabotage, Refresh, OVERRIDE_FLOATS};
use super::*;
use crate::state::*;

const CANVAS: Id = 1;
/// G (top) > P (overridden) > C1, C2; Q a sibling of G.
const G: Id = 10;
const P: Id = 11;
const C1: Id = 12;
const C2: Id = 13;
const Q: Id = 14;

fn item(id: Id, parent: Parent, children: Vec<Id>, rect: Option<[f32; 4]>) -> Item {
    Item {
        id,
        origin: Origin::Created,
        parent: Some(parent),
        children,
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
        commands: Commands {
            list: rect
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

/// The base scene: G at (10, 200), P at (5, 0) under it, its children drawing, Q beside G.
fn base() -> ResolvedState {
    let mut s = ResolvedState::empty(13);
    let canvas_parent = Parent {
        kind: ParentKind::Canvas,
        id: CANVAS,
    };
    let mut g = item(G, canvas_parent, vec![P], Some([0.0, 0.0, 4.0, 4.0]));
    g.xform = [1.0, 0.0, 0.0, 1.0, 10.0, 200.0];
    let mut p = item(P, in_item(G), vec![C1, C2], None);
    p.xform = [1.0, 0.0, 0.0, 1.0, 5.0, 0.0];
    let mut c1 = item(C1, in_item(P), vec![], Some([0.0, 0.0, 30.0, 20.0]));
    c1.xform = [1.0, 0.0, 0.0, 1.0, 2.0, 3.0];
    let c2 = item(C2, in_item(P), vec![], Some([10.0, 25.0, 20.0, 10.0]));
    let q = item(Q, canvas_parent, vec![], Some([300.0, 10.0, 20.0, 20.0]));
    for it in [g, p, c1, c2, q] {
        s.items.insert(it.id, it);
    }
    s.canvases.insert(
        CANVAS,
        Canvas {
            id: CANVAS,
            origin: Origin::RootQuery,
            root: true,
            attached: true,
            layer: 0,
            sublayer: 0,
            items: vec![G, Q],
            xform: geom::IDENTITY,
            modulate: [1.0; 4],
        },
    );
    s
}

fn full_delta(s: &ResolvedState) -> TxDelta {
    TxDelta {
        full: true,
        canvases_upserted: vec![CANVAS],
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

/// A packed table of one override (frozen false).
fn table(id: Id, xf: Xform, modulate: [f32; 4], visible: bool) -> (Vec<u32>, Vec<f32>) {
    let mut v = Vec::with_capacity(OVERRIDE_FLOATS);
    v.extend_from_slice(&xf);
    v.extend_from_slice(&modulate);
    v.push(if visible { 1.0 } else { 0.0 });
    v.push(0.0); // frozen
    (vec![id], v)
}

const LIFT: Xform = [1.0, 0.0, 0.0, 1.0, 0.0, -119.0];
const TINT: [f32; 4] = [1.0, 0.5, 0.5, 0.75];

/// The variants the game makes (P's own properties) and the override that matches each.
#[derive(Clone, Copy, Debug)]
enum Variant {
    Moved,
    Scaled,
    Hidden,
    Tinted,
}

fn scale_about(sx: f32, sy: f32, px: f32, py: f32) -> Xform {
    [sx, 0.0, 0.0, sy, px - sx * px, py - sy * py]
}

fn game(v: Variant, s: &mut ResolvedState) {
    let p = s.items.get_mut(&P).unwrap();
    match v {
        // P's parent G is a translation, so a presentation-space translation is P's own.
        Variant::Moved => p.xform[5] += -119.0,
        // About P's global (15, 200): P's local (0, 0). Godot's pivot form: scale about the
        // local pivot, as `Control` composes it.
        Variant::Scaled => p.xform = geom::mul(&p.xform, &scale_about(1.25, 1.25, 0.0, 0.0)),
        Variant::Hidden => p.visible = false,
        Variant::Tinted => p.modulate = TINT,
    }
}

fn ov(v: Variant) -> (Vec<u32>, Vec<f32>) {
    match v {
        Variant::Moved => table(P, LIFT, [1.0; 4], true),
        Variant::Scaled => table(P, scale_about(1.25, 1.25, 15.0, 200.0), [1.0; 4], true),
        Variant::Hidden => table(P, geom::IDENTITY, [1.0; 4], false),
        Variant::Tinted => table(P, geom::IDENTITY, TINT, true),
    }
}

const VARIANTS: [Variant; 4] = [
    Variant::Moved,
    Variant::Scaled,
    Variant::Hidden,
    Variant::Tinted,
];

fn variant_digest(v: Variant) -> Hash {
    let store = PayloadStore::default();
    let mut s = base();
    game(v, &mut s);
    let mut a = applier();
    a.apply(&s, &full_delta(&s), &store);
    a.paint_digest()
}

#[test]
fn override_oracle_through_the_walk() {
    let store = PayloadStore::default();
    for v in VARIANTS {
        let s = base();
        let mut b = applier();
        let (ids, vals) = ov(v);
        b.set_overrides(&ids, &vals).unwrap();
        b.apply(&s, &full_delta(&s), &store);
        assert_eq!(b.paint_digest(), variant_digest(v), "{v:?}");
    }
}

#[test]
fn override_oracle_through_the_redraw_path() {
    let store = PayloadStore::default();
    for v in VARIANTS {
        let s = base();
        let mut b = applier();
        b.apply(&s, &full_delta(&s), &store);
        b.list.consumed();
        let before = b.paint_digest();
        let (ids, vals) = ov(v);
        b.set_overrides(&ids, &vals).unwrap();
        let r = b.refresh_overrides(&s, &store);
        let want = if matches!(v, Variant::Hidden) {
            Refresh::Walked
        } else {
            Refresh::Moved
        };
        assert_eq!(r, want, "{v:?}");
        assert_eq!(b.paint_digest(), variant_digest(v), "{v:?}");
        // Damage: the rewritten rows are dirty for the executor.
        if !matches!(v, Variant::Hidden) {
            assert!(!b.list.dirty.items.is_empty(), "{v:?}: no damage");
        }
        b.list.consumed();
        // Clearing the override draws the base again.
        b.set_overrides(&[], &[]).unwrap();
        assert_ne!(b.refresh_overrides(&s, &store), Refresh::Clean);
        assert_eq!(b.paint_digest(), before, "{v:?} cleared");
        assert_eq!(b.refresh_overrides(&s, &store), Refresh::Clean);
    }
}

#[test]
fn identity_overrides_paint_nothing_new() {
    let store = PayloadStore::default();
    let s = base();
    let mut a = applier();
    a.apply(&s, &full_delta(&s), &store);
    let mut b = applier();
    let ids: Vec<u32> = s.items.keys().copied().collect();
    let mut vals = Vec::new();
    for _ in &ids {
        vals.extend_from_slice(&geom::IDENTITY);
        vals.extend_from_slice(&[1.0; 4]);
        vals.push(1.0);
        vals.push(0.0); // frozen
    }
    b.set_overrides(&ids, &vals).unwrap();
    b.apply(&s, &full_delta(&s), &store);
    assert_eq!(a.paint_digest(), b.paint_digest());
}

/// A transform-only transaction (G moves) under an override on P: the rows-only path composes
/// the table. `override-fast-path-miss` must be caught.
fn transform_only(sabotage: OverrideSabotage) -> (Hash, Hash, u32) {
    let store = PayloadStore::default();
    let mut s = base();
    let mut b = applier();
    b.ov_sabotage = sabotage;
    let (ids, vals) = ov(Variant::Moved);
    b.set_overrides(&ids, &vals).unwrap();
    b.apply(&s, &full_delta(&s), &store);
    s.items.get_mut(&G).unwrap().xform[4] += 10.0;
    let delta = TxDelta {
        seq: 2,
        items_upserted: vec![G],
        ..TxDelta::default()
    };
    let why = b.apply(&s, &delta, &store).why;
    let mut v = base();
    game(Variant::Moved, &mut v);
    v.items.get_mut(&G).unwrap().xform[4] += 10.0;
    let mut a = applier();
    a.apply(&v, &full_delta(&v), &store);
    (a.paint_digest(), b.paint_digest(), why)
}

#[test]
fn override_follows_a_transform_only_frame() {
    let (want, got, why) = transform_only(OverrideSabotage::default());
    assert_eq!(why, 0, "the move took the rows-only path");
    assert_eq!(want, got);
    let (want, got, _) = transform_only(OverrideSabotage {
        fast_path_miss: true,
        ..Default::default()
    });
    assert_ne!(want, got, "override-fast-path-miss not caught");
}

#[test]
fn sabotage_no_inherit_is_caught_on_children() {
    let store = PayloadStore::default();
    let s = base();
    let mut b = applier();
    b.ov_sabotage.no_inherit = true;
    let (ids, vals) = ov(Variant::Moved);
    b.set_overrides(&ids, &vals).unwrap();
    b.apply(&s, &full_delta(&s), &store);
    assert_ne!(b.paint_digest(), variant_digest(Variant::Moved));
}

#[test]
fn sabotage_no_damage_is_caught_on_the_redraw_path() {
    let store = PayloadStore::default();
    let s = base();
    let mut b = applier();
    b.ov_sabotage.no_damage = true;
    b.apply(&s, &full_delta(&s), &store);
    b.list.consumed();
    let (ids, vals) = ov(Variant::Moved);
    b.set_overrides(&ids, &vals).unwrap();
    assert_eq!(b.refresh_overrides(&s, &store), Refresh::Moved);
    assert!(b.list.dirty.items.is_empty(), "override-no-damage marked damage");
}

#[test]
fn a_changed_table_waits_for_a_prepared_transaction() {
    let store = PayloadStore::default();
    let s = base();
    let mut b = applier();
    b.apply(&s, &full_delta(&s), &store);
    let delta = TxDelta {
        seq: 2,
        ..TxDelta::default()
    };
    b.prepare(&s, &delta);
    let (ids, vals) = ov(Variant::Tinted);
    b.set_overrides(&ids, &vals).unwrap();
    assert_eq!(b.refresh_overrides(&s, &store), Refresh::Deferred);
    b.apply(&s, &delta, &store);
    assert_eq!(b.paint_digest(), variant_digest(Variant::Tinted));
    assert_eq!(b.refresh_overrides(&s, &store), Refresh::Clean);
}

#[test]
fn removed_items_leave_the_table_and_reach_the_log() {
    let store = PayloadStore::default();
    let mut s = base();
    let mut b = applier();
    b.log_removed(true);
    let (ids, vals) = ov(Variant::Moved);
    b.set_overrides(&ids, &vals).unwrap();
    b.apply(&s, &full_delta(&s), &store);
    s.items.remove(&C2);
    s.items.remove(&P);
    s.items.remove(&C1);
    s.items.get_mut(&G).unwrap().children.clear();
    let delta = TxDelta {
        seq: 2,
        items_upserted: vec![G],
        items_removed: vec![P, C1, C2],
        ..TxDelta::default()
    };
    b.apply(&s, &delta, &store);
    assert_eq!(b.take_removed(), vec![P, C1, C2]);
    assert!(b.take_removed().is_empty());
    assert_eq!(b.overrides().count(), 0);
}

#[test]
fn queries_read_the_game_state() {
    let store = PayloadStore::default();
    let s = base();
    let mut b = applier();
    let (ids, vals) = ov(Variant::Moved);
    b.set_overrides(&ids, &vals).unwrap();
    b.apply(&s, &full_delta(&s), &store);
    let f = b.query_item(&s, C1).unwrap();
    assert_eq!(f.parent, Some(P));
    assert!(f.visible);
    // G (10, 200) · P (5, 0) · C1 (2, 3): the game's, not the lifted one.
    assert_eq!(f.xform, Some([1.0, 0.0, 0.0, 1.0, 17.0, 203.0]));
    assert_eq!(f.rect, Some([17.0, 203.0, 30.0, 20.0]));
    assert_eq!(b.query_item(&s, P).unwrap().rect, None);
    assert_eq!(b.query_children(&s, P), vec![C1, C2]);
    assert_eq!(
        b.query_subtree_rect(&s, P),
        Some([17.0, 203.0, 30.0, 32.0])
    );
    assert!(b.query_item(&s, 99).is_none());
}

// ------------------------------------------------------------------------- INP1: pointer mapping

fn near(a: [f32; 2], b: [f32; 2]) -> bool {
    (a[0] - b[0]).abs() < 1e-3 && (a[1] - b[1]).abs() < 1e-3
}

fn applied(
    set: Option<(Vec<u32>, Vec<f32>)>,
    sabotage: OverrideSabotage,
) -> (ResolvedState, Applier) {
    let store = PayloadStore::default();
    let s = base();
    let mut b = applier();
    b.ov_sabotage = sabotage;
    if let Some((ids, vals)) = set {
        b.set_overrides(&ids, &vals).unwrap();
    }
    b.apply(&s, &full_delta(&s), &store);
    (s, b)
}

#[test]
fn a_tap_on_a_raised_item_reaches_its_game_position() {
    // C1 is game-rect (17, 203, 30, 20): centre (32, 213). P's lift draws it 119 px higher.
    let (s, b) = applied(Some(ov(Variant::Moved)), OverrideSabotage::default());
    assert_eq!(b.hit_test(32.0, 94.0), Some(C1), "C1 is drawn raised");
    let (item, p) = b.to_game(&s, 32.0, 94.0).unwrap();
    assert_eq!(item, Some(C1));
    assert!(near(p, [32.0, 213.0]), "{p:?}");
    // Where it was before the lift nothing is drawn any more.
    assert_eq!(b.hit_test(32.0, 213.0), None);
    assert_eq!(b.to_game(&s, 32.0, 213.0), Some((None, [32.0, 213.0])));
}

#[test]
fn a_non_overridden_item_maps_to_itself() {
    let (s, b) = applied(Some(ov(Variant::Moved)), OverrideSabotage::default());
    let (item, p) = b.to_game(&s, 310.0, 20.0).unwrap();
    assert_eq!(item, Some(Q));
    assert_eq!(p, [310.0, 20.0]);
    // With no table at all, too.
    let (s, b) = applied(None, OverrideSabotage::default());
    assert_eq!(b.to_game(&s, 32.0, 213.0), Some((Some(C1), [32.0, 213.0])));
}

#[test]
fn a_scaled_override_inverts_about_its_pivot() {
    // P scaled 1.24 about its origin (G (10,200) · P (5,0) = (15, 200)): C1's game centre (32, 213)
    // is drawn at 15 + 1.24·17, 200 + 1.24·13.
    let xf = scale_about(1.24, 1.24, 15.0, 200.0);
    let (ids, vals) = table(P, xf, [1.0; 4], true);
    let (s, b) = applied(Some((ids, vals)), OverrideSabotage::default());
    let drawn = [15.0 + 1.24 * 17.0, 200.0 + 1.24 * 13.0];
    let (item, p) = b.to_game(&s, drawn[0], drawn[1]).unwrap();
    assert_eq!(item, Some(C1));
    assert!(near(p, [32.0, 213.0]), "{p:?}");
    // The drawn rect grew: x = 54 is right of C1's unscaled edge (47) and inside its scaled one.
    assert_eq!(b.hit_test(54.0, drawn[1]), Some(C1));
}

#[test]
fn the_nearest_override_composes_with_its_ancestors() {
    // P lifted, C1 itself nudged: E = O_C1 · O_P, so (0, -119) then (+5, 0) in presentation space.
    let ids = vec![P, C1];
    let mut vals = table(P, LIFT, [1.0; 4], true).1;
    vals.extend(table(C1, [1.0, 0.0, 0.0, 1.0, 5.0, 0.0], [1.0; 4], true).1);
    let (s, b) = applied(Some((ids, vals)), OverrideSabotage::default());
    let (item, p) = b.to_game(&s, 37.0, 94.0).unwrap();
    assert_eq!(item, Some(C1));
    assert!(near(p, [32.0, 213.0]), "{p:?}");
}

#[test]
fn the_topmost_item_in_draw_order_wins() {
    let store = PayloadStore::default();
    let mut s = base();
    // Q (drawn after G) now covers G's top-left corner.
    s.items.get_mut(&Q).unwrap().commands = Commands {
        list: vec![Command::Rect {
            aa: false,
            rect: [5.0, 195.0, 20.0, 20.0],
            color: [1.0; 4],
        }],
        ..Commands::default()
    };
    let mut b = applier();
    b.apply(&s, &full_delta(&s), &store);
    assert_eq!(b.hit_test(12.0, 202.0), Some(Q));
    assert_eq!(b.hit_test(7.0, 197.0), Some(Q));
    // G alone owns nothing Q does not cover here; outside both is bare clear colour.
    assert_eq!(b.hit_test(100.0, 100.0), None);
}

#[test]
fn a_hit_follows_a_transform_only_frame() {
    let store = PayloadStore::default();
    let mut s = base();
    let mut b = applier();
    let (ids, vals) = ov(Variant::Moved);
    b.set_overrides(&ids, &vals).unwrap();
    b.apply(&s, &full_delta(&s), &store);
    s.items.get_mut(&G).unwrap().xform[4] += 10.0;
    let delta = TxDelta {
        seq: 2,
        items_upserted: vec![G],
        ..TxDelta::default()
    };
    assert_eq!(b.apply(&s, &delta, &store).why, 0, "the rows-only path");
    let (item, p) = b.to_game(&s, 42.0, 94.0).unwrap();
    assert_eq!(item, Some(C1));
    assert!(near(p, [42.0, 213.0]), "{p:?}");
    assert_eq!(b.hit_test(20.0, 94.0), None);
}

#[test]
fn sabotage_inverse_skip_is_caught() {
    let (s, b) = applied(
        Some(ov(Variant::Moved)),
        OverrideSabotage {
            inverse_skip: true,
            ..Default::default()
        },
    );
    let (item, p) = b.to_game(&s, 32.0, 94.0).unwrap();
    assert_eq!(item, Some(C1));
    assert!(!near(p, [32.0, 213.0]), "inverse-skip not caught");
}

// ------------------------------------------------------------- FRZ-HOOK (frz-d.md §5, §6)

/// A packed table of one frozen override (identity, white, visible).
fn frozen_table(id: Id) -> (Vec<u32>, Vec<f32>) {
    let mut v = Vec::with_capacity(OVERRIDE_FLOATS);
    v.extend_from_slice(&geom::IDENTITY);
    v.extend_from_slice(&[1.0; 4]);
    v.push(1.0); // visible
    v.push(1.0); // frozen
    (vec![id], v)
}

/// The base scene with C1 drawing texture 5, and the store holding its payload. Returns the hash.
fn tex_scene() -> (ResolvedState, PayloadStore, Hash) {
    let mut s = base();
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
            width: 8,
            height: 8,
            mipmaps: false,
            payload_bytes: 100,
            variants: Vec::new(),
            canvas: None,
        },
    );
    let c1 = s.items.get_mut(&C1).unwrap();
    c1.commands = Commands {
        list: vec![Command::TextureRectRegion {
            tex: Some(5),
            transpose: false,
            clip_uv: false,
            rect: [0.0, 0.0, 30.0, 20.0],
            src: [0.0, 0.0, 30.0, 20.0],
            modulate: [1.0; 4],
        }],
        ..Commands::default()
    };
    let mut store = PayloadStore::default();
    store.textures.insert(
        hash,
        payloads::TexturePixels {
            width: 8,
            height: 8,
            rgba: vec![255; 256].into(),
            format: "RGBA8".into(),
            mipmaps: false,
            data_len: 256,
            compressed: None,
            half: None,
            floats: None,
        },
    );
    (s, store, hash)
}

fn full_delta_tex(s: &ResolvedState) -> TxDelta {
    TxDelta {
        full: true,
        canvases_upserted: vec![CANVAS],
        items_upserted: s.items.keys().copied().collect(),
        items_commands: s.items.keys().copied().collect(),
        textures_upserted: s.textures.keys().copied().collect(),
        ..TxDelta::default()
    }
}

#[test]
fn frozen_holds_records_through_change_and_removal_then_unfreeze() {
    let store = PayloadStore::default();
    let mut s = base();
    let mut b = applier();
    // The subtree is already drawn before it is frozen (the freeze holds what is there).
    b.apply(&s, &full_delta(&s), &store);
    let held = b.paint_digest();
    let (ids, vals) = frozen_table(P);
    b.set_overrides(&ids, &vals).unwrap();
    // The freeze is composed now (the redraw path), before any change arrives.
    assert_ne!(b.refresh_overrides(&s, &store), Refresh::Clean);

    // A change while frozen is skipped (the membership syncs at this apply).
    s.items.get_mut(&C1).unwrap().xform[4] += 40.0;
    b.apply(&s, &TxDelta { seq: 2, items_upserted: vec![C1], ..TxDelta::default() }, &store);
    assert!(b.frozen.contains(&P) && b.frozen.contains(&C1) && b.frozen.contains(&C2));
    assert_eq!(b.paint_digest(), held, "a change applied while frozen");

    // A removal while frozen is skipped: the records stay and still draw.
    s.items.remove(&P);
    s.items.remove(&C1);
    s.items.remove(&C2);
    s.items.get_mut(&G).unwrap().children.clear();
    b.apply(
        &s,
        &TxDelta { seq: 3, items_upserted: vec![G], items_removed: vec![P, C1, C2], ..TxDelta::default() },
        &store,
    );
    assert!(
        b.items.contains_key(&P) && b.items.contains_key(&C1) && b.items.contains_key(&C2),
        "held records dropped by the removal"
    );

    // Unfreezing marks the subtree changed; the next apply re-reads it from the state (which no
    // longer holds it), drops the records and matches the state's shot.
    b.set_overrides(&[], &[]).unwrap();
    b.apply(&s, &TxDelta { seq: 4, ..TxDelta::default() }, &store);
    assert!(
        !b.items.contains_key(&P) && !b.items.contains_key(&C1) && !b.items.contains_key(&C2),
        "stale records kept after unfreeze"
    );
    let mut a = applier();
    a.apply(&s, &full_delta(&s), &store);
    assert_eq!(b.paint_digest(), a.paint_digest(), "unfreeze did not match the state");
}

#[test]
fn sabotage_frozen_still_applies_is_caught() {
    let store = PayloadStore::default();
    let mut s = base();
    let mut b = applier();
    b.apply(&s, &full_delta(&s), &store);
    let held = b.paint_digest();
    let (ids, vals) = frozen_table(P);
    b.set_overrides(&ids, &vals).unwrap();
    b.ov_sabotage.frozen_still_applies = true;
    assert_ne!(b.refresh_overrides(&s, &store), Refresh::Clean);
    s.items.get_mut(&C1).unwrap().xform[4] += 40.0;
    b.apply(&s, &TxDelta { seq: 2, items_upserted: vec![C1], ..TxDelta::default() }, &store);
    assert_ne!(b.paint_digest(), held, "frozen-still-applies not caught");
}

#[test]
fn unfreeze_reapplies_a_skipped_change() {
    let store = PayloadStore::default();
    let mut s = base();
    let mut b = applier();
    b.apply(&s, &full_delta(&s), &store);
    let held = b.paint_digest();
    let (ids, vals) = frozen_table(P);
    b.set_overrides(&ids, &vals).unwrap();
    assert_ne!(b.refresh_overrides(&s, &store), Refresh::Clean);

    s.items.get_mut(&C1).unwrap().xform[4] += 40.0;
    b.apply(&s, &TxDelta { seq: 2, items_upserted: vec![C1], ..TxDelta::default() }, &store);
    assert_eq!(b.paint_digest(), held, "the change applied while frozen");

    // Unfreeze: the skipped change is re-read from the (current) state.
    b.set_overrides(&[], &[]).unwrap();
    b.apply(&s, &TxDelta { seq: 3, ..TxDelta::default() }, &store);
    let mut a = applier();
    a.apply(&s, &full_delta(&s), &store);
    assert_eq!(b.paint_digest(), a.paint_digest(), "the skipped change was not re-applied");
    assert_ne!(b.paint_digest(), held, "the change never landed");
}

#[test]
fn frozen_payloads_survive_and_frozen_sweeps_drops_them() {
    let (mut s, store, hash) = tex_scene();
    let mut b = applier();
    b.apply(&s, &full_delta_tex(&s), &store);
    assert!(b.referenced_payload_hashes().contains(&hash), "the texture is not resident");
    let (ids, vals) = frozen_table(P);
    b.set_overrides(&ids, &vals).unwrap();
    assert_ne!(b.refresh_overrides(&s, &store), Refresh::Clean);
    // A change while frozen syncs the membership (the subtree is still in the state).
    s.items.get_mut(&C1).unwrap().xform[4] += 40.0;
    b.apply(&s, &TxDelta { seq: 2, items_upserted: vec![C1], ..TxDelta::default() }, &store);

    // Remove the frozen subtree and its now-unreferenced texture: the held record keeps the
    // texture resident, so the retention sweep keeps its payload.
    s.items.remove(&P);
    s.items.remove(&C1);
    s.items.remove(&C2);
    s.items.get_mut(&G).unwrap().children.clear();
    s.textures.remove(&5);
    b.apply(
        &s,
        &TxDelta {
            seq: 3,
            items_upserted: vec![G],
            items_removed: vec![P, C1, C2],
            textures_removed: vec![5],
            ..TxDelta::default()
        },
        &store,
    );
    assert!(
        b.referenced_payload_hashes().contains(&hash),
        "the frozen subtree's payload was dropped by the retention sweep"
    );

    // The sabotage drops it: the sweep no longer reports the held payload.
    let mut c = applier();
    c.ov_sabotage.frozen_sweeps = true;
    let (s2, store2, hash2) = tex_scene();
    c.apply(&s2, &full_delta_tex(&s2), &store2);
    let (ids2, vals2) = frozen_table(P);
    c.set_overrides(&ids2, &vals2).unwrap();
    assert_ne!(c.refresh_overrides(&s2, &store2), Refresh::Clean);
    let mut s2 = s2;
    s2.items.get_mut(&C1).unwrap().xform[4] += 40.0;
    c.apply(&s2, &TxDelta { seq: 2, items_upserted: vec![C1], ..TxDelta::default() }, &store2);
    s2.items.remove(&P);
    s2.items.remove(&C1);
    s2.items.remove(&C2);
    s2.items.get_mut(&G).unwrap().children.clear();
    s2.textures.remove(&5);
    c.apply(
        &s2,
        &TxDelta {
            seq: 3,
            items_upserted: vec![G],
            items_removed: vec![P, C1, C2],
            textures_removed: vec![5],
            ..TxDelta::default()
        },
        &store2,
    );
    assert!(
        !c.referenced_payload_hashes().contains(&hash2),
        "frozen-sweeps was not caught"
    );
}
