#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8t checks (lib/gate8-tex-checks.ts, G8t) on the committed
// fixtures/gate8-tex/expected.json and on synthetic hook, fixture and oracle lines, each with a
// passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8.ts
//
// 1. expected.json is self-consistent: every drawn texture names both families, every decoded
//    source format maps to a carried payload format, refusals carry no payload format.
// 2. pairTextures pairs by frame and shape, a decode by its source_format.
// 3. censusProblems: a decode as expected passes; a wrong payload format, a missing
//    source_format, a missing decode_ns, an unexpected refusal and a refusal that carries a
//    source_format each fail.
// 4. oracleProblems: equal hashes pass; a perturbed hash, a refused-but-decodable texture and a
//    published texture the oracle cannot carry each fail; the lossless control uses the desktop
//    import for both families.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  censusProblems,
  compareWorkerRecordings,
  type FixtureTextureLine,
  type G8tExpected,
  type HookTextureLine,
  maskedHookLog,
  type OracleReport,
  oracleProblems,
  pairTextures,
} from "../lib/gate8-tex-checks";
import type { ResolvedRecording, ResolvedTransaction } from "../lib/render-stream-2";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..", "..");

let assertions = 0;
let failures = 0;
function assert(condition: boolean, what: string): void {
  assertions++;
  if (!condition) {
    failures++;
    console.log(`FAIL ${what}`);
  } else console.log(`PASS ${what}`);
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function hook(over: Partial<HookTextureLine>): HookTextureLine {
  return {
    frame: 1,
    thread: "main",
    op: "texture_2d_create",
    id: 1,
    status: "ok",
    reason: null,
    format: "RGBA8",
    source_format: "DXT5",
    width: 64,
    height: 64,
    mipmaps: false,
    data_bytes: 16384,
    payload_bytes: 16500,
    hash: HASH_A,
    copy_ns: 1000,
    hash_ns: 2000,
    decode_ns: 3000,
    ...over,
  };
}

function fixture(over: Partial<FixtureTextureLine>): FixtureTextureLine {
  return {
    step: 0,
    frame: 1,
    name: "alpha",
    family: "desktop",
    key: "s3tc",
    path: "res://.godot/imported/alpha.png-x.s3tc.ctex",
    source: "ctex",
    format: "DXT5",
    width: 64,
    height: 64,
    mipmaps: false,
    ...over,
  };
}

function oracle(entries: Partial<OracleReport["textures"][number]>[]): OracleReport {
  return {
    schema: "render-stream-gate8-oracle/1",
    timing: false,
    repeats: 0,
    textures: entries.map((e) => ({
      name: "alpha",
      family: "desktop",
      key: "s3tc",
      path: "",
      source_format: "DXT5",
      width: 64,
      height: 64,
      mipmaps: false,
      decoded_format: "RGBA8",
      payload_sha256: HASH_A,
      ...e,
    })),
  };
}

function expectedCases(expected: G8tExpected): void {
  const carried = new Set(["RGBA8", "R8", "RG8"]);
  let ok = true;
  for (const [name, tex] of Object.entries({ ...expected.textures, ...expected.cost }))
    for (const family of ["desktop", "mobile"] as const) {
      const fam = tex[family];
      if (!fam) ok = false;
      else if (fam.refused !== undefined) ok &&= fam.format === undefined && fam.source_format !== null;
      else ok &&= fam.format !== undefined && carried.has(fam.format);
      if (!ok) console.log(`  expected.json: ${name}/${family}`);
    }
  assert(ok, "expected.json: every texture names both families, a carried payload or a typed refusal");
  assert(
    expected.steps.length === 2 && expected.steps[0].family === "desktop" && expected.steps[1].family === "mobile",
    "expected.json: step 0 draws the desktop family, step 1 the mobile one",
  );
}

function pairCases(): void {
  const pairs = pairTextures(
    [fixture({}), fixture({ name: "opaque", format: "DXT1" }), fixture({ name: "late", frame: 11 })],
    [hook({ source_format: "DXT1", hash: HASH_B }), hook({}), hook({ frame: 2 })],
  );
  assert(pairs[0].hook?.hash === HASH_A && pairs[1].hook?.hash === HASH_B, "pairTextures pairs a decode by its source_format");
  assert(pairs[2].hook === undefined, "pairTextures needs the same frame");
  const refused = pairTextures(
    [fixture({ name: "hdr", format: "BPTC_RGBFU", width: 16, height: 16 })],
    [hook({ status: "unsupported", reason: "unsupported-format", format: "BPTC_RGBFU", source_format: undefined, width: 16, height: 16, hash: null })],
  );
  assert(refused[0].hook !== undefined, "pairTextures pairs a refusal by its own format");
}

function censusCases(): void {
  const fam = { source_format: "DXT5", format: "RGBA8" };
  const p = (h: Partial<HookTextureLine>) => ({ fixture: fixture({}), hook: hook(h) });
  assert(censusProblems(p({}), fam).length === 0, "census: a decode as expected passes");
  assert(censusProblems(p({ format: "RGB8" }), fam).length > 0, "census: a wrong payload format fails");
  assert(censusProblems(p({ source_format: undefined }), fam).length > 0, "census: a missing source_format fails");
  assert(censusProblems(p({ decode_ns: null }), fam).length > 0, "census: a missing decode_ns fails");
  assert(
    censusProblems(p({ status: "unsupported", reason: "unsupported-format", format: "DXT5", source_format: undefined }), fam).length > 0,
    "census: an unexpected refusal fails",
  );
  const refusedFam = { source_format: "BPTC_RGBFU", refused: "unsupported-format" };
  const refusal = { status: "unsupported", reason: "unsupported-format", format: "BPTC_RGBFU", source_format: undefined, hash: null };
  assert(censusProblems(p(refusal), refusedFam).length === 0, "census: a declared refusal passes");
  assert(
    censusProblems(p({ ...refusal, source_format: "BPTC_RGBFU" }), refusedFam).length > 0,
    "census: a refusal carrying a source_format fails",
  );
  assert(
    censusProblems({ fixture: fixture({}), hook: undefined }, fam).length > 0,
    "census: a missing create fails",
  );
}

function oracleCases(): void {
  const pair = (h: Partial<HookTextureLine>, f: Partial<FixtureTextureLine> = {}) => ({
    fixture: fixture(f),
    hook: hook(h),
  });
  assert(oracleProblems(pair({}), oracle([{}])).length === 0, "oracle: equal hashes pass");
  assert(oracleProblems(pair({ hash: HASH_B }), oracle([{}])).length > 0, "oracle: a perturbed payload fails");
  assert(
    oracleProblems(pair({ status: "unsupported", reason: "unsupported-format", source_format: undefined, format: "DXT5", hash: null }), oracle([{}])).length > 0,
    "oracle: a decodable texture the hook refused fails",
  );
  assert(
    oracleProblems(pair({}), oracle([{ decoded_format: null, payload_sha256: null }])).length > 0,
    "oracle: a published texture the oracle cannot carry fails",
  );
  assert(
    oracleProblems(
      pair({ status: "unsupported", reason: "unsupported-format", source_format: undefined, format: "DXT5", hash: null }),
      oracle([{ decoded_format: null, payload_sha256: null }]),
    ).length === 0,
    "oracle: a refused texture the oracle cannot carry passes",
  );
  assert(
    oracleProblems(
      pair({ source_format: undefined }, { name: "control", family: "mobile", key: "", format: "RGBA8" }),
      oracle([{ name: "control", family: "desktop", key: "", source_format: "RGBA8" }]),
    ).length === 0,
    "oracle: the lossless control's mobile create uses its single (desktop) import",
  );
  assert(oracleProblems(pair({}), oracle([])).length > 0, "oracle: a missing oracle entry fails");
}

// G8kw: the hold-back's contract on synthetic resolved recordings.
function recording(frames: [number, string][]): ResolvedRecording {
  return {
    schema: "render-stream-8-resolved/1",
    session_id: "s",
    stream_id: "t",
    resources: [],
    transactions: frames.map(
      ([frame, hash], i) =>
        ({
          seq: i + 1,
          frame,
          encoding: "full",
          state: { textures: [{ id: 1, hash }] },
        }) as unknown as ResolvedTransaction,
    ),
  };
}

function workerCases(): void {
  const sync = recording([[1, HASH_A], [2, HASH_A], [3, HASH_B], [4, HASH_B]]);
  const held = compareWorkerRecordings(sync, recording([[2, HASH_A], [4, HASH_B]]));
  assert(
    held.problems.length === 0 && JSON.stringify(held.held_frames) === "[1,3]",
    "workers: a recording missing held frames but equal on every published one passes",
  );
  assert(
    compareWorkerRecordings(sync, recording([[2, HASH_A], [3, "0".repeat(64)], [4, HASH_B]])).problems
      .some((p) => p.startsWith("frame 3")),
    "workers: a frame published before its hash was ready (zero hash) fails",
  );
  assert(
    compareWorkerRecordings(sync, recording([[2, HASH_A], [3, HASH_B]])).problems.some((p) =>
      p.includes("ends at frame 3"),
    ),
    "workers: a recording that never publishes the last state fails",
  );
  assert(
    compareWorkerRecordings(sync, recording([[2, HASH_A], [5, HASH_B]])).problems.some((p) =>
      p.includes("never published"),
    ),
    "workers: a frame the synchronous recording never had fails",
  );
  assert(
    compareWorkerRecordings(sync, recording([])).problems.includes("the async recording has no transaction"),
    "workers: an empty recording fails",
  );
  const syncLog = [
    `{"frame":1,"t_us":5,"op":"texture_2d_create","id":1,"hash":"${HASH_A}","copy_ns":9,"hash_ns":3}`,
    `{"frame":2,"t_us":7,"op":"store","hash":"${HASH_A}"}`,
  ].join("\n");
  const asyncLog = [
    `{"frame":1,"t_us":6,"op":"texture_2d_create","id":1,"hash":"${HASH_A}","copy_ns":8,"hash_ns":4,"worker":true,"hook_ns":12,"dup_ns":2}`,
    `{"frame":4,"t_us":9,"op":"store","hash":"${HASH_A}"}`,
  ].join("\n");
  const a = maskedHookLog(syncLog);
  const b = maskedHookLog(asyncLog);
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    "workers: hook logs equal but for cost columns, worker keys and the store line's frame",
  );
  assert(
    JSON.stringify(maskedHookLog(asyncLog.replace(`"id":1`, `"id":2`)).texture) !== JSON.stringify(a.texture),
    "workers: a differing fact in a texture line is seen",
  );
}

async function main(): Promise<void> {
  const expected = JSON.parse(
    await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-tex", "expected.json"), "utf8"),
  ) as G8tExpected;
  expectedCases(expected);
  pairCases();
  censusCases();
  oracleCases();
  workerCases();
  console.log(`\nself-test-gate8: ${assertions - failures}/${assertions} assertions passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
