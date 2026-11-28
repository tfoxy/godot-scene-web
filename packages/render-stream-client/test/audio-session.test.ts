// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { AudioClockEstimator } from "../src/audio/clock";
import type { AudioContextLike } from "../src/audio/mainEngine";
import {
  type OpenAudioTrackOptions,
  openAudioTrack,
} from "../src/audio/session";
import { TakeStore } from "../src/audio/takeStore";
import {
  type BlockHeader,
  decodeAudioText,
  encodeAudioText,
  encodeBlock,
  keyId,
} from "../src/audio/wire";
import type {
  RenderStreamTransportEvents,
  RenderStreamTransportFactory,
} from "../src/transport";

class Clock {
  t = 0;
  id = 0;
  timers = new Map<number, { at: number; cb: () => void }>();
  now = () => this.t;
  random = () => 0.5;
  setTimeout = (cb: () => void, ms: number) => {
    const id = ++this.id;
    this.timers.set(id, { at: this.t + ms, cb });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.t = next[1].at;
      this.timers.delete(next[0]);
      next[1].cb();
    }
    this.t = end;
  }
}
class Node {
  connections: unknown[] = [];
  disconnected = false;
  gain = {
    value: 1,
    setTargetAtTime: (value: number) => {
      this.gain.value = value;
    },
    setValueAtTime: (value: number) => {
      this.gain.value = value;
    },
    linearRampToValueAtTime: (value: number) => {
      this.gain.value = value;
    },
  };
  connect(node: unknown) {
    this.connections.push(node);
    return node;
  }
  disconnect() {
    this.disconnected = true;
  }
}
class Source extends Node {
  buffer: { planes: Float32Array[]; length: number } | null = null;
  playbackRate = {
    value: 1,
    setValueAtTime: (value: number) => {
      this.playbackRate.value = value;
    },
  };
  offset = { value: 0 };
  starts: number[] = [];
  stops: number[] = [];
  onended: (() => void) | null = null;
  start(at = 0) {
    this.starts.push(at);
  }
  stop(at = 0) {
    this.stops.push(at);
  }
  end() {
    this.onended?.();
  }
}
class Context {
  currentTime = 0;
  destination = new Node();
  sources: Source[] = [];
  constants: Source[] = [];
  gains: Node[] = [];
  createChannelSplitter = () => new Node();
  createChannelMerger = () => new Node();
  decodeAudioData = vi.fn(
    async (_bytes: ArrayBuffer) =>
      this.createBuffer(2, 4800, 48000) as unknown as AudioBuffer,
  );
  createGain = () => {
    const n = new Node();
    this.gains.push(n);
    return n;
  };
  createBufferSource = () => {
    const s = new Source();
    this.sources.push(s);
    return s;
  };
  createConstantSource = () => {
    const s = new Source();
    this.constants.push(s);
    return s;
  };
  createBuffer = (channels: number, length: number, sampleRate: number) => {
    const planes = Array.from(
      { length: channels },
      () => new Float32Array(length),
    );
    return {
      planes,
      numberOfChannels: channels,
      duration: length / sampleRate,
      length,
      sampleRate,
      getChannelData: (c: number) => planes[c],
    };
  };
  getOutputTimestamp = () => ({
    contextTime: this.currentTime,
    performanceTime: this.currentTime * 1000,
  });
  resume = async () => {};
}
const BANK = "00".repeat(16),
  KEY = keyId("event:/test"),
  HASH = "ab".repeat(32);
const LANE = { id: 1, name: "music", group: "Music" };
const readyMessage = (audio: Record<string, unknown> = {}) => ({
  type: "track-ready",
  protocol: "render-stream-audio/1",
  source: 1,
  kind: "audio",
  format: "gsw-audio/1",
  down_format: null,
  keepalive_ms: 1000,
  max_message_bytes: 4096,
  rate: { messages_per_second: 1000, burst: 2000 },
  audio: {
    clock_us: 0,
    rate: 48000,
    lane_block_frames: 512,
    codec: "pcm16",
    godot: true,
    fmod: true,
    lanes: [LANE],
    ...audio,
  },
});
const cue = (more = {}) => ({
  type: "cue",
  key_id: KEY,
  key: "event:/test",
  kind: "oneshot",
  group: "SFX",
  pitch: 1,
  volume: 1,
  ...more,
});
const header = (more: Partial<BlockHeader> = {}): BlockHeader => ({
  kind: 1,
  flags: 3,
  lane: 0,
  codec: 0,
  channels: 2,
  stream: 1,
  block: 0,
  rate: 48000,
  frames: 2,
  made_us: 0n,
  due_us: 0n,
  sent_us: 0n,
  ...more,
});
function pcm(values: number[]): Uint8Array {
  const b = new Uint8Array(values.length * 2);
  const v = new DataView(b.buffer);
  values.forEach((n, i) => {
    v.setInt16(i * 2, n, true);
  });
  return b;
}
async function setup(extra: Partial<OpenAudioTrackOptions> = {}) {
  const clock = new Clock(),
    context = new Context();
  const links: {
    on: RenderStreamTransportEvents;
    sent: string[];
    closes: [number, string][];
    protocol: string;
  }[] = [];
  const transport: RenderStreamTransportFactory = (_ep, protocol, on) => {
    const link = {
      on,
      protocol,
      sent: [] as string[],
      closes: [] as [number, string][],
    };
    links.push(link);
    return {
      send: (t) => link.sent.push(t),
      close: (c, r) => {
        link.closes.push([c, r]);
      },
      fetchResource: async () => {
        throw new Error("unexpected fetch");
      },
    };
  };
  const track = openAudioTrack({
    url: "ws://localhost/render-stream",
    credential: "ab".repeat(32),
    context: context as unknown as AudioContextLike,
    transport,
    clock,
    reconnect: false,
    ...extra,
  });
  await Promise.resolve();
  const link = links[0];
  const text = (v: Record<string, unknown>) =>
    link.on.message(
      JSON.stringify({ ...v, t: clock.t * 1000, s: clock.t * 1000 }),
    );
  const ready = (v = readyMessage()) => {
    link.on.open();
    link.on.message(JSON.stringify(v));
  };
  const snapshot = (gains = { SFX: 1, Music: 0.5 }, bankset = BANK) =>
    text({
      type: "audio-state",
      godot: { buses: [], voices: [] },
      fmod: { bankset, groups: gains, lanes: [LANE] },
    });
  const block = (h = header(), bytes = pcm([32767, -32768, 16384, -16384])) =>
    link.on.message(encodeBlock(h, bytes).buffer as ArrayBuffer);
  const messages = () => link.sent.filter(Boolean).map((t) => JSON.parse(t));
  const finish = () => {
    text({ type: "take-ready", key_id: KEY, stream: 1, hash: HASH });
  };
  return {
    track,
    clock,
    context,
    links,
    link,
    text,
    ready,
    snapshot,
    block,
    messages,
    finish,
  };
}

describe("audio session", () => {
  it("shares the track handshake while offering only the audio subprotocol", async () => {
    const s = await setup({ client: "test-web", codecs: ["mp3", "wav"] });
    s.ready();
    expect(s.link.protocol).toBe("render-stream-audio.1");
    expect(s.messages()[0]).toMatchObject({
      type: "track-hello",
      protocol: "render-stream-audio/1",
      kind: "audio",
      formats: ["gsw-audio/1"],
      client: "test-web",
      audio: { codecs: ["pcm16"], sample_codecs: ["mp3", "wav"] },
    });
    expect(s.track.state).toBe("open");
    expect(s.track.ready?.lane_block_frames).toBe(512);
    s.track.close();
  });
  it("retains the snapshot and sample registrations independently of the view", async () => {
    const s = await setup();
    s.ready();
    s.snapshot();
    s.text({
      type: "sample",
      id: 1,
      variants: [{ codec: "wav", hash: HASH, bytes: 44 }],
      channels: 2,
      rate: 48000,
      length_ms: 1,
      loop: { mode: "disabled", begin: 0, end: 0 },
      store: true,
    });
    s.text({
      type: "sample-variant",
      id: 1,
      codec: "mp3",
      hash: HASH,
      bytes: 10,
    });
    expect(s.track.snapshot?.fmod?.bankset).toBe(BANK);
    expect(s.track.samples.get(1)).toMatchObject({
      variants: [{ codec: "wav" }, { codec: "mp3" }],
    });
    s.text({ type: "sample-drop", id: 1 });
    expect(s.track.samples.size).toBe(0);
    s.track.close();
  });
  it("advertises stored ids in pages of at most 100 with reset only on the first", async () => {
    const store = new TakeStore();
    for (let i = 0; i < 205; i++)
      store.put({
        bankset: BANK,
        keyId: i.toString(16).padStart(32, "0"),
        hash: HASH,
        pcm: [new Float32Array(1), new Float32Array(1)],
        frames: 1,
      });
    store.put({
      bankset: "ff".repeat(16),
      keyId: HASH.slice(0, 32),
      hash: HASH,
      pcm: [new Float32Array(1), new Float32Array(1)],
      frames: 1,
    });
    const s = await setup({ store });
    s.ready();
    s.snapshot();
    const pages = s.messages().filter((m) => m.type === "have");
    expect(pages.map((p) => p.key_ids.length)).toEqual([100, 100, 5]);
    expect(pages.map((p) => p.reset)).toEqual([true, false, false]);
    expect(pages.every((p) => p.bankset === BANK)).toBe(true);
    s.track.close();
  });
  it("sends an empty initial have reset, then subscribes lanes with positive group gain", async () => {
    const s = await setup();
    s.ready();
    s.snapshot({ SFX: 1, Music: 0 });
    expect(s.messages().filter((m) => m.type === "have")).toEqual([
      { type: "have", bankset: BANK, key_ids: [], reset: true },
    ]);
    s.text({ type: "groups", gains: { Music: 0.3 }, snapshot: false });
    expect(s.messages().filter((m) => m.type === "lanes")).toEqual([
      { type: "lanes", ids: [1] },
    ]);
    s.text({ type: "groups", gains: { Music: 0 }, snapshot: false });
    expect(
      s
        .messages()
        .filter((m) => m.type === "lanes")
        .at(-1).ids,
    ).toEqual([]);
    s.track.close();
  });
  it("caps the initial have union at 4096 without evicting a supplied store", async () => {
    const store = new TakeStore();
    for (let i = 0; i < 4097; i++)
      store.put({
        bankset: BANK,
        keyId: i.toString(16).padStart(32, "0"),
        hash: HASH,
        pcm: [new Float32Array(1), new Float32Array(1)],
        frames: 1,
      });
    const s = await setup({ store });
    s.ready();
    s.snapshot();
    const pages = s.messages().filter((m) => m.type === "have");
    expect(new Set(pages.flatMap((p) => p.key_ids)).size).toBe(4096);
    expect(pages.every((p) => p.key_ids.length <= 100)).toBe(true);
    expect(pages.map((p) => p.reset)).toEqual(pages.map((_, i) => i === 0));
    expect(store.ids(BANK)).toHaveLength(4097);
    s.track.close();
  });
  it("keeps a completed take playable without advertising past the have cap", async () => {
    const store = new TakeStore();
    for (let i = 0; i < 4096; i++)
      store.put({
        bankset: BANK,
        keyId: i.toString(16).padStart(32, "0"),
        hash: HASH,
        pcm: [new Float32Array(1), new Float32Array(1)],
        frames: 1,
      });
    const s = await setup({ store });
    s.ready();
    s.snapshot();
    const before = s.messages().filter((m) => m.type === "have").length;
    s.text(cue());
    s.text({
      type: "take-start",
      key_id: KEY,
      stream: 1,
      frames: 2,
      bankset: BANK,
    });
    s.block();
    s.finish();
    const pages = s.messages().filter((m) => m.type === "have");
    expect(pages).toHaveLength(before);
    expect(new Set(pages.flatMap((p) => p.key_ids)).size).toBe(4096);
    expect(store.ids(BANK)).toHaveLength(4097);
    const count = s.context.sources.length;
    s.text(cue());
    expect(s.context.sources).toHaveLength(count + 1);
    expect(s.context.sources.at(-1)?.buffer?.length).toBe(2);
    expect(s.track.state).toBe("open");
    s.track.close();
  });
  it.each([
    false,
    true,
  ])("aborts unavailable take assembly and drains its voices (ended before abort: %s)", async (endedBefore) => {
    const store = new TakeStore(),
      cached = keyId("event:/cached");
    store.put({
      bankset: BANK,
      keyId: cached,
      hash: HASH,
      frames: 2,
      pcm: [new Float32Array(2), new Float32Array(2)],
    });
    const s = await setup({ store });
    s.ready();
    s.snapshot();
    s.text(cue());
    s.text({
      type: "take-start",
      key_id: KEY,
      stream: 1,
      frames: 4,
      bankset: BANK,
    });
    s.block(header({ flags: 1 }));
    const source = s.context.sources[0];
    const gain = source.connections[0] as Node;
    if (endedBefore) source.end();
    s.text({ type: "take-unavailable", key_id: KEY, reason: "link-down" });
    if (!endedBefore) source.end();
    expect(
      (store as unknown as { streams: Map<number, unknown> }).streams.size,
    ).toBe(0);
    expect(gain.disconnected).toBe(true);
    // Blocks already in flight after link-down must not close the Godot audio track.
    s.block(header({ block: 1, flags: 2 }));
    expect(s.track.state).toBe("open");
    expect(s.context.sources).toHaveLength(1);
    s.text(cue({ key_id: cached, key: "event:/cached" }));
    expect(s.context.sources).toHaveLength(2);
    expect(store.peek(BANK, cached)).toBeDefined();
    expect(store.peek(BANK, KEY)).toBeUndefined();
    s.track.close();
  });
  it("probes eight clocks 50 ms apart and then one every five seconds", async () => {
    const s = await setup();
    s.ready();
    s.snapshot();
    // Incoming keepalives keep this test focused on the media clock, not track-idle.
    for (let i = 0; i < 6; i++) {
      s.clock.advance(1000);
      s.link.on.message("");
    }
    expect(
      s
        .messages()
        .filter((m) => m.type === "clock")
        .map((m) => m.c),
    ).toEqual([0, 50, 100, 150, 200, 250, 300, 350, 5350]);
    s.track.close();
    expect(s.clock.timers.size).toBe(0);
  });
  it("assembles first-sight PCM, advertises only complete takes, and plays a later cue synchronously", async () => {
    const s = await setup();
    s.ready();
    s.snapshot();
    s.text(cue({ pitch: 2, volume: 0.5 }));
    s.text({
      type: "take-start",
      key_id: KEY,
      stream: 1,
      frames: 4,
      bankset: BANK,
    });
    s.block(header({ flags: 1 }));
    s.block(header({ block: 1, flags: 2 }), pcm([0, 8192, -8192, 0]));
    expect(s.context.sources).toHaveLength(2);
    expect(s.track.store.peek(BANK, KEY)).toBeUndefined();
    expect(s.context.sources[0].starts[0]).toBe(0.005);
    expect(s.context.sources[1].starts[0]).toBeCloseTo(0.005 + 2 / 96000);
    expect(s.context.sources[0].playbackRate.value).toBe(2);
    s.finish();
    expect(s.track.store.peek(BANK, KEY)?.pcm[1]).toEqual(
      new Float32Array([-1, -0.5, 0.25, 0]),
    );
    expect(
      s
        .messages()
        .filter((m) => m.type === "have")
        .at(-1),
    ).toMatchObject({ reset: false, key_ids: [KEY] });
    s.context.currentTime = 10;
    const count = s.link.sent.length;
    s.text(cue());
    expect(s.context.sources.at(-1)?.starts).toEqual([10]);
    expect(s.context.sources.at(-1)?.buffer?.length).toBe(4);
    expect(s.link.sent.length).toBe(count);
    const cachedBuffer = s.context.sources.at(-1)?.buffer;
    s.text(cue());
    expect(s.context.sources.at(-1)?.buffer).toBe(cachedBuffer);
    s.track.close();
  });
  it("preserves repeated cold cues before and during take delivery", async () => {
    const s = await setup();
    s.ready();
    s.snapshot();
    s.text(cue());
    s.text(cue());
    s.text({
      type: "take-start",
      key_id: KEY,
      stream: 1,
      frames: 2,
      bankset: BANK,
    });
    s.text(cue());
    s.block();
    s.finish();
    expect(s.context.sources).toHaveLength(3);
    s.track.close();
  });
  it("applies snapshot gains and group updates to active voices", async () => {
    const s = await setup();
    s.ready();
    s.snapshot({ SFX: 0.25, Music: 1 });
    s.text(cue({ volume: 0.5 }));
    s.text({
      type: "take-start",
      key_id: KEY,
      stream: 1,
      frames: 2,
      bankset: BANK,
    });
    s.block();
    s.finish();
    const gain = s.context.sources[0].connections[0] as Node;
    expect(gain.gain.value).toBe(0.125);
    s.text({ type: "groups", gains: { SFX: 0 }, snapshot: false });
    expect(gain.gain.value).toBe(0);
    s.text(cue());
    expect(s.context.sources).toHaveLength(1);
    s.track.close();
  });
  it("drops a lane backlog after a stall and handles gaps and new epochs", async () => {
    const s = await setup();
    s.ready();
    s.snapshot();
    const laneHeader = (more = {}) =>
      header({ kind: 2, lane: 1, frames: 512, flags: 4, ...more });
    s.block(laneHeader(), new Uint8Array());
    expect(s.context.sources[0].starts[0]).toBeCloseTo(0.06);
    s.clock.t = 2000;
    s.context.currentTime = 2;
    s.block(laneHeader({ block: 1, due_us: 10667n }), new Uint8Array());
    expect(s.context.sources).toHaveLength(1);
    s.block(
      laneHeader({ block: 200, due_us: 2000000n, flags: 12 }),
      new Uint8Array(),
    );
    expect(s.context.sources[1].starts[0]).toBeCloseTo(2.06);
    s.block(
      laneHeader({ stream: 2, block: 0, due_us: 2010667n }),
      new Uint8Array(),
    );
    expect(s.context.sources[0].stops).toHaveLength(1);
    expect(s.context.sources[1].stops).toHaveLength(1);
    s.block(
      laneHeader({ stream: 1, block: 201, due_us: 2020000n }),
      new Uint8Array(),
    );
    expect(s.context.sources).toHaveLength(3);
    s.track.close();
  });
  it("gates the tiny keepalive on actual source activity and restores it on end", async () => {
    const s = await setup();
    expect(s.context.constants[0].offset.value).toBe(1e-5);
    s.ready();
    s.snapshot();
    s.text(cue());
    s.text({
      type: "take-start",
      key_id: KEY,
      stream: 1,
      frames: 2,
      bankset: BANK,
    });
    s.block();
    s.finish();
    expect(s.context.constants[0].stops).toHaveLength(1);
    s.context.sources[0].end();
    expect(s.context.constants).toHaveLength(2);
    s.track.close();
    expect(s.context.constants[1].stops).toHaveLength(1);
    expect(s.context.sources[0].stops).toHaveLength(0);
  });
  it("retains decoded takes but clears in-flight state and timers on reconnect", async () => {
    const s = await setup({ reconnect: { initialMs: 250, maxMs: 1000 } });
    s.ready();
    s.snapshot();
    s.text(cue());
    s.text({
      type: "take-start",
      key_id: KEY,
      stream: 1,
      frames: 2,
      bankset: BANK,
    });
    s.block();
    s.finish();
    s.link.on.close(1001, "audio-stalled");
    expect(s.track.state).toBe("reconnecting");
    expect(s.track.snapshot).toBeNull();
    s.clock.advance(250);
    const next = s.links[1];
    next.on.open();
    next.on.message(JSON.stringify(readyMessage()));
    next.on.message(
      JSON.stringify({
        type: "audio-state",
        t: 0,
        s: 0,
        godot: null,
        fmod: { bankset: BANK, groups: { SFX: 1 }, lanes: [LANE] },
      }),
    );
    expect(
      next.sent.map((t) => JSON.parse(t)).find((m) => m.type === "have"),
    ).toMatchObject({ reset: true, key_ids: [KEY] });
    s.track.close();
    expect(s.clock.timers.size).toBe(0);
  });
  it("preserves audio-overflow and its minimum one-second retry delay", async () => {
    const closes: unknown[] = [];
    const s = await setup({
      reconnect: { initialMs: 10, maxMs: 20 },
      onClose: (i) => closes.push(i),
    });
    s.ready();
    s.link.on.close(1013, "audio-overflow");
    expect(closes[0]).toMatchObject({
      reason: "audio-overflow",
      reconnectInMs: 1000,
    });
    s.clock.advance(999);
    expect(s.links).toHaveLength(1);
    s.clock.advance(1);
    expect(s.links).toHaveLength(2);
    s.track.close();
  });
  it("does not relabel ordinary track-rate errors", async () => {
    const s = await setup();
    s.ready();
    s.link.on.close(1008, "track-rate");
    expect(await s.track.finished).toMatchObject({ reason: "track-rate" });
  });
  it.each([
    "protocol",
    "codec",
    "frames",
  ])("rejects invalid ready %s", async (bad) => {
    const s = await setup();
    const m = readyMessage();
    if (bad === "protocol") m.protocol = "render-stream-track/1";
    if (bad === "codec") m.audio.codec = "opus";
    if (bad === "frames") m.audio.lane_block_frames = 256;
    s.ready(m);
    expect(await s.track.finished).toMatchObject({
      code: 1002,
      reason: "audio-protocol",
    });
    expect(s.clock.timers.size).toBe(0);
  });
  it("rejects PCM before a snapshot and invalid PCM after it", async () => {
    const a = await setup();
    a.ready();
    a.block();
    expect(await a.track.finished).toMatchObject({ reason: "audio-protocol" });
    const b = await setup();
    b.ready();
    b.snapshot();
    b.link.on.message(new ArrayBuffer(2));
    expect(await b.track.finished).toMatchObject({ reason: "audio-protocol" });
  });
  it("passes handshake refusals through without playing anything", async () => {
    const s = await setup();
    s.link.on.open();
    s.link.on.message(
      '{"type":"track-error","reason":"track-unauthorized","detail":"wrong"}',
    );
    s.link.on.close(1008, "track-unauthorized");
    expect(await s.track.finished).toMatchObject({
      reason: "track-unauthorized",
      detail: "wrong",
      opened: false,
    });
    expect(s.context.sources).toHaveLength(0);
  });
  it("keeps binary lane traffic alive under the shared inbound watchdog", async () => {
    const s = await setup();
    s.ready();
    s.snapshot();
    for (let i = 0; i < 5; i++) {
      s.clock.advance(900);
      s.context.currentTime = s.clock.t / 1000;
      s.block(
        header({
          kind: 2,
          lane: 1,
          frames: 512,
          flags: 4,
          block: i,
          due_us: BigInt(s.clock.t * 1000),
        }),
        new Uint8Array(),
      );
    }
    expect(s.track.state).toBe("open");
    s.track.close();
  });
});

describe("audio media clock", () => {
  it("uses the minimum RTT midpoint and getOutputTimestamp to map capture time", () => {
    const c = new AudioClockEstimator();
    c.reset(5000000, 1000);
    c.request(1000);
    expect(c.reply(1000, 5010000, 1020)).toBe(true);
    c.request(1100);
    c.reply(1100, 5115000, 1130);
    expect(c.snapshot()).toEqual({ offsetMs: 4000, rttMs: 20 });
    const context = new Context();
    context.getOutputTimestamp = () => ({
      contextTime: 10,
      performanceTime: 2000,
    });
    expect(
      c.contextTime(6000000, context as unknown as AudioContext, 2000),
    ).toBe(10);
    expect(c.reply(777, 9000000, 800)).toBe(false);
    c.request(1200);
    c.reply(1200, 5210000, 1210);
    expect(c.snapshot()).toEqual({ offsetMs: 4005, rttMs: 10 });
  });
  it("falls back while output timestamps are unavailable or not initialized", () => {
    const c = new AudioClockEstimator();
    c.reset(5000000, 1000);
    const context = new Context();
    context.currentTime = 2;
    context.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });
    expect(
      c.contextTime(6000000, context as unknown as AudioContext, 2000),
    ).toBe(2);
  });
});

describe("take assembly and text validation", () => {
  it("assembles silent blocks as zeros and refuses missing, repeated or premature final blocks", () => {
    const s = new TakeStore();
    s.begin(1, KEY, 2, BANK);
    expect(() =>
      s.append({ header: header({ block: 1 }), payload: pcm([0, 0, 0, 0]) }),
    ).toThrow("audio-protocol");
    expect(() => s.finish(1, KEY, HASH)).toThrow("audio-protocol");
    s.append({ header: header({ flags: 7 }), payload: new Uint8Array() });
    expect(() =>
      s.append({ header: header(), payload: pcm([0, 0, 0, 0]) }),
    ).toThrow("audio-protocol");
    expect(s.finish(1, KEY, HASH).pcm[0]).toEqual(new Float32Array(2));
    s.begin(2, KEY, 4, BANK);
    expect(() =>
      s.append({ header: header({ stream: 2 }), payload: pcm([0, 0, 0, 0]) }),
    ).toThrow("audio-protocol");
  });
  it("refuses invalid JSON, oversized have, mismatched keys and unknown event types", () => {
    expect(() => decodeAudioText("{")).toThrow("audio-protocol");
    expect(() =>
      decodeAudioText(JSON.stringify({ ...cue(), key_id: BANK, t: 0, s: 0 })),
    ).toThrow("audio-protocol");
    expect(() => decodeAudioText('{"type":"unknown","t":0,"s":0}')).toThrow(
      "audio-protocol",
    );
    expect(() =>
      encodeAudioText({
        type: "have",
        bankset: BANK,
        key_ids: Array(101).fill(KEY),
        reset: false,
      }),
    ).toThrow("audio-protocol");
  });
});

it("queues have pages through the advertised token bucket without losing ids", async () => {
  const store = new TakeStore();
  for (let i = 0; i < 205; i++)
    store.put({
      bankset: BANK,
      keyId: i.toString(16).padStart(32, "0"),
      hash: HASH,
      pcm: [new Float32Array(1), new Float32Array(1)],
      frames: 1,
    });
  const s = await setup({ store });
  const m = readyMessage();
  m.rate = { messages_per_second: 10, burst: 1 };
  s.ready(m);
  s.snapshot();
  expect(s.messages().filter((m) => m.type === "have")).toHaveLength(0);
  s.clock.advance(1000);
  s.link.on.message("");
  expect(
    s
      .messages()
      .filter((m) => m.type === "have")
      .map((m) => m.key_ids.length),
  ).toEqual([100, 100, 5]);
  const clocks = s
    .messages()
    .filter((m) => m.type === "clock")
    .map((m) => m.c);
  expect(clocks[1]).toBeGreaterThan(50);
  s.track.close();
  expect(s.clock.timers.size).toBe(0);
});

it("can be closed repeatedly without leaking output", async () => {
  const s = await setup();
  s.track.close();
  s.track.close();
  expect(s.context.constants[0].stops).toHaveLength(1);
  expect(s.clock.timers.size).toBe(0);
});

it("gates loop lanes by cue identity and accepts a keyless loop-stop-all", async () => {
  const s = await setup();
  s.ready();
  s.snapshot();
  s.block(
    header({ kind: 2, lane: 1, frames: 512, flags: 4 }),
    new Uint8Array(),
  );
  const blockGain = s.context.sources[0].connections[0] as Node;
  const laneGain = blockGain.connections[0] as Node;
  s.text(cue({ kind: "loop-start", group: "Music" }));
  expect(laneGain.gain.value).toBe(0.5);
  s.text(cue({ kind: "loop-stop", group: "Music" }));
  expect(laneGain.gain.value).toBe(0);
  s.text(cue({ kind: "loop-start", group: "Music" }));
  expect(laneGain.gain.value).toBe(0.5);
  s.text(cue({ kind: "loop-stop-all", group: "Music", key: "", key_id: BANK }));
  expect(laneGain.gain.value).toBe(0);
  expect(s.track.state).toBe("open");
  s.track.close();
});

it("keeps callback failures out of protocol validation", async () => {
  const s = await setup({
    onEvent: () => {
      throw new Error("consumer callback");
    },
    onStage: () => {
      throw new Error("consumer diagnostic");
    },
  });
  s.ready();
  const pending: VoidFunction[] = [];
  const spy = vi
    .spyOn(globalThis, "queueMicrotask")
    .mockImplementation((cb) => {
      pending.push(cb);
    });
  try {
    s.snapshot();
    expect(s.track.state).toBe("open");
    expect(pending).toHaveLength(2);
  } finally {
    spy.mockRestore();
    s.track.close();
  }
});

it("treats group names as data rather than inherited object properties", async () => {
  const s = await setup();
  s.ready();
  s.snapshot();
  s.text(cue({ group: "constructor" }));
  s.text({
    type: "take-start",
    key_id: KEY,
    stream: 1,
    frames: 2,
    bankset: BANK,
  });
  s.block();
  s.finish();
  const blockGain = s.context.sources[0].connections[0] as Node;
  expect((blockGain.connections[0] as Node).gain.value).toBe(1);
  s.track.close();
});

it("plays a Godot sample through the audio session and shares its keepalive gate", async () => {
  const fetchAsset = vi.fn(async () => new ArrayBuffer(64));
  const s = await setup({ fetchAsset });
  s.ready();
  s.snapshot();
  s.text({
    type: "sample",
    id: 1,
    variants: [{ codec: "wav", hash: HASH, bytes: 64 }],
    channels: 2,
    rate: 48000,
    length_ms: 100,
    loop: { mode: "disabled", begin: 0, end: 0 },
    store: false,
  });
  s.text({
    type: "start",
    voice: 1,
    sample: 1,
    bus: -1,
    offset_s: 0,
    pitch: 1,
    volumes: [1, 1, 1, 1, 1, 1, 1, 1],
  });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(s.context.sources).toHaveLength(1);
  expect(s.context.sources[0].starts).toEqual([0]);
  expect(fetchAsset).toHaveBeenCalledExactlyOnceWith(HASH, {
    store: false,
    cache: "no-store",
  });
  expect(s.context.constants[0].stops).toHaveLength(1);
  s.context.sources[0].end();
  expect(s.context.constants).toHaveLength(2);
  s.text({ type: "stop", voice: 1, reason: "end" });
  expect(s.context.sources[0].stops).toHaveLength(0);
  expect(s.messages().some((m) => m.type === "stop")).toBe(false);
  s.track.close();
});
it("closes audio-protocol on an out-of-range Godot bus index", async () => {
  const s = await setup();
  s.ready();
  s.snapshot();
  s.text({ type: "bus", op: "volume_db", bus: 9, value: 0 });
  expect(s.track.state).toBe("closed");
  expect(s.link.closes).toContainEqual([1000, "audio-protocol"]);
  s.track.close();
});
it("closes on an asset rejection and cancels late fetches when the track closes", async () => {
  for (const rejecting of [true, false]) {
    let resolve!: (bytes: ArrayBuffer) => void;
    const s = await setup({
      fetchAsset: () =>
        rejecting
          ? Promise.reject(new Error("asset failed"))
          : new Promise((r) => {
              resolve = r;
            }),
    });
    s.ready();
    s.snapshot();
    s.text({
      type: "sample",
      id: 1,
      variants: [{ codec: "wav", hash: HASH, bytes: 64 }],
      channels: 2,
      rate: 48000,
      length_ms: 100,
      loop: { mode: "disabled", begin: 0, end: 0 },
      store: false,
    });
    s.text({
      type: "start",
      voice: 1,
      sample: 1,
      bus: 0,
      offset_s: 0,
      pitch: 1,
      volumes: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    if (rejecting) expect(s.track.state).toBe("closed");
    else {
      s.track.close();
      resolve(new ArrayBuffer(64));
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
    expect(s.context.sources).toHaveLength(0);
    s.track.close();
  }
});
