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
// -6.ts modules (G4e1: "Renaming files is not part of this contract").
// runSuite() below runs the same checks against golden-2 (version 2, unchanged), golden-3
// (version 3), golden-4 (version 4), golden-5 (version 5) and golden-6 (version 6); "renamed
// tests are not required" means the per-check messages below still say "rs2"-flavoured things
// like ".rs2"/".rs3"/".rs4"/".rs5"/".rs6" from `entry.file` itself, not from a hardcoded suffix.
//
// Checks, each required by the contract's G2b1 "Pass criteria" (and, for golden-3/-4/-5/-6, by
// G4e1, render-stream-4.md's G5w, render-stream-5.md's G55w and G6w):
//   - decodeRecording() deep-equals each of full/patch/inline.decoded.json;
//   - recordSha256() reproduces every record's sha256 in all three decoded forms;
//   - validateRecording() of all three valid vectors is [];
//   - resolveRecording() of all three deep-equals resolved.json (session_id/stream_id/per-
//     transaction "encoding" excepted, as /1), and its "resources" is [] for full/patch and
//     index.json's "inline_resources" for inline (checked separately: unlike the other fields,
//     this one is never shared ground truth -- it is genuinely stream-specific);
//   - golden-5 only: params.rs5 (the "params" shader-source policy) decodes,
//     validates clean and resolves to resolved-params.json -- its own independent leg, since it
//     is a separate small recording, not part of the shared resolved.json;
//   - golden-6 only: presentation.rs6, snap.rs6 and rate.rs6 (three
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
//   -: a /4 skip session (unknown_item_policy after sabotage,
//     unknown_items after unsupported in every transaction) validates and resolves with its
//     account; the key in a strict session, a skip transaction without it and any policy value
//     but "skip" are all meta-schema.
//   - golden-13 (W13a, render-stream-13.md "As built (W13a)"): runSuite at version 13 (every
//     invalid vector also at its listed seq), then version13Cases(): XXH64's test vectors, every
//     lane transcoded /13 -> /12 (decodeRs13) and /12 -> /13 (encodeRs13) byte for byte, the
//     predict lane against predict.decoded.json and predict-resolved.json, the predict-stale
//     encoder sabotage (= invalid/predict-stale.rs13) and the noPredictReset validator sabotage
//     (predict-check at predict.rs13 seq 7, patch.rs13 seq 16).
//   - golden-14 (ID3, render-stream-14.md): runSuite at version 14, then version14Cases(): every
//     lane and sabotage vector is its golden-13 twin re-stamped /14, the predict lane decodes and
//     resolves at /14, no-predict-reset at /14, the item_meta lanes (golden-13's v1 grant and the
//     v2 lane with instance_id / mouse_filter and re-stamps) validate, dump to their `dump` and
//     reach /12 through their /13 twin, a v2 grant below /14 is item-meta-schema, and a re-stamp
//     replaces the held row at receipt.
//   - golden-15 (render-stream-15.md): runSuite at version 15 (plus its hints lane: decoded,
//     validated, resolved, the hint set at the end, its /14 transcode valid at /14), then
//     version15Cases(): every golden-14 /14 vector re-stamped is its golden-15 vector, the
//     predict lane at /15, and hand-made streams for each hint code, hint placement, a fresh
//     hint against the whole state, and size_override's version gate, entry rule and
//     texture-version.
//   - golden-16 (render-stream-16.md): runSuite at version 16 (plus its viewports lane: decoded,
//     hashed, validated, resolved, no resources; the hints lane's rs14 is golden-15's), then
//     golden16Cases(): every golden-15 vector re-stamped /16 is its golden-16 vector and back down
//     (the re-stamp inserts or removes the session's "viewports" and moves the end stats), the
//     predict lane at /16; and version16Cases(), independent of golden-16: hand-made streams over
//     patch.rs15 re-stamped /16 for the session key, the table and its patches, viewport_f32 after
//     pt_f32 and alone, the two kinds, the three reasons, the derived entry through a proxy, the
//     resolved form, each new code, and the below-/16 and "viewports":"off" gates.
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
  itemMetaRequestProblem,
  itemMetaRowJson,
  multimeshBufferSha256,
  PARTICLE_EMIT_FLOAT_COUNT,
  particlesFloatCount,
  particlesFloatsByName,
  particlesFloatsInWireOrder,
  payloadSha256,
  RS13_ZR_MIN,
  recordSha256,
  resolveRecording,
  rs13ZrDecode,
  rs13ZrEncode,
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
const GOLDEN14_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-14");
const GOLDEN15_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-15");
const GOLDEN16_DIR = resolve(SCRIPT_DIR, "../../protocol/golden-16");

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
    version?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
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
  // golden-5 only: params.rs5's own independent leg.
  params_leg?: IndependentLeg;
  // golden-6 only: presentation.rs6/snap.rs6/rate.rs6's own independent legs (render-stream-6.md
  // "Golden vectors"), mirroring params_leg.
  presentation_leg?: IndependentLeg;
  snap_leg?: IndependentLeg;
  rate_leg?: IndependentLeg;
  // golden-7 only (render-stream-7.md "Golden vectors"): window2.rs7, the
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
  // golden-15 only (render-stream-15.md "Validators and golden vectors"): the hints lane.
  hints?: IndependentLeg & { rs14: string; hints_at_end: string[] };
  // golden-16 only (render-stream-16.md "Validators and golden vectors"): the viewports lane.
  viewports?: IndependentLeg;
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
// (2 for golden-2/, 3 for golden-3/ -- G4e1; 4 for golden-4/ -- render-stream-4.md
// G5w; 5 for golden-5/ -- render-stream-5.md G55w; 6 for golden-6/ -- render-stream-6.md G6w).
// The checks themselves are the same for all five: only the directory and the `version` argument
// threaded into decodeRecording()/validateRecording()/resolveRecording() differ.
async function runSuite(
  goldenDir: string,
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16,
): Promise<void> {
  const label = goldenDir.endsWith("golden-16")
    ? "golden-16"
    : goldenDir.endsWith("golden-15")
      ? "golden-15"
      : goldenDir.endsWith("golden-14")
        ? "golden-14"
        : goldenDir.endsWith("golden-13")
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
  // record, so golden-13's inline lane carries golden-12's inline_resources (and golden-14's, ID3).
  if (version >= 13 && index.inline_resources === undefined) {
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

  // --- independent legs: golden-5's params.rs5, golden-6's
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

  // --- golden-15's hints lane (render-stream-15.md): hints of each cause, an unhint, a later
  // transaction naming a hinted hash and a size override; its /14 transcode validates at /14 ---
  if (index.hints !== undefined) {
    const lane = index.hints;
    const bytes = await readBytes(goldenDir, lane.file);
    ok(
      sha256Hex(bytes) === lane.sha256,
      `${label}: ${lane.file} hashes to its listed sha256`,
    );
    let decoded: unknown = null;
    try {
      decoded = decodeRecording(bytes, version);
    } catch (error) {
      decoded = String(error);
    }
    ok(
      isDeepStrictEqual(
        decoded,
        JSON.parse(await readFile(join(goldenDir, lane.decoded), "utf8")),
      ),
      `${label}: decodeRecording(${lane.file}) deep-equals ${lane.decoded}`,
    );
    const errors = validateRecording(bytes, version);
    ok(
      errors.length === 0,
      `${label}: validateRecording(${lane.file}) is [] (got ${JSON.stringify(errors)})`,
    );
    let resolved: unknown = null;
    try {
      resolved = stripExcepted(resolveRecording(bytes, version));
    } catch (error) {
      resolved = String(error);
    }
    ok(
      statesEqual(
        resolved,
        JSON.parse(await readFile(join(goldenDir, lane.resolved), "utf8")),
      ),
      `${label}: resolveRecording(${lane.file}) deep-equals ${lane.resolved} (excepted fields aside)`,
    );
    const split = splitRecords(bytes, version);
    const v = createRecordingValidator(split.records, version);
    let failed: string[] | undefined = v.errors ?? undefined;
    for (let i = 1; i < split.records.length && failed === undefined; i++)
      failed = v.accept(i);
    const atEnd = [...(v.hints?.().keys() ?? [])].sort();
    ok(
      failed === undefined && isDeepStrictEqual(atEnd, lane.hints_at_end),
      `${label}: the hints in effect at the end of ${lane.file} are index.json's hints_at_end (got ${JSON.stringify(failed ?? atEnd)})`,
    );
    const rs14 = await readBytes(goldenDir, lane.rs14);
    const errors14 = validateRecording(rs14, 14);
    ok(
      errors14.length === 0,
      `${label}: ${lane.rs14} (transcode --to 14) validates at /14 (got ${JSON.stringify(errors14)})`,
    );
  }

  // --- golden-16's viewports lane (render-stream-16.md "Validators and golden vectors"): decoded,
  // hashed, validated clean and resolved, with no resource records ---
  if (index.viewports !== undefined) {
    const lane = index.viewports;
    const bytes = await readBytes(goldenDir, lane.file);
    ok(
      sha256Hex(bytes) === lane.sha256,
      `${label}: ${lane.file} hashes to its listed sha256`,
    );
    let decoded: unknown = null;
    try {
      decoded = decodeRecording(bytes, version);
    } catch (error) {
      decoded = String(error);
    }
    ok(
      isDeepStrictEqual(
        decoded,
        JSON.parse(await readFile(join(goldenDir, lane.decoded), "utf8")),
      ),
      `${label}: decodeRecording(${lane.file}) deep-equals ${lane.decoded}`,
    );
    const errors = validateRecording(bytes, version);
    ok(
      errors.length === 0,
      `${label}: validateRecording(${lane.file}) is [] (got ${JSON.stringify(errors)})`,
    );
    let resolved: ReturnType<typeof resolveRecording> | null = null;
    let threw: string | null = null;
    try {
      resolved = resolveRecording(bytes, version);
    } catch (error) {
      threw = String(error);
    }
    ok(
      resolved !== null &&
        statesEqual(
          stripExcepted(resolved),
          JSON.parse(await readFile(join(goldenDir, lane.resolved), "utf8")),
        ),
      `${label}: resolveRecording(${lane.file}) deep-equals ${lane.resolved} (excepted fields aside)${threw === null ? "" : ` (threw ${threw})`}`,
    );
    ok(
      resolved !== null && resolved.resources.length === 0,
      `${label}: resolveRecording(${lane.file}).resources is []`,
    );
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

  // ID3 (render-stream-14.md): golden-14, and a /14 decode refuses /13 and a /13 decode /14 (GRSE).
  await runSuite(GOLDEN14_DIR, 14);
  const full14 = await readBytes(GOLDEN14_DIR, "full.rs14");
  ok(
    validateRecording(full13, 14)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-13/full.rs13 decoded as version 14 is rejected with bad-magic",
  );
  ok(
    validateRecording(full14, 13)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-14/full.rs14 decoded as version 13 is rejected with bad-magic",
  );
  ok(
    Buffer.from(full14.subarray(0, 4)).toString("latin1") === "GRSE" &&
      wireVersionOf(full14) === 14,
    "golden-14/full.rs14 starts with GRSE, and wireVersionOf() reads it as 14",
  );
  await version14Cases();

  // render-stream-15.md: golden-15, and a /15 decode refuses /14 and a /14 decode /15 (GRSF).
  await runSuite(GOLDEN15_DIR, 15);
  const full15 = await readBytes(GOLDEN15_DIR, "full.rs15");
  ok(
    validateRecording(full14, 15)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-14/full.rs14 decoded as version 15 is rejected with bad-magic",
  );
  ok(
    validateRecording(full15, 14)[0]?.startsWith("bad-magic: ") ?? false,
    "golden-15/full.rs15 decoded as version 14 is rejected with bad-magic",
  );
  ok(
    Buffer.from(full15.subarray(0, 4)).toString("latin1") === "GRSF",
    "golden-15/full.rs15 starts with GRSF",
  );
  await version15Cases();

  // render-stream-16.md: golden-16, and a /16 decode refuses /15 and a /15 decode /16 (GRSG).
  let golden16 = true;
  try {
    await readFile(join(GOLDEN16_DIR, "index.json"), "utf8");
  } catch {
    golden16 = false;
  }
  ok(golden16, "golden-16/index.json exists");
  if (golden16) {
    await runSuite(GOLDEN16_DIR, 16);
    const full16 = await readBytes(GOLDEN16_DIR, "full.rs16");
    ok(
      validateRecording(full15, 16)[0]?.startsWith("bad-magic: ") ?? false,
      "golden-15/full.rs15 decoded as version 16 is rejected with bad-magic",
    );
    ok(
      validateRecording(full16, 15)[0]?.startsWith("bad-magic: ") ?? false,
      "golden-16/full.rs16 decoded as version 15 is rejected with bad-magic",
    );
    ok(
      Buffer.from(full16.subarray(0, 4)).toString("latin1") === "GRSG" &&
        wireVersionOf(full16) === 16,
      "golden-16/full.rs16 starts with GRSG, and wireVersionOf() reads it as 16",
    );
    await golden16Cases();
  }
  await version16Cases();

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

// The two optional keys, at /6 (the test encoder speaks /6 since G6b).
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
// render-stream-7.md "Hello": a minimal, self-contained hello checker for
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
    return [
      `"live_coding" ${JSON.stringify(liveCoding)} is not a comma list of [a-z0-9-] names`,
    ];
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
        checkHello11({ ...(parsed as object), live_coding: "zstd" }).length ===
          0,
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
  ok(
    checked === 13,
    `golden-11: full.rs11 carries 13 multimesh entries (got ${checked})`,
  );
  // UIT (render-stream-11.md "As built (UIT)"): item 18 resolves with use_identity_transform true
  // at 22 (right after copy_to_backbuffer) and without the key at 23, at either encoding.
  for (const name of ["full.rs11", "patch.rs11", "inline.rs11"]) {
    const r = resolveRecording(await readBytes(GOLDEN11_DIR, name), 11);
    const item18 = (seq: number) =>
      r.transactions
        .find((t) => t.seq === seq)
        ?.state.items.find((i) => i.id === 18);
    const at22 = item18(22);
    const keys = at22 ? Object.keys(at22) : [];
    ok(
      at22?.use_identity_transform === true &&
        keys[keys.indexOf("copy_to_backbuffer") + 1] ===
          "use_identity_transform",
      `golden-11: ${name} seq 22's item 18 resolves with use_identity_transform true after copy_to_backbuffer`,
    );
    const at23 = item18(23);
    ok(
      at23 !== undefined && !("use_identity_transform" in at23),
      `golden-11: ${name} seq 23's item 18 resolves without use_identity_transform`,
    );
  }
  const patch11 = resolveRecording(
    await readBytes(GOLDEN11_DIR, "patch.rs11"),
    11,
  );
  const mm2 = (seq: number) =>
    patch11.transactions
      .find((t) => t.seq === seq)
      ?.state.multimeshes?.find((m) => m.id === 2);
  const decodedPatch = decodeRecording(
    await readBytes(GOLDEN11_DIR, "patch.rs11"),
    11,
  );
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
        checkHello12({ ...(parsed as object), live_coding: "zstd" }).length ===
          0,
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
      for (const { entry, floats } of transactionParticles(
        meta,
        record.blocks,
      )) {
        const r = state?.particles?.find((p) => p.id === entry.id);
        const want = floats === null ? null : particlesFloatsByName(floats);
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
  ok(
    checked === 11 + 9,
    `golden-12: full.rs12 and patch.rs12 carry 20 particles entries (got ${checked})`,
  );
  const emitsBySeq = new Map<
    number,
    ReturnType<typeof transactionParticleEmits>
  >();
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
      isDeepStrictEqual(
        emits23[0].transform,
        [1, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0],
      ) &&
      isDeepStrictEqual(emits23[0].velocity, [0, -16, 0]) &&
      isDeepStrictEqual(emits23[0].color, [1, 1, 1, 1]) &&
      isDeepStrictEqual(emits23[0].custom, [0, 0, 0, 0]) &&
      isDeepStrictEqual(
        emits23[1].transform,
        [2, 0, 0, 0, 2, 0, 0, 0, 1, -8, 4, 0],
      ) &&
      isDeepStrictEqual(emits23[1].velocity, [0, -32, 0]) &&
      isDeepStrictEqual(emits23[1].color, [1, 0.5, 0.25, 1]) &&
      isDeepStrictEqual(emits23[1].custom, [0.5, 0, 0, 1]) &&
      emits23[1].emit.f - emits23[0].emit.f === PARTICLE_EMIT_FLOAT_COUNT,
    "golden-12: full.rs12 seq 23's two emits on emitter 1 carry the generator's floats",
  );
  ok(
    [...emitsBySeq].every(([seq, e]) => (seq === 23) === e.length > 0),
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
      isDeepStrictEqual(
        e1at24.floats.trail_poses[1],
        [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -4, 0],
      ),
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
  ok(
    same === 21,
    `golden-12: full.rs12's seq 1-21 records are golden-11's bytes (${same} of 21)`,
  );

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
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16,
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
  /** W13r: the zero-run token format's own cases (zero-runs.json). */
  zero_runs: { file: string; min_run: number; blocks: string[] };
  sabotage: {
    "predict-stale": { vector: string; code: string; seq: number };
    "zr-overrun": { vector: string; code: string; seq: number };
    "zr-short-run": { vector: string; code: string; seq: number };
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
    /** ID3 (golden-14): the lane's /13 stream (its transcode --to 13). */
    rs13?: string;
    dump?: unknown;
  }>;
}

/** TAG1: rs-core-check --item-meta-dump's JSON over a whole recording (TypeScript side). */
function itemMetaDumpOf(
  data: Uint8Array,
  ask: ItemMetaRequest | null | undefined,
  version: 13 | 14 | 15 | 16 = 13,
): unknown {
  const split = splitRecords(data, version);
  const v = createRecordingValidator(split.records, version, {
    itemMeta: ask,
  });
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
    Object.fromEntries(
      [...m.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([k, r]) => [String(k), r]),
    );
  return {
    grant: t.grant,
    strings: t.strings,
    rows: byId(
      new Map(
        [...t.rows.entries()].map(([k, r]) => [k, itemMetaRowJson(t, r)]),
      ),
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
        ok(
          false,
          `golden-13: ${lane.name}: decodeRs13(${lane.file}) threw ${String(error)}`,
        );
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
        ok(
          false,
          `golden-13: ${lane.name}: decode/resolve ${lane.file} threw ${String(error)}`,
        );
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

  // --- W13r writer sabotages zr-overrun / zr-short-run ----------------------------------------
  for (const [name, sabotage] of [
    ["zr-overrun", "overrun"],
    ["zr-short-run", "short-run"],
  ] as const) {
    const entry = index.sabotage[name];
    const bytes = encodeRs13(p12, { zrSabotage: sabotage });
    ok(
      sameBytes(bytes, await readBytes(GOLDEN13_DIR, entry.vector)),
      `golden-13: encodeRs13(${predict.rs12}, { zrSabotage: "${sabotage}" }) is ${entry.vector} byte for byte`,
    );
    const errors = validateRecording(bytes, 13);
    ok(
      errors.length === 1 &&
        errors[0].startsWith(`${entry.code}: `) &&
        errorSeq(bytes, 13, errors[0]) === entry.seq,
      `golden-13: the ${name} stream fails ${entry.code} at seq ${entry.seq} (got ${JSON.stringify(errors)})`,
    );
    let threw = "";
    try {
      decodeRs13(bytes);
    } catch (error) {
      threw = (error as Error).message;
    }
    ok(
      threw.startsWith(`${entry.code}: seq ${entry.seq}: `),
      `golden-13: decodeRs13(${name}) throws ${entry.code} at seq ${entry.seq} (got ${JSON.stringify(threw)})`,
    );
  }

  // --- W13r zero-runs.json: the token format alone -------------------------------------------
  {
    const zr = JSON.parse(
      await readFile(join(GOLDEN13_DIR, index.zero_runs.file), "utf8"),
    ) as {
      min_run: number;
      valid: Array<{ plain: string; coded: string }>;
      invalid: Array<{
        coded: string;
        length: number;
        code: string;
        description: string;
      }>;
    };
    ok(
      zr.min_run === RS13_ZR_MIN && index.zero_runs.min_run === RS13_ZR_MIN,
      `golden-13: zero-runs.json's min_run is ${RS13_ZR_MIN}`,
    );
    for (const c of zr.valid) {
      const plain = Buffer.from(c.plain, "hex");
      const coded = Buffer.from(c.coded, "hex");
      ok(
        sameBytes(rs13ZrEncode(plain), coded) &&
          sameBytes(rs13ZrDecode(coded, plain.length), plain),
        `golden-13: zero-runs.json valid ${c.plain.slice(0, 24)}… (${plain.length} B) codes and decodes`,
      );
    }
    for (const c of zr.invalid) {
      let got = "pass";
      try {
        rs13ZrDecode(Buffer.from(c.coded, "hex"), c.length);
      } catch (error) {
        got = (error as Error).message.split(":")[0];
      }
      ok(
        got === c.code,
        `golden-13: zero-runs.json invalid "${c.description}" is ${c.code} (got ${got})`,
      );
    }
  }

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

/** ID3: a /13 file re-stamped /14 (or back; render-stream-15.md: /15 too): the magic and the
 * session's protocol, every record keeping its length (render-stream-14.md). render-stream-16.md:
 * re-stamping up to /16 also inserts `,"viewports":"on"` as the session's last key before
 * "blocks", and down from /16 removes its `,"viewports":"<value>"`; the session record then moves
 * by that key's length, so the end record's bytes_total and max_record_bytes follow (a test
 * re-stamp, not a transcode). */
function restamp(
  data: Uint8Array,
  from: 13 | 14 | 15 | 16,
  to: 13 | 14 | 15 | 16,
): Uint8Array {
  const out = Uint8Array.from(data);
  out[3] = 0x44 + (to - 13);
  const enc = (v: number) =>
    new TextEncoder().encode(`"protocol":"render-stream/${v}"`);
  const old = Buffer.from(enc(from));
  const at = Buffer.from(out).indexOf(old);
  if (at < 0) throw new Error("no session protocol to re-stamp");
  out.set(enc(to), at);
  if (from >= 16 === to >= 16) return out;
  return restampViewportsKey(out, to >= 16);
}

/** The raw records of a recording (each with its length prefix), by framing alone. */
function rawFrames(data: Uint8Array): Uint8Array[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Uint8Array[] = [];
  let p = 8;
  while (p + 4 <= data.length) {
    const n = 4 + dv.getUint32(p, true);
    out.push(data.subarray(p, Math.min(p + n, data.length)));
    p += n;
  }
  return out;
}

/** render-stream-16.md "Validators and golden vectors": the session's `viewports` key inserted
 * ("on") or removed, and the end record's bytes_total and max_record_bytes moved with it. */
function restampViewportsKey(data: Uint8Array, insert: boolean): Uint8Array {
  const frames = rawFrames(data);
  const session = frames[0];
  const metaLen = new DataView(
    session.buffer,
    session.byteOffset,
    session.byteLength,
  ).getUint32(4, true);
  const text = Buffer.from(session.subarray(8, 8 + metaLen)).toString("latin1");
  let next: string;
  if (insert) {
    const k = text.lastIndexOf(',"blocks":[');
    if (k < 0) throw new Error("no session blocks key to re-stamp before");
    next = `${text.slice(0, k)},"viewports":"on"${text.slice(k)}`;
  } else {
    next = text.replace(/,"viewports":"[a-z]+"(?=,"blocks":\[)/, "");
    if (next === text) throw new Error("no session viewports key to remove");
  }
  const tail = Buffer.from(session.subarray(8 + metaLen));
  const head = Buffer.alloc(8);
  const metaBytes = Buffer.from(next, "latin1");
  head.writeUInt32LE(4 + metaBytes.length + tail.length, 0);
  head.writeUInt32LE(metaBytes.length, 4);
  const newSession = new Uint8Array(Buffer.concat([head, metaBytes, tail]));
  const delta = newSession.length - session.length;
  frames[0] = newSession;
  // The end record (the last one, when it decodes as one): bytes_total moves by the key's
  // length; max_record_bytes is the largest other record, the new session included.
  const last = frames.length - 1;
  let end: Record<string, unknown> | null = null;
  try {
    end = recordMeta(frames[last]);
  } catch {
    end = null;
  }
  if (end !== null && end.type === "end" && last > 0) {
    frames[last] = withRecordMeta(frames[last], (m) => {
      const stats = m.stats as Record<string, number>;
      const oldMax = stats.max_record_bytes;
      stats.bytes_total += delta;
      const others = frames.slice(1, last).map((r) => r.length);
      stats.max_record_bytes =
        oldMax === session.length || newSession.length > oldMax
          ? Math.max(newSession.length, ...others)
          : oldMax;
    });
  }
  return new Uint8Array(
    Buffer.concat([Buffer.from(data.subarray(0, 8)), ...frames]),
  );
}

interface Golden14Index extends Golden13Index {
  valid: Array<{ file: string; rs12: string; rs13: string }>;
  predict: Golden13Index["predict"] & { rs13: string };
  invalid: Array<{ file: string; code: string; version: number }>;
}

// ID3 (render-stream-14.md): golden-14 against golden-13 (re-stamped twins), the predict lane at
// /14, no-predict-reset at /14, the item_meta lanes (v1 and v2), a v2 grant below /14 and a
// re-stamp.
async function version14Cases(): Promise<void> {
  const index = JSON.parse(
    await readFile(join(GOLDEN14_DIR, "index.json"), "utf8"),
  ) as Golden14Index;
  const i13 = JSON.parse(
    await readFile(join(GOLDEN13_DIR, "index.json"), "utf8"),
  ) as Golden13Index & { invalid: Array<{ file: string }> };
  // --- every golden-13 vector re-stamped is its golden-14 vector ---------------------------------
  const pairs: Array<[string, string]> = [
    ...index.valid.map((l): [string, string] => [l.file, l.rs13]),
    [index.predict.file, index.predict.rs13],
    ...i13.invalid
      .filter((e) => !e.file.endsWith("bad-magic.rs13"))
      .map((e): [string, string] => [
        e.file.replace(/\.rs13$/, ".rs14"),
        `../golden-13/${e.file}`,
      ]),
  ];
  let restamped = 0;
  for (const [f14, f13] of pairs) {
    const a = await readBytes(GOLDEN14_DIR, f14);
    const b = await readBytes(GOLDEN14_DIR, f13);
    if (sameBytes(a, restamp(b, 13, 14))) restamped++;
    else ok(false, `golden-14: ${f14} is ${f13} re-stamped /14`);
  }
  ok(
    restamped === pairs.length && restamped > 50,
    `golden-14: ${restamped}/${pairs.length} vectors are their golden-13 twins re-stamped /14`,
  );
  // --- the predict lane decodes, validates and resolves at /14 ------------------------------------
  const p14 = await readBytes(GOLDEN14_DIR, index.predict.file);
  ok(
    sha256Hex(p14) === index.predict.sha256 &&
      isDeepStrictEqual(
        decodeRecording(p14, 14),
        JSON.parse(
          await readFile(join(GOLDEN14_DIR, index.predict.decoded), "utf8"),
        ),
      ) &&
      validateRecording(p14, 14).length === 0,
    `golden-14: ${index.predict.file} hashes to its sha256, decodes to ${index.predict.decoded} and validates`,
  );
  const presolved = resolveRecording(p14, 14);
  ok(
    presolved.schema === "render-stream-14-resolved/1" &&
      statesEqual(
        stripExcepted(presolved),
        JSON.parse(
          await readFile(join(GOLDEN14_DIR, index.predict.resolved), "utf8"),
        ),
      ),
    `golden-14: resolveRecording(${index.predict.file}) deep-equals ${index.predict.resolved}`,
  );
  // --- sabotages at /14 ------------------------------------------------------------------------
  for (const name of ["predict-stale", "zr-overrun", "zr-short-run"] as const) {
    const entry = index.sabotage[name];
    const bytes = await readBytes(GOLDEN14_DIR, entry.vector);
    const errors = validateRecording(bytes, 14);
    ok(
      errors.length === 1 &&
        errors[0].startsWith(`${entry.code}: `) &&
        errorSeq(bytes, 14, errors[0]) === entry.seq,
      `golden-14: ${entry.vector} fails ${entry.code} at seq ${entry.seq} (got ${JSON.stringify(errors)})`,
    );
  }
  const noReset = index.sabotage["no-predict-reset"];
  for (const fail of noReset.fails) {
    const bytes = await readBytes(GOLDEN14_DIR, fail.file);
    const sabotaged = validateRecording(bytes, 14, { noPredictReset: true });
    ok(
      sabotaged.length === 1 &&
        sabotaged[0].startsWith(`${noReset.code}: `) &&
        errorSeq(bytes, 14, sabotaged[0]) === fail.seq,
      `golden-14: validateRecording(${fail.file}, { noPredictReset }) fails ${noReset.code} at seq ${fail.seq} (got ${JSON.stringify(sabotaged)})`,
    );
  }
  // --- the item_meta lanes -----------------------------------------------------------------------
  for (const lane of index.item_meta_valid) {
    const bytes = await readBytes(GOLDEN14_DIR, lane.file);
    const asked = validateRecording(bytes, 14, { itemMeta: lane.item_meta });
    const recording = validateRecording(bytes, 14);
    ok(
      asked.length === 0 && recording.length === 0,
      `golden-14: ${lane.name}: validateRecording(${lane.file}) is [] asked and as a recording (got ${JSON.stringify([asked, recording])})`,
    );
    if (lane.sha256 !== undefined)
      ok(
        sha256Hex(bytes) === lane.sha256,
        `golden-14: ${lane.name}: ${lane.file} hashes to its sha256`,
      );
    if (lane.dump !== undefined) {
      let dump: unknown = null;
      try {
        dump = itemMetaDumpOf(bytes, lane.item_meta, 14);
      } catch (error) {
        dump = String(error);
      }
      ok(
        isDeepStrictEqual(dump, lane.dump),
        `golden-14: ${lane.name}: the item_meta table of ${lane.file} is index.json's dump (got ${JSON.stringify(dump).slice(0, 200)})`,
      );
    }
    if (lane.rs13 !== undefined && lane.rs12 !== undefined) {
      const rs13 = await readBytes(GOLDEN14_DIR, lane.rs13);
      const rs12 = await readBytes(GOLDEN14_DIR, lane.rs12);
      let down: Uint8Array | null = null;
      try {
        down = decodeRs13(rs13);
      } catch (error) {
        ok(
          false,
          `golden-14: ${lane.name}: decodeRs13(${lane.rs13}) threw ${String(error)}`,
        );
      }
      ok(
        validateRecording(rs13, 13).length === 0 &&
          down !== null &&
          sameBytes(down, rs12) &&
          statesEqual(
            resolveRecording(bytes, 14).transactions.map((t) => t.state),
            resolveRecording(rs12, 12).transactions.map((t) => t.state),
          ),
        `golden-14: ${lane.name}: ${lane.rs13} validates at /13 and transcodes to ${lane.rs12}, and ${lane.file} resolves to its states`,
      );
    }
  }
  // --- targeted: a v2 grant below /14; a re-stamp replaces the held row --------------------------
  const v2 = await readBytes(GOLDEN14_DIR, "item-meta-v2.rs14");
  const at13 = validateRecording(restamp(v2, 14, 13), 13);
  ok(
    at13.length === 1 &&
      at13[0].startsWith("item-meta-schema: ") &&
      at13[0].includes("grant: "),
    `golden-14: item-meta-v2.rs14 stamped /13 is item-meta-schema at its v2 grant (got ${JSON.stringify(at13)})`,
  );
  const v2req: ItemMetaRequest = {
    fields: ["class", "instance_id", "mouse_filter"],
    groups: [],
    meta_keys: [],
  };
  ok(
    itemMetaRequestProblem(v2req, 14) === null &&
      itemMetaRequestProblem(v2req, 13) !== null &&
      itemMetaRequestProblem(
        { ...v2req, fields: ["mouse_filter", "instance_id"] },
        14,
      ) !== null,
    "golden-14: the v2 fields are grantable at /14 only, after class, script, scene, path in order",
  );
  {
    const split = splitRecords(v2, 14);
    const v = createRecordingValidator(split.records, 14);
    const filter = new Map<number, unknown>();
    const restamps: string[] = [];
    for (let i = 1; i < split.records.length && !v.errors; i++) {
      const errors = v.accept(i);
      if (errors) {
        restamps.push(`error ${errors[0]}`);
        break;
      }
      const pending = v.itemMetaPending?.() ?? null;
      const t = v.itemMeta?.();
      if (pending !== null && pending.form === "delta" && t !== undefined)
        for (const row of pending.items)
          if (t.rows.has(row[0] as number)) restamps.push(String(row[0]));
      const raw = split.records[i].bytes;
      const metaLen = new DataView(raw.buffer, raw.byteOffset).getUint32(
        4,
        true,
      );
      const meta = JSON.parse(
        Buffer.from(raw.subarray(8, 8 + metaLen)).toString("latin1"),
      ) as { type: string; seq?: number };
      if (meta.type === "transaction" && t !== undefined) {
        const row = t.rows.get(7);
        filter.set(
          meta.seq ?? -1,
          row === undefined ? undefined : itemMetaRowJson(t, row),
        );
      }
    }
    const after = (seq: number) =>
      (filter.get(seq) as { mouse_filter?: unknown } | null | undefined)
        ?.mouse_filter;
    ok(
      restamps.join(",") === "7,1" && after(11) === 5 && after(12) === 4,
      `golden-14: the deltas before seqs 12 and 17 re-stamp items 7 and 1, and item 7's mouse_filter is 5 after seq 11 and 4 after seq 12 (got ${JSON.stringify([restamps, after(11), after(12)])})`,
    );
  }
}

// --------------------------------------------------------------------------------------- /15

/** A recording's records as byte arrays (magic dropped). */
function recordBytes(
  data: Uint8Array,
  version: 13 | 14 | 15 | 16,
): Uint8Array[] {
  return splitRecords(data, version).records.map((r) => r.bytes);
}

function recordMeta(rec: Uint8Array): Record<string, unknown> {
  const metaLen = new DataView(
    rec.buffer,
    rec.byteOffset,
    rec.byteLength,
  ).getUint32(4, true);
  return JSON.parse(
    Buffer.from(rec.subarray(8, 8 + metaLen)).toString("latin1"),
  ) as Record<string, unknown>;
}

/** `rec` with a mutated meta, its blocks untouched (canonical: JSON.stringify keeps key order). */
function withRecordMeta(
  rec: Uint8Array,
  mutate: (meta: Record<string, unknown>) => void,
): Uint8Array {
  const metaLen = new DataView(
    rec.buffer,
    rec.byteOffset,
    rec.byteLength,
  ).getUint32(4, true);
  const meta = recordMeta(rec);
  mutate(meta);
  const text = Buffer.from(JSON.stringify(meta), "latin1");
  const tail = Buffer.from(rec.subarray(8 + metaLen));
  const head = Buffer.alloc(8);
  head.writeUInt32LE(4 + text.length + tail.length, 0);
  head.writeUInt32LE(text.length, 4);
  return new Uint8Array(Buffer.concat([head, text, tail]));
}

/** A record with a JSON meta and no blocks (render-stream-15.md's hint records). */
function jsonRecord(meta: Record<string, unknown>): Uint8Array {
  const text = Buffer.from(JSON.stringify(meta), "latin1");
  const head = Buffer.alloc(8);
  head.writeUInt32LE(8 + text.length, 0);
  head.writeUInt32LE(text.length, 4);
  return new Uint8Array(Buffer.concat([head, text, Buffer.alloc(4)]));
}

/** A recording of `magic` and `recs` (session first, end last), the end record's bytes_total and
 * max_record_bytes recomputed. */
function assembleRecording(magic: Uint8Array, recs: Uint8Array[]): Uint8Array {
  const body = recs.slice(0, -1);
  const end = withRecordMeta(recs[recs.length - 1], (m) => {
    const stats = m.stats as Record<string, number>;
    stats.bytes_total = 8 + body.reduce((n, r) => n + r.length, 0);
    stats.max_record_bytes = Math.max(...body.map((r) => r.length));
  });
  return new Uint8Array(
    Buffer.concat([Buffer.from(magic.subarray(0, 8)), ...body, end]),
  );
}

/** The index of transaction `seq` in `recs`. */
function txIndex(recs: Uint8Array[], seq: number): number {
  const i = recs.findIndex((r) => {
    const m = recordMeta(r);
    return m.type === "transaction" && m.seq === seq;
  });
  if (i < 0) throw new Error(`no transaction seq ${seq}`);
  return i;
}

/** A texture entry with `size_override` right after `variants` (render-stream-15.md). */
function withSizeOverride(
  entry: Record<string, unknown>,
  size: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === "size_override") continue;
    out[k] = v;
    if (k === "variants") out.size_override = size;
  }
  return out;
}

function editTexture(
  rec: Uint8Array,
  id: number,
  fn: (t: Record<string, unknown>) => Record<string, unknown>,
): Uint8Array {
  return withRecordMeta(rec, (m) => {
    const list = m.textures as Array<Record<string, unknown>>;
    const k = list.findIndex((t) => t.id === id);
    if (k < 0) throw new Error(`no texture ${id} in seq ${String(m.seq)}`);
    list[k] = fn(list[k]);
  });
}

// render-stream-15.md: golden-15 against golden-14 (re-stamped twins), the predict lane at /15,
// and the /15 rules the golden vectors cannot show by themselves: hint placement, the codes over
// hand-made streams, and size_override's version gate, entry rule and texture-version.
async function version15Cases(): Promise<void> {
  const i14 = JSON.parse(
    await readFile(join(GOLDEN14_DIR, "index.json"), "utf8"),
  ) as Golden14Index & {
    item_meta_valid: Array<{ file: string }>;
  };
  // --- every golden-14 /14 vector re-stamped is its golden-15 vector ----------------------------
  const files14 = [
    ...i14.valid.map((l) => l.file),
    i14.predict.file,
    ...i14.item_meta_valid.map((l) => l.file),
    ...i14.invalid
      .map((e) => e.file)
      .filter((f) => f.endsWith(".rs14") && !f.endsWith("bad-magic.rs14")),
  ];
  const pairs = [...new Set(files14)];
  let restamped = 0;
  for (const f14 of pairs) {
    const f15 = f14.replace(/\.rs14$/, ".rs15");
    let a: Uint8Array | null = null;
    try {
      a = await readBytes(GOLDEN15_DIR, f15);
    } catch {
      a = null;
    }
    const b = await readBytes(GOLDEN14_DIR, f14);
    if (a !== null && sameBytes(a, restamp(b, 14, 15))) restamped++;
    else ok(false, `golden-15: ${f15} is golden-14's ${f14} re-stamped /15`);
  }
  ok(
    restamped === pairs.length && restamped > 60,
    `golden-15: ${restamped}/${pairs.length} vectors are their golden-14 twins re-stamped /15`,
  );
  const i15 = JSON.parse(
    await readFile(join(GOLDEN15_DIR, "index.json"), "utf8"),
  ) as Golden14Index;
  const p15 = await readBytes(GOLDEN15_DIR, i15.predict.file);
  const presolved = resolveRecording(p15, 15);
  ok(
    validateRecording(p15, 15).length === 0 &&
      presolved.schema === "render-stream-15-resolved/1" &&
      statesEqual(
        stripExcepted(presolved),
        JSON.parse(
          await readFile(join(GOLDEN15_DIR, i15.predict.resolved), "utf8"),
        ),
      ),
    `golden-15: ${i15.predict.file} validates and resolves to ${i15.predict.resolved}`,
  );

  // --- hand-made streams over golden-14's patch lane re-stamped /15 ------------------------------
  const patch15 = restamp(await readBytes(GOLDEN14_DIR, "patch.rs14"), 14, 15);
  const inline15 = restamp(
    await readBytes(GOLDEN14_DIR, "inline.rs14"),
    14,
    15,
  );
  const recs = recordBytes(patch15, 15);
  const magic = patch15.subarray(0, 8);
  const seq1 = recordMeta(recs[txIndex(recs, 1)]);
  const tex1 = (seq1.textures as Array<Record<string, unknown>>).find(
    (t) => t.id === 1,
  ) as Record<string, unknown>;
  const hintOf = (over: Record<string, unknown> = {}) => ({
    type: "resource_hint",
    hash: tex1.hash,
    kind: "texture",
    format: tex1.format,
    source_format: tex1.source_format,
    width: tex1.width,
    height: tex1.height,
    mipmaps: tex1.mipmaps,
    payload_bytes: tex1.payload_bytes,
    variants: tex1.variants,
    path: "res://icon.png",
    cause: "warm",
    priority: 0,
    blocks: [],
    ...over,
  });
  const hint = jsonRecord(hintOf());
  const unhint = (hash: unknown) =>
    jsonRecord({ type: "resource_unhint", hash, blocks: [] });
  const code = (data: Uint8Array, version: 14 | 15 = 15) => {
    const errors = validateRecording(data, version);
    return errors.length === 0 ? "ok" : errors[0].split(":")[0];
  };
  const last = recs.length - 1;
  const hinted = assembleRecording(magic, [
    recs[0],
    hint,
    ...recs.slice(1, last),
    unhint(tex1.hash),
    recs[last],
  ]);
  ok(
    code(hinted) === "ok",
    `golden-15: patch.rs15 with a warm hint of texture 1's hash after the session and its unhint after the last transaction validates (got ${JSON.stringify(validateRecording(hinted, 15))})`,
  );
  {
    const split = splitRecords(hinted, 15);
    const v = createRecordingValidator(split.records, 15);
    v.accept(1);
    const after1 = [...(v.hints?.().keys() ?? [])];
    ok(
      after1.length === 1 && after1[0] === tex1.hash,
      "golden-15: the validator's hint set holds the hash after the hint",
    );
  }
  ok(
    code(restamp(hinted, 15, 14), 14) === "meta-schema",
    "golden-15: a resource_hint below /15 is meta-schema",
  );
  ok(
    code(assembleRecording(magic, [recs[0], hint, hint, ...recs.slice(1)])) ===
      "hint-duplicate",
    "golden-15: a second hint of a hinted hash is hint-duplicate",
  );
  ok(
    code(
      assembleRecording(magic, [
        recs[0],
        hint,
        unhint(tex1.hash),
        hint,
        ...recs.slice(1),
      ]),
    ) === "ok",
    "golden-15: a hash may be hinted again after its unhint",
  );
  ok(
    code(
      assembleRecording(magic, [
        recs[0],
        unhint("ab".repeat(32)),
        ...recs.slice(1),
      ]),
    ) === "hint-unknown",
    "golden-15: an unhint of a hash that is not hinted is hint-unknown",
  );
  {
    const irecs = recordBytes(inline15, 15);
    ok(
      code(assembleRecording(magic, [irecs[0], hint, ...irecs.slice(1)])) ===
        "hint-inline",
      "golden-15: a hint in an inline-delivery session is hint-inline",
    );
  }
  ok(
    code(
      assembleRecording(magic, [
        recs[0],
        jsonRecord(hintOf({ width: 15 })),
        ...recs.slice(1),
      ]),
    ) === "hint-meta",
    "golden-15: a hint whose width differs from the entry a later transaction resolves is hint-meta",
  );
  {
    // Hinted after seq 1: seq 2 (a patch that does not carry texture 1) still resolves it.
    const at = txIndex(recs, 2);
    const data = assembleRecording(magic, [
      ...recs.slice(0, at),
      jsonRecord(hintOf({ width: 15 })),
      ...recs.slice(at),
    ]);
    const errors = validateRecording(data, 15);
    ok(
      code(data) === "hint-meta" && errorSeq(data, 15, errors[0]) === 2,
      `golden-15: a fresh hint is checked against the whole resolved state, not only the next transaction's entries (got ${JSON.stringify(errors)})`,
    );
  }
  ok(
    code(
      assembleRecording(magic, [
        recs[0],
        jsonRecord(hintOf({ cause: "game" })),
        ...recs.slice(1),
      ]),
    ) === "meta-schema" &&
      code(
        assembleRecording(magic, [
          recs[0],
          jsonRecord(hintOf({ path: "" })),
          ...recs.slice(1),
        ]),
      ) === "meta-schema",
    "golden-15: an unknown cause and an empty path are meta-schema",
  );
  // --- size_override ----------------------------------------------------------------------------
  const i1 = txIndex(recs, 1);
  const withOverride = (size: unknown, version: 14 | 15 = 15) => {
    const r = [...recs];
    r[i1] = editTexture(r[i1], 1, (t) => withSizeOverride(t, size));
    const data = assembleRecording(magic, r);
    return version === 15 ? data : restamp(data, 15, 14);
  };
  ok(
    code(withOverride([15, 16])) === "ok",
    `golden-15: texture 1 drawn at 15x16 (a size_override) at seq 1 validates (got ${JSON.stringify(validateRecording(withOverride([15, 16]), 15))})`,
  );
  {
    const resolved = resolveRecording(withOverride([15, 16]), 15);
    const t = resolved.transactions[1].state.textures.find((x) => x.id === 1);
    ok(
      isDeepStrictEqual(t?.size_override, [15, 16]) &&
        Object.keys(t ?? {}).indexOf("size_override") ===
          Object.keys(t ?? {}).indexOf("variants") + 1,
      "golden-15: the resolved texture keeps its size_override after variants through a patch that does not carry it",
    );
  }
  ok(
    code(withOverride([15, 16], 14), 14) === "meta-schema",
    "golden-15: a size_override below /15 is meta-schema",
  );
  ok(
    code(withOverride([16, 16])) === "texture-entry",
    "golden-15: a size_override equal to the payload's size is texture-entry",
  );
  ok(
    code(withOverride([0, 16])) === "meta-schema" &&
      code(withOverride([16385, 16])) === "meta-schema" &&
      code(withOverride([15])) === "meta-schema",
    "golden-15: a size_override outside 1..16384 or not a pair is meta-schema",
  );
  {
    const r = [...recs];
    r[i1] = editTexture(r[i1], 4, (t) => withSizeOverride(t, [4, 4]));
    ok(
      code(assembleRecording(magic, r)) === "texture-entry",
      "golden-15: a size_override on a placeholder is texture-entry",
    );
  }
  {
    // seq 3 updates texture 1 to version 2 (no override); full seq 5 re-sends version 2 with
    // one: a change at an equal version.
    const r = [...recs];
    const i5 = txIndex(r, 5);
    r[i5] = editTexture(r[i5], 1, (t) => withSizeOverride(t, [15, 16]));
    const data = assembleRecording(magic, r);
    const errors = validateRecording(data, 15);
    ok(
      code(data) === "texture-version" && errorSeq(data, 15, errors[0]) === 5,
      `golden-15: a size_override that appears at an unchanged version is texture-version at seq 5 (got ${JSON.stringify(errors)})`,
    );
  }
}

// --------------------------------------------------------------------------------------- /16

type Meta = Record<string, unknown>;

/** `rec` (a transaction) with a mutated meta and, when `vp` is given, its viewport_f32 replaced:
 * an array appends the block (after every other one), null drops it. Canonical: JSON.stringify
 * keeps key order. */
function editTx(
  rec: Uint8Array,
  mutate: (m: Meta) => void,
  vp?: number[] | null,
): Uint8Array {
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const metaLen = dv.getUint32(4, true);
  const meta = recordMeta(rec);
  let p = 8 + metaLen;
  const count = dv.getUint32(p, true);
  p += 4;
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const n = dv.getUint32(p, true);
    blocks.push(rec.subarray(p, p + 4 + n));
    p += 4 + n;
  }
  mutate(meta);
  if (vp !== undefined) {
    const descriptors = meta.blocks as Array<{ name: string }>;
    if (descriptors[descriptors.length - 1]?.name === "viewport_f32") {
      descriptors.pop();
      blocks.pop();
    }
    if (vp !== null) {
      descriptors.push({
        name: "viewport_f32",
        type: "f32",
        count: vp.length,
      } as {
        name: string;
      });
      const b = Buffer.alloc(4 + 4 * vp.length);
      b.writeUInt32LE(4 * vp.length, 0);
      for (let i = 0; i < vp.length; i++) b.writeFloatLE(vp[i], 4 + 4 * i);
      blocks.push(new Uint8Array(b));
    }
  }
  const text = Buffer.from(JSON.stringify(meta), "latin1");
  const countBytes = Buffer.alloc(4);
  countBytes.writeUInt32LE(blocks.length, 0);
  const tail = Buffer.concat([
    countBytes,
    ...blocks.map((b) => Buffer.from(b)),
  ]);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(4 + text.length + tail.length, 0);
  head.writeUInt32LE(text.length, 4);
  return new Uint8Array(Buffer.concat([head, text, tail]));
}

/** `m` with removed_viewports / viewports set (undefined drops the key), right before
 * predict_check (render-stream-16.md "The viewport table"). */
function setViewportKeys(
  m: Meta,
  removed: number[] | undefined,
  viewports: Meta[] | undefined,
): void {
  const out: Meta = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === "removed_viewports" || k === "viewports") continue;
    if (k === "predict_check") {
      if (removed !== undefined) out.removed_viewports = removed;
      if (viewports !== undefined) out.viewports = viewports;
    }
    out[k] = v;
  }
  for (const k of Object.keys(m)) delete m[k];
  Object.assign(m, out);
}

/** `m`'s textures with `entries` replacing (or inserting, ascending by id) the same ids. */
function putTextures(m: Meta, entries: Meta[]): void {
  const list = (m.textures as Meta[]).filter(
    (t) => !entries.some((e) => e.id === t.id),
  );
  list.push(...entries);
  list.sort((a, b) => (a.id as number) - (b.id as number));
  m.textures = list;
}

/** A /16 viewport or proxy texture entry, keys in wire order. */
function kindTexture(
  id: number,
  kind: "viewport" | "proxy",
  value: number | null,
  over: Meta = {},
): Meta {
  return {
    id,
    origin: "created",
    adopted_content: null,
    kind,
    status: "ok",
    reason: null,
    version: 1,
    hash: null,
    format: null,
    source_format: null,
    width: 0,
    height: 0,
    mipmaps: false,
    payload_bytes: 0,
    variants: [],
    [kind === "viewport" ? "viewport" : "target"]: value,
    canvas: null,
    ...over,
  };
}

/** An unsupported 4x4 RGBAF image texture entry, keys in wire order. */
function unsupportedImage(id: number, reason: string): Meta {
  const { target: _target, ...rest } = kindTexture(id, "proxy", null);
  return {
    ...rest,
    kind: "image",
    status: "unsupported",
    reason,
    format: "RGBAF",
    width: 4,
    height: 4,
  };
}

/** A viewport entry (render-stream-16.md "Viewport entry"), keys in wire order. */
function viewportEntry(over: Meta = {}): Meta {
  return {
    id: 1,
    origin: "created",
    parent: 0,
    active: true,
    active_seq: 1,
    size: [64, 32],
    transparent: false,
    update: "always",
    once_seq: 0,
    clear: "always",
    clear_seq: 0,
    disable_2d: false,
    renders_3d: false,
    hdr_2d: false,
    msaa_2d: 0,
    canvas_cull_mask: 4294967295,
    default_texture_filter: "linear",
    default_texture_repeat: "disabled",
    snap_2d: [false, false],
    canvases: [
      [1, 0, 0],
      [2, 1, 0],
    ],
    f: 0,
    ...over,
  };
}

/** Floats for viewport entries in order: a global transform, then one per canvases row. */
function viewportFloats(entries: Meta[]): number[] {
  const out: number[] = [];
  for (const e of entries) {
    out.push(1, 0, 0, 1, 2.5, 0);
    const rows = (e.canvases as unknown[]).length;
    for (let r = 0; r < rows; r++) out.push(1, 0, 0, 1, 10 * (r + 1), 4);
  }
  return out;
}

// render-stream-16.md: golden-16 against golden-15. Every golden-15 vector re-stamped /16 is its
// golden-16 vector, and every golden-16 one re-stamped back down is its golden-15 twin (each
// lane going down the chain); the predict lane at /16.
async function golden16Cases(): Promise<void> {
  const i15 = JSON.parse(
    await readFile(join(GOLDEN15_DIR, "index.json"), "utf8"),
  ) as Golden14Index & {
    item_meta_valid: Array<{ file: string }>;
    hints: { file: string };
    corrupt: Array<{ file: string }>;
  };
  const files15 = [
    ...i15.valid.map((l) => l.file),
    i15.predict.file,
    ...i15.item_meta_valid.map((l) => l.file),
    i15.hints.file,
    ...i15.corrupt.map((l) => l.file),
    ...i15.invalid
      .map((e) => e.file)
      .filter(
        (f) =>
          f.endsWith(".rs15") &&
          !f.startsWith("../") &&
          !f.endsWith("bad-magic.rs15"),
      ),
  ];
  const pairs = [...new Set(files15)];
  let up = 0;
  let down = 0;
  for (const f15 of pairs) {
    const f16 = f15.replace(/\.rs15$/, ".rs16");
    let a: Uint8Array | null = null;
    try {
      a = await readBytes(GOLDEN16_DIR, f16);
    } catch {
      a = null;
    }
    const b = await readBytes(GOLDEN15_DIR, f15);
    if (a !== null && sameBytes(a, restamp(b, 15, 16))) up++;
    else ok(false, `golden-16: ${f16} is golden-15's ${f15} re-stamped /16`);
    if (a !== null && sameBytes(restamp(a, 16, 15), b)) down++;
    else ok(false, `golden-16: ${f16} re-stamped /15 is golden-15's ${f15}`);
  }
  ok(
    up === pairs.length && down === pairs.length && up > 70,
    `golden-16: ${up}/${pairs.length} vectors are their golden-15 twins re-stamped /16, ${down} re-stamp back down to them`,
  );
  const i16 = JSON.parse(
    await readFile(join(GOLDEN16_DIR, "index.json"), "utf8"),
  ) as Golden14Index;
  const p16 = await readBytes(GOLDEN16_DIR, i16.predict.file);
  let presolved: ReturnType<typeof resolveRecording> | null = null;
  try {
    presolved = resolveRecording(p16, 16);
  } catch {
    presolved = null;
  }
  ok(
    validateRecording(p16, 16).length === 0 &&
      presolved !== null &&
      presolved.schema === "render-stream-16-resolved/1" &&
      statesEqual(
        stripExcepted(presolved),
        JSON.parse(
          await readFile(join(GOLDEN16_DIR, i16.predict.resolved), "utf8"),
        ),
      ),
    `golden-16: ${i16.predict.file} validates and resolves to ${i16.predict.resolved}`,
  );
}

// render-stream-16.md: the /16 rules over hand-made streams (golden-15's patch lane re-stamped
// /16, then a viewport, its texture and a proxy added from seq 22): the session key, the table and
// its patches, viewport_f32 (after pt_f32, and alone as block 9), the two kinds, the three
// session reasons, the derived entry through a proxy, the resolved form, and every new code and
// its below-/16 and "viewports":"off" gates. Independent of golden-16.
async function version16Cases(): Promise<void> {
  const patch15 = await readBytes(GOLDEN15_DIR, "patch.rs15");
  const patch16 = restamp(patch15, 15, 16);
  const magic = patch16.subarray(0, 8);
  const base = recordBytes(patch16, 16);
  const code = (data: Uint8Array, version: 15 | 16 = 16) => {
    const errors = validateRecording(data, version);
    return errors.length === 0 ? "ok" : errors[0].split(":")[0];
  };
  const at = (data: Uint8Array, version: 15 | 16 = 16) => {
    const errors = validateRecording(data, version);
    return errors.length === 0 ? null : errorSeq(data, version, errors[0]);
  };
  ok(
    code(patch16) === "ok" &&
      Buffer.from(patch16.subarray(0, 4)).toString("latin1") === "GRSG" &&
      wireVersionOf(patch16) === 16 &&
      sameBytes(restamp(patch16, 16, 15), patch15),
    `golden-16 (hand-made): golden-15's patch.rs15 re-stamped /16 ("viewports":"on") validates and re-stamps back (got ${JSON.stringify(validateRecording(patch16, 16))})`,
  );
  // --- the session key -----------------------------------------------------------------------
  const sessionWith = (fn: (m: Meta) => void, recs = base) =>
    assembleRecording(magic, [withRecordMeta(recs[0], fn), ...recs.slice(1)]);
  {
    const noKey = Uint8Array.from(patch15);
    noKey[3] = 0x47;
    const enc = (v: number) =>
      new TextEncoder().encode(`"protocol":"render-stream/${v}"`);
    noKey.set(enc(16), Buffer.from(noKey).indexOf(Buffer.from(enc(15))));
    ok(
      code(noKey) === "meta-schema",
      'golden-16 (hand-made): a /16 session without "viewports" is meta-schema',
    );
    ok(
      code(sessionWith((m) => (m.viewports = "yes"))) === "meta-schema",
      'golden-16 (hand-made): a session "viewports" other than on/off/unavailable is meta-schema',
    );
    ok(
      code(sessionWith((m) => (m.viewports = "off"))) === "ok" &&
        code(sessionWith((m) => (m.viewports = "unavailable"))) === "ok",
      'golden-16 (hand-made): "viewports":"off" and "unavailable" streams without viewport keys validate',
    );
  }

  // --- a stream with viewports ------------------------------------------------------------------
  interface Edit {
    mutate: (m: Meta) => void;
    vp?: number[] | null;
  }
  const build = (edits: Record<number, Edit>, recs = base): Uint8Array => {
    const r = [...recs];
    for (const [seq, e] of Object.entries(edits)) {
      const i = txIndex(r, Number(seq));
      r[i] = editTx(r[i], e.mutate, e.vp);
    }
    return assembleRecording(magic, r);
  };
  const vp1 = viewportEntry();
  const vp1Big = viewportEntry({ size: [128, 64] });
  const tex13 = kindTexture(13, "viewport", 1);
  const tex14 = kindTexture(14, "proxy", 13);
  const add = (
    viewports: Meta[],
    textures: Meta[],
    removed?: number[],
  ): Edit => ({
    mutate: (m) => {
      setViewportKeys(m, removed, viewports.length > 0 ? viewports : undefined);
      if (textures.length > 0) putTextures(m, textures);
    },
    vp: viewports.length > 0 ? viewportFloats(viewports) : undefined,
  });
  // VA: added at seq 22 (after pt_f32), resized at seq 25 (no pt_f32: viewport_f32 is block 9),
  // re-listed by the full at seq 26.
  const editsA = (over: Record<number, Edit> = {}) => ({
    22: add([vp1], [tex13, tex14]),
    25: add([vp1Big], []),
    26: add([vp1Big], [tex13, tex14]),
    ...over,
  });
  const va = build(editsA());
  ok(
    code(va) === "ok",
    `golden-16 (hand-made): a viewport, its texture and a proxy added at seq 22, resized at seq 25 and re-listed by the full at seq 26 validate (got ${JSON.stringify(validateRecording(va, 16))})`,
  );
  {
    const resolved = resolveRecording(va, 16);
    const decoded = decodeRecording(va, 16);
    const state = (seq: number) =>
      resolved.transactions.find((t) => t.seq === seq)
        ?.state as unknown as Meta;
    const vps = (seq: number) => state(seq)?.viewports as Meta[] | undefined;
    const keys = Object.keys(vps(22)?.[0] ?? {});
    const stateKeys = Object.keys(state(22) ?? {});
    const floats = vps(22)?.[0]?.floats as Meta | undefined;
    ok(
      resolved.schema === "render-stream-16-resolved/1" &&
        decoded.schema === "render-stream-16-decoded/1" &&
        vps(21) === undefined &&
        stateKeys[stateKeys.length - 1] === "viewports" &&
        stateKeys.indexOf("viewports") === stateKeys.indexOf("particles") + 1 &&
        isDeepStrictEqual(keys, [
          ...Object.keys(vp1).filter((k) => k !== "f"),
          "floats",
        ]) &&
        isDeepStrictEqual(floats, {
          global_xform: [1, 0, 0, 1, 2.5, 0],
          canvas_xforms: [
            [1, 0, 0, 1, 10, 4],
            [1, 0, 0, 1, 20, 4],
          ],
        }) &&
        isDeepStrictEqual(vps(24)?.[0]?.size, [64, 32]) &&
        isDeepStrictEqual(vps(25)?.[0]?.size, [128, 64]) &&
        isDeepStrictEqual(vps(26)?.[0]?.size, [128, 64]),
      `golden-16 (hand-made): the resolved form carries "viewports" right after "particles" from seq 22 (entry fields in wire order without f, then floats), carried by patches and resized at seq 25`,
    );
    const t14 = (state(23)?.textures as Meta[]).find((t) => t.id === 14) ?? {};
    const tk = Object.keys(t14);
    ok(
      t14.target === 13 && tk.indexOf("target") === tk.indexOf("variants") + 1,
      "golden-16 (hand-made): a resolved proxy texture carries target after variants, as the wire",
    );
  }
  // VB: removed at seq 25 with its texture freed; the proxy keeps the tombstone as target.
  const tex13Freed = kindTexture(13, "viewport", 1, {
    status: "freed",
    version: 2,
  });
  const editsB = (over: Record<number, Edit> = {}) => ({
    22: add([vp1], [tex13, tex14]),
    25: add([], [tex13Freed], [1]),
    26: add([], [tex13Freed, tex14]),
    ...over,
  });
  const vb = build(editsB());
  ok(
    code(vb) === "ok",
    `golden-16 (hand-made): removing the viewport at seq 25 with its texture freed, the proxy keeping the tombstone, validates (got ${JSON.stringify(validateRecording(vb, 16))})`,
  );
  {
    const resolved = resolveRecording(vb, 16);
    const s25 = resolved.transactions.find((t) => t.seq === 25)
      ?.state as unknown as Meta;
    ok(
      s25 !== undefined && !("viewports" in s25),
      'golden-16 (hand-made): the resolved state drops "viewports" once the table is empty',
    );
  }

  // --- below /16, and under "viewports":"off" ----------------------------------------------------
  ok(
    code(restamp(va, 16, 15), 15) === "meta-schema",
    "golden-16 (hand-made): the viewport stream re-stamped /15 is meta-schema",
  );
  {
    const proxyOnly = build({ 22: add([], [kindTexture(13, "proxy", 1)]) });
    const reason3d = build({
      22: {
        mutate: (m) =>
          (m.unsupported as Meta[]).unshift({
            op: "viewport_attach_camera",
            item: null,
            reason: "viewport-3d",
          }),
      },
    });
    ok(
      code(proxyOnly) === "ok" && code(reason3d) === "ok",
      `golden-16 (hand-made): a proxy alone, and a viewport-3d entry, validate under "on" (got ${JSON.stringify([validateRecording(proxyOnly, 16), validateRecording(reason3d, 16)])})`,
    );
    ok(
      code(restamp(proxyOnly, 16, 15), 15) === "meta-schema" &&
        code(restamp(reason3d, 16, 15), 15) === "meta-schema",
      "golden-16 (hand-made): a proxy texture, and a viewport-3d entry, below /16 are meta-schema",
    );
    const off = (data: Uint8Array) => {
      const recs = recordBytes(data, 16);
      return assembleRecording(magic, [
        withRecordMeta(recs[0], (m) => (m.viewports = "off")),
        ...recs.slice(1),
      ]);
    };
    const vpOnly = build({ 22: { mutate: () => {}, vp: [1, 0, 0, 1, 0, 0] } });
    ok(
      code(off(va)) === "meta-schema" &&
        code(off(proxyOnly)) === "meta-schema" &&
        code(off(reason3d)) === "meta-schema" &&
        code(off(vpOnly)) === "meta-schema",
      'golden-16 (hand-made): under "viewports":"off" the viewport keys, a proxy, a viewport-* reason and viewport_f32 are each meta-schema',
    );
    const unresolvedImage = build({
      22: add([], [unsupportedImage(15, "proxy-unresolved")]),
    });
    ok(
      code(unresolvedImage) === "texture-entry" &&
        code(off(unresolvedImage)) === "meta-schema",
      'golden-16 (hand-made): reason "proxy-unresolved" on an image is texture-entry under "on" and meta-schema under "off"',
    );
    {
      // A viewport needs a session adoption to be "adopted" (adoption-entry, as every table): the
      // stream with every other adopted entry made "created" and the session's adoption null.
      const unadopt = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(unadopt);
        else if (v !== null && typeof v === "object") {
          const o = v as Meta;
          if (o.origin === "adopted") {
            o.origin = "created";
            if ("adopted_content" in o) o.adopted_content = null;
          }
          for (const x of Object.values(o)) unadopt(x);
        }
      };
      const noAdoption = (recs: Uint8Array[]) =>
        assembleRecording(magic, [
          withRecordMeta(recs[0], (m) => (m.adoption = null)),
          ...recs
            .slice(1, -1)
            .map((r) =>
              recordMeta(r).type === "transaction" ? editTx(r, unadopt) : r,
            ),
          recs[recs.length - 1],
        ]);
      const baseline = noAdoption(base);
      const adopted = build(
        editsA({
          22: add([viewportEntry({ origin: "adopted" })], [tex13, tex14]),
        }),
        recordBytes(baseline, 16),
      );
      const first = validateRecording(adopted, 16)[0] ?? "";
      ok(
        code(baseline) === "ok" &&
          first.startsWith("adoption-entry: ") &&
          /viewport 1 has origin "adopted"/.test(first) &&
          at(adopted) === 22,
        `golden-16 (hand-made): an adopted viewport in a session without adoption is adoption-entry at seq 22 (got ${JSON.stringify([validateRecording(baseline, 16)[0] ?? null, first])})`,
      );
    }
    ok(
      code(vpOnly) === "viewport-offset" && at(vpOnly) === 22,
      'golden-16 (hand-made): a viewport_f32 without "viewports" is viewport-offset at seq 22',
    );
  }

  // --- meta-schema on the table and the kinds ----------------------------------------------------
  const cases: Array<[string, Record<number, Edit>, string, number | null]> = [
    [
      "an empty viewports",
      { 22: { mutate: (m) => setViewportKeys(m, undefined, []) } },
      "meta-schema",
      22,
    ],
    [
      "an empty removed_viewports",
      editsB({ 25: { mutate: (m) => setViewportKeys(m, [], undefined) } }),
      "meta-schema",
      25,
    ],
    [
      "a viewport entry's keys out of order",
      editsA({
        22: add(
          [
            Object.fromEntries(
              Object.entries(vp1).sort(([a], [b]) =>
                a === "active" ? -1 : b === "active" ? 1 : 0,
              ),
            ),
          ],
          [tex13, tex14],
        ),
      }),
      "meta-schema",
      22,
    ],
    [
      "a viewport entry missing a key",
      editsA({
        22: add(
          [
            Object.fromEntries(
              Object.entries(vp1).filter(([k]) => k !== "hdr_2d"),
            ),
          ],
          [tex13, tex14],
        ),
      }),
      "meta-schema",
      22,
    ],
    [
      'a "viewport" key on an image',
      editsA({
        22: add(
          [vp1],
          [
            tex13,
            tex14,
            {
              ...kindTexture(15, "viewport", 1),
              kind: "image",
              status: "unsupported",
              reason: "unsupported-format",
            },
          ],
        ),
      }),
      "meta-schema",
      22,
    ],
    [
      "a proxy without its target key",
      editsA({
        22: add(
          [vp1],
          [
            tex13,
            Object.fromEntries(
              Object.entries(tex14).filter(([k]) => k !== "target"),
            ),
          ],
        ),
      }),
      "meta-schema",
      22,
    ],
    [
      "removed_viewports not ascending",
      editsB({
        22: add(
          [vp1, viewportEntry({ id: 2, f: 18 })],
          [tex13, tex14, kindTexture(15, "viewport", 2)],
        ),
        25: add(
          [],
          [
            tex13Freed,
            kindTexture(15, "viewport", 2, { status: "freed", version: 2 }),
          ],
          [2, 1],
        ),
        26: add(
          [],
          [
            tex13Freed,
            tex14,
            kindTexture(15, "viewport", 2, { status: "freed", version: 2 }),
          ],
        ),
      }),
      "meta-schema",
      25,
    ],
    // --- viewport-entry ---
    [
      'a default_texture_filter "default"',
      editsA({
        22: add(
          [viewportEntry({ default_texture_filter: "default" })],
          [tex13, tex14],
        ),
      }),
      "viewport-entry",
      22,
    ],
    [
      "an msaa_2d of 4",
      editsA({ 22: add([viewportEntry({ msaa_2d: 4 })], [tex13, tex14]) }),
      "viewport-entry",
      22,
    ],
    [
      "a negative size",
      editsA({ 22: add([viewportEntry({ size: [-1, 32] })], [tex13, tex14]) }),
      "viewport-entry",
      22,
    ],
    [
      'an update "sometimes"',
      editsA({
        22: add([viewportEntry({ update: "sometimes" })], [tex13, tex14]),
      }),
      "viewport-entry",
      22,
    ],
    [
      "viewports not ascending by id",
      editsA({
        22: add(
          [viewportEntry({ id: 2 }), viewportEntry({ id: 1, f: 18 })],
          [tex13, tex14, kindTexture(15, "viewport", 2)],
        ),
      }),
      "viewport-entry",
      22,
    ],
    [
      "canvases rows not ascending",
      editsA({
        22: add(
          [
            viewportEntry({
              canvases: [
                [2, 1, 0],
                [1, 0, 0],
              ],
            }),
          ],
          [tex13, tex14],
        ),
      }),
      "viewport-entry",
      22,
    ],
    [
      "a canvases row naming no canvas",
      editsA({
        22: add(
          [viewportEntry({ canvases: [[9, 0, 0]], f: 0 })],
          [tex13, tex14],
        ),
      }),
      "viewport-entry",
      22,
    ],
    [
      "a parent naming no viewport",
      editsA({ 22: add([viewportEntry({ parent: 7 })], [tex13, tex14]) }),
      "viewport-entry",
      22,
    ],
    [
      "a viewport without an ok viewport texture",
      editsA({ 22: add([vp1], [kindTexture(14, "proxy", 4)]) }),
      "viewport-entry",
      22,
    ],
    [
      "a viewport with two ok viewport textures",
      editsA({
        22: add([vp1], [tex13, tex14, kindTexture(15, "viewport", 1)]),
      }),
      "viewport-entry",
      22,
    ],
    // --- viewport-parent-cycle ---
    [
      "a viewport that is its own parent",
      editsA({ 22: add([viewportEntry({ parent: 1 })], [tex13, tex14]) }),
      "viewport-parent-cycle",
      22,
    ],
    [
      "two viewports parenting each other",
      editsA({
        22: add(
          [
            viewportEntry({ parent: 2 }),
            viewportEntry({ id: 2, parent: 1, f: 18 }),
          ],
          [tex13, tex14, kindTexture(15, "viewport", 2)],
        ),
      }),
      "viewport-parent-cycle",
      22,
    ],
    // --- viewport-offset ---
    [
      "an f off the running count",
      editsA({ 22: add([viewportEntry({ f: 1 })], [tex13, tex14]) }),
      "viewport-offset",
      22,
    ],
    [
      "a viewport_f32 shorter than the claim",
      editsA({
        22: {
          ...add([vp1], [tex13, tex14]),
          vp: viewportFloats([vp1]).slice(6),
        },
      }),
      "viewport-offset",
      22,
    ],
    [
      "viewports without viewport_f32",
      editsA({ 22: { ...add([vp1], [tex13, tex14]), vp: undefined } }),
      "viewport-offset",
      22,
    ],
    // --- texture-entry ---
    [
      "an unsupported viewport texture",
      editsA({
        22: add(
          [vp1],
          [
            tex13,
            tex14,
            kindTexture(15, "viewport", 1, {
              status: "unsupported",
              reason: "proxy-unresolved",
            }),
          ],
        ),
      }),
      "texture-entry",
      22,
    ],
    [
      "proxy-unresolved on an image",
      editsA({
        22: add(
          [vp1],
          [tex13, tex14, unsupportedImage(15, "proxy-unresolved")],
        ),
      }),
      "texture-entry",
      22,
    ],
    [
      "an unsupported proxy with another reason",
      editsA({
        22: add(
          [vp1],
          [
            tex13,
            kindTexture(14, "proxy", null, {
              status: "unsupported",
              reason: "unsupported-format",
            }),
          ],
        ),
      }),
      "texture-entry",
      22,
    ],
    [
      "a viewport texture with a variant",
      editsA({
        22: add(
          [vp1],
          [
            kindTexture(13, "viewport", 1, {
              variants: [
                {
                  encoding: "block",
                  hash: "ab".repeat(32),
                  payload_bytes: 16,
                  format: "BPTC_RGBA",
                  params: null,
                },
              ],
            }),
            tex14,
          ],
        ),
      }),
      "texture-entry",
      22,
    ],
    [
      "a viewport texture with a width",
      editsA({
        22: add([vp1], [kindTexture(13, "viewport", 1, { width: 64 }), tex14]),
      }),
      "texture-entry",
      22,
    ],
    // --- texture-ref ---
    [
      "an ok viewport texture naming no viewport",
      editsA({
        22: add([vp1], [tex13, tex14, kindTexture(15, "viewport", 9)]),
      }),
      "texture-ref",
      22,
    ],
    // --- proxy-target ---
    [
      "an ok proxy with a null target",
      editsA({ 22: add([vp1], [tex13, kindTexture(14, "proxy", null)]) }),
      "proxy-target",
      22,
    ],
    [
      "an ok proxy naming no entry",
      editsA({ 22: add([vp1], [tex13, kindTexture(14, "proxy", 99)]) }),
      "proxy-target",
      22,
    ],
    [
      "an ok proxy of a proxy",
      editsA({
        22: add([vp1], [tex13, tex14, kindTexture(15, "proxy", 14)]),
      }),
      "proxy-target",
      22,
    ],
    [
      "an unsupported proxy with a target",
      editsA({
        22: add(
          [vp1],
          [
            tex13,
            kindTexture(14, "proxy", 13, {
              status: "unsupported",
              reason: "proxy-unresolved",
            }),
          ],
        ),
      }),
      "proxy-target",
      22,
    ],
    // --- unsupported-mismatch ---
    [
      "a viewport-hdr-2d entry with another op",
      {
        22: {
          mutate: (m) =>
            (m.unsupported as Meta[]).unshift({
              op: "viewport_attach_camera",
              item: null,
              reason: "viewport-hdr-2d",
            }),
        },
      },
      "unsupported-mismatch",
      22,
    ],
    [
      'a non-root-viewport entry under "on"',
      {
        22: {
          mutate: (m) =>
            (m.unsupported as Meta[]).unshift({
              op: "viewport_set_parent_viewport",
              item: null,
              reason: "non-root-viewport",
            }),
        },
      },
      "unsupported-mismatch",
      22,
    ],
    [
      "a proxy of an ok image where an unsupported texture was drawn",
      {
        22: add([], [kindTexture(3, "proxy", 1, { version: 2 })]),
        26: add([], [kindTexture(3, "proxy", 1, { version: 2 })]),
      },
      "unsupported-mismatch",
      22,
    ],
    // --- patch rules, ids, adoption ---
    [
      "a removed viewport absent from the base",
      editsB({ 25: add([], [tex13Freed], [5]) }),
      "patch-removed",
      25,
    ],
    [
      "a viewport both removed and present",
      editsB({ 25: add([vp1], [tex13Freed], [1]) }),
      "patch-removed",
      25,
    ],
    [
      "removed_viewports in a full transaction",
      editsA({ 26: add([vp1Big], [tex13, tex14], [1]) }),
      "patch-encoding",
      26,
    ],
    [
      "a removed viewport id listed again",
      editsB({
        26: add([vp1], [tex13Freed, tex14, kindTexture(15, "viewport", 1)]),
      }),
      "id-reused",
      26,
    ],
    [
      'an adopted viewport texture with adopted_content "creation"',
      editsA({
        22: add(
          [vp1],
          [
            kindTexture(13, "viewport", 1, {
              origin: "adopted",
              adopted_content: "creation",
            }),
            tex14,
          ],
        ),
      }),
      "adoption-entry",
      22,
    ],
  ];
  for (const [what, edits, want, seq] of cases) {
    const data = build(edits);
    const got = code(data);
    const gotSeq = at(data);
    ok(
      got === want && (seq === null || gotSeq === seq),
      `golden-16 (hand-made): ${what} is ${want}${seq === null ? "" : ` at seq ${seq}`} (got ${got} at ${gotSeq}: ${JSON.stringify(validateRecording(data, 16)[0] ?? null)})`,
    );
  }

  // --- valid edges --------------------------------------------------------------------------------
  const valid: Array<[string, Record<number, Edit>]> = [
    [
      "a proxy of a freed tombstone (texture 10)",
      editsA({
        22: add([vp1], [tex13, kindTexture(14, "proxy", 10)]),
        26: add([vp1Big], [tex13, kindTexture(14, "proxy", 10)]),
      }),
    ],
    [
      "an unsupported proxy (proxy-unresolved, target null)",
      editsA({
        22: add(
          [vp1],
          [
            tex13,
            kindTexture(14, "proxy", null, {
              status: "unsupported",
              reason: "proxy-unresolved",
            }),
          ],
        ),
        26: add(
          [vp1Big],
          [
            tex13,
            kindTexture(14, "proxy", null, {
              status: "unsupported",
              reason: "proxy-unresolved",
            }),
          ],
        ),
      }),
    ],
    [
      "a nested viewport (parent 1) and one out of the tree (parent null)",
      editsA({
        22: add(
          [
            vp1,
            viewportEntry({ id: 2, parent: 1, f: 18 }),
            viewportEntry({ id: 3, parent: null, canvases: [], f: 36 }),
          ],
          [
            tex13,
            tex14,
            kindTexture(15, "viewport", 2),
            kindTexture(16, "viewport", 3),
          ],
        ),
        25: add([], []),
        26: add(
          [
            vp1,
            viewportEntry({ id: 2, parent: 1, f: 18 }),
            viewportEntry({ id: 3, parent: null, canvases: [], f: 36 }),
          ],
          [
            tex13,
            tex14,
            kindTexture(15, "viewport", 2),
            kindTexture(16, "viewport", 3),
          ],
        ),
      }),
    ],
    [
      "an adopted viewport and its adopted texture (adopted_content current)",
      editsA({
        22: add(
          [viewportEntry({ origin: "adopted" })],
          [
            kindTexture(13, "viewport", 1, {
              origin: "adopted",
              adopted_content: "current",
            }),
            tex14,
          ],
        ),
        25: add([viewportEntry({ origin: "adopted", size: [128, 64] })], []),
        26: add(
          [viewportEntry({ origin: "adopted", size: [128, 64] })],
          [
            kindTexture(13, "viewport", 1, {
              origin: "adopted",
              adopted_content: "current",
            }),
            tex14,
          ],
        ),
      }),
    ],
    [
      "a canvas texture whose diffuse names a proxy, and one whose diffuse names a viewport",
      editsA({
        22: add(
          [vp1],
          [
            tex13,
            tex14,
            {
              ...kindTexture(15, "proxy", 1),
              kind: "canvas",
              target: undefined,
              canvas: { diffuse: 14, filter: "default", repeat: "default" },
            },
          ].map((t) => JSON.parse(JSON.stringify(t)) as Meta),
        ),
      }),
    ],
    [
      "the derived unsupported-texture through a proxy of an unsupported image",
      {
        22: add(
          [],
          [
            kindTexture(3, "proxy", 15, { version: 2 }),
            unsupportedImage(15, "unsupported-format"),
          ],
        ),
        26: add(
          [],
          [
            kindTexture(3, "proxy", 15, { version: 2 }),
            unsupportedImage(15, "unsupported-format"),
          ],
        ),
      },
    ],
    [
      "a viewport-3d, viewport-hdr-2d and viewport-msaa-2d entry with their ops",
      {
        22: {
          mutate: (m) =>
            (m.unsupported as Meta[]).unshift(
              {
                op: "viewport_attach_camera",
                item: null,
                reason: "viewport-3d",
              },
              {
                op: "viewport_set_use_hdr_2d",
                item: null,
                reason: "viewport-hdr-2d",
              },
              {
                op: "viewport_set_msaa_2d",
                item: null,
                reason: "viewport-msaa-2d",
              },
            ),
        },
      },
    ],
  ];
  for (const [what, edits] of valid) {
    const data = build(edits);
    ok(
      code(data) === "ok",
      `golden-16 (hand-made): ${what} validates (got ${JSON.stringify(validateRecording(data, 16))})`,
    );
  }
  {
    // A canvas texture whose diffuse names a viewport is texture-ref below /16's widening: at /16
    // it validates; a diffuse naming a canvas texture stays texture-ref.
    const canvasTex = (id: number, diffuse: number) =>
      JSON.parse(
        JSON.stringify({
          ...kindTexture(id, "proxy", 1),
          kind: "canvas",
          target: undefined,
          canvas: { diffuse, filter: "default", repeat: "default" },
        }),
      ) as Meta;
    const ok16 = build(
      editsA({ 22: add([vp1], [tex13, tex14, canvasTex(15, 13)]) }),
    );
    const bad = build(
      editsA({
        22: add([vp1], [tex13, tex14, canvasTex(15, 13), canvasTex(16, 15)]),
      }),
    );
    ok(
      code(ok16) === "ok" && code(bad) === "texture-ref",
      `golden-16 (hand-made): a diffuse may name a viewport at /16, and still not a canvas texture (got ${code(ok16)}, ${code(bad)})`,
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
