// @vitest-environment node
//
// S8 `effects-webgpu-runtime`, proved without a browser.
//
// This scenario's claim is unusually narrow and unusually easy to break: its four arms are the SAME
// shipped runtimes mounting the SAME nodes, differing by ONE option value (`effectsRenderer`). Every
// assertion here is about something that could drift while the harness still printed a beautiful
// four-column table:
//
//   * the arms are laid out on the same pixels as S6 — at 12 systems AND at the 30 the consuming
//     project renders, in three viewports (otherwise the WebGPU/WebGL difference is partly a
//     canvas-size difference wearing a renderer's name),
//   * every arm builds S6's particle spec, field for field, including the additive case S7 refused,
//   * `effectsRenderer` is PINNED on both sides — never left at the `"auto"` default, which would
//     make a reference arm adopt WebGPU wherever an adapter exists,
//   * the METRIC KEY SETS say what each arm did: `glMs`/`blitMs` are WebGL's, `submitMs` is
//     WebGPU's, and no key is zero-filled across the boundary.
//
// What cannot be proved here is that a `GPUDevice` was ever acquired. That is what `ready()`'s
// refusal and the `rendererWebgpu` row are for, and they are exercised on hardware, not mocked: a
// fake device would only prove that the scenario calls the fake.

import { describe, expect, it } from "vitest";
import {
  EFFECTS_MECHANISMS,
  EFFECTS_MS_COUNTERS,
  EFFECTS_WEBGPU_MECHANISMS,
  EFFECTS_WEBGPU_RUNTIME_MECHANISMS,
  effectsCanvasPad,
  effectsCellBox,
  effectsGridShape,
  effectsGridSize,
  effectsRendererFor,
  effectsRuntime,
  effectsSamplePoints,
  effectsSlotPx,
  effectsSpec,
  effectsStageSize,
  effectsWebgpuRuntime,
  forcesWebgpuAdapter,
  freezesPopulation,
  frozenSurfaceOptions,
  getScenario,
  mechanismsOf,
  renameWebgpuBuckets,
  resolveParams,
  runtimeMetricKeysFor,
  runtimeUsesParticles,
  runtimeUsesWebgpu,
  type StageLayout,
  swapsFrozenSurfaces,
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

const s8 = (overrides: Record<string, string | number> = {}) =>
  resolveParams(effectsWebgpuRuntime, overrides);
const s6 = (overrides: Record<string, string | number> = {}) =>
  resolveParams(effectsRuntime, overrides);

describe("effects-webgpu-runtime: registry", () => {
  it("registers the scenario and its four arms, in order", () => {
    expect(getScenario("effects-webgpu-runtime")).toBe(effectsWebgpuRuntime);
    expect(mechanismsOf(effectsWebgpuRuntime)).toEqual(
      EFFECTS_WEBGPU_RUNTIME_MECHANISMS,
    );
    expect(EFFECTS_WEBGPU_RUNTIME_MECHANISMS).toEqual([
      "particles-webgl",
      "particles-webgpu",
      "shaders-webgl",
      "shaders-webgpu",
    ]);
    // A reference arm is FIRST, so a `--mechanism`-less run reads the shipped WebGL pipeline before
    // the WebGPU one, and a truncated table still contains the thing the other arm is compared with.
    expect(mechanismsOf(effectsWebgpuRuntime)[0]).toBe("particles-webgl");
    expect(() =>
      resolveParams(effectsWebgpuRuntime, { mechanism: "particles-vulkan" }),
    ).toThrow(/not one of/);
  });

  it("keeps S7's arm names for the arms it continues, and takes none of S6's", () => {
    // S7's table is what this scenario's numbers are read against (47 -> 87 Hz), so the four arms
    // that exist in both are spelled the same on purpose — a reader lining the tables up should not
    // have to translate. The probe's blit arm has no counterpart: nothing shipped blits from WebGPU.
    for (const mechanism of EFFECTS_WEBGPU_RUNTIME_MECHANISMS) {
      expect(EFFECTS_WEBGPU_MECHANISMS).toContain(mechanism);
    }
    expect(EFFECTS_WEBGPU_RUNTIME_MECHANISMS).not.toContain(
      "particles-webgpu-blit",
    );
    // …and none of S6's, whose arms name a different axis entirely (live/simcap/frozen).
    for (const mechanism of EFFECTS_MECHANISMS) {
      expect(EFFECTS_WEBGPU_RUNTIME_MECHANISMS).not.toContain(mechanism);
    }
  });

  it("classifies each arm the way `mount` and `metrics` switch on it", () => {
    expect(EFFECTS_WEBGPU_RUNTIME_MECHANISMS.filter(runtimeUsesWebgpu)).toEqual(
      ["particles-webgpu", "shaders-webgpu"],
    );
    expect(
      EFFECTS_WEBGPU_RUNTIME_MECHANISMS.filter(runtimeUsesParticles),
    ).toEqual(["particles-webgl", "particles-webgpu"]);
  });
});

// THE PREMISE. An arm and its reference differ by ONE option value. If `effectsRenderer` were ever
// left at its `"auto"` default on the reference side, that arm would adopt WebGPU on any device with
// an adapter — which is every device this scenario is worth running on — and the table would be
// WebGPU against WebGPU with a 0% difference reported as "productization cost nothing".
describe("effects-webgpu-runtime: the arm IS the effectsRenderer option", () => {
  it("pins both sides explicitly, and never to `auto`", () => {
    expect(effectsRendererFor("particles-webgl")).toBe("webgl");
    expect(effectsRendererFor("shaders-webgl")).toBe("webgl");
    expect(effectsRendererFor("particles-webgpu")).toBe("webgpu");
    expect(effectsRendererFor("shaders-webgpu")).toBe("webgpu");
    for (const mechanism of EFFECTS_WEBGPU_RUNTIME_MECHANISMS) {
      expect(effectsRendererFor(mechanism)).not.toBe("auto");
      // The renderer an arm asks for is exactly what its NAME says, in both directions.
      expect(effectsRendererFor(mechanism) === "webgpu").toBe(
        runtimeUsesWebgpu(mechanism),
      );
    }
  });

  it("forces the adapter only when asked, and only ever on purpose", () => {
    expect(forcesWebgpuAdapter(s8())).toBe(false);
    expect(forcesWebgpuAdapter(s8({ forceWebgpu: 0 }))).toBe(false);
    expect(forcesWebgpuAdapter(s8({ forceWebgpu: 1 }))).toBe(true);
    // Not a free-form number: a typo'd `--param forceWebgpu=2` must fail loudly rather than land on
    // a truthy branch that voids the arm without saying so.
    expect(() =>
      resolveParams(effectsWebgpuRuntime, { forceWebgpu: 2 }),
    ).toThrow(/not one of/);
  });
});

// THE SAME PIXELS AS S6 — at the default 12 AND at the 30+ the consuming project renders, which is
// the count this scenario exists to confirm the win at. "Shares the helper" is a fact about today's
// import graph; this is the assertion that makes it a fact about the RESULT.
describe("effects-webgpu-runtime: the same pixels as S6", () => {
  for (const overrides of [{}, { systems: 12 }, { systems: 30 }]) {
    const label = JSON.stringify(overrides);
    it(`lays out identically to effects-runtime for ${label}`, () => {
      const a = s8(overrides);
      const b = s6(overrides);
      expect(effectsSlotPx(a)).toBe(effectsSlotPx(b));
      expect(effectsCanvasPad(a)).toBe(effectsCanvasPad(b));
      for (const layout of LAYOUTS) {
        expect(effectsWebgpuRuntime.stageSize(a, layout)).toEqual(
          effectsRuntime.stageSize(b, layout),
        );
        expect(effectsWebgpuRuntime.gridShape?.(a, layout)).toEqual(
          effectsRuntime.gridShape?.(b, layout),
        );
        expect(effectsGridShape(a, layout)).toEqual(
          effectsGridShape(b, layout),
        );
        expect(effectsGridSize(a, layout)).toEqual(effectsGridSize(b, layout));
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

  it("puts a sample point in every cell, at both system counts", () => {
    // The presence guard is the only thing standing between "WebGPU presented nothing" and a
    // beautiful frame rate for a blank page, and on the WebGPU arms it is sampling pixels the
    // compositor owns rather than a 2D canvas. One point per cell, at its centre.
    for (const systems of [12, 30]) {
      for (const layout of LAYOUTS) {
        const params = s8({ systems });
        const points = effectsSamplePoints(params, layout);
        expect(points).toHaveLength(systems);
        const stage = effectsWebgpuRuntime.stageSize(params, layout);
        for (const point of points) {
          expect(point.x).toBeGreaterThan(0);
          expect(point.y).toBeGreaterThan(0);
          expect(point.x).toBeLessThan(stage.width);
          expect(point.y).toBeLessThan(stage.height);
        }
      }
    }
  });
});

describe("effects-webgpu-runtime: the same particles as S6", () => {
  it("builds S6's spec, field for field, on every arm", () => {
    for (const mechanism of EFFECTS_WEBGPU_RUNTIME_MECHANISMS) {
      for (const index of [0, 1, 5, 11, 29]) {
        expect(effectsSpec(s8({ mechanism }), index)).toEqual(
          effectsSpec(s6({ mechanism: "particles-live" }), index),
        );
      }
    }
  });

  it("carries S6's additive spec too — the case S7 refused", () => {
    // S7's probe threw on `blend=1` because it had no accumulate+resolve pass. The shipped WebGPU
    // renderer ports it, so the parameter is a measurement here rather than a refusal, and the spec
    // it produces has to be S6's or the arms are drawing different pictures.
    for (const mechanism of EFFECTS_WEBGPU_RUNTIME_MECHANISMS) {
      const spec = effectsSpec(s8({ mechanism, blend: 1 }), 0);
      expect(spec.blendMode).toBe(1);
      expect(spec).toEqual(effectsSpec(s6({ blend: 1 }), 0));
    }
    expect(() => resolveParams(effectsWebgpuRuntime, { blend: 2 })).toThrow(
      /not one of/,
    );
  });

  it("never caps the sim on any arm — there is no simcap knob to cap it with", () => {
    // `fixedFps: 0` is how `normalizeParticleConfig` spells Godot's default 30 Hz, i.e. UNCAPPED.
    // This scenario compares renderers; a capped sim on one arm would put a workload difference
    // inside a renderer comparison.
    for (const mechanism of EFFECTS_WEBGPU_RUNTIME_MECHANISMS) {
      expect(effectsSpec(s8({ mechanism }), 0).fixedFps).toBe(0);
    }
    expect(effectsWebgpuRuntime.params.simCapHz).toBeUndefined();
    expect(effectsWebgpuRuntime.params.pacing).toBeUndefined();
    // …and S6 still has both, so this is a deliberate omission and not a knob that vanished.
    expect(effectsRuntime.params.simCapHz).toBeDefined();
    expect(effectsRuntime.params.pacing).toBeDefined();
  });

  it("pins the defaults the device reading will be published against", () => {
    expect(s8()).toEqual({
      mechanism: "particles-webgl",
      systems: 12,
      amount: 64,
      cellPx: 96,
      blend: 0,
      fps: 0,
      renderScale: 1,
      churn: 8,
      forceWebgpu: 0,
      // Both OFF by default, so every S8 table published before the swap existed still describes
      // what a default run does.
      freeze: 0,
      swap: 0,
    });
    // `overLife` is NOT declared here, and the spec still gets S6's ramps: `effectsSpec` reads
    // `params.overLife ?? "ramps"`. That is why the spec-identity test above passes against S6's
    // defaults, and it is checked rather than assumed.
    expect(effectsWebgpuRuntime.params.overLife).toBeUndefined();
    expect(effectsSpec(s8(), 0).colorRamp).toBeDefined();
    expect(effectsSpec(s8(), 0).alphaCurve).toBeDefined();
  });
});

// WHICH KEYS EXIST IS A CLAIM. An absent key means NOT MEASURED, and a fabricated 0 cannot be told
// apart from a measured one — so the absences below carry as much as the presences: the WebGPU arms
// have no blit to time, and a `blitMs: 0` beside WebGL's 342 would read as "the blit got free".
describe("effects-webgpu-runtime: metric key sets", () => {
  const keys = (mechanism: string, forced = false) =>
    new Set(runtimeMetricKeysFor(mechanism, forced));
  const armsWith = (key: string) =>
    EFFECTS_WEBGPU_RUNTIME_MECHANISMS.filter((m) => keys(m).has(key));

  it("never reports an empty block, on any arm", () => {
    for (const mechanism of EFFECTS_WEBGPU_RUNTIME_MECHANISMS) {
      expect(runtimeMetricKeysFor(mechanism).length).toBeGreaterThan(0);
      // No duplicates — a repeated key would silently overwrite itself in the reported object.
      expect(keys(mechanism).size).toBe(runtimeMetricKeysFor(mechanism).length);
      // Every arm can answer "was every cell alive?".
      expect(keys(mechanism).has("renderedNodes")).toBe(true);
    }
  });

  it("keeps `glMs` and `blitMs` on the WebGL arms and `submitMs` on the WebGPU ones", () => {
    expect(armsWith("glMs")).toEqual(["particles-webgl", "shaders-webgl"]);
    expect(armsWith("blitMs")).toEqual(["particles-webgl", "shaders-webgl"]);
    expect(armsWith("submitMs")).toEqual([
      "particles-webgpu",
      "shaders-webgpu",
    ]);
    // Neither name ever appears on both sides of the rename: a `glMs` on a WebGPU arm would invite a
    // reader to median GL submit and WebGPU encode together, and a `submitMs` on a WebGL arm would
    // be GL wearing the other API's name.
    for (const mechanism of ["particles-webgpu", "shaders-webgpu"]) {
      expect(keys(mechanism).has("glMs")).toBe(false);
      expect(keys(mechanism).has("blitMs")).toBe(false);
    }
    for (const mechanism of ["particles-webgl", "shaders-webgl"]) {
      expect(keys(mechanism).has("submitMs")).toBe(false);
      expect(keys(mechanism).has("webgpuSubmits")).toBe(false);
    }
  });

  it("carries the validity rows on the WebGPU arms and none of the WebGL ones", () => {
    for (const key of [
      "rendererWebgpu",
      "webgpuFallbacks",
      "webgpuSubmits",
      "gpuErrors",
      "deviceLosses",
    ]) {
      expect(armsWith(key)).toEqual(["particles-webgpu", "shaders-webgpu"]);
    }
    // `webgpuBindingFallbacks` exists only on the SHADER runtime: it is the only one that can put
    // some bindings on WebGL under a WebGPU runtime (SCREEN_TEXTURE, a WGSL-transpile refusal). The
    // particle runtime has no such counter, and inventing a 0 for it would claim a measurement the
    // runtime never makes.
    expect(armsWith("webgpuBindingFallbacks")).toEqual(["shaders-webgpu"]);
  });

  it("reports `forcedAdapter` only when the adapter was really forced", () => {
    for (const mechanism of EFFECTS_WEBGPU_RUNTIME_MECHANISMS) {
      expect(keys(mechanism, false).has("forcedAdapter")).toBe(false);
    }
    expect(keys("particles-webgpu", true).has("forcedAdapter")).toBe(true);
    expect(keys("shaders-webgpu", true).has("forcedAdapter")).toBe(true);
    // …and never on a WebGL arm, which asks for no adapter at all.
    expect(keys("particles-webgl", true).has("forcedAdapter")).toBe(false);
    expect(keys("shaders-webgl", true).has("forcedAdapter")).toBe(false);
  });

  it("reports no simulation on the shader arms, because there is none", () => {
    for (const key of ["simMs", "simSteps", "instances", "buildMs"]) {
      expect(keys("shaders-webgpu").has(key)).toBe(false);
      expect(keys("shaders-webgl").has(key)).toBe(false);
      expect(keys("particles-webgpu").has(key)).toBe(true);
      expect(keys("particles-webgl").has(key)).toBe(true);
    }
    // …and no `boxReads` either: that claim is about the particle runtime's observer sizing.
    expect(armsWith("boxReads")).toEqual([
      "particles-webgl",
      "particles-webgpu",
    ]);
  });

  it("keeps the WebGL arms reporting exactly S6's keys", () => {
    // The reference arms mount the shipped runtimes with `effectsProfiling` on, so their key set is
    // `particleCounters`/`shaderCounters` plus S6's two whole-life rows. If this drifts, the
    // in-session reference stops being comparable with S6's and S7's published tables.
    expect(runtimeMetricKeysFor("particles-webgl").sort()).toEqual(
      [
        "blitMs",
        "boxReads",
        "buildMs",
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
    expect(runtimeMetricKeysFor("shaders-webgl").sort()).toEqual(
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

  it("gives the WebGPU arms the same workload keys as their reference", () => {
    // Everything that is not about the RENDERER must be identical across the pair, or the arms are
    // not subtractable: same sim keys, same draw counts, same tick counts.
    for (const [webgl, webgpu] of [
      ["particles-webgl", "particles-webgpu"],
      ["shaders-webgl", "shaders-webgpu"],
    ]) {
      const shared = [...keys(webgl)].filter(
        (key) => key !== "glMs" && key !== "blitMs",
      );
      for (const key of shared) {
        expect(keys(webgpu).has(key)).toBe(true);
      }
    }
  });
});

// THE RENAME ITSELF, which is the one place this scenario transforms a number rather than reporting
// it. It has to move `glMs` and drop `blitMs` and touch nothing else — a rename that also rounded,
// re-keyed or dropped a workload counter would be editing the runtime's evidence.
describe("effects-webgpu-runtime: renameWebgpuBuckets", () => {
  it("moves glMs to submitMs, drops blitMs, and leaves every other key alone", () => {
    expect(
      renameWebgpuBuckets({
        profTicks: 217,
        simSteps: 900,
        simMs: 60.12,
        buildMs: 15.5,
        glMs: 139.7,
        blitMs: 0,
        instances: 89052,
        webgpuSubmits: 217,
      }),
    ).toEqual({
      profTicks: 217,
      simSteps: 900,
      simMs: 60.12,
      buildMs: 15.5,
      submitMs: 139.7,
      instances: 89052,
      webgpuSubmits: 217,
    });
  });

  it("carries the not-measured state through: no profile, no bucket keys", () => {
    // `effectsProfiling` off (or a no-op runtime) means the runtime returns `profile: null` and
    // `particleCounters` contributes no bucket keys at all. The rename must not invent `submitMs`
    // out of a missing `glMs` — "nobody measured" has to survive the boundary.
    expect(renameWebgpuBuckets({ particleDraws: 12 })).toEqual({
      particleDraws: 12,
    });
    expect(renameWebgpuBuckets({})).toEqual({});
    expect(renameWebgpuBuckets({ blitMs: 342.3 })).toEqual({});
  });
});

// FREEZE AND SWAP ARE PARAMS, NOT ARMS — they apply to the arm AND its reference, and the reading is
// the SAME arm at swap=0 against swap=1. That is the discipline these tests exist to hold: an option
// that reached only one side of a pair would turn a swap measurement into a renderer measurement.
describe("effects-webgpu-runtime: the freeze/swap params", () => {
  it("declares both as 0/1 params with 0 the default", () => {
    for (const name of ["freeze", "swap"]) {
      expect(effectsWebgpuRuntime.params[name]).toBeDefined();
      expect(effectsWebgpuRuntime.params[name].default).toBe(0);
      expect(effectsWebgpuRuntime.params[name].values).toEqual([0, 1]);
    }
    // Default OFF on both, so every S8 table published before this existed still describes what the
    // default run does.
    expect(freezesPopulation(s8())).toBe(false);
    expect(swapsFrozenSurfaces(s8())).toBe(false);
    expect(freezesPopulation(s8({ freeze: 1 }))).toBe(true);
    expect(swapsFrozenSurfaces(s8({ freeze: 1, swap: 1 }))).toBe(true);
  });

  it("freezes the runtime the ARM actually mounts, and nothing else", () => {
    // A frozen particle system is warmed once from its seed and its loop parked; a frozen shader
    // renders ONE frame at a pinned TIME. Neither option means anything to the other runtime, and
    // setting it there would be a claim in the options object that nothing reads.
    expect(frozenSurfaceOptions(s8({ freeze: 1 }), "particles-webgl")).toEqual({
      staticParticles: true,
      staticParticleImages: false,
      staticShaderImages: false,
    });
    expect(frozenSurfaceOptions(s8({ freeze: 1 }), "shaders-webgpu")).toEqual({
      staticShaders: true,
      staticShaderTime: 1,
      staticParticleImages: false,
      staticShaderImages: false,
    });
  });

  it("pins BOTH image-swap options in BOTH directions, on every arm", () => {
    // `staticShaderImages` SHIPS ON. An omitted `false` at swap=0 would let a freeze=1 reference
    // engage the mechanism implicitly, and the swap=0/swap=1 pair would be comparing a swapped
    // window against a swapped window.
    for (const mechanism of EFFECTS_WEBGPU_RUNTIME_MECHANISMS) {
      for (const params of [s8(), s8({ freeze: 1 })]) {
        const options = frozenSurfaceOptions(params, mechanism);
        expect(options.staticShaderImages).toBe(false);
        expect(options.staticParticleImages).toBe(false);
      }
      const swapped = frozenSurfaceOptions(
        s8({ freeze: 1, swap: 1 }),
        mechanism,
      );
      expect(swapped.staticShaderImages).toBe(true);
      expect(swapped.staticParticleImages).toBe(true);
    }
  });

  it("gives an arm and its reference IDENTICAL freeze/swap options", () => {
    // The premise of the whole scenario, restated for the new params: the pair differs by
    // `effectsRenderer` and by nothing else.
    for (const [webgl, webgpu] of [
      ["particles-webgl", "particles-webgpu"],
      ["shaders-webgl", "shaders-webgpu"],
    ]) {
      for (const params of [
        s8(),
        s8({ freeze: 1 }),
        s8({ freeze: 1, swap: 1 }),
      ]) {
        expect(frozenSurfaceOptions(params, webgl)).toEqual(
          frozenSurfaceOptions(params, webgpu),
        );
      }
    }
  });

  it("REFUSES swap=1 without freeze=1, with the remedy front-loaded", () => {
    // A live population never earns a swap (a live shader's content key moves every frame; a live
    // particle system paints every frame), so the run would publish an armed mechanism that never
    // engaged — a swap=1 row identical to swap=0, read as "the mechanism does nothing".
    //
    // The refusal is the first thing `mount()` does, before it touches the DOM, which is what lets a
    // node test reach it at all.
    const ctx = {
      root: {} as HTMLElement,
      params: s8({ swap: 1 }),
      layout: DESKTOP,
    };
    expect(() => effectsWebgpuRuntime.mount(ctx as never)).toThrowError(
      /--param freeze=1/,
    );
    // …and the legal combinations do NOT throw here (they fail later, on a DOM this test has none
    // of — which is why only the refusal is asserted).
    expect(swapsFrozenSurfaces(s8({ swap: 1 }))).toBe(true);
    expect(freezesPopulation(s8({ swap: 1 }))).toBe(false);
  });
});

describe("effects-webgpu-runtime: the swap's reported keys", () => {
  const swapKeys = [
    "staticImageSwaps",
    "staticImageReverts",
    "staticImageEncodes",
    "staticImageFailures",
    "staticImageEncodeMs",
    "staticImageCaptureMs",
    // Captures refused as entirely transparent — the counter that tells "12/12 surfaces swapped"
    // apart from "12/12 surfaces swapped to a picture of nothing" (see the scenario's traps).
    "staticImageBlankCaptures",
    "staticImagesLive",
  ];

  it("reports NOTHING about the swap on a run that did not arm it", () => {
    // The `forcedAdapter` convention: an absent key means NOT MEASURED. `staticImageSwaps: 0` on a
    // run with the mechanism switched off would not mean "nothing swapped", it would mean "nothing
    // was asked to", and a reader cannot tell those apart from a zero.
    for (const mechanism of EFFECTS_WEBGPU_RUNTIME_MECHANISMS) {
      const keys = new Set(runtimeMetricKeysFor(mechanism));
      for (const key of swapKeys) {
        expect(keys.has(key)).toBe(false);
      }
    }
  });

  it("adds the seven window deltas and the live GAUGE on a swap run, on every arm", () => {
    for (const mechanism of EFFECTS_WEBGPU_RUNTIME_MECHANISMS) {
      const before = runtimeMetricKeysFor(mechanism);
      const after = runtimeMetricKeysFor(mechanism, false, true);
      expect(new Set(after).size).toBe(after.length); // no duplicates
      // Purely ADDITIVE: a swap run still reports everything a non-swap run does, or the two could
      // not be read against each other — which is the entire point of the swap=0/swap=1 pair.
      for (const key of before) {
        expect(after).toContain(key);
      }
      expect(after.filter((key) => !before.includes(key)).sort()).toEqual(
        [...swapKeys].sort(),
      );
    }
  });

  it("rounds both swap ms counters like every other ms counter", () => {
    // `counterDelta` rounds to 2dp only for keys in this set; an unrounded ms column would print
    // 17 digits of float noise beside a rounded one.
    expect(EFFECTS_MS_COUNTERS.has("staticImageEncodeMs")).toBe(true);
    expect(EFFECTS_MS_COUNTERS.has("staticImageCaptureMs")).toBe(true);
    // The two stay SEPARATE: encode-ms is synchronous main-thread park, capture-ms is a GPU
    // readback's wall time, and adding them would invent a park that never happened.
    expect(EFFECTS_MS_COUNTERS.has("staticImageMs")).toBe(false);
  });

  it("keeps the swap keys out of the WebGPU bucket rename", () => {
    // `renameWebgpuBuckets` only ever touches `glMs`/`blitMs`; the swap's counters mean the same
    // thing on both renderers and must arrive unrenamed.
    expect(
      renameWebgpuBuckets({
        glMs: 12.5,
        blitMs: 4,
        staticImageEncodeMs: 8.25,
        staticImageCaptureMs: 31.5,
        staticImageSwaps: 12,
      }),
    ).toEqual({
      submitMs: 12.5,
      staticImageEncodeMs: 8.25,
      staticImageCaptureMs: 31.5,
      staticImageSwaps: 12,
    });
  });
});
