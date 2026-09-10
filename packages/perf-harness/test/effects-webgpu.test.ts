// @vitest-environment node
//
// S7 `effects-webgpu`, proved without a browser and WITHOUT A WEBGPU MOCK.
//
// There is no jsdom WebGPU and there is deliberately no fake one here: a mock device would only
// prove that the scenario calls the mock. What CAN be proved offline is everything the probe's
// claim actually rests on, and every item below is something that could be silently wrong while the
// harness still printed a beautiful five-column table:
//
//   * the arms are laid out on the SAME pixels as S6 (otherwise the WebGPU/WebGL difference is a
//     canvas-size difference wearing an API's name),
//   * the particle SPEC is S6's spec (otherwise the arms simulate different particles),
//   * the packed instance bytes are the SHIPPED bytes (otherwise the renderer draws a different
//     picture from the one it is being compared with),
//   * the WGSL really contains the entry points the pipelines name, and the ported Godot shader
//     really carries every constant of the original,
//   * the premultiply/blend pairing is intact on BOTH halves at once, and
//   * the METRIC KEY SETS say what each arm did and do not zero-fill what it did not do.
//
// The three files under test are structured for exactly this: `wgsl.ts` and `webgpu/pack.ts` hold
// no DOM and no WebGPU object, so they import in plain node.

import {
  createParticleState,
  INSTANCE_STRIDE,
  InstanceBuffer,
  normalizeParticleConfig,
  type Particle,
  type ParticleSystemState,
} from "@godot-scene-web/effects/particles";
import { backingStoreSize, effectivePixelRatio } from "@godot-scene-web/html";
import { describe, expect, it } from "vitest";
import {
  EFFECTS_MECHANISMS,
  EFFECTS_SHADER_SOURCE,
  EFFECTS_WEBGPU_MECHANISMS,
  effectsCanvasPad,
  effectsCellBox,
  effectsGridShape,
  effectsRuntime,
  effectsSamplePoints,
  effectsSlotPx,
  effectsSpec,
  effectsStageSize,
  effectsWebgpu,
  getScenario,
  mechanismsOf,
  metricKeysFor,
  PARTICLE_FS_ENTRY,
  PARTICLE_VERTEX_BUFFERS,
  PARTICLE_VS_ENTRY,
  PARTICLE_WGSL,
  PREMULTIPLIED_BLEND,
  packSystem,
  resolveParams,
  SHADER_FS_ENTRY,
  SHADER_VS_ENTRY,
  SHADER_WGSL,
  type StageLayout,
  usesBlit,
  usesParticles,
  usesWebgpu,
  WEBGPU_DOT_PX,
  webgpuCanvasPixels,
  webgpuPixelRatio,
  webgpuUnsupportedParam,
} from "../src/scenarios";

const DESKTOP: StageLayout = {
  viewport: { width: 1280, height: 800 },
  fit: false,
};
const PORTRAIT: StageLayout = {
  viewport: { width: 412, height: 883 },
  fit: true,
};
const LANDSCAPE: StageLayout = {
  viewport: { width: 883, height: 412 },
  fit: true,
};
const LAYOUTS = [DESKTOP, PORTRAIT, LANDSCAPE];

const s7 = (overrides: Record<string, string | number> = {}) =>
  resolveParams(effectsWebgpu, overrides);
const s6 = (overrides: Record<string, string | number> = {}) =>
  resolveParams(effectsRuntime, overrides);

describe("effects-webgpu: registry", () => {
  it("registers the scenario and its five arms, in order", () => {
    expect(getScenario("effects-webgpu")).toBe(effectsWebgpu);
    expect(mechanismsOf(effectsWebgpu)).toEqual(EFFECTS_WEBGPU_MECHANISMS);
    expect(EFFECTS_WEBGPU_MECHANISMS).toEqual([
      "particles-webgl",
      "particles-webgpu",
      "particles-webgpu-blit",
      "shaders-webgl",
      "shaders-webgpu",
    ]);
    // The reference arm is FIRST, so a `--mechanism`-less run reads the shipped pipeline before the
    // probe's, and a truncated table still contains the thing everything else is subtracted from.
    expect(mechanismsOf(effectsWebgpu)[0]).toBe("particles-webgl");
    expect(() =>
      resolveParams(effectsWebgpu, { mechanism: "particles-vulkan" }),
    ).toThrow(/not one of/);
  });

  it("classifies each arm the way the renderer switch does", () => {
    expect(EFFECTS_WEBGPU_MECHANISMS.filter(usesWebgpu)).toEqual([
      "particles-webgpu",
      "particles-webgpu-blit",
      "shaders-webgpu",
    ]);
    expect(EFFECTS_WEBGPU_MECHANISMS.filter(usesParticles)).toEqual([
      "particles-webgl",
      "particles-webgpu",
      "particles-webgpu-blit",
    ]);
    expect(EFFECTS_WEBGPU_MECHANISMS.filter(usesBlit)).toEqual([
      "particles-webgpu-blit",
    ]);
  });
});

// THE PREMISE OF THE WHOLE PROBE. S7 subtracts its arms from S6's, so if the two scenarios lay
// their cells out differently then every difference the table shows is partly a geometry
// difference. They share the helpers outright — but "shares the helper" is a fact about today's
// import graph, and this is the assertion that makes it a fact about the RESULT.
describe("effects-webgpu: the same pixels as S6", () => {
  for (const overrides of [{}, { systems: 3 }, { systems: 25 }]) {
    const label = JSON.stringify(overrides);
    it(`lays out identically to effects-runtime for ${label}`, () => {
      const a = s7(overrides);
      const b = s6(overrides);
      expect(effectsSlotPx(a)).toBe(effectsSlotPx(b));
      expect(effectsCanvasPad(a)).toBe(effectsCanvasPad(b));
      for (const layout of LAYOUTS) {
        expect(effectsWebgpu.stageSize(a, layout)).toEqual(
          effectsRuntime.stageSize(b, layout),
        );
        expect(effectsWebgpu.gridShape?.(a, layout)).toEqual(
          effectsRuntime.gridShape?.(b, layout),
        );
        expect(effectsGridShape(a, layout)).toEqual(
          effectsGridShape(b, layout),
        );
        expect(effectsSamplePoints(a, layout)).toEqual(
          effectsSamplePoints(b, layout),
        );
        expect(effectsStageSize(a, layout)).toEqual(
          effectsStageSize(b, layout),
        );
        const { columns } = effectsGridShape(a, layout);
        for (let index = 0; index < Number(a.systems); index++) {
          expect(effectsCellBox(index, columns, a)).toEqual(
            effectsCellBox(index, columns, b),
          );
        }
      }
    });
  }
});

describe("effects-webgpu: the same particles as S6", () => {
  it("builds S6's spec, field for field, on every arm", () => {
    for (const mechanism of EFFECTS_WEBGPU_MECHANISMS) {
      for (const index of [0, 1, 5, 11]) {
        expect(effectsSpec(s7({ mechanism }), index)).toEqual(
          effectsSpec(s6({ mechanism: "particles-live" }), index),
        );
      }
    }
  });

  it("never caps the sim on any arm — S7 has no simcap knob to cap it with", () => {
    // `fixedFps: 0` is how `normalizeParticleConfig` spells Godot's default 30 Hz, i.e. UNCAPPED.
    // S6's `simcap` arm is the only thing in the codebase that sets it, and S7 does not declare
    // `simCapHz` at all: this probe compares renderers, and a capped sim on one arm would put a
    // workload difference inside a renderer comparison.
    for (const mechanism of EFFECTS_WEBGPU_MECHANISMS) {
      expect(effectsSpec(s7({ mechanism }), 0).fixedFps).toBe(0);
    }
    expect(effectsWebgpu.params.simCapHz).toBeUndefined();
    expect(effectsWebgpu.params.pacing).toBeUndefined();
    // …and S6 still has both, so this is a deliberate omission rather than a knob that vanished.
    expect(effectsRuntime.params.simCapHz).toBeDefined();
    expect(effectsRuntime.params.pacing).toBeDefined();
  });

  it("pins the defaults its reference reading will be published against", () => {
    expect(s7()).toEqual({
      mechanism: "particles-webgl",
      systems: 12,
      amount: 64,
      cellPx: 96,
      overLife: "ramps",
      blend: 0,
      fps: 0,
      renderScale: 1,
      churn: 8,
    });
  });
});

describe("effects-webgpu: the canvas-pixel laws are imported, not copied", () => {
  // The probe hardcodes the particle runtime's module-private `DEFAULT_DOT` (16 px) because it
  // cannot import it. This is the guard: `spriteExtentPad` pads an untextured system by half the
  // sprite DIAGONAL, so the pad S6 computes is a function of that same private constant. If the
  // runtime ever moves it, the pad moves and this fails — before the probe starts drawing dots of
  // one size into canvases padded for another.
  it("catches the runtime moving DEFAULT_DOT out from under WEBGPU_DOT_PX", () => {
    expect(WEBGPU_DOT_PX).toBe(16);
    expect(effectsCanvasPad(s7())).toBe(
      Math.ceil(Math.hypot(WEBGPU_DOT_PX, WEBGPU_DOT_PX) / 2),
    );
    expect(effectsCanvasPad(s7())).toBe(12);
    expect(effectsSlotPx(s7())).toBe(96 + 24);
  });

  it("sizes every backing store through the shipped backingStoreSize", () => {
    for (const dpr of [1, 2, 2.625]) {
      for (const renderScale of [1, 0.5]) {
        // `effectivePixelRatio` reads `window.devicePixelRatio` (1 under node) and multiplies by the
        // clamped renderScale, so the ratio a canvas is REALLY sized at is `dpr * renderScale`.
        expect(webgpuPixelRatio(renderScale)).toBe(
          effectivePixelRatio(renderScale),
        );
        const ratio = dpr * renderScale;
        for (const css of [effectsSlotPx(s7()), 120, 315, 1]) {
          expect(webgpuCanvasPixels(css, css, ratio)).toEqual(
            backingStoreSize(css, css, ratio),
          );
        }
        // …and a non-square box too, so a transposed w/h could not pass.
        expect(webgpuCanvasPixels(120, 96, ratio)).toEqual(
          backingStoreSize(120, 96, ratio),
        );
      }
    }
  });
});

describe("effects-webgpu: the WGSL says what the pipelines name", () => {
  it("declares both stages and the four entry points the descriptors reference", () => {
    for (const source of [PARTICLE_WGSL, SHADER_WGSL]) {
      expect(source).toContain("@vertex");
      expect(source).toContain("@fragment");
    }
    // Spelled through the CONSTANTS, which is what the pipeline descriptors use: a renamed entry
    // point that only got renamed in one of the two places is a pipeline-creation failure at run
    // time on a phone, and a failing assertion here.
    expect(PARTICLE_WGSL).toContain(`fn ${PARTICLE_VS_ENTRY}(`);
    expect(PARTICLE_WGSL).toContain(`fn ${PARTICLE_FS_ENTRY}(`);
    expect(SHADER_WGSL).toContain(`fn ${SHADER_VS_ENTRY}(`);
    expect(SHADER_WGSL).toContain(`fn ${SHADER_FS_ENTRY}(`);
    // The entry points are not shared between the two modules, so a copy/paste cannot silently make
    // one pipeline compile the other's shader.
    expect(
      new Set([
        PARTICLE_VS_ENTRY,
        PARTICLE_FS_ENTRY,
        SHADER_VS_ENTRY,
        SHADER_FS_ENTRY,
      ]).size,
    ).toBe(4);
  });

  it("declares a vertex layout whose stride IS the shipped instance stride", () => {
    const [corners, instances] = PARTICLE_VERTEX_BUFFERS;
    expect(corners.stepMode).toBe("vertex");
    expect(corners.arrayStride).toBe(8);
    expect(instances.stepMode).toBe("instance");
    // THE law: the packer writes `INSTANCE_STRIDE` floats and the GPU reads `arrayStride` bytes.
    expect(instances.arrayStride).toBe(INSTANCE_STRIDE * 4);
    // Float offsets 0/2/4/5/9 of the shipped record, in bytes.
    expect([...instances.attributes].map((a) => a.offset)).toEqual([
      0, 8, 16, 20, 36,
    ]);
    expect([...instances.attributes].map((a) => a.format)).toEqual([
      "float32x2",
      "float32x2",
      "float32",
      "float32x4",
      "float32",
    ]);
  });

  // THE PORT'S DRIFT GUARD. S6's `shaders-live` runs `EFFECTS_SHADER_SOURCE` through the shipped
  // Godot→GLSL transpiler; S7's `shaders-webgpu` runs a hand-written WGSL transcription. The two
  // arms are only comparable while they are the same shader, and "the same shader" is checkable at
  // the level of its constants: every float literal of the Godot source must appear in the port.
  it("carries every float constant of EFFECTS_SHADER_SOURCE into SHADER_WGSL", () => {
    const literals = EFFECTS_SHADER_SOURCE.match(/\d+\.\d+/g) ?? [];
    expect(literals.length).toBeGreaterThan(8);
    for (const literal of new Set(literals)) {
      expect(
        SHADER_WGSL,
        `SHADER_WGSL is missing the Godot constant ${literal}`,
      ).toContain(literal);
    }
    // Spot-check the ones a typo would most plausibly eat, so a future refactor of the regex above
    // cannot quietly make this test vacuous.
    for (const constant of ["12.0", "2.5", "0.45", "0.85", "0.35"]) {
      expect(SHADER_WGSL).toContain(constant);
    }
  });

  // BOTH HALVES OF THE PREMULTIPLY CONTRACT, asserted together on purpose: "fragment returns rgb*a"
  // + "blend one / one-minus-src-alpha". Either half alone is wrong — a premultiplied fragment under
  // a src-alpha blend double-multiplies, a straight fragment under this blend halos — and neither
  // shows up as an error, only as a slightly different picture at the same frame rate. It is also
  // what the shipped GL path says (`webgl/shared-gl.ts` declares `premultipliedAlpha: true`), so the
  // arms compare at equal pixels rather than at equivalent-but-differently-stated ones.
  it("returns premultiplied from both fragments AND blends for premultiplied", () => {
    const premultiplied =
      /return\s+vec4f\(\s*col\.rgb\s*\*\s*col\.a\s*,\s*col\.a\s*\)/;
    expect(PARTICLE_WGSL).toMatch(premultiplied);
    expect(SHADER_WGSL).toMatch(premultiplied);
    expect(PREMULTIPLIED_BLEND.color.srcFactor).toBe("one");
    expect(PREMULTIPLIED_BLEND.color.dstFactor).toBe("one-minus-src-alpha");
    expect(PREMULTIPLIED_BLEND.alpha?.srcFactor).toBe("one");
    expect(PREMULTIPLIED_BLEND.alpha?.dstFactor).toBe("one-minus-src-alpha");
  });
});

// THE BYTES. `packSystem` is the one part of the pipeline that had to be restated rather than
// imported (the shipped loop lives inside `drawBinding`, between the runtime's profiling brackets
// and a `gl.viewport`). So it is checked element by element against the expression the runtime
// uses — a transposed field or a dropped `dpr` here is a subtly wrong picture at a plausible frame
// rate, which is the failure this whole harness exists to refuse.
describe("effects-webgpu: packSystem writes the shipped instance record", () => {
  function particle(overrides: Partial<Particle>): Particle {
    return {
      active: true,
      time: 0,
      lifetime: 1,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      rotation: 0,
      seed: 0,
      angleRand: 0,
      scaleRand: 0,
      hueRand: 0,
      animOffsetRand: 0,
      startColor: [1, 1, 1, 1],
      scaleX: 1,
      scaleY: 1,
      r: 1,
      g: 1,
      b: 1,
      a: 1,
      frame: 0,
      ...overrides,
    };
  }

  function stateWith(particles: Particle[]): ParticleSystemState {
    const config = normalizeParticleConfig({
      amount: particles.length,
      originX: 48,
      originY: 48,
    });
    const state = createParticleState(config);
    state.particles = particles;
    state.count = particles.length;
    return state;
  }

  it("packs exactly the live particles, in the shipped field order", () => {
    const particles = [
      particle({
        x: 10,
        y: -4,
        rotation: 0.5,
        r: 0.25,
        g: 0.5,
        b: 0.75,
        a: 0.5,
        frame: 3,
      }),
      // SKIPPED: inactive. The shipped loop's `!p.active` guard.
      particle({ active: false, x: 999 }),
      particle({ x: -6, y: 2, scaleX: 2, scaleY: 0.5, a: 0.125 }),
      // SKIPPED: fully transparent. The shipped loop's `p.a <= 0` guard — an alpha-0 particle costs
      // nothing on screen and must cost nothing in the buffer either.
      particle({ a: 0, x: 777 }),
    ];
    const state = stateWith(particles);
    const buffer = new InstanceBuffer(8);
    const geometry = {
      originX: 48,
      originY: 48,
      pad: 12,
      dpr: 2,
      frameW: 16,
      frameH: 16,
    };

    const count = packSystem(buffer, state, geometry);

    expect(INSTANCE_STRIDE).toBe(10);
    expect(count).toBe(2);
    expect(buffer.count).toBe(2);
    // `(originX + x + pad) * dpr`, `(originY + y + pad) * dpr`,
    // `max(0, frameW * scaleX) * dpr`, `max(0, frameH * scaleY) * dpr`, rotation, r, g, b, a, frame
    expect(
      Array.from(buffer.data.subarray(0, count * INSTANCE_STRIDE)),
    ).toEqual([
      (48 + 10 + 12) * 2,
      (48 - 4 + 12) * 2,
      16 * 1 * 2,
      16 * 1 * 2,
      0.5,
      0.25,
      0.5,
      0.75,
      0.5,
      3,
      (48 - 6 + 12) * 2,
      (48 + 2 + 12) * 2,
      16 * 2 * 2,
      16 * 0.5 * 2,
      0,
      1,
      1,
      1,
      0.125,
      0,
    ]);
  });

  it("resets the buffer, so a shrinking system does not draw last frame's tail", () => {
    const state = stateWith([particle({}), particle({}), particle({})]);
    const buffer = new InstanceBuffer(8);
    const geometry = {
      originX: 48,
      originY: 48,
      pad: 12,
      dpr: 1,
      frameW: 16,
      frameH: 16,
    };
    expect(packSystem(buffer, state, geometry)).toBe(3);
    state.particles[0].active = false;
    state.particles[1].a = 0;
    expect(packSystem(buffer, state, geometry)).toBe(1);
    expect(buffer.count).toBe(1);
  });

  it("clamps a negative scale to 0 rather than flipping the quad", () => {
    const state = stateWith([particle({ scaleX: -3, scaleY: 1 })]);
    const buffer = new InstanceBuffer(8);
    expect(
      packSystem(buffer, state, { pad: 0, dpr: 1, frameW: 16, frameH: 16 }),
    ).toBe(1);
    expect(buffer.data[2]).toBe(0);
    expect(buffer.data[3]).toBe(16);
  });
});

// WHICH KEYS EXIST IS A CLAIM. An absent key means NOT MEASURED and a fabricated 0 cannot be told
// apart from a measured one, so the absences below are as load-bearing as the presences: the direct
// WebGPU arms have NO blit to time, and saying so is the whole point of the blit arm existing.
describe("effects-webgpu: metric key sets", () => {
  const keys = (mechanism: string) => new Set(metricKeysFor(mechanism));
  const armsWith = (key: string) =>
    EFFECTS_WEBGPU_MECHANISMS.filter((m) => keys(m).has(key));

  it("never reports an empty block, on any arm", () => {
    for (const mechanism of EFFECTS_WEBGPU_MECHANISMS) {
      expect(metricKeysFor(mechanism).length).toBeGreaterThan(0);
      // No duplicates — a repeated key would silently overwrite itself in the reported object.
      expect(keys(mechanism).size).toBe(metricKeysFor(mechanism).length);
      // Every arm can answer "was every cell alive?".
      expect(keys(mechanism).has("renderedNodes")).toBe(true);
    }
  });

  it("keeps `submitMs` off the WebGL arms, because it is not GL", () => {
    expect(armsWith("submitMs")).toEqual([
      "particles-webgpu",
      "particles-webgpu-blit",
      "shaders-webgpu",
    ]);
    // …and `glMs` off the WebGPU arms, for the same reason read the other way.
    expect(armsWith("glMs")).toEqual(["particles-webgl", "shaders-webgl"]);
  });

  it("reports a blit ONLY where a blit happens", () => {
    // `blits` exists on exactly one arm: the one whose whole job is to keep the blit.
    expect(armsWith("blits")).toEqual(["particles-webgpu-blit"]);
    // `blitMs` on the two shipped-architecture WebGL arms (the runtime's own GL→2D blit) and on the
    // WebGPU blit arm — and on NEITHER direct arm, where the absence IS the architecture.
    expect(armsWith("blitMs")).toEqual([
      "particles-webgl",
      "particles-webgpu-blit",
      "shaders-webgl",
    ]);
    expect(keys("particles-webgpu").has("blitMs")).toBe(false);
    expect(keys("shaders-webgpu").has("blitMs")).toBe(false);
  });

  it("reports no simulation on the shader arms, because there is none", () => {
    for (const key of ["simMs", "simSteps", "instances", "buildMs"]) {
      expect(keys("shaders-webgpu").has(key)).toBe(false);
      expect(keys("shaders-webgl").has(key)).toBe(false);
      expect(keys("particles-webgpu").has(key)).toBe(true);
    }
  });

  it("carries the three validity rows on every WebGPU arm and none of the WebGL ones", () => {
    for (const key of ["adapterFallback", "gpuErrors", "deviceLosses"]) {
      expect(armsWith(key)).toEqual([
        "particles-webgpu",
        "particles-webgpu-blit",
        "shaders-webgpu",
      ]);
    }
  });

  it("keeps the WebGL arms reporting exactly S6's keys", () => {
    // The reference arms mount the shipped runtimes with `effectsProfiling` on, so their key set is
    // `particleCounters`/`shaderCounters` plus S6's two whole-life rows. If this drifts, the
    // in-session reference stops being comparable with S6's published table.
    expect(metricKeysFor("particles-webgl").sort()).toEqual(
      [
        "boxReads",
        "buildMs",
        "blitMs",
        "glMs",
        "instances",
        "particleCacheHits",
        "particleDraws",
        "profBindings",
        "profTicks",
        "renderedNodes",
        "simMs",
        "simSteps",
      ].sort(),
    );
    expect(metricKeysFor("shaders-webgl").sort()).toEqual(
      [
        "blitMs",
        "glMs",
        "profBindings",
        "profTicks",
        "renderedNodes",
        "shaderCacheHits",
        "shaderDraws",
      ].sort(),
    );
  });
});

describe("effects-webgpu: what it refuses to answer", () => {
  it("refuses blend=1 on the WebGPU arms and names the fallback", () => {
    for (const mechanism of ["particles-webgl", "shaders-webgl"]) {
      // The shipped runtimes DO implement Godot ADD (accumulate + resolve), so these arms are free.
      expect(webgpuUnsupportedParam(s7({ mechanism, blend: 1 }))).toBeNull();
    }
    for (const mechanism of [
      "particles-webgpu",
      "particles-webgpu-blit",
      "shaders-webgpu",
    ]) {
      const message = webgpuUnsupportedParam(s7({ mechanism, blend: 1 }));
      expect(message).toBeTruthy();
      // It must name WHAT is missing…
      expect(message).toMatch(/accumulate\+resolve|accumulate and resolve/);
      // …and WHERE to go instead, as a runnable command.
      expect(message).toContain("--scenario effects-runtime --param blend=1");
      expect(message).toContain(mechanism);
    }
  });

  it("refuses nothing at the default blend", () => {
    for (const mechanism of EFFECTS_WEBGPU_MECHANISMS) {
      expect(webgpuUnsupportedParam(s7({ mechanism }))).toBeNull();
      expect(webgpuUnsupportedParam(s7({ mechanism, blend: 0 }))).toBeNull();
    }
  });

  it("leaves S6's own arms alone", () => {
    // S7 must not have grown a mechanism name S6 already uses, or a `--mechanism` typo would run a
    // different scenario's arm and be reported under this one's name.
    for (const mechanism of EFFECTS_MECHANISMS) {
      expect(EFFECTS_WEBGPU_MECHANISMS).not.toContain(mechanism);
    }
  });
});
