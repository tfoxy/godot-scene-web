// Adapted from sts2-couch-coop takeStore.ts; copyright 2026 Tomás Fox, MIT.
// The product-independent store has no HTTP route, index or settings dependency.
import type { Block } from "./wire";
export interface Take {
  bankset: string;
  keyId: string;
  hash: string;
  pcm: Float32Array[];
  frames: number;
}
interface Assembly {
  bankset: string;
  keyId: string;
  frames: number;
  received: number;
  next: number;
  last: boolean;
  blocks: Float32Array[][];
}
export function blockPcm(block: Block): Float32Array[] {
  const pcm = [
    new Float32Array(block.header.frames),
    new Float32Array(block.header.frames),
  ];
  if (!(block.header.flags & 4)) {
    const v = new DataView(
      block.payload.buffer,
      block.payload.byteOffset,
      block.payload.byteLength,
    );
    for (let f = 0; f < block.header.frames; f++)
      for (let c = 0; c < 2; c++)
        pcm[c][f] = v.getInt16((f * 2 + c) * 2, true) / 32768;
  }
  return pcm;
}
export class TakeStore {
  private banks = new Map<string, Map<string, Take>>();
  private streams = new Map<number, Assembly>();
  peek(bankset: string, keyId: string): Take | undefined {
    return this.banks.get(bankset)?.get(keyId);
  }
  ids(bankset: string): string[] {
    return [...(this.banks.get(bankset)?.keys() ?? [])];
  }
  entries(): Take[] {
    return [...this.banks.values()].flatMap((bank) => [...bank.values()]);
  }
  put(take: Take): void {
    let bank = this.banks.get(take.bankset);
    if (!bank) {
      bank = new Map();
      this.banks.set(take.bankset, bank);
    }
    bank.set(take.keyId, take);
  }
  begin(stream: number, keyId: string, frames: number, bankset: string): void {
    if (this.streams.has(stream)) throw new Error("audio-protocol");
    this.streams.set(stream, {
      bankset,
      keyId,
      frames,
      received: 0,
      next: 0,
      last: false,
      blocks: [],
    });
  }
  append(block: Block): Float32Array[] {
    const a = this.streams.get(block.header.stream),
      h = block.header;
    if (
      !a ||
      a.last ||
      h.block !== a.next ||
      !!(h.flags & 1) !== (a.next === 0) ||
      h.flags & 8 ||
      a.received + h.frames > a.frames
    )
      throw new Error("audio-protocol");
    const pcm = blockPcm(block);
    a.blocks.push(pcm);
    a.received += h.frames;
    a.next++;
    a.last = !!(h.flags & 2);
    if (a.last !== (a.received === a.frames)) throw new Error("audio-protocol");
    return pcm;
  }
  finish(stream: number, keyId: string, hash: string): Take {
    const a = this.streams.get(stream);
    if (!a?.last || a.keyId !== keyId) throw new Error("audio-protocol");
    const pcm = [new Float32Array(a.frames), new Float32Array(a.frames)];
    let offset = 0;
    for (const b of a.blocks) {
      for (let c = 0; c < 2; c++) pcm[c].set(b[c], offset);
      offset += b[0].length;
    }
    const take = { bankset: a.bankset, keyId, hash, pcm, frames: a.frames };
    this.put(take);
    this.streams.delete(stream);
    return take;
  }
  resetStreams(): void {
    this.streams.clear();
  }
  abort(stream: number): void {
    this.streams.delete(stream);
  }
}
