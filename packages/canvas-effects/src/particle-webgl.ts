// Instanced WebGL renderer for one particle system: a single
// `gl.drawArraysInstanced` of a unit quad with per-instance center/scale/rotation/
// color/frame from the `InstanceBuffer`. Per-particle continuous color/alpha tint
// (color_ramp over life) is a one-line `texture() * v_color` here — the reason WebGL
// beats Canvas2D for this. Runs on the SHARED GL context (`../webgl/shared-gl`) so all
// systems + shaders share one context; the runtime blits the result to each node's
// 2D canvas (same pattern as the shader runtime).
//
// PREMULTIPLIED OUTPUT IS THE CONTRACT, not a choice. The shared canvas declares
// `premultipliedAlpha: true`, so every fragment here writes `(rgb·a, a)`: the MIX fragment
// multiplies before it returns and blends `ONE / ONE_MINUS_SRC_ALPHA`, and the additive resolve
// presents the accumulated total as `(light, cov)`. Both halves of each pairing are load-bearing
// and neither errors on its own — a premultiplied fragment under a src-alpha blend
// double-multiplies, a straight one under this blend halos — which is why the fragment text and
// `blendFactorsFor` are asserted TOGETHER in `particles-render.test.ts`. It is the same contract
// `./render-webgpu.ts` states in WGSL, deliberately expression for expression.

/** A borrowed GL context and quad. Core never creates or owns either resource. */
export interface ParticleGl {
  gl: WebGL2RenderingContext;
  quad: WebGLBuffer;
}

function compileProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram | null {
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }
  gl.shaderSource(vertex, vertexSource);
  gl.shaderSource(fragment, fragmentSource);
  gl.compileShader(vertex);
  gl.compileShader(fragment);
  if (
    !gl.getShaderParameter(vertex, gl.COMPILE_STATUS) ||
    !gl.getShaderParameter(fragment, gl.COMPILE_STATUS)
  ) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  gl.deleteProgram(program);
  return null;
}

import {
  INSTANCE_STRIDE,
  type InstanceBuffer,
} from "@godot-scene-web/effects/particles";

interface InstanceGpuAllocation {
  buffer: WebGLBuffer;
  bytes: number;
}

/** GPU residency is deliberately external to the portable instance data. */
const instanceAllocations = new WeakMap<
  WebGL2RenderingContext,
  WeakMap<InstanceBuffer, InstanceGpuAllocation>
>();

function allocationsFor(
  gl: WebGL2RenderingContext,
): WeakMap<InstanceBuffer, InstanceGpuAllocation> {
  let allocations = instanceAllocations.get(gl);
  if (!allocations) {
    allocations = new WeakMap();
    instanceAllocations.set(gl, allocations);
  }
  return allocations;
}

function uploadInstances(
  gl: WebGL2RenderingContext,
  instances: InstanceBuffer,
): WebGLBuffer | null {
  const allocations = allocationsFor(gl);
  let allocation = allocations.get(instances);
  if (!allocation) {
    const buffer = gl.createBuffer();
    if (!buffer) return null;
    allocation = { buffer, bytes: 0 };
    allocations.set(instances, allocation);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, allocation.buffer);
  if (instances.data.byteLength > allocation.bytes) {
    gl.bufferData(gl.ARRAY_BUFFER, instances.data, gl.DYNAMIC_DRAW);
    allocation.bytes = instances.data.byteLength;
  } else {
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      instances.data,
      0,
      instances.count * INSTANCE_STRIDE,
    );
  }
  return allocation.buffer;
}

/** Release one portable buffer's WebGL allocation on its owning borrowed context. */
export function disposeParticleInstanceBuffer(
  gl: WebGL2RenderingContext,
  instances: InstanceBuffer,
): void {
  const allocations = instanceAllocations.get(gl);
  const allocation = allocations?.get(instances);
  if (!allocation) return;
  gl.deleteBuffer(allocation.buffer);
  allocations?.delete(instances);
}

/** Context-loss path: forget driver names without issuing GL commands. */
export function invalidateParticleInstanceBuffer(
  gl: WebGL2RenderingContext,
  instances: InstanceBuffer,
): void {
  instanceAllocations.get(gl)?.delete(instances);
}

const VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 a_corner;   // unit quad corner, [-0.5, 0.5]
layout(location = 1) in vec2 a_center;   // particle center, device px
layout(location = 2) in vec2 a_scale;    // sprite size, device px (base * scale)
layout(location = 3) in float a_rotation;
layout(location = 4) in vec4 a_color;
layout(location = 5) in float a_frame;
uniform vec2 u_viewport;                  // canvas size, device px
uniform float u_hframes;
uniform float u_vframes;
out vec2 v_uv;
out vec2 v_quad;
out vec2 v_cell;
out vec4 v_color;
void main() {
  float c = cos(a_rotation);
  float s = sin(a_rotation);
  vec2 rotated = vec2(a_corner.x * c - a_corner.y * s, a_corner.x * s + a_corner.y * c);
  vec2 px = a_center + rotated * a_scale;
  vec2 clip = (px / u_viewport) * 2.0 - 1.0;
  clip.y = -clip.y;                       // canvas Y-down -> clip Y-up
  gl_Position = vec4(clip, 0.0, 1.0);
  vec2 uv01 = a_corner + 0.5;             // 0..1 across the SPRITE quad
  vec2 cell = vec2(mod(a_frame, u_hframes), floor(a_frame / u_hframes));
  v_uv = (cell + uv01) / vec2(u_hframes, u_vframes);
  // The flipbook cell INDEX, so a fragment that re-derives its own sprite-local UV (the polar remap) can map
  // it back into the same cell instead of over the whole sheet.
  v_cell = cell;
  // Quad-local 0..1, INDEPENDENT of the flipbook grid: the untextured dot is drawn from this.
  // Deriving it from the atlas-mapped v_uv put the dot's center at the SHEET's center, so any
  // grid > 1x1 left the fallback dot off-center and clipped to a sliver of one cell.
  v_quad = uv01;
  v_color = a_color;
}`;

// Exported for the coverage tests only (jsdom has no GL, so the fragment's ORDERING invariants — coverage read
// PRE-LUT, the mask sampled over the quad — are asserted against the source). Not re-exported by the package.
export const FRAGMENT_SRC = `#version 300 es
precision mediump float;
uniform sampler2D u_texture;
uniform sampler2D u_lutTex;   // per-TEXEL color LUT, 1px tall (see u_lut)
uniform sampler2D u_maskTex;  // quad-shaped coverage mask, unit 2 (see u_mask)
// The flipbook grid, ALSO declared in the vertex stage: a uniform shared across stages must match in type AND
// PRECISION, and the vertex stage's float default is highp while this one's is mediump — declaring these as a
// plain float here fails to LINK (silently: no particle program, so no particle canvases at all).
uniform highp float u_hframes;
uniform highp float u_vframes;
uniform int u_textured;
uniform int u_lut;        // 1 = recolor through the LUT, indexed by the source RED channel
uniform int u_additive;   // 1 = additive: emit the particle's LIGHT (Godot ADD: src.rgb * src.a)
uniform int u_alphaFromRed;  // 1 = coverage comes from the source RED channel, not its alpha
uniform int u_erode;         // 1 = apply the constant-erosion smoothstep below
uniform vec2 u_erodeFactors; // (threshold, softness) for that smoothstep
uniform int u_mask;          // 1 = multiply coverage by u_maskTex's red, sampled over the QUAD
uniform int u_uvPolar;       // 1 = sample the sheet through Godot's polar_coordinates remap
in vec2 v_uv;
in vec2 v_quad;
in vec2 v_cell;
in vec4 v_color;
out vec4 fragColor;
void main() {
  vec2 uv = v_uv;
  if (u_uvPolar == 1) {
    // Godot polar_coordinates(UV, vec2(0.5), 1, 1) (shaders/vfx/_util/polar_coordinates.gdshaderinc):
    // x = radius from the sprite center (0..1.41 at the corners), y = the angle mapped to 0..1, both wrapped.
    // A radial sheet (common_ring_polar_a) is a RING only through this; sampled flat it is a vertical BAR.
    vec2 dir = v_quad - 0.5;
    float radius = length(dir) * 2.0;
    float angle = atan(dir.y, dir.x) * (1.0 / (3.1416 * 2.0));
    uv = (v_cell + mod(vec2(radius, angle), 1.0)) / vec2(u_hframes, u_vframes);
  }
  vec4 tex;
  if (u_textured == 1) {
    tex = texture(u_texture, uv);
  } else {
    // Soft round dot when the system has no texture — measured across the QUAD, not the
    // atlas-mapped UV, so it stays centered whatever the (meaningless, textureless) grid is.
    float r = length(v_quad - 0.5) * 2.0;
    tex = vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(0.7, 1.0, r));
  }
  // COVERAGE — taken PRE-LUT, because the LUT is a color lookup INDEXED by that same red channel: reading it
  // afterwards would sample the LUT's own (usually white) output instead of the sheet's shape. STS2's
  // grayscale VFX sheets are alpha-less PNGs, so tex.a is 1.0 everywhere and the alpha branch draws a SQUARE.
  float coverage = u_alphaFromRed == 1 ? tex.r : tex.a;
  if (u_lut == 1) {
    // Godot's VFX particle-shader family: COLOR = vec4(texture(lut, texture_color.rr).rgb,
    // alpha) * vertex_color. The sprite sheet is a single-channel MASK, so its own RGB is
    // meaningless (it reads as a red/orange block); the LUT holds the real colors. Sampled
    // AFTER the texture/dot resolve so both branches are recolored, and the source ALPHA is
    // preserved untouched — only RGB comes from the LUT.
    tex = vec4(texture(u_lutTex, vec2(tex.r, 0.5)).rgb, tex.a);
  }
  if (u_erode == 1) {
    // Godot erosion_from_factors(vec2(threshold, softness), coverage) — a CONSTANT erosion curve, i.e. the
    // threshold does not sweep over the particle's life (see ParticleSpecConfig.alphaErode).
    coverage = smoothstep(u_erodeFactors.x, u_erodeFactors.x + u_erodeFactors.y, coverage);
  }
  if (u_mask == 1) {
    // Godot's mask sampler reads the sprite's own UV, NOT the flipbook cell — it shapes the whole quad.
    coverage *= texture(u_maskTex, v_quad).r;
  }
  tex.a = coverage;
  vec4 col = tex * v_color;
  if (u_additive == 1) {
    // Additive sprites contribute light = color x alpha (Godot BLEND_MODE_ADD adds
    // src.rgb * src.a to the framebuffer, nothing where light is 0 -- so an opaque-black
    // glow background or an alpha-shaped sprite's transparent area both add nothing).
    // Emit that light RAW and SUM it across particles (blendFunc ONE, ONE into the
    // accumulator FBO); the resolve pass then derives the per-pixel TOTAL's peak-channel
    // coverage ONCE and presents the pair premultiplied. Normalizing per PARTICLE here
    // (the old path) amplified every faint texel to full brightness and let overlaps
    // clamp to white while stacking coverage -- a subtle 5-particle fog rendered as an
    // opaque white haze wall.
    fragColor = vec4(col.rgb * tex.a * v_color.a, 0.0);
  } else {
    // PREMULTIPLIED, under blendFactorsFor(0)'s ONE / ONE_MINUS_SRC_ALPHA -- the shared canvas
    // declares premultipliedAlpha: true (../webgl/shared-gl.ts) and this is that contract.
    // Algebraically identical to emitting straight col under SRC_ALPHA / ONE_MINUS_SRC_ALPHA
    // (both land col.rgb*col.a + dst*(1-col.a)), and written THIS way so the fragment and the
    // canvas state the same thing -- the same pairing render-webgpu.ts's fs_particles uses, since
    // a GPUCanvasContext has no straight-alpha mode to differ with.
    fragColor = vec4(col.rgb * col.a, col.a);
  }
}`;

// Resolve pass for additive systems: read the summed light accumulated in the FBO and PRESENT it,
// premultiplied, as the canvas contract requires: color = the light itself, alpha = its peak
// channel. Source-over then contributes `light + dst * (1 - peak)` -- the closest source-over
// approximation of Godot's pure `light + dst`, applied to the per-pixel TOTAL (not per particle).
//
// NO DIVISION, and therefore no `cov > 0` guard: a premultiplied canvas wants `(light, cov)`
// directly. (It used to resolve `(light / cov, cov)` for a straight-alpha canvas, where the blit
// into the node canvas multiplied by cov again and put `light` back -- correct, but only because
// two mistakes cancelled. The same expression as render-webgpu.ts's fs_resolve.)
const RESOLVE_VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 a_pos;   // full-screen clip-space quad (shared-gl quad buffer)
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Exported for the same reason `FRAGMENT_SRC` is: jsdom has no GL, so the alpha contract this pass
// states — `(light, cov)`, no divide, no guard — is asserted against the SOURCE.
export const RESOLVE_FRAGMENT_SRC = `#version 300 es
precision mediump float;
uniform sampler2D u_accum;
out vec4 fragColor;
void main() {
  // Same viewport rect + origin as the accumulate pass, so fragment coords match texels.
  vec3 light = texelFetch(u_accum, ivec2(gl_FragCoord.xy), 0).rgb;
  float cov = max(max(light.r, light.g), light.b);
  fragColor = vec4(light, cov);
}`;

// The light-accumulation render target for additive systems: particles sum their raw
// light here (blendFunc ONE, ONE), then the resolve pass normalizes the total into the
// default framebuffer. Grow-only (like the shared canvas) to avoid realloc thrash.
interface AccumTarget {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

export interface ParticleProgram {
  program: WebGLProgram;
  cornerBuffer: WebGLBuffer;
  uViewport: WebGLUniformLocation | null;
  uHframes: WebGLUniformLocation | null;
  uVframes: WebGLUniformLocation | null;
  uTexture: WebGLUniformLocation | null;
  uLutTex: WebGLUniformLocation | null;
  uMaskTex: WebGLUniformLocation | null;
  uTextured: WebGLUniformLocation | null;
  uLut: WebGLUniformLocation | null;
  uAdditive: WebGLUniformLocation | null;
  uAlphaFromRed: WebGLUniformLocation | null;
  uErode: WebGLUniformLocation | null;
  uErodeFactors: WebGLUniformLocation | null;
  uMask: WebGLUniformLocation | null;
  uUvPolar: WebGLUniformLocation | null;
  /** Additive resolve pass (normalize summed light -> straight color + coverage). */
  resolveProgram: WebGLProgram;
  uAccum: WebGLUniformLocation | null;
  accum: AccumTarget | null;
}

// Compiled once per page (the programs + the static unit-quad corner buffer are
// context-global), cached at module scope. `null` cached on compile failure so the
// runtime falls back to the static preview.
interface CachedProgram {
  program: ParticleProgram | null;
  refs: number;
  pinned: boolean;
}
const cached = new WeakMap<WebGL2RenderingContext, CachedProgram>();

export function getParticleProgram(
  gl: WebGL2RenderingContext,
): ParticleProgram | null {
  const existing = cached.get(gl);
  if (existing) {
    existing.pinned = true;
    return existing.program;
  }
  const program = compileProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
  const resolveProgram = compileProgram(
    gl,
    RESOLVE_VERTEX_SRC,
    RESOLVE_FRAGMENT_SRC,
  );
  if (!program || !resolveProgram) {
    if (program) gl.deleteProgram(program);
    if (resolveProgram) gl.deleteProgram(resolveProgram);
    cached.set(gl, { program: null, refs: 0, pinned: true });
    return null;
  }
  const cornerBuffer = gl.createBuffer();
  if (!cornerBuffer) {
    gl.deleteProgram(program);
    gl.deleteProgram(resolveProgram);
    cached.set(gl, { program: null, refs: 0, pinned: true });
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  // Unit quad [-0.5, 0.5] as a TRIANGLE_STRIP.
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
    gl.STATIC_DRAW,
  );
  const result: ParticleProgram = {
    program,
    cornerBuffer,
    uViewport: gl.getUniformLocation(program, "u_viewport"),
    uHframes: gl.getUniformLocation(program, "u_hframes"),
    uVframes: gl.getUniformLocation(program, "u_vframes"),
    uTexture: gl.getUniformLocation(program, "u_texture"),
    uLutTex: gl.getUniformLocation(program, "u_lutTex"),
    uMaskTex: gl.getUniformLocation(program, "u_maskTex"),
    uTextured: gl.getUniformLocation(program, "u_textured"),
    uLut: gl.getUniformLocation(program, "u_lut"),
    uAdditive: gl.getUniformLocation(program, "u_additive"),
    uAlphaFromRed: gl.getUniformLocation(program, "u_alphaFromRed"),
    uErode: gl.getUniformLocation(program, "u_erode"),
    uErodeFactors: gl.getUniformLocation(program, "u_erodeFactors"),
    uMask: gl.getUniformLocation(program, "u_mask"),
    uUvPolar: gl.getUniformLocation(program, "u_uvPolar"),
    resolveProgram,
    uAccum: gl.getUniformLocation(resolveProgram, "u_accum"),
    accum: null,
  };
  cached.set(gl, { program: result, refs: 0, pinned: true });
  return result;
}

/** Acquire a shared program lease for a producer that will later release it. */
export function acquireParticleProgram(
  gl: WebGL2RenderingContext,
): ParticleProgram | null {
  const entry = cached.get(gl);
  if (entry) {
    if (!entry.program) return null;
    entry.refs += 1;
    return entry.program;
  }
  // Construct without pinning: a headless-only context may release its final lease.
  const program = getParticleProgram(gl);
  const created = cached.get(gl)!;
  created.pinned = false;
  created.refs = 1;
  return program;
}

function destroyCachedProgram(
  gl: WebGL2RenderingContext,
  program: ParticleProgram,
): void {
  gl.deleteProgram(program.program);
  gl.deleteProgram(program.resolveProgram);
  gl.deleteBuffer(program.cornerBuffer);
  if (program.accum) {
    gl.deleteFramebuffer(program.accum.fbo);
    gl.deleteTexture(program.accum.texture);
  }
}

/** Release a producer lease. Pinned HTML consumers keep their shared program alive. */
export function releaseParticleProgram(
  gl: WebGL2RenderingContext,
  contextLost = false,
): void {
  const entry = cached.get(gl);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs !== 0 || entry.pinned) return;
  cached.delete(gl);
  if (entry.program && !contextLost) destroyCachedProgram(gl, entry.program);
}

/** Drop one context's cached renderer after ordinary invalidation or context loss. */
export function invalidateParticleProgram(
  gl: WebGL2RenderingContext,
  contextLost = false,
): void {
  const entry = cached.get(gl);
  if (entry && !contextLost && entry.refs > 0) return;
  cached.delete(gl);
  if (!entry?.program || contextLost) return;
  destroyCachedProgram(gl, entry.program);
}

// Ensure the accumulation FBO covers (w, h), growing (never shrinking) its texture —
// the same grow-only policy as the shared canvas, for the same realloc-cost reason.
function ensureAccumTarget(
  gl: WebGL2RenderingContext,
  program: ParticleProgram,
  w: number,
  h: number,
): AccumTarget | null {
  let accum = program.accum;
  if (!accum) {
    const fbo = gl.createFramebuffer();
    const texture = gl.createTexture();
    if (!fbo || !texture) {
      if (fbo) gl.deleteFramebuffer(fbo);
      if (texture) gl.deleteTexture(texture);
      return null;
    }
    accum = {
      fbo,
      texture,
      width: 0,
      height: 0,
    };
    program.accum = accum;
  }
  if (accum.width < w || accum.height < h) {
    const width = Math.max(accum.width, w);
    const height = Math.max(accum.height, h);
    gl.bindTexture(gl.TEXTURE_2D, accum.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    // texelFetch sampling — filtering is irrelevant, but the texture must be complete.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, accum.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      accum.texture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(accum.fbo);
      gl.deleteTexture(accum.texture);
      program.accum = null;
      return null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    accum.width = width;
    accum.height = height;
  }
  return accum;
}

export interface DrawParticlesOptions {
  texture: WebGLTexture | null;
  textured: boolean;
  /**
   * Baked per-texel color LUT (1px-tall RGBA ramp) bound on texture unit 1, or null.
   * Present => the fragment shader replaces each texel's RGB with `lut(texel.r)`, keeping
   * the source alpha. See `ParticleSpecConfig.colorLut`.
   */
  lutTexture?: WebGLTexture | null;
  /**
   * Quad-shaped coverage mask bound on texture unit 2, or null. Present => the fragment multiplies coverage by
   * its RED channel (`ParticleSpecConfig.maskUrl`). A still-loading texture is the shared 1x1 TRANSPARENT
   * placeholder, so the system stays invisible until it decodes — the same "no mask, no particle" the game shows.
   */
  maskTexture?: WebGLTexture | null;
  hframes: number;
  vframes: number;
  blendMode: number;
  viewportW: number;
  viewportH: number;
  /** The rect the pixels actually LAND in (≤ viewportW/H): the caller's clamped `gl.viewport`
   *  when the shared drawing buffer couldn't hold the full viewportW×H (see
   *  `ensureSharedDrawSize`). `viewportW/H` stay the px coordinate DOMAIN (the vertex NDC
   *  mapping divides by them), so a smaller target scales the draw down; the caller's blit
   *  scales it back up. Defaults to viewportW/H — a healthy buffer changes nothing. */
  targetW?: number;
  targetH?: number;
  /** Non-default destination for a borrowed-stage additive resolve. */
  targetFramebuffer?: WebGLFramebuffer | null;
  /**
   * Add the resolved light into an already-painted destination rather than
   * overwriting a freshly cleared particle surface. This is required when an
   * additive system is an ordered pass in a shared canvas framebuffer.
   */
  additiveResolveIntoExisting?: boolean;
  /** `ParticleSpecConfig.alphaFromRed`: coverage from the source RED channel, pre-LUT. */
  alphaFromRed?: boolean;
  /** `ParticleSpecConfig.alphaErode`: constant-erosion smoothstep applied to coverage. */
  erode?: { threshold: number; softness: number } | null;
  /** `ParticleSpecConfig.uvPolar`: sample the sheet through Godot's polar_coordinates remap. */
  uvPolar?: boolean;
}

/** Allocate additive accumulation storage before a caller mutates simulation state. */
export function prepareParticleDraw(
  gl: WebGL2RenderingContext,
  program: ParticleProgram,
  opts: DrawParticlesOptions,
): boolean {
  if (opts.blendMode !== 1) return true;
  const targetW = opts.targetW ?? opts.viewportW;
  const targetH = opts.targetH ?? opts.viewportH;
  return ensureAccumTarget(gl, program, targetW, targetH) !== null;
}

// GL blend factors for a CanvasItemMaterial blend mode, as the SEPARATE four Godot uses:
// [srcRGB, dstRGB, srcAlpha, dstAlpha]. Pure + GL-free (returns enum NAMES) so it is
// unit-testable; `drawParticles` maps names -> gl[name] onto `blendFuncSeparate`.
// 1 = add (glow); everything else => standard alpha "mix".
//
// SEPARATE, not one pair for both channels, because Godot's canvas blending is separate and
// both of its backends agree — GLES3 `rasterizer_canvas_gles3.cpp:755-762` (BLEND_MODE_MIX,
// transparent-render-target branch) and RD `material_storage.cpp:655-663`
// (`blend_mode_to_blend_attachment`, BLEND_MODE_MIX) both give the ALPHA channel src factor
// ONE. Applying SRC_ALPHA to alpha as well — as this did — lands a covered pixel near a^2
// instead of a, which shows up wherever alpha is partial: soft sprite edges and overlaps.
// The canvas composites source-over onto the page, so that alpha is a real coverage value the
// page sees, not an internal detail.
export function blendFactorsFor(
  blendMode: number,
): [string, string, string, string] {
  // 1 = add (glow): the fragment shader emits the particle's raw LIGHT (color x alpha,
  // see FRAGMENT_SRC / u_additive) and overlapping particles must SUM it — Godot's
  // BLEND_MODE_ADD — inside the accumulation FBO. The resolve pass then converts the
  // per-pixel total to straight color + coverage alpha for the source-over canvas.
  // (Normalizing per particle with source-over accumulation clamped overlaps to white.)
  //
  // ONE on all four rather than Godot's `(SRC_ALPHA, ONE, SRC_ALPHA, ONE)`: this fragment has
  // already done the src.rgb * src.a itself, and it writes alpha 0 — the accumulator's alpha
  // channel carries nothing, and the resolve's `texelFetch(...).rgb` never reads it.
  if (blendMode === 1) return ["ONE", "ONE", "ONE", "ONE"];
  // MIX: the PREMULTIPLIED form. The fragment already carries `rgb * a` (see FRAGMENT_SRC), so the
  // source contributes its light unscaled and the destination is attenuated by the coverage the
  // source claims: `dst' = src.rgb*src.a + dst*(1 - src.a)`, and the same pair on alpha for
  // Godot's separate-alpha `ONE`. Exactly what `SRC_ALPHA / ONE_MINUS_SRC_ALPHA` computes over a
  // STRAIGHT source — the choice between the two forms is not arithmetic, it is which contract the
  // canvas is declared under, and this one matches `premultipliedAlpha: true`. It is also
  // `render-webgpu.ts`'s `PREMULTIPLIED_BLEND` verbatim, so both backends say one thing.
  return ["ONE", "ONE_MINUS_SRC_ALPHA", "ONE", "ONE_MINUS_SRC_ALPHA"];
}

const INSTANCE_ATTRS: Array<{ loc: number; size: number; offset: number }> = [
  { loc: 1, size: 2, offset: 0 }, // a_center
  { loc: 2, size: 2, offset: 2 }, // a_scale
  { loc: 3, size: 1, offset: 4 }, // a_rotation
  { loc: 4, size: 4, offset: 5 }, // a_color
  { loc: 5, size: 1, offset: 9 }, // a_frame
];

// Draw one system's instances into the (already sized + viewport'd + cleared) shared
// canvas. Additive systems (blendMode 1) render in two passes: SUM the raw per-particle
// light into the accumulation FBO (Godot ADD semantics), then resolve the total into the
// default framebuffer as straight color + coverage alpha. Restores attrib divisors
// afterwards so the shared shader runtime, which uses the default VAO, is unaffected.
export function drawParticles(
  sharedGl: ParticleGl,
  program: ParticleProgram,
  buffer: InstanceBuffer,
  opts: DrawParticlesOptions,
): boolean {
  const { gl } = sharedGl;
  if (buffer.count <= 0) return true;
  const instanceGpuBuffer = uploadInstances(gl, buffer);
  if (!instanceGpuBuffer) return false;

  const additive = opts.blendMode === 1;
  // Where the pixels land (the caller's clamped viewport); viewportW/H remain the coordinate
  // domain. Identical unless the shared drawing buffer capped the draw (see DrawParticlesOptions).
  const targetW = opts.targetW ?? opts.viewportW;
  const targetH = opts.targetH ?? opts.viewportH;
  if (additive) {
    // Accumulate light offscreen; same viewport rect/origin as the default framebuffer,
    // so the resolve pass can map fragment coords to accumulator texels 1:1.
    if (!prepareParticleDraw(gl, program, opts)) return false;
    const accum = program.accum!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, accum.fbo);
    gl.viewport(0, 0, targetW, targetH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  gl.useProgram(program.program);

  gl.bindBuffer(gl.ARRAY_BUFFER, program.cornerBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, instanceGpuBuffer);
  const strideBytes = INSTANCE_STRIDE * 4;
  for (let index = 0; index < INSTANCE_ATTRS.length; index += 1) {
    const attr = INSTANCE_ATTRS[index];
    gl.enableVertexAttribArray(attr.loc);
    gl.vertexAttribPointer(
      attr.loc,
      attr.size,
      gl.FLOAT,
      false,
      strideBytes,
      attr.offset * 4,
    );
    gl.vertexAttribDivisor(attr.loc, 1);
  }

  if (program.uViewport) {
    gl.uniform2f(program.uViewport, opts.viewportW, opts.viewportH);
  }
  const textured = Boolean(opts.textured && opts.texture);
  const hframes = textured ? Math.max(1, opts.hframes) : 1;
  const vframes = textured ? Math.max(1, opts.vframes) : 1;
  if (program.uHframes) gl.uniform1f(program.uHframes, hframes);
  if (program.uVframes) gl.uniform1f(program.uVframes, vframes);
  if (program.uTextured) {
    gl.uniform1i(program.uTextured, textured ? 1 : 0);
  }
  if (program.uAdditive) {
    gl.uniform1i(program.uAdditive, additive ? 1 : 0);
  }
  // Coverage semantics (see ParticleSpecConfig). Written EVERY draw — the program is shared across systems, so
  // a flag left on by the previous system would otherwise leak into this one.
  if (program.uAlphaFromRed) {
    gl.uniform1i(program.uAlphaFromRed, opts.alphaFromRed ? 1 : 0);
  }
  const erode = opts.erode ?? null;
  if (program.uErode) gl.uniform1i(program.uErode, erode ? 1 : 0);
  if (program.uErodeFactors) {
    gl.uniform2f(
      program.uErodeFactors,
      erode ? erode.threshold : 0,
      erode ? erode.softness : 0,
    );
  }
  if (program.uUvPolar) {
    gl.uniform1i(program.uUvPolar, opts.uvPolar ? 1 : 0);
  }
  gl.activeTexture(gl.TEXTURE0);
  if (opts.texture && program.uTexture) {
    gl.bindTexture(gl.TEXTURE_2D, opts.texture);
    gl.uniform1i(program.uTexture, 0);
  } else {
    // Unbind explicitly: a previous resolve pass left the accumulator on TEXTURE0, and
    // sampling it while it is the render target is a feedback loop (undefined behavior).
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  // Unit 1 = the color LUT. Bound (or explicitly unbound) every draw, since the unit is
  // shared with whatever the previous system left there.
  const lut = opts.lutTexture ?? null;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, lut);
  if (program.uLutTex) gl.uniform1i(program.uLutTex, 1);
  if (program.uLut) gl.uniform1i(program.uLut, lut ? 1 : 0);
  // Unit 2 = the quad coverage mask. Same shared-unit discipline as the LUT: bound (or explicitly unbound) on
  // every draw, never left to whatever the previous system put there.
  const mask = opts.maskTexture ?? null;
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, mask);
  if (program.uMaskTex) gl.uniform1i(program.uMaskTex, 2);
  if (program.uMask) gl.uniform1i(program.uMask, mask ? 1 : 0);
  // Back to unit 0 for the caller / the next system (the resolve pass and the shared shader runtime both
  // assume TEXTURE0 is the active unit).
  gl.activeTexture(gl.TEXTURE0);

  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  if (additive) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
  else
    gl.blendFuncSeparate(
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
  gl.disable(gl.DEPTH_TEST);

  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, buffer.count);

  // Leave the default VAO clean for the shader runtime (it uses attrib 0 only).
  for (let index = 0; index < INSTANCE_ATTRS.length; index += 1) {
    const attr = INSTANCE_ATTRS[index];
    gl.vertexAttribDivisor(attr.loc, 0);
    gl.disableVertexAttribArray(attr.loc);
  }

  if (additive && program.accum) {
    // Resolve the summed light. A standalone particle surface was just cleared,
    // so it overwrites. An ordered direct pass instead adds the light into the
    // painter target, preserving the scene already behind it.
    gl.bindFramebuffer(gl.FRAMEBUFFER, opts.targetFramebuffer ?? null);
    gl.viewport(0, 0, targetW, targetH);
    gl.useProgram(program.resolveProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, sharedGl.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, program.accum.texture);
    if (program.uAccum) gl.uniform1i(program.uAccum, 0);
    if (opts.additiveResolveIntoExisting) {
      gl.enable(gl.BLEND);
      gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
      gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
    } else gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Blend state is left as it lies. There is no "ambient" state on the shared context to
    // restore to: every consumer sets its own before drawing — this function does at the top of
    // its blend block, and the shader backend disables BLEND in its preamble.
  }
  return true;
}
