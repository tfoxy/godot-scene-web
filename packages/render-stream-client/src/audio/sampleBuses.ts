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

// Ported from Godot 4.5.1 platform/web/js/libs/library_godot_audio.js (Bus and SampleNodeBus).
import type { AudioContextLike } from "./mainEngine";
import type { AudioBusState, BusCommand } from "./wire";

export interface SampleBus {
  input: GainNode;
  solo: GainNode;
  output: GainNode;
  target: SampleBus | null;
}
export interface SampleRoute {
  input: GainNode;
  splitter: ChannelSplitterNode;
  output: ChannelMergerNode;
  gains: GainNode[];
  bus: SampleBus;
}
// Four Godot stereo pairs -> WebAudio 7.1 (front, center/LFE, side, rear).
const CHANNELS = [0, 1, 2, 3, 6, 7, 4, 5];
export class SampleBuses {
  private buses: SampleBus[] = [];
  private routes = new Set<SampleRoute>();
  private solo: SampleBus | null = null;
  constructor(private context: AudioContextLike) {
    this.snapshot([]);
  }
  private get(index: number): SampleBus {
    const bus = this.buses[index === -1 ? 0 : index];
    if (!bus) throw new Error("audio-protocol");
    return bus;
  }
  resolve(index: number): SampleBus {
    return this.get(index);
  }
  validate(index: number): void {
    this.get(index);
  }
  private make(): SampleBus {
    const input = this.context.createGain(),
      solo = this.context.createGain(),
      output = this.context.createGain();
    input.connect(solo).connect(output);
    output.connect(this.context.destination);
    return { input, solo, output, target: null };
  }
  private send(bus: SampleBus, target: SampleBus | null): void {
    bus.output.disconnect();
    bus.target = target;
    bus.output.connect(target?.input ?? this.context.destination);
  }
  snapshot(states: AudioBusState[]): void {
    this.dispose();
    this.buses = Array.from({ length: Math.max(1, states.length) }, () =>
      this.make(),
    );
    states.forEach((state, i) => {
      if (i === 0 && state.send !== -1) throw new Error("audio-protocol");
      const bus = this.buses[i];
      bus.input.gain.value = 10 ** (state.volume_db / 20);
      bus.output.gain.value = state.mute ? 0 : 1;
      this.send(bus, state.send === -1 ? null : this.get(state.send));
      if (state.solo) this.solo = bus;
    });
    this.syncSolo();
  }
  private syncSolo(): void {
    for (const bus of this.buses)
      bus.solo.gain.value = this.solo === null || this.solo === bus ? 1 : 0;
  }
  command(m: BusCommand): void {
    if (m.bus < 0 && m.op !== "add") throw new Error("audio-protocol");
    switch (m.op) {
      case "count":
        while (this.buses.length > m.value) this.remove(this.buses.length - 1);
        while (this.buses.length < m.value) this.buses.push(this.make());
        break;
      case "add": {
        if (m.bus < -1 || m.bus > this.buses.length)
          throw new Error("audio-protocol");
        // AudioServer preserves Master at index zero.
        const at = m.bus === -1 ? this.buses.length : Math.max(1, m.bus);
        this.buses.splice(at, 0, this.make());
        break;
      }
      case "remove":
        this.remove(m.bus);
        break;
      case "move": {
        this.get(m.bus);
        if (
          m.bus < 1 ||
          (m.value !== -1 && (m.value < 1 || m.value > this.buses.length))
        )
          throw new Error("audio-protocol");
        if (m.bus === m.value) break;
        const bus = this.buses.splice(m.bus, 1)[0];
        this.buses.splice(
          m.value === -1
            ? this.buses.length
            : m.value > m.bus
              ? m.value - 1
              : m.value,
          0,
          bus,
        );
        break;
      }
      case "send": {
        const bus = this.get(m.bus);
        if (m.bus < 0 || (m.bus === 0 && m.value !== -1))
          throw new Error("audio-protocol");
        this.send(bus, m.value === -1 ? null : this.get(m.value));
        break;
      }
      case "volume_db":
        this.get(m.bus).input.gain.value = 10 ** (m.value / 20);
        break;
      case "mute":
        this.get(m.bus).output.gain.value = m.value ? 0 : 1;
        break;
      case "solo": {
        const bus = this.get(m.bus);
        if (m.value) this.solo = bus;
        else if (this.solo === bus) this.solo = null;
        break;
      }
    }
    this.syncSolo();
  }
  private remove(index: number): void {
    const bus = this.get(index);
    if (index < 1) throw new Error("audio-protocol");
    this.buses.splice(index, 1);
    if (this.solo === bus) this.solo = null;
    for (const other of this.buses)
      if (other.target === bus) this.send(other, null);
    for (const route of this.routes)
      if (route.bus === bus) {
        route.output.disconnect();
        route.bus = this.buses[0];
        route.output.connect(route.bus.input);
      }
    bus.input.disconnect();
    bus.solo.disconnect();
    bus.output.disconnect();
  }
  route(index: number): SampleRoute {
    const bus = this.get(index);
    const input = this.context.createGain();
    input.channelCount = 2;
    input.channelCountMode = "explicit";
    const splitter = this.context.createChannelSplitter(8),
      output = this.context.createChannelMerger(8);
    input.connect(splitter);
    const gains = CHANNELS.map((_channel, web) => {
      const gain = this.context.createGain();
      splitter.connect(gain, web);
      gain.connect(output, 0, web);
      return gain;
    });
    output.connect(bus.input);
    const route = { input, splitter, output, gains, bus };
    this.routes.add(route);
    return route;
  }
  volumes(route: SampleRoute, values: number[], at: number): void {
    CHANNELS.forEach((channel, web) => {
      route.gains[web].gain.setValueAtTime(values[channel], at);
    });
  }
  release(route: SampleRoute): void {
    route.input.disconnect();
    route.splitter.disconnect();
    route.output.disconnect();
    for (const gain of route.gains) gain.disconnect();
    this.routes.delete(route);
  }
  dispose(): void {
    for (const route of [...this.routes]) this.release(route);
    for (const bus of this.buses) {
      bus.input.disconnect();
      bus.solo.disconnect();
      bus.output.disconnect();
    }
    this.buses = [];
    this.solo = null;
  }
}
