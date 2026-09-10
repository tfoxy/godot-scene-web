import {
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_EXTERNAL_EFFECT,
  DRAW_GLYPHS,
  DRAW_NINE_PATCH,
  DRAW_POLYLINE,
  DRAW_QUAD,
  DRAW_SCREEN_EFFECT,
  DRAW_TEXTURED_MESH,
  type DrawList,
} from "./draw-list";

/** A top-left-origin, axis-aligned rectangle. It is used in design or backing
 * pixel space; the caller decides which, and {@link transformDamageRect} moves
 * between them conservatively. */
export interface DamageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Public retained-rendering vocabulary for a rectangle that needs repainting. */
export type DirtyRect = DamageRect;

/** A conservative rectangle reported by one draw command when its extent is
 * known. `commandDamageBounds` returns `null` for a full/direct fallback. */
export type CommandBounds = DamageRect;

/** A tile selected by {@link DamageTiles}. */
export interface DamageTile extends DamageRect {
  column: number;
  row: number;
}

/** A tile accumulator for retaining a backing surface without retaining an
 * unbounded list of tiny invalidations. */
export interface DamageTiles {
  readonly width: number;
  readonly height: number;
  /** Physical backing pixels in one tile. Retained callers use 64×64 tiles. */
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly columns: number;
  readonly rows: number;
  readonly tileCount: number;
  readonly dirtyCount: number;
  /** `dirtyCount / tileCount`, or zero for an empty surface. */
  readonly coverage: number;
  readonly dirty: boolean;
  resize(width: number, height: number): void;
  mark(rect: DamageRect | null): void;
  clear(): void;
  /** The exact backing-pixel tiles currently marked, in paint order. */
  tiles(): readonly DamageTile[];
  /**
   * Visit marked tiles without materialising `DamageTile` objects. The same
   * mutable tile view is passed each time, so read it synchronously and do not
   * retain it. This is the retained-frame hot path; `tiles()` is only a
   * diagnostics convenience.
   */
  forEach(callback: (tile: DamageTile) => void): void;
  /**
   * Visit an exact, non-overlapping rectangular cover of the marked tiles.
   * Horizontally adjacent tiles are joined, then identical row runs are joined
   * vertically. No clean pixel is included, so each region is safe to pass to
   * a scissored retained replay independently. As with {@link forEach}, the
   * rectangle is a reusable mutable view and must not be retained.
   */
  forEachRegion(callback: (region: DamageRect) => void): void;
  /** Return the marked tiles and clear the accumulator. */
  consume(): readonly DamageTile[];
}

/** Retained replay uses fixed physical-pixel tiles, never CSS pixels. */
export const RETAINED_DAMAGE_TILE_SIZE = 64;
/** The largest tile coverage that is worth planning for retained replay. */
export const RETAINED_MAX_DAMAGE_COVERAGE = 0.2;

/** A `Transform2D` mapping the rect's coordinates into another top-left space. */
export type DamageTransform = ArrayLike<number>;

export function createDamageRect(): DamageRect {
  return { x: 0, y: 0, width: 0, height: 0 };
}

export function isDamageEmpty(rect: DamageRect): boolean {
  return !(rect.width > 0 && rect.height > 0);
}

/** Expand in the rectangle's own coordinate space without mutating inputs. */
export function outsetDamageRect(
  rect: DamageRect,
  outset: number,
  out: DamageRect = createDamageRect(),
): DamageRect | null {
  if (!isFiniteDamageRect(rect) || !Number.isFinite(outset) || outset < 0) {
    return null;
  }
  out.x = rect.x - outset;
  out.y = rect.y - outset;
  out.width = rect.width + outset * 2;
  out.height = rect.height + outset * 2;
  return isFiniteDamageRect(out) ? out : null;
}

/** True when two half-open rectangles overlap. Touching edges do not repaint. */
export function damageIntersects(a: DamageRect, b: DamageRect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    b.width > 0 &&
    b.height > 0 &&
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Expand `out` to cover both input rectangles. */
export function unionDamageRect(
  a: DamageRect,
  b: DamageRect,
  out: DamageRect = createDamageRect(),
): DamageRect {
  if (isDamageEmpty(a)) {
    out.x = b.x;
    out.y = b.y;
    out.width = Math.max(0, b.width);
    out.height = Math.max(0, b.height);
    return out;
  }
  if (isDamageEmpty(b)) {
    out.x = a.x;
    out.y = a.y;
    out.width = Math.max(0, a.width);
    out.height = Math.max(0, a.height);
    return out;
  }
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  out.x = minX;
  out.y = minY;
  out.width = Math.max(0, maxX - minX);
  out.height = Math.max(0, maxY - minY);
  return out;
}

/** Transform all four corners, returning the enclosing axis-aligned rectangle. */
export function transformDamageRect(
  rect: DamageRect,
  transform: DamageTransform,
  out: DamageRect = createDamageRect(),
): DamageRect {
  return transformDamageValues(
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    transform,
    out,
  );
}

/** Allocation-free coordinate form used by command bounds in retained loops. */
function transformDamageValues(
  x0: number,
  y0: number,
  width: number,
  height: number,
  transform: DamageTransform,
  out: DamageRect,
  transformOffset = 0,
): DamageRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let corner = 0; corner < 4; corner += 1) {
    const x = corner === 0 || corner === 3 ? x0 : x0 + width;
    const y = corner < 2 ? y0 : y0 + height;
    const px =
      transform[transformOffset] * x +
      transform[transformOffset + 2] * y +
      transform[transformOffset + 4];
    const py =
      transform[transformOffset + 1] * x +
      transform[transformOffset + 3] * y +
      transform[transformOffset + 5];
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  out.x = minX;
  out.y = minY;
  out.width = Math.max(0, maxX - minX);
  out.height = Math.max(0, maxY - minY);
  return out;
}

function hasFiniteTransform(
  transform: ArrayLike<number>,
  transformOffset: number,
): boolean {
  for (let index = 0; index < 6; index += 1) {
    if (!Number.isFinite(transform[transformOffset + index])) return false;
  }
  return true;
}

function isFiniteDamageRect(rect: DamageRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

/**
 * Compute a conservative visual bound for one command. `null` means unknown,
 * which callers must treat as intersecting every damage region. Glyphs are
 * known only when their producer supplied explicit local ink bounds; guessing
 * from pen positions or em size could leave stale ink on a retained surface.
 */
export function commandDamageBounds<TTexture>(
  list: DrawList<TTexture>,
  index: number,
  out: DamageRect = createDamageRect(),
): CommandBounds | null {
  const kind = list.kindAt(index);
  // A screen effect depends on every preceding pixel, so a partial retained
  // replay cannot safely plan around it.
  if (kind === DRAW_SCREEN_EFFECT || kind === DRAW_EXTERNAL_EFFECT) return null;
  if (kind === DRAW_QUAD || kind === DRAW_NINE_PATCH) {
    const at = list.floatOffsetAt(index);
    const floats = list.floats;
    const w = floats[at + 6];
    const h = floats[at + 7];
    if (
      !hasFiniteTransform(floats, at) ||
      !Number.isFinite(w) ||
      !Number.isFinite(h) ||
      w < 0 ||
      h < 0
    ) {
      return null;
    }
    transformDamageValues(0, 0, w, h, floats, out, at);
    return isFiniteDamageRect(out) ? out : null;
  }
  if (kind === DRAW_POLYLINE) {
    const at = list.floatOffsetAt(index);
    const ints = list.ints;
    const floats = list.floats;
    const count = ints[list.intOffsetAt(index)];
    if (count <= 0) {
      out.x = 0;
      out.y = 0;
      out.width = 0;
      out.height = 0;
      return out;
    }
    const width = floats[at];
    if (!Number.isFinite(width)) return null;
    const half = Math.abs(width) / 2;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let point = 0; point < count; point += 1) {
      const x = floats[at + 5 + point * 2];
      const y = floats[at + 6 + point * 2];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      minX = Math.min(minX, x - half);
      minY = Math.min(minY, y - half);
      maxX = Math.max(maxX, x + half);
      maxY = Math.max(maxY, y + half);
    }
    out.x = minX;
    out.y = minY;
    out.width = maxX - minX;
    out.height = maxY - minY;
    return isFiniteDamageRect(out) ? out : null;
  }
  if (kind === DRAW_TEXTURED_MESH) {
    const at = list.floatOffsetAt(index);
    const intAt = list.intOffsetAt(index);
    const floats = list.floats;
    const vertexCount = list.ints[intAt];
    if (vertexCount <= 0) {
      out.x = 0;
      out.y = 0;
      out.width = 0;
      out.height = 0;
      return out;
    }
    const xx = floats[at];
    const xy = floats[at + 1];
    const yx = floats[at + 2];
    const yy = floats[at + 3];
    const ox = floats[at + 4];
    const oy = floats[at + 5];
    const positionsAt = at + 10;
    if (!hasFiniteTransform(floats, at)) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    // Bounds every VERTEX, not just the indexed subset: this remains safe if a
    // retained producer patches topology elsewhere, and the extra loop is tiny
    // beside a GPU mesh draw. Transforming each point is necessary for rotation
    // and skew; transforming a local AABB first would be less tight but still
    // misses nothing only when it includes all four derived corners.
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const x = floats[positionsAt + vertex * 2];
      const y = floats[positionsAt + vertex * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const transformedX = xx * x + yx * y + ox;
      const transformedY = xy * x + yy * y + oy;
      minX = Math.min(minX, transformedX);
      minY = Math.min(minY, transformedY);
      maxX = Math.max(maxX, transformedX);
      maxY = Math.max(maxY, transformedY);
    }
    out.x = minX;
    out.y = minY;
    out.width = Math.max(0, maxX - minX);
    out.height = Math.max(0, maxY - minY);
    return isFiniteDamageRect(out) ? out : null;
  }
  if (kind === DRAW_GLYPHS) {
    const at = list.floatOffsetAt(index);
    const floats = list.floats;
    const x = floats[at + 12];
    const y = floats[at + 13];
    const width = floats[at + 14];
    const height = floats[at + 15];
    const effectOutset = floats[at + 16];
    if (
      !hasFiniteTransform(floats, at) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      !Number.isFinite(effectOutset) ||
      width < 0 ||
      height < 0 ||
      effectOutset < 0
    ) {
      return null;
    }
    // `spreadPx` is a local dilation owned by this command. The producer's
    // outset covers its additional effect/AA reach, so both are needed.
    const spread = Math.abs(floats[at + 11]);
    const outset = effectOutset + (Number.isFinite(spread) ? spread : 0);
    transformDamageValues(
      x - outset,
      y - outset,
      width + outset * 2,
      height + outset * 2,
      floats,
      out,
      at,
    );
    return isFiniteDamageRect(out) ? out : null;
  }
  if (kind === DRAW_CLIP_PUSH || kind === DRAW_CLIP_POP) {
    // Clip commands paint nothing themselves. Their scope is reconstructed by
    // the ordered replay iterator, never guessed from these empty bounds.
    out.x = 0;
    out.y = 0;
    out.width = 0;
    out.height = 0;
    return out;
  }
  // A newer IR kind must not silently look like invisible content. The direct
  // path's unknown-command diagnostic remains useful, but retained replay has
  // to decline before it clears pixels it cannot reconstruct.
  return null;
}

export function createDamageTiles(
  width: number,
  height: number,
  tileWidth = RETAINED_DAMAGE_TILE_SIZE,
  tileHeight = tileWidth,
): DamageTiles {
  const tileW = Number.isFinite(tileWidth)
    ? Math.max(1, Math.floor(tileWidth))
    : RETAINED_DAMAGE_TILE_SIZE;
  const tileH = Number.isFinite(tileHeight)
    ? Math.max(1, Math.floor(tileHeight))
    : tileW;
  let surfaceWidth = 0;
  let surfaceHeight = 0;
  let columns = 0;
  let rows = 0;
  let marked = new Uint8Array(0);
  let dirty = false;
  let dirtyCount = 0;
  // `forEachRegion` is the retained hot path. Keep its run planner and result
  // storage at their high-water mark instead of creating arrays per frame.
  let regionsStale = true;
  let regionCount = 0;
  const regionPool: DamageRect[] = [];
  let previousEnds = new Int32Array(0);
  let previousRegions = new Int32Array(0);
  let currentEnds = new Int32Array(0);
  let currentRegions = new Int32Array(0);
  const iterationTile: DamageTile = {
    column: 0,
    row: 0,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };

  function resize(nextWidth: number, nextHeight: number): void {
    surfaceWidth = Number.isFinite(nextWidth)
      ? Math.max(0, Math.round(nextWidth))
      : 0;
    surfaceHeight = Number.isFinite(nextHeight)
      ? Math.max(0, Math.round(nextHeight))
      : 0;
    columns = Math.ceil(surfaceWidth / tileW);
    rows = Math.ceil(surfaceHeight / tileH);
    marked = new Uint8Array(columns * rows);
    dirty = false;
    dirtyCount = 0;
    regionsStale = true;
    previousEnds = new Int32Array(columns);
    previousRegions = new Int32Array(columns);
    currentEnds = new Int32Array(columns);
    currentRegions = new Int32Array(columns);
  }

  function mark(rect: DamageRect | null): void {
    if (surfaceWidth === 0 || surfaceHeight === 0) return;
    if (!rect || !isFiniteDamageRect(rect)) {
      marked.fill(1);
      dirty = marked.length > 0;
      dirtyCount = marked.length;
      regionsStale = true;
      return;
    }
    if (isDamageEmpty(rect)) return;
    const left = Math.max(0, Math.floor(rect.x / tileW));
    const top = Math.max(0, Math.floor(rect.y / tileH));
    const right = Math.min(columns, Math.ceil((rect.x + rect.width) / tileW));
    const bottom = Math.min(rows, Math.ceil((rect.y + rect.height) / tileH));
    for (let row = top; row < bottom; row += 1) {
      for (let column = left; column < right; column += 1) {
        const index = row * columns + column;
        if (marked[index] === 0) {
          marked[index] = 1;
          dirtyCount += 1;
          dirty = true;
          regionsStale = true;
        }
      }
    }
  }

  function tiles(): DamageTile[] {
    const result: DamageTile[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (marked[row * columns + column] === 0) continue;
        const x = column * tileW;
        const y = row * tileH;
        result.push({
          column,
          row,
          x,
          y,
          width: Math.min(tileW, surfaceWidth - x),
          height: Math.min(tileH, surfaceHeight - y),
        });
      }
    }
    return result;
  }

  function forEach(callback: (tile: DamageTile) => void): void {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (marked[row * columns + column] === 0) continue;
        const x = column * tileW;
        const y = row * tileH;
        iterationTile.column = column;
        iterationTile.row = row;
        iterationTile.x = x;
        iterationTile.y = y;
        iterationTile.width = Math.min(tileW, surfaceWidth - x);
        iterationTile.height = Math.min(tileH, surfaceHeight - y);
        callback(iterationTile);
      }
    }
  }

  /**
   * Build a maximal exact rectangular cover from the tile bitset. A row is
   * first reduced to horizontal runs; only a run with the same column span in
   * the immediately preceding row extends its existing rectangle. That rule
   * is what prevents a T/L-shaped set of tiles from filling its clean corner.
   */
  function rebuildRegions(): void {
    if (!regionsStale) return;
    regionsStale = false;
    regionCount = 0;
    previousEnds.fill(-1);
    previousRegions.fill(-1);

    for (let row = 0; row < rows; row += 1) {
      currentEnds.fill(-1);
      currentRegions.fill(-1);
      const y = row * tileH;
      const height = Math.min(tileH, surfaceHeight - y);
      for (let column = 0; column < columns; ) {
        if (marked[row * columns + column] === 0) {
          column += 1;
          continue;
        }
        const start = column;
        column += 1;
        while (column < columns && marked[row * columns + column] !== 0) {
          column += 1;
        }
        const end = column;
        let regionIndex = -1;
        if (previousEnds[start] === end) {
          regionIndex = previousRegions[start];
        }
        if (regionIndex >= 0) {
          // This row is directly below an identical horizontal run, so the
          // enlarged rectangle still covers exactly marked tiles.
          regionPool[regionIndex]!.height += height;
        } else {
          regionIndex = regionCount;
          regionCount += 1;
          const region = regionPool[regionIndex] ?? createDamageRect();
          region.x = start * tileW;
          region.y = y;
          region.width = Math.min(surfaceWidth, end * tileW) - region.x;
          region.height = height;
          regionPool[regionIndex] = region;
        }
        currentEnds[start] = end;
        currentRegions[start] = regionIndex;
      }
      [previousEnds, currentEnds] = [currentEnds, previousEnds];
      [previousRegions, currentRegions] = [currentRegions, previousRegions];
    }
  }

  function forEachRegion(callback: (region: DamageRect) => void): void {
    rebuildRegions();
    for (let index = 0; index < regionCount; index += 1) {
      callback(regionPool[index]!);
    }
  }

  resize(width, height);
  return {
    get width() {
      return surfaceWidth;
    },
    get height() {
      return surfaceHeight;
    },
    get tileWidth() {
      return tileW;
    },
    get tileHeight() {
      return tileH;
    },
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get tileCount() {
      return marked.length;
    },
    get dirtyCount() {
      return dirtyCount;
    },
    get coverage() {
      return marked.length === 0 ? 0 : dirtyCount / marked.length;
    },
    get dirty() {
      return dirty;
    },
    resize,
    mark,
    clear() {
      marked.fill(0);
      dirty = false;
      dirtyCount = 0;
      regionsStale = true;
    },
    tiles,
    forEach,
    forEachRegion,
    consume() {
      const result = tiles();
      marked.fill(0);
      dirty = false;
      dirtyCount = 0;
      regionsStale = true;
      return result;
    },
  };
}
