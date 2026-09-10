// The harfbuzzjs arms' machinery: shape once, rasterize once, then only blit.
//
// WHAT THESE ARMS ARE TESTING. `dom` and `canvas2d` both re-rasterize every glyph of every run on
// every frame, because both are told the run as a STRING and a transform, and neither browser API
// has a way to say "you have drawn this exact glyph at this exact sub-pixel phase before". The
// premise here is that small rotated CJK is the worst possible case for that — hundreds of distinct
// complex outlines, a rotation that defeats the browser's own glyph cache, and a translation that
// changes the phase every frame — and that shaping and rasterizing ONCE, into a texture the GPU
// then only blits, converts a per-frame cost into a startup cost.
//
// The two arms differ in WHAT is baked, which is the interesting axis:
//
//   * `hb-atlas` bakes each GLYPH, rotated, at N sub-pixel phases. Draws are snapped to whole
//     device pixels and the phase is chosen from the fraction, so every blit is 1:1 texel-to-pixel
//     — no resampling at all, at the cost of N copies of the atlas and a quantized position.
//   * `hb-run` bakes each RUN whole, rotated, once, and thereafter only translates it. One texture
//     per run and one quad per run, at the cost of a bilinear resample on every frame. This is the
//     repo's frozen-surface/SWAP technique (see the WebGPU effects work) applied to text.
//
// BOTH ARE GRADED BY THE ALIGNMENT GUARD before their numbers are quoted. A baked atlas is exactly
// the kind of arm that picks up a half-pixel offset — every step here (the cell's integral offset,
// the phase bucket's centre, the run anchor) is a place a rounding rule could put the text
// somewhere slightly else, and `alignmentPx` is what makes that a failed row rather than a
// flattering `rmsVsReference`.
//
// NEVER `getImageData`. On the headed-Xvfb rung an accelerated 2D canvas reads back alpha 0
// (docs/perf-harness.md, "WHAT IS ACTUALLY BROKEN ON THAT RUNG"), so a baker that round-tripped its
// pages through bytes would upload blank atlases on the exact rung the GPU numbers come from. Page
// canvases go to `texImage2D` as a `TexImageSource` and are never read back.

import {
  BLEND_MIX,
  type CanvasExecutor,
  type CanvasStage,
  type CanvasTextureCache,
  type CanvasTextureHandle,
  createCanvasExecutor,
  createCanvasStage,
  createDrawList,
  createQuadView,
  createTextureCache,
  type DrawList,
} from "@godot-scene-web/canvas";
import {
  atlasPageSideFor,
  type Bounds,
  cellGeometryFor,
  packShelves,
  phaseGridFor,
  phaseIndexAt,
  phaseOffsetAt,
  rotateBounds,
} from "./text-atlas";

// ---------------------------------------------------------------------------------------------
// Shaping — the `bakeShaper` axis
// ---------------------------------------------------------------------------------------------

/** One positioned glyph of a run. `penPx` is CSS px along the UNROTATED baseline from the run's
 *  left edge; rotation is applied by the caller, once, to the whole run. */
export interface ShapedGlyph {
  key: string;
  penPx: number;
}

/**
 * Separates a glyph key's FACE from its glyph.
 *
 * Load-bearing since the round grew a second script. A HarfBuzz key is a glyph id and a `fillText`
 * key is the character itself, and both are per-FACE: Noto Sans SC's gid 97 and Roboto's gid 97 are
 * unrelated outlines, and `"S"` means one thing in a Latin face and nothing at all in a Han subset.
 * One atlas now holds both, so an unqualified key would let one face's glyph silently render as the
 * other's — a bug that produces perfectly crisp, perfectly aligned, WRONG text, which nothing else
 * in this round measures.
 *
 * A slash rather than a hash: `bakeAtlas` appends `#<phase>` to every key and reads it back with
 * `lastIndexOf("#")`, and a `fillText` key really can be the character `#`.
 */
export const GLYPH_KEY_SEPARATOR = "/";

/** The atlas key for glyph `id` of face `faceId`. */
export function glyphKey(faceId: string, id: string | number): string {
  return `${faceId}${GLYPH_KEY_SEPARATOR}${id}`;
}

/** Which face a glyph key belongs to — how a key finds its way back to the shaper that made it. */
export function faceIdOf(key: string): string {
  const at = key.indexOf(GLYPH_KEY_SEPARATOR);
  return at < 0 ? "" : key.slice(0, at);
}

function glyphIdOf(key: string): string {
  const at = key.indexOf(GLYPH_KEY_SEPARATOR);
  return at < 0 ? key : key.slice(at + 1);
}

/**
 * The HarfBuzz glyph id inside a key, or `null` when the key did not come from a HarfBuzz shaper.
 *
 * ONE DEFINITION OF THE `g` PREFIX, because there are now two consumers of it. The prefix exists so
 * a bare number can never be read as a `fillText` shaper's character key (see {@link glyphKey}), and
 * `createHarfBuzzShaper` used to be the only code that knew that. `hb-gpu` shapes with the same
 * shaper and then encodes the OUTLINE of the same gid out of a second module, so it has to get from
 * a key back to a glyph id too — and a second `Number(key.slice(...))` written beside this one would
 * be free to disagree the first time the format changed, which renders as one glyph's outline drawn
 * under another glyph's key: crisp, aligned and wrong.
 *
 * `null` rather than `NaN`, so a caller that forgot to check gets a type error rather than an
 * encode of glyph `NaN`.
 */
export function harfbuzzGlyphIdOf(key: string): number | null {
  const id = glyphIdOf(key);
  if (!id.startsWith("g")) return null;
  const gid = Number(id.slice(1));
  return Number.isInteger(gid) && gid >= 0 ? gid : null;
}

/**
 * How a run becomes positioned glyphs, and how one of those glyphs becomes ink.
 *
 * Two implementations, and the difference between them is a MEASUREMENT, not a convenience: it
 * separates "does baking help" from "does HarfBuzz shaping matter for this text". CJK is the case
 * where the answer is plausibly no — Han is full-width, unkerned and unligatured, so a naive
 * per-codepoint layout may be byte-identical to a shaped one — and if it is, the `hb-` arms'
 * advantage is baking alone and a consumer can have it without a 420 KB wasm module.
 */
export interface TextShaper {
  readonly name: string;
  /** Namespace every key this shaper emits carries. See {@link GLYPH_KEY_SEPARATOR}. */
  readonly faceId: string;
  /** Positioned glyphs, in draw order. */
  shape(text: string): ShapedGlyph[];
  /** Ink bounds in CSS px relative to the glyph's origin, y measured DOWN. */
  boundsOf(key: string): Bounds;
  /** Fill the glyph with its origin at the current transform's origin, in CSS px units. */
  draw(ctx: CanvasRenderingContext2D, key: string): void;
  /** Bytes of wasm heap this shaper holds, or 0 when it has no wasm. */
  heapBytes(): number;
}

const EMPTY_BOUNDS: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

/**
 * A HarfBuzz shaper over `bytes`, at `fontSizePx`.
 *
 * `setScale(upem, upem)` — the font's OWN units, not the pixel size. HarfBuzz scales positions by
 * `scale / upem` in integer arithmetic, so asking for pixels directly (`setScale(12, 12)`) rounds
 * every advance and every outline coordinate to a whole pixel inside the shaper, and asking for
 * 26.6 fixed point (`setScale(12 * 64, ...)`) quietly puts the outlines in a 768-units-per-em space
 * whose curves have visibly fewer distinct positions than the font's 1000. Shaping in font units
 * and scaling to px here in floating point is the only one of the three that loses nothing.
 */
export async function createHarfBuzzShaper(
  bytes: ArrayBuffer,
  fontSizePx: number,
  faceId: string,
): Promise<TextShaper> {
  // Dynamic, so the ~420 KB wasm module and its top-level await are paid for by the arms that use
  // it and by nothing else: the perf-harness ships ONE bundle for all nine scenarios, and a static
  // import here would put a wasm instantiation in front of every one of them.
  const hb = await import("harfbuzzjs");
  const blob = new hb.Blob(new Uint8Array(bytes));
  const face = new hb.Face(blob, 0);
  const font = new hb.Font(face);
  const upem = face.upem;
  font.setScale(upem, upem);
  const toPx = fontSizePx / upem;

  const paths = new Map<number, Path2D | null>();
  const bounds = new Map<number, Bounds>();
  // `<face>/g<gid>`; the `g` is what stops a bare number from ever being read as a character key.
  // Through `harfbuzzGlyphIdOf`, which is the one place that convention is written down — the
  // `hb-gpu` arm reads the same keys back to encode their outlines.
  const gidOf = (key: string): number => harfbuzzGlyphIdOf(key) ?? 0;

  return {
    name: "harfbuzz",
    faceId,

    shape(text) {
      const buffer = new hb.Buffer();
      buffer.addText(text);
      // Script, direction and language INFERRED rather than asserted: the fixture runs are Han plus
      // a U+25A0 beacon, and hard-coding `ltr`/`Hans` here would make the arm disagree with the
      // browser's own shaping decisions for any other text a future fixture uses.
      buffer.guessSegmentProperties();
      hb.shape(font, buffer);
      const items = buffer.getGlyphInfosAndPositions();
      const out: ShapedGlyph[] = [];
      let pen = 0;
      for (const item of items) {
        out.push({
          key: glyphKey(faceId, `g${item.codepoint}`),
          penPx: (pen + (item.xOffset ?? 0)) * toPx,
        });
        pen += item.xAdvance ?? 0;
      }
      return out;
    },

    boundsOf(key) {
      const gid = gidOf(key);
      const cached = bounds.get(gid);
      if (cached) return cached;
      const extents = font.glyphExtents(gid);
      // HarfBuzz extents are y-UP with a NEGATIVE height: `yBearing` is the ink's top and
      // `yBearing + height` its bottom. Flipping to the y-down space every canvas here works in
      // therefore swaps which one is `minY`.
      const value: Bounds =
        extents && extents.width !== 0 && extents.height !== 0
          ? {
              minX: extents.xBearing * toPx,
              maxX: (extents.xBearing + extents.width) * toPx,
              minY: -extents.yBearing * toPx,
              maxY: -(extents.yBearing + extents.height) * toPx,
            }
          : EMPTY_BOUNDS;
      bounds.set(gid, value);
      return value;
    },

    draw(ctx, key) {
      const gid = gidOf(key);
      let path = paths.get(gid);
      if (path === undefined) {
        const d = font.glyphToPath(gid);
        path = d ? new Path2D(d) : null;
        paths.set(gid, path);
      }
      if (!path) return;
      ctx.save();
      // Font units to CSS px, and y-up to y-down in the same step. Nonzero winding is the default
      // and is what TrueType outlines assume, so it is not restated.
      ctx.scale(toPx, -toPx);
      ctx.fill(path);
      ctx.restore();
    },

    heapBytes() {
      // Any referenced table is a `Uint8Array` VIEW onto the wasm memory, so its buffer's length is
      // the heap's current size. Cheaper and more honest than instrumenting the module: it reports
      // what the allocator has actually grown to, including whatever shaping just did.
      return face.referenceTable("head")?.buffer.byteLength ?? 0;
    },
  };
}

/**
 * The control shaper: one glyph per code point, positioned and drawn by the browser's own 2D
 * canvas text API, with no HarfBuzz anywhere.
 *
 * Deliberately NOT a second rasterizer choice bolted onto the HarfBuzz path — the point is that
 * this is exactly what `canvas2d` does per frame, so an `hb-atlas` run with `bakeShaper=fillText`
 * isolates the baking from the shaping: same ink, same metrics, same rasterizer, drawn once instead
 * of every frame.
 */
export function createCanvasShaper(
  fontSizePx: number,
  fontFamily: string,
  faceId: string,
): TextShaper {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("text-hb: no 2d context for the fillText shaper");
  }
  const font = `${fontSizePx}px "${fontFamily}"`;
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  const bounds = new Map<string, Bounds>();

  return {
    name: "fillText",
    faceId,

    shape(text) {
      const out: ShapedGlyph[] = [];
      let pen = 0;
      // `[...text]` iterates by CODE POINT: a `for` over `.length` would split any astral character
      // into two halves and measure each surrogate as a glyph.
      for (const char of [...text]) {
        out.push({ key: glyphKey(faceId, char), penPx: pen });
        pen += ctx.measureText(char).width;
      }
      return out;
    },

    boundsOf(key) {
      const cached = bounds.get(key);
      if (cached) return cached;
      const m = ctx.measureText(glyphIdOf(key));
      const value: Bounds = {
        minX: -m.actualBoundingBoxLeft,
        maxX: m.actualBoundingBoxRight,
        minY: -m.actualBoundingBoxAscent,
        maxY: m.actualBoundingBoxDescent,
      };
      bounds.set(key, value);
      return value;
    },

    draw(target, key) {
      // The font has to be set on the TARGET context, not this shaper's measuring one: `draw` is
      // handed a page canvas that knows nothing about the face.
      target.font = font;
      target.textBaseline = "alphabetic";
      target.fillText(glyphIdOf(key), 0, 0);
    },

    heapBytes() {
      return 0;
    },
  };
}

/**
 * Several faces behind one key space — what lets ONE atlas hold a Han run and a Latin run.
 *
 * Everything downstream of shaping (the baker, the packer, the draw loop, the fidelity probe) works
 * in `ShapedGlyph.key`s and nothing else, so the multiplexing has to happen exactly here or it has
 * to happen in four places. `boundsOf` and `draw` route on the key's face prefix; `shape` is told
 * which face to use, because a run's script is a property of the run and not of its characters.
 *
 * THROWS on an unknown face rather than skipping the glyph. A missing shaper renders as absent
 * text, which every metric in this round reports as an unusually cheap and unusually crisp arm.
 */
export interface ShaperSet {
  readonly faces: readonly TextShaper[];
  shape(faceId: string, text: string): ShapedGlyph[];
  boundsOf(key: string): Bounds;
  draw(ctx: CanvasRenderingContext2D, key: string): void;
  /** Summed across faces: two HarfBuzz faces are two wasm heaps, and the table should say so. */
  heapBytes(): number;
}

export function createShaperSet(shapers: readonly TextShaper[]): ShaperSet {
  const byFace = new Map(shapers.map((shaper) => [shaper.faceId, shaper]));
  const of = (faceId: string): TextShaper => {
    const shaper = byFace.get(faceId);
    if (!shaper) {
      throw new Error(
        `text-hb: no shaper for face "${faceId}" (have: ${[...byFace.keys()].join(", ")}) — its glyphs would silently not be drawn, which reads as a cheap, crisp arm`,
      );
    }
    return shaper;
  };
  return {
    faces: shapers,
    shape: (faceId, text) => of(faceId).shape(text),
    boundsOf: (key) => of(faceIdOf(key)).boundsOf(key),
    draw: (ctx, key) => of(faceIdOf(key)).draw(ctx, key),
    heapBytes: () => shapers.reduce((sum, s) => sum + s.heapBytes(), 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Baking
// ---------------------------------------------------------------------------------------------

/** Something to rasterize into an atlas cell, once, in CSS px around an anchor at the origin. */
export interface BakeItem {
  key: string;
  /** Ink bounds in CSS px relative to the anchor, y-down, BEFORE rotation. */
  bounds: Bounds;
  /** Draw it with the anchor at the current transform's origin, in CSS px units. */
  draw(ctx: CanvasRenderingContext2D): void;
}

/** Where one baked variant lives, and where it goes on screen. */
export interface BakedCell {
  page: number;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  /** Device-px vector from the item's ANCHOR to the cell's top-left. Integral. */
  offsetX: number;
  offsetY: number;
}

export interface BakedAtlas {
  /** Cells by `key`, then by phase index. `cells.get(key)![phase]`. */
  cells: Map<string, BakedCell[]>;
  pages: HTMLCanvasElement[];
  pageSide: number;
  /** Effective phase grid side — 1 when rotation is not baked. See {@link bakeAtlas}. */
  grid: number;
  phases: number;
  cellCount: number;
  occupancy: number;
  bakeMs: number;
}

export interface BakeOptions {
  dpr: number;
  /** Rotation baked INTO the pixels, in radians. Zero means the caller rotates the quad instead. */
  radians: number;
  /**
   * Whether the DRAW will land this cell on whole device pixels.
   *
   * Load-bearing, and the reason it is stated rather than inferred: a snapped draw carries the
   * fractional part of the position in the BAKE (that is what phases are), while an unsnapped draw
   * carries it in the quad's own coordinates. Bake a sub-pixel offset into a cell that is then
   * drawn at a fractional position and the two ADD — the offset lands on top of the true position
   * instead of standing in for it, and every glyph sits permanently half a pixel out.
   */
  snapped: boolean;
  /** Requested sub-pixel variants per item; see {@link phaseGridFor}. Ignored when not snapped. */
  phases: number;
  maxPageSide: number;
}

/**
 * Rasterize every item, at every sub-pixel phase, into shelf-packed atlas pages.
 *
 * PHASES ONLY EXIST FOR A SNAPPED DRAW. Snapping makes the blit exactly 1:1 texel-to-pixel and
 * makes the pre-baked sub-pixel offset the ONLY thing carrying the fractional position. An
 * unsnapped draw — a rotated quad, or a whole run translated to a fractional position — is a
 * bilinear tap on every fragment no matter where the corners land, so N copies of the atlas would
 * buy nothing but VRAM, and the cell has to be baked at offset ZERO so the quad's own coordinates
 * are the whole truth about where it goes.
 *
 * Measured, when this was wrong: `hb-run` baked at the centre of its single bucket (+0.5, +0.5
 * device px) and then drew at a fractional position, so it sat 1.13 px from the reference and the
 * fidelity probe refused its per-pixel columns.
 */
export function bakeAtlas(
  items: readonly BakeItem[],
  options: BakeOptions,
): BakedAtlas {
  const startedAt = performance.now();
  const { dpr, radians, snapped, maxPageSide } = options;
  const grid = snapped ? phaseGridFor(options.phases) : 1;
  const phases = grid * grid;

  // Geometry first, for every item, so the page size can be chosen from the REAL total area rather
  // than from an estimate that would be wrong by whatever the rotation adds.
  const geometry = new Map<
    string,
    { width: number; height: number; offsetX: number; offsetY: number }
  >();
  let totalArea = 0;
  // The longest side any ONE cell needs, tracked alongside the area because the two ask different
  // questions of the page size and area alone answers only the first — see `atlasPageSideFor`.
  let largestCellSide = 0;
  for (const item of items) {
    const device: Bounds = {
      minX: item.bounds.minX * dpr,
      minY: item.bounds.minY * dpr,
      maxX: item.bounds.maxX * dpr,
      maxY: item.bounds.maxY * dpr,
    };
    const cell = cellGeometryFor(
      radians === 0 ? device : rotateBounds(device, radians),
    );
    geometry.set(item.key, cell);
    totalArea += cell.width * cell.height * phases;
    largestCellSide = Math.max(largestCellSide, cell.width, cell.height);
  }

  const pageSide = atlasPageSideFor(
    totalArea,
    maxPageSide,
    undefined,
    largestCellSide,
  );
  const packing = packShelves(
    items.flatMap((item) => {
      const cell = geometry.get(item.key);
      if (!cell) return [];
      return Array.from({ length: phases }, (_, phase) => ({
        key: `${item.key}#${phase}`,
        width: cell.width,
        height: cell.height,
      }));
    }),
    pageSide,
    pageSide,
  );

  const pages: HTMLCanvasElement[] = [];
  const contexts: CanvasRenderingContext2D[] = [];
  for (let index = 0; index < packing.pages; index += 1) {
    const page = document.createElement("canvas");
    page.width = pageSide;
    // Only as tall as the shelves reached — see `ShelfPacking.pageHeights`.
    page.height = packing.pageHeights[index];
    const ctx = page.getContext("2d");
    if (!ctx) {
      throw new Error("text-hb: no 2d context for an atlas page");
    }
    // White ink, straight alpha from the rasterizer's own coverage. The tint is applied by the
    // quad, so the atlas holds coverage rather than a colour decision.
    ctx.fillStyle = "#ffffff";
    pages.push(page);
    contexts.push(ctx);
  }

  const byKey = new Map<string, BakeItem>(items.map((i) => [i.key, i]));
  const cells = new Map<string, BakedCell[]>();
  for (const placement of packing.placements) {
    const hash = placement.key.lastIndexOf("#");
    const itemKey = placement.key.slice(0, hash);
    const phase = Number(placement.key.slice(hash + 1));
    const item = byKey.get(itemKey);
    const cell = geometry.get(itemKey);
    if (!item || !cell) continue;

    let list = cells.get(itemKey);
    if (!list) {
      list = new Array<BakedCell>(phases);
      cells.set(itemKey, list);
    }
    list[phase] = {
      page: placement.page,
      srcX: placement.x,
      srcY: placement.y,
      srcW: placement.width,
      srcH: placement.height,
      offsetX: cell.offsetX,
      offsetY: cell.offsetY,
    };

    const ctx = contexts[placement.page];
    if (!ctx) continue;
    // Zero for an unsnapped draw: the quad's own fractional corners already say where the ink goes,
    // so a baked offset would be added on top of it rather than standing in for it.
    const offset = snapped ? phaseOffsetAt(phase, grid) : { x: 0, y: 0 };
    ctx.save();
    // Clipped to its own cell. The gutter and the cell's slack should make this unnecessary, but
    // "should" is doing a lot of work across three rasterizers and a rotation: a glyph that
    // overflowed by an antialiased pixel would deposit ink in a NEIGHBOUR's cell, and that shows up
    // as a stray mark beside an unrelated character — the hardest kind of rendering bug to trace
    // back to its cause.
    ctx.beginPath();
    ctx.rect(placement.x, placement.y, placement.width, placement.height);
    ctx.clip();
    // Device px: put the anchor where the phase asks, rotate, then switch to CSS px for the item.
    ctx.translate(
      placement.x - cell.offsetX + offset.x,
      placement.y - cell.offsetY + offset.y,
    );
    if (radians !== 0) ctx.rotate(radians);
    ctx.scale(dpr, dpr);
    item.draw(ctx);
    ctx.restore();
  }

  return {
    cells,
    pages,
    pageSide,
    grid,
    phases,
    cellCount: packing.placements.length,
    occupancy: packing.occupancy,
    bakeMs: performance.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

export interface AtlasRendererOptions {
  container: HTMLElement;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  pages: readonly HTMLCanvasElement[];
}

export interface AtlasRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly pageCount: number;
  /** Resident atlas bytes on the GPU, as the texture cache counts them. */
  readonly atlasBytes: number;
  begin(): void;
  /** Blit a cell whose top-left lands at device px `(x, y)`. Snap `x`/`y` for a 1:1 blit. */
  blit(cell: BakedCell, x: number, y: number): void;
  /** Draw a cell through a device-space 2x3 affine applied to its local `(0,0)-(w,h)` box. */
  transformed(cell: BakedCell, m: Float32Array): void;
  /** Submit the frame. Returns what this frame cost in quads and draw calls. */
  end(): { quads: number; batches: number };
  dispose(): void;
}

/**
 * A WebGL2 stage over the scenario's own canvas, drawing baked cells as textured quads.
 *
 * DESIGN SPACE IS DEVICE PIXELS. Every other consumer of `createCanvasStage` gives it a scene-sized
 * design extent and lets the projection scale it; here design and framebuffer are the same size on
 * purpose, so an integral destination in this renderer's coordinates IS an integral destination in
 * the drawing buffer. That is what makes `hb-atlas`'s 1:1 claim true rather than approximate — a
 * projection with any scale in it would resample every blit and quietly turn the phase machinery
 * into decoration.
 */
export function createAtlasRenderer(
  options: AtlasRendererOptions,
): AtlasRenderer {
  const { container, cssWidth, cssHeight, dpr, pages } = options;
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const deviceW = Math.round(cssWidth * dpr);
  const deviceH = Math.round(cssHeight * dpr);
  canvas.width = deviceW;
  canvas.height = deviceH;
  container.appendChild(canvas);

  const stage: CanvasStage | null = createCanvasStage({
    canvas,
    designWidth: deviceW,
    designHeight: deviceH,
  });
  if (!stage) {
    throw new Error(
      "text-hb: no WebGL2 context for the atlas renderer — the hb- arms have no fallback, and a silently skipped arm would report as a cheap one",
    );
  }
  stage.setStageSize(deviceW, deviceH);

  const cache: CanvasTextureCache = createTextureCache(stage.gl);
  const handles: CanvasTextureHandle[] = pages.map((page, index) =>
    cache.acquire(`atlas:${index}`, page),
  );
  const executor: CanvasExecutor = createCanvasExecutor({
    gl: stage.gl,
    white: cache.white(),
  });
  // Compile and link NOW. Reading a shader's compile status blocks on the driver — 100-250 ms on a
  // phone — and paying that inside the measured window would be charged to the first frame of the
  // arm rather than to its setup.
  executor.warmUp();

  const list: DrawList<CanvasTextureHandle | null> = createDrawList({
    commandCapacity: 512,
  });
  const view = createQuadView();
  view.blend = BLEND_MIX;
  let quadsThisFrame = 0;

  function push(cell: BakedCell, m: Float32Array): void {
    const texture = handles[cell.page];
    if (!texture) return;
    view.m = m;
    view.w = cell.srcW;
    view.h = cell.srcH;
    view.srcX = cell.srcX;
    view.srcY = cell.srcY;
    view.srcW = cell.srcW;
    view.srcH = cell.srcH;
    list.pushQuad(view, texture);
    quadsThisFrame += 1;
  }

  const translation = new Float32Array([1, 0, 0, 1, 0, 0]);

  return {
    canvas,
    pageCount: pages.length,
    get atlasBytes() {
      return cache.stats.bytes;
    },

    begin() {
      list.reset();
      quadsThisFrame = 0;
    },

    blit(cell, x, y) {
      translation[4] = x;
      translation[5] = y;
      push(cell, translation);
    },

    transformed(cell, m) {
      push(cell, m);
    },

    end() {
      stage.applyViewport();
      if (!executor.execute(list, stage.projection(), { clear: true })) {
        throw new Error(
          "text-hb: the quad program would not build, so this frame drew nothing — a silently blank arm would report as an extremely fast one",
        );
      }
      // `ExecutorStats` is zeroed at the top of every `execute`, so these are already THIS frame's
      // numbers. Subtracting a previous reading (the obvious thing to write) yields 0 on every
      // steady-state frame, because the two are equal.
      return { quads: quadsThisFrame, batches: executor.stats.batches };
    },

    dispose() {
      executor.dispose();
      cache.dispose();
      stage.dispose();
      canvas.remove();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Placement — the arithmetic the alignment guard grades
// ---------------------------------------------------------------------------------------------

/** Everything a baked run needs to reach the screen in the same place every other arm puts it. */
export interface RunLayout {
  /** The un-rotated run box, CSS px. */
  width: number;
  height: number;
  /** Run box top edge to alphabetic baseline, CSS px. Every arm in this round anchors here. */
  baselinePx: number;
  dpr: number;
  radians: number;
  /** Whether the rotation is in the PIXELS (snap and blit) or in the DRAW (rotate the quad). */
  bakeRotation: boolean;
}

/**
 * Where a glyph at pen position `penPx` sits relative to the run box's CENTRE, in un-rotated CSS px.
 *
 * The centre and not the top-left because that is what everything rotates and translates about: the
 * shipped HTML model maps a rotation-only Godot Control to `transform-origin: 50% 50%`, `canvas2d`
 * rotates about the same point, Godot's `Label` is given a matching `pivot_offset`, and the
 * per-frame translation moves it. One expression, used by the bake AND by the draw AND by the
 * fidelity probe, because for a baked arm any disagreement between them is a fraction of a pixel of
 * permanent offset — which is what `alignmentPx` exists to catch and what it caught twice already.
 */
export function glyphLocal(
  penPx: number,
  layout: RunLayout,
): { x: number; y: number } {
  return {
    x: penPx - layout.width / 2,
    y: -layout.height / 2 + layout.baselinePx,
  };
}

/** Scratch for a rotated quad's 2x3, reused so a per-glyph draw allocates nothing. */
const scratchTransform = new Float32Array(6);

/**
 * Draw one run's worth of baked glyph cells, its box centred at `centreX`/`centreY` in CSS px.
 *
 * This is `hb-atlas`'s per-frame work in full: a pen walk, a rotation, and one quad per glyph.
 */
export function drawGlyphCells(
  renderer: AtlasRenderer,
  atlas: BakedAtlas,
  glyphs: readonly ShapedGlyph[],
  centreX: number,
  centreY: number,
  layout: RunLayout,
): void {
  const cos = Math.cos(layout.radians);
  const sin = Math.sin(layout.radians);
  for (const glyph of glyphs) {
    const local = glyphLocal(glyph.penPx, layout);
    const originX = (centreX + local.x * cos - local.y * sin) * layout.dpr;
    const originY = (centreY + local.x * sin + local.y * cos) * layout.dpr;
    const cells = atlas.cells.get(glyph.key);
    if (!cells) continue;

    if (layout.bakeRotation) {
      // The whole point of the arm. Split the glyph's device-space origin into a whole pixel and a
      // fraction, put the quad on the whole pixel — so the blit is exactly 1:1 texel-to-pixel, with
      // no resampling anywhere — and let the pre-baked variant carry the fraction.
      const ix = Math.floor(originX);
      const iy = Math.floor(originY);
      const cell =
        cells[phaseIndexAt(originX - ix, originY - iy, atlas.grid)] ?? cells[0];
      if (cell) renderer.blit(cell, ix + cell.offsetX, iy + cell.offsetY);
      continue;
    }
    const cell = cells[0];
    if (cell) rotatedQuad(renderer, cell, originX, originY, cos, sin);
  }
}

/** Draw one whole baked run, its box centred at `centreX`/`centreY` in CSS px. */
export function drawRunCell(
  renderer: AtlasRenderer,
  cell: BakedCell,
  centreX: number,
  centreY: number,
  layout: RunLayout,
): void {
  const anchorX = centreX * layout.dpr;
  const anchorY = centreY * layout.dpr;
  if (layout.bakeRotation) {
    // NOT snapped, and that is this arm's whole cost: one texture per run means one baked sub-pixel
    // phase, so the fractional position is paid for with a bilinear resample every frame. The
    // fidelity probe's `edgeShimmer` is where that shows up.
    renderer.blit(cell, anchorX + cell.offsetX, anchorY + cell.offsetY);
    return;
  }
  rotatedQuad(
    renderer,
    cell,
    anchorX,
    anchorY,
    Math.cos(layout.radians),
    Math.sin(layout.radians),
  );
}

/**
 * The upright-atlas control path: the cell is un-rotated pixels, so the QUAD carries the rotation.
 *
 * The quad's local `(0, 0)` is the cell's top-left, which sits at the cell offset in the item's
 * UN-rotated frame — so the offset has to be rotated before it is added to the anchor, exactly as
 * the ink inside the cell is.
 */
function rotatedQuad(
  renderer: AtlasRenderer,
  cell: BakedCell,
  anchorX: number,
  anchorY: number,
  cos: number,
  sin: number,
): void {
  scratchTransform[0] = cos;
  scratchTransform[1] = sin;
  scratchTransform[2] = -sin;
  scratchTransform[3] = cos;
  scratchTransform[4] = anchorX + (cell.offsetX * cos - cell.offsetY * sin);
  scratchTransform[5] = anchorY + (cell.offsetX * sin + cell.offsetY * cos);
  renderer.transformed(cell, scratchTransform);
}

/**
 * Free an atlas page's system memory once it is on the GPU.
 *
 * A 2048x2048 page is 16 MB of renderer heap, and at a phone's device pixel ratio this workload
 * needs several. Keeping them alive would double-count the atlas in every memory reading the
 * harness takes and would charge the `hb-` arms for RAM they do not actually use after startup:
 * the pixels live in VRAM from the upload onwards, which is what `atlasBytes` reports.
 */
export function releaseAtlasPages(pages: readonly HTMLCanvasElement[]): void {
  for (const page of pages) {
    page.width = 0;
    page.height = 0;
  }
}
