// @vitest-environment node
import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AudioContextLike,
  MainAudioEngine,
} from "../src/audio/mainEngine";
import { MainSinkReceiver } from "../src/audio/mainSink";
import {
  type MainSinkCommand,
  type SinkBatch,
  SinkBatcher,
} from "../src/audio/sinkBatch";
import { type Take, TakeStore } from "../src/audio/takeStore";
import type { AudioCue, Block } from "../src/audio/wire";
import { encodeBlock, keyId } from "../src/audio/wire";
import { WorkletAudioEngine } from "../src/audio/workletEngine";

const cue: AudioCue = {
  type: "cue",
  kind: "oneshot",
  key_id: "key",
  group: "sfx",
  volume: 1,
  pitch: 1,
  t: 0,
  s: 0,
};
const lane = { id: 9, group: "music", state: "on" } as const;
function block(index = 0, stream = 5): Block {
  return {
    header: {
      kind: 2,
      flags: 0,
      lane: 9,
      stream,
      block: index,
      frames: 480,
      made_us: 0n,
      due_us: 0n,
      sent_us: 0n,
    },
    payload: new Uint8Array(1920).fill(1),
  };
}
function take(): Take {
  return {
    bankset: "bank",
    keyId: "key",
    hash: "hash",
    frames: 480,
    pcm: [new Float32Array(480).fill(0.5), new Float32Array(480).fill(-0.5)],
  };
}
function engineMock() {
  return Object.fromEntries(
    [
      "loadTake",
      "play",
      "beginTake",
      "abortTake",
      "takeBlock",
      "laneBlock",
      "stopLane",
      "setGroups",
      "gate",
      "setSampleActive",
      "reset",
    ].map((name) => [name, vi.fn()]),
  ) as unknown as MainAudioEngine;
}
function context() {
  const gains: ReturnType<typeof node>[] = [],
    sources: ReturnType<typeof node>[] = [];
  function node() {
    return {
      gain: {
        value: 1,
        setTargetAtTime: vi.fn(),
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      playbackRate: { value: 1 },
      offset: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
      buffer: null,
    };
  }
  const ctx = {
    currentTime: 0,
    destination: {},
    createGain: () => {
      const n = node();
      gains.push(n);
      return n;
    },
    createBufferSource: () => {
      const n = node();
      sources.push(n);
      return n;
    },
    createConstantSource: node,
    createBuffer: (_channels: number, length: number) => {
      const pcm = [new Float32Array(length), new Float32Array(length)];
      return { getChannelData: (c: number) => pcm[c] };
    },
  };
  return { ctx, gains, sources };
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("main sink receiver", () => {
  it("maps every command to the main engine, resolving resident take keys", () => {
    const engine = engineMock(),
      store = new TakeStore(),
      t = take();
    store.put(t);
    const sink = new MainSinkReceiver(engine, store),
      b = block();
    const commands: MainSinkCommand[] = [
      { kind: "load", key: "bank/key" },
      { kind: "play", key: "bank/key", cue, handledMs: 0 },
      { kind: "take-start", stream: 5, cues: [cue] },
      { kind: "take-block", block: { header: b.header }, pcm: t.pcm },
      { kind: "take-abort", stream: 5 },
      {
        kind: "lane-block",
        block: { header: b.header },
        lane,
        due: 1,
        pcm: t.pcm,
      },
      { kind: "lane-stop", lane: 9 },
      { kind: "gate", cue },
      { kind: "groups", gains: { sfx: 0 }, snapshot: true },
      { kind: "sample-active", count: 2 },
      { kind: "reset" },
    ];
    for (const command of commands) sink.handle({ epoch: 0, command });
    expect(engine.loadTake).toHaveBeenCalledWith(t);
    expect(engine.play).toHaveBeenCalledWith(t, cue);
    expect(engine.beginTake).toHaveBeenCalledWith(5, [cue]);
    expect(engine.takeBlock).toHaveBeenCalledWith(
      { header: b.header, payload: new Uint8Array(0) },
      t.pcm,
    );
    expect(engine.abortTake).toHaveBeenCalledWith(5);
    expect(engine.laneBlock).toHaveBeenCalledWith(
      { header: b.header, payload: new Uint8Array(0) },
      lane,
      1,
      t.pcm,
    );
    expect(engine.stopLane).toHaveBeenCalledWith(9);
    expect(engine.gate).toHaveBeenCalledWith(cue);
    expect(engine.setGroups).toHaveBeenCalledWith({ sfx: 0 }, true);
    expect(engine.setSampleActive).toHaveBeenCalledWith(2);
    expect(engine.reset).toHaveBeenCalledTimes(1);
  });
  it.each(["load", "play"] as const)("fails a missing %s key", (kind) => {
    const sink = new MainSinkReceiver(engineMock(), new TakeStore());
    expect(() =>
      sink.handle({
        epoch: 0,
        command:
          kind === "load"
            ? { kind, key: "bank/missing" }
            : { kind, key: "bank/missing", cue, handledMs: 0 },
      }),
    ).toThrow("audio-take-missing");
  });
  it("ignores stale epochs and resets once on adoption, keeping resident takes", () => {
    const engine = engineMock(),
      store = new TakeStore();
    store.put(take());
    const sink = new MainSinkReceiver(engine, store);
    sink.handle({ epoch: 2, command: { kind: "reset" } });
    sink.handle({ epoch: 1, command: { kind: "sample-active", count: 8 } });
    sink.handle({ epoch: 2, command: { kind: "load", key: "bank/key" } });
    expect(engine.reset).toHaveBeenCalledTimes(1);
    expect(engine.setSampleActive).not.toHaveBeenCalled();
    sink.handle({ epoch: 3, command: { kind: "sample-active", count: 1 } });
    expect(engine.reset).toHaveBeenCalledTimes(2);
    expect(engine.loadTake).toHaveBeenCalledTimes(1);
  });
});

describe("adaptive main lane lead", () => {
  it("raises and fades, drops beyond the cap, then resets to 60 ms", () => {
    const f = context(),
      stage = vi.fn();
    const e = new MainAudioEngine(f.ctx as unknown as AudioContextLike, stage, {
      laneLead: "adaptive",
    });
    e.laneBlock(block(), lane, 0);
    f.ctx.currentTime = 0.12;
    e.laneBlock(block(1), lane, 0.01);
    expect(stage).toHaveBeenCalledWith({ type: "lane-lead", lead_ms: 130 });
    expect(f.sources[1].start).toHaveBeenCalledWith(0.14);
    expect(
      f.gains.some((g) =>
        g.gain.linearRampToValueAtTime.mock.calls.some(
          (c) => c[1] === 0.14500000000000002,
        ),
      ),
    ).toBe(true);
    f.ctx.currentTime = 1;
    e.laneBlock(block(2), lane, 0.5);
    expect(f.sources).toHaveLength(2);
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "lane-drop", block: 2 }),
    );
    e.reset();
    expect(stage).toHaveBeenLastCalledWith({ type: "lane-lead", lead_ms: 60 });
    e.laneBlock(block(0, 6), lane, 1);
    expect(f.sources[2].start).toHaveBeenCalledWith(1.06);
    e.dispose();
  });
  it("lowers only for an idle new lane epoch, and leaves the all-main default fixed", () => {
    const f = context(),
      stage = vi.fn(),
      e = new MainAudioEngine(f.ctx as unknown as AudioContextLike, stage, {
        laneLead: "adaptive",
      });
    f.ctx.currentTime = 0.1;
    e.laneBlock(block(), lane, 0);
    e.laneBlock(block(0, 6), lane, 0.1);
    expect(
      stage.mock.calls.filter(([r]) => r.type === "lane-lead"),
    ).toHaveLength(1);
    e.stopLane(9);
    e.laneBlock(block(0, 7), lane, 0.1);
    expect(stage).toHaveBeenCalledWith({ type: "lane-lead", lead_ms: 60 });
    e.dispose();
    const fixed = new MainAudioEngine(
      f.ctx as unknown as AudioContextLike,
      stage,
    );
    const count = f.sources.length;
    fixed.laneBlock(block(), lane, 0);
    expect(f.sources).toHaveLength(count);
    fixed.dispose();
  });
});

describe("sink batching", () => {
  it("holds a third batch, merges on ack, and lets urgent commands flush in order", async () => {
    const send = vi.fn(),
      b = new SinkBatcher(send, () => 0);
    b.push({ kind: "stage", data: 1 });
    await tick();
    b.push({ kind: "stage", data: 2 });
    await tick();
    b.push({ kind: "stage", data: 3 });
    await tick();
    b.push({ kind: "stage", data: 4 });
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    b.ack();
    await tick();
    expect(
      send.mock.calls[2][0].items.map((i: { data: number }) => i.data),
    ).toEqual([3, 4]);
    b.push({ kind: "stage", data: 5 });
    await tick();
    b.push({ kind: "sample", data: 6 });
    b.push({ kind: "event", data: 7 });
    expect(send).toHaveBeenCalledTimes(3);
    await tick();
    expect(
      send.mock.calls[3][0].items.map((i: { data: number }) => i.data),
    ).toEqual([5, 6, 7]);
    b.push({ kind: "stage", data: 8 });
    b.ack();
    await tick();
    expect(send).toHaveBeenCalledTimes(4);
    b.ack();
    await tick();
    expect(send).toHaveBeenCalledTimes(5);
  });
  it("pre-drops held stale lanes at flush with a Worker diagnostic", async () => {
    let time = 0;
    const send = vi.fn(),
      b = new SinkBatcher(send, () => time);
    b.push({ kind: "stage" });
    await tick();
    b.push({ kind: "stage" });
    await tick();
    b.push({
      epoch: 0,
      command: { kind: "lane-block", block: block(), lane, due: 0 },
    });
    await tick();
    time = 1;
    b.ack();
    await tick();
    expect(send.mock.calls[2][0].items).toEqual([
      expect.objectContaining({
        kind: "stage",
        data: expect.objectContaining({ type: "lane-drop", at: "worker" }),
      }),
    ]);
    expect(send.mock.calls[2][1]).toEqual([]);
  });
  it("transfers detached copies while TakeStore.finish and resident takes stay intact", async () => {
    const copies: Float32Array[][] = [],
      received: SinkBatch[] = [];
    const send = (batch: SinkBatch, transfer: Transferable[]) => {
      for (const item of batch.items) {
        if ("command" in item && "pcm" in item.command)
          copies.push(item.command.pcm);
        else if ("kind" in item && item.kind === "take")
          copies.push((item.data as Take).pcm);
      }
      received.push(structuredClone(batch, { transfer }));
    };
    const b = new SinkBatcher(send, () => 0),
      store = new TakeStore(),
      t = take(),
      chunk = block();
    chunk.header.flags = 3;
    store.begin(5, "key", 480, "bank");
    const pcm = store.append(chunk);
    b.push({ epoch: 0, command: { kind: "take-block", block: chunk, pcm } });
    b.push({
      epoch: 0,
      command: { kind: "lane-block", block: block(), lane, due: 0 },
    });
    b.push({ kind: "take", data: t });
    b.push({ epoch: 0, command: { kind: "load", take: t } });
    await tick();
    expect(copies).toHaveLength(3);
    expect(copies.flat().every((p) => p.byteLength === 0)).toBe(true);
    expect(pcm[0].length).toBe(480);
    expect(t.pcm[0][0]).toBe(0.5);
    expect(store.finish(5, "key", "hash").pcm[0][0]).toBeCloseTo(257 / 32768);
    expect(received[0].items[0]).toMatchObject({
      command: { block: { header: chunk.header } },
    });
    expect(
      (received[0].items[0] as { command: { block: unknown } }).command.block,
    ).not.toHaveProperty("payload");
    expect(received[0].items[3]).toMatchObject({
      command: { kind: "load", key: "bank/key" },
    });
  });
  it("loops WorkletAudioEngine through a Node MessageChannel into the main receiver", async () => {
    const channel = new MessageChannel(),
      store = new TakeStore(),
      engine = engineMock(),
      sink = new MainSinkReceiver(engine, store);
    const batcher = new SinkBatcher(
      (batch, transfer) =>
        channel.port1.postMessage(batch, transfer as ArrayBuffer[]),
      () => 0,
    );
    const done = new Promise<void>((resolve, reject) => {
      channel.port2.on("message", (batch: SinkBatch) => {
        try {
          for (const item of batch.items) {
            if ("command" in item) sink.handle(item);
            else if (item.kind === "take") store.put(item.data as Take);
          }
          channel.port2.postMessage({ kind: "batch-ack" });
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    channel.port1.on("message", () => batcher.ack());
    try {
      const worker = new WorkletAudioEngine({
          postMessage: (item) => batcher.push(item),
        }),
        t = take();
      batcher.push({ kind: "take", data: t });
      worker.loadTake(t);
      worker.play(t, cue);
      worker.beginTake(5, [cue]);
      worker.takeBlock(block(), t.pcm);
      worker.laneBlock(block(), lane, 0);
      await done;
      expect(engine.play).toHaveBeenCalledWith(
        expect.objectContaining({ keyId: "key" }),
        cue,
      );
      expect(engine.takeBlock).toHaveBeenCalledTimes(1);
      expect(engine.laneBlock).toHaveBeenCalledTimes(1);
      expect(t.pcm[0].length).toBe(480);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
describe("audio transport Worker module loopback", () => {
  it("runs the real socket session and transfers assembled takes over Node MessageChannel", async () => {
    vi.resetModules();
    const channel = new MessageChannel(),
      store = new TakeStore(),
      engine = engineMock(),
      receiver = new MainSinkReceiver(engine, store);
    const batches: SinkBatch[] = [],
      controls: string[] = [];
    const bank = "00".repeat(16),
      key = keyId("event:/test"),
      hash = "ab".repeat(32);
    const scope = globalThis as unknown as {
      onmessage: ((e: { data: unknown }) => void) | null;
    };
    vi.stubGlobal("onmessage", null);
    vi.stubGlobal("location", { href: "http://localhost/" });
    vi.stubGlobal(
      "postMessage",
      (batch: SinkBatch, transfer: ArrayBuffer[]) => {
        expect(batch.kind).toBe("batch");
        channel.port1.postMessage(batch, transfer);
      },
    );
    let socket!: Socket;
    class Socket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
      onclose: ((e: { code: number; reason: string }) => void) | null = null;
      sent: Record<string, unknown>[] = [];
      constructor() {
        socket = this;
      }
      send(text: string) {
        this.sent.push(JSON.parse(text));
      }
      close(code: number, reason: string) {
        this.readyState = 3;
        this.onclose?.({ code, reason });
      }
      text(data: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify({ t: 0, s: 0, ...data }) });
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    let finish!: () => void, reject!: (e: unknown) => void;
    const done = new Promise<void>((resolve, fail) => {
      finish = resolve;
      reject = fail;
    });
    let played = false;
    channel.port2.on("message", (batch: SinkBatch) => {
      try {
        batches.push(batch);
        for (const item of batch.items) {
          if ("command" in item) {
            receiver.handle(item);
            if (item.command.kind === "play") played = true;
          } else {
            controls.push(item.kind);
            if (item.kind === "take") store.put(item.data as Take);
            if (item.kind === "credential")
              channel.port2.postMessage({
                kind: "credential",
                id: item.id,
                value: "ab".repeat(32),
              });
            if (item.kind === "error") throw Error(String(item.data));
            if (item.kind === "finished") finish();
          }
        }
        channel.port2.postMessage({ kind: "batch-ack" });
        if (played) {
          played = false;
          channel.port2.postMessage({ kind: "close" });
        }
      } catch (error) {
        reject(error);
      }
    });
    channel.port1.on("message", (data) => scope.onmessage?.({ data }));
    try {
      await import("../src/audio/transport.worker");
      scope.onmessage!({
        data: {
          kind: "init",
          sink: "main",
          options: {
            url: "ws://localhost/render-stream",
            credential: "",
            reconnect: false,
          },
          provider: true,
          takes: [],
          diag: true,
          anchor: {
            currentTime: 0,
            now: performance.timeOrigin + performance.now(),
            running: false,
            stamp: {},
          },
        },
      });
      // The credential provider roundtrip must complete before the socket is constructed.
      await vi.waitFor(() => expect(socket).toBeDefined());
      socket.onopen!();
      socket.text({
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
          lanes: [{ id: 9, name: "music", group: "music" }],
        },
      });
      socket.text({
        type: "audio-state",
        godot: { buses: [], voices: [] },
        fmod: {
          bankset: bank,
          groups: { sfx: 1, music: 1 },
          lanes: [{ id: 9, name: "music", group: "music" }],
        },
      });
      socket.text({
        type: "cue",
        key_id: key,
        key: "event:/test",
        kind: "oneshot",
        group: "sfx",
        pitch: 1,
        volume: 1,
      });
      socket.text({
        type: "take-start",
        bankset: bank,
        key_id: key,
        stream: 1,
        frames: 2,
      });
      const header = {
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
      } as const;
      socket.onmessage!({
        data: encodeBlock(header, new Uint8Array(8).fill(1))
          .buffer as ArrayBuffer,
      });
      socket.text({ type: "take-ready", key_id: key, stream: 1, hash });
      socket.text({
        type: "cue",
        key_id: key,
        key: "event:/test",
        kind: "oneshot",
        group: "sfx",
        pitch: 1,
        volume: 1,
      });
      socket.onmessage!({
        data: encodeBlock(
          { ...header, kind: 2, flags: 1, lane: 9, stream: 5, frames: 512 },
          new Uint8Array(2048).fill(1),
        ).buffer as ArrayBuffer,
      });
      await done;
      expect(engine.play).toHaveBeenCalledTimes(1);
      expect(engine.takeBlock).toHaveBeenCalledTimes(1);
      expect(engine.laneBlock).toHaveBeenCalledTimes(1);
      expect(store.peek(bank, key)?.pcm[0][0]).toBeCloseTo(257 / 32768);
      expect(controls).toEqual(
        expect.arrayContaining([
          "credential",
          "state",
          "open",
          "sample-snapshot",
          "event",
          "take",
          "stage",
          "reset",
          "close",
          "finished",
        ]),
      );
      expect(socket.sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "have", key_ids: [key] }),
        ]),
      );
      const items = batches.flatMap((b) => b.items),
        mirror = items.findIndex((i) => "kind" in i && i.kind === "take"),
        load = items.findIndex(
          (i) => "command" in i && i.command.kind === "load",
        );
      expect(mirror).toBeLessThan(load);
    } finally {
      scope.onmessage?.({ data: { kind: "close" } });
      channel.port1.close();
      channel.port2.close();
    }
  });
});
