#!/usr/bin/env -S pnpm exec tsx --conditions=development
// G7o1 self-test (protocol/gate7-design.md "G7o1", D31): the per-record whole-record SHA-256 is
// evidence only, and browser receivers may compute it off the frame path. Two checks named there:
//
//   record-digest-equal:    createRecordingValidator's digest(i) in "deferred" mode equals the
//                            same record's digest in "inline" mode, for every accepted record of
//                            each input.
//   record-digest-complete: checkRecordDigestComplete() catches a receiver that accepted a record
//                            but never called digest() for it (the `digest-skip` sabotage), and
//                            clears once digest() is called.
//
// Usage (the four G7x bench recordings, gate7-design.md "G7x" Inputs table -- real captures, not
// committed; copy them locally and verify their sha256 first, per that table, as G7o1's own run
// did under this worktree's artifacts/render-stream/gate7/g7o1-inputs/):
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-record-digest.ts --inputs <inputs.json>
//
// <inputs.json> is render-stream-gate7-bench-inputs/1 (gate7-bench.ts's loadInputs() schema).
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  checkRecordDigestComplete,
  createRecordingValidator,
  MAGIC,
  MAGIC_V3,
  MAGIC_V4,
  MAGIC_V5,
  MAGIC_V6,
  type RawRecord,
  splitRecords,
} from "../lib/render-stream-2";

type Version = 2 | 3 | 4 | 5 | 6;

interface BenchInput {
  name: string;
  recording: string;
}

interface BenchInputsFile {
  schema?: string;
  inputs?: BenchInput[];
}

let failures = 0;

function ok(condition: boolean, what: string): void {
  if (condition) {
    console.log(`[SELF-TEST OK] ${what}`);
  } else {
    failures++;
    console.error(`[SELF-TEST FAIL] ${what}`);
  }
}

function versionOf(data: Uint8Array): Version {
  const same = (m: Uint8Array) => m.every((b, i) => data[i] === b);
  if (same(MAGIC_V6)) return 6;
  if (same(MAGIC_V5)) return 5;
  if (same(MAGIC_V4)) return 4;
  if (same(MAGIC_V3)) return 3;
  if (same(MAGIC)) return 2;
  throw new Error("bad-magic: not a render-stream/2..6 recording");
}

async function checkInput(name: string, path: string): Promise<void> {
  const buf = await readFile(path);
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = versionOf(data);
  const split = splitRecords(data, version);
  ok(split.errors.length === 0, `${name}: splitRecords() has no errors`);
  const records: RawRecord[] = split.records;

  const inlineValidator = createRecordingValidator(records, version, {
    recordDigest: "inline",
  });
  const deferredValidator = createRecordingValidator(records, version, {
    recordDigest: "deferred",
  });
  ok(
    inlineValidator.errors === null && deferredValidator.errors === null,
    `${name}: both validators accept the session record`,
  );

  let sabotageIndex = -1;
  for (let i = 1; i < records.length; i++) {
    const inlineErrors = inlineValidator.accept(i);
    const deferredErrors = deferredValidator.accept(i);
    if (i === 1) {
      ok(
        inlineErrors === undefined && deferredErrors === undefined,
        `${name}: record 1 is accepted by both validators (inline: ${JSON.stringify(inlineErrors)}, deferred: ${JSON.stringify(deferredErrors)})`,
      );
    } else if (inlineErrors || deferredErrors) {
      ok(
        false,
        `${name}: record ${i} is accepted by both validators (inline: ${JSON.stringify(inlineErrors)}, deferred: ${JSON.stringify(deferredErrors)})`,
      );
      return;
    }
    if (deferredValidator.digestPending().includes(i)) {
      // Pick one mid-stream accepted transaction as the digest-skip sabotage target, once.
      if (sabotageIndex === -1 && i > 1 && i < records.length - 1)
        sabotageIndex = i;
    }
  }
  ok(
    sabotageIndex !== -1,
    `${name}: found a record to use as the digest-skip sabotage target`,
  );

  // record-digest-complete, clean: the inline validator never defers, so it is complete already.
  ok(
    checkRecordDigestComplete(inlineValidator).length === 0,
    `${name}: checkRecordDigestComplete(inline) is [] (nothing is ever deferred)`,
  );

  // record-digest-complete, sabotage: digest() was never called on the deferred validator, so
  // every accepted record (indices 1..records.length-1, bar the end record which has no
  // transaction-shaped digest requirement either -- it is still an accepted record) is pending.
  const pendingBeforeDigest = deferredValidator.digestPending();
  ok(
    pendingBeforeDigest.length === records.length - 1,
    `${name}: digest-skip sabotage: digestPending() lists all ${records.length - 1} accepted records before any digest() call (got ${pendingBeforeDigest.length})`,
  );
  const incomplete = checkRecordDigestComplete(deferredValidator);
  ok(
    incomplete.length === 1 &&
      incomplete[0].startsWith("record-digest-complete: "),
    `${name}: digest-skip sabotage: checkRecordDigestComplete(deferred) fails record-digest-complete before any digest() call (got ${JSON.stringify(incomplete)})`,
  );

  // record-digest-equal: every accepted record's deferred digest equals its inline digest.
  let allEqual = true;
  for (let i = 1; i < records.length; i++) {
    const inlineDigest = inlineValidator.digest(i);
    const deferredDigest = deferredValidator.digest(i);
    if (
      inlineDigest !== deferredDigest ||
      inlineDigest.length !== 64 ||
      !/^[0-9a-f]{64}$/.test(inlineDigest)
    ) {
      allEqual = false;
      ok(
        false,
        `${name}: record ${i}: deferred digest ${deferredDigest} equals inline digest ${inlineDigest}`,
      );
    }
  }
  ok(
    allEqual,
    `${name}: record-digest-equal: the deferred digest equals the inline one for every one of ${records.length - 1} records`,
  );

  // record-digest-complete, cleared: now that every index has been digested, nothing is pending.
  ok(
    deferredValidator.digestPending().length === 0,
    `${name}: digestPending() is [] once digest() has been called for every accepted record`,
  );
  ok(
    checkRecordDigestComplete(deferredValidator).length === 0,
    `${name}: checkRecordDigestComplete(deferred) is [] once every accepted record is digested`,
  );

  ok(
    inlineValidator.finish().length === 0,
    `${name}: inlineValidator.finish() is [] (${name} is a clean recording)`,
  );
  ok(
    deferredValidator.finish().length === 0,
    `${name}: deferredValidator.finish() is [] (${name} is a clean recording)`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--inputs");
  if (i === -1 || args[i + 1] === undefined) {
    console.error(
      "self-test-record-digest: --inputs <render-stream-gate7-bench-inputs/1 json> is required " +
        '(the four G7x bench recordings; see gate7-design.md "G7x" Inputs table)',
    );
    process.exitCode = 2;
    return;
  }
  const inputsPath = resolve(args[i + 1]);
  const parsed = JSON.parse(
    await readFile(inputsPath, "utf8"),
  ) as BenchInputsFile;
  if (
    parsed.schema !== "render-stream-gate7-bench-inputs/1" ||
    !parsed.inputs
  ) {
    console.error(
      `self-test-record-digest: ${inputsPath} is not render-stream-gate7-bench-inputs/1`,
    );
    process.exitCode = 2;
    return;
  }
  for (const input of parsed.inputs)
    await checkInput(input.name, resolve(input.recording));

  console.log(
    `\nself-test-record-digest: ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
