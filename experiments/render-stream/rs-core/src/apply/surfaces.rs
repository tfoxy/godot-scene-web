//! render-stream/16 viewport surfaces on the receiver (viewport-surfaces-design.md Q5a-c,
//! D10-D12): each non-root viewport the root's frame reaches is drawn by its own [`Applier`] into
//! its own list ([`gsw_canvas_draw_list::Target::surface`] = the viewport id), which an executor
//! renders into an offscreen target before the root's list; the root's draws (and other surfaces')
//! sample it through the [`gsw_canvas_draw_list::TextureOp::Surface`] alias its `viewport`
//! texture became.
//!
//! - **Rows per pass.** A surface applier holds only the items its `canvases` rows reach (a
//!   canvas shared with the root, or with another surface, has its items once per pass), walks
//!   those rows with the viewport's transforms, cull mask and default filter and repeat, and so
//!   gets its own walk, assembly and cover walk (a transparent target: the cover walk's
//!   alpha-one rule).
//! - **Closure.** Per apply, the surfaces reachable from the root's final draws (after the cover
//!   walk) through `viewport` textures, recursively through the surfaces rendered this frame. A
//!   surface never in the closure is never built, rendered or allocated.
//! - **Due rule** (Q5a, Godot's `renderer_viewport.cpp:740-830` on the receiver's frames):
//!   `always` and `when_visible` when in the closure; `once` (and a `disabled` viewport whose
//!   `once_seq` advanced: the host's dummy renderer never flips once to disabled, so a game that
//!   set `disabled` again before the snapshot drew is indistinguishable from one that did not)
//!   when `once_seq` advanced; `when_parent_visible` when its parent renders this frame. Not
//!   active, or 1 px or less on a side: not rendered.
//! - **Order** (D11): Godot's `_sort_active_viewports` over the active viewports in activation
//!   order (`active_seq`), children first, siblings in activation order; the root last. A surface
//!   sampling one later in the order samples its previous contents, as in Godot; one sampling
//!   itself samples transparent. Both are typed `viewport-feedback`. Neither loops: the closure is
//!   a visited set and the order a sort.
//! - **Skip.** A due surface whose clear mode is `always` (idempotent) is not re-rendered when its
//!   list, size, sampled textures and surfaces, and (for programs reading `TIME`) shader time are
//!   unchanged since its last render. Clear `never` / `next_frame` surfaces render every due frame
//!   and are approximate (Godot accumulates per host frame, a receiver per received frame): typed
//!   `viewport-accumulation`.
//! - **Lifetime.** A target is allocated by its first render, re-allocated by a size change
//!   (contents lost, as Godot's), and freed when its viewport is freed or deactivated, or grows
//!   past the executor's largest texture side (typed `viewport-too-large`; it then samples
//!   transparent, as one never rendered does).
//! - **`viewports: false`** (the core option, D3): the table is applied but no surface is built;
//!   every `viewport` texture samples transparent; `skipped_off` counts what would have run.
//!
//! Nothing here runs while the state holds no viewport (below /16 the table is always empty).

use super::geom::{self, Xform};
use super::payloads::PayloadStore;
use super::{Applier, ApplyShortcut, IdMap, Viewport};
use crate::state::{
    Filter, Id, Repeat, ResolvedState, TxDelta, ViewportClear, ViewportSurface, ViewportUpdate,
};
use gsw_canvas_draw_list::{DrawList, Format, DRAW_UNTEXTURED};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::hash::BuildHasherDefault;

pub(crate) type IdSet = HashSet<Id, BuildHasherDefault<crate::validate::IdHasher>>;

/// One `canvases` row of a viewport entry, as a surface applier walks it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SurfaceRow {
    pub canvas: Id,
    pub layer: i64,
    pub sublayer: i64,
    /// The canvas's transform on this viewport (before the viewport's global canvas transform).
    pub xform: Xform,
}

/// What makes an [`Applier`] a surface applier: the viewport it draws and the rows it walks.
#[derive(Debug)]
pub(crate) struct SurfaceView {
    /// The viewport id (its list's `Target::surface`).
    #[allow(dead_code)]
    pub id: Id,
    pub rows: Vec<SurfaceRow>,
    pub filter: Filter,
    pub repeat: Repeat,
    /// The items `rows`' canvases reach, as of the last apply.
    pub member: IdSet,
    /// The rows (or anything else the walk reads of the entry) changed since the last apply:
    /// re-compute the membership and walk.
    pub dirty: bool,
}

/// Per-apply surface counters (one frame), and the totals since the session began.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SurfaceStats {
    /// Surfaces with an applier.
    pub live: u32,
    /// Surfaces in this frame's closure.
    pub reached: u32,
    /// Surfaces due this frame (rendered, or skipped as unchanged).
    pub due: u32,
    /// Surfaces rendered (executed) this frame.
    pub rendered: u32,
    /// Due surfaces not re-rendered because nothing they draw changed.
    pub unchanged: u32,
    /// `surfacesSkipped`: surfaces the closure reached that the `viewports: false` option did not
    /// build.
    pub skipped_off: u32,
    /// Targets the executor holds after this frame, and their pixels.
    pub allocated: u32,
    pub allocated_pixels: u64,
    /// Targets freed this frame.
    pub freed: u32,
}

/// One surface's pass state.
struct Pass {
    applier: Box<Applier>,
    /// What the transactions since the applier last applied changed (it applies only when due).
    pending: Option<TxDelta>,
    /// The `once_seq` / `clear_seq` last honoured.
    once_seq: i64,
    clear_seq: i64,
    /// The size of the target the executor holds for it (None: none).
    allocated: Option<[u32; 2]>,
    /// The target holds a render since it was allocated.
    rendered: bool,
    /// The list's shader time at its last render (bits).
    time: u32,
    /// Something it samples (a surface, an image) changed since its last render: the skip rule
    /// may not keep it. Persists across frames it is not reached or not due.
    stale: bool,
}

/// The root applier's surface passes ([`Applier::surfaces`]).
#[derive(Default)]
pub struct SurfaceSet {
    passes: BTreeMap<Id, Pass>,
    /// The surface passes to execute at the next draw, in order: (viewport id, clear first).
    /// Several applies before one draw accumulate here (a pass ordered by an earlier apply is
    /// carried until `consumed`, its clear ORed with later ones).
    order: Vec<(Id, bool)>,
    /// Godot's order over every active viewport at the last apply (a restored context re-renders
    /// the live surfaces in it).
    last_order: Vec<Id>,
    /// Surfaces whose target the executor frees this frame.
    freed: Vec<u32>,
    pub stats: SurfaceStats,
}

impl SurfaceSet {
    /// This frame's passes, in execution order, with whether each clears first.
    pub fn passes(&self) -> impl Iterator<Item = (&DrawList, bool)> + '_ {
        self.order.iter().filter_map(|(id, clear)| {
            self.passes.get(id).map(|p| (&p.applier.list, *clear))
        })
    }

    /// The surfaces whose GL objects the executor frees this frame.
    pub fn freed(&self) -> &[u32] {
        &self.freed
    }

    /// The merged draw calls an executor issues for this frame's surface passes.
    pub fn expected_calls(&self) -> u32 {
        self.order
            .iter()
            .filter_map(|(id, _)| self.passes.get(id))
            .map(|p| p.applier.expected_calls())
            .sum()
    }

    /// The surface lists this frame executed were consumed (dirty ranges and texture operations
    /// forgotten); the frees reached the executor.
    pub fn consumed(&mut self) {
        for (id, _) in &self.order {
            if let Some(p) = self.passes.get_mut(id) {
                p.applier.list.consumed();
            }
        }
        self.order.clear();
        self.freed.clear();
    }

    /// A restored context: every surface's objects are gone. Their lists go again with
    /// `dirty.all`, and nothing is allocated or rendered until it renders again.
    /// Every surface that held a render is rendered again by the redraw, cleared, in the last
    /// Godot order (a static scene's surfaces and a `once` snapshot, from its current list, come
    /// back without a new transaction).
    pub fn context_restored(&mut self) {
        let mut live: Vec<Id> = Vec::new();
        for (id, p) in self.passes.iter_mut() {
            p.applier.list.dirty.all = true;
            p.applier.list.dirty.draws = true;
            p.stale = false;
            if p.allocated.is_some() {
                p.rendered = true;
                live.push(*id);
            } else {
                p.rendered = false;
            }
        }
        let mut order: Vec<(Id, bool)> = self
            .last_order
            .iter()
            .filter(|id| live.contains(id))
            .map(|id| (*id, true))
            .collect();
        // Live passes the last order does not name (none, normally) go last.
        for id in live {
            if !order.iter().any(|(o, _)| *o == id) {
                order.push((id, true));
            }
        }
        // A live pass sampling one later in the restore order holds a transparent copy of it
        // after this redraw (Godot's holds its previous contents): it renders again when next due.
        let position: BTreeMap<Id, usize> =
            order.iter().enumerate().map(|(k, (id, _))| (*id, k)).collect();
        let mut scratch = Vec::new();
        for (id, p) in self.passes.iter_mut() {
            let Some(&m) = position.get(id) else {
                continue;
            };
            sampled(&p.applier.list, &p.applier.surface_aliases, &mut scratch);
            if scratch.iter().any(|s| position.get(s).is_some_and(|k| *k > m)) {
                p.stale = true;
            }
        }
        self.order = order;
        self.freed.clear();
    }

    /// The surface's applier (diagnostics and tests).
    pub fn applier(&self, id: Id) -> Option<&Applier> {
        self.passes.get(&id).map(|p| &*p.applier)
    }

    /// The viewports with a pass.
    pub fn ids(&self) -> Vec<Id> {
        self.passes.keys().copied().collect()
    }

    /// Free the surface's target and GL objects; the pass stays, so its next render starts from
    /// a full list (the executor's objects are new) and is never skipped.
    fn free(&mut self, id: Id) {
        if let Some(p) = self.passes.get_mut(&id) {
            if p.allocated.take().is_some() {
                self.freed.push(id as u32);
                self.stats.freed += 1;
            }
            p.rendered = false;
            p.applier.list.dirty.all = true;
            p.applier.list.dirty.draws = true;
        }
        self.order.retain(|(o, _)| *o != id);
    }
}

/// The viewport ids `list`'s draws and bindings sample, through `aliases` (texture id to viewport
/// id), ascending and unique.
pub(crate) fn sampled(list: &DrawList, aliases: &IdMap<Id>, out: &mut Vec<Id>) {
    out.clear();
    if aliases.is_empty() {
        return;
    }
    for d in &list.draws {
        if d.flags & DRAW_UNTEXTURED == 0 && d.index_count > 0 {
            if let Some(v) = aliases.get(&(d.texture as Id)) {
                out.push(*v);
            }
        }
    }
    for b in &list.bindings {
        if b.program == 0 {
            continue;
        }
        for s in &b.samplers {
            if let Some(v) = aliases.get(&(s.texture as Id)) {
                out.push(*v);
            }
        }
    }
    out.sort_unstable();
    out.dedup();
}

/// Godot's `RendererViewport::_sort_active_viewports` (renderer_viewport.cpp), statement for
/// statement, over `active`: the active non-root viewports in activation order with their wire
/// `parent` (`Some(0)` the root, `None` out of the tree). The root viewport is the first active
/// viewport (activated at startup) and parentless. Viewports without a parent are the walk's
/// starting nodes; each node's children are prepended, scanning from the last activated, so
/// children come before parents and siblings keep activation order. A viewport the walk never
/// reaches (an inactive parent, or a parent chain that does not end, which the validator refuses
/// as `viewport-parent-cycle`) is not drawn, as in Godot. The root (0) is not in the result.
pub(crate) fn godot_order(active: &[(Id, Option<Id>)]) -> Vec<Id> {
    // Godot's active_viewports: the root first, then the rest in activation order. The root's
    // own parent is `None`.
    let all: Vec<(Id, Option<Id>)> = std::iter::once((0, None))
        .chain(active.iter().copied())
        .collect();
    let mut result: VecDeque<Id> = VecDeque::new();
    let mut nodes: VecDeque<Id> = VecDeque::new();
    for (id, parent) in all.iter().rev() {
        if parent.is_some() {
            continue;
        }
        nodes.push_back(*id);
        result.push_front(*id);
    }
    while let Some(node) = nodes.pop_front() {
        for (id, parent) in all.iter().rev() {
            if *parent != Some(node) {
                continue;
            }
            if !nodes.contains(id) && !result.contains(id) {
                nodes.push_back(*id);
                result.push_front(*id);
            }
        }
    }
    result.into_iter().filter(|id| *id != 0).collect()
}

/// The surface applier's viewport for entry `e`: its size, its clear (transparent: (0,0,0,0);
/// else the session's clear colour, `root_clear`), its global canvas transform and cull mask, and
/// Godot's format for it (transparent RGBA8, else RGB10_A2; HDR is typed `viewport-hdr-2d` by the
/// host and drawn as RGBA8).
fn surface_viewport(e: &ViewportSurface, root_clear: [f32; 4]) -> Viewport {
    Viewport {
        width: e.size[0].max(1) as u32,
        height: e.size[1].max(1) as u32,
        clear: if e.transparent { [0.0; 4] } else { root_clear },
        global_xform: e.global_xform,
        cull_mask: e.canvas_cull_mask,
        format: if e.transparent {
            Format::Rgba8
        } else {
            Format::Rgb10A2
        },
    }
}

fn rows_of(e: &ViewportSurface) -> Vec<SurfaceRow> {
    if e.disable_2d {
        // Godot draws no canvas of a viewport with 2D disabled (it still clears).
        return Vec::new();
    }
    e.canvases
        .iter()
        .zip(&e.canvas_xforms)
        .map(|(c, xf)| SurfaceRow {
            canvas: c.canvas,
            layer: c.layer,
            sublayer: c.sublayer,
            xform: *xf,
        })
        .collect()
}

impl Applier {
    /// A surface applier for viewport `e` under root `root` (its options and programs).
    fn new_surface(root: &Applier, e: &ViewportSurface) -> Applier {
        let vp = surface_viewport(e, root.viewport.clear);
        let mut a = Applier::new(vp);
        a.list.target.opaque = !e.transparent;
        a.list.target.surface = e.id as u32;
        a.surface = Some(Box::new(SurfaceView {
            id: e.id,
            rows: rows_of(e),
            filter: e.default_texture_filter,
            repeat: e.default_texture_repeat,
            member: IdSet::default(),
            dirty: true,
        }));
        a.inherit_options(root);
        a
    }

    /// The options a surface applier takes from the root, and its programs.
    fn inherit_options(&mut self, root: &Applier) {
        self.sabotage = root.sabotage;
        self.delivery = root.delivery.clone();
        self.stream_version = root.stream_version;
        self.half_instances = root.half_instances;
        self.cover_walk = root.cover_walk;
        self.cover.groups_off = root.cover.groups_off;
        self.cover.group_merge_off = root.cover.group_merge_off;
        self.cover.group_merge_check = root.cover.group_merge_check;
        // Diagnostics (`rs-core-check walk-diff`): an oracle root's surfaces walk every apply too.
        self.always_walk = root.always_walk;
        self.max_texture_side = root.max_texture_side;
        if self.programs_epoch != root.programs_epoch {
            self.programs = root.programs.clone();
            self.programs_epoch = root.programs_epoch;
            self.programs_dirty = true;
        }
        // J1: a program still linking omits its materials' draws in a surface as in the root
        // (`set_program` ends a link and moves the epoch, so the settle re-inherits both).
        if self.linking != root.linking {
            self.linking = root.linking.clone();
            self.programs_dirty = true;
        }
    }

    /// Bring a surface applier in line with entry `e`; a change of anything its walk reads
    /// re-walks at the next apply.
    fn configure_surface(&mut self, e: &ViewportSurface, root_clear: [f32; 4]) {
        let vp = surface_viewport(e, root_clear);
        let rows = rows_of(e);
        let Some(sv) = self.surface.as_mut() else {
            return;
        };
        let walk_changed = sv.rows != rows
            || sv.filter != e.default_texture_filter
            || sv.repeat != e.default_texture_repeat
            || self.viewport.width != vp.width
            || self.viewport.height != vp.height
            || self.viewport.cull_mask != vp.cull_mask
            || self.viewport.global_xform != vp.global_xform;
        if walk_changed {
            sv.rows = rows;
            sv.filter = e.default_texture_filter;
            sv.repeat = e.default_texture_repeat;
            sv.dirty = true;
        }
        self.viewport = vp;
        let t = &mut self.list.target;
        let before = *t;
        t.width = vp.width;
        t.height = vp.height;
        t.clear = vp.clear;
        t.format = vp.format;
        t.opaque = !e.transparent;
        if *t != before {
            // A new clear colour, format or blend contract redraws the pass.
            self.list.dirty.draws = true;
        }
    }

    /// render-stream/16: a surface applier's items for this apply (ascending): the upserted ones
    /// it holds or newly reaches, and the removed ones it held or no longer reaches. The
    /// membership is re-computed only when something it depends on changed (items, canvases,
    /// rows); `first`: every member is upserted.
    pub(super) fn surface_membership(
        &mut self,
        state: &ResolvedState,
        delta: &TxDelta,
    ) -> (Vec<Id>, Vec<Id>) {
        let first = self.first;
        let Some(sv) = self.surface.as_mut() else {
            return (Vec::new(), Vec::new());
        };
        let recompute = first
            || sv.dirty
            || !delta.items_upserted.is_empty()
            || !delta.items_removed.is_empty()
            || !delta.canvases_upserted.is_empty()
            || !delta.canvases_removed.is_empty();
        if !recompute {
            return (Vec::new(), Vec::new());
        }
        let mut member = IdSet::default();
        let mut stack: Vec<Id> = Vec::new();
        for r in &sv.rows {
            if let Some(c) = state.canvases.get(&r.canvas) {
                stack.extend(c.items.iter().copied());
            }
        }
        while let Some(id) = stack.pop() {
            if !member.insert(id) {
                continue;
            }
            if let Some(it) = state.items.get(&id) {
                stack.extend(it.children.iter().copied());
            }
        }
        let old = std::mem::replace(&mut sv.member, member);
        let new = &sv.member;
        let mut ups: Vec<Id> = if first {
            new.iter().copied().collect()
        } else {
            delta
                .items_upserted
                .iter()
                .copied()
                .filter(|id| new.contains(id))
                .chain(new.iter().copied().filter(|id| !old.contains(id)))
                .collect()
        };
        ups.sort_unstable();
        ups.dedup();
        let mut rems: Vec<Id> = delta
            .items_removed
            .iter()
            .copied()
            .filter(|id| old.contains(id))
            .chain(old.iter().copied().filter(|id| !new.contains(id)))
            .collect();
        rems.sort_unstable();
        rems.dedup();
        if std::mem::take(&mut sv.dirty) && !first {
            self.force_walk = true;
        }
        (ups, rems)
    }

    /// Whether item `id` is drawn by this applier: always on the root; on a surface applier, when
    /// its rows reach it.
    pub(super) fn is_member(&self, id: Id) -> bool {
        self.surface.as_ref().is_none_or(|sv| sv.member.contains(&id))
    }

    /// The transform canvas `canvas` draws with on this applier's viewport (the viewport's global
    /// canvas transform times the canvas's own: on the root, its attachment's; on a surface, its
    /// row's), None when the viewport does not draw it.
    pub(super) fn canvas_xform(&self, state: &ResolvedState, canvas: Id) -> Option<Xform> {
        match &self.surface {
            None => state
                .canvases
                .get(&canvas)
                .map(|c| geom::mul(&self.viewport.global_xform, &c.xform)),
            Some(sv) => sv
                .rows
                .iter()
                .find(|r| r.canvas == canvas)
                .map(|r| geom::mul(&self.viewport.global_xform, &r.xform)),
        }
    }

    /// The texture filter an item's `default` takes: the session's, or the surface viewport's.
    pub(super) fn default_filter(&self, state: &ResolvedState) -> Filter {
        self.surface
            .as_ref()
            .map_or(state.default_texture_filter, |sv| sv.filter)
    }

    pub(super) fn default_repeat(&self, state: &ResolvedState) -> Repeat {
        self.surface
            .as_ref()
            .map_or(state.default_texture_repeat, |sv| sv.repeat)
    }

    /// Whether this applier draws canvas `canvas` (on a surface: one of its rows).
    pub(super) fn draws_canvas(&self, canvas: Id) -> bool {
        self.surface
            .as_ref()
            .is_none_or(|sv| sv.rows.iter().any(|r| r.canvas == canvas))
    }

    /// Whether any of the list's live bindings runs a program whose code reads `TIME`.
    fn reads_time(&self) -> bool {
        self.list.bindings.iter().enumerate().any(|(slot, b)| {
            b.program != 0
                && self.binding_key(slot as u32).is_some_and(|k| {
                    matches!(
                        self.programs.get(&k.hash),
                        Some(super::programs::ProgramEntry::Ready(info)) if info.time
                    )
                })
        })
    }

    /// The root's surface passes for this apply (see the module note). Runs after the root's own
    /// apply and cover walk; nothing when the state holds no viewport and none is live.
    pub(super) fn apply_surfaces(
        &mut self,
        state: &ResolvedState,
        delta: &TxDelta,
        payloads: &PayloadStore,
    ) {
        if self.surface.is_some() || (state.viewports.is_empty() && self.surfaces.is_none()) {
            return;
        }
        let mut set = self.surfaces.take().unwrap_or_default();
        set.run(self, state, delta, payloads);
        if !(set.passes.is_empty() && set.freed.is_empty() && state.viewports.is_empty()) {
            self.surfaces = Some(set);
        }
    }
}

impl SurfaceSet {
    fn run(
        &mut self,
        root: &mut Applier,
        state: &ResolvedState,
        delta: &TxDelta,
        payloads: &PayloadStore,
    ) {
        self.stats = SurfaceStats::default();
        // Passes an earlier apply ordered that no draw has run yet: carried (must render).
        let mut carried: BTreeMap<Id, bool> = std::mem::take(&mut self.order).into_iter().collect();
        let max_side = root.max_texture_side;
        let rebuild = std::mem::take(&mut root.surfaces_rebuild);
        // Passes whose viewport is gone or inactive free their target and applier; a rebuild
        // (a payload that reached the store late) starts every applier afresh.
        let gone: Vec<Id> = self
            .passes
            .keys()
            .copied()
            .filter(|id| rebuild || state.viewports.get(id).is_none_or(|e| !e.active))
            .collect();
        for id in gone {
            self.free(id);
            self.passes.remove(&id);
            carried.remove(&id);
        }
        for p in self.passes.values_mut() {
            match &mut p.pending {
                Some(d) => d.merge(delta),
                None => p.pending = Some(delta.clone()),
            }
        }

        // The closure, and the due surfaces' lists.
        let mut queue: VecDeque<Id> = VecDeque::new();
        let mut scratch: Vec<Id> = Vec::new();
        sampled(&root.list, &root.surface_aliases, &mut scratch);
        queue.extend(scratch.iter().copied());
        let mut visited: HashSet<Id> = HashSet::new();
        let mut deferred: HashSet<Id> = HashSet::new();
        let mut due: Vec<Id> = Vec::new();
        let mut due_set: HashSet<Id> = HashSet::new();
        while let Some(v) = queue.pop_front() {
            if visited.contains(&v) {
                continue;
            }
            let Some(e) = state.viewports.get(&v) else {
                visited.insert(v);
                continue;
            };
            // when_parent_visible: the parent's decision first (once deferred; a parent the
            // closure never reaches does not render, so neither does this).
            if e.update == ViewportUpdate::WhenParentVisible {
                if let Some(p) = e.parent.filter(|p| *p != 0) {
                    if !visited.contains(&p) && !deferred.contains(&v) && queue.contains(&p) {
                        deferred.insert(v);
                        queue.push_back(v);
                        continue;
                    }
                }
            }
            visited.insert(v);
            self.stats.reached += 1;
            if !e.active || e.size[0] <= 1 || e.size[1] <= 1 {
                continue;
            }
            if !root.viewports_enabled {
                self.stats.skipped_off += 1;
                continue;
            }
            let (w, h) = (e.size[0] as u32, e.size[1] as u32);
            if max_side != 0 && (w > max_side || h > max_side) {
                root.note(ApplyShortcut::ViewportTooLarge.as_str(), 1);
                self.free(v);
                carried.remove(&v);
                continue;
            }
            let honoured_once = self.passes.get(&v).map_or(0, |p| p.once_seq);
            let is_due = match e.update {
                ViewportUpdate::Always | ViewportUpdate::WhenVisible => true,
                ViewportUpdate::Once | ViewportUpdate::Disabled => e.once_seq > honoured_once,
                ViewportUpdate::WhenParentVisible => match e.parent {
                    Some(0) => true,
                    Some(p) => due_set.contains(&p),
                    None => false,
                },
            };
            if !is_due {
                continue;
            }
            let pass = self.passes.entry(v).or_insert_with(|| Pass {
                applier: Box::new(Applier::new_surface(root, e)),
                pending: None,
                once_seq: 0,
                clear_seq: 0,
                allocated: None,
                rendered: false,
                time: 0,
                stale: false,
            });
            pass.applier.inherit_options(root);
            pass.applier.configure_surface(e, root.viewport.clear);
            let d = pass.pending.take().unwrap_or_else(|| delta.clone());
            pass.applier.apply(state, &d, payloads);
            // Its uploads and frees duplicate the root's (the root names every texture any item
            // draws): only the root's reach the executor.
            let l = &mut pass.applier.list;
            l.texture_ops.clear();
            l.texture_bytes.clear();
            l.texture_shared.clear();
            due.push(v);
            due_set.insert(v);
            sampled(&pass.applier.list, &pass.applier.surface_aliases, &mut scratch);
            queue.extend(scratch.iter().copied());
        }
        self.stats.due = due.len() as u32;

        // Godot's order over the active viewports (activation order: `active_seq`, then id).
        let mut active: Vec<(i64, Id, Option<Id>)> = state
            .viewports
            .values()
            .filter(|e| e.active)
            .map(|e| (e.active_seq, e.id, e.parent))
            .collect();
        active.sort_unstable();
        let pairs: Vec<(Id, Option<Id>)> = active.iter().map(|(_, id, p)| (*id, *p)).collect();
        self.last_order = godot_order(&pairs);
        carried.retain(|id, _| self.passes.get(id).is_some_and(|p| p.allocated.is_some()));
        let order: Vec<Id> = self
            .last_order
            .iter()
            .copied()
            .filter(|id| due_set.contains(id) || carried.contains_key(id))
            .collect();
        let placed = order.iter().filter(|id| due_set.contains(id)).count();
        if placed != due.len() {
            // A due surface the sort cannot place (an endless parent chain): typed, not drawn.
            root.note(ApplyShortcut::ViewportOrder.as_str(), (due.len() - placed) as u64);
        }
        // Texture ids the root's list re-defines this frame (what a surface samples may change).
        let changed_textures: IdSet = root
            .list
            .texture_ops
            .iter()
            .map(|op| op.id() as Id)
            .collect();
        let mut executed: IdSet = IdSet::default();
        for (k, &v) in order.iter().enumerate() {
            let e = &state.viewports[&v];
            let Some(pass) = self.passes.get_mut(&v) else {
                continue;
            };
            let carried_clear = carried.get(&v).copied();
            if !due_set.contains(&v) {
                // Carried from an earlier apply and not due now: rendered as that apply ordered.
                executed.insert(v);
                pass.stale = false;
                self.order.push((v, carried_clear.unwrap_or(true)));
                continue;
            }
            let a = &pass.applier;
            sampled(&a.list, &a.surface_aliases, &mut scratch);
            if scratch.iter().any(|s| *s == v || order[k + 1..].contains(s)) {
                root.note(ApplyShortcut::ViewportFeedback.as_str(), 1);
            }
            let size = [a.list.target.width, a.list.target.height];
            let clear = match e.clear {
                ViewportClear::Always => true,
                ViewportClear::Never => false,
                ViewportClear::NextFrame => e.clear_seq > pass.clear_seq,
            };
            if e.clear != ViewportClear::Always {
                root.note(ApplyShortcut::ViewportAccumulation.as_str(), 1);
            }
            let time = a.list.shader_time.to_bits();
            let inputs_changed = scratch.iter().any(|s| executed.contains(s) || self.freed.contains(&(*s as u32)))
                || a.list.draws.iter().any(|d| {
                    d.flags & DRAW_UNTEXTURED == 0 && changed_textures.contains(&(d.texture as Id))
                })
                || a.list
                    .bindings
                    .iter()
                    .any(|b| b.samplers.iter().any(|s| changed_textures.contains(&(s.texture as Id))));
            let unchanged = carried_clear.is_none()
                && !pass.stale
                && e.clear == ViewportClear::Always
                && pass.rendered
                && pass.allocated == Some(size)
                && a.list.dirty.is_clean()
                && !inputs_changed
                && (pass.time == time || !a.reads_time());
            pass.once_seq = pass.once_seq.max(e.once_seq);
            pass.clear_seq = pass.clear_seq.max(e.clear_seq);
            if unchanged {
                self.stats.unchanged += 1;
                continue;
            }
            // A re-allocated target starts transparent (WebGL zero-fills a new texture).
            if pass.allocated != Some(size) {
                pass.rendered = false;
            }
            pass.allocated = Some(size);
            pass.rendered = true;
            pass.time = time;
            pass.stale = false;
            executed.insert(v);
            self.order.push((v, clear || carried_clear.unwrap_or(false)));
        }
        // A surface not rendered this frame whose size changed lost its contents (Godot
        // re-allocates the render target at once): free it, so it samples transparent.
        let stale: Vec<Id> = self
            .passes
            .iter()
            .filter(|(id, p)| {
                !executed.contains(*id)
                    && p.allocated.is_some_and(|[w, h]| {
                        state
                            .viewports
                            .get(*id)
                            .is_none_or(|e| [e.size[0] as u32, e.size[1] as u32] != [w, h])
                    })
            })
            .map(|(id, _)| *id)
            .collect();
        for id in stale {
            self.free(id);
        }
        // Inputs that changed this run invalidate every pass that samples them, rendered or not:
        // one not rendered now (out of the closure, not due) renders when next due; one rendered
        // before a surface it samples rendered (later in the order: Godot's previous contents)
        // renders again next frame.
        let position: BTreeMap<Id, usize> = self
            .order
            .iter()
            .enumerate()
            .map(|(k, (id, _))| (*id, k))
            .collect();
        let freed_now: IdSet = self.freed.iter().map(|f| *f as Id).collect();
        for (id, p) in self.passes.iter_mut() {
            let a = &p.applier;
            sampled(&a.list, &a.surface_aliases, &mut scratch);
            let mine = position.get(id).copied();
            let surface_changed = scratch.iter().any(|s| match (mine, position.get(s)) {
                // itself binds transparent (stable); a later surface's new contents are seen
                // only by its next render
                (Some(m), Some(k)) => *k > m,
                (None, Some(_)) => true,
                _ => freed_now.contains(s),
            });
            let texture_changed = mine.is_none()
                && (a.list.draws.iter().any(|d| {
                    d.flags & DRAW_UNTEXTURED == 0 && changed_textures.contains(&(d.texture as Id))
                }) || a.list.bindings.iter().any(|b| {
                    b.samplers
                        .iter()
                        .any(|s| changed_textures.contains(&(s.texture as Id)))
                }));
            if surface_changed || texture_changed {
                p.stale = true;
            }
        }
        self.stats.rendered = self.order.len() as u32;
        self.stats.live = self.passes.len() as u32;
        for p in self.passes.values() {
            if let Some([w, h]) = p.allocated {
                self.stats.allocated += 1;
                self.stats.allocated_pixels += u64::from(w) * u64::from(h);
            }
        }
    }
}
