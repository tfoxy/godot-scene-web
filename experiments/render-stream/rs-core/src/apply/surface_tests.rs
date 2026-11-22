//! render-stream/16 viewport surfaces in the applier (surfaces.rs; viewport-surfaces-design.md
//! Q5a-c) on hand-built /16 states: which surfaces are built, in which order, when a due one is
//! skipped, and what the executor is told to allocate and free.

use super::surfaces::godot_order;
use super::*;
use crate::state::*;
use gsw_canvas_draw_list::{TextureOp, ROOT_SURFACE};

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

fn rect(r: [f32; 4]) -> Commands {
    Commands {
        list: vec![Command::Rect {
            aa: false,
            rect: r,
            color: [1.0; 4],
        }],
        ..Commands::default()
    }
}

fn tex_rect(tex: Id, r: [f32; 4]) -> Commands {
    Commands {
        list: vec![Command::TextureRect {
            tex: Some(tex),
            tile: false,
            transpose: false,
            rect: r,
            modulate: [1.0; 4],
        }],
        ..Commands::default()
    }
}

fn texture(id: Id, kind: TextureKind, viewport: Option<Id>, target: Option<Id>) -> Texture {
    Texture {
        id,
        origin: Origin::Created,
        adopted_content: None,
        kind,
        status: EntryStatus::Ok,
        reason: None,
        version: 1,
        hash: None,
        format: None,
        source_format: None,
        width: 0,
        height: 0,
        mipmaps: false,
        payload_bytes: 0,
        variants: Vec::new(),
        size_override: None,
        viewport,
        target,
        canvas: None,
    }
}

fn canvas(id: Id, root: bool, items: Vec<Id>) -> Canvas {
    Canvas {
        id,
        origin: Origin::Created,
        root,
        attached: root,
        layer: 0,
        sublayer: 0,
        items,
        xform: geom::IDENTITY,
        modulate: [1.0; 4],
    }
}

fn surface(id: Id, parent: Id, canvases: &[Id], size: [i64; 2]) -> ViewportSurface {
    ViewportSurface {
        id,
        origin: Origin::Created,
        parent: Some(parent),
        active: true,
        active_seq: id as i64,
        size,
        transparent: true,
        update: ViewportUpdate::Always,
        once_seq: 0,
        clear: ViewportClear::Always,
        clear_seq: 0,
        disable_2d: false,
        renders_3d: false,
        hdr_2d: false,
        msaa_2d: 0,
        canvas_cull_mask: 0xffff_ffff,
        default_texture_filter: Filter::Linear,
        default_texture_repeat: Repeat::Disabled,
        snap_2d: [false, false],
        canvases: canvases
            .iter()
            .map(|c| ViewportCanvas {
                canvas: *c,
                layer: 0,
                sublayer: 0,
            })
            .collect(),
        global_xform: geom::IDENTITY,
        canvas_xforms: canvases.iter().map(|_| geom::IDENTITY).collect(),
    }
}

const fn on(canvas: Id) -> Parent {
    Parent {
        kind: ParentKind::Canvas,
        id: canvas,
    }
}

/// Root canvas 1 draws viewport 5's texture (100) with item 10; viewport 5 (32x16, transparent,
/// `always`) draws canvas 2, where item 20 is a rect.
pub(super) fn scene() -> ResolvedState {
    let mut s = ResolvedState::empty(16);
    s.canvases.insert(1, canvas(1, true, vec![10]));
    s.canvases.insert(2, canvas(2, false, vec![20]));
    s.items.insert(10, item(10, on(1), tex_rect(100, [0.0, 0.0, 32.0, 16.0])));
    s.items.insert(20, item(20, on(2), rect([2.0, 2.0, 8.0, 8.0])));
    s.textures
        .insert(100, texture(100, TextureKind::Viewport, Some(5), None));
    s.viewports.insert(5, surface(5, 0, &[2], [32, 16]));
    s
}

fn full_delta(s: &ResolvedState) -> TxDelta {
    TxDelta {
        full: true,
        canvases_upserted: s.canvases.keys().copied().collect(),
        items_upserted: s.items.keys().copied().collect(),
        items_commands: s.items.keys().copied().collect(),
        textures_upserted: s.textures.keys().copied().collect(),
        ..TxDelta::default()
    }
}

fn applier() -> Applier {
    Applier::new(Viewport {
        width: 64,
        height: 32,
        clear: [0.2, 0.2, 0.4, 1.0],
        global_xform: geom::IDENTITY,
        cull_mask: 0xffff_ffff,
        format: Format::Rgb10A2,
    })
}

#[test]
fn surface_groups_inherit_scissor_option_on_creation_and_update() {
    let mut s = scene();
    let owner = s.items.get_mut(&20).unwrap();
    owner.commands = rect([8.0, 4.0, 8.0, 4.0]);
    owner.children = vec![21];
    owner.canvas_group = Some(CanvasGroup {
        mode: CanvasGroupMode::ClipOnly,
        clear_margin: 5.0,
        fit_empty: false,
        fit_margin: 0.0,
        blur_mipmaps: false,
    });
    s.items.insert(
        21,
        item(
            21,
            Parent {
                kind: ParentKind::Item,
                id: 20,
            },
            rect([0.0, 0.0, 30.0, 16.0]),
        ),
    );
    let mut a = applier();
    for (step, on) in [false, true, false].into_iter().enumerate() {
        a.set_group_scissor(on);
        s.items.get_mut(&20).unwrap().xform[4] = step as f32;
        let delta = if step == 0 {
            full_delta(&s)
        } else {
            TxDelta {
                items_upserted: vec![20],
                ..TxDelta::default()
            }
        };
        a.apply(&s, &delta, &PayloadStore::default());
        let pass = a.surfaces.as_ref().unwrap().applier(5).unwrap();
        assert!(!pass.list.screen_ops.is_empty());
        assert_eq!(
            pass.list.draws.iter().any(|d| d.flags & DRAW_SCISSOR != 0),
            on
        );
        if on {
            assert_eq!(pass.list.screen_ops[0].region, [8, 3, 10, 6]);
        }
        a.list.consumed();
        a.surfaces.as_mut().unwrap().consumed();
    }
}

#[test]
fn surface_groups_inherit_cells_option_on_creation_and_update() {
    let mut s = scene();
    s.viewports.get_mut(&5).unwrap().size = [128, 64];
    let owner = s.items.get_mut(&20).unwrap();
    owner.commands = tex_rect(300, [0.0, 0.0, 128.0, 64.0]);
    owner.children = vec![21];
    owner.canvas_group = Some(CanvasGroup {
        mode: CanvasGroupMode::ClipOnly,
        clear_margin: 5.0,
        fit_empty: false,
        fit_margin: 0.0,
        blur_mipmaps: false,
    });
    s.items.insert(
        21,
        item(
            21,
            Parent {
                kind: ParentKind::Item,
                id: 20,
            },
            rect([0.0, 0.0, 128.0, 64.0]),
        ),
    );
    let (mut t, mut px) = image(300, 1, 255);
    t.width = 128;
    t.height = 64;
    t.payload_bytes = 128 * 64 * 4;
    let mut rgba = vec![255; t.payload_bytes as usize];
    for y in 0..64 {
        for x in 32..96 {
            rgba[(y * 128 + x) * 4 + 3] = 0;
        }
    }
    px.width = 128;
    px.height = 64;
    px.data_len = rgba.len();
    px.rgba = rgba.into();
    let mut store = PayloadStore::default();
    store.textures.insert(t.hash.unwrap(), px.with_opacity());
    s.textures.insert(300, t);
    let mut a = applier();
    for (step, on) in [false, true, false].into_iter().enumerate() {
        a.set_group_cells(on);
        let delta = if step == 0 {
            full_delta(&s)
        } else {
            TxDelta::default()
        };
        a.apply(&s, &delta, &store);
        let pass = a.surfaces.as_ref().unwrap().applier(5).unwrap();
        assert!(pass.list.draws.iter().any(|d| d.flags & DRAW_GROUP_CLIP != 0));
        assert_eq!(pass.list.group_cells.is_empty(), !on, "step {step}, cells on: {on}");
        a.list.consumed();
        a.surfaces.as_mut().unwrap().consumed();
    }
}

/// One frame: apply, then what the executor would run (surface ids and clears, frees), then
/// consume every list as `draw` does.
fn frame(a: &mut Applier, s: &ResolvedState, d: &TxDelta) -> (Vec<(u32, bool)>, Vec<u32>) {
    let store = PayloadStore::default();
    a.prepare(s, d);
    a.apply(s, d, &store);
    let (passes, freed) = match a.surfaces.as_ref() {
        Some(set) => (
            set.passes()
                .map(|(l, clear)| (l.target.surface, clear))
                .collect(),
            set.freed().to_vec(),
        ),
        None => (Vec::new(), Vec::new()),
    };
    a.list.consumed();
    if let Some(set) = a.surfaces.as_mut() {
        set.consumed();
    }
    (passes, freed)
}

fn empty(s: &ResolvedState) -> TxDelta {
    TxDelta {
        seq: s.seq,
        ..TxDelta::default()
    }
}

#[test]
fn godot_order_puts_children_first_and_keeps_siblings_in_activation_order() {
    // Root children A(1), B(2) activated in that order; C(3) under A, activated last.
    let order = godot_order(&[(1, Some(0)), (2, Some(0)), (3, Some(1))]);
    assert_eq!(order, vec![3, 1, 2]);
    // Activation order decides siblings, not ids.
    assert_eq!(godot_order(&[(2, Some(0)), (1, Some(0))]), vec![2, 1]);
    // A viewport under an inactive parent is never reached (as in Godot).
    assert_eq!(godot_order(&[(4, Some(9)), (1, Some(0))]), vec![1]);
    // Out of the tree (no parent): its own root, after the root's subtree.
    assert_eq!(godot_order(&[(1, Some(0)), (7, None)]), vec![1, 7]);
}

#[test]
fn a_state_without_viewports_builds_nothing() {
    let mut s = scene();
    s.viewports.clear();
    s.textures.clear();
    s.items.insert(10, item(10, on(1), rect([0.0, 0.0, 4.0, 4.0])));
    let mut a = applier();
    let d = full_delta(&s);
    let (passes, freed) = frame(&mut a, &s, &d);
    assert!(passes.is_empty() && freed.is_empty());
    assert!(a.surfaces.is_none(), "no viewport: no surface set at all");
}

#[test]
fn the_root_samples_a_surface_through_its_alias_and_the_surface_draws_its_canvas() {
    let s = scene();
    let mut a = applier();
    let d = full_delta(&s);
    let store = PayloadStore::default();
    a.prepare(&s, &d);
    a.apply(&s, &d, &store);
    // The viewport texture became an alias of surface 5, and the root's draw samples it.
    assert!(a
        .list
        .texture_ops
        .contains(&TextureOp::Surface { id: 100, surface: 5 }));
    assert_eq!(a.list.target.surface, ROOT_SURFACE);
    assert!(a.list.draws.iter().any(|d| d.texture == 100));
    let set = a.surfaces.as_ref().unwrap();
    let passes: Vec<_> = set.passes().collect();
    assert_eq!(passes.len(), 1);
    let (l, clear) = passes[0];
    assert!(clear);
    assert_eq!(l.target.surface, 5);
    assert_eq!((l.target.width, l.target.height), (32, 16));
    assert_eq!(l.target.format, Format::Rgba8);
    assert!(!l.target.opaque, "a transparent surface is a transparent target");
    assert_eq!(l.target.clear, [0.0; 4]);
    // Its uploads are the root's alone.
    assert!(l.texture_ops.is_empty());
    // Item 20 is drawn there, item 10 (the root's) is not.
    assert_eq!(l.draws.len(), 1);
    assert_eq!(set.applier(5).unwrap().items.len(), 1);
    assert!(set.applier(5).unwrap().items.contains_key(&20));
    // The surface's sampler default is the viewport's (Linear), not the session's.
    assert_ne!(l.draws[0].sampler & Sampler::LINEAR, 0);
    assert_eq!(set.stats.rendered, 1);
    assert_eq!(set.stats.allocated_pixels, 32 * 16);
}

#[test]
fn a_surface_the_root_does_not_reach_is_never_built() {
    let mut s = scene();
    // The root's item draws a plain rect: nothing samples viewport 5.
    s.items.insert(10, item(10, on(1), rect([0.0, 0.0, 4.0, 4.0])));
    let mut a = applier();
    let d = full_delta(&s);
    let (passes, _) = frame(&mut a, &s, &d);
    assert!(passes.is_empty());
    let set = a.surfaces.as_ref().unwrap();
    assert!(set.ids().is_empty(), "no applier, no target");
    assert_eq!(set.stats.allocated, 0);
}

#[test]
fn an_unchanged_idempotent_surface_is_not_re_rendered_until_something_it_draws_changes() {
    let mut s = scene();
    let mut a = applier();
    let d = full_delta(&s);
    assert_eq!(frame(&mut a, &s, &d).0, vec![(5, true)]);
    // Nothing changed: due (always) but skipped.
    let (passes, _) = frame(&mut a, &s, &empty(&s));
    assert!(passes.is_empty());
    assert_eq!(a.surfaces.as_ref().unwrap().stats.unchanged, 1);
    // The surface's item moves: rendered again.
    s.seq += 1;
    s.items.get_mut(&20).unwrap().xform = [1.0, 0.0, 0.0, 1.0, 3.0, 0.0];
    let d = TxDelta {
        seq: s.seq,
        items_upserted: vec![20],
        ..TxDelta::default()
    };
    assert_eq!(frame(&mut a, &s, &d).0, vec![(5, true)]);
    // A change only the root sees does not re-render it.
    s.seq += 1;
    s.items.get_mut(&10).unwrap().xform = [1.0, 0.0, 0.0, 1.0, 1.0, 0.0];
    let d = TxDelta {
        seq: s.seq,
        items_upserted: vec![10],
        ..TxDelta::default()
    };
    assert!(frame(&mut a, &s, &d).0.is_empty());
}

#[test]
fn once_renders_once_per_once_seq_and_disabled_never_renders_alone() {
    let mut s = scene();
    s.viewports.get_mut(&5).unwrap().update = ViewportUpdate::Disabled;
    let mut a = applier();
    let d = full_delta(&s);
    assert!(frame(&mut a, &s, &d).0.is_empty(), "disabled, never once: never drawn");
    assert!(a.surfaces.as_ref().unwrap().ids().is_empty());
    s.seq += 1;
    {
        let v = s.viewports.get_mut(&5).unwrap();
        v.update = ViewportUpdate::Once;
        v.once_seq = 1;
    }
    assert_eq!(frame(&mut a, &s, &empty(&s)).0, vec![(5, true)]);
    // The same once_seq again: kept, even when what it draws changed.
    s.seq += 1;
    s.items.get_mut(&20).unwrap().xform = [1.0, 0.0, 0.0, 1.0, 3.0, 0.0];
    let d = TxDelta {
        seq: s.seq,
        items_upserted: vec![20],
        ..TxDelta::default()
    };
    assert!(frame(&mut a, &s, &d).0.is_empty());
    // A new once (the game set disabled again before the receiver saw it): one snapshot more,
    // with the change it missed.
    s.seq += 1;
    {
        let v = s.viewports.get_mut(&5).unwrap();
        v.update = ViewportUpdate::Disabled;
        v.once_seq = 2;
    }
    assert_eq!(frame(&mut a, &s, &empty(&s)).0, vec![(5, true)]);
}

#[test]
fn clear_never_accumulates_every_due_frame_and_is_typed() {
    let mut s = scene();
    s.viewports.get_mut(&5).unwrap().clear = ViewportClear::Never;
    let mut a = applier();
    let d = full_delta(&s);
    assert_eq!(frame(&mut a, &s, &d).0, vec![(5, false)]);
    assert_eq!(frame(&mut a, &s, &empty(&s)).0, vec![(5, false)]);
    assert!(a.shortcut_totals["viewport-accumulation"] >= 2);
    // next_frame: one clear per new clear_seq.
    s.seq += 1;
    {
        let v = s.viewports.get_mut(&5).unwrap();
        v.clear = ViewportClear::NextFrame;
        v.clear_seq = 1;
    }
    assert_eq!(frame(&mut a, &s, &empty(&s)).0, vec![(5, true)]);
    assert_eq!(frame(&mut a, &s, &empty(&s)).0, vec![(5, false)]);
}

#[test]
fn nested_surfaces_render_children_first_and_when_parent_visible_follows_its_parent() {
    let mut s = scene();
    // Viewport 5's item draws viewport 6's texture (101); 6 is 5's child, when_parent_visible.
    s.canvases.insert(3, canvas(3, false, vec![30]));
    s.items.insert(20, item(20, on(2), tex_rect(101, [0.0, 0.0, 16.0, 8.0])));
    s.items.insert(30, item(30, on(3), rect([0.0, 0.0, 2.0, 2.0])));
    s.textures
        .insert(101, texture(101, TextureKind::Viewport, Some(6), None));
    let mut inner = surface(6, 5, &[3], [16, 8]);
    inner.update = ViewportUpdate::WhenParentVisible;
    s.viewports.insert(6, inner);
    let mut a = applier();
    let d = full_delta(&s);
    assert_eq!(frame(&mut a, &s, &d).0, vec![(6, true), (5, true)]);
    // The parent disabled: neither renders.
    s.seq += 1;
    s.viewports.get_mut(&5).unwrap().update = ViewportUpdate::Disabled;
    s.items.get_mut(&30).unwrap().xform = [1.0, 0.0, 0.0, 1.0, 1.0, 0.0];
    let d = TxDelta {
        seq: s.seq,
        items_upserted: vec![30],
        ..TxDelta::default()
    };
    assert!(frame(&mut a, &s, &d).0.is_empty());
    // Enabled again: the inner change it missed is drawn (its applier kept the delta).
    s.seq += 1;
    s.viewports.get_mut(&5).unwrap().update = ViewportUpdate::Always;
    let (passes, _) = frame(&mut a, &s, &empty(&s));
    assert_eq!(passes, vec![(6, true), (5, true)]);
    let inner = a.surfaces.as_ref().unwrap().applier(6).unwrap();
    assert_eq!(inner.list.items[0].xform[4], 1.0);
}

#[test]
fn a_shared_canvas_has_rows_in_every_pass_that_draws_it() {
    let mut s = scene();
    // Viewport 5 draws the root's canvas 1 too (one World2D in two viewports), at an offset.
    {
        let v = s.viewports.get_mut(&5).unwrap();
        v.canvases.insert(
            0,
            ViewportCanvas {
                canvas: 1,
                layer: 0,
                sublayer: 0,
            },
        );
        v.canvas_xforms.insert(0, [1.0, 0.0, 0.0, 1.0, 5.0, 0.0]);
    }
    let mut a = applier();
    let d = full_delta(&s);
    frame(&mut a, &s, &d);
    let sub = a.surfaces.as_ref().unwrap().applier(5).unwrap();
    assert!(sub.items.contains_key(&10) && sub.items.contains_key(&20));
    // Item 10 on the surface draws with the surface's canvas transform.
    let row = sub.items[&10].row as usize;
    assert_eq!(sub.list.items[row].xform[4], 5.0);
    // And on the root with the root's.
    assert_eq!(a.list.items[a.items[&10].row as usize].xform[4], 0.0);
    // It samples itself through item 10: typed feedback, no loop.
    assert!(a.shortcut_totals.get("viewport-feedback").is_some_and(|n| *n >= 1));
}

#[test]
fn a_proxy_draws_its_viewport_target() {
    let mut s = scene();
    s.textures
        .insert(200, texture(200, TextureKind::Proxy, None, Some(100)));
    s.items.insert(10, item(10, on(1), tex_rect(200, [0.0, 0.0, 32.0, 16.0])));
    let mut a = applier();
    let d = full_delta(&s);
    assert_eq!(frame(&mut a, &s, &d).0, vec![(5, true)]);
    assert!(a.list.draws.iter().any(|d| d.texture == 100), "the proxy binds its target");
    // Re-pointed at nothing drawable: the root stops sampling 5.
    s.seq += 1;
    s.textures.get_mut(&200).unwrap().target = None;
    s.textures.get_mut(&200).unwrap().status = EntryStatus::Unsupported;
    let d = TxDelta {
        seq: s.seq,
        textures_upserted: vec![200],
        ..TxDelta::default()
    };
    frame(&mut a, &s, &d);
    assert!(!a.list.draws.iter().any(|d| d.texture == 100));
}

#[test]
fn a_resize_reallocates_and_a_freed_or_deactivated_viewport_frees_its_target() {
    let mut s = scene();
    let mut a = applier();
    let d = full_delta(&s);
    frame(&mut a, &s, &d);
    s.seq += 1;
    s.viewports.get_mut(&5).unwrap().size = [40, 20];
    let store = PayloadStore::default();
    let e = empty(&s);
    a.prepare(&s, &e);
    a.apply(&s, &e, &store);
    {
        let set = a.surfaces.as_ref().unwrap();
        let (l, _) = set.passes().next().unwrap();
        assert_eq!((l.target.width, l.target.height), (40, 20));
        assert_eq!(set.stats.allocated_pixels, 40 * 20);
    }
    a.list.consumed();
    a.surfaces.as_mut().unwrap().consumed();
    // Deactivated: freed.
    s.seq += 1;
    s.viewports.get_mut(&5).unwrap().active = false;
    let (passes, freed) = frame(&mut a, &s, &empty(&s));
    assert!(passes.is_empty());
    assert_eq!(freed, vec![5]);
    assert!(a.surfaces.as_ref().unwrap().ids().is_empty());
    // Re-activated, then the viewport freed with its texture.
    s.seq += 1;
    s.viewports.get_mut(&5).unwrap().active = true;
    assert_eq!(frame(&mut a, &s, &empty(&s)).0, vec![(5, true)]);
    s.seq += 1;
    s.viewports.remove(&5);
    s.textures.get_mut(&100).unwrap().status = EntryStatus::Freed;
    let d = TxDelta {
        seq: s.seq,
        textures_upserted: vec![100],
        ..TxDelta::default()
    };
    let (_, freed) = frame(&mut a, &s, &d);
    assert_eq!(freed, vec![5]);
}

#[test]
fn the_viewports_option_off_builds_no_surface_and_counts_it() {
    let s = scene();
    let mut a = applier();
    a.viewports_enabled = false;
    let d = full_delta(&s);
    let (passes, _) = frame(&mut a, &s, &d);
    assert!(passes.is_empty());
    let set = a.surfaces.as_ref().unwrap();
    assert_eq!(set.stats.skipped_off, 1);
    assert!(set.ids().is_empty());
    // The table is still applied: the alias exists, so the draw samples transparent.
    assert!(a.list.draws.iter().any(|d| d.texture == 100));
}

#[test]
fn a_surface_over_the_largest_texture_side_is_refused_and_typed() {
    let mut s = scene();
    s.viewports.get_mut(&5).unwrap().size = [5000, 16];
    let mut a = applier();
    a.max_texture_side = 4096;
    let d = full_delta(&s);
    assert!(frame(&mut a, &s, &d).0.is_empty());
    assert_eq!(a.shortcut_totals["viewport-too-large"], 1);
}

#[test]
fn a_one_pixel_or_inactive_viewport_is_not_rendered() {
    let mut s = scene();
    s.viewports.get_mut(&5).unwrap().size = [1, 16];
    let mut a = applier();
    let d = full_delta(&s);
    assert!(frame(&mut a, &s, &d).0.is_empty());
}
fn apply_only(a: &mut Applier, s: &ResolvedState, d: &TxDelta) {
    let store = PayloadStore::default();
    a.prepare(s, d);
    a.apply(s, d, &store);
}

#[test]
fn two_applies_before_one_draw_keep_a_once_render() {
    let mut s = scene();
    s.viewports.get_mut(&5).unwrap().update = ViewportUpdate::Once;
    let mut a = applier();
    let d = full_delta(&s);
    frame(&mut a, &s, &d);
    s.seq += 1;
    s.viewports.get_mut(&5).unwrap().once_seq = 1;
    s.items.get_mut(&20).unwrap().xform = [1.0, 0.0, 0.0, 1.0, 3.0, 0.0];
    let d1 = TxDelta { seq: s.seq, items_upserted: vec![20], ..TxDelta::default() };
    apply_only(&mut a, &s, &d1);
    let after_first: Vec<u32> = a.surfaces.as_ref().unwrap().passes().map(|(l, _)| l.target.surface).collect();
    // A second transaction (nothing about viewport 5) applied before the draw.
    s.seq += 1;
    apply_only(&mut a, &s, &empty(&s));
    let at_draw: Vec<u32> = a.surfaces.as_ref().unwrap().passes().map(|(l, _)| l.target.surface).collect();
    eprintln!("after first apply: {after_first:?}; at draw: {at_draw:?}");
    assert_eq!(at_draw, vec![5], "the once render requested by the first apply reaches the draw");
}

#[test]
fn a_freed_surface_rerenders_with_a_full_list() {
    let mut s = scene();
    let mut a = applier();
    let d = full_delta(&s);
    frame(&mut a, &s, &d);
    // The root stops sampling it and the viewport resizes meanwhile: freed (stale size).
    s.seq += 1;
    { let mut it = item(10, on(1), rect([0.0, 0.0, 4.0, 4.0])); it.content_version = s.seq as i64 + 10; s.items.insert(10, it); }
    s.viewports.get_mut(&5).unwrap().size = [40, 20];
    let d = TxDelta { seq: s.seq, items_upserted: vec![10], items_commands: vec![10], ..TxDelta::default() };
    let (p2, freed) = frame(&mut a, &s, &d);
    eprintln!("f2 passes {p2:?} freed: {freed:?} root samples 100: {}", a.list.draws.iter().any(|d| d.texture == 100));
    // Sampled again.
    s.seq += 1;
    { let mut it = item(10, on(1), tex_rect(100, [0.0, 0.0, 32.0, 16.0])); it.content_version = s.seq as i64 + 10; s.items.insert(10, it); }
    let d = TxDelta { seq: s.seq, items_upserted: vec![10], items_commands: vec![10], ..TxDelta::default() };
    apply_only(&mut a, &s, &d);
    let set = a.surfaces.as_ref().unwrap();
    let passes: Vec<(u32, bool)> = set.passes().map(|(l, _)| (l.target.surface, l.dirty.all)).collect();
    eprintln!("passes (surface, dirty.all): {passes:?}");
    assert_eq!(passes, vec![(5, true)], "fresh executor objects need a dirty.all list");
}

#[test]
fn a_surface_back_in_the_closure_sees_a_sampled_surface_that_changed_meanwhile() {
    let mut s = ResolvedState::empty(16);
    s.canvases.insert(1, canvas(1, true, vec![10, 11]));
    s.canvases.insert(2, canvas(2, false, vec![20]));
    s.canvases.insert(3, canvas(3, false, vec![30]));
    s.items.insert(10, item(10, on(1), tex_rect(100, [0.0, 0.0, 32.0, 16.0])));
    s.items.insert(11, item(11, on(1), tex_rect(101, [32.0, 0.0, 32.0, 16.0])));
    s.items.insert(20, item(20, on(2), tex_rect(101, [0.0, 0.0, 32.0, 16.0])));
    s.items.insert(30, item(30, on(3), rect([2.0, 2.0, 8.0, 8.0])));
    s.textures.insert(100, texture(100, TextureKind::Viewport, Some(5), None));
    s.textures.insert(101, texture(101, TextureKind::Viewport, Some(6), None));
    s.viewports.insert(5, surface(5, 0, &[2], [32, 16]));
    s.viewports.insert(6, surface(6, 0, &[3], [32, 16]));
    s.viewports.get_mut(&6).unwrap().active_seq = 1;
    s.viewports.get_mut(&5).unwrap().active_seq = 2;
    let mut a = applier();
    let d = full_delta(&s);
    eprintln!("f1 {:?}", frame(&mut a, &s, &d).0);
    // Frame 2: the root stops drawing viewport 5; viewport 6's content moves (6 re-renders).
    s.seq += 1;
    { let mut it = item(10, on(1), rect([0.0, 0.0, 4.0, 4.0])); it.content_version = s.seq as i64 + 10; s.items.insert(10, it); }
    s.items.get_mut(&30).unwrap().xform = [1.0, 0.0, 0.0, 1.0, 5.0, 0.0];
    let d = TxDelta { seq: s.seq, items_upserted: vec![10, 30], items_commands: vec![10], ..TxDelta::default() };
    eprintln!("f2 {:?}", frame(&mut a, &s, &d).0);
    // Frame 3: viewport 5 drawn again; it samples 6, whose contents changed since 5's last render.
    s.seq += 1;
    { let mut it = item(10, on(1), tex_rect(100, [0.0, 0.0, 32.0, 16.0])); it.content_version = s.seq as i64 + 10; s.items.insert(10, it); }
    let d = TxDelta { seq: s.seq, items_upserted: vec![10], items_commands: vec![10], ..TxDelta::default() };
    let f3 = frame(&mut a, &s, &d).0;
    eprintln!("f3 {f3:?}");
    assert!(f3.iter().any(|(v, _)| *v == 5), "5 must re-render: what it samples changed");
}

#[test]
fn a_context_restore_redraw_rerenders_live_surfaces() {
    let s = scene();
    let mut a = applier();
    let d = full_delta(&s);
    assert_eq!(frame(&mut a, &s, &d).0, vec![(5, true)]);
    // Context lost and restored with no new transaction (loop.ts stepContext -> core.redraw ->
    // gsw-rs draw -> Applier::context_restored -> execute_lists again).
    let store = PayloadStore::default();
    a.context_restored(&store);
    let passes: Vec<u32> = a.surfaces.as_ref().unwrap().passes().map(|(l, _)| l.target.surface).collect();
    eprintln!("passes in the restore redraw: {passes:?}");
    assert_eq!(passes, vec![5], "the new context has no surface target: the redraw must render it");
}

fn image(id: Id, version: i64, byte: u8) -> (Texture, payloads::TexturePixels) {
    let mut t = texture(id, TextureKind::Image, None, None);
    t.version = version;
    t.hash = Some(Hash([byte; 32]));
    t.format = Some("RGBA8".into());
    t.width = 2;
    t.height = 2;
    t.payload_bytes = 16;
    let px = payloads::TexturePixels {
        width: 2,
        height: 2,
        rgba: vec![byte; 16].into(),
        format: "RGBA8".into(),
        mipmaps: false,
        data_len: 16,
        compressed: None,
        half: None,
        floats: None,
        opacity: None,
    };
    (t, px)
}

#[test]
fn an_image_re_uploaded_while_a_surface_is_out_of_the_closure_re_renders_it_when_back() {
    let mut s = scene();
    // The surface draws image 300.
    s.items.insert(20, item(20, on(2), tex_rect(300, [0.0, 0.0, 8.0, 8.0])));
    let (t, px) = image(300, 1, 7);
    let mut store = PayloadStore::default();
    store.textures.insert(t.hash.unwrap(), px);
    s.textures.insert(300, t);
    let mut a = applier();
    let mut step = |a: &mut Applier, s: &ResolvedState, d: &TxDelta, store: &PayloadStore| {
        a.prepare(s, d);
        a.apply(s, d, store);
        let p: Vec<u32> = a.surfaces.as_ref().unwrap().passes().map(|(l, _)| l.target.surface).collect();
        a.list.consumed();
        a.surfaces.as_mut().unwrap().consumed();
        p
    };
    assert_eq!(step(&mut a, &s, &full_delta(&s), &store), vec![5]);
    // Out of the closure; meanwhile image 300 gets a new version and payload.
    s.seq += 1;
    {
        let mut it = item(10, on(1), rect([0.0, 0.0, 4.0, 4.0]));
        it.content_version = 50;
        s.items.insert(10, it);
    }
    let (t, px) = image(300, 2, 9);
    store.textures.insert(t.hash.unwrap(), px);
    s.textures.insert(300, t);
    let d = TxDelta {
        seq: s.seq,
        items_upserted: vec![10],
        items_commands: vec![10],
        textures_upserted: vec![300],
        ..TxDelta::default()
    };
    assert!(step(&mut a, &s, &d, &store).is_empty());
    // Back: it re-renders (its list is clean, but what it samples changed).
    s.seq += 1;
    {
        let mut it = item(10, on(1), tex_rect(100, [0.0, 0.0, 32.0, 16.0]));
        it.content_version = 51;
        s.items.insert(10, it);
    }
    let d = TxDelta {
        seq: s.seq,
        items_upserted: vec![10],
        items_commands: vec![10],
        ..TxDelta::default()
    };
    assert_eq!(step(&mut a, &s, &d, &store), vec![5]);
    // And then rests (nothing changed).
    s.seq += 1;
    assert!(step(&mut a, &s, &empty(&s), &store).is_empty());
}

#[test]
fn surface_expected_calls_follow_the_passes_an_execution_runs() {
    let s = scene();
    let mut a = applier();
    let d = full_delta(&s);
    let store = PayloadStore::default();
    a.prepare(&s, &d);
    a.apply(&s, &d, &store);
    let set = a.surfaces.as_ref().unwrap();
    let merged: u32 = set.passes().map(|(l, _)| l.merged_draw_count() as u32).sum();
    assert!(merged > 0);
    assert_eq!(set.expected_calls(), merged, "the passes the next draw runs");
    // After the draw consumed them, a redraw (overrides, restore-free) runs the root alone.
    a.surfaces.as_mut().unwrap().consumed();
    assert_eq!(a.surfaces.as_ref().unwrap().expected_calls(), 0);
}

// VS3 gate round 2.

fn feedback_scene() -> ResolvedState {
    // Root draws 5 and 6; 5 (activated first, so earlier in Godot's order) samples 6.
    let mut s = ResolvedState::empty(16);
    s.canvases.insert(1, canvas(1, true, vec![10, 11]));
    s.canvases.insert(2, canvas(2, false, vec![20]));
    s.canvases.insert(3, canvas(3, false, vec![30]));
    s.items.insert(10, item(10, on(1), tex_rect(100, [0.0, 0.0, 32.0, 16.0])));
    s.items.insert(11, item(11, on(1), tex_rect(101, [32.0, 0.0, 32.0, 16.0])));
    s.items.insert(20, item(20, on(2), tex_rect(101, [0.0, 0.0, 32.0, 16.0])));
    s.items.insert(30, item(30, on(3), rect([2.0, 2.0, 8.0, 8.0])));
    s.textures.insert(100, texture(100, TextureKind::Viewport, Some(5), None));
    s.textures.insert(101, texture(101, TextureKind::Viewport, Some(6), None));
    s.viewports.insert(5, surface(5, 0, &[2], [32, 16]));
    s.viewports.insert(6, surface(6, 0, &[3], [32, 16]));
    s.viewports.get_mut(&5).unwrap().active_seq = 1;
    s.viewports.get_mut(&6).unwrap().active_seq = 2;
    s
}

#[test]
fn feedback_rests_then_restore_rerenders_the_earlier_sampler() {
    let mut s = feedback_scene();
    let mut a = applier();
    let d = full_delta(&s);
    let f1 = frame(&mut a, &s, &d).0;
    s.seq += 1;
    let f2 = frame(&mut a, &s, &empty(&s)).0;
    s.seq += 1;
    let f3 = frame(&mut a, &s, &empty(&s)).0;
    eprintln!("f1 {f1:?} f2 {f2:?} f3 {f3:?}");
    assert!(f3.is_empty(), "rests");
    let store = PayloadStore::default();
    a.context_restored(&store);
    let r: Vec<u32> = a.surfaces.as_ref().unwrap().passes().map(|(l, _)| l.target.surface).collect();
    a.list.consumed();
    a.surfaces.as_mut().unwrap().consumed();
    s.seq += 1;
    let f4 = frame(&mut a, &s, &empty(&s)).0;
    eprintln!("restore {r:?} f4 {f4:?}");
    // 5 rendered before 6 in the restore redraw, so it holds a transparent 6; Godot's 5 held
    // 6's previous (non-transparent) contents. The next frame must re-render 5, as f2 did.
    assert!(f4.iter().any(|(v, _)| *v == 5), "5 sampled a later surface the restore re-rendered");
}

#[test]
fn many_applies_before_a_draw_stay_bounded_and_then_rest() {
    let mut s = scene();
    let mut a = applier();
    let d = full_delta(&s);
    frame(&mut a, &s, &d);
    for k in 0..200 {
        s.seq += 1;
        s.items.get_mut(&20).unwrap().xform = [1.0, 0.0, 0.0, 1.0, (k % 7) as f32, 0.0];
        let d = TxDelta { seq: s.seq, items_upserted: vec![20], ..TxDelta::default() };
        apply_only(&mut a, &s, &d);
        let n = a.surfaces.as_ref().unwrap().passes().count();
        assert!(n <= 1, "order grew to {n}");
    }
    let n = a.surfaces.as_ref().unwrap().passes().count();
    a.list.consumed();
    a.surfaces.as_mut().unwrap().consumed();
    s.seq += 1;
    let rest = frame(&mut a, &s, &empty(&s)).0;
    s.seq += 1;
    let rest2 = frame(&mut a, &s, &empty(&s)).0;
    eprintln!("at draw {n}; rest {rest:?} {rest2:?}");
    assert_eq!(n, 1);
    assert!(rest.is_empty() && rest2.is_empty());
}

#[test]
fn carried_then_draw_then_rest() {
    let mut s = scene();
    s.viewports.get_mut(&5).unwrap().update = ViewportUpdate::Once;
    let mut a = applier();
    frame(&mut a, &s, &full_delta(&s));
    s.seq += 1;
    s.viewports.get_mut(&5).unwrap().once_seq = 1;
    s.items.get_mut(&20).unwrap().xform = [1.0, 0.0, 0.0, 1.0, 3.0, 0.0];
    let d1 = TxDelta { seq: s.seq, items_upserted: vec![20], ..TxDelta::default() };
    apply_only(&mut a, &s, &d1);
    s.seq += 1;
    let f = frame(&mut a, &s, &empty(&s)).0;
    s.seq += 1;
    let r = frame(&mut a, &s, &empty(&s)).0;
    eprintln!("carried draw {f:?} then {r:?}");
    assert_eq!(f, vec![(5, true)]);
    assert!(r.is_empty());
}


#[test]
fn a_sampler_of_a_resized_once_surface_re_renders() {
    let mut s = feedback_scene();
    // 6 first in Godot's order (so 5 samples an earlier surface), and a once snapshot.
    s.viewports.get_mut(&6).unwrap().active_seq = 1;
    s.viewports.get_mut(&5).unwrap().active_seq = 2;
    s.viewports.get_mut(&6).unwrap().update = ViewportUpdate::Once;
    s.viewports.get_mut(&6).unwrap().once_seq = 1;
    let mut a = applier();
    let f1 = frame(&mut a, &s, &full_delta(&s));
    s.seq += 1;
    let f1b = frame(&mut a, &s, &empty(&s)).0;
    // 6 resizes without a new snapshot: its target is re-allocated (transparent).
    s.seq += 1;
    s.viewports.get_mut(&6).unwrap().size = [40, 20];
    let f2 = frame(&mut a, &s, &empty(&s));
    s.seq += 1;
    let f3 = frame(&mut a, &s, &empty(&s)).0;
    eprintln!("f1 {f1:?} f1b {f1b:?} f2 {f2:?} f3 {f3:?}");
    assert!(f2.1.contains(&6), "6 freed");
    assert!(f2.0.iter().chain(f3.iter()).any(|(v, _)| *v == 5), "5 re-renders without 6's old snapshot");
}

/// Viewport 5's item 20 under a custom-shader material whose code hash is `CODE`.
fn shader_surface_scene() -> ResolvedState {
    let mut s = scene();
    s.shaders.insert(
        41,
        Shader {
            id: 41,
            origin: Origin::Created,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            mode: Some(ShaderMode::CanvasItem),
            source: Some(ShaderSource::Payload),
            hash: Some(CODE),
            payload_bytes: 64,
            builtin: None,
            process: None,
            uses: Vec::new(),
            default_textures: Vec::new(),
        },
    );
    s.materials.insert(
        40,
        Material {
            id: 40,
            origin: Origin::Created,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            shader: Some(41),
            params: Vec::new(),
        },
    );
    s.items.get_mut(&20).unwrap().material = Some(40);
    s
}

const CODE: Hash = Hash([0x61; 32]);

#[test]
fn a_surface_item_on_a_linking_program_is_omitted_until_the_link_settles() {
    use super::programs::{ProgramEntry, ProgramInfo};
    let s = shader_surface_scene();
    let d = TxDelta {
        shaders_upserted: vec![41],
        materials_upserted: vec![40],
        ..full_delta(&s)
    };
    let mut store = PayloadStore::default();
    store.shaders.insert(
        CODE,
        "shader_type canvas_item;\nvoid fragment() {}\n".into(),
    );
    let mut a = applier();
    a.prepare(&s, &d);
    a.mark_linking(CODE);
    a.apply(&s, &d, &store);
    {
        let set = a.surfaces.as_ref().unwrap();
        let surface = set.applier(5).unwrap();
        assert!(
            surface.list.draws.is_empty(),
            "the surface drew a still-linking program's item (shaderless)"
        );
        assert!(
            surface
                .shortcut_totals
                .contains_key("shader-linking-skipped")
        );
    }
    a.list.consumed();
    a.surfaces.as_mut().unwrap().consumed();
    a.set_program(
        CODE,
        ProgramEntry::Ready(ProgramInfo {
            program: 1,
            blend: BlendMode::Mix,
            light: LightMode::Normal,
            uniforms: Vec::new(),
            samplers: Vec::new(),
            screen: None,
            vertex: false,
            time: false,
            alpha: None,
        }),
    );
    assert!(a.revisit(&s, &store), "the settled link was not revisited");
    let set = a.surfaces.as_ref().unwrap();
    let surface = set.applier(5).unwrap();
    assert!(
        surface
            .list
            .draws
            .iter()
            .any(|d| d.program != gsw_canvas_draw_list::BUILTIN_PROGRAM),
        "the surface item does not draw with its program after the settle"
    );
}

#[test]
fn deferred_cover_settles_early_only_for_a_sampled_surface() {
    for sampled in [true, false] {
        let mut s = scene();
        if !sampled {
            s.items.get_mut(&10).unwrap().commands = rect([0.0, 0.0, 4.0, 4.0]);
        }
        let mut a = applier();
        a.set_deferred_cover(true);
        a.apply(&s, &full_delta(&s), &PayloadStore::default());
        assert_eq!(a.cover_due(), !sampled);
        if sampled {
            let pass = a.surfaces.as_ref().unwrap().applier(5).unwrap();
            assert!(!pass.cover.deferred, "surface appliers stay eager");
            assert!(!pass.cover_due());
            assert!(pass.cover_recheck());
        }
        a.settle_cover();
        assert!(a.cover_recheck());
    }
}


fn tween_record(item: Id) -> crate::tweens::Record {
    use crate::tweens::*;
    Record {
        seq: 1,
        frame: 1,
        time: 0,
        poses: vec![Pose {
            item,
            kind: Kind::Node2d,
            values: [
                0., 0., 0., 1., 1., 0., 0., 0., 1., 1., 1., 1., 1., 1., 1., 1.,
            ],
        }],
        events: vec![Event::Begin(Begin {
            id: 1,
            item,
            order: 1,
            begin: 0,
            end: 1_000_000,
            steps: vec![Step {
                components: vec![0],
                start: 0,
                duration: 1_000_000,
                trans: 0,
                ease: 0,
                from: Some(vec![0.]),
                to: vec![10.],
            }],
        })],
    }
}

#[test]
fn regression_surface_tween_refreshes_between_host_transactions() {
    let s = scene();
    let store = PayloadStore::default();
    let mut a = applier();
    a.apply(&s, &full_delta(&s), &store);
    a.surfaces.as_mut().unwrap().consumed();
    a.tween_tick(&s, &store, 0., Some((0, &[tween_record(20)])));
    a.surfaces.as_mut().unwrap().consumed();
    let held = a
        .surfaces
        .as_ref()
        .unwrap()
        .applier(5)
        .unwrap()
        .paint_digest();
    a.tween_tick(&s, &store, 500_000., None);
    let set = a.surfaces.as_ref().unwrap();
    assert_ne!(set.applier(5).unwrap().paint_digest(), held);
    assert_eq!(set.passes().count(), 1);
    assert_eq!(set.applier(5).unwrap().paint_order()[0].1[4], 5.);
    a.surfaces.as_mut().unwrap().consumed();
    a.tween_tick(&s, &store, 1_000_000., None);
    assert_eq!(
        a.surfaces
            .as_ref()
            .unwrap()
            .applier(5)
            .unwrap()
            .paint_digest(),
        held
    );
}

#[test]
fn regression_root_only_tween_does_not_rerun_accumulating_surface() {
    let mut s = scene();
    s.viewports.get_mut(&5).unwrap().clear = ViewportClear::Never;
    let store = PayloadStore::default();
    let mut a = applier();
    a.apply(&s, &full_delta(&s), &store);
    a.surfaces.as_mut().unwrap().consumed();
    let serial = a.surfaces.as_ref().unwrap().applier(5).unwrap().walk_serial;
    a.tween_tick(&s, &store, 0., Some((0, &[tween_record(10)])));
    a.tween_tick(&s, &store, 500_000., None);
    let set = a.surfaces.as_ref().unwrap();
    assert_eq!(set.passes().count(), 0);
    assert_eq!(set.applier(5).unwrap().walk_serial, serial);
}

#[test]
fn regression_surface_tween_respects_once_and_disabled() {
    for update in [ViewportUpdate::Once, ViewportUpdate::Disabled] {
        let mut s = scene();
        s.viewports.get_mut(&5).unwrap().update = update;
        s.viewports.get_mut(&5).unwrap().once_seq = 1;
        let store = PayloadStore::default();
        let mut a = applier();
        a.apply(&s, &full_delta(&s), &store);
        a.surfaces.as_mut().unwrap().consumed();
        let held = a
            .surfaces
            .as_ref()
            .unwrap()
            .applier(5)
            .unwrap()
            .paint_digest();
        a.tween_tick(&s, &store, 0., Some((0, &[tween_record(20)])));
        a.tween_tick(&s, &store, 500_000., None);
        let set = a.surfaces.as_ref().unwrap();
        assert_eq!(set.passes().count(), 0);
        assert_eq!(set.applier(5).unwrap().paint_digest(), held);
    }
}
