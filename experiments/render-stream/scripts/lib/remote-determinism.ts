#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Run-to-run determinism of a gate's evidence (docs/remote-compute.md R1): given N run directories
// of the same gate (a runner's --out, e.g. validate-increment's <out>/native-rust-gate0/run), it
// reports, per shot PNG, whether every run's bytes are identical (sha256), and per dump JSON,
// whether every run's value is equal under canonicalEqual (lib/gate1-checks.ts: keys sorted,
// numbers rounded to float32) once the run-volatile fields are masked.
//
//   pnpm exec tsx --conditions=development experiments/render-stream/scripts/lib/remote-determinism.ts \
//     [--out determinism.json] RUN RUN [RUN...]
//   ... remote-determinism.ts --digest RUN_DIR --out run.digest.json
//   either form: [--build-record <web bundle>/build.json ...] (a web pck's build_sha256 is compared
//   by content, see buildContentMap)
//
// A RUN is a run directory or a digest file (R3): `--digest` reduces one run directory to what is
// compared (every shot's sha256, every masked dump's canonical-form hash, the live-set keys and the
// provenance), so a runner digests its own repeats and only the digests travel to the job that
// compares runners (gate 7's run dirs are GBs). A pixel report needs both images, so it is made only
// between runs given as directories (one runner's repeats).
//
// Shots: every *.png under a run dir (reference and receiver shots, and the checker's diff images).
// Dumps: every receiver applied.json and state/*.json, and the fixture's steps.jsonl (one JSON
// value per line). A path present in some runs and absent from others disagrees. The provenance of
// each run (the GL renderer string Godot printed, gamescope's Vulkan device) must agree too: runs on
// different rasterizers are not a determinism sample.
//
// Masked (VOLATILE_KEYS): identity and wall-clock fields that differ between two runs by design --
// the random session/stream ids, the recording file's size and digest (it embeds those ids and the
// capture's encode timings), absolute evidence paths, and the receiver's microsecond timestamps.
// The per-transaction record digests are compared (two local NVIDIA runs agree on every one). A disagreeing shot gets a
// pixel report: mismatched pixel count, bounding box, the first few locations and the per-channel
// delta histogram. Exits 0 when everything agrees, 1 on any disagreement, 2 on bad usage.

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import { pckContentDigest } from "./godot-pck";

/** Keys whose values differ between two runs of identical rendering by design. */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "session_id",
  "stream_id",
  // applied.json's {path, sha256, bytes} of the recording file: the recording carries the random ids
  // and the capture's own encode/snapshot nanosecond totals (its `end` record), so its size and
  // digest differ run to run. Each transaction's record_sha256 stays compared: it does not.
  "recording",
  "received_sha256",
  "received_bytes",
  "path",
  "received_path",
  "state_path",
  "dir",
  "received_us",
  "applied_us",
  "submitted_us",
  "fetch_us",
]);

export function isDump(rel: string): boolean {
  return (
    /(^|\/)applied\.json$/.test(rel) ||
    /(^|\/)state\/[^/]+\.json$/.test(rel) ||
    /(^|\/)steps\.jsonl$/.test(rel)
  );
}

/** The value with every VOLATILE_KEYS member (at any depth) replaced by a fixed marker. */
export function mask(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mask);
  // an absolute evidence path embedded in a string (a failure detail): the repeats of one runner use
  // $RUNNER_TEMP/v, v2, v3...
  if (typeof value === "string")
    return value.replace(/_temp\/v\d*\//g, "_temp/v/");
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] =
        VOLATILE_KEYS.has(k) || k.endsWith("_us") ? "<volatile>" : mask(v);
    return out;
  }
  return value;
}

/** R3: mask() plus, for a WEB-EXPORT receiver's dump (applied.json `receiver.kind`), its
 * `process_frame`s: the export fetches the recording asynchronously, so the frame its loop is on when
 * a transaction applies (or a shot is taken) follows load timing -- two repeats on one runner were a
 * frame apart on every transaction (run 39801064520), the only field that differed. Native and gsw
 * receivers keep it compared. */
export function maskDump(value: unknown): unknown {
  const m = mask(value);
  const kind = (value as { receiver?: { kind?: unknown } } | null)?.receiver
    ?.kind;
  if (kind !== "web-export") return m;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          k === "process_frame" ? "<volatile>" : strip(x),
        ]),
      );
    return v;
  };
  return strip(m);
}

export function parseDump(rel: string, text: string): unknown {
  if (rel.endsWith(".jsonl"))
    return text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  return JSON.parse(text);
}

/** R3: a web export's build identity, compared by CONTENT. A web receiver's dumps carry
 * `receiver.build_sha256`, the sha256 of the export's `receiver.pck`. Godot 4.5.1's export writes the
 * same entries with the same bytes on every machine, but their DATA ORDER is nondeterministic (run
 * 39828406894: 16 builds from identical inputs gave two raw digests, the local box a third; same 17
 * entries, sizes and md5s, four class_name scripts reordered). So the raw digest is not a property of
 * what was built, and masking it would hide a real build difference. Instead each run's build records
 * (`--build-record <bundle>/build.json`) map a raw pck sha256 to its content digest
 * (godot-pck.ts pckContentDigest over the sorted path/size/md5 entries), and a dump's build_sha256 is
 * compared as `pck-content:<digest>`. Two builds whose contents differ still disagree (a real
 * disagreement); a raw digest with no record stays compared raw. The raw drift is reported as info
 * (DeterminismReport.build_identity), never as a failure. */
export type BuildContentMap = Record<string, string>;
export const BUILD_CONTENT_PREFIX = "pck-content:";

export function buildContentMap(records: unknown[]): BuildContentMap {
  const map: BuildContentMap = {};
  for (const r of records) {
    const pck = (r as { schema?: unknown; pck?: unknown } | null)?.pck as
      | {
          sha256?: unknown;
          content_sha256?: unknown;
          files?: Array<{ path: string; size: number; md5: string }>;
        }
      | undefined;
    if (
      (r as { schema?: unknown }).schema !== "render-stream-web-build/1" ||
      typeof pck?.sha256 !== "string" ||
      !Array.isArray(pck.files)
    )
      throw new Error(
        "remote-determinism: a --build-record is not a web build.json",
      );
    // recomputed from the entry list (a record written before content_sha256 existed still maps)
    const content = pckContentDigest(pck.files);
    if (pck.content_sha256 !== undefined && pck.content_sha256 !== content)
      throw new Error(
        `remote-determinism: build record ${pck.sha256}: content_sha256 ${String(pck.content_sha256)} is not its entry list's ${content}`,
      );
    if (map[pck.sha256] !== undefined && map[pck.sha256] !== content)
      throw new Error(
        `remote-determinism: two build records give pck ${pck.sha256} different contents`,
      );
    map[pck.sha256] = content;
  }
  return map;
}

/** value with every mapped `build_sha256` replaced by its content digest; `seen` collects the raw
 * and content values substituted. */
export function substituteBuild(
  value: unknown,
  map: BuildContentMap,
  seen: { raw: Set<string>; content: Set<string> },
): unknown {
  if (Array.isArray(value))
    return value.map((v) => substituteBuild(v, map, seen));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        k === "build_sha256" &&
        typeof v === "string" &&
        map[v] !== undefined
      ) {
        seen.raw.add(v);
        seen.content.add(map[v]);
        out[k] = `${BUILD_CONTENT_PREFIX}${map[v]}`;
      } else out[k] = substituteBuild(v, map, seen);
    }
    return out;
  }
  return value;
}

/** R3: a run's INPUT directories, never digested or compared. `sources-made/` is the native source
 * runs gate 7 replays (run-gate7.sh --make-sources): a source-cache input, not this run's output. A
 * repeat that hits the cache an earlier repeat published reads the source from the cache instead, so
 * the directory exists in some repeats and not others (run 39815482313: 1881 files on one side only).
 * The sources' own determinism is R2's (the native gates on the same llvmpipe). */
export const INPUT_DIR = /(^|\/)sources-made\//;

async function walk(
  root: string,
  dir = root,
  out: string[] = [],
): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(root, p);
    if (e.isDirectory()) {
      if (!INPUT_DIR.test(`${rel}/`)) await walk(root, p, out);
    } else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** The leaves of a masked canonical dump, path -> JSON text (capped): what a digest carries for each
 * applied.json, so a cross-runner disagreement names its fields and values (digests travel without
 * the dumps themselves). */
const LEAF_CAP = 20000;
export function dumpLeaves(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  const go = (v: unknown, path: string) => {
    if (n >= LEAF_CAP) return;
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) go(x, `${path}[${i}]`);
    } else if (v !== null && typeof v === "object")
      for (const [k, x] of Object.entries(v as Record<string, unknown>))
        go(x, path ? `${path}.${k}` : k);
    else {
      out[path] = JSON.stringify(v).slice(0, 160);
      n++;
    }
  };
  go(value, "");
  return out;
}

/** Up to `max` differing leaf paths between runs' leaves (a path absent in a run is `<absent>`). */
export function leafDiff(
  leaves: Array<Record<string, string> | undefined>,
  max = 12,
): { count: number; fields: Array<{ path: string; values: string[] }> } {
  const have = leaves.filter((l): l is Record<string, string> => !!l);
  if (have.length < 2) return { count: 0, fields: [] };
  const paths = [...new Set(have.flatMap((l) => Object.keys(l)))].sort();
  const fields: Array<{ path: string; values: string[] }> = [];
  let count = 0;
  for (const path of paths) {
    const values = have.map((l) => l[path] ?? "<absent>");
    if (values.every((v) => v === values[0])) continue;
    count++;
    if (fields.length < max) fields.push({ path, values });
  }
  return { count, fields };
}

export interface PixelDiff {
  width: number;
  height: number;
  mismatched_pixels: number;
  bbox: [number, number, number, number] | null; // x0 y0 x1 y1, inclusive
  first: Array<{ x: number; y: number; a: number[]; b: number[] }>;
  max_channel_delta: number[]; // r g b a
  delta_histogram: Record<string, number>; // max |delta| over channels -> pixel count
  size_mismatch?: string;
}

export async function pixelDiff(a: Buffer, b: Buffer): Promise<PixelDiff> {
  const ra = await sharp(a)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rb = await sharp(b)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = ra.info.width;
  const h = ra.info.height;
  const d: PixelDiff = {
    width: w,
    height: h,
    mismatched_pixels: 0,
    bbox: null,
    first: [],
    max_channel_delta: [0, 0, 0, 0],
    delta_histogram: {},
  };
  if (w !== rb.info.width || h !== rb.info.height) {
    d.size_mismatch = `${w}x${h} vs ${rb.info.width}x${rb.info.height}`;
    return d;
  }
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let m = 0;
      for (let c = 0; c < 4; c++) {
        const dc = Math.abs(ra.data[i + c] - rb.data[i + c]);
        if (dc > d.max_channel_delta[c]) d.max_channel_delta[c] = dc;
        if (dc > m) m = dc;
      }
      if (m === 0) continue;
      d.mismatched_pixels++;
      d.delta_histogram[String(m)] = (d.delta_histogram[String(m)] ?? 0) + 1;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      if (d.first.length < 8)
        d.first.push({
          x,
          y,
          a: [...ra.data.subarray(i, i + 4)],
          b: [...rb.data.subarray(i, i + 4)],
        });
    }
  if (x1 >= 0) d.bbox = [x0, y0, x1, y1];
  return d;
}

/** Godot's "OpenGL API ... Using Device: ..." line and gamescope's Vulkan device, per run. */
export async function provenanceOf(run: string, files: string[]) {
  let gl: string | null = null;
  for (const f of files.filter((x) => x.endsWith("stdout.log")).sort()) {
    const m = /^OpenGL API .*$/m.exec(await readFile(join(run, f), "utf8"));
    if (m) {
      gl = m[0];
      break;
    }
  }
  let vulkan: string | null = null;
  for (const f of files
    .filter((x) => /(^|\/)gamescope[^/]*\/gamescope\.json$/.test(x))
    .sort()) {
    try {
      const j = JSON.parse(await readFile(join(run, f), "utf8")) as {
        vulkanDevice?: string | null;
      };
      vulkan = j.vulkanDevice ?? null;
      break;
    } catch {
      // a half-written bring-up file: no provenance from it
    }
  }
  // R3: a browser leg's WebGL renderer string (browser-harness.ts checkBrowserProvenance), so a
  // SwiftShader run and a lavapipe run are never taken as one sample. Absent on native-only runs.
  let browser: string | null = null;
  for (const f of files
    .filter((x) => /(^|\/)provenance\.json$/.test(x))
    .sort()) {
    try {
      const j = JSON.parse(await readFile(join(run, f), "utf8")) as {
        renderer?: string | null;
      };
      if (typeof j.renderer === "string") {
        browser = j.renderer;
        break;
      }
    } catch {
      // not a browser leg's provenance
    }
  }
  return {
    gl_renderer: gl,
    vulkan_device: vulkan,
    ...(browser !== null ? { browser_renderer: browser } : {}),
  };
}

export interface DeterminismReport {
  schema: "render-stream-remote-determinism/1";
  runs: number;
  run_dirs: string[];
  ok: boolean;
  provenance: Array<{
    gl_renderer: string | null;
    vulkan_device: string | null;
    browser_renderer?: string;
  }>;
  provenance_agree: boolean;
  shots: { total: number; agree: number; disagree: string[] };
  dumps: { total: number; agree: number; disagree: string[] };
  /** Live legs (R2): wire-seq-keyed shots and states, compared as content sets, see liveSetDirs. */
  live_sets: Array<{
    dir: string;
    /** state-image: an animated live leg's shots, compared as a function of its states
     * (stateImageCheck) */
    kind: "shots" | "states" | "state-image";
    distinct: number[]; // per run: distinct images (or masked states)
    agree: boolean;
    /** state-image: masked states seen in two or more runs, and those that rendered differently */
    shared_states?: number;
    inconsistent?: string[];
  }>;
  /** applied.json of a live-set leg: transaction boundaries follow the credit loop, not compared. */
  live_timed: string[];
  /** web build identity (buildContentMap): raw pck sha256 drift is info; content must agree */
  build_identity?: {
    raw: string[][];
    content: string[][];
    raw_drift: boolean;
    content_agree: boolean;
  };
  shot_rows: Array<{
    path: string;
    agree: boolean;
    sha256: Array<string | null>;
    diff?: PixelDiff[];
  }>;
  dump_rows: Array<{
    path: string;
    agree: boolean;
    missing: number[];
    differs_from_run1: number[];
    /** a disagreeing applied.json: how many leaves differ, and the first few with each run's value */
    fields_differing?: number;
    fields?: Array<{ path: string; values: string[] }>;
  }>;
}

/** gate1-checks.ts's `canonical` (canonicalEqual compares JSON.stringify of it): object keys sorted,
 * every number rounded to float32. Mirrored here so a digest can hash it; the self-test pins the
 * equivalence with canonicalEqual. */
export function canonicalForm(value: unknown): unknown {
  if (typeof value === "number") return Math.fround(value);
  if (Array.isArray(value)) return value.map(canonicalForm);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort())
      out[key] = canonicalForm((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

const sha = (x: string | Buffer) =>
  createHash("sha256").update(x).digest("hex");
const SET_SHOT = /(^|\/)shots\/(stream-\d+-)?seq-\d+\.png$/;
const SET_STATE = /(^|\/)state\/(stream-\d+-)?seq-\d+\.json$/;
/** R3: a live leg that stalls the credit loop on purpose (g1d's live-stall, g5f/g55f's
 * live-*-stall, their stale-coalesce sabotages). Which frames the receiver shows around the stall
 * follows when credit resumes, so even the SET of distinct images is delivery timing: such a set is
 * listed in live_timed, never compared. */
const STALL_LEG = /(^|\/)[^/]*(stall|stale-coalesce)[^/]*\//;

/** GRT6: a replay of a recording whose CONTENT follows wall-clock timing on the capturing machine, so
 * two runs record different transactions (not a rendering difference):
 *  - g8ku/pending, g8ku-web/web-pending: GRC_TEXTURE_WORKER_DELAY_MS=250 jobs against the capture's
 *    frame rate decide which textures are still `delivery-pending` at each seq (run 40153318460:
 *    three runners, three pending sets, so the seq-8 shot differs);
 *  - g8l/basis/replay: the replay of the live host's recording, where the lazy uastc variants land
 *    at whichever seq their encodes finish (the same two local NVIDIA runs differ too).
 * Their applied.json (and, for the pending legs, the shots) are listed in live_timed, never compared.
 * The checker still holds each run to its own exact pixel and upload checks. */
const TIMED_RECORDING_LEG =
  /^(g8ku\/pending|g8ku-web\/web-pending|g8l\/basis\/replay)\//;
const TIMED_RECORDING_SHOTS = /^(g8ku\/pending|g8ku-web\/web-pending)\//;

/** R3: an ANIMATED live leg (g2c's live-animate, g5f's live-mesh, g55f's live-shader). Each settle
 * shot shows whichever animation frame the credit loop delivered by then, so the shot images
 * themselves differ run to run, together with the receiver's applied state (state/seq-N.json):
 * delivery timing, not rendering. Run 39861745131 (lavapipe, 3 runs per group): every such leg's
 * runs applied different state sets (22-25 masked states over 3 runs, 4-9 seen in more than one),
 * and every state seen in more than one run rendered to the same image. So when a shot set
 * disagrees as a content set, it is compared as a FUNCTION from masked state to image: every state
 * applied in two or more runs must render identically (a state rendering two ways is render
 * nondeterminism). It applies only when every shot has its state and every run took the same
 * number of distinct images (a run that lost a settle image still disagrees). Returns null when it
 * does not apply. */
export function stateImageCheck(
  dir: string,
  perRun: Array<Set<string>>,
  digests: RunDigest[],
): { shared: number; inconsistent: string[] } | null {
  const stateDir = dir.replace(/\/shots$/, "/state");
  if (stateDir === dir) return null;
  const images = new Map<string, Set<string>>();
  const runsOf = new Map<string, Set<number>>();
  const where = new Map<string, string>();
  const counts: number[] = [];
  for (const [i, files] of perRun.entries()) {
    const distinct = new Set<string>();
    for (const f of files) {
      const png = digests[i].png[f];
      const st =
        digests[i].states[
          `${stateDir}/${f.slice(f.lastIndexOf("/") + 1).replace(/\.png$/, ".json")}`
        ];
      if (png === undefined || st === undefined) return null;
      distinct.add(png);
      if (!images.has(st)) images.set(st, new Set());
      images.get(st)?.add(png);
      if (!runsOf.has(st)) runsOf.set(st, new Set());
      runsOf.get(st)?.add(i);
      if (!where.has(st)) where.set(st, f);
    }
    counts.push(distinct.size);
  }
  if (counts.some((c) => c !== counts[0])) return null;
  const inconsistent = [...images.entries()]
    .filter(([, imgs]) => imgs.size > 1)
    .map(([st]) => where.get(st) ?? st);
  const shared = [...runsOf.values()].filter((r) => r.size > 1).length;
  return { shared, inconsistent };
}

/** One run's evidence reduced to what compareRuns compares (R3): gate 7's run dirs are GBs (5.1 GB
 * for one g7-6 run), so each runner digests its own repeats and only the digests travel. */
export interface RunDigest {
  schema: "render-stream-remote-determinism-digest/1";
  run: string;
  files: string[];
  /** shot -> sha256 of its bytes */
  png: Record<string, string>;
  /** dump -> sha256 of JSON.stringify(canonicalForm(mask(value))); null: unparseable */
  dumps: Record<string, string | null>;
  /** live-set state -> sha256 of JSON.stringify(sortKeys(mask(value))) */
  states: Record<string, string>;
  /** applied.json files with a `live` object */
  applied_live: string[];
  /** applied.json -> its masked canonical leaves (dumpLeaves), for a disagreement's field report */
  leaves?: Record<string, Record<string, string>>;
  /** build_sha256 values substituted by their content digest (buildContentMap), sorted */
  build_raw?: string[];
  build_content?: string[];
  provenance: DeterminismReport["provenance"][number];
}

export async function digestRun(
  run: string,
  builds: BuildContentMap = {},
): Promise<RunDigest> {
  const files = (await walk(run)).sort();
  const d: RunDigest = {
    schema: "render-stream-remote-determinism-digest/1",
    run,
    files,
    png: {},
    dumps: {},
    states: {},
    applied_live: [],
    leaves: {},
    provenance: await provenanceOf(run, files),
  };
  const seen = { raw: new Set<string>(), content: new Set<string>() };
  for (const rel of files) {
    if (rel.endsWith(".png")) {
      d.png[rel] = sha(await readFile(join(run, rel)));
      continue;
    }
    if (!isDump(rel)) continue;
    let v: unknown;
    try {
      v = parseDump(rel, await readFile(join(run, rel), "utf8"));
    } catch {
      d.dumps[rel] = null;
      continue;
    }
    v = substituteBuild(v, builds, seen);
    const canon = canonicalForm(maskDump(v));
    d.dumps[rel] = sha(JSON.stringify(canon));
    if (SET_STATE.test(rel))
      d.states[rel] = sha(JSON.stringify(sortKeys(mask(v))));
    if (/(^|\/)applied\.json$/.test(rel)) {
      const live = (v as { live?: unknown } | null)?.live;
      if (live !== undefined && live !== null) d.applied_live.push(rel);
      else if (d.leaves) d.leaves[rel] = dumpLeaves(canon);
    }
  }
  if (seen.raw.size > 0) {
    d.build_raw = [...seen.raw].sort();
    d.build_content = [...seen.content].sort();
  }
  return d;
}

/** A run argument: a run directory (digested here) or a digest file written by --digest. */
async function loadRun(
  arg: string,
  builds: BuildContentMap,
): Promise<{ digest: RunDigest; dir: string | null }> {
  if (arg.endsWith(".json")) {
    const digest = JSON.parse(await readFile(arg, "utf8")) as RunDigest;
    if (digest.schema !== "render-stream-remote-determinism-digest/1")
      throw new Error(`${arg}: not a remote-determinism digest`);
    return { digest, dir: null };
  }
  return { digest: await digestRun(arg, builds), dir: arg };
}

export async function compareRuns(
  runs: string[],
  builds: BuildContentMap = {},
): Promise<DeterminismReport> {
  const loaded = await Promise.all(runs.map((r) => loadRun(r, builds)));
  const digests = loaded.map((l) => l.digest);
  const all = [...new Set(digests.flatMap((d) => d.files))].sort();
  const has = digests.map((d) => new Set(d.files));
  const provenance = digests.map((d) => d.provenance);
  const provenanceAgree = provenance.every(
    (p) =>
      p.gl_renderer === provenance[0].gl_renderer &&
      p.vulkan_device === provenance[0].vulkan_device &&
      p.browser_renderer === provenance[0].browser_renderer,
  );

  // Live legs (R2). A live leg's shots are named by the WIRE seq they landed at (`<dir>/shots/seq-N.png`,
  // `<dir>/state/seq-N.json`), and which seq a settle shot lands at follows the credit loop's timing: it
  // differs run to run on any machine, local NVIDIA included. That is delivery timing, not rendering, so
  // when the runs name different seqs (every run having some) the directory is compared as a CONTENT
  // SET: the distinct images (and masked states) must be equal across runs. Names that agree in every
  // run are still compared file by file. A live receiver's applied.json (it has a `live` object; or it
  // sits beside a set-compared shots dir): transaction boundaries, acks and counters follow the credit
  // loop, so it is not compared: listed in live_timed. A stall leg's set (STALL_LEG) is live-timed too.
  const liveSets: DeterminismReport["live_sets"] = [];
  const liveTimed: string[] = [];
  const setDirs = new Set<string>(); // the leg dir D whose D/shots/seq-*.png ran as a set
  const inSet = new Set<string>();
  const byStateImage = new Set<string>(); // state dirs judged with their shots (stateImageCheck)
  const seqIn = (re: RegExp) => {
    const byDir = new Map<string, Array<Set<string>>>();
    for (const f of all.filter((x) => re.test(x))) {
      const d = f.slice(0, f.lastIndexOf("/"));
      if (!byDir.has(d))
        byDir.set(
          d,
          runs.map(() => new Set<string>()),
        );
      runs.forEach((_, i) => {
        if (has[i].has(f)) byDir.get(d)?.[i].add(f);
      });
    }
    return byDir;
  };
  for (const [kind, re] of [
    ["shots", SET_SHOT],
    ["states", SET_STATE],
  ] as const) {
    for (const [dir, perRun] of seqIn(re)) {
      const names = perRun.map((x) => [...x].sort().join("\n"));
      const differ = names.some((n) => n !== names[0]);
      if (!differ || perRun.some((x) => x.size === 0)) continue;
      const sets = perRun.map((files, i) => {
        const out = new Set<string>();
        for (const f of files)
          out.add(
            (kind === "shots" ? digests[i].png[f] : digests[i].states[f]) ??
              `unreadable:${f}`,
          );
        return out;
      });
      for (const files of perRun) for (const f of files) inSet.add(f);
      setDirs.add(dir.replace(/\/(shots|state)$/, ""));
      if (STALL_LEG.test(`${dir}/`)) {
        liveTimed.push(`${dir}/`);
        continue;
      }
      if (kind === "states" && byStateImage.has(dir)) continue;
      const agree = sets.every(
        (x) => x.size === sets[0].size && [...x].every((h) => sets[0].has(h)),
      );
      const fn =
        !agree && kind === "shots"
          ? stateImageCheck(dir, perRun, digests)
          : null;
      if (fn) {
        byStateImage.add(dir.replace(/\/shots$/, "/state"));
        if (fn.shared === 0) {
          // no state applied in two runs: nothing to compare, the set is delivery timing
          liveTimed.push(`${dir}/`);
          continue;
        }
        liveSets.push({
          dir,
          kind: "state-image",
          distinct: sets.map((x) => x.size),
          agree: fn.inconsistent.length === 0,
          shared_states: fn.shared,
          ...(fn.inconsistent.length
            ? { inconsistent: fn.inconsistent.slice(0, 8) }
            : {}),
        });
        continue;
      }
      liveSets.push({
        dir,
        kind,
        distinct: sets.map((x) => x.size),
        agree,
      });
    }
  }
  for (const rel of all.filter((f) => /(^|\/)applied\.json$/.test(f))) {
    const d = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    if (setDirs.has(d) || digests.some((x) => x.applied_live.includes(rel))) {
      inSet.add(rel);
      liveTimed.push(rel);
    }
  }

  for (const rel of all) {
    if (inSet.has(rel)) continue;
    if (
      (/(^|\/)applied\.json$/.test(rel) && TIMED_RECORDING_LEG.test(rel)) ||
      (rel.endsWith(".png") && TIMED_RECORDING_SHOTS.test(rel))
    ) {
      inSet.add(rel);
      liveTimed.push(rel);
    }
  }

  const shotRows: DeterminismReport["shot_rows"] = [];
  for (const rel of all.filter((f) => f.endsWith(".png") && !inSet.has(f))) {
    const shas = digests.map((d, i) =>
      has[i].has(rel) ? (d.png[rel] ?? null) : null,
    );
    const agree = shas.every((s) => s !== null && s === shas[0]);
    const row: DeterminismReport["shot_rows"][number] = {
      path: rel,
      agree,
      sha256: shas,
    };
    // a pixel report needs both images: runs given as directories (a runner's own repeats)
    const dir0 = loaded[0].dir;
    if (!agree && shas[0] && dir0) {
      row.diff = [];
      const a = await readFile(join(dir0, rel));
      for (let i = 1; i < runs.length; i++) {
        const di = loaded[i].dir;
        if (di && shas[i] && shas[i] !== shas[0])
          row.diff.push(await pixelDiff(a, await readFile(join(di, rel))));
      }
    }
    shotRows.push(row);
  }

  const dumpRows: DeterminismReport["dump_rows"] = [];
  for (const rel of all.filter((f) => isDump(f) && !inSet.has(f))) {
    const missing: number[] = [];
    const vals: Array<string | undefined> = [];
    for (let i = 0; i < runs.length; i++) {
      const v = has[i].has(rel) ? digests[i].dumps[rel] : undefined;
      if (v === undefined || v === null) {
        missing.push(i + 1); // unparseable counts as absent
        vals.push(undefined);
      } else vals.push(v);
    }
    const differs: number[] = [];
    for (let i = 1; i < runs.length; i++)
      if (vals[i] !== undefined && vals[0] !== undefined && vals[0] !== vals[i])
        differs.push(i + 1);
    const row: DeterminismReport["dump_rows"][number] = {
      path: rel,
      agree: missing.length === 0 && differs.length === 0,
      missing,
      differs_from_run1: differs,
    };
    if (differs.length > 0) {
      const ld = leafDiff(digests.map((d) => d.leaves?.[rel]));
      if (ld.count > 0) {
        row.fields_differing = ld.count;
        row.fields = ld.fields;
      }
    }
    dumpRows.push(row);
  }

  const shotsBad = shotRows.filter((r) => !r.agree).map((r) => r.path);
  const dumpsBad = dumpRows.filter((r) => !r.agree).map((r) => r.path);
  let buildIdentity: DeterminismReport["build_identity"];
  if (digests.some((d) => d.build_raw)) {
    const raw = digests.map((d) => d.build_raw ?? []);
    const content = digests.map((d) => d.build_content ?? []);
    const same = (xs: string[][]) => xs.every((x) => x.join() === xs[0].join());
    buildIdentity = {
      raw,
      content,
      raw_drift: !same(raw),
      content_agree: same(content),
    };
  }
  return {
    schema: "render-stream-remote-determinism/1",
    runs: runs.length,
    run_dirs: runs,
    ok:
      runs.length >= 2 &&
      shotRows.length > 0 &&
      provenanceAgree &&
      shotsBad.length === 0 &&
      dumpsBad.length === 0 &&
      liveSets.every((x) => x.agree) &&
      (buildIdentity?.content_agree ?? true),
    provenance,
    provenance_agree: provenanceAgree,
    shots: {
      total: shotRows.length,
      agree: shotRows.length - shotsBad.length,
      disagree: shotsBad,
    },
    dumps: {
      total: dumpRows.length,
      agree: dumpRows.length - dumpsBad.length,
      disagree: dumpsBad,
    },
    live_sets: liveSets,
    live_timed: liveTimed,
    ...(buildIdentity ? { build_identity: buildIdentity } : {}),
    shot_rows: shotRows,
    dump_rows: dumpRows,
  };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  return v;
}

async function main(argv: string[]): Promise<number> {
  let out: string | null = null;
  const runs: string[] = [];
  let digest: string | null = null;
  const records: unknown[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i] ?? null;
    else if (argv[i] === "--build-record") {
      const f = argv[++i];
      if (!f) {
        console.error("remote-determinism: --build-record FILE");
        return 2;
      }
      records.push(JSON.parse(await readFile(f, "utf8")));
    } else if (argv[i] === "--digest") digest = argv[++i] ?? null;
    else if (argv[i] === "--") continue;
    else runs.push(argv[i]);
  }
  if (digest !== null) {
    // R3: one run's digest, for the cross-runner comparison (compareRuns takes it as a run)
    if (!out || runs.length > 0) {
      console.error("remote-determinism: --digest RUN_DIR --out FILE.json");
      return 2;
    }
    const d = await digestRun(digest, buildContentMap(records));
    await writeFile(out, `${JSON.stringify(d)}\n`);
    console.log(
      `remote-determinism: digest of ${digest}: ${Object.keys(d.png).length} shots, ${Object.keys(d.dumps).length} dumps -> ${out}`,
    );
    return 0;
  }
  if (runs.length < 2) {
    console.error("remote-determinism: give at least two run directories");
    return 2;
  }
  const r = await compareRuns(runs, buildContentMap(records));
  if (out) await writeFile(out, `${JSON.stringify(r, null, 2)}\n`);
  for (const [i, p] of r.provenance.entries())
    console.log(
      `run ${i + 1}: ${runs[i]}\n  GL: ${p.gl_renderer ?? "?"}\n  Vulkan: ${p.vulkan_device ?? "?"}`,
    );
  for (const row of r.shot_rows.filter((x) => !x.agree)) {
    console.log(
      `DIFF shot ${row.path}: ${row.sha256.map((s) => s?.slice(0, 12) ?? "missing").join(" ")}`,
    );
    for (const d of row.diff ?? [])
      console.log(
        `  ${d.mismatched_pixels} px, bbox ${JSON.stringify(d.bbox)}, max delta rgba ${d.max_channel_delta.join("/")}`,
      );
  }
  for (const row of r.dump_rows.filter((x) => !x.agree)) {
    console.log(
      `DIFF dump ${row.path}: missing in ${JSON.stringify(row.missing)}, differs in ${JSON.stringify(row.differs_from_run1)}` +
        (row.fields_differing ? `, ${row.fields_differing} fields` : ""),
    );
    for (const f of (row.fields ?? []).slice(0, 4))
      console.log(`  ${f.path}: ${f.values.join(" | ")}`);
  }
  for (const ls of r.live_sets)
    console.log(
      `${ls.agree ? "live set ok" : "DIFF live set"} ${ls.dir} (${ls.kind}): distinct per run ${JSON.stringify(ls.distinct)}` +
        (ls.shared_states !== undefined
          ? `, ${ls.shared_states} states in 2+ runs${ls.inconsistent ? `, rendered two ways: ${ls.inconsistent.join(" ")}` : ""}`
          : ""),
    );
  if (r.build_identity)
    console.log(
      `build identity: content ${r.build_identity.content_agree ? "agrees" : "DIFFERS"}` +
        (r.build_identity.raw_drift
          ? `; raw pck sha256 drifts (info: export order, not content): ${r.build_identity.raw.map((x) => x.map((y) => y.slice(0, 12)).join(",")).join(" | ")}`
          : "; raw pck sha256 same"),
    );
  if (r.live_timed.length)
    console.log(
      `live-timed (applied.json, not compared): ${r.live_timed.length}`,
    );
  console.log(
    `remote-determinism: ${r.ok ? "AGREE" : "DISAGREE"} over ${r.runs} runs: shots ${r.shots.agree}/${r.shots.total}, ` +
      `dumps ${r.dumps.agree}/${r.dumps.total}, provenance ${r.provenance_agree ? "same" : "DIFFERS"}`,
  );
  return r.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
