import { describe, expect, it } from "vitest";
import { compileDrawList } from "../src/compiled-draw-list";
import { createDrawList, createQuadView } from "../src/draw-list";
import {
  createCanvasExecutor,
  type ExecutorTexture,
} from "../src/executor-webgl";
import {
  createRetainedRangeCache,
  RETAINED_RANGE_DEFAULTS,
  type RetainedRangeCandidate,
  type RetainedRangeSubstitutionPlan,
  retainedRangePlanState,
} from "../src/retained-range-cache";
import { type CanvasTextureSource, createTextureCache } from "../src/textures";
import { createFakeGl, fakeProjection } from "./fake-gl";

function page(id: number): ExecutorTexture {
  return {
    texture: { id } as unknown as WebGLTexture,
    width: 64,
    height: 64,
    revision: id,
  };
}

function bitmap(width: number, height: number): CanvasTextureSource {
  return { width, height } as unknown as CanvasTextureSource;
}

function appendQuads(
  list: ReturnType<typeof createDrawList<ExecutorTexture | null>>,
  count: number,
  texture: ExecutorTexture = page(1),
  offsetX = 0,
): void {
  for (let index = 0; index < count; index += 1) {
    const quad = createQuadView();
    quad.m[4] = offsetX + index;
    quad.m[5] = 2;
    quad.w = 4;
    quad.h = 4;
    quad.srcW = 4;
    quad.srcH = 4;
    list.pushQuad(quad, texture);
  }
}

function candidate(
  key: string,
  start: number,
  end: number,
  x = 0,
  pixelRevision = 1,
): RetainedRangeCandidate {
  return {
    key,
    start,
    end,
    bounds: { x, y: 1, width: 16, height: 6 },
    pixelRevision,
  };
}

describe("retained range cache", () => {
  it("pins the bounded production defaults", () => {
    expect(RETAINED_RANGE_DEFAULTS).toEqual({
      maxEntries: 8,
      maxDimension: 1024,
      maxEntryStageAreaRatio: 0.2,
      maxCompositeStageAreaRatio: 0.5,
      maxResidentBytes: 12 * 1024 * 1024,
      maxPeakBytes: 16 * 1024 * 1024,
      gutterPixels: 1,
      maxUnseenFrames: 120,
    });
  });

  it("creates cold pixels once, then substitutes the warm range in painter order", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 10);
    const projection = fakeProjection(100, 100);
    const selected = candidate("middle", 1, 9);

    const cold = cache.prepare(list, projection, [selected]);
    expect(executor.execute(list, projection, { substitutions: cold })).toBe(
      true,
    );
    expect(executor.stats).toMatchObject({
      logicalCommands: 10,
      liveCommands: 10,
      substitutedCommands: 8,
      retainedComposites: 1,
      retainedRasterizations: 1,
    });
    expect(cache.stats).toMatchObject({
      allocations: 1,
      rebuilds: 1,
      composites: 1,
      realHits: 0,
      entries: 1,
      backings: 1,
    });

    fake.reset();
    const warm = cache.prepare(list, projection, [selected]);
    expect(executor.execute(list, projection, { substitutions: warm })).toBe(
      true,
    );
    expect(executor.stats).toMatchObject({
      logicalCommands: 10,
      liveCommands: 2,
      substitutedCommands: 8,
      retainedComposites: 1,
      retainedRasterizations: 0,
    });
    expect(cache.stats).toMatchObject({
      allocations: 1,
      rebuilds: 1,
      composites: 2,
      realHits: 1,
    });
    // Two live commands and one inline composite are one ordered instance stream,
    // never a later overlay pass.
    expect(fake.draws.reduce((sum, draw) => sum + draw.instanceCount, 0)).toBe(
      3,
    );
  });

  it("stops a compiled source-over run at an inline substitution boundary", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 16);
    const compiled = compileDrawList(list);
    const refresh = compiled.refresh();
    const projection = fakeProjection(100, 100);
    const substitutions = cache.prepare(
      list,
      projection,
      [candidate("middle", 4, 12)],
      refresh,
    );

    expect(
      executor.execute(list, projection, {
        compiled,
        compiledRefresh: refresh,
        substitutions,
      }),
    ).toBe(true);
    expect(executor.stats).toMatchObject({
      logicalCommands: 16,
      liveCommands: 16,
      substitutedCommands: 8,
      retainedComposites: 1,
      retainedRasterizations: 1,
    });
    expect(cache.stats).toMatchObject({ composites: 1, rebuilds: 1 });
  });

  it("uses a compiled revision for cache validity without enabling GPU command reuse", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 16);
    const refresh = compileDrawList(list).refresh();
    const projection = fakeProjection(100, 100);
    const substitutions = cache.prepare(
      list,
      projection,
      [candidate("middle", 4, 12)],
      refresh,
    );

    expect(
      executor.execute(list, projection, {
        compiledRefresh: refresh,
        substitutions,
      }),
    ).toBe(true);
    expect(executor.stats.retainedComposites).toBe(1);
    expect(executor.stats.compiledCachedDrawCalls).toBe(0);
  });

  it("accepts balanced nested internal clips and rejects an enclosing external clip", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const projection = fakeProjection(100, 100);
    const nested = createDrawList<ExecutorTexture | null>();
    const clip = { ...createQuadView(), radius: 0 };
    nested.pushClipRect(clip);
    nested.pushClipRect(clip);
    appendQuads(nested, 2);
    nested.popClip();
    nested.popClip();
    const plan = cache.prepare(nested, projection, [candidate("nested", 0, 6)]);
    expect(executor.execute(nested, projection, { substitutions: plan })).toBe(
      true,
    );
    expect(executor.stats.substitutedCommands).toBe(6);

    const external = createDrawList<ExecutorTexture | null>();
    external.pushClipRect(clip);
    appendQuads(external, 2);
    external.popClip();
    const rejected = cache.prepare(external, projection, [
      candidate("external", 1, 3),
    ]);
    executor.execute(external, projection, { substitutions: rejected });
    expect(executor.stats.substitutedCommands).toBe(0);
    expect(cache.stats.fallbackReasons["invalid-candidate"]).toBe(1);
  });

  it("uses an origin-adjusted FBO projection and flips its texture exactly once", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 8, page(2), 10);
    const projection = fakeProjection(100, 100, 200, 200);
    const plan = cache.prepare(list, projection, [
      {
        ...candidate("offset", 0, 8, 10),
        bounds: { x: 10, y: 20, width: 16, height: 8 },
      },
    ]);
    expect(executor.execute(list, projection, { substitutions: plan })).toBe(
      true,
    );

    const projections = fake
      .named("uniform4f")
      .map((call) => call.args.slice(1) as number[]);
    const rasterProjection = projections.find(
      (args) =>
        Math.abs(args[0] - 4 / 34) < 1e-6 && Math.abs(args[1] - -4 / 18) < 1e-6,
    );
    expect(rasterProjection).toBeDefined();
    const uploads = fake.named("bufferSubData");
    const composite = uploads.at(-1)?.args[2] as Float32Array;
    // u0, v0, uSpan, vSpan: one negative V span is the FBO correction.
    expect([...composite.subarray(8, 12)]).toEqual([0, 1, 1, -1]);
  });

  it("invalidates only changed content and source texture revisions", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const textures = createTextureCache(fake.gl);
    const firstTexture = textures.acquire("first", bitmap(32, 32));
    const secondTexture = textures.acquire("second", bitmap(32, 32));
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 4, firstTexture, 0);
    appendQuads(list, 4, secondTexture, 40);
    const projection = fakeProjection(100, 100);
    const first = candidate("first", 0, 4, 0);
    const second = candidate("second", 4, 8, 40);

    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [first, second]),
    });
    expect(cache.stats.rebuilds).toBe(2);

    textures.update("first", bitmap(32, 32));
    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [first, second]),
    });
    expect(executor.stats.retainedRasterizations).toBe(1);
    expect(cache.stats.rebuildReasons.resource).toBe(1);

    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [
        { ...first, pixelRevision: 2 },
        second,
      ]),
    });
    expect(executor.stats.retainedRasterizations).toBe(1);
    expect(cache.stats.rebuildReasons.content).toBe(1);
  });

  it("reuses an unchanged backing at a translated device-pixel placement", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 8);
    const projection = fakeProjection(100, 100);
    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [
        candidate("moving", 0, 8),
      ]),
    });
    const translated = cache.prepare(list, projection, [
      candidate("moving", 0, 8, 5),
    ]);
    executor.execute(list, projection, { substitutions: translated });
    expect(executor.stats.retainedRasterizations).toBe(0);
    expect(cache.stats.realHits).toBe(1);
  });

  it("falls the whole frame back live on allocation failure or a malformed plan", () => {
    const failed = createFakeGl({ failCreate: ["texture"] });
    const executor = createCanvasExecutor({ gl: failed.gl });
    const cache = createRetainedRangeCache(failed.gl);
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 8, page(4));
    const projection = fakeProjection(100, 100);
    const unavailable = cache.prepare(list, projection, [candidate("a", 0, 8)]);
    expect(
      executor.execute(list, projection, { substitutions: unavailable }),
    ).toBe(true);
    expect(executor.stats).toMatchObject({
      liveCommands: 8,
      substitutedCommands: 0,
      retainedFallbacks: 1,
    });

    const malformed = {} as RetainedRangeSubstitutionPlan;
    expect(
      executor.execute(list, projection, { substitutions: malformed }),
    ).toBe(true);
    expect(executor.stats).toMatchObject({
      liveCommands: 8,
      substitutedCommands: 0,
      retainedFallbacks: 1,
    });
  });

  it("falls an outstanding plan live after its backing is evicted or replaced", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl, { maxEntries: 1 });
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 16);
    const projection = fakeProjection(100, 100);
    const first = candidate("first", 0, 8);
    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [first]),
    });

    const evicted = cache.prepare(list, projection, [first]);
    cache.prepare(list, projection, [candidate("second", 8, 16, 30)]);
    executor.execute(list, projection, { substitutions: evicted });
    expect(executor.stats).toMatchObject({
      liveCommands: 16,
      substitutedCommands: 0,
      retainedFallbacks: 1,
    });

    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [first]),
    });
    const replaced = cache.prepare(list, projection, [first]);
    cache.prepare(list, projection, [
      { ...first, bounds: { x: 0, y: 1, width: 20, height: 6 } },
    ]);
    executor.execute(list, projection, { substitutions: replaced });
    expect(executor.stats).toMatchObject({
      liveCommands: 16,
      substitutedCommands: 0,
      retainedFallbacks: 1,
    });
  });

  it("falls an outstanding warm plan live after explicit invalidation", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 8);
    const projection = fakeProjection(100, 100);
    const selected = candidate("stale", 0, 8);
    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [selected]),
    });
    const outstanding = cache.prepare(list, projection, [selected]);

    cache.invalidate("stale", "test");
    executor.execute(list, projection, { substitutions: outstanding });
    expect(executor.stats).toMatchObject({
      liveCommands: 8,
      substitutedCommands: 0,
      retainedFallbacks: 1,
    });
  });

  it("rejects a plan prepared by a different WebGL context", () => {
    const owner = createFakeGl();
    const foreign = createFakeGl();
    const cache = createRetainedRangeCache(owner.gl);
    const executor = createCanvasExecutor({ gl: foreign.gl });
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 8);
    const projection = fakeProjection(100, 100);
    const plan = cache.prepare(list, projection, [candidate("foreign", 0, 8)]);

    executor.execute(list, projection, { substitutions: plan });
    expect(executor.stats).toMatchObject({
      liveCommands: 8,
      substitutedCommands: 0,
      retainedFallbacks: 1,
    });
  });

  it("preserves a separately bound read framebuffer during allocation and raster", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 8);
    const projection = fakeProjection(100, 100);
    const readFramebuffer = fake.gl.createFramebuffer();
    fake.gl.bindFramebuffer(fake.gl.READ_FRAMEBUFFER, readFramebuffer);

    const plan = cache.prepare(list, projection, [candidate("read", 0, 8)]);
    expect(fake.gl.getParameter(fake.gl.READ_FRAMEBUFFER_BINDING)).toBe(
      readFramebuffer,
    );
    executor.execute(list, projection, { substitutions: plan });
    expect(fake.gl.getParameter(fake.gl.READ_FRAMEBUFFER_BINDING)).toBe(
      readFramebuffer,
    );
  });

  it("revalidates opaque plan ordering before touching any retained pixels", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 16);
    const projection = fakeProjection(100, 100);
    const plan = cache.prepare(list, projection, [
      candidate("a", 0, 8),
      candidate("b", 8, 16, 20),
    ]);
    const state = retainedRangePlanState(plan);
    expect(state).not.toBeNull();
    (state?.entries as unknown as unknown[]).reverse();
    executor.execute(list, projection, { substitutions: plan });
    expect(executor.stats).toMatchObject({
      liveCommands: 16,
      substitutedCommands: 0,
      retainedRasterizations: 0,
      retainedFallbacks: 1,
    });
  });

  it("enforces entry/area/byte budgets and evicts by successful-composite LRU", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl, {
      maxEntries: 1,
      maxResidentBytes: 4096,
      maxPeakBytes: 8192,
    });
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 16);
    const projection = fakeProjection(100, 100);
    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [candidate("a", 0, 8)]),
    });
    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [
        candidate("b", 8, 16, 20),
      ]),
    });
    expect(cache.stats).toMatchObject({
      entries: 1,
      evictions: 1,
      allocations: 2,
    });

    const bounded = cache.prepare(list, projection, [
      candidate("b", 8, 16, 20),
      candidate("c", 0, 8),
    ]);
    executor.execute(list, projection, { substitutions: bounded });
    expect(executor.stats).toMatchObject({
      substitutedCommands: 8,
      retainedFallbacks: 0,
    });
    expect(cache.stats.fallbackReasons["cold-budget"]).toBe(1);

    const rejected = cache.prepare(list, projection, [
      {
        ...candidate("too-large", 0, 8),
        bounds: { x: 0, y: 0, width: 60, height: 60 },
      },
    ]);
    executor.execute(list, projection, { substitutions: rejected });
    expect(executor.stats.substitutedCommands).toBe(0);
    expect(cache.stats.fallbackReasons["entry-size-budget"]).toBe(1);
  });

  it("drops dead-context handles without deletes, rebuilds, and live-disposes", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 8);
    const projection = fakeProjection(100, 100);
    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [candidate("a", 0, 8)]),
    });
    fake.reset();
    cache.invalidateContext();
    executor.invalidate();
    expect(fake.named("deleteFramebuffer")).toHaveLength(0);
    expect(fake.named("deleteTexture")).toHaveLength(0);

    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [candidate("a", 0, 8)]),
    });
    expect(cache.stats.contextRebuilds).toBe(1);
    fake.reset();
    cache.dispose();
    expect(fake.named("deleteFramebuffer")).toHaveLength(1);
    expect(fake.named("deleteTexture")).toHaveLength(1);
    expect(cache.stats).toMatchObject({ entries: 0, backings: 0, bytes: 0 });
  });

  it("clears live backings, rejects stale plans, and rebuilds in the same cache", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl);
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 8);
    const projection = fakeProjection(100, 100);
    const selected = candidate("resized", 0, 8);
    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [selected]),
    });
    const stale = cache.prepare(list, projection, [selected]);

    fake.reset();
    cache.clear("resize");
    expect(fake.named("deleteFramebuffer")).toHaveLength(1);
    expect(fake.named("deleteTexture")).toHaveLength(1);
    expect(cache.stats).toMatchObject({
      entries: 0,
      backings: 0,
      bytes: 0,
      deletes: 1,
    });

    executor.execute(list, projection, { substitutions: stale });
    expect(executor.stats).toMatchObject({
      liveCommands: 8,
      substitutedCommands: 0,
      retainedFallbacks: 1,
    });
    expect(cache.stats.fallbackReasons["invalid-plan"]).toBe(1);

    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [selected]),
    });
    expect(executor.stats).toMatchObject({
      substitutedCommands: 8,
      retainedRasterizations: 1,
    });
    expect(cache.stats).toMatchObject({
      allocations: 2,
      rebuilds: 2,
      entries: 1,
      backings: 1,
    });
    expect(cache.stats.rebuildReasons.resize).toBe(1);
  });

  it("expires entries only after the configured number of presented unseen frames", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const cache = createRetainedRangeCache(fake.gl, { maxUnseenFrames: 1 });
    const list = createDrawList<ExecutorTexture | null>();
    appendQuads(list, 16);
    const projection = fakeProjection(100, 100);
    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [candidate("a", 0, 8)]),
    });
    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [
        candidate("b", 8, 16, 20),
      ]),
    });
    expect(cache.stats.entries).toBe(2);
    executor.execute(list, projection, {
      substitutions: cache.prepare(list, projection, [
        candidate("b", 8, 16, 20),
      ]),
    });
    expect(cache.stats).toMatchObject({ entries: 1, evictions: 1 });
  });
});
