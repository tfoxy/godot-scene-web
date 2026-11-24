// Adapted from sts2-couch-coop mixerCore.ts; copyright 2026 Tomás Fox, MIT.
// Segment interpolation, take lead/underrun fades, group smoothing and idle DC follow its mixer.
// Track groups and lane ids replace product buses; capture-clock deadlines replace lane reanchoring.
import { LaneJitterBuffer } from "./laneJitterBuffer";
import type { MixerStage, SinkEnvelope } from "./sinkProtocol";
import { blockPcm, type Take } from "./takeStore";

interface Voice {
  group: string;
  volume: number;
  pitch: number;
  gain: number;
  next: number;
  done: boolean;
  lane: number | null;
  segments: number;
  buf: Float32Array;
}
// Planar branch of the upstream Segment/PcmView: the wire decoder already produced f32 PCM.
class Segment {
  started = false;
  t0 = 0;
  pos = 0;
  startFrame: number;
  step: number;
  rampFrames: number;
  constructor(
    readonly pcm: Float32Array[],
    at: number,
    pitch: number,
    fade: boolean,
    readonly voice: Voice,
    sampleRate: number,
  ) {
    this.startFrame = at * sampleRate;
    this.step = (48000 / sampleRate) * pitch;
    this.rampFrames = fade ? 0.005 * sampleRate : 0;
  }
}
export class MixerCore {
  private epoch = 0;
  private takes = new Map<string, Take>();
  private streams = new Map<number, Voice[]>();
  private lanes = new Map<number, { voice: Voice; jitter: LaneJitterBuffer }>();
  private voices = new Set<Voice>();
  private segments: Segment[] = [];
  private groups: Record<string, number> = {};
  private gates = new Map<string, Set<string>>();
  private sampleActive = 0;
  private time = 0;
  constructor(
    readonly sampleRate: number,
    private stage?: (row: MixerStage) => void,
  ) {}
  setSampleActive(count: number): void {
    this.sampleActive = count;
  }
  private gain(v: Voice): number {
    return (
      v.volume *
      (Object.hasOwn(this.groups, v.group) ? this.groups[v.group] : 1) *
      (v.lane !== null &&
      this.gates.has(v.group) &&
      !this.gates.get(v.group)?.size
        ? 0
        : 1)
    );
  }
  private voice(
    group: string,
    volume: number,
    pitch: number,
    done: boolean,
    lane: number | null = null,
  ): Voice {
    const v = {
      group,
      volume,
      pitch,
      done,
      lane,
      gain: 1,
      next: this.time + 0.005,
      segments: 0,
      buf: new Float32Array(128),
    };
    v.gain = this.gain(v);
    this.voices.add(v);
    return v;
  }
  private add(v: Voice, pcm: Float32Array[], at: number, fade = false): void {
    v.segments++;
    this.segments.push(new Segment(pcm, at, v.pitch, fade, v, this.sampleRate));
  }
  handle({ epoch, command: c }: SinkEnvelope, contextTime: number): void {
    this.time = contextTime;
    if (epoch < this.epoch) return;
    if (epoch > this.epoch) {
      this.reset();
      this.epoch = epoch;
    }
    switch (c.kind) {
      case "load":
        this.takes.set(`${c.take.bankset}/${c.take.keyId}`, c.take);
        break;
      case "play": {
        const take = this.takes.get(c.key);
        if (!take) throw new Error("audio-take-missing");
        const v = this.voice(c.cue.group, c.cue.volume, c.cue.pitch, true);
        if (this.gain(v) <= 0) {
          this.voices.delete(v);
          break;
        }
        this.add(v, take.pcm, this.time);
        this.stage?.({
          type: "cached-start",
          contextTime: this.time,
          handledMs: c.handledMs,
          t: c.cue.t,
          s: c.cue.s,
        });
        break;
      }
      case "take-start":
        this.streams.set(
          c.stream,
          c.cues.map((q) => this.voice(q.group, q.volume, q.pitch, false)),
        );
        break;
      case "take-abort":
        for (const v of this.streams.get(c.stream) ?? []) {
          v.done = true;
          if (v.segments === 0) this.voices.delete(v);
        }
        this.streams.delete(c.stream);
        break;
      case "take-block": {
        const h = c.block.header,
          list = this.streams.get(h.stream);
        if (!list) throw new Error("audio-take-missing");
        for (const v of list) {
          const at = Math.max(this.time + 0.005, v.next);
          this.add(v, c.pcm, at, v.next < this.time + 0.001);
          v.next = at + h.frames / (48000 * v.pitch);
          if (h.flags & 2) v.done = true;
          this.stage?.({
            type: "take-source-start",
            stream: h.stream,
            block: h.block,
            contextTime: at,
          });
        }
        if (h.flags & 2) this.streams.delete(h.stream);
        break;
      }
      case "lane-block": {
        const h = c.block.header;
        let state = this.lanes.get(c.lane.id);
        if (!state) {
          state = {
            voice: this.voice(c.lane.group, 1, 1, false, c.lane.id),
            jitter: new LaneJitterBuffer(),
          };
          this.lanes.set(c.lane.id, state);
        }
        const decision = state.jitter.accept(
          h.stream,
          h.block,
          c.due,
          this.time,
          !!(h.flags & 8),
        );
        if (!decision) {
          this.stage?.({
            type: "lane-drop",
            lane: c.lane.id,
            stream: h.stream,
            block: h.block,
          });
          break;
        }
        if (decision.newEpoch) this.removeSegments(state.voice);
        this.add(state.voice, blockPcm(c.block), decision.at, decision.fade);
        this.stage?.({
          type: "lane-start",
          lane: c.lane.id,
          stream: h.stream,
          block: h.block,
          contextTime: decision.at,
        });
        break;
      }
      case "lane-stop": {
        const state = this.lanes.get(c.lane);
        if (state) {
          this.removeSegments(state.voice);
          this.voices.delete(state.voice);
        }
        this.lanes.delete(c.lane);
        break;
      }
      case "groups":
        this.groups = c.snapshot
          ? { ...c.gains }
          : { ...this.groups, ...c.gains };
        break;
      case "gate": {
        let keys = this.gates.get(c.cue.group);
        if (!keys) {
          keys = new Set();
          this.gates.set(c.cue.group, keys);
        }
        if (c.cue.kind === "loop-start") keys.add(c.cue.key_id);
        else if (c.cue.kind === "loop-stop") keys.delete(c.cue.key_id);
        else keys.clear();
        break;
      }
      case "sample-active":
        this.setSampleActive(c.count);
        break;
      case "reset":
        this.reset();
        break;
    }
  }
  private removeSegments(v: Voice): void {
    this.segments = this.segments.filter((s) => s.voice !== v);
    v.segments = 0;
  }
  private reset(): void {
    this.segments.length = 0;
    this.voices.clear();
    this.streams.clear();
    this.lanes.clear();
    this.groups = {};
    this.gates.clear();
    // The caller's take store survives reconnect, as does the sink's decoded cache.
  }
  /** Mix in the upstream 128-frame quanta. No render-path allocation. */
  render(
    left: Float32Array,
    right: Float32Array,
    contextTime: number,
    input?: Float32Array[],
  ): void {
    for (let off = 0; off < left.length; off += 128) {
      const n = Math.min(128, left.length - off),
        q0 = Math.round(contextTime * this.sampleRate) + off;
      const keepAlive = this.sampleActive === 0 && this.segments.length === 0;
      for (let j = 0; j < n; j++) {
        left[off + j] = (input?.[0]?.[off + j] ?? 0) + (keepAlive ? 1e-5 : 0);
        right[off + j] =
          (input?.[1]?.[off + j] ?? input?.[0]?.[off + j] ?? 0) +
          (keepAlive ? 1e-5 : 0);
      }
      const alpha = 1 - Math.exp(-1 / (0.015 * this.sampleRate));
      for (const v of this.voices) {
        const target = this.gain(v);
        for (let j = 0; j < n; j++) {
          v.gain += (target - v.gain) * alpha;
          v.buf[j] = v.gain;
        }
      }
      for (let slot = this.segments.length - 1; slot >= 0; slot--) {
        const seg = this.segments[slot];
        if (this.mixSegment(seg, seg.voice.buf, left, right, off, n, q0)) {
          seg.voice.segments--;
          this.segments[slot] = this.segments[this.segments.length - 1];
          this.segments.pop();
          if (seg.voice.done && seg.voice.segments === 0)
            this.voices.delete(seg.voice);
        }
      }
    }
    this.time = contextTime + left.length / this.sampleRate;
  }
  // Port of mixerCore.ts mixSegment's f32-planar branch, including its late-start rule.
  private mixSegment(
    seg: Segment,
    gainBuf: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
    off: number,
    n: number,
    q0: number,
  ): boolean {
    let j = 0;
    if (!seg.started) {
      const first = Math.ceil(seg.startFrame - 1e-6);
      if (first >= q0 + n) return false;
      if (first < q0) {
        j = 0;
        seg.t0 = q0;
        seg.pos = 0;
      } else {
        j = first - q0;
        seg.t0 = seg.startFrame;
        seg.pos = (first - seg.startFrame) * seg.step;
      }
      seg.started = true;
    }
    const frames = seg.pcm[0].length,
      step = seg.step,
      t0 = seg.t0,
      rampFrames = seg.rampFrames;
    let pos = seg.pos;
    const left = seg.pcm[0],
      right = seg.pcm[1] ?? left;
    for (; j < n; j++) {
      const i = Math.floor(pos);
      if (i >= frames) break;
      const frac = pos - i;
      const i1 = i + 1 < frames ? i + 1 : i;
      const l0 = left[i],
        r0 = right[i];
      let g = gainBuf[j];
      if (rampFrames > 0) {
        const x = (q0 + j - t0) / rampFrames;
        if (x < 1) g *= x > 0 ? x : 0;
      }
      outL[off + j] += (l0 + (left[i1] - l0) * frac) * g;
      outR[off + j] += (r0 + (right[i1] - r0) * frac) * g;
      pos += step;
    }
    seg.pos = pos;
    return pos >= frames;
  }
}
