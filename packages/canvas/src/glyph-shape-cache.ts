import type { HbGpuShapeOptions } from "@godot-scene-web/hb-gpu";

export interface GlyphShapeCacheStats {
  shapeHits: number;
  shapeMisses: number;
  shapeEntries: number;
  shapeGlyphs: number;
  shapeEvicted: number;
}

export interface CachedShape {
  count: number;
  slots: Int32Array;
  /** `[penX + xOffset, penY + yOffset]`, in font units. */
  pen: Int32Array;
  advanceX: number;
  advanceY: number;
  usedAt: number;
}

export type CachedShapeData = Omit<CachedShape, "usedAt">;

/**
 * Small bounded cache for HarfBuzz's scale-free font-unit output. Unknown options deliberately
 * bypass it: forwarding a future shaping option must not accidentally reuse an older result.
 */
export class GlyphShapeCache {
  private readonly byFace = new Map<number, Map<string, CachedShape>>();
  private tick = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxGlyphs: number,
    private readonly stats: GlyphShapeCacheStats,
  ) {}

  key(text: string, options: HbGpuShapeOptions | undefined): string | null {
    if (!options || Object.keys(options).length === 0) return text;
    const allowed = new Set(["direction", "script", "language", "features"]);
    if (Object.keys(options).some((name) => !allowed.has(name))) return null;
    // Features are an ordered OpenType program: sorting would change a caller's request.
    return JSON.stringify([
      options.direction,
      options.script,
      options.language,
      options.features,
      text,
    ]);
  }

  get(faceId: number, key: string): CachedShape | null {
    if (this.maxEntries === 0 || this.maxGlyphs === 0) return null;
    const entry = this.byFace.get(faceId)?.get(key);
    if (!entry) return null;
    entry.usedAt = ++this.tick;
    this.stats.shapeHits += 1;
    return entry;
  }

  put(faceId: number, key: string, shape: CachedShapeData): void {
    if (
      this.maxEntries === 0 ||
      this.maxGlyphs === 0 ||
      shape.count > this.maxGlyphs
    )
      return;
    while (
      this.stats.shapeEntries >= this.maxEntries ||
      this.stats.shapeGlyphs + shape.count > this.maxGlyphs
    ) {
      let oldestFace: Map<string, CachedShape> | undefined;
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const entries of this.byFace.values()) {
        for (const [candidateKey, candidate] of entries) {
          if (candidate.usedAt < oldest) {
            oldest = candidate.usedAt;
            oldestFace = entries;
            oldestKey = candidateKey;
          }
        }
      }
      if (!oldestFace || oldestKey === undefined) break;
      const removed = oldestFace.get(oldestKey)!;
      oldestFace.delete(oldestKey);
      this.stats.shapeEntries -= 1;
      this.stats.shapeGlyphs -= removed.count;
      this.stats.shapeEvicted += 1;
    }
    let entries = this.byFace.get(faceId);
    if (!entries) {
      entries = new Map();
      this.byFace.set(faceId, entries);
    }
    entries.set(key, { ...shape, usedAt: ++this.tick });
    this.stats.shapeEntries += 1;
    this.stats.shapeGlyphs += shape.count;
  }

  miss(): void {
    this.stats.shapeMisses += 1;
  }

  clear(): void {
    this.byFace.clear();
    this.stats.shapeEntries = 0;
    this.stats.shapeGlyphs = 0;
  }
}
