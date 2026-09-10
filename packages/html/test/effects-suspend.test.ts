// jsdom (gsw default env).
//
// The EFFECT-SUSPEND contract (`src/effects-suspend.ts`): a host that knows a subtree is
// occluded (a full-screen dialog over the scene) stamps `data-godot-effects-suspended` on a
// container; both live runtimes then skip those bindings entirely — no shader render, no
// particle simulate/draw — and stop counting them as reasons to keep the rAF loop alive, so a
// fully covered scene parks the loop at zero per-frame cost. Resume happens on the reconcile
// that removes the attribute: shaders re-render at the CURRENT time, particle systems continue
// from their FROZEN state (never reset).
//
// These stub a fake WebGL2/2D context and a CONTROLLABLE rAF queue (flushed by hand), counting
// `drawArrays` (shader renders) / `drawArraysInstanced` (particle draws) to observe the work.
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
  EFFECTS_SUSPENDED_ATTR,
  isEffectsSuspended,
} from "../src/effects-suspend";
import { createParticleRuntime } from "../src/particles/runtime";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { createWebglShaderRuntime } from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

// A TIME-reading shader: it keeps the loop alive, so "the loop parked" is a real signal.
const TIME_SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME, 0.0, 0.0, 1.0); }";

let drawCount = 0;
let instancedDrawCount = 0;

function fakeGl(): unknown {
  const overrides: Record<string, (...args: unknown[]) => unknown> = {
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
    createFramebuffer: () => ({}),
    checkFramebufferStatus: () => 36053, // FRAMEBUFFER_COMPLETE
    drawArrays: () => {
      drawCount += 1;
      return undefined;
    },
    drawArraysInstanced: () => {
      instancedDrawCount += 1;
      return undefined;
    },
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

// Controllable rAF: queue callbacks, flush them by hand so parking is observable.
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

// A controllable clock (the runtimes read it through shared-gl's `performanceNow`), so a
// hand-flushed frame can carry a real dt — particles only spawn as time passes.
let clockMs = 0;
const advance = (ms: number): void => {
  clockMs += ms;
};

let origNow: () => number;
let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;

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
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest(); // also resets the shared clock origin
  clockMs = 0;
  drawCount = 0;
  instancedDrawCount = 0;
  rafQueue = [];
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

function sizedSelfLayer(): HTMLElement {
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
  return self;
}

// NB: unique shader paths per test — the program cache is module-scoped.
function shaderNode(path: string): { node: HTMLElement; self: HTMLElement } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  const self = sizedSelfLayer();
  node.appendChild(self);
  return { node, self };
}

// A non-additive (blendMode 0) continuous emitter so the draw path stays on the simple blit.
function particleSpec(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "GPUParticles2D",
    amount: 8,
    lifetime: 4,
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
  const self = sizedSelfLayer();
  node.appendChild(self);
  return { node, self };
}

const shaderCanvasIn = (self: HTMLElement): Element | null =>
  self.querySelector("[data-godot-shader-canvas]");

describe("isEffectsSuspended (the DOM contract)", () => {
  it("matches the element itself, any ancestor, and any attribute value", () => {
    const outer = document.createElement("div");
    const mid = document.createElement("div");
    const leaf = document.createElement("div");
    outer.appendChild(mid);
    mid.appendChild(leaf);

    expect(isEffectsSuspended(leaf)).toBe(false);

    outer.setAttribute(EFFECTS_SUSPENDED_ATTR, ""); // presence alone is the signal
    expect(isEffectsSuspended(leaf)).toBe(true);
    outer.setAttribute(EFFECTS_SUSPENDED_ATTR, "occluded-by-dialog");
    expect(isEffectsSuspended(leaf)).toBe(true);
    outer.removeAttribute(EFFECTS_SUSPENDED_ATTR);
    expect(isEffectsSuspended(leaf)).toBe(false);

    leaf.setAttribute(EFFECTS_SUSPENDED_ATTR, "1"); // on the node itself
    expect(isEffectsSuspended(leaf)).toBe(true);
  });

  it("names the attribute in the data-godot-* convention", () => {
    expect(EFFECTS_SUSPENDED_ATTR).toBe("data-godot-effects-suspended");
  });
});

describe("webgl shader runtime — suspend", () => {
  const options = { resolveShaderSource: async () => TIME_SHADER } as never;

  it("never renders a binding mounted under a suspended ancestor, and parks the loop", async () => {
    const root = document.createElement("div");
    const cover = document.createElement("div");
    cover.setAttribute(EFFECTS_SUSPENDED_ATTR, "1");
    const { node, self } = shaderNode("res://suspend-mounted.gdshader");
    cover.appendChild(node);
    root.appendChild(cover);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile();
    await settle();

    expect(shaderCanvasIn(self)).toBeTruthy(); // the binding still exists…
    flushRaf();
    expect(drawCount).toBe(0); // …but nothing is rendered
    expect(rafQueue.length).toBe(0); // and a TIME shader does NOT keep the loop alive
    rt.dispose();
  });

  it("suspends a live binding on the reconcile that adds the attribute, and resumes on the one that removes it", async () => {
    const root = document.createElement("div");
    const cover = document.createElement("div");
    const { node } = shaderNode("res://suspend-toggle.gdshader");
    cover.appendChild(node);
    root.appendChild(cover);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(drawCount).toBe(1);
    expect(rafQueue.length).toBe(1); // animated: the loop re-armed

    // The host covers the subtree.
    cover.setAttribute(EFFECTS_SUSPENDED_ATTR, "1");
    rt.reconcile();
    flushRaf();
    expect(drawCount).toBe(1); // frozen — no further renders
    expect(rafQueue.length).toBe(0); // …and the loop parked
    flushRaf();
    expect(drawCount).toBe(1);

    // The dialog closes.
    cover.removeAttribute(EFFECTS_SUSPENDED_ATTR);
    rt.reconcile();
    expect(rafQueue.length).toBe(1); // resume re-kicked the loop
    flushRaf();
    expect(drawCount).toBe(2); // re-rendered at the CURRENT time
    expect(rafQueue.length).toBe(1); // animating again
    rt.dispose();
  });

  it("keeps rendering an unsuspended sibling while the covered one is frozen", async () => {
    const root = document.createElement("div");
    const cover = document.createElement("div");
    cover.setAttribute(EFFECTS_SUSPENDED_ATTR, "1");
    cover.appendChild(shaderNode("res://suspend-sibling-a.gdshader").node);
    const visible = shaderNode("res://suspend-sibling-b.gdshader");
    root.append(cover, visible.node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile();
    await settle();

    flushRaf();
    expect(drawCount).toBe(1); // only the visible one drew
    expect(rafQueue.length).toBe(1); // …and it keeps the loop alive
    flushRaf();
    expect(drawCount).toBe(2);
    rt.dispose();
  });
});

describe("particle runtime — suspend", () => {
  const options = { enableParticles: true } as never;

  it("skips simulate + draw for a suspended system and parks the loop", () => {
    const root = document.createElement("div");
    const cover = document.createElement("div");
    cover.setAttribute(EFFECTS_SUSPENDED_ATTR, "1");
    const { node, self } = particleNode(particleSpec());
    cover.appendChild(node);
    root.appendChild(cover);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    // Born under a suspended ancestor ⇒ born PARKED, so its canvas is never even inserted: an
    // unsized canvas has no box to place, and the park exists precisely to not spend a compositor
    // layer on a surface nobody can see. The binding is real (it parked), it just has no DOM.
    expect(self.querySelector("[data-godot-particle-canvas]")).toBeNull();
    expect(rt.stats().dormantParks).toBe(1);
    expect(rafQueue.length).toBe(1); // reconcile kicked the loop once

    flushRaf();
    expect(instancedDrawCount).toBe(0); // nothing simulated or drawn
    expect(rafQueue.length).toBe(0); // a live emitter would have re-armed — parked instead
    rt.dispose();
  });

  it("FREEZES a running system (state kept, not reset) and resumes it mid-flight", () => {
    const root = document.createElement("div");
    const cover = document.createElement("div");
    const { node } = particleNode(particleSpec());
    cover.appendChild(node);
    root.appendChild(cover);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    flushRaf(); // t=0: nothing born yet, but the emitter is live so the loop re-arms
    advance(100);
    flushRaf();
    advance(100);
    flushRaf();
    const drewWhileLive = instancedDrawCount;
    expect(drewWhileLive).toBeGreaterThan(0); // particles are in flight
    expect(rafQueue.length).toBe(1);

    cover.setAttribute(EFFECTS_SUSPENDED_ATTR, "1");
    rt.reconcile();
    flushRaf();
    expect(instancedDrawCount).toBe(drewWhileLive); // frozen: no draw
    expect(rafQueue.length).toBe(0); // parked
    flushRaf();
    expect(instancedDrawCount).toBe(drewWhileLive);

    cover.removeAttribute(EFFECTS_SUSPENDED_ATTR);
    rt.reconcile();
    expect(rafQueue.length).toBe(1); // resume re-kicked the loop
    flushRaf();
    // The very first resumed frame draws instances: the frozen particles were still there (a
    // RESET system would be empty at t=0 and draw nothing).
    expect(instancedDrawCount).toBe(drewWhileLive + 1);
    rt.dispose();
  });

  it("does not warm/draw a suspended system in frozen (static) mode, and does once resumed", () => {
    const root = document.createElement("div");
    const cover = document.createElement("div");
    cover.setAttribute(EFFECTS_SUSPENDED_ATTR, "1");
    cover.appendChild(particleNode(particleSpec()).node);
    root.appendChild(cover);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticles: true,
    } as never);
    rt.reconcile();
    flushRaf();
    expect(instancedDrawCount).toBe(0); // the one-shot warm+draw is skipped too
    expect(rafQueue.length).toBe(0);

    cover.removeAttribute(EFFECTS_SUSPENDED_ATTR);
    rt.reconcile();
    flushRaf();
    expect(instancedDrawCount).toBe(1); // warmed + drawn once…
    expect(rafQueue.length).toBe(0); // …then parked again (static)
    rt.dispose();
  });

  it("keeps simulating an unsuspended sibling while the covered one is frozen", () => {
    const root = document.createElement("div");
    const cover = document.createElement("div");
    cover.setAttribute(EFFECTS_SUSPENDED_ATTR, "1");
    cover.appendChild(particleNode(particleSpec()).node);
    root.append(cover, particleNode(particleSpec()).node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    flushRaf();
    advance(100);
    flushRaf();
    advance(100);
    flushRaf();
    expect(instancedDrawCount).toBeGreaterThan(0); // the visible one runs…
    expect(rafQueue.length).toBe(1); // …and keeps the loop alive
    rt.dispose();
  });
});
