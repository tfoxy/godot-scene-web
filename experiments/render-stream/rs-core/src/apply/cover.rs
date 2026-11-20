//! The applier's side of the cover walk (`gsw_canvas_draw_list::cover`): after every apply the
//! assembled draw table is walked back to front and the list the executor reads holds only what
//! can still change a pixel. The assembled table is kept beside it, so a transaction that moves
//! rows only (a cover drifting by a fraction of a pixel, a modulate fading) walks again without
//! re-assembling.
//!
//! The walk reads the frame's final rows, vertices and instances, the uploaded textures' opaque
//! texels ([`super::residency::Resident::opacity`]) and each binding's program (whether it samples
//! the screen, has its own vertex stage, or ends on an alpha that is a uniform's multiple, which
//! with the binding's value 0 makes its draws no-ops, or a zero alpha proven from the current
//! binding's uniform values and sampler formats). Nothing on the wire or in the state
//! changes.
//!
//! On the list the walk leaves, the tile half (`gsw_canvas_draw_list::cover::tiles`) then writes
//! the root list's depth tables (`DrawList::depth_tiles`, `DrawList::depth_draws`): where a later
//! draw overwrites only part of an earlier one, the executor depth-tests the earlier one there.
//! Viewport surface lists get none (their executor targets have no depth buffer).

use super::programs::ProgramEntry;
use super::{residency, Applier, IdMap};
use gsw_canvas_draw_list::cover::{CoverFacts, ProgramFacts};
use gsw_canvas_draw_list::opacity::Opacity;
use gsw_canvas_draw_list::{Draw, DrawList, InstancedDraw, ScreenOp};

/// One draw table: draws, screen operations, instanced ranges.
#[derive(Default)]
pub(super) struct Table {
    draws: Vec<Draw>,
    ops: Vec<ScreenOp>,
    instanced: Vec<InstancedDraw>,
}

fn swap_table(list: &mut DrawList, t: &mut Table) {
    std::mem::swap(&mut list.draws, &mut t.draws);
    std::mem::swap(&mut list.screen_ops, &mut t.ops);
    std::mem::swap(&mut list.instanced, &mut t.instanced);
}

fn same_table(list: &DrawList, t: &Table) -> bool {
    list.draws == t.draws && list.screen_ops == t.ops && list.instanced == t.instanced
}

// Match the whole-list diagnostic contract without allocating its potentially large Debug string.
fn group_check_digest(list: &DrawList) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    struct Writer(Sha256);
    impl std::fmt::Write for Writer {
        fn write_str(&mut self, value: &str) -> std::fmt::Result {
            self.0.update(value.as_bytes());
            Ok(())
        }
    }
    let mut writer = Writer(Sha256::new());
    std::fmt::Write::write_fmt(&mut writer, format_args!("{list:?}")).unwrap();
    writer.0.finalize().into()
}

/// The cover walk's state between applies.
#[derive(Default)]
pub(super) struct CoverState {
    /// Boxed (made on first use): [`Applier::cull_covered`] takes it out of the applier for
    /// every walk.
    walk: Option<Box<gsw_canvas_draw_list::cover::CoverWalk>>,
    /// The assembled table while the list holds the culled one (`culled`).
    full: Table,
    /// The table the executor last saw, while `shown_valid` (it differed from the full table).
    shown: Table,
    culled: bool,
    shown_valid: bool,
    /// The tile half (boxed, made on first use), and whether it runs (default on).
    tiles: Option<Box<gsw_canvas_draw_list::cover::tiles::TileWalk>>,
    tiles_off: bool,
    pub(super) alpha_ranges: super::programs::alpha_range::Cache,
    pub(super) alpha_zero: Vec<bool>,
    pub(super) groups: gsw_canvas_draw_list::cover::groups::GroupWalk,
    pub(super) group_ranges: Vec<gsw_canvas_draw_list::cover::groups::GroupRange>,
    pub(super) groups_off: bool,
    pub(super) group_merge_off: bool,
    pub(super) group_merge_check: bool,
    /// Diagnostic input table, before either group optimization, for the next restore.
    group_restore_check: Option<Table>,
}

struct Facts<'a> {
    resident: &'a IdMap<residency::Resident>,
    applier: &'a Applier,
}

impl CoverFacts for Facts<'_> {
    fn opacity(&self, texture: u32) -> Option<&Opacity> {
        self.resident.get(&texture)?.opacity.as_deref()
    }

    fn program(&self, slot: u32) -> ProgramFacts {
        let Some(key) = self.applier.binding_key(slot) else {
            return ProgramFacts::UNKNOWN;
        };
        match self.applier.programs.get(&key.hash) {
            Some(ProgramEntry::Ready(info)) => ProgramFacts {
                reads_screen: info.screen.is_some(),
                vertex_stage: info.vertex,
                alpha: info.alpha,
            },
            _ => ProgramFacts::UNKNOWN,
        }
    }

    fn alpha_zero(&self, slot: u32) -> bool {
        self.applier
            .cover
            .alpha_zero
            .get(slot as usize)
            .copied()
            .unwrap_or(false)
    }

    fn max_texture_side(&self) -> u32 {
        self.applier.max_texture_side
    }
}

impl Applier {
    /// Before `assemble` rebuilds the table: the list takes back the assembled table it was culled
    /// from (so the assembly marks the table dirty only when the assembled table changed), and the
    /// culled one is kept as what the executor last saw.
    pub(super) fn cover_unswap(&mut self) {
        let c = &mut self.cover;
        c.groups.restore(&mut self.list);
        if let Some(expected) = c.group_restore_check.take() {
            assert!(
                same_table(&self.list, &expected),
                "group restore changed the next apply's input"
            );
        }
        if c.culled {
            swap_table(&mut self.list, &mut c.full);
            std::mem::swap(&mut c.full, &mut c.shown);
            c.culled = false;
            c.shown_valid = true;
        }
    }

    /// After the apply wrote its rows and instances: walks the assembled table and leaves the list
    /// holding what can change a pixel ([`Applier::cover_walk`] off: the whole table). Marks the
    /// draw table dirty when what the executor reads changed; returns whether it did.
    pub(super) fn cull_covered(&mut self) -> bool {
        self.cover_unswap();
        let mut groups = std::mem::take(&mut self.cover.groups);
        let facts = Facts {
            resident: &self.resident,
            applier: self,
        };
        groups.prepare(
            &self.list,
            &self.cover.group_ranges,
            &facts,
            self.cover_walk && !self.cover.groups_off,
        );
        self.cover.groups = groups;
        let mut walk = self.cover.walk.take().unwrap_or_default();
        let dropped = if self.cover_walk {
            let facts = Facts {
                resident: &self.resident,
                applier: self,
            };
            walk.run(&self.list, &facts)
        } else {
            // What the walk remembers holds only while it sees every change.
            walk.forget();
            false
        };
        let c = &mut self.cover;
        self.stats.covered_draws = 0;
        self.stats.covered_ops = 0;
        self.stats.noop_draws = 0;
        self.stats.covers = walk.covers;
        if dropped && walk.reused && c.shown_valid {
            // The walk kept its last answer over the same table, so the table the executor last
            // saw is the one a compaction would make: the list takes it back.
            swap_table(&mut self.list, &mut c.full);
            swap_table(&mut self.list, &mut c.shown);
            c.culled = true;
            c.shown_valid = false;
            self.stats.covered_draws = walk.dropped_draws;
            self.stats.covered_ops = walk.dropped_ops;
            self.stats.noop_draws = walk.noop_draws;
            let min_area = walk.min_cover_area;
            self.cover.walk = Some(walk);
            return self.finish_cover(min_area);
        }
        if dropped {
            swap_table(&mut self.list, &mut c.full);
            walk.compact(
                &c.full.draws,
                &c.full.ops,
                &c.full.instanced,
                &mut self.list.draws,
                &mut self.list.screen_ops,
                &mut self.list.instanced,
            );
            c.culled = true;
            self.stats.covered_draws = walk.dropped_draws;
            self.stats.covered_ops = walk.dropped_ops;
            self.stats.noop_draws = walk.noop_draws;
        }
        let min_area = walk.min_cover_area;
        self.cover.walk = Some(walk);
        let c = &mut self.cover;
        let changed = if c.shown_valid {
            !same_table(&self.list, &c.shown)
        } else {
            // The executor last saw the full table (or what `assemble` already compared).
            dropped
        };
        c.shown_valid = false;
        if changed {
            self.list.dirty.draws = true;
        }
        self.finish_cover(min_area) || changed
    }

    fn finish_cover(&mut self, min_area: u32) -> bool {
        // Depth tests name only the prefix before the first back-buffer operation. Merging
        // leaves that prefix untouched, so retain the original owner/copy analysis and indices.
        let tiles_changed = self.cover_tiles(min_area);
        let c = &mut self.cover;
        let mapping = if c.culled {
            c.walk
                .as_ref()
                .map(|w| (w.keep_draw.as_slice(), w.keep_op.as_slice()))
        } else {
            None
        };
        if c.group_merge_check {
            c.group_restore_check = Some(Table {
                draws: self.list.draws.clone(),
                ops: self.list.screen_ops.clone(),
                instanced: self.list.instanced.clone(),
            });
        }
        let mut changed = c.groups.apply_compacted(&mut self.list, mapping);
        let mut groups = std::mem::take(&mut self.cover.groups);
        let mut list = std::mem::take(&mut self.list);
        let facts = Facts {
            resident: &self.resident,
            applier: self,
        };
        let original = self.cover.group_merge_check.then(|| group_check_digest(&list));
        changed |= groups.merge(
            &mut list,
            &facts,
            self.cover_walk && !self.cover.group_merge_off,
        );
        if let Some(original) = original {
            let mut plain = list.clone();
            groups.restore_merge_copy(&mut plain);
            assert_eq!(original, group_check_digest(&plain), "group restore changed list fields");
            assert!(
                groups.check_merge(&plain, &list),
                "group merge changed more than order and indices"
            );
            groups.restore_copy(&mut plain);
            assert!(
                same_table(&plain, self.cover.group_restore_check.as_ref().unwrap()),
                "group restore changed the compacted input table"
            );
        }
        self.list = list;
        self.cover.groups = groups;
        if changed {
            self.list.dirty.draws = true;
        }
        changed || tiles_changed
    }

    /// The tile half over the list as it now stands: writes its depth tables (cleared when the
    /// walk or the tiles are off, or on a surface applier). Marks the draw table dirty and returns
    /// true when they changed.
    fn cover_tiles(&mut self, min_area: u32) -> bool {
        self.stats.tile_covers = 0;
        self.stats.tile_tested = 0;
        self.stats.tile_hidden_px = 0;
        self.stats.tile_classified = 0;
        let on = self.cover_walk && !self.cover.tiles_off && self.surface.is_none();
        if !on {
            if let Some(t) = self.cover.tiles.as_mut() {
                t.forget();
            }
            let had = !self.list.depth_tiles.is_empty() || !self.list.depth_draws.is_empty();
            self.list.depth_tiles.clear();
            self.list.depth_draws.clear();
            if had {
                self.list.dirty.draws = true;
            }
            return had;
        }
        let mut tiles = self.cover.tiles.take().unwrap_or_default();
        tiles.min_cover_area = min_area;
        {
            let facts = Facts {
                resident: &self.resident,
                applier: self,
            };
            tiles.run(&self.list, &facts);
        }
        self.stats.tile_covers = tiles.covers;
        self.stats.tile_tested = tiles.tested;
        self.stats.tile_hidden_px = tiles.hidden_px.min(u64::from(u32::MAX)) as u32;
        self.stats.tile_classified = tiles.classified;
        let changed = self.list.depth_tiles != tiles.tiles || self.list.depth_draws != tiles.draws;
        if changed {
            self.list.depth_tiles.clone_from(&tiles.tiles);
            self.list.depth_draws.clone_from(&tiles.draws);
            self.list.dirty.draws = true;
        }
        self.cover.tiles = Some(tiles);
        changed
    }

    /// Whether disjoint, scissored Copy groups share a back-buffer pass (default on).
    pub fn set_group_merge(&mut self, on: bool) {
        self.cover.group_merge_off = !on;
    }

    /// Opt-in exhaustive diagnostics: check each merge and the next apply's restored input.
    /// The normal rendering path does not clone or hash lists for this check.
    pub fn set_group_merge_check(&mut self, on: bool) {
        self.cover.group_merge_check = on;
    }

    /// Diagnostic copy with just the group permutation undone.
    pub fn unmerged_list(&self) -> DrawList {
        let mut list = self.list.clone();
        self.cover.groups.restore_merge_copy(&mut list);
        list
    }

    /// Whether gated clip groups expose dead owner-alpha cells (on by default).
    pub fn set_group_cells(&mut self, on: bool) {
        self.cover.groups.cells_off = !on;
    }

    /// Whether canvas-group draws and copies are restricted to the composite's bounds.
    /// On by default; disabling this exact optimization is useful for diagnostics.
    pub fn set_group_scissor(&mut self, on: bool) {
        self.cover.groups_off = !on;
    }

    /// Whether the cover walk's tile half writes depth tables into the root list (on by default;
    /// off for A/B measurements). It changes no pixel.
    pub fn set_cover_tiles(&mut self, on: bool) {
        self.cover.tiles_off = !on;
    }

    /// The smallest hidden area, in target pixels, worth a depth test
    /// (`gsw_canvas_draw_list::cover::tiles::DEFAULT_MIN_HIDDEN_PX` by default).
    pub fn set_cover_tiles_min_hidden(&mut self, px: u32) {
        self.cover
            .tiles
            .get_or_insert_with(Default::default)
            .min_hidden_px = px;
    }

    /// The smallest cover the walk analyses, in target pixels
    /// (`gsw_canvas_draw_list::cover::DEFAULT_MIN_COVER_AREA` by default).
    pub fn set_cover_min_area(&mut self, px: u32) {
        self.cover
            .walk
            .get_or_insert_with(Default::default)
            .min_cover_area = px;
    }

    /// Whether the cover walk also leaves out draws that change no pixel
    /// (`gsw_canvas_draw_list::cover::noop`: a zero source alpha under a blend that keeps the
    /// destination). On by default; off for A/B measurements of what covers alone leave out.
    pub fn set_cover_noops(&mut self, on: bool) {
        self.cover
            .walk
            .get_or_insert_with(Default::default)
            .drop_noops = on;
    }

    /// The assembled draw table, before the cover walk: the list's own when nothing was culled.
    pub fn assembled_draws(&self) -> &[Draw] {
        if self.cover.culled {
            &self.cover.full.draws
        } else {
            &self.list.draws
        }
    }
}

impl Applier {
    /// Diagnostics (`rs-core-check walk-diff --cover`): what every target pixel of the list as it
    /// stands depends on (`gsw_canvas_draw_list::cover::oracle`), with this applier's textures and
    /// programs.
    pub fn cover_provenance(&self) -> gsw_canvas_draw_list::cover::oracle::Provenance {
        let facts = Facts {
            resident: &self.resident,
            applier: self,
        };
        gsw_canvas_draw_list::cover::oracle::provenance(&self.list, &facts)
    }

    /// Diagnostics (`rs-core-check walk-diff --cover`): whether the list as it stands is what a
    /// walk that remembers nothing makes of the assembled table, i.e. whether what the applier's
    /// walk kept across applies changed no answer.
    pub fn cover_recheck(&self) -> bool {
        let mut plain = self.list.clone();
        self.cover.groups.restore_copy(&mut plain);
        let mut full = plain.clone();
        if self.cover.culled {
            full.draws.clone_from(&self.cover.full.draws);
            full.screen_ops.clone_from(&self.cover.full.ops);
            full.instanced.clone_from(&self.cover.full.instanced);
        }
        let facts = Facts {
            resident: &self.resident,
            applier: self,
        };
        let mut walk = gsw_canvas_draw_list::cover::CoverWalk::default();
        if let Some(w) = &self.cover.walk {
            walk.min_cover_area = w.min_cover_area;
            walk.drop_noops = w.drop_noops;
        }
        // The depth tables: what a fresh check with no slack stands behind.
        let owners = self.cover.tiles.as_ref().map_or(&[][..], |t| &t.owners[..]);
        if !gsw_canvas_draw_list::cover::tiles::TileWalk::default()
            .verify(&plain, owners, &facts)
        {
            return false;
        }
        if !(self.cover_walk && walk.run(&full, &facts)) {
            return !self.cover.culled;
        }
        let mut t = Table::default();
        walk.compact(
            &full.draws,
            &full.screen_ops,
            &full.instanced,
            &mut t.draws,
            &mut t.ops,
            &mut t.instanced,
        );
        self.cover.culled && same_table(&plain, &t)
    }
}
