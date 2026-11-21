//! Pure, paint-ordered draw-call planning shared by executors and offline tools.
use crate::{
    BUILTIN_PROGRAM, Blend, DRAW_GROUP_CLIP, DRAW_GROUP_COMPOSITE, DRAW_INSTANCED, DRAW_MSDF,
    DRAW_SCISSOR, DRAW_SCREEN_OPS, DRAW_TO_BACK_BUFFER, DRAW_UNTEXTURED, Draw, DrawList,
    WHITE_TEXTURE, mergeable, merged,
};

/// One `drawElements` call: the state of draw `draw` over a merged index range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Call {
    /// Index of the run's first draw in `list.draws` (its state is the call's, but for the
    /// texture and sampler: `texture_draw`'s).
    pub draw: u32,
    pub first_index: u32,
    pub index_count: u32,
    /// The draw whose texture and sampler the call binds: the run's first draw that is not
    /// [`DRAW_UNTEXTURED`], else `draw` (an all-untextured run, which needs no texture of its own).
    pub texture_draw: u32,
    /// The run's depth level ([`crate::depth_level`]): every draw of a run has the
    /// same; None for draws the list does not depth-test.
    pub depth: Option<u32>,
    /// Union of the run's draw bounds in design rows, top-left `[x, y, w, h]`.
    pub bounds: [i32; 4],
    /// Texture/sampler table. K=1 uses only slot zero; other entries are white.
    /// Multi-slot calls retain the previous call's resident pairs in unused slots.
    pub slots: [(u32, u32); 4],
}

/// What [`plan_calls`] counted besides the calls.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlanCounts {
    pub merged: u32,
    pub skipped: u32,
    pub breaks: BreakCounts,
    pub slot_fallbacks: u32,
}

/// Supported texture capacities. The executor uses the default single-slot plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlanOptions {
    pub texture_slots: u8,
}
impl Default for PlanOptions {
    fn default() -> Self {
        Self { texture_slots: 1 }
    }
}

/// First failing condition per run boundary, in declaration order. Empty draws are ignored;
/// undrawable counts skipped nonempty draws. Equal-binding program breaks are a subset of program.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BreakCounts {
    pub texture: u32,
    pub sampler: u32,
    pub blend: u32,
    pub program: u32,
    pub program_equal_bindings: u32,
    pub msdf_flag: u32,
    pub msdf_params: u32,
    pub scissor_flag: u32,
    pub scissor_rect: u32,
    pub back_buffer_group_flags: u32,
    pub other_flags: u32,
    pub instanced: u32,
    pub screen_ops: u32,
    pub index_gap: u32,
    pub depth_level: u32,
    pub group_cells: u32,
    pub undrawable: u32,
}

fn count_break(
    list: &DrawList,
    a: &Draw,
    b: &Draw,
    depth_changed: bool,
    group_changed: bool,
    texture_ok: bool,
    h: &mut BreakCounts,
) {
    let untextured = (a.flags | b.flags) & DRAW_UNTEXTURED != 0;
    let xor = a.flags ^ b.flags;
    let group_flags = DRAW_TO_BACK_BUFFER | DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE;
    let known_flags =
        DRAW_UNTEXTURED | DRAW_SCREEN_OPS | DRAW_MSDF | DRAW_SCISSOR | group_flags | DRAW_INSTANCED;
    if !texture_ok && !untextured && a.texture != b.texture {
        h.texture += 1;
    } else if !texture_ok && !untextured && a.sampler != b.sampler {
        h.sampler += 1;
    } else if a.blend != b.blend {
        h.blend += 1;
    } else if a.program != b.program {
        h.program += 1;
        if a.program != 0 && b.program != 0 {
            if let (Some(a), Some(b)) = (
                list.bindings.get((a.program - 1) as usize),
                list.bindings.get((b.program - 1) as usize),
            ) {
                if a == b {
                    h.program_equal_bindings += 1;
                }
            }
        }
    } else if xor & DRAW_MSDF != 0 {
        h.msdf_flag += 1;
    } else if a.flags & DRAW_MSDF != 0 && a.msdf != b.msdf {
        h.msdf_params += 1;
    } else if xor & DRAW_SCISSOR != 0 {
        h.scissor_flag += 1;
    } else if a.flags & DRAW_SCISSOR != 0 && a.scissor != b.scissor {
        h.scissor_rect += 1;
    } else if xor & group_flags != 0 {
        h.back_buffer_group_flags += 1;
    } else if xor & !known_flags != 0 {
        h.other_flags += 1;
    } else if (a.flags | b.flags) & DRAW_INSTANCED != 0 {
        h.instanced += 1;
    } else if b.flags & DRAW_SCREEN_OPS != 0 {
        h.screen_ops += 1;
    } else if a.first_index + a.index_count != b.first_index {
        h.index_gap += 1;
    } else if depth_changed {
        h.depth_level += 1;
    } else if group_changed {
        h.group_cells += 1;
    }
}

/// Whether the executor can draw `draw` at all: a known texture (`known_texture`), a known blend,
/// the builtin program or a binding slot whose program compiled (`known_binding`, given the
/// draw's `program`), and an index range inside `index_len`.
pub fn drawable(
    draw: &Draw,
    index_len: usize,
    known_texture: impl Fn(u32) -> bool,
    known_binding: impl Fn(u32) -> bool,
) -> bool {
    Blend::from_u32(draw.blend).is_some()
        && (draw.program == BUILTIN_PROGRAM || known_binding(draw.program))
        && (draw.texture == WHITE_TEXTURE || known_texture(draw.texture))
        && u64::from(draw.first_index) + u64::from(draw.index_count) <= index_len as u64
}

/// The draw calls for `list`, in paint order, into `out` (cleared first). Adjacent drawable draws
/// of one depth level merge when [`mergeable`] allows; an empty draw neither draws nor ends a run (as
/// [`DrawList::merged_draw_count`] counts); an undrawable one is skipped and ends the run.
pub fn plan_calls(
    list: &DrawList,
    known_texture: impl Fn(u32) -> bool,
    known_binding: impl Fn(u32) -> bool,
    out: &mut Vec<Call>,
) -> PlanCounts {
    plan_calls_with_options(
        list,
        PlanOptions::default(),
        known_texture,
        known_binding,
        out,
    )
}

/// Plan with an explicit texture capacity. For a retained slot stream, use
/// [`plan_calls_with_slots`]; this convenience form discards the stream after conflict checking.
pub fn plan_calls_with_options(
    list: &DrawList,
    options: PlanOptions,
    known_texture: impl Fn(u32) -> bool,
    known_binding: impl Fn(u32) -> bool,
    out: &mut Vec<Call>,
) -> PlanCounts {
    assert!(
        matches!(options.texture_slots, 1 | 4),
        "texture_slots must be 1 or 4"
    );
    if options.texture_slots == 1 {
        return plan_inner(list, options, known_texture, known_binding, out, None).unwrap();
    }
    plan_calls_with_slots(
        list,
        options,
        known_texture,
        known_binding,
        out,
        &mut Vec::new(),
        &mut Vec::new(),
    )
}

/// Plan and update one slot byte per vertex, preserving the caller's allocation. `dirty` is
/// cleared, then filled with maximal half-open ranges containing exactly the changed/new bytes.
/// Truncation needs no upload. Unreferenced vertices and single-slot/ineligible draws use zero.
/// Conflicting vertex ownership discards the entire multi-slot plan and replans with one slot.
pub fn plan_calls_with_slots(
    list: &DrawList,
    options: PlanOptions,
    known_texture: impl Fn(u32) -> bool,
    known_binding: impl Fn(u32) -> bool,
    out: &mut Vec<Call>,
    stream: &mut Vec<u8>,
    dirty: &mut Vec<std::ops::Range<usize>>,
) -> PlanCounts {
    assert!(
        matches!(options.texture_slots, 1 | 4),
        "texture_slots must be 1 or 4"
    );
    let mut owners = vec![None; list.vertices.len()];
    let result = plan_inner(
        list,
        options,
        &known_texture,
        &known_binding,
        out,
        (options.texture_slots == 4).then_some(owners.as_mut_slice()),
    );
    let counts = match result {
        Some(c) => c,
        None => {
            owners.fill(None);
            let mut c = plan_inner(
                list,
                PlanOptions::default(),
                known_texture,
                known_binding,
                out,
                None,
            )
            .unwrap();
            c.slot_fallbacks = 1;
            c
        }
    };
    dirty.clear();
    let previous_len = stream.len();
    stream.resize(owners.len(), 0);
    let mut start = None;
    for (i, owner) in owners.into_iter().enumerate() {
        let next = owner.unwrap_or(0);
        let changed = i >= previous_len || stream[i] != next;
        if changed {
            start.get_or_insert(i);
        } else if let Some(first) = start.take() {
            dirty.push(first..i);
        }
        stream[i] = next;
    }
    if let Some(first) = start {
        dirty.push(first..stream.len());
    }
    counts
}

fn eligible(d: &Draw) -> bool {
    d.program == BUILTIN_PROGRAM
        && d.flags & (DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE | DRAW_INSTANCED) == 0
}

fn slot_for(d: &Draw, slots: &[(u32, u32); 4], used: &[bool; 4]) -> Option<usize> {
    if d.flags & DRAW_UNTEXTURED != 0 {
        return Some(0);
    }
    slots
        .iter()
        .position(|&pair| pair == (d.texture, d.sampler))
        .or_else(|| used.iter().position(|&u| !u))
}

fn plan_inner(
    list: &DrawList,
    options: PlanOptions,
    known_texture: impl Fn(u32) -> bool,
    known_binding: impl Fn(u32) -> bool,
    out: &mut Vec<Call>,
    mut owners: Option<&mut [Option<u8>]>,
) -> Option<PlanCounts> {
    out.clear();
    let mut counts = PlanCounts::default();
    let mut run: Option<Draw> = None;
    let mut group = None;
    let mut slots = [(WHITE_TEXTURE, 0); 4];
    let mut used = [false; 4];
    for (i, draw) in list.draws.iter().enumerate() {
        if draw.index_count == 0 {
            continue;
        }
        if !drawable(draw, list.indices.len(), &known_texture, &known_binding) {
            counts.skipped += 1;
            counts.breaks.undrawable += 1;
            run = None;
            continue;
        }
        let depth = crate::depth_level(list, i as u32);
        let next_group = list.group_cells.iter().position(|g| g.draws.contains(&i));
        let multi =
            options.texture_slots == 4 && eligible(draw) && run.as_ref().is_some_and(eligible);
        let candidate = slot_for(draw, &slots, &used);
        let texture_ok = multi && candidate.is_some();
        let joins = if let (Some(r), Some(call)) = (run, out.last()) {
            count_break(
                list,
                &r,
                draw,
                call.depth != depth,
                group != next_group,
                texture_ok,
                &mut counts.breaks,
            );
            let mut next = *draw;
            if texture_ok {
                next.texture = r.texture;
                next.sampler = r.sampler;
            }
            call.depth == depth && group == next_group && mergeable(&r, &next)
        } else {
            false
        };
        if joins {
            let r = run.unwrap();
            let call = out.last_mut().unwrap();
            call.index_count += draw.index_count;
            if r.flags & DRAW_UNTEXTURED != 0 && draw.flags & DRAW_UNTEXTURED == 0 {
                call.texture_draw = i as u32;
            }
            counts.merged += 1;
            run = Some(merged(&r, draw));
        } else {
            used = [false; 4];
            out.push(Call {
                draw: i as u32,
                first_index: draw.first_index,
                index_count: draw.index_count,
                texture_draw: i as u32,
                depth,
                bounds: [0; 4],
                slots: [(WHITE_TEXTURE, 0); 4],
            });
            run = Some(*draw);
        }
        group = next_group;
        let call = out.last_mut().unwrap();
        let slot = if options.texture_slots == 4 && eligible(draw) {
            let slot = slot_for(draw, &slots, &used).unwrap();
            if draw.flags & DRAW_UNTEXTURED == 0 {
                used[slot] = true;
                slots[slot] = (draw.texture, draw.sampler);
            }
            call.slots = slots;
            slot as u8
        } else {
            let tex = &list.draws[call.texture_draw as usize];
            call.slots[0] = (tex.texture, tex.sampler);
            // Single-slot calls overwrite unit zero but leave the other sticky entries alone.
            slots[0] = call.slots[0];
            0
        };
        if let Some(owners) = owners.as_deref_mut() {
            let start = draw.first_index as usize;
            for &vertex in &list.indices[start..start + draw.index_count as usize] {
                if let Some(owner) = owners.get_mut(vertex as usize) {
                    if owner.is_some_and(|previous| previous != slot) {
                        return None;
                    }
                    *owner = Some(slot);
                }
            }
        }
    }
    Some(counts)
}

/// Fill bounds after planning once, independently of replay regions.
pub fn call_bounds(
    list: &DrawList,
    calls: &mut [Call],
    bounds_for_draw: impl Fn(usize) -> crate::cover::PxRect,
) {
    use crate::cover::PxRect;
    for call in calls {
        let mut bounds = PxRect::EMPTY;
        let mut left = call.index_count;
        for d in call.draw as usize..list.draws.len() {
            if left == 0 {
                break;
            }
            let draw = &list.draws[d];
            let b = bounds_for_draw(d);
            if !b.is_empty() {
                bounds = if bounds.is_empty() {
                    b
                } else {
                    PxRect {
                        x0: bounds.x0.min(b.x0),
                        y0: bounds.y0.min(b.y0),
                        x1: bounds.x1.max(b.x1),
                        y1: bounds.y1.max(b.y1),
                    }
                };
            }
            left -= draw.index_count;
        }
        call.bounds = [
            bounds.x0,
            bounds.y0,
            bounds.x1 - bounds.x0,
            bounds.y1 - bounds.y0,
        ];
    }
}
