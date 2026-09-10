/**
 * Constant-width polyline -> quads, so a `DRAW_POLYLINE` goes through the SAME
 * instance buffer, the same shader and the same batch as everything else instead
 * of forcing a second program and a mid-frame draw break.
 *
 * That is possible because the batcher's instance carries four EXPLICIT corners
 * rather than an affine basis (see `./batcher`): a quad instance is any
 * quadrilateral, and a quadrilateral with its last two corners coincident is a
 * triangle. So a stroke is emitted as
 *
 * - one parallelogram per segment (the segment offset by ±width/2 along its
 *   normal), and
 * - one triangle per interior vertex, filling the notch on the OUTSIDE of the
 *   turn.
 *
 * JOINS ARE BEVEL, CAPS ARE BUTT — the first pass the wave-1 brief allows, and a
 * deliberate choice rather than an oversight:
 *
 * - a MITER join needs the two segment edges extended to their intersection,
 *   which runs away to infinity as the turn approaches a reversal and therefore
 *   needs a miter limit that itself falls back to... a bevel. Two code paths for
 *   a shape that differs from the bevel only inside a `width/2` disc.
 * - a ROUND join needs an arc, i.e. a fan of triangles whose count depends on the
 *   turn angle and the on-screen width — the one thing in this file that would
 *   make its output size unpredictable.
 *
 * The bevel differs from both only within half a stroke width of a vertex, and
 * the measured population of polylines in the recorded scenes this executor was
 * sized against is ZERO (the paint-source mix is texture/text/particles/spine/
 * solid). Upgrading to round joins is local to this file: emit a fan instead of
 * the single wedge triangle in the interior-vertex loop.
 *
 * Self-overlap: at a sharp turn the two segment parallelograms overlap near the
 * vertex, so a translucent stroke double-composites there. Godot's own
 * `draw_polyline` has the same artefact; fixing it needs a stencil or a
 * single-pass SDF, neither of which belongs in wave 1.
 */

/** Floats per emitted quad: four `(x, y)` corners in draw-list local space. */
export const POLYLINE_QUAD_FLOATS = 8;

/**
 * The most quads a `pointCount`-point stroke can produce: one per segment plus
 * one per interior vertex. Sizes a caller's output buffer exactly.
 */
export function polylineQuadCapacity(pointCount: number): number {
  if (pointCount < 2) return 0;
  return pointCount - 1 + Math.max(0, pointCount - 2);
}

/**
 * Tessellate `points` (flattened `x, y, x, y, …`, the draw-list's own layout)
 * into quads, writing `POLYLINE_QUAD_FLOATS` floats per quad into `out` from
 * `outOffset`. Returns the number of quads written.
 *
 * Corners are written in the batcher's unit-square order — `(0,0)`, `(1,0)`,
 * `(1,1)`, `(0,1)` — so a triangle is spelled by repeating the last corner.
 *
 * Zero-length segments are skipped (they have no direction to offset along, and
 * a duplicated point is a common artefact of a resampled path); a vertex whose
 * incoming or outgoing segment was skipped gets no join wedge, because there is
 * no notch to fill.
 */
export function expandPolyline(
  points: ArrayLike<number>,
  pointCount: number,
  width: number,
  out: Float32Array,
  outOffset = 0,
): number {
  const half = width / 2;
  if (pointCount < 2 || !(half > 0)) return 0;

  let at = outOffset;
  let quads = 0;
  // The previous LIVE segment's unit normal, or null when there was none (start
  // of the stroke, or the previous segment was degenerate).
  let previousNormalX = 0;
  let previousNormalY = 0;
  let hasPrevious = false;
  let previousDirX = 0;
  let previousDirY = 0;

  for (let i = 0; i + 1 < pointCount; i += 1) {
    const ax = points[i * 2];
    const ay = points[i * 2 + 1];
    const bx = points[i * 2 + 2];
    const by = points[i * 2 + 3];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (!(length > 0)) {
      hasPrevious = false;
      continue;
    }
    const dirX = dx / length;
    const dirY = dy / length;
    // The LEFT normal (the direction rotated a quarter turn), scaled to half the
    // stroke width, so `±normal` are the two edges of this segment.
    const normalX = -dirY * half;
    const normalY = dirX * half;

    if (hasPrevious) {
      // The notch sits on the OUTSIDE of the turn: `cross > 0` is a turn towards
      // the left normal, so the gap opens on `-normal`, and vice versa.
      const cross = previousDirX * dirY - previousDirY * dirX;
      if (cross !== 0) {
        const side = cross > 0 ? -1 : 1;
        // A triangle: the vertex, and the two segment edges that end/start on the
        // outside of the turn. Third corner repeated — see the module note.
        out[at] = ax;
        out[at + 1] = ay;
        out[at + 2] = ax + previousNormalX * side;
        out[at + 3] = ay + previousNormalY * side;
        out[at + 4] = ax + normalX * side;
        out[at + 5] = ay + normalY * side;
        out[at + 6] = ax + normalX * side;
        out[at + 7] = ay + normalY * side;
        at += POLYLINE_QUAD_FLOATS;
        quads += 1;
      }
    }

    out[at] = ax + normalX;
    out[at + 1] = ay + normalY;
    out[at + 2] = bx + normalX;
    out[at + 3] = by + normalY;
    out[at + 4] = bx - normalX;
    out[at + 5] = by - normalY;
    out[at + 6] = ax - normalX;
    out[at + 7] = ay - normalY;
    at += POLYLINE_QUAD_FLOATS;
    quads += 1;

    previousNormalX = normalX;
    previousNormalY = normalY;
    previousDirX = dirX;
    previousDirY = dirY;
    hasPrevious = true;
  }

  return quads;
}
