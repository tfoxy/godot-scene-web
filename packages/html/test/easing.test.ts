import { describe, expect, it } from "vitest";
import { ELASTIC_OUT_LINEAR, godotEasingToCss } from "../src/easing";

describe("godotEasingToCss", () => {
  it("maps expo per direction", () => {
    expect(godotEasingToCss("Out", "Expo")).toBe("cubic-bezier(0.19, 1, 0.22, 1)");
    expect(godotEasingToCss("In", "Expo")).toBe("cubic-bezier(0.95, 0.05, 0.795, 0.035)");
    expect(godotEasingToCss("InOut", "Expo")).toBe("cubic-bezier(1, 0, 0, 1)");
  });

  it("maps back per direction", () => {
    expect(godotEasingToCss("Out", "Back")).toBe("cubic-bezier(0.34, 1.56, 0.64, 1)");
    expect(godotEasingToCss("In", "Back")).toBe("cubic-bezier(0.36, 0, 0.66, -0.56)");
    expect(godotEasingToCss("InOut", "Back")).toBe("cubic-bezier(0.68, -0.6, 0.32, 1.6)");
  });

  it("maps elastic-out to the linear() oscillation and other elastic dirs to a bezier", () => {
    expect(godotEasingToCss("Out", "Elastic")).toBe(ELASTIC_OUT_LINEAR);
    expect(godotEasingToCss("In", "Elastic")).toBe("cubic-bezier(0.68, -0.6, 0.32, 1.6)");
  });

  it("maps linear", () => {
    expect(godotEasingToCss("InOut", "Linear")).toBe("linear");
  });

  it("maps the polynomial/trig trans families to their cubic-bezier fits", () => {
    // The reported STS2 case: the shop inventory's 700ms Quint/Out open slide used to get the generic `ease-out`,
    // which lags Godot's easeOutQuint by up to 0.388 of the travel distance (measured) — the panel looked ~2× slower
    // to arrive in the browser than in the game.
    expect(godotEasingToCss("Out", "Quint")).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(godotEasingToCss("In", "Quint")).toBe("cubic-bezier(0.64, 0, 0.78, 0)");
    expect(godotEasingToCss("InOut", "Quint")).toBe("cubic-bezier(0.83, 0, 0.17, 1)");
    expect(godotEasingToCss("Out", "Sine")).toBe("cubic-bezier(0.61, 1, 0.88, 1)");
    expect(godotEasingToCss("InOut", "Sine")).toBe("cubic-bezier(0.37, 0, 0.63, 1)");
    expect(godotEasingToCss("In", "Quad")).toBe("cubic-bezier(0.11, 0, 0.5, 0)");
    expect(godotEasingToCss("Out", "Cubic")).toBe("cubic-bezier(0.33, 1, 0.68, 1)");
    expect(godotEasingToCss("Out", "Quart")).toBe("cubic-bezier(0.25, 1, 0.5, 1)");
    expect(godotEasingToCss("Out", "Circ")).toBe("cubic-bezier(0, 0.55, 0.45, 1)");
  });

  it("maps a MISSING trans to linear (Godot's Tween default is TRANS_LINEAR)", () => {
    expect(godotEasingToCss("Out", undefined)).toBe("linear");
    expect(godotEasingToCss("InOut", undefined)).toBe("linear");
    expect(godotEasingToCss(undefined, undefined)).toBe("linear");
    expect(godotEasingToCss("Out", "")).toBe("linear");
  });

  it("falls back to ease-* for trans families with no cubic-bezier form", () => {
    for (const trans of ["Bounce", "Spring"]) {
      expect(godotEasingToCss("Out", trans)).toBe("ease-out");
      expect(godotEasingToCss("In", trans)).toBe("ease-in");
      expect(godotEasingToCss("InOut", trans)).toBe("ease-in-out");
    }
  });

  it("is case-insensitive in both arguments (raw Godot enum names or lowercase)", () => {
    expect(godotEasingToCss("out", "expo")).toBe(godotEasingToCss("Out", "Expo"));
    expect(godotEasingToCss("OUT", "EXPO")).toBe(godotEasingToCss("Out", "Expo"));
  });

  it("defaults to the in-out column when ease is missing/unknown (Godot's default_ease is EASE_IN_OUT)", () => {
    expect(godotEasingToCss(undefined, "Cubic")).toBe(godotEasingToCss("InOut", "Cubic"));
    expect(godotEasingToCss("OutIn", "Cubic")).toBe(godotEasingToCss("InOut", "Cubic")); // OutIn has no CSS form here
  });
});
