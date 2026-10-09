#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the render-stream/0 TypeScript decoder (lib/render-stream-0.ts) against the
// golden vectors it shares with the C++ encoder and the GDScript decoder
// (protocol/golden/, protocol/render-stream-0.md).
//
//   mise exec -- pnpm exec tsx --conditions=development scripts/test/self-test-rs0.ts
//
// Checks, each required by gate0-design.md's WP2 "Passes when":
//   - decodeRecording(minimal.bin) deep-equals minimal.decoded.json;
//   - validateRecording(minimal.bin) is [] (it validates clean);
//   - recordSha256() reproduces every record's sha256 in minimal.decoded.json;
//   - every protocol/golden/invalid/*.bin is rejected by validateRecording() with exactly one
//     error, and that error starts with the code index.json names for it;
//   - corrupt-meta.bin is rejected the same way, with "meta-json".
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  decodeRecording,
  recordSha256,
  validateRecording,
} from "../lib/render-stream-0";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(SCRIPT_DIR, "../../protocol/golden");

interface GoldenIndex {
  valid: Array<{ file: string; hex: string; decoded: string; sha256: string }>;
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

async function main(): Promise<void> {
  const index = JSON.parse(
    await readFile(join(GOLDEN_DIR, "index.json"), "utf8"),
  ) as GoldenIndex;

  // --- minimal.bin decodes exactly like minimal.decoded.json ---------------------------------
  const minimalEntry = index.valid[0];
  const minimalBytes = await readBytes(minimalEntry.file);
  const expectedDecoded = JSON.parse(
    await readFile(join(GOLDEN_DIR, minimalEntry.decoded), "utf8"),
  );

  let decoded: ReturnType<typeof decodeRecording> | undefined;
  try {
    decoded = decodeRecording(minimalBytes);
    ok(true, `decodeRecording(${minimalEntry.file}) did not throw`);
  } catch (error) {
    ok(
      false,
      `decodeRecording(${minimalEntry.file}) did not throw (threw: ${String(error)})`,
    );
  }
  if (decoded !== undefined) {
    ok(
      isDeepStrictEqual(decoded, expectedDecoded),
      `decodeRecording(${minimalEntry.file}) deep-equals ${minimalEntry.decoded}`,
    );
    for (const record of decoded.records) {
      ok(
        recordSha256(minimalBytes, record.offset) === record.sha256,
        `recordSha256() reproduces the sha256 of the record at offset ${record.offset}`,
      );
    }
  }

  // --- minimal.bin validates clean ------------------------------------------------------------
  const minimalErrors = validateRecording(minimalBytes);
  ok(
    minimalErrors.length === 0,
    `validateRecording(${minimalEntry.file}) is [] (got ${JSON.stringify(minimalErrors)})`,
  );

  // --- corrupt-meta.bin is rejected with exactly one error, "meta-json" ------------------------
  for (const entry of index.corrupt) {
    const bytes = await readBytes(entry.file);
    const errors = validateRecording(bytes);
    ok(
      errors.length === 1 && errors[0].startsWith(`${entry.code}: `),
      `validateRecording(${entry.file}) is rejected with exactly one error starting with "${entry.code}: " (got ${JSON.stringify(errors)})`,
    );
  }

  // --- every invalid/*.bin is rejected with exactly its one expected code ---------------------
  for (const entry of index.invalid) {
    const bytes = await readBytes(entry.file);
    const errors = validateRecording(bytes);
    ok(
      errors.length === 1 && errors[0].startsWith(`${entry.code}: `),
      `validateRecording(${entry.file}) is rejected with exactly one error starting with "${entry.code}: " (got ${JSON.stringify(errors)})`,
    );
  }

  console.log(
    `\nself-test-rs0: ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
