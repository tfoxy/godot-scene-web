// Adapted from sts2-couch-coop mainSink.ts; copyright 2026 Tomás Fox, MIT.
// Arrival-time one-shots, streaming takes and clocked lanes share the same node lifecycle.
import { createKeepAlive, type KeepAliveHandle } from "./keepAlive";
import { LaneJitterBuffer } from "./laneJitterBuffer";
import { blockPcm, type Take } from "./takeStore";
import type { AudioCue, Block, LinkLane } from "./wire";

export type AudioContextLike = Pick<
  AudioContext,
  | "currentTime"
  | "destination"
  | "createGain"
  | "createBuffer"
  | "createBufferSource"
  | "createConstantSource"
  | "getOutputTimestamp"
  | "resume"
  | "decodeAudioData"
  | "createChannelSplitter"
  | "createChannelMerger"
>;
export const LANE_LEAD_MIN_S = 0.06;
export const LANE_LEAD_MAX_S = 0.25;
export const LANE_LEAD_MARGIN_S = 0.02;

export interface AudioStage {
  type: string;
  handledMs: number;
  contextTime?: number;
  t?: number;
  voice?: number;
  s?: number;
  lane?: number;
  stream?: number;
  block?: number;
  count?: number;
  made_us?: number;
  due_us?: number;
  sent_us?: number;
  path?: "main" | "worker" | "worklet";
  lag_ms?: number;
  items?: number;
  handle_ms?: number;
  lane_spans?: number;
  lane_blocks?: number;
  lead_ms?: number;
  at?: "worker";
}
interface Voice {
  gain: GainNode;
  group: string;
  volume: number;
  pitch: number;
  sources: Set<AudioBufferSourceNode>;
  nextAt: number;
  done: boolean;
}
interface Lane {
  jitter: LaneJitterBuffer;
  epoch: number;
  voice: Voice;
}
export class MainAudioEngine {
  private voices = new Set<Voice>();
  private sampleActive = 0;
  private laneLead = LANE_LEAD_MIN_S;
  private buffers = new WeakMap<Take, AudioBuffer>();
  private takes = new Map<number, Voice[]>();
  private lanes = new Map<number, Lane>();
  private groups: Record<string, number> = {};
  private loopKeys = new Map<string, Set<string>>();
  private keepAlive: KeepAliveHandle;
  constructor(
    readonly context: AudioContextLike,
    private stage?: (row: Omit<AudioStage, "handledMs">) => void,
    private options: { laneLead?: "adaptive" } = {},
  ) {
    this.keepAlive = createKeepAlive(context as AudioContext, () => {
      if (this.sampleActive !== 0) return false;
      for (const v of this.voices) if (v.sources.size !== 0) return false;
      return true;
    });
  }
  setSampleActive(count: number): void {
    this.sampleActive = count;
    this.touch();
  }
  private touch(): void {
    this.keepAlive.update();
  }
  private groupGain(group: string): number {
    return Object.hasOwn(this.groups, group) ? this.groups[group] : 1;
  }
  setGroups(gains: Record<string, number>, snapshot: boolean): void {
    this.groups = snapshot ? { ...gains } : { ...this.groups, ...gains };
    for (const v of this.voices)
      v.gain.gain.setTargetAtTime(
        v.volume * this.groupGain(v.group),
        this.context.currentTime,
        0.015,
      );
    for (const [id] of this.lanes) this.updateLaneGate(id);
  }
  private voice(
    group: string,
    volume: number,
    pitch: number,
    done: boolean,
  ): Voice {
    const gain = this.context.createGain();
    gain.gain.value = volume * this.groupGain(group);
    gain.connect(this.context.destination);
    const voice = {
      gain,
      group,
      volume,
      pitch,
      sources: new Set<AudioBufferSourceNode>(),
      nextAt: this.context.currentTime + 0.005,
      done,
    };
    this.voices.add(voice);
    return voice;
  }
  private buffer(pcm: Float32Array[]): AudioBuffer {
    const b = this.context.createBuffer(2, pcm[0].length, 48000);
    for (let c = 0; c < 2; c++) b.getChannelData(c).set(pcm[c]);
    return b;
  }
  private schedule(
    v: Voice,
    pcm: Float32Array[] | AudioBuffer,
    at: number,
    fade = false,
    offset = 0,
  ): void {
    const source = this.context.createBufferSource();
    source.buffer = Array.isArray(pcm) ? this.buffer(pcm) : pcm;
    source.playbackRate.value = v.pitch;
    let blockGain: GainNode | undefined;
    if (fade) {
      blockGain = this.context.createGain();
      blockGain.gain.setValueAtTime(0, at);
      blockGain.gain.linearRampToValueAtTime(1, at + 0.005);
      source.connect(blockGain);
      blockGain.connect(v.gain);
    } else source.connect(v.gain);
    const wasEmpty = v.sources.size === 0;
    v.sources.add(source);
    source.onended = () => {
      v.sources.delete(source);
      source.disconnect();
      blockGain?.disconnect();
      if (v.done && v.sources.size === 0) {
        v.gain.disconnect();
        this.voices.delete(v);
      }
      if (v.sources.size === 0) this.touch();
    };
    if (offset > 0) source.start(at, offset);
    else source.start(at);
    if (wasEmpty) this.touch();
  }
  loadTake(take: Take): AudioBuffer {
    let buffer = this.buffers.get(take);
    if (!buffer) {
      buffer = this.buffer(take.pcm);
      this.buffers.set(take, buffer);
    }
    return buffer;
  }
  play(take: Take, cue: AudioCue): void {
    if (cue.volume * this.groupGain(cue.group) <= 0) return;
    const v = this.voice(cue.group, cue.volume, cue.pitch, true);
    this.schedule(v, this.loadTake(take), this.context.currentTime);
    this.stage?.({
      type: "cached-start",
      contextTime: this.context.currentTime,
      t: cue.t,
      s: cue.s,
    });
  }
  beginTake(stream: number, cues: AudioCue[]): void {
    this.takes.set(
      stream,
      cues.map((cue) => this.voice(cue.group, cue.volume, cue.pitch, false)),
    );
  }
  abortTake(stream: number): void {
    for (const v of this.takes.get(stream) ?? []) {
      v.done = true;
      if (v.sources.size === 0) {
        v.gain.disconnect();
        this.voices.delete(v);
      }
    }
    this.takes.delete(stream);
    this.touch();
  }
  takeBlock(block: Block, pcm: Float32Array[]): void {
    const list = this.takes.get(block.header.stream);
    if (!list) throw new Error("audio-protocol");
    for (const v of list) {
      const at = Math.max(this.context.currentTime + 0.005, v.nextAt);
      this.schedule(v, pcm, at, v.nextAt < this.context.currentTime + 0.001);
      v.nextAt = at + block.header.frames / (48000 * v.pitch);
      if (block.header.flags & 2) v.done = true;
      this.stage?.({
        type: "take-source-start",
        stream: block.header.stream,
        block: block.header.block,
        contextTime: at,
      });
    }
    if (block.header.flags & 2) this.takes.delete(block.header.stream);
  }
  private stop(v: Voice): void {
    v.done = true;
    for (const s of v.sources) {
      s.onended?.(new Event("ended"));
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    v.sources.clear();
    v.gain.disconnect();
    this.voices.delete(v);
    this.touch();
  }
  private setLaneLead(lead: number): void {
    if (lead === this.laneLead) return;
    this.laneLead = lead;
    this.stage?.({ type: "lane-lead", lead_ms: lead * 1000 });
  }
  laneBlock(
    block: Block,
    lane: LinkLane,
    dueContextTime: number,
    pcm?: Float32Array[],
    count = 1,
  ): void {
    let state = this.lanes.get(lane.id);
    if (!state) {
      state = {
        jitter: new LaneJitterBuffer(),
        epoch: -1,
        voice: this.voice(lane.group, 1, 1, false),
      };
      this.lanes.set(lane.id, state);
      this.updateLaneGate(lane.id);
    }
    const h = block.header;
    const adaptive = this.options.laneLead === "adaptive";
    if (
      adaptive &&
      block.header.stream > state.epoch &&
      [...this.lanes.values()].every((l) => l.voice.sources.size === 0)
    )
      this.setLaneLead(LANE_LEAD_MIN_S);
    const now = this.context.currentTime;
    const need = now - dueContextTime + LANE_LEAD_MARGIN_S;
    const target =
      adaptive && need > this.laneLead
        ? Math.min(need, LANE_LEAD_MAX_S)
        : this.laneLead;
    const raised = target > this.laneLead;
    const duration = h.frames / 48000;
    const late = need - target;
    let k = 0;
    while (
      k < count &&
      (adaptive
        ? k * duration < late
        : dueContextTime + k * duration + target < now)
    )
      k++;
    const drop = (block: number, count: number) =>
      this.stage?.({
        type: "lane-drop",
        lane: lane.id,
        stream: h.stream,
        block,
        count,
      });
    state.epoch = Math.max(state.epoch, h.stream);
    if (k >= count) {
      state.jitter.accept(
        h.stream,
        h.block + count - 1,
        dueContextTime + (count - 1) * duration,
        Infinity,
        !!(h.flags & 8),
        this.laneLead,
      );
      drop(h.block, count);
      return;
    }
    const decision = state.jitter.accept(
      h.stream,
      h.block + k,
      dueContextTime + k * duration,
      now,
      !!(h.flags & 8),
      target,
      count - k,
    );
    if (!decision) {
      drop(h.block, count);
      return;
    }
    if (k) drop(h.block, k);
    this.setLaneLead(target);
    if (decision.newEpoch && state.voice.sources.size) {
      const volume = state.voice.volume;
      this.stop(state.voice);
      state.voice = this.voice(lane.group, volume, 1, false);
    }
    this.schedule(
      state.voice,
      pcm ?? blockPcm(block),
      decision.at,
      decision.fade || raised,
      k * duration,
    );
    this.stage?.({
      type: "lane-start",
      lane: lane.id,
      stream: h.stream,
      block: h.block + k,
      count: count - k,
      contextTime: decision.at,
      due_us: Number(h.due_us) + Math.round(k * duration * 1e6),
      made_us: Number(h.made_us),
      sent_us: Number(h.sent_us),
    });
  }
  gate(cue: AudioCue): void {
    let keys = this.loopKeys.get(cue.group);
    if (!keys) {
      keys = new Set();
      this.loopKeys.set(cue.group, keys);
    }
    if (cue.kind === "loop-start") keys.add(cue.key_id);
    else if (cue.kind === "loop-stop") keys.delete(cue.key_id);
    else keys.clear();
    for (const [id] of this.lanes) this.updateLaneGate(id);
  }
  private updateLaneGate(id: number): void {
    const v = this.lanes.get(id)?.voice;
    if (!v) return;
    v.volume =
      this.loopKeys.has(v.group) && this.loopKeys.get(v.group)?.size === 0
        ? 0
        : 1;
    v.gain.gain.setTargetAtTime(
      v.volume * this.groupGain(v.group),
      this.context.currentTime,
      0.015,
    );
  }
  stopLane(id: number): void {
    const lane = this.lanes.get(id);
    if (lane) this.stop(lane.voice);
    this.lanes.delete(id);
  }
  reset(): void {
    for (const v of [...this.voices]) this.stop(v);
    this.takes.clear();
    this.lanes.clear();
    this.groups = {};
    this.loopKeys.clear();
    this.setLaneLead(LANE_LEAD_MIN_S);
  }
  dispose(): void {
    this.reset();
    this.keepAlive.dispose();
  }
}
