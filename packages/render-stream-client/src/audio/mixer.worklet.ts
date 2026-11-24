// Adapted from sts2-couch-coop mixer.worklet.ts; copyright 2026 Tomás Fox, MIT.
import { MixerCore } from "./mixerCore";
import type { SinkEnvelope } from "./sinkProtocol";

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  ctor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;
class TrackMixer extends AudioWorkletProcessor {
  private core: MixerCore;
  private scratch = new Float32Array(128);
  constructor(options?: AudioWorkletNodeOptions) {
    super();
    this.core = new MixerCore(
      sampleRate,
      options?.processorOptions?.diag
        ? (row) => this.port.postMessage({ kind: "stage", row })
        : undefined,
    );
    this.port.onmessage = (
      event: MessageEvent<{ kind: string; port?: MessagePort; count?: number }>,
    ) => {
      if (event.data.kind === "port" && event.data.port) {
        event.data.port.onmessage = (e: MessageEvent<SinkEnvelope>) =>
          this.core.handle(e.data, currentTime);
        this.port.postMessage({ kind: "ready" });
      } else if (
        event.data.kind === "sample-active" &&
        typeof event.data.count === "number"
      ) {
        this.core.setSampleActive(event.data.count);
      }
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (out?.[0])
      this.core.render(out[0], out[1] ?? this.scratch, currentTime, inputs[0]);
    return true;
  }
}
registerProcessor("gsw-track-mixer", TrackMixer);
