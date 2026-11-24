// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";
import type { AudioContextLike, AudioStage } from "../src/audio/mainEngine";
import { MixerCore } from "../src/audio/mixerCore";
import {
  openAudioTrack as openPublicTrack,
  supportsAudioWorklet,
} from "../src/audio/path";
import {
  type AudioTrack,
  openAudioTrack as openMainTrack,
} from "../src/audio/session";

vi.mock("../src/audio/session", () => ({ openAudioTrack: vi.fn() }));

import type { SinkEnvelope } from "../src/audio/sinkProtocol";
import { type Take, TakeStore } from "../src/audio/takeStore";
import type { AudioCue, Block } from "../src/audio/wire";
import { WorkletAudioEngine } from "../src/audio/workletEngine";

const take: Take = {
  bankset: "bank",
  keyId: "key",
  hash: "hash",
  frames: 480,
  pcm: [new Float32Array(480).fill(0.5), new Float32Array(480).fill(-0.5)],
};
const cue: AudioCue = {
  type: "cue",
  kind: "oneshot",
  key_id: "key",
  group: "sfx",
  volume: 0.5,
  pitch: 1,
  t: 100,
  s: 110,
};
function fixture() {
  const rows: Omit<AudioStage, "handledMs">[] = [];
  const core = new MixerCore(48000, (row) => rows.push(row));
  let time = 0;
  const engine = new WorkletAudioEngine({
    postMessage: (m: SinkEnvelope) => core.handle(structuredClone(m), time),
  });
  const render = (at = time, n = 128) => {
    const left = new Float32Array(n),
      right = new Float32Array(n);
    time = at;
    core.render(left, right, at);
    time += n / 48000;
    return { left, right };
  };
  return {
    core,
    engine,
    rows,
    render,
    setTime: (at: number) => {
      time = at;
    },
  };
}
function block(index = 0, dueFlags = 1): Block {
  return {
    header: {
      kind: 2,
      flags: dueFlags,
      lane: 9,
      stream: 5,
      block: index,
      frames: 480,
      made_us: 0n,
      due_us: 0n,
      sent_us: 0n,
    },
    payload: new Uint8Array(1920),
  } as Block;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("audio worklet port", () => {
  it("publishes the independent audio subpath and notice", () => {
    expect(packageJson.exports).toHaveProperty("./audio", {
      development: "./src/audio.ts",
      types: "./dist/audio.d.ts",
      import: "./dist/audio.js",
    });
    expect(packageJson.files).toContain("THIRD-PARTY-NOTICES");
  });
  it("starts cached cues at receipt with stereo PCM and final gain", () => {
    const f = fixture();
    f.engine.loadTake(take);
    f.engine.play(take, cue);
    const out = f.render();
    expect(out.left[0]).toBe(0.25);
    expect(out.right[0]).toBe(-0.25);
    expect(f.rows.filter((r) => r.type === "cached-start")).toHaveLength(1);
    expect(f.rows[0].contextTime).toBe(0);
    expect(take.pcm[0][0]).toBe(0.5);
  });
  it("resamples 48 kHz PCM at the output rate and applies pitch", () => {
    const core = new MixerCore(24000);
    const sample = {
      ...take,
      pcm: [
        Float32Array.from([0, 0.25, 0.5, 0.75]),
        Float32Array.from([0, 0.25, 0.5, 0.75]),
      ],
    };
    core.handle({ epoch: 0, command: { kind: "load", take: sample } }, 0);
    core.handle(
      {
        epoch: 0,
        command: {
          kind: "play",
          key: "bank/key",
          cue: { ...cue, volume: 1 },
          handledMs: 0,
        },
      },
      0,
    );
    const left = new Float32Array(2),
      right = new Float32Array(2);
    core.render(left, right, 0);
    expect([...left]).toEqual([0, 0.5]);
  });
  it("idle DC is absent while a cue or native sample voice is active", () => {
    const f = fixture();
    expect(f.render().left[0]).toBeCloseTo(1e-5, 9);
    f.engine.setSampleActive(1);
    expect(f.render().left[0]).toBe(0);
    f.engine.setSampleActive(0);
    expect(f.render().left[0]).toBeCloseTo(1e-5, 9);
  });
  it("mixes the native sample input without adding DC", () => {
    const core = new MixerCore(48000);
    core.handle({ epoch: 0, command: { kind: "sample-active", count: 1 } }, 0);
    const left = new Float32Array(128),
      right = new Float32Array(128);
    core.render(left, right, 0, [
      new Float32Array(128).fill(0.2),
      new Float32Array(128).fill(-0.2),
    ]);
    expect(left[0]).toBeCloseTo(0.2);
    expect(right[0]).toBeCloseTo(-0.2);
  });
  it("smooths arbitrary group gains on existing cues", () => {
    const f = fixture();
    f.engine.loadTake(take);
    f.engine.play(take, cue);
    expect(f.render().left[0]).toBe(0.25);
    f.engine.setGroups({ sfx: 0 }, false);
    const out = f.render();
    expect(out.left[127]).toBeLessThan(out.left[0]);
  });
  it("chains first-sight take blocks and stops after the last", () => {
    const f = fixture();
    f.engine.beginTake(5, [cue]);
    f.engine.takeBlock(block(0, 1), take.pcm);
    f.engine.takeBlock(block(1, 2), take.pcm);
    expect(f.rows.map((r) => r.contextTime)).toEqual([0.005, 0.015]);
    expect(f.render(0.005).left[0]).toBe(0.25);
    f.render(0.03, 1024);
    expect(f.render(0.06).left[0]).toBeCloseTo(1e-5, 9);
  });
  it.each([
    false,
    true,
  ])("drains aborted take voices (queued blocks: %s)", (queued) => {
    const f = fixture();
    f.engine.loadTake(take);
    f.engine.beginTake(5, [cue]);
    if (queued) f.engine.takeBlock(block(0, 1), take.pcm);
    f.engine.abortTake(5);
    f.render(0, 2048);
    const state = f.core as unknown as {
      streams: Map<number, unknown>;
      voices: Set<unknown>;
    };
    expect(state.streams.size).toBe(0);
    expect(state.voices.size).toBe(0);
    f.engine.play(take, cue);
    expect(f.render(0.1).left[0]).toBe(0.25);
  });
  it("drops lane backlog after a stall, accepts the next gap and stops the lane", () => {
    const f = fixture(),
      lane = { id: 9, group: "custom", state: "on" } as const;
    f.setTime(1);
    f.engine.laneBlock(block(), lane, 0);
    expect(f.rows[0].type).toBe("lane-drop");
    const b = block(10, 8);
    b.payload.fill(1);
    f.engine.laneBlock(b, lane, 1);
    expect(f.rows[1]).toMatchObject({
      type: "lane-start",
      lane: 9,
      block: 10,
      contextTime: 1.06,
    });
    f.engine.stopLane(9);
    expect(f.render(1.065).left[0]).toBeCloseTo(1e-5, 9);
  });
  it("new lane stream removes queued sources from its old stream", () => {
    const f = fixture(),
      lane = { id: 9, group: "custom", state: "on" } as const;
    const a = block();
    a.payload.fill(100);
    f.engine.laneBlock(a, lane, 0);
    const b = block();
    b.header.stream = 6;
    f.engine.laneBlock(b, lane, 0);
    expect(f.render(0.065).left[0]).toBe(0);
  });
  it("fences stale messages and keeps the resident take across reconnect", () => {
    const f = fixture();
    f.engine.loadTake(take);
    f.engine.play(take, cue);
    f.engine.reset();
    f.core.handle(
      {
        epoch: 0,
        command: { kind: "play", key: "bank/key", cue, handledMs: 0 },
      },
      0,
    );
    expect(f.render().left[0]).toBeCloseTo(1e-5, 9);
    f.engine.play(take, cue);
    expect(f.render().left[0]).toBe(0.25);
  });
  it("sends worker commands without transferring retained PCM", () => {
    const postMessage = vi.fn();
    const e = new WorkletAudioEngine({ postMessage });
    e.loadTake(take);
    expect(postMessage.mock.calls[0]).toHaveLength(1);
    expect(take.pcm[0].length).toBe(480);
  });
  it("enumerates resident takes from all banks for Worker initialization", () => {
    const store = new TakeStore();
    store.put(take);
    store.put({ ...take, bankset: "other" });
    expect(store.entries()).toHaveLength(2);
    store.resetStreams();
    expect(store.entries()).toHaveLength(2);
  });
  it("selects worklet only on secure contexts with both Worker and worklet APIs", () => {
    const context = { audioWorklet: {} } as AudioContextLike;
    expect(supportsAudioWorklet(context)).toBe(false);
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("AudioWorkletNode", class {});
    expect(supportsAudioWorklet(context)).toBe(true);
    vi.stubGlobal("isSecureContext", false);
    expect(supportsAudioWorklet(context)).toBe(false);
  });
});

describe("audio path lifecycle", () => {
  function context(addModule = vi.fn(async () => {})) {
    return {
      currentTime: 0,
      state: "running",
      audioWorklet: { addModule },
      resume: vi.fn(async () => {}),
      getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AudioContextLike;
  }
  function secure() {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("Worker", vi.fn());
    vi.stubGlobal("AudioWorkletNode", vi.fn());
  }
  it("close during module loading never opens a socket or creates a mixer", async () => {
    secure();
    let loaded!: () => void;
    const addModule = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          loaded = resolve;
        }),
    );
    const onClose = vi.fn(),
      onState = vi.fn();
    const track = openPublicTrack({
      url: "ws://localhost/render-stream",
      credential: "token",
      context: context(addModule),
      onClose,
      onState,
    });
    track.close();
    track.close();
    const info = await track.finished;
    loaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(info.reason).toBe("client-close");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith("closed");
    expect(Worker).not.toHaveBeenCalled();
    expect(AudioWorkletNode).not.toHaveBeenCalled();
  });
  it("module refusal falls back once to the caller's main context", async () => {
    secure();
    const ctx = context(
      vi.fn(async () => {
        throw Error("CSP");
      }),
    );
    let end!: (value: unknown) => void;
    const result = {
      state: "connecting",
      ready: null,
      snapshot: null,
      samples: new Map(),
      store: new TakeStore(),
      finished: new Promise((resolve) => {
        end = resolve;
      }),
      close: vi.fn(() => end({ reason: "client-close" })),
    } as unknown as AudioTrack;
    vi.mocked(openMainTrack).mockReturnValue(result);
    const track = openPublicTrack({
      url: "ws://localhost/render-stream",
      credential: "token",
      context: ctx,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(openMainTrack).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openMainTrack).mock.calls[0][0].context).toBe(ctx);
    track.close();
    await track.finished;
    expect(result.close).toHaveBeenCalledTimes(1);
  });
  it("close while awaiting worklet readiness cancels its timeout and port", async () => {
    vi.useFakeTimers();
    secure();
    const disconnect = vi.fn(),
      portClose = vi.fn();
    vi.stubGlobal(
      "AudioWorkletNode",
      vi.fn(
        class FakeNode {
          connect = vi.fn();
          disconnect = disconnect;
          port = { postMessage: vi.fn(), close: portClose, onmessage: null };
        },
      ),
    );
    const track = openPublicTrack({
      url: "ws://localhost/render-stream",
      credential: "token",
      context: context(),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    track.close();
    await track.finished;
    await Promise.resolve();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(portClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(openMainTrack).not.toHaveBeenCalled();
  });
});
