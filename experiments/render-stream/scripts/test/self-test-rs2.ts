#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the render-stream/2 TypeScript decoder/validator/resolver (lib/render-stream-2.ts)
// against the golden vectors it shares with the C++ codec/diff and the GDScript decoder
// (protocol/golden-2/, protocol/render-stream-2.md).
//
//   mise exec -- pnpm exec tsx --conditions=development scripts/test/self-test-rs2.ts
//
// Checks, each required by gate2-design.md's G2b1 "Pass criteria":
//   - decodeRecording() deep-equals each of full/patch/inline.decoded.json;
//   - recordSha256() reproduces every record's sha256 in all three decoded forms;
//   - validateRecording() of all three valid vectors is [];
//   - resolveRecording() of all three deep-equals resolved.json (session_id/stream_id/per-
//     transaction "encoding" excepted, as /1), and its "resources" is [] for full/patch.rs2 and
//     index.json's "inline_resources" for inline.rs2 (checked separately: unlike the other
//     fields, this one is never shared ground truth -- it is genuinely stream-specific);
//   - every protocol/golden-2/invalid/*.rs2 is rejected with exactly one error of the right code;
//   - corrupt-meta.rs2 is rejected with "meta-json";
//   - every payload-invalid/*.grt throws the named code from decodeTexturePayload();
//   - every payloads/*.grt hashes to its listed name and decodes to its listed shape, and
//     expectedDataBytes() agrees with the payload's own data length.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  decodeRecording,
  decodeTexturePayload,
  expectedDataBytes,
  payloadSha256,
  recordSha256,
  resolveRecording,
  statesEqual,
  validateRecording,
} from "../lib/render-stream-2";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-2");

interface GoldenIndex {
  valid: Array<{ file: string; hex: string; decoded: string; sha256: string }>;
  resolved: string;
  inline_resources: Array<{
    hash: string;
    bytes: number;
    record_index: number;
  }>;
  corrupt: Array<{
    file: string;
    code: string;
    record_index: number;
    seq: number;
    description: string;
  }>;
  invalid: Array<{ file: string; code: string; description: string }>;
  payload_invalid: Array<{ file: string; code: string; description: string }>;
  payloads: Array<{
    file: string;
    hash: string;
    format: string;
    width: number;
    height: number;
    mipmaps: boolean;
    bytes: number;
  }>;
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

// render-stream-2.md "Golden vectors": resolved.json omits the top-level session_id/stream_id,
// the per-transaction "encoding", AND (unlike /1) the top-level "resources" -- the last one is
// checked separately below, since it is never shared across the three streams.
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

  // --- all three streams resolve to the same shared resolved.json (modulo excepted fields) ----
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
        `resolveRecording(${entry.file}) deep-equals ${index.resolved} (excepted fields aside)`,
      );
      const expectedResources =
        entry.file === "inline.rs2" ? index.inline_resources : [];
      ok(
        statesEqual(resolved.resources, expectedResources),
        `resolveRecording(${entry.file}).resources is ${entry.file === "inline.rs2" ? "index.json's inline_resources" : "[]"}`,
      );
    }
  }

  // --- corrupt-meta.rs2 is rejected with exactly one error, "meta-json" -----------------------
  for (const entry of index.corrupt) {
    const bytes = await readBytes(entry.file);
    const errors = validateRecording(bytes);
    ok(
      errors.length === 1 && errors[0].startsWith(`${entry.code}: `),
      `validateRecording(${entry.file}) is rejected with exactly one error starting with "${entry.code}: " (got ${JSON.stringify(errors)})`,
    );
  }

  // --- every invalid/*.rs2 is rejected with exactly its one expected code ---------------------
  for (const entry of index.invalid) {
    const bytes = await readBytes(entry.file);
    const errors = validateRecording(bytes);
    ok(
      errors.length === 1 && errors[0].startsWith(`${entry.code}: `),
      `validateRecording(${entry.file}) is rejected with exactly one error starting with "${entry.code}: " (got ${JSON.stringify(errors)})`,
    );
  }

  // --- every payload-invalid/*.grt throws its named code from decodeTexturePayload() ---------
  for (const entry of index.payload_invalid) {
    const bytes = await readBytes(entry.file);
    let threw: string | null = null;
    try {
      decodeTexturePayload(bytes);
    } catch (error) {
      threw = String((error as Error).message ?? error);
    }
    ok(
      threw?.startsWith(`${entry.code}: `) ?? false,
      `decodeTexturePayload(${entry.file}) throws "${entry.code}: ..." (got ${JSON.stringify(threw)})`,
    );
  }

  // --- every payloads/*.grt hashes to its name and decodes to its listed shape ----------------
  for (const entry of index.payloads) {
    const bytes = await readBytes(entry.file);
    ok(
      payloadSha256(bytes) === entry.hash,
      `payloadSha256(${entry.file}) equals its listed hash`,
    );
    const decoded = decodeTexturePayload(bytes);
    ok(
      decoded.format === entry.format &&
        decoded.width === entry.width &&
        decoded.height === entry.height &&
        decoded.mipmaps === entry.mipmaps,
      `decodeTexturePayload(${entry.file}) decodes to its listed shape`,
    );
    ok(
      bytes.length === entry.bytes,
      `${entry.file}'s total byte length equals index.json's listed "bytes"`,
    );
    ok(
      expectedDataBytes(
        entry.format,
        entry.width,
        entry.height,
        entry.mipmaps,
      ) === decoded.data.length,
      `expectedDataBytes() agrees with ${entry.file}'s actual data length`,
    );
  }

  console.log(
    `\nself-test-rs2: ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
