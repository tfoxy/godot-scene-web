// jsdom (gsw default env).
//
// Effect-loop PACING (see ../src/effects-loop-pacing). Both live effect loops are FPS-capped, but they
// used to keep a rAF armed on EVERY display frame and skip inside the tick — so a 30fps cap on a 60Hz
// phone cost two main-thread frame wakeups per rendered frame, one of them pure overhead. With
// `effectsLoopPacing: "timer"` (the default) a capped loop PARKS on a setTimeout to the next cap
// boundary and re-enters through ONE rAF; the display frames it would only skip cost no frame wakeup at
// all. `effectsLoopPacing: "raf"` restores the old spin verbatim (the kill switch).
//
// The harness models a 60Hz display over a virtual clock: `performance.now` IS the clock, rAF callbacks
// run at each vsync, and timer callbacks run at their due time inside the interval. It counts rAF
// wakeups (the frame-pipeline cost the park removes), timer wakeups, and GL draws — the rendered frames,
// which must be IDENTICAL under both pacings.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createEffectsLoopPacer } from "../src/effects-loop-pacing";
import { createParticleRuntime } from "../src/particles/runtime";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { createWebglShaderRuntime } from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

// A TIME-reading shader with no screen-space inputs: it animates every frame and measures nothing.
const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";

const FRAME_MS = 1000 / 60;

let drawCount = 0;

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
    drawArrays: () => {
      drawCount += 1;
      return undefined;
    },
    drawArraysInstanced: () => {
      drawCount += 1;
      return undefined;
    },
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

interface PendingFrame {
  id: number;
  cb: FrameRequestCallback;
}
interface PendingTimer {
  id: number;
  due: number;
  cb: () => void;
}

let clockMs = 0;
let frames: PendingFrame[] = [];
let timers: PendingTimer[] = [];
let handleSeq = 1;
let rafWakeups = 0;
let timerWakeups = 0;

/** Run `count` display frames: due timers fire at their due time, then the vsync runs the rAF queue. */
function displayFrames(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const vsync = clockMs + FRAME_MS;
    for (;;) {
      let next: PendingTimer | null = null;
      for (const timer of timers) {
        if (timer.due <= vsync && (next === null || timer.due < next.due))
          next = timer;
      }
      if (next === null) break;
      const due = next;
      timers = timers.filter((timer) => timer !== due);
      clockMs = Math.max(clockMs, due.due);
      timerWakeups += 1;
      due.cb();
    }
    clockMs = vsync;
    const queued = frames;
    frames = [];
    for (const frame of queued) {
      rafWakeups += 1;
      frame.cb(clockMs);
    }
  }
}

/** Milliseconds until the pending park fires (Infinity = not parked). */
function parkDelay(): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const timer of timers) earliest = Math.min(earliest, timer.due);
  return earliest - clockMs;
}

function resetCounters(): void {
  drawCount = 0;
  rafWakeups = 0;
  timerWakeups = 0;
}

let origNow: () => number;
let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origSetTimeout: typeof globalThis.setTimeout;
let origClearTimeout: typeof globalThis.clearTimeout;
let origRO: typeof globalThis.ResizeObserver;

// The harness drains promise jobs on the REAL timer queue (the stubbed one is virtual-clock driven).
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => origSetTimeout(resolve, 0));
  }
};

beforeAll(() => {
  (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;
  origNow = performance.now;
  performance.now = (() => clockMs) as typeof performance.now;
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return new Proxy({}, { get: () => () => undefined });
    return null;
  }) as typeof HTMLCanvasElement.prototype.getContext;
  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;
  origSetTimeout = globalThis.setTimeout;
  origClearTimeout = globalThis.clearTimeout;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = handleSeq++;
    frames.push({ id, cb });
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    frames = frames.filter((frame) => frame.id !== id);
  }) as typeof globalThis.cancelAnimationFrame;
  globalThis.setTimeout = ((cb: () => void, ms?: number) => {
    const id = handleSeq++;
    timers.push({ id, due: clockMs + (ms ?? 0), cb });
    return id;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers = timers.filter((timer) => timer.id !== id);
  }) as unknown as typeof globalThis.clearTimeout;
  origRO = globalThis.ResizeObserver;
});

afterAll(() => {
  performance.now = origNow;
  HTMLCanvasElement.prototype.getContext = origGetContext;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.setTimeout = origSetTimeout;
  globalThis.clearTimeout = origClearTimeout;
  globalThis.ResizeObserver = origRO;
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest(); // also resets the shared clock origin
  clockMs = 0;
  frames = [];
  timers = [];
  resetCounters();
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// NB: unique shader paths per test — the program cache is module-scoped.
function mountShaderRoot(path: string): {
  root: HTMLElement;
  node: HTMLElement;
} {
  const root = document.createElement("div");
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
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
  return { root, node };
}

const shaderOptions = (over: Record<string, unknown> = {}) =>
  ({ resolveShaderSource: async () => SHADER, ...over }) as never;

function particleSpec(): string {
  return JSON.stringify({
    kind: "GPUParticles2D",
    amount: 8,
    lifetime: 1,
    emitting: true,
    initialVelocityMin: 50,
    initialVelocityMax: 50,
    blendMode: 0,
  });
}

function mountParticleRoot(): HTMLElement {
  const root = document.createElement("div");
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", particleSpec());
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
  return root;
}

describe("effect-loop pacing — WebGL shader runtime", () => {
  it("timer pacing (default): one rAF per CAPPED frame, not per display frame", async () => {
    const { root } = mountShaderRoot("res://pace-timer.gdshader");
    const rt = createWebglShaderRuntime(root, shaderOptions({ shaderFps: 30 }));
    rt.reconcile();
    await settle();
    resetCounters();

    displayFrames(60); // one simulated second at 60Hz

    // A 30fps cap over a second: ~30 rendered frames, and ONE frame wakeup per rendered frame —
    // not the 60 the pre-pacing spin armed.
    expect(drawCount).toBeGreaterThanOrEqual(28);
    expect(drawCount).toBeLessThanOrEqual(31);
    expect(rafWakeups).toBeLessThanOrEqual(31);
    expect(rafWakeups).toBe(drawCount); // every frame wakeup rendered; none was a pure skip
    expect(timerWakeups).toBeLessThanOrEqual(31);
    rt.dispose();
  });

  it("raf pacing (kill switch): keeps the pre-pacing per-display-frame arming", async () => {
    const { root } = mountShaderRoot("res://pace-raf.gdshader");
    const rt = createWebglShaderRuntime(
      root,
      shaderOptions({ shaderFps: 30, effectsLoopPacing: "raf" }),
    );
    rt.reconcile();
    await settle();
    resetCounters();

    displayFrames(60);

    expect(rafWakeups).toBe(60); // a rAF every display frame — most of them pure skips
    expect(timerWakeups).toBe(0); // …and never a park
    expect(timers).toHaveLength(0);
    // The spin's cap check is EXACT, so a boundary the vsync grid misses by a hair costs a whole
    // display frame — it under-delivers the cap (~22fps for a 30 cap here). That is what the parked
    // path's boundary slop fixes; both are within the cap.
    expect(drawCount).toBeGreaterThanOrEqual(20);
    expect(drawCount).toBeLessThanOrEqual(31);
    rt.dispose();
  });

  it("never renders FEWER frames than the spin, at a fraction of the frame wakeups", async () => {
    const timerRoot = mountShaderRoot("res://pace-same-timer.gdshader");
    const timerRt = createWebglShaderRuntime(
      timerRoot.root,
      shaderOptions({ shaderFps: 30 }),
    );
    timerRt.reconcile();
    await settle();
    resetCounters();
    displayFrames(60);
    const parked = { draws: drawCount, raf: rafWakeups };
    timerRt.dispose();

    __resetSharedForTest();
    clockMs = 0;
    frames = [];
    timers = [];
    resetCounters();
    const rafRoot = mountShaderRoot("res://pace-same-raf.gdshader");
    const rafRt = createWebglShaderRuntime(
      rafRoot.root,
      shaderOptions({ shaderFps: 30, effectsLoopPacing: "raf" }),
    );
    rafRt.reconcile();
    await settle();
    resetCounters();
    displayFrames(60);

    expect(parked.draws).toBeGreaterThanOrEqual(drawCount); // the animation never gets slower…
    expect(parked.draws).toBeLessThanOrEqual(31); // …and still honours the 30fps cap
    expect(parked.raf).toBeLessThan(rafWakeups / 1.5); // at a fraction of the frame wakeups
    rafRt.dispose();
  });

  it("an invalidation during a park renders at the next cap boundary, and never double-arms", async () => {
    const { root, node } = mountShaderRoot("res://pace-invalidate.gdshader");
    const rt = createWebglShaderRuntime(root, shaderOptions({ shaderFps: 30 }));
    rt.reconcile();
    await settle();
    displayFrames(2); // the first capped frame renders, then the loop parks
    resetCounters();
    expect(frames).toHaveLength(0);
    expect(timers).toHaveLength(1);
    const parkedFor = parkDelay();

    // A host re-render lands mid-park: it must ride the pending park, not arm a second wakeup.
    node.setAttribute("data-godot-shader-params", '{"amount":0.5}');
    rt.reconcile();
    expect(frames).toHaveLength(0);
    expect(timers).toHaveLength(1);
    expect(parkDelay()).toBe(parkedFor);

    displayFrames(1); // still inside the cap interval: nothing rendered, nothing woke
    expect(drawCount).toBe(0);
    expect(rafWakeups).toBe(0);

    displayFrames(1); // the cap boundary: the park re-entered and rendered
    expect(drawCount).toBe(1);
    expect(rafWakeups).toBe(1);
    rt.dispose();
  });

  it("dispose() mid-park leaves no timer and no rAF behind", async () => {
    const { root } = mountShaderRoot("res://pace-dispose-park.gdshader");
    const rt = createWebglShaderRuntime(root, shaderOptions({ shaderFps: 30 }));
    rt.reconcile();
    await settle();
    displayFrames(2);
    expect(timers).toHaveLength(1); // parked

    rt.dispose();
    resetCounters();
    expect(timers).toHaveLength(0);
    expect(frames).toHaveLength(0);

    displayFrames(20);
    expect(rafWakeups).toBe(0);
    expect(timerWakeups).toBe(0);
    expect(drawCount).toBe(0);
  });

  it("dispose() cancels an in-flight rAF (uncapped loop)", async () => {
    const { root } = mountShaderRoot("res://pace-dispose-raf.gdshader");
    const rt = createWebglShaderRuntime(root, shaderOptions()); // uncapped: a rAF is always armed
    rt.reconcile();
    await settle();
    displayFrames(1);
    expect(frames).toHaveLength(1);

    rt.dispose();
    resetCounters();
    expect(frames).toHaveLength(0);
    displayFrames(5);
    expect(rafWakeups).toBe(0);
    expect(drawCount).toBe(0);
  });

  it("setFps() drops a park armed against the OLD cap", async () => {
    const { root } = mountShaderRoot("res://pace-setfps.gdshader");
    const rt = createWebglShaderRuntime(root, shaderOptions({ shaderFps: 5 }));
    rt.reconcile();
    await settle();
    displayFrames(13); // past the 200ms boundary: rendered, then parked for the next one
    expect(timers).toHaveLength(1);
    expect(parkDelay()).toBeGreaterThan(150);

    rt.setFps(60);
    // The 200ms-cap park is gone and the loop is armed against the NEW cap instead — as a park when
    // the 60fps boundary is still ahead, as a rAF when (as here) it is already due.
    const armedIn = frames.length > 0 ? 0 : parkDelay();
    expect(timers.length + frames.length).toBe(1); // re-armed, not stacked
    expect(armedIn).toBeLessThanOrEqual(1000 / 60);
    rt.dispose();
  });
});

describe("effect-loop pacing — particle runtime", () => {
  it("timer pacing (default): one rAF per capped frame, not per display frame", () => {
    const root = mountParticleRoot();
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      particleFps: 25,
    } as never);
    rt.reconcile();
    resetCounters();

    displayFrames(60); // one simulated second at 60Hz

    // A 40ms cap on a 16.7ms grid renders on the first vsync at/after each boundary (20/s, exactly
    // as the spin did) — the point here is that nothing wakes in between.
    expect(drawCount).toBeGreaterThanOrEqual(18);
    expect(drawCount).toBeLessThanOrEqual(25);
    expect(rafWakeups).toBe(drawCount);
    expect(timerWakeups).toBeLessThanOrEqual(25);
    rt.dispose();
  });

  it("raf pacing (kill switch): keeps the pre-pacing per-display-frame arming", () => {
    const root = mountParticleRoot();
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      particleFps: 25,
      effectsLoopPacing: "raf",
    } as never);
    rt.reconcile();
    resetCounters();

    displayFrames(60);

    expect(rafWakeups).toBe(60);
    expect(timerWakeups).toBe(0);
    expect(timers).toHaveLength(0);
    rt.dispose();
  });

  it("dispose() mid-park leaves no timer and no rAF behind", () => {
    const root = mountParticleRoot();
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      particleFps: 25,
    } as never);
    rt.reconcile();
    displayFrames(4); // rendered at least one capped frame, then parked
    expect(timers).toHaveLength(1);

    rt.dispose();
    resetCounters();
    expect(timers).toHaveLength(0);
    expect(frames).toHaveLength(0);

    displayFrames(20);
    expect(rafWakeups).toBe(0);
    expect(timerWakeups).toBe(0);
    expect(drawCount).toBe(0);
  });
});

describe("createEffectsLoopPacer", () => {
  it("arms ONE wakeup at a time (a pending park absorbs further arms)", () => {
    let ticks = 0;
    const pacer = createEffectsLoopPacer(() => {
      ticks += 1;
    }, "timer");

    pacer.arm(0.033);
    pacer.arm(0.033);
    pacer.arm(0.001);
    expect(timers).toHaveLength(1);
    expect(frames).toHaveLength(0);
    expect(pacer.isArmed()).toBe(true);

    displayFrames(3);
    expect(ticks).toBe(1); // one park → one rAF → one tick
    expect(pacer.isArmed()).toBe(false);
    pacer.cancel();
  });

  it("arms rAF directly for a boundary inside the slop, and never parks under 'raf' pacing", () => {
    const parking = createEffectsLoopPacer(() => {}, "timer");
    parking.arm(0.001); // inside the boundary slop → no timer hop
    expect(timers).toHaveLength(0);
    expect(frames).toHaveLength(1);
    expect(parking.isDue(0.001)).toBe(true);
    parking.cancel();

    const spinning = createEffectsLoopPacer(() => {}, "raf");
    spinning.arm(1); // a whole second away — "raf" pacing still re-arms immediately
    expect(timers).toHaveLength(0);
    expect(frames).toHaveLength(1);
    expect(spinning.isDue(0.001)).toBe(false); // exact cap check, as before pacing
    spinning.cancel();
  });
});
