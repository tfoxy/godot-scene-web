// The presence guard, and specifically the thing that breaks it on a phone.
//
// `Page.captureScreenshot` on Android returns the compositor surface — the physical window — which is
// NOT `cssViewport × devicePixelRatio`. Scaling the scenario's CSS sample points by DPR there lands
// every one of them outside the image, all 50 samples miss, and the guard reports "this run rendered
// nothing" for a perfectly good render. Scoring 0 because of a measurement bug is the one failure a
// presence guard must not have, so the scale is MEASURED from the screenshot instead.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { fitStage, mapStagePoint } from "../src/fit";
import { checkPresence } from "../src/presence";

const BACKGROUND: [number, number, number] = [0x10, 0x10, 0x14];

/** A PNG of `width × height` image px, painted white in a 9x9 box around each device-px point. */
async function screenshotWith(
  width: number,
  height: number,
  points: { x: number; y: number }[],
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    data[i * channels] = BACKGROUND[0];
    data[i * channels + 1] = BACKGROUND[1];
    data[i * channels + 2] = BACKGROUND[2];
  }
  for (const point of points) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = Math.round(point.x) + dx;
        const y = Math.round(point.y) + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) {
          continue;
        }
        const offset = (y * width + x) * channels;
        data[offset] = 0xff;
        data[offset + 1] = 0xff;
        data[offset + 2] = 0xff;
      }
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

describe("checkPresence", () => {
  it("hits every sample when the screenshot is CSS-sized (the desktop case)", async () => {
    const samplePoints = [
      { x: 64, y: 64 },
      { x: 300, y: 200 },
    ];
    const shot = await screenshotWith(1280, 800, samplePoints);
    const result = await checkPresence({
      screenshot: shot,
      samplePoints,
      devicePixelRatio: 1,
      cssViewport: { width: 1280, height: 800 },
    });
    expect(result.sampleHits).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.scale).toEqual({ x: 1, y: 1 });
  });

  it("MEASURES the scale when the screenshot is not viewport × DPR (the phone case)", async () => {
    // Phone shape: the page lays out at 1280x800 CSS px (emulated), but the surface that comes back
    // is the physical 1080x675 window — a scale of 0.84, and the page still reports DPR 2.625.
    const samplePoints = [
      { x: 64, y: 64 },
      { x: 640, y: 400 },
      { x: 1000, y: 520 },
    ];
    const scale = 1080 / 1280;
    const shot = await screenshotWith(
      1080,
      675,
      samplePoints.map((point) => ({
        x: point.x * scale,
        y: point.y * (675 / 800),
      })),
    );
    const result = await checkPresence({
      screenshot: shot,
      samplePoints,
      devicePixelRatio: 2.625,
      cssViewport: { width: 1280, height: 800 },
    });
    expect(result.sampleHits).toBe(3);
    expect(result.imageSize).toEqual({ width: 1080, height: 675 });
    expect(result.scale.x).toBeCloseTo(0.84, 2);
  });

  it("would have scored 0/3 on that same phone screenshot without the measured scale", async () => {
    // The regression this exists to prevent. Multiplying CSS points by DPR 2.625 puts all three
    // samples far outside a 1080x675 image, and the run gets DISCARDED as "a blank page".
    const samplePoints = [
      { x: 64, y: 64 },
      { x: 640, y: 400 },
      { x: 1000, y: 520 },
    ];
    const scale = 1080 / 1280;
    const shot = await screenshotWith(
      1080,
      675,
      samplePoints.map((point) => ({
        x: point.x * scale,
        y: point.y * (675 / 800),
      })),
    );
    const result = await checkPresence({
      screenshot: shot,
      samplePoints,
      devicePixelRatio: 2.625,
    });
    expect(result.sampleHits).toBe(0);
    expect(result.ok).toBe(false);
  });

  it("still reports a genuinely missing sprite as a miss", async () => {
    // The guard must not become permissive: a point with nothing under it is a real failure.
    const samplePoints = [
      { x: 64, y: 64 },
      { x: 640, y: 400 },
    ];
    const shot = await screenshotWith(1280, 800, [samplePoints[0]]);
    const result = await checkPresence({
      screenshot: shot,
      samplePoints,
      devicePixelRatio: 1,
      cssViewport: { width: 1280, height: 800 },
    });
    expect(result.sampleHits).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.misses).toEqual([{ x: 640, y: 400 }]);
  });
});

describe("presence: content that did not FIT vs content that did not RENDER", () => {
  // Two failures that look identical in a hit count and demand opposite fixes: a sample point off
  // the screen entirely means the stage overflowed the viewport (a geometry problem — the case that
  // motivated the viewport fit), a point on screen with nothing under it means the render failed.
  it("counts the misses that fell OUTSIDE the viewport separately", async () => {
    const onScreen = { x: 100, y: 100 };
    // The unfitted-portrait-phone shape: the grid's right-hand columns land past the viewport edge.
    const offScreen = [
      { x: 700, y: 100 },
      { x: 1000, y: 100 },
    ];
    const shot = await screenshotWith(412, 883, [onScreen]);
    const result = await checkPresence({
      screenshot: shot,
      samplePoints: [onScreen, ...offScreen],
      devicePixelRatio: 1,
      cssViewport: { width: 412, height: 883 },
    });
    expect(result.sampleHits).toBe(1);
    expect(result.outsideViewport).toBe(2);
    expect(result.ok).toBe(false);
  });

  it("reports zero when every point is inside the viewport, hit or miss", async () => {
    const points = [
      { x: 100, y: 100 },
      { x: 300, y: 300 },
    ];
    const shot = await screenshotWith(412, 883, [points[0]]);
    const result = await checkPresence({
      screenshot: shot,
      samplePoints: points,
      devicePixelRatio: 1,
      cssViewport: { width: 412, height: 883 },
    });
    expect(result.sampleHits).toBe(1);
    // Missed, but ON screen: a rendering failure, not a fit failure.
    expect(result.outsideViewport).toBe(0);
  });

  it("a FITTED portrait run puts every mapped point inside the image", async () => {
    // End-to-end of the fix, in the guard's own terms: stage-space points mapped through the fit
    // land inside a phone-sized screenshot, and all of them hit.
    const fit = fitStage(
      { width: 1064, height: 544 },
      { width: 412, height: 883 },
    );
    const stagePoints = [
      { x: 64, y: 64 },
      { x: 1000, y: 500 },
      { x: 532, y: 272 },
    ];
    const mapped = stagePoints.map((point) => mapStagePoint(point, fit));
    // The phone's screenshot is the physical window: 412 CSS px at DPR 2.625.
    const shot = await screenshotWith(
      1082,
      2318,
      mapped.map((point) => ({
        x: point.x * (1082 / 412),
        y: point.y * (2318 / 883),
      })),
    );
    const result = await checkPresence({
      screenshot: shot,
      samplePoints: mapped,
      devicePixelRatio: 2.625,
      cssViewport: { width: 412, height: 883 },
    });
    expect(result.outsideViewport).toBe(0);
    expect(result.sampleHits).toBe(3);
    expect(result.ok).toBe(true);
  });
});
