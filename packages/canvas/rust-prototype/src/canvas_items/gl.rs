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
    FIRST_SAMPLER_UNIT, ITEM_TEXELS, ITEMS_PER_ROW, MAX_PROGRAM_SAMPLERS, Sabotage, gl_scissor,
    gl_scissor_y_up, godot_screen_transform, item_program_fragment, item_program_vertex,
    item_rows_for, item_upload_rects, msdf_fragment, plan_calls,
};
use crate::present::{
    ContextAttributes,
    canvas::{LossWatch, create_context},
};
use glow::HasContext;
use gsw_canvas_draw_list::{
    ANISOTROPY_TEXTURE, BLACK_TEXTURE, BUILTIN_PROGRAM, Binding, Blend, CompressedFormat,
    DRAW_GROUP_CLIP, DRAW_GROUP_COMPOSITE, DRAW_MSDF, DRAW_SCISSOR, DRAW_TO_BACK_BUFFER,
    DRAW_UNTEXTURED, Draw, DrawList, Format, NORMAL_TEXTURE, SCREEN_TEXTURE, Sampler, ScreenOp,
    ScreenOpKind, TRANSPARENT_TEXTURE, Target, TextureOp, UniformValue, Vertex, WHITE_TEXTURE,
    default_texture_texel, premultiplies,
};
use std::cell::Cell;
use std::collections::HashMap;

/// P3-TM: the default-texture ids beside [`WHITE_TEXTURE`], in `Objects::defaults` order.
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
// ExecOptions::godot_orientation: Godot's screen_transform as canvas.glsl applies it.
uniform bool u_godot_screen;
uniform mat4 u_screen;
uniform bool u_premultiply;
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
  vec2 design = vec2(t0.x * a_position.x + t0.z * a_position.y + t1.x,
                     t0.y * a_position.x + t0.w * a_position.y + t1.y);
  gl_Position = u_godot_screen ? u_screen * vec4(design, 0.0, 1.0)
                               : vec4(design * u_projection.xy + u_projection.zw, 0.0, 1.0);
  v_uv = a_uv;
  // Interpolated STRAIGHT, as Godot's color_interp is; premultiplied per fragment.
  v_color = a_color;
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
    /// The present program's `u_flip_rows` (G7t: Godot's orientation).
    flip_rows: Option<i32>,
    /// The builtin MSDF program's projection and [`MsdfState`] (G7tm).
    msdf_projection: Option<(u32, u32, bool)>,
    msdf_state: Option<MsdfState>,
    /// Texture and sampler object on each item-space sampler unit.
    units: [Option<(glow::Texture, glow::Sampler)>; 16],
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
    /// Active `sampler2D` uniforms (beyond `TEXTURE`) and the unit each samples.
    sampler_units: Vec<(String, u32)>,
    /// Target size and [`ExecOptions::godot_orientation`] the vertex uniforms were set for.
    projection: Option<(u32, u32, bool)>,
    premultiply_out: Option<bool>,
    /// The (binding slot, version) whose values GL holds.
    applied: Option<(u32, u64)>,
    /// `gsw_msdf_on`, `gsw_msdf`, `gsw_msdf_no_median` (G7tm).
    u_msdf_on: Option<glow::UniformLocation>,
    u_msdf: Option<glow::UniformLocation>,
    u_msdf_no_median: Option<glow::UniformLocation>,
    msdf_state: Option<(bool, MsdfState)>,
    /// P3-ST: `SCREEN_PIXEL_SIZE` (declared by a module that reads SCREEN_UV or it) and the target
    /// size it was set for.
    u_screen_pixel_size: Option<glow::UniformLocation>,
    screen_pixel_size: Option<(u32, u32)>,
    /// P3-TM: `TIME` (declared by a module whose code reads it) and the bits of the
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

/// The builtin program's MSDF variant: [`VERT`] with [`msdf_fragment`] (G7tm).
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
    /// P3-VX: the vertex module, for a program with its own vertex stage.
    vertex: Option<String>,
    compiled: Option<CompiledItem>,
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
    msdf: MsdfProgram,
    u_projection: Option<glow::UniformLocation>,
    u_godot_screen: Option<glow::UniformLocation>,
    u_screen: Option<glow::UniformLocation>,
    u_premultiply: Option<glow::UniformLocation>,
    u_texel_premultiply: Option<glow::UniformLocation>,
    present_program: glow::Program,
    u_flip_rows: Option<glow::UniformLocation>,
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
    /// P3-TM: GLES3's other default textures, in [`DEFAULT_TEXTURE_IDS`] order (1x1, nearest, as
    /// `white`).
    defaults: [glow::Texture; 4],
    /// Index `wrap · 2 + linear` (wrap 0 clamp, 1 repeat, 2 mirror).
    samplers: [glow::Sampler; 6],
    target: Option<TargetObjects>,
    /// P3-ST: the back buffer, made at the first screen copy for the target's size and format.
    screen: Option<ScreenObjects>,
}

/// P3-ST: Godot 4.5.1's GLES3 render-target back buffer (`_create_render_target_backbuffer`,
/// texture_storage.cpp:2290-2337): the target's internal format, `max(1, mips(w, h) - 4)` levels
/// (the smallest no smaller than about 32 px), each half the previous (floor, at least 1), sampled
/// linear / linear-mipmap-linear / clamp-to-edge, with MAX_LEVEL 0 until a mip chain is built.
struct ScreenObjects {
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
    /// CG3: the group owners' program ([`DRAW_GROUP_CLIP`], [`DRAW_GROUP_COMPOSITE`]).
    group: GroupProgram,
}

/// CG3: [`VERT`] with [`GROUP_FRAG`]: Godot's default clip-children and canvas-group shaders over
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

/// CG3: the fragment stage of a group owner's draw: the builtin draw's colour (straight: the
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
            // CG3: the group program's fixed uniforms (the back buffer is this target's size).
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

/// P3-ST, CG3: one [`ScreenOp`] before a draw (Godot's `render_target_copy_to_back_buffer`,
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
    let Some(target) = objects.target.as_ref() else {
        return;
    };
    let target_fb = target.framebuffer;
    let present_vertex_array = objects.present_vertex_array;
    let linear_clamp = objects.samplers[sampler_index(Sampler::LINEAR | Sampler::CLAMP)];
    let Some(screen) = ensure_screen(gl, cache, &mut objects.screen, target) else {
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

/// Compile an item-space program: the builtin vertex stage (its modulate passed straight), or
/// [`item_program_vertex`] around `vertex` (P3-VX), and [`item_program_fragment`] around `module`.
/// Leaves no program bound.
fn compile_item(
    gl: &glow::Context,
    module: &str,
    vertex: Option<&str>,
) -> Result<CompiledItem, String> {
    let program = match vertex {
        Some(v) => compile(gl, &item_program_vertex(v), &item_program_fragment(module))?,
        None => compile(gl, VERT, &item_program_fragment(module))?,
    };
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
            // P3-VX: the vertex stage's canvas matrices are binding values like any uniform.
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
            gl.uniform_1_i32(
                gl.get_uniform_location(program, "u_texture").as_ref(),
                UNIT_DRAW as i32,
            );
            gl.uniform_1_i32(
                gl.get_uniform_location(program, "u_items").as_ref(),
                UNIT_ITEMS as i32,
            );
            // G7tm: the MSDF variant. Its vertex stage passes the modulate straight; the fragment
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
                present_program,
                u_flip_rows,
                present_vertex_array,
                vertex_array,
                vertex_buffer,
                index_buffer,
                vertex_capacity: INITIAL_VERTICES,
                index_capacity: INITIAL_INDICES,
                item_texture,
                item_rows: 1,
                white,
                defaults,
                samplers,
                target: None,
                screen: None,
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
    /// Item-space programs by id ([`CanvasItemsExecutor::define_program`]).
    programs: HashMap<u32, ItemProgram>,
    /// A version per binding slot, bumped whenever the list marks it dirty: a program re-sends
    /// its uniforms when the (slot, version) it holds differs.
    binding_versions: Vec<u64>,
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
    /// G8kp: the compressed families this context exposes ([`gpu_families`]), the `gpu_formats` a
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
            objects: Some(objects),
            cache: Cache::default(),
            textures: HashMap::new(),
            calls: Vec::new(),
            needs_full: true,
            max_side,
            fence: None,
            frames: 0,
            planned_calls: 0,
            programs: HashMap::new(),
            binding_versions: Vec::new(),
            version_counter: 0,
        })
    }

    /// Register item-space program `id` (> 0): the module `@godot-scene-web/effects`'s
    /// `transpileGodotItemShader` emits, compiled at once around [`item_program_fragment`]. A
    /// compile or link failure is returned with GL's log and registers nothing. Redefining an id
    /// replaces its program. Programs survive a restored context (recompiled from the module).
    pub fn define_program(&mut self, id: u32, module: &str) -> Result<(), String> {
        self.define_program_with_vertex(id, module, None)
    }

    /// [`define_program`](Self::define_program) for a program with its own vertex stage (P3-VX):
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
        let compiled = compile_item(&self.gl.raw, module, vertex);
        self.cache.program = None;
        let compiled = compiled?;
        if let Some(old) = self.programs.insert(
            id,
            ItemProgram {
                module: module.to_string(),
                vertex: vertex.map(str::to_string),
                compiled: Some(compiled),
            },
        ) && let Some(c) = old.compiled
        {
            unsafe { self.gl.raw.delete_program(c.program) };
        }
        Ok(())
    }

    /// Forget item-space program `id`; draws naming a binding of it are skipped from now on.
    pub fn free_program(&mut self, id: u32) {
        if let Some(p) = self.programs.remove(&id)
            && let Some(c) = p.compiled
            && !self.loss.lost()
        {
            unsafe { self.gl.raw.delete_program(c.program) };
            if self.cache.program == Some(c.program) {
                self.cache.program = None;
            }
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
                    // Item-space programs come back from their modules (they compiled before).
                    for p in self.programs.values_mut() {
                        p.compiled =
                            compile_item(&self.gl.raw, &p.module, p.vertex.as_deref()).ok();
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
        self.version_bindings(list);
        let mut calls = std::mem::take(&mut self.calls);
        let counts = {
            let textures = &self.textures;
            let programs = &self.programs;
            let known_texture = |id: u32| {
                id == WHITE_TEXTURE
                    || DEFAULT_TEXTURE_IDS.contains(&id)
                    || textures.contains_key(&id)
            };
            plan_calls(
                list,
                known_texture,
                |program: u32| {
                    list.bindings
                        .get(program as usize - 1)
                        .is_some_and(|b: &Binding| {
                            programs
                                .get(&b.program)
                                .is_some_and(|p| p.compiled.is_some())
                                && b.samplers
                                    .iter()
                                    .all(|s| s.texture == SCREEN_TEXTURE || known_texture(s.texture))
                        })
                },
                &mut calls,
            )
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
                TextureOp::UploadCompressed {
                    id,
                    width,
                    height,
                    format,
                    offset,
                    len,
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
                    if u64::from(offset) + u64::from(len) > list.texture_bytes.len() as u64 {
                        return Err(ExecError::Invalid(format!(
                            "texture {id}: bytes outside texture_bytes"
                        )));
                    }
                }
            }
        }
        Ok(())
    }

    /// Bump the version of every binding slot the list marks dirty (every slot on a full upload).
    fn version_bindings(&mut self, list: &DrawList) {
        let n = list.bindings.len();
        let all = list.dirty.all || self.binding_versions.len() != n;
        self.binding_versions.resize(n, 0);
        let mut bump = |slot: usize, versions: &mut Vec<u64>| {
            self.version_counter += 1;
            versions[slot] = self.version_counter;
        };
        if all {
            for slot in 0..n {
                bump(slot, &mut self.binding_versions);
            }
        } else {
            for &(start, end) in list.dirty.bindings.as_slice() {
                for slot in start as usize..(end as usize).min(n) {
                    bump(slot, &mut self.binding_versions);
                }
            }
        }
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
                    let straight =
                        &list.texture_bytes[start..start + 4 * width as usize * height as usize];
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
                TextureOp::UploadCompressed {
                    id,
                    width,
                    height,
                    format,
                    offset,
                    len,
                } => {
                    // G8kp (texture-delivery-design.md Q6 "GSW"): a `block` variant's level 0, in
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
                    let start = offset as usize;
                    let bytes = &list.texture_bytes[start..start + len as usize];
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
        let sabotage = self.options.sabotage;
        let gl = &self.gl;
        let cache = &mut self.cache;
        let (width, height) = (target.width, target.height);
        let target_fb = target.framebuffer;

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

        // `present.ts`'s `toClip`: the f64 quotient stored as f32.
        let projection = [
            (2.0 / f64::from(width)) as f32,
            (-2.0 / f64::from(height)) as f32,
            -1.0,
            1.0,
        ];
        // ExecOptions::godot_orientation: Godot's screen_transform instead (G7t).
        let godot = self.options.godot_orientation;
        let screen = godot_screen_transform(width, height);
        bind_vertex_array(gl, cache, objects.vertex_array);
        let Some(objects) = self.objects.as_mut() else {
            return;
        };

        // P3-ST, CG3: the next screen operation to run (operations precede the draw they name).
        let mut next_op = 0usize;
        for call in calls.iter() {
            // The back-buffer operations GLES3 makes before this call's first draw (those of a
            // draw `plan_calls` skipped run here too, in order).
            let mut ran_ops = false;
            while let Some(op) = list.screen_ops.get(next_op) {
                if op.before > call.draw {
                    break;
                }
                screen_op(gl, cache, objects, op, godot, stats);
                next_op += 1;
                ran_ops = true;
            }
            if ran_ops {
                bind_vertex_array(gl, cache, objects.vertex_array);
            }
            let n = self.planned_calls;
            self.planned_calls += 1;
            if self.options.sabotage == Some(Sabotage::DropDraws) && n % 2 == 1 {
                stats.calls_dropped += 1;
                continue;
            }
            let draw = &list.draws[call.draw as usize];
            // CG3: an open canvas group's draws go into the back buffer, blended as into a
            // transparent target; every other draw into the target.
            let to_back_buffer = draw.flags & DRAW_TO_BACK_BUFFER != 0;
            let opaque = list.target.opaque && !to_back_buffer;
            if to_back_buffer {
                let Some(bb) = objects.screen.as_mut() else {
                    // No back buffer (a target of 40 px or less): GLES3 has none to draw into.
                    stats.calls_dropped += 1;
                    continue;
                };
                bind_draw_framebuffer(gl, cache, Some(bb.framebuffer));
                attach_screen_level(gl, bb, 0);
            } else {
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
                // CG3: a group owner through Godot's default clip-children or canvas-group shader.
                let Some(bb) = objects.screen.as_mut() else {
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
                // G7tm: the builtin's MSDF variant.
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
                // G7tm: an MSDF draw through an item-space program (canvas.glsl's MSDF branch
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
                let version = self
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
                    for u in &binding.uniforms {
                        if let Some((location, utype, size)) = item.uniforms.get(&*u.name) {
                            set_uniform(gl, location, *utype, *size, &u.value);
                        }
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
                        // P3-ST: the back buffer, with its own fixed sampler; CG3: white for a draw
                        // into the back buffer (canvas_begin binds white there).
                        Some(s) if s.texture == SCREEN_TEXTURE => match objects.screen.as_ref() {
                            Some(screen) if !to_back_buffer => (screen.texture, screen.sampler),
                            _ => (objects.white, objects.samplers[0]),
                        },
                        // P3-TM: GLES3's default for an unset hinted sampler.
                        Some(s) if DEFAULT_TEXTURE_IDS.contains(&s.texture) => {
                            let at = DEFAULT_TEXTURE_IDS
                                .iter()
                                .position(|id| *id == s.texture)
                                .unwrap_or(0);
                            (objects.defaults[at], objects.samplers[0])
                        }
                        Some(s) if s.texture != WHITE_TEXTURE => {
                            match self.textures.get(&s.texture) {
                                Some(t) => (*t, objects.samplers[sampler_index(s.sampler)]),
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
            if draw.flags & DRAW_SCISSOR != 0 {
                set_scissor_enabled(gl, cache, true);
                let scissor = if godot {
                    gl_scissor_y_up(draw.scissor)
                } else {
                    gl_scissor(draw.scissor, height)
                };
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
            // G7o4: the texture and sampler are the run's first textured draw's.
            let tex_draw = &list.draws[call.texture_draw as usize];
            // An all-untextured call binds the white texel too: its fragments ignore the texture,
            // but leaving a stale binding in place (the cache is not the whole GL state) dropped
            // a gate 4e MSDF frame's draws after an atlas re-upload (G7o4's g7-4 run).
            if tex_draw.flags & DRAW_UNTEXTURED != 0 || tex_draw.texture == WHITE_TEXTURE {
                // A 1×1 white texel samples white under every filter and wrap: keep the sampler.
                bind_draw_texture_with(gl, cache, objects.white, stats);
            } else if let Some(texture) = self.textures.get(&tex_draw.texture) {
                bind_draw_texture_with(gl, cache, *texture, stats);
                let sampler = objects.samplers[sampler_index(tex_draw.sampler)];
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
            for (_, p) in self.programs.drain() {
                if let Some(c) = p.compiled {
                    gl.delete_program(c.program);
                }
            }
            if let Some(o) = self.objects.take() {
                gl.delete_program(o.program);
                gl.delete_program(o.msdf.program);
                gl.delete_program(o.present_program);
                gl.delete_vertex_array(o.present_vertex_array);
                gl.delete_vertex_array(o.vertex_array);
                gl.delete_buffer(o.vertex_buffer);
                gl.delete_buffer(o.index_buffer);
                gl.delete_texture(o.item_texture);
                gl.delete_texture(o.white);
                for texture in o.defaults {
                    gl.delete_texture(texture);
                }
                for sampler in o.samplers {
                    gl.delete_sampler(sampler);
                }
                if let Some(t) = o.target {
                    gl.delete_framebuffer(t.framebuffer);
                    gl.delete_texture(t.texture);
                }
                if let Some(screen) = o.screen {
                    delete_screen(gl, screen);
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

/// `executor-webgl.ts`'s `BLEND_STATES`; `PremulAlpha` is MIX's GL state, `Disabled` no blending.
/// On an `opaque` target (Godot's non-transparent render target) every blend keeps the
/// destination's alpha, `GL_ZERO, GL_ONE`, as Godot's GLES3 canvas renderer sets it there
/// (rasterizer_canvas_gles3.cpp:755-798).
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
    let (mut func, equation_rgb, src_rgb, dst_rgb, mut src_alpha, mut dst_alpha) = match blend {
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
    if opaque {
        src_alpha = glow::ZERO;
        dst_alpha = glow::ONE;
        func |= 0x10;
    }
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

/// G8kp: the GL internal format of a block-compressed upload, as Godot's GLES3 driver picks it
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

/// G8kp (texture-delivery-design.md Q3): Godot's feature names for the compressed families a
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
