import { describe, expect, it, vi } from "vitest";
import { BatchableSprite, InstructionSet, Matrix, Texture } from "pixi.js";
import { MatrixBatcher, MatrixSprite } from "../src/pixi-color-batch";

function element(matrix?: readonly number[]): BatchableSprite {
  const sprite = new MatrixSprite(Texture.WHITE);
  sprite.width = 8; sprite.height = 6;
  if (matrix) sprite.setInlineMatrix(true, matrix);
  const gpu = new BatchableSprite();
  gpu.renderable = sprite;
  gpu.transform = new Matrix();
  gpu.texture = sprite.texture;
  gpu.bounds = sprite.visualBounds;
  return gpu;
}

describe("Pixi inline color batch", () => {
  it("packs different per-element matrices into one real Pixi batch", () => {
    const a = element([0,1,0, 1,0,0, 0,0,1]);
    const b = element([.5,0,0, 0,.7,0, 0,0,.9]);
    const batcher = new MatrixBatcher({ maxTextures: 4 });
    const instructions = new InstructionSet();
    batcher.begin(); batcher.add(a); batcher.add(b); batcher.finish(instructions);
    expect(instructions.instructionSize).toBe(1);
    expect(batcher.batches[0].elements).toHaveLength(2);
    const data = batcher.attributeBuffer.float32View;
    expect(Array.from(data.slice(6,15))).toEqual([0,1,0,1,0,0,0,0,1]);
    const second = Array.from(data.slice(4*15+6,4*15+15));
    for (const [index, expected] of [.5,0,0,0,.7,0,0,0,.9].entries())
      expect(second[index]).toBeCloseTo(expected);
    expect(batcher.geometry.getAttribute("aMatrix2").stride).toBe(60);
    batcher.destroy(); a.renderable.destroy(); b.renderable.destroy();
  });

  it("owns shader revisions and rejects invalid coefficients", () => {
    const sprite = new MatrixSprite(Texture.WHITE);
    sprite.setInlineMatrix(true, [1,0,0, 0,1,0, 0,0,1]);
    const batcher = new MatrixBatcher({ maxTextures: 4 });
    const original = batcher.shader;
    const destroyOriginal = vi.spyOn(original, "destroy");
    batcher._updateMaxTextures(4);
    expect(batcher.shader).toBe(original);
    batcher._updateMaxTextures(2);
    expect(destroyOriginal).toHaveBeenCalledOnce();
    const replacement = batcher.shader;
    const destroyReplacement = vi.spyOn(replacement, "destroy");
    batcher.destroy();
    batcher.destroy();
    expect(destroyReplacement).toHaveBeenCalledOnce();
    expect(() => sprite.setInlineMatrix(true, [NaN,0,0,0,1,0,0,0,1])).toThrow("invalid inline color matrix");
    sprite.destroy();
  });
});
