#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 7 runner helpers (G7d), called by run-gate7.sh:
//
//   gate7-phone-tool.ts check-selection <desktop|device> [<device id>]
//       Exit 2 with the reason unless the pair is valid (browser-harness.ts resolveDeviceSelection,
//       D28: device arms never run without both flags).
//   gate7-phone-tool.ts plan --group g7-dev|g7-bench [--device <id>] [--inputs <inputs.json>] --out <plan.json>
//       The leg plan (lib/gate7-dev-legs.ts) for that group and environment.
//   gate7-phone-tool.ts bench-inputs --root <dir> --out <inputs.json>
//       render-stream-gate7-bench-inputs/1 for the captures under <dir> (scene/, hd/, pace/): the
//       gate 6 `animate` capture's full and patch sinks, the gate6-hd capture's patch sink (a full
//       transaction, then patches) and the pace capture's patch sink, with transaction counts.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  HarnessUsageError,
  loadDeviceTable,
  resolveDeviceSelection,
} from "./lib/browser-harness";
import {
  type PlannedLeg,
  planGate7Bench,
  planGate7Dev,
} from "./lib/gate7-dev-legs";
import { decodeRecord, splitRecords } from "./lib/render-stream-2";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export const BENCH_INPUT_FILES: {
  name: string;
  dir: string;
  file: string;
  source: string;
}[] = [
  {
    name: "scene-full",
    dir: "scene",
    file: "recording.rs2",
    source:
      "gate6-scene `animate`, 400 frames, full sink: the 400-transaction capture G6c's replay numbers came from (bench-matches-g6c)",
  },
  {
    name: "scene-patch",
    dir: "scene",
    file: "recording-patch.rs2",
    source: "the same capture's patch sink: what a live receiver decodes",
  },
  {
    name: "hd-patch",
    dir: "hd",
    file: "recording-patch.rs2",
    source:
      "gate6-hd native 1920x1080 (G6h's capture), patch sink: a full transaction, then patches",
  },
  {
    name: "pace-patch",
    dir: "pace",
    file: "recording-patch.rs2",
    source:
      "fixtures/gate7-pace, 400 frames, patch sink: one transform patch per transaction",
  },
];

function countTransactions(path: string): number | null {
  const data = new Uint8Array(readFileSync(path));
  for (const version of [6, 5, 4] as const) {
    const split = splitRecords(data, version);
    if (split.errors.length > 0) continue;
    let n = 0;
    for (const raw of split.records)
      if (decodeRecord(raw, version).record?.meta.type === "transaction") n++;
    return n;
  }
  return null;
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv
    .slice(2)
    .filter((a, i) => !(i === 0 && a === "--"));
  if (command === "check-selection") {
    const [env, device] = argv;
    if (env !== "desktop" && env !== "device")
      throw new HarnessUsageError(
        `--env must be desktop or device (got ${env})`,
      );
    resolveDeviceSelection(env, device || undefined, loadDeviceTable());
    return;
  }
  if (command === "plan") {
    const group = flag(argv, "--group");
    const device = flag(argv, "--device") || null;
    const out = flag(argv, "--out");
    if (!out) throw new HarnessUsageError("plan needs --out");
    const table = loadDeviceTable();
    let legs: PlannedLeg[];
    if (group === "g7-dev") legs = planGate7Dev(device, table);
    else if (group === "g7-bench") {
      const inputsPath = flag(argv, "--inputs");
      const names = inputsPath
        ? (
            JSON.parse(readFileSync(inputsPath, "utf8")) as {
              inputs: { name: string }[];
            }
          ).inputs.map((i) => i.name)
        : BENCH_INPUT_FILES.map((f) => f.name);
      legs = planGate7Bench(device, names);
    } else throw new HarnessUsageError(`plan: unknown group ${group}`);
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(
      out,
      `${JSON.stringify({ schema: "render-stream-gate7-plan/1", group, env: device ? "device" : "desktop", device, legs }, null, 2)}\n`,
    );
    console.log(
      `gate7-phone-tool: ${group} plan: ${legs.length} legs (${legs.filter((l) => l.needs.length === 0).length} runnable now) -> ${out}`,
    );
    return;
  }
  if (command === "bench-inputs") {
    const root = resolve(flag(argv, "--root") ?? "");
    const out = flag(argv, "--out");
    if (!out) throw new HarnessUsageError("bench-inputs needs --out");
    const inputs = [];
    for (const f of BENCH_INPUT_FILES) {
      const recording = join(root, f.dir, "capture", f.file);
      if (!existsSync(recording)) {
        console.error(
          `gate7-phone-tool: bench input ${f.name}: no ${recording}, skipped`,
        );
        continue;
      }
      const store = join(root, f.dir, "capture", "store");
      inputs.push({
        name: f.name,
        recording,
        store: existsSync(store) ? store : null,
        transactions: countTransactions(recording),
        source: f.source,
      });
    }
    await writeFile(
      out,
      `${JSON.stringify({ schema: "render-stream-gate7-bench-inputs/1", inputs }, null, 2)}\n`,
    );
    console.log(
      `gate7-phone-tool: ${inputs.length} bench inputs -> ${out} (${inputs.map((i) => `${i.name}: ${i.transactions} tx`).join(", ")})`,
    );
    return;
  }
  throw new HarnessUsageError(`unknown command ${command ?? ""}`);
}

main().catch((error) => {
  console.error(
    `gate7-phone-tool: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = error instanceof HarnessUsageError ? 2 : 1;
});
