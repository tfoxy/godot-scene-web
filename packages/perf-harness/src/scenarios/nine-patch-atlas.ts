// S3 `nine-patch-atlas` — 20 nine-patch nodes, 9 slices each, over ONE big sheet.
//
// gsw's shipped nine-patch path for an EXTERNAL texture URL (`packages/html/src/textures.ts`, the
// `if (ninePatch)` block) emits:
//
//     border-style: solid;
//     border-width: <patch margins>px;
//     border-image-source: url(<the whole sheet>);
//     border-image-slice: <clamped source margins> fill;
//     border-image-repeat: stretch stretch;
//
// i.e. every nine-patch node's display list references the FULL sheet, and the browser scales that
// sheet per node, into that node's box. Two differently-sized nodes are therefore two differently
// scaled draws of one 16 MP image — the same cause class as `atlas-sprites`' page-crop arm, reached
// by a completely different code path, and never measured before this scenario existed.
//
// The `gsw-nine-patch` arm gets that CSS from the SHIPPED pipeline — the scene is authored as real
// `.tscn` text and run through `parseGodotTextScene` -> `deriveSceneGraph` -> `resolveGodotSceneTree`
// -> `renderSceneToHtmlModel` -> `mountHtmlScene`. Re-deriving the five declarations by hand here
// would measure a copy that cannot drift when the real one does, which is the one thing a harness
// must never do.
//
// The sheet is the OPAQUE generated fixture, not the sprite atlas: a nine-patch stretches its centre
// slice across the whole node, and an atlas page's transparent gutters would land under the presence
// guard's sample points and report a perfectly good render as a blank page.

import {
  godotSceneBaseCss,
  mountHtmlScene,
  renderSceneToHtmlModel,
  SELF_LAYER_CLASS,
} from "@godot-scene-web/html";
import { resolveGodotSceneTree } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { type GridShape, gridShapeFor } from "../fit";
import { type RescaleSchedule, rescaleScaleAt } from "./ancestor-rescale";
import type {
  ParamValue,
  Scenario,
  ScenarioContext,
  StageLayout,
} from "./types";

export const NINE_PATCH_MECHANISMS = ["gsw-nine-patch", "slice-blob", "canvas"];
export const NODE_SIZING_VALUES = ["varied", "uniform"];

/** The AUTHORED grid width, used whenever the run is not fitted (so desktop is unchanged). */
const COLUMNS = 4;
const CELL_W = 258;
const CELL_H = 126;
const PAD = 8;
const SHEET_URL_MARKER = "/fixture/background.png";

export interface PatchBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Node geometry, pure and shared by every arm. `uniform` gives all 20 nodes one size, so the sheet is
 * scaled ONCE; `varied` gives each its own, so the sheet is scaled 20 different ways. That is the
 * whole isolation: same node count, same slice count, same sheet — only the number of distinct
 * scalings changes.
 */
/**
 * S3's grid shape. Same rule as the sprite grid, with the cells' REAL aspect (258x126, not square),
 * so a portrait viewport gets a tall arrangement of the same 20 nodes instead of a wide one squeezed
 * into a band. Unfitted runs keep the authored 4 columns.
 */
export function patchGridShape(
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
    CELL_W / CELL_H,
    layout.viewport.height > 0
      ? layout.viewport.width / layout.viewport.height
      : 1,
  );
}

export function patchBoxes(
  count: number,
  sizing: string,
  columns: number = COLUMNS,
): PatchBox[] {
  const boxes: PatchBox[] = [];
  for (let index = 0; index < count; index++) {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const width = sizing === "uniform" ? 190 : 150 + ((index * 37) % 80);
    const height = sizing === "uniform" ? 94 : 70 + ((index * 53) % 48);
    boxes.push({
      left: PAD + col * CELL_W,
      top: PAD + row * CELL_H,
      width,
      height,
    });
  }
  return boxes;
}

/**
 * The scene, as real Godot text. Authored rather than hand-built as objects so the whole shipped
 * chain — parser, scene graph, Control layout, HTML model — is what produces the DOM under test.
 */
export function ninePatchSceneText(
  boxes: PatchBox[],
  margin: number,
  viewport: { width: number; height: number },
): string {
  const lines: string[] = [
    "[gd_scene load_steps=2 format=3]",
    "",
    '[ext_resource type="Texture2D" path="res://sheet.png" id="1"]',
    "",
    '[node name="Root" type="Control"]',
    `offset_right = ${viewport.width}.0`,
    `offset_bottom = ${viewport.height}.0`,
  ];
  boxes.forEach((box, index) => {
    lines.push(
      "",
      `[node name="Patch${index}" type="NinePatchRect" parent="."]`,
      `offset_left = ${box.left}.0`,
      `offset_top = ${box.top}.0`,
      `offset_right = ${box.left + box.width}.0`,
      `offset_bottom = ${box.top + box.height}.0`,
      `patch_margin_left = ${margin}`,
      `patch_margin_top = ${margin}`,
      `patch_margin_right = ${margin}`,
      `patch_margin_bottom = ${margin}`,
      'texture = ExtResource("1")',
    );
  });
  return `${lines.join("\n")}\n`;
}

/** The nine source/destination slice rects, in the order gsw's border-image `fill` paints them. */
export function nineSlices(
  box: { width: number; height: number },
  margin: number,
  sheet: { width: number; height: number },
): {
  source: { x: number; y: number; width: number; height: number };
  dest: { x: number; y: number; width: number; height: number };
}[] {
  const columns = [
    { sx: 0, sw: margin, dx: 0, dw: margin },
    {
      sx: margin,
      sw: Math.max(1, sheet.width - margin * 2),
      dx: margin,
      dw: Math.max(0, box.width - margin * 2),
    },
    {
      sx: sheet.width - margin,
      sw: margin,
      dx: box.width - margin,
      dw: margin,
    },
  ];
  const rows = [
    { sy: 0, sh: margin, dy: 0, dh: margin },
    {
      sy: margin,
      sh: Math.max(1, sheet.height - margin * 2),
      dy: margin,
      dh: Math.max(0, box.height - margin * 2),
    },
    {
      sy: sheet.height - margin,
      sh: margin,
      dy: box.height - margin,
      dh: margin,
    },
  ];
  const slices = [];
  for (const row of rows) {
    for (const column of columns) {
      slices.push({
        source: {
          x: column.sx,
          y: row.sy,
          width: column.sw,
          height: row.sh,
        },
        dest: { x: column.dx, y: row.dy, width: column.dw, height: row.dh },
      });
    }
  }
  return slices;
}

interface PatchNode {
  /** Outer element that owns the node's box. */
  element: HTMLElement;
  /** gsw's self-layer, which carries the border-image; undefined on the control arms. */
  selfLayer: HTMLElement | undefined;
  canvas: HTMLCanvasElement | undefined;
  slices: HTMLElement[];
  box: PatchBox;
}

interface State {
  container: HTMLElement;
  style: HTMLStyleElement | undefined;
  nodes: PatchNode[];
  boxes: PatchBox[];
  margin: number;
  schedule: RescaleSchedule;
  bitmap: ImageBitmap | undefined;
  blobUrls: string[];
  prepared: Promise<void> | undefined;
  startMs: number | undefined;
  scale: number;
}

const states = new WeakMap<HTMLElement, State>();

function sheetOf(ctx: ScenarioContext): {
  url: string;
  width: number;
  height: number;
} {
  const sheet = ctx.fixture.background;
  if (!sheet) {
    throw new Error(
      "nine-patch-atlas: the runner served no sheet fixture — every arm draws from it, so measuring without it would be measuring nothing",
    );
  }
  return sheet;
}

export const ninePatchAtlas: Scenario = {
  name: "nine-patch-atlas",
  params: {
    mechanism: {
      default: "gsw-nine-patch",
      values: NINE_PATCH_MECHANISMS,
      describe: "how a nine-patch node draws its nine slices",
    },
    mounted: { default: 20, describe: "nine-patch nodes mounted" },
    patchMargin: {
      default: 24,
      describe: "patch margin in px (the corner/edge slice size)",
    },
    sheetSize: {
      default: 4096,
      describe: "nine-patch sheet size in px (square)",
    },
    nodeSizing: {
      default: "varied",
      values: NODE_SIZING_VALUES,
      describe:
        "varied: every node a different size, so the sheet is scaled 20 ways; uniform: one size, one scaling",
    },
    focusPeriodMs: { default: 1000, describe: "length of one rescale cycle" },
    focusRampMs: { default: 300, describe: "ramp time in each direction" },
    focusHoldMs: { default: 200, describe: "time held at the focused scale" },
    focusScale: { default: 1.2, describe: "peak scale" },
    // Declared so the runner's atlas step has the same knobs as every other scenario; this scenario
    // draws from the sheet, not the sprite atlas, so the page it generates is the small default.
    regions: { default: 16, describe: "regions on the (unused) sprite atlas" },
    atlasPage: { default: 1024, describe: "sprite atlas page size in px" },
  },

  backgroundFixture(params: Record<string, ParamValue>) {
    const size = Number(params.sheetSize);
    return { width: size, height: size };
  },

  watchImageUrl: SHEET_URL_MARKER,

  mount(ctx: ScenarioContext): void {
    const mechanism = String(ctx.params.mechanism);
    const margin = Number(ctx.params.patchMargin);
    const boxes = patchBoxes(
      Number(ctx.params.mounted),
      String(ctx.params.nodeSizing),
      patchGridShape(ctx.params, ctx.layout).columns,
    );
    const sheet = sheetOf(ctx);

    const container = document.createElement("div");
    container.id = "perf-stage";
    container.style.position = "absolute";
    container.style.inset = "0";
    ctx.root.appendChild(container);

    const state: State = {
      container,
      style: undefined,
      nodes: [],
      boxes,
      margin,
      schedule: {
        periodMs: Number(ctx.params.focusPeriodMs),
        rampMs: Number(ctx.params.focusRampMs),
        holdMs: Number(ctx.params.focusHoldMs),
        scale: Number(ctx.params.focusScale),
      },
      bitmap: undefined,
      blobUrls: [],
      prepared: undefined,
      startMs: undefined,
      scale: 1,
    };

    if (mechanism === "gsw-nine-patch") {
      mountShippedNinePatch(state, boxes, margin, sheet, ctx.stage);
    } else {
      mountControlArm(state, boxes, mechanism);
    }

    states.set(ctx.root, state);
    state.prepared = prepare(ctx, state, mechanism, margin, sheet);
  },

  async ready(ctx: ScenarioContext): Promise<void> {
    const state = states.get(ctx.root);
    if (!state?.prepared) {
      throw new Error("nine-patch-atlas: ready() called before mount()");
    }
    await state.prepared;
  },

  step(ctx: ScenarioContext, _frame: number): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    const now = performance.now();
    state.startMs ??= now;
    const scale = rescaleScaleAt(now - state.startMs, state.schedule);
    state.scale = scale;
    applyPatchScale(ctx, state, scale);
  },

  teardown(ctx: ScenarioContext): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    for (const url of state.blobUrls) {
      URL.revokeObjectURL(url);
    }
    state.bitmap?.close?.();
    state.style?.remove();
    state.container.remove();
    states.delete(ctx.root);
  },

  samplePoints(ctx: ScenarioContext): { x: number; y: number }[] {
    const boxes = patchBoxes(
      Number(ctx.params.mounted),
      String(ctx.params.nodeSizing),
      patchGridShape(ctx.params, ctx.layout).columns,
    );
    // Called after the measured window, so it must describe the geometry the screenshot will show:
    // the last scale the step loop applied is still on the elements.
    const scale = states.get(ctx.root)?.scale ?? 1;
    return boxes.map((box) => ({
      x: (box.left + box.width / 2) * scale,
      y: (box.top + box.height / 2) * scale,
    }));
  },

  // The node grid's extent at its PEAK scale, plus the same padding the grid starts with.
  // `applyPatchScale` multiplies every left/top/width/height, so the extent is linear in the scale.
  stageSize(params: Record<string, ParamValue>, layout: StageLayout) {
    const boxes = patchBoxes(
      Number(params.mounted),
      String(params.nodeSizing ?? "varied"),
      patchGridShape(params, layout).columns,
    );
    const peak = Math.max(1, Number(params.focusScale) || 1);
    const right = Math.max(...boxes.map((box) => box.left + box.width));
    const bottom = Math.max(...boxes.map((box) => box.top + box.height));
    return {
      width: Math.ceil(right * peak) + PAD,
      height: Math.ceil(bottom * peak) + PAD,
    };
  },

  gridShape(params: Record<string, ParamValue>, layout: StageLayout) {
    return patchGridShape(params, layout);
  },
};

function mountShippedNinePatch(
  state: State,
  boxes: PatchBox[],
  margin: number,
  sheet: { url: string; width: number; height: number },
  // The Control root is sized from the box the scenario was GIVEN, never from `window.innerWidth`:
  // on a fitted run the stage is scaled into the viewport by a transform above this subtree, so the
  // window size is the letterboxed frame, not the space these nodes lay out in.
  stageSize: { width: number; height: number },
): void {
  const scene = parseGodotTextScene(
    ninePatchSceneText(boxes, margin, stageSize),
  );
  const model = renderSceneToHtmlModel(
    resolveGodotSceneTree(deriveSceneGraph(scene)),
    {
      resolveResource: () => ({
        url: sheet.url,
        size: { width: sheet.width, height: sheet.height },
      }),
    },
  );
  const style = document.createElement("style");
  style.textContent = `${godotSceneBaseCss}\n${model.css}`;
  document.head.appendChild(style);
  state.style = style;

  const stage = mountHtmlScene(state.container, model);
  // The resource-kind attribute lands on BOTH the node element and its self-layer, so the class is
  // what disambiguates: the self-layer is where the border-image lives.
  const selfLayers = [
    ...stage.querySelectorAll<HTMLElement>(
      `.${SELF_LAYER_CLASS}[data-godot-resource-kind="NinePatchRect"]`,
    ),
  ];
  if (selfLayers.length !== boxes.length) {
    throw new Error(
      `nine-patch-atlas: the shipped pipeline produced ${selfLayers.length} nine-patch layers for ${boxes.length} nodes — the scenario is not measuring what it claims`,
    );
  }
  selfLayers.forEach((selfLayer, index) => {
    const element = selfLayer.parentElement as HTMLElement;
    state.nodes.push({
      element,
      selfLayer,
      canvas: undefined,
      slices: [],
      box: boxes[index],
    });
  });
}

function mountControlArm(
  state: State,
  boxes: PatchBox[],
  mechanism: string,
): void {
  for (const box of boxes) {
    const element = document.createElement("div");
    element.className = "patch";
    element.style.position = "absolute";
    element.style.left = `${box.left}px`;
    element.style.top = `${box.top}px`;
    element.style.width = `${box.width}px`;
    element.style.height = `${box.height}px`;
    state.container.appendChild(element);
    let canvas: HTMLCanvasElement | undefined;
    const slices: HTMLElement[] = [];
    if (mechanism === "canvas") {
      canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(box.width));
      canvas.height = Math.max(1, Math.round(box.height));
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      canvas.style.display = "block";
      element.appendChild(canvas);
    } else {
      for (let i = 0; i < 9; i++) {
        const slice = document.createElement("span");
        slice.style.position = "absolute";
        slice.style.backgroundRepeat = "no-repeat";
        slice.style.backgroundSize = "100% 100%";
        element.appendChild(slice);
        slices.push(slice);
      }
    }
    state.nodes.push({
      element,
      selfLayer: undefined,
      canvas,
      slices,
      box,
    });
  }
}

async function prepare(
  ctx: ScenarioContext,
  state: State,
  mechanism: string,
  margin: number,
  sheet: { url: string; width: number; height: number },
): Promise<void> {
  if (mechanism === "gsw-nine-patch") {
    // Only the fetch is awaited: the arm's cost belongs in paint + decode, which is where the
    // mechanism really puts it.
    await new Promise<void>((res, rej) => {
      const image = new Image();
      image.onload = () => res();
      image.onerror = () => rej(new Error(`failed to load ${sheet.url}`));
      image.src = sheet.url;
    });
    return;
  }

  const response = await fetch(sheet.url);
  const bitmap = await createImageBitmap(await response.blob());
  state.bitmap = bitmap;

  if (mechanism === "canvas") {
    for (const node of state.nodes) {
      drawPatchToCanvas(node, margin, sheet, bitmap);
    }
    return;
  }

  // slice-blob: bake each node's nine slices ONCE at their destination resolution, so no display
  // list ever references the full sheet. That is the fix this arm exists to price.
  for (const node of state.nodes) {
    const slices = nineSlices(node.box, margin, sheet);
    for (let i = 0; i < slices.length; i++) {
      const { source, dest } = slices[i];
      const element = node.slices[i];
      if (dest.width <= 0 || dest.height <= 0) {
        element.style.display = "none";
        continue;
      }
      const offscreen = new OffscreenCanvas(
        Math.max(1, Math.round(dest.width)),
        Math.max(1, Math.round(dest.height)),
      );
      const context = offscreen.getContext("2d");
      if (!context) {
        throw new Error("slice-blob: no 2d context on OffscreenCanvas");
      }
      context.drawImage(
        bitmap,
        source.x,
        source.y,
        source.width,
        source.height,
        0,
        0,
        offscreen.width,
        offscreen.height,
      );
      const url = URL.createObjectURL(
        await offscreen.convertToBlob({ type: "image/png" }),
      );
      state.blobUrls.push(url);
      element.style.backgroundImage = `url("${url}")`;
    }
  }
  applyPatchScale(ctx, state, 1);
}

function drawPatchToCanvas(
  node: PatchNode,
  margin: number,
  sheet: { width: number; height: number },
  bitmap: ImageBitmap,
): void {
  const canvas = node.canvas;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) {
    return;
  }
  const scaleX = canvas.width / node.box.width;
  const scaleY = canvas.height / node.box.height;
  context.clearRect(0, 0, canvas.width, canvas.height);
  for (const { source, dest } of nineSlices(node.box, margin, sheet)) {
    if (dest.width <= 0 || dest.height <= 0) {
      continue;
    }
    context.drawImage(
      bitmap,
      source.x,
      source.y,
      source.width,
      source.height,
      dest.x * scaleX,
      dest.y * scaleY,
      dest.width * scaleX,
      dest.height * scaleY,
    );
  }
}

/**
 * Re-lay every node out at `scale`, in CSS px. gsw's own content-scale does exactly this
 * (`scaleStyleRecord` rewrites every px length, border widths included), so the shipped arm's
 * `border-image` is re-scaled per node per frame — which is the cost under measurement.
 */
function applyPatchScale(
  ctx: ScenarioContext,
  state: State,
  scale: number,
): void {
  const mechanism = String(ctx.params.mechanism);
  const sheet = sheetOf(ctx);
  for (const node of state.nodes) {
    const box = node.box;
    const width = box.width * scale;
    const height = box.height * scale;
    const margin = state.margin * scale;
    node.element.style.left = `${box.left * scale}px`;
    node.element.style.top = `${box.top * scale}px`;
    node.element.style.width = `${width}px`;
    node.element.style.height = `${height}px`;
    if (mechanism === "gsw-nine-patch") {
      if (node.selfLayer) {
        node.selfLayer.style.borderWidth = `${margin}px`;
      }
      continue;
    }
    if (mechanism === "canvas" && node.canvas && state.bitmap) {
      const backing = Math.max(1, Math.round(width));
      const backingH = Math.max(1, Math.round(height));
      if (node.canvas.width !== backing || node.canvas.height !== backingH) {
        node.canvas.width = backing;
        node.canvas.height = backingH;
      }
      node.canvas.style.width = `${width}px`;
      node.canvas.style.height = `${height}px`;
      drawPatchToCanvas(node, state.margin, sheet, state.bitmap);
      continue;
    }
    const slices = nineSlices({ width, height }, margin, sheet);
    for (let i = 0; i < slices.length; i++) {
      const element = node.slices[i];
      const { dest } = slices[i];
      if (!element || dest.width <= 0 || dest.height <= 0) {
        continue;
      }
      element.style.left = `${dest.x}px`;
      element.style.top = `${dest.y}px`;
      element.style.width = `${dest.width}px`;
      element.style.height = `${dest.height}px`;
    }
  }
}
