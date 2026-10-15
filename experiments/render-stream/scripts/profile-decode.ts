// Receiver decode profile (2026-10-14), TypeScript side: the same recording through
// lib/render-stream-2.ts, the decoder the GSW browser receiver loads (G7j). It mirrors
// receiver/tests/decode_profile.gd's stages so the two can be compared per transaction:
//
//   decodeRecord  = record sha256 + meta ASCII + JSON.parse + schema + canonical re-stringify
//                   + block conversion (schema is the residual: decodeRecord minus the rest)
//   decode_validate_resolve = createRecordingValidator(...).accept(i) per transaction (G7d's
//                   incremental validator, what GSW's bench page times): decodeRecord, patch rules,
//                   applyTransaction, checkResolvedInvariants, id and resource rules
//   stream checks = accept() minus decodeRecord (both means)
//   applyTransaction alone (the resolver's lift + Map copies), measured separately
//
// The ASCII and block steps are replicas of decodeRecord's private loops (bytesToAscii and the
// DataView reads); everything else calls the exported functions. Two hash variants: "pure" is
// scripts/lib/sha256.ts (what a browser gets), "node" injects node:crypto. G7d's
// scripts/gate7-bench.ts is the per-phase bench of record (and runs on the phones); this adds the
// split inside decodeRecord and the Node-side comparison with the GDScript and Rust profiles.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/profile-decode.ts <recording> [--repeats 5] [--out x.json]

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  applyTransaction,
  createRecordingValidator,
  decodeRecord,
  emptyResolvedState,
  type RawRecord,
  type ResolvedState,
  setHashImpl,
  splitRecords,
  type TransactionMeta,
} from "./lib/render-stream-2";
import { sha256Hex } from "./lib/sha256";

const nodeSha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function summary(perTx: number[][]): {
  mean_us: number;
  p50_us: number;
  p95_us: number;
} {
  const medians = perTx.map(median);
  const mean = medians.reduce((a, b) => a + b, 0) / Math.max(1, medians.length);
  const sorted = [...medians].sort((a, b) => a - b);
  const p95 =
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  return { mean_us: mean, p50_us: median(medians), p95_us: p95 };
}

// Replica of render-stream-2.ts's private bytesToAscii (per-byte string append).
function bytesToAscii(bytes: Uint8Array): string | null {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x20 || b > 0x7e) return null;
    out += String.fromCharCode(b);
  }
  return out;
}

interface Stages {
  record_sha256: number;
  meta_ascii: number;
  json_parse: number;
  canonical_stringify: number;
  blocks: number;
  decode_record: number;
  apply_transaction: number;
}

function stageOne(
  raw: RawRecord,
  state: ResolvedState,
): { t: Stages; next: ResolvedState } {
  const view = new DataView(
    raw.bytes.buffer,
    raw.bytes.byteOffset,
    raw.bytes.byteLength,
  );
  let t0 = performance.now();
  const digest = hashOf(raw.bytes);
  const record_sha256 = (performance.now() - t0) * 1000;

  const metaLen = view.getUint32(4, true);
  t0 = performance.now();
  const metaText = bytesToAscii(raw.bytes.subarray(8, 8 + metaLen));
  const meta_ascii = (performance.now() - t0) * 1000;
  if (metaText === null || digest.length !== 64) throw new Error("bad meta");

  t0 = performance.now();
  const meta = JSON.parse(metaText) as {
    blocks: { type: string; count: number }[];
  };
  const json_parse = (performance.now() - t0) * 1000;

  t0 = performance.now();
  const canonical = JSON.stringify(meta) === metaText;
  const canonical_stringify = (performance.now() - t0) * 1000;
  if (!canonical) throw new Error("non-canonical meta");

  t0 = performance.now();
  let pos = 8 + metaLen + 4;
  const blocks: number[][] = [];
  for (const d of meta.blocks) {
    const len = view.getUint32(pos, true);
    pos += 4;
    const out: number[] = [];
    if (d.type === "f32")
      for (let f = 0; f < d.count; f++)
        out.push(view.getFloat32(pos + f * 4, true));
    else if (d.type === "i32")
      for (let f = 0; f < d.count; f++)
        out.push(view.getInt32(pos + f * 4, true));
    else if (d.type === "f64")
      for (let f = 0; f < d.count; f++)
        out.push(view.getFloat64(pos + f * 8, true));
    blocks.push(out);
    pos += len;
  }
  const blocks_us = (performance.now() - t0) * 1000;

  t0 = performance.now();
  const decoded = decodeRecord(raw, 6);
  const decode_record = (performance.now() - t0) * 1000;
  if (decoded.record === undefined) throw new Error(decoded.errors[0]);

  t0 = performance.now();
  const next = applyTransaction(
    state,
    decoded.record.meta as TransactionMeta,
    decoded.record.blocks as number[][],
  );
  const apply_transaction = (performance.now() - t0) * 1000;
  return {
    t: {
      record_sha256,
      meta_ascii,
      json_parse,
      canonical_stringify,
      blocks: blocks_us,
      decode_record,
      apply_transaction,
    },
    next,
  };
}

let hashOf: (bytes: Uint8Array) => string = sha256Hex;

function profile(data: Uint8Array, repeats: number, hash: "pure" | "node") {
  hashOf = hash === "pure" ? sha256Hex : nodeSha256;
  setHashImpl(hashOf);
  const split = splitRecords(data, 6);
  const txs = split.records.filter((r) => {
    const d = decodeRecord(r, 6);
    return d.record?.meta.type === "transaction";
  });
  const keys: (keyof Stages)[] = [
    "record_sha256",
    "meta_ascii",
    "json_parse",
    "canonical_stringify",
    "blocks",
    "decode_record",
    "apply_transaction",
  ];
  const samples: Record<string, number[][]> = {};
  for (const k of keys) samples[k] = txs.map(() => []);
  const txOfRecord = new Map(txs.map((r, i) => [r.offset, i]));
  const accepted: number[][] = txs.map(() => []);
  for (let r = 0; r <= repeats; r++) {
    let state = emptyResolvedState();
    for (let i = 0; i < txs.length; i++) {
      const { t, next } = stageOne(txs[i], state);
      state = next;
      if (r > 0) for (const k of keys) samples[k][i].push(t[k]);
    }
    const validator = createRecordingValidator(split.records, 6);
    if (validator.errors) throw new Error(validator.errors[0]);
    for (let i = 1; i < split.records.length; i++) {
      const t0 = performance.now();
      const errors = validator.accept(i);
      const us = (performance.now() - t0) * 1000;
      if (errors) throw new Error(errors[0]);
      const tx = txOfRecord.get(split.records[i].offset);
      if (r > 0 && tx !== undefined) accepted[tx].push(us);
    }
  }
  const out: Record<string, unknown> = { hash, transactions: txs.length };
  for (const k of keys) out[k] = summary(samples[k]);
  out.decode_validate_resolve = summary(accepted);
  const s = (k: string) => (out[k] as { mean_us: number }).mean_us;
  out.stream_checks_per_tx_us =
    s("decode_validate_resolve") - s("decode_record");
  out.schema_residual_us =
    s("decode_record") -
    (s("record_sha256") +
      s("meta_ascii") +
      s("json_parse") +
      s("canonical_stringify") +
      s("blocks"));
  return out;
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const path = args[0];
  if (!path) {
    console.error(
      "usage: profile-decode.ts <recording> [--repeats N] [--out file.json]",
    );
    process.exit(2);
  }
  const repeatsAt = args.indexOf("--repeats");
  const repeats = repeatsAt >= 0 ? Number(args[repeatsAt + 1]) : 5;
  const outAt = args.indexOf("--out");
  const data = new Uint8Array(readFileSync(path));
  const result = {
    schema: "receiver-decode-profile-ts/1",
    recording: path,
    bytes: data.length,
    node: process.version,
    repeats,
    variants: [profile(data, repeats, "node"), profile(data, repeats, "pure")],
  };
  for (const v of result.variants) {
    const line = Object.entries(v)
      .map(([k, x]) =>
        typeof x === "object" && x !== null
          ? `${k}=${(x as { mean_us: number }).mean_us.toFixed(1)}/p95 ${(x as { p95_us: number }).p95_us.toFixed(1)}`
          : typeof x === "number"
            ? `${k}=${Number.isInteger(x) ? x : x.toFixed(1)}`
            : `${k}=${x}`,
      )
      .join(" ");
    console.log(`[profile-decode] ${line}`);
  }
  if (outAt >= 0)
    writeFileSync(args[outAt + 1], `${JSON.stringify(result, null, 2)}\n`);
}

main();
