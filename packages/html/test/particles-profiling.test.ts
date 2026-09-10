// jsdom (gsw default env).
//
// OPT-IN per-frame cost attribution for the particle runtime (`effectsProfiling`, see `../src/types`
// and `ParticleProfile`): a live tick is split into CPU SIM / instance-buffer BUILD / GL SUBMIT /
// GL→2D BLIT so a benchmark can say WHICH of them a slow phone is spending its frame in.
//
// Two properties are what these tests actually defend, and both are about the OFF state:
//
//   1. OFF IS NULL, NOT ZERO. `stats().profile` is `null` when nothing measured. A zeroed object
//      would let a bench report "the simulation is free" when the truth is "nobody measured", and
//      that is a worse failure than no profiler at all.
//   2. OFF COSTS NOTHING PER BINDING. Every bracket sits behind one hoisted null check, so an
//      unprofiled tick takes no clock reading whatever — asserted by SPYING on `performance.now`
//      (which the runtime's own clock also goes through) and showing its call count does not grow
//      with the binding count.
//
// Harness copied from `particles-static.test.ts`: fake WebGL2/2D contexts, a hand-flushed rAF queue,
// and the shared ResizeObserver stub (whose initial delivery is what mounts a binding's canvas under
// the default `particleObserverSizing`). The CLOCK is stubbed too, and deterministically: it advances
// only between pumped ticks, so `dt` per tick is exactly what the test says and every measured
// interval inside a tick is exactly 0 ms — real timings are a device question, not a jsdom one.
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
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

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

// Controllable rAF: queue callbacks, flush them by hand so a "tick" is an explicit test step.
let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
  return q.length;
}

// The stubbed clock (ms), moved ONLY by `pumpTick`. Frozen inside a tick, so every bracketed
// interval measures exactly 0 — finite and >= 0, which is all a jsdom run can honestly assert.
let clockMs = 0;
// One display frame's worth of ticks: advance the clock, then run whatever the loop armed.
const TICK_MS = 34; // > 1/30 s, so each tick buys exactly one fixed sub-step per binding
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
  // The runtime's own clock (`nowSeconds`) latches its origin on first read, so it must be reset
  // alongside the shared GL — otherwise the first tick of a suite sees the previous test's elapsed
  // time as its `dt`.
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  rafQueue = [];
  clockMs = 0;
  globalThis.ResizeObserver = makeResizeObserverStub();
  // Every clock reading in the runtime — the loop's `nowSeconds` and the profiler's brackets alike —
  // goes through `performance.now`, which is exactly why this spy can count the profiler's cost.
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clockMs);
});

afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
  document.body.innerHTML = "";
});

// A non-additive (blendMode 0) spec so the draw path never hits the additive accumulator FBO under
// the fake GL. `explosiveness: 1` births every particle on the first sub-step, so a pumped tick
// always has instances to push (and the system stays live for the whole run, keeping the loop armed).
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

// A root carrying `systems` particle nodes, mounted in the document.
function mountRoot(systems: number, specJson = spec()): HTMLElement {
  const root = document.createElement("div");
  for (let i = 0; i < systems; i += 1) root.appendChild(particleNode(specJson));
  document.body.appendChild(root);
  return root;
}

describe("particle runtime — effectsProfiling OFF (the default)", () => {
  it("reports profile === null — 'not measured', never a zeroed object", () => {
    const rt = createParticleRuntime(mountRoot(1), {
      enableParticles: true,
    } as never);
    rt.reconcile();
    pumpTick();
    // Strictly null: a bench must not be able to read `simMs: 0` out of an un-instrumented runtime.
    expect(rt.stats().profile).toBeNull();
    expect(rt.stats().draws).toBeGreaterThan(0); // …and it really did draw, so this is not a no-op handle
    rt.dispose();

    // The no-op handle (particles unavailable/disabled) reports null too — it never measured either.
    const noop = createParticleRuntime(document.createElement("div"), {
      enableParticles: false,
    } as never);
    expect(noop.stats().profile).toBeNull();
    noop.dispose();
  });

  it("takes NO clock reading per binding: the tick's cost does not grow with the binding count", () => {
    // The runtime reads the clock a fixed number of times per TICK (loop pacing), and — with
    // profiling off — zero times per BINDING. So the same number of ticks over 1 system and over 8
    // must cost the same number of `performance.now()` calls. This is the assertion that keeps the
    // brackets behind their hoisted guard: a `performance.now()` that escaped one would show up
    // here as 8x the readings.
    const measure = (
      systems: number,
      options: Record<string, unknown>,
    ): number => {
      const root = mountRoot(systems);
      const rt = createParticleRuntime(root, options as never);
      rt.reconcile();
      pumpTick(); // first tick: mount/warm effects settle out of the counted window
      const before = nowSpy?.mock.calls.length ?? 0;
      for (let i = 0; i < 4; i += 1) pumpTick();
      const cost = (nowSpy?.mock.calls.length ?? 0) - before;
      rt.dispose();
      root.remove();
      return cost;
    };

    const off = { enableParticles: true };
    const oneOff = measure(1, off);
    const eightOff = measure(8, off);
    expect(eightOff).toBe(oneOff);

    // …and the same window WITH profiling on does scale with bindings, which is what proves the
    // comparison above is measuring the guard and not a suite that simply never ticked.
    const on = { enableParticles: true, effectsProfiling: true };
    expect(measure(8, on)).toBeGreaterThan(measure(1, on));
  });
});

describe("particle runtime — effectsProfiling ON", () => {
  it("attributes each live tick to sim / build / GL submit / blit", () => {
    const systems = 3;
    const ticks = 5;
    const root = mountRoot(systems);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      effectsProfiling: true,
    } as never);
    rt.reconcile();
    for (let i = 0; i < ticks; i += 1) pumpTick();

    const profile = rt.stats().profile;
    if (!profile)
      throw new Error("effectsProfiling: true must allocate a profile");

    // Every pumped tick ran the live path (the loop stays armed while the systems are alive), and
    // each one simulated + drew every binding.
    expect(profile.ticks).toBe(ticks);
    expect(profile.bindings).toBe(ticks * systems);
    // The sim ran at its OWN rate: TICK_MS (34) > one 1/30 sub-step, so one step per binding-tick.
    // The relation, not the absolute number, is the point — `simSteps` is decoupled from `ticks`.
    expect(profile.simSteps).toBe(profile.bindings);
    // Something was really pushed into the instance buffer, i.e. the build bucket had work to do.
    expect(profile.instances).toBeGreaterThan(0);
    expect(profile.instances).toBeGreaterThanOrEqual(profile.bindings);
    // Under the stubbed (frozen-inside-a-tick) clock every interval is exactly 0 ms. What is
    // asserted is the CONTRACT — finite, never negative, never NaN from an unbalanced bracket.
    for (const ms of [
      profile.simMs,
      profile.buildMs,
      profile.glMs,
      profile.blitMs,
    ]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    // The same live object on every read (the `ParticleRuntimeStats` contract), so a bench can hold
    // it across a window instead of re-reading the handle.
    expect(rt.stats().profile).toBe(profile);
    rt.dispose();
  });

  it("keeps counting across ticks (monotonic, never reset)", () => {
    const root = mountRoot(1);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      effectsProfiling: true,
    } as never);
    rt.reconcile();
    pumpTick();
    const after1 = { ...(rt.stats().profile ?? {}) } as {
      ticks: number;
      simSteps: number;
    };
    pumpTick();
    pumpTick();
    const profile = rt.stats().profile;
    expect(profile?.ticks).toBe(after1.ticks + 2);
    expect(profile?.simSteps).toBeGreaterThan(after1.simSteps);
    rt.dispose();
  });

  it("books NOTHING for frozen (staticParticles) mode — a parked loop has no per-frame cost", () => {
    const root = mountRoot(2);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      effectsProfiling: true,
    } as never);
    rt.reconcile();
    pumpTick(); // warms + draws each binding ONCE, then PARKS the loop
    expect(rafQueue.length).toBe(0); // parked: nothing re-armed
    pumpTick(); // …so further frames do no work at all

    const profile = rt.stats().profile;
    // The frozen draw is real work, but it is NOT a per-frame cost, and charging it to buckets whose
    // denominator is `ticks` would invent a per-frame cost this mode does not have. `stats().draws`
    // is where that one-off shows up.
    expect(profile).toEqual({
      ticks: 0,
      bindings: 0,
      simSteps: 0,
      instances: 0,
      simMs: 0,
      buildMs: 0,
      glMs: 0,
      blitMs: 0,
    });
    expect(rt.stats().draws).toBeGreaterThan(0);
    rt.dispose();
  });
});
