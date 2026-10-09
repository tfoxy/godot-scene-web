#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Small helpers the gate runners (run-gate0.sh, run-gate1.sh, through lib/legs.sh) need between
// legs, built on the same decoder the checker uses so the runner never parses render-stream/1 a
// second way.
//
//   gate0-tool.ts settle-seqs <steps.jsonl> <recording.rs1>
//       Prints the CSV of transaction seqs at each step's settle frame (RS_RECEIVER_SHOT_SEQS).
//       Exits 1 with the reason on stderr when the join fails (the leg is then capture-failure,
//       step-join-failed).
//   gate0-tool.ts corrupt <in.rs1> <out.rs1> [seq=3]
//       Writes a copy whose transaction <seq> has its first meta byte set to 0x00.
//   gate0-tool.ts seq-at-frame <recording.rs1> <frame>
//       Prints the seq of the transaction published at <frame>; exits 1 when there is none.

import { readFile, writeFile } from "node:fs/promises";

import {
  CORRUPT_SEQ,
  corruptTransactionMeta,
  joinSettleSeqs,
  parseStepLog,
  summarizeRecording,
} from "./lib/gate0-checks";

async function readBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "settle-seqs" && args.length === 2) {
    let stepsText: string | undefined;
    try {
      stepsText = await readFile(args[0], "utf8");
    } catch {
      stepsText = undefined;
    }
    const recording = summarizeRecording(args[1], await readBytes(args[1]));
    const join = joinSettleSeqs(
      parseStepLog(stepsText),
      recording.transactions,
    );
    if (!join.ok) {
      console.error(
        `gate0-tool: step-join-failed: ${join.problems.join("; ")}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(join.entries.map((e) => e.seq).join(","));
    return;
  }
  if (command === "corrupt" && (args.length === 2 || args.length === 3)) {
    const data = await readBytes(args[0]);
    if (!data) throw new Error(`gate0-tool: cannot read ${args[0]}`);
    const seq = args[2] === undefined ? CORRUPT_SEQ : Number(args[2]);
    await writeFile(args[1], corruptTransactionMeta(data, seq));
    return;
  }
  if (command === "seq-at-frame" && args.length === 2) {
    const recording = summarizeRecording(args[0], await readBytes(args[0]));
    const frame = Number(args[1]);
    const t = recording.transactions.find((x) => x.meta.frame === frame);
    if (!t) {
      console.error(
        `gate0-tool: no transaction at frame ${args[1]} in ${args[0]}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(String(t.meta.seq));
    return;
  }
  console.error(
    "usage: gate0-tool.ts settle-seqs <steps.jsonl> <recording.rs1> | corrupt <in> <out> [seq] | seq-at-frame <recording.rs1> <frame>",
  );
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
