// Gate 8 g8ctl checks (RT-CTX, results/p3/late-arm.md "Deferred"; GAP2-RX, results/p3/gap2-rx.md):
// a runtime-built CanvasTexture (built in code, no .tres) adopted at a late arm from the drawing
// item's node's `texture` (the node map), since the RenderingServer has no canvas-texture channel
// getter. The fixture is fixtures/gate8-ct-late. RT-CTX judged the capture only; GAP2-RX adds the
// receiver side: the adopted CanvasTexture's diffuse must be made resident and drawn, exactly as
// P3-CT's g8c proved for an arm-at-init CanvasTexture.
//
//   ctl-legs                every leg that ran exited 0
//   ct-late-adopt           the late capture adopts every runtime CanvasTexture from the node map
//                           (origin adopted, status ok, diffuse an ok image), nothing refused, no
//                           unknown-texture
//   ct-late-fault           under GRC_ADOPT_FAULT=no-resources nothing is adopted and the draws
//                           through a CanvasTexture stay unknown-texture (the pre-RT-CTX capture)
//   ct-late-diffuse-uploaded  each receiver makes every adopted canvas texture's diffuse resident
//                           (an image upload), although no command names the diffuse itself
//   ct-late-reference       each receiver equals the unarmed reference exactly at every checkpoint,
//                           and each declared region holds ink (or is blank once its cell is freed)
//   ct-late-free            the fixture frees a CanvasTexture after the arm: the capture's table drops
//                           it (and its diffuse) and a later receiver transaction releases a texture
//
// The judgements over resolved data are pure exported functions (adoptProblems, faultProblems,
// freeProblems, diffuseUploadProblems, releaseProblems, regionInkProblems) that
// test/self-test-gate8-ct-late.ts drives on synthetic ResolvedRecordings; the test encoder cannot emit
// /8 adopted canvas-texture entries.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  check,
  exitCode,
  loadRecording,
  readJson,
  shotDiff,
  shotPath,
  skipped,
  type G8aCheck,
  type Rect,
} from "./gate8-adopt-checks";
import { decodePngRgba } from "./gate-minus1-checks";
import { type ResolvedRecording, validateRecording } from "./render-stream-2";

export interface G8ctlExpected {
  schema: string;
  arm_frame: number;
  quit_frame: number;
  canvas_count: number;
  regions: Record<string, [number, number, number, number]>;
  cells: string[];
  clear_color: [number, number, number];
  /** `blank` names the cells that must be empty (the clear colour) at that checkpoint */
  checkpoints: { step: number; settle: number; blank?: string[] }[];
  /** the frame the fixture frees a CanvasTexture at (after the arm) and how many it frees */
  free_frame?: number;
  freed_canvas_count?: number;
}

export interface G8ctlReport {
  legs: Record<string, unknown>;
  pixels: Record<string, { step: number; differing: number }[]>;
  diffuses: number[] | null;
}

const LEGS = [
  "import/fixture",
  "import/receiver",
  "reference",
  "late/capture",
  "fault-no-resources/capture",
  "late/receiver",
  "late/receiver-patch",
];

const RECEIVERS = ["late/receiver", "late/receiver-patch"];

export interface CaptureResult {
  stream?: {
    gate8?: { adopt_stats?: { resources?: Record<string, number> } };
  };
}

export function adoptionResources(r: CaptureResult | undefined): Record<string, number> | undefined {
  return r?.stream?.gate8?.adopt_stats?.resources;
}

/** The unsupported commands of `rec` with `reason` `unknown-texture`, over every transaction. */
export function unknownTextureCount(rec: ResolvedRecording): number {
  let n = 0;
  for (const t of rec.transactions)
    for (const it of t.state.items)
      for (const c of it.commands)
        if (c.op === "unsupported" && c.reason === "unknown-texture") n++;
  return n;
}

const SINKS = ["recording.rs8", "recording-patch.rs8"] as const;

/** Both /8 sinks of a capture validated through the TypeScript validator (a well-formed adopted
 * canvas-texture entry must carry adopted_content when origin is adopted). */
export async function validateSinkProblems(legDir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const sink of SINKS) {
    let data: Uint8Array;
    try {
      data = new Uint8Array(await readFile(join(legDir, sink)));
    } catch {
      problems.push(`${sink}: missing`);
      continue;
    }
    const errors = validateRecording(data, 8);
    if (errors.length > 0) problems.push(`${sink}: ${errors[0].slice(0, 240)}`);
  }
  return problems;
}

type Tx = ResolvedRecording["transactions"][number];

/** The transaction holding the most canvas textures (the adoption peak; the first on a tie). */
function peakTransaction(rec: ResolvedRecording): Tx | undefined {
  let best: Tx | undefined;
  let bestN = -1;
  for (const t of rec.transactions) {
    const n = t.state.textures.filter((x) => x.kind === "canvas").length;
    if (n > bestN) {
      best = t;
      bestN = n;
    }
  }
  return best;
}

/** The adopted `ok` canvas textures' diffuse ids at the adoption peak of the capture. */
export function adoptedDiffuses(rec: ResolvedRecording): number[] {
  const peak = peakTransaction(rec);
  if (!peak) return [];
  const byId = new Map(peak.state.textures.map((x) => [x.id, x]));
  const out: number[] = [];
  for (const c of peak.state.textures) {
    if (c.kind !== "canvas" || c.origin !== "adopted" || c.status !== "ok") continue;
    const d = c.canvas?.diffuse;
    const img = d == null ? undefined : byId.get(d);
    if (d != null && img && img.kind === "image" && img.status === "ok") out.push(d);
  }
  return out;
}

export interface CanvasExpectation {
  canvas_count: number;
  freed_canvas_count?: number;
}

/** ct-late-adopt / ct-spine-adopt: the capture's result.json counters, its recording (resolved, or
 * why not) and its sinks. The peak transaction holds exactly `canvas_count` adopted ok canvas
 * textures with ok image diffuses; the last holds `canvas_count - freed_canvas_count`. */
export function adoptProblems(
  res: Record<string, number> | undefined,
  rec: { rec?: ResolvedRecording; error?: string },
  expected: CanvasExpectation,
  sinkProblems: string[],
): string[] {
  const problems: string[] = [];
  if (!(expected.canvas_count > 0)) problems.push(`expected canvas_count ${expected.canvas_count} is not positive`);
  if (!res) problems.push("no stream.gate8.adopt_stats.resources");
  else {
    if (res.textures_canvas !== expected.canvas_count)
      problems.push(`adopted ${res.textures_canvas} canvas textures, ${expected.canvas_count} expected`);
    if ((res.textures_refused ?? 0) !== 0) problems.push(`refused ${res.textures_refused}`);
  }
  if (!rec.rec) problems.push(rec.error ?? "no recording");
  else {
    const peak = peakTransaction(rec.rec);
    const last = rec.rec.transactions.at(-1);
    if (!peak || !last) problems.push("no transaction");
    else {
      const canvases = peak.state.textures.filter((x) => x.kind === "canvas");
      if (canvases.length !== expected.canvas_count)
        problems.push(`${canvases.length} canvas textures at the adoption peak, ${expected.canvas_count} expected`);
      const byId = new Map(peak.state.textures.map((x) => [x.id, x]));
      for (const c of canvases) {
        if (c.origin !== "adopted") problems.push(`canvas ${c.id}: origin ${c.origin}`);
        if (c.status !== "ok") problems.push(`canvas ${c.id}: status ${c.status}`);
        const d = c.canvas?.diffuse;
        const img = d == null ? undefined : byId.get(d);
        if (d == null || !img || img.kind !== "image" || img.status !== "ok")
          problems.push(`canvas ${c.id}: diffuse ${d} is not an ok image`);
      }
      const live = last.state.textures.filter((x) => x.kind === "canvas" && x.status === "ok").length;
      const want = expected.canvas_count - (expected.freed_canvas_count ?? 0);
      if (live !== want) problems.push(`${live} live canvas textures in the last state, ${want} expected`);
    }
    const unknown = unknownTextureCount(rec.rec);
    if (unknown > 0) problems.push(`${unknown} unknown-texture commands over the recording`);
  }
  problems.push(...sinkProblems);
  return problems;
}

/** ct-late-fault / ct-spine-fault: under GRC_ADOPT_FAULT=no-resources nothing is adopted. */
export function faultProblems(
  res: Record<string, number> | undefined,
  rec: { rec?: ResolvedRecording; error?: string },
  sinkProblems: string[],
): string[] {
  const problems: string[] = [];
  if (!res) problems.push("no stream.gate8.adopt_stats.resources");
  else if ((res.textures_canvas ?? 0) !== 0)
    problems.push(`adopted ${res.textures_canvas} canvas textures under the fault`);
  if (!rec.rec) problems.push(rec.error ?? "no recording");
  else {
    const last = rec.rec.transactions.at(-1);
    if (!last) problems.push("no transaction");
    const canvases = last ? last.state.textures.filter((x) => x.kind === "canvas") : [];
    if (canvases.length !== 0) problems.push(`last state has ${canvases.length} canvas entries`);
    const unknown = unknownTextureCount(rec.rec);
    if (unknown === 0) problems.push("no unknown-texture command under the fault");
  }
  problems.push(...sinkProblems);
  return problems;
}

/** ct-late-free (capture side): after `free_frame` the table no longer holds `freed_canvas_count`
 * of the peak's canvas textures, nor their diffuses (an entry gone, or a `freed` tombstone). */
export function freeProblems(rec: ResolvedRecording | undefined, expected: G8ctlExpected): string[] {
  const problems: string[] = [];
  const want = expected.freed_canvas_count ?? 0;
  if (!(want > 0)) problems.push("expected.freed_canvas_count is not positive");
  if (expected.free_frame === undefined) problems.push("expected.free_frame is missing");
  if (!rec) return [...problems, "no recording"];
  const peak = peakTransaction(rec);
  const last = rec.transactions.at(-1);
  if (!peak || !last) return [...problems, "no transaction"];
  if (expected.free_frame !== undefined && last.frame <= expected.free_frame)
    problems.push(`last transaction is frame ${last.frame}, not after the free at ${expected.free_frame}`);
  const alive = new Set(last.state.textures.filter((x) => x.status === "ok").map((x) => x.id));
  const gone = peak.state.textures.filter((x) => x.kind === "canvas" && !alive.has(x.id));
  if (gone.length !== want) problems.push(`${gone.length} canvas textures dropped from the table, ${want} expected`);
  for (const c of gone) {
    const d = c.canvas?.diffuse;
    if (d == null) problems.push(`canvas ${c.id}: no diffuse at the peak`);
    else if (alive.has(d)) problems.push(`canvas ${c.id}: diffuse ${d} is still an ok entry after its canvas texture was freed`);
  }
  return problems;
}

interface UploadRow {
  id: number;
  op: string;
}

/** ct-late-diffuse-uploaded: `diffuses` (from the capture) must number `canvas_count`, and every
 * receiver must have uploaded each. `uploads` is the receiver's applied.json uploads[] (undefined
 * when absent). */
export function diffuseUploadProblems(
  diffuses: readonly number[],
  expectedCount: number,
  uploads: Record<string, UploadRow[] | undefined>,
): string[] {
  const problems: string[] = [];
  if (diffuses.length === 0 || diffuses.length !== expectedCount)
    problems.push(`${diffuses.length} adopted diffuses in the capture, ${expectedCount} expected`);
  const legs = Object.keys(uploads);
  if (legs.length === 0) problems.push("no receiver leg");
  for (const l of legs) {
    const u = uploads[l];
    if (!u) {
      problems.push(`${l}: no uploads[] in applied.json`);
      continue;
    }
    for (const d of diffuses)
      if (!u.some((x) => x.id === d && (x.op === "create" || x.op === "replace")))
        problems.push(`${l}: diffuse ${d} never uploaded`);
  }
  return problems;
}

interface AppliedTx {
  frame?: number;
  resources?: { freed?: number } | null;
}

/** ct-late-free (receiver side): the transactions applied at or after `free_frame` release at
 * least `min` textures (applied.json transactions[].resources.freed). */
export function releaseProblems(
  txs: readonly AppliedTx[] | undefined,
  freeFrame: number | undefined,
  min: number,
): string[] {
  if (!txs || txs.length === 0) return ["no transactions[] in applied.json"];
  if (freeFrame === undefined || !(min > 0)) return ["expected free_frame / freed_canvas_count missing"];
  let freed = 0;
  let after = 0;
  for (const t of txs)
    if (typeof t.frame === "number" && t.frame >= freeFrame) {
      after++;
      freed += t.resources?.freed ?? 0;
    }
  if (after === 0) return [`no transaction applied at or after frame ${freeFrame}`];
  if (freed < min) return [`${freed} textures released at or after frame ${freeFrame}, at least ${min} expected`];
  return [];
}

/** One declared region of a receiver's shot: more than half its pixels differ from the clear colour
 * (`wantInk`) or at most 1% do (blank). Reads the shot of checkpoint `step` in `legDir`. */
export async function regionInkProblems(
  legDir: string,
  step: number,
  name: string,
  rect: Rect | undefined,
  clear: readonly number[],
  wantInk: boolean,
): Promise<string[]> {
  if (!rect) return [`${name}: no region declared`];
  const p = await shotPath(legDir, step);
  const img = existsSync(p) ? await decodePngRgba(p) : undefined;
  if (!img) return [`step ${step} ${name}: shot missing`];
  let n = 0;
  let ink = 0;
  for (let y = rect[1]; y <= rect[3]; y++)
    for (let x = rect[0]; x <= rect[2]; x++) {
      if (x >= img.width || y >= img.height) continue;
      n++;
      const i = (y * img.width + x) * 4;
      if (
        Math.abs(img.data[i] - clear[0]) > 2 ||
        Math.abs(img.data[i + 1] - clear[1]) > 2 ||
        Math.abs(img.data[i + 2] - clear[2]) > 2
      )
        ink++;
    }
  if (n === 0) return [`step ${step} ${name}: region outside the shot`];
  if (wantInk && ink * 2 <= n) return [`step ${step} ${name}: only ${ink}/${n} px differ from the clear colour`];
  if (!wantInk && ink * 100 > n) return [`step ${step} ${name}: ${ink}/${n} px differ from the clear colour, blank expected`];
  return [];
}

/** ct-late-reference / ct-spine-reference over the receivers: shots equal the unarmed reference at
 * every checkpoint, and every declared cell holds ink (or is blank where the checkpoint says). */
export async function referenceProblems(
  base: string,
  receivers: readonly string[],
  expected: Pick<G8ctlExpected, "checkpoints" | "regions" | "cells" | "clear_color">,
  pixels?: Record<string, { step: number; differing: number }[]>,
): Promise<string[]> {
  const problems: string[] = [];
  if (expected.checkpoints.length === 0) problems.push("expected.checkpoints is empty");
  if (expected.cells.length === 0) problems.push("expected.cells is empty");
  for (const l of receivers) {
    if (pixels) pixels[l] = [];
    for (const c of expected.checkpoints) {
      const d = await shotDiff(join(base, l), join(base, "reference"), c.step);
      if (!d.present) {
        problems.push(`${l} step ${c.step}: shot missing`);
        continue;
      }
      if (d.differing > 0) problems.push(`${l} step ${c.step}: ${d.differing} px differ (max ${d.max_delta})`);
      pixels?.[l].push({ step: c.step, differing: d.differing });
      for (const cell of expected.cells)
        problems.push(
          ...(await regionInkProblems(
            join(base, l),
            c.step,
            cell,
            expected.regions[cell],
            expected.clear_color,
            !(c.blank ?? []).includes(cell),
          )),
        );
    }
  }
  return problems;
}

export async function runG8ctl(
  out: string,
  expected: G8ctlExpected,
): Promise<{ checks: G8aCheck[]; report: G8ctlReport }> {
  const g = join(out, "g8ctl");
  const checks: G8aCheck[] = [];
  const report: G8ctlReport = { legs: {}, pixels: {}, diffuses: null };
  const dir = (leg: string) => join(g, leg);
  const ran = (leg: string) => existsSync(join(dir(leg), "exit-code.txt"));
  const result = async (leg: string) =>
    readJson<CaptureResult>(join(dir(leg), "evidence", "result.json"));

  // ctl-legs
  {
    const problems: string[] = [];
    let any = false;
    for (const leg of LEGS) {
      if (skipped(dir(leg))) continue;
      const rc = await exitCode(dir(leg));
      if (rc === null) problems.push(`${leg}: did not run`);
      else {
        any = true;
        if (rc !== "0") problems.push(`${leg}: exit ${rc}`);
      }
    }
    checks.push(check("ctl-legs", "RT-CTX: every g8ctl leg that ran exited 0", any ? problems : null));
  }

  // ct-late-adopt
  {
    const leg = "late/capture";
    let problems: string[];
    let detail: string | undefined;
    if (!ran(leg)) {
      problems = ["late/capture did not run"];
    } else {
      const res = adoptionResources(await result(leg));
      problems = adoptProblems(
        res,
        await loadRecording(dir(leg), 8),
        expected,
        await validateSinkProblems(dir(leg)),
      );
      if (res) detail = `adopted ${res.textures_canvas} canvas textures (refused ${res.textures_refused})`;
    }
    checks.push(
      check(
        "ct-late-adopt",
        "RT-CTX: the late capture adopts every runtime CanvasTexture from the drawing item's node (origin adopted, status ok, its diffuse an ok image), nothing refused, no unknown-texture draw",
        problems,
        detail,
      ),
    );
  }

  // ct-late-fault
  {
    const leg = "fault-no-resources/capture";
    let problems: string[];
    if (!ran(leg)) {
      problems = ["fault-no-resources/capture did not run"];
    } else {
      problems = faultProblems(
        adoptionResources(await result(leg)),
        await loadRecording(dir(leg), 8),
        await validateSinkProblems(dir(leg)),
      );
    }
    checks.push(
      check(
        "ct-late-fault",
        "RT-CTX: under GRC_ADOPT_FAULT=no-resources no CanvasTexture is adopted and the draws through one stay unknown-texture (the pre-RT-CTX capture)",
        problems,
      ),
    );
  }

  // --- GAP2-RX: the receiver side ----------------------------------------------------------------
  const cap = await loadRecording(dir("late/capture"), 8);
  const diffuses = cap.rec ? adoptedDiffuses(cap.rec) : [];
  report.diffuses = diffuses.length > 0 ? diffuses : null;

  // ct-late-diffuse-uploaded
  {
    let problems: string[] | null = null;
    if (RECEIVERS.every((l) => ran(l))) {
      const uploads: Record<string, UploadRow[] | undefined> = {};
      for (const l of RECEIVERS)
        uploads[l] = (await readJson<{ uploads?: UploadRow[] }>(join(dir(l), "applied.json")))?.uploads;
      problems = diffuseUploadProblems(diffuses, expected.canvas_count, uploads);
    }
    checks.push(
      check(
        "ct-late-diffuse-uploaded",
        "each receiver makes every adopted canvas texture's diffuse resident (an image upload), although no command names the diffuse itself: an adopted canvas texture names its diffuse",
        problems,
        `${diffuses.length} diffuses`,
      ),
    );
  }

  // ct-late-reference
  {
    let problems: string[] | null = null;
    if (RECEIVERS.every((l) => ran(l)) && ran("reference"))
      problems = await referenceProblems(g, RECEIVERS, expected, report.pixels);
    checks.push(
      check(
        "ct-late-reference",
        "each receiver (full and patch sinks) equals the unarmed reference exactly at every checkpoint, and every declared cell holds the adopted diffuse's ink (blank once its cell is freed): the adopted canvas textures draw their diffuses, not Godot's white default",
        problems,
      ),
    );
  }

  // ct-late-free
  {
    let problems: string[] | null = null;
    if (ran("late/capture") && RECEIVERS.every((l) => ran(l))) {
      problems = freeProblems(cap.rec, expected);
      for (const l of RECEIVERS) {
        const applied = await readJson<{ transactions?: unknown }>(join(dir(l), "applied.json"));
        const txs = Array.isArray(applied?.transactions) ? (applied.transactions as never[]) : undefined;
        problems.push(...releaseProblems(txs, expected.free_frame === undefined ? undefined : expected.free_frame - 2, expected.freed_canvas_count ?? 0).map((x) => `${l}: ${x}`));
      }
    }
    checks.push(
      check(
        "ct-late-free",
        "the fixture frees a runtime CanvasTexture after the arm: the capture's table drops it and its diffuse (no ok entry after the free) and each receiver releases a texture in a transaction at or after the free",
        problems,
      ),
    );
  }

  return { checks, report };
}
