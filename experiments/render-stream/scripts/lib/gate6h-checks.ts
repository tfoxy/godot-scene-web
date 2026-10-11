// Gate 6h checks (protocol/gate6-design.md "G6h", "Q6e", "Q7b"): fixtures/gate6-hd, nine copies
// of the gate 6 scene in a 3x3 grid at logical 1920x1080 under `canvas_items` stretch, its
// references at both presentations (native 1920x1080, half 960x540) and its native legs, on
// render-stream/6 since G6b (render-stream/5 when G6h landed). G6b's half legs are
// lib/gate6b-checks.ts's.
//
// Everything here reads an evidence directory written by run-gate6.sh's g6h group
// (lib/gate6h-legs.sh), or is pure over values already read from one, so
// scripts/test/self-test-gate6h.ts can drive each check with synthetic values. Nothing launches a
// process.
//
// The records that meet here, none a replay of another (D7):
//   - fixtures/gate6-hd/make_expected.py's model: gate6-scene's model per cell at the cell's phase,
//     translated by the cell's origin; `half` is the same scene under scale(0.5) with
//     StyleBoxFlat's feather widened to aa_size / 0.5 canvas units (sbf:497-511). A shape's pixel
//     is decided under `half` exactly as under `native`: by its centre, undecided within 1/16 px
//     of an edge, so a half-pixel edge leaves its pixels undecided and an even logical edge (every
//     rect edge of the scene) decides them;
//   - the rendered references (oracle on) and their repeats at both presentations, an armed
//     reference at native, compared with the model per pixel class and with each other;
//   - the HD oracle (fixtures/gate6-hd/hd_oracle.gd): the grid and cell layout, the viewport's
//     stretch and font oversampling, every cell's scroll, layer, materials, PB, RT and LE focus, and
//     the atlas pages, read back from the rendered engine;
//   - the native capture: its classification, its session (stretch, root size), its sinks and
//     costs, its atlas pages against the oracle's, and the receivers' frames against the reference.
//
// Since G6b the wire is render-stream/6, which carries the nine HUD CanvasLayers (layers 1 + c,
// distinct, so no stacking tie): every leg classifies `success` and every receiver comparison
// covers every pixel, the nine HU regions included. Before G6b (render-stream/5) every leg was
// `unsupported` with `extra-canvas` and each cell's HU was excluded.
//
// Frames are 1920x1080: the orchestrator walks the shots one at a time (raster, reference frames,
// receiver frames) and keeps only the previous settle shot for the freshness comparisons.
//
// Evidence under <out>/hd/ (lib/gate6h-legs.sh): import/, capture-native/,
// reference-native{,-repeat,-armed}/, receiver-native{,-patch}/, reference-half{,-repeat}/.

import { join } from "node:path";

import {
  decodePngRgba,
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type AppliedJson,
  type Checkpoint,
  classifyLeg,
  drawIndexTies,
  PATCH_RECORDING_NAME,
  parseStepLog,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
  type StepLine,
} from "./gate0-checks";
import { parseJsonl } from "./gate2-checks";
import { checkPatchResolvesToFull, evaluateCapture } from "./gate3-checks";
import { check } from "./gate5-checks";
import type {
  Affine,
  Box,
  Gate5Item,
  Gate5Texture,
  Rgba8,
} from "./gate5-expected";
import type { Gate6Expected, Gate6Op, Gate6Shot } from "./gate6-expected";
import {
  appliedPairs,
  evaluateAtlasParity6,
  evaluateUnsupportedClass,
  type Frame6,
  type Gate6Check,
  type Gate6Checkpoint,
  nameIds6,
  type OracleLine6,
  type OracleLog6,
  type OraclePage,
  type RegionBudget6,
  shotSeqs,
  unsupportedPairs,
  wantedClass,
} from "./gate6a-checks";
import { loadWire5, type Wire5 } from "./gate55-wire";
import { type Gate5Raster, rasterizeItems } from "./geometry-raster";

// ---------------------------------------------------------------------------------------------
// expected.json (render-stream-gate6-hd-expected/1)
// ---------------------------------------------------------------------------------------------

export type Presentation = "native" | "half";
export const PRESENTATIONS: readonly Presentation[] = ["native", "half"];

export interface HdItem extends Gate5Item {
  /** the op list `half` draws instead (antialiased StyleBoxFlats: aa_size / 0.5) */
  ops_half?: string;
}

export interface HdShot {
  id: string;
  kind: "settle" | "mid";
  frame: number;
  step: number;
  /** logical coordinates */
  regions: Record<string, Box>;
  items: HdItem[];
}

export interface HdCellView {
  v_scroll: number;
  content_position: [number, number];
  hud: { layer: number; visible: boolean };
  pb_value: number;
  sm: { phase: number; tint: number[]; shader_sha256: string };
  cm_blend_mode: number;
  rich_text: {
    line_offsets: number[];
    content_height: number;
    v_scroll: number;
  };
  le_focus: boolean;
  cell_position: [number, number];
}

export interface HdStep {
  step: number;
  applied_frame: number;
  settle_frame: number;
  marker_rgba8: Rgba8;
  canvas_transform: Affine;
  /** per region (`c<c>.<region>`): its modelled content differs from the previous step's */
  fresh: Record<string, boolean>;
  /** what hd_oracle.gd must read back per cell at the settle frame */
  cells: HdCellView[];
}

export interface HdCell {
  cell: number;
  origin: [number, number];
  phase: number;
  texa_offset: number;
  hud_layer: number;
  hud_layer_step9: number;
  texb: string;
}

export interface Gate6HdExpected {
  schema: "render-stream-gate6-hd-expected/1";
  fixture: string;
  viewport: [number, number];
  presentations: Record<
    Presentation,
    { size: [number, number]; scale: number; oversampling: number }
  >;
  cells: HdCell[];
  focus_cell: number;
  clear_rgba8: Rgba8;
  start_frame_default: number;
  step_frames_default: number;
  settle_offset: number;
  quit_frame_default: number;
  last_step: number;
  mid_frames: number[];
  time_offset_frames: number;
  exact_edge_px: number;
  shift: [number, number];
  bg_panel: Box;
  creation_order: string[];
  created_later: { name: string; step: number }[];
  freed: { name: string; step: number }[];
  regions: Record<string, Box>;
  class: Record<string, "exact" | "undecided">;
  marker_rect: [number, number, number, number];
  textures: Record<string, Gate5Texture>;
  texture_hashes: Record<string, string>;
  draw_index_ties: unknown[];
  hud_panel_px: number;
  op_lists: Record<string, Gate6Op[]>;
  shots: HdShot[];
  steps: HdStep[];
  unsupported: [string, string][];
  synced: string[];
}

/** The items one presentation draws: the stretch scale composed onto every item transform and
 * scissor (the root's stretch is applied to every canvas, rv.cpp:45-46), and `ops_half` where
 * the half lowering differs. */
export function hdItems(
  e: Pick<Gate6HdExpected, "presentations">,
  shot: Pick<HdShot, "items">,
  pres: Presentation,
): Gate5Item[] {
  const s = e.presentations[pres].scale;
  return shot.items.map((i) => ({
    name: i.name,
    region: i.region,
    xform: s === 1 ? i.xform : (i.xform.map((v) => v * s) as unknown as Affine),
    clip_px: i.clip_px ? (i.clip_px.map((v) => v * s) as Box) : null,
    ops: pres === "half" ? (i.ops_half ?? i.ops) : i.ops,
  }));
}

/** The expected frame of one shot at one presentation. */
export function rasterOfShotHd(
  e: Gate6HdExpected,
  shot: HdShot,
  pres: Presentation,
): Gate5Raster {
  return rasterizeItems({
    viewport: e.presentations[pres].size,
    clear: e.clear_rgba8,
    textures: e.textures,
    opLists: e.op_lists,
    items: hdItems(e, shot, pres),
    exactEdgePx: e.exact_edge_px,
  });
}

/** Per pixel, the index of its region (-1: BG), for regions in logical coordinates drawn at
 * `scale` (every region edge is even, so `half` maps it to an integer pixel). */
export interface RegionIndex {
  names: string[];
  index: Int16Array;
  width: number;
  height: number;
}

export function regionIndexHd(
  regions: Record<string, Box>,
  width: number,
  height: number,
  scale: number,
): RegionIndex {
  const names = Object.keys(regions);
  const index = new Int16Array(width * height).fill(-1);
  names.forEach((name, k) => {
    const [x0, y0, x1, y1] = regions[name].map((v) => Math.round(v * scale));
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++)
      index.fill(
        k,
        y * width + Math.max(0, x0),
        y * width + Math.min(width, x1),
      );
  });
  return { names, index, width, height };
}

export function regionName(ri: RegionIndex, i: number): string {
  const k = ri.index[i];
  return k < 0 ? "BG" : ri.names[k];
}

function scaleBox(b: Box, s: number): Box {
  return b.map((v) => Math.round(v * s)) as Box;
}

/** The undecided boxes' content per region of one shot (freshness of undecided regions). */
export function undecidedContentHd(
  e: Pick<Gate6HdExpected, "op_lists">,
  shot: Pick<HdShot, "items">,
): Record<string, string> {
  const out: Record<string, unknown[]> = {};
  for (const item of shot.items)
    for (const op of e.op_lists[item.ops] ?? [])
      if ("kind" in op && op.kind === "undecided") {
        const list = out[item.region] ?? [];
        list.push([item.xform, op.rect, op.content]);
        out[item.region] = list;
      }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [k, JSON.stringify(v)]),
  );
}

function maxDelta(
  a: Uint8Array,
  ai: number,
  b: Uint8Array,
  bi: number,
): number {
  let d = 0;
  for (let c = 0; c < 4; c++)
    d = Math.max(d, Math.abs(a[ai * 4 + c] - b[bi * 4 + c]));
  return d;
}

// ---------------------------------------------------------------------------------------------
// expected-self-consistent (HD)
// ---------------------------------------------------------------------------------------------

const LEVELS = new Set([0, 51, 102, 153, 204, 255]);
const THEME_PREFIXES = ["SCROLLBAR", "PB.", "BT.", "LE."];

/** Pure, raster-free: the HD expected.json obeys its own rules, recomputed here independently of
 * make_expected.py's asserts: 1920x1080 logical, presented at 1920x1080 (scale 1, oversampling 1)
 * and 960x540 (0.5, 0.5); nine cells tiling a 3x3 grid of 640x360 with phase 7c, TEXA offset 100c
 * and HUD layers 1 + c (-1 - c at step 9, so no two cells share a stacking key); the focus on
 * cell 8 only; steps 0..11 at 1 + 10k (settle +7) with distinct markers; the shots; every region
 * inside the viewport and pairwise disjoint at every shot, its edges even (integer pixels at
 * half); the colour and texel grid; D6's formulas per cell at frame + 7c. */
export function evaluateExpectedStaticHd(e: Gate6HdExpected): {
  problems: string[];
  detail: string;
} {
  const problems: string[] = [];
  const [W, H] = e.viewport;
  if (W !== 1920 || H !== 1080) problems.push(`viewport ${W}x${H}`);
  const pn = e.presentations.native;
  const ph = e.presentations.half;
  if (
    JSON.stringify(pn) !==
      JSON.stringify({ size: [1920, 1080], scale: 1, oversampling: 1 }) ||
    JSON.stringify(ph) !==
      JSON.stringify({ size: [960, 540], scale: 0.5, oversampling: 0.5 })
  )
    problems.push(`presentations ${JSON.stringify(e.presentations)}`);
  if (e.cells.length !== 9) problems.push(`${e.cells.length} cells`);
  for (const c of e.cells) {
    const origin = [640 * (c.cell % 3), 360 * Math.floor(c.cell / 3)];
    if (
      JSON.stringify(c.origin) !== JSON.stringify(origin) ||
      c.phase !== 7 * c.cell ||
      c.texa_offset !== 100 * c.cell ||
      c.hud_layer !== 1 + c.cell ||
      c.hud_layer_step9 !== -1 - c.cell
    )
      problems.push(`cell ${c.cell}: ${JSON.stringify(c)}`);
  }
  if (e.focus_cell !== 8) problems.push(`focus cell ${e.focus_cell}`);
  const steps = e.steps.map((s) => s.step);
  if (JSON.stringify(steps) !== JSON.stringify([...Array(12).keys()]))
    problems.push(`steps ${JSON.stringify(steps)}`);
  for (const s of e.steps) {
    const applied = s.step === 0 ? 1 : 1 + 10 * s.step;
    if (s.applied_frame !== applied || s.settle_frame !== 1 + 10 * s.step + 7)
      problems.push(
        `step ${s.step}: frames ${s.applied_frame}/${s.settle_frame}`,
      );
    if (s.cells.length !== 9) problems.push(`step ${s.step}: cell views`);
    const layers = new Set(s.cells.map((c) => c.hud.layer));
    if (layers.size !== 9)
      problems.push(`step ${s.step}: HUD layers not distinct`);
    s.cells.forEach((c, k) => {
      const want = s.step === 9 ? -1 - k : 1 + k;
      if (c.hud.layer !== want)
        problems.push(`step ${s.step} cell ${k}: HUD layer ${c.hud.layer}`);
      if (c.le_focus !== (k === e.focus_cell))
        problems.push(`step ${s.step} cell ${k}: le_focus ${c.le_focus}`);
      const f = s.settle_frame + 7 * k;
      const frozen = s.step >= 11;
      const phase = frozen ? 0 : Math.floor((f % 24) / 4);
      const v = ((f + e.time_offset_frames) % 300) / 3;
      const pb = frozen ? 40 : Math.floor(v / 0.01 + 0.5) * 0.01;
      if (c.sm.phase !== phase)
        problems.push(
          `step ${s.step} cell ${k}: SM phase ${c.sm.phase} != formula ${phase}`,
        );
      if (Math.abs(c.pb_value - pb) > 1e-9)
        problems.push(
          `step ${s.step} cell ${k}: PB value ${c.pb_value} != formula ${pb}`,
        );
    });
  }
  if (new Set(e.steps.map((s) => s.marker_rgba8.join())).size !== 12)
    problems.push("marker colours are not distinct per step");
  const want = [
    ...[...Array(12).keys()].map((k) => `step-${k}`),
    "frame-13",
    "frame-53",
    "frame-93",
  ];
  if (JSON.stringify(e.shots.map((s) => s.id)) !== JSON.stringify(want))
    problems.push(`shots ${JSON.stringify(e.shots.map((s) => s.id))}`);
  for (const shot of e.shots) {
    const boxes = Object.entries(shot.regions).sort(
      (a, b) => a[1][0] - b[1][0],
    );
    if (boxes.length !== 9 * 17)
      problems.push(`${shot.id}: ${boxes.length} regions`);
    for (let i = 0; i < boxes.length; i++) {
      const [na, a] = boxes[i];
      if (
        !(
          0 <= a[0] &&
          a[0] < a[2] &&
          a[2] <= W &&
          0 <= a[1] &&
          a[1] < a[3] &&
          a[3] <= H
        )
      )
        problems.push(`${shot.id}: region ${na} is not inside the viewport`);
      if (a.some((v) => v % 2 !== 0))
        problems.push(`${shot.id}: region ${na} has an odd edge`);
      for (let j = i + 1; j < boxes.length; j++) {
        const [nb, b] = boxes[j];
        if (b[0] >= a[2]) break;
        if (!(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]))
          problems.push(`${shot.id}: regions ${na} and ${nb} overlap`);
      }
    }
  }
  const onGrid = (v: number) =>
    [0, 0.2, 0.4, 0.6, 0.8, 1].some((g) => Math.abs(v - g) < 5e-4);
  for (const [key, ops] of Object.entries(e.op_lists))
    for (const op of ops) {
      if (!("kind" in op) || op.kind !== "mesh") continue;
      if (THEME_PREFIXES.some((p) => op.name.startsWith(p))) continue;
      for (const c of op.colors) {
        const band = op.band_px !== undefined && Math.abs(c[3]) < 1e-6;
        if (
          !c.slice(0, 3).every(onGrid) ||
          (!band && Math.abs(c[3] - 1) > 1e-6)
        ) {
          problems.push(`${key}/${op.name}: colour ${c} off the grid`);
          break;
        }
      }
    }
  for (const [name, t] of Object.entries(e.textures))
    for (let i = 0; i < t.rgba8_hex.length; i += 2)
      if (!LEVELS.has(Number.parseInt(t.rgba8_hex.slice(i, i + 2), 16))) {
        problems.push(`texture ${name}: texel byte off the grid`);
        break;
      }
  return {
    problems,
    detail: `${e.cells.length} cells, ${e.steps.length} steps, ${e.shots.length} shots, ${Object.keys(e.regions).length} regions, ${Object.keys(e.op_lists).length} op lists, ${Object.keys(e.textures).length} textures`,
  };
}

/** Pure, one shot's raster at one presentation: outside every region only a cell's BG panel
 * (moved with the root canvas at steps 10 and 11), the clear colour or band; before step 10 each
 * cell's bottom strip (y in [344, 360) of the cell) is the clear colour outside TL. */
export function evaluateRasterOutsideHd(
  e: Pick<
    Gate6HdExpected,
    "presentations" | "cells" | "clear_rgba8" | "shift" | "bg_panel"
  >,
  shot: Pick<HdShot, "id" | "step" | "regions">,
  r: Gate5Raster,
  ri: RegionIndex,
  pres: Presentation,
): string[] {
  const s = e.presentations[pres].scale;
  const [sx, sy] = shot.step >= 10 ? e.shift : [0, 0];
  const panels = e.cells.map((c) =>
    scaleBox(
      [
        c.origin[0] + e.bg_panel[0] + sx,
        c.origin[1] + e.bg_panel[1] + sy,
        c.origin[0] + e.bg_panel[2] + sx,
        c.origin[1] + e.bg_panel[3] + sy,
      ],
      s,
    ),
  );
  const strips =
    shot.step >= 10
      ? []
      : e.cells.map((c) =>
          scaleBox(
            [
              c.origin[0],
              c.origin[1] + 344,
              c.origin[0] + 640,
              c.origin[1] + 360,
            ],
            s,
          ),
        );
  let outside = 0;
  let strip = 0;
  const clear = e.clear_rgba8;
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      const i = y * r.width + x;
      const name = regionName(ri, i);
      const inStrip = strips.some(
        (b) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3],
      );
      if (inStrip && !name.endsWith(".TL")) {
        if (
          !r.exact[i] ||
          [0, 1, 2].some((c) => r.rgba[i * 4 + c] !== clear[c])
        )
          strip++;
      }
      if (name !== "BG" || r.band[i]) continue;
      const inPanel = panels.some(
        (b) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3],
      );
      const want = inPanel ? [51, 51, 51] : clear.slice(0, 3);
      if (!r.exact[i] || [0, 1, 2].some((c) => r.rgba[i * 4 + c] !== want[c]))
        outside++;
    }
  const problems: string[] = [];
  if (outside > 0)
    problems.push(
      `${pres} ${shot.id}: ${outside} pixels outside every region are neither a BG panel, the clear colour nor band`,
    );
  if (strip > 0)
    problems.push(
      `${pres} ${shot.id}: ${strip} pixels of the cells' bottom strips are not the clear colour`,
    );
  return problems;
}

/** Pure: between two consecutive settle shots' rasters, the regions whose model changed (pixels,
 * decided-ness or undecided content), over the union of both shots' boxes. */
export function changedRegionsHd(
  a: {
    regions: Record<string, Box>;
    raster: Pick<Gate5Raster, "rgba" | "exact" | "width">;
    content: Record<string, string>;
  },
  b: {
    regions: Record<string, Box>;
    raster: Pick<Gate5Raster, "rgba" | "exact" | "width">;
    content: Record<string, string>;
  },
  scale: number,
): Set<string> {
  const out = new Set<string>();
  const W = b.raster.width;
  for (const [name, box] of Object.entries(b.regions)) {
    if (a.content[name] !== b.content[name]) {
      out.add(name);
      continue;
    }
    const pa = scaleBox(a.regions[name] ?? box, scale);
    const pb = scaleBox(box, scale);
    let changed = false;
    for (
      let y = Math.min(pa[1], pb[1]);
      y < Math.max(pa[3], pb[3]) && !changed;
      y++
    )
      for (
        let x = Math.min(pa[0], pb[0]);
        x < Math.max(pa[2], pb[2]) && !changed;
        x++
      ) {
        const i = y * W + x;
        if (a.raster.exact[i] !== b.raster.exact[i]) changed = true;
        for (let c = 0; c < 4; c++)
          if (a.raster.rgba[i * 4 + c] !== b.raster.rgba[i * 4 + c])
            changed = true;
      }
    if (changed) out.add(name);
  }
  return out;
}

/** Pure: the regions whose pixels differ between two frames (reference freshness). */
export function changedRegionsFrames(
  a: Frame6,
  b: Frame6,
  regionsA: Record<string, Box>,
  regionsB: Record<string, Box>,
  scale: number,
  exclude: ReadonlySet<string> = new Set(),
): Set<string> {
  const out = new Set<string>();
  for (const [name, box] of Object.entries(regionsB)) {
    if (exclude.has(name)) continue;
    const pa = scaleBox(regionsA[name] ?? box, scale);
    const pb = scaleBox(box, scale);
    let differs = false;
    for (
      let y = Math.min(pa[1], pb[1]);
      y < Math.max(pa[3], pb[3]) && !differs;
      y++
    )
      for (
        let x = Math.min(pa[0], pb[0]);
        x < Math.max(pa[2], pb[2]) && !differs;
        x++
      ) {
        const i = y * b.width + x;
        if (maxDelta(a.rgba, i, b.rgba, i) > 0) differs = true;
      }
    if (differs) out.add(name);
  }
  return out;
}

/** Pure: a changed-region set against `fresh` at step k; problems name each disagreement. */
export function freshnessProblems(
  label: string,
  k: number,
  fresh: Record<string, boolean>,
  changed: ReadonlySet<string>,
  exclude: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const [name, f] of Object.entries(fresh)) {
    if (exclude.has(name)) continue;
    if (changed.has(name) !== f)
      out.push(
        `${label} step ${k}: ${name} ${changed.has(name) ? "changed" : "did not change"}, expected fresh=${f}`,
      );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Frames against the model and against each other
// ---------------------------------------------------------------------------------------------

/** Pure: one frame against its raster on every decided pixel (delta as the raster allows). */
export function imageAgainstModelHd(
  leg: string,
  shot: string,
  frame: Frame6 | null,
  r: Gate5Raster,
  ri: RegionIndex,
  path: string,
): { problem: string | null; checkpoint: Gate6Checkpoint } {
  if (!frame || frame.width !== r.width || frame.height !== r.height)
    return {
      problem: `${leg} ${shot}.png missing, unreadable or the wrong size`,
      checkpoint: {
        leg,
        shot,
        path,
        compared: null,
        mismatched_pixels: null,
        max_channel_delta: null,
        delta1_used: null,
        regions: {},
      },
    };
  let compared = 0;
  let mismatched = 0;
  let maxD = 0;
  let used = 0;
  const regions: Record<string, number> = {};
  const examples: string[] = [];
  for (let i = 0; i < r.width * r.height; i++) {
    if (!r.exact[i]) continue;
    compared++;
    const d = maxDelta(frame.rgba, i, r.rgba, i);
    if (d > 0 && d <= r.delta[i]) used++;
    if (d <= r.delta[i]) continue;
    mismatched++;
    maxD = Math.max(maxD, d);
    const name = regionName(ri, i);
    regions[name] = (regions[name] ?? 0) + 1;
    if (examples.length < 3)
      examples.push(
        `(${i % r.width},${Math.floor(i / r.width)}) ${[...frame.rgba.subarray(i * 4, i * 4 + 4)]} vs ${[...r.rgba.subarray(i * 4, i * 4 + 4)]}`,
      );
  }
  return {
    problem:
      mismatched > 0
        ? `${leg} ${shot}: ${mismatched} decided pixels differ from the model (max delta ${maxD}; ${Object.entries(
            regions,
          )
            .slice(0, 6)
            .map(([g, n]) => `${g} ${n}`)
            .join(", ")}; e.g. ${examples.join(", ")})`
        : null,
    checkpoint: {
      leg,
      shot,
      path,
      compared,
      mismatched_pixels: mismatched,
      max_channel_delta: maxD,
      delta1_used: used,
      regions,
    },
  };
}

/** Pure: every sub-shape covers at least half its expected area with pixels that differ from what
 * lies beneath it in the model. */
export function presenceHd(
  leg: string,
  shot: string,
  frame: Frame6 | null,
  r: Gate5Raster,
): { problems: string[]; shapes: number } {
  if (!frame) return { problems: [`${leg} ${shot}: shot missing`], shapes: 0 };
  const problems: string[] = [];
  let shapes = 0;
  for (const c of r.shapes) {
    if (c.covered === 0) continue;
    shapes++;
    let present = 0;
    c.area.forEach((i, k) => {
      for (let ch = 0; ch < 4; ch++)
        if (frame.rgba[i * 4 + ch] !== c.underlay[k * 4 + ch]) {
          present++;
          return;
        }
    });
    if (present * 2 < c.covered)
      problems.push(
        `${leg} ${shot} ${c.item}/${c.shape}: ${present} pixels present, expected at least ${Math.ceil(c.covered / 2)} of ${c.covered}`,
      );
  }
  return { problems, shapes };
}

export interface FrameDiffHd {
  compared: number;
  mismatched: number;
  max_delta: number;
  regions: Record<string, number>;
  excluded: Record<string, number>;
}

/** Pure: raw per-channel comparison of two frames, alpha included, attributing every pixel to its
 * region (or "BG"); excluded regions are counted apart. */
export function diffFramesHd(
  a: Frame6,
  b: Frame6,
  ri: RegionIndex,
  exclude: ReadonlySet<string>,
): FrameDiffHd {
  const out: FrameDiffHd = {
    compared: 0,
    mismatched: 0,
    max_delta: 0,
    regions: {},
    excluded: {},
  };
  for (let i = 0; i < a.width * a.height; i++) {
    const region = regionName(ri, i);
    const d = maxDelta(a.rgba, i, b.rgba, i);
    if (exclude.has(region)) {
      if (d > 0) out.excluded[region] = (out.excluded[region] ?? 0) + 1;
      continue;
    }
    out.compared++;
    if (d === 0) continue;
    out.mismatched++;
    out.max_delta = Math.max(out.max_delta, d);
    out.regions[region] = (out.regions[region] ?? 0) + 1;
  }
  return out;
}

/** Pure: leg against leg per region and pixel class, accumulated into `cells` over shots;
 * returns the number of differing pixels of this shot. */
export function accumulateBudgetHd(
  cells: Map<string, RegionBudget6>,
  a: Frame6,
  b: Frame6,
  r: Gate5Raster,
  ri: RegionIndex,
): number {
  let n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const cls = r.exact[i]
      ? r.delta[i] > 0
        ? "delta1"
        : "exact"
      : r.band[i]
        ? "band"
        : "undecided";
    // Per region family (`SC`, not `c3.SC`): nine cells x 17 regions would bury the table.
    const name = regionName(ri, i).replace(/^c\d+\./, "");
    const key = `${name}/${cls}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        region: name,
        class: cls,
        pixels: 0,
        mismatched_pixels: 0,
        max_channel_delta: 0,
      };
      cells.set(key, cell);
    }
    cell.pixels++;
    const d = maxDelta(a.rgba, i, b.rgba, i);
    if (d === 0) continue;
    n++;
    cell.mismatched_pixels++;
    cell.max_channel_delta = Math.max(cell.max_channel_delta, d);
  }
  return n;
}

/** The regions never compared receiver against reference: none since G6b (render-stream/6
 * carries the HUD layers); on /5 they were the nine HU regions. */
export function excludedRegionsHd(
  _e: Pick<Gate6HdExpected, "cells">,
): Set<string> {
  return new Set<string>();
}

/** Pure (render-stream/5 only, kept for its self-test): what a per-cell HU exclusion hid was
 * exactly the HUD panels a /5 receiver could not draw: per cell, the panel's 168x28 pixels while
 * that cell's HUD showed above the root canvas, else 0. */
export function hudExclusionProblems(
  e: Pick<Gate6HdExpected, "steps" | "hud_panel_px" | "presentations">,
  leg: string,
  shot: Pick<HdShot, "id" | "step">,
  diff: FrameDiffHd,
  pres: Presentation,
): string[] {
  const out: string[] = [];
  const s = e.presentations[pres].scale;
  e.steps[shot.step].cells.forEach((c, k) => {
    const want =
      c.hud.visible && c.hud.layer > 0 ? Math.round(e.hud_panel_px * s * s) : 0;
    const got = diff.excluded[`c${k}.HU`] ?? 0;
    if (got !== want)
      out.push(
        `${leg} ${shot.id}: c${k}.HU differs in ${got} pixels, expected exactly the HUD panel's ${want}`,
      );
  });
  return out;
}

/** Pure: a leg's verdict over its shots (honest legs: every compared pixel equal). */
export function pixelVerdictHd(
  diffs: readonly { shot: string; diff: FrameDiffHd | null }[],
): {
  verdict: "success" | "pixel-mismatch" | "incomplete";
  table: Record<string, string[]>;
  problems: string[];
} {
  const problems: string[] = [];
  const table: Record<string, string[]> = {};
  let incomplete = false;
  let any = false;
  for (const d of diffs) {
    if (!d.diff) {
      incomplete = true;
      problems.push(`${d.shot}: shot missing`);
      continue;
    }
    const regions = Object.keys(d.diff.regions).sort();
    table[d.shot] = regions;
    if (regions.length > 0) {
      any = true;
      problems.push(
        `${d.shot}: ${d.diff.mismatched} pixels differ from the reference (${regions.slice(0, 6).join(",")})`,
      );
    }
  }
  return {
    verdict: incomplete ? "incomplete" : any ? "pixel-mismatch" : "success",
    table,
    problems,
  };
}

// ---------------------------------------------------------------------------------------------
// The HD oracle
// ---------------------------------------------------------------------------------------------

export interface HdOracleCell {
  cell: number;
  position: [number, number];
  size: [number, number];
  scene_global_position: [number, number];
  scroll: { v_scroll: number; content_position: [number, number] };
  canvas_layers: {
    name: string;
    layer: number;
    sublayer: number;
    visible: boolean;
  }[];
  materials: OracleLine6["materials"];
  pb_value: number;
  rich_text: OracleLine6["rich_text"];
  line_edit: OracleLine6["line_edit"];
  le_focus: boolean;
}

export interface HdOracleLine {
  schema: "render-stream-gate6-hd-oracle/1";
  step: number;
  frame: number;
  oversampling: number;
  viewport: {
    window_size: [number, number];
    visible_size: [number, number];
    stretch_scale: [number, number];
    canvas_transform: number[];
  };
  grid: { position: [number, number]; size: [number, number] };
  cells: HdOracleCell[];
  pages: OraclePage[];
}

export function validateHdOracleLine(value: unknown): string | null {
  if (value === null || typeof value !== "object") return "not an object";
  const v = value as Partial<HdOracleLine>;
  if (v.schema !== "render-stream-gate6-hd-oracle/1") return "schema";
  if (!Number.isInteger(v.step) || !Number.isInteger(v.frame))
    return "step/frame";
  if (
    !v.viewport ||
    !v.grid ||
    !Array.isArray(v.cells) ||
    !Array.isArray(v.pages)
  )
    return "viewport/grid/cells/pages";
  return null;
}

export interface HdOracleLog {
  leg: string;
  path: string;
  text: string | undefined;
  lines: HdOracleLine[];
  problem: string | null;
}

export async function loadHdOracle(
  dir: string,
  leg: string,
): Promise<HdOracleLog> {
  const path = join(dir, "oracle.jsonl");
  const text = await readTextOrUndefined(path);
  const parsed = parseJsonl<HdOracleLine>(text, validateHdOracleLine);
  return { leg, path, text, lines: parsed.lines, problem: parsed.problem };
}

function lineAt(log: HdOracleLog, step: number): HdOracleLine | undefined {
  return log.lines.find((l) => l.step === step);
}

/** Pure: every oracle log of a presentation has one line per step at its settle frame; the grid
 * spans the logical 1920x1080 at (0, 0) and each cell sits at its 3x3 origin, 640x360, its Scene at
 * the same global position; the visible rect is the logical size whatever the presentation. */
export function evaluateGridLayout(
  e: Pick<Gate6HdExpected, "steps" | "cells">,
  logs: readonly HdOracleLog[],
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  const eq = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  for (const log of logs) {
    if (log.problem) {
      problems.push(`${log.leg} oracle.jsonl: ${log.problem}`);
      continue;
    }
    if (log.lines.length !== e.steps.length)
      problems.push(
        `${log.leg}: ${log.lines.length} oracle lines, expected ${e.steps.length}`,
      );
    for (const s of e.steps) {
      const o = lineAt(log, s.step);
      if (!o) {
        problems.push(`${log.leg} step ${s.step}: no oracle line`);
        continue;
      }
      compared++;
      const bad = (what: string, got: unknown, want: unknown) =>
        problems.push(
          `${log.leg} step ${s.step}: ${what} ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
        );
      if (o.frame !== s.settle_frame) bad("frame", o.frame, s.settle_frame);
      if (!eq(o.grid, { position: [0, 0], size: [1920, 1080] }))
        bad("grid", o.grid, "(0,0) 1920x1080");
      if (!eq(o.viewport.visible_size, [1920, 1080]))
        bad("visible size", o.viewport.visible_size, [1920, 1080]);
      if (o.cells.length !== e.cells.length)
        bad("cells", o.cells.length, e.cells.length);
      for (const c of e.cells) {
        const got = o.cells[c.cell];
        if (!got) continue;
        if (!eq(got.position, c.origin))
          bad(`cell ${c.cell} position`, got.position, c.origin);
        if (!eq(got.size, [640, 360]))
          bad(`cell ${c.cell} size`, got.size, [640, 360]);
        if (!eq(got.scene_global_position, c.origin))
          bad(
            `cell ${c.cell} Scene global position`,
            got.scene_global_position,
            c.origin,
          );
      }
    }
  }
  return { problems, compared };
}

/** Pure: the oracle reads back the presentation: font oversampling (1 at native, 0.5 at half,
 * vp.cpp:1071-1082), the window size, the stretch scale, and the root canvas transform per step. */
export function evaluateOversampling(
  e: Pick<Gate6HdExpected, "steps" | "presentations">,
  logs: readonly { pres: Presentation; log: HdOracleLog }[],
): { problems: string[]; table: Record<string, number[]> } {
  const problems: string[] = [];
  const table: Record<string, number[]> = {};
  for (const { pres, log } of logs) {
    const p = e.presentations[pres];
    const seen = new Set<number>();
    for (const s of e.steps) {
      const o = lineAt(log, s.step);
      if (!o) {
        problems.push(`${log.leg} step ${s.step}: no oracle line`);
        continue;
      }
      seen.add(o.oversampling);
      if (o.oversampling !== p.oversampling)
        problems.push(
          `${log.leg} step ${s.step}: oversampling ${o.oversampling} != ${p.oversampling}`,
        );
      if (JSON.stringify(o.viewport.window_size) !== JSON.stringify(p.size))
        problems.push(
          `${log.leg} step ${s.step}: window ${JSON.stringify(o.viewport.window_size)} != ${JSON.stringify(p.size)}`,
        );
      if (
        JSON.stringify(o.viewport.stretch_scale) !==
        JSON.stringify([p.scale, p.scale])
      )
        problems.push(
          `${log.leg} step ${s.step}: stretch ${JSON.stringify(o.viewport.stretch_scale)} != ${p.scale}`,
        );
      if (
        JSON.stringify(o.viewport.canvas_transform) !==
        JSON.stringify(s.canvas_transform)
      )
        problems.push(
          `${log.leg} step ${s.step}: canvas transform ${JSON.stringify(o.viewport.canvas_transform)} != ${JSON.stringify(s.canvas_transform)}`,
        );
    }
    table[log.leg] = [...seen];
  }
  return { problems, table };
}

/** Pure: every cell's state as the oracle reads it equals the model's cell view (scroll and the
 * floored content position, the HUD layer, sublayer and visibility, PB's value, SM's phase, tint
 * and shader hash, CM's blend mode, RT's layout and scroll, LE's focus), and the repeat's bytes
 * equal the reference's at each presentation. */
export function evaluateCellOracle(
  e: Pick<Gate6HdExpected, "steps">,
  logs: readonly HdOracleLog[],
  pairs: readonly [HdOracleLog, HdOracleLog][],
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  const near = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  const eq = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  for (const log of logs) {
    for (const s of e.steps) {
      const o = lineAt(log, s.step);
      if (!o) continue;
      s.cells.forEach((w, k) => {
        const c = o.cells[k];
        const bad = (what: string, got: unknown, want: unknown) =>
          problems.push(
            `${log.leg} step ${s.step} cell ${k}: ${what} ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
          );
        if (!c) {
          bad("cell", undefined, k);
          return;
        }
        compared++;
        if (c.scroll.v_scroll !== w.v_scroll)
          bad("v_scroll", c.scroll.v_scroll, w.v_scroll);
        if (!eq(c.scroll.content_position, w.content_position))
          bad(
            "content_position",
            c.scroll.content_position,
            w.content_position,
          );
        const hud = c.canvas_layers.find((l) => l.name === "HUD");
        if (!hud || hud.layer !== w.hud.layer || hud.visible !== w.hud.visible)
          bad("HUD layer/visible", hud, w.hud);
        if (!near(c.pb_value, w.pb_value))
          bad("pb_value", c.pb_value, w.pb_value);
        const phase = c.materials.SM.params.find((p) => p.name === "phase");
        const tint = c.materials.SM.params.find((p) => p.name === "tint");
        if (phase?.type !== "int" || phase.value !== w.sm.phase)
          bad("SM phase", phase, w.sm.phase);
        if (tint?.type !== "color" || !eq(tint.value, w.sm.tint))
          bad("SM tint", tint, w.sm.tint);
        if (c.materials.SM.shader_sha256 !== w.sm.shader_sha256)
          bad("SM shader", c.materials.SM.shader_sha256, w.sm.shader_sha256);
        if (c.materials.CM.blend_mode !== w.cm_blend_mode)
          bad("CM blend_mode", c.materials.CM.blend_mode, w.cm_blend_mode);
        if (!eq(c.rich_text.line_offsets, w.rich_text.line_offsets))
          bad(
            "RT line offsets",
            c.rich_text.line_offsets,
            w.rich_text.line_offsets,
          );
        if (c.rich_text.content_height !== w.rich_text.content_height)
          bad(
            "RT content height",
            c.rich_text.content_height,
            w.rich_text.content_height,
          );
        if (c.rich_text.v_scroll !== w.rich_text.v_scroll)
          bad("RT v_scroll", c.rich_text.v_scroll, w.rich_text.v_scroll);
        if (c.le_focus !== w.le_focus) bad("LE focus", c.le_focus, w.le_focus);
      });
    }
  }
  for (const [a, b] of pairs)
    if (a.text !== undefined && a.text !== b.text)
      problems.push(`${a.leg} and ${b.leg} oracle.jsonl differ`);
  return { problems, compared };
}

/** The HD oracle as the gate 6a atlas-parity check reads it (step and pages per line). */
export function asOracle6(log: HdOracleLog): OracleLog6 {
  return {
    leg: log.leg,
    path: log.path,
    text: log.text,
    lines: log.lines as unknown as OracleLine6[],
    problem: log.problem,
  };
}

// ---------------------------------------------------------------------------------------------
// The capture
// ---------------------------------------------------------------------------------------------

interface ViewportMeta {
  logical_size?: number[];
  stretch?: { mode?: string; aspect?: string };
  root_size_policy?: string;
  host_size_status?: string;
  host_window_size?: number[];
}

/** Pure: the native capture's session declares the HD project as it ran: logical 1920x1080,
 * `canvas_items` / `keep`, root-size policy enforce-min-size with the window grown to 1920x1080
 * (status match), and the host's final transform the identity (stretch scale 1 x the global
 * canvas transform), on both sinks. */
export function evaluateHdSession(
  recordings: readonly { label: string; recording: RecordingSummary }[],
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  let detail = "";
  for (const { label, recording } of recordings) {
    const v = (
      recording.session as unknown as { viewport?: ViewportMeta } | undefined
    )?.viewport;
    const want = {
      logical_size: [1920, 1080],
      stretch_mode: "canvas_items",
      stretch_aspect: "keep",
      root_size_policy: "enforce-min-size",
      host_size_status: "match",
      host_window_size: [1920, 1080],
    };
    const got = {
      logical_size: v?.logical_size,
      stretch_mode: v?.stretch?.mode,
      stretch_aspect: v?.stretch?.aspect,
      root_size_policy: v?.root_size_policy,
      host_size_status: v?.host_size_status,
      host_window_size: v?.host_window_size,
    };
    if (JSON.stringify(got) !== JSON.stringify(want))
      problems.push(
        `${label}: session viewport ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
      );
    const blocks = recording.session_blocks ?? [];
    const visible = blocks[2];
    const final = blocks[3];
    if (JSON.stringify(visible) !== JSON.stringify([0, 0, 1920, 1080]))
      problems.push(`${label}: host_visible_rect ${JSON.stringify(visible)}`);
    if (JSON.stringify(final) !== JSON.stringify([1, 0, 0, 1, 0, 0]))
      problems.push(
        `${label}: host_final_xform ${JSON.stringify(final)}, expected the identity`,
      );
    detail = `${JSON.stringify(got)}; host_final_xform ${JSON.stringify(final)}`;
  }
  return { problems, detail };
}

/** Pure: both sinks decode (validateRecording []), start at frame 1 and hold `quit`
 * transactions, as their end record says. */
export function evaluateHdRecordings(
  full: RecordingSummary,
  patch: RecordingSummary,
  quit: number,
): string[] {
  const problems: string[] = [];
  for (const [label, r] of [
    ["full", full],
    ["patch", patch],
  ] as const) {
    if (!r.present) {
      problems.push(`${label}: missing`);
      continue;
    }
    if (r.errors.length > 0)
      problems.push(`${label}: ${r.errors.slice(0, 3).join(" | ")}`);
    if (r.transactions[0]?.meta.frame !== 1)
      problems.push(`${label}: first frame ${r.transactions[0]?.meta.frame}`);
    if (r.transactions.length !== quit || r.end?.transactions !== quit)
      problems.push(
        `${label}: ${r.transactions.length} transactions (end ${r.end?.transactions}), expected ${quit}`,
      );
  }
  return problems;
}

/** Pure: no tie on any sink, and at frame 1 the root canvas holds Grid then the nine top_level
 * TLs at distinct draw indices (items made in _ready never tie, As built G6a). */
export function evaluateNoTiesHd(
  sinks: readonly { label: string; recording: RecordingSummary }[],
  ids: ReadonlyMap<string, number>,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  for (const { label, recording } of sinks)
    for (const t of recording.transactions) {
      if (t.meta.unsupported.some((u) => u.reason === "draw-index-tie"))
        problems.push(`${label} frame ${t.meta.frame}: a draw-index-tie entry`);
      const ties = drawIndexTies(t.meta);
      if (ties.length > 0)
        problems.push(
          `${label} frame ${t.meta.frame}: ${ties.length} tie(s), e.g. ${JSON.stringify(ties[0].members)}`,
        );
      if (problems.length > 6) break;
    }
  const first = sinks[0]?.recording.transactions[0];
  const root = first?.meta.canvases.find((c) => c.id === 1);
  const items = new Map(
    (first?.meta.items ?? []).map((i) => [i.id, i] as const),
  );
  const children = (root?.items ?? []).map(
    (id) => [id, items.get(id)?.draw_index] as const,
  );
  const want = ["Grid", ...[...Array(9).keys()].map((c) => `c${c}.TL`)].map(
    (n) => ids.get(n),
  );
  if (
    JSON.stringify(children.map(([id]) => id)) !== JSON.stringify(want) ||
    new Set(children.map(([, d]) => d)).size !== children.length
  )
    problems.push(
      `frame 1 root canvas children ${JSON.stringify(children)}, expected Grid and the nine TLs ${JSON.stringify(want)} at distinct draw indices`,
    );
  return {
    problems,
    detail: `frame ${first?.meta.frame}: root canvas ${children.map(([id, d]) => `${id}@${d}`).join(" ")}`,
  };
}

/** Pure: a leg's steps.jsonl lists steps 0..11 at the model's applied and settle frames. */
export function evaluateStepLogHd(
  e: Pick<Gate6HdExpected, "steps">,
  leg: string,
  got: StepLine[] | undefined,
): string[] {
  const want = e.steps.map((s) => ({
    step: s.step,
    applied_frame: s.applied_frame,
    settle_frame: s.settle_frame,
  }));
  return JSON.stringify(got) === JSON.stringify(want)
    ? []
    : [`${leg} steps.jsonl ${JSON.stringify(got)?.slice(0, 120)} != expected`];
}

/** The capture's costs at HD: bytes per transaction on each sink (record length, prefix
 * included), and at the last settle step the items, commands and LA8 atlas pages (payload bytes). */
export function hdCosts(
  full: Pick<Wire5, "transactions">,
  patch: Pick<Wire5, "transactions">,
  lastSettle: number,
): string {
  const stats = (w: Pick<Wire5, "transactions">) => {
    const b = w.transactions.map((t) => t.bytes);
    const total = b.reduce((s, v) => s + v, 0);
    return `${w.transactions.length} tx, ${total} B, mean ${Math.round(total / Math.max(1, b.length))} B, max ${Math.max(0, ...b)} B`;
  };
  const tx = full.transactions.find((t) => t.frame === lastSettle);
  const atlas = (tx?.state.textures ?? []).filter(
    (t) => t.kind === "image" && t.status === "ok" && t.format === "LA8",
  );
  const atlasBytes = atlas.reduce((s, t) => s + t.payload_bytes, 0);
  const items = tx?.state.items.length ?? 0;
  const commands = (tx?.state.items ?? []).reduce(
    (s, i) => s + i.commands.length,
    0,
  );
  return `full sink: ${stats(full)}; patch sink: ${stats(patch)}; at frame ${lastSettle}: ${items} items, ${commands} commands, ${atlas.length} LA8 atlas pages (${atlas.map((t) => `${t.width}x${t.height}`).join(" ")}, ${atlasBytes} payload B)`;
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export const G6H_DIR = "hd";

export interface G6hLegEntry {
  group: "g6h";
  expected_class: string;
  result_class: string | null;
  pixel_verdict?: string;
  expected_pixel_verdict?: string;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface Gate6hResult {
  checks: Gate6Check[];
  legs: Record<string, G6hLegEntry>;
  checkpoints: Gate6Checkpoint[];
  budgets: Record<string, RegionBudget6[]>;
  freshness: Record<string, Record<string, string[]>>;
  mismatch_tables: Record<string, Record<string, string[]>>;
  census: Record<string, string>;
}

const REFERENCE_LEGS: { leg: string; dir: string; pres: Presentation }[] = [
  { leg: "reference-hd-native", dir: "reference-native", pres: "native" },
  {
    leg: "reference-hd-native-repeat",
    dir: "reference-native-repeat",
    pres: "native",
  },
  {
    leg: "reference-hd-native-armed",
    dir: "reference-native-armed",
    pres: "native",
  },
  { leg: "reference-hd-half", dir: "reference-half", pres: "half" },
  {
    leg: "reference-hd-half-repeat",
    dir: "reference-half-repeat",
    pres: "half",
  },
];

const RECEIVER_LEGS: { leg: string; dir: string; sink: string }[] = [
  { leg: "receiver-hd-native", dir: "receiver-native", sink: RECORDING_NAME },
  {
    leg: "receiver-hd-native-patch",
    dir: "receiver-native-patch",
    sink: PATCH_RECORDING_NAME,
  },
];

export async function loadFrame(path: string): Promise<Frame6 | null> {
  const png = await decodePngRgba(path);
  return png ? { width: png.width, height: png.height, rgba: png.data } : null;
}

export async function requestedSeqs(dir: string): Promise<number[]> {
  const text = (await readTextOrUndefined(join(dir, "env.txt"))) ?? "";
  const line = text
    .split("\n")
    .find((l) => l.startsWith("RS_RECEIVER_SHOT_SEQS="));
  return line
    ? line
        .slice("RS_RECEIVER_SHOT_SEQS=".length)
        .split(",")
        .filter((s) => s !== "")
        .map(Number)
    : [];
}

export async function shotFiles(
  dir: string,
  seqs: readonly number[],
): Promise<number[]> {
  const out: number[] = [];
  for (const s of seqs)
    if (await fileExists(join(dir, "shots", `seq-${s}.png`))) out.push(s);
  return out;
}

export async function runGate6h(
  out: string,
  e: Gate6HdExpected,
): Promise<Gate6hResult> {
  const checks: Gate6Check[] = [];
  const legs: Record<string, G6hLegEntry> = {};
  const checkpoints: Gate6Checkpoint[] = [];
  const budgets: Record<string, RegionBudget6[]> = {};
  const freshness: Record<string, Record<string, string[]>> = {};
  const mismatchTables: Record<string, Record<string, string[]>> = {};
  const census: Record<string, string> = {};
  const D = join(out, G6H_DIR);
  const fixture = join("fixtures", "gate6-hd", "expected.json");

  // The capture: class, session, sinks, ties, costs.
  const cap = await evaluateCapture(D, {
    legDir: "capture-native",
    expectedClass: wantedClass(e.unsupported),
  });
  const wireFull = await loadWire5(join(D, "capture-native", RECORDING_NAME));
  const wirePatch = await loadWire5(
    join(D, "capture-native", PATCH_RECORDING_NAME),
  );
  {
    const pairs = unsupportedPairs(cap.full);
    const problems = evaluateUnsupportedClass(cap, pairs, e.unsupported);
    checks.push(
      check(
        "leg-class-capture-hd-native",
        `the capture-hd-native leg classifies ${wantedClass(e.unsupported)} on render-stream/6 (the nine HUD CanvasLayers at distinct layers 1 + c are carried: no extra-canvas, no stacking tie)${e.unsupported.length > 0 ? ` with exactly ${e.unsupported.map((w) => w.join("/")).join(", ")}` : ""}: armed, stream closed, both sinks valid and equivalent, no capture failure`,
        problems,
        `${cap.result_class}: ${pairs.join(", ") || "nothing typed"}`,
        cap.artifacts,
      ),
    );
    legs["capture-hd-native"] = {
      group: "g6h",
      expected_class: wantedClass(e.unsupported),
      result_class: cap.result_class,
      reasons: cap.reasons,
      exit_code: cap.exit_code,
      artifacts: cap.artifacts,
    };
    const ses = evaluateHdSession([
      { label: "full", recording: cap.full },
      { label: "patch", recording: cap.patch },
    ]);
    checks.push(
      check(
        "hd-session",
        "both sinks' session declares the HD project as it ran headless: logical 1920x1080, stretch canvas_items / keep, root-size policy enforce-min-size with host_window_size 1920x1080 and host_size_status match (D4: under canvas_items, enforce-min-size is presentation at the logical size), host_visible_rect (0,0,1920,1080) and host_final_xform the identity (stretch scale 1)",
        ses.problems,
        ses.detail,
        [cap.full.path, cap.patch.path],
      ),
    );
    const rec = evaluateHdRecordings(cap.full, cap.patch, e.quit_frame_default);
    const patchFull = checkPatchResolvesToFull(cap.full, cap.patch);
    checks.push(
      check(
        "hd-recordings",
        `both capture sinks decode (validateRecording []), start at frame 1 and hold the file timeline's ${e.quit_frame_default} transactions, and the patch sink resolves to the full sink at every frame, floats bit for bit`,
        [...rec, ...(patchFull.passed ? [] : [patchFull.detail])].slice(0, 8),
        `full ${cap.full.bytes} B, patch ${cap.patch.bytes} B; ${patchFull.detail}`,
        [cap.full.path, cap.patch.path],
      ),
    );
    const names = nameIds6(wireFull.transactions, [
      ...e.creation_order,
      ...e.created_later.map((c) => c.name),
    ]);
    const t = evaluateNoTiesHd(
      [
        { label: "full", recording: cap.full },
        { label: "patch", recording: cap.patch },
      ],
      names.ids,
    );
    checks.push(
      check(
        "hd-draw-index-tie",
        "no draw-index tie anywhere on either sink, and at frame 1 the root canvas holds exactly Grid and the nine top_level TLs at distinct draw indices (Q6e's predicted Grid/TL tie does not occur: every top-level item is made in _ready, As built G6a)",
        [...names.problems, ...t.problems].slice(0, 8),
        t.detail,
        [cap.full.path],
      ),
    );
  }
  const stepProblems: string[] = [];
  stepProblems.push(
    ...evaluateStepLogHd(
      e,
      "capture-hd-native",
      parseStepLog(
        await readTextOrUndefined(join(D, "capture-native", "steps.jsonl")),
      ),
    ),
  );
  for (const r of REFERENCE_LEGS)
    stepProblems.push(
      ...evaluateStepLogHd(
        e,
        r.leg,
        parseStepLog(await readTextOrUndefined(join(D, r.dir, "steps.jsonl"))),
      ),
    );
  checks.push(
    check(
      "hd-step-log",
      "the HD capture's and every HD reference's steps.jsonl list steps 0..11 at frame 1 and 1 + 10k, settled 7 frames later, every cell applying each step in the same frame",
      stepProblems,
      "steps 0..11 at the model's frames on every leg",
      [],
    ),
  );

  // The oracle: grid, oversampling, cells, atlas.
  const oNative = await loadHdOracle(
    join(D, "reference-native"),
    "reference-hd-native",
  );
  const oNativeRep = await loadHdOracle(
    join(D, "reference-native-repeat"),
    "reference-hd-native-repeat",
  );
  const oHalf = await loadHdOracle(
    join(D, "reference-half"),
    "reference-hd-half",
  );
  const oHalfRep = await loadHdOracle(
    join(D, "reference-half-repeat"),
    "reference-hd-half-repeat",
  );
  const oracleLogs = [oNative, oNativeRep, oHalf, oHalfRep];
  {
    const g = evaluateGridLayout(e, oracleLogs);
    checks.push(
      check(
        "hd-grid-layout",
        "at every settle step of both presentations (reference and repeat), the oracle reads the GridContainer at (0,0) 1920x1080, the visible rect at the logical 1920x1080, and cell c's Cell Control at (640 (c mod 3), 360 floor(c/3)) 640x360 with its Scene at the same global position: the grid lays out against the logical size at either presentation",
        g.problems.slice(0, 10),
        `${g.compared} oracle lines`,
        oracleLogs.map((l) => l.path),
      ),
    );
    const o = evaluateOversampling(e, [
      { pres: "native", log: oNative },
      { pres: "native", log: oNativeRep },
      { pres: "half", log: oHalf },
      { pres: "half", log: oHalfRep },
    ]);
    checks.push(
      check(
        "hd-oversampling-reference",
        "the oracle reads font oversampling 1.0, window 1920x1080 and stretch scale 1 at native, and 0.5, 960x540 and 0.5 at half, at every settle step, with the root canvas transform of the step (identity, (8,4) from step 10): the host-side quantities Q1b names follow the presentation",
        o.problems.slice(0, 10),
        Object.entries(o.table)
          .map(([k, v]) => `${k}: ${v.join(",")}`)
          .join("; "),
        oracleLogs.map((l) => l.path),
      ),
    );
    const c = evaluateCellOracle(e, oracleLogs, [
      [oNative, oNativeRep],
      [oHalf, oHalfRep],
    ]);
    checks.push(
      check(
        "hd-cell-oracle",
        "every cell's state the oracle reads back at every settle step, at both presentations, equals the model's cell view: SC's v_scroll and floored content position, the HUD layer (1 + c, -1 - c at step 9) and visibility, PB's value and SM's phase at the cell's phase 7c (D6), SM's tint and shader hash, CM's blend mode, the RichTextLabel's line offsets and scroll, and LineEdit focus on cell 8 only; each repeat's oracle.jsonl equals its reference's byte for byte",
        c.problems.slice(0, 10),
        `${c.compared} cell lines`,
        oracleLogs.map((l) => l.path),
      ),
    );
  }
  {
    const view = {
      steps: e.steps,
      hook_census: { atlas_format: "LA8" },
    } as unknown as Pick<Gate6Expected, "steps" | "hook_census">;
    const a = evaluateAtlasParity6(view, asOracle6(oNative), wireFull);
    const b = evaluateAtlasParity6(view, asOracle6(oNative), wirePatch);
    checks.push(
      check(
        "hd-atlas-parity",
        "at native, at every settle step, each atlas page the reference's oracle reads back is the hash of exactly one ok image texture in the capture's settle transaction and every ok LA8 image there is an oracle page, on both sinks: a headless host at the logical window size rasterizes the same glyph atlases as the rendered 1920x1080 reference (oversampling 1); half is G6b's",
        [
          ...(wireFull.error ? [`full: ${wireFull.error}`] : []),
          ...a.problems,
          ...b.problems.map((p) => `patch: ${p}`),
        ].slice(0, 10),
        `${a.pages} page cells (${Object.entries(a.table)
          .map(([k, n]) => `${k}:${n}`)
          .join(" ")})`,
        [oNative.path, wireFull.path, wirePatch.path],
      ),
    );
    census["capture-hd-native"] = hdCosts(
      wireFull,
      wirePatch,
      e.steps[e.steps.length - 1].settle_frame,
    );
  }

  // Shots, one at a time: the model at both presentations, the references, the receivers.
  const recvSeqs = new Map<string, Map<string, number>>();
  for (const r of RECEIVER_LEGS) {
    const rec = r.sink === PATCH_RECORDING_NAME ? cap.patch : cap.full;
    recvSeqs.set(
      r.leg,
      shotSeqs(e.shots as unknown as Gate6Shot[], rec.transactions),
    );
  }
  const selfProblems: string[] = [];
  const imageProblems: Record<Presentation, string[]> = {
    native: [],
    half: [],
  };
  const presenceProblems: string[] = [];
  let presenceShapes = 0;
  const freshProblems: string[] = [];
  const freshTables: Record<string, Record<string, string[]>> = {
    "reference-hd-native": {},
    "reference-hd-half": {},
  };
  const budgetCells: Record<string, Map<string, RegionBudget6>> = {
    "reference-repeat-native": new Map(),
    "reference-repeat-half": new Map(),
    "reference-armed-native": new Map(),
  };
  const budgetProblems: Record<string, string[]> = {
    "reference-repeat-native": [],
    "reference-repeat-half": [],
    "reference-armed-native": [],
  };
  const recvDiffs: Record<
    string,
    { shot: string; diff: FrameDiffHd | null }[]
  > = {};
  for (const r of RECEIVER_LEGS) recvDiffs[r.leg] = [];
  const exclude = excludedRegionsHd(e);
  const prev: Record<
    Presentation,
    {
      regions: Record<string, Box>;
      raster: Gate5Raster;
      content: Record<string, string>;
      ref: Frame6 | null;
    } | null
  > = { native: null, half: null };
  for (const shot of e.shots) {
    const content = undecidedContentHd(e, shot);
    for (const pres of PRESENTATIONS) {
      const p = e.presentations[pres];
      const raster = rasterOfShotHd(e, shot, pres);
      const ri = regionIndexHd(shot.regions, p.size[0], p.size[1], p.scale);
      selfProblems.push(...evaluateRasterOutsideHd(e, shot, raster, ri, pres));
      const refLeg = REFERENCE_LEGS.filter((l) => l.pres === pres);
      const frames = new Map<string, Frame6 | null>();
      for (const l of refLeg)
        frames.set(
          l.leg,
          await loadFrame(join(D, l.dir, "shots", `${shot.id}.png`)),
        );
      const refName = `reference-hd-${pres}`;
      const ref = frames.get(refName) ?? null;
      const img = imageAgainstModelHd(
        refName,
        shot.id,
        ref,
        raster,
        ri,
        join(D, `reference-${pres}`, "shots", `${shot.id}.png`),
      );
      checkpoints.push(img.checkpoint);
      if (img.problem) imageProblems[pres].push(img.problem);
      const pr = presenceHd(refName, shot.id, ref, raster);
      presenceProblems.push(...pr.problems);
      presenceShapes += pr.shapes;
      // Budgets: repeat at both presentations, armed at native.
      for (const [key, leg] of [
        [`reference-repeat-${pres}`, `${refName}-repeat`],
        ...(pres === "native"
          ? [["reference-armed-native", "reference-hd-native-armed"]]
          : []),
      ] as const) {
        const other = frames.get(leg) ?? null;
        if (
          !ref ||
          !other ||
          ref.width !== other.width ||
          ref.height !== other.height
        ) {
          budgetProblems[key].push(
            `${shot.id}: ${!ref ? refName : leg} shot missing`,
          );
          continue;
        }
        const n = accumulateBudgetHd(budgetCells[key], ref, other, raster, ri);
        if (n > 0)
          budgetProblems[key].push(
            `${shot.id}: ${n} pixels differ between ${refName} and ${leg}`,
          );
      }
      // Receivers at native.
      if (pres === "native")
        for (const r of RECEIVER_LEGS) {
          const seq = recvSeqs.get(r.leg)?.get(shot.id);
          const got =
            seq === undefined
              ? null
              : await loadFrame(join(D, r.dir, "shots", `seq-${seq}.png`));
          const diff =
            ref && got && ref.width === got.width && ref.height === got.height
              ? diffFramesHd(ref, got, ri, exclude)
              : null;
          recvDiffs[r.leg].push({ shot: shot.id, diff });
        }
      // Freshness between consecutive settle shots: the model's (self-consistency) and the
      // reference's (pixels).
      if (shot.kind === "settle") {
        const before = prev[pres];
        const k = shot.step;
        if (before) {
          const fresh = e.steps[k].fresh;
          const modelChanged = changedRegionsHd(
            before,
            { regions: shot.regions, raster, content },
            p.scale,
          );
          selfProblems.push(
            ...freshnessProblems(`model ${pres}`, k, fresh, modelChanged),
          );
          if (before.ref && ref) {
            const refChanged = changedRegionsFrames(
              before.ref,
              ref,
              before.regions,
              shot.regions,
              p.scale,
            );
            freshTables[refName][String(k)] = [...refChanged].sort();
            freshProblems.push(
              ...freshnessProblems(refName, k, fresh, refChanged),
            );
          } else freshProblems.push(`${refName} step ${k}: shot missing`);
        }
        prev[pres] = { regions: shot.regions, raster, content, ref };
      }
    }
  }

  checks.push(
    check(
      "hd-expected-self-consistent",
      "fixtures/gate6-hd/expected.json obeys its rules: 1920x1080 presented at 1920x1080 (scale 1, oversampling 1) and 960x540 (0.5, 0.5); nine cells on the 3x3 grid with phase 7c, TEXA offset 100c and distinct HUD layers 1 + c (-1 - c at step 9); LineEdit focus on cell 8 only; steps 0..11 at 1 + 10k with distinct markers; the fifteen shots; every region inside the viewport, pairwise disjoint and on even edges; every scene colour and texel on the 0.2 grid; SM's phase and PB's value at frame + 7c as D6 gives them; and in both presentations' rasters only BG panels, the clear colour or band outside the regions, each cell's bottom strip clear outside TL before step 10, and `fresh` as the rasters and the undecided content say",
      [...evaluateExpectedStaticHd(e).problems, ...selfProblems].slice(0, 10),
      evaluateExpectedStaticHd(e).detail,
      [fixture],
    ),
  );
  for (const pres of PRESENTATIONS) {
    const cps = checkpoints.filter((c) => c.leg === `reference-hd-${pres}`);
    const compared = cps.reduce((n, c) => n + (c.compared ?? 0), 0);
    const used = cps.reduce((n, c) => n + (c.delta1_used ?? 0), 0);
    checks.push(
      check(
        `hd-expected-image-reference-${pres}`,
        pres === "native"
          ? "every reference-hd-native shot (twelve settle shots and frames 13, 53, 93, 1920x1080) equals the model on every decided pixel of every cell: exact where the raster is exact, within 1 where it allows delta 1; band and undecided pixels (text, RT) excluded, never relaxed"
          : "every reference-hd-half shot (960x540, stretch 0.5) equals the half model on every decided pixel of every cell: the scene under scale(0.5) with the StyleBoxFlat feather at aa_size / 0.5; a pixel is decided by its centre (an edge through a pixel centre leaves it undecided, an even logical edge decides it), exact or within 1 as the raster allows; band and undecided pixels excluded, never relaxed",
        imageProblems[pres].slice(0, 10),
        `${compared} decided pixels match over ${cps.length} shots (${used} use delta 1)`,
        [join(D, `reference-${pres}`, "shots")],
      ),
    );
  }
  checks.push(
    check(
      "hd-presence-reference",
      "every modelled shape of every cell of every reference shot, at both presentations, covers at least half its area with pixels that differ from what lies beneath it in the model",
      presenceProblems.slice(0, 8),
      `${presenceShapes} shape-shots present`,
      [
        join(D, "reference-native", "shots"),
        join(D, "reference-half", "shots"),
      ],
    ),
  );
  freshness["reference-hd-native"] = freshTables["reference-hd-native"];
  freshness["reference-hd-half"] = freshTables["reference-hd-half"];
  checks.push(
    check(
      "hd-freshness-reference",
      "between consecutive settle shots of reference-hd-native and reference-hd-half, each cell's region pixels change exactly when expected.json says fresh (the scene's own step table in every cell, the continuous regions at the cell's phase)",
      freshProblems.slice(0, 10),
      `native ${Object.keys(freshTables["reference-hd-native"]).length} steps, half ${Object.keys(freshTables["reference-hd-half"]).length} steps`,
      [
        join(D, "reference-native", "shots"),
        join(D, "reference-half", "shots"),
      ],
    ),
  );
  for (const [key, cells] of Object.entries(budgetCells))
    budgets[`hd-${key}`] = [...cells.values()];
  for (const pres of PRESENTATIONS) {
    const key = `reference-repeat-${pres}`;
    const total = [...budgetCells[key].values()].reduce(
      (n, b) => n + b.pixels,
      0,
    );
    checks.push(
      check(
        `hd-reference-repeat-budget-${pres}`,
        `reference-hd-${pres}-repeat equals reference-hd-${pres} on every pixel of every shot, per region and pixel class (the receiver budget is this measurement: 0, Q6g)`,
        budgetProblems[key].slice(0, 6),
        `0 of ${total} pixel-shots differ`,
        [join(D, `reference-${pres}-repeat`, "shots")],
      ),
    );
  }
  {
    const key = "reference-armed-native";
    const total = [...budgetCells[key].values()].reduce(
      (n, b) => n + b.pixels,
      0,
    );
    checks.push(
      check(
        "hd-armed-transparent",
        "reference-hd-native-armed (the capture extension armed with a full-sink stream in the rendered 1920x1080 reference) equals reference-hd-native on every pixel of every shot",
        budgetProblems[key].slice(0, 6),
        `0 of ${total} pixel-shots differ`,
        [join(D, "reference-native-armed", "shots")],
      ),
    );
  }

  // Receivers.
  const vsRef: string[] = [];
  const vsDetail: string[] = [];
  for (const r of RECEIVER_LEGS) {
    const dir = join(D, r.dir);
    const recording = r.sink === PATCH_RECORDING_NAME ? cap.patch : cap.full;
    const seqs = recvSeqs.get(r.leg) ?? new Map<string, number>();
    const diffs = recvDiffs[r.leg];
    const applied = await readJson<AppliedJson>(join(dir, "applied.json"));
    const requested = await requestedSeqs(dir);
    const cps: Checkpoint[] = diffs.map((d) => ({
      step: Number(d.shot.replace(/^\D+/, "")),
      settle_frame: e.shots.find((s) => s.id === d.shot)?.frame ?? 0,
      seq: seqs.get(d.shot) ?? null,
      reference_png: join(D, "reference-native", "shots", `${d.shot}.png`),
      receiver_png: join(dir, "shots", `seq-${seqs.get(d.shot)}.png`),
      diff_png: null,
      mismatched_pixels: d.diff?.mismatched ?? null,
      max_channel_delta: d.diff?.max_delta ?? null,
      regions: [],
    }));
    const cls = classifyLeg({
      captureResult: cap.captureResult,
      recording,
      receiver: {
        applied,
        requestedShotSeqs: requested,
        shotFiles: await shotFiles(dir, requested),
      },
      checkpoints: cps,
    });
    const problems = evaluateUnsupportedClass(
      cls,
      unsupportedPairs(recording),
      e.unsupported,
    );
    const ap = appliedPairs(applied);
    const wantAp = e.unsupported
      .map(([op, reason]) => `${op}/${reason}`)
      .sort();
    if (JSON.stringify(ap) !== JSON.stringify(wantAp))
      problems.push(
        `applied.json unsupported ${JSON.stringify(ap)} != ${JSON.stringify(wantAp)}`,
      );
    const pv = pixelVerdictHd(diffs);
    problems.push(...pv.problems);
    mismatchTables[r.leg] = pv.table;
    checks.push(
      check(
        `leg-class-${r.leg}`,
        `the ${r.leg} leg (rendered 1920x1080 receiver on capture-native/${r.sink}) classifies ${wantedClass(e.unsupported)} on render-stream/6 (the capture's reasons, if any, also in applied.json, and no receiver-typed entry), applied every seq, and every pixel of every shot, the nine HU regions included, equals reference-hd-native`,
        problems.slice(0, 8),
        `${cls.result_class}, pixels ${pv.verdict}`,
        [join(dir, "applied.json"), join(dir, "shots")],
      ),
    );
    legs[r.leg] = {
      group: "g6h",
      expected_class: wantedClass(e.unsupported),
      result_class: cls.result_class,
      pixel_verdict: pv.verdict,
      expected_pixel_verdict: "success",
      reasons: cls.reasons,
      exit_code: await readExitCode(dir),
      artifacts: [join(dir, "applied.json"), join(dir, "shots")],
    };
    vsRef.push(...pv.problems.map((p) => `${r.leg} ${p}`));
    vsDetail.push(
      `${r.leg} ${diffs.reduce((n, d) => n + (d.diff?.compared ?? 0), 0)}`,
    );
  }
  checks.push(
    check(
      "hd-receiver-vs-reference",
      "receiver-hd-native and -patch: every pixel of every shot (settle and intermediate, 1920x1080) equals reference-hd-native's, raw per channel with alpha, the nine HU regions included (the HUD CanvasLayers are carried and replayed since G6b, render-stream/6); budget 0 (Q6g)",
      vsRef.slice(0, 10),
      `pixels compared: ${vsDetail.join(", ")}`,
      RECEIVER_LEGS.map((r) => join(D, r.dir, "shots")),
    ),
  );
  return {
    checks,
    legs,
    checkpoints,
    budgets,
    freshness,
    mismatch_tables: mismatchTables,
    census,
  };
}
