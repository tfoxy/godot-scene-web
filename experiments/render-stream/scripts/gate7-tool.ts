#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 7 runner helpers (G7e), called by run-gate7.sh:
//
//   gate7-tool.ts source-provenance --extension E --out <source run>/gate7-source.json
//     writes the current build's D21 provenance next to a source run it just made
//   gate7-tool.ts web-legs --group g7-0 --source <gate 0 run> --bundle <bundle dir> --out <gate 7 run>
//     replays the group's native receiver legs in the web-export receiver (lib/gate7-web-legs.ts)
//   gate7-tool.ts source-inputs --source gate0=<run>,gate1=<run>,... --out <inputs.json>
//     (G7a) every capture recording of the source runs (`*/capture*/recording*.rs2` and the live
//     receivers' `received.rs2`), each once by sha256, as render-stream-gate7-bench-inputs/1 for
//     self-test-rs-core.ts (Q14d "Real recordings")
//   gate7-tool.ts gsw-bundle --out <dir> [--rs-build <artifacts/render-stream/rs-core/<sha>>]
//     (G7a) bundles the GSW canvas receiver (lib/gsw-bundle.ts); prints the directory
//   gate7-tool.ts gsw-legs --group g7-<0..3> --source <gate run> --bundle <gsw bundle> --out <gate 7 run>
//     (G7a) replays the group's native receiver legs, and its GSW-only sabotages, in the GSW canvas
//     receiver into <out>/<gate>/gsw/ (lib/gate7-gsw.ts)

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { currentBuildProvenance, gate0WebLegSpecs } from "./lib/gate7-adapters";
import { type GswGate, gswLegSpecs } from "./lib/gate7-gsw";
import { runWebLegs } from "./lib/gate7-web-legs";
import { buildGswBundle, DEFAULT_RS_BUILD } from "./lib/gsw-bundle";

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
  if (command === "source-inputs") {
    const inputs: {
      name: string;
      recording: string;
      store?: string;
      source: string;
    }[] = [];
    const seen = new Set<string>();
    for (const pair of flag(argv, "--source").split(",").filter(Boolean)) {
      const eq = pair.indexOf("=");
      const gate = pair.slice(0, eq);
      const root = resolve(pair.slice(eq + 1));
      const found: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 3) return;
        for (const e of readdirSync(dir).sort()) {
          const p = join(dir, e);
          if (statSync(p).isDirectory()) walk(p, depth + 1);
          else if (
            /\/capture[^/]*\/recording[^/]*\.rs2$/.test(p) ||
            /\/live\/receiver\/received\.rs2$/.test(p)
          )
            found.push(p);
        }
      };
      walk(root, 0);
      for (const p of found) {
        const sha = createHash("sha256").update(readFileSync(p)).digest("hex");
        if (seen.has(sha)) continue;
        seen.add(sha);
        const store = join(p, "..", "store");
        inputs.push({
          name: `${gate}-${p
            .slice(root.length + 1)
            .replace(/\//g, "-")
            .replace(/\.rs2$/, "")}`,
          recording: p,
          ...(existsSync(store) ? { store } : {}),
          source: `${gate} source run`,
        });
      }
    }
    writeFileSync(
      resolve(flag(argv, "--out")),
      `${JSON.stringify({ schema: "render-stream-gate7-bench-inputs/1", inputs }, null, 2)}\n`,
    );
    console.log(`gate7-tool: ${inputs.length} source recordings`);
    return;
  }
  if (command === "gsw-bundle") {
    const i = argv.indexOf("--rs-build");
    const rsBuild =
      i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : DEFAULT_RS_BUILD;
    const bundle = await buildGswBundle(resolve(flag(argv, "--out")), rsBuild);
    console.log(bundle.dir);
    return;
  }
  if (command === "gsw-legs") {
    const group = flag(argv, "--group");
    const gate = (
      {
        "g7-0": "gate0",
        "g7-1": "gate1",
        "g7-2": "gate2",
        "g7-3": "gate3",
      } as Record<string, GswGate>
    )[group];
    if (!gate)
      throw new Error(
        `gate7-tool: no gsw legs for ${group} (G7a lands g7-0..g7-3)`,
      );
    const out = resolve(flag(argv, "--out"));
    const source = resolve(flag(argv, "--source"));
    const bundle = resolve(flag(argv, "--bundle"));
    const build = JSON.parse(
      readFileSync(join(bundle, "build.json"), "utf8"),
    ) as {
      sha256: string;
    };
    const results = await runWebLegs(
      {
        out,
        gate,
        sourceDir: source,
        bundleDir: bundle,
        buildSha256: build.sha256,
        kind: "gsw",
      },
      gswLegSpecs(gate, source, join(out, gate, "gsw")),
    );
    const refused = results.filter((r) => !r.provenanceOk);
    if (refused.length > 0)
      console.error(
        `gate7-tool: harness-refused (browser-provenance) on ${refused.map((r) => r.leg).join(", ")}`,
      );
    return;
  }
  throw new Error(`gate7-tool: unknown command ${command ?? "<none>"}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
