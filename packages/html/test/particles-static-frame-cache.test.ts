// jsdom (gsw default env).
//
// The FROZEN-particle static-frame cache (`src/particles/static-frame-cache.ts`) — the particle
// sibling of the shader runtime's `staticFrameCache`. In `staticParticles` mode a system is warmed
// once, drawn once and parked forever, and the CPU simulation under `src/particles/` is fully
// deterministic (a seeded MINSTD LCG; no `Math.random`, no `Date.now`, no `performance.now`
// anywhere in that directory), so two systems built from the same spec ALREADY paint the same
// pixels. The cache collapses them to one warm + one instanced draw + N blits.
//
// Two layers are covered here:
//   * the pure key/LRU module — every key component, the eviction cap, the pixel budget;
//   * the runtime wiring — hits skip BOTH the warm and the draw, `cacheHits` counts them, the
//     cache survives `dispose()`, a mid-flight (non-pristine) freeze is never cached, and the warm
//     a hit skipped is paid back before live simulation resumes.
//
// jsdom has no real 2D raster (no `canvas` npm package), so a canvas's PIXELS are modelled as one
// token string: `drawImage` copies the source's token, `clearRect` clears it. That is enough to
// prove WHICH bitmap a node canvas ends up carrying — the fidelity claim this cache lives or dies
// on — because the token of the shared GL canvas can be poisoned between phases.

import {
  createParticleState,
  InstanceBuffer,
  preprocessParticles,
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
  vi,
} from "vitest";
import { createParticleRuntime } from "../src/particles/runtime";
import {
  __resetStaticParticleFrameCacheForTest,
  __staticParticleFrameCacheStatsForTest,
  getStaticParticleFrame,
  particleStaticFrameKey,
  particleStaticFrameKeyBase,
  storeStaticParticleFrame,
} from "../src/particles/static-frame-cache";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { __resetSharedForTest, getShared } from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

/** Instance floats of every `drawParticles` call this tick, in call order (copied — the buffer is reused). */
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

/** The token each canvas currently "contains". Absent = never painted. */
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
  HTMLCanvasElement.prototype.getContext = function (
    this: object,
    kind: string,
  ) {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return fake2d(this);
    return null;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
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
  __resetStaticParticleFrameCacheForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  rafQueue = [];
  drawnInstances = [];
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ---- fixtures ----------------------------------------------------------------------------------

const staticOptions = { enableParticles: true, staticParticles: true } as never;
const liveOptions = { enableParticles: true } as never;

// blendMode 0 (non-additive) so the draw path never reaches the additive accumulator FBO under the
// fake GL — the same constraint the other particle runtime tests work under.
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
  // The host's `data-godot-particle-visible-rect` ("x,y,width,height" in the node's own local px
  // space), or null for a host that stamps none. It bounds the canvas MARGIN, so it is a geometry
  // input to the frozen frame exactly like the box size is — see the last describe block.
  visibleRect: string | null = null,
): { node: HTMLElement; self: HTMLElement } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", specJson);
  if (visibleRect !== null) {
    node.setAttribute("data-godot-particle-visible-rect", visibleRect);
  }
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

/** Paint the SHARED GL canvas — the source `drawBinding` blits from — with a recognisable token. */
function paintSharedCanvas(token: string): void {
  const shared = getShared();
  if (!shared) throw new Error("no shared GL");
  paint(shared.canvas, token);
}

// ---- the determinism the whole mechanism rests on ----------------------------------------------

describe("particle simulation determinism (the cache's premise)", () => {
  function warmed(over: Record<string, unknown> = {}) {
    const state = createParticleState(
      normalizeParticleConfig({
        amount: 24,
        lifetime: 1,
        emitting: true,
        initialVelocityMin: 40,
        initialVelocityMax: 90,
        spread: 180,
        angularVelocityMin: -90,
        angularVelocityMax: 90,
        scaleMin: 0.5,
        scaleMax: 1.5,
        lifetimeRandomness: 0.5,
        randomness: 0.7,
        ...over,
      }),
      2048,
    );
    preprocessParticles(state);
    warmStaticParticles(state);
    return state;
  }

  it("two states built from the same config warm to a BIT-IDENTICAL particle set", () => {
    // If this ever fails, the cache is unsound at its root: two twins would not be pixel-identical
    // and no key could fix it. (It also covers `randomness`/`lifetimeRandomness`, the fields most
    // likely to reach for a real RNG.)
    const a = warmed();
    const b = warmed();
    expect(b.particles).toEqual(a.particles);
    expect(b.time).toBe(a.time);
    expect(b.cycle).toBe(a.cycle);
    expect(b.emitting).toBe(a.emitting);
  });

  it("and therefore to a bit-identical packed INSTANCE BUFFER (what the GL draw consumes)", () => {
    const pack = (state: ReturnType<typeof warmed>) => {
      const buffer = new InstanceBuffer();
      for (const p of state.particles) {
        if (!p.active || p.a <= 0) continue;
        buffer.push(
          p.x,
          p.y,
          p.scaleX,
          p.scaleY,
          p.rotation,
          p.r,
          p.g,
          p.b,
          p.a,
          p.frame,
        );
      }
      return Array.from(buffer.data.slice(0, buffer.count * 10));
    };
    const a = pack(warmed());
    const b = pack(warmed());
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it("a different SEED produces a different particle set (so seeds must split the cache)", () => {
    const a = warmed({ seed: 1 });
    const b = warmed({ seed: 7 });
    expect(b.particles).not.toEqual(a.particles);
  });
});

// ---- the pure key ------------------------------------------------------------------------------

describe("particleStaticFrameKey", () => {
  const base = {
    specJson: '{"amount":8}',
    count: 8,
    blendMode: 0,
    seed: 0,
    textureUrl: null as string | null,
    maskUrl: null as string | null,
  };
  const geometry = {
    width: 240,
    height: 240,
    drawRatio: 2,
    padX: 20,
    padY: 20,
    frameW: 16,
    frameH: 16,
    textureWidth: 0,
    textureHeight: 0,
  };
  const key = (
    baseOver: Partial<typeof base> = {},
    geomOver: Partial<typeof geometry> = {},
  ) =>
    particleStaticFrameKey(
      particleStaticFrameKeyBase({ ...base, ...baseOver }),
      {
        ...geometry,
        ...geomOver,
      },
    );

  it("is stable for identical inputs", () => {
    expect(key()).toBe(key());
  });

  it("has the documented format", () => {
    expect(key()).toBe(
      '12:{"amount":8}|n8|b0|s0|t-1:|k-1:|240x240|r2|p20x20|f16x16|@0x0',
    );
  });

  // Every component, one at a time — the "any single key component differing ⇒ miss" contract.
  const baseVariants: Array<[string, Partial<typeof base>]> = [
    ["specJson", { specJson: '{"amount":9}' }],
    ["count (the maxInstances clamp)", { count: 7 }],
    ["blendMode", { blendMode: 1 }],
    ["seed", { seed: 1 }],
    ["textureUrl", { textureUrl: "a.png" }],
    ["maskUrl", { maskUrl: "m.png" }],
  ];
  const geometryVariants: Array<[string, Partial<typeof geometry>]> = [
    ["width", { width: 241 }],
    ["height", { height: 241 }],
    ["drawRatio", { drawRatio: 2.01 }],
    ["padX (the draw's x origin)", { padX: 21 }],
    // The DIRECTIONAL half: a burst that rises 60px and falls 500 has the same left/right margin as
    // one that rises 500 and falls 60, and they are not the same picture.
    ["padY (the draw's y origin)", { padY: 21 }],
    ["frameW", { frameW: 17 }],
    ["frameH", { frameH: 17 }],
    ["textureWidth", { textureWidth: 1 }],
    ["textureHeight", { textureHeight: 1 }],
  ];
  for (const [name, over] of baseVariants) {
    it(`splits on ${name}`, () => expect(key(over)).not.toBe(key()));
  }
  for (const [name, over] of geometryVariants) {
    it(`splits on ${name}`, () => expect(key({}, over)).not.toBe(key()));
  }

  it("keeps GEOMETRY exact — a sub-1% drawRatio delta is NOT quantized away", () => {
    // The shader key's widened-background precedent: quantizing a geometry term lets a frame cached
    // under one layout be served for another, i.e. the wrong pixels.
    expect(key({}, { drawRatio: 2.0001 })).not.toBe(key());
    expect(key({}, { padX: 20.5 })).not.toBe(key());
    expect(key({}, { padY: 20.5 })).not.toBe(key());
  });

  it("a host string cannot impersonate the fields after it (length-prefixed)", () => {
    // Without the length prefix this spec, whose text ENDS with what the next fields look like,
    // would collide with the default key.
    const evil = '{"amount":8}|n8|b0|s0|t-1:|k-1:';
    expect(key({ specJson: evil })).not.toBe(key());
    // Same trap through the two URL fields.
    expect(key({ textureUrl: "a|k-1:", maskUrl: null })).not.toBe(
      key({ textureUrl: "a", maskUrl: null }),
    );
  });
});

// ---- LRU + budget ------------------------------------------------------------------------------

function makeCanvas(w: number, h: number, token: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  paint(canvas, token);
  return canvas;
}

describe("static-frame cache — LRU + budget", () => {
  it("stores a COPY, so a later repaint of the source cannot corrupt the cached frame", () => {
    const source = makeCanvas(4, 4, "ORIGINAL");
    storeStaticParticleFrame("k", source, 4, 4);
    paint(source, "REPAINTED");
    expect(pixelsOf(getStaticParticleFrame("k") as object)).toBe("ORIGINAL");
  });

  it("evicts the least-recently-USED entry past the 64-entry cap", () => {
    for (let i = 0; i < 64; i += 1) {
      storeStaticParticleFrame(`k${i}`, makeCanvas(4, 4, `f${i}`), 4, 4);
    }
    expect(__staticParticleFrameCacheStatsForTest().entries).toBe(64);
    // Touch the oldest so it is no longer the LRU victim.
    expect(getStaticParticleFrame("k0")).toBeDefined();
    storeStaticParticleFrame("k64", makeCanvas(4, 4, "f64"), 4, 4);
    expect(__staticParticleFrameCacheStatsForTest().entries).toBe(64);
    expect(getStaticParticleFrame("k0")).toBeDefined(); // bumped by the read → survived
    expect(getStaticParticleFrame("k1")).toBeUndefined(); // the new LRU victim
    expect(getStaticParticleFrame("k64")).toBeDefined();
  });

  it("also evicts on the TOTAL-PIXEL budget (a fleet of huge ambient canvases)", () => {
    // 2048x2048 = 4,194,304 px; the budget is 16,777,216 px, so the 5th entry evicts the 1st even
    // though the entry count is nowhere near 64.
    for (let i = 0; i < 4; i += 1) {
      storeStaticParticleFrame(
        `big${i}`,
        makeCanvas(2048, 2048, `b${i}`),
        2048,
        2048,
      );
    }
    expect(__staticParticleFrameCacheStatsForTest().entries).toBe(4);
    storeStaticParticleFrame("big4", makeCanvas(2048, 2048, "b4"), 2048, 2048);
    const stats = __staticParticleFrameCacheStatsForTest();
    expect(stats.entries).toBe(4);
    expect(stats.pixels).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(getStaticParticleFrame("big0")).toBeUndefined();
    expect(getStaticParticleFrame("big4")).toBeDefined();
  });

  it("refuses a single frame bigger than the whole budget (never evicts everything for one)", () => {
    storeStaticParticleFrame("small", makeCanvas(4, 4, "s"), 4, 4);
    storeStaticParticleFrame("giant", makeCanvas(4096, 8192, "g"), 4096, 8192);
    expect(getStaticParticleFrame("giant")).toBeUndefined();
    expect(getStaticParticleFrame("small")).toBeDefined();
  });

  it("a re-store BUMPS the key to most-recently-used (Map.set alone would not)", () => {
    // `Map.set` on an existing key keeps its original slot, so without an explicit delete the
    // freshest frame would stay at the LRU front and be the next thing evicted.
    for (let i = 0; i < 64; i += 1) {
      storeStaticParticleFrame(`k${i}`, makeCanvas(4, 4, `f${i}`), 4, 4);
    }
    storeStaticParticleFrame("k0", makeCanvas(4, 4, "f0-again"), 4, 4); // re-store the oldest
    storeStaticParticleFrame("k64", makeCanvas(4, 4, "f64"), 4, 4); // forces one eviction
    expect(getStaticParticleFrame("k0")).toBeDefined(); // survived: the re-store bumped it
    expect(getStaticParticleFrame("k1")).toBeUndefined(); // evicted instead
  });

  it("a re-store under the SAME key replaces (and re-books) instead of double-counting", () => {
    storeStaticParticleFrame("k", makeCanvas(10, 10, "one"), 10, 10);
    storeStaticParticleFrame("k", makeCanvas(10, 10, "two"), 10, 10);
    const stats = __staticParticleFrameCacheStatsForTest();
    expect(stats.entries).toBe(1);
    expect(stats.pixels).toBe(100);
    expect(pixelsOf(getStaticParticleFrame("k") as object)).toBe("two");
  });
});

// ---- the runtime wiring ------------------------------------------------------------------------

describe("particle runtime — frozen static-frame cache", () => {
  it("a twin blits the FIRST system's bitmap: no second warm, no second draw", () => {
    const root = document.createElement("div");
    const a = particleNode(spec());
    root.appendChild(a.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("FRAME-A");
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().cacheHits).toBe(0);
    expect(pixelsOf(canvasIn(a.self))).toBe("FRAME-A");
    const drawnForA = drawnInstances;
    expect(drawnForA.length).toBe(1);

    // POISON the shared GL canvas: anything that re-draws from here on paints "FRAME-B". A twin
    // that comes out "FRAME-A" can only have got it from the cache.
    paintSharedCanvas("FRAME-B");
    drawnInstances = [];
    const b = particleNode(spec());
    root.appendChild(b.node);
    rt.reconcile();
    flushRaf();

    expect(pixelsOf(canvasIn(b.self))).toBe("FRAME-A");
    expect(drawnInstances).toEqual([]); // no instanced draw at all this tick
    expect(rt.stats().draws).toBe(1); // still the ONE draw from the first tick
    // Two hits: the twin, plus the already-frozen first binding re-blitting its own cached frame
    // (which used to cost a full re-draw on every static wake).
    expect(rt.stats().cacheHits).toBe(2);
    rt.dispose();
  });

  it("N identical frozen systems cost 1 draw + (N-1) hits", () => {
    const root = document.createElement("div");
    const nodes = Array.from({ length: 5 }, () => particleNode(spec()));
    for (const n of nodes) root.appendChild(n.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("FLEET");
    flushRaf();

    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().cacheHits).toBe(4);
    for (const n of nodes) expect(pixelsOf(canvasIn(n.self))).toBe("FLEET");
    rt.dispose();
  });

  it("survives dispose(): a NEW runtime reuses the frame the old one rendered", () => {
    const rootA = document.createElement("div");
    const a = particleNode(spec());
    rootA.appendChild(a.node);
    document.body.appendChild(rootA);
    const rtA = createParticleRuntime(rootA, staticOptions);
    rtA.reconcile();
    paintSharedCanvas("FIRST-RUNTIME");
    flushRaf();
    expect(rtA.stats().draws).toBe(1);
    rtA.dispose();

    paintSharedCanvas("SECOND-RUNTIME"); // poison again
    const rootB = document.createElement("div");
    const b = particleNode(spec());
    rootB.appendChild(b.node);
    document.body.appendChild(rootB);
    const rtB = createParticleRuntime(rootB, staticOptions);
    rtB.reconcile();
    flushRaf();

    expect(rtB.stats().draws).toBe(0); // nothing re-rendered
    expect(rtB.stats().cacheHits).toBe(1);
    expect(pixelsOf(canvasIn(b.self))).toBe("FIRST-RUNTIME");
    rtB.dispose();
  });

  it("a different SEED splits the cache (both systems render)", () => {
    const root = document.createElement("div");
    const a = particleNode(spec({ seed: 1 }));
    const b = particleNode(spec({ seed: 2 }));
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("X");
    flushRaf();

    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().cacheHits).toBe(0);
    // …and they really are different pictures, not just different keys.
    expect(drawnInstances.length).toBe(2);
    expect(drawnInstances[1]).not.toEqual(drawnInstances[0]);
    rt.dispose();
  });

  it("a different SPEC splits the cache", () => {
    const root = document.createElement("div");
    root.appendChild(particleNode(spec()).node);
    root.appendChild(particleNode(spec({ lifetime: 2 })).node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("X");
    flushRaf();
    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().cacheHits).toBe(0);
    rt.dispose();
  });

  it("a different CANVAS SIZE splits the cache (same spec, different node box)", () => {
    const root = document.createElement("div");
    root.appendChild(particleNode(spec(), 100).node);
    root.appendChild(particleNode(spec(), 180).node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("X");
    flushRaf();
    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().cacheHits).toBe(0);
    rt.dispose();
  });

  it("a different particleMaxInstances clamp splits the cache across runtimes", () => {
    // The clamp is a per-RUNTIME option and the cache is module-scoped: same spec, different
    // effective particle count ⇒ a different picture, so it must not alias.
    const mount = (max: number) => {
      const root = document.createElement("div");
      const n = particleNode(spec({ amount: 64 }));
      root.appendChild(n.node);
      document.body.appendChild(root);
      const rt = createParticleRuntime(root, {
        enableParticles: true,
        staticParticles: true,
        particleMaxInstances: max,
      } as never);
      rt.reconcile();
      flushRaf();
      return rt;
    };
    paintSharedCanvas("X");
    const rtA = mount(64);
    const rtB = mount(16);
    expect(rtA.stats().draws).toBe(1);
    expect(rtB.stats().draws).toBe(1); // NOT a hit on rtA's frame
    expect(rtB.stats().cacheHits).toBe(0);
    rtA.dispose();
    rtB.dispose();
  });

  it("a MID-FLIGHT freeze is never cached (its warm is not a function of the spec)", () => {
    // Live first, so the sim state carries a wall-clock-dependent phase; `setStaticParticles(true)`
    // then warms from THERE. Two such nodes are not twins, so nothing may be shared.
    const root = document.createElement("div");
    const a = particleNode(spec());
    const b = particleNode(spec());
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, liveOptions);
    rt.reconcile();
    paintSharedCanvas("LIVE");
    flushRaf(); // one live step → both bindings are no longer pristine
    // (a first step at dt≈0 has nothing alive yet, so it may or may not have drawn — irrelevant here)
    const liveDraws = rt.stats().draws;

    rt.setStaticParticles(true);
    flushRaf();
    expect(rt.stats().cacheHits).toBe(0);
    expect(rt.stats().draws).toBe(liveDraws + 2); // BOTH re-rendered
    expect(__staticParticleFrameCacheStatsForTest().entries).toBe(0); // and nothing was published
    rt.dispose();
  });

  it("unfreezing pays back the warm a cache hit skipped (no resume pop)", () => {
    // Binding A renders + publishes; binding B takes the hit and never warms. On resume both must
    // simulate from the SAME state — which only holds if B's skipped warm is paid back.
    const root = document.createElement("div");
    const a = particleNode(spec());
    const b = particleNode(spec());
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("FROZEN");
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().cacheHits).toBe(1); // B never warmed

    drawnInstances = [];
    rt.setStaticParticles(false);
    flushRaf(); // one live tick: both bindings simulate + draw

    expect(drawnInstances.length).toBe(2);
    expect(drawnInstances[0].length).toBeGreaterThan(0);
    expect(drawnInstances[1]).toEqual(drawnInstances[0]);
    rt.dispose();
  });

  it("re-entering frozen mode after a live run does not serve the pre-live frame", () => {
    const root = document.createElement("div");
    const a = particleNode(spec());
    root.appendChild(a.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("FROZEN-1");
    flushRaf();
    expect(rt.stats().draws).toBe(1);

    rt.setStaticParticles(false);
    flushRaf(); // live: the binding stops being pristine
    rt.setStaticParticles(true);
    paintSharedCanvas("FROZEN-2");
    flushRaf();

    // Re-rendered from the live state, NOT served the stale pristine frame.
    expect(pixelsOf(canvasIn(a.self))).toBe("FROZEN-2");
    rt.dispose();
  });

  it("dynamic (non-frozen) mode never consults or fills the cache", () => {
    const root = document.createElement("div");
    root.appendChild(particleNode(spec()).node);
    root.appendChild(particleNode(spec()).node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, liveOptions);
    rt.reconcile();
    paintSharedCanvas("LIVE");
    flushRaf();
    flushRaf();

    expect(rt.stats().cacheHits).toBe(0);
    expect(__staticParticleFrameCacheStatsForTest().entries).toBe(0);
    rt.dispose();
  });

  it("a FROZEN-AT-MOUNT binding stays pristine, so its frame is still cacheable", () => {
    // `staticParticleFreezeAtMount` warms and draws a binding once in the LIVE loop and then skips
    // it — before the loop clears `pristine`, which is the whole point. `pristine` is the cache's
    // (and the surface swap's) admission gate: a state some wall-clock `dt` has entered is a phase
    // that depends on WHEN it ran, so it can never be named by a spec-derived key again. This pins
    // that a frozen-at-mount binding is NOT that, by making the cache serve one.
    const root = document.createElement("div");
    const a = particleNode(spec());
    const b = particleNode(spec());
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticleFreezeAtMount: true,
    } as never);
    rt.reconcile();
    paintSharedCanvas("LIVE-FROZEN");
    flushRaf();
    // The live loop draws each of them once itself — it does not consult the cache, which is the
    // frozen loop's mechanism.
    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().cacheHits).toBe(0);
    expect(__staticParticleFrameCacheStatsForTest().entries).toBe(0);

    // POISON the shared canvas, then hand the same two bindings to the frozen loop. If either had
    // been stepped, its key would be gone and both would re-render "POISONED".
    paintSharedCanvas("POISONED");
    rt.setStaticParticles(true);
    flushRaf();
    expect(rt.stats().cacheHits).toBe(1); // one published, one served
    expect(pixelsOf(canvasIn(a.self))).toBe(pixelsOf(canvasIn(b.self)));
    rt.dispose();
  });

  it("a different VISIBLE RECT splits the cache (same spec, same box, different margin)", () => {
    // The rect bounds the canvas MARGIN (`src/particles/extents.ts`), so two systems that agree on
    // everything else but sit at different places on the stage get differently-sized canvases —
    // and therefore different pictures. Frozen mode would otherwise blit one into the other.
    const root = document.createElement("div");
    const near = particleNode(spec(), 100, "-40,-40,200,200");
    const far = particleNode(spec(), 100, "-80,-40,200,200");
    root.appendChild(near.node);
    root.appendChild(far.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("X");
    flushRaf();

    // Really different canvases, not just different keys: 60px of room to the right vs 20px.
    expect(canvasIn(near.self).style.width).toBe("172px");
    expect(canvasIn(far.self).style.width).toBe("132px");
    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().cacheHits).toBe(0);
    rt.dispose();
  });

  it("but a rect that lands on the SAME margin still shares one frame", () => {
    // The converse, and the reason the key carries `padX`/`padY` rather than the attribute string:
    // it is a GEOMETRY key. A rect far larger than the burst can reach clamps nothing, so it is the
    // same canvas as no rect at all — and must not cost a second warm + draw.
    const root = document.createElement("div");
    const unbounded = particleNode(spec(), 100, null);
    const roomy = particleNode(spec(), 100, "-2000,-2000,4000,4000");
    root.appendChild(unbounded.node);
    root.appendChild(roomy.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("SHARED");
    flushRaf();

    expect(canvasIn(roomy.self).style.width).toBe(
      canvasIn(unbounded.self).style.width,
    );
    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().cacheHits).toBe(1);
    expect(pixelsOf(canvasIn(roomy.self))).toBe("SHARED");
    rt.dispose();
  });

  it("a MOVED emitter re-renders — it never paints its stale frame at the new size", () => {
    // The failure this exists to prevent. Static particles are the product default, so an emitter
    // that scrolls with the map re-sizes a canvas that is already showing a cached frame. If the
    // key did not carry the margin, the re-allocated (and therefore CLEARED) canvas would be
    // re-served the frame drawn for its OLD size: a burst drawn at the wrong offset inside a
    // differently-shaped box, which is a visible smear, not a subtle one.
    const root = document.createElement("div");
    const moving = particleNode(spec(), 100, "-40,-40,200,200");
    root.appendChild(moving.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("AT-FIRST-PLACE");
    flushRaf();
    const canvas = canvasIn(moving.self);
    expect(canvas.style.width).toBe("172px");
    expect(pixelsOf(canvas)).toBe("AT-FIRST-PLACE");
    expect(rt.stats().draws).toBe(1);

    // POISON the shared GL canvas: anything drawn from here on is "AT-SECOND-PLACE". The emitter
    // then scrolls, and the host restates its rect.
    paintSharedCanvas("AT-SECOND-PLACE");
    moving.node.setAttribute(
      "data-godot-particle-visible-rect",
      "-80,-40,200,200",
    );
    rt.reconcile();
    flushRaf();

    expect(canvasIn(moving.self)).toBe(canvas); // re-sized in place, not re-created
    expect(canvas.style.width).toBe("132px"); // …and really re-sized
    expect(pixelsOf(canvas)).toBe("AT-SECOND-PLACE"); // re-rendered, NOT the stale frame
    expect(rt.stats().draws).toBe(2);
    rt.dispose();
  });

  it("…and scrolling BACK serves the first frame again (the key re-keys both ways)", () => {
    // Invalidation alone would pass the test above. This pins the stronger claim: the key is a pure
    // function of the geometry, so returning to a geometry the cache has seen is a HIT — which is
    // what keeps a map that scrolls back and forth from re-rendering forever.
    const root = document.createElement("div");
    const moving = particleNode(spec(), 100, "-40,-40,200,200");
    root.appendChild(moving.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("HOME");
    flushRaf();
    expect(rt.stats().draws).toBe(1);

    moving.node.setAttribute(
      "data-godot-particle-visible-rect",
      "-80,-40,200,200",
    );
    paintSharedCanvas("AWAY");
    rt.reconcile();
    flushRaf();
    expect(rt.stats().draws).toBe(2);

    // Back home. Nothing may re-render: the "HOME" frame is still in the cache under this geometry.
    paintSharedCanvas("POISONED");
    moving.node.setAttribute(
      "data-godot-particle-visible-rect",
      "-40,-40,200,200",
    );
    rt.reconcile();
    flushRaf();

    expect(rt.stats().draws).toBe(2); // still two — no third render
    expect(canvasIn(moving.self).style.width).toBe("172px");
    expect(pixelsOf(canvasIn(moving.self))).toBe("HOME");
    rt.dispose();
  });

  it("a re-budget marks the binding DIRTY, so even the freeze-at-mount loop repaints it", () => {
    // The frozen loop redraws every binding unconditionally on each wake, so it would mask a missing
    // dirty flag. `staticParticleFreezeAtMount` does not: it runs inside the LIVE loop and draws a
    // frozen binding only when `dirty` says it owes a repaint. That makes it the sharp test of
    // `sizeCanvasOrDefer`'s contract — a re-allocation clears the canvas, and the binding must be
    // marked as owing a repaint or the emitter is left BLANK after it moves.
    const root = document.createElement("div");
    const moving = particleNode(spec(), 100, "-40,-40,200,200");
    root.appendChild(moving.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticleFreezeAtMount: true,
    } as never);
    rt.reconcile();
    paintSharedCanvas("FIRST");
    flushRaf();
    const canvas = canvasIn(moving.self);
    expect(rt.stats().draws).toBe(1);
    expect(pixelsOf(canvas)).toBe("FIRST");

    // A second tick with nothing changed draws nothing — the binding is clean.
    paintSharedCanvas("SECOND");
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    expect(pixelsOf(canvas)).toBe("FIRST");

    // Now move it. The canvas is re-allocated (and blanked); the repaint is owed and paid.
    moving.node.setAttribute(
      "data-godot-particle-visible-rect",
      "-80,-40,200,200",
    );
    rt.reconcile();
    flushRaf();

    expect(canvas.style.width).toBe("132px");
    expect(rt.stats().draws).toBe(2);
    expect(pixelsOf(canvas)).toBe("SECOND"); // not left blank
    rt.dispose();
  });

  it("a SUSPENDED frozen binding neither hits nor fills the cache", () => {
    const root = document.createElement("div");
    const a = particleNode(spec());
    a.node.setAttribute("data-godot-effects-suspended", "1");
    root.appendChild(a.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, staticOptions);
    rt.reconcile();
    paintSharedCanvas("X");
    flushRaf();
    expect(rt.stats().draws).toBe(0);
    expect(rt.stats().cacheHits).toBe(0);
    expect(__staticParticleFrameCacheStatsForTest().entries).toBe(0);
    rt.dispose();
  });
});
