// Shared WebGL2 plumbing used by BOTH live runtimes (the ShaderMaterial runtime in
// `runtime.ts` and the particle runtime in `../particles/runtime.ts`). Keeping it in
// one module is load-bearing: both runtimes MUST share
//   - ONE WebGL2 context (an offscreen canvas), so we never hit the browser's ~16
//     live-context limit even with many cards + particle systems on a page, and
//   - ONE module-scoped texture cache, so identical textures upload once, and
//   - ONE monotonic clock origin, so `TIME` is continuous across attach/detach and
//     across the two runtimes (a per-runtime origin would reset animations to 0).
// Duplicating any of these would defeat those guarantees.

import {
  createWebglFullscreenQuad,
  createWebglPlaceholderTexture,
  createWebglTexture,
  uploadWebglTexture,
} from "@godot-scene-web/canvas-effects/webgl";
import { bakeTexture, type TextureBakeSpec } from "./bake-texture";

export interface SharedGl {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  /** Full-screen clip-space [-1,1] quad as a TRIANGLE_STRIP (the shader runtime). */
  quad: WebGLBuffer;
}

export interface TextureEntry {
  texture: WebGLTexture | null;
  width: number;
  height: number;
  loaded: boolean;
  listeners: Set<() => void>;
}

// Module-scope shared state, persisted across attach/detach cycles.
let shared: SharedGl | null | undefined; // undefined = not tried; null = unavailable
const textureCache = new Map<string, TextureEntry>();
// The shared canvas's ACTUAL drawing-buffer ceiling, discovered at runtime (see
// `ensureSharedDrawSize`). Infinity until a grow comes back smaller than requested; latched so a
// doomed realloc isn't re-attempted (and the buffer re-cleared) on every draw. Module-scoped like
// the canvas itself — both runtimes share the one buffer, so they must share its one ceiling.
let sharedMaxWidth = Number.POSITIVE_INFINITY;
let sharedMaxHeight = Number.POSITIVE_INFINITY;
// The `TIME` clock origin — module-scoped (set once) so it is MONOTONIC across
// attach/detach cycles and across both runtimes. A re-render (e.g. focusing a
// creature adds tooltip nodes) tears down and re-attaches a runtime; a per-attach
// origin would reset TIME to 0 and visibly restart every animation. Persisting it
// keeps TIME continuous, like Godot's `TIME` (seconds since start).
let clockOrigin: number | undefined;

// Renderer strings that mean WebGL is being rasterized on the CPU (no usable GPU):
// SwiftShader (Chromium's software fallback, incl. the ANGLE/Vulkan-Subzero variant),
// Mesa's llvmpipe/softpipe, and Windows' Basic Render Driver. Running our full-screen
// fragment shaders (doom-bar FBM noise, card-ripple SDF) on these pegs the CPU for no
// visual gain over the CSS/SVG fallback — so we decline WebGL and let the fallback render.
const SOFTWARE_RENDERER_RE =
  /swiftshader|llvmpipe|softpipe|\bsoftware\b|basic render|paravirtual/i;

// Read the unmasked GL renderer string, if the browser exposes it. Returns "" when the
// `WEBGL_debug_renderer_info` extension is unavailable (e.g. privacy-masked) — callers
// must treat "" as UNKNOWN, not software, so a real GPU is never disabled on uncertainty.
function readRendererString(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): string {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return "";
    return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "");
  } catch {
    return "";
  }
}

export interface GpuInfo {
  /** The unmasked GL renderer string, or "" when masked/unknown/unavailable. */
  renderer: string;
  /** True only when `renderer` POSITIVELY matches a software rasterizer — never on "" (unknown). */
  software: boolean;
  /** True when WebGL is unavailable at all (no context). */
  unavailable: boolean;
}

let gpuInfo: GpuInfo | undefined;

// Probe the GPU once for a consumer's device-tier heuristic. Uses its OWN throwaway context (then
// drops it) so it works even on software renderers, where `getShared` returns null + loses its
// context. Latched. Returns `software:false` on an unknown/masked string so a real GPU is never
// mis-classified as software on uncertainty (callers fall back to other low-end signals).
export function describeGpu(): GpuInfo {
  if (gpuInfo) return gpuInfo;
  try {
    if (typeof document === "undefined") {
      gpuInfo = { renderer: "", software: false, unavailable: true };
      return gpuInfo;
    }
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") || canvas.getContext("webgl")) as
      | WebGLRenderingContext
      | WebGL2RenderingContext
      | null;
    if (!gl) {
      gpuInfo = { renderer: "", software: false, unavailable: true };
      return gpuInfo;
    }
    const renderer = readRendererString(gl);
    gpuInfo = {
      renderer,
      software: SOFTWARE_RENDERER_RE.test(renderer),
      unavailable: false,
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return gpuInfo;
  } catch {
    gpuInfo = { renderer: "", software: false, unavailable: true };
    return gpuInfo;
  }
}

export function getShared(): SharedGl | null {
  if (shared !== undefined) {
    return shared;
  }
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      // THE ALPHA CONTRACT OF THIS CANVAS, and the one line every fragment that draws here must
      // agree with. `premultipliedAlpha` does not change a single byte in the drawing buffer — it
      // tells the browser how to READ them, on every `drawImage` out of this canvas and on every
      // page composite. Declare it wrong and nothing errors; the picture is simply wrong, and no
      // readback can see it, because the declaration is not in the buffer.
      //
      // TRUE, i.e. every consumer writes `(rgb·a, a)`:
      //   - `./transpile.ts` emits `fragColor = vec4(COLOR.rgb * COLOR.a, COLOR.a);` and
      //     `./shader-backend.ts` draws with BLEND off, so COLOR lands premultiplied;
      //   - core's `particles/render-webgl.ts` emits a premultiplied fragment under
      //     `blendFuncSeparate(ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`, and its
      //     additive resolve presents the accumulated total as `(light, cov)`.
      // That is byte-for-byte the WebGPU contract (`../webgpu/device.ts` configures
      // `alphaMode: "premultiplied"`, both WGSL fragments return `rgb*a`), which is the point: ONE
      // statement of the rule for both backends instead of two that have to be kept in sync.
      //
      // It used to be FALSE, and the MIX particle path was wrong for it: a straight declaration
      // over `blendFuncSeparate(SRC_ALPHA, …)` — which is itself a premultiplying operation over a
      // cleared buffer — made the blit into each node canvas multiply by alpha a SECOND time, so
      // MIX particles composited at roughly a² instead of a. `shared-gl.test.ts` pins this line and
      // `test-harness`'s `webglCompositeXvfb.test.ts` measures the result on a real page.
      premultipliedAlpha: true,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      shared = null;
      return null;
    }
    // Software-rendered WebGL (SwiftShader/llvmpipe/…) runs every shader on the CPU; treat it
    // as "no GPU available" and fall back to CSS/SVG — UNLESS positively a hardware renderer,
    // or the string is masked/unknown (default ON so a real GPU is never penalised). Escape
    // hatch: set `globalThis.__gswForceWebglShaders = true` to run shaders even on software
    // (e.g. to exercise the shader path on a headless/CI box).
    const forceWebgl =
      (globalThis as Record<string, unknown>).__gswForceWebglShaders === true;
    if (!forceWebgl && SOFTWARE_RENDERER_RE.test(readRendererString(gl))) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      shared = null;
      return null;
    }
    const quad = createWebglFullscreenQuad(gl);
    if (!quad) {
      shared = null;
      return null;
    }
    shared = { canvas, gl, quad };
    return shared;
  } catch {
    shared = null;
    return null;
  }
}

// A reported drawing-buffer dimension, or `fallback` (the canvas attribute) when the context
// doesn't report one (test fakes / non-browser contexts) — trusting the attribute there keeps the
// pre-verification behavior exactly.
function actualBufferDim(reported: unknown, fallback: number): number {
  return typeof reported === "number" &&
    Number.isFinite(reported) &&
    reported > 0
    ? reported
    : fallback;
}

/** The size a caller can REALLY draw + blit for a w×h node render on the shared canvas:
 *  `vw`×`vh` (≤ w×h) and the buffer height `bufH` the bottom-left blit's source rows must be
 *  measured against. On a healthy context this is exactly {w, h, canvas.height}. */
export interface SharedDrawSize {
  vw: number;
  vh: number;
  bufH: number;
}

// Grow the shared canvas (grow-only, as both runtimes always did — reallocating per node per
// frame was a realloc storm) so a w×h draw fits, and VERIFY the drawing buffer actually reached
// the requested size. Setting `canvas.width/height` only REQUESTS a realloc: the GL
// implementation may come back SMALLER — the GPU's max texture/renderbuffer size, or an
// allocation failure that keeps the previous buffer (Chrome restores the last-known-good size).
// Trusting the attribute is the UNDERDOCKS widened-background black-band bug: the viewport/
// scissor spanned the attribute size and the blit's source rect read columns/rows past the real
// buffer → transparent → a band at exactly oldBuffer/newAttribute of the node canvas. When the
// buffer comes back short, the attribute is snapped DOWN to it (so canvas-as-image dimensions
// match the pixels that exist), the ceiling is latched (no per-draw realloc retry; the retry
// would also CLEAR the buffer every draw), and the caller renders at vw×vh and scales its blit
// up to the node's full backing — complete content at reduced resolution, never a clipped band.
export function ensureSharedDrawSize(
  sharedGl: SharedGl,
  w: number,
  h: number,
): SharedDrawSize {
  const { gl, canvas } = sharedGl;
  const wantW = Math.min(w, sharedMaxWidth);
  const wantH = Math.min(h, sharedMaxHeight);
  if (canvas.width < wantW) canvas.width = wantW;
  if (canvas.height < wantH) canvas.height = wantH;
  let bufW = actualBufferDim(gl.drawingBufferWidth, canvas.width);
  let bufH = actualBufferDim(gl.drawingBufferHeight, canvas.height);
  if (bufW < canvas.width || bufH < canvas.height) {
    if (bufW < canvas.width) sharedMaxWidth = bufW;
    if (bufH < canvas.height) sharedMaxHeight = bufH;
    // Snap at the achievable size (a realloc the implementation just proved it can hold; it
    // clears the buffer, which is fine — every caller draws immediately after).
    if (canvas.width !== bufW) canvas.width = bufW;
    if (canvas.height !== bufH) canvas.height = bufH;
    bufW = actualBufferDim(gl.drawingBufferWidth, canvas.width);
    bufH = actualBufferDim(gl.drawingBufferHeight, canvas.height);
  }
  return { vw: Math.min(w, bufW), vh: Math.min(h, bufH), bufH };
}

export function getTexture(
  gl: WebGL2RenderingContext,
  url: string,
  repeat = false,
  maxDim?: number,
): TextureEntry {
  return getImageTexture(gl, url, { repeat, maxDim });
}

// Downscale a loaded image to ≤ maxDim on its longest edge BEFORE uploading, so a huge source (e.g. a
// full-screen background ~4096²) doesn't cost a ~250ms main-thread `texImage2D` upload. Aspect is preserved
// (so uvFit is unchanged); the shader samples UV [0,1] either way, just at a lower internal resolution. A no-op
// when maxDim is unset/0, the image already fits, or there's no DOM (SSR). Returns the upload source + its dims.
export function downscaleForUpload(
  image: HTMLImageElement,
  maxDim: number | undefined,
): { source: TexImageSource; width: number; height: number } {
  const w = image.naturalWidth || 1;
  const h = image.naturalHeight || 1;
  if (
    !maxDim ||
    maxDim <= 0 ||
    (w <= maxDim && h <= maxDim) ||
    typeof document === "undefined"
  ) {
    return { source: image, width: w, height: h };
  }
  const scale = maxDim / Math.max(w, h);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { source: image, width: w, height: h };
  ctx.drawImage(image, 0, 0, dw, dh);
  return { source: canvas, width: dw, height: dh };
}

// Godot CanvasItem.TextureRepeat: 2 = Enabled, 3 = Mirror -> the texture wraps; 0
// (ParentNode) / 1 (Disabled) clamp. A shader that scrolls the node TEXTURE past
// [0,1] via TIME (e.g. the affliction smoke) only animates if the texture wraps;
// clamped, the scroll freezes at the edge as a motionless, edge-coloured patch.
export function nodeTextureRepeats(node: HTMLElement): boolean {
  const value = node.getAttribute("data-godot-texture-repeat");
  return value === "2" || value === "3";
}

export function getImageTexture(
  gl: WebGL2RenderingContext,
  url: string,
  opts: { repeat: boolean; maxDim?: number },
): TextureEntry {
  return loadUploadedTexture(
    gl,
    `${opts.repeat ? "repeat" : "clamp"}:${url}`,
    url,
    opts.repeat,
    (image) => downscaleForUpload(image, opts.maxDim),
  );
}

// Like `getImageTexture` but uploads only the atlas SUB-RECT `region` (page px, top-left origin) — for a
// WebGL shader on an atlas-region sprite (map-node icon, relic). Without it the runtime binds the whole atlas
// PAGE, so the shader's implicit `COLOR = texture(TEXTURE, UV)` samples page padding → opaque white (the
// recolor shaders pass white through). Cropping makes the sprite fill UV [0,1], so `uvFit` /
// `TEXTURE_PIXEL_SIZE` (both derived from the uploaded texture's dims) come out right with NO shader change.
export function getRegionTexture(
  gl: WebGL2RenderingContext,
  url: string,
  region: { x: number; y: number; width: number; height: number },
  opts: { repeat: boolean; maxDim?: number },
): TextureEntry {
  const key =
    `${opts.repeat ? "repeat" : "clamp"}:region` +
    `:${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)}:${url}`;
  return loadUploadedTexture(gl, key, url, opts.repeat, (image) =>
    cropRegionForUpload(image, region, opts.maxDim),
  );
}

// Shared texture loader: a 1x1 transparent placeholder now, then async-load `url`, transform it via `toUpload`
// (full-image downscale, or atlas-region crop) and upload UN-flipped: image row 0 lands at texture V=0, i.e.
// top-left origin — matching the transpiled prelude's Godot-convention `UV`/`GODOT_UV` (UV.y=0 = top) and
// `getBakedTexture`'s top-left uploads. (A FLIP_Y upload here double-flips against `1.0 - v_uv.y` in
// transpile.ts and renders base textures upside-down.) Alpha stays un-premultiplied. One code path for every
// cached texture.
function loadUploadedTexture(
  gl: WebGL2RenderingContext,
  cacheKey: string,
  url: string,
  repeat: boolean,
  toUpload: (image: HTMLImageElement) => {
    source: TexImageSource;
    width: number;
    height: number;
  },
): TextureEntry {
  const cached = textureCache.get(cacheKey);
  if (cached) return cached;
  const texture = createWebglPlaceholderTexture(gl, repeat);
  const entry: TextureEntry = {
    texture,
    width: 1,
    height: 1,
    loaded: false,
    listeners: new Set(),
  };
  textureCache.set(cacheKey, entry);
  if (!texture) return entry;
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    // Top-left-origin upload (no FLIP_Y): the shader prelude samples with Godot-convention
    // UVs (UV.y=0 = top), so the image must keep row 0 at V=0.
    const up = toUpload(image);
    uploadWebglTexture(gl, texture, up.source, undefined, undefined, {
      repeat,
    });
    entry.width = up.width;
    entry.height = up.height;
    markTextureLoaded(entry);
  };
  image.src = url;
  return entry;
}

// Crop the atlas sub-rect `region` (page px, top-left origin) to an offscreen canvas, downscaled to `maxDim`
// on its longest edge (the region size, not the page). Mirrors `downscaleForUpload`'s canvas-draw; a no-op
// fallback to the whole image when there's no DOM / 2D context.
function cropRegionForUpload(
  image: HTMLImageElement,
  region: { x: number; y: number; width: number; height: number },
  maxDim: number | undefined,
): { source: TexImageSource; width: number; height: number } {
  const rw = Math.max(1, Math.round(region.width));
  const rh = Math.max(1, Math.round(region.height));
  const fallback = {
    source: image as TexImageSource,
    width: image.naturalWidth || rw,
    height: image.naturalHeight || rh,
  };
  if (typeof document === "undefined") return fallback;
  const scale =
    maxDim && maxDim > 0 ? Math.min(1, maxDim / Math.max(rw, rh)) : 1;
  const dw = Math.max(1, Math.round(rw * scale));
  const dh = Math.max(1, Math.round(rh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return fallback;
  ctx.drawImage(image, region.x, region.y, rw, rh, 0, 0, dw, dh);
  return { source: canvas, width: dw, height: dh };
}

function markTextureLoaded(entry: TextureEntry): void {
  entry.loaded = true;
  for (const listener of [...entry.listeners]) {
    listener();
  }
  entry.listeners.clear();
}

/** The subset of a texture entry the load hook needs: whether the real pixels have arrived, and who
 *  to tell when they do. Structural rather than `TextureEntry` so an entry from a non-WebGL texture
 *  cache — which has no `WebGLTexture` to offer — can be waited on through the same hook. */
export interface TextureLoadState {
  loaded: boolean;
  listeners: Set<() => void>;
}

export function onTextureLoaded(
  entry: TextureLoadState,
  listener: () => void,
): () => void {
  if (entry.loaded) {
    listener();
    return () => {};
  }
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

export function getSolidTexture(
  gl: WebGL2RenderingContext,
  key: string,
  rgba: [number, number, number, number],
): TextureEntry {
  const cacheKey = `solid:${key}`;
  const cached = textureCache.get(cacheKey);
  if (cached) return cached;
  const texture = createWebglTexture(gl);
  if (texture) uploadWebglTexture(gl, texture, new Uint8Array(rgba), 1, 1);
  const entry: TextureEntry = {
    texture,
    width: 1,
    height: 1,
    loaded: true,
    listeners: new Set(),
  };
  textureCache.set(cacheKey, entry);
  return entry;
}

// Upload (or refresh) a 2D canvas into a caller-OWNED GL texture — the SCREEN_TEXTURE
// capture path re-uploads its per-binding screen composite here. Unlike the url-keyed
// `textureCache` entries these textures are volatile (re-captured, per-binding) and are
// created/deleted by the caller. Top-left-origin upload (no FLIP_Y), matching the
// transpiled prelude's Godot-convention UVs (SCREEN_UV.y = 0 is the top).
export const uploadCanvasTexture = uploadWebglTexture;

// A procedural sampler texture (NoiseTexture2D/GradientTexture1D) baked from its
// spec to RGBA bytes and uploaded once. Cached by a stable spec key so identical
// samplers across nodes (e.g. every enemy's doom bar) share one GL texture.
export function getBakedTexture(
  gl: WebGL2RenderingContext,
  key: string,
  bake: () => { width: number; height: number; data: Uint8ClampedArray },
  opts: { repeat: boolean; nearest?: boolean },
): TextureEntry {
  const cached = textureCache.get(key);
  if (cached) return cached;
  const baked = bake();
  const texture = createWebglTexture(gl);
  // `repeat_enable` -> REPEAT so an unbounded TIME scroll keeps wrapping (CLAMP
  // would freeze the animation at the texture edge); else CLAMP_TO_EDGE.
  // NEAREST for a CONSTANT-interpolation ramp: the bake already produced hard steps, and
  // LINEAR would smear each step boundary back across a texel. LINEAR otherwise.
  if (texture)
    uploadWebglTexture(
      gl,
      texture,
      new Uint8Array(
        baked.data.buffer,
        baked.data.byteOffset,
        baked.data.byteLength,
      ),
      baked.width,
      baked.height,
      opts,
    );
  const entry: TextureEntry = {
    texture,
    width: baked.width,
    height: baked.height,
    loaded: true,
    listeners: new Set(),
  };
  textureCache.set(key, entry);
  return entry;
}

export type { TextureBakeSpec };
// Re-export so callers that bake spec textures don't also need to import bake-texture.
export { bakeTexture };

// ---- clock + environment shims (guarded for non-browser / test envs) --------

// Seconds since the shared (monotonic) clock origin. Lazily initialises the origin
// on first call, so whichever runtime attaches first sets it and both then agree.
export function nowSeconds(): number {
  if (clockOrigin === undefined) clockOrigin = performanceNow();
  return (performanceNow() - clockOrigin) / 1000;
}

/** TEST-ONLY: reset the memoized shared GL + clock so a test can install a stubbed
 *  `getContext`/WebGL2 and re-probe deterministically (getShared latches its result). */
export function __resetSharedForTest(): void {
  shared = undefined;
  clockOrigin = undefined;
  sharedMaxWidth = Number.POSITIVE_INFINITY;
  sharedMaxHeight = Number.POSITIVE_INFINITY;
}

export function performanceNow(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : 0;
}

export function devicePixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio
    ? window.devicePixelRatio
    : 1;
}

// The backing-store pixel ratio a runtime should size its canvases at: `devicePixelRatio` scaled by
// an optional `renderScale` (clamped to (0, 1]). <1 renders the effect at a lower internal resolution
// (browser upscales the CSS-sized canvas) — the low-end GPU-fill saving knob. Shared by both runtimes
// so a particle system and a shader on the same device agree on their pixel density.
export function effectivePixelRatio(renderScale?: number): number {
  const scale =
    typeof renderScale === "number" && renderScale > 0
      ? Math.min(renderScale, 1)
      : 1;
  return devicePixelRatio() * scale;
}

// Longest-edge ceiling (backing-store px) for a PINNED static backing store — see
// `staticShaderPixelRatio` / `staticParticlePixelRatio` in `../types`. It bounds only the PINNED
// path: the live path is sized by `devicePixelRatio × renderScale`, which the device itself bounds,
// and has never been clamped.
//
// 2048 because that is the WebGL2 (GLES 3.0) guaranteed minimum `MAX_TEXTURE_SIZE`, i.e. the largest
// dimension every conformant context can be relied on to allocate. Two things push back on going
// higher: the ONE shared drawing buffer is grow-only and shared by every node in both runtimes, so a
// single oversized pinned node permanently grows it (and if the grow comes back short,
// `ensureSharedDrawSize` LATCHES a lower ceiling for every other node); and each frozen frame is also
// snapshotted into the 64-entry static-frame cache, whose bitmaps scale with the pinned size. A pin
// is a consumer's guess at "what fullscreen would be on this device" — this is the guard rail that
// keeps a wrong guess (a windowed 4K desktop asking for 4K-class frames) from becoming an allocation
// problem, at the cost of a softer frame on displays that really are that large.
export const MAX_PINNED_BACKING_DIM = 2048;

/** Backing-store size (px) for a `cssW`×`cssH` surface at `ratio`, plus the ratio ACTUALLY applied —
 *  which differs from `ratio` only when `maxDim` bit, and is what a caller that draws geometry in
 *  CSS px × ratio (the particle runtime) must scale by so its sprites still land inside the canvas.
 *
 *  With `maxDim` the result is scaled down ASPECT-PRESERVINGLY (the `downscaleForUpload` idiom) so
 *  its longest edge fits. Per-axis clamping is not an option: the shader runtime's `uvFit` derives
 *  contain/cover from the canvas aspect, so a squashed backing store would re-fit the texture
 *  wrongly. Without `maxDim` (or under it) this is exactly the `Math.max(1, Math.round(css * ratio))`
 *  both runtimes have always done, and `ratio` comes back untouched. */
export function backingStoreSize(
  cssW: number,
  cssH: number,
  ratio: number,
  maxDim?: number,
): { w: number; h: number; ratio: number } {
  const w = Math.max(1, Math.round(cssW * ratio));
  const h = Math.max(1, Math.round(cssH * ratio));
  const longest = Math.max(w, h);
  if (!maxDim || maxDim <= 0 || longest <= maxDim) return { w, h, ratio };
  const scale = maxDim / longest;
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
    ratio: ratio * scale,
  };
}

/** The self-layer attribute that carries a surface's PER-BINDING backing-density multiplier — the
 *  factor by which the device pixels this surface really covers exceed its own CSS box.
 *
 *  Both fx runtimes size a canvas from `clientWidth × (devicePixelRatio × renderScale)`, and
 *  `clientWidth` is blind to ancestor CSS transforms: a node under a `transform: scale(1.41)`
 *  ancestor lays out at its untransformed width, so its backing store is sized for 1/1.41 of the
 *  device pixels it is magnified onto and the surface is visibly soft. Nothing the runtime can read
 *  off its own element tells it that — the transform belongs to an ancestor the runtime does not
 *  own, and finding it would be a `getBoundingClientRect()` walk per surface per frame, i.e. exactly
 *  the forced layout both runtimes are built around avoiding.
 *
 *  So the HOST states it. It already composed that transform to write it; this attribute is that
 *  number, handed down. It is a MULTIPLIER on the density term, not a replacement for it: the
 *  device ratio, `renderScale` and any frozen-mode pin all still apply, and this rides on top.
 *
 *  IT IS AN AXIS SCALE, NOT A BOUNDING-BOX RATIO, and a host that confuses the two will over-allocate
 *  every rotated surface it owns. `getBoundingClientRect()` returns the axis-aligned bounding box of a
 *  transformed element, so a square rotated θ measures `|cos θ| + |sin θ|` wider than it is — √2 at
 *  45° — while covering exactly as many device pixels as before. Rotation is rigid. The number this
 *  attribute wants is the transform's column norm (or the mean of the two under a non-uniform scale).
 *
 *  Named `data-godot-shader-*` and read by the PARTICLE runtime as well, deliberately — one name
 *  for one question ("how magnified is this surface?") that both fx families ask identically, so a
 *  host stamps it the same way whichever runtime picks the node up. */
export const SURFACE_PIXEL_RATIO_ATTR = "data-godot-shader-pixel-ratio";

/** Ceiling on the attribute above. The multiplier is the one density input that arrives as a STRING
 *  from outside the runtime — `renderScale` is clamped to ≤ 1 and the static pin is bounded by
 *  `MAX_PINNED_BACKING_DIM` — so a host mid-animation, or a host with a bug, could otherwise turn
 *  one attribute write into a quadratic backing-store allocation on a surface the runtime has no
 *  other reason to distrust. 4 is 16× the area, past any magnification a UI plausibly applies to a
 *  live effect, and a surface asking for more is far likelier to be wrong than under-resolved. */
export const MAX_SURFACE_PIXEL_RATIO = 4;

/** Parse `SURFACE_PIXEL_RATIO_ATTR` into a density MULTIPLIER.
 *
 *  Absent, empty, unparseable, non-finite or non-positive ⇒ exactly `1`, i.e. the density term is
 *  the product it has always been and the surface is sized byte-for-byte as it was before this
 *  attribute existed. That is the whole off-switch: a host that never writes the attribute cannot
 *  tell this feature is here.
 *
 *  Values BELOW 1 are honoured (a surface minified by an ancestor really does cover fewer device
 *  pixels than its box). Above `MAX_SURFACE_PIXEL_RATIO` they are capped, not rejected — a too-large
 *  value is still evidence the surface is magnified, so clamping keeps most of the fix while
 *  refusing the allocation. */
export function parseSurfacePixelRatio(
  attr: string | null | undefined,
): number {
  if (attr === null || attr === undefined) return 1;
  const value = Number.parseFloat(attr);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(value, MAX_SURFACE_PIXEL_RATIO);
}

/** Normalize a pinned static backing ratio (`staticShaderPixelRatio`/`staticParticlePixelRatio`):
 *  a finite ratio > 0, else `undefined` = NOT pinned (the runtime keeps sizing every binding at
 *  `devicePixelRatio × renderScale`, exactly as before the option existed). Unlike `renderScale`
 *  it is NOT clamped to ≤ 1 — the whole point is to allow a backing store denser than the current
 *  fit — only bounded later by `MAX_PINNED_BACKING_DIM` on the resulting size. */
export function normalizeStaticPixelRatio(
  value: number | undefined,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** TEST-ONLY: reset the memoized GPU probe so a test can re-run `describeGpu` with a fresh stub. */
export function __resetGpuInfoForTest(): void {
  gpuInfo = undefined;
}
