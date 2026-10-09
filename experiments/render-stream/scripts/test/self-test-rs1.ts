#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the render-stream/1 TypeScript decoder/validator/resolver (lib/render-stream-1.ts)
// against the golden vectors it shares with the C++ codec/diff and the GDScript decoder
// (protocol/golden-1/, protocol/render-stream-1.md).
//
//   mise exec -- pnpm exec tsx --conditions=development scripts/test/self-test-rs1.ts
//
// Checks, each required by gate1-design.md's G1b1 "Pass criteria":
//   - decodeRecording(full.rs1) deep-equals full.decoded.json, same for patch.rs1;
//   - recordSha256() reproduces every record's sha256 in both decoded forms;
//   - validateRecording() of both valid vectors is [];
//   - resolveRecording(full.rs1) and resolveRecording(patch.rs1) both deep-equal resolved.json,
//     with the stream_id and per-transaction "encoding" fields excepted (render-stream-1.md
//     "Golden vectors": those legitimately differ between the two streams);
//   - every protocol/golden-1/invalid/*.rs1 is rejected by validateRecording() with exactly one
//     error, whose code is the one index.json names for it;
//   - corrupt-meta.rs1 is rejected the same way, with "meta-json".
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  decodeRecording,
  recordSha256,
  resolveRecording,
  statesEqual,
  validateRecording,
} from "../lib/render-stream-1";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-1");

interface GoldenIndex {
  valid: Array<{ file: string; hex: string; decoded: string; sha256: string }>;
  resolved: string;
  corrupt: Array<{
    file: string;
    code: string;
    record_index: number;
    seq: number;
    description: string;
  }>;
  invalid: Array<{ file: string; code: string; description: string }>;
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

async function readBytes(relativePath: string): Promise<Uint8Array> {
  const buf = await readFile(join(GOLDEN_DIR, relativePath));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// render-stream-1.md "Golden vectors": resolved.json omits the top-level stream_id and the
// per-transaction "encoding" field, since those legitimately differ between full.rs1 and
// patch.rs1. Strip the same fields from a live resolveRecording() result before comparing.
function stripExcepted(resolved: ReturnType<typeof resolveRecording>): unknown {
  return {
    schema: resolved.schema,
    transactions: resolved.transactions.map((t) => ({
      seq: t.seq,
      frame: t.frame,
      state: t.state,
    })),
  };
}

async function main(): Promise<void> {
  const index = JSON.parse(
    await readFile(join(GOLDEN_DIR, "index.json"), "utf8"),
  ) as GoldenIndex;

  for (const entry of index.valid) {
    const bytes = await readBytes(entry.file);
    const expectedDecoded = JSON.parse(
      await readFile(join(GOLDEN_DIR, entry.decoded), "utf8"),
    );

    let decoded: ReturnType<typeof decodeRecording> | undefined;
    try {
      decoded = decodeRecording(bytes);
      ok(true, `decodeRecording(${entry.file}) did not throw`);
    } catch (error) {
      ok(
        false,
        `decodeRecording(${entry.file}) did not throw (threw: ${String(error)})`,
      );
    }
    if (decoded !== undefined) {
      ok(
        isDeepStrictEqual(decoded, expectedDecoded),
        `decodeRecording(${entry.file}) deep-equals ${entry.decoded}`,
      );
      for (const record of decoded.records) {
        ok(
          recordSha256(bytes, record.offset) === record.sha256,
          `recordSha256() reproduces the sha256 of the ${entry.file} record at offset ${record.offset}`,
        );
      }
    }

    const errors = validateRecording(bytes);
    ok(
      errors.length === 0,
      `validateRecording(${entry.file}) is [] (got ${JSON.stringify(errors)})`,
    );
  }

  // --- both streams resolve to the same shared resolved.json (modulo the excepted fields) -----
  const expectedResolved = JSON.parse(
    await readFile(join(GOLDEN_DIR, index.resolved), "utf8"),
  );
  for (const entry of index.valid) {
    const bytes = await readBytes(entry.file);
    let resolved: ReturnType<typeof resolveRecording> | undefined;
    try {
      resolved = resolveRecording(bytes);
      ok(true, `resolveRecording(${entry.file}) did not throw`);
    } catch (error) {
      ok(
        false,
        `resolveRecording(${entry.file}) did not throw (threw: ${String(error)})`,
      );
    }
    if (resolved !== undefined) {
      const stripped = stripExcepted(resolved);
      ok(
        statesEqual(stripped, expectedResolved),
        `resolveRecording(${entry.file}) deep-equals ${index.resolved} (stream_id/encoding excepted)`,
      );
    }
  }

  // --- corrupt-meta.rs1 is rejected with exactly one error, "meta-json" -----------------------
  for (const entry of index.corrupt) {
    const bytes = await readBytes(entry.file);
    const errors = validateRecording(bytes);
    ok(
      errors.length === 1 && errors[0].startsWith(`${entry.code}: `),
      `validateRecording(${entry.file}) is rejected with exactly one error starting with "${entry.code}: " (got ${JSON.stringify(errors)})`,
    );
  }

  // --- every invalid/*.rs1 is rejected with exactly its one expected code ---------------------
  for (const entry of index.invalid) {
    const bytes = await readBytes(entry.file);
    const errors = validateRecording(bytes);
    ok(
      errors.length === 1 && errors[0].startsWith(`${entry.code}: `),
      `validateRecording(${entry.file}) is rejected with exactly one error starting with "${entry.code}: " (got ${JSON.stringify(errors)})`,
    );
  }

  console.log(
    `\nself-test-rs1: ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
