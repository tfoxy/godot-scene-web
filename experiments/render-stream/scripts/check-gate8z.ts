#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 8 group G8z: gate 8's manifest checks, the seven of Q11 (gate7-design.md) judged against the
// render-stream-8 files and the runs lib/feature-evidence-8.ts quotes. Pure; it reads existing run
// directories and never runs a leg.
//
//   check-gate8z.ts [--evidence-root <artifacts dir>] [--out <dir>]
//
// The root defaults to `<main checkout>/artifacts` (paths in the manifests start `render-stream/`).
// Exit 0 only if every row passes (a `report` row never fails; `pending` is a failure).

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { PROFILE_8 } from "./lib/feature-evidence-8";
import {
  defaultEvidenceRoot8,
  runGate7z,
  runGate7zSessions,
} from "./lib/gate7z-checks";
import {
  buildManifest2,
  manifest8Path,
  readCollected,
  serializeManifest2,
} from "./make-features";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const root = resolve(argValue("--evidence-root") ?? defaultEvidenceRoot8());
  const collected = readCollected(8);
  const inp = {
    root,
    manifestPath: manifest8Path,
    regenerate: (k: Parameters<typeof manifest8Path>[0]) =>
      serializeManifest2(buildManifest2(k, collected, 8)),
    profile: PROFILE_8,
  };
  const checks = runGate7z(inp);
  await runGate7zSessions(inp, checks);
  let failed = 0;
  for (const c of checks) {
    if (c.status === "fail" || c.status === "pending") failed++;
    console.log(`${c.status.toUpperCase().padEnd(7)} ${c.id}  ${c.detail}`);
  }
  const out = argValue("--out");
  if (out) {
    await mkdir(out, { recursive: true });
    await writeFile(
      join(out, "g8-z.json"),
      `${JSON.stringify({ schema: "render-stream-g8z/1", root, checks }, null, 2)}\n`,
    );
  }
  console.log(
    `check-gate8z: ${checks.length - failed}/${checks.length} rows ok`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
