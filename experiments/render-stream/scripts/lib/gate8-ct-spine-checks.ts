// Gate 8 g8ctsp checks (LATE-SPINE): a runtime-built CanvasTexture adopted at a late arm from the
// draw's own texture reference (the canvas_texture_* hooks' registry), not from a node's `texture`
// property -- the spine-godot shape, whose drawing node has no `texture`. The fixture is
// fixtures/gate8-ct-spine: the capture loads at frame 8, its arm is deferred (GRC_ARM_DEFER_FRAMES)
// to frame 14, and the CanvasTexture is created at frame 10 in between, so the hooks observe its
// channels while it is still pre-arm. The receiver legs (full and patch sinks) are judged against the unarmed reference like g8ctl's.
//
//   ctsp-legs                every leg that ran exited 0
//   ct-spine-adopt           the late capture adopts the runtime CanvasTexture from the registry
//                            (LAR1: canvas_registry; origin adopted, status ok, diffuse an ok
//                            image), nothing refused, no unknown-texture draw
//   ct-spine-adopt-named     LAR1, for F2: the adopted canvas texture is named by a command in the
//                            transaction that first carries it (the spine-godot shape)
//   ct-spine-fault           under GRC_ADOPT_FAULT=no-resources nothing is adopted and the draw
//                            stays unknown-texture (the pre-LATE-SPINE capture)
//   ct-spine-diffuse-uploaded  each receiver uploads the adopted diffuse
//   ct-spine-reference       each receiver equals the unarmed reference at every checkpoint and the
//                            expected.json MESH region holds ink

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  check,
  exitCode,
  type G8aCheck,
  loadRecording,
  readJson,
  skipped,
} from "./gate8-adopt-checks";
import {
  adoptedDiffuses,
  adoptionResources,
  adoptNamedProblems,
  adoptProblems,
  type CaptureResult,
  diffuseUploadProblems,
  faultProblems,
  referenceProblems,
  validateSinkProblems,
} from "./gate8-ct-late-checks";

export interface G8ctspExpected {
  schema: string;
  arm_frame: number;
  quit_frame: number;
  canvas_count: number;
  regions: Record<string, [number, number, number, number]>;
  cells: string[];
  clear_color: [number, number, number];
  checkpoints: { step: number; settle: number; blank?: string[] }[];
}

export interface G8ctspReport {
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

interface UploadRow {
  id: number;
  op: string;
}

export async function runG8ctsp(
  out: string,
  expected: G8ctspExpected,
): Promise<{ checks: G8aCheck[]; report: G8ctspReport }> {
  const g = join(out, "g8ctsp");
  const checks: G8aCheck[] = [];
  const report: G8ctspReport = { legs: {}, pixels: {}, diffuses: null };
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
    checks.push(
      check(
        "ctsp-legs",
        "LATE-SPINE: every g8ctsp leg that ran exited 0",
        any ? problems : null,
      ),
    );
  }

  // ct-spine-adopt
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
      if (res && res.canvas_registry !== expected.canvas_count)
        problems.push(
          `${res.canvas_registry} canvas textures from the registry, ${expected.canvas_count} expected`,
        );
      if (res)
        detail = `adopted ${res.textures_canvas} canvas textures, ${res.canvas_registry} from the registry (refused ${res.textures_refused})`;
    }
    checks.push(
      check(
        "ct-spine-adopt",
        "LATE-SPINE, LAR1: the late capture adopts the runtime CanvasTexture from the registry's recorded channels (origin adopted, status ok, its diffuse an ok image), nothing refused, no unknown-texture draw",
        problems,
        detail,
      ),
    );
  }

  // ct-spine-adopt-named (LAR1, for F2)
  {
    const leg = "late/capture";
    let problems: string[];
    let detail: string | undefined;
    if (!ran(leg)) {
      problems = ["late/capture did not run"];
    } else {
      const r = adoptNamedProblems(
        (await loadRecording(dir(leg), 8)).rec,
        expected.canvas_count,
      );
      problems = r.problems;
      detail = `${r.adopted} adopted canvas textures named`;
    }
    checks.push(
      check(
        "ct-spine-adopt-named",
        "LAR1 (for F2): the adopted canvas texture is named by a command in the transaction that first carries it",
        problems,
        detail,
      ),
    );
  }

  // ct-spine-fault
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
        "ct-spine-fault",
        "LATE-SPINE: under GRC_ADOPT_FAULT=no-resources no CanvasTexture is adopted and the draw through one stays unknown-texture (the pre-LATE-SPINE capture)",
        problems,
      ),
    );
  }

  // --- the receiver side: the adopted diffuse is resident and drawn --------------------------------
  const cap = await loadRecording(dir("late/capture"), 8);
  const diffuses = cap.rec ? adoptedDiffuses(cap.rec) : [];
  report.diffuses = diffuses.length > 0 ? diffuses : null;

  // ct-spine-diffuse-uploaded
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
        "ct-spine-diffuse-uploaded",
        "each receiver makes the adopted canvas texture's diffuse resident (an image upload) although no command names it: the named canvas texture names it (P3-CT; LAR8 retired GAP2-RX's adopted shortcut)",
        problems,
        `${diffuses.length} diffuses`,
      ),
    );
  }

  // ct-spine-reference
  {
    let problems: string[] | null = null;
    if (RECEIVERS.every((l) => ran(l)) && ran("reference"))
      problems = await referenceProblems(g, RECEIVERS, expected, report.pixels);
    checks.push(
      check(
        "ct-spine-reference",
        "each receiver (full and patch sinks) equals the unarmed reference exactly at every checkpoint, and the declared MESH cell holds the adopted diffuse's ink (not the clear colour, not Godot's white default)",
        problems,
      ),
    );
  }

  return { checks, report };
}
