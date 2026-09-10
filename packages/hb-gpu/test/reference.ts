// The reference the GPU pipeline is graded against: the same outline, the same transform, filled
// at 8x and box-downsampled.
//
// WHY A RASTERIZER HERE RATHER THAN A SECOND ENGINE'S. The thing under test is whether a blob
// reached the GPU intact — byte order, stride, row wrap, texel offset — and the failure modes are
// gross: a swapped byte pair turns curve coordinates into noise, a row off by one makes band
// headers read as curve data. What is needed is a picture of the CORRECT glyph at the correct
// place, from a completely different code path. Canvas2D would be a second engine, but reading it
// back means `getImageData` on an accelerated canvas, which returns alpha 0 on this exact rung;
// and a headless canvas is a third rasterizer with its own hinting opinions. A scanline fill of the
// same outline has no opinions at all, and at 8x supersampling its answer IS area coverage, to
// within the 65 levels an 8x8 box of a binary fill can produce.
//
// THAT QUANTISATION IS NOT NEGLIGIBLE AND SHOULD NOT BE QUOTED AS IF IT WERE. The step is 255/64 =
// 3.98 byte levels, so the reference carries ~1.15 levels of RMS on its own (uniform error, step
// over sqrt 12). The pipeline measures 1.62 against it at 14 px — so roughly `sqrt(1.62^2 -
// 1.15^2)` = 1.14 of that is real disagreement and the rest is the reference's own grid. Raising
// SUPERSAMPLE to 16 would quarter it, at 4x the fill cost, and would not change any verdict here:
// the threshold is 6 and the cheapest upload fault reads 6.70.
//
// The outline comes from npm `harfbuzzjs`, i.e. a DIFFERENT HarfBuzz build reading the same font
// file. So the two halves of this test share the font bytes and nothing else: if `hb-gpu.wasm`'s
// encoder and this package's upload agreed on a wrong answer, they would still have to agree with
// an independent build's outlines to pass.

import { boxDownsample } from "../../../scripts/test-support/text-image-metrics";

/** Supersampling factor. 8 gives 65 coverage levels, i.e. ~1.15 byte levels of RMS — see above. */
export const SUPERSAMPLE = 8;

export interface ReferenceGeometry {
  /** Output size in device px, square. */
  size: number;
  /** Object units (device px) per em. */
  pixelsPerEm: number;
  /** Units per em of the face the path is in. */
  upem: number;
  /** Pen origin on the baseline, device px. */
  originX: number;
  originY: number;
  /** Object-space 2x3 `[xx, xy, yx, yy, tx, ty]` — the same array `setModel` is given. */
  model: readonly number[];
  /**
   * Grow the filled outline by this many DEVICE px before downsampling — the ground truth for
   * `HbGpuRenderer.setSpread`. Omitted or 0 is the plain fill.
   *
   * THE DILATION HAPPENS AT 8x, WHICH IS THE ONLY PLACE IT CAN. What a dilated glyph should look
   * like is the area coverage of `outline (+) disk(r)`, and area coverage is exactly what
   * supersampling measures — so the disk is applied to the 8x binary fill and the box downsample
   * then reports the fraction of each device pixel the grown SHAPE covers. Dilating the downsampled
   * image instead would be dilating an antialiased picture, which saturates every rim pixel to
   * solid and would grade the shader against a reference with no antialiasing in it at all.
   *
   * This is a stricter reference than the shader can be, and deliberately: the shader takes a max
   * over point samples of coverage, which is not the same operator as "area of the grown shape".
   * The gap between them IS the outline's fidelity and is what the low-ppem case measures.
   */
  dilatePx?: number;
}

/**
 * Grow `mask` by a disk of `radius` samples, exactly, on the supersampled grid.
 *
 * DECOMPOSED BY ROW OFFSET, because the brute-force version this replaces is O(n·r²) and at 8x the
 * radius is 24 samples — `withinRadius` in the test file does 96x96 at r<6 and is fine; 1024x1024 at
 * r=24 is two orders of magnitude worse. A disk is the union over `dy` of horizontal segments of
 * half-width `floor(sqrt(r² - dy²))`, and a horizontal "is anything set within w" is a prefix-sum
 * lookup. That makes it O(n·r) with an exact answer rather than an approximation — a separable box
 * or two passes of a smaller disk would both be wrong by tens of percent on the diagonals, which is
 * the direction the rim assertion is most sensitive in.
 */
function dilateDisk(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const out = new Uint8Array(mask.length);
  const reach = Math.floor(radius);
  const radiusSquared = radius * radius;
  // One row's running count of set samples, so "any set in [x-w, x+w]" is two lookups.
  const prefix = new Int32Array(width + 1);
  for (let dy = -reach; dy <= reach; dy += 1) {
    const half = Math.floor(Math.sqrt(Math.max(0, radiusSquared - dy * dy)));
    for (let y = 0; y < height; y += 1) {
      const sourceY = y - dy;
      if (sourceY < 0 || sourceY >= height) continue;
      const rowStart = sourceY * width;
      prefix[0] = 0;
      for (let x = 0; x < width; x += 1) {
        prefix[x + 1] = prefix[x] + (mask[rowStart + x] ? 1 : 0);
      }
      if (prefix[width] === 0) continue;
      const outStart = y * width;
      for (let x = 0; x < width; x += 1) {
        if (out[outStart + x]) continue;
        const from = x - half < 0 ? 0 : x - half;
        const to = x + half + 1 > width ? width : x + half + 1;
        if (prefix[to] - prefix[from] > 0) out[outStart + x] = 1;
      }
    }
  }
  return out;
}

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Flatten one path command's curve into line segments.
 *
 * Segment count from the control polygon's length AT THE SUPERSAMPLED SCALE, so the flattening
 * error is bounded in the units the fill actually samples in. A fixed count would be wasteful for
 * a 3 px hook and visibly polygonal for a 200 px stroke.
 */
function segmentsFor(length: number): number {
  return Math.min(64, Math.max(4, Math.ceil(length / 2)));
}

/**
 * Parse the SVG path `harfbuzzjs` emits and produce edges already in supersampled device space.
 *
 * THROWS on an unrecognised command rather than skipping it. A skipped command is a glyph missing
 * one stroke, which reads as a small RMS disagreement — the exact signal this test is trying to
 * attribute to the upload path.
 */
export function edgesOf(pathData: string, geometry: ReferenceGeometry): Edge[] {
  const scale = geometry.pixelsPerEm / geometry.upem;
  const [xx, xy, yx, yy, tx, ty] = geometry.model;

  // Font units (y-UP) -> object device px (y-DOWN) -> model transform -> supersampled.
  const project = (ex: number, ey: number): [number, number] => {
    const ox = geometry.originX + scale * ex;
    const oy = geometry.originY - scale * ey;
    return [
      (xx * ox + yx * oy + tx) * SUPERSAMPLE,
      (xy * ox + yy * oy + ty) * SUPERSAMPLE,
    ];
  };

  const edges: Edge[] = [];
  let current: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  const lineTo = (to: [number, number]): void => {
    edges.push({ x0: current[0], y0: current[1], x1: to[0], y1: to[1] });
    current = to;
  };

  // Commands and their numeric arguments. `harfbuzzjs` emits absolute M/L/Q/C/Z with no separators
  // beyond commas and signs.
  const tokens =
    pathData.match(/[MLQCZmlqcz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  const number = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const command = tokens[i++];
    switch (command) {
      case "M": {
        current = project(number(), number());
        start = current;
        break;
      }
      case "L": {
        lineTo(project(number(), number()));
        break;
      }
      case "Q": {
        const control = project(number(), number());
        const end = project(number(), number());
        const from = current;
        const n = segmentsFor(
          Math.hypot(control[0] - from[0], control[1] - from[1]) +
            Math.hypot(end[0] - control[0], end[1] - control[1]),
        );
        for (let s = 1; s <= n; s += 1) {
          const t = s / n;
          const u = 1 - t;
          lineTo([
            u * u * from[0] + 2 * u * t * control[0] + t * t * end[0],
            u * u * from[1] + 2 * u * t * control[1] + t * t * end[1],
          ]);
        }
        break;
      }
      case "C": {
        const c1 = project(number(), number());
        const c2 = project(number(), number());
        const end = project(number(), number());
        const from = current;
        const n = segmentsFor(
          Math.hypot(c1[0] - from[0], c1[1] - from[1]) +
            Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) +
            Math.hypot(end[0] - c2[0], end[1] - c2[1]),
        );
        for (let s = 1; s <= n; s += 1) {
          const t = s / n;
          const u = 1 - t;
          lineTo([
            u * u * u * from[0] +
              3 * u * u * t * c1[0] +
              3 * u * t * t * c2[0] +
              t * t * t * end[0],
            u * u * u * from[1] +
              3 * u * u * t * c1[1] +
              3 * u * t * t * c2[1] +
              t * t * t * end[1],
          ]);
        }
        break;
      }
      case "Z":
      case "z": {
        lineTo(start);
        break;
      }
      default:
        throw new Error(
          `hb-gpu reference: unhandled path command "${command}" — a skipped stroke would read as a small RMS disagreement`,
        );
    }
  }
  return edges;
}

/**
 * Fill `edges` with the NONZERO winding rule at 8x, then box-downsample to device pixels.
 *
 * Nonzero and not even-odd: TrueType outlines are drawn with opposite winding for counters, and
 * even-odd would agree with nonzero on every glyph that has no self-intersection and then disagree
 * spectacularly on one that does.
 *
 * The downsample is `boxDownsample` from the fidelity probe rather than a local copy — its own doc
 * comment records why an unweighted mean is the only correct filter for an integer factor, and
 * having two of them is how the reference and the arms end up filtered differently.
 */
export function rasterizeReference(
  pathData: string,
  geometry: ReferenceGeometry,
): { data: Uint8Array; width: number; height: number } {
  const edges = edgesOf(pathData, geometry);
  const side = geometry.size * SUPERSAMPLE;
  const rgba = new Uint8Array(side * side * 4);

  const crossings: { x: number; winding: number }[] = [];
  for (let py = 0; py < side; py += 1) {
    // The sample is the pixel's CENTRE. Sampling its corner would shift the whole reference half a
    // supersample — 1/16 of a device pixel — straight into the registration budget.
    const sy = py + 0.5;
    crossings.length = 0;
    for (const edge of edges) {
      if (edge.y0 === edge.y1) continue;
      const top = Math.min(edge.y0, edge.y1);
      const bottom = Math.max(edge.y0, edge.y1);
      // Half-open in y, so a vertex shared by two edges is counted exactly once.
      if (sy < top || sy >= bottom) continue;
      const t = (sy - edge.y0) / (edge.y1 - edge.y0);
      crossings.push({
        x: edge.x0 + t * (edge.x1 - edge.x0),
        winding: edge.y1 > edge.y0 ? 1 : -1,
      });
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a.x - b.x);

    let winding = 0;
    for (let c = 0; c < crossings.length - 1; c += 1) {
      winding += crossings[c].winding;
      if (winding === 0) continue;
      const from = Math.max(0, Math.ceil(crossings[c].x - 0.5));
      const to = Math.min(side, Math.ceil(crossings[c + 1].x - 0.5));
      for (let px = from; px < to; px += 1) {
        const at = (py * side + px) * 4;
        rgba[at] = 255;
        rgba[at + 1] = 255;
        rgba[at + 2] = 255;
        rgba[at + 3] = 255;
      }
    }
  }

  // THE DILATION GOES HERE — after the fill, before the downsample. See `dilatePx`.
  if (geometry.dilatePx && geometry.dilatePx > 0) {
    const mask = new Uint8Array(side * side);
    for (let i = 0; i < mask.length; i += 1) mask[i] = rgba[i * 4 + 3] ? 1 : 0;
    const grown = dilateDisk(mask, side, side, geometry.dilatePx * SUPERSAMPLE);
    for (let i = 0; i < grown.length; i += 1) {
      const value = grown[i] ? 255 : 0;
      rgba[i * 4] = value;
      rgba[i * 4 + 1] = value;
      rgba[i * 4 + 2] = value;
      rgba[i * 4 + 3] = value;
    }
  }

  const small = boxDownsample(rgba, side, side, SUPERSAMPLE);
  const luma = new Uint8Array(small.width * small.height);
  for (let i = 0; i < luma.length; i += 1) luma[i] = small.data[i * 4];
  return { data: luma, width: small.width, height: small.height };
}
