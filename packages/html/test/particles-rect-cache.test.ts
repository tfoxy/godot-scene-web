// jsdom (gsw default env).
//
// The particle runtime sizes each binding's overlay canvas from its self-layer content box, and that
// box read (`clientWidth`/`clientHeight`) always follows DOM writes this runtime just made — the
// canvas insert, the preview hide, the canvas style — so it is a FORCED SYNCHRONOUS LAYOUT. A live
// combat trace put ~all of the document's `get clientWidth` self-time in here (468 forced layouts /
// 332 ms over 9.6 s), split between the create path and a second, synchronous texture-loaded
// re-size. These tests pin the cure the sibling shader runtime already had:
//
//   - a binding is measured ONCE, in a contiguous pass AFTER every create-time DOM write;
//   - every later size — an adaptive `setRenderScale`, a frozen-mode pin change, the frozen-mode
//     flip, an already-decoded texture's re-pad, a ResizeObserver delivery — reads NOTHING;
//   - `particleRectCache: false` restores the read-every-time behaviour.
//
// Instrumented through `stats().boxReads` rather than through geometry: jsdom reports 0 for
// `clientWidth`, so the canvas sizes here mean nothing, while the READS are exactly the thing under
// test. The self-layers below do carry (counting) clientWidth getters, which is also how the phasing
// is proved: each getter records what the DOM looked like at the moment it was read.
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
function flushRaf(): void {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
}

/** The runtime's ONE ResizeObserver, captured so a test can deliver an entry by hand. */
let roCallback: ResizeObserverCallback | null = null;
const observedTargets: Element[] = [];

/** What the DOM looked like at each self-layer box read — the phasing evidence. */
interface ReadSnapshot {
  canvases: number;
  previewsHidden: number;
}
let readSnapshots: ReadSnapshot[] = [];

let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;
let origImage: typeof globalThis.Image;

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
  origImage = globalThis.Image;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  globalThis.Image = origImage;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  rafQueue = [];
  readSnapshots = [];
  roCallback = null;
  observedTargets.length = 0;
  globalThis.Image = origImage;
  globalThis.ResizeObserver = makeResizeObserverStub({
    onConstruct: (cb) => {
      roCallback = cb;
    },
    onObserve: (target) => {
      observedTargets.push(target);
    },
    // The self-layers here INSTRUMENT `clientWidth` (that is the whole measurement), so the stub
    // must not reach for it: a real observer measures during the browser's own layout step and
    // costs the runtime no read. Same box the getters report.
    box: () => ({ width: 100, height: 60 }),
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** jsdom never loads images, so a texture entry is never `loaded` and the texture-load listener never
 *  fires. This stub decodes SYNCHRONOUSLY on `src=`, which is the real-world common case the second
 *  forced layout came from: every twin of a VFX family after the first hits the shared texture cache
 *  and `onTextureLoaded` runs its listener inline. */
function useSynchronouslyDecodingImages(): void {
  globalThis.Image = class {
    onload: (() => void) | null = null;
    crossOrigin: string | null = null;
    naturalWidth = 8;
    naturalHeight = 8;
    set src(_value: string) {
      this.onload?.();
    }
  } as unknown as typeof globalThis.Image;
}

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

/** One `[data-godot-particle-runtime]` node with a self-layer whose box reads are COUNTED and
 *  SNAPSHOTTED (what was in the DOM when the read happened). Carries a static preview span, so the
 *  create-time "hide the preview" write is real. */
function addParticleNode(root: HTMLElement, specJson: string): HTMLElement {
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", specJson);
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  const preview = document.createElement("span");
  preview.setAttribute("data-godot-particle", "1");
  self.appendChild(preview);
  node.appendChild(self);
  root.appendChild(node);
  const snapshot = (): ReadSnapshot => ({
    canvases: root.querySelectorAll("[data-godot-particle-canvas]").length,
    previewsHidden: Array.from(
      root.querySelectorAll<HTMLElement>("[data-godot-particle]"),
    ).filter((span) => span.style.display === "none").length,
  });
  Object.defineProperty(self, "clientWidth", {
    get: () => {
      readSnapshots.push(snapshot());
      return 100;
    },
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => 60,
    configurable: true,
  });
  return node;
}

/** A root with `count` particle systems, plus the runtime over it (NOT yet reconciled). */
function mount(count: number, options: Record<string, unknown> = {}) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const nodes: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    // Distinct seeds → distinct specs, so nothing here depends on the static-frame cache.
    nodes.push(addParticleNode(root, spec({ seed: i + 1 })));
  }
  const runtime = createParticleRuntime(root, {
    enableParticles: true,
    ...options,
  } as never);
  return { root, nodes, runtime };
}

/** Hand the runtime a ResizeObserver delivery for `target`, the way the browser would. */
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

// These pin the READ path — a create measured by `reconcile` itself — so they run with
// `particleObserverSizing: false`. That is not the default any more (a create's first box comes from
// the ResizeObserver, see the next describe), but it is the path the cache exists to make cheap and
// the fallback every engine without a delivering observer still takes.
describe("particle runtime — self-layer box cache (particleRectCache)", () => {
  const readPath = { particleObserverSizing: false };

  it("measures each new binding ONCE, and only after every create-time DOM write", () => {
    const { root, runtime } = mount(3, readPath);
    runtime.reconcile();

    // One measurement per binding: each has its OWN self-layer, so three bindings genuinely need
    // three reads. What the phasing buys is that they are CONTIGUOUS — see the snapshots below.
    expect(runtime.stats().boxReads).toBe(3);
    expect(root.querySelectorAll("[data-godot-particle-canvas]").length).toBe(
      3,
    );

    // The phasing evidence: at the FIRST read, all three previews were already hidden — i.e. every
    // create ran before any read. Under the old create-then-size-per-node interleave the first read
    // would have seen ONE preview hidden, and each read would have been a separate layout flush.
    //
    // No canvas is in the DOM at read time: a canvas is inserted by its FIRST SIZING (the write pass
    // below), never by its create, because an unsized canvas would sit in the layout at its 300x150
    // default. The reads are what this suite counts, and they still all see the same DOM.
    expect(readSnapshots).toHaveLength(3);
    for (const snap of readSnapshots) {
      expect(snap).toEqual({ canvases: 0, previewsHidden: 3 });
    }

    runtime.dispose();
  });

  it("reads NOTHING on fleet re-sizes, on a frozen-mode flip, or on an observer delivery", () => {
    const { nodes, runtime } = mount(3, readPath);
    runtime.reconcile();
    const afterCreate = runtime.stats().boxReads;
    expect(afterCreate).toBe(3);

    // Adaptive quality: density-only, so every binding sizes from its cached box.
    runtime.setRenderScale(0.5);
    expect(runtime.stats().boxReads).toBe(3);
    // The frozen-mode flip (which applies the pin recorded just before it) and a live pin retune
    // both re-size the whole fleet.
    runtime.setStaticParticlePixelRatio(2);
    runtime.setStaticParticles(true);
    expect(runtime.stats().boxReads).toBe(3);
    runtime.setStaticParticlePixelRatio(3);
    expect(runtime.stats().boxReads).toBe(3);

    // The observer measured the new box off the main path: it sizes AND refreshes the cache, so
    // neither it nor the next fleet re-size reads anything.
    expect(observedTargets).toHaveLength(3);
    for (const target of observedTargets) deliverResize(target, 200, 120);
    expect(runtime.stats().boxReads).toBe(3);
    runtime.setStaticParticles(false);
    runtime.setRenderScale(1);
    expect(runtime.stats().boxReads).toBe(3);

    // A re-created binding (spec change → new binding) is measured once, like any create.
    nodes[0].setAttribute("data-godot-particle-specs", spec({ seed: 99 }));
    runtime.reconcile();
    expect(runtime.stats().boxReads).toBe(4);

    runtime.dispose();
  });

  it("re-pads from the cached box when an already-decoded texture fires inline", () => {
    useSynchronouslyDecodingImages();
    const mountTextured = (options: Record<string, unknown>) => {
      const root = document.createElement("div");
      document.body.appendChild(root);
      for (let i = 0; i < 3; i++) {
        addParticleNode(root, spec({ seed: i + 1, textureUrl: "/sprite.png" }));
      }
      const runtime = createParticleRuntime(root, {
        enableParticles: true,
        ...options,
      } as never);
      runtime.reconcile();
      return runtime;
    };

    // The sprite is decoded before the listener is armed, so `onTextureLoaded` fires SYNCHRONOUSLY
    // and re-sizes each canvas for the now-known sprite dimensions. Only the pad moved — the element
    // box did not — so that re-size costs no read: 3, not 6.
    const cached = mountTextured(readPath);
    expect(cached.stats().boxReads).toBe(3);
    cached.dispose();

    // And the inline fire is really happening (this is not a listener that never ran): with the
    // cache off, that same synchronous re-size is a SECOND read per binding — the trace's second
    // forced layout, in the flesh.
    const uncached = mountTextured({ particleRectCache: false });
    expect(uncached.stats().boxReads).toBe(6);
    uncached.dispose();
  });

  it("particleRectCache: false restores the read-every-time behaviour", () => {
    // No `particleObserverSizing` override needed: observer-first sizing REQUIRES the cache (there
    // is nowhere for a delivered box to live without it), so turning the cache off already puts this
    // runtime on the read path.
    const { runtime } = mount(3, { particleRectCache: false });
    runtime.reconcile();
    // Same count on create — one size per new binding, no measure pass. (The create-time WRITES are
    // still phased ahead of them: the switch kills the cache, not the phasing.) What comes back is
    // the interleave: each of these reads sits between the sizing writes of the bindings around it,
    // so it is its own layout flush.
    expect(runtime.stats().boxReads).toBe(3);

    // And every later re-size re-reads the element, exactly as before the cache existed.
    runtime.setRenderScale(0.5);
    expect(runtime.stats().boxReads).toBe(6);
    runtime.setStaticParticlePixelRatio(2);
    runtime.setStaticParticles(true);
    expect(runtime.stats().boxReads).toBe(9);

    // Not even an observer delivery arms a cache the option turned off.
    for (const target of observedTargets) deliverResize(target, 200, 120);
    expect(runtime.stats().boxReads).toBe(9);
    runtime.setStaticParticlePixelRatio(3);
    expect(runtime.stats().boxReads).toBe(12);

    runtime.dispose();
  });

  it("keeps drawing after the phased create (the canvas is sized before the first tick)", () => {
    const { root, runtime } = mount(2, { ...readPath, staticParticles: true });
    runtime.reconcile();
    flushRaf(); // frozen mode: warm + draw once per binding, then park
    // Sizing moved out of `createBinding` into the reconcile's write pass; the loop must still find
    // every canvas sized (jsdom's 0 box + the sprite pad) and draw it.
    expect(runtime.stats().draws).toBe(2);
    for (const canvas of root.querySelectorAll<HTMLCanvasElement>(
      "[data-godot-particle-canvas]",
    )) {
      expect(canvas.width).toBeGreaterThan(0);
    }
    runtime.dispose();
  });
});

// The box cache took this runtime's forced layouts to ONE PER BINDING CREATED. That floor was still
// the largest remaining forced-layout cost in a live client (191 ms of `get clientWidth` on a phone
// trace, essentially all of it in the measure pass), and it exists only because the runtime asked
// the browser for a box on the main thread. The observer has already measured it during the
// browser's own layout step, so a create can just wait for it — and `boxReads` goes to ZERO.
describe("particle runtime — observer-first sizing (particleObserverSizing)", () => {
  it("creates force NO layout at all — the first box comes from the observer", () => {
    const { root, runtime } = mount(3);
    runtime.reconcile();

    // The whole point. Not "fewer reads": none.
    expect(runtime.stats().boxReads).toBe(0);
    expect(readSnapshots).toHaveLength(0);
    // …and the bindings are fully alive: the stub delivers on `observe()` the way a browser
    // delivers an initial observation, so each canvas is sized and mounted by that delivery.
    expect(observedTargets).toHaveLength(3);
    expect(root.querySelectorAll("[data-godot-particle-canvas]").length).toBe(
      3,
    );
    for (const canvas of root.querySelectorAll<HTMLCanvasElement>(
      "[data-godot-particle-canvas]",
    )) {
      expect(canvas.width).toBeGreaterThan(0);
    }
    // Every later size still rides the cache, so the count STAYS at zero.
    runtime.setRenderScale(0.5);
    runtime.setStaticParticles(true);
    expect(runtime.stats().boxReads).toBe(0);
    runtime.dispose();
  });

  it("holds the canvas out of the DOM until that first box lands, then draws", () => {
    // A real delivery is asynchronous (end of the next frame's layout step), so this suppresses the
    // stub's synchronous stand-in and delivers by hand — the only way to see the gap.
    globalThis.ResizeObserver = makeResizeObserverStub({
      onConstruct: (cb) => {
        roCallback = cb;
      },
      onObserve: (target) => {
        observedTargets.push(target);
      },
      initialDelivery: false,
    });
    const { root, runtime } = mount(1, { staticParticles: true });
    runtime.reconcile();

    // Nothing in the DOM (an unsized canvas has no box to place) and nothing read either. The
    // preview IS already hidden: hiding it is a pure write, and leaving it up for the extra frame
    // would flash differently-placed dots under the arriving canvas.
    expect(runtime.stats().boxReads).toBe(0);
    expect(root.querySelectorAll("[data-godot-particle-canvas]").length).toBe(
      0,
    );
    expect(
      root.querySelector<HTMLElement>("[data-godot-particle]")?.style.display,
    ).toBe("none");
    flushRaf();
    expect(runtime.stats().draws).toBe(0); // nothing to draw into

    deliverResize(observedTargets[0], 100, 60);
    const canvas = root.querySelector<HTMLCanvasElement>(
      "[data-godot-particle-canvas]",
    );
    expect(canvas).toBeTruthy();
    expect(canvas?.width).toBeGreaterThan(0);
    expect(runtime.stats().boxReads).toBe(0); // sized from the delivery, not from a read
    // The mount kicked the loop, so the frozen frame lands on the next tick.
    flushRaf();
    expect(runtime.stats().draws).toBe(1);
    runtime.dispose();
  });

  it("backstop: an engine that never delivers still gets sized, in ONE contiguous read run", () => {
    // Chrome delivers an initial observation for every observed target, 0x0 included (verified) —
    // but the spec only guarantees one when the size DIFFERS from the last reported, initially 0x0,
    // and a particle self-layer is routinely 0x0. On a strict engine the binding would never be
    // sized, never mounted and never drawn, so two frames after the reconcile it is swept.
    globalThis.ResizeObserver = makeResizeObserverStub({
      onObserve: (target) => {
        observedTargets.push(target);
      },
      initialDelivery: false,
    });
    const { root, runtime } = mount(3, { staticParticles: true });
    runtime.reconcile();
    expect(runtime.stats().boxReads).toBe(0);
    expect(root.querySelectorAll("[data-godot-particle-canvas]").length).toBe(
      0,
    );

    flushRaf(); // frame 1: the loop tick (nothing mounted) + the backstop's inner rAF
    expect(runtime.stats().boxReads).toBe(0);
    flushRaf(); // frame 2: the backstop runs

    // It costs exactly what the read path costs and no more — one read per binding, all in one
    // contiguous run (every snapshot sees the same DOM), then the writes.
    expect(runtime.stats().boxReads).toBe(3);
    expect(readSnapshots).toHaveLength(3);
    for (const snap of readSnapshots) {
      expect(snap).toEqual({ canvases: 0, previewsHidden: 3 });
    }
    expect(root.querySelectorAll("[data-godot-particle-canvas]").length).toBe(
      3,
    );
    flushRaf();
    expect(runtime.stats().draws).toBe(3);
    runtime.dispose();
  });

  it("particleObserverSizing: false restores the create-time measure pass", () => {
    const { root, runtime } = mount(3, { particleObserverSizing: false });
    runtime.reconcile();
    expect(runtime.stats().boxReads).toBe(3);
    expect(root.querySelectorAll("[data-godot-particle-canvas]").length).toBe(
      3,
    );
    runtime.dispose();
  });
});
