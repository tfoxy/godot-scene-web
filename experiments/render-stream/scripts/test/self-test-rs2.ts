#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the render-stream/2, /3 AND /4 TypeScript decoder/validator/resolver
// (lib/render-stream-2.ts) against the golden vectors they share with the C++ codec/diff and the
// GDScript decoder (protocol/golden-2/, render-stream-2.md; protocol/golden-3/,
// render-stream-3.md; protocol/golden-4/, render-stream-4.md).
//
//   mise exec -- pnpm exec tsx --conditions=development scripts/test/self-test-rs2.ts
//
// render-stream/3 (G4e1) and render-stream/4 (G5w) are implemented in render-stream-2.ts itself,
// behind an explicit `version` parameter -- not forked render-stream-3.ts/-4.ts modules
// (gate4-design.md G4e1: "Renaming files is not part of this contract"). runSuite() below runs
// the same checks against golden-2 (version 2, unchanged), golden-3 (version 3) and golden-4
// (version 4); "renamed tests are not required" means the per-check messages below still say
// "rs2"-flavoured things like ".rs2"/".rs3"/".rs4" from `entry.file` itself, not from a
// hardcoded suffix.
//
// Checks, each required by gate2-design.md's G2b1 "Pass criteria" (and, for golden-3/-4, by
// gate4-design.md's G4e1 and render-stream-4.md's G5w "Pass criteria"):
//   - decodeRecording() deep-equals each of full/patch/inline.decoded.json;
//   - recordSha256() reproduces every record's sha256 in all three decoded forms;
//   - validateRecording() of all three valid vectors is [];
//   - resolveRecording() of all three deep-equals resolved.json (session_id/stream_id/per-
//     transaction "encoding" excepted, as /1), and its "resources" is [] for full/patch and
//     index.json's "inline_resources" for inline (checked separately: unlike the other fields,
//     this one is never shared ground truth -- it is genuinely stream-specific);
//   - every invalid/*.rs2, .rs3 or .rs4 is rejected with exactly one error of the right code;
//   - corrupt-meta.rs2/.rs3/.rs4 is rejected with "meta-json";
//   - every payload-invalid/*.grt (golden-2 only: /3 does not change the payload format) throws
//     the named code from decodeTexturePayload(); every payload-invalid/*.grm (golden-4 only)
//     throws the named code from decodeMeshPayload();
//   - every payloads/*.grt hashes to its listed name and decodes to its listed shape, and
//     expectedDataBytes() agrees with the payload's own data length; every golden-4
//     mesh_payloads/*.grm likewise against decodeMeshPayload()/meshPayloadSha256().
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
import {
  decodeMeshPayload,
  meshPayloadSha256,
} from "../lib/render-stream-mesh";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GOLDEN2_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-2");
const GOLDEN3_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-3");
const GOLDEN4_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-4");

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
  // golden-3 has no payload-invalid vectors of its own: render-stream-3.md does not change the
  // render-stream-texture/1 payload format, so golden-2's are the only ones that exist.
  payload_invalid?: Array<{ file: string; code: string; description: string }>;
  payloads: Array<{
    file: string;
    hash: string;
    format: string;
    width: number;
    height: number;
    mipmaps: boolean;
    bytes: number;
  }>;
  // golden-4 only (render-stream-4.md "Mesh payload").
  mesh_payloads?: Array<{
    file: string;
    hash: string;
    primitive: string;
    format: number;
    vertex_count: number;
    index_count: number;
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

async function readBytes(
  goldenDir: string,
  relativePath: string,
): Promise<Uint8Array> {
  const buf = await readFile(join(goldenDir, relativePath));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// render-stream-2.md "Golden vectors": resolved.json omits the top-level session_id/stream_id,
// the per-transaction "encoding", AND (unlike /1) the top-level "resources" -- the last one is
// checked separately below, since it is never shared across the three streams. Unchanged at /3
// (render-stream-3.md "Golden vectors").
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

// Runs every check against one golden directory, decoding with the given protocol `version`
// (2 for golden-2/, 3 for golden-3/ -- gate4-design.md G4e1; 4 for golden-4/ -- render-stream-4.md
// G5w). The checks themselves are the same for all three: only the directory and the `version`
// argument threaded into decodeRecording()/validateRecording()/resolveRecording() differ.
async function runSuite(goldenDir: string, version: 2 | 3 | 4): Promise<void> {
  const label = goldenDir.endsWith("golden-4")
    ? "golden-4"
    : goldenDir.endsWith("golden-3")
      ? "golden-3"
      : "golden-2";
  const index = JSON.parse(
    await readFile(join(goldenDir, "index.json"), "utf8"),
  ) as GoldenIndex;

  for (const entry of index.valid) {
    const bytes = await readBytes(goldenDir, entry.file);
    const expectedDecoded = JSON.parse(
      await readFile(join(goldenDir, entry.decoded), "utf8"),
    );

    let decoded: ReturnType<typeof decodeRecording> | undefined;
    try {
      decoded = decodeRecording(bytes, version);
      ok(true, `${label}: decodeRecording(${entry.file}) did not throw`);
    } catch (error) {
      ok(
        false,
        `${label}: decodeRecording(${entry.file}) did not throw (threw: ${String(error)})`,
      );
    }
    if (decoded !== undefined) {
      ok(
        isDeepStrictEqual(decoded, expectedDecoded),
        `${label}: decodeRecording(${entry.file}) deep-equals ${entry.decoded}`,
      );
      for (const record of decoded.records) {
        ok(
          recordSha256(bytes, record.offset) === record.sha256,
          `${label}: recordSha256() reproduces the sha256 of the ${entry.file} record at offset ${record.offset}`,
        );
      }
    }

    const errors = validateRecording(bytes, version);
    ok(
      errors.length === 0,
      `${label}: validateRecording(${entry.file}) is [] (got ${JSON.stringify(errors)})`,
    );
  }

  // --- all three streams resolve to the same shared resolved.json (modulo excepted fields) ----
  const expectedResolved = JSON.parse(
    await readFile(join(goldenDir, index.resolved), "utf8"),
  );
  for (const entry of index.valid) {
    const bytes = await readBytes(goldenDir, entry.file);
    let resolved: ReturnType<typeof resolveRecording> | undefined;
    try {
      resolved = resolveRecording(bytes, version);
      ok(true, `${label}: resolveRecording(${entry.file}) did not throw`);
    } catch (error) {
      ok(
        false,
        `${label}: resolveRecording(${entry.file}) did not throw (threw: ${String(error)})`,
      );
    }
    if (resolved !== undefined) {
      const stripped = stripExcepted(resolved);
      ok(
        statesEqual(stripped, expectedResolved),
        `${label}: resolveRecording(${entry.file}) deep-equals ${index.resolved} (excepted fields aside)`,
      );
      const isInline = entry.file.startsWith("inline.");
      const expectedResources = isInline ? index.inline_resources : [];
      ok(
        statesEqual(resolved.resources, expectedResources),
        `${label}: resolveRecording(${entry.file}).resources is ${isInline ? "index.json's inline_resources" : "[]"}`,
      );
    }
  }

  // --- corrupt-meta.rs2/.rs3 is rejected with exactly one error, "meta-json" -------------------
  for (const entry of index.corrupt) {
    const bytes = await readBytes(goldenDir, entry.file);
    const errors = validateRecording(bytes, version);
    ok(
      errors.length === 1 && errors[0].startsWith(`${entry.code}: `),
      `${label}: validateRecording(${entry.file}) is rejected with exactly one error starting with "${entry.code}: " (got ${JSON.stringify(errors)})`,
    );
  }

  // --- every invalid/*.rs2/.rs3 is rejected with exactly its one expected code -----------------
  for (const entry of index.invalid) {
    const bytes = await readBytes(goldenDir, entry.file);
    const errors = validateRecording(bytes, version);
    ok(
      errors.length === 1 && errors[0].startsWith(`${entry.code}: `),
      `${label}: validateRecording(${entry.file}) is rejected with exactly one error starting with "${entry.code}: " (got ${JSON.stringify(errors)})`,
    );
  }

  // --- every payload-invalid/*.grt (or, at /4, *.grm) throws its named code -------------------
  for (const entry of index.payload_invalid ?? []) {
    const bytes = await readBytes(goldenDir, entry.file);
    let threw: string | null = null;
    try {
      // golden-4's payload_invalid vectors are GRM1 (render-stream-mesh/1), not GRT1; every
      // other golden directory's are GRT1.
      if (version === 4) {
        decodeMeshPayload(bytes);
      } else {
        decodeTexturePayload(bytes);
      }
    } catch (error) {
      threw = String((error as Error).message ?? error);
    }
    ok(
      threw?.startsWith(`${entry.code}: `) ?? false,
      `${label}: decode${version === 4 ? "Mesh" : "Texture"}Payload(${entry.file}) throws "${entry.code}: ..." (got ${JSON.stringify(threw)})`,
    );
  }

  // --- every payloads/*.grt hashes to its name and decodes to its listed shape ----------------
  for (const entry of index.payloads) {
    const bytes = await readBytes(goldenDir, entry.file);
    ok(
      payloadSha256(bytes) === entry.hash,
      `${label}: payloadSha256(${entry.file}) equals its listed hash`,
    );
    const decoded = decodeTexturePayload(bytes);
    ok(
      decoded.format === entry.format &&
        decoded.width === entry.width &&
        decoded.height === entry.height &&
        decoded.mipmaps === entry.mipmaps,
      `${label}: decodeTexturePayload(${entry.file}) decodes to its listed shape`,
    );
    ok(
      bytes.length === entry.bytes,
      `${label}: ${entry.file}'s total byte length equals index.json's listed "bytes"`,
    );
    ok(
      expectedDataBytes(
        entry.format,
        entry.width,
        entry.height,
        entry.mipmaps,
      ) === decoded.data.length,
      `${label}: expectedDataBytes() agrees with ${entry.file}'s actual data length`,
    );
  }

  // --- every golden-4 mesh_payloads/*.grm hashes to its name and decodes to its listed shape ---
  for (const entry of index.mesh_payloads ?? []) {
    const bytes = await readBytes(goldenDir, entry.file);
    ok(
      meshPayloadSha256(bytes) === entry.hash,
      `${label}: meshPayloadSha256(${entry.file}) equals its listed hash`,
    );
    const decoded = decodeMeshPayload(bytes);
    ok(
      decoded.primitive === entry.primitive &&
        decoded.format === entry.format &&
        decoded.vertex_count === entry.vertex_count &&
        decoded.index_count === entry.index_count,
      `${label}: decodeMeshPayload(${entry.file}) decodes to its listed shape`,
    );
    ok(
      bytes.length === entry.bytes,
      `${label}: ${entry.file}'s total byte length equals index.json's listed "bytes"`,
    );
  }
}

async function main(): Promise<void> {
  await runSuite(GOLDEN2_DIR, 2);
  await runSuite(GOLDEN3_DIR, 3);
  await runSuite(GOLDEN4_DIR, 4);

  // --- a /3 decode refuses a /2-magic stream, and vice versa (render-stream-3.md: "Decoders
  // refuse GRS2 ... any other byte 3 is simply 'any other byte 3' to a /2 decoder"); likewise a
  // /4 decode refuses /3 and a /3 decode refuses /4 (render-stream-4.md, same rule) -------------
  const full2 = await readBytes(GOLDEN2_DIR, "full.rs2");
  const full3 = await readBytes(GOLDEN3_DIR, "full.rs3");
  const full4 = await readBytes(GOLDEN4_DIR, "full.rs4");
  ok(
    validateRecording(full3, 2)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-3/full.rs3 decoded as version 2 is rejected with bad-magic",
  );
  ok(
    validateRecording(full2, 3)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-2/full.rs2 decoded as version 3 is rejected with bad-magic",
  );
  ok(
    validateRecording(full4, 3)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-4/full.rs4 decoded as version 3 is rejected with bad-magic",
  );
  ok(
    validateRecording(full3, 4)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-3/full.rs3 decoded as version 4 is rejected with bad-magic",
  );

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
