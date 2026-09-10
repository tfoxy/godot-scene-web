// jsdom (gsw default env).
//
// FROZEN-MODE ONE-SHOT EXPIRY: in `staticParticles` mode a system is warmed to one representative frame and
// parked, which is right for an emitter that runs forever and WRONG for a burst. A one-shot is a burst, and in
// animated mode this runtime already ends it by itself — the sim clears `emitting` after one cycle, the last
// particle dies at `lifetime * (2 - explosiveness)` (Godot's own `active_time`), and the final draw leaves the
// canvas BLANK. The frozen path had no such endpoint: it drew the warmed mid-flight frame and parked it for as
// long as the node stayed mounted.
//
// WHY THAT MATTERED. The only other input that could retire the frame is the host's `emitting` flag, and a host
// can get it stuck. The live case: a game-side visual freeze (couch-coop's headless CPU saver) disables each
// particle node's process — the very process Godot clears `Emitting` from at the end of a one-shot cycle — so
// every energy-counter VFX latched `emitting: true` forever and the browser mirror painted a permanent "energy
// ring" over a counter the game itself was showing bare. The game side is fixed at the source; this is the
// renderer's own backstop, and it is general: no host can pin a burst on screen past its own active window.
//
// What is pinned here:
//   - the LAW (`oneShotBurstSeconds`) is Godot's `lifetime * (2 - explosiveness)` — the same law the game-side
//     mod schedules its end-of-burst by, so the two sides agree on when a burst is over;
//   - a legitimate transient still shows for its FULL window (measured from this client's first sight of the
//     burst — it cannot know when the host started it), and is retired only after;
//   - the frozen loop WAKES ITSELF at the burst end. A parked loop has no other reason to run, so without that
//     wake the burst would sit there until some unrelated event kicked the loop;
//   - a continuous emitter arms no wake at all (the frozen loop must stay at zero per-frame cost);
//   - `staticParticleOneShotExpiry: false` is the kill switch — nothing is ever retired.
//
// jsdom has no raster, so "is it still being drawn?" is asserted through `stats()` (`draws` + `cacheHits`, the
// two ways a frozen binding paints) and through the recorded 2D context calls, never through pixels.

import {
  oneShotBurstSeconds,
  staticOneShotExpired,
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

// Every 2D call the runtime makes, in order. A RETIRE is the distinguishing shape: a `clearRect` with no
// `drawImage` after it (a redraw and a cache-hit blit both end in one).
let ops2d: string[] = [];

// Controllable rAF: queue callbacks, flush them by hand so the loop's park/wake is observable.
let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
  return q.length;
}

// The shared monotonic clock the runtime reads through shared-gl's `performanceNow`.
let clockMs = 0;
const advanceSeconds = (s: number): void => {
  clockMs += s * 1000;
};

// Wait (real time) for the pacer's setTimeout park to hand the loop back to rAF — the DEFAULT pacing, i.e. what
// production does. Polls rather than sleeping a fixed amount so the assertion is not a race.
async function waitForRaf(maxMs = 1000): Promise<boolean> {
  const started = Date.now();
  while (rafQueue.length === 0 && Date.now() - started < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return rafQueue.length > 0;
}

let origNow: () => number;
let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;

beforeAll(() => {
  origNow = performance.now;
  performance.now = (() => clockMs) as typeof performance.now;
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") {
      return new Proxy(
        {},
        {
          get:
            (_target, key: string) =>
            (...args: unknown[]): undefined => {
              void args;
              ops2d.push(key);
              return undefined;
            },
        },
      );
    }
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
  performance.now = origNow;
  HTMLCanvasElement.prototype.getContext = origGetContext;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest(); // also resets the shared clock origin
  __resetStaticParticleFrameCacheForTest();
  clockMs = 0;
  rafQueue = [];
  ops2d = [];
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// lifetime 0.4 / explosiveness 0 ⇒ an 0.8s active window. These are the live energy-ring numbers
// (`vfx_common_ring_polar_a` as instanced in the regent energy counter).
function spec(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "GPUParticles2D",
    amount: 8,
    lifetime: 0.4,
    explosiveness: 0,
    oneShot: true,
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

function mount(specJson: string): HTMLElement {
  const root = document.createElement("div");
  root.appendChild(particleNode(specJson).node);
  document.body.appendChild(root);
  return root;
}

describe("one-shot burst window (pure)", () => {
  it("is Godot's `lifetime * (2 - explosiveness)` — the same law the game side schedules by", () => {
    const cfg = (over: Record<string, unknown>) =>
      normalizeParticleConfig({ lifetime: 1, ...over } as never);
    // explosiveness 1: every particle is born at t=0, so the cycle is ONE lifetime.
    expect(oneShotBurstSeconds(cfg({ explosiveness: 1 }))).toBeCloseTo(1, 10);
    // explosiveness 0: births are spread over a full lifetime, so the last particle dies at 2x.
    expect(oneShotBurstSeconds(cfg({ explosiveness: 0 }))).toBeCloseTo(2, 10);
    expect(
      oneShotBurstSeconds(cfg({ lifetime: 2, explosiveness: 0.5 })),
    ).toBeCloseTo(3, 10);
    // The live energy ring.
    expect(
      oneShotBurstSeconds(cfg({ lifetime: 0.4, explosiveness: 0 })),
    ).toBeCloseTo(0.8, 10);
  });

  it("expires a one-shot only AFTER its full window, and never expires anything else", () => {
    const burst = normalizeParticleConfig({
      lifetime: 0.4,
      explosiveness: 0,
      oneShot: true,
      emitting: true,
    } as never);
    // A legitimate transient (a hit spark) must still get its whole natural life on screen…
    expect(staticOneShotExpired(burst, 0)).toBe(false);
    expect(staticOneShotExpired(burst, 0.79)).toBe(false);
    // …and only then stop being drawn.
    expect(staticOneShotExpired(burst, 0.8)).toBe(true);
    expect(staticOneShotExpired(burst, 30)).toBe(true);

    // A CONTINUOUS emitter genuinely runs forever — retiring one would erase an ambient the scene wants.
    const ambient = normalizeParticleConfig({
      lifetime: 0.4,
      oneShot: false,
      emitting: true,
    } as never);
    expect(staticOneShotExpired(ambient, 999)).toBe(false);

    // A one-shot the host says is NOT emitting is not a burst on screen at all: there is nothing to retire
    // (the warm produces an empty frame), so the rule has no opinion about it.
    const idle = normalizeParticleConfig({
      lifetime: 0.4,
      oneShot: true,
      emitting: false,
    } as never);
    expect(staticOneShotExpired(idle, 999)).toBe(false);
  });
});

describe("particle runtime — frozen one-shot expiry", () => {
  // "raf" pacing makes the loop's self-wake land in the hand-flushed rAF queue, so the whole burst timeline is
  // observable without real timers (the default "timer" pacing is covered on its own below).
  const staticOptions = {
    enableParticles: true,
    staticParticles: true,
    effectsLoopPacing: "raf",
  } as never;

  it("draws the burst for its full window, then stops drawing it and parks for good", () => {
    const root = mount(spec());
    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    flushRaf(); // warm + draw the frozen frame
    const painted = () => rt.stats().draws + rt.stats().cacheHits;
    expect(painted()).toBe(1);
    // The frozen loop keeps exactly ONE wakeup armed — the burst's own end. (A frozen fleet with no one-shots
    // arms none at all; see the ambient case below.)
    expect(rafQueue.length).toBe(1);

    // Halfway through the window: still a burst, still drawn.
    advanceSeconds(0.5);
    flushRaf();
    expect(painted()).toBe(2);
    expect(rafQueue.length).toBe(1); // …and still waiting for the end

    // Past the window (0.5 + 0.4 > 0.8): the burst is over.
    ops2d = [];
    advanceSeconds(0.4);
    flushRaf();
    expect(painted()).toBe(2); // nothing drawn or blitted for it any more
    expect(ops2d).toEqual(["clearRect"]); // the canvas was BLANKED, not repainted
    expect(rafQueue.length).toBe(0); // nothing left to wake for: parked, at zero cost

    // And it stays retired — a later kick repaints nothing.
    ops2d = [];
    rt.setFps(30); // any host-driven kick
    flushRaf();
    expect(painted()).toBe(2);
    expect(ops2d).toEqual([]);
    rt.dispose();
  });

  it("arms NO wakeup for a continuous emitter (a frozen ambient stays free)", () => {
    const root = mount(spec({ oneShot: false }));
    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    expect(rafQueue.length).toBe(0); // parked with nothing pending — an ambient never expires
    rt.dispose();
  });

  it("keeps drawing a one-shot the host reports as NOT emitting (nothing to expire)", () => {
    const root = mount(spec({ emitting: false }));
    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    flushRaf();
    expect(rafQueue.length).toBe(0); // no burst on screen ⇒ no expiry clock, no wake

    ops2d = [];
    advanceSeconds(10);
    rt.setFps(30);
    flushRaf();
    // Long past what WOULD have been the window: this binding still goes through the normal frozen step (here a
    // static-frame cache hit — an un-emitting system's frame is empty, so it never books a `draws`), which is
    // what a RETIRE would have skipped.
    expect(rt.stats().cacheHits).toBe(1);
    expect(ops2d).toContain("drawImage");
    rt.dispose();
  });

  it("`staticParticleOneShotExpiry: false` parks the warmed burst forever (the kill switch)", () => {
    const root = mount(spec());
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      effectsLoopPacing: "raf",
      staticParticleOneShotExpiry: false,
    } as never);
    rt.reconcile();
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    expect(rafQueue.length).toBe(0); // no expiry ⇒ no self-wake, exactly as before this option existed

    ops2d = [];
    advanceSeconds(30);
    rt.setFps(30);
    flushRaf();
    expect(rt.stats().draws + rt.stats().cacheHits).toBe(2); // still painting the warmed frame
    expect(ops2d).toContain("drawImage");
    rt.dispose();
  });

  // The production pacing: the frozen loop PARKS on a timer rather than holding a rAF chain, so the burst-end
  // wake has to survive that park. Uses a short window (lifetime 0.1 ⇒ a 200 ms burst) so the real timer is
  // short, and drives the VIRTUAL clock past the end so the woken tick really does retire.
  it("wakes itself out of a TIMER park to retire the burst (default pacing)", async () => {
    const root = mount(spec({ lifetime: 0.1, explosiveness: 0 }));
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
    } as never);
    rt.reconcile();
    expect(await waitForRaf()).toBe(true);
    flushRaf(); // warm + draw, then park on a ~196 ms timer for the burst end
    expect(rt.stats().draws).toBe(1);
    expect(rafQueue.length).toBe(0); // parked: no rAF held while waiting

    advanceSeconds(0.25); // the burst is over by the time the park fires
    expect(await waitForRaf()).toBe(true); // …and the park DID fire, unprompted
    ops2d = [];
    flushRaf();
    expect(rt.stats().draws + rt.stats().cacheHits).toBe(1); // retired, not redrawn
    expect(ops2d).toEqual(["clearRect"]);
    rt.dispose();
  });
});
