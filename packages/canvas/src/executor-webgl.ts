import {
  type Batch,
  type BatchFlushReason,
  COLOR_MATRIX_FLOATS,
  createQuadBatcher,
  createQuadInstance,
  INSTANCE_COLOR_OFFSET,
  INSTANCE_CORNERS_OFFSET,
  INSTANCE_FLOATS,
  INSTANCE_SLOTS_OFFSET,
  INSTANCE_UV_OFFSET,
  MAX_TEXTURE_SLOTS,
  type QuadBatcher,
} from "./batcher";
import {
  type ClipStack,
  createClipStack,
  createScissorBox,
  type PixelTransform,
  type ScissorBox,
} from "./clip-stack";
import { colorMatricesEqual, IDENTITY_COLOR_MATRIX } from "./color";
import type { CompiledDrawList } from "./compiled-draw-list";
import type { DamageRect } from "./damage";
import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  BLEND_SUB,
  type BlendMode,
  createClipRectView,
  createGlyphsView,
  createNinePatchView,
  createPolylineView,
  createQuadView,
  createTexturedMeshView,
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_EXTERNAL_EFFECT,
  DRAW_GLYPHS,
  DRAW_NINE_PATCH,
  DRAW_POLYLINE,
  DRAW_QUAD,
  DRAW_SCREEN_EFFECT,
  DRAW_TEXTURED_MESH,
  type DrawList,
  type GlyphsView,
} from "./draw-list";
import type { GlyphPass } from "./glyph-pass";
import {
  createNinePatchBands,
  expandNinePatch,
  type NinePatchBand,
} from "./nine-patch";
import { expandPolyline, POLYLINE_QUAD_FLOATS } from "./polyline";
import type { StageProjection } from "./present";
import type { CommandMask } from "./replay";
import type { CanvasTextureHandle } from "./textures";

/**
 * The WebGL2 executor: a draw list in, GL draws out.
 *
 * ONE PROGRAM, ONE VERTEX FORMAT, ONE BUFFER for the whole scene. Every command
 * kind is reduced to the same instanced quad — a sprite is one, a nine-patch is
 * up to nine (`./nine-patch`), a polyline is one per segment plus one per join
 * (`./polyline`), a solid fill is one sampling a 1x1 white texel. That is what
 * lets `./batcher` merge across command kinds instead of only within them, and it
 * is why there is no "solid" shader, no "line" shader and no per-kind draw path
 * to keep in sync.
 *
 * WHAT BREAKS A BATCH, and what deliberately does not. GL state that lives on the
 * DRAW rather than on the instance has to break one: the blend mode, the scissor
 * box, and the rounded-clip uniforms. Everything else is per-instance data —
 * transform, source rect, tint, texture (an index into the batch's slot table),
 * colour matrix (an index into the batch's uniform table) — so it costs a few
 * floats instead of a draw call. See `./batcher`'s note for the measurement that
 * decided this.
 *
 * ORDER OF OPERATIONS AROUND A STATE CHANGE, which is the one genuinely subtle
 * thing in this file. A flush DRAWS with whatever GL state is currently set, so
 * the pending batch must be flushed BEFORE the new state is applied, never after.
 * Every state change here therefore reads: tell the batcher (which flushes the
 * old batch under the old GL state), then touch GL. Doing it the other way round
 * is invisible in a screenshot of a static scene and produces a one-frame-late
 * clip the moment anything moves.
 *
 * THE ONE COMMAND THAT IS NOT A QUAD. `glyphs` runs are outlines evaluated per fragment, which no
 * amount of instancing turns into the program above, so they are delegated to an injected
 * {@link GlyphPass} (`./glyph-pass`) and cost one draw call each. That makes them the only place
 * this file hands the context to somebody else mid-frame, and the order-of-operations rule above is
 * exactly what governs it: flush, then the pass, then rebind. `emitGlyphsCommand` is where that is
 * written down.
 *
 * THE ALPHA CONTRACT, end to end: textures upload premultiplied (`./textures`),
 * tints in the draw list are premultiplied, the fragment emits `vec4(rgb*a, a)`,
 * the MIX blend is `(ONE, ONE_MINUS_SRC_ALPHA)`, and the canvas is declared
 * `premultipliedAlpha: true` (`./present`). Any one of those five flipped on its
 * own is silent — nothing errors, the picture is just wrong — which is why they
 * are named together here.
 */

/** A texture handle the executor can draw: the GL object and the size its source
 *  rects are measured against. `CanvasTextureHandle` satisfies it. */
export type ExecutorTexture = CanvasTextureHandle;

/** GL blend state for a Godot blend mode, as ENUM NAMES so the mapping is pure
 *  and unit-testable (the same trick `html`'s `blendFactorsFor` uses). */
export interface BlendState {
  equationRgb: "FUNC_ADD" | "FUNC_REVERSE_SUBTRACT";
  equationAlpha: "FUNC_ADD";
  srcRgb: "ONE" | "DST_COLOR";
  dstRgb: "ONE" | "ZERO" | "ONE_MINUS_SRC_ALPHA";
  srcAlpha: "ONE" | "DST_ALPHA";
  dstAlpha: "ONE" | "ZERO" | "ONE_MINUS_SRC_ALPHA";
}

const BLEND_STATES: Record<BlendMode, BlendState> = {
  // MIX, in its PREMULTIPLIED form: the source already carries `rgb*a`, so it
  // contributes unscaled and the destination is attenuated by the coverage the
  // source claims. Algebraically identical to `SRC_ALPHA / ONE_MINUS_SRC_ALPHA`
  // over a STRAIGHT source — the choice between the two is not arithmetic, it is
  // which contract the canvas is declared under.
  [BLEND_MIX]: {
    equationRgb: "FUNC_ADD",
    equationAlpha: "FUNC_ADD",
    srcRgb: "ONE",
    dstRgb: "ONE_MINUS_SRC_ALPHA",
    srcAlpha: "ONE",
    dstAlpha: "ONE_MINUS_SRC_ALPHA",
  },
  // ADD: light adds and nothing is attenuated. Coverage accumulates too, so a
  // stack of glows still reports itself as covering the pixel to the page.
  [BLEND_ADD]: {
    equationRgb: "FUNC_ADD",
    equationAlpha: "FUNC_ADD",
    srcRgb: "ONE",
    dstRgb: "ONE",
    srcAlpha: "ONE",
    dstAlpha: "ONE",
  },
  // SUB: `dst - src` on COLOUR only. The alpha equation stays `FUNC_ADD` — a
  // reverse-subtract on alpha would eat the destination's coverage as well, so a
  // dark smoke sprite would punch a transparent hole in the scene instead of
  // darkening it.
  [BLEND_SUB]: {
    equationRgb: "FUNC_REVERSE_SUBTRACT",
    equationAlpha: "FUNC_ADD",
    srcRgb: "ONE",
    dstRgb: "ONE",
    srcAlpha: "ONE",
    dstAlpha: "ONE",
  },
  // MUL: the destination times the source, with no additive term at all — hence
  // the ZERO destination factors. Separate alpha so coverage multiplies too.
  [BLEND_MUL]: {
    equationRgb: "FUNC_ADD",
    equationAlpha: "FUNC_ADD",
    srcRgb: "DST_COLOR",
    dstRgb: "ZERO",
    srcAlpha: "DST_ALPHA",
    dstAlpha: "ZERO",
  },
};

/** The GL blend state a Godot `CanvasItemMaterial.BlendMode` maps to. */
export function blendStateFor(blend: BlendMode): BlendState {
  return BLEND_STATES[blend] ?? BLEND_STATES[BLEND_MIX];
}

export interface ExecutorStats {
  /** Draw-list commands read. */
  commands: number;
  /** Quad instances pushed, including expanded nine-patch bands and stroke quads. */
  quads: number;
  /** `drawArraysInstanced` calls — the number this executor exists to keep small. */
  batches: number;
  /** Texture-unit binds summed over batches. */
  textureBinds: number;
  /** Times the scissor box actually changed. */
  scissorChanges: number;
  /** Times GL blend state actually changed. */
  blendChanges: number;
  ninePatches: number;
  ninePatchQuads: number;
  polylines: number;
  polylineQuads: number;
  /** Indexed textured-mesh commands executed. */
  texturedMeshes: number;
  /** Triangle-list primitives submitted by textured meshes. */
  texturedMeshTriangles: number;
  /** `drawElements` calls issued by textured meshes. */
  texturedMeshDrawCalls: number;
  /** `glyphs` commands handed to the installed {@link CanvasExecutorOptions.glyphs} pass. */
  glyphRuns: number;
  /** Glyphs the pass reported drawing, summed over runs. Excludes ones it skipped. */
  glyphs: number;
  /** Draw calls the pass reported. One per run, for the reason {@link GlyphPass.drawRun} gives. */
  glyphDrawCalls: number;
  glyphRunBatches: number;
  glyphRunBatchFallbacks: number;
  /**
   * `glyphs` commands seen with NO pass installed.
   *
   * A NAMED NO-OP RATHER THAN A SILENT ONE. A list carrying text into an executor that cannot draw
   * text is a wiring mistake — the consumer forgot to pass `glyphs` — and its symptom is a page
   * that renders perfectly except for having no words on it. That is exactly the kind of failure
   * a screenshot review passes and a counter catches.
   */
  glyphRunsDropped: number;
  /** Screen-dependent passes executed at their recorded painter position. */
  screenEffects: number;
  /** Required screen passes that refused or failed at runtime. */
  screenEffectFailures: number;
  /** Direct external passes executed at their recorded painter position. */
  externalEffects: number;
  /** Required direct external passes that refused or failed at runtime. */
  externalEffectFailures: number;
  /** Clip rects that could not be an exact scissor (see `./clip-stack`). */
  rotatedClipFallbacks: number;
  /** `clipPop`s with nothing open — a malformed list, survived rather than thrown. */
  unbalancedClipPops: number;
  /**
   * Commands whose kind this executor does not handle.
   *
   * The dispatch switch had no `default` for its first five kinds, so a sixth added to the IR fell
   * through it silently while still counting in {@link ExecutorStats.commands} — a frame missing
   * every command of the new kind, reported as a frame that drew everything.
   */
  unknownCommands: number;
  /** Largest single batch, in instances. */
  maxBatchQuads: number;
  /** Why batches ended, so a regression in batching says which axis moved. */
  flushes: Record<BatchFlushReason, number>;
  /** Per-execution compiled-plan diagnostics; direct frames leave these zero. */
  compiledPlanBuilds: number;
  compiledPlanReuses: number;
  compiledTemplateRangeUpdates: number;
  reusedSelections: number;
  reusedBatches: number;
  compiledGpuFullUploads: number;
  compiledGpuRangeUploads: number;
  compiledCachedDrawCalls: number;
}

export interface CanvasExecutorOptions {
  gl: WebGL2RenderingContext;
  /** The 1x1 white texel untextured quads sample. Defaults to one the executor
   *  makes and owns; pass `CanvasTextureCache.white()` to share the cache's. */
  white?: ExecutorTexture;
  /**
   * Who draws `glyphs` commands. Omitted means the executor cannot draw text.
   *
   * INJECTED, exactly like {@link CanvasExecutorOptions.white}, and for the reason
   * {@link GlyphPass} states: the only implementation is backed by a glyph renderer that a scene
   * with no text should not have to load, and the main barrel's export surface is mirrored by hand
   * downstream. Import `@godot-scene-web/canvas/glyphs` and pass one when the scene has text.
   *
   * Leaving it out is not an error — plenty of draw lists have no glyph runs at all — but a list
   * that DOES carry one then counts it in {@link ExecutorStats.glyphRunsDropped} rather than
   * skipping it in silence.
   */
  glyphs?: GlyphPass;
  /**
   * Opt-in only: combine physically adjacent glyph commands when the injected pass exposes
   * `drawRuns`. This never crosses a clip, a command-mask gap, or any non-glyph command.
   */
  batchAdjacentGlyphRuns?: boolean;
  /** Texture units per batch. Clamped to the context's `MAX_TEXTURE_IMAGE_UNITS`
   *  and to {@link MAX_TEXTURE_SLOTS}. */
  maxTextureSlots?: number;
  /** Colour-matrix slots per batch, including the identity at slot 0. */
  maxColorMatrices?: number;
  /** Initial instance-arena capacity, in quads. */
  quadCapacity?: number;
}

export interface ExecuteOptions {
  /** Clear the framebuffer to transparent black before drawing. Default true. */
  clear?: boolean;
  /**
   * Replacement clear colour for a full-frame stage pass. It is intentionally
   * an execute option rather than a global GL mutation: retained FBO replays
   * keep their transparent clear while an opaque presenter can establish its
   * base pixels without a second fullscreen draw.
   */
  clearColor?: readonly [number, number, number, number];
  /**
   * Restrict both clearing and drawing to this top-left framebuffer-pixel
   * rectangle. It is the retained-surface seam, but is also useful to any
   * caller rendering into its own FBO; omitted keeps the direct full-frame
   * executor path byte-for-byte in shape.
   */
  damage?: DamageRect;
  /** Ordered replay selection. Clip closures are supplied by `createReplayMask`.
   * Omitted means every command is executed, as direct frames always have. */
  commandMask?: CommandMask;
  /** Opt-in retained plan. Omitted direct frames do no compilation work. */
  compiled?: CompiledDrawList<ExecutorTexture | null>;
}

export interface CanvasExecutor {
  readonly gl: WebGL2RenderingContext;
  readonly stats: ExecutorStats;
  /** Texture units a batch can hold on THIS context. */
  readonly maxTextureSlots: number;
  /** Build the program and buffers now, off whatever critical path the caller
   *  cares about. `execute` does it lazily otherwise — and reading a shader's
   *  compile status BLOCKS on the driver (~100-250 ms on a phone), so paying it
   *  during the first frame is a visible hitch. */
  warmUp(): boolean;
  /** Draw one frame. Returns false when the program could not be built. */
  execute(
    list: DrawList<ExecutorTexture | null>,
    projection: StageProjection,
    options?: ExecuteOptions,
  ): boolean;
  /** Release executor-owned cached GPU buffers for one compiled plan. */
  releaseCompiled(plan: CompiledDrawList<ExecutorTexture | null>): void;
  /** The context is GONE: drop every GL object without calling into GL. The next
   *  `execute` rebuilds them. */
  invalidate(): void;
  /** Delete every GL object this executor owns. */
  dispose(): void;
}

interface Program {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  cornerBuffer: WebGLBuffer;
  instanceBuffer: WebGLBuffer;
  instanceBytes: number;
  uProjection: WebGLUniformLocation | null;
  uColorMatrices: WebGLUniformLocation | null;
  uRoundedRect: WebGLUniformLocation | null;
  uRoundedRadius: WebGLUniformLocation | null;
}

interface CachedGpuRun {
  start: number;
  end: number;
  blend: BlendMode;
  commands: Int32Array;
  textures: ExecutorTexture[];
  dimensions: Int32Array;
  itemsByTexture: number[][];
  colorMatrices: Float32Array;
  colorMatrixCount: number;
  instances: Float32Array;
  buffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
}

interface CachedGpuPlan {
  plan: CompiledDrawList<ExecutorTexture | null>;
  generation: number;
  contentRevision: number;
  runs: CachedGpuRun[];
  runsAt: (CachedGpuRun | null)[];
  runsForCommand: (CachedGpuRun | null)[];
  itemsForCommand: Int32Array;
}

/** The deliberately separate program for indexed triangle meshes. Meshes are
 * not coerced into instanced quads: arbitrary topology needs indexed triangles
 * and per-vertex UV interpolation. */
interface MeshProgram {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  vertexBytes: number;
  indexBytes: number;
  uProjection: WebGLUniformLocation | null;
  uTint: WebGLUniformLocation | null;
  uTexture: WebGLUniformLocation | null;
}

const VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 a_corner;   // unit-square corner, see INSTANCE_CORNERS_OFFSET
layout(location = 1) in vec4 a_p01;      // p0 (0,0), p1 (1,0)
layout(location = 2) in vec4 a_p23;      // p2 (1,1), p3 (0,1)
layout(location = 3) in vec4 a_uv;       // u0, v0, uSpan, vSpan
layout(location = 4) in vec4 a_color;    // PREMULTIPLIED tint
layout(location = 5) in vec2 a_slots;    // texture slot, colour-matrix slot
uniform vec4 u_projection;               // design -> clip: scale.xy, translate.xy
out vec2 v_uv;
out vec4 v_color;
out vec2 v_design;
flat out int v_texture;
flat out int v_matrix;
void main() {
  // BILINEAR across four explicit corners rather than an affine basis: see the
  // note in ./batcher. For the affine case (every sprite) this is exactly the
  // affine map; for a stroke segment it is the quadrilateral itself.
  vec2 top = mix(a_p01.xy, a_p01.zw, a_corner.x);
  vec2 bottom = mix(a_p23.zw, a_p23.xy, a_corner.x);
  vec2 design = mix(top, bottom, a_corner.y);
  gl_Position = vec4(design * u_projection.xy + u_projection.zw, 0.0, 1.0);
  v_uv = a_uv.xy + a_uv.zw * a_corner;
  v_color = a_color;
  v_design = design;
  v_texture = int(a_slots.x);
  v_matrix = int(a_slots.y);
}`;

const TEXTURED_MESH_VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;
uniform vec4 u_projection;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_position * u_projection.xy + u_projection.zw, 0.0, 1.0);
  v_uv = a_uv;
}`;

const TEXTURED_MESH_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform vec4 u_tint;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  // Both the uploaded texel and tint are premultiplied, so ordinary component
  // multiplication remains premultiplied for the shared blend contract.
  fragColor = texture(u_texture, v_uv) * u_tint;
}`;

/**
 * The fragment shader, generated for the slot counts THIS context supports.
 *
 * The `if` ladder is not laziness: GLSL ES 3.00 allows a sampler array to be
 * indexed only by a constant expression, so a dynamic slot has to be resolved by
 * comparison. (The colour-matrix array next to it is a plain uniform array, which
 * dynamic indexing IS allowed on.)
 *
 * `precision highp int` is load-bearing. The default integer precision is `highp`
 * in the vertex stage and `mediump` in the fragment stage, and a cross-stage
 * variable whose precision disagrees fails to LINK — silently, in the sense that
 * the only symptom is a program that does not exist and therefore a canvas that
 * draws nothing. `highp float` matters for a different reason: `mediump` carries
 * ~10 bits of mantissa, which cannot address a texel on a 4096-wide atlas page.
 */
function fragmentSource(textureSlots: number, colorMatrices: number): string {
  const ladder: string[] = [];
  for (let i = 0; i < textureSlots; i += 1) {
    ladder.push(
      `  ${i === 0 ? "if" : "} else if"} (slot == ${i}) {\n    return texture(u_textures[${i}], uv);`,
    );
  }
  ladder.push("  }");
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_textures[${textureSlots}];
uniform mat3 u_colorMatrices[${colorMatrices}];
uniform vec4 u_roundedRect;    // centre.xy, half-extent.xy, DESIGN units
uniform float u_roundedRadius; // <= 0 disables the rounded test entirely
in vec2 v_uv;
in vec4 v_color;
in vec2 v_design;
flat in int v_texture;
flat in int v_matrix;
out vec4 fragColor;

vec4 sampleSlot(int slot, vec2 uv) {
${ladder.join("\n")}
  return vec4(0.0);
}

void main() {
  if (u_roundedRadius > 0.0) {
    // Standard rounded-rect distance: shrink the box by the radius, take the
    // distance to that box, subtract the radius back.
    vec2 d = abs(v_design - u_roundedRect.xy) - (u_roundedRect.zw - vec2(u_roundedRadius));
    if (length(max(d, vec2(0.0))) - u_roundedRadius > 0.0) {
      discard;
    }
  }
  vec4 texel = sampleSlot(v_texture, v_uv);
  if (v_matrix != 0) {
    // The matrix is defined on the texture's OWN colour, so it has to see
    // straight (un-premultiplied) sRGB — apply it to premultiplied channels and a
    // half-transparent pixel is transformed as if it were half as bright. No
    // linearization: the same sRGB-domain transform html's applyColorMatrixToPixels
    // performs on the CPU, clamped for the same reason (it writes clamped bytes).
    float alpha = texel.a;
    vec3 straight = alpha > 0.0 ? texel.rgb / alpha : vec3(0.0);
    straight = clamp(u_colorMatrices[v_matrix] * straight, 0.0, 1.0);
    texel = vec4(straight * alpha, alpha);
  }
  // Two PREMULTIPLIED colours compose with a plain multiply, and the result is
  // premultiplied — which is what the blend factors and the canvas expect.
  fragColor = texel * v_color;
}`;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

// A local compile+link rather than `html/webgl/shared-gl`'s: that module's
// helpers are not on its package's public barrel, and widening the barrel to
// reach them would change a checked-in export surface for thirty lines. Same
// failure reporting: a link failure over a shader that did not compile is
// reported as the COMPILE failure it is, with the shader's own log.
function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSrc: string,
  fragmentSrc: string,
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (!linked) {
    let compileFailed = false;
    for (const shader of [vs, fs]) {
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) continue;
      compileFailed = true;
      console.warn(
        "[gsw canvas] shader compile failed:",
        gl.getShaderInfoLog(shader),
      );
    }
    if (!compileFailed) {
      console.warn(
        "[gsw canvas] program link failed:",
        gl.getProgramInfoLog(program),
      );
    }
    gl.deleteProgram(program);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return linked ? program : null;
}

/** `[x, y]` per corner, in TRIANGLE_STRIP order: `(0,0) (1,0) (0,1) (1,1)`, whose
 *  two triangles are `p0 p1 p3` and `p1 p3 p2`. A quad with `p2 === p3` therefore
 *  degenerates to exactly the triangle `p0 p1 p3` — how `./polyline` spells a join
 *  wedge without a second draw path. */
const CORNERS = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const NO_CHANGED_COMMANDS: readonly number[] = [];

interface InstanceAttribute {
  location: number;
  size: number;
  offset: number;
}

const INSTANCE_ATTRIBUTES: InstanceAttribute[] = [
  { location: 1, size: 4, offset: INSTANCE_CORNERS_OFFSET },
  { location: 2, size: 4, offset: INSTANCE_CORNERS_OFFSET + 4 },
  { location: 3, size: 4, offset: INSTANCE_UV_OFFSET },
  { location: 4, size: 4, offset: INSTANCE_COLOR_OFFSET },
  { location: 5, size: 2, offset: INSTANCE_SLOTS_OFFSET },
];

export function createCanvasExecutor(
  options: CanvasExecutorOptions,
): CanvasExecutor {
  const gl = options.gl;
  const contextUnits = Number(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)) || 8;
  const maxTextureSlots = Math.max(
    1,
    Math.min(
      MAX_TEXTURE_SLOTS,
      contextUnits,
      Math.floor(options.maxTextureSlots ?? MAX_TEXTURE_SLOTS),
    ),
  );
  const maxColorMatrices = Math.max(
    2,
    Math.floor(options.maxColorMatrices ?? 16),
  );

  let program: Program | null = null;
  let meshProgram: MeshProgram | null = null;
  let ownedWhite: ExecutorTexture | null = null;
  const suppliedWhite = options.white ?? null;
  const glyphPass = options.glyphs ?? null;

  const stats: ExecutorStats = {
    commands: 0,
    quads: 0,
    batches: 0,
    textureBinds: 0,
    scissorChanges: 0,
    blendChanges: 0,
    ninePatches: 0,
    ninePatchQuads: 0,
    polylines: 0,
    polylineQuads: 0,
    texturedMeshes: 0,
    texturedMeshTriangles: 0,
    texturedMeshDrawCalls: 0,
    glyphRuns: 0,
    glyphs: 0,
    glyphDrawCalls: 0,
    glyphRunBatches: 0,
    glyphRunBatchFallbacks: 0,
    glyphRunsDropped: 0,
    screenEffects: 0,
    screenEffectFailures: 0,
    externalEffects: 0,
    externalEffectFailures: 0,
    rotatedClipFallbacks: 0,
    unbalancedClipPops: 0,
    unknownCommands: 0,
    maxBatchQuads: 0,
    flushes: {
      textureSlots: 0,
      colorMatrices: 0,
      blend: 0,
      clip: 0,
      glyphs: 0,
      effects: 0,
      meshes: 0,
      compiled: 0,
      end: 0,
    },
    compiledPlanBuilds: 0,
    compiledPlanReuses: 0,
    compiledTemplateRangeUpdates: 0,
    reusedSelections: 0,
    reusedBatches: 0,
    compiledGpuFullUploads: 0,
    compiledGpuRangeUploads: 0,
    compiledCachedDrawCalls: 0,
  };

  const clipStack: ClipStack = createClipStack();
  const scissor: ScissorBox = createScissorBox();
  const damageScissor: ScissorBox = createScissorBox();
  const appliedScissor: ScissorBox = createScissorBox();
  let appliedRoundedRadius = -1;
  /** The rounded-clip rect last uploaded: centre.xy, half-extent.xy. */
  const appliedRounded = new Float32Array(4);
  let appliedBlend: BlendMode | null = null;

  const quadView = createQuadView();
  const patchView = createNinePatchView();
  const lineView = createPolylineView(64);
  const clipView = createClipRectView();
  const glyphsView = createGlyphsView(64);
  // `readGlyphs` fills caller-owned views. Keep a grow-only pool so an adjacent-run batch does
  // not turn a retained replay into per-frame garbage.
  const glyphRunViewPool: GlyphsView[] = [];
  const glyphRunViews: GlyphsView[] = [];
  const texturedMeshView = createTexturedMeshView(64, 96);
  const bands: NinePatchBand[] = createNinePatchBands();
  let strokeQuads = new Float32Array(256 * POLYLINE_QUAD_FLOATS);
  // `x, y, u, v` per vertex, transformed into design space before upload. It is
  // grow-only like the batcher's arena, so retained replay settles at zero
  // allocations after its largest mesh has been seen.
  let meshVertices = new Float32Array(64 * 4);

  const batcher: QuadBatcher = createQuadBatcher({
    maxTextureSlots,
    maxColorMatrices,
    quadCapacity: options.quadCapacity,
    draw: drawBatch,
  });
  const compiledGpuPlans = new WeakMap<
    CompiledDrawList<ExecutorTexture | null>,
    CachedGpuPlan
  >();
  const liveCompiledGpuPlans = new Set<CachedGpuPlan>();
  const cachedQuad = createQuadInstance();

  function whiteTexture(): ExecutorTexture {
    if (suppliedWhite) return suppliedWhite;
    if (ownedWhite) return ownedWhite;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    ownedWhite = { texture, width: 1, height: 1 };
    return ownedWhite;
  }

  function ensureProgram(): Program | null {
    if (program) return program;
    const linked = linkProgram(
      gl,
      VERTEX_SRC,
      fragmentSource(maxTextureSlots, maxColorMatrices),
    );
    if (!linked) return null;
    const vao = gl.createVertexArray();
    const cornerBuffer = gl.createBuffer();
    const instanceBuffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const strideBytes = INSTANCE_FLOATS * 4;
    for (const attribute of INSTANCE_ATTRIBUTES) {
      gl.enableVertexAttribArray(attribute.location);
      gl.vertexAttribPointer(
        attribute.location,
        attribute.size,
        gl.FLOAT,
        false,
        strideBytes,
        attribute.offset * 4,
      );
      gl.vertexAttribDivisor(attribute.location, 1);
    }
    gl.bindVertexArray(null);

    gl.useProgram(linked);
    // The sampler uniforms are set ONCE: slot i is always unit i, for the life of
    // the program. Only the BINDINGS change per batch.
    const units = new Int32Array(maxTextureSlots);
    for (let i = 0; i < maxTextureSlots; i += 1) units[i] = i;
    const uTextures = gl.getUniformLocation(linked, "u_textures[0]");
    if (uTextures) gl.uniform1iv(uTextures, units);

    program = {
      program: linked,
      vao,
      cornerBuffer,
      instanceBuffer,
      instanceBytes: 0,
      uProjection: gl.getUniformLocation(linked, "u_projection"),
      uColorMatrices: gl.getUniformLocation(linked, "u_colorMatrices[0]"),
      uRoundedRect: gl.getUniformLocation(linked, "u_roundedRect"),
      uRoundedRadius: gl.getUniformLocation(linked, "u_roundedRadius"),
    };
    return program;
  }

  function ensureMeshProgram(): MeshProgram | null {
    if (meshProgram) return meshProgram;
    const linked = linkProgram(
      gl,
      TEXTURED_MESH_VERTEX_SRC,
      TEXTURED_MESH_FRAGMENT_SRC,
    );
    if (!linked) return null;
    const vao = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bindVertexArray(null);
    gl.useProgram(linked);
    const uTexture = gl.getUniformLocation(linked, "u_texture");
    if (uTexture) gl.uniform1i(uTexture, 0);
    meshProgram = {
      program: linked,
      vao,
      vertexBuffer,
      indexBuffer,
      vertexBytes: 0,
      indexBytes: 0,
      uProjection: gl.getUniformLocation(linked, "u_projection"),
      uTint: gl.getUniformLocation(linked, "u_tint"),
      uTexture,
    };
    return meshProgram;
  }

  function drawBatch(batch: Batch): void {
    const current = program;
    if (!current) return;
    const floats = batch.quadCount * INSTANCE_FLOATS;
    const bytes = floats * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, current.instanceBuffer);
    if (current.instanceBytes < bytes) {
      // Grow-only, and orphaning: a fresh `bufferData` also tells the driver the
      // old contents are dead, so it never has to wait for the previous draw to
      // finish reading them.
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
      current.instanceBytes = bytes;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.instances, 0, floats);

    for (let slot = 0; slot < batch.textureCount; slot += 1) {
      const entry = batch.textures[slot];
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, entry ? entry.texture : null);
    }
    if (batch.colorMatrixCount > 1 && current.uColorMatrices) {
      // `transpose = true`: the draw list stores matrices ROW-major and GLSL reads
      // them column-major, so `m * v` only means what it reads as if the upload
      // transposes. (WebGL2 permits a true transpose; WebGL1 did not.)
      gl.uniformMatrix3fv(
        current.uColorMatrices,
        true,
        batch.colorMatrices,
        0,
        batch.colorMatrixCount * COLOR_MATRIX_FLOATS,
      );
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.quadCount);
    stats.batches += 1;
    stats.textureBinds += batch.textureCount;
    if (batch.quadCount > stats.maxBatchQuads) {
      stats.maxBatchQuads = batch.quadCount;
    }
    stats.flushes[batch.reason] += 1;
  }

  function releaseGpuPlan(cache: CachedGpuPlan, deleteGl: boolean): void {
    if (deleteGl) {
      for (const run of cache.runs) {
        gl.deleteBuffer(run.buffer);
        gl.deleteVertexArray(run.vao);
      }
    }
    compiledGpuPlans.delete(cache.plan);
    liveCompiledGpuPlans.delete(cache);
  }

  function makeCachedVao(
    current: Program,
    buffer: WebGLBuffer,
  ): WebGLVertexArrayObject | null {
    const vao = gl.createVertexArray();
    if (!vao) return null;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, current.cornerBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const strideBytes = INSTANCE_FLOATS * 4;
    for (const attribute of INSTANCE_ATTRIBUTES) {
      gl.enableVertexAttribArray(attribute.location);
      gl.vertexAttribPointer(
        attribute.location,
        attribute.size,
        gl.FLOAT,
        false,
        strideBytes,
        attribute.offset * 4,
      );
      gl.vertexAttribDivisor(attribute.location, 1);
    }
    gl.bindVertexArray(current.vao);
    return vao;
  }

  function matrixSlot(
    matrices: Float32Array,
    count: number,
    source: Float32Array,
    sourceOffset: number,
  ): number {
    for (let slot = 0; slot < count; slot += 1) {
      if (
        colorMatricesEqual(
          matrices,
          slot * COLOR_MATRIX_FLOATS,
          source,
          sourceOffset,
        )
      )
        return slot;
    }
    return -1;
  }

  function writeCachedQuad(
    run: CachedGpuRun,
    item: number,
    index: number,
    plan: CompiledDrawList<ExecutorTexture | null>,
    textureSlot: number,
    matrixSlotIndex: number,
  ): void {
    const texture = run.textures[textureSlot];
    plan.fillQuad(index, texture.width, texture.height, cachedQuad);
    const at = item * INSTANCE_FLOATS;
    run.instances[at] = cachedQuad.x0;
    run.instances[at + 1] = cachedQuad.y0;
    run.instances[at + 2] = cachedQuad.x1;
    run.instances[at + 3] = cachedQuad.y1;
    run.instances[at + 4] = cachedQuad.x2;
    run.instances[at + 5] = cachedQuad.y2;
    run.instances[at + 6] = cachedQuad.x3;
    run.instances[at + 7] = cachedQuad.y3;
    run.instances[at + 8] = cachedQuad.u0;
    run.instances[at + 9] = cachedQuad.v0;
    run.instances[at + 10] = cachedQuad.uSpan;
    run.instances[at + 11] = cachedQuad.vSpan;
    run.instances[at + 12] = cachedQuad.r;
    run.instances[at + 13] = cachedQuad.g;
    run.instances[at + 14] = cachedQuad.b;
    run.instances[at + 15] = cachedQuad.a;
    run.instances[at + 16] = textureSlot;
    run.instances[at + 17] = matrixSlotIndex;
  }

  function buildGpuPlan(
    plan: CompiledDrawList<ExecutorTexture | null>,
    current: Program,
    generation: number,
    contentRevision: number,
  ): CachedGpuPlan | null {
    const list = plan.list;
    const runs: CachedGpuRun[] = [];
    const runsAt: (CachedGpuRun | null)[] = new Array(list.count).fill(null);
    const runsForCommand: (CachedGpuRun | null)[] = new Array(list.count).fill(
      null,
    );
    const itemsForCommand = new Int32Array(list.count);
    const discardPartial = (): void => {
      for (const run of runs) {
        gl.deleteBuffer(run.buffer);
        gl.deleteVertexArray(run.vao);
      }
    };
    for (const descriptor of plan.batches) {
      let cursor = descriptor.start;
      while (cursor < descriptor.end) {
        const commandIndexes: number[] = [];
        const textures: ExecutorTexture[] = [];
        const matrices = new Float32Array(
          maxColorMatrices * COLOR_MATRIX_FLOATS,
        );
        matrices.set(IDENTITY_COLOR_MATRIX);
        let matrixCount = 1;
        while (cursor < descriptor.end) {
          const texture = list.textureAt(cursor) ?? whiteTexture();
          let textureSlot = textures.indexOf(texture);
          if (textureSlot < 0 && textures.length >= maxTextureSlots) break;
          const matrixIndex = list.colorMatrixIndexAt(cursor);
          let slot = 0;
          if (matrixIndex >= 0) {
            slot = matrixSlot(
              matrices,
              matrixCount,
              list.colorMatrices,
              matrixIndex * COLOR_MATRIX_FLOATS,
            );
            if (slot < 0 && matrixCount >= maxColorMatrices) break;
          }
          if (textureSlot < 0) {
            textureSlot = textures.length;
            textures.push(texture);
          }
          if (matrixIndex >= 0 && slot < 0) {
            slot = matrixCount;
            matrices.set(
              list.colorMatrices.subarray(
                matrixIndex * COLOR_MATRIX_FLOATS,
                (matrixIndex + 1) * COLOR_MATRIX_FLOATS,
              ),
              slot * COLOR_MATRIX_FLOATS,
            );
            matrixCount += 1;
          }
          commandIndexes.push(cursor);
          cursor += 1;
        }
        const buffer = gl.createBuffer();
        if (!buffer) {
          discardPartial();
          return null;
        }
        const vao = makeCachedVao(current, buffer);
        if (!vao) {
          gl.deleteBuffer(buffer);
          discardPartial();
          return null;
        }
        const commands = Int32Array.from(commandIndexes);
        const run: CachedGpuRun = {
          start: commands[0],
          end: commands[commands.length - 1] + 1,
          blend: descriptor.blend,
          commands,
          textures,
          dimensions: new Int32Array(textures.length * 2),
          itemsByTexture: textures.map(() => []),
          colorMatrices: matrices.subarray(
            0,
            matrixCount * COLOR_MATRIX_FLOATS,
          ),
          colorMatrixCount: matrixCount,
          instances: new Float32Array(commands.length * INSTANCE_FLOATS),
          buffer,
          vao,
        };
        for (let item = 0; item < commands.length; item += 1) {
          const index = commands[item];
          const textureSlot = textures.indexOf(
            list.textureAt(index) ?? whiteTexture(),
          );
          const matrixIndex = list.colorMatrixIndexAt(index);
          const slot =
            matrixIndex < 0
              ? 0
              : matrixSlot(
                  run.colorMatrices,
                  matrixCount,
                  list.colorMatrices,
                  matrixIndex * COLOR_MATRIX_FLOATS,
                );
          writeCachedQuad(run, item, index, plan, textureSlot, slot);
          run.itemsByTexture[textureSlot].push(item);
        }
        for (let slot = 0; slot < textures.length; slot += 1) {
          run.dimensions[slot * 2] = textures[slot].width;
          run.dimensions[slot * 2 + 1] = textures[slot].height;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, run.instances, gl.DYNAMIC_DRAW);
        stats.compiledGpuFullUploads += 1;
        runs.push(run);
        runsAt[run.start] = run;
        for (let item = 0; item < run.commands.length; item += 1) {
          const index = run.commands[item];
          runsForCommand[index] = run;
          itemsForCommand[index] = item;
        }
      }
    }
    gl.bindVertexArray(current.vao);
    const cache = {
      plan,
      generation,
      contentRevision,
      runs,
      runsAt,
      runsForCommand,
      itemsForCommand,
    };
    compiledGpuPlans.set(plan, cache);
    liveCompiledGpuPlans.add(cache);
    return cache;
  }

  function updateGpuPlan(
    cache: CachedGpuPlan,
    current: Program,
    changedCommands: readonly number[],
    contentRevision: number,
  ): CachedGpuPlan | null {
    const list = cache.plan.list;
    const updateItem = (run: CachedGpuRun, item: number): boolean => {
      const index = run.commands[item];
      const texture = list.textureAt(index) ?? whiteTexture();
      const textureSlot = run.textures.indexOf(texture);
      if (textureSlot < 0) return false;
      // A source can switch to a texture that is already resident in this run.
      // The slot table still changed for this item, and its old membership list
      // would miss later dimension changes, so rebuild the cache conservatively.
      if (
        run.instances[item * INSTANCE_FLOATS + INSTANCE_SLOTS_OFFSET] !==
        textureSlot
      )
        return false;
      const matrixIndex = list.colorMatrixIndexAt(index);
      const matrixSlotIndex =
        matrixIndex < 0
          ? 0
          : matrixSlot(
              run.colorMatrices,
              run.colorMatrixCount,
              list.colorMatrices,
              matrixIndex * COLOR_MATRIX_FLOATS,
            );
      if (matrixSlotIndex < 0) return false;
      writeCachedQuad(
        run,
        item,
        index,
        cache.plan,
        textureSlot,
        matrixSlotIndex,
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, run.buffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        item * INSTANCE_FLOATS * 4,
        run.instances,
        item * INSTANCE_FLOATS,
        INSTANCE_FLOATS,
      );
      stats.compiledGpuRangeUploads += 1;
      return true;
    };
    for (const index of changedCommands) {
      const run = cache.runsForCommand[index];
      if (!run) continue;
      if (!updateItem(run, cache.itemsForCommand[index])) {
        releaseGpuPlan(cache, true);
        return buildGpuPlan(
          cache.plan,
          current,
          cache.generation,
          contentRevision,
        );
      }
    }
    // Texture dimensions can change outside DrawList patch APIs. This walks only
    // the distinct textures in each cached run, then touches their recorded items.
    for (const run of cache.runs) {
      for (let slot = 0; slot < run.textures.length; slot += 1) {
        const texture = run.textures[slot];
        if (
          run.dimensions[slot * 2] === texture.width &&
          run.dimensions[slot * 2 + 1] === texture.height
        )
          continue;
        run.dimensions[slot * 2] = texture.width;
        run.dimensions[slot * 2 + 1] = texture.height;
        for (const item of run.itemsByTexture[slot]) {
          if (!updateItem(run, item)) {
            releaseGpuPlan(cache, true);
            return buildGpuPlan(
              cache.plan,
              current,
              cache.generation,
              contentRevision,
            );
          }
        }
      }
    }
    gl.bindVertexArray(current.vao);
    cache.contentRevision = contentRevision;
    return cache;
  }

  function drawCachedRange(
    run: CachedGpuRun,
    first: number,
    count: number,
    current: Program,
  ): void {
    applyBlend(run.blend);
    gl.bindVertexArray(run.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, run.buffer);
    const strideBytes = INSTANCE_FLOATS * 4;
    for (const attribute of INSTANCE_ATTRIBUTES) {
      gl.vertexAttribPointer(
        attribute.location,
        attribute.size,
        gl.FLOAT,
        false,
        strideBytes,
        first * strideBytes + attribute.offset * 4,
      );
    }
    for (let slot = 0; slot < run.textures.length; slot += 1) {
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, run.textures[slot].texture);
    }
    if (run.colorMatrixCount > 1 && current.uColorMatrices) {
      gl.uniformMatrix3fv(
        current.uColorMatrices,
        true,
        run.colorMatrices,
        0,
        run.colorMatrixCount * COLOR_MATRIX_FLOATS,
      );
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    stats.batches += 1;
    stats.textureBinds += run.textures.length;
    stats.quads += count;
    stats.maxBatchQuads = Math.max(stats.maxBatchQuads, count);
    stats.compiledCachedDrawCalls += 1;
    gl.bindVertexArray(current.vao);
  }

  /**
   * Forget everything this executor believes about the GL state it set.
   *
   * TWO CALLERS, ONE RULE: it does not own the context. `execute` calls it on entry because
   * something else may have drawn into the context since the last frame, and the glyph pass path
   * calls it on the way back because something else just did, in the middle of this one. Every
   * cached value here guards a GL call that would otherwise be skipped, so a stale cache is not a
   * redundant call — it is a call that never happens and state that is silently somebody else's.
   *
   * `appliedBlend` is the one that bites hardest today: `@godot-scene-web/hb-gpu` sets the
   * NON-separate `blendEquation`/`blendFunc`, which write both the RGB and the alpha halves, so
   * without this the next quad keeps the glyph pass's blend and nothing errors.
   */
  function invalidateAppliedState(): void {
    appliedBlend = null;
    appliedRoundedRadius = -1;
    appliedScissor.x = -1;
    appliedScissor.y = -1;
    appliedScissor.width = -1;
    appliedScissor.height = -1;
  }

  function applyBlend(blend: BlendMode): void {
    if (blend === appliedBlend) return;
    batcher.setBlend(blend);
    const state = blendStateFor(blend);
    gl.blendEquationSeparate(
      gl[state.equationRgb] as number,
      gl[state.equationAlpha] as number,
    );
    gl.blendFuncSeparate(
      gl[state.srcRgb] as number,
      gl[state.dstRgb] as number,
      gl[state.srcAlpha] as number,
      gl[state.dstAlpha] as number,
    );
    appliedBlend = blend;
    stats.blendChanges += 1;
  }

  function applyClip(
    transform: PixelTransform,
    width: number,
    height: number,
    damage?: DamageRect,
  ): void {
    clipStack.scissor(transform, width, height, scissor);
    if (damage) {
      const left = Math.max(0, Math.min(width, Math.floor(damage.x)));
      const right = Math.max(
        left,
        Math.min(width, Math.ceil(damage.x + damage.width)),
      );
      const top = Math.max(0, Math.min(height, Math.floor(damage.y)));
      const bottom = Math.max(
        top,
        Math.min(height, Math.ceil(damage.y + damage.height)),
      );
      damageScissor.x = left;
      damageScissor.y = height - bottom;
      damageScissor.width = right - left;
      damageScissor.height = bottom - top;
      const clippedRight = Math.min(scissor.x + scissor.width, right);
      const clippedTop = Math.max(scissor.y, damageScissor.y);
      const clippedBottom = Math.min(
        scissor.y + scissor.height,
        damageScissor.y + damageScissor.height,
      );
      scissor.x = Math.max(scissor.x, left);
      scissor.y = clippedTop;
      scissor.width = Math.max(0, clippedRight - scissor.x);
      scissor.height = Math.max(0, clippedBottom - clippedTop);
    }
    if (
      scissor.x !== appliedScissor.x ||
      scissor.y !== appliedScissor.y ||
      scissor.width !== appliedScissor.width ||
      scissor.height !== appliedScissor.height
    ) {
      gl.scissor(scissor.x, scissor.y, scissor.width, scissor.height);
      appliedScissor.x = scissor.x;
      appliedScissor.y = scissor.y;
      appliedScissor.width = scissor.width;
      appliedScissor.height = scissor.height;
      stats.scissorChanges += 1;
    }
    const current = program;
    if (!current) return;
    const rounded = clipStack.rounded();
    const radius = rounded ? rounded.radius : 0;
    const centerX = rounded ? rounded.centerX : 0;
    const centerY = rounded ? rounded.centerY : 0;
    const halfWidth = rounded ? rounded.halfWidth : 0;
    const halfHeight = rounded ? rounded.halfHeight : 0;
    if (
      radius === appliedRoundedRadius &&
      centerX === appliedRounded[0] &&
      centerY === appliedRounded[1] &&
      halfWidth === appliedRounded[2] &&
      halfHeight === appliedRounded[3]
    ) {
      return;
    }
    if (current.uRoundedRadius) gl.uniform1f(current.uRoundedRadius, radius);
    if (current.uRoundedRect) {
      gl.uniform4f(
        current.uRoundedRect,
        centerX,
        centerY,
        halfWidth,
        halfHeight,
      );
    }
    appliedRoundedRadius = radius;
    appliedRounded[0] = centerX;
    appliedRounded[1] = centerY;
    appliedRounded[2] = halfWidth;
    appliedRounded[3] = halfHeight;
  }

  // ---- per-command emission -------------------------------------------------
  //
  // All of these write through the batcher's ONE staging instance, so a frame of
  // any size allocates nothing after the arenas have settled.

  /**
   * Emit one rect of a command: `localX..localH` is the destination in the
   * command's own local space (`0..w` by `0..h`), which `m` maps into design
   * space; `srcX..srcH` is the source in page pixels.
   */
  function emitRect(
    m: Float32Array,
    localX: number,
    localY: number,
    localW: number,
    localH: number,
    srcX: number,
    srcY: number,
    srcW: number,
    srcH: number,
    texture: ExecutorTexture,
    flipH: boolean,
    flipV: boolean,
    r: number,
    g: number,
    b: number,
    a: number,
    colorMatrix: ArrayLike<number> | null,
    colorMatrixOffset: number,
  ): void {
    const quad = batcher.quad;
    const x1 = localX + localW;
    const y1 = localY + localH;
    const xx = m[0];
    const xy = m[1];
    const yx = m[2];
    const yy = m[3];
    const ox = m[4];
    const oy = m[5];
    quad.x0 = xx * localX + yx * localY + ox;
    quad.y0 = xy * localX + yy * localY + oy;
    quad.x1 = xx * x1 + yx * localY + ox;
    quad.y1 = xy * x1 + yy * localY + oy;
    quad.x2 = xx * x1 + yx * y1 + ox;
    quad.y2 = xy * x1 + yy * y1 + oy;
    quad.x3 = xx * localX + yx * y1 + ox;
    quad.y3 = xy * localX + yy * y1 + oy;

    // Page pixels -> normalized. A ZERO-span source is left alone rather than
    // widened to the whole texture: it means "stretch this one texel", which is
    // exactly what an untextured solid fill on the white texel wants.
    const invW = 1 / Math.max(1, texture.width);
    const invH = 1 / Math.max(1, texture.height);
    let u0 = srcX * invW;
    let v0 = srcY * invH;
    let uSpan = srcW * invW;
    let vSpan = srcH * invH;
    if (flipH) {
      u0 += uSpan;
      uSpan = -uSpan;
    }
    if (flipV) {
      v0 += vSpan;
      vSpan = -vSpan;
    }
    quad.u0 = u0;
    quad.v0 = v0;
    quad.uSpan = uSpan;
    quad.vSpan = vSpan;
    quad.r = r;
    quad.g = g;
    quad.b = b;
    quad.a = a;
    batcher.push(texture, colorMatrix, colorMatrixOffset);
    stats.quads += 1;
  }

  function emitQuadCommand(
    list: DrawList<ExecutorTexture | null>,
    index: number,
    compiled: CompiledDrawList<ExecutorTexture | null> | undefined,
  ): void {
    const texture = list.textureAt(index) ?? whiteTexture();
    if (
      compiled?.fillQuad(index, texture.width, texture.height, batcher.quad)
    ) {
      applyBlend(list.ints[list.intOffsetAt(index)] as BlendMode);
      const matrixIndex = list.colorMatrixIndexAt(index);
      batcher.push(
        texture,
        matrixIndex >= 0 ? list.colorMatrices : null,
        matrixIndex >= 0 ? matrixIndex * COLOR_MATRIX_FLOATS : 0,
      );
      stats.quads += 1;
      return;
    }
    list.readQuad(index, quadView);
    applyBlend(quadView.blend);
    emitRect(
      quadView.m,
      0,
      0,
      quadView.w,
      quadView.h,
      quadView.srcX,
      quadView.srcY,
      quadView.srcW,
      quadView.srcH,
      texture,
      quadView.flipH,
      quadView.flipV,
      quadView.r,
      quadView.g,
      quadView.b,
      quadView.a,
      quadView.hasColorMatrix ? quadView.colorMatrix : null,
      0,
    );
  }

  function emitNinePatchCommand(
    list: DrawList<ExecutorTexture | null>,
    index: number,
  ): void {
    list.readNinePatch(index, patchView);
    applyBlend(patchView.blend);
    const texture = list.textureAt(index) ?? whiteTexture();
    const count = expandNinePatch(patchView, bands);
    stats.ninePatches += 1;
    stats.ninePatchQuads += count;
    for (let i = 0; i < count; i += 1) {
      const band = bands[i];
      // A horizontal flip mirrors the PATCH, so both the band's place in the
      // destination and its own source have to turn over; mirroring only the
      // source would flip each band inside itself and leave the corners where
      // they were. (For a plain quad the same expression is a no-op, which is why
      // there is one code path.)
      const localX = patchView.flipH
        ? patchView.w - band.dstX - band.dstW
        : band.dstX;
      const localY = patchView.flipV
        ? patchView.h - band.dstY - band.dstH
        : band.dstY;
      emitRect(
        patchView.m,
        localX,
        localY,
        band.dstW,
        band.dstH,
        band.srcX,
        band.srcY,
        band.srcW,
        band.srcH,
        texture,
        patchView.flipH,
        patchView.flipV,
        patchView.r,
        patchView.g,
        patchView.b,
        patchView.a,
        patchView.hasColorMatrix ? patchView.colorMatrix : null,
        0,
      );
    }
  }

  function emitPolylineCommand(
    list: DrawList<ExecutorTexture | null>,
    index: number,
  ): void {
    list.readPolyline(index, lineView);
    // The IR gives a polyline no blend mode of its own; a stroke is normal alpha
    // compositing, which is what Godot's `draw_polyline` does too.
    applyBlend(BLEND_MIX);
    const white = whiteTexture();
    const needed =
      Math.max(0, 2 * lineView.pointCount - 3) * POLYLINE_QUAD_FLOATS;
    if (strokeQuads.length < needed) {
      strokeQuads = new Float32Array(Math.max(needed, strokeQuads.length * 2));
    }
    const count = expandPolyline(
      lineView.points,
      lineView.pointCount,
      lineView.width,
      strokeQuads,
      0,
    );
    stats.polylines += 1;
    stats.polylineQuads += count;
    const quad = batcher.quad;
    for (let i = 0; i < count; i += 1) {
      const at = i * POLYLINE_QUAD_FLOATS;
      // Stroke geometry is already in DESIGN space, so it bypasses `emitRect`'s
      // local->design map rather than being handed an identity transform.
      quad.x0 = strokeQuads[at];
      quad.y0 = strokeQuads[at + 1];
      quad.x1 = strokeQuads[at + 2];
      quad.y1 = strokeQuads[at + 3];
      quad.x2 = strokeQuads[at + 4];
      quad.y2 = strokeQuads[at + 5];
      quad.x3 = strokeQuads[at + 6];
      quad.y3 = strokeQuads[at + 7];
      quad.u0 = 0;
      quad.v0 = 0;
      quad.uSpan = 0;
      quad.vSpan = 0;
      quad.r = lineView.r;
      quad.g = lineView.g;
      quad.b = lineView.b;
      quad.a = lineView.a;
      batcher.push(white, null, 0);
      stats.quads += 1;
    }
  }

  /**
   * Execute one true indexed mesh between quad batches. The flush is before any
   * state mutation, preserving painter order. The mesh then borrows the context
   * only long enough to upload its pooled data and draw; program and VAO are
   * rebound to the quad executor before returning, while blend/scissor remain
   * the executor's own known state for the next command.
   */
  function emitTexturedMeshCommand(
    list: DrawList<ExecutorTexture | null>,
    index: number,
    projection: StageProjection,
    current: Program,
  ): void {
    batcher.flush("meshes");
    list.readTexturedMesh(index, texturedMeshView);
    applyBlend(texturedMeshView.blend);
    stats.texturedMeshes += 1;
    if (texturedMeshView.indexCount === 0) return;
    const mesh = ensureMeshProgram();
    if (!mesh) return;
    const vertexFloats = texturedMeshView.vertexCount * 4;
    if (meshVertices.length < vertexFloats) {
      meshVertices = new Float32Array(
        Math.max(vertexFloats, meshVertices.length * 2),
      );
    }
    const m = texturedMeshView.m;
    for (let vertex = 0; vertex < texturedMeshView.vertexCount; vertex += 1) {
      const source = vertex * 2;
      const target = vertex * 4;
      const x = texturedMeshView.positions[source];
      const y = texturedMeshView.positions[source + 1];
      meshVertices[target] = m[0] * x + m[2] * y + m[4];
      meshVertices[target + 1] = m[1] * x + m[3] * y + m[5];
      meshVertices[target + 2] = texturedMeshView.uvs[source];
      meshVertices[target + 3] = texturedMeshView.uvs[source + 1];
    }
    gl.bindVertexArray(mesh.vao);
    gl.useProgram(mesh.program);
    if (mesh.uProjection) {
      gl.uniform4f(
        mesh.uProjection,
        projection.toClip[0],
        projection.toClip[1],
        projection.toClip[2],
        projection.toClip[3],
      );
    }
    if (mesh.uTint) {
      gl.uniform4f(
        mesh.uTint,
        texturedMeshView.r,
        texturedMeshView.g,
        texturedMeshView.b,
        texturedMeshView.a,
      );
    }
    const vertexBytes = vertexFloats * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertexBuffer);
    if (mesh.vertexBytes < vertexBytes) {
      gl.bufferData(gl.ARRAY_BUFFER, vertexBytes, gl.DYNAMIC_DRAW);
      mesh.vertexBytes = vertexBytes;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, meshVertices, 0, vertexFloats);
    const indexBytes = texturedMeshView.indexCount * 4;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
    if (mesh.indexBytes < indexBytes) {
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexBytes, gl.DYNAMIC_DRAW);
      mesh.indexBytes = indexBytes;
    }
    gl.bufferSubData(
      gl.ELEMENT_ARRAY_BUFFER,
      0,
      texturedMeshView.indices,
      0,
      texturedMeshView.indexCount,
    );
    const texture = list.textureAt(index) ?? whiteTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture.texture);
    gl.drawElements(
      gl.TRIANGLES,
      texturedMeshView.indexCount,
      gl.UNSIGNED_INT,
      0,
    );
    stats.texturedMeshTriangles += texturedMeshView.indexCount / 3;
    stats.texturedMeshDrawCalls += 1;
    // Mesh setup replaces both bindings, just like a glyph pass. The quad
    // program's blend/scissor state deliberately stays live and cached.
    gl.bindVertexArray(current.vao);
    gl.useProgram(current.program);
  }

  /**
   * Hand one glyph run to the installed pass, then put the context back the way it was.
   *
   * THE ORDER IS THE MODULE'S OWN RULE (see the note at the top of this file): a flush DRAWS with
   * whatever GL state is live, so the pending batch has to go out BEFORE the pass replaces the
   * program and the vertex array — never after. Doing it the other way round draws this frame's
   * quads through a glyph shader, which is a blank rectangle rather than anything that reads as an
   * ordering bug.
   *
   * WHAT IS RESTORED, AND WHY EACH ONE IS NEEDED. `drawBatch` re-binds `ARRAY_BUFFER` and its
   * textures per batch, so those look after themselves; the VAO and the program are bound ONCE per
   * frame, and a pass that leaves the VAO unbound (hb-gpu's `end` does exactly that, deliberately,
   * because WebGL2 has no cheap read-back of the binding) would make the next `drawArraysInstanced`
   * read attributes from nothing. The cached state goes through
   * {@link invalidateAppliedState} rather than being re-applied eagerly, so a run followed by
   * nothing costs no GL calls at all.
   *
   * NOT restored, because the pass is forbidden to touch it: `SCISSOR_TEST`, the scissor box and
   * the viewport. That is what makes a clip rect clip a glyph run.
   */
  function emitGlyphsCommand(
    list: DrawList<ExecutorTexture | null>,
    index: number,
    projection: StageProjection,
    current: Program,
  ): void {
    if (!glyphPass) {
      // NOT a flush. With no pass, nothing is drawn and no GL state moves, so breaking the batch
      // here would cost a draw call to accomplish nothing. The run is counted instead.
      stats.glyphRunsDropped += 1;
      return;
    }
    batcher.flush("glyphs");
    list.readGlyphs(index, glyphsView);
    const drawn = glyphPass.drawRun(glyphsView, projection);
    stats.glyphRuns += 1;
    stats.glyphs += drawn.glyphs;
    stats.glyphDrawCalls += drawn.drawCalls;
    gl.bindVertexArray(current.vao);
    gl.useProgram(current.program);
    // hb-gpu deliberately does not touch the executor-owned scissor or its rounded-clip
    // uniform; renderer tests pin that boundary. It does replace blend state, so invalidate only
    // the cache which would otherwise suppress the required restoration.
    appliedBlend = null;
  }

  function emitAdjacentGlyphCommands(
    list: DrawList<ExecutorTexture | null>,
    firstIndex: number,
    projection: StageProjection,
    current: Program,
    commandMask: CommandMask | undefined,
  ): number {
    if (!glyphPass || !options.batchAdjacentGlyphRuns || !glyphPass.drawRuns) {
      emitGlyphsCommand(list, firstIndex, projection, current);
      return firstIndex;
    }

    let count = 0;
    for (let index = firstIndex; index < list.count; index += 1) {
      // A mask gap is a painter-order boundary for retained replay: the skipped command has not
      // been selected for this dirty region, so do not silently make two remaining commands look
      // adjacent. Clips/masks and every other kind fail this same exact test.
      if (
        list.kindAt(index) !== DRAW_GLYPHS ||
        (commandMask && !commandMask.includes(index))
      ) {
        break;
      }
      let view = glyphRunViewPool[count];
      if (!view) {
        view = createGlyphsView(64);
        glyphRunViewPool.push(view);
      }
      list.readGlyphs(index, view);
      count += 1;
    }
    if (count < 2) {
      emitGlyphsCommand(list, firstIndex, projection, current);
      return firstIndex;
    }

    glyphRunViews.length = count;
    for (let i = 0; i < count; i += 1) glyphRunViews[i] = glyphRunViewPool[i]!;
    if (glyphPass.canBatchRuns && !glyphPass.canBatchRuns(glyphRunViews)) {
      stats.glyphRunBatchFallbacks += 1;
      emitGlyphsCommand(list, firstIndex, projection, current);
      return firstIndex;
    }
    batcher.flush("glyphs");
    const drawn = glyphPass.drawRuns(glyphRunViews, projection);
    stats.glyphRuns += count;
    stats.glyphs += drawn.glyphs;
    stats.glyphDrawCalls += drawn.drawCalls;
    stats.glyphRunBatches += 1;
    gl.bindVertexArray(current.vao);
    gl.useProgram(current.program);
    appliedBlend = null;
    return firstIndex + count - 1;
  }

  function emitScreenEffectCommand(
    list: DrawList<ExecutorTexture | null>,
    index: number,
    projection: StageProjection,
    damage: DamageRect | undefined,
    current: Program,
  ): boolean {
    const effect = list.screenEffectAt(index);
    if (!effect) {
      stats.unknownCommands += 1;
      return false;
    }
    batcher.flush("effects");
    const framebuffer = gl.getParameter(
      gl.DRAW_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const succeeded = effect.execute({
      gl,
      framebuffer,
      width: projection.framebufferWidth,
      height: projection.framebufferHeight,
      damage,
      scissor: appliedScissor,
    });
    if (succeeded) stats.screenEffects += 1;
    else stats.screenEffectFailures += 1;
    // The pass may replace every binding/state. Resume exactly as the executor's
    // next command expects; active clip and damage are reapplied, not guessed.
    gl.bindVertexArray(current.vao);
    gl.useProgram(current.program);
    gl.viewport(
      0,
      0,
      projection.framebufferWidth,
      projection.framebufferHeight,
    );
    gl.enable(gl.SCISSOR_TEST);
    invalidateAppliedState();
    applyClip(
      projection.toFramebuffer,
      projection.framebufferWidth,
      projection.framebufferHeight,
      damage,
    );
    applyBlend(BLEND_MIX);
    return succeeded;
  }

  function emitExternalEffectCommand(
    list: DrawList<ExecutorTexture | null>,
    index: number,
    projection: StageProjection,
    damage: DamageRect | undefined,
    current: Program,
  ): boolean {
    const effect = list.externalEffectAt(index);
    if (!effect) {
      stats.unknownCommands += 1;
      return false;
    }
    batcher.flush("effects");
    const framebuffer = gl.getParameter(
      gl.DRAW_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const succeeded = effect.execute({
      gl,
      framebuffer,
      width: projection.framebufferWidth,
      height: projection.framebufferHeight,
      damage,
      scissor: appliedScissor,
    });
    if (succeeded) stats.externalEffects += 1;
    else stats.externalEffectFailures += 1;
    // An external pass owns every mutable GL binding while it paints. The next
    // canvas command must resume the executor contract, never its leftovers.
    gl.bindVertexArray(current.vao);
    gl.useProgram(current.program);
    gl.viewport(
      0,
      0,
      projection.framebufferWidth,
      projection.framebufferHeight,
    );
    gl.enable(gl.SCISSOR_TEST);
    invalidateAppliedState();
    applyClip(
      projection.toFramebuffer,
      projection.framebufferWidth,
      projection.framebufferHeight,
      damage,
    );
    applyBlend(BLEND_MIX);
    return succeeded;
  }

  return {
    gl,
    stats,
    maxTextureSlots,

    warmUp() {
      return ensureProgram() !== null && ensureMeshProgram() !== null;
    },

    releaseCompiled(plan) {
      const cache = compiledGpuPlans.get(plan);
      if (cache) releaseGpuPlan(cache, true);
    },

    execute(list, projection, executeOptions) {
      const current = ensureProgram();
      if (!current) return false;

      stats.commands = 0;
      stats.quads = 0;
      stats.batches = 0;
      stats.textureBinds = 0;
      stats.scissorChanges = 0;
      stats.blendChanges = 0;
      stats.ninePatches = 0;
      stats.ninePatchQuads = 0;
      stats.polylines = 0;
      stats.polylineQuads = 0;
      stats.texturedMeshes = 0;
      stats.texturedMeshTriangles = 0;
      stats.texturedMeshDrawCalls = 0;
      stats.glyphRuns = 0;
      stats.glyphs = 0;
      stats.glyphDrawCalls = 0;
      stats.glyphRunBatches = 0;
      stats.glyphRunBatchFallbacks = 0;
      stats.glyphRunsDropped = 0;
      stats.screenEffects = 0;
      stats.screenEffectFailures = 0;
      stats.externalEffects = 0;
      stats.externalEffectFailures = 0;
      stats.rotatedClipFallbacks = 0;
      stats.unbalancedClipPops = 0;
      stats.unknownCommands = 0;
      stats.maxBatchQuads = 0;
      stats.flushes.textureSlots = 0;
      stats.flushes.colorMatrices = 0;
      stats.flushes.blend = 0;
      stats.flushes.clip = 0;
      stats.flushes.glyphs = 0;
      stats.flushes.effects = 0;
      stats.flushes.meshes = 0;
      stats.flushes.compiled = 0;
      stats.flushes.end = 0;
      stats.compiledPlanBuilds = 0;
      stats.compiledPlanReuses = 0;
      stats.compiledTemplateRangeUpdates = 0;
      stats.reusedSelections = 0;
      stats.reusedBatches = 0;
      stats.compiledGpuFullUploads = 0;
      stats.compiledGpuRangeUploads = 0;
      stats.compiledCachedDrawCalls = 0;

      const compiled =
        executeOptions?.compiled?.list === list
          ? executeOptions.compiled
          : undefined;
      let gpuCache: CachedGpuPlan | null = null;
      if (compiled) {
        const refresh = compiled.refresh();
        stats.compiledPlanBuilds = refresh.rebuilt ? 1 : 0;
        stats.compiledPlanReuses = refresh.rebuilt ? 0 : 1;
        stats.compiledTemplateRangeUpdates = refresh.rangeUpdates;
        // Selection is caller-owned (`plan.select`); execute never allocates or
        // rebuilds one behind a direct frame's back.
        stats.reusedSelections = 0;
        stats.reusedBatches = refresh.rebuilt ? 0 : compiled.batches.length;
        const existing = compiledGpuPlans.get(compiled);
        if (
          existing &&
          (existing.generation !== refresh.planGeneration ||
            (existing.contentRevision !== refresh.contentRevision &&
              existing.contentRevision !== refresh.deltaBaseRevision))
        ) {
          releaseGpuPlan(existing, true);
        }
        const currentCache = compiledGpuPlans.get(compiled);
        gpuCache = currentCache
          ? currentCache.contentRevision === refresh.contentRevision
            ? updateGpuPlan(
                currentCache,
                current,
                NO_CHANGED_COMMANDS,
                refresh.contentRevision,
              )
            : updateGpuPlan(
                currentCache,
                current,
                refresh.changedCommands,
                refresh.contentRevision,
              )
          : buildGpuPlan(
              compiled,
              current,
              refresh.planGeneration,
              refresh.contentRevision,
            );
      }

      clipStack.reset();
      batcher.reset();

      const width = projection.framebufferWidth;
      const height = projection.framebufferHeight;
      gl.bindVertexArray(current.vao);
      gl.useProgram(current.program);
      gl.viewport(0, 0, width, height);
      if (current.uProjection) {
        gl.uniform4f(
          current.uProjection,
          projection.toClip[0],
          projection.toClip[1],
          projection.toClip[2],
          projection.toClip[3],
        );
      }
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.enable(gl.SCISSOR_TEST);
      // Force every cached state to be re-applied: this executor does not own the
      // context and cannot assume anything about what else drew into it.
      invalidateAppliedState();
      applyClip(
        projection.toFramebuffer,
        width,
        height,
        executeOptions?.damage,
      );
      applyBlend(BLEND_MIX);

      if (executeOptions?.clear !== false) {
        const clearColor = executeOptions?.clearColor;
        gl.clearColor(
          clearColor?.[0] ?? 0,
          clearColor?.[1] ?? 0,
          clearColor?.[2] ?? 0,
          clearColor?.[3] ?? 0,
        );
        gl.clear(gl.COLOR_BUFFER_BIT);
      }

      let clipSerial = 0;
      let screenEffectFailed = false;
      const count = list.count;
      for (let index = 0; index < count; index += 1) {
        if (screenEffectFailed) break;
        if (
          executeOptions?.commandMask &&
          !executeOptions.commandMask.includes(index)
        ) {
          continue;
        }
        const cached = executeOptions?.commandMask
          ? gpuCache?.runsForCommand[index]
          : gpuCache?.runsAt[index];
        if (cached) {
          const first = executeOptions?.commandMask
            ? (gpuCache?.itemsForCommand[index] ?? 0)
            : 0;
          let cachedCount = 1;
          if (!executeOptions?.commandMask)
            cachedCount = cached.commands.length;
          else {
            while (
              first + cachedCount < cached.commands.length &&
              executeOptions.commandMask.includes(
                cached.commands[first + cachedCount],
              )
            ) {
              cachedCount += 1;
            }
          }
          batcher.flush("compiled");
          drawCachedRange(cached, first, cachedCount, current);
          stats.commands += cachedCount;
          index = cached.commands[first + cachedCount - 1];
          continue;
        }
        stats.commands += 1;
        switch (list.kindAt(index)) {
          case DRAW_QUAD:
            emitQuadCommand(list, index, compiled);
            break;
          case DRAW_NINE_PATCH:
            emitNinePatchCommand(list, index);
            break;
          case DRAW_POLYLINE:
            emitPolylineCommand(list, index);
            break;
          case DRAW_GLYPHS:
            index = emitAdjacentGlyphCommands(
              list,
              index,
              projection,
              current,
              executeOptions?.commandMask,
            );
            break;
          case DRAW_TEXTURED_MESH:
            emitTexturedMeshCommand(list, index, projection, current);
            break;
          case DRAW_SCREEN_EFFECT:
            screenEffectFailed = !emitScreenEffectCommand(
              list,
              index,
              projection,
              executeOptions?.damage,
              current,
            );
            break;
          case DRAW_EXTERNAL_EFFECT:
            screenEffectFailed = !emitExternalEffectCommand(
              list,
              index,
              projection,
              executeOptions?.damage,
              current,
            );
            break;
          case DRAW_CLIP_PUSH: {
            list.readClipRect(index, clipView);
            // Flush the pending batch FIRST, under the clip it was drawn with —
            // see the module note on the order of operations.
            clipSerial += 1;
            batcher.setClipEpoch(clipSerial);
            clipStack.push(clipView);
            applyClip(
              projection.toFramebuffer,
              width,
              height,
              executeOptions?.damage,
            );
            break;
          }
          case DRAW_CLIP_POP: {
            if (clipStack.depth === 0) {
              stats.unbalancedClipPops += 1;
              break;
            }
            clipSerial += 1;
            batcher.setClipEpoch(clipSerial);
            clipStack.pop();
            applyClip(
              projection.toFramebuffer,
              width,
              height,
              executeOptions?.damage,
            );
            break;
          }
          // THE GUARD THIS SWITCH DID NOT HAVE. Without it a kind the IR grew and this file did
          // not learn falls straight through, uncounted except in `stats.commands` — a frame
          // missing everything of that kind, reporting as a frame that drew all of it.
          default:
            stats.unknownCommands += 1;
            break;
        }
      }

      batcher.flush("end");
      stats.rotatedClipFallbacks = clipStack.rotatedFallbacks;
      gl.bindVertexArray(null);
      gl.disable(gl.SCISSOR_TEST);
      return !screenEffectFailed;
    },

    invalidate() {
      // No deletes: after a context loss the names are already invalid, and
      // asking a dead context to free them is a stream of GL errors at best.
      program = null;
      meshProgram = null;
      ownedWhite = null;
      appliedBlend = null;
      appliedRoundedRadius = -1;
      for (const cache of [...liveCompiledGpuPlans])
        releaseGpuPlan(cache, false);
    },

    dispose() {
      for (const cache of [...liveCompiledGpuPlans])
        releaseGpuPlan(cache, true);
      if (program) {
        gl.deleteProgram(program.program);
        gl.deleteVertexArray(program.vao);
        gl.deleteBuffer(program.cornerBuffer);
        gl.deleteBuffer(program.instanceBuffer);
        program = null;
      }
      if (ownedWhite) {
        gl.deleteTexture(ownedWhite.texture);
        ownedWhite = null;
      }
      if (meshProgram) {
        gl.deleteProgram(meshProgram.program);
        gl.deleteVertexArray(meshProgram.vao);
        gl.deleteBuffer(meshProgram.vertexBuffer);
        gl.deleteBuffer(meshProgram.indexBuffer);
        meshProgram = null;
      }
    },
  };
}
