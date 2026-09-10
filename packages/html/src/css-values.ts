import {
  type ColorMatrix,
  type GodotVariant,
  isColorValue,
} from "@godot-scene-web/core";

/**
 * A linear RGB color transform (`out_rgb = rows · in_rgb`, no offset, alpha
 * unchanged), stored row-major. This is the common representation for both a
 * diagonal modulate tint and an arbitrary `feColorMatrix` shader tint (e.g. an
 * HSV color-adjust shader), so the two compose uniformly.
 */
export type { ColorMatrix } from "@godot-scene-web/core";

const COLOR_MATRIX_EPSILON = 1e-6;

export function diagonalColorMatrix(
  r: number,
  g: number,
  b: number,
): ColorMatrix {
  return {
    rows: [
      [r, 0, 0],
      [0, g, 0],
      [0, 0, b],
    ],
  };
}

export function colorMatrixIsDiagonal(matrix: ColorMatrix): boolean {
  const r = matrix.rows;
  return (
    Math.abs(r[0][1]) < COLOR_MATRIX_EPSILON &&
    Math.abs(r[0][2]) < COLOR_MATRIX_EPSILON &&
    Math.abs(r[1][0]) < COLOR_MATRIX_EPSILON &&
    Math.abs(r[1][2]) < COLOR_MATRIX_EPSILON &&
    Math.abs(r[2][0]) < COLOR_MATRIX_EPSILON &&
    Math.abs(r[2][1]) < COLOR_MATRIX_EPSILON
  );
}

export function colorMatrixIsIdentity(matrix: ColorMatrix): boolean {
  const r = matrix.rows;
  return (
    colorMatrixIsDiagonal(matrix) &&
    Math.abs(r[0][0] - 1) < COLOR_MATRIX_EPSILON &&
    Math.abs(r[1][1] - 1) < COLOR_MATRIX_EPSILON &&
    Math.abs(r[2][2] - 1) < COLOR_MATRIX_EPSILON
  );
}

/**
 * Compose two color transforms applied to a column vector. `a` is the outer
 * transform (applied last): the result computes `a · b`. `undefined` is treated
 * as identity, and an identity result collapses back to `undefined` so callers
 * can skip painting a tint.
 */
export function composeColorMatrix(
  a: ColorMatrix | undefined,
  b: ColorMatrix | undefined,
): ColorMatrix | undefined {
  if (!a && !b) {
    return undefined;
  }
  const ra = (a ?? IDENTITY_COLOR_MATRIX).rows;
  const rb = (b ?? IDENTITY_COLOR_MATRIX).rows;
  const cell = (i: number, j: number): number =>
    ra[i][0] * rb[0][j] + ra[i][1] * rb[1][j] + ra[i][2] * rb[2][j];
  const matrix: ColorMatrix = {
    rows: [
      [cell(0, 0), cell(0, 1), cell(0, 2)],
      [cell(1, 0), cell(1, 1), cell(1, 2)],
      [cell(2, 0), cell(2, 1), cell(2, 2)],
    ],
  };
  return colorMatrixIsIdentity(matrix) ? undefined : matrix;
}

const IDENTITY_COLOR_MATRIX: ColorMatrix = {
  rows: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};

/**
 * CSS `rgba(...)` for the diagonal multiply path (`background-blend: multiply`).
 * Only valid when the matrix is diagonal; off-diagonals are ignored.
 */
export function colorMatrixDiagonalCss(matrix: ColorMatrix): string {
  const r = matrix.rows;
  return `rgba(${toByte(r[0][0])}, ${toByte(r[1][1])}, ${toByte(r[2][2])}, 1)`;
}

/** The 20-value SVG `feColorMatrix` row form (alpha passes through). */
export function colorMatrixFeValues(matrix: ColorMatrix): string {
  const r = matrix.rows;
  return [
    round(r[0][0]),
    round(r[0][1]),
    round(r[0][2]),
    0,
    0,
    round(r[1][0]),
    round(r[1][1]),
    round(r[1][2]),
    0,
    0,
    round(r[2][0]),
    round(r[2][1]),
    round(r[2][2]),
    0,
    0,
    0,
    0,
    0,
    1,
    0,
  ].join(" ");
}

export function cssSize(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function styleAttribute(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

export function colorCss(value: GodotVariant | undefined): string | undefined {
  if (!isColorValue(value)) {
    return undefined;
  }
  const [r = 0, g = 0, b = 0, a = 1] = value.args;
  return `rgba(${toByte(r)}, ${toByte(g)}, ${toByte(b)}, ${clamp(a, 0, 1)})`;
}

export function colorAlpha(value: GodotVariant | undefined): number {
  return isColorValue(value) ? clamp(value.args[3] ?? 1, 0, 1) : 1;
}

export function modulateTint(
  props: Record<string, GodotVariant>,
): ColorMatrix | undefined {
  const tint = { r: 1, g: 1, b: 1 };
  for (const value of [props.modulate, props.self_modulate]) {
    if (!isColorValue(value)) {
      continue;
    }
    const [r = 1, g = 1, b = 1, a = 1] = value.args;
    // A fully transparent modulate (alpha 0) makes the node invisible at rest, so its RGB
    // multiply has no visible effect — but baking it would DESTROY the texture's colors
    // (a near-zero multiply blacks out the raster), and a later opacity+tint override (e.g.
    // a focus gold ring revealed by clearing this override) could never recover them. Skip
    // the RGB contribution of an alpha-0 modulate; the alpha is applied separately as opacity.
    if (a === 0) {
      continue;
    }
    tint.r *= clamp(r, 0, 1);
    tint.g *= clamp(g, 0, 1);
    tint.b *= clamp(b, 0, 1);
  }
  if (tint.r === 1 && tint.g === 1 && tint.b === 1) {
    return undefined;
  }
  return diagonalColorMatrix(tint.r, tint.g, tint.b);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

export function cssUrl(value: string): string {
  return value.replace(/"/g, '\\"');
}

export function toByte(value: number): number {
  return Math.round(clamp(value, 0, 1) * 255);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function safeClassSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * A texture URL is "embedded" when it carries its own bytes (a `data:` URI), so
 * an inline `<image>` SVG can rasterize it as a CSS background/border image.
 * External URLs (e.g. `/api/asset/...` served out-of-band by `presentation
 * serve`) cannot: browsers load CSS-image SVGs in a restricted mode that blocks
 * external `<image>` references, so those paths use a plain raster background
 * plus a CSS `filter: url(#id)` color matrix instead of baking the tint into the
 * SVG.
 */
export function isEmbeddedAssetUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith("data:");
}
