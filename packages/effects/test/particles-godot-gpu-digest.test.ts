import { describe, expect, it } from "vitest";
import { GodotGpuEmitter } from "../src/particles";
import {
  runScenarioDigest,
  SCENARIOS,
  type ScenarioEmitter,
} from "./fixtures/godot-gpu-scenarios";

// Digests of every frame's packed instances, taken from the emitter before its per-particle pass
// was made allocation-free (scratch vectors, resolved material fields, cached spawn values). The
// simulation's output is a contract with the host's GPU (to float precision), so a refactor of
// the pass must keep every bit: a changed digest is a changed simulation, never a re-pin.
const PINNED: Record<string, string> = {
  "ambient-global-moving": "e9b05c94",
  "swirl-turbulence-fixed30-preprocess": "8508f6fa",
  "ring3d-curves-local": "5d002a78",
  "burst-oneshot-restart-request": "4b6d4951",
};

describe("GodotGpuEmitter output is bit-stable", () => {
  for (const s of SCENARIOS)
    it(s.name, () => {
      expect(
        runScenarioDigest(
          s,
          (c) => new GodotGpuEmitter(c) as unknown as ScenarioEmitter,
        ),
      ).toBe(PINNED[s.name]);
    });

  it("a new material object takes effect on the next pass (cached spawn values included)", () => {
    const s = SCENARIOS[0];
    const e = new GodotGpuEmitter(s.config);
    for (let i = 0; i < 30; i++) e.update(1 / 60);
    const twin = new GodotGpuEmitter(s.config);
    for (let i = 0; i < 30; i++) twin.update(1 / 60);
    // A new material object with other uniforms changes the next pass's output.
    e.configure({
      ...s.config,
      material: {
        ...s.config.material,
        uniforms: {
          ...s.config.material.uniforms,
          gravity: [0, 400, 0],
          scale_max: 4,
        },
      },
    });
    twin.configure({ ...s.config });
    e.update(1 / 60);
    twin.update(1 / 60);
    const a = new Float32Array(s.config.amount * 16);
    const b = new Float32Array(s.config.amount * 16);
    e.pack(a);
    twin.pack(b);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});
