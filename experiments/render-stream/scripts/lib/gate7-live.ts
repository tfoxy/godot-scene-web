// Gate 7 live groups (G7l; gate7-design.md "G7l", Q2, Q3, Q8, Q9): the live legs of gates 1, 2,
// 5 (g5f) and 5.5 (g55f) delivered to a browser receiver over render-stream/7; G7g adds gate 6's
// g6l (and its presentation-check, lib/gate7-g6-checks.ts).
//
// A live leg cannot replay a source run: its host paces against the receiver it serves. So the
// gate's OWN runner runs again with `GATE7_LIVE_KIND=web|gsw` (lib/legs.sh): every live host gets
// the harness origin in GRC_LIVE_ALLOWED_ORIGINS, and every live receiver launch (and every
// file-mode replay of a received.rs7, the live-replay legs) goes to a browser instead
// (lib/gate7-live-legs.ts). run-gate7.sh --live writes one such run per gate and receiver kind to
// `<out>/<gate>/live-<kind>/`, and the runner's own checker writes its result.json there.
//
// This file judges such a run, unforked, the way G7b judges file legs (lib/gate7b-adapters.ts):
//
// 1. Which checks are the browser's. The gate's checker judges two views of the run: `full-view`
//    (every entry a link) and `blank-view` (every browser receiver directory, found by its
//    `page-config.json`, replaced by an empty directory). A check whose verdict changes reads a
//    browser leg, and only those are reported `<id>@<kind>`. The rest judge native legs the gate
//    still needs (references, captures, g1a/g2a's legs); a failing one fails `native-legs@<kind>`,
//    because the run they belong to is then not evidence. `group-*` checks of groups the runner
//    was not asked for are dropped (the runner's own run-scoping, as G7b).
// 2. Gate 7's checks on every browser leg (Q8's table): browser-provenance, console-clean,
//    token-not-logged (every host token, over the whole run tree, the harness/daemon logs and
//    every PUT body included; Chromium's own profile store is not evidence and is excluded),
//    hello-recorded (Q2/Q3: each live connection's /7 hello as the host recorded it), and
//    credit-from-paced-loop (Q9: every `submitted` ack follows a drawing rAF that applied it).
//    `live-vs-replay@<kind>` is the gate's own live-replay comparison, read from (1).

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";

import { decodePngRgba } from "./gate-minus1-checks";
import { filesUnder, type Gate7Check, mk, readJson } from "./gate7-adapters";
import { presentationCheck } from "./gate7-g6-checks";
import {
  buildMirrorView,
  type CheckerCheck,
  classifyShot,
  type GateDef,
  runChecker,
} from "./gate7b-adapters";

export interface LiveGateDef {
  gate: string;
  group: string;
  checker: string;
  runner: string;
  /** run-gate<N>.sh --legs for the live run (the native groups the live groups compare against
   * come first: g1c/g1d need g1a's reference, g2c needs g2a's). */
  runnerLegs: string;
  /** The gate's live groups (Q8). */
  liveGroups: readonly string[];
}

export const GATE7L_GATES: readonly LiveGateDef[] = [
  {
    gate: "gate1",
    group: "g7-1",
    checker: "check-gate1.ts",
    runner: "run-gate1.sh",
    runnerLegs: "g1a,g1c,g1d",
    liveGroups: ["g1c", "g1d"],
  },
  {
    gate: "gate2",
    group: "g7-2",
    checker: "check-gate2.ts",
    runner: "run-gate2.sh",
    runnerLegs: "g2a,g2c,g2e",
    liveGroups: ["g2c", "g2e"],
  },
  {
    gate: "gate5",
    group: "g7-5",
    checker: "check-gate5.ts",
    runner: "run-gate5.sh",
    runnerLegs: "g5c,g5f",
    liveGroups: ["g5f"],
  },
  {
    gate: "gate55",
    group: "g7-55",
    checker: "check-gate55.ts",
    runner: "run-gate55.sh",
    runnerLegs: "g55f",
    liveGroups: ["g55f"],
  },
  // G7g: gate 6's live motion, warm, stall, reconnect and stale-coalesce legs (g6l); its
  // reference-live-frames and reference-file legs are native and run in the same runner.
  {
    gate: "gate6",
    group: "g7-6",
    checker: "check-gate6.ts",
    runner: "run-gate6.sh",
    runnerLegs: "g6l",
    liveGroups: ["g6l"],
  },
];

/** Checks of the gate's own checker that a browser leg cannot answer by construction, each with
 * its reason. Reported `not-applicable` (non-gating), never dropped. */
export const LIVE_NOT_APPLICABLE: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {};

/** Failures already explained by an earlier increment's typed receiver refusal. They stay
 * FAILING and gating (the browser cannot pass the leg: D1, D22); the detail names the cause when
 * every region the check names is in `regions`, so a new failure elsewhere is never hidden. */
export const LIVE_KNOWN_FAILURES: Readonly<
  Record<
    string,
    readonly { ids: RegExp; regions: readonly string[]; reason: string }[]
  >
> = {
  // GDScript web core only: the Rust core issues the update through GL_ELEMENT_ARRAY_BUFFER
  // (G7xw), so on `--web-core rust` (G7xwl) these checks must pass and nothing is excused.
  "web:gdscript:gate5": [
    {
      ids: /^(receiver-vs-reference|warm-host-no-gets|leg-class-live-mesh(-warm|-stall)?)$/,
      regions: ["RM", "DF"],
      reason:
        "G7b's typed web refusal `web-index-region-update`: Godot 4.5.1 binds the wrong target for a mesh index-region update (mesh_storage.cpp:591-593), WebGL 2 rejects it, so RM keeps its old triangles from step 4 (936 px); g5f's per-checkpoint DF tolerance (wire state equals full) cannot excuse DF at step 5 while RM fails in that checkpoint",
    },
  ],
};

export function knownFailure(
  kind: string,
  gate: string,
  c: CheckerCheck,
  core: "gdscript" | "rust" = "rust",
): string | undefined {
  const key = kind === "web" ? `${kind}:${core}:${gate}` : `${kind}:${gate}`;
  for (const k of LIVE_KNOWN_FAILURES[key] ?? []) {
    if (!k.ids.test(c.id)) continue;
    const named = [...(c.detail ?? "").matchAll(/ in ([A-Z0-9,]+)/g)].flatMap(
      (m) => m[1].split(","),
    );
    if (named.length > 0 && named.every((r) => k.regions.includes(r)))
      return k.reason;
  }
  return undefined;
}

export interface LiveGroupResult {
  group: string;
  kind: "web" | "gsw";
  live: true;
  passed: boolean;
  run_dir: string;
  browser_legs: string[];
  checks: Gate7Check[];
  cadence: LiveCadence[];
}

/** Per live browser leg: what the host published against what it offered (G6c's terms). */
export interface LiveCadence {
  leg: string;
  connection: number;
  frames_offered: number | null;
  sent: number | null;
  coalesced: number | null;
  credit_rtt_frames_median: number | null;
  credit_rtt_frames_p95: number | null;
  submitted_ack_us_median: number | null;
  submitted_ack_us_p95: number | null;
}

export interface PageConfig {
  url?: string;
  env?: Record<string, string>;
  canvas?: [number, number];
}

export interface SummaryConnection {
  connection: number;
  version?: number;
  receiver_kind?: string | null;
  credit_window?: number | null;
  credit_window_requested?: number | null;
  manifest_sha256?: string | null;
  presentation_backing_w?: number;
  presentation_backing_h?: number;
  presentation_css_w?: number;
  presentation_css_h?: number;
  dpr_milli?: number;
  origin?: string | null;
  token_ok?: boolean | null;
  frames_offered?: number;
  sent?: number;
  coalesced?: number;
  credit_rtt_frames?: { median?: number; p95?: number };
  ack_latency_us?: { submitted?: { median?: number; p95?: number } };
}

/** Q8 hello-recorded for one live connection the host summarised: its /7 hello as the browser leg
 * at `page` (its page-config.json) must have sent it. Empty when it matches. (G7r shares it.) */
export function helloProblems(
  c: SummaryConnection,
  page: PageConfig | undefined,
  expectedKind: string,
): string[] {
  const env = page?.env ?? {};
  const origin = page?.url ? new URL(page.url).origin : null;
  const want: Record<string, unknown> = {
    version: 7,
    receiver_kind: expectedKind,
    credit_window: 1,
    credit_window_requested: Number(env.RS_RECEIVER_CREDIT_WINDOW ?? "1"),
    manifest_sha256: env.RS_RECEIVER_MANIFEST_SHA256 ?? null,
    presentation_backing_w: page?.canvas?.[0],
    presentation_backing_h: page?.canvas?.[1],
    presentation_css_w: page?.canvas?.[0],
    presentation_css_h: page?.canvas?.[1],
    dpr_milli: 1000,
    origin,
  };
  return Object.entries(want)
    .filter(([k, v]) => (c as unknown as Record<string, unknown>)[k] !== v)
    .map(
      ([k, v]) =>
        `${k}=${JSON.stringify((c as unknown as Record<string, unknown>)[k])} (want ${JSON.stringify(v)})`,
    );
}

/** Q6 for one browser leg directory: its provenance.json verdict and its console's errors (a
 * SHADER ERROR, a `WebGL: ` error or an uncaught page error). (G7r shares it.) */
export async function browserLegProblems(
  dir: string,
  leg: string,
): Promise<{ provenance: string[]; console: string[] }> {
  const provenance: string[] = [];
  const consoleBad: string[] = [];
  const p = await readJson<{ ok?: boolean; reasons?: string[] }>(
    join(dir, "provenance.json"),
  );
  if (!p?.ok)
    provenance.push(
      `${leg}: ${p ? (p.reasons ?? []).join("; ") : "provenance.json missing"}`,
    );
  let consoleText = "";
  try {
    consoleText = readFileSync(join(dir, "console.jsonl"), "utf8");
  } catch {
    consoleBad.push(`${leg}: console.jsonl missing`);
  }
  for (const line of consoleText.split("\n").filter(Boolean)) {
    const m = JSON.parse(line) as { type: string; text: string };
    if (m.type === "pageerror" || /SHADER ERROR|WebGL: /.test(m.text))
      consoleBad.push(`${leg}: ${m.type}: ${m.text.slice(0, 160)}`);
  }
  return { provenance, console: consoleBad };
}

/** Every directory under `root` (relative, "/"-separated) holding a page-config.json: a browser
 * receiver leg written by lib/gate7-live-legs.ts. Chromium's profile tree is not walked. */
export function discoverBrowserLegs(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const dir = rel === "" ? root : join(root, rel);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (rel !== "" && entries.includes("page-config.json")) out.push(rel);
    for (const e of entries) {
      if (e === "gate7-browser" || e === "store" || e === "cache") continue;
      const r = rel === "" ? e : `${rel}/${e}`;
      let isDir = false;
      try {
        isDir = statSync(join(root, r)).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) walk(r);
    }
  };
  walk("");
  return out.sort();
}

export interface BandResult {
  /** `<browser leg>/shots/<shot>` -> the image the banded view shows instead. */
  byFile: Map<string, string>;
  /** One line per substituted or snapped shot. */
  substituted: string[];
  /** Browser shots with pixels beyond the band against their nearest native image (kept as
   * they are for those pixels; the gate's own check judges them). */
  unmatched: string[];
}

type Rgba = { path: string; w: number; h: number; data: Uint8Array };

/** Q7's band for live legs (readback and delta1, each at most one level per RGB channel with
 * alpha equal; G7b's classes, `classifyShot`). Candidates are every PNG of the run outside the
 * browser legs and outside diff/ directories: the references and native receivers the gate's
 * checker compares against. For each browser shot the nearest candidate is chosen (fewest pixels
 * beyond the band, on a sample). A shot identical to it needs nothing; one within the band
 * everywhere is replaced by it; otherwise each pixel within the band is snapped to the
 * candidate's value and every other pixel stays the browser's (a shot whose static part is in
 * band but whose animated region is compared by the checker against its own synthesis, gate 2's
 * live-animate). The banded view can therefore only turn a failing check into a passing one when
 * every pixel that failed it was within one level: the band's own claim. */
export async function bandSubstitutions(
  runDir: string,
  browserLegs: readonly string[],
  snapDir: string,
): Promise<BandResult> {
  const result: BandResult = {
    byFile: new Map(),
    substituted: [],
    unmatched: [],
  };
  const isBrowser = (rel: string): boolean =>
    browserLegs.some((l) => rel === l || rel.startsWith(`${l}/`));
  const candidates: Rgba[] = [];
  const all = (await readdir(runDir, { recursive: true })) as string[];
  for (const rel of all) {
    if (
      !rel.endsWith(".png") ||
      rel.includes("/diff/") ||
      rel.startsWith("gate7-browser/")
    )
      continue;
    if (isBrowser(rel)) continue;
    const img = await decodePngRgba(join(runDir, rel));
    if (img)
      candidates.push({
        path: join(runDir, rel),
        w: img.width,
        h: img.height,
        data: img.data,
      });
  }
  const inBand = (a: Uint8Array, b: Uint8Array, i: number): boolean =>
    a[i + 3] === b[i + 3] &&
    Math.abs(a[i] - b[i]) <= 1 &&
    Math.abs(a[i + 1] - b[i + 1]) <= 1 &&
    Math.abs(a[i + 2] - b[i + 2]) <= 1;
  await rm(snapDir, { recursive: true, force: true });
  for (const leg of browserLegs) {
    for (const f of filesUnder(join(runDir, leg, "shots"))) {
      if (!f.endsWith(".png")) continue;
      const key = `${leg}/shots/${f}`;
      const img = await decodePngRgba(join(runDir, leg, "shots", f));
      if (!img) continue;
      let nearest: Rgba | null = null;
      let nearestFar = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        if (c.w !== img.width || c.h !== img.height) continue;
        let far = 0;
        for (let i = 0; i < img.data.length; i += 4 * 7)
          if (!inBand(c.data, img.data, i)) far++;
        if (far < nearestFar) {
          nearest = c;
          nearestFar = far;
        }
      }
      if (nearest === null) {
        result.unmatched.push(`${key}: no native image of its size`);
        continue;
      }
      const classes = classifyShot(nearest.data, img.data);
      if (classes.identical === classes.pixels) continue;
      const near = relative(runDir, nearest.path);
      if (classes.other === 0) {
        result.byFile.set(key, nearest.path);
        result.substituted.push(
          `${key} <- ${near} (readback ${classes.readback}, delta1 ${classes.delta1})`,
        );
        continue;
      }
      const snapped = new Uint8Array(img.data);
      let moved = 0;
      for (let i = 0; i < snapped.length; i += 4) {
        if (
          snapped[i] === nearest.data[i] &&
          snapped[i + 1] === nearest.data[i + 1] &&
          snapped[i + 2] === nearest.data[i + 2]
        )
          continue;
        if (!inBand(nearest.data, snapped, i)) continue;
        snapped[i] = nearest.data[i];
        snapped[i + 1] = nearest.data[i + 1];
        snapped[i + 2] = nearest.data[i + 2];
        moved++;
      }
      result.unmatched.push(
        `${key}: nearest ${near} has ${classes.other} px beyond the band (max delta ${classes.other_max_delta})${moved > 0 ? `; ${moved} in-band px snapped` : ""}`,
      );
      if (moved === 0) continue;
      const to = join(snapDir, leg, "shots", f);
      await mkdir(dirname(to), { recursive: true });
      await sharp(Buffer.from(snapped), {
        raw: { width: img.width, height: img.height, channels: 4 },
      })
        .png()
        .toFile(to);
      result.byFile.set(key, to);
      result.substituted.push(`${key} snapped to ${near} (${moved} px)`);
    }
  }
  return result;
}

/** Leg directories (relative) holding a strace.txt, at most three levels deep. */
function discoverTracedLegs(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(rel === "" ? root : join(root, rel));
    } catch {
      return;
    }
    if (rel !== "" && entries.includes("strace.txt")) out.push(rel);
    if (depth >= 3) return;
    for (const e of entries) {
      if (e === "gate7-browser" || e === "store" || e === "cache") continue;
      const r = rel === "" ? e : `${rel}/${e}`;
      try {
        if (statSync(join(root, r)).isDirectory()) walk(r, depth + 1);
      } catch {
        // not a directory
      }
    }
  };
  walk("", 0);
  return out.sort();
}

function verdict(c: CheckerCheck | undefined, view: string): string {
  if (!c) return "<absent>";
  return JSON.stringify({
    passed: c.passed,
    status: c.status ?? null,
    detail: c.detail ?? null,
  })
    .split(view)
    .join("<run>");
}

/** Every file under `root` whose bytes contain `token`, except `exclude` and the Chromium
 * profiles (browser-internal storage, not evidence). G7hp moved every profile to a temp
 * directory outside `root` entirely, so this `gate7-browser/profiles/` skip is now a defensive
 * no-op kept for a run from before that change, or a reintroduced regression. */
export async function grepTree(
  root: string,
  token: string,
  exclude: ReadonlySet<string>,
): Promise<string[]> {
  const hits: string[] = [];
  const needle = Buffer.from(token, "utf8");
  let entries: string[];
  try {
    entries = (await readdir(root, { recursive: true })) as string[];
  } catch {
    return hits;
  }
  for (const rel of entries) {
    if (rel.startsWith("gate7-browser/profiles/")) continue;
    const full = join(root, rel);
    if (exclude.has(full)) continue;
    let buf: Buffer;
    try {
      buf = await readFile(full);
    } catch {
      continue;
    }
    if (buf.includes(needle)) hits.push(rel);
  }
  return hits;
}

/** Q9 credit-from-paced-loop for one browser leg's applied.json: every transaction acked
 * `submitted` was applied and drawn in the rAF callback that sent the ack. The web export records
 * the main-loop iteration of the apply (`process_frame`) and of the `submitted` ack
 * (`submitted_process_frame`): Godot's web main loop is one iteration per rAF callback, so the
 * two must be equal. The GSW receiver records, per transaction (`paced`), the rAF callback index
 * of the apply (`applied_raf`) and of the draw that included it (`drawn_raf`), where the ack was
 * sent from (`submitted_from`: `raf`, or `onmessage` under the ack-on-receipt sabotage) and when
 * (`submitted_ack_ms`, never before `drawn_ms`). */
export function pacedLoopProblems(leg: string, applied: unknown): string[] {
  const problems: string[] = [];
  const doc = applied as {
    receiver?: { kind?: string };
    transactions?: Array<Record<string, unknown>>;
  };
  const kind = doc.receiver?.kind;
  let acked = 0;
  for (const t of doc.transactions ?? []) {
    if (t.submitted_us === null || t.submitted_us === undefined) continue;
    acked++;
    if (kind === "web-export") {
      if (t.submitted_process_frame !== t.process_frame)
        problems.push(
          `${leg} seq ${t.seq}: applied at process frame ${t.process_frame}, submitted at ${t.submitted_process_frame}`,
        );
    } else if (kind === "gsw-canvas") {
      const p = (t.paced ?? {}) as Record<string, unknown>;
      const ok =
        p.submitted_from === "raf" &&
        typeof p.applied_raf === "number" &&
        p.drawn_raf === p.applied_raf &&
        typeof p.submitted_ack_ms === "number" &&
        typeof p.drawn_ms === "number" &&
        p.submitted_ack_ms >= p.drawn_ms - 0.1;
      if (!ok)
        problems.push(
          `${leg} seq ${t.seq}: applied in rAF ${p.applied_raf}, drawn in ${p.drawn_raf}, submitted from ${p.submitted_from} at ${p.submitted_ack_ms} ms (drawn ${p.drawn_ms})`,
        );
    } else {
      problems.push(`${leg}: receiver kind ${kind} is not a browser`);
      break;
    }
  }
  if (problems.length > 6)
    return [
      ...problems.slice(0, 6),
      `${leg}: ${problems.length} in all of ${acked} acked`,
    ];
  return problems;
}

export interface LiveGroupInput {
  def: LiveGateDef;
  kind: "web" | "gsw";
  /** `<out>/<gate>/live-<kind>`: the gate runner's GATE7-mode run. */
  runDir: string;
  /** Where the views go (`<out>/<gate>/live-<kind>-views`). */
  viewsDir: string;
  /** G7xwl: the web export's expected core (run-gate7.sh --web-core; default rust since G7xd). */
  core?: "gdscript" | "rust";
}

/** The side module a `--core rust` web bundle loads beside the engine (build-rs-core-web.sh). */
export const RS_CORE_SIDE_MODULE = "librs_core_ext.wasm";

/** G7xwl: why a web leg directory is not evidence of running on `core` (empty when it is). Three
 * signals, each the receiver's or the browser's own:
 *   - receiver.gd's `core rust (<path>)` log line, written when RS_RECEIVER_CORE=rust loaded the
 *     adapter and before any record, in stdout.log or in console.jsonl (the browser's console
 *     stream, the only engine output a SIGKILLed leg keeps: its page state is never read back);
 *   - applied.json's `receiver.core`, when the leg wrote one (a SIGKILLed leg does not);
 *   - under rust, the page's resource timing showing the side module fetched, unless the leg
 *     was aborted before its page state was read (timings.json `aborted` with no resources).
 * G7xd made rust the engine's own default (gdscript, frozen at /7, needs the env word to opt
 * in): a gdscript run without RS_RECEIVER_CORE (the drop-env sabotage) still loads the
 * rust-capable module, but logs `core rust` and says rust where gdscript was requested. */
export async function receiverCoreProblems(
  dir: string,
  leg: string,
  core: "gdscript" | "rust",
): Promise<string[]> {
  const out: string[] = [];
  const read = (name: string): string | null => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return null;
    }
  };
  const stdout = read("stdout.log");
  const consoleText = read("console.jsonl");
  if (stdout === null && consoleText === null)
    return [`${leg}: neither stdout.log nor console.jsonl`];
  const rustLine = /core rust \(/;
  const consoleLogs = (consoleText ?? "")
    .split("\n")
    .filter(Boolean)
    .some((l) => {
      try {
        const m = JSON.parse(l) as { type?: string; text?: string };
        return m.type === "log" && rustLine.test(m.text ?? "");
      } catch {
        return false;
      }
    });
  const logsRust =
    (stdout ?? "").split("\n").some((l) => rustLine.test(l)) || consoleLogs;
  if (core === "rust" && !logsRust)
    out.push(`${leg}: no \`core rust\` line in stdout.log or console.jsonl`);
  if (core === "gdscript" && logsRust)
    out.push(`${leg}: the engine logged \`core rust\` on a gdscript run`);
  const applied = await readJson<{ receiver?: { core?: unknown } }>(
    join(dir, "applied.json"),
  );
  if (applied) {
    const got =
      typeof applied.receiver?.core === "string"
        ? applied.receiver.core
        : "gdscript";
    if (got !== core)
      out.push(`${leg}: applied.json receiver.core ${got}, want ${core}`);
  }
  if (core === "rust") {
    const timings = await readJson<{
      aborted?: boolean;
      resources?: Array<{ name?: string } | string>;
    }>(join(dir, "timings.json"));
    const names = (timings?.resources ?? []).map((r) =>
      typeof r === "string" ? r : (r.name ?? ""),
    );
    const unread = timings?.aborted === true && names.length === 0;
    if (
      !unread &&
      !names.some((n) => n.split("?")[0].endsWith(`/${RS_CORE_SIDE_MODULE}`))
    )
      out.push(`${leg}: the page never fetched ${RS_CORE_SIDE_MODULE}`);
  }
  return out;
}

export async function checkGateLive(
  input: LiveGroupInput,
): Promise<LiveGroupResult> {
  const { def, kind, viewsDir } = input;
  const core = input.core ?? "rust";
  // Real path: a native strace leg records the real one (buildMirrorView relocates by it).
  const runDir = realpathSync(input.runDir);
  const checks: Gate7Check[] = [];
  const cadence: LiveCadence[] = [];
  const browserLegs = discoverBrowserLegs(runDir);
  const legsJson = await readJson<{ groups_run?: string[] }>(
    join(runDir, "legs.json"),
  );
  const groupsRun = legsJson?.groups_run ?? [];
  const missingGroups = def.liveGroups.filter((g) => !groupsRun.includes(g));
  checks.push(
    mk(
      `live-run@${kind}`,
      "G7l: the gate's runner ran its live groups with a browser receiver (GATE7_LIVE_KIND)",
      [
        ...(existsSync(join(runDir, "result.json"))
          ? []
          : [`${runDir}: no result.json`]),
        ...missingGroups.map((g) => `group ${g} not run`),
        ...(browserLegs.length === 0 ? ["no browser receiver leg found"] : []),
      ],
      `${browserLegs.length} browser legs in ${groupsRun.join(",")}`,
    ),
  );
  if (browserLegs.length === 0 || !existsSync(join(runDir, "result.json")))
    return {
      group: def.group,
      kind,
      live: true,
      passed: false,
      run_dir: runDir,
      browser_legs: browserLegs,
      checks,
      cadence,
    };

  // (1) Classification through two views.
  const gateDef: GateDef = {
    gate: def.gate,
    group: def.group,
    checker: def.checker,
    viewGroups: groupsRun,
    sourceLegs: def.runnerLegs,
    runner: def.runner,
  };
  const fullView = join(viewsDir, "full-view");
  const blankView = join(viewsDir, "blank-view");
  const empty = join(viewsDir, "empty-leg");
  await rm(empty, { recursive: true, force: true });
  await mkdir(empty, { recursive: true });
  // A native strace leg's trace names the run's absolute paths: relocate it into each view
  // (G7b's mechanism), or its openat checks look at a path the view does not have.
  const traced = discoverTracedLegs(runDir).filter(
    (l) => !browserLegs.includes(l),
  );
  await buildMirrorView(runDir, new Map(), fullView, groupsRun, traced);
  await buildMirrorView(
    runDir,
    new Map(browserLegs.map((l) => [l, empty])),
    blankView,
    groupsRun,
    traced,
  );
  const full = await runChecker(gateDef, fullView);
  const blank = await runChecker(gateDef, blankView);
  const blankById = new Map((blank.checks ?? []).map((c) => [c.id, c]));
  // Q7's band (G7b "As built"): a browser shot whose every differing pixel against a native
  // image of the run (a reference or native receiver shot) is `readback` or `delta1` is that
  // image within the band. The banded view substitutes it; a check that fails exactly but
  // passes banded is reported passed with the band named. A shot with any other difference stays
  // the browser's own.
  const band = await bandSubstitutions(
    runDir,
    browserLegs,
    join(viewsDir, "banded-shots"),
  );
  let banded: Map<string, CheckerCheck> | null = null;
  if (band.substituted.length > 0) {
    const bandedView = join(viewsDir, "banded-view");
    const bandedLegs = join(viewsDir, "banded-legs");
    await rm(bandedLegs, { recursive: true, force: true });
    const replaced = new Map<string, string>();
    for (const leg of browserLegs) {
      const to = join(bandedLegs, leg);
      await mkdir(to, { recursive: true });
      for (const f of filesUnder(join(runDir, leg))) {
        const sub = band.byFile.get(`${leg}/${f}`);
        const dst = join(to, f);
        await mkdir(dirname(dst), { recursive: true });
        symlinkSync(sub ?? join(runDir, leg, f), dst);
      }
      replaced.set(leg, to);
    }
    await buildMirrorView(runDir, replaced, bandedView, groupsRun, traced);
    const r = await runChecker(gateDef, bandedView);
    banded = new Map((r.checks ?? []).map((c) => [c.id, c]));
  }
  const na = LIVE_NOT_APPLICABLE[def.gate] ?? {};
  const nativeBad: string[] = [];
  const classified: string[] = [];
  const replayIds: string[] = [];
  for (const c of full.checks ?? []) {
    const m = /^group-(.+)$/.exec(c.id);
    if (m && !groupsRun.includes(m[1])) continue;
    const reads =
      verdict(c, fullView) !== verdict(blankById.get(c.id), blankView);
    if (!reads) {
      if (!c.passed)
        nativeBad.push(`${c.id}: ${(c.detail ?? "").slice(0, 200)}`);
      continue;
    }
    classified.push(c.id);
    if (c.id.startsWith("live-replay-equals-live")) replayIds.push(c.id);
    if (!c.passed && na[c.id]) {
      checks.push({
        id: `${c.id}@${kind}`,
        criterion: c.criterion ?? c.id,
        passed: false,
        gating: false,
        detail: `not-applicable: ${na[c.id]} (${(c.detail ?? "").slice(0, 300)})`,
      });
      continue;
    }
    const bandedVerdict = banded?.get(c.id);
    if (!c.passed && bandedVerdict?.passed) {
      checks.push({
        id: `${c.id}@${kind}`,
        criterion: c.criterion ?? c.id,
        passed: true,
        gating: true,
        detail: `band (Q7 readback/delta1, ${band.substituted.length} shots substituted): ${(bandedVerdict.detail ?? "").slice(0, 600)} | exact: ${(c.detail ?? "").split(fullView).join("<run>").slice(0, 600)}`,
      });
      continue;
    }
    const known = c.passed ? undefined : knownFailure(kind, def.gate, c, core);
    checks.push({
      id: `${c.id}@${kind}`,
      criterion: c.criterion ?? c.id,
      passed: c.passed,
      gating: true,
      detail: `${known ? `known: ${known} | ` : ""}${(c.detail ?? "").split(fullView).join("<run>").slice(0, 2000)}`,
    });
  }
  checks.push(
    mk(
      `native-legs@${kind}`,
      "G7l: every check of the run that reads no browser leg (references, captures, the native groups the live groups compare against) passed, so the run is evidence",
      nativeBad,
      "all native-leg checks passed",
    ),
  );
  checks.push(
    mk(
      `live-vs-replay@${kind}`,
      "G7l: the file replay of received.rs7 through the same browser equals the live shots and states (the gate's own live-replay checks)",
      replayIds.length === 0 &&
        def.liveGroups.some((g) => g === "g1c" || g === "g2c")
        ? ["no live-replay check read a browser leg"]
        : replayIds
            .filter(
              (id) => !(full.checks ?? []).find((c) => c.id === id)?.passed,
            )
            .map((id) => `${id} failed`),
      replayIds.length === 0
        ? "no live-replay leg in this gate"
        : replayIds.join(", "),
    ),
  );
  await writeFile(
    join(viewsDir, "classification.json"),
    `${JSON.stringify({ browser_legs: browserLegs, classified, native_failed: nativeBad, band: band.substituted, band_unmatched: band.unmatched }, null, 2)}\n`,
  );

  // (2) Gate 7's per-leg checks.
  const prov: string[] = [];
  const consoleBad: string[] = [];
  const hello: string[] = [];
  const paced: string[] = [];
  const coreBad: string[] = [];
  let helloConnections = 0;
  let pacedLegs = 0;
  const expectedKind = kind === "web" ? "web-export" : "gsw-canvas";
  for (const leg of browserLegs) {
    const dir = join(runDir, leg);
    const basics = await browserLegProblems(dir, leg);
    prov.push(...basics.provenance);
    consoleBad.push(...basics.console);
    if (kind === "web")
      coreBad.push(...(await receiverCoreProblems(dir, leg, core)));
    const page = await readJson<PageConfig>(join(dir, "page-config.json"));
    const env = page?.env ?? {};
    if (env.RS_RECEIVER_MODE !== "live") continue;
    // The leg's host: <leg>/host beside <leg>/receiver.
    const legRoot = leg.endsWith("/receiver")
      ? leg.slice(0, -"/receiver".length)
      : leg;
    const summary = await readJson<{ connections?: SummaryConnection[] }>(
      join(runDir, legRoot, "host", "evidence", "live-summary.json"),
    );
    for (const c of summary?.connections ?? []) {
      helloConnections++;
      const bad = helloProblems(c, page, expectedKind);
      // A hello the host refused (no token): only the token verdict differs from an honest one.
      if (bad.length > 0)
        hello.push(`${legRoot} conn ${c.connection}: ${bad.join(", ")}`);
      cadence.push({
        leg: legRoot,
        connection: c.connection,
        frames_offered: c.frames_offered ?? null,
        sent: c.sent ?? null,
        coalesced: c.coalesced ?? null,
        credit_rtt_frames_median: c.credit_rtt_frames?.median ?? null,
        credit_rtt_frames_p95: c.credit_rtt_frames?.p95 ?? null,
        submitted_ack_us_median: c.ack_latency_us?.submitted?.median ?? null,
        submitted_ack_us_p95: c.ack_latency_us?.submitted?.p95 ?? null,
      });
    }
    const applied = await readJson<unknown>(join(dir, "applied.json"));
    if (
      applied &&
      (env.RS_RECEIVER_CREDIT_STAGE ?? "submitted") === "submitted"
    ) {
      pacedLegs++;
      paced.push(...pacedLoopProblems(legRoot, applied));
    }
  }
  checks.push(
    mk(
      `browser-provenance@${kind}`,
      "Q6: every browser leg ran the pinned Chromium with D9's flags, the real GPU, no Wayland FD",
      prov,
      `${browserLegs.length} legs`,
    ),
  );
  checks.push(
    mk(
      `console-clean@${kind}`,
      "Q6: no browser leg logged a SHADER ERROR, a `WebGL: ` error or an uncaught page error",
      consoleBad,
      `${browserLegs.length} legs clean`,
    ),
  );
  if (kind === "web")
    checks.push(
      mk(
        `receiver-core@${kind}`,
        core === "rust"
          ? "G7xwl: every web leg (live and its received.rs7 replays) decoded and applied through the shared Rust core: its log names `core rust`, its applied.json says `receiver.core` rust, and its page fetched the bundle's rs-core side module"
          : "G7xwl: every web leg ran the GDScript core (no `core rust` log line; applied.json `receiver.core` gdscript)",
        coreBad,
        `${browserLegs.length} legs on the ${core} core`,
      ),
    );
  checks.push(
    mk(
      `hello-recorded@${kind}`,
      "Q8: each live connection's host summary shows the /7 hello: version 7, the receiver kind, window 1 granted for the window asked, the manifest sha, the presentation integers of the canvas at DPR 1, and the harness origin",
      helloConnections === 0
        ? ["no live connection recorded by any host"]
        : hello,
      `${helloConnections} connections`,
    ),
  );
  checks.push(
    mk(
      `credit-from-paced-loop@${kind}`,
      "Q9: every `submitted` ack follows the rAF callback that applied that seq and drew",
      pacedLegs === 0 ? ["no live leg with submitted credit"] : paced,
      `${pacedLegs} legs with submitted credit`,
    ),
  );

  // token-not-logged over the whole run: every host token.
  const tokens: Array<{ leg: string; token: string; path: string }> = [];
  for (const entry of readdirSync(runDir)) {
    const path = join(runDir, entry, "host", "evidence", "live-token");
    if (existsSync(path))
      tokens.push({
        leg: entry,
        token: readFileSync(path, "utf8").trim(),
        path,
      });
  }
  const tokenHits: string[] = [];
  const exclude = new Set(tokens.map((t) => t.path));
  for (const t of tokens) {
    if (t.token === "") continue;
    for (const hit of await grepTree(runDir, t.token, exclude))
      tokenHits.push(
        `${t.leg}'s token in ${relative(runDir, join(runDir, hit))}`,
      );
  }
  checks.push(
    mk(
      `token-not-logged@${kind}`,
      "Q8/G2e: no host token appears in any file of the run but its own evidence/live-token: console.jsonl, stdout.log, the launcher and daemon logs, page-config/env/argv and every PUT body included",
      tokens.length === 0 ? [] : tokenHits,
      tokens.length === 0
        ? "no leg ran with a token"
        : `${tokens.length} tokens, none logged`,
    ),
  );
  // G7g: gate 6's live receivers present at the scene's 640x360 presentation_size.
  if (def.gate === "gate6")
    checks.push(
      await presentationCheck(
        kind,
        new Map(browserLegs.map((l) => [l, join(runDir, l)])),
      ),
    );

  return {
    group: def.group,
    kind,
    live: true,
    passed: checks.every((c) => c.passed || !c.gating),
    run_dir: runDir,
    browser_legs: browserLegs,
    checks,
    cadence,
  };
}

export function liveDefForGroup(group: string): LiveGateDef | undefined {
  return GATE7L_GATES.find((d) => d.group === group);
}
