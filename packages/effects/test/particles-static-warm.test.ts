import { describe, expect, it } from "vitest";
import { staticWarmSeconds } from "../src/particles";

describe("staticWarmSeconds", () => {
  it.each([
    [false, 0, 10],
    [true, 0, 4],
    [true, -1, 4],
    [false, 3, 3],
    [true, 100, 20],
    [false, 100, 20],
  ])("oneShot=%s preprocess=%s warms %s seconds", (oneShot, preprocess, expected) => {
    expect(staticWarmSeconds({ lifetime: 10, oneShot, preprocess })).toBe(
      expected,
    );
  });
});
