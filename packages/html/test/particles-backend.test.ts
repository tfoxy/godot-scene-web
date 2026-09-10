// jsdom (gsw default env).
//
// The RENDER-BACKEND SEAM (`../src/particles/render-backend`): the runtime owns the simulation, the
// bindings and the loop, and every renderer-specific move goes through ONE interface. What these
// tests defend is the seam's SHAPE, not its WebGL implementation (that is what every other
// particles-*.test.ts already covers end to end):
//
//   - a tick's draws are BRACKETED by `beginFrame`/`endFrame`, in both the live and the frozen
//     branch, and the pair is balanced. On WebGL those are no-ops; a WebGPU backend records one
//     command encoder per tick and submits it once at `endFrame`, so a tick that opened a frame and
//     never closed it (or closed one it never opened) would drop or double-submit a whole frame's
//     work. A tick the FPS cap DEFERS does no work and must open no frame.
//   - the no-live-instances frame goes through `clear`, not `draw` — a real (blank) frame the
//     backend still has to put on the canvas, and on WebGPU a canvas keeps its last presented frame
//     until something clears it.
//   - every binding's GPU resources are handed back through `disposeSurface`.
//   - the sizing law folds in `maxBackingDim`: UNDEFINED (what WebGL reports) leaves the backing
//     store exactly where it was, a number clamps it.
//
// The backend is wrapped, not replaced: the real WebGL backend still runs underneath, so these
// assertions are made against the shipped path. Harness copied from `particles-profiling.test.ts` —
// fake WebGL2/2D contexts, a hand-flushed rAF queue, the shared ResizeObserver stub (whose initial
// delivery is what mounts a canvas under the default `particleObserverSizing`), and a stubbed clock
// that moves only between pumped ticks.
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

import type { ParticleRenderBackend } from "../src/particles/render-backend";
import { createParticleRuntime } from "../src/particles/runtime";
import { __resetStaticParticleFrameCacheForTest } from "../src/particles/static-frame-cache";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

/** Every FRAME-level backend call the runtime made, in order. `maxBackingDim` is deliberately not
 *  recorded here: it is a sizing question, asked outside any frame. */
let calls: string[] = [];
/** Longest-edge ceiling the wrapped backend reports, or undefined to pass the real one through. */
let backendMaxDim: number | undefined;
/** The real WebGL backend under the recorder, so a test can ask what IT answers. */
let realBackend: ParticleRenderBackend | null = null;

function recording(backend: ParticleRenderBackend): ParticleRenderBackend {
  return {
    kind: backend.kind,
    createSurface: (canvas, config) => {
      calls.push("createSurface");
      return backend.createSurface(canvas, config);
    },
    // Texture resolution is a BACKEND question (a `WebGLTexture` means nothing to a WebGPU pass), so
    // it rides the same seam and this recorder forwards it untouched. Not counted: it is asked once
    // per binding CREATE, outside any frame, and these tests are about the frame.
    resolveTextures: (config) => backend.resolveTextures(config),
    disposeSurface: (surface, buffer) => {
      calls.push("disposeSurface");
      backend.disposeSurface(surface, buffer);
    },
    maxBackingDim: () =>
      backendMaxDim === undefined ? backend.maxBackingDim() : backendMaxDim,
    beginFrame: () => {
      calls.push("beginFrame");
      backend.beginFrame();
    },
    endFrame: () => {
      calls.push("endFrame");
      backend.endFrame();
    },
    clear: (surface, w, h, prof) => {
      calls.push("clear");
      backend.clear(surface, w, h, prof);
    },
    draw: (surface, buffer, opts, prof) => {
      calls.push("draw");
      backend.draw(surface, buffer, opts, prof);
    },
  };
}

vi.mock("../src/particles/render-backend", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/particles/render-backend")>();
  return {
    ...actual,
    createWebglParticleBackend: (
      ...args: Parameters<typeof actual.createWebglParticleBackend>
    ) => {
      const backend = actual.createWebglParticleBackend(...args);
      if (!backend) return null;
      realBackend = backend;
      return recording(backend);
    },
  };
});

// A fake WebGL2 context: methods that must return truthy do; everything else is a harmless no-op.
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

// The stubbed clock (ms), moved ONLY by `pumpTick` — so a tick's `dt` is exactly what the test says.
let clockMs = 0;
const TICK_MS = 34; // > 1/30 s, so an FPS-capped loop is due on every pumped tick
function pumpTick(): void {
  clockMs += TICK_MS;
  flushRaf();
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
  rafQueue = [];
  clockMs = 0;
  calls = [];
  backendMaxDim = undefined;
  realBackend = null;
  globalThis.ResizeObserver = makeResizeObserverStub();
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clockMs);
});

afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
  document.body.innerHTML = "";
});

// `explosiveness: 1` births every particle on the first sub-step, so a pumped tick always has
// instances to draw; blendMode 0 keeps the fake GL off the additive accumulator path.
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

const count = (name: string): number =>
  calls.filter((call) => call === name).length;

describe("particle runtime — the render-backend seam", () => {
  it("brackets a live tick's draws with beginFrame/endFrame", () => {
    const rt = createParticleRuntime(mountRoot(2), {
      enableParticles: true,
    } as never);
    rt.reconcile();
    calls = [];

    pumpTick();
    // One frame, both bindings drawn INSIDE it — a WebGPU backend records exactly this into one
    // command encoder and submits it at `endFrame`.
    expect(calls).toEqual(["beginFrame", "draw", "draw", "endFrame"]);

    pumpTick();
    pumpTick();
    expect(count("beginFrame")).toBe(3);
    expect(count("endFrame")).toBe(3);
    expect(count("draw")).toBe(6);
    rt.dispose();
  });

  it("brackets the FROZEN pass too, and parks after it", () => {
    const rt = createParticleRuntime(mountRoot(2), {
      enableParticles: true,
      staticParticles: true,
    } as never);
    rt.reconcile();
    calls = [];

    pumpTick(); // warms + draws each binding ONCE, then parks the loop
    expect(calls[0]).toBe("beginFrame");
    expect(calls[calls.length - 1]).toBe("endFrame");
    // ONE frame for the whole pass, and inside it the frozen collapse the static-frame cache exists
    // for: the twins share a bitmap, so the second is a cache-hit BLIT — which stays on the 2D
    // context by design (`ParticleSurface.ctx2d`) and never reaches the backend.
    expect(count("draw")).toBe(1);
    expect(rt.stats().cacheHits).toBe(1);

    expect(rafQueue.length).toBe(0); // parked
    pumpTick();
    expect(count("beginFrame")).toBe(1); // …so no further frame was opened
    expect(count("endFrame")).toBe(1);
    rt.dispose();
  });

  it("opens NO frame on a tick the FPS cap defers", () => {
    const rt = createParticleRuntime(mountRoot(1), {
      enableParticles: true,
      particleFps: 30,
      // "raf" pacing re-arms per display frame, which is what makes an early (deferred) tick
      // observable at all — the default "timer" pacing parks instead of running one.
      effectsLoopPacing: "raf",
    } as never);
    rt.reconcile();
    calls = [];

    // Clock frozen: the cap boundary is a whole interval away, so this tick defers without work.
    flushRaf();
    expect(calls).toEqual([]);

    pumpTick(); // now past the boundary
    expect(calls).toEqual(["beginFrame", "draw", "endFrame"]);
    rt.dispose();
  });

  it("routes a frame with no live instances through clear(), never draw()", () => {
    const rt = createParticleRuntime(mountRoot(1, spec({ emitting: false })), {
      enableParticles: true,
    } as never);
    rt.reconcile();
    calls = [];

    pumpTick();
    // A blank frame is still a frame the backend must put on the canvas (see `ParticleProfile`'s
    // blitMs note: the clear is booked as fill, not as a free skip).
    expect(calls).toEqual(["beginFrame", "clear", "endFrame"]);
    rt.dispose();
  });

  it("hands every binding's GPU resources back through disposeSurface", () => {
    const root = mountRoot(2);
    const rt = createParticleRuntime(root, { enableParticles: true } as never);
    rt.reconcile();
    expect(count("createSurface")).toBe(2);
    calls = [];

    // A node that leaves the DOM is disposed by the next reconcile…
    root.firstElementChild?.remove();
    rt.reconcile();
    expect(count("disposeSurface")).toBe(1);

    // …and the runtime's own teardown takes the rest.
    rt.dispose();
    expect(count("disposeSurface")).toBe(2);
  });

  it("sizes the canvas unchanged when the backend reports NO ceiling (WebGL)", () => {
    const rt = createParticleRuntime(mountRoot(1), {
      enableParticles: true,
    } as never);
    rt.reconcile();
    const canvas = document.querySelector(
      "[data-godot-particle-canvas]",
    ) as HTMLCanvasElement;

    // The shipped WebGL backend has no size law of its own — the shared drawing buffer discovers its
    // ceiling at draw time instead (`ensureSharedDrawSize`).
    expect(realBackend?.maxBackingDim()).toBeUndefined();
    // devicePixelRatio is 1 under jsdom, so an UNBOUNDED sizing is exactly the CSS box: the backing
    // store the runtime allocated before this seam existed.
    const cssW = Number.parseFloat(canvas.style.width);
    const cssH = Number.parseFloat(canvas.style.height);
    expect(canvas.width).toBe(Math.round(cssW));
    expect(canvas.height).toBe(Math.round(cssH));
    // …and the box is big enough that the clamp in the next test really has to bite.
    expect(Math.max(cssW, cssH)).toBeGreaterThan(64);
    rt.dispose();
  });

  it("folds a backend that DOES report a ceiling into the sizing law", () => {
    backendMaxDim = 64;
    const rt = createParticleRuntime(mountRoot(1), {
      enableParticles: true,
    } as never);
    rt.reconcile();
    const canvas = document.querySelector(
      "[data-godot-particle-canvas]",
    ) as HTMLCanvasElement;

    // Aspect-preserving, like every other backing-store clamp (`backingStoreSize`).
    expect(Math.max(canvas.width, canvas.height)).toBe(64);
    rt.dispose();
  });
});
