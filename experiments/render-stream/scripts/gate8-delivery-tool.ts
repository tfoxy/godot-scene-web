#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 8 group g8kp's browser legs (G8kp, protocol/texture-delivery-design.md D3, Q3, Q6 "GSW"),
// called by run-gate8.sh after the native legs:
//
//   gate8-delivery-tool.ts gsw-legs --source <gate 8 run> [--mask s3tc,bptc,rgtc]
//       [--rs-build <artifacts/render-stream/rs-core/<sha>>]
//
// Builds the rs-core wasm (build-rs-core.sh --wasm-only, unless --rs-build names one) and the GSW
// bundle (lib/gsw-bundle.ts) under <run>/g8kp/gsw-bundle, then replays the native leg
// g8kp/receiver (its own env.txt and argv.txt: the /9 passthrough recording, its store and shot
// seqs) in the GSW receiver page, in the repo-private pinned headless Chromium
// (lib/gate7-web-legs.ts, the gate 7 file groups' runner), three times:
//
//   g8kp/gsw-run/gsw              the GSW receiver as it is (texture_encodings block,decoded;
//                                 gpu_formats from its WebGL extensions)
//   g8kp/gsw-run/gsw-masked       RS_RECEIVER_GPU_FORMAT_MASK=<mask>: D3 must pick decoded
//   g8kp/gsw-run/sabotage-ignore-format-mask/gsw
//                                 the mask stated but not applied (sabotage ignore-format-mask):
//                                 delivery-select must fail it
//
// g8kp/gsw-run is the harness's static root (the source run is linked at sources/gate8).
//
// RS_SABOTAGE_TIER=skip (the smoke tier) leaves the sabotage leg out with skipped-by-tier.txt, as
// lib/legs.sh does for a native sabotage leg.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runWebLegs, type WebLegSpec } from "./lib/gate7-web-legs";
import { buildGswBundle } from "./lib/gsw-bundle";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");

function flag(argv: string[], name: string, fallback?: string): string {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`gate8-delivery-tool: ${name} is required`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command !== "gsw-legs")
    throw new Error(
      "usage: gate8-delivery-tool.ts gsw-legs --source <gate 8 run> [--mask list]",
    );
  const source = resolve(flag(argv, "--source"));
  const mask = flag(argv, "--mask", "s3tc,bptc,rgtc");
  const g8kp = join(source, "g8kp");
  const run = join(g8kp, "gsw-run");
  let rsBuild = argv.includes("--rs-build")
    ? resolve(flag(argv, "--rs-build"))
    : "";
  if (!rsBuild) {
    const log = execFileSync(
      "bash",
      [join(SCRIPT_DIR, "build-rs-core.sh"), "--wasm-only"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const sha = /^sha=(.+)$/m.exec(log)?.[1];
    if (!sha)
      throw new Error(
        `gate8-delivery-tool: build-rs-core.sh printed no sha:\n${log}`,
      );
    rsBuild = join(
      REPO_ROOT,
      "artifacts",
      "render-stream",
      "rs-core",
      sha.trim(),
    );
  }
  const bundle = await buildGswBundle(join(g8kp, "gsw-bundle"), rsBuild);
  const nativeDir = join(g8kp, "receiver");
  if (!existsSync(join(nativeDir, "env.txt")))
    throw new Error(
      `gate8-delivery-tool: no native leg at ${nativeDir} (env.txt missing)`,
    );
  const sabotageSkipped = process.env.RS_SABOTAGE_TIER === "skip";
  const legs: WebLegSpec[] = [
    { leg: "gsw", nativeDir, webDir: join(run, "gsw") },
    {
      leg: "gsw-masked",
      nativeDir,
      webDir: join(run, "gsw-masked"),
      extraEnv: { RS_RECEIVER_GPU_FORMAT_MASK: mask },
    },
  ];
  const sabotageDir = join(run, "sabotage-ignore-format-mask", "gsw");
  if (sabotageSkipped) {
    await mkdir(sabotageDir, { recursive: true });
    await writeFile(
      join(sabotageDir, "skipped-by-tier.txt"),
      "skipped-by-tier: RS_SABOTAGE_TIER=skip (a sabotage leg)\n",
    );
  } else {
    legs.push({
      leg: "sabotage-ignore-format-mask/gsw",
      nativeDir,
      webDir: sabotageDir,
      extraEnv: {
        RS_RECEIVER_GPU_FORMAT_MASK: mask,
        RS_RECEIVER_SABOTAGE: "ignore-format-mask",
      },
    });
  }
  const results = await runWebLegs(
    {
      out: run,
      gate: "gate8",
      sourceDir: source,
      bundleDir: bundle.dir,
      buildSha256: bundle.sha256,
      kind: "gsw",
    },
    legs,
  );
  for (const r of results)
    console.log(
      `gate8-delivery-tool: ${r.leg} exit ${r.exitCode}${r.provenanceOk ? "" : " (harness-refused: browser-provenance)"} ${r.wallMs} ms`,
    );
}

main().catch((e: unknown) => {
  console.error(
    `gate8-delivery-tool: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
  process.exit(1);
});
