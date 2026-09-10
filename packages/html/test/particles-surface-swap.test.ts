// jsdom (gsw default env).
//
// The PARTICLE runtime wired to the generic frozen-surface image swap (`src/surface-image-swap.ts`)
// through the opt-in `staticParticleImages` option. A frozen particle canvas is exactly the surface
// that mechanism exists for — it never changes, yet it keeps a compositor layer, a blend render
// surface and a per-frame GPU fill — and particles are the LARGER population downstream (33 of 45
// effect canvases in one measured combat scene), so the shader-only wiring missed most of the win.
//
// What is pinned here:
//   - OFF (the default) is byte-identical to the pre-swap runtime: no state, no `<img>`, no timer,
//     no write to the canvas's `display`;
//   - `true` maps to the QUIET-WINDOW gate with the module defaults — never the `content-key` gate,
//     whose observation count this runtime can never feed;
//   - a quiet surface swaps after the window and its canvas is HIDDEN (the swap module staying the
//     single writer of that property);
//   - THE KEY ONE: what a static-frame CACHE-HIT BLIT means. That blit writes pixels while booking
//     `cacheHits`, not `draws`, so it must report — but what it reports is the KEY of the frame it
//     just blitted, which is the frame the `<img>` over it is already showing. So the swap SURVIVES
//     it (identical pixels by the key's contract) while a paint that cannot be keyed — a live tick,
//     whose phase depends on when it ran — thaws it exactly as before. Both directions are pinned.
//   - a live-simulating surface never swaps; the `canFreezeSurface` host veto; host invalidation;
//     resize / render-scale / mode-flip reverts; and dispose returning `staticImageUrlsLive` to 0,
//     which is the leak probe a device run reads.
//
// Everything the swap defers runs on the policy's INJECTED clock/timer seams (never vitest's global
// fake timers), while the runtime's own rAF loop is driven by the hand-flushed rAF queue — the two
// clocks are deliberately independent, which is what lets a test say "the loop painted, then a
// second of quiet passed" in either order.
//
// jsdom has no real 2D raster, so a canvas's PIXELS are modelled as one token string (the
// `particles-static-frame-cache` harness's trick): `drawImage` copies the source's token,
// `clearRect` clears it.
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
  __resetStaticImageSwapForTest,
  DEFAULT_QUIET_WINDOW_MS,
  liveStaticImageUrlCount,
  STATIC_SURFACE_IMAGE_ATTR,
  type StaticSurfacePolicy,
} from "../src/surface-image-swap";
import { __resetSharedForTest, getShared } from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

/** Instance floats of every `drawParticles` call, in call order (the buffer is reused, so copied). */
let drawnInstances: number[][] = [];

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
      drawnInstances.push(Array.from(buffer.data.slice(0, buffer.count * 10)));
    },
  };
});

// ---- the modelled-pixel 2D context -------------------------------------------------------------

const painted = new WeakMap<object, string>();

function paint(canvas: object, token: string): void {
  painted.set(canvas, token);
}
function pixelsOf(canvas: object): string {
  return painted.get(canvas) ?? "";
}

function fake2d(canvas: object): unknown {
  const overrides: Record<string, (...args: unknown[]) => unknown> = {
    clearRect: () => painted.set(canvas, ""),
    drawImage: (source: unknown) =>
      painted.set(canvas, pixelsOf(source as object)),
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

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

// ---- rAF queue (the runtime's loop) + a recording global setTimeout -----------------------------

let rafQueue: FrameRequestCallback[] = [];
/** Run every queued rAF callback; returns how many ran (0 = the loop has parked itself). */
function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
  return q.length;
}

/** Delays passed to the GLOBAL `setTimeout` — the seam the swap uses when a policy injects none.
 *  With the mechanism off, nothing in this runtime arms one at all (no fps cap in these tests). */
let globalDelays: number[] = [];
/** Delays a swap-ish caller could plausibly have armed (the harness's own `flush` uses 0). */
const armedDelays = (): number[] => globalDelays.filter((d) => d > 0);

// ---- encode / decode / object-URL stubs --------------------------------------------------------

let encodeCalls = 0;
let urlSeq = 0;
let revokedUrls: string[] = [];

let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origToBlob: HTMLCanvasElement["toBlob"];
let origDecode: HTMLImageElement["decode"] | undefined;
let origCreateObjectURL: typeof URL.createObjectURL;
let origRevokeObjectURL: typeof URL.revokeObjectURL;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;
let origSetTimeout: typeof globalThis.setTimeout;

beforeAll(() => {
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: object,
    kind: string,
  ) {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return fake2d(this);
    return null;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function toBlob(
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ): void {
    encodeCalls++;
    callback(new Blob(["frame"], { type: "image/png" }));
  };
  origDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = (): Promise<void> => Promise.resolve();
  origCreateObjectURL = URL.createObjectURL;
  origRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = ((): string =>
    `blob:stub/${++urlSeq}`) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string): void => {
    revokedUrls.push(url);
  }) as typeof URL.revokeObjectURL;
  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    rafQueue.push(cb)) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame =
    (() => {}) as typeof globalThis.cancelAnimationFrame;
  origRO = globalThis.ResizeObserver;
  origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    globalDelays.push(ms ?? 0);
    return origSetTimeout(fn, ms);
  }) as typeof globalThis.setTimeout;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  HTMLCanvasElement.prototype.toBlob = origToBlob;
  if (origDecode) HTMLImageElement.prototype.decode = origDecode;
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  globalThis.setTimeout = origSetTimeout;
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  __resetStaticImageSwapForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  __resetStaticImageSwapForTest();
  rafQueue = [];
  drawnInstances = [];
  globalDelays = [];
  revokedUrls = [];
  encodeCalls = 0;
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ---- the injected clock + timer seam (the swap's own, independent of the rAF loop) --------------

function scheduler() {
  let nowMs = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = (): Promise<void> =>
    new Promise((resolve) => origSetTimeout(resolve, 0));
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
    pending: (): number => timers.size,
    /** Run every timer due within `ms`, in time order, letting promises settle between each. */
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
        await flush();
      }
      nowMs = target;
      await flush();
    },
  };
}

type Clock = ReturnType<typeof scheduler>;

const QUIET_MS = 1000;

/** The policy these tests drive: the quiet-window gate on a hand-driven clock. */
function quietPolicy(
  clock: Clock,
  over: Partial<StaticSurfacePolicy> = {},
): StaticSurfacePolicy {
  return {
    gate: { kind: "quiet-window", quietMs: QUIET_MS },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...over,
  };
}

// ---- fixtures ----------------------------------------------------------------------------------

// blendMode 0 (non-additive) so the draw path never reaches the additive accumulator FBO under the
// fake GL — the constraint every particle runtime test works under.
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

function particleNode(
  specJson: string,
  box = 100,
): { node: HTMLElement; self: HTMLElement } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", specJson);
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  Object.defineProperty(self, "clientWidth", {
    get: () => box,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => box,
    configurable: true,
  });
  node.appendChild(self);
  return { node, self };
}

function canvasIn(self: HTMLElement): HTMLCanvasElement {
  const canvas = self.querySelector<HTMLCanvasElement>(
    "[data-godot-particle-canvas]",
  );
  if (!canvas) throw new Error("no particle canvas mounted");
  return canvas;
}

/** The stand-in `<img>` for a binding's canvas, or null. (The attribute name is historical — it
 *  predates the swap module being generic — and is a published DOM contract, so particles use it
 *  too.) */
function standIn(self: HTMLElement): HTMLImageElement | null {
  return self.querySelector<HTMLImageElement>(`[${STATIC_SURFACE_IMAGE_ATTR}]`);
}

/** Paint the SHARED GL canvas — the source `drawBinding` blits from — with a recognisable token. */
function paintSharedCanvas(token: string): void {
  const shared = getShared();
  if (!shared) throw new Error("no shared GL");
  paint(shared.canvas, token);
}

function mount(count = 1, box = 100) {
  const root = document.createElement("div");
  const nodes = Array.from({ length: count }, () => particleNode(spec(), box));
  for (const n of nodes) root.appendChild(n.node);
  document.body.appendChild(root);
  return { root, nodes };
}

// ---- OFF (the default) -------------------------------------------------------------------------

describe("particle surface swap — OFF is the pre-swap runtime, exactly", () => {
  it("frozen mode with the option unset: no state, no <img>, no timer, no display write", async () => {
    const { root, nodes } = mount(2);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
    } as never);
    rt.reconcile();
    paintSharedCanvas("FROZEN");
    flushRaf();

    const canvas = canvasIn(nodes[0].self);
    const cssAfterDraw = canvas.style.cssText;
    // However long the world stands still, an off runtime cannot swap: it has no clock armed to
    // notice (this is the "arms nothing" proof — the loop itself sets no timer without an fps cap).
    expect(armedDelays()).toEqual([]);
    await new Promise((resolve) => origSetTimeout(resolve, 5));
    flushRaf();

    for (const n of nodes) {
      expect(standIn(n.self)).toBeNull();
      // The canvas is mounted with `position`/`pointer-events` only; `display` is never written,
      // which is what "byte-identical" means for the property the swap owns.
      expect(canvasIn(n.self).style.display).toBe("");
    }
    expect(canvas.style.cssText).toBe(cssAfterDraw);
    expect(encodeCalls).toBe(0);
    expect(liveStaticImageUrlCount()).toBe(0);
    const stats = rt.stats();
    expect(stats.staticImageSwaps).toBe(0);
    expect(stats.staticImageEncodes).toBe(0);
    expect(stats.staticImagesLive).toBe(0);
    expect(stats.staticImageUrlsLive).toBe(0);
    // …and the runtime it was always: one warm+draw for the first system, a cache blit for its twin.
    expect(stats.draws).toBe(1);
    expect(stats.cacheHits).toBe(1);
    expect(pixelsOf(canvasIn(nodes[1].self))).toBe("FROZEN");
    rt.dispose();
  });

  it("`false` is the same as unset (and `setStaticParticleImages(false)` on it is inert)", () => {
    const { root, nodes } = mount(1);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: false,
    } as never);
    rt.reconcile();
    flushRaf();
    rt.setStaticParticleImages(false); // already off
    rt.invalidateStaticSurfaces(); // nothing to invalidate
    expect(standIn(nodes[0].self)).toBeNull();
    expect(armedDelays()).toEqual([]);
    expect(rt.stats().staticImageSwaps).toBe(0);
    rt.dispose();
  });
});

// ---- the `true` mapping ------------------------------------------------------------------------

describe("particle surface swap — `true` means the QUIET-WINDOW gate", () => {
  it("arms a sweep one DEFAULT_QUIET_WINDOW_MS out (the content-key gate would arm nothing)", () => {
    // The mapping is not directly observable, but its consequence is: only the quiet-window gate
    // defers anything, and it defers exactly one window from the moment a surface is attached.
    // `staticShaderImages: true` — the content-key gate — arms NO timer at all, by design.
    const { root } = mount(1);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: true,
    } as never);
    rt.reconcile();

    const armed = armedDelays();
    expect(armed.length).toBeGreaterThan(0);
    // `armSweep` fires at `lastDrawAt + quietMs`, computed a hair after the attach that set it.
    expect(
      armed.some(
        (d) => d > DEFAULT_QUIET_WINDOW_MS - 20 && d <= DEFAULT_QUIET_WINDOW_MS,
      ),
    ).toBe(true);
    rt.dispose();
  });

  it("an explicit content-key policy arms nothing for a particle surface (and can never fire)", () => {
    const { root, nodes } = mount(1);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: { gate: { kind: "content-key" } },
    } as never);
    rt.reconcile();
    flushRaf();
    flushRaf();
    // A frozen particle surface paints ONCE and then the loop parks, and this runtime never calls
    // the content-key gate's other clock (`noteStaticImageReconcile`) — so `stable` cannot reach the
    // 3 observations that gate wants, however long the world stands still. That the paint now
    // carries a KEY does not change it: a key is what the quiet window measures content WITH, not a
    // substitute for the observations this gate counts. No timer, no swap, ever — which is why
    // `true` must not map to it.
    expect(armedDelays()).toEqual([]);
    expect(standIn(nodes[0].self)).toBeNull();
    expect(rt.stats().staticImageSwaps).toBe(0);
    rt.dispose();
  });
});

// ---- the swap itself ---------------------------------------------------------------------------

describe("particle surface swap — a quiet frozen surface", () => {
  it("swaps after the window: <img> in the canvas's place, canvas hidden, gauges up", async () => {
    const clock = scheduler();
    const { root, nodes } = mount(1);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    paintSharedCanvas("FROZEN");
    flushRaf(); // warm + draw once, then the loop parks

    const canvas = canvasIn(nodes[0].self);
    expect(standIn(nodes[0].self)).toBeNull(); // not yet: the window has not elapsed
    await clock.advance(QUIET_MS - 1);
    expect(standIn(nodes[0].self)).toBeNull();

    await clock.advance(2);
    const img = standIn(nodes[0].self);
    expect(img).not.toBeNull();
    // Immediately BEFORE the canvas: the same slot in the child list, so the same paint order.
    expect(img?.nextElementSibling).toBe(canvas);
    expect(img?.style.display).toBe("block");
    expect(canvas.style.display).toBe("none");
    // The stand-in reproduces the canvas's box (which `syncCanvasSize` writes inline).
    expect(img?.style.left).toBe(canvas.style.left);
    expect(img?.style.width).toBe(canvas.style.width);

    const stats = rt.stats();
    expect(stats.staticImageSwaps).toBe(1);
    expect(stats.staticImageEncodes).toBe(1);
    expect(stats.staticImagesLive).toBe(1);
    expect(stats.staticImageUrlsLive).toBe(1);
    expect(stats.staticImageFailures).toBe(0);
    rt.dispose();
  });

  it("a fleet of twins all swap on ONE shared encode (the frame key is reported)", async () => {
    const clock = scheduler();
    const { root, nodes } = mount(4);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    paintSharedCanvas("FLEET");
    flushRaf();
    await clock.advance(QUIET_MS + 1);

    expect(rt.stats().staticImagesLive).toBe(4);
    for (const n of nodes) {
      expect(standIn(n.self)).not.toBeNull();
      expect(canvasIn(n.self).style.display).toBe("none");
    }
    // THE key-dedup payoff. `notePaint` reports this binding's static-frame key — the name of the
    // bitmap the canvas holds — so four twins are four surfaces on ONE entry: one readback, one
    // object URL, four `<img>`s. (Before the key was reported each took a private synthetic key and
    // paid its own encode; at a real fleet's 35 twins per spec that is 34 wasted readbacks.)
    expect(rt.stats().staticImageEncodes).toBe(1);
    expect(rt.stats().staticImageUrlsLive).toBe(1);
    const srcs = new Set(
      nodes.map((n) => standIn(n.self)?.getAttribute("src") ?? ""),
    );
    expect(srcs.size).toBe(1);
    rt.dispose();
  });

  it("a DIFFERENT spec is a different key: no sharing across two families", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    const a = particleNode(spec());
    const b = particleNode(spec({ seed: 77 }));
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);

    expect(rt.stats().staticImagesLive).toBe(2);
    expect(rt.stats().staticImageEncodes).toBe(2);
    expect(standIn(a.self)?.getAttribute("src")).not.toBe(
      standIn(b.self)?.getAttribute("src"),
    );
    rt.dispose();
  });

  it("a live-simulating surface never swaps, however long the runtime runs", async () => {
    const clock = scheduler();
    const { root, nodes } = mount(1);
    const rt = createParticleRuntime(root, {
      enableParticles: true, // LIVE mode
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    paintSharedCanvas("LIVE");
    flushRaf();

    // 20 ticks at 200 ms of swap-clock each: 4 s of wall time, never a 1 s gap between paints. Every
    // one of them must really run — an emitting system keeps the loop armed — because the whole
    // assertion below is "paints kept pushing the window out", not "nothing happened".
    // (A live tick whose sim has nothing active yet still CLEARS the canvas, which is a pixel write
    // and is reported as such; drop `notePaint` from that branch and this surface swaps.)
    for (let i = 0; i < 20; i++) {
      await clock.advance(200);
      expect(flushRaf()).toBeGreaterThan(0);
    }
    expect(rt.stats().staticImageSwaps).toBe(0);
    expect(standIn(nodes[0].self)).toBeNull();
    expect(canvasIn(nodes[0].self).style.display).toBe("");
    rt.dispose();
  });
});

// ---- THE cache-hit blit ------------------------------------------------------------------------

describe("particle surface swap — the static-frame CACHE-HIT BLIT is a keyed paint", () => {
  it("a re-blitting frozen fleet KEEPS its stand-ins: the blit re-states the same key", async () => {
    // THE case this wiring exists to get right, and the one whose verdict the reported key INVERTS.
    // `staticStepBinding`'s hit branch writes pixels into the canvas while booking `cacheHits`, not
    // `draws` — so it must report, or nothing downstream would know the surface had been touched at
    // all. What it reports is the key of the frame it just blitted, which is the frame the `<img>`
    // over that canvas is already showing: identical pixels by the key's own contract. Reverting
    // there would take a correct stand-in down and pay a whole window plus an encode to put an
    // identical one back — and since a frozen fleet re-blits every time anything kicks the parked
    // loop, that is the mechanism never staying engaged.
    // (Delete the `notePaint` call in that branch and the swap goes BLIND to the blit instead, which
    // is a different bug: the watchdog's `drawSeq` proxy stops moving with the canvas.)
    const clock = scheduler();
    const { root, nodes } = mount(2);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    paintSharedCanvas("FROZEN");
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(2);
    const hitsBefore = rt.stats().cacheHits;
    const encodesBefore = rt.stats().staticImageEncodes;

    // A third twin mounts. Its reconcile kicks the parked loop, whose static branch re-blits the
    // cached frame for EVERY binding — including the two that are currently swapped.
    const third = particleNode(spec());
    root.appendChild(third.node);
    rt.reconcile();
    flushRaf();

    expect(rt.stats().cacheHits).toBeGreaterThan(hitsBefore); // the blit path really ran
    expect(rt.stats().staticImagesLive).toBe(2); // …and both stand-ins stayed up
    expect(rt.stats().staticImageRevertsByCause.draw).toBe(0);
    for (const n of nodes) {
      expect(standIn(n.self)).not.toBeNull();
      expect(canvasIn(n.self).style.display).toBe("none");
      expect(pixelsOf(canvasIn(n.self))).toBe("FROZEN");
    }

    // The newcomer earns its own window and then attaches to the SAME entry — no second encode.
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(3);
    expect(rt.stats().staticImageEncodes).toBe(encodesBefore);
    expect(rt.stats().staticImageUrlsLive).toBe(1);
    rt.dispose();
  });

  it("a paint that CANNOT be keyed still thaws: leaving frozen mode animates the surfaces", async () => {
    // The other half of the same contract. A key is tolerated because it is a promise about the
    // pixels; the moment the runtime cannot make that promise — the live loop has stepped the state,
    // so its phase depends on WHEN rather than on the spec — `staticFrameKeyFor` returns null and a
    // paint means exactly what it always meant: this surface is not standing still.
    const clock = scheduler();
    const { root, nodes } = mount(2);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    paintSharedCanvas("FROZEN");
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(2);

    // Live again: each binding re-earns a window against its own animating canvas…
    rt.setStaticParticles(false);
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(2);
    // …and now they are KEYLESS, so they no longer share an entry — two synthetic keys, two URLs.
    expect(rt.stats().staticImageUrlsLive).toBe(2);

    // One more live tick and every stand-in comes down, on the null key alone.
    flushRaf();
    expect(rt.stats().staticImagesLive).toBe(0);
    expect(rt.stats().staticImageRevertsByCause.draw).toBe(2);
    for (const n of nodes) expect(standIn(n.self)).toBeNull();
    rt.dispose();
  });

  it("a CLEAR-ONLY frame is a paint too: an emptied canvas thaws its stand-in", async () => {
    // The third pixel-writing path. A live tick with no active instances still `clearRect`s the
    // canvas and returns before the instanced draw — pixels changed, and nothing else would ever
    // notice: `dirty` is untouched, the backing store keeps its size and stays in the DOM, so the
    // WATCHDOG's proxies all say "legitimately frozen" and a stale `<img>` would sit there forever.
    // `emitting: false` makes every tick of this system exactly that frame.
    const clock = scheduler();
    const root = document.createElement("div");
    const a = particleNode(spec({ emitting: false }));
    root.appendChild(a.node);
    document.body.appendChild(root);
    const rt = createParticleRuntime(root, {
      enableParticles: true, // LIVE mode: the tick simulates, finds nothing alive, and clears
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    // An empty canvas that stands still is still worth swapping (it costs the same layer).
    expect(rt.stats().staticImagesLive).toBe(1);

    // Kick the parked loop with an unrelated mount, so the tick re-clears the swapped canvas.
    const b = particleNode(spec({ emitting: false }));
    root.appendChild(b.node);
    rt.reconcile();
    flushRaf();

    expect(standIn(a.self)).toBeNull();
    expect(canvasIn(a.self).style.display).toBe("");
    expect(rt.stats().staticImageRevertsByCause.draw).toBe(1);
    rt.dispose();
  });

  it("a cache-hit binding that never warmed still owes its warm after a swap+unfreeze", async () => {
    // `pendingWarm` must survive the swap: A renders and publishes, B blits and never warms, both
    // freeze as `<img>`. Leaving frozen mode has to pay B's skipped warm back or its spray resumes
    // from the un-warmed post-create state — a visible pop the swap must not introduce either.
    const clock = scheduler();
    const { root } = mount(2);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    paintSharedCanvas("FROZEN");
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().cacheHits).toBe(1); // B never warmed
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(2);

    drawnInstances = [];
    rt.setStaticParticles(false);
    flushRaf(); // one live tick: both bindings simulate + draw

    expect(rt.stats().staticImagesLive).toBe(0); // the surfaces are about to animate
    expect(drawnInstances.length).toBe(2);
    expect(drawnInstances[0].length).toBeGreaterThan(0);
    expect(drawnInstances[1]).toEqual(drawnInstances[0]); // same state ⇒ the warm was paid back
    rt.dispose();
  });
});

// ---- host controls ------------------------------------------------------------------------------

describe("particle surface swap — host controls", () => {
  it("`canFreezeSurface` vetoes a surface (and only that one)", async () => {
    const clock = scheduler();
    const { root, nodes } = mount(2);
    const vetoed = nodes[0].node;
    const seen: HTMLElement[] = [];
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock, {
        canFreezeSurface: (node: HTMLElement) => {
          seen.push(node);
          return node !== vetoed;
        },
      }),
    } as never);
    rt.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS * 4);

    // The veto is consulted with the RUNTIME NODE (not the self-layer, not the canvas), so a host
    // that owns an element by path can answer without knowing gsw's internals.
    expect(seen).toContain(vetoed);
    expect(standIn(nodes[0].self)).toBeNull();
    expect(canvasIn(nodes[0].self).style.display).toBe("");
    expect(standIn(nodes[1].self)).not.toBeNull();
    expect(rt.stats().staticImagesLive).toBe(1);
    rt.dispose();
  });

  it("invalidateStaticSurfaces() reverts everything; with nodes, only that subtree", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    const holder = document.createElement("div"); // an ANCESTOR the host owns, not a bound node
    const a = particleNode(spec());
    const b = particleNode(spec());
    holder.appendChild(a.node);
    root.appendChild(holder);
    root.appendChild(b.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(2);

    rt.invalidateStaticSurfaces([holder]); // by ancestor: a host need not know which node gsw bound
    expect(standIn(a.self)).toBeNull();
    expect(canvasIn(a.self).style.display).toBe("");
    expect(standIn(b.self)).not.toBeNull();
    expect(rt.stats().staticImagesLive).toBe(1);
    expect(rt.stats().staticImageRevertsByCause["host-invalidate"]).toBe(1);

    rt.invalidateStaticSurfaces(); // no argument: the whole set
    expect(rt.stats().staticImagesLive).toBe(0);
    expect(standIn(b.self)).toBeNull();

    // NOT blocked: each surface re-earns its window.
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(2);
    rt.dispose();
  });

  it("setStaticParticleImages(false) reverts + revokes; (true) re-arms and re-earns", async () => {
    const clock = scheduler();
    const { root, nodes } = mount(1);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(1);
    const url = standIn(nodes[0].self)?.getAttribute("src");
    expect(url).toBeTruthy();

    rt.setStaticParticleImages(false);
    expect(standIn(nodes[0].self)).toBeNull();
    expect(canvasIn(nodes[0].self).style.display).toBe("");
    expect(rt.stats().staticImagesLive).toBe(0);
    expect(liveStaticImageUrlCount()).toBe(0);
    expect(revokedUrls).toContain(url);
    expect(clock.pending()).toBe(0); // every timer cancelled with the swapper

    // …and nothing re-swaps while it is off, however long the surface stands still.
    await clock.advance(QUIET_MS * 3);
    expect(rt.stats().staticImagesLive).toBe(0);

    rt.setStaticParticleImages(true);
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(1);
    rt.dispose();
  });
});

// ---- reverts the runtime owes -------------------------------------------------------------------

describe("particle surface swap — the reverts a re-size and a mode flip owe", () => {
  it("setRenderScale re-sizes the canvas, so the swap reverts (without blocking)", async () => {
    const clock = scheduler();
    const { root, nodes } = mount(1);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(1);

    rt.setRenderScale(0.5); // a different backing store ⇒ a different frame
    expect(rt.stats().staticImagesLive).toBe(0);
    expect(standIn(nodes[0].self)).toBeNull();
    expect(canvasIn(nodes[0].self).style.display).toBe("");
    expect(rt.stats().staticImageRevertsByCause.resize).toBe(1);

    // Re-earned after the new frame has stood still for a window (the loop redrew it in between).
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(1);
    rt.dispose();
  });

  it("a ResizeObserver delivery that re-allocates the canvas reverts it too", async () => {
    // The realloc CLEARS the backing store: whatever was frozen is not what the canvas holds.
    let deliver: ((entries: unknown[]) => void) | null = null;
    const observed: Element[] = [];
    globalThis.ResizeObserver = makeResizeObserverStub({
      onConstruct: (cb) => {
        deliver = cb as unknown as (entries: unknown[]) => void;
      },
      onObserve: (target) => {
        observed.push(target);
      },
    });

    const clock = scheduler();
    const { root, nodes } = mount(1);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(1);

    expect(deliver).not.toBeNull();
    deliver?.([
      { target: observed[0], contentRect: { width: 240, height: 240 } },
    ]);
    expect(rt.stats().staticImagesLive).toBe(0);
    expect(standIn(nodes[0].self)).toBeNull();
    expect(canvasIn(nodes[0].self).style.display).toBe("");
    rt.dispose();
  });

  it("setStaticParticles(false) reverts every surface — they are about to animate", async () => {
    const clock = scheduler();
    const { root, nodes } = mount(2);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(2);

    rt.setStaticParticles(false);
    // Immediately, not at the next paint: a suspended binding may not paint for a long time.
    expect(rt.stats().staticImagesLive).toBe(0);
    for (const n of nodes) {
      expect(standIn(n.self)).toBeNull();
      expect(canvasIn(n.self).style.display).toBe("");
    }
    rt.dispose();
  });

  it("a SUSPENDED binding is not frozen mid-suspension, and its resume repaint is clean", async () => {
    const clock = scheduler();
    const { root, nodes } = mount(1);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    flushRaf();

    // Occluded before it ever earns the window (`../effects-suspend`): it owes a redraw, so it is
    // not a surface anyone may freeze. Its canvas IS hidden while suspended — but by the dormancy
    // PARK, not by a swap (`staticImagesLive` stays 0 and no `<img>` exists); see
    // `particles-dormant.test.ts` for that arbitration.
    nodes[0].node.setAttribute("data-godot-effects-suspended", "1");
    rt.reconcile();
    await clock.advance(QUIET_MS * 3);
    expect(rt.stats().staticImagesLive).toBe(0);
    expect(standIn(nodes[0].self)).toBeNull();
    expect(canvasIn(nodes[0].self).style.display).toBe("none");
    expect(rt.stats().dormantLive).toBe(1);

    // Resume: the park un-hides the canvas, the reconcile kicks the loop, the binding repaints, and
    // only THEN can it earn a swap.
    nodes[0].node.removeAttribute("data-godot-effects-suspended");
    rt.reconcile();
    expect(canvasIn(nodes[0].self).style.display).toBe("");
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(1);
    expect(canvasIn(nodes[0].self).style.display).toBe("none");
    rt.dispose();
  });
});

// ---- teardown ------------------------------------------------------------------------------------

describe("particle surface swap — teardown", () => {
  it("dispose() reverts every surface and returns staticImageUrlsLive to 0", async () => {
    const clock = scheduler();
    const { root, nodes } = mount(3);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(rt.stats().staticImagesLive).toBe(3);
    // THREE surfaces on ONE key (`notePaint` reports it) ⇒ one URL, refcounted three times.
    expect(liveStaticImageUrlCount()).toBe(1);
    const urls = nodes.map((n) => standIn(n.self)?.getAttribute("src"));

    rt.dispose();

    // THE LEAK PROBE: a leaked object URL pins its bytes for the life of the document.
    expect(liveStaticImageUrlCount()).toBe(0);
    expect(rt.stats().staticImageUrlsLive).toBe(0);
    expect(rt.stats().staticImagesLive).toBe(0);
    for (const url of urls) expect(revokedUrls).toContain(url);
    // The stand-ins are gone with their canvases (the whole binding was torn down).
    for (const n of nodes) expect(standIn(n.self)).toBeNull();
    expect(clock.pending()).toBe(0); // nothing left armed
  });

  it("a node leaving the DOM releases its URL on the next reconcile", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    // Two DIFFERENT specs, so the two surfaces are two keys and two URLs — a shared key would only
    // prove the refcount, and what is under test here is the release.
    const a = particleNode(spec());
    const b = particleNode(spec({ seed: 5 }));
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      staticParticleImages: quietPolicy(clock),
    } as never);
    rt.reconcile();
    flushRaf();
    await clock.advance(QUIET_MS + 1);
    expect(liveStaticImageUrlCount()).toBe(2);

    a.node.remove();
    rt.reconcile();
    expect(liveStaticImageUrlCount()).toBe(1);
    expect(rt.stats().staticImagesLive).toBe(1);
    rt.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });
});
