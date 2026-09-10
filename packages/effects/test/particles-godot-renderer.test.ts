// The `godotRenderer` colour correction: Godot's RendererRD backends run
// `ParticleProcessMaterial.color` through `Color::srgb_to_linear()` at UBO-upload time and
// then write the result into a non-linear canvas without undoing it, so a browser render
// must apply the same curve to match a Forward+/Mobile capture. Full derivation and the
// Godot 4.5.1 line references: core's `src/particles/godot-renderer.ts`.
//
// The live evidence for all of this is the Godot fixture
// (`fixtures/visual-2d/particles-blend.tscn`, see `docs/parity.md`); these tests pin the
// arithmetic, the default, the opt-out, and — most importantly — everything the correction
// must NOT touch.

import { describe, expect, it } from "vitest";
import {
  createParticleState,
  DEFAULT_GODOT_RENDERER,
  linearizeParticleBaseColor,
  linearizesParticleColor,
  normalizeGodotRenderer,
  normalizeParticleConfig,
  simulateParticles,
  srgbToLinear,
} from "../src/particles";
import type { GodotRendererBackend } from "../src/particles/godot-renderer";

const BACKENDS: GodotRendererBackend[] = [
  "forward_plus",
  "mobile",
  "gl_compatibility",
];

describe("srgbToLinear — Godot's Color::srgb_to_linear(), core/math/color.h:191-197", () => {
  it("is the identity at both ends of the range", () => {
    // The fixed points matter: a fully saturated channel is where the curve does nothing,
    // which is what makes blue the per-channel regression check on the parity fixture.
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBe(1);
  });

  it("matches the IEC 61966-2-1 curve at known values", () => {
    // Standard reference points for the piecewise sRGB EOTF.
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114, 8);
    expect(srgbToLinear(0.25)).toBeCloseTo(0.05087609, 8);
    expect(srgbToLinear(0.75)).toBeCloseTo(0.52252155, 8);
  });

  it("uses the LINEAR segment below the 0.04045 threshold", () => {
    expect(srgbToLinear(0.02)).toBeCloseTo(0.02 / 12.92, 12);
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 12);
    // Godot's comparison is strict `<`, so the threshold itself takes the POWER branch.
    expect(srgbToLinear(0.04045)).toBeCloseTo(
      ((0.04045 + 0.055) / 1.055) ** 2.4,
      12,
    );
  });

  it("is the exponent-2.4 piecewise curve, NOT a pow(x, 2.2) approximation", () => {
    expect(srgbToLinear(0.85)).toBeCloseTo(0.69207106, 7);
    expect(srgbToLinear(0.4)).toBeCloseTo(0.13286832, 7);

    // WHY THIS TEST EXISTS RATHER THAN A FIXTURE ASSERTION. The parity fixture CANNOT tell
    // these two curves apart: at its additive gain of 255*4*0.11, `pow(x, 2.2)` differs
    // from the real curve by 0.82 bytes on green, 0.04 on blue — under 1/255 everywhere,
    // i.e. inside the noise the fixture already carries. So the Godot SOURCE is the only
    // authority for the exponent, and this is where it gets pinned.
    for (const c of [0.85, 0.4, 0.3, 0.6]) {
      expect(
        Math.abs(255 * 4 * 0.11 * (c ** 2.2 - srgbToLinear(c))),
      ).toBeLessThan(1);
    }
    // Distinct functions all the same — an accidental swap is a real (if small) error.
    expect(srgbToLinear(0.85)).not.toBe(0.85 ** 2.2);
  });

  it("reproduces the ADD cluster's measured Godot pixels", () => {
    // The parity fixture's ADD emitters are `color = Color(1, 0.85, 0.4, 0.11)` over a
    // 0.5 gray backdrop, four particles deep, additive: `128 + 255*4*0.11*linear(rgb)`.
    // Godot measures (239, 203, 143) at the cluster core.
    const predicted = [1, 0.85, 0.4].map(
      (c) => 128 + 255 * 4 * 0.11 * srgbToLinear(c),
    );
    expect(predicted[0]).toBeCloseTo(240.2, 1);
    expect(predicted[1]).toBeCloseTo(205.7, 1);
    expect(predicted[2]).toBeCloseTo(142.9, 1);
    // Within ~3/255 of Godot's measured triple on every channel.
    for (const [i, measured] of [239, 203, 143].entries()) {
      expect(Math.abs(predicted[i] - measured)).toBeLessThan(3);
    }
  });

  it("reproduces the MIX cluster's linearized colour", () => {
    // `color = Color(0.3, 0.6, 1, 0.35)`; docs/parity.md predicts Godot's MIX core from
    // the linearized triple (0.0732, 0.3185, 1.0).
    expect(srgbToLinear(0.3)).toBeCloseTo(0.0732, 4);
    expect(srgbToLinear(0.6)).toBeCloseTo(0.3185, 4);
    // Blue is 1.0 -> untouched. This is the channel the correction cannot move.
    expect(srgbToLinear(1.0)).toBe(1.0);
  });
});

describe("the godotRenderer option", () => {
  it("defaults to forward_plus — Godot's own default for a new project", () => {
    expect(DEFAULT_GODOT_RENDERER).toBe("forward_plus");
    expect(normalizeParticleConfig({}).godotRenderer).toBe("forward_plus");
    expect(normalizeGodotRenderer(undefined)).toBe("forward_plus");
  });

  it("coerces anything unrecognized to the default", () => {
    for (const bad of [null, "", "vulkan", "forward+", 3, {}, []]) {
      expect(normalizeGodotRenderer(bad)).toBe("forward_plus");
    }
    for (const backend of BACKENDS) {
      expect(normalizeGodotRenderer(backend)).toBe(backend);
    }
  });

  it("accepts every documented backend spelling", () => {
    const values: GodotRendererBackend[] = [
      "forward_plus",
      "mobile",
      "gl_compatibility",
    ];
    expect(values.map(normalizeGodotRenderer)).toEqual(values);
  });

  it("linearizes on both RendererRD backends and on neither other path", () => {
    expect(linearizesParticleColor("forward_plus")).toBe(true);
    expect(linearizesParticleColor("mobile")).toBe(true);
    expect(linearizesParticleColor("gl_compatibility")).toBe(false);
  });
});

describe("the correction applied to baseColor", () => {
  const COLOR: [number, number, number, number] = [1, 0.85, 0.4, 0.11];

  it("converts RGB on forward_plus and mobile, identically", () => {
    const fp = linearizeParticleBaseColor(COLOR, "forward_plus", true);
    const mobile = linearizeParticleBaseColor(COLOR, "mobile", true);
    expect(fp).toEqual(mobile);
    expect(fp[0]).toBe(1);
    expect(fp[1]).toBeCloseTo(srgbToLinear(0.85), 12);
    expect(fp[2]).toBeCloseTo(srgbToLinear(0.4), 12);
  });

  it("is an EXACT no-op on gl_compatibility", () => {
    // Bit-for-bit, not approximately: opting out must not perturb anything.
    expect(linearizeParticleBaseColor(COLOR, "gl_compatibility", true)).toEqual(
      [...COLOR],
    );
    const cfg = normalizeParticleConfig({
      baseColor: [0.3, 0.6, 1, 0.35],
      godotRenderer: "gl_compatibility",
    });
    expect(cfg.baseColorRender).toEqual(cfg.baseColor);
  });

  it("NEVER touches alpha, on any backend", () => {
    for (const backend of BACKENDS) {
      // 0.11 is well inside the power branch, so an accidental 4-channel map would show.
      expect(linearizeParticleBaseColor(COLOR, backend, true)[3]).toBe(0.11);
      expect(
        normalizeParticleConfig({
          baseColor: [0.3, 0.6, 1, 0.35],
          godotRenderer: backend,
        }).baseColorRender[3],
      ).toBe(0.35);
    }
  });

  it("keeps baseColor itself raw — the authored inspector value", () => {
    const cfg = normalizeParticleConfig({
      baseColor: [0.3, 0.6, 1, 0.35],
      godotRenderer: "forward_plus",
    });
    expect(cfg.baseColor).toEqual([0.3, 0.6, 1, 0.35]);
    expect(cfg.baseColorRender[0]).toBeCloseTo(srgbToLinear(0.3), 12);
  });

  it("does not alias the colour it was handed", () => {
    const source: [number, number, number, number] = [0.3, 0.6, 1, 0.35];
    const out = linearizeParticleBaseColor(source, "gl_compatibility", true);
    out[0] = 999;
    expect(source[0]).toBe(0.3);
  });

  it("is idempotent — re-normalizing a normalized config does not re-apply the curve", () => {
    // Several call sites do `normalizeParticleConfig({ ...alreadyNormalized })`; deriving
    // `baseColorRender` instead of overwriting `baseColor` is what makes that safe.
    const once = normalizeParticleConfig({ baseColor: [0.3, 0.6, 1, 0.35] });
    const twice = normalizeParticleConfig({ ...once });
    expect(twice.baseColor).toEqual(once.baseColor);
    expect(twice.baseColorRender).toEqual(once.baseColorRender);
  });
});

describe("the correction's scope — what it must NOT reach", () => {
  it("leaves CPUParticles2D.color alone on every backend", () => {
    // CPUParticles2D computes its colours on the CPU and emits vertex colours
    // (`scene/2d/cpu_particles_2d.cpp:1086-1096`); `srgb_to_linear` does not appear in
    // that file at all, so no backend converts it.
    for (const backend of BACKENDS) {
      const cfg = normalizeParticleConfig({
        kind: "CPUParticles2D",
        baseColor: [0.3, 0.6, 1, 0.35],
        godotRenderer: backend,
      });
      expect(cfg.baseColorFromProcessMaterial).toBe(false);
      expect(cfg.baseColorRender).toEqual(cfg.baseColor);
    }
  });

  it("leaves a GPUParticles2D whose colour came from modulate alone", () => {
    // Godot converts the canvas `modulate` only under `use_linear_colors`, i.e. only with
    // an HDR 2D render target (`renderer_canvas_render_rd.cpp:669,692`).
    const cfg = normalizeParticleConfig({
      kind: "GPUParticles2D",
      baseColor: [0.3, 0.6, 1, 0.35],
      baseColorFromProcessMaterial: false,
      godotRenderer: "forward_plus",
    });
    expect(cfg.baseColorRender).toEqual(cfg.baseColor);
  });

  it("leaves simulation color ramps byte-for-byte untouched", () => {
    // Godot declares the ramps WITHOUT `source_color`
    // (`particle_process_material.cpp:313-319`), so it samples them raw and multiplies
    // them against the linearized base. The two factors are in different colour spaces in
    // the engine, and must be here too.
    const colorRamp = [
      {
        offset: 0,
        color: [0.3, 0.6, 1, 1] as [number, number, number, number],
      },
      {
        offset: 1,
        color: [0.5, 0.5, 0.5, 0] as [number, number, number, number],
      },
    ];
    const colorInitialRamp = [
      {
        offset: 0,
        color: [0.85, 0.4, 0.2, 1] as [number, number, number, number],
      },
    ];
    const colorLut = [
      {
        offset: 0.5,
        color: [0.4, 0.4, 0.4, 1] as [number, number, number, number],
      },
    ];
    const cfg = normalizeParticleConfig({
      baseColor: [0.3, 0.6, 1, 0.35],
      godotRenderer: "forward_plus",
      colorRamp,
      colorInitialRamp,
      colorLut,
    } as never);
    expect(cfg.colorRamp).toEqual(colorRamp);
    expect(cfg.colorInitialRamp).toEqual(colorInitialRamp);
    // …while the base colour DID move, so the assertions above are not vacuous.
    expect(cfg.baseColorRender[0]).not.toBe(cfg.baseColor[0]);
  });
});

describe("the seam sits BEFORE the ramp multiply", () => {
  // Godot's order is `linear(color_value) * ramp(t)`, never `linear(base * ramp)`:
  // `particle_process_material.cpp:595` assigns `params.color = color_value` (already
  // linearized on the CPU) and `:626-627` multiplies the raw-sampled ramp in afterwards.
  function displayedRgb(
    overrides: Partial<Parameters<typeof normalizeParticleConfig>[0]>,
  ): [number, number, number] {
    const cfg = normalizeParticleConfig({
      seed: 1234,
      fixedFps: 60,
      amount: 1,
      lifetime: 10,
      explosiveness: 1,
      randomness: 0,
      gravity: [0, 0],
      initialVelocityMin: 0,
      initialVelocityMax: 0,
      ...overrides,
    });
    const state = createParticleState(cfg);
    simulateParticles(state, 0.5);
    const p = state.particles.find((particle) => particle.active);
    if (!p) {
      throw new Error("no active particle");
    }
    return [p.r, p.g, p.b];
  }

  it("multiplies the LINEARIZED base by the RAW ramp", () => {
    const base: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
    // A flat 0.5 ramp: the displayed colour must be `0.5 * linear(0.5)`, NOT `linear(0.25)`.
    const ramp = [
      {
        offset: 0,
        color: [0.5, 0.5, 0.5, 1] as [number, number, number, number],
      },
      {
        offset: 1,
        color: [0.5, 0.5, 0.5, 1] as [number, number, number, number],
      },
    ];
    const [r] = displayedRgb({ baseColor: base, colorRamp: ramp } as never);
    expect(r).toBeCloseTo(0.5 * srgbToLinear(0.5), 6);
    // The wrong order — linearizing the product — would land here instead.
    expect(r).not.toBeCloseTo(srgbToLinear(0.5 * 0.5), 6);
  });

  it("applies the curve once, with no ramp present", () => {
    const [r, g, b] = displayedRgb({ baseColor: [1, 0.85, 0.4, 1] } as never);
    expect(r).toBeCloseTo(1, 6);
    expect(g).toBeCloseTo(srgbToLinear(0.85), 6);
    expect(b).toBeCloseTo(srgbToLinear(0.4), 6);
  });

  it("gl_compatibility leaves the displayed colour at the authored sRGB value", () => {
    const [r, g, b] = displayedRgb({
      baseColor: [1, 0.85, 0.4, 1],
      godotRenderer: "gl_compatibility",
    } as never);
    expect(r).toBeCloseTo(1, 6);
    expect(g).toBeCloseTo(0.85, 6);
    expect(b).toBeCloseTo(0.4, 6);
  });
});
