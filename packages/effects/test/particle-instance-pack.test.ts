import { describe, expect, it } from "vitest";
import {
  InstanceBuffer,
  type ParticleRenderConfig,
  type ParticleSystemState,
  packParticleInstances,
} from "../src/particles";

const config = { hframes: 2, vframes: 4, flipbookCropOnly: false } as Pick<
  ParticleRenderConfig,
  "hframes" | "vframes" | "flipbookCropOnly"
>;
const state = {
  particles: [
    {
      active: true,
      x: 2,
      y: 4,
      scaleX: 2,
      scaleY: -1,
      rotation: 0.5,
      r: 0.2,
      g: 0.3,
      b: 0.4,
      a: 0.5,
      frame: 7,
    },
    {
      active: false,
      x: 9,
      y: 9,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      r: 1,
      g: 1,
      b: 1,
      a: 1,
      frame: 0,
    },
    {
      active: true,
      x: 1,
      y: 1,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      r: 1,
      g: 1,
      b: 1,
      a: 0,
      frame: 0,
    },
  ],
} as unknown as ParticleSystemState;

describe("packParticleInstances", () => {
  it("filters inactive/transparent particles and packs crop, transform, origin, and modulation", () => {
    const instances = new InstanceBuffer(1);
    expect(
      packParticleInstances({
        state,
        config,
        instances,
        textureWidth: 20,
        textureHeight: 40,
        origin: [10, 20],
        transform: {
          xx: 2,
          xy: 0,
          yx: 0,
          yy: 3,
          originX: 7,
          originY: 11,
          scale: 2,
          rotation: 1,
        },
        modulate: [0.5, 2, 0.25, 0.5],
      }),
    ).toBe(1);
    expect([...instances.data.slice(0, 5)]).toEqual([31, 83, 40, 0, 1.5]);
    expect(instances.data[5]).toBeCloseTo(0.1);
    expect(instances.data[6]).toBeCloseTo(0.6);
    expect(instances.data[7]).toBeCloseTo(0.1);
    expect(instances.data[8]).toBeCloseTo(0.25);
    expect(instances.data[9]).toBe(7);
  });

  it("resets and reuses the supplied buffer", () => {
    const instances = new InstanceBuffer(4);
    packParticleInstances({
      state,
      config: { ...config, flipbookCropOnly: true },
      instances,
      textureWidth: 20,
      textureHeight: 40,
    });
    expect(instances.count).toBe(1);
    expect([...instances.data.slice(0, 5)]).toEqual([2, 4, 40, 0, 0.5]);
  });
});
