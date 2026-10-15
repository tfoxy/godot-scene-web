#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 7 runner helpers (G7e), called by run-gate7.sh:
//
//   gate7-tool.ts source-provenance --extension E --out <source run>/gate7-source.json
//     writes the current build's D21 provenance next to a source run it just made
//   gate7-tool.ts web-legs --group g7-0 --source <gate 0 run> --bundle <bundle dir> --out <gate 7 run>
//     replays the group's native receiver legs in the web-export receiver (lib/gate7-web-legs.ts)

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { currentBuildProvenance, gate0WebLegSpecs } from "./lib/gate7-adapters";
import { runWebLegs } from "./lib/gate7-web-legs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
export const PINNED_LINUX_TEMPLATE = join(
  homedir(),
  ".cache",
  "godot-render-stream",
  "templates",
  "4.5.1-stable",
  "linux_release.x86_64",
);

function flag(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (!v) throw new Error(`gate7-tool: ${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2).filter((a) => a !== "--");
  if (command === "source-provenance") {
    const doc = currentBuildProvenance(
      REPO_ROOT,
      resolve(flag(argv, "--extension")),
      PINNED_LINUX_TEMPLATE,
    );
    writeFileSync(
      resolve(flag(argv, "--out")),
      `${JSON.stringify(doc, null, 2)}\n`,
    );
    return;
  }
  if (command === "web-legs") {
    const group = flag(argv, "--group");
    if (group !== "g7-0")
      throw new Error(`gate7-tool: no web legs for ${group} yet (G7b)`);
    const out = resolve(flag(argv, "--out"));
    const source = resolve(flag(argv, "--source"));
    const bundle = resolve(flag(argv, "--bundle"));
    const build = JSON.parse(
      readFileSync(join(bundle, "build.json"), "utf8"),
    ) as { pck: { sha256: string } };
    const results = await runWebLegs(
      {
        out,
        gate: "gate0",
        sourceDir: source,
        bundleDir: bundle,
        buildSha256: build.pck.sha256,
      },
      gate0WebLegSpecs(source, join(out, "gate0", "web")),
    );
    const refused = results.filter((r) => !r.provenanceOk);
    if (refused.length > 0) {
      console.error(
        `gate7-tool: harness-refused (browser-provenance) on ${refused.map((r) => r.leg).join(", ")}`,
      );
    }
    return;
  }
  throw new Error(`gate7-tool: unknown command ${command ?? "<none>"}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
