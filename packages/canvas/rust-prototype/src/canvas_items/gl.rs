//! [`CanvasItemsExecutor`]: the WebGL2 half of `canvas-items` (see the module note in `mod.rs`).
//!
//! It owns the canvas's WebGL2 context (`antialias: false`, `depth: false`, `stencil: false`,
//! `premultipliedAlpha: true`, `preserveDrawingBuffer: false`: the stage's attributes in
//! `packages/canvas/src/present.ts`) and issues every call through a state cache, so a frame pays
//! only for what changed. Fixed bindings, set once per (re)creation:
//! - unit 0: the draw's texture and its sampler object (one per filter × wrap, created up front);
//! - unit 1: the item data texture (RGBA32F, `3 · ITEMS_PER_ROW` wide), fetched by the vertex stage;
//! - unit 2: the target's colour texture, read by the RGB10_A2 present draw. The draw program never
//!   samples unit 2, so drawing into the target is no feedback loop;
//! - one vertex array holding the vertex buffer's four attributes and the index buffer.
//!
//! No `getError`, no per-frame resets. Context loss is the canvas's `webglcontextlost` event
//! ([`LossWatch`]); after `webglcontextrestored`, [`CanvasItemsExecutor::context_state`] (also run
//! by `execute`) re-creates every object and answers [`ContextState::Restored`], and the next
//! `execute` refuses with [`ExecError::NeedsFullUpload`] until the caller sends a list with
//! `dirty.all` and every texture re-queued.
use super::{
    Call, ExecOptions, ExecStats, ITEM_TEXELS, ITEMS_PER_ROW, Sabotage, gl_scissor, item_rows_for,
    item_upload_rects, plan_calls,
};
use crate::present::{
    ContextAttributes,
    canvas::{LossWatch, create_context},
};
use glow::HasContext;
use gsw_canvas_draw_list::{
    Blend, DRAW_SCISSOR, DrawList, Format, Sampler, Target, TextureOp, Vertex, WHITE_TEXTURE,
};
use std::cell::Cell;
use std::collections::HashMap;

const UNIT_DRAW: u32 = 0;
const UNIT_ITEMS: u32 = 1;
const UNIT_TARGET: u32 = 2;
const VERTEX_BYTES: usize = std::mem::size_of::<Vertex>();
const INITIAL_VERTICES: usize = 1024;
const INITIAL_INDICES: usize = 3072;

/// The draw program's vertex stage. `a_position` is item-local; the item's row gives `xform`
/// (Godot `Transform2D` columns) and the modulate. The projection is `executor-webgl.ts`'s
/// `a_position * u_projection.xy + u_projection.zw` over the design position.
const VERT: &str = r#"#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_color;  // STRAIGHT
layout(location = 3) in uint a_item;
uniform sampler2D u_items;
uniform vec4 u_projection;
uniform bool u_premultiply;
out vec2 v_uv;
out vec4 v_color;
flat out vec4 v_tint;
void main() {
  int item = int(a_item);
  ivec2 at = ivec2((item % 512) * 3, item / 512);
  vec4 t0 = texelFetch(u_items, at, 0);
  vec4 t1 = texelFetch(u_items, at + ivec2(1, 0), 0);
  vec4 t2 = texelFetch(u_items, at + ivec2(2, 0), 0);
  vec2 design = vec2(t0.x * a_position.x + t0.z * a_position.y + t1.x,
                     t0.y * a_position.x + t0.w * a_position.y + t1.y);
  gl_Position = vec4(design * u_projection.xy + u_projection.zw, 0.0, 1.0);
  v_uv = a_uv;
  // Interpolated STRAIGHT, as Godot's color_interp is; premultiplied per fragment.
  v_color = a_color;
  vec4 modulate = vec4(t1.zw, t2.xy);
  v_tint = u_premultiply ? vec4(modulate.rgb * modulate.a, modulate.a) : modulate;
}"#;

/// The draw program's fragment stage: `TEXTURED_MESH_FRAGMENT_SRC` of `executor-webgl.ts`, with
/// both of its alpha flags folded into `u_premultiply` (on for every blend but `premul_alpha`).
const FRAG: &str = r#"#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_texture;
uniform bool u_premultiply;
in vec2 v_uv;
in vec4 v_color;
flat in vec4 v_tint;
out vec4 fragColor;
void main() {
  vec4 texel = texture(u_texture, v_uv);
  // A straight texel becomes premultiplied only AFTER filtering: Godot's order.
  if (u_premultiply) texel.rgb *= texel.a;
  vec4 color = v_color;
  if (u_premultiply) color.rgb *= color.a;
  fragColor = texel * color * v_tint;
}"#;

/// `present.ts`'s `PRESENT_VERTEX_SRC`: one triangle over the viewport, no attributes.
const PRESENT_VERT: &str = r#"#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1)) - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}"#;

/// `present.ts`'s `PRESENT_FRAGMENT_SRC`: the nearest 8-bit level, as `readPixels` converts.
const PRESENT_FRAG: &str = r#"#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_frame;
out vec4 fragColor;
void main() {
  vec4 c = texelFetch(u_frame, ivec2(gl_FragCoord.xy), 0);
  fragColor = floor(c * 255.0 + 0.5) / 255.0;
}"#;

/// Why an `execute` (or a shot) did nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecError {
    /// The context is lost (and not yet restored). Nothing was drawn.
    Lost,
    /// The executor's objects are new (creation, or a restored context): the list must carry
    /// `dirty.all`, and every texture it draws must be queued again.
    NeedsFullUpload,
    /// The list (or the call) is malformed; nothing was drawn.
    Invalid(String),
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecError::Lost => f.write_str("WebGL2 context lost"),
            ExecError::NeedsFullUpload => {
                f.write_str("context (re)created: send dirty.all and re-queue textures")
            }
            ExecError::Invalid(message) => f.write_str(message),
        }
    }
}

impl From<ExecError> for String {
    fn from(error: ExecError) -> String {
        error.to_string()
    }
}

/// The context as the canvas's loss and restore events last reported it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextState {
    Ready,
    /// Lost and not (yet) restored: `execute` refuses.
    Lost,
    /// Restored, and this call re-created every object: the caller re-sends everything.
    Restored,
}

/// The executor's one outstanding fence (`fenceSync` after a frame's blit).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FenceState {
    /// No fence is outstanding.
    None,
    /// The fence of `execute` number `frame` (1-based) has not signalled yet.
    Pending { frame: u32 },
    /// It signalled (observed by this poll); the fence is deleted and the next `execute` issues one.
    Complete { frame: u32 },
}

/// The glow context plus a count of the calls a frame makes through it.
struct Gl {
    raw: glow::Context,
    calls: Cell<u32>,
}

impl Gl {
    fn new(raw: glow::Context) -> Self {
        Gl {
            raw,
            calls: Cell::new(0),
        }
    }
    /// The context, counting one GL call.
    #[inline]
    fn c(&self) -> &glow::Context {
        self.calls.set(self.calls.get() + 1);
        &self.raw
    }
}

/// What is bound or set, so a frame issues only the changes. `None` is "unknown": the next use
/// issues the call. Reset whenever the objects are re-created.
#[derive(Default)]
struct Cache {
    draw_framebuffer: Option<Option<glow::Framebuffer>>,
    read_framebuffer: Option<Option<glow::Framebuffer>>,
    program: Option<glow::Program>,
    vertex_array: Option<glow::VertexArray>,
    array_buffer: Option<glow::Buffer>,
    active_unit: Option<u32>,
    draw_texture: Option<glow::Texture>,
    draw_sampler: Option<glow::Sampler>,
    blend_enabled: Option<bool>,
    /// 0 MIX (and PREMUL_ALPHA), 1 ADD, 2 SUB, 3 MUL.
    blend_func: Option<u8>,
    scissor_enabled: Option<bool>,
    scissor: Option<[i32; 4]>,
    viewport: Option<[i32; 4]>,
    clear_color: Option<[u32; 4]>,
    premultiply: Option<bool>,
    projection: Option<(u32, u32)>,
}

struct TargetObjects {
    texture: glow::Texture,
    framebuffer: glow::Framebuffer,
    width: u32,
    height: u32,
    format: Format,
}

/// Every GL object besides the list's textures (re-created on restore).
struct Objects {
    program: glow::Program,
    u_projection: Option<glow::UniformLocation>,
    u_premultiply: Option<glow::UniformLocation>,
    present_program: glow::Program,
    present_vertex_array: glow::VertexArray,
    vertex_array: glow::VertexArray,
    vertex_buffer: glow::Buffer,
    index_buffer: glow::Buffer,
    /// Capacities in vertices and indices.
    vertex_capacity: usize,
    index_capacity: usize,
    item_texture: glow::Texture,
    item_rows: u32,
    white: glow::Texture,
    /// Index `wrap · 2 + linear` (wrap 0 clamp, 1 repeat, 2 mirror).
    samplers: [glow::Sampler; 6],
    target: Option<TargetObjects>,
}

fn compile(gl: &glow::Context, vert: &str, frag: &str) -> Result<glow::Program, String> {
    unsafe {
        let program = gl.create_program()?;
        let mut shaders = Vec::new();
        for (kind, source) in [(glow::VERTEX_SHADER, vert), (glow::FRAGMENT_SHADER, frag)] {
            let shader = gl.create_shader(kind)?;
            gl.shader_source(shader, source);
            gl.compile_shader(shader);
            gl.attach_shader(program, shader);
            shaders.push(shader);
        }
        gl.link_program(program);
        let linked = gl.get_program_link_status(program);
        let mut log = String::new();
        if !linked {
            log = gl.get_program_info_log(program);
            for shader in &shaders {
                log.push_str(&gl.get_shader_info_log(*shader));
            }
        }
        for shader in shaders {
            gl.detach_shader(program, shader);
            gl.delete_shader(shader);
        }
        if !linked {
            gl.delete_program(program);
            return Err(format!("canvas-items program link failed: {log}"));
        }
        Ok(program)
    }
}

fn sampler_index(bits: u32) -> usize {
    let wrap = match (bits & Sampler::WRAP_MASK) >> Sampler::WRAP_SHIFT {
        1 => 1,
        2 => 2,
        _ => 0,
    };
    wrap * 2 + (bits & Sampler::LINEAR) as usize
}

impl Objects {
    /// Create every object, leaving the context in the state [`Cache::default`] does not assume.
    /// On failure (a lost context, in practice) objects created so far are left to the context.
    fn create(gl: &glow::Context) -> Result<Objects, String> {
        unsafe {
            let program = compile(gl, VERT, FRAG)?;
            gl.use_program(Some(program));
            let u_projection = gl.get_uniform_location(program, "u_projection");
            let u_premultiply = gl.get_uniform_location(program, "u_premultiply");
            gl.uniform_1_i32(
                gl.get_uniform_location(program, "u_texture").as_ref(),
                UNIT_DRAW as i32,
            );
            gl.uniform_1_i32(
                gl.get_uniform_location(program, "u_items").as_ref(),
                UNIT_ITEMS as i32,
            );
            let present_program = compile(gl, PRESENT_VERT, PRESENT_FRAG)?;
            gl.use_program(Some(present_program));
            gl.uniform_1_i32(
                gl.get_uniform_location(present_program, "u_frame").as_ref(),
                UNIT_TARGET as i32,
            );
            gl.use_program(None);
            let present_vertex_array = gl.create_vertex_array()?;

            let vertex_array = gl.create_vertex_array()?;
            let vertex_buffer = gl.create_buffer()?;
            let index_buffer = gl.create_buffer()?;
            gl.bind_vertex_array(Some(vertex_array));
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(vertex_buffer));
            gl.buffer_data_size(
                glow::ARRAY_BUFFER,
                (INITIAL_VERTICES * VERTEX_BYTES) as i32,
                glow::DYNAMIC_DRAW,
            );
            let stride = VERTEX_BYTES as i32;
            for (location, size, offset) in [(0u32, 2, 0), (1, 2, 8), (2, 4, 16)] {
                gl.enable_vertex_attrib_array(location);
                gl.vertex_attrib_pointer_f32(location, size, glow::FLOAT, false, stride, offset);
            }
            gl.enable_vertex_attrib_array(3);
            gl.vertex_attrib_pointer_i32(3, 1, glow::UNSIGNED_INT, stride, 32);
            gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, Some(index_buffer));
            gl.buffer_data_size(
                glow::ELEMENT_ARRAY_BUFFER,
                (INITIAL_INDICES * 4) as i32,
                glow::DYNAMIC_DRAW,
            );
            gl.bind_vertex_array(None);
            gl.bind_buffer(glow::ARRAY_BUFFER, None);

            let item_texture = gl.create_texture()?;
            gl.active_texture(glow::TEXTURE0 + UNIT_ITEMS);
            gl.bind_texture(glow::TEXTURE_2D, Some(item_texture));
            for (parameter, value) in [
                (glow::TEXTURE_MIN_FILTER, glow::NEAREST),
                (glow::TEXTURE_MAG_FILTER, glow::NEAREST),
                (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE),
                (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE),
            ] {
                gl.tex_parameter_i32(glow::TEXTURE_2D, parameter, value as i32);
            }
            allocate_items(gl, 1);

            let white = gl.create_texture()?;
            gl.active_texture(glow::TEXTURE0 + UNIT_DRAW);
            gl.bind_texture(glow::TEXTURE_2D, Some(white));
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MIN_FILTER,
                glow::NEAREST as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MAG_FILTER,
                glow::NEAREST as i32,
            );
            gl.tex_image_2d(
                glow::TEXTURE_2D,
                0,
                glow::RGBA8 as i32,
                1,
                1,
                0,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelUnpackData::Slice(Some(&[255u8, 255, 255, 255][..])),
            );

            let mut samplers = Vec::with_capacity(6);
            for index in 0..6usize {
                let sampler = gl.create_sampler()?;
                let wrap = [glow::CLAMP_TO_EDGE, glow::REPEAT, glow::MIRRORED_REPEAT][index / 2];
                let filter = if index % 2 == 1 {
                    glow::LINEAR
                } else {
                    glow::NEAREST
                };
                gl.sampler_parameter_i32(sampler, glow::TEXTURE_WRAP_S, wrap as i32);
                gl.sampler_parameter_i32(sampler, glow::TEXTURE_WRAP_T, wrap as i32);
                gl.sampler_parameter_i32(sampler, glow::TEXTURE_MIN_FILTER, filter as i32);
                gl.sampler_parameter_i32(sampler, glow::TEXTURE_MAG_FILTER, filter as i32);
                samplers.push(sampler);
            }
            let samplers: [glow::Sampler; 6] =
                samplers.try_into().map_err(|_| "samplers".to_string())?;

            Ok(Objects {
                program,
                u_projection,
                u_premultiply,
                present_program,
                present_vertex_array,
                vertex_array,
                vertex_buffer,
                index_buffer,
                vertex_capacity: INITIAL_VERTICES,
                index_capacity: INITIAL_INDICES,
                item_texture,
                item_rows: 1,
                white,
                samplers,
                target: None,
            })
        }
    }
}

/// (Re)specify the bound item texture as `rows` rows of RGBA32F (contents undefined).
fn allocate_items(gl: &glow::Context, rows: u32) {
    unsafe {
        gl.tex_image_2d(
            glow::TEXTURE_2D,
            0,
            glow::RGBA32F as i32,
            (ITEMS_PER_ROW * ITEM_TEXELS) as i32,
            rows as i32,
            0,
            glow::RGBA,
            glow::FLOAT,
            glow::PixelUnpackData::Slice(None),
        );
    }
}

/// The executor. See the module note.
pub struct CanvasItemsExecutor {
    canvas: web_sys::HtmlCanvasElement,
    context: web_sys::WebGl2RenderingContext,
    gl: Gl,
    loss: LossWatch,
    options: ExecOptions,
    objects: Option<Objects>,
    cache: Cache,
    textures: HashMap<u32, glow::Texture>,
    calls: Vec<Call>,
    needs_full: bool,
    max_side: u32,
    fence: Option<(glow::Fence, u32)>,
    frames: u32,
    /// Merged calls planned since creation: [`Sabotage::DropDraws`] skips the odd ones, counted
    /// across frames, so a list of one call per frame loses every second frame's draw.
    planned_calls: u64,
}

/// The stage context's attributes (`present.ts`'s `CONTEXT_ATTRIBUTES`).
pub const CONTEXT_ATTRIBUTES: ContextAttributes = ContextAttributes {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultiplied_alpha: true,
    preserve_drawing_buffer: false,
    desynchronized: false,
};

impl CanvasItemsExecutor {
    /// Create `canvas`'s WebGL2 context ([`CONTEXT_ATTRIBUTES`]) and every object a frame needs.
    /// The canvas must have no context yet. The first `execute` must carry `dirty.all`.
    pub fn new(canvas: web_sys::HtmlCanvasElement, options: ExecOptions) -> Result<Self, String> {
        let context = create_context(&canvas, CONTEXT_ATTRIBUTES)?;
        let loss = LossWatch::new(&canvas);
        let raw = glow::Context::from_webgl2_context(context.clone());
        let max_side = unsafe { raw.get_parameter_i32(glow::MAX_TEXTURE_SIZE) } as u32;
        let objects = Objects::create(&raw)?;
        Ok(CanvasItemsExecutor {
            canvas,
            context,
            gl: Gl::new(raw),
            loss,
            options,
            objects: Some(objects),
            cache: Cache::default(),
            textures: HashMap::new(),
            calls: Vec::new(),
            needs_full: true,
            max_side,
            fence: None,
            frames: 0,
            planned_calls: 0,
        })
    }

    pub fn options(&self) -> ExecOptions {
        self.options
    }

    pub fn set_options(&mut self, options: ExecOptions) {
        self.options = options;
    }

    /// The WebGL2 context this executor owns (for diagnostics; do not change its state).
    pub fn context(&self) -> &web_sys::WebGl2RenderingContext {
        &self.context
    }

    /// The target's size, once a frame allocated it.
    pub fn target_size(&self) -> Option<(u32, u32)> {
        self.objects
            .as_ref()
            .and_then(|o| o.target.as_ref())
            .map(|t| (t.width, t.height))
    }

    /// Whether the list's texture `id` is resident.
    pub fn has_texture(&self, id: u32) -> bool {
        id == WHITE_TEXTURE || self.textures.contains_key(&id)
    }

    /// Learn about loss and restore from the canvas's events. On the first call after
    /// `webglcontextrestored` this re-creates every object and answers `Restored`: every texture is
    /// gone, and the next `execute` needs `dirty.all` and re-queued texture uploads.
    pub fn context_state(&mut self) -> ContextState {
        if self.loss.lost() {
            if !self.loss.take_restored() {
                return ContextState::Lost;
            }
            // Every handle belongs to the dead context: forget them without calling GL.
            self.textures.clear();
            self.fence = None;
            self.objects = None;
            self.cache = Cache::default();
            self.gl = Gl::new(glow::Context::from_webgl2_context(self.context.clone()));
            return match Objects::create(&self.gl.raw) {
                Ok(objects) => {
                    self.objects = Some(objects);
                    self.needs_full = true;
                    ContextState::Restored
                }
                Err(_) => {
                    self.loss.mark_lost();
                    ContextState::Lost
                }
            };
        }
        if self.objects.is_some() {
            ContextState::Ready
        } else {
            ContextState::Lost
        }
    }

    /// Run one frame of `list` (see the module note) and blit it to the canvas. The caller calls
    /// `list.consumed()` afterwards. On an error nothing was drawn.
    pub fn execute(&mut self, list: &DrawList) -> Result<ExecStats, ExecError> {
        let mut stats = ExecStats {
            draws: list.draws.len() as u32,
            ..ExecStats::default()
        };
        match self.context_state() {
            ContextState::Lost => return Err(ExecError::Lost),
            ContextState::Restored => stats.restored = 1,
            ContextState::Ready => {}
        }
        if self.needs_full && !list.dirty.all {
            return Err(ExecError::NeedsFullUpload);
        }
        self.validate(list)?;
        self.gl.calls.set(0);
        self.frames += 1;
        self.texture_ops(list, &mut stats);
        self.ensure_target(&list.target)?;
        self.upload(list, &mut stats);
        let mut calls = std::mem::take(&mut self.calls);
        let counts = {
            let textures = &self.textures;
            plan_calls(list, |id| textures.contains_key(&id), &mut calls)
        };
        stats.draws_merged = counts.merged;
        stats.draws_skipped = counts.skipped;
        self.draw(list, &calls, &mut stats);
        self.calls = calls;
        self.blit(list.target.format);
        if self.fence.is_none()
            && let Ok(fence) =
                unsafe { self.gl.c().fence_sync(glow::SYNC_GPU_COMMANDS_COMPLETE, 0) }
        {
            self.fence = Some((fence, self.frames));
            stats.fence_issued = 1;
        }
        self.needs_full = false;
        stats.gl_calls = self.gl.calls.get();
        Ok(stats)
    }

    /// Poll the outstanding fence without blocking. WebGL updates a sync's status only between
    /// tasks, so poll on a later frame (the g31 has no timer query; G7x's `gpu_complete_ms`).
    pub fn poll_fence(&mut self) -> FenceState {
        let Some((fence, frame)) = self.fence else {
            return FenceState::None;
        };
        if self.loss.lost() {
            return FenceState::Pending { frame };
        }
        let status = unsafe { self.gl.raw.get_sync_status(fence) };
        if status == glow::SIGNALED {
            unsafe { self.gl.raw.delete_sync(fence) };
            self.fence = None;
            FenceState::Complete { frame }
        } else {
            FenceState::Pending { frame }
        }
    }

    /// The shot: `readPixels` RGBA/UNSIGNED_BYTE of the target (G7c's `StageTarget.readPixels`:
    /// each 10- or 2-bit channel rounded to the nearest 8-bit level), rows TOP-DOWN, into
    /// `out[..4·w·h]`.
    pub fn read_target(&mut self, out: &mut [u8]) -> Result<(), ExecError> {
        if self.context_state() != ContextState::Ready {
            return Err(ExecError::Lost);
        }
        let Some(target) = self.objects.as_ref().and_then(|o| o.target.as_ref()) else {
            return Err(ExecError::Invalid(
                "no frame has allocated the target yet".into(),
            ));
        };
        let (framebuffer, width, height) = (target.framebuffer, target.width, target.height);
        self.read(Some(framebuffer), width, height, out)
    }

    /// The canvas's drawing buffer after the blit, rows top-down (same task only: the canvas does
    /// not preserve its drawing buffer). For tests: compositor-equals-readback.
    pub fn read_canvas(&mut self, out: &mut [u8]) -> Result<(), ExecError> {
        if self.context_state() != ContextState::Ready {
            return Err(ExecError::Lost);
        }
        let (width, height) = (self.canvas.width(), self.canvas.height());
        self.read(None, width, height, out)
    }

    /// `gl.getError()`, for tests (never on the frame path).
    pub fn gl_error(&self) -> u32 {
        unsafe { self.gl.raw.get_error() }
    }

    fn read(
        &mut self,
        framebuffer: Option<glow::Framebuffer>,
        width: u32,
        height: u32,
        out: &mut [u8],
    ) -> Result<(), ExecError> {
        let stride = width as usize * 4;
        let length = stride * height as usize;
        if out.len() < length {
            return Err(ExecError::Invalid(format!(
                "read: {length} bytes needed, {} given",
                out.len()
            )));
        }
        self.bind_read_framebuffer(framebuffer);
        unsafe {
            self.gl.c().read_pixels(
                0,
                0,
                width as i32,
                height as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelPackData::Slice(Some(&mut out[..length])),
            );
        }
        // GL rows come back bottom-up.
        let (mut top, mut bottom) = (0usize, height as usize);
        while top + 1 < bottom {
            bottom -= 1;
            let (head, tail) = out.split_at_mut(bottom * stride);
            head[top * stride..top * stride + stride].swap_with_slice(&mut tail[..stride]);
            top += 1;
        }
        Ok(())
    }

    fn validate(&self, list: &DrawList) -> Result<(), ExecError> {
        let Target {
            width,
            height,
            clear,
            ..
        } = list.target;
        if width == 0 || height == 0 || width > self.max_side || height > self.max_side {
            return Err(ExecError::Invalid(format!(
                "target {width}x{height} outside 1..={}",
                self.max_side
            )));
        }
        if clear.iter().any(|c| !c.is_finite()) {
            return Err(ExecError::Invalid(
                "target clear colour is not finite".into(),
            ));
        }
        if item_rows_for(list.items.len()) > self.max_side {
            return Err(ExecError::Invalid(format!(
                "{} items exceed the item texture",
                list.items.len()
            )));
        }
        for op in &list.texture_ops {
            match *op {
                TextureOp::Upload {
                    id,
                    width,
                    height,
                    offset,
                } => {
                    if id == WHITE_TEXTURE {
                        return Err(ExecError::Invalid("texture id 0 is the white texel".into()));
                    }
                    if width == 0 || height == 0 || width > self.max_side || height > self.max_side
                    {
                        return Err(ExecError::Invalid(format!(
                            "texture {id}: size {width}x{height}"
                        )));
                    }
                    let end = u64::from(offset) + 4 * u64::from(width) * u64::from(height);
                    if end > list.texture_bytes.len() as u64 {
                        return Err(ExecError::Invalid(format!(
                            "texture {id}: bytes outside texture_bytes"
                        )));
                    }
                }
                TextureOp::Free { id } => {
                    if id == WHITE_TEXTURE {
                        return Err(ExecError::Invalid("texture id 0 is the white texel".into()));
                    }
                }
            }
        }
        Ok(())
    }

    fn texture_ops(&mut self, list: &DrawList, stats: &mut ExecStats) {
        for op in &list.texture_ops {
            match *op {
                TextureOp::Upload {
                    id,
                    width,
                    height,
                    offset,
                } => {
                    let texture = match self.textures.get(&id) {
                        Some(texture) => *texture,
                        None => match unsafe { self.gl.c().create_texture() } {
                            Ok(texture) => {
                                self.textures.insert(id, texture);
                                texture
                            }
                            Err(_) => {
                                self.loss.mark_lost();
                                continue;
                            }
                        },
                    };
                    self.bind_draw_texture(texture, stats);
                    let start = offset as usize;
                    let bytes =
                        &list.texture_bytes[start..start + 4 * width as usize * height as usize];
                    unsafe {
                        self.gl.c().tex_image_2d(
                            glow::TEXTURE_2D,
                            0,
                            glow::RGBA8 as i32,
                            width as i32,
                            height as i32,
                            0,
                            glow::RGBA,
                            glow::UNSIGNED_BYTE,
                            glow::PixelUnpackData::Slice(Some(bytes)),
                        );
                    }
                    stats.texture_uploads += 1;
                    stats.texture_upload_bytes += bytes.len() as u32;
                }
                TextureOp::Free { id } => {
                    if let Some(texture) = self.textures.remove(&id) {
                        unsafe { self.gl.c().delete_texture(texture) };
                        if self.cache.draw_texture == Some(texture) {
                            self.cache.draw_texture = None;
                        }
                        stats.texture_frees += 1;
                    }
                }
            }
        }
    }

    fn ensure_target(&mut self, target: &Target) -> Result<(), ExecError> {
        let objects = self.objects.as_mut().ok_or(ExecError::Lost)?;
        if let Some(t) = &objects.target
            && t.width == target.width
            && t.height == target.height
            && t.format == target.format
        {
            return Ok(());
        }
        let gl = &self.gl;
        if let Some(old) = objects.target.take() {
            unsafe {
                gl.c().delete_framebuffer(old.framebuffer);
                gl.c().delete_texture(old.texture);
            }
        }
        let internal = match target.format {
            Format::Rgb10A2 => glow::RGB10_A2,
            Format::Rgba8 => glow::RGBA8,
        };
        let (texture, framebuffer, complete) = unsafe {
            let texture = gl.c().create_texture().map_err(|_| ExecError::Lost)?;
            let framebuffer = gl.c().create_framebuffer().map_err(|_| ExecError::Lost)?;
            gl.c().active_texture(glow::TEXTURE0 + UNIT_TARGET);
            gl.c().bind_texture(glow::TEXTURE_2D, Some(texture));
            for parameter in [glow::TEXTURE_MIN_FILTER, glow::TEXTURE_MAG_FILTER] {
                gl.c()
                    .tex_parameter_i32(glow::TEXTURE_2D, parameter, glow::NEAREST as i32);
            }
            for parameter in [glow::TEXTURE_WRAP_S, glow::TEXTURE_WRAP_T] {
                gl.c()
                    .tex_parameter_i32(glow::TEXTURE_2D, parameter, glow::CLAMP_TO_EDGE as i32);
            }
            gl.c().tex_storage_2d(
                glow::TEXTURE_2D,
                1,
                internal,
                target.width as i32,
                target.height as i32,
            );
            gl.c()
                .bind_framebuffer(glow::FRAMEBUFFER, Some(framebuffer));
            gl.c().framebuffer_texture_2d(
                glow::FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::TEXTURE_2D,
                Some(texture),
                0,
            );
            let complete =
                gl.c().check_framebuffer_status(glow::FRAMEBUFFER) == glow::FRAMEBUFFER_COMPLETE;
            (texture, framebuffer, complete)
        };
        self.cache.active_unit = Some(UNIT_TARGET);
        self.cache.draw_framebuffer = Some(Some(framebuffer));
        self.cache.read_framebuffer = Some(Some(framebuffer));
        if !complete {
            unsafe {
                gl.c().delete_framebuffer(framebuffer);
                gl.c().delete_texture(texture);
            }
            self.cache.draw_framebuffer = None;
            self.cache.read_framebuffer = None;
            return Err(ExecError::Invalid(format!(
                "target format {:?} is not renderable here",
                target.format
            )));
        }
        objects.target = Some(TargetObjects {
            texture,
            framebuffer,
            width: target.width,
            height: target.height,
            format: target.format,
        });
        if self.canvas.width() != target.width {
            self.canvas.set_width(target.width);
        }
        if self.canvas.height() != target.height {
            self.canvas.set_height(target.height);
        }
        Ok(())
    }

    fn upload(&mut self, list: &DrawList, stats: &mut ExecStats) {
        let all = list.dirty.all || self.needs_full;
        let Some(objects) = self.objects.as_mut() else {
            return;
        };
        let gl = &self.gl;
        let cache = &mut self.cache;

        // Item rows: unit 1 always holds the item texture.
        let rows = item_rows_for(list.items.len());
        let mut items_all = all;
        if rows > objects.item_rows {
            let grown = rows.next_power_of_two();
            set_active_unit(gl, cache, UNIT_ITEMS);
            allocate_items(gl.c(), grown);
            objects.item_rows = grown;
            items_all = true;
        }
        let mut upload_items = |start: u32, end: u32, stats: &mut ExecStats| {
            let end = end.min(list.items.len() as u32);
            for rect in item_upload_rects(start, end) {
                set_active_unit(gl, cache, UNIT_ITEMS);
                let items = &list.items[rect.first as usize..(rect.first + rect.count) as usize];
                let bytes: &[u8] = bytemuck::cast_slice(items);
                unsafe {
                    gl.c().tex_sub_image_2d(
                        glow::TEXTURE_2D,
                        0,
                        rect.x as i32,
                        rect.y as i32,
                        rect.width as i32,
                        rect.height as i32,
                        glow::RGBA,
                        glow::FLOAT,
                        glow::PixelUnpackData::Slice(Some(bytes)),
                    );
                }
                stats.item_rows += rect.count;
                stats.item_bytes += bytes.len() as u32;
                stats.upload_calls += 1;
            }
        };
        if items_all {
            upload_items(0, list.items.len() as u32, stats);
        } else if self.options.sabotage != Some(Sabotage::StaleItemRow) {
            for &(start, end) in list.dirty.items.as_slice() {
                upload_items(start, end, stats);
            }
        }

        // Vertices: ARRAY_BUFFER is not vertex-array state.
        let mut vertices_all = all;
        if list.vertices.len() > objects.vertex_capacity {
            objects.vertex_capacity = list.vertices.len().next_power_of_two();
            bind_array_buffer(gl, cache, objects.vertex_buffer);
            unsafe {
                gl.c().buffer_data_size(
                    glow::ARRAY_BUFFER,
                    (objects.vertex_capacity * VERTEX_BYTES) as i32,
                    glow::DYNAMIC_DRAW,
                );
            }
            vertices_all = true;
        }
        let vertex_ranges = if vertices_all {
            vec![(0, list.vertices.len() as u32)]
        } else {
            list.dirty.vertices.as_slice().to_vec()
        };
        for (start, end) in vertex_ranges {
            let end = (end as usize).min(list.vertices.len());
            let start = start as usize;
            if start >= end {
                continue;
            }
            bind_array_buffer(gl, cache, objects.vertex_buffer);
            let bytes: &[u8] = bytemuck::cast_slice(&list.vertices[start..end]);
            unsafe {
                gl.c().buffer_sub_data_u8_slice(
                    glow::ARRAY_BUFFER,
                    (start * VERTEX_BYTES) as i32,
                    bytes,
                )
            };
            stats.vertex_bytes += bytes.len() as u32;
            stats.upload_calls += 1;
        }

        // Indices: ELEMENT_ARRAY_BUFFER is the vertex array's, so bind that first.
        let mut indices_all = all;
        if list.indices.len() > objects.index_capacity {
            objects.index_capacity = list.indices.len().next_power_of_two();
            bind_vertex_array(gl, cache, objects.vertex_array);
            unsafe {
                gl.c().buffer_data_size(
                    glow::ELEMENT_ARRAY_BUFFER,
                    (objects.index_capacity * 4) as i32,
                    glow::DYNAMIC_DRAW,
                );
            }
            indices_all = true;
        }
        let index_ranges = if indices_all {
            vec![(0, list.indices.len() as u32)]
        } else {
            list.dirty.indices.as_slice().to_vec()
        };
        for (start, end) in index_ranges {
            let end = (end as usize).min(list.indices.len());
            let start = start as usize;
            if start >= end {
                continue;
            }
            bind_vertex_array(gl, cache, objects.vertex_array);
            let bytes: &[u8] = bytemuck::cast_slice(&list.indices[start..end]);
            unsafe {
                gl.c().buffer_sub_data_u8_slice(
                    glow::ELEMENT_ARRAY_BUFFER,
                    (start * 4) as i32,
                    bytes,
                )
            };
            stats.index_bytes += bytes.len() as u32;
            stats.upload_calls += 1;
        }
    }

    fn draw(&mut self, list: &DrawList, calls: &[Call], stats: &mut ExecStats) {
        let Some(objects) = self.objects.as_ref() else {
            return;
        };
        let Some(target) = objects.target.as_ref() else {
            return;
        };
        let gl = &self.gl;
        let cache = &mut self.cache;
        let (width, height) = (target.width, target.height);

        bind_draw_framebuffer(gl, cache, Some(target.framebuffer));
        set_viewport(gl, cache, width, height);
        set_scissor_enabled(gl, cache, false);
        // The list's clear colour is straight; the target holds premultiplied colour.
        let [r, g, b, a] = list.target.clear;
        let clear = [r * a, g * a, b * a, a];
        let bits = clear.map(f32::to_bits);
        if cache.clear_color != Some(bits) {
            unsafe { gl.c().clear_color(clear[0], clear[1], clear[2], clear[3]) };
            cache.clear_color = Some(bits);
        }
        unsafe { gl.c().clear(glow::COLOR_BUFFER_BIT) };
        if calls.is_empty() {
            return;
        }

        if cache.program != Some(objects.program) {
            unsafe { gl.c().use_program(Some(objects.program)) };
            cache.program = Some(objects.program);
        }
        if cache.projection != Some((width, height)) {
            unsafe {
                gl.c().uniform_4_f32(
                    objects.u_projection.as_ref(),
                    // `present.ts`'s `toClip`: the f64 quotient stored as f32.
                    (2.0 / f64::from(width)) as f32,
                    (-2.0 / f64::from(height)) as f32,
                    -1.0,
                    1.0,
                )
            };
            cache.projection = Some((width, height));
        }
        bind_vertex_array(gl, cache, objects.vertex_array);

        for call in calls.iter() {
            let n = self.planned_calls;
            self.planned_calls += 1;
            if self.options.sabotage == Some(Sabotage::DropDraws) && n % 2 == 1 {
                stats.calls_dropped += 1;
                continue;
            }
            let draw = &list.draws[call.draw as usize];
            // `plan_calls` admitted only known blends.
            let blend = Blend::from_u32(draw.blend).unwrap_or(Blend::Mix);
            if draw.flags & DRAW_SCISSOR != 0 {
                set_scissor_enabled(gl, cache, true);
                let scissor = gl_scissor(draw.scissor, height);
                if cache.scissor != Some(scissor) {
                    unsafe {
                        gl.c()
                            .scissor(scissor[0], scissor[1], scissor[2], scissor[3])
                    };
                    cache.scissor = Some(scissor);
                    stats.scissor_changes += 1;
                }
            } else {
                set_scissor_enabled(gl, cache, false);
            }
            set_blend(gl, cache, blend, stats);
            let premultiply = blend != Blend::PremulAlpha;
            if cache.premultiply != Some(premultiply) {
                unsafe {
                    gl.c()
                        .uniform_1_i32(objects.u_premultiply.as_ref(), premultiply as i32)
                };
                cache.premultiply = Some(premultiply);
            }
            if draw.texture == WHITE_TEXTURE {
                // A 1×1 white texel samples white under every filter and wrap: keep the sampler.
                bind_draw_texture_with(gl, cache, objects.white, stats);
            } else if let Some(texture) = self.textures.get(&draw.texture) {
                bind_draw_texture_with(gl, cache, *texture, stats);
                let sampler = objects.samplers[sampler_index(draw.sampler)];
                if cache.draw_sampler != Some(sampler) {
                    unsafe { gl.c().bind_sampler(UNIT_DRAW, Some(sampler)) };
                    cache.draw_sampler = Some(sampler);
                    stats.sampler_binds += 1;
                }
            }
            unsafe {
                gl.c().draw_elements(
                    glow::TRIANGLES,
                    call.index_count as i32,
                    glow::UNSIGNED_INT,
                    (call.first_index * 4) as i32,
                )
            };
            stats.draw_calls += 1;
        }
    }

    /// G7c's `StageTarget.blit()`: RGB10_A2 through the rounding `texelFetch` draw, RGBA8 through
    /// `blitFramebuffer`. Leaves the canvas bound for drawing.
    fn blit(&mut self, format: Format) {
        let Some(objects) = self.objects.as_ref() else {
            return;
        };
        let Some(target) = objects.target.as_ref() else {
            return;
        };
        let gl = &self.gl;
        let cache = &mut self.cache;
        set_scissor_enabled(gl, cache, false);
        match format {
            Format::Rgb10A2 => {
                bind_draw_framebuffer(gl, cache, None);
                set_viewport(gl, cache, target.width, target.height);
                if cache.blend_enabled != Some(false) {
                    unsafe { gl.c().disable(glow::BLEND) };
                    cache.blend_enabled = Some(false);
                }
                if cache.program != Some(objects.present_program) {
                    unsafe { gl.c().use_program(Some(objects.present_program)) };
                    cache.program = Some(objects.present_program);
                }
                bind_vertex_array(gl, cache, objects.present_vertex_array);
                unsafe { gl.c().draw_arrays(glow::TRIANGLES, 0, 3) };
            }
            Format::Rgba8 => {
                bind_draw_framebuffer(gl, cache, None);
                bind_read(gl, cache, Some(target.framebuffer));
                let (w, h) = (target.width as i32, target.height as i32);
                unsafe {
                    gl.c().blit_framebuffer(
                        0,
                        0,
                        w,
                        h,
                        0,
                        0,
                        w,
                        h,
                        glow::COLOR_BUFFER_BIT,
                        glow::NEAREST,
                    )
                };
            }
        }
    }

    fn bind_read_framebuffer(&mut self, framebuffer: Option<glow::Framebuffer>) {
        bind_read(&self.gl, &mut self.cache, framebuffer);
    }

    fn bind_draw_texture(&mut self, texture: glow::Texture, stats: &mut ExecStats) {
        bind_draw_texture_with(&self.gl, &mut self.cache, texture, stats);
    }
}

impl Drop for CanvasItemsExecutor {
    fn drop(&mut self) {
        if self.loss.lost() {
            return;
        }
        let gl = &self.gl.raw;
        unsafe {
            if let Some((fence, _)) = self.fence.take() {
                gl.delete_sync(fence);
            }
            for (_, texture) in self.textures.drain() {
                gl.delete_texture(texture);
            }
            if let Some(o) = self.objects.take() {
                gl.delete_program(o.program);
                gl.delete_program(o.present_program);
                gl.delete_vertex_array(o.present_vertex_array);
                gl.delete_vertex_array(o.vertex_array);
                gl.delete_buffer(o.vertex_buffer);
                gl.delete_buffer(o.index_buffer);
                gl.delete_texture(o.item_texture);
                gl.delete_texture(o.white);
                for sampler in o.samplers {
                    gl.delete_sampler(sampler);
                }
                if let Some(t) = o.target {
                    gl.delete_framebuffer(t.framebuffer);
                    gl.delete_texture(t.texture);
                }
            }
        }
    }
}

fn set_active_unit(gl: &Gl, cache: &mut Cache, unit: u32) {
    if cache.active_unit != Some(unit) {
        unsafe { gl.c().active_texture(glow::TEXTURE0 + unit) };
        cache.active_unit = Some(unit);
    }
}

fn bind_draw_texture_with(
    gl: &Gl,
    cache: &mut Cache,
    texture: glow::Texture,
    stats: &mut ExecStats,
) {
    if cache.draw_texture != Some(texture) {
        set_active_unit(gl, cache, UNIT_DRAW);
        unsafe { gl.c().bind_texture(glow::TEXTURE_2D, Some(texture)) };
        cache.draw_texture = Some(texture);
        stats.texture_binds += 1;
    }
}

fn bind_array_buffer(gl: &Gl, cache: &mut Cache, buffer: glow::Buffer) {
    if cache.array_buffer != Some(buffer) {
        unsafe { gl.c().bind_buffer(glow::ARRAY_BUFFER, Some(buffer)) };
        cache.array_buffer = Some(buffer);
    }
}

fn bind_vertex_array(gl: &Gl, cache: &mut Cache, vertex_array: glow::VertexArray) {
    if cache.vertex_array != Some(vertex_array) {
        unsafe { gl.c().bind_vertex_array(Some(vertex_array)) };
        cache.vertex_array = Some(vertex_array);
    }
}

fn bind_draw_framebuffer(gl: &Gl, cache: &mut Cache, framebuffer: Option<glow::Framebuffer>) {
    if cache.draw_framebuffer != Some(framebuffer) {
        unsafe { gl.c().bind_framebuffer(glow::DRAW_FRAMEBUFFER, framebuffer) };
        cache.draw_framebuffer = Some(framebuffer);
    }
}

fn bind_read(gl: &Gl, cache: &mut Cache, framebuffer: Option<glow::Framebuffer>) {
    if cache.read_framebuffer != Some(framebuffer) {
        unsafe { gl.c().bind_framebuffer(glow::READ_FRAMEBUFFER, framebuffer) };
        cache.read_framebuffer = Some(framebuffer);
    }
}

fn set_viewport(gl: &Gl, cache: &mut Cache, width: u32, height: u32) {
    let viewport = [0, 0, width as i32, height as i32];
    if cache.viewport != Some(viewport) {
        unsafe { gl.c().viewport(0, 0, width as i32, height as i32) };
        cache.viewport = Some(viewport);
    }
}

fn set_scissor_enabled(gl: &Gl, cache: &mut Cache, enabled: bool) {
    if cache.scissor_enabled != Some(enabled) {
        unsafe {
            if enabled {
                gl.c().enable(glow::SCISSOR_TEST)
            } else {
                gl.c().disable(glow::SCISSOR_TEST)
            }
        };
        cache.scissor_enabled = Some(enabled);
    }
}

/// `executor-webgl.ts`'s `BLEND_STATES`; `PremulAlpha` is MIX's GL state, `Disabled` no blending.
fn set_blend(gl: &Gl, cache: &mut Cache, blend: Blend, stats: &mut ExecStats) {
    let enabled = blend != Blend::Disabled;
    if cache.blend_enabled != Some(enabled) {
        unsafe {
            if enabled {
                gl.c().enable(glow::BLEND)
            } else {
                gl.c().disable(glow::BLEND)
            }
        };
        cache.blend_enabled = Some(enabled);
    }
    if !enabled {
        return;
    }
    let (func, equation_rgb, src_rgb, dst_rgb, src_alpha, dst_alpha) = match blend {
        Blend::Add => (
            1u8,
            glow::FUNC_ADD,
            glow::ONE,
            glow::ONE,
            glow::ONE,
            glow::ONE,
        ),
        Blend::Sub => (
            2,
            glow::FUNC_REVERSE_SUBTRACT,
            glow::ONE,
            glow::ONE,
            glow::ONE,
            glow::ONE,
        ),
        Blend::Mul => (
            3,
            glow::FUNC_ADD,
            glow::DST_COLOR,
            glow::ZERO,
            glow::DST_ALPHA,
            glow::ZERO,
        ),
        _ => (
            0,
            glow::FUNC_ADD,
            glow::ONE,
            glow::ONE_MINUS_SRC_ALPHA,
            glow::ONE,
            glow::ONE_MINUS_SRC_ALPHA,
        ),
    };
    if cache.blend_func != Some(func) {
        unsafe {
            gl.c().blend_equation_separate(equation_rgb, glow::FUNC_ADD);
            gl.c()
                .blend_func_separate(src_rgb, dst_rgb, src_alpha, dst_alpha);
        }
        cache.blend_func = Some(func);
        stats.blend_changes += 1;
    }
}
