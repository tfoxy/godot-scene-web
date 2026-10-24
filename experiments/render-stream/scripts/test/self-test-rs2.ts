#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the render-stream/2, /3, /4, /5 AND /6 TypeScript decoder/validator/resolver
// (lib/render-stream-2.ts) against the golden vectors they share with the C++ codec/diff and the
// Rust core (until G7gd also a GDScript decoder) (protocol/golden-2/, render-stream-2.md; protocol/golden-3/,
// render-stream-3.md; protocol/golden-4/, render-stream-4.md; protocol/golden-5/,
// render-stream-5.md; protocol/golden-6/, render-stream-6.md).
//
//   mise exec -- pnpm exec tsx --conditions=development scripts/test/self-test-rs2.ts
//
// render-stream/3 (G4e1), /4 (G5w), /5 (G55w) and /6 (G6w) are implemented in render-stream-2.ts
// itself, behind an explicit `version` parameter -- not forked render-stream-3.ts/-4.ts/-5.ts/
// -6.ts modules (gate4-design.md G4e1: "Renaming files is not part of this contract").
// runSuite() below runs the same checks against golden-2 (version 2, unchanged), golden-3
// (version 3), golden-4 (version 4), golden-5 (version 5) and golden-6 (version 6); "renamed
// tests are not required" means the per-check messages below still say "rs2"-flavoured things
// like ".rs2"/".rs3"/".rs4"/".rs5"/".rs6" from `entry.file` itself, not from a hardcoded suffix.
//
// Checks, each required by gate2-design.md's G2b1 "Pass criteria" (and, for golden-3/-4/-5/-6, by
// gate4-design.md's G4e1, render-stream-4.md's G5w, render-stream-5.md's G55w and
// gate6-design.md's G6w "Pass criteria"):
//   - decodeRecording() deep-equals each of full/patch/inline.decoded.json;
//   - recordSha256() reproduces every record's sha256 in all three decoded forms;
//   - validateRecording() of all three valid vectors is [];
//   - resolveRecording() of all three deep-equals resolved.json (session_id/stream_id/per-
//     transaction "encoding" excepted, as /1), and its "resources" is [] for full/patch and
//     index.json's "inline_resources" for inline (checked separately: unlike the other fields,
//     this one is never shared ground truth -- it is genuinely stream-specific);
//   - golden-5 only: params.rs5 (gate5_5-design.md D4's "params" shader-source policy) decodes,
//     validates clean and resolves to resolved-params.json -- its own independent leg, since it
//     is a separate small recording, not part of the shared resolved.json;
//   - golden-6 only: presentation.rs6, snap.rs6 and rate.rs6 (gate6-design.md Q4's three
//     dedicated small streams) each decode, validate clean and resolve to their own
//     resolved-*.json -- independent legs, mirroring params.rs5;
//   - every invalid/*.rs2, .rs3, .rs4, .rs5 or .rs6 is rejected with exactly one error of the
//     right code;
//   - corrupt-meta.rs2/.rs3/.rs4/.rs5/.rs6 is rejected with "meta-json";
//   - every payload-invalid/*.grt (golden-2 only: /3 does not change the payload format) throws
//     the named code from decodeTexturePayload(); every payload-invalid/*.grm (golden-4 only)
//     throws the named code from decodeMeshPayload(); every payload-invalid/*.grp (golden-5
//     only) throws the named code from decodeShaderPayload();
//   - every payloads/*.grt hashes to its listed name and decodes to its listed shape, and
//     expectedDataBytes() agrees with the payload's own data length; every golden-4
//     mesh_payloads/*.grm likewise against decodeMeshPayload()/meshPayloadSha256(); every
//     golden-5 shader_payloads/*.grp likewise against decodeShaderPayload()/
//     shaderPayloadSha256().
//   - protocol/unknown-item-skip.md: a /4 skip session (unknown_item_policy after sabotage,
//     unknown_items after unsupported in every transaction) validates and resolves with its
//     account; the key in a strict session, a skip transaction without it and any policy value
//     but "skip" are all meta-schema.
//
// Exits non-zero if any assertion fails.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  checkKtx2Shape,
  decodeKtx2Payload,
  decodeRecording,
  decodeTexturePayload,
  expectedDataBytes,
  isPartialUnknownItems,
  payloadSha256,
  recordSha256,
  resolveRecording,
  statesEqual,
  validateRecording,
  wireVersionOf,
} from "../lib/render-stream-2";
import {
  decodeMeshPayload,
  meshPayloadSha256,
} from "../lib/render-stream-mesh";
import {
  decodeShaderPayload,
  shaderPayloadSha256,
} from "../lib/render-stream-shader";
import { encodeRs2Recording, type TState } from "./rs2-test-encoder";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GOLDEN2_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-2");
const GOLDEN3_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-3");
const GOLDEN4_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-4");
const GOLDEN5_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-5");
const GOLDEN6_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-6");
const GOLDEN7_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-7");
const GOLDEN8_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-8");
const GOLDEN9_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-9");

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
  // golden-5 only (render-stream-5.md "Shader payload").
  shader_payloads?: Array<{ file: string; hash: string; bytes: number }>;
  // golden-5 only: params.rs5's own independent leg (gate5_5-design.md D4).
  params_leg?: IndependentLeg;
  // golden-6 only: presentation.rs6/snap.rs6/rate.rs6's own independent legs (render-stream-6.md
  // "Golden vectors"), mirroring params_leg.
  presentation_leg?: IndependentLeg;
  snap_leg?: IndependentLeg;
  rate_leg?: IndependentLeg;
  // golden-7 only (render-stream-7.md "Golden vectors", gate7-design.md Q2): window2.rs7, the
  // credit_window-2 leg with two chained patches.
  window2_leg?: IndependentLeg;
  // golden-8 only (render-stream-8.md "Golden vectors"): off.rs8, the adoption-null,
  // decode-off leg with a /8 sabotage declaration.
  off_leg?: IndependentLeg;
  // golden-9 only (render-stream-9.md "Golden vectors"): the two synthetic KTX2 payloads.
  ktx2_payloads?: Array<{
    file: string;
    hash: string;
    width: number;
    height: number;
    levels: number;
    bytes: number;
    encoding: string;
    supercompression: string;
  }>;
  control?: { valid: string[]; invalid: string[] };
}

interface IndependentLeg {
  file: string;
  hex: string;
  decoded: string;
  sha256: string;
  resolved: string;
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
// G5w; 5 for golden-5/ -- render-stream-5.md G55w; 6 for golden-6/ -- render-stream-6.md G6w).
// The checks themselves are the same for all five: only the directory and the `version` argument
// threaded into decodeRecording()/validateRecording()/resolveRecording() differ.
async function runSuite(
  goldenDir: string,
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
): Promise<void> {
  const label = goldenDir.endsWith("golden-9")
    ? "golden-9"
    : goldenDir.endsWith("golden-8")
      ? "golden-8"
      : goldenDir.endsWith("golden-7")
        ? "golden-7"
        : goldenDir.endsWith("golden-6")
          ? "golden-6"
          : goldenDir.endsWith("golden-5")
            ? "golden-5"
            : goldenDir.endsWith("golden-4")
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

  // --- every payload-invalid/*.grt (or, at /4, *.grm; at /5, *.grp) throws its named code ------
  for (const entry of index.payload_invalid ?? []) {
    const bytes = await readBytes(goldenDir, entry.file);
    let threw: string | null = null;
    try {
      // golden-4's payload_invalid vectors are GRM1 (render-stream-mesh/1); golden-5's are GRP1
      // (render-stream-shader/1); every other golden directory's are GRT1.
      if (version === 5) {
        decodeShaderPayload(bytes);
      } else if (version === 4) {
        decodeMeshPayload(bytes);
      } else {
        decodeTexturePayload(bytes);
      }
    } catch (error) {
      threw = String((error as Error).message ?? error);
    }
    ok(
      threw?.startsWith(`${entry.code}: `) ?? false,
      `${label}: decode${version === 5 ? "Shader" : version === 4 ? "Mesh" : "Texture"}Payload(${entry.file}) throws "${entry.code}: ..." (got ${JSON.stringify(threw)})`,
    );
  }

  // --- every payloads/*.grt hashes to its name and decodes to its listed shape ----------------
  for (const entry of index.payloads) {
    const bytes = await readBytes(goldenDir, entry.file);
    ok(
      payloadSha256(bytes) === entry.hash,
      `${label}: payloadSha256(${entry.file}) equals its listed hash`,
    );
    const decoded = decodeTexturePayload(bytes, version);
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
        version,
      ) === decoded.data.length,
      `${label}: expectedDataBytes() agrees with ${entry.file}'s actual data length`,
    );
  }

  // --- golden-9's ktx2_payloads/*.ktx2 hash to their names and decode to their listed shape ----
  for (const entry of index.ktx2_payloads ?? []) {
    const bytes = await readBytes(goldenDir, entry.file);
    ok(
      payloadSha256(bytes) === entry.hash && bytes.length === entry.bytes,
      `${label}: ${entry.file} hashes to its listed hash and has its listed length`,
    );
    let decoded: ReturnType<typeof decodeKtx2Payload> | undefined;
    try {
      decoded = decodeKtx2Payload(bytes);
    } catch (error) {
      ok(
        false,
        `${label}: decodeKtx2Payload(${entry.file}) threw ${String(error)}`,
      );
    }
    if (decoded !== undefined) {
      ok(
        decoded.width === entry.width &&
          decoded.height === entry.height &&
          decoded.levels === entry.levels &&
          decoded.model === entry.encoding &&
          decoded.supercompression ===
            (entry.supercompression === "zstd" ? 2 : 1),
        `${label}: decodeKtx2Payload(${entry.file}) decodes to its listed shape`,
      );
      ok(
        checkKtx2Shape(
          decoded,
          "uastc",
          entry.width,
          entry.height,
          entry.levels > 1,
        ) === null &&
          checkKtx2Shape(
            decoded,
            "etc1s",
            entry.width,
            entry.height,
            entry.levels > 1,
          ) !== null,
        `${label}: checkKtx2Shape(${entry.file}) accepts uastc at its own size and refuses etc1s`,
      );
    }
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

  // --- every golden-5 shader_payloads/*.grp hashes to its name and decodes to its listed shape -
  for (const entry of index.shader_payloads ?? []) {
    const bytes = await readBytes(goldenDir, entry.file);
    ok(
      shaderPayloadSha256(bytes) === entry.hash,
      `${label}: shaderPayloadSha256(${entry.file}) equals its listed hash`,
    );
    const decoded = decodeShaderPayload(bytes);
    ok(
      new TextEncoder().encode(decoded.code).length === decoded.code_bytes,
      `${label}: decodeShaderPayload(${entry.file}) decodes a code string whose UTF-8 length equals code_bytes`,
    );
    ok(
      bytes.length === entry.bytes,
      `${label}: ${entry.file}'s total byte length equals index.json's listed "bytes"`,
    );
  }

  // --- independent legs: golden-5's params.rs5 (gate5_5-design.md D4), golden-6's
  // presentation.rs6/snap.rs6/rate.rs6 (render-stream-6.md "Golden vectors") and golden-7's
  // rate.rs7/window2.rs7 (render-stream-7.md "Golden vectors") -- each a separate, independent
  // small recording, not part of the shared full/patch/inline streams. ------------------------
  for (const legEntry of [
    index.params_leg,
    index.presentation_leg,
    index.snap_leg,
    index.rate_leg,
    index.window2_leg,
    index.off_leg,
  ]) {
    if (legEntry === undefined) continue;
    const bytes = await readBytes(goldenDir, legEntry.file);
    const expectedDecoded = JSON.parse(
      await readFile(join(goldenDir, legEntry.decoded), "utf8"),
    );
    const decoded = decodeRecording(bytes, version);
    ok(
      isDeepStrictEqual(decoded, expectedDecoded),
      `${label}: decodeRecording(${legEntry.file}) deep-equals ${legEntry.decoded}`,
    );
    const errors = validateRecording(bytes, version);
    ok(
      errors.length === 0,
      `${label}: validateRecording(${legEntry.file}) is [] (got ${JSON.stringify(errors)})`,
    );
    const resolved = resolveRecording(bytes, version);
    const expectedResolved = JSON.parse(
      await readFile(join(goldenDir, legEntry.resolved), "utf8"),
    );
    if (legEntry === index.window2_leg) {
      // render-stream-7.md "Golden vectors" (As built, G7w): window2.rs7's credit_window-2
      // stream has THREE transactions (a full plus two chained no-op patches) where
      // resolved-rate.json has one -- nothing in the scene ever changes, so every transaction's
      // `state` (seq/frame/encoding aside) must equal that single expected state.
      const expectedState = (
        expectedResolved as { transactions: Array<{ state: unknown }> }
      ).transactions[0].state;
      ok(
        resolved.transactions.length === 3,
        `${label}: resolveRecording(${legEntry.file}) has 3 transactions (got ${resolved.transactions.length})`,
      );
      for (const txn of resolved.transactions) {
        ok(
          statesEqual(txn.state, expectedState),
          `${label}: resolveRecording(${legEntry.file}) seq ${txn.seq}'s state deep-equals ${legEntry.resolved}'s sole transaction state`,
        );
      }
    } else {
      const stripped = stripExcepted(resolved);
      ok(
        statesEqual(stripped, expectedResolved),
        `${label}: resolveRecording(${legEntry.file}) deep-equals ${legEntry.resolved} (excepted fields aside)`,
      );
    }
  }
}

async function main(): Promise<void> {
  await runSuite(GOLDEN2_DIR, 2);
  await runSuite(GOLDEN3_DIR, 3);
  await runSuite(GOLDEN4_DIR, 4);
  await runSuite(GOLDEN5_DIR, 5);
  await runSuite(GOLDEN6_DIR, 6);
  await runSuite(GOLDEN7_DIR, 7);
  await runSuite(GOLDEN8_DIR, 8);
  await runSuite(GOLDEN9_DIR, 9);

  // --- a /3 decode refuses a /2-magic stream, and vice versa (render-stream-3.md: "Decoders
  // refuse GRS2 ... any other byte 3 is simply 'any other byte 3' to a /2 decoder"); likewise a
  // /4 decode refuses /3 and a /3 decode refuses /4, a /5 decode refuses /4 and a /4 decode
  // refuses /5, and a /6 decode refuses /5 and a /5 decode refuses /6 (render-stream-4.md/
  // render-stream-5.md/render-stream-6.md, same rule) -------------------------------------------
  const full2 = await readBytes(GOLDEN2_DIR, "full.rs2");
  const full3 = await readBytes(GOLDEN3_DIR, "full.rs3");
  const full4 = await readBytes(GOLDEN4_DIR, "full.rs4");
  const full5 = await readBytes(GOLDEN5_DIR, "full.rs5");
  const full6 = await readBytes(GOLDEN6_DIR, "full.rs6");
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
  ok(
    validateRecording(full5, 4)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-5/full.rs5 decoded as version 4 is rejected with bad-magic",
  );
  ok(
    validateRecording(full4, 5)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-4/full.rs4 decoded as version 5 is rejected with bad-magic",
  );
  ok(
    validateRecording(full6, 5)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-6/full.rs6 decoded as version 5 is rejected with bad-magic",
  );
  ok(
    validateRecording(full5, 6)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-5/full.rs5 decoded as version 6 is rejected with bad-magic",
  );
  // a /7 decode refuses /6 and a /6 decode refuses /7 (same rule, render-stream-7.md).
  const rate6 = await readBytes(GOLDEN6_DIR, "rate.rs6");
  const rate7 = await readBytes(GOLDEN7_DIR, "rate.rs7");
  ok(
    validateRecording(rate7, 6)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-7/rate.rs7 decoded as version 6 is rejected with bad-magic",
  );
  ok(
    validateRecording(rate6, 7)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-6/rate.rs6 decoded as version 7 is rejected with bad-magic",
  );

  // a /8 decode refuses /7 and a /7 decode refuses /8 (same rule, render-stream-8.md).
  const full8 = await readBytes(GOLDEN8_DIR, "full.rs8");
  ok(
    validateRecording(rate7, 8)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-7/rate.rs7 decoded as version 8 is rejected with bad-magic",
  );
  ok(
    validateRecording(full8, 7)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-8/full.rs8 decoded as version 7 is rejected with bad-magic",
  );
  ok(
    wireVersionOf(full8) === 8 &&
      wireVersionOf(rate7) === 7 &&
      wireVersionOf(full6) === 6,
    "wireVersionOf() reads GRS8 as 8, GRS7 as 7 and every other magic as 6",
  );
  await version8Cases(full8, rate7);

  // a /9 decode refuses /8 and a /8 decode refuses /9 (same rule, render-stream-9.md).
  const full9 = await readBytes(GOLDEN9_DIR, "full.rs9");
  ok(
    validateRecording(full8, 9)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-8/full.rs8 decoded as version 9 is rejected with bad-magic",
  );
  ok(
    validateRecording(full9, 8)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-9/full.rs9 decoded as version 8 is rejected with bad-magic",
  );
  ok(
    wireVersionOf(full9) === 9 && wireVersionOf(full8) === 8,
    "wireVersionOf() reads GRS9 as 9",
  );
  await version9Cases(full9);

  unknownItemCases();
  await helloCases();

  console.log(
    `\nself-test-rs2: ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

// Re-frames the session record (the first one) of a recording with a mutated meta object:
// recomputes meta_len and the record length, leaves every block untouched.
function reframeSession(
  bytes: Uint8Array,
  mutate: (meta: Record<string, unknown>) => void,
): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const recordLen = view.getUint32(8, true);
  const metaLen = view.getUint32(12, true);
  const metaText = Buffer.from(bytes.subarray(16, 16 + metaLen)).toString(
    "ascii",
  );
  const meta = JSON.parse(metaText) as Record<string, unknown>;
  mutate(meta);
  const newMeta = Buffer.from(JSON.stringify(meta), "ascii");
  const tail = bytes.subarray(16 + metaLen, 12 + recordLen);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(4 + newMeta.length + tail.length, 0);
  head.writeUInt32LE(newMeta.length, 4);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(bytes.subarray(0, 8)),
      head,
      newMeta,
      Buffer.from(tail),
      Buffer.from(bytes.subarray(12 + recordLen)),
    ]),
  );
}

// render-stream-8.md: the version gates the golden vectors cannot show (a /7 stream carrying a /8
// field), mutated from real recordings, plus the float payload sizes' version gate.
async function version8Cases(
  full8: Uint8Array,
  rate7: Uint8Array,
): Promise<void> {
  const first = (bytes: Uint8Array, version: 7 | 8) =>
    validateRecording(bytes, version)[0] ?? "";
  // Sanity: re-framing without a change reproduces the recording byte for byte.
  const same = reframeSession(full8, () => undefined);
  ok(
    Buffer.compare(Buffer.from(same), Buffer.from(full8)) === 0,
    "reframeSession() without a mutation reproduces golden-8/full.rs8 exactly",
  );
  const withAdoption = reframeSession(rate7, (meta) => {
    meta.adoption = null;
  });
  ok(
    first(withAdoption, 7).startsWith("meta-schema: "),
    "a /7 session carrying the /8 key adoption is rejected (meta-schema)",
  );
  const withKind = reframeSession(rate7, (meta) => {
    meta.sabotage = { kind: "perturb-decode", frame: 1, op: null };
  });
  ok(
    first(withKind, 7).startsWith("meta-schema: "),
    "a /7 session declaring the /8-only sabotage kind perturb-decode is rejected (meta-schema)",
  );
  const noAdoption = reframeSession(full8, (meta) => {
    delete meta.adoption;
  });
  ok(
    first(noAdoption, 8).startsWith("meta-schema: "),
    "a /8 session without the adoption key is rejected (meta-schema)",
  );
  const noDecode = reframeSession(full8, (meta) => {
    delete (meta.resources as Record<string, unknown>).decode;
  });
  ok(
    first(noDecode, 8).startsWith("meta-schema: "),
    "a /8 session without resources.decode is rejected (meta-schema)",
  );
  // Float payload formats are sized at /8 only (D9); below /8 they stay unsized, as before.
  ok(
    expectedDataBytes("RGBAF", 2, 2, false, 8) === 64 &&
      expectedDataBytes("RGF", 3, 2, true, 8) === 56 &&
      expectedDataBytes("RGBH", 4, 4, false, 8) === 96,
    "expectedDataBytes() sizes RGBAF/RGF/RGBH at /8",
  );
  let threw = false;
  try {
    expectedDataBytes("RGBAF", 2, 2, false, 7);
  } catch {
    threw = true;
  }
  ok(threw, "expectedDataBytes() refuses RGBAF below /8");
}

// render-stream-9.md: the version gates the golden vectors cannot show, mutated from the real /9
// recording, plus the block payload sizes.
async function version9Cases(full9: Uint8Array): Promise<void> {
  const first = (bytes: Uint8Array) => validateRecording(bytes, 9)[0] ?? "";
  const same = reframeSession(full9, () => undefined);
  ok(
    Buffer.compare(Buffer.from(same), Buffer.from(full9)) === 0,
    "reframeSession() without a mutation reproduces golden-9/full.rs9 exactly",
  );
  const noDelivery = reframeSession(full9, (meta) => {
    delete (meta.resources as Record<string, unknown>).texture_delivery;
  });
  ok(
    first(noDelivery).startsWith("meta-schema: "),
    "a /9 session without resources.texture_delivery is rejected (meta-schema)",
  );
  const badEncoder = reframeSession(full9, (meta) => {
    (
      (meta.resources as Record<string, unknown>).texture_delivery as Record<
        string,
        unknown
      >
    ).encoder = "Basis 1.60";
  });
  ok(
    first(badEncoder).startsWith("meta-schema: "),
    "a /9 session whose encoder is not a params_id prefix is rejected (meta-schema)",
  );
  // The /8 decoder refuses a /8 session carrying the /9 key (the resources object has fixed keys).
  const full8 = await readBytes(GOLDEN8_DIR, "full.rs8");
  const with8Key = reframeSession(full8, (meta) => {
    (meta.resources as Record<string, unknown>).texture_delivery = {
      mode: "rgba",
      encoder: null,
    };
  });
  ok(
    (validateRecording(with8Key, 8)[0] ?? "").startsWith("meta-schema: "),
    "a /8 session carrying resources.texture_delivery is rejected (meta-schema)",
  );
  // Block payload sizes are known at /9 only; below /9 the block formats stay unsized.
  ok(
    expectedDataBytes("DXT1", 4, 4, false, 9) === 8 &&
      expectedDataBytes("DXT5", 16, 16, true, 9) === 368 &&
      expectedDataBytes("ASTC_8x8", 16, 16, true, 9) ===
        64 + 16 + 16 + 16 + 16 &&
      expectedDataBytes("ETC2_RGB8", 5, 5, false, 9) === 32 &&
      expectedDataBytes("RGTC_R", 1, 1, true, 9) === 8,
    "expectedDataBytes() sizes the block formats at /9 (Godot's _get_dst_image_size)",
  );
  let threw = false;
  try {
    expectedDataBytes("DXT5", 4, 4, false, 8);
  } catch {
    threw = true;
  }
  ok(threw, "expectedDataBytes() refuses a block format below /9");
}

// protocol/unknown-item-skip.md "Session"/"Transaction": the two optional keys, at /6 (the test encoder speaks /6 since G6b).
function unknownItemCases(): void {
  const account = (calls: number) => ({
    unknown_rids: 1,
    withheld_items: 2,
    withheld_commands: 3,
    unknown_calls: calls,
  });
  const states = (withAccount: boolean[]): TState[] =>
    withAccount.map((has, i) => ({
      frame: i + 1,
      canvases: [{ id: 1, items: [], xform: [1, 0, 0, 1, 0, 0] }],
      items: [],
      ...(has ? { unknown_items: account(i + 4) } : {}),
    }));
  const opts = { encoding: "patch" as const, hooksPlanned: [] };
  const skip = encodeRs2Recording(states([true, true]), {
    ...opts,
    unknownItemPolicy: "skip",
  });
  ok(
    validateRecording(skip, 6).length === 0,
    `unknown items: a /6 skip session validates (${validateRecording(skip, 6)[0] ?? ""})`,
  );
  const decoded = decodeRecording(skip, 6);
  const session = decoded.records[0].meta;
  ok(
    session.type === "session" && session.unknown_item_policy === "skip",
    "unknown items: the session decodes unknown_item_policy",
  );
  const resolved = resolveRecording(skip, 6);
  ok(
    isDeepStrictEqual(resolved.transactions[1].state.unknown_items, account(5)),
    "unknown items: the patch transaction resolves with its complete account",
  );
  const tx = decoded.records[1].meta;
  ok(
    tx.type === "transaction" && isPartialUnknownItems(tx),
    "unknown items: a transaction with an unknown RID is partial-unknown-items",
  );
  ok(
    !isPartialUnknownItems({
      unknown_items: { ...account(1), unknown_rids: 0, withheld_items: 0 },
    }) && !isPartialUnknownItems({}),
    "unknown items: nothing withheld (or a strict transaction) is not partial",
  );
  const metaSchema = (bytes: Uint8Array, version: 6, what: string) => {
    const errors = validateRecording(bytes, version);
    ok(
      errors.length === 1 && errors[0].startsWith("meta-schema: "),
      `unknown items: ${what} is meta-schema (${errors[0] ?? "accepted"})`,
    );
  };
  metaSchema(
    encodeRs2Recording(states([true, true]), opts),
    6,
    "unknown_items in a strict session",
  );
  metaSchema(
    encodeRs2Recording(states([true, false]), {
      ...opts,
      unknownItemPolicy: "skip",
    }),
    6,
    "a skip transaction without unknown_items",
  );
  metaSchema(
    encodeRs2Recording(states([true]), {
      ...opts,
      unknownItemPolicy: "strict" as "skip",
    }),
    6,
    'unknown_item_policy "strict" (absent is the only spelling of strict)',
  );
}

// --------------------------------------------------------------------------------------- hello (G7w)
//
// render-stream-7.md "Hello" (gate7-design.md Q2): a minimal, self-contained hello checker for
// the TypeScript self-test (G7w's own scope -- hello is a live-wire control message, never part
// of a recording, so render-stream-2.ts's decoder never touches it; this mirrors
// rs_live.cpp's parse_control(V7) independently, exercised against the SAME golden-7/control/
// vectors that file's own self-test checks).
const HELLO7_KEYS = [
  "type",
  "protocol",
  "receiver",
  "receiver_kind",
  "credit_stage",
  "credit_window",
  "inbound_buffer_bytes",
  "token",
  "manifest_sha256",
  "presentation_backing_w",
  "presentation_backing_h",
  "presentation_css_w",
  "presentation_css_h",
  "dpr_milli",
];
const HEX64 = /^[0-9a-f]{64}$/;

function isNonNegativeInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// render-stream-9.md "Hello": /8's keys plus texture_encodings and gpu_formats, each a comma list
// matching ^[a-z0-9]+(,[a-z0-9]+)*$ of at most 96 characters.
const HELLO9_KEYS = [...HELLO7_KEYS, "texture_encodings", "gpu_formats"];
const FLAT_LIST = /^[a-z0-9]+(,[a-z0-9]+)*$/;

function checkHello9(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["hello is not an object"];
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (
    keys.length !== HELLO9_KEYS.length ||
    !HELLO9_KEYS.every((k) => keys.includes(k))
  ) {
    return [
      `hello has keys ${JSON.stringify(keys)}, expected exactly ${JSON.stringify(HELLO9_KEYS)}`,
    ];
  }
  for (const key of ["texture_encodings", "gpu_formats"]) {
    const v = obj[key];
    if (typeof v !== "string" || v.length > 96 || !FLAT_LIST.test(v)) {
      return [`"${key}" is not a comma list of [a-z0-9] names, <= 96 chars`];
    }
  }
  // Everything else is /7's hello under the protocol string render-stream/9.
  const rest: Record<string, unknown> = {};
  for (const key of HELLO7_KEYS) rest[key] = obj[key];
  rest.protocol =
    obj.protocol === "render-stream/9" ? "render-stream/7" : obj.protocol;
  return checkHello7(rest);
}

function checkHello7(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["hello is not an object"];
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (
    keys.length !== HELLO7_KEYS.length ||
    !HELLO7_KEYS.every((k) => keys.includes(k))
  ) {
    return [
      `hello has keys ${JSON.stringify(keys)}, expected exactly ${JSON.stringify(HELLO7_KEYS)}`,
    ];
  }
  if (obj.type !== "hello") return ['"type" is not "hello"'];
  if (obj.protocol !== "render-stream/7")
    return [
      `"protocol" is ${JSON.stringify(obj.protocol)}, not "render-stream/7"`,
    ];
  if (typeof obj.receiver !== "string" || obj.receiver.length > 64)
    return ['"receiver" is not a string of at most 64 characters'];
  if (
    !["native", "web-export", "gsw-canvas"].includes(
      obj.receiver_kind as string,
    )
  )
    return ['"receiver_kind" is not native, web-export or gsw-canvas'];
  if (obj.credit_stage !== "submitted" && obj.credit_stage !== "applied")
    return ['"credit_stage" is not submitted or applied'];
  if (
    typeof obj.credit_window !== "number" ||
    !Number.isInteger(obj.credit_window) ||
    obj.credit_window < 1 ||
    obj.credit_window > 2
  )
    return [
      `"credit_window" is ${JSON.stringify(obj.credit_window)}, not 1 or 2`,
    ];
  if (!isNonNegativeInt(obj.inbound_buffer_bytes))
    return ['"inbound_buffer_bytes" is not a non-negative integer'];
  if (
    !(
      obj.token === null ||
      (typeof obj.token === "string" && HEX64.test(obj.token))
    )
  )
    return ['"token" is neither null nor 64 lowercase hex'];
  if (
    !(
      obj.manifest_sha256 === null ||
      (typeof obj.manifest_sha256 === "string" &&
        HEX64.test(obj.manifest_sha256))
    )
  )
    return ['"manifest_sha256" is neither null nor 64 lowercase hex'];
  for (const key of [
    "presentation_backing_w",
    "presentation_backing_h",
    "presentation_css_w",
    "presentation_css_h",
    "dpr_milli",
  ]) {
    if (!isNonNegativeInt(obj[key])) {
      return [`"${key}" is not a non-negative integer`];
    }
  }
  return [];
}

async function helloCases9(): Promise<void> {
  const index = JSON.parse(
    await readFile(join(GOLDEN9_DIR, "index.json"), "utf8"),
  ) as { control: { valid: string[]; invalid: string[] } };
  ok(
    index.control.valid.length === 4 && index.control.invalid.length === 10,
    "golden-9 index lists 4 valid and 10 invalid control vectors",
  );
  for (const file of index.control.valid) {
    const parsed: unknown = JSON.parse(
      await readFile(join(GOLDEN9_DIR, file), "utf8"),
    );
    const errors = checkHello9(parsed);
    ok(
      errors.length === 0,
      `golden-9/${file} accepted (got ${JSON.stringify(errors)})`,
    );
  }
  for (const file of index.control.invalid) {
    const parsed: unknown = JSON.parse(
      await readFile(join(GOLDEN9_DIR, file), "utf8"),
    );
    ok(checkHello9(parsed).length > 0, `golden-9/${file} refused`);
  }
}

async function helloCases(): Promise<void> {
  await helloCases9();
  const root = join(GOLDEN7_DIR, "control");
  const validDir = join(root, "valid");
  const invalidDir = join(root, "invalid");
  const validFiles = (await readdir(validDir))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const invalidFiles = (await readdir(invalidDir))
    .filter((f) => f.endsWith(".json"))
    .sort();
  ok(
    validFiles.length === 4,
    `golden-7/control/valid has 4 vectors (got ${validFiles.length})`,
  );
  ok(
    invalidFiles.length === 6,
    `golden-7/control/invalid has 6 vectors (got ${invalidFiles.length})`,
  );
  for (const file of validFiles) {
    const parsed: unknown = JSON.parse(
      await readFile(join(validDir, file), "utf8"),
    );
    const errors = checkHello7(parsed);
    ok(
      errors.length === 0,
      `golden-7/control/valid/${file} accepted (got ${JSON.stringify(errors)})`,
    );
  }
  for (const file of invalidFiles) {
    const parsed: unknown = JSON.parse(
      await readFile(join(invalidDir, file), "utf8"),
    );
    const errors = checkHello7(parsed);
    ok(errors.length > 0, `golden-7/control/invalid/${file} refused`);
  }
  // A sanity round trip on a known-good vector's fields, independent of the golden file.
  const sample = {
    type: "hello",
    protocol: "render-stream/7",
    receiver: "x",
    receiver_kind: "gsw-canvas",
    credit_stage: "submitted",
    credit_window: 1,
    inbound_buffer_bytes: 1024,
    token: null,
    manifest_sha256: null,
    presentation_backing_w: 1,
    presentation_backing_h: 1,
    presentation_css_w: 1,
    presentation_css_h: 1,
    dpr_milli: 1000,
  };
  ok(
    checkHello7(sample).length === 0,
    "a hand-built minimal /7 hello is accepted",
  );
  ok(
    checkHello7({ ...sample, credit_window: 3 }).length > 0,
    "credit_window 3 is refused",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
