// @vitest-environment node
import { describe, expect, it } from "vitest";
import vectors from "../../../../../experiments/render-stream/protocol/audio-vectors.json";
import {
  type BlockHeader,
  canonicalKey,
  decodeBlock,
  decodeLink,
  decodePrefix,
  encodeBlock,
  encodeLink,
  encodePrefix,
  hex,
  keyId,
  type LinkMessage,
  type MediaPrefix,
  unhex,
} from "../wire";

function single(bits: string): number {
  const b = new ArrayBuffer(4);
  const v = new DataView(b);
  v.setUint32(0, Number.parseInt(bits, 16));
  return v.getFloat32(0);
}
describe("audio golden keys", () => {
  for (const v of vectors.keys)
    it(v.name, () => {
      const run = () =>
        canonicalKey(
          v.path,
          v.params.map((p) => [p.name, single(p.bits)]),
        );
      if (!v.valid) expect(run).toThrow();
      else {
        expect(run()).toBe(v.canonical);
        expect(keyId(run())).toBe(v.key_id);
      }
    });
});
describe("audio golden blocks", () => {
  for (const v of vectors.blocks)
    it(v.name, () => {
      const bytes = unhex(v.hex);
      const context = {
        lanes: v.lanes,
        lane_block_frames: v.lane_block_frames,
      };
      if (!v.valid || !v.header || v.payload === undefined) {
        expect(() => decodeBlock(bytes, context)).toThrow();
        return;
      }
      const header: BlockHeader = {
        ...v.header,
        made_us: BigInt(v.header.made_us),
        due_us: BigInt(v.header.due_us),
        sent_us: BigInt(v.header.sent_us),
      };
      const decoded = decodeBlock(bytes, context);
      expect(decoded.header).toEqual(header);
      expect(hex(decoded.payload)).toBe(v.payload);
      expect(hex(encodeBlock(header, unhex(v.payload), context))).toBe(v.hex);
      // Decode correctly even from an unaligned slice of a larger carrier buffer.
      const padded = new Uint8Array(bytes.length + 3);
      padded.set(bytes, 1);
      expect(
        decodeBlock(padded.subarray(1, bytes.length + 1), context),
      ).toEqual(decoded);
    });
});
describe("audio golden link messages", () => {
  for (const v of vectors.links)
    it(v.name, () => {
      if (!v.valid || !("message" in v)) {
        expect(() => decodeLink(unhex(v.hex))).toThrow();
        return;
      }
      const message = { ...v.message } as unknown as LinkMessage;
      if (message.type === 5) message.t_us = BigInt(message.t_us);
      expect(decodeLink(unhex(v.hex))).toEqual(message);
      expect(hex(encodeLink(message))).toBe(v.hex);
    });
});
describe("audio golden WT stream prefixes", () => {
  for (const v of vectors.prefixes)
    it(v.name, () => {
      if (!v.valid) {
        expect(() => decodePrefix(unhex(v.hex))).toThrow();
        return;
      }
      const prefix = (
        v.kind === 2 ? { kind: 2, key_id: v.key_id } : { kind: 3, lane: v.lane }
      ) as MediaPrefix;
      expect(decodePrefix(unhex(v.hex))).toEqual(prefix);
      expect(hex(encodePrefix(prefix))).toBe(v.hex);
    });
});
