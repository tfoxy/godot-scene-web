#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for render-stream-core (gate7-design.md Q14d "Real recordings"): the Rust decoder
// (experiments/render-stream/rs-core) against the TypeScript decoder of record
// (lib/render-stream-2.ts), transaction by transaction, over real recordings.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-rs-core.ts --inputs <inputs.json> \
//     [--goldens] [--rs-core-check <path>]
//
// 1. Locates the native CLI (default rs-core/target/release/rs-core-check; built with
//    `cargo build --offline --release` when missing) and runs `rs-core-check diff` over every
//    input of `inputs.json` (schema render-stream-gate7-bench-inputs/1): one JSONL line per
//    record with its sha256 and, per transaction, the sha256 of its canonical resolved JSON and
//    its unsupported list.
// 2. Runs the TypeScript decoder over the same records (`createRecordingValidator` for the
//    verdict, `decodeRecord` + `applyTransaction` for the state, the hash injected from
//    node:crypto) and requires, for EVERY record, the same sha256, and after EVERY transaction the
//    same state sha256 (TypeScript side: sha256 of `JSON.stringify` of the transaction exactly as
//    `resolveRecording` builds it) and the same unsupported list.
// 3. On a mismatch writes both canonical JSONs of the first mismatching transaction under
//    artifacts/render-stream/gate7/g7x/self-test-rs-core/ and fails.
// 4. --goldens: also runs `rs-core-check goldens` (golden-2 ... golden-8) and judges
//    self-test-rs2.ts's unknown-item-skip cases (protocol/unknown-item-skip.md) with both decoders.
//
// Exits non-zero on any mismatch or failure.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyTransaction,
  createRecordingValidator,
  decodeRecord,
  emptyResolvedState,
  type ResolvedState,
  type ResolvedTransaction,
  setHashImpl,
  sortedResolvedCanvases,
  sortedResolvedItems,
  sortedResolvedMaterials,
  sortedResolvedMeshes,
  sortedResolvedShaders,
  sortedResolvedTextures,
  splitRecords,
  validateRecording,
} from "../lib/render-stream-2";
import { setHashImpl as setMeshHashImpl } from "../lib/render-stream-mesh";
import { setHashImpl as setShaderHashImpl } from "../lib/render-stream-shader";
import { encodeRs2Recording, type TState } from "./rs2-test-encoder";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RS_CORE_DIR = resolve(SCRIPT_DIR, "../../rs-core");
const PROTOCOL_DIR = resolve(SCRIPT_DIR, "../../protocol");
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../..");
const OUT_DIR = join(
  REPO_ROOT,
  "artifacts/render-stream/gate7/g7x/self-test-rs-core",
);

type Version = 2 | 3 | 4 | 5 | 6;

interface NativeLine {
  index?: number;
  offset?: number;
  type?: string;
  sha256?: string;
  seq?: number;
  state_sha256?: string;
  unsupported?: unknown[];
  error?: string;
}

let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`,
  );
}

const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function parseArgs(argv: string[]): {
  inputs: string | null;
  goldens: boolean;
  cli: string | null;
} {
  let inputs: string | null = null;
  let goldens = false;
  let cli: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--inputs") inputs = argv[++i] ?? null;
    else if (a === "--goldens") goldens = true;
    else if (a === "--rs-core-check") cli = argv[++i] ?? null;
    else if (a === "--") continue;
    else throw new Error(`unknown argument ${a}`);
  }
  return { inputs, goldens, cli };
}

function locateCli(explicit: string | null): string {
  if (explicit !== null) return resolve(explicit);
  const path = join(RS_CORE_DIR, "target/release/rs-core-check");
  if (!existsSync(path)) {
    console.log(`building ${path}`);
    const built = spawnSync(
      "cargo",
      ["build", "--offline", "--release", "--bin", "rs-core-check"],
      { cwd: RS_CORE_DIR, stdio: "inherit" },
    );
    if (built.status !== 0) throw new Error("cargo build failed");
  }
  return path;
}

function versionOf(data: Uint8Array): Version | null {
  const head = [0x47, 0x52, 0x53];
  if (data.length < 8 || head.some((b, i) => data[i] !== b)) return null;
  const v = data[3] - 0x30;
  return v >= 2 && v <= 6 ? (v as Version) : null;
}

// One element of resolveRecording(data, version).transactions, built exactly as it builds it.
function resolvedTransaction(
  meta: Parameters<typeof applyTransaction>[1],
  state: ResolvedState,
  version: Version,
): ResolvedTransaction {
  return {
    seq: meta.seq,
    frame: meta.frame,
    encoding: meta.encoding,
    state: {
      status: meta.status,
      failures: meta.failures,
      unsupported: meta.unsupported,
      ...(meta.unknown_items !== undefined
        ? { unknown_items: meta.unknown_items }
        : {}),
      default_texture_filter: meta.default_texture_filter,
      default_texture_repeat: meta.default_texture_repeat,
      canvases: sortedResolvedCanvases(state),
      items: sortedResolvedItems(state),
      textures: sortedResolvedTextures(state),
      ...(version >= 4 ? { meshes: sortedResolvedMeshes(state) } : {}),
      ...(version >= 5
        ? {
            shaders: sortedResolvedShaders(state),
            materials: sortedResolvedMaterials(state),
          }
        : {}),
    },
  };
}

// protocol/unknown-item-skip.md: self-test-rs2.ts's unknownItemCases, judged by both decoders.
function unknownItemCases(cli: string): void {
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
  const cases: Array<[string, Buffer]> = [
    [
      "skip-session",
      encodeRs2Recording(states([true, true]), {
        ...opts,
        unknownItemPolicy: "skip",
      }),
    ],
    ["strict-with-account", encodeRs2Recording(states([true, true]), opts)],
    [
      "skip-without-account",
      encodeRs2Recording(states([true, false]), {
        ...opts,
        unknownItemPolicy: "skip",
      }),
    ],
    [
      "policy-strict",
      encodeRs2Recording(states([true]), {
        ...opts,
        unknownItemPolicy: "strict" as "skip",
      }),
    ],
  ];
  const dir = join(OUT_DIR, "unknown-items");
  mkdirSync(dir, { recursive: true });
  const files = cases.map(([name, bytes]) => {
    const file = join(dir, `${name}.rs6`);
    writeFileSync(file, bytes);
    return file;
  });
  const run = spawnSync(cli, ["validate", "--version", "6", ...files], {
    encoding: "utf8",
  });
  const native = new Map(
    run.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        const [file, code] = l.split("\t");
        return [file, code] as const;
      }),
  );
  cases.forEach(([name, bytes], i) => {
    const errors = validateRecording(new Uint8Array(bytes), 6);
    const ts = errors.length === 0 ? "ok" : errors[0].split(":")[0];
    const rust = native.get(files[i]);
    expect(
      `unknown items: ${name} is "${ts}" in both decoders`,
      rust === ts,
      `rust ${rust ?? "(none)"}`,
    );
  });
}

function nativeDump(cli: string, inputs: string, name: string, seq: number) {
  const run = spawnSync(
    cli,
    ["diff", "--inputs", inputs, "--dump", `${name}:${seq}`],
    { encoding: "utf8", maxBuffer: 1 << 30 },
  );
  return run.stdout.trim();
}

function checkInput(
  cli: string,
  inputsPath: string,
  name: string,
  recording: string,
  nativeLines: NativeLine[],
): void {
  const data = new Uint8Array(readFileSync(recording));
  const version = versionOf(data);
  if (version === null) {
    expect(`${name}: recording has a render-stream/2..6 magic`, false);
    return;
  }
  const split = splitRecords(data, version);
  if (split.errors.length > 0) {
    expect(`${name}: splitRecords`, false, split.errors[0]);
    return;
  }
  const records = split.records;
  const validator = createRecordingValidator(records, version);
  expect(
    `${name}: the TypeScript validator accepts the session record`,
    validator.errors === null,
    validator.errors?.[0] ?? "",
  );
  const nativeError = nativeLines.find((l) => l.error !== undefined);
  expect(
    `${name}: rs-core-check diff accepted every record`,
    nativeError === undefined,
    nativeError?.error ?? "",
  );
  const byIndex = new Map<number, NativeLine>();
  for (const l of nativeLines)
    if (l.index !== undefined) byIndex.set(l.index, l);

  let state = emptyResolvedState();
  let transactions = 0;
  let mismatches = 0;
  let recordMismatches = 0;
  let firstMismatchWritten = false;
  for (let i = 0; i < records.length; i++) {
    if (i > 0 && validator.errors === null) {
      const errors = validator.accept(i);
      if (errors !== undefined) {
        expect(
          `${name}: the TypeScript validator accepts record ${i}`,
          false,
          errors[0],
        );
        break;
      }
    }
    const decoded = decodeRecord(records[i], version);
    if (decoded.record === undefined) {
      expect(`${name}: decodeRecord(${i})`, false, decoded.errors[0]);
      break;
    }
    const native = byIndex.get(i);
    if (native?.sha256 !== decoded.record.sha256) {
      recordMismatches++;
      if (recordMismatches === 1) {
        expect(
          `${name}: record ${i} sha256 matches`,
          false,
          `ts ${decoded.record.sha256}, rust ${native?.sha256 ?? "(none)"}`,
        );
      }
    }
    const meta = decoded.record.meta;
    if (meta.type !== "transaction") continue;
    state = applyTransaction(state, meta, decoded.record.blocks as number[][]);
    transactions++;
    const text = JSON.stringify(resolvedTransaction(meta, state, version));
    const stateSha = sha256Hex(text);
    const unsupportedEqual =
      JSON.stringify(meta.unsupported) ===
      JSON.stringify(native?.unsupported ?? null);
    if (
      native?.seq !== meta.seq ||
      native?.state_sha256 !== stateSha ||
      !unsupportedEqual
    ) {
      mismatches++;
      if (!firstMismatchWritten) {
        firstMismatchWritten = true;
        mkdirSync(OUT_DIR, { recursive: true });
        const base = join(OUT_DIR, `${name}-seq${meta.seq}`);
        writeFileSync(`${base}.ts.json`, text);
        writeFileSync(
          `${base}.rs.json`,
          nativeDump(cli, inputsPath, name, meta.seq),
        );
        expect(
          `${name}: transaction seq ${meta.seq} resolves identically`,
          false,
          `state ${native?.state_sha256 ?? "(none)"} vs ${stateSha}, unsupported ${unsupportedEqual ? "equal" : "differ"}; wrote ${base}.{ts,rs}.json`,
        );
      }
    }
  }
  if (validator.errors === null) {
    const finish = validator.finish();
    expect(
      `${name}: the TypeScript validator finishes clean`,
      finish.length === 0,
      finish[0] ?? "",
    );
  }
  expect(
    `${name}: every record sha256 matches (${records.length} records)`,
    recordMismatches === 0,
    `${recordMismatches} differ`,
  );
  expect(
    `${name}: every transaction's canonical state and unsupported list match (${transactions} transactions)`,
    mismatches === 0,
    `${mismatches} differ`,
  );
  console.log(
    `${name}: records ${records.length}, transactions ${transactions}, mismatches ${mismatches + recordMismatches}`,
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.inputs === null && !args.goldens) {
    console.error(
      "usage: self-test-rs-core.ts --inputs <inputs.json> [--goldens] [--rs-core-check <path>]",
    );
    process.exitCode = 2;
    return;
  }
  const hash = (bytes: Uint8Array) => sha256Hex(bytes);
  setHashImpl(hash);
  setMeshHashImpl(hash);
  setShaderHashImpl(hash);
  const cli = locateCli(args.cli);

  if (args.inputs !== null) {
    const inputsPath = resolve(args.inputs);
    const index = JSON.parse(readFileSync(inputsPath, "utf8")) as {
      schema: string;
      inputs: Array<{ name: string; recording: string }>;
    };
    expect(
      "inputs.json is render-stream-gate7-bench-inputs/1",
      index.schema === "render-stream-gate7-bench-inputs/1",
    );
    const diffDir = join(OUT_DIR, "diff");
    mkdirSync(diffDir, { recursive: true });
    const run = spawnSync(
      cli,
      ["diff", "--inputs", inputsPath, "--out", diffDir],
      { encoding: "utf8", maxBuffer: 1 << 30 },
    );
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    for (const input of index.inputs) {
      const jsonl = join(diffDir, `${input.name}.jsonl`);
      const lines: NativeLine[] = existsSync(jsonl)
        ? readFileSync(jsonl, "utf8")
            .split("\n")
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as NativeLine)
        : [];
      expect(
        `${input.name}: rs-core-check diff wrote ${jsonl}`,
        lines.length > 0,
      );
      checkInput(
        cli,
        inputsPath,
        input.name,
        resolve(dirname(inputsPath), input.recording),
        lines,
      );
    }
  }

  if (args.goldens) {
    unknownItemCases(cli);
    const run = spawnSync(cli, ["goldens", "--dir", PROTOCOL_DIR], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    const tail = run.stdout
      .split("\n")
      .filter(
        (l) => l.startsWith("[FAIL]") || /^golden-|^cross|^rs-core/.test(l),
      );
    for (const l of tail) console.log(l);
    expect(
      "rs-core-check goldens passes golden-2 ... golden-8",
      run.status === 0,
    );
  }

  console.log(
    `\nself-test-rs-core: ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`,
  );
  if (failures > 0) process.exitCode = 1;
}

main();
