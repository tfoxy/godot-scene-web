//! I4: a state holding a canvas group or a back-buffer copy walks only when a move or a
//! re-lowering reaches what a group's walk results read (`moves_reach_group`,
//! `relowering_reaches_group`). Every apply is checked against the oracle that walks and
//! re-assembles every time (`Applier::always_walk`) by what the packed list paints.

use super::*;
use crate::state::*;
use overrides::Refresh;

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

fn rect_cmds(r: [f32; 4], color: [f32; 4]) -> Commands {
    Commands {
        list: vec![Command::Rect {
            aa: false,
            rect: r,
            color,
        }],
        ..Commands::default()
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

const PANEL: Id = 10;
const OWNER: Id = 2;
const MASKED: Id = 3;
const COPY: Id = 5;
const MOVER: Id = 6;
const PULSE: Id = 7;
const LATE: Id = 8;
/// Plain items after the copy, re-lowered in place every tick (a lobby's animated labels).
const FILLERS: std::ops::Range<Id> = 100..140;

/// A lobby-shaped tree: a panel (10) holding a clip-only group (2) over a fill (3); an item that
/// moves (6) and one whose colour pulses (7) drawn before a rect-mode BackBufferCopy (5), then a
/// plain item (8) and a row of fillers.
fn lobby() -> ResolvedState {
    let mut panel = item(PANEL, ON_ROOT, rect_cmds([0.0, 0.0, 4.0, 4.0], [1.0; 4]));
    panel.children = vec![OWNER];
    let mut owner = item(
        OWNER,
        under(PANEL),
        rect_cmds([10.0, 4.0, 20.0, 10.0], [1.0; 4]),
    );
    owner.canvas_group = Some(CanvasGroup {
        mode: CanvasGroupMode::ClipOnly,
        clear_margin: 5.0,
        fit_empty: false,
        fit_margin: 0.0,
        blur_mipmaps: false,
    });
    owner.children = vec![MASKED];
    let masked = item(
        MASKED,
        under(OWNER),
        rect_cmds([8.0, 2.0, 18.0, 14.0], [0.5; 4]),
    );
    let mover = item(MOVER, ON_ROOT, rect_cmds([30.0, 2.0, 6.0, 6.0], [1.0; 4]));
    let pulse = item(PULSE, ON_ROOT, rect_cmds([30.0, 10.0, 6.0, 6.0], [1.0; 4]));
    let mut copy = item(COPY, ON_ROOT, Commands::default());
    copy.copy_to_backbuffer = Some([28.0, 0.0, 20.0, 20.0]);
    copy.draw_index = 50;
    let mut late = item(LATE, ON_ROOT, rect_cmds([40.0, 0.0, 4.0, 4.0], [1.0; 4]));
    late.draw_index = 60;
    let mut items = vec![panel, owner, masked, mover, pulse, copy, late];
    for id in FILLERS {
        let x = (id - FILLERS.start) as f32;
        items.push(item(id, ON_ROOT, rect_cmds([x, 24.0, 1.0, 4.0], [1.0; 4])));
    }
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
    items.sort_by_key(|it| it.draw_index);
    for it in items {
        if it.parent.map(|p| p.kind) == Some(ParentKind::Canvas) {
            c.items.push(it.id);
        }
        s.items.insert(it.id, it);
    }
    s.canvases.insert(1, c);
    s
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

fn full_delta(s: &ResolvedState) -> TxDelta {
    TxDelta {
        full: true,
        canvases_upserted: s.canvases.keys().copied().collect(),
        items_upserted: s.items.keys().copied().collect(),
        items_commands: s.items.keys().copied().collect(),
        ..TxDelta::default()
    }
}

/// One change of `id`'s transform (a translation by `dx`).
fn nudge(s: &mut ResolvedState, d: &mut TxDelta, id: Id, dx: f32) {
    s.items.get_mut(&id).unwrap().xform[4] += dx;
    d.items_upserted.push(id);
}

/// One content change of `id` keeping its shape: its rect's colour, or its rect when `rect`.
fn recolor(s: &mut ResolvedState, d: &mut TxDelta, id: Id, k: u32, rect: Option<[f32; 4]>) {
    let it = s.items.get_mut(&id).unwrap();
    let Command::Rect { rect: r, .. } = it.commands.list[0] else {
        unreachable!()
    };
    let shade = (k % 7) as f32 / 7.0;
    it.commands = rect_cmds(rect.unwrap_or(r), [shade, 1.0 - shade, 0.5, 1.0]);
    it.content_version += 1;
    d.items_upserted.push(id);
    d.items_commands.push(id);
}

/// An idle tick: the mover moves, the pulse and the fillers change colour (nothing near the group).
fn idle_tick(s: &mut ResolvedState, k: u32) -> TxDelta {
    let mut d = TxDelta::default();
    nudge(s, &mut d, MOVER, if k % 2 == 0 { 1.0 } else { -1.0 });
    recolor(s, &mut d, PULSE, k, None);
    for id in FILLERS {
        recolor(s, &mut d, id, k + id as u32, None);
    }
    d
}

/// Three appliers in lockstep: the scoped one, the pre-I4 rule and the walk-every-time oracle.
struct Trio {
    scoped: Applier,
    before: Applier,
    oracle: Applier,
    store: PayloadStore,
}

impl Trio {
    fn new(s: &ResolvedState) -> Trio {
        let mut t = Trio {
            scoped: Applier::new(viewport()),
            before: Applier::new(viewport()),
            oracle: Applier::new(viewport()),
            store: PayloadStore::default(),
        };
        t.before.back_buffer_always_walks = true;
        t.oracle.always_walk = true;
        t.apply(s, &full_delta(s));
        t
    }

    /// The scoped and pre-I4 stats; asserts all three paint the same.
    fn apply(&mut self, s: &ResolvedState, d: &TxDelta) -> (ApplyStats, ApplyStats) {
        let a = self.scoped.apply(s, d, &self.store).clone();
        let b = self.before.apply(s, d, &self.store).clone();
        self.oracle.apply(s, d, &self.store);
        let want = self.oracle.paint_digest();
        assert_eq!(self.scoped.paint_digest(), want, "scoped vs oracle: {a:?}");
        assert_eq!(self.before.paint_digest(), want, "pre-I4 vs oracle: {b:?}");
        for x in [&mut self.scoped, &mut self.before, &mut self.oracle] {
            x.list.consumed();
        }
        (a, b)
    }
}

#[test]
fn idle_ticks_beside_a_group_and_a_copy_walk_only_under_the_pre_i4_rule() {
    let mut s = lobby();
    let mut t = Trio::new(&s);
    assert_eq!(
        t.scoped.list.screen_ops.len(),
        2,
        "the group's copy and item 5's"
    );
    let (mut scoped_walks, mut before_walks) = (0, 0);
    const TICKS: u32 = 60;
    for k in 0..TICKS {
        let d = idle_tick(&mut s, k);
        let (a, b) = t.apply(&s, &d);
        // Before I4: every tick walked and assembled, with only the back-buffer bit set.
        assert!(b.structural);
        assert_eq!(b.why, Why::BACK_BUFFER);
        assert_eq!(b.back_buffer_items, 2);
        // Scoped: the move is rows-only and the re-lowerings are in place.
        assert!(!a.structural && !a.reassembled, "{a:?}");
        assert_eq!(a.why, 0);
        assert_eq!(a.relowered_in_place, 1 + FILLERS.len() as u32);
        assert_eq!(a.back_buffer_items, 2);
        scoped_walks += u32::from(a.structural);
        before_walks += u32::from(b.structural);
    }
    assert_eq!((scoped_walks, before_walks), (0, TICKS));
}

#[test]
fn an_empty_tick_does_nothing_even_beside_a_group() {
    let s = lobby();
    let mut t = Trio::new(&s);
    let (a, b) = t.apply(&s, &TxDelta::default());
    assert!(!a.structural && a.why == 0);
    assert_eq!(b.why, Why::BACK_BUFFER);
}

#[test]
fn what_a_group_reads_still_walks() {
    let mut s = lobby();
    let mut t = Trio::new(&s);
    let group_rect = |a: &Applier| a.list.screen_ops[0].region;
    let r0 = group_rect(&t.scoped);
    let walks = |t: &mut Trio, s: &ResolvedState, d: &TxDelta| {
        let (a, _) = t.apply(s, d);
        assert!(a.structural, "{a:?}");
        assert_eq!(a.why, Why::BACK_BUFFER, "{a:?}");
    };
    // A child of the owner moves: the group's rect follows it.
    let mut d = TxDelta::default();
    nudge(&mut s, &mut d, MASKED, 3.0);
    walks(&mut t, &s, &d);
    assert_ne!(group_rect(&t.scoped), r0);
    // The owner moves; the panel above it moves.
    let mut d = TxDelta::default();
    nudge(&mut s, &mut d, OWNER, 2.0);
    walks(&mut t, &s, &d);
    let mut d = TxDelta::default();
    nudge(&mut s, &mut d, PANEL, -2.0);
    walks(&mut t, &s, &d);
    // A child's rect changes (in place: same shape).
    let r1 = group_rect(&t.scoped);
    let mut d = TxDelta::default();
    recolor(&mut s, &mut d, MASKED, 1, Some([0.0, 0.0, 30.0, 20.0]));
    walks(&mut t, &s, &d);
    assert_ne!(group_rect(&t.scoped), r1);
    // The owner's own content changes, even with the same rect.
    let mut d = TxDelta::default();
    recolor(&mut s, &mut d, OWNER, 2, None);
    walks(&mut t, &s, &d);
    // A child's colour alone does not move the group: in place, no walk.
    let mut d = TxDelta::default();
    recolor(&mut s, &mut d, MASKED, 3, None);
    let (a, _) = t.apply(&s, &d);
    assert!(!a.structural && a.why == 0, "{a:?}");
    // The copy moves, or an item drawn before it changes its rect: the copy reads its own
    // untransformed rect and samples the target when it draws, so no walk.
    let mut d = TxDelta::default();
    nudge(&mut s, &mut d, COPY, 4.0);
    recolor(&mut s, &mut d, PULSE, 4, Some([31.0, 9.0, 6.0, 6.0]));
    let (a, _) = t.apply(&s, &d);
    assert!(!a.structural && a.why == 0, "{a:?}");
}

#[test]
fn a_moved_canvas_holding_a_group_walks() {
    let mut s = lobby();
    let mut t = Trio::new(&s);
    s.canvases.get_mut(&1).unwrap().xform[4] = 3.0;
    let d = TxDelta {
        canvases_upserted: vec![1],
        ..TxDelta::default()
    };
    let (a, _) = t.apply(&s, &d);
    assert!(a.structural);
    assert_eq!(a.why, Why::BACK_BUFFER);
}

#[test]
fn an_override_on_a_group_walks_and_one_beside_it_does_not() {
    let s = lobby();
    let mut t = Trio::new(&s);
    // A shifted, opaque, visible, unfrozen override (`OVERRIDE_FLOATS`).
    let shift = [1.0, 0.0, 0.0, 1.0, 2.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0];
    for (id, walked) in [(MOVER, false), (MASKED, true)] {
        for x in [&mut t.scoped, &mut t.before, &mut t.oracle] {
            x.set_overrides(&[id as u32], &shift).unwrap();
        }
        let st: Vec<Refresh> = [&mut t.scoped, &mut t.before, &mut t.oracle]
            .into_iter()
            .map(|x| x.refresh_overrides(&s, &t.store))
            .collect();
        assert_eq!(st[0] == Refresh::Walked, walked, "{id}: {:?}", st[0]);
        assert_eq!(st[1], Refresh::Walked);
        let want = t.oracle.paint_digest();
        assert_eq!(t.scoped.paint_digest(), want);
        assert_eq!(t.before.paint_digest(), want);
    }
}

/// Native micro-measure (`cargo test --release i4_idle -- --ignored --nocapture`): the idle tick's
/// apply under the scoped and the pre-I4 rule.
#[test]
#[ignore]
fn i4_idle_apply_cost() {
    for always in [true, false] {
        let mut s = lobby();
        let mut a = Applier::new(viewport());
        a.back_buffer_always_walks = always;
        let store = PayloadStore::default();
        a.apply(&s, &full_delta(&s), &store);
        let n = 20_000;
        let t0 = std::time::Instant::now();
        let mut walks = 0;
        for k in 0..n {
            let d = idle_tick(&mut s, k);
            walks += u32::from(a.apply(&s, &d, &store).structural);
            a.list.consumed();
        }
        let us = t0.elapsed().as_secs_f64() * 1e6 / n as f64;
        println!(
            "back_buffer_always_walks={always}: {us:.2} us/apply, {walks}/{n} structural, {} items",
            s.items.len()
        );
    }
}
