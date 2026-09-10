// jsdom (gsw default env).
//
// PROGRAM WARMING. `compileProgramAsync` yields to the driver before it asks a blocking question, which on a
// device that exposes `KHR_parallel_shader_compile` makes a cold link nearly free. Without the extension —
// and real Android hardware does not have it; a Moto G86 answers null — `ready()` reports true immediately and
// `finish()` blocks on `LINK_STATUS` for as long as the driver needs. A consumer measured one such link at
// 90.3 ms of main thread, landing mid-combat because that frame was the first to want the shader.
//
// `warmPrograms` cannot make that link cheaper. It lets a consumer choose WHEN to pay it, which is a different
// claim and the one these tests pin: the cache the lazy create path consults is populated ahead of time, the
// lazy path itself is unchanged, and every way warming can fail leaves that path exactly where it was.

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
import { createWebglShaderRuntime } from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";

const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(1.0); }";

const glCalls = { createProgram: 0 };

function fakeGl(): unknown {
  const overrides: Record<string, () => unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    getActiveUniform: () => null,
    // Null, like the phone: `ready()` then answers true immediately and `finish()` is the blocking query.
    getExtension: () => null,
    getParameter: () => "",
    createShader: () => ({}),
    createProgram: () => {
      glCalls.createProgram++;
      return {};
    },
    createTexture: () => ({}),
    createBuffer: () => ({}),
    createVertexArray: () => ({}),
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
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
  globalThis.requestAnimationFrame = (() =>
    1) as typeof globalThis.requestAnimationFrame;
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
  glCalls.createProgram = 0;
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

function shaderNode(path = "res://s.gdshader"): HTMLElement {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  node.appendChild(self);
  return node;
}

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

describe("warmPrograms", () => {
  it("links a shader BEFORE any node asks for it, so the create path finds it cached", async () => {
    const resolve = vi.fn(async () => SHADER);
    const root = mount();
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: resolve,
    } as never);

    expect(
      await rt.warmPrograms([
        { shaderKey: "res://s.gdshader", path: "res://s.gdshader" },
      ]),
    ).toBe(1);
    expect(glCalls.createProgram).toBe(1);

    // The node arrives later — mid-combat, in the case this exists for — and compiles NOTHING.
    root.appendChild(shaderNode());
    rt.reconcile();
    await settle();
    expect(glCalls.createProgram).toBe(1);
    rt.dispose();
  });

  it("costs nothing for a shader that is already compiled, including its source fetch", async () => {
    const resolve = vi.fn(async () => SHADER);
    const root = mount();
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: resolve,
    } as never);
    // A key of its own: `programCache` is MODULE-wide (that is the point of it), so a key another test in this
    // file compiled would already be warm here and the first call below would prove nothing.
    const spec = [
      { shaderKey: "res://twice.gdshader", path: "res://twice.gdshader" },
    ];

    await rt.warmPrograms(spec);
    const fetches = resolve.mock.calls.length;
    expect(await rt.warmPrograms(spec)).toBe(1);
    expect(glCalls.createProgram).toBe(1);
    expect(resolve.mock.calls.length).toBe(fetches);
    rt.dispose();
  });

  it("counts a shader whose source will not resolve as a miss, and leaves the lazy path alone", async () => {
    const root = mount();
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => undefined,
    } as never);
    // A miss is not an error and must not throw: warming is an optimisation, and the node that wants this
    // shader later takes exactly the path it takes today (including its own unsupported-render report).
    expect(
      await rt.warmPrograms([
        { shaderKey: "res://missing.gdshader", path: "res://missing.gdshader" },
      ]),
    ).toBe(0);
    expect(glCalls.createProgram).toBe(0);
    rt.dispose();
  });

  it("survives a resolver that throws", async () => {
    const root = mount();
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => {
        throw new Error("offline");
      },
    } as never);
    expect(
      await rt.warmPrograms([
        { shaderKey: "res://x.gdshader", path: "res://x.gdshader" },
      ]),
    ).toBe(0);
    rt.dispose();
  });

  it("stops warming once the runtime is disposed", async () => {
    const root = mount();
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    const warm = rt.warmPrograms([
      { shaderKey: "res://a.gdshader", path: "res://a.gdshader" },
      { shaderKey: "res://b.gdshader", path: "res://b.gdshader" },
      { shaderKey: "res://c.gdshader", path: "res://c.gdshader" },
    ]);
    rt.dispose();
    await warm;
    // A dispose mid-warm must not keep feeding a dead context: the loop checks before each spec, so at most
    // the one already in flight lands.
    expect(glCalls.createProgram).toBeLessThanOrEqual(1);
  });

  it("is a no-op handle's no-op, so a caller needs no WebGL2 check of its own", async () => {
    const root = mount();
    // No resolver configured ⇒ the no-op runtime.
    const rt = createWebglShaderRuntime(root, {} as never);
    expect(await rt.warmPrograms([{ shaderKey: "res://s.gdshader" }])).toBe(0);
    rt.dispose();
  });
});
