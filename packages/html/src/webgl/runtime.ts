// Live WebGL2 runtime that renders supported Godot `ShaderMaterial` nodes by
// executing the ACTUAL shader (transpiled to GLSL ES 3.00), instead of the
// CSS/SVG approximation. It runs only in the live DOM/Vue renderers (the static
// html-string renderer never calls it, so it keeps the SVG fallback).
//
// Design:
//   - ONE shared WebGL2 context (an offscreen canvas) renders every node, so we
//     never hit the browser's ~16-live-context limit even with many cards. Each
//     node owns a cheap 2D `<canvas>` that the shared GL output is blitted onto.
//     The context, texture cache, and monotonic clock live in `./shared-gl`,
//     shared with the particle runtime.
//   - Programs (transpile+compile) are cached at module scope, keyed by shader id,
//     so re-renders (state changes) reuse them.
//   - A single rAF clock feeds `TIME`; only shaders that read `TIME` re-render per
//     frame, static ones render once (and on resize). Under an FPS cap the loop PARKS on a timer
//     to the next cap boundary instead of arming a rAF per display frame — see
//     `../effects-loop-pacing` (and `effectsLoopPacing: "raf"` to restore the spin).
//   - Everything the runtime needs is read from the mounted DOM + `options`
//     (the shader id/params/modulate are data-attributes set by `material.ts`;
//     the texture URL + fit come from the self-layer's background paint), so the
//     caller holds a persistent runtime and reconciles it after DOM updates.
//   - NO forced layout in the render loop: the viewport rects a SCREEN_UV/SCREEN_TEXTURE shader
//     needs (the scene root's, and the node self-layer's) are CACHED and refreshed in ONE batched
//     read at tick start, only when something invalidated them (see "rect cache" below).
//   - Occlusion: a binding under a `data-godot-effects-suspended` ancestor is SUSPENDED — skipped
//     by the loop and not counted as animated, so a covered subtree costs nothing per frame. See
//     `../effects-suspend` for the full contract.
//   - Dormancy: a node carrying `data-godot-shader-dormant` keeps its binding but parks it (hidden
//     canvas, skipped by the loop AND the rect batch, `syncCanvasSize` deferred to the wake), so a
//     node flipping in and out of a shader-off state no longer pays a create-time forced layout per
//     flip. A binding dormant for ~30s is disposed by ONE per-runtime sweep. See `../shader-dormant`.
//   - Image swap: a binding whose surface has been observed not to move is shown as an `<img>` of
//     its own frame instead of its canvas (the canvas stays, hidden), which drops its compositor
//     layer, its render surface and its per-frame GPU fill. The MECHANISM lives in
//     `../surface-image-swap` (generic, no WebGL); the POLICY — which gate, what an invalidation
//     does, encode pacing, a host veto — comes from the `staticShaderImages` option, whose default
//     (`true`) is the frozen-mode content-key gate that shipped first. `false` is the kill switch.

import {
  compileProgramAsync,
  createWebglTexture,
  uploadWebglTexture,
} from "@godot-scene-web/canvas-effects/webgl";
import {
  expandGodotShaderIncludes,
  type GodotBlendMode,
  type ShaderSampler,
  type ShaderUniform,
  type TranspiledShader,
  transpileGodotShader,
  UnsupportedShaderError,
} from "@godot-scene-web/effects/shaders";
import {
  reportUnsupportedRender,
  type UnsupportedRenderReporter,
} from "../diagnostics";
import { createEffectsLoopPacer } from "../effects-loop-pacing";
import { isEffectsSuspended } from "../effects-suspend";
import { ownSelfLayer, SELF_LAYER_CLASS } from "../render-structure";
import type { GodotHtmlRuntimeOptions } from "../runtime-options";
import { DORMANT_DISPOSE_SECONDS, isShaderDormant } from "../shader-dormant";
import {
  applySurfaceVisibility,
  createStaticImageSwapCounters,
  createStaticSurfaceSwapper,
  disposeStaticImage,
  liveStaticImageUrlCount,
  noteStaticImageReconcile,
  noteStaticSurfaceWake,
  onStaticFrameEvicted,
  revertStaticImage,
  type StaticImageState,
  type StaticImageSwapCounters,
  type StaticSurfaceCapture,
  type StaticSurfaceSwapper,
  staticStillPoolStats,
} from "../surface-image-swap";
import type { GodotEffectRenderInfo } from "../types";
import {
  acquireWebgpuDevice,
  latchWebgpuFallbackReason,
  onWebgpuDeviceLost,
  peekWebgpuDevice,
  type WebgpuFallbackReason,
  type WebgpuShared,
  webgpuFallbackReason,
} from "../webgpu/device";
import {
  createWebgpuShaderBackend,
  peekWebgpuShaderBackend,
  type WebgpuShaderBackend,
} from "../webgpu/render-shader";
import { canvasFromPremultipliedRgba } from "../webgpu/still-capture";
import {
  createWebglShaderBackend,
  layerRect,
  memoStaticFrameKey,
  parseAtlasRegion,
  quantizeForKey,
  type ShaderRenderBackend,
  type ShaderTextureHandle,
  type StaticSamplerIdentity,
  texturesLoaded,
} from "./shader-backend";
import {
  backingStoreSize,
  effectivePixelRatio,
  getShared,
  MAX_PINNED_BACKING_DIM,
  nodeTextureRepeats,
  normalizeStaticPixelRatio,
  nowSeconds,
  onTextureLoaded,
  parseSurfacePixelRatio,
  type SharedGl,
  SURFACE_PIXEL_RATIO_ATTR,
} from "./shared-gl";

// The GL-typed helpers the render backend now owns, re-exported so their long-standing import
// specifier (`./webgl/runtime`) keeps working for consumers and tests.
export { parseAtlasRegion } from "./shader-backend";

/** A transpiled+compiled shader and everything a render needs to know about it. Exported as a TYPE
 *  for the render backend (`./shader-backend`); the program cache itself stays here. */
export interface CompiledProgram {
  program: WebGLProgram;
  uniformLocations: Map<string, WebGLUniformLocation | null>;
  uniforms: ShaderUniform[];
  samplers: ShaderSampler[];
  usesTime: boolean;
  usesTexturePixelSize: boolean;
  usesScreenUv: boolean;
  /** The shader samples SCREEN_TEXTURE → the runtime maintains a per-binding screen capture. */
  usesScreenTexture: boolean;
  usesScreenPixelSize: boolean;
  /** render_mode blend (mix/add/sub/mul/premul_alpha) → applied as a CSS mix-blend-mode on the node. */
  blend: GodotBlendMode;
}

// Programs are cached at module scope, keyed by shader id, so re-renders reuse them.
const programCache = new Map<string, CompiledProgram | "unsupported">();

// In-flight compiles, keyed exactly like `programCache` and holding only the promise (every SETTLED
// verdict, "unsupported" included, still lands in the cache). Building a program is asynchronous now
// — the status query is deferred until the driver says it will not block (see `compileProgramAsync`)
// — so the window in which a shader is "being compiled" is real, and N nodes that want the same
// shader inside it must share ONE compile rather than each kicking the driver with its own copy.
// Same shape, and the same settle-cleanup, as `shaderSourceRequests` below.
const programRequests = new Map<string, Promise<CompiledProgram | null>>();

// The program-cache key. Screen-capture-enabled runtimes compile under their own
// namespace, so an option-off runtime's "unsupported" verdict for a SCREEN_TEXTURE
// shader (the gate below) never poisons an option-on runtime sharing the module
// cache — and vice versa. For the default (option off) everything is keyed exactly
// as before.
function programCacheKey(shaderKey: string, screenCapture: boolean): string {
  return screenCapture ? `screen-capture:${shaderKey}` : shaderKey;
}

// Static-frame cache (frozen-TIME mode ONLY): a node renders its shader once, so identical inputs across nodes
// (e.g. 12 playable cards sharing the same glow, or the same node re-created across remounts) can reuse one
// rendered bitmap and SKIP the GL draw entirely — one render + N cheap 2D blits. Keyed by the shader + canvas
// size + fit + texture identity + the EXACT uv-window + QUANTIZED params/modulate (so the producer's per-delta
// param jitter doesn't bust it). The window is deliberately NOT quantized: it is geometry — which sub-rect of
// the node the frame's pixels COVER — so serving a frame across any window delta paints the wrong pixels (the
// UNDERDOCKS widened-background band bug: a frame cached under the old clip window was blitted for the widened
// one whenever the quantized keys collided). NEVER consulted for live TIME shaders (their output changes every
// frame). Module-scoped + LRU-bounded, like programCache/textureCache; survives remounts, never cleared on
// dispose.
const STATIC_FRAME_CACHE_LIMIT = 64;
const staticFrameCache = new Map<string, HTMLCanvasElement>();

// `quantizeForKey`/`staticFrameKey` live in `./shader-backend` (both backends name a frozen frame
// with the same string — the WebGPU one has no frame CACHE but does feed the image swap, and the two
// must agree on what "the same frame" means). They are imported back here because this file owns the
// cache the key addresses and the precomputed key halves below.

// The attr-derived halves of `staticFrameKey`, PRECOMPUTED whenever the attribute they come from
// is (re-)parsed instead of re-serialized on every render. Two `JSON.stringify` passes over the
// param maps per node per frame was pure waste: the parsed values only ever change when their
// data-attr string does, which `updateBinding` already detects with a cheap string compare.
function paramsFrameKey(params: Record<string, ShaderParamValue>): string {
  return JSON.stringify(params, (_k, v) =>
    typeof v === "number" ? quantizeForKey(v) : v,
  );
}

function paramKindsFrameKey(paramKinds: Record<string, string>): string {
  return JSON.stringify(paramKinds);
}

function modulateFrameKey(modulate: readonly number[]): string {
  return modulate.map(quantizeForKey).join(",");
}

// EXACT, not quantized (unlike params/modulate): the window decides WHICH pixels of the node the
// frame contains, so two windows that differ at all must never share a cached frame — a canvas can
// keep the same w/h across a real window change (a box growth compensating a du shrink, or a pure
// u0/v0 pan), and pre-quantization those served a stale-clip blit.
function windowFrameKey(window: readonly number[]): string {
  return window.join(",");
}

// Snapshot a just-rendered node canvas into the LRU cache (a fresh 2D canvas so it isn't overwritten by the
// node's next render). Evicts the oldest entries past the cap.
function storeStaticFrame(
  key: string,
  source: HTMLCanvasElement,
  w: number,
  h: number,
): void {
  if (typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(source, 0, 0);
  staticFrameCache.set(key, canvas);
  while (staticFrameCache.size > STATIC_FRAME_CACHE_LIMIT) {
    const oldest = staticFrameCache.keys().next().value;
    if (oldest === undefined) break;
    staticFrameCache.delete(oldest);
    // The image swap keys its object URLs by the SAME key, so an eviction here retires that entry
    // too (see `../surface-image-swap`) — a leaked blob URL outlives the document otherwise.
    onStaticFrameEvicted(oldest);
  }
}

// A cached frozen frame for `key`, LRU-bumped so the eviction above always drops the coldest entry.
// The backend's render path asks through here (see `WebglShaderBackendDeps`) instead of reaching
// into the Map: the bump is cache bookkeeping, not rendering, and the cache keeps its one home.
function lookupStaticFrame(key: string): HTMLCanvasElement | undefined {
  const hit = staticFrameCache.get(key);
  if (!hit) return undefined;
  staticFrameCache.delete(key);
  staticFrameCache.set(key, hit); // LRU bump
  return hit;
}

/** TEST-ONLY: clear the static-frame cache so a test starts from an empty cache. */
export function __resetStaticShaderFrameCacheForTest(): void {
  staticFrameCache.clear();
}

// IN-FLIGHT shader-source resolves, keyed by shader id (the `BAKED_CACHE` shape in `../tint-bake`).
// WHY: `programCache` only dedupes AFTER a source has been fetched, expanded and transpiled, so a
// cold cache with N nodes sharing one shader (a hand of cards) fired N identical fetches and N
// identical `expandGodotShaderIncludes` passes concurrently — the create-burst cost we're paying on
// phones. They now share ONE promise.
//
// The entry is dropped once it settles, so this is purely an in-flight window (a later create hits
// `programCache` instead) — which also means a FAILED fetch is never cached as a verdict and the
// next binding retries.
const shaderSourceRequests = new Map<string, Promise<string | undefined>>();

function resolveExpandedShaderSource(
  shaderKey: string,
  path: string | undefined,
  uid: string | undefined,
  resolveShaderSource: NonNullable<
    GodotHtmlRuntimeOptions["resolveShaderSource"]
  >,
): Promise<string | undefined> {
  const inFlight = shaderSourceRequests.get(shaderKey);
  if (inFlight) return inFlight;
  const request = (async () => {
    const source = await resolveShaderSource(path, uid);
    if (source === undefined) return undefined;
    return await expandGodotShaderIncludes(source, (includePath) =>
      resolveShaderSource(includePath, undefined),
    );
  })();
  // Settle-cleanup on a DERIVED promise, so a rejection is handled here (no unhandled-rejection
  // warning) while still propagating to every awaiting caller through `request` itself.
  const forget = (): void => {
    if (shaderSourceRequests.get(shaderKey) === request) {
      shaderSourceRequests.delete(shaderKey);
    }
  };
  request.then(forget, forget);
  shaderSourceRequests.set(shaderKey, request);
  return request;
}

/** TEST-ONLY: drop any in-flight shader-source requests so a test starts from a cold cache. */
export function __resetShaderSourceRequestsForTest(): void {
  shaderSourceRequests.clear();
}

// Transpile + compile a shader once, caching by id. Returns null when the shader is unsupported or
// fails to compile (caller leaves the node on CSS/SVG). ASYNC because the compile is: the driver is
// given time to finish before anything asks it a blocking question (see `compileProgramAsync`), so a
// cold shader now settles a few milliseconds later WITHOUT the main thread standing still for it.
// A cached program still resolves on the first microtask, and the synchronous `programCache` peek
// callers use to decide whether they need a source at all is untouched.
function getProgramAsync(
  gl: WebGL2RenderingContext,
  shaderKey: string,
  source: string,
  onUnsupported?: UnsupportedRenderReporter,
  screenCapture = false,
): Promise<CompiledProgram | null> {
  const cacheKey = programCacheKey(shaderKey, screenCapture);
  const cached = programCache.get(cacheKey);
  if (cached === "unsupported") return Promise.resolve(null);
  if (cached) return Promise.resolve(cached);
  const inFlight = programRequests.get(cacheKey);
  if (inFlight) return inFlight;
  const request = buildProgram(
    gl,
    cacheKey,
    shaderKey,
    source,
    onUnsupported,
    screenCapture,
  );
  // Settle-cleanup on a DERIVED promise, so a rejection is handled here while still propagating to
  // every awaiting caller through `request` itself (`resolveExpandedShaderSource`'s pattern).
  const forget = (): void => {
    if (programRequests.get(cacheKey) === request) {
      programRequests.delete(cacheKey);
    }
  };
  request.then(forget, forget);
  programRequests.set(cacheKey, request);
  return request;
}

async function buildProgram(
  gl: WebGL2RenderingContext,
  cacheKey: string,
  shaderKey: string,
  source: string,
  onUnsupported: UnsupportedRenderReporter | undefined,
  screenCapture: boolean,
): Promise<CompiledProgram | null> {
  let program: WebGLProgram | null = null;
  let transpiled: TranspiledShader;
  try {
    transpiled = transpileGodotShader(source);
  } catch (error) {
    // Fail loud (deduped): the node keeps its CSS/SVG paint, but which shader gsw couldn't run — an
    // unsupported GLSL construct vs an unexpected transpile bug — is now surfaced, not silently dropped.
    reportUnsupportedRender(
      {
        kind: "shader",
        id: shaderKey,
        reason:
          error instanceof UnsupportedShaderError
            ? "unsupported shader construct"
            : "shader transpile error",
        error,
      },
      onUnsupported,
    );
    programCache.set(cacheKey, "unsupported");
    return null;
  }
  // Screen reads transpile, but the capture machinery is OPT-IN (`enableScreenTextureCapture`).
  // Without it, take the exact unsupported/CSS-fallback path such shaders took before support
  // existed, so every option-off consumer is unaffected.
  if (
    (transpiled.usesScreenTexture || transpiled.usesScreenPixelSize) &&
    !screenCapture
  ) {
    reportUnsupportedRender(
      {
        kind: "shader",
        id: shaderKey,
        reason: "screen-texture capture not enabled",
      },
      onUnsupported,
    );
    programCache.set(cacheKey, "unsupported");
    return null;
  }
  // The await is the point: the compile+link are kicked here and the main thread is released while
  // the driver works. Everything below — the status query inside `compileProgramAsync`, and the
  // `getUniformLocation` walk, which blocks on an incomplete link just as hard — happens only once
  // the driver reports it can answer without stalling.
  program = await compileProgramAsync(
    gl,
    transpiled.vertexGlsl,
    transpiled.fragmentGlsl,
    (p) => gl.bindAttribLocation(p, 0, "a_pos"),
  );
  if (!program) {
    reportUnsupportedRender(
      { kind: "shader", id: shaderKey, reason: "shader failed to compile" },
      onUnsupported,
    );
    programCache.set(cacheKey, "unsupported");
    return null;
  }
  const uniformLocations = new Map<string, WebGLUniformLocation | null>();
  const names = [
    "TIME",
    "TEXTURE",
    "TEXTURE_PIXEL_SIZE",
    "SCREEN_TEXTURE",
    "SCREEN_PIXEL_SIZE",
    "MODULATE",
    "_godot_uv_fit",
    "_godot_uv_window",
    "_godot_screen_origin",
    "_godot_screen_size",
    ...transpiled.uniforms.map((u) =>
      u.arrayLength ? `${u.name}[0]` : u.name,
    ),
    ...transpiled.samplers.map((s) => s.name),
  ];
  for (const name of names) {
    const key = name.endsWith("[0]") ? name.slice(0, -3) : name;
    uniformLocations.set(key, gl.getUniformLocation(program, name));
  }
  const compiled: CompiledProgram = {
    program,
    uniformLocations,
    uniforms: transpiled.uniforms,
    samplers: transpiled.samplers,
    usesTime: transpiled.usesTime,
    usesTexturePixelSize: transpiled.usesTexturePixelSize,
    usesScreenUv: transpiled.usesScreenUv,
    usesScreenTexture: transpiled.usesScreenTexture,
    usesScreenPixelSize: transpiled.usesScreenPixelSize,
    blend: transpiled.blend,
  };
  programCache.set(cacheKey, compiled);
  return compiled;
}

/** The subset of DOMRect the screen-space paths read. Lets a CACHED rect (a plain snapshot) stand
 *  in for a live `getBoundingClientRect()` everywhere. */
export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A resolved sampler uniform: its baked texture + the slot it binds to. */
export interface SamplerBinding {
  name: string;
  entry: ShaderTextureHandle;
  /** WHERE the backend binds it, in that backend's own numbering: a GL texture UNIT (1..N, unit 0
   *  being the node TEXTURE) on WebGL, and the user-sampler INDEX (0..N-1, which the WGSL binding
   *  table maps to `@binding(3 + 2i)`) on WebGPU. Only the backend that produced this reads it. */
  unit: number;
  /** The source this sampler actually binds.  This is deliberately independent of the backend's
   * texture-cache key: it names the shader input for the renderer-agnostic frozen-frame key. */
  frameIdentity: StaticSamplerIdentity;
}

// Minimum seconds between screen-capture refreshes for one binding. The capture is a
// throttled snapshot — a TIME shader animates every frame over a ~3Hz-refreshed
// background — NEVER a per-rAF DOM walk.
const SCREEN_CAPTURE_MIN_INTERVAL_S = 0.3;
// Default longest-edge cap for the capture canvas (see `maxScreenCaptureDim`).
const DEFAULT_MAX_SCREEN_CAPTURE_DIM = 1024;

/** Per-binding SCREEN_TEXTURE capture: the offscreen 2D composite + its own GL texture.
 *  Binding-OWNED (created/deleted with the binding) — NOT a url-keyed textureCache entry,
 *  since the content is volatile and unique to the node's position in draw order. */
export interface ScreenCaptureState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: WebGLTexture;
  /** `nowSeconds()` of the last composite+upload (throttle timestamp). */
  capturedAt: number;
  width: number;
  height: number;
}

export interface NodeBinding {
  /** The keyed shader node element (the reconcile Map key); its DOM identity is stable
   *  across re-renders for an unchanged node (Stage B), so its binding is reused. */
  node: HTMLElement;
  /** `uid ?? path` — a change means the shader itself swapped → recreate, not update. */
  shaderKey: string;
  selfLayer: HTMLElement;
  /** Scene root, for the SCREEN_UV viewport rect (node-rect ÷ root-rect). */
  root: HTMLElement;
  /** The renderer this binding draws through (see `./shader-backend`). PER-BINDING, not
   *  per-runtime: a shader that cannot run on the runtime's preferred backend must fall back on its
   *  own rather than veto its neighbours. Today every binding gets the WebGL backend. */
  backend: ShaderRenderBackend;
  canvas: HTMLCanvasElement;
  /** The blit target — null on a backend that renders STRAIGHT into the node canvas (WebGPU), which
   *  is also what every 2D-only feature keys off. Always present on a WebGL binding. */
  ctx2d: CanvasRenderingContext2D | null;
  /** ASYNC ENCODE SOURCE for the frozen-surface image swap, set ONLY on a binding whose canvas
   *  cannot be read back (a WebGPU one). Produces a fresh 2D canvas of this binding's current frame
   *  through the backend's capture hook; the swap module owns and releases it. Absent on a WebGL
   *  binding, whose canvas the swap reads directly. See `../surface-image-swap`'s
   *  `StaticImageSwapBinding.captureCanvas`. */
  captureCanvas?: () => Promise<StaticSurfaceCapture>;
  /** The GL-compiled shader. Present on EVERY binding, WebGPU ones included: it is the source of the
   *  renderer-agnostic facts the runtime reads (`usesTime`, `usesScreenUv`, `blend`, the uniform and
   *  sampler NAME lists), and it is what a device loss falls back onto without a second compile. The
   *  WGSL twin of a WebGPU binding lives in `../webgpu/render-shader`, keyed by the same shader id. */
  program: CompiledProgram;
  texture: ShaderTextureHandle;
  /** Canonical node TEXTURE inputs, kept alongside the resolved handle so the shared frozen-frame
   * key does not have to read DOM attributes (and remains pure). */
  textureRepeat: boolean;
  textureRegion: { x: number; y: number; width: number; height: number } | null;
  /** Procedural sampler-uniform textures (see `SamplerBinding.unit` for the numbering). */
  samplers: SamplerBinding[];
  /** background-size mode for UV fit: "contain" | "cover" | "fill". */
  fit: "contain" | "cover" | "fill";
  /** UV/canvas window [u0,v0,du,dv] in node-local top-left fractions: the runtime renders only this SUB-RECT of
   *  the node into a smaller, repositioned canvas (clamping an off-screen-overflowing background to the visible
   *  region), and the shader samples the matching portion via `_godot_uv_window`. [0,0,1,1] = full node. */
  window: [number, number, number, number];
  windowAttr: string | null;
  /** Per-binding backing-density MULTIPLIER (see `SURFACE_PIXEL_RATIO_ATTR`): how much bigger this
   *  surface is on screen than its own CSS box, as the host states it. Multiplied into whichever
   *  density term applies (the live `devicePixelRatio × renderScale`, or the frozen pin) by
   *  `syncCanvasSize`. Always a finite positive number — `parseSurfacePixelRatio` resolves every
   *  malformed/absent attribute to exactly `1`, which is the un-stamped, byte-identical case. */
  pixelRatioScale: number;
  /** …and the raw attribute string it came from, so a sweep tells "unchanged" from "moved" with one
   *  string compare and no parse (the `windowAttr` idiom, for the same reason). */
  pixelRatioAttr: string | null;
  /** Last-measured self-layer content-box size in CSS px. Seeded by the one create-time layout read and kept
   *  current by the ResizeObserver's contentRect — so a later resize driven by a WINDOW change (or a renderScale
   *  step), where the box itself is unchanged, reuses this instead of forcing another clientWidth/Height reflow.
   *  Meaningless until `boxMeasured`. */
  boxW: number;
  boxH: number;
  /** Has this binding's box EVER been resolved (by a layout read or a delivered `contentRect`)? The reuse gate,
   *  and it is a flag rather than `boxW > 0` because a self-layer can legitimately measure 0x0 — a hidden
   *  ancestor, a Node2D with no rect — and a size test would then never latch, sending EVERY later
   *  `syncCanvasSize` back through the forced `clientWidth`/`clientHeight` layout for as long as the node
   *  lives. (`../particles/runtime`'s `boxMeasured` is the same flag, for the same reason.) A latched 0x0 is
   *  refreshed for free the moment it stops being 0x0: only a resize can do that, and a resize is what the
   *  shared ResizeObserver reports. */
  boxMeasured: boolean;
  params: Record<string, ShaderParamValue>;
  paramKinds: Record<string, string>;
  modulate: [number, number, number, number];
  /** Precomputed `staticFrameKey` parts, rebuilt only when the attribute they derive from is
   *  re-parsed (see the `…FrameKey` helpers) instead of re-serialized per render. */
  paramsKey: string;
  paramKindsKey: string;
  modulateKey: string;
  windowKey: string;
  textureLoadDisposers: Array<() => void>;
  /** Binding-local cache for the otherwise pure staticFrameKey calculation. Every effective
   * writer of a keyed input advances this epoch through invalidateStaticFrameKey. */
  staticKeyEpoch: number;
  staticKeyMemo: {
    epoch: number;
    w: number;
    h: number;
    /** quantizeForKey(TIME), matching staticFrameKey rather than the caller's raw clock value. */
    time: number;
    key: string;
  } | null;
  loadingFallback: boolean;
  loadingFallbackCleared: boolean;
  /** Whether a static (non-TIME) node still needs its one-shot render. */
  dirty: boolean;
  /** Occlusion suspend (see `../effects-suspend`): the node sits under a
   *  `data-godot-effects-suspended` ancestor → the loop skips it entirely and it does NOT keep the
   *  rAF loop alive. Recomputed on every `reconcile()`, never polled per frame. */
  suspended: boolean;
  /** Dormant (see `../shader-dormant`): the node carries `data-godot-shader-dormant` → the binding
   *  is KEPT but parked — canvas hidden, skipped by the loop AND the batched rect read, and
   *  `syncCanvasSize` deferred to the wake. Recomputed on every `reconcile()`. */
  dormant: boolean;
  /** A `syncCanvasSize` that was skipped while dormant; run once on wake. */
  canvasSyncDeferred: boolean;
  /** Ordinal of the moment this binding went dormant, from the runtime's monotonic counter (0 while
   *  awake). The dormant-expiry sweep compares ordinals rather than a wall clock, so it needs no
   *  per-binding timer and no clock reading. */
  dormantSeq: number;
  /** Cached self-layer viewport rect for the SCREEN_UV / SCREEN_TEXTURE paths, refreshed by the
   *  runtime's batched rect read (see the rect cache below). null until first measured. Reading it
   *  per frame was a forced layout PER SCREEN_UV NODE PER FRAME. */
  layerRect: ViewportRect | null;
  // Raw data-attr signatures captured at create/update, so `reconcile` can detect a real
  // change with cheap attribute reads (NO layout) and skip work for unchanged nodes.
  paramsAttr: string | null;
  paramKindsAttr: string | null;
  modulateAttr: string | null;
  samplersAttr: string | null;
  samplerUrlsAttr: string | null;
  /** Resolved texture url (self-layer attr or backgroundImage). */
  textureUrl: string | null;
  /** Memo of the last `selfLayer.style.backgroundImage` string and the url parsed out of it, so an
   *  unchanged paint skips the regex on every reconcile. `null` = nothing memoized yet (the style
   *  property is always a string, so it can never collide with a real value). */
  backgroundImageStyle: string | null;
  backgroundImageParsed: string | null;
  /** Raw `data-godot-atlas-region` string (atlas sub-rect crop) so a change re-uploads. */
  textureRegionAttr: string | null;
  textureRepeatAttr: string | null;
  /** SCREEN_TEXTURE capture state; created lazily on the first render of a
   *  `usesScreenTexture` program, null for every other shader. */
  screenCapture: ScreenCaptureState | null;
  /** Frozen-surface image-swap state (see `../surface-image-swap`), or null when the runtime's
   *  `staticShaderImages` option is off — in which case every swap call site is a no-op and the
   *  binding takes exactly the path it took before the swap existed. */
  staticImage: StaticImageState | null;
  /** The static-frame key of the frame this canvas HOLDS, or null when the frame is not a frozen,
   *  content-addressed one (live mode, a screen-space shader, textures still loading). Written by
   *  the backend on every paint and reported to the consumer through `GodotEffectRenderInfo.staticKey`
   *  — see there for why a host that composites these canvases wants it. It is the same string the
   *  static-frame cache and the image swap name that bitmap by; nothing here derives a second one. */
  lastStaticKey: string | null;
}

/** Invalidate the binding-local memo around staticFrameKey.  Keep this separate from
 * `lastStaticKey`: that field describes the pixels the canvas currently holds, while this only
 * says that the inputs to a future key calculation changed. */
export function invalidateStaticFrameKey(binding: NodeBinding): void {
  binding.staticKeyEpoch += 1;
  binding.staticKeyMemo = null;
}

/** OPT-IN per-frame cost attribution for ONE shader runtime (`effectsProfiling`, see `../types`),
 *  read from `stats().profile`; NULL when the option is off. The particle runtime's `ParticleProfile`
 *  with the two CPU buckets removed — a shader frame has no simulation and no instance buffer, so
 *  everything a shader tick does on the main thread is submit + blit. */
export interface ShaderProfile {
  /** Loop ticks that rendered at least one binding. A tick deferred by the FPS cap (`capDeferrals`)
   *  or one where every binding was clean/parked/suspended books none. */
  ticks: number;
  /** Bindings the tick handed to `renderNode`, summed across those ticks — static-frame cache hits
   *  included, whether they blit or simply confirm their canvas already presents the keyed frame.
   *  Clean, parked and suspended bindings are skipped by the loop before this and never counted. */
  bindings: number;
  /** GL SUBMIT: `renderNode`'s viewport/clear/program preamble, its texture binds and uniform
   *  writes, and the `drawArrays`. SUBMIT ONLY — the GPU runs asynchronously, so this never contains
   *  GPU execution time. Deliberately EXCLUDES the throttled SCREEN_TEXTURE capture (a 2D composite
   *  of the DOM plus an upload, on its own ~300 ms cadence), which would otherwise spike this bucket
   *  on the frames that happen to refresh it. */
  glMs: number;
  /** GL→2D BLIT: the node canvas's `clearRect` + the `drawImage` copying the shared GL canvas onto
   *  it — and a cross-canvas static-frame cache-hit blit, which is the cost that cache trades the GL draw for.
   *  Fill cost, so it scales with backing-store area (`renderScale` × devicePixelRatio), not with
   *  shader complexity. */
  blitMs: number;
}

/** A zeroed `ShaderProfile`. Allocated ONCE per runtime and only when `effectsProfiling` is on; the
 *  render path mutates it in place, so measuring adds no per-frame allocation. */
function createShaderProfile(): ShaderProfile {
  return { ticks: 0, bindings: 0, glMs: 0, blitMs: 0 };
}

/** Live, monotonically-increasing counters for ONE shader runtime (see `WebglShaderRuntime.stats`).
 *  Plain fields bumped with `++` on the hot paths — no allocation, no behavior change; a probe
 *  snapshots the object and diffs across a gesture window. Never reset for the runtime's lifetime. */
export interface WebglShaderRuntimeStats extends StaticImageSwapCounters {
  /** Actual GL draws of a shader frame (`renderNode` reaching `gl.drawArrays`). */
  draws: number;
  /** Frozen-mode static-frame cache hits: the GL draw was skipped and a cached frame was handled. */
  cacheHits: number;
  /** Cache hits whose target canvas already held the named frame, so the 2D clear/blit was skipped.
   *  `onBindingRendered` still fires: the binding presented/handled its current frame even though no
   *  pixels changed. */
  blitSkips: number;
  /** SEAM — 0 today: static re-renders skipped because the quantized frame key was unchanged.
   *  Future consumer: the `staticDirtyByFrameKey` dirty gating (Fix B) in `updateBinding`. */
  dirtySkips: number;
  /** Ticks pushed past the fps-cap boundary (the `!pacer.isDue` re-arm in `tick`). Today only capped
   *  ANIMATED loops take this path — frozen mode bypasses the cap entirely (`capRemaining` returns 0),
   *  so this stays 0 in static mode until `capStaticRerenders` (Fix A) routes static dirty re-renders
   *  through the cap too. */
  capDeferrals: number;
  /** Node-canvas backing-store reallocations: `syncCanvasSize` calls that actually re-assigned
   *  `canvas.width`/`height` (one event per call, however many dimensions moved). */
  canvasReallocs: number;
  /** Synchronous out-of-loop renders (`renderBindingNow`): the uv-window/realloc anti-flicker path
   *  that draws immediately instead of waiting for the next tick. */
  syncRenders: number;
  /** `syncCanvasSize` calls that sized a binding at the PINNED static ratio
   *  (`staticShaderPixelRatio`) instead of `devicePixelRatio × renderScale`. A device probe reads
   *  this to confirm the pin is actually in force — it stays 0 when the option is unset OR the
   *  runtime never entered frozen mode, which `canvasReallocs` alone cannot distinguish (that
   *  counter is about the OPPOSITE thing: how much re-sizing churn is still happening). */
  pinnedCanvasSyncs: number;
  /** Per-frame cost attribution (see `ShaderProfile`), or NULL when `effectsProfiling` is off — the
   *  default, and the no-op handle always. NULL rather than a zeroed object ON PURPOSE: "not
   *  measured" must never read as "measured, cost nothing". The same object every `stats()` call. */
  profile: ShaderProfile | null;
  /** GAUGE — which renderer NEW bindings of this runtime are created on RIGHT NOW, re-derived on
   *  each `stats()` read (a runtime can change backend mid-life, in one direction: a WebGPU device
   *  that is lost is rebuilt on WebGL).
   *
   *  `"pending"` is a real state: with `effectsRenderer: "auto"`/`"webgpu"` on a browser that HAS
   *  `navigator.gpu`, the device arrives from a promise, and until it does no binding is created at
   *  all — every opted-in node simply keeps its CSS/SVG paint, exactly as it does while its shader
   *  source is still being fetched. `"none"` is the no-op handle (no WebGL2, or no shader resolver).
   *
   *  It is the RUNTIME's answer, not a binding's: individual bindings can be on WebGL under a
   *  `"webgpu"` runtime (see `webgpuBindingFallbacks`). */
  renderer: "pending" | "webgpu" | "webgl" | "none";
  /** COUNTER. Times this runtime adopted WebGL after being asked for `"auto"`/`"webgpu"` — the
   *  SYNCHRONOUS "this browser has no navigator.gpu" decline included, which is the common case and
   *  the reason a plain WebGL page reports 1 here rather than 0. Stays 0 for `effectsRenderer:
   *  "webgl"` (nothing was ever asked for) and for a runtime that adopted WebGPU and kept it. */
  webgpuFallbacks: number;
  /** COUNTER — bindings that took the WebGL backend under a runtime whose renderer is WebGPU,
   *  because THEIR shader cannot run there: it samples SCREEN_TEXTURE, its WGSL transpile refused a
   *  construct, or its module/pipeline failed to build. This is the counter that says the
   *  per-binding fallback is doing its job — one screen-reading shader must not veto N WebGPU
   *  canvases, and without this the only symptom would be a node that is quietly slower. */
  webgpuBindingFallbacks: number;
  /** The FIRST reason this runtime declined WebGPU (later ones cannot un-explain it), or null while
   *  it never has. THE diagnostic for a silent fallback: `renderer: "webgl"` under
   *  `effectsRenderer: "webgpu"` says something went wrong, and only this says what. */
  webgpuFallbackReason: WebgpuFallbackReason | null;
  /** COUNTER — `queue.submit` calls this runtime's WebGPU backend has made, sampled on read. ONE per
   *  tick that drew anything, whatever the binding count: that batching is the measured win (S7), so
   *  a probe that finds it climbing with N nodes has found the win being given back. 0 on WebGL,
   *  where the question is meaningless. */
  webgpuSubmits: number;
  /** GAUGE — `device.lost` resolutions seen by the page-wide device (see `../webgpu/device`). A lost
   *  device stops producing frames, so a non-zero value here next to `renderer: "webgl"` is the
   *  device-loss rebuild having happened. */
  webgpuDeviceLosses: number;
  /** GAUGE — `uncapturederror` events on the page-wide device. Non-zero means a frame was silently
   *  WRONG: WebGPU reports most command-level mistakes this way and nothing else says so. */
  webgpuErrors: number;
}

function createWebglShaderRuntimeStats(): WebglShaderRuntimeStats {
  return {
    draws: 0,
    cacheHits: 0,
    blitSkips: 0,
    dirtySkips: 0,
    capDeferrals: 0,
    canvasReallocs: 0,
    syncRenders: 0,
    pinnedCanvasSyncs: 0,
    // OFF unless the runtime turns it on at create: the never-measured state, and the only one a
    // no-op handle can ever report.
    profile: null,
    // "none" is the no-op handle's permanent answer; a real runtime overwrites this on its first
    // `stats()` read (and the gate has usually settled it before anyone can look).
    renderer: "none",
    webgpuFallbacks: 0,
    webgpuBindingFallbacks: 0,
    webgpuFallbackReason: null,
    webgpuSubmits: 0,
    webgpuDeviceLosses: 0,
    webgpuErrors: 0,
    // See `../surface-image-swap` (`StaticImageSwapCounters`) for what these mean. A device probe
    // reads swaps/reverts/encodes to confirm the mechanism WITHOUT console logs, `staticImagesLive`
    // to confirm how much of the set is engaged, and `staticImageUrlsLive` to confirm it doesn't leak.
    ...createStaticImageSwapCounters(),
  };
}

// Is there a WebGPU API on this page AT ALL? The gate's synchronous short-circuit (see `openGate`):
// no `navigator.gpu` means no promise is created, no microtask is scheduled and no create is ever
// deferred — which is what keeps jsdom and every non-WebGPU browser on the byte-identical path under
// the default `effectsRenderer: "auto"`. Deliberately NOT `acquireWebgpuDevice`, which would answer
// the same question one turn of the event loop later.
function hasWebgpuApi(): boolean {
  return Boolean(
    (globalThis.navigator as (Navigator & { gpu?: unknown }) | undefined)?.gpu,
  );
}

/**
 * One shader to compile AHEAD of the node that will need it. See {@link WebglShaderRuntime.warmPrograms}.
 *
 * The same three values the create path derives from a node's `data-godot-shader-*` attributes, so a caller that
 * knows its scene's shader set can name them without a node existing yet.
 */
export interface WebglWarmSpec {
  /** The shader id — the `programCache` key, and what `resolveShaderSource` is ultimately asked about. */
  shaderKey: string;
  /** Resource path passed to `resolveShaderSource`. Omit when the consumer resolves by uid alone. */
  path?: string;
  /** Resource uid passed to `resolveShaderSource`. */
  uid?: string;
}

/** A persistent WebGL shader runtime for a mounted scene root (see createWebglShaderRuntime). */
export interface WebglShaderRuntime {
  /** Diff the live `[data-godot-shader-webgl]` set against the bindings: keep+update
   *  unchanged nodes (no forced layout), create new ones, dispose gone ones. */
  reconcile(): void;
  /** Live retune the backing-store resolution (devicePixelRatio × clamped `scale`) without a
   *  dispose+recreate — for an adaptive-quality consumer that lowers fill cost under load. While a
   *  pin is in force (see `setStaticShaderPixelRatio`) AND the runtime is in frozen mode this
   *  re-sizes nothing: the frozen backing stores (and their cached frames) are deliberately held
   *  still. The new scale still takes effect for live bindings the moment frozen mode is left. */
  setRenderScale(scale: number): void;
  /** Live set/clear the pinned FROZEN backing-store ratio (see `staticShaderPixelRatio`). Pass
   *  `undefined` (or a non-positive value) to un-pin, restoring `devicePixelRatio × renderScale`
   *  sizing for frozen bindings too. Only frozen bindings are affected — a live binding is never
   *  sized by the pin. */
  setStaticShaderPixelRatio(ratio: number | undefined): void;
  /** Live retune the animated re-render FPS cap (0 = uncapped). */
  setFps(fps: number): void;
  /** Live toggle frozen-TIME (single-shot) mode: render each shader ONCE at a pinned TIME and stop the loop
   *  (true), or resume per-frame animation (false). The low-end fallback that renders a correct still frame
   *  instead of a per-frame loop — see the `staticShaders` option. */
  setStaticShaders(value: boolean): void;
  /** Live toggle of the frozen-surface image swap (see the `staticShaderImages` option and
   *  `../surface-image-swap`). Turning it OFF reverts every live swap immediately and revokes its
   *  object URLs — the kill switch, safe to throw at any time. Turning it back ON re-arms the
   *  runtime's CONFIGURED policy (a boolean here never replaces it) and every binding re-earns. */
  setStaticShaderImages(value: boolean): void;
  /** HOST-DRIVEN revert of the surface image swap, WITHOUT blocking: with no argument every swapped
   *  surface is handed back to its canvas; with a node list, only the bindings at (or under) those
   *  elements. Each affected surface restarts its gate and re-earns the swap on its own. This is how
   *  a host that knows something the runtime cannot see — it is about to re-parent a subtree, it
   *  just re-themed, its own occlusion pass changed its mind — un-shadows a stale stand-in
   *  immediately instead of waiting for a watchdog window. */
  invalidateStaticSurfaces(nodes?: Iterable<HTMLElement>): void;
  /** The runtime's live counters (see `WebglShaderRuntimeStats`). Returns the SAME live object every
   *  call — read-only by convention; snapshot (spread) it to diff. All-zero on the no-op handle.
   *  `.profile` carries the opt-in per-frame cost attribution (`effectsProfiling`) and is NULL
   *  whenever it was not measured, the no-op handle included. */
  stats(): WebglShaderRuntimeStats;
  /**
   * TEST / DIAGNOSTIC HOOK: the binding at (or under) `node` re-rendered into an offscreen texture
   * and read back as tightly-packed RGBA (PREMULTIPLIED, top-down, at the canvas's BACKING-STORE
   * size), or null when there is nothing to read — no binding there, a zero-sized canvas, or a
   * binding rendering on WebGL.
   *
   * WEBGL RETURNS NULL ON PURPOSE, and it is not a gap: that canvas holds readable 2D pixels, so a
   * caller who wants them uses `getImageData` on it. This exists because a WebGPU canvas has no such
   * path — `drawImage`/`toDataURL` from one are blank under headless Chrome and pathological on
   * Android (docs/perf-harness.md S7) — so the frame has to be produced a SECOND time, into a
   * texture that `copyTextureToBuffer` can reach (`../webgpu/readback`). It renders the binding's
   * CURRENT state at the runtime's current TIME, which for a frozen binding is exactly the frame on
   * screen.
   *
   * This is the WebGL↔WebGPU image-parity harness's capture path.
   */
  captureNodePixels?(node: HTMLElement): Promise<Uint8Array | null>;
  /**
   * Resolve, transpile and LINK these shaders now, so the node that eventually wants one finds it cached.
   * Resolves to how many of `specs` ended with a usable program (cached ones included).
   *
   * WHY THIS EXISTS. `compileProgramAsync` yields to the driver before asking a blocking question, which on a
   * device with `KHR_parallel_shader_compile` makes a cold link nearly free. WITHOUT that extension — and it is
   * absent on real Android hardware; a Moto G86 answers null for it — `ready()` reports true immediately and
   * `finish()` then blocks on `LINK_STATUS` for as long as the driver needs. One measured link cost 90.3 ms of
   * main thread, and it landed mid-combat because that was the first frame a node asked for that shader.
   *
   * THIS CANNOT MAKE THE LINK FREE, and does not pretend to: the driver's work is the driver's work. It only
   * lets a consumer choose WHEN to pay — behind a loading screen, where 90 ms is invisible, instead of on the
   * frame a card is played. That is the whole claim, and it is the one to verify.
   *
   * PURELY ADDITIVE. Nothing about the lazy create path changes; this only populates the cache it already
   * consults. A spec whose source will not resolve, or will not compile, is counted as a miss and leaves that
   * shader exactly where it was — the node that needs it later keeps its CSS/SVG paint, as it does today. Safe
   * to call more than once and safe to ignore the result.
   */
  warmPrograms(specs: Iterable<WebglWarmSpec>): Promise<number>;
  /** Tear everything down (cancel the rAF loop, disconnect observers, remove canvases). */
  dispose(): void;
}

/**
 * Create a PERSISTENT WebGL runtime for a mounted scene root. Unlike a teardown+reattach
 * per render, the caller keeps this handle and calls `reconcile()` on each re-render:
 * unchanged shader nodes KEEP their binding (a cheap attribute-only update — no
 * `syncCanvasSize`/`clientWidth` forced layout), new nodes are created, gone nodes
 * disposed. One shared rAF loop renders the live binding set. A no-op handle when WebGL2
 * is unavailable or no shader resolver is configured.
 */
export function createWebglShaderRuntime(
  root: HTMLElement,
  options: GodotHtmlRuntimeOptions,
): WebglShaderRuntime {
  const sharedGl = getShared();
  if (!sharedGl || typeof options.resolveShaderSource !== "function") {
    // The no-op handle still carries (all-zero, never-incremented) stats so probes need no null case.
    const noopStats = createWebglShaderRuntimeStats();
    return {
      reconcile() {},
      setRenderScale() {},
      setStaticShaderPixelRatio() {},
      setFps() {},
      setStaticShaders() {},
      setStaticShaderImages() {},
      invalidateStaticSurfaces() {},
      stats: () => noopStats,
      // No WebGL2 and/or no resolver: there is nothing to warm, and a caller must not have to care.
      warmPrograms: () => Promise.resolve(0),
      dispose() {},
    };
  }
  const resolveShaderSource = options.resolveShaderSource;
  // Optional per-binding render notification (see `GodotHtmlRuntimeOptions.onBindingRendered`): fired
  // right after a renderNode HANDLED this binding's current frame — a real GL draw, a cache-hit
  // blit, or a same-canvas cache hit that simply confirms it remains presented. Absent ⇒
  // byte-identical behavior.
  const onBindingRendered = options.onBindingRendered;
  // The third argument (see `GodotEffectRenderInfo`), read off the binding's compiled program — which
  // is fixed for the binding's life (a shader swap recreates the binding, see `NodeBinding.shaderKey`),
  // so this is a pure restatement of facts the runtime already holds. A fresh object per firing, and
  // it can afford to be: the callback fires only behind a handled/presented frame, normally a full-canvas
  // blit and usually a GL submit too, next to which one small literal is nothing — and a shared mutable one would hand a
  // consumer that keeps the reference somebody else's blend mode.
  const renderInfoOf = (binding: NodeBinding): GodotEffectRenderInfo => ({
    usesScreenTexture: binding.program.usesScreenTexture,
    usesScreenUv: binding.program.usesScreenUv,
    blend: binding.program.blend,
    // The frame this canvas holds, as the backend just named it (null for anything that is not a
    // frozen, content-addressed frame) — see `GodotEffectRenderInfo.staticKey`.
    staticKey: binding.lastStaticKey,
  });
  const { gl } = sharedGl;
  // Backing-store pixel ratio for every LIVE node canvas (devicePixelRatio × clamped renderScale). <1
  // is the low-end resolution knob. MUTABLE so an adaptive consumer can retune it live via
  // setRenderScale (the canvases re-size on the next tick) without a dispose+recreate. `sizeCanvas`
  // is what every sizing path (incl. the ResizeObserver) reads, so a resize after a live change uses
  // the CURRENT ratio.
  let pixelRatio = effectivePixelRatio(options.renderScale);
  // OPT-IN pinned backing ratio for FROZEN bindings (see `staticShaderPixelRatio`). `undefined` =
  // not pinned, which is every consumer that doesn't set it: the sizing path below then resolves to
  // `pixelRatio` in both modes, exactly as it always did. MUTABLE via setStaticShaderPixelRatio.
  let staticPixelRatio = normalizeStaticPixelRatio(
    options.staticShaderPixelRatio,
  );
  // Is the pin in force RIGHT NOW? Only in frozen mode: a live binding is animating against the
  // current fit and must keep tracking `devicePixelRatio × renderScale`.
  const pinnedRatio = (): number | undefined =>
    staticShaders ? staticPixelRatio : undefined;
  // Optional FPS cap for the animated re-render loop (options.shaderFps). 0/undefined → uncapped.
  // MUTABLE for live setFps (adaptive quality keeps fps high but can lower it toward the floor).
  let minFrameTime =
    options.shaderFps && options.shaderFps > 0 ? 1 / options.shaderFps : 0;
  // Frozen-TIME (single-shot) mode: render each shader ONCE at a pinned representative TIME, then stop the loop,
  // instead of re-rendering TIME-driven shaders every frame. A single frozen frame is correct for any shader
  // (the render_mode blend is a node CSS mix-blend-mode, applied regardless of frame count, so an additive glow
  // still glows) and costs ~zero ongoing GPU — the low-end fallback that replaces a per-shader CSS approximation.
  // MUTABLE via setStaticShaders so an adaptive consumer can drop into it as a downgrade rung. `staticShaderTime`
  // is the pinned TIME in seconds (default 1; the consumer tunes it to land animated loops on a representative
  // phase).
  let staticShaders = options.staticShaders ?? false;
  // Frozen-surface image swap (see `../surface-image-swap`). The option carries the POLICY (a plain
  // `true` = the content-key gate that shipped first); the runtime only decides WHEN to consult it.
  // Ships ON — a consumer that never enters frozen mode is unaffected either way under the default
  // policy, since a content-key swap only ever acts on a cacheable frozen frame — and
  // `staticShaderImages: false` / `setStaticShaderImages(false)` is the kill switch, which takes the
  // pre-existing code path exactly (a binding with no swap state is untouched by it).
  const staticSurfacePolicy = options.staticShaderImages ?? true;
  const staticTime =
    typeof options.staticShaderTime === "number" ? options.staticShaderTime : 1;
  // Cap for GL texture uploads (longest edge); a larger image is downscaled before texImage2D to avoid the
  // main-thread upload spike. Undefined ⇒ native size.
  const maxTextureDim = options.maxTextureDimension;
  // Opt-in SCREEN_TEXTURE capture. Off (default) ⇒ screen-reading shaders take the same
  // unsupported/CSS-fallback path as before support existed.
  const enableScreenCapture = options.enableScreenTextureCapture === true;
  const maxScreenCaptureDim =
    options.maxScreenCaptureDim && options.maxScreenCaptureDim > 0
      ? options.maxScreenCaptureDim
      : DEFAULT_MAX_SCREEN_CAPTURE_DIM;
  // The WebGL backend (see `./shader-backend`). Built at create and kept for the runtime's whole
  // life whatever `backend` currently is, because it is what every failure path adopts — no adapter,
  // a rejected pipeline, a device lost mid-run, a single shader WebGPU cannot express — and a
  // fallback constructed at the moment it was needed would be a second way to fail, on the
  // device-loss path, which is the worst possible moment to discover the shared GL context cannot be
  // had either. The DOM half of a create, the program cache, the static-frame cache and the
  // SCREEN_TEXTURE composite stay here and are reached back through these deps.
  const glBackend = createWebglShaderBackend(sharedGl, {
    maxTextureDim,
    captureScreenTexture: (binding, rootRect) =>
      captureScreenTexture(sharedGl, binding, rootRect, maxScreenCaptureDim),
    staticFrameKey: memoStaticFrameKey,
    lookupStaticFrame,
    storeStaticFrame,
  });
  // The renderer NEW bindings are created on. NULL means PENDING: this runtime asked for WebGPU and
  // the device has not arrived yet (see the renderer gate below). Nothing is created in that state —
  // an opted-in node keeps its CSS/SVG paint, exactly as it does while its shader source is still
  // being fetched — and it is never null again once a backend has been adopted.
  let backend: ShaderRenderBackend | null = null;
  // The WebGPU backend once adopted, kept separately from `backend` because it survives a
  // per-binding decision: a runtime on WebGPU still hands SOME bindings to `glBackend`.
  let gpuBackend: WebgpuShaderBackend | null = null;
  let lastTime = nowSeconds();
  let disposed = false;
  // Instrumentation counters (see WebglShaderRuntimeStats): plain `++` writes on the hot paths,
  // exposed live via the handle's `stats()`. Purely observational — no render decision reads them.
  const runtimeStats = createWebglShaderRuntimeStats();
  // OPT-IN per-frame cost attribution (see `ShaderProfile`), or null forever. ONE object for the
  // runtime's life, mutated in place and published by reference through `stats().profile`, so an off
  // runtime carries a null field and the render path takes no clock reading at all.
  const profile: ShaderProfile | null =
    options.effectsProfiling === true ? createShaderProfile() : null;
  runtimeStats.profile = profile;
  // The surface image swap for THIS runtime: it owns the encode queue, the gate timers, the
  // watchdog and the swapped set, under `staticSurfacePolicy`. `null` IS the kill switch — no
  // binding is ever given swap state, and every swap call site is a no-op on a stateless binding.
  let surfaceSwapper: StaticSurfaceSwapper | null = createStaticSurfaceSwapper(
    staticSurfacePolicy,
    runtimeStats,
  );
  // Keyed by the shader NODE element — its DOM identity is stable across re-renders for an
  // unchanged node (Stage B keyed reconcile), so its binding is reused, not recreated.
  const bindings = new Map<HTMLElement, NodeBinding>();
  // Per-node generation guard for the async source-resolve race: a node removed (or its
  // shader re-keyed) before resolveShaderSource settles must not create a stale binding.
  const pending = new Map<HTMLElement, symbol>();

  // Size ONE binding's backing store at the ratio that applies to it right now: the PIN while
  // frozen (see `staticShaderPixelRatio`), else the live `devicePixelRatio × renderScale`. The
  // longest-edge clamp rides the pinned path only — the live path is bounded by the device and
  // has never been clamped, so an un-pinned runtime sizes byte-identically to before. Every
  // in-runtime `syncCanvasSize` goes through here so the two paths can't drift.
  //
  // This is the RUNTIME-WIDE half of the density only. The per-binding half — how magnified THIS
  // surface is (`SURFACE_PIXEL_RATIO_ATTR`) — is folded in by `syncCanvasSize` itself, so it applies
  // to whichever of the two ratios above won and to the create-time sizing alike.
  const sizeCanvas = (
    binding: NodeBinding,
    contentRect?: { width: number; height: number },
  ): void => {
    const pin = pinnedRatio();
    if (pin !== undefined) runtimeStats.pinnedCanvasSyncs++;
    syncCanvasSize(
      binding,
      pin ?? pixelRatio,
      contentRect,
      runtimeStats,
      backingDimLimit(
        pin === undefined ? undefined : MAX_PINNED_BACKING_DIM,
        // The backend's OWN ceiling, where it has one (WebGPU: `maxTextureDimension2D`). Absent on
        // WebGL — undefined here keeps an un-pinned GL runtime sizing byte-identically to before.
        binding.backend.maxBackingDim?.(),
      ),
    );
  };

  // ---- first sizing: MUTATE all → MEASURE all → WRITE all -------------------------------------
  //
  // THE layout read of this runtime, and the only one that is not served from a cache: a brand-new
  // binding's self-layer box. It cannot be avoided (each binding has its own self-layer) and it
  // cannot be taken BEFORE `createBinding` either — that function zeroes the self-layer's border,
  // and these layers are `box-sizing: border-box`, so the box a pre-measure would read is not the
  // box the canvas has to cover.
  //
  // What CAN be avoided is paying a style+layout FLUSH per node. A create finishes inside its own
  // microtask continuation (see `scheduleCreate`), so building + measuring in one step made a
  // reconcile that mounts N shader nodes interleave N writes with N reads — N forced layouts inside
  // one task. Measured on a moto g86 5G combat trace: 53.6 ms of `get clientWidth` self time inside
  // `UpdateLayoutTree`/`performLayout` across two ~12 s traces, 14.8 ms of it in a single 68.4 ms
  // long task; and on this repo's own `effects-runtime --mechanism shaders-live` run, 12 of the
  // trace's 14 `Layout` events were one per shader node, 0.16–0.35 ms apart.
  //
  // So the create burst is phased, exactly as `../particles/runtime`'s reconcile is: every canvas is
  // built first (that is `createBinding`), then every box is read back-to-back with no write between
  // them — one flush for the whole run — then every backing store is sized from the cache. The drain
  // is a MICROTASK, so nothing is deferred by a frame and no rAF tick can see an unsized canvas.
  const awaitingFirstSize: NodeBinding[] = [];
  let firstSizeDrainArmed = false;
  // PASS 2 — MEASURE. The one `clientWidth`/`clientHeight` read, in the one place that performs it.
  const readBoxInto = (binding: NodeBinding): void => {
    binding.boxW = binding.selfLayer.clientWidth;
    binding.boxH = binding.selfLayer.clientHeight;
    binding.boxMeasured = true;
  };
  const drainFirstSizes = (): void => {
    firstSizeDrainArmed = false;
    if (disposed || awaitingFirstSize.length === 0) return;
    const queued = awaitingFirstSize.splice(0, awaitingFirstSize.length);
    const live: NodeBinding[] = [];
    for (const binding of queued) {
      // Disposed, or its node re-bound, between the create and this drain: it owes nothing.
      if (bindings.get(binding.node) !== binding) continue;
      // Parked in that window: reading its box is exactly the forced layout dormancy exists to
      // avoid, so the sizing is handed to the wake — `syncCanvasSizeOrDefer`'s contract, and the
      // reason this is not a silent skip. (Not reachable today: only a host `reconcile()` can park
      // a binding, and a task cannot interleave with the microtask this drain runs in. It is
      // written this way because a binding that quietly never gets sized draws at the canvas
      // element's 300x150 default, which is a wrong picture rather than a missing one.)
      if (binding.dormant) {
        binding.canvasSyncDeferred = true;
        continue;
      }
      live.push(binding);
    }
    for (const binding of live) {
      if (!binding.boxMeasured) readBoxInto(binding);
    }
    // PASS 3 — WRITE. Every box is cached now, so this run resolves at tier 2 and reads nothing.
    for (const binding of live) sizeCanvas(binding);
    if (live.length > 0) scheduleRender();
  };
  const queueFirstSize = (binding: NodeBinding): void => {
    // Born parked: the create pays no sizing at all (`createBinding` already marked the sync as
    // deferred), and the wake pays exactly one.
    if (binding.dormant) return;
    awaitingFirstSize.push(binding);
    if (firstSizeDrainArmed) return;
    firstSizeDrainArmed = true;
    if (typeof queueMicrotask === "function") {
      queueMicrotask(drainFirstSizes);
    } else {
      void Promise.resolve().then(drainFirstSizes);
    }
  };

  // ---- rect cache ----------------------------------------------------------------------------
  //
  // The screen-space paths (SCREEN_UV, SCREEN_TEXTURE, SCREEN_PIXEL_SIZE) need viewport rects: the
  // scene root's, and each such node's self-layer. Measuring them inside the render loop is a
  // FORCED LAYOUT per frame (and, for the self-layer, per SCREEN_UV node per frame) — a fixed
  // main-thread cost on screens where nothing moves, which is what phone traces showed. So the
  // rects are cached and re-read in ONE batch at tick start, and only when something could have
  // moved them:
  //   - `reconcile()` (the host re-rendered → the DOM may have moved),
  //   - a binding's ResizeObserver (its own box changed),
  //   - a window resize,
  //   - a new binding appearing,
  //   - and a conservative TTL, so a CSS-transition-driven move (which fires none of the above)
  //     can't leave a SCREEN_UV sample badly stale — worst case it lags by RECT_CACHE_MAX_AGE_S.
  // Nothing is read at all when no live binding actually needs a rect (the common case).
  const RECT_CACHE_MAX_AGE_S = 0.12;
  let cachedRootRect: ViewportRect | null = null;
  let rectsReadAt = Number.NEGATIVE_INFINITY;
  let rectsStale = true;
  const invalidateRects = (): void => {
    rectsStale = true;
  };
  // The root rect is the SAME for every shader node: served from the cache, read lazily only if a
  // render needs it before any batch ran.
  const getRootRect = (): ViewportRect =>
    (cachedRootRect ??= root.getBoundingClientRect());
  // ONE batched layout flush: read the root rect and every rect-consuming binding's self-layer
  // back-to-back (no interleaved writes ⇒ the browser flushes layout once), or nothing at all when
  // the cache is still fresh.
  const refreshRects = (): void => {
    const now = nowSeconds();
    if (!rectsStale && now - rectsReadAt < RECT_CACHE_MAX_AGE_S) return;
    let read = false;
    for (const binding of bindings.values()) {
      // Dormant (parked) and suspended (occluded) bindings measure nothing — the whole point of
      // both states is that they cost no layout.
      if (binding.dormant || binding.suspended) continue;
      if (!readsScreenRect(binding.program)) continue;
      if (!read) {
        cachedRootRect = root.getBoundingClientRect();
        read = true;
      }
      if (needsLayerRect(binding.program)) {
        binding.layerRect = binding.selfLayer.getBoundingClientRect();
      }
    }
    // Only mark the cache fresh once it actually holds a measurement; with no rect consumer there
    // is nothing to cache (and nothing was read).
    if (read) {
      rectsStale = false;
      rectsReadAt = now;
    }
  };
  const onWindowResize = (): void => invalidateRects();
  if (typeof window !== "undefined") {
    window.addEventListener("resize", onWindowResize);
  }

  // ---- shared ResizeObserver -----------------------------------------------------------------
  //
  // ONE observer for the whole runtime, dispatching by observed target, instead of one per binding.
  // Each `new ResizeObserver` is its own registration + closure and its own callback slot in the
  // browser's observation loop; a create-burst (a re-keyed hand of cards) built dozens at once. The
  // per-binding semantics are preserved exactly: a target's LAST entry in a delivery wins (an
  // intermediate size would only be overwritten anyway), and one `invalidateRects` per delivery.
  const observedBindings = new Map<Element, NodeBinding>();
  const sharedObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          const latest = new Map<Element, ResizeObserverEntry>();
          for (const entry of entries) latest.set(entry.target, entry);
          let changed = false;
          let liveChanged = false;
          for (const [target, entry] of latest) {
            const binding = observedBindings.get(target);
            if (!binding) continue;
            // The observer already measured the new size — use it instead of forcing a
            // clientWidth/clientHeight reflow. Reads the CURRENT ratio (`sizeCanvas`) so a resize
            // after a live setRenderScale — or under a frozen-mode pin — uses that ratio rather
            // than the create-time one. A DORMANT binding defers the sync (its box read is
            // exactly what dormancy exists to avoid) but still
            // CACHES the delivered box: the wake's deferred syncCanvasSize passes no contentRect,
            // so without this it would size the canvas from the stale pre-park box (a 0×0 box —
            // a hidden ancestor — is left out; the wake falls back to a fresh clientWidth read).
            if (binding.dormant) {
              if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
                binding.boxW = entry.contentRect.width;
                binding.boxH = entry.contentRect.height;
                binding.boxMeasured = true;
              }
              binding.canvasSyncDeferred = true;
            } else {
              sizeCanvas(binding, entry.contentRect);
              liveChanged = true;
            }
            binding.dirty = true;
            changed = true;
          }
          // A box changed ⇒ this node's (and possibly every node's) cached viewport rect is stale.
          if (changed) invalidateRects();
          // A LIVE binding was resized: the realloc CLEARED its backing store, so the frozen-mode
          // (or non-TIME) loop — which self-stops — must be re-kicked or the node stays blank/stale
          // until an unrelated event schedules a tick (the "widened window never drawn" half of the
          // UNDERDOCKS band bug). Dormant-only deliveries schedule nothing: their work runs on wake.
          if (liveChanged) scheduleRender();
        });
  const observeBinding = (binding: NodeBinding): void => {
    if (!sharedObserver) return;
    observedBindings.set(binding.selfLayer, binding);
    sharedObserver.observe(binding.selfLayer);
  };
  const unobserveBinding = (binding: NodeBinding): void => {
    if (!sharedObserver) return;
    observedBindings.delete(binding.selfLayer);
    sharedObserver.unobserve(binding.selfLayer);
  };

  // ---- dormancy ------------------------------------------------------------------------------
  //
  // See `../shader-dormant` for the contract. Expiry is ONE per-runtime timer, armed only while at
  // least one binding is dormant. It compares monotonic ORDINALS, not a clock: the sweep disposes
  // every binding that was already dormant when the timer was armed (so ≥ one full interval), then
  // re-arms if any remain. No per-binding timer, no `nowSeconds()` reading, no drift.
  let dormantSeq = 0;
  let dormantSweepArmedAt = 0;
  let dormantSweepTimer: ReturnType<typeof setTimeout> | null = null;
  const armDormantSweep = (): void => {
    if (disposed || dormantSweepTimer !== null) return;
    dormantSweepArmedAt = dormantSeq;
    dormantSweepTimer = setTimeout(
      sweepDormant,
      DORMANT_DISPOSE_SECONDS * 1000,
    );
  };
  function sweepDormant(): void {
    dormantSweepTimer = null;
    if (disposed) return;
    let remaining = false;
    const expired: HTMLElement[] = [];
    for (const [node, binding] of bindings) {
      if (!binding.dormant) continue;
      if (binding.dormantSeq <= dormantSweepArmedAt) expired.push(node);
      else remaining = true;
    }
    for (const node of expired) {
      const binding = bindings.get(node);
      if (!binding) continue;
      disposeBinding(binding);
      bindings.delete(node);
    }
    if (remaining) armDormantSweep();
  }

  // ONE shared loop over the LIVE binding set. `animated` is recomputed each tick (the
  // set changes across reconciles) and the loop self-stops when nothing is animated/dirty;
  // create/update re-kick it via scheduleRender (so adding the first TIME shader restarts it).
  // Wakeups go through the pacer: under an FPS cap it PARKS on a timer to the cap boundary
  // instead of spinning a rAF per display frame (see ../effects-loop-pacing).
  const pacer = createEffectsLoopPacer(() => tick(), options.effectsLoopPacing);
  // Seconds until the cap allows the next animated re-render. 0 = now: uncapped, or frozen mode
  // (whose one-shot render is never deferred).
  const capRemaining = (now: number): number =>
    staticShaders || minFrameTime <= 0 ? 0 : minFrameTime - (now - lastTime);
  const tick = (): void => {
    if (disposed) return;
    // In frozen mode TIME is pinned (a deterministic, cacheable still frame); otherwise it advances live.
    const time = staticShaders ? staticTime : nowSeconds();
    // FPS cap only throttles ANIMATED re-renders; a frozen-mode one-shot must not be deferred.
    // (TIME still advances from the shared clock, so live animations stay time-correct — just sampled lower.)
    const remaining = capRemaining(time);
    if (!pacer.isDue(remaining)) {
      runtimeStats.capDeferrals++;
      pacer.arm(remaining);
      return;
    }
    lastTime = time;
    // Batch every layout read this tick could need UP FRONT (usually: none at all).
    refreshRects();
    let animated = false;
    // Bindings this tick actually rendered, so a tick that found nothing to draw books no `ticks`
    // and stays out of the buckets' denominator (see `ShaderProfile`).
    let profBindings = 0;
    // The tick's frame bracket (see `ShaderRenderBackend`). A no-op on WebGL, where every draw is
    // submitted as it is issued; on WebGPU it opens the ONE command encoder whose single submit per
    // tick is exactly the win measured in S7. BOTH backends are bracketed, always: under a WebGPU
    // runtime some bindings are on WebGL (see `webgpuBindingFallbacks`), and either set may be the
    // one that draws this tick.
    glBackend.beginFrame();
    gpuBackend?.beginFrame();
    for (const binding of bindings.values()) {
      // Parked binding (see ../shader-dormant): the canvas is hidden and the box unmeasured, so
      // there is nothing to draw; `dirty` is left set for the wake.
      if (binding.dormant) continue;
      // Occluded subtree (see ../effects-suspend): render nothing and don't keep the loop alive.
      // `dirty` is left set, so the resume reconcile re-renders it at the current TIME.
      if (binding.suspended) continue;
      // A TIME shader keeps the loop alive ONLY in live mode; frozen, it renders once (when dirty) and stops.
      const animatedShader = binding.program.usesTime && !staticShaders;
      if (animatedShader) animated = true;
      if (animatedShader || binding.dirty) {
        if (profile) profBindings++;
        const handled = binding.backend.renderNode(
          binding,
          time,
          staticShaders,
          getRootRect,
          runtimeStats,
          profile,
        );
        clearLoadingFallbackIfReady(binding);
        binding.dirty = false;
        if (handled && onBindingRendered)
          onBindingRendered(
            binding.node,
            binding.canvas,
            renderInfoOf(binding),
          );
      }
    }
    gpuBackend?.endFrame();
    glBackend.endFrame();
    if (profile && profBindings > 0) {
      profile.ticks++;
      profile.bindings += profBindings;
    }
    if (animated) scheduleRender();
  };
  // Kick the loop from a wake path (a create/update, a reconcile, a live quality retune). A wakeup
  // already in flight is left alone — including a PARK, which fires within one cap interval, exactly
  // the worst case of the pre-pacing skip-and-re-arm.
  const scheduleRender = (): void => {
    if (disposed || pacer.isArmed()) return;
    pacer.arm(capRemaining(nowSeconds()));
  };

  // Render ONE binding right now (not on the next rAF). Used after a window/size change resizes the canvas —
  // assigning canvas.width CLEARS it, so without an immediate re-render the canvas would be blank until the next
  // tick (a one-frame flicker). Cheap: a single node draw + (only for SCREEN_UV) one getBoundingClientRect.
  const renderBindingNow = (binding: NodeBinding): void => {
    if (disposed) return;
    // A suspended (occluded) or dormant (parked, hidden canvas) binding has nothing to flicker —
    // leave it dirty so the resume/wake renders it at the current TIME instead of painting now.
    if (binding.suspended || binding.dormant) {
      binding.dirty = true;
      return;
    }
    const time = staticShaders ? staticTime : nowSeconds();
    // A synchronous out-of-loop render is about to happen (the parked/suspended early-return above
    // renders nothing, so it deliberately does not count).
    runtimeStats.syncRenders++;
    // Serve the rects from the cache (refreshed here if this is the first read since an
    // invalidation), so a burst of window-change renders inside one reconcile still costs at most
    // one layout flush.
    refreshRects();
    // NO profile: this is an out-of-loop anti-flicker render, not a frame the loop paid for, and
    // folding it into the per-frame buckets would inflate a tick that never happened (`ticks` is
    // their denominator). `syncRenders` above is how a probe sees this path at all.
    // Bracketed like a tick: a batching backend must still submit the work this render just
    // recorded, or the anti-flicker frame would never reach the screen.
    binding.backend.beginFrame();
    const handled = binding.backend.renderNode(
      binding,
      time,
      staticShaders,
      getRootRect,
      runtimeStats,
    );
    binding.backend.endFrame();
    binding.dirty = false;
    if (handled && onBindingRendered)
      onBindingRendered(binding.node, binding.canvas, renderInfoOf(binding));
  };

  const wireTextureListeners = (binding: NodeBinding): void => {
    for (const dispose of binding.textureLoadDisposers) dispose();
    binding.textureLoadDisposers.length = 0;
    const markDirty = (): void => {
      // A decoded texture can settle with the same dimensions as its placeholder.  Its loaded
      // state still changes whether a frozen frame is eligible, and a decode can replace the
      // backend view without touching any DOM attribute, so it is a real key-input writer.
      invalidateStaticFrameKey(binding);
      binding.dirty = true;
      scheduleRender();
    };
    binding.textureLoadDisposers.push(
      onTextureLoaded(binding.texture, markDirty),
    );
    for (const sampler of binding.samplers) {
      binding.textureLoadDisposers.push(
        onTextureLoaded(sampler.entry, markDirty),
      );
    }
  };

  const disposeBinding = (binding: NodeBinding): void => {
    unobserveBinding(binding);
    // Drop the stand-in `<img>` and release this binding's object-URL refcount BEFORE the canvas
    // goes: a leaked blob URL outlives the node, the runtime and the scene.
    disposeStaticImage(binding);
    for (const dispose of binding.textureLoadDisposers) dispose();
    binding.textureLoadDisposers.length = 0;
    binding.canvas.remove();
    // Revert the blend we set on the node (it's the consumer's element; clear it in case the node
    // persists after it stops being a shader node, e.g. a reused element).
    binding.node.style.mixBlendMode = "";
    // Whatever renderer-owned state this binding holds goes back to its backend (see
    // `ShaderRenderBackend.disposeSurface`) — on GL, its SCREEN_TEXTURE capture texture.
    binding.backend.disposeSurface(binding);
  };

  // `syncCanvasSize`, DEFERRED while the binding is dormant. A parked binding's box read is exactly
  // the forced layout dormancy exists to avoid, and however many syncs pile up while it sleeps, the
  // wake pays for ONE.
  const syncCanvasSizeOrDefer = (binding: NodeBinding): void => {
    if (binding.dormant) {
      binding.canvasSyncDeferred = true;
      return;
    }
    sizeCanvas(binding);
  };

  // Re-read a KEPT binding's data-attrs (cheap attribute/style reads — NEVER a clientWidth/Height forced
  // reflow; a window change resizes the canvas from the cached box) and update only what changed. This is what
  // makes a re-render with unchanged shader nodes do ZERO forced layout — the fix for the per-render reflow storm.
  const updateBinding = (binding: NodeBinding): void => {
    const node = binding.node;
    const selfLayer = binding.selfLayer;
    let changed = false;
    let rewire = false;

    const paramsAttr = node.getAttribute("data-godot-shader-params");
    if (paramsAttr !== binding.paramsAttr) {
      binding.params = parseParams(paramsAttr);
      binding.paramsKey = paramsFrameKey(binding.params);
      binding.paramsAttr = paramsAttr;
      invalidateStaticFrameKey(binding);
      changed = true;
    }
    const kindsAttr = node.getAttribute("data-godot-shader-param-kinds");
    if (kindsAttr !== binding.paramKindsAttr) {
      binding.paramKinds = parseParamKinds(kindsAttr);
      binding.paramKindsKey = paramKindsFrameKey(binding.paramKinds);
      binding.paramKindsAttr = kindsAttr;
      invalidateStaticFrameKey(binding);
      changed = true;
    }
    const modAttr = node.getAttribute("data-godot-shader-modulate");
    if (modAttr !== binding.modulateAttr) {
      binding.modulate = parseModulate(modAttr);
      binding.modulateKey = modulateFrameKey(binding.modulate);
      binding.modulateAttr = modAttr;
      invalidateStaticFrameKey(binding);
      changed = true;
    }
    const fit = backgroundFit(selfLayer);
    if (fit !== binding.fit) {
      binding.fit = fit;
      invalidateStaticFrameKey(binding);
      changed = true;
    }
    const windowAttr = selfLayer.getAttribute("data-godot-shader-uv-window");
    if (windowAttr !== binding.windowAttr) {
      binding.window = parseWindow(windowAttr);
      binding.windowKey = windowFrameKey(binding.window);
      binding.windowAttr = windowAttr;
      invalidateStaticFrameKey(binding);
      placeCanvasWindow(binding.canvas, binding.window);
      // The canvas just MOVED. A stand-in `<img>` copied the old placement, so it is retired here
      // rather than left mis-placed for however long it takes the re-render below to notice the new
      // (window-derived) frame key — which is deferred outright while parked/occluded. Not blocked:
      // an animating window can never reach the stability gate in the first place.
      revertStaticImage(binding, runtimeStats);
      // The canvas sub-rect changed → resize its backing to box×window. The box itself is UNCHANGED by a pure
      // window move, so syncCanvasSize reuses the cached box size (no forced reflow — this was the per-frame
      // clientWidth read that showed up as the #1 main-thread symbol on phones when a large overflowing
      // background's visible window animated). The resize CLEARS the canvas, so re-render synchronously to avoid
      // a one-frame blank (flicker). Dormant ⇒ both are deferred to the wake.
      syncCanvasSizeOrDefer(binding);
      renderBindingNow(binding);
      changed = true;
    }
    const ratioAttr = selfLayer.getAttribute(SURFACE_PIXEL_RATIO_ATTR);
    if (ratioAttr !== binding.pixelRatioAttr) {
      binding.pixelRatioScale = parseSurfacePixelRatio(ratioAttr);
      binding.pixelRatioAttr = ratioAttr;
      // The uv-window block above, for the same three reasons and in the same order. A stand-in
      // `<img>` is showing pixels rendered at the OLD density, so it is retired HERE — deliberately,
      // by the swap's own `revertStaticImage`, and not left for the watchdog to catch as an
      // unexplained re-allocation on some later sweep (which would also reset the surface's gate and
      // make it re-earn a freeze it never lost). The re-size itself reuses the cached box: a density
      // change moves no element box, so this costs NO forced reflow. And the re-size CLEARS the
      // backing store, so re-render synchronously rather than show one blank frame. Dormant ⇒ both
      // are deferred to the wake.
      //
      // Cheap when nothing moved, which is the case that matters: an UNCHANGED attribute is one
      // string compare per sweep and takes none of this.
      revertStaticImage(binding, runtimeStats);
      syncCanvasSizeOrDefer(binding);
      renderBindingNow(binding);
      changed = true;
    }
    const url =
      selfLayer.getAttribute("data-godot-shader-texture-url") ||
      memoizedBackgroundImageUrl(binding, selfLayer);
    const regionAttr = selfLayer.getAttribute("data-godot-atlas-region");
    const repeatAttr = node.getAttribute("data-godot-texture-repeat");
    if (
      url !== binding.textureUrl ||
      regionAttr !== binding.textureRegionAttr ||
      repeatAttr !== binding.textureRepeatAttr
    ) {
      binding.textureUrl = url;
      binding.textureRegionAttr = regionAttr;
      binding.textureRepeatAttr = repeatAttr;
      binding.textureRepeat = nodeTextureRepeats(node);
      binding.textureRegion = parseAtlasRegion(regionAttr);
      binding.texture = binding.backend.resolveNodeTexture({
        node,
        selfLayer,
        textureUrl: url,
      });
      invalidateStaticFrameKey(binding);
      changed = true;
      rewire = true;
    }
    const samplersAttr = node.getAttribute("data-godot-shader-samplers");
    const samplerUrlsAttr = node.getAttribute("data-godot-shader-sampler-urls");
    if (
      samplersAttr !== binding.samplersAttr ||
      samplerUrlsAttr !== binding.samplerUrlsAttr
    ) {
      binding.samplers = binding.backend.resolveSamplers(node, binding.program);
      binding.samplersAttr = samplersAttr;
      binding.samplerUrlsAttr = samplerUrlsAttr;
      invalidateStaticFrameKey(binding);
      changed = true;
      rewire = true;
    }
    if (rewire) wireTextureListeners(binding);
    if (changed) {
      binding.dirty = true;
      scheduleRender();
    }
  };

  const scheduleCreate = (
    node: HTMLElement,
    path: string | undefined,
    uid: string | undefined,
    shaderKey: string,
  ): void => {
    const generation = Symbol();
    pending.set(node, generation);
    // Still want this binding? (not disposed, not superseded by a newer create on the same
    // node, the node is still in the DOM, and it hasn't already been created).
    const stillWanted = (): boolean =>
      !disposed &&
      pending.get(node) === generation &&
      node.isConnected &&
      !bindings.has(node);

    void (async () => {
      const selfLayer = ownSelfLayer(node);
      if (!selfLayer) {
        pending.delete(node);
        return;
      }
      const url =
        selfLayer.getAttribute("data-godot-shader-texture-url") ||
        backgroundImageUrl(selfLayer);

      // THE RENDERER GATE, awaited (see `openGate`). Settled synchronously in every case that
      // matters — a `"webgl"` runtime, a browser with no `navigator.gpu`, a second runtime on a page
      // whose device already arrived — so this awaits a real promise only while a WebGPU device is
      // in flight. A create that waits is why there is no surface-less binding state in this
      // runtime: a shader binding SUPPRESSES the node's CSS/SVG paint at create, so one that cannot
      // draw yet would be a visible hole, and this path is already asynchronous for the shader
      // source.
      const runtimeBackend = backend ?? (await settledBackend());
      if (!runtimeBackend || !stillWanted()) {
        pending.delete(node);
        return;
      }

      let source: string | undefined;
      const cached = programCache.get(
        programCacheKey(shaderKey, enableScreenCapture),
      );
      if (cached === "unsupported") {
        clearLoadingFallbackStyles(selfLayer);
        pending.delete(node);
        return;
      }
      // A WebGPU runtime needs the SOURCE to build this shader's WGSL twin — even when the GL
      // program is already cached, which is what a second node with the same shader (or a WebGL
      // runtime elsewhere on the page) leaves behind. The decision, once made, is cached per shader,
      // so this is at most one extra resolve per shader per page.
      const needsWgsl =
        runtimeBackend.kind === "webgpu" &&
        gpuBackend?.peekShader(shaderKey) === undefined;
      if (!cached || needsWgsl) {
        try {
          // Shared across every node with this shader id (see `resolveExpandedShaderSource`):
          // a cold cache with N same-shader nodes now does ONE fetch + ONE include expansion.
          source = await resolveExpandedShaderSource(
            shaderKey,
            path,
            uid,
            resolveShaderSource,
          );
        } catch {
          source = undefined;
        }
        if (!stillWanted()) {
          pending.delete(node);
          return;
        }
        // Only fatal when there is no compiled program either. With one cached, an unresolvable
        // source costs this binding its WebGPU twin (it falls back below), not its render.
        if (source === undefined && !cached) {
          reportUnsupportedRender(
            {
              kind: "shader",
              id: shaderKey,
              reason: "shader source unresolved",
            },
            options.onUnsupported,
          );
          clearLoadingFallbackStyles(selfLayer);
          pending.delete(node);
          return;
        }
      }
      const program = await getProgramAsync(
        gl,
        shaderKey,
        source ?? "",
        options.onUnsupported,
        enableScreenCapture,
      );
      if (!program || !stillWanted()) {
        if (stillWanted()) clearLoadingFallbackStyles(selfLayer);
        pending.delete(node);
        return;
      }
      // PER-BINDING, not per-runtime: a shader WebGPU cannot express falls back BY ITSELF.
      const bindingBackend = await chooseBindingBackend(
        runtimeBackend,
        shaderKey,
        source,
      );
      if (!stillWanted()) {
        pending.delete(node);
        return;
      }
      const binding = createBinding(
        bindingBackend,
        root,
        node,
        selfLayer,
        url,
        shaderKey,
        program,
      );
      pending.delete(node);
      if (!binding) {
        clearLoadingFallbackStyles(selfLayer);
        return;
      }
      bindings.set(node, binding);
      // The canvas is built but not sized yet: this hands the one box read to the batched
      // measure→write drain (see `queueFirstSize`), which runs before any frame can paint.
      queueFirstSize(binding);
      observeBinding(binding);
      // Swap state exists only while the mechanism is on; NO swapper IS the kill switch (every
      // image-swap call site is a no-op on a stateless binding), so an off runtime keeps the old
      // code exactly. `attach` also registers the binding, which is what lets the swapper's own
      // gate/watchdog timers enumerate it without the runtime handing them anything.
      //
      // TWO ENCODE SOURCES. A WebGL binding's canvas holds readable 2D pixels, so the swap reads it
      // directly — the path that shipped first. A WebGPU binding's canvas cannot be read at all
      // (`drawImage`/`toDataURL`/`toBlob` go through presentation: blank headless, pathological on
      // Android — S7), which is why v1 simply never attached one. v2 attaches it with a CAPTURE HOOK
      // instead: the backend re-renders this binding's current frame into an offscreen texture and
      // copies it back (`../webgpu/readback`), and the swap encodes THAT. The canvas is never read.
      //
      // WHY THE FROZEN CONTENT KEY STAYS VALID ACROSS THAT INDIRECTION. The key names a set of pure
      // node-local inputs (shader, size, fit, textures, window, modulate, params, pinned time), and
      // `captureSurface` re-renders at the pinned static time from the binding's CURRENT params — so
      // it reproduces the frame the key names, not merely a frame. If any of those inputs moves, the
      // next render reports a different key and the swap reverts before the stand-in is stale;
      // that is the same invariant the WebGL path has, and it is why the extra render is sound
      // rather than a second interpretation of the state.
      //
      // A binding with neither (no 2D context and no capture hook) is left unattached — the
      // documented kill switch applied per binding, with every swap counter staying 0 for it.
      if (binding.ctx2d) {
        surfaceSwapper?.attach(binding);
      } else if (binding.backend.captureSurface) {
        binding.captureCanvas = async () => {
          // Read the size BEFORE the await: the capture is produced at the backing-store size the
          // render used, and a re-size landing mid-capture must not re-interpret those bytes.
          const w = binding.canvas.width;
          const h = binding.canvas.height;
          // THE BLANK GUARD's assertion, read at the same instant and for the same reason (see
          // `../surface-image-swap`'s BLANK CAPTURES). What this runtime can honestly say about a
          // capture is that it encodes a FULL-VIEWPORT QUAD — `captureSurfacePixels` runs the live
          // pipeline over the whole surface, so there is always draw work — multiplied by the node's
          // MODULATE, which is the one input from outside the fragment program that can zero the
          // frame on its own. Modulated to invisible ⇒ an invisible capture is the truth and is
          // encoded as one.
          // THE RESIDUAL, stated: what happens INSIDE the program is not knowable from here, so a
          // shader that really outputs alpha 0 everywhere reads as a blank capture and is held on
          // its live canvas instead of frozen. That costs one surface — one that paints nothing —
          // its layer saving, it is booked as `staticImageBlankCaptures` rather than inferred, and
          // it is the deliberate side of the trade against a surface that WAS painting silently
          // vanishing behind a PNG of nothing.
          const expectCoverage = binding.modulate[3] > 0;
          const pixels = await captureBindingPixels(binding);
          return pixels
            ? canvasFromPremultipliedRgba(pixels, w, h, expectCoverage)
            : null;
        };
        surfaceSwapper?.attach(binding);
      }
      binding.dirty = true;
      // Born dormant (the host stamped the node before it was ever bound): park it immediately so
      // the create pays NO `syncCanvasSize` — the whole point of the contract for a node that flips
      // in and out of shader-off states.
      if (binding.dormant) {
        binding.dormantSeq = ++dormantSeq;
        armDormantSweep();
      }
      // A new binding has no measured rect yet → let the next tick's batch pick it up.
      invalidateRects();
      wireTextureListeners(binding);
      scheduleRender();
    })();
  };

  // Re-evaluate a kept binding's occlusion state (attribute-only, no layout). Resuming re-arms the
  // render: the canvas still holds the pre-suspend frame, so it must be redrawn at the CURRENT
  // time, and its cached rect is almost certainly stale (the layout changed under it).
  const syncSuspended = (binding: NodeBinding): void => {
    const suspended = isEffectsSuspended(binding.node);
    if (suspended === binding.suspended) return;
    binding.suspended = suspended;
    if (!suspended) {
      binding.dirty = true;
      invalidateRects();
      scheduleRender();
    }
  };

  // Re-evaluate a kept binding's dormancy (attribute-only, no layout — see `../shader-dormant`).
  // Going dormant hides the canvas and parks the binding; WAKING pays the one deferred
  // `syncCanvasSize` (however many resizes/renderScale steps piled up while asleep collapse into
  // it), unhides, and re-arms the render at the current TIME.
  const syncDormant = (binding: NodeBinding): void => {
    const dormant = isShaderDormant(binding.node);
    if (dormant === binding.dormant) return;
    binding.dormant = dormant;
    if (dormant) {
      // Hides the canvas AND any stand-in `<img>`: a parked node paints nothing either way, and the
      // swap must not resurrect the canvas on the wake below. See `../surface-image-swap`.
      applySurfaceVisibility(binding);
      binding.dormantSeq = ++dormantSeq;
      armDormantSweep();
      return;
    }
    binding.dormantSeq = 0;
    applySurfaceVisibility(binding);
    // The wake re-arms a render this binding's gate may not be able to attribute — and a DEFERRED
    // canvas re-size below reallocates (and CLEARS) the backing store under any stand-in. Hand the
    // decision to the swap module, which reverts (without blocking) exactly when it cannot vouch
    // for the stand-in, instead of leaving a stale `<img>` up until the watchdog polls.
    noteStaticSurfaceWake(binding, runtimeStats, binding.canvasSyncDeferred);
    if (binding.canvasSyncDeferred) {
      binding.canvasSyncDeferred = false;
      sizeCanvas(binding);
    }
    binding.dirty = true;
    invalidateRects();
    scheduleRender();
  };

  const reconcile = (): void => {
    if (disposed) return;
    // The host re-rendered, so anything may have moved: the cached viewport rects are stale.
    // (Invalidated at the END too — this pass itself writes canvas sizes/styles.)
    invalidateRects();
    const present = new Set<HTMLElement>(
      root.querySelectorAll<HTMLElement>("[data-godot-shader-webgl]"),
    );
    // Dispose bindings whose node left the DOM.
    for (const [node, binding] of bindings) {
      if (!present.has(node)) {
        disposeBinding(binding);
        bindings.delete(node);
      }
    }
    // Keep+update existing bindings (unchanged shader); create new ones.
    for (const node of present) {
      const path = node.getAttribute("data-godot-shader-path") ?? undefined;
      const uid = node.getAttribute("data-godot-shader-uid") ?? undefined;
      const shaderKey = uid ?? path;
      if (!shaderKey) continue;
      const existing = bindings.get(node);
      if (existing) {
        if (existing.shaderKey === shaderKey) {
          // Dormancy FIRST: `updateBinding` may want a `syncCanvasSize`, which must defer while
          // parked and must run against a woken binding.
          syncDormant(existing);
          syncSuspended(existing);
          updateBinding(existing);
          // The image swap's stability clock: a frozen node renders once and is never visited by
          // the loop again, so "nothing asked this binding to re-render" is what evidence of a
          // frozen surface looks like. Attribute-only, no layout — see `../surface-image-swap`.
          if (existing.staticImage) {
            noteStaticImageReconcile(existing, staticShaders, runtimeStats);
          }
          continue;
        }
        // The shader itself swapped on the same element → recreate the program + binding.
        disposeBinding(existing);
        bindings.delete(node);
      }
      // Don't double-schedule while a create is already in flight for this node.
      if (!pending.has(node)) scheduleCreate(node, path, uid, shaderKey);
    }
    // updateBinding may have resized canvases / moved windows; re-measure on the next tick.
    invalidateRects();
  };

  // ---- THE RENDERER GATE (see `effectsRenderer` in ../types) ----------------------------------
  //
  // Factories are SYNCHRONOUS and a `GPUDevice` is not, so the gate's whole job is to make the
  // asynchronous case rare and the synchronous case exact:
  //
  //   "webgl"                     → adopt WebGL here, having probed nothing.
  //   no `navigator.gpu`          → adopt WebGL here too. This is the branch that keeps every jsdom
  //                                 test and every non-WebGPU browser on the byte-identical path
  //                                 they were on before this existed, even though the DEFAULT is
  //                                 "auto" — no promise, no microtask, no deferred create.
  //   device already settled      → adopt (or decline) here, synchronously. Page-wide memos make
  //                                 this the answer for every runtime after the first.
  //   otherwise                   → PENDING: creates WAIT (see `scheduleCreate`), so the nodes keep
  //                                 their CSS/SVG paint until the device answers instead of being
  //                                 stripped and left blank.
  //
  // Every failure is SILENT and lands in the stats: `webgpuFallbacks`, `webgpuFallbackReason`,
  // `webgpuBindingFallbacks`.
  let gpuShared: WebgpuShared | null = null;
  let unsubscribeDeviceLost: (() => void) | null = null;
  // THIS runtime's first fallback reason. The module-level latch in `../webgpu/device` is page-wide
  // (one device, one story), but a runtime pinned to `"webgl"` must not report a reason it never
  // hit, so the stat is sourced from here.
  let fallbackReason: WebgpuFallbackReason | null = null;
  // The in-flight resolution, awaited by a create that arrived while the gate was still open.
  let gatePromise: Promise<void> | null = null;

  const settledBackend = async (): Promise<ShaderRenderBackend | null> => {
    if (backend) return backend;
    await gatePromise;
    return backend;
  };

  // WHICH backend renders ONE binding. A WebGPU runtime still hands a binding to WebGL when its
  // shader cannot run there — a `hint_screen_texture` sampler, a construct the WGSL emitter refuses,
  // a module or pipeline that failed to build. That decision is the shader's, is cached per shader
  // by the backend, and is counted here so a silent per-binding fallback stays visible.
  const chooseBindingBackend = async (
    runtimeBackend: ShaderRenderBackend,
    shaderKey: string,
    source: string | undefined,
  ): Promise<ShaderRenderBackend> => {
    const gpu = gpuBackend;
    if (!gpu || runtimeBackend.kind !== "webgpu") return runtimeBackend;
    if (await gpu.prepareShader(shaderKey, source)) return gpu;
    runtimeStats.webgpuBindingFallbacks++;
    return glBackend;
  };

  // Adopt WebGL, silently, counting it. THE one place a whole-runtime fallback happens, so the
  // counter and the reason can never disagree. (A PER-BINDING fallback is a different event with its
  // own counter — the runtime is still on WebGPU.)
  const fallbackToWebgl = (reason: WebgpuFallbackReason): void => {
    if (disposed || backend?.kind === "webgl") return;
    runtimeStats.webgpuFallbacks++;
    if (fallbackReason === null) fallbackReason = reason;
    latchWebgpuFallbackReason(reason);
    backend = glBackend;
    gpuBackend = null;
    scheduleRender();
  };

  const adoptWebgpu = (
    shared: WebgpuShared,
    gpu: WebgpuShaderBackend,
  ): void => {
    if (disposed) return;
    gpuShared = shared;
    gpuBackend = gpu;
    backend = gpu;
    unsubscribeDeviceLost = onWebgpuDeviceLost(handleDeviceLost);
    // Creates that parked on the gate resume on their own; this kicks the loop for anything that did
    // not (a runtime whose reconcile ran before the gate settled has nothing else to wake it).
    scheduleRender();
  };

  // A lost device takes every WebGPU surface with it — and the canvas ELEMENTS too, because a canvas
  // that has held a webgpu context can never yield a 2d one, so the WebGL rebuild cannot reuse them.
  // Disposing each binding removes its canvas and restores its self-layer paint; `reconcile()` then
  // builds every node again from scratch, on WebGL, with NEW canvas elements.
  const handleDeviceLost = (): void => {
    if (disposed || backend?.kind !== "webgpu") return;
    for (const binding of bindings.values()) disposeBinding(binding);
    bindings.clear();
    fallbackToWebgl("device-lost");
    reconcile();
  };

  // The PENDING resolution: await the device, then its programs, then adopt — or fall back with
  // whatever `../webgpu/device` classified the failure as. A runtime disposed while this was in
  // flight does nothing at all.
  const resolveWebgpu = async (): Promise<void> => {
    const shared = await acquireWebgpuDevice();
    if (disposed) return;
    if (!shared) {
      fallbackToWebgl(webgpuFallbackReason() ?? "no-adapter");
      return;
    }
    const gpu = await createWebgpuShaderBackend(shared, { maxTextureDim });
    if (disposed) return;
    if (!gpu) {
      fallbackToWebgl(webgpuFallbackReason() ?? "pipeline-error");
      return;
    }
    adoptWebgpu(shared, gpu);
  };

  const openGate = (): void => {
    const wanted = options.effectsRenderer ?? "auto";
    if (wanted === "webgl") {
      // Adopted DIRECTLY, not through `fallbackToWebgl`: nothing was ever asked for, so nothing
      // fell back, and `webgpuFallbacks` stays 0 — which is how a pinned reference arm reads as one.
      backend = glBackend;
      return;
    }
    if (!hasWebgpuApi()) {
      fallbackToWebgl("no-navigator-gpu");
      return;
    }
    const device = peekWebgpuDevice();
    if (device === null) {
      // Already tried and unavailable (or poisoned by an earlier device loss) — no second probe.
      fallbackToWebgl(webgpuFallbackReason() ?? "no-adapter");
      return;
    }
    if (device === undefined) {
      gatePromise = resolveWebgpu();
      return;
    }
    const gpu = peekWebgpuShaderBackend(device, { maxTextureDim });
    if (gpu) {
      adoptWebgpu(device, gpu);
      return;
    }
    if (gpu === null) {
      fallbackToWebgl(webgpuFallbackReason() ?? "pipeline-error");
      return;
    }
    // Device in hand, device-scope state still being built (this runtime is the second one on the
    // page, in the same turn as the first): finish asynchronously.
    gatePromise = resolveWebgpu();
  };
  openGate();

  // The binding at `node`, or the first one UNDER it — a host that owns a subtree should not have to
  // know which of its descendants gsw bound (the `invalidateStaticSurfaces` convention).
  const bindingAt = (node: HTMLElement): NodeBinding | null => {
    const exact = bindings.get(node);
    if (exact) return exact;
    for (const binding of bindings.values()) {
      if (node.contains(binding.node)) return binding;
    }
    return null;
  };

  // ONE binding's pixels, through its backend's capture hook. The body of the handle's
  // `captureNodePixels` (which is now this plus a `bindingAt` lookup), factored out because the
  // frozen-surface image swap needs the SAME production for a WebGPU binding it cannot read: the
  // hook re-renders the binding's current frame into an offscreen texture and copies it back, which
  // is the only sanctioned way pixels leave a WebGPU canvas (`../webgpu/readback`).
  //
  // Null on WebGL (its `captureSurface` is absent — that canvas holds readable 2D pixels), on a
  // zero-sized backing store, and on any capture the device refuses. PER BINDING, not per runtime: a
  // screen-texture node under a WebGPU runtime renders on WebGL and answers null, honestly.
  const captureBindingPixels = async (
    binding: NodeBinding,
  ): Promise<Uint8Array | null> => {
    const capture = binding.backend.captureSurface;
    if (!capture) return null;
    if (binding.canvas.width < 1 || binding.canvas.height < 1) return null;
    // The SAME time the render paths use, so what is captured is the frame the canvas is showing and
    // not a second interpretation of the same state. Rects served from the cache (refreshed here if
    // stale) exactly as `renderBindingNow` does, since a SCREEN_UV shader reads them.
    refreshRects();
    const time = staticShaders ? staticTime : nowSeconds();
    return capture(binding, time, staticShaders, getRootRect);
  };

  // Live resolution retune (adaptive quality): change the backing-store pixel ratio and re-size every
  // node canvas to match, then re-render. The shared backbuffer is grow-only so a SMALLER ratio never
  // shrinks it (cheap); the per-binding `syncCanvasSize` reuses each cached box (the box is unchanged by a
  // ratio step), so a retune no longer forces a per-binding reflow.
  const setRenderScale = (scale: number): void => {
    if (disposed) return;
    const next = effectivePixelRatio(scale);
    if (next === pixelRatio) return;
    pixelRatio = next;
    // PINNED + frozen: the pin, not the scale, decides the backing store, so there is nothing to
    // re-size and nothing to re-dirty — which is the point. Re-sizing here would clear every frozen
    // canvas and change every static-frame cache key, i.e. re-render the whole static set on a
    // device that is stepping quality DOWN. The new `pixelRatio` is still recorded above, so live
    // bindings get it as soon as frozen mode is left (or the pin is cleared).
    if (pinnedRatio() !== undefined) return;
    for (const binding of bindings.values()) {
      syncCanvasSizeOrDefer(binding);
      // A runtime-wide re-size changes every frozen frame key. That is the runtime's own decision,
      // not this node churning, so the swap is undone WITHOUT blocking — the binding re-earns the
      // stability gate rather than being disqualified by an adaptive-quality step.
      revertStaticImage(binding, runtimeStats);
      binding.dirty = true;
    }
    scheduleRender();
  };

  // Live set/clear of the frozen-mode pin. Takes effect immediately when the runtime is ALREADY
  // frozen (every binding re-sizes to the new pinned ratio and re-renders); otherwise it is just
  // recorded and applied by the next `setStaticShaders(true)`.
  const setStaticShaderPixelRatio = (ratio: number | undefined): void => {
    if (disposed) return;
    const next = normalizeStaticPixelRatio(ratio);
    if (next === staticPixelRatio) return;
    staticPixelRatio = next;
    if (!staticShaders) return;
    for (const binding of bindings.values()) {
      syncCanvasSizeOrDefer(binding);
      revertStaticImage(binding, runtimeStats); // same reasoning as setRenderScale
      binding.dirty = true;
    }
    scheduleRender();
  };

  // Live FPS-cap retune. 0/undefined → uncapped. A change just re-kicks the loop so a now-lower cap
  // takes effect (or a raised one resumes animation that had self-stopped).
  const setFps = (fps: number): void => {
    if (disposed) return;
    minFrameTime = fps > 0 ? 1 / fps : 0;
    // A pending park targets the OLD cap boundary — drop it so the new cap arms from here.
    pacer.cancelPark();
    scheduleRender();
  };

  // Live frozen-TIME toggle (adaptive quality): entering static renders a single frozen frame per binding then
  // self-stops; leaving it re-dirties every binding so the animation loop restarts (a usesTime shader re-arms
  // `animated`). A no-op if already in the requested mode.
  const setStaticShaders = (value: boolean): void => {
    if (disposed || value === staticShaders) return;
    staticShaders = value;
    // With a pin configured, the mode flip IS a backing-store change (pinned ratio ⇄ live
    // devicePixelRatio × renderScale), so each binding re-sizes here. With no pin the effective
    // ratio is identical in both modes and no sizing pass runs at all — as before.
    const resize = staticPixelRatio !== undefined;
    for (const binding of bindings.values()) {
      if (resize) syncCanvasSizeOrDefer(binding);
      // Leaving frozen mode: the shader animates again, so the still `<img>` must come down NOW
      // rather than at the next tick (which a parked/occluded binding may not reach). Entering it:
      // nothing is swapped yet, so this is a no-op.
      revertStaticImage(binding, runtimeStats);
      binding.dirty = true;
    }
    // The cap does not apply in frozen mode (and a resume wants the full rate back), so a park
    // armed under the previous mode is stale.
    pacer.cancelPark();
    scheduleRender();
  };

  // Live kill switch for the frozen-surface image swap. OFF disposes the swapper: every live swap
  // reverts, every object URL is released and every timer is cancelled immediately (the state
  // objects are dropped, so every swap call site goes back to being a no-op). ON builds a fresh
  // swapper under the runtime's CONFIGURED policy — the boolean is a switch, never a policy — and
  // each binding must earn its swap again.
  const setStaticShaderImages = (value: boolean): void => {
    if (disposed || value === (surfaceSwapper !== null)) return;
    if (!value) {
      // Revert BEFORE the swapper goes: a revert un-hides the canvas and books the counter, while
      // the disposal that follows only drops state (a torn-down surface is gone, not handed back).
      for (const binding of bindings.values()) {
        revertStaticImage(binding, runtimeStats);
      }
      surfaceSwapper?.dispose();
      surfaceSwapper = null;
      return;
    }
    surfaceSwapper = createStaticSurfaceSwapper(
      staticSurfacePolicy,
      runtimeStats,
    );
    for (const binding of bindings.values()) {
      surfaceSwapper?.attach(binding);
      // Fresh state knows no frame key (only a render can name one), so the binding is re-dirtied
      // — in frozen mode that is a cache-hit blit, not a GL draw — and the gate starts from the
      // key that render reports. Without this a runtime switched ON after its set had already
      // rendered could never swap anything.
      binding.dirty = true;
    }
    scheduleRender();
  };

  // Host-driven revert-without-block (see `WebglShaderRuntime.invalidateStaticSurfaces`). With no
  // argument the swapper hands its whole set back; with elements, every binding AT or UNDER one of
  // them — a host that owns a subtree should not have to know which of its descendants gsw bound.
  const invalidateStaticSurfaces = (nodes?: Iterable<HTMLElement>): void => {
    if (disposed || !surfaceSwapper) return;
    if (!nodes) {
      surfaceSwapper.invalidate();
      return;
    }
    const targets: NodeBinding[] = [];
    for (const element of nodes) {
      const exact = bindings.get(element);
      if (exact) {
        targets.push(exact);
        continue;
      }
      for (const binding of bindings.values()) {
        if (element.contains(binding.node)) targets.push(binding);
      }
    }
    if (targets.length > 0) surfaceSwapper.invalidate(targets);
  };

  /**
   * See `WebglShaderRuntime.warmPrograms`. Deliberately built out of the SAME two calls the create path makes —
   * `resolveExpandedShaderSource` then `getProgramAsync` — so a warmed shader and a lazily-created one cannot
   * diverge, and so both dedupe through the same two in-flight maps whichever gets there first.
   *
   * SEQUENTIAL, not `Promise.all`. Each link is a blocking `finish()` on a device without
   * `KHR_parallel_shader_compile`, and firing them together would concatenate those blocks into one long task —
   * the exact shape being moved off the frame path. One at a time leaves a gap for anything else to run in.
   */
  const warmPrograms = async (
    specs: Iterable<WebglWarmSpec>,
  ): Promise<number> => {
    let warmed = 0;
    for (const spec of specs) {
      if (disposed) break;
      // A cached program is already the answer, and asking for its source again would be a fetch for nothing.
      if (
        programCache.get(programCacheKey(spec.shaderKey, enableScreenCapture))
      ) {
        warmed++;
        continue;
      }
      let source: string | undefined;
      try {
        source = await resolveExpandedShaderSource(
          spec.shaderKey,
          spec.path,
          spec.uid,
          resolveShaderSource,
        );
      } catch {
        source = undefined;
      }
      // A miss is not an error: warming is an optimisation, and the node that wants this shader later takes
      // exactly the path it takes today, including reporting its own unsupported-render if it comes to that.
      if (source === undefined || disposed) continue;
      const program = await getProgramAsync(
        gl,
        spec.shaderKey,
        source,
        options.onUnsupported,
        enableScreenCapture,
      );
      if (program) warmed++;
    }
    return warmed;
  };

  const dispose = (): void => {
    disposed = true;
    pacer.cancel();
    // Stop listening for a device loss this runtime can no longer act on (the subscription is
    // page-wide and would otherwise outlive every binding it exists to rebuild).
    unsubscribeDeviceLost?.();
    unsubscribeDeviceLost = null;
    if (dormantSweepTimer !== null) {
      clearTimeout(dormantSweepTimer);
      dormantSweepTimer = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", onWindowResize);
    }
    for (const binding of bindings.values()) disposeBinding(binding);
    // After every binding has released its URL ref: cancels the swapper's gate/watchdog/encode
    // timers, so a disposed runtime leaves nothing armed.
    surfaceSwapper?.dispose();
    surfaceSwapper = null;
    bindings.clear();
    observedBindings.clear();
    sharedObserver?.disconnect();
    pending.clear();
    // A create that landed in the same task as this dispose still has its sizing queued; the drain
    // checks `disposed` too, but dropping the references here keeps a disposed runtime from pinning
    // every binding it just tore down until the microtask runs.
    awaitingFirstSize.length = 0;
  };

  return {
    reconcile,
    setRenderScale,
    setStaticShaderPixelRatio,
    setFps,
    setStaticShaders,
    setStaticShaderImages,
    invalidateStaticSurfaces,
    warmPrograms,
    stats: () => {
      // The two GAUGES among the counters, sampled on read: object URLs alive MODULE-wide (across
      // every runtime in the document — the leak probe), and surfaces swapped right now in THIS
      // runtime. The live count is re-derived from the swapper rather than trusted incrementally, so
      // the "is it engaged?" measurement (72/72) cannot drift if a revert path is ever missed.
      runtimeStats.staticImageUrlsLive = liveStaticImageUrlCount();
      runtimeStats.staticImagesLive = surfaceSwapper?.liveSwapCount() ?? 0;
      // The still pool's two gauges, on the same contract and DOCUMENT-wide for the same reason
      // (the pool is shared by every swapper in the page). Nothing tells a runtime when the pool
      // evicts, so they are read here rather than tracked — and left unsampled they would report 0
      // forever, which a dashboard cannot tell from "the budget is off".
      const stillPool = staticStillPoolStats();
      runtimeStats.staticStillRetainedEntries = stillPool.entries;
      runtimeStats.staticStillRetainedBytes = stillPool.bytes;
      // The renderer gauge, re-derived rather than remembered: a runtime can change backend once
      // (WebGPU → WebGL, on a device loss), and "pending" is a state a reader must be able to see.
      runtimeStats.renderer = backend?.kind ?? "pending";
      runtimeStats.webgpuFallbackReason = fallbackReason;
      // Counters that live on the BACKEND (submits) and on the page-wide DEVICE (losses, errors),
      // sampled here so a fallback leaves the last real reading standing instead of zeroing it.
      const submits = gpuBackend?.submits();
      if (submits !== undefined) runtimeStats.webgpuSubmits = submits;
      if (gpuShared) {
        runtimeStats.webgpuDeviceLosses = gpuShared.counters.deviceLosses;
        runtimeStats.webgpuErrors = gpuShared.counters.gpuErrors;
      }
      return runtimeStats;
    },
    captureNodePixels: async (
      node: HTMLElement,
    ): Promise<Uint8Array | null> => {
      if (disposed) return null;
      const binding = bindingAt(node);
      if (!binding) return null;
      return captureBindingPixels(binding);
    },
    dispose,
  };
}

function createBinding(
  // The renderer this binding will draw through. It decides the node canvas's context type (a
  // canvas can hold exactly ONE for its lifetime) and resolves the textures the shader samples;
  // every other line here is DOM work that no renderer changes.
  backend: ShaderRenderBackend,
  root: HTMLElement,
  node: HTMLElement,
  selfLayer: HTMLElement,
  url: string | null,
  shaderKey: string,
  program: CompiledProgram,
): NodeBinding | null {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-godot-shader-canvas", "true");
  // NB: no `inset:0` — the window placement sets left/top/width/height (full-bleed by default, a sub-rect when
  // the node overflows the viewport), and inset's right/bottom would fight an explicit width/height.
  Object.assign(canvas.style, {
    position: "absolute",
    pointerEvents: "none",
  });
  const windowAttr = selfLayer.getAttribute("data-godot-shader-uv-window");
  const uvWindow = parseWindow(windowAttr);
  placeCanvasWindow(canvas, uvWindow);
  // The host's magnification for this surface, read at create so the FIRST sizing already has it —
  // a binding that had to discover it on a later sweep would allocate once at the wrong density and
  // then re-allocate, which for a freeze-at-mount surface is the difference between claiming a
  // cached still and minting a new one. An attribute read, not a layout read: it costs nothing here.
  const pixelRatioAttr = selfLayer.getAttribute(SURFACE_PIXEL_RATIO_ATTR);
  // No context ⇒ no binding, before ANY of the DOM mutation below: the node keeps its CSS/SVG
  // paint, exactly as when this was a bare `getContext("2d")`.
  const surface = backend.createSurface({
    canvas,
    node,
    selfLayer,
    textureUrl: url,
    program,
    shaderKey,
  });
  if (!surface) return null;
  // The canvas replaces the node's CSS/SVG paint with the live shader. For a
  // NinePatchRect, the fill's SHAPE (incl. slanted end caps like the doom bar's
  // diagonal end) lives in the `border-image`; the `inset:0` canvas only covers the
  // content box. So: zero the border (box-sizing is border-box → the node keeps its
  // size) so the canvas covers the FULL node, and clip it to the fill's nine-patch
  // alpha via `mask-box-image` (published as `data-godot-shader-fill-mask` — stable,
  // unlike the live border-image which we clear). The live shader then fills the
  // whole segment, caps included, with the diagonal cap; the layer behind (amber
  // HpMiddleground) is covered by the canvas where it paints and by the overlapping
  // neighbour segment / clip Mask elsewhere.
  const fillMask = selfLayer.getAttribute("data-godot-shader-fill-mask");
  if (fillMask) {
    canvas.style.setProperty("-webkit-mask-box-image", fillMask);
    canvas.style.setProperty("mask-box-image", fillMask);
  }
  const loadingFallback = hasLoadingFallback(selfLayer);
  if (!loadingFallback) {
    selfLayer.style.backgroundImage = "none";
  } else {
    selfLayer.setAttribute("data-godot-shader-loading", "1");
  }
  selfLayer.style.borderImageSource = "none";
  selfLayer.style.filter = "none";
  selfLayer.style.borderWidth = "0";
  selfLayer.insertBefore(canvas, selfLayer.firstChild);

  // Honor the shader's render_mode blend via a CSS mix-blend-mode on the NODE element. It must be the node, not
  // the canvas: the canvas lives inside the node's own transform stacking context, so a canvas-level blend
  // can't reach the DOM painted behind the node. An additive shader (blend_add, e.g. card_ripple's frame glow)
  // then adds to the content behind instead of compositing source-over (which would wash it into a flat sheet).
  node.style.mixBlendMode = blendToMixBlendMode(program.blend);

  // Capture the raw data-attr strings so `reconcile`'s updateBinding can detect a real
  // change with a cheap string compare (no re-parse, no layout) on a kept binding.
  const paramsAttr = node.getAttribute("data-godot-shader-params");
  const paramKindsAttr = node.getAttribute("data-godot-shader-param-kinds");
  const modulateAttr = node.getAttribute("data-godot-shader-modulate");
  const samplersAttr = node.getAttribute("data-godot-shader-samplers");
  const samplerUrlsAttr = node.getAttribute("data-godot-shader-sampler-urls");
  const textureRegionAttr = selfLayer.getAttribute("data-godot-atlas-region");
  const textureRepeatAttr = node.getAttribute("data-godot-texture-repeat");

  // Born dormant? Then the canvas starts hidden and the create-time `syncCanvasSize` — the forced
  // `clientWidth`/`clientHeight` layout this contract exists to skip — is deferred to the wake.
  const dormant = isShaderDormant(node);
  if (dormant) {
    canvas.style.display = "none";
  }

  const params = parseParams(paramsAttr);
  const paramKinds = parseParamKinds(paramKindsAttr);
  const modulate = parseModulate(modulateAttr);

  const binding: NodeBinding = {
    node,
    shaderKey,
    selfLayer,
    root,
    backend,
    canvas,
    ctx2d: surface.ctx2d,
    program,
    texture: surface.texture,
    textureRepeat: nodeTextureRepeats(node),
    textureRegion: parseAtlasRegion(textureRegionAttr),
    samplers: surface.samplers,
    fit: backgroundFit(selfLayer),
    params,
    paramKinds,
    modulate,
    paramsKey: paramsFrameKey(params),
    paramKindsKey: paramKindsFrameKey(paramKinds),
    modulateKey: modulateFrameKey(modulate),
    windowKey: windowFrameKey(uvWindow),
    window: uvWindow,
    windowAttr,
    pixelRatioScale: parseSurfacePixelRatio(pixelRatioAttr),
    pixelRatioAttr,
    boxW: 0,
    boxH: 0,
    boxMeasured: false,
    textureLoadDisposers: [],
    staticKeyEpoch: 0,
    staticKeyMemo: null,
    loadingFallback,
    loadingFallbackCleared: false,
    dirty: true,
    suspended: isEffectsSuspended(node),
    dormant,
    canvasSyncDeferred: dormant,
    dormantSeq: 0,
    layerRect: null,
    paramsAttr,
    paramKindsAttr,
    modulateAttr,
    samplersAttr,
    samplerUrlsAttr,
    textureUrl: url,
    backgroundImageStyle: null,
    backgroundImageParsed: null,
    textureRegionAttr,
    textureRepeatAttr,
    screenCapture: null,
    // The runtime's swapper fills this in right after `createBinding`, when one exists.
    staticImage: null,
    // Nothing painted yet, so this canvas holds no named frame.
    lastStaticKey: null,
  };
  // NOTHING IS MEASURED HERE. This function is now pure MUTATION: the caller queues the binding's
  // first sizing (`queueFirstSize`) so a burst of creates measures in ONE contiguous run instead of
  // one write→read interleave — and one forced style+layout flush — per node. The canvas is
  // unsized until that drain, which no frame can observe: the drain is a microtask and rAF cannot
  // run before the microtask queue empties.
  // The runtime observes this binding through its ONE shared ResizeObserver (see `observeBinding`).
  return binding;
}

function hasLoadingFallback(selfLayer: HTMLElement): boolean {
  return selfLayer.getAttribute("data-godot-shader-loading-fallback") === "1";
}

function clearLoadingFallbackIfReady(binding: NodeBinding): void {
  if (
    !binding.loadingFallback ||
    binding.loadingFallbackCleared ||
    !texturesLoaded(binding)
  ) {
    return;
  }

  binding.loadingFallbackCleared = true;
  clearLoadingFallbackStyles(binding.selfLayer);
}

function clearLoadingFallbackStyles(selfLayer: HTMLElement): void {
  if (
    !hasLoadingFallback(selfLayer) &&
    !selfLayer.hasAttribute("data-godot-shader-loading")
  ) {
    return;
  }
  selfLayer.removeAttribute("data-godot-shader-loading");
  selfLayer.removeAttribute("data-godot-shader-loading-fallback");
  selfLayer.style.background = "none";
  selfLayer.style.backgroundImage = "none";
  selfLayer.style.backgroundColor = "";
  selfLayer.style.clipPath = "";
  selfLayer.style.borderRadius = "";
}

// The tightest of the longest-edge ceilings that apply (the pinned-static cap, the backend's own),
// or undefined when neither does — which is the un-pinned WebGL case, i.e. every consumer before
// WebGPU existed, and must stay indistinguishable from it.
function backingDimLimit(
  ...limits: Array<number | undefined>
): number | undefined {
  let out: number | undefined;
  for (const limit of limits) {
    if (limit === undefined || limit <= 0) continue;
    out = out === undefined ? limit : Math.min(out, limit);
  }
  return out;
}

// THE SIZING. Its inputs, in full, so the contract is readable in one place:
//
//   BOX     — the self-layer's content-box in CSS px, from the cheapest tier that can answer (below).
//   WINDOW  — `binding.window`'s du/dv: the canvas covers only that sub-rect of the box.
//   DENSITY — `dpr` (the runtime-wide term: the live `devicePixelRatio × renderScale`, or the frozen
//             `staticShaderPixelRatio` pin, decided by the caller) TIMES `binding.pixelRatioScale`,
//             this ONE surface's magnification as the host stated it (`SURFACE_PIXEL_RATIO_ATTR`).
//             The two compose rather than replace: the pin answers "how dense should a frozen
//             surface be on this device", the attribute answers "how much of the screen does THIS
//             surface actually cover", and a frozen magnified surface needs both. An un-stamped
//             binding carries exactly `1`, so its density is the bare `dpr` it always was.
//   MAXDIM  — the longest-edge ceiling, on the pinned path only.
//
// Deliberately NOT an input: the page's live fit/zoom transform. The box tiers above are all
// layout-space reads (`clientWidth`, the observer's `contentRect`), which do not move when an
// ancestor's CSS transform does — so folding a live fit in here would make every backing store
// churn on a resize that changed no layout at all. The host's attribute is the transform-aware
// term, and it is stamped at rest for that reason.
function syncCanvasSize(
  binding: NodeBinding,
  dpr: number,
  contentRect?: { width: number; height: number },
  stats?: WebglShaderRuntimeStats,
  // Longest-edge ceiling for the resulting backing store, passed ONLY on the pinned static path
  // (see `staticShaderPixelRatio`). Undefined ⇒ unbounded, which is what the live path always was.
  maxDim?: number,
): void {
  // Box (content-box) size, in priority order that AVOIDS a forced reflow after creation:
  //   1. the ResizeObserver-provided contentRect (already measured off the main path — no reflow), else
  //   2. the box we last measured (a WINDOW-only change or a renderScale step doesn't move the box, so its
  //      size is still valid — reusing it is what keeps those paths reflow-free), else
  //   3. a single clientWidth/Height layout read — only when nothing has measured this binding yet, which
  //      the runtime pays ONCE per create, in a batched measure pass (see `drainFirstSizes`).
  // Shader self-layers are full-bleed with no padding, so content-box width == clientWidth. The chosen size is
  // cached so the next window/renderScale resize can reuse it; the observer refreshes it on any real box change.
  let boxW: number;
  let boxH: number;
  if (contentRect) {
    boxW = contentRect.width;
    boxH = contentRect.height;
  } else if (binding.boxMeasured) {
    boxW = binding.boxW;
    boxH = binding.boxH;
  } else {
    boxW = binding.selfLayer.clientWidth;
    boxH = binding.selfLayer.clientHeight;
  }
  binding.boxW = boxW;
  binding.boxH = boxH;
  // Whatever tier answered, this binding now HAS a box (see `NodeBinding.boxMeasured`) — including a 0x0 one,
  // which is a real answer about a hidden/rect-less node and not a reason to re-read the layout forever.
  binding.boxMeasured = true;
  // The canvas covers only the window SUB-RECT of the self-layer (full node), so its backing store is the
  // box size scaled by the window's du/dv — a clamped background renders far fewer pixels.
  const cssW = boxW * binding.window[2];
  const cssH = boxH * binding.window[3];
  // (The applied `ratio` this also returns is only meaningful to a caller that draws geometry in CSS
  // px × ratio — the particle runtime. A shader fills its canvas from a clip-space quad, so only the
  // aspect matters here, and the clamp preserves it.)
  const { w, h } = backingStoreSize(
    cssW,
    cssH,
    dpr * binding.pixelRatioScale,
    maxDim,
  );
  const wChanged = binding.canvas.width !== w;
  const hChanged = binding.canvas.height !== h;
  if (wChanged) binding.canvas.width = w;
  if (hChanged) binding.canvas.height = h;
  // Re-assigning width/height REALLOCATES (and clears) the backing store — count one realloc EVENT
  // per call that actually re-assigned; a same-size sync costs (and counts) nothing.
  if (wChanged || hChanged) {
    // Canvas dimensions are part of the frame's pixel domain.  The assignment also clears the
    // backing store, so a memo hit here would be wrong even if a later writer restored the old
    // dimensions before the next render.
    invalidateStaticFrameKey(binding);
    if (stats) stats.canvasReallocs++;
  }
}

/** TEST ONLY: drive `syncCanvasSize` (box caching → no post-create reflow) without a WebGL2 context, which
 *  jsdom lacks (the real runtime is a no-op there, so the binding path is otherwise untestable). */
export function syncCanvasSizeForTest(
  binding: NodeBinding,
  dpr: number,
  contentRect?: { width: number; height: number },
): void {
  syncCanvasSize(binding, dpr, contentRect);
}

/** Does this program need the node's own self-layer rect? (SCREEN_UV's node÷root mapping and the
 *  SCREEN_TEXTURE composite's overlap test both do.) */
function needsLayerRect(program: CompiledProgram): boolean {
  return program.usesScreenUv || program.usesScreenTexture;
}

/** Does this program need ANY viewport rect (adds SCREEN_PIXEL_SIZE, which needs only the root)? */
function readsScreenRect(program: CompiledProgram): boolean {
  return needsLayerRect(program) || program.usesScreenPixelSize;
}

// ---- SCREEN_TEXTURE capture --------------------------------------------------
//
// APPROXIMATION SEMANTICS: Godot's SCREEN_TEXTURE is the real framebuffer of everything
// drawn before the current item. The browser can't read the composited DOM back, so we
// approximate it: walk the scene's self-layer elements in DOM (draw) order UP TO this
// node and `drawImage` the ones that (a) spatially overlap the node's on-screen rect and
// (b) have a drawable source — a runtime <canvas> (an earlier shader/particle node) or an
// already-loaded texture image. Text, gradients, borders, CSS filters/blends and
// background-size fitting are all skipped/simplified (each source is drawn stretched to
// its element rect) — good enough for "distort what's behind me" effects. The composite
// is in VIEWPORT coordinates (the whole root rect, downscaled to `maxScreenCaptureDim`),
// so the shader samples it directly with SCREEN_UV. Refreshes are throttled
// (`SCREEN_CAPTURE_MIN_INTERVAL_S`) and forced on a viewport resize — never per rAF.

// Decoded capture image sources, keyed by url. The GL textureCache holds only uploaded
// GL textures (which drawImage can't read), so the capture path keeps its own
// HTMLImageElement cache; a not-yet-loaded image is skipped until a later refresh.
const captureImageCache = new Map<string, HTMLImageElement>();

function getCaptureImage(url: string): HTMLImageElement | null {
  const cached = captureImageCache.get(url);
  if (cached) return cached;
  if (typeof Image === "undefined") return null;
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = url;
  captureImageCache.set(url, image);
  return image;
}

// A self-layer's drawImage-able paint source, or null (text/plain-color/none — skipped).
function drawableSource(layer: HTMLElement): CanvasImageSource | null {
  // A runtime canvas (an earlier WebGL shader/particle node) already holds the layer's
  // final pixels — blit it directly.
  for (const child of layer.children) {
    if (!(child instanceof HTMLCanvasElement)) continue;
    // …EXCEPT a WebGPU-backed one. `drawImage` from a WebGPU canvas is never a source here: it comes
    // back BLANK on SwiftShader and is pathologically slow on Android Chrome (measured — S7 in
    // docs/perf-harness.md, where the blit-shaped WebGPU arm collapsed 87 → 23 Hz). Skipping it
    // falls through to the layer's texture image below: a worse approximation of an already
    // approximate composite, which beats a blank hole and a stalled GPU process. Only a WebGPU
    // backend ever stamps this attribute; the GL backend does not.
    if (child.getAttribute("data-godot-effects-backend") === "webgpu") continue;
    return child;
  }
  const url =
    layer.getAttribute("data-godot-shader-texture-url") ||
    backgroundImageUrl(layer);
  if (!url) return null;
  const image = getCaptureImage(url);
  return image?.complete && image.naturalWidth > 0 ? image : null;
}

// Composite the content drawn BEFORE this node (see the approximation note above) onto
// the capture canvas, in root-viewport coordinates scaled to the canvas size.
function compositeScreenContent(
  binding: NodeBinding,
  rootRect: ViewportRect,
  state: ScreenCaptureState,
): void {
  const { ctx, canvas } = state;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sx = canvas.width / Math.max(1, rootRect.width);
  const sy = canvas.height / Math.max(1, rootRect.height);
  // The node's own rect comes from the cache (the per-layer rects below are unavoidable, but this
  // whole composite is throttled to SCREEN_CAPTURE_MIN_INTERVAL_S — never per rAF).
  const nodeRect = layerRect(binding);
  const nodeRight = nodeRect.left + nodeRect.width;
  const nodeBottom = nodeRect.top + nodeRect.height;
  const layers = binding.root.querySelectorAll<HTMLElement>(
    `.${SELF_LAYER_CLASS}`,
  );
  for (const layer of layers) {
    // Draw order stops at the node's own subtree: SCREEN_TEXTURE sees only content
    // painted BEFORE it (and never feeds the node's own output back into itself).
    if (layer === binding.selfLayer || binding.node.contains(layer)) break;
    const rect = layer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue; // hidden/empty
    if (
      rect.right <= nodeRect.left ||
      rect.left >= nodeRight ||
      rect.bottom <= nodeRect.top ||
      rect.top >= nodeBottom
    ) {
      continue; // no spatial overlap with the node's screen rect
    }
    const source = drawableSource(layer);
    if (!source) continue;
    try {
      ctx.drawImage(
        source,
        (rect.left - rootRect.left) * sx,
        (rect.top - rootRect.top) * sy,
        rect.width * sx,
        rect.height * sy,
      );
    } catch {
      // A detached/zero-sized source must not kill the node's render.
    }
  }
}

// Ensure + (throttled) refresh the binding's screen capture, returning it for the draw.
// A viewport resize forces an immediate recapture; otherwise a refresh happens at most
// every SCREEN_CAPTURE_MIN_INTERVAL_S (the throttle is wall-clock, independent of the
// shader TIME, so frozen-TIME mode still captures once).
function captureScreenTexture(
  sharedGl: SharedGl,
  binding: NodeBinding,
  rootRect: ViewportRect,
  maxDim: number,
): ScreenCaptureState | null {
  if (typeof document === "undefined") return null;
  const { gl } = sharedGl;
  const rw = Math.max(1, rootRect.width);
  const rh = Math.max(1, rootRect.height);
  const scale = Math.min(1, maxDim / Math.max(rw, rh));
  const cw = Math.max(1, Math.round(rw * scale));
  const ch = Math.max(1, Math.round(rh * scale));
  let state = binding.screenCapture;
  if (!state) {
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const texture = createWebglTexture(gl);
    if (!texture) return null;
    state = {
      canvas,
      ctx,
      texture,
      capturedAt: Number.NEGATIVE_INFINITY,
      width: cw,
      height: ch,
    };
    binding.screenCapture = state;
  }
  const resized = state.width !== cw || state.height !== ch;
  if (
    !resized &&
    nowSeconds() - state.capturedAt < SCREEN_CAPTURE_MIN_INTERVAL_S
  ) {
    return state; // throttled: the previous composite/texture is reused as-is
  }
  if (resized) {
    state.canvas.width = cw;
    state.canvas.height = ch;
    state.width = cw;
    state.height = ch;
  }
  state.capturedAt = nowSeconds();
  compositeScreenContent(binding, rootRect, state);
  uploadWebglTexture(gl, state.texture, state.canvas);
  return state;
}

// ---- DOM/attribute readers -------------------------------------------------

function backgroundImageUrl(el: HTMLElement): string | null {
  const value = el.style.backgroundImage;
  const match = /url\((['"]?)(.*?)\1\)/.exec(value);
  return match ? match[2] : null;
}

// Per-binding memo of the above: `updateBinding` runs for EVERY kept binding on EVERY reconcile,
// and the paint almost never changes, so the regex over a (possibly long, data-URI) background
// string was pure repeat work. Keyed on the raw style string, so a hit is exactly what a re-parse
// would have produced.
function memoizedBackgroundImageUrl(
  binding: NodeBinding,
  el: HTMLElement,
): string | null {
  const raw = el.style.backgroundImage;
  if (raw === binding.backgroundImageStyle) {
    return binding.backgroundImageParsed;
  }
  binding.backgroundImageStyle = raw;
  binding.backgroundImageParsed = backgroundImageUrl(el);
  return binding.backgroundImageParsed;
}

// Map a Godot canvas_item render_mode blend to the closest CSS mix-blend-mode. `add` → `plus-lighter` (true
// additive), `mul` → `multiply`. `mix` (default) plus `sub`/`premul_alpha` (no clean CSS equivalent) → `""`
// (normal source-over), which also clears any blend a previously-cached shader left on a reused node element.
export function blendToMixBlendMode(blend: GodotBlendMode): string {
  switch (blend) {
    case "add":
      return "plus-lighter";
    case "mul":
      return "multiply";
    default:
      return "";
  }
}

function backgroundFit(el: HTMLElement): "contain" | "cover" | "fill" {
  const size = el.style.backgroundSize;
  if (size === "contain") return "contain";
  if (size === "cover") return "cover";
  return "fill";
}

export type ShaderParamValue = number | number[];

function parseParams(value: string | null): Record<string, ShaderParamValue> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function parseParamKinds(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      if (typeof raw === "string" && raw !== "") out[key] = raw;
    }
    return out;
  } catch {
    return {};
  }
}

function parseModulate(value: string | null): [number, number, number, number] {
  if (!value) return [1, 1, 1, 1];
  const parts = value.split(",").map((p) => Number.parseFloat(p.trim()));
  return [parts[0] ?? 1, parts[1] ?? 1, parts[2] ?? 1, parts[3] ?? 1];
}

const FULL_WINDOW: [number, number, number, number] = [0, 0, 1, 1];

// Parse the `data-godot-shader-uv-window` attr ("u0,v0,du,dv", node-local top-left fractions) into a clamped
// sub-rect, defaulting to the full node on absence/garbage.
function parseWindow(value: string | null): [number, number, number, number] {
  if (!value) return [...FULL_WINDOW];
  const p = value.split(",").map((s) => Number.parseFloat(s.trim()));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n)))
    return [...FULL_WINDOW];
  const u0 = Math.min(Math.max(p[0], 0), 1);
  const v0 = Math.min(Math.max(p[1], 0), 1);
  const du = Math.min(Math.max(p[2], 0), 1 - u0);
  const dv = Math.min(Math.max(p[3], 0), 1 - v0);
  return [u0, v0, du > 0 ? du : 1, dv > 0 ? dv : 1];
}

function isFullWindow(w: readonly number[]): boolean {
  return w[0] <= 0.0005 && w[1] <= 0.0005 && w[2] >= 0.9995 && w[3] >= 0.9995;
}

// Position the per-node canvas over the window sub-rect within the (always full-size) self-layer. Full window
// ⇒ full-bleed (the common case); a sub-rect ⇒ a smaller canvas so its (blend-mode) main-thread paint covers
// only the visible region, not the off-screen overflow.
function placeCanvasWindow(
  canvas: HTMLCanvasElement,
  w: readonly number[],
): void {
  if (isFullWindow(w)) {
    Object.assign(canvas.style, {
      left: "0",
      top: "0",
      width: "100%",
      height: "100%",
    });
  } else {
    Object.assign(canvas.style, {
      left: `${w[0] * 100}%`,
      top: `${w[1] * 100}%`,
      width: `${w[2] * 100}%`,
      height: `${w[3] * 100}%`,
    });
  }
}
