// jsdom (gsw default env).
//
// OPT-IN pinned static backing size (`staticShaderPixelRatio` / `staticParticlePixelRatio`): while a runtime is
// in FROZEN mode, a consumer can pin the backing-store ratio its canvases are sized at, so the frozen set stops
// re-allocating (and, for shaders, re-keying its static-frame cache) every time the host's fit scale or the
// adaptive `setRenderScale` ladder moves. These tests pin the contract on BOTH runtimes:
//   - the pin applies to FROZEN bindings only,
//   - live bindings keep tracking devicePixelRatio x renderScale,
//   - `setRenderScale` re-sizes and re-dirties NOTHING while the pin is in force,
//   - the longest-edge clamp (MAX_PINNED_BACKING_DIM) holds, aspect preserved,
//   - and with the option ABSENT every size is byte-for-byte what it was before the option existed.
//
// Same fake-WebGL2 + hand-flushed rAF harness as webgl-static / particles-static.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createParticleRuntime } from "../src/particles/runtime";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import {
  __resetStaticShaderFrameCacheForTest,
  createWebglShaderRuntime,
} from "../src/webgl/runtime";
import {
  __resetSharedForTest,
  backingStoreSize,
  MAX_PINNED_BACKING_DIM,
} from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

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
  rafQueue = [];
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// --- shader-runtime fixtures -------------------------------------------------------------------

const BOX_W = 100;
const BOX_H = 50;

function shaderNode(path = "res://s.gdshader"): {
  node: HTMLElement;
  self: HTMLElement;
} {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  Object.defineProperty(self, "clientWidth", {
    get: () => BOX_W,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => BOX_H,
    configurable: true,
  });
  node.appendChild(self);
  return { node, self };
}

async function mountShaderRuntime(
  options: Record<string, unknown>,
  path = "res://s.gdshader",
): Promise<{
  rt: ReturnType<typeof createWebglShaderRuntime>;
  canvas: HTMLCanvasElement;
}> {
  const root = document.createElement("div");
  const { node, self } = shaderNode(path);
  root.appendChild(node);
  document.body.appendChild(root);
  const rt = createWebglShaderRuntime(root, {
    resolveShaderSource: async () => SHADER,
    ...options,
  } as never);
  rt.reconcile();
  await settle();
  const canvas = self.querySelector("canvas") as HTMLCanvasElement;
  return { rt, canvas };
}

// --- particle-runtime fixtures -----------------------------------------------------------------

function spec(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "GPUParticles2D",
    amount: 8,
    lifetime: 1,
    emitting: true,
    initialVelocityMin: 50,
    initialVelocityMax: 50,
    blendMode: 0,
    ...over,
  });
}

function particleNode(): { node: HTMLElement; self: HTMLElement } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", spec());
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  Object.defineProperty(self, "clientWidth", {
    get: () => BOX_W,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => BOX_H,
    configurable: true,
  });
  node.appendChild(self);
  return { node, self };
}

function mountParticleRuntime(options: Record<string, unknown>): {
  rt: ReturnType<typeof createParticleRuntime>;
  canvas: HTMLCanvasElement;
} {
  const root = document.createElement("div");
  const { node, self } = particleNode();
  root.appendChild(node);
  document.body.appendChild(root);
  const rt = createParticleRuntime(root, {
    enableParticles: true,
    ...options,
  } as never);
  rt.reconcile();
  const canvas = self.querySelector(
    "[data-godot-particle-canvas]",
  ) as HTMLCanvasElement;
  return { rt, canvas };
}

describe("backingStoreSize (pure)", () => {
  it("is the plain round(css x ratio) with no cap, and hands the ratio back untouched", () => {
    expect(backingStoreSize(100, 50, 1)).toEqual({ w: 100, h: 50, ratio: 1 });
    expect(backingStoreSize(100, 50, 2.5)).toEqual({
      w: 250,
      h: 125,
      ratio: 2.5,
    });
    // Sub-pixel boxes still allocate at least 1px, exactly as before.
    expect(backingStoreSize(0.2, 0.2, 1)).toEqual({ w: 1, h: 1, ratio: 1 });
  });

  it("clamps by the LONGEST edge, preserving aspect, and reports the ratio it really applied", () => {
    const { w, h, ratio } = backingStoreSize(1000, 500, 10, 2048);
    expect(w).toBe(2048); // 10000 -> 2048
    expect(h).toBe(1024); // aspect 2:1 kept
    expect(ratio).toBeCloseTo(10 * (2048 / 10000), 10);
    // A size already inside the cap is untouched (and keeps the exact input ratio).
    expect(backingStoreSize(100, 50, 2, 2048)).toEqual({
      w: 200,
      h: 100,
      ratio: 2,
    });
  });
});

describe("webgl runtime — pinned static backing size", () => {
  it("sizes a FROZEN binding at the pin instead of devicePixelRatio x renderScale", async () => {
    const { rt, canvas } = await mountShaderRuntime({
      staticShaders: true,
      renderScale: 0.5, // would have given 50x25
      staticShaderPixelRatio: 3,
    });
    expect(canvas.width).toBe(BOX_W * 3);
    expect(canvas.height).toBe(BOX_H * 3);
    expect(rt.stats().pinnedCanvasSyncs).toBeGreaterThan(0);
    rt.dispose();
  });

  it("leaves LIVE bindings on devicePixelRatio x renderScale even when a pin is configured", async () => {
    const { rt, canvas } = await mountShaderRuntime({
      staticShaders: false,
      renderScale: 0.5,
      staticShaderPixelRatio: 3,
    });
    expect(canvas.width).toBe(BOX_W * 0.5);
    expect(canvas.height).toBe(BOX_H * 0.5);
    expect(rt.stats().pinnedCanvasSyncs).toBe(0); // the pin never applied
    rt.dispose();
  });

  it("setRenderScale re-sizes and re-dirties NOTHING while pinned (the cached frame survives)", async () => {
    const { rt, canvas } = await mountShaderRuntime({
      staticShaders: true,
      staticShaderPixelRatio: 2,
    });
    flushRaf(); // render the frozen frame
    expect(canvas.width).toBe(BOX_W * 2);
    const before = { ...rt.stats() };
    expect(before.draws).toBe(1);

    rt.setRenderScale(0.25); // an adaptive downgrade step
    expect(canvas.width).toBe(BOX_W * 2); // unmoved
    expect(canvas.height).toBe(BOX_H * 2);
    expect(rt.stats().canvasReallocs).toBe(before.canvasReallocs);
    flushRaf();
    // Nothing was re-dirtied, so nothing re-rendered AT ALL — not even the cheap cache-hit blit
    // (`cacheHits`), which is what a re-dirtied binding at an unchanged pinned size would have cost.
    expect(rt.stats().draws).toBe(before.draws);
    expect(rt.stats().cacheHits).toBe(before.cacheHits);
    rt.dispose();
  });

  it("un-pinned, setRenderScale still re-sizes a frozen binding (today's behavior, unchanged)", async () => {
    const { rt, canvas } = await mountShaderRuntime({ staticShaders: true });
    flushRaf();
    expect(canvas.width).toBe(BOX_W);
    rt.setRenderScale(0.5);
    expect(canvas.width).toBe(BOX_W * 0.5);
    expect(canvas.height).toBe(BOX_H * 0.5);
    flushRaf();
    expect(rt.stats().draws).toBe(2); // re-dirtied -> re-rendered, as before
    rt.dispose();
  });

  it("clamps the pinned backing store to MAX_PINNED_BACKING_DIM on its longest edge", async () => {
    const { rt, canvas } = await mountShaderRuntime({
      staticShaders: true,
      staticShaderPixelRatio: 100, // asks for 10000x5000
    });
    expect(canvas.width).toBe(MAX_PINNED_BACKING_DIM);
    expect(canvas.height).toBe(MAX_PINNED_BACKING_DIM / 2); // 2:1 aspect preserved
    rt.dispose();
  });

  it("a mode flip re-sizes between the pinned and the live ratio", async () => {
    const { rt, canvas } = await mountShaderRuntime({
      staticShaders: false,
      staticShaderPixelRatio: 3,
    });
    expect(canvas.width).toBe(BOX_W);
    rt.setStaticShaders(true);
    expect(canvas.width).toBe(BOX_W * 3);
    rt.setStaticShaders(false);
    expect(canvas.width).toBe(BOX_W);
    rt.dispose();
  });

  it("setStaticShaderPixelRatio applies live to a frozen runtime, and un-pins on undefined", async () => {
    const { rt, canvas } = await mountShaderRuntime({ staticShaders: true });
    expect(canvas.width).toBe(BOX_W);
    rt.setStaticShaderPixelRatio(2);
    expect(canvas.width).toBe(BOX_W * 2);
    rt.setStaticShaderPixelRatio(undefined);
    expect(canvas.width).toBe(BOX_W);
    // Junk values are treated as "not pinned" rather than allocating a 0x0 / NaN canvas.
    rt.setStaticShaderPixelRatio(0);
    expect(canvas.width).toBe(BOX_W);
    rt.setStaticShaderPixelRatio(Number.NaN);
    expect(canvas.width).toBe(BOX_W);
    rt.dispose();
  });

  // The default-path guard: with the option ABSENT every size must be exactly `box x window x
  // devicePixelRatio x renderScale`, in both modes and across a live retune — i.e. what every
  // existing consumer (the recon view, the playground) gets today.
  it("DEFAULT PATH: option absent => identical sizes in both modes, and no pinned syncs", async () => {
    for (const staticShaders of [false, true]) {
      const { rt, canvas } = await mountShaderRuntime(
        { staticShaders, renderScale: 0.5 },
        `res://default-${staticShaders}.gdshader`,
      );
      expect(canvas.width).toBe(Math.round(BOX_W * 0.5));
      expect(canvas.height).toBe(Math.round(BOX_H * 0.5));
      rt.setRenderScale(1);
      expect(canvas.width).toBe(BOX_W);
      expect(canvas.height).toBe(BOX_H);
      rt.setStaticShaders(!staticShaders);
      expect(canvas.width).toBe(BOX_W); // a mode flip alone never re-sizes anything
      expect(canvas.height).toBe(BOX_H);
      expect(rt.stats().pinnedCanvasSyncs).toBe(0);
      rt.dispose();
      document.body.innerHTML = "";
    }
  });
});

describe("particle runtime — pinned static backing size", () => {
  // The particle canvas is (box + 2*pad) x ratio, and `pad` depends on the spec, so the pinned
  // expectations are stated relative to the SAME node's un-pinned size rather than re-deriving pad.
  function baselineCanvasSize(): { w: number; h: number } {
    const { rt, canvas } = mountParticleRuntime({ staticParticles: true });
    const size = { w: canvas.width, h: canvas.height };
    rt.dispose();
    document.body.innerHTML = "";
    return size;
  }

  it("sizes a FROZEN binding at the pin instead of devicePixelRatio x renderScale", () => {
    const base = baselineCanvasSize();
    const { rt, canvas } = mountParticleRuntime({
      staticParticles: true,
      renderScale: 0.5,
      staticParticlePixelRatio: 3,
    });
    expect(canvas.width).toBe(base.w * 3);
    expect(canvas.height).toBe(base.h * 3);
    expect(rt.stats().pinnedCanvasSyncs).toBeGreaterThan(0);
    rt.dispose();
  });

  it("leaves LIVE bindings on devicePixelRatio x renderScale even when a pin is configured", () => {
    const base = baselineCanvasSize();
    const { rt, canvas } = mountParticleRuntime({
      staticParticles: false,
      renderScale: 0.5,
      staticParticlePixelRatio: 3,
    });
    expect(canvas.width).toBe(Math.round(base.w * 0.5));
    expect(canvas.height).toBe(Math.round(base.h * 0.5));
    expect(rt.stats().pinnedCanvasSyncs).toBe(0);
    rt.dispose();
  });

  it("setRenderScale re-sizes NOTHING while pinned, and still re-sizes when un-pinned", () => {
    const base = baselineCanvasSize();
    const pinned = mountParticleRuntime({
      staticParticles: true,
      staticParticlePixelRatio: 2,
    });
    flushRaf(); // warm + draw the frozen spray
    expect(pinned.canvas.width).toBe(base.w * 2);
    const draws = pinned.rt.stats().draws;
    pinned.rt.setRenderScale(0.25);
    expect(pinned.canvas.width).toBe(base.w * 2); // unmoved: the parked canvas keeps its pixels
    flushRaf();
    expect(pinned.rt.stats().draws).toBe(draws); // …and the parked loop was never kicked to redraw
    pinned.rt.dispose();
    document.body.innerHTML = "";

    const plain = mountParticleRuntime({ staticParticles: true });
    flushRaf();
    expect(plain.canvas.width).toBe(base.w);
    plain.rt.setRenderScale(0.5);
    expect(plain.canvas.width).toBe(Math.round(base.w * 0.5)); // unchanged behavior
    plain.rt.dispose();
  });

  it("clamps the pinned backing store to MAX_PINNED_BACKING_DIM on its longest edge", () => {
    const { rt, canvas } = mountParticleRuntime({
      staticParticles: true,
      staticParticlePixelRatio: 100,
    });
    expect(Math.max(canvas.width, canvas.height)).toBe(MAX_PINNED_BACKING_DIM);
    rt.dispose();
  });

  it("a mode flip re-sizes between the pinned and the live ratio", () => {
    const base = baselineCanvasSize();
    const { rt, canvas } = mountParticleRuntime({
      staticParticles: false,
      staticParticlePixelRatio: 3,
    });
    expect(canvas.width).toBe(base.w);
    rt.setStaticParticles(true);
    expect(canvas.width).toBe(base.w * 3);
    rt.setStaticParticles(false);
    expect(canvas.width).toBe(base.w);
    rt.dispose();
  });

  it("setStaticParticlePixelRatio applies live to a frozen runtime, and un-pins on undefined", () => {
    const base = baselineCanvasSize();
    const { rt, canvas } = mountParticleRuntime({ staticParticles: true });
    expect(canvas.width).toBe(base.w);
    rt.setStaticParticlePixelRatio(2);
    expect(canvas.width).toBe(base.w * 2);
    rt.setStaticParticlePixelRatio(undefined);
    expect(canvas.width).toBe(base.w);
    rt.dispose();
  });

  it("DEFAULT PATH: option absent => identical sizes in both modes, and no pinned syncs", () => {
    const base = baselineCanvasSize();
    for (const staticParticles of [false, true]) {
      const { rt, canvas } = mountParticleRuntime({
        staticParticles,
        renderScale: 0.5,
      });
      expect(canvas.width).toBe(Math.round(base.w * 0.5));
      expect(canvas.height).toBe(Math.round(base.h * 0.5));
      rt.setRenderScale(1);
      expect(canvas.width).toBe(base.w);
      rt.setStaticParticles(!staticParticles);
      expect(canvas.width).toBe(base.w); // a mode flip alone never re-sizes anything
      expect(rt.stats().pinnedCanvasSyncs).toBe(0);
      rt.dispose();
      document.body.innerHTML = "";
    }
  });
});
