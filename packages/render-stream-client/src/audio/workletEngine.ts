// Adapted from sts2-couch-coop audioTransportCore.ts sink output; copyright 2026 Tomás Fox, MIT.
import type { AudioSessionRuntime } from "./session";
import type { SinkCommand, SinkEnvelope } from "./sinkProtocol";
import type { Take } from "./takeStore";

type SessionEngine = AudioSessionRuntime["engine"];
export class WorkletAudioEngine implements SessionEngine {
  private epoch = 0;
  constructor(private port: Pick<MessagePort, "postMessage">) {}
  private post(command: SinkCommand): void {
    const message: SinkEnvelope = { epoch: this.epoch, command };
    // The take store retains its PCM. Structured clone deliberately preserves ownership.
    this.port.postMessage(message);
  }
  loadTake(take: Take): void {
    this.post({ kind: "load", take });
  }
  play(
    take: Take,
    cue: Parameters<AudioSessionRuntime["engine"]["play"]>[1],
  ): void {
    this.post({
      kind: "play",
      key: `${take.bankset}/${take.keyId}`,
      cue,
      handledMs: performance.timeOrigin + performance.now(),
    });
  }
  beginTake(
    stream: number,
    cues: Parameters<AudioSessionRuntime["engine"]["beginTake"]>[1],
  ): void {
    this.post({ kind: "take-start", stream, cues });
  }
  takeBlock(
    block: Parameters<AudioSessionRuntime["engine"]["takeBlock"]>[0],
    pcm: Float32Array[],
  ): void {
    this.post({ kind: "take-block", block, pcm });
  }
  abortTake(stream: number): void {
    this.post({ kind: "take-abort", stream });
  }
  laneBlock(
    block: Parameters<AudioSessionRuntime["engine"]["laneBlock"]>[0],
    lane: Parameters<AudioSessionRuntime["engine"]["laneBlock"]>[1],
    due: number,
  ): void {
    this.post({ kind: "lane-block", block, lane, due });
  }
  setGroups(gains: Record<string, number>, snapshot: boolean): void {
    this.post({ kind: "groups", gains, snapshot });
  }
  gate(cue: Parameters<AudioSessionRuntime["engine"]["gate"]>[0]): void {
    this.post({ kind: "gate", cue });
  }
  stopLane(lane: number): void {
    this.post({ kind: "lane-stop", lane });
  }
  setSampleActive(count: number): void {
    this.post({ kind: "sample-active", count });
  }
  reset(): void {
    ++this.epoch;
    this.post({ kind: "reset" });
  }
  dispose(): void {
    this.reset();
  }
}
