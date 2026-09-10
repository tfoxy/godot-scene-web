import { describe, expect, it } from "vitest";
import {
  type Batch,
  type BatchTexture,
  createQuadBatcher,
  INSTANCE_FLOATS,
  INSTANCE_SLOTS_OFFSET,
  INSTANCE_UV_OFFSET,
  MAX_TEXTURE_SLOTS,
  type QuadBatcher,
} from "../src/batcher";
import { BLEND_ADD, BLEND_MIX } from "../src/draw-list";

interface Recorded {
  quadCount: number;
  textureCount: number;
  colorMatrixCount: number;
  blend: number;
  clipEpoch: number;
  reason: string;
  slots: number[];
  matrixSlots: number[];
}

function harness(
  options: { maxTextureSlots?: number; maxColorMatrices?: number } = {},
): { batcher: QuadBatcher; batches: Recorded[] } {
  const batches: Recorded[] = [];
  const batcher = createQuadBatcher({
    ...options,
    draw(batch: Batch) {
      const slots: number[] = [];
      const matrixSlots: number[] = [];
      for (let i = 0; i < batch.quadCount; i += 1) {
        slots.push(
          batch.instances[i * INSTANCE_FLOATS + INSTANCE_SLOTS_OFFSET],
        );
        matrixSlots.push(
          batch.instances[i * INSTANCE_FLOATS + INSTANCE_SLOTS_OFFSET + 1],
        );
      }
      batches.push({
        quadCount: batch.quadCount,
        textureCount: batch.textureCount,
        colorMatrixCount: batch.colorMatrixCount,
        blend: batch.blend,
        clipEpoch: batch.clipEpoch,
        reason: batch.reason,
        slots,
        matrixSlots,
      });
    },
  });
  return { batcher, batches };
}

function texture(id: number): BatchTexture {
  return { texture: { id } as unknown as WebGLTexture };
}

describe("quad batcher merging", () => {
  it("merges quads with DIFFERENT textures into one draw", () => {
    // The whole reason this class exists: eight textures, one batch.
    const { batcher, batches } = harness({ maxTextureSlots: 16 });
    for (let i = 0; i < 8; i += 1) batcher.push(texture(i));
    batcher.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0].quadCount).toBe(8);
    expect(batches[0].textureCount).toBe(8);
    expect(batches[0].slots).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("gives a repeated texture the SAME slot", () => {
    const { batcher, batches } = harness();
    const a = texture(1);
    const b = texture(2);
    for (const t of [a, b, a, a, b]) batcher.push(t);
    batcher.flush();
    expect(batches[0].textureCount).toBe(2);
    expect(batches[0].slots).toEqual([0, 1, 0, 0, 1]);
  });

  it("flushes when the texture table is full and starts a fresh one", () => {
    const { batcher, batches } = harness({ maxTextureSlots: 4 });
    for (let i = 0; i < 9; i += 1) batcher.push(texture(i));
    batcher.flush();
    expect(batches.map((b) => b.quadCount)).toEqual([4, 4, 1]);
    expect(batches.map((b) => b.reason)).toEqual([
      "textureSlots",
      "textureSlots",
      "end",
    ]);
    expect(batcher.stats.flushes.textureSlots).toBe(2);
  });

  it("does NOT flush when the full table already holds the next texture", () => {
    const { batcher, batches } = harness({ maxTextureSlots: 2 });
    const a = texture(1);
    const b = texture(2);
    for (const t of [a, b, a, b, a, b]) batcher.push(t);
    batcher.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0].quadCount).toBe(6);
  });
});

describe("quad batcher flush triggers", () => {
  it("breaks on a blend change and carries the mode on the batch", () => {
    const { batcher, batches } = harness();
    batcher.push(texture(1));
    batcher.setBlend(BLEND_ADD);
    batcher.push(texture(1));
    batcher.flush();
    expect(batches.map((b) => b.reason)).toEqual(["blend", "end"]);
    expect(batches.map((b) => b.blend)).toEqual([BLEND_MIX, BLEND_ADD]);
  });

  it("does not break when the blend is set to what it already is", () => {
    const { batcher, batches } = harness();
    batcher.push(texture(1));
    batcher.setBlend(BLEND_MIX);
    batcher.push(texture(1));
    batcher.flush();
    expect(batches).toHaveLength(1);
  });

  it("breaks on a clip-scope change", () => {
    const { batcher, batches } = harness();
    batcher.push(texture(1));
    batcher.setClipEpoch(7);
    batcher.push(texture(1));
    batcher.setClipEpoch(8);
    batcher.push(texture(1));
    batcher.flush();
    expect(batches.map((b) => b.reason)).toEqual(["clip", "clip", "end"]);
    expect(batches.map((b) => b.clipEpoch)).toEqual([0, 7, 8]);
  });

  it("does not emit an empty batch when state changes with nothing pending", () => {
    const { batcher, batches } = harness();
    batcher.setBlend(BLEND_ADD);
    batcher.setClipEpoch(3);
    batcher.flush();
    expect(batches).toHaveLength(0);
    expect(batcher.stats.batches).toBe(0);
  });
});

describe("quad batcher colour-matrix table", () => {
  const red = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const green = new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0]);

  it("keeps the identity at slot 0 and costs a matrix-free quad nothing", () => {
    const { batcher, batches } = harness();
    batcher.push(texture(1));
    batcher.push(texture(1), null);
    batcher.flush();
    expect(batches[0].colorMatrixCount).toBe(1);
    expect(batches[0].matrixSlots).toEqual([0, 0]);
  });

  it("DEDUPES matrices by value, so many cards on one tint share a slot", () => {
    const { batcher, batches } = harness();
    batcher.push(texture(1), red);
    batcher.push(texture(2), new Float32Array(red));
    batcher.push(texture(3), green);
    batcher.push(texture(4), red);
    batcher.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0].colorMatrixCount).toBe(3);
    expect(batches[0].matrixSlots).toEqual([1, 1, 2, 1]);
  });

  it("flushes when the matrix table overflows, and re-slots the texture", () => {
    // Three slots = identity plus two matrices.
    const { batcher, batches } = harness({ maxColorMatrices: 3 });
    const shared = texture(9);
    for (let i = 0; i < 5; i += 1) {
      const matrix = new Float32Array(9);
      matrix[0] = i;
      batcher.push(shared, matrix);
    }
    batcher.flush();
    expect(batches.map((b) => b.reason)).toEqual([
      "colorMatrices",
      "colorMatrices",
      "end",
    ]);
    expect(batches.map((b) => b.quadCount)).toEqual([2, 2, 1]);
    // Each fresh batch re-binds the texture at slot 0 and restarts at matrix 1.
    expect(batches.every((b) => b.textureCount === 1)).toBe(true);
    expect(batches.map((b) => b.matrixSlots)).toEqual([[1, 2], [1, 2], [1]]);
  });

  it("reads a matrix from an offset into a shared arena", () => {
    const arena = new Float32Array([...red, ...green]);
    const { batcher, batches } = harness();
    batcher.push(texture(1), arena, 9);
    batcher.push(texture(1), arena, 0);
    batcher.push(texture(1), arena, 9);
    batcher.flush();
    expect(batches[0].matrixSlots).toEqual([1, 2, 1]);
  });
});

describe("quad batcher instance data", () => {
  it("writes the staging quad verbatim, including a negative flip span", () => {
    const raw: Float32Array[] = [];
    const recorder = createQuadBatcher({
      draw(batch) {
        raw.push(batch.instances.slice(0, batch.quadCount * INSTANCE_FLOATS));
      },
    });
    const quad = recorder.quad;
    quad.x0 = 1;
    quad.y0 = 2;
    quad.x1 = 3;
    quad.y1 = 4;
    quad.x2 = 5;
    quad.y2 = 6;
    quad.x3 = 7;
    quad.y3 = 8;
    quad.u0 = 0.5;
    quad.v0 = 0.25;
    quad.uSpan = -0.5;
    quad.vSpan = 0.125;
    quad.r = 0.1;
    quad.g = 0.2;
    quad.b = 0.3;
    quad.a = 0.4;
    recorder.push(texture(1));
    recorder.flush();
    expect([...raw[0].subarray(0, 8)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([
      ...raw[0].subarray(INSTANCE_UV_OFFSET, INSTANCE_UV_OFFSET + 4),
    ]).toEqual([0.5, 0.25, -0.5, 0.125]);
  });

  it("grows its arena to a frame's high-water mark and then stops", () => {
    const { batcher } = harness({ maxTextureSlots: 2 });
    // ONE texture object throughout, so nothing else can end the batch and the
    // arena is the only thing that has to give.
    const page = texture(0);
    for (let i = 0; i < 2000; i += 1) batcher.push(page);
    const growths = batcher.stats.arenaGrowths;
    expect(growths).toBeGreaterThan(0);
    expect(batcher.quadCount).toBe(2000);
    batcher.flush();
    // The second frame of the same size allocates nothing — the property the
    // whole pooled design exists for.
    for (let i = 0; i < 2000; i += 1) batcher.push(page);
    expect(batcher.stats.arenaGrowths).toBe(growths);
  });
});

describe("quad batcher configuration", () => {
  it("clamps the slot count to the WebGL2 guaranteed minimum", () => {
    expect(
      createQuadBatcher({ draw: () => {}, maxTextureSlots: 999 })
        .maxTextureSlots,
    ).toBe(MAX_TEXTURE_SLOTS);
    expect(
      createQuadBatcher({ draw: () => {}, maxTextureSlots: 0 }).maxTextureSlots,
    ).toBe(1);
  });

  it("reset drops the open batch WITHOUT drawing it", () => {
    const { batcher, batches } = harness();
    batcher.push(texture(1));
    batcher.reset();
    batcher.flush();
    expect(batches).toHaveLength(0);
    expect(batcher.stats.quads).toBe(0);
  });

  it("resets mesh and screen-effect flush diagnostics between frames", () => {
    const { batcher } = harness();
    batcher.push(texture(1));
    batcher.flush("meshes");
    batcher.push(texture(2));
    batcher.flush("effects");
    expect(batcher.stats.flushes.meshes).toBe(1);
    expect(batcher.stats.flushes.effects).toBe(1);
    batcher.reset();
    expect(batcher.stats.flushes.meshes).toBe(0);
    expect(batcher.stats.flushes.effects).toBe(0);
  });
});
