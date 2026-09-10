import type { GlyphsView } from "./draw-list";
import type { StageProjection } from "./present";

/**
 * The seam between the executor and whatever draws glyph outlines.
 *
 * STRUCTURAL, AND IN THE CORE, SO THE BARREL STAYS FREE OF A GLYPH RENDERER. The only
 * implementation this repo ships is backed by `@godot-scene-web/hb-gpu` and lives on the
 * `./glyphs` subpath, for two reasons that are both about cost rather than taste: the main
 * barrel's export list is mirrored by hand-maintained ambient `.d.ts` files in
 * `../sts2-couch-coop` and `../spirectl` (see `AGENTS.md`), so every name added there is work
 * downstream; and a scene with no text should not pull a glyph renderer, its wasm loader and its
 * atlas into the bundle. A consumer that wants glyphs imports the adapter and injects it exactly
 * the way `CanvasExecutorOptions.white` is injected today.
 *
 * ONE METHOD, AND NO FRAME LIFECYCLE. There is no `begin`/`end` here on purpose: the executor
 * flushes its pending batch before calling {@link GlyphPass.drawRun} and restores its own GL state
 * after, so a pass has nothing to get wrong about when a frame starts. Everything it needs about
 * the frame is in the two arguments.
 */
export interface GlyphPass {
  /**
   * Draw ONE glyph run, in the GL state the executor is currently in.
   *
   * ONE DRAW CALL PER RUN, and that is a property of the mechanism rather than a thing to optimise
   * away later: hb-gpu's program carries the run's colour and its model matrix as UNIFORMS, so two
   * runs can only share a draw when both are identical, and the model matrix in particular cannot
   * be moved onto the instance without also moving the dilation `hb_gpu_dilate` computes through
   * it. A caller that wants fewer draws should merge runs when it BUILDS the list.
   *
   * `run` is the executor's own reusable view and is valid only for the duration of the call —
   * `run.slots` and `run.positions` are overwritten by the next `readGlyphs`. Read what is needed
   * and return.
   *
   * `projection` is the frame's, and the pass is expected to honour BOTH halves of it: `toClip`
   * maps design space (the space `run.positions` are in, after `run.m`) to clip space, and
   * `framebufferWidth`/`framebufferHeight` is the achieved drawing buffer, which is what a
   * resolution-independent glyph shader measures a screen pixel against. They differ by the
   * device-pixel ratio and conflating them is a dilation error, not a placement error.
   *
   * WHAT THE PASS MAY ASSUME on entry: `BLEND` is enabled, `SCISSOR_TEST` is enabled and the
   * scissor box is the frame's current clip, the viewport is the whole drawing buffer, and the
   * pending quad batch has already been drawn. WHAT IT MAY LEAVE DIRTY: the program, the bound
   * VAO, `ARRAY_BUFFER`, texture unit 0 and the blend equation/function — the executor rebinds and
   * re-invalidates all of those. It must NOT clear, must NOT touch the viewport, and must NOT
   * touch `SCISSOR_TEST` or the scissor box, because that is what clips the run.
   */
  drawRun(
    run: GlyphsView,
    projection: StageProjection,
  ): { glyphs: number; drawCalls: number };

  /**
   * Draw consecutive glyph commands as one ordered submission. Optional so existing passes keep
   * their exact one-command path. The executor only calls this for physically adjacent glyph
   * commands in an unbroken clip/mask scope; implementations must preserve the supplied order.
   */
  drawRuns?(
    runs: readonly GlyphsView[],
    projection: StageProjection,
  ): { glyphs: number; drawCalls: number };

  /** Conservative residency admission for `drawRuns`; false keeps commands separate. */
  canBatchRuns?(runs: readonly GlyphsView[]): boolean;
}
