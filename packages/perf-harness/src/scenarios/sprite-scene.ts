// The sprite scene S1 (`atlas-sprites`) and S2 (`ancestor-rescale`) share, plus the layer S4
// (`large-image-coexistence`) mounts on top of a big background.
//
// Extracted rather than copied: the whole value of these scenarios is that the three MECHANISMS
// (region-blob / page-crop / canvas) draw the SAME geometry from the SAME fixture, so any difference
// in the numbers is the mechanism. A forked copy per scenario would quietly let the geometry drift
// and every cross-scenario comparison would become meaningless.
//
//   region-blob : bake each region once (OffscreenCanvas -> convertToBlob -> object URL), one small
//                 image per region. Costs a full page decode + N encodes up front, JS-visible.
//   page-crop   : one <div> per sprite with `background-image: url(<whole page>)` cropped by CSS via
//                 gsw's SHIPPED `regionBackgroundStyle`. Cheap to set up; every sprite's display list
//                 references the 16 MP source, which is the decode hazard under study.
//   canvas      : createImageBitmap(page) once, then per-node <canvas> + drawImage.

import { regionBackgroundStyle } from "@godot-scene-web/html";
import { type GridShape, gridShapeFor } from "../fit";
import type { ParamSpec, ScenarioContext, StageLayout } from "./types";

export const SPRITE_PX = 96;
export const GAP_PX = 8;
export const PAD_PX = 16;
/**
 * The AUTHORED grid width, used whenever the run is not fitted. Desktop stays exactly 10x5 for 50
 * sprites, which is what `baselines/linux-chrome-148.json` and the S1-S4 reference tables were
 * measured at.
 */
export const COLUMNS = 10;

export const SPRITE_MECHANISMS = ["region-blob", "page-crop", "canvas"];

/**
 * `scaleDiversity` isolates the two halves of the page-crop hazard, which S1's numbers alone
 * conflate:
 *
 *   per-region — the atlas regions are inset by a per-region jitter, so every sprite's 96x96 box
 *                implies its OWN `background-size` (measured: `980.589px 1440.35px` next to
 *                `1297.74px 1010.84px`). Chrome keeps a separately-scaled decode per distinct size,
 *                so N sprites cost N scaled decodes OF ONE PAGE.
 *   shared     — the regions are laid out with no jitter, so every region is the same size and every
 *                sprite resolves to the SAME `background-size`. One page, one scale, one decode.
 *
 * The geometry (96x96 boxes on a fixed grid) is identical either way: only the fixture's region
 * rectangles change, so the difference in the numbers is scale diversity and nothing else. That
 * distinction is what the consuming project's real defect turns on — a re-scaled ancestor multiplies
 * the number of distinct scales, not the number of images.
 */
export const SCALE_DIVERSITY_VALUES = ["per-region", "shared"];

export const SPRITE_SCENE_PARAMS: Record<string, ParamSpec> = {
  mechanism: {
    default: "page-crop",
    values: SPRITE_MECHANISMS,
    describe: "how a sprite references its atlas region",
  },
  mounted: { default: 50, describe: "sprites mounted simultaneously" },
  animated: {
    default: 10,
    describe: "sprites that advance their region index every frame",
  },
  regions: { default: 100, describe: "regions on the atlas page" },
  atlasPage: { default: 4096, describe: "atlas page size in px (square)" },
  scaleDiversity: {
    default: "per-region",
    values: SCALE_DIVERSITY_VALUES,
    describe:
      "per-region: every sprite implies its own background-size (N scaled decodes of one page); shared: all sprites share one",
  },
};

/** True when the atlas regions must be generated WITHOUT the per-region inset jitter. */
export function usesUniformRegions(params: {
  scaleDiversity?: unknown;
}): boolean {
  return String(params.scaleDiversity ?? "per-region") === "shared";
}

export interface SpriteNode {
  element: HTMLElement;
  canvas: HTMLCanvasElement | undefined;
  baseRegion: number;
  animated: boolean;
  currentRegion: number;
}

export interface SpriteSceneState {
  nodes: SpriteNode[];
  container: HTMLElement;
  page: HTMLImageElement | undefined;
  bitmap: ImageBitmap | undefined;
  regionUrls: string[];
  prepared: Promise<void> | undefined;
  /** Current sprite box edge in CSS px. Only `applySpriteScale` moves it off `SPRITE_PX`. */
  boxPx: number;
}

export function mechanismOf(ctx: ScenarioContext): string {
  return String(ctx.params.mechanism);
}

export function spriteRegionIndex(index: number, regionCount: number): number {
  return (index * 7 + 3) % regionCount;
}

/**
 * The grid shape for a run: the authored 10-column layout when the stage is used at its authored
 * size, and a shape matching the VIEWPORT'S ASPECT when the stage is fitted.
 *
 * Portrait phone, 50 sprites: 5 columns x 10 rows instead of 10 x 5. Same 50 sprites — the count is
 * never a function of the screen, or no two environments could be compared — but they now fill a
 * portrait viewport instead of being fitted into a thin band across the middle of it, which is what
 * actually loads the renderer.
 *
 * Gated on `fit`, not on the aspect, precisely so an UNFITTED desktop run keeps its 10x5 grid: a
 * 1280x800 viewport is 1.6 wide, and the aspect-derived shape for that is 9x6.
 */
export function spriteGridShape(
  params: { mounted?: unknown },
  layout: StageLayout,
): GridShape {
  const mounted = Math.max(1, Number(params.mounted ?? 0) || 0);
  if (!layout.fit) {
    return {
      columns: Math.min(COLUMNS, mounted),
      rows: Math.ceil(mounted / COLUMNS),
    };
  }
  return gridShapeFor(
    mounted,
    // Sprite cells are square (SPRITE_PX + GAP_PX either way), so the cell aspect is 1.
    1,
    layout.viewport.height > 0
      ? layout.viewport.width / layout.viewport.height
      : 1,
  );
}

export function spritePosition(
  index: number,
  columns: number = COLUMNS,
): { left: number; top: number } {
  const col = index % columns;
  const row = Math.floor(index / columns);
  return {
    left: PAD_PX + col * (SPRITE_PX + GAP_PX),
    top: PAD_PX + row * (SPRITE_PX + GAP_PX),
  };
}

/**
 * The grid's own box in CSS px: the padded bounding box of `mounted` sprites on the fixed
 * COLUMNS-wide grid. Pure, and shared by all four scenarios, so the stage a fitted run scales into
 * the viewport is derived from the SAME geometry the sprites are laid out with — a hand-written
 * constant here would drift the moment `mounted` or `COLUMNS` changed and quietly clip the last row.
 */
export function spriteSceneStageSize(
  params: { mounted?: unknown },
  layout: StageLayout,
): { width: number; height: number } {
  const { columns, rows } = spriteGridShape(params, layout);
  return {
    width: PAD_PX * 2 + columns * SPRITE_PX + (columns - 1) * GAP_PX,
    height: PAD_PX * 2 + rows * SPRITE_PX + (rows - 1) * GAP_PX,
  };
}

/** Sprite centres in CSS px, before any ancestor transform. */
export function spriteSamplePoints(
  ctx: ScenarioContext,
): { x: number; y: number }[] {
  const mounted = Number(ctx.params.mounted);
  const { columns } = spriteGridShape(ctx.params, ctx.layout);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < mounted; i++) {
    const { left, top } = spritePosition(i, columns);
    points.push({ x: left + SPRITE_PX / 2, y: top + SPRITE_PX / 2 });
  }
  return points;
}

/**
 * Build the sprite grid under `host` (default: the scenario root). S2 passes its own ancestor element
 * so the very same grid sits under a transform it can animate.
 */
export function mountSpriteScene(
  ctx: ScenarioContext,
  host: HTMLElement = ctx.root,
): SpriteSceneState {
  const mounted = Number(ctx.params.mounted);
  const animated = Number(ctx.params.animated);
  const regionCount = ctx.fixture.regions.length;
  const { columns } = spriteGridShape(ctx.params, ctx.layout);

  const container = document.createElement("div");
  container.id = "perf-stage";
  container.style.position = "absolute";
  container.style.inset = "0";
  host.appendChild(container);

  const nodes: SpriteNode[] = [];
  for (let i = 0; i < mounted; i++) {
    const { left, top } = spritePosition(i, columns);
    const element = document.createElement("div");
    element.className = "sprite";
    element.style.position = "absolute";
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${SPRITE_PX}px`;
    element.style.height = `${SPRITE_PX}px`;
    let canvas: HTMLCanvasElement | undefined;
    if (mechanismOf(ctx) === "canvas") {
      canvas = document.createElement("canvas");
      canvas.width = SPRITE_PX;
      canvas.height = SPRITE_PX;
      canvas.style.width = `${SPRITE_PX}px`;
      canvas.style.height = `${SPRITE_PX}px`;
      canvas.style.display = "block";
      element.appendChild(canvas);
    }
    container.appendChild(element);
    const baseRegion = spriteRegionIndex(i, regionCount);
    nodes.push({
      element,
      canvas,
      baseRegion,
      animated: i < animated,
      currentRegion: baseRegion,
    });
  }

  const state: SpriteSceneState = {
    nodes,
    container,
    page: undefined,
    bitmap: undefined,
    regionUrls: [],
    prepared: undefined,
    boxPx: SPRITE_PX,
  };

  // `page-crop` can paint straight from the page URL, so its styles are applied at mount: the
  // browser starts the fetch immediately and the cost lands where the mechanism really puts it
  // (paint + decode), not in a JS-visible preparation step.
  if (mechanismOf(ctx) === "page-crop") {
    for (const node of nodes) {
      applyPageCrop(ctx, node, node.currentRegion, state.boxPx);
    }
  }
  state.prepared = prepareSpriteScene(ctx, state);
  return state;
}

export function stepSpriteScene(
  ctx: ScenarioContext,
  state: SpriteSceneState,
  frame: number,
): void {
  const regionCount = ctx.fixture.regions.length;
  const mechanism = mechanismOf(ctx);
  for (const node of state.nodes) {
    if (!node.animated) {
      continue;
    }
    node.currentRegion = (node.baseRegion + frame) % regionCount;
    if (mechanism === "page-crop") {
      applyPageCrop(ctx, node, node.currentRegion, state.boxPx);
    } else if (mechanism === "region-blob") {
      const url = state.regionUrls[node.currentRegion];
      if (url) {
        node.element.style.backgroundImage = `url("${url}")`;
      }
    } else if (mechanism === "canvas" && state.bitmap && node.canvas) {
      drawRegionToCanvas(ctx, node.canvas, state.bitmap, node.currentRegion);
    }
  }
}

export function teardownSpriteScene(state: SpriteSceneState): void {
  for (const url of state.regionUrls) {
    if (url) {
      URL.revokeObjectURL(url);
    }
  }
  state.bitmap?.close?.();
  state.container.remove();
}

export async function prepareSpriteScene(
  ctx: ScenarioContext,
  state: SpriteSceneState,
): Promise<void> {
  const mechanism = mechanismOf(ctx);
  if (mechanism === "page-crop") {
    // Only the network fetch is awaited. Forcing a decode here would move the mechanism's real cost
    // out of paint and into `readyMs`, hiding the very thing this arm exists to expose.
    state.page = await loadImage(ctx.fixture.pageUrl);
    return;
  }

  const response = await fetch(ctx.fixture.pageUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  state.bitmap = bitmap;

  if (mechanism === "canvas") {
    for (const node of state.nodes) {
      if (node.canvas) {
        drawRegionToCanvas(ctx, node.canvas, bitmap, node.currentRegion);
      }
    }
    return;
  }

  // region-blob: bake every region once so the animation can swap between them without re-baking.
  const urls: string[] = [];
  for (let i = 0; i < ctx.fixture.regions.length; i++) {
    const region = ctx.fixture.regions[i];
    const offscreen = new OffscreenCanvas(region.width, region.height);
    const context = offscreen.getContext("2d");
    if (!context) {
      throw new Error("region-blob: no 2d context on OffscreenCanvas");
    }
    context.drawImage(
      bitmap,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      region.width,
      region.height,
    );
    const baked = await offscreen.convertToBlob({ type: "image/png" });
    urls.push(URL.createObjectURL(baked));
  }
  state.regionUrls = urls;
  for (const node of state.nodes) {
    const url = urls[node.currentRegion];
    node.element.style.backgroundImage = `url("${url}")`;
    node.element.style.backgroundSize = "100% 100%";
    node.element.style.backgroundRepeat = "no-repeat";
  }
}

/**
 * Re-lay the grid out at `scale`, in CSS px — box sizes and positions, not a transform.
 *
 * This is how the consuming project's view-scale / card-focus actually works: the renderer rewrites
 * element geometry, so `regionBackgroundStyle` re-derives a NEW `background-size` and the browser
 * needs the atlas decoded at a new scale. An ancestor `transform: scale()` measurably does NOT do
 * that (see `ancestor-rescale`'s driver documentation), which is the whole reason both exist.
 */
export function applySpriteScale(
  ctx: ScenarioContext,
  state: SpriteSceneState,
  scale: number,
): void {
  const mechanism = mechanismOf(ctx);
  const boxPx = SPRITE_PX * scale;
  state.boxPx = boxPx;
  const { columns } = spriteGridShape(ctx.params, ctx.layout);
  for (let index = 0; index < state.nodes.length; index++) {
    const node = state.nodes[index];
    const { left, top } = spritePosition(index, columns);
    const style = node.element.style;
    style.left = `${left * scale}px`;
    style.top = `${top * scale}px`;
    style.width = `${boxPx}px`;
    style.height = `${boxPx}px`;
    if (mechanism === "page-crop") {
      applyPageCrop(ctx, node, node.currentRegion, boxPx);
    } else if (mechanism === "canvas" && node.canvas && state.bitmap) {
      // A canvas renderer under a scale change re-sizes its backing store and redraws; pretending
      // otherwise would credit this arm with a resolution it does not have.
      const backing = Math.max(1, Math.round(boxPx));
      if (node.canvas.width !== backing) {
        node.canvas.width = backing;
        node.canvas.height = backing;
      }
      node.canvas.style.width = `${boxPx}px`;
      node.canvas.style.height = `${boxPx}px`;
      drawRegionToCanvas(ctx, node.canvas, state.bitmap, node.currentRegion);
    }
  }
}

export function applyPageCrop(
  ctx: ScenarioContext,
  node: SpriteNode,
  regionIndex: number,
  boxPx: number = SPRITE_PX,
): void {
  const region = ctx.fixture.regions[regionIndex];
  // gsw's SHIPPED crop math — measuring a re-derivation here would measure the wrong code.
  const { backgroundPosition, backgroundSize } = regionBackgroundStyle(region, {
    atlasSize: ctx.fixture.pageSize,
    box: { width: boxPx, height: boxPx },
    stretchMode: 1,
  });
  const style = node.element.style;
  if (!style.backgroundImage) {
    style.backgroundImage = `url("${ctx.fixture.pageUrl}")`;
    style.backgroundRepeat = "no-repeat";
  }
  style.backgroundPosition = backgroundPosition;
  style.backgroundSize = backgroundSize;
}

export function drawRegionToCanvas(
  ctx: ScenarioContext,
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap,
  regionIndex: number,
): void {
  const region = ctx.fixture.regions[regionIndex];
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    bitmap,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const image = new Image();
    image.onload = () => res(image);
    image.onerror = () => rej(new Error(`failed to load ${url}`));
    image.src = url;
  });
}
