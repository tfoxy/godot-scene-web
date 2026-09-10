import { describe, expect, it } from "vitest";
import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  BLEND_SUB,
  commandDamageBounds,
  createClipRectView,
  createDamageTiles,
  createDrawList,
  createGlyphsView,
  createPolylineView,
  createQuadView,
  createReplayMask,
  createReplayMaskScratch,
  createTexturedMeshView,
  maxPartialReplayCommands,
  outsetDamageRect,
  transformDamageRect,
  unionDamageRect,
} from "../src/index";

function quad(x: number, y: number, width: number, height: number) {
  const view = createQuadView();
  view.m[4] = x;
  view.m[5] = y;
  view.w = width;
  view.h = height;
  return view;
}

describe("conservative command damage bounds", () => {
  it("encloses all transformed quad corners and maps it to backing pixels", () => {
    const list = createDrawList();
    const view = quad(10, 20, 8, 4);
    view.m.set([0, 2, -3, 0, 10, 20]);
    const index = list.pushQuad(view);
    expect(commandDamageBounds(list, index)).toEqual({
      x: -2,
      y: 20,
      width: 12,
      height: 16,
    });
    expect(
      transformDamageRect(
        commandDamageBounds(list, index)!,
        [2, 0, 0, 3, 1, 2],
      ),
    ).toEqual({ x: -3, y: 62, width: 24, height: 48 });
  });

  it("encloses every transformed mesh vertex, including a rotated/skewed extremum", () => {
    const list = createDrawList();
    const mesh = createTexturedMeshView(3, 3);
    mesh.m.set([0, 2, -3, 0, 10, 20]);
    mesh.positions.set([0, 0, 4, 0, 1, 3]);
    mesh.uvs.set([0, 0, 1, 0, 0, 1]);
    mesh.indices.set([0, 1, 2]);
    mesh.vertexCount = 3;
    mesh.indexCount = 3;
    expect(commandDamageBounds(list, list.pushTexturedMesh(mesh))).toEqual({
      x: 1,
      y: 20,
      width: 9,
      height: 8,
    });
  });

  it("uses caller ink bounds through rotation, spread and effect/AA outset", () => {
    const list = createDrawList();
    const run = createGlyphsView(1);
    run.m.set([0, 2, -3, 0, 10, 20]);
    run.glyphCount = 1;
    run.localInkX = 1;
    run.localInkY = 2;
    run.localInkWidth = 4;
    run.localInkHeight = 3;
    run.spreadPx = 2;
    run.localInkOutset = 1;
    const out = { x: 0, y: 0, width: 0, height: 0 };
    expect(commandDamageBounds(list, list.pushGlyphs(run), out)).toBe(out);
    expect(out).toEqual({ x: -14, y: 16, width: 27, height: 20 });
  });

  it("fails closed for legacy glyphs without an explicit complete ink tuple", () => {
    const list = createDrawList();
    const legacy = createGlyphsView(1);
    legacy.glyphCount = 1;
    expect(commandDamageBounds(list, list.pushGlyphs(legacy))).toBeNull();
    legacy.localInkX = 0;
    legacy.localInkY = 0;
    legacy.localInkWidth = 1;
    legacy.localInkHeight = 1;
    // The required effect/AA reach is absent, so a partial replay still must
    // not guess whether neighbouring text pixels were touched.
    expect(commandDamageBounds(list, list.pushGlyphs(legacy))).toBeNull();
  });

  it("keeps primitive geometry independent of blend mode", () => {
    const list = createDrawList();
    const expected = { x: 0, y: 0, width: 10, height: 10 };
    for (const blend of [BLEND_MIX, BLEND_ADD, BLEND_SUB, BLEND_MUL]) {
      const view = quad(0, 0, 10, 10);
      view.blend = blend;
      expect(commandDamageBounds(list, list.pushQuad(view))).toEqual(expected);
    }
    const line = createPolylineView(2);
    line.width = 2;
    line.pointCount = 2;
    line.points.set([0, 0, 10, 0]);
    expect(commandDamageBounds(list, list.pushPolyline(line))).toEqual({
      x: -1,
      y: -1,
      width: 12,
      height: 2,
    });
  });

  it("marks only tiles touched by a half-open damage rect and clips edge tiles", () => {
    const tiles = createDamageTiles(130, 70, 64);
    tiles.mark({ x: 63, y: 1, width: 2, height: 64 });
    expect(tiles.tiles()).toEqual([
      { column: 0, row: 0, x: 0, y: 0, width: 64, height: 64 },
      { column: 1, row: 0, x: 64, y: 0, width: 64, height: 64 },
      { column: 0, row: 1, x: 0, y: 64, width: 64, height: 6 },
      { column: 1, row: 1, x: 64, y: 64, width: 64, height: 6 },
    ]);
    expect(tiles.consume()).toHaveLength(4);
    expect(tiles.dirty).toBe(false);
    expect(tiles.dirtyCount).toBe(0);
    expect(tiles.coverage).toBe(0);
    tiles.mark(null);
    expect(tiles.tileWidth).toBe(64);
    expect(tiles.tileHeight).toBe(64);
    expect(tiles.tileCount).toBe(6);
    expect(tiles.dirtyCount).toBe(6);
    expect(tiles.coverage).toBe(1);
    expect(tiles.tiles().at(-1)).toEqual({
      column: 2,
      row: 1,
      x: 128,
      y: 64,
      width: 2,
      height: 6,
    });
  });

  it("does not let an empty rect pull a union back to the origin", () => {
    expect(
      unionDamageRect(
        { x: 0, y: 0, width: 0, height: 0 },
        { x: 80, y: 90, width: 10, height: 20 },
      ),
    ).toEqual({ x: 80, y: 90, width: 10, height: 20 });
  });

  it("makes the caller's old-plus-new movement/deletion damage a single safe region", () => {
    expect(
      unionDamageRect(
        { x: 10, y: 20, width: 5, height: 6 },
        { x: 100, y: 200, width: 7, height: 8 },
      ),
    ).toEqual({ x: 10, y: 20, width: 97, height: 188 });
  });

  it("outsets old and new physical bounds without mutating either source", () => {
    const oldBounds = { x: 10, y: 20, width: 5, height: 6 };
    const nextBounds = { x: 100, y: 200, width: 7, height: 8 };
    const oldOutset = outsetDamageRect(oldBounds, 2)!;
    const nextOutset = outsetDamageRect(nextBounds, 2)!;
    expect(oldBounds).toEqual({ x: 10, y: 20, width: 5, height: 6 });
    expect(nextBounds).toEqual({ x: 100, y: 200, width: 7, height: 8 });
    expect(unionDamageRect(oldOutset, nextOutset)).toEqual({
      x: 8,
      y: 18,
      width: 101,
      height: 192,
    });
  });

  it("fails closed to every tile for an invalid damage rectangle", () => {
    const tiles = createDamageTiles(128, 64);
    tiles.mark({ x: Number.NaN, y: 0, width: 1, height: 1 });
    expect(tiles.dirtyCount).toBe(2);
    expect(tiles.coverage).toBe(1);
  });

  it("iterates dirty tiles with one reusable view instead of per-tile objects", () => {
    const tiles = createDamageTiles(128, 64);
    tiles.mark(null);
    const seen: unknown[] = [];
    const columns: number[] = [];
    tiles.forEach((tile) => {
      seen.push(tile);
      columns.push(tile.column);
    });
    expect(columns).toEqual([0, 1]);
    expect(seen[0]).toBe(seen[1]);
  });

  it("coalesces matching tile runs into exact non-overlapping replay regions", () => {
    const tiles = createDamageTiles(192, 192, 64);
    // A T shape is the important case: joining its bounding box would repaint
    // the clean bottom-right tile, while joining only equal row runs is exact.
    tiles.mark({ x: 0, y: 0, width: 192, height: 64 });
    tiles.mark({ x: 0, y: 64, width: 64, height: 64 });
    tiles.mark({ x: 128, y: 64, width: 64, height: 64 });
    const regions: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    tiles.forEachRegion((region) => regions.push({ ...region }));
    expect(regions).toEqual([
      { x: 0, y: 0, width: 192, height: 64 },
      { x: 0, y: 64, width: 64, height: 64 },
      { x: 128, y: 64, width: 64, height: 64 },
    ]);

    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        const x = column * 64 + 32;
        const y = row * 64 + 32;
        const covering = regions.filter(
          (region) =>
            x >= region.x &&
            x < region.x + region.width &&
            y >= region.y &&
            y < region.y + region.height,
        );
        expect(covering).toHaveLength(
          row === 0 || (row === 1 && column !== 1) ? 1 : 0,
        );
      }
    }
  });

  it("extends identical runs vertically and reuses the planned regions", () => {
    const tiles = createDamageTiles(192, 192, 64);
    tiles.mark({ x: 0, y: 0, width: 128, height: 128 });
    const first: unknown[] = [];
    const second: unknown[] = [];
    tiles.forEachRegion((region) => first.push(region));
    tiles.forEachRegion((region) => second.push(region));
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({ x: 0, y: 0, width: 128, height: 128 });
    // The hot path uses its high-water-mark region storage rather than
    // materialising a new rectangle list on every retained frame.
    expect(second[0]).toBe(first[0]);
  });
});

describe("ordered replay selection", () => {
  it("selects intersecting paint in order and closes exactly the opened clip scope", () => {
    const list = createDrawList();
    const clip = createClipRectView();
    clip.w = 100;
    clip.h = 100;
    list.pushQuad(quad(200, 0, 10, 10)); // 0: skipped
    list.pushClipRect(clip); // 1: reopened for selected command
    list.pushQuad(quad(10, 10, 10, 10)); // 2: selected
    list.pushQuad(quad(200, 10, 10, 10)); // 3: skipped inside scope
    list.popClip(); // 4: required closure
    list.pushQuad(quad(15, 15, 10, 10)); // 5: selected after the pop

    const mask = createReplayMask(list, { x: 0, y: 0, width: 40, height: 40 });
    expect(mask.indices()).toEqual([1, 2, 4, 5]);
    expect(mask.count).toBe(4);
  });

  it("declines unknown glyph bounds to a full/direct fallback", () => {
    const list = createDrawList();
    list.pushGlyphs({
      ...{ m: new Float32Array([1, 0, 0, 1, 500, 500]) },
      pixelsPerEm: 12,
      r: 1,
      g: 1,
      b: 1,
      a: 1,
      slots: new Int32Array([1]),
      positions: new Float32Array([0, 0]),
      glyphCount: 1,
      spreadPx: 0,
    });
    const mask = createReplayMask(list, { x: 0, y: 0, width: 1, height: 1 });
    expect(mask.requiresFullReplay).toBe(true);
    expect(mask.indices()).toEqual([]);
  });

  it("declines screen-dependent content before a retained tile is cleared", () => {
    const list = createDrawList();
    list.pushScreenEffect({ screenDependent: true, execute: () => true });
    const mask = createReplayMask(list, { x: 0, y: 0, width: 64, height: 64 });
    expect(mask).toMatchObject({ count: 0, requiresFullReplay: true });
  });

  it("expands candidates in final tile coordinates after a shrinking transform", () => {
    const list = createDrawList();
    const nearEdge = quad(641, 10, 1, 1);
    // Its unexpanded final x extent is [64.1, 64.2), just outside this tile.
    list.pushQuad(nearEdge);
    const damage = { x: 0, y: 0, width: 64, height: 64 };
    const transform = [0.1, 0, 0, 0.1, 0, 0];
    expect(
      createReplayMask(list, damage, { transform, rasterOutset: 0 }).indices(),
    ).toEqual([]);
    // The default one final pixel catches filtering/AA reach regardless of the
    // design-to-framebuffer transform's 0.1 scale.
    expect(createReplayMask(list, damage, { transform }).indices()).toEqual([
      0,
    ]);
  });

  it("does not grow a provider-owned cached bound across tile selections", () => {
    const list = createDrawList();
    list.pushQuad(quad(0, 0, 1, 1));
    const cached = { x: 64.1, y: 10, width: 0.1, height: 0.1 };
    const original = { ...cached };
    const scratch = createReplayMaskScratch();
    const options = { boundsAt: () => cached };
    const damage = { x: 0, y: 0, width: 64, height: 64 };
    expect(scratch.select(list, damage, options).indices()).toEqual([0]);
    expect(scratch.select(list, damage, options).indices()).toEqual([0]);
    expect(cached).toEqual(original);
  });

  it("fails closed instead of propagating invalid primitive bounds", () => {
    const list = createDrawList();
    const invalidQuad = quad(0, 0, 1, 1);
    invalidQuad.m[0] = Number.NaN;
    expect(commandDamageBounds(list, list.pushQuad(invalidQuad))).toBeNull();
    const line = createPolylineView(1);
    line.pointCount = 1;
    line.points[0] = Number.NaN;
    expect(commandDamageBounds(list, list.pushPolyline(line))).toBeNull();
    const mesh = createTexturedMeshView(1, 0);
    mesh.vertexCount = 1;
    mesh.positions[0] = Number.NaN;
    expect(commandDamageBounds(list, list.pushTexturedMesh(mesh))).toBeNull();
  });

  it("treats a selection threshold as the same full/direct fallback", () => {
    const list = createDrawList();
    list.pushQuad(quad(0, 0, 10, 10));
    const scratch = createReplayMaskScratch();
    const mask = scratch.select(
      list,
      { x: 0, y: 0, width: 20, height: 20 },
      { maxCommands: 0 },
    );
    expect(mask).toMatchObject({
      count: 0,
      thresholdExceeded: true,
      requiresFullReplay: true,
    });
    // The reusable scratch must not leak a previous decline into a later,
    // otherwise-valid partial selection.
    const recovered = scratch.select(
      list,
      { x: 0, y: 0, width: 20, height: 20 },
      { maxCommands: 1 },
    );
    expect(recovered).toMatchObject({
      count: 1,
      thresholdExceeded: false,
      requiresFullReplay: false,
    });
  });

  it("exposes the strict 40% retained command budget without imposing it on generic selection", () => {
    expect(maxPartialReplayCommands(10)).toBe(3);
    expect(maxPartialReplayCommands(5)).toBe(1);
    expect(maxPartialReplayCommands(1)).toBe(0);
  });

  it("fails closed for structurally unbalanced clip scopes", () => {
    const list = createDrawList();
    const clip = createClipRectView();
    clip.w = 10;
    clip.h = 10;
    list.pushClipRect(clip);
    const mask = createReplayMask(list, { x: 0, y: 0, width: 10, height: 10 });
    expect(mask).toMatchObject({ count: 0, requiresFullReplay: true });
  });
});
