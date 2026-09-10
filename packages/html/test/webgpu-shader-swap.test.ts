// jsdom (gsw default env).
//
// THE FROZEN-SURFACE IMAGE SWAP ON A WEBGPU SHADER BINDING — the v2 path (`src/surface-image-swap`'s
// CAPTURE-HOOK SOURCES, `src/webgpu/still-capture.ts`, and the gate in `src/webgl/runtime.ts`).
//
// v1 never attached the swapper to a WebGPU binding at all: the swap encoded FROM the node canvas,
// and reading a WebGPU canvas is blank headless and pathological on Android. v2 attaches it with an
// async CAPTURE HOOK instead — the backend re-renders the frozen frame into an offscreen texture and
// `copyTextureToBuffer`s it back — so what this suite pins is that the indirection is real and
// bounded:
//
//   - a frozen binding does swap, and the readback happens ONCE for the frame (not per reconcile);
//   - the `<img>` takes the canvas's place in paint order and the canvas is hidden;
//   - a LIVE binding never swaps, because a live frame is not frozen output and reports no key;
//   - a device loss releases the swap (gauge and URLs back to 0) and the WebGL rebuild re-attaches
//     on the SYNCHRONOUS path — no capture hook, because that canvas can be read directly;
//   - a capture the device refuses is a counted failure that leaves the surface on its canvas and
//     cannot wedge the encode queue.
//
// The WebGPU side is the recording stub (`support/webgpu-stub`), so this is about the WIRING, never
// about pixels; the pixels are the desktop swap-parity test's job
// (packages/test-harness/test/webgpuSwapParityBrowser.test.ts).
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { SELF_LAYER_CLASS } from "../src/render-structure";
import {
  __resetStaticImageSwapForTest,
  liveStaticImageUrlCount,
  STATIC_SURFACE_IMAGE_ATTR,
} from "../src/surface-image-swap";
import {
  __resetShaderSourceRequestsForTest,
  __resetStaticShaderFrameCacheForTest,
  createWebglShaderRuntime,
} from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { __resetWebgpuForTest } from "../src/webgpu/device";
import { __resetWebgpuShaderProgramsForTest } from "../src/webgpu/render-shader";
import { __resetWebgpuTextureCacheForTest } from "../src/webgpu/textures";
import {
  installWebgpuStub,
  type WebgpuStubHandle,
  type WebgpuStubOptions,
} from "./support/webgpu-stub";

// A TIME shader: frozen mode pins TIME, which is what makes the frame nameable by a content key.
const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";

let drawCount = 0;

function fakeGl(): unknown {
  const overrides: Record<string, (...args: unknown[]) => unknown> = {
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
    drawArrays: () => {
      drawCount += 1;
      return undefined;
    },
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

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (turns = 10): Promise<void> => {
  for (let i = 0; i < turns; i++) await flush();
};

// ---- encode / decode / object-URL stubs (jsdom has none of these) ------------------------------

let blobSources: HTMLCanvasElement[] = [];
let createdUrls: string[] = [];
let revokedUrls: string[] = [];
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
  URL.revokeObjectURL = ((url: string): void => {
    revokedUrls.push(url);
  }) as typeof URL.revokeObjectURL;
  // The conversion from captured bytes to a 2D canvas needs the browser's `ImageData`, which jsdom
  // does not ship (it is part of the optional canvas implementation).
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

let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;

beforeAll(() => {
  (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return new Proxy({}, { get: () => () => undefined });
    return null;
  }) as typeof HTMLCanvasElement.prototype.getContext;
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
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  restoreEncodeStubs();
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticShaderFrameCacheForTest();
  __resetShaderSourceRequestsForTest();
  __resetStaticImageSwapForTest();
  __resetWebgpuForTest();
  __resetWebgpuShaderProgramsForTest();
  __resetWebgpuTextureCacheForTest();
  drawCount = 0;
  rafQueue = [];
  blobSources = [];
  createdUrls = [];
  revokedUrls = [];
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  stub?.uninstall();
  stub = null;
  document.body.innerHTML = "";
});

// The GL program cache is module-scoped and never reset (by design — it survives remounts), so each
// test uses its own shader path.
let shaderSeq = 0;
function mountNode(modulate = "1,1,1,1"): { root: HTMLElement; path: string } {
  const path = `res://swap-${++shaderSeq}.gdshader`;
  const root = document.createElement("div");
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", modulate);
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  Object.defineProperty(self, "clientWidth", {
    get: () => 100,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => 50,
    configurable: true,
  });
  node.appendChild(self);
  root.appendChild(node);
  document.body.appendChild(root);
  return { root, path };
}

const canvasEl = (): HTMLCanvasElement | null =>
  document.querySelector<HTMLCanvasElement>("[data-godot-shader-canvas]");
const standIn = (): HTMLImageElement | null =>
  document.querySelector<HTMLImageElement>(`[${STATIC_SURFACE_IMAGE_ATTR}]`);
const readbacks = (handle: WebgpuStubHandle): number =>
  handle.calls.filter((call) => call.name === "encoder.copyTextureToBuffer")
    .length;

/** Drive the runtime until the swap engages, or give up. ONE render establishes the content key and
 *  each clean `reconcile()` is one further observation of it (a frozen node is never visited by the
 *  loop again, which is why the reconcile clock exists at all). Bounded so a broken gate fails as a
 *  missing swap rather than as a hang. */
async function driveUntilSwapped(
  rt: { reconcile(): void; stats(): { staticImagesLive: number } },
  passes = 8,
): Promise<number> {
  for (let pass = 0; pass < passes; pass++) {
    rt.reconcile();
    flushRaf();
    await settle();
    if (rt.stats().staticImagesLive > 0) return pass + 1;
  }
  return -1;
}

describe("frozen WebGPU shader surfaces swap through the capture hook", () => {
  it("freezes to an <img> with exactly ONE readback, hiding the canvas in place", async () => {
    const handle = withWebgpu();
    const { root } = mountNode();
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
      staticShaderTime: 1,
      staticShaderImages: true,
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");
    const canvas = canvasEl();
    expect(canvas).not.toBeNull();
    // The frozen frame is rendered once, by the WebGPU backend — the GL path drew nothing.
    flushRaf();
    await settle();
    expect(drawCount).toBe(0);

    expect(await driveUntilSwapped(rt)).toBeGreaterThan(0);

    const img = standIn();
    expect(img).not.toBeNull();
    // In the canvas's exact place in paint order, with the canvas hidden (no box, no layer).
    expect(img?.nextElementSibling).toBe(canvas);
    expect(canvas?.style.display).toBe("none");

    const stats = rt.stats();
    expect(stats.staticImageSwaps).toBe(1);
    expect(stats.staticImagesLive).toBe(1);
    expect(stats.staticImageEncodes).toBe(1);
    expect(stats.staticImageCaptures).toBe(1);
    expect(stats.staticImageCaptureFailures).toBe(0);
    expect(stats.staticImageFailures).toBe(0);
    // ONE readback for the frame, however many reconciles observed it — the encode is per KEY.
    expect(readbacks(handle)).toBe(1);
    // And it was NOT the node canvas that got encoded: a WebGPU canvas is unreadable, so the source
    // is the throwaway canvas the capture hook produced.
    expect(blobSources.length).toBe(1);
    expect(blobSources[0]).not.toBe(canvas);

    rt.dispose();
    // The leak probe: the URL goes with the last holder.
    expect(liveStaticImageUrlCount()).toBe(0);
  });

  it("never swaps a LIVE binding — an animating frame is not frozen output", async () => {
    const handle = withWebgpu();
    const { root } = mountNode();
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: false,
      staticShaderImages: true,
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");

    for (let i = 0; i < 8; i++) {
      rt.reconcile();
      flushRaf();
      await settle();
    }

    expect(standIn()).toBeNull();
    expect(rt.stats().staticImageSwaps).toBe(0);
    expect(rt.stats().staticImagesLive).toBe(0);
    expect(readbacks(handle)).toBe(0);
    expect(createdUrls).toEqual([]);
    rt.dispose();
  });

  it("a device loss releases the swap, and the WebGL rebuild re-attaches on the SYNC path", async () => {
    const handle = withWebgpu();
    const { root } = mountNode();
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
      staticShaderTime: 1,
      staticShaderImages: true,
    } as never);
    rt.reconcile();
    await settle();
    expect(await driveUntilSwapped(rt)).toBeGreaterThan(0);
    expect(rt.stats().staticImagesLive).toBe(1);
    expect(liveStaticImageUrlCount()).toBe(1);

    // A driver reset takes every WebGPU surface — and the canvas ELEMENTS, since a canvas that held
    // a webgpu context can never yield a 2d one.
    handle.loseDevice("reset");
    await settle();

    expect(rt.stats().renderer).toBe("webgl");
    // The swap state went with the bindings: the gauge falls and no URL is left pinned.
    expect(rt.stats().staticImagesLive).toBe(0);
    expect(liveStaticImageUrlCount()).toBe(0);
    expect(standIn()).toBeNull();

    // Rebuilt on WebGL, the surface re-earns its swap — and it does so by reading its OWN canvas,
    // because a 2D-backed canvas needs no capture at all.
    const capturesBefore = rt.stats().staticImageCaptures;
    const readbacksBefore = readbacks(handle);
    expect(await driveUntilSwapped(rt)).toBeGreaterThan(0);
    expect(rt.stats().staticImagesLive).toBe(1);
    expect(rt.stats().staticImageCaptures).toBe(capturesBefore);
    expect(readbacks(handle)).toBe(readbacksBefore);
    expect(blobSources[blobSources.length - 1]).toBe(canvasEl());
    rt.dispose();
  });

  it("a REFUSED capture is counted and leaves the surface on its canvas, without wedging", async () => {
    const handle = withWebgpu();
    const { root } = mountNode();
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
      staticShaderTime: 1,
      staticShaderImages: true,
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");

    // The capture allocates an offscreen target; a device that refuses it reports nothing back.
    const device = handle.device as unknown as {
      createTexture: (descriptor: GPUTextureDescriptor) => unknown;
    };
    const realCreateTexture = device.createTexture;
    device.createTexture = (descriptor: GPUTextureDescriptor): unknown => {
      if (descriptor.label === "gsw-shader-capture") {
        throw new Error("out of memory");
      }
      return realCreateTexture.call(device, descriptor);
    };

    expect(await driveUntilSwapped(rt)).toBe(-1);
    const stats = rt.stats();
    expect(stats.staticImagesLive).toBe(0);
    expect(stats.staticImageCaptureFailures).toBeGreaterThan(0);
    // A capture failure is still a failure: the aggregate keeps its meaning.
    expect(stats.staticImageFailures).toBeGreaterThanOrEqual(
      stats.staticImageCaptureFailures,
    );
    expect(stats.staticImageCaptures).toBe(0);
    expect(standIn()).toBeNull();
    expect(canvasEl()?.style.display).not.toBe("none");
    expect(createdUrls).toEqual([]);

    // NOT wedged: the runtime keeps rendering and reconciling normally afterwards.
    rt.reconcile();
    flushRaf();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");
    rt.dispose();
  });

  // ---- the blank guard -------------------------------------------------------------------------
  //
  // A device that reads back NOTHING — the readback completes, reports no error, and the bytes are
  // all zero. Measured for real, headed under Xvfb on Chrome's default ANGLE backend
  // (docs/perf-harness.md, S8): every surface swapped, every counter said so, and the page showed
  // nothing. `renderedPixel: null` is that device.

  it("a readback that comes back EMPTY refuses the swap and leaves the canvas up", async () => {
    const handle = withWebgpu({ renderedPixel: null });
    const { root } = mountNode();
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
      staticShaderTime: 1,
      staticShaderImages: true,
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");

    expect(await driveUntilSwapped(rt)).toBe(-1);

    const stats = rt.stats();
    // The surface is exactly where it was, which is the entire point: a canvas that is painting
    // stays on screen instead of being hidden behind a PNG of nothing.
    expect(standIn()).toBeNull();
    expect(canvasEl()?.style.display).not.toBe("none");
    expect(stats.staticImagesLive).toBe(0);
    expect(stats.staticImageEncodes).toBe(0);
    expect(createdUrls).toEqual([]);
    // Named, not inferred from a hole in the numbers.
    expect(stats.staticImageBlankCaptures).toBe(1);
    expect(stats.staticImageCaptureFailures).toBe(1);
    expect(stats.staticImageFailures).toBe(1);
    expect(stats.staticImageCaptures).toBe(0);
    // TERMINAL: eight further reconciles bought exactly one readback in total, so a device in this
    // state cannot be made to re-render and re-copy every surface forever.
    expect(readbacks(handle)).toBe(1);
    rt.dispose();
  });

  it("a node MODULATED to alpha 0 still freezes on that same empty readback", async () => {
    // The load-bearing exception. An invisible frame is not always a broken readback, and where the
    // runtime can SEE that the frame is legitimately invisible it must not claim coverage — refusing
    // this surface would leave a live canvas up forever, which is the cost the swap exists to
    // remove. Same device as the test above; only the node's modulate differs.
    const handle = withWebgpu({ renderedPixel: null });
    const { root } = mountNode("1,1,1,0");
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
      staticShaderTime: 1,
      staticShaderImages: true,
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");

    expect(await driveUntilSwapped(rt)).toBeGreaterThan(0);

    const stats = rt.stats();
    expect(standIn()).not.toBeNull();
    expect(canvasEl()?.style.display).toBe("none");
    expect(stats.staticImageBlankCaptures).toBe(0);
    expect(stats.staticImageCaptures).toBe(1);
    expect(readbacks(handle)).toBe(1);
    rt.dispose();
  });
});
