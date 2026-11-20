//! Conservative partial-redraw planning for an ordered [`DrawList`].
//!
//! Planning is pure with respect to the executor: only [`Planner::commit`] advances the executed
//! reference. Unmatched old and new draws damage their bounds; matched draws preserve paint order.
//! Regions use device pixels, top-left origin, and `[x, y, width, height]` rectangles.

use crate::cover::{self, CoverFacts, ProgramFacts, PxRect};
use crate::DrawList;

mod back;
mod diff;
mod mask;
mod signature;
use mask::Mask;
use signature::{snapshot, Snapshot};

/// Executor facts not stored in a draw list. Revisions must change on upload, free and alias.
pub trait DamageFacts {
    fn texture_revision(&self, id: u32) -> u32;
    /// Binding slot, zero-based (draw program minus one).
    fn program(&self, slot: u32) -> ProgramFacts;
    fn reads_time(&self, slot: u32) -> bool;
    fn program_revision(&self, _slot: u32) -> u32 {
        0
    }
    /// The same admission predicates the executor uses, including program readiness.
    fn admitted(&self, list: &DrawList, d: usize) -> bool;
}

struct BoundsFacts<'a, F>(&'a F);
impl<F: DamageFacts> CoverFacts for BoundsFacts<'_, F> {
    fn opacity(&self, _: u32) -> Option<&crate::opacity::Opacity> {
        None
    }
    fn program(&self, slot: u32) -> ProgramFacts {
        self.0.program(slot)
    }
}

#[derive(Clone, Debug)]
pub struct PlanOptions {
    pub cell: u32,
    pub regions_max: usize,
    pub area_max: f32,
    pub calls_max: f32,
}
impl Default for PlanOptions {
    fn default() -> Self {
        Self {
            cell: 32,
            regions_max: 8,
            area_max: 0.5,
            calls_max: 0.75,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FullReason {
    First,
    Invalidated,
    DirtyAll,
    ScreenReader,
    HistoryRead,
    Area,
    Calls,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    Skip,
    Full(FullReason),
    Partial {
        regions: Vec<[i32; 4]>,
        back_regions: Vec<[i32; 4]>,
    },
}

/// A reader or mipmap operation responsible for a conservative full-redraw fallback.
/// For an operation, `draw` is its `before` position and `op` is its screen-op table index.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct FullTrigger {
    pub draw: usize,
    pub op: Option<usize>,
    /// Zero-based binding slot; absent for builtin draws and screen operations.
    pub program_slot: Option<u32>,
    pub bounds: [i32; 4],
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlanStats {
    pub changed_old: usize,
    pub changed_new: usize,
    pub matched: usize,
    pub changed_old_ops: usize,
    pub changed_new_ops: usize,
    pub structural: bool,
    pub area_permille: u32,
    pub region_count: usize,
    /// Sum of admitted draw/region intersections (a draw can replay in several regions).
    pub replayed_draws: usize,
    pub admitted_draws: usize,
    /// Number of entries in the input draw table, including back-buffer producers.
    pub planned_draws: usize,
    /// Readers and mipmap operations whose inputs are not fresh from an earlier Clear/Copy.
    pub history_reads: usize,
    /// Triggers for the returned ScreenReader/HistoryRead reason, empty for other plans.
    pub full_triggers: Vec<FullTrigger>,
}

#[derive(Default)]
pub struct Planner {
    previous: Option<Snapshot>,
    pending: Option<Snapshot>,
    invalidated: bool,
}

impl Planner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn plan(
        &mut self,
        list: &DrawList,
        facts: &impl DamageFacts,
        opts: &PlanOptions,
    ) -> (Plan, PlanStats) {
        let next = snapshot(list, facts);
        let mut stats = PlanStats {
            admitted_draws: next.replay.iter().filter(|(_, admitted)| *admitted).count(),
            history_reads: next.back.history_reads,
            planned_draws: list.draws.len(),
            ..PlanStats::default()
        };
        let mut damage = Mask::new(list.target.width, list.target.height, opts.cell);
        if let Some(old) = &self.previous {
            let (a, b) = diff::unmatched(&old.draws, &next.draws);
            stats.changed_old_ops = a.iter().filter(|&&i| old.draws[i].is_op).count();
            stats.changed_new_ops = b.iter().filter(|&&i| next.draws[i].is_op).count();
            stats.changed_old = a.len() - stats.changed_old_ops;
            stats.changed_new = b.len() - stats.changed_new_ops;
            stats.matched = next.draw_count - stats.changed_new;
            stats.structural = old.draw_count != next.draw_count || !a.is_empty() || !b.is_empty();
            for i in a {
                damage.add(old.draws[i].bounds);
            }
            for i in b {
                damage.add(next.draws[i].bounds);
            }
        } else {
            stats.changed_new = next.draw_count;
            stats.changed_new_ops = next.draws.iter().filter(|d| d.is_op).count();
            stats.structural = !next.draws.is_empty();
        }
        let reason = if self.invalidated {
            Some(FullReason::Invalidated)
        } else if self.previous.is_none() {
            Some(FullReason::First)
        } else if self
            .previous
            .as_ref()
            .is_some_and(|p| p.target != next.target)
        {
            Some(FullReason::Invalidated)
        } else if list.dirty.all {
            Some(FullReason::DirtyAll)
        } else {
            next.back.expand(&mut damage, opts.regions_max)
        };
        let plan = if let Some(reason) = reason {
            stats.full_triggers = match reason {
                FullReason::ScreenReader => next.back.screen_triggers(&damage),
                FullReason::HistoryRead => next.back.history_triggers.clone(),
                _ => Vec::new(),
            };
            Plan::Full(reason)
        } else if damage.is_empty() {
            Plan::Skip
        } else {
            let regions = damage.regions(opts.regions_max);
            stats.replayed_draws = regions
                .iter()
                .map(|r| {
                    let r = PxRect::xywh(*r);
                    next.replay
                        .iter()
                        .filter(|(bounds, admitted)| *admitted && bounds.intersects(&r))
                        .count()
                })
                .sum();
            let area: i64 = regions.iter().map(|r| PxRect::xywh(*r).area()).sum();
            let target_area = u64::from(list.target.width) * u64::from(list.target.height);
            stats.area_permille = if target_area == 0 {
                0
            } else {
                (area as u64 * 1000 / target_area) as u32
            };
            stats.region_count = regions.len();
            if area as f64 > f64::from(opts.area_max) * target_area as f64 {
                Plan::Full(FullReason::Area)
            } else if stats.replayed_draws as f64
                > f64::from(opts.calls_max) * stats.admitted_draws as f64
            {
                Plan::Full(FullReason::Calls)
            } else {
                Plan::Partial {
                    regions,
                    back_regions: if next.back.has_back_draws {
                        damage.dilated().regions(opts.regions_max)
                    } else {
                        Vec::new()
                    },
                }
            }
        };
        if matches!(plan, Plan::Full(_)) {
            stats.area_permille = 1000;
            stats.region_count = 1;
            stats.replayed_draws = stats.admitted_draws;
        }
        self.pending = Some(next);
        (plan, stats)
    }

    /// Call only after the most recently planned frame was successfully executed or skipped.
    pub fn commit(&mut self) {
        if let Some(next) = self.pending.take() {
            self.previous = Some(next);
            self.invalidated = false;
        }
    }

    /// Discard pending and executed references after failed execution or target/context changes.
    pub fn invalidate(&mut self) {
        self.previous = None;
        self.pending = None;
        self.invalidated = true;
    }
}

#[cfg(test)]
mod tests;
