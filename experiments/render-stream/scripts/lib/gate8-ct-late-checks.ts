// Gate 8 g8ctl checks (RT-CTX; GAP2-RX; LAR1): CanvasTextures adopted at a late arm, three built in
// code (no .tres) and one cached `.tres`. The fixture is fixtures/gate8-ct-late. Since LAR1 the
// `deferred` leg (the capture loaded before the scene, the arm deferred to frame 12) adopts every
// CanvasTexture from the registry's recorded channels, and its receivers are judged against the
// unarmed reference; the `late` leg (loaded at frame 12, load-late, F1) judges the residual path:
// the cached `.tres` adopted through the resource cache (PM9), the runtime ones refused, typed.
//
//   ctl-legs                every leg that ran exited 0
//   ct-late-adopt           the deferred capture adopts every CanvasTexture (origin adopted, status
//                           ok, diffuse an ok image), nothing refused, no unknown-texture
//   ctl-registry-source     LAR1: on deferred every adopted CanvasTexture came from the registry
//                           (canvas_registry == canvas_count, canvas_residual 0), and registry.json
//                           recorded them
//   ct-adopt-named          LAR1, for F2 (LAR8): every adopted canvas texture is named by a command
//                           in the transaction that first carries it (deferred and late)
//   ct-late-residual        LAR1 (F1): the late capture adopts the cached `.tres` from the resource
//                           cache and refuses the runtime CanvasTextures, every refusal typed
//                           no-image, their draws unknown-texture
//   ct-late-fault           under GRC_ADOPT_FAULT=no-resources nothing is adopted and the draws
//                           through a CanvasTexture stay unknown-texture (late, unchanged)
//   sabotage-registry-off   LAR1: the deferred capture under GRC_ADOPT_FAULT=registry-off fails
//                           ctl-registry-source and ct-late-adopt
//   ct-late-diffuse-uploaded  each receiver makes every adopted canvas texture's diffuse resident
//                           (an image upload), although no command names the diffuse itself
//   ct-late-reference       each receiver equals the unarmed reference exactly at every checkpoint,
//                           and each declared region holds ink (or is blank once its cell is freed)
//   ct-late-free            the fixture frees a CanvasTexture after the arm: the capture's table drops
//                           it (and its diffuse) and a later receiver transaction releases a texture
//
// The judgements over resolved data are pure exported functions (adoptProblems, faultProblems,
// registrySourceProblems, adoptNamedProblems, residualProblems, freeProblems,
// diffuseUploadProblems, releaseProblems, regionInkProblems) that test/self-test-gate8-ct-late.ts
// drives on synthetic ResolvedRecordings; the test encoder cannot emit /8 adopted canvas-texture
// entries.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePngRgba } from "./gate-minus1-checks";
import {
  check,
  exitCode,
  type G8aCheck,
  loadRecording,
  type Rect,
  readJson,
  shotDiff,
  shotPath,
  skipped,
} from "./gate8-adopt-checks";
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
  /** LAR1 (F1): the late leg's residual path -- canvas textures adopted from the resource cache,
   * and the typed no-image refusals (the runtime-built cells, whose draws stay unknown-texture) */
  late?: LateResidualExpectation;
}

export interface LateResidualExpectation {
  canvas_residual: number;
  refused_no_image: number;
  unknown_cells?: string[];
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
  "deferred/capture",
  "late/capture",
  "fault-no-resources/capture",
  "sabotage-registry-off/capture",
  "deferred/receiver",
  "deferred/receiver-patch",
];

const RECEIVERS = ["deferred/receiver", "deferred/receiver-patch"];

export interface CaptureResult {
  stream?: {
    gate8?: { adopt_stats?: { resources?: Record<string, number> } };
  };
}

export function adoptionResources(
  r: CaptureResult | undefined,
): Record<string, number> | undefined {
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
    if (c.kind !== "canvas" || c.origin !== "adopted" || c.status !== "ok")
      continue;
    const d = c.canvas?.diffuse;
    const img = d == null ? undefined : byId.get(d);
    if (d != null && img && img.kind === "image" && img.status === "ok")
      out.push(d);
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
  if (!(expected.canvas_count > 0))
    problems.push(
      `expected canvas_count ${expected.canvas_count} is not positive`,
    );
  if (!res) problems.push("no stream.gate8.adopt_stats.resources");
  else {
    if (res.textures_canvas !== expected.canvas_count)
      problems.push(
        `adopted ${res.textures_canvas} canvas textures, ${expected.canvas_count} expected`,
      );
    if ((res.textures_refused ?? 0) !== 0)
      problems.push(`refused ${res.textures_refused}`);
  }
  if (!rec.rec) problems.push(rec.error ?? "no recording");
  else {
    const peak = peakTransaction(rec.rec);
    const last = rec.rec.transactions.at(-1);
    if (!peak || !last) problems.push("no transaction");
    else {
      const canvases = peak.state.textures.filter((x) => x.kind === "canvas");
      if (canvases.length !== expected.canvas_count)
        problems.push(
          `${canvases.length} canvas textures at the adoption peak, ${expected.canvas_count} expected`,
        );
      const byId = new Map(peak.state.textures.map((x) => [x.id, x]));
      for (const c of canvases) {
        if (c.origin !== "adopted")
          problems.push(`canvas ${c.id}: origin ${c.origin}`);
        if (c.status !== "ok")
          problems.push(`canvas ${c.id}: status ${c.status}`);
        const d = c.canvas?.diffuse;
        const img = d == null ? undefined : byId.get(d);
        if (d == null || !img || img.kind !== "image" || img.status !== "ok")
          problems.push(`canvas ${c.id}: diffuse ${d} is not an ok image`);
      }
      const live = last.state.textures.filter(
        (x) => x.kind === "canvas" && x.status === "ok",
      ).length;
      const want = expected.canvas_count - (expected.freed_canvas_count ?? 0);
      if (live !== want)
        problems.push(
          `${live} live canvas textures in the last state, ${want} expected`,
        );
    }
    const unknown = unknownTextureCount(rec.rec);
    if (unknown > 0)
      problems.push(`${unknown} unknown-texture commands over the recording`);
  }
  problems.push(...sinkProblems);
  return problems;
}

/** registry.json's canvas texture family (only what ctl-registry-source reads). */
export interface RegistryEvidence {
  enabled?: boolean;
  fault?: string;
  families?: Record<string, { creates?: number } | undefined>;
}

/** ctl-registry-source (LAR1): every adopted canvas texture came from the registry -- the capture
 * adopted `canvasCount`, all of them `canvas_registry`, none through the residual path, nothing
 * refused -- and registry.json shows a recording registry that saw at least that many
 * CanvasTexture creates. */
export function registrySourceProblems(
  res: Record<string, number> | undefined,
  reg: RegistryEvidence | undefined,
  canvasCount: number,
): string[] {
  const problems: string[] = [];
  if (!(canvasCount > 0))
    problems.push(`expected canvas_count ${canvasCount} is not positive`);
  if (!res) problems.push("no stream.gate8.adopt_stats.resources");
  else {
    if (res.canvas_registry === undefined)
      problems.push("no canvas_registry counter (pre-LAR1 capture)");
    else if (res.canvas_registry !== canvasCount)
      problems.push(
        `${res.canvas_registry} canvas textures from the registry, ${canvasCount} expected`,
      );
    if ((res.canvas_residual ?? 0) !== 0)
      problems.push(
        `${res.canvas_residual} canvas textures through the residual path`,
      );
    if ((res.textures_canvas ?? 0) !== canvasCount)
      problems.push(
        `adopted ${res.textures_canvas} canvas textures, ${canvasCount} expected`,
      );
    if ((res.textures_refused ?? 0) !== 0)
      problems.push(`refused ${res.textures_refused}`);
  }
  if (!reg) problems.push("no evidence/registry.json");
  else {
    if (reg.enabled !== true)
      problems.push(`registry not recording (fault ${reg.fault})`);
    const creates = reg.families?.canvas_texture?.creates ?? 0;
    if (creates < canvasCount)
      problems.push(
        `registry.json: ${creates} canvas texture creates, at least ${canvasCount} expected`,
      );
  }
  return problems;
}

/** The texture ids a command names (its `tex`). */
function commandTexture(c: unknown): number | undefined {
  const t = (c as { tex?: unknown }).tex;
  return typeof t === "number" ? t : undefined;
}

/** ct-adopt-named (LAR1, for F2): every adopted canvas texture is named by a command (`tex`) in the
 * transaction that first carries it, so a receiver needs no "adopted names its diffuse" shortcut
 * (GAP2-RX, retired in LAR8) to make its diffuse resident. At least `minAdopted` must be adopted. */
export function adoptNamedProblems(
  rec: ResolvedRecording | undefined,
  minAdopted: number,
): { problems: string[]; adopted: number } {
  if (!rec) return { problems: ["no recording"], adopted: 0 };
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const t of rec.transactions) {
    const named = new Set<number>();
    for (const it of t.state.items)
      for (const c of it.commands) {
        const id = commandTexture(c);
        if (id !== undefined) named.add(id);
      }
    for (const x of t.state.textures) {
      if (x.kind !== "canvas" || x.origin !== "adopted" || seen.has(x.id))
        continue;
      seen.add(x.id);
      if (!named.has(x.id))
        problems.push(
          `canvas ${x.id}: first carried at seq ${t.seq} (frame ${t.frame}) with no command naming it`,
        );
    }
  }
  if (seen.size < minAdopted)
    problems.push(
      `${seen.size} adopted canvas textures, at least ${minAdopted} expected`,
    );
  return { problems, adopted: seen.size };
}

/** ct-late-residual (LAR1, F1): the late capture -- loaded after every CanvasTexture exists, so the
 * registry holds none -- adopts exactly `late.canvas_residual` canvas textures, all through the
 * residual path (the resource cache), and refuses `late.refused_no_image`, every refusal typed
 * no-image; the refused draws stay unknown-texture, and the last state holds the adopted ones. */
export function residualProblems(
  res: Record<string, number> | undefined,
  rec: { rec?: ResolvedRecording; error?: string },
  late: LateResidualExpectation | undefined,
): string[] {
  if (!late) return ["expected.late is missing"];
  const problems: string[] = [];
  if (!res) problems.push("no stream.gate8.adopt_stats.resources");
  else {
    if (res.canvas_residual !== late.canvas_residual)
      problems.push(
        `${res.canvas_residual} canvas textures through the residual path, ${late.canvas_residual} expected`,
      );
    if ((res.canvas_registry ?? 0) !== 0)
      problems.push(`${res.canvas_registry} canvas textures from the registry`);
    if ((res.textures_canvas ?? 0) !== late.canvas_residual)
      problems.push(
        `adopted ${res.textures_canvas} canvas textures, ${late.canvas_residual} expected`,
      );
    if (res.refused_no_image !== late.refused_no_image)
      problems.push(
        `${res.refused_no_image} no-image refusals, ${late.refused_no_image} expected`,
      );
    const typed = (res.refused_no_image ?? 0) + (res.refused_canvas_empty ?? 0);
    if ((res.textures_refused ?? 0) !== typed)
      problems.push(
        `${res.textures_refused} textures refused, only ${typed} of them typed`,
      );
  }
  if (!rec.rec) problems.push(rec.error ?? "no recording");
  else {
    const last = rec.rec.transactions.at(-1);
    const canvases = last
      ? last.state.textures.filter(
          (x) =>
            x.kind === "canvas" && x.origin === "adopted" && x.status === "ok",
        ).length
      : 0;
    if (canvases !== late.canvas_residual)
      problems.push(
        `${canvases} adopted ok canvas textures in the last state, ${late.canvas_residual} expected`,
      );
    if (late.refused_no_image > 0 && unknownTextureCount(rec.rec) === 0)
      problems.push("no unknown-texture command for the refused CanvasTextures");
  }
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
    problems.push(
      `adopted ${res.textures_canvas} canvas textures under the fault`,
    );
  if (!rec.rec) problems.push(rec.error ?? "no recording");
  else {
    const last = rec.rec.transactions.at(-1);
    if (!last) problems.push("no transaction");
    const canvases = last
      ? last.state.textures.filter((x) => x.kind === "canvas")
      : [];
    if (canvases.length !== 0)
      problems.push(`last state has ${canvases.length} canvas entries`);
    const unknown = unknownTextureCount(rec.rec);
    if (unknown === 0)
      problems.push("no unknown-texture command under the fault");
  }
  problems.push(...sinkProblems);
  return problems;
}

/** ct-late-free (capture side): after `free_frame` the table no longer holds `freed_canvas_count`
 * of the peak's canvas textures, nor their diffuses (an entry gone, or a `freed` tombstone). */
export function freeProblems(
  rec: ResolvedRecording | undefined,
  expected: G8ctlExpected,
): string[] {
  const problems: string[] = [];
  const want = expected.freed_canvas_count ?? 0;
  if (!(want > 0)) problems.push("expected.freed_canvas_count is not positive");
  if (expected.free_frame === undefined)
    problems.push("expected.free_frame is missing");
  if (!rec) return [...problems, "no recording"];
  const peak = peakTransaction(rec);
  const last = rec.transactions.at(-1);
  if (!peak || !last) return [...problems, "no transaction"];
  if (expected.free_frame !== undefined && last.frame <= expected.free_frame)
    problems.push(
      `last transaction is frame ${last.frame}, not after the free at ${expected.free_frame}`,
    );
  const alive = new Set(
    last.state.textures.filter((x) => x.status === "ok").map((x) => x.id),
  );
  const gone = peak.state.textures.filter(
    (x) => x.kind === "canvas" && !alive.has(x.id),
  );
  if (gone.length !== want)
    problems.push(
      `${gone.length} canvas textures dropped from the table, ${want} expected`,
    );
  for (const c of gone) {
    const d = c.canvas?.diffuse;
    if (d == null) problems.push(`canvas ${c.id}: no diffuse at the peak`);
    else if (alive.has(d))
      problems.push(
        `canvas ${c.id}: diffuse ${d} is still an ok entry after its canvas texture was freed`,
      );
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
    problems.push(
      `${diffuses.length} adopted diffuses in the capture, ${expectedCount} expected`,
    );
  const legs = Object.keys(uploads);
  if (legs.length === 0) problems.push("no receiver leg");
  for (const l of legs) {
    const u = uploads[l];
    if (!u) {
      problems.push(`${l}: no uploads[] in applied.json`);
      continue;
    }
    for (const d of diffuses)
      if (
        !u.some((x) => x.id === d && (x.op === "create" || x.op === "replace"))
      )
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
  if (freeFrame === undefined || !(min > 0))
    return ["expected free_frame / freed_canvas_count missing"];
  let freed = 0;
  let after = 0;
  for (const t of txs)
    if (typeof t.frame === "number" && t.frame >= freeFrame) {
      after++;
      freed += t.resources?.freed ?? 0;
    }
  if (after === 0)
    return [`no transaction applied at or after frame ${freeFrame}`];
  if (freed < min)
    return [
      `${freed} textures released at or after frame ${freeFrame}, at least ${min} expected`,
    ];
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
  if (wantInk && ink * 2 <= n)
    return [
      `step ${step} ${name}: only ${ink}/${n} px differ from the clear colour`,
    ];
  if (!wantInk && ink * 100 > n)
    return [
      `step ${step} ${name}: ${ink}/${n} px differ from the clear colour, blank expected`,
    ];
  return [];
}

/** ct-late-reference / ct-spine-reference over the receivers: shots equal the unarmed reference at
 * every checkpoint, and every declared cell holds ink (or is blank where the checkpoint says). */
export async function referenceProblems(
  base: string,
  receivers: readonly string[],
  expected: Pick<
    G8ctlExpected,
    "checkpoints" | "regions" | "cells" | "clear_color"
  >,
  pixels?: Record<string, { step: number; differing: number }[]>,
): Promise<string[]> {
  const problems: string[] = [];
  if (expected.checkpoints.length === 0)
    problems.push("expected.checkpoints is empty");
  if (expected.cells.length === 0) problems.push("expected.cells is empty");
  for (const l of receivers) {
    if (pixels) pixels[l] = [];
    for (const c of expected.checkpoints) {
      const d = await shotDiff(join(base, l), join(base, "reference"), c.step);
      if (!d.present) {
        problems.push(`${l} step ${c.step}: shot missing`);
        continue;
      }
      if (d.differing > 0)
        problems.push(
          `${l} step ${c.step}: ${d.differing} px differ (max ${d.max_delta})`,
        );
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
  const ran = (leg: string) =>
    existsSync(join(dir(leg), "exit-code.txt")) && skipped(dir(leg)) === null;
  const result = async (leg: string) =>
    readJson<CaptureResult>(join(dir(leg), "evidence", "result.json"));
  const registry = async (leg: string) =>
    readJson<RegistryEvidence>(join(dir(leg), "evidence", "registry.json"));

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
    checks.push(
      check(
        "ctl-legs",
        "every g8ctl leg that ran exited 0",
        any ? problems : null,
      ),
    );
  }

  // ct-late-adopt (LAR1: on deferred)
  {
    const leg = "deferred/capture";
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (ran(leg)) {
      const res = adoptionResources(await result(leg));
      problems = adoptProblems(
        res,
        await loadRecording(dir(leg), 8),
        expected,
        await validateSinkProblems(dir(leg)),
      );
      if (res)
        detail = `adopted ${res.textures_canvas} canvas textures (refused ${res.textures_refused})`;
    }
    if (problems === null) problems = [`${leg} did not run`];
    checks.push(
      check(
        "ct-late-adopt",
        "LAR1: the deferred capture (loaded before the scene, armed at frame 12) adopts every CanvasTexture, runtime-built and cached (origin adopted, status ok, its diffuse an ok image), nothing refused, no unknown-texture draw",
        problems,
        detail,
      ),
    );
  }

  // ctl-registry-source (LAR1)
  {
    const leg = "deferred/capture";
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (ran(leg)) {
      const res = adoptionResources(await result(leg));
      problems = registrySourceProblems(
        res,
        await registry(leg),
        expected.canvas_count,
      );
      if (res)
        detail = `${res.canvas_registry} from the registry, ${res.canvas_residual} residual`;
    }
    if (problems === null) problems = [`${leg} did not run`];
    checks.push(
      check(
        "ctl-registry-source",
        "LAR1: on deferred every adopted CanvasTexture came from the registry's recorded channels (canvas_registry == canvas_count, canvas_residual 0, nothing refused) and registry.json recorded their creates",
        problems,
        detail,
      ),
    );
  }

  // ct-adopt-named (LAR1, for F2): deferred (every cell) and late (the cached one)
  {
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (ran("deferred/capture") && ran("late/capture")) {
      const d = adoptNamedProblems(
        (await loadRecording(dir("deferred/capture"), 8)).rec,
        expected.canvas_count,
      );
      const l = adoptNamedProblems(
        (await loadRecording(dir("late/capture"), 8)).rec,
        expected.late?.canvas_residual ?? 1,
      );
      problems = [
        ...d.problems.map((x) => `deferred: ${x}`),
        ...l.problems.map((x) => `late: ${x}`),
      ];
      detail = `deferred ${d.adopted}, late ${l.adopted} adopted canvas textures named`;
    }
    if (problems === null)
      problems = ["deferred/capture or late/capture did not run"];
    checks.push(
      check(
        "ct-adopt-named",
        "LAR1 (for F2): every adopted canvas texture is named by a command in the transaction that first carries it, on deferred and late",
        problems,
        detail,
      ),
    );
  }

  // ct-late-residual (LAR1, F1)
  {
    const leg = "late/capture";
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (ran(leg)) {
      const res = adoptionResources(await result(leg));
      problems = residualProblems(
        res,
        await loadRecording(dir(leg), 8),
        expected.late,
      );
      problems.push(...(await validateSinkProblems(dir(leg))));
      if (res)
        detail = `${res.canvas_residual} residual (PM9), ${res.refused_no_image} refused no-image of ${res.textures_refused}`;
    }
    if (problems === null) problems = [`${leg} did not run`];
    checks.push(
      check(
        "ct-late-residual",
        "LAR1 (F1): the late capture (loaded after every CanvasTexture exists) adopts the cached .tres through the resource cache (PM9) and refuses the runtime-built CanvasTextures, every refusal typed no-image, their draws unknown-texture",
        problems,
        detail,
      ),
    );
  }

  // ct-late-fault
  {
    const leg = "fault-no-resources/capture";
    let problems: string[] | null = null;
    if (ran(leg)) {
      problems = faultProblems(
        adoptionResources(await result(leg)),
        await loadRecording(dir(leg), 8),
        await validateSinkProblems(dir(leg)),
      );
    }
    if (problems === null) problems = [`${leg} did not run`];
    checks.push(
      check(
        "ct-late-fault",
        "under GRC_ADOPT_FAULT=no-resources (late) no CanvasTexture is adopted and the draws through one stay unknown-texture",
        problems,
      ),
    );
  }

  // sabotage-registry-off (LAR1)
  {
    const leg = "sabotage-registry-off/capture";
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (ran(leg)) {
      problems = [];
      const res = adoptionResources(await result(leg));
      const reg = await registry(leg);
      const rec = await loadRecording(dir(leg), 8);
      // The sabotage's own evidence must exist, or both checks would fail vacuously.
      if (!res) problems.push("no stream.gate8.adopt_stats.resources");
      if (reg?.fault !== "registry-off")
        problems.push(`its registry.json names fault ${reg?.fault}`);
      if (!rec.rec) problems.push(rec.error ?? "no recording");
      const source = registrySourceProblems(res, reg, expected.canvas_count);
      const adopt = adoptProblems(res, rec, expected, []);
      if (source.length === 0) problems.push("ctl-registry-source did not fail");
      if (adopt.length === 0) problems.push("ct-late-adopt did not fail");
      detail = `ctl-registry-source ${source.length} problems, ct-late-adopt ${adopt.length}`;
    }
    if (problems === null) problems = [`${leg} did not run`];
    checks.push(
      check(
        "sabotage-registry-off",
        "LAR1: the deferred capture under GRC_ADOPT_FAULT=registry-off (the registry records nothing, so the deferred leg is a load-late one) fails ctl-registry-source and ct-late-adopt",
        problems,
        detail,
      ),
    );
  }

  // --- GAP2-RX: the receiver side ----------------------------------------------------------------
  const cap = await loadRecording(dir("deferred/capture"), 8);
  const diffuses = cap.rec ? adoptedDiffuses(cap.rec) : [];
  report.diffuses = diffuses.length > 0 ? diffuses : null;

  // ct-late-diffuse-uploaded
  {
    let problems: string[] | null = null;
    if (RECEIVERS.every((l) => ran(l))) {
      const uploads: Record<string, UploadRow[] | undefined> = {};
      for (const l of RECEIVERS)
        uploads[l] = (
          await readJson<{ uploads?: UploadRow[] }>(
            join(dir(l), "applied.json"),
          )
        )?.uploads;
      problems = diffuseUploadProblems(
        diffuses,
        expected.canvas_count,
        uploads,
      );
    }
    checks.push(
      check(
        "ct-late-diffuse-uploaded",
        "each receiver makes every adopted canvas texture's diffuse resident (an image upload), although no command names the diffuse itself: the named canvas texture names it (P3-CT; LAR8 retired GAP2-RX's adopted shortcut)",
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
    if (ran("deferred/capture") && RECEIVERS.every((l) => ran(l))) {
      problems = freeProblems(cap.rec, expected);
      for (const l of RECEIVERS) {
        const applied = await readJson<{ transactions?: unknown }>(
          join(dir(l), "applied.json"),
        );
        const txs = Array.isArray(applied?.transactions)
          ? (applied.transactions as never[])
          : undefined;
        problems.push(
          ...releaseProblems(
            txs,
            expected.free_frame === undefined
              ? undefined
              : expected.free_frame - 2,
            expected.freed_canvas_count ?? 0,
          ).map((x) => `${l}: ${x}`),
        );
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
