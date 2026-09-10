// The RENDER-BACKEND seam of the shader runtime (`./runtime`), plus its WebGL implementation.
//
// WHY: the runtime is ~95% renderer-agnostic lifecycle machinery — reconcile, dormancy, occlusion,
// sizing, the rect cache, the frozen-surface image swap, the loop and its pacing. The
// renderer-specific surface is narrow and provable: give a node canvas a context, resolve the
// textures the shader samples, draw one frame. That surface is `ShaderRenderBackend`; everything
// below it is today's `renderNode` + the GL half of `createBinding`, MOVED here unchanged. A
// second (WebGPU) implementation then lands as a peer instead of a fork of the runtime.
//
// PER-BINDING, not per-runtime: the backend hangs off the BINDING (`NodeBinding.backend`), because
// a shader that cannot run on WebGPU (it samples SCREEN_TEXTURE, or its WGSL transpile failed) must
// fall back to GL BY ITSELF rather than veto the other N canvases. The GL path is per-binding
// self-contained, which is what makes that possible.
//
// WHAT STAYS IN THE RUNTIME: everything that is DOM work or module-scoped cache. Canvas creation,
// styling, window placement, the self-layer insert, the node's mix-blend-mode, the loading-fallback
// suppression, the program cache, the static-frame cache, and the SCREEN_TEXTURE composite (a walk
// of the scene's self-layers with `drawImage` — DOM, not GL). The backend reaches the last three
// through `WebglShaderBackendDeps` so they keep their single home.

import {
  clearWebglSurface,
  deleteWebglTexture,
  drawGodotWebglShaderFrame,
} from "@godot-scene-web/canvas-effects/webgl";
import { noteStaticFrame } from "../surface-image-swap";
import { bakeTexture, type TextureBakeSpec } from "./bake-texture";
import type {
  CompiledProgram,
  NodeBinding,
  SamplerBinding,
  ScreenCaptureState,
  ShaderProfile,
  ViewportRect,
  WebglShaderRuntimeStats,
} from "./runtime";
import {
  ensureSharedDrawSize,
  getBakedTexture,
  getImageTexture,
  getRegionTexture,
  getSolidTexture,
  getTexture,
  nodeTextureRepeats,
  performanceNow,
  type SharedGl,
  type TextureEntry,
} from "./shared-gl";

/** One binding's node surface: the `<canvas>` the runtime created, plus its 2D context — which
 *  exists ONLY on the WebGL backend, whose shared offscreen output is blitted onto it. A WebGPU
 *  backend renders straight into the node canvas (a canvas can hold exactly ONE context type for
 *  its lifetime), so its `ctx2d` is null and every 2D-only feature keys off that. */
export interface ShaderSurface {
  canvas: HTMLCanvasElement;
  ctx2d: CanvasRenderingContext2D | null;
}

/** A sampler's visual source, independent of the backend-specific texture-cache handle.  The
 * frozen-frame key records this alongside dimensions: two same-size URLs or bake specs are not the
 * same pixels, and repeat changes the shader's sampling outside [0,1]. */
export type StaticSamplerIdentity = readonly ["url" | "bake", string, boolean];

/** The structural subset of a texture entry the RUNTIME carries around: enough to size the UV fit
 *  and TEXTURE_PIXEL_SIZE (`width`/`height`), to know whether the real pixels have arrived
 *  (`loaded` — the frozen-frame cache gate and the loading-fallback clear) and to be told when they
 *  do (`listeners`, see `onTextureLoaded`). Deliberately NOT `TextureEntry`: the GPU resource itself
 *  is the backend's business, and a WebGPU entry carries no `WebGLTexture`. The twin of
 *  `ParticleTextureHandle` in `../particles/render-backend`, for the same reason. */
export interface ShaderTextureHandle {
  width: number;
  height: number;
  loaded: boolean;
  listeners: Set<() => void>;
}

/** What resolving a binding's backend-typed textures needs. The url is resolved by the runtime (a
 *  self-layer attribute or the background paint) BEFORE the create suppresses that paint. */
export interface ShaderTextureSpec {
  node: HTMLElement;
  selfLayer: HTMLElement;
  /** Resolved texture url; null ⇒ the solid-white stand-in (the shader supplies its own colour). */
  textureUrl: string | null;
}

/** A create: the texture spec plus the already-created, already-placed node canvas. */
export interface ShaderSurfaceSpec extends ShaderTextureSpec {
  canvas: HTMLCanvasElement;
  program: CompiledProgram;
  /** `uid ?? path` — the shader's identity, the key both the GL program cache and the WebGPU
   *  pipeline cache use. The GL backend has no use for it (it is handed the compiled program); a
   *  backend whose compilation unit is the shader looks its pipeline up by it. */
  shaderKey: string;
}

/** A created surface + the backend-typed textures the binding samples: the node TEXTURE, and the
 *  user sampler uniforms in whatever slots that backend numbers them with (`SamplerBinding.unit`). */
export interface CreatedShaderSurface extends ShaderSurface {
  texture: ShaderTextureHandle;
  samplers: SamplerBinding[];
}

/** The renderer-specific half of the shader runtime. One implementation per graphics API; the
 *  binding decides which one it uses (see the per-binding note above). */
export interface ShaderRenderBackend {
  readonly kind: "webgl" | "webgpu";
  /** Give the node canvas its context and resolve the binding's textures. Null ⇒ no context (the
   *  create is abandoned and the node keeps its CSS/SVG paint, exactly as before). */
  createSurface(spec: ShaderSurfaceSpec): CreatedShaderSurface | null;
  /** Re-resolve the node TEXTURE after a texture-url / atlas-region attribute change. */
  resolveNodeTexture(spec: ShaderTextureSpec): ShaderTextureHandle;
  /** Re-resolve the user sampler uniforms after a sampler attribute change. */
  resolveSamplers(
    node: HTMLElement,
    program: CompiledProgram,
  ): SamplerBinding[];
  /** Release the binding-OWNED backend state (never the shared, cache-owned programs/textures). */
  disposeSurface(binding: NodeBinding): void;
  /** Render one binding's frame. Returns whether this call HANDLED/PRESENTED the binding's current
   *  frame — a real GL draw, a static-frame cache-hit blit, or an unchanged same-canvas cache hit
   *  (see `renderNodeGl`); false only where no frame could be handled (the zero-size /
   *  no-2D-context skips). It is NOT a draw counter — `stats.draws`, `stats.cacheHits`, and
   *  `stats.blitSkips` distinguish the paths. `prof` is the LOOP's
   *  opt-in cost attribution; the out-of-loop anti-flicker render passes null. */
  renderNode(
    binding: NodeBinding,
    time: number,
    staticMode: boolean,
    getRootRect: () => ViewportRect,
    stats?: WebglShaderRuntimeStats,
    prof?: ShaderProfile | null,
  ): boolean;
  /** Bracket the binding loop of ONE tick. No-ops on WebGL (each draw is issued as it comes);
   *  a WebGPU backend opens/submits its single per-tick command encoder here. */
  beginFrame(): void;
  endFrame(): void;
  /** Longest edge this backend can give a node canvas, folded into the sizing law, or undefined for
   *  "the device decides". ABSENT on WebGL, whose shared drawing buffer discovers its own ceiling at
   *  draw time (`ensureSharedDrawSize`) and scales the blit to cover the node anyway; a WebGPU canvas
   *  past `maxTextureDimension2D` simply cannot produce a texture, so it has to be capped up front. */
  maxBackingDim?(): number | undefined;
  /** `queue.submit` calls this backend has made. ABSENT on WebGL, where the question is meaningless
   *  (every draw is its own submission). */
  submits?(): number;
  /** Re-render this binding's CURRENT frame into an offscreen texture and read it back as tightly
   *  packed RGBA (premultiplied, top-down, at the canvas's backing-store size), or null when it
   *  cannot be produced. ABSENT on WebGL — that canvas holds readable 2D pixels, so a caller uses
   *  `getImageData` on it. See `WebglShaderRuntime.captureNodePixels`. */
  captureSurface?(
    binding: NodeBinding,
    time: number,
    staticMode: boolean,
    getRootRect: () => ViewportRect,
  ): Promise<Uint8Array | null>;
}

/** The runtime-owned services the GL backend calls into: the per-runtime option it needs, the
 *  SCREEN_TEXTURE composite, and the module-scoped static-frame cache — all of which stay in
 *  `./runtime` (they are DOM work or shared caches, not GL). */
export interface WebglShaderBackendDeps {
  /** Longest-edge cap for texture uploads (`maxTextureDimension`); undefined ⇒ native size. */
  maxTextureDim: number | undefined;
  /** Ensure + (throttled) refresh this binding's SCREEN_TEXTURE capture, or null when it can't be
   *  built. Called at the one point in the draw where the texture units are still free. */
  captureScreenTexture(
    binding: NodeBinding,
    rootRect: ViewportRect,
  ): ScreenCaptureState | null;
  /** Frozen-mode static-frame cache (module-scoped in the runtime, shared across runtimes and
   *  remounts): the key for this render, an LRU-bumping lookup, and the post-draw snapshot. */
  staticFrameKey(
    binding: NodeBinding,
    w: number,
    h: number,
    time: number,
  ): string;
  lookupStaticFrame(key: string): HTMLCanvasElement | undefined;
  storeStaticFrame(
    key: string,
    source: HTMLCanvasElement,
    w: number,
    h: number,
  ): void;
}

/** The WebGL backend: one shared WebGL2 context draws every node into a shared offscreen buffer,
 *  and each frame is blitted onto the node's own 2D canvas. `shared` is the process-wide context
 *  from `./shared-gl` — the backend owns no context of its own. */
export function createWebglShaderBackend(
  shared: SharedGl,
  deps: WebglShaderBackendDeps,
): ShaderRenderBackend {
  const { gl } = shared;
  return {
    kind: "webgl",
    createSurface(spec) {
      const ctx2d = spec.canvas.getContext("2d");
      if (!ctx2d) return null;
      return {
        canvas: spec.canvas,
        ctx2d,
        texture: resolveNodeTexture(gl, spec, deps.maxTextureDim),
        samplers: resolveSamplers(
          gl,
          spec.node,
          spec.program,
          deps.maxTextureDim,
        ),
      };
    },
    resolveNodeTexture: (spec) =>
      resolveNodeTexture(gl, spec, deps.maxTextureDim),
    resolveSamplers: (node, program) =>
      resolveSamplers(gl, node, program, deps.maxTextureDim),
    disposeSurface(binding) {
      // No gl.deleteTexture/deleteProgram for the sampled textures/program: those are shared
      // module-cache entries reused across nodes/remounts (textureCache/programCache). The
      // SCREEN_TEXTURE capture texture is the one binding-OWNED piece of GL state.
      if (binding.screenCapture) {
        deleteWebglTexture(gl, binding.screenCapture.texture);
        binding.screenCapture = null;
      }
    },
    renderNode: (binding, time, staticMode, getRootRect, stats, prof) =>
      renderNodeGl(
        shared,
        deps,
        binding,
        time,
        staticMode,
        getRootRect,
        stats,
        prof,
      ),
    // GL submits every draw as it is issued, so a tick needs no bracketing.
    beginFrame() {},
    endFrame() {},
  };
}

// Returns whether this call HANDLED/PRESENTED the binding's current frame: true for a real GL draw,
// a static-frame cache-hit blit, and a same-canvas cache hit whose pixels already match. False only
// where no frame could be handled at all — the zero-size and no-2D-context skips. The runtime's
// optional `onBindingRendered` notification keys off this: a consumer that COMPOSITES the canvas
// itself must hear about every handled binding, while `blitSkips` says no pixels changed. See
// `GodotHtmlRuntimeOptions.onBindingRendered`.
function renderNodeGl(
  sharedGl: SharedGl,
  deps: WebglShaderBackendDeps,
  binding: NodeBinding,
  time: number,
  staticMode: boolean,
  getRootRect: () => ViewportRect,
  stats?: WebglShaderRuntimeStats,
  // The LOOP's cost attribution (see `ShaderProfile`), or null/absent — the out-of-loop
  // `renderBindingNow` and every test caller pass nothing and take the un-timed path. Every bracket
  // below sits behind this one null check, so an unprofiled render reads no clock.
  prof: ShaderProfile | null = null,
): boolean {
  const { gl } = sharedGl;
  const w = binding.canvas.width;
  const h = binding.canvas.height;
  if (w < 1 || h < 1) return false;
  // The blit target. Always present on a GL binding (the create fails without it); the null case is
  // the type talking about a WebGPU surface, which this backend never renders into.
  const ctx2d = binding.ctx2d;
  if (!ctx2d) return false;
  // Static-frame cache: in frozen mode, reuse an identical previously-rendered frame and skip the GL draw.
  // Excluded: SCREEN_UV shaders (output depends on on-screen position, not node-local inputs),
  // SCREEN_TEXTURE shaders (output depends on the content drawn behind the node) and not-yet-
  // loaded textures (a placeholder frame must not be cached — the texture-load listener re-renders when ready).
  const cacheable =
    staticMode &&
    !binding.program.usesScreenUv &&
    !binding.program.usesScreenTexture &&
    texturesLoaded(binding);
  let cacheKey: string | null = null;
  if (cacheable) {
    cacheKey = deps.staticFrameKey(binding, w, h, time);
    const hit = deps.lookupStaticFrame(cacheKey);
    if (hit) {
      if (stats) stats.cacheHits++;
      // This target already presents the exact named frame. The key includes backing dimensions and
      // every frozen input, while resize clears the canvas before changing dimensions, so clearing
      // and re-blitting would only spend main-thread fill work. It is still a handled frame: retain
      // the static-frame/swap bookkeeping and let the runtime notify its consumer below.
      if (binding.lastStaticKey === cacheKey) {
        if (stats) stats.blitSkips++;
      } else {
        const hitBlitStart = prof ? performanceNow() : 0;
        ctx2d.clearRect(0, 0, w, h);
        ctx2d.drawImage(hit, 0, 0);
        if (prof) prof.blitMs += performanceNow() - hitBlitStart;
      }
      // The canvas now holds exactly the frame `cacheKey` names — the invariant the image swap's
      // gate (and its revert) needs. See `../surface-image-swap`. The same fact, published to the
      // outside consumer through `GodotEffectRenderInfo.staticKey`: this canvas and the one that
      // really drew hold the SAME pixels, which is what lets a host composite them from one texture.
      binding.lastStaticKey = cacheKey;
      if (binding.staticImage && stats)
        noteStaticFrame(binding, cacheKey, stats);
      // A cache hit is presented/handled and reported as one. A cross-canvas hit wrote pixels; a
      // same-canvas hit confirms that this binding still presents the named frame. In both cases a
      // consumer tracking effect surfaces must hear about it, and `blitSkips` distinguishes the latter.
      return true;
    }
  }
  // GROW-ONLY, VERIFIED: the shared backbuffer only ever grows to the largest node seen (a per-node
  // per-frame realloc was the dominant profiling cost); each node renders into a bottom-left sub-rect
  // (GL origin is bottom-left) and blits just that region. The grow is verified against the ACTUAL
  // drawing buffer (`ensureSharedDrawSize`): the buffer can come back smaller than the attribute (GPU
  // max size, failed realloc keeping the old buffer), and drawing/blitting at the attribute size then
  // reads out-of-bounds → the black band on a node whose backing outgrew the buffer. `vw`×`vh` ≤ w×h
  // is what can really be drawn; the blit below scales it up to the node's full canvas.
  const { vw, vh, bufH } = ensureSharedDrawSize(sharedGl, w, h);

  // GL SUBMIT bucket, first segment: the viewport/clear/program preamble. It stops at the
  // SCREEN_TEXTURE capture below and resumes after it, because that capture is a 2D composite of
  // the DOM plus a texture upload on its OWN ~300 ms throttle — real cost, but not per-frame draw
  // submit, and charging it here would make `glMs` spike on the frames it happens to refresh.
  const glPreambleStart = prof ? performanceNow() : 0;
  clearWebglSurface(gl, vw, vh, true);
  const { program } = binding;
  if (prof) prof.glMs += performanceNow() - glPreambleStart;

  // Refresh the (throttled) SCREEN_TEXTURE capture BEFORE the draw's texture units are
  // bound — the upload binds TEXTURE_2D itself, so it must not clobber unit 0/1..N.
  const screenCapture = program.usesScreenTexture
    ? deps.captureScreenTexture(binding, getRootRect())
    : null;

  // …and the second segment: texture binds, uniform writes, the draw call.
  const glDrawStart = prof ? performanceNow() : 0;
  const fit = uvFit(binding, w, h);
  // The node-local sub-rect this canvas covers (default full); the shader remaps GODOT_UV through it.
  let screenOrigin: [number, number] | undefined;
  let screenSize: [number, number] | undefined;
  let screenPixelSize: [number, number] | undefined;
  if (program.usesScreenUv) {
    const [ox, oy, sx, sy] = screenRect(binding, getRootRect());
    screenOrigin = [ox, oy];
    screenSize = [sx, sy];
  }
  if (program.usesScreenPixelSize) {
    // 1/captureSize when a capture exists (matches the texel grid the shader samples);
    // else 1/viewport (CSS px) — the natural screen-pixel size without a capture.
    const rootRect = screenCapture ? null : getRootRect();
    const sw = screenCapture
      ? screenCapture.width
      : Math.max(1, rootRect?.width ?? 1);
    const sh = screenCapture
      ? screenCapture.height
      : Math.max(1, rootRect?.height ?? 1);
    screenPixelSize = [1 / sw, 1 / sh];
  }
  drawGodotWebglShaderFrame(gl, {
    program: program.program,
    locations: program.uniformLocations,
    uniforms: program.uniforms,
    quad: sharedGl.quad,
    width: vw,
    height: vh,
    texture: glTextureOf(binding.texture),
    time: program.usesTime ? time : undefined,
    texturePixelSize: program.usesTexturePixelSize
      ? [1 / binding.texture.width, 1 / binding.texture.height]
      : undefined,
    modulate: binding.modulate,
    uvFit: fit,
    uvWindow: binding.window,
    screenOrigin,
    screenSize,
    screenTexture: screenCapture?.texture,
    screenTextureUnit: SCREEN_TEXTURE_UNIT,
    screenPixelSize,
    samplers: binding.samplers.map((sampler) => ({
      name: sampler.name,
      unit: sampler.unit,
      texture: glTextureOf(sampler.entry),
    })),
    params: binding.params,
    paramKinds: binding.paramKinds,
  });
  if (prof) prof.glMs += performanceNow() - glDrawStart;
  if (stats) stats.draws++;

  // Blit the shared GL output onto this node's own 2D canvas. The node rendered into the BOTTOM-left
  // vw×vh of the (possibly larger) shared canvas; in the top-down 2D canvas that's the rows
  // [bufH - vh, …). The dest covers the node's FULL w×h backing: when the buffer capped the draw
  // below w×h, the frame scales up (full content at reduced resolution) instead of leaving the
  // out-of-window remainder transparent (the black band).
  const blitStart = prof ? performanceNow() : 0;
  ctx2d.clearRect(0, 0, w, h);
  ctx2d.drawImage(sharedGl.canvas, 0, bufH - vh, vw, vh, 0, 0, w, h);
  if (prof) prof.blitMs += performanceNow() - blitStart;

  // Cache this frozen frame so an identical node (or this node re-created) reuses it without a GL draw.
  if (cacheable && cacheKey)
    deps.storeStaticFrame(cacheKey, binding.canvas, w, h);
  // What this canvas now holds, for the consumer (see the cache-hit branch above). NULL on every
  // un-cacheable frame — live TIME, a screen-space shader, a texture still decoding — because those
  // frames are not a pure function of any key and must never be shared by one.
  binding.lastStaticKey = cacheKey;
  // Feed the image swap the key this canvas now holds — a null key (live mode, a screen-space
  // shader, textures still loading) retires any live swap, since the surface is not frozen output.
  if (binding.staticImage && stats) noteStaticFrame(binding, cacheKey, stats);
  return true;
}

// This backend only ever renders bindings IT created (the binding remembers the backend that made
// its surface, and a backend swap re-creates the binding on a NEW canvas), so every handle it is
// handed really is a GL `TextureEntry` — the same discipline as `glTextureOf` in
// `../particles/render-backend`.
function glTextureOf(handle: ShaderTextureHandle): WebGLTexture | null {
  return (handle as TextureEntry).texture;
}

// SCREEN_TEXTURE binds on a FIXED high unit, clear of unit 0 (the node TEXTURE) and
// `resolveSamplers`' 1..N user-sampler range (real shaders carry a handful of samplers,
// nowhere near 8).
const SCREEN_TEXTURE_UNIT = 8;

/** Quantize a key number so near-identical params collapse to one cache entry (absorbs streamed
 *  jitter). Exported because `./runtime` builds the PRECOMPUTED halves of the key below with it. */
export function quantizeForKey(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The CONTENT KEY of one frozen frame: everything a re-render of this binding at this size and this
 * pinned time would read. Two renders that agree on it produce the same pixels, which is what makes
 * it usable as both a frame-cache address and the image swap's stability evidence.
 *
 * RENDERER-AGNOSTIC, and here rather than in `./runtime` for exactly that reason: the WebGL backend
 * addresses its static-frame CACHE with it, the WebGPU backend (`../webgpu/render-shader`) has no
 * such cache but names its frozen frames with the same string so the swap's gate observes the same
 * identity on either renderer. Every term is a node-local input — which is why a SCREEN_UV or
 * SCREEN_TEXTURE shader is excluded by its caller instead of being keyed here.
 */
export function staticFrameKey(
  binding: NodeBinding,
  w: number,
  h: number,
  time: number,
): string {
  // JSON is intentional framing, rather than the old delimiter-concatenation: shader URLs, names
  // and serialized bake specs can themselves contain every delimiter.  Do not read the DOM here;
  // both renderers call this pure function and the binding stores its canonical resolved inputs.
  return JSON.stringify([
    "gsw-static-frame/v2",
    binding.shaderKey,
    [w, h],
    binding.fit,
    [
      binding.textureUrl,
      binding.textureRepeat,
      binding.textureRegion
        ? [
            binding.textureRegion.x,
            binding.textureRegion.y,
            binding.textureRegion.width,
            binding.textureRegion.height,
          ]
        : null,
      [binding.texture.width, binding.texture.height],
    ],
    binding.modulateKey,
    binding.samplers.map((sampler) => [
      sampler.name,
      sampler.frameIdentity,
      [sampler.entry.width, sampler.entry.height],
    ]),
    binding.windowKey,
    quantizeForKey(time),
    binding.paramsKey,
    binding.paramKindsKey,
  ]);
}

/** The hot-path wrapper around the pure staticFrameKey.  Its epoch is advanced by the runtime at
 * every effective input writer; dimensions and time remain explicit memo coordinates because they
 * are render-call inputs rather than binding fields. */
export function memoStaticFrameKey(
  binding: NodeBinding,
  w: number,
  h: number,
  time: number,
): string {
  // The memo coordinate must be the same representative TIME the key names. Static callers
  // normally pass one pinned value, but a direct/capture caller inside this 0.01 quantum must
  // reuse the same memo rather than doing a useless re-serialization.
  const keyTime = quantizeForKey(time);
  const memo = binding.staticKeyMemo;
  if (
    memo &&
    memo.epoch === binding.staticKeyEpoch &&
    memo.w === w &&
    memo.h === h &&
    memo.time === keyTime
  ) {
    return memo.key;
  }
  const key = staticFrameKey(binding, w, h, time);
  binding.staticKeyMemo = {
    epoch: binding.staticKeyEpoch,
    w,
    h,
    time: keyTime,
    key,
  };
  return key;
}

/** Have the node TEXTURE and every user sampler finished loading? (A placeholder frame must not be
 *  cached, and the loading fallback must not be cleared, until they have.) */
export function texturesLoaded(binding: NodeBinding): boolean {
  return (
    binding.texture.loaded &&
    binding.samplers.every((sampler) => sampler.entry.loaded)
  );
}

// The binding's cached self-layer rect, measured on demand if the batched read hasn't covered it
// yet (a fresh binding, or a render outside the loop). Refreshed — never read per frame — by the
// runtime's `refreshRects`.
export function layerRect(binding: NodeBinding): ViewportRect {
  if (!binding.layerRect) {
    binding.layerRect = binding.selfLayer.getBoundingClientRect();
  }
  return binding.layerRect;
}

/** The node's normalized rect within the scene-root viewport — Godot's SCREEN_UV
 *  domain (origin + the node-local UV scaled by the node's on-screen size). Tracks layout/scroll
 *  via the (invalidated + TTL-refreshed) rect cache; scale/zoom cancels (node ÷ root).
 *  Exported so a second backend feeds its shader the SAME numbers rather than a re-derivation. */
export function screenRect(
  binding: NodeBinding,
  root: ViewportRect,
): [number, number, number, number] {
  const node = layerRect(binding);
  const rw = root.width || 1;
  const rh = root.height || 1;
  return [
    (node.left - root.left) / rw,
    (node.top - root.top) / rh,
    node.width / rw,
    node.height / rh,
  ];
}

/** The UV scale so the texture is contained/covered/filled in the node rect like
 *  Godot's TextureRect stretch (mirrors the self-layer `background-size`). Returns
 *  the fraction of the canvas the drawn texture occupies on each axis; the shader
 *  maps `UV = (v_uv - 0.5) / fit + 0.5`. Exported for the same reason as `screenRect`:
 *  two backends must not each own a copy of this arithmetic. */
export function uvFit(
  binding: NodeBinding,
  canvasW: number,
  canvasH: number,
): [number, number] {
  if (binding.fit === "fill") return [1, 1];
  const tw = binding.texture.width;
  const th = binding.texture.height;
  // The texture is fit to the FULL node box, and the windowed GODOT_UV is in box-UV space, so contain/cover
  // must be computed against the box dimensions (canvas ÷ window), not the sub-rect canvas. Full window ⇒ box
  // == canvas (unchanged).
  const boxW = canvasW / binding.window[2];
  const boxH = canvasH / binding.window[3];
  if (tw <= 0 || th <= 0 || boxW <= 0 || boxH <= 0) return [1, 1];
  const scale =
    binding.fit === "cover"
      ? Math.max(boxW / tw, boxH / th)
      : Math.min(boxW / tw, boxH / th);
  return [(tw * scale) / boxW, (th * scale) / boxH];
}

// ---- texture resolution ----------------------------------------------------

// The shader's input texture: the atlas SUB-RECT when the self-layer carries a region (map-node/relic icons),
// else the whole image. Cropping is what stops an atlas-sprite recolor shader from sampling page padding →
// white; with the sprite filling UV [0,1], `uvFit`/`TEXTURE_PIXEL_SIZE` also come out right unchanged. With no
// url at all the shader samples a 1×1 solid white (it supplies its own colour).
function resolveNodeTexture(
  gl: WebGL2RenderingContext,
  spec: ShaderTextureSpec,
  maxDim: number | undefined,
): TextureEntry {
  const { node, selfLayer, textureUrl } = spec;
  if (!textureUrl) return getSolidTexture(gl, "white", [255, 255, 255, 255]);
  const repeat = nodeTextureRepeats(node);
  const region = parseAtlasRegion(
    selfLayer.getAttribute("data-godot-atlas-region"),
  );
  return region
    ? getRegionTexture(gl, textureUrl, region, { repeat, maxDim })
    : getTexture(gl, textureUrl, repeat, maxDim);
}

// Parse `data-godot-atlas-region` ("x,y,w,h" in atlas page px) into a positive sub-rect, or null when absent
// (a non-atlas texture) or malformed. It's stamped on every atlas TextureRect/Sprite2D self-layer for the CSS
// crop, so it doubles as the signal to sample only the sprite's sub-rect of the atlas PAGE. Exported for tests
// (the GL crop itself needs a real WebGL2 context — device-verified).
export function parseAtlasRegion(
  attr: string | null,
): { x: number; y: number; width: number; height: number } | null {
  if (!attr) return null;
  const parts = attr.split(",").map((value) => Number(value.trim()));
  if (parts.length < 4 || parts.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const [x, y, width, height] = parts;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

// Bake or load the shader's user sampler uniforms from the node attributes emitted
// by material.ts. Each gets its own texture unit (1..N; unit 0 is the node TEXTURE).
function resolveSamplers(
  gl: WebGL2RenderingContext,
  node: HTMLElement,
  program: CompiledProgram,
  maxTextureDim?: number,
): SamplerBinding[] {
  if (program.samplers.length === 0) return [];
  const specs = parseSamplerSpecs(
    node.getAttribute("data-godot-shader-samplers"),
  );
  const urls = parseSamplerUrls(
    node.getAttribute("data-godot-shader-sampler-urls"),
  );
  const out: SamplerBinding[] = [];
  let unit = 1;
  for (const sampler of program.samplers) {
    const url = urls[sampler.name];
    if (url) {
      out.push({
        name: sampler.name,
        entry: getImageTexture(gl, url, {
          repeat: sampler.repeat,
          maxDim: maxTextureDim,
        }),
        unit,
        frameIdentity: ["url", url, sampler.repeat],
      });
      unit += 1;
      continue;
    }
    const spec = specs[sampler.name];
    if (!spec) continue; // no resolvable source -> sampler stays unbound (reads 0)
    const specIdentity = JSON.stringify(spec) ?? "undefined";
    const key = `${sampler.name}:${specIdentity}`;
    const entry = getBakedTexture(gl, key, () => bakeTexture(spec), {
      repeat: sampler.repeat,
    });
    out.push({
      name: sampler.name,
      entry,
      unit,
      frameIdentity: ["bake", specIdentity, sampler.repeat],
    });
    unit += 1;
  }
  return out;
}

/** The `data-godot-shader-samplers` bake specs, by uniform name. Exported so a second backend reads
 *  the SAME attributes with the same tolerance for garbage (a malformed value is "no samplers", never
 *  a throw in a render path). */
export function parseSamplerSpecs(
  value: string | null,
): Record<string, TextureBakeSpec> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

/** The `data-godot-shader-sampler-urls` map, by uniform name. Exported alongside
 *  `parseSamplerSpecs`, and for the same reason. */
export function parseSamplerUrls(value: string | null): Record<string, string> {
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

// ---- uniform setters -------------------------------------------------------
