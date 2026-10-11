// Types and pure helpers for fixtures/gate55-cim/expected.json (render-stream-gate55-expected/1,
// protocol/gate5_5-design.md "Q6d"), written by fixtures/gate55-cim/make_expected.py. No I/O, no
// Godot, no capture evidence. Each variant (`base`, `modulate`) is a gate 5 scene of its own:
// `asGate5` views it as a Gate5Expected so gate 5's image, presence, freshness and leg checks and
// lib/geometry-raster.ts (with its blend modes) apply unchanged.

import type {
  Box,
  Gate5Expected,
  Gate5ExpectedStep,
  Gate5Op,
  Rgba,
  Rgba8,
} from "./gate5-expected";
import { type Gate5Raster, rasterizeItems } from "./geometry-raster";

export const GATE55_VARIANTS = ["base", "modulate"] as const;
export type Gate55Variant = (typeof GATE55_VARIANTS)[number];

/** One RenderingServer material call of make_expected.py's CimSim (ids are its own counters). */
export interface Gate55RsCall {
  call: string;
  [arg: string]: unknown;
}

/** A fixture-level call (node, property, exact value). */
export interface Gate55FixtureCall {
  node: string | null;
  property: string;
  value: unknown;
}

export interface Gate55Step extends Gate5ExpectedStep {
  /** the marker as it appears after the canvas modulate */
  marker_shown_rgba8: Rgba8;
  canvas_modulate: Rgba;
  material_calls: Gate55FixtureCall[];
  rs_material_calls: Gate55RsCall[];
  /** per RenderingServer method (free split as free:shader / free:material), this step's calls */
  census: Record<string, number>;
  /** per item with its own CanvasItemMaterial: the shader's builtin descriptor (D7) */
  builtin: Record<
    string,
    { blend_mode: string; light_mode: string; particles_animation: boolean }
  >;
  /** per item drawing with a material (inherited included): [blend, light] */
  effective: Record<string, [string, string]>;
  /** items a pre-/5 capture types `canvas_item_set_material`/`unsupported-state` */
  typed_entries: string[];
  /** [x, y, r, g, b, a, delta]: one pixel per rect cell of every fresh region */
  probes: number[][];
}

export interface Gate55VariantExpected {
  creation_order: string[];
  steps: Gate55Step[];
}

export interface Gate55Prediction {
  frame?: number;
  op?: string;
  variant?: string;
  regions: Record<string, number[]>;
}

export interface Gate55Expected {
  schema: "render-stream-gate55-expected/1";
  fixture: string;
  viewport: [number, number];
  clear_rgba8: Rgba8;
  target_alpha_bits: number;
  start_frame_default: number;
  step_frames_default: number;
  settle_offset: number;
  quit_frame_default: number;
  last_step: number;
  regions: Record<string, Box>;
  marker_rect: [number, number, number, number];
  exact_edge_px: number;
  /** material ops the record hooks (counts only) before calibrator 8 */
  hooked_before_calibrator8: string[];
  /** material ops only calibrator 8 hooks (G55a) */
  calibrator8_ops: string[];
  /** the ops a pre-/5 capture types `unsupported` */
  typed_ops: string[];
  /** per variant, RenderingServer calls per method over the run (teardown excluded) */
  hook_census: Record<Gate55Variant, Record<string, number>>;
  op_lists: Record<string, Gate5Op[]>;
  variants: Record<Gate55Variant, Gate55VariantExpected>;
  predictions: Record<string, Gate55Prediction>;
}

/** The variant's scene as a Gate5Expected (gate 5's checks read only the fields set here). */
export function asGate5(
  e: Gate55Expected,
  variant: Gate55Variant,
): Gate5Expected {
  return {
    schema: "render-stream-gate5-expected/1",
    fixture: `${e.fixture}${variant === "base" ? "" : `-${variant}`}`,
    viewport: e.viewport,
    clear_rgba8: e.clear_rgba8,
    start_frame_default: e.start_frame_default,
    step_frames_default: e.step_frames_default,
    settle_offset: e.settle_offset,
    quit_frame_default: e.quit_frame_default,
    last_step: e.last_step,
    creation_order: e.variants[variant].creation_order,
    created_later: [],
    regions: e.regions,
    marker_rect: e.marker_rect,
    exact_edge_px: e.exact_edge_px,
    aa_band_px: 0,
    thin_band_px: 0,
    textures: {},
    engine_textures: [],
    hook_census: {},
    typed_ops: e.typed_ops,
    calibrator7_ops: [],
    tie_free_edges_checked: 0,
    lowering_predictions: {},
    op_lists: e.op_lists,
    steps: e.variants[variant].steps,
    predictions: {},
  };
}

export function stepOf55(
  e: Gate55Expected,
  variant: Gate55Variant,
  step: number,
): Gate55Step {
  const found = e.variants[variant].steps.find((s) => s.step === step);
  if (!found) throw new Error(`gate55-expected: no ${variant} step ${step}`);
  return found;
}

/** The expected frame of one step of one variant: the blend-aware raster on the RGB10_A2 target. */
export function rasterize55(
  e: Gate55Expected,
  variant: Gate55Variant,
  step: number,
): Gate5Raster {
  return rasterizeItems({
    viewport: e.viewport,
    clear: e.clear_rgba8,
    textures: {},
    opLists: e.op_lists,
    items: stepOf55(e, variant, step).items,
    exactEdgePx: e.exact_edge_px,
    targetAlphaBits: e.target_alpha_bits,
  });
}

export function rasters55(
  e: Gate55Expected,
  variant: Gate55Variant,
): Map<number, Gate5Raster> {
  const out = new Map<number, Gate5Raster>();
  for (const s of e.variants[variant].steps)
    out.set(s.step, rasterize55(e, variant, s.step));
  return out;
}

/** Per step: each item's own material (CimSim id or null) and use_parent_material, from the
 * calls through that step (a freed material leaves every item naming it, D5). */
export function expectedItemMaterials(
  e: Gate55Expected,
  variant: Gate55Variant,
): Map<number, Map<string, { material: number | null; use_parent: boolean }>> {
  const out = new Map<
    number,
    Map<string, { material: number | null; use_parent: boolean }>
  >();
  const cur = new Map<string, { material: number | null; use_parent: boolean }>(
    e.variants[variant].creation_order.map((n) => [
      n,
      { material: null, use_parent: false },
    ]),
  );
  for (const s of e.variants[variant].steps) {
    for (const c of s.rs_material_calls) {
      if (c.call === "canvas_item_set_material") {
        const it = cur.get(c.item as string);
        if (it) it.material = (c.material as number | null) ?? null;
      } else if (c.call === "canvas_item_set_use_parent_material") {
        const it = cur.get(c.item as string);
        if (it) it.use_parent = c.value as boolean;
      } else if (c.call === "free" && c.kind === "material") {
        for (const it of cur.values())
          if (it.material === c.material) it.material = null;
      }
    }
    out.set(s.step, new Map([...cur].map(([n, v]) => [n, { ...v }] as const)));
  }
  return out;
}
