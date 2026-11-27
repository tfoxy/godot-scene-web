import { LANE_LEAD_MAX_S } from "./mainEngine";
import type { SinkCommand, SinkEnvelope } from "./sinkProtocol";
import { blockPcm, type Take } from "./takeStore";
import type { Block } from "./wire";

export const SINK_BATCH_CREDITS = 2;
type PcmBlock = Pick<Block, "header">;
export type MainSinkCommand =
  | Exclude<SinkCommand, { kind: "load" | "lane-block" | "take-block" }>
  | { kind: "load"; key: string }
  | {
      kind: "lane-block";
      block: PcmBlock;
      lane: Extract<SinkCommand, { kind: "lane-block" }>["lane"];
      due: number;
      pcm: Float32Array[];
    }
  | { kind: "take-block"; block: PcmBlock; pcm: Float32Array[] };
export interface MainSinkEnvelope {
  epoch: number;
  command: MainSinkCommand;
}
export interface SinkPost {
  kind: string;
  data?: unknown;
  id?: number;
}
export type SinkItem = MainSinkEnvelope | SinkPost;
export interface SinkBatch {
  kind: "batch";
  postedMs: number;
  items: SinkItem[];
}
const now = () => performance.timeOrigin + performance.now();

/** One ordered stream, with at most two ordinary batches awaiting main's acknowledgement. */
export class SinkBatcher {
  private pending: SinkItem[] = [];
  private outstanding = 0;
  private urgent = false;
  private queued = false;
  constructor(
    private send: (batch: SinkBatch, transfer: Transferable[]) => void,
    private currentTime: () => number,
    private clock = now,
  ) {}
  push(message: SinkEnvelope | SinkPost): void {
    let item: SinkItem;
    if ("command" in message) {
      const c = message.command;
      let command: MainSinkCommand;
      switch (c.kind) {
        case "load":
          command = { kind: "load", key: `${c.take.bankset}/${c.take.keyId}` };
          break;
        case "lane-block":
          command = {
            ...c,
            block: { header: c.block.header },
            pcm: blockPcm(c.block),
          };
          break;
        case "take-block":
          command = {
            ...c,
            block: { header: c.block.header },
            pcm: c.pcm.map((p) => p.slice()),
          };
          break;
        default:
          command = c;
      }
      item = { epoch: message.epoch, command };
    } else if (message.kind === "take") {
      const take = message.data as Take;
      item = {
        ...message,
        data: { ...take, pcm: take.pcm.map((p) => p.slice()) },
      };
    } else item = message;
    this.pending.push(item);
    const kind = "command" in item ? item.command.kind : item.kind;
    if (!["lane-block", "take-block", "stage"].includes(kind))
      this.urgent = true;
    this.queue();
  }
  ack(): void {
    if (this.outstanding) this.outstanding--;
    this.queue();
  }
  private queue(): void {
    if (this.queued || !this.pending.length) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.flush();
    });
  }
  private flush(): void {
    if (
      !this.pending.length ||
      (!this.urgent && this.outstanding >= SINK_BATCH_CREDITS)
    )
      return;
    const items = this.pending.map((item): SinkItem => {
      if ("command" in item && item.command.kind === "lane-block") {
        const c = item.command;
        if (c.due + LANE_LEAD_MAX_S < this.currentTime())
          return {
            kind: "stage",
            data: {
              type: "lane-drop",
              at: "worker",
              lane: c.lane.id,
              stream: c.block.header.stream,
              block: c.block.header.block,
              handledMs: this.clock(),
            },
          };
      }
      return item;
    });
    const transfer: Transferable[] = [];
    for (const item of items) {
      const pcm =
        "command" in item
          ? "pcm" in item.command
            ? item.command.pcm
            : undefined
          : item.kind === "take"
            ? (item.data as Take).pcm
            : undefined;
      for (const plane of pcm ?? []) transfer.push(plane.buffer as ArrayBuffer);
    }
    this.pending = [];
    this.urgent = false;
    this.outstanding++;
    this.send({ kind: "batch", postedMs: this.clock(), items }, transfer);
  }
}
