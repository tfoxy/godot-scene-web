// Pure synthesis of the gate 3 fixture's expected per-step frame, straight from
// fixtures/gate3/expected.json (render-stream-gate3-expected/1) -- no file or network I/O, no
// Godot, no capture evidence. See ../../protocol/gate3-design.md "Q6c" for the schema and the
// checks (`expected-image-reference`, `probes-reference`) that compare real screenshots with it.
//
// Every gate 3 draw is a non-antialiased add_rect with an opaque colour on the 0.2 grid, and every
// scissor edge is an integer (D8), so the synthesis is exact: the clear colour, then each draw's
// rect intersected with its effective scissor, in paint order.

/** [x, y, w, h] in root-canvas pixels. */
export type Rect4 = [number, number, number, number];
/** A scissor, [x0, y0, x1, y1): half-open, integer. */
export type Clip4 = [number, number, number, number];
export type Rgba8 = [number, number, number, number];

/** One painted rect, in paint order: its axis-aligned rect after every transform, its colour and
 * the effective scissor of its clip owner (null: none). */
export interface Gate3Draw {
  name: string;
  rect_px: Rect4;
  rgba8: Rgba8;
  clip_px: Clip4 | null;
}

/** A clip owner's final scissor at a step: a rect, null (its clip is off), or "skipped" (a zero-
 * area intersection skipped it and its subtree, renderer_canvas_cull.cpp:408-411). */
export type ClipRectValue = Clip4 | null | "skipped";

export type Edge = "left" | "right" | "top" | "bottom";

/** One probe pixel (gate3-design.md Q6c "Probe rule"): `<owner>.<edge>.<side>.<i>`. */
export interface Gate3Probe {
  name: string;
  owner: string;
  edge: Edge;
  side: "inside" | "outside";
  xy: [number, number];
  rgba8: Rgba8;
  /** the same pixel with every clip off */
  unclipped_rgba8: Rgba8;
  /** the pair's outside pixel differs from the unclipped scene there */
  decisive: boolean;
}

/** One retained-state assertion on the step's settle transaction (gate 1's kinds plus Q6c's). */
export type Gate3Invariant =
  | { kind: "clip"; item: string; value: boolean }
  | { kind: "custom_rect"; item: string; enabled: boolean; rect: Rect4 }
  | { kind: "commands"; item: string; count: number }
  | { kind: "content_unchanged"; items: string[]; step: number }
  | { kind: "version"; items: string[]; cmp: "eq" | "gt"; step: number }
  | { kind: "canvas_xform"; canvas: number; value: number[] };

export interface Gate3ExpectedStep {
  step: number;
  marker_rgba8: Rgba8;
  /** the root canvas transform: x.x, x.y, y.x, y.y, origin.x, origin.y */
  canvas_transform: number[];
  /** paint order: z ascending, then the cull's pre-order */
  draws: Gate3Draw[];
  /** items with commands that the custom-rect visibility test leaves undrawn */
  culled: string[];
  clip_rects: Record<string, ClipRectValue>;
  probes: Gate3Probe[];
  invariants: Gate3Invariant[];
}

/** A sabotage or unsupported leg's predicted outcome (Q7), computed by the same model. */
export interface Gate3Prediction {
  steps?: number[];
  regions?: string[];
  /** "<step>:<probe name>" */
  probes?: string[];
}

/** Variant `clip-ignore` (gate3-design.md Q6b, G3d): a static raw item `RI`, present only under
 * `RS_FIXTURE_VARIANT=clip-ignore`, whose second rect escapes its own clip in the real engine
 * (Q1d). Each draw list is in paint order (`RI`'s first rect, then its second), to append to a
 * step's `draws` before synthesis.
 *
 * Both `reference_draws[step]` and `receiver_draws[step]` are per step: `RI` is static, but the
 * step-9 canvas shift (Q6b) still moves it like every other top-level item -- that shift is not
 * gate 3b's D3 fix, just `RI` inheriting the canvas transform, so it applies on both sides.
 *
 * Since G5d (gate5-design.md D10 and Q6g, render-stream/4) `add_clip_ignore` is a real command the
 * receiver replays in order, so `receiver_draws` equals `reference_draws` at every step and
 * `receiver-clip-ignore` matches `reference-clip-ignore` in every region, `ri` included. On
 * render-stream/3 the receiver saw two unsupported commands and clipped the second rect to `RI`'s
 * own scissor: region `ri` was the one predicted difference. */
export interface Gate3VariantClipIgnore {
  name: "clip-ignore";
  /** RI's region (until G5d the only region a receiver's image differed from the reference in;
   * since G5d it differs nowhere) */
  region_name: string;
  region: Rect4;
  /** RI's own scissor at step 0: custom_rect translated by its origin */
  clip_px: Clip4;
  reference_draws: Gate3Draw[][];
  receiver_draws: Gate3Draw[][];
}

export interface Gate3Expected {
  schema: "render-stream-gate3-expected/1";
  fixture: "gate3" | "gate3-xform";
  viewport: [number, number];
  clear_rgba8: Rgba8;
  start_frame_default: number;
  step_frames_default: number;
  settle_offset: number;
  quit_frame_default: number;
  last_step: number;
  regions: Record<string, Rect4>;
  empty_region: Rect4;
  /** item names in canvas_item_create order: wire ids 1, 2, ... */
  creation_order: string[];
  created_later: { name: string; step: number }[];
  /** every item whose clip is ever on */
  owners: string[];
  /** gate3-design.md Q6b's hand table, by step ("0".."9") */
  hand_clip_rects: Record<string, Record<string, ClipRectValue>>;
  non_decisive_edges: { owner: string; edge: Edge; reason: string }[];
  /** whole-run RS call totals at the hook (Q1a) */
  census_totals: {
    canvas_item_set_clip: { false: number; true: number };
    canvas_item_set_custom_rect: { false: number; true: number };
    canvas_item_clear: number;
  };
  steps: Gate3ExpectedStep[];
  predictions: Record<string, Gate3Prediction>;
  /** absent on `gate3-xform` (G3c); present here from G3d on */
  variant_clip_ignore?: Gate3VariantClipIgnore;
}

export interface SynthesizedFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Step k's applied frame (step 0 is the `_ready` state, frame 1) and settle frame. */
export function stepFrames3(
  expected: Pick<
    Gate3Expected,
    "start_frame_default" | "step_frames_default" | "settle_offset"
  >,
  step: number,
): { applied: number; settle: number } {
  const S = expected.start_frame_default;
  const N = expected.step_frames_default;
  return {
    applied: step === 0 ? 1 : S + N * step,
    settle: S + N * step + expected.settle_offset,
  };
}

function stepOf(expected: Gate3Expected, step: number): Gate3ExpectedStep {
  const found = expected.steps.find((s) => s.step === step);
  if (!found)
    throw new Error(`gate3-expected: no step ${step} in expected.json`);
  return found;
}

/** A draw's painted pixels: its rect inside the viewport and its scissor, or null when empty. */
export function visibleRect(
  draw: Pick<Gate3Draw, "rect_px" | "clip_px">,
  viewport: readonly number[],
): Clip4 | null {
  const [x, y, w, h] = draw.rect_px;
  let x0 = Math.max(0, x);
  let y0 = Math.max(0, y);
  let x1 = Math.min(viewport[0], x + w);
  let y1 = Math.min(viewport[1], y + h);
  if (draw.clip_px) {
    x0 = Math.max(x0, draw.clip_px[0]);
    y0 = Math.max(y0, draw.clip_px[1]);
    x1 = Math.min(x1, draw.clip_px[2]);
    y1 = Math.min(y1, draw.clip_px[3]);
  }
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/**
 * The expected RGBA frame for one step: the clear colour, then every draw in paint order, each
 * intersected with its scissor (`clips: false` ignores every scissor: the unclipped scene the
 * probes call `unclipped_rgba8`).
 */
export function synthesizeGate3(
  expected: Gate3Expected,
  step: number,
  opts: { clips?: boolean } = {},
): SynthesizedFrame {
  const [width, height] = expected.viewport;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++)
    rgba.set(expected.clear_rgba8, i * 4);
  for (const draw of stepOf(expected, step).draws) {
    const r = visibleRect(
      opts.clips === false ? { ...draw, clip_px: null } : draw,
      expected.viewport,
    );
    if (!r) continue;
    for (let y = r[1]; y < r[3]; y++)
      for (let x = r[0]; x < r[2]; x++)
        rgba.set(draw.rgba8, (y * width + x) * 4);
  }
  return { width, height, rgba };
}

/** `expected` with `extraDraws` appended to every step's `draws` (gate3-design.md Q6b "Variant
 * clip-ignore", G3d): a flat array broadcasts the same draws to every step (`RI` is static, but
 * its global position still follows a step's canvas shift, Q6b); a `(step) => draws` callback
 * gives a different list per step. Lets `synthesizeGate3`/`compareShotsWithSynth` build the
 * reference or receiver image for a variant leg without a second synthesis path. */
export function withExtraDraws(
  expected: Gate3Expected,
  extraDraws: readonly Gate3Draw[] | ((step: number) => readonly Gate3Draw[]),
): Gate3Expected {
  const forStep =
    typeof extraDraws === "function" ? extraDraws : () => extraDraws;
  return {
    ...expected,
    steps: expected.steps.map((s) => ({
      ...s,
      draws: [...s.draws, ...forStep(s.step)],
    })),
  };
}

/** The probes of one step, in expected.json order. */
export function probesOf(expected: Gate3Expected, step: number): Gate3Probe[] {
  return stepOf(expected, step).probes;
}

/** The RGBA of pixel (x, y) of a frame. */
export function pixelAt(
  frame: { width: number; rgba: Uint8Array },
  x: number,
  y: number,
): Rgba8 {
  const i = (y * frame.width + x) * 4;
  return [
    frame.rgba[i],
    frame.rgba[i + 1],
    frame.rgba[i + 2],
    frame.rgba[i + 3],
  ];
}

export function clipValueEqual(a: ClipRectValue, b: ClipRectValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function formatClip(v: ClipRectValue | undefined): string {
  if (v === undefined) return "<absent>";
  if (v === null) return "-";
  if (v === "skipped") return "skipped";
  return `[${v.join(",")})`;
}
