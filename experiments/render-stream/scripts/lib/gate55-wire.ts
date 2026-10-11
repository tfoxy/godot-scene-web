// render-stream/5 recordings as gate 5.5's checks read them (protocol/gate5_5-design.md Q4,
// render-stream-5.md): every transaction's wire form (a patch's partial lists, with
// `shaders`/`materials`/`removed_*` and the `param_f64` block size) beside its resolved state
// (the shader and material tables, items with `material`/`use_parent_material`/`instance_params`,
// canvases with `modulate`). Always decoded at version 5 explicitly, whatever render-stream-2.ts's
// default is: gate 0's RecordingSummary carries neither table.
//
// Pure over bytes apart from loadWire5's one read; nothing launches a process.

import { readFile } from "node:fs/promises";

import {
  decodeRecording,
  type ResolvedTransaction,
  resolveRecording,
  type SessionMeta,
  type TransactionMeta,
} from "./render-stream-2";

/** One transaction: its wire meta and its resolved state (resolveRecording's `state`). */
export interface Wire5Tx {
  seq: number;
  frame: number;
  encoding: "full" | "patch";
  wire: TransactionMeta;
  /** the record's byte length, length prefix included */
  bytes: number;
  /** values in the transaction's param_f64 block (8 bytes each) */
  param_f64: number;
  state: ResolvedTransaction["state"];
}

/** One resource record and the seq of the first transaction after it (null: none follows). */
export interface Wire5Resource {
  hash: string;
  bytes: number;
  before_seq: number | null;
}

export interface Wire5 {
  path: string;
  present: boolean;
  /** the first decode/resolve error (the transactions then stop short or are empty) */
  error: string | null;
  session?: SessionMeta;
  transactions: Wire5Tx[];
  resources: Wire5Resource[];
}

/** Decodes and resolves one /5 recording's bytes (undefined = the file is missing). */
export function wire5FromBytes(
  path: string,
  data: Uint8Array | undefined,
): Wire5 {
  const out: Wire5 = {
    path,
    present: data !== undefined,
    error: null,
    transactions: [],
    resources: [],
  };
  if (!data) {
    out.error = "missing: no recording file";
    return out;
  }
  try {
    const decoded = decodeRecording(data, 5);
    const resolved = resolveRecording(data, 5);
    let k = 0;
    const pending: Wire5Resource[] = [];
    for (const record of decoded.records) {
      const meta = record.meta;
      if (meta.type === "session") out.session = meta;
      else if (meta.type === "resource") {
        const r = { hash: meta.hash, bytes: meta.bytes, before_seq: null };
        pending.push(r);
        out.resources.push(r);
      } else if (meta.type === "transaction") {
        for (const r of pending) r.before_seq = meta.seq;
        pending.length = 0;
        const block = meta.blocks.find((b) => b.name === "param_f64");
        out.transactions.push({
          seq: meta.seq,
          frame: meta.frame,
          encoding: meta.encoding,
          wire: meta,
          bytes: record.byte_length,
          param_f64: block?.count ?? 0,
          state: resolved.transactions[k].state,
        });
        k++;
      }
    }
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
  }
  return out;
}

export async function loadWire5(path: string): Promise<Wire5> {
  let data: Uint8Array | undefined;
  try {
    data = new Uint8Array(await readFile(path));
  } catch {
    data = undefined;
  }
  return wire5FromBytes(path, data);
}

/** The transaction published at `frame`, if any. */
export function txAt<T extends { frame: number }>(
  transactions: readonly T[],
  frame: number,
): T | undefined {
  return transactions.find((t) => t.frame === frame);
}

/** Item name -> wire id: the ids seen over the run, ascending, paired with the fixture's creation
 * order (every gate 5.5 item is made in `_ready`, so creation order is id order). */
export function itemIdsByCreation(
  transactions: readonly { state: { items: readonly { id: number }[] } }[],
  creationOrder: readonly string[],
): {
  ids: Map<string, number>;
  names: Map<number, string>;
  problems: string[];
} {
  const seen = new Set<number>();
  for (const t of transactions) for (const i of t.state.items) seen.add(i.id);
  const sorted = [...seen].sort((a, b) => a - b);
  const problems: string[] = [];
  if (sorted.length !== creationOrder.length)
    problems.push(
      `${sorted.length} item ids on the wire, expected ${creationOrder.length} (${creationOrder.join(",")})`,
    );
  const ids = new Map<string, number>();
  const names = new Map<number, string>();
  creationOrder.forEach((n, k) => {
    if (k < sorted.length) {
      ids.set(n, sorted[k]);
      names.set(sorted[k], n);
    }
  });
  return { ids, names, problems };
}

/** The distinct ids a table takes over the run, ascending. */
export function tableIdsOverRun(
  transactions: readonly Wire5Tx[],
  table: "shaders" | "materials",
): number[] {
  const seen = new Set<number>();
  for (const t of transactions)
    for (const e of t.state[table] ?? []) seen.add(e.id);
  return [...seen].sort((a, b) => a - b);
}
