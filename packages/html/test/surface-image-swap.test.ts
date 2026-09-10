// jsdom (gsw default env).
//
// The FROZEN-SURFACE IMAGE SWAP (`src/surface-image-swap.ts`): a frozen shader binding whose
// static-frame key has been observed not to move is shown as an `<img>` of its own frame instead of
// its `<canvas>`, which drops the canvas's compositor layer / render surface / per-frame GPU fill.
// The gate is the whole design — a surface that CHANGES is measurably worse as an image — so these
// tests pin, in order:
//
//   - the stability gate: no swap before K observations, swap at K, on either clock
//     (frozen re-renders and quiet reconciles);
//   - churn: a key change after a swap reverts THAT FRAME and blocks the binding forever;
//   - one encode + one object URL per KEY, refcounted across every node sharing it, revoked when
//     the last one lets go, and on runtime dispose;
//   - LRU eviction retires a key without revoking under a live `<img>`;
//   - the box: same inline geometry, same place in paint order, node `mix-blend-mode` untouched;
//   - the dormant park composing with the swap (both surfaces hidden, the canvas NOT resurrected);
//   - the counters a device probe reads instead of console logs;
//   - and, with the option OFF, a path byte-identical to the one that existed before this feature.
//
// The lower half drives the module directly with a synthetic binding (registry mechanics); the upper
// half drives the real runtime through the same fake-WebGL2 + hand-flushed rAF harness as
// `webgl-static.test.ts`, so the gate is exercised where it actually runs.
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

import { SELF_LAYER_CLASS } from "../src/render-structure";
import { SHADER_DORMANT_ATTR } from "../src/shader-dormant";
import {
  __resetStaticImageSwapForTest,
  applySurfaceVisibility,
  claimStaticStill,
  createStaticImageState,
  createStaticImageSwapCounters,
  createStaticSurfaceSwapper,
  disposeStaticImage,
  liveStaticImageUrlCount,
  noteStaticFrame,
  noteStaticImageReconcile,
  onStaticFrameEvicted,
  revertStaticImage,
  STABLE_OBSERVATIONS_BEFORE_SWAP,
  STATIC_CAPTURE_BLANK,
  STATIC_SURFACE_IMAGE_ATTR,
  type StaticImageSwapBinding,
  type StaticImageSwapCounters,
  type StaticSurfaceCapture,
  type StaticSurfacePolicy,
  type StaticSurfaceSwapper,
} from "../src/surface-image-swap";
import {
  __resetStaticShaderFrameCacheForTest,
  createWebglShaderRuntime,
} from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";

const K = STABLE_OBSERVATIONS_BEFORE_SWAP;
const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";

// ---- encode / decode / object-URL stubs ------------------------------------------------------

let blobTypes: string[] = [];
/** The canvas each `toBlob` was called ON, in order. For a capture-hook binding this is the HOOK's
 *  canvas and never the binding's own — the whole point of that path. */
let blobSources: HTMLCanvasElement[] = [];
/** Encode callbacks parked instead of invoked (set by the one test that needs an in-flight window). */
let deferEncodes = false;
let parkedEncodes: Array<() => void> = [];
let createdUrls: string[] = [];
let revokedUrls: string[] = [];
let decodeFails = false;
let urlSeq = 0;

let origToBlob: HTMLCanvasElement["toBlob"];
let origDecode: HTMLImageElement["decode"] | undefined;
let origCreateObjectURL: typeof URL.createObjectURL;
let origRevokeObjectURL: typeof URL.revokeObjectURL;

function installBlobStubs(): void {
  origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function toBlob(
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
  ): void {
    blobTypes.push(type ?? "");
    blobSources.push(this);
    const run = (): void => callback(new Blob(["frame"], { type }));
    if (deferEncodes) parkedEncodes.push(run);
    else run();
  };
  origDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = (): Promise<void> =>
    decodeFails ? Promise.reject(new Error("decode")) : Promise.resolve();
  origCreateObjectURL = URL.createObjectURL;
  origRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = ((): string => {
    const url = `blob:stub/${++urlSeq}`;
    createdUrls.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string): void => {
    revokedUrls.push(url);
  }) as typeof URL.revokeObjectURL;
}

function restoreBlobStubs(): void {
  HTMLCanvasElement.prototype.toBlob = origToBlob;
  if (origDecode) HTMLImageElement.prototype.decode = origDecode;
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await flush();
};

function newCounters(): StaticImageSwapCounters {
  return createStaticImageSwapCounters();
}

// ---- runtime harness (mirrors webgl-static.test.ts) -------------------------------------------

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

let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;

beforeAll(() => {
  (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;
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
  installBlobStubs();
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  restoreBlobStubs();
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticShaderFrameCacheForTest();
  __resetStaticImageSwapForTest();
  blobTypes = [];
  blobSources = [];
  parkedEncodes = [];
  createdUrls = [];
  revokedUrls = [];
  deferEncodes = false;
  decodeFails = false;
  rafQueue = [];
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

function shaderNode(path = "res://s.gdshader"): {
  node: HTMLElement;
  self: HTMLElement;
} {
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
  return { node, self };
}

const canvasIn = (self: HTMLElement): HTMLCanvasElement | null =>
  self.querySelector<HTMLCanvasElement>("[data-godot-shader-canvas]");
const imageIn = (self: HTMLElement): HTMLImageElement | null =>
  self.querySelector<HTMLImageElement>(`[${STATIC_SURFACE_IMAGE_ATTR}]`);

/** Mount a frozen-mode runtime with `count` identical shader nodes and render the first frame. */
async function mountFrozen(
  count = 1,
  extraOptions: Record<string, unknown> = {},
): Promise<{
  rt: ReturnType<typeof createWebglShaderRuntime>;
  root: HTMLElement;
  nodes: HTMLElement[];
  selfs: HTMLElement[];
}> {
  const root = document.createElement("div");
  const nodes: HTMLElement[] = [];
  const selfs: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const { node, self } = shaderNode();
    root.appendChild(node);
    nodes.push(node);
    selfs.push(self);
  }
  document.body.appendChild(root);
  const rt = createWebglShaderRuntime(root, {
    resolveShaderSource: async () => SHADER,
    staticShaders: true,
    ...extraOptions,
  } as never);
  rt.reconcile();
  await settle();
  flushRaf(); // the one frozen render
  await flush();
  return { rt, root, nodes, selfs };
}

/** `n` reconciles in which nothing changed — the gate's clock. */
async function quietReconciles(
  rt: ReturnType<typeof createWebglShaderRuntime>,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    rt.reconcile();
    await flush();
  }
}

describe("frozen-surface image swap — the stability gate, through the runtime", () => {
  it("does NOT swap before K quiet reconciles, and swaps exactly at K", async () => {
    const { rt, selfs } = await mountFrozen();

    // The first render only ESTABLISHES the key (nothing has been observed to be stable yet).
    expect(imageIn(selfs[0])).toBeNull();
    expect(blobTypes).toEqual([]);

    await quietReconciles(rt, K - 1);
    expect(imageIn(selfs[0])).toBeNull(); // one observation short
    expect(blobTypes).toEqual([]);
    expect(rt.stats().staticImageSwaps).toBe(0);

    await quietReconciles(rt, 1);
    const img = imageIn(selfs[0]);
    expect(img).toBeTruthy();
    expect(blobTypes).toEqual(["image/png"]); // ONE encode, PNG (see the module doc)
    expect(rt.stats().staticImageSwaps).toBe(1);
    expect(rt.stats().staticImageEncodes).toBe(1);
    expect(rt.stats().staticImageUrlsLive).toBe(1);
    // The canvas is parked, not removed: the revert (and the SCREEN_TEXTURE capture path, which
    // reads a layer's pixels off its <canvas> child) both still need it.
    const canvas = canvasIn(selfs[0]);
    expect(canvas).toBeTruthy();
    expect(canvas?.style.display).toBe("none");
    expect(img?.style.display).toBe("block");
    rt.dispose();
  });

  it("never swaps a LIVE (unfrozen) runtime, however long it sits still", async () => {
    const { rt, selfs } = await mountFrozen(1, { staticShaders: false });
    await quietReconciles(rt, K + 4);
    expect(imageIn(selfs[0])).toBeNull();
    expect(blobTypes).toEqual([]);
    expect(rt.stats().staticImageSwaps).toBe(0);
    rt.dispose();
  });

  it("a key that keeps churning never reaches the gate", async () => {
    const { rt, nodes, selfs } = await mountFrozen();
    for (let i = 0; i < K + 4; i++) {
      nodes[0].setAttribute("data-godot-shader-params", `{"a":${i}}`);
      rt.reconcile();
      await flush();
      flushRaf(); // the re-render re-keys the frame
      await flush();
    }
    expect(imageIn(selfs[0])).toBeNull();
    expect(blobTypes).toEqual([]);
    rt.dispose();
  });

  it("reverts on the FIRST key change after a swap, and never swaps that binding again", async () => {
    const { rt, nodes, selfs } = await mountFrozen();
    await quietReconciles(rt, K);
    expect(imageIn(selfs[0])).toBeTruthy();
    const swappedUrl = createdUrls[0];

    // Churn: a param moves → re-render → a different frame key.
    nodes[0].setAttribute("data-godot-shader-params", '{"a":1}');
    rt.reconcile();
    await flush();
    flushRaf();
    await flush();

    expect(imageIn(selfs[0])).toBeNull();
    expect(canvasIn(selfs[0])?.style.display).toBe(""); // the canvas is back, with the NEW frame
    expect(rt.stats().staticImageReverts).toBe(1);
    expect(revokedUrls).toEqual([swappedUrl]); // last holder let go → revoked
    expect(rt.stats().staticImageUrlsLive).toBe(0);

    // Blocked for the life of the binding, however quiet it gets afterwards.
    await quietReconciles(rt, K * 3);
    expect(imageIn(selfs[0])).toBeNull();
    expect(rt.stats().staticImageSwaps).toBe(1);
    expect(blobTypes.length).toBe(1);
    rt.dispose();
  });

  it("shares ONE encode and ONE object URL across every node on the same key", async () => {
    const { rt, selfs } = await mountFrozen(3);
    await quietReconciles(rt, K);

    const imgs = selfs.map((self) => imageIn(self));
    expect(imgs.every(Boolean)).toBe(true);
    expect(new Set(imgs.map((img) => img?.getAttribute("src"))).size).toBe(1);
    expect(blobTypes.length).toBe(1); // 3 nodes, 1 encode
    expect(createdUrls.length).toBe(1);
    expect(rt.stats().staticImageSwaps).toBe(3);
    expect(rt.stats().staticImageEncodes).toBe(1);
    expect(rt.stats().staticImageUrlsLive).toBe(1);

    // Two of the three nodes leave: the URL is still held by the third.
    selfs[0].parentElement?.remove();
    selfs[1].parentElement?.remove();
    rt.reconcile();
    await flush();
    expect(revokedUrls).toEqual([]);
    expect(rt.stats().staticImageUrlsLive).toBe(1);

    // Runtime teardown releases the last ref.
    rt.dispose();
    expect(revokedUrls).toEqual([createdUrls[0]]);
    expect(liveStaticImageUrlCount()).toBe(0);
  });

  it("the live kill switch reverts every swap and revokes; re-arming re-earns the gate", async () => {
    const { rt, selfs } = await mountFrozen();
    await quietReconciles(rt, K);
    expect(imageIn(selfs[0])).toBeTruthy();

    rt.setStaticShaderImages(false);
    expect(imageIn(selfs[0])).toBeNull();
    expect(canvasIn(selfs[0])?.style.display).toBe("");
    expect(revokedUrls.length).toBe(1);
    expect(rt.stats().staticImageReverts).toBe(1);
    await quietReconciles(rt, K * 2);
    expect(imageIn(selfs[0])).toBeNull(); // OFF means off

    rt.setStaticShaderImages(true);
    flushRaf(); // re-arming re-dirties, so a render can name the current key
    await flush();
    await quietReconciles(rt, K - 1);
    expect(imageIn(selfs[0])).toBeNull(); // the gate starts over, it is not remembered
    await quietReconciles(rt, 1);
    expect(imageIn(selfs[0])).toBeTruthy();
    rt.dispose();
  });

  it("leaving frozen mode takes the <img> down immediately", async () => {
    const { rt, selfs } = await mountFrozen();
    await quietReconciles(rt, K);
    expect(imageIn(selfs[0])).toBeTruthy();

    rt.setStaticShaders(false);
    expect(imageIn(selfs[0])).toBeNull();
    expect(canvasIn(selfs[0])?.style.display).toBe("");
    expect(rt.stats().staticImageReverts).toBe(1);
    expect(revokedUrls.length).toBe(1);
    rt.dispose();
  });

  it("a runtime-wide re-size reverts WITHOUT blocking (an adaptive step is not node churn)", async () => {
    const { rt, selfs } = await mountFrozen();
    await quietReconciles(rt, K);
    expect(imageIn(selfs[0])).toBeTruthy();

    rt.setRenderScale(0.5);
    expect(imageIn(selfs[0])).toBeNull();
    expect(rt.stats().staticImageReverts).toBe(1);
    flushRaf(); // the re-size's re-render, at the new backing size
    await flush();

    await quietReconciles(rt, K);
    expect(imageIn(selfs[0])).toBeTruthy(); // re-earned, not disqualified
    expect(rt.stats().staticImageSwaps).toBe(2);
    rt.dispose();
  });

  it("composes with the dormant park: both surfaces hidden, and the wake does not resurrect the canvas", async () => {
    const { rt, nodes, selfs } = await mountFrozen();
    await quietReconciles(rt, K);
    const img = imageIn(selfs[0]);
    const canvas = canvasIn(selfs[0]);
    expect(img).toBeTruthy();

    nodes[0].setAttribute(SHADER_DORMANT_ATTR, "1");
    rt.reconcile();
    await flush();
    expect(img?.style.display).toBe("none");
    expect(canvas?.style.display).toBe("none");

    nodes[0].removeAttribute(SHADER_DORMANT_ATTR);
    rt.reconcile();
    await flush();
    expect(img?.style.display).toBe("block");
    expect(canvas?.style.display).toBe("none"); // still swapped — the wake must not un-park it
    expect(img?.isConnected).toBe(true);

    // The wake re-renders at the same key, which must NOT count as churn.
    flushRaf();
    await flush();
    expect(imageIn(selfs[0])).toBe(img);
    expect(rt.stats().staticImageReverts).toBe(0);
    rt.dispose();
  });

  it("preserves the canvas's box, its place in paint order, and the node's blend", async () => {
    const { rt, nodes, selfs } = await mountFrozen();
    const canvas = canvasIn(selfs[0]);
    if (!canvas) throw new Error("no canvas");
    canvas.style.left = "25%";
    canvas.style.top = "10%";
    canvas.style.width = "50%";
    canvas.style.height = "80%";
    nodes[0].style.mixBlendMode = "plus-lighter";

    await quietReconciles(rt, K);
    const img = imageIn(selfs[0]);
    if (!img) throw new Error("no image");

    expect(img.style.position).toBe("absolute");
    expect(img.style.pointerEvents).toBe("none");
    expect(img.style.left).toBe("25%");
    expect(img.style.top).toBe("10%");
    expect(img.style.width).toBe("50%");
    expect(img.style.height).toBe("80%");
    // Neither `object-fit` nor `image-rendering` may resample differently than the canvas did.
    expect(img.style.objectFit).toBe("fill");
    expect(img.style.imageRendering).toBe("auto");
    // Same position in the child list as the (now hidden) canvas ⇒ same paint order.
    expect(img.nextElementSibling).toBe(canvas);
    expect(img.parentElement).toBe(canvas.parentElement);
    // The blend lives on the NODE (a canvas-level blend cannot reach the DOM behind it) and is
    // therefore untouched by the swap.
    expect(nodes[0].style.mixBlendMode).toBe("plus-lighter");
    expect(img.getAttribute(STATIC_SURFACE_IMAGE_ATTR)).toBe("true");
    rt.dispose();
  });

  it("an <img> that will not decode leaves the canvas up and blocks the binding", async () => {
    decodeFails = true;
    const { rt, selfs } = await mountFrozen();
    await quietReconciles(rt, K + 2);
    expect(imageIn(selfs[0])).toBeNull();
    expect(canvasIn(selfs[0])?.style.display).toBe("");
    expect(rt.stats().staticImageSwaps).toBe(0);
    expect(rt.stats().staticImageFailures).toBe(1);
    expect(rt.stats().staticImageUrlsLive).toBe(0); // released, not leaked
    rt.dispose();
  });
});

describe("frozen-surface image swap — host-driven invalidation and display ownership", () => {
  it("invalidateStaticSurfaces() with no argument hands EVERY surface back, unblocked", async () => {
    const { rt, selfs } = await mountFrozen(2);
    await quietReconciles(rt, K);
    expect(imageIn(selfs[0])).toBeTruthy();
    expect(imageIn(selfs[1])).toBeTruthy();
    expect(rt.stats().staticImagesLive).toBe(2);

    rt.invalidateStaticSurfaces();
    expect(imageIn(selfs[0])).toBeNull();
    expect(imageIn(selfs[1])).toBeNull();
    expect(canvasIn(selfs[0])?.style.display).toBe("");
    expect(rt.stats().staticImageReverts).toBe(2);
    expect(rt.stats().staticImageRevertsByCause["host-invalidate"]).toBe(2);
    expect(rt.stats().staticImagesLive).toBe(0);
    expect(rt.stats().staticImageUrlsLive).toBe(0);

    // Not blocked — the host said "not now", not "never".
    await quietReconciles(rt, K + 1);
    expect(imageIn(selfs[0])).toBeTruthy();
    expect(rt.stats().staticImagesLive).toBe(2);
    rt.dispose();
  });

  it("invalidateStaticSurfaces(nodes) reverts exactly the named bindings — or everything under them", async () => {
    const { rt, root, nodes, selfs } = await mountFrozen(3);
    await quietReconciles(rt, K);
    expect(rt.stats().staticImagesLive).toBe(3);

    rt.invalidateStaticSurfaces([nodes[1]]);
    expect(imageIn(selfs[0])).toBeTruthy();
    expect(imageIn(selfs[1])).toBeNull();
    expect(imageIn(selfs[2])).toBeTruthy();
    expect(rt.stats().staticImagesLive).toBe(2);

    // A host that owns a SUBTREE should not have to know which descendants gsw bound.
    rt.invalidateStaticSurfaces([root]);
    expect(imageIn(selfs[0])).toBeNull();
    expect(imageIn(selfs[2])).toBeNull();
    expect(rt.stats().staticImagesLive).toBe(0);
    expect(rt.stats().staticImageRevertsByCause["host-invalidate"]).toBe(3);
    rt.dispose();
  });

  it("never un-hides a canvas the HOST hid — the dormancy wake restores what it found", async () => {
    const { rt, nodes, selfs } = await mountFrozen();
    const canvas = canvasIn(selfs[0]);
    if (!canvas) throw new Error("no canvas");
    // A host running its own occlusion / virtualizer pass over the same DOM claims this element.
    canvas.style.display = "none";

    nodes[0].setAttribute(SHADER_DORMANT_ATTR, "1");
    rt.reconcile();
    await flush();
    expect(canvas.style.display).toBe("none");

    nodes[0].removeAttribute(SHADER_DORMANT_ATTR);
    rt.reconcile();
    await flush();
    // The pre-fix wake wrote a blanket `""` here and resurrected a canvas gsw does not own.
    expect(canvas.style.display).toBe("none");
    rt.dispose();
  });
});

describe("frozen-surface image swap — the option carries POLICY, not just on/off", () => {
  it("a quiet-window policy freezes on the runtime's own draw clock, through the option", async () => {
    // A hand-driven clock/timer seam, exactly as a consumer would supply for determinism.
    let nowMs = 0;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const advance = async (ms: number): Promise<void> => {
      const target = nowMs + ms;
      for (;;) {
        let dueId = -1;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < dueAt) {
            dueAt = t.at;
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
    };

    const { rt, selfs } = await mountFrozen(1, {
      staticShaderImages: {
        gate: { kind: "quiet-window", quietMs: 500 },
        now: () => nowMs,
        setTimeout: (fn: () => void, ms: number) => {
          const id = ++seq;
          timers.set(id, { at: nowMs + ms, fn });
          return id;
        },
        clearTimeout: (handle: unknown) => {
          timers.delete(handle as number);
        },
      },
    });

    // No reconciles at all — the quiet-window gate does not use them as a clock.
    expect(imageIn(selfs[0])).toBeNull();
    await advance(499);
    expect(imageIn(selfs[0])).toBeNull();
    await advance(2);
    expect(imageIn(selfs[0])).toBeTruthy();
    expect(rt.stats().staticImagesLive).toBe(1);

    // The runtime's own re-render is a draw: it thaws the surface the same tick.
    flushRaf();
    await flush();
    rt.setRenderScale(0.5); // re-dirties + re-renders every binding
    flushRaf();
    await flush();
    expect(imageIn(selfs[0])).toBeNull();
    rt.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });
});

describe("frozen-surface image swap — OFF is the pre-existing path", () => {
  it("staticShaderImages:false never encodes, never swaps, and leaves every counter at 0", async () => {
    const { rt, nodes, selfs } = await mountFrozen(2, {
      staticShaderImages: false,
    });
    await quietReconciles(rt, K * 3);

    expect(imageIn(selfs[0])).toBeNull();
    expect(imageIn(selfs[1])).toBeNull();
    expect(blobTypes).toEqual([]);
    expect(createdUrls).toEqual([]);
    expect(canvasIn(selfs[0])?.style.display).toBe("");

    // The dormant park still writes exactly `display: none` / `""` on the canvas.
    nodes[0].setAttribute(SHADER_DORMANT_ATTR, "1");
    rt.reconcile();
    await flush();
    expect(canvasIn(selfs[0])?.style.display).toBe("none");
    nodes[0].removeAttribute(SHADER_DORMANT_ATTR);
    rt.reconcile();
    await flush();
    expect(canvasIn(selfs[0])?.style.display).toBe("");

    const stats = rt.stats();
    expect({
      swaps: stats.staticImageSwaps,
      reverts: stats.staticImageReverts,
      encodes: stats.staticImageEncodes,
      failures: stats.staticImageFailures,
      urls: stats.staticImageUrlsLive,
    }).toEqual({ swaps: 0, reverts: 0, encodes: 0, failures: 0, urls: 0 });
    rt.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });
});

// ---- module-level registry mechanics ----------------------------------------------------------

function fakeBinding(): StaticImageSwapBinding {
  const self = document.createElement("div");
  const canvas = document.createElement("canvas");
  // The swap encodes from the backing store, so a 0x0 canvas is not a frame.
  canvas.width = 8;
  canvas.height = 4;
  canvas.setAttribute("data-godot-shader-canvas", "true");
  Object.assign(canvas.style, {
    position: "absolute",
    pointerEvents: "none",
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
  });
  const node = document.createElement("div");
  node.appendChild(self);
  document.body.appendChild(node);
  self.appendChild(canvas);
  return {
    node,
    canvas,
    dirty: false,
    dormant: false,
    staticImage: createStaticImageState(),
  };
}

const standIn = (binding: StaticImageSwapBinding): HTMLImageElement | null =>
  binding.canvas.parentElement?.querySelector<HTMLImageElement>(
    `[${STATIC_SURFACE_IMAGE_ATTR}]`,
  ) ?? null;

/** Feed one key through the render clock `n` times. */
async function observeRenders(
  binding: StaticImageSwapBinding,
  key: string,
  counters: StaticImageSwapCounters,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) noteStaticFrame(binding, key, counters);
  await flush();
}

describe("frozen-surface image swap — registry mechanics", () => {
  it("counts the FIRST frozen render as establishing the key, not as an observation", async () => {
    const binding = fakeBinding();
    const counters = newCounters();
    await observeRenders(binding, "k", counters, K); // 1 establish + K-1 observations
    expect(standIn(binding)).toBeNull();
    await observeRenders(binding, "k", counters, 1);
    expect(standIn(binding)).toBeTruthy();
    expect(counters.staticImageSwaps).toBe(1);
  });

  it("a dormant binding observes nothing and is never swapped while parked", async () => {
    const binding = fakeBinding();
    const counters = newCounters();
    binding.dormant = true;
    await observeRenders(binding, "k", counters, K * 3);
    expect(standIn(binding)).toBeNull();
    binding.dormant = false;
    await observeRenders(binding, "k", counters, 1);
    expect(standIn(binding)).toBeTruthy();
  });

  it("a dirty binding contributes no RECONCILE observation (its canvas is not the key's frame yet)", async () => {
    const binding = fakeBinding();
    const counters = newCounters();
    noteStaticFrame(binding, "k", counters); // establish
    binding.dirty = true;
    for (let i = 0; i < K * 3; i++)
      noteStaticImageReconcile(binding, true, counters);
    await flush();
    expect(standIn(binding)).toBeNull();
    binding.dirty = false;
    for (let i = 0; i < K; i++)
      noteStaticImageReconcile(binding, true, counters);
    await flush();
    expect(standIn(binding)).toBeTruthy();
  });

  it("refcounts one URL across bindings and revokes only on the LAST release", async () => {
    const a = fakeBinding();
    const b = fakeBinding();
    const counters = newCounters();
    await observeRenders(a, "shared", counters, K + 1);
    await observeRenders(b, "shared", counters, K + 1);
    expect(counters.staticImageEncodes).toBe(1);
    expect(counters.staticImageSwaps).toBe(2);
    expect(liveStaticImageUrlCount()).toBe(1);
    expect(standIn(a)?.getAttribute("src")).toBe(
      standIn(b)?.getAttribute("src"),
    );

    disposeStaticImage(a);
    expect(revokedUrls).toEqual([]);
    expect(liveStaticImageUrlCount()).toBe(1);
    disposeStaticImage(b);
    expect(revokedUrls).toEqual([createdUrls[0]]);
    expect(liveStaticImageUrlCount()).toBe(0);
  });

  it("an encode that finishes after everyone let go publishes no URL at all", async () => {
    deferEncodes = true;
    const binding = fakeBinding();
    const counters = newCounters();
    await observeRenders(binding, "k", counters, K + 1);
    expect(parkedEncodes.length).toBe(1);
    expect(standIn(binding)).toBeNull(); // still encoding

    disposeStaticImage(binding); // the node went away mid-encode
    parkedEncodes[0]();
    await flush();
    expect(createdUrls).toEqual([]);
    expect(liveStaticImageUrlCount()).toBe(0);
    expect(standIn(binding)).toBeNull();
  });

  it("LRU eviction retires a key without revoking under a live <img>, and re-encodes for the next holder", async () => {
    const a = fakeBinding();
    const counters = newCounters();
    await observeRenders(a, "k", counters, K + 1);
    const firstUrl = standIn(a)?.getAttribute("src");
    expect(firstUrl).toBeTruthy();

    onStaticFrameEvicted("k");
    // The still-swapped binding keeps its (immutable) pixels: no revoke, no re-decode.
    expect(revokedUrls).toEqual([]);
    expect(standIn(a)?.getAttribute("src")).toBe(firstUrl);

    // A new holder of the same key must NOT attach to the retired entry.
    const b = fakeBinding();
    await observeRenders(b, "k", counters, K + 1);
    expect(counters.staticImageEncodes).toBe(2);
    expect(standIn(b)?.getAttribute("src")).not.toBe(firstUrl);
    expect(liveStaticImageUrlCount()).toBe(2);

    disposeStaticImage(a);
    expect(revokedUrls).toEqual([firstUrl]);
    disposeStaticImage(b);
    expect(liveStaticImageUrlCount()).toBe(0);
  });

  it("`revertStaticImage` undoes a swap without blocking; a key change blocks forever", async () => {
    const soft = fakeBinding();
    const counters = newCounters();
    await observeRenders(soft, "k", counters, K + 1);
    revertStaticImage(soft, counters);
    expect(standIn(soft)).toBeNull();
    expect(counters.staticImageReverts).toBe(1);
    await observeRenders(soft, "k", counters, K + 1);
    expect(standIn(soft)).toBeTruthy(); // re-earned

    const hard = fakeBinding();
    await observeRenders(hard, "k1", counters, K + 1);
    expect(standIn(hard)).toBeTruthy();
    noteStaticFrame(hard, "k2", counters); // churn
    await flush();
    expect(standIn(hard)).toBeNull();
    await observeRenders(hard, "k2", counters, K * 4);
    expect(standIn(hard)).toBeNull(); // blocked for the life of the binding
  });

  it("a null key (live mode / screen-space shader / textures loading) retires the swap, unblocked", async () => {
    const binding = fakeBinding();
    const counters = newCounters();
    await observeRenders(binding, "k", counters, K + 1);
    expect(standIn(binding)).toBeTruthy();

    noteStaticFrame(binding, null, counters);
    await flush();
    expect(standIn(binding)).toBeNull();
    expect(counters.staticImageReverts).toBe(1);
    expect(liveStaticImageUrlCount()).toBe(0);

    await observeRenders(binding, "k", counters, K + 1);
    expect(standIn(binding)).toBeTruthy();
  });

  it("`applySurfaceVisibility` on a stateless binding is exactly the old dormant park", () => {
    const binding = fakeBinding();
    binding.staticImage = null;
    binding.dormant = true;
    applySurfaceVisibility(binding);
    expect(binding.canvas.style.display).toBe("none");
    binding.dormant = false;
    applySurfaceVisibility(binding);
    expect(binding.canvas.style.display).toBe("");
  });

  it("never touches the canvas when the environment cannot encode", async () => {
    const saved = HTMLCanvasElement.prototype.toBlob;
    // biome-ignore lint/suspicious/noExplicitAny: deleting a prototype method for the probe
    (HTMLCanvasElement.prototype as any).toBlob = undefined;
    const binding = fakeBinding();
    const counters = newCounters();
    const spy = vi.spyOn(URL, "createObjectURL");
    await observeRenders(binding, "k", counters, K * 3);
    expect(standIn(binding)).toBeNull();
    expect(binding.canvas.style.display).toBe("");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    HTMLCanvasElement.prototype.toBlob = saved;
  });
});

// ---- capture-hook encode sources (the WebGPU path) ---------------------------------------------
//
// A binding whose canvas CANNOT be read back (a WebGPU one) supplies `captureCanvas` instead: an
// async hook that re-renders its current frame offscreen and hands back an ordinary 2D canvas (see
// `src/webgpu/still-capture.ts`). Everything downstream — dedup, the stand-in, parked stills — is
// then identical to the canvas-sourced path, so what these pin is the seam itself:
//
//   - the encode really reads the HOOK's canvas, never the binding's;
//   - capture wall time books its OWN counters and does not leak into encode-ms, which means
//     "synchronous main-thread park" and has to keep meaning that;
//   - every way a capture can fail leaves the surface on its canvas WITHOUT wedging the queue;
//   - a capture that lands after everyone let go publishes nothing;
//   - the two zero-readback paths (key dedup, parked stills) skip the capture entirely.
//
// The clock/timer seams are injected for the same reason the policy suite injects them: a capture's
// cost is measured on the module's own clock, so "this readback took 40 ms" has to be something a
// test can STATE rather than wait for.

/** A hand-driven clock + timer seam, sized to what these tests need (the policy suite's fuller one
 *  also models pending-timer counts, which nothing here asserts). */
function captureScheduler() {
  let nowMs = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: (): number => nowMs,
    /** Charge wall time from INSIDE a stubbed capture — how a fake clock says "this readback took
     *  40 ms". */
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
      // Never backwards: a stubbed capture may have `spend()`-ed past the target from inside a timer
      // callback, and a clock that ran back would un-expire every deadline the module holds.
      nowMs = Math.max(nowMs, target);
      await settle();
    },
  };
}

type CaptureClock = ReturnType<typeof captureScheduler>;

/** A binding whose canvas is unreadable: the hook is the only way to its pixels. */
function captureBinding(
  hook: () => Promise<StaticSurfaceCapture>,
): StaticImageSwapBinding {
  const binding = fakeBinding();
  binding.staticImage = null; // the swapper gives it state under ITS policy
  binding.captureCanvas = hook;
  return binding;
}

/** The throwaway canvas a real capture hook produces — sized like the surface it stands for. */
function capturedCanvas(width = 8, height = 4): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function quietPolicy(
  clock: CaptureClock,
  extra: Partial<StaticSurfacePolicy> = {},
): StaticSurfacePolicy {
  return {
    gate: { kind: "quiet-window", quietMs: 1000 },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...extra,
  };
}

function captureSwapper(
  policy: StaticSurfacePolicy,
  counters: StaticImageSwapCounters,
): StaticSurfaceSwapper {
  const swapper = createStaticSurfaceSwapper(policy, counters);
  if (!swapper) throw new Error("policy unexpectedly disabled the swapper");
  return swapper;
}

describe("frozen-surface image swap — capture-hook encode sources", () => {
  it("encodes the HOOK's canvas and books the readback as CAPTURE time, not encode time", async () => {
    const clock = captureScheduler();
    const counters = newCounters();
    const swapper = captureSwapper(quietPolicy(clock), counters);
    const captured = capturedCanvas();
    const binding = captureBinding(async () => {
      clock.spend(40); // the GPU readback's wall time
      return captured;
    });
    swapper.attach(binding);

    await clock.advance(1001);

    expect(standIn(binding)).toBeTruthy();
    expect(counters.staticImageSwaps).toBe(1);
    expect(counters.staticImagesLive).toBe(1);
    expect(counters.staticImageCaptures).toBe(1);
    expect(counters.staticImageCaptureFailures).toBe(0);
    expect(counters.staticImageEncodes).toBe(1);
    // The encode read what the hook produced. The binding's own canvas is never touched — on a real
    // WebGPU surface reading it is blank headless and pathological on Android.
    expect(blobSources).toEqual([captured]);
    // The 40 ms went to the capture counters…
    expect(counters.staticImageCaptureMs).toBe(40);
    expect(counters.staticImageCaptureMaxMs).toBe(40);
    // …and NOT into encode-ms, which means "synchronous main-thread park" and must keep meaning it.
    expect(counters.staticImageEncodeMs).toBe(0);
    expect(counters.staticImageEncodeMaxMs).toBe(0);
    // The capture canvas is released once its encode has been kicked.
    expect(captured.width).toBe(0);
    expect(captured.height).toBe(0);
    swapper.dispose();
  });

  it("a null capture books a CAPTURE failure and blocks the surface under the default policy", async () => {
    const clock = captureScheduler();
    const counters = newCounters();
    const swapper = captureSwapper(quietPolicy(clock), counters);
    const binding = captureBinding(async () => null);
    swapper.attach(binding);

    await clock.advance(1001);
    expect(standIn(binding)).toBeNull();
    expect(counters.staticImageCaptureFailures).toBe(1);
    // A capture failure is still a failure: the aggregate keeps its meaning.
    expect(counters.staticImageFailures).toBe(1);
    expect(counters.staticImageCaptures).toBe(0);
    expect(createdUrls).toEqual([]);

    // Blocked, not wedged: the queue drains and the surface is simply never offered again.
    await clock.advance(10_000);
    expect(counters.staticImageCaptureFailures).toBe(1);
    expect(standIn(binding)).toBeNull();
    swapper.dispose();
  });

  it("a REJECTED capture is the same event as a null one, and `retry` re-paces it forever", async () => {
    const clock = captureScheduler();
    const counters = newCounters();
    const swapper = captureSwapper(
      quietPolicy(clock, {
        onInvalidate: "retry",
        encode: { intervalMs: 100 },
      }),
      counters,
    );
    let attempts = 0;
    const binding = captureBinding(async () => {
      attempts++;
      if (attempts === 1) throw new Error("the device refused the capture");
      return capturedCanvas();
    });
    swapper.attach(binding);

    await clock.advance(1001);
    expect(attempts).toBe(1);
    expect(counters.staticImageCaptureFailures).toBe(1);
    expect(standIn(binding)).toBeNull();

    // Rescheduled on the encode cadence rather than disqualified.
    await clock.advance(2001);
    expect(attempts).toBe(2);
    expect(counters.staticImageCaptures).toBe(1);
    expect(standIn(binding)).toBeTruthy();
    swapper.dispose();
  });

  // ---- blank captures --------------------------------------------------------------------------
  //
  // The failure that reads as a success: the readback completes, reports nothing wrong, and hands
  // back an entirely transparent frame for a surface that was painting (measured headed on the
  // default ANGLE backend — docs/perf-harness.md, S8). Publishing it hides a canvas that was drawing
  // behind a PNG of nothing, with `staticImagesLive` and zero failures saying it all went well.

  it("a BLANK capture leaves the canvas mounted, publishes NO <img>, and books its own counter", async () => {
    const clock = captureScheduler();
    const counters = newCounters();
    const swapper = captureSwapper(quietPolicy(clock), counters);
    const binding = captureBinding(async () => STATIC_CAPTURE_BLANK);
    swapper.attach(binding);

    await clock.advance(1001);

    // The whole point: the surface is exactly where it was — its own canvas, visible, unhidden.
    expect(standIn(binding)).toBeNull();
    expect(binding.canvas.style.display).toBe("");
    expect(binding.canvas.isConnected).toBe(true);
    expect(counters.staticImagesLive).toBe(0);
    expect(counters.staticImageSwaps).toBe(0);

    // Counted DISTINCTLY, and layered: a blank readback is a capture failure and therefore a
    // failure, so the two aggregates keep their meanings and the new counter says which one it was.
    expect(counters.staticImageBlankCaptures).toBe(1);
    expect(counters.staticImageCaptureFailures).toBe(1);
    expect(counters.staticImageFailures).toBe(1);
    // Not a capture that produced pixels, and nothing was encoded from it.
    expect(counters.staticImageCaptures).toBe(0);
    expect(counters.staticImageEncodes).toBe(0);
    expect(blobSources).toEqual([]);
    expect(createdUrls).toEqual([]);
    expect(liveStaticImageUrlCount()).toBe(0);
    swapper.dispose();
  });

  it("a blank capture is TERMINAL for the surface — even under `onInvalidate: retry`", async () => {
    // A null/throwing capture under `retry` is rescheduled forever (the test above this section),
    // because it says nothing about whether the NEXT one will work. A blank one does: it is a
    // statement about the device's readback path, and re-asking costs a full GPU re-render plus a
    // `copyTextureToBuffer` per surface per interval to be told the same thing.
    const clock = captureScheduler();
    const counters = newCounters();
    const swapper = captureSwapper(
      quietPolicy(clock, {
        onInvalidate: "retry",
        encode: { intervalMs: 100 },
      }),
      counters,
    );
    let attempts = 0;
    const binding = captureBinding(async () => {
      attempts++;
      return STATIC_CAPTURE_BLANK;
    });
    swapper.attach(binding);

    await clock.advance(1001);
    expect(attempts).toBe(1);
    expect(counters.staticImageBlankCaptures).toBe(1);

    // Ten seconds and a hundred encode intervals later: not one more readback.
    await clock.advance(10_000);
    expect(attempts).toBe(1);
    expect(counters.staticImageBlankCaptures).toBe(1);
    expect(standIn(binding)).toBeNull();
    expect(binding.canvas.style.display).toBe("");
    swapper.dispose();
  });

  it("does not hold the queue: the NEXT surface still freezes after one blank", async () => {
    const clock = captureScheduler();
    const counters = newCounters();
    const swapper = captureSwapper(quietPolicy(clock), counters);
    const blank = captureBinding(async () => STATIC_CAPTURE_BLANK);
    swapper.attach(blank);
    await clock.advance(1001);
    expect(counters.staticImageBlankCaptures).toBe(1);

    // A different surface, whose readback works — a producer refusing one frame must not be able to
    // disqualify a fleet (the entries are per KEY, and a keyless surface encodes under a private
    // synthetic one).
    const painted = captureBinding(async () => capturedCanvas());
    swapper.attach(painted);
    await clock.advance(1001);
    expect(standIn(painted)).toBeTruthy();
    expect(counters.staticImageCaptures).toBe(1);
    expect(counters.staticImageBlankCaptures).toBe(1);
    swapper.dispose();
  });

  it("a SLOW capture arms the adaptive backoff, which defers the next pass", async () => {
    const clock = captureScheduler();
    const counters = newCounters();
    const swapper = captureSwapper(
      quietPolicy(clock, {
        encode: {
          slice: 4,
          intervalMs: 10,
          slowEncodeMs: 30,
          // Long enough to still be holding when the NEXT surface's quiet window elapses — the
          // situation the backoff exists for (a fleet freezing against a saturated GPU).
          slowBackoffMs: 5000,
        },
      }),
      counters,
    );
    const slow = captureBinding(async () => {
      clock.spend(120); // a saturated GPU handing pixels over
      return capturedCanvas();
    });
    swapper.attach(slow);
    await clock.advance(1001);
    expect(counters.staticImageCaptures).toBe(1);
    // Measured on the capture's WALL time — the one clock a suppressed frame cannot fake.
    expect(counters.staticImageSlowEncodes).toBe(1);

    // A second surface arriving inside the backoff window is held, not encoded.
    const next = captureBinding(async () => capturedCanvas());
    swapper.attach(next);
    await clock.advance(1001);
    expect(counters.staticImageBackoffDeferrals).toBeGreaterThan(0);

    // Bounded, always: whichever expires first — the hold, or `busyMaxDeferMs`'s cap on one
    // unbroken run of deferrals — the surface freezes.
    await clock.advance(6000);
    expect(counters.staticImageCaptures).toBe(2);
    expect(standIn(next)).toBeTruthy();
    swapper.dispose();
  });

  it("a capture that lands after the surface let go publishes nothing", async () => {
    const clock = captureScheduler();
    const counters = newCounters();
    const swapper = captureSwapper(quietPolicy(clock), counters);
    let release: ((canvas: HTMLCanvasElement | null) => void) | null = null;
    const binding = captureBinding(
      () =>
        new Promise<HTMLCanvasElement | null>((resolve) => {
          release = resolve;
        }),
    );
    swapper.attach(binding);

    await clock.advance(1001);
    expect(release).not.toBeNull();
    expect(standIn(binding)).toBeNull(); // still capturing

    // The node went away mid-capture (a dispose, a revert, a runtime teardown).
    swapper.detach(binding);
    release?.(capturedCanvas());
    await settle();

    expect(createdUrls).toEqual([]);
    expect(liveStaticImageUrlCount()).toBe(0);
    expect(standIn(binding)).toBeNull();
    // Nothing FAILED — the surface simply stopped wanting a still.
    expect(counters.staticImageFailures).toBe(0);
    expect(counters.staticImageCaptureFailures).toBe(0);
    swapper.dispose();
  });

  it("two surfaces on ONE content key pay ONE capture and both attach to it", async () => {
    const clock = captureScheduler();
    const counters = newCounters();
    // The content-key gate is what dedup keys off; a keyless (quiet-window) surface gets a private
    // synthetic key by construction and can never share.
    const swapper = captureSwapper(
      {
        gate: { kind: "content-key" },
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      },
      counters,
    );
    let captures = 0;
    const hook = async (): Promise<HTMLCanvasElement> => {
      captures++;
      return capturedCanvas();
    };
    const a = captureBinding(hook);
    const b = captureBinding(hook);
    swapper.attach(a);
    swapper.attach(b);

    for (let i = 0; i < K + 1; i++) {
      noteStaticFrame(a, "shared", counters);
      noteStaticFrame(b, "shared", counters);
    }
    await settle();

    expect(captures).toBe(1);
    expect(counters.staticImageCaptures).toBe(1);
    expect(counters.staticImageEncodes).toBe(1);
    expect(counters.staticImageSwaps).toBe(2);
    expect(standIn(a)?.getAttribute("src")).toBe(
      standIn(b)?.getAttribute("src"),
    );
    expect(liveStaticImageUrlCount()).toBe(1);
    swapper.dispose();
  });

  it("a reclaimed PARKED still costs no capture at all", async () => {
    const clock = captureScheduler();
    const counters = newCounters();
    const swapper = captureSwapper(
      quietPolicy(clock, { encode: { parkedStillBytes: 1 << 20 } }),
      counters,
    );
    const binding = captureBinding(async () => capturedCanvas());
    swapper.attach(binding);

    await clock.advance(1001);
    const url = standIn(binding)?.getAttribute("src");
    expect(url).toBeTruthy();
    expect(counters.staticImageCaptures).toBe(1);

    // A host "not now" — it did not say the pixels moved, so the still is parked, not revoked.
    swapper.invalidate();
    expect(standIn(binding)).toBeNull();
    expect(revokedUrls).toEqual([]);

    await clock.advance(1001);
    expect(standIn(binding)?.getAttribute("src")).toBe(url);
    expect(counters.staticImageReuseHits).toBe(1);
    // The whole point: the re-freeze went nowhere near the GPU.
    expect(counters.staticImageCaptures).toBe(1);
    expect(counters.staticImageEncodes).toBe(1);
    swapper.dispose();
  });
});

// ---- baking and claiming, through the CAPTURE-HOOK source ---------------------------------------
//
// The second-appearance shortcut has to work on the source that cannot be read directly, or the
// WebGPU half of a fleet keeps paying full price. `bakeStill` reuses the whole encode tail, so what
// is pinned here is that the tail really is shared: a bake goes through the hook, publishes an entry
// held by nobody, and a later surface claims those pixels without touching the GPU.

describe("frozen-surface image swap — banking a still from a capture hook", () => {
  it("bakes through the HOOK, retains the entry, and a later surface claims it for free", async () => {
    const clock = captureScheduler();
    const counters = newCounters();
    const swapper = captureSwapper(
      quietPolicy(clock, {
        gate: { kind: "quiet-window", quietMs: 1000, keyedQuietMs: 0 },
        encode: { stillCacheBytes: 1 << 20 },
      }),
      counters,
    );
    let captures = 0;
    // The donor: a surface on its way out, whose canvas cannot be read at all. Its pixels only exist
    // through the hook, which is exactly the case v1 could not bank.
    const donorCanvas = capturedCanvas();
    const settled: boolean[] = [];
    swapper.bakeStill(
      {
        canvas: donorCanvas,
        captureCanvas: async () => {
          captures++;
          return capturedCanvas();
        },
      },
      "burst-frame",
      counters,
      (published) => settled.push(published),
    );
    await clock.advance(1);

    expect(settled).toEqual([true]);
    expect(captures).toBe(1);
    expect(counters.staticStillBakes).toBe(1);
    expect(counters.staticImageCaptures).toBe(1);
    expect(counters.staticImageEncodes).toBe(1);
    // The bake read the HOOK's canvas, never the donor's own — the whole point of that path.
    expect(blobSources).not.toContain(donorCanvas);
    expect(liveStaticImageUrlCount()).toBe(1);
    expect(counters.staticImagesLive).toBe(0); // banked, not shown

    const binding = captureBinding(async () => {
      captures++;
      return capturedCanvas();
    });
    swapper.attach(binding);
    expect(claimStaticStill(binding, "burst-frame", counters)).toBe(true);
    await settle();

    expect(standIn(binding)).toBeTruthy();
    expect(counters.staticStillMounts).toBe(1);
    // No second capture, no second encode: the claim never went near the GPU.
    expect(captures).toBe(1);
    expect(counters.staticImageEncodes).toBe(1);
    swapper.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });

  it("counts a claim whose <img> will not decode as a HIT that never mounted", async () => {
    const clock = captureScheduler();
    const counters = newCounters();
    const swapper = captureSwapper(
      quietPolicy(clock, {
        gate: { kind: "quiet-window", quietMs: 1000, keyedQuietMs: 0 },
        encode: { stillCacheBytes: 1 << 20 },
      }),
      counters,
    );
    swapper.bakeStill(
      { canvas: capturedCanvas(), captureCanvas: async () => capturedCanvas() },
      "burst-frame",
      counters,
    );
    await clock.advance(1);
    expect(liveStaticImageUrlCount()).toBe(1);

    decodeFails = true;
    const binding = captureBinding(async () => capturedCanvas());
    swapper.attach(binding);
    expect(claimStaticStill(binding, "burst-frame", counters)).toBe(true);
    await settle();

    // The key WAS there — that is what the hit says — and the pixels still never reached the screen.
    // The gap between the two counters is the whole diagnosis.
    expect(counters.staticStillCacheHits).toBe(1);
    expect(counters.staticStillMounts).toBe(0);
    expect(standIn(binding)).toBeNull();
    expect(binding.canvas.style.display).toBe("");
    expect(counters.staticImageFailures).toBe(1);
    swapper.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });
});
