// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { AudioContextLike, AudioStage } from "../src/audio/mainEngine";
import { SampleBuses } from "../src/audio/sampleBuses";
import { GodotSampleEngine } from "../src/audio/sampleEngine";
import {
  type AudioBusState,
  type AudioSample,
  type AudioStart,
  type BusCommand,
  decodeAudioText,
  type SampleEvent,
} from "../src/audio/wire";

class Param {
  value = 1;
  values: [number, number][] = [];
  setValueAtTime(value: number, at: number) {
    this.values.push([value, at]);
    this.value = value;
    return this;
  }
}
class Node {
  connections: { node: Node; output?: number; input?: number }[] = [];
  gain = new Param();
  channelCount = 2;
  channelCountMode = "max";
  connect(node: Node, output?: number, input?: number) {
    this.connections.push({ node, output, input });
    return node;
  }
  disconnect() {
    this.connections = [];
  }
}
class Source extends Node {
  playbackRate = new Param();
  buffer: ReturnType<Context["createBuffer"]> | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  starts: [number, number][] = [];
  stops: number[] = [];
  onended: (() => void) | null = null;
  start(at = 0, offset = 0) {
    this.starts.push([at, offset]);
  }
  stop(at = 0) {
    this.stops.push(at);
  }
  end() {
    this.onended?.();
  }
}
class Context {
  currentTime = 10;
  destination = new Node();
  sources: Source[] = [];
  createGain = () => new Node();
  createChannelSplitter = () => new Node();
  createChannelMerger = () => new Node();
  createBufferSource = () => {
    const s = new Source();
    this.sources.push(s);
    return s;
  };
  createBuffer = (channels: number, length: number, sampleRate: number) => {
    const planes = Array.from(
      { length: channels },
      () => new Float32Array(length),
    );
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (c: number) => planes[c],
    };
  };
  decoded = this.createBuffer(2, 8, 8);
  decodeAudioData = vi.fn(async () => this.decoded as unknown as AudioBuffer);
}
const HASH = "ab".repeat(32);
const VOLUMES = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
const registration = (extra: Partial<AudioSample> = {}): AudioSample => ({
  type: "sample",
  id: 1,
  variants: [{ codec: "wav", hash: HASH, bytes: 64 }],
  channels: 2,
  rate: 8,
  length_ms: 1000,
  loop: { mode: "disabled", begin: 0, end: 0 },
  store: true,
  ...extra,
});
const start = (extra: Partial<AudioStart> = {}): AudioStart => ({
  type: "start",
  voice: 1,
  sample: 1,
  bus: 0,
  offset_s: 0,
  pitch: 1,
  volumes: VOLUMES,
  ...extra,
});
const state = (extra: Partial<AudioBusState> = {}): AudioBusState => ({
  name: "Master",
  volume_db: 0,
  send: -1,
  solo: false,
  mute: false,
  ...extra,
});
async function settled() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function setup(codecs = ["wav"]) {
  const context = new Context();
  context.decoded.getChannelData(0).set([0, 1, 2, 3, 4, 5, 6, 7]);
  const fetch = vi.fn(async () => new ArrayBuffer(64)),
    active = vi.fn(),
    failure = vi.fn();
  const stages: Omit<AudioStage, "handledMs">[] = [];
  const engine = new GodotSampleEngine(
    context as unknown as AudioContextLike,
    codecs,
    fetch,
    (t) => t / 1e6,
    active,
    failure,
    (row) => stages.push(row),
  );
  const send = (m: Omit<SampleEvent, "t" | "s">, t = 1000000) =>
    engine.handle(
      decodeAudioText(JSON.stringify({ ...m, t, s: t })) as SampleEvent,
    );
  return { context, engine, fetch, active, failure, stages, send };
}
describe("Godot sample playback", () => {
  it("fetches only on first start and plays a late one-shot immediately from zero", async () => {
    const s = setup();
    s.send(registration());
    await settled();
    expect(s.fetch).not.toHaveBeenCalled();
    s.send(start({ offset_s: 0.5 }));
    await settled();
    expect(s.fetch).toHaveBeenCalledExactlyOnceWith(HASH, {
      store: true,
      cache: "default",
    });
    expect(s.context.sources[0].starts).toEqual([[10, 0]]);
    expect(s.context.sources[0].loop).toBe(false);
    expect(s.active).toHaveBeenLastCalledWith(1);
    s.engine.dispose();
  });
  it.each([
    "forward",
    "backward",
    "pingpong",
  ] as const)("plays %s loops with a continuous source cycle", async (mode) => {
    const s = setup();
    s.send(registration({ loop: { mode, begin: 2, end: 6 }, store: false }));
    s.send(start(), 10000000);
    await settled();
    const source = s.context.sources[0];
    expect(source.loop).toBe(true);
    if (mode === "forward") {
      expect(source.loopStart).toBe(0.25);
      expect(source.loopEnd).toBe(0.75);
      expect([...source.buffer!.getChannelData(0)]).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7,
      ]);
    } else if (mode === "backward") {
      expect(source.loopStart).toBe(0);
      expect(source.loopEnd).toBe(0.5);
      expect([...source.buffer!.getChannelData(0)]).toEqual([5, 4, 3, 2, 1, 0]);
    } else {
      expect(source.loopStart).toBe(0.25);
      expect(source.loopEnd).toBe(1.25);
      expect([...source.buffer!.getChannelData(0)]).toEqual([
        0, 1, 2, 3, 4, 5, 5, 4, 3, 2,
      ]);
    }
    s.engine.dispose();
  });
  it("uses native WAV frame units after decode resampling, and seconds for compressed variants", async () => {
    for (const codec of ["wav", "mp3"] as const) {
      const s = setup([codec]);
      s.send(
        registration({
          rate: 4,
          variants: [{ codec, hash: HASH, bytes: 64 }],
          loop: {
            mode: "forward",
            begin: codec === "wav" ? 1 : 0.25,
            end: codec === "wav" ? 3 : 0.75,
          },
        }),
      );
      s.send(start(), 10000000);
      await settled();
      expect(s.context.sources[0].loopStart).toBe(0.25);
      expect(s.context.sources[0].loopEnd).toBe(0.75);
      s.engine.dispose();
    }
  });
  it("advances late looping starts by lateness and pitch", async () => {
    const s = setup();
    s.send(registration({ loop: { mode: "forward", begin: 0, end: 8 } }));
    s.send(start({ offset_s: 0.1, pitch: 2 }), 9900000);
    await settled();
    expect(s.context.sources[0].starts[0][1]).toBeCloseTo(0.3);
    s.engine.dispose();
  });
  it("integrates pitch across pauses and resumes on the voice-relative timeline", async () => {
    const s = setup();
    s.send(registration());
    s.send(start(), 1000000);
    await settled();
    s.send({ type: "pitch", voice: 1, pitch: 2 }, 1100000);
    s.send({ type: "pause", voice: 1, paused: true }, 1300000);
    s.send({ type: "pitch", voice: 1, pitch: 0.5 }, 1400000);
    s.send({ type: "pause", voice: 1, paused: false }, 1500000);
    const [first, resumed] = s.context.sources;
    expect(first.playbackRate.values).toEqual([
      [1, 10],
      [2, 10.1],
    ]);
    expect(first.stops).toEqual([10.3]);
    expect(resumed.starts[0][0]).toBe(10.5);
    expect(resumed.starts[0][1]).toBeCloseTo(0.5);
    expect(resumed.playbackRate.values).toEqual([[0.5, 10.5]]);
    s.send({ type: "stop", voice: 1, reason: "end" }, 1700000);
    s.send({ type: "stop", voice: 1, reason: "stop" }, 1800000);
    expect(resumed.stops).toEqual([10.7]);
    first.end();
    resumed.end();
    expect(s.stages.filter((r) => r.type === "sample-stop")).toHaveLength(1);
    s.engine.dispose();
    expect(resumed.stops).toHaveLength(1);
  });
  it("queues commands during decoding, preserving full voice duration after actual start", async () => {
    const s = setup();
    let resolve!: (bytes: ArrayBuffer) => void;
    s.fetch.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    s.send(registration());
    s.send(start(), 1000000);
    s.send({ type: "pitch", voice: 1, pitch: 2 }, 1200000);
    s.send({ type: "stop", voice: 1, reason: "end" }, 1400000);
    await settled();
    expect(s.context.sources).toHaveLength(0);
    s.context.currentTime = 20;
    resolve(new ArrayBuffer(64));
    await settled();
    expect(s.context.sources[0].starts).toEqual([[20, 0]]);
    expect(s.context.sources[0].playbackRate.values).toEqual([
      [1, 20],
      [2, 20.2],
    ]);
    expect(s.context.sources[0].stops).toEqual([20.4]);
    s.engine.dispose();
  });
  it("retains no-store data across concurrent voices and pause, releasing after the last end", async () => {
    const s = setup();
    s.send(registration({ store: false }));
    s.send(start());
    s.send(start({ voice: 2 }));
    await settled();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.fetch.mock.calls[0]).toEqual([
      HASH,
      { store: false, cache: "no-store" },
    ]);
    s.send({ type: "pause", voice: 2, paused: true });
    s.context.sources[1].end();
    s.context.sources[0].end();
    s.send({ type: "pause", voice: 2, paused: false });
    expect(s.fetch).toHaveBeenCalledTimes(1);
    s.context.sources[2].end();
    s.send(start({ voice: 3 }));
    await settled();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    s.engine.dispose();
  });
  it("downgrades a cached registration to no-store before the next bus-bound start", async () => {
    const s = setup();
    s.send(registration());
    s.send(start());
    await settled();
    s.context.sources[0].end();
    s.send(registration({ store: false }));
    s.send(start({ voice: 2 }));
    await settled();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.fetch.mock.calls[1]).toEqual([
      HASH,
      { store: false, cache: "no-store" },
    ]);
    s.engine.dispose();
  });
  it("reuses stored samples and retains an unregistered sample only for its existing voice", async () => {
    const s = setup();
    s.send(registration());
    s.send(start());
    await settled();
    s.context.sources[0].end();
    s.send(start({ voice: 2 }));
    await settled();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    s.send({ type: "sample-drop", id: 1 });
    s.send({ type: "pause", voice: 2, paused: true });
    s.context.sources[1].end();
    s.send({ type: "pause", voice: 2, paused: false });
    expect(s.context.sources).toHaveLength(3);
    s.engine.dispose();
  });
  it("restores a paused snapshot voice after its following registration, at position_s", async () => {
    const s = setup();
    s.engine.snapshot({
      type: "audio-state",
      t: 9000000,
      s: 9000000,
      godot: {
        buses: [],
        voices: [{ ...start(), position_s: 0.4, paused: true }],
      },
      fmod: null,
    });
    expect(s.fetch).not.toHaveBeenCalled();
    s.send(registration());
    await settled();
    expect(s.context.sources).toHaveLength(0);
    s.send({ type: "pause", voice: 1, paused: false }, 9100000);
    expect(s.context.sources[0].starts).toEqual([[10.1, 0.4]]);
    s.engine.dispose();
  });
  it("catches a running snapshot loop up from position_s without advancing a paused loop", async () => {
    for (const paused of [false, true]) {
      const s = setup();
      s.engine.snapshot({
        type: "audio-state",
        t: 9500000,
        s: 9500000,
        godot: { buses: [], voices: [{ ...start(), position_s: 0.2, paused }] },
        fmod: null,
      });
      s.send(registration({ loop: { mode: "forward", begin: 0, end: 8 } }));
      await settled();
      if (paused) s.send({ type: "pause", voice: 1, paused: false }, 9500000);
      expect(s.context.sources[0].starts[0][1]).toBeCloseTo(paused ? 0.2 : 0.7);
      s.engine.dispose();
    }
  });
  it("waits for a supported lazy variant and ignores decode completion after reset", async () => {
    const s = setup();
    s.send(registration({ variants: [] }));
    s.send(start());
    await settled();
    expect(s.fetch).not.toHaveBeenCalled();
    s.send({
      type: "sample-variant",
      id: 1,
      codec: "wav",
      hash: HASH,
      bytes: 64,
    });
    s.engine.reset();
    await settled();
    expect(s.context.sources).toHaveLength(0);
    expect(s.failure).not.toHaveBeenCalled();
    s.engine.dispose();
  });
  it("fails the session on asset failure without an unhandled rejection", async () => {
    const s = setup();
    s.fetch.mockRejectedValueOnce(new Error("fetch failed"));
    s.send(registration());
    s.send(start());
    await settled();
    expect(s.failure).toHaveBeenCalledTimes(1);
    s.engine.dispose();
  });
  it("schedules per-bus voice volumes relative to actual start and keeps routes through bus moves", async () => {
    const s = setup();
    s.engine.snapshot({
      type: "audio-state",
      t: 0,
      s: 0,
      godot: { buses: [state(), state({ name: "SFX" })], voices: [] },
      fmod: null,
    });
    s.send(registration());
    s.send(start());
    await settled();
    s.send(
      {
        type: "voice-volumes",
        voice: 1,
        buses: [{ bus: 1, v: VOLUMES.map((v) => v / 2) }],
      },
      1200000,
    );
    const source = s.context.sources[0];
    const front = (input: Node) =>
      input.connections[0].node.connections[0].node.gain;
    expect(source.connections).toHaveLength(2);
    expect(front(source.connections[0].node).values.at(-1)).toEqual([0, 10.2]);
    expect(front(source.connections[1].node).values.at(-1)).toEqual([
      0.5, 10.2,
    ]);
    s.send({ type: "bus", op: "add", bus: 1 });
    s.send(
      { type: "voice-volumes", voice: 1, buses: [{ bus: 2, v: VOLUMES }] },
      1300000,
    );
    expect(source.connections).toHaveLength(2);
    expect(front(source.connections[1].node).values.at(-1)).toEqual([1, 10.3]);
    s.engine.dispose();
  });
  it("retains pending routes by identity while bus indices shift during asset decode", async () => {
    const s = setup();
    let resolve!: (b: ArrayBuffer) => void;
    s.fetch.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    s.engine.snapshot({
      type: "audio-state",
      t: 0,
      s: 0,
      godot: { buses: [state(), state({ name: "SFX" })], voices: [] },
      fmod: null,
    });
    s.send(registration());
    s.send(start({ bus: 1 }));
    s.send(
      {
        type: "voice-volumes",
        voice: 1,
        buses: [{ bus: 1, v: VOLUMES.map((v) => v / 2) }],
      },
      1200000,
    );
    s.send({ type: "bus", op: "add", bus: 1 });
    s.send({ type: "bus", op: "volume_db", bus: 2, value: -6 });
    await settled();
    resolve(new ArrayBuffer(64));
    await settled();
    const source = s.context.sources[0],
      input = source.connections[0].node;
    const bus =
      input.connections[0].node.connections[0].node.connections[0].node
        .connections[0].node;
    expect(bus.gain.value).toBeCloseTo(10 ** (-6 / 20));
    expect(source.connections).toHaveLength(1);
    s.engine.dispose();
  });
  it("refetches with no-store when an active stored registration is downgraded", async () => {
    const s = setup();
    s.send(registration());
    s.send(start());
    await settled();
    s.send(registration({ store: false }));
    s.send(start({ voice: 2 }));
    await settled();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.fetch.mock.calls[1]).toEqual([
      HASH,
      { store: false, cache: "no-store" },
    ]);
    s.engine.dispose();
  });
  it("counts a natural end once and never invents a voice-stop event", async () => {
    const s = setup();
    s.send(registration({ store: false }));
    s.send(start());
    await settled();
    s.context.sources[0].end();
    s.context.sources[0].end();
    expect(s.active).toHaveBeenLastCalledWith(0);
    expect(s.stages.filter((r) => r.type === "sample-stop")).toHaveLength(0);
    s.send({ type: "stop", voice: 1, reason: "end" }, 2000000);
    s.send({ type: "stop", voice: 1, reason: "end" }, 2000000);
    expect(s.context.sources[0].stops).toHaveLength(0);
    expect(s.stages.filter((r) => r.type === "sample-stop")).toHaveLength(1);
    s.engine.dispose();
  });
});

describe("Godot sample buses", () => {
  function setupBuses(states: AudioBusState[] = []) {
    const context = new Context(),
      buses = new SampleBuses(context as unknown as AudioContextLike);
    buses.snapshot(states);
    return { buses, context };
  }
  it("restores bus gains, mute, sends and default Master, with -1 voice fallback", () => {
    const { buses, context } = setupBuses();
    const master = buses.route(-1).bus;
    expect(master.input.gain.value).toBe(1);
    expect(master.output.connections[0].node).toBe(context.destination);
    buses.snapshot([
      state({ volume_db: -6 }),
      state({ name: "SFX", volume_db: -12, send: 0, mute: true }),
    ]);
    const route = buses.route(1);
    expect(route.bus.input.gain.value).toBeCloseTo(10 ** (-12 / 20));
    expect(route.bus.output.gain.value).toBe(0);
    expect(route.bus.target).toBe(buses.route(0).bus);
    buses.command({ type: "bus", op: "volume_db", bus: 1, value: -3 });
    expect(route.bus.input.gain.value).toBeCloseTo(10 ** (-3 / 20));
    buses.command({ type: "bus", op: "mute", bus: 1, value: false });
    expect(route.bus.output.gain.value).toBe(1);
    buses.command({ type: "bus", op: "send", bus: 1, value: -1 });
    expect(route.bus.output.connections[0].node).toBe(context.destination);
    buses.dispose();
  });
  it("matches the web driver's single-solo gate and keeps mute multiplicative", () => {
    const { buses } = setupBuses([
      state(),
      state({ name: "A" }),
      state({ name: "B" }),
    ]);
    const a = buses.route(1).bus,
      b = buses.route(2).bus;
    buses.command({ type: "bus", op: "solo", bus: 1, value: true });
    expect(a.solo.gain.value).toBe(1);
    expect(b.solo.gain.value).toBe(0);
    buses.command({ type: "bus", op: "mute", bus: 1, value: true });
    expect(a.output.gain.value * a.solo.gain.value).toBe(0);
    buses.command({ type: "bus", op: "solo", bus: 2, value: true });
    expect(a.solo.gain.value).toBe(0);
    expect(b.solo.gain.value).toBe(1);
    buses.command({ type: "bus", op: "solo", bus: 1, value: false });
    expect(a.solo.gain.value).toBe(0);
    buses.command({ type: "bus", op: "solo", bus: 2, value: false });
    expect(a.solo.gain.value).toBe(1);
    buses.dispose();
  });
  it("preserves bus objects across insert/move/remove and reroutes deleted sends and voices", () => {
    const { buses } = setupBuses([
      state(),
      state({ name: "A" }),
      state({ name: "B", send: 1 }),
    ]);
    const a = buses.route(1),
      b = buses.route(2);
    buses.command({ type: "bus", op: "add", bus: 1 });
    expect(buses.route(2).bus).toBe(a.bus);
    expect(b.bus.target).toBe(a.bus);
    buses.command({ type: "bus", op: "move", bus: 3, value: 1 });
    expect(buses.route(1).bus).toBe(b.bus);
    buses.command({ type: "bus", op: "move", bus: 1, value: -1 });
    expect(buses.route(3).bus).toBe(b.bus);
    buses.command({ type: "bus", op: "remove", bus: 2 });
    expect(a.bus).toBe(buses.route(0).bus);
    expect(b.bus.target).toBe(null);
    buses.command({ type: "bus", op: "count", bus: 0, value: 1 });
    expect(b.bus).toBe(buses.route(0).bus);
    buses.command({ type: "bus", op: "count", bus: 0, value: 3 });
    expect(buses.route(2).bus.input.gain.value).toBe(1);
    buses.dispose();
  });
  it("maps all four linear stereo pairs without product volume curves", () => {
    const { buses } = setupBuses();
    const route = buses.route(0);
    buses.volumes(route, VOLUMES, 12);
    expect(route.gains.map((g) => (g.gain as unknown as Param).values)).toEqual(
      [1, 0.9, 0.8, 0.7, 0.4, 0.3, 0.6, 0.5].map((v) => [[v, 12]]),
    );
    buses.dispose();
  });
  it.each<BusCommand>([
    { type: "bus", op: "remove", bus: 4 },
    { type: "bus", op: "volume_db", bus: -1, value: 0 },
    { type: "bus", op: "send", bus: 0, value: 5 },
    { type: "bus", op: "move", bus: 1, value: 8 },
    { type: "bus", op: "add", bus: 5 },
  ])("rejects out-of-range bus command %j", (m) => {
    const { buses } = setupBuses();
    expect(() => buses.command(m)).toThrow("audio-protocol");
    buses.dispose();
  });
});

describe("Godot audio wire validation", () => {
  it.each([
    { ...registration(), loop: { mode: "other", begin: 0, end: 0 } },
    {
      ...registration(),
      variants: [{ codec: "wav", hash: "wrong", bytes: 64 }],
    },
    { ...start(), bus: "Master" },
    { ...start(), pitch: 0 },
    { ...start(), volumes: [1, 1] },
    { type: "pitch", voice: 1, pitch: -1 },
    { type: "pause", voice: 1, paused: 0 },
    { type: "voice-volumes", voice: 1, buses: [{ bus: 0, v: [1] }] },
    { type: "bus", op: "count", bus: 0, value: 0 },
    { type: "bus", op: "send", bus: 1, value: "Master" },
    { type: "bus", op: "mute", bus: 1, value: 1 },
    { type: "bus", op: "unknown", bus: 0 },
    {
      type: "audio-state",
      godot: { buses: [{ ...state(), send: "Master" }], voices: [] },
      fmod: null,
    },
  ])("rejects malformed sample/voice/bus members %j", (m) => {
    expect(() => decodeAudioText(JSON.stringify({ ...m, t: 1, s: 1 }))).toThrow(
      "audio-protocol",
    );
  });
});
