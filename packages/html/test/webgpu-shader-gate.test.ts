// jsdom (gsw default env).
//
// The shader runtime's RENDERER GATE and its PER-BINDING fallback (`effectsRenderer`, see
// ../src/types.ts and the gate block in ../src/webgl/runtime.ts).
//
// THE GUARANTEE THIS SUITE EXISTS TO PIN, first test below: `effectsRenderer` defaults to `"auto"`,
// and jsdom has no `navigator.gpu`, so WebGL is adopted SYNCHRONOUSLY — no promise, no microtask, no
// deferred create. That is what keeps every other shader test in this package on the byte-identical
// path it was on before WebGPU existed, and it is why the default could be flipped on at all.
//
// THE SECOND THING IT PINS is the per-BINDING half. A shader that samples SCREEN_TEXTURE cannot run
// on WebGPU (capturing what was already composited is a runtime-architecture question, not a
// translation one), but it must not veto its neighbours: one such node renders on WebGL while every
// other node on the same runtime presents from its own WebGPU canvas. Counting it
// (`webgpuBindingFallbacks`) is the only way that stays visible — the symptom otherwise is a node
// that is quietly slower than the ones beside it.
//
// The WebGPU side is the recording stub (`support/webgpu-stub`), so this is about the GATE's
// decisions and bookkeeping, never about pixels; WebGL↔WebGPU image parity is the browser harness's
// job.
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

import { SELF_LAYER_CLASS } from "../src/render-structure";
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

// A TIME shader: `usesTime` keeps the loop alive, so a tick per `flushRaf` is observable.
const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";
// The shape WGSL cannot express — sampling what was already composited. `transpileGodotShaderWgsl`
// throws `UnsupportedWgslShaderError` for it, which is the per-binding fallback's trigger.
const SCREEN_SHADER = `shader_type canvas_item;
uniform sampler2D SCREEN_TEXTURE : hint_screen_texture, filter_nearest;
void fragment() { COLOR = texture(SCREEN_TEXTURE, SCREEN_UV + vec2(TIME * 0.001, 0.0)); }`;

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

// Controllable rAF: queue callbacks, flush them by hand so a tick is a deliberate act.
let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
  return q.length;
}

/** Drain the microtask AND macrotask queues. The gate is a chain of awaits over promises the stub
 *  resolves immediately — device, then device-scope state, then this shader's module and pipeline —
 *  and the create it gates is itself async (the shader source resolve), so a few turns of both
 *  settle everything without a real timer. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (turns = 10): Promise<void> => {
  for (let i = 0; i < turns; i++) await flush();
};

let stub: WebgpuStubHandle | null = null;
function withWebgpu(options: WebgpuStubOptions = {}): WebgpuStubHandle {
  // Installed OVER the fake `getContext` below, which the stub delegates every non-"webgpu" kind to
  // — so a runtime on this page can hand one binding a WebGPU context and the next a real 2D one,
  // which is exactly what the per-binding fallback needs.
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
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticShaderFrameCacheForTest();
  __resetShaderSourceRequestsForTest();
  __resetWebgpuForTest();
  __resetWebgpuShaderProgramsForTest();
  __resetWebgpuTextureCacheForTest();
  drawCount = 0;
  rafQueue = [];
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

// Each test uses its OWN shader path: the GL program cache is module-scoped and never reset (by
// design — it survives remounts), so sharing a key would let one test's compiled program answer for
// another's.
let shaderSeq = 0;
function shaderNode(path: string): HTMLElement {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  // A non-zero box so `syncCanvasSize` makes a > 0 canvas (a zero-sized one renders nothing).
  Object.defineProperty(self, "clientWidth", {
    get: () => 100,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => 50,
    configurable: true,
  });
  node.appendChild(self);
  return node;
}

/** A root holding `count` nodes of one shader, mounted. Returns the root and the shader's path. */
function mountRoot(count: number): { root: HTMLElement; path: string } {
  const path = `res://gate-${++shaderSeq}.gdshader`;
  const root = document.createElement("div");
  for (let i = 0; i < count; i++) root.appendChild(shaderNode(path));
  document.body.appendChild(root);
  return { root, path };
}

const canvases = (): HTMLCanvasElement[] =>
  Array.from(document.querySelectorAll("[data-godot-shader-canvas]"));

const webgpuCanvases = (): HTMLCanvasElement[] =>
  canvases().filter(
    (canvas) => canvas.getAttribute("data-godot-effects-backend") === "webgpu",
  );

const callCount = (handle: WebgpuStubHandle, name: string): number =>
  handle.calls.filter((call) => call.name === name).length;

describe("shader renderer gate — the synchronous branches", () => {
  it("adopts WebGL SYNCHRONOUSLY under the default 'auto' when the page has no navigator.gpu", async () => {
    // No stub installed: jsdom has no `navigator.gpu`, which is every other shader test here.
    expect((navigator as Navigator & { gpu?: unknown }).gpu).toBeUndefined();
    const { root } = mountRoot(2);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    // Adopted BEFORE anything could await — the stat is already final at construction.
    expect(rt.stats().renderer).toBe("webgl");
    rt.reconcile();
    await settle();

    flushRaf();
    expect(drawCount).toBe(2);
    expect(canvases()).toHaveLength(2);
    expect(webgpuCanvases()).toHaveLength(0);
    // Counted and explained rather than hidden — a silent fallback is only diagnosable through these.
    expect(rt.stats().webgpuFallbacks).toBe(1);
    expect(rt.stats().webgpuFallbackReason).toBe("no-navigator-gpu");
    expect(rt.stats().webgpuSubmits).toBe(0);
    expect(rt.stats().webgpuBindingFallbacks).toBe(0);
    rt.dispose();
  });

  it("effectsRenderer: 'webgl' probes NOTHING, even on a page that has WebGPU", async () => {
    const handle = withWebgpu();
    const { root } = mountRoot(1);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      effectsRenderer: "webgl",
    } as never);
    rt.reconcile();
    await settle();

    expect(handle.requestAdapterCalls).toBe(0);
    expect(rt.stats().renderer).toBe("webgl");
    // Nothing was ever ASKED for, so nothing fell back: this is what a pinned reference arm reads as.
    expect(rt.stats().webgpuFallbacks).toBe(0);
    expect(rt.stats().webgpuFallbackReason).toBeNull();
    flushRaf();
    expect(drawCount).toBe(1);
    rt.dispose();
  });
});

describe("shader renderer gate — adopting WebGPU", () => {
  it("runs PENDING until the device lands, then creates every binding on WebGPU", async () => {
    const handle = withWebgpu();
    const { root } = mountRoot(2);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();

    // PENDING: no binding exists yet, so no canvas has replaced a node's CSS/SVG paint. Waiting is
    // this runtime's answer to the pending window — a shader create SUPPRESSES that paint, so a
    // binding that could not draw yet would be a visible hole.
    expect(rt.stats().renderer).toBe("pending");
    expect(canvases()).toHaveLength(0);

    await settle();
    expect(rt.stats().renderer).toBe("webgpu");
    expect(canvases()).toHaveLength(2);
    expect(webgpuCanvases()).toHaveLength(2);
    // One configured context per binding, presenting PREMULTIPLIED frames — the only alpha mode that
    // composites over the page, and the one the transpiled fragment is written for.
    expect(handle.contexts).toHaveLength(2);
    for (const context of handle.contexts) {
      expect(context.configured?.alphaMode).toBe("premultiplied");
    }
    // The GL path drew nothing: these bindings never touch the shared context.
    expect(drawCount).toBe(0);
    rt.dispose();
  });

  it("submits ONCE per tick whatever the node count — the measured win", async () => {
    const handle = withWebgpu();
    const { root } = mountRoot(3);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");
    handle.calls.length = 0;

    flushRaf();
    // THREE render passes, ONE submit. A submit count that climbed with the node count would be the
    // batching win being given back (docs/perf-harness.md S7).
    expect(callCount(handle, "encoder.beginRenderPass")).toBe(3);
    expect(callCount(handle, "queue.submit")).toBe(1);
    expect(rt.stats().draws).toBe(3);
    expect(rt.stats().webgpuSubmits).toBe(1);

    flushRaf();
    expect(rt.stats().webgpuSubmits).toBe(2);
    expect(rt.stats().draws).toBe(6);
    rt.dispose();
  });

  it("compiles ONE pipeline for N nodes sharing a shader, and rewrites the viewport every draw", async () => {
    const handle = withWebgpu();
    const { root } = mountRoot(3);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();

    // The compilation unit is the SHADER, cached at device scope: three nodes, one module, one
    // pipeline. (Plus nothing else — a second pipeline here would mean the cache key is wrong.)
    expect(callCount(handle, "createShaderModule")).toBe(1);
    expect(callCount(handle, "createRenderPipeline")).toBe(1);

    handle.calls.length = 0;
    flushRaf();
    // Rewritten per draw rather than latched at create: a node canvas resizes, and a stale viewport
    // maps the full-screen strip onto the wrong rect with nothing to report it.
    expect(callCount(handle, "pass.setViewport")).toBe(3);
    for (const call of handle.calls.filter(
      (c) => c.name === "pass.setViewport",
    )) {
      expect(call.args.slice(0, 4)).toEqual([0, 0, 100, 50]);
    }
    // A full-screen triangle strip: four vertices, one instance, no vertex buffer.
    for (const call of handle.calls.filter((c) => c.name === "pass.draw")) {
      expect(call.args).toEqual([4, 1]);
    }
    expect(callCount(handle, "pass.setVertexBuffer")).toBe(0);
    rt.dispose();
  });
});

describe("shader renderer gate — the PER-BINDING fallback", () => {
  it("puts a SCREEN_TEXTURE binding on WebGL while its neighbour stays on WebGPU", async () => {
    const handle = withWebgpu();
    const root = document.createElement("div");
    const plainPath = `res://plain-${++shaderSeq}.gdshader`;
    const screenPath = `res://screen-${++shaderSeq}.gdshader`;
    root.appendChild(shaderNode(plainPath));
    root.appendChild(shaderNode(screenPath));
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      // The screen-reading shader compiles at all only with the capture machinery opted in.
      enableScreenTextureCapture: true,
      resolveShaderSource: async (path: string) =>
        path === screenPath ? SCREEN_SHADER : SHADER,
    } as never);
    rt.reconcile();
    await settle();

    // The RUNTIME is on WebGPU — one shader it cannot express did not veto the other.
    expect(rt.stats().renderer).toBe("webgpu");
    expect(rt.stats().webgpuBindingFallbacks).toBe(1);
    // …and the whole-runtime counters are untouched: a per-binding fallback is a different event.
    expect(rt.stats().webgpuFallbacks).toBe(0);

    const all = canvases();
    expect(all).toHaveLength(2);
    // Exactly one canvas is WebGPU-backed. The stamp is what `drawableSource` keys on to never
    // `drawImage` a WebGPU canvas into the screen capture.
    expect(webgpuCanvases()).toHaveLength(1);
    expect(handle.contexts).toHaveLength(1);

    handle.calls.length = 0;
    flushRaf();
    // BOTH render: one GL `drawArrays`, one WebGPU pass inside one submit.
    expect(drawCount).toBe(1);
    expect(callCount(handle, "encoder.beginRenderPass")).toBe(1);
    expect(callCount(handle, "queue.submit")).toBe(1);
    expect(rt.stats().draws).toBe(2);
    rt.dispose();
  });

  it("falls a binding back when its WGSL module fails to compile, and remembers the verdict", async () => {
    const handle = withWebgpu();
    handle.setCompilationMessages([
      {
        type: "error",
        message: "unresolved identifier",
        lineNum: 3,
        linePos: 5,
      },
    ]);
    // The pipeline error path is loud on purpose (`pipeline.ts` warns once); silence it here so the
    // suite output stays about the assertions.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { root } = mountRoot(2);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();

    // Both bindings are on WebGL, and the runtime is still nominally on WebGPU: the DEVICE is fine,
    // this one shader is not.
    expect(rt.stats().renderer).toBe("webgpu");
    expect(rt.stats().webgpuBindingFallbacks).toBe(2);
    expect(webgpuCanvases()).toHaveLength(0);
    // The verdict is CACHED per shader: two bindings, one compile attempt — not one per node.
    expect(callCount(handle, "createShaderModule")).toBe(1);

    flushRaf();
    expect(drawCount).toBe(2);
    warn.mockRestore();
    rt.dispose();
  });
});

describe("shader renderer gate — falling back", () => {
  it("adopts WebGL with a reason when there is no adapter", async () => {
    withWebgpu({ adapter: "null" });
    const { root } = mountRoot(1);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      effectsRenderer: "webgpu",
    } as never);
    rt.reconcile();
    await settle();

    expect(rt.stats().renderer).toBe("webgl");
    expect(rt.stats().webgpuFallbacks).toBe(1);
    expect(rt.stats().webgpuFallbackReason).toBe("no-adapter");
    // Asked for WebGPU, got WebGL, still renders: a fallback is silent, never a failure to draw.
    flushRaf();
    expect(drawCount).toBe(1);
    rt.dispose();
  });

  it("rebuilds every binding on WebGL — with NEW canvas elements — when the device is lost", async () => {
    const handle = withWebgpu();
    const { root } = mountRoot(2);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");
    const before = canvases();
    expect(before).toHaveLength(2);

    handle.loseDevice();
    await settle();

    // THE CANVASES ARE REPLACED, and they have to be: a canvas that has held a webgpu context can
    // never yield a 2d one, so the WebGL rebuild cannot reuse the elements.
    const after = canvases();
    expect(after).toHaveLength(2);
    for (const canvas of after) expect(before).not.toContain(canvas);
    expect(webgpuCanvases()).toHaveLength(0);
    expect(rt.stats().renderer).toBe("webgl");
    expect(rt.stats().webgpuFallbackReason).toBe("device-lost");
    expect(rt.stats().webgpuDeviceLosses).toBe(1);

    // The rebuilt bindings really render, through the shared GL context this time.
    drawCount = 0;
    flushRaf();
    expect(drawCount).toBe(2);
    rt.dispose();
  });

  it("counts uncaptured device errors, which are the only sign a frame was silently wrong", async () => {
    const handle = withWebgpu();
    const { root } = mountRoot(1);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().webgpuErrors).toBe(0);

    handle.emitUncapturedError();
    expect(rt.stats().webgpuErrors).toBe(1);
    rt.dispose();
  });
});

describe("shader renderer gate — captureNodePixels", () => {
  it("reads a WebGPU binding's frame back through a texture, never through the canvas", async () => {
    const handle = withWebgpu();
    const { root } = mountRoot(1);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();

    handle.calls.length = 0;
    const pixels = await rt.captureNodePixels?.(root);
    // Tightly packed RGBA at the canvas's BACKING-STORE size (100 × 50 at dpr 1).
    expect(pixels).toBeInstanceOf(Uint8Array);
    expect(pixels?.length).toBe(100 * 50 * 4);
    // Through a COPY, not a canvas read: `drawImage`/`toDataURL` on a WebGPU canvas are blank
    // headless and pathological on Android (S7), which is the whole reason this hook exists.
    expect(callCount(handle, "encoder.copyTextureToBuffer")).toBe(1);
    // An `rgba8unorm`-targeted TWIN of the live pipeline: a pipeline's fragment target format must
    // match its attachment, and the canvas here is bgra8unorm.
    expect(callCount(handle, "createRenderPipeline")).toBe(1);
    rt.dispose();
  });

  it("returns null for a WebGL binding — that canvas is readable with getImageData", async () => {
    const { root } = mountRoot(1);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      effectsRenderer: "webgl",
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();

    await expect(rt.captureNodePixels?.(root)).resolves.toBeNull();
    rt.dispose();
  });
});
