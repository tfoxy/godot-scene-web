export interface ImageDiffOptions {
  threshold?: number;
  maxDiffRatio?: number;
  diffPath?: string;
  mode?: ImageDiffMode;
  region?: ImageDiffRegion;
}

export type ImageDiffMode = "full" | "node" | "text-runs";

export interface ImageDiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageDiffResult {
  ok: boolean;
  mode: ImageDiffMode;
  threshold: number;
  maxDiffRatio: number;
  region?: ImageDiffRegion;
  width?: number;
  height?: number;
  expectedSize?: { width: number; height: number };
  actualSize?: { width: number; height: number };
  diffPixels?: number;
  totalPixels?: number;
  diffRatio?: number;
  diffPath?: string;
  reason?: "dimension-mismatch" | "pixel-mismatch" | "channel-delta";
  /** See `ChannelDelta` — present only on the raw-RGBA comparison, which is the only caller that
   *  can promise both sides are in the same alpha space. */
  channelDelta?: ChannelDelta;
}

/**
 * The THRESHOLD-INDEPENDENT half of a raw-RGBA comparison: the largest single-channel byte
 * disagreement anywhere in the two buffers, where it is, and how many pixels carry one.
 *
 * WHY IT SITS BESIDE PIXELMATCH RATHER THAN INSTEAD OF IT. Pixelmatch answers "would a human notice
 * this?" — it converts to YIQ, weights the channels perceptually, BLENDS semi-transparent pixels
 * onto white by their own alpha, and compares the result against `35215 · threshold²`. Every one of
 * those steps is the right thing for a screenshot diff and the wrong thing for an alpha-algebra bug:
 * blending by alpha before comparing is precisely how a factor of alpha hides, and squaring the
 * threshold makes the cutoff coarse where it matters (0.12 ⇒ maxDelta ≈ 507, which a whole
 * missing/extra multiply at partial coverage fits comfortably under).
 *
 * This metric makes no perceptual claim at all. It is `max |a[i] - b[i]|` over every byte, alpha
 * included, in whatever space the caller handed in — so it cannot be tuned into agreeing, and it is
 * what caught a MIX particle path compositing at `a²` while reporting zero differing pixels.
 *
 * `worst` is reported because "202" without a coordinate is not actionable; the channel index says
 * whether the disagreement is in colour or in coverage, which is usually the whole diagnosis.
 */
export interface ChannelDelta {
  /** `max |expected[i] - actual[i]|` over every byte of both buffers. */
  max: number;
  /** The allowance this run was held to (`RgbaDiffOptions.maxChannelDelta`). */
  budget: number;
  /** Pixels with at least one channel over `budget`. Zero whenever `max <= budget`. */
  overBudgetPixels: number;
  /** Pixels that are not byte-identical. Reported, never asserted: two rasterizers are entitled to
   *  disagree by a byte on an edge sample, and this is the number that says how much of the image
   *  that covers when `max` is small. */
  differingPixels: number;
  /** Where `max` was found. Absent only when the buffers are byte-identical. */
  worst?: {
    x: number;
    y: number;
    /** 0=R, 1=G, 2=B, 3=A. */
    channel: number;
    expected: number;
    actual: number;
  };
}

/** Channel names for a readable failure message. */
