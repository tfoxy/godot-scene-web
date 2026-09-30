import type { CompiledRefreshResult } from "./compiled-draw-list";
import type { DamageRect } from "./damage";
import {
  BLEND_MIX,
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_GLYPHS,
  DRAW_NINE_PATCH,
  DRAW_QUAD,
  type DrawList,
} from "./draw-list";
import type { StageProjection } from "./present";
import type { CanvasTextureHandle } from "./textures";

/** One caller-selected, independently paintable interval of the logical list. */
export interface RetainedRangeCandidate {
  /** Stable ownership key. It is also the final tie-breaker for eviction. */
  readonly key: string;
  /** Inclusive logical command index. */
  readonly start: number;
  /** Exclusive logical command index. */
  readonly end: number;
  /** Complete, unclipped design-space raster footprint. */
  readonly bounds: DamageRect;
  /**
   * Caller-owned pixel identity. Keep it stable only when the interval's pixels
   * are unchanged (a validated whole-device-pixel translation is placement,
   * not pixels); advance it for content, clip, order, scale, or font changes.
   */
  readonly pixelRevision: number;
}

export interface RetainedRangeCacheOptions {
  maxEntries?: number;
  maxDimension?: number;
  maxEntryStageAreaRatio?: number;
  maxCompositeStageAreaRatio?: number;
  maxResidentBytes?: number;
  maxPeakBytes?: number;
  gutterPixels?: number;
  maxUnseenFrames?: number;
}

export interface RetainedRangeCacheStats {
  plans: number;
  planFallbacks: number;
  realHits: number;
  composites: number;
  rebuilds: number;
  rasterPixels: number;
  compositePixels: number;
  entries: number;
  backings: number;
  bytes: number;
  peakBytes: number;
  allocations: number;
  deletes: number;
  evictions: number;
  contextRebuilds: number;
  readonly rebuildReasons: Record<string, number>;
  readonly fallbackReasons: Record<string, number>;
}

const PLAN_BRAND: unique symbol = Symbol("RetainedRangeSubstitutionPlan");

/**
 * An opaque, cache-issued execution plan. Consumers may retain and pass it, but
 * cannot manufacture substitutions or access backing textures.
 */
export interface RetainedRangeSubstitutionPlan {
  readonly [PLAN_BRAND]: true;
}

export interface RetainedRangeCache {
  readonly gl: WebGL2RenderingContext;
  readonly stats: RetainedRangeCacheStats;
  /**
   * Select, budget, and allocate this frame's substitutions. Candidate order is
   * priority order; accepted intervals are sorted into painter order in the
   * opaque result. When supplied, `compiledRefresh` is observed but never
   * consumed or mutated.
   */
  prepare(
    list: DrawList<CanvasTextureHandle | null>,
    projection: StageProjection,
    candidates: readonly RetainedRangeCandidate[],
    compiledRefresh?: CompiledRefreshResult,
  ): RetainedRangeSubstitutionPlan;
  /** Mark one backing's pixels stale without destroying its reusable storage. */
  invalidate(key: string, reason?: string): void;
  /** Mark every backing stale without destroying reusable storage. */
  invalidateAll(reason?: string): void;
  /**
   * Delete every live backing immediately while keeping this cache reusable.
   * The reason is attributed to each entry's next successful rebuild.
   */
  clear(reason?: string): void;
  /** Drop dead-context handles without issuing any GL delete. */
  invalidateContext(): void;
  /** Delete all resources while the context is live. */
  dispose(): void;
}

export const RETAINED_RANGE_DEFAULTS = Object.freeze({
  maxEntries: 8,
  maxDimension: 1024,
  maxEntryStageAreaRatio: 0.2,
  maxCompositeStageAreaRatio: 0.5,
  maxResidentBytes: 12 * 1024 * 1024,
  maxPeakBytes: 16 * 1024 * 1024,
  gutterPixels: 1,
  maxUnseenFrames: 120,
});

interface ResolvedOptions {
  maxEntries: number;
  maxDimension: number;
  maxEntryStageAreaRatio: number;
  maxCompositeStageAreaRatio: number;
  maxResidentBytes: number;
  maxPeakBytes: number;
  gutterPixels: number;
  maxUnseenFrames: number;
}

interface RetainedBackingTexture extends CanvasTextureHandle {
  revision: number;
}

interface TextureDependency {
  texture: CanvasTextureHandle;
  revision: number;
}

interface RetainedEntry {
  key: string;
  start: number;
  end: number;
  pixelRevision: number;
  textureDependencies: TextureDependency[];
  texture: RetainedBackingTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  bytes: number;
  valid: boolean;
  pendingReason: string;
  generation: number;
  lastSeenFrame: number;
  lastCompositeFrame: number;
}

export interface RetainedRangePlanEntryInternal {
  readonly entry: RetainedEntry;
  readonly key: string;
  readonly start: number;
  readonly end: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly needsRaster: boolean;
  readonly entryGeneration: number;
  readonly rasterProjection: StageProjection;
  rasterizedThisFrame: boolean;
}

export interface RetainedRangePlanStateInternal {
  readonly owner: object;
  readonly list: DrawList<CanvasTextureHandle | null>;
  readonly structuralRevision: number;
  readonly contentRevision: number;
  readonly contextGeneration: number;
  readonly projectionSignature: readonly number[];
  readonly compiledPlanGeneration: number | null;
  readonly compiledContentRevision: number | null;
  readonly entries: readonly RetainedRangePlanEntryInternal[];
  valid: boolean;
  presented: boolean;
}

interface CacheInternals {
  gl: WebGL2RenderingContext;
  entries: ReadonlyMap<string, RetainedEntry>;
  contextGeneration: number;
  presentedFrames: number;
  textureRevision: number;
  entryGeneration: number;
  stats: RetainedRangeCacheStats;
}

const planStates = new WeakMap<object, RetainedRangePlanStateInternal>();
const cacheInternals = new WeakMap<object, CacheInternals>();

function increment(record: Record<string, number>, reason: string): void {
  record[reason] = (record[reason] ?? 0) + 1;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveOptions(options: RetainedRangeCacheOptions): ResolvedOptions {
  return {
    maxEntries: Math.max(
      1,
      Math.floor(
        finitePositive(
          options.maxEntries ?? 0,
          RETAINED_RANGE_DEFAULTS.maxEntries,
        ),
      ),
    ),
    maxDimension: Math.max(
      1,
      Math.floor(
        finitePositive(
          options.maxDimension ?? 0,
          RETAINED_RANGE_DEFAULTS.maxDimension,
        ),
      ),
    ),
    maxEntryStageAreaRatio: finitePositive(
      options.maxEntryStageAreaRatio ?? 0,
      RETAINED_RANGE_DEFAULTS.maxEntryStageAreaRatio,
    ),
    maxCompositeStageAreaRatio: finitePositive(
      options.maxCompositeStageAreaRatio ?? 0,
      RETAINED_RANGE_DEFAULTS.maxCompositeStageAreaRatio,
    ),
    maxResidentBytes: Math.max(
      4,
      Math.floor(
        finitePositive(
          options.maxResidentBytes ?? 0,
          RETAINED_RANGE_DEFAULTS.maxResidentBytes,
        ),
      ),
    ),
    maxPeakBytes: Math.max(
      4,
      Math.floor(
        finitePositive(
          options.maxPeakBytes ?? 0,
          RETAINED_RANGE_DEFAULTS.maxPeakBytes,
        ),
      ),
    ),
    gutterPixels: Math.max(
      0,
      Math.floor(
        Number.isFinite(options.gutterPixels)
          ? (options.gutterPixels ?? RETAINED_RANGE_DEFAULTS.gutterPixels)
          : RETAINED_RANGE_DEFAULTS.gutterPixels,
      ),
    ),
    maxUnseenFrames: Math.max(
      1,
      Math.floor(
        finitePositive(
          options.maxUnseenFrames ?? 0,
          RETAINED_RANGE_DEFAULTS.maxUnseenFrames,
        ),
      ),
    ),
  };
}

function validBounds(bounds: DamageRect): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function intervalIsIndependent(
  list: DrawList<CanvasTextureHandle | null>,
  start: number,
  end: number,
): boolean {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > list.count
  ) {
    return false;
  }
  let outerDepth = 0;
  for (let index = 0; index < start; index += 1) {
    const kind = list.kindAt(index);
    if (kind === DRAW_CLIP_PUSH) outerDepth += 1;
    else if (kind === DRAW_CLIP_POP) outerDepth -= 1;
    if (outerDepth < 0) return false;
  }
  if (outerDepth !== 0) return false;
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const kind = list.kindAt(index);
    switch (kind) {
      case DRAW_QUAD:
      case DRAW_NINE_PATCH:
        if (list.ints[list.intOffsetAt(index)] !== BLEND_MIX) return false;
        break;
      case DRAW_GLYPHS:
        break;
      case DRAW_CLIP_PUSH:
        depth += 1;
        break;
      case DRAW_CLIP_POP:
        depth -= 1;
        if (depth < 0) return false;
        break;
      default:
        return false;
    }
  }
  return depth === 0;
}

function rasterRect(
  projection: StageProjection,
  bounds: DamageRect,
  gutter: number,
): { left: number; top: number; width: number; height: number } | null {
  const m = projection.toFramebuffer;
  // Stage projections are axis-aligned. Refuse an invented inverse for a future
  // rotated/sheared stage because it would make the tight FBO footprint false.
  if (m[1] !== 0 || m[2] !== 0 || m[0] <= 0 || m[3] <= 0) return null;
  const left = Math.floor(m[0] * bounds.x + m[4]) - gutter;
  const top = Math.floor(m[3] * bounds.y + m[5]) - gutter;
  const right = Math.ceil(m[0] * (bounds.x + bounds.width) + m[4]) + gutter;
  const bottom = Math.ceil(m[3] * (bounds.y + bounds.height) + m[5]) + gutter;
  const width = right - left;
  const height = bottom - top;
  return width > 0 && height > 0 ? { left, top, width, height } : null;
}

function makeRasterProjection(
  projection: StageProjection,
  rect: { left: number; top: number; width: number; height: number },
): StageProjection {
  const m = projection.toFramebuffer;
  return {
    designWidth: projection.designWidth,
    designHeight: projection.designHeight,
    toClip: new Float32Array([
      (2 * m[0]) / rect.width,
      (-2 * m[3]) / rect.height,
      (2 * (m[4] - rect.left)) / rect.width - 1,
      1 - (2 * (m[5] - rect.top)) / rect.height,
    ]),
    toFramebuffer: new Float32Array([
      m[0],
      0,
      0,
      m[3],
      m[4] - rect.left,
      m[5] - rect.top,
    ]),
    framebufferWidth: rect.width,
    framebufferHeight: rect.height,
  };
}

function projectionSignature(projection: StageProjection): readonly number[] {
  return [
    projection.framebufferWidth,
    projection.framebufferHeight,
    projection.designWidth,
    projection.designHeight,
    ...projection.toClip,
    ...projection.toFramebuffer,
  ];
}

function collectDependencies(
  list: DrawList<CanvasTextureHandle | null>,
  start: number,
  end: number,
): TextureDependency[] {
  const dependencies: TextureDependency[] = [];
  for (let index = start; index < end; index += 1) {
    const texture = list.textureAt(index);
    if (!texture || dependencies.some((item) => item.texture === texture))
      continue;
    dependencies.push({ texture, revision: texture.revision });
  }
  return dependencies;
}

function dependenciesEqual(
  left: readonly TextureDependency[],
  right: readonly TextureDependency[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].texture !== right[index].texture ||
      left[index].revision !== right[index].revision
    ) {
      return false;
    }
  }
  return true;
}

/** Internal executor access; deliberately not re-exported from the public barrel. */
export function retainedRangePlanState(
  plan: RetainedRangeSubstitutionPlan | undefined,
): RetainedRangePlanStateInternal | null {
  return plan ? (planStates.get(plan as object) ?? null) : null;
}

/** Internal executor validation; deliberately not re-exported. */
export function validateRetainedRangePlan(
  plan: RetainedRangePlanStateInternal,
  gl: WebGL2RenderingContext,
  list: DrawList<CanvasTextureHandle | null>,
  projection: StageProjection,
  compiledRefresh?: CompiledRefreshResult,
): boolean {
  const internals = cacheInternals.get(plan.owner);
  if (
    !internals ||
    internals.gl !== gl ||
    !plan.valid ||
    plan.presented ||
    plan.list !== list ||
    plan.structuralRevision !== list.structuralRevision ||
    plan.contentRevision !== list.contentRevision ||
    plan.contextGeneration !== internals.contextGeneration
  ) {
    return false;
  }
  const signature = projectionSignature(projection);
  if (
    signature.length !== plan.projectionSignature.length ||
    signature.some((value, index) => value !== plan.projectionSignature[index])
  ) {
    return false;
  }
  if (
    plan.compiledPlanGeneration !== null &&
    (!compiledRefresh ||
      compiledRefresh.planGeneration !== plan.compiledPlanGeneration ||
      compiledRefresh.contentRevision !== plan.compiledContentRevision)
  ) {
    return false;
  }
  let previousEnd = -1;
  for (const item of plan.entries) {
    if (
      item.start < previousEnd ||
      !intervalIsIndependent(list, item.start, item.end) ||
      internals.entries.get(item.key) !== item.entry ||
      item.entryGeneration !== item.entry.generation ||
      (!item.needsRaster && !item.entry.valid) ||
      !item.entry.framebuffer ||
      !item.entry.texture.texture ||
      item.entry.textureDependencies.some(
        (dependency) => dependency.texture.revision !== dependency.revision,
      )
    ) {
      return false;
    }
    previousEnd = item.end;
  }
  return true;
}

/** Internal executor notification; deliberately not re-exported. */
export function retainedRangeRasterized(
  plan: RetainedRangePlanStateInternal,
  item: RetainedRangePlanEntryInternal,
): void {
  const internals = cacheInternals.get(plan.owner);
  if (!internals) return;
  item.entry.valid = true;
  item.entry.texture.revision = ++internals.textureRevision;
  item.rasterizedThisFrame = true;
  internals.stats.rebuilds += 1;
  internals.stats.rasterPixels += item.width * item.height;
  increment(internals.stats.rebuildReasons, item.entry.pendingReason || "cold");
  item.entry.pendingReason = "";
}

/** Internal executor notification; deliberately not re-exported. */
export function retainedRangePlanFallback(
  plan: RetainedRangePlanStateInternal | null,
  reason: string,
): void {
  if (!plan?.valid) return;
  const internals = cacheInternals.get(plan.owner);
  if (!internals) return;
  plan.valid = false;
  internals.stats.planFallbacks += 1;
  increment(internals.stats.fallbackReasons, reason);
}

/** Internal executor notification; deliberately not re-exported. */
export function retainedRangePlanPresented(
  plan: RetainedRangePlanStateInternal,
): void {
  if (plan.presented) return;
  const internals = cacheInternals.get(plan.owner);
  if (!internals) return;
  internals.presentedFrames += 1;
  const frame = internals.presentedFrames;
  for (const item of plan.entries) {
    internals.stats.composites += 1;
    internals.stats.compositePixels += item.width * item.height;
    if (!item.rasterizedThisFrame) internals.stats.realHits += 1;
    item.entry.lastSeenFrame = frame;
    item.entry.lastCompositeFrame = frame;
  }
  plan.presented = true;
}

export function createRetainedRangeCache(
  gl: WebGL2RenderingContext,
  options: RetainedRangeCacheOptions = {},
): RetainedRangeCache {
  const limits = resolveOptions(options);
  const entries = new Map<string, RetainedEntry>();
  const stats: RetainedRangeCacheStats = {
    plans: 0,
    planFallbacks: 0,
    realHits: 0,
    composites: 0,
    rebuilds: 0,
    rasterPixels: 0,
    compositePixels: 0,
    entries: 0,
    backings: 0,
    bytes: 0,
    peakBytes: 0,
    allocations: 0,
    deletes: 0,
    evictions: 0,
    contextRebuilds: 0,
    rebuildReasons: Object.create(null) as Record<string, number>,
    fallbackReasons: Object.create(null) as Record<string, number>,
  };
  const owner = {};
  const internals: CacheInternals = {
    gl,
    entries,
    contextGeneration: 1,
    presentedFrames: 0,
    textureRevision: 0,
    entryGeneration: 0,
    stats,
  };
  cacheInternals.set(owner, internals);
  const clearedRebuildReasons = new Map<string, string>();
  let rebuildAfterContextLoss = false;
  let allocationRefusedByBudget = false;

  function syncCounts(): void {
    stats.entries = entries.size;
    stats.backings = entries.size;
  }

  function discardEntry(entry: RetainedEntry, deleteGl: boolean): void {
    if (deleteGl) {
      gl.deleteFramebuffer(entry.framebuffer);
      gl.deleteTexture(entry.texture.texture);
      stats.deletes += 1;
    }
    stats.bytes -= entry.bytes;
    entries.delete(entry.key);
    syncCounts();
  }

  function evict(entry: RetainedEntry): void {
    discardEntry(entry, true);
    stats.evictions += 1;
  }

  function evictionOrder(protectedKeys: ReadonlySet<string>): RetainedEntry[] {
    return [...entries.values()]
      .filter((entry) => !protectedKeys.has(entry.key))
      .sort(
        (left, right) =>
          left.lastCompositeFrame - right.lastCompositeFrame ||
          left.key.localeCompare(right.key),
      );
  }

  function makeRoom(
    key: string,
    oldBytes: number,
    newBytes: number,
    protectedKeys: ReadonlySet<string>,
  ): boolean {
    const isNew = !entries.has(key);
    const fits = (): boolean =>
      (!isNew || entries.size < limits.maxEntries) &&
      stats.bytes - oldBytes + newBytes <= limits.maxResidentBytes &&
      stats.bytes + newBytes <= limits.maxPeakBytes;
    const replacementProtected = new Set(protectedKeys);
    replacementProtected.add(key);
    for (const entry of evictionOrder(replacementProtected)) {
      if (fits()) break;
      evict(entry);
    }
    return fits();
  }

  function allocate(
    key: string,
    width: number,
    height: number,
    previous: RetainedEntry | undefined,
    protectedKeys: ReadonlySet<string>,
  ): RetainedEntry | null {
    const bytes = width * height * 4;
    allocationRefusedByBudget = false;
    if (!makeRoom(key, previous?.bytes ?? 0, bytes, protectedKeys)) {
      allocationRefusedByBudget = true;
      return null;
    }
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) {
      if (texture) gl.deleteTexture(texture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      return null;
    }
    const previousFramebuffer = gl.getParameter(
      gl.DRAW_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const previousTexture = gl.getParameter(
      gl.TEXTURE_BINDING_2D,
    ) as WebGLTexture | null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.DRAW_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    const complete =
      gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) ===
      gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousFramebuffer);
    gl.bindTexture(gl.TEXTURE_2D, previousTexture);
    if (!complete) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return null;
    }
    stats.peakBytes = Math.max(stats.peakBytes, stats.bytes + bytes);
    if (previous) discardEntry(previous, true);
    const clearedReason = previous ? undefined : clearedRebuildReasons.get(key);
    const entry: RetainedEntry = {
      key,
      start: 0,
      end: 0,
      pixelRevision: -1,
      textureDependencies: [],
      texture: { texture, width, height, revision: 0 },
      framebuffer,
      width,
      height,
      bytes,
      valid: false,
      pendingReason: previous ? "resize" : (clearedReason ?? "cold"),
      generation: ++internals.entryGeneration,
      lastSeenFrame: internals.presentedFrames,
      lastCompositeFrame: previous?.lastCompositeFrame ?? -1,
    };
    clearedRebuildReasons.delete(key);
    entries.set(key, entry);
    stats.bytes += bytes;
    stats.allocations += 1;
    if (rebuildAfterContextLoss) {
      stats.contextRebuilds += 1;
      rebuildAfterContextLoss = false;
    }
    syncCounts();
    return entry;
  }

  const cache: RetainedRangeCache = {
    gl,
    stats,

    prepare(list, projection, candidates, compiledRefresh) {
      stats.plans += 1;
      const protectedKeys = new Set<string>();
      const accepted: RetainedRangePlanEntryInternal[] = [];
      const stageArea =
        projection.framebufferWidth * projection.framebufferHeight;
      let compositeArea = 0;
      let allocationFailed = false;
      const seenKeys = new Set<string>();

      // Expiry is measured in successfully presented frames, not calls to
      // `prepare`: failed plans cannot age unrelated live entries.
      for (const entry of [...entries.values()]) {
        if (
          internals.presentedFrames - entry.lastSeenFrame >=
          limits.maxUnseenFrames
        ) {
          evict(entry);
        }
      }

      for (const candidate of candidates) {
        if (!candidate.key || seenKeys.has(candidate.key)) {
          increment(stats.fallbackReasons, "duplicate-key");
          continue;
        }
        seenKeys.add(candidate.key);
        if (
          !validBounds(candidate.bounds) ||
          !Number.isFinite(candidate.pixelRevision) ||
          !intervalIsIndependent(list, candidate.start, candidate.end)
        ) {
          increment(stats.fallbackReasons, "invalid-candidate");
          continue;
        }
        const rect = rasterRect(
          projection,
          candidate.bounds,
          limits.gutterPixels,
        );
        if (!rect) {
          increment(stats.fallbackReasons, "invalid-raster-bounds");
          continue;
        }
        const area = rect.width * rect.height;
        if (
          rect.width > limits.maxDimension ||
          rect.height > limits.maxDimension ||
          area > stageArea * limits.maxEntryStageAreaRatio
        ) {
          increment(stats.fallbackReasons, "entry-size-budget");
          continue;
        }
        if (
          compositeArea + area >
          stageArea * limits.maxCompositeStageAreaRatio
        ) {
          increment(stats.fallbackReasons, "frame-area-budget");
          continue;
        }
        if (
          accepted.some(
            (item) => candidate.start < item.end && candidate.end > item.start,
          )
        ) {
          increment(stats.fallbackReasons, "overlap");
          continue;
        }

        let entry = entries.get(candidate.key);
        if (
          entry &&
          (entry.width !== rect.width || entry.height !== rect.height)
        ) {
          const replacement = allocate(
            candidate.key,
            rect.width,
            rect.height,
            entry,
            protectedKeys,
          );
          if (!replacement) {
            if (allocationRefusedByBudget) {
              increment(stats.fallbackReasons, "replacement-budget");
              continue;
            }
            allocationFailed = true;
            increment(stats.fallbackReasons, "replacement-allocation");
            break;
          }
          entry = replacement;
        } else if (!entry) {
          const created = allocate(
            candidate.key,
            rect.width,
            rect.height,
            undefined,
            protectedKeys,
          );
          if (!created) {
            if (allocationRefusedByBudget) {
              increment(stats.fallbackReasons, "cold-budget");
              continue;
            }
            allocationFailed = true;
            increment(stats.fallbackReasons, "cold-allocation");
            break;
          }
          entry = created;
        }

        const dependencies = collectDependencies(
          list,
          candidate.start,
          candidate.end,
        );
        let reason = "";
        if (entry.start !== candidate.start || entry.end !== candidate.end)
          reason = entry.valid ? "interval" : entry.pendingReason;
        else if (entry.pixelRevision !== candidate.pixelRevision)
          reason = "content";
        else if (!dependenciesEqual(entry.textureDependencies, dependencies))
          reason = "resource";
        if (reason) {
          entry.valid = false;
          entry.pendingReason = reason;
          entry.generation = ++internals.entryGeneration;
        }
        entry.start = candidate.start;
        entry.end = candidate.end;
        entry.pixelRevision = candidate.pixelRevision;
        entry.textureDependencies = dependencies;
        protectedKeys.add(entry.key);
        compositeArea += area;
        accepted.push({
          entry,
          key: entry.key,
          start: candidate.start,
          end: candidate.end,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          needsRaster: !entry.valid,
          entryGeneration: entry.generation,
          rasterProjection: makeRasterProjection(projection, rect),
          rasterizedThisFrame: false,
        });
      }

      accepted.sort(
        (left, right) =>
          left.start - right.start || left.key.localeCompare(right.key),
      );
      const planObject = {
        [PLAN_BRAND]: true,
      } as RetainedRangeSubstitutionPlan;
      const state: RetainedRangePlanStateInternal = {
        owner,
        list,
        structuralRevision: list.structuralRevision,
        contentRevision: list.contentRevision,
        contextGeneration: internals.contextGeneration,
        projectionSignature: projectionSignature(projection),
        compiledPlanGeneration: compiledRefresh?.planGeneration ?? null,
        compiledContentRevision: compiledRefresh?.contentRevision ?? null,
        entries: accepted,
        valid: !allocationFailed,
        presented: false,
      };
      planStates.set(planObject as object, state);
      if (allocationFailed) {
        stats.planFallbacks += 1;
        increment(stats.fallbackReasons, "allocation-failure");
      }
      return planObject;
    },

    invalidate(key, reason = "explicit") {
      const entry = entries.get(key);
      if (!entry) return;
      entry.valid = false;
      entry.pendingReason = reason;
      entry.generation = ++internals.entryGeneration;
    },

    invalidateAll(reason = "explicit-all") {
      for (const entry of entries.values()) {
        entry.valid = false;
        entry.pendingReason = reason;
        entry.generation = ++internals.entryGeneration;
      }
    },

    clear(reason = "clear") {
      clearedRebuildReasons.clear();
      for (const entry of [...entries.values()]) {
        clearedRebuildReasons.set(entry.key, reason);
        discardEntry(entry, true);
      }
      internals.contextGeneration += 1;
    },

    invalidateContext() {
      entries.clear();
      clearedRebuildReasons.clear();
      stats.entries = 0;
      stats.backings = 0;
      stats.bytes = 0;
      internals.contextGeneration += 1;
      rebuildAfterContextLoss = true;
    },

    dispose() {
      for (const entry of [...entries.values()]) discardEntry(entry, true);
      clearedRebuildReasons.clear();
      internals.contextGeneration += 1;
      rebuildAfterContextLoss = false;
    },
  };
  return cache;
}
