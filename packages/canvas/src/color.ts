/**
 * Premultiplied colour composition — the arithmetic the batcher writes into an
 * instance and the fragment shader repeats on the GPU, in one place so the two
 * can be checked against each other (and against `html`'s CPU tint bake).
 *
 * TWO CONVENTIONS MEET HERE, and mixing them up is the classic renderer bug:
 *
 * - a **premultiplied** colour carries `(r·a, g·a, b·a, a)`. That is what the
 *   draw-list's tints are, what every texture in {@link ./textures} is uploaded
 *   as, what the fragment emits, and what the canvas is declared as. Composing
 *   two premultiplied colours is a plain componentwise multiply.
 * - a **straight** colour carries `(r, g, b, a)` with the channels independent.
 *   The only thing that wants straight colour is the 3x3 colour matrix, because
 *   the matrix is defined on the texture's own RGB — multiply a premultiplied
 *   colour by it and a 50%-alpha pixel is transformed as if it were half as
 *   bright.
 *
 * Everything below is sRGB-domain: no linearization anywhere. That is not a
 * shortcut, it is the contract — the matrices come from Godot HSV materials that
 * Godot itself applies to sRGB texture bytes, and `html`'s
 * `applyColorMatrixToPixels` (the CPU bake of the same transform, used by the DOM
 * renderer) applies them to sRGB bytes too. Linearizing here would make the GPU
 * path disagree with the DOM path it is meant to replace.
 */

/** Row-major 3x3 identity, the value slot 0 of a batch's matrix table holds. */
export const IDENTITY_COLOR_MATRIX: readonly number[] = [
  1, 0, 0, 0, 1, 0, 0, 0, 1,
];

/** A straight or premultiplied RGBA colour, 0..1 per channel. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function createRgba(): Rgba {
  return { r: 1, g: 1, b: 1, a: 1 };
}

export function clamp01(value: number): number {
  if (!(value > 0)) return 0; // also catches NaN
  return value < 1 ? value : 1;
}

/**
 * Straight `(r,g,b,a)` -> premultiplied, clamped. The shape a producer has (a
 * Godot `modulate` is straight) turned into the shape {@link QuadView} wants.
 */
export function premultiply(
  r: number,
  g: number,
  b: number,
  a: number,
  out: Rgba,
): Rgba {
  const alpha = clamp01(a);
  out.r = clamp01(r) * alpha;
  out.g = clamp01(g) * alpha;
  out.b = clamp01(b) * alpha;
  out.a = alpha;
  return out;
}

/**
 * Premultiplied -> straight, with the `a === 0` hole filled with black. The
 * inverse of {@link premultiply} up to that hole (a fully transparent
 * premultiplied pixel has forgotten its colour, so nothing can recover it).
 */
export function unpremultiply(colour: Rgba, out: Rgba): Rgba {
  const a = colour.a;
  if (a <= 0) {
    out.r = 0;
    out.g = 0;
    out.b = 0;
    out.a = 0;
    return out;
  }
  out.r = colour.r / a;
  out.g = colour.g / a;
  out.b = colour.b / a;
  out.a = a;
  return out;
}

/**
 * Compose two PREMULTIPLIED colours — a texel times its quad's tint. A plain
 * componentwise multiply, which is the whole reason the premultiplied form is
 * worth keeping: with straight colours this would need the alpha handled apart
 * from the channels it has already scaled.
 */
export function modulatePremultiplied(
  source: Rgba,
  tint: Rgba,
  out: Rgba,
): Rgba {
  out.r = source.r * tint.r;
  out.g = source.g * tint.g;
  out.b = source.b * tint.b;
  out.a = source.a * tint.a;
  return out;
}

/**
 * Apply a row-major 3x3 to STRAIGHT sRGB channels in 0..1, clamped — the float
 * twin of `html`'s `applyColorMatrixToPixels` (which works in 0..255 bytes and
 * clamps because it writes a `Uint8ClampedArray`) and of the colour-matrix branch
 * in the executor's fragment shader. All three must agree; `colour.test.ts`
 * asserts the first two against each other pixel for pixel.
 *
 * Alpha is untouched, exactly as `feColorMatrix` with only the RGB rows set.
 */
export function applyColorMatrix01(
  colour: Rgba,
  matrix: ArrayLike<number>,
  offset: number,
  out: Rgba,
): Rgba {
  const r = colour.r;
  const g = colour.g;
  const b = colour.b;
  out.r = clamp01(
    matrix[offset] * r + matrix[offset + 1] * g + matrix[offset + 2] * b,
  );
  out.g = clamp01(
    matrix[offset + 3] * r + matrix[offset + 4] * g + matrix[offset + 5] * b,
  );
  out.b = clamp01(
    matrix[offset + 6] * r + matrix[offset + 7] * g + matrix[offset + 8] * b,
  );
  out.a = colour.a;
  return out;
}

/**
 * The full per-fragment colour law, on the CPU: a PREMULTIPLIED texel, its
 * optional colour matrix, and the quad's PREMULTIPLIED tint, in the order the
 * shader applies them (un-premultiply, transform, re-premultiply, modulate).
 *
 * This exists so a pixel test can state the number it expects from the same
 * expression the GPU evaluates rather than from a second, hand-derived one.
 */
export function shadeQuadPixel(
  texel: Rgba,
  matrix: ArrayLike<number> | null,
  matrixOffset: number,
  tint: Rgba,
  out: Rgba,
): Rgba {
  if (matrix) {
    unpremultiply(texel, out);
    applyColorMatrix01(out, matrix, matrixOffset, out);
    out.r *= out.a;
    out.g *= out.a;
    out.b *= out.a;
  } else {
    out.r = texel.r;
    out.g = texel.g;
    out.b = texel.b;
    out.a = texel.a;
  }
  return modulatePremultiplied(out, tint, out);
}

/** True when the 9 floats at `offset` are the identity, i.e. a no-op slot. */
export function isIdentityColorMatrix(
  matrix: ArrayLike<number>,
  offset = 0,
): boolean {
  for (let i = 0; i < 9; i += 1) {
    if (matrix[offset + i] !== IDENTITY_COLOR_MATRIX[i]) return false;
  }
  return true;
}

/**
 * True when the 9 floats at `a`/`b` are equal — the batcher's matrix-table
 * dedupe. EXACT equality, deliberately: the table's job is to notice that many
 * cards carry the same computed tint, and an epsilon would merge two tints a
 * scene meant to differ. The corollary is that a `Float32Array` and a plain
 * `number[]` holding "the same" value do not match (`0.3` and its f32 round-trip
 * are different numbers), so a caller that wants dedupe should keep one storage
 * width — which the draw-list and this package both do.
 */
export function colorMatricesEqual(
  a: ArrayLike<number>,
  aOffset: number,
  b: ArrayLike<number>,
  bOffset: number,
): boolean {
  for (let i = 0; i < 9; i += 1) {
    if (a[aOffset + i] !== b[bOffset + i]) return false;
  }
  return true;
}
