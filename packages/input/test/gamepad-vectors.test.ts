// Drives every conformance/v1/gamepad vector through `createGamepadCapture` on a scripted page:
// each frame sets `getGamepads()`, fires the events a browser would, runs the pending poll, and
// must push exactly that frame's `expect` records in order.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GamepadCaptureOptions, GamepadRecord } from "../src/gamepad";
import { type FakeFrame, fakeGamepadPage } from "./gamepad-fake";

interface GamepadVector {
  name: string;
  frames: FakeFrame[];
  options: Partial<GamepadCaptureOptions>;
  expect: GamepadRecord[][];
}

const dir = join(import.meta.dirname, "../conformance/v1/gamepad");
const suites = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    ...(JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      description: string;
      vectors: GamepadVector[];
    }),
  }));

describe("conformance/v1/gamepad", () => {
  it("has one expect entry per frame and unique names", () => {
    const names = suites.flatMap((suite) => suite.vectors.map((v) => v.name));
    expect(new Set(names).size).toBe(names.length);
    for (const vector of suites.flatMap((suite) => suite.vectors))
      expect(vector.expect.length, vector.name).toBe(vector.frames.length);
  });

  for (const suite of suites)
    describe(suite.file, () => {
      for (const vector of suite.vectors)
        it(vector.name, () => {
          const page = fakeGamepadPage(vector.options);
          const got = vector.frames.map((frame) => page.step(frame));
          expect(got).toEqual(vector.expect);
          page.capture.dispose();
        });
    });
});
