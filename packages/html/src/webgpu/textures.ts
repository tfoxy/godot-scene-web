// The WebGPU texture cache — the twin of `../webgl/shared-gl.ts`'s `textureCache`, deliberately
// built to be PROVABLY parallel to it:
//
//   - the cache KEYS are the same strings for the same inputs (`clamp:`/`repeat:` + url, and the
//     caller-supplied `particle-lut:{…}` for baked ones). Both caches are module-scoped, so a page
//     that falls back from WebGPU to WebGL mid-run re-derives the same key for the same texture and
//     nothing in the runtimes needs to know which cache answered.
//   - entries carry `width`/`height`/`loaded`/`listeners`, the quartet the particle runtime reads
//     off a WebGL `TextureEntry` (frame-grid sizing, sprite extent, the "redraw when it decodes"
//     subscription). Keeping the field names identical is what lets the runtime stay
//     renderer-agnostic over both.
//   - uploads keep STRAIGHT alpha (`premultipliedAlpha: false`), exactly as the GL path's
//     `UNPACK_PREMULTIPLY_ALPHA_WEBGL false`. Premultiplication happens ONCE, in WGSL, at fragment
//     output — premultiplying here as well would darken every edge texel by its own alpha twice.
//   - uploads are top-left-origin (no flip), so image row 0 is V=0, matching the Godot-convention
//     UVs the fragment code samples with.
//
// The one thing WebGL does NOT force on the runtime: a `GPUTexture`'s size is fixed at creation, so
// the 1×1 placeholder cannot be re-uploaded into at the decoded size — the entry's `texture` AND
// `view` are REPLACED when the image lands. Any bind group built from the placeholder view is
// stale from that moment; rebuilding it is the job of the `loaded` listener, which is exactly the
// callback the GL path already fires for its own reasons (a redraw).

import {
  createWebgpuRgbaTexture,
  createWebgpuSampler,
  destroyWebgpuTexture,
  uploadWebgpuExternalImage,
  uploadWebgpuRgba,
} from "@godot-scene-web/canvas-effects/webgpu";
import { onWebgpuDeviceLost, TEXTURE_USAGE, type WebgpuShared } from "./device";

export interface GpuTextureEntry {
  /** REPLACED when an async image decodes — never captured across a `loaded` notification. */
  texture: GPUTexture;
  /** REPLACED with `texture`; the handle bind groups are built from. */
  view: GPUTextureView;
  sampler: GPUSampler;
  width: number;
  height: number;
  loaded: boolean;
  listeners: Set<() => void>;
}

export interface GpuImageTextureOptions {
  repeat?: boolean;
}

export interface GpuBakedTextureOptions {
  /** NEAREST for a CONSTANT-interpolation ramp: the bake already produced hard steps, and LINEAR
   *  would smear each step boundary back across a texel. */
  nearest?: boolean;
  repeat?: boolean;
}

/** Baked pixel data. Structurally satisfied by `ImageData` and by `bakeTexture`'s
 *  `{width, height, data}`, so a caller can hand either to `getBakedTextureGpu`. */
export interface BakedPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

// Every texture a `copyExternalImageToTexture` writes into must declare RENDER_ATTACHMENT as well
// as COPY_DST (the copy is implemented as a render pass), and TEXTURE_BINDING because that is what
// the whole thing is for.
const _UPLOADABLE_USAGE =
  TEXTURE_USAGE.TEXTURE_BINDING |
  TEXTURE_USAGE.COPY_DST |
  TEXTURE_USAGE.RENDER_ATTACHMENT;

// Module-scope caches, keyed by the same strings as the GL cache. `cacheDevice` is the generation
// marker: entries belong to ONE device, so a new device (after a loss + re-acquire) starts clean
// rather than handing out textures the new device cannot bind.
const textureCache = new Map<string, GpuTextureEntry>();
const samplerCache = new Map<string, GPUSampler>();
let cacheDevice: GPUDevice | null = null;
let unsubscribeLost: (() => void) | null = null;

/** The cache key for an image texture — byte-identical to `getImageTexture`'s in
 *  `../webgl/shared-gl.ts` (`${opts.repeat ? "repeat" : "clamp"}:${url}`, shared-gl.ts:318). If
 *  that line ever changes, this one must change with it. */
export function imageTextureCacheKey(url: string, repeat: boolean): string {
  return `${repeat ? "repeat" : "clamp"}:${url}`;
}

/**
 * A sprite/mask texture from `url`, returned IMMEDIATELY as a 1×1 transparent placeholder and
 * filled in when the image decodes. Same contract as the GL path: until it loads, a masked system
 * draws nothing (the placeholder's red is 0) rather than flashing an unmasked square.
 */
export function getImageTextureGpu(
  shared: WebgpuShared,
  url: string,
  opts: GpuImageTextureOptions = {},
): GpuTextureEntry {
  const repeat = opts.repeat === true;
  return loadImageTexture(
    shared,
    imageTextureCacheKey(url, repeat),
    url,
    repeat,
    null,
  );
}

/** The cache key for an atlas SUB-RECT texture — byte-identical to `getRegionTexture`'s in
 *  `../webgl/shared-gl.ts`, for the same reason `imageTextureCacheKey` is. */
export function regionTextureCacheKey(
  url: string,
  region: AtlasRegion,
  repeat: boolean,
): string {
  return (
    `${repeat ? "repeat" : "clamp"}:region` +
    `:${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)}:${url}`
  );
}

/** An atlas sprite's own sub-rect of the atlas PAGE, in page pixels, top-left origin. */
export interface AtlasRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Like `getImageTextureGpu` but uploads ONLY the atlas sub-rect `region` — the twin of
 * `getRegionTexture`, and needed for the same reason: bound the whole page instead and a recolour
 * shader's implicit `COLOR = texture(TEXTURE, UV)` samples the page's padding (opaque white) rather
 * than the sprite. Cropping makes the sprite fill UV [0,1], so `uvFit` and `TEXTURE_PIXEL_SIZE`
 * (both derived from the uploaded size) come out right with no shader change.
 *
 * The crop is the copy's own `origin`, so it costs no intermediate canvas — WebGPU can express
 * directly what the GL path has to draw into a scratch 2D canvas to achieve.
 */
export function getRegionTextureGpu(
  shared: WebgpuShared,
  url: string,
  region: AtlasRegion,
  opts: GpuImageTextureOptions = {},
): GpuTextureEntry {
  const repeat = opts.repeat === true;
  return loadImageTexture(
    shared,
    regionTextureCacheKey(url, region, repeat),
    url,
    repeat,
    region,
  );
}

// The shared image loader behind both getters: a 1×1 transparent placeholder now, the decoded image
// (whole, or cropped to `region`) uploaded when it lands.
function loadImageTexture(
  shared: WebgpuShared,
  key: string,
  url: string,
  repeat: boolean,
  region: AtlasRegion | null,
): GpuTextureEntry {
  ensureCacheDevice(shared);
  const cached = textureCache.get(key);
  if (cached) return cached;

  const { device } = shared;
  const entry: GpuTextureEntry = {
    texture: placeholderTexture(device, key),
    view: undefined as unknown as GPUTextureView,
    sampler: samplerFor(shared, { nearest: false, repeat }),
    width: 1,
    height: 1,
    loaded: false,
    listeners: new Set(),
  };
  entry.view = entry.texture.createView();
  textureCache.set(key, entry);

  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    // The entry may have been dropped by a device loss between `src` and `onload`; uploading into
    // a dead device is pointless and the listeners belong to surfaces that are gone.
    if (textureCache.get(key) !== entry || cacheDevice !== device) return;
    const naturalW = Math.max(1, image.naturalWidth || 1);
    const naturalH = Math.max(1, image.naturalHeight || 1);
    // A region is clamped to the decoded page: a stale/oversized region descriptor must crop to
    // something rather than make `copyExternalImageToTexture` throw out of an image callback.
    const width = region
      ? Math.max(1, Math.min(Math.round(region.width), naturalW))
      : naturalW;
    const height = region
      ? Math.max(1, Math.min(Math.round(region.height), naturalH))
      : naturalH;
    const originX = region
      ? Math.max(0, Math.min(Math.round(region.x), naturalW - width))
      : 0;
    const originY = region
      ? Math.max(0, Math.min(Math.round(region.y), naturalH - height))
      : 0;
    try {
      const uploaded = createWebgpuRgbaTexture(device, width, height, key);
      uploadWebgpuExternalImage(device, uploaded, {
        source: image,
        origin: [originX, originY],
      });
      const texture = uploaded.texture;
      entry.texture.destroy();
      entry.texture = texture;
      entry.view = texture.createView();
      entry.width = width;
      entry.height = height;
    } catch {
      // Upload refused (a tainted cross-origin image, a size past the device limit): the entry
      // stays the transparent placeholder, which draws nothing — the same visible outcome as the
      // GL path's failed `texImage2D`.
      return;
    }
    markLoaded(entry);
  };
  image.src = url;
  return entry;
}

/**
 * A procedurally baked texture (the particle colour LUT: a 256×1 gradient), uploaded SYNCHRONOUSLY
 * — the pixels already exist, so there is no placeholder state and `loaded` is true on return.
 * `key` is the caller's stable spec key, the same one it hands `getBakedTexture` on the GL side
 * (`particle-lut:${JSON.stringify(spec)}`), so identical samplers across nodes share one texture.
 */
export function getBakedTextureGpu(
  shared: WebgpuShared,
  key: string,
  bake: () => HTMLCanvasElement | BakedPixels,
  opts: GpuBakedTextureOptions = {},
): GpuTextureEntry {
  ensureCacheDevice(shared);
  const cached = textureCache.get(key);
  if (cached) return cached;

  const { device } = shared;
  const baked = bake();
  const isCanvas = typeof (baked as BakedPixels).data === "undefined";
  const width = Math.max(1, Math.round(baked.width) || 1);
  const height = Math.max(1, Math.round(baked.height) || 1);
  const uploaded = createWebgpuRgbaTexture(device, width, height, key);
  const texture = uploaded.texture;
  if (isCanvas) {
    uploadWebgpuExternalImage(device, uploaded, {
      source: baked as HTMLCanvasElement,
    });
  } else {
    const pixels = (baked as BakedPixels).data;
    uploadWebgpuRgba(device, uploaded, pixels);
  }
  const entry: GpuTextureEntry = {
    texture,
    view: texture.createView(),
    sampler: samplerFor(shared, {
      nearest: opts.nearest === true,
      repeat: opts.repeat === true,
    }),
    width,
    height,
    loaded: true,
    listeners: new Set(),
  };
  textureCache.set(key, entry);
  return entry;
}

/** Module-scoped samplers: filtering + wrap is a two-bit space, so four objects serve every entry
 *  and a per-texture sampler would only add driver-side state. */
function samplerFor(
  shared: WebgpuShared,
  opts: { nearest: boolean; repeat: boolean },
): GPUSampler {
  const key = `${opts.nearest ? "nearest" : "linear"}:${opts.repeat ? "repeat" : "clamp"}`;
  const cached = samplerCache.get(key);
  if (cached) return cached;
  const sampler = createWebgpuSampler(shared.device, opts);
  samplerCache.set(key, sampler);
  return sampler;
}

function placeholderTexture(device: GPUDevice, label: string): GPUTexture {
  const uploaded = createWebgpuRgbaTexture(device, 1, 1, label);
  uploadWebgpuRgba(device, uploaded, new Uint8Array([0, 0, 0, 0]));
  return uploaded.texture;
}

function markLoaded(entry: GpuTextureEntry): void {
  entry.loaded = true;
  for (const listener of [...entry.listeners]) listener();
  entry.listeners.clear();
}

// The cache lives and dies with the device: a lost device invalidates every texture in it, and a
// re-acquire hands out a NEW `GPUDevice` whose bind groups cannot reference the old one's objects.
function ensureCacheDevice(shared: WebgpuShared): void {
  if (cacheDevice === shared.device) return;
  clearCache();
  cacheDevice = shared.device;
  unsubscribeLost = onWebgpuDeviceLost(clearCache);
}

function clearCache(): void {
  for (const entry of textureCache.values()) {
    try {
      destroyWebgpuTexture(entry.texture);
    } catch {
      // Destroying against a lost device is a no-op that some implementations still refuse.
    }
  }
  textureCache.clear();
  samplerCache.clear();
  cacheDevice = null;
  unsubscribeLost?.();
  unsubscribeLost = null;
}

/** TEST-ONLY: the live cache keys, for asserting they match the GL cache's for the same inputs. */
export function __webgpuTextureCacheKeysForTest(): string[] {
  return [...textureCache.keys()];
}

/** TEST-ONLY: drop every cached texture/sampler so a suite can re-probe with a fresh stub device. */
export function __resetWebgpuTextureCacheForTest(): void {
  clearCache();
}
