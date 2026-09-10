// The PAGE half of the WebGL↔WebGPU image-parity harness.
//
// esbuild bundles this file (`conditions: ["development"]`, so `@godot-scene-web/html` resolves to
// its TypeScript SOURCE rather than a possibly-stale `dist/`) and the test injects it with
// `page.addScriptTag`. It exposes ONE object on `window`; everything else about the page — the
// fixture list, the comparison, the artifacts — lives node-side.
//
// WHAT THIS MOUNTS. The SHIPPED runtimes, through their public factories, from DOM nodes carrying
// the same `data-godot-*` attributes the renderer emits (`createParticleRuntime` reads one
// `data-godot-particle-specs` JSON blob per node; `createWebglShaderRuntime` reads
// `data-godot-shader-*` off the node and its self-layer). Nothing here re-derives a simulation, a
// canvas size or a draw: a parity harness that rendered its own version of the pipeline would be
// comparing two things neither of which ships.
//
// WHAT MAKES A FRAME COMPARABLE. Both runtimes are put in FROZEN mode — `staticParticles` warms
// each system once from its seed and parks the loop, `staticShaders` + `staticShaderTime` render
// one frame at a pinned TIME — so "the frame" is a pure function of the fixture, not of when the
// capture happened to run.

import { SELF_LAYER_CLASS } from "@godot-scene-web/html";
import type { GodotHtmlMountOptions } from "@godot-scene-web/html/runtime";
import {
  createParticleRuntime,
  createWebglShaderRuntime,
} from "@godot-scene-web/html/runtime";
import {
  FIXTURE_SHADER_TIME,
  type ParityFixture,
  type ShaderParityFixture,
} from "./fixtures";
import { bytesToBase64, premultiplyRgba } from "./pixels";

/**
 * `shared-gl.ts` DECLINES a software renderer (SwiftShader here, llvmpipe in CI) and caches that
 * decision module-scoped on the first `getShared()`, so without this every binding would silently
 * become a no-op and the harness would compare two blank canvases and call them equal. Set at
 * module scope — this bundle owns its page, unlike the perf-harness bundle which shares one.
 */
(globalThis as Record<string, unknown>).__gswForceWebglShaders = true;

/** How long one fixture may take to produce its first real draw. */
const RENDER_TIMEOUT_MS = 10000;
/**
 * How long a WebGPU side may stay `renderer === "pending"`.
 *
 * Comfortably past `webgpu/device.ts`'s own 8 s `ACQUIRE_TIMEOUT_MS`, so an acquire that times out
 * reports itself as the FALLBACK it becomes (with its reason) instead of racing this timeout and
 * being reported as "never resolved".
 */
const ADOPTION_TIMEOUT_MS = 15000;
/**
 * How long the frame must stand STILL before it is captured.
 *
 * A draw is not blocked on texture decode: the runtime draws with whatever is resolved (a 1x1
 * transparent placeholder for a sprite, red 0 for a mask — i.e. an invisible system) and redraws
 * when the image lands. So "it rendered once" is not "it rendered the picture", and the capture
 * waits for a quiet window on top of the first `onBindingRendered`.
 */
const SETTLE_QUIET_MS = 150;

/** Which renderer a side asks the runtimes for — passed straight through as `effectsRenderer`.
 *  Pinned explicitly on both sides: `"auto"` (the shipped default) would let the reference side
 *  silently become the thing under test on any box that happens to have a WebGPU adapter. */
export interface RenderSide {
  effectsRenderer?: "auto" | "webgl" | "webgpu";
}

export interface CapturedFrame {
  width: number;
  height: number;
  /** Top-down, PREMULTIPLIED RGBA, base64. See `premultiplyRgba` for why premultiplied. */
  pixelsB64: string;
  /**
   * How the pixels were read: `"capture-hook"` = the runtime's WebGPU `captureNodePixels` readback,
   * `"2d"` = `getImageData` off the node's own 2D blit canvas (the WebGL path).
   *
   * ASSERTED node-side, not merely recorded. It is the difference between "the WebGPU backend drew
   * this" and "something fell back to WebGL and the harness read the fallback's canvas" — the exact
   * way a cross-backend comparison can quietly become WebGL-vs-WebGL and pass.
   */
  capture: "capture-hook" | "2d";
  /** The runtime's own draw counters, so a test can prove the frame was DRAWN and not blitted out
   *  of the module-scoped static-frame cache. */
  draws: number;
  cacheHits: number;
  /** Distinct `onBindingRendered` calls for this node — 1 for a clean frozen frame, more when a
   *  texture landed and forced a redraw. */
  renders: number;
  /** `stats().renderer` — `"webgpu"`/`"webgl"`/`"pending"`/`"none"`. The RUNTIME's gauge. */
  renderer: string | null;
  webgpuFallbacks: number | null;
  webgpuFallbackReason: string | null;
  /** Shader runtime only (the particle runtime has no per-binding choice): bindings that fell back
   *  to WebGL BY THEMSELVES under a WebGPU runtime — a shader WGSL cannot express. */
  webgpuBindingFallbacks: number | null;
  /**
   * `data-godot-effects-backend` off the node's canvas — the per-BINDING oracle.
   *
   * Only the WebGPU SHADER backend stamps it (`webgpu/render-shader.ts`), so `null` on a particle
   * node says nothing; on a shader node it is what tells a WebGPU binding from one that fell back
   * while the runtime as a whole stayed on WebGPU.
   */
  bindingBackend: string | null;
}

interface CaptureResult {
  width: number;
  height: number;
  pixels: Uint8Array;
  capture: "capture-hook" | "2d";
  /**
   * Whether `pixels` is ALREADY premultiplied.
   *
   * The readback hook's contract is premultiplied (a `GPUCanvasContext` has no straight-alpha mode,
   * so the WGSL returns `rgb*a` and the readback re-renders that same fragment); `getImageData` is
   * straight alpha. Premultiplying the hook's output a second time would darken every soft edge on
   * the WebGPU side only — a difference that looks exactly like a real backend bug and would have
   * been "calibrated" away into the tolerance.
   */
  premultiplied: boolean;
}

/**
 * The WebGPU readback seam (WP-6/WP-7).
 *
 * `captureNodePixels(node)` is an offscreen rgba8unorm re-render of the frozen frame plus
 * `copyTextureToBuffer` + `mapAsync`. It has to exist because a WebGPU canvas can never be read
 * through `drawImage`/`toDataURL` (measured: pathological on Android Chrome, blank on SwiftShader)
 * — the S7 "never blit from a WebGPU canvas" law.
 *
 * It returns BARE BYTES, tightly packed top-down premultiplied RGBA at the canvas BACKING-STORE
 * size — no dimensions of its own, which is why the caller reads them off the canvas.
 *
 * `null` is a MEANINGFUL answer, not an error: the binding is on WebGL. That is every binding of a
 * WebGL runtime, and — in the shader runtime, which chooses per binding — a single screen-texture
 * node under an otherwise-WebGPU runtime. Both fall through to `getImageData` below, which is the
 * WebGL path's real output, blit included.
 */
interface CaptureCapableRuntime {
  captureNodePixels?: (node: HTMLElement) => Promise<Uint8Array | null>;
}

interface MountedRuntime {
  reconcile: () => void;
  dispose: () => void;
  /** NOTE: both runtimes return the SAME live object every call and mutate it in place, so a
   *  "before" snapshot has to be copied out, never held by reference. */
  stats: () => {
    draws: number;
    cacheHits: number;
    renderer?: string;
    webgpuFallbacks?: number;
    webgpuFallbackReason?: string | null;
    /** Shader runtime only. */
    webgpuBindingFallbacks?: number;
    /** The frozen-surface image swap's gauges/counters — read by `renderSwappedStill` only. */
    staticImagesLive?: number;
    staticImageSwaps?: number;
    staticImageCaptures?: number;
    staticImageCaptureFailures?: number;
    /** Captures the swap REFUSED as entirely transparent for a surface the renderer knew it drew
     *  (`@godot-scene-web/html`'s BLANK CAPTURES). Must be 0 on any rung whose readback works —
     *  a non-zero here is the launch-mode hazard, not a comparison failure. */
    staticImageBlankCaptures?: number;
    staticImageFailures?: number;
  };
}

const HOST_ID = "gsw-parity-host";

/** `at` moves the host away from the viewport's top-left. Only the compositor test passes it (it
 *  needs page background on every side of the canvas); the parity capture reads the canvas's own
 *  pixels and does not care where it sits, so its call keeps the original 0,0. */
function host(at?: { left: number; top: number }): HTMLElement {
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    if (at) {
      existing.style.left = `${at.left}px`;
      existing.style.top = `${at.top}px`;
    }
    return existing;
  }
  const element = document.createElement("div");
  element.id = HOST_ID;
  // Top-left of the viewport and opaque-free: the canvases must be on screen (the runtimes park
  // dormant bindings that are not) but nothing must paint over or under them.
  Object.assign(element.style, {
    position: "absolute",
    left: `${at?.left ?? 0}px`,
    top: `${at?.top ?? 0}px`,
    background: "transparent",
  });
  document.body.appendChild(element);
  return element;
}

/** The node's own paint layer, found by both runtimes with a DIRECT-child `.godot-scene-self-layer`
 *  lookup. The class is imported, never spelled, so it cannot drift from the renderer's. */
function buildSelfLayer(): HTMLElement {
  const layer = document.createElement("div");
  layer.className = SELF_LAYER_CLASS;
  Object.assign(layer.style, { position: "absolute", inset: "0" });
  return layer;
}

function buildParticleNode(fixture: ParityFixture): HTMLElement {
  const node = document.createElement("div");
  Object.assign(node.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: `${fixture.cellPx}px`,
    height: `${fixture.cellPx}px`,
  });
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-path", `parity/${fixture.name}`);
  if (fixture.kind === "particles") {
    node.setAttribute(
      "data-godot-particle-specs",
      JSON.stringify(fixture.spec),
    );
  }
  node.appendChild(buildSelfLayer());
  return node;
}

function buildShaderNode(fixture: ShaderParityFixture): HTMLElement {
  const node = document.createElement("div");
  Object.assign(node.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: `${fixture.cellPx}px`,
    height: `${fixture.cellPx}px`,
  });
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute(
    "data-godot-shader-path",
    `res://parity/${fixture.name}.gdshader`,
  );
  // A distinct uid per fixture: the runtime caches compiled programs and frozen frames by shader
  // key, and two fixtures sharing a key would share the other's frame.
  node.setAttribute(
    "data-godot-shader-uid",
    `uid://gsw-parity-${fixture.name}`,
  );
  node.setAttribute("data-godot-shader-params", JSON.stringify(fixture.params));
  if (fixture.modulate) {
    node.setAttribute("data-godot-shader-modulate", fixture.modulate);
  }
  const layer = buildSelfLayer();
  if (fixture.uvWindow) {
    layer.setAttribute("data-godot-shader-uv-window", fixture.uvWindow);
  }
  node.appendChild(layer);
  return node;
}

/**
 * Decode a fixture's images BEFORE the runtime is mounted.
 *
 * The runtime's own texture loader is async and its first draw happens without waiting. Warming the
 * browser's image cache first means the runtime's `new Image()` for the same data-URL resolves
 * almost immediately, so the settle window has something to settle ON rather than a race.
 */
async function preloadImages(urls: string[]): Promise<void> {
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.onload = () => resolve();
          image.onerror = () => resolve();
          image.src = url;
        }),
    ),
  );
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** The render options both runtimes are built from, for one fixture on one side.
 *
 *  `swap` ARMS the frozen-surface image swap, which every other capture path here must have OFF: it
 *  replaces a settled canvas with an encoded `<img>`, i.e. a second image codec inside a pixel
 *  comparison. `renderSwappedStill` is the one caller that wants exactly that, because the codec
 *  round trip IS what it measures. */
function renderOptions(
  fixture: ParityFixture,
  side: RenderSide,
  onRendered: (node: HTMLElement, canvas: HTMLCanvasElement) => void,
  swap = false,
): GodotHtmlMountOptions {
  const options: Record<string, unknown> = {
    enableParticles: true,
    enableWebglShaders: true,
    // FROZEN on both runtimes: warm-once from the seed, one draw at a pinned TIME, then park.
    staticParticles: true,
    staticShaders: true,
    staticShaderTime: FIXTURE_SHADER_TIME,
    // The surface-image swap replaces a settled canvas with an encoded `<img>`. It is ON by default
    // for shaders, and it would hand this harness a re-encoded PNG of the frame instead of the
    // frame — a second image codec inside a pixel comparison. Off on both runtimes.
    staticParticleImages: false,
    staticShaderImages: false,
    renderScale: 1,
    effectsProfiling: true,
    resolveShaderSource: () =>
      fixture.kind === "shader" ? fixture.source : undefined,
    onBindingRendered: onRendered,
  };
  if (swap) {
    // A particle surface reports a NULL content key on every paint (its frame is the bitmap of a
    // simulation, not a pure function of anything nameable), so its only usable gate is the quiet
    // window — shortened here because a frozen fixture is quiet the moment it has drawn, and the
    // test should not spend the default second waiting to be told so.
    options.staticParticleImages = {
      gate: { kind: "quiet-window", quietMs: 100 },
    };
    options.staticShaderImages = true;
  }
  if (side.effectsRenderer) {
    options.effectsRenderer = side.effectsRenderer;
  }
  return options as GodotHtmlMountOptions;
}

/**
 * Read a node's frame back as top-down straight-alpha RGBA.
 *
 * The parameterized half of the harness: a runtime that offers `captureNodePixels` (the WebGPU
 * readback hook) is asked first, and the WebGL path falls through to `getImageData` on the 2D
 * canvas the runtime blitted into — which is the shipped output, blit included.
 */
async function capturePixels(
  runtime: MountedRuntime,
  node: HTMLElement,
  canvas: HTMLCanvasElement,
): Promise<CaptureResult> {
  const hook = (runtime as unknown as CaptureCapableRuntime).captureNodePixels;
  if (typeof hook === "function") {
    const pixels = await hook.call(runtime, node);
    if (pixels) {
      // The hook reads back the node's OWN canvas, so the canvas's backing store is the frame's
      // size — the same number `getImageData` is asked for on the other side, which is what makes
      // the two captures comparable without any scaling.
      const { width, height } = canvas;
      const wanted = width * height * 4;
      if (pixels.length !== wanted) {
        throw new Error(
          `webgpu-parity: captureNodePixels returned ${pixels.length} bytes for a ${width}x${height} canvas (expected ${wanted}) — the readback and the canvas disagree about the frame's size, so every pixel after the first row would be compared against the wrong one`,
        );
      }
      return {
        width,
        height,
        pixels,
        capture: "capture-hook",
        premultiplied: true,
      };
    }
  }
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) {
    throw new Error(
      "webgpu-parity: the node's canvas has no 2D context — a WebGPU-backed canvas must supply captureNodePixels() instead (never drawImage/toDataURL a WebGPU canvas)",
    );
  }
  if (canvas.width === 0 || canvas.height === 0) {
    throw new Error(
      `webgpu-parity: the node's canvas is ${canvas.width}x${canvas.height} — nothing was sized`,
    );
  }
  const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
  return {
    width: canvas.width,
    height: canvas.height,
    pixels: new Uint8Array(data.data.buffer.slice(0)),
    capture: "2d",
    premultiplied: false,
  };
}

/**
 * Wait for a WebGPU side to have ADOPTED WebGPU, and fail loudly if it adopted WebGL instead.
 *
 * The runtimes' WebGPU gate is asynchronous and SILENT BY DESIGN: no `navigator.gpu`, no adapter, a
 * software adapter, an acquire timeout, a pipeline error — each quietly becomes WebGL and keeps
 * drawing the right picture. That is correct for a product and fatal for this harness, whose whole
 * claim is that the two sides are different backends. Without this gate a fallback produces a
 * PASSING run in which both sides were WebGL, which is the one failure mode a parity suite must
 * never have.
 *
 * `renderer` goes `"pending"` → `"webgpu" | "webgl"`, so this waits out `"pending"` and then reads
 * the verdict. It is checked BEFORE the render/settle wait so a fallback reports its own reason
 * rather than timing out later behind a generic "never settled" message.
 */
async function awaitAdoption(
  runtime: MountedRuntime,
  fixture: ParityFixture,
  side: RenderSide,
): Promise<void> {
  if (side.effectsRenderer !== "webgpu") {
    return;
  }
  const deadline = performance.now() + ADOPTION_TIMEOUT_MS;
  while (runtime.stats().renderer === "pending") {
    if (performance.now() > deadline) {
      throw new Error(
        `webgpu-parity: fixture "${fixture.name}" (${fixture.kind}) was still "pending" after ${ADOPTION_TIMEOUT_MS} ms — the WebGPU device never resolved and the runtime never even fell back`,
      );
    }
    await nextFrame();
  }
  const stats = runtime.stats();
  if (stats.renderer !== "webgpu") {
    throw new Error(
      `webgpu-parity: fixture "${fixture.name}" (${fixture.kind}) asked for effectsRenderer:"webgpu" but the runtime adopted "${stats.renderer}" (webgpuFallbacks=${stats.webgpuFallbacks}, webgpuFallbackReason=${stats.webgpuFallbackReason}). Comparing this against the WebGL side would be comparing WebGL against WebGL and reporting it as cross-backend parity.`,
    );
  }
}

/** A fixture that has been mounted and has SETTLED, still alive on the page. */
interface MountedFixture {
  runtime: MountedRuntime;
  node: HTMLElement;
  canvas: HTMLCanvasElement;
  /** `onBindingRendered` calls for this node so far — read at capture time, not at settle time. */
  renderCount: () => number;
}

/**
 * Build a fixture's node, mount the shipped runtime over it, and wait for a settled frame — the
 * half `renderFixture` (capture then dispose) and `mountFixture` (keep it on the page for a
 * screenshot) share, so the two can never disagree about what "mounted and settled" means.
 */
async function mountAndSettle(
  fixture: ParityFixture,
  side: RenderSide,
  at?: { left: number; top: number },
  swap = false,
): Promise<MountedFixture> {
  await preloadImages(fixture.kind === "particles" ? fixture.images : []);

  const container = host(at);
  container.style.width = `${fixture.cellPx}px`;
  container.style.height = `${fixture.cellPx}px`;
  const node =
    fixture.kind === "particles"
      ? buildParticleNode(fixture)
      : buildShaderNode(fixture);
  container.appendChild(node);

  let renders = 0;
  let lastRenderAt = 0;
  let canvas: HTMLCanvasElement | null = null;
  const onRendered = (rendered: HTMLElement, drawn: HTMLCanvasElement) => {
    if (rendered !== node) {
      return;
    }
    renders++;
    lastRenderAt = performance.now();
    canvas = drawn;
  };

  const options = renderOptions(fixture, side, onRendered, swap);
  const runtime = (fixture.kind === "particles"
    ? createParticleRuntime(container, options)
    : createWebglShaderRuntime(
        container,
        options,
      )) as unknown as MountedRuntime;

  try {
    runtime.reconcile();

    await awaitAdoption(runtime, fixture, side);

    // Wait for a first real draw (`onBindingRendered` fires only on a draw that reached
    // `drawParticles`/`gl.drawArrays` — never on a cache-hit blit or a skip), then for the frame to
    // stop changing.
    const deadline = performance.now() + RENDER_TIMEOUT_MS;
    while (
      renders === 0 ||
      performance.now() - lastRenderAt < SETTLE_QUIET_MS
    ) {
      if (performance.now() > deadline) {
        throw new Error(
          `webgpu-parity: fixture "${fixture.name}" (${fixture.kind}) produced ${renders} render(s) in ${RENDER_TIMEOUT_MS} ms and never settled — the runtime is not drawing here (no WebGL2? the software-renderer decline? an unresolved shader source?), and capturing anyway would publish a blank canvas as a result`,
        );
      }
      await nextFrame();
    }
    if (!canvas) {
      throw new Error(
        `webgpu-parity: fixture "${fixture.name}" reported a render without a canvas`,
      );
    }
    return { runtime, node, canvas, renderCount: () => renders };
  } catch (error) {
    // Only the FAILED mount tears itself down here; a successful one is disposed by its caller
    // (`renderFixture` after the capture, never by `mountFixture` — see there).
    runtime.dispose();
    node.remove();
    throw error;
  }
}

async function renderFixture(
  fixture: ParityFixture,
  side: RenderSide = {},
): Promise<CapturedFrame> {
  const { runtime, node, canvas, renderCount } = await mountAndSettle(
    fixture,
    side,
  );

  try {
    const captured = await capturePixels(runtime, node, canvas);
    const stats = runtime.stats();
    return {
      width: captured.width,
      height: captured.height,
      // PREMULTIPLIED before it leaves the page: the WebGPU side is premultiplied by construction
      // (`GPUCanvasContext` has no straight-alpha mode), and dividing it back out would divide by
      // zero over every transparent pixel of a particle canvas.
      //
      // ONLY the straight-alpha `getImageData` path is converted. The readback hook already returns
      // premultiplied bytes, and multiplying those again would scale every partially-transparent
      // pixel by alpha twice — darkening exactly the soft edges this suite measures, on the WebGPU
      // side alone, in a way that reads as a backend bug.
      pixelsB64: bytesToBase64(
        captured.premultiplied
          ? captured.pixels
          : premultiplyRgba(captured.pixels),
      ),
      capture: captured.capture,
      draws: stats.draws,
      cacheHits: stats.cacheHits,
      renders: renderCount(),
      renderer: stats.renderer ?? null,
      webgpuFallbacks: stats.webgpuFallbacks ?? null,
      webgpuFallbackReason: stats.webgpuFallbackReason ?? null,
      webgpuBindingFallbacks: stats.webgpuBindingFallbacks ?? null,
      bindingBackend: canvas.getAttribute("data-godot-effects-backend"),
    };
  } finally {
    // Dispose between fixtures: bindings, canvases and GL buffers go, so the next fixture starts
    // from the same state this one did. (The module-scoped caches — programs, textures, frozen
    // frames — deliberately SURVIVE, exactly as they do in a real page; the test keeps the two
    // sides in separate pages so one side can never be served the other's cached frame.)
    runtime.dispose();
    node.remove();
  }
}

// ---------------------------------------------------------------------------------------------
// The SWAPPED STILL: what the frozen-surface image swap actually publishes
// ---------------------------------------------------------------------------------------------

/** How long the swap may take to engage after the frame has settled. Generous: the gate needs
 *  several observations (shaders) or a quiet window (particles), and then a GPU readback, a PNG
 *  encode and an image decode. */
const SWAP_TIMEOUT_MS = 10000;
/** The attribute the swap stamps on its stand-in — a published DOM contract of the html package. */
const SWAP_IMAGE_ATTR = "data-godot-shader-image";

export interface SwappedStillFrame {
  /** The stand-in's intrinsic size. Asserted node-side to equal the canvas BACKING STORE: the swap
   *  encodes the backing store and presents it at the CSS box, so an `<img>` that came back at the
   *  CSS size would mean the frame was resampled somewhere. */
  width: number;
  height: number;
  /** The `<img>`'s decoded pixels, PREMULTIPLIED, base64 — what the page really shows. */
  stillB64: string;
  /** The same frozen frame straight from the renderer (`captureNodePixels`, already premultiplied),
   *  captured from the SAME live binding — the thing the still is compared against. */
  referenceB64: string;
  referenceWidth: number;
  referenceHeight: number;
  /** `"capture-hook"` on WebGPU, `"2d"` on WebGL. Asserted node-side: a WebGL-fallback comparison
   *  would be measuring the codec round trip only, and would pass for the wrong reason. */
  capture: "capture-hook" | "2d";
  renderer: string | null;
  webgpuFallbacks: number | null;
  webgpuFallbackReason: string | null;
  bindingBackend: string | null;
  /** The swap's own bookkeeping, so a failed run says WHY rather than just "no image". */
  staticImagesLive: number;
  staticImageCaptures: number;
  staticImageCaptureFailures: number;
  /** Captures refused as entirely transparent — 0 on a working readback rung (see the swap's BLANK
   *  CAPTURES). Reported so a run that produced no stand-in can say WHICH failure it was. */
  staticImageBlankCaptures: number;
  staticImageFailures: number;
}

/** The `<img>` the swap stood in for this node's canvas, or null while it has not swapped yet. */
function standInFor(node: HTMLElement): HTMLImageElement | null {
  return node.querySelector<HTMLImageElement>(`[${SWAP_IMAGE_ATTR}]`);
}

/**
 * Drive the runtime until one surface has actually swapped.
 *
 * SHADERS need the reconcile clock: a frozen node renders once and the loop never visits it again,
 * so "nothing asked this binding to re-render" is what evidence of a frozen surface looks like and
 * each clean `reconcile()` is one observation of the content key.
 *
 * PARTICLES must NOT be reconciled in a loop: their gate is the quiet window, measured from the
 * surface's own paints, and a reconcile that provoked a repaint would reset the very window it is
 * waiting on. It just waits.
 */
async function awaitSwapEngaged(
  runtime: MountedRuntime,
  fixture: ParityFixture,
): Promise<void> {
  const deadline = performance.now() + SWAP_TIMEOUT_MS;
  for (;;) {
    if ((runtime.stats().staticImagesLive ?? 0) >= 1) return;
    if (performance.now() > deadline) {
      const stats = runtime.stats();
      throw new Error(
        `webgpu-parity: fixture "${fixture.name}" (${fixture.kind}) never swapped to an <img> within ${SWAP_TIMEOUT_MS} ms — staticImagesLive=${stats.staticImagesLive}, captures=${stats.staticImageCaptures}, captureFailures=${stats.staticImageCaptureFailures}, blankCaptures=${stats.staticImageBlankCaptures}, failures=${stats.staticImageFailures}, renderer=${stats.renderer}, webgpuFallbackReason=${stats.webgpuFallbackReason}. A non-zero blankCaptures is the launch mode, not the code: the capture produced no visible pixels — an empty readback, or a 2D canvas that kept none of them — so nothing was published and the canvas was left up (see the swap's BLANK CAPTURES). Without a stand-in there is nothing to compare, and capturing the canvas instead would silently test the path this hook exists to leave behind.`,
      );
    }
    if (fixture.kind === "shader") runtime.reconcile();
    await nextFrame();
  }
}

/** Decode the stand-in and read its pixels back as STRAIGHT-alpha RGBA at its intrinsic size. This
 *  is the full publish path — unpremultiply, PNG encode, decode, and the 2D canvas's own
 *  premultiply/unpremultiply round trip — which is exactly what the tolerance has to cover. */
async function decodeStandIn(
  img: HTMLImageElement,
  fixture: ParityFixture,
): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  await img.decode();
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (width < 1 || height < 1) {
    throw new Error(
      `webgpu-parity: fixture "${fixture.name}" swapped to an <img> that decoded to ${width}x${height}`,
    );
  }
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const ctx2d = scratch.getContext("2d");
  if (!ctx2d) {
    throw new Error("webgpu-parity: no 2D context for the stand-in readback");
  }
  ctx2d.clearRect(0, 0, width, height);
  ctx2d.drawImage(img, 0, 0);
  const data = ctx2d.getImageData(0, 0, width, height);
  return { width, height, pixels: new Uint8Array(data.data.buffer.slice(0)) };
}

/**
 * Mount a fixture frozen WITH THE SWAP ARMED, wait for the `<img>` to go up, and return both what
 * the page now shows and what the renderer would draw.
 *
 * WHY THIS EXISTS. Every other capture here reads the RENDERER. This one reads the PUBLISHED
 * ARTEFACT, which on a WebGPU binding has been through a readback, an unpremultiply, a PNG encode
 * and a decode before anything is composited — a chain with no pixel test on it at all until now.
 * The two are compared in PREMULTIPLIED space for the same reason every other comparison here is:
 * the renderer side has no straight-alpha form, and dividing it out would divide by zero over the
 * transparent majority of a particle canvas.
 */
async function renderSwappedStill(
  fixture: ParityFixture,
  side: RenderSide = {},
): Promise<SwappedStillFrame> {
  const { runtime, node, canvas } = await mountAndSettle(
    fixture,
    side,
    undefined,
    true,
  );
  try {
    await awaitSwapEngaged(runtime, fixture);
    const img = standInFor(node);
    if (!img) {
      throw new Error(
        `webgpu-parity: fixture "${fixture.name}" reports staticImagesLive=${runtime.stats().staticImagesLive} but no [${SWAP_IMAGE_ATTR}] under its node`,
      );
    }
    const still = await decodeStandIn(img, fixture);
    // The reference comes from the SAME still-live binding, so the two are the same frame by
    // construction rather than by two mounts agreeing.
    const reference = await capturePixels(runtime, node, canvas);
    const stats = runtime.stats();
    return {
      width: still.width,
      height: still.height,
      // The stand-in's pixels are straight (a decoded PNG read through `getImageData`); the
      // reference is premultiplied already when it came from the readback hook.
      stillB64: bytesToBase64(premultiplyRgba(still.pixels)),
      referenceB64: bytesToBase64(
        reference.premultiplied
          ? reference.pixels
          : premultiplyRgba(reference.pixels),
      ),
      referenceWidth: reference.width,
      referenceHeight: reference.height,
      capture: reference.capture,
      renderer: stats.renderer ?? null,
      webgpuFallbacks: stats.webgpuFallbacks ?? null,
      webgpuFallbackReason: stats.webgpuFallbackReason ?? null,
      bindingBackend: canvas.getAttribute("data-godot-effects-backend"),
      staticImagesLive: stats.staticImagesLive ?? 0,
      staticImageCaptures: stats.staticImageCaptures ?? 0,
      staticImageCaptureFailures: stats.staticImageCaptureFailures ?? 0,
      staticImageBlankCaptures: stats.staticImageBlankCaptures ?? 0,
      staticImageFailures: stats.staticImageFailures ?? 0,
    };
  } finally {
    runtime.dispose();
    node.remove();
  }
}

/**
 * A fixture mounted and settled and LEFT ON THE PAGE, described in page coordinates.
 *
 * For the Xvfb compositor test (`test/webgpuCompositeXvfb.test.ts`), which asserts on a
 * `page.screenshot()` — i.e. on what the browser's COMPOSITOR made of the canvas, the one thing
 * texture readback structurally cannot see. It needs the frame to still be there when the shot is
 * taken (so: no dispose) and it needs to know WHERE, in page pixels, to sample.
 */
export interface MountedFixtureInfo {
  /** The node's viewport rect, CSS px — the frame of reference every sample point is stated in. */
  node: { left: number; top: number; width: number; height: number };
  /** The runtime's own canvas rect. Recorded for diagnosis: a canvas that composites in the wrong
   *  place makes every sample wrong, and this is what tells that apart from a wrong colour. */
  canvas: { left: number; top: number; width: number; height: number };
  /** `stats().renderer` — the gauge that says whether WebGPU was really adopted or silently
   *  fell back. A compositor test that measured the WebGL fallback would pass vacuously. */
  renderer: string | null;
  webgpuFallbacks: number | null;
  webgpuFallbackReason: string | null;
  renders: number;
  draws: number;
}

/** Mounted runtimes are kept alive here: nothing else references them once `mountFixture` returns,
 *  and a disposed (or collected) runtime takes its canvas off the page before the screenshot. */
const keptAlive: MountedRuntime[] = [];

async function mountFixture(
  fixture: ParityFixture,
  side: RenderSide = {},
  at?: { left: number; top: number },
): Promise<MountedFixtureInfo> {
  const mounted = await mountAndSettle(fixture, side, at);
  keptAlive.push(mounted.runtime);
  const stats = mounted.runtime.stats();
  const nodeRect = mounted.node.getBoundingClientRect();
  const canvasRect = mounted.canvas.getBoundingClientRect();
  return {
    node: {
      left: nodeRect.left,
      top: nodeRect.top,
      width: nodeRect.width,
      height: nodeRect.height,
    },
    canvas: {
      left: canvasRect.left,
      top: canvasRect.top,
      width: canvasRect.width,
      height: canvasRect.height,
    },
    renderer: stats.renderer ?? null,
    webgpuFallbacks: stats.webgpuFallbacks ?? null,
    webgpuFallbackReason: stats.webgpuFallbackReason ?? null,
    renders: mounted.renderCount(),
    draws: stats.draws,
  };
}

/**
 * Whether this browser can give us a real WebGPU DEVICE — the gate side B needs.
 *
 * Deliberately goes all the way to `requestDevice`, not just `requestAdapter`. Measured on this
 * box: an adapter can be handed out where the device request then fails ("A valid external Instance
 * reference no longer exists"), and an adapter-only gate would let the suite run and then fail every
 * fixture with a fallback error rather than skipping honestly. Two other environment facts this
 * interacts with, both measured:
 *
 *  - a `page.setContent` page is NOT a secure context and Chrome hides `navigator.gpu` there
 *    ENTIRELY, so a page must be served from a real origin (the tests route-fulfil `http://localhost`)
 *    or this returns false for a reason that has nothing to do with the box;
 *  - readback needs no compositor and works headless, but the DEVICE needs a working instance —
 *    hence the tests' headless-then-headed launch ladder.
 */
async function hasWebgpu(): Promise<boolean> {
  const gpu = (
    navigator as {
      gpu?: {
        requestAdapter(): Promise<{
          requestDevice(): Promise<unknown>;
        } | null>;
      };
    }
  ).gpu;
  if (!gpu) {
    return false;
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return false;
    }
    return (await adapter.requestDevice()) !== null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// WGSL corpus validation
// ---------------------------------------------------------------------------------------------

/** One transpiled module to validate: a name for the report and the WGSL the emitter produced. */
export interface WgslModuleToValidate {
  name: string;
  wgsl: string;
}

export interface WgslCompilationMessage {
  severity: string;
  message: string;
  lineNum: number;
  linePos: number;
}

export interface WgslValidationResult {
  name: string;
  errors: WgslCompilationMessage[];
  warnings: WgslCompilationMessage[];
}

/**
 * Compile WGSL strings in a REAL WGSL compiler and report what it said.
 *
 * This is the only proof that exists that the emitter produces VALID WGSL. The node-side tests can
 * check that a rule fired and that a byte offset is what it should be, but "is this a legal WGSL
 * program" is a question only a WGSL front-end can answer — and the interesting cases are exactly
 * the ones regexes cannot reach (uniformity analysis on `fwidth` inside a uniform-bounded loop, for
 * instance, which is a whole-program dataflow property).
 *
 * Its own device, acquired straight from `navigator.gpu` rather than through the html package's
 * `acquireWebgpuDevice()`: that helper DECLINES software adapters by policy, and whether this box's
 * adapter is software has nothing to do with whether the WGSL is well-formed.
 *
 * `getCompilationInfo()` is the reporting path; the error scope around `createShaderModule` is a
 * belt-and-braces catch for a validation error that never surfaces as a compilation message.
 */
async function validateWgslModules(
  modules: WgslModuleToValidate[],
): Promise<WgslValidationResult[]> {
  const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
  if (!gpu) {
    throw new Error(
      "webgpu-parity: navigator.gpu is absent — WGSL validation needs a real compiler (is the page on a secure origin?)",
    );
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error("webgpu-parity: no WebGPU adapter for WGSL validation");
  }
  const device = await adapter.requestDevice();
  const results: WgslValidationResult[] = [];
  try {
    for (const module of modules) {
      const errors: WgslCompilationMessage[] = [];
      const warnings: WgslCompilationMessage[] = [];
      device.pushErrorScope("validation");
      let shaderModule: GPUShaderModule | null = null;
      try {
        shaderModule = device.createShaderModule({
          code: module.wgsl,
          label: module.name,
        });
      } catch (error) {
        errors.push({
          severity: "error",
          message: `createShaderModule threw: ${String(error)}`,
          lineNum: 0,
          linePos: 0,
        });
      }
      if (shaderModule) {
        const info = await shaderModule.getCompilationInfo();
        for (const message of info.messages) {
          const entry: WgslCompilationMessage = {
            severity: String(message.type),
            message: message.message,
            lineNum: message.lineNum,
            linePos: message.linePos,
          };
          if (message.type === "error") {
            errors.push(entry);
          } else if (message.type === "warning") {
            warnings.push(entry);
          }
        }
      }
      const scoped = await device.popErrorScope();
      if (scoped && errors.length === 0) {
        errors.push({
          severity: "error",
          message: `validation error scope: ${scoped.message}`,
          lineNum: 0,
          linePos: 0,
        });
      }
      results.push({ name: module.name, errors, warnings });
    }
  } finally {
    device.destroy();
  }
  return results;
}

export interface WebgpuParityHook {
  hasWebgpu(): Promise<boolean>;
  renderFixture(
    fixture: ParityFixture,
    side?: RenderSide,
  ): Promise<CapturedFrame>;
  /** Mount frozen WITH the surface-image swap armed and return the published `<img>`'s pixels
   *  beside the renderer's own — the only test of what the swap actually puts on the page. */
  renderSwappedStill(
    fixture: ParityFixture,
    side?: RenderSide,
  ): Promise<SwappedStillFrame>;
  /** Mount and settle a fixture and LEAVE it on the page — for screenshot-based tests. */
  mountFixture(
    fixture: ParityFixture,
    side?: RenderSide,
    at?: { left: number; top: number },
  ): Promise<MountedFixtureInfo>;
  /** Compile transpiled WGSL in this browser's real WGSL front-end and report its messages. */
  validateWgslModules(
    modules: WgslModuleToValidate[],
  ): Promise<WgslValidationResult[]>;
}

const hook: WebgpuParityHook = {
  hasWebgpu,
  renderFixture,
  renderSwappedStill,
  mountFixture,
  validateWgslModules,
};
(window as unknown as Record<string, unknown>).__gswWebgpuParity = hook;
