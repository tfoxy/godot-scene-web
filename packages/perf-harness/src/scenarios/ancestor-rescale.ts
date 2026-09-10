// S2 `ancestor-rescale` — the harness's own ACCEPTANCE TEST.
//
// S1's scene, unchanged, under an ancestor whose `transform: scale()` is animated 1.0 -> 1.2 and
// back, repeatedly. This is the card-focus / 1.2x hover-tip / view-scale shape that produced the
// traced regression in the consuming project: 429 ms and 507 ms activation stalls, 1034.8 ms of
// decode of which 97.6% fell inside the two focus/unfocus windows, and 40 of 68 images decoded twice
// or more.
//
// WHY THE SCALE IS DRIVEN FROM JS, PER FRAME
//
// A CSS transition/animation on `transform` is COMPOSITOR-DRIVEN: cc re-uses the tiles it already
// rasterized and just re-composites them at a new transform. It would produce a beautiful, cheap,
// entirely irrelevant measurement. The regression under study is a RASTER-SCALE change: the display
// list is re-recorded at a new scale, so every image in it needs a decode AT THAT SCALE. Only
// driving the scale from a rAF callback each frame forces the paint + raster + decode chain that is
// the entire point. `driver=css-transition` keeps the compositor-driven version available as a
// control, so that claim is PROVED rather than asserted.
//
// THREE DRIVERS, AND WHAT MEASURING THEM ACTUALLY SHOWED
//
//   js-layout    (default) re-lays the subtree out in CSS px every frame: box sizes and positions
//                change, so `regionBackgroundStyle` re-derives a new `background-size`. This is what
//                the consuming project's view-scale / card-focus actually does — its renderer
//                rewrites element geometry, it does not wrap the scene in a transform.
//   js-transform             writes `transform: scale()` on an ancestor every frame from JS.
//   css-transition           the same curve as a compositor-driven `@keyframes` animation.
//
// MEASURED NEGATIVE RESULT (Chrome for Testing 148, headless, SwiftShader, `cacheFamily: software`):
// none of the three re-decodes the atlas. The scale genuinely reaches cc's decode cache — at
// `focusScale=0.5` the cache keys' `target_size` moves from mip 1/2 (`382x406 -> 191x203`) to mip
// 1/4 (`382x406 -> 96x102`) — but `SoftwareImageDecodeCache` satisfies the new mip by RE-SCALING an
// existing decode instead of re-running the codec. Across every driver and both scales the page ran
// the PNG codec exactly 4 times, `redecodeCount` stayed at 3 (the same 3 a completely static S1 run
// produces), and no arm ever produced an activation gap over 100 ms.
//
// The traced regression (40 of 68 images decoded >= 2x, 429 ms and 507 ms activation stalls) is
// therefore a `GpuImageDecodeCache` behaviour, on the decode path a real phone uses — precisely the
// software/GPU split `docs/perf-harness.md` warns about. See that document for the full table.

import {
  applySpriteScale,
  mountSpriteScene,
  SPRITE_SCENE_PARAMS,
  type SpriteSceneState,
  spriteGridShape,
  spriteSamplePoints,
  spriteSceneStageSize,
  stepSpriteScene,
  teardownSpriteScene,
} from "./sprite-scene";
import type {
  ParamValue,
  Scenario,
  ScenarioContext,
  StageLayout,
} from "./types";

export const RESCALE_DRIVERS = ["js-layout", "js-transform", "css-transition"];

const KEYFRAMES_NAME = "perf-ancestor-rescale";

export interface RescaleSchedule {
  /** Length of one focus/unfocus cycle. */
  periodMs: number;
  /** Time spent ramping in each direction. */
  rampMs: number;
  /** Time held at the focused scale between the two ramps. */
  holdMs: number;
  /** Peak scale (1.2 = the consuming project's card-focus / hover-tip factor). */
  scale: number;
}

/**
 * The scale curve, as a pure function of elapsed time. Unit-tested rather than eyeballed: a curve
 * that silently returned a CONSTANT would make this scenario measure nothing at all while still
 * producing a plausible-looking table.
 *
 *   [0, ramp)                    focus:   1 -> scale
 *   [ramp, ramp+hold)            held focused
 *   [ramp+hold, 2*ramp+hold)     unfocus: scale -> 1
 *   [2*ramp+hold, period)        resting at 1
 */
export function rescaleScaleAt(
  elapsedMs: number,
  schedule: RescaleSchedule,
): number {
  const period = Math.max(1, schedule.periodMs);
  const ramp = Math.max(0, schedule.rampMs);
  const hold = Math.max(0, schedule.holdMs);
  const peak = schedule.scale;
  const phase = ((elapsedMs % period) + period) % period;
  if (ramp <= 0) {
    return phase < hold ? peak : 1;
  }
  if (phase < ramp) {
    return 1 + (peak - 1) * (phase / ramp);
  }
  if (phase < ramp + hold) {
    return peak;
  }
  if (phase < ramp + hold + ramp) {
    return peak - (peak - 1) * ((phase - ramp - hold) / ramp);
  }
  return 1;
}

/** The same curve as `@keyframes`, for the compositor-driven control arm. */
export function rescaleKeyframesCss(
  name: string,
  schedule: RescaleSchedule,
): string {
  const period = Math.max(1, schedule.periodMs);
  const pct = (ms: number): string =>
    `${Math.max(0, Math.min(100, (ms / period) * 100)).toFixed(4)}%`;
  const ramp = Math.max(0, schedule.rampMs);
  const hold = Math.max(0, schedule.holdMs);
  return (
    `@keyframes ${name} {` +
    `0% { transform: scale(1); }` +
    `${pct(ramp)} { transform: scale(${schedule.scale}); }` +
    `${pct(ramp + hold)} { transform: scale(${schedule.scale}); }` +
    `${pct(ramp + hold + ramp)} { transform: scale(1); }` +
    `100% { transform: scale(1); }` +
    `}`
  );
}

interface State {
  sprites: SpriteSceneState;
  ancestor: HTMLElement;
  style: HTMLStyleElement | undefined;
  schedule: RescaleSchedule;
  driver: string;
  startMs: number | undefined;
  scale: number;
}

const states = new WeakMap<HTMLElement, State>();

function scheduleOf(ctx: ScenarioContext): RescaleSchedule {
  return {
    periodMs: Number(ctx.params.focusPeriodMs),
    rampMs: Number(ctx.params.focusRampMs),
    holdMs: Number(ctx.params.focusHoldMs),
    scale: Number(ctx.params.focusScale),
  };
}

/** Read the scale actually on screen from the computed transform matrix. */
function computedScaleOf(element: HTMLElement): number {
  const value = getComputedStyle(element).transform;
  const parsed = /matrix\(\s*([-\d.eE+]+)/.exec(value);
  const scale = parsed ? Number(parsed[1]) : Number.NaN;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export const ancestorRescale: Scenario = {
  name: "ancestor-rescale",
  params: {
    ...SPRITE_SCENE_PARAMS,
    focusPeriodMs: {
      default: 1000,
      describe: "length of one focus/unfocus cycle",
    },
    focusRampMs: {
      default: 300,
      describe:
        "ramp time in each direction (the traced focus tween is ~300ms)",
    },
    focusHoldMs: { default: 200, describe: "time held at the focused scale" },
    focusScale: {
      default: 1.2,
      describe: "peak ancestor scale (1.2 = the card-focus / hover-tip factor)",
    },
    driver: {
      default: "js-layout",
      values: RESCALE_DRIVERS,
      describe:
        "js-layout: re-lay the subtree out in CSS px every frame (what gsw's view-scale does); js-transform: ancestor transform:scale() from JS; css-transition: compositor-driven control",
    },
  },

  mount(ctx: ScenarioContext): void {
    const schedule = scheduleOf(ctx);
    const driver = String(ctx.params.driver);

    const ancestor = document.createElement("div");
    ancestor.id = "perf-ancestor";
    ancestor.style.position = "absolute";
    ancestor.style.inset = "0";
    // Top-left origin so a sample point maps through the scale by plain multiplication, and NO
    // `will-change`: promoting this to its own compositor layer is precisely the optimisation whose
    // absence the regression depends on.
    ancestor.style.transformOrigin = "0 0";
    ancestor.style.transform = "scale(1)";
    ctx.root.appendChild(ancestor);

    let style: HTMLStyleElement | undefined;
    if (driver === "css-transition") {
      style = document.createElement("style");
      style.textContent = rescaleKeyframesCss(KEYFRAMES_NAME, schedule);
      document.head.appendChild(style);
      ancestor.style.animation = `${KEYFRAMES_NAME} ${schedule.periodMs}ms linear infinite`;
    }

    states.set(ctx.root, {
      sprites: mountSpriteScene(ctx, ancestor),
      ancestor,
      style,
      schedule,
      driver,
      startMs: undefined,
      scale: 1,
    });
  },

  async ready(ctx: ScenarioContext): Promise<void> {
    const state = states.get(ctx.root);
    if (!state?.sprites.prepared) {
      throw new Error("ancestor-rescale: ready() called before mount()");
    }
    await state.sprites.prepared;
  },

  step(ctx: ScenarioContext, frame: number): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    // The sprite animation runs identically to S1, so the DIFFERENCE between the two scenarios is
    // the ancestor scale and nothing else.
    stepSpriteScene(ctx, state.sprites, frame);
    if (state.driver === "css-transition") {
      return;
    }
    // Wall-clock, not frame index: the curve under study is a 300 ms tween, and a frame-indexed
    // curve would silently stretch to 10x its length under `--cpu-throttle 6`.
    const now = performance.now();
    state.startMs ??= now;
    const scale = rescaleScaleAt(now - state.startMs, state.schedule);
    state.scale = scale;
    if (state.driver === "js-transform") {
      state.ancestor.style.transform = `scale(${scale})`;
    } else {
      applySpriteScale(ctx, state.sprites, scale);
    }
  },

  teardown(ctx: ScenarioContext): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    teardownSpriteScene(state.sprites);
    state.style?.remove();
    state.ancestor.remove();
    states.delete(ctx.root);
  },

  samplePoints(ctx: ScenarioContext): { x: number; y: number }[] {
    const base = spriteSamplePoints(ctx);
    const state = states.get(ctx.root);
    if (!state) {
      return base;
    }
    // Called once, after the measured window, immediately before the harness screenshots the page —
    // so it must report where the sprites are IN THAT SCREENSHOT. The js-raf arm is already static
    // (nothing writes the transform after the last step); the compositor-driven control is still
    // running, so it is frozen at its current value first. Without this the presence guard would
    // compare the screenshot against un-scaled coordinates and report a perfectly good render as a
    // blank page.
    const scale =
      state.driver === "css-transition"
        ? computedScaleOf(state.ancestor)
        : state.scale;
    if (state.driver === "css-transition") {
      state.ancestor.style.animation = "none";
      state.ancestor.style.transform = `scale(${scale})`;
    }
    return base.map((point) => ({ x: point.x * scale, y: point.y * scale }));
  },

  // The grid at its PEAK focus scale. Every driver grows the scene by `focusScale` — js-layout
  // re-lays it out that big, js-transform and css-transition scale it that big — and the screenshot
  // is taken wherever in the cycle the window happened to end. A stage sized for the resting scale
  // would clip the focused frame and turn a correct render into a presence failure.
  stageSize(params: Record<string, ParamValue>, layout: StageLayout) {
    const base = spriteSceneStageSize(params, layout);
    const peak = Math.max(1, Number(params.focusScale) || 1);
    return {
      width: Math.ceil(base.width * peak),
      height: Math.ceil(base.height * peak),
    };
  },

  gridShape(params: Record<string, ParamValue>, layout: StageLayout) {
    return spriteGridShape(params, layout);
  },
};
