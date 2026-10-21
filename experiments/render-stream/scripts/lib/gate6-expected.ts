// Types and pure helpers for fixtures/gate6-scene/expected.json (render-stream-gate6-expected/1,
// protocol/gate6-design.md "Q6f"), written by fixtures/gate6-scene/make_expected.py. No I/O, no
// Godot, no capture evidence. The coverage model is gate 5's (lib/gate5-expected.ts), rasterized
// by lib/geometry-raster.ts, plus gate 6's undecided boxes (text, the RichTextLabel, RF).

import type {
  Affine,
  Box,
  Gate5Item,
  Gate5Op,
  Gate5Texture,
  Rgba8,
} from "./gate5-expected";
import {
  type Gate5Raster,
  rasterizeItems,
  type UndecidedShape,
} from "./geometry-raster";

export type Gate6Op = Gate5Op | UndecidedShape;

/** One shot of a reference leg: a settle frame (step-<k>.png) or an intermediate frame
 * (frame-<f>.png), with the regions in force and every item in paint order. */
export interface Gate6Shot {
  id: string;
  kind: "settle" | "mid";
  frame: number;
  /** the step in force at the frame */
  step: number;
  regions: Record<string, Box>;
  items: Gate5Item[];
}

export interface Gate6OracleView {
  oversampling: number;
  v_scroll: number;
  content_position: [number, number];
  hud: { layer: number; visible: boolean };
  pb_value: number;
  sm: { phase: number; tint: number[]; shader_sha256: string };
  /** CanvasItemMaterial.BlendMode: 1 add, 2 sub */
  cm_blend_mode: number;
}

export interface Gate6Step {
  step: number;
  applied_frame: number;
  settle_frame: number;
  marker_rgba8: Rgba8;
  canvas_transform: Affine;
  /** per region: its modelled content differs from the previous step's */
  fresh: Record<string, boolean>;
  /** what scene_oracle.gd must read back at the settle frame */
  oracle: Gate6OracleView;
}

export interface Gate6Variant {
  creation_order: string[];
  regions: Record<string, Box>;
  class: Record<string, "exact" | "undecided">;
  shots: Gate6Shot[];
  steps: Gate6Step[];
}

export interface Gate6Prediction {
  frame?: number;
  op?: string;
  /** shot id -> the regions (and "BG") where the leg's receiver differs from the reference */
  shots: Record<string, string[]>;
}

export interface Gate6Census {
  textures: {
    frame: number;
    op: string;
    texture: string;
    hash: string | null;
  }[];
  engine_textures: {
    frame: number;
    op: string;
    format: string;
    width: number;
    height: number;
  }[];
  atlas_format: string;
  mesh: {
    create_frame: number;
    vertex_count: number;
    index_count: number;
    region_update_frames: [number, number];
  };
  sm: {
    shader_sha256: string;
    code_bytes: number;
    param_sets: [number, string][];
  };
  cm: { shaders: [number, string][] };
  canvas: {
    canvas_create: number;
    viewport_attach_canvas: number;
    viewport_set_canvas_transform: number;
    hud_hidden_frames: [number, number];
  };
  /** `animate` (Q6d): [frame, content name, GRT1 sha256] of TEXA's in-place updates */
  animate_texa: [number, string, string][];
}

export interface Gate6Expected extends Gate6Variant {
  schema: "render-stream-gate6-expected/1";
  fixture: string;
  viewport: [number, number];
  clear_rgba8: Rgba8;
  start_frame_default: number;
  step_frames_default: number;
  settle_offset: number;
  quit_frame_default: number;
  capture_quit_frame: number;
  last_step: number;
  mid_frames: number[];
  time_offset_frames: number;
  measured: {
    rt_line_h: number;
    row_label_h_max: number;
    text_advance_bound: number;
  };
  exact_edge_px: number;
  created_later: { name: string; step: number }[];
  freed: { name: string; step: number }[];
  hidden_items: string[];
  marker_rect: [number, number, number, number];
  textures: Record<string, Gate5Texture>;
  texture_hashes: Record<string, string>;
  hook_census: Gate6Census;
  draw_index_ties: unknown[];
  scroll: {
    step: number;
    v_scroll: number;
    content_offset: [number, number];
    scissor: Box;
    rt_scroll: number;
  }[];
  pb_redraw_frames: number[];
  op_lists: Record<string, Gate6Op[]>;
  variants: {
    refused: Gate6Variant & { unsupported: [string, string][] };
  };
  unsupported: [string, string][];
  predictions: Record<string, Gate6Prediction>;
}

/** The refused variant as a whole view of its own (shared constants and op lists). */
export function refusedView(e: Gate6Expected): Gate6Expected {
  const v = e.variants.refused;
  return {
    ...e,
    creation_order: v.creation_order,
    regions: v.regions,
    class: v.class,
    shots: v.shots,
    steps: v.steps,
    unsupported: v.unsupported,
  };
}

/** The expected frame of one shot. */
export function rasterOfShot(e: Gate6Expected, shot: Gate6Shot): Gate5Raster {
  return rasterizeItems({
    viewport: e.viewport,
    clear: e.clear_rgba8,
    textures: e.textures,
    opLists: e.op_lists,
    items: shot.items,
    exactEdgePx: e.exact_edge_px,
  });
}

/** One raster per shot id, computed once per checker run. */
export function rastersOf6(
  e: Pick<Gate6Expected, "shots"> & Gate6Expected,
): Map<string, Gate5Raster> {
  const out = new Map<string, Gate5Raster>();
  for (const s of e.shots) out.set(s.id, rasterOfShot(e, s));
  return out;
}

/** The region holding pixel (x, y) among `regions`, or "BG". */
export function regionOf6(
  regions: Record<string, Box>,
  x: number,
  y: number,
): string {
  for (const [name, r] of Object.entries(regions))
    if (x >= r[0] && x < r[2] && y >= r[1] && y < r[3]) return name;
  return "BG";
}

/** Per pixel, its region name, for one shot. */
export function regionMap(
  regions: Record<string, Box>,
  width: number,
  height: number,
): string[] {
  const out = new Array<string>(width * height);
  // GRT4b: regionOf6's loop with its Object.entries() taken once per map, not once per pixel.
  const entries = Object.entries(regions);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let name = "BG";
      for (const [n, r] of entries)
        if (x >= r[0] && x < r[2] && y >= r[1] && y < r[3]) {
          name = n;
          break;
        }
      out[y * width + x] = name;
    }
  return out;
}

/** The shot file a reference leg writes for a shot. */
export function referenceShotFile(shot: Pick<Gate6Shot, "id">): string {
  return `${shot.id}.png`;
}

/** The undecided boxes' content per region of one shot (freshness of undecided regions). */
export function undecidedContent(
  e: Pick<Gate6Expected, "op_lists">,
  shot: Gate6Shot,
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
