// S1 `atlas-sprites` — the A/B instrument for "how should a sprite reference a region of a big
// atlas page?".
//
// The mechanism is a PARAMETER, never a forked copy of the scenario: the geometry, the sprite count,
// the animation and the sample points are byte-identical across arms, so any difference in the
// numbers is the mechanism and nothing else. The scene itself lives in `sprite-scene.ts` because S2
// re-scales THE SAME grid from an ancestor and S4 puts THE SAME grid on top of a big background —
// forking it per scenario is exactly how the arms would silently stop being comparable.

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

const states = new WeakMap<HTMLElement, SpriteSceneState>();

export const atlasSprites: Scenario = {
  name: "atlas-sprites",
  params: SPRITE_SCENE_PARAMS,

  mount(ctx: ScenarioContext): void {
    states.set(ctx.root, mountSpriteScene(ctx));
  },

  async ready(ctx: ScenarioContext): Promise<void> {
    const state = states.get(ctx.root);
    if (!state?.prepared) {
      throw new Error("atlas-sprites: ready() called before mount()");
    }
    await state.prepared;
  },

  step(ctx: ScenarioContext, frame: number): void {
    const state = states.get(ctx.root);
    if (state) {
      stepSpriteScene(ctx, state, frame);
    }
  },

  teardown(ctx: ScenarioContext): void {
    const state = states.get(ctx.root);
    if (state) {
      teardownSpriteScene(state);
      states.delete(ctx.root);
    }
  },

  samplePoints(ctx: ScenarioContext): { x: number; y: number }[] {
    return spriteSamplePoints(ctx);
  },

  // Nothing in S1 moves the grid: the animation swaps atlas regions, not geometry, so the stage is
  // the grid's own padded box — in whatever shape the viewport asked for.
  stageSize(params: Record<string, ParamValue>, layout: StageLayout) {
    return spriteSceneStageSize(params, layout);
  },

  gridShape(params: Record<string, ParamValue>, layout: StageLayout) {
    return spriteGridShape(params, layout);
  },
};
