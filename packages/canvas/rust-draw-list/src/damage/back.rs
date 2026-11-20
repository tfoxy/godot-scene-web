//! Forward back-buffer dependencies, followed by monotone damage expansion.
use super::{DamageFacts, FullReason, FullTrigger, Mask};
use crate::cover::PxRect;
use crate::{
    DrawList, ScreenOpKind, BUILTIN_PROGRAM, DRAW_GROUP_CLIP, DRAW_GROUP_COMPOSITE,
    DRAW_TO_BACK_BUFFER,
};

#[derive(Default)]
struct Rule {
    region: Option<PxRect>,
    readers: Vec<PxRect>,
}
#[derive(Default)]
pub(super) struct Analysis {
    copies: Vec<Rule>,
    mips: Vec<Rule>,
    screen_readers: Vec<FullTrigger>,
    pub history_triggers: Vec<FullTrigger>,
    pub history_reads: usize,
    pub has_back_draws: bool,
}

pub(super) fn reader(list: &DrawList, d: usize, facts: &impl DamageFacts) -> bool {
    let draw = &list.draws[d];
    draw.flags & DRAW_TO_BACK_BUFFER == 0
        && (if draw.program == BUILTIN_PROGRAM {
            draw.flags & (DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE) != 0
        } else {
            facts.program(draw.program - 1).reads_screen
        })
}

pub(super) fn grow(r: PxRect, by: i32) -> PxRect {
    if r.is_empty() {
        return PxRect::EMPTY;
    }
    PxRect {
        x0: r.x0.saturating_sub(by),
        y0: r.y0.saturating_sub(by),
        x1: r.x1.saturating_add(by),
        y1: r.y1.saturating_add(by),
    }
}

/// Exact coverage by earlier clears and copies. Draws (including their blending) do not
/// prove fresh pixels. Tile rounding here would wrongly certify
/// unwritten history pixels as fresh.
fn covered(r: PxRect, writes: &[PxRect]) -> bool {
    let mut remaining = vec![r];
    for w in writes {
        let mut next = Vec::new();
        for p in remaining {
            let i = p.intersect(w);
            if i.is_empty() {
                next.push(p);
                continue;
            }
            for piece in [
                PxRect { y1: i.y0, ..p },
                PxRect { y0: i.y1, ..p },
                PxRect {
                    x1: i.x0,
                    y0: i.y0,
                    y1: i.y1,
                    ..p
                },
                PxRect {
                    x0: i.x1,
                    y0: i.y0,
                    y1: i.y1,
                    ..p
                },
            ] {
                if !piece.is_empty() {
                    next.push(piece);
                }
            }
        }
        remaining = next;
        if remaining.is_empty() {
            return true;
        }
    }
    remaining.iter().all(PxRect::is_empty)
}

impl Analysis {
    pub fn new(list: &DrawList, facts: &impl DamageFacts, bounds: &[PxRect]) -> Self {
        let mut out = Self::default();
        let target = PxRect::xywh([0, 0, list.target.width as i32, list.target.height as i32]);
        let mut writes = Vec::new();
        // A partial copy leaves pixels of earlier copies alive. Keep every dependency until
        // Clear; proving overwrite is optional, forgetting a surviving copied pixel is not.
        let mut copies = Vec::new();
        // Rebuilds can also be partial. Clear only resets level zero, so old mip dependencies
        // must survive it along with the cached mip levels.
        let mut active_mips = Vec::new();
        let mut sample_mips = false;
        let mut next_op = 0;
        let last = list
            .draws
            .iter()
            .enumerate()
            .rfind(|(d, draw)| draw.index_count > 0 && facts.admitted(list, *d))
            .map(|(d, _)| d);
        for (d, draw) in list.draws.iter().enumerate() {
            if last.is_none_or(|last| d > last) {
                break;
            }
            while let Some(op) = list.screen_ops.get(next_op) {
                if op.before as usize > d {
                    break;
                }
                next_op += 1;
                let region = PxRect::xywh(op.region).intersect(&target);
                sample_mips = op.sample_mips;
                match op.kind {
                    ScreenOpKind::Clear => {
                        writes.clear();
                        writes.push(target);
                        copies.clear();
                    }
                    ScreenOpKind::Copy if !region.is_empty() => {
                        writes.push(region);
                        out.copies.push(Rule {
                            region: Some(region),
                            ..Rule::default()
                        });
                        copies.push(out.copies.len() - 1);
                        if op.mipmaps && !region.is_empty() {
                            out.mips.push(Rule {
                                region: Some(region),
                                ..Rule::default()
                            });
                            active_mips.push(out.mips.len() - 1);
                        }
                    }
                    ScreenOpKind::Copy => {}
                    ScreenOpKind::Mipmaps => {
                        if !covered(region, &writes) {
                            out.history_reads += 1;
                            out.history_triggers.push(FullTrigger {
                                draw: op.before as usize,
                                op: Some(next_op - 1),
                                program_slot: None,
                                bounds: rect_xywh(region),
                            });
                        }
                        if !region.is_empty() {
                            out.mips.push(Rule {
                                region: Some(region),
                                ..Rule::default()
                            });
                            active_mips.push(out.mips.len() - 1);
                        }
                    }
                }
            }
            if !facts.admitted(list, d) || draw.index_count == 0 {
                continue;
            }
            if draw.flags & DRAW_TO_BACK_BUFFER != 0 {
                out.has_back_draws = true;
                continue;
            }
            if !reader(list, d, facts) || bounds[d].is_empty() {
                continue;
            }
            let item_space = draw.program != BUILTIN_PROGRAM;
            let footprint = if item_space {
                target
            } else {
                grow(bounds[d], 1).intersect(&target)
            };
            let mip_history = sample_mips
                && (active_mips.is_empty()
                    || active_mips
                        .iter()
                        .any(|&k| !covered(out.mips[k].region.expect("mipmap region"), &writes)));
            if !covered(footprint, &writes) || mip_history {
                out.history_reads += 1;
                out.history_triggers.push(FullTrigger {
                    draw: d,
                    op: None,
                    program_slot: draw.program.checked_sub(1),
                    bounds: rect_xywh(bounds[d]),
                });
            }
            if item_space {
                out.screen_readers.push(FullTrigger {
                    draw: d,
                    op: None,
                    program_slot: Some(draw.program - 1),
                    bounds: rect_xywh(bounds[d]),
                });
            }
            for &k in &copies {
                out.copies[k].readers.push(bounds[d]);
            }
            if sample_mips {
                for &k in &active_mips {
                    out.mips[k].readers.push(bounds[d]);
                }
            }
        }
        out
    }

    pub fn screen_triggers(&self, damage: &Mask) -> Vec<FullTrigger> {
        self.screen_readers
            .iter()
            .filter(|r| damage.intersects(PxRect::xywh(r.bounds)))
            .cloned()
            .collect()
    }

    pub fn expand(&self, damage: &mut Mask, regions_max: usize) -> Option<FullReason> {
        if self.history_reads > 0 {
            return Some(FullReason::HistoryRead);
        }
        loop {
            let mut changed = false;
            for rule in &self.copies {
                if rule.readers.is_empty() {
                    continue;
                }
                let region = rule.region.expect("copy region");
                if damage.intersects(region)
                    || rule.readers.iter().any(|r| damage.intersects(grow(*r, 1)))
                {
                    changed |= damage.add(region);
                    for &r in &rule.readers {
                        changed |= damage.add(r);
                    }
                }
            }
            for rule in &self.mips {
                if rule.readers.is_empty() {
                    continue;
                }
                let region = rule.region.expect("mipmap region");
                if damage.intersects(region) || rule.readers.iter().any(|r| damage.intersects(*r)) {
                    changed |= damage.add(region);
                    for &r in &rule.readers {
                        changed |= damage.add(r);
                    }
                }
            }
            // Region-limit merges can add clean cells, which can themselves reach a copy
            // or screen reader. Include those cells before deciding that expansion is finished.
            for r in damage.regions(regions_max) {
                changed |= damage.add(PxRect::xywh(r));
            }
            if !changed {
                break;
            }
        }
        if self
            .screen_readers
            .iter()
            .any(|r| damage.intersects(PxRect::xywh(r.bounds)))
        {
            Some(FullReason::ScreenReader)
        } else {
            None
        }
    }
}

fn rect_xywh(r: PxRect) -> [i32; 4] {
    [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0]
}
