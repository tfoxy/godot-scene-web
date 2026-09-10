// jsdom (gsw default env).
//
// COVERAGE semantics for Godot particle shaders: where a sprite's final alpha comes from.
//
// Half of STS2's VFX shader family derives coverage from the source texture's RED channel
// (`vfx_grayscale_particle_shader`: `COLOR = vec4(lut(tex.r).rgb, vertex_color.a * tex.r)`), and those sheets
// are GRAYSCALE PNGs with no alpha channel — so taking alpha from `tex.a` (1.0 everywhere) draws an opaque
// SQUARE where the game draws a soft glow. Three more pieces ride with it: a constant erosion smoothstep, a
// quad-shaped `mask` sampler, and the polar UV remap that turns a radial sheet into a ring.
//
// Covered here: the config normalization + defaults, the draw-time uniform plumbing, the texture-unit
// discipline (mask on unit 2, TEXTURE0 restored), the fragment's ORDERING invariants (coverage is read
// PRE-LUT; the mask samples the quad, not the flipbook cell), and the compat contract — a spec with NO
// coverage fields drives every flag to 0, i.e. renders exactly as it did before.

import {
  drawParticles,
  getParticleProgram,
} from "@godot-scene-web/canvas-effects/webgl";
import { InstanceBuffer } from "@godot-scene-web/effects/particles";
import { normalizeParticleSpecConfig as normalizeParticleConfig } from "@godot-scene-web/html/runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FRAGMENT_SRC } from "../../canvas-effects/src/particle-webgl";
import { createParticleRuntime } from "../src/particles/runtime";
import { __resetStaticParticleFrameCacheForTest } from "../src/particles/static-frame-cache";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { __resetSharedForTest, type SharedGl } from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

interface GlCall {
  name: string;
  args: unknown[];
}

// A fake WebGL2 context that RECORDS the calls the binding assertions care about (same shape as
// particles-lut.test.ts's).
function recordingGl(): { gl: WebGL2RenderingContext; calls: GlCall[] } {
  const calls: GlCall[] = [];
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
    createFramebuffer: () => ({}),
    createVertexArray: () => ({}),
  };
  const enums = new Map<string, number>();
  const gl = new Proxy(overrides, {
    get: (target, key: string) => {
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
        if (!enums.has(key)) enums.set(key, 1000 + enums.size);
        return enums.get(key);
      }
      if (key in target) {
        return (...args: unknown[]) => {
          calls.push({ name: key, args });
          return target[key](...args);
        };
      }
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, calls };
}

function fakeShared(gl: WebGL2RenderingContext): SharedGl {
  return {
    canvas: document.createElement("canvas"),
    gl,
    quad: {} as WebGLBuffer,
  };
}

function oneInstanceBuffer(): InstanceBuffer {
  const buffer = new InstanceBuffer(1);
  buffer.push(0, 0, 8, 8, 0, 1, 1, 1, 1, 0);
  return buffer;
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    if (kind === "2d") return new Proxy({}, { get: () => () => undefined });
    return null;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
});

afterEach(() => {
  __resetSharedForTest();
});

describe("coverage fields in the parsed config", () => {
  it("defaults to the pre-coverage behaviour: alpha coverage, no erosion, no mask, no polar remap", () => {
    const cfg = normalizeParticleConfig({});
    expect(cfg.alphaFromRed).toBe(false);
    expect(cfg.alphaErode).toBeNull();
    expect(cfg.maskUrl).toBeNull();
    expect(cfg.uvPolar).toBe(false);
  });

  it("carries the authored values through", () => {
    const cfg = normalizeParticleConfig({
      alphaFromRed: true,
      alphaErode: { threshold: 0.2012, softness: 0.5 },
      maskUrl: "/res/images/vfx/power_applied/power_applied_noise_mask.png",
      uvPolar: true,
    });
    expect(cfg.alphaFromRed).toBe(true);
    expect(cfg.alphaErode).toEqual({ threshold: 0.2012, softness: 0.5 });
    expect(cfg.maskUrl).toBe(
      "/res/images/vfx/power_applied/power_applied_noise_mask.png",
    );
    expect(cfg.uvPolar).toBe(true);
  });

  it("rejects a malformed erosion pair instead of poisoning the smoothstep with NaN", () => {
    expect(
      normalizeParticleConfig({ alphaErode: { threshold: 0.5 } as never })
        .alphaErode,
    ).toBeNull();
    expect(
      normalizeParticleConfig({ alphaErode: "0.5" as never }).alphaErode,
    ).toBeNull();
    // A NEGATIVE softness would make smoothstep's edges cross (undefined in GLSL) — clamped to a hard step.
    expect(
      normalizeParticleConfig({
        alphaErode: { threshold: 0.4, softness: -1 },
      }).alphaErode,
    ).toEqual({ threshold: 0.4, softness: 0 });
  });
});

describe("fragment ordering invariants", () => {
  it("reads coverage from the RED channel BEFORE the LUT rewrites RGB", () => {
    // The LUT is indexed by the SAME red channel, so a post-LUT read would sample the LUT's own output
    // (a white stop => coverage 1 everywhere => the solid white block the LUT round shipped).
    const coverage = FRAGMENT_SRC.indexOf("float coverage =");
    const lut = FRAGMENT_SRC.indexOf("texture(u_lutTex");
    expect(coverage).toBeGreaterThan(0);
    expect(lut).toBeGreaterThan(coverage);
    expect(FRAGMENT_SRC).toContain(
      "float coverage = u_alphaFromRed == 1 ? tex.r : tex.a;",
    );
  });

  it("samples the mask over the QUAD (v_quad), never the flipbook-mapped v_uv", () => {
    expect(FRAGMENT_SRC).toContain("texture(u_maskTex, v_quad)");
  });

  it("erodes coverage, then masks it, then publishes it as the sprite's alpha", () => {
    const erode = FRAGMENT_SRC.indexOf("coverage = smoothstep(");
    const mask = FRAGMENT_SRC.indexOf("coverage *= texture(u_maskTex");
    const publish = FRAGMENT_SRC.indexOf("tex.a = coverage;");
    expect(erode).toBeGreaterThan(0);
    expect(mask).toBeGreaterThan(erode);
    expect(publish).toBeGreaterThan(mask);
  });

  it("maps the polar remap back into the particle's own flipbook cell", () => {
    // Godot's polar_coordinates(UV, vec2(0.5), 1, 1): radius x 2, angle / 2pi, both wrapped.
    expect(FRAGMENT_SRC).toContain("float radius = length(dir) * 2.0;");
    expect(FRAGMENT_SRC).toContain(
      "uv = (v_cell + mod(vec2(radius, angle), 1.0)) / vec2(u_hframes, u_vframes);",
    );
  });
});

describe("drawParticles coverage plumbing", () => {
  const draw = (
    opts: Partial<Parameters<typeof drawParticles>[3]> = {},
  ): {
    calls: GlCall[];
    gl: WebGL2RenderingContext;
    program: NonNullable<ReturnType<typeof getParticleProgram>>;
  } => {
    const { gl, calls } = recordingGl();
    const program = getParticleProgram(gl);
    if (!program) throw new Error("program");
    calls.length = 0;
    drawParticles(fakeShared(gl), program, oneInstanceBuffer(), {
      texture: {} as WebGLTexture,
      textured: true,
      hframes: 1,
      vframes: 1,
      blendMode: 0,
      viewportW: 64,
      viewportH: 64,
      ...opts,
    });
    return { calls, gl, program };
  };

  it("drives every flag to 0 for a spec with NO coverage fields (the compat contract)", () => {
    const { calls, gl, program } = draw();
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uAlphaFromRed, 0],
    });
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uErode, 0],
    });
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uMask, 0],
    });
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uUvPolar, 0],
    });
    // Unit 2 is explicitly UNBOUND, so a masked system drawn just before can't leak its mask into this one.
    const unit2 = calls.findIndex(
      (c) => c.name === "activeTexture" && c.args[0] === gl.TEXTURE2,
    );
    expect(unit2).toBeGreaterThanOrEqual(0);
    expect(calls[unit2 + 1]).toEqual({
      name: "bindTexture",
      args: [gl.TEXTURE_2D, null],
    });
  });

  it("turns on alphaFromRed / erosion / polar and passes the erosion factors", () => {
    const { calls, program } = draw({
      alphaFromRed: true,
      erode: { threshold: 0.2012, softness: 0.5 },
      uvPolar: true,
    });
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uAlphaFromRed, 1],
    });
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uErode, 1],
    });
    expect(calls).toContainEqual({
      name: "uniform2f",
      args: [program.uErodeFactors, 0.2012, 0.5],
    });
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uUvPolar, 1],
    });
  });

  it("binds the mask on texture unit 2 and points the sampler at it", () => {
    const maskTexture = {} as WebGLTexture;
    const { calls, gl, program } = draw({ maskTexture });
    const activeIdx = calls.findIndex(
      (c) => c.name === "activeTexture" && c.args[0] === gl.TEXTURE2,
    );
    expect(activeIdx).toBeGreaterThanOrEqual(0);
    expect(calls[activeIdx + 1]).toEqual({
      name: "bindTexture",
      args: [gl.TEXTURE_2D, maskTexture],
    });
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uMaskTex, 2],
    });
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uMask, 1],
    });
  });

  it("restores TEXTURE0 after the LUT + mask units (the shared context's ambient unit)", () => {
    const { calls, gl } = draw({
      maskTexture: {} as WebGLTexture,
      lutTexture: {} as WebGLTexture,
    });
    const units = calls
      .filter((c) => c.name === "activeTexture")
      .map((c) => c.args[0]);
    // 0 (sprite) -> 1 (lut) -> 2 (mask) -> 0 again.
    expect(units).toEqual([gl.TEXTURE0, gl.TEXTURE1, gl.TEXTURE2, gl.TEXTURE0]);
  });
});

// End-to-end through the runtime: a mounted node whose spec carries the coverage fields must reach the draw
// with them (the runtime owns the mask texture's lifetime, so a spec-only test would not catch a missing bind).
describe("runtime → draw wiring", () => {
  let rafQueue: FrameRequestCallback[] = [];
  let recorded: GlCall[] = [];
  let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let origRAF: typeof globalThis.requestAnimationFrame;
  let origRO: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    recorded = [];
    rafQueue = [];
    origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = ((kind: string) => {
      if (kind === "webgl2") {
        const { gl, calls } = recordingGl();
        recorded = calls;
        return gl;
      }
      if (kind === "2d") return new Proxy({}, { get: () => () => undefined });
      return null;
    }) as typeof HTMLCanvasElement.prototype.getContext;
    origRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      rafQueue.push(cb)) as typeof globalThis.requestAnimationFrame;
    origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = makeResizeObserverStub();
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = origGetContext;
    globalThis.requestAnimationFrame = origRAF;
    globalThis.ResizeObserver = origRO;
    document.body.innerHTML = "";
  });

  const mount = (over: Record<string, unknown>): void => {
    const node = document.createElement("div");
    node.setAttribute("data-godot-particle-runtime", "1");
    node.setAttribute(
      "data-godot-particle-specs",
      JSON.stringify({
        kind: "GPUParticles2D",
        amount: 4,
        lifetime: 1,
        emitting: true,
        initialVelocityMin: 40,
        initialVelocityMax: 40,
        blendMode: 0,
        ...over,
      }),
    );
    const self = document.createElement("div");
    self.className = SELF_LAYER_CLASS;
    Object.defineProperty(self, "clientWidth", { get: () => 100 });
    Object.defineProperty(self, "clientHeight", { get: () => 100 });
    node.appendChild(self);
    document.body.appendChild(node);
    const runtime = createParticleRuntime(document.body, {
      enableParticles: true,
      staticParticles: true,
    } as never);
    runtime.reconcile();
    for (const cb of rafQueue.splice(0)) cb(0);
  };

  const uniformValues = (index: number): unknown[] =>
    recorded
      .filter((c) => c.name === "uniform1i" || c.name === "uniform2f")
      .map((c) => c.args[index]);

  it("passes a spec's coverage fields (and its mask texture) down to the draw", () => {
    mount({
      alphaFromRed: true,
      uvPolar: true,
      alphaErode: { threshold: 0.2012, softness: 0.5 },
      maskUrl: "/res/images/vfx/power_applied/power_applied_noise_mask.png",
    });
    // The erosion pair is unique enough to identify without uniform locations.
    expect(
      recorded.some(
        (c) =>
          c.name === "uniform2f" && c.args[1] === 0.2012 && c.args[2] === 0.5,
      ),
    ).toBe(true);
    // Four coverage toggles were written as 1 (alphaFromRed, erode, mask, uvPolar) — the mask one proves the
    // runtime created + bound a texture for `maskUrl` (a null mask would have written 0).
    const ones = uniformValues(1).filter((v) => v === 1).length;
    expect(ones).toBeGreaterThanOrEqual(4);
    expect(uniformValues(1)).toContain(2); // u_maskTex -> unit 2
  });

  it("writes every toggle OFF for a spec with no coverage fields", () => {
    mount({});
    expect(
      recorded.some((c) => c.name === "uniform2f" && c.args[1] === 0),
    ).toBe(true);
    // The only `1` written is a sampler's UNIT index (u_lutTex -> 1); every coverage TOGGLE is 0. This spec
    // is untextured, so u_textured is 0 too — i.e. one `1` in total.
    const drawUniforms = recorded.filter((c) => c.name === "uniform1i");
    expect(drawUniforms.filter((c) => c.args[1] === 2)).toHaveLength(1); // u_maskTex is still addressed
    expect(drawUniforms.filter((c) => c.args[1] === 1)).toHaveLength(1);
  });
});
