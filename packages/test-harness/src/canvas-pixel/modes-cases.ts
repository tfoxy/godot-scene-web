/**
 * The INPUTS of the canvas modes pixel suite, and nothing else: texel bytes,
 * colours and geometry, stated once so the page that draws them
 * (`./modes-entry.ts`) and the test that predicts their pixels
 * (`test/canvasModesPixel.test.ts`) cannot drift apart.
 *
 * Deliberately no arithmetic about what the pixels should BE. Each prediction is
 * a CPU model written in the test, from these numbers and from the GL and Godot
 * rules it cites; putting it here, beside the inputs the page also reads, would
 * let a wrong model and a wrong renderer agree by construction.
 *
 * Every number is picked so that the predicted value is FAR from a rounding
 * boundary (a `.5` after scaling to the target's levels), which is what lets the
 * suite hold most cases to a channel budget of 0: a GPU and a CPU model may round
 * a boundary value differently, and a case built on one would be measuring that.
 */

export type Rgba = readonly [number, number, number, number];

/** Default stage: design == framebuffer pixels, so a coordinate is a pixel. */
export const MODES_STAGE = 64;

// ---- vertexGradient: per-vertex colours interpolated STRAIGHT -----------------

/**
 * A full-stage quad mesh whose left two vertices carry `left` and right two
 * `right`, STRAIGHT alpha. Colour and alpha both vary along x, which is the
 * case where straight and premultiplied interpolation are different pictures.
 */
export const GRADIENT_LEFT: Rgba = [1, 0.5, 0, 1];
export const GRADIENT_RIGHT: Rgba = [0, 0.5, 1, 0];

// ---- vertexTextured: straight texel x straight vertex colour x premul tint ----

/** A 1x1 straight-stored texel. */
export const TEXTURED_TEXEL: Rgba = [200, 100, 50, 128];
/** Every vertex, straight. */
export const TEXTURED_VERTEX: Rgba = [0.5, 1, 1, 0.75];
/** The mesh tint as a STRAIGHT colour; the page premultiplies it for the IR. */
export const TEXTURED_MODULATE: Rgba = [1, 0.5, 1, 0.8];

// ---- premultipliedSource: Godot PREMULT_ALPHA over an opaque background --------

/** Opaque background, exact in 8 bits: 51, 102, 153. */
export const PREMUL_BACKGROUND: Rgba = [0.2, 0.4, 0.6, 1];
/** A texel holding PREMULTIPLIED content (rgb <= a), stored as given. */
export const PREMUL_TEXEL: Rgba = [100, 50, 0, 128];
/** Band 2's vertex colour, applied as given (`premultipliedVertexColors`). */
export const PREMUL_VERTEX: Rgba = [1, 1, 1, 0.5];
/** Band 3's tint: Godot's STRAIGHT modulate, passed as given (see `BlendMode`). */
export const PREMUL_MODULATE: Rgba = [1, 1, 1, 0.5];
/** Bands, 16 rows each, top to bottom. */
export const PREMUL_BANDS = [
  "premulQuad",
  "mixQuad",
  "premulMeshVertexColour",
  "premulQuadStraightModulate",
] as const;

// ---- wrap: clamp / repeat / mirror, linear and nearest -------------------------

/** A 4x1 opaque page. Bytes are multiples of 4, so a 1/4-3/4 blend is an integer. */
export const WRAP_TEXELS: readonly Rgba[] = [
  [40, 0, 0, 255],
  [0, 80, 0, 255],
  [0, 0, 120, 255],
  [200, 160, 0, 255],
];
/** One 4-row band per binding, top to bottom. */
export const WRAP_BANDS = [
  { wrap: "clamp", filter: "linear" },
  { wrap: "repeat", filter: "linear" },
  { wrap: "mirror", filter: "linear" },
  { wrap: "clamp", filter: "nearest" },
  { wrap: "repeat", filter: "nearest" },
  { wrap: "mirror", filter: "nearest" },
] as const;
export const WRAP_BAND_ROWS = 4;
/** Each band's quad: 16 px wide, sampling page pixels `-2 .. 6` (scale 2), so
 *  it crosses BOTH texture edges (s = 0 and s = 4) with pixel centres landing
 *  at quarter-texel offsets. */
export const WRAP_QUAD_WIDTH = 16;
export const WRAP_SRC_X = -2;
export const WRAP_SRC_W = 8;

// ---- straightFilter: filter-then-premultiply vs premultiply-then-filter --------

/** A 2x1 page: opaque, then HALF-transparent with very different colour. */
export const FILTER_TEXELS: readonly Rgba[] = [
  [240, 16, 0, 255],
  [16, 240, 0, 128],
];
/** One row of 8 px over the 2 texels (scale 4): eighth-texel offsets. */
export const FILTER_QUAD_WIDTH = 8;
export const FILTER_QUAD_HEIGHT = 4;

// ---- rgb10a2Ramp: 10-bit storage and its 8-bit readback -----------------------

/** 1024 x 2: row 0 a colour ramp at every 10-bit level, row 1 an alpha ramp. */
export const RAMP_WIDTH = 1024;
export const RAMP_HEIGHT = 2;
/** Column `i`'s opaque colour in row 0, in 10-bit levels. */
export function rampLevels(i: number): [number, number, number] {
  return [i, 1023 - i, (i * 7) % 1024];
}

// ---- rgb10a2Stack: blending at 10-bit precision -------------------------------

/** Left half: an opaque base, then `STACK_LAYERS` MIX layers of one colour. */
export const STACK_BASE = 98 / 255;
export const STACK_LAYER_COLOUR = 0.4;
export const STACK_LAYER_ALPHA = 0.2;
export const STACK_LAYERS = 5;
/** Right half: one translucent quad over the transparent clear (straight). */
export const STACK_TRANSLUCENT: Rgba = [0.3, 0.3, 0.3, 0.6];
