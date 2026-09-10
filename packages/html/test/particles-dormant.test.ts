// jsdom (gsw default env).
//
// The particle runtime's DORMANCY PARK: a binding whose subtree the host suspended
// (`data-godot-effects-suspended`) does not merely stop simulating — its canvas is HIDDEN.
//
// WHY that is the whole point: a `<canvas>` is an unconditionally promoted compositor layer, so a
// suspended system kept its layer, its render surface and its GPU backing store for as long as the
// node stayed mounted. A live combat trace put the client cost of a discard→draw shuffle at 95 ms
// for an 85-BYTE delta — uncorrelated with what arrived, correlated with what was standing on
// screen — with 401 layers created against 61 deleted and GPU-process memory climbing 148 → 276 MB.
// Freezing the simulation cannot touch any of that; hiding the canvas is what hands it back.
//
// What is pinned here:
//   - park/resume keeps the SAME binding (same canvas element, same simulation), and only its
//     `display` moves;
//   - a parked binding's `sizeCanvas` is DEFERRED — observer deliveries, `setRenderScale` steps and
//     pin flips write nothing to a hidden canvas, and the wake pays for exactly one (and, when the
//     binding was born parked, for the ONE box read the create skipped);
//   - the ordinal-based expiry sweep disposes a binding parked past `DORMANT_DISPOSE_SECONDS`, and
//     leaves one that woke in time alone;
//   - THE ARBITRATION with the frozen-surface image swap: this runtime never writes a canvas's
//     `display` itself (except the create-time hide the swapper adopts). It sets `dormant` and calls
//     `applySurfaceVisibility`, the swap module's single writer, exactly as `webgl/runtime` does. So
//     a park hides the stand-in `<img>` too (never an `<img>` stranded over a hidden canvas), and a
//     wake reverts it through `noteStaticSurfaceWake` (never a canvas left hidden after resume);
//   - `particleDormant: false` is the kill switch: no `display` write, no parks, no sweep, and the
//     swap gauges behave exactly as they did before the park existed.
//
// jsdom has no layout and no raster, so everything here is asserted through the DOM (`display`,
// `isConnected`) and through `stats()` counters — never through geometry.
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

import { EFFECTS_SUSPENDED_ATTR } from "../src/effects-suspend";
import { createParticleRuntime } from "../src/particles/runtime";
import { __resetStaticParticleFrameCacheForTest } from "../src/particles/static-frame-cache";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { DORMANT_DISPOSE_SECONDS } from "../src/shader-dormant";
import {
  __resetStaticImageSwapForTest,
  liveStaticImageUrlCount,
  STATIC_SURFACE_IMAGE_ATTR,
  type StaticSurfacePolicy,
} from "../src/surface-image-swap";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

vi.mock("@godot-scene-web/canvas-effects/webgl", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@godot-scene-web/canvas-effects/webgl")
    >();
  return { ...actual, drawParticles: () => {} };
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
function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
  return q.length;
}

/** The runtime's ONE ResizeObserver callback, captured so a test can deliver an entry by hand. */
let roCallback: ResizeObserverCallback | null = null;

let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;
let origToBlob: HTMLCanvasElement["toBlob"];
let origDecode: HTMLImageElement["decode"] | undefined;
let origCreateObjectURL: typeof URL.createObjectURL;
let origRevokeObjectURL: typeof URL.revokeObjectURL;
let urlSeq = 0;

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
  // The swap's encode/decode/object-URL seams (jsdom has none): PNG bytes are irrelevant here, only
  // that a stand-in becomes live.
  origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function toBlob(
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ): void {
    callback(new Blob(["frame"], { type: "image/png" }));
  };
  origDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = (): Promise<void> => Promise.resolve();
  origCreateObjectURL = URL.createObjectURL;
  origRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = ((): string =>
    `blob:stub/${++urlSeq}`) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  HTMLCanvasElement.prototype.toBlob = origToBlob;
  if (origDecode) HTMLImageElement.prototype.decode = origDecode;
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
  __resetSharedForTest();
  __resetStaticImageSwapForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  __resetStaticImageSwapForTest();
  rafQueue = [];
  roCallback = null;
  globalThis.ResizeObserver = makeResizeObserverStub({
    onConstruct: (cb) => {
      roCallback = cb;
    },
    // Deliver each self-layer's box from the fixture's own record rather than by reading
    // `clientWidth` — this suite instruments those getters to count the runtime's FORCED LAYOUTS,
    // and a browser's observer measures without forcing one.
    box: (target) => {
      const box = fixtureBoxes.get(target) ?? 0;
      return { width: box, height: box };
    },
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

const spec = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    kind: "GPUParticles2D",
    amount: 4,
    lifetime: 1,
    emitting: true,
    blendMode: 0,
    seed: 3,
    ...over,
  });

interface Fixture {
  node: HTMLElement;
  self: HTMLElement;
  /** `clientWidth`/`clientHeight` reads on this binding's self-layer — the forced-layout hazard. */
  boxReads: { count: number };
}

/** Each fixture self-layer's box, so the ResizeObserver stub can deliver it without going through
 *  the instrumented `clientWidth` (see the stub's `box` hook). */
const fixtureBoxes = new WeakMap<Element, number>();

function particleNode(specJson: string, box = 100): Fixture {
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", specJson);
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  const boxReads = { count: 0 };
  Object.defineProperty(self, "clientWidth", {
    get: () => {
      boxReads.count += 1;
      return box;
    },
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => {
      boxReads.count += 1;
      return box;
    },
    configurable: true,
  });
  node.appendChild(self);
  fixtureBoxes.set(self, box);
  return { node, self, boxReads };
}

function canvasIn(self: HTMLElement): HTMLCanvasElement {
  const canvas = self.querySelector<HTMLCanvasElement>(
    "[data-godot-particle-canvas]",
  );
  if (!canvas) throw new Error("no particle canvas mounted");
  return canvas;
}

function maybeCanvasIn(self: HTMLElement): HTMLCanvasElement | null {
  return self.querySelector<HTMLCanvasElement>("[data-godot-particle-canvas]");
}

function standIn(self: HTMLElement): HTMLImageElement | null {
  return self.querySelector<HTMLImageElement>(`[${STATIC_SURFACE_IMAGE_ATTR}]`);
}

function suspend(node: HTMLElement, on: boolean): void {
  if (on) node.setAttribute(EFFECTS_SUSPENDED_ATTR, "1");
  else node.removeAttribute(EFFECTS_SUSPENDED_ATTR);
}

/** Hand the runtime a ResizeObserver delivery for a self-layer, the way the browser would. */
function deliverResize(target: Element, width: number, height: number): void {
  roCallback?.(
    [
      {
        target,
        contentRect: { width, height },
      } as unknown as ResizeObserverEntry,
    ],
    {} as ResizeObserver,
  );
}

function mount(fixtures: Fixture[], options: Record<string, unknown> = {}) {
  const root = document.createElement("div");
  for (const f of fixtures) root.appendChild(f.node);
  document.body.appendChild(root);
  const runtime = createParticleRuntime(root, {
    enableParticles: true,
    ...options,
  } as never);
  return { root, runtime };
}

// ---- park / resume -----------------------------------------------------------------------------

describe("particle runtime — dormancy park", () => {
  it("hides the canvas on suspend and un-hides it on resume, keeping the SAME binding", () => {
    const a = particleNode(spec());
    const { runtime } = mount([a]);
    runtime.reconcile();
    const canvas = canvasIn(a.self);
    expect(canvas.style.display).toBe("");
    expect(runtime.stats().dormantLive).toBe(0);

    suspend(a.node, true);
    runtime.reconcile();
    // THE win: the canvas is still in the DOM (so the binding, its simulation and its GL buffer
    // survive), but it is hidden — no box, no paint, no compositor layer, no backing store.
    expect(maybeCanvasIn(a.self)).toBe(canvas);
    expect(canvas.style.display).toBe("none");
    expect(runtime.stats().dormantParks).toBe(1);
    expect(runtime.stats().dormantLive).toBe(1);
    expect(runtime.stats().dormantWakes).toBe(0);

    suspend(a.node, false);
    runtime.reconcile();
    expect(maybeCanvasIn(a.self)).toBe(canvas); // never re-created
    expect(canvas.style.display).toBe("");
    expect(runtime.stats().dormantWakes).toBe(1);
    expect(runtime.stats().dormantLive).toBe(0);
    runtime.dispose();
  });

  it("parks a binding BORN under a suspended ancestor, paying no box read and no sizing", () => {
    const a = particleNode(spec());
    suspend(a.node, true);
    const { runtime } = mount([a]);
    runtime.reconcile();

    // Not even in the DOM: an unsized canvas has no box to place, so the mount waits for the first
    // sizing — which for a parked binding is its WAKE. Strictly stronger than the hidden canvas this
    // asserted before the mount was deferred; there is no layer to drop because none was minted.
    expect(maybeCanvasIn(a.self)).toBeNull();
    // The create's measure pass skipped it and its `sizeCanvas` was deferred, so it forced no
    // layout at all — the shader runtime's born-dormant contract.
    expect(a.boxReads.count).toBe(0);
    expect(runtime.stats().boxReads).toBe(0);
    expect(runtime.stats().dormantParks).toBe(1);
    expect(runtime.stats().dormantLive).toBe(1);

    // …and the loop finds nothing to do for it (it is suspended), so nothing draws.
    flushRaf();
    expect(runtime.stats().draws).toBe(0);
    runtime.dispose();
  });

  it("repaints on resume, from the FROZEN simulation state", () => {
    // Frozen mode, so one flush = one painted frame per binding (`draws`, or a `cacheHits` blit of
    // an identical frame — the park cares about neither, only that a parked binding paints NOTHING
    // and a woken one paints again).
    const a = particleNode(spec());
    const { runtime } = mount([a], { staticParticles: true });
    runtime.reconcile();
    flushRaf();
    const painted = (): number =>
      runtime.stats().draws + runtime.stats().cacheHits;
    expect(painted()).toBe(1);

    suspend(a.node, true);
    runtime.reconcile();
    for (let i = 0; i < 4; i += 1) flushRaf();
    expect(painted()).toBe(1); // parked: no warm, no draw, no blit

    suspend(a.node, false);
    runtime.reconcile();
    flushRaf();
    expect(painted()).toBe(2);
    runtime.dispose();
  });

  it("handles a wake that arrives in the SAME reconcile as a spec change", () => {
    // The binding is re-created, not woken: the park must not queue an owed `sizeCanvas` for a
    // binding the same pass is about to dispose, or the write pass would size an orphan canvas.
    const a = particleNode(spec());
    const { runtime } = mount([a]);
    runtime.reconcile();
    const parkedCanvas = canvasIn(a.self);
    suspend(a.node, true);
    runtime.reconcile();
    expect(parkedCanvas.style.display).toBe("none");

    suspend(a.node, false);
    a.node.setAttribute("data-godot-particle-specs", spec({ seed: 77 }));
    runtime.reconcile();

    const rebuilt = canvasIn(a.self);
    expect(rebuilt).not.toBe(parkedCanvas);
    expect(parkedCanvas.isConnected).toBe(false);
    expect(rebuilt.style.display).toBe(""); // visible, and…
    expect(rebuilt.width).toBeGreaterThan(0); // …sized by its own create, not by a stale wake
    expect(runtime.stats().dormantLive).toBe(0);
    runtime.dispose();
  });
});

// ---- the deferred sizeCanvas --------------------------------------------------------------------

describe("particle runtime — a parked binding's deferred sizeCanvas", () => {
  it("writes NOTHING to a parked canvas, and the wake pays exactly one sync", () => {
    // Two identical systems; only `parked` is suspended. `control` is the A/B: it takes every
    // re-size as it happens, so the wake is correct iff the two canvases end up identical.
    const parked = particleNode(spec());
    const control = particleNode(spec({ seed: 9 }));
    const { runtime } = mount([parked, control]);
    runtime.reconcile();
    const parkedCanvas = canvasIn(parked.self);
    const controlCanvas = canvasIn(control.self);

    suspend(parked.node, true);
    runtime.reconcile();
    const cssAtPark = parkedCanvas.style.cssText;
    const widthAtPark = parkedCanvas.width;
    const readsAtPark = parked.boxReads.count;

    // Everything that re-sizes a fleet, while parked: an observer delivery (a real box change), an
    // adaptive density step, and a frozen-mode pin flip. With WS-1's box cache in place the cost
    // these skip is the WRITE side — four style writes plus a backing-store REALLOCATION of a canvas
    // nobody can see (and, with the swap on, a stand-in revert).
    deliverResize(parked.self, 240, 180);
    deliverResize(control.self, 240, 180);
    runtime.setRenderScale(0.5);
    runtime.setStaticParticlePixelRatio(2);
    runtime.setStaticParticles(true);
    expect(parkedCanvas.style.cssText).toBe(cssAtPark);
    expect(parkedCanvas.width).toBe(widthAtPark);
    expect(parked.boxReads.count).toBe(readsAtPark);

    suspend(parked.node, false);
    runtime.reconcile();
    // ONE sync for all four, from the box the observer parked in the cache — so still no read…
    expect(parked.boxReads.count).toBe(readsAtPark);
    // …and it lands exactly where the never-parked control did.
    expect(parkedCanvas.style.cssText).toBe(controlCanvas.style.cssText);
    expect(parkedCanvas.width).toBe(controlCanvas.width);
    expect(parkedCanvas.height).toBe(controlCanvas.height);
    runtime.dispose();
  });

  it("a wake with no parked measurement pays exactly ONE box read (born parked)", () => {
    // The premise is a parked binding whose observation NEVER LANDED, so the wake is the first
    // moment anything knows its box. Chrome delivers an initial observation for every observed
    // target (0x0 included), so this is the spec-strict engine `particleObserverSizing` has to keep
    // working on — hence a stub that reports nothing.
    globalThis.ResizeObserver = makeResizeObserverStub({
      initialDelivery: false,
    });
    const a = particleNode(spec());
    suspend(a.node, true);
    const { runtime } = mount([a]);
    runtime.reconcile();
    expect(runtime.stats().boxReads).toBe(0);

    runtime.setRenderScale(0.5); // piles onto the same deferred sync
    expect(runtime.stats().boxReads).toBe(0);

    suspend(a.node, false);
    runtime.reconcile();
    // `readBoxInto` books ONE read per binding (it reads clientWidth + clientHeight together), in
    // the reconcile's contiguous measure pass — not one per deferred sync.
    expect(runtime.stats().boxReads).toBe(1);
    expect(canvasIn(a.self).width).toBeGreaterThan(0);
    runtime.dispose();
  });

  it("keeps the wake's box read in the MEASURE pass, before any of that reconcile's sizing writes", () => {
    // A reconcile that wakes one system and mounts another must still be MUTATE → MEASURE → WRITE:
    // both reads sit in one contiguous run, so they cost ONE layout flush rather than two.
    //
    // This is the READ path's phasing, so it is pinned to the read path: with the default
    // `particleObserverSizing` a create is not measured here at all (its box comes from the observer
    // instead), and there would be nothing to order. The stub reports nothing for the same reason
    // the test above suppresses it — the wake must be the first thing to learn the parked box.
    const woken = particleNode(spec());
    suspend(woken.node, true);
    globalThis.ResizeObserver = makeResizeObserverStub({
      initialDelivery: false,
    });
    const { root, runtime } = mount([woken], {
      particleObserverSizing: false,
    });
    runtime.reconcile();
    expect(runtime.stats().boxReads).toBe(0);

    const readOrder: string[] = [];
    const fresh = particleNode(spec({ seed: 42 }));
    Object.defineProperty(fresh.self, "clientWidth", {
      get: () => {
        readOrder.push("read:fresh");
        return 100;
      },
      configurable: true,
    });
    Object.defineProperty(woken.self, "clientWidth", {
      get: () => {
        readOrder.push("read:woken");
        return 100;
      },
      configurable: true,
    });
    const canvasSizes: PropertyDescriptor | undefined =
      Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width");
    Object.defineProperty(HTMLCanvasElement.prototype, "width", {
      configurable: true,
      get(this: HTMLCanvasElement) {
        return (canvasSizes?.get as () => number)?.call(this) ?? 0;
      },
      set(this: HTMLCanvasElement, value: number) {
        readOrder.push("write:canvas");
        (canvasSizes?.set as (v: number) => void)?.call(this, value);
      },
    });
    try {
      root.appendChild(fresh.node);
      suspend(woken.node, false);
      runtime.reconcile();
    } finally {
      if (canvasSizes) {
        Object.defineProperty(
          HTMLCanvasElement.prototype,
          "width",
          canvasSizes,
        );
      }
    }

    expect(runtime.stats().boxReads).toBe(2);
    const firstWrite = readOrder.indexOf("write:canvas");
    expect(readOrder.slice(0, firstWrite)).toEqual([
      "read:fresh",
      "read:woken",
    ]);
    runtime.dispose();
  });
});

// ---- the expiry sweep ---------------------------------------------------------------------------

describe("particle runtime — parked-binding expiry", () => {
  it("disposes a binding that stays parked past the window, and re-creates it born parked", () => {
    const a = particleNode(spec());
    const { runtime } = mount([a]);
    runtime.reconcile();
    const canvas = canvasIn(a.self);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      suspend(a.node, true);
      runtime.reconcile();

      vi.advanceTimersByTime(DORMANT_DISPOSE_SECONDS * 1000 - 1);
      expect(canvas.isConnected).toBe(true); // still parked, still kept
      expect(runtime.stats().dormantDisposes).toBe(0);

      vi.advanceTimersByTime(1);
      expect(canvas.isConnected).toBe(false); // swept: canvas removed, binding gone
      expect(maybeCanvasIn(a.self)).toBeNull();
      expect(runtime.stats().dormantDisposes).toBe(1);
      expect(runtime.stats().dormantLive).toBe(0);

      // The node is still mounted and still suspended, so the next reconcile re-creates it — BORN
      // parked, i.e. unmeasured, unsized and not even inserted, and armed to expire again.
      const readsBefore = runtime.stats().boxReads;
      runtime.reconcile();
      expect(maybeCanvasIn(a.self)).toBeNull();
      expect(runtime.stats().boxReads).toBe(readsBefore);
      expect(runtime.stats().dormantLive).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    runtime.dispose();
  });

  it("leaves a binding that woke before the sweep fired alone", () => {
    const a = particleNode(spec());
    const { runtime } = mount([a]);
    runtime.reconcile();
    const canvas = canvasIn(a.self);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      suspend(a.node, true);
      runtime.reconcile();
      vi.advanceTimersByTime(DORMANT_DISPOSE_SECONDS * 500);
      suspend(a.node, false);
      runtime.reconcile();
      vi.advanceTimersByTime(DORMANT_DISPOSE_SECONDS * 1000);
      expect(canvas.isConnected).toBe(true);
      expect(maybeCanvasIn(a.self)).toBe(canvas);
      expect(runtime.stats().dormantDisposes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    runtime.dispose();
  });

  it("arms ONE timer for the whole runtime, and dispose() leaves nothing armed", () => {
    const a = particleNode(spec());
    const b = particleNode(spec({ seed: 4 }));
    const c = particleNode(spec({ seed: 5 }));
    const { runtime } = mount([a, b, c]);
    runtime.reconcile();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (const f of [a, b, c]) suspend(f.node, true);
      runtime.reconcile();
      expect(runtime.stats().dormantParks).toBe(3);
      expect(vi.getTimerCount()).toBe(1); // one sweep, not one per binding
      runtime.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- arbitration with the frozen-surface image swap ---------------------------------------------

/** The swap's own clock/timer seam, driven by hand (the `particles-surface-swap` harness's). */
function scheduler() {
  let nowMs = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));
  return {
    now: (): number => nowMs,
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = ++seq;
      timers.set(id, { at: nowMs + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    async advance(ms: number): Promise<void> {
      const target = nowMs + ms;
      for (;;) {
        let dueId = -1;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueId = id;
          }
        }
        if (dueId < 0) break;
        const timer = timers.get(dueId);
        timers.delete(dueId);
        nowMs = Math.max(nowMs, dueAt);
        timer?.fn();
        await settle();
      }
      nowMs = target;
      await settle();
    },
  };
}

const QUIET_MS = 1000;

function quietPolicy(clock: ReturnType<typeof scheduler>): StaticSurfacePolicy {
  return {
    gate: { kind: "quiet-window", quietMs: QUIET_MS },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
}

describe("particle runtime — park vs. the frozen-surface image swap", () => {
  it("hides the stand-in <img> with the canvas, and reverts it on the wake", async () => {
    const clock = scheduler();
    const a = particleNode(spec());
    const { runtime } = mount([a], {
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    });
    runtime.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);

    const canvas = canvasIn(a.self);
    const img = standIn(a.self);
    expect(img).not.toBeNull();
    expect(runtime.stats().staticImagesLive).toBe(1);
    expect(canvas.style.display).toBe("none"); // hidden BY THE SWAP
    expect(img?.style.display).toBe("block");

    // Park a SWAPPED surface. `applySurfaceVisibility` composes the two states: parked hides both,
    // so nothing is left painting — and no `<img>` is stranded over the hidden canvas.
    suspend(a.node, true);
    runtime.reconcile();
    expect(img?.style.display).toBe("none");
    expect(canvas.style.display).toBe("none");
    expect(runtime.stats().dormantLive).toBe(1);

    // The wake hands the decision to the swap module (`noteStaticSurfaceWake`), which cannot vouch
    // for a keyless stand-in across a park — so it reverts, WITHOUT blocking, and the canvas comes
    // back visible rather than staying hidden under a retired `<img>`.
    suspend(a.node, false);
    runtime.reconcile();
    expect(standIn(a.self)).toBeNull();
    expect(canvas.style.display).toBe("");
    const stats = runtime.stats();
    expect(stats.staticImagesLive).toBe(0);
    expect(stats.staticImageRevertsByCause["dormancy-wake"]).toBe(1);
    expect(stats.staticImageUrlsLive).toBe(0);

    // …and the surface re-earns its swap from there (the revert did not disqualify it).
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(runtime.stats().staticImagesLive).toBe(1);
    expect(canvasIn(a.self).style.display).toBe("none");
    runtime.dispose();
  });

  it("never swaps a parked surface (nothing to win, and its canvas is mid-defer)", async () => {
    const clock = scheduler();
    const a = particleNode(spec());
    const { runtime } = mount([a], {
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    });
    runtime.reconcile();
    flushRaf();
    suspend(a.node, true);
    runtime.reconcile();

    await clock.advance(QUIET_MS * 4);
    expect(standIn(a.self)).toBeNull();
    expect(runtime.stats().staticImagesLive).toBe(0);
    expect(runtime.stats().staticImageEncodes).toBe(0);
    expect(canvasIn(a.self).style.display).toBe("none"); // parked, not swapped
    runtime.dispose();
  });

  it("releases the stand-in's object URL when the sweep disposes a parked swapped binding", async () => {
    const clock = scheduler();
    const a = particleNode(spec());
    const { runtime } = mount([a], {
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    });
    runtime.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(liveStaticImageUrlCount()).toBe(1);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      suspend(a.node, true);
      runtime.reconcile();
      vi.advanceTimersByTime(DORMANT_DISPOSE_SECONDS * 1000);
      expect(runtime.stats().dormantDisposes).toBe(1);
      expect(maybeCanvasIn(a.self)).toBeNull();
      expect(standIn(a.self)).toBeNull();
      expect(liveStaticImageUrlCount()).toBe(0); // the leak probe
    } finally {
      vi.useRealTimers();
    }
    runtime.dispose();
  });
});

// ---- the kill switch ----------------------------------------------------------------------------

describe("particle runtime — particleDormant: false", () => {
  it("never parks, never writes `display`, and arms no sweep", () => {
    const a = particleNode(spec());
    const { runtime } = mount([a], { particleDormant: false });
    runtime.reconcile();
    const canvas = canvasIn(a.self);
    const cssBefore = canvas.style.cssText;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      suspend(a.node, true);
      runtime.reconcile();
      // The pre-park contract: the simulation freezes, the canvas keeps its last drawn frame.
      expect(canvas.style.display).toBe("");
      expect(canvas.style.cssText).toBe(cssBefore);
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(DORMANT_DISPOSE_SECONDS * 2000);
      expect(canvas.isConnected).toBe(true); // no expiry either
    } finally {
      vi.useRealTimers();
    }
    const stats = runtime.stats();
    expect(stats.dormantParks).toBe(0);
    expect(stats.dormantWakes).toBe(0);
    expect(stats.dormantDisposes).toBe(0);
    expect(stats.dormantLive).toBe(0);
    runtime.dispose();
  });

  it("sizes a suspended binding as it always did (nothing is deferred)", () => {
    const a = particleNode(spec());
    suspend(a.node, true);
    const { runtime } = mount([a], { particleDormant: false });
    runtime.reconcile();
    // Born suspended is just… born: measured once, sized once, canvas visible. The measurement
    // comes from the observer's first delivery (`particleObserverSizing`, the default), so it costs
    // no forced layout — what matters here is that the park is not in the way, not who measured.
    expect(runtime.stats().boxReads).toBe(0);
    expect(canvasIn(a.self).style.display).toBe("");
    const width = canvasIn(a.self).width;
    expect(width).toBeGreaterThan(0);

    runtime.setRenderScale(0.5);
    expect(canvasIn(a.self).width).toBeLessThan(width); // sized immediately, not at a wake
    runtime.dispose();
  });

  it("leaves the swap gauges exactly where they were before the park existed", async () => {
    const clock = scheduler();
    const a = particleNode(spec());
    const { runtime } = mount([a], {
      particleDormant: false,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    });
    runtime.reconcile();
    flushRaf();

    // Suspended: `dirty`, so the gate refuses — the swap's own occlusion answer, unchanged, and
    // with no park in the way the canvas stays visible showing its last frame.
    suspend(a.node, true);
    runtime.reconcile();
    await clock.advance(QUIET_MS * 3);
    expect(runtime.stats().staticImagesLive).toBe(0);
    expect(runtime.stats().staticImageUrlsLive).toBe(0);
    expect(canvasIn(a.self).style.display).toBe("");

    // Resumed, repainted, quiet: it swaps exactly as it always did.
    suspend(a.node, false);
    runtime.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    const stats = runtime.stats();
    expect(stats.staticImagesLive).toBe(1);
    expect(stats.staticImageUrlsLive).toBe(1);
    expect(stats.staticImageRevertsByCause["dormancy-wake"]).toBe(0);
    expect(canvasIn(a.self).style.display).toBe("none"); // by the swap, the only writer
    runtime.dispose();
  });
});
