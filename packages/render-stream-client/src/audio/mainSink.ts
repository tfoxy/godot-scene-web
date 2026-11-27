import type { MainAudioEngine } from "./mainEngine";
import type { MainSinkEnvelope } from "./sinkBatch";
import type { TakeStore } from "./takeStore";

/** The main sink consumes only pre-timed commands; the Worker owns the session clock. */
export class MainSinkReceiver {
  private epoch = 0;
  constructor(
    readonly engine: MainAudioEngine,
    private store: TakeStore,
  ) {}
  private take(key: string) {
    const slash = key.indexOf("/");
    const take = this.store.peek(key.slice(0, slash), key.slice(slash + 1));
    if (!take) throw new Error("audio-take-missing");
    return take;
  }
  handle({ epoch, command: c }: MainSinkEnvelope): void {
    if (epoch < this.epoch) return;
    const newer = epoch > this.epoch;
    if (newer) {
      this.engine.reset();
      this.epoch = epoch;
    }
    switch (c.kind) {
      case "load":
        this.engine.loadTake(this.take(c.key));
        break;
      case "play":
        this.engine.play(this.take(c.key), c.cue);
        break;
      case "take-start":
        this.engine.beginTake(c.stream, c.cues);
        break;
      case "take-abort":
        this.engine.abortTake(c.stream);
        break;
      case "take-block":
        this.engine.takeBlock(
          { ...c.block, payload: new Uint8Array(0) },
          c.pcm,
        );
        break;
      case "lane-block":
        this.engine.laneBlock(
          { ...c.block, payload: new Uint8Array(0) },
          c.lane,
          c.due,
          c.pcm,
        );
        break;
      case "lane-stop":
        this.engine.stopLane(c.lane);
        break;
      case "groups":
        this.engine.setGroups(c.gains, c.snapshot);
        break;
      case "gate":
        this.engine.gate(c.cue);
        break;
      case "sample-active":
        this.engine.setSampleActive(c.count);
        break;
      case "reset":
        if (!newer) this.engine.reset();
        break;
    }
  }
}
