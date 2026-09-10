// jsdom (gsw default env).
//
// Parked-blend neutralization (`parkStaticParticleBlend`): in `staticParticles` mode a binding's
// canvas is drawn once and parked — but the HOST NODE's non-normal `mix-blend-mode` (additive VFX →
// `plus-lighter`) would keep a standing compositor blend render surface for pixels that never
// change. With the option, the runtime forces the node's inline blend to `normal` while parked and
// restores the saved value on unpark (live resume, dispose). Default OFF must be byte-identical.
// Same fake-GL + hand-flushed rAF harness as `particles-static.test.ts`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createParticleRuntime } from "../src/particles/runtime";
import { __resetStaticParticleFrameCacheForTest } from "../src/particles/static-frame-cache";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

const animatedOptions = { enableParticles: true, parkStaticParticleBlend: true } as never;
const parkOptions = {
  enableParticles: true,
  staticParticles: true,
  parkStaticParticleBlend: true,
} as never;
const legacyStaticOptions = { enableParticles: true, staticParticles: true } as never;

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
  return new Proxy(overrides, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
}

// Controllable rAF: queue callbacks, flush them by hand so park/unpark timing is observable.
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
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind: string) {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return new Proxy({}, { get: () => () => undefined });
    return null;
  } as typeof HTMLCanvasElement.prototype.getContext;
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
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  rafQueue = [];
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// A non-additive (blendMode 0) spec so the draw path never hits the additive accumulator FBO under
// the fake GL. The node-level CSS blend under test is independent of the spec's own blendMode.
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
  blend?: string,
  specJson = spec(),
): { node: HTMLElement; self: HTMLElement } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", specJson);
  if (blend !== undefined) node.style.mixBlendMode = blend;
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  Object.defineProperty(self, "clientWidth", { get: () => 100, configurable: true });
  Object.defineProperty(self, "clientHeight", { get: () => 100, configurable: true });
  node.appendChild(self);
  return { node, self };
}

function mount(...nodes: HTMLElement[]): HTMLElement {
  const root = document.createElement("div");
  for (const node of nodes) root.appendChild(node);
  document.body.appendChild(root);
  return root;
}

describe("particle runtime — parked-blend neutralization (parkStaticParticleBlend)", () => {
  it("parks an additive node's blend to normal while frozen; dispose restores it verbatim", () => {
    const { node, self } = particleNode("plus-lighter");
    const root = mount(node);

    const rt = createParticleRuntime(root, parkOptions);
    rt.reconcile(); // static + option → neutralized synchronously at reconcile (before the tick)
    expect(node.style.mixBlendMode).toBe("normal");

    flushRaf(); // warm + draw + park — stays neutralized
    expect(node.style.mixBlendMode).toBe("normal");
    expect(self.querySelector("[data-godot-particle-canvas]")).toBeTruthy();

    rt.dispose(); // preview spans return → the blend they rely on comes back exactly as found
    expect(node.style.mixBlendMode).toBe("plus-lighter");
  });

  it("valve OFF (option absent) is byte-identical: the blend is never touched", () => {
    const { node } = particleNode("plus-lighter");
    const root = mount(node);

    const rt = createParticleRuntime(root, legacyStaticOptions);
    rt.reconcile();
    flushRaf();
    expect(node.style.mixBlendMode).toBe("plus-lighter");
    rt.dispose();
    expect(node.style.mixBlendMode).toBe("plus-lighter");
  });

  it("animated mode never neutralizes (dynamic visuals byte-identical); toggling static parks and resumes", () => {
    const { node } = particleNode("plus-lighter");
    const root = mount(node);

    const rt = createParticleRuntime(root, animatedOptions);
    rt.reconcile();
    flushRaf();
    expect(node.style.mixBlendMode).toBe("plus-lighter"); // live sim → untouched

    rt.setStaticParticles(true); // enter the parked world…
    flushRaf();
    expect(node.style.mixBlendMode).toBe("normal");

    rt.setStaticParticles(false); // …and leave it: restored IMMEDIATELY, not on a later tick
    expect(node.style.mixBlendMode).toBe("plus-lighter");
    rt.dispose();
  });

  it("a node without any blend gets no inline 'normal' spam", () => {
    const { node } = particleNode(); // no inline mix-blend-mode
    const root = mount(node);

    const rt = createParticleRuntime(root, parkOptions);
    rt.reconcile();
    flushRaf();
    expect(node.style.mixBlendMode).toBe("");
    rt.dispose();
    expect(node.style.mixBlendMode).toBe("");
  });

  it("heals a host style writer re-imposing the blend mid-park, and still restores the ORIGINAL", () => {
    const { node } = particleNode("multiply"); // original blend ≠ the clobber value below
    const root = mount(node);

    const rt = createParticleRuntime(root, parkOptions);
    rt.reconcile();
    flushRaf();
    expect(node.style.mixBlendMode).toBe("normal");

    // A host style pass rewrites the node blend WITHOUT touching any effect marker (so nothing
    // kicks the loop). The host's next reconcile call is the heal point.
    node.style.mixBlendMode = "plus-lighter";
    rt.reconcile();
    expect(node.style.mixBlendMode).toBe("normal");

    rt.dispose();
    expect(node.style.mixBlendMode).toBe("multiply"); // first-saved value wins, clobber forgotten
  });

  it("neutralizes a suspended (occluded) binding too — its parked canvas must not cost a surface", () => {
    const { node } = particleNode("plus-lighter");
    const cover = document.createElement("div");
    cover.setAttribute("data-godot-effects-suspended", "1");
    cover.appendChild(node);
    const root = mount(cover);

    const rt = createParticleRuntime(root, parkOptions);
    rt.reconcile(); // binding is suspended (no warm/draw) but still parked-blend-neutralized
    expect(node.style.mixBlendMode).toBe("normal");
    flushRaf();
    expect(node.style.mixBlendMode).toBe("normal");
    rt.dispose();
    expect(node.style.mixBlendMode).toBe("plus-lighter");
  });

  it("a spec re-key (one-shot re-trigger) restores then re-parks within the same reconcile", () => {
    const { node } = particleNode("plus-lighter");
    const root = mount(node);

    const rt = createParticleRuntime(root, parkOptions);
    rt.reconcile();
    flushRaf();
    expect(node.style.mixBlendMode).toBe("normal");

    // The host bumps the spec (epoch re-trigger) → old binding disposed (blend restored), new
    // binding created and immediately re-parked by the same reconcile's re-assert pass.
    node.setAttribute("data-godot-particle-specs", spec({ amount: 9 }));
    rt.reconcile();
    expect(node.style.mixBlendMode).toBe("normal");
    flushRaf(); // new binding warms + draws + parks
    expect(node.style.mixBlendMode).toBe("normal");

    rt.dispose();
    expect(node.style.mixBlendMode).toBe("plus-lighter");
  });
});
