import { describe, expect, it } from "vitest";
import { createEaseSampler, godotEaseSample } from "../src/easing/numeric";

describe("numeric Godot easing", () => {
  it("keeps exact endpoints for every named family", () => {
    for (const transition of [
      "Linear",
      "Sine",
      "Quint",
      "Quart",
      "Quad",
      "Expo",
      "Elastic",
      "Cubic",
      "Circ",
      "Bounce",
      "Back",
      "Spring",
    ]) {
      for (const ease of ["In", "Out", "InOut", "OutIn"]) {
        expect(godotEaseSample(transition, ease, 0)).toBe(0);
        expect(godotEaseSample(transition, ease, 1)).toBe(1);
      }
    }
  });

  it("normalizes wire names while preserving the curve", () => {
    expect(createEaseSampler("ease_in_out", "TRANS_QUAD")(0.25)).toBe(
      godotEaseSample("Quad", "InOut", 0.25),
    );
  });
});
