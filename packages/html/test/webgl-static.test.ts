// jsdom (gsw default env).
//
// Frozen-TIME (single-shot) shader mode: with `staticShaders`, a TIME-driven shader renders ONCE at a pinned
// representative TIME and the rAF loop SELF-STOPS (no per-frame re-render), and identical static frames are
// reused across nodes via the module cache (one GL draw + N cheap blits). These tests stub a fake WebGL2/2D
// context and a CONTROLLABLE rAF queue (flushed by hand) and count `drawArrays` to observe the loop + cache.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  __resetStaticShaderFrameCacheForTest,
  createWebglShaderRuntime,
} from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { SELF_LAYER_CLASS } from "../src/render-structure";

// A TIME-reading shader so `usesTime` is true (the case frozen mode actually changes).
const SHADER = "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";

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
  };
  return new Proxy(overrides, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
}

// Controllable rAF: queue callbacks, flush them by hand so we can observe whether the loop reschedules itself.
let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
  return q.length;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

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
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
  origRO = globalThis.ResizeObserver;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticShaderFrameCacheForTest();
  drawCount = 0;
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

function shaderNode(path = "res://s.gdshader"): { node: HTMLElement; self: HTMLElement } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  // Give the self-layer a non-zero size so syncCanvasSize makes a >0 canvas.
  Object.defineProperty(self, "clientWidth", { get: () => 100, configurable: true });
  Object.defineProperty(self, "clientHeight", { get: () => 50, configurable: true });
  node.appendChild(self);
  return { node, self };
}

describe("webgl runtime — frozen-TIME (static) mode", () => {
  it("renders a TIME shader ONCE and self-stops (no per-frame reschedule)", async () => {
    const root = document.createElement("div");
    root.appendChild(shaderNode().node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
    } as never);
    rt.reconcile();
    await settle();

    flushRaf(); // run the one queued tick → renders the frozen frame
    expect(drawCount).toBe(1);
    // Frozen: a TIME shader does NOT keep the loop alive, so nothing was rescheduled.
    expect(rafQueue.length).toBe(0);
    // And a further frame does no work.
    flushRaf();
    expect(drawCount).toBe(1);
    rt.dispose();
  });

  it("animated mode (default) keeps rescheduling the loop and re-rendering the TIME shader", async () => {
    const root = document.createElement("div");
    root.appendChild(shaderNode().node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();

    flushRaf();
    expect(drawCount).toBe(1);
    expect(rafQueue.length).toBe(1); // a TIME shader re-armed the loop
    flushRaf();
    expect(drawCount).toBe(2); // …and re-rendered
    rt.dispose();
  });

  it("setStaticShaders(false) re-arms the animation loop after a frozen frame", async () => {
    const root = document.createElement("div");
    root.appendChild(shaderNode().node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(drawCount).toBe(1);
    expect(rafQueue.length).toBe(0); // frozen → stopped

    rt.setStaticShaders(false); // back to animated → re-dirties + reschedules
    flushRaf();
    expect(drawCount).toBe(2);
    expect(rafQueue.length).toBe(1); // loop alive again
    rt.dispose();
  });

  it("reuses one GL draw across identical static nodes (cache hit blits instead of re-rendering)", async () => {
    const root = document.createElement("div");
    root.appendChild(shaderNode("res://glow.gdshader").node);
    root.appendChild(shaderNode("res://glow.gdshader").node); // identical shader/params/size
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
    } as never);
    rt.reconcile();
    await settle();

    flushRaf();
    // First node renders + caches; the second is an identical-frame cache hit → NO second GL draw.
    expect(drawCount).toBe(1);
    rt.dispose();
  });
});

describe("webgl runtime — self-layer resolution with show_behind_parent children", () => {
  // A behind-child renders BEFORE the parent's own self-layer (render-structure), so a
  // descendant querySelector would find the CHILD's layer first: the canvas then mounts in
  // the wrong element and the texture lookup misses `data-godot-shader-texture-url` →
  // solid-white TEXTURE (the map-node/relic "white rectangle" bug). The runtime must bind
  // the node's OWN (direct-child) self-layer.
  it("binds the node's own self-layer, not a behind-child's", async () => {
    const { node, self } = shaderNode();
    const child = document.createElement("div");
    child.setAttribute("data-godot-show-behind-parent", "true");
    const childSelf = document.createElement("div");
    childSelf.className = SELF_LAYER_CLASS;
    childSelf.style.filter = "url(#tint-1)";
    childSelf.style.backgroundImage = "url(outline.png)";
    child.appendChild(childSelf);
    node.insertBefore(child, self); // behind slot: child subtree precedes the own self-layer

    const root = document.createElement("div");
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();

    // Canvas mounts in the node's OWN layer…
    expect(self.querySelector("canvas")).toBeTruthy();
    // …and the behind-child's layer is untouched (no canvas, styles not clobbered).
    expect(childSelf.querySelector("canvas")).toBeNull();
    expect(childSelf.style.filter).toBe('url("#tint-1")');
    expect(childSelf.style.backgroundImage).toBe('url("outline.png")');
    rt.dispose();
  });
});

describe("createWebglShaderRuntime — setStaticShaders is always callable", () => {
  it("never throws when toggled with no bindings present", () => {
    const root = document.createElement("div");
    const rt = createWebglShaderRuntime(root, { resolveShaderSource: () => undefined } as never);
    expect(() => {
      rt.setStaticShaders(true);
      rt.setStaticShaders(false);
      rt.dispose();
    }).not.toThrow();
  });
});

// Instrumentation seam (WebglShaderRuntimeStats): purely observational counters on the render paths.
// These tests pin the increment points — a draw is a REAL GL draw (cross-checked against the fake-GL
// drawArrays count), a cache hit is the blit-without-draw path, a realloc is an actual width/height
// re-assignment — and that the two Fix-A/B seam counters stay 0 on today's code paths.
describe("webgl runtime — stats() counters", () => {
  it("counts draws + create-time canvas reallocs, and cacheHits on an identical-frame blit", async () => {
    const root = document.createElement("div");
    const a = shaderNode("res://glow.gdshader");
    const b = shaderNode("res://glow.gdshader"); // identical shader/params/size → static-frame cache hit
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
    } as never);
    rt.reconcile();
    await settle();
    // Create-time syncCanvasSize re-assigned each canvas from the jsdom default (300x150) to 100x50:
    // one realloc EVENT per binding, and nothing has drawn yet.
    expect(rt.stats().canvasReallocs).toBe(2);
    expect(rt.stats().draws).toBe(0);

    flushRaf(); // first node renders + caches; the second blits the cached frame (NO second GL draw)
    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().cacheHits).toBe(1);
    expect(rt.stats().draws).toBe(drawCount); // the counter tracks the REAL fake-GL drawArrays count

    // An update cycle: a param delta changes the quantized frame key → the next tick is a cache MISS
    // (a real GL draw), and only for the changed node.
    a.node.setAttribute("data-godot-shader-params", JSON.stringify({ width: 0.5 }));
    rt.reconcile();
    flushRaf();
    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().cacheHits).toBe(1);
    expect(rt.stats().draws).toBe(drawCount);

    // The Fix-A/B seams: frozen mode bypasses the fps cap today (no deferrals), and the frame-key
    // dirty gate does not exist yet (no skips). Nothing rendered synchronously either.
    expect(rt.stats().capDeferrals).toBe(0);
    expect(rt.stats().dirtySkips).toBe(0);
    expect(rt.stats().syncRenders).toBe(0);
    rt.dispose();
  });

  it("a uv-window change counts ONE synchronous render and ONE backing realloc", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().syncRenders).toBe(0);
    expect(rt.stats().canvasReallocs).toBe(1); // create-time sizing only

    // Clamp the node to a half-size visible window: updateBinding resizes the backing store (the
    // realloc) and re-renders SYNCHRONOUSLY (renderBindingNow — the anti-flicker path) with a new
    // window frame key (a real GL draw, not a cache hit).
    self.setAttribute("data-godot-shader-uv-window", "0,0,0.5,0.5");
    rt.reconcile();
    expect(rt.stats().syncRenders).toBe(1);
    expect(rt.stats().canvasReallocs).toBe(2);
    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().draws).toBe(drawCount);
    rt.dispose();
  });

  it("a capped ANIMATED tick waking before its boundary counts a capDeferral (and draws nothing)", async () => {
    const root = document.createElement("div");
    root.appendChild(shaderNode().node);
    document.body.appendChild(root);

    // "raf" pacing keeps the pre-parking rAF spin, so the hand-flushed queue drives the capped loop
    // (the default "timer" pacing would park on an uncontrollable setTimeout).
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      shaderFps: 1, // 1s cap — the flushes below land well inside the first boundary
      effectsLoopPacing: "raf",
    } as never);
    rt.reconcile();
    await settle();

    flushRaf(); // woke before the 1s boundary → deferred + re-armed, NO draw
    expect(rt.stats().capDeferrals).toBe(1);
    expect(rt.stats().draws).toBe(0);
    flushRaf();
    expect(rt.stats().capDeferrals).toBe(2);
    expect(rt.stats().draws).toBe(0);
    rt.dispose();
  });

  it("the no-op handle (no shader resolver) exposes all-zero stats", () => {
    const rt = createWebglShaderRuntime(document.createElement("div"), {} as never);
    expect(rt.stats()).toEqual({
      draws: 0,
      cacheHits: 0,
      blitSkips: 0,
      pinnedCanvasSyncs: 0,
      dirtySkips: 0,
      capDeferrals: 0,
      canvasReallocs: 0,
      syncRenders: 0,
      // NULL, not a zeroed object: `effectsProfiling` is unset, so nothing was measured.
      profile: null,
      // The renderer gate (see `webgpu-shader-gate.test.ts`) never opened on the no-op handle: there
      // is no WebGL2 context or no shader resolver, so there is no renderer at all and nothing was
      // ever asked for. "none" with a null reason and zero fallbacks is the shape that says so — a
      // real jsdom runtime under the default `effectsRenderer: "auto"` reports "webgl" with
      // `webgpuFallbacks: 1` and reason "no-navigator-gpu" instead.
      renderer: "none",
      webgpuFallbacks: 0,
      webgpuBindingFallbacks: 0,
      webgpuFallbackReason: null,
      webgpuSubmits: 0,
      webgpuDeviceLosses: 0,
      webgpuErrors: 0,
      staticImageSwaps: 0,
      staticImageReverts: 0,
      staticImageRevertsByCause: {
        "key-change": 0,
        "not-frozen": 0,
        draw: 0,
        "host-invalidate": 0,
        watchdog: 0,
        resize: 0,
        "dormancy-wake": 0,
        "decode-failure": 0,
      },
      staticImageEncodes: 0,
      staticImageFailures: 0,
      staticImageBusyDeferrals: 0,
      staticImageBusyForcedEncodes: 0,
      staticImageEncodeMs: 0,
      staticImageEncodeMaxMs: 0,
      staticImageSlowEncodes: 0,
      staticImageBackoffDeferrals: 0,
      staticImageClampedEncodes: 0,
      staticImageCaptures: 0,
      staticImageCaptureFailures: 0,
      staticImageBlankCaptures: 0,
      staticImageCaptureMs: 0,
      staticImageCaptureMaxMs: 0,
      staticImageReuseHits: 0,
      staticStillCacheHits: 0,
      staticStillCacheMisses: 0,
      staticStillMounts: 0,
      staticStillBakes: 0,
      staticStillRetainedEntries: 0,
      staticStillRetainedBytes: 0,
      staticImageUrlsLive: 0,
      staticImagesLive: 0,
    });
    rt.dispose();
  });
});

// OPT-IN per-frame cost attribution (`effectsProfiling`, see `ShaderProfile` and the particle
// runtime's fuller `particles-profiling.test.ts`). The shader half has two buckets — GL SUBMIT and
// GL→2D BLIT — and the same load-bearing rule: OFF is `null`, never a zeroed object, because "not
// measured" and "measured, cost nothing" are different facts.
describe("webgl runtime — effectsProfiling", () => {
  it("reports profile === null when the option is unset", async () => {
    const root = document.createElement("div");
    root.appendChild(shaderNode().node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(drawCount).toBe(1); // it really rendered…
    expect(rt.stats().profile).toBeNull(); // …and still measured nothing
    rt.dispose();
  });

  it("counts the loop's ticks + bindings and books finite submit/blit times when on", async () => {
    const root = document.createElement("div");
    root.appendChild(shaderNode("res://a.gdshader").node);
    root.appendChild(shaderNode("res://b.gdshader").node); // distinct ids → two real renders per tick
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      effectsProfiling: true,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf(); // a TIME shader keeps the loop armed, so each flush is one full tick
    flushRaf();

    const profile = rt.stats().profile;
    if (!profile)
      throw new Error("effectsProfiling: true must allocate a profile");
    expect(profile.ticks).toBe(2);
    expect(profile.bindings).toBe(4); // 2 ticks x 2 bindings
    for (const ms of [profile.glMs, profile.blitMs]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    expect(rt.stats().profile).toBe(profile); // the SAME live object each read
    rt.dispose();
  });
});
