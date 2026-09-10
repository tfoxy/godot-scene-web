// What the executor does around a glyph run — the only point in a frame where it hands its
// context to somebody else and takes it back.
//
// None of this is about what a glyph LOOKS like. It is about the three things that go wrong when a
// pass is spliced into a batching renderer, every one of which produces a picture rather than an
// error:
//
//   1. ORDER. A flush DRAWS with whatever GL state is live, so the pending quads have to go out
//      BEFORE the pass replaces the program. Flushed after, this frame's quads are rasterised
//      through a glyph shader — a blank rectangle, not something that reads as an ordering bug.
//   2. RESTORE. hb-gpu's `end` leaves the VAO UNBOUND and the program its own, and sets the
//      non-separate `blendFunc`. Any one of those left alone makes the NEXT quad wrong: no
//      attributes, the wrong shader, or a silently inherited blend.
//   3. THE MISSING PASS. A list carrying text into an executor with no pass installed is a wiring
//      mistake whose only symptom is a page that renders perfectly except for having no words on
//      it. It has to be counted.
//
// The stand-in pass below issues a real `drawArraysInstanced` and leaves exactly the dirt hb-gpu
// documents itself leaving, which is what makes `fake-gl`'s draw log able to answer all three.

import { describe, expect, it } from "vitest";
import {
  BLEND_MIX,
  createClipRectView,
  createDrawList,
  createGlyphsView,
  createQuadView,
  type DrawCommandKind,
  type DrawList,
} from "../src/draw-list";
import {
  createCanvasExecutor,
  type ExecutorTexture,
} from "../src/executor-webgl";
import type { GlyphPass } from "../src/glyph-pass";
import { createFakeGl, type FakeGl, fakeProjection } from "./fake-gl";

function page(id: number, width = 256, height = 256): ExecutorTexture {
  return { texture: { id } as unknown as WebGLTexture, width, height };
}

/**
 * A pass that draws and dirties the context exactly the way `HbGpuRenderer.end` documents.
 *
 * `blendFunc(ONE, ONE)` — ADDITIVE — rather than hb-gpu's real premultiplied MIX, and that
 * substitution is the point: MIX's factors are byte-identical to the ones the executor sets for
 * `BLEND_MIX`, so a pass that left them behind would be indistinguishable from an executor that
 * restored them. An additive leftover is not.
 */
function fakePass(glyphsPerRun = 3): GlyphPass & {
  runs: { pixelsPerEm: number; glyphCount: number; framebuffer: number }[];
  program: object;
  vao: object;
} {
  const program = { __gl: "pass-program" };
  const vao = { __gl: "pass-vao" };
  const recordedRuns: {
    pixelsPerEm: number;
    glyphCount: number;
    framebuffer: number;
  }[] = [];
  let gl: WebGL2RenderingContext | null = null;
  return {
    runs: recordedRuns,
    program,
    vao,
    /** The executor never hands the pass a context; it takes the one it drew into. */
    attach(context: WebGL2RenderingContext) {
      gl = context;
    },
    drawRun(run, projection) {
      if (!gl) throw new Error("fakePass: attach() first");
      recordedRuns.push({
        pixelsPerEm: run.pixelsPerEm,
        glyphCount: run.glyphCount,
        framebuffer: projection.framebufferWidth,
      });
      gl.useProgram(program as unknown as WebGLProgram);
      gl.bindVertexArray(vao as unknown as WebGLVertexArrayObject);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glyphsPerRun);
      // UNBOUND, not restored — WebGL2 has no cheap read-back of the binding, so this is what a
      // real pass leaves and what the executor has to cope with.
      gl.bindVertexArray(null);
      return { glyphs: glyphsPerRun, drawCalls: 1 };
    },
    drawRuns(batchRuns, projection) {
      if (!gl) throw new Error("fakePass: attach() first");
      for (const run of batchRuns) {
        recordedRuns.push({
          pixelsPerEm: run.pixelsPerEm,
          glyphCount: run.glyphCount,
          framebuffer: projection.framebufferWidth,
        });
      }
      gl.useProgram(program as unknown as WebGLProgram);
      gl.bindVertexArray(vao as unknown as WebGLVertexArrayObject);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glyphsPerRun * batchRuns.length);
      gl.bindVertexArray(null);
      return { glyphs: glyphsPerRun * batchRuns.length, drawCalls: 1 };
    },
  } as GlyphPass & {
    runs: { pixelsPerEm: number; glyphCount: number; framebuffer: number }[];
    program: object;
    vao: object;
    attach(context: WebGL2RenderingContext): void;
  };
}

function setup(options: { noPass?: boolean; glyphsPerRun?: number; batch?: boolean } = {}) {
  const fake: FakeGl = createFakeGl();
  const pass = options.noPass ? null : fakePass(options.glyphsPerRun);
  if (pass) (pass as unknown as { attach(gl: unknown): void }).attach(fake.gl);
  const executor = createCanvasExecutor({
    gl: fake.gl,
    glyphs: pass ?? undefined,
    batchAdjacentGlyphRuns: options.batch,
  });
  const list = createDrawList<ExecutorTexture | null>();
  return {
    fake,
    executor,
    list,
    pass,
    projection: fakeProjection(1920, 1080),
  };
}

/** A quad the batcher will happily merge with its neighbours. */
function pushQuad(list: DrawList<ExecutorTexture | null>, texture = page(1)) {
  const quad = createQuadView();
  quad.w = 8;
  quad.h = 8;
  quad.blend = BLEND_MIX;
  list.pushQuad(quad, texture);
}

/** A run of `count` glyphs at `pixelsPerEm`, with ids the pass never reads. */
function pushGlyphs(
  list: DrawList<ExecutorTexture | null>,
  count = 3,
  pixelsPerEm = 32,
) {
  const run = createGlyphsView(count);
  run.glyphCount = count;
  run.pixelsPerEm = pixelsPerEm;
  for (let i = 0; i < count; i += 1) {
    run.slots[i] = i;
    run.positions[i * 2] = i * 10;
    run.positions[i * 2 + 1] = 100;
  }
  list.pushGlyphs(run);
}

describe("the glyph pass inside a frame", () => {
  it("batches only physically adjacent glyph commands when explicitly enabled", () => {
    const { fake, executor, list, projection, pass } = setup({ batch: true, glyphsPerRun: 2 });
    pushGlyphs(list, 2);
    pushGlyphs(list, 3);
    executor.execute(list, projection);
    expect(fake.draws.map((draw) => draw.instanceCount)).toEqual([4]);
    expect(executor.stats.glyphRuns).toBe(2);
    expect(executor.stats.glyphDrawCalls).toBe(1);
    expect(pass?.runs).toHaveLength(2);
  });

  it("does not cross a clip boundary or a non-glyph command", () => {
    const { fake, executor, list, projection } = setup({ batch: true });
    pushGlyphs(list);
    const clip = createClipRectView();
    clip.w = 100;
    clip.h = 100;
    list.pushClipRect(clip);
    pushGlyphs(list);
    list.popClip();
    pushGlyphs(list);
    pushQuad(list);
    pushGlyphs(list);
    executor.execute(list, projection);
    // Four independent glyph submissions: neither clip push/pop nor quad is batchable.
    expect(fake.draws.map((draw) => draw.instanceCount)).toEqual([3, 3, 3, 1, 3]);
    expect(executor.stats.glyphDrawCalls).toBe(4);
  });

  it("does not join glyph commands across a retained replay mask gap", () => {
    const { fake, executor, list, projection } = setup({ batch: true });
    pushGlyphs(list);
    pushGlyphs(list);
    pushGlyphs(list);
    const selected = new Set([0, 2]);
    executor.execute(list, projection, {
      commandMask: {
        count: 2,
        includes: (index) => selected.has(index),
        indices: () => [0, 2],
      },
    });
    expect(fake.draws.map((draw) => draw.instanceCount)).toEqual([3, 3]);
    expect(executor.stats.glyphRuns).toBe(2);
    expect(executor.stats.glyphDrawCalls).toBe(2);
  });

  it("falls back to ordered individual draws when glyph residency declines a batch", () => {
    const { fake, executor, list, projection, pass } = setup({ batch: true });
    pass!.canBatchRuns = () => false;
    pushGlyphs(list);
    pushGlyphs(list);
    executor.execute(list, projection);
    expect(fake.draws.map((draw) => draw.instanceCount)).toEqual([3, 3]);
    expect(executor.stats.glyphRunBatches).toBe(0);
    expect(executor.stats.glyphRunBatchFallbacks).toBe(1);
    expect(executor.stats.glyphDrawCalls).toBe(2);
  });

  it("draws quad, glyphs, quad in that order, one draw each", () => {
    // THE TEST THAT MATTERS MOST. Two quads that would otherwise merge into one batch are split by
    // the run, and the run's draw lands BETWEEN them — which is only true if the batcher was
    // flushed before the pass rather than after it.
    const { fake, executor, list, projection } = setup({ glyphsPerRun: 5 });
    pushQuad(list);
    pushGlyphs(list, 5);
    pushQuad(list);
    executor.execute(list, projection);

    expect(fake.draws.map((draw) => draw.instanceCount)).toEqual([1, 5, 1]);
    expect(executor.stats.batches).toBe(2);
    expect(executor.stats.glyphRuns).toBe(1);
    expect(executor.stats.glyphs).toBe(5);
    expect(executor.stats.glyphDrawCalls).toBe(1);
    // The break is attributed to the run, not folded into `end`.
    expect(executor.stats.flushes.glyphs).toBe(1);
    expect(executor.stats.flushes.end).toBe(1);
  });

  it("re-binds its own program and VAO after the pass", () => {
    const { fake, executor, list, projection, pass } = setup();
    pushQuad(list);
    pushGlyphs(list);
    pushQuad(list);
    executor.execute(list, projection);

    const vaoBinds = fake.named("bindVertexArray").map((call) => call.args[0]);
    const passVaoAt = vaoBinds.indexOf(pass?.vao);
    expect(passVaoAt).toBeGreaterThanOrEqual(0);
    // Immediately after the pass leaves it `null`, the executor's own VAO is bound again. Without
    // this the last quad reads its attributes from nothing and draws nothing at all.
    expect(vaoBinds[passVaoAt + 1]).toBeNull();
    expect(vaoBinds[passVaoAt + 2]).toBeTruthy();
    expect(vaoBinds[passVaoAt + 2]).not.toBe(pass?.vao);

    const programs = fake.named("useProgram").map((call) => call.args[0]);
    const passProgramAt = programs.indexOf(pass?.program);
    expect(passProgramAt).toBeGreaterThanOrEqual(0);
    expect(programs[passProgramAt + 1]).toBe(programs[0]);
  });

  it("re-applies its own blend, instead of inheriting the pass's", () => {
    // hb-gpu sets the NON-separate `blendFunc`/`blendEquation`, which write both halves. The
    // executor's cached `appliedBlend` has to be invalidated or the next quad silently keeps it —
    // no error, just a picture composited the wrong way.
    const { fake, executor, list, projection } = setup();
    pushQuad(list);
    pushGlyphs(list);
    pushQuad(list);
    executor.execute(list, projection);

    const gl = fake.gl as unknown as Record<string, number>;
    expect(fake.draws[1].blendFunc).toEqual([gl.ONE, gl.ONE, gl.ONE, gl.ONE]);
    expect(fake.draws[2].blendFunc).toEqual([
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    ]);
    // Twice: once at the top of the frame, once after the pass.
    expect(executor.stats.blendChanges).toBe(2);
  });

  it("keeps a clip rect clipping the glyphs inside it", () => {
    // `SCISSOR_TEST` is enabled for the whole frame and the pass is forbidden to touch it, so a
    // clipped run needs no cooperation from the pass at all — which is worth pinning, because the
    // alternative design (a pass that sets its own scissor) is the one people reach for.
    const { fake, executor, list, projection } = setup();
    const clip = createClipRectView();
    clip.x = 0;
    clip.y = 0;
    clip.w = 960;
    clip.h = 540;
    list.pushClipRect(clip);
    pushGlyphs(list);
    list.popClip();
    pushQuad(list);
    executor.execute(list, projection);

    // Design y 0..540 is the TOP half, so the scissor origin is at 1080 - 540.
    expect(fake.draws[0].scissor).toEqual([0, 540, 960, 540]);
    expect(fake.draws[1].scissor).toEqual([0, 0, 1920, 1080]);
  });

  it("hands the pass the frame's own projection", () => {
    const { executor, list, pass } = setup();
    pushGlyphs(list, 4, 21);
    executor.execute(list, fakeProjection(1920, 1080, 3840, 2160));
    expect(pass?.runs).toEqual([
      { pixelsPerEm: 21, glyphCount: 4, framebuffer: 3840 },
    ]);
  });

  it("resets the glyph counters every frame", () => {
    const { executor, list, projection } = setup();
    pushGlyphs(list);
    executor.execute(list, projection);
    expect(executor.stats.glyphRuns).toBe(1);
    executor.execute(createDrawList<ExecutorTexture | null>(), projection);
    expect(executor.stats.glyphRuns).toBe(0);
    expect(executor.stats.glyphs).toBe(0);
    expect(executor.stats.glyphRunBatches).toBe(0);
    expect(executor.stats.glyphRunBatchFallbacks).toBe(0);
    expect(executor.stats.flushes.glyphs).toBe(0);
  });

  it("resets adjacent-batch diagnostics on the next execution", () => {
    const { executor, list, projection, pass } = setup({ batch: true });
    pushGlyphs(list);
    pushGlyphs(list);
    executor.execute(list, projection);
    expect(executor.stats.glyphRunBatches).toBe(1);
    pass!.canBatchRuns = () => false;
    executor.execute(list, projection);
    expect(executor.stats.glyphRunBatches).toBe(0);
    expect(executor.stats.glyphRunBatchFallbacks).toBe(1);
    executor.execute(createDrawList<ExecutorTexture | null>(), projection);
    expect(executor.stats.glyphRunBatches).toBe(0);
    expect(executor.stats.glyphRunBatchFallbacks).toBe(0);
  });
});

describe("a glyph run with no pass installed", () => {
  it("is counted, not silently dropped", () => {
    // GENUINELY ABSENT, not a no-op stand-in: the wiring mistake this counter exists for is a
    // consumer that never passed `glyphs` at all.
    const { fake, executor, list, projection } = setup({ noPass: true });
    pushQuad(list);
    pushGlyphs(list);
    pushQuad(list);
    executor.execute(list, projection);

    expect(executor.stats.commands).toBe(3);
    expect(executor.stats.glyphRunsDropped).toBe(1);
    expect(executor.stats.glyphRuns).toBe(0);
    // And it does NOT break the batch: with nothing drawn and no GL state moved, flushing here
    // would cost a draw call to accomplish nothing.
    expect(fake.draws).toHaveLength(1);
    expect(fake.draws[0].instanceCount).toBe(2);
    expect(executor.stats.flushes.glyphs).toBe(0);
  });
});

describe("the dispatch switch's default", () => {
  it("counts a command kind it does not handle", () => {
    // The switch had no `default`, so a kind added to the IR and not to the executor fell straight
    // through — a frame missing everything of that kind while reporting as a frame that drew it
    // all. Spoofed rather than pushed, because `createDrawList` cannot record an unknown kind.
    const { executor, list, projection } = setup();
    pushQuad(list);
    const spoofed = Object.create(list) as DrawList<ExecutorTexture | null>;
    (spoofed as { kindAt(index: number): DrawCommandKind }).kindAt = () =>
      99 as DrawCommandKind;
    executor.execute(spoofed, projection);
    expect(executor.stats.commands).toBe(1);
    expect(executor.stats.unknownCommands).toBe(1);
    expect(executor.stats.quads).toBe(0);
  });
});
