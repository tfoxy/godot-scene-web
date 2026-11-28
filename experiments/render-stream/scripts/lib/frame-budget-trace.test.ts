import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitTracedBench } from "../gate7-bench";
import {
  startCdpTrace,
  TRACE_CATEGORIES,
  type TraceConnection,
} from "./frame-budget-trace";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("CDP trace stream", () => {
  it("subscribes before ending, streams text/base64 chunks, and stops idempotently", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".local/trace-test-"));
    dirs.push(dir);
    const calls: string[] = [];
    let listener: ((p: { stream?: string }) => void) | undefined;
    let reads = 0;
    const connection: TraceConnection = {
      async send(method, params) {
        calls.push(method);
        if (method === "Tracing.start")
          expect(params).toMatchObject({
            transferMode: "ReturnAsStream",
            traceConfig: { includedCategories: TRACE_CATEGORIES },
          });
        if (method === "Tracing.end") listener?.({ stream: "trace-handle" });
        if (method === "IO.read")
          return reads++ === 0
            ? { data: '{"traceEvents":', eof: false }
            : {
                data: Buffer.from("[]}").toString("base64"),
                base64Encoded: true,
                eof: true,
              };
        return {};
      },
      onComplete(fn) {
        listener = fn;
        return () => {
          calls.push("off");
        };
      },
      async dispose() {
        calls.push("dispose");
      },
    };
    const trace = await startCdpTrace(connection, join(dir, "trace.json"));
    await Promise.all([trace.stop(), trace.stop()]);
    expect(JSON.parse(await readFile(join(dir, "trace.json"), "utf8"))).toEqual(
      { traceEvents: [] },
    );
    expect(calls).toEqual([
      "Tracing.start",
      "Tracing.end",
      "IO.read",
      "IO.read",
      "off",
      "IO.close",
      "dispose",
    ]);
  });

  it("detaches on a refused start", async () => {
    let disposed = false;
    await expect(
      startCdpTrace(
        {
          async send() {
            throw new Error("trace already active");
          },
          onComplete() {
            throw new Error("unused");
          },
          async dispose() {
            disposed = true;
          },
        },
        "unused",
      ),
    ).rejects.toThrow("trace already active");
    expect(disposed).toBe(true);
  });
});

// Exercise the gate driver against a fake page/CDP seam; no browser or quiet lock.
it("starts only at a measured seq threshold and stops after the requested seconds", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".local/trace-driver-test-"));
  dirs.push(dir);
  vi.useFakeTimers();
  const states = [
    { state: "running", detail: "warmup", seq: 100, warmup: true },
    { state: "running", detail: "repeat", seq: 9, warmup: false },
    { state: "running", detail: "repeat", seq: 10, warmup: false },
    { state: "done", detail: "done", seq: 20, warmup: false },
  ];
  let polls = 0;
  const stop = vi.fn(async () => {
    await writeFile(
      join(dir, "trace.json"),
      await readFile(
        new URL("../test/fixtures/frame-budget.json", import.meta.url),
      ),
    );
  });
  const startTrace = vi.fn(async () => {
    expect(polls).toBe(3);
    return { stop };
  });
  const result = waitTracedBench(
    {
      evaluate: async <T>() => states[polls++] as T,
      close: async () => {},
      startTrace,
    },
    { traceSeconds: 5, traceFromSeq: 10 },
    dir,
    "fake",
  );
  await vi.advanceTimersByTimeAsync(4999);
  expect(startTrace).toHaveBeenCalledTimes(1);
  expect(stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(101);
  await result;
  expect(
    JSON.parse(await readFile(join(dir, "frame-budget.json"), "utf8")).frames,
  ).toHaveLength(2);
});

it("fails explicitly if a measured repeat never reaches the trace threshold", async () => {
  await expect(
    waitTracedBench(
      {
        evaluate: async <T>() =>
          ({ state: "done", detail: "done", seq: 9, warmup: false }) as T,
        close: async () => {},
        startTrace: async () => {
          throw new Error("must not start");
        },
      },
      { traceSeconds: 5, traceFromSeq: 10 },
      "unused",
      "fake",
    ),
  ).rejects.toThrow("trace threshold seq 10 was never reported");
});
