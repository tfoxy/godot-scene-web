//! `canvas-items`: an executor for `gsw-canvas-draw-list`'s packed CanvasItem [`DrawList`] on WebGL2
//! through `glow`, with no wgpu.
//!
//! The browser half is [`CanvasItemsExecutor`] (wasm32). One frame is
//! [`CanvasItemsExecutor::execute`], then the caller's [`DrawList::consumed`]:
//!
//! 1. the list's [`TextureOp`](gsw_canvas_draw_list::TextureOp)s, in order: `texImage2D` of straight
//!    RGBA8 straight from a view of `texture_bytes` or of a shared payload, or a delete;
//! 2. the dirty uploads, each straight from a view of the list's own memory: item rows
//!    (`texSubImage2D` into an RGBA32F data texture, three texels per item, [`ITEMS_PER_ROW`] items
//!    per texture row), vertex and index ranges (`bufferSubData`). `dirty.all`, a grown array or a
//!    restored context uploads everything;
//! 3. a clear of the offscreen target (`list.target`: RGB10_A2 or RGBA8) to the PREMULTIPLIED
//!    `target.clear` (the list's clear colour is straight, the target holds premultiplied colour);
//! 4. every [`Draw`] in order, merging only ADJACENT draws that
//!    [`mergeable`](gsw_canvas_draw_list::mergeable) allows ([`plan_calls`]); a run that takes in
//!    [`DRAW_UNTEXTURED`](gsw_canvas_draw_list::DRAW_UNTEXTURED) draws binds its textured draws'
//!    texture, and the builtin program draws an
//!    [`ITEM_UNTEXTURED`](gsw_canvas_draw_list::ITEM_UNTEXTURED) item's fragments as the white
//!    texel;
//! 5. the blit to the canvas with the TypeScript stage's `StageTarget` semantics (`packages/canvas/src/present.ts`):
//!    RGB10_A2 is a `texelFetch` draw writing `floor(c·255 + 0.5)/255`, never `blitFramebuffer`;
//!    RGBA8 is a `blitFramebuffer`;
//! 6. a fence ([`CanvasItemsExecutor::poll_fence`]), since many mobile GPUs have no timer query.
//!
//! The colour contract is the TypeScript executor's textured-mesh path (`executor-webgl.ts`,
//! `TEXTURED_MESH_FRAGMENT_SRC`): `fragColor = texel * colour * tint`, the texel premultiplied after
//! filtering, the straight vertex colour premultiplied per fragment and the item modulate
//! premultiplied; a [`Blend::PremulAlpha`] draw uses all three as given (modulate straight) under
//! MIX's GL state. Positions are item-local; the vertex shader fetches its item's row and applies
//! `xform`, then the design → clip projection `[2/w, -2/h, -1, 1]` of the target size.
//!
//! This module also holds the target-independent planning ([`plan_calls`], [`item_upload_rects`])
//! so it is unit-tested natively.
use gsw_canvas_draw_list::{
    BUILTIN_PROGRAM, Blend, DrawList,
};

#[cfg(test)]
use gsw_canvas_draw_list::{DRAW_UNTEXTURED, Draw, WHITE_TEXTURE};

#[cfg(target_arch = "wasm32")]
mod gl;
#[cfg(any(target_arch = "wasm32", test))]
mod group_depth;
#[cfg(any(target_arch = "wasm32", test))]
mod program_poll;
#[cfg(any(target_arch = "wasm32", test))]
mod item_shaders;
#[cfg(target_arch = "wasm32")]
pub use gl::{gpu_families, CanvasItemsExecutor, ContextState, ExecError, FenceState};
#[cfg(all(target_arch = "wasm32", feature = "canvas-items-test"))]
pub mod test_harness;

/// The GL enums [`blend_state`] names, as numbers so the choice is testable off wasm32 (glow is a
/// wasm-only dependency); `gl.rs` asserts each equals glow's at compile time.
pub(crate) mod gl_enum {
    pub const ZERO: u32 = 0;
    pub const ONE: u32 = 1;
    pub const SRC_ALPHA: u32 = 0x0302;
    pub const ONE_MINUS_SRC_ALPHA: u32 = 0x0303;
    pub const DST_ALPHA: u32 = 0x0304;
    pub const DST_COLOR: u32 = 0x0306;
    pub const FUNC_ADD: u32 = 0x8006;
    pub const FUNC_REVERSE_SUBTRACT: u32 = 0x800B;
}

/// One blend unit setting: the cache key, the equation (both channels) and the four factors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BlendState {
    pub(crate) func: u8,
    pub(crate) equation: u32,
    pub(crate) src_rgb: u32,
    pub(crate) dst_rgb: u32,
    pub(crate) src_alpha: u32,
    pub(crate) dst_alpha: u32,
}

/// Godot's GLES3 canvas blend switch (rasterizer_canvas_gles3.cpp:755-798) for `blend`, with the
/// colour premultiplied as [`premultiplies`] says: `GL_SRC_ALPHA` over a straight colour equals
/// `GL_ONE` over the premultiplied one, but the alpha channel is never premultiplied, so its factor
/// stays `GL_SRC_ALPHA`. On a transparent target `Add`/`Sub` run alpha through the same factors and
/// equation as colour (`Sub` removes alpha, as Godot's does); on an `opaque` target every blend
/// keeps the destination's alpha, `GL_ZERO, GL_ONE`.
pub(crate) fn blend_state(blend: Blend, opaque: bool) -> BlendState {
    let (mut func, equation, src_rgb, dst_rgb, mut src_alpha, mut dst_alpha) = match blend {
        Blend::Add => (
            1u8,
            gl_enum::FUNC_ADD,
            gl_enum::ONE,
            gl_enum::ONE,
            gl_enum::SRC_ALPHA,
            gl_enum::ONE,
        ),
        Blend::Sub => (
            2,
            gl_enum::FUNC_REVERSE_SUBTRACT,
            gl_enum::ONE,
            gl_enum::ONE,
            gl_enum::SRC_ALPHA,
            gl_enum::ONE,
        ),
        Blend::Mul => (
            3,
            gl_enum::FUNC_ADD,
            gl_enum::DST_COLOR,
            gl_enum::ZERO,
            gl_enum::DST_ALPHA,
            gl_enum::ZERO,
        ),
        _ => (
            0,
            gl_enum::FUNC_ADD,
            gl_enum::ONE,
            gl_enum::ONE_MINUS_SRC_ALPHA,
            gl_enum::ONE,
            gl_enum::ONE_MINUS_SRC_ALPHA,
        ),
    };
    if opaque {
        src_alpha = gl_enum::ZERO;
        dst_alpha = gl_enum::ONE;
        func |= 0x10;
    }
    BlendState {
        func,
        equation,
        src_rgb,
        dst_rgb,
        src_alpha,
        dst_alpha,
    }
}

/// Items per row of the item data texture. Its width is `3 · ITEMS_PER_ROW` texels (1536, inside
/// WebGL2's guaranteed 2048), so item `i` is texels `3·(i % 512) .. +3` of row `i / 512`, and a
/// run of whole rows is one contiguous slice of `DrawList::items`.
pub const ITEMS_PER_ROW: u32 = 512;
/// RGBA32F texels per item (an `Item` is 48 bytes).
pub const ITEM_TEXELS: u32 = 3;

/// Deliberate faults for proving the pixel tests. Each must make the executor's own pixel test fail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sabotage {
    /// Skip every second merged draw call the executor plans (the 2nd, 4th, …, counted across
    /// frames since creation).
    DropDraws,
    /// Skip uploading dirty item rows unless `dirty.all`: a transform-only frame draws stale rows.
    StaleItemRow,
    /// `premultiplied-upload`: textures are premultiplied (8-bit) on upload
    /// and sampled as premultiplied, so linear filtering mixes premultiplied texels where Godot
    /// filters straight ones and premultiplies after.
    PremultipliedUpload,
    /// `msdf-no-median`: an MSDF draw takes the smallest of the three distances instead of
    /// their median. Wherever the channels disagree (every edge the field colours with two of the
    /// three channels) coverage drops, and it never rises, so only drawn ink changes.
    MsdfNoMedian,
    /// Test-only: retain stale colour under partial replay.
    DamageNoScissorClear,
    /// Test-only: skip all back-buffer producers and screen operations during partial replay.
    DamageSkipBackProducers,
}

impl Sabotage {
    /// `"drop-draws"`, `"stale-item-row"`, `"premultiplied-upload"` or `"msdf-no-median"`;
    /// `""`/`"none"` is no sabotage; anything else is refused.
    pub fn parse(name: &str) -> Result<Option<Sabotage>, String> {
        match name {
            "" | "none" => Ok(None),
            "drop-draws" => Ok(Some(Sabotage::DropDraws)),
            "stale-item-row" => Ok(Some(Sabotage::StaleItemRow)),
            "premultiplied-upload" => Ok(Some(Sabotage::PremultipliedUpload)),
            "msdf-no-median" => Ok(Some(Sabotage::MsdfNoMedian)),
            "damage-no-scissor-clear" => Ok(Some(Sabotage::DamageNoScissorClear)),
            "damage-skip-back-producers" => Ok(Some(Sabotage::DamageSkipBackProducers)),
            other => Err(format!("unknown canvas-items sabotage {other:?}")),
        }
    }
}

/// One surface pass of [`CanvasItemsExecutor::execute_frame`] (render-stream/16 viewport
/// surfaces): `list` draws into the offscreen target its [`gsw_canvas_draw_list::Target::surface`]
/// names.
#[derive(Clone, Copy)]
pub struct SurfacePass<'a> {
    pub list: &'a gsw_canvas_draw_list::DrawList,
    /// Clear the target before drawing (Godot's clear due this frame). A clear-`never` surface
    /// keeps what earlier passes drew; a target (re)allocated this pass starts transparent.
    pub clear: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExecOptions {
    /// Plan and execute retained damage, including partial redraws.
    pub damage: bool,
    pub sabotage: Option<Sabotage>,
    /// Draw the target the way Godot's GLES3 renderer draws a 2D render target: design y up the
    /// GL window (row 0 at the bottom is design row 0), through `screen_transform` exactly as
    /// `canvas_render_items` builds it (`translate_local(-w/2, -h/2)` then `scale(2/w, 2/h)`, in
    /// float32) and applied as a `mat4` product (canvas.glsl). GL's fill rule then breaks ties of
    /// edges exactly on pixel centres the way the engine does (a hexagon's
    /// edges, a LineEdit's StyleBoxFlat). Shots read the target without a row swap and the present draw
    /// flips it onto the canvas. Off by default, which keeps `executor-webgl.ts`'s orientation.
    pub godot_orientation: bool,
}

/// One `execute`'s counters: a fixed `#[repr(C)]` block of u32s, so a wasm caller can read it
/// through a `Uint32Array` view ([`ExecStats::as_words`]). Every count is for that call only.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExecStats {
    /// `list.draws.len()`.
    pub draws: u32,
    /// `drawElements` calls issued.
    pub draw_calls: u32,
    /// Draws folded into the call of the draw before them.
    pub draws_merged: u32,
    /// Draws refused: unknown texture id, unknown blend, a program other than the builtin, or an
    /// index range outside `list.indices`. Each also ends the merge run it would have joined.
    pub draws_skipped: u32,
    /// Merged calls not issued because of [`Sabotage::DropDraws`].
    pub calls_dropped: u32,
    /// `texImage2D` uploads from `list.texture_ops`, and their bytes.
    pub texture_uploads: u32,
    pub texture_upload_bytes: u32,
    pub texture_frees: u32,
    /// Item rows (one per item) uploaded, and their bytes (48 each).
    pub item_rows: u32,
    pub item_bytes: u32,
    pub vertex_bytes: u32,
    pub index_bytes: u32,
    /// `texSubImage2D` / `bufferSubData` calls for the above.
    pub upload_calls: u32,
    /// GL state changes the state cache let through.
    pub scissor_changes: u32,
    pub blend_changes: u32,
    pub texture_binds: u32,
    pub sampler_binds: u32,
    /// Every GL call this `execute` issued, the blit and fence included.
    pub gl_calls: u32,
    /// 1 when this call re-created the executor's objects after `webglcontextrestored`.
    pub restored: u32,
    /// 1 when this call issued a fence (none is issued while one is still pending).
    pub fence_issued: u32,
    /// Item-space program switches (`useProgram` of a program other than the builtin).
    pub program_binds: u32,
    /// Bindings whose uniform values were (re)sent to their program.
    pub binding_uploads: u32,
    /// Back-buffer copies and clears (`ScreenOpKind::Copy`, `ScreenOpKind::Clear`)
    /// and mip chains built (`ScreenOpKind::Mipmaps`, or a copy's).
    pub screen_copies: u32,
    pub screen_mipmaps: u32,
    /// Target tiles and dead group cells drawn into depth buffers, and calls tested against them.
    pub depth_tiles: u32,
    pub depth_tested: u32,
    /// Full-redraw calls planned (zero when the frame is skipped).
    pub planned_calls: u32,
    /// 0 off, 1 full, 2 partial executed, 3 skip.
    pub damage_mode: u32,
    /// Planner reason index + 1; executor invalidation reasons start at 100.
    pub damage_reason: u32,
    pub damage_regions: u32,
    pub damage_permille: u32,
    pub damage_changed: u32,
    pub damage_us: u32,
    /// Calls actually issued across partial replay regions.
    pub damage_calls: u32,
    /// Back-buffer operations omitted because no replayed reader consumes their output.
    pub damage_ops_skipped: u32,
}

impl ExecStats {
    pub const WORDS: usize = std::mem::size_of::<ExecStats>() / 4;

    pub fn as_words(&self) -> &[u32; Self::WORDS] {
        // SAFETY: `#[repr(C)]` of u32 fields only: no padding, size 4·WORDS, alignment 4.
        unsafe { &*(self as *const ExecStats as *const [u32; Self::WORDS]) }
    }

    /// Whether this frame violates the receiver's expected draw-call count.
    pub fn parity_violation(&self, expected: u32) -> bool {
        // Partial replay can issue each planned call once per region, so only Off/Full
        // compare issued calls. The partial-vs-full pixel oracle checks partial replay.
        self.damage_mode != 3
            && (self.planned_calls != expected
                || (self.damage_mode <= 1 && self.draw_calls != self.planned_calls))
    }

    /// The counters as a JSON object (evidence and tests; not for the frame path).
    pub fn to_json(&self) -> String {
        format!(
            concat!(
                "{{\"draws\":{},\"drawCalls\":{},\"drawsMerged\":{},\"drawsSkipped\":{},",
                "\"callsDropped\":{},\"textureUploads\":{},\"textureUploadBytes\":{},",
                "\"textureFrees\":{},\"itemRows\":{},\"itemBytes\":{},\"vertexBytes\":{},",
                "\"indexBytes\":{},\"uploadCalls\":{},\"scissorChanges\":{},\"blendChanges\":{},",
                "\"textureBinds\":{},\"samplerBinds\":{},\"glCalls\":{},\"restored\":{},",
                "\"fenceIssued\":{},\"programBinds\":{},\"bindingUploads\":{},",
                "\"screenCopies\":{},\"screenMipmaps\":{},\"depthTiles\":{},\"depthTested\":{},\"plannedCalls\":{},\"damageMode\":{},\"damageReason\":{},",
                "\"damageRegions\":{},\"damagePermille\":{},\"damageChanged\":{},\"damageUs\":{},\"damageCalls\":{},\"damageOpsSkipped\":{}}}"
            ),
            self.draws,
            self.draw_calls,
            self.draws_merged,
            self.draws_skipped,
            self.calls_dropped,
            self.texture_uploads,
            self.texture_upload_bytes,
            self.texture_frees,
            self.item_rows,
            self.item_bytes,
            self.vertex_bytes,
            self.index_bytes,
            self.upload_calls,
            self.scissor_changes,
            self.blend_changes,
            self.texture_binds,
            self.sampler_binds,
            self.gl_calls,
            self.restored,
            self.fence_issued,
            self.program_binds,
            self.binding_uploads,
            self.screen_copies,
            self.screen_mipmaps,
            self.depth_tiles,
            self.depth_tested,
            self.planned_calls,
            self.damage_mode,
            self.damage_reason,
            self.damage_regions,
            self.damage_permille,
            self.damage_changed,
            self.damage_us,
            self.damage_calls,
            self.damage_ops_skipped,

        )
    }
}

/// Godot 4.5.1's MSDF coverage, as `canvas.glsl` computes it for a rect with
/// `INSTANCE_FLAGS_USE_MSDF` (drivers/gles3/shaders/canvas.glsl:562-564 `msdf_median`, 601-618),
/// statement for statement. `msdf` is the draw's `[px_range, outline]`
/// (`gsw_canvas_draw_list::Draw::msdf`, Godot's `read_draw_data_ninepatch_margins.xy`, which
/// rasterizer_canvas_gles3.cpp:999-1004 fills from the rect's `px_range` and `outline`). The
/// result is what Godot multiplies into `color.a`. `no_median` is [`Sabotage::MsdfNoMedian`].
pub const MSDF_COVERAGE: &str = r#"
float gsw_msdf_median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}
float gsw_msdf_coverage(sampler2D color_texture, vec2 uv, vec2 msdf, bool no_median) {
  float px_range = msdf.x;
  float outline_thickness = msdf.y;
  vec4 msdf_sample = texture(color_texture, uv);
  vec2 msdf_size = vec2(textureSize(color_texture, 0));
  vec2 dest_size = vec2(1.0) / fwidth(uv);
  float px_size = max(0.5 * dot((vec2(px_range) / msdf_size), dest_size), 1.0);
  float d = no_median ? min(msdf_sample.r, min(msdf_sample.g, msdf_sample.b))
                      : gsw_msdf_median(msdf_sample.r, msdf_sample.g, msdf_sample.b);
  if (outline_thickness > 0.0) {
    float cr = clamp(outline_thickness, 0.0, (px_range / 2.0) - 1.0) / px_range;
    d = min(d, msdf_sample.a);
    return clamp((d - 0.5 + cr) * px_size, 0.0, 1.0);
  }
  return clamp((d - 0.5) * px_size + 0.5, 0.0, 1.0);
}
"#;

/// The builtin program's fragment stage for a [`DRAW_MSDF`](gsw_canvas_draw_list::DRAW_MSDF) draw
/// Godot's order (canvas.glsl:566-618, 716): `color = color_interp` (the vertex colour ×
/// the modulate, straight), then `color.a = coverage · color.a`; the texel is not multiplied in.
/// The vertex stage passes the modulate straight (`u_premultiply` 0) and the colour is
/// premultiplied last, for every blend but `premul_alpha` (`u_premultiply_out`), so the blend
/// states are the builtin's.
pub fn msdf_fragment() -> String {
    format!(
        r#"#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_texture;
uniform bool u_premultiply_out;
uniform vec2 u_msdf;
uniform bool u_msdf_no_median;
in vec2 v_uv;
in vec4 v_color;
flat in vec4 v_tint;
out vec4 fragColor;
{MSDF_COVERAGE}
void main() {{
  vec4 color = v_color * v_tint;
  color.a = gsw_msdf_coverage(u_texture, v_uv, u_msdf, u_msdf_no_median) * color.a;
  fragColor = u_premultiply_out ? vec4(color.rgb * color.a, color.a) : color;
}}
"#
    )
}

/// The fragment stage of an item-space program: `canvas.glsl`'s order (Godot 4.5.1,
/// drivers/gles3/shaders/canvas.glsl:566-717) around the program module, which declares its
/// uniforms and samplers, its helpers, and `void godot_item_fragment(inout vec4 COLOR, in vec2 UV)`
/// (`@godot-scene-web/effects`'s `transpileGodotItemShader`):
///
/// ```text
/// color = color_interp * texture(color_texture, uv)   (straight: vertex colour × item modulate)
///   or, for an MSDF draw, color.a = coverage · color.a   (canvas.glsl:601-618)
/// fragment(COLOR = color, UV = uv)
/// color *= canvas_modulation                           (gsw_post_modulate; white when unshaded)
/// ```
///
/// The output is premultiplied for every blend but `premul_alpha` (`gsw_premultiply_out`), as the
/// builtin program's is, so the blend states are the builtin's.
pub fn item_program_fragment(module: &str) -> String {
    format!(
        r#"#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D TEXTURE;
uniform vec4 gsw_post_modulate;
uniform bool gsw_premultiply_out;
uniform bool gsw_msdf_on;
uniform vec2 gsw_msdf;
uniform bool gsw_msdf_no_median;
in vec2 v_uv;
in vec4 v_color;
flat in vec4 v_tint;
out vec4 gsw_frag_color;
{MSDF_COVERAGE}
{module}
void main() {{
  vec4 gsw_color = v_color * v_tint;
  if (gsw_msdf_on) {{
    gsw_color.a = gsw_msdf_coverage(TEXTURE, v_uv, gsw_msdf, gsw_msdf_no_median) * gsw_color.a;
  }} else {{
    gsw_color *= texture(TEXTURE, v_uv);
  }}
  godot_item_fragment(gsw_color, v_uv);
  gsw_color *= gsw_post_modulate;
  gsw_frag_color = gsw_premultiply_out ? vec4(gsw_color.rgb * gsw_color.a, gsw_color.a) : gsw_color;
}}
"#
    )
}

/// The vertex stage of an item-space program whose code has its own (a `vertex()`, or
/// `skip_vertex_transform`), around the transpiler's vertex module (`@godot-scene-web/effects`'
/// `vertexGlsl`, which declares `void godot_item_vertex(inout vec2 VERTEX, inout vec2 UV,
/// inout vec4 COLOR, inout float POINT_SIZE, in mat4 MODEL_MATRIX, in mat4 CANVAS_MATRIX,
/// in mat4 SCREEN_MATRIX)` and `#define`s `GSW_SKIP_VERTEX_TRANSFORM` / `GSW_WORLD_VERTEX_COORDS`
/// for those render modes). Godot 4.5.1's order (drivers/gles3/shaders/canvas.glsl:179-280):
///
/// ```text
/// color  = vertex colour * item modulate        (straight, BEFORE the code: v_tint is white)
/// model  = canvas⁻¹ · the row's xform           (GLES3's base_transform: final_transform with the
///                                                canvas transform taken off again)
/// world_vertex_coords:   vertex = model · vertex
/// vertex(VERTEX, UV, COLOR, POINT_SIZE, model, canvas, screen)
/// neither render mode:   vertex = model · vertex
/// color_interp = color;  vertex = canvas · vertex;  gl_Position = screen · vertex
/// ```
///
/// `gsw_canvas_matrix` / `gsw_canvas_inverse` are the binding's (the item's canvas transform and
/// its affine inverse, both column-major `mat4`s; identity until a binding sets them). The screen
/// matrix is [`godot_screen_transform`] under `godot_orientation`, else the projection as a matrix.
pub fn item_program_vertex(module: &str) -> String {
    format!(
        r#"#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_color;  // STRAIGHT
layout(location = 3) in uint a_item;
// PM3: the draw's instance (identity, white and zero custom unless DRAW_INSTANCED).
layout(location = 4) in vec4 a_inst0;
layout(location = 5) in vec4 a_inst1;
layout(location = 6) in vec4 a_inst_color;
layout(location = 7) in vec4 a_inst_custom;
#define GSW_INSTANCE_CUSTOM a_inst_custom
uniform sampler2D u_items;
uniform vec4 u_projection;
uniform bool u_godot_screen;
uniform mat4 u_screen;
uniform mat4 gsw_canvas_matrix;
uniform mat4 gsw_canvas_inverse;
uniform sampler2D TEXTURE;
out vec2 v_uv;
out vec4 v_color;
flat out vec4 v_tint;
{module}
void main() {{
  int gsw_item = int(a_item);
  ivec2 gsw_at = ivec2((gsw_item % 512) * 3, gsw_item / 512);
  vec4 gsw_t0 = texelFetch(u_items, gsw_at, 0);
  vec4 gsw_t1 = texelFetch(u_items, gsw_at + ivec2(1, 0), 0);
  vec4 gsw_t2 = texelFetch(u_items, gsw_at + ivec2(2, 0), 0);
  mat4 gsw_final = mat4(vec4(gsw_t0.xy, 0.0, 0.0), vec4(gsw_t0.zw, 0.0, 0.0),
                        vec4(0.0, 0.0, 1.0, 0.0), vec4(gsw_t1.xy, 0.0, 1.0));
  // canvas.glsl's USE_INSTANCING: MODEL_MATRIX = item × instance.
  mat4 gsw_model = gsw_canvas_inverse * gsw_final
      * transpose(mat4(a_inst0, a_inst1, vec4(0.0, 0.0, 1.0, 0.0), vec4(0.0, 0.0, 0.0, 1.0)));
  mat4 gsw_screen = u_godot_screen ? u_screen
      : mat4(vec4(u_projection.x, 0.0, 0.0, 0.0), vec4(0.0, u_projection.y, 0.0, 0.0),
             vec4(0.0, 0.0, 1.0, 0.0), vec4(u_projection.zw, 0.0, 1.0));
  vec2 gsw_vertex = a_position;
  vec2 gsw_uv = a_uv;
  vec4 gsw_color = a_color * vec4(gsw_t1.zw, gsw_t2.xy) * a_inst_color;
  float gsw_point_size = 1.0;
#ifdef GSW_WORLD_VERTEX_COORDS
  gsw_vertex = (gsw_model * vec4(gsw_vertex, 0.0, 1.0)).xy;
#endif
  godot_item_vertex(gsw_vertex, gsw_uv, gsw_color, gsw_point_size, gsw_model, gsw_canvas_matrix,
                    gsw_screen);
#if !defined(GSW_SKIP_VERTEX_TRANSFORM) && !defined(GSW_WORLD_VERTEX_COORDS)
  gsw_vertex = (gsw_model * vec4(gsw_vertex, 0.0, 1.0)).xy;
#endif
  v_color = gsw_color;
  gsw_vertex = (gsw_canvas_matrix * vec4(gsw_vertex, 0.0, 1.0)).xy;
  v_uv = gsw_uv;
  v_tint = vec4(1.0);
  gl_Position = gsw_screen * vec4(gsw_vertex, 0.0, 1.0);
}}
"#
    )
}

/// The uniform names [`item_program_vertex`] reads from a binding.
pub const CANVAS_MATRIX_UNIFORM: &str = "gsw_canvas_matrix";
pub const CANVAS_INVERSE_UNIFORM: &str = "gsw_canvas_inverse";

/// Texture units: 0 the draw's texture, 1 the item rows, 2 the target (present only); an item-space
/// program's own samplers take units [`FIRST_SAMPLER_UNIT`] and up, at most
/// [`MAX_PROGRAM_SAMPLERS`] (WebGL 2 guarantees 16 fragment units).
pub const FIRST_SAMPLER_UNIT: u32 = 3;
pub const MAX_PROGRAM_SAMPLERS: usize = 13;

pub use gsw_canvas_draw_list::plan::{
    Call, PlanCounts, PlanOptions, call_bounds, drawable, plan_calls, plan_calls_with_options,
};

/// Screen operations and back-buffer producers needed by replayed readers, in plan order.
/// The back buffer is not retained across frames for correctness: the damage planner sends a
/// reader to Full unless an earlier Clear/Copy in this frame covers its footprint. Therefore
/// an omitted operation's output is never read. A Clear starts a new dependency interval.
pub fn partial_back_work(list: &DrawList, calls: &[Call], regions: &[[i32; 4]]) -> (Vec<bool>, Vec<bool>) {
    use gsw_canvas_draw_list::{DRAW_TO_BACK_BUFFER, DRAW_GROUP_CLIP, DRAW_GROUP_COMPOSITE, SCREEN_TEXTURE, ScreenOpKind, cover::PxRect};
    let mut ops = vec![false; list.screen_ops.len()];
    let mut producers = vec![false; calls.len()];
    let mut live = false;
    let mut next = calls.len();
    let visit = |i: usize, live: &mut bool, producers: &mut [bool]| {
        let call = &calls[i];
        let draw = &list.draws[call.draw as usize];
        if draw.flags & DRAW_TO_BACK_BUFFER != 0 {
            producers[i] = *live;
        } else {
            let reader = if draw.program == BUILTIN_PROGRAM {
                draw.flags & (DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE) != 0
            } else {
                list.bindings.get(draw.program as usize - 1).is_some_and(|b|
                    b.samplers.iter().any(|s| s.texture == SCREEN_TEXTURE))
            };
            *live |= reader && regions.iter().any(|&r| PxRect::xywh(call.bounds).intersects(&PxRect::xywh(r)));
        }
    };
    for (i, op) in list.screen_ops.iter().enumerate().rev() {
        while next > 0 && calls[next-1].draw >= op.before {
            next -= 1;
            visit(next, &mut live, &mut producers);
        }
        ops[i] = live;
        if op.kind == ScreenOpKind::Clear { live = false; }
    }
    while next > 0 { next -= 1; visit(next, &mut live, &mut producers); }
    (ops, producers)
}

/// Intersect design-row scissors. `None` means unscissored; an empty box skips the issue.
pub fn effective_scissor(draw_scissor: Option<[i32; 4]>, region: Option<[i32; 4]>) -> Option<[i32; 4]> {
    match (draw_scissor, region) {
        (Some(a), Some(b)) => {
            let r = gsw_canvas_draw_list::cover::PxRect::xywh(a)
                .intersect(&gsw_canvas_draw_list::cover::PxRect::xywh(b));
            Some([r.x0, r.y0, r.x1.saturating_sub(r.x0).max(0), r.y1.saturating_sub(r.y0).max(0)])
        }
        (a, b) => a.or(b),
    }
}

/// One `texSubImage2D` of item rows: texel rectangle `x, y, width, 1·height` holding items
/// `first .. first + count` (contiguous in `DrawList::items`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ItemRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub first: u32,
    pub count: u32,
}

/// The at most three rectangles (a partial first row, whole middle rows, a partial last row) that
/// upload items `start .. end`.
pub fn item_upload_rects(start: u32, end: u32) -> impl Iterator<Item = ItemRect> {
    let mut parts = [None; 3];
    if start < end {
        let k = ITEMS_PER_ROW;
        let (first_row, last_row) = (start / k, (end - 1) / k);
        if first_row == last_row {
            parts[0] = Some(ItemRect {
                x: (start % k) * ITEM_TEXELS,
                y: first_row,
                width: (end - start) * ITEM_TEXELS,
                height: 1,
                first: start,
                count: end - start,
            });
        } else {
            // Leading partial row, unless `start` begins a row.
            let mut whole_from = first_row;
            if !start.is_multiple_of(k) {
                let row_end = (first_row + 1) * k;
                parts[0] = Some(ItemRect {
                    x: (start % k) * ITEM_TEXELS,
                    y: first_row,
                    width: (row_end - start) * ITEM_TEXELS,
                    height: 1,
                    first: start,
                    count: row_end - start,
                });
                whole_from = first_row + 1;
            }
            // Trailing partial row, unless `end` ends a row.
            let mut whole_to = last_row + 1;
            if !end.is_multiple_of(k) {
                parts[2] = Some(ItemRect {
                    x: 0,
                    y: last_row,
                    width: (end - last_row * k) * ITEM_TEXELS,
                    height: 1,
                    first: last_row * k,
                    count: end - last_row * k,
                });
                whole_to = last_row;
            }
            if whole_from < whole_to {
                parts[1] = Some(ItemRect {
                    x: 0,
                    y: whole_from,
                    width: k * ITEM_TEXELS,
                    height: whole_to - whole_from,
                    first: whole_from * k,
                    count: (whole_to - whole_from) * k,
                });
            }
        }
    }
    parts.into_iter().flatten()
}

/// Rows of the item texture needed for `items` items (at least 1).
pub fn item_rows_for(items: usize) -> u32 {
    (items as u32).div_ceil(ITEMS_PER_ROW).max(1)
}

/// A top-left-origin scissor `[x, y, w, h]` as GL's bottom-left box in a target `height` tall.
pub fn gl_scissor(scissor: [i32; 4], height: u32) -> [i32; 4] {
    let [x, y, w, h] = scissor;
    let (w, h) = (w.max(0), h.max(0));
    [x, height as i32 - (y + h), w, h]
}

/// [`gl_scissor`] for a target drawn in Godot's orientation ([`ExecOptions::godot_orientation`]):
/// design rows are GL rows, so only the size is clamped.
pub fn gl_scissor_y_up(scissor: [i32; 4]) -> [i32; 4] {
    let [x, y, w, h] = scissor;
    [x, y, w.max(0), h.max(0)]
}

/// Godot's `screen_transform` for a `width`×`height` target as `canvas_render_items` builds it
/// (rasterizer_canvas_gles3.cpp:331-334: `translate_local(-(w / 2.0f), -(h / 2.0f), 0)` then
/// `scale(Vector3(2.0f / w, 2.0f / h, 1))`, real_t = float), as the column-major `mat4`
/// `_update_transform_to_mat4` uploads.
pub fn godot_screen_transform(width: u32, height: u32) -> [f32; 16] {
    let (w, h) = (width as f32, height as f32);
    let (sx, sy) = (2.0f32 / w, 2.0f32 / h);
    let (ox, oy) = (-(w / 2.0f32) * sx, -(h / 2.0f32) * sy);
    [
        sx, 0.0, 0.0, 0.0, //
        0.0, sy, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        ox, oy, 0.0, 1.0,
    ]
}

/// How an image over `MAX_TEXTURE_SIZE` is reduced at upload: the draw list's contract, which
/// the cover walk reads to know which texels a reduced texture holds.
pub use gsw_canvas_draw_list::{downscale_factor, downscaled_size};

mod downscale;
pub use downscale::downscale_rgba8;

/// Reduce an RGBA16F image (8 bytes a texel) by `k`, keeping the first texel of each block (a
/// half-float box filter would need f16 arithmetic for a format STS2 sends rarely).
pub fn downscale_texels_nearest(
    src: &[u8],
    width: u32,
    height: u32,
    k: u32,
    texel: usize,
) -> Vec<u8> {
    let (w, k) = (width as usize, k as usize);
    let (dw, dh) = downscaled_size(width, height, k as u32);
    let (dw, dh) = (dw as usize, dh as usize);
    let mut out = Vec::with_capacity(dw * dh * texel);
    for dy in 0..dh {
        for dx in 0..dw {
            let at = ((dy * k) * w + dx * k) * texel;
            out.extend_from_slice(&src[at..at + texel]);
        }
    }
    out
}

/// Replace `held`'s arrays with `next`'s, marking dirty only the elements that differ (or
/// everything for an array whose length changed) and keeping `held`'s queued texture ops: how a
/// test turns two `PDL1` dumps into one frame's dirty ranges. The target is replaced too (a target
/// change re-allocates on its own).
#[cfg(any(test, feature = "canvas-items-test"))]
pub fn replace_marking_changes(held: &mut DrawList, next: DrawList) {
    fn diff<T: PartialEq>(old: &[T], new: &[T], ranges: &mut gsw_canvas_draw_list::Ranges) -> bool {
        if old.len() != new.len() {
            return false;
        }
        let mut i = 0;
        while i < new.len() {
            if old[i] != new[i] {
                let start = i;
                while i < new.len() && old[i] != new[i] {
                    i += 1;
                }
                ranges.add(start as u32, i as u32);
            } else {
                i += 1;
            }
        }
        true
    }
    let dirty = &mut held.dirty;
    let same_shape = diff(&held.items, &next.items, &mut dirty.items)
        & diff(&held.vertices, &next.vertices, &mut dirty.vertices)
        & diff(&held.indices, &next.indices, &mut dirty.indices);
    if !same_shape {
        dirty.all = true;
    }
    if held.draws != next.draws {
        dirty.draws = true;
    }
    held.target = next.target;
    held.items = next.items;
    held.vertices = next.vertices;
    held.indices = next.indices;
    held.draws = next.draws;
}

#[cfg(test)]
mod tests {
    use super::*;
    use gsw_canvas_draw_list::{DRAW_SCISSOR, Sampler};

    fn parity_drop_draws(damage_mode: u32) {
        let mut stats = ExecStats {
            damage_mode,
            planned_calls: 2,
            draw_calls: 2,
            ..ExecStats::default()
        };
        assert!(!stats.parity_violation(2));
        // DropDraws omits the second call without changing the plan.
        stats.draw_calls = 1;
        stats.calls_dropped = 1;
        assert!(stats.parity_violation(2));
    }

    #[test]
    fn parity_drop_draws_with_damage_off_is_a_violation() {
        parity_drop_draws(0);
    }

    #[test]
    fn parity_drop_draws_with_full_damage_is_a_violation() {
        parity_drop_draws(1);
    }

    #[test]
    fn parity_skip_does_not_count_as_a_violation() {
        let stats = ExecStats {
            damage_mode: 3,
            ..ExecStats::default()
        };
        assert!(!stats.parity_violation(2));
    }

    #[test]
    fn parity_partial_replay_may_issue_a_different_call_count() {
        for draw_calls in [1, 2, 4] {
            let stats = ExecStats {
                damage_mode: 2,
                planned_calls: 2,
                draw_calls,
                ..ExecStats::default()
            };
            assert!(!stats.parity_violation(2));
        }
    }

    #[test]
    fn parity_planned_count_must_match_expected_except_on_skip() {
        for damage_mode in 0..=2 {
            let stats = ExecStats {
                damage_mode,
                planned_calls: 1,
                draw_calls: 1,
                ..ExecStats::default()
            };
            assert!(stats.parity_violation(2));
        }
    }

    fn draw(first: u32, count: u32) -> Draw {
        Draw {
            first_index: first,
            index_count: count,
            ..Draw::default()
        }
    }

    fn list(draws: Vec<Draw>, indices: usize) -> DrawList {
        DrawList {
            draws,
            indices: vec![0; indices],
            ..DrawList::default()
        }
    }

    fn expected_slots(list: &DrawList, draw: usize) -> [(u32, u32); 4] {
        let mut slots = [(WHITE_TEXTURE, 0); 4];
        let d = &list.draws[draw];
        slots[0] = (d.texture, d.sampler);
        slots
    }

    #[test]
    fn plan_merges_adjacent_equal_state_only_and_agrees_with_merged_draw_count() {
        let a = draw(0, 6);
        let b = draw(6, 6);
        let c = Draw {
            texture: 2,
            ..draw(12, 3)
        };
        let d = Draw {
            texture: 2,
            ..draw(15, 3)
        };
        let e = draw(18, 6); // white again: a new call, never merged back into `a`'s
        let l = list(vec![a, b, c, d, e], 24);
        let mut out = Vec::new();
        let counts = plan_calls(&l, |_| true, |_| false, &mut out);
        assert_eq!(out.len(), l.merged_draw_count());
        assert_eq!(
            out,
            vec![
                Call {
                    draw: 0,
                    first_index: 0,
                    index_count: 12,
                    texture_draw: 0,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 0),
                },
                Call {
                    draw: 2,
                    first_index: 12,
                    index_count: 6,
                    texture_draw: 2,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 2),
                },
                Call {
                    draw: 4,
                    first_index: 18,
                    index_count: 6,
                    texture_draw: 4,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 4),
                },
            ]
        );
        assert_eq!(
            counts,
            PlanCounts {
                merged: 2,
                skipped: 0,
                breaks: gsw_canvas_draw_list::plan::BreakCounts { texture: 2, ..Default::default() },
                ..Default::default()
            }
        );
    }

    #[test]
    fn plan_never_merges_draws_of_different_depth_levels() {
        let mut l = list(vec![draw(0, 6), draw(6, 6), draw(12, 6), draw(18, 6)], 24);
        l.depth_tiles = vec![gsw_canvas_draw_list::DepthTile {
            rect: [0, 0, 32, 32],
            level: 1,
        }];
        // Draws 0 and 1 at level 0, draw 2 untested, draw 3 at level 0 again.
        l.depth_draws = [0, 1, 3]
            .map(|d| gsw_canvas_draw_list::DepthDraw { draw: d, level: 0 })
            .to_vec();
        let mut out = Vec::new();
        plan_calls(&l, |_| true, |_| true, &mut out);
        let calls: Vec<(u32, u32, Option<u32>)> = out
            .iter()
            .map(|c| (c.draw, c.index_count, c.depth))
            .collect();
        assert_eq!(calls, [(0, 12, Some(0)), (2, 6, None), (3, 6, Some(0))]);
        assert_eq!(out.len(), l.merged_draw_count());
        // Without tiles nothing is tested: one call.
        l.depth_tiles.clear();
        plan_calls(&l, |_| true, |_| true, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].depth, None);
        assert_eq!(l.merged_draw_count(), 1);
    }

    #[test]
    fn plan_never_merges_across_state_scissor_or_a_gap() {
        let a = draw(0, 3);
        let gap = draw(6, 3); // does not touch `a`
        let sampler = Draw {
            sampler: Sampler::LINEAR,
            ..draw(9, 3)
        };
        let blend = Draw {
            blend: Blend::Add as u32,
            sampler: Sampler::LINEAR,
            ..draw(12, 3)
        };
        let s1 = Draw {
            flags: DRAW_SCISSOR,
            scissor: [0, 0, 4, 4],
            ..draw(15, 3)
        };
        let s2 = Draw {
            flags: DRAW_SCISSOR,
            scissor: [0, 0, 4, 5],
            ..draw(18, 3)
        };
        let s3 = Draw {
            flags: DRAW_SCISSOR,
            scissor: [0, 0, 4, 5],
            ..draw(21, 3)
        };
        let l = list(vec![a, gap, sampler, blend, s1, s2, s3], 24);
        let mut out = Vec::new();
        let counts = plan_calls(&l, |_| true, |_| false, &mut out);
        assert_eq!(out.len(), 6);
        assert_eq!(out.len(), l.merged_draw_count());
        assert_eq!(counts.merged, 1);
        assert_eq!(
            out[5],
            Call {
                draw: 5,
                first_index: 18,
                index_count: 6,
                texture_draw: 5,
                depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 5),
            }
        );
    }

    #[test]
    fn plan_skips_undrawable_draws_and_ends_their_run() {
        let a = draw(0, 3);
        let unknown_texture = Draw {
            texture: 7,
            ..draw(3, 3)
        };
        let b = draw(6, 3);
        let bad_blend = Draw {
            blend: 99,
            ..draw(9, 3)
        };
        let out_of_range = draw(12, 6); // indices end at 15
        let empty = draw(15, 0);
        let program = Draw {
            program: 3,
            ..draw(12, 3)
        };
        let l = list(
            vec![
                a,
                unknown_texture,
                b,
                bad_blend,
                out_of_range,
                empty,
                program,
            ],
            15,
        );
        let mut out = Vec::new();
        let counts = plan_calls(&l, |id| id == 2, |_| false, &mut out);
        assert_eq!(
            counts,
            PlanCounts {
                merged: 0,
                skipped: 4,
                breaks: gsw_canvas_draw_list::plan::BreakCounts { undrawable: 4, ..Default::default() },
                ..Default::default()
            }
        );
        assert_eq!(
            out,
            vec![
                Call {
                    draw: 0,
                    first_index: 0,
                    index_count: 3,
                    texture_draw: 0,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 0),
                },
                Call {
                    draw: 2,
                    first_index: 6,
                    index_count: 3,
                    texture_draw: 2,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 2),
                }
            ]
        );
    }

    #[test]
    fn untextured_draws_join_a_textured_run_and_the_call_binds_its_texture() {
        let w = |first| Draw {
            flags: DRAW_UNTEXTURED,
            ..draw(first, 3)
        };
        let t = |first, texture| Draw {
            texture,
            sampler: Sampler::LINEAR,
            ..draw(first, 3)
        };
        // W W A W A | B W: the first run binds A (draw 2), the second B (draw 5).
        let l = list(
            vec![w(0), w(3), t(6, 2), w(9), t(12, 2), t(15, 3), w(18)],
            21,
        );
        let mut out = Vec::new();
        let counts = plan_calls(&l, |_| true, |_| false, &mut out);
        assert_eq!(out.len(), l.merged_draw_count());
        assert_eq!(
            out,
            vec![
                Call {
                    draw: 0,
                    first_index: 0,
                    index_count: 15,
                    texture_draw: 2,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 2),
                },
                Call {
                    draw: 5,
                    first_index: 15,
                    index_count: 6,
                    texture_draw: 5,
                    depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 5),
                },
            ]
        );
        assert_eq!(counts.merged, 5);
        // An all-untextured run names its own first draw.
        let l = list(vec![w(0), w(3)], 6);
        plan_calls(&l, |_| true, |_| false, &mut out);
        assert_eq!(out[0].texture_draw, 0);
        assert_eq!(out[0].index_count, 6);
    }

    #[test]
    fn an_empty_draw_does_not_end_a_run() {
        let l = list(vec![draw(0, 3), draw(3, 0), draw(3, 3)], 6);
        let mut out = Vec::new();
        plan_calls(&l, |_| true, |_| false, &mut out);
        assert_eq!(
            out,
            vec![Call {
                draw: 0,
                first_index: 0,
                index_count: 6,
                texture_draw: 0,
                depth: None,
                    bounds: [0; 4],
                    slots: expected_slots(&l, 0),
            }]
        );
        assert_eq!(l.merged_draw_count(), 1);
    }

    #[test]
    fn godot_orientation_keeps_design_rows_and_godots_screen_transform() {
        // Scissors are design rows: nothing is flipped, sizes are clamped.
        assert_eq!(gl_scissor_y_up([2, 3, 10, 5]), [2, 3, 10, 5]);
        assert_eq!(gl_scissor_y_up([0, 0, -4, 5]), [0, 0, 0, 5]);
        // translate_local(-w/2, -h/2) then scale(2/w, 2/h), float32: column-major mat4.
        let m = godot_screen_transform(640, 360);
        assert_eq!(m[0], 2.0f32 / 640.0);
        assert_eq!(m[5], 2.0f32 / 360.0);
        assert_eq!(m[12], -320.0f32 * (2.0f32 / 640.0));
        assert_eq!(m[13], -180.0f32 * (2.0f32 / 360.0));
        assert_eq!((m[10], m[15]), (1.0, 1.0));
        // An odd size keeps its half-pixel centre.
        assert_eq!(godot_screen_transform(5, 3)[12], -2.5f32 * (2.0f32 / 5.0));
    }

    #[test]
    fn item_rects_cover_exactly_the_range_in_contiguous_pieces() {
        let k = ITEMS_PER_ROW;
        let cases = [
            (0, 1),
            (5, 9),
            (0, k),
            (k - 2, k + 3),
            (3, 3 * k + 7),
            (k, 3 * k),
            (2 * k - 1, 2 * k),
            (0, 0),
        ];
        for (start, end) in cases {
            let rects: Vec<_> = item_upload_rects(start, end).collect();
            let mut next = start;
            for r in &rects {
                assert_eq!(r.first, next, "{start}..{end}: contiguous");
                assert_eq!(r.x, (r.first % k) * ITEM_TEXELS);
                assert_eq!(r.y, r.first / k);
                assert_eq!(r.width * r.height, r.count * ITEM_TEXELS);
                if r.height > 1 {
                    assert_eq!((r.x, r.width), (0, k * ITEM_TEXELS));
                }
                next += r.count;
            }
            assert_eq!(next, end.max(start), "{start}..{end}: complete");
            assert!(rects.len() <= 3);
        }
        assert_eq!(item_upload_rects(k - 2, k + 3).count(), 2);
        assert_eq!(item_upload_rects(3, 3 * k + 7).count(), 3);
    }

    #[test]
    fn scissor_flips_to_gl_origin() {
        assert_eq!(gl_scissor([2, 3, 10, 5], 64), [2, 56, 10, 5]);
        assert_eq!(gl_scissor([0, 0, -4, 5], 8), [0, 3, 0, 5]);
    }

    #[test]
    fn replay_scissor_intersects_without_changing_full_scissors() {
        let own = [4, 8, 20, 30];
        assert_eq!(effective_scissor(Some(own), None), Some(own));
        assert_eq!(effective_scissor(None, None), None);
        assert_eq!(effective_scissor(None, Some(own)), Some(own));
        assert_eq!(effective_scissor(Some(own), Some([16, 0, 24, 20])), Some([16, 8, 8, 12]));
        assert_eq!(effective_scissor(Some(own), Some([24, 8, 4, 4])), Some([24, 8, 0, 4]));
        assert_eq!(effective_scissor(Some([i32::MAX-2, 0, 20, 4]), Some([0, 0, 8, 4])), Some([i32::MAX-2, 0, 0, 4]));
    }

    #[test]
    fn replay_bounds_include_every_draw_in_a_merged_run() {
        use gsw_canvas_draw_list::{Item, Vertex, cover::{CoverFacts, ProgramFacts, draw_bounds}};
        struct Facts;
        impl CoverFacts for Facts {
            fn opacity(&self, _: u32) -> Option<&gsw_canvas_draw_list::opacity::Opacity> { None }
            fn program(&self, _: u32) -> ProgramFacts { ProgramFacts::UNKNOWN }
        }
        impl gsw_canvas_draw_list::damage::DamageFacts for Facts {
            fn texture_revision(&self, _: u32) -> u32 { 0 }
            fn program(&self, _: u32) -> ProgramFacts { ProgramFacts::UNKNOWN }
            fn reads_time(&self, _: u32) -> bool { false }
            fn admitted(&self, _: &DrawList, _: usize) -> bool { true }
        }
        let mut l = list(vec![draw(0, 3), draw(3, 3)], 6);
        l.target.width = 128; l.target.height = 128;
        l.items.push(Item { xform: [1.0,0.0,0.0,1.0,0.0,0.0], ..Item::default() });
        l.vertices = [[4.0,8.0], [16.0,8.0], [4.0,16.0], [80.0,80.0], [96.0,80.0], [80.0,96.0]]
            .map(|pos| Vertex { pos, ..Vertex::default() }).to_vec();
        l.indices = (0..6).collect();
        let mut calls = Vec::new();
        plan_calls(&l, |_| true, |_| true, &mut calls);
        assert_eq!(calls.len(), 1);
        let mut planner = gsw_canvas_draw_list::damage::Planner::new();
        planner.plan(&l, &Facts, &gsw_canvas_draw_list::damage::PlanOptions::default());
        call_bounds(&l, &mut calls, |d| planner.draw_bounds(d));
        let a = draw_bounds(&l, 0, &Facts); let b = draw_bounds(&l, 1, &Facts);
        assert_eq!(calls[0].bounds, [a.x0, a.y0, b.x1-a.x0, b.y1-a.y0]);
        l.draws[0].program = 1;
        plan_calls(&l, |_| true, |_| true, &mut calls);
        planner.plan(&l, &Facts, &gsw_canvas_draw_list::damage::PlanOptions::default());
        call_bounds(&l, &mut calls, |d| planner.draw_bounds(d));
        assert_eq!(calls[0].bounds, [0, 0, 128, 128]);
    }

    #[test]
    fn partial_back_work_follows_readers_until_clear_in_event_order() {
        use gsw_canvas_draw_list::{DRAW_TO_BACK_BUFFER, DRAW_GROUP_COMPOSITE, ScreenOp, ScreenOpKind, Binding, SamplerUniform, SCREEN_TEXTURE};
        let mut l = list(vec![draw(0,3); 6], 18);
        for (i, d) in l.draws.iter_mut().enumerate() { d.first_index = i as u32*3; }
        l.draws[0].flags = DRAW_TO_BACK_BUFFER;
        l.draws[1].flags = DRAW_GROUP_COMPOSITE;
        l.draws[2].flags = DRAW_TO_BACK_BUFFER;
        l.draws[3].program = 1;
        l.draws[4].flags = DRAW_TO_BACK_BUFFER; // no following reader
        l.bindings.push(Binding { samplers: vec![SamplerUniform { name: "screen".into(), texture: SCREEN_TEXTURE, sampler: 0 }], ..Binding::default() });
        let op = |before, kind| ScreenOp { before, kind, region: [0,0,128,128], mipmaps: false, sample_mips: false };
        l.screen_ops = vec![op(0,ScreenOpKind::Clear), op(0,ScreenOpKind::Copy), op(1,ScreenOpKind::Mipmaps),
            op(2,ScreenOpKind::Clear), op(4,ScreenOpKind::Clear), op(6,ScreenOpKind::Copy)];
        // Explicit calls isolate the event ordering (screen-op boundaries prevent merged runs).
        let calls: Vec<_> = (0..6).map(|i| Call { draw: i, first_index: i*3, index_count: 3,
            texture_draw: i, depth: None, slots: [(WHITE_TEXTURE, 0); 4], bounds: if i < 2 { [0,0,32,32] } else { [64,64,32,32] } }).collect();
        let (ops, producers) = partial_back_work(&l, &calls, &[[0,0,32,32]]);
        assert_eq!(ops, [true,true,true,false,false,false]);
        assert_eq!(producers, [true,false,false,false,false,false]);
        let (ops, producers) = partial_back_work(&l, &calls, &[[64,64,32,32]]);
        assert_eq!(ops, [false,false,false,true,false,false]);
        assert_eq!(producers, [false,false,true,false,false,false]);
        let (ops, producers) = partial_back_work(&l, &calls, &[]);
        assert!(ops.iter().all(|&needed| !needed));
        assert!(producers.iter().all(|&needed| !needed));
    }

    #[test]
    fn stats_are_a_flat_word_block() {
        let stats = ExecStats {
            draws: 3,
            fence_issued: 1,
            binding_uploads: 5,
            screen_mipmaps: 7,
            depth_tested: 9,
            planned_calls: 11,
            damage_mode: 2,
            damage_reason: 4,
            damage_regions: 6,
            damage_permille: 80,
            damage_changed: 10,
            damage_us: 12,
            damage_calls: 13,
            damage_ops_skipped: 14,
            ..ExecStats::default()
        };
        // The word block is read by position: a new field goes last and bumps WORDS.
        assert_eq!(ExecStats::WORDS, 35);
        assert_eq!(stats.as_words()[23], 7);
        assert_eq!(stats.as_words()[0], 3);
        assert_eq!(stats.as_words()[19], 1);
        assert_eq!(stats.as_words()[21], 5);
        assert_eq!(&stats.as_words()[25..], &[9, 11, 2, 4, 6, 80, 10, 12, 13, 14]);
        assert!(stats.to_json().starts_with("{\"draws\":3,"));
    }

    #[test]
    fn replacing_marks_only_changed_elements() {
        use gsw_canvas_draw_list::{Item, Target};
        let item = |x: f32| Item {
            xform: [1.0, 0.0, 0.0, 1.0, x, 0.0],
            modulate: [1.0; 4],
            ..Item::default()
        };
        let mut held = DrawList::new(Target::default());
        held.items = (0..6).map(|i| item(i as f32)).collect();
        held.indices = vec![0, 1, 2];
        held.consumed();
        held.upload_texture(3, 1, 1, &[1, 2, 3, 4]);
        let mut next = held.clone();
        next.items[1] = item(10.0);
        next.items[2] = item(11.0);
        next.items[5] = item(12.0);
        replace_marking_changes(&mut held, next.clone());
        assert!(!held.dirty.all && !held.dirty.draws);
        assert_eq!(held.dirty.items.as_slice(), &[(1, 3), (5, 6)]);
        assert!(held.dirty.vertices.is_empty() && held.dirty.indices.is_empty());
        assert_eq!(held.items, next.items);
        assert_eq!(held.texture_ops.len(), 1, "queued texture ops survive");
        next.indices.push(0);
        replace_marking_changes(&mut held, next);
        assert!(held.dirty.all);
    }

    #[test]
    fn sabotage_names() {
        assert_eq!(Sabotage::parse("drop-draws"), Ok(Some(Sabotage::DropDraws)));
        assert_eq!(
            Sabotage::parse("stale-item-row"),
            Ok(Some(Sabotage::StaleItemRow))
        );
        assert_eq!(
            Sabotage::parse("msdf-no-median"),
            Ok(Some(Sabotage::MsdfNoMedian))
        );
        assert_eq!(Sabotage::parse(""), Ok(None));
        assert!(Sabotage::parse("bogus").is_err());
    }

    #[test]
    fn msdf_glsl_is_canvas_glsl_statement_for_statement() {
        // drivers/gles3/shaders/canvas.glsl:562-564, 605-617 (Godot 4.5.1), as written there.
        for line in [
            "return max(min(r, g), min(max(r, g), b));",
            "float outline_thickness = msdf.y;",
            "vec2 msdf_size = vec2(textureSize(color_texture, 0));",
            "vec2 dest_size = vec2(1.0) / fwidth(uv);",
            "float px_size = max(0.5 * dot((vec2(px_range) / msdf_size), dest_size), 1.0);",
            "float cr = clamp(outline_thickness, 0.0, (px_range / 2.0) - 1.0) / px_range;",
            "d = min(d, msdf_sample.a);",
            "return clamp((d - 0.5 + cr) * px_size, 0.0, 1.0);",
            "return clamp((d - 0.5) * px_size + 0.5, 0.0, 1.0);",
        ] {
            assert!(MSDF_COVERAGE.contains(line), "{line}");
        }
        assert!(msdf_fragment().contains(MSDF_COVERAGE));
        assert!(
            item_program_fragment("void godot_item_fragment(inout vec4 C, in vec2 U) {}")
                .contains("if (gsw_msdf_on)")
        );
    }

    #[test]
    fn downscale_factor_fits_the_max_side() {
        assert_eq!(downscale_factor(4096, 4096, 4096), 1);
        assert_eq!(downscale_factor(5380, 1320, 4096), 2);
        assert_eq!(downscaled_size(5380, 1320, 2), (2690, 660));
        assert_eq!(downscale_factor(12289, 10, 4096), 4);
        assert_eq!(downscaled_size(12289, 10, 4), (3073, 3));
        assert_eq!(downscale_factor(9000, 9000, 0), 1);
    }

    #[test]
    fn downscale_rgba8_weights_by_alpha_and_keeps_edges() {
        // 3x2 by 2: block (0,0) = red opaque + transparent white + two transparent; block (1,0) is
        // the odd edge column (2 texels).
        #[rustfmt::skip]
        let src = [
            255, 0, 0, 255,   255, 255, 255, 0,   0, 0, 255, 255,
            255, 255, 255, 0, 255, 255, 255, 0,   0, 0, 255, 255,
        ];
        let out = downscale_rgba8(&src, 3, 2, 2);
        assert_eq!(out.len(), 2 * 1 * 4);
        // colour from the opaque texel only (no white bleed), alpha the mean: 255/4 -> 64
        assert_eq!(&out[0..4], &[255, 0, 0, 64]);
        assert_eq!(&out[4..8], &[0, 0, 255, 255]);
        // a fully transparent block keeps its plain colour mean
        let clear = [10, 20, 30, 0, 30, 40, 50, 0];
        assert_eq!(downscale_rgba8(&clear, 2, 1, 2), vec![20, 30, 40, 0]);
    }

    #[test]
    fn downscale_texels_nearest_keeps_each_blocks_first_texel() {
        let src: Vec<u8> = (0..5 * 3).flat_map(|i: u8| [i; 8]).collect();
        let out = downscale_texels_nearest(&src, 5, 3, 2, 8);
        let firsts: Vec<u8> = out.chunks_exact(8).map(|t| t[0]).collect();
        assert_eq!(firsts, vec![0, 2, 4, 10, 12, 14]);
    }

    fn factors(s: BlendState) -> (u32, u32, u32, u32, u32) {
        (s.equation, s.src_rgb, s.dst_rgb, s.src_alpha, s.dst_alpha)
    }

    #[test]
    fn transparent_add_and_sub_run_alpha_through_godots_factors_and_equation() {
        use gl_enum::*;
        assert_eq!(
            factors(blend_state(Blend::Add, false)),
            (FUNC_ADD, ONE, ONE, SRC_ALPHA, ONE)
        );
        // Reverse-subtract covers alpha too: a Sub draw removes coverage, it never adds it.
        assert_eq!(
            factors(blend_state(Blend::Sub, false)),
            (FUNC_REVERSE_SUBTRACT, ONE, ONE, SRC_ALPHA, ONE)
        );
    }

    #[test]
    fn opaque_target_keeps_the_destination_alpha_for_every_blend() {
        for blend in [
            Blend::Mix,
            Blend::Add,
            Blend::Sub,
            Blend::Mul,
            Blend::PremulAlpha,
        ] {
            let s = blend_state(blend, true);
            assert_eq!(
                (s.src_alpha, s.dst_alpha),
                (gl_enum::ZERO, gl_enum::ONE),
                "{blend:?}"
            );
        }
        assert_eq!(
            blend_state(Blend::Sub, true).equation,
            gl_enum::FUNC_REVERSE_SUBTRACT
        );
    }

    #[test]
    fn mix_and_mul_transparent_states_are_unchanged() {
        use gl_enum::*;
        assert_eq!(
            factors(blend_state(Blend::Mix, false)),
            (FUNC_ADD, ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)
        );
        assert_eq!(
            factors(blend_state(Blend::Mul, false)),
            (FUNC_ADD, DST_COLOR, ZERO, DST_ALPHA, ZERO)
        );
    }

    #[test]
    fn cache_keys_distinguish_blend_and_target_kind() {
        let mut keys: Vec<u8> = [Blend::Mix, Blend::Add, Blend::Sub, Blend::Mul]
            .into_iter()
            .flat_map(|b| [blend_state(b, false).func, blend_state(b, true).func])
            .collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), 8);
    }
}
