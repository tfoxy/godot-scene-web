import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let readReplayWindow: typeof import("./bench-rs").readReplayWindow;
beforeAll(async () => {
  // Import the real bench in idle mode, without starting wasm or touching a browser.
  vi.stubGlobal("location", { search: "?mode=idle" });
  vi.stubGlobal("document", { getElementById: () => null });
  ({ readReplayWindow } = await import("./bench-rs"));
});
afterAll(() => vi.unstubAllGlobals());

describe("replay seq window", () => {
  it("keeps the legacy replay path when no window is supplied", () => {
    expect(readReplayWindow(new URLSearchParams())).toBeNull();
  });
  it("uses inclusive seq bounds, with an optional open end", () => {
    expect(readReplayWindow(new URLSearchParams("from=1500&to=1800"))).toEqual({
      from: 1500,
      to: 1800,
    });
    expect(readReplayWindow(new URLSearchParams("from=1500"))).toEqual({
      from: 1500,
      to: null,
    });
    expect(readReplayWindow(new URLSearchParams("to=0"))).toEqual({
      from: 0,
      to: 0,
    });
  });
  it.each([
    "from=-1",
    "from=1.5",
    "from=NaN",
    "from=1800&to=1500",
    "to=Infinity",
    "from=",
  ])("rejects invalid window %s", (q) => {
    expect(() => readReplayWindow(new URLSearchParams(q))).toThrow(/window/);
  });
});

it.each(
  [
    { repeats: 1, windowed: true },
    { repeats: 2, windowed: true },
    { repeats: 1, windowed: false },
    ...[false, true].flatMap((staging) => [
      { repeats: 1, windowed: true, missing: "fatal", staging },
      { repeats: 2, windowed: true, missing: "skip", staging },
    ]),
  ].map((row) => ({ missing: "none", staging: false, ...row })),
)("replays with repeats=$repeats, window=$windowed", async ({
  repeats,
  windowed,
  missing,
  staging,
}) => {
  const { runBench } = await import("./bench-rs");
  const memory = new WebAssembly.Memory({ initial: 1 });
  const stats = new Uint32Array(memory.buffer, 0, 40);
  let resets = 0;
  let frames = 0;
  let draws = 0;
  let deferred = 0;
  let provided = 0;
  let staged = 0;
  let uploaded:
    | {
        window: { from: number; to: number };
        repeats: number;
        missing_skipped?: string[];
        results: {
          error: string | null;
          samples: { seq: number }[];
          measured: { frames: number };
        }[];
      }
    | undefined;
  class FakeRs {
    alloc_recording() {
      return 256;
    }
    load() {
      return 1810;
    }
    reset() {
      resets++;
      stats.fill(0);
      return 0;
    }
    start() {
      return 0;
    }
    accept(index: number) {
      stats[1] = index - 1;
      stats[2] = index;
      return missing === "none" ? 0 : 3;
    }
    needed_count() {
      return 2;
    }
    needed_ptr() {
      // A missing hash followed by an available one verifies cursor alignment.
      new Uint8Array(memory.buffer, 256, 32).fill(0);
      new Uint8Array(memory.buffer, 288, 32).fill(1);
      return 256;
    }
    defer_payload(hash: string) {
      expect(hash).toBe("00".repeat(32));
      deferred++;
      return 0;
    }
    alloc_payload() {
      return 512;
    }
    provide() {
      provided++;
      return 0;
    }
    provide_staged() {
      provided++;
      return 0;
    }
    pending_shaders() {
      return 0;
    }
    apply() {
      return 0;
    }
    draw() {
      draws++;
      return 0;
    }
    stats_ptr() {
      return 0;
    }
    digest() {
      return 0;
    }
    poll_fence() {
      return 1;
    }
    evidence_json() {
      return "{}";
    }
    free() {}
  }
  if (staging)
    Object.defineProperty(FakeRs.prototype, "stage_payload", {
      value: (_length: number, hash: string) => {
        expect(hash).toBe("01".repeat(32));
        staged++;
        return 0;
      },
    });
  vi.stubGlobal("window", {});
  vi.stubGlobal("self", { crossOriginIsolated: true });
  vi.stubGlobal("navigator", { userAgent: "fake" });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
  });
  vi.stubGlobal("requestAnimationFrame", (callback: (ts: number) => void) => {
    frames++;
    queueMicrotask(() => callback(performance.now()));
  });
  vi.stubGlobal("fetch", async (_url: string, options?: RequestInit) => {
    if (options?.method === "PUT") uploaded = JSON.parse(String(options.body));
    if (_url.endsWith("index.jsonl"))
      return new Response(JSON.stringify({ hash: "01".repeat(32) }));
    return new Response(new Uint8Array(4));
  });
  const measure = vi.spyOn(performance, "measure");
  try {
    const query = `input=/recording&nonce=test&warmup=0&repeats=${repeats}${windowed ? "&from=1500&to=1800&prof=1" : ""}${missing !== "none" ? "&store=/store" : ""}${missing === "skip" ? "&missing=skip" : ""}`;
    await runBench(new URLSearchParams(query), {
      default: async () => ({ memory }),
      GswRs: FakeRs,
    } as unknown as import("./bench-rs").GswRsModule);
    if (missing === "fatal") {
      expect(uploaded?.results[0].error).toBe(
        `record 1: payload ${"00".repeat(32)} not in the store`,
      );
      expect(uploaded?.results[0].samples).toHaveLength(0);
      expect(deferred).toBe(0);
      expect(provided).toBe(0);
      return;
    }
    if (missing === "skip") {
      expect(uploaded?.missing_skipped).toEqual(["00".repeat(32)]);
      expect(deferred).toBe(1801 * repeats);
      expect(provided).toBe(1801 * repeats);
      expect(staged).toBe(staging ? 1801 * repeats : 0);
    } else expect(uploaded).not.toHaveProperty("missing_skipped");
    expect(uploaded?.repeats).toBe(repeats);
    if (windowed) expect(uploaded?.window).toEqual({ from: 1500, to: 1800 });
    else expect(uploaded).not.toHaveProperty("window");
    expect(uploaded?.results).toHaveLength(repeats);
    for (const result of uploaded?.results ?? []) {
      expect(result.error).toBeNull();
      if (windowed) expect(result.measured.frames).toBe(301);
      else expect(result).not.toHaveProperty("measured");
      expect(result.samples.map((s) => s.seq)).toEqual(
        Array.from(
          { length: windowed ? 301 : 1809 },
          (_, i) => (windowed ? 1500 : 0) + i,
        ),
      );
    }
    expect(resets).toBe(repeats);
    expect(draws).toBe((windowed ? 1801 : 1809) * repeats); // prefix really applied/drew again after each reset
    expect(frames).toBe((windowed ? 302 : 1810) * repeats); // one setup rAF plus the measured window
    expect(measure).toHaveBeenCalledTimes(windowed ? 5 * 301 * repeats : 0); // prefix has no user timings
  } finally {
    measure.mockRestore();
  }
});
