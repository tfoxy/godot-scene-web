import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { frameBudget, type TraceEvent } from "./frame-budget";

const fixture = JSON.parse(
  readFileSync(
    new URL("../test/fixtures/frame-budget.json", import.meta.url),
    "utf8",
  ),
);

describe("frame budget", () => {
  it("clips and unions GPU tasks at frame boundaries, without nested double counting", () => {
    const report = frameBudget(fixture);
    expect(report.frames).toHaveLength(2); // last rAF has no complete interval
    expect(report.frames[0]).toMatchObject({
      interval_ms: 10,
      raf_ms: 6,
      decode_ms: 1,
      provide_ms: 0.5,
      program_ms: 0.5,
      apply_ms: 1,
      draw_ms: 2,
      gpu_task_ms: 6,
      gpu_idle_ms: 4,
      swaps: 1,
      dropped: 0,
    });
    expect(report.frames[1]).toMatchObject({
      interval_ms: 10,
      raf_ms: 4,
      decode_ms: 0,
      gpu_task_ms: 4,
      gpu_idle_ms: 6,
      swaps: 0,
      dropped: 1,
    });
    expect(report.summary.gpu_task_ms).toEqual({
      n: 2,
      mean: 5,
      p50: 4,
      p95: 6,
    });
    expect(report.summary.swaps).toMatchObject({ n: 2, mean: 0.5 });
  });

  it("selects the renderer carrying bench timings, and accepts synchronous measures", () => {
    const extra: TraceEvent[] = [
      {
        ph: "M",
        name: "thread_name",
        pid: 9,
        tid: 91,
        args: { name: "CrRendererMain" },
      },
      {
        ph: "X",
        name: "FireAnimationFrame",
        pid: 9,
        tid: 91,
        ts: 2000,
        dur: 300,
      },
      { ph: "B", name: "rs-bench:decode", pid: 1, tid: 11, ts: 11000 },
      { ph: "E", pid: 1, tid: 11, ts: 12000 },
    ];
    expect(
      frameBudget({ traceEvents: [...fixture.traceEvents, ...extra] }).frames[1]
        .decode_ms,
    ).toBe(1);
  });

  it("refuses an ambiguous renderer or an incomplete trace", () => {
    expect(() => frameBudget({ traceEvents: [] })).toThrow(/rAF/);
    const events = fixture.traceEvents.filter(
      (e: TraceEvent) => !e.name?.startsWith("rs-bench:"),
    );
    events.push(
      {
        ph: "M",
        name: "thread_name",
        pid: 9,
        tid: 91,
        args: { name: "CrRendererMain" },
      },
      {
        ph: "X",
        name: "FireAnimationFrame",
        pid: 9,
        tid: 91,
        ts: 2000,
        dur: 300,
      },
    );
    expect(() => frameBudget({ traceEvents: events })).toThrow(/renderer/i);
  });
});
