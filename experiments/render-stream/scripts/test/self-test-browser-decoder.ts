#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate7-design.md G7j: the render-stream TypeScript decoder (lib/render-stream-2.ts,
// lib/render-stream-mesh.ts, lib/render-stream-shader.ts) is loadable in a browser. G7j's change is
// narrow: those three files no longer hard-import `node:crypto` -- each keeps its own injectable
// `hashImpl` (lib/sha256.ts's pure, synchronous `sha256Hex` by default, swappable with
// `setHashImpl()`). This file is the proof:
//
//   mise exec -- pnpm exec tsx --conditions=development scripts/test/self-test-browser-decoder.ts
//
// Checks (gate7-design.md G7j "Checks"):
//   - Section A: lib/sha256.ts's pure `sha256Hex` equals `node:crypto` directly, at the FIPS
//     180-4 padding boundary lengths (0, 55/56/57, 63/64/65, 119/120/121, ...) and over 10 000
//     random lengths 0-70 000 B.
//   - Section B: the three modules' own exported hash wrappers (`payloadSha256`,
//     `meshPayloadSha256`, `shaderPayloadSha256`) agree with each other -- and with the golden's
//     committed hash -- whichever implementation is injected, over every golden-2..golden-6
//     payload (.grt/.grm/.grp). `recordSha256` gets the same treatment on every record of every
//     valid vector.
//   - Section C: every golden-2..golden-6 valid vector decodes, validates and resolves
//     IDENTICALLY whether the pure default or an injected `node:crypto` wrapper is in use.
//   - Section D (sabotage, gate7-design.md G7j "Sabotage"): injecting a hash that skips the
//     FIPS 180-4 length padding (`brokenSha256NoLengthPadding`) must make a clean golden vector
//     fail with `resource-hash`, proving this harness would actually catch a broken pure
//     implementation rather than passing on a stub.
//   - Section E: an esbuild `platform: "browser"` bundle of the three modules has no `node:`
//     import (a metafile check) -- what actually makes them loadable in a browser, as opposed to
//     merely producing the same hashes.
//
// golden-7 (G7w, protocol/gate7-design.md Q2) does not exist on this branch yet; the GOLDENS list
// below extends to it the same way /3 to /6 were added (memory
// g4e1-rs3-version-switch-pattern) once it lands. This file does not add it itself -- G7w owns
// render-stream/7's codecs and golden vectors.
//
// Exits non-zero if any assertion fails.

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as esbuild from "esbuild";

import {
  decodeRecording,
  payloadSha256,
  recordSha256,
  resolveRecording,
  setHashImpl as setRs2HashImpl,
  statesEqual,
  validateRecording,
} from "../lib/render-stream-2";
import {
  meshPayloadSha256,
  setHashImpl as setMeshHashImpl,
} from "../lib/render-stream-mesh";
import {
  setHashImpl as setShaderHashImpl,
  shaderPayloadSha256,
} from "../lib/render-stream-shader";
import { brokenSha256NoLengthPadding, sha256Hex } from "../lib/sha256";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = resolve(SCRIPT_DIR, "../lib");
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "../..");

function nodeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function injectPure(): void {
  setRs2HashImpl(sha256Hex);
  setMeshHashImpl(sha256Hex);
  setShaderHashImpl(sha256Hex);
}

function injectNodeCrypto(): void {
  setRs2HashImpl(nodeSha256);
  setMeshHashImpl(nodeSha256);
  setShaderHashImpl(nodeSha256);
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
  dir: string,
  relativePath: string,
): Promise<Uint8Array> {
  const buf = await readFile(join(dir, relativePath));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function randomU8(len: number): Uint8Array {
  const buf = randomBytes(len);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

interface GoldenIndex {
  valid: Array<{ file: string }>;
  payloads: Array<{ file: string; hash: string }>;
  mesh_payloads?: Array<{ file: string; hash: string }>;
  shader_payloads?: Array<{ file: string; hash: string }>;
}

// golden-7 is not listed yet -- see the file header.
const GOLDENS: ReadonlyArray<{ dir: string; version: 2 | 3 | 4 | 5 | 6 }> = [
  { dir: resolve(EXPERIMENT_DIR, "protocol/golden-2"), version: 2 },
  { dir: resolve(EXPERIMENT_DIR, "protocol/golden-3"), version: 3 },
  { dir: resolve(EXPERIMENT_DIR, "protocol/golden-4"), version: 4 },
  { dir: resolve(EXPERIMENT_DIR, "protocol/golden-5"), version: 5 },
  { dir: resolve(EXPERIMENT_DIR, "protocol/golden-6"), version: 6 },
];

async function sectionA(): Promise<void> {
  const boundaryLengths = [
    0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 1000, 65536, 70000,
  ];
  for (const len of boundaryLengths) {
    const bytes = randomU8(len);
    ok(
      sha256Hex(bytes) === nodeSha256(bytes),
      `sha256Hex matches node:crypto at length ${len}`,
    );
  }

  const RANDOM_TRIALS = 10_000;
  let mismatches = 0;
  for (let i = 0; i < RANDOM_TRIALS; i++) {
    const len = Math.floor(Math.random() * 70_001);
    const bytes = randomU8(len);
    if (sha256Hex(bytes) !== nodeSha256(bytes)) mismatches++;
  }
  ok(
    mismatches === 0,
    `sha256Hex matches node:crypto on ${RANDOM_TRIALS} random lengths 0-70000 B (${mismatches} mismatches)`,
  );
}

async function sectionB(): Promise<void> {
  for (const { dir, version } of GOLDENS) {
    const label = `golden-${version}`;
    const index = JSON.parse(
      await readFile(join(dir, "index.json"), "utf8"),
    ) as GoldenIndex;

    for (const entry of index.payloads) {
      const bytes = await readBytes(dir, entry.file);
      injectPure();
      const pure = payloadSha256(bytes);
      injectNodeCrypto();
      const node = payloadSha256(bytes);
      ok(
        pure === node && pure === entry.hash,
        `${label}: payloadSha256(${entry.file}) agrees across the pure default, an injected node:crypto, and the golden's own hash`,
      );
    }
    for (const entry of index.mesh_payloads ?? []) {
      const bytes = await readBytes(dir, entry.file);
      injectPure();
      const pure = meshPayloadSha256(bytes);
      injectNodeCrypto();
      const node = meshPayloadSha256(bytes);
      ok(
        pure === node && pure === entry.hash,
        `${label}: meshPayloadSha256(${entry.file}) agrees across the pure default, an injected node:crypto, and the golden's own hash`,
      );
    }
    for (const entry of index.shader_payloads ?? []) {
      const bytes = await readBytes(dir, entry.file);
      injectPure();
      const pure = shaderPayloadSha256(bytes);
      injectNodeCrypto();
      const node = shaderPayloadSha256(bytes);
      ok(
        pure === node && pure === entry.hash,
        `${label}: shaderPayloadSha256(${entry.file}) agrees across the pure default, an injected node:crypto, and the golden's own hash`,
      );
    }

    // recordSha256 funnels through render-stream-2.ts's own hashImpl too (it hashes a raw record
    // byte range directly, independent of payload format).
    for (const entry of index.valid) {
      const bytes = await readBytes(dir, entry.file);
      injectPure();
      const decoded = decodeRecording(bytes, version);
      for (const record of decoded.records) {
        injectPure();
        const pure = recordSha256(bytes, record.offset);
        injectNodeCrypto();
        const node = recordSha256(bytes, record.offset);
        ok(
          pure === node && pure === record.sha256,
          `${label}: recordSha256(${entry.file}, ${record.offset}) agrees across the pure default, an injected node:crypto, and the decoded record's own sha256`,
        );
      }
    }
  }
  injectPure();
}

async function sectionC(): Promise<void> {
  for (const { dir, version } of GOLDENS) {
    const label = `golden-${version}`;
    const index = JSON.parse(
      await readFile(join(dir, "index.json"), "utf8"),
    ) as GoldenIndex;

    for (const entry of index.valid) {
      const bytes = await readBytes(dir, entry.file);

      injectPure();
      const pureDecoded = decodeRecording(bytes, version);
      const pureErrors = validateRecording(bytes, version);
      const pureResolved = resolveRecording(bytes, version);

      injectNodeCrypto();
      const nodeDecoded = decodeRecording(bytes, version);
      const nodeErrors = validateRecording(bytes, version);
      const nodeResolved = resolveRecording(bytes, version);

      ok(
        isDeepStrictEqual(pureDecoded, nodeDecoded),
        `${label}: decodeRecording(${entry.file}) is identical with the pure default and an injected node:crypto`,
      );
      ok(
        isDeepStrictEqual(pureErrors, nodeErrors) && pureErrors.length === 0,
        `${label}: validateRecording(${entry.file}) is identically [] with the pure default and an injected node:crypto (got ${JSON.stringify(pureErrors)} / ${JSON.stringify(nodeErrors)})`,
      );
      ok(
        statesEqual(pureResolved, nodeResolved),
        `${label}: resolveRecording(${entry.file}) is identical with the pure default and an injected node:crypto`,
      );
    }
  }
  injectPure();
}

async function sectionD(): Promise<void> {
  const dir = resolve(EXPERIMENT_DIR, "protocol/golden-2");
  const index = JSON.parse(
    await readFile(join(dir, "index.json"), "utf8"),
  ) as GoldenIndex;
  const inlineEntry = index.valid.find((e) => e.file.startsWith("inline."));
  if (!inlineEntry) {
    ok(
      false,
      "golden-2/index.json has an inline.* vector for the sabotage case",
    );
    return;
  }
  const bytes = await readBytes(dir, inlineEntry.file);

  injectPure();
  const cleanErrors = validateRecording(bytes, 2);
  ok(
    cleanErrors.length === 0,
    `golden-2: validateRecording(${inlineEntry.file}) is clean with the real hash (sanity check before sabotage, got ${JSON.stringify(cleanErrors)})`,
  );

  setRs2HashImpl(brokenSha256NoLengthPadding);
  const sabotagedErrors = validateRecording(bytes, 2);
  ok(
    sabotagedErrors.length > 0 &&
      sabotagedErrors.every((e) => e.startsWith("resource-hash: ")),
    `golden-2: validateRecording(${inlineEntry.file}) fails with resource-hash when the injected hash skips FIPS 180-4 length padding (got ${JSON.stringify(sabotagedErrors)})`,
  );
  injectPure();
}

async function sectionE(): Promise<void> {
  const entryPoints = [
    join(LIB_DIR, "render-stream-2.ts"),
    join(LIB_DIR, "render-stream-mesh.ts"),
    join(LIB_DIR, "render-stream-shader.ts"),
  ];
  try {
    const result = await esbuild.build({
      entryPoints,
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["development"],
      write: false,
      outdir: "out", // write:false means nothing actually lands here; esbuild still requires
      // an outdir to name multiple output files.
      metafile: true,
      logLevel: "silent",
    });
    const nodeImports = Object.keys(result.metafile.inputs).filter((p) =>
      p.startsWith("node:"),
    );
    ok(
      nodeImports.length === 0,
      `esbuild platform:"browser" bundle of render-stream-2/mesh/shader.ts has no node: import (found: ${JSON.stringify(nodeImports)})`,
    );
    ok(
      result.outputFiles.length === entryPoints.length,
      "esbuild produced one output file per entry point",
    );
  } catch (error) {
    ok(
      false,
      `esbuild platform:"browser" bundle of render-stream-2/mesh/shader.ts succeeds (threw: ${String(error)})`,
    );
  }
}

async function main(): Promise<void> {
  injectPure();
  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();

  console.log(
    `\nself-test-browser-decoder: ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main();
