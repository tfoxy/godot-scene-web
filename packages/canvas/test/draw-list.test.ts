import { describe, expect, it } from "vitest";
import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  commandDamageBounds,
  createClipRectView,
  createDrawList,
  createDrawListFragment,
  createDrawListPatchView,
  createGlyphsView,
  createNinePatchView,
  createPolylineView,
  createQuadView,
  createTexturedMeshView,
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_EXTERNAL_EFFECT,
  DRAW_GLYPHS,
  DRAW_NINE_PATCH,
  DRAW_POLYLINE,
  DRAW_QUAD,
  DRAW_SCREEN_EFFECT,
  DRAW_TEXTURED_MESH,
  FLIP_H,
  FLIP_V,
  setViewColorMatrix,
} from "../src/index";

// Payload values are stored in Float32Arrays, so every literal used in a
// round-trip assertion is exactly representable in float32 (halves/quarters).
function sampleQuad() {
  const quad = createQuadView();
  quad.m.set([2, 0.5, -0.5, 1.5, 128, -64]);
  quad.w = 96;
  quad.h = 48.5;
  quad.srcX = 12;
  quad.srcY = 34;
  quad.srcW = 100;
  quad.srcH = 200;
  quad.r = 0.25;
  quad.g = 0.5;
  quad.b = 0.75;
  quad.a = 0.5;
  quad.blend = BLEND_ADD;
  quad.flipH = true;
  quad.flipV = false;
  return quad;
}

function sampleGlyphs() {
  const run = createGlyphsView(4);
  run.m.set([2, 0.5, -0.5, 1.5, 128, -64]);
  run.pixelsPerEm = 14;
  run.r = 0.25;
  run.g = 0.5;
  run.b = 0.75;
  run.a = 0.5;
  run.slots.set([7, 0, 4096]);
  run.positions.set([0, 0, 14.5, -2.25, 29, 0]);
  run.glyphCount = 3;
  run.spreadPx = 2.5;
  run.localInkX = -1;
  run.localInkY = -2;
  run.localInkWidth = 32;
  run.localInkHeight = 18;
  run.localInkOutset = 1.5;
  return run;
}

function sampleTexturedMesh() {
  const mesh = createTexturedMeshView(4, 6);
  mesh.m.set([0, 2, -3, 0, 10, 20]);
  mesh.positions.set([0, 0, 4, 0, 4, 3, 0, 3]);
  mesh.uvs.set([0, 0, 1, 0, 1, 1, 0, 1]);
  mesh.indices.set([0, 1, 2, 0, 2, 3]);
  mesh.vertexCount = 4;
  mesh.indexCount = 6;
  mesh.r = 0.25;
  mesh.g = 0.5;
  mesh.b = 0.75;
  mesh.a = 0.5;
  mesh.blend = BLEND_MUL;
  return mesh;
}

describe("draw list storage", () => {
  it("round-trips a quad through the arenas", () => {
    const list = createDrawList<string>();
    const index = list.pushQuad(sampleQuad(), "page-0");

    expect(index).toBe(0);
    expect(list.count).toBe(1);
    expect(list.kindAt(0)).toBe(DRAW_QUAD);
    expect(list.kindNameAt(0)).toBe("quad");
    expect(list.textureAt(0)).toBe("page-0");

    const out = createQuadView();
    expect(list.readQuad(0, out)).toBe(out);
    expect(Array.from(out.m)).toEqual([2, 0.5, -0.5, 1.5, 128, -64]);
    expect(out.w).toBe(96);
    expect(out.h).toBe(48.5);
    expect([out.srcX, out.srcY, out.srcW, out.srcH]).toEqual([
      12, 34, 100, 200,
    ]);
    expect([out.r, out.g, out.b, out.a]).toEqual([0.25, 0.5, 0.75, 0.5]);
    expect(out.blend).toBe(BLEND_ADD);
    expect(out.flipH).toBe(true);
    expect(out.flipV).toBe(false);
    expect(out.hasColorMatrix).toBe(false);
  });

  it("keeps flip flags independent", () => {
    const list = createDrawList();
    const quad = createQuadView();
    for (const [flipH, flipV] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      quad.flipH = flipH;
      quad.flipV = flipV;
      list.pushQuad(quad);
    }

    const out = createQuadView();
    const flags = [0, 1, 2, 3].map((i) => {
      list.readQuad(i, out);
      return (out.flipH ? FLIP_H : 0) | (out.flipV ? FLIP_V : 0);
    });
    expect(flags).toEqual([0, FLIP_H, FLIP_V, FLIP_H | FLIP_V]);
  });

  it("stores a color matrix only for the commands that have one", () => {
    const list = createDrawList();
    const plain = createQuadView();
    const tinted = createQuadView();
    setViewColorMatrix(tinted, {
      rows: [
        [0.5, 0.25, 0],
        [0, 1, 0.125],
        [0.75, 0, 0.5],
      ],
    });

    list.pushQuad(plain);
    list.pushQuad(tinted);
    list.pushQuad(plain);

    expect(list.colorMatrixIndexAt(0)).toBe(-1);
    expect(list.colorMatrixIndexAt(1)).toBe(0);
    expect(list.colorMatrixIndexAt(2)).toBe(-1);

    const out = createQuadView();
    list.readQuad(1, out);
    expect(out.hasColorMatrix).toBe(true);
    expect(Array.from(out.colorMatrix)).toEqual([
      0.5, 0.25, 0, 0, 1, 0.125, 0.75, 0, 0.5,
    ]);

    // A reused view must not report a stale matrix on the next, plain command.
    list.readQuad(2, out);
    expect(out.hasColorMatrix).toBe(false);
  });

  it("disarms a view's matrix when passed null", () => {
    const view = createQuadView();
    setViewColorMatrix(view, {
      rows: [
        [2, 0, 0],
        [0, 2, 0],
        [0, 0, 2],
      ],
    });
    expect(view.hasColorMatrix).toBe(true);
    setViewColorMatrix(view, null);
    expect(view.hasColorMatrix).toBe(false);
  });

  it("round-trips a nine-patch with its margins", () => {
    const list = createDrawList<number>();
    const patch = createNinePatchView();
    Object.assign(patch, sampleQuad());
    patch.blend = BLEND_MUL;
    patch.marginLeft = 6;
    patch.marginTop = 7;
    patch.marginRight = 8;
    patch.marginBottom = 9;

    list.pushNinePatch(patch, 42);
    expect(list.kindAt(0)).toBe(DRAW_NINE_PATCH);
    expect(list.kindNameAt(0)).toBe("ninePatch");
    expect(list.textureAt(0)).toBe(42);

    const out = createNinePatchView();
    list.readNinePatch(0, out);
    expect([
      out.marginLeft,
      out.marginTop,
      out.marginRight,
      out.marginBottom,
    ]).toEqual([6, 7, 8, 9]);
    expect([out.srcX, out.srcY, out.srcW, out.srcH]).toEqual([
      12, 34, 100, 200,
    ]);
    expect(out.blend).toBe(BLEND_MUL);
    expect(out.w).toBe(96);
  });

  it("round-trips a polyline's flattened points", () => {
    const list = createDrawList();
    const line = createPolylineView(2);
    line.points.set([0, 0, 10, 20]);
    line.pointCount = 2;
    line.width = 2.5;
    line.r = 1;
    line.g = 0.5;
    line.b = 0;
    line.a = 0.25;

    list.pushPolyline(line);
    expect(list.kindAt(0)).toBe(DRAW_POLYLINE);
    expect(list.textureAt(0)).toBeNull();

    const out = createPolylineView(1);
    list.readPolyline(0, out);
    expect(out.pointCount).toBe(2);
    expect(Array.from(out.points.subarray(0, 4))).toEqual([0, 0, 10, 20]);
    expect(out.width).toBe(2.5);
    expect([out.r, out.g, out.b, out.a]).toEqual([1, 0.5, 0, 0.25]);
  });

  it("round-trips an indexed textured mesh without retaining its caller buffers", () => {
    const list = createDrawList<string>();
    const mesh = sampleTexturedMesh();
    const index = list.pushTexturedMesh(mesh, "mesh-page");
    mesh.positions.fill(99);
    mesh.uvs.fill(99);
    mesh.indices.fill(99);

    expect(list.kindAt(index)).toBe(DRAW_TEXTURED_MESH);
    expect(list.kindNameAt(index)).toBe("texturedMesh");
    expect(list.textureAt(index)).toBe("mesh-page");
    const out = list.readTexturedMesh(index, createTexturedMeshView(1, 1));
    expect([...out.m]).toEqual([0, 2, -3, 0, 10, 20]);
    expect([...out.positions.subarray(0, 8)]).toEqual([0, 0, 4, 0, 4, 3, 0, 3]);
    expect([...out.uvs.subarray(0, 8)]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect([...out.indices.subarray(0, 6)]).toEqual([0, 1, 2, 0, 2, 3]);
    expect([out.r, out.g, out.b, out.a, out.blend]).toEqual([
      0.25,
      0.5,
      0.75,
      0.5,
      BLEND_MUL,
    ]);
  });

  it("rejects malformed textured-mesh topology before reserving an arena slice", () => {
    const list = createDrawList();
    const mesh = sampleTexturedMesh();
    mesh.indices[5] = 4;
    expect(() => list.pushTexturedMesh(mesh)).toThrow(/outside 4 vertices/);
    expect(list.count).toBe(0);
    mesh.indices[5] = 3;
    mesh.indexCount = 5;
    expect(() => list.pushTexturedMesh(mesh)).toThrow(/not a triangle list/);
    expect(list.count).toBe(0);
  });

  it("reads only the claimed prefix of an oversized polyline buffer", () => {
    const list = createDrawList();
    const line = createPolylineView(8);
    line.points.set([1, 2, 3, 4, 999, 999]);
    line.pointCount = 2;
    list.pushPolyline(line);

    const out = createPolylineView(8);
    out.points.fill(-1);
    list.readPolyline(0, out);
    expect(out.pointCount).toBe(2);
    expect(Array.from(out.points.subarray(0, 4))).toEqual([1, 2, 3, 4]);
    expect(out.points[4]).toBe(-1);
  });

  it("rejects a polyline that claims more points than it carries", () => {
    const list = createDrawList();
    const line = createPolylineView(2);
    line.pointCount = 5;
    expect(() => list.pushPolyline(line)).toThrow(RangeError);
    expect(list.count).toBe(0);
  });

  it("round-trips clip rects including corner radius and x outset", () => {
    const list = createDrawList();
    const clip = createClipRectView();
    clip.x = 10;
    clip.y = 20;
    clip.w = 300;
    clip.h = 400;
    clip.cornerRadius = 12.5;
    clip.outsetX = 4;
    list.pushClipRect(clip);
    list.popClip();

    const out = createClipRectView();
    list.readClipRect(0, out);
    expect(out).toEqual({
      x: 10,
      y: 20,
      w: 300,
      h: 400,
      cornerRadius: 12.5,
      outsetX: 4,
    });
    expect(list.kindAt(0)).toBe(DRAW_CLIP_PUSH);
    expect(list.kindAt(1)).toBe(DRAW_CLIP_POP);
  });

  it("round-trips a glyph run's slots and pen positions", () => {
    const list = createDrawList();
    const run = sampleGlyphs();
    const index = list.pushGlyphs(run);

    expect(list.kindAt(index)).toBe(DRAW_GLYPHS);
    expect(list.kindNameAt(index)).toBe("glyphs");
    // Glyph runs carry no texture handle: the atlas is the executor's, and the
    // slot ids are what name a glyph inside it.
    expect(list.textureAt(index)).toBeNull();
    expect(list.colorMatrixIndexAt(index)).toBe(-1);

    const out = list.readGlyphs(index, createGlyphsView(1));
    expect([...out.m]).toEqual([2, 0.5, -0.5, 1.5, 128, -64]);
    expect(out.pixelsPerEm).toBe(14);
    expect([out.r, out.g, out.b, out.a]).toEqual([0.25, 0.5, 0.75, 0.5]);
    expect(out.glyphCount).toBe(3);
    expect([...out.slots.subarray(0, 3)]).toEqual([7, 0, 4096]);
    expect([...out.positions.subarray(0, 6)]).toEqual([
      0, 0, 14.5, -2.25, 29, 0,
    ]);
    // THE OUTLINE HALF OF THE HEADER, AND THE REASON THE STRIDE MOVED FROM 11 TO 12. A header
    // float that is written but never read back — or read out of the wrong slot — is an outline
    // that silently does not appear, or a fill that silently does, because everything downstream
    // of this is a number the shader simply believes.
    expect(out.spreadPx).toBe(2.5);
    expect([
      out.localInkX,
      out.localInkY,
      out.localInkWidth,
      out.localInkHeight,
      out.localInkOutset,
    ]).toEqual([-1, -2, 32, 18, 1.5]);
  });

  it("keeps a second run's pens clear of the first run's header", () => {
    // THE FAILURE A SINGLE ROUND-TRIP CANNOT SEE. `pushGlyphs` and `readGlyphs` both derive the pen
    // offset from `GLYPHS_HEADER_FLOATS`, so a stride bumped in the writer and not the reader — or
    // a payload sized off the old constant — still round-trips one run perfectly and corrupts the
    // NEXT one. Two runs back to back put real data on both sides of the boundary.
    const list = createDrawList();
    const second = createGlyphsView(2);
    second.glyphCount = 2;
    second.pixelsPerEm = 40;
    second.spreadPx = 1.25;
    second.slots.set([101, 202]);
    second.positions.set([9, 8, 7, 6]);

    const a = list.pushGlyphs(sampleGlyphs());
    const b = list.pushGlyphs(second);

    const outA = list.readGlyphs(a, createGlyphsView(1));
    expect([...outA.positions.subarray(0, 6)]).toEqual([
      0, 0, 14.5, -2.25, 29, 0,
    ]);
    expect(outA.spreadPx).toBe(2.5);

    const outB = list.readGlyphs(b, createGlyphsView(1));
    expect(outB.pixelsPerEm).toBe(40);
    expect(outB.spreadPx).toBe(1.25);
    expect([...outB.slots.subarray(0, 2)]).toEqual([101, 202]);
    expect([...outB.positions.subarray(0, 4)]).toEqual([9, 8, 7, 6]);
  });

  it("records a spread-less view from an older consumer as 0, not NaN", () => {
    // THE CONSUMER THIS REALLY HAPPENS TO. `../sts2-couch-coop` builds a `GlyphsView` field for
    // field rather than through `createGlyphsView`, and resolves this package through a
    // hand-maintained ambient `.d.ts` (see `AGENTS.md`). A field added here and not there does not
    // fail its typecheck — it arrives as `undefined`, which a Float32Array stores as NaN, and the
    // vertex shader multiplies a quad corner by it. The glyph pass's own `setSpread` clamps NaN
    // back to 0, so the shipped path survives; the IR must not hand a NaN to anything else.
    const list = createDrawList();
    const legacy = createGlyphsView(2);
    legacy.glyphCount = 1;
    legacy.slots.set([5]);
    legacy.positions.set([3, 4]);
    (legacy as { spreadPx?: number }).spreadPx = undefined;

    const index = list.pushGlyphs(legacy);
    const out = list.readGlyphs(index, createGlyphsView(1));
    expect(out.spreadPx).toBe(0);
    expect(Number.isNaN(out.spreadPx)).toBe(false);
    expect([...out.positions.subarray(0, 2)]).toEqual([3, 4]);
  });

  it("reads only the claimed prefix of an oversized glyph run buffer", () => {
    const list = createDrawList();
    const run = createGlyphsView(8);
    run.slots.set([11, 22, 33, 44, 55, 66, 77, 88]);
    run.positions.set([1, 2, 3, 4, 5, 6, 7, 8]);
    run.glyphCount = 2;
    const index = list.pushGlyphs(run);

    const out = list.readGlyphs(index, createGlyphsView(8));
    expect(out.glyphCount).toBe(2);
    expect([...out.slots.subarray(0, 2)]).toEqual([11, 22]);
    expect([...out.positions.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
  });

  it("rejects a glyph run that claims more glyphs than it carries", () => {
    const list = createDrawList();
    const run = createGlyphsView(2);
    run.glyphCount = 3;
    expect(() => list.pushGlyphs(run)).toThrow(RangeError);
  });

  it("grows a glyph read-back buffer that is too small", () => {
    const list = createDrawList();
    const run = createGlyphsView(6);
    run.slots.set([1, 2, 3, 4, 5, 6]);
    run.positions.set([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    run.glyphCount = 6;
    const index = list.pushGlyphs(run);

    const out = createGlyphsView(1);
    list.readGlyphs(index, out);
    expect(out.slots.length).toBeGreaterThanOrEqual(6);
    expect(out.positions.length).toBeGreaterThanOrEqual(12);
    expect([...out.slots.subarray(0, 6)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("preserves command order across mixed kinds", () => {
    const list = createDrawList();
    list.pushClipRect(createClipRectView());
    list.pushQuad(createQuadView());
    list.pushPolyline(createPolylineView(2));
    list.pushGlyphs(createGlyphsView(1));
    list.pushTexturedMesh(sampleTexturedMesh());
    list.pushNinePatch(createNinePatchView());
    list.popClip();

    expect([0, 1, 2, 3, 4, 5, 6].map((i) => list.kindNameAt(i))).toEqual([
      "clipPush",
      "quad",
      "polyline",
      "glyphs",
      "texturedMesh",
      "ninePatch",
      "clipPop",
    ]);
  });

  it("hands out non-overlapping arena slices", () => {
    const list = createDrawList();
    const quad = sampleQuad();
    list.pushQuad(quad);
    list.pushQuad(quad);
    list.pushClipRect(createClipRectView());

    expect(list.floatOffsetAt(0)).toBe(0);
    expect(list.floatOffsetAt(1)).toBe(16);
    expect(list.floatOffsetAt(2)).toBe(32);
    expect(list.intOffsetAt(0)).toBe(0);
    expect(list.intOffsetAt(1)).toBe(3);
    // Clip pushes carry no ints, so the next command starts where they left off.
    expect(list.intOffsetAt(2)).toBe(6);
  });

  it("throws for out-of-range indices and mismatched kinds", () => {
    const list = createDrawList();
    list.pushQuad(createQuadView());

    expect(() => list.kindAt(1)).toThrow(RangeError);
    expect(() => list.kindAt(-1)).toThrow(RangeError);
    expect(() => list.readQuad(1, createQuadView())).toThrow(RangeError);
    expect(() => list.readClipRect(0, createClipRectView())).toThrow(TypeError);
    expect(() => list.readPolyline(0, createPolylineView())).toThrow(
      /is "quad", not "polyline"/,
    );
  });
});

describe("draw list growth", () => {
  it("grows past its initial command capacity without losing commands", () => {
    const list = createDrawList<string>({
      commandCapacity: 2,
      floatCapacity: 4,
      intCapacity: 1,
      colorMatrixCapacity: 1,
    });
    const quad = sampleQuad();
    const total = 50;
    for (let i = 0; i < total; i += 1) {
      quad.w = i;
      list.pushQuad(quad, `page-${i}`);
    }

    expect(list.count).toBe(total);
    expect(list.floats.length).toBeGreaterThanOrEqual(total * 16);
    expect(list.ints.length).toBeGreaterThanOrEqual(total * 3);

    const out = createQuadView();
    for (let i = 0; i < total; i += 1) {
      list.readQuad(i, out);
      expect(out.w).toBe(i);
      expect(out.h).toBe(48.5);
      expect(list.textureAt(i)).toBe(`page-${i}`);
    }
  });

  it("grows the color-matrix arena independently", () => {
    const list = createDrawList({ colorMatrixCapacity: 1 });
    const quad = createQuadView();
    for (let i = 0; i < 10; i += 1) {
      setViewColorMatrix(quad, {
        rows: [
          [i, 0, 0],
          [0, i, 0],
          [0, 0, i],
        ],
      });
      list.pushQuad(quad);
    }

    expect(list.colorMatrices.length).toBeGreaterThanOrEqual(90);
    const out = createQuadView();
    for (let i = 0; i < 10; i += 1) {
      list.readQuad(i, out);
      expect(out.hasColorMatrix).toBe(true);
      expect(out.colorMatrix[0]).toBe(i);
      expect(out.colorMatrix[4]).toBe(i);
      expect(out.colorMatrix[8]).toBe(i);
    }
  });

  it("grows a polyline read-back buffer that is too small", () => {
    const list = createDrawList();
    const line = createPolylineView(64);
    for (let i = 0; i < 64; i += 1) {
      line.points[i * 2] = i;
      line.points[i * 2 + 1] = -i;
    }
    line.pointCount = 64;
    list.pushPolyline(line);

    const out = createPolylineView(2);
    list.readPolyline(0, out);
    expect(out.pointCount).toBe(64);
    expect(out.points.length).toBeGreaterThanOrEqual(128);
    expect(out.points[126]).toBe(63);
    expect(out.points[127]).toBe(-63);
  });

  it("keeps a grown arena alive across a reset (buffers are pooled)", () => {
    const list = createDrawList({ commandCapacity: 1, floatCapacity: 1 });
    const quad = sampleQuad();
    for (let i = 0; i < 20; i += 1) list.pushQuad(quad);
    const grownFloats = list.floats.length;

    list.reset();
    expect(list.count).toBe(0);
    expect(list.floats.length).toBe(grownFloats);

    list.pushQuad(quad);
    expect(list.floats.length).toBe(grownFloats);
  });
});

describe("draw list reset", () => {
  it("rewinds the write cursors and reuses the arena slots", () => {
    const list = createDrawList();
    list.pushQuad(sampleQuad(), null);
    list.pushClipRect(createClipRectView());
    list.reset();

    expect(list.count).toBe(0);
    expect(list.clipDepth).toBe(0);
    expect(list.maxClipDepth).toBe(0);
    expect(() => list.kindAt(0)).toThrow(RangeError);

    const second = createQuadView();
    second.w = 7;
    list.pushQuad(second);
    expect(list.count).toBe(1);
    expect(list.floatOffsetAt(0)).toBe(0);
    const out = createQuadView();
    list.readQuad(0, out);
    expect(out.w).toBe(7);
  });

  it("drops texture handle references so a reset frame retains nothing", () => {
    const list = createDrawList<{ id: string }>();
    const texture = { id: "page-0" };
    list.pushQuad(createQuadView(), texture);
    expect(list.textureAt(0)).toBe(texture);

    list.reset();
    list.pushClipRect(createClipRectView());
    expect(list.textureAt(0)).toBeNull();
  });

  it("restarts color-matrix numbering", () => {
    const list = createDrawList();
    const quad = createQuadView();
    setViewColorMatrix(quad, {
      rows: [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ],
    });
    list.pushQuad(quad);
    expect(list.colorMatrixIndexAt(0)).toBe(0);

    list.reset();
    list.pushQuad(quad);
    expect(list.colorMatrixIndexAt(0)).toBe(0);
    const out = createQuadView();
    list.readQuad(0, out);
    expect(Array.from(out.colorMatrix)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("clip nesting bookkeeping", () => {
  it("tracks current and peak depth", () => {
    const list = createDrawList();
    const clip = createClipRectView();
    expect(list.clipDepth).toBe(0);

    list.pushClipRect(clip);
    expect(list.clipDepth).toBe(1);
    list.pushClipRect(clip);
    list.pushClipRect(clip);
    expect(list.clipDepth).toBe(3);
    expect(list.maxClipDepth).toBe(3);

    list.popClip();
    list.popClip();
    expect(list.clipDepth).toBe(1);
    expect(list.maxClipDepth).toBe(3);

    list.pushClipRect(clip);
    expect(list.clipDepth).toBe(2);
    expect(list.maxClipDepth).toBe(3);

    list.popClip();
    list.popClip();
    expect(list.clipDepth).toBe(0);
    expect(list.maxClipDepth).toBe(3);
  });

  it("refuses to pop more than was pushed, and records nothing when it does", () => {
    const list = createDrawList();
    list.pushClipRect(createClipRectView());
    list.popClip();
    expect(() => list.popClip()).toThrow(RangeError);
    expect(list.count).toBe(2);
    expect(list.clipDepth).toBe(0);
  });

  it("keeps each nested clip's own rect", () => {
    const list = createDrawList();
    const clip = createClipRectView();
    clip.x = 0;
    clip.w = 100;
    list.pushClipRect(clip);
    clip.x = 25;
    clip.w = 50;
    clip.cornerRadius = 8;
    list.pushClipRect(clip);
    list.popClip();
    list.popClip();

    const out = createClipRectView();
    list.readClipRect(0, out);
    expect([out.x, out.w, out.cornerRadius]).toEqual([0, 100, 0]);
    list.readClipRect(1, out);
    expect([out.x, out.w, out.cornerRadius]).toEqual([25, 50, 8]);
  });
});

describe("in-place patching", () => {
  it("patches mesh positions, UVs and source without moving its retained topology", () => {
    const list = createDrawList<string>();
    const index = list.pushTexturedMesh(sampleTexturedMesh(), "before");
    list.patchTexturedMeshPositions(
      index,
      new Float32Array([8, 9, 10, 11, 12, 13, 14, 15]),
    );
    list.patchTexturedMeshUvs(
      index,
      new Float32Array([0.25, 0.5, 0.75, 0.5, 0.75, 1, 0.25, 1]),
    );
    list.patchTexturedMeshSource(index, "after");

    const out = list.readTexturedMesh(index, createTexturedMeshView());
    expect([...out.positions.subarray(0, 8)]).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect([...out.uvs.subarray(0, 8)]).toEqual([
      0.25, 0.5, 0.75, 0.5, 0.75, 1, 0.25, 1,
    ]);
    expect([...out.indices.subarray(0, 6)]).toEqual([0, 1, 2, 0, 2, 3]);
    expect([...out.m]).toEqual([0, 2, -3, 0, 10, 20]);
    expect(list.textureAt(index)).toBe("after");
  });

  it("replaces a quad's colour and nothing else", () => {
    const list = createDrawList<string>();
    const index = list.pushQuad(sampleQuad(), "page-0");

    list.patchQuadColor(index, 0.125, 0.25, 0.375, 0.5);

    const out = createQuadView();
    list.readQuad(index, out);
    expect([out.r, out.g, out.b, out.a]).toEqual([0.125, 0.25, 0.375, 0.5]);
    // Everything the patch must not have touched.
    expect(Array.from(out.m)).toEqual([2, 0.5, -0.5, 1.5, 128, -64]);
    expect([out.w, out.h]).toEqual([96, 48.5]);
    expect([out.srcX, out.srcY, out.srcW, out.srcH]).toEqual([
      12, 34, 100, 200,
    ]);
    expect(out.blend).toBe(BLEND_ADD);
    expect(out.flipH).toBe(true);
    expect(list.textureAt(index)).toBe("page-0");
  });

  it("replaces a quad's transform and nothing else", () => {
    const list = createDrawList();
    const index = list.pushQuad(sampleQuad());

    list.patchQuadTransform(index, [1, 0, 0, 1, 8, 16]);

    const out = createQuadView();
    list.readQuad(index, out);
    expect(Array.from(out.m)).toEqual([1, 0, 0, 1, 8, 16]);
    expect([out.w, out.h]).toEqual([96, 48.5]);
    expect([out.r, out.g, out.b, out.a]).toEqual([0.25, 0.5, 0.75, 0.5]);
    expect(out.blend).toBe(BLEND_ADD);

    // A longer buffer is fine — only the first six entries are read, which is
    // what lets a caller hand over a reusable scratch matrix.
    list.patchQuadTransform(index, [3, 0, 0, 3, 0, 0, 999, 999]);
    list.readQuad(index, out);
    expect(Array.from(out.m)).toEqual([3, 0, 0, 3, 0, 0]);
    expect(() => list.patchQuadTransform(index, [1, 0, 0, 1, 0])).toThrow(
      RangeError,
    );
  });

  it("patches a nine-patch, leaving its margins intact", () => {
    const list = createDrawList();
    const patch = createNinePatchView();
    Object.assign(patch, sampleQuad());
    patch.marginLeft = 6;
    patch.marginTop = 7;
    patch.marginRight = 8;
    patch.marginBottom = 9;
    const index = list.pushNinePatch(patch);

    list.patchQuadColor(index, 0, 0, 0, 0.25);
    list.patchQuadTransform(index, [1, 0, 0, 1, -4, -8]);

    const out = createNinePatchView();
    list.readNinePatch(index, out);
    expect([out.r, out.g, out.b, out.a]).toEqual([0, 0, 0, 0.25]);
    expect(Array.from(out.m)).toEqual([1, 0, 0, 1, -4, -8]);
    expect([
      out.marginLeft,
      out.marginTop,
      out.marginRight,
      out.marginBottom,
    ]).toEqual([6, 7, 8, 9]);
    expect([out.srcW, out.srcH]).toEqual([100, 200]);
  });

  it("refuses commands that are not quad-like, and out-of-range indices", () => {
    const list = createDrawList();
    list.pushPolyline(createPolylineView(2));
    list.pushClipRect(createClipRectView());
    list.popClip();

    expect(() => list.patchQuadColor(0, 1, 1, 1, 1)).toThrow(
      /is "polyline", not a quad-like command/,
    );
    expect(() => list.patchQuadTransform(1, [1, 0, 0, 1, 0, 0])).toThrow(
      TypeError,
    );
    expect(() => list.patchQuadColor(2, 1, 1, 1, 1)).toThrow(TypeError);
    expect(() => list.patchQuadColor(3, 1, 1, 1, 1)).toThrow(RangeError);
    expect(() => list.patchQuadTransform(-1, [1, 0, 0, 1, 0, 0])).toThrow(
      RangeError,
    );
  });

  it("patches a glyph run's transform and colour, leaving its glyphs alone", () => {
    const list = createDrawList();
    const index = list.pushGlyphs(sampleGlyphs());

    list.patchGlyphsTransform(index, [1, 0, 0, 1, 10, 20]);
    list.patchGlyphsColor(index, 0.125, 0.25, 0.375, 0.5);

    const out = list.readGlyphs(index, createGlyphsView(1));
    expect([...out.m]).toEqual([1, 0, 0, 1, 10, 20]);
    expect([out.r, out.g, out.b, out.a]).toEqual([0.125, 0.25, 0.375, 0.5]);
    expect(out.pixelsPerEm).toBe(14);
    expect(out.glyphCount).toBe(3);
    expect([...out.slots.subarray(0, 3)]).toEqual([7, 0, 4096]);
    expect([...out.positions.subarray(0, 6)]).toEqual([
      0, 0, 14.5, -2.25, 29, 0,
    ]);
    // AND THE SPREAD, which neither patcher writes. It was APPENDED at float 11 rather than
    // inserted, precisely so the transform's 0..5 and the colour's 7..10 did not move under both
    // patchers — a shift there is a silently recoloured, or silently fattened, run.
    expect(out.spreadPx).toBe(2.5);
  });

  it("keeps the quad and glyph patch guards apart", () => {
    const list = createDrawList();
    list.pushQuad(sampleQuad());
    list.pushGlyphs(sampleGlyphs());

    expect(() => list.patchQuadTransform(1, [1, 0, 0, 1, 0, 0])).toThrow(
      /is "glyphs", not a quad-like command/,
    );
    expect(() => list.patchGlyphsColor(0, 1, 1, 1, 1)).toThrow(
      /is "quad", not "glyphs"/,
    );
  });

  it("patches a command recorded before the arena grew", () => {
    // THE HAZARD THE DOC WARNS ABOUT, as a test: a caller that captured
    // `list.floats` at push time would be writing into a dead buffer here,
    // because the pushes below reallocate the arena. Going through the method
    // re-reads it.
    const list = createDrawList({ commandCapacity: 1, floatCapacity: 4 });
    const first = list.pushQuad(sampleQuad());
    const staleFloats = list.floats;
    for (let i = 0; i < 40; i += 1) list.pushQuad(sampleQuad());
    expect(list.floats).not.toBe(staleFloats);

    list.patchQuadColor(first, 1, 0, 0, 1);
    list.patchQuadTransform(first, [1, 0, 0, 1, 5, 6]);

    const out = createQuadView();
    list.readQuad(first, out);
    expect([out.r, out.g, out.b, out.a]).toEqual([1, 0, 0, 1]);
    expect(Array.from(out.m)).toEqual([1, 0, 0, 1, 5, 6]);
    // The neighbours are untouched: a patch writes one command's slots.
    list.readQuad(1, out);
    expect([out.r, out.g, out.b, out.a]).toEqual([0.25, 0.5, 0.75, 0.5]);
    expect(Array.from(out.m)).toEqual([2, 0.5, -0.5, 1.5, 128, -64]);
  });

  it("patches a quad source and texture without disturbing its other payload", () => {
    const list = createDrawList<string>({
      commandCapacity: 1,
      floatCapacity: 4,
    });
    const first = list.pushQuad(sampleQuad(), "old-page");
    for (let i = 0; i < 40; i += 1) list.pushQuad(sampleQuad(), "other-page");

    list.patchQuadSource(first, "new-page", 1, 2, 3, 4);

    const out = list.readQuad(first, createQuadView());
    expect(list.textureAt(first)).toBe("new-page");
    expect([out.srcX, out.srcY, out.srcW, out.srcH]).toEqual([1, 2, 3, 4]);
    expect([...out.m]).toEqual([2, 0.5, -0.5, 1.5, 128, -64]);
    expect([
      out.r,
      out.g,
      out.b,
      out.a,
      out.blend,
      out.flipH,
      out.flipV,
    ]).toEqual([0.25, 0.5, 0.75, 0.5, BLEND_ADD, true, false]);
  });

  it("accepts nine-patches and rejects non-quad source patches", () => {
    const list = createDrawList<string>();
    const patch = createNinePatchView();
    patch.w = 10;
    patch.h = 20;
    const patchIndex = list.pushNinePatch(patch, "old");
    list.patchQuadSource(patchIndex, "new", 4, 5, 6, 7);
    const out = list.readNinePatch(patchIndex, createNinePatchView());
    expect(list.textureAt(patchIndex)).toBe("new");
    expect([out.srcX, out.srcY, out.srcW, out.srcH, out.w, out.h]).toEqual([
      4, 5, 6, 7, 10, 20,
    ]);
    const line = list.pushPolyline(createPolylineView());
    expect(() => list.patchQuadSource(line, "no", 0, 0, 1, 1)).toThrow(
      /not a quad-like command/,
    );
  });

  it("leaves the colour matrix alone — arena and index both", () => {
    const list = createDrawList();
    const tinted = createQuadView();
    setViewColorMatrix(tinted, {
      rows: [
        [0.5, 0.25, 0],
        [0, 1, 0.125],
        [0.75, 0, 0.5],
      ],
    });
    list.pushQuad(tinted);
    list.pushQuad(createQuadView());

    list.patchQuadColor(0, 0.5, 0.5, 0.5, 0.5);
    list.patchQuadTransform(0, [0, 1, -1, 0, 0, 0]);
    list.patchQuadColor(1, 0.25, 0.25, 0.25, 1);

    expect(list.colorMatrixIndexAt(0)).toBe(0);
    expect(list.colorMatrixIndexAt(1)).toBe(-1);
    const out = createQuadView();
    list.readQuad(0, out);
    expect(out.hasColorMatrix).toBe(true);
    expect(Array.from(out.colorMatrix)).toEqual([
      0.5, 0.25, 0, 0, 1, 0.125, 0.75, 0, 0.5,
    ]);
    // The patch is not a colour operation: it does not append a matrix either.
    expect(Array.from(list.colorMatrices.subarray(9, 18))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("leaves no residue for the command that reuses the slot after a reset", () => {
    const list = createDrawList();
    list.pushQuad(sampleQuad());
    // Values a freshly created view could never hold, so the assertions below
    // fail loudly if the arena slots were reused without being rewritten.
    list.patchQuadColor(0, 0.5, 0.25, 0.125, 0.0625);
    list.patchQuadTransform(0, [9, 9, 9, 9, 9, 9]);
    list.reset();

    const fresh = createQuadView();
    fresh.w = 7;
    const index = list.pushQuad(fresh);
    expect(index).toBe(0);
    const out = createQuadView();
    list.readQuad(0, out);
    expect(Array.from(out.m)).toEqual([1, 0, 0, 1, 0, 0]);
    expect([out.r, out.g, out.b, out.a]).toEqual([1, 1, 1, 1]);
    expect(out.w).toBe(7);
  });
});

describe("blend modes", () => {
  it("round-trips every mode", () => {
    const list = createDrawList();
    const quad = createQuadView();
    for (const blend of [BLEND_MIX, BLEND_ADD, 2, BLEND_MUL] as const) {
      quad.blend = blend;
      list.pushQuad(quad);
    }
    const out = createQuadView();
    const modes = [0, 1, 2, 3].map((i) => list.readQuad(i, out).blend);
    expect(modes).toEqual([0, 1, 2, 3]);
  });
});

describe("retained draw-list fragments", () => {
  function mixedFragmentSource() {
    const source = createDrawList<object>();
    const quadTexture = { name: "quad" };
    const patchTexture = { name: "patch" };
    const meshTexture = { name: "mesh" };
    const screen = { screenDependent: true as const, execute: () => false };
    const external = { execute: () => false };
    const clip = createClipRectView();
    clip.x = 3;
    clip.y = 4;
    clip.w = 80;
    clip.h = 60;
    clip.cornerRadius = 5;
    clip.outsetX = 2;
    source.pushClipRect(clip);

    const quad = sampleQuad();
    setViewColorMatrix(quad, {
      rows: [
        [0.5, 0.25, 0],
        [0, 1, 0.125],
        [0.75, 0, 0.5],
      ],
    });
    source.pushQuad(quad, quadTexture);

    const patch = createNinePatchView();
    Object.assign(patch, sampleQuad());
    patch.marginLeft = 2;
    patch.marginTop = 3;
    patch.marginRight = 4;
    patch.marginBottom = 5;
    source.pushNinePatch(patch, patchTexture);

    const line = createPolylineView(3);
    line.points.set([1, 2, 3, 5, 8, 13]);
    line.pointCount = 3;
    line.width = 1.5;
    line.r = 0.25;
    line.g = 0.5;
    line.b = 0.75;
    line.a = 0.5;
    source.pushPolyline(line);
    source.pushGlyphs(sampleGlyphs());
    source.pushTexturedMesh(sampleTexturedMesh(), meshTexture);
    source.pushScreenEffect(screen);
    source.pushExternalEffect(external);
    source.popClip();
    return { source, quadTexture, patchTexture, meshTexture, screen, external };
  }

  it("clones every command payload and appends it in exact painter order", () => {
    const { source, quadTexture, patchTexture, meshTexture, screen, external } =
      mixedFragmentSource();
    const fragment = createDrawListFragment<object>({
      commandCapacity: 1,
      floatCapacity: 1,
      intCapacity: 1,
      colorMatrixCapacity: 1,
    });
    fragment.capture(source, 0, source.count);
    expect([fragment.count, fragment.clipDepth, fragment.maxClipDepth]).toEqual(
      [source.count, 0, 1],
    );

    const destination = createDrawList<object>({
      commandCapacity: 1,
      floatCapacity: 1,
      intCapacity: 1,
      colorMatrixCapacity: 1,
    });
    const prefix = destination.pushQuad(createQuadView(), { name: "prefix" });
    const start = destination.appendFragment(fragment);
    const suffix = destination.pushQuad(createQuadView(), { name: "suffix" });
    expect([prefix, start, suffix]).toEqual([0, 1, source.count + 1]);
    expect(destination.count).toBe(source.count + 2);
    expect(
      Array.from({ length: source.count }, (_, index) =>
        destination.kindNameAt(start + index),
      ),
    ).toEqual([
      "clipPush",
      "quad",
      "ninePatch",
      "polyline",
      "glyphs",
      "texturedMesh",
      "screenEffect",
      "externalEffect",
      "clipPop",
    ]);
    expect(destination.clipDepth).toBe(0);
    expect(destination.maxClipDepth).toBe(1);
    expect(destination.readClipRect(start, createClipRectView())).toEqual({
      x: 3,
      y: 4,
      w: 80,
      h: 60,
      cornerRadius: 5,
      outsetX: 2,
    });

    const quad = destination.readQuad(start + 1, createQuadView());
    expect([
      ...quad.m,
      quad.w,
      quad.h,
      quad.srcX,
      quad.srcY,
      quad.srcW,
      quad.srcH,
    ]).toEqual([2, 0.5, -0.5, 1.5, 128, -64, 96, 48.5, 12, 34, 100, 200]);
    expect([
      quad.r,
      quad.g,
      quad.b,
      quad.a,
      quad.blend,
      quad.flipH,
      quad.flipV,
    ]).toEqual([0.25, 0.5, 0.75, 0.5, BLEND_ADD, true, false]);
    expect([...quad.colorMatrix]).toEqual([
      0.5, 0.25, 0, 0, 1, 0.125, 0.75, 0, 0.5,
    ]);
    expect(destination.textureAt(start + 1)).toBe(quadTexture);

    const patch = destination.readNinePatch(start + 2, createNinePatchView());
    expect([
      patch.marginLeft,
      patch.marginTop,
      patch.marginRight,
      patch.marginBottom,
    ]).toEqual([2, 3, 4, 5]);
    expect([
      ...patch.m,
      patch.w,
      patch.h,
      patch.srcX,
      patch.srcY,
      patch.srcW,
      patch.srcH,
      patch.r,
      patch.g,
      patch.b,
      patch.a,
      patch.blend,
      patch.flipH,
      patch.flipV,
    ]).toEqual([
      2,
      0.5,
      -0.5,
      1.5,
      128,
      -64,
      96,
      48.5,
      12,
      34,
      100,
      200,
      0.25,
      0.5,
      0.75,
      0.5,
      BLEND_ADD,
      true,
      false,
    ]);
    expect(destination.textureAt(start + 2)).toBe(patchTexture);
    const line = destination.readPolyline(start + 3, createPolylineView());
    expect([
      ...line.points.subarray(0, 6),
      line.width,
      line.r,
      line.g,
      line.b,
      line.a,
    ]).toEqual([1, 2, 3, 5, 8, 13, 1.5, 0.25, 0.5, 0.75, 0.5]);
    const glyphs = destination.readGlyphs(start + 4, createGlyphsView());
    expect([...glyphs.slots.subarray(0, glyphs.glyphCount)]).toEqual([
      7, 0, 4096,
    ]);
    expect([...glyphs.positions.subarray(0, glyphs.glyphCount * 2)]).toEqual([
      0, 0, 14.5, -2.25, 29, 0,
    ]);
    expect([
      ...glyphs.m,
      glyphs.pixelsPerEm,
      glyphs.r,
      glyphs.g,
      glyphs.b,
      glyphs.a,
      glyphs.spreadPx,
      glyphs.localInkX,
      glyphs.localInkY,
      glyphs.localInkWidth,
      glyphs.localInkHeight,
      glyphs.localInkOutset,
    ]).toEqual([
      2, 0.5, -0.5, 1.5, 128, -64, 14, 0.25, 0.5, 0.75, 0.5, 2.5, -1, -2, 32,
      18, 1.5,
    ]);
    const mesh = destination.readTexturedMesh(
      start + 5,
      createTexturedMeshView(),
    );
    expect([
      ...mesh.m,
      ...mesh.positions.subarray(0, 8),
      ...mesh.uvs.subarray(0, 8),
      ...mesh.indices.subarray(0, 6),
    ]).toEqual([
      0, 2, -3, 0, 10, 20, 0, 0, 4, 0, 4, 3, 0, 3, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1,
      2, 0, 2, 3,
    ]);
    expect([mesh.r, mesh.g, mesh.b, mesh.a, mesh.blend]).toEqual([
      0.25,
      0.5,
      0.75,
      0.5,
      BLEND_MUL,
    ]);
    expect(destination.textureAt(start + 5)).toBe(meshTexture);
    expect(destination.kindAt(start + 6)).toBe(DRAW_SCREEN_EFFECT);
    expect(destination.screenEffectAt(start + 6)).toBe(screen);
    expect(destination.kindAt(start + 7)).toBe(DRAW_EXTERNAL_EFFECT);
    expect(destination.externalEffectAt(start + 7)).toBe(external);

    for (let index = 0; index < source.count; index += 1) {
      expect(
        commandDamageBounds(source, index),
        `damage command ${index}`,
      ).toEqual(commandDamageBounds(destination, start + index));
    }
  });

  it("survives source patches and reset, while reusing destination backing storage", () => {
    const { source } = mixedFragmentSource();
    const fragment = createDrawListFragment<object>({
      commandCapacity: 1,
      floatCapacity: 1,
      intCapacity: 1,
    });
    fragment.capture(source, 0, source.count);
    const destination = createDrawList<object>({
      commandCapacity: 1,
      floatCapacity: 1,
      intCapacity: 1,
    });
    const structuralBefore = destination.structuralRevision;
    const contentBefore = destination.contentRevision;
    destination.appendFragment(fragment);
    expect(destination.structuralRevision).toBe(
      structuralBefore + fragment.count,
    );
    expect(destination.contentRevision).toBe(contentBefore + fragment.count);
    const floats = destination.floats;
    const ints = destination.ints;
    const matrices = destination.colorMatrices;

    source.patchQuadColor(1, 0, 0, 0, 0);
    source.reset();
    source.pushQuad(createQuadView());
    destination.reset();
    const afterReset = destination.structuralRevision;
    destination.appendFragment(fragment);
    expect(destination.structuralRevision).toBe(afterReset + fragment.count);
    expect(destination.floats).toBe(floats);
    expect(destination.ints).toBe(ints);
    expect(destination.colorMatrices).toBe(matrices);
    const quad = destination.readQuad(1, createQuadView());
    expect([quad.r, quad.g, quad.b, quad.a]).toEqual([0.25, 0.5, 0.75, 0.5]);
  });

  it("atomically overwrites a same-shaped fragment without changing command layout", () => {
    const original = mixedFragmentSource();
    const replacement = mixedFragmentSource();
    // Make the retained matrix distinguishable from the old destination bytes.
    replacement.source.colorMatrices[
      replacement.source.colorMatrixIndexAt(1) * 9
    ] = 0.125;
    const originalFragment = createDrawListFragment<object>();
    originalFragment.capture(original.source, 0, original.source.count);
    const replacementFragment = createDrawListFragment<object>();
    replacementFragment.capture(
      replacement.source,
      0,
      replacement.source.count,
    );
    const destination = createDrawList<object>({ patchJournalCapacity: 32 });
    destination.appendFragment(originalFragment);
    const structuralBefore = destination.structuralRevision;
    const contentBefore = destination.contentRevision;
    const matrixSlot = destination.colorMatrixIndexAt(1);
    const oldTextures = Array.from({ length: destination.count }, (_, index) =>
      destination.textureAt(index),
    );

    expect(destination.patchFragment(0, replacementFragment)).toBe(true);
    expect(destination.structuralRevision).toBe(structuralBefore);
    expect(destination.contentRevision).toBe(
      contentBefore + replacementFragment.count,
    );
    expect(destination.colorMatrixIndexAt(1)).toBe(matrixSlot);
    expect(
      Array.from(
        destination.colorMatrices.subarray(matrixSlot * 9, matrixSlot * 9 + 9),
      ),
    ).toEqual(
      Array.from(
        replacement.source.colorMatrices.subarray(
          replacement.source.colorMatrixIndexAt(1) * 9,
          replacement.source.colorMatrixIndexAt(1) * 9 + 9,
        ),
      ),
    );

    const patchView = createDrawListPatchView();
    destination.readPatchesSince(contentBefore, patchView);
    expect(patchView.overflowed).toBe(false);
    expect(patchView.indices).toEqual(
      Array.from({ length: replacementFragment.count }, (_, index) => index),
    );
    for (let index = 0; index < destination.count; index += 1) {
      expect(destination.commandRevisionAt(index)).toBeGreaterThan(
        contentBefore,
      );
      expect(destination.kindAt(index)).toBe(replacement.source.kindAt(index));
    }

    expect(destination.textureAt(1)).toBe(replacement.quadTexture);
    expect(destination.textureAt(2)).toBe(replacement.patchTexture);
    expect(destination.textureAt(5)).toBe(replacement.meshTexture);
    expect(destination.textureAt(1)).not.toBe(oldTextures[1]);
    expect(destination.screenEffectAt(6)).toBe(replacement.screen);
    expect(destination.externalEffectAt(7)).toBe(replacement.external);
    expect(destination.readClipRect(0, createClipRectView())).toEqual(
      replacement.source.readClipRect(0, createClipRectView()),
    );
    expect(destination.readQuad(1, createQuadView())).toEqual(
      replacement.source.readQuad(1, createQuadView()),
    );
    expect(destination.readNinePatch(2, createNinePatchView())).toEqual(
      replacement.source.readNinePatch(2, createNinePatchView()),
    );
    expect(destination.readPolyline(3, createPolylineView())).toEqual(
      replacement.source.readPolyline(3, createPolylineView()),
    );
    expect(destination.readGlyphs(4, createGlyphsView())).toEqual(
      replacement.source.readGlyphs(4, createGlyphsView()),
    );
    expect(destination.readTexturedMesh(5, createTexturedMeshView())).toEqual(
      replacement.source.readTexturedMesh(5, createTexturedMeshView()),
    );

    const empty = createDrawListFragment<object>();
    const beforeEmpty = destination.contentRevision;
    expect(destination.patchFragment(destination.count, empty)).toBe(true);
    expect(destination.contentRevision).toBe(beforeEmpty);
    expect(destination.structuralRevision).toBe(structuralBefore);
  });

  it("refuses a mismatched fragment atomically", () => {
    const source = createDrawList<object>();
    const sourceQuad = sampleQuad();
    setViewColorMatrix(sourceQuad, {
      rows: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    });
    source.pushQuad(sourceQuad, { name: "replacement" });
    const fragment = createDrawListFragment<object>();
    fragment.capture(source, 0, 1);

    const destination = createDrawList<object>();
    const destinationQuad = sampleQuad();
    destination.pushQuad(destinationQuad, { name: "old" });
    const structuralBefore = destination.structuralRevision;
    const contentBefore = destination.contentRevision;
    const floatsBefore = Array.from(destination.floats);
    const intsBefore = Array.from(destination.ints);
    const matricesBefore = Array.from(destination.colorMatrices);
    const textureBefore = destination.textureAt(0);

    // The source has a matrix and the destination does not. Its numeric arena
    // is otherwise the same length, exercising the matrix-shape guard rather
    // than an easy kind/range rejection.
    expect(destination.patchFragment(0, fragment)).toBe(false);
    expect(destination.structuralRevision).toBe(structuralBefore);
    expect(destination.contentRevision).toBe(contentBefore);
    expect(Array.from(destination.floats)).toEqual(floatsBefore);
    expect(Array.from(destination.ints)).toEqual(intsBefore);
    expect(Array.from(destination.colorMatrices)).toEqual(matricesBefore);
    expect(destination.textureAt(0)).toBe(textureBefore);

    const lineSource = createDrawList<object>();
    const longLine = createPolylineView(3);
    longLine.pointCount = 3;
    longLine.points.set([0, 0, 1, 1, 2, 2]);
    lineSource.pushPolyline(longLine);
    const lineFragment = createDrawListFragment<object>();
    lineFragment.capture(lineSource, 0, 1);
    const shortLine = createPolylineView(2);
    shortLine.pointCount = 2;
    shortLine.points.set([0, 0, 1, 1]);
    const lineDestination = createDrawList<object>();
    lineDestination.pushPolyline(shortLine);
    const lineContentBefore = lineDestination.contentRevision;
    expect(lineDestination.patchFragment(0, lineFragment)).toBe(false);
    expect(lineDestination.contentRevision).toBe(lineContentBefore);
    expect(lineDestination.patchFragment(1, lineFragment)).toBe(false);
    expect(lineDestination.patchFragment(0, {} as never)).toBe(false);

    const firstReplacement = createDrawList<object>();
    const firstReplacementQuad = sampleQuad();
    firstReplacementQuad.r = 0.125;
    firstReplacement.pushQuad(firstReplacementQuad, { name: "first-new" });
    const firstFragment = createDrawListFragment<object>();
    firstFragment.capture(firstReplacement, 0, 1);
    const batchDestination = createDrawList<object>();
    const firstDestination = batchDestination.pushQuad(sampleQuad(), {
      name: "first-old",
    });
    batchDestination.pushQuad(sampleQuad(), { name: "second-old" });
    const batchContentBefore = batchDestination.contentRevision;
    const firstTextureBefore = batchDestination.textureAt(firstDestination);
    const firstColorBefore = batchDestination.readQuad(
      firstDestination,
      createQuadView(),
    ).r;

    // The first range is valid, but the later matrix-shape mismatch must keep
    // it from being applied: batches have one all-or-nothing boundary.
    expect(
      batchDestination.patchFragments([
        { start: 0, fragment: firstFragment },
        { start: 1, fragment },
      ]),
    ).toBe(false);
    expect(batchDestination.contentRevision).toBe(batchContentBefore);
    expect(batchDestination.textureAt(firstDestination)).toBe(
      firstTextureBefore,
    );
    expect(
      batchDestination.readQuad(firstDestination, createQuadView()).r,
    ).toBe(firstColorBefore);
    expect(
      batchDestination.patchFragments([
        { start: 1, fragment: firstFragment },
        { start: 0, fragment: firstFragment },
      ]),
    ).toBe(false);
  });

  it("rejects malformed and unbalanced ranges without discarding a prior capture", () => {
    const { source } = mixedFragmentSource();
    const fragment = createDrawListFragment<object>();
    fragment.capture(source, 0, source.count);
    expect(() => fragment.capture(source, -1, 1)).toThrow(/outside count/);
    expect(() => fragment.capture(source, 1, source.count)).toThrow(
      /did not push/,
    );
    expect(() => fragment.capture(source, 0, source.count - 1)).toThrow(
      /leaves 1 clip/,
    );

    // Public arenas make malformed producer data observable; validation must
    // happen before reset so a bad recapture cannot destroy the useful clone.
    source.ints[source.intOffsetAt(1) + 2] = 999;
    expect(() => fragment.capture(source, 0, source.count)).toThrow(
      /color matrix 999/,
    );
    expect(fragment.count).toBe(source.count);
    const destination = createDrawList<object>();
    destination.appendFragment(fragment);
    expect(destination.count).toBe(source.count);
    const beforeInvalidAppend = destination.count;
    expect(() => destination.appendFragment({} as never)).toThrow(
      /created by createDrawListFragment/,
    );
    expect(destination.count).toBe(beforeInvalidAppend);
  });
});
