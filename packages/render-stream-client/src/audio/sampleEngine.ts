/**************************************************************************/
/*  library_godot_audio.js                                                */
/**************************************************************************/
/*                         This file is part of:                          */
/*                             GODOT ENGINE                               */
/*                        https://godotengine.org                         */
/**************************************************************************/
/* Copyright (c) 2014-present Godot Engine contributors (see AUTHORS.md). */
/* Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur.                  */
/*                                                                        */
/* Permission is hereby granted, free of charge, to any person obtaining  */
/* a copy of this software and associated documentation files (the        */
/* "Software"), to deal in the Software without restriction, including    */
/* without limitation the rights to use, copy, modify, merge, publish,    */
/* distribute, sublicense, and/or sell copies of the Software, and to     */
/* permit persons to whom the Software is furnished to do so, subject to  */
/* the following conditions:                                              */
/*                                                                        */
/* The above copyright notice and this permission notice shall be         */
/* included in all copies or substantial portions of the Software.        */
/*                                                                        */
/* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,        */
/* EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF     */
/* MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. */
/* IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY   */
/* CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,   */
/* TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE      */
/* SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.                 */
/**************************************************************************/

// Ported from Godot 4.5.1 platform/web/js/libs/library_godot_audio.js (Sample/SampleNode).
// Emscripten glue and the position worklet are replaced by the track's capture-clock timeline.
import type { AudioContextLike, AudioStage } from "./mainEngine";
import { SampleBuses, type SampleRoute } from "./sampleBuses";
import type {
  AudioSample,
  AudioSnapshot,
  AudioStart,
  SampleEvent,
  VoiceCommand,
} from "./wire";

export type FetchAudioAsset = (
  hash: string,
  options: { store: boolean; cache: "default" | "no-store" },
) => Promise<ArrayBuffer>;
interface Sample {
  info: AudioSample;
  refs: number;
  load?: Promise<Decoded>;
}
interface Decoded {
  buffer: AudioBuffer;
  loopStart: number;
  loopEnd: number;
  offset: (seconds: number) => number;
}
interface Instance {
  node: AudioBufferSourceNode;
  stopped: boolean;
}
type Command = VoiceCommand & {
  t: number;
  targets?: { route: SampleRoute; values: number[] }[];
};
interface Voice {
  start: AudioStart;
  t: number;
  initial: number | null;
  paused: boolean;
  pitch: number;
  position: number;
  lastAt: number;
  anchor: number | null;
  sample?: Sample;
  data?: Decoded;
  commands: Command[];
  routes: Map<number, SampleRoute>;
  nodes: Set<Instance>;
  current: Instance | null;
  stopped: boolean;
  loading: boolean;
}
export class GodotSampleEngine {
  private samples = new Map<number, Sample>();
  private voices = new Map<number, Voice>();
  private buses: SampleBuses;
  private active = 0;
  private generation = 0;
  constructor(
    private context: AudioContextLike,
    private codecs: readonly string[],
    private fetchAsset: FetchAudioAsset | undefined,
    private contextTime: (t: number) => number,
    private activity: (count: number) => void,
    private failure: () => void,
    private stage?: (row: Omit<AudioStage, "handledMs">) => void,
  ) {
    this.buses = new SampleBuses(context);
  }
  snapshot(state: AudioSnapshot): void {
    this.buses.snapshot(state.godot?.buses ?? []);
    for (const voice of state.godot?.voices ?? [])
      this.start(voice, state.t, voice.position_s, voice.paused);
  }
  handle(m: SampleEvent): void {
    switch (m.type) {
      case "sample": {
        const prior = this.samples.get(m.id);
        if (prior) {
          prior.info = m;
          if (!m.store) prior.load = undefined;
        } else this.samples.set(m.id, { info: m, refs: 0 });
        for (const v of this.voices.values())
          if (v.start.sample === m.id) this.load(v);
        break;
      }
      case "sample-variant": {
        const sample = this.samples.get(m.id);
        if (!sample) throw new Error("audio-protocol");
        sample.info = {
          ...sample.info,
          variants: [
            ...sample.info.variants,
            { codec: m.codec, hash: m.hash, bytes: m.bytes },
          ],
        };
        for (const v of this.voices.values())
          if (v.start.sample === m.id) this.load(v);
        break;
      }
      case "sample-drop":
        this.samples.delete(m.id);
        break;
      case "start":
        this.start(m, m.t, null, false);
        break;
      case "bus":
        this.buses.command(m);
        break;
      default: {
        const voice = this.voices.get(m.voice);
        if (!voice || voice.stopped) break;
        const command: Command = { ...m };
        if (m.type === "voice-volumes")
          command.targets = m.buses.map((b) => {
            const bus = this.buses.resolve(b.bus);
            let route = [...voice.routes.values()].find((r) => r.bus === bus);
            if (!route) {
              route = this.buses.route(b.bus);
              this.buses.volumes(
                route,
                Array(8).fill(0),
                this.context.currentTime,
              );
              voice.routes.set(voice.routes.size, route);
              for (const n of voice.nodes) n.node.connect(route.input);
            }
            return { route, values: b.v };
          });
        if (voice.anchor === null) voice.commands.push(command);
        else this.command(voice, command);
        break;
      }
    }
  }
  private start(
    start: AudioStart,
    t: number,
    initial: number | null,
    paused: boolean,
  ): void {
    if (this.voices.has(start.voice)) throw new Error("audio-protocol");
    this.buses.validate(start.bus);
    const voice: Voice = {
      start,
      t,
      initial,
      paused,
      pitch: start.pitch,
      position: 0,
      lastAt: 0,
      anchor: null,
      commands: [],
      routes: new Map(),
      nodes: new Set(),
      current: null,
      stopped: false,
      loading: false,
    };
    const route = this.buses.route(start.bus);
    this.buses.volumes(route, start.volumes, this.context.currentTime);
    voice.routes.set(0, route);
    this.voices.set(start.voice, voice);
    this.load(voice);
  }
  private load(v: Voice): void {
    if (v.loading || v.anchor !== null) return;
    const sample = this.samples.get(v.start.sample);
    if (!sample) return; // A snapshot precedes the registrations it references.
    const variant = [...this.codecs, "wav"]
      .map((codec) => sample.info.variants.find((v) => v.codec === codec))
      .find(Boolean);
    if (!variant) return; // A lazily built WAV can arrive in sample-variant.
    if (!this.fetchAsset) throw new Error("audio-protocol");
    const generation = this.generation;
    v.loading = true;
    v.sample = sample;
    sample.refs++;
    if (!sample.load) {
      const info = sample.info;
      sample.load = Promise.resolve()
        .then(() =>
          this.fetchAsset!(variant.hash, {
            store: info.store,
            cache: info.store ? "default" : "no-store",
          }),
        )
        .then((bytes) => this.context.decodeAudioData(bytes))
        .then((buffer) => this.prepare(buffer, info, variant.codec));
    }
    void sample.load
      .then((data) => {
        if (generation !== this.generation || !this.voices.has(v.start.voice))
          return;
        v.data = data;
        v.anchor = v.lastAt = this.context.currentTime;
        const lateness = Math.max(
          0,
          this.context.currentTime - this.contextTime(v.t),
        );
        const looping = sample.info.loop.mode !== "disabled";
        const position = v.initial ?? (looping ? v.start.offset_s : 0);
        v.position = data.offset(
          position + (looping && !v.paused ? lateness * v.pitch : 0),
        );
        if (!v.paused) this.source(v, v.anchor);
        this.stage?.({
          type: "sample-start",
          voice: v.start.voice,
          contextTime: v.anchor,
          t: v.t,
        });
        for (const command of v.commands) this.command(v, command);
        v.commands = [];
      })
      .catch(() => {
        if (generation === this.generation) this.failure();
      });
  }
  private prepare(
    buffer: AudioBuffer,
    info: AudioSample,
    codec: string,
  ): Decoded {
    const mode = info.loop.mode;
    if (mode === "disabled")
      return { buffer, loopStart: 0, loopEnd: 0, offset: (s) => s };
    const rate = buffer.sampleRate;
    // decodeAudioData may resample WAVs to the context's rate; loop frames are at native rate.
    const scale = codec === "wav" ? rate / info.rate : rate;
    const begin = Math.min(
      buffer.length - 1,
      Math.round(info.loop.begin * scale),
    );
    const end =
      info.loop.end === 0
        ? buffer.length
        : Math.min(buffer.length, Math.round(info.loop.end * scale));
    if (end <= begin) throw new Error("audio-protocol");
    if (mode === "forward")
      return {
        buffer,
        loopStart: begin / rate,
        loopEnd: end / rate,
        offset: (s) =>
          s < end / rate
            ? s
            : begin / rate + ((s - begin / rate) % ((end - begin) / rate)),
      };
    // Positive-rate WebAudio nodes play a reversed buffer for backward loops, or a
    // forward/reverse loop cycle for pingpong. All timing remains on one source clock.
    const length = mode === "backward" ? end : end + end - begin;
    const out = this.context.createBuffer(
      buffer.numberOfChannels,
      length,
      rate,
    );
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const src = buffer.getChannelData(c),
        dst = out.getChannelData(c);
      if (mode === "backward")
        for (let f = 0; f < end; f++) dst[f] = src[end - 1 - f];
      else {
        dst.set(src.subarray(0, end));
        for (let f = begin; f < end; f++)
          dst[end + f - begin] = src[end - 1 - (f - begin)];
      }
    }
    const loopStart = mode === "backward" ? 0 : begin / rate;
    const loopEnd = mode === "backward" ? (end - begin) / rate : length / rate;
    return {
      buffer: out,
      loopStart,
      loopEnd,
      offset: (s) =>
        s < loopEnd ? s : loopStart + ((s - loopStart) % (loopEnd - loopStart)),
    };
  }
  private source(v: Voice, at: number): void {
    if (
      !v.data ||
      (v.data.loopEnd === 0 && v.position >= v.data.buffer.duration)
    )
      return;
    const node = this.context.createBufferSource();
    const instance = { node, stopped: false };
    node.buffer = v.data.buffer;
    node.loop = v.data.loopEnd > 0;
    node.loopStart = v.data.loopStart;
    node.loopEnd = v.data.loopEnd;
    node.playbackRate.setValueAtTime(v.pitch, at);
    for (const route of v.routes.values()) {
      route.input.channelCount = Math.max(2, v.data.buffer.numberOfChannels);
      node.connect(route.input);
    }
    v.nodes.add(instance);
    v.current = instance;
    node.onended = () => {
      node.onended = null;
      node.disconnect();
      v.nodes.delete(instance);
      this.activity(--this.active);
      if (v.current === instance) {
        v.current = null;
        if (!instance.stopped) {
          v.data = undefined;
          this.release(v);
        }
      }
      if (v.stopped && v.nodes.size === 0) this.cleanup(v);
    };
    node.start(at, v.position);
    this.activity(++this.active);
  }
  private advance(v: Voice, at: number): void {
    if (!v.paused) v.position += Math.max(0, at - v.lastAt) * v.pitch;
    if (v.data?.loopEnd && v.position >= v.data.loopEnd)
      v.position =
        v.data.loopStart +
        ((v.position - v.data.loopStart) % (v.data.loopEnd - v.data.loopStart));
    v.lastAt = at;
  }
  private halt(v: Voice, at: number): void {
    if (v.current && !v.current.stopped) {
      v.current.stopped = true;
      v.current.node.stop(at);
    }
    v.current = null;
  }
  private command(v: Voice, m: Command): void {
    if (v.stopped || v.anchor === null) return;
    const at = Math.max(this.context.currentTime, v.anchor + (m.t - v.t) / 1e6);
    this.advance(v, at);
    switch (m.type) {
      case "pitch":
        v.pitch = m.pitch;
        v.current?.node.playbackRate.setValueAtTime(m.pitch, at);
        break;
      case "pause":
        if (m.paused === v.paused) break;
        if (m.paused) this.halt(v, at);
        else this.source(v, at);
        v.paused = m.paused;
        break;
      case "voice-volumes": {
        // Keep routes alive until their scheduled zero gain has passed. This also
        // avoids disconnecting sound early when several future commands arrive together.
        for (const route of v.routes.values())
          this.buses.volumes(route, Array(8).fill(0), at);
        for (const target of m.targets ?? [])
          this.buses.volumes(target.route, target.values, at);
        break;
      }
      case "stop":
        v.stopped = true;
        this.halt(v, at);
        this.stage?.({
          type: "sample-stop",
          voice: v.start.voice,
          contextTime: at,
          t: m.t,
        });
        if (v.nodes.size === 0) this.cleanup(v);
        break;
    }
  }
  private release(v: Voice): void {
    if (v.sample) {
      if (--v.sample.refs === 0 && !v.sample.info.store)
        v.sample.load = undefined;
      v.sample = undefined;
    }
  }
  private cleanup(v: Voice): void {
    for (const route of v.routes.values()) this.buses.release(route);
    v.routes.clear();
    v.data = undefined;
    this.release(v);
    this.voices.delete(v.start.voice);
  }
  reset(): void {
    this.generation++;
    for (const v of this.voices.values()) {
      for (const instance of v.nodes) {
        instance.node.onended = null;
        if (!instance.stopped) instance.node.stop();
        instance.node.disconnect();
      }
      this.cleanup(v);
    }
    this.samples.clear();
    this.active = 0;
    this.activity(0);
    this.buses.snapshot([]);
  }
  dispose(): void {
    this.reset();
    this.buses.dispose();
  }
}
