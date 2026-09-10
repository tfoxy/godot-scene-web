// jsdom (gsw default env).
//
// Frozen (static) particle mode, the sibling of the shader runtime's `staticShaders`: with `staticParticles`,
// each system is WARMED to a representative mid-flight state, drawn ONCE, and the rAF loop SELF-PARKS (no
// per-frame simulate/draw), while the frozen spray stays on-screen. A re-triggered/newly-mounted system is
// re-warmed and re-frozen. These stub a fake WebGL2/2D context and a CONTROLLABLE rAF queue (flushed by hand)
// so the loop's park/alive behaviour is observable, plus a pure test of the warm helper.

import {
  activeParticleCount,
  createParticleState,
  warmStaticParticles,
} from "@godot-scene-web/effects/particles";
import { normalizeParticleSpecConfig as normalizeParticleConfig } from "@godot-scene-web/html/runtime";
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
import { __resetStaticParticleFrameCacheForTest } from "../src/particles/static-frame-cache";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { createStaticImageSwapCounters } from "../src/surface-image-swap";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

const options = { enableParticles: true } as never;
const staticOptions = { enableParticles: true, staticParticles: true } as never;

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

// Controllable rAF: queue callbacks, flush them by hand so we can observe whether the loop reschedules itself.
let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
  return q.length;
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
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// A non-additive (blendMode 0) spec so the draw path never hits the additive accumulator FBO under the fake GL.
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

function particleNode(specJson: string): {
  node: HTMLElement;
  self: HTMLElement;
} {
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
  return { node, self };
}

const canvasIn = (self: HTMLElement): Element | null =>
  self.querySelector("[data-godot-particle-canvas]");

describe("warmStaticParticles (pure)", () => {
  function state(over: Record<string, unknown> = {}) {
    return createParticleState(
      normalizeParticleConfig({
        amount: 16,
        lifetime: 1,
        emitting: true,
        initialVelocityMin: 40,
        initialVelocityMax: 40,
        ...over,
      }),
      2048,
    );
  }

  it("populates a fresh (un-preprocessed) continuous emitter with in-flight particles", () => {
    const s = state({ oneShot: false, preprocess: 0 });
    expect(activeParticleCount(s)).toBe(0); // nothing born yet at t=0
    warmStaticParticles(s);
    expect(activeParticleCount(s)).toBeGreaterThan(0); // warmed to a representative spread
    expect(s.remainder).toBe(0); // sub-step remainder dropped → clean frozen state
  });

  it("populates a fresh one-shot burst mid-flight (not the empty t=0 nor the fully-dead end)", () => {
    const s = state({ oneShot: true, explosiveness: 1, preprocess: 0 });
    warmStaticParticles(s);
    expect(activeParticleCount(s)).toBeGreaterThan(0);
  });

  it("reaches steady drift for an authored-preprocess ambient emitter", () => {
    const s = state({ oneShot: false, preprocess: 5 });
    warmStaticParticles(s);
    expect(activeParticleCount(s)).toBeGreaterThan(0);
  });
});

describe("particle runtime — frozen (static) mode", () => {
  it("static from options: warms + draws once, then the loop self-parks (no reschedule)", () => {
    const root = document.createElement("div");
    const { node, self } = particleNode(spec());
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    expect(canvasIn(self)).toBeTruthy();
    expect(rafQueue.length).toBe(1); // reconcile kicked the loop once

    flushRaf(); // the one queued tick warms + draws the frozen frame…
    expect(rafQueue.length).toBe(0); // …and PARKS (a live emitter would otherwise re-arm)
    flushRaf(); // a further frame does nothing (already parked)
    expect(rafQueue.length).toBe(0);
    rt.dispose();
  });

  it("animated mode (default) keeps the loop alive for a live emitter", () => {
    const root = document.createElement("div");
    const { node } = particleNode(spec());
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    flushRaf();
    expect(rafQueue.length).toBe(1); // a live emitter re-armed the loop (contrast: static parks)
    rt.dispose();
  });

  it("setStaticParticles(true) parks a running loop; (false) resumes live simulation", () => {
    const root = document.createElement("div");
    const { node } = particleNode(spec());
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    flushRaf();
    expect(rafQueue.length).toBe(1); // alive

    rt.setStaticParticles(true); // freeze → next tick warms + draws + parks
    flushRaf();
    expect(rafQueue.length).toBe(0); // parked

    rt.setStaticParticles(false); // resume → loop kicked again
    flushRaf();
    expect(rafQueue.length).toBe(1); // alive again
    rt.dispose();
  });

  it("re-warms + re-freezes a newly mounted node while static (loop still parks)", () => {
    const root = document.createElement("div");
    const a = particleNode(spec());
    root.appendChild(a.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    flushRaf();
    expect(rafQueue.length).toBe(0); // frozen + parked

    // A new node appears while frozen → reconcile re-kicks the loop, which warms the new binding and re-parks.
    const b = particleNode(spec());
    root.appendChild(b.node);
    rt.reconcile();
    expect(rafQueue.length).toBe(1); // reconcile kicked the loop for the new binding
    flushRaf();
    expect(canvasIn(b.self)).toBeTruthy(); // new binding created + drawn
    expect(rafQueue.length).toBe(0); // …and re-parked
    rt.dispose();
  });

  // A backing-store resize CLEARS the 2D canvas. While frozen the loop is PARKED and would never
  // redraw, so the frozen spray vanished after any resize (a rotate, a letterbox/viewport change,
  // a settings panel opening). The runtime must re-kick the loop from its ResizeObserver.
  function captureResizeObserver(): { deliver: (entries: unknown[]) => void } {
    const box = { deliver: (_: unknown[]) => {} };
    globalThis.ResizeObserver = makeResizeObserverStub({
      onConstruct: (cb) => {
        box.deliver = cb as unknown as (entries: unknown[]) => void;
      },
    });
    return box;
  }

  it("a REAL canvas resize while frozen re-kicks the parked loop (redrawing the frozen frame)", () => {
    const ro = captureResizeObserver();
    const root = document.createElement("div");
    const { node, self } = particleNode(spec());
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    flushRaf();
    expect(rafQueue.length).toBe(0); // frozen + parked
    const canvas = canvasIn(self) as HTMLCanvasElement;
    const before = canvas.width;

    // The self-layer grew → the canvas is re-sized, and thereby CLEARED.
    ro.deliver([{ target: self, contentRect: { width: 400, height: 400 } }]);
    expect(canvas.width).not.toBe(before); // the backing store really was reallocated
    expect(rafQueue.length).toBe(1); // …and the parked loop was woken to redraw it

    flushRaf();
    expect(rafQueue.length).toBe(0); // redrew once and re-parked (still zero per-frame cost)
    rt.dispose();
  });

  it("a no-op resize observation does NOT wake the parked loop", () => {
    const ro = captureResizeObserver();
    const root = document.createElement("div");
    const { node, self } = particleNode(spec());
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    flushRaf();
    expect(rafQueue.length).toBe(0);

    // Same size as the stubbed clientWidth/Height → nothing reallocated, nothing to redraw.
    ro.deliver([{ target: self, contentRect: { width: 100, height: 100 } }]);
    expect(rafQueue.length).toBe(0);
    rt.dispose();
  });

  it("setStaticParticles is always callable (no bindings) and is idempotent", () => {
    const root = document.createElement("div");
    const rt = createParticleRuntime(root, options);
    expect(() => {
      rt.setStaticParticles(true);
      rt.setStaticParticles(true); // idempotent (already static)
      rt.setStaticParticles(false);
      rt.dispose();
    }).not.toThrow();
  });
});

// Instrumentation seam (ParticleRuntimeStats — the shader runtime's stats() sibling): `draws` counts
// actual instanced GL draws of a system frame, nothing else, and never resets.
describe("particle runtime — stats() counters", () => {
  it("counts instanced draws; a parked frozen loop adds none; the no-op handle stays all-zero", () => {
    const root = document.createElement("div");
    const { node } = particleNode(spec());
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    // `pinnedCanvasSyncs` stays 0: these options set no `staticParticlePixelRatio`, so every canvas
    // is sized the un-pinned way. `boxReads` is 0 — the reconcile forces NO layout at all, because
    // the binding's first box came from the observer's initial delivery (`particleObserverSizing`,
    // the default; see `particles-rect-cache.test.ts`). The dormancy-park
    // counters are all 0 too: nothing here is suspended, so no binding is ever parked (see
    // `particles-dormant.test.ts`). The swap counters
    // (`ParticleRuntimeStats extends StaticImageSwapCounters`) are all zero — `staticParticleImages`
    // is opt-in and unset here, so the mechanism never runs; this stays an EXHAUSTIVE shape assertion.
    // `profile` is NULL, not a zeroed object: `effectsProfiling` is unset, so nothing was measured
    // (see `particles-profiling.test.ts`).
    expect(rt.stats()).toEqual({
      draws: 0,
      cacheHits: 0,
      pinnedCanvasSyncs: 0,
      boxReads: 0,
      dormantParks: 0,
      dormantWakes: 0,
      dormantDisposes: 0,
      dormantLive: 0,
      profile: null,
      // The renderer gate's jsdom answer (see `particles-webgpu-gate.test.ts`): `effectsRenderer`
      // defaults to "auto", jsdom has no `navigator.gpu`, so WebGL is adopted SYNCHRONOUSLY — which
      // is what keeps this whole suite on the path it was on before WebGPU existed. The decline is
      // counted and explained rather than hidden.
      renderer: "webgl",
      webgpuFallbacks: 1,
      webgpuFallbackReason: "no-navigator-gpu",
      webgpuSubmits: 0,
      webgpuDeviceLosses: 0,
      webgpuErrors: 0,
      staticStillDonors: 0,
      staticStillDonorBakes: 0,
      staticStillDonorsDropped: 0,
      ...createStaticImageSwapCounters(),
    }); // nothing drawn until the tick runs

    flushRaf(); // warm + draw the one frozen frame
    expect(rt.stats().draws).toBe(1);
    flushRaf(); // parked → no further draw
    expect(rt.stats().draws).toBe(1);
    rt.dispose();

    const noop = createParticleRuntime(document.createElement("div"), {
      enableParticles: false,
    } as never);
    expect(noop.stats()).toEqual({
      draws: 0,
      cacheHits: 0,
      pinnedCanvasSyncs: 0,
      boxReads: 0,
      dormantParks: 0,
      dormantWakes: 0,
      dormantDisposes: 0,
      dormantLive: 0,
      profile: null,
      // "none" — no renderer at all, and nothing was ever asked for: the no-op handle never opened
      // the gate, so it reports no fallback and no reason (a runtime that DID probe reports both).
      renderer: "none",
      webgpuFallbacks: 0,
      webgpuFallbackReason: null,
      webgpuSubmits: 0,
      webgpuDeviceLosses: 0,
      webgpuErrors: 0,
      staticStillDonors: 0,
      staticStillDonorBakes: 0,
      staticStillDonorsDropped: 0,
      ...createStaticImageSwapCounters(),
    });
    noop.dispose();
  });
});
