// Gate 8 g8ctsp checks (LATE-SPINE): a runtime-built CanvasTexture adopted at a late arm from the
// draw's own texture reference (the canvas_texture_* hooks' registry), not from a node's `texture`
// property -- the spine-godot shape, whose drawing node has no `texture`. The fixture is
// fixtures/gate8-ct-spine: the capture loads at frame 8, its arm is deferred (GRC_ARM_DEFER_FRAMES)
// to frame 14, and the CanvasTexture is created at frame 10 in between, so the hooks observe its
// channels while it is still pre-arm. Capture-only (the receiver side is GAP2-RX's g8ctl).
//
//   ctsp-legs                every leg that ran exited 0
//   ct-spine-adopt           the late capture adopts the runtime CanvasTexture from the hooks'
//                            registry (origin adopted, status ok, diffuse an ok image), nothing
//                            refused, no unknown-texture draw
//   ct-spine-fault           under GRC_ADOPT_FAULT=no-resources nothing is adopted and the draw
//                            stays unknown-texture (the pre-LATE-SPINE capture)

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  check,
  exitCode,
  loadRecording,
  readJson,
  skipped,
  type G8aCheck,
} from "./gate8-adopt-checks";
import { type ResolvedRecording, validateRecording } from "./render-stream-2";

export interface G8ctspExpected {
  schema: string;
  arm_frame: number;
  quit_frame: number;
  canvas_count: number;
  regions: Record<string, [number, number, number, number]>;
  cells: string[];
  clear_color: [number, number, number];
  checkpoints: { step: number; settle: number }[];
}

export interface G8ctspReport {
  legs: Record<string, unknown>;
}

const LEGS = ["import/fixture", "import/receiver", "reference", "late/capture", "fault-no-resources/capture"];

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

export async function runG8ctsp(
  out: string,
  expected: G8ctspExpected,
): Promise<{ checks: G8aCheck[]; report: G8ctspReport }> {
  const g = join(out, "g8ctsp");
  const checks: G8aCheck[] = [];
  const report: G8ctspReport = { legs: {} };
  const dir = (leg: string) => join(g, leg);
  const ran = (leg: string) => existsSync(join(dir(leg), "exit-code.txt"));
  const result = async (leg: string) =>
    readJson<CaptureResult>(join(dir(leg), "evidence", "result.json"));

  // ctsp-legs
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
    checks.push(check("ctsp-legs", "LATE-SPINE: every g8ctsp leg that ran exited 0", any ? problems : null));
  }

  // ct-spine-adopt
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
        "ct-spine-adopt",
        "LATE-SPINE: the late capture adopts the runtime CanvasTexture from the canvas_texture_* hooks' registry (origin adopted, status ok, its diffuse an ok image), nothing refused, no unknown-texture draw",
        problems,
        detail,
      ),
    );
  }

  // ct-spine-fault
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
        "ct-spine-fault",
        "LATE-SPINE: under GRC_ADOPT_FAULT=no-resources no CanvasTexture is adopted and the draw through one stays unknown-texture (the pre-LATE-SPINE capture)",
        problems,
      ),
    );
  }

  return { checks, report };
}
