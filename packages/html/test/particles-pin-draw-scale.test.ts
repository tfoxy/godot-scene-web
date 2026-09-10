// jsdom (gsw default env).
//
// The particle runtime draws its instance geometry in CSS px x the backing ratio, so a PINNED frozen canvas
// (`staticParticlePixelRatio`) must be drawn at the SAME ratio it was sized at — including the reduced ratio
// the longest-edge clamp leaves behind. If the draw kept using `devicePixelRatio x renderScale` while the
// canvas was pinned, every sprite would land at the wrong size/position inside it.
//
// `drawParticles` is stubbed so the packed instance buffer is observable (the fake GL cannot be read back);
// the deterministic LCG sim makes two runs of the same spec produce identical particle state, so the pinned
// run's floats can be compared against the un-pinned baseline exactly.

import { INSTANCE_STRIDE } from "@godot-scene-web/effects/particles";
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
import { createParticleRuntime } from "../src/particles/runtime";
import { __resetStaticParticleFrameCacheForTest } from "../src/particles/static-frame-cache";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import {
  __resetSharedForTest,
  MAX_PINNED_BACKING_DIM,
} from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

/** Instance floats of the last `drawParticles` call (copied — the runtime reuses the buffer). */
let lastInstances: number[] = [];

vi.mock("@godot-scene-web/canvas-effects/webgl", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@godot-scene-web/canvas-effects/webgl")
    >();
  return {
    ...actual,
    drawParticles: (
      _shared: unknown,
      _program: unknown,
      buffer: { data: Float32Array; count: number },
    ) => {
      lastInstances = Array.from(buffer.data.slice(0, buffer.count * 10));
    },
  };
});

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
function flushRaf(): void {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
}

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
  lastInstances = [];
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

const SPEC = JSON.stringify({
  kind: "GPUParticles2D",
  amount: 8,
  lifetime: 1,
  emitting: true,
  initialVelocityMin: 50,
  initialVelocityMax: 50,
  // A FULL-CIRCLE spread and NO GRAVITY, so the travel-extent margin is the same on all four sides
  // and the canvas stays SQUARE (see particles/extents.ts — Godot's default gravity is (0, 980),
  // which on its own gives a system half a screen of downward margin and none upward). That is a
  // precondition of the clamp assertion below, which recovers the granted ratio as
  // `clamped.width / base.width`: both are integers, so the estimator is only exact when the two
  // axes clamp identically.
  spread: 180,
  gravity: [0, 0],
  blendMode: 0,
  seed: 7, // deterministic across runs
});

// Mount one frozen particle system, run its single warm+draw tick, and return the packed instances
// plus the canvas the runtime sized for them.
function frozenDraw(over: Record<string, unknown>): {
  instances: number[];
  canvas: HTMLCanvasElement;
} {
  const root = document.createElement("div");
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", SPEC);
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

  const rt = createParticleRuntime(root, {
    enableParticles: true,
    staticParticles: true,
    ...over,
  } as never);
  rt.reconcile();
  flushRaf();
  const canvas = self.querySelector(
    "[data-godot-particle-canvas]",
  ) as HTMLCanvasElement;
  const instances = lastInstances;
  const size = { width: canvas.width, height: canvas.height };
  rt.dispose();
  document.body.innerHTML = "";
  return {
    instances,
    canvas: size as unknown as HTMLCanvasElement,
  };
}

describe("particle runtime — pinned draws match the pinned canvas", () => {
  it("scales instance geometry by the PIN, not by devicePixelRatio x renderScale", () => {
    const base = frozenDraw({});
    const pinned = frozenDraw({
      renderScale: 0.5,
      staticParticlePixelRatio: 2,
    });

    expect(base.instances.length).toBeGreaterThan(0);
    expect(pinned.instances.length).toBe(base.instances.length);
    expect(pinned.canvas.width).toBe(base.canvas.width * 2);

    // Position (0,1) and sprite size (2,3) are the ratio-scaled fields; rotation/color/frame (4..9)
    // are ratio-independent and must be untouched. x2 is exact in binary FP, so compare exactly.
    for (let i = 0; i < base.instances.length; i += INSTANCE_STRIDE) {
      for (const f of [0, 1, 2, 3]) {
        expect(pinned.instances[i + f]).toBe(base.instances[i + f] * 2);
      }
      for (const f of [4, 5, 6, 7, 8, 9]) {
        expect(pinned.instances[i + f]).toBe(base.instances[i + f]);
      }
    }
  });

  it("falls back to the CLAMPED ratio when the pinned size hit the cap", () => {
    const base = frozenDraw({});
    // 100px box + pad, x100 → far past the cap, so the canvas (and therefore the draw) lands on the
    // reduced ratio the clamp allowed, NOT on 100.
    const clamped = frozenDraw({ staticParticlePixelRatio: 100 });
    const applied = clamped.canvas.width / base.canvas.width;

    expect(Math.max(clamped.canvas.width, clamped.canvas.height)).toBe(
      MAX_PINNED_BACKING_DIM,
    );
    expect(applied).toBeLessThan(100); // the clamp really bit
    for (let i = 0; i < base.instances.length; i += INSTANCE_STRIDE) {
      for (const f of [0, 1, 2, 3]) {
        expect(clamped.instances[i + f]).toBeCloseTo(
          base.instances[i + f] * applied,
          2,
        );
      }
    }
  });
});
