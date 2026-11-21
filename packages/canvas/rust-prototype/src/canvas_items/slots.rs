//! Lazily linked texture-slot variants. The single-texture sources remain unchanged.
use super::*;

pub(super) const SLOT_UNITS: [u32; 4] = [UNIT_DRAW, 12, 13, 14];

fn vertex() -> String {
    VERT.replace(
        "layout(location = 0)",
        "layout(location = 8) in uint a_slot;\nflat out uint v_slot;\nlayout(location = 0)",
    )
    .replace("  v_uv = a_uv;", "  v_slot = a_slot;\n  v_uv = a_uv;")
}

fn samplers(source: &str, sabotage: bool) -> String {
    source.replace("uniform sampler2D u_texture;", &format!(
        "uniform sampler2D u_texture0;\nuniform sampler2D u_texture1;\nuniform sampler2D u_texture2;\nuniform sampler2D u_texture3;\nflat in uint v_slot;\nuint slot_index() {{ return {}; }}",
        if sabotage { "(v_slot + 1u) % 4u" } else { "v_slot" }
    ))
}

fn sample_chain(msdf: bool) -> String {
    // Every draw texture uses one of six sampler objects, with min = mag and no mipmaps.
    // Only level 0 is read: sampling is independent of derivatives even inside this branch.
    let mut chain = String::from("  vec4 sampled;\n");
    if msdf {
        chain.push_str("  vec2 msdf_size;\n");
    }
    for i in 0..4 {
        let branch = if i == 0 { "if" } else { "else if" };
        chain.push_str(&format!(
            "  {branch} (slot_index() == {i}u) {{\n    sampled = texture(u_texture{i}, v_uv);\n"
        ));
        if msdf {
            chain.push_str(&format!(
                "    msdf_size = vec2(textureSize(u_texture{i}, 0));\n"
            ));
        }
        chain.push_str("  }\n");
    }
    chain
}

fn fragment(msdf: bool, sabotage: bool) -> String {
    if !msdf {
        return samplers(FRAG, sabotage).replace(
            "  vec4 sampled = texture(u_texture, v_uv);",
            &sample_chain(false),
        );
    }
    // Evaluate fwidth in uniform control flow, before selecting the sampler. Everything after
    // the sample uses the single-texture shader's expressions verbatim.
    let coverage = super::super::MSDF_COVERAGE
        .replace(
            "sampler2D color_texture, vec2 uv, vec2 msdf",
            "vec4 msdf_sample, vec2 msdf_size, vec2 dest_size, vec2 msdf",
        )
        .replace("  vec4 msdf_sample = texture(color_texture, uv);\n", "")
        .replace(
            "  vec2 msdf_size = vec2(textureSize(color_texture, 0));\n",
            "",
        )
        .replace("  vec2 dest_size = vec2(1.0) / fwidth(uv);\n", "");
    samplers(&msdf_fragment(), sabotage)
        .replace(super::super::MSDF_COVERAGE, &coverage)
        .replace(
            "  vec4 color = v_color * v_tint;",
            &format!(
                "  vec2 dest_size = vec2(1.0) / fwidth(v_uv);\n{}  vec4 color = v_color * v_tint;",
                sample_chain(true)
            ),
        )
        .replace(
            "gsw_msdf_coverage(u_texture, v_uv, u_msdf",
            "gsw_msdf_coverage(sampled, msdf_size, dest_size, u_msdf",
        )
}

pub(super) struct SlotProgram {
    pub program: glow::Program,
    projection: Option<(u32, u32, bool)>,
    u_projection: Option<glow::UniformLocation>,
    u_godot_screen: Option<glow::UniformLocation>,
    u_screen: Option<glow::UniformLocation>,
    u_premultiply: Option<glow::UniformLocation>,
    u_texel_premultiply: Option<glow::UniformLocation>,
    u_msdf: Option<glow::UniformLocation>,
    u_msdf_no_median: Option<glow::UniformLocation>,
    pub u_depth: Option<glow::UniformLocation>,
    premultiply: Option<bool>,
    msdf_state: Option<MsdfState>,
}

impl SlotProgram {
    fn new(gl: &Gl, program: glow::Program, msdf: bool) -> Self {
        gl.use_program(Some(program));
        let raw = &gl.raw;
        unsafe {
            for (i, unit) in SLOT_UNITS.into_iter().enumerate() {
                gl.c().uniform_1_i32(
                    raw.get_uniform_location(program, &format!("u_texture{i}"))
                        .as_ref(),
                    unit as i32,
                );
            }
            gl.c().uniform_1_i32(
                raw.get_uniform_location(program, "u_items").as_ref(),
                UNIT_ITEMS as i32,
            );
            if msdf {
                gl.c().uniform_1_i32(
                    raw.get_uniform_location(program, "u_premultiply").as_ref(),
                    0,
                );
            }
            Self {
                program,
                projection: None,
                premultiply: None,
                msdf_state: None,
                u_projection: raw.get_uniform_location(program, "u_projection"),
                u_godot_screen: raw.get_uniform_location(program, "u_godot_screen"),
                u_screen: raw.get_uniform_location(program, "u_screen"),
                u_premultiply: raw.get_uniform_location(
                    program,
                    if msdf {
                        "u_premultiply_out"
                    } else {
                        "u_premultiply"
                    },
                ),
                u_texel_premultiply: raw.get_uniform_location(program, "u_texel_premultiply"),
                u_msdf: raw.get_uniform_location(program, "u_msdf"),
                u_msdf_no_median: raw.get_uniform_location(program, "u_msdf_no_median"),
                u_depth: raw.get_uniform_location(program, "u_depth"),
            }
        }
    }

    pub fn bind(
        &mut self,
        gl: &Gl,
        cache: &mut Cache,
        size: (u32, u32),
        godot: bool,
        draw: &Draw,
        opaque: bool,
        sabotage: Option<Sabotage>,
    ) {
        if cache.program != Some(self.program) {
            gl.use_program(Some(self.program));
            cache.program = Some(self.program);
        }
        let (width, height) = size;
        if self.projection != Some((width, height, godot)) {
            set_vertex_projection(
                gl,
                [&self.u_projection, &self.u_godot_screen, &self.u_screen],
                [
                    (2.0 / f64::from(width)) as f32,
                    (-2.0 / f64::from(height)) as f32,
                    -1.0,
                    1.0,
                ],
                godot,
                &godot_screen_transform(width, height),
            );
            self.projection = Some((width, height, godot));
        }
        let premultiply = premultiplies(Blend::from_u32(draw.blend).unwrap_or(Blend::Mix), opaque);
        if self.premultiply != Some(premultiply) {
            unsafe {
                gl.c()
                    .uniform_1_i32(self.u_premultiply.as_ref(), premultiply as i32);
                gl.c().uniform_1_i32(
                    self.u_texel_premultiply.as_ref(),
                    (premultiply && sabotage != Some(Sabotage::PremultipliedUpload)) as i32,
                );
            }
            self.premultiply = Some(premultiply);
        }
        if draw.flags & DRAW_MSDF != 0 {
            let state = MsdfState::of(draw, sabotage);
            if self.msdf_state != Some(state) {
                set_msdf(gl, [&self.u_msdf, &self.u_msdf_no_median], draw.msdf, state);
                self.msdf_state = Some(state);
            }
        }
    }
}

#[derive(Default)]
pub(super) enum SlotPrograms {
    #[default]
    Unstarted,
    Pending([DepthProgram; 2]),
    Ready([SlotProgram; 2]),
    Failed,
}

impl SlotPrograms {
    pub fn ready(&mut self, gl: &Gl, sabotage: bool) -> bool {
        if matches!(self, Self::Unstarted) {
            let mut links = [DepthProgram::Failed, DepthProgram::Failed];
            for (i, link) in links.iter_mut().enumerate() {
                match start_link(&gl.raw, &vertex(), &fragment(i == 1, sabotage)) {
                    Ok((program, shaders)) => {
                        *link = DepthProgram::Pending {
                            program,
                            shaders,
                            polled: false,
                            fence: unsafe {
                                gl.c().fence_sync(glow::SYNC_GPU_COMMANDS_COMPLETE, 0)
                            }
                            .ok(),
                        }
                    }
                    Err(_) => {
                        for link in links {
                            delete_link_state(&gl.raw, link);
                        }
                        *self = Self::Failed;
                        return false;
                    }
                }
            }
            *self = Self::Pending(links);
            return false;
        }
        if let Self::Pending(links) = self {
            let parallel = gl
                .raw
                .supported_extensions()
                .contains("KHR_parallel_shader_compile");
            for link in links.iter_mut() {
                let DepthProgram::Pending {
                    program,
                    fence,
                    polled,
                    ..
                } = link
                else {
                    continue;
                };
                let ready = link_ready(
                    parallel.then(|| unsafe { gl.raw.get_program_completion_status(*program) }),
                    || fence.map(|f| unsafe { gl.raw.get_sync_status(f) == glow::SIGNALED }),
                    *polled,
                );
                *polled = true;
                if !ready {
                    continue;
                }
                let DepthProgram::Pending {
                    program,
                    shaders,
                    fence,
                    ..
                } = std::mem::replace(link, DepthProgram::Failed)
                else {
                    unreachable!()
                };
                if let Some(fence) = fence {
                    unsafe {
                        gl.raw.delete_sync(fence);
                    }
                }
                if let Ok(program) = finish_link(&gl.raw, program, shaders) {
                    *link = DepthProgram::Ready(program);
                }
            }
            if links.iter().any(|l| matches!(l, DepthProgram::Failed)) {
                self.delete(&gl.raw);
                *self = Self::Failed;
                return false;
            }
            if let [DepthProgram::Ready(a), DepthProgram::Ready(b)] = links {
                *self = Self::Ready([
                    SlotProgram::new(gl, *a, false),
                    SlotProgram::new(gl, *b, true),
                ]);
            }
        }
        matches!(self, Self::Ready(_))
    }
    pub fn delete(&mut self, gl: &glow::Context) {
        match std::mem::take(self) {
            Self::Ready(programs) => {
                for p in programs {
                    unsafe { gl.delete_program(p.program) };
                }
            }
            Self::Pending(links) => {
                for link in links {
                    delete_link_state(gl, link);
                }
            }
            _ => {}
        }
    }
}

fn delete_link_state(gl: &glow::Context, state: DepthProgram) {
    unsafe {
        match state {
            DepthProgram::Pending {
                program,
                shaders,
                fence,
                ..
            } => {
                if let Some(fence) = fence {
                    gl.delete_sync(fence);
                }
                for shader in shaders {
                    gl.delete_shader(shader);
                }
                gl.delete_program(program);
            }
            DepthProgram::Ready(program) => gl.delete_program(program),
            DepthProgram::Failed => {}
        }
    }
}

/// Retain the planner's slot stream per list, including admission and optional merge barriers.
#[derive(Default)]
pub(super) struct SlotPlan {
    valid: bool,
    key: Vec<(Draw, Option<u32>, Option<usize>, bool)>,
    index_len: usize,
    pub calls: Vec<Call>,
    pub counts: gsw_canvas_draw_list::plan::PlanCounts,
    pub stream: Vec<u8>,
    pub dirty: Vec<std::ops::Range<usize>>,
}
impl SlotPlan {
    /// A K=1 frame can consume index dirtiness without updating this retained plan.
    pub fn invalidate(&mut self) {
        self.valid = false;
    }

    pub fn update(
        &mut self,
        list: &DrawList,
        texture: impl Fn(u32) -> bool,
        binding: impl Fn(u32) -> bool,
    ) {
        let key: Vec<_> = list
            .draws
            .iter()
            .enumerate()
            .map(|(i, d)| {
                (
                    *d,
                    gsw_canvas_draw_list::depth_level(list, i as u32),
                    list.group_cells.iter().position(|g| g.draws.contains(&i)),
                    drawable(d, list.indices.len(), &texture, &binding),
                )
            })
            .collect();
        self.dirty.clear();
        if !self.valid
            || key != self.key
            || list.dirty.all
            || !list.dirty.indices.is_empty()
            || self.stream.len() != list.vertices.len()
            || self.index_len != list.indices.len()
        {
            self.counts = gsw_canvas_draw_list::plan::plan_calls_with_slots(
                list,
                gsw_canvas_draw_list::plan::PlanOptions { texture_slots: 4 },
                texture,
                binding,
                &mut self.calls,
                &mut self.stream,
                &mut self.dirty,
            );
            if !self.valid {
                // The GPU may still contain ownership from before a K=1 frame. Re-upload
                // every byte even if some assignments happen to equal the old CPU stream.
                self.dirty.clear();
                self.dirty.push(0..self.stream.len());
            }
            self.valid = true;
            self.key = key;
            self.index_len = list.indices.len();
        }
    }
}
