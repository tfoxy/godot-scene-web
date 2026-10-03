//! Ordered instanced wgpu executor shared by browser WebGL2 and native harnesses.
use crate::{
    contract::{Admission, Blend, Command, Patch, PatchDelta, Quad, SCENE_VERSION, Scene, SceneState},
    damage::{self, DamageSet, DeviceRect, Projection},
    geometry::{self, Draw, Geometry, Instance, ResourceIndexCache, TEXTURE_SLOTS},
    present::PresentMode,
    resources::{ResourceChange, ResourceFormat, ResourceStore},
};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use wgpu::util::DeviceExt;

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

struct TextureEntry {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
}
struct Picture {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    bind: wgpu::BindGroup,
}
/// Where a present puts the committed picture (see [`crate::present`]).
enum Output {
    /// wgpu's surface: copy pass into the acquired texture, then wgpu-hal's present draw.
    Surface(wgpu::Surface<'static>),
    /// A canvas whose WebGL2 context this renderer created: one present draw from the picture.
    #[cfg(target_arch = "wasm32")]
    Canvas(crate::present::canvas::CanvasPresenter),
}
pub struct Renderer {
    output: Output,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    surface_globals: wgpu::Buffer,
    surface_globals_bind: wgpu::BindGroup,
    design_globals: wgpu::Buffer,
    design_globals_bind: wgpu::BindGroup,
    pipelines: [wgpu::RenderPipeline; 2],
    copy_pipeline: wgpu::RenderPipeline,
    texture_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    textures: HashMap<String, TextureEntry>,
    /// One slot per draw index in the geometry currently being rendered.
    /// `None` means "not built yet" (or invalidated). The hot path: a hit
    /// costs an index read and a handle clone, no string work at all.
    bind_cache: Vec<Option<wgpu::BindGroup>>,
    /// Keyed by a draw's resource-key list, surviving a full rebuild that
    /// resets `bind_cache` — see `resolve_draw_binds`. This is what gives a
    /// full rebuild with no resource upload zero new bind groups, the
    /// property the renderer had before `bind_cache` was indexed by draw.
    content_bind_cache: HashMap<Vec<Option<String>>, wgpu::BindGroup>,
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
    white: TextureEntry,
    pictures: [Picture; 2],
    committed_picture: Option<usize>,
    instance_buffer: Option<wgpu::Buffer>,
    instance_capacity: usize,
    committed_geometry: Geometry,
    fullscreen_buffer: wgpu::Buffer,
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
    backend: String,
    adapter_info: wgpu::AdapterInfo,
    adapter_timestamp_query_supported: bool,
    adapter_texture_slots: u32,
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
    /// A 1x1 transparent texture bound to the copy pipeline: drawn under a
    /// scissor it clears exactly the damaged pixels, which `LoadOp::Clear`
    /// cannot (it ignores the scissor). Created on first enable.
    damage_clear: Option<(TextureEntry, wgpu::BindGroup)>,
    damage_stats: DamageStats,
    last_damage: Option<&'static str>,
    /// Pixels the last present wrote to the canvas's default framebuffer.
    last_blit_pixels: u64,
    #[cfg(feature = "fault-injection")]
    validation_failure_once: bool,
}
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

impl Renderer {
    pub async fn new(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::LowPower,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
                apply_limit_buckets: false,
            })
            .await
            .map_err(|e| e.to_string())?;
        Self::with_adapter(adapter, Output::Surface(surface), width, height).await
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
        if mode == PresentMode::Surface {
            return Err("the surface present mode uses Renderer::new".into());
        }
        let context = crate::present::canvas::create_context(&canvas, mode.context_attributes())?;
        // SAFETY: the context was just created and is not lost; the renderer keeps the canvas
        // (and so the context) alive at least as long as the device built on it.
        let exposed = unsafe {
            wgpu::hal::gles::Adapter::new_external(context, wgpu::GlBackendOptions::default())
        }
        .ok_or("WebGL2 adapter unavailable on the created context")?;
        // SAFETY: the WebGL GLES instance holds no per-instance adapter state; any GL instance
        // accepts an adapter exposed from an external context.
        let adapter = unsafe { instance.create_adapter_from_hal(exposed) };
        let presenter = crate::present::canvas::CanvasPresenter::new(canvas, mode);
        Self::with_adapter(adapter, Output::Canvas(presenter), width, height).await
    }
    async fn with_adapter(
        adapter: wgpu::Adapter,
        mut output: Output,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let adapter_info = adapter.get_info();
        let adapter_timestamp_query_supported =
            adapter.features().contains(wgpu::Features::TIMESTAMP_QUERY);
        let backend = match adapter_info.backend {
            wgpu::Backend::Gl if cfg!(target_arch = "wasm32") => "webgl2".to_string(),
            wgpu::Backend::Gl => "gles".to_string(),
            wgpu::Backend::Vulkan => "vulkan".to_string(),
            wgpu::Backend::BrowserWebGpu => "webgpu".to_string(),
            other => format!("{other:?}"),
        };
        let actual = adapter.limits();
        if actual.max_sampled_textures_per_shader_stage < TEXTURE_SLOTS as u32 {
            return Err(format!(
                "8 texture slots required; adapter provides {}",
                actual.max_sampled_textures_per_shader_stage
            ));
        }
        let mut requested = wgpu::Limits::downlevel_webgl2_defaults();
        requested.max_texture_dimension_2d = actual.max_texture_dimension_2d;
        requested.max_sampled_textures_per_shader_stage = TEXTURE_SLOTS as u32;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                required_limits: requested,
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())?;
        let max_side = device.limits().max_texture_dimension_2d;
        if width.max(height) > max_side {
            return Err(format!(
                "surface {width}x{height} exceeds max texture side {max_side}"
            ));
        }
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let config = match &mut output {
            Output::Surface(surface) => {
                let config = surface
                    .get_default_config(&adapter, width.max(1), height.max(1))
                    .ok_or("surface unsupported")?;
                surface.configure(&device, &config);
                config
            }
            #[cfg(target_arch = "wasm32")]
            Output::Canvas(presenter) => {
                presenter.set_size(width.max(1), height.max(1));
                // Never configured; it carries the size and the picture format. `get_default_config`
                // on the WebGL2 surface picks `Rgba8UnormSrgb` (wgpu-core lists sRGB formats
                // first), so the surface path's pictures are sRGB; these must be too, or the scene
                // would blend in a different space.
                wgpu::SurfaceConfiguration {
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    color_space: wgpu::SurfaceColorSpace::Auto,
                    width: width.max(1),
                    height: height.max(1),
                    desired_maximum_frame_latency: 2,
                    present_mode: wgpu::PresentMode::Fifo,
                    alpha_mode: wgpu::CompositeAlphaMode::Auto,
                    view_formats: vec![],
                }
            }
        };
        let surface_globals = viewport_buffer(&device, width, height);
        let design_globals = viewport_buffer(&device, 1, 1);
        let globals_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let surface_globals_bind = viewport_bind(&device, &globals_layout, &surface_globals);
        let design_globals_bind = viewport_bind(&device, &globals_layout, &design_globals);
        let texture_entries: Vec<_> = (0..TEXTURE_SLOTS)
            .map(|i| wgpu::BindGroupLayoutEntry {
                binding: i as u32,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            })
            .chain(std::iter::once(wgpu::BindGroupLayoutEntry {
                binding: TEXTURE_SLOTS as u32,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            }))
            .collect();
        let texture_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &texture_entries,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("instanced scene shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&globals_layout), Some(&texture_layout)],
            immediate_size: 0,
        });
        let attrs = wgpu::vertex_attr_array![0=>Float32x4,1=>Float32x4,2=>Float32x4,3=>Float32x4,4=>Float32x4,5=>Float32x4,6=>Float32x4,7=>Float32x4,8=>Float32x4,9=>Float32x4,10=>Float32x2,11=>Float32x2,12=>Float32x2];
        let make_pipeline = |entry_point: &str, blend: Option<wgpu::BlendState>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("instanced scene pipeline"),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[Some(wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<Instance>() as u64,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &attrs,
                    })],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry_point),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: config.format,
                        blend,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let add = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let pipelines = [
            make_pipeline("fs", Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING)),
            make_pipeline("fs", Some(add)),
        ];
        let copy_pipeline = make_pipeline("fs_copy", None);
        let white = create_texture(
            &device,
            &queue,
            1,
            1,
            ResourceFormat::Srgb,
            Some(&[255, 255, 255, 255]),
        );
        let pictures = [
            create_picture(&device, &texture_layout, &sampler, &config),
            create_picture(&device, &texture_layout, &sampler, &config),
        ];
        let fullscreen_buffer = create_fullscreen_buffer(&device, width, height);
        if let Some(error) = scope.pop().await {
            return Err(format!("GPU initialization validation: {error}"));
        }
        #[cfg(target_arch = "wasm32")]
        if let Output::Canvas(presenter) = &mut output {
            // Everything a canvas present needs from wgpu-hal is checked here, so it cannot fail later.
            for picture in &pictures {
                gl_texture(&picture._texture)?;
            }
            // SAFETY: wgpu-hal's glow context of this device, which is the canvas's context.
            let hal = unsafe { device.as_hal::<wgpu::hal::api::Gles>() }
                .ok_or("device is not a GLES device")?;
            unsafe { presenter.init(hal.context().lock()) }?;
        }
        Ok(Self {
            output,
            device,
            queue,
            config,
            surface_globals,
            surface_globals_bind,
            design_globals,
            design_globals_bind,
            pipelines,
            copy_pipeline,
            texture_layout,
            sampler,
            textures: HashMap::new(),
            bind_cache: Vec::new(),
            content_bind_cache: HashMap::new(),
            committed_resource_epoch: 0,
            slot_undo: Vec::new(),
            resource_index_cache: None,
            white,
            pictures,
            committed_picture: None,
            instance_buffer: None,
            instance_capacity: 0,
            committed_geometry: Geometry::default(),
            fullscreen_buffer,
            resources: ResourceStore::with_max_side(max_side),
            state: SceneState::default(),
            staged: None,
            staged_patch_ids: None,
            staged_delta: None,
            admitted_dimensions_epoch: 0,
            upload_calls: 0,
            upload_bytes: 0,
            instance_upload_bytes: 0,
            texture_creations: 3,
            buffer_creations: 3,
            draw_calls: 0,
            completed_presents: 0,
            incremental_patches: 0,
            geometry_rebuilds: 0,
            wasm_calls: Cell::new(0),
            present_calls: 0,
            phase_identity: None,
            active_operation_id: None,
            backend,
            adapter_info,
            adapter_timestamp_query_supported,
            adapter_texture_slots: actual.max_sampled_textures_per_shader_stage,
            draw_state_dedupe: false,
            damage_present: false,
            damage_verify: false,
            damage: None,
            damage_dirty_keys: HashSet::new(),
            damage_clear: None,
            damage_stats: DamageStats::default(),
            last_damage: None,
            last_blit_pixels: 0,
            #[cfg(feature = "fault-injection")]
            validation_failure_once: false,
        })
    }
    pub fn backend_name(&self) -> &str {
        &self.backend
    }
    pub fn present_mode(&self) -> PresentMode {
        match &self.output {
            Output::Surface(_) => PresentMode::Surface,
            #[cfg(target_arch = "wasm32")]
            Output::Canvas(presenter) => presenter.mode,
        }
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
        if enabled && self.damage_clear.is_none() {
            let entry = create_texture(
                &self.device,
                &self.queue,
                1,
                1,
                ResourceFormat::Linear,
                Some(&[0, 0, 0, 0]),
            );
            let bind = bind_textures(
                &self.device,
                &self.texture_layout,
                &self.sampler,
                &[&entry.view; TEXTURE_SLOTS],
            );
            self.texture_creations += 1;
            self.damage_clear = Some((entry, bind));
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
        serde_json::json!({
            "backend": self.backend,
            "adapterName": self.adapter_info.name,
            "adapterVendor": self.adapter_info.vendor,
            "adapterDevice": self.adapter_info.device,
            "adapterDriver": self.adapter_info.driver,
            "adapterDriverInfo": self.adapter_info.driver_info,
            "adapterTimestampQuerySupported": self.adapter_timestamp_query_supported,
            "wgpuTimestampQuery": self.device.features().contains(wgpu::Features::TIMESTAMP_QUERY),
            "webgl2TimerExtension": null,
            "webgl2TimerExtensionReason": "wgpu owns the WebGL2 context and exposes no safe context accessor",
            "gpuElapsedNs": null,
            "gpuElapsedNsReason": "no validated timer query on the executor context"
        })
    }
    pub fn record_wasm_call(&self) {
        self.wasm_calls.set(self.wasm_calls.get() + 1);
    }
    #[cfg(feature = "fault-injection")]
    pub fn debug_validation_failure_once(&mut self) {
        self.validation_failure_once = true;
    }
    pub fn max_texture_side(&self) -> u32 {
        self.device.limits().max_texture_dimension_2d
    }
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        let max = self.max_texture_side();
        if width.max(height) > max {
            return Err(format!(
                "surface {width}x{height} exceeds max texture side {max}"
            ));
        }
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        match &mut self.output {
            Output::Surface(surface) => surface.configure(&self.device, &self.config),
            #[cfg(target_arch = "wasm32")]
            Output::Canvas(presenter) => presenter.set_size(self.config.width, self.config.height),
        }
        self.pictures = [
            create_picture(
                &self.device,
                &self.texture_layout,
                &self.sampler,
                &self.config,
            ),
            create_picture(
                &self.device,
                &self.texture_layout,
                &self.sampler,
                &self.config,
            ),
        ];
        self.texture_creations += 2;
        self.committed_picture = None;
        self.damage = None;
        self.staged = None;
        self.staged_patch_ids = None;
        self.staged_delta = None;
        // Full clear: draw indices and their bind groups are revalidated from
        // scratch on the next present rather than trusted across a resize.
        self.bind_cache.clear();
        self.fullscreen_buffer = create_fullscreen_buffer(&self.device, width, height);
        self.buffer_creations += 1;
        self.queue.write_buffer(
            &self.surface_globals,
            0,
            bytemuck::cast_slice(&[width as f32, height as f32, 0.0, 0.0]),
        );
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
                    self.textures.insert(
                        key.clone(),
                        create_texture(&self.device, &self.queue, *width, *height, *format, None),
                    );
                    created += 1;
                }
                ResourceChange::Replace {
                    key,
                    width,
                    height,
                    format,
                    pixels,
                } => {
                    self.textures.insert(
                        key.clone(),
                        create_texture(
                            &self.device,
                            &self.queue,
                            *width,
                            *height,
                            *format,
                            Some(pixels),
                        ),
                    );
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
                    write_texture_region(
                        &self.queue,
                        &texture._texture,
                        *x,
                        *y,
                        *width,
                        *height,
                        pixels,
                    );
                }
                ResourceChange::Release { key } => {
                    self.textures.remove(key);
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
            if scene.width != self.config.width || scene.height != self.config.height {
                self.staged = None;
                return Admission {
                    accepted: false,
                    revision: None,
                    unsupported_commands: 0,
                    resource_pending: 0,
                    error: Some(format!(
                        "scene surface {}x{} does not match configured {}x{}",
                        scene.width, scene.height, self.config.width, self.config.height
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
            if scene.width != self.config.width || scene.height != self.config.height {
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
            if scene.width != self.config.width || scene.height != self.config.height {
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
        #[cfg(target_arch = "wasm32")]
        let blit_partial = partial_rects.map(<[DeviceRect]>::to_vec);
        let frame = match &self.output {
            _ if skip => None,
            Output::Surface(surface) => match surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(f)
                | wgpu::CurrentSurfaceTexture::Suboptimal(f) => Some(f),
                e => return self.failed(&format!("{e:?}"), 0, 0),
            },
            #[cfg(target_arch = "wasm32")]
            Output::Canvas(_) => None,
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
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut draws = surface_draws;
        let mut dirty = Vec::new();
        if let Some(spans) = delta_spans.as_ref() {
            draws += self.committed_geometry.draws.len();
            let buffer = self
                .instance_buffer
                .as_ref()
                .expect("committed instances allocated");
            for (start, instances) in spans {
                if instances.is_empty() {
                    continue;
                }
                let end = start + instances.len();
                let bytes = bytemuck::cast_slice(instances);
                self.queue.write_buffer(
                    buffer,
                    (*start * std::mem::size_of::<Instance>()) as u64,
                    bytes,
                );
                self.upload_bytes += bytes.len() as u64;
                self.instance_upload_bytes += bytes.len() as u64;
                dirty.push((*start, end));
            }
        }
        if let Some(ref g) = candidate_geometry {
            draws += g.draws.len();
            let needed = g.instances.len().max(1);
            if needed > self.instance_capacity {
                self.instance_capacity = needed.next_power_of_two();
                self.instance_buffer = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("grow-only scene instances"),
                    size: (self.instance_capacity * std::mem::size_of::<Instance>()) as u64,
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }));
                self.buffer_creations += 1;
                dirty.push((0, g.instances.len()));
            } else if candidate_same_layout == Some(true) {
                dirty = candidate_dirty.take().unwrap_or_else(|| {
                    geometry::dirty_ranges(&self.committed_geometry.instances, &g.instances)
                });
            } else {
                dirty.push((0, g.instances.len()));
            }
            let buffer = self
                .instance_buffer
                .as_ref()
                .expect("instance buffer allocated");
            for &(start, end) in &dirty {
                if start < end {
                    let bytes = bytemuck::cast_slice(&g.instances[start..end]);
                    self.queue.write_buffer(
                        buffer,
                        (start * std::mem::size_of::<Instance>()) as u64,
                        bytes,
                    );
                    self.upload_bytes += bytes.len() as u64;
                    self.instance_upload_bytes += bytes.len() as u64;
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
        let binds: Vec<wgpu::BindGroup> = if render_draws.is_empty() {
            Vec::new()
        } else {
            let device = &self.device;
            let texture_layout = &self.texture_layout;
            let sampler = &self.sampler;
            let textures = &self.textures;
            let white = &self.white;
            resolve_draw_binds(
                &mut self.bind_cache,
                &mut self.content_bind_cache,
                render_draws,
                incremental,
                |resources| build_texture_bind(device, texture_layout, sampler, textures, white, resources),
            )
        };
        if let Some((design_width, design_height)) = design_size {
            self.queue.write_buffer(
                &self.design_globals,
                0,
                bytemuck::cast_slice(&[design_width as f32, design_height as f32, 0.0, 0.0]),
            );
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
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("scene and surface"),
                });
            if let (Some(g), Some(target)) = (render_geometry, target) {
                match &plan {
                    DamagePlan::Partial {
                        rects, selection, ..
                    } => {
                        let (issued, pixels) = self.encode_partial_picture(
                            &mut encoder,
                            target,
                            g,
                            &binds,
                            rects.rects(),
                            selection,
                        );
                        draws = surface_draws + issued;
                        partial_work = (issued as u64, pixels);
                    }
                    _ => {
                        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                            label: Some("candidate picture"),
                            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                                view: &self.pictures[target].view,
                                resolve_target: None,
                                ops: wgpu::Operations {
                                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                                    store: wgpu::StoreOp::Store,
                                },
                                depth_slice: None,
                            })],
                            ..Default::default()
                        });
                        pass.set_bind_group(0, &self.design_globals_bind, &[]);
                        if let Some(buffer) = &self.instance_buffer {
                            pass.set_vertex_buffer(0, buffer.slice(..));
                        }
                        let mut last_pipeline: Option<usize> = None;
                        for (draw, bind) in g.draws.iter().zip(&binds) {
                            let pipeline_index = if draw.blend == Blend::Add { 1 } else { 0 };
                            if !self.draw_state_dedupe || last_pipeline != Some(pipeline_index) {
                                pass.set_pipeline(&self.pipelines[pipeline_index]);
                                last_pipeline = Some(pipeline_index);
                            }
                            pass.set_bind_group(1, bind, &[]);
                            pass.draw(0..6, draw.start..draw.start + draw.count);
                        }
                    }
                }
            }
            if let Some(frame) = frame.as_ref() {
                let picture = &self.pictures[shown_picture.expect("picture exists")];
                let view = frame.texture.create_view(&Default::default());
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("surface copy"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    ..Default::default()
                });
                pass.set_pipeline(&self.copy_pipeline);
                pass.set_bind_group(0, &self.surface_globals_bind, &[]);
                pass.set_bind_group(1, &picture.bind, &[]);
                pass.set_vertex_buffer(0, self.fullscreen_buffer.slice(..));
                pass.draw(0..6, 0..1);
            }
            #[cfg(feature = "fault-injection")]
            if std::mem::take(&mut self.validation_failure_once) {
                // Both buffers are 16 bytes and lack copy usages. The validation
                // scope must refuse this candidate before queue.present.
                encoder.copy_buffer_to_buffer(&self.surface_globals, 0, &self.design_globals, 0, 32);
            }
            self.queue.submit([encoder.finish()]);
        } else {
            draws = 0;
        }
        self.draw_calls += draws as u64;
        drop(encode_phase);
        // The validation future may suspend here. Its initial poll and wait are unclassified.
        phase_stamp(phase_identity.as_ref(), "validation.wait", "start");
        let validation_error = scope.pop().await;
        phase_stamp(phase_identity.as_ref(), "validation.wait", "end");
        let _resume_phase = PhaseSpan::new(phase_identity.as_ref(), "resume");
        if let Some(error) = validation_error {
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
            self.queue.present(frame);
            self.completed_presents += 1;
            self.last_blit_pixels = u64::from(self.config.width) * u64::from(self.config.height);
        } else if render {
            #[cfg(target_arch = "wasm32")]
            if let Err(error) = self.present_to_canvas(
                shown_picture.expect("picture exists"),
                blit_partial.as_deref(),
            ) {
                // Unreachable after construction's checks (it means wgpu-hal changed under us). The
                // picture may already hold this candidate, so drop the damage state: the next
                // present redraws and copies whole.
                self.damage = None;
                return self.failed(&format!("canvas present: {error}"), 0, draws);
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
    /// Direct present: draw picture `index` into the canvas, only inside `partial` on a preserved
    /// canvas that still shows the previous picture. Construction checked every fallible step, so
    /// an error here means wgpu-hal changed under us.
    #[cfg(target_arch = "wasm32")]
    fn present_to_canvas(&mut self, index: usize, partial: Option<&[DeviceRect]>) -> Result<(), String> {
        let Output::Canvas(presenter) = &mut self.output else {
            return Err("no canvas output".into());
        };
        let (width, height) = (self.config.width, self.config.height);
        let regions =
            crate::present::blit_regions(presenter.mode, presenter.force_full, partial, width, height);
        let scissored = regions != [DeviceRect::full(width, height)];
        let raw = gl_texture(&self.pictures[index]._texture)?;
        // SAFETY: wgpu-hal's glow context of this device, which is the canvas's context; `raw` is a
        // picture this renderer keeps alive, sized to the configured surface.
        let device = unsafe { self.device.as_hal::<wgpu::hal::api::Gles>() }
            .ok_or("device is not a GLES device")?;
        unsafe { presenter.present(device.context().lock(), raw, &regions, scissored, width, height) }?;
        self.last_blit_pixels = crate::present::blit_pixels(&regions);
        Ok(())
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
                surface: (self.config.width, self.config.height),
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
    /// Redraw `rects` of picture `target` in place: per rectangle, scissor,
    /// clear to transparent, then replay in order every draw whose footprint
    /// reaches it. Returns the draw calls issued and the pixels covered.
    fn encode_partial_picture(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target: usize,
        g: &Geometry,
        binds: &[wgpu::BindGroup],
        rects: &[DeviceRect],
        selection: &[DeviceRect],
    ) -> (usize, u64) {
        let (_, clear_bind) = self.damage_clear.as_ref().expect("damage present enabled");
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("damaged picture"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.pictures[target].view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            ..Default::default()
        });
        let mut issued = 0usize;
        let mut pixels = 0u64;
        for rect in rects {
            pass.set_scissor_rect(
                rect.x0 as u32,
                rect.y0 as u32,
                (rect.x1 - rect.x0) as u32,
                (rect.y1 - rect.y0) as u32,
            );
            // The picture has the surface's size, so the surface quad and
            // globals cover it exactly; the copy pipeline does not blend.
            pass.set_pipeline(&self.copy_pipeline);
            pass.set_bind_group(0, &self.surface_globals_bind, &[]);
            pass.set_bind_group(1, clear_bind, &[]);
            pass.set_vertex_buffer(0, self.fullscreen_buffer.slice(..));
            pass.draw(0..6, 0..1);
            issued += 1;
            pass.set_bind_group(0, &self.design_globals_bind, &[]);
            if let Some(buffer) = &self.instance_buffer {
                pass.set_vertex_buffer(0, buffer.slice(..));
            }
            let mut last_pipeline: Option<usize> = None;
            for ((draw, bind), bounds) in g.draws.iter().zip(binds).zip(selection) {
                if !bounds.intersects(rect) {
                    continue;
                }
                let pipeline_index = if draw.blend == Blend::Add { 1 } else { 0 };
                if last_pipeline != Some(pipeline_index) {
                    pass.set_pipeline(&self.pipelines[pipeline_index]);
                    last_pipeline = Some(pipeline_index);
                }
                pass.set_bind_group(1, bind, &[]);
                pass.draw(0..6, draw.start..draw.start + draw.count);
                issued += 1;
            }
            pixels += rect.area();
        }
        (issued, pixels)
    }
    /// After a successful present: record what the committed picture now
    /// holds, so the next patch can trust it.
    fn commit_damage(&mut self, plan: DamagePlan, design_size: Option<(u32, u32)>) {
        let projection = design_size.map(|(design_width, design_height)| {
            Projection::new(self.config.width, self.config.height, design_width, design_height)
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
        if let Some(buffer) = &self.instance_buffer {
            for &(start, end) in dirty {
                let end = end.min(self.committed_geometry.instances.len());
                if start < end {
                    let bytes =
                        bytemuck::cast_slice(&self.committed_geometry.instances[start..end]);
                    self.queue.write_buffer(
                        buffer,
                        (start * std::mem::size_of::<Instance>()) as u64,
                        bytes,
                    );
                    self.upload_bytes += bytes.len() as u64;
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
            backend: self.backend.clone(),
            max_texture_side: self.max_texture_side(),
            max_sampled_textures: self.adapter_texture_slots,
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
#[cfg(target_arch = "wasm32")]
impl Drop for Renderer {
    fn drop(&mut self) {
        if let Output::Canvas(presenter) = &mut self.output {
            // SAFETY: wgpu-hal's glow context of this (still alive) device.
            if let Some(device) = unsafe { self.device.as_hal::<wgpu::hal::api::Gles>() } {
                unsafe { presenter.release(device.context().lock()) };
            }
        }
    }
}
/// The raw GL texture behind a wgpu texture on the WebGL2 backend.
#[cfg(target_arch = "wasm32")]
fn gl_texture(texture: &wgpu::Texture) -> Result<glow::Texture, String> {
    // SAFETY: only reads the handle; the guard is dropped before returning and the texture is
    // kept alive by its owner.
    let hal = unsafe { texture.as_hal::<wgpu::hal::api::Gles>() }.ok_or("not a GLES texture")?;
    match hal.inner {
        wgpu::hal::gles::TextureInner::Texture { raw, .. } => Ok(raw),
        _ => Err("not a GL texture object".into()),
    }
}
fn viewport_buffer(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("viewport"),
        contents: bytemuck::cast_slice(&[width as f32, height as f32, 0.0, 0.0]),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    })
}
fn viewport_bind(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    buffer: &wgpu::Buffer,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: buffer.as_entire_binding(),
        }],
    })
}
fn bind_textures(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    views: &[&wgpu::TextureView],
) -> wgpu::BindGroup {
    let entries: Vec<_> = views
        .iter()
        .enumerate()
        .map(|(i, v)| wgpu::BindGroupEntry {
            binding: i as u32,
            resource: wgpu::BindingResource::TextureView(v),
        })
        .chain(std::iter::once(wgpu::BindGroupEntry {
            binding: TEXTURE_SLOTS as u32,
            resource: wgpu::BindingResource::Sampler(sampler),
        }))
        .collect();
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout,
        entries: &entries,
    })
}
/// Build a fresh bind group for one draw's resource slots. A free function
/// (not a `&self` method) so a caller can borrow `device`/`texture_layout`/
/// `sampler`/`textures`/`white` individually and still hold other fields of
/// `Renderer` mutably at the same time — see `resolve_draw_binds`'s call
/// site in `present`. Does not consult or populate any cache itself.
fn build_texture_bind(
    device: &wgpu::Device,
    texture_layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    textures: &HashMap<String, TextureEntry>,
    white: &TextureEntry,
    resources: &[Option<String>],
) -> wgpu::BindGroup {
    let views: Vec<_> = (0..TEXTURE_SLOTS)
        .map(|i| {
            resources
                .get(i)
                .and_then(|r| r.as_ref())
                .and_then(|key| textures.get(key))
                .map_or(&white.view, |entry| &entry.view)
        })
        .collect();
    bind_textures(device, texture_layout, sampler, &views)
}
fn create_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    w: u32,
    h: u32,
    format: ResourceFormat,
    pixels: Option<&[u8]>,
) -> TextureEntry {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: match format {
            ResourceFormat::Srgb => wgpu::TextureFormat::Rgba8UnormSrgb,
            ResourceFormat::Linear => wgpu::TextureFormat::Rgba8Unorm,
        },
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    if let Some(pixels) = pixels {
        write_texture_region(queue, &texture, 0, 0, w, h, pixels);
    }
    let view = texture.create_view(&Default::default());
    TextureEntry {
        _texture: texture,
        view,
    }
}
fn write_texture_region(
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    pixels: &[u8],
) {
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d { x, y, z: 0 },
            aspect: wgpu::TextureAspect::All,
        },
        pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(w * 4),
            rows_per_image: Some(h),
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
}
fn create_picture(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    config: &wgpu::SurfaceConfiguration,
) -> Picture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("reusable picture"),
        size: wgpu::Extent3d {
            width: config.width,
            height: config.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: config.format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    let views = [&view; TEXTURE_SLOTS];
    let bind = bind_textures(device, layout, sampler, &views);
    Picture {
        _texture: texture,
        view,
        bind,
    }
}
fn create_fullscreen_buffer(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Buffer {
    let quad = Quad {
        resource: None,
        m: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        w: width as f32,
        h: height as f32,
        src: [0.0, 0.0, 1.0, 1.0],
        color: [1.0; 4],
        blend: Blend::Mix,
        flip_h: false,
        flip_v: false,
        color_matrix: None,
    };
    let scene = Scene {
        version: SCENE_VERSION,
        revision: 0,
        width,
        height,
        design_width: width,
        design_height: height,
        resources: vec![],
        commands: vec![Command::Quad {
            id: "full".into(),
            quad,
        }],
    };
    let geometry = geometry::build(&scene);
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("static surface quad"),
        contents: bytemuck::cast_slice(&geometry.instances),
        usage: wgpu::BufferUsages::VERTEX,
    })
}
