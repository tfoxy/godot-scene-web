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
//   ct-late-reference       each receiver equals the unarmed reference exactly at every checkpoint

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  check,
  exitCode,
  loadRecording,
  readJson,
  shotDiff,
  skipped,
  type G8aCheck,
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
  checkpoints: { step: number; settle: number }[];
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

interface CaptureResult {
  stream?: {
    gate8?: { adopt_stats?: { resources?: Record<string, number> } };
  };
}

function adoptionResources(r: CaptureResult | undefined): Record<string, number> | undefined {
  return r?.stream?.gate8?.adopt_stats?.resources;
}

/** The unsupported commands of `rec` with `reason` `unknown-texture`, over every transaction. */
function unknownTextureCount(rec: ResolvedRecording): number {
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
async function validateSinkProblems(legDir: string): Promise<string[]> {
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

/** The adopted `ok` canvas textures' diffuse ids in the last state of the capture. */
function adoptedDiffuses(rec: ResolvedRecording): number[] {
  const last = rec.transactions.at(-1);
  if (!last) return [];
  const byId = new Map(last.state.textures.map((x) => [x.id, x]));
  const out: number[] = [];
  for (const c of last.state.textures) {
    if (c.kind !== "canvas" || c.origin !== "adopted" || c.status !== "ok") continue;
    const d = c.canvas?.diffuse;
    const img = d == null ? undefined : byId.get(d);
    if (d != null && img && img.kind === "image" && img.status === "ok") out.push(d);
  }
  return out;
}

interface UploadRow {
  id: number;
  op: string;
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
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (!ran(leg)) {
      problems = ["late/capture did not run"];
    } else {
      problems = [];
      const res = adoptionResources(await result(leg));
      if (!res) problems.push("no stream.gate8.adopt_stats.resources");
      else {
        if (res.textures_canvas !== expected.canvas_count)
          problems.push(`adopted ${res.textures_canvas} canvas textures, ${expected.canvas_count} expected`);
        if ((res.textures_refused ?? 0) !== 0) problems.push(`refused ${res.textures_refused}`);
        detail = `adopted ${res.textures_canvas} canvas textures (refused ${res.textures_refused})`;
      }
      const rec = await loadRecording(dir(leg), 8);
      if (!rec.rec) problems.push(rec.error ?? "no recording");
      else {
        const last = rec.rec.transactions.at(-1);
        if (!last) problems.push("no transaction");
        else {
          const canvases = last.state.textures.filter((x) => x.kind === "canvas");
          if (canvases.length !== expected.canvas_count)
            problems.push(`${canvases.length} canvas textures in the last state, ${expected.canvas_count} expected`);
          const byId = new Map(last.state.textures.map((x) => [x.id, x]));
          for (const c of canvases) {
            if (c.origin !== "adopted") problems.push(`canvas ${c.id}: origin ${c.origin}`);
            if (c.status !== "ok") problems.push(`canvas ${c.id}: status ${c.status}`);
            const d = c.canvas?.diffuse;
            const img = d == null ? undefined : byId.get(d);
            if (d == null || !img || img.kind !== "image" || img.status !== "ok")
              problems.push(`canvas ${c.id}: diffuse ${d} is not an ok image`);
          }
        }
        const unknown = unknownTextureCount(rec.rec);
        if (unknown > 0) problems.push(`${unknown} unknown-texture commands over the recording`);
      }
      problems.push(...(await validateSinkProblems(dir(leg))));
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
    let problems: string[] | null = null;
    if (!ran(leg)) {
      problems = ["fault-no-resources/capture did not run"];
    } else {
      problems = [];
      const res = adoptionResources(await result(leg));
      if (!res) problems.push("no stream.gate8.adopt_stats.resources");
      else if ((res.textures_canvas ?? 0) !== 0)
        problems.push(`adopted ${res.textures_canvas} canvas textures under the fault`);
      const rec = await loadRecording(dir(leg), 8);
      if (!rec.rec) problems.push(rec.error ?? "no recording");
      else {
        const last = rec.rec.transactions.at(-1);
        const canvases = last ? last.state.textures.filter((x) => x.kind === "canvas") : [];
        if (canvases.length !== 0) problems.push(`last state has ${canvases.length} canvas entries`);
        const unknown = unknownTextureCount(rec.rec);
        if (unknown === 0) problems.push("no unknown-texture command under the fault");
      }
      problems.push(...(await validateSinkProblems(dir(leg))));
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
    let problems: string[] | null = [];
    for (const l of RECEIVERS) {
      if (!ran(l)) {
        problems = null;
        break;
      }
      const applied = await readJson<{ uploads?: UploadRow[] }>(join(dir(l), "applied.json"));
      if (!applied?.uploads) {
        problems.push(`${l}: no uploads[] in applied.json`);
        continue;
      }
      for (const d of diffuses)
        if (!applied.uploads.some((u) => u.id === d && (u.op === "create" || u.op === "replace")))
          problems.push(`${l}: diffuse ${d} never uploaded`);
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
    let problems: string[] | null = [];
    for (const l of RECEIVERS) {
      if (!ran(l) || !ran("reference")) {
        problems = null;
        break;
      }
      report.pixels[l] = [];
      for (const c of expected.checkpoints) {
        const d = await shotDiff(join(dir(l)), join(dir("reference")), c.step);
        if (!d.present) {
          problems.push(`${l} step ${c.step}: shot missing`);
          continue;
        }
        if (d.differing > 0)
          problems.push(`${l} step ${c.step}: ${d.differing} px differ (max ${d.max_delta})`);
        report.pixels[l].push({ step: c.step, differing: d.differing });
      }
    }
    checks.push(
      check(
        "ct-late-reference",
        "each receiver (full and patch sinks) equals the unarmed reference exactly at every checkpoint: the adopted canvas textures draw their diffuses, not Godot's white default",
        problems,
      ),
    );
  }

  return { checks, report };
}
