import { describe, expect, it } from "vitest";
import {
  bakeGradient,
  bakeNoise,
  bakeTexture,
  type GradientBakeSpec,
  type NoiseBakeSpec,
} from "../src/webgl/bake-texture";

// The doom_bar material's GradientTexture1D (3-stop purple ramp).
const DOOM_GRADIENT: GradientBakeSpec = {
  kind: "gradient",
  width: 256,
  stops: [
    { offset: 0, color: [0.300863, 0.162626, 0.528347, 1] },
    { offset: 0.514583, color: [0.513726, 0.254902, 0.505882, 1] },
    { offset: 1, color: [0.354657, 0.0421873, 0.437114, 1] },
  ],
};

// The doom_bar material's NoiseTexture2D / FastNoiseLite (Perlin FBM), shrunk for
// the test (the real texture is 512×512).
const DOOM_NOISE: NoiseBakeSpec = {
  kind: "noise",
  width: 48,
  height: 48,
  seamless: false,
  noiseType: 3,
  frequency: 0.0383,
  fractalType: 1,
  octaves: 5,
  lacunarity: 2,
  gain: 0.5,
  seed: 0,
};

function rgba(
  px: { data: Uint8ClampedArray },
  x: number,
): [number, number, number, number] {
  const i = x * 4;
  return [px.data[i], px.data[i + 1], px.data[i + 2], px.data[i + 3]];
}

describe("bakeGradient", () => {
  const out = bakeGradient(DOOM_GRADIENT);

  it("is a width×1 RGBA ramp", () => {
    expect(out.width).toBe(256);
    expect(out.height).toBe(1);
    expect(out.data.length).toBe(256 * 4);
  });

  it("hits the stop colors at their offsets (linear interpolation)", () => {
    // Endpoints are the first/last stop exactly.
    expect(rgba(out, 0)).toEqual([77, 41, 135, 255]);
    expect(rgba(out, 255)).toEqual([90, 11, 111, 255]);
    // Middle stop at offset 0.5146 -> x ≈ round(0.514583 * 255) = 131.
    const mid = rgba(out, Math.round(0.514583 * 255));
    expect(mid[0]).toBeGreaterThanOrEqual(129);
    expect(mid[0]).toBeLessThanOrEqual(132); // ~0.5137 * 255
    expect(mid[3]).toBe(255);
  });

  it("dispatches through bakeTexture", () => {
    expect(bakeTexture(DOOM_GRADIENT).data).toEqual(out.data);
  });
});

describe("bakeNoise", () => {
  it("is deterministic for a fixed spec", () => {
    const a = bakeNoise(DOOM_NOISE);
    const b = bakeNoise(DOOM_NOISE);
    expect(a.width).toBe(48);
    expect(a.height).toBe(48);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("produces a varying, finite, opaque grayscale field", () => {
    const out = bakeNoise(DOOM_NOISE);
    const seen = new Set<number>();
    let sum = 0;
    for (let p = 0; p < out.width * out.height; p += 1) {
      const i = p * 4;
      // Grayscale: R == G == B.
      expect(out.data[i]).toBe(out.data[i + 1]);
      expect(out.data[i]).toBe(out.data[i + 2]);
      expect(out.data[i + 3]).toBe(255); // opaque
      seen.add(out.data[i]);
      sum += out.data[i];
    }
    expect(seen.size).toBeGreaterThan(8); // not flat
    const mean = sum / (out.width * out.height);
    expect(mean).toBeGreaterThan(60); // remapped to ~mid-range, not pinned to an edge
    expect(mean).toBeLessThan(195);
  });

  it("changes with the seed", () => {
    const a = bakeNoise(DOOM_NOISE);
    const b = bakeNoise({ ...DOOM_NOISE, seed: 7 });
    expect(Array.from(a.data)).not.toEqual(Array.from(b.data));
  });
});
