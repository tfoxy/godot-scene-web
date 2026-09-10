import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  channelDelta,
  comparePngScreenshots,
  compareRgbaBuffers,
  describeChannelDelta,
} from "../src/image-diff";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("comparePngScreenshots", () => {
  it("passes matching images and writes a diff artifact", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "godot-scene-web-image-diff-"));
    const expected = join(tempDir, "expected.png");
    const actual = join(tempDir, "actual.png");
    const diff = join(tempDir, "diff.png");
    await writePng(expected, 2, 2, [255, 0, 0, 255]);
    await writePng(actual, 2, 2, [255, 0, 0, 255]);

    const result = await comparePngScreenshots(expected, actual, {
      diffPath: diff,
    });

    expect(result.ok).toBe(true);
    expect(result.diffPixels).toBe(0);
    await expect(readFile(diff)).resolves.toBeInstanceOf(Buffer);
  });

  it("fails when the changed pixel ratio exceeds the limit", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "godot-scene-web-image-diff-"));
    const expected = join(tempDir, "expected.png");
    const actual = join(tempDir, "actual.png");
    await writePng(expected, 2, 2, [255, 0, 0, 255]);
    await writePng(actual, 2, 2, [0, 0, 255, 255]);

    const result = await comparePngScreenshots(expected, actual, {
      threshold: 0.01,
      maxDiffRatio: 0.1,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("pixel-mismatch");
    expect(result.diffRatio).toBe(1);
  });

  it("fails the same mismatch in a tight region that passes in a full image", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "godot-scene-web-image-diff-"));
    const expected = join(tempDir, "expected.png");
    const actual = join(tempDir, "actual.png");
    await writePng(expected, 100, 100, [128, 128, 128, 255]);
    await writePng(
      actual,
      100,
      100,
      [128, 128, 128, 255],
      [{ x: 50, y: 50, color: [0, 0, 0, 255] }],
    );

    const fullResult = await comparePngScreenshots(expected, actual, {
      maxDiffRatio: 0.001,
    });
    const regionResult = await comparePngScreenshots(expected, actual, {
      maxDiffRatio: 0.001,
      mode: "text-runs",
      region: { x: 50, y: 50, width: 1, height: 1 },
    });

    expect(fullResult.ok).toBe(true);
    expect(fullResult.mode).toBe("full");
    expect(fullResult.region).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(regionResult.ok).toBe(false);
    expect(regionResult.mode).toBe("text-runs");
    expect(regionResult.region).toEqual({ x: 50, y: 50, width: 1, height: 1 });
    expect(regionResult.diffRatio).toBe(1);
  });

  it("writes a cropped diff artifact for region comparisons", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "godot-scene-web-image-diff-"));
    const expected = join(tempDir, "expected.png");
    const actual = join(tempDir, "actual.png");
    const diff = join(tempDir, "diff.png");
    await writePng(expected, 10, 10, [255, 255, 255, 255]);
    await writePng(
      actual,
      10,
      10,
      [255, 255, 255, 255],
      [{ x: 5, y: 6, color: [0, 0, 0, 255] }],
    );

    const result = await comparePngScreenshots(expected, actual, {
      diffPath: diff,
      region: { x: 4, y: 5, width: 3, height: 4 },
    });
    const diffSize = await sharp(diff).metadata();

    expect(result.totalPixels).toBe(12);
    expect(diffSize.width).toBe(3);
    expect(diffSize.height).toBe(4);
  });

  it("fails dimension mismatches", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "godot-scene-web-image-diff-"));
    const expected = join(tempDir, "expected.png");
    const actual = join(tempDir, "actual.png");
    await writePng(expected, 2, 2, [255, 0, 0, 255]);
    await writePng(actual, 3, 2, [255, 0, 0, 255]);

    const result = await comparePngScreenshots(expected, actual);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dimension-mismatch");
    expect(result.expectedSize).toEqual({ width: 2, height: 2 });
    expect(result.actualSize).toEqual({ width: 3, height: 2 });
  });
});

describe("compareRgbaBuffers", () => {
  it("passes identical buffers and writes a diff artifact", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "godot-scene-web-rgba-diff-"));
    const diff = join(tempDir, "diff.png");
    const expected = solidRgba(4, 4, [12, 200, 90, 255]);
    const actual = solidRgba(4, 4, [12, 200, 90, 255]);

    const result = await compareRgbaBuffers(expected, actual, {
      width: 4,
      height: 4,
      diffPath: diff,
    });
    const diffSize = await sharp(diff).metadata();

    expect(result.ok).toBe(true);
    expect(result.diffPixels).toBe(0);
    expect(result.diffRatio).toBe(0);
    expect(result.totalPixels).toBe(16);
    expect(diffSize.width).toBe(4);
    expect(diffSize.height).toBe(4);
  });

  it("passes a difference inside the ratio budget and fails the same one outside it", async () => {
    const expected = solidRgba(10, 10, [255, 255, 255, 255]);
    const actual = solidRgba(10, 10, [255, 255, 255, 255]);
    // Two of a hundred pixels: 0.02 exactly.
    for (const pixel of [0, 1]) {
      actual.set([0, 0, 0, 255], pixel * 4);
    }

    const inside = await compareRgbaBuffers(expected, actual, {
      width: 10,
      height: 10,
      maxDiffRatio: 0.02,
    });
    const outside = await compareRgbaBuffers(expected, actual, {
      width: 10,
      height: 10,
      maxDiffRatio: 0.01,
    });

    expect(inside.ok).toBe(true);
    expect(inside.diffPixels).toBe(2);
    expect(inside.diffRatio).toBeCloseTo(0.02, 10);
    expect(outside.ok).toBe(false);
    expect(outside.reason).toBe("pixel-mismatch");
  });

  it("reports a buffer of the wrong length as a dimension mismatch instead of comparing it", async () => {
    const expected = solidRgba(4, 4, [1, 2, 3, 255]);
    const actual = solidRgba(4, 3, [1, 2, 3, 255]);

    const result = await compareRgbaBuffers(expected, actual, {
      width: 4,
      height: 4,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dimension-mismatch");
    expect(result.expectedSize).toEqual({ width: 4, height: 4 });
    expect(result.actualSize).toEqual({ width: 4, height: 3 });
  });

  it("keeps pixelmatch's threshold meaningful: a small channel shift passes loose and fails tight", async () => {
    const expected = solidRgba(8, 8, [120, 120, 120, 255]);
    const actual = solidRgba(8, 8, [126, 120, 120, 255]);

    const loose = await compareRgbaBuffers(expected, actual, {
      width: 8,
      height: 8,
      threshold: 0.12,
      maxDiffRatio: 0,
    });
    const tight = await compareRgbaBuffers(expected, actual, {
      width: 8,
      height: 8,
      threshold: 0,
      maxDiffRatio: 0,
    });

    expect(loose.ok).toBe(true);
    expect(loose.diffPixels).toBe(0);
    expect(tight.ok).toBe(false);
    expect(tight.diffPixels).toBe(64);
  });
});

/**
 * THE METRIC THAT DOES NOT BLEND BEFORE IT COMPARES.
 *
 * The case that motivated it is reproduced literally below: a premultiplied buffer whose colour has
 * been multiplied by alpha ONE MORE TIME than it should — the shape of a straight-alpha canvas that
 * is fed premultiplied content, which the shipped WebGL particle MIX path did. Pixelmatch calls it
 * zero at the parity suite's own threshold; the channel metric calls it what it is.
 */
describe("channelDelta — the threshold-independent verdict", () => {
  /** `(c·a, a)` — what a correct premultiplied frame holds for colour `c` at coverage `a`. */
  function premultiplied(
    width: number,
    height: number,
    rgb: [number, number, number],
    alpha: number,
    extraMultiplies = 0,
  ): Uint8Array {
    const a = alpha / 255;
    const factor = a * a ** extraMultiplies;
    return solidRgba(width, height, [
      Math.round(rgb[0] * factor),
      Math.round(rgb[1] * factor),
      Math.round(rgb[2] * factor),
      alpha,
    ]);
  }

  it("is zero, with no worst pixel, on byte-identical buffers", () => {
    const buffer = premultiplied(4, 4, [200, 100, 50], 128);
    const delta = channelDelta(buffer, buffer.slice(), 4, 0);
    expect(delta.max).toBe(0);
    expect(delta.differingPixels).toBe(0);
    expect(delta.overBudgetPixels).toBe(0);
    expect(delta.worst).toBeUndefined();
    expect(describeChannelDelta(delta)).toContain("byte-identical");
  });

  it("names the worst byte: its coordinate, its channel and both values", () => {
    const expected = solidRgba(3, 2, [10, 20, 30, 255]);
    const actual = solidRgba(3, 2, [10, 20, 30, 255]);
    // Pixel index 4 = (x 1, y 1); channel 2 = blue.
    actual[4 * 4 + 2] = 95;
    const delta = channelDelta(expected, actual, 3, 0);
    expect(delta.max).toBe(65);
    expect(delta.worst).toEqual({
      x: 1,
      y: 1,
      channel: 2,
      expected: 30,
      actual: 95,
    });
    expect(delta.differingPixels).toBe(1);
    expect(delta.overBudgetPixels).toBe(1);
    expect(describeChannelDelta(delta)).toContain("at (1, 1).b: 30 vs 95");
  });

  it("counts pixels over the budget separately from pixels that merely differ", () => {
    const expected = solidRgba(4, 1, [100, 100, 100, 255]);
    const actual = new Uint8Array(expected);
    actual[0] = 101; // +1  — differs, within budget
    actual[4] = 102; // +2  — differs, within budget
    actual[8] = 140; // +40 — over budget
    const delta = channelDelta(expected, actual, 4, 2);
    expect(delta.max).toBe(40);
    expect(delta.differingPixels).toBe(3);
    expect(delta.overBudgetPixels).toBe(1);
  });

  it("catches a DOUBLE-PREMULTIPLIED frame that pixelmatch scores as zero", async () => {
    // Mid-grey at 50% coverage, and the same pixel multiplied by alpha once too often — the exact
    // failure a straight-alpha canvas holding premultiplied content produces on the way out.
    const correct = premultiplied(32, 32, [200, 200, 200], 128);
    const doubled = premultiplied(32, 32, [200, 200, 200], 128, 1);

    const result = await compareRgbaBuffers(correct, doubled, {
      width: 32,
      height: 32,
      // The shipped parity threshold and a budget that tolerates nothing: pixelmatch STILL says the
      // two images are identical, because step one of its comparison is blending each pixel onto
      // white by its own alpha — the very factor that went missing.
      threshold: 0.12,
      maxDiffRatio: 0,
      maxChannelDelta: 2,
    });

    expect(result.diffPixels).toBe(0);
    expect(result.diffRatio).toBe(0);
    // …and the per-channel verdict is unambiguous: 100 vs 50 on every colour channel.
    expect(result.channelDelta?.max).toBe(50);
    expect(result.channelDelta?.differingPixels).toBe(32 * 32);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("channel-delta");
  });

  it("reports the delta but keeps the old verdict when no budget is given", async () => {
    const correct = premultiplied(8, 8, [200, 200, 200], 128);
    const doubled = premultiplied(8, 8, [200, 200, 200], 128, 1);
    const result = await compareRgbaBuffers(correct, doubled, {
      width: 8,
      height: 8,
      threshold: 0.12,
      maxDiffRatio: 0,
    });
    expect(result.channelDelta?.max).toBe(50);
    expect(result.ok).toBe(true);
  });
});

function solidRgba(
  width: number,
  height: number,
  color: [number, number, number, number],
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data.set(color, index);
  }
  return data;
}

async function writePng(
  path: string,
  width: number,
  height: number,
  color: [number, number, number, number],
  pixels: {
    x: number;
    y: number;
    color: [number, number, number, number];
  }[] = [],
): Promise<void> {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = color[0];
    data[index + 1] = color[1];
    data[index + 2] = color[2];
    data[index + 3] = color[3];
  }
  for (const pixel of pixels) {
    const index = (pixel.y * width + pixel.x) * 4;
    data[index] = pixel.color[0];
    data[index + 1] = pixel.color[1];
    data[index + 2] = pixel.color[2];
    data[index + 3] = pixel.color[3];
  }
  await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(path);
}
