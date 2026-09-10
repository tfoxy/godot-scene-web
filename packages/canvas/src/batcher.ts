import { colorMatricesEqual, IDENTITY_COLOR_MATRIX } from "./color";
import { BLEND_MIX, type BlendMode } from "./draw-list";

/**
 * The quad batcher: everything the executor knows about MERGING draws, with no
 * GL in it, so the flush decisions — the thing that decides whether a frame is 20
 * draw calls or 200 — are unit-testable rather than inferred from a profiler.
 *
 * WHY MULTI-TEXTURE BATCHING IS THE WHOLE POINT. Probing recorded scenes for
 * batch runs (a run = a maximal span of consecutive painting nodes sharing
 * texture + blend + clip + colour-matrix state) found combat at 152 runs over 183
 * painting nodes — 1.2 nodes per batch, i.e. essentially no batching — and 151 of
 * those 152 breaks were the TEXTURE alone. The map is the same story: 174 runs
 * over 825 nodes, 173 texture breaks. But the number of DISTINCT textures per
 * screen is only 24-65. So a batch that can hold many textures at once collapses
 * the run count towards the number of times the state that a batch CANNOT hold
 * changes — blend (0-16 per screen) and clip (0-26) — plus one flush per
 * texture-table refill. That is the difference between "tens of draws" and "one
 * draw per node", and it is why the slot table below is not an optimization to
 * add later.
 *
 * HOW A TEXTURE STOPS BREAKING A BATCH. Each batch binds up to
 * `maxTextureSlots` textures to consecutive texture units and each quad carries
 * the INDEX of the one it samples. The fragment shader turns that index back into
 * a sampler with a compiled `if` ladder (GLSL ES 3.00 forbids indexing a sampler
 * array with anything but a constant). A quad whose texture is not in the table
 * takes the next free slot; when the table is full the batch flushes and starts a
 * new table.
 *
 * COLOUR MATRICES GET THE SAME TREATMENT, for the same reason at a smaller scale:
 * the card screens carry 30-48 HSV-transformed quads, and one draw call each
 * would undo the texture win. A batch holds up to `maxColorMatrices` matrices in
 * a uniform array with the IDENTITY pinned at slot 0, so "no matrix" costs
 * nothing and needs no separate program. Identical matrices share a slot (the
 * table is deduped by value), which matters because those 30-48 quads are usually
 * a handful of distinct tints applied to many cards.
 *
 * ORDER IS NEVER REORDERED. Instances are drawn in the order they were pushed —
 * `drawArraysInstanced` rasterizes instance N before instance N+1, which is the
 * property a painter's-algorithm 2D renderer with no depth buffer depends on. So
 * this batcher only ever MERGES CONSECUTIVE commands; it never sorts, and it can
 * therefore be dropped in front of any draw list without changing what the frame
 * looks like. Bucketing non-adjacent commands by texture is a separate,
 * order-unsafe transformation that belongs to whoever BUILDS the list and knows
 * which spans are safe to permute.
 *
 * FOUR EXPLICIT CORNERS, NOT AN AFFINE BASIS. An instance carries `p0..p3`
 * outright (8 floats) rather than a 2x3 transform (6). The two extra floats buy
 * arbitrary quadrilaterals, which is what lets `./polyline`'s stroke segments AND
 * its join wedges (a triangle spelled as a quad with two coincident corners) ride
 * in the same buffer, the same shader and the same batch as every sprite. The
 * alternative — a second program and a mid-frame break for every polyline — costs
 * far more than 8 bytes per quad. The consequence to know about: UV interpolates
 * affinely per triangle, so a NON-parallelogram textured quad would show a seam
 * along the split diagonal. Nothing produces one (sprites and nine-patch bands
 * are affine images of a rect; the non-affine quads are untextured stroke
 * geometry), and if something ever does, the fix is to split it rather than to
 * make every quad pay for projective interpolation.
 */

/** Floats per instance. See the field offsets below for the layout. */
export const INSTANCE_FLOATS = 18;
/** Offset of `p0.x` — four `(x, y)` corners, in the unit-square order
 *  `(0,0)`, `(1,0)`, `(1,1)`, `(0,1)`. Design space. */
export const INSTANCE_CORNERS_OFFSET = 0;
/** Offset of the normalized source rect `(u0, v0, uSpan, vSpan)`. A span is
 *  NEGATIVE for a flipped axis, which is how `FLIP_H`/`FLIP_V` are carried. */
export const INSTANCE_UV_OFFSET = 8;
/** Offset of the PREMULTIPLIED tint, `(r, g, b, a)`. */
export const INSTANCE_COLOR_OFFSET = 12;
/** Offset of `(textureSlot, colorMatrixSlot)`. Matrix slot 0 is the identity. */
export const INSTANCE_SLOTS_OFFSET = 16;

/** Floats per colour-matrix slot. */
export const COLOR_MATRIX_FLOATS = 9;

/** The most texture units this batcher will ever ask for, whatever the GPU
 *  reports. Sixteen is the WebGL2 (GLES 3.0) guaranteed minimum for
 *  `MAX_TEXTURE_IMAGE_UNITS`, so asking for more buys a shader that some
 *  conformant device cannot link, in exchange for a batch boundary the measured
 *  key counts (24-65 distinct textures per screen) would still hit. */
export const MAX_TEXTURE_SLOTS = 16;

/** Default colour-matrix table size, including the identity at slot 0. */
export const DEFAULT_COLOR_MATRIX_SLOTS = 16;

/** What a batch binds to a texture unit. Structural on purpose: the batcher only
 *  needs the handle's IDENTITY to slot it, and a test can hand it a stand-in. */
export interface BatchTexture {
  readonly texture: WebGLTexture;
}

/**
 * The staging view a caller fills before {@link QuadBatcher.push}. Owned by the
 * batcher and reused, so a frame's worth of quads allocates nothing.
 */
export interface QuadInstance {
  /** Corner at unit-square `(0, 0)`, design space. */
  x0: number;
  y0: number;
  /** Corner at `(1, 0)`. */
  x1: number;
  y1: number;
  /** Corner at `(1, 1)`. */
  x2: number;
  y2: number;
  /** Corner at `(0, 1)`. */
  x3: number;
  y3: number;
  /** Normalized source origin (the texel under corner `(0, 0)`). */
  u0: number;
  v0: number;
  /** Normalized source span; negative mirrors the axis. */
  uSpan: number;
  vSpan: number;
  /** PREMULTIPLIED tint. */
  r: number;
  g: number;
  b: number;
  a: number;
}

export function createQuadInstance(): QuadInstance {
  return {
    x0: 0,
    y0: 0,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    x3: 0,
    y3: 0,
    u0: 0,
    v0: 0,
    uSpan: 1,
    vSpan: 1,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
  };
}

export type BatchFlushReason =
  /** The texture table was full and the next quad wanted a texture not in it. */
  | "textureSlots"
  /** The colour-matrix table was full and the next quad wanted a new matrix. */
  | "colorMatrices"
  /** The blend mode changed; GL blend state is per-draw, not per-instance. */
  | "blend"
  /** The clip scope changed; the scissor box is per-draw too. */
  | "clip"
  /**
   * A glyph run interrupted the quads.
   *
   * Not a state change this batcher could hold: the glyph pass replaces the program and the vertex
   * array outright, so the pending batch has to be DRAWN under the executor's state before the
   * pass runs. Counted separately from `blend` and `clip` because it is the one break a consumer
   * can remove by moving text, and a frame whose batching regressed should say so by axis.
   */
  | "glyphs"
  /** A screen-dependent effect interrupted the instanced-quad program. */
  | "effects"
  /** An indexed mesh interrupted the instanced-quad program. */
  | "meshes"
  /** A retained compiled GPU run takes over after direct quad staging. */
  | "compiled"
  /** End of the draw list (or an explicit flush by the caller). */
  | "end";

/**
 * One batch, handed to the sink. Every array is the batcher's own live storage —
 * valid only for the duration of the call, and only over the stated prefix.
 */
export interface Batch {
  /** Instance data: `quadCount * INSTANCE_FLOATS` floats from index 0. */
  readonly instances: Float32Array;
  readonly quadCount: number;
  /** Texture table. Entries `0 .. textureCount - 1` are the units to bind;
   *  everything past that is a stale `null` slot and must not be read. */
  readonly textures: readonly (BatchTexture | null)[];
  readonly textureCount: number;
  /** `colorMatrixCount * COLOR_MATRIX_FLOATS` floats; slot 0 is the identity. */
  readonly colorMatrices: Float32Array;
  readonly colorMatrixCount: number;
  readonly blend: BlendMode;
  /** The clip scope this batch was accumulated under (see `./clip-stack`). */
  readonly clipEpoch: number;
  readonly reason: BatchFlushReason;
}

export interface BatcherStats {
  /** Batches emitted, i.e. draw calls the executor issues for quads. */
  batches: number;
  /** Instances pushed. */
  quads: number;
  /** Texture-unit binds — `textureCount` summed over batches. */
  textureBinds: number;
  /** Largest single batch, in instances. */
  maxBatchQuads: number;
  /** Times the instance arena had to grow (should settle at zero). */
  arenaGrowths: number;
  flushes: Record<BatchFlushReason, number>;
}

export interface QuadBatcherOptions {
  /** Where a finished batch goes. Called synchronously from `push`/`flush`. */
  draw(batch: Batch): void;
  /** Texture units per batch; clamped to `[1, MAX_TEXTURE_SLOTS]`. */
  maxTextureSlots?: number;
  /** Colour-matrix slots per batch INCLUDING the identity; at least 1. */
  maxColorMatrices?: number;
  /** Initial instance-arena capacity, in quads. */
  quadCapacity?: number;
}

export interface QuadBatcher {
  readonly maxTextureSlots: number;
  readonly maxColorMatrices: number;
  /** Instances accumulated in the OPEN batch. */
  readonly quadCount: number;
  /** Texture slots taken in the open batch. */
  readonly textureCount: number;
  /** Colour-matrix slots taken in the open batch, including the identity. */
  readonly colorMatrixCount: number;
  readonly blend: BlendMode;
  readonly stats: BatcherStats;
  /** The reusable staging instance; fill it, then call {@link QuadBatcher.push}. */
  readonly quad: QuadInstance;
  /** Start a frame: drop any open batch WITHOUT drawing it, and zero the stats. */
  reset(): void;
  /** Flush first if the mode differs, then adopt it. */
  setBlend(blend: BlendMode): void;
  /** Flush first if the scope differs, then adopt it. */
  setClipEpoch(epoch: number): void;
  /**
   * Commit {@link QuadBatcher.quad}. `colorMatrix` is 9 row-major floats at
   * `colorMatrixOffset`, or `null` for the identity (which costs no slot).
   */
  push(
    texture: BatchTexture,
    colorMatrix?: ArrayLike<number> | null,
    colorMatrixOffset?: number,
  ): void;
  /** Emit the open batch, if it has anything in it. */
  flush(reason?: BatchFlushReason): void;
}

function emptyFlushCounts(): Record<BatchFlushReason, number> {
  return {
    textureSlots: 0,
    colorMatrices: 0,
    blend: 0,
    clip: 0,
    glyphs: 0,
    effects: 0,
    meshes: 0,
    compiled: 0,
    end: 0,
  };
}

function zeroFlushCounts(counts: Record<BatchFlushReason, number>): void {
  counts.textureSlots = 0;
  counts.colorMatrices = 0;
  counts.blend = 0;
  counts.clip = 0;
  counts.glyphs = 0;
  counts.effects = 0;
  counts.meshes = 0;
  counts.compiled = 0;
  counts.end = 0;
}

export function createQuadBatcher(options: QuadBatcherOptions): QuadBatcher {
  const maxTextureSlots = Math.max(
    1,
    Math.min(
      MAX_TEXTURE_SLOTS,
      Math.floor(options.maxTextureSlots ?? MAX_TEXTURE_SLOTS),
    ),
  );
  const maxColorMatrices = Math.max(
    1,
    Math.floor(options.maxColorMatrices ?? DEFAULT_COLOR_MATRIX_SLOTS),
  );
  const draw = options.draw;

  let instances = new Float32Array(
    Math.max(1, Math.floor(options.quadCapacity ?? 512)) * INSTANCE_FLOATS,
  );
  let quadCount = 0;

  // Linear tables, not Maps: at 16 entries a scan beats a hash, and there is
  // nothing to clear between batches beyond a counter.
  const textures: (BatchTexture | null)[] = new Array(maxTextureSlots).fill(
    null,
  );
  let textureCount = 0;

  const colorMatrices = new Float32Array(
    maxColorMatrices * COLOR_MATRIX_FLOATS,
  );
  colorMatrices.set(IDENTITY_COLOR_MATRIX, 0);
  let colorMatrixCount = 1;

  let blend: BlendMode = BLEND_MIX;
  let clipEpoch = 0;

  const quad = createQuadInstance();
  const stats: BatcherStats = {
    batches: 0,
    quads: 0,
    textureBinds: 0,
    maxBatchQuads: 0,
    arenaGrowths: 0,
    flushes: emptyFlushCounts(),
  };

  // One reused payload object: a sink that keeps it past the call is reading
  // whatever the next batch put there, which is what the `Batch` doc says.
  const batch: {
    instances: Float32Array;
    quadCount: number;
    textures: readonly (BatchTexture | null)[];
    textureCount: number;
    colorMatrices: Float32Array;
    colorMatrixCount: number;
    blend: BlendMode;
    clipEpoch: number;
    reason: BatchFlushReason;
  } = {
    instances,
    quadCount: 0,
    textures,
    textureCount: 0,
    colorMatrices,
    colorMatrixCount: 1,
    blend,
    clipEpoch: 0,
    reason: "end" as BatchFlushReason,
  };

  function flush(reason: BatchFlushReason = "end"): void {
    if (quadCount === 0) {
      // Nothing drawn under the old state; the tables are already empty.
      return;
    }
    batch.instances = instances;
    batch.quadCount = quadCount;
    batch.textureCount = textureCount;
    batch.colorMatrixCount = colorMatrixCount;
    batch.blend = blend;
    batch.clipEpoch = clipEpoch;
    batch.reason = reason;
    stats.batches += 1;
    stats.textureBinds += textureCount;
    if (quadCount > stats.maxBatchQuads) stats.maxBatchQuads = quadCount;
    stats.flushes[reason] += 1;
    draw(batch);
    quadCount = 0;
    for (let i = 0; i < textureCount; i += 1) textures[i] = null;
    textureCount = 0;
    colorMatrixCount = 1;
  }

  /** The texture's slot in the open batch, or -1 when the table is full. */
  function slotFor(texture: BatchTexture): number {
    for (let i = 0; i < textureCount; i += 1) {
      if (textures[i] === texture) return i;
    }
    if (textureCount >= maxTextureSlots) return -1;
    textures[textureCount] = texture;
    textureCount += 1;
    return textureCount - 1;
  }

  /** The matrix's slot, deduped by value, or -1 when the table is full. */
  function matrixSlotFor(matrix: ArrayLike<number>, offset: number): number {
    for (let i = 0; i < colorMatrixCount; i += 1) {
      if (
        colorMatricesEqual(
          colorMatrices,
          i * COLOR_MATRIX_FLOATS,
          matrix,
          offset,
        )
      ) {
        return i;
      }
    }
    if (colorMatrixCount >= maxColorMatrices) return -1;
    const at = colorMatrixCount * COLOR_MATRIX_FLOATS;
    for (let i = 0; i < COLOR_MATRIX_FLOATS; i += 1) {
      colorMatrices[at + i] = matrix[offset + i];
    }
    colorMatrixCount += 1;
    return colorMatrixCount - 1;
  }

  function ensureCapacity(): void {
    const needed = (quadCount + 1) * INSTANCE_FLOATS;
    if (needed <= instances.length) return;
    let capacity = Math.max(INSTANCE_FLOATS, instances.length);
    while (capacity < needed) capacity *= 2;
    const grown = new Float32Array(capacity);
    grown.set(instances);
    instances = grown;
    stats.arenaGrowths += 1;
  }

  return {
    maxTextureSlots,
    maxColorMatrices,
    get quadCount() {
      return quadCount;
    },
    get textureCount() {
      return textureCount;
    },
    get colorMatrixCount() {
      return colorMatrixCount;
    },
    get blend() {
      return blend;
    },
    stats,
    quad,

    reset() {
      quadCount = 0;
      for (let i = 0; i < textureCount; i += 1) textures[i] = null;
      textureCount = 0;
      colorMatrixCount = 1;
      blend = BLEND_MIX;
      clipEpoch = 0;
      stats.batches = 0;
      stats.quads = 0;
      stats.textureBinds = 0;
      stats.maxBatchQuads = 0;
      stats.arenaGrowths = 0;
      zeroFlushCounts(stats.flushes);
    },

    setBlend(next) {
      if (next === blend) return;
      flush("blend");
      blend = next;
    },

    setClipEpoch(epoch) {
      if (epoch === clipEpoch) return;
      flush("clip");
      clipEpoch = epoch;
    },

    push(texture, colorMatrix = null, colorMatrixOffset = 0) {
      let slot = slotFor(texture);
      if (slot < 0) {
        flush("textureSlots");
        slot = slotFor(texture);
      }
      let matrixSlot = 0;
      if (colorMatrix) {
        matrixSlot = matrixSlotFor(colorMatrix, colorMatrixOffset);
        if (matrixSlot < 0) {
          flush("colorMatrices");
          // The texture table went with it, so the slot has to be retaken.
          slot = slotFor(texture);
          matrixSlot = matrixSlotFor(colorMatrix, colorMatrixOffset);
          // A one-slot table holds nothing but the identity, so a batcher
          // configured that way cannot carry matrices at all: draw untransformed
          // rather than index a slot that does not exist.
          if (matrixSlot < 0) matrixSlot = 0;
        }
      }
      ensureCapacity();
      const at = quadCount * INSTANCE_FLOATS;
      instances[at] = quad.x0;
      instances[at + 1] = quad.y0;
      instances[at + 2] = quad.x1;
      instances[at + 3] = quad.y1;
      instances[at + 4] = quad.x2;
      instances[at + 5] = quad.y2;
      instances[at + 6] = quad.x3;
      instances[at + 7] = quad.y3;
      instances[at + 8] = quad.u0;
      instances[at + 9] = quad.v0;
      instances[at + 10] = quad.uSpan;
      instances[at + 11] = quad.vSpan;
      instances[at + 12] = quad.r;
      instances[at + 13] = quad.g;
      instances[at + 14] = quad.b;
      instances[at + 15] = quad.a;
      instances[at + 16] = slot;
      instances[at + 17] = matrixSlot;
      quadCount += 1;
      stats.quads += 1;
    },

    flush,
  };
}
