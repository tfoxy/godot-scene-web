// jsdom (gsw default env).
//
// THE FROZEN-SURFACE IMAGE SWAP ON A WEBGPU PARTICLE BINDING — the v2 path (`staticParticleImages`
// over `src/surface-image-swap`'s CAPTURE-HOOK SOURCES, wired in `src/particles/runtime.ts`'s
// `attachSurfaceSwap`).
//
// v1 gated the whole mechanism on the surface having a 2D context, because the swap encoded the
// canvas's OWN pixels and a WebGPU canvas cannot be read back. v2 registers such a binding with an
// async CAPTURE HOOK instead: the backend re-renders the frame into an offscreen texture and copies
// it back. Particles need NO new frozen-frame signal for this — `notePaint` is renderer-agnostic and
// the WebGPU frozen path already ends there — so what these pin is the two ends of the mechanism on
// this renderer:
//
//   - a quiet window really does elapse into a capture + a swapped `<img>`, with the canvas hidden;
//   - a subsequent PAINT thaws it, attributed to the "draw" cause — the quiet-window gate's whole
//     correctness argument, which does not change just because the pixels arrived by readback;
//   - and FREEZE AT MOUNT's claim (`staticParticleFreezeAtMount`), which is worth more here than
//     anywhere: what a second appearance skips on this renderer is a WebGPU context, an offscreen
//     render target and a `copyTextureToBuffer` — the most expensive surface gsw has.
//
// Harness: `particles-webgpu-gate.test.ts` (fake WebGL2/2D contexts, hand-flushed rAF, the shared
// ResizeObserver stub, a stubbed `performance.now`) plus the swap's own INJECTED clock/timer seams,
// which are independent of the rAF loop's clock and are what make a quiet window a deliberate act.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { __resetWebgpuParticleProgramForTest } from "../src/particles/render-webgpu";
import { createParticleRuntime } from "../src/particles/runtime";
import { __resetStaticParticleFrameCacheForTest } from "../src/particles/static-frame-cache";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import {
  __resetStaticImageSwapForTest,
  liveStaticImageUrlCount,
  STATIC_SURFACE_IMAGE_ATTR,
  type StaticSurfacePolicy,
} from "../src/surface-image-swap";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { __resetWebgpuForTest } from "../src/webgpu/device";
import { __resetWebgpuTextureCacheForTest } from "../src/webgpu/textures";
import { makeResizeObserverStub } from "./support/resize-observer-stub";
import {
  installWebgpuStub,
  type WebgpuStubHandle,
  type WebgpuStubOptions,
} from "./support/webgpu-stub";

function fakeGl(): unknown {
  const overrides: Record<string, () => unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    getActiveUniform: () => null,
    getExtension: () => null,
    getParameter: () => "",
    createShader: () => ({}),
    createProgram: () => ({}),
    createTexture: () => ({}),
    createBuffer: () => ({}),
    createVertexArray: () => ({}),
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
  return q.length;
}

let clockMs = 0;
const TICK_MS = 34;
function pumpTick(): void {
  clockMs += TICK_MS;
  flushRaf();
}

const origSetTimeout = globalThis.setTimeout;
const nextTask = (): Promise<void> =>
  new Promise((resolve) => origSetTimeout(resolve, 0));
async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) await nextTask();
}

// ---- encode / decode / object-URL stubs (jsdom has none of these) ------------------------------

let blobSources: HTMLCanvasElement[] = [];
let createdUrls: string[] = [];
let urlSeq = 0;

let origToBlob: HTMLCanvasElement["toBlob"];
let origDecode: HTMLImageElement["decode"] | undefined;
let origCreateObjectURL: typeof URL.createObjectURL;
let origRevokeObjectURL: typeof URL.revokeObjectURL;
let origImageData: unknown;

function installEncodeStubs(): void {
  origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function toBlob(
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
  ): void {
    blobSources.push(this);
    callback(new Blob(["frame"], { type }));
  };
  origDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = (): Promise<void> => Promise.resolve();
  origCreateObjectURL = URL.createObjectURL;
  origRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = ((): string => {
    const url = `blob:stub/${++urlSeq}`;
    createdUrls.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  // The captured bytes reach a 2D canvas through `ImageData`, which jsdom does not ship.
  origImageData = (globalThis as Record<string, unknown>).ImageData;
  (globalThis as Record<string, unknown>).ImageData = class {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

function restoreEncodeStubs(): void {
  HTMLCanvasElement.prototype.toBlob = origToBlob;
  if (origDecode) HTMLImageElement.prototype.decode = origDecode;
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
  (globalThis as Record<string, unknown>).ImageData = origImageData;
}

let stub: WebgpuStubHandle | null = null;
function withWebgpu(options: WebgpuStubOptions = {}): WebgpuStubHandle {
  stub = installWebgpuStub(options);
  return stub;
}

/** Every `getContext` call, with the element it was made on — the spy the ZERO-CANVAS claim below
 *  is proved with (a claimed surface must never ask for a rendering context). */
let contextCalls: Array<{ canvas: object; kind: string }> = [];
const contextCallsFor = (canvas: object): number =>
  contextCalls.filter((call) => call.canvas === canvas).length;

let nowSpy: ReturnType<typeof vi.spyOn> | null = null;
let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;

beforeAll(() => {
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: object,
    kind: string,
  ) {
    contextCalls.push({ canvas: this, kind });
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return new Proxy({}, { get: () => () => undefined });
    return null;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    rafQueue.push(cb)) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame =
    (() => {}) as typeof globalThis.cancelAnimationFrame;
  origRO = globalThis.ResizeObserver;
  installEncodeStubs();
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  restoreEncodeStubs();
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  __resetStaticImageSwapForTest();
  __resetWebgpuForTest();
  __resetWebgpuParticleProgramForTest();
  __resetWebgpuTextureCacheForTest();
  rafQueue = [];
  clockMs = 0;
  blobSources = [];
  createdUrls = [];
  contextCalls = [];
  globalThis.ResizeObserver = makeResizeObserverStub();
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clockMs);
});

afterEach(() => {
  stub?.uninstall();
  stub = null;
  nowSpy?.mockRestore();
  nowSpy = null;
  document.body.innerHTML = "";
});

// ---- the swap's injected clock (independent of the rAF loop's) --------------------------------

function scheduler() {
  let nowMs = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: (): number => nowMs,
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = ++seq;
      timers.set(id, { at: nowMs + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    async advance(ms: number): Promise<void> {
      const target = nowMs + ms;
      for (;;) {
        let dueId = -1;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueId = id;
          }
        }
        if (dueId < 0) break;
        const timer = timers.get(dueId);
        timers.delete(dueId);
        nowMs = Math.max(nowMs, dueAt);
        timer?.fn();
        await settle();
      }
      nowMs = Math.max(nowMs, target);
      await settle();
    },
  };
}

const QUIET_MS = 1000;

function quietPolicy(clock: ReturnType<typeof scheduler>): StaticSurfacePolicy {
  return {
    gate: { kind: "quiet-window", quietMs: QUIET_MS },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
}

// ---- fixtures ----------------------------------------------------------------------------------

// blendMode 0 (non-additive): the additive path reaches an accumulator FBO that the fake GL cannot
// stand up — the constraint every particle runtime test works under.
function spec(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "GPUParticles2D",
    amount: 8,
    lifetime: 4,
    emitting: true,
    explosiveness: 1,
    initialVelocityMin: 50,
    initialVelocityMax: 50,
    blendMode: 0,
    ...over,
  });
}

function mountRoot(specJson = spec()): {
  root: HTMLElement;
  self: HTMLElement;
} {
  const root = document.createElement("div");
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", specJson);
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  Object.defineProperty(self, "clientWidth", {
    get: () => 100,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => 100,
    configurable: true,
  });
  node.appendChild(self);
  root.appendChild(node);
  document.body.appendChild(root);
  return { root, self };
}

/** Another particle node (same spec, same box) appended to an existing root — the fixture the
 *  second-appearance tests need, which `mountRoot` cannot give (it makes its own root). */
function particleNodeIn(root: HTMLElement, specJson = spec()): HTMLElement {
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", specJson);
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  Object.defineProperty(self, "clientWidth", {
    get: () => 100,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => 100,
    configurable: true,
  });
  node.appendChild(self);
  root.appendChild(node);
  return self;
}

const canvasEl = (): HTMLCanvasElement | null =>
  document.querySelector<HTMLCanvasElement>("[data-godot-particle-canvas]");
const standIn = (): HTMLImageElement | null =>
  document.querySelector<HTMLImageElement>(`[${STATIC_SURFACE_IMAGE_ATTR}]`);
const readbacks = (handle: WebgpuStubHandle): number =>
  handle.calls.filter((call) => call.name === "encoder.copyTextureToBuffer")
    .length;

describe("frozen WebGPU particle surfaces swap through the capture hook", () => {
  it("swaps to an <img> once the quiet window elapses, capturing rather than reading the canvas", async () => {
    const handle = withWebgpu();
    const clock = scheduler();
    const { root } = mountRoot();
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");

    // The frozen frame is drawn once; after that the surface stands still and its window runs.
    pumpTick();
    await settle();
    const canvas = canvasEl();
    expect(canvas).not.toBeNull();
    expect(standIn()).toBeNull(); // the window has not elapsed

    await clock.advance(QUIET_MS + 1);

    const img = standIn();
    expect(img).not.toBeNull();
    // The stand-in takes the canvas's exact place in paint order, and the canvas is hidden.
    expect(img?.nextElementSibling).toBe(canvas);
    expect(canvas?.style.display).toBe("none");

    const stats = rt.stats();
    expect(stats.staticImageSwaps).toBe(1);
    expect(stats.staticImagesLive).toBe(1);
    expect(stats.staticImageCaptures).toBe(1);
    expect(stats.staticImageCaptureFailures).toBe(0);
    expect(stats.staticImageEncodes).toBe(1);
    // Exactly one readback, and the encode read the capture's throwaway canvas — never the WebGPU
    // one, which cannot be read at all.
    expect(readbacks(handle)).toBe(1);
    expect(blobSources.length).toBe(1);
    expect(blobSources[0]).not.toBe(canvas);

    rt.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });

  it("a subsequent PAINT thaws the swap, attributed to the 'draw' cause", async () => {
    withWebgpu();
    const clock = scheduler();
    const { root } = mountRoot();
    // A LIVE runtime, which is the population the quiet-window gate is really for: a system that
    // has stopped moving is not a system that was declared frozen, and the only evidence either way
    // is its own paints. Ticks are hand-pumped, so "quiet" here means what it says.
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");
    pumpTick();
    await settle();

    await clock.advance(QUIET_MS + 1);
    expect(standIn()).not.toBeNull();
    expect(rt.stats().staticImagesLive).toBe(1);
    expect(rt.stats().staticImageCaptures).toBe(1);

    // One more tick and the surface repaints. The quiet-window gate has given up the content-key
    // invariant, so a paint is the only evidence it has — and it acts on it INSTANTLY rather than
    // waiting for the watchdog to notice.
    pumpTick();
    await settle();

    expect(standIn()).toBeNull();
    expect(canvasEl()?.style.display).not.toBe("none");
    const stats = rt.stats();
    expect(stats.staticImagesLive).toBe(0);
    expect(stats.staticImageReverts).toBe(1);
    expect(stats.staticImageRevertsByCause.draw).toBe(1);
    rt.dispose();
  });
});

// ---- the blank guard ---------------------------------------------------------------------------
//
// A device whose readback completes, reports nothing wrong, and hands back an ENTIRELY TRANSPARENT
// frame (`renderedPixel: null`) — measured for real, headed under Xvfb on Chrome's default ANGLE
// backend, where all 12 surfaces swapped and the page showed nothing (docs/perf-harness.md, S8).
//
// The pair below is the whole judgement: the SAME all-zero readback, opposite verdicts, decided only
// by whether the runtime packed any instances for the capture it just took.

describe("an empty readback is refused only where the runtime knows it drew", () => {
  it("a system WITH live particles keeps its canvas and books staticImageBlankCaptures", async () => {
    const handle = withWebgpu({ renderedPixel: null });
    const clock = scheduler();
    const { root } = mountRoot();
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");
    pumpTick();
    await settle();

    await clock.advance(QUIET_MS + 1);

    // No stand-in, and the canvas that is painting is still the thing on screen.
    expect(standIn()).toBeNull();
    expect(canvasEl()?.style.display).not.toBe("none");
    const stats = rt.stats();
    expect(stats.staticImagesLive).toBe(0);
    expect(stats.staticImageEncodes).toBe(0);
    expect(createdUrls).toEqual([]);
    expect(stats.staticImageBlankCaptures).toBe(1);
    expect(stats.staticImageCaptureFailures).toBe(1);
    expect(stats.staticImageFailures).toBe(1);
    expect(stats.staticImageCaptures).toBe(0);

    // TERMINAL, and therefore not a spin: ten more seconds of windows buy no second readback.
    await clock.advance(10_000);
    expect(readbacks(handle)).toBe(1);
    expect(rt.stats().staticImageBlankCaptures).toBe(1);
    rt.dispose();
  });

  it("a system with NOTHING alive freezes on that same empty readback", async () => {
    // The load-bearing exception. A system that has emitted nothing draws nothing — `drawBinding`
    // CLEARS the canvas instead of drawing when the pack loop produced no instances — so its frame
    // is legitimately blank and its readback is legitimately empty. Refusing it would hold a live
    // canvas in the composite forever, which is the cost this whole mechanism exists to remove.
    const handle = withWebgpu({ renderedPixel: null });
    const clock = scheduler();
    const { root } = mountRoot(spec({ emitting: false }));
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");
    pumpTick();
    await settle();

    await clock.advance(QUIET_MS + 1);

    expect(standIn()).not.toBeNull();
    expect(canvasEl()?.style.display).toBe("none");
    const stats = rt.stats();
    expect(stats.staticImageBlankCaptures).toBe(0);
    expect(stats.staticImageCaptures).toBe(1);
    expect(stats.staticImageEncodes).toBe(1);
    expect(stats.staticImagesLive).toBe(1);
    expect(readbacks(handle)).toBe(1);
    rt.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });
});

// ---- freeze at mount, on the capture-hook renderer ----------------------------------------------

describe("freeze at mount claims a still on WebGPU too — with no readback", () => {
  it("the second appearance mounts as <img> with no context and no second capture", async () => {
    const handle = withWebgpu();
    const clock = scheduler();
    const root = document.createElement("div");
    particleNodeIn(root);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticleFreezeAtMount: true,
      staticParticleImages: {
        // The frame key is a complete description of a pristine particle frame, so a keyed surface
        // has nothing to wait for; retention is what keeps the encoded still claimable afterwards.
        gate: { kind: "quiet-window", quietMs: QUIET_MS, keyedQuietMs: 0 },
        encode: { stillCacheBytes: 1 << 20 },
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      },
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");
    pumpTick(); // the first appearance warms, draws and reports its key
    await settle();
    await clock.advance(2);

    // ONE readback for the whole family: the capture hook re-rendered this binding's frame into an
    // offscreen texture and copied it back, and the encode read that throwaway canvas.
    expect(rt.stats().staticImageCaptures).toBe(1);
    expect(readbacks(handle)).toBe(1);
    expect(rt.stats().staticImageEncodes).toBe(1);
    expect(standIn()).not.toBeNull();

    contextCalls = [];
    const second = particleNodeIn(root);
    rt.reconcile();
    expect(rt.stats().staticStillCacheHits).toBe(1);
    await settle();

    const secondCanvas = second.querySelector<HTMLCanvasElement>(
      "[data-godot-particle-canvas]",
    );
    expect(secondCanvas).not.toBeNull();
    // THE CLAIM. On this renderer the alternative would have been a WebGPU context, an offscreen
    // render target and a `copyTextureToBuffer` — the most expensive surface gsw has. None happened.
    expect(contextCallsFor(secondCanvas as object)).toBe(0);
    expect(readbacks(handle)).toBe(1);
    expect(rt.stats().staticImageCaptures).toBe(1);
    expect(rt.stats().staticImageEncodes).toBe(1);
    expect(rt.stats().staticStillMounts).toBe(1);
    expect(rt.stats().staticImagesLive).toBe(2);

    rt.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });
});
