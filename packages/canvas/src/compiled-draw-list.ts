import type { QuadInstance } from "./batcher";
import {
  commandDamageBounds,
  createDamageRect,
  type DamageRect,
} from "./damage";
import {
  BLEND_MIX,
  type BlendMode,
  createDrawListPatchView,
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_QUAD,
  type DrawList,
} from "./draw-list";
import {
  createReplayMaskScratch,
  type ReplayMaskScratch,
  type ReplaySelectionOptions,
} from "./replay";

/** A maximal run that can stay in the quad executor without a painter-order
 * barrier. Texture/matrix slots deliberately are not included: those limits are
 * context-specific and the live batcher remains their authority. */
export interface CompiledBatchDescriptor {
  readonly start: number;
  readonly end: number;
  readonly blend: BlendMode;
  readonly clipDepth: number;
}

export interface CompiledDrawListDiagnostics {
  planBuilds: number;
  structuralInvalidations: number;
  planReuses: number;
  /** CPU template ranges refreshed after safe command patches. */
  templateRangeUpdates: number;
  reusedSelections: number;
  reusedBatches: number;
}

export interface CompiledRefreshResult {
  readonly rebuilt: boolean;
  readonly rangeUpdates: number;
  /** Reused storage listing only commands patched since the prior refresh. */
  readonly changedCommands: readonly number[];
  /** Increments on every structural/overflow/context plan rebuild. */
  readonly planGeneration: number;
  /** Current DrawList content revision represented by this plan. */
  readonly contentRevision: number;
  /** Revision a cached consumer must match before applying this delta. */
  readonly deltaBaseRevision: number;
}

/**
 * A retained, allocation-free planning view of a stable draw list. It never
 * owns GL objects: the executor's grow-only instance buffer remains the single
 * GPU allocation authority. The WebGL executor may cache these templates in
 * plan-keyed GPU buffers. Quad templates remove transform/source/tint decoding from replay;
 * all non-quad commands deliberately take the direct executor path.
 */
export interface CompiledDrawList<TTexture = unknown> {
  readonly list: DrawList<TTexture>;
  readonly batches: readonly CompiledBatchDescriptor[];
  readonly diagnostics: CompiledDrawListDiagnostics;
  refresh(): CompiledRefreshResult;
  invalidate(): void;
  /** Fill the batcher's reusable staging instance from a cached quad template. */
  fillQuad(
    index: number,
    textureWidth: number,
    textureHeight: number,
    out: QuadInstance,
  ): boolean;
  /** Fill `out` with a cached conservative bound, or return null for unknown. */
  commandBounds(index: number, out: DamageRect): DamageRect | null;
  /** Reuse caller-owned selection storage and cached bounds. */
  select(
    damage: DamageRect,
    scratch: ReplayMaskScratch,
    options?: ReplaySelectionOptions,
  ): ReplayMaskScratch;
}

const TEMPLATE_FLOATS = 16;
const NO_TEMPLATE = -1;

export function compileDrawList<TTexture>(
  list: DrawList<TTexture>,
): CompiledDrawList<TTexture> {
  let seenStructural = -1;
  let seenContent = -1;
  let templateOffsets = new Int32Array(0);
  let templates = new Float32Array(0);
  let bounds = new Float32Array(0);
  let knownBounds = new Uint8Array(0);
  let batchDescriptors: CompiledBatchDescriptor[] = [];
  let invalidated = false;
  let planGeneration = 0;
  let deltaBaseRevision = 0;
  const patchView = createDrawListPatchView();
  const diagnostics: CompiledDrawListDiagnostics = {
    planBuilds: 0,
    structuralInvalidations: 0,
    planReuses: 0,
    templateRangeUpdates: 0,
    reusedSelections: 0,
    reusedBatches: 0,
  };
  const selectionOptions: ReplaySelectionOptions = {
    boundsAt(index, out) {
      return plan.commandBounds(index, out);
    },
  };
  const boundsScratch = createDamageRect();
  const changedCommands: number[] = [];
  const refreshResult: {
    rebuilt: boolean;
    rangeUpdates: number;
    changedCommands: readonly number[];
    planGeneration: number;
    contentRevision: number;
    deltaBaseRevision: number;
  } = {
    rebuilt: false,
    rangeUpdates: 0,
    changedCommands,
    planGeneration: 0,
    contentRevision: 0,
    deltaBaseRevision: 0,
  };

  function updateBounds(index: number): void {
    const value = commandDamageBounds(list, index, boundsScratch);
    const at = index * 4;
    if (!value) {
      knownBounds[index] = 0;
      return;
    }
    knownBounds[index] = 1;
    bounds[at] = value.x;
    bounds[at + 1] = value.y;
    bounds[at + 2] = value.width;
    bounds[at + 3] = value.height;
  }

  function updateQuadTemplate(index: number): void {
    const target = templateOffsets[index];
    if (target === NO_TEMPLATE) return;
    const source = list.floatOffsetAt(index);
    const floats = list.floats;
    const m0 = floats[source];
    const m1 = floats[source + 1];
    const m2 = floats[source + 2];
    const m3 = floats[source + 3];
    const m4 = floats[source + 4];
    const m5 = floats[source + 5];
    const w = floats[source + 6];
    const h = floats[source + 7];
    templates[target] = m4;
    templates[target + 1] = m5;
    templates[target + 2] = m0 * w + m4;
    templates[target + 3] = m1 * w + m5;
    templates[target + 4] = m0 * w + m2 * h + m4;
    templates[target + 5] = m1 * w + m3 * h + m5;
    templates[target + 6] = m2 * h + m4;
    templates[target + 7] = m3 * h + m5;
    templates[target + 8] = floats[source + 8];
    templates[target + 9] = floats[source + 9];
    templates[target + 10] = floats[source + 10];
    templates[target + 11] = floats[source + 11];
    templates[target + 12] = floats[source + 12];
    templates[target + 13] = floats[source + 13];
    templates[target + 14] = floats[source + 14];
    templates[target + 15] = floats[source + 15];
  }

  function rebuild(): void {
    const count = list.count;
    templateOffsets = new Int32Array(count);
    templateOffsets.fill(NO_TEMPLATE);
    templates = new Float32Array(count * TEMPLATE_FLOATS);
    bounds = new Float32Array(count * 4);
    knownBounds = new Uint8Array(count);
    batchDescriptors = [];
    let templateCount = 0;
    let clipDepth = 0;
    let runStart = -1;
    let runBlend: BlendMode = BLEND_MIX;
    let runClipDepth = 0;
    const closeRun = (end: number): void => {
      if (runStart < 0) return;
      batchDescriptors.push({
        start: runStart,
        end,
        blend: runBlend,
        clipDepth: runClipDepth,
      });
      runStart = -1;
    };
    for (let index = 0; index < count; index += 1) {
      const kind = list.kindAt(index);
      updateBounds(index);
      if (kind === DRAW_QUAD) {
        const blend = list.ints[list.intOffsetAt(index)] as BlendMode;
        if (runStart < 0 || runBlend !== blend || runClipDepth !== clipDepth) {
          closeRun(index);
          runStart = index;
          runBlend = blend;
          runClipDepth = clipDepth;
        }
        templateOffsets[index] = templateCount * TEMPLATE_FLOATS;
        templateCount += 1;
        updateQuadTemplate(index);
      } else {
        closeRun(index);
        if (kind === DRAW_CLIP_PUSH) clipDepth += 1;
        else if (kind === DRAW_CLIP_POP) clipDepth = Math.max(0, clipDepth - 1);
      }
    }
    closeRun(count);
    templates = templates.subarray(0, templateCount * TEMPLATE_FLOATS);
    seenStructural = list.structuralRevision;
    seenContent = list.contentRevision;
    deltaBaseRevision = seenContent;
    planGeneration += 1;
    invalidated = false;
    diagnostics.planBuilds += 1;
  }

  const plan: CompiledDrawList<TTexture> = {
    list,
    get batches() {
      return batchDescriptors;
    },
    diagnostics,
    refresh() {
      if (invalidated || seenStructural !== list.structuralRevision) {
        rebuild();
        changedCommands.length = 0;
        refreshResult.rebuilt = true;
        refreshResult.rangeUpdates = 0;
        refreshResult.planGeneration = planGeneration;
        refreshResult.contentRevision = seenContent;
        refreshResult.deltaBaseRevision = deltaBaseRevision;
        return refreshResult;
      }
      if (seenContent === list.contentRevision) {
        diagnostics.planReuses += 1;
        diagnostics.reusedBatches += batchDescriptors.length;
        refreshResult.rebuilt = false;
        refreshResult.rangeUpdates = 0;
        refreshResult.planGeneration = planGeneration;
        refreshResult.contentRevision = seenContent;
        refreshResult.deltaBaseRevision = deltaBaseRevision;
        return refreshResult;
      }
      const patches = list.readPatchesSince(seenContent, patchView);
      if (patches.overflowed) {
        rebuild();
        changedCommands.length = 0;
        refreshResult.rebuilt = true;
        refreshResult.rangeUpdates = 0;
        refreshResult.planGeneration = planGeneration;
        refreshResult.contentRevision = seenContent;
        refreshResult.deltaBaseRevision = deltaBaseRevision;
        return refreshResult;
      }
      let updates = 0;
      changedCommands.length = 0;
      for (let patch = 0; patch < patches.indices.length; patch += 1) {
        const index = patches.indices[patch];
        updateBounds(index);
        updateQuadTemplate(index);
        updates += 1;
        changedCommands.push(index);
      }
      deltaBaseRevision = seenContent;
      seenContent = list.contentRevision;
      diagnostics.planReuses += 1;
      diagnostics.reusedBatches += batchDescriptors.length;
      diagnostics.templateRangeUpdates += updates;
      refreshResult.rebuilt = false;
      refreshResult.rangeUpdates = updates;
      refreshResult.planGeneration = planGeneration;
      refreshResult.contentRevision = seenContent;
      refreshResult.deltaBaseRevision = deltaBaseRevision;
      return refreshResult;
    },
    invalidate() {
      invalidated = true;
      diagnostics.structuralInvalidations += 1;
    },
    fillQuad(index, textureWidth, textureHeight, out) {
      const at = templateOffsets[index];
      if (at === NO_TEMPLATE) return false;
      out.x0 = templates[at];
      out.y0 = templates[at + 1];
      out.x1 = templates[at + 2];
      out.y1 = templates[at + 3];
      out.x2 = templates[at + 4];
      out.y2 = templates[at + 5];
      out.x3 = templates[at + 6];
      out.y3 = templates[at + 7];
      const invWidth = 1 / Math.max(1, textureWidth);
      const invHeight = 1 / Math.max(1, textureHeight);
      out.u0 = templates[at + 8] * invWidth;
      out.v0 = templates[at + 9] * invHeight;
      out.uSpan = templates[at + 10] * invWidth;
      out.vSpan = templates[at + 11] * invHeight;
      out.r = templates[at + 12];
      out.g = templates[at + 13];
      out.b = templates[at + 14];
      out.a = templates[at + 15];
      const flags = list.ints[list.intOffsetAt(index) + 1];
      if ((flags & 1) !== 0) {
        out.u0 += out.uSpan;
        out.uSpan = -out.uSpan;
      }
      if ((flags & 2) !== 0) {
        out.v0 += out.vSpan;
        out.vSpan = -out.vSpan;
      }
      return true;
    },
    commandBounds(index, out) {
      if (index < 0 || index >= list.count || knownBounds[index] === 0)
        return null;
      const at = index * 4;
      out.x = bounds[at];
      out.y = bounds[at + 1];
      out.width = bounds[at + 2];
      out.height = bounds[at + 3];
      return out;
    },
    select(damage, scratch, options) {
      plan.refresh();
      diagnostics.reusedSelections += 1;
      selectionOptions.transform = options?.transform;
      selectionOptions.rasterOutset = options?.rasterOutset;
      selectionOptions.maxCommands = options?.maxCommands;
      selectionOptions.unknownBounds = options?.unknownBounds;
      return scratch.select(list, damage, selectionOptions);
    },
  };
  rebuild();
  return plan;
}

/** Convenience for consumers with no existing scratch. Retained loops should
 * create one scratch once and call `plan.select` instead. */
export function createCompiledReplayMask<TTexture>(
  plan: CompiledDrawList<TTexture>,
  damage: DamageRect,
  options?: ReplaySelectionOptions,
): ReplayMaskScratch {
  return plan.select(damage, createReplayMaskScratch(plan.list.count), options);
}
