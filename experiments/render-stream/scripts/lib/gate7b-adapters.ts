// Gate 7 adapters for gates 1 to 6 (G7b; gate7-design.md "G7b", Q4, Q7, Q8, D11, D21, D34): the
// web-export receiver replays EVERY file receiver leg of a native source run of each gate, and each
// gate's OWN checker judges the result, unforked.
//
// Three things make this generic rather than a hand-written table per gate:
//
// 1. Discovery. A file receiver leg is any directory of the source run whose env.txt sets
//    RS_RECEIVER_RECORDING (and not RS_RECEIVER_URL, which is a live leg, G7l's) and whose argv
//    launched the pinned release template on the receiver project. Three kinds are not replayed,
//    each typed with its reason (never silently): `native-only-trace` (the leg exists to strace the
//    native process, which a browser cannot), `native-only-editor` (a support leg on the debug
//    editor, e.g. gate 1's receiver-typecheck), and `live-derived` (a replay of a live leg's own
//    received tap; it belongs to the live groups, G7l).
// 2. The view. `<out>/<gate>/web-view/` mirrors the source run, every entry a symlink to the
//    source, except each replayed leg, which links to its web leg directory. Its legs.json names
//    only the gate's file-leg groups (`viewGroups`), so the live groups' checks (G7l's, and the
//    ones that write report sets into their legs) never run here. The gate's own CLI checker
//    (`check-gate<N>.ts --out <view>`) then judges the view exactly as it judges a native run.
// 3. Which checks are the web's. The same checker also judges `native-view/` (the same view with
//    no leg replaced) and `blank-view/` (every replayed leg replaced by an empty directory). A check
//    whose verdict or detail changes between those two reads a replayed leg; that set, and only
//    it, is reported `<id>@web`. Every other check judges only the source run's captures,
//    references and native-only legs (D11, D21), so it is not repeated. The classification is
//    written to `<out>/<gate>/classification.json` for review.
//
// Gate 7's own checks are added per gate: source-run-valid, browser-provenance, console-clean,
// evidence-complete, applied-equals-native, compositor-equals-readback (on the gate's honest full
// legs whose last shot is of the state the canvas shows at exit), and P-W1's per-shot web-vs-
// native triangulation (Q7: report only, but every non-zero diff is listed).

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodePngRgba } from "./gate-minus1-checks";
import { diffRgba } from "./gate0-checks";
import {
  appliedCore,
  dropCrossCoreDetail,
  filesUnder,
  type Gate7Check,
  type Gate7GroupResult,
  jsonDiffPaths,
  mk,
  nativeOnly,
  normalizeApplied,
  readJson,
  type SourceProvenance,
  sha256File,
  sourceProvenanceProblems,
} from "./gate7-adapters";
import type { WebLegSpec } from "./gate7-web-legs";
import { resolveRecording, statesEqual } from "./render-stream-2";

const SCRIPT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");

export interface GateDef {
  /** The source run's gate key (`--source <gate>=<dir>`). */
  gate: string;
  /** The gate 7 leg group. */
  group: string;
  /** The gate's own CLI checker under scripts/. */
  checker: string;
  /** The source groups whose legs are file legs (Q8); the view's legs.json names only these
   * (intersected with what the source ran). */
  viewGroups: readonly string[];
  /** run-gate<N>.sh's --legs for a source run made by run-gate7.sh --make-sources. */
  sourceLegs: string;
  runner: string;
}

/** Q8's file-leg groups per gate; the live groups (g1c, g1d, g2c, g2e, g5f, g55f, g6l) are G7l's
 * and G7g's, the rate, soak and report groups (g6s, g6c, g6p, g6z) G7r's, G7k's and G7p's. */
export const GATE7B_GATES: readonly GateDef[] = [
  {
    gate: "gate1",
    group: "g7-1",
    checker: "check-gate1.ts",
    viewGroups: ["g1a", "g1b"],
    sourceLegs: "g1a,g1b",
    runner: "run-gate1.sh",
  },
  {
    gate: "gate2",
    group: "g7-2",
    checker: "check-gate2.ts",
    viewGroups: ["g2a", "g2b", "g2d"],
    sourceLegs: "g2a,g2b,g2d",
    runner: "run-gate2.sh",
  },
  {
    gate: "gate3",
    group: "g7-3",
    checker: "check-gate3.ts",
    viewGroups: ["g3a", "g3b", "g3c", "g3d"],
    sourceLegs: "g3a,g3b,g3c,g3d",
    runner: "run-gate3.sh",
  },
  {
    gate: "gate4",
    group: "g7-4",
    checker: "check-gate4.ts",
    viewGroups: ["g4a", "g4b", "g4c", "g4d", "g4e", "g4f"],
    sourceLegs: "g4a,g4b,g4c,g4d,g4e,g4f",
    runner: "run-gate4.sh",
  },
  {
    gate: "gate5",
    group: "g7-5",
    checker: "check-gate5.ts",
    viewGroups: ["g5b", "g5c", "g5d", "g5e", "g5g"],
    sourceLegs: "g5b,g5c,g5d,g5e,g5g",
    runner: "run-gate5.sh",
  },
  {
    gate: "gate55",
    group: "g7-55",
    checker: "check-gate55.ts",
    viewGroups: ["g55b", "g55c", "g55d", "g55e"],
    sourceLegs: "g55b,g55c,g55d,g55e",
    runner: "run-gate55.sh",
  },
  {
    gate: "gate6",
    group: "g7-6",
    checker: "check-gate6.ts",
    viewGroups: ["g6a", "g6h", "g6b"],
    sourceLegs: "g6a,g6h,g6b",
    runner: "run-gate6.sh",
  },
];

export function gateDefForGroup(group: string): GateDef | undefined {
  return GATE7B_GATES.find((g) => g.group === group);
}

export type ExcludedReason =
  | "native-only-trace"
  | "native-only-editor"
  | "native-only-warm-cache"
  | "live-derived";

export interface DiscoveredLeg {
  leg: string;
  nativeDir: string;
  /** The native leg ran --headless (D11: a browser always renders). */
  headless: boolean;
  /** The native leg's --resolution, if any (the presentation size; the web canvas). */
  resolution: string | null;
  sabotage: string | null;
  excluded: ExcludedReason | null;
  excludedDetail: string;
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

function envOf(dir: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of readLines(join(dir, "env.txt"))) {
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) env.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return env;
}

function legDirs(root: string, prefix = ""): string[] {
  const out: string[] = [];
  const here = join(root, prefix);
  let entries: string[];
  try {
    entries = readdirSync(here).sort();
  } catch {
    return out;
  }
  if (
    prefix !== "" &&
    entries.includes("argv.txt") &&
    entries.includes("env.txt")
  )
    out.push(prefix);
  for (const e of entries) {
    const rel = prefix === "" ? e : `${prefix}/${e}`;
    const abs = join(root, rel);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (
      e === "shots" ||
      e === "diff" ||
      e === "cache" ||
      e === "store" ||
      e === "evidence"
    )
      continue;
    out.push(...legDirs(root, rel));
  }
  return out;
}

/** Every file receiver leg of a native source run (header, 1). */
export function discoverFileReceiverLegs(sourceDir: string): DiscoveredLeg[] {
  const all = legDirs(sourceDir);
  // Received taps of the source's live receivers (live-derived file legs replay one of them).
  const liveTaps = new Set<string>();
  for (const rel of all) {
    const env = envOf(join(sourceDir, rel));
    if (!env.has("RS_RECEIVER_URL")) continue;
    for (const f of filesUnder(join(sourceDir, rel))) {
      if (f.endsWith(".rs2") && !f.includes("/"))
        liveTaps.add(sha256File(join(sourceDir, rel, f)));
    }
  }
  const out: DiscoveredLeg[] = [];
  for (const rel of all) {
    const dir = join(sourceDir, rel);
    const env = envOf(dir);
    if (!env.has("RS_RECEIVER_RECORDING") || env.has("RS_RECEIVER_URL"))
      continue;
    const argv = readLines(join(dir, "argv.txt")).filter((l) => l !== "");
    const pathIdx = argv.indexOf("--path");
    const project = pathIdx >= 0 ? (argv[pathIdx + 1] ?? "") : "";
    if (basename(project) !== "receiver") continue;
    const resIdx = argv.indexOf("--resolution");
    const leg: DiscoveredLeg = {
      leg: rel,
      nativeDir: dir,
      headless: argv.includes("--headless"),
      resolution: resIdx >= 0 ? (argv[resIdx + 1] ?? null) : null,
      sabotage: env.get("RS_RECEIVER_SABOTAGE") ?? null,
      excluded: null,
      excludedDetail: "",
    };
    const recording = join(dir, "recording.rs2");
    if (basename(argv[0] ?? "") !== "linux_release.x86_64") {
      leg.excluded = "native-only-editor";
      leg.excludedDetail = `launched ${basename(argv[0] ?? "?")}, not the release template (a native support leg)`;
    } else if (
      existsSync(join(dir, "strace.txt")) ||
      existsSync(join(dir, "strace-status.txt"))
    ) {
      leg.excluded = "native-only-trace";
      leg.excludedDetail =
        "the leg straces the native receiver process (D11: its checks read strace.txt; a browser has no such trace)";
    } else if (env.get("RS_RECEIVER_CACHE_MODE") === "warm") {
      leg.excluded = "native-only-warm-cache";
      leg.excludedDetail =
        "replays onto another leg's receiver-side disk cache (RS_RECEIVER_CACHE_MODE=warm); Q4: RS_RECEIVER_CACHE_DIR is native only and the web's cache is the browser's HTTP cache (G7k's startup-warm legs)";
    } else if (existsSync(recording) && liveTaps.has(sha256File(recording))) {
      leg.excluded = "live-derived";
      leg.excludedDetail =
        "replays a live receiver's received tap: a live group's leg (G7l)";
    }
    out.push(leg);
  }
  return out;
}

/** The legs whose compositor screenshot is taken: the honest full-sink receivers of each fixture
 * (a leg named `receiver` or ending `/receiver`, no sabotage) and every honest HD presentation leg
 * (`--resolution`, no sabotage, not patch/inline). */
function wantsCompositor(leg: DiscoveredLeg): boolean {
  if (leg.sabotage || leg.headless) return false;
  if (leg.leg.includes("sabotage")) return false;
  const name = basename(leg.leg);
  if (name === "receiver") return true;
  return leg.resolution !== null && !/patch|inline|at-logical/.test(name);
}

/** The web leg specs for a gate's source run, under `<webRoot>` (= `<out>/<gate>/web`). */
export function webLegSpecs(
  sourceDir: string,
  webRoot: string,
): { specs: WebLegSpec[]; discovered: DiscoveredLeg[] } {
  const discovered = discoverFileReceiverLegs(sourceDir);
  const specs: WebLegSpec[] = discovered
    .filter((d) => d.excluded === null)
    .map((d) => ({
      leg: d.leg,
      nativeDir: d.nativeDir,
      webDir: join(webRoot, d.leg),
      compositor: wantsCompositor(d),
    }));
  return { specs, discovered };
}

/** Builds `viewDir` (header, 2): the source with each `replaced` leg linked to its target. */
export async function buildMirrorView(
  sourceDir: string,
  replaced: ReadonlyMap<string, string>,
  viewDir: string,
  viewGroups: readonly string[],
  relocated: readonly string[] = [],
): Promise<void> {
  await rm(viewDir, { recursive: true, force: true });
  await mkdir(viewDir, { recursive: true });
  // A `relocated` leg (a native strace leg) is a real directory in the view: its files are links,
  // except strace.txt, which is copied with the source run's absolute path rewritten to the view's
  // (the trace recorded where the native process opened its recording; the checkers expect the
  // run they judge). Evidence relocation only: no other byte changes.
  const relocate = async (r: string): Promise<void> => {
    await mkdir(join(viewDir, r), { recursive: true });
    for (const f of readdirSync(join(sourceDir, r))) {
      if (f === "strace.txt")
        await writeFile(
          join(viewDir, r, f),
          readFileSync(join(sourceDir, r, f), "utf8")
            .split(resolve(sourceDir))
            .join(viewDir),
        );
      else symlinkSync(join(sourceDir, r, f), join(viewDir, r, f));
    }
  };
  const keys = [...replaced.keys(), ...relocated];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of readdirSync(join(sourceDir, rel))) {
      const r = rel === "" ? entry : `${rel}/${entry}`;
      if (rel === "" && (entry === "result.json" || entry === "legs.json"))
        continue;
      const target = replaced.get(r);
      if (target !== undefined) {
        symlinkSync(target, join(viewDir, r));
        continue;
      }
      if (relocated.includes(r)) {
        await relocate(r);
        continue;
      }
      const src = join(sourceDir, r);
      if (
        keys.some((k) => k.startsWith(`${r}/`)) &&
        statSync(src).isDirectory()
      ) {
        await mkdir(join(viewDir, r), { recursive: true });
        await walk(r);
      } else {
        symlinkSync(src, join(viewDir, r));
      }
    }
  };
  await walk("");
  const legs = await readJson<{
    groups_run?: string[];
    groups_landed?: string[];
  }>(join(sourceDir, "legs.json"));
  const run = (legs?.groups_run ?? []).filter((g) => viewGroups.includes(g));
  await writeFile(
    join(viewDir, "legs.json"),
    `${JSON.stringify({ ...(legs ?? {}), groups_run: run })}\n`,
  );
}

export interface CheckerCheck {
  id: string;
  criterion?: string;
  passed: boolean;
  status?: string;
  detail?: string;
}

interface CheckerReport {
  gate_passed?: boolean;
  checks?: CheckerCheck[];
  legs?: Record<
    string,
    {
      result_class?: string;
      expected_class?: string | null;
      exit_code?: number | null;
    }
  >;
}

/** Runs the gate's own CLI checker on `viewDir` and returns its result.json. */
export async function runChecker(
  def: GateDef,
  viewDir: string,
): Promise<CheckerReport> {
  const r = spawnSync(
    "mise",
    [
      "exec",
      "--",
      "pnpm",
      "exec",
      "tsx",
      "--conditions=development",
      join(SCRIPT_DIR, def.checker),
      "--out",
      viewDir,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
    },
  );
  await writeFile(
    join(viewDir, "checker.log"),
    `${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}\nexit ${r.status}\n`,
  );
  const report = await readJson<CheckerReport>(join(viewDir, "result.json"));
  if (!report)
    throw new Error(
      `${def.checker} wrote no result.json for ${viewDir} (exit ${r.status}): ${(r.stderr ?? "").slice(-2000)}`,
    );
  return report;
}

/** A check's verdict with the view's own directory replaced by `<run>`: details that quote a path
 * through the view must not look receiver-dependent just because the views live apart. */
function verdictKey(c: CheckerCheck | undefined, viewDir: string): string {
  if (!c) return "<absent>";
  return JSON.stringify({
    passed: c.passed,
    status: c.status ?? null,
    detail: c.detail ?? null,
  })
    .split(viewDir)
    .join("<run>");
}

/** Checks a web leg's evidence cannot answer, by construction (D11/Q4), each with the source-cited
 * reason. Filled from G7b's measured runs only; a check listed here is reported `not-applicable`
 * (non-gating) with its reason, never dropped. */
export const NOT_APPLICABLE_AT_WEB: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  gate2: {
    "fresh-cache":
      "Q4: RS_RECEIVER_CACHE_DIR is native only; a web leg has no receiver-side cache directory to start empty and end holding its fetches (applied.json cache.mode is `http-cache`)",
    "warm-cache":
      "Q4: receiver-warm replays onto receiver-cold's disk cache, which the web does not have (that leg is not replayed: native-only-warm-cache)",
  },
};

export interface Gate7bInput {
  def: GateDef;
  sourceDir: string;
  gateOut: string;
  /** Q4 bundle provenance (no-source-scene is judged once, by g7-0's adapter, and here per gate). */
  bundleDir: string;
  current: SourceProvenance;
}

export interface Gate7bClassification {
  schema: "render-stream-gate7b-classification/1";
  gate: string;
  view_groups: string[];
  legs: {
    leg: string;
    replayed: boolean;
    excluded: ExcludedReason | null;
    detail: string;
    headless: boolean;
    resolution: string | null;
    sabotage: string | null;
  }[];
  web_checks: string[];
  source_only_checks: string[];
  raw_failing_web_checks: string[];
  shots: LegShotClasses[];
}

// --- P-W1's mismatch classes (G7b finding; results/gate7/g7b.md) ----------------------------
//
// The root viewport's render target is RGB10_A2 on both platforms (texture_storage.cpp:2144-2149),
// but `texture_2d_get` reads it back two different ways (texture_storage.cpp:1104-1198):
//   native (desktop GL): glGetTexImage(GL_RGBA, GL_UNSIGNED_BYTE) on the 10-bit texture, which the
//     NVIDIA driver converts by dropping the two low bits: n = floor(v / 4);
//   web (GLES): a shader copy into an RGBA8 texture, then glReadPixels: the GPU's float-to-unorm8
//     conversion of v / 1023, w = round(v * 255 / 1023).
// So one rendered 10-bit value v can read back as different bytes. A channel pair (n, w) is
// `readback`-consistent when some v gives both. Alpha is 2 bits and reads back 0/85/170/255 on both
// paths, so it must be equal. A pixel that is not readback-consistent but differs by at most 1 level
// in every colour channel is `delta1` (Q7's band: translucent blends and AA-feather vertex-colour
// interpolation, where ANGLE/Vulkan converts the source colour to the target's levels before
// blending -- memory g7c-gpu-blend-conversion-facts -- so v itself can differ by one 10-bit level).
// Anything else is `other`: unexplained, and it fails.

const READBACK_CONSISTENT: Uint8Array = (() => {
  const t = new Uint8Array(256 * 256);
  for (let v = 0; v < 1024; v++)
    t[Math.floor(v / 4) * 256 + Math.round((v * 255) / 1023)] = 1;
  return t;
})();

export interface ShotClasses {
  pixels: number;
  identical: number;
  readback: number;
  delta1: number;
  other: number;
  /** The largest channel delta among `other` pixels (0 when there are none). */
  other_max_delta: number;
}

export function classifyShot(native: Uint8Array, web: Uint8Array): ShotClasses {
  const out: ShotClasses = {
    pixels: native.length / 4,
    identical: 0,
    readback: 0,
    delta1: 0,
    other: 0,
    other_max_delta: 0,
  };
  for (let i = 0; i < native.length; i += 4) {
    if (
      native[i] === web[i] &&
      native[i + 1] === web[i + 1] &&
      native[i + 2] === web[i + 2] &&
      native[i + 3] === web[i + 3]
    ) {
      out.identical++;
      continue;
    }
    let readback = native[i + 3] === web[i + 3];
    let small = readback;
    let maxDelta = Math.abs(native[i + 3] - web[i + 3]);
    for (let c = 0; c < 3; c++) {
      const n = native[i + c];
      const w = web[i + c];
      if (n === w) continue;
      if (READBACK_CONSISTENT[n * 256 + w] !== 1) readback = false;
      const d = Math.abs(n - w);
      if (d > 1) small = false;
      if (d > maxDelta) maxDelta = d;
    }
    if (readback) out.readback++;
    else if (small) out.delta1++;
    else {
      out.other++;
      if (maxDelta > out.other_max_delta) out.other_max_delta = maxDelta;
    }
  }
  return out;
}

export interface LegShotClasses {
  leg: string;
  shot: string;
  classes: ShotClasses | null;
  problem?: string;
}

/** Every shot of a web leg against its native leg's. */
export async function classifyLegShots(
  leg: string,
  nativeDir: string,
  webDir: string,
): Promise<LegShotClasses[]> {
  const out: LegShotClasses[] = [];
  for (const f of filesUnder(join(nativeDir, "shots"))) {
    if (!f.endsWith(".png")) continue;
    const a = await decodePngRgba(join(nativeDir, "shots", f));
    const b = await decodePngRgba(join(webDir, "shots", f));
    if (!a || !b || a.width !== b.width || a.height !== b.height) {
      out.push({
        leg,
        shot: f,
        classes: null,
        problem: b ? "unreadable or size differs" : "missing on web",
      });
      continue;
    }
    out.push({ leg, shot: f, classes: classifyShot(a.data, b.data) });
  }
  return out;
}

/** The banded leg (Q7 "As built", G7b): the web leg's own files, except each shot whose every
 * differing pixel is `readback` or `delta1`, which is the native shot instead (the gate's budgets
 * then judge N's pixels, which W equals within the recorded band). A shot with any `other` pixel
 * stays the web's own, so the gate's own check sees it. */
async function buildBandedLeg(
  webDir: string,
  nativeDir: string,
  bandedDir: string,
  shots: readonly LegShotClasses[],
): Promise<void> {
  await mkdir(bandedDir, { recursive: true });
  const substitute = new Set(
    shots
      .filter((s) => s.classes !== null && s.classes.other === 0)
      .map((s) => `shots/${s.shot}`),
  );
  for (const f of filesUnder(webDir)) {
    if (f.startsWith("diff/")) continue;
    const to = join(bandedDir, f);
    await mkdir(dirname(to), { recursive: true });
    symlinkSync(substitute.has(f) ? join(nativeDir, f) : join(webDir, f), to);
  }
}

/** The resolved state at `seq`, for the compositor's "same frame" test. */
function resolvedStates(
  recordingPath: string,
): Map<number, unknown> | undefined {
  try {
    const data = new Uint8Array(readFileSync(recordingPath));
    for (const version of [6, 5, 4, 3, 2] as const) {
      try {
        const r = resolveRecording(data, version);
        return new Map(r.transactions.map((t) => [t.seq, t.state]));
      } catch {}
    }
  } catch {}
  return undefined;
}

/** compositor-equals-readback for one web leg (Q7; same rule as g7-0's, on resolved states). */
async function compositorVerdict(
  legDir: string,
): Promise<{ applicable: boolean; problems: string[]; note: string }> {
  const applied = await readJson<{
    shots?: { seq?: number }[];
    transactions?: { seq?: number }[];
  }>(join(legDir, "applied.json"));
  const screenshot = join(legDir, "compositor", "screenshot.png");
  if (!applied)
    return { applicable: true, problems: ["applied.json missing"], note: "" };
  if (!existsSync(screenshot))
    return {
      applicable: true,
      problems: ["no compositor screenshot"],
      note: "",
    };
  const shots = applied.shots ?? [];
  const last = shots[shots.length - 1];
  const tx = applied.transactions ?? [];
  const lastSeq = tx[tx.length - 1]?.seq;
  if (!last?.seq || !lastSeq)
    return {
      applicable: false,
      problems: [],
      note: "no shot or no transaction",
    };
  const states = resolvedStates(join(legDir, "recording.rs2"));
  if (!states)
    return {
      applicable: true,
      problems: ["recording does not resolve"],
      note: "",
    };
  if (!statesEqual(states.get(last.seq), states.get(lastSeq)))
    return {
      applicable: false,
      problems: [],
      note: `the last shot (seq ${last.seq}) is not of the state shown at exit (seq ${lastSeq})`,
    };
  const shot = await decodePngRgba(
    join(legDir, "shots", `seq-${last.seq}.png`),
  );
  const comp = await decodePngRgba(screenshot);
  if (!shot || !comp)
    return {
      applicable: true,
      problems: ["unreadable shot or screenshot"],
      note: "",
    };
  if (shot.width !== comp.width || shot.height !== comp.height)
    return {
      applicable: true,
      problems: [
        `screenshot ${comp.width}x${comp.height} vs shot ${shot.width}x${shot.height}`,
      ],
      note: "",
    };
  for (let i = 3; i < shot.data.length; i += 4)
    if (shot.data[i] !== 255)
      return {
        applicable: false,
        problems: [],
        note: "the last shot is not opaque",
      };
  const d = diffRgba(shot.data, comp.data, shot.width, shot.height);
  return {
    applicable: true,
    problems:
      d.mismatched_pixels === 0
        ? []
        : [
            `${d.mismatched_pixels} px differ (max channel delta ${d.max_channel_delta})`,
          ],
    note: `${shot.width}x${shot.height} seq ${last.seq}`,
  };
}

/** One gate's `g7-<N>@web` group. The web legs must already be in `<gateOut>/web/`. */
export async function checkGateWeb(
  input: Gate7bInput,
): Promise<Gate7GroupResult & { classification: Gate7bClassification }> {
  const { def, sourceDir, gateOut } = input;
  const webRoot = join(gateOut, "web");
  const { specs, discovered } = webLegSpecs(sourceDir, webRoot);
  const checks: Gate7Check[] = [];

  // 2 and 3: the three views and the checker on each.
  const webMap = new Map(specs.map((s) => [s.leg, s.webDir]));
  const blankRoot = join(gateOut, "blank-legs");
  await rm(blankRoot, { recursive: true, force: true });
  const blankMap = new Map<string, string>();
  for (const s of specs) {
    const d = join(blankRoot, s.leg);
    await mkdir(d, { recursive: true });
    blankMap.set(s.leg, d);
  }
  // P-W1's classes per shot, and the banded legs (Q7's band, recorded "As built").
  const shotClasses: LegShotClasses[] = [];
  const bandedRoot = join(gateOut, "banded-legs");
  await rm(bandedRoot, { recursive: true, force: true });
  const bandedMap = new Map<string, string>();
  for (const s of specs) {
    const classes = await classifyLegShots(s.leg, s.nativeDir, s.webDir);
    shotClasses.push(...classes);
    const d = join(bandedRoot, s.leg);
    await buildBandedLeg(s.webDir, s.nativeDir, d, classes);
    bandedMap.set(s.leg, d);
  }
  const views = {
    native: join(gateOut, "native-view"),
    blank: join(gateOut, "blank-view"),
    web: join(gateOut, "web-view"),
    banded: join(gateOut, "banded-view"),
  };
  const traced = discovered
    .filter((d) => d.excluded === "native-only-trace")
    .map((d) => d.leg);
  await buildMirrorView(
    sourceDir,
    new Map(),
    views.native,
    def.viewGroups,
    traced,
  );
  await buildMirrorView(
    sourceDir,
    blankMap,
    views.blank,
    def.viewGroups,
    traced,
  );
  await buildMirrorView(sourceDir, webMap, views.web, def.viewGroups, traced);
  await buildMirrorView(
    sourceDir,
    bandedMap,
    views.banded,
    def.viewGroups,
    traced,
  );
  const native = await runChecker(def, views.native);
  const blank = await runChecker(def, views.blank);
  const web = await runChecker(def, views.web);
  const banded = await runChecker(def, views.banded);
  const byId = (r: CheckerReport) =>
    new Map((r.checks ?? []).map((c) => [c.id, c]));
  const nById = byId(native);
  const bById = byId(blank);
  const wById = byId(web);
  const bandById = byId(banded);
  const ids = [...new Set([...nById.keys(), ...bById.keys()])];
  const webIds = ids.filter(
    (id) =>
      verdictKey(nById.get(id), views.native) !==
      verdictKey(bById.get(id), views.blank),
  );
  const sourceOnly = ids.filter((id) => !webIds.includes(id));
  const na = NOT_APPLICABLE_AT_WEB[def.gate] ?? {};
  const rawFailing: string[] = [];
  for (const id of webIds) {
    const n = nById.get(id);
    const w = wById.get(id);
    const band = bandById.get(id);
    if (w && !w.passed) rawFailing.push(id);
    if (na[id] !== undefined) {
      checks.push({
        id: `${id}@web`,
        criterion: n?.criterion ?? "gate's own check",
        passed: w?.passed === true,
        gating: false,
        detail: `not-applicable: ${na[id]}; web ${w?.passed ? "passes" : "fails"}: ${w?.detail ?? ""}`,
      });
      continue;
    }
    const notRun = band?.status === "not-run" && n?.status !== "not-run";
    const rawNote =
      w && !w.passed && band?.passed
        ? ` [raw web shots FAIL, passes only under the recorded readback/delta1 band: ${(w.detail ?? "").slice(0, 300)}]`
        : "";
    checks.push({
      id: `${id}@web`,
      criterion: n?.criterion ?? band?.criterion ?? "gate's own check",
      passed: band !== undefined && band.passed === true && !notRun,
      gating: true,
      detail:
        band === undefined
          ? "the checker did not report it on the web view"
          : `${band.detail ?? ""}${rawNote}${n && !n.passed ? ` (native also fails: ${n.detail ?? ""})` : ""}`,
    });
  }
  checks.push({
    id: "raw-web-checks@web",
    criterion:
      "Q7 P-W1 (report only): the gate's own checks on the RAW web shots (no band); every one listed here fails only on pixels, and pw1-classes@web says which class",
    passed: rawFailing.length === 0,
    gating: false,
    detail:
      rawFailing.length === 0
        ? `all ${webIds.length} web checks pass on the raw web shots`
        : `${webIds.length - rawFailing.length}/${webIds.length} pass raw; failing raw: ${rawFailing.join(", ")}`,
  });
  {
    const totals = { shots: 0, identical: 0, readback: 0, delta1: 0, other: 0 };
    const pxTotals = { readback: 0, delta1: 0, other: 0 };
    const problems: string[] = [];
    const refusedOther: string[] = [];
    let otherMax = 0;
    // A leg whose web receiver typed a web-only refusal (`web-*` in applied.json `unsupported`)
    // differs from native by design; its `other` pixels are attributed to the refusal (and its own
    // leg-class and reference checks fail on them), never to the pixel band.
    const refusedLegs = new Set<string>();
    for (const sp of specs) {
      const w = await readJson<{ unsupported?: { reason?: string }[] }>(
        join(sp.webDir, "applied.json"),
      );
      if ((w?.unsupported ?? []).some((u) => u.reason?.startsWith("web-")))
        refusedLegs.add(sp.leg);
    }
    for (const s of shotClasses) {
      totals.shots++;
      if (!s.classes) {
        problems.push(`${s.leg}/${s.shot}: ${s.problem}`);
        continue;
      }
      const c = s.classes;
      pxTotals.readback += c.readback;
      pxTotals.delta1 += c.delta1;
      pxTotals.other += c.other;
      if (c.other > 0 && refusedLegs.has(s.leg)) {
        totals.other++;
        refusedOther.push(`${s.leg}/${s.shot} ${c.other} px`);
      } else if (c.other > 0) {
        totals.other++;
        otherMax = Math.max(otherMax, c.other_max_delta);
        problems.push(
          `${s.leg}/${s.shot}: ${c.other} px unexplained (max delta ${c.other_max_delta})`,
        );
      } else if (c.delta1 > 0) totals.delta1++;
      else if (c.readback > 0) totals.readback++;
      else totals.identical++;
    }
    checks.push(
      mk(
        "pw1-classes@web",
        "Q7/G7b: every differing web pixel is explained: `readback` (one 10-bit value read back by glGetTexImage natively and by the GLES copy shader on the web) or `delta1` (at most one level per colour channel, alpha equal); no `other` pixel",
        problems,
        `${totals.shots} shots: ${totals.identical} identical, ${totals.readback} readback-only, ${totals.delta1} with delta1 px; pixels readback ${pxTotals.readback}, delta1 ${pxTotals.delta1}, other ${pxTotals.other}${refusedOther.length > 0 ? ` (all on web-refused legs: ${refusedOther.length} shots, e.g. ${refusedOther.slice(0, 3).join(", ")})` : ""}`,
      ),
    );
  }

  // D21 source-run-valid: the native view passes every web check, every replayed leg is in its
  // expected class natively, and the source was made on this build.
  {
    const problems: string[] = [];
    for (const id of webIds) {
      const n = nById.get(id);
      if (!n?.passed && na[id] === undefined)
        problems.push(`native ${id} fails: ${(n?.detail ?? "").slice(0, 200)}`);
    }
    const src = await readJson<SourceProvenance>(
      join(sourceDir, "gate7-source.json"),
    );
    if (!src)
      problems.push(
        "source gate7-source.json missing (make it with run-gate7.sh --make-sources or gate7-tool.ts source-provenance)",
      );
    else problems.push(...sourceProvenanceProblems(src, input.current));
    checks.push(
      mk(
        `source-run-valid@web`,
        "D21: the source run passes every check the web legs answer (natively, on the same view), and was made from the same inputs (content key: template, capture library, calibration, receiver core and the source-shaping files; lib/source-key.ts)",
        problems,
        `source valid on ${webIds.length} web checks, same build`,
      ),
    );
  }

  // Per-leg gate 7 checks.
  const prov: string[] = [];
  const consoleBad: string[] = [];
  const missing: string[] = [];
  const appliedDiff: string[] = [];
  const webRefusals: string[] = [];
  const pw1 = { shots: 0, identical: 0, differing: [] as string[] };
  const startup: Record<string, unknown>[] = [];
  const compositorProblems: string[] = [];
  const compositorNotes: string[] = [];
  let compositorApplied = 0;
  for (const spec of specs) {
    const p = await readJson<{ ok?: boolean; reasons?: string[] }>(
      join(spec.webDir, "provenance.json"),
    );
    if (!p?.ok)
      prov.push(
        `${spec.leg}: ${p?.reasons?.join(", ") ?? "no provenance.json"}`,
      );
    let consoleText = "";
    try {
      consoleText = readFileSync(join(spec.webDir, "console.jsonl"), "utf8");
    } catch {
      consoleBad.push(`${spec.leg}: console.jsonl missing`);
    }
    for (const line of consoleText.split("\n").filter(Boolean)) {
      const m = JSON.parse(line) as { type: string; text: string };
      if (m.type === "pageerror" || /SHADER ERROR|WebGL: /.test(m.text))
        consoleBad.push(`${spec.leg}: ${m.type}: ${m.text.slice(0, 160)}`);
    }
    const nativeFiles = filesUnder(spec.nativeDir).filter(
      (f) => !nativeOnly(f),
    );
    for (const f of nativeFiles)
      if (!existsSync(join(spec.webDir, f))) missing.push(`${spec.leg}/${f}`);
    const nApplied = await readJson<unknown>(
      join(spec.nativeDir, "applied.json"),
    );
    const wApplied = await readJson<unknown>(join(spec.webDir, "applied.json"));
    const leg = discovered.find((d) => d.leg === spec.leg);
    if (!nApplied || !wApplied) {
      if (nApplied || wApplied)
        appliedDiff.push(
          `${spec.leg}: applied.json missing on ${nApplied ? "web" : "native"}`,
        );
    } else {
      // Evidence paths quoted inside values (a failure detail naming a store file) are where,
      // not what: the native source and leg paths become the web's URL paths first.
      const nativeText = JSON.stringify(nApplied)
        .split(resolve(spec.nativeDir))
        .join(`/${relative(dirname(dirname(webRoot)), spec.webDir)}`)
        .split(resolve(sourceDir))
        .join(`/sources/${def.gate}`);
      const crossCore = appliedCore(nApplied) !== appliedCore(wApplied);
      const strip = (doc: unknown): unknown => {
        const n = normalizeApplied(doc) as Record<string, unknown>;
        // D11: a --headless native leg has a headless viewport block; a browser always renders.
        if (leg?.headless) delete n.viewport;
        // G7xw: a rust web leg against its gdscript native leg compares failure seq and reason.
        if (crossCore) dropCrossCoreDetail(n);
        return n;
      };
      const diffs = jsonDiffPaths(
        strip(JSON.parse(nativeText)),
        strip(wApplied),
      );
      // A web-only typed refusal (reason `web-*`, e.g. rs_applier.gd's web-index-region-update)
      // changes applied.json by design: the leg is reported under web-refusals@web instead.
      const refusals = (
        ((
          wApplied as {
            unsupported?: {
              reason?: string;
              name?: string;
              seq?: number | null;
            }[];
          }
        ).unsupported ?? []) as {
          reason?: string;
          name?: string;
          seq?: number | null;
        }[]
      ).filter(
        (u) => typeof u.reason === "string" && u.reason.startsWith("web-"),
      );
      if (refusals.length > 0)
        webRefusals.push(
          `${spec.leg}: ${refusals.length} refused (${[...new Set(refusals.map((u) => `${u.name} ${u.reason}`))].join(", ")}, first seq ${refusals[0].seq}); applied.json differs at ${diffs.join(" | ") || "nothing else"}`,
        );
      else if (diffs.length > 0)
        appliedDiff.push(`${spec.leg}: ${diffs.join(" | ")}`);
    }
    for (const s of shotClasses.filter((x) => x.leg === spec.leg)) {
      pw1.shots++;
      if (!s.classes) pw1.differing.push(`${spec.leg}/${s.shot}: ${s.problem}`);
      else if (s.classes.identical === s.classes.pixels) pw1.identical++;
      else
        pw1.differing.push(
          `${spec.leg}/${s.shot}: ${s.classes.pixels - s.classes.identical} px (readback ${s.classes.readback}, delta1 ${s.classes.delta1}, other ${s.classes.other})`,
        );
    }
    if (spec.compositor) {
      const v = await compositorVerdict(spec.webDir);
      if (v.applicable) {
        compositorApplied++;
        for (const p of v.problems)
          compositorProblems.push(`${spec.leg}: ${p}`);
        if (v.problems.length === 0)
          compositorNotes.push(`${spec.leg} ${v.note}`);
      } else compositorNotes.push(`${spec.leg} not applicable: ${v.note}`);
    }
    const timings = await readJson<{
      wall_ms?: number;
      wasm_heap_bytes?: number | null;
    }>(join(spec.webDir, "timings.json"));
    startup.push({
      leg: spec.leg,
      wall_ms: timings?.wall_ms ?? null,
      wasm_heap_bytes: timings?.wasm_heap_bytes ?? null,
    });
  }
  checks.push(
    mk(
      "browser-provenance@web",
      "Q6/D9: every web leg's browser names ANGLE, NVIDIA and Vulkan, holds no Wayland fd, had DISPLAY/WAYLAND_DISPLAY unset and is the recorded chromium-1223 binary",
      prov,
      `${specs.length} legs on the pinned hardware Chromium`,
    ),
  );
  checks.push(
    mk(
      "console-clean@web",
      "Q6: no web leg logged a SHADER ERROR, a `WebGL: ` error or an uncaught page error",
      consoleBad,
      `${specs.length} legs clean`,
    ),
  );
  checks.push(
    mk(
      "evidence-complete@web",
      "Q8: every file a native receiver leg writes (applied.json, shots, state dumps, logs, exit code) exists for its web leg by the same name",
      missing,
      `${specs.length} legs complete`,
    ),
  );
  checks.push(
    mk(
      "applied-equals-native@web",
      "G7e/Q4: each web leg's applied.json equals its native leg's on every field except timings, evidence paths, process frames, `receiver`, `cache` (the web's HTTP cache) and `display_server`; for a --headless native leg, also `viewport` (D11)",
      appliedDiff,
      `${specs.length} legs equal native`,
    ),
  );
  checks.push({
    id: "web-refusals@web",
    criterion:
      "Q4/G7b (report): legs where the web receiver typed a web-only refusal (reason `web-*`) instead of making an engine call that fails on WebGL 2; their applied.json differs from native by design and their own leg classes say what that cost",
    passed: webRefusals.length === 0,
    gating: false,
    detail: webRefusals.length === 0 ? "none" : webRefusals.join("; "),
  });
  checks.push(
    mk(
      "compositor-equals-readback@web",
      "Q7: on the gate's honest full and HD legs, the CDP screenshot of the canvas equals the receiver's own readback of the same opaque frame, channel 0",
      compositorApplied === 0 ? ["no leg was applicable"] : compositorProblems,
      `${compositorApplied} legs exact (${compositorNotes.join("; ")})`,
    ),
  );
  checks.push(
    mk(
      "pw1-web-equals-native@web",
      "Q7 P-W1 (report only): every web shot equals its native shot byte for byte",
      pw1.differing,
      `${pw1.identical}/${pw1.shots} shots identical`,
      false,
    ),
  );
  // Q7: a band needs a same-build W repeat that is identical. Every leg with a non-identical shot
  // was replayed a second time (gate7-tool.ts web-legs --repeat-differing) into web-repeat/.
  {
    const differingLegs = [
      ...new Set(
        shotClasses
          .filter((s) => !s.classes || s.classes.identical !== s.classes.pixels)
          .map((s) => s.leg),
      ),
    ];
    const problems: string[] = [];
    let compared = 0;
    for (const leg of differingLegs) {
      const first = join(webRoot, leg);
      const again = join(gateOut, "web-repeat", leg);
      if (!existsSync(join(again, "shots"))) {
        problems.push(`${leg}: no repeat`);
        continue;
      }
      for (const f of filesUnder(join(first, "shots"))) {
        compared++;
        const a = await decodePngRgba(join(first, "shots", f));
        const b = await decodePngRgba(join(again, "shots", f));
        if (
          !a ||
          !b ||
          a.width !== b.width ||
          diffRgba(a.data, b.data, a.width, a.height).mismatched_pixels > 0
        )
          problems.push(`${leg}/shots/${f} differs between the two web runs`);
      }
    }
    checks.push(
      mk(
        "web-repeat-identical@web",
        "Q7: every web leg whose shots differ from native was replayed again on the same build, and every shot of the repeat is byte-identical to the first run",
        problems,
        differingLegs.length === 0
          ? "no web shot differs from native, no repeat needed"
          : `${differingLegs.length} legs repeated, ${compared} shots identical`,
      ),
    );
  }
  const excluded = discovered.filter((d) => d.excluded !== null);
  checks.push({
    id: "legs-not-replayed@web",
    criterion:
      "D11/Q8 (report): file receiver legs of the source that the web does not replay, each typed",
    passed: true,
    gating: false,
    detail:
      excluded.length === 0
        ? "none"
        : excluded.map((d) => `${d.leg}: ${d.excluded}`).join("; "),
  });

  const classification: Gate7bClassification = {
    schema: "render-stream-gate7b-classification/1",
    gate: def.gate,
    view_groups: [...def.viewGroups],
    legs: discovered.map((d) => ({
      leg: d.leg,
      replayed: d.excluded === null,
      excluded: d.excluded,
      detail: d.excludedDetail,
      headless: d.headless,
      resolution: d.resolution,
      sabotage: d.sabotage,
    })),
    web_checks: webIds,
    source_only_checks: sourceOnly,
    raw_failing_web_checks: rawFailing,
    shots: shotClasses,
  };
  await writeFile(
    join(gateOut, "classification.json"),
    `${JSON.stringify(classification, null, 2)}\n`,
  );
  return {
    group: def.group,
    kind: "web",
    passed: checks.every((c) => c.passed || !c.gating),
    checks,
    pw1,
    startup,
    classification,
  };
}

/** Relative helper for the CLI's log lines. */
export function relToRepo(path: string): string {
  return relative(REPO_ROOT, path);
}
