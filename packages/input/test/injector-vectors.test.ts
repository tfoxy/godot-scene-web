// Checks every conformance/v1/injector vector for self-consistency without Godot: the test-only
// model of the GDScript injector (model-injector.ts) must reach each `expect` entry exactly.
// Godot runs the same vectors against real Input in packages/input/godot/tests/
// injector_selftest.gd (`pnpm test:input-godot`).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInputMessage } from "../src/index";
import {
  type InjectorVector,
  normalizeExpect,
  runInjectorVector,
} from "./model-injector";

const dir = join(import.meta.dirname, "../conformance/v1/injector");
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .sort();
const vectors = files.map((file) => ({
  file,
  vector: JSON.parse(readFileSync(join(dir, file), "utf8")) as InjectorVector,
}));

describe("conformance/v1/injector", () => {
  it("has vectors, each named after its file", () => {
    expect(vectors.length).toBeGreaterThan(0);
    for (const { file, vector } of vectors)
      expect(`${vector.name}.json`).toBe(file);
  });

  it("orders expect entries by step and keeps them in range", () => {
    for (const { vector } of vectors) {
      const afters = vector.expect.map((entry) => entry.after);
      expect(afters, vector.name).toEqual([...afters].sort((a, b) => a - b));
      for (const after of afters)
        expect(after, vector.name).toBeLessThan(vector.steps.length);
    }
  });

  it("sends only messages the codec judges as each step expects", () => {
    // A step without `result` must be a valid message: a typo in a vector must not turn into a
    // silent codec rejection that both implementations then agree on.
    for (const { vector } of vectors)
      for (const step of vector.steps) {
        if (!("recv" in step) || step.result !== undefined) continue;
        const text =
          typeof step.recv === "string" ? step.recv : JSON.stringify(step.recv);
        expect(parseInputMessage(text).ok, `${vector.name}: ${text}`).toBe(
          true,
        );
      }
  });

  it("leaves nothing held after each vector's last step", () => {
    for (const { vector } of vectors) {
      const last = runInjectorVector({
        ...vector,
        expect: [...vector.expect, { after: vector.steps.length - 1 }],
      }).at(-1);
      expect(last?.physical_keys, vector.name).toEqual([]);
      expect(last?.joy_buttons, vector.name).toEqual([]);
      expect(last?.joy_axes, vector.name).toEqual([]);
      expect(last?.mouse_mask, vector.name).toBe(0);
    }
  });

  it.each(
    vectors.map(({ vector }) => [vector.name, vector] as const),
  )("%s", (_name, vector) => {
    const states = runInjectorVector(vector);
    vector.expect.forEach((entry, index) => {
      expect(states[index], `${vector.name} after step ${entry.after}`).toEqual(
        normalizeExpect(entry),
      );
    });
  });
});
