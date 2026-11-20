import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCEPT_END } from "../src/abi";
import { WasmStreamCore } from "../src/core";
import type { RenderStreamProtocol } from "../src/endpoint";
import type { RenderStreamExtension } from "../src/extensions";
import {
  createRenderStreamClient,
  pointerTargetResolver,
  RenderStreamEndpointError,
} from "../src/index";
import type { LoaderEnv } from "../src/loader";
import { type RenderStreamStatus, StreamLoop } from "../src/loop";
import type {
  RenderStreamTransportEvents,
  RenderStreamTransportFactory,
} from "../src/transport";
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
    "prefetchMaxInFlight",
    "prefetchBudgetBytes",
  ] as const)("validates %s as a non-negative safe integer", (option) => {
    const canvas = document.createElement("canvas");
    for (const value of [
      -1,
      0.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(() =>
        createRenderStreamClient({ canvas, core, endpoint, [option]: value }),
      ).toThrow(`${option} must be a non-negative safe integer`);
    for (const value of [0, 1, 64 << 20])
      createRenderStreamClient({
        canvas,
        core,
        endpoint,
        [option]: value,
      }).dispose();
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

describe("endpoint protocol changes", () => {
  function mount(
    protocol: RenderStreamProtocol,
    extensions: RenderStreamExtension[] = [],
    resourceHints?: boolean,
    viewports?: boolean,
    staticParticles?: boolean,
    transparentClear?: boolean,
  ) {
    vi.useFakeTimers();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const s = scriptedEnv({ init: async () => ({ memory }) });
    const base = s.glueModule.default();
    const instances: GswRs[] = [];
    let refuse = false;
    class GswRs extends base.GswRs {
      readonly options: {
        live_protocol: number;
        viewports?: boolean;
        transparent_clear?: boolean;
      };
      readonly free = vi.fn();
      readonly set_window = vi.fn();
      readonly payloads = new Set<string>();
      readonly live_reset = vi.fn((keep: boolean) => {
        if (!keep) this.payloads.clear();
      });
      readonly live_accept = vi.fn(() => 0);
      readonly to_game = vi.fn((x: number, y: number) => [7, x, y]);
      readonly hit_test = vi.fn(() => -1);
      constructor(
        readonly canvas: HTMLCanvasElement,
        options: string,
      ) {
        super();
        if (refuse) throw new Error("rebuild refused");
        this.options = JSON.parse(options);
        instances.push(this);
      }
      rx() {
        expect(this.free).not.toHaveBeenCalled();
        return 0;
      }
      live_session(_len: number, offered: number) {
        return offered === this.options.live_protocol ? 0 : -1;
      }
      session_meta() {
        return JSON.stringify({
          session_id: "s",
          stream: { stream_id: "st" },
          viewport: { presentation_size: [300, 150] },
          resources: { fetch: "inline" },
        });
      }
    }
    class LiveCoding extends base.LiveCoding {
      decode_rx(_g: unknown, len: number) {
        return len;
      }
    }
    s.glueModule.default = () =>
      ({ ...base, GswRs, LiveCoding }) as ReturnType<
        typeof s.glueModule.default
      >;
    loader.env = s.env;
    const statuses: RenderStreamStatus[] = [];
    const connections: {
      events: RenderStreamTransportEvents;
      sub: string;
      builtFor: number;
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }[] = [];
    const transport: RenderStreamTransportFactory = (_e, sub, events) => {
      const conn = {
        events,
        sub,
        builtFor: instances.at(-1)?.options.live_protocol ?? 0,
        send: vi.fn(),
        close: vi.fn(),
      };
      connections.push(conn);
      return {
        send: conn.send,
        close: conn.close,
        fetchResource: () => stall(),
      };
    };
    const canvas = document.createElement("canvas");
    Object.defineProperties(canvas, {
      clientWidth: { value: 300 },
      clientHeight: { value: 150 },
    });
    const c = createRenderStreamClient({
      canvas,
      core: freshCore(),
      endpoint: { ...endpoint, protocol },
      extensions,
      transport,
      applyOn: "frame",
      ...(resourceHints !== undefined ? { resourceHints } : {}),
      ...(staticParticles !== undefined ? { staticParticles } : {}),
      ...(viewports !== undefined ? { viewports } : {}),
      ...(transparentClear !== undefined ? { transparentClear } : {}),
      onStatus: (st) => statuses.push(st),
    });
    function open() {
      const conn = connections.at(-1);
      if (!conn) throw new Error("no connection");
      conn.events.open();
      conn.events.message(new Uint8Array([1]).buffer);
      return conn;
    }
    return {
      c,
      canvas,
      instances,
      connections,
      statuses,
      open,
      refuseBuild: (on: boolean) => {
        refuse = on;
      },
    };
  }

  it.each([
    [12, 13, false, [12, 13]],
    [13, 14, false, [13, 14]],
    [13, 14, true, [14]],
    [14, 13, false, [14, 13]],
  ] as const)("switches /%i to /%i (v2 wants: %s) at the connection boundary", async (from, to, wants, built) => {
    const h = mount(
      from,
      wants ? [{ id: "v2", wants: { fields: ["instance_id"] } }] : [],
    );
    h.c.connect();
    await vi.advanceTimersByTimeAsync(0);
    h.open();
    h.instances[0].payloads.add("resident");
    h.c.setEndpoint({ ...endpoint, protocol: to, presentation: [900, 600] });
    expect(h.instances.map((g) => g.options.live_protocol)).toEqual(built);
    expect(h.connections.at(-1)).toMatchObject({
      sub: `render-stream.${to}`,
      builtFor: to,
    });
    const conn = h.open();
    expect(JSON.parse(conn.send.mock.calls[0][0])).toMatchObject({
      protocol: `render-stream/${to}`,
    });
    expect(h.instances[0].free).toHaveBeenCalledTimes(built.length - 1);
    expect(h.instances.every((g) => g.canvas === h.canvas)).toBe(true);
    if (built.length > 1) {
      expect(h.instances[1].set_window).toHaveBeenCalledWith(900, 600);
      expect(h.instances[1].payloads.size).toBe(0);
    } else expect(h.instances[0].payloads.has("resident")).toBe(true);
    h.c.dispose();
  });

  it.each([
    [13, undefined, 13],
    [15, undefined, 13],
    [15, false, 13],
    [13, true, 15],
    [14, true, 15],
    [15, true, 15],
    [16, undefined, 16],
    [16, false, 16],
    [16, true, 16],
  ] as const)("endpoint /%i with resourceHints %s offers, builds and says /%i", async (protocol, hints, spoken) => {
    const h = mount(protocol, [], hints);
    h.c.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.connections[0]).toMatchObject({
      sub: `render-stream.${spoken}`,
      builtFor: spoken,
    });
    const conn = h.open();
    expect(JSON.parse(conn.send.mock.calls[0][0]).protocol).toBe(
      `render-stream/${spoken}`,
    );
    expect(h.c.hints()).toEqual([]);
    const st = h.c.stats();
    expect("hintsReceived" in st).toBe(hints === true);
    h.c.dispose();
  });

  it("offers exactly render-stream.16 to a /16 endpoint, v2 wants and hints included", async () => {
    const h = mount(
      16,
      [{ id: "v2", wants: { fields: ["instance_id"] } }],
      true,
    );
    h.c.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.connections).toHaveLength(1);
    expect(h.connections[0]).toMatchObject({
      sub: "render-stream.16",
      builtFor: 16,
    });
    const conn = h.open();
    const hello = JSON.parse(conn.send.mock.calls[0][0]);
    expect(hello.protocol).toBe("render-stream/16");
    expect(hello.item_meta.fields).toEqual(["instance_id"]);
    expect("hintsReceived" in h.c.stats()).toBe(true);
    h.c.dispose();
  });

  it("builds the core with viewports on unless the option says false", async () => {
    for (const [option, built] of [
      [undefined, undefined],
      [true, undefined],
      [false, false],
    ] as const) {
      const h = mount(16, [], undefined, option);
      h.c.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.instances[0].options.viewports).toBe(built);
      // The offer and the hello are the same either way.
      expect(h.connections[0].sub).toBe("render-stream.16");
      expect(JSON.parse(h.open().send.mock.calls[0][0]).protocol).toBe(
        "render-stream/16",
      );
      h.c.dispose();
    }
    expect(() => mount(16, [], undefined, "no" as never)).toThrow(
      /viewports must be a boolean/,
    );
  });

  it("passes transparentClear only when enabled, including after a protocol rebuild", async () => {
    let defaultHello: unknown;
    for (const option of [undefined, false, true]) {
      const h = mount(13, [], undefined, undefined, undefined, option);
      h.c.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.instances[0].options.transparent_clear).toBe(
        option ? true : undefined,
      );
      expect(h.connections[0].sub).toBe("render-stream.13");
      const hello = JSON.parse(h.open().send.mock.calls[0][0]);
      if (option === undefined) defaultHello = hello;
      else expect(hello).toEqual(defaultHello);
      h.c.setEndpoint({ ...endpoint, protocol: 16 });
      expect(h.instances[1].options.transparent_clear).toBe(
        option ? true : undefined,
      );
      h.c.dispose();
    }
    expect(() =>
      mount(13, [], undefined, undefined, undefined, "yes" as never),
    ).toThrow(/transparentClear must be a boolean/);
  });

  it("staticParticles reaches the core at creation, runtime, and after a protocol rebuild", async () => {
    const set = vi.spyOn(WasmStreamCore.prototype, "setStaticParticles");
    try {
      for (const on of [undefined, false, true]) {
        const h = mount(13, [], undefined, undefined, on);
        h.c.connect();
        await vi.advanceTimersByTimeAsync(0);
        expect(set).toHaveBeenLastCalledWith(on ?? false);
        expect(typeof h.c.setStaticParticles).toBe("function");
        h.c.setStaticParticles?.(true);
        expect(set).toHaveBeenLastCalledWith(true);
        h.c.setEndpoint({ ...endpoint, protocol: 14 });
        h.c.setStaticParticles?.(false);
        expect(set).toHaveBeenLastCalledWith(false);
        h.c.dispose();
        const calls = set.mock.calls.length;
        h.c.setStaticParticles?.(true);
        expect(set).toHaveBeenCalledTimes(calls);
      }
      expect(() => mount(13, [], undefined, undefined, "no" as never)).toThrow(
        /staticParticles must be a boolean/,
      );
    } finally {
      set.mockRestore();
    }
  });

  it("frameCap: validated, switched at runtime, and woken by input on the canvas's document", async () => {
    const canvas = document.createElement("canvas");
    expect(() =>
      createRenderStreamClient({
        canvas,
        core,
        endpoint,
        frameCap: "sometimes" as never,
      }),
    ).toThrow(/frameCap must be "off" or "automatic"/);
    expect(() =>
      createRenderStreamClient({
        canvas,
        core,
        endpoint,
        frameCapBounds: { animationPx: "fast" as never },
      }),
    ).toThrow(/frameCapBounds\.animationPx/);
    const wake = vi.spyOn(StreamLoop.prototype, "wake");
    const setCap = vi.spyOn(StreamLoop.prototype, "setFrameCap");
    try {
      const h = mount(13);
      h.c.connect();
      await vi.advanceTimersByTimeAsync(0);
      h.open();
      expect(h.c.stats()).toMatchObject({
        frameCap: "off",
        frameCapEngaged: false,
        cappedFrames: 0,
        skippedFrames: 0,
      });
      expect(typeof h.c.setFrameCap).toBe("function");
      expect(typeof h.c.wake).toBe("function");
      // Off: no listener, and wake() does nothing.
      document.dispatchEvent(new Event("pointerdown"));
      h.c.wake?.();
      expect(wake).not.toHaveBeenCalled();
      h.c.setFrameCap?.("automatic");
      expect(setCap).toHaveBeenLastCalledWith("automatic", undefined);
      // Bounds go to the loop as given; a bad one is refused before anything changes.
      h.c.setFrameCap?.("automatic", { animationPx: 32 });
      expect(setCap).toHaveBeenLastCalledWith("automatic", { animationPx: 32 });
      expect(() => h.c.setFrameCap?.("automatic", { motionPx: -1 })).toThrow(
        /frameCapBounds\.motionPx/,
      );
      expect(h.c.stats().frameCap).toBe("automatic");
      for (const t of ["pointerdown", "touchstart", "keydown", "wheel"])
        document.dispatchEvent(new Event(t));
      expect(wake).toHaveBeenCalledTimes(4);
      h.c.wake?.();
      expect(wake).toHaveBeenCalledTimes(5);
      expect(() => h.c.setFrameCap?.("fast" as never)).toThrow(/frameCap/);
      h.c.setFrameCap?.("off");
      document.dispatchEvent(new Event("keydown"));
      expect(wake).toHaveBeenCalledTimes(5);
      h.c.setFrameCap?.("automatic");
      h.c.dispose();
      document.dispatchEvent(new Event("keydown"));
      expect(wake).toHaveBeenCalledTimes(5);
    } finally {
      wake.mockRestore();
      setCap.mockRestore();
    }
  });

  it("leaves the 13 to 15 hints offers alone and switches /15 to /16 at the connection boundary", async () => {
    const h = mount(15, [], true);
    h.c.connect();
    await vi.advanceTimersByTimeAsync(0);
    h.open();
    h.c.setEndpoint({ ...endpoint, protocol: 16 });
    expect(h.instances.map((g) => g.options.live_protocol)).toEqual([15, 16]);
    expect(h.connections.at(-1)).toMatchObject({
      sub: "render-stream.16",
      builtFor: 16,
    });
    h.c.dispose();
  });

  it("refuses resourceHints below protocol 13, at creation and on setEndpoint", async () => {
    expect(() => mount(12, [], true)).toThrow(
      /resourceHints needs protocol 13/,
    );
    const h = mount(13, [], true);
    expect(() => h.c.setEndpoint({ ...endpoint, protocol: 12 })).toThrow(
      /resourceHints needs protocol 13/,
    );
    h.c.dispose();
  });

  it("keeps the core and payloads for URL-only changes and a transport backoff reconnect", async () => {
    const h = mount(13);
    h.c.connect();
    await vi.advanceTimersByTimeAsync(0);
    h.open();
    h.instances[0].payloads.add("resident");
    h.c.setEndpoint({
      ...endpoint,
      protocol: 13,
      url: "ws://127.0.0.1:2/render-stream",
    });
    const conn = h.open();
    conn.events.close(1006, "dropped");
    await vi.advanceTimersByTimeAsync(20);
    expect(h.statuses.at(-1)).toEqual({
      kind: "reconnecting",
      attempt: 1,
      inMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    h.open();
    expect(h.connections).toHaveLength(3);
    expect(
      h.connections.every(
        (c) => c.builtFor === 13 && c.sub === "render-stream.13",
      ),
    ).toBe(true);
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0].free).not.toHaveBeenCalled();
    expect(h.instances[0].live_reset).toHaveBeenCalledWith(true);
    expect(h.instances[0].payloads.has("resident")).toBe(true);
    h.c.dispose();
  });

  it("defers an idle client's new protocol until connect", async () => {
    const h = mount(12);
    h.c.setEndpoint({ ...endpoint, protocol: 13 });
    expect(h.instances).toHaveLength(0);
    expect(h.connections).toHaveLength(0);
    h.c.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.instances.map((g) => g.options.live_protocol)).toEqual([13]);
    expect(h.connections[0]).toMatchObject({
      sub: "render-stream.13",
      builtFor: 13,
    });
    h.c.dispose();
  });

  it("defers an ended client's new protocol while keeping its live core until connect", async () => {
    const h = mount(12);
    h.c.connect();
    await vi.advanceTimersByTimeAsync(0);
    const conn = h.open();
    h.instances[0].live_accept.mockReturnValue(ACCEPT_END);
    conn.events.message(new Uint8Array([2]).buffer);
    await vi.advanceTimersByTimeAsync(20);
    expect(conn.close).toHaveBeenCalledWith(1000, "end seen");
    conn.events.close(1000, "end seen");
    await vi.advanceTimersByTimeAsync(20);
    expect(h.statuses.at(-1)).toEqual({ kind: "ended" });
    h.c.setEndpoint({ ...endpoint, protocol: 13 });
    expect(h.instances.map((g) => g.options.live_protocol)).toEqual([12]);
    expect(h.instances[0].free).not.toHaveBeenCalled();
    expect(h.connections).toHaveLength(1);
    h.c.connect();
    expect(h.instances.map((g) => g.options.live_protocol)).toEqual([12, 13]);
    expect(h.instances[0].free).toHaveBeenCalledTimes(1);
    expect(h.connections.at(-1)).toMatchObject({
      sub: "render-stream.13",
      builtFor: 13,
    });
    h.open();
    h.c.dispose();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("stops after a rebuild failure (no WebGL2: %s, extension: %s), and connect can retry", async (noWebgl, extension) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = mount(
      12,
      extension
        ? [
            {
              id: "filters",
              onSession: (s) => {
                s.mouseFilter(7, "stop");
                s.pickOrder("tree");
              },
            },
          ]
        : [],
    );
    h.c.connect();
    await vi.advanceTimersByTimeAsync(0);
    const conn = h.open();
    expect(h.c.clientToGame(1, 1)?.item).toBe(7);
    conn.events.message(new Uint8Array([2]).buffer);
    const probe = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(
        noWebgl
          ? null
          : ({ getExtension: () => null } as unknown as WebGL2RenderingContext),
      );
    try {
      h.refuseBuild(true);
      expect(() =>
        h.c.setEndpoint({ ...endpoint, protocol: 13 }),
      ).not.toThrow();
      expect(h.statuses.at(-1)).toMatchObject({
        kind: "failed",
        reason: noWebgl ? "no-webgl2" : "core-load-failed",
      });
      expect(h.instances[0].free).toHaveBeenCalledTimes(1);
      expect(h.connections).toHaveLength(1);
      expect(h.c.toGame(1, 1)).toBeNull();
      expect(h.c.clientToGame(1, 1)).toBeNull();
      expect(pointerTargetResolver(h.c)(1, 1)).toBeNull();
      expect(error).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.connections).toHaveLength(1);
      h.refuseBuild(false);
      h.c.connect();
      expect(h.instances.map((g) => g.options.live_protocol)).toEqual([12, 13]);
      expect(h.connections.at(-1)).toMatchObject({
        sub: "render-stream.13",
        builtFor: 13,
      });
      h.open();
      expect(h.c.clientToGame(1, 1)?.item).toBe(7);
      expect(h.instances[1].to_game).toHaveBeenCalledWith(1, 1);
      expect(pointerTargetResolver(h.c)(1, 1)).toBeNull();
      expect(h.instances[1].hit_test).toHaveBeenCalledWith(1, 1);
      expect(error).not.toHaveBeenCalled();
      h.c.dispose();
      expect(h.instances.map((g) => g.free.mock.calls.length)).toEqual([1, 1]);
    } finally {
      probe.mockRestore();
      error.mockRestore();
    }
  });
});
