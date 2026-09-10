// The WebGPU particle backend: the peer of `./render-webgl`, rendering STRAIGHT into each node's own
// canvas. There is no shared canvas and no blit — the pixels are produced where the compositor
// already reads them, which is the whole measured point (docs/perf-harness.md S7: 47 → 87 Hz on the
// phone, and a blit-shaped WebGPU arm that collapsed to 23).
//
// WHAT "PORT" MEANS HERE. The WGSL below is `render-webgl.ts`'s `VERTEX_SRC`/`FRAGMENT_SRC`
// transcribed, not re-derived: same flipbook arithmetic, same polar remap, same PRE-LUT coverage
// read, same erode-then-mask order, same `1 - smoothstep(0.7, 1.0, r)` dot, same additive
// accumulate+resolve pair. Those orderings are load-bearing (each one is a bug this pipeline already
// had once), so `webgpu-particles-wgsl.test.ts` asserts them as TEXT — jsdom has no WebGPU to run
// them in, exactly as `FRAGMENT_SRC`'s own coverage tests work.
//
// PREMULTIPLIED OUTPUT IS NOT OPTIONAL. A `GPUCanvasContext` offers only
// `alphaMode: "opaque" | "premultiplied"`, so the only arrangement that composites over the page is:
// the fragment returns `vec4f(rgb * a, a)` AND the pipeline blends `one / one-minus-src-alpha` on
// colour and alpha. The pairing is load-bearing in both directions and neither half errors on its
// own (a premultiplied fragment under a src-alpha blend double-multiplies; a straight fragment under
// this blend halos), which is why `PREMULTIPLIED_BLEND` sits next to the shader text and one test
// asserts the two TOGETHER.
//
// `./render-webgl.ts` states the SAME contract — its shared canvas declares
// `premultipliedAlpha: true`, its MIX fragment premultiplies, and `blendFactorsFor(0)` is this blend
// in GL enum names. That is recent: the GL canvas used to declare itself straight-alpha, which made
// this file's arrangement a translation rather than a restatement, and left the GL side free to
// disagree with itself (it did — MIX composited at a²).
//
// ONE ENCODER PER TICK. `beginFrame` opens a single `GPUCommandEncoder`, every `draw`/`clear` records
// passes into it, and `endFrame` submits it ONCE. That is the shape S7 measured; a per-draw submit
// would make "WebGPU" mean "N submits" and give back the win.

import { INSTANCE_STRIDE, type InstanceBuffer } from "@godot-scene-web/effects";
import { frameGridFor } from "@godot-scene-web/effects/particles";
import {
  compileModule,
  createPipeline,
  createUniformRing,
  SHADER_STAGE,
  type UniformRing,
  uniformBindGroupLayout,
} from "./webgpu-pipeline";
import { readTexturePixels } from "./webgpu-readback";

const PARTICLE_BUFFER_USAGE = { VERTEX: 0x0020, COPY_DST: 0x0008 } as const;
const PARTICLE_TEXTURE_USAGE = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  RENDER_ATTACHMENT: 0x10,
} as const;

/** Resolved texture resource supplied by the host. This package never loads URLs or owns images. */
export interface WebgpuParticleTexture {
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
}

export interface WebgpuParticleDrawOptions {
  width: number;
  height: number;
  texture: unknown | null;
  textured: boolean;
  lutTexture: unknown | null;
  maskTexture: unknown | null;
  hframes: number;
  vframes: number;
  blendMode: number;
  alphaFromRed?: boolean;
  erode?: { threshold: number; softness: number } | null;
  uvPolar?: boolean;
}

export interface WebgpuParticleSurface {
  readonly context: GPUCanvasContext;
  readonly textures: {
    sprite: WebgpuParticleTexture | null;
    lut: WebgpuParticleTexture | null;
    mask: WebgpuParticleTexture | null;
  };
  readonly onTexturesChanged?: (callback: () => void) => () => void;
}

export interface WebgpuParticleRendererOptions {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly readTexturePixels?: (
    texture: GPUTexture,
    width: number,
    height: number,
  ) => Promise<Uint8Array>;
  readonly onPipelineError?: () => void;
}

/** Bytes per packed instance record: the shipped `INSTANCE_STRIDE` (10 floats) × 4. Stated as a
 *  literal because it is what the vertex-buffer layout declares as its `arrayStride` and what every
 *  attribute offset below is measured in. */
export const INSTANCE_STRIDE_BYTES = 40;

// DRIFT GUARD, at module load. The attribute offsets below are hand-written byte positions into the
// record `InstanceBuffer.push` writes; a change to `INSTANCE_STRIDE` that did not update them would
// not fail to compile, it would draw garbage — every instance reading a sliding window of the
// previous one's floats. Throwing here turns that into an immediate, named failure at import.
if (INSTANCE_STRIDE * 4 !== INSTANCE_STRIDE_BYTES) {
  throw new Error(
    `gsw particle instance stride drift: INSTANCE_STRIDE (${INSTANCE_STRIDE}) * 4 !== ${INSTANCE_STRIDE_BYTES}. ` +
      "PARTICLE_VERTEX_BUFFERS in particles/render-webgpu.ts declares byte offsets into the packed record " +
      "(center@0, scale@8, rotation@16, color@20, frame@36) and must be updated with it.",
  );
}

/** Vertex entry point of `PARTICLE_WGSL`. Referenced by the pipeline descriptors, never spelled twice. */
export const PARTICLE_VS_ENTRY = "vs_particles";
/** Fragment entry point for MIX (and every non-additive) blend: premultiplied colour out. */
export const PARTICLE_FS_ENTRY = "fs_particles";
/** Fragment entry point for the ADDITIVE accumulate pass: raw light out, alpha 0. */
export const PARTICLE_FS_ADDITIVE_ENTRY = "fs_particles_additive";
/** Vertex entry point of `ADDITIVE_RESOLVE_WGSL` (a full-target strip). */
export const RESOLVE_VS_ENTRY = "vs_resolve";
/** Fragment entry point of `ADDITIVE_RESOLVE_WGSL`. */
export const RESOLVE_FS_ENTRY = "fs_resolve";

/**
 * The blend state every non-additive draw uses, and the other half of the premultiply contract in
 * the module header.
 *
 * `one / one-minus-src-alpha` on colour AND alpha: the fragment already carries `rgb * a`, so the
 * source contributes its light unscaled and the destination is attenuated by the coverage the source
 * claims — `dst' = src.rgb*src.a + dst*(1-src.a)`, which is what `SRC_ALPHA / ONE_MINUS_SRC_ALPHA`
 * computes over a straight-alpha source (the GL path's blend). The alpha channel gets the same pair
 * so the canvas's own alpha accumulates the same way.
 */
export const PREMULTIPLIED_BLEND: GPUBlendState = {
  color: {
    operation: "add",
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
  },
  alpha: {
    operation: "add",
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
  },
};

/** The ACCUMULATE pass's blend: `ONE, ONE` on both channels, i.e. `render-webgl`'s
 *  `blendFactorsFor(1)` — overlapping additive particles SUM their raw light (Godot
 *  `BLEND_MODE_ADD`) instead of compositing over one another. */
export const ADDITIVE_BLEND: GPUBlendState = {
  color: { operation: "add", srcFactor: "one", dstFactor: "one" },
  alpha: { operation: "add", srcFactor: "one", dstFactor: "one" },
};

/**
 * The vertex buffer layout: slot 0 is the static unit-quad corner (stepped per VERTEX), slot 1 is the
 * packed instance record (stepped per INSTANCE).
 *
 * The attribute offsets are the shipped float offsets × 4 — center@0, scale@8, rotation@16,
 * color@20, frame@36 — i.e. exactly `INSTANCE_ATTRS` in `render-webgl.ts`, in bytes. Exported so a
 * test can read the stride back without building a device.
 */
export const PARTICLE_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 8,
    stepMode: "vertex",
    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
  },
  {
    arrayStride: INSTANCE_STRIDE_BYTES,
    stepMode: "instance",
    attributes: [
      { shaderLocation: 1, offset: 0, format: "float32x2" }, // a_center, device px
      { shaderLocation: 2, offset: 8, format: "float32x2" }, // a_scale, device px
      { shaderLocation: 3, offset: 16, format: "float32" }, // a_rotation, rad
      { shaderLocation: 4, offset: 20, format: "float32x4" }, // a_color, straight
      { shaderLocation: 5, offset: 36, format: "float32" }, // a_frame (flipbook index)
    ],
  },
];

/** Floats in the per-surface uniform slot (`Params` below): 6 f32 then 6 u32, all 4 bytes. */
const PARAMS_FLOATS = 12;
const PARAMS_BYTES = PARAMS_FLOATS * 4;

/**
 * The instanced particle module — `render-webgl.ts`'s two shader stages, transcribed.
 *
 * PER-SYSTEM VALUES ARE UNIFORMS, NOT PIPELINE VARIANTS. `textured`/`lut`/`mask`/`uvPolar` etc. select
 * branches at runtime out of ONE pipeline, exactly as the GL program's `u_textured`/`u_lut` do — the
 * alternative (a pipeline per feature combination) is 64 pipelines for a fragment whose branches are
 * uniform-valued and therefore free of divergence. Sampling inside those branches is legal for two
 * independent reasons: a branch on a uniform value is UNIFORM CONTROL FLOW (so even
 * derivative-taking `textureSample` would be allowed), and the samples below use
 * `textureSampleLevel(..., 0.0)`, which needs no derivatives at all. Level 0 is not an approximation
 * here: every texture this backend binds is created with a single mip level (see `../webgpu/textures`).
 */
export const PARTICLE_WGSL = `struct Params {
  viewport: vec2f,       // canvas backing size, device px — REWRITTEN EVERY DRAW (canvases resize)
  grid: vec2f,           // hframes, vframes
  erodeFactors: vec2f,   // threshold, softness
  textured: u32,
  lut: u32,
  alphaFromRed: u32,
  erode: u32,
  mask: u32,
  uvPolar: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(1) @binding(0) var sprite_tex: texture_2d<f32>;
@group(1) @binding(1) var sprite_smp: sampler;
@group(1) @binding(2) var lut_tex: texture_2d<f32>;
@group(1) @binding(3) var lut_smp: sampler;
@group(1) @binding(4) var mask_tex: texture_2d<f32>;
@group(1) @binding(5) var mask_smp: sampler;

// GLSL's \`mod\` is FLOOR-signed; WGSL's \`%\` is TRUNC-signed. The flipbook cell index and the polar
// wrap are both written against GLSL semantics in the shader this ports, so re-derive them rather
// than swap in an operator that agrees only for positive operands.
fn godot_mod(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y);
}

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) quad: vec2f,
  @location(2) cell: vec2f,
  @location(3) color: vec4f,
};

@vertex
fn ${PARTICLE_VS_ENTRY}(
  @location(0) corner: vec2f,
  @location(1) center: vec2f,
  @location(2) scale: vec2f,
  @location(3) rotation: f32,
  @location(4) color: vec4f,
  @location(5) frame: f32,
) -> VsOut {
  let c = cos(rotation);
  let s = sin(rotation);
  let rotated = vec2f(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  let px = center + rotated * scale;
  var clip = (px / params.viewport) * 2.0 - 1.0;
  clip.y = -clip.y;                       // canvas Y-down -> clip Y-up
  var out: VsOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  let uv01 = corner + 0.5;                // 0..1 across the SPRITE quad
  let cell = vec2f(godot_mod(frame, params.grid.x), floor(frame / params.grid.x));
  out.uv = (cell + uv01) / params.grid;
  // The flipbook cell INDEX, so a fragment that re-derives its own sprite-local UV (the polar remap)
  // can map it back into the same cell instead of over the whole sheet.
  out.cell = cell;
  // Quad-local 0..1, INDEPENDENT of the flipbook grid: the untextured dot and the coverage mask are
  // both measured from this. Deriving them from the atlas-mapped uv put the dot's centre at the
  // SHEET's centre, so any grid > 1x1 left it off-centre and clipped to a sliver of one cell.
  out.quad = uv01;
  out.color = color;
  return out;
}

struct Shaded {
  col: vec4f,
  coverage: f32,
};

// The whole fragment feature set, shared by both entry points below so the mix and additive paths
// can never disagree about it (in GL they are one shader and a branch).
fn shade(in: VsOut) -> Shaded {
  var uv = in.uv;
  if (params.uvPolar == 1u) {
    // Godot polar_coordinates(UV, vec2(0.5), 1, 1) (shaders/vfx/_util/polar_coordinates.gdshaderinc):
    // x = radius from the sprite centre (0..1.41 at the corners), y = the angle mapped to 0..1, both
    // wrapped — then RE-WRAPPED INTO THE SAME CELL through in.cell, so a flipbook stays a flipbook.
    // A radial sheet (common_ring_polar_a) is a RING only through this; sampled flat it is a
    // vertical BAR.
    let dir = in.quad - vec2f(0.5);
    let radius = length(dir) * 2.0;
    let angle = atan2(dir.y, dir.x) * (1.0 / (3.1416 * 2.0));
    uv = (in.cell + vec2f(godot_mod(radius, 1.0), godot_mod(angle, 1.0))) / params.grid;
  }
  var tex: vec4f;
  if (params.textured == 1u) {
    tex = textureSampleLevel(sprite_tex, sprite_smp, uv, 0.0);
  } else {
    // Soft round dot when the system has no texture — measured across the QUAD, not the atlas-mapped
    // uv, so it stays centred whatever the (meaningless, textureless) grid is.
    let r = length(in.quad - vec2f(0.5)) * 2.0;
    tex = vec4f(1.0, 1.0, 1.0, 1.0 - smoothstep(0.7, 1.0, r));
  }
  // COVERAGE — taken PRE-LUT, because the LUT is a colour lookup INDEXED by that same red channel:
  // reading it afterwards would sample the LUT's own (usually white) output instead of the sheet's
  // shape. Grayscale VFX sheets are alpha-less PNGs, so tex.a is 1.0 everywhere and the alpha branch
  // draws a SQUARE.
  var coverage = select(tex.a, tex.r, params.alphaFromRed == 1u);
  if (params.lut == 1u) {
    // Godot's VFX particle-shader family: COLOR = vec4(texture(lut, texture_color.rr).rgb, alpha) *
    // vertex_color. The sheet is a single-channel MASK, so its own RGB is meaningless; the LUT holds
    // the real colours. Sampled AFTER the texture/dot resolve so both branches are recoloured, and
    // the source ALPHA is preserved untouched — only RGB comes from the LUT.
    tex = vec4f(textureSampleLevel(lut_tex, lut_smp, vec2f(tex.r, 0.5), 0.0).rgb, tex.a);
  }
  if (params.erode == 1u) {
    // Godot erosion_from_factors(vec2(threshold, softness), coverage) — a CONSTANT erosion curve,
    // i.e. the threshold does not sweep over the particle's life. AFTER the LUT, BEFORE the mask.
    coverage = smoothstep(params.erodeFactors.x, params.erodeFactors.x + params.erodeFactors.y, coverage);
  }
  if (params.mask == 1u) {
    // Godot's mask sampler reads the sprite's own UV, NOT the flipbook cell — it shapes the whole quad.
    coverage = coverage * textureSampleLevel(mask_tex, mask_smp, in.quad, 0.0).r;
  }
  tex.a = coverage;
  var out: Shaded;
  out.col = tex * in.color;
  out.coverage = coverage;
  return out;
}

@fragment
fn ${PARTICLE_FS_ENTRY}(in: VsOut) -> @location(0) vec4f {
  let col = shade(in).col;
  // PREMULTIPLIED — see the module header. Only correct under PREMULTIPLIED_BLEND.
  return vec4f(col.rgb * col.a, col.a);
}

@fragment
fn ${PARTICLE_FS_ADDITIVE_ENTRY}(in: VsOut) -> @location(0) vec4f {
  // Additive sprites contribute light = colour x alpha (Godot BLEND_MODE_ADD adds src.rgb * src.a to
  // the framebuffer, so an opaque-black glow background or an alpha-shaped sprite's transparent area
  // both add nothing). Emit that light RAW and SUM it across particles (ADDITIVE_BLEND, into the
  // accumulator); the resolve pass converts the per-pixel TOTAL to coverage ONCE. Normalizing per
  // PARTICLE amplified every faint texel to full brightness and let overlaps clamp to white while
  // stacking coverage — a subtle 5-particle fog rendered as an opaque white haze wall.
  // ALPHA IS 0: the accumulator holds light, not coverage.
  let shaded = shade(in);
  return vec4f(shaded.col.rgb * shaded.coverage * in.color.a, 0.0);
}
`;

/**
 * The additive RESOLVE pass: read the summed light out of the accumulator and present it.
 *
 * THE ALGEBRA. A premultiplied canvas wants the accumulated light itself: `(light, cov)` composites
 * to `light + dst*(1-cov)`, with no division at all — and therefore no `cov > 0` guard either, since
 * the division that would have needed one is gone (at cov = 0 the fragment is (0,0,0,0), which
 * composites to `dst` exactly). `RESOLVE_FRAGMENT_SRC` in `./render-webgl.ts` is now the same
 * expression, its canvas being premultiplied too; it used to divide by `cov` for a straight-alpha
 * canvas and rely on the blit into the node canvas to multiply it back.
 *
 * `textureLoad` at integer pixel coordinates, like GL's `texelFetch`: the accumulate pass renders
 * into the top-left w×h rect of a grow-only accumulator, and WebGPU framebuffer coordinates are
 * Y-DOWN in both passes, so texel (x, y) is fragment (x, y) with no flip arithmetic anywhere.
 */
export const ADDITIVE_RESOLVE_WGSL = `@group(0) @binding(0) var accum_tex: texture_2d<f32>;

@vertex
fn ${RESOLVE_VS_ENTRY}(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  // TRIANGLE_STRIP corner order, matching the particle quad's: (-1,-1) (1,-1) (-1,1) (1,1).
  var corners = array<vec2f, 4>(
    vec2f(-1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(-1.0, 1.0),
    vec2f(1.0, 1.0)
  );
  return vec4f(corners[index], 0.0, 1.0);
}

@fragment
fn ${RESOLVE_FS_ENTRY}(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let light = textureLoad(accum_tex, vec2i(pos.xy), 0).rgb;
  let cov = max(light.r, max(light.g, light.b));
  return vec4f(light, cov);
}
`;

/** The accumulator's format. `rgba8unorm` rather than a float target ON PURPOSE: the GL path
 *  accumulates into an RGBA/UNSIGNED_BYTE FBO, so its sums CLAMP at 1.0 per channel, and matching
 *  that byte-clamping beats being more faithful than the renderer this must look identical to. */
const ACCUM_FORMAT: GPUTextureFormat = "rgba8unorm";

const TRANSPARENT: GPUColor = { r: 0, g: 0, b: 0, a: 0 };

/** The grow-only light accumulator, one per DEVICE (the analogue of `ParticleProgram.accum`): every
 *  additive system on the page borrows it inside its own pass pair, so N systems cost one texture. */
interface AccumTarget {
  texture: GPUTexture;
  view: GPUTextureView;
  bindGroup: GPUBindGroup;
  width: number;
  height: number;
}

/** Per-surface GPU state, supplied with a presentation context and resolved handles by the host. */
export interface WebgpuParticleSurfaceState extends WebgpuParticleSurface {
  ring: UniformRing;
  words: Uint32Array;
  instances: GPUBuffer | null;
  instanceBytes: number;
  bindGroup: GPUBindGroup | null;
  boundViews: [unknown, unknown, unknown];
  bindGroupDirty: boolean;
  disposeTextureListener: (() => void) | null;
}

/** Device-scope modules, pipelines, static quad, placeholder and additive accumulator. */
interface ParticleProgramGpu {
  device: GPUDevice;
  format: GPUTextureFormat;
  module: GPUShaderModule;
  resolveModule: GPUShaderModule;
  uniformLayout: GPUBindGroupLayout;
  textureLayout: GPUBindGroupLayout;
  accumLayout: GPUBindGroupLayout;
  particleLayout: GPUPipelineLayout;
  resolvePipelineLayout: GPUPipelineLayout;
  normal: GPURenderPipeline;
  accumulate: GPURenderPipeline;
  resolve: GPURenderPipeline;
  corners: GPUBuffer;
  placeholderView: GPUTextureView;
  placeholderSampler: GPUSampler;
  accum: AccumTarget | null;
  capture: { normal: GPURenderPipeline; resolve: GPURenderPipeline } | null;
}
let programMemo: Promise<ParticleProgramGpu | null> | undefined;
let programSettled: ParticleProgramGpu | null | undefined;
let programDevice: GPUDevice | null = null;

function acquireParticleProgram(
  options: WebgpuParticleRendererOptions,
): Promise<ParticleProgramGpu | null> {
  if (programDevice !== options.device) {
    programMemo = undefined;
    programSettled = undefined;
    programDevice = options.device;
  }
  if (programMemo) return programMemo;
  programMemo = buildParticleProgram(options).then((program) => {
    programSettled = program;
    return program;
  });
  return programMemo;
}
function peekParticleProgram(
  options: WebgpuParticleRendererOptions,
): ParticleProgramGpu | null | undefined {
  return programDevice === options.device ? programSettled : undefined;
}

async function buildParticleProgram(
  options: WebgpuParticleRendererOptions,
): Promise<ParticleProgramGpu | null> {
  const { device, format } = options;
  const module = await compileModule(device, PARTICLE_WGSL, "gsw-particles");
  if (!module) return null;
  const resolveModule = await compileModule(
    device,
    ADDITIVE_RESOLVE_WGSL,
    "gsw-particle-resolve",
  );
  if (!resolveModule) return null;
  const uniformLayout = uniformBindGroupLayout(
    device,
    SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT,
    PARAMS_BYTES,
    "gsw-particle-params",
  );
  const textureLayout = device.createBindGroupLayout({
    label: "gsw-particle-textures",
    entries: [
      { binding: 0, visibility: SHADER_STAGE.FRAGMENT, texture: {} },
      { binding: 1, visibility: SHADER_STAGE.FRAGMENT, sampler: {} },
      { binding: 2, visibility: SHADER_STAGE.FRAGMENT, texture: {} },
      { binding: 3, visibility: SHADER_STAGE.FRAGMENT, sampler: {} },
      { binding: 4, visibility: SHADER_STAGE.FRAGMENT, texture: {} },
      { binding: 5, visibility: SHADER_STAGE.FRAGMENT, sampler: {} },
    ],
  });
  const accumLayout = device.createBindGroupLayout({
    label: "gsw-particle-accum",
    entries: [{ binding: 0, visibility: SHADER_STAGE.FRAGMENT, texture: {} }],
  });
  const particleLayout = device.createPipelineLayout({
    label: "gsw-particles",
    bindGroupLayouts: [uniformLayout, textureLayout],
  });
  const resolvePipelineLayout = device.createPipelineLayout({
    label: "gsw-particle-resolve",
    bindGroupLayouts: [accumLayout],
  });
  const normal = await createPipeline(
    device,
    particlePipelineDescriptor(module, particleLayout, format, false),
    "gsw-particles",
  );
  if (!normal) return null;
  const accumulate = await createPipeline(
    device,
    particlePipelineDescriptor(module, particleLayout, ACCUM_FORMAT, true),
    "gsw-particles-additive",
  );
  if (!accumulate) return null;
  const resolve = await createPipeline(
    device,
    resolvePipelineDescriptor(resolveModule, resolvePipelineLayout, format),
    "gsw-particle-resolve",
  );
  if (!resolve) return null;
  const corners = device.createBuffer({
    label: "gsw-particle-corners",
    size: 32,
    usage: PARTICLE_BUFFER_USAGE.VERTEX | PARTICLE_BUFFER_USAGE.COPY_DST,
  });
  device.queue.writeBuffer(
    corners,
    0,
    new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
  );
  const placeholder = device.createTexture({
    label: "gsw-particle-placeholder",
    size: [1, 1, 1],
    format: "rgba8unorm",
    usage:
      PARTICLE_TEXTURE_USAGE.TEXTURE_BINDING | PARTICLE_TEXTURE_USAGE.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: placeholder },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4, rowsPerImage: 1 },
    [1, 1, 1],
  );
  return {
    device,
    format,
    module,
    resolveModule,
    uniformLayout,
    textureLayout,
    accumLayout,
    particleLayout,
    resolvePipelineLayout,
    normal,
    accumulate,
    resolve,
    corners,
    placeholderView: placeholder.createView(),
    placeholderSampler: device.createSampler({
      label: "gsw-particle-placeholder",
      magFilter: "linear",
      minFilter: "linear",
    }),
    accum: null,
    capture: null,
  };
}

function particlePipelineDescriptor(
  module: GPUShaderModule,
  layout: GPUPipelineLayout,
  format: GPUTextureFormat,
  additive: boolean,
): GPURenderPipelineDescriptor {
  return {
    label: additive ? "gsw-particles-additive" : "gsw-particles",
    layout,
    vertex: {
      module,
      entryPoint: PARTICLE_VS_ENTRY,
      buffers: PARTICLE_VERTEX_BUFFERS,
    },
    fragment: {
      module,
      entryPoint: additive ? PARTICLE_FS_ADDITIVE_ENTRY : PARTICLE_FS_ENTRY,
      targets: [
        { format, blend: additive ? ADDITIVE_BLEND : PREMULTIPLIED_BLEND },
      ],
    },
    primitive: { topology: "triangle-strip" },
  };
}
function resolvePipelineDescriptor(
  module: GPUShaderModule,
  layout: GPUPipelineLayout,
  format: GPUTextureFormat,
): GPURenderPipelineDescriptor {
  return {
    label: "gsw-particle-resolve",
    layout,
    vertex: { module, entryPoint: RESOLVE_VS_ENTRY },
    fragment: { module, entryPoint: RESOLVE_FS_ENTRY, targets: [{ format }] },
    primitive: { topology: "triangle-strip" },
  };
}

/** Construct a renderer after its device program is compiled. Presentation contexts and texture handles stay host-owned. */
export async function createWebgpuParticleRenderer(
  options: WebgpuParticleRendererOptions,
): Promise<WebgpuParticleRenderer | null> {
  const program = await acquireParticleProgram(options);
  return program ? rendererOver(options, program) : null;
}
export function peekWebgpuParticleRenderer(
  options: WebgpuParticleRendererOptions,
): WebgpuParticleRenderer | null | undefined {
  const program = peekParticleProgram(options);
  return program === undefined
    ? undefined
    : program === null
      ? null
      : rendererOver(options, program);
}
export interface WebgpuParticleRenderer {
  createSurface(surface: WebgpuParticleSurface): WebgpuParticleSurfaceState;
  disposeSurface(surface: WebgpuParticleSurfaceState): void;
  beginFrame(): void;
  endFrame(): void;
  clear(surface: WebgpuParticleSurfaceState): void;
  draw(
    surface: WebgpuParticleSurfaceState,
    buffer: InstanceBuffer,
    opts: WebgpuParticleDrawOptions,
  ): void;
  captureSurface(
    surface: WebgpuParticleSurfaceState,
    buffer: InstanceBuffer,
    opts: WebgpuParticleDrawOptions,
  ): Promise<Uint8Array | null>;
  submits(): number;
}
function rendererOver(
  options: WebgpuParticleRendererOptions,
  program: ParticleProgramGpu,
): WebgpuParticleRenderer {
  const { device } = options;
  let encoder: GPUCommandEncoder | null = null;
  let recorded = false;
  let implicit = false;
  let submitCount = 0;
  const ensureEncoder = () => {
    if (!encoder) {
      encoder = device.createCommandEncoder({ label: "gsw-particles" });
      implicit = true;
    }
    return encoder;
  };
  const flush = () => {
    if (encoder && recorded) {
      device.queue.submit([encoder.finish()]);
      submitCount++;
    }
    encoder = null;
    recorded = false;
    implicit = false;
  };
  const flushImplicit = () => {
    if (implicit) flush();
  };
  return {
    createSurface(surface) {
      const ring = createUniformRing(device, 1, PARAMS_FLOATS, {
        label: "gsw-particle-params",
        layout: program.uniformLayout,
      });
      const state = Object.assign(surface, {
        ring,
        words: new Uint32Array(ring.staging.buffer),
        instances: null,
        instanceBytes: 0,
        bindGroup: null,
        boundViews: [null, null, null] as [unknown, unknown, unknown],
        bindGroupDirty: true,
        disposeTextureListener: null,
      }) as WebgpuParticleSurfaceState;
      state.disposeTextureListener =
        surface.onTexturesChanged?.(() => {
          state.bindGroupDirty = true;
        }) ?? null;
      return state;
    },
    disposeSurface(state) {
      state.disposeTextureListener?.();
      state.instances?.destroy();
      state.ring.destroy();
      state.bindGroup = null;
    },
    beginFrame() {
      if (!encoder) {
        encoder = device.createCommandEncoder({ label: "gsw-particles" });
        recorded = false;
        implicit = false;
      }
    },
    endFrame: flush,
    clear(state) {
      const view = currentView(state);
      if (view) {
        const pass = ensureEncoder().beginRenderPass({
          label: "gsw-particle-clear",
          colorAttachments: [
            {
              view,
              clearValue: TRANSPARENT,
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        });
        pass.end();
        recorded = true;
      }
      flushImplicit();
    },
    draw(state, buffer, opts) {
      const view = currentView(state);
      if (view) {
        encodeSurface(program, ensureEncoder(), state, view, buffer, opts);
        recorded = true;
      }
      flushImplicit();
    },
    submits: () => submitCount,
    captureSurface: (state, buffer, opts) =>
      captureSurfacePixels(program, options, state, buffer, opts),
  };
}

/** The canvas's current swap-chain view, or null when it cannot be had (an unconfigured context, a
 *  zero-sized canvas, a lost device). A frame that cannot acquire its target is SKIPPED, not thrown
 *  out of: the runtime's next tick asks again. */
function currentView(state: WebgpuParticleSurfaceState): GPUTextureView | null {
  try {
    return state.context.getCurrentTexture().createView();
  } catch {
    return null;
  }
}

/** Record one system's draw into `encoder`, targeting `view` (the canvas's swap-chain image, or a
 *  capture texture). Additive systems record TWO passes; passes execute in the order they were
 *  recorded, so accumulate→resolve is safe inside the shared one-submit frame. */
function encodeSurface(
  program: ParticleProgramGpu,
  encoder: GPUCommandEncoder,
  state: WebgpuParticleSurfaceState,
  view: GPUTextureView,
  buffer: InstanceBuffer,
  opts: WebgpuParticleDrawOptions,
  capture = false,
): void {
  const w = Math.max(1, Math.floor(opts.width));
  const h = Math.max(1, Math.floor(opts.height));
  writeParams(program, state, w, h, opts);
  uploadInstances(program, state, buffer);
  const textures = ensureBindGroup(program, state);
  const additive = opts.blendMode === 1;
  // Only the pipelines that write the TARGET are format-dependent; the accumulate pass always
  // renders into the `rgba8unorm` accumulator, capture or not.
  const pipelines = capture ? captureOrThrow(program) : program;

  if (additive) {
    const accum = ensureAccum(program, w, h);
    // ACCUMULATE. The load op clears the WHOLE (grow-only) accumulator, exactly as the GL path's
    // `gl.clear` does with no scissor — only the top-left w×h rect is ever read back.
    const accumPass = encoder.beginRenderPass({
      label: "gsw-particle-accumulate",
      colorAttachments: [
        {
          view: accum.view,
          clearValue: TRANSPARENT,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    // The viewport pins this system's NDC onto the accumulator's top-left w×h rect, so the resolve's
    // `textureLoad(pos.xy)` reads the texel the fragment wrote.
    accumPass.setViewport(0, 0, w, h, 0, 1);
    accumPass.setScissorRect(0, 0, w, h);
    accumPass.setPipeline(program.accumulate);
    accumPass.setBindGroup(0, state.ring.bindGroup, [0]);
    accumPass.setBindGroup(1, textures);
    accumPass.setVertexBuffer(0, program.corners);
    accumPass.setVertexBuffer(1, state.instances);
    accumPass.draw(4, buffer.count);
    accumPass.end();

    const resolvePass = encoder.beginRenderPass({
      label: "gsw-particle-resolve",
      colorAttachments: [
        { view, clearValue: TRANSPARENT, loadOp: "clear", storeOp: "store" },
      ],
    });
    resolvePass.setPipeline(pipelines.resolve);
    resolvePass.setBindGroup(0, accum.bindGroup);
    resolvePass.draw(4, 1);
    resolvePass.end();
    return;
  }

  const pass = encoder.beginRenderPass({
    label: "gsw-particle-draw",
    colorAttachments: [
      { view, clearValue: TRANSPARENT, loadOp: "clear", storeOp: "store" },
    ],
  });
  pass.setPipeline(pipelines.normal);
  pass.setBindGroup(0, state.ring.bindGroup, [0]);
  pass.setBindGroup(1, textures);
  pass.setVertexBuffer(0, program.corners);
  pass.setVertexBuffer(1, state.instances);
  pass.draw(4, buffer.count);
  pass.end();
}

/** The per-surface uniform slot. REWRITTEN EVERY DRAW rather than latched at create: a node canvas
 *  resizes (renderScale, a pin change, a rotation, a laid-out box moving), and a stale viewport maps
 *  every particle to the wrong clip position — silently, since nothing about it is an error. */
function writeParams(
  program: ParticleProgramGpu,
  state: WebgpuParticleSurfaceState,
  w: number,
  h: number,
  opts: WebgpuParticleDrawOptions,
): void {
  const textured = Boolean(opts.textured && state.textures.sprite);
  const [hframes, vframes] = frameGridFor(textured, opts.hframes, opts.vframes);
  const erode = opts.erode ?? null;
  const floats = state.ring.staging;
  const words = state.words;
  floats[0] = w;
  floats[1] = h;
  floats[2] = hframes;
  floats[3] = vframes;
  floats[4] = erode ? erode.threshold : 0;
  floats[5] = erode ? erode.softness : 0;
  words[6] = textured ? 1 : 0;
  words[7] = opts.lutTexture && state.textures.lut ? 1 : 0;
  words[8] = opts.alphaFromRed ? 1 : 0;
  words[9] = erode ? 1 : 0;
  words[10] = opts.maskTexture && state.textures.mask ? 1 : 0;
  words[11] = opts.uvPolar ? 1 : 0;
  program.device.queue.writeBuffer(
    state.ring.buffer,
    0,
    floats,
    0,
    PARAMS_FLOATS,
  );
}

/** The per-surface instance buffer: GROW-ONLY, like everything else in this pipeline, so a steady
 *  fleet allocates nothing per frame. */
function uploadInstances(
  program: ParticleProgramGpu,
  state: WebgpuParticleSurfaceState,
  buffer: InstanceBuffer,
): void {
  const bytes = Math.max(
    INSTANCE_STRIDE_BYTES,
    buffer.count * INSTANCE_STRIDE_BYTES,
  );
  if (!state.instances || bytes > state.instanceBytes) {
    state.instances?.destroy();
    state.instances = program.device.createBuffer({
      label: "gsw-particle-instances",
      size: bytes,
      usage: PARTICLE_BUFFER_USAGE.VERTEX | PARTICLE_BUFFER_USAGE.COPY_DST,
    });
    state.instanceBytes = bytes;
  }
  if (buffer.count <= 0) return;
  // Byte offsets into the ARRAY BUFFER (not element counts into the view): `InstanceBuffer.data` is
  // a grow-doubling `Float32Array` whose tail beyond `count` is stale, and only the used head is
  // uploaded.
  program.device.queue.writeBuffer(
    state.instances,
    0,
    buffer.data.buffer,
    buffer.data.byteOffset,
    buffer.count * INSTANCE_STRIDE_BYTES,
  );
}

/** The surface's texture bind group, rebuilt when a decode replaced one of its views (see
 *  `WebgpuParticleSurfaceState.boundViews`) and otherwise reused. */
function ensureBindGroup(
  program: ParticleProgramGpu,
  state: WebgpuParticleSurfaceState,
): GPUBindGroup {
  const spriteView = state.textures.sprite?.view ?? program.placeholderView;
  const lutView = state.textures.lut?.view ?? program.placeholderView;
  const maskView = state.textures.mask?.view ?? program.placeholderView;
  const stale =
    state.boundViews[0] !== spriteView ||
    state.boundViews[1] !== lutView ||
    state.boundViews[2] !== maskView;
  if (state.bindGroup && !state.bindGroupDirty && !stale)
    return state.bindGroup;
  state.bindGroup = program.device.createBindGroup({
    label: "gsw-particle-textures",
    layout: program.textureLayout,
    entries: [
      { binding: 0, resource: spriteView },
      {
        binding: 1,
        resource: state.textures.sprite?.sampler ?? program.placeholderSampler,
      },
      { binding: 2, resource: lutView },
      {
        binding: 3,
        resource: state.textures.lut?.sampler ?? program.placeholderSampler,
      },
      { binding: 4, resource: maskView },
      {
        binding: 5,
        resource: state.textures.mask?.sampler ?? program.placeholderSampler,
      },
    ],
  });
  state.boundViews = [spriteView, lutView, maskView];
  state.bindGroupDirty = false;
  return state.bindGroup;
}

/** Grow (never shrink) the device-scope light accumulator to cover w×h — the same policy, for the
 *  same realloc-cost reason, as the GL path's `ensureAccumTarget`. */
function ensureAccum(
  program: ParticleProgramGpu,
  w: number,
  h: number,
): AccumTarget {
  const current = program.accum;
  if (current && current.width >= w && current.height >= h) return current;
  const width = Math.max(current?.width ?? 0, w);
  const height = Math.max(current?.height ?? 0, h);
  current?.texture.destroy();
  const texture = program.device.createTexture({
    label: "gsw-particle-accum",
    size: [width, height, 1],
    format: ACCUM_FORMAT,
    usage:
      PARTICLE_TEXTURE_USAGE.RENDER_ATTACHMENT |
      PARTICLE_TEXTURE_USAGE.TEXTURE_BINDING,
  });
  const view = texture.createView();
  const accum: AccumTarget = {
    texture,
    view,
    bindGroup: program.device.createBindGroup({
      label: "gsw-particle-accum",
      layout: program.accumLayout,
      entries: [{ binding: 0, resource: view }],
    }),
    width,
    height,
  };
  program.accum = accum;
  return accum;
}

function captureOrThrow(program: ParticleProgramGpu): {
  normal: GPURenderPipeline;
  resolve: GPURenderPipeline;
} {
  const capture = program.capture;
  if (!capture) {
    // Unreachable: `captureSurfacePixels` compiles them before it encodes anything.
    throw new Error("gsw: capture pipelines were not compiled");
  }
  return capture;
}

/**
 * Re-render this surface's CURRENT frame into an offscreen texture and read it back.
 *
 * NEVER `drawImage`/`toDataURL` FROM THE CANVAS. Both read a WebGPU canvas through its presentation
 * path, which is blank under headless SwiftShader and pathological on Android Chrome (S7 measured
 * 23 Hz against 87 for direct presentation). `copyTextureToBuffer` + `mapAsync` — what
 * `../webgpu/readback` does — is the one path verified to work fully headless, which is why this
 * hook exists at all rather than the parity harness simply reading the canvas.
 *
 * The pipelines are the live ones re-created against `rgba8unorm`: a pipeline's fragment target
 * format must match its attachment, and the canvas format is usually `bgra8unorm`. Everything else —
 * module, entry points, blend states, uniforms, bind groups — is shared with the live draw, so what
 * comes back is the frame the canvas is showing, not a second interpretation of it.
 */
async function captureSurfacePixels(
  program: ParticleProgramGpu,
  options: WebgpuParticleRendererOptions,
  state: WebgpuParticleSurfaceState,
  buffer: InstanceBuffer,
  opts: WebgpuParticleDrawOptions,
): Promise<Uint8Array | null> {
  const w = Math.max(1, Math.floor(opts.width));
  const h = Math.max(1, Math.floor(opts.height));
  if (!program.capture) {
    const normal = await createPipeline(
      program.device,
      particlePipelineDescriptor(
        program.module,
        program.particleLayout,
        ACCUM_FORMAT,
        false,
      ),
      "gsw-particles-capture",
    );
    const resolve = await createPipeline(
      program.device,
      resolvePipelineDescriptor(
        program.resolveModule,
        program.resolvePipelineLayout,
        ACCUM_FORMAT,
      ),
      "gsw-particle-resolve-capture",
    );
    if (!normal || !resolve) return null;
    program.capture = { normal, resolve };
  }
  const target = program.device.createTexture({
    label: "gsw-particle-capture",
    size: [w, h, 1],
    format: ACCUM_FORMAT,
    usage:
      PARTICLE_TEXTURE_USAGE.RENDER_ATTACHMENT |
      PARTICLE_TEXTURE_USAGE.COPY_SRC,
  });
  try {
    const encoder = program.device.createCommandEncoder({
      label: "gsw-particle-capture",
    });
    encodeSurface(
      program,
      encoder,
      state,
      target.createView(),
      buffer,
      { ...opts, width: w, height: h },
      true,
    );
    program.device.queue.submit([encoder.finish()]);
    return await (
      options.readTexturePixels ??
      ((texture, width, height) =>
        readTexturePixels({ device: options.device }, texture, width, height))
    )(target, w, h);
  } catch {
    // A capture is a diagnostic, never a render: a device that refuses it reports nothing and the
    // live path is untouched.
    options.onPipelineError?.();
    return null;
  } finally {
    target.destroy();
  }
}

/** TEST-ONLY: drop the device-scope pipelines so a suite can re-probe with a fresh stub device. */
export function __resetWebgpuParticleProgramForTest(): void {
  programMemo = undefined;
  programSettled = undefined;
  programDevice = null;
}
