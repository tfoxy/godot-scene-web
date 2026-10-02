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
pub fn patch_spans(
    old: &Geometry,
    scene: &Scene,
    updates: &[(usize, Command)],
    clips_at: impl Fn(usize) -> Option<[Option<usize>; 3]>,
) -> Option<Vec<(usize, Vec<Instance>)>> {
    if old.command_ranges.len() != scene.commands.len() {
        return None;
    }
    // Most patches touch commands with no resource (solid quads, text), so
    // building the key -> resource index unconditionally allocated a
    // HashMap on every call even when no update ever looked it up. Build it
    // lazily, once, on the first update that actually carries a resource.
    let mut resource_index: Option<HashMap<&str, &Resource>> = None;
    let mut spans = Vec::with_capacity(updates.len());
    for (index, command) in updates {
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
            commands.push(scene.commands.get(clip)?.clone());
        }
        commands.push(command.clone());
        let resources = if let Some(key) = quad.resource.as_deref() {
            let index = resource_index.get_or_insert_with(|| {
                scene
                    .resources
                    .iter()
                    .map(|r| (r.key.as_str(), r))
                    .collect()
            });
            vec![(*index.get(key)?).clone()]
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
    Some(spans)
}
