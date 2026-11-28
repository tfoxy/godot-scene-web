import { LANE_LEAD_MAX_S } from "./mainEngine";
import type { SinkCommand, SinkEnvelope } from "./sinkProtocol";
import type { Take } from "./takeStore";
import type { Block } from "./wire";

export const SINK_BATCH_CREDITS = 2;
export const LANE_COALESCE_MAX_BLOCKS = 24;
export const LANE_COALESCE_DUE_TOLERANCE_S = 0.001;
type PcmBlock = Pick<Block, "header">;
export type MainSinkCommand =
  | Exclude<SinkCommand, { kind: "load" | "lane-block" | "take-block" }>
  | { kind: "load"; key: string }
  | {
      kind: "lane-block";
      block: PcmBlock;
      lane: Extract<SinkCommand, { kind: "lane-block" }>["lane"];
      due: number;
      count?: number;
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
type PendingLane = Extract<SinkCommand, { kind: "lane-block" }>;
type PendingEnvelope = {
  epoch: number;
  command: Exclude<MainSinkCommand, { kind: "lane-block" }> | PendingLane;
};
type PendingItem = PendingEnvelope | SinkPost;
interface LaneSpan {
  head: { epoch: number; command: PendingLane };
  blocks: Block[];
}

/** Decode directly into the final planar span; silent blocks leave their frames zeroed. */
function spanPcm(blocks: Block[]): Float32Array[] {
  const frames = blocks.reduce((n, b) => n + b.header.frames, 0);
  const pcm = [new Float32Array(frames), new Float32Array(frames)];
  let offset = 0;
  for (const block of blocks) {
    if (!(block.header.flags & 4)) {
      const view = new DataView(
        block.payload.buffer,
        block.payload.byteOffset,
        block.payload.byteLength,
      );
      for (let f = 0; f < block.header.frames; f++)
        for (let c = 0; c < 2; c++)
          pcm[c][offset + f] = view.getInt16((f * 2 + c) * 2, true) / 32768;
    }
    offset += block.header.frames;
  }
  return pcm;
}
const now = () => performance.timeOrigin + performance.now();

/** One ordered stream, with at most two ordinary batches awaiting main's acknowledgement. */
export class SinkBatcher {
  private pending: PendingItem[] = [];
  private outstanding = 0;
  private urgent = false;
  private queued = false;
  constructor(
    private send: (batch: SinkBatch, transfer: Transferable[]) => void,
    private currentTime: () => number,
    private clock = now,
  ) {}
  push(message: SinkEnvelope | SinkPost): void {
    let item: PendingItem;
    if ("command" in message) {
      const c = message.command;
      let command: PendingEnvelope["command"];
      switch (c.kind) {
        case "load":
          command = { kind: "load", key: `${c.take.bankset}/${c.take.keyId}` };
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
    } else {
      if (
        message.kind === "stage" &&
        typeof message.data === "object" &&
        message.data !== null &&
        "type" in message.data &&
        message.data.type === "lane-block"
      )
        return;
      item = message;
    }
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
  private preDrop(): PendingItem[] {
    const items: PendingItem[] = [];
    const drops = new Map<
      number,
      {
        epoch: number;
        data: {
          type: string;
          at: "worker";
          lane: number;
          stream: number;
          block: number;
          count: number;
          handledMs: number;
        };
      }
    >();
    for (const item of this.pending) {
      if ("command" in item && item.command.kind === "lane-block") {
        const c = item.command,
          h = c.block.header;
        if (c.due + LANE_LEAD_MAX_S < this.currentTime()) {
          const run = drops.get(c.lane.id);
          if (
            run &&
            run.epoch === item.epoch &&
            run.data.stream === h.stream &&
            run.data.block + run.data.count === h.block
          )
            run.data.count++;
          else {
            const data = {
              type: "lane-drop",
              at: "worker" as const,
              lane: c.lane.id,
              stream: h.stream,
              block: h.block,
              count: 1,
              handledMs: this.clock(),
            };
            drops.set(c.lane.id, { epoch: item.epoch, data });
            items.push({ kind: "stage", data });
          }
          continue;
        }
        drops.delete(c.lane.id);
      } else {
        const kind = "command" in item ? item.command.kind : item.kind;
        if (kind !== "take-block" && kind !== "stage") drops.clear();
      }
      items.push(item);
    }
    return items;
  }
  private coalesce(pending: PendingItem[]): SinkItem[] {
    const items: (SinkItem | LaneSpan)[] = [],
      open = new Map<number, LaneSpan>();
    for (const item of pending) {
      if ("command" in item && item.command.kind === "lane-block") {
        const c = item.command,
          h = c.block.header,
          span = open.get(c.lane.id);
        if (
          span &&
          item.epoch === span.head.epoch &&
          h.stream === span.head.command.block.header.stream &&
          h.block ===
            span.head.command.block.header.block + span.blocks.length &&
          !(h.flags & (8 | 1)) &&
          !(span.blocks[span.blocks.length - 1].header.flags & 2) &&
          Math.abs(
            c.due -
              (span.head.command.due +
                (span.blocks.length * span.head.command.block.header.frames) /
                  48000),
          ) <= LANE_COALESCE_DUE_TOLERANCE_S &&
          span.blocks.length < LANE_COALESCE_MAX_BLOCKS
        ) {
          span.blocks.push(c.block);
        } else {
          const next: LaneSpan = {
            head: { epoch: item.epoch, command: c },
            blocks: [c.block],
          };
          open.set(c.lane.id, next);
          items.push(next);
        }
      } else {
        const kind = "command" in item ? item.command.kind : item.kind;
        if (kind !== "take-block" && kind !== "stage") open.clear();
        items.push(item as SinkItem);
      }
    }
    return items.map((item): SinkItem => {
      if (!("blocks" in item)) return item;
      const { epoch, command: c } = item.head;
      return {
        epoch,
        command: {
          kind: "lane-block",
          block: { header: c.block.header },
          lane: c.lane,
          due: c.due,
          pcm: spanPcm(item.blocks),
          count: item.blocks.length,
        },
      };
    });
  }
  private flush(): void {
    if (
      !this.pending.length ||
      (!this.urgent && this.outstanding >= SINK_BATCH_CREDITS)
    )
      return;
    const items = this.coalesce(this.preDrop());
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
