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
    CANVAS_INVERSE_UNIFORM, CANVAS_MATRIX_UNIFORM, Call, ExecOptions, ExecStats,
    FIRST_SAMPLER_UNIT, ITEM_TEXELS, ITEMS_PER_ROW, MAX_PROGRAM_SAMPLERS, Sabotage, blend_state,
    downscale_factor, downscale_rgba8, downscale_texels_nearest, downscaled_size, gl_enum,
    gl_scissor, gl_scissor_y_up, godot_screen_transform, item_program_fragment,
    item_program_vertex, item_rows_for, item_upload_rects, msdf_fragment, plan_calls,
    SurfacePass, drawable, call_bounds, effective_scissor, partial_back_work,
    group_depth::{GroupDepth, depth_ndc},
    program_poll::{link_ready, poll_links},
    item_shaders::{ItemShaders, LinkShaders, ShaderApi},
};
use crate::present::{
    ContextAttributes,
    canvas::{LossWatch, create_context},
};
use glow::HasContext;
use gsw_canvas_draw_list::{
    ANISOTROPY_TEXTURE, BLACK_TEXTURE, BUILTIN_PROGRAM, Blend, CompressedFormat,
    DepthTile, DRAW_GROUP_CLIP, DRAW_GROUP_COMPOSITE, DRAW_INSTANCED, DRAW_MSDF, DRAW_SCISSOR,
    DRAW_TO_BACK_BUFFER, DRAW_UNTEXTURED, Draw, DrawList, Format, Instance, NORMAL_TEXTURE,
    ROOT_SURFACE, SCREEN_TEXTURE, Sampler, ScreenOp, ScreenOpKind, TRANSPARENT_TEXTURE, Target, TextureOp,
    UniformValue, Vertex, WHITE_TEXTURE, default_texture_texel, premultiplies,
};
use gsw_canvas_draw_list::{damage::{DamageFacts, Plan, PlanOptions, Planner}, cover::ProgramFacts};
use std::cell::Cell;
use std::collections::HashMap;
use std::ops::ControlFlow;
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

/// The default-texture ids beside [`WHITE_TEXTURE`], in `Objects::defaults` order.
const DEFAULT_TEXTURE_IDS: [u32; 4] =
    [BLACK_TEXTURE, TRANSPARENT_TEXTURE, NORMAL_TEXTURE, ANISOTROPY_TEXTURE];

const IDENTITY_MAT4: [f32; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

const UNIT_DRAW: u32 = 0;
const UNIT_ITEMS: u32 = 1;
const UNIT_TARGET: u32 = 2;
const VERTEX_BYTES: usize = std::mem::size_of::<Vertex>();
const INITIAL_VERTICES: usize = 1024;
/// The instance attributes (`a_inst0`, `a_inst1`, `a_inst_color`, `a_inst_custom`).
const INSTANCE_ATTRIBUTES: u32 = 4;
const INSTANCE_BYTES: usize = std::mem::size_of::<Instance>();
const INITIAL_INSTANCES: usize = 64;
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
// PM3: a DRAW_INSTANCED draw's instance (gsw_canvas_draw_list::Instance); every other draw sees the
// identity instance as constant attributes, which leaves its arithmetic exact.
layout(location = 4) in vec4 a_inst0;
layout(location = 5) in vec4 a_inst1;
layout(location = 6) in vec4 a_inst_color;
uniform sampler2D u_items;
uniform vec4 u_projection;
// ExecOptions::godot_orientation: Godot's screen_transform as canvas.glsl applies it.
uniform bool u_godot_screen;
uniform mat4 u_screen;
uniform bool u_premultiply;
// DrawList::depth_draws: the draw's depth (NDC), read only while the depth test is on.
uniform float u_depth;
out vec2 v_uv;
out vec4 v_color;
flat out vec4 v_tint;
// G7o4: the row's ITEM_UNTEXTURED flag (bit 30 of the flags word, read through its float bits).
flat out uint v_untextured;
void main() {
  int item = int(a_item);
  ivec2 at = ivec2((item % 512) * 3, item / 512);
  vec4 t0 = texelFetch(u_items, at, 0);
  vec4 t1 = texelFetch(u_items, at + ivec2(1, 0), 0);
  vec4 t2 = texelFetch(u_items, at + ivec2(2, 0), 0);
  // canvas.glsl's `model_matrix * transpose(mat4(instance_xform0, instance_xform1, ..))`: the
  // item's 2x3 times the instance's rows.
  vec4 m = vec4(t0.x * a_inst0.x + t0.z * a_inst1.x, t0.y * a_inst0.x + t0.w * a_inst1.x,
                t0.x * a_inst0.y + t0.z * a_inst1.y, t0.y * a_inst0.y + t0.w * a_inst1.y);
  vec2 o = vec2(t0.x * a_inst0.w + t0.z * a_inst1.w + t1.x,
                t0.y * a_inst0.w + t0.w * a_inst1.w + t1.y);
  vec2 design = vec2(m.x * a_position.x + m.z * a_position.y + o.x,
                     m.y * a_position.x + m.w * a_position.y + o.y);
  gl_Position = u_godot_screen ? u_screen * vec4(design, 0.0, 1.0)
                               : vec4(design * u_projection.xy + u_projection.zw, 0.0, 1.0);
  // Depth only: x, y and w (so coverage and every varying) are untouched.
  gl_Position.z = u_depth * gl_Position.w;
  v_uv = a_uv;
  // Interpolated STRAIGHT, as Godot's color_interp is; premultiplied per fragment.
  v_color = a_color * a_inst_color;
  vec4 modulate = vec4(t1.zw, t2.xy);
  v_tint = u_premultiply ? vec4(modulate.rgb * modulate.a, modulate.a) : modulate;
  v_untextured = (floatBitsToUint(t2.z) >> 30) & 1u;
}"#;

/// The draw program's fragment stage: `TEXTURED_MESH_FRAGMENT_SRC` of `executor-webgl.ts`, with
/// both of its alpha flags folded into `u_premultiply` (on for every blend but `premul_alpha`).
const FRAG: &str = r#"#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_texture;
uniform bool u_premultiply;
uniform bool u_texel_premultiply;
in vec2 v_uv;
in vec4 v_color;
flat in vec4 v_tint;
flat in uint v_untextured;
out vec4 fragColor;
void main() {
  // G7o4: an untextured item's fragment takes the white texel's exact value (1.0), whatever
  // texture its merged call binds (sampled first, outside any branch).
  vec4 sampled = texture(u_texture, v_uv);
  vec4 texel = v_untextured != 0u ? vec4(1.0) : sampled;
  // A straight texel becomes premultiplied only AFTER filtering: Godot's order.
  if (u_texel_premultiply) texel.rgb *= texel.a;
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
// ExecOptions::godot_orientation: the target's height (its rows are design rows), else 0.
uniform int u_flip_rows;
out vec4 fragColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (u_flip_rows > 0) p.y = u_flip_rows - 1 - p.y;
  vec4 c = texelFetch(u_frame, p, 0);
  fragColor = floor(c * 255.0 + 0.5) / 255.0;
}"#;

/// The depth tiles' pre-pass (`DrawList::depth_tiles`): clip-space positions with the tile's depth,
/// no colour written (the colour mask is off while it draws).
const DEPTH_VERT: &str = r#"#version 300 es
layout(location = 0) in vec3 a_position;
void main() {
  gl_Position = vec4(a_position, 1.0);
}"#;

const DEPTH_FRAG: &str = r#"#version 300 es
precision mediump float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.0);
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
    /// 0 MIX (and PREMUL_ALPHA), 1 ADD, 2 SUB, 3 MUL; bit 4 an opaque target's alpha factors.
    blend_func: Option<u8>,
    scissor_enabled: Option<bool>,
    scissor: Option<[i32; 4]>,
    viewport: Option<[i32; 4]>,
    clear_color: Option<[u32; 4]>,
    /// The BUILTIN program's premultiply uniforms and projection (item-space programs keep
    /// their own in [`CompiledItem`]).
    premultiply: Option<bool>,
    projection: Option<(u32, u32, bool)>,
    /// The present program's `u_flip_rows` (Godot's orientation).
    flip_rows: Option<i32>,
    /// The builtin MSDF program's projection and [`MsdfState`].
    msdf_projection: Option<(u32, u32, bool)>,
    msdf_state: Option<MsdfState>,
    /// Texture and sampler object on each item-space sampler unit.
    units: [Option<(glow::Texture, glow::Sampler)>; 16],
    /// Depth state: the test (its function is always GREATER once set), the depth and colour
    /// write masks, the clear depth (always 0 once set), and the builtin program's `u_depth`.
    depth_test: Option<bool>,
    depth_func: bool,
    depth_mask: Option<bool>,
    color_mask: Option<bool>,
    clear_depth: bool,
    /// Keyed on the program object, so a relinked or re-created builtin program never inherits
    /// a value its own uniform does not hold.
    u_depth: Option<(glow::Program, u32)>,
}

/// An item-space program as GL holds it.
struct CompiledItem {
    program: glow::Program,
    u_projection: Option<glow::UniformLocation>,
    u_godot_screen: Option<glow::UniformLocation>,
    u_screen: Option<glow::UniformLocation>,
    u_post_modulate: Option<glow::UniformLocation>,
    u_premultiply_out: Option<glow::UniformLocation>,
    /// Active non-sampler uniforms by declared name: location, GL type, array size.
    uniforms: HashMap<String, (glow::UniformLocation, u32, i32)>,
    /// The active uniforms by their position in a binding's uniform list: (position, name,
    /// location, GL type, array size), and the list's length. Every binding of a program lists
    /// the program's declared uniforms in the same order, so one plan serves them all; a binding
    /// whose length differs, or whose name at a planned position differs, re-plans it. A binding
    /// upload then touches the active uniforms only (a program declares many more than the
    /// compiler keeps).
    uniform_plan: Vec<(usize, Box<str>, glow::UniformLocation, u32, i32)>,
    uniform_plan_len: Option<usize>,
    /// Active `sampler2D` uniforms (beyond `TEXTURE`) and the unit each samples.
    sampler_units: Vec<(String, u32)>,
    /// Target size and [`ExecOptions::godot_orientation`] the vertex uniforms were set for.
    projection: Option<(u32, u32, bool)>,
    premultiply_out: Option<bool>,
    /// The (binding slot, version) whose values GL holds.
    applied: Option<(u32, u64)>,
    /// `gsw_msdf_on`, `gsw_msdf`, `gsw_msdf_no_median`.
    u_msdf_on: Option<glow::UniformLocation>,
    u_msdf: Option<glow::UniformLocation>,
    u_msdf_no_median: Option<glow::UniformLocation>,
    msdf_state: Option<(bool, MsdfState)>,
    /// `SCREEN_PIXEL_SIZE` (declared by a module that reads SCREEN_UV or it) and the target
    /// size it was set for.
    u_screen_pixel_size: Option<glow::UniformLocation>,
    screen_pixel_size: Option<(u32, u32)>,
    /// `TIME` (declared by a module whose code reads it) and the bits of the
    /// [`DrawList::shader_time`] it was set to.
    u_time: Option<glow::UniformLocation>,
    time: Option<u32>,
}

/// An MSDF draw's fragment uniforms as GL holds them: `[px_range, outline]` as bits, and whether
/// [`Sabotage::MsdfNoMedian`] is on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct MsdfState {
    params: [u32; 2],
    no_median: bool,
}

impl MsdfState {
    fn of(draw: &Draw, sabotage: Option<Sabotage>) -> MsdfState {
        MsdfState {
            params: draw.msdf.map(f32::to_bits),
            no_median: sabotage == Some(Sabotage::MsdfNoMedian),
        }
    }
}

/// The builtin program's MSDF variant: [`VERT`] with [`msdf_fragment`].
struct MsdfProgram {
    program: glow::Program,
    u_projection: Option<glow::UniformLocation>,
    u_godot_screen: Option<glow::UniformLocation>,
    u_screen: Option<glow::UniformLocation>,
    u_premultiply_out: Option<glow::UniformLocation>,
    u_msdf: Option<glow::UniformLocation>,
    u_msdf_no_median: Option<glow::UniformLocation>,
    /// `u_premultiply_out` as GL holds it.
    premultiply_out: Option<bool>,
}

/// A registered item-space program: its module (kept to recompile after a restored context).
struct ItemProgram {
    module: String,
    /// The vertex module, for a program with its own vertex stage.
    vertex: Option<String>,
    compiled: Option<CompiledItem>,
    /// A link issued by [`CanvasItemsExecutor::begin_program`] whose status is not read yet
    /// (`compiled` is `None` meanwhile, so its draws are skipped).
    pending: Option<PendingLink>,
}

/// A program linked without reading its status: GL compiles and links it in the background
/// (`KHR_parallel_shader_compile`, or a fence after the link commands).
struct PendingLink {
    program: glow::Program,
    shaders: LinkShaders<glow::Shader>,
    /// [`CanvasItemsExecutor::poll_programs`] calls made when the link was issued.
    epoch: u64,
    /// Signalled once the GPU process has issued the link commands. The driver's compile can
    /// still be pending, so a status read can overrun the poll's budget.
    fence: Option<glow::Fence>,
}

struct TargetObjects {
    texture: glow::Texture,
    framebuffer: glow::Framebuffer,
    width: u32,
    height: u32,
    format: Format,
    /// A DEPTH_COMPONENT16 renderbuffer on the framebuffer, attached at the first list with depth
    /// tables (root targets only); `depth_failed` once the attachment left it incomplete.
    depth: Option<glow::Renderbuffer>,
    depth_failed: bool,
}

/// The depth pre-pass program's link.
enum DepthProgram {
    /// Linked, status not read; the same completion/fence gate as item programs.
    /// `polled` is the fallback when no fence could be created.
    Pending {
        program: glow::Program,
        shaders: [glow::Shader; 2],
        polled: bool,
        fence: Option<glow::Fence>,
    },
    Ready(glow::Program),
    /// The link failed: lists draw without their depth tables (the same pixels).
    Failed,
}

/// Every GL object besides the list's textures (re-created on restore).
struct Objects {
    program: glow::Program,
    msdf: MsdfProgram,
    u_projection: Option<glow::UniformLocation>,
    u_godot_screen: Option<glow::UniformLocation>,
    u_screen: Option<glow::UniformLocation>,
    u_premultiply: Option<glow::UniformLocation>,
    u_texel_premultiply: Option<glow::UniformLocation>,
    u_depth: Option<glow::UniformLocation>,
    /// The depth tiles' pre-pass: program, vertex array and buffer, and the tiles (with the
    /// target size and orientation) the buffer holds.
    /// Linked without a status read when the objects are made (as item-space programs are,
    /// [`CanvasItemsExecutor::begin_program`]) and settled by
    /// [`CanvasItemsExecutor::depth_program_ready`] the first frame that has depth tables.
    depth_program: DepthProgram,
    depth_vertex_array: glow::VertexArray,
    depth_buffer: glow::Buffer,
    depth_tiles: Option<(Vec<DepthTile>, u32, u32, bool)>,
    present_program: glow::Program,
    u_flip_rows: Option<glow::UniformLocation>,
    present_vertex_array: glow::VertexArray,
    white: glow::Texture,
    /// GLES3's other default textures, in [`DEFAULT_TEXTURE_IDS`] order (1x1, nearest, as
    /// `white`).
    defaults: [glow::Texture; 4],
    /// Index `wrap · 2 + linear` (wrap 0 clamp, 1 repeat, 2 mirror).
    samplers: [glow::Sampler; 6],
    /// The active list's objects: the root list's ([`ROOT_SURFACE`]) outside
    /// [`CanvasItemsExecutor::execute_frame`]'s surface passes.
    list: ListObjects,
    /// [`Target::surface`] of `list`.
    active: u32,
    /// Every other list's objects, by [`Target::surface`] (the root's while a surface pass runs).
    parked: HashMap<u32, ListObjects>,
}

/// One list's GL objects (render-stream/16 viewport surfaces: the root list and each surface
/// list has its own): its arrays, its target and its back buffer, so a list's dirty ranges
/// upload into its own buffers and its draws never see another list's rows.
struct ListObjects {
    vertex_array: glow::VertexArray,
    vertex_buffer: glow::Buffer,
    index_buffer: glow::Buffer,
    /// `DrawList::instances`, read by DRAW_INSTANCED draws.
    instance_buffer: glow::Buffer,
    /// Capacities in vertices, indices and instances.
    vertex_capacity: usize,
    index_capacity: usize,
    instance_capacity: usize,
    item_texture: glow::Texture,
    item_rows: u32,
    target: Option<TargetObjects>,
    /// The back buffer, made at the first screen copy for the target's size and format.
    screen: Option<ScreenObjects>,
    /// The next execution of this list must carry `dirty.all` (fresh objects).
    needs_full: bool,
    /// A version per binding slot of this list, bumped whenever the list marks it dirty: a
    /// program re-sends its uniforms when the (slot, version) it holds differs. Versions come
    /// from one executor-wide counter, so two lists' equal slots never share a version.
    binding_versions: Vec<u64>,
}

impl ListObjects {
    /// A list's arrays (VAO, vertex, index and instance buffers, the item texture), no target.
    /// Leaves ARRAY_BUFFER, the vertex array and the active unit changed (the caller forgets
    /// them in its [`Cache`]), and the item texture bound on [`UNIT_ITEMS`].
    fn create(gl: &glow::Context) -> Result<ListObjects, String> {
        unsafe {
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
            // The instance buffer; attributes 4-7 hold the identity instance as constants
            // except during an instanced call.
            let instance_buffer = gl.create_buffer()?;
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(instance_buffer));
            gl.buffer_data_size(
                glow::ARRAY_BUFFER,
                (INITIAL_INSTANCES * INSTANCE_BYTES) as i32,
                glow::DYNAMIC_DRAW,
            );
            identity_instance(gl);
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
            Ok(ListObjects {
                vertex_array,
                vertex_buffer,
                index_buffer,
                instance_buffer,
                vertex_capacity: INITIAL_VERTICES,
                index_capacity: INITIAL_INDICES,
                instance_capacity: INITIAL_INSTANCES,
                item_texture,
                item_rows: 1,
                target: None,
                screen: None,
                needs_full: true,
                binding_versions: Vec::new(),
            })
        }
    }

    /// Delete every object (a live context only).
    fn delete(self, gl: &glow::Context) {
        unsafe {
            gl.delete_vertex_array(self.vertex_array);
            gl.delete_buffer(self.vertex_buffer);
            gl.delete_buffer(self.index_buffer);
            gl.delete_buffer(self.instance_buffer);
            gl.delete_texture(self.item_texture);
            if let Some(t) = self.target {
                gl.delete_framebuffer(t.framebuffer);
                gl.delete_texture(t.texture);
                if let Some(depth) = t.depth {
                    gl.delete_renderbuffer(depth);
                }
            }
            if let Some(screen) = self.screen {
                delete_screen(gl, screen);
            }
        }
    }
}

/// Godot 4.5.1's GLES3 render-target back buffer (`_create_render_target_backbuffer`,
/// texture_storage.cpp:2290-2337): the target's internal format, `max(1, mips(w, h) - 4)` levels
/// (the smallest no smaller than about 32 px), each half the previous (floor, at least 1), sampled
/// linear / linear-mipmap-linear / clamp-to-edge, with MAX_LEVEL 0 until a mip chain is built.
struct ScreenObjects {
    /// Optional transient depth for dead group cells; recreated with this back buffer.
    depth: Option<glow::Renderbuffer>,
    texture: glow::Texture,
    framebuffer: glow::Framebuffer,
    width: u32,
    height: u32,
    format: Format,
    levels: u32,
    /// The texture's GL_TEXTURE_MAX_LEVEL.
    max_level: u32,
    sampler: glow::Sampler,
    /// The gaussian downsample (copy.glsl's MODE_GAUSSIAN_BLUR).
    program: glow::Program,
    u_pixel_size: Option<glow::UniformLocation>,
    u_copy_section: Option<glow::UniformLocation>,
    u_source_section: Option<glow::UniformLocation>,
    /// The level attached to `framebuffer` (a mip chain leaves its last one there).
    attached: u32,
    /// The group owners' program ([`DRAW_GROUP_CLIP`], [`DRAW_GROUP_COMPOSITE`]).
    group: GroupProgram,
}

/// [`VERT`] with [`GROUP_FRAG`]: Godot's default clip-children and canvas-group shaders over
/// the builtin draw.
struct GroupProgram {
    program: glow::Program,
    u_projection: Option<glow::UniformLocation>,
    u_godot_screen: Option<glow::UniformLocation>,
    u_screen: Option<glow::UniformLocation>,
    u_mode: Option<glow::UniformLocation>,
    /// The target size and orientation the vertex uniforms were set for, and the mode GL holds.
    projection: Option<(u32, u32, bool)>,
    mode: Option<i32>,
}

/// Godot's `Image::get_image_required_mipmaps`: halvings until both sides are 1.
fn required_mipmaps(width: u32, height: u32) -> u32 {
    let (mut w, mut h, mut n) = (width.max(1), height.max(1), 0);
    while w > 1 || h > 1 {
        w = (w >> 1).max(1);
        h = (h >> 1).max(1);
        n += 1;
    }
    n
}

/// copy.glsl's MODE_GAUSSIAN_BLUR vertex stage over copy_effects.cpp's six-vertex screen quad:
/// `copy_section` places the destination region in the level, `source_section` the region it
/// samples in the level above (both normalized; `(0, 0, 1, 1)` for the whole level).
const GAUSS_VERT: &str = r#"#version 300 es
precision highp float;
uniform highp vec4 copy_section;
uniform highp vec4 source_section;
out vec2 uv_interp;
const vec2 QUAD[6] = vec2[6](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
                             vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));
void main() {
  vec2 v = QUAD[gl_VertexID];
  uv_interp = v * 0.5 + 0.5;
  gl_Position = vec4(v, 1.0, 1.0);
  gl_Position.xy = (copy_section.xy + uv_interp.xy * copy_section.zw) * 2.0 - 1.0;
  uv_interp = source_section.xy + uv_interp * source_section.zw;
}"#;

/// The fragment stage of a group owner's draw: the builtin draw's colour (straight: the
/// vertex stage runs with `u_premultiply` off), then Godot's default shader for the owner
/// (rasterizer_canvas_gles3.cpp:2844-2883), both `render_mode unshaded`, reading the back buffer
/// at canvas.glsl's `SCREEN_UV` (`gl_FragCoord.xy * screen_pixel_size`) at level 0:
/// - mode 1, clip children: `COLOR.rgb = c.rgb`;
/// - mode 2, canvas group: `c.rgb /= c.a` when `c.a > 0.0001`, then `COLOR *= c`.
///
/// The result is premultiplied last, as every mix-blended draw is.
const GROUP_FRAG: &str = r#"#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_texture;
uniform sampler2D u_back_buffer;
uniform highp vec2 u_screen_pixel_size;
uniform int u_group_mode;
in vec2 v_uv;
in vec4 v_color;
flat in vec4 v_tint;
flat in uint v_untextured;
out vec4 fragColor;
void main() {
  vec4 sampled = texture(u_texture, v_uv);
  vec4 texel = v_untextured != 0u ? vec4(1.0) : sampled;
  vec4 color = v_color * v_tint * texel;
  vec4 c = textureLod(u_back_buffer, gl_FragCoord.xy * u_screen_pixel_size, 0.0);
  if (u_group_mode == 1) {
    color.rgb = c.rgb;
  } else {
    if (c.a > 0.0001) {
      c.rgb /= c.a;
    }
    color *= c;
  }
  // GLES3 writes the straight colour, and a fixed-point target clamps a fragment output to
  // [0, 1] before the SRC_ALPHA blend: un-premultiplying a back buffer whose alpha was quantized
  // (RGB10_A2's two alpha bits) can exceed 1, so clamp before premultiplying for the ONE blend.
  color = clamp(color, 0.0, 1.0);
  fragColor = vec4(color.rgb * color.a, color.a);
}"#;

/// copy.glsl's MODE_GAUSSIAN_BLUR fragment stage (Jimenez's 13-tap box filter), verbatim.
const GAUSS_FRAG: &str = r#"#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 uv_interp;
uniform sampler2D source;
uniform highp vec2 pixel_size;
layout(location = 0) out vec4 frag_color;
void main() {
  vec4 A = textureLod(source, uv_interp + pixel_size * vec2(-1.0, -1.0), 0.0);
  vec4 B = textureLod(source, uv_interp + pixel_size * vec2(0.0, -1.0), 0.0);
  vec4 C = textureLod(source, uv_interp + pixel_size * vec2(1.0, -1.0), 0.0);
  vec4 D = textureLod(source, uv_interp + pixel_size * vec2(-0.5, -0.5), 0.0);
  vec4 E = textureLod(source, uv_interp + pixel_size * vec2(0.5, -0.5), 0.0);
  vec4 F = textureLod(source, uv_interp + pixel_size * vec2(-1.0, 0.0), 0.0);
  vec4 G = textureLod(source, uv_interp, 0.0);
  vec4 H = textureLod(source, uv_interp + pixel_size * vec2(1.0, 0.0), 0.0);
  vec4 I = textureLod(source, uv_interp + pixel_size * vec2(-0.5, 0.5), 0.0);
  vec4 J = textureLod(source, uv_interp + pixel_size * vec2(0.5, 0.5), 0.0);
  vec4 K = textureLod(source, uv_interp + pixel_size * vec2(-1.0, 1.0), 0.0);
  vec4 L = textureLod(source, uv_interp + pixel_size * vec2(0.0, 1.0), 0.0);
  vec4 M = textureLod(source, uv_interp + pixel_size * vec2(1.0, 1.0), 0.0);
  float weight = 0.5 / 4.0;
  float lesser_weight = 0.125 / 4.0;
  frag_color = (D + E + I + J) * weight;
  frag_color += (A + B + G + F) * lesser_weight;
  frag_color += (B + C + H + G) * lesser_weight;
  frag_color += (F + G + L + K) * lesser_weight;
  frag_color += (G + H + M + L) * lesser_weight;
}"#;

/// The unit the gaussian pass samples its source level on (an item-space program's last unit;
/// the cache's record of it is kept).
const UNIT_SCREEN_PASS: u32 = 15;

fn delete_screen(gl: &glow::Context, screen: ScreenObjects) {
    unsafe {
        if let Some(depth) = screen.depth {
            gl.delete_renderbuffer(depth);
        }
        gl.delete_framebuffer(screen.framebuffer);
        gl.delete_texture(screen.texture);
        gl.delete_sampler(screen.sampler);
        gl.delete_program(screen.program);
        gl.delete_program(screen.group.program);
    }
}

/// The back buffer for `target`, made (or remade for a new size or format) on demand. None when
/// GL refuses it, or for a target of 40 px or less on a side, for which GLES3 makes none.
fn ensure_screen<'o>(
    gl: &Gl,
    cache: &mut Cache,
    screen: &'o mut Option<ScreenObjects>,
    target: &TargetObjects,
) -> Option<&'o mut ScreenObjects> {
    if screen
        .as_ref()
        .is_some_and(|s| (s.width, s.height, s.format) != (target.width, target.height, target.format))
    {
        if let Some(old) = screen.take() {
            delete_screen(gl.c(), old);
        }
        for unit in cache.units.iter_mut() {
            *unit = None;
        }
    }
    if screen.is_none() {
        if target.width <= 40 || target.height <= 40 {
            return None;
        }
        let levels = required_mipmaps(target.width, target.height).saturating_sub(4).max(1);
        let internal = match target.format {
            Format::Rgb10A2 => glow::RGB10_A2,
            Format::Rgba8 => glow::RGBA8,
        };
        let program = compile(gl.c(), GAUSS_VERT, GAUSS_FRAG).ok()?;
        let group_program = match compile(gl.c(), VERT, GROUP_FRAG) {
            Ok(p) => p,
            Err(_) => {
                unsafe { gl.c().delete_program(program) };
                return None;
            }
        };
        unsafe {
            let c = gl.c();
            let texture = c.create_texture().ok()?;
            let framebuffer = c.create_framebuffer().ok()?;
            let sampler = c.create_sampler().ok()?;
            set_active_unit(gl, cache, UNIT_SCREEN_PASS);
            c.bind_texture(glow::TEXTURE_2D, Some(texture));
            cache.units[UNIT_SCREEN_PASS as usize] = None;
            c.tex_storage_2d(
                glow::TEXTURE_2D,
                levels as i32,
                internal,
                target.width as i32,
                target.height as i32,
            );
            c.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_BASE_LEVEL, 0);
            c.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAX_LEVEL, 0);
            c.sampler_parameter_i32(sampler, glow::TEXTURE_MAG_FILTER, glow::LINEAR as i32);
            c.sampler_parameter_i32(
                sampler,
                glow::TEXTURE_MIN_FILTER,
                glow::LINEAR_MIPMAP_LINEAR as i32,
            );
            c.sampler_parameter_i32(sampler, glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE as i32);
            c.sampler_parameter_i32(sampler, glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE as i32);
            c.use_program(Some(program));
            cache.program = Some(program);
            c.uniform_1_i32(
                c.get_uniform_location(program, "source").as_ref(),
                UNIT_SCREEN_PASS as i32,
            );
            let u_pixel_size = c.get_uniform_location(program, "pixel_size");
            let u_copy_section = c.get_uniform_location(program, "copy_section");
            let u_source_section = c.get_uniform_location(program, "source_section");
            // The group program's fixed uniforms (the back buffer is this target's size).
            c.use_program(Some(group_program));
            cache.program = Some(group_program);
            let at = |name: &str| c.get_uniform_location(group_program, name);
            c.uniform_1_i32(at("u_texture").as_ref(), UNIT_DRAW as i32);
            c.uniform_1_i32(at("u_items").as_ref(), UNIT_ITEMS as i32);
            c.uniform_1_i32(at("u_back_buffer").as_ref(), UNIT_SCREEN_PASS as i32);
            c.uniform_1_i32(at("u_premultiply").as_ref(), 0);
            c.uniform_2_f32(
                at("u_screen_pixel_size").as_ref(),
                (1.0 / f64::from(target.width)) as f32,
                (1.0 / f64::from(target.height)) as f32,
            );
            let group = GroupProgram {
                program: group_program,
                u_projection: at("u_projection"),
                u_godot_screen: at("u_godot_screen"),
                u_screen: at("u_screen"),
                u_mode: at("u_group_mode"),
                projection: None,
                mode: None,
            };
            *screen = Some(ScreenObjects {
                depth: None,
                texture,
                framebuffer,
                width: target.width,
                height: target.height,
                format: target.format,
                levels,
                max_level: 0,
                sampler,
                program,
                u_pixel_size,
                u_copy_section,
                u_source_section,
                attached: u32::MAX,
                group,
            });
            let made = screen.as_mut().unwrap();
            bind_draw_framebuffer(gl, cache, Some(framebuffer));
            attach_screen_level(gl, made, 0);
            // Failure keeps the colour-only back buffer usable; cells are optional facts.
            if let Ok(depth) = c.create_renderbuffer() {
                c.bind_renderbuffer(glow::RENDERBUFFER, Some(depth));
                c.renderbuffer_storage(
                    glow::RENDERBUFFER, glow::DEPTH_COMPONENT16,
                    target.width as i32, target.height as i32,
                );
                c.bind_renderbuffer(glow::RENDERBUFFER, None);
                c.framebuffer_renderbuffer(
                    glow::DRAW_FRAMEBUFFER, glow::DEPTH_ATTACHMENT, glow::RENDERBUFFER, Some(depth),
                );
                if c.check_framebuffer_status(glow::DRAW_FRAMEBUFFER) == glow::FRAMEBUFFER_COMPLETE {
                    made.depth = Some(depth);
                } else {
                    c.framebuffer_renderbuffer(
                        glow::DRAW_FRAMEBUFFER, glow::DEPTH_ATTACHMENT, glow::RENDERBUFFER, None,
                    );
                    c.delete_renderbuffer(depth);
                }
            }
        }
    }
    screen.as_mut()
}

/// Attach level `level` of the back buffer to its framebuffer (bound for drawing) unless it is.
fn attach_screen_level(gl: &Gl, screen: &mut ScreenObjects, level: u32) {
    if screen.attached != level {
        unsafe {
            gl.c().framebuffer_texture_2d(
                glow::DRAW_FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::TEXTURE_2D,
                Some(screen.texture),
                level as i32,
            )
        };
        unsafe {
            gl.c().framebuffer_renderbuffer(
                glow::DRAW_FRAMEBUFFER, glow::DEPTH_ATTACHMENT, glow::RENDERBUFFER,
                if level == 0 { screen.depth } else { None },
            );
        }
        screen.attached = level;
    }
}

/// A [`ScreenOp`]'s region in GL rows of the target (and back buffer): design rows under
/// [`ExecOptions::godot_orientation`], else flipped, clamped to the target.
fn screen_region(op: &ScreenOp, width: u32, height: u32, godot: bool) -> [i32; 4] {
    let [x, y, w, h] = op.region;
    let (x0, y0) = (x.max(0), y.max(0));
    let (x1, y1) = ((x + w).min(width as i32), (y + h).min(height as i32));
    let r = [x0, y0, (x1 - x0).max(0), (y1 - y0).max(0)];
    if godot { r } else { gl_scissor(r, height) }
}

/// The back buffer's gaussian mip chain over `region` (GL rows of level 0), as
/// `CopyEffects::gaussian_blur` builds it (copy_effects.cpp:240-310): level `i` from level `i - 1`,
/// each destination region the previous one halved (position shifted, size at least 1), drawn in
/// a viewport of the level's size, sampling the previous level's region. Blending is off.
fn gaussian_chain(
    gl: &Gl,
    cache: &mut Cache,
    screen: &mut ScreenObjects,
    region: [i32; 4],
    present_vertex_array: glow::VertexArray,
    linear_clamp: glow::Sampler,
) {
    unsafe {
        let c = gl.c();
        if cache.blend_enabled != Some(false) {
            c.disable(glow::BLEND);
            cache.blend_enabled = Some(false);
        }
        if cache.program != Some(screen.program) {
            c.use_program(Some(screen.program));
            cache.program = Some(screen.program);
        }
        bind_vertex_array(gl, cache, present_vertex_array);
        set_active_unit(gl, cache, UNIT_SCREEN_PASS);
        c.bind_texture(glow::TEXTURE_2D, Some(screen.texture));
        c.bind_sampler(UNIT_SCREEN_PASS, Some(linear_clamp));
        cache.units[UNIT_SCREEN_PASS as usize] = Some((screen.texture, linear_clamp));
        bind_draw_framebuffer(gl, cache, Some(screen.framebuffer));
        let (mut w, mut h) = (screen.width, screen.height);
        let [mut dx, mut dy, mut dw, mut dh] = region;
        let mut source = [
            dx as f32 / w as f32,
            dy as f32 / h as f32,
            dw as f32 / w as f32,
            dh as f32 / h as f32,
        ];
        for level in 1..screen.levels {
            dx >>= 1;
            dy >>= 1;
            dw = (dw >> 1).max(1);
            dh = (dh >> 1).max(1);
            w = (w >> 1).max(1);
            h = (h >> 1).max(1);
            c.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_BASE_LEVEL, level as i32 - 1);
            c.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAX_LEVEL, level as i32 - 1);
            attach_screen_level(gl, screen, level);
            set_viewport(gl, cache, w, h);
            let dest = [
                dx as f32 / w as f32,
                dy as f32 / h as f32,
                dw as f32 / w as f32,
                dh as f32 / h as f32,
            ];
            c.uniform_4_f32(
                screen.u_copy_section.as_ref(),
                dest[0],
                dest[1],
                dest[2],
                dest[3],
            );
            c.uniform_4_f32(
                screen.u_source_section.as_ref(),
                source[0],
                source[1],
                source[2],
                source[3],
            );
            c.uniform_2_f32(
                screen.u_pixel_size.as_ref(),
                (1.0 / f64::from(w)) as f32,
                (1.0 / f64::from(h)) as f32,
            );
            c.draw_arrays(glow::TRIANGLES, 0, 6);
            source = dest;
        }
        c.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_BASE_LEVEL, 0);
        screen.max_level = u32::MAX; // force the caller's MAX_LEVEL write
    }
}

/// One [`ScreenOp`] before a draw (Godot's `render_target_copy_to_back_buffer`,
/// `render_target_clear_back_buffer` and `render_target_gen_back_buffer_mipmaps`), then the back
/// buffer's sampled levels as the operation leaves them. Leaves the target bound for drawing; the
/// caller rebinds its vertex array.
fn screen_op(
    gl: &Gl,
    cache: &mut Cache,
    objects: &mut Objects,
    op: &ScreenOp,
    godot: bool,
    stats: &mut ExecStats,
) {
    let Some(target) = objects.list.target.as_ref() else {
        return;
    };
    let target_fb = target.framebuffer;
    let present_vertex_array = objects.present_vertex_array;
    let linear_clamp = objects.samplers[sampler_index(Sampler::LINEAR | Sampler::CLAMP)];
    let Some(screen) = ensure_screen(gl, cache, &mut objects.list.screen, target) else {
        return;
    };
    set_scissor_enabled(gl, cache, false);
    let region = screen_region(op, screen.width, screen.height, godot);
    let empty = region[2] <= 0 || region[3] <= 0;
    match op.kind {
        ScreenOpKind::Copy if !empty => unsafe {
            bind_read(gl, cache, Some(target_fb));
            bind_draw_framebuffer(gl, cache, Some(screen.framebuffer));
            attach_screen_level(gl, screen, 0);
            let [x, y, w, h] = region;
            gl.c().blit_framebuffer(
                x,
                y,
                x + w,
                y + h,
                x,
                y,
                x + w,
                y + h,
                glow::COLOR_BUFFER_BIT,
                glow::NEAREST,
            );
            stats.screen_copies += 1;
            if op.mipmaps && screen.levels > 1 {
                gaussian_chain(
                    gl,
                    cache,
                    screen,
                    region,
                    present_vertex_array,
                    linear_clamp,
                );
                stats.screen_mipmaps += 1;
            }
        },
        ScreenOpKind::Clear => unsafe {
            bind_draw_framebuffer(gl, cache, Some(screen.framebuffer));
            attach_screen_level(gl, screen, 0);
            gl.c().clear_color(0.0, 0.0, 0.0, 0.0);
            gl.c().clear(glow::COLOR_BUFFER_BIT);
            cache.clear_color = None;
            stats.screen_copies += 1;
        },
        ScreenOpKind::Mipmaps if !empty && screen.levels > 1 => {
            gaussian_chain(
                gl,
                cache,
                screen,
                region,
                present_vertex_array,
                linear_clamp,
            );
            stats.screen_mipmaps += 1;
        }
        _ => {}
    }
    let max_level = if op.sample_mips { screen.levels - 1 } else { 0 };
    if screen.max_level != max_level {
        unsafe {
            set_active_unit(gl, cache, UNIT_SCREEN_PASS);
            gl.c().bind_texture(glow::TEXTURE_2D, Some(screen.texture));
            cache.units[UNIT_SCREEN_PASS as usize] = None;
            gl.c()
                .tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAX_LEVEL, max_level as i32);
        }
        screen.max_level = max_level;
    }
    bind_draw_framebuffer(gl, cache, Some(target_fb));
    set_viewport(gl, cache, screen.width, screen.height);
}

impl ShaderApi for glow::Context {
    type Shader = glow::Shader;
    type Program = glow::Program;

    fn compile_stage(&self, vertex: bool, source: &str) -> Result<glow::Shader, String> {
        unsafe {
            let shader = self.create_shader(if vertex { glow::VERTEX_SHADER } else { glow::FRAGMENT_SHADER })?;
            self.shader_source(shader, source);
            self.compile_shader(shader);
            Ok(shader)
        }
    }
    fn new_program(&self) -> Result<glow::Program, String> {
        unsafe { self.create_program() }
    }
    fn attach(&self, program: glow::Program, shader: glow::Shader) {
        unsafe { self.attach_shader(program, shader) }
    }
    fn link(&self, program: glow::Program) {
        unsafe { self.link_program(program) }
    }
    fn linked(&self, program: glow::Program) -> bool {
        unsafe { self.get_program_link_status(program) }
    }
    fn program_log(&self, program: glow::Program) -> String {
        unsafe { self.get_program_info_log(program) }
    }
    fn shader_log(&self, shader: glow::Shader) -> String {
        unsafe { self.get_shader_info_log(shader) }
    }
    fn detach(&self, program: glow::Program, shader: glow::Shader) {
        unsafe { self.detach_shader(program, shader) }
    }
    fn delete_stage(&self, shader: glow::Shader) {
        unsafe { self.delete_shader(shader) }
    }
    fn delete_link(&self, program: glow::Program) {
        unsafe { self.delete_program(program) }
    }
}

fn compile(gl: &glow::Context, vert: &str, frag: &str) -> Result<glow::Program, String> {
    let (program, shaders) = start_link(gl, vert, frag)?;
    finish_link(gl, program, shaders)
}

/// Compile both stages and link, reading no status: the driver may do the work in the
/// background until [`finish_link`] (or `COMPLETION_STATUS_KHR`) asks.
fn start_link(
    gl: &glow::Context,
    vert: &str,
    frag: &str,
) -> Result<(glow::Program, [glow::Shader; 2]), String> {
    unsafe {
        let program = gl.create_program()?;
        let mut shaders = [None, None];
        for (k, (kind, source)) in [(glow::VERTEX_SHADER, vert), (glow::FRAGMENT_SHADER, frag)]
            .into_iter()
            .enumerate()
        {
            let shader = match gl.create_shader(kind) {
                Ok(shader) => shader,
                Err(e) => {
                    for s in shaders.into_iter().flatten() {
                        gl.delete_shader(s);
                    }
                    gl.delete_program(program);
                    return Err(e);
                }
            };
            gl.shader_source(shader, source);
            gl.compile_shader(shader);
            gl.attach_shader(program, shader);
            shaders[k] = Some(shader);
        }
        gl.link_program(program);
        let [Some(v), Some(f)] = shaders else {
            unreachable!("both stages were created")
        };
        Ok((program, [v, f]))
    }
}

/// Read a [`start_link`]'s status (blocking until the driver is done): the program, or GL's
/// logs (the program deleted). The shaders are detached and deleted either way.
fn finish_link(
    gl: &glow::Context,
    program: glow::Program,
    shaders: [glow::Shader; 2],
) -> Result<glow::Program, String> {
    unsafe {
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

/// Compile an item-space program: the builtin vertex stage (its modulate passed straight), or
/// [`item_program_vertex`] around `vertex`, and [`item_program_fragment`] around `module`.
/// Leaves no program bound.
fn compile_item(
    gl: &glow::Context,
    module: &str,
    vertex: Option<&str>,
    shared: &mut ItemShaders<glow::Shader>,
) -> Result<CompiledItem, String> {
    let (program, shaders) = start_item(gl, module, vertex, shared)?;
    finish_item(gl, program, shaders, shared)
}

/// [`compile_item`]'s compile and link, reading no status.
fn start_item(
    gl: &glow::Context,
    module: &str,
    vertex: Option<&str>,
    shared: &mut ItemShaders<glow::Shader>,
) -> Result<(glow::Program, LinkShaders<glow::Shader>), String> {
    let vertex = vertex.map(item_program_vertex);
    shared.start(gl, vertex.as_deref(), VERT, &item_program_fragment(module))
}

/// [`compile_item`] after [`start_item`]: the link status, then the program's uniforms.
fn finish_item(
    gl: &glow::Context,
    program: glow::Program,
    shaders: LinkShaders<glow::Shader>,
    shared: &mut ItemShaders<glow::Shader>,
) -> Result<CompiledItem, String> {
    let program = shared.finish(gl, program, shaders)?;
    unsafe {
        gl.use_program(Some(program));
        // The vertex stage's tint stays straight: the fragment stage owns the order.
        gl.uniform_1_i32(
            gl.get_uniform_location(program, "u_premultiply").as_ref(),
            0,
        );
        gl.uniform_1_i32(
            gl.get_uniform_location(program, "u_items").as_ref(),
            UNIT_ITEMS as i32,
        );
        gl.uniform_1_i32(
            gl.get_uniform_location(program, "TEXTURE").as_ref(),
            UNIT_DRAW as i32,
        );
        let mut uniforms = HashMap::new();
        let mut sampler_units = Vec::new();
        for index in 0..gl.get_active_uniforms(program) {
            let Some(active) = gl.get_active_uniform(program, index) else {
                continue;
            };
            let name = active.name.trim_end_matches("[0]").to_string();
            // The vertex stage's canvas matrices are binding values like any uniform.
            let canvas = name == CANVAS_MATRIX_UNIFORM || name == CANVAS_INVERSE_UNIFORM;
            if !canvas
                && (name == "TEXTURE"
                    || name == "SCREEN_PIXEL_SIZE"
                    || name == "TIME"
                    || name.starts_with("gsw_")
                    || name.starts_with("u_"))
            {
                continue;
            }
            let Some(location) = gl.get_uniform_location(program, &name) else {
                continue;
            };
            if active.utype == glow::SAMPLER_2D {
                if sampler_units.len() >= MAX_PROGRAM_SAMPLERS || active.size != 1 {
                    gl.use_program(None);
                    gl.delete_program(program);
                    return Err(format!(
                        "sampler {name}: more than {MAX_PROGRAM_SAMPLERS} samplers or a sampler array"
                    ));
                }
                let unit = FIRST_SAMPLER_UNIT + sampler_units.len() as u32;
                gl.uniform_1_i32(Some(&location), unit as i32);
                sampler_units.push((name, unit));
            } else {
                if canvas {
                    // Identity until a binding sends the item's canvas transform.
                    gl.uniform_matrix_4_f32_slice(Some(&location), false, &IDENTITY_MAT4);
                }
                uniforms.insert(name, (location, active.utype, active.size));
            }
        }
        let compiled = CompiledItem {
            program,
            u_projection: gl.get_uniform_location(program, "u_projection"),
            u_godot_screen: gl.get_uniform_location(program, "u_godot_screen"),
            u_screen: gl.get_uniform_location(program, "u_screen"),
            u_post_modulate: gl.get_uniform_location(program, "gsw_post_modulate"),
            u_premultiply_out: gl.get_uniform_location(program, "gsw_premultiply_out"),
            uniforms,
            uniform_plan: Vec::new(),
            uniform_plan_len: None,
            sampler_units,
            projection: None,
            premultiply_out: None,
            applied: None,
            u_msdf_on: gl.get_uniform_location(program, "gsw_msdf_on"),
            u_msdf: gl.get_uniform_location(program, "gsw_msdf"),
            u_msdf_no_median: gl.get_uniform_location(program, "gsw_msdf_no_median"),
            msdf_state: None,
            u_screen_pixel_size: gl.get_uniform_location(program, "SCREEN_PIXEL_SIZE"),
            screen_pixel_size: None,
            u_time: gl.get_uniform_location(program, "TIME"),
            time: None,
        };
        gl.use_program(None);
        Ok(compiled)
    }
}

/// Send one uniform's value as its GL type takes it (a value of the other number kind is
/// converted; at most `size` elements; nothing for a value shorter than one element).
fn set_uniform(
    gl: &Gl,
    location: &glow::UniformLocation,
    utype: u32,
    size: i32,
    value: &UniformValue,
) {
    let (components, float) = match utype {
        glow::FLOAT => (1, true),
        glow::FLOAT_VEC2 => (2, true),
        glow::FLOAT_VEC3 => (3, true),
        glow::FLOAT_VEC4 => (4, true),
        glow::FLOAT_MAT2 => (4, true),
        glow::FLOAT_MAT3 => (9, true),
        glow::FLOAT_MAT4 => (16, true),
        glow::INT | glow::BOOL => (1, false),
        glow::INT_VEC2 | glow::BOOL_VEC2 => (2, false),
        glow::INT_VEC3 | glow::BOOL_VEC3 => (3, false),
        glow::INT_VEC4 | glow::BOOL_VEC4 => (4, false),
        _ => return,
    };
    let max = components * size.max(1) as usize;
    let loc = Some(location);
    unsafe {
        if float {
            let floats: Vec<f32> = match value {
                UniformValue::Float(v) => v.clone(),
                UniformValue::Int(v) => v.iter().map(|x| *x as f32).collect(),
            };
            let n = floats.len().min(max) / components * components;
            if n == 0 {
                return;
            }
            let v = &floats[..n];
            match utype {
                glow::FLOAT => gl.c().uniform_1_f32_slice(loc, v),
                glow::FLOAT_VEC2 => gl.c().uniform_2_f32_slice(loc, v),
                glow::FLOAT_VEC3 => gl.c().uniform_3_f32_slice(loc, v),
                glow::FLOAT_VEC4 => gl.c().uniform_4_f32_slice(loc, v),
                glow::FLOAT_MAT2 => gl.c().uniform_matrix_2_f32_slice(loc, false, v),
                glow::FLOAT_MAT3 => gl.c().uniform_matrix_3_f32_slice(loc, false, v),
                _ => gl.c().uniform_matrix_4_f32_slice(loc, false, v),
            }
        } else {
            let ints: Vec<i32> = match value {
                UniformValue::Int(v) => v.clone(),
                UniformValue::Float(v) => v.iter().map(|x| *x as i32).collect(),
            };
            let n = ints.len().min(max) / components * components;
            if n == 0 {
                return;
            }
            let v = &ints[..n];
            match components {
                1 => gl.c().uniform_1_i32_slice(loc, v),
                2 => gl.c().uniform_2_i32_slice(loc, v),
                3 => gl.c().uniform_3_i32_slice(loc, v),
                _ => gl.c().uniform_4_i32_slice(loc, v),
            }
        }
    }
}

impl Objects {
    /// Create every object, leaving the context in the state [`Cache::default`] does not assume.
    /// On failure (a lost context, in practice) objects created so far are left to the context.
    fn create(gl: &glow::Context) -> Result<Objects, String> {
        unsafe {
            let program = compile(gl, VERT, FRAG)?;
            gl.use_program(Some(program));
            let u_projection = gl.get_uniform_location(program, "u_projection");
            let u_godot_screen = gl.get_uniform_location(program, "u_godot_screen");
            let u_screen = gl.get_uniform_location(program, "u_screen");
            let u_premultiply = gl.get_uniform_location(program, "u_premultiply");
            let u_texel_premultiply = gl.get_uniform_location(program, "u_texel_premultiply");
            let u_depth = gl.get_uniform_location(program, "u_depth");
            gl.uniform_1_i32(
                gl.get_uniform_location(program, "u_texture").as_ref(),
                UNIT_DRAW as i32,
            );
            gl.uniform_1_i32(
                gl.get_uniform_location(program, "u_items").as_ref(),
                UNIT_ITEMS as i32,
            );
            // The MSDF variant. Its vertex stage passes the modulate straight; the fragment
            // stage premultiplies last.
            let msdf_program = compile(gl, VERT, &msdf_fragment())?;
            gl.use_program(Some(msdf_program));
            gl.uniform_1_i32(
                gl.get_uniform_location(msdf_program, "u_premultiply")
                    .as_ref(),
                0,
            );
            gl.uniform_1_i32(
                gl.get_uniform_location(msdf_program, "u_texture").as_ref(),
                UNIT_DRAW as i32,
            );
            gl.uniform_1_i32(
                gl.get_uniform_location(msdf_program, "u_items").as_ref(),
                UNIT_ITEMS as i32,
            );
            let msdf = MsdfProgram {
                program: msdf_program,
                u_projection: gl.get_uniform_location(msdf_program, "u_projection"),
                u_godot_screen: gl.get_uniform_location(msdf_program, "u_godot_screen"),
                u_screen: gl.get_uniform_location(msdf_program, "u_screen"),
                u_premultiply_out: gl.get_uniform_location(msdf_program, "u_premultiply_out"),
                u_msdf: gl.get_uniform_location(msdf_program, "u_msdf"),
                u_msdf_no_median: gl.get_uniform_location(msdf_program, "u_msdf_no_median"),
                premultiply_out: None,
            };
            let present_program = compile(gl, PRESENT_VERT, PRESENT_FRAG)?;
            gl.use_program(Some(present_program));
            gl.uniform_1_i32(
                gl.get_uniform_location(present_program, "u_frame").as_ref(),
                UNIT_TARGET as i32,
            );
            gl.use_program(None);
            let present_vertex_array = gl.create_vertex_array()?;
            let (depth_program, depth_shaders) = start_link(gl, DEPTH_VERT, DEPTH_FRAG)?;
            let depth_program = DepthProgram::Pending {
                program: depth_program,
                shaders: depth_shaders,
                polled: false,
                fence: gl.fence_sync(glow::SYNC_GPU_COMMANDS_COMPLETE, 0).ok(),
            };
            let depth_vertex_array = gl.create_vertex_array()?;
            let depth_buffer = gl.create_buffer()?;
            gl.bind_vertex_array(Some(depth_vertex_array));
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(depth_buffer));
            gl.enable_vertex_attrib_array(0);
            gl.vertex_attrib_pointer_f32(0, 3, glow::FLOAT, false, 12, 0);
            gl.bind_vertex_array(None);

            let list = ListObjects::create(gl)?;

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

            let mut defaults = Vec::with_capacity(DEFAULT_TEXTURE_IDS.len());
            for id in DEFAULT_TEXTURE_IDS {
                let texel = default_texture_texel(id).ok_or("default texture")?;
                let texture = gl.create_texture()?;
                gl.bind_texture(glow::TEXTURE_2D, Some(texture));
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
                    glow::PixelUnpackData::Slice(Some(&texel[..])),
                );
                defaults.push(texture);
            }
            let defaults: [glow::Texture; 4] =
                defaults.try_into().map_err(|_| "defaults".to_string())?;
            gl.bind_texture(glow::TEXTURE_2D, Some(white));

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

            let u_flip_rows = gl.get_uniform_location(present_program, "u_flip_rows");
            Ok(Objects {
                program,
                msdf,
                u_projection,
                u_godot_screen,
                u_screen,
                u_premultiply,
                u_texel_premultiply,
                u_depth,
                depth_program,
                depth_vertex_array,
                depth_buffer,
                depth_tiles: None,
                present_program,
                u_flip_rows,
                present_vertex_array,
                white,
                defaults,
                samplers,
                list,
                active: ROOT_SURFACE,
                parked: HashMap::new(),
            })
        }
    }
}

/// The identity instance as the constant values of attributes 4-7 (their arrays disabled):
/// what every draw that is not DRAW_INSTANCED reads.
fn identity_instance(gl: &glow::Context) {
    let i = Instance::IDENTITY;
    let rows = [
        [i.xform[0], i.xform[1], i.xform[2], i.xform[3]],
        [i.xform[4], i.xform[5], i.xform[6], i.xform[7]],
        i.color,
        i.custom,
    ];
    for (k, v) in rows.iter().enumerate() {
        unsafe { gl.vertex_attrib_4_f32(INSTANCE_ATTRIBUTES + k as u32, v[0], v[1], v[2], v[3]) };
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

/// Admission and shader facts shared by full call planning and damage snapshots.
struct FrameFacts<'a> {
    list: &'a DrawList,
    textures: &'a HashMap<u32, glow::Texture>,
    aliases: &'a HashMap<u32, u32>,
    programs: &'a HashMap<u32, ItemProgram>,
    texture_revisions: &'a HashMap<u32, u32>,
    program_revisions: &'a HashMap<u32, u32>,
}
impl FrameFacts<'_> {
    fn known_texture(&self, id: u32) -> bool {
        id == WHITE_TEXTURE || DEFAULT_TEXTURE_IDS.contains(&id)
            || self.textures.contains_key(&id) || self.aliases.contains_key(&id)
    }
    fn known_binding(&self, program: u32) -> bool {
        self.list.bindings.get(program as usize - 1).is_some_and(|b| {
            self.programs.get(&b.program).is_some_and(|p| p.compiled.is_some())
                && b.samplers.iter().all(|s| s.texture == SCREEN_TEXTURE || self.known_texture(s.texture))
        })
    }
    fn item_program(&self, slot: u32) -> Option<&ItemProgram> {
        let binding = self.list.bindings.get(slot as usize)?;
        self.programs.get(&binding.program).filter(|p| p.compiled.is_some())
    }
}
impl gsw_canvas_draw_list::cover::CoverFacts for FrameFacts<'_> {
    fn opacity(&self, _: u32) -> Option<&gsw_canvas_draw_list::opacity::Opacity> { None }
    fn program(&self, slot: u32) -> ProgramFacts { DamageFacts::program(self, slot) }
}
impl DamageFacts for FrameFacts<'_> {
    fn texture_revision(&self, id: u32) -> u32 {
        self.texture_revisions.get(&id).copied().unwrap_or(0)
    }
    fn program(&self, slot: u32) -> ProgramFacts {
        let Some(p) = self.item_program(slot) else { return ProgramFacts::UNKNOWN; };
        ProgramFacts {
            reads_screen: self.list.bindings[slot as usize].samplers.iter().any(|s| s.texture == SCREEN_TEXTURE),
            vertex_stage: p.vertex.is_some(),
            alpha: None,
        }
    }
    fn reads_time(&self, slot: u32) -> bool {
        self.item_program(slot).and_then(|p| p.compiled.as_ref()).is_none_or(|p| p.u_time.is_some())
    }
    fn program_revision(&self, slot: u32) -> u32 {
        self.list.bindings.get(slot as usize).and_then(|b| self.program_revisions.get(&b.program)).copied().unwrap_or(0)
    }
    fn admitted(&self, list: &DrawList, d: usize) -> bool {
        drawable(&list.draws[d], list.indices.len(), |id| self.known_texture(id), |p| self.known_binding(p))
    }
}

/// The executor. See the module note.
pub struct CanvasItemsExecutor {
    canvas: web_sys::HtmlCanvasElement,
    context: web_sys::WebGl2RenderingContext,
    gl: Gl,
    loss: LossWatch,
    options: ExecOptions,
    planner: Planner,
    damage_reason: u32,
    damage_history_reads: u32,
    texture_revisions: HashMap<u32, u32>,
    program_revisions: HashMap<u32, u32>,
    objects: Option<Objects>,
    cache: Cache,
    textures: HashMap<u32, glow::Texture>,
    /// [`TextureOp::Surface`] aliases: texture id to the surface whose colour texture it
    /// samples.
    surface_aliases: HashMap<u32, u32>,
    /// A surface pass bound its own texture on [`UNIT_TARGET`] (where the RGB10_A2 blit reads
    /// the root's): the next blit binds the root's again.
    target_unit_stale: bool,
    calls: Vec<Call>,
    max_side: u32,
    fence: Option<(glow::Fence, u32)>,
    frames: u32,
    /// Merged calls planned since creation: [`Sabotage::DropDraws`] skips the odd ones, counted
    /// across frames, so a list of one call per frame loses every second frame's draw.
    planned_calls: u64,
    /// Item-space programs by id ([`CanvasItemsExecutor::define_program`]).
    programs: HashMap<u32, ItemProgram>,
    /// One builtin vertex shader per live context, shared only by item programs.
    item_shaders: ItemShaders<glow::Shader>,
    /// [`CanvasItemsExecutor::poll_programs`] calls so far.
    poll_epoch: u64,
    /// Pending links a restored context recompiled, for the next `poll_programs`.
    links_restored: Vec<(u32, Result<(), String>)>,
    /// The source of every list's binding versions ([`ListObjects::binding_versions`]).
    version_counter: u64,
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
    /// The compressed families this context exposes ([`gpu_families`]), the `gpu_formats` a
    /// GSW receiver states before any mask.
    pub fn gpu_families(&self) -> Vec<&'static str> {
        let extensions = self.gl.raw.supported_extensions();
        gpu_families(extensions.iter().map(String::as_str))
    }

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
            planner: Planner::new(),
            damage_reason: if options.damage { 105 } else { 0 },
            damage_history_reads: 0,
            texture_revisions: HashMap::new(),
            program_revisions: HashMap::new(),
            objects: Some(objects),
            cache: Cache::default(),
            textures: HashMap::new(),
            surface_aliases: HashMap::new(),
            target_unit_stale: false,
            calls: Vec::new(),
            max_side,
            fence: None,
            frames: 0,
            planned_calls: 0,
            programs: HashMap::new(),
            item_shaders: ItemShaders::default(),
            poll_epoch: 0,
            links_restored: Vec::new(),
            version_counter: 0,
        })
    }

    /// This context's `MAX_TEXTURE_SIZE`: a texture over it is reduced at upload
    /// ([`downscale_factor`]). 0 when the context was lost before it was read.
    pub fn max_texture_side(&self) -> u32 {
        self.max_side
    }

    /// Register item-space program `id` (> 0): the module `@godot-scene-web/effects`'s
    /// `transpileGodotItemShader` emits, compiled at once around [`item_program_fragment`]. A
    /// compile or link failure is returned with GL's log and registers nothing. Redefining an id
    /// replaces its program. Programs survive a restored context (recompiled from the module).
    pub fn define_program(&mut self, id: u32, module: &str) -> Result<(), String> {
        self.define_program_with_vertex(id, module, None)
    }

    /// [`define_program`](Self::define_program) for a program with its own vertex stage:
    /// `vertex` is the transpiler's `vertexGlsl`, compiled around [`item_program_vertex`]; `None`
    /// keeps the builtin vertex stage.
    pub fn define_program_with_vertex(
        &mut self,
        id: u32,
        module: &str,
        vertex: Option<&str>,
    ) -> Result<(), String> {
        if id == BUILTIN_PROGRAM {
            return Err("program id 0 is the builtin".into());
        }
        if self.context_state() == ContextState::Lost {
            return Err(ExecError::Lost.to_string());
        }
        let compiled = compile_item(&self.gl.raw, module, vertex, &mut self.item_shaders);
        self.cache.program = None;
        let compiled = compiled?;
        let revision = self.program_revisions.entry(id).or_default();
        *revision = revision.wrapping_add(1);
        if let Some(old) = self.programs.insert(
            id,
            ItemProgram {
                module: module.to_string(),
                vertex: vertex.map(str::to_string),
                compiled: Some(compiled),
                pending: None,
            },
        ) {
            self.delete_item(old);
        }
        Ok(())
    }

    /// [`define_program_with_vertex`](Self::define_program_with_vertex) without waiting for the
    /// driver: both stages are compiled and the program linked, but no status is read, so the
    /// call does not block on the compile. The program is registered as pending: [`has_program`]
    /// is false and its draws are skipped until a later [`poll_programs`] finds the link done.
    /// An error here is a lost context or a GL object that could not be created; a compile or
    /// link failure is reported by `poll_programs`.
    ///
    /// [`has_program`]: Self::has_program
    /// [`poll_programs`]: Self::poll_programs
    pub fn begin_program(
        &mut self,
        id: u32,
        module: &str,
        vertex: Option<&str>,
    ) -> Result<(), String> {
        if id == BUILTIN_PROGRAM {
            return Err("program id 0 is the builtin".into());
        }
        if self.context_state() == ContextState::Lost {
            return Err(ExecError::Lost.to_string());
        }
        let (program, shaders) = start_item(&self.gl.raw, module, vertex, &mut self.item_shaders)?;
        let fence = unsafe { self.gl.raw.fence_sync(glow::SYNC_GPU_COMMANDS_COMPLETE, 0).ok() };
        // The driver starts on the commands now, not when the frame's task ends.
        unsafe { self.gl.raw.flush() };
        self.cache.program = None;
        let revision = self.program_revisions.entry(id).or_default();
        *revision = revision.wrapping_add(1);
        if let Some(old) = self.programs.insert(
            id,
            ItemProgram {
                module: module.to_string(),
                vertex: vertex.map(str::to_string),
                compiled: None,
                pending: Some(PendingLink {
                    program,
                    shaders,
                    epoch: self.poll_epoch,
                    fence,
                }),
            },
        ) {
            self.delete_item(old);
        }
        Ok(())
    }

    /// Settle the links [`begin_program`](Self::begin_program) issued, once per frame and before
    /// that frame's definitions: in id order, starting another settle only while the poll has
    /// spent less than 8 ms. Always settle at least one ready link; a status read can overrun.
    /// Readiness is `COMPLETION_STATUS_KHR` with the extension, otherwise a signalled fence after the link
    /// commands (only if fence creation failed, the epoch fallback). Returns each settled
    /// program: `Ok` when it is now drawn, `Err` with GL's logs when it failed (it is
    /// unregistered, as a failed [`define_program`](Self::define_program) registers nothing).
    /// While the context is lost nothing settles; a restored context recompiles every program,
    /// pending ones included, and reports those here.
    pub fn poll_programs(&mut self) -> Vec<(u32, Result<(), String>)> {
        let started = performance_now();
        self.poll_epoch += 1;
        if self.context.is_context_lost() {
            self.loss.mark_lost();
        }
        let context_ready = self.context_state() != ContextState::Lost;
        let parallel = self
            .gl
            .raw
            .supported_extensions()
            .contains("KHR_parallel_shader_compile");
        let epoch = self.poll_epoch;
        let ids: Vec<_> = self.programs.iter()
            .filter_map(|(id, p)| p.pending.is_some().then_some(*id)).collect();
        let done = poll_links(context_ready, &mut self.links_restored, ids.into_iter(),
            || performance_now() - started, |id| {
            let Some(p) = self.programs.get_mut(&id) else {
                return ControlFlow::Continue(None);
            };
            let Some(link) = p.pending.as_ref() else {
                return ControlFlow::Continue(None);
            };
            if !link_ready(
                parallel.then(|| unsafe { self.gl.raw.get_program_completion_status(link.program) }),
                || link.fence.map(|f| unsafe { self.gl.raw.get_sync_status(f) == glow::SIGNALED }),
                link.epoch < epoch,
            ) {
                return ControlFlow::Continue(None);
            }
            let link = p.pending.take().unwrap();
            let result = match finish_item(&self.gl.raw, link.program, link.shaders, &mut self.item_shaders) {
                Ok(compiled) => {
                    p.compiled = Some(compiled);
                    Ok(())
                }
                // A context lost before its event (COMPLETION_STATUS_KHR reads true on a lost
                // context too): the failure is the loss's, not the code's. The link stays
                // pending (its handles died with the context; nothing deletes them), so the
                // restore recompiles the program from its module and reports it then.
                Err(_) if self.context.is_context_lost() => {
                    p.pending = Some(PendingLink {
                        program: link.program,
                        shaders: link.shaders,
                        epoch: link.epoch,
                        fence: None,
                    });
                    self.loss.mark_lost();
                    return ControlFlow::Break(());
                }
                Err(log) => {
                    self.programs.remove(&id);
                    Err(log)
                }
            };
            if !self.context.is_context_lost() {
                if let Some(fence) = link.fence {
                    unsafe { self.gl.raw.delete_sync(fence) };
                }
            }
            ControlFlow::Continue(Some(result))
        });
        self.cache.program = None;
        done
    }

    /// Whether item-space program `id` was begun and its link is not settled yet.
    pub fn program_pending(&self, id: u32) -> bool {
        self.programs.get(&id).is_some_and(|p| p.pending.is_some())
    }

    /// Delete a replaced or freed program's GL objects (none while the context is lost).
    fn delete_item(&mut self, p: ItemProgram) {
        if self.loss.lost() || self.context.is_context_lost() {
            return;
        }
        let gl = &self.gl.raw;
        unsafe {
            if let Some(c) = p.compiled {
                gl.delete_program(c.program);
                if self.cache.program == Some(c.program) {
                    self.cache.program = None;
                }
            }
            if let Some(l) = p.pending {
                if let Some(fence) = l.fence {
                    gl.delete_sync(fence);
                }
                self.item_shaders.discard(gl, l.program, l.shaders);
                gl.delete_program(l.program);
            }
        }
    }

    /// History-dependent reads found in the last root damage snapshot.
    pub fn damage_history_reads(&self) -> u32 {
        self.damage_history_reads
    }

    /// Forget item-space program `id`; draws naming a binding of it are skipped from now on.
    pub fn free_program(&mut self, id: u32) {
        let revision = self.program_revisions.entry(id).or_default();
        *revision = revision.wrapping_add(1);
        if let Some(p) = self.programs.remove(&id) {
            self.delete_item(p);
        }
    }

    /// Whether item-space program `id` is registered and compiled.
    pub fn has_program(&self, id: u32) -> bool {
        self.programs.get(&id).is_some_and(|p| p.compiled.is_some())
    }

    pub fn options(&self) -> ExecOptions {
        self.options
    }

    pub fn set_options(&mut self, options: ExecOptions) {
        if self.options.damage != options.damage {
            self.planner.invalidate();
            self.damage_reason = 105;
        }
        if self.options.godot_orientation != options.godot_orientation {
            self.planner.invalidate();
            self.damage_reason = 103;
        }
        if self.options.sabotage != options.sabotage {
            self.planner.invalidate();
            self.damage_reason = 104;
        }
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
            .and_then(|o| o.list.target.as_ref())
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
            if self.options.damage { self.planner.invalidate(); }
            self.damage_reason = 101;
            // Every handle belongs to the dead context: forget them without calling GL.
            self.textures.clear();
            self.surface_aliases.clear();
            self.target_unit_stale = false;
            self.fence = None;
            self.objects = None;
            self.item_shaders.forget_context();
            self.cache = Cache::default();
            self.gl = Gl::new(glow::Context::from_webgl2_context(self.context.clone()));
            return match Objects::create(&self.gl.raw) {
                Ok(objects) => {
                    // Fresh list objects need `dirty.all` (ListObjects::needs_full).
                    self.objects = Some(objects);
                    // Item-space programs come back from their modules (they compiled before).
                    // A pending link's objects died with the context: it is recompiled here
                    // too, and its outcome goes to the next `poll_programs`.
                    let mut ids: Vec<u32> = self.programs.keys().copied().collect();
                    ids.sort_unstable();
                    for id in ids {
                        let Some(p) = self.programs.get_mut(&id) else {
                            continue;
                        };
                        let was_pending = p.pending.take().is_some();
                        match compile_item(&self.gl.raw, &p.module, p.vertex.as_deref(), &mut self.item_shaders) {
                            Ok(c) => {
                                p.compiled = Some(c);
                                if was_pending {
                                    self.links_restored.push((id, Ok(())));
                                }
                            }
                            Err(log) => {
                                p.compiled = None;
                                if was_pending {
                                    self.programs.remove(&id);
                                    self.links_restored.push((id, Err(log)));
                                }
                            }
                        }
                    }
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
        self.execute_frame(list, &[], &[])
    }

    /// render-stream/16 viewport surfaces: free surfaces `freed` (their target, back buffer and
    /// arrays), run each of `surfaces` into its own offscreen target in the order given (Godot's
    /// viewport order: children first), then `root` ([`ROOT_SURFACE`]), and blit the root to the
    /// canvas. A [`TextureOp::Surface`] alias samples a surface as the passes so far left it
    /// (a surface later in the order: its previous contents; the target being drawn: transparent).
    /// Texture operations run first, the root's and then each surface's, so every pass sees every
    /// texture. A surface's objects are made at its first pass, and its target is (re)allocated
    /// when its size or format changes (contents lost, as Godot's). The caller calls `consumed()`
    /// on every list it passed. With no surfaces this is exactly [`Self::execute`].
    pub fn execute_frame(
        &mut self,
        root: &DrawList,
        surfaces: &[SurfacePass<'_>],
        freed: &[u32],
    ) -> Result<ExecStats, ExecError> {
        let result = self.execute_frame_inner(root, surfaces, freed);
        if result.is_err() && self.options.damage {
            self.planner.invalidate();
        } else if self.options.damage {
            self.planner.commit();
            self.damage_reason = 0;
        }
        result
    }

    fn execute_frame_inner(
        &mut self,
        root: &DrawList,
        surfaces: &[SurfacePass<'_>],
        freed: &[u32],
    ) -> Result<ExecStats, ExecError> {
        let mut stats = ExecStats {
            draws: root.draws.len() as u32,
            ..ExecStats::default()
        };
        match self.context_state() {
            ContextState::Lost => return Err(ExecError::Lost),
            ContextState::Restored => stats.restored = 1,
            ContextState::Ready => {}
        }
        if self.list_needs_full() && !root.dirty.all {
            return Err(ExecError::NeedsFullUpload);
        }
        for pass in surfaces {
            let surface = pass.list.target.surface;
            if surface == ROOT_SURFACE {
                return Err(ExecError::Invalid("a surface pass names the root".into()));
            }
            let fresh = self
                .objects
                .as_ref()
                .is_none_or(|o| o.parked.get(&surface).is_none_or(|l| l.needs_full));
            if fresh && !pass.list.dirty.all {
                return Err(ExecError::NeedsFullUpload);
            }
            self.validate(pass.list)?;
        }
        self.validate(root)?;
        self.gl.calls.set(0);
        self.frames += 1;
        self.texture_ops(root, &mut stats);
        for pass in surfaces {
            self.texture_ops(pass.list, &mut stats);
        }
        if !freed.is_empty() {
            self.free_surfaces(freed);
        }
        for pass in surfaces {
            stats.draws += pass.list.draws.len() as u32;
            let result = self.activate(pass.list.target.surface).and_then(|()| {
                self.ensure_target(&pass.list.target, false)?;
                self.run_list(pass.list, pass.clear, None, &mut stats);
                Ok(())
            });
            if let Err(e) = result {
                // The root is active outside a frame, whatever failed.
                let _ = self.activate(ROOT_SURFACE);
                return Err(e);
            }
        }
        if !surfaces.is_empty() {
            self.activate(ROOT_SURFACE)?;
        }
        self.ensure_target(&root.target, true)?;
        let mut partial = None;
        if self.options.damage {
            let reason = if !surfaces.is_empty() { 100 }
                else if stats.restored != 0 { 101 }
                else if self.options.sabotage.is_some_and(|s| !matches!(s, Sabotage::DamageNoScissorClear | Sabotage::DamageSkipBackProducers)) { 104 }
                else { self.damage_reason };
            if reason != 0 { self.planner.invalidate(); }
            let started = performance_now();
            let facts = FrameFacts {
                list: root, textures: &self.textures, aliases: &self.surface_aliases,
                programs: &self.programs, texture_revisions: &self.texture_revisions,
                program_revisions: &self.program_revisions,
            };
            let (plan, planned) = self.planner.plan(root, &facts, &PlanOptions::default());
            self.damage_history_reads = planned.history_reads as u32;
            stats.damage_us = ((performance_now() - started) * 1000.0) as u32;
            stats.damage_regions = planned.region_count as u32;
            stats.damage_permille = planned.area_permille;
            stats.damage_changed = (planned.changed_old + planned.changed_new) as u32;
            stats.damage_mode = match plan {
                Plan::Skip => 3, Plan::Full(_) => 1, Plan::Partial { .. } => 2,
            };
            stats.damage_reason = match plan {
                Plan::Full(r) => if reason != 0 { reason } else { r as u32 + 1 },
                _ => 0,
            };
            if let Plan::Partial { regions, back_regions } = &plan {
                partial = Some((regions.clone(), back_regions.clone()));
            }
            if matches!(plan, Plan::Skip) {
                self.upload(root, &mut stats);
                self.version_bindings(root);
                if let Some(o) = self.objects.as_mut() { o.list.needs_full = false; }
                stats.gl_calls = self.gl.calls.get();
                return Ok(stats);
            }
        }
        self.run_list(root, true, partial.as_ref().map(|(r, b)| (r.as_slice(), b.as_slice())), &mut stats);
        self.blit(root.target.format);
        if self.fence.is_none()
            && let Ok(fence) =
                unsafe { self.gl.c().fence_sync(glow::SYNC_GPU_COMMANDS_COMPLETE, 0) }
        {
            self.fence = Some((fence, self.frames));
            stats.fence_issued = 1;
        }
        stats.gl_calls = self.gl.calls.get();
        Ok(stats)
    }

    /// Upload the active list's dirty ranges, plan its calls and draw them into its target.
    fn run_list(&mut self, list: &DrawList, clear: bool, partial: Option<(&[[i32; 4]], &[[i32; 4]])>, stats: &mut ExecStats) {
        self.upload(list, stats);
        self.version_bindings(list);
        let mut calls = std::mem::take(&mut self.calls);
        let counts = {
            let facts = FrameFacts {
                list, textures: &self.textures, aliases: &self.surface_aliases,
                programs: &self.programs, texture_revisions: &self.texture_revisions,
                program_revisions: &self.program_revisions,
            };
            let counts = plan_calls(list, |id| facts.known_texture(id), |p| facts.known_binding(p), &mut calls);
            // Bounds only feed the partial region loop; a Full or damage-off frame skips the walk.
            if partial.is_some() {
                call_bounds(list, &mut calls, |d| self.planner.draw_bounds(d));
            }
            counts
        };
        stats.planned_calls += calls.len() as u32;
        stats.draws_merged += counts.merged;
        stats.draws_skipped += counts.skipped;
        // The depth tables: the root list only, on a cleared target that takes a depth buffer.
        let tables = !list.depth_tiles.is_empty() && !list.depth_draws.is_empty();
        let root = self
            .objects
            .as_ref()
            .is_some_and(|o| o.active == ROOT_SURFACE);
        let depth = tables && root && clear && self.depth_program_ready() && self.ensure_depth();
        // Group cells use the independent back-buffer depth attachment, including on surfaces.
        let group_depth = !list.group_cells.is_empty() && self.depth_program_ready();
        self.draw(list, &calls, clear, depth, group_depth, partial, stats);
        self.calls = calls;
        if let Some(o) = self.objects.as_mut() {
            o.list.needs_full = false;
        }
    }

    /// Whether the active list's objects need a `dirty.all` list (fresh, or no objects at all).
    fn list_needs_full(&self) -> bool {
        self.objects.as_ref().is_none_or(|o| o.list.needs_full)
    }

    /// Make surface `surface`'s list objects the active ones (creating them on first use), and
    /// bind its item texture on [`UNIT_ITEMS`].
    fn activate(&mut self, surface: u32) -> Result<(), ExecError> {
        let objects = self.objects.as_mut().ok_or(ExecError::Lost)?;
        if objects.active == surface {
            return Ok(());
        }
        let next = match objects.parked.remove(&surface) {
            Some(l) => l,
            None => {
                let made = ListObjects::create(&self.gl.raw);
                // `create` changed bindings the cache tracks.
                self.cache.vertex_array = None;
                self.cache.array_buffer = None;
                self.cache.active_unit = None;
                made.map_err(|_| {
                    self.loss.mark_lost();
                    ExecError::Lost
                })?
            }
        };
        let prev = std::mem::replace(&mut objects.list, next);
        objects.parked.insert(objects.active, prev);
        objects.active = surface;
        set_active_unit(&self.gl, &mut self.cache, UNIT_ITEMS);
        unsafe {
            self.gl
                .c()
                .bind_texture(glow::TEXTURE_2D, Some(objects.list.item_texture))
        };
        Ok(())
    }

    /// Delete surfaces' list objects (never the root's, never the active list's).
    fn free_surfaces(&mut self, freed: &[u32]) {
        let Some(objects) = self.objects.as_mut() else {
            return;
        };
        let mut any = false;
        let mut target_deleted = false;
        for surface in freed {
            if *surface == ROOT_SURFACE || *surface == objects.active {
                continue;
            }
            if let Some(l) = objects.parked.remove(surface) {
                target_deleted |= l.target.is_some();
                l.delete(&self.gl.raw);
                any = true;
            }
        }
        if any {
            // Deleted handles may sit in the cache: forget everything it holds.
            self.cache = Cache::default();
        }
        if target_deleted && self.options.damage {
            // Root aliases now sample transparent, even if the root draw list is unchanged.
            self.planner.invalidate();
            self.damage_reason = 100;
        }
    }

    /// Free every surface's list objects (a producer that starts over: a fresh applier holds no
    /// surface pass). Nothing when none exists.
    pub fn free_all_surfaces(&mut self) {
        let ids: Vec<u32> = self
            .objects
            .as_ref()
            .map(|o| o.parked.keys().copied().filter(|s| *s != ROOT_SURFACE).collect())
            .unwrap_or_default();
        if !ids.is_empty() && !self.loss.lost() {
            self.free_surfaces(&ids);
        }
    }

    /// Surfaces whose list objects exist (for tests and diagnostics).
    pub fn surfaces(&self) -> Vec<u32> {
        let Some(o) = self.objects.as_ref() else {
            return Vec::new();
        };
        let mut v: Vec<u32> = o
            .parked
            .keys()
            .copied()
            .chain(std::iter::once(o.active))
            .filter(|s| *s != ROOT_SURFACE)
            .collect();
        v.sort_unstable();
        v
    }

    /// Read surface `surface`'s target (Godot's orientation keeps design rows; else rows are
    /// top-down as [`Self::read_target`]'s). An error when it has no target.
    pub fn read_surface(&mut self, surface: u32, out: &mut [u8]) -> Result<(), ExecError> {
        if self.context_state() != ContextState::Ready {
            return Err(ExecError::Lost);
        }
        let objects = self.objects.as_ref().ok_or(ExecError::Lost)?;
        let list = if objects.active == surface {
            Some(&objects.list)
        } else {
            objects.parked.get(&surface)
        };
        let Some(t) = list.and_then(|l| l.target.as_ref()) else {
            return Err(ExecError::Invalid(format!("surface {surface} has no target")));
        };
        let (framebuffer, width, height) = (t.framebuffer, t.width, t.height);
        let swap = !self.options.godot_orientation;
        self.read(Some(framebuffer), width, height, out, swap)
    }

    /// Surface `surface`'s target size, once a pass allocated it.
    pub fn surface_size(&self, surface: u32) -> Option<(u32, u32)> {
        let o = self.objects.as_ref()?;
        let l = if o.active == surface {
            Some(&o.list)
        } else {
            o.parked.get(&surface)
        };
        l.and_then(|l| l.target.as_ref()).map(|t| (t.width, t.height))
    }

    /// Poll the outstanding fence without blocking. WebGL updates a sync's status only between
    /// tasks, so poll on a later frame (many mobile GPUs have no timer query).
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

    /// The shot: `readPixels` RGBA/UNSIGNED_BYTE of the target (the TypeScript `StageTarget.readPixels`:
    /// each 10- or 2-bit channel rounded to the nearest 8-bit level), rows TOP-DOWN, into
    /// `out[..4·w·h]`.
    pub fn read_target(&mut self, out: &mut [u8]) -> Result<(), ExecError> {
        if self.context_state() != ContextState::Ready {
            return Err(ExecError::Lost);
        }
        let Some(target) = self.objects.as_ref().and_then(|o| o.list.target.as_ref()) else {
            return Err(ExecError::Invalid(
                "no frame has allocated the target yet".into(),
            ));
        };
        let (framebuffer, width, height) = (target.framebuffer, target.width, target.height);
        // In Godot's orientation GL row 0 is design row 0: no swap.
        let swap = !self.options.godot_orientation;
        self.read(Some(framebuffer), width, height, out, swap)
    }

    /// The canvas's drawing buffer after the blit, rows top-down (same task only: the canvas does
    /// not preserve its drawing buffer). For tests: compositor-equals-readback.
    pub fn read_canvas(&mut self, out: &mut [u8]) -> Result<(), ExecError> {
        if self.context_state() != ContextState::Ready {
            return Err(ExecError::Lost);
        }
        let (width, height) = (self.canvas.width(), self.canvas.height());
        self.read(None, width, height, out, true)
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
        swap_rows: bool,
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
        if !swap_rows {
            return Ok(());
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
                    id, width, height, ..
                } => {
                    if id == WHITE_TEXTURE {
                        return Err(ExecError::Invalid("texture id 0 is the white texel".into()));
                    }
                    // An image over MAX_TEXTURE_SIZE is reduced at upload (`downscale_factor`).
                    if width == 0 || height == 0 {
                        return Err(ExecError::Invalid(format!(
                            "texture {id}: size {width}x{height}"
                        )));
                    }
                    check_texture_bytes(list, op, id)?;
                }
                TextureOp::Free { id } | TextureOp::Surface { id, .. } => {
                    if id == WHITE_TEXTURE {
                        return Err(ExecError::Invalid("texture id 0 is the white texel".into()));
                    }
                }
                TextureOp::UploadHalf {
                    id, width, height, ..
                } => {
                    if id == WHITE_TEXTURE {
                        return Err(ExecError::Invalid("texture id 0 is the white texel".into()));
                    }
                    if width == 0 || height == 0 {
                        return Err(ExecError::Invalid(format!(
                            "texture {id}: size {width}x{height}"
                        )));
                    }
                    check_texture_bytes(list, op, id)?;
                }
                TextureOp::UploadCompressed {
                    id,
                    width,
                    height,
                    format,
                    len,
                    ..
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
                    if u64::from(len) != format.level_bytes(width, height) {
                        return Err(ExecError::Invalid(format!(
                            "texture {id}: {len} bytes is not {format:?}'s level 0 at {width}x{height}"
                        )));
                    }
                    check_texture_bytes(list, op, id)?;
                }
            }
        }
        Ok(())
    }

    /// Bump the version of every binding slot the list marks dirty (every slot on a full upload).
    fn version_bindings(&mut self, list: &DrawList) {
        let Some(objects) = self.objects.as_mut() else {
            return;
        };
        let versions = &mut objects.list.binding_versions;
        let n = list.bindings.len();
        let all = list.dirty.all || versions.len() != n;
        versions.resize(n, 0);
        let counter = &mut self.version_counter;
        let mut bump = |slot: usize, versions: &mut Vec<u64>| {
            *counter += 1;
            versions[slot] = *counter;
        };
        if all {
            for slot in 0..n {
                bump(slot, versions);
            }
        } else {
            for &(start, end) in list.dirty.bindings.as_slice() {
                for slot in start as usize..(end as usize).min(n) {
                    bump(slot, versions);
                }
            }
        }
    }

    fn texture_ops(&mut self, list: &DrawList, stats: &mut ExecStats) {
        for op in &list.texture_ops {
            let id = match *op {
                TextureOp::Upload { id, .. } | TextureOp::UploadHalf { id, .. }
                | TextureOp::UploadCompressed { id, .. } | TextureOp::Free { id }
                | TextureOp::Surface { id, .. } => id,
            };
            let revision = self.texture_revisions.entry(id).or_default();
            *revision = revision.wrapping_add(1);
            match *op {
                TextureOp::Upload { id, width, height, .. } => {
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
                    let straight = op_bytes(list, op);
                    let premultiplied: Vec<u8>;
                    let bytes = if self.options.sabotage == Some(Sabotage::PremultipliedUpload) {
                        premultiplied = straight
                            .chunks_exact(4)
                            .flat_map(|p| {
                                let a = u32::from(p[3]);
                                let m = |c: u8| ((u32::from(c) * a + 127) / 255) as u8;
                                [m(p[0]), m(p[1]), m(p[2]), p[3]]
                            })
                            .collect();
                        &premultiplied[..]
                    } else {
                        straight
                    };
                    let k = downscale_factor(width, height, self.max_side);
                    let reduced: Vec<u8>;
                    let (bytes, width, height) = if k > 1 {
                        reduced = downscale_rgba8(bytes, width, height, k);
                        let (w, h) = downscaled_size(width, height, k);
                        (&reduced[..], w, h)
                    } else {
                        (bytes, width, height)
                    };
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
                TextureOp::UploadHalf { id, width, height, .. } => {
                    // A half-float image as GLES3 keeps it (RGBA16F), sampled as RGBA8 is.
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
                    let bytes = op_bytes(list, op);
                    let k = downscale_factor(width, height, self.max_side);
                    let reduced: Vec<u8>;
                    let (bytes, width, height) = if k > 1 {
                        reduced = downscale_texels_nearest(bytes, width, height, k, 8);
                        let (w, h) = downscaled_size(width, height, k);
                        (&reduced[..], w, h)
                    } else {
                        (bytes, width, height)
                    };
                    unsafe {
                        self.gl.c().tex_image_2d(
                            glow::TEXTURE_2D,
                            0,
                            glow::RGBA16F as i32,
                            width as i32,
                            height as i32,
                            0,
                            glow::RGBA,
                            glow::HALF_FLOAT,
                            glow::PixelUnpackData::Slice(Some(bytes)),
                        );
                    }
                    stats.texture_uploads += 1;
                    stats.texture_upload_bytes += bytes.len() as u32;
                }
                TextureOp::UploadCompressed {
                    id,
                    width,
                    height,
                    format,
                    len,
                    ..
                } => {
                    // A `block` variant's level 0, in
                    // the GL internal format Godot's GLES3 driver uses for it; the texture is then
                    // sampled exactly as an RGBA8 one (level 0, the draw's own sampler).
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
                    let bytes = op_bytes(list, op);
                    unsafe {
                        self.gl.c().compressed_tex_image_2d(
                            glow::TEXTURE_2D,
                            0,
                            compressed_internal_format(format) as i32,
                            width as i32,
                            height as i32,
                            0,
                            len as i32,
                            bytes,
                        );
                    }
                    stats.texture_uploads += 1;
                    stats.texture_upload_bytes += len;
                }
                TextureOp::Free { id } => {
                    self.surface_aliases.remove(&id);
                    if let Some(texture) = self.textures.remove(&id) {
                        unsafe { self.gl.c().delete_texture(texture) };
                        if self.cache.draw_texture == Some(texture) {
                            self.cache.draw_texture = None;
                        }
                        stats.texture_frees += 1;
                    }
                }
                TextureOp::Surface { id, surface } => {
                    // An id is one texture: an alias replaces an image of the same id.
                    if let Some(texture) = self.textures.remove(&id) {
                        unsafe { self.gl.c().delete_texture(texture) };
                        if self.cache.draw_texture == Some(texture) {
                            self.cache.draw_texture = None;
                        }
                    }
                    self.surface_aliases.insert(id, surface);
                }
            }
        }
    }

    /// The active list's target for `target`, (re)allocated on a size or format change. `root`:
    /// the canvas follows its size (a surface's never moves the canvas).
    fn ensure_target(&mut self, target: &Target, root: bool) -> Result<(), ExecError> {
        let objects = self.objects.as_mut().ok_or(ExecError::Lost)?;
        if let Some(t) = &objects.list.target
            && t.width == target.width
            && t.height == target.height
            && t.format == target.format
        {
            return Ok(());
        }
        if root && self.options.damage {
            self.planner.invalidate();
            self.damage_reason = 102;
        }
        let gl = &self.gl;
        if let Some(old) = objects.list.target.take() {
            unsafe {
                gl.c().delete_framebuffer(old.framebuffer);
                gl.c().delete_texture(old.texture);
                if let Some(depth) = old.depth {
                    gl.c().delete_renderbuffer(depth);
                }
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
        if !root {
            self.target_unit_stale = true;
        }
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
        objects.list.target = Some(TargetObjects {
            texture,
            framebuffer,
            width: target.width,
            height: target.height,
            format: target.format,
            depth: None,
            depth_failed: false,
        });
        if !root {
            return Ok(());
        }
        if self.canvas.width() != target.width {
            self.canvas.set_width(target.width);
        }
        if self.canvas.height() != target.height {
            self.canvas.set_height(target.height);
        }
        Ok(())
    }

    /// Whether the depth pre-pass program has linked, settling its link after the readiness gate
    /// (`COMPLETION_STATUS_KHR`, or a signalled fence after the link commands). A fence orders
    /// the status read after issue but can still leave it waiting on the driver's compile.
    /// Until then lists draw without their depth tables, which paints the same
    /// pixels (the tables only reject what a later draw overwrites). A failed link, or one read on
    /// a context lost meanwhile (the restore makes new objects and a new link), stays unused.
    fn depth_program_ready(&mut self) -> bool {
        let Some(objects) = self.objects.as_mut() else {
            return false;
        };
        let DepthProgram::Pending { program, polled, fence, .. } = &mut objects.depth_program else {
            return matches!(objects.depth_program, DepthProgram::Ready(_));
        };
        let parallel = self.gl.raw.supported_extensions().contains("KHR_parallel_shader_compile");
        let ready = link_ready(
            parallel.then(|| unsafe { self.gl.raw.get_program_completion_status(*program) }),
            || fence.map(|f| unsafe { self.gl.raw.get_sync_status(f) == glow::SIGNALED }),
            *polled,
        );
        *polled = true;
        if !ready {
            return false;
        }
        let DepthProgram::Pending { program, shaders, fence, .. } =
            std::mem::replace(&mut objects.depth_program, DepthProgram::Failed)
        else {
            return false;
        };
        // A lost context invalidates the handles; never delete its fence.
        if !self.context.is_context_lost() {
            if let Some(fence) = fence {
                unsafe { self.gl.raw.delete_sync(fence) };
            }
        } else {
            self.loss.mark_lost();
            return false;
        }
        match finish_link(&self.gl.raw, program, shaders) {
            Ok(program) => {
                objects.depth_program = DepthProgram::Ready(program);
                true
            }
            Err(_) => {
                if self.context.is_context_lost() {
                    self.loss.mark_lost();
                }
                false
            }
        }
    }

    /// Attach a DEPTH_COMPONENT16 renderbuffer (every WebGL 2 context renders to one) to the
    /// active target. False when there is no target or the attachment left the framebuffer
    /// incomplete (then detached, and never tried again for this target): the list then draws
    /// without its depth tables, which paints the same pixels.
    fn ensure_depth(&mut self) -> bool {
        let Some(objects) = self.objects.as_mut() else {
            return false;
        };
        let Some(target) = objects.list.target.as_mut() else {
            return false;
        };
        if target.depth.is_some() {
            return true;
        }
        if target.depth_failed {
            return false;
        }
        let gl = &self.gl;
        let complete = unsafe {
            let Ok(depth) = gl.c().create_renderbuffer() else {
                return false;
            };
            gl.c().bind_renderbuffer(glow::RENDERBUFFER, Some(depth));
            gl.c().renderbuffer_storage(
                glow::RENDERBUFFER,
                glow::DEPTH_COMPONENT16,
                target.width as i32,
                target.height as i32,
            );
            gl.c().bind_renderbuffer(glow::RENDERBUFFER, None);
            gl.c()
                .bind_framebuffer(glow::FRAMEBUFFER, Some(target.framebuffer));
            gl.c().framebuffer_renderbuffer(
                glow::FRAMEBUFFER,
                glow::DEPTH_ATTACHMENT,
                glow::RENDERBUFFER,
                Some(depth),
            );
            let complete =
                gl.c().check_framebuffer_status(glow::FRAMEBUFFER) == glow::FRAMEBUFFER_COMPLETE;
            if complete {
                target.depth = Some(depth);
            } else {
                gl.c().framebuffer_renderbuffer(
                    glow::FRAMEBUFFER,
                    glow::DEPTH_ATTACHMENT,
                    glow::RENDERBUFFER,
                    None,
                );
                gl.c().delete_renderbuffer(depth);
                target.depth_failed = true;
            }
            complete
        };
        self.cache.draw_framebuffer = Some(Some(target.framebuffer));
        self.cache.read_framebuffer = Some(Some(target.framebuffer));
        complete
    }

    fn upload(&mut self, list: &DrawList, stats: &mut ExecStats) {
        let Some(objects) = self.objects.as_mut() else {
            return;
        };
        let all = list.dirty.all || objects.list.needs_full;
        let gl = &self.gl;
        let cache = &mut self.cache;

        // Item rows: unit 1 always holds the item texture.
        let rows = item_rows_for(list.items.len());
        let mut items_all = all;
        if rows > objects.list.item_rows {
            let grown = rows.next_power_of_two();
            set_active_unit(gl, cache, UNIT_ITEMS);
            allocate_items(gl.c(), grown);
            objects.list.item_rows = grown;
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
        if list.vertices.len() > objects.list.vertex_capacity {
            objects.list.vertex_capacity = list.vertices.len().next_power_of_two();
            bind_array_buffer(gl, cache, objects.list.vertex_buffer);
            unsafe {
                gl.c().buffer_data_size(
                    glow::ARRAY_BUFFER,
                    (objects.list.vertex_capacity * VERTEX_BYTES) as i32,
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
            bind_array_buffer(gl, cache, objects.list.vertex_buffer);
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
        if list.indices.len() > objects.list.index_capacity {
            objects.list.index_capacity = list.indices.len().next_power_of_two();
            bind_vertex_array(gl, cache, objects.list.vertex_array);
            unsafe {
                gl.c().buffer_data_size(
                    glow::ELEMENT_ARRAY_BUFFER,
                    (objects.list.index_capacity * 4) as i32,
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
            bind_vertex_array(gl, cache, objects.list.vertex_array);
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

        // Instances (ARRAY_BUFFER, like the vertices).
        let mut instances_all = all;
        if list.instances.len() > objects.list.instance_capacity {
            objects.list.instance_capacity = list.instances.len().next_power_of_two();
            bind_array_buffer(gl, cache, objects.list.instance_buffer);
            unsafe {
                gl.c().buffer_data_size(
                    glow::ARRAY_BUFFER,
                    (objects.list.instance_capacity * INSTANCE_BYTES) as i32,
                    glow::DYNAMIC_DRAW,
                );
            }
            instances_all = true;
        }
        let instance_ranges = if instances_all {
            vec![(0, list.instances.len() as u32)]
        } else {
            list.dirty.instances.as_slice().to_vec()
        };
        for (start, end) in instance_ranges {
            let end = (end as usize).min(list.instances.len());
            let start = start as usize;
            if start >= end {
                continue;
            }
            bind_array_buffer(gl, cache, objects.list.instance_buffer);
            let bytes: &[u8] = bytemuck::cast_slice(&list.instances[start..end]);
            unsafe {
                gl.c().buffer_sub_data_u8_slice(
                    glow::ARRAY_BUFFER,
                    (start * INSTANCE_BYTES) as i32,
                    bytes,
                )
            };
            stats.vertex_bytes += bytes.len() as u32;
            stats.upload_calls += 1;
        }
    }

    /// Draw `calls` into the active list's target, cleared first when `clear` (Godot's clear of
    /// a render target; a surface whose clear mode is not due keeps its contents).
    fn draw(
        &mut self,
        list: &DrawList,
        calls: &[Call],
        clear: bool,
        depth: bool,
        group_depth_ready: bool,
        partial: Option<(&[[i32; 4]], &[[i32; 4]])>,
        stats: &mut ExecStats,
    ) {
        let Some(objects) = self.objects.as_ref() else {
            return;
        };
        let Some(target) = objects.list.target.as_ref() else {
            return;
        };
        let sabotage = self.options.sabotage;
        let gl = &self.gl;
        let cache = &mut self.cache;
        let (width, height) = (target.width, target.height);
        let target_fb = target.framebuffer;
        // A target with a depth buffer clears it with its colour (on a tiler, tile memory set up
        // rather than loaded) and invalidates it once the depth window ends (never stored).
        let has_depth = target.depth.is_some() && clear;
        let godot = self.options.godot_orientation;
        let list_vertex_array = objects.list.vertex_array;

        bind_draw_framebuffer(gl, cache, Some(target_fb));
        set_viewport(gl, cache, width, height);
        set_scissor_enabled(gl, cache, false);
        // The list's clear colour is straight; the target holds premultiplied colour.
        if clear {
            let [r, g, b, a] = list.target.clear;
            let clear = [r * a, g * a, b * a, a];
            let bits = clear.map(f32::to_bits);
            if cache.clear_color != Some(bits) {
                unsafe { gl.c().clear_color(clear[0], clear[1], clear[2], clear[3]) };
                cache.clear_color = Some(bits);
            }
            if has_depth {
                if !cache.clear_depth {
                    unsafe { gl.c().clear_depth_f32(0.0) };
                    cache.clear_depth = true;
                }
                set_depth_mask(gl, cache, true);
            }
            if let Some((regions, _)) = partial {
                if sabotage != Some(Sabotage::DamageNoScissorClear) {
                    for &region in regions {
                        apply_scissor(gl, cache, Some(region), height, godot, stats);
                        unsafe { gl.c().clear(glow::COLOR_BUFFER_BIT) };
                    }
                }
                // Depth initialization and prepasses always cover the full attachment.
                set_scissor_enabled(gl, cache, false);
                if has_depth { unsafe { gl.c().clear(glow::DEPTH_BUFFER_BIT) }; }
            } else {
                let mask = glow::COLOR_BUFFER_BIT | if has_depth { glow::DEPTH_BUFFER_BIT } else { 0 };
                unsafe { gl.c().clear(mask) };
            }
        }
        // The depth tiles, before any draw (see DepthTile): depth only, at their levels.
        let mut depth_live = has_depth;
        let mut tested = false;
        if depth && has_depth && !calls.is_empty() {
            if let Some(objects) = self.objects.as_mut() {
                depth_prepass(gl, cache, objects, &list.depth_tiles, width, height, godot);
                tested = true;
                stats.depth_tiles = list.depth_tiles.len() as u32;
            }
        }
        if calls.is_empty() {
            if depth_live {
                end_depth(gl, cache, target_fb);
            }
            return;
        }

        // `present.ts`'s `toClip`: the f64 quotient stored as f32.
        let projection = [
            (2.0 / f64::from(width)) as f32,
            (-2.0 / f64::from(height)) as f32,
            -1.0,
            1.0,
        ];
        // ExecOptions::godot_orientation: Godot's screen_transform instead.
        let screen = godot_screen_transform(width, height);
        bind_vertex_array(gl, cache, list_vertex_array);
        let Some(objects) = self.objects.as_mut() else {
            return;
        };

        // The next screen operation to run (operations precede the draw they name).
        let mut next_op = 0usize;
        let mut group_depth = GroupDepth::default();
        let mut back_depth_live = None;
        let skip_back_producers = partial.is_some()
            && sabotage == Some(Sabotage::DamageSkipBackProducers);
        let back_work = partial.map(|(regions, _)| partial_back_work(list, calls, regions));
        for (call_index, call) in calls.iter().enumerate() {
            // The back-buffer operations GLES3 makes before this call's first draw (those of a
            // draw `plan_calls` skipped run here too, in order).
            let mut ran_ops = false;
            while let Some(op) = list.screen_ops.get(next_op) {
                if op.before > call.draw {
                    break;
                }
                // The depth window ends at the first back-buffer operation.
                if depth_live {
                    end_depth(gl, cache, target_fb);
                    depth_live = false;
                    tested = false;
                }
                if group_depth.operation(op) {
                    if let Some(fb) = back_depth_live.take() {
                        end_depth(gl, cache, fb);
                    }
                }
                if !skip_back_producers && back_work.as_ref().is_none_or(|(ops, _)| ops[next_op]) {
                    screen_op(gl, cache, objects, op, godot, stats);
                    ran_ops = true;
                } else {
                    stats.damage_ops_skipped += 1;
                }
                next_op += 1;
            }
            if ran_ops {
                bind_vertex_array(gl, cache, objects.list.vertex_array);
            }
            let n = self.planned_calls;
            self.planned_calls += 1;
            if self.options.sabotage == Some(Sabotage::DropDraws) && n % 2 == 1 {
                stats.calls_dropped += 1;
                continue;
            }
            let draw = &list.draws[call.draw as usize];
            // An open canvas group's draws go into the back buffer, blended as into a
            // transparent target; every other draw into the target.
            let to_back_buffer = draw.flags & DRAW_TO_BACK_BUFFER != 0;
            let opaque = list.target.opaque && !to_back_buffer;
            if to_back_buffer && depth_live {
                // ... and at the first draw into the back buffer.
                end_depth(gl, cache, target_fb);
                depth_live = false;
                tested = false;
            }
            if to_back_buffer && (skip_back_producers || back_work.as_ref().is_some_and(|(_, producers)| !producers[call_index])) { continue; }
            if to_back_buffer {
                let Some(bb) = objects.list.screen.as_mut() else {
                    // No back buffer (a target of 40 px or less): GLES3 has none to draw into.
                    stats.calls_dropped += 1;
                    continue;
                };
                bind_draw_framebuffer(gl, cache, Some(bb.framebuffer));
                attach_screen_level(gl, bb, 0);
                let fb = bb.framebuffer;
                let supported = group_depth_ready && bb.depth.is_some();
                if let Some(tiles) = group_depth.begin(list, call.draw as usize, supported) {
                    // Full depth clear at pass start, independent of the previous draw's scissor.
                    set_scissor_enabled(gl, cache, false);
                    if !cache.clear_depth {
                        unsafe { gl.c().clear_depth_f32(0.0) };
                        cache.clear_depth = true;
                    }
                    set_depth_mask(gl, cache, true);
                    unsafe { gl.c().clear(glow::DEPTH_BUFFER_BIT) };
                    depth_prepass(gl, cache, objects, tiles, width, height, godot);
                    bind_vertex_array(gl, cache, objects.list.vertex_array);
                    stats.depth_tiles += tiles.len() as u32;
                    back_depth_live = Some(fb);
                }
            } else {
                if let Some(fb) = back_depth_live.take() {
                    end_depth(gl, cache, fb);
                }
                group_depth.end();
                bind_draw_framebuffer(gl, cache, Some(target_fb));
            }
            let group_mode = if draw.program != BUILTIN_PROGRAM {
                0
            } else if draw.flags & DRAW_GROUP_CLIP != 0 {
                1
            } else if draw.flags & DRAW_GROUP_COMPOSITE != 0 {
                2
            } else {
                0
            };
            // `plan_calls` admitted only known blends.
            let blend = Blend::from_u32(draw.blend).unwrap_or(Blend::Mix);
            let msdf = draw.flags & DRAW_MSDF != 0;
            if group_mode != 0 {
                // A group owner through Godot's default clip-children or canvas-group shader.
                let Some(bb) = objects.list.screen.as_mut() else {
                    stats.calls_dropped += 1;
                    continue;
                };
                let g = &mut bb.group;
                if cache.program != Some(g.program) {
                    unsafe { gl.c().use_program(Some(g.program)) };
                    cache.program = Some(g.program);
                }
                if g.projection != Some((width, height, godot)) {
                    set_vertex_projection(
                        gl,
                        [&g.u_projection, &g.u_godot_screen, &g.u_screen],
                        projection,
                        godot,
                        &screen,
                    );
                    g.projection = Some((width, height, godot));
                }
                if g.mode != Some(group_mode) {
                    unsafe { gl.c().uniform_1_i32(g.u_mode.as_ref(), group_mode) };
                    g.mode = Some(group_mode);
                }
                let back = (bb.texture, bb.sampler);
                if cache.units[UNIT_SCREEN_PASS as usize] != Some(back) {
                    set_active_unit(gl, cache, UNIT_SCREEN_PASS);
                    unsafe {
                        gl.c().bind_texture(glow::TEXTURE_2D, Some(back.0));
                        gl.c().bind_sampler(UNIT_SCREEN_PASS, Some(back.1));
                    }
                    cache.units[UNIT_SCREEN_PASS as usize] = Some(back);
                    stats.texture_binds += 1;
                }
            } else if draw.program == BUILTIN_PROGRAM && msdf {
                // The builtin's MSDF variant.
                let m = &mut objects.msdf;
                if cache.program != Some(m.program) {
                    unsafe { gl.c().use_program(Some(m.program)) };
                    cache.program = Some(m.program);
                }
                if cache.msdf_projection != Some((width, height, godot)) {
                    set_vertex_projection(
                        gl,
                        [&m.u_projection, &m.u_godot_screen, &m.u_screen],
                        projection,
                        godot,
                        &screen,
                    );
                    cache.msdf_projection = Some((width, height, godot));
                }
                let premultiply_out = premultiplies(blend, opaque);
                if m.premultiply_out != Some(premultiply_out) {
                    unsafe {
                        gl.c()
                            .uniform_1_i32(m.u_premultiply_out.as_ref(), premultiply_out as i32)
                    };
                    m.premultiply_out = Some(premultiply_out);
                }
                let state = MsdfState::of(draw, sabotage);
                if cache.msdf_state != Some(state) {
                    set_msdf(gl, [&m.u_msdf, &m.u_msdf_no_median], draw.msdf, state);
                    cache.msdf_state = Some(state);
                }
            } else if draw.program == BUILTIN_PROGRAM {
                if cache.program != Some(objects.program) {
                    unsafe { gl.c().use_program(Some(objects.program)) };
                    cache.program = Some(objects.program);
                }
                if cache.projection != Some((width, height, godot)) {
                    set_vertex_projection(
                        gl,
                        [
                            &objects.u_projection,
                            &objects.u_godot_screen,
                            &objects.u_screen,
                        ],
                        projection,
                        godot,
                        &screen,
                    );
                    cache.projection = Some((width, height, godot));
                }
            } else {
                // An item-space program (plan_calls admitted only a compiled one).
                let slot = draw.program - 1;
                let binding = &list.bindings[slot as usize];
                let Some(item) = self
                    .programs
                    .get_mut(&binding.program)
                    .and_then(|p| p.compiled.as_mut())
                else {
                    continue;
                };
                if cache.program != Some(item.program) {
                    unsafe { gl.c().use_program(Some(item.program)) };
                    cache.program = Some(item.program);
                    stats.program_binds += 1;
                }
                if item.projection != Some((width, height, godot)) {
                    set_vertex_projection(
                        gl,
                        [&item.u_projection, &item.u_godot_screen, &item.u_screen],
                        projection,
                        godot,
                        &screen,
                    );
                    item.projection = Some((width, height, godot));
                }
                let premultiply_out = premultiplies(blend, opaque);
                if item.premultiply_out != Some(premultiply_out) {
                    unsafe {
                        gl.c()
                            .uniform_1_i32(item.u_premultiply_out.as_ref(), premultiply_out as i32)
                    };
                    item.premultiply_out = Some(premultiply_out);
                }
                // An MSDF draw through an item-space program (canvas.glsl's MSDF branch
                // runs before the shader's fragment code).
                let state = MsdfState::of(draw, sabotage);
                if msdf && item.msdf_state != Some((true, state)) {
                    unsafe { gl.c().uniform_1_i32(item.u_msdf_on.as_ref(), 1) };
                    set_msdf(gl, [&item.u_msdf, &item.u_msdf_no_median], draw.msdf, state);
                    item.msdf_state = Some((true, state));
                } else if !msdf && item.msdf_state.map(|(on, _)| on) != Some(false) {
                    unsafe { gl.c().uniform_1_i32(item.u_msdf_on.as_ref(), 0) };
                    item.msdf_state = Some((false, state));
                }
                let version = objects
                    .list
                    .binding_versions
                    .get(slot as usize)
                    .copied()
                    .unwrap_or(0);
                if item.applied != Some((slot, version)) {
                    let [r, g, b, a] = binding.post_modulate;
                    unsafe {
                        gl.c()
                            .uniform_4_f32(item.u_post_modulate.as_ref(), r, g, b, a)
                    };
                    let us = &binding.uniforms;
                    let planned = item.uniform_plan_len == Some(us.len())
                        && item
                            .uniform_plan
                            .iter()
                            .all(|(k, name, ..)| us[*k].name == *name);
                    if !planned {
                        item.uniform_plan.clear();
                        for (k, u) in us.iter().enumerate() {
                            if let Some((location, utype, size)) = item.uniforms.get(&*u.name) {
                                item.uniform_plan.push((
                                    k,
                                    u.name.clone(),
                                    location.clone(),
                                    *utype,
                                    *size,
                                ));
                            }
                        }
                        item.uniform_plan_len = Some(us.len());
                    }
                    for (k, _, location, utype, size) in &item.uniform_plan {
                        set_uniform(gl, location, *utype, *size, &us[*k].value);
                    }
                    item.applied = Some((slot, version));
                    stats.binding_uploads += 1;
                }
                if item.u_screen_pixel_size.is_some()
                    && item.screen_pixel_size != Some((width, height))
                {
                    unsafe {
                        gl.c().uniform_2_f32(
                            item.u_screen_pixel_size.as_ref(),
                            (1.0 / f64::from(width)) as f32,
                            (1.0 / f64::from(height)) as f32,
                        )
                    };
                    item.screen_pixel_size = Some((width, height));
                }
                let time = list.shader_time.to_bits();
                if item.u_time.is_some() && item.time != Some(time) {
                    unsafe { gl.c().uniform_1_f32(item.u_time.as_ref(), list.shader_time) };
                    item.time = Some(time);
                }
                for (name, unit) in &item.sampler_units {
                    let bound = binding.samplers.iter().find(|s| &*s.name == name.as_str());
                    let (texture, sampler) = match bound {
                        // The back buffer, with its own fixed sampler; white for a draw
                        // into the back buffer (canvas_begin binds white there).
                        Some(s) if s.texture == SCREEN_TEXTURE => match objects.list.screen.as_ref() {
                            Some(screen) if !to_back_buffer => (screen.texture, screen.sampler),
                            _ => (objects.white, objects.samplers[0]),
                        },
                        // GLES3's default for an unset hinted sampler.
                        Some(s) if DEFAULT_TEXTURE_IDS.contains(&s.texture) => {
                            let at = DEFAULT_TEXTURE_IDS
                                .iter()
                                .position(|id| *id == s.texture)
                                .unwrap_or(0);
                            (objects.defaults[at], objects.samplers[0])
                        }
                        Some(s) if s.texture != WHITE_TEXTURE => {
                            match lookup_texture(
                                &self.textures,
                                &self.surface_aliases,
                                objects,
                                s.texture,
                            ) {
                                Some(t) => (t, objects.samplers[sampler_index(s.sampler)]),
                                None => (objects.white, objects.samplers[0]),
                            }
                        }
                        _ => (objects.white, objects.samplers[0]),
                    };
                    let at = *unit as usize;
                    if cache.units[at] != Some((texture, sampler)) {
                        set_active_unit(gl, cache, *unit);
                        unsafe {
                            gl.c().bind_texture(glow::TEXTURE_2D, Some(texture));
                            gl.c().bind_sampler(*unit, Some(sampler));
                        }
                        cache.units[at] = Some((texture, sampler));
                        stats.texture_binds += 1;
                    }
                }
            }
            // A listed draw of the builtin program: depth-tested at its level while the tiles
            // hold; every other draw untested.
            let test = tested
                && draw.program == BUILTIN_PROGRAM
                && !msdf
                && group_mode == 0
                && !to_back_buffer;
            let level = call.depth.filter(|_| test);
            let group_test = to_back_buffer && back_depth_live.is_some()
                && group_depth.tests(call.draw as usize);
            if depth_live || back_depth_live.is_some() {
                set_depth_test(gl, cache, level.is_some() || group_test);
            }
            // Item-space and MSDF vertices already use NDC z=0. Builtin vertices must use the
            // same value here, regardless of a previous target depth level. Dead cells sit at
            // the top tile level, and all tested draws leave the depth buffer unchanged.
            let z = if group_test && draw.program == BUILTIN_PROGRAM && !msdf && group_mode == 0 {
                Some(0.0)
            } else {
                level.map(|level| depth_ndc(level, true))
            };
            if let Some(z) = z {
                if cache.u_depth != Some((objects.program, z.to_bits())) {
                    unsafe { gl.c().uniform_1_f32(objects.u_depth.as_ref(), z) };
                    cache.u_depth = Some((objects.program, z.to_bits()));
                }
            }
            if level.is_some() || group_test {
                stats.depth_tested += 1;
            }
            set_blend(gl, cache, blend, opaque, stats);
            let premultiply = premultiplies(blend, opaque);
            // (The MSDF variant holds its own `u_premultiply_out`, set above.)
            if draw.program == BUILTIN_PROGRAM
                && !msdf
                && group_mode == 0
                && cache.premultiply != Some(premultiply)
            {
                // Textures stored premultiplied (the premultiplied-upload sabotage) are sampled
                // as premultiplied: only the vertex colour is premultiplied in the shader.
                let texel = premultiply && sabotage != Some(Sabotage::PremultipliedUpload);
                unsafe {
                    gl.c()
                        .uniform_1_i32(objects.u_premultiply.as_ref(), premultiply as i32);
                    gl.c()
                        .uniform_1_i32(objects.u_texel_premultiply.as_ref(), texel as i32);
                };
                cache.premultiply = Some(premultiply);
            }
            // The texture and sampler are the run's first textured draw's.
            let tex_draw = &list.draws[call.texture_draw as usize];
            // An all-untextured call binds the white texel too: its fragments ignore the texture,
            // but leaving a stale binding in place (the cache is not the whole GL state) can drop
            // an MSDF frame's draws after an atlas re-upload.
            if tex_draw.flags & DRAW_UNTEXTURED != 0 || tex_draw.texture == WHITE_TEXTURE {
                // A 1×1 white texel samples white under every filter and wrap: keep the sampler.
                bind_draw_texture_with(gl, cache, objects.white, stats);
            } else if let Some(texture) =
                lookup_texture(&self.textures, &self.surface_aliases, objects, tex_draw.texture)
            {
                bind_draw_texture_with(gl, cache, texture, stats);
                let sampler = objects.samplers[sampler_index(tex_draw.sampler)];
                if cache.draw_sampler != Some(sampler) {
                    unsafe { gl.c().bind_sampler(UNIT_DRAW, Some(sampler)) };
                    cache.draw_sampler = Some(sampler);
                    stats.sampler_binds += 1;
                }
            }
            let instance_count = if draw.flags & DRAW_INSTANCED != 0 {
                // Godot's TYPE_MULTIMESH call (rasterizer_canvas_gles3.cpp:1478-1513): the
                // instance attributes from the range's first instance, divisor 1, then
                // `glDrawElementsInstanced`; the identity constants again after it.
                let range = list
                    .instanced
                    .binary_search_by_key(&call.draw, |r| r.draw)
                    .ok()
                    .map(|i| list.instanced[i]);
                let Some(range) = range.filter(|r| {
                    r.count > 0
                        && u64::from(r.first) + u64::from(r.count) <= list.instances.len() as u64
                }) else {
                    continue;
                };
                bind_array_buffer(gl, cache, objects.list.instance_buffer);
                let base = range.first as usize * INSTANCE_BYTES;
                unsafe {
                    for k in 0..INSTANCE_ATTRIBUTES {
                        let location = INSTANCE_ATTRIBUTES + k;
                        gl.c().enable_vertex_attrib_array(location);
                        gl.c().vertex_attrib_pointer_f32(
                            location,
                            4,
                            glow::FLOAT,
                            false,
                            INSTANCE_BYTES as i32,
                            (base + 16 * k as usize) as i32,
                        );
                        gl.c().vertex_attrib_divisor(location, 1);
                    }
                }
                Some(range.count)
            } else { None };
            let own = (draw.flags & DRAW_SCISSOR != 0).then_some(draw.scissor);
            if let Some((regions, back_regions)) = partial {
                let regions = if to_back_buffer { back_regions } else { regions };
                for &region in regions {
                    if !gsw_canvas_draw_list::cover::PxRect::xywh(call.bounds)
                        .intersects(&gsw_canvas_draw_list::cover::PxRect::xywh(region)) { continue; }
                    let rect = effective_scissor(own, Some(region));
                    if rect.is_some_and(|r| r[2] <= 0 || r[3] <= 0) { continue; }
                    apply_scissor(gl, cache, rect, height, godot, stats);
                    issue_call(gl, call, instance_count);
                    stats.draw_calls += 1;
                    stats.damage_calls += 1;
                }
            } else {
                // Preserve Full's issue count even for a draw with an empty own scissor.
                apply_scissor(gl, cache, effective_scissor(own, None), height, godot, stats);
                issue_call(gl, call, instance_count);
                stats.draw_calls += 1;
            }
            if instance_count.is_some() {
                unsafe {
                    for k in 0..INSTANCE_ATTRIBUTES {
                        gl.c().disable_vertex_attrib_array(INSTANCE_ATTRIBUTES + k);
                    }
                }
                identity_instance(gl.c());
            }
        }
        if let Some(fb) = back_depth_live {
            end_depth(gl, cache, fb);
        }
        if depth_live {
            end_depth(gl, cache, target_fb);
        }
    }

    /// The TypeScript `StageTarget.blit()`: RGB10_A2 through the rounding `texelFetch` draw, RGBA8 through
    /// `blitFramebuffer`. Leaves the canvas bound for drawing.
    fn blit(&mut self, format: Format) {
        let Some(objects) = self.objects.as_ref() else {
            return;
        };
        let Some(target) = objects.list.target.as_ref() else {
            return;
        };
        let gl = &self.gl;
        let cache = &mut self.cache;
        set_scissor_enabled(gl, cache, false);
        match format {
            Format::Rgb10A2 => {
                // A surface target made since the last blit took UNIT_TARGET.
                if std::mem::take(&mut self.target_unit_stale) {
                    set_active_unit(gl, cache, UNIT_TARGET);
                    unsafe { gl.c().bind_texture(glow::TEXTURE_2D, Some(target.texture)) };
                }
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
                let flip = if self.options.godot_orientation {
                    target.height as i32
                } else {
                    0
                };
                if cache.flip_rows != Some(flip) {
                    unsafe { gl.c().uniform_1_i32(objects.u_flip_rows.as_ref(), flip) };
                    cache.flip_rows = Some(flip);
                }
                bind_vertex_array(gl, cache, objects.present_vertex_array);
                unsafe { gl.c().draw_arrays(glow::TRIANGLES, 0, 3) };
            }
            Format::Rgba8 => {
                bind_draw_framebuffer(gl, cache, None);
                bind_read(gl, cache, Some(target.framebuffer));
                let (w, h) = (target.width as i32, target.height as i32);
                // Godot's orientation: the target's row 0 is the canvas's top row.
                let (dy0, dy1) = if self.options.godot_orientation {
                    (h, 0)
                } else {
                    (0, h)
                };
                unsafe {
                    gl.c().blit_framebuffer(
                        0,
                        0,
                        w,
                        h,
                        0,
                        dy0,
                        w,
                        dy1,
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
        if self.loss.lost() || self.context.is_context_lost() {
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
            for (_, p) in self.programs.drain() {
                if let Some(c) = p.compiled {
                    gl.delete_program(c.program);
                }
                if let Some(l) = p.pending {
                    if let Some(fence) = l.fence {
                        gl.delete_sync(fence);
                    }
                    self.item_shaders.discard(gl, l.program, l.shaders);
                    gl.delete_program(l.program);
                }
            }
            self.item_shaders.delete(gl);
            if let Some(o) = self.objects.take() {
                gl.delete_program(o.program);
                gl.delete_program(o.msdf.program);
                gl.delete_program(o.present_program);
                gl.delete_vertex_array(o.present_vertex_array);
                match o.depth_program {
                    DepthProgram::Pending {
                        program, shaders, fence, ..
                    } => {
                        if let Some(fence) = fence {
                            gl.delete_sync(fence);
                        }
                        for s in shaders {
                            gl.delete_shader(s);
                        }
                        gl.delete_program(program);
                    }
                    DepthProgram::Ready(program) => gl.delete_program(program),
                    DepthProgram::Failed => {}
                }
                gl.delete_vertex_array(o.depth_vertex_array);
                gl.delete_buffer(o.depth_buffer);
                gl.delete_texture(o.white);
                for texture in o.defaults {
                    gl.delete_texture(texture);
                }
                for sampler in o.samplers {
                    gl.delete_sampler(sampler);
                }
                o.list.delete(gl);
                for (_, l) in o.parked {
                    l.delete(gl);
                }
            }
        }
    }
}

/// The GL texture a draw binds for list texture `id`: a resident texture, or a
/// [`TextureOp::Surface`] alias's surface colour texture -- transparent when that surface has no
/// target yet, or is the target being drawn (Godot's `viewport-feedback`: a viewport never samples
/// itself). None for an id that is neither.
fn lookup_texture(
    textures: &HashMap<u32, glow::Texture>,
    aliases: &HashMap<u32, u32>,
    objects: &Objects,
    id: u32,
) -> Option<glow::Texture> {
    if let Some(t) = textures.get(&id) {
        return Some(*t);
    }
    if let Some(at) = DEFAULT_TEXTURE_IDS.iter().position(|d| *d == id) {
        return Some(objects.defaults[at]);
    }
    let surface = *aliases.get(&id)?;
    let transparent = DEFAULT_TEXTURE_IDS
        .iter()
        .position(|d| *d == TRANSPARENT_TEXTURE)
        .map(|at| objects.defaults[at]);
    if surface == objects.active {
        return transparent;
    }
    match objects.parked.get(&surface).and_then(|l| l.target.as_ref()) {
        Some(t) => Some(t.texture),
        None => transparent,
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

fn set_depth_test(gl: &Gl, cache: &mut Cache, on: bool) {
    if cache.depth_test == Some(on) {
        return;
    }
    unsafe {
        if on {
            gl.c().enable(glow::DEPTH_TEST);
            if !cache.depth_func {
                gl.c().depth_func(glow::GREATER);
                cache.depth_func = true;
            }
        } else {
            gl.c().disable(glow::DEPTH_TEST);
        }
    }
    cache.depth_test = Some(on);
}

fn set_depth_mask(gl: &Gl, cache: &mut Cache, on: bool) {
    if cache.depth_mask != Some(on) {
        unsafe { gl.c().depth_mask(on) };
        cache.depth_mask = Some(on);
    }
}

fn set_color_mask(gl: &Gl, cache: &mut Cache, on: bool) {
    if cache.color_mask != Some(on) {
        unsafe { gl.c().color_mask(on, on, on, on) };
        cache.color_mask = Some(on);
    }
}

/// The depth window's end: the test off and the target's depth contents invalidated, so a tiler
/// never stores them (the next frame clears them again).
fn end_depth(gl: &Gl, cache: &mut Cache, target: glow::Framebuffer) {
    bind_draw_framebuffer(gl, cache, Some(target));
    set_depth_test(gl, cache, false);
    unsafe {
        gl.c()
            .invalidate_framebuffer(glow::DRAW_FRAMEBUFFER, &[glow::DEPTH_ATTACHMENT])
    };
}

/// The depth tiles' pre-pass into the cleared depth buffer of the bound target: every tile at
/// its level, the colour mask off, `GREATER` (each pixel keeps its highest level; tiles never
/// overlap anyway); the depth mask is off again afterwards, so tested draws leave it as it is.
/// Tile edges lie on pixel boundaries, so a tile covers exactly its pixels' centres.
fn depth_prepass(
    gl: &Gl,
    cache: &mut Cache,
    objects: &mut Objects,
    tiles: &[DepthTile],
    width: u32,
    height: u32,
    godot: bool,
) {
    bind_vertex_array(gl, cache, objects.depth_vertex_array);
    let held = objects
        .depth_tiles
        .as_ref()
        .is_some_and(|(t, w, h, g)| t[..] == *tiles && (*w, *h, *g) == (width, height, godot));
    if !held {
        let x = |px: i32| (2.0 * f64::from(px) / f64::from(width) - 1.0) as f32;
        // Design rows run down the GL window, or up it in Godot's orientation.
        let y = |px: i32| {
            let t = 2.0 * f64::from(px) / f64::from(height) - 1.0;
            (if godot { t } else { -t }) as f32
        };
        let mut bytes: Vec<u8> = Vec::with_capacity(tiles.len() * 6 * 12);
        for t in tiles {
            let [rx, ry, rw, rh] = t.rect;
            let (x0, x1, y0, y1) = (x(rx), x(rx + rw), y(ry), y(ry + rh));
            let z = depth_ndc(t.level, false);
            for (px, py) in [(x0, y0), (x1, y0), (x1, y1), (x0, y0), (x1, y1), (x0, y1)] {
                for v in [px, py, z] {
                    bytes.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        bind_array_buffer(gl, cache, objects.depth_buffer);
        unsafe {
            gl.c()
                .buffer_data_u8_slice(glow::ARRAY_BUFFER, &bytes, glow::DYNAMIC_DRAW)
        };
        objects.depth_tiles = Some((tiles.to_vec(), width, height, godot));
    }
    let DepthProgram::Ready(program) = objects.depth_program else {
        return;
    };
    if cache.program != Some(program) {
        unsafe { gl.c().use_program(Some(program)) };
        cache.program = Some(program);
    }
    set_color_mask(gl, cache, false);
    set_depth_mask(gl, cache, true);
    set_depth_test(gl, cache, true);
    unsafe {
        gl.c()
            .draw_arrays(glow::TRIANGLES, 0, (tiles.len() * 6) as i32)
    };
    set_color_mask(gl, cache, true);
    set_depth_mask(gl, cache, false);
    set_depth_test(gl, cache, false);
}

/// State is prepared once per call; only scissor and the issue vary by replay region.
fn issue_call(gl: &Gl, call: &Call, instances: Option<u32>) {
    unsafe {
        if let Some(count) = instances {
            gl.c().draw_elements_instanced(glow::TRIANGLES, call.index_count as i32,
                glow::UNSIGNED_INT, (call.first_index * 4) as i32, count as i32);
        } else {
            gl.c().draw_elements(glow::TRIANGLES, call.index_count as i32,
                glow::UNSIGNED_INT, (call.first_index * 4) as i32);
        }
    }
}

fn apply_scissor(gl: &Gl, cache: &mut Cache, rect: Option<[i32; 4]>, height: u32, godot: bool, stats: &mut ExecStats) {
    let Some(rect) = rect else { set_scissor_enabled(gl, cache, false); return; };

    set_scissor_enabled(gl, cache, true);
    let rect = if godot { gl_scissor_y_up(rect) } else { gl_scissor(rect, height) };
    if cache.scissor != Some(rect) {
        unsafe { gl.c().scissor(rect[0], rect[1], rect[2], rect[3]) };
        cache.scissor = Some(rect);
        stats.scissor_changes += 1;
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

/// The vertex stage's projection uniforms (`u_projection`, `u_godot_screen`, `u_screen`), for the
/// builtin program and every item-space program alike (they share [`VERT`]): `executor-webgl.ts`'s
/// projection, or Godot's `screen_transform` under [`ExecOptions::godot_orientation`].
/// An MSDF draw's fragment uniforms: `[px_range, outline]` and the `msdf-no-median` switch.
fn set_msdf(
    gl: &Gl,
    [u_msdf, u_no_median]: [&Option<glow::UniformLocation>; 2],
    [px_range, outline]: [f32; 2],
    state: MsdfState,
) {
    unsafe {
        gl.c().uniform_2_f32(u_msdf.as_ref(), px_range, outline);
        gl.c()
            .uniform_1_i32(u_no_median.as_ref(), i32::from(state.no_median));
    }
}

fn set_vertex_projection(
    gl: &Gl,
    [u_projection, u_godot_screen, u_screen]: [&Option<glow::UniformLocation>; 3],
    [a, b, c, d]: [f32; 4],
    godot: bool,
    screen: &[f32; 16],
) {
    unsafe {
        gl.c().uniform_4_f32(u_projection.as_ref(), a, b, c, d);
        gl.c()
            .uniform_1_i32(u_godot_screen.as_ref(), i32::from(godot));
        gl.c()
            .uniform_matrix_4_f32_slice(u_screen.as_ref(), false, screen);
    }
}

const _: () = {
    assert!(gl_enum::ZERO == glow::ZERO);
    assert!(gl_enum::ONE == glow::ONE);
    assert!(gl_enum::SRC_ALPHA == glow::SRC_ALPHA);
    assert!(gl_enum::ONE_MINUS_SRC_ALPHA == glow::ONE_MINUS_SRC_ALPHA);
    assert!(gl_enum::DST_ALPHA == glow::DST_ALPHA);
    assert!(gl_enum::DST_COLOR == glow::DST_COLOR);
    assert!(gl_enum::FUNC_ADD == glow::FUNC_ADD);
    assert!(gl_enum::FUNC_REVERSE_SUBTRACT == glow::FUNC_REVERSE_SUBTRACT);
};

/// `executor-webgl.ts`'s `BLEND_STATES`; `PremulAlpha` is MIX's GL state, `Disabled` no blending.
/// The state itself is [`blend_state`].
fn set_blend(gl: &Gl, cache: &mut Cache, blend: Blend, opaque: bool, stats: &mut ExecStats) {
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
    let state = blend_state(blend, opaque);
    if cache.blend_func != Some(state.func) {
        unsafe {
            gl.c()
                .blend_equation_separate(state.equation, state.equation);
            gl.c().blend_func_separate(
                state.src_rgb,
                state.dst_rgb,
                state.src_alpha,
                state.dst_alpha,
            );
        }
        cache.blend_func = Some(state.func);
        stats.blend_changes += 1;
    }
}

/// An upload's bytes in the list (arena or shared), or an `Invalid` naming texture `id`.
fn check_texture_bytes(list: &DrawList, op: &TextureOp, id: u32) -> Result<(), ExecError> {
    match op.byte_len() {
        Some((bytes, len)) if list.texture_data(bytes, len).is_none() => Err(ExecError::Invalid(
            format!("texture {id}: bytes outside texture_bytes/texture_shared"),
        )),
        _ => Ok(()),
    }
}

/// A validated upload's bytes (`validate` refused any op [`check_texture_bytes`] does not hold).
fn op_bytes<'a>(list: &'a DrawList, op: &TextureOp) -> &'a [u8] {
    op.byte_len()
        .and_then(|(bytes, len)| list.texture_data(bytes, len))
        .expect("validated texture bytes")
}

/// The GL internal format of a block-compressed upload, as Godot's GLES3 driver picks it
/// (`texture_storage.cpp` `_get_gl_image_and_format`).
fn compressed_internal_format(format: CompressedFormat) -> u32 {
    match format {
        CompressedFormat::Dxt1 => 0x83F1, // COMPRESSED_RGBA_S3TC_DXT1_EXT
        CompressedFormat::Dxt3 => 0x83F2, // COMPRESSED_RGBA_S3TC_DXT3_EXT
        CompressedFormat::Dxt5 => 0x83F3, // COMPRESSED_RGBA_S3TC_DXT5_EXT
        CompressedFormat::RgtcR => 0x8DBB, // COMPRESSED_RED_RGTC1_EXT
        CompressedFormat::RgtcRg => 0x8DBD, // COMPRESSED_RED_GREEN_RGTC2_EXT
        CompressedFormat::BptcRgba => 0x8E8C, // COMPRESSED_RGBA_BPTC_UNORM_EXT
        CompressedFormat::Etc2Rgb8 => 0x9274, // COMPRESSED_RGB8_ETC2
        CompressedFormat::Etc2Rgb8A1 => 0x9276, // COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2
        CompressedFormat::Etc2Rgba8 => 0x9278, // COMPRESSED_RGBA8_ETC2_EAC
        CompressedFormat::EacR11 => 0x9270, // COMPRESSED_R11_EAC
        CompressedFormat::EacR11Signed => 0x9271, // COMPRESSED_SIGNED_R11_EAC
        CompressedFormat::EacRg11 => 0x9272, // COMPRESSED_RG11_EAC
        CompressedFormat::EacRg11Signed => 0x9273, // COMPRESSED_SIGNED_RG11_EAC
        CompressedFormat::Astc4x4 => 0x93B0, // COMPRESSED_RGBA_ASTC_4x4_KHR
        CompressedFormat::Astc8x8 => 0x93B7, // COMPRESSED_RGBA_ASTC_8x8_KHR
    }
}

/// Godot's feature names for the compressed families a
/// WebGL context exposes, from its extension list: `s3tc` (`WEBGL_compressed_texture_s3tc`),
/// `bptc` (`EXT_texture_compression_bptc`), `rgtc` (`EXT_texture_compression_rgtc`), `etc2`
/// (`WEBGL_compressed_texture_etc`), `astc` (`WEBGL_compressed_texture_astc`), in that order.
pub fn gpu_families<'a>(extensions: impl IntoIterator<Item = &'a str>) -> Vec<&'static str> {
    let have: Vec<&str> = extensions.into_iter().collect();
    [
        ("s3tc", "WEBGL_compressed_texture_s3tc"),
        ("bptc", "EXT_texture_compression_bptc"),
        ("rgtc", "EXT_texture_compression_rgtc"),
        ("etc2", "WEBGL_compressed_texture_etc"),
        ("astc", "WEBGL_compressed_texture_astc"),
    ]
    .into_iter()
    .filter(|(_, ext)| have.contains(ext))
    .map(|(family, _)| family)
    .collect()
}
