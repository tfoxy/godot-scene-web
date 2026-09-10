import pixelmatch from "pixelmatch";
import sharp from "sharp";

import type {
  ChannelDelta,
  ImageDiffMode,
  ImageDiffOptions,
  ImageDiffRegion,
  ImageDiffResult,
} from "./image-diff-types";

export type {
  ChannelDelta,
  ImageDiffMode,
  ImageDiffOptions,
  ImageDiffRegion,
  ImageDiffResult,
} from "./image-diff-types";

const CHANNEL_NAMES = ["r", "g", "b", "a"] as const;

/** A one-line, paste-into-a-report summary of a `ChannelDelta`. */
export function describeChannelDelta(delta: ChannelDelta): string {
  if (!delta.worst) {
    return `max per-channel delta 0 (byte-identical), budget ${delta.budget}`;
  }
  const { x, y, channel, expected, actual } = delta.worst;
  return (
    `max per-channel delta ${delta.max} (budget ${delta.budget}) at (${x}, ${y}).` +
    `${CHANNEL_NAMES[channel]}: ${expected} vs ${actual}; ` +
    `${delta.overBudgetPixels} px over budget, ${delta.differingPixels} px not byte-identical`
  );
}

/**
 * `max |expected - actual|` over every byte, plus where it was found. Both buffers must already be
 * in the SAME alpha space — this does not convert, and comparing straight against premultiplied
 * would report the conversion rather than the renderers.
 */
export function channelDelta(
  expected: Uint8Array,
  actual: Uint8Array,
  width: number,
  budget: number,
): ChannelDelta {
  let max = 0;
  let worst: ChannelDelta["worst"];
  let overBudgetPixels = 0;
  let differingPixels = 0;
  for (let index = 0; index + 3 < expected.length; index += 4) {
    let pixelMax = 0;
    let pixelChannel = 0;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(
        expected[index + channel] - actual[index + channel],
      );
      if (delta > pixelMax) {
        pixelMax = delta;
        pixelChannel = channel;
      }
    }
    if (pixelMax === 0) continue;
    differingPixels++;
    if (pixelMax > budget) overBudgetPixels++;
    if (pixelMax > max) {
      max = pixelMax;
      const pixel = index / 4;
      worst = {
        x: width > 0 ? pixel % width : pixel,
        y: width > 0 ? Math.floor(pixel / width) : 0,
        channel: pixelChannel,
        expected: expected[index + pixelChannel],
        actual: actual[index + pixelChannel],
      };
    }
  }
  return { max, budget, overBudgetPixels, differingPixels, worst };
}

export async function comparePngScreenshots(
  expectedPath: string,
  actualPath: string,
  options: ImageDiffOptions = {},
): Promise<ImageDiffResult> {
  const threshold = options.threshold ?? 0.12;
  const maxDiffRatio = options.maxDiffRatio ?? 0.01;
  const mode = options.mode ?? "full";
  const expected = await readImageSize(expectedPath);
  const actual = await readImageSize(actualPath);
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      ok: false,
      mode,
      threshold,
      maxDiffRatio,
      region: options.region,
      expectedSize: { width: expected.width, height: expected.height },
      actualSize: { width: actual.width, height: actual.height },
      reason: "dimension-mismatch",
    };
  }

  const region = options.region ?? {
    x: 0,
    y: 0,
    width: expected.width,
    height: expected.height,
  };
  const expectedRegion = await readRegionRgba(expectedPath, region);
  const actualRegion = await readRegionRgba(actualPath, region);
  const diff = options.diffPath
    ? Buffer.alloc(region.width * region.height * 4)
    : undefined;
  const diffPixels = pixelmatch(
    expectedRegion,
    actualRegion,
    diff,
    region.width,
    region.height,
    { threshold },
  );
  if (options.diffPath && diff) {
    await sharp(diff, {
      raw: { width: region.width, height: region.height, channels: 4 },
    })
      .png()
      .toFile(options.diffPath);
  }
  const totalPixels = region.width * region.height;
  const diffRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  return {
    ok: diffRatio <= maxDiffRatio,
    mode,
    threshold,
    maxDiffRatio,
    region,
    width: region.width,
    height: region.height,
    diffPixels,
    totalPixels,
    diffRatio,
    diffPath: options.diffPath,
    reason: diffRatio <= maxDiffRatio ? undefined : "pixel-mismatch",
  };
}

export interface RgbaDiffOptions {
  width: number;
  height: number;
  threshold?: number;
  maxDiffRatio?: number;
  /** The per-channel byte allowance (see `ChannelDelta`). Defaults to 255 — i.e. reported but not
   *  enforced — so an existing caller that only asked for a pixelmatch ratio keeps its verdict. */
  maxChannelDelta?: number;
  diffPath?: string;
  mode?: ImageDiffMode;
}

/**
 * The same comparison as `comparePngScreenshots`, against RAW top-down RGBA already in memory.
 *
 * WHY A SIBLING RATHER THAN A PNG ROUND-TRIP. The WebGL↔WebGPU parity harness
 * (`./webgpu-parity/`) reads its two sides straight out of the page — `getImageData` on the
 * WebGL side, a `copyTextureToBuffer` readback on the WebGPU side — so both arrive as byte
 * arrays. Encoding each to a PNG file only to have `sharp` decode it again would add an
 * encoder to the comparison path, and PNG's own colour handling is exactly the kind of thing
 * that would show up as a "renderer difference".
 *
 * The PNGs this writes are ARTIFACTS, not inputs: the optional `diffPath` gets pixelmatch's
 * highlight image so a failure is reviewable. The images being compared are written by the
 * caller, beside it.
 *
 * Both buffers must be PREMULTIPLIED (or both straight) — this function does not convert. A
 * fully transparent pixel carries no colour, so comparing straight-alpha bytes there compares
 * whatever the two renderers happened to leave behind.
 *
 * TWO VERDICTS, NOT ONE. `diffRatio` is pixelmatch's perceptual answer and `channelDelta` is the
 * raw one (see `ChannelDelta` for why neither replaces the other); `ok` requires BOTH to be within
 * their budgets. The second was added after the first reported "zero differing pixels" for a
 * particle path that was compositing at `a²` — a whole factor of alpha at partial coverage scores
 * under a perceptual threshold, because blending onto white by that same alpha is step one of the
 * comparison.
 */
export async function compareRgbaBuffers(
  expected: Uint8Array,
  actual: Uint8Array,
  options: RgbaDiffOptions,
): Promise<ImageDiffResult> {
  const { width, height } = options;
  const threshold = options.threshold ?? 0.12;
  const maxDiffRatio = options.maxDiffRatio ?? 0.01;
  const maxChannelDelta = options.maxChannelDelta ?? 255;
  const mode = options.mode ?? "full";
  const region: ImageDiffRegion = { x: 0, y: 0, width, height };
  const wanted = width * height * 4;
  if (expected.length !== wanted || actual.length !== wanted) {
    // A short buffer is a dimension disagreement, reported in the same shape a PNG size
    // mismatch is — with the implied height, so the message says which side is wrong.
    return {
      ok: false,
      mode,
      threshold,
      maxDiffRatio,
      region,
      expectedSize: impliedSize(expected.length, width, height),
      actualSize: impliedSize(actual.length, width, height),
      reason: "dimension-mismatch",
    };
  }

  const diff = options.diffPath ? Buffer.alloc(wanted) : undefined;
  const diffPixels = pixelmatch(expected, actual, diff, width, height, {
    threshold,
  });
  if (options.diffPath && diff) {
    await sharp(diff, { raw: { width, height, channels: 4 } })
      .png()
      .toFile(options.diffPath);
  }
  const totalPixels = width * height;
  const diffRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  const delta = channelDelta(expected, actual, width, maxChannelDelta);
  const ratioOk = diffRatio <= maxDiffRatio;
  const deltaOk = delta.max <= maxChannelDelta;
  return {
    ok: ratioOk && deltaOk,
    mode,
    threshold,
    maxDiffRatio,
    region,
    width,
    height,
    diffPixels,
    totalPixels,
    diffRatio,
    diffPath: options.diffPath,
    channelDelta: delta,
    // The RATIO's verdict is reported first when both fail: it is the coarser statement, and a
    // failure that moved whole pixels has usually also moved a channel.
    reason: ratioOk
      ? deltaOk
        ? undefined
        : "channel-delta"
      : "pixel-mismatch",
  };
}

/** The size a buffer of `length` bytes would have at the declared width — for the error report. */
function impliedSize(
  length: number,
  width: number,
  height: number,
): { width: number; height: number } {
  if (width <= 0) {
    return { width, height };
  }
  return { width, height: length / 4 / width };
}

async function readImageSize(
  path: string,
): Promise<{ width: number; height: number }> {
  const { width, height } = await sharp(path).metadata();
  if (width === undefined || height === undefined) {
    throw new Error(`Unable to read image dimensions for ${path}`);
  }
  return { width, height };
}

async function readRegionRgba(
  path: string,
  region: ImageDiffRegion,
): Promise<Buffer> {
  return sharp(path)
    .extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    })
    .ensureAlpha()
    .raw()
    .toBuffer();
}
