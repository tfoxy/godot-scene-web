// S6 `effects-runtime` — a live particle system's frame, taken apart.
//
// THE QUESTION. On the target phone (moto g86 5G) live PARTICLES feel slow with only a handful of
// systems on screen, while live SHADERS do not. The suspicion is the CPU simulation
// (`packages/html/src/particles/simulate.ts`), which runs a fixed-step integration over every
// particle of every system on the main thread every tick. But a particle frame is FOUR things —
// the sim, the instance-buffer build, the instanced GL draw, and the GL→2D blit onto the node's
// canvas — plus whatever it costs merely to keep N composited canvases on screen. "Particles are
// slow" names none of them.
//
// So this scenario separates them BY CONSTRUCTION, mounting the REAL shipped runtimes
// (`createParticleRuntime` / `createWebglShaderRuntime` from `@godot-scene-web/html`). Measuring a
// re-derivation would measure the wrong code, exactly as S1's `page-crop` arm calls the shipped
// `regionBackgroundStyle` rather than a copy of its crop math.
//
// THE ARMS
//
//   particles-live     sim (fixed 30 Hz) + build + instanced draw + blit, every tick — the real thing
//   particles-simcap   the IDENTICAL spec with `fixedFps: simCapHz` (default 1). One sim step per
//                      second instead of thirty; every particle stays alive and the build + draw +
//                      blit path is byte-identical. `live - simcap` is the CPU sim.
//   particles-frozen   the identical spec again with the runtime option `staticParticles: true`:
//                      each system is warmed once, drawn once, and the loop PARKS. The compositing
//                      floor — N canvases on screen with nothing redrawing them.
//   shaders-live       the WebGL shader runtime at the same cell count and the same canvas pixel
//                      count, running a TIME-driven shader: GL draw + blit every tick, no CPU sim.
//                      The particles-vs-shaders delta at equal pixels.
//
// WHY `fixedFps` IS THE ONLY KNOB THAT CAN DO THIS. `simulateParticles` steps
// `while (remainder >= 1/fixedFps)` (`simulate.ts`), and `normalizeParticleConfig` reads
// `fixedFps: 0` as Godot's default 30 (`state.ts`). Lowering it makes the sim step RARELY while
// leaving every other input to the draw path untouched — same `amount`, same active instances, same
// blend, same canvas.
//
// THE `speedScale: 0` TRAP, which looks like the obvious way to do this and silently measures an
// empty page. `simulateParticles` accumulates `dt * speedScale`, so at zero the remainder never
// reaches a step boundary, no slot is ever restarted, and every particle stays INACTIVE. The
// runtime's `drawBinding` then takes its clear-only path — no instance build, no `drawParticles`,
// no `onBindingRendered` — while `particlesAreLive` still reports the binding as live (it is still
// `emitting`), so the loop keeps spinning over nothing. The arm would report a beautiful frame rate
// for a blank canvas. `fixedFps` is the knob; `speedScale` is not.
//
// THE CHURN STRIP, and why a scenario about particles has to draw something that is not a particle.
// The frozen arm PARKS the loop: it draws once and returns without re-arming, so nothing activates
// a layer tree for the rest of the window. The harness's own report validation rejects
// `contentUpdateHz <= 0` as "nothing was measured" — a correct frozen run would be thrown out as a
// broken one. So the scenario carries a small strip of unrelated cells recoloured every frame in
// `step()`, exactly as S5 `static-surfaces` does, which also supplies the "while the DOM renders
// other things" half of every arm's steady state.
//
// THE EQUAL-INSTANCE-COUNT LAW, which is what actually sets `lifetime`. The simcap arm is only an
// isolation of the sim if it draws the SAME NUMBER of particles as the live arm. A slot dies the
// step its age reaches `lifetime` and is only reborn when the cycle clock next crosses its birth
// phase, so the fraction of slots momentarily dead is one sim step per lifetime — negligible at
// 30 Hz, and one HALF at `fixedFps: 1` with a 2-second lifetime. Measured with the real simulation:
// 64 slots, `lifetime=2` gives 63 active live against 32 under the cap (the arm would be drawing
// half the work and the "sim cost" would silently include half the draw); `lifetime=32` gives 64
// against 62. So the lifetime is 32 s and the velocities are derived from a TRAVEL BUDGET
// (`cellPx/2` over one lifetime) rather than authored, which keeps the spray inside its canvas.
// Per-step sim cost does not depend on lifetime or velocity, so nothing about what is being measured
// moves — only the aliasing does.
//
// WHY `preprocess`. Godot pre-simulates `preprocess` seconds before the first draw, and this
// runtime does it at binding create — i.e. inside `readyMs`, before the measured window. One
// lifetime of preprocess is what makes every slot have emitted at least once, so all four arms open
// their window at a full, steady-state instance count instead of ramping up through it.
//
// WHY A SEED PER SYSTEM. `seed: EFFECTS_SEED_BASE + index`. Identical specs would collapse in the
// frozen arm's module-scoped static-frame cache (N systems become one warm + one draw + N blits —
// see `staticStepBinding`), so the floor would be measured for one system and N cheap blits. Distinct
// seeds also stop N systems from being one simulation drawn N times in the live arms.
//
// NO TEXTURE, NO ATLAS, NO BACKGROUND FIXTURE. This scenario deliberately declares no `regions` /
// `atlasPage` params: the runner's defaults match S1's cached fixture, and declaring different ones
// would regenerate a 15 MB atlas page for a scenario that never reads it. Untextured particles draw
// the runtime's built-in procedural dot (`render-webgl.ts`), so sprite-sheet decode and texture
// upload are an explicit NON-GOAL here — a different question, for a different scenario.
//
// NO `perf assert` GATE. Gates get written FROM device readings, not from desktop intuition: S2's
// gate was written that way and a device run then contradicted three of its five relations. The
// verdict arithmetic is in `docs/perf-harness.md`; the numbers to put in it come off the phone.

import {
  emissionExtentPad,
  SELF_LAYER_CLASS,
  spriteExtentPad,
} from "@godot-scene-web/html";
import type {
  GodotHtmlMountOptions,
  ParticleSpecConfig,
} from "@godot-scene-web/html/runtime";
import {
  createParticleRuntime,
  createWebglShaderRuntime,
  type ParticleRuntime,
  type ParticleRuntimeStats,
  type WebglShaderRuntime,
  type WebglShaderRuntimeStats,
} from "@godot-scene-web/html/runtime";
import { type GridShape, gridShapeFor } from "../fit";
import type {
  ParamValue,
  Scenario,
  ScenarioContext,
  StageLayout,
} from "./types";

export const EFFECTS_MECHANISMS = [
  "particles-live",
  "particles-simcap",
  "particles-frozen",
  "shaders-live",
];

/**
 * The counter keys whose values are MILLISECONDS rather than counts, and are therefore rounded
 * before they leave `metrics()` — every other key is an integer event count and is reported raw.
 */
export const EFFECTS_MS_COUNTERS = new Set([
  "simMs",
  "buildMs",
  "glMs",
  "blitMs",
  // The frozen-surface image swap's two costs, reported only by S8's `swap=1` runs (see
  // `effects-webgpu-runtime.ts`). Kept apart from each other for the reason the html package keeps
  // them apart: `staticImageEncodeMs` is synchronous main-thread PARK, `staticImageCaptureMs` is a
  // GPU readback's wall time, and adding them would invent a park that never happened.
  "staticImageEncodeMs",
  "staticImageCaptureMs",
]);

/**
 * One particle's LIFETIME in seconds, and the single most load-bearing constant in the file.
 *
 * See the equal-instance-count law above: the simcap arm is an isolation of the sim only while it
 * draws as many particles as the live arm, and the fraction of momentarily-dead slots is one sim
 * step per lifetime. At `simCapHz=1` that is `1/32` here, against `1/2` at the 2-second lifetime a
 * "normal-looking" spray would use.
 */
export const EFFECTS_LIFETIME_S = 32;
/** `preprocess`, in seconds: one whole lifetime, so every slot has emitted before the window opens. */
export const EFFECTS_PREPROCESS_S = EFFECTS_LIFETIME_S;
/** Base of the per-system seed. `seed: EFFECTS_SEED_BASE + index` — see the seed note above. */
export const EFFECTS_SEED_BASE = 1337;

/** Gap between neighbouring cells, and the padding around the whole grid, in CSS px. */
export const EFFECTS_CELL_GAP_PX = 10;
export const EFFECTS_GRID_PAD_PX = 16;
/** The authored column count, used on an unfitted (desktop) run so the reference table stays valid. */
export const EFFECTS_COLUMNS = 4;
/** Breathing room so a sample point never lands on the stage's clip edge. */
const STAGE_MARGIN = 16;

/** The churn strip: unrelated content repainted every frame, below the effect grid (S5's shape). */
const CHURN_WIDTH = 44;
const CHURN_HEIGHT = 56;
const CHURN_GAP = 8;
const CHURN_MARGIN = 12;

/** How long `ready()` waits for every binding to render once before calling the arm unmeasurable. */
const READY_TIMEOUT_MS = 8000;

/** Edge (px) of the decode canary's own image — see `decodeCanaryUrl`. Re-exported below because S7
 *  `effects-webgpu` paints no images either and SHARES this canary rather than growing a second. */
const CANARY_PX = 8;
export const EFFECTS_CANARY_PX = CANARY_PX;

/**
 * THE DECODE CANARY, and why a scenario that paints no images has to paint one anyway.
 *
 * `validateReport` rejects `decode.count === 0` outright: for every scenario before this one a zero
 * there meant the cc decode-cache event names had DRIFTED (the software path emits
 * `SoftwareImageDecodeCache::*`, a phone's GPU path emits `GpuImageDecodeCache::*`), and reporting a
 * drifted matcher as "no decode cost" is the worst mistake this harness could make. S6 is the first
 * scenario whose page genuinely paints no image at all — GL canvases and solid colours — so it would
 * be failed by an invariant that is true of every OTHER scenario.
 *
 * So the stage carries ONE tiny generated PNG, painted once in a corner of the container. The trace
 * then has a real decode of a real painted image, which is what the validator is actually asking
 * about. It rides the CONTAINER and not the churn cells on purpose: a cell that repaints every frame
 * re-decodes its background with it (measured: 150 decode tasks and 8 ms of decode for the same one
 * image), which is a per-frame cost this scenario has no reason to pay and a `REDECODES` row a
 * reader would have to explain. It is also deliberately NOT an atlas region — texture decode is this
 * scenario's stated non-goal, and a 4096² page would put ~150 ms of it inside every arm.
 *
 * `toDataURL` (not `toBlob`) so mount stays synchronous — there is nothing to await, and the stage
 * carries its image from the first painted frame.
 */
export function decodeCanaryUrl(): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = CANARY_PX;
  canvas.height = CANARY_PX;
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) {
    return null;
  }
  // Two tones with alpha, so the PNG really carries colour AND an alpha channel — a single flat
  // opaque pixel is the sort of image an encoder or a cache can treat specially.
  ctx2d.fillStyle = "rgba(255, 255, 255, 0.30)";
  ctx2d.fillRect(0, 0, CANARY_PX / 2, CANARY_PX / 2);
  ctx2d.fillRect(CANARY_PX / 2, CANARY_PX / 2, CANARY_PX / 2, CANARY_PX / 2);
  ctx2d.fillStyle = "rgba(0, 0, 0, 0.20)";
  ctx2d.fillRect(CANARY_PX / 2, 0, CANARY_PX / 2, CANARY_PX / 2);
  ctx2d.fillRect(0, CANARY_PX / 2, CANARY_PX / 2, CANARY_PX / 2);
  return canvas.toDataURL("image/png");
}

/**
 * The shader the `shaders-live` arm runs, as Godot source.
 *
 * It MUST read `TIME`: the shader runtime only re-renders a binding whose program `usesTime`
 * (`webgl/runtime.ts`'s loop sets `animated` from exactly that), so a static shader would render
 * once, park, and measure the same thing the frozen particle arm measures.
 *
 * Delivered through the `resolveShaderSource(path, uid)` runtime option rather than a `.gdshader`
 * file, because that option IS the runtime's source contract — there is no file lookup to reproduce.
 */
export const EFFECTS_SHADER_SOURCE = `shader_type canvas_item;

void fragment() {
    vec2 p = UV - vec2(0.5);
    float r = length(p) * 2.0;
    float wave = 0.5 + 0.5 * sin(r * 12.0 - TIME * 2.5);
    vec3 tint = vec3(0.45 + 0.4 * wave, 0.30 + 0.25 * wave, 0.85 - 0.3 * wave);
    COLOR = vec4(tint, clamp(1.0 - 0.5 * r, 0.35, 1.0));
}
`;

/** The resource path the shader nodes carry, and the key `resolveShaderSource` is asked for. */
export const EFFECTS_SHADER_PATH = "res://perf/effects_runtime.gdshader";

export const EFFECTS_RUNTIME_PARAMS: Record<
  string,
  { default: ParamValue; values?: ParamValue[]; describe: string }
> = {
  mechanism: {
    default: "particles-live",
    values: EFFECTS_MECHANISMS,
    describe: "which effect runtime runs, and how much of it runs per tick",
  },
  systems: {
    default: 12,
    describe: "particle systems (or shader nodes) mounted on the stage",
  },
  amount: { default: 64, describe: "particles per system" },
  cellPx: {
    default: 96,
    describe:
      "one system's node box in CSS px; its canvas is this plus the runtime's own sprite/emission pad on every side",
  },
  simCapHz: {
    default: 1,
    describe:
      "the simcap arm's `fixedFps`. 1 = one sim step per second against the live arm's 30, with the draw path untouched",
  },
  overLife: {
    default: "ramps",
    values: ["ramps", "none"],
    describe:
      "`ramps` gives every particle a colour ramp + alpha/scale curves, so the sim pays the per-particle sampleGradient/sampleCurve chain in updateDisplay; `none` omits them",
  },
  blend: {
    default: 0,
    values: [0, 1],
    describe:
      "CanvasItemMaterial blend mode: 0 mix, 1 ADD — which costs a second accumulate+resolve pass in render-webgl",
  },
  fps: {
    default: 0,
    describe:
      "FPS cap for BOTH effect loops (particleFps / shaderFps). 0 = uncapped. A cap cannot reduce sim cost — see the docs",
  },
  pacing: {
    default: "timer",
    values: ["timer", "raf"],
    describe:
      "how a CAPPED loop arms its next tick (effectsLoopPacing): `timer` parks to the cap boundary, `raf` spins every display frame",
  },
  renderScale: {
    default: 1,
    describe:
      "backing-store multiplier for every effect canvas, on top of devicePixelRatio (<1 renders the effects smaller and upscales)",
  },
  churn: {
    default: 8,
    describe:
      "unrelated cells repainted every frame beside the effects. NOT decoration: the frozen arm parks its loop, and a run with zero layer activations is rejected by the report validator as 'nothing was measured'",
  },
};

/**
 * URL params arrive as STRINGS (`serve.ts` stringifies every value into the query and the in-page
 * `readParams` only coerces numerics), while `resolveParams` on the node side produces real numbers
 * and booleans. Both spellings therefore reach scenario code.
 */
function numParam(value: ParamValue | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mechanismOf(params: { mechanism?: unknown }): string {
  return String(params.mechanism ?? EFFECTS_MECHANISMS[0]);
}

/** Whether this arm mounts the PARTICLE runtime (three of the four do). */
export function usesParticleRuntime(mechanism: string): boolean {
  return mechanism.startsWith("particles-");
}

/** Whether this arm freezes the particle runtime (warm+draw once, then park the loop). */
export function usesFrozenParticles(mechanism: string): boolean {
  return mechanism === "particles-frozen";
}

/**
 * The `fixedFps` this arm's spec carries: `simCapHz` on the simcap arm, 0 (= Godot's default 30 Hz,
 * see `normalizeParticleConfig`) everywhere else.
 *
 * CLAMPED TO AN INTEGER >= 1. `normalizeParticleConfig` ROUNDS `fixedFps`, so `simCapHz=0.5` would
 * become 0 — which does not mean "half a step per second", it means the live arm's 30 Hz. The simcap
 * arm would then be the live arm under a different name and the table would read as "the sim is
 * free".
 */
export function simCapFixedFps(params: {
  mechanism?: unknown;
  simCapHz?: unknown;
}): number {
  if (mechanismOf(params) !== "particles-simcap") {
    return 0;
  }
  return Math.max(1, Math.round(numParam(params.simCapHz as never, 1)));
}

/**
 * The over-life ramps + curves the `overLife: "ramps"` mode adds to a spec.
 *
 * These are the point of the parameter: `updateDisplay` samples `colorRamp` through
 * `sampleGradient` and the curves through `sampleCurve` FOR EVERY PARTICLE OF EVERY STEP, so they
 * are a real slice of the sim's per-particle cost and not a look.
 *
 * Two constraints they must respect, both about not moving anything else:
 *   - the scale curve PEAKS AT 1 and only shrinks, so `spriteExtentPad` (which pads the canvas by
 *     the curve's max) returns the same pad as `overLife: "none"`. A curve peaking above 1 would
 *     make a non-geometric parameter change the canvas size, and the two modes would no longer be
 *     comparable at equal pixels.
 *   - the alpha curve STARTS AT 1, so a just-born particle at the cell centre — which is what
 *     `samplePoints` aims the presence guard at — is fully opaque. A fade-IN would make a correct
 *     render read as a blank page.
 */
function overLifeRamps(): Partial<ParticleSpecConfig> {
  return {
    colorRamp: [
      { offset: 0, color: [1, 0.86, 0.45, 1] },
      { offset: 0.5, color: [1, 0.42, 0.22, 1] },
      { offset: 1, color: [0.35, 0.18, 0.65, 1] },
    ],
    alphaCurve: [
      { x: 0, y: 1 },
      { x: 0.65, y: 0.75 },
      { x: 1, y: 0.15 },
    ],
    scaleCurve: [
      { x: 0, y: 1 },
      { x: 1, y: 0.35 },
    ],
  };
}

/**
 * System `index`'s particle spec — the `data-godot-particle-specs` payload, in the runtime's own
 * field naming (`parseParticleConfig` → `normalizeParticleConfig` in `particles/state.ts`, which
 * fills every field it is not given from Godot's defaults, so a hand-authored partial spec is a
 * supported input and no `.tscn`, parser or resolver is involved).
 *
 * PURE, and exported, because the whole isolation rests on one property a test can check without a
 * browser: the live and simcap specs are IDENTICAL apart from `fixedFps`.
 *
 * The emission is a POINT at the cell centre (`originX/originY` — a draw-space translation the
 * runtime applies at `drawBinding`, so unlike `emissionOffset` it costs no canvas pad), with
 * `explosiveness: 0, randomness: 0` so births are spread evenly across the cycle: there is always a
 * just-born particle sitting at that centre, which is where `samplePoints` sends the presence guard.
 * `spread: 180` about `direction: [0,-1]` with no gravity makes the spray symmetric, so the cloud is
 * centred on the cell whatever the seed.
 */
export function effectsSpec(
  params: Record<string, ParamValue>,
  index: number,
): Partial<ParticleSpecConfig> {
  const cellPx = numParam(params.cellPx, 96);
  const amount = Math.max(1, Math.round(numParam(params.amount, 64)));
  // The travel budget: a particle's whole life must fit inside its own cell, or the spray is clipped
  // by the canvas and the arms stop drawing the same pixels. Half a cell over one lifetime.
  const velocityMax = cellPx / 2 / EFFECTS_LIFETIME_S;
  return {
    kind: "CPUParticles2D",
    amount,
    amountRatio: 1,
    lifetime: EFFECTS_LIFETIME_S,
    lifetimeRandomness: 0,
    oneShot: false,
    emitting: true,
    explosiveness: 0,
    randomness: 0,
    preprocess: EFFECTS_PREPROCESS_S,
    speedScale: 1,
    // THE one field that differs between the live and simcap arms. See `simCapFixedFps`.
    fixedFps: simCapFixedFps(params),
    localCoords: false,
    drawOrder: 0,
    seed: EFFECTS_SEED_BASE + index,
    // Point emission. Every field the canvas-pad law reads is stated explicitly (see
    // `effectsCanvasPad`), not left to the normalizer, so the geometry is provable from the spec.
    emissionShape: 0,
    emissionOffset: [0, 0],
    emissionScale: [1, 1],
    emissionSphereRadius: 0,
    emissionRingRadius: 0,
    emissionRingInnerRadius: 0,
    emissionBoxExtents: [0, 0],
    direction: [0, -1],
    spread: 180,
    initialVelocityMin: velocityMax / 3,
    initialVelocityMax: velocityMax,
    gravity: [0, 0],
    scaleMin: 1,
    scaleMax: 1,
    baseColor: [1, 0.78, 0.42, 1],
    // The emitter sits at the cell's centre; the canvas is anchored on the node box.
    originX: cellPx / 2,
    originY: cellPx / 2,
    // Untextured: the runtime draws its built-in procedural dot at DEFAULT_DOT (16 px) — see the
    // no-texture non-goal above. Stated rather than defaulted for the same reason as the emission.
    textureUrl: null,
    textureWidth: 0,
    textureHeight: 0,
    hframes: 1,
    vframes: 1,
    blendMode: Math.round(numParam(params.blend, 0)),
    ...(String(params.overLife ?? "ramps") === "ramps" ? overLifeRamps() : {}),
  };
}

/**
 * The per-side canvas pad the particle runtime will grow each node's canvas by, from the runtime's
 * OWN pad law (`spriteExtentPad` + `emissionExtentPad`, both pure and exported by
 * `@godot-scene-web/html`).
 *
 * Imported rather than re-derived on purpose: this number decides the canvas pixel count, the
 * shader arm's node box (which has to match it) and the stage box, and a local copy of the law
 * would drift from the runtime's the first time the runtime's changed — the scenario would then be
 * comparing two different canvas sizes and calling it a mechanism difference.
 *
 * The cast is safe by construction: `effectsSpec` states every field these two read
 * (texture size, hframes/vframes, scale range, scale curves, emission shape/offset/scale/extents).
 */
export function effectsCanvasPad(params: Record<string, ParamValue>): number {
  const spec = effectsSpec(params, 0) as ParticleSpecConfig;
  return spriteExtentPad(spec, null) + emissionExtentPad(spec);
}

/**
 * One grid slot in CSS px: the CANVAS footprint, not the node box.
 *
 * The particle node is `cellPx` inset by the pad inside it, and the shader node fills it — so both
 * arms produce a canvas of exactly this size, centred on exactly the same point. Which is the whole
 * basis for comparing them: "same cell count, same canvas pixel count".
 */
export function effectsSlotPx(params: Record<string, ParamValue>): number {
  return numParam(params.cellPx, 96) + effectsCanvasPad(params) * 2;
}

export function effectsGridShape(
  params: { systems?: unknown },
  layout: StageLayout,
): GridShape {
  const count = Math.max(1, Number(params.systems ?? 0) || 0);
  if (!layout.fit) {
    return {
      columns: Math.min(EFFECTS_COLUMNS, count),
      rows: Math.ceil(count / EFFECTS_COLUMNS),
    };
  }
  // Square cells, so the cell aspect is 1 — S1's and S5's rule, for their reason: a landscape grid
  // fitted into a portrait phone renders tiny and under-loads the work being measured.
  return gridShapeFor(
    count,
    1,
    layout.viewport.height > 0
      ? layout.viewport.width / layout.viewport.height
      : 1,
  );
}

/** Slot `index`'s top-left in CSS px. */
export function effectsCellBox(
  index: number,
  columns: number,
  params: Record<string, ParamValue>,
): { left: number; top: number; size: number } {
  const size = effectsSlotPx(params);
  const pitch = size + EFFECTS_CELL_GAP_PX;
  return {
    left: EFFECTS_GRID_PAD_PX + (index % columns) * pitch,
    top: EFFECTS_GRID_PAD_PX + Math.floor(index / columns) * pitch,
    size,
  };
}

/** The effect grid's own box in CSS px. Pure, so the stage box can be proved without a browser. */
export function effectsGridSize(
  params: Record<string, ParamValue>,
  layout: StageLayout,
): { width: number; height: number } {
  const { columns, rows } = effectsGridShape(params, layout);
  const size = effectsSlotPx(params);
  const pitch = size + EFFECTS_CELL_GAP_PX;
  return {
    width: EFFECTS_GRID_PAD_PX * 2 + size + Math.max(0, columns - 1) * pitch,
    height: EFFECTS_GRID_PAD_PX * 2 + size + Math.max(0, rows - 1) * pitch,
  };
}

/**
 * Where each churn cell sits, in CSS px. The strip WRAPS at the effect grid's width instead of
 * running off to the right in one line — S5's rule, and for its reason: a strip wider than the grid
 * would set the stage width and drag the fit scale down, so the scenario would be rastered at a
 * scale the device never uses (the exact failure `src/fit.ts` exists to prevent).
 */
export function churnCellsFor(
  params: Record<string, ParamValue>,
  layout: StageLayout,
): { left: number; top: number }[] {
  const count = Math.max(0, Number(params.churn ?? 0) || 0);
  const grid = effectsGridSize(params, layout);
  const usable = Math.max(
    CHURN_WIDTH,
    grid.width - EFFECTS_GRID_PAD_PX * 2 + CHURN_GAP,
  );
  const perRow = Math.max(1, Math.floor(usable / (CHURN_WIDTH + CHURN_GAP)));
  const top0 = grid.height + CHURN_MARGIN;
  return Array.from({ length: count }, (_, index) => ({
    left: EFFECTS_GRID_PAD_PX + (index % perRow) * (CHURN_WIDTH + CHURN_GAP),
    top: top0 + Math.floor(index / perRow) * (CHURN_HEIGHT + CHURN_GAP),
  }));
}

/** The scenario's design box: the effect grid plus the churn strip. Pure. */
export function effectsStageSize(
  params: Record<string, ParamValue>,
  layout: StageLayout,
): { width: number; height: number } {
  const grid = effectsGridSize(params, layout);
  const cells = churnCellsFor(params, layout);
  const churnRight = cells.reduce(
    (max, cell) => Math.max(max, cell.left + CHURN_WIDTH),
    0,
  );
  const churnBottom = cells.reduce(
    (max, cell) => Math.max(max, cell.top + CHURN_HEIGHT),
    grid.height,
  );
  return {
    width: Math.max(grid.width, churnRight + EFFECTS_GRID_PAD_PX),
    height: churnBottom + STAGE_MARGIN,
  };
}

/** Sample points: one per cell CENTRE, where a just-born particle always sits. Pure. */
export function effectsSamplePoints(
  params: Record<string, ParamValue>,
  layout: StageLayout,
): { x: number; y: number }[] {
  const count = Math.max(1, Number(params.systems ?? 0) || 0);
  const { columns } = effectsGridShape(params, layout);
  return Array.from({ length: count }, (_, index) => {
    const { left, top, size } = effectsCellBox(index, columns, params);
    return { x: left + size / 2, y: top + size / 2 };
  });
}

/**
 * The particle runtime's own counters, flattened into the report's shape.
 *
 * `profile` is NULL unless `effectsProfiling` was passed (`runtimeOptions` always passes it), and a
 * null profile contributes NO KEYS — deliberately, and it is the same rule the runtime itself
 * applies: a `simMs: 0` invented for an un-instrumented runtime would read as "the simulation is
 * free" when the truth is "nobody measured", which is the one thing `metrics()` must never say.
 *
 * Pure, so the key SET per arm is provable without a browser.
 */
export function particleCounters(
  stats: ParticleRuntimeStats,
): Record<string, number> {
  const profile = stats.profile;
  return {
    /** `drawBinding` calls that reached `drawParticles` — never a cache-hit blit or a clear-only. */
    particleDraws: stats.draws,
    /** Frozen-mode static-frame cache hits (N identical systems collapsing to one warm + N blits). */
    particleCacheHits: stats.cacheHits,
    ...(profile
      ? {
          profTicks: profile.ticks,
          profBindings: profile.bindings,
          simSteps: profile.simSteps,
          instances: profile.instances,
          simMs: profile.simMs,
          buildMs: profile.buildMs,
          glMs: profile.glMs,
          blitMs: profile.blitMs,
        }
      : {}),
  };
}

/** The shader runtime's counters, same shape and same null-profile rule (`ShaderProfile`). */
export function shaderCounters(
  stats: WebglShaderRuntimeStats,
): Record<string, number> {
  const profile = stats.profile;
  return {
    shaderDraws: stats.draws,
    shaderCacheHits: stats.cacheHits,
    ...(profile
      ? {
          profTicks: profile.ticks,
          profBindings: profile.bindings,
          glMs: profile.glMs,
          blitMs: profile.blitMs,
        }
      : {}),
  };
}

/**
 * `after − before`, per key: the WINDOW's share of counters that accumulate from mount.
 *
 * Window-scoping is the whole point. Every arm warms up before the window opens — the frozen arm
 * draws its entire frozen set there, the live arms mount and draw their first frames there — so a
 * raw counter would answer "did this runtime ever draw?" when the claim being checked is "did it
 * keep drawing while it was being measured". `particles-frozen` is the case that makes it concrete:
 * its `particleDraws` is 12 from mount and must be ~0 in-window, and only the delta can say so.
 *
 * A key present in `before` but not in `after` is dropped, not reported as a negative or a zero: the
 * counter stopped existing, which is not a measurement. Non-finite values are dropped for the same
 * reason (the validator would reject them, and a substituted 0 would be a number this file invented).
 */
export function counterDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const [key, value] of Object.entries(after)) {
    const raw = value - (before[key] ?? 0);
    if (!Number.isFinite(raw)) {
      continue;
    }
    delta[key] = EFFECTS_MS_COUNTERS.has(key)
      ? Math.round(raw * 100) / 100
      : raw;
  }
  return delta;
}

interface State {
  container: HTMLElement;
  churn: HTMLElement[];
  /** The effect nodes, in mount order — the reconcile keys both runtimes bind against. */
  nodes: HTMLElement[];
  /** Live runtime handles, kept for teardown and for whatever wants to read their counters. */
  particles: ParticleRuntime | null;
  shaders: WebglShaderRuntime | null;
  /**
   * Distinct nodes whose binding has REALLY drawn at least once, counted from the runtimes'
   * `onBindingRendered` (which the runtimes fire only on a draw that reached `drawParticles` /
   * `gl.drawArrays` — never on a cache-hit blit or a skip). This is what `ready()` waits on: binding
   * creation is asynchronous on both runtimes (observer-delivered sizing on one, an awaited
   * `resolveShaderSource` on the other), so "the runtime returned a handle" says nothing about
   * whether anything is on screen.
   */
  rendered: Set<HTMLElement>;
  /**
   * The runtime's counters as they stood on the FIRST `step()` — i.e. at the top of the measured
   * window, the earliest in-window hook a scenario has. `metrics()` reports the difference (see
   * `counterDelta`). Null until that first step, which is also what "the window never opened" looks
   * like: `metrics()` then has nothing to subtract and reports the whole-life counters, which is the
   * honest read-out for a run that was never stepped.
   */
  windowStart: Record<string, number> | null;
}

/**
 * Every run's live state, keyed by the root the runner handed the scenario — which is also the key
 * a per-scenario metrics hook would look it up by. Both runtime handles and the rendered-node set
 * live in here rather than in `mount`'s closure for exactly that reason: reporting a runtime's own
 * counters (`ParticleRuntime.stats()` / `WebglShaderRuntime.stats()`) is then a read, not a
 * refactor.
 */
const states = new WeakMap<HTMLElement, State>();

/**
 * This arm's runtime counters, read now. Exactly one of the two handles exists per arm (see
 * `mount`), which is what keeps the reported key set per-arm rather than zero-filled.
 *
 * `stats()` returns the SAME live object every call and the profile is mutated in place, so this
 * flattening is also the snapshot: `counterDelta` could not subtract two aliases of one object.
 */
function liveCounters(state: State): Record<string, number> {
  if (state.particles) {
    return particleCounters(state.particles.stats());
  }
  if (state.shaders) {
    return shaderCounters(state.shaders.stats());
  }
  return {};
}

/**
 * The render options BOTH runtimes are built from — one place, so the two arms differ only where
 * this scenario says they differ, and so an option that has to reach both (profiling counters, a
 * future quality knob) is added once instead of twice.
 */
function runtimeOptions(
  ctx: ScenarioContext,
  state: State,
): GodotHtmlMountOptions {
  const mechanism = mechanismOf(ctx.params);
  const fps = Math.max(0, numParam(ctx.params.fps, 0));
  return {
    enableParticles: true,
    enableWebglShaders: true,
    // Both loops read their own cap; passing the one `fps` param to both keeps the arms comparable
    // at a cap instead of capping one of them by accident.
    particleFps: fps,
    shaderFps: fps,
    effectsLoopPacing:
      String(ctx.params.pacing ?? "timer") === "raf" ? "raf" : "timer",
    renderScale: Math.max(0.01, numParam(ctx.params.renderScale, 1)),
    staticParticles: usesFrozenParticles(mechanism),
    // The per-frame cost attribution both runtimes expose through `stats().profile` — the whole
    // reason this scenario can say WHICH of the four buckets a tick went into rather than leaving a
    // reader to infer it from a wall-clock frame cost. On for every arm: an arm whose profile was
    // null would report no bucket keys at all, and the arms would stop being comparable.
    effectsProfiling: true,
    resolveShaderSource: () => EFFECTS_SHADER_SOURCE,
    onBindingRendered: (node) => {
      state.rendered.add(node);
    },
  };
}

/**
 * One particle node: the outer reconcile key + its own self-layer, which is where the canvas goes.
 *
 * EXPORTED for S8 `effects-webgpu-runtime`, which mounts the same shipped runtime under a different
 * `effectsRenderer` and must mount the SAME NODES to be comparable with this scenario. Sharing the
 * builder rather than copying it is what makes "the arm differs by one option and nothing else" a
 * fact about the import graph instead of a promise in a comment.
 */
export function buildParticleNode(
  ctx: ScenarioContext,
  index: number,
  box: { left: number; top: number; size: number },
): HTMLElement {
  const cellPx = numParam(ctx.params.cellPx, 96);
  const pad = effectsCanvasPad(ctx.params);
  const node = document.createElement("div");
  node.className = "effect";
  // The NODE box is `cellPx`, inset by the pad inside the slot, so the canvas the runtime grows to
  // `cellPx + 2*pad` fills the slot exactly and is centred on the sample point.
  Object.assign(node.style, {
    position: "absolute",
    left: `${box.left + pad}px`,
    top: `${box.top + pad}px`,
    width: `${cellPx}px`,
    height: `${cellPx}px`,
  });
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute(
    "data-godot-particle-specs",
    JSON.stringify(effectsSpec(ctx.params, index)),
  );
  node.appendChild(buildSelfLayer());
  return node;
}

/** One shader node. It fills the WHOLE slot, so its canvas has a particle cell's pixel count.
 *  Exported for S8, for the reason on `buildParticleNode`. */
export function buildShaderNode(
  _ctx: ScenarioContext,
  index: number,
  box: { left: number; top: number; size: number },
): HTMLElement {
  const node = document.createElement("div");
  node.className = "effect";
  Object.assign(node.style, {
    position: "absolute",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.size}px`,
    height: `${box.size}px`,
  });
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", EFFECTS_SHADER_PATH);
  // A distinct uid per node would compile N identical programs; the runtime caches by shader key,
  // and N nodes sharing one program is what a real scene looks like.
  node.setAttribute("data-godot-shader-uid", `uid://gsw-perf-effects-${index}`);
  node.appendChild(buildSelfLayer());
  return node;
}

/**
 * The node's own paint layer, which both runtimes find with `ownSelfLayer` (a DIRECT-child lookup
 * for `.godot-scene-self-layer` — the class is imported rather than spelled, so this cannot drift
 * from the renderer's).
 */
export function buildSelfLayer(): HTMLElement {
  const layer = document.createElement("div");
  layer.className = SELF_LAYER_CLASS;
  // `position: absolute` so it is the containing block for the runtime-owned canvas (which the
  // particle runtime anchors at `-pad`), `inset: 0` so its content box is the node's box — the box
  // both runtimes size their canvas from.
  Object.assign(layer.style, { position: "absolute", inset: "0" });
  return layer;
}

/**
 * One churn cell, at its computed slot (see `churnCellsFor`). Exported for S8, for the reason on
 * `buildParticleNode`: the strip is what keeps a run from being rejected as "nothing was measured",
 * so it has to be the SAME strip in both scenarios or their `contentUpdateHz` rows are not the same
 * measurement.
 */
export function buildChurnCell(left: number, top: number): HTMLElement {
  const cell = document.createElement("div");
  cell.className = "churn";
  Object.assign(cell.style, {
    position: "absolute",
    left: `${left}px`,
    top: `${top}px`,
    width: `${CHURN_WIDTH}px`,
    height: `${CHURN_HEIGHT}px`,
    backgroundColor: "#404058",
  });
  return cell;
}

/**
 * Paint the decode canary onto the stage container (see `decodeCanaryUrl`), or do nothing if this
 * engine has no 2D canvas to generate it with. `no-repeat` matters — a tiled background over the
 * whole stage would make every pixel "content" and change what `presented.nonEmptyRatio` means.
 *
 * Exported for S8: `validateReport` rejects `decode.count === 0` on every scenario, and a second
 * effects scenario that grew its own canary would be a second image to explain.
 */
export function paintDecodeCanary(container: HTMLElement): void {
  const canary = decodeCanaryUrl();
  if (!canary) {
    return;
  }
  Object.assign(container.style, {
    backgroundImage: `url(${canary})`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right bottom",
    backgroundSize: `${CANARY_PX}px ${CANARY_PX}px`,
  });
}

export const effectsRuntime: Scenario = {
  name: "effects-runtime",
  params: EFFECTS_RUNTIME_PARAMS,

  mount(ctx: ScenarioContext): void {
    // FIRST, before anything can touch the shared GL context. `shared-gl.ts` DECLINES a software
    // renderer (SwiftShader on this headless box, llvmpipe in CI) and caches that decision
    // module-scoped on the first `getShared()`, so without this every arm would silently become a
    // no-op handle and the scenario would measure a blank page at a beautiful frame rate. It is set
    // here and not at module scope on purpose: this module is bundled into the SHARED page bundle
    // with every other scenario, and a module-scope write would change their runtimes too.
    (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;

    const mechanism = mechanismOf(ctx.params);
    const count = Math.max(1, Math.round(numParam(ctx.params.systems, 12)));
    const { columns } = effectsGridShape(ctx.params, ctx.layout);

    const container = document.createElement("div");
    container.id = "perf-stage";
    Object.assign(container.style, { position: "absolute", inset: "0" });
    // The decode canary (see `decodeCanaryUrl`): one 8x8 image, painted ONCE, in the corner of a
    // container nothing ever repaints.
    paintDecodeCanary(container);
    ctx.root.appendChild(container);

    const nodes: HTMLElement[] = [];
    for (let index = 0; index < count; index++) {
      const box = effectsCellBox(index, columns, ctx.params);
      const node = usesParticleRuntime(mechanism)
        ? buildParticleNode(ctx, index, box)
        : buildShaderNode(ctx, index, box);
      container.appendChild(node);
      nodes.push(node);
    }

    // The churn strip (see the module note): unrelated content, invalidated every frame, so a PARKED
    // frozen arm still produces layer activations and is measured instead of rejected.
    const churn: HTMLElement[] = [];
    for (const { left, top } of churnCellsFor(ctx.params, ctx.layout)) {
      const cell = buildChurnCell(left, top);
      container.appendChild(cell);
      churn.push(cell);
    }

    const state: State = {
      container,
      churn,
      nodes,
      particles: null,
      shaders: null,
      rendered: new Set<HTMLElement>(),
      windowStart: null,
    };
    const options = runtimeOptions(ctx, state);
    // Exactly ONE runtime per arm. Creating both would put the other's loop and its ResizeObserver
    // in the same frame budget for nothing — this scenario's whole claim is that an arm's cost is
    // the thing the arm names.
    if (usesParticleRuntime(mechanism)) {
      state.particles = createParticleRuntime(container, options);
      state.particles.reconcile();
    } else {
      state.shaders = createWebglShaderRuntime(container, options);
      state.shaders.reconcile();
    }
    states.set(ctx.root, state);
  },

  /**
   * Resolve only once EVERY binding has drawn at least once.
   *
   * Both runtimes create bindings asynchronously — the particle runtime waits for its shared
   * ResizeObserver to deliver a first box before it mounts a canvas, and the shader runtime awaits
   * `resolveShaderSource` and a program compile — so a `ready()` that returned after `reconcile()`
   * would open the measured window on a page that is still filling in, and charge the arm for it.
   *
   * A timeout is a FAILURE, not a warning: every arm here is "the shipped runtime, running". If it
   * did not run there is nothing to measure, and a silent resolve would publish the blank page as a
   * result (see `mount`'s note on the software-renderer decline).
   */
  async ready(ctx: ScenarioContext): Promise<void> {
    const state = states.get(ctx.root);
    if (!state) {
      throw new Error("effects-runtime: ready() called before mount()");
    }
    const expected = state.nodes.length;
    const deadline = performance.now() + READY_TIMEOUT_MS;
    while (state.rendered.size < expected) {
      if (performance.now() > deadline) {
        throw new Error(
          `effects-runtime: only ${state.rendered.size}/${expected} ${mechanismOf(ctx.params)} bindings rendered within ${READY_TIMEOUT_MS} ms — the runtime is not running here (no WebGL2? a software renderer declined?), and measuring it anyway would report a blank page as a result`,
        );
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
  },

  /**
   * The churn strip, and NOTHING else. Every arm's effect work is driven by the runtime's own loop,
   * which is the code under measurement; a `step()` that poked the runtimes would be measuring this
   * file instead.
   *
   * The one other thing that happens here is the counter snapshot, on the FIRST call only: this is
   * the earliest hook a scenario has that is inside the measured window, so it is where the window's
   * share of a monotonic counter starts (see `counterDelta`).
   */
  step(ctx: ScenarioContext, frame: number): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    if (state.windowStart === null) {
      state.windowStart = liveCounters(state);
    }
    for (let index = 0; index < state.churn.length; index++) {
      const hue = (frame * 7 + index * 23) % 360;
      state.churn[index].style.backgroundColor = `hsl(${hue} 45% 42%)`;
    }
  },

  /**
   * What each arm did, from the runtimes' own counters — the evidence that an arm did the thing its
   * name claims, which no trace metric can attribute per-arm.
   *
   * Three checks live in this block, and they are the reason it exists:
   *   - FROZEN REALLY PARKED: `particleDraws` ~ 0 and `profTicks` 0 across the window. The arm draws
   *     its whole set before the window opens; if the loop were quietly still running, the trace
   *     would just show a cheap page and nothing would say why.
   *   - SIMCAP REALLY CAPPED THE SIM AND ONLY THE SIM: `simSteps` collapses to about
   *     `systems x simCapHz x windowSeconds` while `particleDraws` keeps ticking at display rate.
   *     Both halves are needed — a `simSteps` drop alone could equally mean the arm stopped drawing.
   *   - THE SIZING PATH FORCED NO LAYOUT: `boxReads` 0.
   *
   * KEYS ARE PER ARM, never zero-filled: a particle arm reports no shader keys and vice versa,
   * because an absent key means "not measured" and a fabricated 0 would be indistinguishable from a
   * measured one. Every value is a WINDOW DELTA except the two marked below, which are whole-life by
   * nature.
   */
  metrics(ctx: ScenarioContext): Record<string, number> {
    const state = states.get(ctx.root);
    if (!state) {
      // `mount()` never ran against this root. Report the one thing that is both true and countable
      // rather than `{}` — an empty block is a validation error precisely because it cannot be told
      // apart from a read-out that failed, and this IS a read-out.
      return { renderedNodes: 0 };
    }
    const counters = liveCounters(state);
    return {
      ...counterDelta(state.windowStart ?? {}, counters),
      // WHOLE-LIFE, not a delta, and the two exceptions are deliberate:
      //   `renderedNodes` — distinct bindings that have EVER drawn, i.e. `ready()`'s own gate. It is
      //     the guarantee that this block is never empty, and the answer to "was every cell alive?".
      //   `boxReads` — the claim is about the CREATE path (`particleObserverSizing` taking a
      //     binding's first box from the ResizeObserver instead of a forced `clientWidth`), and
      //     creates happen before the window. A windowed delta would read 0 for a runtime that
      //     forced a layout per binding at mount.
      renderedNodes: state.rendered.size,
      ...(state.particles
        ? { boxReads: state.particles.stats().boxReads }
        : {}),
    };
  },

  teardown(ctx: ScenarioContext): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    state.particles?.dispose();
    state.shaders?.dispose();
    state.container.remove();
    states.delete(ctx.root);
  },

  samplePoints(ctx: ScenarioContext): { x: number; y: number }[] {
    return effectsSamplePoints(ctx.params, ctx.layout);
  },

  stageSize(params: Record<string, ParamValue>, layout: StageLayout) {
    return effectsStageSize(params, layout);
  },

  gridShape(params: Record<string, ParamValue>, layout: StageLayout) {
    return effectsGridShape(params, layout);
  },
};
