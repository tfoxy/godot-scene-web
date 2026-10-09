// Pure synthesis of the gate 3 rotated/scaled fixture's expected per-step frame, straight from
// fixtures/gate3-xform/expected.json (render-stream-gate3-expected/1, fixture "gate3-xform") -- no
// file or network I/O, no Godot, no capture evidence. See ../../protocol/gate3-design.md "Q6d".
//
// Every draw is a non-antialiased add_rect with an opaque colour on the 0.2 grid, clipped by an
// integer scissor (D8). A draw under a rotation is a quad: a pixel is covered when its centre
// lies inside it. Pixels whose centre lies within `band_px` (1.0) of a non-axis-aligned edge of a
// draw, inside that draw's scissor, form the `band`: the rasterizer's own edge rule decides them,
// so the expected-image checks leave them out and the receiver is compared with the reference
// there under a budget a same-build reference repeat measures. make_expected.py computes the same
// coverage and band with the same arithmetic (squared distances, no sqrt), so the two agree.

import type {
  Clip4,
  ClipRectValue,
  Edge,
  Gate3Invariant,
  Gate3Prediction,
  Gate3Probe,
  Rect4,
  Rgba8,
  SynthesizedFrame,
} from "./gate3-expected";

export type Point = [number, number];

/** One painted rect, in paint order: `rect_px` [x, y, w, h] (floats) when its transform is
 * axis-aligned, else `quad`, its four transformed corners; its colour and its effective scissor. */
export interface Gate3xDraw {
  name: string;
  rect_px?: Rect4;
  quad?: [Point, Point, Point, Point];
  rgba8: Rgba8;
  clip_px: Clip4 | null;
}

export const CLIP_MODELS = [
  "engine",
  "rotated-exact",
  "edge-round",
  "pixel-centre",
] as const;
export type ClipModel = (typeof CLIP_MODELS)[number];

/** A D7 probe: the colour every clip model predicts at one pixel and step. `hand` is the
 * contract's table (Q6d), by item name or "clear"; `models` the derivation. */
export interface Gate3xSemanticProbe {
  name: string;
  step: number;
  xy: [number, number];
  models: Record<ClipModel, Rgba8>;
  hand: Record<ClipModel, string>;
}

export interface Gate3xExpectedStep {
  step: number;
  marker_rgba8: Rgba8;
  canvas_transform: number[];
  draws: Gate3xDraw[];
  culled: string[];
  clip_rects: Record<string, ClipRectValue>;
  /** the band's pixel count, as make_expected.py counted it */
  band_pixels: number;
  probes: Gate3Probe[];
  invariants: Gate3Invariant[];
}

export interface Gate3xExpected {
  schema: "render-stream-gate3-expected/1";
  fixture: "gate3-xform";
  viewport: [number, number];
  clear_rgba8: Rgba8;
  start_frame_default: number;
  step_frames_default: number;
  settle_offset: number;
  quit_frame_default: number;
  last_step: number;
  band_px: number;
  regions: Record<string, Rect4>;
  empty_region: Rect4;
  creation_order: string[];
  created_later: { name: string; step: number }[];
  owners: string[];
  models: ClipModel[];
  /** gate3-design.md Q6d's engine-model scissors, by step ("0".."4") */
  hand_clip_rects: Record<string, Record<string, ClipRectValue>>;
  non_decisive_edges: { owner: string; edge: Edge; reason: string }[];
  semantic_probes: Gate3xSemanticProbe[];
  steps: Gate3xExpectedStep[];
  predictions: Record<string, Gate3Prediction>;
}

export interface SynthesizedFrameX extends SynthesizedFrame {
  /** 1 where the pixel is in the band */
  band: Uint8Array;
  bandPixels: number;
}

/** The centre (cx, cy) lies inside or on the convex quad (either winding). */
export function quadCovers(
  q: readonly Point[],
  cx: number,
  cy: number,
): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

/** The squared distance from (px, py) to the segment a-b. */
export function segDist2(px: number, py: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)),
  );
  const ex = px - (a[0] + t * dx);
  const ey = py - (a[1] + t * dy);
  return ex * ex + ey * ey;
}

/** A draw's axis-aligned bounds [x, y, w, h]. */
export function drawBounds(d: Gate3xDraw): Rect4 {
  if (d.rect_px) return d.rect_px;
  const q = d.quad ?? [];
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
}

/** Pixel (x, y) is covered by the draw by its centre (axis-aligned: left/top inclusive). */
export function drawCovers(d: Gate3xDraw, x: number, y: number): boolean {
  const cx = x + 0.5;
  const cy = y + 0.5;
  if (d.rect_px) {
    const [rx, ry, rw, rh] = d.rect_px;
    return rx <= cx && cx < rx + rw && ry <= cy && cy < ry + rh;
  }
  return d.quad ? quadCovers(d.quad, cx, cy) : false;
}

/** The pixel window a draw can touch: its bounds (+2 px) inside the viewport and its scissor. */
export function drawWindow(
  d: Pick<Gate3xDraw, "rect_px" | "quad" | "clip_px">,
  viewport: readonly number[],
  clips = true,
): Clip4 {
  const [x0, y0, w, h] = drawBounds(d as Gate3xDraw);
  let xa = Math.max(0, Math.floor(x0) - 2);
  let ya = Math.max(0, Math.floor(y0) - 2);
  let xb = Math.min(viewport[0], Math.ceil(x0 + w) + 2);
  let yb = Math.min(viewport[1], Math.ceil(y0 + h) + 2);
  if (clips && d.clip_px) {
    xa = Math.max(xa, d.clip_px[0]);
    ya = Math.max(ya, d.clip_px[1]);
    xb = Math.min(xb, d.clip_px[2]);
    yb = Math.min(yb, d.clip_px[3]);
  }
  return [xa, ya, xb, yb];
}

/** Paints `draws` in order over the clear colour and marks the band. */
export function paintDraws(
  draws: readonly Gate3xDraw[],
  viewport: readonly [number, number] | readonly number[],
  clear: Rgba8,
  bandPx: number,
  opts: { clips?: boolean } = {},
): SynthesizedFrameX {
  const [width, height] = viewport;
  const rgba = new Uint8Array(width * height * 4);
  const band = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) rgba.set(clear, i * 4);
  const limit = bandPx * bandPx;
  for (const d of draws) {
    const [xa, ya, xb, yb] = drawWindow(d, viewport, opts.clips !== false);
    for (let y = ya; y < yb; y++)
      for (let x = xa; x < xb; x++) {
        if (d.quad) {
          const q = d.quad;
          for (let i = 0; i < 4; i++)
            if (segDist2(x + 0.5, y + 0.5, q[i], q[(i + 1) % 4]) <= limit) {
              band[y * width + x] = 1;
              break;
            }
        }
        if (drawCovers(d, x, y)) rgba.set(d.rgba8, (y * width + x) * 4);
      }
  }
  let bandPixels = 0;
  for (const b of band) bandPixels += b;
  return { width, height, rgba, band, bandPixels };
}

function stepOf(expected: Gate3xExpected, step: number): Gate3xExpectedStep {
  const found = expected.steps.find((s) => s.step === step);
  if (!found)
    throw new Error(`gate3x-expected: no step ${step} in expected.json`);
  return found;
}

/**
 * The expected RGBA frame for one step and its band mask: the clear colour, then every draw in
 * paint order by pixel-centre coverage inside its scissor (`clips: false` ignores every scissor).
 */
export function synthesizeGate3x(
  expected: Gate3xExpected,
  step: number,
  opts: { clips?: boolean } = {},
): SynthesizedFrameX {
  return paintDraws(
    stepOf(expected, step).draws,
    expected.viewport,
    expected.clear_rgba8,
    expected.band_px,
    opts,
  );
}

export function stepOfX(
  expected: Gate3xExpected,
  step: number,
): Gate3xExpectedStep {
  return stepOf(expected, step);
}
