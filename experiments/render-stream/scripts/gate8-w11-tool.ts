#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 8 group g8w11's receiver legs (W11c's GSW legs, W11d's native ones;
// protocol/render-stream-11.md "Receivers"), called by run-gate8.sh after the g8w11 captures:
//
//   gate8-w11-tool.ts gsw-legs --source <gate 8 run> [--rs-build <artifacts/render-stream/rs-core/<sha>>]
//   gate8-w11-tool.ts native-plan --source <gate 8 run>
//   gate8-w11-tool.ts gsw-legs --set pt13 --source <gate 8 run> [--rs-build ...]   (W13c)
//
// native-plan (W11d) prints one tab-separated line per leg for run-gate8.sh's native receiver
// legs (the same legs, captures and shot frames as the GSW legs below): the native leg directory
// relative to <run>/g8w11 (`<capture's directory>[/sabotage-<kind>]/receiver`), the capture
// directory, the sink, the shot seqs (CSV), the receiver sabotage ("-" for none) and the session's
// canvas size (the receiver's --resolution, as the GSW legs' plan has it); and writes
// <run>/g8w11/native-frames.json ({native leg: {frame: seq}}). Gate 7's g7-8 GSW half replays these
// native legs (lib/gate7-gsw-g8.ts) and judges them with the native checks
// (lib/gate8-w11-native-checks.ts).
//
// Builds the rs-core wasm (build-rs-core.sh --wasm-only, unless --rs-build names one) and the GSW
// bundle (lib/gsw-bundle.ts) under <run>/g8w11/gsw-bundle, then replays g8w11's captures in the GSW
// receiver page, in the repo-private pinned headless Chromium (lib/gate7-web-legs.ts, the gate 7
// file groups' runner), one leg each under <run>/g8w11/gsw/<leg>/gsw. A leg's planned launch
// (env.txt, argv.txt: the recording, its store, shot seqs) is written to <leg>/plan first, as a
// native receiver leg's would be; g8w11 has no native receiver (W11d).
//
//   scale, scale-v10           capture-scale's patch sink at /11 (auto) and its /10 twin
//   scale-off                  capture-scale at /11 under GRC_MESH_DYNAMIC=off (every pose a hash)
//   scene, scene-v10           gate6-scene animate's patch sink at /11 (auto) and its /10 twin
//   scene-off                  gate6-scene at /11 under off (MS's poses return every 90 frames)
//   mesh, mesh-v10             gate5-mesh's full sink at /11 (auto) and its /10 twin
//   sabotage-stale-dynamic-rx/scene       a dynamic body is ignored when its shape holds
//   sabotage-no-prune/scene-off           the validator keeps C lifelong
//   sabotage-evict-carried/scene-off      a carried record is dropped on arrival
//   sabotage-ignore-released/scale-off    the store never drops what left H
//
// W13c (render-stream-13.md "As built (W13c)"): GSW's /13 legs on W13b's /13 captures, with their
// /12 twins (GSW-only until W13d: native-plan leaves them out, the native receiver refuses /13):
//
//   scale13, scale13-v12       capture-scale's patch sink at /13 and its /12 twin
//   mesh13, mesh13-v12         gate5-mesh's full sink at /13 and its /12 twin; their shot frames
//                              are the /11 mesh leg's too (frame group mesh13 holds mesh/capture)
//   sabotage-no-predict-reset/mesh13      a full un-predicted against the history (no reset):
//                              the second full transaction fails predict-check
//
// `--set pt13` (run_g8pt, after the g8pt captures) replays gate 8 g8pt's headless /13 twins the
// same way under <run>/g8pt/gsw13/<leg>/gsw: pump13 and pump13-v12 (fixtures/gate8-mm under the
// frame_pre_draw pump: multimesh buffers, shot at g8mm's settle frames when g8mm ran), shim13 and
// shim13-v12 (fixtures/gate8-pt under the headless particles shim). lib/gate8-w13-gsw-checks.ts
// judges them too.
//
// lib/gate8-w13-gsw-checks.ts judges them.
//
// Shots: the frames both twins hold (up to six, evenly spread, the last included), each leg at the
// seq of that frame in its own recording; every leg writes perf.json (`gsw.w11`, the module's /11
// evidence). lib/gate8-w11-gsw-checks.ts judges them.
//
// RS_SABOTAGE_TIER=skip (the smoke tier) leaves the sabotage legs out with skipped-by-tier.txt, as
// lib/legs.sh does for a native sabotage leg.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeRecording, resolveRecording } from "./lib/render-stream-2";
import { runWebLegs, type WebLegSpec } from "./lib/gate7-web-legs";
import { buildGswBundle } from "./lib/gsw-bundle";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const BINARY = join(
  process.env.HOME ?? "",
  ".cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64",
);

/** One g8w11 GSW leg: which capture it replays, and its twin for the shot frames. */
export interface W11GswLeg {
  leg: string;
  capture: string;
  sink: string;
  version: 10 | 11 | 12 | 13;
  /** The leg whose frames this one's shots share (its own name for a /11 leg with a twin). */
  frames: string;
  sabotage?: string;
  /** W13c: a GSW-only leg (no native receiver leg until W13d). */
  gswOnly?: true;
}

export const W11_GSW_LEGS: W11GswLeg[] = [
  { leg: "scale", capture: "scale/capture", sink: "recording-patch.rs11", version: 11, frames: "scale" },
  { leg: "scale-v10", capture: "scale/v10/capture", sink: "recording-patch.rs10", version: 10, frames: "scale" },
  { leg: "scale-off", capture: "scale/off/capture", sink: "recording-patch.rs11", version: 11, frames: "scale" },
  { leg: "scene", capture: "scene/capture", sink: "recording-patch.rs11", version: 11, frames: "scene" },
  { leg: "scene-v10", capture: "scene/v10/capture", sink: "recording-patch.rs10", version: 10, frames: "scene" },
  { leg: "scene-off", capture: "scene/off/capture", sink: "recording-patch.rs11", version: 11, frames: "scene" },
  { leg: "mesh", capture: "mesh/capture", sink: "recording.rs11", version: 11, frames: "mesh" },
  { leg: "mesh-v10", capture: "mesh/v10/capture", sink: "recording.rs10", version: 10, frames: "mesh" },
  {
    // gate6-scene's MS moves visibly between poses; capture-scale's heights move by frame * 0.001,
    // under a pixel, so a stale pose there leaves the shots unchanged.
    leg: "sabotage-stale-dynamic-rx/scene",
    capture: "scene/capture",
    sink: "recording-patch.rs11",
    version: 11,
    frames: "scene",
    sabotage: "stale-dynamic-rx",
  },
  {
    leg: "sabotage-no-prune/scene-off",
    capture: "scene/off/capture",
    sink: "recording-patch.rs11",
    version: 11,
    frames: "scene",
    sabotage: "no-prune",
  },
  {
    leg: "sabotage-evict-carried/scene-off",
    capture: "scene/off/capture",
    sink: "recording-patch.rs11",
    version: 11,
    frames: "scene",
    sabotage: "evict-carried",
  },
  {
    leg: "sabotage-ignore-released/scale-off",
    capture: "scale/off/capture",
    sink: "recording-patch.rs11",
    version: 11,
    frames: "scale",
    sabotage: "ignore-released",
  },
  // W13c: /13 and the /12 twins (GSW-only until W13d).
  { leg: "scale13", capture: "scale13/capture", sink: "recording-patch.rs13", version: 13, frames: "scale13", gswOnly: true },
  { leg: "scale13-v12", capture: "scale13/v12/capture", sink: "recording-patch.rs12", version: 12, frames: "scale13", gswOnly: true },
  { leg: "mesh13", capture: "mesh13/capture", sink: "recording.rs13", version: 13, frames: "mesh13", gswOnly: true },
  { leg: "mesh13-v12", capture: "mesh13/v12/capture", sink: "recording.rs12", version: 12, frames: "mesh13", gswOnly: true },
  {
    // gate5-mesh's full sink: every transaction full, its dynamic units carried across each one.
    leg: "sabotage-no-predict-reset/mesh13",
    capture: "mesh13/capture",
    sink: "recording.rs13",
    version: 13,
    frames: "mesh13",
    sabotage: "no-predict-reset",
    gswOnly: true,
  },
];

/** W13c (`--set pt13`): g8pt's headless /13 captures and their /12 twins, under <run>/g8pt. */
export const W13_PT_LEGS: W11GswLeg[] = [
  { leg: "pump13", capture: "headless-pump13/capture", sink: "recording.rs13", version: 13, frames: "pump13", gswOnly: true },
  { leg: "pump13-v12", capture: "headless-pump/capture", sink: "recording.rs12", version: 12, frames: "pump13", gswOnly: true },
  { leg: "shim13", capture: "headless-shim13/capture", sink: "recording.rs13", version: 13, frames: "shim13", gswOnly: true },
  { leg: "shim13-v12", capture: "headless-shim/capture", sink: "recording.rs12", version: 12, frames: "shim13", gswOnly: true },
];
const PT13_FRAME_GROUPS: Record<string, string[]> = {
  pump13: ["headless-pump13/capture", "headless-pump/capture"],
  shim13: ["headless-shim13/capture", "headless-shim/capture"],
};

/** The frame groups: which captures' frames the shots must share (the /11 legs and the twin). */
/** W11d: a leg's native receiver directory under <run>/g8w11. */
export function nativeLeg(def: W11GswLeg): string {
  const base = dirname(def.capture);
  return def.sabotage
    ? `${base}/sabotage-${def.sabotage}/receiver`
    : `${base}/receiver`;
}

const FRAME_GROUPS: Record<string, string[]> = {
  scale: ["scale/capture", "scale/v10/capture", "scale/off/capture"],
  scene: ["scene/capture", "scene/v10/capture", "scene/off/capture"],
  mesh: ["mesh/capture", "mesh/v10/capture"],
  // W13c: the /13 legs, their /12 twins (and, for mesh13, the /11 mesh leg's frames).
  scale13: ["scale13/capture", "scale13/v12/capture"],
  mesh13: ["mesh13/capture", "mesh13/v12/capture", "mesh/capture"],
};

function flag(argv: string[], name: string, fallback?: string): string {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`gate8-w11-tool: ${name} is required`);
}

/** frame -> seq of every transaction of a recording, and the session's canvas size. */
function frameSeqs(path: string, version: 10 | 11 | 12 | 13): {
  bySeq: Map<number, number>;
  canvas: [number, number];
} {
  const data = new Uint8Array(readFileSync(path));
  const rec = resolveRecording(data, version);
  const bySeq = new Map<number, number>();
  for (const t of rec.transactions) bySeq.set(t.frame, t.seq);
  const session = decodeRecording(data, version).records[0].meta as {
    viewport?: {
      logical_size: [number, number];
      presentation_size?: [number, number];
    };
  };
  const vp = session.viewport;
  const size = vp?.presentation_size ?? vp?.logical_size ?? [640, 360];
  return { bySeq, canvas: [Math.max(1, size[0]), Math.max(1, size[1])] };
}

/** Up to `n` frames every recording of a group holds, evenly spread, the last included. */
export function sharedFrames(
  maps: readonly Map<number, number>[],
  n: number,
): number[] {
  if (maps.length === 0) return [];
  const common = [...maps[0].keys()]
    .filter((f) => maps.every((m) => m.has(f)))
    .sort((a, b) => a - b);
  if (common.length <= n) return common;
  const out = new Set<number>();
  for (let k = 1; k <= n; k++)
    out.add(common[Math.round((k * (common.length - 1)) / n)]);
  return [...out].sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "gsw-legs" && argv[0] !== "native-plan")
    throw new Error(
      "usage: gate8-w11-tool.ts gsw-legs|native-plan --source <gate 8 run> [--rs-build dir]",
    );
  const source = resolve(flag(argv, "--source"));
  const pt13 = flag(argv, "--set", "w11") === "pt13";
  const g = join(source, pt13 ? "g8pt" : "g8w11");
  const run = join(g, pt13 ? "gsw13" : "gsw");
  if (argv[0] === "native-plan") {
    await nativePlan(g);
    return;
  }
  let rsBuild = argv.includes("--rs-build")
    ? resolve(flag(argv, "--rs-build"))
    : "";
  if (!rsBuild) {
    const log = execFileSync(
      "bash",
      [join(SCRIPT_DIR, "build-rs-core.sh"), "--wasm-only"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const sha = /^sha=(.+)$/m.exec(log)?.[1];
    if (!sha)
      throw new Error(`gate8-w11-tool: build-rs-core.sh printed no sha:\n${log}`);
    rsBuild = join(REPO_ROOT, "artifacts", "render-stream", "rs-core", sha.trim());
  }
  const bundle = await buildGswBundle(join(g, "gsw-bundle"), rsBuild);
  const legs = pt13 ? W13_PT_LEGS : W11_GSW_LEGS;
  const { recOf, groupFrames } = shotPlan(g, legs, pt13 ? PT13_FRAME_GROUPS : FRAME_GROUPS);
  if (pt13) {
    // pump13: g8mm's settle frames (and the frame before each), the frames its reference shot.
    const steps = join(source, "g8mm", "capture", "steps.jsonl");
    if (existsSync(steps)) {
      const settle = readFileSync(steps, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .flatMap((l) => {
          const f = (JSON.parse(l) as { settle_frame: number }).settle_frame;
          return [f - 1, f];
        });
      const maps = PT13_FRAME_GROUPS.pump13.flatMap((c) => {
        const def = legs.find((l) => l.capture === c);
        const r = def ? recOf(def.capture, def.sink, def.version) : null;
        return r ? [r.bySeq] : [];
      });
      groupFrames.set(
        "pump13",
        settle.filter((f) => maps.length > 0 && maps.every((m) => m.has(f))),
      );
    }
  }
  await gswLegs(g, run, source, bundle, recOf, groupFrames, legs);
}

/** Shot frames per group: shared by every capture of the group that exists. */
function shotPlan(
  g: string,
  legs: readonly W11GswLeg[] = W11_GSW_LEGS,
  groups: Record<string, string[]> = FRAME_GROUPS,
) {
  const recs = new Map<string, ReturnType<typeof frameSeqs>>();
  const recOf = (capture: string, sink: string, version: 10 | 11 | 12 | 13) => {
    const key = `${capture}/${sink}`;
    if (!recs.has(key)) {
      const path = join(g, capture, sink);
      if (!existsSync(path)) return null;
      recs.set(key, frameSeqs(path, version));
    }
    return recs.get(key) ?? null;
  };
  const groupFrames = new Map<string, number[]>();
  for (const [group, captures] of Object.entries(groups)) {
    const maps: Map<number, number>[] = [];
    for (const capture of captures) {
      const def = legs.find((l) => l.capture === capture && !l.sabotage);
      if (!def) continue;
      const r = recOf(def.capture, def.sink, def.version);
      if (r) maps.push(r.bySeq);
    }
    groupFrames.set(group, sharedFrames(maps, 6));
  }
  return { recOf, groupFrames };
}

/** W11d: native-plan (header). */
async function nativePlan(g: string): Promise<void> {
  const { recOf, groupFrames } = shotPlan(g);
  const frames: Record<string, Record<string, number>> = {};
  const lines: string[] = [];
  for (const def of W11_GSW_LEGS) {
    // W13c: the /13 legs are GSW's alone until W13d.
    if (def.gswOnly) continue;
    const r = recOf(def.capture, def.sink, def.version);
    const shot: Record<string, number> = {};
    for (const f of groupFrames.get(def.frames) ?? []) {
      const seq = r?.bySeq.get(f);
      if (seq !== undefined) shot[String(f)] = seq;
    }
    const leg = nativeLeg(def);
    frames[leg] = shot;
    lines.push(
      [
        leg,
        def.capture,
        def.sink,
        Object.values(shot).join(",") || "-",
        def.sabotage ?? "-",
        r ? `${r.canvas[0]}x${r.canvas[1]}` : "-",
      ].join("\t"),
    );
  }
  await writeFile(join(g, "native-frames.json"), `${JSON.stringify(frames, null, 1)}\n`);
  console.log(lines.join("\n"));
}

async function gswLegs(
  g: string,
  run: string,
  source: string,
  bundle: { dir: string; sha256: string },
  recOf: ReturnType<typeof shotPlan>["recOf"],
  groupFrames: Map<string, number[]>,
  defs: readonly W11GswLeg[] = W11_GSW_LEGS,
): Promise<void> {
  const sabotageSkipped = process.env.RS_SABOTAGE_TIER === "skip";
  const legs: WebLegSpec[] = [];
  const frames: Record<string, Record<string, number>> = {};
  for (const def of defs) {
    const legDir = join(run, def.leg);
    const webDir = join(legDir, "gsw");
    await mkdir(legDir, { recursive: true });
    if (def.sabotage && sabotageSkipped) {
      await mkdir(webDir, { recursive: true });
      await writeFile(
        join(webDir, "skipped-by-tier.txt"),
        "skipped-by-tier: RS_SABOTAGE_TIER=skip (a sabotage leg)\n",
      );
      continue;
    }
    const r = recOf(def.capture, def.sink, def.version);
    if (!r) {
      await mkdir(webDir, { recursive: true });
      await writeFile(
        join(webDir, "skipped.txt"),
        `no capture at ${join(def.capture, def.sink)}\n`,
      );
      continue;
    }
    const shot: Record<string, number> = {};
    for (const f of groupFrames.get(def.frames) ?? []) {
      const seq = r.bySeq.get(f);
      if (seq !== undefined) shot[String(f)] = seq;
    }
    frames[def.leg] = shot;
    const plan = join(legDir, "plan");
    await mkdir(plan, { recursive: true });
    const env = [
      `RS_RECEIVER_RECORDING=${join(g, def.capture, def.sink)}`,
      `RS_RECEIVER_OUT=${join(plan, "applied.json")}`,
      `RS_RECEIVER_PERF_OUT=${join(plan, "perf.json")}`,
      `RS_RECEIVER_SHOT_SEQS=${Object.values(shot).join(",")}`,
      `RS_RECEIVER_STORE_DIR=${join(g, def.capture, "store")}`,
      ...(def.sabotage ? [`RS_RECEIVER_SABOTAGE=${def.sabotage}`] : []),
    ];
    await writeFile(join(plan, "env.txt"), `${env.join("\n")}\n`);
    await writeFile(
      join(plan, "argv.txt"),
      `${[BINARY, "--path", join(SCRIPT_DIR, "..", "receiver"), "--resolution", `${r.canvas[0]}x${r.canvas[1]}`].join("\n")}\n`,
    );
    await writeFile(join(legDir, "frames.json"), `${JSON.stringify(shot)}\n`);
    legs.push({ leg: def.leg, nativeDir: plan, webDir });
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
      `gate8-w11-tool: ${r.leg} exit ${r.exitCode}${r.provenanceOk ? "" : " (harness-refused: browser-provenance)"} ${r.wallMs} ms`,
    );
  await writeFile(join(run, "frames.json"), `${JSON.stringify(frames, null, 1)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
