//! Ordered instanced executor shared by browser WebGL2 and native harnesses. Everything here is
//! backend-neutral; the GPU calls go through [`GpuBackend`] (wgpu: [`WgpuBackend`]).
use crate::{
    backend::{FrameWork, GpuBackend, PictureRegion, PicturePass, wgpu_backend::WgpuBackend},
    contract::{Admission, Command, Patch, PatchDelta, SceneState},
    damage::{self, DamageSet, DeviceRect, Projection},
    geometry::{self, Draw, Geometry, Instance, ResourceIndexCache, TEXTURE_SLOTS},
    idle::IdleSet,
    present::PresentMode,
    resources::{ResourceChange, ResourceFormat, ResourceStore},
};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};

// These trace timestamps bracket synchronous Rust execution only. A dropped span
// closes on every early return; no span crosses the validation future's await.
#[derive(Clone)]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
struct PhaseIdentity {
    run_id: String,
    renderer_instance_id: String,
    operation_id: u32,
}
struct PhaseSpan {
    identity: Option<PhaseIdentity>,
    name: &'static str,
}
impl PhaseSpan {
    fn new(identity: Option<&PhaseIdentity>, name: &'static str) -> Self {
        phase_stamp(identity, name, "start");
        Self {
            identity: identity.cloned(),
            name,
        }
    }
}
impl Drop for PhaseSpan {
    fn drop(&mut self) {
        phase_stamp(self.identity.as_ref(), self.name, "end");
    }
}
#[cfg(target_arch = "wasm32")]
fn phase_stamp(identity: Option<&PhaseIdentity>, name: &str, edge: &str) {
    if let Some(identity) = identity {
        let label = if identity.run_id.is_empty() || identity.renderer_instance_id.is_empty() {
            format!("cc:rust-exec:{}:{name}:{edge}", identity.operation_id)
        } else {
            format!(
                "canvas-profile/1:{}",
                serde_json::json!({
                    "runId": identity.run_id,
                    "rendererInstanceId": identity.renderer_instance_id,
                    "operationId": identity.operation_id,
                    "phase": format!("rust.{name}"),
                    "edge": edge,
                })
            )
        };
        web_sys::console::time_stamp_with_data(&wasm_bindgen::JsValue::from_str(&label));
    }
}
#[cfg(not(target_arch = "wasm32"))]
fn phase_stamp(_identity: Option<&PhaseIdentity>, _name: &str, _edge: &str) {}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentResult {
    pub operation_id: Option<u32>,
    pub presented: bool,
    pub revision: Option<u64>,
    /// Draws submitted by this present, including the surface draw.
    pub draws: usize,
    pub resource_pending: usize,
    pub unsupported_commands: usize,
    pub backend: String,
    pub max_texture_side: u32,
    pub max_sampled_textures: u32,
    pub draw_calls: u64,
    pub buffer_creations: u64,
    pub texture_creations: u64,
    pub upload_bytes: u64,
    pub instance_upload_bytes: u64,
    pub completed_presents: u64,
    pub incremental_patches: u64,
    pub geometry_rebuilds: u64,
    pub wasm_calls: u64,
    pub error: Option<String>,
    /// Damage present only (`set_damage_present(true)`); absent otherwise.
    /// `"partial"`: the picture was redrawn inside the damage rectangles;
    /// `"full"`: it was redrawn whole; `"skip"`: nothing changed on screen,
    /// so no picture pass, no surface copy and no `queue.present` ran (the
    /// canvas keeps showing the previous, still-correct frame).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub damage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub damage_stats: Option<DamageStats>,
    /// The present mode (`surface`, `direct`, `preserved`, `preserved-desync`).
    pub present: &'static str,
    /// Pixels this present wrote to the canvas's default framebuffer: 0 on a skip or failure, the
    /// whole surface for wgpu's present or a full canvas present, the damage area for a preserved
    /// partial.
    pub blit_pixels: u64,
}
/// Cumulative damage-present counters, reported only while it is enabled.
#[derive(serde::Serialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct DamageStats {
    pub partial_presents: u64,
    pub full_presents: u64,
    pub skipped_presents: u64,
    /// Device pixels redrawn by partial presents.
    pub partial_pixels: u64,
    /// Draw calls issued by partial picture passes (clears included).
    pub partial_draws: u64,
    /// `set_damage_verify(true)` only: partial plans the brute-force check
    /// found incomplete; each one was replaced by a full redraw. The check
    /// shares the planner's bounds model (`damage::instance_bounds`), so it
    /// catches bookkeeping slips (a stale per-draw bound, a missed span or
    /// dirty key), not a wrong bounds model, and it is not pixel evidence.
    /// Exactness is proven by pixel comparison against a full redraw.
    pub verify_mismatches: u64,
    pub verify_checks: u64,
}
/// What the committed picture holds, while the damage present can trust it:
/// exactly `draws` over the committed instances, at `projection`, with every
/// resource except `damage_dirty_keys` as currently uploaded.
struct DamageState {
    picture: usize,
    projection: Projection,
    draws: Vec<Draw>,
    /// Conservative device bounds per draw, aligned with `draws`.
    bounds: Vec<DeviceRect>,
}
enum DamagePlan {
    /// The damage present is disabled: today's full redraw, untouched.
    Off,
    Full,
    /// Redraw `rects` in place. `selection[d]` holds every pixel draw `d`
    /// can write after this present; `touched` lists draws whose stored
    /// bounds must be recomputed once the present commits. Empty `rects`
    /// is a skipped present.
    Partial {
        rects: DamageSet,
        selection: Vec<DeviceRect>,
        touched: Vec<usize>,
        resource_changed: Vec<usize>,
    },
}
/// Put back the draw slots a failed present renamed in place (newest first), and drop those draws' cached
/// bind groups, which were built for the renamed lists.
fn undo_slot_renames<T>(
    draws: &mut [Draw],
    bind_cache: &mut [Option<T>],
    undo: &mut Vec<(usize, usize, Option<String>)>,
) {
    for (draw, slot, previous) in undo.drain(..).rev() {
        draws[draw].resources[slot] = previous;
        if let Some(bind) = bind_cache.get_mut(draw) {
            *bind = None;
        }
    }
}
/// What [`plan_damage`] reads of the renderer: the committed picture's damage bookkeeping and draw table.
struct DamageInputs<'a> {
    enabled: bool,
    state: Option<&'a DamageState>,
    committed_picture: Option<usize>,
    /// Configured surface size in device pixels.
    surface: (u32, u32),
    committed: &'a Geometry,
    dirty_keys: &'a HashSet<String>,
}
/// Decide how much of the committed picture this present must redraw.
/// Pure CPU; reads only committed state (`inputs`) and this present's candidate.
fn plan_damage(
    inputs: &DamageInputs,
    candidate: Option<&Geometry>,
    candidate_dirty: Option<&[(usize, usize)]>,
    delta: Option<&[(usize, Vec<Instance>)]>,
    design_size: Option<(u32, u32)>,
) -> DamagePlan {
    if !inputs.enabled {
        return DamagePlan::Off;
    }
    let (Some(state), Some((design_width, design_height))) = (inputs.state, design_size)
    else {
        return DamagePlan::Full;
    };
    let projection =
        Projection::new(inputs.surface.0, inputs.surface.1, design_width, design_height);
    let old = inputs.committed;
    if inputs.committed_picture != Some(state.picture)
        || state.projection != projection
        || state.draws.len() != old.draws.len()
    {
        return DamagePlan::Full;
    }
    // A delta renames draw slots in the committed table in place before planning, so the committed draws are
    // the ones this present renders; `state.draws` still holds what the picture was drawn with.
    let new_draws = candidate
        .map(|g| g.draws.as_slice())
        .unwrap_or(old.draws.as_slice());
    if new_draws.len() != state.draws.len()
        || candidate.is_some_and(|g| {
            g.instances.len() != old.instances.len() || g.command_ranges != old.command_ranges
        })
        || new_draws.iter().zip(&state.draws).any(|(new, held)| {
            new.start != held.start || new.count != held.count || new.blend != held.blend
        })
    {
        return DamagePlan::Full;
    }
    let surface = projection.full().area();
    let mut rects = DamageSet::default();
    let mut selection = state.bounds.clone();
    let mut touched = Vec::new();
    // `false` turns the plan into a full redraw: an instance outside the
    // draw table, or damage already past half the surface (stop diffing).
    let mut changed = |index: usize, before: &Instance, after: &Instance| -> bool {
        let Some(draw) = damage::draw_of(new_draws, index) else {
            return false;
        };
        rects.add(damage::instance_bounds(before, &projection));
        let after_bounds = damage::instance_bounds(after, &projection);
        rects.add(after_bounds);
        selection[draw] = selection[draw].union(&after_bounds);
        if touched.last() != Some(&draw) {
            touched.push(draw);
        }
        rects.area() * 2 <= surface
    };
    if let Some(g) = candidate {
        let Some(ranges) = candidate_dirty else {
            return DamagePlan::Full;
        };
        for &(start, end) in ranges {
            for index in start..end {
                if !changed(index, &old.instances[index], &g.instances[index]) {
                    return DamagePlan::Full;
                }
            }
        }
    } else if let Some(spans) = delta {
        for (start, instances) in spans {
            for (offset, after) in instances.iter().enumerate() {
                let index = start + offset;
                let Some(before) = old.instances.get(index) else {
                    return DamagePlan::Full;
                };
                if before != after && !changed(index, before, after) {
                    return DamagePlan::Full;
                }
            }
        }
    }
    // A draw whose texture list or texture contents changed repaints its
    // whole old footprint; its new footprint is that plus the changed
    // instances' new bounds, already in `rects`.
    let mut resource_changed = Vec::new();
    for (index, (draw, held)) in new_draws.iter().zip(&state.draws).enumerate() {
        let swapped = draw.resources != held.resources;
        let rewritten = !inputs.dirty_keys.is_empty()
            && draw
                .resources
                .iter()
                .flatten()
                .any(|key| inputs.dirty_keys.contains(key));
        if swapped || rewritten {
            rects.add(state.bounds[index]);
            resource_changed.push(index);
        }
    }
    touched.sort_unstable();
    touched.dedup();
    if rects.area() * 2 > surface {
        return DamagePlan::Full;
    }
    DamagePlan::Partial {
        rects,
        selection,
        touched,
        resource_changed,
    }
}

pub struct Renderer<B: GpuBackend = WgpuBackend> {
    backend: B,
    /// Configured surface size in device pixels (at least 1x1).
    width: u32,
    height: u32,
    /// The design size the backend holds: a present writes it only when it changes.
    design_globals_size: Option<(u32, u32)>,
    textures: HashMap<String, B::Texture>,
    /// One slot per draw index in the geometry currently being rendered.
    /// `None` means "not built yet" (or invalidated). The hot path: a hit
    /// costs an index read and a handle clone, no string work at all.
    bind_cache: Vec<Option<B::Bind>>,
    /// Keyed by a draw's resource-key list, surviving a full rebuild that
    /// resets `bind_cache` — see `resolve_draw_binds`. This is what gives a
    /// full rebuild with no resource upload zero new bind groups, the
    /// property the renderer had before `bind_cache` was indexed by draw.
    content_bind_cache: HashMap<Vec<Option<String>>, B::Bind>,
    /// Bumped only when a committed scene's `resources` list actually
    /// changed content from the previous one: a fresh `admit_scene` with a
    /// different list (see where `self.state = staged` is set in `present`),
    /// or a patch that carries a `resources` list (`commit_delta`, which also
    /// moves `resource_index_cache` to the new epoch in place).
    committed_resource_epoch: u64,
    /// Draw slots the present in progress renamed in place, with their previous keys (see `failed`).
    slot_undo: Vec<(usize, usize, Option<String>)>,
    /// `key -> Resource` index for `geometry::patch_spans_with_cache`,
    /// cached under `committed_resource_epoch`.
    resource_index_cache: ResourceIndexCache,
    committed_picture: Option<usize>,
    /// Instances the backend's buffer holds; 0 until the first scene (no buffer yet).
    instance_capacity: usize,
    committed_geometry: Geometry,
    pub resources: ResourceStore,
    pub state: SceneState,
    staged: Option<SceneState>,
    staged_patch_ids: Option<Vec<String>>,
    staged_delta: Option<PatchDelta>,
    admitted_dimensions_epoch: u64,
    pub upload_calls: u64,
    pub upload_bytes: u64,
    pub instance_upload_bytes: u64,
    pub texture_creations: u64,
    pub buffer_creations: u64,
    pub draw_calls: u64,
    pub completed_presents: u64,
    pub incremental_patches: u64,
    pub geometry_rebuilds: u64,
    pub wasm_calls: Cell<u64>,
    pub present_calls: u64,
    phase_identity: Option<PhaseIdentity>,
    active_operation_id: Option<u32>,
    /// wgpu-core 30 re-emits program + vertex-attribute GL state on every
    /// `set_pipeline`, even a repeat of the last one — most draws in a pass
    /// share a pipeline (mix vs add blend), so a per-pass "did it change"
    /// check skips that work. Runtime-gated: `false` (the default)
    /// reproduces today's call sequence exactly; see `set_draw_state_dedupe`.
    draw_state_dedupe: bool,
    /// Runtime-gated damage present (`set_damage_present`). `false` (the
    /// default) reproduces today's full redraw and present exactly.
    damage_present: bool,
    damage_verify: bool,
    damage: Option<DamageState>,
    /// Keys whose texture changed (any upload op) since the picture last
    /// accounted for them. Recorded only while the damage present is on.
    damage_dirty_keys: HashSet<String>,
    damage_stats: DamageStats,
    last_damage: Option<&'static str>,
    /// Pixels the last present wrote to the canvas's default framebuffer.
    last_blit_pixels: u64,
    /// The installed idle animations (`set_idle_anims`), valid while the committed revision is theirs.
    idle: Option<IdleSet>,
    idle_stats: IdleStats,
    /// The last `present_idle`'s full present result (diagnostics and the integration gate; never on the frame path).
    idle_last_result: Option<PresentResult>,
    #[cfg(feature = "fault-injection")]
    validation_failure_once: bool,
}
/// Cumulative `present_idle` counters (`idle_stats`).
#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct IdleStats {
    pub installs: u64,
    pub install_refusals: u64,
    pub presents: u64,
    /// Presents whose poses moved no command (f32 equal to the committed ones): nothing staged.
    pub unchanged: u64,
    pub partial: u64,
    pub full: u64,
    pub skipped: u64,
    pub refusals: u64,
    pub commands_moved: u64,
    pub last_error: Option<String>,
}
/// `present_idle` result bits. 0 is a refusal (`idle_stats().lastError` says why); a presented frame sets
/// `IDLE_PRESENTED` plus how its picture was produced.
pub const IDLE_PRESENTED: u32 = 1;
pub const IDLE_SKIP: u32 = 2;
pub const IDLE_PARTIAL: u32 = 4;
pub const IDLE_FULL: u32 = 8;
pub const IDLE_UNCHANGED: u32 = 16;
// A batch may touch the same key repeatedly. Stage only those keys while consulting
// committed GPU residency for each key's first operation.
fn validate_gpu_changes(
    changes: &[ResourceChange],
    contains_key: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let mut present: HashMap<&str, bool> = HashMap::new();
    for change in changes {
        let key = change.key();
        let exists = *present.entry(key).or_insert_with(|| contains_key(key));
        match change {
            ResourceChange::Allocate { .. } if exists => {
                return Err("allocation key already exists on GPU".into());
            }
            ResourceChange::Allocate { .. } | ResourceChange::Replace { .. } => {
                present.insert(key, true);
            }
            ResourceChange::Subrect { .. } if !exists => {
                return Err("subrect texture missing on GPU".into());
            }
            ResourceChange::Release { .. } => {
                present.insert(key, false);
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod gpu_preflight_tests {
    use super::*;

    fn allocate(key: &str) -> ResourceChange {
        ResourceChange::Allocate {
            key: key.into(),
            width: 2,
            height: 2,
            format: ResourceFormat::Linear,
        }
    }
    fn subrect(key: &str) -> ResourceChange {
        ResourceChange::Subrect {
            key: key.into(),
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            pixels: vec![0; 4],
        }
    }
    fn release(key: &str) -> ResourceChange {
        ResourceChange::Release { key: key.into() }
    }

    #[test]
    fn ordered_touched_key_presence() {
        assert!(validate_gpu_changes(&[allocate("new"), subrect("new")], |_| false).is_ok());
        assert!(
            validate_gpu_changes(&[release("old"), allocate("old")], |key| key == "old").is_ok()
        );
        assert!(
            validate_gpu_changes(&[release("old"), subrect("old")], |key| key == "old").is_err()
        );
        assert!(validate_gpu_changes(&[allocate("new"), allocate("new")], |_| false).is_err());
        assert!(validate_gpu_changes(&[allocate("new"), subrect("missing")], |_| false).is_err());
    }
}

/// Resolve the bind group for each draw in `draws`, through two cooperating
/// caches:
/// - `per_draw`, one slot per draw index — the hot path. A hit costs an
///   index read and a cheap handle clone, no string work at all.
///   `incremental = false` means `geometry::build` just produced a brand
///   new draw table (not a patch): a draw at a given index may now mean
///   something completely different than it did last frame, so every slot
///   is reset first. `incremental = true` (the delta-patch /
///   `patch_instances` steady state) guarantees each index still refers to
///   the same draw with the same resource keys — see
///   `geometry::patch_instances` and `patch_spans`, both of which refuse
///   (forcing a full rebuild instead) the moment a patched command's
///   resource or blend would differ from before — so existing slots are
///   trusted as-is and only a length mismatch (first frame, or recovering
///   from a discarded candidate) grows the vector.
/// - `by_content`, keyed by a draw's resource-key list — untouched by a
///   full rebuild (only `invalidate_binds_for_resource_changes` below
///   touches it), so a draw whose resource list matches one seen under any
///   earlier draw index reuses that bind group instead of building a new
///   one. This is the property the renderer had before per-draw indexing
///   (content-keyed, one `wgpu::BindGroup` per distinct list): a full
///   rebuild with no resource upload in between must build zero new bind
///   groups, since every list it could possibly produce is already here.
///
/// Never call this with an empty `draws` for a present that has nothing to
/// render: `per_draw` would reset to length 0 and discard every cached
/// slot for no reason — skip the call entirely instead (see `present`'s
/// call site and the `empty_present_must_not_touch_the_cache` test).
///
/// `build` runs only for a draw whose resource list is new to *both*
/// caches.
fn resolve_draw_binds<T: Clone>(
    per_draw: &mut Vec<Option<T>>,
    by_content: &mut HashMap<Vec<Option<String>>, T>,
    draws: &[Draw],
    incremental: bool,
    mut build: impl FnMut(&[Option<String>]) -> T,
) -> Vec<T> {
    if !incremental {
        per_draw.clear();
    }
    if per_draw.len() != draws.len() {
        per_draw.resize_with(draws.len(), || None);
    }
    draws
        .iter()
        .enumerate()
        .map(|(index, draw)| {
            if let Some(bind) = per_draw[index].clone() {
                return bind;
            }
            if let Some(bind) = by_content.get(&draw.resources) {
                let bind = bind.clone();
                per_draw[index] = Some(bind.clone());
                return bind;
            }
            let bind = build(&draw.resources);
            per_draw[index] = Some(bind.clone());
            by_content.insert(draw.resources.clone(), bind.clone());
            bind
        })
        .collect()
}

/// Invalidate both caches for exactly the resource keys that changed in one
/// upload batch: one pass to collect the changed-key set (excluding
/// `Subrect`, which writes into the existing texture in place and so never
/// invalidates anything), then one pass over `draws` for `per_draw` and one
/// `retain` over `by_content`.
fn invalidate_binds_for_resource_changes<T>(
    per_draw: &mut [Option<T>],
    by_content: &mut HashMap<Vec<Option<String>>, T>,
    draws: &[Draw],
    changes: &[ResourceChange],
) {
    let changed_keys: std::collections::HashSet<&str> = changes
        .iter()
        .filter(|change| !matches!(change, ResourceChange::Subrect { .. }))
        .map(ResourceChange::key)
        .collect();
    if changed_keys.is_empty() {
        return;
    }
    let references_changed =
        |resources: &[Option<String>]| {
            resources
                .iter()
                .any(|r| r.as_deref().is_some_and(|key| changed_keys.contains(key)))
        };
    for (index, draw) in draws.iter().enumerate() {
        if index < per_draw.len() && references_changed(&draw.resources) {
            per_draw[index] = None;
        }
    }
    by_content.retain(|resources, _| !references_changed(resources));
}

#[cfg(test)]
mod plan_damage_tests {
    use super::*;
    use crate::contract::Scene;

    fn scene(first_key: &str) -> Scene {
        let quad = |id: &str, key: &str, x: f32| {
            serde_json::json!({"id":id,"kind":"rasterText","resource":key,"m":[1,0,0,1,x,0],"w":10,"h":8,
                "src":[0,0,10,8],"color":[1,1,1,1],"blend":"mix","flipH":false,"flipV":false,"colorMatrix":null})
        };
        serde_json::from_value(serde_json::json!({"version":2,"revision":1,"width":100,"height":100,
            "designWidth":100,"designHeight":100,
            "resources":[{"key":first_key,"width":10,"height":8},{"key":"other","width":10,"height":8}],
            "commands":[quad("clock", first_key, 10.0), quad("name", "other", 60.0)]}))
        .unwrap()
    }

    /// An equal-size raster swap keeps every instance byte; only the draw's slot names a new key. Production
    /// renames the committed table in place before planning while `DamageState.draws` still holds the keys the
    /// picture was drawn with; the plan must damage that draw's footprint (its old bounds), not skip the present.
    #[test]
    fn an_equal_size_slot_rename_damages_the_renamed_draw() {
        let old = geometry::build(&scene("text:04:00"));
        let projection = Projection::new(100, 100, 100, 100);
        let state = DamageState {
            picture: 0,
            projection,
            draws: old.draws.clone(),
            bounds: old
                .draws
                .iter()
                .map(|draw| damage::draw_bounds(draw, &old.instances, &projection))
                .collect(),
        };
        let dirty = HashSet::new();
        // The replaced command's span, byte-identical to what it was.
        let spans = vec![(0usize, vec![old.instances[0]])];
        let plan_for = |committed: &Geometry| {
            plan_damage(
                &DamageInputs {
                    enabled: true,
                    state: Some(&state),
                    committed_picture: Some(0),
                    surface: (100, 100),
                    committed,
                    dirty_keys: &dirty,
                },
                None,
                None,
                Some(&spans),
                Some((100, 100)),
            )
        };
        assert!(matches!(&plan_for(&old), DamagePlan::Partial { rects, .. } if rects.is_empty()));
        let mut renamed = old.clone();
        renamed.draws[0].resources[0] = Some("text:04:01".into());
        let DamagePlan::Partial { rects, resource_changed, .. } = plan_for(&renamed) else {
            panic!("an equal-size swap should be a partial redraw");
        };
        assert_eq!(resource_changed, vec![0]);
        assert!(rects.covers(&state.bounds[0]));
        assert_eq!(rects.area(), state.bounds[0].area());
    }

    /// A failed present restores the slots it renamed in place, newest first, and drops those draws' binds.
    #[test]
    fn a_failed_present_restores_renamed_slots() {
        let mut draws = geometry::build(&scene("text:04:00")).draws;
        let original = draws.clone();
        let mut binds = vec![Some(1u32); draws.len()];
        let mut undo = Vec::new();
        for key in ["text:04:01", "text:04:02"] {
            let previous = std::mem::replace(&mut draws[0].resources[0], Some(key.into()));
            undo.push((0, 0, previous));
        }
        undo_slot_renames(&mut draws, &mut binds, &mut undo);
        assert_eq!(draws, original);
        assert!(undo.is_empty());
        assert_eq!(binds[0], None);
    }
}

#[cfg(test)]
mod bind_cache_tests {
    use super::*;
    use crate::contract::Blend;
    use std::cell::Cell;

    fn draw(resources: &[Option<&str>]) -> Draw {
        Draw {
            start: 0,
            count: 1,
            resources: resources.iter().map(|r| r.map(String::from)).collect(),
            blend: Blend::Mix,
        }
    }

    /// A `build` stand-in that counts its own calls, so a test can assert
    /// "this many (and no more) bind groups were actually built" the same
    /// way the real `wgpu::BindGroup`-creating closure would be counted via
    /// `texture_creations`-style diagnostics, without a GPU device.
    fn counting_build(counter: &Cell<u32>) -> impl FnMut(&[Option<String>]) -> u32 + '_ {
        move |_resources| {
            counter.set(counter.get() + 1);
            counter.get()
        }
    }

    #[test]
    fn full_rebuild_with_no_upload_builds_zero_new_binds() {
        let draws_a = vec![draw(&[Some("a")]), draw(&[Some("b")]), draw(&[Some("c")])];
        let mut per_draw = Vec::new();
        let mut by_content = HashMap::new();
        let calls = Cell::new(0u32);
        resolve_draw_binds(&mut per_draw, &mut by_content, &draws_a, false, counting_build(&calls));
        assert_eq!(calls.get(), 3);

        // A full rebuild (`incremental = false` — exactly what an
        // `admit_scene` from an unrelated text-only change produces) whose
        // draws reference the SAME resource lists, just reordered under a
        // different draw table, and with no resource upload in between.
        let draws_b = vec![draw(&[Some("c")]), draw(&[Some("a")]), draw(&[Some("b")])];
        resolve_draw_binds(&mut per_draw, &mut by_content, &draws_b, false, counting_build(&calls));
        assert_eq!(
            calls.get(),
            3,
            "no new bind groups: every resource list was already in by_content"
        );
    }

    #[test]
    fn full_rebuild_still_builds_for_a_genuinely_new_resource_list() {
        let draws_a = vec![draw(&[Some("a")])];
        let mut per_draw = Vec::new();
        let mut by_content = HashMap::new();
        let calls = Cell::new(0u32);
        resolve_draw_binds(&mut per_draw, &mut by_content, &draws_a, false, counting_build(&calls));
        assert_eq!(calls.get(), 1);

        let draws_b = vec![draw(&[Some("a")]), draw(&[Some("new")])];
        resolve_draw_binds(&mut per_draw, &mut by_content, &draws_b, false, counting_build(&calls));
        assert_eq!(calls.get(), 2, "the unseen list \"new\" builds; the seen list \"a\" reuses");
    }

    #[test]
    fn incremental_steady_state_builds_nothing_again() {
        let draws = vec![draw(&[Some("a")]), draw(&[Some("b")])];
        let mut per_draw = Vec::new();
        let mut by_content = HashMap::new();
        let calls = Cell::new(0u32);
        resolve_draw_binds(&mut per_draw, &mut by_content, &draws, false, counting_build(&calls));
        assert_eq!(calls.get(), 2);
        let binds =
            resolve_draw_binds(&mut per_draw, &mut by_content, &draws, true, counting_build(&calls));
        assert_eq!(calls.get(), 2, "every slot already held a per-draw hit");
        assert_eq!(binds.len(), 2);
    }

    #[test]
    fn incremental_keeps_existing_slots_and_grows_as_needed() {
        let draws_a = vec![draw(&[Some("a")]), draw(&[Some("b")])];
        let mut per_draw = Vec::new();
        let mut by_content = HashMap::new();
        let calls = Cell::new(0u32);
        resolve_draw_binds(&mut per_draw, &mut by_content, &draws_a, false, counting_build(&calls));
        assert_eq!(calls.get(), 2);
        let draws_b = vec![
            draw(&[Some("a")]),
            draw(&[Some("b")]),
            draw(&[Some("new")]),
            draw(&[Some("new2")]),
        ];
        resolve_draw_binds(&mut per_draw, &mut by_content, &draws_b, true, counting_build(&calls));
        assert_eq!(per_draw.len(), 4);
        assert_eq!(calls.get(), 4, "two existing slots reused untouched, two new ones built");
    }

    /// Documents why `present` must skip `resolve_draw_binds` entirely for
    /// an empty present (nothing staged, no patch — the no-op `presentScene`
    /// couch calls routinely, `createPixiMirrorRenderer.ts:1376`): calling
    /// it anyway, even just to get an empty `Vec` back, wipes a populated
    /// cache for no reason, forcing every draw to rebuild on the next real
    /// patch.
    #[test]
    fn empty_draws_call_would_wipe_a_populated_cache() {
        let mut per_draw: Vec<Option<u32>> = vec![Some(1), Some(2)];
        let mut by_content: HashMap<Vec<Option<String>>, u32> = HashMap::new();
        let calls = Cell::new(0u32);
        let binds =
            resolve_draw_binds(&mut per_draw, &mut by_content, &[], false, counting_build(&calls));
        assert!(binds.is_empty());
        assert!(
            per_draw.is_empty(),
            "an empty, non-incremental call resets per-draw slots to length 0 — \
             present() must guard against calling this when there is nothing to render"
        );
    }

    #[test]
    fn release_invalidates_only_draws_and_content_entries_referencing_that_key() {
        let draws = vec![
            draw(&[Some("a")]),
            draw(&[Some("b")]),
            draw(&[Some("a"), Some("c")]),
        ];
        let mut per_draw = vec![Some(1u32), Some(2u32), Some(3u32)];
        let mut by_content: HashMap<Vec<Option<String>>, u32> = [
            (draws[0].resources.clone(), 1u32),
            (draws[1].resources.clone(), 2u32),
            (draws[2].resources.clone(), 3u32),
        ]
        .into_iter()
        .collect();
        let changes = vec![ResourceChange::Release { key: "a".into() }];
        invalidate_binds_for_resource_changes(&mut per_draw, &mut by_content, &draws, &changes);
        assert_eq!(
            per_draw,
            vec![None, Some(2), None],
            "only the draws naming the released key rebind; draw 1 (key b) is untouched"
        );
        assert_eq!(by_content.len(), 1, "only the content entry naming key b survives");
        assert!(by_content.contains_key(&draws[1].resources));
    }

    #[test]
    fn replace_invalidates_only_draws_referencing_that_key() {
        let draws = vec![draw(&[Some("atlas")]), draw(&[Some("other")])];
        let mut per_draw = vec![Some(1u32), Some(2u32)];
        let mut by_content: HashMap<Vec<Option<String>>, u32> = HashMap::new();
        let changes = vec![ResourceChange::Replace {
            key: "atlas".into(),
            width: 4,
            height: 4,
            format: ResourceFormat::Linear,
            pixels: vec![0; 64],
        }];
        invalidate_binds_for_resource_changes(&mut per_draw, &mut by_content, &draws, &changes);
        assert_eq!(per_draw, vec![None, Some(2)]);
    }

    #[test]
    fn subrect_never_invalidates() {
        let draws = vec![draw(&[Some("atlas")])];
        let mut per_draw = vec![Some(1u32)];
        let mut by_content: HashMap<Vec<Option<String>>, u32> = HashMap::new();
        let changes = vec![ResourceChange::Subrect {
            key: "atlas".into(),
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            pixels: vec![0; 4],
        }];
        invalidate_binds_for_resource_changes(&mut per_draw, &mut by_content, &draws, &changes);
        assert_eq!(
            per_draw,
            vec![Some(1)],
            "a subrect writes the same texture in place; the bind group stays valid"
        );
    }

    #[test]
    fn allocate_of_an_unreferenced_key_touches_nothing() {
        let draws = vec![draw(&[Some("atlas")])];
        let mut per_draw = vec![Some(1u32)];
        let mut by_content: HashMap<Vec<Option<String>>, u32> = HashMap::new();
        let changes = vec![ResourceChange::Allocate {
            key: "new-key".into(),
            width: 2,
            height: 2,
            format: ResourceFormat::Linear,
        }];
        invalidate_binds_for_resource_changes(&mut per_draw, &mut by_content, &draws, &changes);
        assert_eq!(per_draw, vec![Some(1)]);
    }
}

impl Renderer<WgpuBackend> {
    pub async fn new(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let backend = WgpuBackend::new(instance, surface, width, height).await?;
        Ok(Self::with_backend(backend, width, height))
    }
    /// The direct present (`mode` is not `Surface`): create `canvas`'s WebGL2 context with the
    /// mode's attributes and build the adapter on it. No `wgpu::Surface` exists; `present` draws
    /// the committed picture into the canvas itself.
    #[cfg(target_arch = "wasm32")]
    pub async fn new_direct(
        instance: &wgpu::Instance,
        canvas: web_sys::HtmlCanvasElement,
        mode: PresentMode,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let backend = WgpuBackend::new_direct(instance, canvas, mode, width, height).await?;
        Ok(Self::with_backend(backend, width, height))
    }
}
impl<B: GpuBackend> Renderer<B> {
    /// A renderer over a constructed backend whose output is `width` x `height`.
    pub fn with_backend(backend: B, width: u32, height: u32) -> Self {
        let max_side = backend.max_texture_side();
        let (texture_creations, buffer_creations) = backend.creation_baseline();
        Self {
            backend,
            width: width.max(1),
            height: height.max(1),
            design_globals_size: None,
            textures: HashMap::new(),
            bind_cache: Vec::new(),
            content_bind_cache: HashMap::new(),
            committed_resource_epoch: 0,
            slot_undo: Vec::new(),
            resource_index_cache: None,
            committed_picture: None,
            instance_capacity: 0,
            committed_geometry: Geometry::default(),
            resources: ResourceStore::with_max_side(max_side),
            state: SceneState::default(),
            staged: None,
            staged_patch_ids: None,
            staged_delta: None,
            admitted_dimensions_epoch: 0,
            upload_calls: 0,
            upload_bytes: 0,
            instance_upload_bytes: 0,
            texture_creations,
            buffer_creations,
            draw_calls: 0,
            completed_presents: 0,
            incremental_patches: 0,
            geometry_rebuilds: 0,
            wasm_calls: Cell::new(0),
            present_calls: 0,
            phase_identity: None,
            active_operation_id: None,
            draw_state_dedupe: false,
            damage_present: false,
            damage_verify: false,
            damage: None,
            damage_dirty_keys: HashSet::new(),
            damage_stats: DamageStats::default(),
            last_damage: None,
            last_blit_pixels: 0,
            idle: None,
            idle_stats: IdleStats::default(),
            idle_last_result: None,
            #[cfg(feature = "fault-injection")]
            validation_failure_once: false,
        }
    }
    pub fn backend_name(&self) -> &str {
        self.backend.name()
    }
    pub fn present_mode(&self) -> PresentMode {
        self.backend.present_mode()
    }
    /// Opt into the pipeline-dedupe draw path (default `false`: unchanged).
    /// One artifact serves both A/B arms this way.
    pub fn set_draw_state_dedupe(&mut self, enabled: bool) {
        self.draw_state_dedupe = enabled;
    }
    /// Opt into the damage present (default `false`: unchanged). While on, a
    /// patch redraws only the picture pixels it can change, in place, and a
    /// present with nothing to change skips the GPU entirely. The first
    /// present after enabling is a full redraw.
    pub fn set_damage_present(&mut self, enabled: bool) {
        if enabled && self.backend.ensure_damage_clear() {
            self.texture_creations += 1;
        }
        if enabled != self.damage_present {
            self.damage = None;
            self.damage_dirty_keys.clear();
        }
        self.damage_present = enabled;
    }
    /// Brute-force check of every partial plan, re-derived from the full old
    /// and new instance arrays instead of the spans and stored per-draw
    /// bounds the planner used (diagnostic; CPU cost proportional to the
    /// scene). It reuses the same bounds model and dirty-key set, so it is a
    /// bookkeeping check, not pixel evidence — see `DamageStats`.
    pub fn set_damage_verify(&mut self, enabled: bool) {
        self.damage_verify = enabled;
    }
    pub fn set_phase_operation_id(&mut self, id: u32) {
        self.phase_identity = (id > 0).then_some(PhaseIdentity {
            run_id: String::new(),
            renderer_instance_id: String::new(),
            operation_id: id,
        });
    }
    pub fn set_phase_identity(&mut self, run_id: String, renderer_instance_id: String, id: u32) {
        self.phase_identity = (id > 0 && !run_id.is_empty() && !renderer_instance_id.is_empty())
            .then_some(PhaseIdentity {
                run_id,
                renderer_instance_id,
                operation_id: id,
            });
    }
    pub fn gpu_timer_capability(&self) -> serde_json::Value {
        self.backend.timer_capability()
    }
    pub fn record_wasm_call(&self) {
        self.wasm_calls.set(self.wasm_calls.get() + 1);
    }
    #[cfg(feature = "fault-injection")]
    pub fn debug_validation_failure_once(&mut self) {
        self.validation_failure_once = true;
    }
    pub fn max_texture_side(&self) -> u32 {
        self.backend.max_texture_side()
    }
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        let max = self.max_texture_side();
        if width.max(height) > max {
            return Err(format!(
                "surface {width}x{height} exceeds max texture side {max}"
            ));
        }
        self.width = width.max(1);
        self.height = height.max(1);
        self.backend.resize(width, height);
        // The backend recreated both pictures and the surface quad.
        self.texture_creations += 2;
        self.buffer_creations += 1;
        self.committed_picture = None;
        self.damage = None;
        self.staged = None;
        self.staged_patch_ids = None;
        self.staged_delta = None;
        // Full clear: draw indices and their bind groups are revalidated from
        // scratch on the next present rather than trusted across a resize.
        self.bind_cache.clear();
        Ok(())
    }
    pub fn upload_rgba_batch(&mut self, bytes: &[u8]) -> Result<usize, String> {
        let _phase = PhaseSpan::new(self.phase_identity.as_ref(), "upload");
        let batch = self.resources.plan_batch(bytes)?;
        let changed = &batch.changes;
        validate_gpu_changes(changed, |key| self.textures.contains_key(key))?;
        let uploaded_pixels: usize = changed.iter().map(ResourceChange::byte_len).sum();
        let mut created = 0;
        for change in changed {
            match change {
                ResourceChange::Allocate {
                    key,
                    width,
                    height,
                    format,
                } => {
                    let texture = self.backend.create_texture(*width, *height, *format, None);
                    if let Some(old) = self.textures.insert(key.clone(), texture) {
                        self.backend.release_texture(old);
                    }
                    created += 1;
                }
                ResourceChange::Replace {
                    key,
                    width,
                    height,
                    format,
                    pixels,
                } => {
                    let texture =
                        self.backend
                            .create_texture(*width, *height, *format, Some(pixels));
                    if let Some(old) = self.textures.insert(key.clone(), texture) {
                        self.backend.release_texture(old);
                    }
                    created += 1;
                }
                ResourceChange::Subrect {
                    key,
                    x,
                    y,
                    width,
                    height,
                    pixels,
                } => {
                    let texture = self
                        .textures
                        .get(key)
                        .ok_or("subrect texture missing on GPU")?;
                    self.backend
                        .write_texture(texture, *x, *y, *width, *height, pixels);
                }
                ResourceChange::Release { key } => {
                    if let Some(texture) = self.textures.remove(key) {
                        self.backend.release_texture(texture);
                    }
                }
            }
        }
        let changed_len = changed.len();
        let has_changes = !changed.is_empty();
        if self.damage_present {
            // Any op, `Subrect` included: the pixels a draw samples changed
            // even when its bind group stays valid.
            self.damage_dirty_keys
                .extend(changed.iter().map(|change| change.key().to_owned()));
        }
        // Targeted, not wholesale: an allocate/replace/release only affects the
        // committed draws (and cached content-keyed groups) that actually
        // reference that key (a `Subrect` keeps the same texture/view
        // identity, so it never needs this). Everything else — the vast
        // majority on a typical change, such as one Bitmap text key
        // releasing — stays valid.
        if has_changes {
            invalidate_binds_for_resource_changes(
                &mut self.bind_cache,
                &mut self.content_bind_cache,
                &self.committed_geometry.draws,
                changed,
            );
        }
        self.resources.commit_batch(batch);
        // Every owned pixel buffer in the plan is dropped here, after the queue copied its bytes.
        self.upload_calls += 1;
        self.upload_bytes += uploaded_pixels as u64;
        self.texture_creations += created;
        Ok(changed_len)
    }
    pub fn admit_scene(&mut self, bytes: &[u8]) -> Admission {
        let _phase = PhaseSpan::new(self.phase_identity.as_ref(), "admit");
        self.staged_patch_ids = None;
        self.staged_delta = None;
        let mut candidate = SceneState::default();
        let result = candidate.admit(bytes, &self.resources);
        if result.accepted {
            let scene = candidate.scene().expect("accepted scene");
            if scene.commands.iter().any(|command| match command {
                Command::GlyphRun { atlas, .. } => self
                    .resources
                    .entries
                    .get(atlas)
                    .is_none_or(|resource| resource.format != ResourceFormat::Linear),
                _ => false,
            }) {
                return Admission {
                    accepted: false,
                    revision: None,
                    unsupported_commands: 0,
                    resource_pending: 0,
                    error: Some("glyph atlas must be linear RGBA8".into()),
                };
            }
            let latest_revision = self
                .state
                .scene()
                .into_iter()
                .chain(self.staged.as_ref().and_then(|staged| staged.scene()))
                .map(|scene| scene.revision)
                .max();
            if latest_revision.is_some_and(|revision| scene.revision <= revision) {
                self.staged = None;
                return Admission {
                    accepted: false,
                    revision: None,
                    unsupported_commands: 0,
                    resource_pending: 0,
                    error: Some("version or revision mismatch".into()),
                };
            }
            if scene.width != self.width || scene.height != self.height {
                self.staged = None;
                return Admission {
                    accepted: false,
                    revision: None,
                    unsupported_commands: 0,
                    resource_pending: 0,
                    error: Some(format!(
                        "scene surface {}x{} does not match configured {}x{}",
                        scene.width, scene.height, self.width, self.height
                    )),
                };
            }
            self.staged = Some(candidate);
        } else {
            self.state.refused_total += result.unsupported_commands;
            self.staged = None;
        }
        result
    }
    pub fn apply_patch(&mut self, bytes: &[u8]) -> Admission {
        let _phase = PhaseSpan::new(self.phase_identity.as_ref(), "admit");
        let patch: Patch = match serde_json::from_slice(bytes) {
            Ok(patch) => patch,
            Err(error) => {
                return Admission {
                    accepted: false,
                    revision: None,
                    unsupported_commands: 0,
                    resource_pending: 0,
                    error: Some(error.to_string()),
                };
            }
        };
        if patch.updates.iter().any(|update| match &update.command {
            Command::GlyphRun { atlas, .. } => self
                .resources
                .entries
                .get(atlas)
                .is_none_or(|resource| resource.format != ResourceFormat::Linear),
            _ => false,
        }) {
            return Admission {
                accepted: false,
                revision: None,
                unsupported_commands: 0,
                resource_pending: 0,
                error: Some("glyph atlas must be linear RGBA8".into()),
            };
        }
        if self.staged.is_none()
            && self.staged_delta.is_none()
            && self.state.scene().is_some()
            && patch.updates.iter().all(|u| {
                u.command.quad().is_some()
                    || matches!(u.command, Command::ClipPush { .. } | Command::GlyphRun { .. })
            })
        {
            // A patch that installs a new resource list always checks the keys it adds against what is
            // resident; the rest only when residency changed size since the last admission.
            let check_resident = self.resources.dimensions_epoch != self.admitted_dimensions_epoch;
            match self.state.preflight_delta(&patch, &self.resources, check_resident) {
                Ok(delta) => {
                    self.staged_delta = Some(delta);
                    return Admission {
                        accepted: true,
                        revision: Some(patch.revision),
                        unsupported_commands: 0,
                        resource_pending: 0,
                        error: None,
                    };
                }
                Err(error) => {
                    return Admission {
                        accepted: false,
                        revision: None,
                        unsupported_commands: 0,
                        resource_pending: 0,
                        error: Some(error),
                    };
                }
            }
        }
        let patch_ids = patch
            .updates
            .iter()
            .map(|update| update.id.clone())
            .collect::<Vec<_>>();
        let had_staged = self.staged.is_some();
        let had_delta = self.staged_delta.is_some();
        let mut candidate = SceneState::default();
        if let Some(scene) = self
            .staged
            .as_ref()
            .or(Some(&self.state))
            .and_then(|s| s.scene())
        {
            candidate.set_scene(scene.clone());
        }
        if let Some(delta) = self.staged_delta.take() {
            let mut materialized = candidate.scene().expect("delta base").clone();
            delta.apply_into(&mut materialized);
            candidate.set_scene(materialized);
        }
        let result = candidate.patch_parsed(patch, &self.resources);
        if result.accepted {
            let scene = candidate.scene().expect("accepted patch");
            if scene.width != self.width || scene.height != self.height {
                self.staged = None;
                return Admission {
                    accepted: false,
                    revision: None,
                    unsupported_commands: 0,
                    resource_pending: 0,
                    error: Some("patch surface does not match configured surface".into()),
                };
            }
            self.staged = Some(candidate);
            if had_delta {
                self.staged_patch_ids = None;
            } else if !had_staged && self.state.scene().is_some() {
                self.staged_patch_ids = Some(patch_ids);
            } else if let (Some(existing), Some(mut ids)) =
                (self.staged_patch_ids.as_mut(), Some(patch_ids))
            {
                existing.append(&mut ids);
            }
        } else {
            self.staged = None;
            self.staged_patch_ids = None;
            self.staged_delta = None;
        }
        result
    }
    pub async fn present(&mut self) -> PresentResult {
        self.present_now()
    }
    /// Install the idle animations for the committed revision (`RIA1`, see [`crate::idle`]). Returns the
    /// number of targets. A refused set leaves no set installed.
    pub fn set_idle_anims(&mut self, bytes: &[u8]) -> Result<u32, String> {
        self.idle = None;
        let installed = (|| {
            let set = IdleSet::decode(bytes)?;
            let scene = self.state.scene().ok_or("no committed scene")?;
            if scene.revision != set.base_revision {
                return Err(format!(
                    "idle set for revision {} but {} is committed",
                    set.base_revision, scene.revision
                ));
            }
            let mut seen = HashSet::new();
            for target in &set.targets {
                if !seen.insert(target.command) {
                    return Err("idle set names a command twice".into());
                }
                match scene.commands.get(target.command) {
                    Some(
                        Command::Quad { .. }
                        | Command::NinePatch { .. }
                        | Command::RasterText { .. }
                        | Command::StillImage { .. }
                        | Command::GlyphRun { .. },
                    ) => {}
                    Some(_) => return Err("idle target is not a placed command".into()),
                    None => return Err("idle target index out of range".into()),
                }
            }
            Ok(set)
        })();
        match installed {
            Ok(set) => {
                let count = set.targets.len() as u32;
                self.idle = Some(set);
                self.idle_stats.installs += 1;
                Ok(count)
            }
            Err(error) => {
                self.idle_stats.install_refusals += 1;
                self.idle_stats.last_error = Some(error.clone());
                Err(error)
            }
        }
    }
    pub fn clear_idle_anims(&mut self) {
        self.idle = None;
    }
    pub fn idle_stats(&self) -> &IdleStats {
        &self.idle_stats
    }
    pub fn idle_last_result(&self) -> Option<&PresentResult> {
        self.idle_last_result.as_ref()
    }
    /// The installed set's command matrices at `t_ms` (f64, six per target), for parity checks.
    pub fn idle_poses(&self, t_ms: f64) -> Vec<f64> {
        self.idle
            .as_ref()
            .map(|set| set.evaluate(t_ms).into_iter().flatten().collect())
            .unwrap_or_default()
    }
    /// One idle frame: re-pose every installed target at `t_ms` and present synchronously through the patch
    /// path (instance spans, damage plan, the same validation). The scene revision does not change, so the
    /// caller's next patch applies on top. Refused (0) while anything is staged, when no set is installed for
    /// the committed revision, or before a first picture.
    pub fn present_idle(&mut self, t_ms: f64) -> u32 {
        let refuse = |this: &mut Self, error: &str| {
            this.idle_stats.refusals += 1;
            this.idle_stats.last_error = Some(error.to_owned());
            0
        };
        if self.staged.is_some() || self.staged_delta.is_some() {
            return refuse(self, "a scene or patch is staged");
        }
        if self.committed_picture.is_none() {
            return refuse(self, "no completed picture");
        }
        if !t_ms.is_finite() {
            return refuse(self, "non-finite idle clock");
        }
        let staged = (|| {
            let (Some(set), Some(scene)) = (self.idle.as_ref(), self.state.scene()) else {
                return Err("no idle set installed");
            };
            if scene.revision != set.base_revision {
                return Err("idle set is stale");
            }
            let mut updates = Vec::new();
            for (target, m) in set.targets.iter().zip(set.evaluate(t_ms)) {
                let m = m.map(|value| value as f32);
                let committed = &scene.commands[target.command];
                let current = match committed {
                    Command::GlyphRun { m, .. } => m,
                    other => &other.quad().expect("installed targets are placed commands").m,
                };
                if *current == m {
                    continue;
                }
                let mut command = committed.clone();
                match &mut command {
                    Command::GlyphRun { m: slot, .. } => *slot = m,
                    Command::Quad { quad, .. }
                    | Command::NinePatch { quad, .. }
                    | Command::RasterText { quad, .. }
                    | Command::StillImage { quad, .. } => quad.m = m,
                    Command::ClipPush { .. } | Command::ClipPop { .. } => unreachable!(),
                }
                updates.push((target.command, command));
            }
            Ok((scene.revision, updates))
        })();
        let (revision, updates) = match staged {
            Ok(staged) => staged,
            Err(error) => return refuse(self, error),
        };
        let moved = updates.len() as u64;
        if !updates.is_empty() {
            self.staged_delta = Some(PatchDelta {
                revision,
                updates,
                resources: None,
            });
        }
        let result = self.present_now();
        let presented = result.presented;
        let error = result.error.clone();
        self.idle_last_result = Some(result);
        if !presented {
            return refuse(self, error.as_deref().unwrap_or("idle present failed"));
        }
        self.idle_stats.presents += 1;
        self.idle_stats.commands_moved += moved;
        let mut code = IDLE_PRESENTED;
        if moved == 0 {
            self.idle_stats.unchanged += 1;
            code |= IDLE_UNCHANGED;
        }
        match self.last_damage {
            Some("partial") => {
                self.idle_stats.partial += 1;
                code |= IDLE_PARTIAL;
            }
            Some("skip") => {
                self.idle_stats.skipped += 1;
                code |= IDLE_SKIP;
            }
            _ => {
                self.idle_stats.full += 1;
                code |= IDLE_FULL;
            }
        }
        code
    }
    fn present_now(&mut self) -> PresentResult {
        let phase_identity = self.phase_identity.take();
        self.active_operation_id = phase_identity
            .as_ref()
            .map(|identity| identity.operation_id);
        let prepare_phase = PhaseSpan::new(phase_identity.as_ref(), "prepare");
        self.present_calls += 1;
        self.last_damage = None;
        self.last_blit_pixels = 0;
        let candidate_scene = self
            .staged
            .as_ref()
            .and_then(|s| s.scene())
            .or_else(|| self.staged_delta.as_ref().and_then(|_| self.state.scene()));
        if let Some(scene) = candidate_scene {
            if scene.width != self.width || scene.height != self.height {
                return self.failed("scene surface does not match configured surface", 0, 0);
            }
            let delta_resources = self
                .staged_delta
                .as_ref()
                .and_then(|delta| delta.resources.as_deref());
            let pending = if self.staged_delta.is_some()
                && delta_resources.is_none()
                && self.resources.dimensions_epoch == self.admitted_dimensions_epoch
            {
                0
            } else {
                delta_resources
                    .unwrap_or(&scene.resources)
                    .iter()
                    .filter(|r| {
                        !self.textures.contains_key(&r.key)
                            || self
                                .resources
                                .entries
                                .get(&r.key)
                                .map(|p| (p.width, p.height))
                                != Some((r.width, r.height))
                    })
                    .count()
            };
            if pending > 0 {
                return self.failed("textures missing on GPU", pending, 0);
            }
        }
        if candidate_scene.is_none() && self.committed_picture.is_none() {
            return self.failed("no completed picture", 0, 0);
        }
        // Damage present: nothing staged means nothing on screen can change.
        // The canvas still shows the last presented frame, so skip the
        // surface copy and `queue.present` entirely. A skip acquires no
        // surface texture, so it cannot observe a Lost/Outdated surface;
        // the next present with a change does. A resize never reaches this
        // skip: it drops `committed_picture`, so the next present fails
        // ("no completed picture") until a full scene is drawn.
        if self.damage_present && candidate_scene.is_none() && !self.fault_armed() {
            self.damage_stats.skipped_presents += 1;
            self.last_damage = Some("skip");
            return self.result(true, 0, None, 0);
        }
        let design_size = candidate_scene.map(|scene| (scene.design_width, scene.design_height));
        let resource_epoch = self.committed_resource_epoch;
        let mut delta_spans = None;
        // Draw slots a resource-replacing patch points at its new keys (see `patch_spans_renaming`).
        let mut slot_renames: Vec<geometry::SlotRename> = Vec::new();
        if let (Some(delta), Some(scene)) = (self.staged_delta.as_ref(), self.state.scene()) {
            let committed_geometry = &self.committed_geometry;
            let state = &self.state;
            delta_spans = geometry::patch_spans_renaming(
                committed_geometry,
                scene,
                &delta.updates,
                |index| state.clips_at(index).copied(),
                &mut self.resource_index_cache,
                resource_epoch,
                delta.resources.as_deref(),
            )
            .map(|patch| {
                slot_renames = patch.renames;
                patch.spans
            });
        }
        let mut incremental = delta_spans.is_some();
        let candidate_geometry = self.staged.as_ref().and_then(|s| s.scene()).map(|scene| {
            if let Some(patched) = self.staged_patch_ids.as_ref().and_then(|ids| {
                self.state.scene().and_then(|old| {
                    geometry::patch_instances(&self.committed_geometry, old, scene, ids)
                })
            }) {
                incremental = true;
                patched
            } else {
                geometry::build(scene)
            }
        });
        let fallback_geometry = if self.staged_delta.is_some() && delta_spans.is_none() {
            let mut next = self.state.scene().expect("delta base").clone();
            self.staged_delta.as_ref().expect("delta").apply_to(&mut next);
            Some(geometry::build(&next))
        } else {
            None
        };
        let candidate_geometry = candidate_geometry.or(fallback_geometry);
        // One instance diff per present, shared by the damage plan and the
        // instance upload below. Without the damage present it is computed
        // only where the upload uses it (an unchanged draw table), as before.
        let candidate_same_layout = candidate_geometry
            .as_ref()
            .map(|g| geometry::same_layout(&self.committed_geometry, g));
        let mut candidate_dirty = candidate_geometry.as_ref().and_then(|g| {
            (g.instances.len() == self.committed_geometry.instances.len()
                && (self.damage_present || candidate_same_layout == Some(true)))
                .then(|| geometry::dirty_ranges(&self.committed_geometry.instances, &g.instances))
        });
        // A slot rename keeps every draw's place and range; only the renamed draws bind differently, so
        // their cached bind groups are dropped and the rest stay. The committed draws are renamed in place
        // (no table copy); `slot_undo` puts them back if this present fails (`failed`).
        for rename in slot_renames.drain(..) {
            let slot = &mut self.committed_geometry.draws[rename.draw].resources[rename.slot];
            let previous = std::mem::replace(slot, Some(rename.key));
            self.slot_undo.push((rename.draw, rename.slot, previous));
            if let Some(bind) = self.bind_cache.get_mut(rename.draw) {
                *bind = None;
            }
        }
        // The damage plan sees the draw table this present renders, renames included: a renamed slot can
        // change a draw's pixels while every instance byte stays equal (an equal-size text swap).
        let mut plan = self.plan_damage(
            candidate_geometry.as_ref(),
            candidate_dirty.as_deref(),
            delta_spans.as_deref(),
            design_size,
        );
        if self.damage_verify
            && matches!(plan, DamagePlan::Partial { .. })
            && !self.verify_damage_plan(
                &plan,
                candidate_geometry.as_ref(),
                delta_spans.as_deref(),
            )
        {
            self.damage_stats.verify_mismatches += 1;
            plan = DamagePlan::Full;
        }
        let partial_rects = match &plan {
            DamagePlan::Partial { rects, .. } => Some(rects.rects()),
            _ => None,
        };
        // An empty partial plan changes no pixel: no picture pass, no copy,
        // no frame acquisition, no present. The state still commits below.
        let skip = partial_rects.is_some_and(|rects| rects.is_empty()) && !self.fault_armed();
        // The canvas regions this present will write, captured before `plan` commits below. A
        // preserved canvas takes only a partial plan's rectangles (`present::blit_regions`).
        let blit_partial = partial_rects.map(<[DeviceRect]>::to_vec);
        let frame = if skip {
            None
        } else {
            match self.backend.acquire_frame() {
                Ok(frame) => frame,
                Err(error) => return self.failed(&error, 0, 0),
            }
        };
        // Surface: an acquired frame means this present renders and presents. Canvas: no frame
        // exists; it renders (and draws into the canvas) whenever it does not skip.
        let render = !skip;
        // The surface copy is one draw of its own; the direct present's canvas draw is not counted.
        let surface_draws = usize::from(frame.is_some());
        let target = if candidate_geometry.is_some() || delta_spans.is_some() {
            // A partial plan redraws the committed picture in place (its
            // pixels outside the damage are the ones being kept); a full
            // redraw alternates pictures as before.
            Some(match (&plan, self.committed_picture) {
                (DamagePlan::Partial { .. }, Some(committed)) => committed,
                (_, committed) => committed.map_or(0, |i| 1 - i),
            })
        } else {
            None
        };
        let scope = self.backend.begin_validation();
        let mut draws = surface_draws;
        let mut dirty = Vec::new();
        if let Some(spans) = delta_spans.as_ref() {
            draws += self.committed_geometry.draws.len();
            for (start, instances) in spans {
                if instances.is_empty() {
                    continue;
                }
                let end = start + instances.len();
                self.backend.write_instances(*start, instances);
                let bytes = std::mem::size_of_val(instances.as_slice()) as u64;
                self.upload_bytes += bytes;
                self.instance_upload_bytes += bytes;
                dirty.push((*start, end));
            }
        }
        if let Some(ref g) = candidate_geometry {
            draws += g.draws.len();
            let needed = g.instances.len().max(1);
            if needed > self.instance_capacity {
                self.instance_capacity = needed.next_power_of_two();
                self.backend.grow_instances(self.instance_capacity);
                self.buffer_creations += 1;
                dirty.push((0, g.instances.len()));
            } else if candidate_same_layout == Some(true) {
                dirty = candidate_dirty.take().unwrap_or_else(|| {
                    geometry::dirty_ranges(&self.committed_geometry.instances, &g.instances)
                });
            } else {
                dirty.push((0, g.instances.len()));
            }
            for &(start, end) in &dirty {
                if start < end {
                    let instances = &g.instances[start..end];
                    self.backend.write_instances(start, instances);
                    let bytes = std::mem::size_of_val(instances) as u64;
                    self.upload_bytes += bytes;
                    self.instance_upload_bytes += bytes;
                }
            }
        }
        // No clone or hash of any draw's resource keys on a cache hit: the
        // cache is addressed by draw index, and `incremental` (established
        // above) already tells us whether this frame's draw table is the
        // same one the cache was built against.
        let render_draws: &[Draw] = if let Some(g) = candidate_geometry.as_ref() {
            g.draws.as_slice()
        } else if delta_spans.is_some() {
            self.committed_geometry.draws.as_slice()
        } else {
            &[]
        };
        // An empty present (nothing staged, no patch — couch's no-op
        // `presentScene` calls, `createPixiMirrorRenderer.ts:1376`) renders
        // nothing and must leave the bind caches exactly as they were:
        // `resolve_draw_binds` resets `bind_cache` to the new (here, zero)
        // length whenever `incremental` is false, which this frame's always
        // is when there's nothing staged or patched — see
        // `empty_draws_call_would_wipe_a_populated_cache`.
        // A skipped present still resolves binds: a draw whose texture list
        // changed off screen must not leave a stale per-draw slot behind.
        let binds: Vec<B::Bind> = if render_draws.is_empty() {
            Vec::new()
        } else {
            let backend = &self.backend;
            let textures = &self.textures;
            resolve_draw_binds(
                &mut self.bind_cache,
                &mut self.content_bind_cache,
                render_draws,
                incremental,
                |resources| build_texture_bind(backend, textures, resources),
            )
        };
        if let Some((design_width, design_height)) = design_size
            && self.design_globals_size != design_size
        {
            self.backend.write_design_size(design_width, design_height);
            self.design_globals_size = design_size;
        }
        drop(prepare_phase);
        let encode_phase = PhaseSpan::new(phase_identity.as_ref(), "encode-submit");
        let render_geometry = candidate_geometry
            .as_ref()
            .or_else(|| delta_spans.as_ref().map(|_| &self.committed_geometry));
        let mut partial_work = (0u64, 0u64);
        // The picture the canvas shows after this present: the one just drawn, else the committed one.
        let shown_picture = target.or(self.committed_picture);
        if render {
            let picture = match (render_geometry, target) {
                (Some(g), Some(target)) => Some(PicturePass {
                    target,
                    draws: &g.draws,
                    binds: &binds,
                    region: match &plan {
                        DamagePlan::Partial {
                            rects, selection, ..
                        } => PictureRegion::Partial {
                            rects: rects.rects(),
                            selection,
                        },
                        _ => PictureRegion::Full {
                            dedupe_pipelines: self.draw_state_dedupe,
                        },
                    },
                }),
                _ => None,
            };
            #[cfg(feature = "fault-injection")]
            let inject_validation_failure = std::mem::take(&mut self.validation_failure_once);
            #[cfg(not(feature = "fault-injection"))]
            let inject_validation_failure = false;
            let partial = self.backend.encode(FrameWork {
                picture,
                surface_copy: frame
                    .as_ref()
                    .map(|frame| (frame, shown_picture.expect("picture exists"))),
                inject_validation_failure,
            });
            if let Some((issued, pixels)) = partial {
                draws = surface_draws + issued;
                partial_work = (issued as u64, pixels);
            }
        } else {
            draws = 0;
        }
        self.draw_calls += draws as u64;
        drop(encode_phase);
        // The validation future may suspend here. Its initial poll and wait are unclassified.
        phase_stamp(phase_identity.as_ref(), "validation.wait", "start");
        let validation = self.backend.end_validation(scope);
        phase_stamp(phase_identity.as_ref(), "validation.wait", "end");
        let _resume_phase = PhaseSpan::new(phase_identity.as_ref(), "resume");
        if let Err(error) = validation {
            // A refused submission may not have written the design size: write it again next time.
            self.design_globals_size = None;
            self.restore_instances(&dirty);
            self.staged = None;
            self.staged_patch_ids = None;
            self.staged_delta = None;
            // The discarded candidate may have populated `bind_cache` slots
            // that no longer line up with the committed draw table (which
            // this present never replaced). Realign rather than leave a
            // length match masking stale content at a reused index.
            // `content_bind_cache` needs no such reset: a resource-list's
            // bind group is correct independent of which candidate it was
            // built for.
            self.bind_cache = vec![None; self.committed_geometry.draws.len()];
            // A refused command buffer runs nothing, but the next present
            // need not rely on that: it redraws the picture whole.
            self.damage = None;
            return self.failed(&format!("GPU validation: {error}"), 0, draws);
        }
        // Past validation this present commits: whatever it renamed in place stays renamed.
        self.slot_undo.clear();
        if let Some(frame) = frame {
            self.backend.present_frame(frame);
            self.completed_presents += 1;
            self.last_blit_pixels = u64::from(self.width) * u64::from(self.height);
        } else if render {
            match self
                .backend
                .present_picture(shown_picture.expect("picture exists"), blit_partial.as_deref())
            {
                Ok(pixels) => self.last_blit_pixels = pixels,
                Err(error) => {
                    // The picture may already hold this candidate, so drop the damage state: the
                    // next present redraws and copies whole.
                    self.damage = None;
                    return self.failed(&format!("canvas present: {error}"), 0, draws);
                }
            }
            self.completed_presents += 1;
        }
        if let Some(g) = candidate_geometry {
            if incremental {
                self.incremental_patches += 1;
            } else {
                self.geometry_rebuilds += 1;
            }
            self.committed_geometry = g;
            self.committed_picture = target;
            if let Some(staged) = self.staged.take() {
                // This branch commits on both an `admit_scene` and an
                // `apply_patch` candidate. Most patches carry the previous
                // resources list forward byte-for-byte; a fresh admission or
                // a patch with a `resources` list may not. Compare rather
                // than assume: only a genuinely different list invalidates
                // `resource_index_cache`, so a run of ordinary patches — the
                // common case — keeps reusing it.
                let resources_changed = staged.scene().map(|s| &s.resources)
                    != self.state.scene().map(|s| &s.resources);
                self.state = staged;
                self.admitted_dimensions_epoch = self.resources.dimensions_epoch;
                if resources_changed {
                    self.committed_resource_epoch += 1;
                }
            } else if let Some(delta) = self.staged_delta.take() {
                self.commit_delta(delta);
            }
            self.staged_patch_ids = None;
        } else if let Some(spans) = delta_spans.take() {
            for (start, instances) in spans {
                let end = start + instances.len();
                self.committed_geometry.instances[start..end].copy_from_slice(&instances);
            }
            let delta = self.staged_delta.take().expect("delta exists");
            self.commit_delta(delta);
            self.committed_picture = target;
            self.incremental_patches += 1;
        }
        self.damage_stats.partial_draws += partial_work.0;
        self.damage_stats.partial_pixels += partial_work.1;
        self.commit_damage(plan, design_size);
        self.result(true, draws, None, 0)
    }
    /// Decide how much of the committed picture this present must redraw (see [`plan_damage`]).
    fn plan_damage(
        &self,
        candidate: Option<&Geometry>,
        candidate_dirty: Option<&[(usize, usize)]>,
        delta: Option<&[(usize, Vec<Instance>)]>,
        design_size: Option<(u32, u32)>,
    ) -> DamagePlan {
        plan_damage(
            &DamageInputs {
                enabled: self.damage_present,
                state: self.damage.as_ref(),
                committed_picture: self.committed_picture,
                surface: (self.width, self.height),
                committed: &self.committed_geometry,
                dirty_keys: &self.damage_dirty_keys,
            },
            candidate,
            candidate_dirty,
            delta,
            design_size,
        )
    }
    /// Independent brute-force check of a partial plan: recompute every
    /// bound from the full old and new instance arrays rather than from the
    /// spans and the stored per-draw bounds the plan used.
    fn verify_damage_plan(
        &mut self,
        plan: &DamagePlan,
        candidate: Option<&Geometry>,
        delta: Option<&[(usize, Vec<Instance>)]>,
    ) -> bool {
        let DamagePlan::Partial {
            rects, selection, ..
        } = plan
        else {
            return true;
        };
        let Some(state) = self.damage.as_ref() else {
            return false;
        };
        self.damage_stats.verify_checks += 1;
        let projection = state.projection;
        let old = &self.committed_geometry;
        let new_instances: Vec<Instance> = match (candidate, delta) {
            (Some(g), _) => g.instances.clone(),
            (None, Some(spans)) => {
                let mut next = old.instances.clone();
                for (start, instances) in spans {
                    next[*start..start + instances.len()].copy_from_slice(instances);
                }
                next
            }
            (None, None) => old.instances.clone(),
        };
        let new_draws = candidate
            .map(|g| g.draws.as_slice())
            .unwrap_or(old.draws.as_slice());
        let old_bounds: Vec<_> = state
            .draws
            .iter()
            .map(|draw| damage::draw_bounds(draw, &old.instances, &projection))
            .collect();
        if old_bounds
            .iter()
            .zip(&state.bounds)
            .any(|(exact, held)| !held.contains(exact))
        {
            return false;
        }
        for (before, after) in old.instances.iter().zip(&new_instances) {
            if before != after
                && !(rects.covers(&damage::instance_bounds(before, &projection))
                    && rects.covers(&damage::instance_bounds(after, &projection)))
            {
                return false;
            }
        }
        for (index, draw) in new_draws.iter().enumerate() {
            let new_bounds = damage::draw_bounds(draw, &new_instances, &projection);
            let resources_changed = draw.resources != state.draws[index].resources
                || draw
                    .resources
                    .iter()
                    .flatten()
                    .any(|key| self.damage_dirty_keys.contains(key));
            if resources_changed && !(rects.covers(&old_bounds[index]) && rects.covers(&new_bounds))
            {
                return false;
            }
            if rects
                .rects()
                .iter()
                .any(|rect| new_bounds.intersects(rect) && !selection[index].intersects(rect))
            {
                return false;
            }
        }
        true
    }
    /// Fault-injection builds only: a validation failure is armed for the
    /// next encoded present, so that present must not be skipped.
    fn fault_armed(&self) -> bool {
        #[cfg(feature = "fault-injection")]
        {
            self.validation_failure_once
        }
        #[cfg(not(feature = "fault-injection"))]
        {
            false
        }
    }
    /// After a successful present: record what the committed picture now
    /// holds, so the next patch can trust it.
    fn commit_damage(&mut self, plan: DamagePlan, design_size: Option<(u32, u32)>) {
        let projection = design_size.map(|(design_width, design_height)| {
            Projection::new(self.width, self.height, design_width, design_height)
        });
        let picture = self.committed_picture;
        match plan {
            DamagePlan::Off => {
                self.damage = None;
            }
            DamagePlan::Partial {
                rects,
                touched,
                resource_changed,
                ..
            } => {
                let (Some(projection), Some(state)) = (projection, self.damage.as_mut()) else {
                    self.damage = None;
                    return;
                };
                let g = &self.committed_geometry;
                for index in touched.into_iter().chain(resource_changed.iter().copied()) {
                    state.bounds[index] = damage::draw_bounds(&g.draws[index], &g.instances, &projection);
                }
                for index in resource_changed {
                    state.draws[index].resources.clone_from(&g.draws[index].resources);
                }
                self.damage_dirty_keys.clear();
                if rects.is_empty() {
                    self.damage_stats.skipped_presents += 1;
                    self.last_damage = Some("skip");
                } else {
                    self.damage_stats.partial_presents += 1;
                    self.last_damage = Some("partial");
                }
            }
            DamagePlan::Full => {
                let (Some(projection), Some(picture)) = (projection, picture) else {
                    self.damage = None;
                    return;
                };
                let g = &self.committed_geometry;
                self.damage = Some(DamageState {
                    picture,
                    projection,
                    draws: g.draws.clone(),
                    bounds: g
                        .draws
                        .iter()
                        .map(|draw| damage::draw_bounds(draw, &g.instances, &projection))
                        .collect(),
                });
                self.damage_dirty_keys.clear();
                self.damage_stats.full_presents += 1;
                self.last_damage = Some("full");
            }
        }
    }
    /// Commit a presented patch delta. A replaced resource list is admitted like a fresh scene's: the
    /// resource index cache moves to a new epoch and the list was checked against what is resident.
    fn commit_delta(&mut self, delta: PatchDelta) {
        let resources_changed = delta.resources.as_ref().is_some_and(|next| {
            self.state.scene().is_none_or(|scene| &scene.resources != next)
        });
        self.state.commit_delta(delta);
        if resources_changed {
            let from = self.committed_resource_epoch;
            self.committed_resource_epoch += 1;
            self.admitted_dimensions_epoch = self.resources.dimensions_epoch;
            // A text tick swaps one key: move the index along instead of rebuilding it next tick.
            if let Some(scene) = self.state.scene() {
                geometry::update_resource_index(
                    &mut self.resource_index_cache,
                    from,
                    self.committed_resource_epoch,
                    &scene.resources,
                );
            }
        }
    }
    fn restore_instances(&mut self, dirty: &[(usize, usize)]) {
        // No capacity means no instance buffer yet: nothing was written.
        if self.instance_capacity > 0 {
            for &(start, end) in dirty {
                let end = end.min(self.committed_geometry.instances.len());
                if start < end {
                    let instances = &self.committed_geometry.instances[start..end];
                    self.backend.write_instances(start, instances);
                    self.upload_bytes += std::mem::size_of_val(instances) as u64;
                }
            }
        }
    }
    fn failed(&mut self, error: &str, pending: usize, draws: usize) -> PresentResult {
        // A present that renamed draw slots in place and then failed restores the committed table.
        undo_slot_renames(&mut self.committed_geometry.draws, &mut self.bind_cache, &mut self.slot_undo);
        self.staged = None;
        self.staged_patch_ids = None;
        self.staged_delta = None;
        self.result(false, draws, Some(error.into()), pending)
    }
    fn result(
        &self,
        presented: bool,
        draws: usize,
        error: Option<String>,
        pending: usize,
    ) -> PresentResult {
        PresentResult {
            operation_id: self.active_operation_id,
            presented,
            revision: self.state.scene().map(|s| s.revision),
            draws,
            resource_pending: pending,
            unsupported_commands: self.state.refused_total,
            backend: self.backend.name().to_owned(),
            max_texture_side: self.max_texture_side(),
            max_sampled_textures: self.backend.sampled_texture_slots(),
            draw_calls: self.draw_calls,
            buffer_creations: self.buffer_creations,
            texture_creations: self.texture_creations,
            upload_bytes: self.upload_bytes,
            instance_upload_bytes: self.instance_upload_bytes,
            completed_presents: self.completed_presents,
            incremental_patches: self.incremental_patches,
            geometry_rebuilds: self.geometry_rebuilds,
            wasm_calls: self.wasm_calls.get(),
            error,
            damage: self.damage_present.then_some(self.last_damage).flatten(),
            damage_stats: self.damage_present.then_some(self.damage_stats),
            present: self.present_mode().name(),
            blit_pixels: self.last_blit_pixels,
        }
    }
}
/// Build a fresh bind for one draw's resource slots: a resident texture per named key, white
/// otherwise. A free function (not a `&self` method) so a caller can borrow the backend and
/// `textures` individually and still hold other fields of `Renderer` mutably at the same time —
/// see `resolve_draw_binds`'s call site in `present`. Does not consult or populate any cache itself.
fn build_texture_bind<B: GpuBackend>(
    backend: &B,
    textures: &HashMap<String, B::Texture>,
    resources: &[Option<String>],
) -> B::Bind {
    let slots: [Option<&B::Texture>; TEXTURE_SLOTS] = std::array::from_fn(|i| {
        resources
            .get(i)
            .and_then(|r| r.as_ref())
            .and_then(|key| textures.get(key))
    });
    backend.create_bind(&slots)
}
