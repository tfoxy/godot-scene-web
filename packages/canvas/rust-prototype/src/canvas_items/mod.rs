//! `canvas-items`: an executor for `gsw-canvas-draw-list`'s packed CanvasItem [`DrawList`] on WebGL2
//! through `glow`, with no wgpu (gate7-design.md Q14b, D30).
//!
//! The browser half is [`CanvasItemsExecutor`] (wasm32). One frame is
//! [`CanvasItemsExecutor::execute`], then the caller's [`DrawList::consumed`]:
//!
//! 1. the list's [`TextureOp`](gsw_canvas_draw_list::TextureOp)s, in order: `texImage2D` of straight
//!    RGBA8 straight from a view of `texture_bytes`, or a delete;
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
//!    texel (G7o4);
//! 5. the blit to the canvas with G7c's `StageTarget` semantics (`packages/canvas/src/present.ts`):
//!    RGB10_A2 is a `texelFetch` draw writing `floor(c·255 + 0.5)/255`, never `blitFramebuffer`
//!    (memory g7c-gpu-blend-conversion-facts); RGBA8 is a `blitFramebuffer`;
//! 6. a fence ([`CanvasItemsExecutor::poll_fence`]), since the g31 has no timer query.
//!
//! The colour contract is G7c's TypeScript textured-mesh path (`executor-webgl.ts`,
//! `TEXTURED_MESH_FRAGMENT_SRC`): `fragColor = texel * colour * tint`, the texel premultiplied after
//! filtering, the straight vertex colour premultiplied per fragment and the item modulate
//! premultiplied; a [`Blend::PremulAlpha`] draw uses all three as given (modulate straight) under
//! MIX's GL state. Positions are item-local; the vertex shader fetches its item's row and applies
//! `xform`, then the design → clip projection `[2/w, -2/h, -1, 1]` of the target size.
//!
//! This module also holds the target-independent planning ([`plan_calls`], [`item_upload_rects`])
//! so it is unit-tested natively.
use gsw_canvas_draw_list::{
    BUILTIN_PROGRAM, Blend, DRAW_UNTEXTURED, Draw, DrawList, WHITE_TEXTURE, mergeable, merged,
};

#[cfg(target_arch = "wasm32")]
mod gl;
#[cfg(target_arch = "wasm32")]
pub use gl::{CanvasItemsExecutor, ContextState, ExecError, FenceState};
#[cfg(all(target_arch = "wasm32", feature = "canvas-items-test"))]
pub mod test_harness;

/// Items per row of the item data texture. Its width is `3 · ITEMS_PER_ROW` texels (1536, inside
/// WebGL2's guaranteed 2048), so item `i` is texels `3·(i % 512) .. +3` of row `i / 512`, and a
/// run of whole rows is one contiguous slice of `DrawList::items`.
pub const ITEMS_PER_ROW: u32 = 512;
/// RGBA32F texels per item (an `Item` is 48 bytes).
pub const ITEM_TEXELS: u32 = 3;

/// The sabotages of gate7-design.md G7x. Each must make the executor's own pixel test fail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sabotage {
    /// Skip every second merged draw call the executor plans (the 2nd, 4th, …, counted across
    /// frames since creation).
    DropDraws,
    /// Skip uploading dirty item rows unless `dirty.all`: a transform-only frame draws stale rows.
    StaleItemRow,
    /// gate7-design.md Q5's `premultiplied-upload`: textures are premultiplied (8-bit) on upload
    /// and sampled as premultiplied, so linear filtering mixes premultiplied texels where Godot
    /// filters straight ones and premultiplies after.
    PremultipliedUpload,
    /// G7tm's `msdf-no-median`: an MSDF draw takes the smallest of the three distances instead of
    /// their median. Wherever the channels disagree (every edge the field colours with two of the
    /// three channels) coverage drops, and it never rises, so only drawn ink changes.
    MsdfNoMedian,
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
            other => Err(format!("unknown canvas-items sabotage {other:?}")),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExecOptions {
    pub sabotage: Option<Sabotage>,
    /// Draw the target the way Godot's GLES3 renderer draws a 2D render target: design y up the
    /// GL window (row 0 at the bottom is design row 0), through `screen_transform` exactly as
    /// `canvas_render_items` builds it (`translate_local(-w/2, -h/2)` then `scale(2/w, 2/h)`, in
    /// float32) and applied as a `mat4` product (canvas.glsl). GL's fill rule then breaks ties of
    /// edges exactly on pixel centres the way the engine does (G7t: gate 4's hex box, the gate 6
    /// LineEdit's StyleBoxFlat). Shots read the target without a row swap and the present draw
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
}

impl ExecStats {
    pub const WORDS: usize = std::mem::size_of::<ExecStats>() / 4;

    pub fn as_words(&self) -> &[u32; Self::WORDS] {
        // SAFETY: `#[repr(C)]` of u32 fields only: no padding, size 4·WORDS, alignment 4.
        unsafe { &*(self as *const ExecStats as *const [u32; Self::WORDS]) }
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
                "\"fenceIssued\":{},\"programBinds\":{},\"bindingUploads\":{}}}"
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
/// (G7tm). Godot's order (canvas.glsl:566-618, 716): `color = color_interp` (the vertex colour ×
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

/// The fragment stage of an item-space program (G7s): `canvas.glsl`'s order (Godot 4.5.1,
/// drivers/gles3/shaders/canvas.glsl:566-717) around the program module, which declares its
/// uniforms and samplers, its helpers, and `void godot_item_fragment(inout vec4 COLOR, in vec2 UV)`
/// (`@godot-scene-web/effects`'s `transpileGodotItemShader`):
///
/// ```text
/// color = color_interp * texture(color_texture, uv)   (straight: vertex colour × item modulate)
///   or, for an MSDF draw (G7tm), color.a = coverage · color.a   (canvas.glsl:601-618)
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

/// Texture units: 0 the draw's texture, 1 the item rows, 2 the target (present only); an item-space
/// program's own samplers take units [`FIRST_SAMPLER_UNIT`] and up, at most
/// [`MAX_PROGRAM_SAMPLERS`] (WebGL 2 guarantees 16 fragment units).
pub const FIRST_SAMPLER_UNIT: u32 = 3;
pub const MAX_PROGRAM_SAMPLERS: usize = 13;

/// One `drawElements` call: the state of draw `draw` over a merged index range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Call {
    /// Index of the run's first draw in `list.draws` (its state is the call's, but for the
    /// texture and sampler: `texture_draw`'s).
    pub draw: u32,
    pub first_index: u32,
    pub index_count: u32,
    /// G7o4: the draw whose texture and sampler the call binds: the run's first draw that is not
    /// [`DRAW_UNTEXTURED`], else `draw` (an all-untextured run, which needs no texture of its own).
    pub texture_draw: u32,
}

/// What [`plan_calls`] counted besides the calls.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlanCounts {
    pub merged: u32,
    pub skipped: u32,
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
/// merge when [`mergeable`] allows; an empty draw neither draws nor ends a run (as
/// [`DrawList::merged_draw_count`] counts); an undrawable one is skipped and ends the run.
pub fn plan_calls(
    list: &DrawList,
    known_texture: impl Fn(u32) -> bool,
    known_binding: impl Fn(u32) -> bool,
    out: &mut Vec<Call>,
) -> PlanCounts {
    out.clear();
    let mut counts = PlanCounts::default();
    // The current run's state (`merged`): its texture and sampler are its first textured draw's.
    let mut run: Option<Draw> = None;
    for (i, draw) in list.draws.iter().enumerate() {
        if draw.index_count == 0 {
            continue;
        }
        if !drawable(draw, list.indices.len(), &known_texture, &known_binding) {
            counts.skipped += 1;
            run = None;
            continue;
        }
        run = Some(match (run, out.last_mut()) {
            (Some(r), Some(call)) if mergeable(&r, draw) => {
                call.index_count += draw.index_count;
                if r.flags & DRAW_UNTEXTURED != 0 && draw.flags & DRAW_UNTEXTURED == 0 {
                    call.texture_draw = i as u32;
                }
                counts.merged += 1;
                merged(&r, draw)
            }
            _ => {
                out.push(Call {
                    draw: i as u32,
                    first_index: draw.first_index,
                    index_count: draw.index_count,
                    texture_draw: i as u32,
                });
                *draw
            }
        });
    }
    counts
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
                    texture_draw: 0
                },
                Call {
                    draw: 2,
                    first_index: 12,
                    index_count: 6,
                    texture_draw: 2
                },
                Call {
                    draw: 4,
                    first_index: 18,
                    index_count: 6,
                    texture_draw: 4
                },
            ]
        );
        assert_eq!(
            counts,
            PlanCounts {
                merged: 2,
                skipped: 0
            }
        );
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
                texture_draw: 5
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
                skipped: 4
            }
        );
        assert_eq!(
            out,
            vec![
                Call {
                    draw: 0,
                    first_index: 0,
                    index_count: 3,
                    texture_draw: 0
                },
                Call {
                    draw: 2,
                    first_index: 6,
                    index_count: 3,
                    texture_draw: 2
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
                },
                Call {
                    draw: 5,
                    first_index: 15,
                    index_count: 6,
                    texture_draw: 5,
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
                texture_draw: 0
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
    fn stats_are_a_flat_word_block() {
        let stats = ExecStats {
            draws: 3,
            fence_issued: 1,
            binding_uploads: 5,
            ..ExecStats::default()
        };
        assert_eq!(ExecStats::WORDS, 22);
        assert_eq!(stats.as_words()[0], 3);
        assert_eq!(stats.as_words()[ExecStats::WORDS - 3], 1);
        assert_eq!(stats.as_words()[ExecStats::WORDS - 1], 5);
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
}
