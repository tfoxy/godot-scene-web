import { afterEach, describe, expect, it, vi } from "vitest";
import {
  definePrograms,
  LIVE_PROGRAM_BUDGET,
  type ProgramCounts,
  type ProgramHost,
  resolvePrograms,
} from "../src/programs";
import { programHost } from "./program-host";

const counts = (): ProgramCounts => ({
  defined: 0,
  refused: 0,
  library_reads: 0,
});
afterEach(() => vi.restoreAllMocks());

describe("budgeted shader definitions", () => {
  it("counts distinct hashes with identical GLSL across slices without deduplicating definitions", () => {
    const g = programHost(7);
    const out = counts();
    const hashes = ["a", "b", "b", "c", "d", "e", "f"];
    const codes = [
      "shader_type canvas_item; uniform float strength = 0.2; void fragment() { COLOR *= strength; }",
      "shader_type canvas_item; uniform float strength = 0.8; void fragment() { COLOR *= strength; }",
      "shader_type canvas_item; uniform float strength = 0.8; void fragment() { COLOR *= strength; }",
      "shader_type canvas_item; uniform float strength = 0.2; void vertex() { VERTEX.x += 1.0; } void fragment() { COLOR *= strength; }",
      "shader_type canvas_item; uniform float strength = 0.2; void fragment() { COLOR += strength; }",
      "shader_type spatial;",
      "shader_type canvas_item; uniform float strength = 0.8; void fragment() { COLOR *= strength; }",
    ];
    g.pending_hash = (i) => hashes[Number(g.pending_shader_id(i))];
    g.pending_code = () => codes[Number(g.pending_shader_id(0))];
    const define = vi.fn<ProgramHost["define_program"]>(g.define_program);
    g.define_program = define;
    expect(definePrograms(g, out, undefined, { ms: Infinity, max: 1 })).toBe(
      true,
    );
    expect(out).toMatchObject({ defined: 1, identical_glsl: 0 });
    definePrograms(g, out);
    expect(out).toMatchObject({ defined: 6, refused: 1, identical_glsl: 2 });
    expect(define).toHaveBeenCalledTimes(6);
    const args = define.mock.calls;
    expect(args[0][1]).toBe(args[1][1]);
    expect(args[0][2]).not.toBe(args[1][2]); // Uniform defaults remain distinct metadata.
    expect(args[3][1]).toBe(args[0][1]);
    expect(args[3][3]).not.toBe(args[0][3]); // A different vertex stage is not identical.
    expect(args[4][1]).not.toBe(args[0][1]);
    const other = counts();
    definePrograms(programHost(1), other);
    expect(other).toMatchObject({ defined: 1, identical_glsl: 0 });
  });

  it("defines a burst of 14 in slices of at most three, keeping the rest held", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const g = programHost(14);
    const out = counts();
    const batches: number[] = [];
    let held = true;
    while (held) {
      const before = out.defined;
      held = definePrograms(g, out, undefined, LIVE_PROGRAM_BUDGET);
      batches.push(out.defined - before);
      expect(g.states.filter((s) => s === "held")).toHaveLength(
        14 - out.defined,
      );
      expect(g.states).not.toContain("pending");
    }
    expect(batches).toEqual([3, 3, 3, 3, 2]);
    expect(out).toEqual({
      defined: 14,
      refused: 0,
      library_reads: 0,
      identical_glsl: 13,
    });
  });

  it("stops after the time budget, always attempting at least one", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const g = programHost(14, () => {
      now += 2.5;
    });
    const out = counts();
    expect(definePrograms(g, out, undefined, LIVE_PROGRAM_BUDGET)).toBe(true);
    expect(out.defined).toBe(2); // 5 ms including the final shader's overrun.
    expect(definePrograms(g, out, undefined, { ms: 0, max: 0 })).toBe(true);
    expect(out.defined).toBe(3);
  });

  it("file mode defines every shader up front", async () => {
    const g = programHost(14);
    const out = await resolvePrograms(
      g,
      new WebAssembly.Memory({ initial: 1 }),
      null,
    );
    expect(out.defined).toBe(14);
    expect(g.states.every((s) => s === "linking")).toBe(true);
  });

  it("an older wasm without hold_program keeps unbudgeted definitions", () => {
    const g: ProgramHost = programHost(14);
    delete g.hold_program;
    const out = counts();
    expect(definePrograms(g, out, undefined, LIVE_PROGRAM_BUDGET)).toBe(false);
    expect(out.defined).toBe(14);
  });

  it("holds a stable snapshot, propagates failures and advances refused shaders", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const g = programHost(6);
    const out = counts();
    const code = g.pending_code;
    g.pending_code = () => "shader_type spatial;";
    expect(definePrograms(g, out, undefined, LIVE_PROGRAM_BUDGET)).toBe(true);
    expect(out.refused).toBe(3);
    g.pending_code = code;
    g.hold_program = () => -1;
    expect(() => definePrograms(g, out, undefined, { ms: 4, max: 1 })).toThrow(
      "fake error",
    );
  });
});
