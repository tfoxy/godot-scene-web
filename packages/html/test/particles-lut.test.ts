// jsdom (gsw default env).
//
// The per-TEXEL particle color LUT: Godot's VFX particle-shader family colors a particle with
// `COLOR = vec4(texture(lut, texture_color.rr).rgb, alpha) * vertex_color`, so the sprite sheet is a
// single-channel MASK and the real colors live in a `GradientTexture1D` sampler. Without it a consumer
// draws the raw red channel (STS2's energy orb / hit streaks rendered as a red-orange block).
//
// Covered here: the constant-interpolation bake (STS2 authors these LUTs with
// `interpolation_mode = 1`, hard steps), the bake/caching entry point, and the draw-time binding
// (unit 1 + the `u_lut` toggle, on and off).

import {
  drawParticles,
  getParticleProgram,
} from "@godot-scene-web/canvas-effects/webgl";
import { InstanceBuffer } from "@godot-scene-web/effects/particles";
import { normalizeParticleSpecConfig as normalizeParticleConfig } from "@godot-scene-web/html/runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lutTextureFor } from "../src/particles/runtime";
import {
  bakeGradient,
  GRADIENT_INTERPOLATE_CONSTANT,
  sampleGradient,
} from "../src/webgl/bake-texture";
import { __resetSharedForTest, type SharedGl } from "../src/webgl/shared-gl";

// The real `vfx_outward_streaks.tres` LUT (the energy orb's hit streaks): two stops,
// `interpolation_mode = 1` (CONSTANT) — mid grey held until 0.563, then white.
const STREAKS_LUT: Array<{
  offset: number;
  color: [number, number, number, number];
}> = [
  { offset: 0, color: [0.35, 0.35, 0.35, 1] },
  { offset: 0.56302524, color: [1, 1, 1, 1] },
];

// A fake WebGL2 context that RECORDS the calls the binding assertions care about.
interface GlCall {
  name: string;
  args: unknown[];
}
function recordingGl(): { gl: WebGL2RenderingContext; calls: GlCall[] } {
  const calls: GlCall[] = [];
  const overrides: Record<string, (...args: unknown[]) => unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    // Distinct objects per call so each uniform location is identifiable.
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
  // GL enum constants (any stable distinct value works): every SHOUTY key gets a memoized
  // number, so `gl.TEXTURE1` / `gl.NEAREST` are comparable in the assertions below.
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
  // `drawParticles` blits nothing here, but the runtime's canvas plumbing may ask for a 2D context.
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    if (kind === "2d") return new Proxy({}, { get: () => () => undefined });
    return null;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  __resetSharedForTest();
});

afterEach(() => {
  __resetSharedForTest();
});

describe("constant-interpolation gradients (Godot Gradient.interpolation_mode = 1)", () => {
  it("HOLDS each stop's color instead of blending toward the next", () => {
    // Just under the second stop the CONSTANT ramp is still the first stop's grey; linear
    // interpolation would already be ~99% of the way to white.
    expect(
      sampleGradient(STREAKS_LUT, 0.56, GRADIENT_INTERPOLATE_CONSTANT),
    ).toEqual([0.35, 0.35, 0.35, 1]);
    expect(sampleGradient(STREAKS_LUT, 0.56)[0]).toBeCloseTo(0.99, 1);
    // At/after the last stop both modes agree.
    expect(
      sampleGradient(STREAKS_LUT, 0.9, GRADIENT_INTERPOLATE_CONSTANT),
    ).toEqual([1, 1, 1, 1]);
  });

  it("bakes a STEPPED texture — grey below the stop, white above, nothing in between", () => {
    const baked = bakeGradient({
      kind: "gradient",
      width: 256,
      stops: STREAKS_LUT,
      interpolationMode: GRADIENT_INTERPOLATE_CONSTANT,
    });
    expect(baked.width).toBe(256);
    expect(baked.height).toBe(1);
    const red = (x: number) => baked.data[x * 4];
    expect(red(0)).toBe(Math.round(0.35 * 255));
    expect(red(140)).toBe(Math.round(0.35 * 255));
    expect(red(255)).toBe(255);
    // Every texel is one of the two authored colors — no blend band.
    const distinct = new Set(Array.from({ length: 256 }, (_, x) => red(x)));
    expect([...distinct].sort((a, b) => a - b)).toEqual([
      Math.round(0.35 * 255),
      255,
    ]);
  });

  it("still blends when the mode is absent/LINEAR (the Godot default)", () => {
    const baked = bakeGradient({
      kind: "gradient",
      width: 256,
      stops: STREAKS_LUT,
    });
    const distinct = new Set(
      Array.from({ length: 256 }, (_, x) => baked.data[x * 4]),
    );
    expect(distinct.size).toBeGreaterThan(2);
  });
});

describe("lutTextureFor", () => {
  it("is null when the spec carries no colorLut (a system with no LUT sampler)", () => {
    const { gl } = recordingGl();
    expect(lutTextureFor(gl, normalizeParticleConfig({}))).toBeNull();
  });

  it("bakes a 256x1 ramp and SHARES it between specs with the same LUT", () => {
    const { gl, calls } = recordingGl();
    const cfg = normalizeParticleConfig({
      colorLut: STREAKS_LUT,
      colorLutInterpolation: GRADIENT_INTERPOLATE_CONSTANT,
    });
    const first = lutTextureFor(gl, cfg);
    expect(first).not.toBeNull();
    expect(first?.width).toBe(256);
    expect(first?.height).toBe(1);
    // Second system, same authored LUT -> the cached GL texture, not a second upload.
    const uploadsAfterFirst = calls.filter(
      (c) => c.name === "texImage2D",
    ).length;
    const second = lutTextureFor(gl, normalizeParticleConfig({ ...cfg }));
    expect(second).toBe(first);
    expect(calls.filter((c) => c.name === "texImage2D").length).toBe(
      uploadsAfterFirst,
    );
  });

  it("uses NEAREST filtering for a CONSTANT ramp and LINEAR for a smooth one", () => {
    // `getBakedTexture`'s cache is keyed by the LUT VALUE and is module-scoped, so give each
    // leg its own gradient — otherwise the second bake is a cache hit and sets no filters.
    const filtersFor = (
      interpolationMode: number | undefined,
      tag: number,
    ): { filters: unknown[]; nearest: number; linear: number } => {
      const { gl, calls } = recordingGl();
      lutTextureFor(
        gl,
        normalizeParticleConfig({
          colorLut: [
            { offset: 0, color: [tag / 255, 0, 0, 1] },
            ...STREAKS_LUT,
          ],
          colorLutInterpolation: interpolationMode,
        }),
      );
      return {
        filters: calls
          .filter(
            (c) =>
              c.name === "texParameteri" &&
              (c.args[1] === gl.TEXTURE_MIN_FILTER ||
                c.args[1] === gl.TEXTURE_MAG_FILTER),
          )
          .map((c) => c.args[2]),
        nearest: gl.NEAREST,
        linear: gl.LINEAR,
      };
    };
    // Hard steps must not be smeared back into a blend by the sampler.
    const constant = filtersFor(GRADIENT_INTERPOLATE_CONSTANT, 11);
    expect(constant.filters).toEqual([constant.nearest, constant.nearest]);
    const linear = filtersFor(undefined, 22);
    expect(linear.filters).toEqual([linear.linear, linear.linear]);
  });
});

describe("drawParticles LUT binding", () => {
  it("binds the LUT on texture unit 1 and turns u_lut ON", () => {
    const { gl, calls } = recordingGl();
    const program = getParticleProgram(gl);
    expect(program).not.toBeNull();
    if (!program) return;
    const lutTexture = {} as WebGLTexture;
    calls.length = 0;
    drawParticles(fakeShared(gl), program, oneInstanceBuffer(), {
      texture: {} as WebGLTexture,
      textured: true,
      lutTexture,
      hframes: 2,
      vframes: 2,
      blendMode: 0,
      viewportW: 64,
      viewportH: 64,
    });
    // The LUT is bound while unit 1 is active...
    const activeIdx = calls.findIndex(
      (c) => c.name === "activeTexture" && c.args[0] === gl.TEXTURE1,
    );
    expect(activeIdx).toBeGreaterThanOrEqual(0);
    const bindIdx = calls.findIndex(
      (c, i) =>
        i > activeIdx && c.name === "bindTexture" && c.args[1] === lutTexture,
    );
    expect(bindIdx).toBeGreaterThan(activeIdx);
    // ...the sampler points at unit 1, and the toggle is on.
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uLutTex, 1],
    });
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uLut, 1],
    });
    // Unit 0 is restored for the caller/next system.
    expect(
      calls.filter((c) => c.name === "activeTexture").at(-1)?.args[0],
    ).toBe(gl.TEXTURE0);
  });

  it("UNBINDS unit 1 and turns u_lut OFF for a system with no LUT (the unit is shared)", () => {
    const { gl, calls } = recordingGl();
    const program = getParticleProgram(gl);
    if (!program) return;
    calls.length = 0;
    drawParticles(fakeShared(gl), program, oneInstanceBuffer(), {
      texture: {} as WebGLTexture,
      textured: true,
      hframes: 1,
      vframes: 1,
      blendMode: 0,
      viewportW: 64,
      viewportH: 64,
    });
    expect(calls).toContainEqual({
      name: "uniform1i",
      args: [program.uLut, 0],
    });
    const activeIdx = calls.findIndex(
      (c) => c.name === "activeTexture" && c.args[0] === gl.TEXTURE1,
    );
    expect(calls[activeIdx + 1]).toEqual({
      name: "bindTexture",
      args: [gl.TEXTURE_2D, null],
    });
  });
});
