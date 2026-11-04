import { DecompressionStream as NodeDecompressionStream } from "node:stream/web";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RenderStreamEndpoint, validateEndpoint } from "../src/endpoint";
import {
  carrierTransport,
  type RenderStreamTransport,
  type RenderStreamTransportEvents,
} from "../src/transport";
import { createWebTransportTransport } from "../src/webtransport";
import {
  FakeTransport,
  FakeWebTransport,
  flush,
  frame,
  resourceResponse,
} from "./fakes";

const HASH = "ab".repeat(32);
const TOKEN = "0123456789abcdef".repeat(4);
const EP: RenderStreamEndpoint = {
  url: "ws://127.0.0.1:1/render-stream",
  resourceBase: "http://127.0.0.1:1",
  token: TOKEN,
  protocol: 13,
  webTransport: {
    url: "https://127.0.0.1:4433/render-stream",
    certificateHashes: [HASH],
  },
};
const SUB = "render-stream.13";

interface Rec {
  events: string[];
  messages: (ArrayBuffer | string)[];
  closes: { code: number; reason: string }[];
  on: RenderStreamTransportEvents;
}
function rec(): Rec {
  const r: Rec = {
    events: [],
    messages: [],
    closes: [],
    on: {
      open: () => r.events.push("open"),
      message: (d) => {
        r.events.push("message");
        r.messages.push(d);
      },
      close: (code, reason) => {
        r.events.push("close");
        r.closes.push({ code, reason });
      },
    },
  };
  return r;
}

const wtOf = () =>
  FakeWebTransport.instances[FakeWebTransport.instances.length - 1];

beforeEach(() => {
  FakeWebTransport.reset();
  vi.stubGlobal("WebTransport", FakeWebTransport);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("DecompressionStream", NodeDecompressionStream);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Connects and gets to `open`, with the live stream's type byte on the wire. */
async function opened(factory = createWebTransportTransport()) {
  const r = rec();
  const t = factory(EP, SUB, r.on);
  const wt = wtOf();
  wt.establish();
  await flush();
  return { r, t, wt };
}

describe("webTransportTransport: session", () => {
  it("opens url?protocol with pinned hashes, no pooling, and opens after the live stream", async () => {
    const r = rec();
    createWebTransportTransport()(EP, SUB, r.on);
    const wt = wtOf();
    expect(wt.url).toBe(
      "https://127.0.0.1:4433/render-stream?protocol=render-stream.13",
    );
    expect(wt.options.allowPooling).toBe(false);
    expect(wt.options.protocols).toBeUndefined();
    const hashes = wt.options.serverCertificateHashes as {
      algorithm: string;
      value: Uint8Array;
    }[];
    expect(hashes).toHaveLength(1);
    expect(hashes[0].algorithm).toBe("sha-256");
    expect([...hashes[0].value]).toEqual(Array(32).fill(0xab));
    expect(r.events).toEqual([]);
    wt.establish();
    await flush();
    expect(r.events).toEqual(["open"]);
    expect([...wt.streams[0].written()]).toEqual([0x00]);
  });

  it("keeps an existing query and omits hashes when the descriptor has none", () => {
    const e = validateEndpoint({
      ...EP,
      webTransport: { url: "https://h.example:4433/render-stream?x=1" },
    });
    createWebTransportTransport()(e, SUB, rec().on);
    expect(wtOf().url).toBe(
      "https://h.example:4433/render-stream?x=1&protocol=render-stream.13",
    );
    expect(wtOf().options.serverCertificateHashes).toBeUndefined();
  });

  it("negotiate offers protocols and requires agreement", async () => {
    const r = rec();
    createWebTransportTransport({ negotiate: true })(EP, SUB, r.on);
    const wt = wtOf();
    expect(wt.options.protocols).toEqual([SUB]);
    wt.protocol = "render-stream.12";
    wt.establish();
    await flush();
    expect(r.events).toEqual(["close"]);
    expect(r.closes[0].code).toBe(1002);
    expect(wt.closeCalls[0].closeCode).toBe(1002);
  });

  it("throws when the descriptor has no webTransport", () => {
    const { webTransport: _w, ...plain } = EP;
    expect(() => createWebTransportTransport()(plain, SUB, rec().on)).toThrow(
      /no webTransport/,
    );
  });
});

describe("webTransportTransport: live framing", () => {
  it("delivers text as string and binary as ArrayBuffer, boundaries kept", async () => {
    const { r, wt } = await opened();
    const s = wt.streams[0];
    s.serverSend(
      new Uint8Array([
        ...frame(1, '{"a":1}'),
        ...frame(0, new Uint8Array([1, 2, 3])),
        ...frame(0, new Uint8Array(0)),
      ]),
    );
    await flush();
    expect(r.messages[0]).toBe('{"a":1}');
    expect([...new Uint8Array(r.messages[1] as ArrayBuffer)]).toEqual([
      1, 2, 3,
    ]);
    expect((r.messages[2] as ArrayBuffer).byteLength).toBe(0);
    expect(r.messages).toHaveLength(3);
  });

  it("reassembles messages split at every byte offset of the header and body", async () => {
    const { r, wt } = await opened();
    const all = new Uint8Array([
      ...frame(1, "héllo"),
      ...frame(0, new Uint8Array([9, 8, 7, 6])),
    ]);
    for (let i = 0; i < all.length; i++)
      wt.streams[0].serverSend(all.subarray(i, i + 1));
    await flush();
    expect(r.messages[0]).toBe("héllo");
    expect([...new Uint8Array(r.messages[1] as ArrayBuffer)]).toEqual([
      9, 8, 7, 6,
    ]);
    expect(r.messages).toHaveLength(2);
  });

  it("splits a chunk that holds the tail of one message and the head of the next", async () => {
    const { r, wt } = await opened();
    const a = frame(1, "one");
    const b = frame(1, "two");
    wt.streams[0].serverSend(a.subarray(0, 6));
    wt.streams[0].serverSend(
      new Uint8Array([...a.subarray(6), ...b.subarray(0, 3)]),
    );
    wt.streams[0].serverSend(b.subarray(3));
    await flush();
    expect(r.messages).toEqual(["one", "two"]);
  });

  it("sends text framed kind 1, in order", async () => {
    const { t, wt } = await opened();
    t.send('{"type":"hello"}');
    t.send("ü");
    await flush();
    const w = wt.streams[0].written();
    expect([...w.subarray(0, 1)]).toEqual([0]);
    const expected = new Uint8Array([
      0,
      ...frame(1, '{"type":"hello"}'),
      ...frame(1, "ü"),
    ]);
    expect([...w]).toEqual([...expected]);
  });

  it("an unknown kind closes the session 1002", async () => {
    const { r, wt } = await opened();
    wt.streams[0].serverSend(new Uint8Array([7, 0, 0, 0, 0]));
    await flush();
    expect(wt.closeCalls[0].closeCode).toBe(1002);
    expect(r.closes).toEqual([
      { code: 1002, reason: "unknown message kind 7" },
    ]);
  });

  it("a message over 64 MiB closes the session 1009", async () => {
    const { r, wt } = await opened();
    wt.streams[0].serverSend(new Uint8Array([0, 1, 0, 0, 5]));
    await flush();
    expect(r.closes[0].code).toBe(1009);
  });
});

describe("webTransportTransport: close mapping", () => {
  it("delivers what the host sent before its close, then the close (finish-before-close)", async () => {
    const { r, wt } = await opened();
    wt.streams[0].serverSend(frame(1, "end"));
    wt.streams[0].serverFin();
    wt.serverClose({ closeCode: 1000, reason: "done" });
    await flush();
    expect(r.events).toEqual(["open", "message", "close"]);
    expect(r.closes).toEqual([{ code: 1000, reason: "done" }]);
  });

  it("delivers queued data even when the session close resets the stream", async () => {
    const { r, wt } = await opened();
    wt.streams[0].serverSend(frame(1, "end"));
    wt.serverClose({ closeCode: 1008, reason: "unauthorized" });
    await flush();
    expect(r.events).toEqual(["open", "message", "close"]);
    expect(r.closes).toEqual([{ code: 1008, reason: "unauthorized" }]);
  });

  it("maps close code 0 or none to 1005", async () => {
    const a = await opened();
    a.wt.serverClose({ closeCode: 0, reason: "" });
    await flush();
    expect(a.r.closes[0]).toEqual({ code: 1005, reason: "" });
    const b = await opened();
    b.wt.serverClose();
    await flush();
    expect(b.r.closes[0].code).toBe(1005);
  });

  it("maps a transport error after open to 1006", async () => {
    const { r, wt } = await opened();
    wt.fail(new Error("idle timeout"));
    await flush();
    expect(r.events).toEqual(["open", "close"]);
    expect(r.closes[0].code).toBe(1006);
    expect(r.closes[0].reason).toContain("idle timeout");
  });

  it("a reset live stream under an open session is a 1006 close", async () => {
    const { r, wt } = await opened();
    wt.streams[0].serverReset(new Error("stream reset"));
    await new Promise((res) => setTimeout(res, 150));
    expect(wt.closeCalls[0].closeCode).toBe(1006);
    expect(r.closes[0].code).toBe(1006);
  });

  it("reports 1006 without open when the session never establishes", async () => {
    const r = rec();
    createWebTransportTransport()(EP, SUB, r.on);
    wtOf().fail();
    await flush();
    expect(r.events).toEqual(["close"]);
    expect(r.closes[0].code).toBe(1006);
  });

  it("reports 1006 when the live stream cannot be created", async () => {
    const r = rec();
    createWebTransportTransport()(EP, SUB, r.on);
    const wt = wtOf();
    wt.streamError = new Error("no streams");
    wt.establish();
    await flush();
    expect(r.events).toEqual(["close"]);
    expect(r.closes[0].code).toBe(1006);
  });

  it("client close finishes the live stream, then closes the session with the code", async () => {
    const { r, t, wt } = await opened();
    t.send("ack");
    t.close(1000, "end seen");
    t.close(1001, "again");
    await flush();
    expect(wt.streams[0].finished()).toBe(true);
    expect(wt.closeCalls).toEqual([{ closeCode: 1000, reason: "end seen" }]);
    expect(r.closes).toEqual([{ code: 1000, reason: "end seen" }]);
    // nothing is read once the client closed
    expect(r.messages).toEqual([]);
  });

  it("truncates a long reason at a UTF-8 boundary to 123 bytes", async () => {
    const { t, wt } = await opened();
    t.close(1000, "é".repeat(100));
    await flush();
    const reason = wt.closeCalls[0].reason as string;
    expect(new TextEncoder().encode(reason).length).toBe(122);
    expect(reason).toBe("é".repeat(61));
  });

  it("a close before the session is ready closes the session directly", async () => {
    const r = rec();
    const t = createWebTransportTransport()(EP, SUB, r.on);
    t.close(1000, "x");
    await flush();
    expect(wtOf().closeCalls).toEqual([{ closeCode: 1000, reason: "x" }]);
    expect(r.closes).toEqual([{ code: 1000, reason: "x" }]);
    expect(r.events).not.toContain("open");
  });
});

describe("webTransportTransport: resource streams", () => {
  const PATH = `/resources/sha256/${HASH}`;
  const ctl = () => new AbortController().signal;

  async function get(
    t: RenderStreamTransport,
    wt: FakeWebTransport,
    reply: Uint8Array | null,
    token: string | null = TOKEN,
    path = PATH,
  ) {
    const p = t.fetchResource(path, { token, signal: ctl() });
    await flush();
    const s = wt.streams[wt.streams.length - 1];
    if (reply) {
      s.serverSend(reply);
      s.serverFin();
    }
    return { p, s };
  }

  it("writes type, accept, path and token, then FIN; returns a 200 body", async () => {
    const { t, wt } = await opened();
    const { p, s } = await get(
      t,
      wt,
      resourceResponse(200, 0, new Uint8Array([5, 6, 7])),
    );
    const res = await p;
    expect(res.status).toBe(200);
    expect([...new Uint8Array(res.body as ArrayBuffer)]).toEqual([5, 6, 7]);
    const w = s.written();
    const path = new TextEncoder().encode(PATH);
    expect(w[0]).toBe(0x01);
    expect(w[1]).toBe(0x01); // gzip accepted, zstd not (F2)
    expect(new DataView(w.buffer, w.byteOffset).getUint16(2, true)).toBe(
      path.length,
    );
    expect(new TextDecoder().decode(w.subarray(4, 4 + path.length))).toBe(PATH);
    expect(w[4 + path.length]).toBe(64);
    expect(new TextDecoder().decode(w.subarray(5 + path.length))).toBe(TOKEN);
    expect(s.finished()).toBe(true);
  });

  it("sends token_len 0 without a token and reads a response split across chunks", async () => {
    const { t, wt } = await opened();
    const resp = resourceResponse(200, 0, new Uint8Array([1, 2, 3, 4]));
    const p = t.fetchResource(PATH, { token: null, signal: ctl() });
    await flush();
    const s = wt.streams[1];
    expect(s.written()[4 + PATH.length]).toBe(0);
    expect(s.written().length).toBe(5 + PATH.length);
    s.serverSend(resp.subarray(0, 2));
    s.serverSend(resp.subarray(2, 8));
    s.serverSend(resp.subarray(8));
    s.serverFin();
    expect(new Uint8Array((await p).body as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it("reports 404 and 401 with a null body", async () => {
    const { t, wt } = await opened();
    for (const status of [404, 401, 503, 400]) {
      const { p } = await get(
        t,
        wt,
        resourceResponse(status, 0, new Uint8Array(0)),
      );
      expect(await p).toEqual({ status, body: null });
    }
  });

  it("decodes a gzip body", async () => {
    const { t, wt } = await opened();
    const raw = new Uint8Array(2000).map((_, i) => i % 7);
    const { p } = await get(
      t,
      wt,
      resourceResponse(200, 1, new Uint8Array(gzipSync(raw))),
    );
    expect(new Uint8Array((await p).body as ArrayBuffer)).toEqual(raw);
  });

  it("rejects an unrequested zstd coding, a coded error, and a length mismatch", async () => {
    const { t, wt } = await opened();
    const z = await get(t, wt, resourceResponse(200, 2, new Uint8Array([1])));
    await expect(z.p).rejects.toThrow(/coding 2/);
    const c = await get(t, wt, resourceResponse(404, 1, new Uint8Array(0)));
    await expect(c.p).rejects.toThrow(/coded error/);
    const short = await get(
      t,
      wt,
      resourceResponse(200, 0, new Uint8Array([1, 2]), 5),
    );
    await expect(short.p).rejects.toThrow(/header says 5/);
    const trunc = await get(t, wt, new Uint8Array([200, 0]));
    await expect(trunc.p).rejects.toThrow(/truncated/);
  });

  it("rejects a bad token and an over-long path before opening a stream", async () => {
    const { t, wt } = await opened();
    await expect(
      t.fetchResource(PATH, { token: "xyz", signal: ctl() }),
    ).rejects.toThrow(/token/);
    await expect(
      t.fetchResource(`/${"a".repeat(1025)}`, { token: null, signal: ctl() }),
    ).rejects.toThrow(/too long/);
    expect(wt.streams).toHaveLength(1);
  });

  it("aborts an in-flight GET", async () => {
    const { t, wt } = await opened();
    const ac = new AbortController();
    const p = t.fetchResource(PATH, { token: null, signal: ac.signal });
    p.catch(() => {});
    await flush();
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(wt.streams[1].cancelled()).toBe(true);
  });

  it("caches bodies by path (F3): the second GET opens no stream; LRU bound holds", async () => {
    const { t, wt } = await opened(
      createWebTransportTransport({ cacheBytes: 10 }),
    );
    const a = await get(
      t,
      wt,
      resourceResponse(200, 0, new Uint8Array(6).fill(1)),
    );
    await a.p;
    const hit = await t.fetchResource(PATH, { token: null, signal: ctl() });
    expect(hit.status).toBe(200);
    expect(wt.streams).toHaveLength(2);
    // a second 6-byte body evicts the first (10-byte bound)
    const other = `/resources/sha256/${"cd".repeat(32)}`;
    const b = await get(
      t,
      wt,
      resourceResponse(200, 0, new Uint8Array(6).fill(2)),
      null,
      other,
    );
    await b.p;
    const again = t.fetchResource(PATH, { token: null, signal: ctl() });
    await flush();
    expect(wt.streams).toHaveLength(4);
    wt.streams[3].serverSend(resourceResponse(404, 0, new Uint8Array(0)));
    wt.streams[3].serverFin();
    expect((await again).status).toBe(404);
  });

  it("returns an independent copy from the cache and caches nothing when off", async () => {
    const { t, wt } = await opened(createWebTransportTransport());
    const a = await get(
      t,
      wt,
      resourceResponse(200, 0, new Uint8Array([4, 4])),
    );
    const first = (await a.p).body as ArrayBuffer;
    const hit1 = (await t.fetchResource(PATH, { token: null, signal: ctl() }))
      .body as ArrayBuffer;
    expect(hit1).not.toBe(first);
    new Uint8Array(hit1)[0] = 9;
    const hit2 = (await t.fetchResource(PATH, { token: null, signal: ctl() }))
      .body as ArrayBuffer;
    expect([...new Uint8Array(hit2)]).toEqual([4, 4]);

    const off = await opened(createWebTransportTransport({ cacheBytes: 0 }));
    const x = await get(
      off.t,
      off.wt,
      resourceResponse(200, 0, new Uint8Array([1])),
    );
    await x.p;
    const y = off.t.fetchResource(PATH, { token: null, signal: ctl() });
    await flush();
    expect(off.wt.streams).toHaveLength(3);
    y.catch(() => {});
  });
});

describe("carrierTransport", () => {
  function setup(
    carrier: "auto" | "websocket" | "webtransport",
    openTimeoutMs?: number,
  ) {
    const wsMade: FakeTransport[] = [];
    const wsOn: RenderStreamTransportEvents[] = [];
    const factory = carrierTransport(carrier, {
      websocket: (_e, sub, on) => {
        const t = new FakeTransport(sub, on);
        wsMade.push(t);
        wsOn.push(on);
        return t;
      },
      webtransport: async () => createWebTransportTransport(),
      openTimeoutMs,
    });
    return { factory, wsMade };
  }

  it("auto uses WebSocket without descriptor webTransport (one property test)", () => {
    const { factory, wsMade } = setup("auto");
    const { webTransport: _w, ...plain } = EP;
    factory(plain, SUB, rec().on);
    expect(wsMade).toHaveLength(1);
    expect(FakeWebTransport.instances).toHaveLength(0);
  });

  it("auto uses WebSocket when the page has no WebTransport global", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("isSecureContext", true);
    const g = globalThis as { WebTransport?: unknown };
    const saved = g.WebTransport;
    delete g.WebTransport;
    try {
      const { factory, wsMade } = setup("auto");
      factory(EP, SUB, rec().on);
      expect(wsMade).toHaveLength(1);
    } finally {
      if (saved) g.WebTransport = saved;
    }
  });

  it("auto uses WebSocket in an insecure context", () => {
    vi.stubGlobal("isSecureContext", false);
    const { factory, wsMade } = setup("auto");
    factory(EP, SUB, rec().on);
    expect(wsMade).toHaveLength(1);
    expect(FakeWebTransport.instances).toHaveLength(0);
  });

  it("auto uses WebTransport when offered and available, and open passes through", async () => {
    const { factory, wsMade } = setup("auto");
    const r = rec();
    factory(EP, SUB, r.on);
    await flush();
    wtOf().establish();
    await flush();
    expect(r.events).toEqual(["open"]);
    expect(wsMade).toHaveLength(0);
  });

  it("auto falls back to WebSocket in the same attempt when WebTransport fails before open, and sticks", async () => {
    const { factory, wsMade } = setup("auto");
    const r = rec();
    const t = factory(EP, SUB, r.on);
    await flush();
    wtOf().fail();
    await flush();
    expect(r.events).toEqual([]); // the failed attempt is not reported
    expect(wsMade).toHaveLength(1);
    // the returned transport now drives the WebSocket
    t.send('{"type":"hello"}');
    expect(wsMade[0].sent).toEqual([{ type: "hello" }]);
    wsMade[0].on.open();
    expect(r.events).toEqual(["open"]);
    // sticky: a reconnect goes straight to WebSocket
    const n = FakeWebTransport.instances.length;
    factory(EP, SUB, rec().on);
    expect(FakeWebTransport.instances).toHaveLength(n);
    expect(wsMade).toHaveLength(2);
  });

  it("auto falls back when the session closes before open without a failure", async () => {
    const { factory, wsMade } = setup("auto");
    const r = rec();
    factory(EP, SUB, r.on);
    await flush();
    wtOf().serverClose({ closeCode: 0 });
    await flush();
    expect(wsMade).toHaveLength(1);
    expect(r.events).toEqual([]);
  });

  it("auto falls back after the open timeout and ignores the abandoned attempt", async () => {
    vi.useFakeTimers();
    const { factory, wsMade } = setup("auto", 3000);
    const r = rec();
    factory(EP, SUB, r.on);
    await vi.advanceTimersByTimeAsync(0);
    const wt = wtOf();
    await vi.advanceTimersByTimeAsync(2999);
    expect(wsMade).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(wsMade).toHaveLength(1);
    expect(wt.closeCalls).toHaveLength(1);
    // a late open or close of the abandoned attempt is dropped
    wt.establish();
    await vi.advanceTimersByTimeAsync(10);
    expect(r.events).toEqual([]);
  });

  it("auto does not fall back after open: the failure is an ordinary close", async () => {
    const { factory, wsMade } = setup("auto");
    const r = rec();
    factory(EP, SUB, r.on);
    await flush();
    wtOf().establish();
    await flush();
    wtOf().fail(new Error("lost"));
    await flush();
    expect(r.events).toEqual(["open", "close"]);
    expect(r.closes[0].code).toBe(1006);
    expect(wsMade).toHaveLength(0);
    // and WebTransport is still tried on the next connect (not sticky)
    factory(EP, SUB, rec().on);
    await flush();
    expect(FakeWebTransport.instances).toHaveLength(2);
  });

  it("a user close during the attempt does not fall back", async () => {
    const { factory, wsMade } = setup("auto");
    const r = rec();
    const t = factory(EP, SUB, r.on);
    t.close(1000, "dispose");
    await flush();
    expect(wsMade).toHaveLength(0);
    expect(r.closes).toEqual([{ code: 1000, reason: "dispose" }]);
  });

  it("a WebTransport constructor that throws falls back to WebSocket", async () => {
    vi.stubGlobal(
      "WebTransport",
      class {
        constructor() {
          throw new TypeError("bad");
        }
      },
    );
    const { factory, wsMade } = setup("auto");
    factory(EP, SUB, rec().on);
    await flush();
    expect(wsMade).toHaveLength(1);
  });

  it("a chunk that fails to load falls back to WebSocket in auto, closes 1006 otherwise", async () => {
    const boom = async () => {
      throw new Error("chunk 404");
    };
    const wsMade: FakeTransport[] = [];
    const ws = (
      _e: RenderStreamEndpoint,
      sub: string,
      on: RenderStreamTransportEvents,
    ) => {
      const t = new FakeTransport(sub, on);
      wsMade.push(t);
      return t;
    };
    carrierTransport("auto", { websocket: ws, webtransport: boom })(
      EP,
      SUB,
      rec().on,
    );
    await flush();
    expect(wsMade).toHaveLength(1);
    const r = rec();
    carrierTransport("webtransport", { websocket: ws, webtransport: boom })(
      EP,
      SUB,
      r.on,
    );
    await flush();
    expect(r.closes[0].code).toBe(1006);
    expect(wsMade).toHaveLength(1);
  });

  it("webtransport never falls back; websocket never uses WebTransport", async () => {
    const a = setup("webtransport");
    const r = rec();
    a.factory(EP, SUB, r.on);
    await flush();
    wtOf().fail();
    await flush();
    expect(r.events).toEqual(["close"]);
    expect(r.closes[0].code).toBe(1006);
    expect(a.wsMade).toHaveLength(0);
    const none = rec();
    a.factory({ ...EP, webTransport: undefined }, SUB, none.on);
    await flush();
    expect(none.closes[0].code).toBe(1006);

    const n = FakeWebTransport.instances.length;
    const b = setup("websocket");
    b.factory(EP, SUB, rec().on);
    expect(b.wsMade).toHaveLength(1);
    expect(FakeWebTransport.instances).toHaveLength(n);
  });
});
