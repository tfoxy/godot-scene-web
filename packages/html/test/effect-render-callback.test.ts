// jsdom (gsw default env).
//
// `GodotHtmlRenderOptions.onBindingRendered` — the ADDITIVE per-binding render notification both live effect
// runtimes fire right after they WROTE PIXELS into that binding's own canvas. The rule is the write, not the
// GL draw, so it covers the real draws (shader `renderNode` reaching `gl.drawArrays` — loop tick or the
// synchronous `renderBindingNow` path — and particle `drawBinding` reaching `drawParticles`), the STATIC-FRAME
// CACHE-HIT BLIT in both runtimes, and the particle clears that blank a finished burst. It must NOT fire where
// nothing was written: a parked/settled loop, a suspended binding, a zero-sized canvas, or when the option is
// absent (byte-identical behavior).
//
// WHO NEEDS THE BLIT. A consumer that COMPOSITES these canvases itself (couch-coop's canvas stage uploads each
// as a GPU texture and draws it as a quad) only ever learns a surface exists through this callback — and a
// fleet of identical frozen surfaces settles at ONE draw plus N-1 blits, so dropping the blit meant drawing one
// card's glow and losing the other six. Same fake-GL + hand-flushed rAF harness as webgl-static /
// particles-static.
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
  __resetStaticShaderFrameCacheForTest,
  createWebglShaderRuntime,
} from "../src/webgl/runtime";
import { createParticleRuntime } from "../src/particles/runtime";
import type { GodotEffectRenderInfo } from "../src/types";
import { __resetStaticParticleFrameCacheForTest } from "../src/particles/static-frame-cache";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

// A TIME-reading shader so `usesTime` is true; frozen mode renders it once and parks.
const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";
// Additive, and it reads SCREEN_UV: two of the three `GodotEffectRenderInfo` fields, off their defaults.
const SHADER_ADD =
  "shader_type canvas_item;\nrender_mode blend_add;\nvoid fragment() { COLOR = vec4(SCREEN_UV, TIME, 1.0); }";
// The third: a SCREEN_TEXTURE read, which only compiles under `enableScreenTextureCapture`.
const SHADER_SCREEN =
  "shader_type canvas_item;\nvoid fragment() { COLOR = texture(SCREEN_TEXTURE, SCREEN_UV) * TIME; }";

let drawCount = 0;
const node2dCalls = new Map<
  HTMLCanvasElement,
  { clears: number; blits: number }
>();

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
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

// Controllable rAF: queue callbacks, flush by hand so the loops' park/re-arm behavior is observable.
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
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") {
      const calls = { clears: 0, blits: 0 };
      node2dCalls.set(this, calls);
      return new Proxy(
        {},
        {
          get: (_target, key: string) => {
            if (key === "clearRect") return () => calls.clears++;
            if (key === "drawImage") return () => calls.blits++;
            return () => undefined;
          },
        },
      );
    }
    return null;
  } as typeof HTMLCanvasElement.prototype.getContext;
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
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  __resetStaticShaderFrameCacheForTest();
  drawCount = 0;
  node2dCalls.clear();
  rafQueue = [];
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// Collected callback events, so identity AND count are assertable.
type Rendered = {
  node: HTMLElement;
  canvas: HTMLCanvasElement;
  info: GodotEffectRenderInfo;
};
function collector(): {
  events: Rendered[];
  onBindingRendered: (
    node: HTMLElement,
    canvas: HTMLCanvasElement,
    info: GodotEffectRenderInfo,
  ) => void;
} {
  const events: Rendered[] = [];
  return {
    events,
    onBindingRendered: (node, canvas, info) =>
      events.push({ node, canvas, info }),
  };
}

// A TWO-ARGUMENT consumer, the shape every caller had before `info` existed. Declared with its own
// explicit type so the assignment below is the compile-time half of the back-compat claim: if the
// third parameter ever stopped being one TypeScript lets a callback ignore, this stops building.
const legacyEvents: HTMLElement[] = [];
const legacyCallback: (node: HTMLElement, canvas: HTMLCanvasElement) => void = (
  node,
) => {
  legacyEvents.push(node);
};

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

describe("webgl shader runtime — onBindingRendered", () => {
  it("fires once per REAL draw with the binding's node + canvas; a parked static loop stays silent", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    root.appendChild(node);
    document.body.appendChild(root);
    const { events, onBindingRendered } = collector();

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
      onBindingRendered,
    } as never);
    rt.reconcile();
    await settle();
    expect(events.length).toBe(0); // nothing drawn yet

    flushRaf(); // the one frozen-frame render
    expect(events.length).toBe(1);
    expect(events[0].node).toBe(node);
    expect(events[0].canvas.getAttribute("data-godot-shader-canvas")).toBe(
      "true",
    );
    expect(self.contains(events[0].canvas)).toBe(true);
    expect(drawCount).toBe(1);

    // Parked (frozen mode self-stops): further frames draw nothing → no further notifications.
    flushRaf();
    flushRaf();
    expect(events.length).toBe(1);
    rt.dispose();
  });

  // CACHE HITS ARE HANDLED AND REPORTED. A fleet of identical frozen nodes settles at ONE draw and
  // N-1 cache-hit blits, so a consumer that composites these canvases itself — uploading each as a
  // texture — would otherwise learn about exactly one of them and draw the rest nowhere. A later hit
  // for the SAME canvas need not write those identical pixels again, but still tells the consumer it
  // remains the current handled frame.
  it("reports cache-hit frames, but skips a redundant same-canvas blit", async () => {
    const root = document.createElement("div");
    const a = shaderNode("res://glow.gdshader");
    const b = shaderNode("res://glow.gdshader"); // identical shader/params/size → static-frame cache hit
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);
    const { events, onBindingRendered } = collector();

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
      onBindingRendered,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();

    // One real draw (a) and one cache-hit blit (b) — the stats keep that split — but BOTH canvases were
    // written this tick, so both are reported, each with its own node and its own canvas.
    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().cacheHits).toBe(1);
    expect(rt.stats().blitSkips).toBe(0);
    expect(events.length).toBe(2);
    expect(events.map((e) => e.node)).toEqual([a.node, b.node]);
    expect(events[0].canvas).not.toBe(events[1].canvas);
    expect(b.self.contains(events[1].canvas)).toBe(true);
    const aCalls = node2dCalls.get(events[0].canvas);
    const bCalls = node2dCalls.get(events[1].canvas);
    expect(aCalls).toEqual({ clears: 1, blits: 1 });
    expect(bCalls).toEqual({ clears: 1, blits: 1 });
    // …and they say so: the SAME `staticKey`, which is the whole reason the blit was legal. A host
    // uploading these canvases can upload one texture for both instead of two copies of one picture.
    expect(events[0].info.staticKey).not.toBeNull();
    expect(events[1].info.staticKey).toBe(events[0].info.staticKey);

    // Re-enable the image swap. It re-dirties both bindings without changing their static keys.
    // Their canvases already present those keys, so the cache path remains handled/reported but makes
    // zero 2D writes. This is the hot path the `blitSkips` counter exposes.
    rt.setStaticShaderImages(false);
    rt.setStaticShaderImages(true);
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().cacheHits).toBe(3);
    expect(rt.stats().blitSkips).toBe(2);
    expect(aCalls).toEqual({ clears: 1, blits: 1 });
    expect(bCalls).toEqual({ clears: 1, blits: 1 });
    expect(events.length).toBe(4);
    expect(events.slice(2).map((event) => event.node)).toEqual([
      a.node,
      b.node,
    ]);
    expect(events[2].info.staticKey).toBe(events[0].info.staticKey);
    expect(events[3].info.staticKey).toBe(events[0].info.staticKey);

    // Parked afterwards: a frozen loop that re-ticks handles nothing, so the count holds.
    flushRaf();
    flushRaf();
    expect(events.length).toBe(4);

    // A param delta on `a` changes the frame key → a REAL redraw of `a` alone → one more notification.
    a.node.setAttribute(
      "data-godot-shader-params",
      JSON.stringify({ width: 0.5 }),
    );
    rt.reconcile();
    flushRaf();
    expect(rt.stats().draws).toBe(2);
    expect(events.length).toBe(5);
    expect(events[4].node).toBe(a.node);
    rt.dispose();
  });

  it("fires on the synchronous renderBindingNow path (uv-window change)", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    root.appendChild(node);
    document.body.appendChild(root);
    const { events, onBindingRendered } = collector();

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
      onBindingRendered,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(events.length).toBe(1);

    // The uv-window change re-renders SYNCHRONOUSLY inside reconcile (anti-flicker path) — a real draw.
    self.setAttribute("data-godot-shader-uv-window", "0,0,0.5,0.5");
    rt.reconcile();
    expect(rt.stats().syncRenders).toBe(1);
    expect(events.length).toBe(2);
    expect(events[1].node).toBe(node);
    rt.dispose();
  });

  it("absent option: renders identically and never throws (byte-identical behavior)", async () => {
    const root = document.createElement("div");
    root.appendChild(shaderNode().node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
    } as never);
    rt.reconcile();
    await settle();
    expect(() => flushRaf()).not.toThrow();
    expect(drawCount).toBe(1);
    expect(rt.stats().draws).toBe(1);
    rt.dispose();
  });

  // `info`: the third argument, per binding. It is what a consumer that composites the canvas ITSELF
  // needs — the blend the runtime otherwise expresses only as a CSS `mix-blend-mode` on the node, and
  // the two "this frame depends on where it sits on the page" flags. It must describe THE BINDING that
  // drew, not the runtime, so the two nodes below carry deliberately different shaders.
  it("reports each binding's own blend and screen-read flags", async () => {
    const root = document.createElement("div");
    // DISTINCT, never-before-seen paths: the compiled-program cache is module-scoped and keyed by
    // shader id, so a path another case already compiled would be served that case's source.
    const plain = shaderNode("res://fx-plain.gdshader");
    const additive = shaderNode("res://fx-additive.gdshader");
    root.appendChild(plain.node);
    root.appendChild(additive.node);
    document.body.appendChild(root);
    const { events, onBindingRendered } = collector();

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async (path: string) =>
        path === "res://fx-additive.gdshader" ? SHADER_ADD : SHADER,
      staticShaders: true,
      onBindingRendered,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();

    expect(events.length).toBe(2);
    const infoOf = (node: HTMLElement) =>
      events.find((e) => e.node === node)?.info;
    expect(infoOf(plain.node)).toEqual({
      usesScreenTexture: false,
      usesScreenUv: false,
      blend: "mix",
      // Frozen, node-local, textures resolved: this frame IS content-addressed, so it is named.
      staticKey: expect.stringContaining(
        "res://fx-plain.gdshader",
      ) as unknown as string,
    });
    // `blend_add` + a SCREEN_UV read: the DOM path turns the first into `mix-blend-mode: plus-lighter`
    // on the node, which is exactly the fact a consumer drawing these pixels elsewhere cannot see.
    // …and a SCREEN_UV shader is NOT content-addressed — its output depends on where the node sits —
    // so it reports no key at all, which is what stops a host from sharing one texture between two of
    // them.
    expect(infoOf(additive.node)).toEqual({
      usesScreenTexture: false,
      usesScreenUv: true,
      blend: "add",
      staticKey: null,
    });
    expect(additive.node.style.mixBlendMode).toBe("plus-lighter");
    rt.dispose();
  });

  it("reports usesScreenTexture for a shader that samples the screen capture", async () => {
    const root = document.createElement("div");
    const { node } = shaderNode("res://ripple.gdshader");
    root.appendChild(node);
    document.body.appendChild(root);
    const { events, onBindingRendered } = collector();

    // Without `enableScreenTextureCapture` such a shader is refused outright (CSS/SVG fallback), so
    // there would be no binding to report about — the option is what makes the flag reachable at all.
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER_SCREEN,
      enableScreenTextureCapture: true,
      staticShaders: true,
      onBindingRendered,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();

    expect(events.length).toBe(1);
    expect(events[0].info.usesScreenTexture).toBe(true);
    rt.dispose();
  });

  // BACK COMPAT, at runtime as well as at the type level (see `legacyCallback`): a consumer written
  // against the two-argument signature keeps working, and the extra argument it ignores changes
  // nothing about the frames it sees.
  it("still drives a two-argument consumer", async () => {
    const root = document.createElement("div");
    const { node } = shaderNode();
    root.appendChild(node);
    document.body.appendChild(root);
    legacyEvents.length = 0;

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
      onBindingRendered: legacyCallback,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(legacyEvents).toEqual([node]);
    rt.dispose();
  });
});

// A non-additive (blendMode 0) spec so the draw path never hits the additive accumulator FBO under the fake GL.
function particleSpec(over: Record<string, unknown> = {}): string {
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

describe("particle runtime — onBindingRendered", () => {
  it("static mode: fires once per binding on the warm+draw; the parked loop stays silent", () => {
    const root = document.createElement("div");
    const a = particleNode(particleSpec());
    const b = particleNode(particleSpec({ amount: 4 }));
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);
    const { events, onBindingRendered } = collector();

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      onBindingRendered,
    } as never);
    rt.reconcile();
    expect(events.length).toBe(0);

    flushRaf(); // the one static warm+draw tick
    expect(events.length).toBe(2);
    expect(new Set(events.map((e) => e.node))).toEqual(
      new Set([a.node, b.node]),
    );
    for (const e of events) {
      expect(e.canvas.getAttribute("data-godot-particle-canvas")).toBe("true");
    }
    // Two DISTINCT specs, so neither can serve the other from the static-frame cache: here, and only
    // here, the notifications and the instanced draws are 1:1. The twin case below is the one that
    // separates "pixels were written" from "the GPU drew".
    expect(events.length).toBe(rt.stats().draws);

    // Parked: nothing further fires.
    flushRaf();
    expect(events.length).toBe(2);
    rt.dispose();
  });

  // The particle twin of the shader cache-hit case, and the reason a phone's frozen fleet matters: N
  // systems built from ONE spec are pixel-identical by construction (the CPU simulation is seeded and
  // deterministic), so gsw warms and draws once and blits the rest. Each blit still writes a canvas.
  it("static mode: fires on the identical-frame cache-hit blit as well as the draw", () => {
    const root = document.createElement("div");
    const spec = particleSpec({ seed: 7 });
    const a = particleNode(spec);
    const b = particleNode(spec); // byte-identical spec + box → static-frame cache hit
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);
    const { events, onBindingRendered } = collector();

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      onBindingRendered,
    } as never);
    rt.reconcile();
    flushRaf();

    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().cacheHits).toBe(1);
    expect(events.length).toBe(2);
    expect(new Set(events.map((e) => e.node))).toEqual(
      new Set([a.node, b.node]),
    );
    expect(events[0].canvas).not.toBe(events[1].canvas);
    // One key for the two of them — the licence to share a texture, exactly as on the shader side.
    expect(events[0].info.staticKey).not.toBeNull();
    expect(events[1].info.staticKey).toBe(events[0].info.staticKey);
    rt.dispose();
  });

  // The other half of the promise: an UNKEYED frame must say so. A live-simulating system's frame is a
  // function of when it was sampled, not of its spec, so two of them are not interchangeable — and a
  // host that shared one texture between them would freeze both onto one system's phase.
  it("live mode: reports no staticKey (the frame is not content-addressed)", () => {
    const root = document.createElement("div");
    const { node } = particleNode(particleSpec());
    root.appendChild(node);
    document.body.appendChild(root);
    const { events, onBindingRendered } = collector();

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      onBindingRendered,
    } as never);
    rt.reconcile();
    flushRaf();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].node).toBe(node);
    expect(events[0].info.staticKey).toBeNull();
    rt.dispose();
  });

  // A CLEAR IS A WRITE. A burst with nothing alive left blanks its canvas, and a consumer holding the
  // burst's last frame as a texture has to be told — otherwise it keeps painting a burst that ended.
  it("fires on a frame that writes a BLANK canvas (no live instances)", () => {
    const root = document.createElement("div");
    const { node } = particleNode(particleSpec({ emitting: false, amount: 0 }));
    root.appendChild(node);
    document.body.appendChild(root);
    const { events, onBindingRendered } = collector();

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      onBindingRendered,
    } as never);
    rt.reconcile();
    flushRaf();

    // No instanced draw happened at all — the notification is the clear's, not a draw's.
    expect(rt.stats().draws).toBe(0);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].node).toBe(node);
    rt.dispose();
  });

  // A particle canvas resolves its own additive mode INSIDE the canvas (the accumulator pass), so what
  // comes out composites source-over like anything else. Reporting the material's mode here would make
  // a compositing consumer apply it a second time — hence the constant, asserted against an ADDITIVE
  // spec so the case would catch a well-meaning "pass the real blend through".
  it("reports the canvas-level constant, additive material or not", () => {
    const root = document.createElement("div");
    const { node } = particleNode(particleSpec({ blendMode: 1 }));
    root.appendChild(node);
    document.body.appendChild(root);
    const { events, onBindingRendered } = collector();

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      onBindingRendered,
    } as never);
    rt.reconcile();
    flushRaf();
    expect(events.length).toBe(1);
    expect(events[0].info).toMatchObject({
      usesScreenTexture: false,
      usesScreenUv: false,
      blend: "mix",
    });
    // A frozen, never-stepped system: its frame is a pure function of the spec, so it is named — and
    // the name carries the spec, which is what makes two twins' keys equal and everyone else's not.
    expect(events[0].info.staticKey).toContain('"blendMode":1');
    rt.dispose();
  });

  it("a suspended (occluded) binding draws nothing and does not fire", () => {
    const root = document.createElement("div");
    const { node } = particleNode(particleSpec());
    node.setAttribute("data-godot-effects-suspended", "1");
    root.appendChild(node);
    document.body.appendChild(root);
    const { events, onBindingRendered } = collector();

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
      onBindingRendered,
    } as never);
    rt.reconcile();
    flushRaf();
    expect(events.length).toBe(0);
    expect(rt.stats().draws).toBe(0);
    rt.dispose();
  });

  it("absent option: draws identically and never throws (byte-identical behavior)", () => {
    const root = document.createElement("div");
    root.appendChild(particleNode(particleSpec()).node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
    } as never);
    rt.reconcile();
    expect(() => flushRaf()).not.toThrow();
    expect(rt.stats().draws).toBe(1);
    rt.dispose();
  });
});
