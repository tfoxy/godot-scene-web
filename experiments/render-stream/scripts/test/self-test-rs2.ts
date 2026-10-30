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
//   - golden-13 (W13a, render-stream-13.md "As built (W13a)"): runSuite at version 13 (every
//     invalid vector also at its listed seq), then version13Cases(): XXH64's test vectors, every
//     lane transcoded /13 -> /12 (decodeRs13) and /12 -> /13 (encodeRs13) byte for byte, the
//     predict lane against predict.decoded.json and predict-resolved.json, the predict-stale
//     encoder sabotage (= invalid/predict-stale.rs13) and the noPredictReset validator sabotage
//     (predict-check at predict.rs13 seq 7, patch.rs13 seq 16).
//
// Exits non-zero if any assertion fails.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  checkInlineFetch,
  checkKtx2Shape,
  createRecordingValidator,
  decodeKtx2Payload,
  decodeRecord,
  decodeRecording,
  decodeRs13,
  decodeTexturePayload,
  encodeRs13,
  expectedDataBytes,
  type ItemMetaRecordMeta,
  type ItemMetaRequest,
  isPartialUnknownItems,
  itemMetaRowJson,
  multimeshBufferSha256,
  PARTICLE_EMIT_FLOAT_COUNT,
  particlesFloatCount,
  particlesFloatsByName,
  particlesFloatsInWireOrder,
  payloadSha256,
  recordSha256,
  resolveRecording,
  splitRecords,
  statesEqual,
  transactionMultimeshes,
  transactionParticleEmits,
  transactionParticles,
  validateRecording,
  wireVersionOf,
  xxh64Hex,
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
const GOLDEN10_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-10");
const GOLDEN11_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-11");
const GOLDEN12_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-12");
const GOLDEN13_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-13");

interface GoldenIndex {
  valid: Array<{ file: string; hex: string; decoded: string; sha256: string }>;
  resolved: string;
  inline_resources: Array<{
    hash: string;
    bytes: number;
    record_index: number;
    /** golden-11 on: the seq of the transaction the record precedes. */
    before_seq?: number;
  }>;
  corrupt: Array<{
    file: string;
    code: string;
    record_index: number;
    seq: number;
    description: string;
  }>;
  /** golden-11 on: each invalid entry carries the version to decode it at (decision 11). */
  invalid: Array<{
    file: string;
    code: string;
    description: string;
    version?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
    /** golden-13 on: the seq of the transaction the vector fails at (null when not one). */
    seq?: number | null;
    /** TAG1 (golden-13): the record the vector fails at. */
    record_index?: number;
    /** TAG1 (golden-13): the validator's item_meta ask (absent: a recording; "none": not asked). */
    item_meta?: ItemMetaRequest | "none";
  }>;
  // golden-3 has no payload-invalid vectors of its own: render-stream-3.md does not change the
  // render-stream-texture/1 payload format, so golden-2's are the only ones that exist.
  payload_invalid?: Array<{ file: string; code: string; description: string }>;
  /** absent from golden-11 (its payloads are golden-10's plus the dynamic bodies). */
  payloads?: Array<{
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
  // golden-11 only (render-stream-11.md "Golden vectors"): names(S) per seq and the dynamic
  // surface bodies.
  names?: Array<{ seq: number; names: string[] }>;
  dynamic_bodies?: Array<{
    file: string;
    source: string;
    sha256: string;
    bytes: number;
  }>;
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
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13,
): Promise<void> {
  const label = goldenDir.endsWith("golden-13")
    ? "golden-13"
    : goldenDir.endsWith("golden-12")
    ? "golden-12"
    : goldenDir.endsWith("golden-11")
    ? "golden-11"
    : goldenDir.endsWith("golden-10")
      ? "golden-10"
      : goldenDir.endsWith("golden-9")
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
  // render-stream-13.md "Forms and transcode": resource records are unchanged at /13, record for
  // record, so golden-13's inline lane carries golden-12's inline_resources.
  if (version === 13 && index.inline_resources === undefined) {
    index.inline_resources = (
      JSON.parse(
        await readFile(join(GOLDEN12_DIR, "index.json"), "utf8"),
      ) as GoldenIndex
    ).inline_resources;
  }

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
    const errors = validateRecording(bytes, entry.version ?? version, {
      itemMeta: itemMetaAsk(entry.item_meta),
    });
    ok(
      errors.length === 1 && errors[0].startsWith(`${entry.code}: `),
      `${label}: validateRecording(${entry.file}) is rejected with exactly one error starting with "${entry.code}: " (got ${JSON.stringify(errors)})`,
    );
    // golden-13 on: the vector fails at its listed transaction.
    if (typeof entry.seq === "number") {
      const at = errorSeq(bytes, entry.version ?? version, errors[0] ?? "");
      ok(
        at === entry.seq,
        `${label}: validateRecording(${entry.file}) fails at seq ${entry.seq} (got ${at})`,
      );
    }
    // TAG1: the item_meta vectors fail at their listed record.
    if (typeof entry.record_index === "number") {
      const m = /record at offset (\d+)/.exec(errors[0] ?? "");
      const at =
        m === null
          ? null
          : splitRecords(bytes, entry.version ?? version).records.findIndex(
              (r) => r.offset === Number(m[1]),
            );
      ok(
        at === entry.record_index,
        `${label}: validateRecording(${entry.file}) fails at record ${entry.record_index} (got ${at})`,
      );
    }
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
  for (const entry of index.payloads ?? []) {
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
  await runSuite(GOLDEN10_DIR, 10);
  await runSuite(GOLDEN11_DIR, 11);
  await runSuite(GOLDEN12_DIR, 12);
  await runSuite(GOLDEN13_DIR, 13);

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

  // a /10 decode refuses /9 and a /9 decode refuses /10 (same rule, render-stream-10.md "File
  // layout": byte 3 is the version as one uppercase hex digit, GRSA).
  const full10 = await readBytes(GOLDEN10_DIR, "full.rs10");
  ok(
    validateRecording(full9, 10)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-9/full.rs9 decoded as version 10 is rejected with bad-magic",
  );
  ok(
    validateRecording(full10, 9)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-10/full.rs10 decoded as version 9 is rejected with bad-magic",
  );
  ok(
    Buffer.from(full10.subarray(0, 4)).toString("latin1") === "GRSA" &&
      wireVersionOf(full10) === 10 &&
      wireVersionOf(full9) === 9,
    "wireVersionOf() reads GRSA as 10",
  );

  // a /11 decode refuses /10 and a /10 decode refuses /11 (render-stream-11.md "File layout").
  const full11 = await readBytes(GOLDEN11_DIR, "full.rs11");
  ok(
    validateRecording(full10, 11)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-10/full.rs10 decoded as version 11 is rejected with bad-magic",
  );
  ok(
    validateRecording(full11, 10)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-11/full.rs11 decoded as version 10 is rejected with bad-magic",
  );
  ok(
    Buffer.from(full11.subarray(0, 4)).toString("latin1") === "GRSB" &&
      wireVersionOf(full11) === 11 &&
      wireVersionOf(full10) === 10,
    "wireVersionOf() reads GRSB as 11",
  );
  await version11Cases();

  // a /12 decode refuses /11 and a /11 decode refuses /12 (render-stream-12.md "File layout").
  const full12 = await readBytes(GOLDEN12_DIR, "full.rs12");
  ok(
    validateRecording(full12, 11)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-12/full.rs12 decoded as version 11 is rejected with bad-magic",
  );
  ok(
    Buffer.from(full12.subarray(0, 4)).toString("latin1") === "GRSC" &&
      wireVersionOf(full12) === 12 &&
      wireVersionOf(full11) === 11,
    "wireVersionOf() reads GRSC as 12",
  );
  await version12Cases();

  // a /13 decode refuses /12 and a /12 decode refuses /13 (render-stream-13.md "As built
  // (W13a)": GRSD).
  const full13 = await readBytes(GOLDEN13_DIR, "full.rs13");
  ok(
    validateRecording(full12, 13)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-12/full.rs12 decoded as version 13 is rejected with bad-magic",
  );
  ok(
    validateRecording(full13, 12)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-13/full.rs13 decoded as version 12 is rejected with bad-magic",
  );
  ok(
    Buffer.from(full13.subarray(0, 4)).toString("latin1") === "GRSD" &&
      wireVersionOf(full13) === 13 &&
      wireVersionOf(full12) === 12,
    "golden-13/full.rs13 starts with GRSD, and wireVersionOf() reads it as 13 (W13d)",
  );
  await version13Cases();

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

// render-stream-10.md "Live transport": the hello is /9's under protocol "render-stream/10"; a /9
// hello on a /10 connection is refused.
function checkHello10(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["hello is not an object"];
  }
  const obj = value as Record<string, unknown>;
  if (obj.protocol !== "render-stream/10")
    return [
      `"protocol" is ${JSON.stringify(obj.protocol)}, not "render-stream/10"`,
    ];
  return checkHello9({ ...obj, protocol: "render-stream/9" });
}

async function helloCases10(): Promise<void> {
  const index = JSON.parse(
    await readFile(join(GOLDEN10_DIR, "index.json"), "utf8"),
  ) as { control: { valid: string[]; invalid: string[] } };
  ok(
    index.control.valid.length === 1 && index.control.invalid.length === 1,
    "golden-10 index lists 1 valid and 1 invalid control vector",
  );
  for (const file of index.control.valid) {
    const parsed: unknown = JSON.parse(
      await readFile(join(GOLDEN10_DIR, file), "utf8"),
    );
    const errors = checkHello10(parsed);
    ok(
      errors.length === 0,
      `golden-10/${file} accepted (got ${JSON.stringify(errors)})`,
    );
  }
  for (const file of index.control.invalid) {
    const parsed: unknown = JSON.parse(
      await readFile(join(GOLDEN10_DIR, file), "utf8"),
    );
    ok(checkHello10(parsed).length > 0, `golden-10/${file} refused`);
    ok(
      checkHello9(parsed).length === 0,
      `golden-10/${file} is a valid /9 hello (refused only for its protocol)`,
    );
  }
}

// render-stream-11.md "Why": the hello is /9's fifteen keys under protocol "render-stream/11"; a
// /10 hello on a /11 connection is refused. W11t ("As built (W11t)"): it may add `live_coding`, a
// comma list of [a-z0-9-] names of at most 96 characters (the only optional key).
function checkHello11(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["hello is not an object"];
  }
  const obj = value as Record<string, unknown>;
  if (obj.protocol !== "render-stream/11")
    return [
      `"protocol" is ${JSON.stringify(obj.protocol)}, not "render-stream/11"`,
    ];
  const { live_coding: liveCoding, ...rest } = obj;
  if (
    "live_coding" in obj &&
    (typeof liveCoding !== "string" ||
      liveCoding.length > 96 ||
      !/^[a-z0-9-]+(,[a-z0-9-]+)*$/.test(liveCoding))
  )
    return [`"live_coding" ${JSON.stringify(liveCoding)} is not a comma list of [a-z0-9-] names`];
  return checkHello9({ ...rest, protocol: "render-stream/9" });
}

async function helloCases11(): Promise<void> {
  const index = JSON.parse(
    await readFile(join(GOLDEN11_DIR, "index.json"), "utf8"),
  ) as { control: { valid: string[]; invalid: string[] } };
  ok(
    index.control.valid.length === 2 && index.control.invalid.length === 2,
    "golden-11 index lists 2 valid and 2 invalid control vectors",
  );
  for (const file of index.control.valid) {
    const parsed: unknown = JSON.parse(
      await readFile(join(GOLDEN11_DIR, file), "utf8"),
    );
    const errors = checkHello11(parsed);
    ok(
      errors.length === 0,
      `golden-11/${file} accepted (got ${JSON.stringify(errors)})`,
    );
  }
  for (const file of index.control.invalid) {
    const parsed: unknown = JSON.parse(
      await readFile(join(GOLDEN11_DIR, file), "utf8"),
    );
    ok(checkHello11(parsed).length > 0, `golden-11/${file} refused`);
    if (file.includes("wrong-protocol"))
      ok(
        checkHello10(parsed).length === 0,
        `golden-11/${file} is a valid /10 hello (refused only for its protocol)`,
      );
    else
      ok(
        checkHello11({ ...(parsed as object), live_coding: "zstd" }).length === 0,
        `golden-11/${file} is refused only for its live_coding`,
      );
  }
}

// golden-11's /11-only legs: the early-prune validator sabotage (decision 10), names(S) per seq
// against index.json's "names", the dynamic bodies' digests, and the inline-fetch-zero predicate
// (decision 9).
async function version11Cases(): Promise<void> {
  const index = JSON.parse(
    await readFile(join(GOLDEN11_DIR, "index.json"), "utf8"),
  ) as GoldenIndex;
  const inline11 = await readBytes(GOLDEN11_DIR, "inline.rs11");
  const sabotaged = validateRecording(inline11, 11, {
    sabotage: "early-prune",
  });
  ok(
    sabotaged.length === 1 && sabotaged[0].startsWith("resource-missing: "),
    `golden-11: sabotage early-prune fails inline.rs11 with resource-missing (got ${JSON.stringify(sabotaged)})`,
  );
  const firstTxnOffset = decodeRecording(inline11, 11).records.find(
    (r) => r.meta.type === "transaction",
  )?.offset;
  ok(
    sabotaged[0]?.includes(`record at offset ${firstTxnOffset}:`) ?? false,
    "golden-11: early-prune's resource-missing is at the first transaction (seq 1)",
  );
  ok(
    validateRecording(inline11, 11).length === 0,
    "golden-11: inline.rs11 without the sabotage is valid",
  );

  // names(S) per seq, from the resolved tables (render-stream-11.md "Definitions").
  const resolved = resolveRecording(
    await readBytes(GOLDEN11_DIR, "full.rs11"),
    11,
  );
  const namesBySeq = new Map(
    (index.names ?? []).map((n) => [n.seq, [...n.names].sort()] as const),
  );
  ok(
    namesBySeq.size === resolved.transactions.length,
    `golden-11: index.json lists names for every seq (${namesBySeq.size} of ${resolved.transactions.length})`,
  );
  for (const txn of resolved.transactions) {
    const names = new Set<string>();
    for (const t of txn.state.textures) {
      if (t.kind !== "image" || t.status !== "ok" || t.hash === null) continue;
      names.add(t.hash);
      for (const v of t.variants ?? []) names.add(v.hash);
    }
    for (const m of txn.state.meshes ?? [])
      if (m.status === "ok")
        for (const s of m.surfaces) if (s.hash !== null) names.add(s.hash);
    for (const sh of txn.state.shaders ?? [])
      if (sh.status === "ok" && sh.source === "payload" && sh.hash !== null)
        names.add(sh.hash);
    ok(
      isDeepStrictEqual([...names].sort(), namesBySeq.get(txn.seq)),
      `golden-11: seq ${txn.seq}'s resolved names equal index.json's names`,
    );
  }

  const resolvedText = JSON.stringify(resolved.transactions);
  for (const body of index.dynamic_bodies ?? []) {
    const bytes = await readBytes(GOLDEN11_DIR, body.file);
    ok(
      payloadSha256(bytes) === body.sha256 && bytes.length === body.bytes,
      `golden-11: ${body.file} hashes to its listed sha256 and has its listed length`,
    );
    ok(
      resolvedText.includes(`"body_sha256":"${body.sha256}"`),
      `golden-11: ${body.file}'s sha256 is some resolved dynamic surface's body_sha256`,
    );
  }

  // inline-fetch-zero (decision 9): after inline.rs11's last transaction, every non-variant
  // inline-sized name is refused; a hash the stream never named is not.
  const split = splitRecords(inline11, 11);
  const validator = createRecordingValidator(split.records, 11);
  for (let i = 1; i < split.records.length - 1; i++) validator.accept(i);
  const lastNames =
    namesBySeq.get(resolved.transactions.at(-1)?.seq ?? -1) ?? [];
  ok(
    lastNames.length > 0 &&
      lastNames.every(
        (h) =>
          checkInlineFetch(validator, h)?.startsWith("inline-fetch-zero: ") ??
          false,
      ),
    "golden-11: checkInlineFetch refuses every name of inline.rs11's last state",
  );
  ok(
    checkInlineFetch(validator, "0".repeat(64)) === null,
    "golden-11: checkInlineFetch allows a hash outside the state and C",
  );
  const outOfBand = splitRecords(
    await readBytes(GOLDEN11_DIR, "full.rs11"),
    11,
  );
  const oobValidator = createRecordingValidator(outOfBand.records, 11);
  for (let i = 1; i < outOfBand.records.length - 1; i++) oobValidator.accept(i);
  ok(
    lastNames.every((h) => checkInlineFetch(oobValidator, h) === null),
    "golden-11: checkInlineFetch allows every name of full.rs11 (out-of-band, inline_max_bytes 0)",
  );
  await multimeshCases11();
}

// PM1 (render-stream-11.md "As built (PM1)"): golden-11's multimesh states 17-21 resolve to the
// tables make_golden.py describes; every resolved buffer_sha256 is the digest of the floats the
// transaction carried (full.rs11: every buffer), a null buffer_f keeps the base's digest
// (patch.rs11 seq 18), and the two PM1 sabotage kinds are /11-only.
async function multimeshCases11(): Promise<void> {
  const full11 = await readBytes(GOLDEN11_DIR, "full.rs11");
  const resolved = resolveRecording(full11, 11);
  const expectedIds: Record<number, number[]> = {
    17: [1, 2, 3],
    18: [1, 2, 3],
    19: [1, 2, 3],
    20: [1],
    21: [1],
    // UIT's states 22 and 23 keep multimesh 1.
    22: [1],
    23: [1],
  };
  for (const txn of resolved.transactions) {
    const ids = txn.state.multimeshes?.map((m) => m.id);
    ok(
      isDeepStrictEqual(ids, expectedIds[txn.seq]),
      `golden-11: seq ${txn.seq}'s resolved multimesh ids are ${JSON.stringify(expectedIds[txn.seq] ?? "absent")} (got ${JSON.stringify(ids)})`,
    );
  }
  const decodedFull = decodeRecording(full11, 11);
  let checked = 0;
  for (const record of decodedFull.records) {
    if (record.meta.type !== "transaction") continue;
    const meta = record.meta;
    const state = resolved.transactions.find((t) => t.seq === meta.seq)?.state;
    for (const { entry, buffer, custom_aabb } of transactionMultimeshes(
      meta,
      record.blocks,
    )) {
      const r = state?.multimeshes?.find((m) => m.id === entry.id);
      const want =
        entry.status === "ok" && buffer !== null
          ? multimeshBufferSha256(buffer)
          : null;
      ok(
        r !== undefined &&
          (entry.status !== "ok" || buffer !== null) &&
          r.buffer_sha256 === want &&
          isDeepStrictEqual(r.custom_aabb, custom_aabb),
        `golden-11: full.rs11 seq ${meta.seq} multimesh ${entry.id}: buffer_sha256 and custom_aabb are the carried floats'`,
      );
      checked++;
    }
  }
  ok(checked === 13, `golden-11: full.rs11 carries 13 multimesh entries (got ${checked})`);
  // UIT (render-stream-11.md "As built (UIT)"): item 18 resolves with use_identity_transform true
  // at 22 (right after copy_to_backbuffer) and without the key at 23, at either encoding.
  for (const name of ["full.rs11", "patch.rs11", "inline.rs11"]) {
    const r = resolveRecording(await readBytes(GOLDEN11_DIR, name), 11);
    const item18 = (seq: number) =>
      r.transactions.find((t) => t.seq === seq)?.state.items.find((i) => i.id === 18);
    const at22 = item18(22);
    const keys = at22 ? Object.keys(at22) : [];
    ok(
      at22?.use_identity_transform === true &&
        keys[keys.indexOf("copy_to_backbuffer") + 1] === "use_identity_transform",
      `golden-11: ${name} seq 22's item 18 resolves with use_identity_transform true after copy_to_backbuffer`,
    );
    const at23 = item18(23);
    ok(
      at23 !== undefined && !("use_identity_transform" in at23),
      `golden-11: ${name} seq 23's item 18 resolves without use_identity_transform`,
    );
  }
  const patch11 = resolveRecording(await readBytes(GOLDEN11_DIR, "patch.rs11"), 11);
  const mm2 = (seq: number) =>
    patch11.transactions
      .find((t) => t.seq === seq)
      ?.state.multimeshes?.find((m) => m.id === 2);
  const decodedPatch = decodeRecording(await readBytes(GOLDEN11_DIR, "patch.rs11"), 11);
  const seq18 = decodedPatch.records.find(
    (r) => r.meta.type === "transaction" && r.meta.seq === 18,
  );
  ok(
    seq18?.meta.type === "transaction" &&
      seq18.meta.multimeshes?.find((m) => m.id === 2)?.buffer_f === null &&
      mm2(18)?.buffer_sha256 !== null &&
      mm2(18)?.buffer_sha256 === mm2(17)?.buffer_sha256 &&
      !isDeepStrictEqual(mm2(18)?.custom_aabb, mm2(17)?.custom_aabb),
    "golden-11: patch.rs11 seq 18's multimesh 2 (buffer_f null, new AABB) keeps seq 17's buffer_sha256",
  );
  ok(
    multimeshBufferSha256([]) === payloadSha256(new Uint8Array(0)),
    "multimeshBufferSha256 of no floats is the SHA-256 of the empty string",
  );

  const full10 = await readBytes(GOLDEN10_DIR, "full.rs10");
  for (const kind of ["perturb-instance", "stale-buffer"]) {
    const v10 = reframeSession(full10, (meta) => {
      meta.sabotage = { kind, frame: 1, op: null };
    });
    ok(
      (validateRecording(v10, 10)[0] ?? "").includes("legal only at /11"),
      `a /10 session declaring the /11-only sabotage kind ${kind} is rejected (meta-schema)`,
    );
    const v11 = reframeSession(full11, (meta) => {
      meta.sabotage = { kind, frame: 1, op: null };
    });
    // The re-framed session moves bytes_total, so the end record's stats are all that differ.
    const errors = validateRecording(v11, 11);
    ok(
      errors.length === 1 && errors[0].startsWith("end-stats-mismatch: "),
      `a /11 session declaring sabotage kind ${kind} is accepted (only the re-framed end stats differ; got ${JSON.stringify(errors)})`,
    );
  }
}

// PM5 (render-stream-12.md "Session record"): /12's hello is /11's under "render-stream/12".
function checkHello12(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["hello is not an object"];
  }
  const obj = value as Record<string, unknown>;
  if (obj.protocol !== "render-stream/12")
    return [
      `"protocol" is ${JSON.stringify(obj.protocol)}, not "render-stream/12"`,
    ];
  return checkHello11({ ...obj, protocol: "render-stream/11" });
}

async function helloCases12(): Promise<void> {
  const index = JSON.parse(
    await readFile(join(GOLDEN12_DIR, "index.json"), "utf8"),
  ) as { control: { valid: string[]; invalid: string[] } };
  ok(
    index.control.valid.length === 2 && index.control.invalid.length === 2,
    "golden-12 index lists 2 valid and 2 invalid control vectors",
  );
  for (const file of index.control.valid) {
    const parsed: unknown = JSON.parse(
      await readFile(join(GOLDEN12_DIR, file), "utf8"),
    );
    const errors = checkHello12(parsed);
    ok(
      errors.length === 0,
      `golden-12/${file} accepted (got ${JSON.stringify(errors)})`,
    );
  }
  for (const file of index.control.invalid) {
    const parsed: unknown = JSON.parse(
      await readFile(join(GOLDEN12_DIR, file), "utf8"),
    );
    ok(checkHello12(parsed).length > 0, `golden-12/${file} refused`);
    if (file.includes("wrong-protocol"))
      ok(
        checkHello11(parsed).length === 0,
        `golden-12/${file} is a valid /11 hello (refused only for its protocol)`,
      );
    else
      ok(
        checkHello12({ ...(parsed as object), live_coding: "zstd" }).length === 0,
        `golden-12/${file} is refused only for its live_coding`,
      );
  }
}

// PM5 (render-stream-12.md "Golden vectors"): golden-12's particles states 22-26 resolve to the
// emitters the generator lists; transactionParticles()/transactionParticleEmits() return the
// floats the resolved entries carry; seq 23's emits; states 1-21 are golden-11's transactions
// byte for byte; the /12-only sabotage kinds.
async function version12Cases(): Promise<void> {
  const full12 = await readBytes(GOLDEN12_DIR, "full.rs12");
  const patchBytes = await readBytes(GOLDEN12_DIR, "patch.rs12");
  const resolved = resolveRecording(full12, 12);
  const expectedIds: Record<number, number[]> = {
    22: [1, 2],
    23: [1, 2],
    24: [1, 2, 3],
    25: [1, 3],
    26: [1, 3],
  };
  for (const txn of resolved.transactions) {
    const ids = txn.state.particles?.map((p) => p.id);
    ok(
      isDeepStrictEqual(ids, expectedIds[txn.seq]),
      `golden-12: seq ${txn.seq}'s resolved particles ids are ${JSON.stringify(expectedIds[txn.seq] ?? "absent")} (got ${JSON.stringify(ids)})`,
    );
  }
  let checked = 0;
  for (const bytes of [full12, patchBytes]) {
    const name = bytes === full12 ? "full.rs12" : "patch.rs12";
    const states = resolveRecording(bytes, 12);
    for (const record of decodeRecording(bytes, 12).records) {
      if (record.meta.type !== "transaction") continue;
      const meta = record.meta;
      const state = states.transactions.find((t) => t.seq === meta.seq)?.state;
      for (const { entry, floats } of transactionParticles(meta, record.blocks)) {
        const r = state?.particles?.find((p) => p.id === entry.id);
        const want =
          floats === null ? null : particlesFloatsByName(floats);
        ok(
          r !== undefined &&
            (floats === null) === (entry.status === "freed") &&
            (floats === null ||
              floats.length === particlesFloatCount(entry.trail_poses)) &&
            statesEqual(r.floats, want) &&
            (want === null ||
              isDeepStrictEqual(particlesFloatsInWireOrder(want), floats)),
          `golden-12: ${name} seq ${meta.seq} particles ${entry.id}: the resolved floats are the carried floats`,
        );
        checked++;
      }
    }
  }
  // full.rs12: 2 + 2 + 3 + 2 + 2 entries; patch.rs12: 2 + 2 (patch) + 2 (patch) + 1 (patch) + 2.
  ok(checked === 11 + 9, `golden-12: full.rs12 and patch.rs12 carry 20 particles entries (got ${checked})`);
  const emitsBySeq = new Map<number, ReturnType<typeof transactionParticleEmits>>();
  for (const record of decodeRecording(full12, 12).records)
    if (record.meta.type === "transaction")
      emitsBySeq.set(
        record.meta.seq,
        transactionParticleEmits(record.meta, record.blocks),
      );
  const emits23 = emitsBySeq.get(23) ?? [];
  ok(
    emits23.length === 2 &&
      emits23.every((e) => e.emit.particles === 1 && e.emit.restarts === 1) &&
      isDeepStrictEqual(
        emits23.map((e) => e.emit.flags),
        [5, 31],
      ) &&
      isDeepStrictEqual(emits23[0].transform, [1, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0]) &&
      isDeepStrictEqual(emits23[0].velocity, [0, -16, 0]) &&
      isDeepStrictEqual(emits23[0].color, [1, 1, 1, 1]) &&
      isDeepStrictEqual(emits23[0].custom, [0, 0, 0, 0]) &&
      isDeepStrictEqual(emits23[1].transform, [2, 0, 0, 0, 2, 0, 0, 0, 1, -8, 4, 0]) &&
      isDeepStrictEqual(emits23[1].velocity, [0, -32, 0]) &&
      isDeepStrictEqual(emits23[1].color, [1, 0.5, 0.25, 1]) &&
      isDeepStrictEqual(emits23[1].custom, [0.5, 0, 0, 1]) &&
      emits23[1].emit.f - emits23[0].emit.f === PARTICLE_EMIT_FLOAT_COUNT,
    "golden-12: full.rs12 seq 23's two emits on emitter 1 carry the generator's floats",
  );
  ok(
    [...emitsBySeq].every(([seq, e]) => (seq === 23) === (e.length > 0)),
    "golden-12: full.rs12 lists emits at seq 23 only",
  );
  const patchSeq25 = decodeRecording(patchBytes, 12).records.find(
    (r) => r.meta.type === "transaction" && r.meta.seq === 25,
  );
  ok(
    patchSeq25?.meta.type === "transaction" &&
      patchSeq25.meta.blocks.length === 9 &&
      isDeepStrictEqual(patchSeq25.meta.removed_particles, [2]) &&
      transactionParticles(patchSeq25.meta, patchSeq25.blocks).every(
        (p) => p.floats === null,
      ),
    "golden-12: patch.rs12 seq 25 removes emitter 2 and carries only the tombstone, without pt_f32",
  );
  const e1at24 = resolved.transactions
    .find((t) => t.seq === 24)
    ?.state.particles?.find((p) => p.id === 1);
  ok(
    e1at24?.trail_poses === 2 &&
      e1at24.floats?.trail_poses.length === 2 &&
      isDeepStrictEqual(e1at24.floats.trail_poses[1], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -4, 0]),
    "golden-12: seq 24's emitter 1 resolves its two trail bind poses",
  );

  // "/12 without particles is transaction-for-transaction /11": seq 1-21's records are
  // golden-11's bytes.
  const full11 = await readBytes(GOLDEN11_DIR, "full.rs11");
  const r11 = splitRecords(full11, 11).records;
  const r12 = splitRecords(full12, 12).records;
  let same = 0;
  for (let i = 1; i <= 21; i++)
    if (
      r11[i] !== undefined &&
      r12[i] !== undefined &&
      Buffer.from(r11[i].bytes).equals(Buffer.from(r12[i].bytes))
    )
      same++;
  ok(same === 21, `golden-12: full.rs12's seq 1-21 records are golden-11's bytes (${same} of 21)`);

  for (const kind of ["perturb-seed", "drop-restart"]) {
    const v11 = reframeSession(full11, (meta) => {
      meta.sabotage = { kind, frame: 1, op: null };
    });
    ok(
      (validateRecording(v11, 11)[0] ?? "").includes("legal only at /12"),
      `a /11 session declaring the /12-only sabotage kind ${kind} is rejected (meta-schema)`,
    );
    const v12 = reframeSession(full12, (meta) => {
      meta.sabotage = { kind, frame: 1, op: null };
    });
    const errors = validateRecording(v12, 12);
    ok(
      errors.length === 1 && errors[0].startsWith("end-stats-mismatch: "),
      `a /12 session declaring sabotage kind ${kind} is accepted (only the re-framed end stats differ; got ${JSON.stringify(errors)})`,
    );
  }
}

// The seq of the transaction an error names by its record offset ("record at offset N"), read
// straight from that record's meta (which may itself be the one decodeRecord refuses); null when
// the error names no transaction record.
function errorSeq(
  bytes: Uint8Array,
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13,
  error: string,
): number | null {
  const m = /record at offset (\d+)/.exec(error);
  if (m === null) return null;
  const raw = splitRecords(bytes, version).records.find(
    (r) => r.offset === Number(m[1]),
  );
  if (raw === undefined) return null;
  const metaLen = new DataView(
    raw.bytes.buffer,
    raw.bytes.byteOffset,
    raw.bytes.byteLength,
  ).getUint32(4, true);
  try {
    const meta = JSON.parse(
      Buffer.from(raw.bytes.subarray(8, 8 + metaLen)).toString("latin1"),
    ) as { type?: unknown; seq?: unknown };
    return meta.type === "transaction" && typeof meta.seq === "number"
      ? meta.seq
      : null;
  } catch {
    return null;
  }
}

/** TAG1: an index entry's item_meta ask as validateRecording's `itemMeta` option. */
function itemMetaAsk(
  ask: ItemMetaRequest | "none" | undefined,
): ItemMetaRequest | null | undefined {
  return ask === "none" ? null : ask;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Golden13Index {
  valid: Array<{ file: string; rs12: string }>;
  predict: {
    file: string;
    decoded: string;
    resolved: string;
    sha256: string;
    rs12: string;
    rs12_sha256: string;
    fulls: number[];
  };
  predict_trace: Record<string, Array<{ seq: number; units: unknown[] }>>;
  sabotage: {
    "predict-stale": { vector: string; code: string; seq: number };
    "no-predict-reset": {
      code: string;
      fails: Array<{ file: string; seq: number }>;
    };
  };
  /** TAG1: the valid item_meta lanes, each validated with its ask. */
  item_meta_valid: Array<{
    name: string;
    file: string;
    item_meta: ItemMetaRequest;
    sha256?: string;
    rs12?: string;
    dump?: unknown;
  }>;
}

/** TAG1: rs-core-check --item-meta-dump's JSON over a whole recording (TypeScript side). */
function itemMetaDumpOf(
  data: Uint8Array,
  ask: ItemMetaRequest | null | undefined,
): unknown {
  const split = splitRecords(data, 13);
  const v = createRecordingValidator(split.records, 13, { itemMeta: ask });
  if (v.errors) throw new Error(v.errors[0]);
  const seen = new Map<number, unknown>();
  let held: ItemMetaRecordMeta | null = null;
  let fulls = 0;
  let deltas = 0;
  for (let i = 1; i < split.records.length; i++) {
    const errors = v.accept(i);
    if (errors) throw new Error(errors[0]);
    const pending = v.itemMetaPending?.() ?? null;
    if (pending !== null) {
      held = pending;
      continue;
    }
    if (held !== null) {
      // The transaction after it was accepted (a record is followed by one, or the stream
      // fails orphan): the table now holds its rows.
      const t = v.itemMeta?.();
      if (t === undefined) throw new Error("no itemMeta accessor");
      if (held.form === "full") fulls++;
      else deltas++;
      for (const row of held.items)
        seen.set(
          row[0] as number,
          itemMetaRowJson(t, row.length === 1 ? null : row.slice(1)),
        );
      held = null;
    }
  }
  const finish = v.finish();
  if (finish.length > 0) throw new Error(finish[0]);
  const t = v.itemMeta?.();
  if (t === undefined) throw new Error("no itemMeta accessor");
  const byId = (m: Map<number, unknown>) =>
    Object.fromEntries([...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, r]) => [String(k), r]));
  return {
    grant: t.grant,
    strings: t.strings,
    rows: byId(
      new Map([...t.rows.entries()].map(([k, r]) => [k, itemMetaRowJson(t, r)])),
    ),
    seen: byId(seen),
    full_records: fulls,
    delta_records: deltas,
  };
}

// W13a (render-stream-13.md "As built (W13a)"): XXH64, the /12 <-> /13 transcode of every lane in
// both directions, the predict lane (decoded, validated, resolved against predict-resolved.json),
// the predict-stale encoder sabotage and the no-predict-reset decoder sabotage.
async function version13Cases(): Promise<void> {
  ok(
    xxh64Hex(new Uint8Array(0)) === "ef46db3751d8e999" &&
      xxh64Hex(new TextEncoder().encode("a")) === "d24ec4f1a98c6e5b",
    'golden-13: xxh64("") = ef46db3751d8e999 and xxh64("a") = d24ec4f1a98c6e5b',
  );
  const index = JSON.parse(
    await readFile(join(GOLDEN13_DIR, "index.json"), "utf8"),
  ) as Golden13Index;
  const lanes = [
    ...index.valid,
    { file: index.predict.file, rs12: index.predict.rs12 },
  ];
  for (const lane of lanes) {
    const rs13 = await readBytes(GOLDEN13_DIR, lane.file);
    const rs12 = await readBytes(GOLDEN13_DIR, lane.rs12);
    let down: Uint8Array | null = null;
    try {
      down = decodeRs13(rs13);
    } catch (error) {
      ok(false, `golden-13: decodeRs13(${lane.file}) threw ${String(error)}`);
    }
    if (down !== null)
      ok(
        sameBytes(down, rs12),
        `golden-13: decodeRs13(${lane.file}) is ${lane.rs12} byte for byte`,
      );
    const trace: NonNullable<Parameters<typeof encodeRs13>[1]>["trace"] = [];
    let up: Uint8Array | null = null;
    try {
      up = encodeRs13(rs12, { trace });
    } catch (error) {
      ok(false, `golden-13: encodeRs13(${lane.rs12}) threw ${String(error)}`);
    }
    if (up !== null)
      ok(
        sameBytes(up, rs13),
        `golden-13: encodeRs13(${lane.rs12}) is ${lane.file} byte for byte`,
      );
    const expectedTrace = index.predict_trace[lane.file];
    if (expectedTrace !== undefined)
      ok(
        isDeepStrictEqual(trace, expectedTrace),
        `golden-13: encodeRs13(${lane.rs12})'s predicted units and orders are index.json's predict_trace["${lane.file}"]`,
      );
  }

  // --- the predict lane: decoded, validated, resolved; its /12 twin resolves alike ------------
  const predict = index.predict;
  const p13 = await readBytes(GOLDEN13_DIR, predict.file);
  const p12 = await readBytes(GOLDEN13_DIR, predict.rs12);
  ok(
    sha256Hex(p13) === predict.sha256 && sha256Hex(p12) === predict.rs12_sha256,
    `golden-13: ${predict.file} and ${predict.rs12} hash to index.json's sha256s`,
  );
  const decoded = decodeRecording(p13, 13);
  ok(
    isDeepStrictEqual(
      decoded,
      JSON.parse(await readFile(join(GOLDEN13_DIR, predict.decoded), "utf8")),
    ),
    `golden-13: decodeRecording(${predict.file}) deep-equals ${predict.decoded}`,
  );
  ok(
    decoded.records.every((r) => recordSha256(p13, r.offset) === r.sha256),
    `golden-13: every ${predict.file} record's sha256 is its /13 bytes' (recordSha256)`,
  );
  const p12Decoded = decodeRecording(p12, 12);
  ok(
    decoded.records.length === p12Decoded.records.length &&
      decoded.records.every((r, i) =>
        isDeepStrictEqual(r.blocks, p12Decoded.records[i].blocks),
      ),
    `golden-13: decodeRecording(${predict.file})'s blocks are ${predict.rs12}'s (reconstructed /12 blocks)`,
  );
  const errors = validateRecording(p13, 13);
  ok(
    errors.length === 0,
    `golden-13: validateRecording(${predict.file}) is [] (got ${JSON.stringify(errors)})`,
  );
  ok(
    validateRecording(p12, 12).length === 0,
    `golden-13: validateRecording(${predict.rs12}, 12) is []`,
  );
  const expectedResolved = JSON.parse(
    await readFile(join(GOLDEN13_DIR, predict.resolved), "utf8"),
  );
  const resolved = resolveRecording(p13, 13);
  ok(
    resolved.schema === "render-stream-13-resolved/1" &&
      statesEqual(stripExcepted(resolved), expectedResolved),
    `golden-13: resolveRecording(${predict.file}) deep-equals ${predict.resolved} (excepted fields aside)`,
  );
  ok(
    resolved.transactions
      .filter((t) => t.encoding === "full")
      .map((t) => t.seq)
      .join(",") === predict.fulls.join(","),
    `golden-13: ${predict.file}'s full transactions are seqs ${predict.fulls.join(", ")}`,
  );
  const resolved12 = resolveRecording(p12, 12);
  ok(
    statesEqual(
      resolved12.transactions.map((t) => t.state),
      resolved.transactions.map((t) => t.state),
    ),
    `golden-13: resolveRecording(${predict.rs12}, 12) resolves to the same states`,
  );

  // --- the live validator, deferred digests: each digest is the /13 record's own ------------
  {
    const split = splitRecords(p13, 13);
    const validator = createRecordingValidator(split.records, 13, {
      recordDigest: "deferred",
    });
    let acceptErrors: string[] | undefined = validator.errors ?? undefined;
    for (let i = 1; i < split.records.length && !acceptErrors; i++)
      acceptErrors = validator.accept(i);
    ok(
      acceptErrors === undefined &&
        validator.finish().length === 0 &&
        split.records.every(
          (r, i) => validator.digest(i) === sha256Hex(r.bytes),
        ),
      `golden-13: createRecordingValidator(${predict.file}, deferred) accepts every record and digests the /13 bytes`,
    );
  }

  // --- TAG1: the valid item_meta lanes ---------------------------------------------------------
  for (const lane of index.item_meta_valid) {
    const bytes = await readBytes(GOLDEN13_DIR, lane.file);
    const asked = validateRecording(bytes, 13, { itemMeta: lane.item_meta });
    ok(
      asked.length === 0,
      `golden-13: ${lane.name}: validateRecording(${lane.file}, item_meta asked) is [] (got ${JSON.stringify(asked)})`,
    );
    const recording = validateRecording(bytes, 13);
    ok(
      recording.length === 0,
      `golden-13: ${lane.name}: validateRecording(${lane.file}) (a recording) is [] (got ${JSON.stringify(recording)})`,
    );
    if (lane.sha256 !== undefined)
      ok(
        sha256Hex(bytes) === lane.sha256,
        `golden-13: ${lane.name}: ${lane.file} hashes to its sha256`,
      );
    if (lane.dump !== undefined) {
      let dump: unknown = null;
      try {
        dump = itemMetaDumpOf(bytes, lane.item_meta);
      } catch (error) {
        dump = String(error);
      }
      ok(
        isDeepStrictEqual(dump, lane.dump),
        `golden-13: ${lane.name}: the item_meta table of ${lane.file} is index.json's dump (got ${JSON.stringify(dump).slice(0, 200)})`,
      );
    }
    if (lane.rs12 !== undefined) {
      const rs12 = await readBytes(GOLDEN13_DIR, lane.rs12);
      let down: Uint8Array | null = null;
      try {
        down = decodeRs13(bytes);
      } catch (error) {
        ok(false, `golden-13: ${lane.name}: decodeRs13(${lane.file}) threw ${String(error)}`);
      }
      if (down !== null)
        ok(
          sameBytes(down, rs12),
          `golden-13: ${lane.name}: decodeRs13(${lane.file}) drops its item_meta records: ${lane.rs12} byte for byte`,
        );
      // The decoded form holds the records (decodeRecording does not throw on them) and
      // resolves to the twin's states.
      let resolvedOk = false;
      try {
        const decodedLane = decodeRecording(bytes, 13);
        resolvedOk =
          decodedLane.records.some((r) => r.meta.type === "item_meta") &&
          statesEqual(
            resolveRecording(bytes, 13).transactions.map((t) => t.state),
            resolveRecording(rs12, 12).transactions.map((t) => t.state),
          );
      } catch (error) {
        ok(false, `golden-13: ${lane.name}: decode/resolve ${lane.file} threw ${String(error)}`);
      }
      ok(
        resolvedOk,
        `golden-13: ${lane.name}: decodeRecording(${lane.file}) keeps its item_meta records and resolveRecording matches ${lane.rs12}`,
      );
    }
  }
  // An item_meta record below /13 is an unknown record type.
  {
    const lane = index.item_meta_valid.find((l) => l.rs12 !== undefined);
    if (lane !== undefined) {
      const bytes = await readBytes(GOLDEN13_DIR, lane.file);
      const raw = splitRecords(bytes, 13).records.find(
        (r) =>
          Buffer.from(r.bytes.subarray(8, 28)).toString("latin1") ===
          '{"type":"item_meta",',
      );
      const errors =
        raw === undefined ? ["none found"] : decodeRecord(raw, 12).errors;
      ok(
        errors.length === 1 && errors[0].startsWith("meta-schema: "),
        `golden-13: an item_meta record decoded at /12 is meta-schema (unknown type) (got ${JSON.stringify(errors)})`,
      );
    }
  }

  // --- predict-stale (encoder sabotage) --------------------------------------------------------
  const staleEntry = index.sabotage["predict-stale"];
  const stale = encodeRs13(p12, { stale: true });
  ok(
    sameBytes(stale, await readBytes(GOLDEN13_DIR, staleEntry.vector)),
    `golden-13: encodeRs13(${predict.rs12}, { stale: true }) is ${staleEntry.vector} byte for byte`,
  );
  const staleErrors = validateRecording(stale, 13);
  ok(
    staleErrors.length === 1 &&
      staleErrors[0].startsWith(`${staleEntry.code}: `) &&
      errorSeq(stale, 13, staleErrors[0]) === staleEntry.seq,
    `golden-13: the predict-stale stream fails ${staleEntry.code} at seq ${staleEntry.seq} (got ${JSON.stringify(staleErrors)})`,
  );

  // --- no-predict-reset (decoder sabotage) -----------------------------------------------------
  const noReset = index.sabotage["no-predict-reset"];
  for (const fail of noReset.fails) {
    const bytes = await readBytes(GOLDEN13_DIR, fail.file);
    const sabotaged = validateRecording(bytes, 13, { noPredictReset: true });
    ok(
      sabotaged.length === 1 &&
        sabotaged[0].startsWith(`${noReset.code}: `) &&
        errorSeq(bytes, 13, sabotaged[0]) === fail.seq,
      `golden-13: validateRecording(${fail.file}, { noPredictReset }) fails ${noReset.code} at seq ${fail.seq} (got ${JSON.stringify(sabotaged)})`,
    );
    let threw = "";
    try {
      decodeRs13(bytes, { noPredictReset: true });
    } catch (error) {
      threw = (error as Error).message;
    }
    ok(
      threw === `${noReset.code}: seq ${fail.seq}`,
      `golden-13: decodeRs13(${fail.file}, { noPredictReset }) throws "${noReset.code}: seq ${fail.seq}" (got ${JSON.stringify(threw)})`,
    );
  }
}

async function helloCases(): Promise<void> {
  await helloCases9();
  await helloCases10();
  await helloCases11();
  await helloCases12();
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
