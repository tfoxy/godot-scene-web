// Types and pure helpers for fixtures/gate5/expected.json (render-stream-gate5-expected/1,
// protocol/gate5-design.md "Q6c"), written by fixtures/gate5/make_expected.py. No I/O, no Godot,
// no capture evidence. scripts/lib/geometry-raster.ts rasterizes the coverage model below.

export type Point = [number, number];
export type Rgba = [number, number, number, number];
export type Rgba8 = [number, number, number, number];
/** [x0, y0, x1, y1): integer, half-open. */
export type Box = [number, number, number, number];
/** Godot Transform2D columns: x.x, x.y, y.x, y.y, origin.x, origin.y. */
export type Affine = [number, number, number, number, number, number];

/** A triangle mesh in draw space: every lowered line, polyline, circle, polygon, primitive,
 * triangle array and rect. `colors` holds one colour or one per vertex; `uvs` and `texture` map
 * a texture (nearest); `band_px` marks an antialiased shape whose feathers are band (D13). */
export interface MeshShape {
  name: string;
  kind: "mesh";
  vertices: Point[];
  triangles: number[][];
  colors: Rgba[];
  uvs?: Point[];
  texture?: string;
  band_px?: number;
}

/** A thin GL line (width < 0): band within `band_px` of the segment. */
export interface ThinLineShape {
  name: string;
  kind: "thin_line";
  from: Point;
  to: Point;
  colors: Rgba[];
  band_px: number;
}

export type NinePatchAxis = "stretch" | "tile" | "tile_fit";

/** A nine-patch command, mapped per axis as the GLES3 shader does. */
export interface NinePatchShape {
  name: string;
  kind: "nine_patch";
  rect: [number, number, number, number];
  texture: string;
  /** left, top, right, bottom */
  margins: [number, number, number, number];
  x_axis: NinePatchAxis;
  y_axis: NinePatchAxis;
  draw_center: boolean;
  modulate: Rgba;
}

export type Gate5Shape = MeshShape | ThinLineShape | NinePatchShape;
export type Gate5Op =
  | Gate5Shape
  | { op: "set_transform"; transform: Affine }
  | { op: "clip_ignore"; ignore: boolean };

export interface Gate5Item {
  name: string;
  region: string;
  /** the item's final transform, canvas transform included */
  xform: Affine;
  /** the item's scissor in canvas pixels, or null */
  clip_px: Box | null;
  /** a key of `op_lists` */
  ops: string;
}

export interface Gate5Call {
  item: string;
  op: string;
  /** computed arguments compare within this many float32 ulps (D12) */
  ulp?: number;
  [arg: string]: unknown;
}

export interface Gate5ExpectedStep {
  step: number;
  applied_frame: number;
  settle_frame: number;
  marker_rgba8: Rgba8;
  canvas_transform: Affine;
  /** items whose `_draw` runs at this step, in order */
  redraws: string[];
  /** per region, the RenderingServer calls the redraws make */
  calls: Record<string, Gate5Call[]>;
  /** every item in paint order */
  items: Gate5Item[];
  /** per region: its pixels differ from the previous step's */
  fresh: Record<string, boolean>;
}

export interface Gate5Texture {
  width: number;
  height: number;
  rgba8_hex: string;
}

export interface Gate5Prediction {
  frame?: number;
  op?: string;
  steps?: number[];
  regions?: Record<string, number[]>;
}

export interface Gate5Expected {
  schema: "render-stream-gate5-expected/1";
  fixture: string;
  viewport: [number, number];
  clear_rgba8: Rgba8;
  start_frame_default: number;
  step_frames_default: number;
  settle_offset: number;
  quit_frame_default: number;
  last_step: number;
  creation_order: string[];
  created_later: { name: string; step: number }[];
  /** [x0, y0, x1, y1) per region */
  regions: Record<string, Box>;
  marker_rect: [number, number, number, number];
  exact_edge_px: number;
  aa_band_px: number;
  thin_band_px: number;
  textures: Record<string, Gate5Texture>;
  engine_textures: {
    frame: number;
    op: string;
    format: string;
    width: number;
    height: number;
  }[];
  /** RenderingServer calls per method over the run */
  hook_census: Record<string, number>;
  /** the ops a pre-/4 capture types `unsupported` */
  typed_ops: string[];
  /** ops typed only once calibrator 7 hooks them (G5a) */
  calibrator7_ops: string[];
  tie_free_edges_checked: number;
  lowering_predictions: Record<string, Record<string, unknown>>;
  op_lists: Record<string, Gate5Op[]>;
  steps: Gate5ExpectedStep[];
  predictions: Record<string, Gate5Prediction>;
}

/** Step k's applied frame (step 0 is the `_ready` state, frame 1) and settle frame. */
export function stepFrames5(
  expected: Pick<
    Gate5Expected,
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

export function stepOf5(
  expected: Pick<Gate5Expected, "steps">,
  step: number,
): Gate5ExpectedStep {
  const found = expected.steps.find((s) => s.step === step);
  if (!found)
    throw new Error(`gate5-expected: no step ${step} in expected.json`);
  return found;
}

export function isShape(op: Gate5Op): op is Gate5Shape {
  return "kind" in op;
}

/** Godot Transform2D a * b: b applied first. */
export function compose(a: readonly number[], b: readonly number[]): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function applyAffine(m: readonly number[], p: readonly number[]): Point {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

export function invertAffine(m: readonly number[]): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** The texture's texels as RGBA8, row-major. */
export function textureTexels(t: Gate5Texture): Uint8Array {
  const out = new Uint8Array(t.width * t.height * 4);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(t.rgba8_hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
