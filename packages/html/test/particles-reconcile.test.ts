// jsdom (gsw default env).
//
// The particle runtime is PERSISTENT + reconciled (mirrors the WebGL shader runtime): on a
// re-render it KEEPS a binding whose `data-godot-particle-specs` is unchanged (so a running
// simulation — ambient emitter or in-flight one-shot — is NOT reset by an unrelated re-render),
// re-inits ONLY a node whose spec changed, and disposes a node that left the DOM. These tests
// stub a fake WebGL2/2D context + a no-op rAF so only the create/reconcile bookkeeping runs.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createParticleRuntime } from "../src/particles/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

const options = { enableParticles: true } as never;

// A fake WebGL2 context: methods that must return truthy do; everything else is a harmless
// no-op. The render loop is disabled (no-op rAF) so draw calls never run.
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
  globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
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
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

function spec(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: "GPUParticles2D", amount: 4, lifetime: 1, emitting: true, ...over });
}

function particleNode(specJson: string): { node: HTMLElement; self: HTMLElement } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", specJson);
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  node.appendChild(self);
  return { node, self };
}

const canvasIn = (self: HTMLElement): Element | null =>
  self.querySelector("[data-godot-particle-canvas]");

describe("particle runtime reconcile (persist + reconcile)", () => {
  // Same self-layer contract as the WebGL shader runtime: a show_behind_parent child's
  // subtree precedes the node's OWN self-layer, so the runtime must use a direct-child
  // lookup or the overlay canvas mounts in the child's layer.
  it("mounts the canvas in the node's own self-layer, not a behind-child's", () => {
    const root = document.createElement("div");
    const { node, self } = particleNode(spec());
    const child = document.createElement("div");
    child.setAttribute("data-godot-show-behind-parent", "true");
    const childSelf = document.createElement("div");
    childSelf.className = SELF_LAYER_CLASS;
    child.appendChild(childSelf);
    node.insertBefore(child, self);
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    expect(canvasIn(self)).toBeTruthy();
    expect(canvasIn(childSelf)).toBeNull();
    rt.dispose();
  });

  it("keeps an unchanged node's binding (same canvas) across reconciles", () => {
    const root = document.createElement("div");
    const { node, self } = particleNode(spec());
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    const canvas = canvasIn(self);
    expect(canvas).toBeTruthy(); // binding created

    rt.reconcile(); // no DOM change → KEEP
    expect(canvasIn(self)).toBe(canvas); // SAME canvas element (sim not reset)
    rt.dispose();
  });

  it("re-inits ONLY a node whose spec signature changed (e.g. a restart-epoch bump)", () => {
    const root = document.createElement("div");
    const { node, self } = particleNode(spec({ restartEpoch: 0 }));
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    const canvas = canvasIn(self);
    expect(canvas).toBeTruthy();

    // A changed spec (a host bumping the restart epoch to re-trigger a one-shot burst).
    node.setAttribute("data-godot-particle-specs", spec({ restartEpoch: 1 }));
    rt.reconcile();
    const next = canvasIn(self);
    expect(next).toBeTruthy();
    expect(next).not.toBe(canvas); // re-initialised → a NEW canvas
    rt.dispose();
  });

  it("creates a binding for a new node and disposes one that left the DOM", () => {
    const root = document.createElement("div");
    const a = particleNode(spec());
    root.appendChild(a.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    expect(canvasIn(a.self)).toBeTruthy();

    const b = particleNode(spec());
    root.appendChild(b.node);
    rt.reconcile();
    expect(canvasIn(b.self)).toBeTruthy();

    // Remove node A → its binding is disposed (canvas removed); B is untouched.
    a.node.remove();
    rt.reconcile();
    expect(canvasIn(a.self)).toBeNull();
    expect(canvasIn(b.self)).toBeTruthy();
    rt.dispose();
  });

  it("setRenderScale resizes a binding's canvas backing store live, keeping the same canvas element", () => {
    const root = document.createElement("div");
    const { node, self } = particleNode(spec());
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    const canvas = canvasIn(self) as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    const widthAtScale1 = canvas.width;
    expect(widthAtScale1).toBeGreaterThan(1);

    // Halving renderScale halves the backing-store density (the low-end GPU-fill lever) — same canvas element,
    // smaller drawing buffer, no dispose+recreate (the running simulation is untouched).
    rt.setRenderScale(0.5);
    expect(canvasIn(self)).toBe(canvas);
    expect(canvas.width).toBeLessThan(widthAtScale1);

    // setFps is a callable live retune that doesn't throw.
    expect(() => rt.setFps(25)).not.toThrow();
    rt.dispose();
  });
});
