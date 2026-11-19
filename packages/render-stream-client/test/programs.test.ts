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
    expect(out).toEqual({ defined: 14, refused: 0, library_reads: 0 });
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
