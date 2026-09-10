// S4 `large-image-coexistence` — does one big background image survive its neighbours?
//
// The consuming project recently replaced a live-rendered combat background with a single
// host-rendered 2520x1080 PNG. That image is now the largest thing on the page by a wide margin, and
// the question it raises is not "how long does it take to decode" (once, at load) but "does anything
// make us pay for it AGAIN". A trace of the real app showed a 275 ms decode running INSIDE a raster
// task — an image that no longer fits the discardable decode cache, so its decode is re-paid on every
// re-raster forever — and nothing in that trace said whether the culprit was an atlas page or the new
// background.
//
// So: mount the background, put S1's sprite grid on top of it, and churn a strip of unrelated
// content every frame. Then assert, from the trace, that the big image is neither re-decoded nor
// re-painted.
//
// HOW EACH HALF OF THAT CLAIM IS ACTUALLY MEASURED
//
//   not re-DECODED  — `decode.redecodeCount` / `decode.inRasterCount`. These are run-wide: cc keys
//                     decodes by an opaque pixelRef/content id that carries no URL, so on an arm
//                     where the total is 0 the background provably decoded once, and on an arm where
//                     it is not 0 the number cannot be attributed. Run with `--param mounted=0` for
//                     the unambiguous version: with no sprites the background is the only image in
//                     the trace and every decode number belongs to it.
//   not re-PAINTED  — `watchedImage.paintCountInWindow`. `PaintImage` is the only url-bearing event
//                     in a Chrome trace, so this is the one honest per-image signal available. A
//                     record inside the measured window means the display list was re-recorded with
//                     the background in it — which is what precedes a re-raster.

import {
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

export const BACKGROUND_URL_MARKER = "/fixture/background.png";

/** Where the churn strip lives, in CSS px. Below the sprite grid, above the background. */
const CHURN_TOP = 620;
const CHURN_HEIGHT = 56;
const CHURN_LEFT = 8;
const CHURN_PITCH = 52;
const CHURN_WIDTH = 44;
/** Breathing room around the outermost content, so a sample point never lands on the stage's edge. */
const STAGE_MARGIN = 16;
/** Background sample rows: below the sprites AND below the churn strip, so they see only the image. */
const BACKGROUND_SAMPLE_Y = [590, 740];
const BACKGROUND_SAMPLE_X = [120, 420, 760, 1100];

interface State {
  sprites: SpriteSceneState;
  background: HTMLElement;
  churn: HTMLElement[];
  layer: HTMLElement;
}

const states = new WeakMap<HTMLElement, State>();

export const largeImageCoexistence: Scenario = {
  name: "large-image-coexistence",
  params: {
    ...SPRITE_SCENE_PARAMS,
    bgWidth: {
      default: 2520,
      describe:
        "background image width (the consuming project renders 2520x1080)",
    },
    bgHeight: { default: 1080, describe: "background image height" },
    churn: {
      default: 24,
      describe:
        "unrelated elements repainted every frame on top of the background",
    },
  },

  backgroundFixture(params: Record<string, ParamValue>) {
    return { width: Number(params.bgWidth), height: Number(params.bgHeight) };
  },

  watchImageUrl: BACKGROUND_URL_MARKER,

  mount(ctx: ScenarioContext): void {
    const background = document.createElement("div");
    background.id = "perf-background";
    background.style.position = "absolute";
    background.style.inset = "0";
    background.style.backgroundRepeat = "no-repeat";
    // `cover` is what a full-bleed background actually uses, and it is also the case that keeps the
    // source:painted ratio honest — the image is drawn once, large, not cropped into a small box.
    background.style.backgroundSize = "cover";
    background.style.backgroundPosition = "center";
    const url = ctx.fixture.background?.url;
    if (!url) {
      throw new Error(
        "large-image-coexistence: the runner served no background fixture — the scenario's central claim is about that image, so measuring without it would be measuring nothing",
      );
    }
    background.style.backgroundImage = `url("${url}")`;
    ctx.root.appendChild(background);

    const layer = document.createElement("div");
    layer.id = "perf-foreground";
    layer.style.position = "absolute";
    layer.style.inset = "0";
    ctx.root.appendChild(layer);

    const sprites = mountSpriteScene(ctx, layer);

    // The churn: content with nothing to do with the background, invalidated every single frame.
    const churnCount = Number(ctx.params.churn);
    const churn: HTMLElement[] = [];
    for (let index = 0; index < churnCount; index++) {
      const cell = document.createElement("div");
      cell.className = "churn";
      cell.style.position = "absolute";
      cell.style.top = `${CHURN_TOP}px`;
      cell.style.left = `${CHURN_LEFT + index * CHURN_PITCH}px`;
      cell.style.width = `${CHURN_WIDTH}px`;
      cell.style.height = `${CHURN_HEIGHT}px`;
      cell.style.backgroundColor = "#404058";
      layer.appendChild(cell);
      churn.push(cell);
    }

    states.set(ctx.root, { sprites, background, churn, layer });
  },

  async ready(ctx: ScenarioContext): Promise<void> {
    const state = states.get(ctx.root);
    if (!state?.sprites.prepared) {
      throw new Error("large-image-coexistence: ready() called before mount()");
    }
    await state.sprites.prepared;
    // The background must be decodable before the window opens, or its first decode would land in
    // the middle of the measurement and be indistinguishable from a re-decode.
    const url = ctx.fixture.background?.url;
    if (url) {
      await new Promise<void>((res, rej) => {
        const image = new Image();
        image.onload = () => res();
        image.onerror = () => rej(new Error(`failed to load ${url}`));
        image.src = url;
      });
    }
  },

  step(ctx: ScenarioContext, frame: number): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    stepSpriteScene(ctx, state.sprites, frame);
    for (let index = 0; index < state.churn.length; index++) {
      const hue = (frame * 7 + index * 23) % 360;
      state.churn[index].style.backgroundColor = `hsl(${hue} 45% 42%)`;
    }
  },

  teardown(ctx: ScenarioContext): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    teardownSpriteScene(state.sprites);
    state.background.remove();
    state.layer.remove();
    states.delete(ctx.root);
  },

  samplePoints(ctx: ScenarioContext): { x: number; y: number }[] {
    // Sprite centres AND bare-background points. Without the latter a run where the background
    // failed to load would still pass the presence guard on the sprites alone — and the background
    // is the entire subject of this scenario.
    const points = spriteSamplePoints(ctx);
    for (const y of BACKGROUND_SAMPLE_Y) {
      for (const x of BACKGROUND_SAMPLE_X) {
        points.push({ x, y });
      }
    }
    return points;
  },

  // The union of the three things this scenario mounts: the sprite grid, the churn strip and the
  // bare-background sample rows. The background itself is `inset: 0`, so it covers whatever this
  // box turns out to be — which is exactly why the box has to be derived from the CONTENT rather
  // than the other way round.
  stageSize(params: Record<string, ParamValue>, layout: StageLayout) {
    const grid = spriteSceneStageSize(params, layout);
    const churnRight =
      CHURN_LEFT +
      Math.max(0, Number(params.churn) - 1) * CHURN_PITCH +
      CHURN_WIDTH;
    return {
      width: Math.max(
        grid.width,
        churnRight + STAGE_MARGIN,
        Math.max(...BACKGROUND_SAMPLE_X) + STAGE_MARGIN,
      ),
      height: Math.max(
        grid.height,
        CHURN_TOP + CHURN_HEIGHT + STAGE_MARGIN,
        Math.max(...BACKGROUND_SAMPLE_Y) + STAGE_MARGIN,
      ),
    };
  },

  gridShape(params: Record<string, ParamValue>, layout: StageLayout) {
    return spriteGridShape(params, layout);
  },
};
