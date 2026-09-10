// jsdom (gsw default env).
//
// THE RENDERER GATE (`effectsRenderer`, see `../src/types`): how a runtime whose factory is
// SYNCHRONOUS adopts a renderer whose device is not, and what it does when that device never comes,
// or comes and then dies.
//
// The branch that matters most is the one with no WebGPU in it at all. `effectsRenderer` defaults to
// `"auto"`, so EVERY existing test in this package now goes through the gate — and stays byte-for-byte
// on its old path only because the absence of `navigator.gpu` is answered synchronously, with no
// promise and no surface-less window. That is asserted first here, and the other 54 test files
// asserting their old expectations unchanged are the rest of the proof.
//
// Harness copied from `particles-backend.test.ts` (fake WebGL2/2D contexts, a hand-flushed rAF queue,
// the shared ResizeObserver stub, a stubbed clock), plus `installWebgpuStub` for the WebGPU half.
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
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { __resetWebgpuForTest } from "../src/webgpu/device";
import { __resetWebgpuTextureCacheForTest } from "../src/webgpu/textures";
import { makeResizeObserverStub } from "./support/resize-observer-stub";
import {
  installWebgpuStub,
  type WebgpuStubHandle,
  type WebgpuStubOptions,
} from "./support/webgpu-stub";

// A fake WebGL2 context: methods that must return truthy do; everything else is a harmless no-op.
// The WebGL backend is built even on a WebGPU runtime (it is the fallback), so this is always needed.
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
const TICK_MS = 34; // > 1/30 s, so an FPS-capped loop is due on every pumped tick
function pumpTick(): void {
  clockMs += TICK_MS;
  flushRaf();
}

/** Drain the microtask queue. The whole gate — device, then pipelines, then adoption — is a chain of
 *  awaits over promises the stub resolves immediately, so it settles in microtasks and never needs a
 *  real timer (which is what lets the `"hang"` case below use fake ones without ambiguity). */
async function settle(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

let stub: WebgpuStubHandle | null = null;
function withWebgpu(options: WebgpuStubOptions = {}): WebgpuStubHandle {
  stub = installWebgpuStub(options);
  return stub;
}

let nowSpy: ReturnType<typeof vi.spyOn> | null = null;
let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;

beforeAll(() => {
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
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  __resetWebgpuForTest();
  __resetWebgpuParticleProgramForTest();
  __resetWebgpuTextureCacheForTest();
  rafQueue = [];
  clockMs = 0;
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

// `explosiveness: 1` births every particle on the first sub-step, so a pumped tick always has
// instances to draw.
function spec(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "GPUParticles2D",
    amount: 6,
    lifetime: 4,
    emitting: true,
    explosiveness: 1,
    initialVelocityMin: 50,
    initialVelocityMax: 50,
    blendMode: 0,
    ...over,
  });
}

function particleNode(specJson: string): HTMLElement {
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
  return node;
}

function mountRoot(systems: number, specJson = spec()): HTMLElement {
  const root = document.createElement("div");
  for (let i = 0; i < systems; i += 1) root.appendChild(particleNode(specJson));
  document.body.appendChild(root);
  return root;
}

const canvases = (): HTMLCanvasElement[] =>
  Array.from(document.querySelectorAll("[data-godot-particle-canvas]"));

const callCount = (handle: WebgpuStubHandle, name: string): number =>
  handle.calls.filter((call) => call.name === name).length;

describe("particle renderer gate — the synchronous branches", () => {
  it("adopts WebGL SYNCHRONOUSLY under the default 'auto' when the page has no navigator.gpu", () => {
    // No stub installed: jsdom has no `navigator.gpu`, which is every existing test in this package.
    expect((navigator as Navigator & { gpu?: unknown }).gpu).toBeUndefined();
    const rt = createParticleRuntime(mountRoot(2), {
      enableParticles: true,
    } as never);
    rt.reconcile();

    // Adopted BEFORE anything could await: the binding draws on the very first pumped tick, with no
    // pending state in between. This is what keeps the rest of the suite byte-identical.
    expect(rt.stats().renderer).toBe("webgl");
    pumpTick();
    expect(rt.stats().draws).toBe(2);
    // Counted and explained rather than hidden — a silent fallback is only diagnosable through these.
    expect(rt.stats().webgpuFallbacks).toBe(1);
    expect(rt.stats().webgpuFallbackReason).toBe("no-navigator-gpu");
    expect(rt.stats().webgpuSubmits).toBe(0);
    rt.dispose();
  });

  it("probes NOTHING for effectsRenderer: 'webgl', even where WebGPU exists", async () => {
    const handle = withWebgpu();
    const rt = createParticleRuntime(mountRoot(1), {
      enableParticles: true,
      effectsRenderer: "webgl",
    } as never);
    rt.reconcile();
    await settle();

    expect(rt.stats().renderer).toBe("webgl");
    // Nothing was ever asked for, so nothing fell back and there is no reason to report.
    expect(rt.stats().webgpuFallbacks).toBe(0);
    expect(rt.stats().webgpuFallbackReason).toBeNull();
    expect(handle.requestAdapterCalls).toBe(0);
    rt.dispose();
  });
});

describe("particle renderer gate — adopting WebGPU", () => {
  it("runs PENDING until the device lands, then hands every binding a surface", async () => {
    const handle = withWebgpu();
    const rt = createParticleRuntime(mountRoot(2), {
      enableParticles: true,
    } as never);
    rt.reconcile();

    // PENDING: the canvases exist, are sized and are MOUNTED (all renderer-agnostic), but they have
    // no surface, so a tick draws nothing and nothing is submitted.
    expect(rt.stats().renderer).toBe("pending");
    expect(canvases()).toHaveLength(2);
    pumpTick();
    expect(rt.stats().draws).toBe(0);

    await settle();
    expect(rt.stats().renderer).toBe("webgpu");
    // One configured context per binding, presenting PREMULTIPLIED frames (the only alpha mode that
    // composites over the page, and the one both fragments are written for).
    expect(handle.contexts).toHaveLength(2);
    for (const context of handle.contexts) {
      expect(context.configured?.alphaMode).toBe("premultiplied");
    }

    // Adoption kicks the loop, so the frame it armed draws both bindings.
    pumpTick();
    expect(rt.stats().draws).toBe(2);
    rt.dispose();
  });

  it("submits ONCE per tick whatever the binding count", async () => {
    const handle = withWebgpu();
    const rt = createParticleRuntime(mountRoot(3), {
      enableParticles: true,
    } as never);
    rt.reconcile();
    await settle();
    const before = callCount(handle, "queue.submit");

    pumpTick();
    // THE measured shape (docs/perf-harness.md S7): three bindings, three render passes, ONE submit.
    // A per-draw submit would make "WebGPU" mean "N submits" and give the win back.
    expect(callCount(handle, "queue.submit") - before).toBe(1);
    expect(rt.stats().webgpuSubmits).toBe(1);
    expect(rt.stats().draws).toBe(3);

    pumpTick();
    expect(rt.stats().webgpuSubmits).toBe(2);
    // …and `blitMs` can never be written on this path: there is no blit to book.
    rt.dispose();
  });

  it("records an additive system as accumulate THEN resolve, inside the one submit", async () => {
    const handle = withWebgpu();
    const rt = createParticleRuntime(mountRoot(1, spec({ blendMode: 1 })), {
      enableParticles: true,
    } as never);
    rt.reconcile();
    await settle();
    handle.calls.length = 0;

    pumpTick();
    // Godot ADD: sum raw light into the accumulator, then resolve the per-pixel TOTAL to coverage.
    // Passes execute in the order they are RECORDED, so the pair is safe inside a shared encoder.
    const passes = handle.calls.filter(
      (call) => call.name === "encoder.beginRenderPass",
    );
    expect(passes).toHaveLength(2);
    expect(callCount(handle, "queue.submit")).toBe(1);
    rt.dispose();
  });
});

describe("particle renderer gate — falling back", () => {
  const cases: Array<[WebgpuStubOptions, string]> = [
    [{ adapter: "null" }, "no-adapter"],
    [{ adapter: "fallback" }, "fallback-adapter"],
    [{ adapter: "throw" }, "no-adapter"],
    [{ device: "throw" }, "device-lost"],
    [{ contextRefused: true }, "context-refused"],
  ];
  for (const [options, reason] of cases) {
    it(`falls back to WebGL with reason "${reason}"`, async () => {
      withWebgpu(options);
      const rt = createParticleRuntime(mountRoot(1), {
        enableParticles: true,
        effectsRenderer: "webgpu",
      } as never);
      rt.reconcile();
      await settle();

      expect(rt.stats().renderer).toBe("webgl");
      expect(rt.stats().webgpuFallbacks).toBe(1);
      expect(rt.stats().webgpuFallbackReason).toBe(reason);
      // The fallback is a RENDERER swap, not a degradation: the binding draws on WebGL.
      pumpTick();
      expect(rt.stats().draws).toBe(1);
      rt.dispose();
    });
  }

  it('gives up on an adapter request that never settles ("acquire-timeout")', async () => {
    // Only setTimeout is faked: `requestAnimationFrame` is this suite's own queue, and the gate's
    // deadline is the one real timer in the whole path.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      withWebgpu({ adapter: "hang" });
      const rt = createParticleRuntime(mountRoot(1), {
        enableParticles: true,
      } as never);
      rt.reconcile();
      await settle();
      // Still pending — a hung adapter is not an answer.
      expect(rt.stats().renderer).toBe("pending");

      vi.advanceTimersByTime(8000);
      await settle();
      expect(rt.stats().renderer).toBe("webgl");
      expect(rt.stats().webgpuFallbackReason).toBe("acquire-timeout");
      rt.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds every binding on WebGL — with NEW canvas elements — when the device is lost", async () => {
    const handle = withWebgpu();
    const rt = createParticleRuntime(mountRoot(2), {
      enableParticles: true,
    } as never);
    rt.reconcile();
    await settle();
    expect(rt.stats().renderer).toBe("webgpu");
    pumpTick();
    const drawnOnWebgpu = rt.stats().draws;
    const before = canvases();
    expect(before).toHaveLength(2);
    const instanceBuffers = handle.buffers.filter(
      (buffer) => buffer.label === "gsw-particle-instances",
    );
    expect(instanceBuffers).toHaveLength(2);

    handle.loseDevice();
    await settle();

    // THE CANVASES ARE REPLACED, and they have to be: a canvas that has held a webgpu context can
    // never yield a 2d one, so the WebGL rebuild cannot reuse the elements.
    const after = canvases();
    expect(after).toHaveLength(2);
    for (const canvas of after) expect(before).not.toContain(canvas);
    // Each replacement really took a 2D context: `createBinding` REFUSES a binding whose backend
    // returns no surface, and a refused binding never inserts its canvas — so two canvases standing
    // here is two non-null `ctx2d`s, which is also what the assertion below draws through.
    for (const canvas of after) expect(canvas.getContext("2d")).not.toBeNull();
    expect(rt.stats().renderer).toBe("webgl");
    expect(rt.stats().webgpuFallbackReason).toBe("device-lost");
    expect(rt.stats().webgpuDeviceLosses).toBe(1);
    // The renderer owns per-surface buffers and listeners, while the HTML texture cache owns the
    // decoded texture handles. A loss must release only the former before rebuilding these nodes on
    // WebGL; destroying a cached texture here would invalidate a later WebGPU device generation.
    expect(instanceBuffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(callCount(handle, "context.unconfigure")).toBe(2);

    // The rebuilt bindings really render (a 2D surface was acquired for each).
    pumpTick();
    expect(rt.stats().draws).toBeGreaterThan(drawnOnWebgpu);
    rt.dispose();
  });
});

describe("particle renderer gate — the WebGPU feature matrix", () => {
  it("skips the static-frame cache on WebGPU: each frozen twin draws its own frame", async () => {
    const handle = withWebgpu();
    const rt = createParticleRuntime(mountRoot(2), {
      enableParticles: true,
      staticParticles: true,
    } as never);
    rt.reconcile();
    await settle();

    pumpTick();
    // On WebGL these two identical systems collapse to 1 draw + 1 cacheHit (see
    // `particles-backend.test.ts`). The cache trades a warm+draw for a BLIT, and a WebGPU surface has
    // no 2D context to blit through — so it is not consulted at all, and each twin pays its own
    // (cheap: the simulation is <3% of a core) warm.
    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().cacheHits).toBe(0);
    expect(callCount(handle, "queue.submit")).toBe(1);

    // …then the loop PARKS, exactly as it does on WebGL — a WebGPU canvas keeps its last presented
    // frame, so the frozen art stays on screen at zero per-frame cost.
    expect(rafQueue.length).toBe(0);
    pumpTick();
    expect(rt.stats().draws).toBe(2);
    rt.dispose();
  });

  it("captures a node's pixels through readback on WebGPU, and refuses on WebGL", async () => {
    withWebgpu();
    const root = mountRoot(1);
    const node = root.firstElementChild as HTMLElement;
    const rt = createParticleRuntime(root, { enableParticles: true } as never);
    rt.reconcile();
    await settle();
    pumpTick();

    const canvas = canvases()[0];
    const pixels = await rt.captureNodePixels?.(node);
    // Tightly packed RGBA at the canvas's BACKING-STORE size (the readback strips the 256-byte row
    // padding `copyTextureToBuffer` demands).
    expect(pixels).toBeInstanceOf(Uint8Array);
    expect(pixels?.length).toBe(canvas.width * canvas.height * 4);
    // An unbound node has no binding to capture.
    expect(
      await rt.captureNodePixels?.(document.createElement("div")),
    ).toBeNull();
    rt.dispose();

    // On WebGL it returns null — not a gap: that canvas holds readable 2D pixels, so a caller uses
    // `getImageData` on it instead.
    const glRoot = mountRoot(1);
    const glRt = createParticleRuntime(glRoot, {
      enableParticles: true,
      effectsRenderer: "webgl",
    } as never);
    glRt.reconcile();
    pumpTick();
    expect(
      await glRt.captureNodePixels?.(glRoot.firstElementChild as HTMLElement),
    ).toBeNull();
    glRt.dispose();
  });
});
