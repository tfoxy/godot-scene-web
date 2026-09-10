import { describe, expect, it } from "vitest";
import {
  BLEND_ADD,
  compileDrawList,
  createCanvasExecutor,
  createClipRectView,
  createDrawList,
  createDrawListFragment,
  createGlyphsView,
  createNinePatchView,
  createQuadInstance,
  createQuadView,
  createReplayMaskScratch,
  type ExecutorTexture,
} from "../src/index";
import { createFakeGl, fakeProjection } from "./fake-gl";

function quad(x: number, y: number, width = 10, height = 10) {
  const view = createQuadView();
  view.m[4] = x;
  view.m[5] = y;
  view.w = width;
  view.h = height;
  return view;
}

function page(id: number): ExecutorTexture {
  return {
    texture: { id } as unknown as WebGLTexture,
    width: 100,
    height: 100,
  };
}

describe("compiled draw lists", () => {
  it("drops partial cached GPU allocations when a later VAO allocation fails", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    expect(executor.warmUp()).toBe(true);
    const list = createDrawList<ExecutorTexture | null>();
    list.pushQuad(quad(0, 0), page(1));
    const plan = compileDrawList(list);
    (
      fake.gl as unknown as { createVertexArray: () => null }
    ).createVertexArray = () => null;
    fake.reset();
    // The cache declines; the already-warm direct executor remains a safe path.
    expect(
      executor.execute(list, fakeProjection(20, 20), { compiled: plan }),
    ).toBe(true);
    expect(fake.named("deleteBuffer")).toHaveLength(1);
  });

  it("flushes an earlier same-blend direct nine-patch before a cached quad run", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const list = createDrawList<ExecutorTexture | null>();
    const patch = createNinePatchView();
    patch.w = 10;
    patch.h = 10;
    patch.srcW = 10;
    patch.srcH = 10;
    const firstTexture = page(1);
    const secondTexture = page(2);
    list.pushNinePatch(patch, firstTexture);
    list.pushQuad(quad(2, 3), secondTexture);
    const plan = compileDrawList(list);

    expect(
      executor.execute(list, fakeProjection(20, 20), { compiled: plan }),
    ).toBe(true);
    expect(fake.draws).toHaveLength(2);
    expect(fake.draws[0].textures[0]).toBe(firstTexture.texture);
    expect(fake.draws[1].textures[0]).toBe(secondTexture.texture);
    expect(executor.stats.flushes.compiled).toBe(1);
  });

  it("rebuilds texture membership before a resident source's dimension update", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl, maxTextureSlots: 2 });
    const list = createDrawList<ExecutorTexture | null>();
    const a = page(1);
    const b = page(2);
    const first = quad(0, 0);
    first.srcW = 50;
    const firstIndex = list.pushQuad(first, a);
    list.pushQuad(quad(10, 0), b);
    const plan = compileDrawList(list);
    const projection = fakeProjection(20, 20);
    expect(executor.execute(list, projection, { compiled: plan })).toBe(true);

    list.patchQuadSource(firstIndex, b, 0, 0, 50, 10);
    fake.reset();
    expect(executor.execute(list, projection, { compiled: plan })).toBe(true);
    expect(executor.stats.compiledGpuFullUploads).toBe(1);
    (b as { width: number }).width = 200;
    fake.reset();
    expect(executor.execute(list, projection, { compiled: plan })).toBe(true);
    expect(executor.stats.compiledGpuRangeUploads).toBe(2);
    const uploads = fake.named("bufferSubData");
    expect((uploads[0].args[2] as Float32Array)[8]).toBeCloseTo(0);
    expect((uploads[0].args[2] as Float32Array)[10]).toBeCloseTo(0.25);
  });

  it("keeps a refresh delta available to selection and independent executor caches", () => {
    const firstFake = createFakeGl();
    const secondFake = createFakeGl();
    const firstExecutor = createCanvasExecutor({ gl: firstFake.gl });
    const secondExecutor = createCanvasExecutor({ gl: secondFake.gl });
    const list = createDrawList<ExecutorTexture | null>();
    const index = list.pushQuad(quad(0, 0), page(1));
    const plan = compileDrawList(list);
    const projection = fakeProjection(20, 20);
    expect(firstExecutor.execute(list, projection, { compiled: plan })).toBe(
      true,
    );
    expect(secondExecutor.execute(list, projection, { compiled: plan })).toBe(
      true,
    );

    list.patchQuadTransform(index, [1, 0, 0, 1, 7, 8]);
    const scratch = createReplayMaskScratch();
    plan.select({ x: 0, y: 0, width: 20, height: 20 }, scratch);
    firstFake.reset();
    secondFake.reset();
    expect(firstExecutor.execute(list, projection, { compiled: plan })).toBe(
      true,
    );
    expect(secondExecutor.execute(list, projection, { compiled: plan })).toBe(
      true,
    );
    expect(firstExecutor.stats.compiledGpuRangeUploads).toBe(1);
    expect(secondExecutor.stats.compiledGpuRangeUploads).toBe(1);

    list.pushQuad(quad(10, 0), page(2));
    plan.select({ x: 0, y: 0, width: 20, height: 20 }, scratch);
    firstFake.reset();
    expect(firstExecutor.execute(list, projection, { compiled: plan })).toBe(
      true,
    );
    expect(firstExecutor.stats.compiledGpuFullUploads).toBe(1);
  });

  it("updates only a patched quad template range and rebuilds after a shape change", () => {
    const list = createDrawList<ExecutorTexture | null>();
    const first = list.pushQuad(quad(1, 2));
    list.pushQuad(quad(30, 40));
    const plan = compileDrawList(list);
    expect(plan.batches).toEqual([
      { start: 0, end: 2, blend: 0, clipDepth: 0 },
    ]);
    const stableRefresh = plan.refresh();
    expect(plan.refresh()).toBe(stableRefresh);
    const instance = createQuadInstance();
    expect(plan.fillQuad(first, 100, 100, instance)).toBe(true);
    expect([instance.x0, instance.y0]).toEqual([1, 2]);

    list.patchQuadTransform(first, [1, 0, 0, 1, 11, 12]);
    const patchResult = plan.refresh();
    expect(patchResult).toMatchObject({ rebuilt: false, rangeUpdates: 1 });
    expect(plan.fillQuad(first, 100, 100, instance)).toBe(true);
    expect([instance.x0, instance.y0]).toEqual([11, 12]);
    expect(plan.diagnostics.templateRangeUpdates).toBe(1);
    expect(plan.diagnostics.planBuilds).toBe(1);

    list.pushQuad(quad(50, 60));
    expect(plan.refresh()).toMatchObject({ rebuilt: true, rangeUpdates: 0 });
    plan.invalidate();
    expect(plan.refresh().rebuilt).toBe(true);
    expect(plan.diagnostics.structuralInvalidations).toBe(1);
  });

  it("updates retained fragment ranges without rebuilding the compiled plan", () => {
    const list = createDrawList<ExecutorTexture | null>();
    list.pushQuad(quad(0, 0));
    list.pushQuad(quad(10, 0));
    list.pushQuad(quad(20, 0));
    const plan = compileDrawList(list);
    const replacement = createDrawList<ExecutorTexture | null>();
    replacement.pushQuad(quad(110, 10));
    replacement.pushQuad(quad(120, 10));
    const firstFragment = createDrawListFragment<ExecutorTexture | null>();
    firstFragment.capture(replacement, 0, 1);
    const secondFragment = createDrawListFragment<ExecutorTexture | null>();
    secondFragment.capture(replacement, 1, 2);

    expect(
      list.patchFragments([
        { start: 1, fragment: firstFragment },
        { start: 2, fragment: secondFragment },
      ]),
    ).toBe(true);
    expect(plan.refresh()).toMatchObject({ rebuilt: false, rangeUpdates: 2 });
    expect(plan.diagnostics.planBuilds).toBe(1);
    expect(plan.diagnostics.templateRangeUpdates).toBe(2);
    const instance = createQuadInstance();
    expect(plan.fillQuad(1, 100, 100, instance)).toBe(true);
    expect([instance.x0, instance.y0]).toEqual([110, 10]);
    expect(plan.fillQuad(2, 100, 100, instance)).toBe(true);
    expect([instance.x0, instance.y0]).toEqual([120, 10]);
  });

  it("refreshes cached glyph bounds after transform patches while colour/source stay safe", () => {
    const list = createDrawList<ExecutorTexture | null>();
    const glyphs = createGlyphsView(1);
    glyphs.glyphCount = 1;
    glyphs.localInkX = 0;
    glyphs.localInkY = 0;
    glyphs.localInkWidth = 10;
    glyphs.localInkHeight = 4;
    glyphs.localInkOutset = 1;
    const glyphIndex = list.pushGlyphs(glyphs);
    const quadIndex = list.pushQuad(quad(20, 0), page(1));
    const plan = compileDrawList(list);
    const out = { x: 0, y: 0, width: 0, height: 0 };
    expect(plan.commandBounds(glyphIndex, out)).toEqual({
      x: -1,
      y: -1,
      width: 12,
      height: 6,
    });

    list.patchGlyphsColor(glyphIndex, 0.5, 0.5, 0.5, 0.5);
    list.patchGlyphsTransform(glyphIndex, [1, 0, 0, 1, 30, 40]);
    list.patchQuadSource(quadIndex, page(2), 0, 0, 10, 10);
    // Multiple glyph patches coalesce to its one current cached range.
    expect(plan.refresh()).toMatchObject({ rebuilt: false, rangeUpdates: 2 });
    expect(plan.commandBounds(glyphIndex, out)).toEqual({
      x: 29,
      y: 39,
      width: 12,
      height: 6,
    });
  });

  it("reads a bounded patch journal independently for each compiled consumer", () => {
    const list = createDrawList<ExecutorTexture | null>({
      patchJournalCapacity: 2,
    });
    for (let index = 0; index < 32; index += 1) list.pushQuad(quad(index, 0));
    const first = compileDrawList(list);
    const second = compileDrawList(list);
    list.patchQuadColor(17, 0.5, 0.5, 0.5, 0.5);
    expect(first.refresh()).toMatchObject({ rebuilt: false, rangeUpdates: 1 });
    expect(second.refresh()).toMatchObject({ rebuilt: false, rangeUpdates: 1 });

    list.patchQuadColor(0, 1, 1, 1, 1);
    list.patchQuadColor(1, 1, 1, 1, 1);
    list.patchQuadColor(2, 1, 1, 1, 1);
    // `second` lagged past its two-entry journal window and fails closed.
    expect(second.refresh()).toMatchObject({ rebuilt: true, rangeUpdates: 0 });
  });

  it("reuses one clip-aware mask identity, preserves closures, and declines caller thresholds", () => {
    const list = createDrawList();
    const outer = createClipRectView();
    outer.w = 100;
    outer.h = 100;
    const inner = createClipRectView();
    inner.w = 50;
    inner.h = 50;
    list.pushClipRect(outer); // 0
    list.pushQuad(quad(200, 0)); // 1
    list.pushClipRect(inner); // 2
    list.pushQuad(quad(10, 10)); // 3
    list.popClip(); // 4
    list.pushQuad(quad(15, 15)); // 5, overlaps later content
    list.popClip(); // 6
    const plan = compileDrawList(list);
    const scratch = createReplayMaskScratch();
    const first = plan.select({ x: 0, y: 0, width: 30, height: 30 }, scratch);
    const indices = first.indices();
    expect(first).toBe(scratch);
    expect(indices).toEqual([0, 2, 3, 4, 5, 6]);
    expect(
      plan.select({ x: 0, y: 0, width: 30, height: 30 }, scratch).indices(),
    ).toBe(indices);
    expect(
      plan.select({ x: 0, y: 0, width: 30, height: 30 }, scratch, {
        maxCommands: 2,
      }),
    ).toMatchObject({ count: 0, thresholdExceeded: true });
  });

  it("keeps compiled replay command order and GPU instance bytes equal to direct execution", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl, maxTextureSlots: 2 });
    const list = createDrawList<ExecutorTexture | null>();
    const clip = createClipRectView();
    clip.w = 100;
    clip.h = 100;
    const a = quad(1, 2);
    a.srcX = 10;
    a.srcY = 20;
    a.srcW = 30;
    a.srcH = 40;
    const b = quad(4, 5);
    b.blend = BLEND_ADD;
    list.pushQuad(a, page(1));
    list.pushClipRect(clip);
    list.pushQuad(b, page(2));
    list.popClip();
    const projection = fakeProjection(100, 100);

    expect(executor.execute(list, projection)).toBe(true);
    expect(executor.stats.compiledPlanBuilds).toBe(0);
    expect(executor.stats.compiledPlanReuses).toBe(0);
    const directDraws = fake.draws.map((draw) => ({
      instanceCount: draw.instanceCount,
      textures: [...draw.textures],
      scissor: [...draw.scissor],
      blendFunc: [...draw.blendFunc],
      blendEquation: [...draw.blendEquation],
    }));

    fake.reset();
    const plan = compileDrawList(list);
    expect(executor.execute(list, projection, { compiled: plan })).toBe(true);
    expect(fake.draws).toEqual(directDraws);
    expect(fake.named("bufferSubData")).toEqual([]);
    expect(
      fake
        .named("bufferData")
        .filter(
          (call) =>
            call.args[1] instanceof Float32Array &&
            (call.args[1] as Float32Array).length === 18,
        ),
    ).toHaveLength(2);
    expect(executor.stats.compiledGpuFullUploads).toBe(2);
    expect(executor.stats.compiledPlanReuses).toBe(1);
    expect(executor.stats.reusedBatches).toBe(plan.batches.length);

    list.patchQuadTransform(0, [1, 0, 0, 1, 9, 8]);
    fake.reset();
    expect(executor.execute(list, projection, { compiled: plan })).toBe(true);
    expect(executor.stats.compiledGpuFullUploads).toBe(0);
    expect(executor.stats.compiledGpuRangeUploads).toBe(1);
    expect(fake.named("bufferSubData")).toHaveLength(1);
    expect(fake.named("bufferSubData")[0].args[1]).toBe(0);

    fake.reset();
    expect(
      executor.execute(list, projection, {
        compiled: plan,
        commandMask: {
          count: 1,
          includes: (index) => index === 0,
          indices: () => [0],
        },
      }),
    ).toBe(true);
    expect(fake.named("bufferData")).toEqual([]);
    expect(fake.named("bufferSubData")).toEqual([]);
    expect(fake.draws).toHaveLength(1);
    expect(fake.draws[0].instanceCount).toBe(1);

    executor.releaseCompiled(plan);
    fake.reset();
    expect(executor.execute(list, projection, { compiled: plan })).toBe(true);
    expect(executor.stats.compiledGpuFullUploads).toBe(2);

    executor.invalidate();
    fake.reset();
    expect(executor.execute(list, projection, { compiled: plan })).toBe(true);
    expect(executor.stats.compiledGpuFullUploads).toBe(2);
  });
});
