import type { ClipRectView } from "./draw-list";

/**
 * The executor's clip scope: a stack of design-space rects, resolved to a GL
 * scissor box and (for the rare rounded clip) to a pair of fragment uniforms.
 *
 * WHY DESIGN SPACE, INTERSECTED BEFORE INTEGERIZING. Each level's rect is
 * intersected with its parent as FLOATS, in the scene's own coordinates, and only
 * the final result is mapped to framebuffer pixels and snapped. Integerizing at
 * every level instead would round the same edge repeatedly, and rounding OUTWARDS
 * (which is what a clip must do — see below) compounds: three nested clips on the
 * same edge would leak up to three pixels.
 *
 * WHY `floor(min)` / `ceil(max)`. A scissor box is whole pixels; the clip it
 * approximates is not. Rounding outwards keeps every pixel the clip PARTIALLY
 * covers, so content is never sheared off by a sub-pixel; the cost is that up to
 * one pixel of overdraw survives on each edge. The other choice (round inwards)
 * eats a visible line off the edge of every scrolling list, which is the failure
 * a reader will actually notice.
 *
 * THE FLIPPED SCISSOR ORIGIN. `gl.scissor` measures Y from the BOTTOM of the
 * drawing buffer; the design space here — like every 2D scene — measures it from
 * the top. So the box's Y is `framebufferHeight - bottomEdge`, not `topEdge`, and
 * getting it wrong produces a clip that is correct in size, correct in X, and
 * mirrored about the middle of the screen — which looks like a layout bug rather
 * than a scissor bug. `clip-stack.test.ts` pins the algebra and the pixel test
 * `nested clips` pins it on a real GPU.
 *
 * ROUNDED CORNERS ARE FRAGMENT WORK, and only for the INNERMOST rounded clip. A
 * scissor cannot express a radius, and a stencil pass per rounded scope would
 * cost more than the feature is worth at the measured population (rounded clips
 * are a handful per screen, nested rounded clips none). So the stack tracks the
 * deepest rounded rect currently open and hands it to the shader as a rounded-rect
 * distance test; every ancestor still clips squarely through the scissor, which is
 * exact for all of them except an outer rounded one's four corners.
 *
 * NON-AXIS-ALIGNED CLIPS FALL BACK TO THEIR AABB. A scissor box is axis-aligned,
 * so a clip can only be exact while the design->framebuffer transform is a scale
 * and a translate. It always is today (see `./present`), and the measured
 * population of rotated clips across the recorded scenes is zero — so rather than
 * carry a stencil path for a case that does not occur, a transform with rotation
 * or skew clips to the transformed rect's bounding box and increments
 * {@link ClipStack.rotatedFallbacks}. A caller that ever sees that counter move
 * has found the case that justifies the stencil.
 */

/** A resolved clip rect in DESIGN space. */
export interface ClipBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The innermost rounded clip, in DESIGN space; `radius <= 0` means none is open. */
export interface RoundedClip {
  centerX: number;
  centerY: number;
  halfWidth: number;
  halfHeight: number;
  radius: number;
}

/** A GL scissor box: framebuffer pixels, origin BOTTOM-LEFT. */
export interface ScissorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A design->framebuffer-pixel affine, in the draw-list's `Transform2D` order
 * `[xx, xy, yx, yy, originX, originY]`: `px = xx*x + yx*y + ox`, `py = xy*x +
 * yy*y + oy`, with `py` measured DOWN from the top of the buffer.
 */
export type PixelTransform = ArrayLike<number>;

export interface ClipStack {
  /** Open clip scopes. */
  readonly depth: number;
  /** Bumped by every push/pop/reset: the batcher's cheap "did the scope change". */
  readonly epoch: number;
  /** Clips that could not be expressed as an axis-aligned scissor (see the module note). */
  readonly rotatedFallbacks: number;
  /** The intersected clip in design space, or `null` when nothing is clipped. */
  bounds(): ClipBounds | null;
  /** The innermost rounded clip, or `null`. */
  rounded(): RoundedClip | null;
  push(clip: ClipRectView): void;
  pop(): void;
  /** Start a frame: drop every scope (a list may end unbalanced) AND the frame's
   *  {@link ClipStack.rotatedFallbacks} count, which is per-frame like every
   *  other executor statistic. */
  reset(): void;
  /**
   * The current clip as a scissor box against a `width`x`height` framebuffer,
   * written into `out`. With nothing clipped this is the whole framebuffer.
   */
  scissor(
    transform: PixelTransform,
    width: number,
    height: number,
    out: ScissorBox,
  ): ScissorBox;
}

interface ClipEntry extends ClipBounds {
  roundedCenterX: number;
  roundedCenterY: number;
  roundedHalfWidth: number;
  roundedHalfHeight: number;
  roundedRadius: number;
}

function createEntry(): ClipEntry {
  return {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    roundedCenterX: 0,
    roundedCenterY: 0,
    roundedHalfWidth: 0,
    roundedHalfHeight: 0,
    roundedRadius: 0,
  };
}

export function createScissorBox(): ScissorBox {
  return { x: 0, y: 0, width: 0, height: 0 };
}

/** True when `transform` is a pure scale + translate, i.e. a scissor can be exact. */
export function isAxisAligned(transform: PixelTransform): boolean {
  return transform[1] === 0 && transform[2] === 0;
}

export function createClipStack(): ClipStack {
  const entries: ClipEntry[] = [];
  let depth = 0;
  let epoch = 0;
  let rotatedFallbacks = 0;
  const boundsOut: ClipBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const roundedOut: RoundedClip = {
    centerX: 0,
    centerY: 0,
    halfWidth: 0,
    halfHeight: 0,
    radius: 0,
  };

  return {
    get depth() {
      return depth;
    },
    get epoch() {
      return epoch;
    },
    get rotatedFallbacks() {
      return rotatedFallbacks;
    },

    bounds() {
      if (depth === 0) return null;
      const top = entries[depth - 1];
      boundsOut.minX = top.minX;
      boundsOut.minY = top.minY;
      boundsOut.maxX = top.maxX;
      boundsOut.maxY = top.maxY;
      return boundsOut;
    },

    rounded() {
      if (depth === 0) return null;
      const top = entries[depth - 1];
      if (!(top.roundedRadius > 0)) return null;
      roundedOut.centerX = top.roundedCenterX;
      roundedOut.centerY = top.roundedCenterY;
      roundedOut.halfWidth = top.roundedHalfWidth;
      roundedOut.halfHeight = top.roundedHalfHeight;
      roundedOut.radius = top.roundedRadius;
      return roundedOut;
    },

    push(clip) {
      while (entries.length <= depth) entries.push(createEntry());
      const entry = entries[depth];
      // The one-axis slack, applied BEFORE the intersection: a re-laid-out scene
      // can legitimately paint a little wider than the clip Godot recorded, and
      // only ever on x (see `ClipRectView.outsetX`).
      const outset = Math.max(0, clip.outsetX);
      let minX = clip.x - outset;
      let minY = clip.y;
      let maxX = clip.x + clip.w + outset;
      let maxY = clip.y + clip.h;
      const parent = depth > 0 ? entries[depth - 1] : null;
      if (parent) {
        if (parent.minX > minX) minX = parent.minX;
        if (parent.minY > minY) minY = parent.minY;
        if (parent.maxX < maxX) maxX = parent.maxX;
        if (parent.maxY < maxY) maxY = parent.maxY;
      }
      entry.minX = minX;
      entry.minY = minY;
      // An empty intersection stays empty rather than inverting.
      entry.maxX = Math.max(minX, maxX);
      entry.maxY = Math.max(minY, maxY);

      if (clip.cornerRadius > 0) {
        // The rounded test follows THIS rect's own corners (post-outset), not the
        // intersection's — the intersection's edges are already exact through the
        // scissor, and rounding them would round a corner the scene never had.
        const halfWidth = (clip.w + outset * 2) / 2;
        const halfHeight = clip.h / 2;
        entry.roundedCenterX = clip.x - outset + halfWidth;
        entry.roundedCenterY = clip.y + halfHeight;
        entry.roundedHalfWidth = Math.max(0, halfWidth);
        entry.roundedHalfHeight = Math.max(0, halfHeight);
        // A radius past half the shorter side is a capsule/circle, not a rect
        // with rounded corners; clamping matches how every rounded-rect SDF and
        // every CSS `border-radius` resolves the same overflow.
        entry.roundedRadius = Math.min(
          clip.cornerRadius,
          entry.roundedHalfWidth,
          entry.roundedHalfHeight,
        );
      } else if (parent) {
        entry.roundedCenterX = parent.roundedCenterX;
        entry.roundedCenterY = parent.roundedCenterY;
        entry.roundedHalfWidth = parent.roundedHalfWidth;
        entry.roundedHalfHeight = parent.roundedHalfHeight;
        entry.roundedRadius = parent.roundedRadius;
      } else {
        entry.roundedRadius = 0;
      }

      depth += 1;
      epoch += 1;
    },

    pop() {
      if (depth === 0) {
        throw new RangeError("clip stack pop with no clip pushed");
      }
      depth -= 1;
      epoch += 1;
    },

    reset() {
      if (depth !== 0) epoch += 1;
      depth = 0;
      rotatedFallbacks = 0;
    },

    scissor(transform, width, height, out) {
      if (depth === 0) {
        out.x = 0;
        out.y = 0;
        out.width = Math.max(0, width);
        out.height = Math.max(0, height);
        return out;
      }
      const top = entries[depth - 1];
      const xx = transform[0];
      const xy = transform[1];
      const yx = transform[2];
      const yy = transform[3];
      const ox = transform[4];
      const oy = transform[5];
      if (xy !== 0 || yx !== 0) rotatedFallbacks += 1;

      // The transformed rect's four corners; under an axis-aligned transform two
      // of them are redundant and this is exactly a two-point map, so there is no
      // separate fast path to get wrong. Under a rotated one it is the AABB the
      // module note describes.
      let minPx = Number.POSITIVE_INFINITY;
      let minPy = Number.POSITIVE_INFINITY;
      let maxPx = Number.NEGATIVE_INFINITY;
      let maxPy = Number.NEGATIVE_INFINITY;
      for (let corner = 0; corner < 4; corner += 1) {
        const x = corner === 0 || corner === 3 ? top.minX : top.maxX;
        const y = corner < 2 ? top.minY : top.maxY;
        const px = xx * x + yx * y + ox;
        const py = xy * x + yy * y + oy;
        if (px < minPx) minPx = px;
        if (px > maxPx) maxPx = px;
        if (py < minPy) minPy = py;
        if (py > maxPy) maxPy = py;
      }

      const left = clampInt(Math.floor(minPx), 0, width);
      const right = clampInt(Math.ceil(maxPx), 0, width);
      const top_ = clampInt(Math.floor(minPy), 0, height);
      const bottom = clampInt(Math.ceil(maxPy), 0, height);
      out.x = left;
      out.width = Math.max(0, right - left);
      // The flip: GL measures the box from the BOTTOM of the drawing buffer.
      out.y = Math.max(0, height - bottom);
      out.height = Math.max(0, bottom - top_);
      return out;
    },
  };
}

function clampInt(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return value < 0 ? low : high;
  return value < low ? low : value > high ? high : value;
}
