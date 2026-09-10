import { describe, expect, it } from "vitest";

import { anchorInsetExpression, appendAnchorName, positionTryFallback } from "../src/anchor-css";

describe("appendAnchorName", () => {
  it("starts a fresh anchor-name value when none exists", () => {
    expect(appendAnchorName(undefined, "--sht0")).toBe("--sht0");
  });

  it("appends to an existing anchor-name value", () => {
    expect(appendAnchorName("--sht0", "--sht1")).toBe("--sht0, --sht1");
  });

  it("does not duplicate an already-present name", () => {
    expect(appendAnchorName("--sht0, --sht1", "--sht0")).toBe("--sht0, --sht1");
  });
});

describe("anchorInsetExpression", () => {
  it("builds a bare anchor() for a single target with no offset", () => {
    expect(anchorInsetExpression("right", ["--sht0"], "min", 0)).toBe("anchor(--sht0 right)");
  });

  it("wraps a positive offset in calc(... + Npx)", () => {
    expect(anchorInsetExpression("bottom", ["--sht0"], "min", 20)).toBe(
      "calc(anchor(--sht0 bottom) + 20px)",
    );
  });

  it("wraps a negative offset in calc(... - Npx)", () => {
    expect(anchorInsetExpression("right", ["--sht0"], "min", -8)).toBe(
      "calc(anchor(--sht0 right) - 8px)",
    );
  });

  it("combines multiple targets with min()/max()", () => {
    expect(anchorInsetExpression("bottom", ["--a", "--b"], "max", 0)).toBe(
      "max(anchor(--a bottom), anchor(--b bottom))",
    );
  });
});

describe("positionTryFallback", () => {
  it("passes a single fallback through unchanged", () => {
    expect(positionTryFallback("flip-inline")).toBe("flip-inline");
  });

  it("joins multiple fallbacks with a comma", () => {
    expect(positionTryFallback("flip-block", "flip-inline")).toBe("flip-block, flip-inline");
  });
});
