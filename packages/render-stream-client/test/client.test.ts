import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRenderStreamClient,
  RenderStreamEndpointError,
} from "../src/index";
import type { LoaderEnv } from "../src/loader";
import type { RenderStreamStatus } from "../src/loop";
import type { RenderStreamTransportFactory } from "../src/transport";
import { after, freshCore, scriptedEnv, stall, streamOf } from "./loader-env";

// The client's loader, on a scripted env when a test sets one (else the page's: jsdom refuses it).
const loader = vi.hoisted(() => ({
  env: undefined as Partial<LoaderEnv> | undefined,
}));
vi.mock("../src/loader", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/loader")>();
  return {
    ...real,
    loadCore: (
      core: Parameters<typeof real.loadCore>[0],
      o: Parameters<typeof real.loadCore>[1],
    ) => real.loadCore(core, { ...o, env: loader.env ?? o.env }),
  };
});

afterEach(() => {
  loader.env = undefined;
  vi.useRealTimers();
});

const endpoint = {
  url: "ws://127.0.0.1:1/render-stream",
  resourceBase: "",
  token: null,
  protocol: 12 as const,
};
const core = {
  glueUrl: "/core/rs_gsw_wasm_client.js",
  wasmUrl: "/core/rs_gsw_wasm_bg.wasm",
};

describe("createRenderStreamClient", () => {
  it("refuses bad extensions (TAG2), a bad credit window and a bad descriptor", () => {
    const canvas = document.createElement("canvas");
    // An extension that wants identities needs /13; ids are unique and non-empty.
    expect(() =>
      createRenderStreamClient({
        canvas,
        core,
        endpoint,
        extensions: [{ id: "x", wants: { groups: ["g"] } }],
      }),
    ).toThrow(/protocol 13/);
    expect(() =>
      createRenderStreamClient({
        canvas,
        core,
        endpoint,
        extensions: [{ id: "x" }, { id: "x" }],
      }),
    ).toThrow(/unique/);
    createRenderStreamClient({
      canvas,
      core,
      endpoint,
      extensions: [{ id: "x" }],
    }).dispose();
    expect(() =>
      createRenderStreamClient({
        canvas,
        core,
        endpoint,
        creditWindow: 3 as never,
      }),
    ).toThrow(/creditWindow/);
    expect(() =>
      createRenderStreamClient({
        canvas,
        core,
        endpoint: { ...endpoint, protocol: 9 as never },
      }),
    ).toThrow(RenderStreamEndpointError);
    expect(() =>
      createRenderStreamClient({
        canvas,
        core,
        endpoint,
        carrier: "quic" as never,
      }),
    ).toThrow(/carrier/);
    for (const coreLoadTimeoutMs of [0, -1, Number.NaN, Infinity, 2 ** 31])
      expect(() =>
        createRenderStreamClient({ canvas, core, endpoint, coreLoadTimeoutMs }),
      ).toThrow(/coreLoadTimeoutMs/);
    for (const carrier of ["auto", "websocket", "webtransport"] as const)
      createRenderStreamClient({ canvas, core, endpoint, carrier }).dispose();
  });

  it.each([
    11, 12,
  ] as const)("refuses v2 wants on /%i at construction", (protocol) => {
    for (const field of ["instance_id", "mouse_filter"] as const) {
      expect(() =>
        createRenderStreamClient({
          canvas: document.createElement("canvas"),
          core,
          endpoint: { ...endpoint, protocol },
          extensions: [{ id: "v2", wants: { fields: [field] } }],
        }),
      ).toThrow(TypeError);
    }
  });

  it("dispose is idempotent, before or after connect, and silences the client", async () => {
    const canvas = document.createElement("canvas");
    const statuses: RenderStreamStatus[] = [];
    const a = createRenderStreamClient({
      canvas,
      core,
      endpoint,
      onStatus: (s) => statuses.push(s),
    });
    a.dispose();
    a.dispose();
    a.connect();
    expect(statuses).toEqual([]);
    expect(a.stats()).toEqual({
      applied: 0,
      appliesPerSec: 0,
      creditRttMsP50: null,
      heapBytes: 0,
      carrier: null,
    });

    const b = createRenderStreamClient({
      canvas,
      core,
      endpoint,
      onStatus: (s) => statuses.push(s),
    });
    b.connect(); // the core load is in flight (and fails in jsdom)
    b.dispose();
    b.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(statuses).toEqual([{ kind: "connecting" }]);
  });

  it("reports a core that cannot load as core-load-failed", async () => {
    const canvas = document.createElement("canvas");
    const statuses: RenderStreamStatus[] = [];
    // The failed load is the event to wait for: how long jsdom takes to refuse the core varies
    // with machine load (a fixed 20 ms sleep failed about 1 run in 3).
    let failed: () => void = () => {};
    const ended = new Promise<void>((r) => {
      failed = r;
    });
    const c = createRenderStreamClient({
      canvas,
      core,
      endpoint,
      onStatus: (s) => {
        statuses.push(s);
        if (s.kind === "failed") failed();
      },
    });
    c.connect();
    await ended;
    expect(statuses.at(-1)).toMatchObject({
      kind: "failed",
      reason: "core-load-failed",
    });
    c.dispose();
  });

  describe("the core load deadline", () => {
    const MS = 5000;

    function mount(
      steps: Parameters<typeof scriptedEnv>[0],
      /** null: the option left out. */
      coreLoadTimeoutMs: number | null = MS,
    ) {
      vi.useFakeTimers();
      const s = scriptedEnv(steps);
      loader.env = s.env;
      const statuses: RenderStreamStatus[] = [];
      const connects: string[] = [];
      const transport: RenderStreamTransportFactory = (e, sub) => {
        connects.push(`${e.url} ${sub}`);
        return {
          send() {},
          close() {},
          fetchResource: () => stall(),
        };
      };
      const c = createRenderStreamClient({
        canvas: document.createElement("canvas"),
        core: freshCore(),
        endpoint,
        transport,
        coreLoadTimeoutMs: coreLoadTimeoutMs ?? undefined,
        onStatus: (st) => statuses.push(st),
      });
      return { s, c, statuses, connects };
    }

    it.each([
      ["build fetch", { build: stall }],
      ["wasm fetch", { wasm: stall }],
      ["wasm hash", { digest: stall }],
      ["wasm compile", { compile: stall }],
      ["glue import", { glue: stall }],
      ["core init", { init: stall }],
    ] as const)("a stalled %s is core-load-failed at the deadline", async (step, steps) => {
      const { s, c, statuses, connects } = mount(steps);
      c.connect();
      await vi.advanceTimersByTimeAsync(MS - 1);
      expect(statuses).toEqual([{ kind: "connecting" }]);
      await vi.advanceTimersByTimeAsync(1);
      expect(statuses).toEqual([
        { kind: "connecting" },
        {
          kind: "failed",
          reason: "core-load-failed",
          detail: `timeout after ${MS} ms in ${step}`,
        },
      ]);
      expect(s.counts.cores).toBe(0);
      expect(connects).toEqual([]);
      c.dispose();
    });

    it("a body that stalls part-way, hashed as it arrives, is a stalled wasm fetch", async () => {
      const { c, statuses } = mount({
        subtle: false,
        body: () => streamOf([new Uint8Array(4)], "stall").stream,
      });
      c.connect();
      await vi.advanceTimersByTimeAsync(MS);
      expect(statuses.at(-1)).toEqual({
        kind: "failed",
        reason: "core-load-failed",
        detail: `timeout after ${MS} ms in wasm fetch`,
      });
      c.dispose();
    });

    it("defaults to 30 s", async () => {
      const { c, statuses } = mount({ wasm: stall }, null);
      c.connect();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(statuses).toEqual([{ kind: "connecting" }]);
      await vi.advanceTimersByTimeAsync(1);
      expect(statuses.at(-1)).toEqual({
        kind: "failed",
        reason: "core-load-failed",
        detail: "timeout after 30000 ms in wasm fetch",
      });
      c.dispose();
    });

    it("dispose mid-load reports nothing more and installs nothing, however late the load", async () => {
      let compile: (m: WebAssembly.Module) => void = () => {};
      const { s, c, statuses, connects } = mount({
        compile: () => new Promise((r) => (compile = r)),
      });
      c.connect();
      await vi.advanceTimersByTimeAsync(100);
      const wasmFetch = s.fetches.find((f) => f.url.endsWith(".wasm"));
      c.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(wasmFetch?.signal?.aborted).toBe(true);
      compile({} as WebAssembly.Module);
      await vi.advanceTimersByTimeAsync(MS * 2);
      expect(statuses).toEqual([{ kind: "connecting" }]);
      expect(s.counts).toEqual({ glues: 0, cores: 0 });
      expect(connects).toEqual([]);
    });

    it("a load that ends just inside the deadline connects", async () => {
      const { s, c, statuses, connects } = mount({
        wasm: () =>
          after(MS - 1, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer),
      });
      c.connect();
      await vi.advanceTimersByTimeAsync(MS - 1);
      expect(s.counts).toEqual({ glues: 1, cores: 1 });
      expect(connects).toEqual([
        "ws://127.0.0.1:1/render-stream render-stream.12",
      ]);
      // Past the core deadline nothing fails: the connect deadline is the loop's now.
      await vi.advanceTimersByTimeAsync(2);
      expect(statuses.every((st) => st.kind === "connecting")).toBe(true);
      c.dispose();
    });

    it("connect after a timeout loads again", async () => {
      let wasm: () => Promise<ArrayBuffer> = stall;
      const { s, c, statuses, connects } = mount({ wasm: () => wasm() });
      c.connect();
      await vi.advanceTimersByTimeAsync(MS);
      expect(statuses.at(-1)).toMatchObject({ reason: "core-load-failed" });
      wasm = async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
      c.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.counts.cores).toBe(1);
      expect(connects).toHaveLength(1);
      c.dispose();
    });
  });
});
