// jsdom (gsw default env).
//
// THE POLICY SURFACE of `src/surface-image-swap.ts` — everything a HOST configures, driven through
// the module's own injected clock/timer seams (never vitest's global fake timers), because those
// seams ARE part of the contract: a consumer that wants deterministic freezes has to be able to
// supply them.
//
// What is pinned here, and why each one matters:
//   - the `quiet-window` gate: eligibility is measured from a surface's OWN DRAWS, so a host that
//     gates `reconcile()` on its own dirty flag cannot stretch (or falsely satisfy) the window;
//   - `onInvalidate: "retry"` vs the `"block"` default: an app that re-keys on `WxH` at every
//     breakpoint must not disqualify its whole population after one rotation;
//   - encode pacing: at most `slice` `toBlob`s per `intervalMs`, smallest-first — the thing that
//     stops a mass freeze from parking the main thread (736 ms, measured downstream);
//   - `canFreezeSurface`: the host veto that lets a second mechanism own an element's `display`;
//   - retry-forever on a failed encode;
//   - the WATCHDOG, without which the quiet-window gate has no correctness argument at all;
//   - `staticImagesLive`, the gauge that answers "is this actually engaged?" (72/72).
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  __resetStaticImageSwapForTest,
  claimStaticStill,
  createStaticImageSwapCounters,
  createStaticSurfaceSwapper,
  hasStaticStill,
  liveStaticImageUrlCount,
  noteStaticFrame,
  noteStaticImageReconcile,
  STATIC_SURFACE_IMAGE_ATTR,
  type StaticImageSwapBinding,
  type StaticImageSwapCounters,
  type StaticSurfacePolicy,
  type StaticSurfaceSwapper,
  staticStillPoolStats,
} from "../src/surface-image-swap";

// ---- encode / decode / object-URL stubs -------------------------------------------------------

/** Backing-store areas, in the order `toBlob` was actually called — the encode-pacing probe. */
let encodedAreas: number[] = [];
/** Per-call encode outcome; default = a blob. Returning null is a failed encode. */
let blobFor: (canvas: HTMLCanvasElement, call: number) => Blob | null = () =>
  new Blob(["frame"], { type: "image/png" });
let encodeCalls = 0;
let urlSeq = 0;
let revokedUrls: string[] = [];

let origToBlob: HTMLCanvasElement["toBlob"];
let origDecode: HTMLImageElement["decode"] | undefined;
let origCreateObjectURL: typeof URL.createObjectURL;
let origRevokeObjectURL: typeof URL.revokeObjectURL;

beforeAll(() => {
  origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function toBlob(
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ): void {
    encodedAreas.push(this.width * this.height);
    callback(blobFor(this, encodeCalls++));
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
});

afterAll(() => {
  HTMLCanvasElement.prototype.toBlob = origToBlob;
  if (origDecode) HTMLImageElement.prototype.decode = origDecode;
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
});

beforeEach(() => {
  __resetStaticImageSwapForTest();
  encodedAreas = [];
  encodeCalls = 0;
  revokedUrls = [];
  blobFor = () => new Blob(["frame"], { type: "image/png" });
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** Let the (real) promise jobs the decode gate rides on run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

// ---- the injected clock + timer seam ----------------------------------------------------------

/**
 * A hand-driven `now`/`setTimeout`/`clearTimeout` triple, handed to the policy. Everything the
 * module defers (gate windows, encode slices, the watchdog) runs exactly when a test says so, and
 * `pending()` is how a test proves the DEFAULT policy arms nothing at all.
 */
function scheduler() {
  let nowMs = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: (): number => nowMs,
    /** Charge wall time to the injected clock from INSIDE a stubbed `toBlob` — the only way a fake
     *  clock can express "this readback blocked the thread for 300 ms", which is what the encode
     *  cost counters and the adaptive backoff are measured against. */
    spend: (ms: number): void => {
      nowMs += ms;
    },
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
      // `Math.max`, not an assignment: a stubbed encode may have `spend()`-ed the clock PAST the
      // target from inside a timer callback, and a fake clock that runs backwards would un-expire
      // every deadline the module is holding. (Identical to a plain assignment without `spend`.)
      nowMs = Math.max(nowMs, target);
      await flush();
    },
  };
}

type Clock = ReturnType<typeof scheduler>;

function seams(clock: Clock): StaticSurfacePolicy {
  return {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
}

// ---- bindings ---------------------------------------------------------------------------------

function fakeBinding(width = 8, height = 4): StaticImageSwapBinding {
  const node = document.createElement("div");
  const self = document.createElement("div");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.setAttribute("data-godot-shader-canvas", "true");
  Object.assign(canvas.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
  });
  self.appendChild(canvas);
  node.appendChild(self);
  document.body.appendChild(node);
  return { node, canvas, dirty: false, dormant: false, staticImage: null };
}

const standIn = (binding: StaticImageSwapBinding): HTMLImageElement | null =>
  binding.canvas.parentElement?.querySelector<HTMLImageElement>(
    `[${STATIC_SURFACE_IMAGE_ATTR}]`,
  ) ?? null;

function makeSwapper(
  policy: StaticSurfacePolicy,
  counters: StaticImageSwapCounters,
): StaticSurfaceSwapper {
  const swapper = createStaticSurfaceSwapper(policy, counters);
  if (!swapper) throw new Error("policy unexpectedly disabled the swapper");
  return swapper;
}

/** jsdom has no 2d context at all, so the `encode.maxDim` clamp cannot run without one. This stubs
 *  the parts `encodeSource` touches and records what it was asked to do — and because the `toBlob`
 *  stub above records `this.width * this.height`, a clamped encode shows up in `encodedAreas` as the
 *  SCRATCH's area, which is the assertion the clamp tests make. `scratches` is the identity probe:
 *  `getContext` is called ON the scratch, so it records which canvas each clamp downscaled into. */
interface Fake2d {
  drawImages: Array<[unknown, number, number, number, number]>;
  clearRects: number;
  scratches: HTMLCanvasElement[];
}

let restore2d: (() => void) | null = null;

function withFake2d(): Fake2d {
  const fake: Fake2d = { drawImages: [], clearRects: 0, scratches: [] };
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(
    this: HTMLCanvasElement,
    kind: string,
  ): unknown {
    if (kind !== "2d") return null;
    fake.scratches.push(this);
    return {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      clearRect: (): void => {
        fake.clearRects++;
      },
      drawImage: (
        source: unknown,
        x: number,
        y: number,
        w: number,
        h: number,
      ): void => {
        fake.drawImages.push([source, x, y, w, h]);
      },
    };
  } as typeof HTMLCanvasElement.prototype.getContext;
  restore2d = (): void => {
    HTMLCanvasElement.prototype.getContext = orig;
  };
  return fake;
}

afterEach(() => {
  restore2d?.();
  restore2d = null;
});

/** Drive a content-key surface to its gate: one note establishes the key, `observations` confirm. */
function earnContentKeyGate(
  binding: StaticImageSwapBinding,
  key: string,
  counters: StaticImageSwapCounters,
  observations: number,
): void {
  for (let i = 0; i <= observations; i++) {
    noteStaticFrame(binding, key, counters);
  }
}

// ---- the quiet-window gate ---------------------------------------------------------------------

describe("surface image swap — the quiet-window gate", () => {
  const quietPolicy = (clock: Clock): StaticSurfacePolicy => ({
    ...seams(clock),
    gate: { kind: "quiet-window", quietMs: 1000 },
  });

  it("freezes a KEYLESS surface once its own draws hold still for quietMs, and not before", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(quietPolicy(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding);

    // A keyless surface reports a NULL key on every paint — the content-key gate would never fire.
    noteStaticFrame(binding, null, counters);
    await clock.advance(999);
    expect(standIn(binding)).toBeNull();

    await clock.advance(2);
    expect(standIn(binding)).toBeTruthy();
    expect(counters.staticImageSwaps).toBe(1);
    expect(counters.staticImagesLive).toBe(1);
    expect(binding.canvas.style.display).toBe("none");
    swapper.dispose();
  });

  it("thaws the INSTANT it draws again — synchronously, before the browser paints — and re-freezes a window later", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(quietPolicy(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding);
    await clock.advance(1001);
    expect(standIn(binding)).toBeTruthy();

    noteStaticFrame(binding, null, counters); // the surface repainted
    expect(standIn(binding)).toBeNull();
    expect(binding.canvas.style.display).toBe(""); // the live canvas is back, same tick
    expect(counters.staticImageRevertsByCause.draw).toBe(1);
    expect(counters.staticImageReverts).toBe(1);
    expect(counters.staticImagesLive).toBe(0);

    // Not blocked: the window simply restarts from that draw.
    await clock.advance(999);
    expect(standIn(binding)).toBeNull();
    await clock.advance(2);
    expect(standIn(binding)).toBeTruthy();
    expect(counters.staticImageSwaps).toBe(2);
    swapper.dispose();
  });

  it("does NOT use reconciles as its clock — they neither freeze nor thaw a surface", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(quietPolicy(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding);

    // A host hammering reconcile() cannot make the gate fire early...
    for (let i = 0; i < 50; i++)
      noteStaticImageReconcile(binding, true, counters);
    await clock.advance(500);
    expect(standIn(binding)).toBeNull();

    // ...and a host that never reconciles at all still freezes on the wall clock.
    await clock.advance(501);
    expect(standIn(binding)).toBeTruthy();

    // Nor can reconciles thaw it: only a real draw does.
    for (let i = 0; i < 50; i++)
      noteStaticImageReconcile(binding, true, counters);
    expect(standIn(binding)).toBeTruthy();
    expect(counters.staticImageReverts).toBe(0);
    swapper.dispose();
  });

  it("starts a surface's window at ATTACH, so one whose every frame was a cache-hit blit still freezes", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(quietPolicy(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding); // never noted at all

    await clock.advance(1001);
    expect(standIn(binding)).toBeTruthy();
    swapper.dispose();
  });

  it("waits out a DIRTY surface (a re-render is pending, so its pixels are about to move)", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(quietPolicy(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding);
    binding.dirty = true;

    await clock.advance(5000);
    expect(standIn(binding)).toBeNull();
    expect(encodedAreas).toEqual([]);

    binding.dirty = false;
    await clock.advance(1001);
    expect(standIn(binding)).toBeTruthy();
    swapper.dispose();
  });
});

// ---- onInvalidate ------------------------------------------------------------------------------

describe("surface image swap — onInvalidate: block vs retry", () => {
  it('"block" (the default) disqualifies a churned surface for the life of the binding', async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      { ...seams(clock), gate: { kind: "content-key", observations: 2 } },
      counters,
    );
    const binding = fakeBinding();
    swapper.attach(binding);

    earnContentKeyGate(binding, "k1", counters, 2);
    await flush();
    expect(standIn(binding)).toBeTruthy();

    noteStaticFrame(binding, "k2", counters); // churn
    await flush();
    expect(standIn(binding)).toBeNull();
    expect(counters.staticImageRevertsByCause["key-change"]).toBe(1);

    earnContentKeyGate(binding, "k2", counters, 2);
    await clock.advance(10_000);
    expect(standIn(binding)).toBeNull(); // blocked forever
    expect(counters.staticImageSwaps).toBe(1);
    swapper.dispose();
  });

  it('"retry" reverts on churn WITHOUT blocking, so the surface re-earns its swap', async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 2 },
        onInvalidate: "retry",
      },
      counters,
    );
    const binding = fakeBinding();
    swapper.attach(binding);

    earnContentKeyGate(binding, "k1", counters, 2);
    await flush();
    expect(standIn(binding)).toBeTruthy();

    // The "resizable canvas re-keys on WxH" case: one breakpoint must not end this surface's career.
    noteStaticFrame(binding, "k2", counters);
    await flush();
    expect(standIn(binding)).toBeNull();
    expect(counters.staticImageRevertsByCause["key-change"]).toBe(1);

    earnContentKeyGate(binding, "k2", counters, 2);
    await flush();
    expect(standIn(binding)).toBeTruthy();
    expect(counters.staticImageSwaps).toBe(2);
    swapper.dispose();
  });
});

// ---- encode pacing -----------------------------------------------------------------------------

describe("surface image swap — encode pacing", () => {
  /** Six surfaces, distinct keys and distinct backing areas, all reaching the gate in ONE block. */
  async function burst(
    counters: StaticImageSwapCounters,
    swapper: StaticSurfaceSwapper,
    areas: number[],
  ): Promise<StaticImageSwapBinding[]> {
    const bindings = areas.map((area) => fakeBinding(area, 1));
    for (const binding of bindings) swapper.attach(binding);
    for (const binding of bindings)
      noteStaticFrame(binding, `k${binding.canvas.width}`, counters);
    for (const binding of bindings)
      noteStaticFrame(binding, `k${binding.canvas.width}`, counters);
    await flush();
    return bindings;
  }

  it("kicks at most `slice` encodes per `intervalMs` and defers the rest", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: { slice: 2, intervalMs: 100 },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);

    // The whole point: six eligible surfaces are NOT six synchronous toBlobs.
    expect(encodedAreas.length).toBe(2);
    await clock.advance(100);
    expect(encodedAreas.length).toBe(4);
    await clock.advance(99);
    expect(encodedAreas.length).toBe(4); // the window has not turned over yet
    await clock.advance(1);
    expect(encodedAreas.length).toBe(6);
    expect(counters.staticImagesLive).toBe(6);
    swapper.dispose();
  });

  it("orders the DEFERRED queue smallest-first by backing-store area", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: { slice: 2, intervalMs: 100, order: "smallest-first" },
      },
      counters,
    );
    // The two inline (head-of-burst) encodes are deliberately unsorted — nothing to sort yet — so
    // the assertion is about the four that queue up behind them.
    await burst(counters, swapper, [10, 20, 900, 30, 400, 5]);
    expect(encodedAreas).toEqual([10, 20]);
    await clock.advance(300);
    expect(encodedAreas.slice(2)).toEqual([5, 30, 400, 900]);
    swapper.dispose();
  });

  it('`order: "dom"` keeps the order the surfaces became eligible in', async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: { slice: 2, intervalMs: 100, order: "dom" },
      },
      counters,
    );
    await burst(counters, swapper, [10, 20, 900, 30, 400, 5]);
    await clock.advance(300);
    expect(encodedAreas).toEqual([10, 20, 900, 30, 400, 5]);
    swapper.dispose();
  });

  it("`deferHead` unset keeps the head of a burst inline — every existing consumer's default", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: { slice: 2, intervalMs: 100 },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    // No clock advance at all yet: an inline head means these two already encoded synchronously,
    // on the caller's own stack.
    expect(encodedAreas.length).toBe(2);
    swapper.dispose();
  });

  it("`deferHead: true` routes even the head of a burst through the timer seam", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: { slice: 2, intervalMs: 100, deferHead: true },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    // The whole point: the caller that made six surfaces eligible never itself runs a `toBlob` —
    // nothing has encoded yet, though the clock has not moved at all.
    expect(encodedAreas.length).toBe(0);
    // The deferred head goes out at the minimum delay, not a whole `intervalMs` later.
    await clock.advance(1);
    expect(encodedAreas.length).toBe(2);
    await clock.advance(100);
    expect(encodedAreas.length).toBe(4);
    await clock.advance(100);
    expect(encodedAreas.length).toBe(6);
    expect(counters.staticImagesLive).toBe(6);
    swapper.dispose();
  });
});

// ---- the host busy signal ------------------------------------------------------------------------
//
// `encode.busy` is a POLICY-level answer to a cost the clock cannot reach: the encode is a GPU→CPU
// readback (~30 ms of wall time for 2.8 ms of CPU on a phone), so what hurts is WHEN it lands, not how
// many land per window. These pin the contract a host writes against: nothing encodes while it says
// busy — the inline head included — the deferral is BOUNDED, and every failure mode of the predicate
// (throwing, stuck ON, absent) leaves the fleet freezing rather than stuck on its canvases.

describe("surface image swap — encode.busy (the host's 'not now')", () => {
  /** Surfaces reaching a 1-observation gate in ONE block, as in the pacing tests above. */
  async function burst(
    counters: StaticImageSwapCounters,
    swapper: StaticSurfaceSwapper,
    areas: number[],
  ): Promise<StaticImageSwapBinding[]> {
    const bindings = areas.map((area) => fakeBinding(area, 1));
    for (const binding of bindings) swapper.attach(binding);
    for (let pass = 0; pass < 2; pass++) {
      for (const binding of bindings)
        noteStaticFrame(binding, `k${binding.canvas.width}`, counters);
    }
    await flush();
    return bindings;
  }

  const busyPolicy = (
    clock: Clock,
    busy: () => boolean,
    encode: Partial<NonNullable<StaticSurfacePolicy["encode"]>> = {},
  ): StaticSurfacePolicy => ({
    ...seams(clock),
    gate: { kind: "content-key", observations: 1 },
    encode: { slice: 2, intervalMs: 100, busy, ...encode },
  });

  it("defers every encode — the INLINE head included — while the host is busy, and drains once it is quiet", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    let busy = true;
    const swapper = makeSwapper(
      busyPolicy(clock, () => busy),
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);

    // The head is what `deferHead` alone cannot save: with no busy signal these two `toBlob`s already
    // ran on the caller's stack, in the middle of whatever burst made the surfaces eligible.
    expect(encodedAreas.length).toBe(0);
    await clock.advance(100);
    expect(encodedAreas.length).toBe(0); // re-armed a window later, still busy
    await clock.advance(100);
    expect(encodedAreas.length).toBe(0);
    expect(counters.staticImageBusyDeferrals).toBeGreaterThan(0);
    expect(counters.staticImageBusyForcedEncodes).toBe(0);

    busy = false;
    await clock.advance(100);
    expect(encodedAreas.length).toBe(2); // ordinary pacing resumes exactly where it left off
    await clock.advance(200);
    expect(encodedAreas.length).toBe(6);
    expect(counters.staticImagesLive).toBe(6);
    expect(counters.staticImageBusyForcedEncodes).toBe(0);
    swapper.dispose();
  });

  it("defers the `deferHead` head too — a 1 ms timer still lands inside the host's burst", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    let busy = true;
    const swapper = makeSwapper(
      busyPolicy(clock, () => busy, { deferHead: true }),
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);

    // `deferHead` on its own would have put the head out at the minimum delay — 1 ms into the burst.
    await clock.advance(1);
    expect(encodedAreas.length).toBe(0);
    await clock.advance(100);
    expect(encodedAreas.length).toBe(0);

    busy = false;
    await clock.advance(100);
    expect(encodedAreas.length).toBe(2);
    await clock.advance(200);
    expect(encodedAreas.length).toBe(6);
    swapper.dispose();
  });

  it("BOUNDS the deferral: a permanently busy host is slowed to a slice per busyMaxDeferMs, never stopped", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      busyPolicy(clock, () => true, { busyMaxDeferMs: 500 }),
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    expect(encodedAreas.length).toBe(0);

    // The bound elapses ⇒ one slice goes out against a host that never stopped saying "busy", and the
    // run restarts from there.
    await clock.advance(500);
    expect(encodedAreas.length).toBe(2);
    expect(counters.staticImageBusyForcedEncodes).toBe(1);
    await clock.advance(500);
    expect(encodedAreas.length).toBe(4);
    expect(counters.staticImageBusyForcedEncodes).toBe(2);
    await clock.advance(500);
    expect(encodedAreas.length).toBe(6);
    expect(counters.staticImageBusyForcedEncodes).toBe(3);
    expect(counters.staticImagesLive).toBe(6);
    // The diagnosis pair: forced ≈ deferrals is what a STUCK predicate looks like from the outside,
    // and both are non-zero here on purpose — this test IS that host.
    expect(counters.staticImageBusyDeferrals).toBeGreaterThan(0);
    swapper.dispose();
  });

  it("bounds the deferred head as well: a `deferHead` queue against a stuck host still drains", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      busyPolicy(clock, () => true, { deferHead: true, busyMaxDeferMs: 500 }),
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4]);
    expect(encodedAreas.length).toBe(0);
    await clock.advance(500);
    expect(encodedAreas.length).toBe(2);
    await clock.advance(500);
    expect(encodedAreas.length).toBe(4);
    expect(counters.staticImagesLive).toBe(4);
    swapper.dispose();
  });

  it("`busyMaxDeferMs: 0` means NEVER DEFER — the signal is ignored, predicate not even consulted", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    let calls = 0;
    const swapper = makeSwapper(
      busyPolicy(
        clock,
        () => {
          calls++;
          return true;
        },
        { busyMaxDeferMs: 0 },
      ),
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);

    // Byte-identical to the no-busy policy: the head is inline, on the caller's stack, at once.
    expect(encodedAreas.length).toBe(2);
    expect(calls).toBe(0);
    expect(counters.staticImageBusyDeferrals).toBe(0);
    expect(counters.staticImageBusyForcedEncodes).toBe(0);
    await clock.advance(300);
    expect(encodedAreas.length).toBe(6);
    swapper.dispose();
  });

  it("FAILS OPEN on a throwing predicate — a host bug must not stop the mechanism", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      busyPolicy(clock, () => {
        throw new Error("host predicate blew up");
      }),
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);

    expect(encodedAreas.length).toBe(2); // exactly as if no predicate had been supplied
    await clock.advance(300);
    expect(encodedAreas.length).toBe(6);
    expect(counters.staticImageBusyDeferrals).toBe(0);
    expect(counters.staticImageBusyForcedEncodes).toBe(0);
    swapper.dispose();
  });

  it("with NO busy field is byte-identical to today, and leaves both counters at 0", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: { slice: 2, intervalMs: 100 },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    expect(encodedAreas.length).toBe(2);
    await clock.advance(100);
    expect(encodedAreas.length).toBe(4);
    await clock.advance(100);
    expect(encodedAreas.length).toBe(6);
    expect(counters.staticImageBusyDeferrals).toBe(0);
    expect(counters.staticImageBusyForcedEncodes).toBe(0);
    swapper.dispose();
  });

  it("consults the predicate ONCE PER PASS, not once per queued surface", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    let calls = 0;
    const swapper = makeSwapper(
      busyPolicy(clock, () => {
        calls++;
        return true;
      }),
      counters,
    );
    // Six surfaces become eligible one at a time, so six passes reach the pump — and each asks once,
    // however many jobs are already queued behind the one it just added.
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    expect(calls).toBe(6);
    expect(counters.staticImageBusyDeferrals).toBe(6);

    // One timer drain over a six-deep queue is ONE more consult, not six.
    await clock.advance(100);
    expect(calls).toBe(7);
    expect(counters.staticImageBusyDeferrals).toBe(7);
    swapper.dispose();
  });
});

// ---- the host veto -----------------------------------------------------------------------------

describe("surface image swap — canFreezeSurface (the host veto)", () => {
  it("keeps a vetoed surface on its canvas, and swaps it once the host lets go", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const claimed = new Set<HTMLElement>();
    const seen: Array<[HTMLElement, HTMLCanvasElement]> = [];
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "quiet-window", quietMs: 1000 },
        canFreezeSurface: (node, canvas) => {
          seen.push([node, canvas]);
          return !claimed.has(node);
        },
      },
      counters,
    );
    const mine = fakeBinding();
    const theirs = fakeBinding();
    claimed.add(theirs.node); // "my own occlusion pass already owns this element's display"
    swapper.attach(mine);
    swapper.attach(theirs);

    await clock.advance(1001);
    expect(standIn(mine)).toBeTruthy();
    expect(standIn(theirs)).toBeNull();
    expect(theirs.canvas.style.display).toBe(""); // untouched — the host owns it
    // The veto is consulted with the host's NODE and its canvas, not just the canvas.
    expect(
      seen.some(
        ([node, canvas]) => node === theirs.node && canvas === theirs.canvas,
      ),
    ).toBe(true);

    claimed.delete(theirs.node);
    await clock.advance(1001);
    expect(standIn(theirs)).toBeTruthy();
    swapper.dispose();
  });
});

// ---- retry-forever on a failed encode ------------------------------------------------------------

describe("surface image swap — a failed encode", () => {
  it('under "block" leaves the surface on its canvas permanently', async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    blobFor = () => null; // toBlob hands back nothing
    const swapper = makeSwapper(
      { ...seams(clock), gate: { kind: "quiet-window", quietMs: 1000 } },
      counters,
    );
    const binding = fakeBinding();
    swapper.attach(binding);

    await clock.advance(1001);
    expect(standIn(binding)).toBeNull();
    expect(counters.staticImageFailures).toBe(1);

    blobFor = () => new Blob(["frame"], { type: "image/png" });
    await clock.advance(10_000);
    expect(standIn(binding)).toBeNull(); // blocked
    expect(encodedAreas.length).toBe(1); // and never retried
    swapper.dispose();
  });

  it('under "retry" is rescheduled on the encode cadence, forever, until it succeeds', async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    let failures = 0;
    blobFor = () => {
      if (failures++ < 3) return null;
      return new Blob(["frame"], { type: "image/png" });
    };
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "quiet-window", quietMs: 1000 },
        onInvalidate: "retry",
        encode: { slice: 4, intervalMs: 100 },
      },
      counters,
    );
    const binding = fakeBinding();
    swapper.attach(binding);

    await clock.advance(1001);
    expect(encodedAreas.length).toBe(1);
    expect(standIn(binding)).toBeNull();

    // One retry per encode interval — not a spin, and not a permanent block.
    await clock.advance(101);
    expect(encodedAreas.length).toBe(2);
    await clock.advance(101);
    expect(encodedAreas.length).toBe(3);
    expect(standIn(binding)).toBeNull();
    await clock.advance(101);
    expect(encodedAreas.length).toBe(4);
    expect(standIn(binding)).toBeTruthy(); // the fourth attempt produced a blob
    expect(counters.staticImageFailures).toBe(3);
    swapper.dispose();
  });
});

// ---- the watchdog ------------------------------------------------------------------------------

describe("surface image swap — the watchdog", () => {
  const watched = (clock: Clock): StaticSurfacePolicy => ({
    ...seams(clock),
    gate: { kind: "quiet-window", quietMs: 1000 },
    watchdogMs: 3000,
  });

  it("reverts a swapped surface whose canvas was repainted behind the module's back", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(watched(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding);
    await clock.advance(1001);
    expect(standIn(binding)).toBeTruthy();

    // A backing-store re-allocation CLEARS the canvas: the stand-in is now over a blank surface, and
    // nothing reported it. This is the class of write the quiet-window gate cannot hear about.
    binding.canvas.width = 64;

    // The watchdog is a standing cadence from the swapper's creation, not from the freeze.
    await clock.advance(1000);
    expect(standIn(binding)).toBeTruthy();
    await clock.advance(1000);
    expect(standIn(binding)).toBeNull();
    expect(counters.staticImageRevertsByCause.watchdog).toBe(1);
    expect(binding.canvas.style.display).toBe("");
    expect(counters.staticImagesLive).toBe(0);
    swapper.dispose();
  });

  it("reverts a swapped surface with a re-render pending, or one that left the DOM", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(watched(clock), counters);
    const dirty = fakeBinding();
    const gone = fakeBinding();
    swapper.attach(dirty);
    swapper.attach(gone);
    await clock.advance(1001);
    expect(standIn(dirty)).toBeTruthy();
    expect(standIn(gone)).toBeTruthy();

    dirty.dirty = true;
    gone.node.remove();
    await clock.advance(3000);
    expect(standIn(dirty)).toBeNull();
    expect(gone.staticImage?.shown).toBe(false);
    expect(counters.staticImageRevertsByCause.watchdog).toBe(2);
    swapper.dispose();
  });

  it("RE-SYNCS (does not revert) a stand-in whose canvas merely moved", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(watched(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding);
    await clock.advance(1001);
    const img = standIn(binding);
    expect(img?.style.left).toBe("0px");

    binding.canvas.style.left = "42px"; // a later placement write by the host runtime
    await clock.advance(3000);
    expect(standIn(binding)).toBe(img); // same element, still swapped
    expect(img?.style.left).toBe("42px");
    expect(img?.style.display).toBe("block");
    expect(counters.staticImageReverts).toBe(0);
    swapper.dispose();
  });

  it("arms NO timer at all under the default (content-key) policy", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(seams(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding);
    earnContentKeyGate(binding, "k", counters, 3);
    await flush();
    expect(standIn(binding)).toBeTruthy();
    // The content-key invariant does not need a watchdog, so an idle frozen scene costs zero
    // wakeups — the property that lets this ship ON by default.
    expect(clock.pending()).toBe(0);
    swapper.dispose();
  });
});

// ---- host-driven invalidation + the live gauge ---------------------------------------------------

describe("surface image swap — invalidate() and staticImagesLive", () => {
  it("invalidate() hands surfaces back WITHOUT blocking — all of them, or just the named ones", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      { ...seams(clock), gate: { kind: "quiet-window", quietMs: 1000 } },
      counters,
    );
    const a = fakeBinding();
    const b = fakeBinding();
    swapper.attach(a);
    swapper.attach(b);
    await clock.advance(1001);
    expect(counters.staticImagesLive).toBe(2);

    swapper.invalidate([a]);
    expect(standIn(a)).toBeNull();
    expect(standIn(b)).toBeTruthy();
    expect(counters.staticImagesLive).toBe(1);
    expect(counters.staticImageRevertsByCause["host-invalidate"]).toBe(1);

    swapper.invalidate();
    expect(standIn(b)).toBeNull();
    expect(counters.staticImagesLive).toBe(0);
    expect(counters.staticImageRevertsByCause["host-invalidate"]).toBe(2);

    // Not blocked: both re-earn a window later.
    await clock.advance(1001);
    expect(standIn(a)).toBeTruthy();
    expect(standIn(b)).toBeTruthy();
    expect(counters.staticImagesLive).toBe(2);
    swapper.dispose();
  });

  it("staticImagesLive rises with the swapped set and comes back to 0 on dispose", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "quiet-window", quietMs: 1000 },
        encode: { slice: 8, intervalMs: 10 },
      },
      counters,
    );
    const bindings = [1, 2, 3, 4, 5].map((i) => fakeBinding(i * 2, 2));
    for (const binding of bindings) swapper.attach(binding);
    expect(counters.staticImagesLive).toBe(0);

    await clock.advance(1001);
    expect(counters.staticImagesLive).toBe(5);
    expect(swapper.liveSwapCount()).toBe(5);
    expect(liveStaticImageUrlCount()).toBe(5);

    swapper.dispose();
    expect(counters.staticImagesLive).toBe(0);
    expect(swapper.liveSwapCount()).toBe(0);
    expect(liveStaticImageUrlCount()).toBe(0); // and no object URL leaked
    expect(revokedUrls.length).toBe(5);
    // Disposal is a teardown, not a hand-back: it must not inflate the revert counter.
    expect(counters.staticImageReverts).toBe(0);
    expect(clock.pending()).toBe(0);
  });
});

// ---- encode.perTask: one readback per task ------------------------------------------------------
//
// `slice` bounds THROUGHPUT per window; it never bounded the PARK, and a device trace said so at
// 1,163 ms — four ~4821x2156 readbacks back-to-back in one timer task on a saturated GPU, against
// 6-13 ms each for the same surfaces once the load passed. `perTask` is the budget that bounds the
// block, and the reason it is scoped to a TASK rather than to a call is that surfaces become eligible
// one at a time: `runSweep` reaches `pumpEncodes` once per surface, all on the same stack.

describe("surface image swap — encode.perTask (one readback per task)", () => {
  /** Surfaces reaching a 1-observation gate in ONE block (the pacing tests' shape). */
  async function burst(
    counters: StaticImageSwapCounters,
    swapper: StaticSurfaceSwapper,
    areas: number[],
  ): Promise<StaticImageSwapBinding[]> {
    const bindings = areas.map((area) => fakeBinding(area, 1));
    for (const binding of bindings) swapper.attach(binding);
    for (let pass = 0; pass < 2; pass++) {
      for (const binding of bindings)
        noteStaticFrame(binding, `k${binding.canvas.width}`, counters);
    }
    await flush();
    return bindings;
  }

  it("puts ONE readback in a task however much slice budget the window has left", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: { slice: 4, intervalMs: 100, perTask: 1, taskGapMs: 10 },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);

    // Six surfaces became eligible on ONE stack, and the window has four encodes of budget: exactly
    // one of them ran. That is the whole fix — the other three are still owed, just not here.
    expect(encodedAreas.length).toBe(1);
    await clock.advance(10);
    expect(encodedAreas.length).toBe(2);
    await clock.advance(10);
    expect(encodedAreas.length).toBe(3);
    await clock.advance(10);
    expect(encodedAreas.length).toBe(4);
    swapper.dispose();
  });

  it("still bounds throughput to `slice` per `intervalMs`", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: { slice: 4, intervalMs: 100, perTask: 1, taskGapMs: 10 },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    await clock.advance(30);
    expect(encodedAreas.length).toBe(4); // the window's whole budget, in four separate tasks

    // A task gap buys nothing once the WINDOW budget is spent: throughput is unchanged, only its
    // granularity moved.
    await clock.advance(10);
    expect(encodedAreas.length).toBe(4);
    await clock.advance(100);
    expect(encodedAreas.length).toBe(6);
    expect(counters.staticImagesLive).toBe(6);
    swapper.dispose();
  });

  it("defaults to `slice`: the drain is byte-identical when `perTask` is unset", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: { slice: 2, intervalMs: 100 },
      },
      counters,
    );
    // The existing pacing test's numbers, exactly — the guard that no other consumer moved.
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    expect(encodedAreas.length).toBe(2);
    await clock.advance(100);
    expect(encodedAreas.length).toBe(4);
    await clock.advance(99);
    expect(encodedAreas.length).toBe(4);
    await clock.advance(1);
    expect(encodedAreas.length).toBe(6);
    swapper.dispose();
  });

  it("re-asks `busy` before EVERY readback, so a host that goes busy mid-drain stops the next one", async () => {
    // THE REGRESSION TEST FOR THE TRACED BUG. The predicate is consulted once per PASS; with the
    // whole slice draining in one pass it could not stop the 2nd, 3rd or 4th readback however much
    // busier each one made the host.
    const run = async (perTask: number | undefined): Promise<number> => {
      __resetStaticImageSwapForTest();
      encodedAreas = [];
      encodeCalls = 0;
      const clock = scheduler();
      const counters = createStaticImageSwapCounters();
      let busy = true;
      // The host goes busy again the instant a readback starts — which is what a readback DOES.
      blobFor = () => {
        busy = true;
        return new Blob(["frame"], { type: "image/png" });
      };
      const swapper = makeSwapper(
        {
          ...seams(clock),
          gate: { kind: "content-key", observations: 1 },
          encode: {
            slice: 4,
            intervalMs: 100,
            taskGapMs: 10,
            busy: () => busy,
            ...(perTask === undefined ? {} : { perTask }),
          },
        },
        counters,
      );
      await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
      expect(encodedAreas.length).toBe(0); // busy throughout the burst
      busy = false;
      await clock.advance(100); // one drain pass, against a host that is quiet AT THE PASS
      const encoded = encodedAreas.length;
      await clock.advance(1000);
      expect(encodedAreas.length).toBe(encoded); // and busy for every pass after
      expect(counters.staticImageBusyDeferrals).toBeGreaterThan(0);
      swapper.dispose();
      return encoded;
    };

    expect(await run(1)).toBe(1); // the fix: one readback, then the predicate gets a say
    expect(await run(undefined)).toBe(4); // the bug: a whole slice, uninterruptible
  });

  it("a FORCED pass under `perTask: 1` spends ONE readback, not a slice", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: {
          slice: 4,
          intervalMs: 100,
          perTask: 1,
          taskGapMs: 10,
          busy: () => true,
          busyMaxDeferMs: 500,
        },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    expect(encodedAreas.length).toBe(0);

    // Raising `busyMaxDeferMs` is what a host does once its predicate is truthful, and the reason
    // that is affordable is here: the guaranteed-progress pass is one readback, not four.
    await clock.advance(500);
    expect(encodedAreas.length).toBe(1);
    expect(counters.staticImageBusyForcedEncodes).toBe(1);
    // The next bound is measured from the forced pass, and the re-ask cadence is `intervalMs` offset
    // by the task gap the forced pass armed — so it lands a shade after 1,000, not exactly on it.
    await clock.advance(600);
    expect(encodedAreas.length).toBe(2);
    expect(counters.staticImageBusyForcedEncodes).toBe(2);
    swapper.dispose();
  });
});

// ---- the adaptive slow-encode backoff -----------------------------------------------------------
//
// The belt to `encode.busy`'s braces, and it exists because of a specific trap: a host predicate is
// usually derived from its FRAME LOOP, and a long readback suppresses the very frames that signal is
// made of. The traced jam produced 362 ms and 674 ms gaps that a 250 ms frame-recency predicate read
// as IDLE. The previous readback's measured cost cannot be faked that way.

describe("surface image swap — the adaptive slow-encode backoff", () => {
  async function burst(
    counters: StaticImageSwapCounters,
    swapper: StaticSurfaceSwapper,
    areas: number[],
  ): Promise<StaticImageSwapBinding[]> {
    const bindings = areas.map((area) => fakeBinding(area, 1));
    for (const binding of bindings) swapper.attach(binding);
    for (let pass = 0; pass < 2; pass++) {
      for (const binding of bindings)
        noteStaticFrame(binding, `k${binding.canvas.width}`, counters);
    }
    await flush();
    return bindings;
  }

  /** A `toBlob` that charges `ms` of wall time to the injected clock, i.e. a readback that blocks. */
  const costs = (clock: Clock, ms: number): void => {
    blobFor = () => {
      clock.spend(ms);
      return new Blob(["frame"], { type: "image/png" });
    };
  };

  it("holds the next readback after a slow one, even while the host reports QUIET", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    costs(clock, 300);
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: {
          slice: 4,
          intervalMs: 100,
          perTask: 1,
          taskGapMs: 10,
          busy: () => false, // the stale signal: a jam suppresses the frames it is made of
          slowEncodeMs: 100,
          slowBackoffMs: 1000,
        },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);

    expect(encodedAreas.length).toBe(1);
    expect(counters.staticImageSlowEncodes).toBe(1);
    expect(counters.staticImageEncodeMaxMs).toBe(300);
    // The split is the point: the host never said busy, so every deferral here is the module's own.
    expect(counters.staticImageBackoffDeferrals).toBeGreaterThan(0);
    expect(counters.staticImageBusyDeferrals).toBe(0);

    await clock.advance(999);
    expect(encodedAreas.length).toBe(1); // still held
    await clock.advance(2);
    expect(encodedAreas.length).toBe(2); // the hold elapsed
    swapper.dispose();
  });

  it("a FAST readback arms nothing", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    costs(clock, 5);
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: {
          slice: 2,
          intervalMs: 100,
          slowEncodeMs: 100,
          slowBackoffMs: 1000,
        },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    expect(encodedAreas.length).toBe(2);
    expect(counters.staticImageSlowEncodes).toBe(0);
    expect(counters.staticImageBackoffDeferrals).toBe(0);
    expect(counters.staticImageEncodeMs).toBe(10);
    await clock.advance(300);
    expect(encodedAreas.length).toBe(6);
    swapper.dispose();
  });

  it("`busyMaxDeferMs` bounds the BACKOFF too — a slowdown, never a stop", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    costs(clock, 300); // every readback is slow, forever
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: {
          slice: 4,
          intervalMs: 100,
          perTask: 1,
          taskGapMs: 10,
          slowEncodeMs: 50,
          slowBackoffMs: 1_000_000, // a hold that would never elapse on its own
          busyMaxDeferMs: 500,
        },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    expect(encodedAreas.length).toBe(1);

    // The single shared bound covers BOTH reasons, so an un-elapsing backoff still drains the fleet
    // one readback at a time — the un-swapped surface it would otherwise strand is a live canvas.
    await clock.advance(20_000);
    expect(encodedAreas.length).toBe(6);
    expect(counters.staticImagesLive).toBe(6);
    expect(counters.staticImageBusyForcedEncodes).toBeGreaterThanOrEqual(5);
    swapper.dispose();
  });

  it("`slowEncodeMs` unset (the default) changes nothing", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    costs(clock, 300); // slow readbacks, and nothing is asked to care
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        // A window LONGER than the readbacks it holds: at `intervalMs: 100` a 300 ms readback rolls
        // the window under its own feet, which is a true statement about the default pacing but not
        // the one under test here.
        encode: { slice: 2, intervalMs: 5000 },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    expect(encodedAreas.length).toBe(2);
    expect(counters.staticImageSlowEncodes).toBe(0);
    expect(counters.staticImageBackoffDeferrals).toBe(0);
    await clock.advance(5000);
    expect(encodedAreas.length).toBe(4);
    await clock.advance(5000);
    expect(encodedAreas.length).toBe(6);
    swapper.dispose();
  });

  it("`busyMaxDeferMs: 0` disables the backoff as well as the predicate", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    costs(clock, 300);
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: {
          slice: 2,
          intervalMs: 5000,
          slowEncodeMs: 50,
          slowBackoffMs: 1_000_000,
          busyMaxDeferMs: 0,
        },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3, 4, 5, 6]);
    // The widened meaning of the valve: no deferral machinery at all, for either reason. A backoff
    // this long would otherwise have stopped the fleet dead after the first readback.
    expect(encodedAreas.length).toBe(2);
    expect(counters.staticImageBackoffDeferrals).toBe(0);
    // The MEASUREMENT is still honest — only the acting on it is switched off.
    expect(counters.staticImageSlowEncodes).toBe(2);
    await clock.advance(5000);
    expect(encodedAreas.length).toBe(4);
    await clock.advance(5000);
    expect(encodedAreas.length).toBe(6);
    swapper.dispose();
  });

  it("`staticImageEncodeMaxMs` reports the worst SINGLE readback", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const spends = [50, 300, 20];
    blobFor = (_canvas, call) => {
      clock.spend(spends[call] ?? 0);
      return new Blob(["frame"], { type: "image/png" });
    };
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "content-key", observations: 1 },
        encode: { slice: 3, intervalMs: 100 },
      },
      counters,
    );
    await burst(counters, swapper, [1, 2, 3]);
    expect(encodedAreas.length).toBe(3);
    expect(counters.staticImageEncodeMaxMs).toBe(300);
    expect(counters.staticImageEncodeMs).toBe(370);
    swapper.dispose();
  });
});

// ---- encode.maxDim: the clamped readback --------------------------------------------------------

describe("surface image swap — encode.maxDim (the clamped readback)", () => {
  const clamped = (clock: Clock, maxDim: number): StaticSurfacePolicy => ({
    ...seams(clock),
    gate: { kind: "quiet-window", quietMs: 1000 },
    encode: { slice: 4, intervalMs: 100, maxDim },
  });

  it("reads back a SCRATCH at the clamped, aspect-preserved size", async () => {
    const fake = withFake2d();
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(clamped(clock, 2048), counters);
    const binding = fakeBinding(4000, 2000);
    swapper.attach(binding);

    await clock.advance(1001);
    // 2048/4000 preserved on both axes: 5.5x fewer pixels off the GPU than the source.
    expect(encodedAreas).toEqual([2048 * 1024]);
    expect(fake.drawImages).toEqual([[binding.canvas, 0, 0, 2048, 1024]]);
    expect(counters.staticImageClampedEncodes).toBe(1);
    expect(standIn(binding)).toBeTruthy();
    swapper.dispose();
  });

  it("leaves a surface at or under the limit alone", async () => {
    const fake = withFake2d();
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(clamped(clock, 2048), counters);
    const binding = fakeBinding(2048, 512);
    swapper.attach(binding);

    await clock.advance(1001);
    expect(encodedAreas).toEqual([2048 * 512]);
    expect(fake.drawImages).toEqual([]);
    expect(fake.scratches).toEqual([]); // no scratch was even allocated
    expect(counters.staticImageClampedEncodes).toBe(0);
    swapper.dispose();
  });

  it("never mutates the source canvas, so the WATCHDOG does not revert the swap", async () => {
    withFake2d();
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      { ...clamped(clock, 1024), watchdogMs: 3000 },
      counters,
    );
    const binding = fakeBinding(4000, 2000);
    swapper.attach(binding);
    await clock.advance(1001);
    expect(standIn(binding)).toBeTruthy();

    // The clamp writes to the scratch; `frozenW/H` and `drawSeq` are read off the SOURCE, so the
    // watchdog's evidence of a legitimate freeze is untouched by it.
    expect(binding.canvas.width).toBe(4000);
    expect(binding.canvas.height).toBe(2000);
    await clock.advance(10_000);
    expect(standIn(binding)).toBeTruthy();
    expect(counters.staticImageReverts).toBe(0);
    swapper.dispose();
  });

  it("falls back to the SOURCE when no 2d context is available", async () => {
    // No `withFake2d()`: jsdom has no 2d context, which is exactly the "the clamp cannot run here"
    // case. A clamp that will not run must never be the reason a surface fails to freeze.
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(clamped(clock, 512), counters);
    const binding = fakeBinding(4000, 2000);
    swapper.attach(binding);

    await clock.advance(1001);
    expect(encodedAreas).toEqual([4000 * 2000]);
    expect(counters.staticImageClampedEncodes).toBe(0);
    expect(counters.staticImageFailures).toBe(0);
    expect(standIn(binding)).toBeTruthy();
    swapper.dispose();
  });

  it("reuses ONE scratch across encodes and releases it at dispose", async () => {
    const fake = withFake2d();
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(clamped(clock, 1024), counters);
    const a = fakeBinding(4000, 2000);
    const b = fakeBinding(2000, 4000);
    swapper.attach(a);
    swapper.attach(b);

    await clock.advance(1001);
    expect(counters.staticImageClampedEncodes).toBe(2);
    expect(new Set(fake.scratches).size).toBe(1); // one per swapper, not one per encode
    const scratch = fake.scratches[0];
    expect(scratch).toBeTruthy();
    expect(scratch?.width).toBeGreaterThan(0);

    swapper.dispose();
    // A 0x0 backing store releases the pixels now rather than at the next GC.
    expect(scratch?.width).toBe(0);
    expect(scratch?.height).toBe(0);
  });

  it("`maxDim` unset changes nothing", async () => {
    const fake = withFake2d();
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "quiet-window", quietMs: 1000 },
        encode: { slice: 4, intervalMs: 100 },
      },
      counters,
    );
    const binding = fakeBinding(4000, 2000);
    swapper.attach(binding);

    await clock.advance(1001);
    expect(encodedAreas).toEqual([4000 * 2000]);
    expect(fake.drawImages).toEqual([]);
    expect(counters.staticImageClampedEncodes).toBe(0);
    swapper.dispose();
  });
});

// ---- parked stills: reuse across revert and re-freeze --------------------------------------------
//
// A keyless surface's revert is usually not a repaint: a host `invalidate`, a dormancy wake, a
// watchdog proxy. `state.drawSeq` says so — it counts actual paints and it did not move — and the
// canvas still holds the exact frozen frame. Parking the entry turns the next freeze into a
// re-attach, for the price of the retained blob. What must not happen is the other case: handing back
// pixels the canvas no longer has.

describe("surface image swap — parked stills (encode.parkedStillBytes)", () => {
  const parked = (clock: Clock, bytes: number): StaticSurfacePolicy => ({
    ...seams(clock),
    gate: { kind: "quiet-window", quietMs: 1000 },
    encode: { slice: 8, intervalMs: 100, parkedStillBytes: bytes },
  });

  const srcOf = (binding: StaticImageSwapBinding): string | null =>
    standIn(binding)?.getAttribute("src") ?? null;

  it("re-attaches the SAME url with zero readback when nothing painted in between", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(parked(clock, 1 << 20), counters);
    const binding = fakeBinding();
    swapper.attach(binding);

    await clock.advance(1001);
    const url = srcOf(binding);
    expect(url).toBeTruthy();
    expect(encodedAreas.length).toBe(1);

    swapper.invalidate(); // the host said "not now" — it did not say the pixels moved
    expect(standIn(binding)).toBeNull();
    expect(revokedUrls).toEqual([]); // parked, not revoked
    expect(liveStaticImageUrlCount()).toBe(1);
    // A canvas that MOVED while parked is not stale — but the stand-in copies the box at freeze time,
    // so a re-attach has to copy the CURRENT one (the watchdog's re-sync only walks shown surfaces).
    binding.canvas.style.left = "42px";

    await clock.advance(1001);
    expect(standIn(binding)?.style.left).toBe("42px");
    expect(srcOf(binding)).toBe(url); // the same frame, re-attached
    expect(encodedAreas.length).toBe(1); // and NOT a second readback
    expect(counters.staticImageReuseHits).toBe(1);
    expect(counters.staticImageEncodes).toBe(1);
    expect(counters.staticImagesLive).toBe(1);
    swapper.dispose();
  });

  it("is disqualified by a DRAW — the canvas no longer holds the encoded frame", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(parked(clock, 1 << 20), counters);
    const binding = fakeBinding();
    swapper.attach(binding);
    await clock.advance(1001);
    const url = srcOf(binding);

    swapper.invalidate();
    noteStaticFrame(binding, null, counters); // a real paint, after the park

    await clock.advance(1001);
    expect(encodedAreas.length).toBe(2);
    expect(srcOf(binding)).not.toBe(url);
    expect(counters.staticImageReuseHits).toBe(0);
    expect(revokedUrls).toEqual([url]); // and the stale still was dropped, not kept on a hunch
    swapper.dispose();
  });

  it("is disqualified by a RE-ALLOCATION — a width write clears the backing store", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(parked(clock, 1 << 20), counters);
    const binding = fakeBinding(8, 4);
    swapper.attach(binding);
    await clock.advance(1001);
    const url = srcOf(binding);

    swapper.invalidate();
    binding.canvas.width = 16;

    await clock.advance(1001);
    expect(encodedAreas).toEqual([8 * 4, 16 * 4]);
    expect(srcOf(binding)).not.toBe(url);
    expect(counters.staticImageReuseHits).toBe(0);
    expect(revokedUrls).toEqual([url]);
    swapper.dispose();
  });

  it("evicts LEAST-RECENTLY-PARKED first once the byte budget is exceeded", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    blobFor = () => new Blob(["0123456789"], { type: "image/png" }); // 10 bytes each
    // Room for two stills; the third park must throw the oldest out.
    const swapper = makeSwapper(parked(clock, 25), counters);
    const a = fakeBinding(2, 2);
    const b = fakeBinding(4, 2);
    const c = fakeBinding(6, 2);
    for (const binding of [a, b, c]) swapper.attach(binding);
    await clock.advance(1001);
    expect(encodedAreas.length).toBe(3);
    const urlA = srcOf(a);

    swapper.invalidate(); // parks a, then b, then c — 30 bytes against a 25-byte budget
    expect(revokedUrls).toEqual([urlA]);
    expect(liveStaticImageUrlCount()).toBe(2);

    await clock.advance(1001);
    // The two survivors re-attach for free; the evicted one pays a readback, as it must.
    expect(counters.staticImageReuseHits).toBe(2);
    expect(encodedAreas.length).toBe(4);
    expect(srcOf(a)).not.toBe(urlA);
    expect(counters.staticImagesLive).toBe(3);
    swapper.dispose();
  });

  it("`parkedStillBytes` unset (the default) is today's immediate revoke", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "quiet-window", quietMs: 1000 },
        encode: { slice: 8, intervalMs: 100 },
      },
      counters,
    );
    const binding = fakeBinding();
    swapper.attach(binding);
    await clock.advance(1001);
    const url = srcOf(binding);

    swapper.invalidate();
    expect(revokedUrls).toEqual([url]); // the last holder let go, so the URL went with it
    expect(liveStaticImageUrlCount()).toBe(0);

    await clock.advance(1001);
    expect(encodedAreas.length).toBe(2);
    expect(counters.staticImageReuseHits).toBe(0);
    swapper.dispose();
  });

  it("revokes parked stills on dispose — a park must not outlive its swapper", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(parked(clock, 1 << 20), counters);
    const binding = fakeBinding();
    swapper.attach(binding);
    await clock.advance(1001);
    const url = srcOf(binding);

    swapper.invalidate();
    expect(liveStaticImageUrlCount()).toBe(1); // parked: the bytes are still pinned

    swapper.dispose();
    expect(revokedUrls).toEqual([url]);
    expect(liveStaticImageUrlCount()).toBe(0); // the leak probe still comes back to 0
  });
});

// ---- the KEYED quiet window ---------------------------------------------------------------------
//
// A quiet-window host may name SOME of its frames. Where it does, the key is content evidence and
// not merely a share key (see the module doc's KEYED-OR-QUIET), and two things change for that
// surface: it may become eligible on a shorter deadline (`keyedQuietMs`), and a repaint that reports
// the SAME key is a re-statement of the pixels already on screen rather than movement. Both are
// inert unless the host asks: an absent `keyedQuietMs` IS `quietMs`, and a null key is the plain
// keyless surface these tests' neighbours above pin.

describe("surface image swap — the KEYED quiet window (gate.keyedQuietMs)", () => {
  const keyedNow = (
    clock: Clock,
    over: Partial<StaticSurfacePolicy> = {},
  ): StaticSurfacePolicy => ({
    ...seams(clock),
    gate: { kind: "quiet-window", quietMs: 1000, keyedQuietMs: 0 },
    encode: { slice: 8, intervalMs: 100 },
    ...over,
  });

  const srcOf = (binding: StaticImageSwapBinding): string | null =>
    standIn(binding)?.getAttribute("src") ?? null;

  it("freezes a KEYED surface the instant it paints, while a keyless one still waits out quietMs", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(keyedNow(clock), counters);
    const keyed = fakeBinding();
    const keyless = fakeBinding();
    swapper.attach(keyed);
    swapper.attach(keyless);

    noteStaticFrame(keyed, "frame-a", counters);
    noteStaticFrame(keyless, null, counters);

    // One sweep tick is all the keyed surface needs: its window is over the moment it painted.
    await clock.advance(2);
    expect(standIn(keyed)).toBeTruthy();
    expect(standIn(keyless)).toBeNull();

    // …and the keyless one is held to exactly the window it always was, from the same paint.
    await clock.advance(1001);
    expect(standIn(keyless)).toBeTruthy();
    expect(counters.staticImageSwaps).toBe(2);
    swapper.dispose();
  });

  it("leaves the swap standing across a repaint under the SAME key — the watchdog included", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(keyedNow(clock, { watchdogMs: 500 }), counters);
    const binding = fakeBinding();
    swapper.attach(binding);
    noteStaticFrame(binding, "frame-a", counters);
    await clock.advance(2);
    const url = srcOf(binding);
    expect(url).toBeTruthy();

    // The host re-blitted the same cached frame. Identical pixels by the key's own contract, so the
    // `<img>` over them is still correct — reverting here would cost a revert plus a re-encode per
    // paint, i.e. the mechanism never engaging for a host that re-blits.
    noteStaticFrame(binding, "frame-a", counters);
    expect(srcOf(binding)).toBe(url);
    expect(counters.staticImageReverts).toBe(0);
    expect(counters.staticImagesLive).toBe(1);
    expect(encodedAreas.length).toBe(1);

    // …and the WATCHDOG must not undo on the next sweep what this branch just accepted: the freeze's
    // own evidence (the paint count it was taken at) follows an accepted repaint.
    await clock.advance(1200);
    expect(srcOf(binding)).toBe(url);
    expect(counters.staticImageRevertsByCause.watchdog).toBe(0);
    swapper.dispose();
  });

  it("still reverts on a DIFFERENT key, and on a null one", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(keyedNow(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding);
    noteStaticFrame(binding, "frame-a", counters);
    await clock.advance(2);
    expect(standIn(binding)).toBeTruthy();

    noteStaticFrame(binding, "frame-b", counters); // the pixels really did move
    expect(standIn(binding)).toBeNull();
    expect(binding.canvas.style.display).toBe("");
    expect(counters.staticImageRevertsByCause.draw).toBe(1);

    await clock.advance(2); // re-earns on the keyed deadline
    expect(standIn(binding)).toBeTruthy();

    // A paint the host cannot NAME is the keyless case again: no evidence, so no benefit of the
    // doubt.
    noteStaticFrame(binding, null, counters);
    expect(standIn(binding)).toBeNull();
    expect(counters.staticImageRevertsByCause.draw).toBe(2);
    // …and it is back on the plain window, since it has no key to be held to the short one.
    await clock.advance(2);
    expect(standIn(binding)).toBeNull();
    await clock.advance(1001);
    expect(standIn(binding)).toBeTruthy();
    swapper.dispose();
  });

  it("is INERT when the host does not set it: a keyed surface waits out quietMs like any other", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "quiet-window", quietMs: 1000 },
        encode: { slice: 8, intervalMs: 100 },
      },
      counters,
    );
    const binding = fakeBinding();
    swapper.attach(binding);
    noteStaticFrame(binding, "frame-a", counters);

    await clock.advance(999);
    expect(standIn(binding)).toBeNull();
    await clock.advance(2);
    expect(standIn(binding)).toBeTruthy();
    swapper.dispose();
  });
});

// ---- retained stills: the pixels outlive the surface ---------------------------------------------
//
// A PARKED still is claimable by one surface and dies with it. A RETAINED one belongs to the KEY, so
// it survives the binding entirely and the next surface to reach that key attaches for zero
// readback. Both kinds share one pool, one byte total and one eviction walk.

describe("surface image swap — retained stills (encode.stillCacheBytes)", () => {
  const retaining = (
    clock: Clock,
    encode: Record<string, unknown> = {},
  ): StaticSurfacePolicy => ({
    ...seams(clock),
    gate: { kind: "quiet-window", quietMs: 1000, keyedQuietMs: 0 },
    encode: { slice: 8, intervalMs: 100, stillCacheBytes: 1 << 20, ...encode },
  });

  const srcOf = (binding: StaticImageSwapBinding): string | null =>
    standIn(binding)?.getAttribute("src") ?? null;

  /** Swap `binding` under `key` on the keyed deadline, and hand back the URL it is showing. */
  async function freezeUnder(
    swapper: StaticSurfaceSwapper,
    binding: StaticImageSwapBinding,
    key: string,
    counters: StaticImageSwapCounters,
    clock: Clock,
  ): Promise<string | null> {
    swapper.attach(binding);
    noteStaticFrame(binding, key, counters);
    await clock.advance(2);
    return srcOf(binding);
  }

  it("survives the DISPOSE of its last holder, and a fresh binding re-attaches for free", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(retaining(clock), counters);
    const first = fakeBinding();
    const url = await freezeUnder(swapper, first, "frame-a", counters, clock);
    expect(url).toBeTruthy();
    expect(encodedAreas.length).toBe(1);

    // The surface goes away — the pixels do not. This is the case `disposeStaticImage` used to
    // revoke outright, on an argument that only ever held for an owner-bound still.
    swapper.detach(first);
    expect(revokedUrls).toEqual([]);
    expect(liveStaticImageUrlCount()).toBe(1);
    expect(hasStaticStill("frame-a")).toBe(true);
    expect(staticStillPoolStats().entries).toBe(1);

    const second = fakeBinding();
    swapper.attach(second);
    expect(claimStaticStill(second, "frame-a", counters)).toBe(true);
    await flush();
    expect(srcOf(second)).toBe(url);
    expect(encodedAreas.length).toBe(1); // and NOT a second readback
    expect(staticStillPoolStats().entries).toBe(0); // it has a holder again
    swapper.dispose();
  });

  it("never retains a KEYLESS surface's private still — no lookup could ever reach it", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(retaining(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding);
    await clock.advance(1001);
    const url = srcOf(binding);
    expect(url).toBeTruthy();

    swapper.detach(binding);
    expect(revokedUrls).toEqual([url]);
    expect(staticStillPoolStats().entries).toBe(0);
    expect(liveStaticImageUrlCount()).toBe(0);
    swapper.dispose();
  });

  it("evicts least-recently-pooled first across PARKED and RETAINED stills on ONE shared budget", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    blobFor = () => new Blob(["0123456789"], { type: "image/png" }); // 10 bytes each
    // 10 + 15 = a 25-byte pool: room for two stills of either kind, and the third must throw the
    // oldest out whichever kind IT is.
    const swapper = makeSwapper(
      retaining(clock, { parkedStillBytes: 10, stillCacheBytes: 15 }),
      counters,
    );
    const a = fakeBinding(2, 2);
    const b = fakeBinding(4, 2);
    const keyless = fakeBinding(6, 2);
    const urlA = await freezeUnder(swapper, a, "frame-a", counters, clock);
    const urlB = await freezeUnder(swapper, b, "frame-b", counters, clock);
    swapper.attach(keyless);
    await clock.advance(1001);
    expect(encodedAreas.length).toBe(3);

    swapper.detach(a); // retained, pooled first
    swapper.detach(b); // retained
    expect(staticStillPoolStats()).toEqual({ entries: 2, bytes: 20 });

    // A PARK now takes the pool to 30 against a 25-byte budget — and the walk is over both kinds, so
    // what goes is the oldest entry, which happens to be a RETAINED one.
    swapper.invalidate([keyless]);
    expect(revokedUrls).toEqual([urlA]);
    expect(hasStaticStill("frame-a")).toBe(false);
    expect(hasStaticStill("frame-b")).toBe(true);
    expect(staticStillPoolStats()).toEqual({ entries: 2, bytes: 20 });

    // The evicted key really is gone: a claim for it misses, while its neighbour still hits.
    const fresh = fakeBinding(2, 2);
    swapper.attach(fresh);
    expect(claimStaticStill(fresh, "frame-a", counters)).toBe(false);
    expect(counters.staticStillCacheMisses).toBe(1);
    expect(claimStaticStill(fresh, "frame-b", counters)).toBe(true);
    expect(srcOf(fresh) ?? (await flush().then(() => srcOf(fresh)))).toBe(urlB);
    swapper.dispose();
  });

  it("comes back to ZERO live URLs when the last swapper disposes, retained entries included", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(retaining(clock), counters);
    const a = fakeBinding();
    const b = fakeBinding();
    await freezeUnder(swapper, a, "frame-a", counters, clock);
    await freezeUnder(swapper, b, "frame-b", counters, clock);
    swapper.detach(a);
    swapper.detach(b);
    expect(liveStaticImageUrlCount()).toBe(2); // both retained: the bytes are still pinned

    swapper.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
    expect(staticStillPoolStats()).toEqual({ entries: 0, bytes: 0 });
    expect(hasStaticStill("frame-a")).toBe(false);
  });

  it("`stillCacheBytes` unset (the default) revokes on the last release, exactly as before", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "quiet-window", quietMs: 1000, keyedQuietMs: 0 },
        encode: { slice: 8, intervalMs: 100 },
      },
      counters,
    );
    const binding = fakeBinding();
    const url = await freezeUnder(swapper, binding, "frame-a", counters, clock);

    swapper.detach(binding);
    expect(revokedUrls).toEqual([url]);
    expect(hasStaticStill("frame-a")).toBe(false);
    expect(staticStillPoolStats().entries).toBe(0);
    swapper.dispose();
  });
});

// ---- claiming a still ----------------------------------------------------------------------------

describe("surface image swap — claiming a still (claimStaticStill)", () => {
  const claiming = (
    clock: Clock,
    over: Partial<StaticSurfacePolicy> = {},
  ): StaticSurfacePolicy => ({
    ...seams(clock),
    gate: { kind: "quiet-window", quietMs: 1000, keyedQuietMs: 0 },
    encode: { slice: 8, intervalMs: 100, stillCacheBytes: 1 << 20 },
    ...over,
  });

  const srcOf = (binding: StaticImageSwapBinding): string | null =>
    standIn(binding)?.getAttribute("src") ?? null;

  /** A surface that earns a still for `key` and is then torn down, leaving the entry retained. */
  async function bankStill(
    swapper: StaticSurfaceSwapper,
    key: string,
    counters: StaticImageSwapCounters,
    clock: Clock,
  ): Promise<string | null> {
    const donor = fakeBinding();
    swapper.attach(donor);
    noteStaticFrame(donor, key, counters);
    await clock.advance(2);
    const url = srcOf(donor);
    swapper.detach(donor);
    return url;
  }

  it("mounts straight as <img>: no gate, no paint, no encode", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(claiming(clock), counters);
    const url = await bankStill(swapper, "frame-a", counters, clock);
    const encodesSoFar = encodedAreas.length;

    const binding = fakeBinding();
    swapper.attach(binding);
    expect(claimStaticStill(binding, "frame-a", counters)).toBe(true);
    await flush();

    expect(srcOf(binding)).toBe(url);
    expect(binding.canvas.style.display).toBe("none");
    expect(encodedAreas.length).toBe(encodesSoFar); // nothing was read back
    expect(counters.staticStillCacheHits).toBe(1);
    expect(counters.staticStillMounts).toBe(1);
    expect(counters.staticImagesLive).toBe(1);
    // Two swaps: the donor earned one the long way, this one took it. ONE encode between them, and
    // this surface never reported a paint at all.
    expect(counters.staticImageSwaps).toBe(2);
    expect(counters.staticImageEncodes).toBe(1);
    swapper.dispose();
  });

  it("misses for an unknown key, mutating nothing but the miss counter", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(claiming(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding);

    expect(claimStaticStill(binding, "never-encoded", counters)).toBe(false);
    await flush();
    expect(standIn(binding)).toBeNull();
    expect(binding.canvas.style.display).toBe("");
    expect(counters.staticStillCacheMisses).toBe(1);
    expect(counters.staticStillCacheHits).toBe(0);
    expect(counters.staticImagesLive).toBe(0);

    // …and the surface can still earn its swap the ordinary way afterwards.
    noteStaticFrame(binding, "frame-a", counters);
    await clock.advance(2);
    expect(standIn(binding)).toBeTruthy();
    swapper.dispose();
  });

  it("books nothing at all when the mechanism is off for that surface", () => {
    const counters = createStaticImageSwapCounters();
    const unattached = fakeBinding(); // never handed to a swapper: no swap state
    expect(claimStaticStill(unattached, "frame-a", counters)).toBe(false);
    expect(counters.staticStillCacheMisses).toBe(0);
    expect(counters.staticStillCacheHits).toBe(0);
  });

  it("refuses a surface that is already engaged rather than stacking a second stand-in", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(claiming(clock), counters);
    await bankStill(swapper, "frame-a", counters, clock);
    const binding = fakeBinding();
    swapper.attach(binding);
    noteStaticFrame(binding, "frame-b", counters);
    await clock.advance(2);
    expect(standIn(binding)).toBeTruthy();
    const url = srcOf(binding);

    expect(claimStaticStill(binding, "frame-a", counters)).toBe(false);
    await flush();
    expect(srcOf(binding)).toBe(url);
    expect(
      binding.canvas.parentElement?.querySelectorAll(
        `[${STATIC_SURFACE_IMAGE_ATTR}]`,
      ).length,
    ).toBe(1);
    swapper.dispose();
  });

  it("a claimed surface's first REAL sizing trips the watchdog, and the host hears it on onRevert", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const reverted: StaticImageSwapBinding[] = [];
    const swapper = makeSwapper(
      claiming(clock, {
        watchdogMs: 500,
        onRevert: (binding) => reverted.push(binding),
      }),
      counters,
    );
    await bankStill(swapper, "frame-a", counters, clock);
    const binding = fakeBinding(8, 4);
    swapper.attach(binding);
    expect(claimStaticStill(binding, "frame-a", counters)).toBe(true);
    await flush();
    expect(standIn(binding)).toBeTruthy();
    expect(reverted).toEqual([]);

    // The claim froze the UNPAINTED values (this canvas has never drawn anything), so the first time
    // it is really allocated the watchdog sees a re-allocation it cannot explain. That is correct:
    // a freshly allocated canvas is blank, and the `<img>` over it is showing pixels nothing under it
    // can vouch for any more.
    binding.canvas.width = 16;
    await clock.advance(600);

    expect(standIn(binding)).toBeNull();
    expect(binding.canvas.style.display).toBe("");
    expect(counters.staticImageRevertsByCause.watchdog).toBe(1);
    expect(reverted).toEqual([binding]);
    swapper.dispose();
  });

  it("calls onRevert for a HOST invalidate too — it is per revert, not per cause", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const reverted: StaticImageSwapBinding[] = [];
    const swapper = makeSwapper(
      claiming(clock, { onRevert: (binding) => reverted.push(binding) }),
      counters,
    );
    const binding = fakeBinding();
    swapper.attach(binding);
    noteStaticFrame(binding, "frame-a", counters);
    await clock.advance(2);
    expect(standIn(binding)).toBeTruthy();

    swapper.invalidate();
    expect(reverted).toEqual([binding]);
    expect(counters.staticImageRevertsByCause["host-invalidate"]).toBe(1);
    swapper.dispose();
  });

  it("swallows a throwing onRevert rather than leaving a surface half-reverted", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      claiming(clock, {
        onRevert: () => {
          throw new Error("host bug");
        },
      }),
      counters,
    );
    const binding = fakeBinding();
    swapper.attach(binding);
    noteStaticFrame(binding, "frame-a", counters);
    await clock.advance(2);
    expect(standIn(binding)).toBeTruthy();

    expect(() => swapper.invalidate()).not.toThrow();
    expect(standIn(binding)).toBeNull();
    expect(binding.canvas.style.display).toBe("");
    swapper.dispose();
  });
});

// ---- baking a still -------------------------------------------------------------------------------

describe("surface image swap — baking a still (bakeStill / queueLength)", () => {
  const baking = (
    clock: Clock,
    encode: Record<string, unknown> = {},
  ): StaticSurfacePolicy => ({
    ...seams(clock),
    gate: { kind: "quiet-window", quietMs: 1000, keyedQuietMs: 0 },
    encode: { slice: 8, intervalMs: 100, stillCacheBytes: 1 << 20, ...encode },
  });

  /** A canvas with pixels and NO parent — the shape of a surface on its way out, which is exactly
   *  what a bake is for (and what the ordinary freeze path refuses). */
  function detachedCanvas(width = 8, height = 4): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  it("publishes an entry held by NOBODY, retained and claimable", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(baking(clock), counters);
    const settled: boolean[] = [];

    swapper.bakeStill(
      { canvas: detachedCanvas() },
      "frame-a",
      counters,
      (published) => settled.push(published),
    );
    await flush();

    expect(settled).toEqual([true]);
    expect(counters.staticStillBakes).toBe(1);
    expect(counters.staticImageEncodes).toBe(1);
    expect(encodedAreas).toEqual([8 * 4]);
    expect(hasStaticStill("frame-a")).toBe(true);
    expect(staticStillPoolStats().entries).toBe(1);
    expect(liveStaticImageUrlCount()).toBe(1);
    // Nothing was SHOWN — the bake is pixels in the bank, not a swap.
    expect(counters.staticImageSwaps).toBe(0);
    expect(counters.staticImagesLive).toBe(0);

    const binding = fakeBinding();
    swapper.attach(binding);
    expect(claimStaticStill(binding, "frame-a", counters)).toBe(true);
    await flush();
    expect(standIn(binding)).toBeTruthy();
    expect(encodedAreas.length).toBe(1); // the claim read nothing back
    swapper.dispose();
  });

  it("is a NO-OP for a key that is already known, in any state", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(baking(clock), counters);
    swapper.bakeStill({ canvas: detachedCanvas() }, "frame-a", counters);
    await flush();
    expect(counters.staticStillBakes).toBe(1);

    // Retained (the state it was just published into).
    const settled: boolean[] = [];
    swapper.bakeStill(
      { canvas: detachedCanvas() },
      "frame-a",
      counters,
      (published) => settled.push(published),
    );
    await flush();
    expect(settled).toEqual([false]);
    expect(counters.staticStillBakes).toBe(1);
    expect(encodedAreas.length).toBe(1);

    // LIVE (a surface is showing it): still a no-op, and emphatically so — a second encode would
    // orphan the URL the `<img>` is pointing at.
    const binding = fakeBinding();
    swapper.attach(binding);
    claimStaticStill(binding, "frame-a", counters);
    await flush();
    swapper.bakeStill({ canvas: detachedCanvas() }, "frame-a", counters);
    await flush();
    expect(counters.staticStillBakes).toBe(1);
    expect(encodedAreas.length).toBe(1);
    swapper.dispose();
  });

  it("is a no-op with retention OFF — a bake with nowhere to live is just a readback", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      {
        ...seams(clock),
        gate: { kind: "quiet-window", quietMs: 1000 },
        encode: { slice: 8, intervalMs: 100 },
      },
      counters,
    );
    const settled: boolean[] = [];
    swapper.bakeStill(
      { canvas: detachedCanvas() },
      "frame-a",
      counters,
      (published) => settled.push(published),
    );
    await flush();
    expect(settled).toEqual([false]);
    expect(counters.staticStillBakes).toBe(0);
    expect(encodedAreas).toEqual([]);
    expect(hasStaticStill("frame-a")).toBe(false);
    swapper.dispose();
  });

  it("leaves the key OPEN when the bake fails, rather than poisoning it for real surfaces", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(baking(clock), counters);
    blobFor = () => null; // the readback produced nothing
    const settled: boolean[] = [];
    swapper.bakeStill(
      { canvas: detachedCanvas() },
      "frame-a",
      counters,
      (published) => settled.push(published),
    );
    await flush();
    expect(settled).toEqual([false]);
    expect(counters.staticImageFailures).toBe(1);
    expect(hasStaticStill("frame-a")).toBe(false);

    // A SURFACE that wants the same key is unaffected by the speculative failure.
    blobFor = () => new Blob(["frame"], { type: "image/png" });
    const binding = fakeBinding();
    swapper.attach(binding);
    noteStaticFrame(binding, "frame-a", counters);
    await clock.advance(2);
    expect(standIn(binding)).toBeTruthy();
    swapper.dispose();
  });

  it("queueLength() is how a host holds a speculative bake behind live candidates", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    // One encode per window, so a burst of surfaces really does queue.
    const swapper = makeSwapper(
      baking(clock, { slice: 1, intervalMs: 1000 }),
      counters,
    );
    const bindings = [fakeBinding(2, 2), fakeBinding(4, 2), fakeBinding(6, 2)];
    for (const binding of bindings) swapper.attach(binding);
    await clock.advance(1001);

    // The head encoded inline; the rest are waiting on the pacing — a bake now would compete with
    // them for the same slice budget.
    expect(swapper.queueLength()).toBe(2);
    expect(encodedAreas.length).toBe(1);

    await clock.advance(2100);
    expect(swapper.queueLength()).toBe(0);
    expect(encodedAreas.length).toBe(3);

    // Drained: the host spends its readback on pixels nobody is waiting for.
    swapper.bakeStill({ canvas: detachedCanvas(3, 3) }, "frame-a", counters);
    await clock.advance(1001);
    expect(hasStaticStill("frame-a")).toBe(true);
    swapper.dispose();
  });
});

// ---- priming unseen keys --------------------------------------------------------------------------
//
// The deferral apparatus is a judgement about BIG surfaces (a ~290 ms readback whose instant is the
// whole cost). For a fleet of small ones collapsing to a couple of distinct keys, holding the one
// encode a key will ever need buys no park back and leaves the whole fleet in the composite. So the
// FIRST encode of a key may skip the deferral check — and nothing else about the pacing moves.

describe("surface image swap — priming unseen keys (encode.primeUnseenKeys)", () => {
  const stuckBusy = (
    clock: Clock,
    encode: Record<string, unknown> = {},
  ): StaticSurfacePolicy => ({
    ...seams(clock),
    gate: { kind: "quiet-window", quietMs: 1000, keyedQuietMs: 0 },
    encode: {
      slice: 4,
      intervalMs: 100,
      // A host that is busy and stays busy — the pathological case both directions are read against.
      busy: () => true,
      busyMaxDeferMs: 100000,
      ...encode,
    },
  });

  it("encodes an UNSEEN key against a busy predicate that never clears, and defers a seen one", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      stuckBusy(clock, { primeUnseenKeys: true }),
      counters,
    );
    const first = fakeBinding();
    swapper.attach(first);
    noteStaticFrame(first, "frame-a", counters);
    await clock.advance(2);

    expect(standIn(first)).toBeTruthy();
    expect(counters.staticImageEncodes).toBe(1);
    expect(counters.staticImageBusyDeferrals).toBe(0);

    // Take the entry away (no retention here), so the next surface on that key has to encode it
    // again — and this time the key is one this document HAS encoded, so the exemption is spent.
    swapper.detach(first);
    const second = fakeBinding();
    swapper.attach(second);
    noteStaticFrame(second, "frame-a", counters);
    await clock.advance(2);

    expect(standIn(second)).toBeNull();
    expect(counters.staticImageEncodes).toBe(1);
    expect(counters.staticImageBusyDeferrals).toBeGreaterThan(0);
    swapper.dispose();
  });

  it("OFF (the default) defers the very same first encode", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(stuckBusy(clock), counters);
    const binding = fakeBinding();
    swapper.attach(binding);
    noteStaticFrame(binding, "frame-a", counters);
    await clock.advance(2);

    expect(standIn(binding)).toBeNull();
    expect(counters.staticImageEncodes).toBe(0);
    expect(counters.staticImageBusyDeferrals).toBeGreaterThan(0);
    swapper.dispose();
  });

  it("bypasses WHEN, never HOW MANY — the slice budget still binds", async () => {
    const clock = scheduler();
    const counters = createStaticImageSwapCounters();
    const swapper = makeSwapper(
      stuckBusy(clock, { primeUnseenKeys: true, slice: 1, intervalMs: 1000 }),
      counters,
    );
    const bindings = [fakeBinding(2, 2), fakeBinding(4, 2), fakeBinding(6, 2)];
    bindings.forEach((binding, index) => {
      swapper.attach(binding);
      noteStaticFrame(binding, `frame-${index}`, counters);
    });

    // Three unseen keys, every one of them exempt from the deferral — and still exactly one encode,
    // because the exemption never touches the window budget.
    await clock.advance(2);
    expect(counters.staticImageEncodes).toBe(1);
    await clock.advance(1001);
    expect(counters.staticImageEncodes).toBe(2);
    swapper.dispose();
  });
});
