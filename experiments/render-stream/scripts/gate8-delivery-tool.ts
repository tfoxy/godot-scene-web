#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 8 groups g8kp's and g8ku's browser legs (G8kp, protocol/texture-delivery-design.md D3, Q3,
// Q6 "GSW"; G8ku, Q6 "Web export"), called by run-gate8.sh after the native legs:
//
//   gate8-delivery-tool.ts gsw-legs --source <gate 8 run> [--mask s3tc,bptc,rgtc]
//       [--rs-build <artifacts/render-stream/rs-core/<sha>>]
//   gate8-delivery-tool.ts web-legs --source <gate 8 run> [--bundle <web-receiver bundle dir>]
//
// G8kf: gsw-legs also replays g8kp/receiver in the web export (g8kp-web/web: does the web export
// state gpu_formats and take `block` variants at /9?), and web-legs replays
// g8ku/sabotage-corrupt-ktx2/receiver as g8ku-web/web-fallback and g8ku/pending/receiver as
// g8ku-web/web-pending.
//
// web-legs (G8ku): builds the web export (build-web-receiver.sh, which builds the rs-core side
// module first; reused when its source digest is unchanged) unless --bundle names one, then
// replays the native leg g8ku/receiver-upgrade (its env.txt and argv.txt: the /9 basis-uastc
// recording, its store, shot seqs, RS_RECEIVER_VARIANT_POLICY=upgrade and RS_RECEIVER_TRANSCODE_LOG=1)
// in the web export, in the pinned headless Chromium: g8ku-web/web. The web export transcodes
// the uastc variants with the same engine call (Image.load_ktx_from_buffer, in wasm, on the main
// thread), so its transcodes[] carry the desktop transcode cost (D14 target: the WebGL context's).
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
import { existsSync, readFileSync } from "node:fs";
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
  if (command === "web-legs") {
    await webLegs(argv);
    return;
  }
  if (command !== "gsw-legs")
    throw new Error(
      "usage: gate8-delivery-tool.ts gsw-legs --source <gate 8 run> [--mask list] | web-legs --source <gate 8 run> [--bundle dir]",
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
  await webBlockLeg(source, []);
}

// The web export's bundle: --bundle names one, else build-web-receiver.sh builds (or reuses) it.
function webBundle(argv: string[]): { dir: string; sha256: string } {
  let bundle = argv.includes("--bundle") ? resolve(flag(argv, "--bundle")) : "";
  if (!bundle) {
    const log = execFileSync(
      "bash",
      [join(SCRIPT_DIR, "build-web-receiver.sh"), "--core", "rust"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    bundle = log.trim().split("\n").pop()?.trim() ?? "";
    if (!bundle || !existsSync(join(bundle, "build.json")))
      throw new Error(
        `gate8-delivery-tool: build-web-receiver.sh printed no bundle directory:\n${log}`,
      );
  }
  const build = JSON.parse(
    readFileSync(join(bundle, "build.json"), "utf8"),
  ) as { pck: { sha256: string } };
  return { dir: bundle, sha256: build.pck.sha256 };
}

// G8kf: the web export on g8kp/receiver's own launch (the /9 passthrough recording): does it state
// gpu_formats and take `block` variants? g8kp-web/web, a harness root beside g8kp/ like g8ku-web.
async function webBlockLeg(source: string, argv: string[]): Promise<void> {
  const g8kp = join(source, "g8kp");
  const nativeDir = join(g8kp, "receiver");
  if (!existsSync(join(nativeDir, "env.txt")))
    throw new Error(
      `gate8-delivery-tool: no native leg at ${nativeDir} (env.txt missing)`,
    );
  const bundle = webBundle(argv);
  const run = join(source, "g8kp-web");
  const results = await runWebLegs(
    {
      out: run,
      gate: "gate8",
      sourceDir: g8kp,
      bundleDir: bundle.dir,
      buildSha256: bundle.sha256,
      kind: "web",
    },
    [{ leg: "web", nativeDir, webDir: join(run, "web") }],
  );
  for (const r of results)
    console.log(
      `gate8-delivery-tool: g8kp-web ${r.leg} exit ${r.exitCode}${r.provenanceOk ? "" : " (harness-refused: browser-provenance)"} ${r.wallMs} ms`,
    );
}

// G8ku: the web export on g8ku/receiver-upgrade's own launch; G8kf adds web-fallback, the same on
// g8ku/sabotage-corrupt-ktx2/receiver's (a KTX2 the transcoder refuses: Q3's fallback to decoded).
async function webLegs(argv: string[]): Promise<void> {
  const source = resolve(flag(argv, "--source"));
  const g8ku = join(source, "g8ku");
  // The harness's static root links its source run at sources/gate8. It sits beside g8ku/, not in
  // it, and links g8ku/ alone: a link to the whole run from inside it (as g8kp's gsw-run has) would
  // make a second cycle, and a recursive walk through two cycles never ends (the remote job's
  // artifact trim globs every stdout.log through symlinks).
  const run = join(source, "g8ku-web");
  const bundle = webBundle(argv);
  const nativeDir = join(g8ku, "receiver-upgrade");
  if (!existsSync(join(nativeDir, "env.txt")))
    throw new Error(
      `gate8-delivery-tool: no native leg at ${nativeDir} (env.txt missing)`,
    );
  const legs: WebLegSpec[] = [
    { leg: "web", nativeDir, webDir: join(run, "web") },
  ];
  const fallbackDir = join(g8ku, "sabotage-corrupt-ktx2", "receiver");
  if (existsSync(join(fallbackDir, "env.txt")))
    legs.push({
      leg: "web-fallback",
      nativeDir: fallbackDir,
      webDir: join(run, "web-fallback"),
    });
  const pendingDir = join(g8ku, "pending", "receiver");
  if (existsSync(join(pendingDir, "env.txt")))
    legs.push({
      leg: "web-pending",
      nativeDir: pendingDir,
      webDir: join(run, "web-pending"),
    });
  const results = await runWebLegs(
    {
      out: run,
      gate: "gate8",
      sourceDir: g8ku,
      bundleDir: bundle.dir,
      buildSha256: bundle.sha256,
      kind: "web",
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
