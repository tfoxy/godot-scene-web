/**
 * Nine-patch band algebra: one `DRAW_NINE_PATCH` command -> up to nine plain
 * quads. Pure (no GL, no state), so the geometry can be unit-tested on its own —
 * it is the part of the executor most likely to be wrong by half a pixel and the
 * part least able to say so on screen.
 *
 * WHERE THE RULES COME FROM. Godot does not expand a nine-patch into quads at
 * all: it draws ONE quad and remaps each fragment's coordinate with
 * `map_ninepatch_axis` (`drivers/gles3/shaders/canvas.glsl`). That function is
 * this module's specification, per axis:
 *
 * - `pixel < margin_begin` -> source coordinate `pixel`, i.e. the leading corner
 *   band is copied 1:1 at its native pixel size;
 * - `pixel >= draw_size - margin_end` -> source `tex_size - (draw_size - pixel)`,
 *   the trailing corner band, also 1:1;
 * - otherwise the centre band, stretched from `[margin_begin, tex_size -
 *   margin_end]` onto `[margin_begin, draw_size - margin_end]`.
 *
 * Expanding that into rects gives identical pixels for the STRETCH axis mode and
 * costs a handful of extra quads that batch with everything else — much cheaper
 * than the branchy per-fragment remap, and it keeps one shader for every command
 * kind. Godot's TILE / TILE_FIT modes are NOT reachable from the draw-list IR
 * (which carries no axis-stretch mode), so STRETCH — Godot's default — is what
 * this implements.
 *
 * DEGENERATE MARGINS FOLLOW THE SAME SPECIFICATION rather than a clamp. Note the
 * order of the branches above: when the two margins together exceed the
 * destination, the LEADING band wins the overlap and the trailing band keeps only
 * what is left. So this module truncates rather than rescaling the corners, which
 * is what the shader does. Bands that come out empty are dropped, so a patch
 * squeezed below its own margins expands to fewer than nine quads (down to one,
 * or to none at all when it has no area).
 *
 * A SOURCE centre that is empty or inverted (the margins meet or cross inside the
 * texture region) is dropped too. Godot's remap would produce a reversed source
 * range there — a mirrored smear — which is nobody's intent.
 */

/** One expanded band: a destination rect in the command's LOCAL space (before the
 *  quad's affine `m`), and the source rect it samples, in page pixels. */
export interface NinePatchBand {
  /** Destination, local space: x in `[0, w]`, y in `[0, h]`. */
  dstX: number;
  dstY: number;
  dstW: number;
  dstH: number;
  /** Source, page pixels — an absolute rect on the page, not relative to the region. */
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
}

/** The nine-patch inputs, matching `NinePatchView`'s fields. */
export interface NinePatchGeometry {
  /** Destination size in local units. */
  w: number;
  h: number;
  /** The patch REGION on the page, in page pixels. */
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  /** Insets into the region, page pixels (Godot `patch_margin_*`). */
  marginLeft: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
}

export function createNinePatchBand(): NinePatchBand {
  return {
    dstX: 0,
    dstY: 0,
    dstW: 0,
    dstH: 0,
    srcX: 0,
    srcY: 0,
    srcW: 0,
    srcH: 0,
  };
}

/** A reusable output buffer: nine bands is the hard maximum, so it never grows. */
export function createNinePatchBands(): NinePatchBand[] {
  return Array.from({ length: 9 }, createNinePatchBand);
}

/** One axis's up-to-three spans: destination `[start, end]` and the source
 *  `[start, end]` (relative to the region's origin) each maps from. */
interface AxisBands {
  dst: [number, number][];
  src: [number, number][];
}

function createAxisBands(): AxisBands {
  return {
    dst: [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    src: [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  };
}

// Module-scoped scratch, so an expansion allocates nothing. Safe because
// `splitAxis` is only ever called from `expandNinePatch`, synchronously, once per
// axis, and the values are consumed before the next call.
const H_BANDS = createAxisBands();
const V_BANDS = createAxisBands();

/**
 * Split ONE axis into its leading / centre / trailing spans, in the shader's
 * branch order. `size` is the destination extent, `texSize` the source extent,
 * `begin`/`end` the two margins. Writes into `out` and returns the number of
 * non-empty spans.
 */
function splitAxis(
  size: number,
  texSize: number,
  begin: number,
  end: number,
  out: AxisBands,
): number {
  const marginBegin = Math.max(0, begin);
  const marginEnd = Math.max(0, end);
  // `pixel < margin_begin` — truncated by the destination, never past it.
  const leadEnd = Math.min(marginBegin, Math.max(0, size));
  // `pixel >= draw_size - margin_end`, but the leading branch was tested FIRST,
  // so the trailing band starts no earlier than where the leading one ended.
  const trailStart = Math.max(leadEnd, size - marginEnd);

  let count = 0;
  // Leading corner: 1:1 from the region's own start.
  if (leadEnd > 0) {
    out.dst[count][0] = 0;
    out.dst[count][1] = leadEnd;
    out.src[count][0] = 0;
    out.src[count][1] = Math.min(leadEnd, texSize);
    count += 1;
  }
  // Centre: the region's middle stretched over the destination's middle. Dropped
  // when either side of that mapping is empty or inverted.
  const centreSrcBegin = marginBegin;
  const centreSrcEnd = texSize - marginEnd;
  if (trailStart > leadEnd && centreSrcEnd > centreSrcBegin) {
    out.dst[count][0] = leadEnd;
    out.dst[count][1] = trailStart;
    out.src[count][0] = centreSrcBegin;
    out.src[count][1] = centreSrcEnd;
    count += 1;
  }
  // Trailing corner: 1:1, measured back from the region's own end.
  if (size > trailStart) {
    const span = size - trailStart;
    out.dst[count][0] = trailStart;
    out.dst[count][1] = size;
    out.src[count][0] = Math.max(0, texSize - span);
    out.src[count][1] = texSize;
    count += 1;
  }
  return count;
}

/**
 * Expand a nine-patch into its bands, filling `out` (use
 * {@link createNinePatchBands}, which is always big enough) and returning how
 * many are live. `out` entries past the return value are stale and must not be
 * read.
 *
 * Returns 0 for a patch with no area — a zero-size destination or a zero-size
 * region draws nothing at all, which is not the same as drawing one empty band.
 */
export function expandNinePatch(
  patch: NinePatchGeometry,
  out: NinePatchBand[],
): number {
  const { w, h, srcW, srcH } = patch;
  if (!(w > 0) || !(h > 0) || !(srcW > 0) || !(srcH > 0)) return 0;

  const columns = splitAxis(
    w,
    srcW,
    patch.marginLeft,
    patch.marginRight,
    H_BANDS,
  );
  const rows = splitAxis(h, srcH, patch.marginTop, patch.marginBottom, V_BANDS);

  let count = 0;
  for (let row = 0; row < rows; row += 1) {
    const [dstTop, dstBottom] = V_BANDS.dst[row];
    const [srcTop, srcBottom] = V_BANDS.src[row];
    for (let column = 0; column < columns; column += 1) {
      const [dstLeft, dstRight] = H_BANDS.dst[column];
      const [srcLeft, srcRight] = H_BANDS.src[column];
      const band = out[count];
      band.dstX = dstLeft;
      band.dstY = dstTop;
      band.dstW = dstRight - dstLeft;
      band.dstH = dstBottom - dstTop;
      band.srcX = patch.srcX + srcLeft;
      band.srcY = patch.srcY + srcTop;
      band.srcW = srcRight - srcLeft;
      band.srcH = srcBottom - srcTop;
      count += 1;
    }
  }
  return count;
}
