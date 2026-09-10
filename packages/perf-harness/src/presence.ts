// The presence guard — the single most important check in this harness.
//
// The #1 failure mode of a rendering benchmark is measuring a BLANK PAGE and reporting excellent
// numbers: no content means no paint, no raster and no decode, which looks like a spectacular win.
// So every run ends with a screenshot that must prove the content is actually on screen, and a run
// whose `sampleHits` is short of the mounted sprite count is reported as a FAILURE, never averaged in.

import sharp from "sharp";

export interface PresenceResult {
  /** Fraction of pixels that differ from the page background. */
  nonEmptyRatio: number;
  /** How many of the expected sprite centres are non-background. */
  sampleHits: number;
  sampleCount: number;
  /** Path the screenshot was written to (set by the runner). */
  screenshot: string;
  ok: boolean;
  misses: { x: number; y: number }[];
  /**
   * How many sample points fell OUTSIDE the CSS viewport entirely.
   *
   * A point off screen and a point on screen but blank are both misses, and they mean opposite
   * things: the first is "the content did not fit the viewport" (a fit/geometry problem), the second
   * is "the content did not render" (a rendering problem). Counting them apart is what lets the
   * failure message name the actual cause instead of always saying "the page rendered nothing".
   */
  outsideViewport: number;
  /** Screenshot dimensions in image px, and the CSS px -> image px scale actually used. */
  imageSize: { width: number; height: number };
  scale: { x: number; y: number };
}

export interface PresenceOptions {
  screenshot: Buffer;
  samplePoints: { x: number; y: number }[];
  devicePixelRatio: number;
  /**
   * The page's own viewport in CSS px. When given, the CSS -> image scale is MEASURED from the
   * screenshot instead of trusting `devicePixelRatio`.
   *
   * This is what makes the presence guard work on a phone. `Page.captureScreenshot` on Android
   * returns the compositor surface, whose size is the physical window — not `viewport × DPR`, and
   * not necessarily the same on both axes. Multiplying CSS sample points by DPR there lands them
   * far outside the image, every sample misses, and the guard reports "the page rendered nothing"
   * on a perfectly good run. Scoring 0 for a measurement bug is the one failure mode a presence
   * guard must not have.
   *
   * The scale is UNIFORM, and it is the SMALLER of the two ratios — a per-axis scale is wrong.
   * Measured on the moto g86 5G (Chrome 151, no emulation): viewport 349x657 CSS px at DPR 3.4876,
   * screenshot 1220x2452, so the ratios are x=3.4957 and y=3.7321. The page did not render taller
   * than it is wide-scaled; the surface is 155 device px TALLER than the content, and the content
   * sits at its TOP-LEFT (proved with a centre marker: it landed at image y=1145, i.e. exactly
   * `657/2 x 3.4957`, not at the image's own centre 1226). Rasterisation is uniform and browser
   * chrome only ever makes the surface BIGGER than the viewport, so the axis with the smaller ratio
   * is the one carrying no chrome, and its ratio is the true scale. Using y here stretched every
   * sample point down the image and cost a perfectly good phone run 24 of its 50 hits.
   */
  cssViewport?: { width: number; height: number };
  /** Page background as [r,g,b]; anything further than `tolerance` from it counts as content. */
  background?: [number, number, number];
  tolerance?: number;
  /** Half-width of the box sampled around each point, in device px (default 2). */
  sampleRadius?: number;
}

export async function checkPresence(
  options: PresenceOptions,
): Promise<Omit<PresenceResult, "screenshot">> {
  const {
    screenshot,
    samplePoints,
    devicePixelRatio,
    cssViewport,
    background = [0x10, 0x10, 0x14],
    tolerance = 12,
    sampleRadius = 2,
  } = options;

  const { data, info } = await sharp(screenshot)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const isContent = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return false;
    }
    const offset = (y * width + x) * channels;
    return (
      Math.abs(data[offset] - background[0]) > tolerance ||
      Math.abs(data[offset + 1] - background[1]) > tolerance ||
      Math.abs(data[offset + 2] - background[2]) > tolerance
    );
  };

  let nonEmpty = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isContent(x, y)) {
        nonEmpty++;
      }
    }
  }

  const ratios: number[] = [];
  if (cssViewport && cssViewport.width > 0) {
    ratios.push(width / cssViewport.width);
  }
  if (cssViewport && cssViewport.height > 0) {
    ratios.push(height / cssViewport.height);
  }
  // One uniform scale, from the axis that is not carrying browser chrome — see `cssViewport` above.
  const uniform = ratios.length > 0 ? Math.min(...ratios) : devicePixelRatio;
  const scale = { x: uniform, y: uniform };

  const misses: { x: number; y: number }[] = [];
  let hits = 0;
  let outsideViewport = 0;
  for (const point of samplePoints) {
    const px = Math.round(point.x * scale.x);
    const py = Math.round(point.y * scale.y);
    // Tested against the CSS VIEWPORT, not the image: on Android the surface is taller than the
    // viewport (browser chrome), so a point past the bottom of the page can still land inside the
    // image. The question this counter answers is "did the content fit the viewport", and the
    // viewport is what has to be measured against.
    if (
      cssViewport
        ? point.x < 0 ||
          point.y < 0 ||
          point.x > cssViewport.width ||
          point.y > cssViewport.height
        : px < 0 || py < 0 || px >= width || py >= height
    ) {
      outsideViewport++;
    }
    let hit = false;
    for (let dy = -sampleRadius; dy <= sampleRadius && !hit; dy++) {
      for (let dx = -sampleRadius; dx <= sampleRadius && !hit; dx++) {
        if (isContent(px + dx, py + dy)) {
          hit = true;
        }
      }
    }
    if (hit) {
      hits++;
    } else {
      misses.push(point);
    }
  }

  return {
    nonEmptyRatio: Math.round((nonEmpty / (width * height)) * 10000) / 10000,
    sampleHits: hits,
    sampleCount: samplePoints.length,
    ok: hits === samplePoints.length && samplePoints.length > 0,
    misses: misses.slice(0, 10),
    outsideViewport,
    imageSize: { width, height },
    scale: {
      x: Math.round(scale.x * 10000) / 10000,
      y: Math.round(scale.y * 10000) / 10000,
    },
  };
}
