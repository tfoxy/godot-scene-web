// Gate 8 g8ctl checks (RT-CTX, results/p3/late-arm.md "Deferred"): a runtime-built CanvasTexture
// (built in code, no .tres) adopted at a late arm from the drawing item's node's `texture` (the
// node map), since the RenderingServer has no canvas-texture channel getter. The fixture is
// fixtures/gate8-ct-late; the check is capture-only, judged on result.json's
// stream.gate8.adopt_stats.resources and the recording's resolved texture table.
//
//   ctl-legs       every leg that ran exited 0
//   ct-late-adopt  the late capture adopts every runtime CanvasTexture from the node map (origin
//                  adopted, status ok, diffuse an ok image), nothing refused, no unknown-texture
//   ct-late-fault  under GRC_ADOPT_FAULT=no-resources nothing is adopted and the draws through a
//                  CanvasTexture stay unknown-texture (the pre-RT-CTX capture)

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { check, exitCode, loadRecording, readJson, skipped, type G8aCheck } from "./gate8-adopt-checks";
import { type ResolvedRecording, validateRecording } from "./render-stream-2";

export interface G8ctlExpected {
  schema: string;
  arm_frame: number;
  quit_frame: number;
  canvas_count: number;
  regions: Record<string, [number, number, number, number]>;
  cells: string[];
  clear_color: [number, number, number];
}

export interface G8ctlReport {
  legs: Record<string, unknown>;
}

const LEGS = ["import/fixture", "late/capture", "fault-no-resources/capture"];

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

export async function runG8ctl(
  out: string,
  expected: G8ctlExpected,
): Promise<{ checks: G8aCheck[]; report: G8ctlReport }> {
  const g = join(out, "g8ctl");
  const checks: G8aCheck[] = [];
  const report: G8ctlReport = { legs: {} };
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

  return { checks, report };
}
