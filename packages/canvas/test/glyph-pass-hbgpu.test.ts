// The hb-gpu-backed glyph pass, without a GPU and without the wasm.
//
// NO WASM ON PURPOSE. `packages/hb-gpu/vendor/hb-gpu.mjs` is emscripten glue compiled
// `-sENVIRONMENT=web,worker`; importing it from node ABORTS. Everything this file tests is the
// adapter's own arithmetic and bookkeeping, so the module and the font are stand-ins — the same
// shape `packages/hb-gpu/test/renderer.test.ts` uses, for the same reason.
//
// THE PROPERTY THIS FILE EXISTS FOR is the one the draw list's slot ids were introduced to buy: a
// retained list outlives the atlas's evictions, and a pass that cached `GlyphSlot`s instead of
// re-resolving them would draw a DIFFERENT glyph's outline at the right size, in the right place,
// perfectly antialiased. Nothing downstream — no ink metric, no screenshot review — can tell that
// from correct text, so it is asserted here.

import type {
  EncodedGlyph,
  HbGpu,
  HbGpuFailure,
  HbGpuFont,
} from "@godot-scene-web/hb-gpu";
import {
  HB_GPU_CONTRAST_NONE,
  type HbGpuContrast,
} from "@godot-scene-web/hb-gpu/webgl";
import { describe, expect, it, vi } from "vitest";
import { createGlyphsView } from "../src/draw-list";
import {
  createHbGpuGlyphPass,
  GLYPH_SLOT_NONE,
  type GlyphFace,
  type HbGpuGlyphPass,
  PPEM_FIDELITY_FLOOR,
} from "../src/glyph-pass-hbgpu";
import { createFakeGl, type FakeGl, fakeProjection } from "./fake-gl";

/** Deterministic blobs: every glyph encodes to `texels` texels, except the ones in `inkless`. */
function fakeFont(
  options: {
    texels?: number;
    inkless?: readonly number[];
    /** Glyph id -> `[xOffset, yOffset]` in font units, y-UP, as HarfBuzz reports them. */
    offsets?: Record<number, readonly [number, number]>;
    shapeFails?: boolean;
  } = {},
): HbGpuFont & { encodeCalls: number[]; shapeCalls: number } {
  const texels = options.texels ?? 100;
  const inkless = new Set(options.inkless ?? []);
  const font = {
    upem: 1000,
    encodeCalls: [] as number[],
    shapeCalls: 0,
    glyphFor: (codepoint: number) => codepoint,
    // One glyph per code unit, glyph id === code point, a constant 600-unit advance, and a
    // y-UP offset on any glyph the test asks for. Enough to grade `fillRun`'s pen arithmetic,
    // which is the only thing in this file that touches a shaper.
    shape(text: string) {
      font.shapeCalls += 1;
      if (options.shapeFails) return null;
      return [...text].map((character) => {
        const glyphId = character.codePointAt(0) ?? 0;
        const offset = options.offsets?.[glyphId];
        return {
          glyphId,
          cluster: 0,
          xAdvance: 600,
          yAdvance: 0,
          xOffset: offset?.[0] ?? 0,
          yOffset: offset?.[1] ?? 0,
        };
      });
    },
    encode(id: number): EncodedGlyph | null {
      font.encodeCalls.push(id);
      const extents = { xBearing: 0, yBearing: 700, width: 600, height: -700 };
      if (inkless.has(id)) return { texels: new Uint8Array(0), extents };
      const bytes = new Uint8Array(texels * 8);
      bytes[0] = id & 0xff;
      return { texels: bytes, extents };
    },
    destroy() {},
  };
  return font;
}

/** A module whose only job is to hand back the font the test made. */
function fakeModule(font: HbGpuFont): HbGpu {
  return {
    heapBytes: 0,
    shaderLibrary: () => "",
    createFont: () => font,
    destroy: () => {},
  };
}

function setup(
  options: {
    atlasTexels?: number;
    /** Caps the atlas WIDTH too, which is what makes a small `atlasTexels` actually small: the
     *  renderer rounds up to whole rows, so at the default 4096-wide atlas one row already holds
     *  ten 400-texel glyphs and nothing ever evicts. */
    maxTextureSize?: number;
    texels?: number;
    inkless?: readonly number[];
    design?: [number, number];
    framebuffer?: [number, number];
    warnBelowPpemFloor?: boolean;
    offsets?: Record<number, readonly [number, number]>;
    shapeFails?: boolean;
    shapeCacheEntries?: number;
    shapeCacheGlyphs?: number;
    /** Left ABSENT unless a test names one — the point of most of them is the default. */
    contrast?: HbGpuContrast;
    batchAdjacentRuns?: boolean;
  } = {},
) {
  const fake: FakeGl = createFakeGl({ maxTextureSize: options.maxTextureSize });
  const font = fakeFont({
    texels: options.texels,
    inkless: options.inkless,
    offsets: options.offsets,
    shapeFails: options.shapeFails,
  });
  const failures: HbGpuFailure[] = [];
  const pass = createHbGpuGlyphPass({
    gl: fake.gl,
    module: fakeModule(font),
    designWidth: options.design?.[0] ?? 640,
    designHeight: options.design?.[1] ?? 480,
    framebufferWidth: options.framebuffer?.[0],
    framebufferHeight: options.framebuffer?.[1],
    atlasTexels: options.atlasTexels ?? 4096,
    warnBelowPpemFloor: options.warnBelowPpemFloor,
    shapeCacheEntries: options.shapeCacheEntries,
    shapeCacheGlyphs: options.shapeCacheGlyphs,
    // SPREAD IN RATHER THAN SET, so a `setup()` with no opinion passes no `contrast` KEY at all
    // and not an explicit `undefined`. Both reach the renderer identically today; only one of them
    // still proves "the default is the renderer's" if this pass ever grows a `??` of its own.
    ...(options.contrast === undefined ? {} : { contrast: options.contrast }),
    batchAdjacentRuns: options.batchAdjacentRuns,
    onError: (failure) => failures.push(failure),
  }) as HbGpuGlyphPass;
  const face = pass.registerFace(new Uint8Array([1]), "f") as GlyphFace;
  return { fake, font, failures, pass, face };
}

/** A run over `slots`, one glyph per 10 design units. */
function runOf(slots: readonly number[], pixelsPerEm = 32) {
  const run = createGlyphsView(Math.max(1, slots.length));
  run.glyphCount = slots.length;
  run.pixelsPerEm = pixelsPerEm;
  for (let i = 0; i < slots.length; i += 1) {
    run.slots[i] = slots[i];
    run.positions[i * 2] = i * 10;
    run.positions[i * 2 + 1] = 100;
  }
  return run;
}

describe("slot ids", () => {
  it("are dense, stable and uploaded exactly once", () => {
    const { pass, face, font } = setup();
    const a = pass.slotFor(face, 7);
    const b = pass.slotFor(face, 8);
    expect([a, b]).toEqual([0, 1]);
    // Asked again, the id is the same and the encoder is not touched: `slotFor` is a map lookup
    // after the first call, which is what makes it safe to call while building a run.
    expect(pass.slotFor(face, 7)).toBe(a);
    expect(font.encodeCalls).toEqual([7, 8]);
    expect(pass.stats.slots).toBe(2);
  });

  it("give an inkless glyph a distinguishable id, and no allocation", () => {
    // A space encodes to a zero-length blob. Handing it a real-looking id would make a degenerate
    // quad reading texel 0 — which is some other glyph's header, drawn as a smear of ink where a
    // space belongs.
    const { pass, face } = setup({ inkless: [3] });
    expect(pass.slotFor(face, 3)).toBe(GLYPH_SLOT_NONE);
    expect(pass.renderer.atlas.entries).toBe(0);
    // And the caller's run skips it rather than drawing it.
    const drawn = pass.drawRun(
      runOf([GLYPH_SLOT_NONE]),
      fakeProjection(640, 480),
    );
    expect(drawn).toEqual({ glyphs: 0, drawCalls: 0 });
    expect(pass.stats.inkless).toBe(1);
  });

  it("drops an id it never issued instead of drawing whatever is at that index", () => {
    const { pass, face } = setup();
    pass.slotFor(face, 7);
    const drawn = pass.drawRun(runOf([0, 99]), fakeProjection(640, 480));
    expect(drawn.glyphs).toBe(1);
    expect(pass.stats.dropped).toBe(1);
  });
});

describe("fillRun", () => {
  // ONE HARFBUZZ. The pass shapes through hb-gpu's own wasm, so a consumer does not load npm
  // harfbuzzjs as a second build with the same faces resident in a second heap. What is graded
  // here is the pen arithmetic, because it is the part that fails by looking almost right.

  it("converts font units to design units and flips y", () => {
    const { pass, face } = setup();
    const run = createGlyphsView(4);
    run.pixelsPerEm = 32; // scale = 32 / 1000 upem = 0.032
    expect(pass.fillRun(run, face, "AB")).toBe(true);

    expect(run.glyphCount).toBe(2);
    // Second glyph sits one 600-unit advance along: 600 * 0.032 = 19.2. y is 0 on the baseline,
    // and NEGATED — HarfBuzz measures up, the draw list measures down.
    //
    // `toBeCloseTo` on all four, for two reasons this file already meets elsewhere: `positions` is
    // a Float32Array, so 19.2 is stored as 19.200000762939453, and negating a zero baseline gives
    // `-0`, which `toBe` distinguishes from `0` and no renderer does.
    expect(run.positions[0]).toBeCloseTo(0, 10);
    expect(run.positions[1]).toBeCloseTo(0, 10);
    expect(run.positions[2]).toBeCloseTo(600 * 0.032, 5);
    expect(run.positions[3]).toBeCloseTo(0, 10);
    expect([...run.slots.subarray(0, 2)]).toEqual([
      pass.slotFor(face, 0x41),
      pass.slotFor(face, 0x42),
    ]);
  });

  it("advances through an inkless glyph without giving it a slot", () => {
    // A space has no outline and no allocation, and it is still exactly what puts the next word
    // where it belongs. Dropping its advance with its slot would close the gap.
    const { pass, face } = setup({ inkless: [0x20] });
    const run = createGlyphsView(4);
    run.pixelsPerEm = 32;
    pass.fillRun(run, face, "A B");

    expect(run.glyphCount).toBe(2);
    // Third code unit, so two advances along — not one.
    expect(run.positions[2]).toBeCloseTo(2 * 600 * 0.032, 5);
    expect(pass.stats.slots).toBe(2);
  });

  it("applies an offset to its own glyph only, never to the pen", () => {
    // xOffset/yOffset are how a mark is placed against the base it hangs off. Folding one into the
    // pen would drag every following glyph along with the accent — text that is fluent, plausible
    // and progressively mis-spaced.
    const { pass, face } = setup({ offsets: { 66: [100, 50] } }); // "B";
    const run = createGlyphsView(4);
    run.pixelsPerEm = 32;
    pass.fillRun(run, face, "ABC");

    expect(run.positions[2]).toBeCloseTo((600 + 100) * 0.032, 5);
    expect(run.positions[3]).toBeCloseTo(-50 * 0.032, 5);
    // C is back on the pen: two advances, no trace of B's offset.
    expect(run.positions[4]).toBeCloseTo(2 * 600 * 0.032, 5);
    expect(run.positions[5]).toBeCloseTo(0, 10);
  });

  it("grows the run's buffers, and reports a refusal without touching it", () => {
    const { pass, face } = setup();
    const run = createGlyphsView(1);
    run.pixelsPerEm = 32;
    expect(pass.fillRun(run, face, "ABCDE")).toBe(true);
    expect(run.glyphCount).toBe(5);
    expect(run.slots.length).toBeGreaterThanOrEqual(5);

    const refused = setup({ shapeFails: true });
    const untouched = createGlyphsView(2);
    untouched.pixelsPerEm = 32;
    untouched.glyphCount = 7;
    expect(refused.pass.fillRun(untouched, refused.face, "AB")).toBe(false);
    expect(untouched.glyphCount).toBe(7);
  });

  it("memoises scale-free shapes and clears them explicitly", () => {
    const { pass, face, font } = setup();
    const first = createGlyphsView(4);
    first.pixelsPerEm = 16;
    const second = createGlyphsView(4);
    second.pixelsPerEm = 48;
    expect(
      pass.fillRun(first, face, "ABC", { features: ["kern", "-liga"] }),
    ).toBe(true);
    expect(
      pass.fillRun(second, face, "ABC", { features: ["kern", "-liga"] }),
    ).toBe(true);
    expect(font.shapeCalls).toBe(1);
    expect(pass.stats.shapeHits).toBe(1);
    expect(pass.stats.shapeMisses).toBe(1);
    expect(pass.stats.shapeEntries).toBe(1);
    // The cached font-unit positions still receive each run's own scale.
    expect(second.positions[2]).toBeCloseTo(first.positions[2] * 3, 5);
    pass.clearShapeCache();
    expect(pass.stats.shapeEntries).toBe(0);
    expect(
      pass.fillRun(second, face, "ABC", { features: ["kern", "-liga"] }),
    ).toBe(true);
    expect(font.shapeCalls).toBe(2);
  });

  it("keeps feature order, bypasses future options, and evicts LRU entries", () => {
    const { pass, face, font } = setup({
      shapeCacheEntries: 1,
      shapeCacheGlyphs: 8,
    });
    const run = createGlyphsView(4);
    run.pixelsPerEm = 32;
    pass.fillRun(run, face, "A", { features: ["kern", "-liga"] });
    pass.fillRun(run, face, "A", { features: ["-liga", "kern"] });
    expect(font.shapeCalls).toBe(2);
    expect(pass.stats.shapeEvicted).toBe(1);
    pass.fillRun(run, face, "A", { futureOption: true } as never);
    pass.fillRun(run, face, "A", { futureOption: true } as never);
    expect(font.shapeCalls).toBe(4);
    expect(pass.stats.shapeEntries).toBe(1);
  });

  it("retains shaped runs across context loss and rebuild", () => {
    const { pass, face, font } = setup();
    const run = createGlyphsView(4);
    run.pixelsPerEm = 32;
    pass.fillRun(run, face, "AB");
    pass.notifyContextLost();
    expect(pass.rebuild()).toBe(true);
    pass.fillRun(run, face, "AB");
    expect(font.shapeCalls).toBe(1);
    expect(pass.stats.shapeHits).toBe(1);
  });
});

describe("eviction", () => {
  /** An atlas that holds exactly two 400-texel glyphs. */
  function tinyAtlas() {
    return setup({ atlasTexels: 1024, maxTextureSize: 1024, texels: 400 });
  }

  it("re-uploads an evicted slot instead of drawing a stale one", () => {
    // THE WHOLE REASON `GlyphsView.slots` HOLDS IDS. Glyph 3's upload wraps the ring onto glyph
    // 1's texels, so a pass that had cached glyph 1's `GlyphSlot` would hand hb-gpu an offset that
    // now belongs to glyph 3 — which its generation guard would SKIP, leaving a hole, and which
    // without that guard would be glyph 3's outline drawn where glyph 1 belongs.
    const { pass, face, font } = tinyAtlas();
    const one = pass.slotFor(face, 1);
    pass.slotFor(face, 2);
    pass.slotFor(face, 3);
    expect(pass.renderer.atlas.evictions).toBe(1);

    const before = font.encodeCalls.length;
    const drawn = pass.drawRun(runOf([one]), fakeProjection(640, 480));

    expect(drawn).toEqual({ glyphs: 1, drawCalls: 1 });
    // Drawn, not skipped: `staleSkips` non-zero would mean the pass handed over a dead slot.
    expect(pass.renderer.atlas.staleSkips).toBe(0);
    expect(pass.stats.reuploads).toBe(1);
    expect(font.encodeCalls.slice(before)).toEqual([1]);
  });

  it("costs nothing extra while every glyph is still resident", () => {
    const { pass, face, font } = tinyAtlas();
    const one = pass.slotFor(face, 1);
    const two = pass.slotFor(face, 2);
    const before = font.encodeCalls.length;
    expect(pass.drawRun(runOf([one, two]), fakeProjection(640, 480))).toEqual({
      glyphs: 2,
      drawCalls: 1,
    });
    // `resolve` is a map lookup. If this ever encodes, the frame is paying ~180 ms for a Han
    // working set it already has in VRAM.
    expect(font.encodeCalls.length).toBe(before);
    expect(pass.stats.reuploads).toBe(0);
  });

  it("admits a resident adjacent batch and declines an evicted source before submission", () => {
    const { pass, face, font } = setup({
      atlasTexels: 1024,
      maxTextureSize: 1024,
      texels: 400,
      batchAdjacentRuns: true,
    });
    const one = pass.slotFor(face, 1);
    const two = pass.slotFor(face, 2);
    const resident = [runOf([one]), runOf([two])];
    expect(pass.canBatchRuns?.(resident)).toBe(true);
    expect(pass.drawRuns?.(resident, fakeProjection(640, 480))).toEqual({
      glyphs: 2,
      drawCalls: 1,
    });

    // The third upload evicts the oldest allocation. A batch that tried to repair `one` while
    // keeping `two` in the same GPU draw could overwrite a source already queued for that draw.
    // Advance the atlas frame first: eviction during the in-flight batched draw is rightly
    // forbidden, while a later frame may replace an old source.
    pass.drawRun(runOf([two]), fakeProjection(640, 480));
    pass.slotFor(face, 3);
    expect(pass.canBatchRuns?.(resident)).toBe(false);
    const before = font.encodeCalls.length;
    expect(pass.drawRun(resident[0]!, fakeProjection(640, 480))).toEqual({
      glyphs: 1,
      drawCalls: 1,
    });
    expect(font.encodeCalls.length).toBeGreaterThan(before);
    expect(pass.renderer.atlas.staleSkips).toBe(0);
  });
});

describe("the run's colour and transform", () => {
  function lastInstance(fake: ReturnType<typeof createFakeGl>): Float32Array {
    const call = fake.named("bufferSubData").at(-1)!;
    return call.args[2] as Float32Array;
  }

  it("does not expose grouped drawing on the compact legacy pass", () => {
    const { pass } = setup();
    expect(pass.drawRuns).toBeUndefined();
    expect(pass.canBatchRuns).toBeUndefined();
  });

  it("un-premultiplies the run's colour, because hb-gpu multiplies once", () => {
    // `GlyphsView` stores `rgb` already multiplied by `a`; hb-gpu's fragment writes
    // `vec4(rgb * a * cov, a * cov)`. Handing the premultiplied triple straight over applies alpha
    // twice — silently, as text that is merely darker, which is exactly the failure the package's
    // alpha note names for every other stage.
    const { fake, pass, face } = setup();
    const id = pass.slotFor(face, 1);
    const run = runOf([id]);
    run.a = 0.5;
    run.r = 0.4; // 0.8 straight
    run.g = 0.25; // 0.5 straight
    run.b = 0.1; // 0.2 straight
    fake.reset();
    pass.drawRun(run, fakeProjection(640, 480));
    const color = fake.named("uniform4fv")[0]!.args[1] as Float32Array;
    expect([...color]).toEqual([0.8, 0.5, 0.2, 0.5].map(Math.fround));
  });

  it("survives a fully transparent run without emitting NaN", () => {
    // `1 / 0` is `Infinity`, and `0 * Infinity` is NaN — which makes every instance record NaN and
    // the draw a silent no-op somewhere else entirely.
    const { fake, pass, face } = setup();
    const run = runOf([pass.slotFor(face, 1)]);
    run.a = 0;
    run.r = 0;
    run.g = 0;
    run.b = 0;
    fake.reset();
    pass.drawRun(run, fakeProjection(640, 480));
    const color = fake.named("uniform4fv")[0]!.args[1] as Float32Array;
    expect([...color].every(Number.isFinite)).toBe(true);
  });

  it("passes the run's transform through as the model matrix", () => {
    // ROTATION BELONGS IN `m`, never in the pen positions: `hb_gpu_dilate` computes its half-pixel
    // dilation by pushing the quad's corner AND its normal through this same matrix, so a rotation
    // applied on the CPU would be dilated along the wrong axes.
    const { fake, pass, face } = setup({ design: [640, 480] });
    const run = runOf([pass.slotFor(face, 1)]);
    // 90 degrees, in the draw list's Transform2D order.
    run.m.set([0, 1, -1, 0, 0, 0]);
    fake.reset();
    pass.drawRun(run, fakeProjection(640, 480));
    const mvp = fake.named("uniformMatrix4fv")[0]!.args[2] as Float32Array;
    expect(mvp[0]).toBeCloseTo(0, 10);
    expect(mvp[1]).toBe(Math.fround(-2 / 480));
    expect(mvp[4]).toBe(Math.fround(-(2 / 640)));
    expect(mvp[5]).toBeCloseTo(0, 10);
  });

  it("hands the run's spread to the renderer on every run, including the runs with none", () => {
    // THE ORDER MATTERS AND THAT IS THE WHOLE TEST. hb-gpu's spread is sticky exactly like its
    // colour and its model matrix — `begin` does not clear it — so a pass that only called
    // `setSpread` when the run asked for an outline would leave the previous run's spread in the
    // program. An outlined label followed by a plain one then draws the plain one fat: a picture,
    // not an error, and nothing downstream counts it.
    //
    // A fake context cannot see the outline itself; `packages/hb-gpu/test/glyphPixelXvfb.test.ts`
    // owns that on a real driver. What it can see is the call that a pixel test would be blind to.
    const { fake, pass, face } = setup();
    const spread = () => fake.named("uniform1f").at(-1)!.args[1];

    const outlined = runOf([pass.slotFor(face, 1)]);
    outlined.spreadPx = 3;
    fake.reset();
    pass.drawRun(outlined, fakeProjection(640, 480));
    expect(spread()).toEqual(3);

    const plain = runOf([pass.slotFor(face, 1)]);
    fake.reset();
    pass.drawRun(plain, fakeProjection(640, 480));
    expect(
      spread(),
      "the run after an outlined one did not re-state the spread — hb-gpu keeps the previous value and draws this run fat",
    ).toEqual(0);
  });

  it("submits adjacent runs once while retaining each run's model, colour and spread", () => {
    const { fake, pass, face } = setup({
      design: [640, 480],
      batchAdjacentRuns: true,
    });
    const first = runOf([pass.slotFor(face, 1)]);
    first.m.set([1, 0, 0, 1, 7, 9]);
    first.a = 0.5;
    first.r = 0.4;
    first.g = 0.25;
    first.b = 0.1;
    first.spreadPx = 2;
    const second = runOf([pass.slotFor(face, 2)]);
    second.m.set([0, 1, -1, 0, 13, 17]);
    second.a = 1;
    second.r = 0.3;
    second.g = 0.6;
    second.b = 0.9;

    fake.reset();
    expect(pass.drawRuns?.([first, second], fakeProjection(640, 480))).toEqual({
      glyphs: 2,
      drawCalls: 1,
    });
    expect(fake.draws).toHaveLength(1);
    expect(fake.draws[0]!.instanceCount).toBe(2);
    const data = lastInstance(fake);
    // Record layout: geometry 0..9, model 10..15, straight rgba 16..19, spread 20.
    expect([...data.slice(10, 16)]).toEqual([1, 0, 0, 1, 7, 9]);
    expect([...data.slice(16, 21)]).toEqual(
      [0.8, 0.5, 0.2, 0.5, 2].map((n) => Math.fround(n)),
    );
    expect([...data.slice(31, 37)]).toEqual([0, 1, -1, 0, 13, 17]);
    expect([...data.slice(37, 42)]).toEqual(
      [0.3, 0.6, 0.9, 1, 0].map((n) => Math.fround(n)),
    );
  });

  it("leaves the spread alone through fillRun, so one shaping pass feeds both runs", () => {
    // An outlined label is the SAME glyphs and pens twice. `fillRun` writes only `slots`,
    // `positions` and `glyphCount`, so a caller shapes once and then pushes the view twice with
    // different colours and spreads; if `fillRun` reset the spread, the second push would need its
    // own shaping pass and the two runs could drift apart by a sub-pixel pen difference.
    const { pass, face } = setup();
    const run = createGlyphsView(4);
    run.pixelsPerEm = 32;
    run.spreadPx = 1.5;
    expect(pass.fillRun(run, face, "ab")).toBe(true);
    expect(run.glyphCount).toBe(2);
    expect(run.spreadPx).toBe(1.5);
  });
});

describe("the projection", () => {
  it("projects from the design size and dilates against the framebuffer size", () => {
    // THE 2x-DPR CASE. `u_viewport` is what `hb_gpu_dilate` measures half a SCREEN pixel against,
    // so handed the design size it dilates twice as far as it should.
    //
    // ASSERTED ON THE UNIFORM BECAUSE THE PIXELS CANNOT SEE IT at this ratio: over-dilation adds
    // fragments whose coverage evaluates to 0, and it was measured at zero differing bytes on a
    // real driver. The direction that does show up is a buffer SMALLER than design space, which
    // clips the AA rim — `packages/test-harness/test/canvasGlyphPixelXvfb.test.ts` covers both.
    const { fake, pass, face } = setup({ design: [640, 480] });
    const run = runOf([pass.slotFor(face, 1)]);
    fake.reset();
    pass.drawRun(run, fakeProjection(640, 480, 1280, 960));
    expect(fake.named("uniform2f")[0].args.slice(1)).toEqual([1280, 960]);
    const mvp = fake.named("uniformMatrix4fv")[0].args[2] as Float32Array;
    expect(mvp[0]).toBe(Math.fround(2 / 640));
    expect(mvp[5]).toBe(Math.fround(-2 / 480));
  });

  it("follows the projection when the stage resizes between frames", () => {
    const { fake, pass, face } = setup({ design: [640, 480] });
    const run = runOf([pass.slotFor(face, 1)]);
    pass.drawRun(run, fakeProjection(640, 480));
    fake.reset();
    pass.drawRun(run, fakeProjection(1920, 1080, 1920, 1080));
    const mvp = fake.named("uniformMatrix4fv")[0].args[2] as Float32Array;
    expect(mvp[0]).toBe(Math.fround(2 / 1920));
    expect(fake.named("uniform2f")[0].args.slice(1)).toEqual([1920, 1080]);
  });
});

describe("the ppem fidelity floor", () => {
  it("warns once, and counts every run, below the floor", () => {
    // MEASURED, AND A SHIPPING CONSTRAINT RATHER THAN A BUG: HarfBuzz's coverage shader takes a
    // five-tap branch under ppem 16, and against an 8x-downsampled reference this path is 0.196 on
    // Han at ppem 14 — blurrier than the DOM path's 0.132.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { pass, face } = setup({ design: [640, 480] });
      const run = runOf([pass.slotFor(face, 1)], PPEM_FIDELITY_FLOOR - 2);
      pass.drawRun(run, fakeProjection(640, 480));
      pass.drawRun(run, fakeProjection(640, 480));
      expect(pass.stats.runsBelowPpemFloor).toBe(2);
      // Once. A page of small text would otherwise emit a line per label per frame, and a warning
      // nobody can read is a warning nobody reads.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/device ppem/);
    } finally {
      warn.mockRestore();
    }
  });

  it("measures ppem in DEVICE pixels, so a 2x stage clears the floor at 14 design px", () => {
    // The phone case the docs quote: 14 CSS px at DPR 3.5 is ppem 49, where this path's distortion
    // is 0.017. The floor is about device pixels and nothing else.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { pass, face } = setup({ design: [640, 480] });
      const run = runOf([pass.slotFor(face, 1)], 14);
      pass.drawRun(run, fakeProjection(640, 480, 1280, 960));
      expect(pass.stats.runsBelowPpemFloor).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // The reported ppem, read back out of the one place the pass publishes it. `toFixed(1)` is the
  // resolution, so every claim below is bracketed to within 0.1 rather than asserted exactly.
  function reportedPpem(warn: { mock: { calls: unknown[][] } }): number | null {
    const first = warn.mock.calls[0]?.[0];
    if (typeof first !== "string") return null;
    const match = /drawn at ([\d.]+) device ppem/.exec(first);
    return match ? Number(match[1]) : null;
  }

  it("folds the scale in the run's model matrix into the ppem it gates on", () => {
    // THE GATE HAS TO AGREE WITH THE SHADER IT IS GATING ON. `hb_gpu_draw` branches on the ppem it
    // derives from `fwidth`, which is the whole chain — design ppem, model matrix, device ratio.
    // This number is the CPU's copy of that, and its only jobs are the counter and the warning.
    // The main consumer puts its fan/fit/hover scale in `run.m` on every node, so a copy that
    // ignored the matrix reported 59.3 for a run the shader was drawing at 23.7: a counter reading
    // a confident zero and a warning that could never fire.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A POWER-OF-TWO DESIGN WIDTH, AND THE BOUNDARY CASE IS THE REASON. `drawRun` recovers the
      // design size from `toClip` (see "the projection" above), and `2 / Float32(2 / 640)` is
      // 639.99999, so a 640-wide stage scales by 1.0000000149 and lands "exactly 16" at
      // 16.0000002 — which clears the floor under `<` AND under `<=`, so it would grade nothing.
      // 512 round-trips exactly, so the run below sits ON 16 and the `<` is really tested.
      const half = setup({ design: [512, 256] });
      const onFloor = runOf([half.pass.slotFor(half.face, 1)], 32);
      onFloor.m.set([0.5, 0, 0, 0.5, 12, 34]);
      half.pass.drawRun(onFloor, fakeProjection(512, 256));
      // ON the floor is not UNDER it: the shader's own branch is `ppem < 16.0`, so this must not
      // count. `<`, consistently, on both sides.
      expect(half.pass.stats.runsBelowPpemFloor).toBe(0);
      expect(warn).not.toHaveBeenCalled();

      // ...and 16 is genuinely WHERE the boundary is, not merely somewhere this run cleared: the
      // same matrix over a design ppem 0.2 lower lands at 15.9 and trips. 0.1 of headroom on the
      // claim, which is `toFixed(1)`'s whole resolution.
      const under = setup({ design: [512, 256] });
      const justUnder = runOf([under.pass.slotFor(under.face, 1)], 31.8);
      justUnder.m.set([0.5, 0, 0, 0.5, 12, 34]);
      under.pass.drawRun(justUnder, fakeProjection(512, 256));
      expect(under.pass.stats.runsBelowPpemFloor).toBe(1);
      expect(reportedPpem(warn)).toBeCloseTo(15.9, 5);
      warn.mockClear();

      // 32 at 0.4 is 12.8, and it is counted AND named. The number in the message is the one a
      // reader has to be able to act on: it is what the shader sees, not the size the caller typed.
      const shrunk = setup({ design: [512, 256] });
      const small = runOf([shrunk.pass.slotFor(shrunk.face, 1)], 32);
      small.m.set([0.4, 0, 0, 0.4, 0, 0]);
      shrunk.pass.drawRun(small, fakeProjection(512, 256));
      expect(shrunk.pass.stats.runsBelowPpemFloor).toBe(1);
      expect(reportedPpem(warn)).toBeCloseTo(12.8, 5);
      // The pre-truthful number, which cleared the floor by 2x, is nowhere in the message.
      expect(warn.mock.calls[0][0]).not.toMatch(/drawn at 32/);
      warn.mockClear();

      // THE MEAN OF THE TWO AXES, WHICH IS THE CONSUMER'S OWN RULE — `rasterScaleFor` in
      // sts2-couch-coop's `mirror/canvas/textLayout.ts` reduces the same matrix the same way, and
      // a gate that disagreed with the raster scale beside it would be a second opinion about one
      // number. 40 ppem under a matrix that is 0.5 wide and 0.1 tall is 12.0, and this case is
      // the one that can tell mean apart from the alternatives: the x axis alone reads 20 and the
      // sum reads 24 (both clear the floor and count nothing), the y axis alone reads 4.
      const squashed = setup({ design: [512, 256] });
      const anisotropic = runOf([squashed.pass.slotFor(squashed.face, 1)], 40);
      anisotropic.m.set([0.5, 0, 0, 0.1, 0, 0]);
      squashed.pass.drawRun(anisotropic, fakeProjection(512, 256));
      expect(squashed.pass.stats.runsBelowPpemFloor).toBe(1);
      expect(reportedPpem(warn)).toBeCloseTo(12, 5);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads a pure rotation as no scale at all, which is what it always assumed", () => {
    // THE OLD CONTRACT WHERE IT WAS TRUE. `GlyphsView.m` carries rotation by design — the shader
    // dilates by pushing the corner and its normal through it — and a rotation's basis vectors are
    // both unit length, so the mean axis is 1 and the reported ppem is what it was before the
    // matrix was read at all. Measured against the un-rotated run rather than against a constant,
    // so the two cannot drift apart.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const plain = setup({ design: [640, 480] });
      plain.pass.drawRun(
        runOf([plain.pass.slotFor(plain.face, 1)], 14),
        fakeProjection(640, 480),
      );
      const before = reportedPpem(warn);
      expect(before).toBeCloseTo(14, 5);
      warn.mockClear();

      const turned = setup({ design: [640, 480] });
      const rotated = runOf([turned.pass.slotFor(turned.face, 1)], 14);
      const radians = Math.PI / 6; // 30 degrees, in the draw list's Transform2D order.
      rotated.m.set([
        Math.cos(radians),
        Math.sin(radians),
        -Math.sin(radians),
        Math.cos(radians),
        7,
        9,
      ]);
      turned.pass.drawRun(rotated, fakeProjection(640, 480));
      expect(turned.pass.stats.runsBelowPpemFloor).toBe(1);
      expect(reportedPpem(warn)).toBe(before);

      // And the residue is far smaller than the counter could ever notice: `m` is a Float32Array,
      // so `cos^2 + sin^2` is 1 only to about 1e-7, against the 2 ppem of headroom this run has
      // below the floor.
      const axis =
        (Math.hypot(rotated.m[0], rotated.m[1]) +
          Math.hypot(rotated.m[2], rotated.m[3])) /
        2;
      expect(Math.abs(axis - 1)).toBeLessThan(1e-6);
    } finally {
      warn.mockRestore();
    }
  });

  it("can be silenced without losing the counter", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { pass, face } = setup({ warnBelowPpemFloor: false });
      pass.drawRun(runOf([pass.slotFor(face, 1)], 8), fakeProjection(640, 480));
      expect(warn).not.toHaveBeenCalled();
      expect(pass.stats.runsBelowPpemFloor).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the contrast curve", () => {
  // THE HALF NO PIXEL GOLDEN CAN SEE. `test:canvas-glyph-pixel` draws at the shipped default and
  // would go red if the default MOVED — but a golden cannot tell "the option was forwarded" from
  // "the option was accepted and ignored", and an ignored option is exactly how a plumbing change
  // fails. So what is asserted here is the uniform the renderer ends up writing, which is the only
  // place the two stories differ.
  //
  // Reading it needs the location tag rather than a location: `test/fake-gl.ts` hands back
  // `{ __gl: "uniform:<name>" }` from `getUniformLocation`, the same shape (and for the same
  // reason) as `packages/hb-gpu/test/renderer.test.ts`'s own `uniformName`.
  const uniformName = (location: unknown): string => {
    if (typeof location !== "object" || location === null) return "";
    const tag = (location as { __gl?: unknown }).__gl;
    return typeof tag === "string" && tag.startsWith("uniform:")
      ? tag.slice("uniform:".length)
      : "";
  };
  const writes = (fake: FakeGl, name: string): unknown[] =>
    fake
      .named("uniform1f")
      .filter((call) => uniformName(call.args[0]) === name)
      .map((call) => call.args[1]);

  it("is the renderer's own when the option is omitted — stem darkening ON", () => {
    // THE PIN ON TODAY'S PICTURE. Every consumer that mounts this pass without saying anything
    // gets `HB_GPU_CONTRAST_DEFAULT`, and the committed glyph-pixel goldens were drawn under it.
    // A default quietly flipped to `none` would not crash anything and would not fail a shape
    // assertion anywhere — it would draw perfectly good, slightly lighter text.
    const { fake, failures } = setup();
    expect(writes(fake, "u_stemDarken")).toEqual([1]);
    expect(writes(fake, "u_gamma")).toEqual([1]);
    expect(failures).toEqual([]);
  });

  it("forwards HB_GPU_CONTRAST_NONE — the Godot-parity setting — to the renderer", () => {
    // What `../sts2-couch-coop`'s `frontend/src/mirror/canvas/glyphPass.ts` mounts with, and why:
    // Godot applies no contrast curve of its own, and the A1 crossover sweep measures this path's
    // distortion at 0.0258 against 0.1091 at ppem 16 with the curve off vs on. See the option's doc.
    const { fake, failures } = setup({ contrast: HB_GPU_CONTRAST_NONE });
    expect(writes(fake, "u_stemDarken")).toEqual([0]);
    expect(writes(fake, "u_gamma")).toEqual([1]);
    expect(failures).toEqual([]);
  });

  it("forwards the whole pair, not just the flag it knows about", () => {
    // `gamma` reaches EVERY pass where `stemDarkening` reaches only an undilated one, so the two
    // fields are not interchangeable and a plumbing that carried one of them would be a plumbing
    // that silently dropped a deliberate transfer curve.
    const { fake, failures } = setup({
      contrast: {
        gamma: 2.2,
        stemDarkening: true,
      },
    });
    expect(writes(fake, "u_gamma")).toEqual([2.2]);
    expect(writes(fake, "u_stemDarken")).toEqual([1]);
    expect(failures).toEqual([]);
  });

  it("leaves the renderer to refuse a degenerate gamma, and does not construct-null over it", () => {
    // NOT THIS FILE'S VALIDATION, ON PURPOSE: `createHbGpuRenderer` already falls back to 1 and
    // reports `degenerate-contrast`, and a second check here would be a second thing to keep in
    // agreement with the shader. What this pins is that the failure ARRIVES — the pass's `onError`
    // is the only channel a consumer wired up — and that the pass still builds, because a page
    // with no words on it is a worse answer to a bad number than uncorrected text is.
    const { pass, fake, failures } = setup({
      contrast: {
        gamma: Number.NaN,
        stemDarkening: true,
      },
    });
    expect(pass).not.toBeNull();
    expect(failures.map((f) => f.reason)).toEqual(["degenerate-contrast"]);
    expect(writes(fake, "u_gamma")).toEqual([1]);
  });
});

describe("construct-or-null and the context lifecycle", () => {
  it("returns null rather than throwing when the renderer will not build", () => {
    // The repo's idiom. A consumer that cannot have the GPU glyph path falls back to its DOM one,
    // and only it knows whether that is acceptable — but it is always told why.
    const fake = createFakeGl({ linkFails: true, infoLog: "nope" });
    const failures: HbGpuFailure[] = [];
    const pass = createHbGpuGlyphPass({
      gl: fake.gl,
      module: fakeModule(fakeFont()),
      designWidth: 640,
      designHeight: 480,
      onError: (failure) => failures.push(failure),
    });
    expect(pass).toBeNull();
    expect(failures.map((f) => f.reason)).toContain("program-link");
  });

  it("forwards the loss and the restore, and keeps every slot id valid across them", () => {
    // SAME OFFSETS ON REBUILD, so nothing the caller recorded has to change. A slot ID is a handle
    // into this pass's own table anyway, which is why it survives an event that destroys the whole
    // atlas texture.
    const { pass, face, font } = setup();
    const id = pass.slotFor(face, 1);
    pass.notifyContextLost();
    expect(pass.renderer.contextLost).toBe(true);
    expect(pass.rebuild()).toBe(true);
    expect(font.encodeCalls).toEqual([1, 1]);
    expect(pass.drawRun(runOf([id]), fakeProjection(640, 480))).toEqual({
      glyphs: 1,
      drawCalls: 1,
    });
  });
});
