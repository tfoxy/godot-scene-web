import { describe, expect, it } from "vitest";
import { createCanvasExecutor } from "../src/executor-webgl";
import {
  buildCombatProfile,
  COMBAT_BLEND_BREAKS,
  COMBAT_CLIP_BREAKS,
  COMBAT_DISTINCT_SOURCES,
  COMBAT_NAIVE_RUNS,
  COMBAT_PAINTING_NODES,
} from "./combat-profile";
import { createFakeGl, fakeProjection } from "./fake-gl";

/**
 * The batch-count bound the wave-1 design was signed off against.
 *
 * The offline probe measured combat at 152 runs from 183 painting nodes with 65
 * distinct paint sources — 1.20 nodes per batch, i.e. essentially no batching —
 * and attributed 151 of those 152 breaks to the TEXTURE alone. The design claim
 * is that multi-texture batching removes almost all of them, leaving roughly the
 * state a batch genuinely cannot carry: the blend changes (16) and the clip-scope
 * changes (26).
 *
 * So the bound below is not a round number picked to pass: it sits just above the
 * 16 + 26 = 42 state changes this list forces, with headroom for texture-table
 * refills. If a change to the batcher pushes past the ceiling, texture batching
 * has regressed.
 *
 * The FLOOR is `COMBAT_CLIP_BREAKS + 1`, not the sum. A blend change and a clip
 * change that land on the same node boundary flush ONCE between them, so the sum
 * is an upper bound on forced flushes rather than a lower one; the 26 clip
 * transitions are individually distinct, so each of them really does cost a draw.
 */
const BATCH_CEILING = 60;
const BATCH_FLOOR = COMBAT_CLIP_BREAKS + 1;

describe("combat-profile fixture", () => {
  it("reproduces the probe's measured shape", () => {
    const profile = buildCombatProfile();
    expect(profile.quads).toBe(COMBAT_PAINTING_NODES);
    expect(profile.distinctTextures).toBe(COMBAT_DISTINCT_SOURCES);
    expect(profile.naiveRuns).toBe(COMBAT_NAIVE_RUNS);
    // Every run breaks on its source, as the probe found (151 of 152 there).
    expect(profile.breaks.source).toBeGreaterThanOrEqual(COMBAT_NAIVE_RUNS - 1);
    expect(profile.breaks.blend).toBe(COMBAT_BLEND_BREAKS);
    expect(profile.breaks.clip).toBe(COMBAT_CLIP_BREAKS);
  });
});

describe("executor batching on the combat profile", () => {
  it(`turns ${COMBAT_NAIVE_RUNS} naive runs into at most ${BATCH_CEILING} draw calls`, () => {
    const profile = buildCombatProfile();
    const fake = createFakeGl({ maxTextureUnits: 16 });
    const executor = createCanvasExecutor({ gl: fake.gl });
    expect(executor.execute(profile.list, fakeProjection(1920, 1080))).toBe(
      true,
    );

    const draws = fake.draws.length;
    // Reported so a run of this test says what it actually achieved, not only
    // that it cleared the bar.
    console.log(
      `combat profile: ${profile.quads} quads, ${profile.distinctTextures} textures, ` +
        `${profile.naiveRuns} naive runs -> ${draws} draw calls ` +
        `(flushes: ${JSON.stringify(executor.stats.flushes)}, ` +
        `max batch ${executor.stats.maxBatchQuads} quads)`,
    );

    expect(draws).toBe(executor.stats.batches);
    expect(draws).toBeLessThanOrEqual(BATCH_CEILING);
    expect(draws).toBeGreaterThanOrEqual(BATCH_FLOOR);
    // Every quad reached the GPU exactly once.
    expect(fake.draws.reduce((sum, draw) => sum + draw.instanceCount, 0)).toBe(
      COMBAT_PAINTING_NODES,
    );
    expect(executor.stats.quads).toBe(COMBAT_PAINTING_NODES);
  });

  it("breaks on state, not on texture: source is no longer the dominant axis", () => {
    const profile = buildCombatProfile();
    const fake = createFakeGl({ maxTextureUnits: 16 });
    const executor = createCanvasExecutor({ gl: fake.gl });
    executor.execute(profile.list, fakeProjection(1920, 1080));
    const flushes = executor.stats.flushes;
    // The probe's 151 source breaks are the number to beat. Texture-table refills
    // are what is left of them once a batch can hold 16 pages at once.
    expect(flushes.textureSlots).toBeLessThan(profile.breaks.source / 4);
    expect(flushes.blend + flushes.clip).toBeGreaterThan(flushes.textureSlots);
  });

  it("degrades gracefully on a context with only 8 texture units", () => {
    // Not a regression guard so much as a statement of the shape: a smaller slot
    // table costs more refills and nothing else moves, so the count rises a
    // little and stays nowhere near the naive one.
    const profile = buildCombatProfile();
    const projection = fakeProjection(1920, 1080);
    const wide = createFakeGl({ maxTextureUnits: 16 });
    createCanvasExecutor({ gl: wide.gl }).execute(profile.list, projection);

    const narrow = createFakeGl({ maxTextureUnits: 8 });
    const executor = createCanvasExecutor({ gl: narrow.gl });
    executor.execute(profile.list, projection);
    expect(executor.maxTextureSlots).toBe(8);
    expect(narrow.draws.length).toBeGreaterThanOrEqual(wide.draws.length);
    expect(narrow.draws.length).toBeLessThan(COMBAT_NAIVE_RUNS / 2);
  });

  it("allocates nothing new on the second identical frame", () => {
    const profile = buildCombatProfile();
    const fake = createFakeGl({ maxTextureUnits: 16 });
    const executor = createCanvasExecutor({ gl: fake.gl });
    const projection = fakeProjection(1920, 1080);
    executor.execute(profile.list, projection);
    const first = fake.draws.length;
    fake.reset();
    executor.execute(profile.list, projection);
    expect(fake.draws.length).toBe(first);
    // The instance buffer is grown at most once per frame size, so a repeat frame
    // re-uploads without a single `bufferData`.
    expect(fake.named("bufferData")).toHaveLength(0);
  });
});
