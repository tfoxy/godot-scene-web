// The WebGPU implementation of `ShaderRenderBackend` — the peer of `../webgl/shader-backend`'s
// WebGL one, rendering each Godot `ShaderMaterial` node STRAIGHT into its own canvas.
//
// WHY IT EXISTS (docs/perf-harness.md S6/S7, measured on a mid-range Android): the WebGL path draws
// every node into one shared offscreen canvas and BLITS the result onto the node's 2D canvas. That
// blit chain saturates Chrome's GPU process and halves whole-page update rates (89 → 47 Hz).
// Presenting from a per-node WebGPU canvas — no shared canvas, no blit, ONE `queue.submit` per tick
// — restored 87 Hz.
//
// PER-SHADER, NOT PER-RUNTIME. Each Godot shader gets its own WGSL module, bind-group layout and
// pipeline, cached at DEVICE scope and keyed by the same shader id the GL program cache uses. A
// shader this backend cannot express — it samples SCREEN_TEXTURE, its WGSL failed to compile, its
// pipeline failed validation — is remembered as `"webgl-only"` and its BINDING renders on the WebGL
// backend instead (the runtime counts `webgpuBindingFallbacks`). One screen-reading shader must not
// veto the other N canvases, which is the whole reason the backend hangs off the binding.
//
// THE THREE PAIRINGS THAT ARE LOAD-BEARING AND SILENT WHEN BROKEN:
//   1. `alphaMode: "premultiplied"` + a fragment returning `vec4f(rgb*a, a)` + `PREMULTIPLIED_BLEND`.
//      The transpiler emits the premultiplied return; this file supplies the other two. A straight
//      fragment under this blend halos; a premultiplied one under src-alpha double-multiplies.
//      Neither raises an error.
//   2. The uniform struct is one opaque byte block. `./pack-uniforms` writes it at the offsets
//      `./transpile-wgsl` computed; nothing here re-derives an offset.
//   3. A texture's `GPUTextureView` is REPLACED when its image decodes (`./textures`), so any bind
//      group built from the placeholder is stale from that moment. `ensureBindGroup` compares the
//      views it bound against the current ones — a check that cannot miss — and the `loaded`
//      listeners registered at create just save it a frame.
//
// WHAT THIS BACKEND DELIBERATELY DOES NOT DO: consult the frozen-frame CACHE. That cache trades a
// redraw for a 2D-canvas blit and there is no 2D canvas here, so the runtime keeps it for its WebGL
// bindings and never arms it on a WebGPU one (`cacheHits` stays 0 on this renderer, by design).
//
// WHAT IT DOES DO, since v2: feed the surface image SWAP. `renderNode` names each frozen frame with
// the shared `staticFrameKey`, which is all the swap's gate needs; the pixels themselves come from
// `captureSurface` below — an offscreen re-render plus `copyTextureToBuffer`, never a read of the
// canvas, because `drawImage`/`toDataURL`/`toBlob` on a WebGPU canvas is blank headless and
// pathological on Android (S7).

import {
  compileModule,
  createPipeline,
  createUniformStaging,
  createWebgpuShaderBindGroup,
  createWebgpuShaderBindGroupLayout,
  createWebgpuShaderUniformBuffer,
  packShaderUniforms,
  readTexturePixels,
  type ShaderUniformValues,
  type UniformStaging,
  WebgpuShaderExecutor,
} from "@godot-scene-web/canvas-effects/webgpu";
import {
  type TranspiledWgslShader,
  transpileGodotShaderWgsl,
} from "@godot-scene-web/effects/shaders";
import { noteStaticFrame } from "../surface-image-swap";
import { bakeTexture } from "../webgl/bake-texture";
import type {
  CompiledProgram,
  NodeBinding,
  SamplerBinding,
  ViewportRect,
} from "../webgl/runtime";
import {
  memoStaticFrameKey,
  parseAtlasRegion,
  parseSamplerSpecs,
  parseSamplerUrls,
  type ShaderRenderBackend,
  type ShaderTextureHandle,
  type ShaderTextureSpec,
  screenRect,
  texturesLoaded,
  uvFit,
} from "../webgl/shader-backend";
import {
  nodeTextureRepeats,
  onTextureLoaded,
  performanceNow,
} from "../webgl/shared-gl";
import {
  configureCanvas,
  latchWebgpuFallbackReason,
  SHADER_STAGE,
  type WebgpuShared,
} from "./device";
import {
  type GpuTextureEntry,
  getBakedTextureGpu,
  getImageTextureGpu,
  getRegionTextureGpu,
} from "./textures";

/**
 * `one / one-minus-src-alpha` on colour AND alpha: the composite for fragments that are already
 * premultiplied, which is the only kind a `alphaMode: "premultiplied"` canvas can present.
 *
 * DELIBERATELY THE ONLY BLEND STATE HERE. Godot's `render_mode blend_*` is NOT translated into a GPU
 * blend state on either backend: it is applied as a CSS `mix-blend-mode` on the NODE element
 * (`blendToMixBlendMode` in `../webgl/runtime`), because the thing an additive shader must add to is
 * the DOM painted behind the node, which no blend inside the node's own canvas can reach. Turning
 * `blend_add` into `ADDITIVE_BLEND` here would additionally blend the shader against the canvas's own
 * cleared transparent black — a no-op that then double-applies once CSS does the real compositing.
 * (The identical constant in `../particles/render-webgpu` is a local copy for the same reason: it is
 * one line of measured law, and an import across the particle/shader seam would be the only edge
 * between two otherwise independent renderers.)
 */
const PREMULTIPLIED_BLEND: GPUBlendState = {
  color: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
  alpha: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
};

const _TRANSPARENT: GPUColor = { r: 0, g: 0, b: 0, a: 0 };

/** Readback target format. A canvas is usually `bgra8unorm`, and a pipeline's fragment target format
 *  must match its attachment — hence the twin pipeline in `captureSurface`. */
const CAPTURE_FORMAT: GPUTextureFormat = "rgba8unorm";

/** The stand-in the node samples when it has no texture url at all: a 1×1 opaque WHITE, so the
 *  implicit `COLOR = texture(TEXTURE, UV)` yields the shader's own colour unchanged. Same key string
 *  as `getSolidTexture(gl, "white", …)` in `../webgl/shared-gl`. */
const SOLID_WHITE_KEY = "solid:white";

/** One shader compiled for one device. */
interface GpuShaderProgram {
  transpiled: TranspiledWgslShader;
  module: GPUShaderModule;
  bindGroupLayout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  pipeline: GPURenderPipeline;
  /** The `rgba8unorm`-targeted twin, compiled on the first `captureSurface`. Null until then — a
   *  runtime that never captures never pays for it. */
  capture: GPURenderPipeline | null;
}

/** Device-scope render state: every shader this page has compiled, plus the in-flight compiles so N
 *  bindings of one shader created in one reconcile share a single transpile+compile. Rebuilt from
 *  scratch when the device changes, exactly like the texture cache — pipelines belong to the device
 *  that made them. */
interface ShaderProgramsGpu {
  device: GPUDevice;
  format: GPUTextureFormat;
  /** `"webgl-only"` is a CACHED DECISION, not a missing entry: a shader that cannot be expressed in
   *  WGSL cannot become expressible later, and re-transpiling it per binding would pay for the same
   *  answer N times. */
  shaders: Map<string, GpuShaderProgram | "webgl-only">;
  pending: Map<string, Promise<boolean>>;
}

// The device-scope memo, in the shape of `./device`'s and `../particles/render-webgpu`'s: `settled`
// is the SYNC view the runtime's gate peeks at so a second runtime adopts without another
// round-trip.
let programsMemo: Promise<ShaderProgramsGpu | null> | undefined;
let programsSettled: ShaderProgramsGpu | null | undefined;
let programsDevice: GPUDevice | null = null;

function acquireShaderPrograms(
  shared: WebgpuShared,
): Promise<ShaderProgramsGpu | null> {
  if (programsDevice !== shared.device) {
    programsMemo = undefined;
    programsSettled = undefined;
    programsDevice = shared.device;
  }
  if (programsMemo) return programsMemo;
  // ASYNC even though nothing shader-independent needs compiling: this backend's unit of compilation
  // is the SHADER, and shaders arrive one at a time as bindings are created (`prepareShader`). The
  // promise is the contract the runtime's gate already speaks — the same one the particle backend
  // uses to await its fixed WGSL — and it is where a future device-scope resource would land.
  programsMemo = Promise.resolve<ShaderProgramsGpu>({
    device: shared.device,
    format: shared.format,
    shaders: new Map(),
    pending: new Map(),
  }).then((programs) => {
    programsSettled = programs;
    return programs;
  });
  return programsMemo;
}

/** `undefined` = not built yet (the caller must await `createWebgpuShaderBackend`), otherwise the
 *  device's program cache. */
function peekShaderPrograms(
  shared: WebgpuShared,
): ShaderProgramsGpu | null | undefined {
  if (programsDevice !== shared.device) return undefined;
  return programsSettled;
}

/** Per-binding GPU state, keyed by the node CANVAS rather than stored on the binding: a canvas holds
 *  exactly ONE context for its lifetime, so it is the natural identity for the context and the
 *  buffers hanging off it, and keeping it here leaves `NodeBinding` renderer-agnostic. */
interface WebgpuShaderSurface {
  context: GPUCanvasContext;
  program: GpuShaderProgram;
  staging: UniformStaging;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup | null;
  /** The views `bindGroup` was built from, in binding order — see the header's point 3. */
  boundViews: unknown[];
  bindGroupDirty: boolean;
  disposers: Array<() => void>;
  executor: WebgpuShaderExecutor;
}

const surfaces = new WeakMap<HTMLCanvasElement, WebgpuShaderSurface>();

/** The WebGPU backend's own surface over `ShaderRenderBackend`: the same interface every binding
 *  drives, plus the two calls the runtime's gate needs to decide PER BINDING whether this backend can
 *  render a given shader at all. */
export interface WebgpuShaderBackend extends ShaderRenderBackend {
  readonly kind: "webgpu";
  /**
   * Compile `shaderKey` for this device, resolving TRUE when a binding of it can render here and
   * FALSE when it is webgl-only (unsupported construct, failed WGSL compile, failed pipeline
   * validation). Never throws and never fails the backend — that asymmetry is the point.
   *
   * `source` may be undefined when the caller could not resolve it; the answer is then false and is
   * NOT cached, since a later create may well have the source.
   */
  prepareShader(
    shaderKey: string,
    source: string | undefined,
  ): Promise<boolean>;
  /** The SYNC view of `prepareShader`: `undefined` = not decided yet. */
  peekShader(shaderKey: string): boolean | undefined;
  submits(): number;
}

export interface WebgpuShaderBackendDeps {
  /** Longest-edge cap for texture uploads, from `maxTextureDimension`. Accepted for signature parity
   *  with the WebGL backend and DELIBERATELY UNUSED in v1: the GL cap exists to avoid a multi-hundred
   *  -millisecond main-thread `texImage2D`, a cost a queue copy does not have, and honouring it would
   *  change the uploaded size and therefore `TEXTURE_PIXEL_SIZE` — a parity difference for a
   *  mitigation this path does not need. */
  maxTextureDim?: number | undefined;
}

/**
 * The WebGPU shader backend over an already-acquired device, or NULL when this device cannot host one.
 *
 * ASYNC, unlike `createWebglShaderBackend`: WebGPU offers no synchronous way to learn that a shader
 * compiled. The runtime is already inside an async gate when it calls this — the device itself came
 * from a promise.
 */
export async function createWebgpuShaderBackend(
  shared: WebgpuShared,
  deps: WebgpuShaderBackendDeps = {},
): Promise<WebgpuShaderBackend | null> {
  const programs = await acquireShaderPrograms(shared);
  return programs ? backendOver(shared, programs, deps) : null;
}

/** The SYNC path for a runtime on a page where the device-scope state already exists: `undefined` =
 *  not ready (await the factory), `null` = this device refused it, otherwise a fresh backend. Each
 *  backend object owns its OWN frame state, so two runtimes ticking over one device cannot land in
 *  each other's command encoder. */
export function peekWebgpuShaderBackend(
  shared: WebgpuShared,
  deps: WebgpuShaderBackendDeps = {},
): WebgpuShaderBackend | null | undefined {
  const programs = peekShaderPrograms(shared);
  if (programs === undefined) return undefined;
  return programs === null ? null : backendOver(shared, programs, deps);
}

function backendOver(
  shared: WebgpuShared,
  programs: ShaderProgramsGpu,
  _deps: WebgpuShaderBackendDeps,
): WebgpuShaderBackend {
  const { device } = shared;
  const executor = new WebgpuShaderExecutor(device);
  // ONE encoder per tick (see the module header). `recorded` keeps an empty tick from submitting an
  // empty command buffer; `implicit` covers a draw that arrives OUTSIDE a begin/endFrame bracket —
  // the runtime always brackets, but a frame that silently never reached the screen is not a failure
  // mode worth leaving open.
  let encoder: GPUCommandEncoder | null = null;
  let recorded = false;
  let implicit = false;
  let _submits = 0;

  const _ensureEncoder = (): GPUCommandEncoder => {
    if (!encoder) {
      encoder = device.createCommandEncoder({ label: "gsw-shaders" });
      implicit = true;
    }
    return encoder;
  };
  const flush = (): void => {
    if (encoder && recorded) {
      device.queue.submit([encoder.finish()]);
      _submits += 1;
    }
    encoder = null;
    recorded = false;
    implicit = false;
  };

  return {
    kind: "webgpu",

    async prepareShader(shaderKey, source) {
      const known = programs.shaders.get(shaderKey);
      if (known !== undefined) return known !== "webgl-only";
      const inFlight = programs.pending.get(shaderKey);
      if (inFlight) return inFlight;
      if (!source) {
        // No source and no cached decision: this binding takes WebGL, but the SHADER is not condemned
        // — the source may resolve on a later create.
        return false;
      }
      const compile = buildShaderProgram(
        shared,
        programs,
        shaderKey,
        source,
      ).finally(() => {
        programs.pending.delete(shaderKey);
      });
      programs.pending.set(shaderKey, compile);
      return compile;
    },

    peekShader(shaderKey) {
      const known = programs.shaders.get(shaderKey);
      return known === undefined ? undefined : known !== "webgl-only";
    },

    createSurface(spec) {
      const program = programs.shaders.get(spec.shaderKey);
      // Unreachable through the runtime (it only creates a WebGPU binding after `prepareShader`
      // answered true), and a null here is the same benign outcome as a refused context: no binding,
      // and the node keeps its CSS/SVG paint.
      if (!program || program === "webgl-only") return null;
      // A canvas holds ONE context type for its whole life, so this is where the choice is made — and
      // a refusal is permanent for this element, not a retryable error. `configureCanvas` has already
      // latched `context-refused`.
      const context = configureCanvas(spec.canvas, shared);
      if (!context) return null;
      // The flag `drawableSource` (the SCREEN_TEXTURE composite in `../webgl/runtime`) keys on to
      // never `drawImage` this canvas. Stamped by this backend ONLY.
      spec.canvas.setAttribute("data-godot-effects-backend", "webgpu");

      const texture = resolveNodeTextureGpu(shared, spec);
      const samplers = resolveSamplersGpu(shared, spec.node, spec.program);
      const staging = createUniformStaging(
        program.transpiled.uniformStructSizeBytes,
      );
      const uniformBuffer = createWebgpuShaderUniformBuffer(
        device,
        `gsw-shader-uniforms:${spec.shaderKey}`,
        staging.bytes.byteLength,
      );
      const state: WebgpuShaderSurface = {
        context,
        program,
        staging,
        uniformBuffer,
        bindGroup: null,
        boundViews: [],
        bindGroupDirty: true,
        disposers: [],
        executor,
      };
      // THE VIEW-REPLACEMENT CONTRACT (`./textures`): a decode REPLACES the entry's texture AND view,
      // so a bind group built from the placeholder is stale from that moment. `ensureBindGroup`'s
      // view comparison catches it either way; this just means the rebuild lands on the same frame
      // the runtime's own listener re-renders.
      for (const entry of [texture, ...samplers.map((s) => s.entry)]) {
        state.disposers.push(
          onTextureLoaded(entry, () => {
            state.bindGroupDirty = true;
          }),
        );
      }
      surfaces.set(spec.canvas, state);
      // `ctx2d: null` is not an omission — it is the fact every 2D-only feature in the runtime keys
      // off (the frozen-frame cache, the surface image swap). See `ShaderSurface`.
      return { canvas: spec.canvas, ctx2d: null, texture, samplers };
    },

    resolveNodeTexture: (spec) => resolveNodeTextureGpu(shared, spec),
    resolveSamplers: (node, program) =>
      resolveSamplersGpu(shared, node, program),

    disposeSurface(binding) {
      const state = surfaces.get(binding.canvas);
      if (!state) return;
      for (const dispose of state.disposers) dispose();
      state.disposers.length = 0;
      state.uniformBuffer.destroy();
      state.bindGroup = null;
      // Hand the swap chain back. The canvas element itself belongs to the runtime, which removes it
      // — but an unconfigured context stops holding its backing images either way.
      try {
        state.context.unconfigure();
      } catch {
        // A context whose device is already lost refuses this on some implementations; there is
        // nothing left to release in that case anyway.
      }
      surfaces.delete(binding.canvas);
    },

    renderNode(binding, time, staticMode, getRootRect, stats, prof) {
      const w = binding.canvas.width;
      const h = binding.canvas.height;
      if (w < 1 || h < 1) return false;
      const state = surfaces.get(binding.canvas);
      if (!state) return false;
      // NO STATIC-FRAME CACHE HERE, on purpose — and that is still true. That cache trades a redraw
      // for a 2D blit onto the node canvas; on this backend the blit does not exist and there is no
      // readable 2D canvas to publish a frame INTO, so a frozen WebGPU binding renders its one frame
      // and parks, with the canvas holding its last PRESENTED image. What IS fed, since v2, is the
      // image SWAP: the frozen frame is named below with the same `staticFrameKey` the GL backend
      // uses, and the swap's capture hook re-renders those pixels offscreen rather than reading the
      // canvas (see `../surface-image-swap`'s CAPTURE-HOOK SOURCES). `staticMode` is the caller's
      // promise that `time` is the pinned one, which is what makes the key nameable at all.
      // GL SUBMIT bucket — ENCODE + UPLOAD issue cost only (the GPU runs async, and the submit itself
      // happens at `endFrame`). `blitMs` stays untouched: there is no blit on this path, and an
      // honest zero there IS the architecture.
      const start = prof ? performanceNow() : 0;
      writeUniforms(shared, state, binding, time, getRootRect, w, h);
      const bindGroup = ensureBindGroup(shared, state, binding);
      if (
        !executor.draw({
          context: state.context,
          pipeline: state.program.pipeline,
          bindGroup,
          uniformBuffer: state.uniformBuffer,
          uniformBytes: state.staging.bytes,
          width: w,
          height: h,
        })
      )
        return false;
      recorded = true;
      if (prof) prof.glMs += performanceNow() - start;
      if (stats) stats.draws++;
      // The frozen-frame signal, at the same point in the draw the GL backend emits it (and with the
      // same cacheable predicate): frozen mode, no screen-space input, every texture decoded. A null
      // key retires a live swap, because the surface is not producing frozen output at all.
      //
      // Computed whether or not a swap is live, since v3: the key is also what the CONSUMER-facing
      // `GodotEffectRenderInfo.staticKey` reports, and a host compositing these canvases wants to know
      // two of them hold the same frame even on a backend that never blits one into the other.
      const cacheable =
        staticMode &&
        !binding.program.usesScreenUv &&
        !binding.program.usesScreenTexture &&
        texturesLoaded(binding);
      binding.lastStaticKey = cacheable
        ? memoStaticFrameKey(binding, w, h, time)
        : null;
      if (binding.staticImage && stats) {
        noteStaticFrame(binding, binding.lastStaticKey, stats);
      }
      if (implicit) flush();
      return true;
    },

    beginFrame() {
      executor.beginFrame();
    },
    endFrame() {
      executor.endFrame();
    },

    // A WebGPU canvas larger than the device's limit simply cannot produce a texture — unlike the GL
    // path, whose shared drawing buffer discovers its ceiling at draw time and scales the blit up to
    // cover the node. So the ceiling is folded into the sizing law up front.
    maxBackingDim() {
      return shared.limits.maxTextureDimension2D;
    },

    submits() {
      return executor.submits();
    },

    captureSurface: (binding, time, staticMode, getRootRect) =>
      captureSurfacePixels(shared, binding, time, staticMode, getRootRect),
  };
}

// ---- shader compilation ----------------------------------------------------

async function buildShaderProgram(
  shared: WebgpuShared,
  programs: ShaderProgramsGpu,
  shaderKey: string,
  source: string,
): Promise<boolean> {
  const { device } = shared;
  let transpiled: TranspiledWgslShader;
  try {
    transpiled = transpileGodotShaderWgsl(source);
  } catch {
    // EVERY throw is "webgl-only" here, `UnsupportedWgslShaderError` and the plain
    // `UnsupportedShaderError` alike. The distinction the two classes carry — "WGSL can't" vs "no
    // backend can" — is the CSS-fallback ladder's business, and by the time this runs the GL side has
    // already compiled this shader successfully, so a plain unsupported error can only mean the two
    // front-ends disagree. Either way this binding renders on WebGL, which is the answer that is
    // right in both readings. No `reportUnsupportedRender`: nothing failed to render.
    programs.shaders.set(shaderKey, "webgl-only");
    return false;
  }

  const label = `gsw-shader:${shaderKey}`;
  const module = await compileModule(device, transpiled.wgsl, label, () =>
    latchWebgpuFallbackReason("pipeline-error"),
  );
  if (!module) {
    programs.shaders.set(shaderKey, "webgl-only");
    return false;
  }
  const bindGroupLayout = createWebgpuShaderBindGroupLayout(
    device,
    label,
    bindGroupLayoutEntries(transpiled),
  );
  const pipelineLayout = device.createPipelineLayout({
    label,
    bindGroupLayouts: [bindGroupLayout],
  });
  const pipeline = await createPipeline(
    device,
    pipelineDescriptor(
      transpiled,
      module,
      pipelineLayout,
      shared.format,
      label,
    ),
    label,
    () => latchWebgpuFallbackReason("pipeline-error"),
  );
  if (!pipeline) {
    programs.shaders.set(shaderKey, "webgl-only");
    return false;
  }
  programs.shaders.set(shaderKey, {
    transpiled,
    module,
    bindGroupLayout,
    pipelineLayout,
    pipeline,
    capture: null,
  });
  return true;
}

/** `@group(0)`, exactly as `./transpile-wgsl` declares it: the uniform struct at 0, the node TEXTURE
 *  and its sampler at 1/2, and each user sampler as a texture/sampler PAIR from 3. */
function bindGroupLayoutEntries(
  transpiled: TranspiledWgslShader,
): GPUBindGroupLayoutEntry[] {
  const { bindings } = transpiled;
  const entries: GPUBindGroupLayoutEntry[] = [
    {
      binding: bindings.uniform,
      visibility: SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT,
      buffer: {
        type: "uniform",
        minBindingSize: transpiled.uniformStructSizeBytes,
      },
    },
    {
      binding: bindings.texture,
      visibility: SHADER_STAGE.FRAGMENT,
      texture: {},
    },
    {
      binding: bindings.textureSampler,
      visibility: SHADER_STAGE.FRAGMENT,
      sampler: {},
    },
  ];
  for (let i = 0; i < transpiled.samplers.length; i++) {
    entries.push({
      binding: bindings.userSamplersBase + 2 * i,
      visibility: SHADER_STAGE.FRAGMENT,
      texture: {},
    });
    entries.push({
      binding: bindings.userSamplersBase + 2 * i + 1,
      visibility: SHADER_STAGE.FRAGMENT,
      sampler: {},
    });
  }
  return entries;
}

function pipelineDescriptor(
  transpiled: TranspiledWgslShader,
  module: GPUShaderModule,
  layout: GPUPipelineLayout,
  format: GPUTextureFormat,
  label: string,
): GPURenderPipelineDescriptor {
  return {
    label,
    layout,
    // No vertex buffers: `vs_main` builds the full-screen strip from `@builtin(vertex_index)`.
    vertex: { module, entryPoint: transpiled.vertexEntry },
    fragment: {
      module,
      entryPoint: transpiled.fragmentEntry,
      // ALWAYS premultiplied — see `PREMULTIPLIED_BLEND` for why the Godot blend mode is not here.
      targets: [{ format, blend: PREMULTIPLIED_BLEND }],
    },
    primitive: { topology: "triangle-strip" },
  };
}

// ---- texture resolution ----------------------------------------------------

/** The shader's input texture, resolved from the SAME attributes the WebGL backend reads: the atlas
 *  SUB-RECT when the self-layer carries a region (cropping is what stops an atlas-sprite recolour
 *  from sampling page padding), the whole image otherwise, and a 1×1 solid white with no url at all. */
function resolveNodeTextureGpu(
  shared: WebgpuShared,
  spec: ShaderTextureSpec,
): GpuTextureEntry {
  const { node, selfLayer, textureUrl } = spec;
  if (!textureUrl) {
    return getBakedTextureGpu(shared, SOLID_WHITE_KEY, () => ({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([255, 255, 255, 255]),
    }));
  }
  const repeat = nodeTextureRepeats(node);
  const region = parseAtlasRegion(
    selfLayer.getAttribute("data-godot-atlas-region"),
  );
  return region
    ? getRegionTextureGpu(shared, textureUrl, region, { repeat })
    : getImageTextureGpu(shared, textureUrl, { repeat });
}

/** The user sampler uniforms, from the same `data-godot-shader-sampler*` attributes and under the
 *  same bake keys as the WebGL path — so a page that falls back mid-run re-derives the same textures
 *  rather than a second interpretation of the same specs. `unit` is the user-sampler INDEX here (see
 *  `SamplerBinding.unit`); a sampler with no resolvable source is omitted, and `ensureBindGroup`
 *  fills its slot with the node TEXTURE. */
function resolveSamplersGpu(
  shared: WebgpuShared,
  node: HTMLElement,
  program: CompiledProgram,
): SamplerBinding[] {
  if (program.samplers.length === 0) return [];
  const specs = parseSamplerSpecs(
    node.getAttribute("data-godot-shader-samplers"),
  );
  const urls = parseSamplerUrls(
    node.getAttribute("data-godot-shader-sampler-urls"),
  );
  const out: SamplerBinding[] = [];
  program.samplers.forEach((sampler, index) => {
    const url = urls[sampler.name];
    if (url) {
      out.push({
        name: sampler.name,
        entry: getImageTextureGpu(shared, url, { repeat: sampler.repeat }),
        unit: index,
        frameIdentity: ["url", url, sampler.repeat],
      });
      return;
    }
    const spec = specs[sampler.name];
    if (!spec) return;
    const specIdentity = JSON.stringify(spec) ?? "undefined";
    const key = `${sampler.name}:${specIdentity}`;
    out.push({
      name: sampler.name,
      entry: getBakedTextureGpu(shared, key, () => bakeTexture(spec), {
        repeat: sampler.repeat,
      }),
      unit: index,
      frameIdentity: ["bake", specIdentity, sampler.repeat],
    });
  });
  return out;
}

// This backend only ever renders bindings IT created (the binding remembers the backend that made its
// surface, and a backend swap re-creates the binding on a NEW canvas), so every handle it is handed
// really is a `GpuTextureEntry`.
function gpuEntry(handle: ShaderTextureHandle): GpuTextureEntry {
  return handle as GpuTextureEntry;
}

// ---- the draw --------------------------------------------------------------

/** Pack this binding's uniform struct and upload it. The VALUES are the same ones `renderNodeGl`
 *  writes through `gl.uniform*` — TIME, TEXTURE_PIXEL_SIZE, MODULATE, the uv fit/window and the
 *  SCREEN_UV rect — computed by the SAME functions (`uvFit`, `screenRect`), so the two renderers
 *  cannot drift on arithmetic. Only the destination differs: named locations there, byte offsets
 *  here (`./pack-uniforms`). */
function writeUniforms(
  shared: WebgpuShared,
  state: WebgpuShaderSurface,
  binding: NodeBinding,
  time: number,
  getRootRect: () => ViewportRect,
  w: number,
  h: number,
): void {
  const { transpiled } = state.program;
  const texture = binding.texture;
  const values: ShaderUniformValues = {
    uvFit: uvFit(binding, w, h),
    uvWindow: binding.window,
    modulate: binding.modulate,
    params: binding.params,
    paramKinds: binding.paramKinds,
  };
  if (transpiled.usesTime) values.time = time;
  if (transpiled.usesTexturePixelSize) {
    values.texturePixelSize = [1 / texture.width, 1 / texture.height];
  }
  if (transpiled.usesScreenUv) {
    const [ox, oy, sx, sy] = screenRect(binding, getRootRect());
    values.screenOrigin = [ox, oy];
    values.screenSize = [sx, sy];
  }
  packShaderUniforms(transpiled, values, state.staging);
  shared.device.queue.writeBuffer(
    state.uniformBuffer,
    0,
    state.staging.bytes,
    0,
    state.staging.bytes.byteLength,
  );
}

/** The binding's `@group(0)` bind group, rebuilt when a decode replaced one of its views and reused
 *  otherwise. User samplers are matched BY NAME against the WGSL sampler list rather than by the
 *  order `resolveSamplers` happened to produce, so the two front-ends' sampler ordering never has to
 *  be assumed equal. A sampler with no resolvable source gets the node TEXTURE — WGSL bindings are
 *  static and every slot must be filled, and the node texture is exactly what an unset `sampler2D`
 *  uniform reads on the WebGL path (an unwritten sampler uniform defaults to texture unit 0). */
function ensureBindGroup(
  shared: WebgpuShared,
  state: WebgpuShaderSurface,
  binding: NodeBinding,
): GPUBindGroup {
  const { transpiled, bindGroupLayout } = state.program;
  const { bindings } = transpiled;
  const node = gpuEntry(binding.texture);
  const byName = new Map(
    binding.samplers.map((sampler) => [sampler.name, gpuEntry(sampler.entry)]),
  );

  const entries: GPUBindGroupEntry[] = [
    {
      binding: bindings.uniform,
      resource: { buffer: state.uniformBuffer },
    },
    { binding: bindings.texture, resource: node.view },
    { binding: bindings.textureSampler, resource: node.sampler },
  ];
  const views: unknown[] = [node.view];
  transpiled.samplers.forEach((sampler, i) => {
    const entry = byName.get(sampler.name) ?? node;
    entries.push({
      binding: bindings.userSamplersBase + 2 * i,
      resource: entry.view,
    });
    entries.push({
      binding: bindings.userSamplersBase + 2 * i + 1,
      resource: entry.sampler,
    });
    views.push(entry.view);
  });

  const stale =
    state.boundViews.length !== views.length ||
    views.some((view, i) => state.boundViews[i] !== view);
  if (state.bindGroup && !state.bindGroupDirty && !stale)
    return state.bindGroup;

  state.bindGroup = createWebgpuShaderBindGroup(
    shared.device,
    "gsw-shader-bindings",
    bindGroupLayout,
    entries,
  );
  state.boundViews = views;
  state.bindGroupDirty = false;
  return state.bindGroup;
}

// ---- readback --------------------------------------------------------------

/**
 * Re-render this binding's CURRENT frame into an offscreen texture and read it back.
 *
 * NEVER `drawImage`/`toDataURL` FROM THE CANVAS. Both read a WebGPU canvas through its presentation
 * path, which is blank under headless SwiftShader and pathological on Android Chrome (S7 measured
 * 23 Hz against 87 for direct presentation). `copyTextureToBuffer` + `mapAsync` — what `./readback`
 * does — is the one path verified to work fully headless, which is why this hook exists at all
 * rather than the parity harness simply reading the canvas.
 *
 * The pipeline is the live one re-created against `rgba8unorm`: a pipeline's fragment target format
 * must match its attachment, and the canvas format is usually `bgra8unorm`. Everything else — module,
 * entry points, blend state, uniforms, bind group — is shared with the live draw, so what comes back
 * is the frame the canvas is showing, not a second interpretation of it.
 */
async function captureSurfacePixels(
  shared: WebgpuShared,
  binding: NodeBinding,
  time: number,
  staticMode: boolean,
  getRootRect: () => ViewportRect,
): Promise<Uint8Array | null> {
  void staticMode;
  const state = surfaces.get(binding.canvas);
  if (!state) return null;
  const w = Math.max(1, Math.floor(binding.canvas.width));
  const h = Math.max(1, Math.floor(binding.canvas.height));
  if (binding.canvas.width < 1 || binding.canvas.height < 1) return null;

  const program = state.program;
  if (!program.capture) {
    const capture = await createPipeline(
      shared.device,
      pipelineDescriptor(
        program.transpiled,
        program.module,
        program.pipelineLayout,
        CAPTURE_FORMAT,
        "gsw-shader-capture",
      ),
      "gsw-shader-capture",
    );
    if (!capture) return null;
    program.capture = capture;
  }
  try {
    writeUniforms(shared, state, binding, time, getRootRect, w, h);
    const bindGroup = ensureBindGroup(shared, state, binding);
    return await state.executor.capture({
      pipeline: program.capture,
      bindGroup,
      uniformBuffer: state.uniformBuffer,
      uniformBytes: state.staging.bytes,
      width: w,
      height: h,
      read: (texture, width, height) =>
        readTexturePixels(shared, texture, width, height),
    });
  } catch {
    // A capture is a diagnostic, never a render: a device that refuses it reports nothing and the
    // live path is untouched.
    latchWebgpuFallbackReason("pipeline-error");
    return null;
  }
}

/** TEST-ONLY: drop the device-scope programs so a suite can re-probe with a fresh stub device. */
export function __resetWebgpuShaderProgramsForTest(): void {
  programsMemo = undefined;
  programsSettled = undefined;
  programsDevice = null;
}
