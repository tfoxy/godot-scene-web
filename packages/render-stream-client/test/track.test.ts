import { describe, expect, it } from "vitest";
import type { RenderStreamEndpoint } from "../src/endpoint";
import {
  type OpenTrackOptions,
  openTrack,
  RenderStreamTrackError,
  TRACK_SUBPROTOCOL,
  type TrackCloseInfo,
  type TrackReady,
  type TrackState,
  trackDisposition,
} from "../src/track";
import type {
  RenderStreamTransport,
  RenderStreamTransportEvents,
  RenderStreamTransportFactory,
} from "../src/transport";

const CRED = "ab".repeat(32);
const VIEW_TOKEN = "cd".repeat(32);

/** A manual clock: timers run in due order as `advance` moves time. */
class Clock {
  t = 0;
  private id = 0;
  private timers: { id: number; at: number; cb: () => void }[] = [];
  now = () => this.t;
  setTimeout = (cb: () => void, ms: number) => {
    const id = ++this.id;
    this.timers.push({ id, at: this.t + ms, cb });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== id);
  };
  random = () => 0.5; // jitter factor exactly 1
  pending = () => this.timers.length;
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers
        .filter((x) => x.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.cb();
    }
    this.t = end;
  }
}

class FakeLink implements RenderStreamTransport {
  readonly carrier = "websocket" as const;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(
    readonly endpoint: RenderStreamEndpoint,
    readonly subprotocol: string,
    readonly on: RenderStreamTransportEvents,
  ) {}
  send(text: string): void {
    this.sent.push(text);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  fetchResource(): never {
    throw new Error("a track fetches nothing");
  }
  // The host's side.
  open(): void {
    this.on.open();
  }
  text(t: string): void {
    this.on.message(t);
  }
  hostClose(code: number, reason: string): void {
    this.on.close(code, reason);
  }
  readyWith(extra: Record<string, unknown> = {}): void {
    this.text(
      JSON.stringify({
        type: "track-ready",
        protocol: "render-stream-track/1",
        source: 7,
        kind: "input",
        format: "gsw-input/1",
        down_format: null,
        keepalive_ms: 1000,
        max_message_bytes: 4096,
        rate: { messages_per_second: 1000, burst: 2000 },
        ...extra,
      }),
    );
  }
  error(reason: string, detail = ""): void {
    this.text(JSON.stringify({ type: "track-error", reason, detail }));
  }
  /** The host's refusal as rs_tracks writes it: the text, then the close with the same reason. */
  refuse(code: number, reason: string, detail = ""): void {
    this.error(reason, detail);
    this.hostClose(code, reason);
  }
}

interface Rig {
  clock: Clock;
  links: FakeLink[];
  opens: TrackReady[];
  messages: string[];
  closes: TrackCloseInfo[];
  states: TrackState[];
  link(): FakeLink;
  sink: ReturnType<typeof openTrack>;
}

async function rig(
  over: Partial<OpenTrackOptions> = {},
  endpoint: Parameters<typeof openTrack>[0] = {
    url: "ws://127.0.0.1:1/render-stream",
  },
): Promise<Rig> {
  const clock = new Clock();
  const links: FakeLink[] = [];
  const r = {
    clock,
    links,
    opens: [] as TrackReady[],
    messages: [] as string[],
    closes: [] as TrackCloseInfo[],
    states: [] as TrackState[],
  };
  const transport: RenderStreamTransportFactory = (ep, sub, on) => {
    const l = new FakeLink(ep, sub, on);
    links.push(l);
    return l;
  };
  const sink = openTrack(endpoint, {
    kind: "input",
    formats: ["gsw-input/1"],
    credential: CRED,
    transport,
    clock,
    onOpen: (x) => r.opens.push(x),
    onMessage: (t) => r.messages.push(t),
    onClose: (i) => r.closes.push(i),
    onState: (s) => r.states.push(s),
    ...over,
  });
  await Promise.resolve();
  return {
    ...r,
    sink,
    link: () => links[links.length - 1],
  };
}

async function open(over: Partial<OpenTrackOptions> = {}): Promise<Rig> {
  const r = await rig(over);
  r.link().open();
  r.link().readyWith();
  return r;
}

describe("openTrack: handshake", () => {
  it("connects once with the track subprotocol and a transport-shaped endpoint", async () => {
    const r = await rig(undefined, {
      url: "ws://127.0.0.1:1/render-stream",
      token: VIEW_TOKEN,
    });
    expect(r.links).toHaveLength(1);
    expect(r.link().subprotocol).toBe("render-stream-track.1");
    expect(TRACK_SUBPROTOCOL).toBe("render-stream-track.1");
    expect(r.link().endpoint).toMatchObject({
      url: "ws://127.0.0.1:1/render-stream",
      resourceBase: "",
      token: null,
    });
    expect(r.sink.state).toBe("connecting");
    expect(r.link().sent).toEqual([]); // no hello before the transport opens
  });

  it("sends the hello with kind, formats and the credential once the transport opens", async () => {
    const r = await rig({
      downFormats: ["gsw-input-feedback/1"],
      client: "couch-web",
      view: { stream_id: "0d".repeat(16), connection: 2 },
    });
    r.link().open();
    expect(r.link().sent).toHaveLength(1);
    expect(JSON.parse(r.link().sent[0])).toEqual({
      type: "track-hello",
      protocol: "render-stream-track/1",
      kind: "input",
      formats: ["gsw-input/1"],
      down_formats: ["gsw-input-feedback/1"],
      credential: CRED,
      client: "couch-web",
      view: { stream_id: "0d".repeat(16), connection: 2 },
    });
  });

  it("omits client and view when not given, and never sends the endpoint token", async () => {
    const r = await rig(undefined, {
      url: "ws://127.0.0.1:1/render-stream",
      token: VIEW_TOKEN,
    });
    r.link().open();
    const hello = JSON.parse(r.link().sent[0]);
    expect(hello).not.toHaveProperty("client");
    expect(hello).not.toHaveProperty("view");
    expect(r.link().sent[0]).not.toContain(VIEW_TOKEN);
  });

  it("handles track-ready: open state, camelCase ready, onOpen once", async () => {
    const r = await rig();
    r.link().open();
    expect(r.sink.ready).toBeNull();
    r.link().readyWith({ down_format: null });
    const want: TrackReady = {
      source: 7,
      kind: "input",
      format: "gsw-input/1",
      downFormat: null,
      keepaliveMs: 1000,
      maxMessageBytes: 4096,
      rate: { messagesPerSecond: 1000, burst: 2000 },
    };
    expect(r.sink.state).toBe("open");
    expect(r.sink.ready).toEqual(want);
    expect(r.opens).toEqual([want]);
    expect(r.states).toEqual(["open"]); // connecting is the initial state
  });

  it("accepts a negotiated down format that it offered", async () => {
    const r = await rig({ downFormats: ["gsw-input-feedback/1"] });
    r.link().open();
    r.link().readyWith({ down_format: "gsw-input-feedback/1" });
    expect(r.sink.ready?.downFormat).toBe("gsw-input-feedback/1");
  });

  it("ignores unknown members of track-ready (additive /1)", async () => {
    const r = await rig();
    r.link().open();
    r.link().readyWith({ future: { x: 1 } });
    expect(r.sink.state).toBe("open");
  });
});

describe("openTrack: refusals are typed closes, never throws", () => {
  // Q1.4 rows: [reason, code, retried]
  const rows: [string, number, boolean][] = [
    ["track-protocol", 1002, false],
    ["track-utf8", 1007, false],
    ["track-hello-timeout", 1002, true],
    ["track-kind-refused", 1008, false],
    ["track-unauthorized", 1008, false],
    ["track-no-receiver", 1013, true],
    ["track-format-refused", 1008, false],
    ["track-rate", 1008, true],
    ["track-idle", 1001, true],
    ["track-receiver-gone", 1013, true],
    ["track-closed", 1000, true],
    ["track-closed", 4001, false],
    ["stream-ended", 1001, true],
    ["message-too-large", 1009, false],
  ];
  for (const [reason, code, retried] of rows) {
    it(`${reason} ${code} ${retried ? "reconnects" : "stays closed"}`, async () => {
      const r = await rig();
      r.link().open();
      r.link().refuse(code, reason, "x");
      expect(r.closes).toHaveLength(1);
      expect(r.closes[0]).toMatchObject({
        code,
        reason,
        detail: "x",
        by: "host",
        opened: false,
        willReconnect: retried,
      });
      expect(r.sink.state).toBe(retried ? "reconnecting" : "closed");
      expect(trackDisposition(code, reason).retry).toBe(retried);
    });
  }

  it("reports the view-token refusal with its detail", async () => {
    const r = await rig();
    r.link().open();
    r.link().refuse(1008, "track-unauthorized", "view-token");
    expect(r.closes[0]).toMatchObject({
      reason: "track-unauthorized",
      detail: "view-token",
    });
  });

  it("takes the reason from the close frame when the track-error text never arrived", async () => {
    const r = await rig();
    r.link().open();
    r.link().hostClose(1008, "track-kind-refused");
    expect(r.closes[0]).toMatchObject({
      reason: "track-kind-refused",
      detail: null,
      willReconnect: false,
    });
  });

  it("takes the reason from the track-error text when the close carried none", async () => {
    const r = await rig();
    r.link().open();
    r.link().error("track-format-refused", "none-common");
    r.link().hostClose(1008, "");
    expect(r.closes[0]).toMatchObject({
      reason: "track-format-refused",
      detail: "none-common",
      willReconnect: false,
    });
  });

  it("waits at least a second after track-rate", async () => {
    const r = await rig();
    r.link().open();
    r.link().refuse(1008, "track-rate");
    expect(r.closes[0].reconnectInMs).toBe(1000);
  });

  it("falls back to the close code for a reason it does not know", () => {
    expect(trackDisposition(1008, "track-future")).toEqual({
      retry: false,
      minDelayMs: 0,
    });
    expect(trackDisposition(4500, "x").retry).toBe(false);
    expect(trackDisposition(1013, "track-future").retry).toBe(true);
    expect(trackDisposition(1001, "").retry).toBe(true);
    expect(trackDisposition(1006, "").retry).toBe(true);
    expect(trackDisposition(1000, "uplink-stalled: 3 batches").retry).toBe(
      true,
    );
  });

  it("a wrong credential stays closed: no new connection however long it waits", async () => {
    const r = await rig();
    r.link().open();
    r.link().refuse(1008, "track-unauthorized", "wrong");
    r.clock.advance(600_000);
    await Promise.resolve();
    expect(r.links).toHaveLength(1);
    expect(r.clock.pending()).toBe(0);
    expect(r.sink.state).toBe("closed");
    await expect(r.sink.finished).resolves.toMatchObject({
      reason: "track-unauthorized",
      detail: "wrong",
    });
  });

  it("treats a transport failure before open (1006) as retryable by transport", async () => {
    const r = await rig();
    r.link().hostClose(1006, "");
    expect(r.closes[0]).toMatchObject({
      code: 1006,
      by: "transport",
      opened: false,
      willReconnect: true,
    });
  });

  it("treats a factory that throws as a retryable transport failure", async () => {
    const clock = new Clock();
    const closes: TrackCloseInfo[] = [];
    openTrack(
      { url: "ws://127.0.0.1:1/render-stream" },
      {
        kind: "input",
        formats: ["gsw-input/1"],
        credential: CRED,
        clock,
        transport: () => {
          throw new Error("boom");
        },
        onClose: (i) => closes.push(i),
      },
    );
    await Promise.resolve();
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      code: 1006,
      by: "transport",
      willReconnect: true,
    });
    expect(closes[0].reason).toContain("boom");
  });
});

describe("openTrack: a reply it cannot accept ends the track for good", () => {
  const cases: [string, (l: FakeLink) => void, string][] = [
    ["not JSON", (l) => l.text("hello"), "track-protocol"],
    ["a payload before ready", (l) => l.text('{"n":1}'), "track-protocol"],
    [
      "another kind",
      (l) => l.readyWith({ kind: "clipboard" }),
      "track-protocol",
    ],
    [
      "a format it never offered",
      (l) => l.readyWith({ format: "gsw-input/2" }),
      "track-protocol",
    ],
    [
      "a down format it never offered",
      (l) => l.readyWith({ down_format: "gsw-input-feedback/1" }),
      "track-protocol",
    ],
    [
      "a zero keepalive",
      (l) => l.readyWith({ keepalive_ms: 0 }),
      "track-protocol",
    ],
    ["a missing rate", (l) => l.readyWith({ rate: null }), "track-protocol"],
    [
      "the wrong protocol",
      (l) => l.readyWith({ protocol: "render-stream-track/2" }),
      "track-protocol",
    ],
  ];
  for (const [name, act, reason] of cases) {
    it(name, async () => {
      const r = await rig();
      r.link().open();
      act(r.link());
      expect(r.link().closed?.reason).toBe(reason);
      expect(r.closes[0]).toMatchObject({
        reason,
        by: "client",
        willReconnect: false,
      });
      expect(r.sink.state).toBe("closed");
    });
  }

  it("a binary message is a protocol violation (text only)", async () => {
    const r = await open();
    r.link().on.message(new ArrayBuffer(4));
    expect(r.closes[0]).toMatchObject({
      code: 1003,
      reason: "track-binary",
      by: "client",
      opened: true,
      willReconnect: false,
    });
  });

  it("closes track-ready-timeout when the host never answers, and retries", async () => {
    const r = await rig({ readyTimeoutMs: 2000 });
    r.link().open();
    r.clock.advance(1999);
    expect(r.closes).toHaveLength(0);
    r.clock.advance(1);
    expect(r.closes[0]).toMatchObject({
      reason: "track-ready-timeout",
      by: "client",
      willReconnect: true,
    });
    expect(r.link().closed?.reason).toBe("track-ready-timeout");
  });
});

describe("openTrack: payload phase", () => {
  it("send is false and queues nothing before ready", async () => {
    const r = await rig();
    expect(r.sink.send("early")).toBe(false);
    r.link().open();
    expect(r.sink.send("early2")).toBe(false);
    r.link().readyWith();
    expect(r.link().sent).toHaveLength(1); // the hello only
    expect(r.sink.stats().dropped.notOpen).toBe(2);
  });

  it("sends payloads verbatim after ready", async () => {
    const r = await open();
    expect(r.sink.send('{"t":"key","k":"é→😀"}')).toBe(true);
    expect(r.link().sent.at(-1)).toBe('{"t":"key","k":"é→😀"}');
    expect(r.sink.stats().sent).toBe(1);
  });

  it("refuses the empty text (that is the keepalive) and anything over max_message_bytes", async () => {
    const r = await open();
    r.link().sent.length = 0;
    expect(r.sink.send("")).toBe(false);
    expect(r.sink.send("x".repeat(4096))).toBe(true);
    expect(r.sink.send("x".repeat(4097))).toBe(false);
    // 1366 three-byte characters are 4098 bytes though only 1366 UTF-16 units.
    expect(r.sink.send("€".repeat(1366))).toBe(false);
    expect(r.sink.send("€".repeat(1365))).toBe(true);
    expect(r.link().sent).toHaveLength(2);
    expect(r.sink.stats().dropped).toMatchObject({ empty: 1, tooLarge: 2 });
  });

  it("drops (never queues) what the host's token bucket would refuse", async () => {
    const r = await rig();
    r.link().open();
    r.link().readyWith({ rate: { messages_per_second: 10, burst: 3 } });
    r.link().sent.length = 0;
    const results = [1, 2, 3, 4].map((i) => r.sink.send(`p${i}`));
    expect(results).toEqual([true, true, true, false]);
    r.clock.advance(100); // one token back
    expect(r.sink.send("p5")).toBe(true);
    expect(r.link().sent).toEqual(["p1", "p2", "p3", "p5"]);
    expect(r.sink.stats().dropped.rate).toBe(1);
  });

  it("delivers down payloads verbatim, even one that looks like a hello", async () => {
    const r = await rig({ downFormats: ["gsw-input-feedback/1"] });
    r.link().open();
    r.link().readyWith({ down_format: "gsw-input-feedback/1" });
    const hello = JSON.stringify({ type: "track-hello", kind: "input" });
    r.link().text(hello);
    r.link().text('{"rumble":1}');
    expect(r.messages).toEqual([hello, '{"rumble":1}']);
  });

  it("never delivers a keepalive", async () => {
    const r = await open();
    r.link().text("");
    r.link().text("");
    expect(r.messages).toEqual([]);
  });

  it("keeps back the host's closing track-error and uses its detail", async () => {
    const r = await open();
    r.link().error("track-closed", "bye");
    expect(r.messages).toEqual([]);
    r.link().hostClose(4001, "track-closed");
    expect(r.closes[0]).toMatchObject({
      code: 4001,
      reason: "track-closed",
      detail: "bye",
      opened: true,
      willReconnect: false,
    });
  });
});

describe("openTrack: keepalive and idle", () => {
  it("sends an empty text after keepalive_ms without a send, and not before", async () => {
    const r = await open();
    r.link().sent.length = 0;
    r.clock.advance(999);
    expect(r.link().sent).toEqual([]);
    r.clock.advance(1);
    expect(r.link().sent).toEqual([""]);
    r.clock.advance(1000);
    expect(r.link().sent).toEqual(["", ""]);
    expect(r.sink.stats().keepalivesSent).toBe(2);
  });

  it("a payload resets the keepalive timer", async () => {
    const r = await open();
    r.link().sent.length = 0;
    r.clock.advance(600);
    r.sink.send("a");
    r.clock.advance(600);
    expect(r.link().sent).toEqual(["a"]);
    r.clock.advance(400);
    expect(r.link().sent).toEqual(["a", ""]);
  });

  it("follows the keepalive_ms the host granted", async () => {
    const r = await rig();
    r.link().open();
    r.link().readyWith({ keepalive_ms: 250 });
    r.link().sent.length = 0;
    r.clock.advance(250);
    expect(r.link().sent).toEqual([""]);
  });

  it("closes track-idle after 3 x keepalive_ms with nothing received, then reconnects", async () => {
    const r = await open();
    r.clock.advance(2999);
    expect(r.closes).toHaveLength(0);
    r.clock.advance(1);
    expect(r.closes).toHaveLength(1);
    expect(r.closes[0]).toMatchObject({
      code: 1001,
      reason: "track-idle",
      by: "client",
      opened: true,
      willReconnect: true,
    });
    // 1001 cannot be written by a browser: the wire code is 1000, the reason is kept.
    expect(r.link().closed).toEqual({ code: 1000, reason: "track-idle" });
    expect(r.sink.state).toBe("reconnecting");
  });

  it("anything received (payload or keepalive) postpones the idle close", async () => {
    const r = await open();
    r.clock.advance(2500);
    r.link().text(""); // the host's keepalive
    r.clock.advance(2500);
    expect(r.closes).toHaveLength(0);
    r.link().text('{"x":1}');
    r.clock.advance(2999);
    expect(r.closes).toHaveLength(0);
    r.clock.advance(1);
    expect(r.closes[0].reason).toBe("track-idle");
  });

  it("a closed track runs no timers", async () => {
    const r = await open();
    r.sink.close();
    expect(r.clock.pending()).toBe(0);
  });
});

describe("openTrack: reconnect", () => {
  it("doubles the delay to the cap, each attempt a fresh hello", async () => {
    const r = await rig({ reconnect: { initialMs: 250, maxMs: 1000 } });
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      r.link().open();
      r.link().hostClose(1013, "track-no-receiver");
      delays.push(r.closes[i].reconnectInMs as number);
      expect(r.sink.state).toBe("reconnecting");
      r.clock.advance(r.closes[i].reconnectInMs as number);
      expect(r.links).toHaveLength(i + 2);
    }
    expect(delays).toEqual([250, 500, 1000, 1000, 1000]);
    expect(r.links.every((l) => l.subprotocol === TRACK_SUBPROTOCOL)).toBe(
      true,
    );
    r.link().open();
    expect(JSON.parse(r.link().sent[0]).type).toBe("track-hello");
  });

  it("applies jitter of +-20% around the doubling delay", async () => {
    for (const [random, want] of [
      [0, 200],
      [0.5, 250],
      [0.999, 300],
    ] as const) {
      const clock = new Clock();
      clock.random = () => random;
      const r = await rig({ clock });
      r.link().hostClose(1006, "");
      expect(r.closes[0].reconnectInMs).toBe(want);
      r.sink.close();
    }
  });

  it("calls onOpen again and resets the backoff once ready", async () => {
    const r = await rig();
    r.link().hostClose(1006, "");
    r.clock.advance(250);
    r.link().open();
    r.link().readyWith();
    expect(r.opens).toHaveLength(1);
    r.link().hostClose(1013, "track-receiver-gone");
    expect(r.closes[1]).toMatchObject({
      opened: true,
      willReconnect: true,
      reconnectInMs: 250,
    });
    r.clock.advance(250);
    r.link().open();
    r.link().readyWith({ source: 8 });
    expect(r.opens.map((o) => o.source)).toEqual([7, 8]);
    expect(r.sink.state).toBe("open");
    expect(r.states).toEqual([
      "reconnecting",
      "connecting",
      "open",
      "reconnecting",
      "connecting",
      "open",
    ]);
  });

  it("reconnect:false never reconnects", async () => {
    const r = await open({ reconnect: false });
    r.link().hostClose(1013, "track-receiver-gone");
    expect(r.closes[0].willReconnect).toBe(false);
    expect(r.sink.state).toBe("closed");
    r.clock.advance(60_000);
    expect(r.links).toHaveLength(1);
  });

  it("drops what a closed connection still says", async () => {
    const r = await open();
    const old = r.link();
    old.hostClose(1013, "track-receiver-gone");
    old.text('{"late":1}');
    old.hostClose(1006, "");
    expect(r.messages).toEqual([]);
    expect(r.closes).toHaveLength(1);
  });
});

describe("openTrack: close and dispose", () => {
  it("close() ends the connection once, never reconnects, and settles finished", async () => {
    const r = await open();
    r.sink.close();
    r.sink.close();
    expect(r.link().closed).toEqual({ code: 1000, reason: "client-close" });
    expect(r.closes).toHaveLength(1);
    expect(r.closes[0]).toMatchObject({
      code: 1000,
      by: "client",
      opened: true,
      willReconnect: false,
    });
    expect(r.sink.state).toBe("closed");
    expect(r.sink.ready).toBeNull();
    expect(r.sink.send("x")).toBe(false);
    r.link().hostClose(1000, "client-close"); // the transport's own close event
    r.clock.advance(60_000);
    expect(r.closes).toHaveLength(1);
    expect(r.links).toHaveLength(1);
    expect(r.states.at(-1)).toBe("closed");
    expect((await r.sink.finished).by).toBe("client");
  });

  it("close() while reconnecting cancels the retry without a second onClose", async () => {
    const r = await rig();
    r.link().hostClose(1006, "");
    expect(r.sink.state).toBe("reconnecting");
    r.sink.close();
    expect(r.closes).toHaveLength(1);
    r.clock.advance(60_000);
    expect(r.links).toHaveLength(1);
    expect(r.clock.pending()).toBe(0);
    expect((await r.sink.finished).code).toBe(1006);
  });

  it("close() before the first connection leaves nothing to connect", async () => {
    const clock = new Clock();
    const links: FakeLink[] = [];
    const sink = openTrack(
      { url: "ws://127.0.0.1:1/render-stream" },
      {
        kind: "input",
        formats: ["gsw-input/1"],
        credential: CRED,
        clock,
        transport: (ep, sub, on) => {
          const l = new FakeLink(ep, sub, on);
          links.push(l);
          return l;
        },
      },
    );
    sink.close();
    await Promise.resolve();
    expect(links).toHaveLength(0);
    expect(sink.state).toBe("closed");
    await expect(sink.finished).resolves.toMatchObject({ by: "client" });
  });

  it("writes a custom close code the browser may send, and 1000 otherwise", async () => {
    const a = await open();
    a.sink.close(4000, "app-done");
    expect(a.link().closed).toEqual({ code: 4000, reason: "app-done" });
    const b = await open();
    b.sink.close(1001, "going");
    expect(b.link().closed).toEqual({ code: 1000, reason: "going" });
  });
});

describe("openTrack: options", () => {
  const base = {
    kind: "input",
    formats: ["gsw-input/1"],
    credential: CRED,
  };
  const ep = { url: "ws://127.0.0.1:1/render-stream" };
  const code = (f: () => unknown): string | null => {
    try {
      f();
      return null;
    } catch (e) {
      return e instanceof RenderStreamTrackError ? e.code : "other";
    }
  };

  it("throws track-credential-is-view-token when the credential is the endpoint token", () => {
    expect(
      code(() =>
        openTrack(
          { ...ep, token: VIEW_TOKEN },
          { ...base, credential: VIEW_TOKEN },
        ),
      ),
    ).toBe("track-credential-is-view-token");
  });

  it("throws track-options-invalid for a hello the host would refuse", () => {
    const bad: Partial<OpenTrackOptions>[] = [
      { kind: "Input" },
      { kind: "" },
      { formats: [] },
      { formats: ["gsw-input"] },
      { formats: ["gsw-input/0"] },
      { formats: ["gsw-input/65536"] },
      { formats: ["gsw-input/1", "gsw-input/1"] },
      { formats: Array.from({ length: 9 }, (_, i) => `f/${i + 1}`) },
      { downFormats: ["Bad/1"] },
      { credential: "" },
      { client: "has space" },
      { view: { stream_id: "short", connection: 1 } },
      { view: { stream_id: "0d".repeat(16), connection: 0 } },
      { credential: "x".repeat(5000) },
    ];
    for (const o of bad)
      expect(
        code(() => openTrack(ep, { ...base, ...o })),
        JSON.stringify(o),
      ).toBe("track-options-invalid");
  });

  it("throws the endpoint validator's error for an unusable url", () => {
    expect(() =>
      openTrack({ url: "ftp://h/render-stream" }, { ...base }),
    ).toThrow(/url scheme/);
  });

  it("does not throw for a good set and passes a WebTransport descriptor to the transport", async () => {
    const r = await rig(
      { carrier: "websocket" },
      {
        url: "ws://127.0.0.1:1/render-stream",
        webTransport: {
          url: "https://127.0.0.1:4433/render-stream",
          certificateHashes: ["ab".repeat(32)],
        },
      },
    );
    expect(r.link().endpoint.webTransport).toEqual({
      url: "https://127.0.0.1:4433/render-stream",
      certificateHashes: ["ab".repeat(32)],
    });
    r.sink.close();
  });
});

// CRED1 (tracks-design.md "As built (CRED1)"): `credential` may be a provider called before every
// connect attempt.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** A provider whose answers the test settles by hand. */
function manual() {
  const calls: {
    ctx: Parameters<
      NonNullable<
        Extract<OpenTrackOptions["credential"], (...a: never[]) => unknown>
      >
    >[0];
    resolve(v: unknown): void;
    reject(e: unknown): void;
  }[] = [];
  const provider = (ctx: (typeof calls)[number]["ctx"]) =>
    new Promise<string>((resolve, reject) => {
      calls.push({
        ctx,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
    });
  return { calls, provider };
}

const helloOf = (l: FakeLink): { credential: unknown } =>
  JSON.parse(l.sent[0]) as { credential: unknown };

describe("openTrack: credential provider (CRED1)", () => {
  it("is called before each attempt, and each hello carries that call's value", async () => {
    let n = 0;
    const seen: unknown[] = [];
    const r = await rig({
      credential: (ctx) => {
        seen.push({ ...ctx, lastClose: ctx.lastClose?.reason ?? null });
        return `cred-${++n}`;
      },
    });
    expect(r.links).toHaveLength(1);
    r.link().open();
    expect(helloOf(r.link()).credential).toBe("cred-1");
    r.link().readyWith();
    r.clock.advance(3000); // idle: the track drops
    expect(r.sink.state).toBe("reconnecting");
    r.clock.advance(1000);
    expect(r.links).toHaveLength(2);
    r.link().open();
    expect(helloOf(r.link()).credential).toBe("cred-2");
    expect(seen).toEqual([
      { attempt: 1, lastClose: null },
      { attempt: 2, lastClose: "track-idle" },
    ]);
    r.sink.close();
  });

  it("an async provider delays the transport until it answers; nothing connects before", async () => {
    const m = manual();
    const r = await rig({ credential: m.provider });
    await flush();
    expect(r.links).toHaveLength(0);
    expect(r.sink.state).toBe("connecting");
    expect(m.calls).toHaveLength(1);
    m.calls[0].resolve("late-cred");
    await flush();
    expect(r.links).toHaveLength(1);
    r.link().open();
    expect(helloOf(r.link()).credential).toBe("late-cred");
    r.sink.close();
  });

  it("provider time does not count towards the ready timeout", async () => {
    const m = manual();
    const r = await rig({
      credential: m.provider,
      readyTimeoutMs: 1000,
      credentialTimeoutMs: 60_000,
    });
    r.clock.advance(30_000); // far past readyTimeoutMs, with the provider still working
    expect(r.closes).toHaveLength(0);
    m.calls[0].resolve(CRED);
    await flush();
    r.link().open();
    r.clock.advance(900);
    r.link().readyWith();
    r.clock.advance(1000);
    expect(r.closes).toHaveLength(0);
    expect(r.sink.state).toBe("open");
    r.sink.close();
  });

  it("the ready timeout still runs from the transport opening", async () => {
    const m = manual();
    const r = await rig({ credential: m.provider, readyTimeoutMs: 1000 });
    m.calls[0].resolve(CRED);
    await flush();
    r.link().open();
    r.clock.advance(1000);
    expect(r.closes[0]).toMatchObject({
      reason: "track-ready-timeout",
      by: "client",
      willReconnect: true,
    });
  });

  it("a provider that throws is a typed, retried close; the next call can succeed", async () => {
    let n = 0;
    const r = await rig({
      credential: () => {
        if (++n === 1) throw new Error("mint server down");
        return CRED;
      },
    });
    expect(r.links).toHaveLength(0);
    expect(r.closes).toHaveLength(1);
    expect(r.closes[0]).toMatchObject({
      code: 1011,
      reason: "track-credential-failed",
      detail: "threw: mint server down",
      by: "client",
      opened: false,
      willReconnect: true,
      reconnectInMs: 250,
    });
    expect(r.sink.state).toBe("reconnecting");
    r.clock.advance(250);
    expect(r.links).toHaveLength(1);
    r.link().open();
    r.link().readyWith();
    expect(r.sink.state).toBe("open");
    expect(r.sink.stats().connections).toBe(2);
    r.sink.close();
  });

  it("a provider that rejects is the same close, with its message, and backs off", async () => {
    const r = await rig({ credential: () => Promise.reject(new Error("503")) });
    await flush();
    expect(r.closes[0]).toMatchObject({
      reason: "track-credential-failed",
      detail: "rejected: 503",
      willReconnect: true,
      reconnectInMs: 250,
    });
    r.clock.advance(250);
    await flush();
    expect(r.closes[1].reconnectInMs).toBe(500);
    r.clock.advance(500);
    await flush();
    expect(r.closes[2].reconnectInMs).toBe(1000);
    expect(r.links).toHaveLength(0);
    r.sink.close();
  });

  it("a non-Error rejection is reported too", async () => {
    const r = await rig({ credential: () => Promise.reject("nope") });
    await flush();
    expect(r.closes[0].detail).toBe("rejected: nope");
    r.sink.close();
  });

  it("a provider that never answers times out; its late answer is ignored", async () => {
    const m = manual();
    const r = await rig({ credential: m.provider, credentialTimeoutMs: 2000 });
    r.clock.advance(1999);
    expect(r.closes).toHaveLength(0);
    r.clock.advance(1);
    expect(r.closes[0]).toMatchObject({
      reason: "track-credential-failed",
      detail: "timeout",
      willReconnect: true,
    });
    m.calls[0].resolve(CRED); // too late
    await flush();
    expect(r.links).toHaveLength(0);
    r.clock.advance(250);
    await flush();
    expect(m.calls).toHaveLength(2); // the next attempt asked again
    m.calls[1].resolve(CRED);
    await flush();
    expect(r.links).toHaveLength(1);
    r.sink.close();
  });

  const invalid: [string, unknown, string][] = [
    ["an empty string", "", "empty"],
    ["a number", 42, "not-a-string"],
    ["undefined", undefined, "not-a-string"],
    ["the view token", VIEW_TOKEN, "view-token"],
    ["a credential that overflows the hello", "x".repeat(5000), "too-long"],
  ];
  for (const [name, value, detail] of invalid) {
    for (const mode of ["sync", "async"] as const) {
      it(`${name} (${mode}) is a final typed close and never connects`, async () => {
        const provide = () => value as string;
        const r = await rig(
          {
            credential:
              mode === "sync" ? provide : () => Promise.resolve(provide()),
          },
          { url: "ws://127.0.0.1:1/render-stream", token: VIEW_TOKEN },
        );
        await flush();
        expect(r.closes).toHaveLength(1);
        expect(r.closes[0]).toMatchObject({
          code: 1008,
          reason: "track-credential-invalid",
          detail,
          by: "client",
          opened: false,
          willReconnect: false,
        });
        r.clock.advance(600_000);
        await flush();
        expect(r.links).toHaveLength(0);
        expect(r.sink.stats().connections).toBe(1);
        expect(r.clock.pending()).toBe(0);
        expect(r.sink.state).toBe("closed");
        await expect(r.sink.finished).resolves.toMatchObject({
          reason: "track-credential-invalid",
        });
      });
    }
  }

  it("a failing provider with reconnect:false ends the track", async () => {
    const r = await rig({
      credential: () => {
        throw new Error("x");
      },
      reconnect: false,
    });
    expect(r.closes[0]).toMatchObject({ willReconnect: false });
    expect(r.sink.state).toBe("closed");
  });

  it("close() while the provider works is clean: one close, no transport, answer dropped", async () => {
    const m = manual();
    const r = await rig({ credential: m.provider });
    await flush();
    r.sink.close();
    expect(r.sink.state).toBe("closed");
    expect(r.closes).toHaveLength(1);
    expect(r.closes[0]).toMatchObject({
      reason: "client-close",
      by: "client",
      opened: false,
      willReconnect: false,
    });
    expect(r.clock.pending()).toBe(0);
    m.calls[0].resolve(CRED);
    await flush();
    r.clock.advance(600_000);
    expect(r.links).toHaveLength(0);
    expect(r.closes).toHaveLength(1);
    expect(r.states.at(-1)).toBe("closed");
    await expect(r.sink.finished).resolves.toMatchObject({
      reason: "client-close",
    });
  });

  it("a rejection that arrives after close() is swallowed, not reported", async () => {
    const m = manual();
    const r = await rig({ credential: m.provider });
    await flush();
    r.sink.close();
    m.calls[0].reject(new Error("late"));
    await flush();
    expect(r.closes).toHaveLength(1);
    expect(r.links).toHaveLength(0);
  });

  it("close() during a retry's provider call (after a drop) is clean too", async () => {
    const calls: ((v: string) => void)[] = [];
    let first = true;
    const r = await rig({
      credential: () => {
        if (!first) return new Promise<string>((res) => calls.push(res));
        first = false;
        return CRED;
      },
    });
    r.link().open();
    r.link().readyWith();
    r.link().hostClose(1001, "stream-ended");
    r.clock.advance(300);
    expect(calls).toHaveLength(1);
    expect(r.sink.state).toBe("connecting");
    r.sink.close();
    calls[0](CRED);
    await flush();
    expect(r.links).toHaveLength(1);
    expect(r.closes).toHaveLength(2);
    expect(r.closes[1].reason).toBe("client-close");
  });

  describe("expired", () => {
    it("is retried when a provider is given, which is called again and sees it", async () => {
      let n = 0;
      const lastClose: unknown[] = [];
      const r = await rig({
        credential: (ctx) => {
          lastClose.push(
            ctx.lastClose && [ctx.lastClose.reason, ctx.lastClose.detail],
          );
          return `cap-${++n}`;
        },
      });
      r.link().open();
      r.link().refuse(1008, "track-unauthorized", "expired");
      expect(r.closes[0]).toMatchObject({
        reason: "track-unauthorized",
        detail: "expired",
        willReconnect: true,
        reconnectInMs: 250,
      });
      expect(r.sink.state).toBe("reconnecting");
      r.clock.advance(250);
      await flush();
      r.link().open();
      expect(helloOf(r.link()).credential).toBe("cap-2");
      r.link().readyWith();
      expect(r.sink.state).toBe("open");
      expect(lastClose).toEqual([null, ["track-unauthorized", "expired"]]);
      r.sink.close();
    });

    it("stays final for a string credential", async () => {
      const r = await rig();
      r.link().open();
      r.link().refuse(1008, "track-unauthorized", "expired");
      expect(r.closes[0].willReconnect).toBe(false);
      expect(r.sink.state).toBe("closed");
    });

    it("gives up after 3 retries in a row: a provider that cannot mint a fresh capability", async () => {
      const r = await rig({ credential: () => CRED });
      for (let i = 0; i < 3; i++) {
        r.link().open();
        r.link().refuse(1008, "track-unauthorized", "expired");
        expect(r.closes[i].willReconnect).toBe(true);
        r.clock.advance(10_000);
        await flush();
      }
      r.link().open();
      r.link().refuse(1008, "track-unauthorized", "expired");
      expect(r.closes[3]).toMatchObject({
        detail: "expired",
        willReconnect: false,
      });
      expect(r.sink.state).toBe("closed");
      expect(r.sink.stats().connections).toBe(4);
    });

    it("the count restarts after a track that opened, or any other end", async () => {
      const r = await rig({ credential: () => CRED });
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 3; i++) {
          r.link().open();
          r.link().refuse(1008, "track-unauthorized", "expired");
          r.clock.advance(10_000);
          await flush();
        }
        r.link().open();
        r.link().readyWith();
        r.link().hostClose(1001, "stream-ended");
        r.clock.advance(10_000);
        await flush();
      }
      expect(r.sink.state).toBe("connecting");
      r.sink.close();
    });

    for (const detail of [
      "wrong",
      "bad-mac",
      "malformed",
      "missing",
      "view-token",
      "wrong-kind",
      "exp-too-far",
      "cap-invalid",
    ]) {
      it(`${detail} stays final even with a provider`, async () => {
        const r = await rig({ credential: () => CRED });
        r.link().open();
        r.link().refuse(1008, "track-unauthorized", detail);
        expect(r.closes[0]).toMatchObject({ detail, willReconnect: false });
        r.clock.advance(600_000);
        await flush();
        expect(r.links).toHaveLength(1);
        expect(r.sink.state).toBe("closed");
      });
    }
  });

  it("trackDisposition: expired is retried only for a refreshable credential", () => {
    expect(trackDisposition(1008, "track-unauthorized", "expired")).toEqual({
      retry: false,
      minDelayMs: 0,
    });
    expect(
      trackDisposition(1008, "track-unauthorized", "expired", true).retry,
    ).toBe(true);
    expect(
      trackDisposition(1008, "track-unauthorized", "wrong", true).retry,
    ).toBe(false);
    expect(trackDisposition(1008, "track-unauthorized", null, true).retry).toBe(
      false,
    );
    expect(trackDisposition(1011, "track-credential-failed").retry).toBe(true);
    expect(trackDisposition(1008, "track-credential-invalid").retry).toBe(
      false,
    );
  });

  describe("options", () => {
    const ep = { url: "ws://127.0.0.1:1/render-stream" };
    const base = { kind: "input", formats: ["gsw-input/1"] };
    const code = (f: () => unknown): string | null => {
      try {
        f();
        return null;
      } catch (e) {
        return e instanceof RenderStreamTrackError ? e.code : "other";
      }
    };
    it("accepts a function without calling it at open", async () => {
      let called = 0;
      const sink = openTrack(ep, {
        ...base,
        credential: () => {
          called++;
          return CRED;
        },
        transport: (e, s, on) => new FakeLink(e, s, on),
      });
      expect(called).toBe(0);
      sink.close();
      await flush();
      expect(called).toBe(0);
    });
    it("a provider is not checked against the view token at open", () => {
      expect(
        code(() =>
          openTrack(
            { ...ep, token: VIEW_TOKEN },
            {
              ...base,
              credential: () => CRED,
              transport: (e, s, on) => new FakeLink(e, s, on),
            },
          ).close(),
        ),
      ).toBe(null);
    });
    it("rejects a credential that is neither string nor function, a bad timeout, an oversized base hello", () => {
      const t = (x: Partial<OpenTrackOptions>) =>
        code(() => openTrack(ep, { ...base, credential: CRED, ...x }));
      expect(t({ credential: 5 as never })).toBe("track-options-invalid");
      expect(t({ credential: "" })).toBe("track-options-invalid");
      expect(t({ credentialTimeoutMs: 0, credential: () => CRED })).toBe(
        "track-options-invalid",
      );
      expect(
        t({
          credential: () => CRED,
          client: "a".repeat(64),
          formats: Array.from(
            { length: 8 },
            (_, i) => `gsw-input-${"x".repeat(40)}/${i + 1}`,
          ),
        }),
      ).toBe("track-options-invalid");
    });
  });
});
