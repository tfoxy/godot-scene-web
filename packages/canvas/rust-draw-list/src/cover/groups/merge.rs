//! A permutation only: copies and children move, target writes keep their relative order.
use super::{GroupWork, Patch};
use crate::cover::{draw_bounds, CoverFacts, PxRect};
use crate::{
    Draw, DrawList, InstancedDraw, ScreenOp, ScreenOpKind, BUILTIN_PROGRAM, DRAW_SCREEN_OPS,
    DRAW_TO_BACK_BUFFER,
};

#[derive(Default)]
pub(super) struct MergeWalk {
    order: Vec<usize>,
    draws: Vec<Patch<Draw>>,
    ops: Vec<Patch<ScreenOp>>,
    instances: Vec<Patch<InstancedDraw>>,
    applied: bool,
}

impl MergeWalk {
    pub fn check_permutation(&self, before: &DrawList, after: &DrawList) -> bool {
        if !self.applied {
            return before.draws == after.draws
                && before.screen_ops == after.screen_ops
                && before.instanced == after.instanced;
        }
        if self.order.len() != before.draws.len() || after.draws.len() != before.draws.len() {
            return false;
        }
        let mut inverse = vec![usize::MAX; self.order.len() + 1];
        inverse[self.order.len()] = self.order.len();
        let mut last_target = None;
        for (new, &old) in self.order.iter().enumerate() {
            if old >= self.order.len() || inverse[old] != usize::MAX {
                return false;
            }
            inverse[old] = new;
            if before.draws[old].flags & DRAW_TO_BACK_BUFFER == 0 {
                if last_target.is_some_and(|last| old <= last) {
                    return false;
                }
                last_target = Some(old);
            }
            let mut expected = before.draws[old];
            expected.flags &= !DRAW_SCREEN_OPS;
            if after.screen_ops.iter().any(|op| op.before as usize == new) {
                expected.flags |= DRAW_SCREEN_OPS;
            }
            if after.draws[new] != expected {
                return false;
            }
        }
        let mut ops = before.screen_ops.clone();
        for op in &mut ops {
            let Some(&at) = inverse.get(op.before as usize) else {
                return false;
            };
            op.before = at as u32;
        }
        ops.sort_by_key(|op| op.before);
        let mut instances = before.instanced.clone();
        for inst in &mut instances {
            let Some(&at) = inverse.get(inst.draw as usize) else {
                return false;
            };
            inst.draw = at as u32;
        }
        instances.sort_by_key(|inst| inst.draw);
        ops == after.screen_ops && instances == after.instanced
    }

    pub fn restore_copy(&self, list: &mut DrawList) {
        if self.applied {
            for p in &self.draws {
                list.draws[p.at] = p.before;
            }
            for p in &self.ops {
                list.screen_ops[p.at] = p.before;
            }
            for p in &self.instances {
                list.instanced[p.at] = p.before;
            }
        }
    }

    pub fn restore(&mut self, list: &mut DrawList) {
        self.restore_copy(list);
        self.applied = false;
    }

    pub fn run(
        &mut self,
        list: &mut DrawList,
        groups: &mut [GroupWork],
        facts: &impl CoverFacts,
        on: bool,
    ) -> bool {
        assert!(!self.applied, "restore group permutation before merging");
        self.draws.clear();
        self.ops.clear();
        self.instances.clear();
        let mut order = Vec::new();
        let mut cursor = 0;
        if on {
            let openings: Vec<_> = groups.iter().map(|g| opening(list, g)).collect();
            let mut i = 0;
            while i < groups.len() {
                if openings[i].is_none() {
                    i += 1;
                    continue;
                }
                let mut end = i + 1;
                while end < groups.len()
                    && openings[end].is_some()
                    && can_extend(list, groups, &openings, i, end, facts)
                {
                    end += 1;
                }
                if end > i + 1 {
                    let span = groups[i].back_buffer.start..groups[end - 1].composite.end;
                    order.extend(cursor..span.start);
                    for g in &groups[i..end] {
                        order.extend(g.back_buffer.clone());
                    }
                    order.extend(
                        span.clone()
                            .filter(|d| !groups[i..end].iter().any(|g| g.back_buffer.contains(d))),
                    );
                    cursor = span.end;
                }
                i = end;
            }
        }
        if cursor == 0 {
            let changed = !self.order.is_empty();
            self.order.clear();
            return changed;
        }
        order.extend(cursor..list.draws.len());
        let changed = self.order != order;
        self.order = order;
        let mut inverse = vec![0; list.draws.len() + 1];
        inverse[list.draws.len()] = list.draws.len();
        for (new, &old) in self.order.iter().enumerate() {
            inverse[old] = new;
        }
        let mut ops = list.screen_ops.clone();
        for op in &mut ops {
            op.before = inverse[op.before as usize] as u32;
        }
        ops.sort_by_key(|op| op.before);
        let mut op_at = 0;
        for (at, &old) in self.order.iter().enumerate() {
            let before = list.draws[at];
            let mut after = list.draws[old];
            after.flags &= !DRAW_SCREEN_OPS;
            if ops.get(op_at).is_some_and(|op| op.before as usize == at) {
                after.flags |= DRAW_SCREEN_OPS;
                while ops.get(op_at).is_some_and(|op| op.before as usize == at) {
                    op_at += 1;
                }
            }
            if before != after {
                self.draws.push(Patch { at, before, after });
            }
        }
        for (at, &after) in ops.iter().enumerate() {
            let before = list.screen_ops[at];
            if before != after {
                self.ops.push(Patch { at, before, after });
            }
        }
        let mut instances = list.instanced.clone();
        for inst in &mut instances {
            inst.draw = inverse[inst.draw as usize] as u32;
        }
        instances.sort_by_key(|inst| inst.draw);
        for (at, &after) in instances.iter().enumerate() {
            let before = list.instanced[at];
            if before != after {
                self.instances.push(Patch { at, before, after });
            }
        }
        for g in groups {
            if !g.back_buffer.is_empty() {
                let start = inverse[g.back_buffer.start];
                g.back_buffer = start..start + g.back_buffer.len();
            }
            if !g.composite.is_empty() {
                let start = inverse[g.composite.start];
                g.composite = start..start + g.composite.len();
            }
        }
        for p in &self.draws {
            list.draws[p.at] = p.after;
        }
        for p in &self.ops {
            list.screen_ops[p.at] = p.after;
        }
        for p in &self.instances {
            list.instanced[p.at] = p.after;
        }
        self.applied = true;
        changed
    }
}

fn opening(list: &DrawList, g: &GroupWork) -> Option<usize> {
    g.rect?;
    if g.back_buffer.is_empty()
        || g.composite.is_empty()
        || g.back_buffer.end != g.composite.start
        || g.composite.end > list.draws.len()
        || list.draws[g.back_buffer.clone()]
            .iter()
            .any(|d| d.flags & DRAW_TO_BACK_BUFFER == 0)
    {
        return None;
    }
    let mut ops =
        list.screen_ops.iter().enumerate().filter(|(_, op)| {
            (g.back_buffer.start..g.composite.end).contains(&(op.before as usize))
        });
    let (at, op) = ops.next()?;
    (ops.next().is_none()
        && op.before as usize == g.back_buffer.start
        && op.kind == ScreenOpKind::Copy
        && !op.mipmaps
        && PxRect::xywh(op.region) == g.rect?)
        .then_some(at)
}

fn can_extend(
    list: &DrawList,
    groups: &[GroupWork],
    openings: &[Option<usize>],
    first: usize,
    next: usize,
    facts: &impl CoverFacts,
) -> bool {
    let g = &groups[next];
    let rect = g.rect.unwrap();
    if groups[next - 1].composite.end > g.back_buffer.start
        || groups[first..next]
            .iter()
            .any(|prior| prior.rect.unwrap().intersects(&rect))
    {
        return false;
    }
    let span = groups[first].back_buffer.start..g.composite.end;
    // No unrelated copy, clear or mip generation can cross the hoisted work.
    if list.screen_ops.iter().enumerate().any(|(at, op)| {
        span.contains(&(op.before as usize)) && !openings[first..=next].contains(&Some(at))
    }) {
        return false;
    }
    for at in span {
        let draw = &list.draws[at];
        if draw.program != BUILTIN_PROGRAM && facts.program(draw.program - 1).reads_screen {
            return false;
        }
        if at < g.back_buffer.start
            && draw.flags & DRAW_TO_BACK_BUFFER == 0
            && draw_bounds(list, at, facts).intersects(&rect)
        {
            return false;
        }
    }
    true
}
