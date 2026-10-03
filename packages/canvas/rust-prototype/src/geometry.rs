use crate::contract::{Blend, Command, GlyphMethod, Quad, Resource, Scene};
use std::collections::HashMap;

pub const TEXTURE_SLOTS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Clip {
    pub rect: [f32; 4],
    pub radius: f32,
    pub outset: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Instance {
    pub origin_axis_x: [f32; 4],
    pub axis_y_uv_origin: [f32; 4],
    pub uv_size_slot: [f32; 4],
    pub color: [f32; 4],
    pub matrix: [f32; 12],
    pub clips: [[f32; 4]; 3],
    pub clip_params: [[f32; 2]; 3],
}

#[derive(Clone, Debug, PartialEq)]
pub struct Draw {
    pub start: u32,
    pub count: u32,
    pub resources: Vec<Option<String>>,
    pub blend: Blend,
}

#[derive(Clone, Default)]
pub struct Geometry {
    pub instances: Vec<Instance>,
    pub draws: Vec<Draw>,
    /// One contiguous instance range per command, including zero-length clips.
    pub command_ranges: Vec<(u32, u32)>,
}

#[derive(Clone, Copy)]
struct GlyphStyle {
    mode: f32,
    px_range: f32,
    outline_width: f32,
    outline_color: [f32; 4],
}

fn emit(
    g: &mut Geometry,
    q: &Quad,
    rect: [f32; 4],
    src: [f32; 4],
    clips: &[Clip],
    page: (u32, u32),
    glyph_style: Option<GlyphStyle>,
) {
    if rect[2] <= 0.0 || rect[3] <= 0.0 {
        return;
    }
    let resource = q.resource.clone();
    let start = g.instances.len() as u32;
    let new_draw = g.draws.last().is_none_or(|last| {
        last.blend != q.blend
            || (!last.resources.contains(&resource) && last.resources.len() == TEXTURE_SLOTS)
    });
    if new_draw {
        g.draws.push(Draw {
            start,
            count: 0,
            resources: Vec::new(),
            blend: q.blend,
        });
    }
    let draw = g.draws.last_mut().expect("draw exists");
    let slot = if let Some(slot) = draw.resources.iter().position(|r| *r == resource) {
        slot
    } else {
        draw.resources.push(resource);
        draw.resources.len() - 1
    };
    let [x, y, w, h] = rect;
    let p = |cx: f32, cy: f32| {
        [
            q.m[0] * cx + q.m[2] * cy + q.m[4],
            q.m[1] * cx + q.m[3] * cy + q.m[5],
        ]
    };
    let a = p(x, y);
    let b = p(x + w, y);
    let c = p(x, y + h);
    let mut inst = Instance {
        origin_axis_x: [a[0], a[1], b[0] - a[0], b[1] - a[1]],
        axis_y_uv_origin: [c[0] - a[0], c[1] - a[1], 0.0, 0.0],
        uv_size_slot: [0.0, 0.0, slot as f32, 0.0],
        color: q.color,
        matrix: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        clips: [[0.0; 4]; 3],
        clip_params: [[-1.0, 0.0]; 3],
    };
    let [sx, sy, sw, sh] = src;
    let u0 = (sx + if q.flip_h { sw } else { 0.0 }) / page.0 as f32;
    let v0 = (sy + if q.flip_v { sh } else { 0.0 }) / page.1 as f32;
    inst.axis_y_uv_origin[2..4].copy_from_slice(&[u0, v0]);
    inst.uv_size_slot[0] = sw / page.0 as f32 * if q.flip_h { -1.0 } else { 1.0 };
    inst.uv_size_slot[1] = sh / page.1 as f32 * if q.flip_v { -1.0 } else { 1.0 };
    if let Some(m) = q.color_matrix {
        inst.matrix = [
            m[0], m[1], m[2], 0.0, m[3], m[4], m[5], 0.0, m[6], m[7], m[8], 0.0,
        ];
    }
    if let Some(style) = glyph_style {
        inst.uv_size_slot[3] = style.mode;
        inst.matrix = [
            style.px_range,
            page.0 as f32,
            page.1 as f32,
            style.outline_width,
            style.outline_color[0],
            style.outline_color[1],
            style.outline_color[2],
            style.outline_color[3],
            0.0,
            0.0,
            0.0,
            0.0,
        ];
    }
    for (j, clip) in clips.iter().enumerate() {
        inst.clips[j] = clip.rect;
        inst.clip_params[j] = [clip.radius, clip.outset];
    }
    g.instances.push(inst);
    draw.count += 1;
}

pub fn build(scene: &Scene) -> Geometry {
    let pages: std::collections::HashMap<_, _> = scene
        .resources
        .iter()
        .map(|r| (r.key.as_str(), (r.width, r.height)))
        .collect();
    let mut g = Geometry::default();
    let mut clips = Vec::new();
    for command in &scene.commands {
        let start = g.instances.len() as u32;
        match command {
            Command::ClipPush {
                rect,
                radius,
                outset,
                ..
            } => clips.push(Clip {
                rect: *rect,
                radius: *radius,
                outset: *outset,
            }),
            Command::ClipPop { .. } => {
                clips.pop();
            }
            Command::Quad { quad, .. }
            | Command::RasterText { quad, .. }
            | Command::StillImage { quad, .. } => {
                let page = quad
                    .resource
                    .as_ref()
                    .and_then(|k| pages.get(k.as_str()).copied())
                    .unwrap_or((1, 1));
                emit(
                    &mut g,
                    quad,
                    [0.0, 0.0, quad.w, quad.h],
                    quad.src,
                    &clips,
                    page,
                    None,
                );
            }
            Command::GlyphRun {
                atlas,
                m,
                glyphs,
                method,
                fill,
                outline,
                shadow,
                px_range,
                alpha,
                ..
            } => {
                let page = pages.get(atlas.as_str()).copied().unwrap_or((1, 1));
                let mode = match method {
                    GlyphMethod::Msdf => 1.0,
                    GlyphMethod::Sdf => 2.0,
                };
                if let Some(shadow) = shadow {
                    for glyph in glyphs {
                        let quad = Quad {
                            resource: Some(atlas.clone()),
                            m: *m,
                            w: glyph.dst[2],
                            h: glyph.dst[3],
                            src: glyph.src,
                            color: [
                                shadow.color[0],
                                shadow.color[1],
                                shadow.color[2],
                                shadow.color[3] * alpha,
                            ],
                            blend: Blend::Mix,
                            flip_h: false,
                            flip_v: false,
                            color_matrix: None,
                        };
                        emit(
                            &mut g,
                            &quad,
                            [
                                glyph.dst[0] + shadow.offset[0],
                                glyph.dst[1] + shadow.offset[1],
                                glyph.dst[2],
                                glyph.dst[3],
                            ],
                            glyph.src,
                            &clips,
                            page,
                            Some(GlyphStyle {
                                mode,
                                px_range: *px_range,
                                outline_width: 0.0,
                                outline_color: [0.0; 4],
                            }),
                        );
                    }
                }
                for glyph in glyphs {
                    let outline_width = outline
                        .as_ref()
                        .map_or(0.0, |v| v.width * glyph.src[2] / glyph.dst[2] / px_range);
                    let outline_color = outline.as_ref().map_or([0.0; 4], |v| {
                        [v.color[0], v.color[1], v.color[2], v.color[3] * alpha]
                    });
                    let quad = Quad {
                        resource: Some(atlas.clone()),
                        m: *m,
                        w: glyph.dst[2],
                        h: glyph.dst[3],
                        src: glyph.src,
                        color: [fill[0], fill[1], fill[2], fill[3] * alpha],
                        blend: Blend::Mix,
                        flip_h: false,
                        flip_v: false,
                        color_matrix: None,
                    };
                    emit(
                        &mut g,
                        &quad,
                        glyph.dst,
                        glyph.src,
                        &clips,
                        page,
                        Some(GlyphStyle {
                            mode,
                            px_range: *px_range,
                            outline_width,
                            outline_color,
                        }),
                    );
                }
            }
            Command::NinePatch { quad, margins, .. } => {
                let page = quad
                    .resource
                    .as_ref()
                    .and_then(|k| pages.get(k.as_str()).copied())
                    .unwrap_or((1, 1));
                let left = margins[0].clamp(0.0, quad.w.min(quad.src[2]));
                let top = margins[1].clamp(0.0, quad.h.min(quad.src[3]));
                let right = margins[2].clamp(0.0, (quad.w - left).min(quad.src[2] - left));
                let bottom = margins[3].clamp(0.0, (quad.h - top).min(quad.src[3] - top));
                let dx = [0.0, left, quad.w - right, quad.w];
                let dy = [0.0, top, quad.h - bottom, quad.h];
                let sx = [
                    quad.src[0],
                    quad.src[0] + left,
                    quad.src[0] + quad.src[2] - right,
                    quad.src[0] + quad.src[2],
                ];
                let sy = [
                    quad.src[1],
                    quad.src[1] + top,
                    quad.src[1] + quad.src[3] - bottom,
                    quad.src[1] + quad.src[3],
                ];
                for yy in 0..3 {
                    for xx in 0..3 {
                        emit(
                            &mut g,
                            quad,
                            [dx[xx], dy[yy], dx[xx + 1] - dx[xx], dy[yy + 1] - dy[yy]],
                            [sx[xx], sy[yy], sx[xx + 1] - sx[xx], sy[yy + 1] - sy[yy]],
                            &clips,
                            page,
                            None,
                        );
                    }
                }
            }
        }
        g.command_ranges.push((start, g.instances.len() as u32));
    }
    g
}

/// A changed clip, batch table, or tile layout requires a complete upload.
pub fn same_layout(old: &Geometry, new: &Geometry) -> bool {
    old.command_ranges == new.command_ranges && old.draws == new.draws
}

pub fn dirty_ranges(old: &[Instance], new: &[Instance]) -> Vec<(usize, usize)> {
    if old.len() != new.len() {
        return vec![(0, new.len())];
    }
    let mut ranges = Vec::new();
    let mut start = None;
    for (i, (a, b)) in old.iter().zip(new).enumerate() {
        if a != b {
            start.get_or_insert(i);
        } else if let Some(s) = start.take() {
            ranges.push((s, i));
        }
    }
    if let Some(s) = start {
        ranges.push((s, new.len()));
    }
    ranges
}

/// A `scene.resources` key -> `Resource` index, cached across calls as long as
/// `epoch` still matches. `Patch` carries no `resources` field (see
/// `contract::Patch`), so the committed scene's resource list only ever
/// changes when a full scene is admitted; a caller that bumps `epoch` solely
/// on that event can reuse this map for every patch in between.
///
/// Values are `(width, height)`, not a cloned `Resource`: the key string is
/// already owned once as the map key, and a `Resource` also owns a copy of
/// its key, so storing the full struct here would clone every key twice per
/// rebuild for no reason — the dimensions are the only fields a lookup
/// doesn't already have at the call site (see `patch_spans_with_cache`,
/// which rebuilds the `Resource` it needs from the key it's already
/// holding plus these two `Copy` fields).
pub type ResourceIndexCache = Option<(u64, HashMap<String, (u32, u32)>)>;

/// Replace only commands named by a validated patch. A changed tile count,
/// texture, blend, or clip returns None so the caller rebuilds the draw table.
pub fn patch_instances(
    old: &Geometry,
    old_scene: &Scene,
    next_scene: &Scene,
    ids: &[String],
) -> Option<Geometry> {
    if old_scene.commands.len() != next_scene.commands.len()
        || old.command_ranges.len() != next_scene.commands.len()
    {
        return None;
    }
    let mut result = old.clone();
    for id in ids {
        let index = next_scene.commands.iter().position(|c| c.id() == id)?;
        let before = &old_scene.commands[index];
        let after = &next_scene.commands[index];
        let (Some(before_quad), Some(after_quad)) = (before.quad(), after.quad()) else {
            return None;
        };
        if before.kind() != after.kind()
            || before_quad.resource != after_quad.resource
            || before_quad.blend != after_quad.blend
        {
            return None;
        }
        let mut stack: Vec<Command> = Vec::new();
        for command in &next_scene.commands[..index] {
            match command {
                Command::ClipPush { .. } => stack.push(command.clone()),
                Command::ClipPop { .. } => {
                    stack.pop();
                }
                _ => {}
            }
        }
        stack.push(after.clone());
        let partial_scene = Scene {
            version: next_scene.version,
            revision: next_scene.revision,
            width: next_scene.width,
            height: next_scene.height,
            design_width: next_scene.design_width,
            design_height: next_scene.design_height,
            resources: next_scene.resources.clone(),
            commands: stack,
        };
        let mut replacement = build(&partial_scene).instances;
        let (start, end) = result.command_ranges[index];
        if replacement.len() != (end - start) as usize {
            return None;
        }
        for (new, previous) in replacement
            .iter_mut()
            .zip(&old.instances[start as usize..end as usize])
        {
            new.uv_size_slot[2] = previous.uv_size_slot[2];
        }
        result.instances[start as usize..end as usize].copy_from_slice(&replacement);
    }
    Some(result)
}

/// Build only changed instance spans. None means a draw-table or tile-layout change.
///
/// A `ClipPush` replacement keeps the draw table: clips live in each instance's
/// clip slots, not in the batches. Every instance inside the replaced clip's
/// scope gets that slot rewritten in place, and a quad replaced in the same
/// patch is built against the replaced clip.
pub fn patch_spans(
    old: &Geometry,
    scene: &Scene,
    updates: &[(usize, Command)],
    clips_at: impl Fn(usize) -> Option<[Option<usize>; 3]>,
) -> Option<Vec<(usize, Vec<Instance>)>> {
    let mut cache: ResourceIndexCache = None;
    patch_spans_with_cache(old, scene, updates, clips_at, &mut cache, 0)
}

/// Same as [`patch_spans`], but reuses `resource_index_cache` across calls
/// instead of rebuilding the `key -> Resource` map every time. The cache is
/// rebuilt only when `resource_epoch` differs from the value it was built
/// under; the caller (the renderer) owns both and bumps the epoch exactly
/// when the committed scene's `resources` list can have changed.
pub fn patch_spans_with_cache(
    old: &Geometry,
    scene: &Scene,
    updates: &[(usize, Command)],
    clips_at: impl Fn(usize) -> Option<[Option<usize>; 3]>,
    resource_index_cache: &mut ResourceIndexCache,
    resource_epoch: u64,
) -> Option<Vec<(usize, Vec<Instance>)>> {
    if old.command_ranges.len() != scene.commands.len() {
        return None;
    }
    let mut clip_updates: HashMap<usize, &Command> = HashMap::new();
    for (index, command) in updates {
        if let Command::ClipPush { .. } = command {
            if !matches!(scene.commands.get(*index)?, Command::ClipPush { .. }) {
                return None;
            }
            clip_updates.insert(*index, command);
        }
    }
    let clip_command = |index: usize| -> Option<&Command> {
        clip_updates
            .get(&index)
            .copied()
            .or_else(|| scene.commands.get(index))
    };
    // Most patches touch commands with no resource (solid quads, text), so
    // building the key -> resource index unconditionally allocated a
    // HashMap on every call even when no update ever looked it up. Build it
    // lazily, on the first update that actually carries a resource — and
    // only when the cached copy is missing or stale, since a `Patch` never
    // changes `scene.resources` (only a fresh `admit_scene` does).
    let mut spans = Vec::with_capacity(updates.len());
    for (index, command) in updates {
        if matches!(command, Command::ClipPush { .. }) {
            continue;
        }
        let before = scene.commands.get(*index)?;
        let (Some(old_quad), Some(quad)) = (before.quad(), command.quad()) else {
            return None;
        };
        if before.kind() != command.kind()
            || old_quad.resource != quad.resource
            || old_quad.blend != quad.blend
        {
            return None;
        }
        let mut commands = Vec::new();
        for clip in clips_at(*index)?.into_iter().flatten() {
            commands.push(clip_command(clip)?.clone());
        }
        commands.push(command.clone());
        let resources = if let Some(key) = quad.resource.as_deref() {
            let fresh = resource_index_cache
                .as_ref()
                .is_none_or(|(epoch, _)| *epoch != resource_epoch);
            if fresh {
                let map = scene
                    .resources
                    .iter()
                    .map(|r| (r.key.clone(), (r.width, r.height)))
                    .collect();
                *resource_index_cache = Some((resource_epoch, map));
            }
            let (_, map) = resource_index_cache.as_ref().expect("just populated above");
            let &(width, height) = map.get(key)?;
            vec![Resource {
                key: key.to_string(),
                width,
                height,
            }]
        } else {
            Vec::new()
        };
        let partial = Scene {
            version: scene.version,
            revision: scene.revision,
            width: scene.width,
            height: scene.height,
            design_width: scene.design_width,
            design_height: scene.design_height,
            resources,
            commands,
        };
        let mut replacement = build(&partial).instances;
        let (start, end) = *old.command_ranges.get(*index)?;
        if replacement.len() != (end - start) as usize {
            return None;
        }
        for (new, previous) in replacement
            .iter_mut()
            .zip(&old.instances[start as usize..end as usize])
        {
            new.uv_size_slot[2] = previous.uv_size_slot[2];
        }
        spans.push((start as usize, replacement));
    }
    if clip_updates.is_empty() {
        return Some(spans);
    }
    // Every other drawing inside a replaced clip's scope (nested scopes
    // included) keeps its instances and takes the new clip in its slot.
    let replaced: std::collections::HashSet<usize> =
        updates.iter().map(|(index, _)| *index).collect();
    let mut scoped = std::collections::BTreeSet::new();
    for &push in clip_updates.keys() {
        let mut depth = 0usize;
        for index in push + 1..scene.commands.len() {
            match &scene.commands[index] {
                Command::ClipPush { .. } => depth += 1,
                Command::ClipPop { .. } if depth == 0 => break,
                Command::ClipPop { .. } => depth -= 1,
                _ if !replaced.contains(&index) => {
                    scoped.insert(index);
                }
                _ => {}
            }
        }
    }
    for index in scoped {
        let (start, end) = *old.command_ranges.get(index)?;
        if start == end {
            continue;
        }
        let mut instances = old.instances[start as usize..end as usize].to_vec();
        for (slot, clip) in clips_at(index)?.into_iter().enumerate() {
            let Some(clip) = clip else { continue };
            if let Some(Command::ClipPush {
                rect,
                radius,
                outset,
                ..
            }) = clip_updates.get(&clip).copied()
            {
                for instance in &mut instances {
                    instance.clips[slot] = *rect;
                    instance.clip_params[slot] = [*radius, *outset];
                }
            }
        }
        spans.push((start as usize, instances));
    }
    Some(spans)
}

#[cfg(test)]
mod resource_index_cache_tests {
    use super::*;
    use crate::contract::Blend;

    fn scene_with_quad(resource_key: &str, width: u32, height: u32, quad_w: f32) -> Scene {
        Scene {
            version: crate::contract::SCENE_VERSION,
            revision: 1,
            width: 100,
            height: 100,
            design_width: 100,
            design_height: 100,
            resources: vec![Resource {
                key: resource_key.into(),
                width,
                height,
            }],
            commands: vec![Command::Quad {
                id: "q0".into(),
                quad: Quad {
                    resource: Some(resource_key.into()),
                    m: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                    w: quad_w,
                    h: 10.0,
                    src: [0.0, 0.0, 10.0, 20.0],
                    color: [1.0; 4],
                    blend: Blend::Mix,
                    flip_h: false,
                    flip_v: false,
                    color_matrix: None,
                },
            }],
        }
    }

    fn no_clips(_index: usize) -> Option<[Option<usize>; 3]> {
        Some([None, None, None])
    }

    /// A stale cache entry whose epoch matches must be trusted as-is: the
    /// resulting UV scale reflects the cached (wrong) resource dimensions,
    /// not the scene's real ones, proving no rebuild happened.
    #[test]
    fn matching_epoch_reuses_cache_without_rebuilding() {
        let base = scene_with_quad("r1", 10, 20, 10.0);
        let old = build(&base);
        let updated = scene_with_quad("r1", 10, 20, 20.0); // same resource, different w
        let updates = vec![(0usize, updated.commands[0].clone())];
        let mut cache: ResourceIndexCache =
            Some((1, [("r1".to_string(), (999u32, 888u32))].into_iter().collect()));
        let spans =
            patch_spans_with_cache(&old, &base, &updates, no_clips, &mut cache, 1).unwrap();
        let (_, instances) = &spans[0];
        // page.0 = 999 (the stale cached width): uv width = src width / page width.
        assert!((instances[0].uv_size_slot[0] - 10.0 / 999.0).abs() < 1e-6);
        // The cache entry itself must be untouched (still the stale one, still epoch 1).
        let (epoch, map) = cache.as_ref().unwrap();
        assert_eq!(*epoch, 1);
        assert_eq!(map.get("r1").unwrap().0, 999);
    }

    /// A new resource epoch forces a fresh build from `scene.resources`,
    /// discarding whatever the stale cache held, and the cache is left
    /// holding the fresh map under the new epoch for the next call to reuse.
    #[test]
    fn new_epoch_rebuilds_and_refreshes_cache() {
        let base = scene_with_quad("r1", 10, 20, 10.0);
        let old = build(&base);
        let updated = scene_with_quad("r1", 10, 20, 20.0);
        let updates = vec![(0usize, updated.commands[0].clone())];
        let mut cache: ResourceIndexCache =
            Some((1, [("r1".to_string(), (999u32, 888u32))].into_iter().collect()));
        let spans =
            patch_spans_with_cache(&old, &base, &updates, no_clips, &mut cache, 2).unwrap();
        let (_, instances) = &spans[0];
        // page.0 = 10 (the scene's real width), read fresh since the epoch changed.
        assert!((instances[0].uv_size_slot[0] - 10.0 / 10.0).abs() < 1e-6);
        let (epoch, map) = cache.as_ref().unwrap();
        assert_eq!(*epoch, 2);
        assert_eq!(map.get("r1").unwrap().0, 10);
    }

    /// `patch_spans` (the uncached entry point kept for existing callers)
    /// always starts from an empty cache, so its output never depends on
    /// anything left over from a previous call — unchanged behaviour.
    #[test]
    fn uncached_entry_point_ignores_any_prior_state() {
        let base = scene_with_quad("r1", 10, 20, 10.0);
        let old = build(&base);
        let updated = scene_with_quad("r1", 10, 20, 20.0);
        let updates = vec![(0usize, updated.commands[0].clone())];
        let spans = patch_spans(&old, &base, &updates, no_clips).unwrap();
        let (_, instances) = &spans[0];
        assert!((instances[0].uv_size_slot[0] - 10.0 / 10.0).abs() < 1e-6);
    }
}
