//! TAG2 (client-extensions-design.md §3.2): the client's override table in the applier, and the
//! read-only queries extensions make of the resolved state.
//!
//! An override is pre-multiplied in presentation space and inherited by the subtree:
//! `final_xf' = O · (parent_xf' · it.xform)`, composed in `cull` and in the rows-only path's
//! `move_rec`. Because every override is a left factor in presentation space, an item's drawn
//! transform is `E · F`, with `F` the game's transform and `E = O_n · … · O_1` the overrides of
//! the item and its ancestors, nearest first. The queries read the game's state (`F`), never `E`.
//!
//! With an empty table the applier does no per-item work: `walk` and `move_subtree` pick the
//! `OV = false` instance of `cull` / `move_rec`, which is the code before TAG2.

use super::geom::{self, Rect, Xform};
use super::{Applier, IdMap, Why};
use crate::apply::payloads::PayloadStore;
use crate::state::{Id, ParentKind, ResolvedState, TxDelta};

/// Floats per item in [`Applier::set_overrides`]' packed table: 6 affine (Godot's column order:
/// x axis, y axis, origin), 4 modulate, 1 visible (0 hides the subtree), 1 frozen (FRZ-HOOK: hold
/// the subtree's records across transactions).
pub const OVERRIDE_FLOATS: usize = 12;

/// One item's override.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Override {
    pub xform: Xform,
    pub modulate: [f32; 4],
    pub visible: bool,
    /// FRZ-HOOK (frz-d.md §5): hold the subtree. `apply` keeps the records of items whose nearest
    /// frozen ancestor has this flag, skipping their upserts and removals.
    pub frozen: bool,
}

/// TAG2 sabotages (each must fail its check).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OverrideSabotage {
    /// `override-no-inherit`: the override reaches the item's own row only (`write_row`'s
    /// composition): its children, cull and clip stay where the game put them.
    pub no_inherit: bool,
    /// `override-no-damage`: an override applied outside a transaction (the redraw path) rewrites
    /// the rows without marking them dirty, so the executor draws the rows it already holds.
    pub no_damage: bool,
    /// `override-fast-path-miss`: the rows-only path of a transaction (`move_rec`) ignores the
    /// table, so a transform-only frame under an override draws the game's transform.
    pub fast_path_miss: bool,
    /// INP1 `inverse-skip`: [`Applier::to_game`] returns the hit item with the point unmapped
    /// (the inverse of the item's effective override is never applied).
    pub inverse_skip: bool,
    /// FRZ-HOOK `frozen-still-applies`: a frozen item's upsert still applies (only the removal is
    /// skipped), so the freeze-then-apply shot changes. Fails the freeze-then-apply check.
    pub frozen_still_applies: bool,
    /// FRZ-HOOK `frozen-sweeps`: [`Applier::referenced_payload_hashes`] omits the frozen
    /// subtree's payloads, so the retention sweep drops them. Fails the retention check.
    pub frozen_sweeps: bool,
}

/// What [`Applier::refresh_overrides`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refresh {
    /// The table had not changed since it was last composed.
    Clean,
    /// A transaction is accepted and not applied yet: its apply composes the table.
    Deferred,
    /// The changed subtrees' rows were rewritten (`move_subtree`).
    Moved,
    /// A visibility change (or a move the rows cannot follow) re-walked and re-assembled.
    Walked,
}

/// The game's view of one item ([`Applier::query_item`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ItemFacts {
    pub parent: Option<Id>,
    /// Effective visibility: the item and its ancestors visible, in the cull mask, on an
    /// attached canvas.
    pub visible: bool,
    /// The draw transform (`final_xform`, or the canvas's under `use_identity_transform`).
    pub xform: Option<Xform>,
    /// The global AABB of the item's own lowered commands under `xform`, presentation px.
    pub rect: Option<Rect>,
}

impl Applier {
    /// Replace the override table with `ids` and their [`OVERRIDE_FLOATS`] values each. Ids not
    /// listed have no override. The changed ids are recorded and composed at the next apply or
    /// [`Applier::refresh_overrides`], whichever comes first.
    pub fn set_overrides(&mut self, ids: &[u32], vals: &[f32]) -> Result<(), String> {
        if vals.len() != ids.len() * OVERRIDE_FLOATS {
            return Err(format!(
                "override-table: {} ids need {} floats, got {}",
                ids.len(),
                ids.len() * OVERRIDE_FLOATS,
                vals.len()
            ));
        }
        let mut next: IdMap<Override> = IdMap::default();
        next.reserve(ids.len());
        for (k, &id) in ids.iter().enumerate() {
            let v = &vals[k * OVERRIDE_FLOATS..(k + 1) * OVERRIDE_FLOATS];
            if v.iter().any(|f| !f.is_finite()) {
                return Err(format!("override-table: item {id} has a non-finite value"));
            }
            let o = Override {
                xform: [v[0], v[1], v[2], v[3], v[4], v[5]],
                modulate: [v[6], v[7], v[8], v[9]],
                visible: v[10] != 0.0,
                frozen: v[11] != 0.0,
            };
            if next.insert(id, o).is_some() {
                return Err(format!("override-table: item {id} is listed twice"));
            }
        }
        for (id, o) in &next {
            match self.overrides.get(id) {
                Some(old) if old == o => {}
                Some(old) => {
                    self.ov_walk |= old.visible != o.visible;
                    self.ov_changed.push(*id);
                    if old.frozen != o.frozen {
                        self.frozen_dirty = true;
                        if old.frozen && !o.frozen {
                            self.unfrozen.push(*id);
                        }
                    }
                }
                None => {
                    self.ov_walk |= !o.visible;
                    self.ov_changed.push(*id);
                    if o.frozen {
                        self.frozen_dirty = true;
                    }
                }
            }
        }
        for (id, old) in &self.overrides {
            if !next.contains_key(id) {
                self.ov_walk |= !old.visible;
                self.ov_changed.push(*id);
                if old.frozen {
                    self.frozen_dirty = true;
                    self.unfrozen.push(*id);
                }
            }
        }
        // A table going from empty to set (or back) changes which `cull` instance walks; the
        // rows-only path below handles it, since `move_subtree` composes from the parent's record.
        self.overrides = next;
        Ok(())
    }

    /// The table as it was last set.
    pub fn overrides(&self) -> impl Iterator<Item = (Id, &Override)> + '_ {
        self.overrides.iter().map(|(id, o)| (*id, o))
    }

    /// Whether the table changed since it was last composed.
    pub fn overrides_dirty(&self) -> bool {
        !self.ov_changed.is_empty() || self.ov_walk
    }

    /// The redraw path (§3.2 "Redraw"): compose a changed table now, with no transaction. The
    /// changed subtrees' rows are recomputed (`move_subtree`) and marked dirty; a visibility
    /// change, a clip in a moved subtree or a canvas group walks and re-assembles. While a
    /// transaction is accepted and not applied, nothing is done: that apply composes the table.
    pub fn refresh_overrides(&mut self, state: &ResolvedState, payloads: &PayloadStore) -> Refresh {
        if !self.overrides_dirty() {
            return Refresh::Clean;
        }
        if self.prepared || self.first {
            return Refresh::Deferred;
        }
        let changed = std::mem::take(&mut self.ov_changed);
        let mut walk = std::mem::take(&mut self.ov_walk)
            || self.always_walk
            || !self.back_buffer_items.is_empty();
        let saved_dirty = self
            .ov_sabotage
            .no_damage
            .then(|| self.list.dirty.items.clone());
        if !walk {
            self.move_attach = false;
            for id in changed {
                if !self.move_subtree(state, id) {
                    walk = true;
                    break;
                }
            }
        }
        let result = if walk {
            self.stats.why |= Why::OVERRIDE;
            self.walk(state);
            self.assemble(state);
            self.refresh_bindings(state, &TxDelta::default(), &[]);
            self.write_instances(state, payloads);
            self.expected_calls = Some(self.list.merged_draw_count() as u32);
            Refresh::Walked
        } else {
            if std::mem::take(&mut self.move_attach) {
                self.assemble(state);
                self.write_instances(state, payloads);
                self.expected_calls = Some(self.list.merged_draw_count() as u32);
            }
            Refresh::Moved
        };
        if let Some(saved) = saved_dirty {
            self.list.dirty.items = saved;
        }
        self.coalesce_dirty();
        result
    }

    /// The expected executed calls of the list as last assembled (a refresh may re-assemble).
    pub fn expected_calls(&self) -> u32 {
        self.expected_calls.unwrap_or(0)
    }

    /// TAG2 `onItemsRemoved`: the ids every apply removes are logged while this is on.
    pub fn log_removed(&mut self, on: bool) {
        self.removed_log = on.then(Vec::new);
    }

    /// The ids removed since the last call (empty unless [`Applier::log_removed`]).
    pub fn take_removed(&mut self) -> Vec<Id> {
        self.removed_log.as_mut().map(std::mem::take).unwrap_or_default()
    }

    /// TAG2: a fresh applier (a coding resync's rebuild) keeps the session's table and log.
    pub fn inherit_overrides(&mut self, old: &mut Applier) {
        self.overrides = std::mem::take(&mut old.overrides);
        self.removed_log = old.removed_log.take();
        self.ov_sabotage = old.ov_sabotage;
        // FRZ-HOOK: the frozen membership and any pending unfreeze follow the table. The fresh
        // applier's first apply re-syncs when `frozen_dirty` is set.
        self.frozen = std::mem::take(&mut old.frozen);
        self.frozen_dirty = old.frozen_dirty;
        self.unfrozen = std::mem::take(&mut old.unfrozen);
        self.reconcile_frozen = old.reconcile_frozen;
    }

    /// FRZ-HOOK (frz-d.md §5): recompute the frozen membership (every item under a frozen root)
    /// when the table's `frozen` flags changed, and mark a full item reconcile when a root was
    /// unfrozen. Called once at the top of `apply`; `set_overrides` (which has no state) only
    /// records the change. The membership persists across applies, so a frozen subtree whose root
    /// has since left the state stays held until it is unfrozen.
    pub fn sync_frozen(&mut self, state: &ResolvedState) {
        let unfreeze = !std::mem::take(&mut self.unfrozen).is_empty();
        if !self.frozen_dirty && !unfreeze {
            return;
        }
        self.frozen_dirty = false;
        self.frozen.clear();
        for (root, o) in &self.overrides {
            if !o.frozen {
                continue;
            }
            let mut stack = vec![*root];
            while let Some(cur) = stack.pop() {
                if !self.frozen.insert(cur) {
                    continue;
                }
                if let Some(it) = state.items.get(&cur) {
                    stack.extend(it.children.iter().copied());
                }
            }
        }
        self.reconcile_frozen |= unfreeze;
    }

    /// FRZ-HOOK: the texture and mesh ids the held (frozen) records still draw from, so the
    /// retention sweep keeps their payloads (they stay resident).
    pub fn frozen_resources(
        &self,
    ) -> (std::collections::HashSet<Id>, std::collections::HashSet<Id>) {
        let mut tex = std::collections::HashSet::new();
        let mut mesh = std::collections::HashSet::new();
        if self.frozen.is_empty() {
            return (tex, mesh);
        }
        for (id, rec) in &self.items {
            if !self.frozen.contains(id) {
                continue;
            }
            tex.extend(rec.tex_sizes.iter().map(|(t, _)| *t));
            mesh.extend(rec.mesh_versions.iter().map(|(m, _)| *m));
        }
        (tex, mesh)
    }

    // ------------------------------------------------------------------------- queries

    /// The game's transform chain of `id`: `(final_xform, draw_xform)` with no override, from the
    /// resolved state (the canvas transform times every ancestor's transform).
    fn game_xforms(&self, state: &ResolvedState, id: Id) -> Option<(Xform, Xform, bool)> {
        let mut chain: Vec<Id> = Vec::new();
        let mut cur = id;
        let mut visible = true;
        let canvas = loop {
            let it = state.items.get(&cur)?;
            visible &= it.visible && it.visibility_layer & self.viewport.cull_mask != 0;
            chain.push(cur);
            let p = it.parent?;
            match p.kind {
                ParentKind::Item => cur = p.id,
                _ => break state.canvases.get(&p.id)?,
            }
            if chain.len() > state.items.len() {
                return None;
            }
        };
        visible &= canvas.attached;
        let canvas_xf = geom::mul(&self.viewport.global_xform, &canvas.xform);
        let mut xf = canvas_xf;
        for k in chain.iter().rev() {
            xf = geom::mul(&xf, &state.items[k].xform);
        }
        let it = &state.items[&id];
        let draw = if it.use_identity_transform && !self.sabotage.ignore_identity_transform {
            canvas_xf
        } else {
            xf
        };
        Some((xf, draw, visible))
    }

    /// The game's facts of item `id` (none of the table's overrides), or None when the state
    /// holds no such item.
    pub fn query_item(&self, state: &ResolvedState, id: Id) -> Option<ItemFacts> {
        let it = state.items.get(&id)?;
        let parent = it
            .parent
            .filter(|p| p.kind == ParentKind::Item)
            .map(|p| p.id);
        let chain = self.game_xforms(state, id);
        let rect = chain.and_then(|(_, draw, _)| self.own_rect(id, &draw));
        Some(ItemFacts {
            parent,
            visible: chain.is_some_and(|c| c.2),
            xform: chain.map(|c| c.1),
            rect,
        })
    }

    fn own_rect(&self, id: Id, draw: &Xform) -> Option<Rect> {
        let rec = self.items.get(&id)?;
        if rec.lowered.draws.is_empty() {
            return None;
        }
        Some(geom::xform_rect(draw, &rec.lowered.rect))
    }

    /// The union of the game's own-command rects of `id` and its visible descendants.
    pub fn query_subtree_rect(&self, state: &ResolvedState, id: Id) -> Option<Rect> {
        let (final_xf, draw, _) = self.game_xforms(state, id)?;
        let mut out: Option<Rect> = None;
        let mut stack: Vec<(Id, Xform, Xform)> = vec![(id, final_xf, draw)];
        while let Some((cur, fx, dx)) = stack.pop() {
            if let Some(r) = self.own_rect(cur, &dx) {
                out = Some(out.map_or(r, |o| geom::merge(&o, &r)));
            }
            let Some(it) = state.items.get(&cur) else {
                continue;
            };
            for c in &it.children {
                let Some(ci) = state.items.get(c) else {
                    continue;
                };
                if !ci.visible {
                    continue;
                }
                let cf = geom::mul(&fx, &ci.xform);
                let cd = if ci.use_identity_transform && !self.sabotage.ignore_identity_transform {
                    let canvas = self.items.get(c).map(|r| r.canvas);
                    canvas
                        .and_then(|k| state.canvases.get(&k))
                        .map_or(self.viewport.global_xform, |cv| {
                            geom::mul(&self.viewport.global_xform, &cv.xform)
                        })
                } else {
                    cf
                };
                stack.push((*c, cf, cd));
            }
        }
        out
    }

    /// The children of `id` in the state's order.
    pub fn query_children(&self, state: &ResolvedState, id: Id) -> Vec<Id> {
        state
            .items
            .get(&id)
            .map(|it| it.children.clone())
            .unwrap_or_default()
    }

    // ------------------------------------------------------------------------- INP1: pointer

    /// INP1: the topmost drawn item under the presentation-space point `(x, y)`, in the last
    /// walk's draw order (the attach list, walked backwards). An entry counts when it emits, the
    /// point is inside its scissor, and inside its content rect under its *drawn* transform
    /// (overrides included; a rotated or sheared item is tested in its own space, not by its
    /// AABB). Nothing is computed per frame: this reads the records the walk and the rows-only
    /// path already keep.
    pub fn hit_test(&self, x: f32, y: f32) -> Option<Id> {
        for a in self.attach.iter().rev() {
            if !a.emit || a.parked {
                continue;
            }
            if let Some(s) = a.scissor {
                let (sx, sy) = (s[0] as f32, s[1] as f32);
                if x < sx || y < sy || x >= sx + s[2] as f32 || y >= sy + s[3] as f32 {
                    continue;
                }
            }
            let Some(rec) = self.items.get(&a.item) else {
                continue;
            };
            if rec.lowered.draws.is_empty() {
                continue;
            }
            let xf = rec.draw_xform;
            let det = xf[0] * xf[3] - xf[1] * xf[2];
            if det == 0.0 || !det.is_finite() {
                continue;
            }
            let [lx, ly] = geom::xform_point(&geom::affine_inverse(&xf), [x, y]);
            let [rx, ry, rw, rh] = rec.lowered.rect;
            if lx >= rx && ly >= ry && lx < rx + rw && ly < ry + rh {
                return Some(a.item);
            }
        }
        None
    }

    /// INP1: the game-space point for a drawn point. The hit item (see [`Applier::hit_test`])
    /// was drawn at `E · F`, with `F` the game's transform and `E` the composed override of the
    /// item and its ancestors (nearest first, the order `cull` composes); the point the game
    /// sees is `E⁻¹ · p`. Returns the hit item and that point, or `(None, p)` when no item is
    /// drawn there (nothing overrides bare clear colour), or `None` for a singular `E`.
    pub fn to_game(&self, state: &ResolvedState, x: f32, y: f32) -> Option<(Option<Id>, [f32; 2])> {
        let p = [x, y];
        let Some(hit) = self.hit_test(x, y) else {
            return Some((None, p));
        };
        if self.overrides.is_empty() || self.ov_sabotage.inverse_skip {
            return Some((Some(hit), p));
        }
        // An item drawn under `use_identity_transform` ignores its ancestors' transforms, and so
        // their overrides.
        if state
            .items
            .get(&hit)
            .is_some_and(|it| it.use_identity_transform)
        {
            return Some((Some(hit), p));
        }
        let mut e = geom::IDENTITY;
        let mut cur = Some(hit);
        let mut guard = state.items.len() + 1;
        while let Some(id) = cur {
            if let Some(o) = self.overrides.get(&id) {
                e = geom::mul(&e, &o.xform);
            }
            cur = state
                .items
                .get(&id)
                .and_then(|it| it.parent)
                .filter(|p| p.kind == ParentKind::Item)
                .map(|p| p.id);
            guard -= 1;
            if guard == 0 {
                break;
            }
        }
        let det = e[0] * e[3] - e[1] * e[2];
        if det == 0.0 || !det.is_finite() {
            return None;
        }
        Some((Some(hit), geom::xform_point(&geom::affine_inverse(&e), p)))
    }
}
