// Gate 3 checks and leg classification (protocol/gate3-design.md "Q7" and "G3a").
//
// Everything here reads an evidence directory written by run-gate3.sh, or is pure over values
// already read from one, so scripts/test/self-test-gate3.ts can drive it with fabricated trees.
// Nothing launches a process. Classification never reads `session.sabotage`. Result classes are
// gate 2's, unchanged (D11).
//
// Group g3a: the axis-aligned fixture's capture (both sinks), its rendered reference, a same-build
// repeat and an extension-armed reference. The clip semantics are checked three ways: the rendered
// reference against expected.json (exact images and named 1 px probes either side of every scissor
// edge), the recording's retained clip state against expected.json's invariants, and every final
// scissor recomputed from the recording (lib/clip-derive.ts) against expected.json's clip_rects.
//
// Evidence layout under <out>/ (see scripts/README.md "Gate 3"):
//   legs.json, binary.json
//   import/fixture/                editor --import of fixtures/gate3
//   capture/                       400-frame capture host, GRC_ROOT_SIZE=enforce-min-size:
//                                  evidence/ (result, counters, root, ...), recording.rs2,
//                                  recording-patch.rs2, store/, steps.jsonl, strace.txt, maps.txt
//   reference/, reference-repeat/  rendered fixture, extension absent: shots/step-<k>.png,
//                                  steps.jsonl
//   reference-armed/               rendered fixture, extension armed with a full-sink stream: the
//                                  same plus evidence/, recording.rs2 and store/

import { join } from "node:path";

import {
  type ClipRect,
  type DerivedEntry,
  deriveClipRects,
  ownerClip,
} from "./clip-derive";
import {
  decodePngRgba,
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type CaptureResultJson,
  checkCaptureArmed,
  checkHeadlessNoGpuGate0,
  checkRecordingDecodes,
  classifyLeg,
  type DrawIndexTie,
  diffRgba,
  firstTransactionWithRectColor,
  type Gate0Check,
  loadRecording,
  PATCH_RECORDING_NAME,
  parseStepLog,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
  type StepLine,
} from "./gate0-checks";
import {
  classifyGate1,
  mapNames,
  type NameMap,
  patchDivergence,
  recordingTies,
  stateAtFrame,
  statesOf,
  type TxState,
} from "./gate1-checks";
import type { Gate1Expected } from "./gate1-expected";
import type { Gate2Class } from "./gate2-checks";
import {
  type ClipRectValue,
  clipValueEqual,
  formatClip,
  type Gate3Expected,
  type Gate3Invariant,
  pixelAt,
  stepFrames3,
  synthesizeGate3,
  visibleRect,
} from "./gate3-expected";

// ---------------------------------------------------------------------------------------------
// Constants of the contract
// ---------------------------------------------------------------------------------------------

/** The capture leg's quit frame: one transaction per frame, so 400 transactions. */
export const G3A_CAPTURE_QUIT_FRAME = 400;

export type Gate3Class = Gate2Class;

export const ALL_GROUPS = ["g3a", "g3b", "g3c", "g3d"] as const;
/** Groups whose increment has landed; run-gate3.sh's LANDED_GROUPS must say the same. */
export const LANDED_GROUPS: readonly string[] = ["g3a"];

export const G3A_SUPPORT_LEGS = [
  "import",
  "reference",
  "reference-repeat",
  "reference-armed",
] as const;

const LEVELS = new Set([0, 51, 102, 153, 204, 255]);

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

export type Gate3Check = Gate0Check & { status: "pass" | "fail" | "not-run" };

export function check(
  id: string,
  criterion: string,
  problems: string[],
  okDetail: string,
  evidence: string[],
): Gate3Check {
  return {
    id,
    criterion,
    passed: problems.length === 0,
    status: problems.length === 0 ? "pass" : "fail",
    detail: problems.length === 0 ? okDetail : problems.join("; "),
    evidence,
  };
}

function fromGate0(c: Gate0Check, criterion?: string): Gate3Check {
  return {
    ...c,
    criterion: criterion ?? c.criterion,
    status: c.passed ? "pass" : "fail",
  };
}

function inside(r: readonly number[], outer: readonly number[]): boolean {
  return (
    r[0] >= outer[0] &&
    r[1] >= outer[1] &&
    r[2] <= outer[0] + outer[2] &&
    r[3] <= outer[1] + outer[3]
  );
}

/** expected.json obeys its own rules (gate3-design.md Q6a colour rule, Q6c probe rule). */
export function checkExpectedSelfConsistent(
  expected: Gate3Expected,
): Gate3Check {
  const problems: string[] = [];
  const [w, h] = expected.viewport ?? [];
  if (expected.schema !== "render-stream-gate3-expected/1")
    problems.push(`schema=${JSON.stringify(expected.schema)}`);
  if (w !== 640 || h !== 360)
    problems.push(`viewport=${JSON.stringify(expected.viewport)}`);
  const S = expected.start_frame_default;
  const N = expected.step_frames_default;
  const last = expected.last_step;
  if (expected.settle_offset !== 7) problems.push("settle_offset is not 7");
  if (expected.quit_frame_default !== S + N * last + 11)
    problems.push(
      `quit_frame_default ${expected.quit_frame_default} != S+N*last_step+11 = ${S + N * last + 11}`,
    );
  const steps = expected.steps ?? [];
  if (
    steps.map((s) => s.step).join(",") !== [...Array(last + 1).keys()].join(",")
  )
    problems.push(
      `steps are ${steps.map((s) => s.step).join(",")}, expected 0..${last}`,
    );
  const names = new Set(expected.creation_order);
  const markerColors = new Set<string>();
  const otherColors = new Set<string>();
  const regions = Object.values(expected.regions ?? {});
  const empty = expected.empty_region;
  for (const step of steps) {
    // Colour rule and layout.
    for (const d of step.draws) {
      if (!names.has(d.name))
        problems.push(`step ${step.step}: unknown draw ${d.name}`);
      if (!d.rgba8.every((v) => LEVELS.has(v)) || d.rgba8[3] !== 255)
        problems.push(
          `step ${step.step}: ${d.name} rgba8 ${d.rgba8.join(",")} breaks the colour rule`,
        );
      (d.name === "Marker" ? markerColors : otherColors).add(d.rgba8.join(","));
      const vis = visibleRect(d, expected.viewport);
      if (!vis) continue;
      if (!regions.some((r) => inside(vis, r)))
        problems.push(
          `step ${step.step}: ${d.name} paints [${vis.join(",")}) outside every region`,
        );
      if (
        vis[0] < empty[0] + empty[2] &&
        empty[0] < vis[2] &&
        vis[1] < empty[1] + empty[3] &&
        empty[1] < vis[3]
      )
        problems.push(
          `step ${step.step}: ${d.name} paints in ${empty.join(",")}`,
        );
      if (
        d.clip_px &&
        !d.clip_px.every((v) => Number.isInteger(v)) &&
        expected.fixture === "gate3"
      )
        problems.push(`step ${step.step}: ${d.name} has a fractional scissor`);
    }
    const markers = step.draws.filter((d) => d.name === "Marker");
    if (
      markers.length !== 1 ||
      markers[0].rgba8.join(",") !== step.marker_rgba8.join(",")
    )
      problems.push(
        `step ${step.step}: the Marker draw does not carry marker_rgba8`,
      );
    // The hand table of Q6b equals the derived clip_rects.
    const hand = expected.hand_clip_rects?.[String(step.step)];
    for (const owner of expected.owners) {
      const derived = step.clip_rects?.[owner];
      if (!hand || !clipValueEqual(hand[owner], derived))
        problems.push(
          `step ${step.step}: ${owner} derived ${formatClip(derived)}, hand table ${formatClip(hand?.[owner])}`,
        );
    }
    // Probe pairs: 1 px apart across their edge, names well formed, pairs complete.
    const byPair = new Map<string, typeof step.probes>();
    for (const p of step.probes) {
      const m = /^(.+)\.(left|right|top|bottom)\.(inside|outside)\.(\d+)$/.exec(
        p.name,
      );
      if (!m || m[1] !== p.owner || m[2] !== p.edge || m[3] !== p.side)
        problems.push(`step ${step.step}: probe name ${p.name} is malformed`);
      const key = `${p.owner}.${p.edge}.${m?.[4] ?? "?"}`;
      byPair.set(key, [...(byPair.get(key) ?? []), p]);
      if (!expected.owners.includes(p.owner))
        problems.push(`step ${step.step}: probe ${p.name} names a non-owner`);
    }
    for (const [key, pair] of byPair) {
      const i = pair.find((p) => p.side === "inside");
      const o = pair.find((p) => p.side === "outside");
      if (pair.length !== 2 || !i || !o) {
        problems.push(`step ${step.step}: probe pair ${key} is incomplete`);
        continue;
      }
      const [dx, dy] = [o.xy[0] - i.xy[0], o.xy[1] - i.xy[1]];
      const want = {
        left: [-1, 0],
        right: [1, 0],
        top: [0, -1],
        bottom: [0, 1],
      }[i.edge];
      if (dx !== want[0] || dy !== want[1])
        problems.push(
          `step ${step.step}: probe pair ${key} is not 1 px apart across its ${i.edge} edge`,
        );
      const rect = step.clip_rects?.[i.owner];
      if (Array.isArray(rect)) {
        const onEdge =
          (i.edge === "left" && i.xy[0] === rect[0]) ||
          (i.edge === "right" && i.xy[0] === rect[2] - 1) ||
          (i.edge === "top" && i.xy[1] === rect[1]) ||
          (i.edge === "bottom" && i.xy[1] === rect[3] - 1);
        if (!onEdge)
          problems.push(
            `step ${step.step}: probe pair ${key}'s inside pixel is not on ${i.owner}'s ${i.edge} edge [${rect.join(",")})`,
          );
      } else {
        problems.push(
          `step ${step.step}: probe pair ${key} names ${i.owner}, which has no scissor`,
        );
      }
      const decisive = o.unclipped_rgba8.join(",") !== o.rgba8.join(",");
      if (i.decisive !== decisive || o.decisive !== decisive)
        problems.push(
          `step ${step.step}: probe pair ${key} decisive flag is not (outside unclipped != outside)`,
        );
    }
    // Probe colours equal the synthesized frames.
    const clipped = synthesizeGate3(expected, step.step);
    const unclipped = synthesizeGate3(expected, step.step, { clips: false });
    for (const p of step.probes) {
      if (pixelAt(clipped, p.xy[0], p.xy[1]).join(",") !== p.rgba8.join(","))
        problems.push(
          `step ${step.step}: probe ${p.name} rgba8 is not the synthesized pixel`,
        );
      if (
        pixelAt(unclipped, p.xy[0], p.xy[1]).join(",") !==
        p.unclipped_rgba8.join(",")
      )
        problems.push(
          `step ${step.step}: probe ${p.name} unclipped_rgba8 is not the unclipped pixel`,
        );
    }
  }
  // Decisive coverage: every owner edge decisive at two or more steps, or listed.
  const listed = new Set(
    (expected.non_decisive_edges ?? []).map((e) => `${e.owner}.${e.edge}`),
  );
  for (const owner of expected.owners)
    for (const edge of ["left", "right", "top", "bottom"]) {
      const covered = new Set(
        steps
          .filter((s) =>
            s.probes.some(
              (p) => p.owner === owner && p.edge === edge && p.decisive,
            ),
          )
          .map((s) => s.step),
      );
      const key = `${owner}.${edge}`;
      if (covered.size < 2 && !listed.has(key))
        problems.push(
          `${key} is decisive at ${covered.size} step(s) and not in non_decisive_edges`,
        );
      if (covered.size >= 2 && listed.has(key))
        problems.push(`${key} is listed non-decisive but is decisive`);
    }
  if (markerColors.size !== steps.length)
    problems.push(
      `${markerColors.size} distinct marker colours for ${steps.length} steps`,
    );
  for (const c of markerColors)
    if (otherColors.has(c))
      problems.push(`marker colour ${c} is also drawn by another add_rect`);
  const probes = steps.reduce((n, s) => n + s.probes.length, 0);
  const decisive = steps.reduce(
    (n, s) =>
      n + s.probes.filter((p) => p.decisive && p.side === "outside").length,
    0,
  );
  return check(
    "expected-self-consistent",
    `expected.json obeys its rules: 640x360, steps 0..${last}, every colour component in {0,51,..,255} with alpha 255, every painted rect inside a region and none in ${JSON.stringify(empty)}, one distinct marker colour per step; every probe pair 1 px apart across its owner's edge with colours equal to the synthesized and unclipped frames; every owner edge decisive at two or more steps or listed; the derived clip_rects equal the hand table of gate3-design.md Q6b`,
    problems,
    `${steps.length} steps, ${steps.reduce((n, s) => n + s.draws.length, 0)} draws, ${probes} probes (${decisive} decisive pairs), ${(expected.non_decisive_edges ?? []).length} listed non-decisive edge(s), hand table matches`,
    [],
  );
}

export async function checkStepAlignment(
  outDir: string,
  expected: Gate3Expected,
  recording: RecordingSummary,
): Promise<Gate3Check> {
  const want: StepLine[] = expected.steps.map((s) => {
    const f = stepFrames3(expected, s.step);
    return { step: s.step, applied_frame: f.applied, settle_frame: f.settle };
  });
  const problems: string[] = [];
  const paths: string[] = [];
  for (const leg of [
    "capture",
    "reference",
    "reference-repeat",
    "reference-armed",
  ]) {
    const path = join(outDir, leg, "steps.jsonl");
    paths.push(path);
    const got = parseStepLog(await readTextOrUndefined(path));
    if (JSON.stringify(got) !== JSON.stringify(want))
      problems.push(`${leg} steps.jsonl ${JSON.stringify(got)} != expected`);
  }
  const firsts: string[] = [];
  for (const s of expected.steps) {
    const t = firstTransactionWithRectColor(
      recording.transactions,
      s.marker_rgba8.map((c) => c / 255),
    );
    const applied = stepFrames3(expected, s.step).applied;
    firsts.push(`${s.step}@${t?.meta.frame ?? "none"}`);
    if (t?.meta.frame !== applied)
      problems.push(
        `step ${s.step}: marker colour first published at frame ${t?.meta.frame ?? "<none>"}, expected ${applied}`,
      );
  }
  return check(
    "step-alignment",
    `capture and every reference steps.jsonl list steps 0..${expected.last_step} at S+N*k (settle +7), and each step's marker colour first appears in the capture transaction of its applied frame`,
    problems,
    `marker colours first published at ${firsts.join(", ")}`,
    [...paths, recording.path],
  );
}

/** validateRecording is [] for both sinks, each with 400 transactions from frame 1. */
export function checkRecordingsDecode(
  full: RecordingSummary,
  patch: RecordingSummary,
): Gate3Check {
  const a = checkRecordingDecodes(full);
  const b = checkRecordingDecodes(patch);
  const problems = [
    ...(a.passed ? [] : [`full: ${a.detail}`]),
    ...(b.passed ? [] : [`patch: ${b.detail}`]),
  ];
  return check(
    "recording-decodes",
    `validateRecording is [] for both capture sinks (recording.rs2 full, recording-patch.rs2 patch), each starting at frame 1 with ${G3A_CAPTURE_QUIT_FRAME} transactions`,
    problems,
    `full ${a.detail}; patch ${b.detail}`,
    [full.path, patch.path],
  );
}

export function checkPatchResolvesToFull(
  full: RecordingSummary,
  patch: RecordingSummary,
): Gate3Check {
  const problems = [...patchDivergence(full, patch)];
  if (full.transactions.length === 0) problems.push("no transactions decoded");
  return check(
    "patch-resolves-to-full",
    "the capture's patch sink, resolved, equals the full sink at every frame -- canvases, items (clip and custom rect included), the default texture filter/repeat and the texture table -- floats bit for bit",
    problems,
    `${patch.transactions.length} frames resolve bit-identically`,
    [full.path, patch.path],
  );
}

/** No draw-index tie that could change a pixel (G1b2's harmless rule); harmless ones are listed. */
export function checkNoDrawIndexTies(full: RecordingSummary): {
  check: Gate3Check;
  ties: DrawIndexTie[];
} {
  const ties = recordingTies(full);
  const problems = ties
    .filter((t) => !t.harmless)
    .map(
      (t) =>
        `frame ${t.frame} ${t.container} {${t.members.join(",")}}@${t.draw_index} overlaps (footprints ${JSON.stringify(t.footprints)})`,
    );
  if (full.transactions.length === 0) problems.push("no transactions decoded");
  return {
    check: check(
      "no-draw-index-ties",
      "the capture recording has no draw-index tie whose members' paint footprints overlap (render-stream-0.md invariant 9, G1b2's harmless rule); harmless ties are reported",
      problems,
      ties.length === 0
        ? "no draw-index ties"
        : `${ties.length} harmless tie(s): ${ties.map((t) => `frame ${t.frame} ${t.container} {${t.members.join(",")}}`).join("; ")}`,
      [full.path],
    ),
    ties,
  };
}

export interface Gate3Checkpoint {
  leg: string;
  step: number;
  shot: string;
  /** full-frame pixels differing from synthesizeGate3; null when unreadable */
  mismatched_pixels: number | null;
  max_channel_delta: number | null;
  regions: {
    name: string;
    mismatched_pixels: number;
    max_channel_delta: number;
  }[];
}

/** One leg's shots against synthesizeGate3, full frame and every region, exact. */
export async function compareShotsWithSynth(
  outDir: string,
  leg: string,
  expected: Gate3Expected,
): Promise<{
  problems: string[];
  checkpoints: Gate3Checkpoint[];
  paths: string[];
}> {
  const problems: string[] = [];
  const checkpoints: Gate3Checkpoint[] = [];
  const paths: string[] = [];
  for (const s of expected.steps) {
    const shot = join(outDir, leg, "shots", `step-${s.step}.png`);
    paths.push(shot);
    const cp: Gate3Checkpoint = {
      leg,
      step: s.step,
      shot,
      mismatched_pixels: null,
      max_channel_delta: null,
      regions: [],
    };
    checkpoints.push(cp);
    const got = await decodePngRgba(shot);
    if (!got) {
      problems.push(`step ${s.step}: ${shot} missing or unreadable`);
      continue;
    }
    const want = synthesizeGate3(expected, s.step);
    if (got.width !== want.width || got.height !== want.height) {
      problems.push(
        `step ${s.step}: ${got.width}x${got.height}, expected ${want.width}x${want.height}`,
      );
      continue;
    }
    const d = diffRgba(want.rgba, got.data, want.width, want.height);
    cp.mismatched_pixels = d.mismatched_pixels;
    cp.max_channel_delta = d.max_channel_delta;
    for (const [name, rect] of Object.entries(expected.regions)) {
      const r = diffRgba(want.rgba, got.data, want.width, want.height, rect);
      cp.regions.push({ name, ...r });
    }
    if (d.mismatched_pixels > 0) {
      const bad = cp.regions
        .filter((r) => r.mismatched_pixels > 0)
        .map((r) => `${r.name} ${r.mismatched_pixels}`);
      problems.push(
        `step ${s.step}: ${d.mismatched_pixels} pixels differ from synthesizeGate3 (max channel delta ${d.max_channel_delta}; regions ${bad.join(", ") || "none"})`,
      );
    }
  }
  return { problems, checkpoints, paths };
}

export async function checkExpectedImageReference(
  outDir: string,
  expected: Gate3Expected,
): Promise<{ check: Gate3Check; checkpoints: Gate3Checkpoint[] }> {
  const r = await compareShotsWithSynth(outDir, "reference", expected);
  return {
    check: check(
      "expected-image-reference",
      `each reference/shots/step-<k>.png (k = 0..${expected.last_step}) equals synthesizeGate3(k) exactly (maxChannelDelta 0), full frame and every region`,
      r.problems,
      `${r.paths.length} reference shots match exactly, full frame and ${Object.keys(expected.regions).length} regions`,
      r.paths,
    ),
    checkpoints: r.checkpoints,
  };
}

export interface ProbeTally {
  total: number;
  decisive: number;
  failed: string[];
}

/** Every probe of every step against one leg's shots, by name. */
export async function probeTally(
  outDir: string,
  leg: string,
  expected: Gate3Expected,
): Promise<{
  tally: Record<string, ProbeTally>;
  problems: string[];
  paths: string[];
}> {
  const tally: Record<string, ProbeTally> = {};
  const problems: string[] = [];
  const paths: string[] = [];
  for (const s of expected.steps) {
    const shot = join(outDir, leg, "shots", `step-${s.step}.png`);
    paths.push(shot);
    const got = await decodePngRgba(shot);
    const t: ProbeTally = {
      total: s.probes.length,
      decisive: s.probes.filter((p) => p.decisive && p.side === "outside")
        .length,
      failed: [],
    };
    tally[s.step] = t;
    if (!got) {
      problems.push(`step ${s.step}: ${shot} missing or unreadable`);
      t.failed = s.probes.map((p) => p.name);
      continue;
    }
    const frame = { width: got.width, rgba: got.data };
    for (const p of s.probes) {
      const px = pixelAt(frame, p.xy[0], p.xy[1]);
      if (px.join(",") !== p.rgba8.join(",")) t.failed.push(p.name);
    }
    if (t.failed.length > 0)
      problems.push(
        `step ${s.step}: ${t.failed.length} probe(s) differ: ${t.failed.slice(0, 6).join(", ")}${t.failed.length > 6 ? ", ..." : ""}`,
      );
  }
  return { tally, problems, paths };
}

export async function checkProbesReference(
  outDir: string,
  expected: Gate3Expected,
): Promise<{ check: Gate3Check; tally: Record<string, ProbeTally> }> {
  const r = await probeTally(outDir, "reference", expected);
  const total = Object.values(r.tally).reduce((n, t) => n + t.total, 0);
  const decisive = Object.values(r.tally).reduce((n, t) => n + t.decisive, 0);
  return {
    check: check(
      "probes-reference",
      "every named probe (1 px inside and outside each scissor edge, at every step) has exactly its expected colour in the reference shots",
      r.problems,
      `${total} probes exact over ${expected.steps.length} steps (${decisive} decisive pairs)`,
      r.paths,
    ),
    tally: r.tally,
  };
}

export async function checkReferenceRepeatBudget(
  outDir: string,
  expected: Gate3Expected,
): Promise<Gate3Check> {
  const problems: string[] = [];
  const paths: string[] = [];
  for (const s of expected.steps) {
    const a = join(outDir, "reference", "shots", `step-${s.step}.png`);
    const b = join(outDir, "reference-repeat", "shots", `step-${s.step}.png`);
    paths.push(a, b);
    const ia = await decodePngRgba(a);
    const ib = await decodePngRgba(b);
    if (!ia || !ib || ia.width !== ib.width || ia.height !== ib.height) {
      problems.push(
        `step ${s.step}: a shot is missing, unreadable or of another size`,
      );
      continue;
    }
    const d = diffRgba(ia.data, ib.data, ia.width, ia.height);
    if (d.mismatched_pixels > 0)
      problems.push(
        `step ${s.step}: reference and reference-repeat differ in ${d.mismatched_pixels} pixels (max channel delta ${d.max_channel_delta})`,
      );
  }
  return check(
    "reference-repeat-budget",
    "reference vs reference-repeat (same build, GPU, driver): identical everywhere at every step -- the budget is 0 (gate3-design.md D8; there is no band in the axis-aligned fixture)",
    problems,
    `budget 0: ${expected.steps.length} step pairs identical`,
    paths,
  );
}

export async function checkArmedTransparent(
  outDir: string,
  expected: Gate3Expected,
): Promise<Gate3Check> {
  const problems: string[] = [];
  const paths: string[] = [];
  const result = await readJson<CaptureResultJson>(
    join(outDir, "reference-armed", "evidence", "result.json"),
  );
  if (result?.status !== "armed")
    problems.push(
      `reference-armed result.json status=${JSON.stringify(result?.status)}`,
    );
  if (result?.stream?.status !== "closed")
    problems.push(
      `reference-armed stream.status=${JSON.stringify(result?.stream?.status)}`,
    );
  for (const s of expected.steps) {
    const a = join(outDir, "reference", "shots", `step-${s.step}.png`);
    const b = join(outDir, "reference-armed", "shots", `step-${s.step}.png`);
    paths.push(b);
    const ia = await decodePngRgba(a);
    const ib = await decodePngRgba(b);
    if (!ia || !ib || ia.width !== ib.width || ia.height !== ib.height) {
      problems.push(
        `step ${s.step}: a shot is missing, unreadable or of another size`,
      );
      continue;
    }
    const d = diffRgba(ia.data, ib.data, ia.width, ia.height);
    if (d.mismatched_pixels > 0)
      problems.push(
        `step ${s.step}: ${d.mismatched_pixels} pixels differ (max channel delta ${d.max_channel_delta})`,
      );
  }
  return check(
    "armed-transparent",
    "reference-armed (extension armed, stream on) armed with its stream closed, and every shot equals reference's exactly (full frame): the hooks forward untouched",
    problems,
    `${expected.steps.length} armed shots byte-identical to the reference`,
    paths,
  );
}

// ---------------------------------------------------------------------------------------------
// Retained clip state and derived scissors
// ---------------------------------------------------------------------------------------------

/** Names to wire ids by creation order, cross-checked by step-0 colours (gate 1's rule). */
export function mapNames3(
  expected: Gate3Expected,
  states: readonly TxState[],
): NameMap {
  // expected.json carries gate 1's creation_order / created_later / timeline keys and step-0
  // draws with name + rgba8, which is all mapNames reads.
  return mapNames(expected as unknown as Gate1Expected, states);
}

const f32eq = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === Math.fround(b[i]));

/** Every invariant of every step on one sink's settle transactions. */
export function evaluateClipInvariants(
  expected: Gate3Expected,
  states: readonly TxState[],
  names: NameMap,
): { problems: string[]; evaluated: number } {
  const problems: string[] = [];
  let evaluated = 0;
  const settle = (step: number) =>
    stateAtFrame(states, stepFrames3(expected, step).settle);
  for (const step of expected.steps) {
    const now = settle(step.step);
    if (!now) {
      problems.push(`step ${step.step}: no settle transaction`);
      continue;
    }
    const item = (name: string, st: TxState) => {
      const id = names.byName.get(name);
      return id === undefined ? undefined : st.items.get(id);
    };
    const fail = (text: string) => problems.push(`step ${step.step}: ${text}`);
    for (const inv of step.invariants as Gate3Invariant[]) {
      evaluated++;
      switch (inv.kind) {
        case "clip": {
          const it = item(inv.item, now);
          if (it?.clip !== inv.value)
            fail(`${inv.item}.clip = ${it?.clip}, expected ${inv.value}`);
          break;
        }
        case "custom_rect": {
          const it = item(inv.item, now);
          if (
            !it ||
            it.custom_rect !== inv.enabled ||
            !f32eq(it.custom_rect_rect, inv.rect)
          )
            fail(
              `${inv.item}.custom_rect = ${it?.custom_rect} [${it?.custom_rect_rect?.join(",")}], expected ${inv.enabled} [${inv.rect.join(",")}]`,
            );
          break;
        }
        case "commands": {
          const it = item(inv.item, now);
          if (it?.commands.length !== inv.count)
            fail(
              `${inv.item} has ${it?.commands.length ?? "?"} commands, expected ${inv.count}`,
            );
          break;
        }
        case "content_unchanged":
        case "version": {
          const then = settle(inv.step);
          if (!then) {
            fail(`no settle transaction for step ${inv.step}`);
            break;
          }
          const cmp = inv.kind === "version" ? inv.cmp : "eq";
          for (const name of inv.items) {
            const a = item(name, now);
            const b = item(name, then);
            if (!a || !b) {
              fail(`${name} absent for the version comparison`);
              continue;
            }
            const ok =
              cmp === "eq"
                ? a.content_version === b.content_version
                : a.content_version > b.content_version;
            if (!ok)
              fail(
                `${name}.content_version ${a.content_version} is not ${cmp} step ${inv.step}'s ${b.content_version}`,
              );
          }
          break;
        }
        case "canvas_xform": {
          const cv = now.canvases.get(inv.canvas);
          if (!cv || !f32eq(cv.xform, inv.value))
            fail(
              `canvas ${inv.canvas} transform ${JSON.stringify(cv?.xform ?? null)}, expected ${JSON.stringify(inv.value)}`,
            );
          break;
        }
      }
    }
  }
  return { problems, evaluated };
}

export function checkClipStateInvariants(
  expected: Gate3Expected,
  full: RecordingSummary,
  patch: RecordingSummary,
): Gate3Check {
  const problems: string[] = [];
  let evaluated = 0;
  let ids = "";
  for (const [sink, rec] of [
    ["full", full],
    ["patch", patch],
  ] as const) {
    const states = statesOf(rec);
    const names = mapNames3(expected, states);
    const r = evaluateClipInvariants(expected, states, names);
    problems.push(
      ...[...names.problems, ...r.problems].map((p) => `${sink}: ${p}`),
    );
    evaluated += r.evaluated;
    if (sink === "full")
      ids = [...names.byName.entries()]
        .map(([n, id]) => `${n}=${id}`)
        .join(" ");
  }
  return check(
    "clip-state-invariants",
    "every expected.json invariant -- clip, custom_rect, command counts, content_version unchanged or bumped, the canvas transform -- holds on its step's settle transaction of both capture sinks (RC clip false at step 6 is the mirror's clear fix; custom_rect false with 1 command at step 7 and 0 at step 8; no content change at steps 1, 2 and 9 but the marker)",
    problems,
    `${evaluated} invariants hold over ${expected.steps.length} settle transactions x 2 sinks; ids ${ids}`,
    [full.path, patch.path],
  );
}

/** clip-derive.ts over one transaction, as an owner -> value table. */
export function derivedOwnerTable(
  expected: Gate3Expected,
  tx: RecordingSummary["transactions"][number]["meta"],
  names: NameMap,
  cullMask?: number,
): Record<string, ClipRectValue | "unknown"> {
  const derived: Map<number, DerivedEntry> = deriveClipRects(
    tx,
    expected.viewport,
    { cullMask },
  );
  const out: Record<string, ClipRectValue | "unknown"> = {};
  for (const owner of expected.owners) {
    const id = names.byName.get(owner);
    out[owner] =
      id === undefined ? null : (ownerClip(derived, id) as ClipRect | null);
  }
  return out;
}

export function checkClipRectsDerived(
  expected: Gate3Expected,
  full: RecordingSummary,
  patch: RecordingSummary,
): {
  check: Gate3Check;
  table: Record<string, Record<string, ClipRectValue | "unknown">>;
} {
  const problems: string[] = [];
  const table: Record<string, Record<string, ClipRectValue | "unknown">> = {};
  for (const [sink, rec] of [
    ["full", full],
    ["patch", patch],
  ] as const) {
    const states = statesOf(rec);
    const names = mapNames3(expected, states);
    problems.push(...names.problems.map((p) => `${sink}: ${p}`));
    const mask = Number(rec.session?.viewport?.canvas_cull_mask ?? 0xffffffff);
    for (const step of expected.steps) {
      const frame = stepFrames3(expected, step.step).settle;
      const tx = rec.transactions.find((t) => t.meta.frame === frame);
      if (!tx) {
        problems.push(`${sink} step ${step.step}: no settle transaction`);
        continue;
      }
      const got = derivedOwnerTable(expected, tx.meta, names, mask);
      if (sink === "full") table[step.step] = got;
      for (const owner of expected.owners)
        if (
          JSON.stringify(got[owner]) !== JSON.stringify(step.clip_rects[owner])
        )
          problems.push(
            `${sink} step ${step.step}: ${owner} derives ${formatClip(got[owner] as ClipRectValue)}, expected ${formatClip(step.clip_rects[owner])}`,
          );
    }
  }
  return {
    check: check(
      "clip-rects-derived",
      "deriveClipRects (lib/clip-derive.ts: transforms from the canvas down, custom rect or command bounds, bounding box, intersection with the rounded ancestor scissor, the 0.5 px skip, position and size rounded half away from zero) over each settle transaction of both sinks equals expected.json clip_rects for every owner and step",
      problems,
      `${expected.steps.length} steps x ${expected.owners.length} owners x 2 sinks derive exactly`,
      [full.path, patch.path],
    ),
    table,
  };
}

// ---------------------------------------------------------------------------------------------
// The RS call census at the hook (counters.json)
// ---------------------------------------------------------------------------------------------

interface CapturedClipEntry {
  item?: string;
  clip?: boolean;
  custom_rect?: boolean;
  calls?: number;
  first_frame?: number;
  last_frame?: number;
}

interface ClipCounters {
  counts?: Record<string, number | null>;
  captured?: Record<string, CapturedClipEntry[] | unknown>;
  captured_dropped?: Record<string, number>;
}

export interface ClipCensus {
  canvas_item_set_clip: { false: number; true: number };
  canvas_item_set_custom_rect: { false: number; true: number };
  canvas_item_clear: number;
  distinct_entries: {
    canvas_item_set_clip: number;
    canvas_item_set_custom_rect: number;
  };
}

export function clipCensusOf(counters: ClipCounters): ClipCensus {
  const entries = (op: string): CapturedClipEntry[] => {
    const v = counters.captured?.[op];
    return Array.isArray(v) ? (v as CapturedClipEntry[]) : [];
  };
  const byFlag = (op: string, key: "clip" | "custom_rect") => {
    const out = { false: 0, true: 0 };
    for (const e of entries(op)) out[e[key] ? "true" : "false"] += e.calls ?? 0;
    return out;
  };
  return {
    canvas_item_set_clip: byFlag("canvas_item_set_clip", "clip"),
    canvas_item_set_custom_rect: byFlag(
      "canvas_item_set_custom_rect",
      "custom_rect",
    ),
    canvas_item_clear: Number(counters.counts?.canvas_item_clear ?? -1),
    distinct_entries: {
      canvas_item_set_clip: entries("canvas_item_set_clip").length,
      canvas_item_set_custom_rect: entries("canvas_item_set_custom_rect")
        .length,
    },
  };
}

export async function checkClipCallCensus(
  outDir: string,
  expected: Gate3Expected,
): Promise<{ check: Gate3Check; census: ClipCensus | null }> {
  const path = join(outDir, "capture", "evidence", "counters.json");
  const counters = await readJson<ClipCounters>(path);
  const problems: string[] = [];
  if (!counters) {
    problems.push("counters.json missing or unparseable");
    return {
      check: check("clip-call-census", "", problems, "", [path]),
      census: null,
    };
  }
  const got = clipCensusOf(counters);
  const want = expected.census_totals;
  for (const op of [
    "canvas_item_set_clip",
    "canvas_item_set_custom_rect",
  ] as const) {
    if (JSON.stringify(got[op]) !== JSON.stringify(want[op]))
      problems.push(
        `${op} calls by value ${JSON.stringify(got[op])}, expected ${JSON.stringify(want[op])}`,
      );
    const total = got[op].false + got[op].true;
    if (counters.counts?.[op] !== total)
      problems.push(
        `counts.${op} ${counters.counts?.[op]} != the captured entries' ${total} calls`,
      );
  }
  if (got.canvas_item_clear !== want.canvas_item_clear)
    problems.push(
      `counts.canvas_item_clear ${got.canvas_item_clear}, expected ${want.canvas_item_clear}`,
    );
  for (const op of [
    "canvas_item_set_clip",
    "canvas_item_set_custom_rect",
    "canvas_item_clear",
  ])
    if (counters.captured_dropped?.[op] !== 0)
      problems.push(
        `captured_dropped.${op} = ${JSON.stringify(counters.captured_dropped?.[op])}, expected 0`,
      );
  return {
    check: check(
      "clip-call-census",
      "at the hook (capture counters.json), canvas_item_set_clip calls by value, canvas_item_set_custom_rect calls by enabled and canvas_item_clear calls over the whole run equal expected.json census_totals (every Control redraw re-sends clear, custom rect and clip, Q1a), with nothing dropped from the captured tables",
      problems,
      `set_clip ${JSON.stringify(got.canvas_item_set_clip)} (${got.distinct_entries.canvas_item_set_clip} distinct), set_custom_rect ${JSON.stringify(got.canvas_item_set_custom_rect)} (${got.distinct_entries.canvas_item_set_custom_rect} distinct), clear ${got.canvas_item_clear}`,
      [path],
    ),
    census: got,
  };
}

// ---------------------------------------------------------------------------------------------
// The capture leg's class
// ---------------------------------------------------------------------------------------------

export interface Gate3CaptureEvaluation {
  expected_class: Gate3Class;
  result_class: Gate3Class;
  reasons: string[];
  harmless_ties: string[];
  exit_code: number | null;
  artifacts: string[];
  full: RecordingSummary;
  patch: RecordingSummary;
  captureResult: CaptureResultJson | undefined;
}

export async function evaluateCapture(
  outDir: string,
): Promise<Gate3CaptureEvaluation> {
  const dir = join(outDir, "capture");
  const captureResult = await readJson<CaptureResultJson>(
    join(dir, "evidence", "result.json"),
  );
  const full = await loadRecording(join(dir, RECORDING_NAME));
  const patch = await loadRecording(join(dir, PATCH_RECORDING_NAME));
  const base = classifyLeg({ captureResult, recording: full, checkpoints: [] });
  const c = classifyGate1(base, full.session, patchDivergence(full, patch));
  const artifacts: string[] = [];
  for (const p of [
    "argv.txt",
    "env.txt",
    "stdout.log",
    "exit-code.txt",
    "evidence/result.json",
    "evidence/counters.json",
    "evidence/root.json",
    RECORDING_NAME,
    PATCH_RECORDING_NAME,
    "steps.jsonl",
    "strace.txt",
  ])
    if (await fileExists(join(dir, p))) artifacts.push(join(dir, p));
  return {
    expected_class: "success",
    result_class: c.result_class as Gate3Class,
    reasons: c.reasons,
    harmless_ties: c.harmless_ties,
    exit_code: await readExitCode(dir),
    artifacts,
    full,
    patch,
    captureResult,
  };
}

/** The ops a recording carries as unsupported (commands and entries other than harmless ties). */
export function unsupportedOps(recording: RecordingSummary): string[] {
  const ops = new Set<string>();
  for (const t of recording.transactions) {
    for (const u of t.meta.unsupported)
      if (u.reason !== "draw-index-tie") ops.add(u.op);
    for (const item of t.meta.items)
      for (const c of item.commands)
        if (c.op === "unsupported") ops.add(c.name ?? "?");
  }
  return [...ops].sort();
}

export function checkCaptureLegClass(e: Gate3CaptureEvaluation): Gate3Check {
  const problems: string[] = [];
  if (e.result_class !== e.expected_class)
    problems.push(
      `class ${e.result_class}, expected ${e.expected_class}: ${e.reasons.slice(0, 2).join(" | ")}`,
    );
  const ops = unsupportedOps(e.full);
  if (ops.length > 0)
    problems.push(`the recording carries unsupported ${ops.join(",")}`);
  return check(
    "leg-class-capture",
    "the capture leg classifies as success: armed, stream closed, both sinks valid and equivalent, host size match under enforce-min-size, no capture failure, no unsupported entry or command",
    problems,
    `${e.result_class}${e.harmless_ties.length > 0 ? ` (${e.harmless_ties.length} harmless tie entries)` : ""}`,
    e.artifacts,
  );
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export interface Gate3Report {
  schema: "render-stream-gate3-report/1";
  generated_at: string;
  binary: { path: string | null; sha256: string | null };
  gate_passed: boolean;
  groups: { run: string[]; landed: string[]; not_run: string[] };
  legs: Record<
    string,
    {
      group: string;
      expected_class: Gate3Class | null;
      result_class: Gate3Class | null;
      reasons: string[];
      harmless_ties?: string[];
      exit_code: number | null;
      artifacts: string[];
    }
  >;
  checks: Gate3Check[];
  checkpoints: Gate3Checkpoint[];
  /** per leg, per step: the probe count, decisive pairs and the probes that failed, by name */
  probes: Record<string, Record<string, ProbeTally>> | null;
  /** per fixture, per step: clip-derive.ts's owner table over the capture's full sink */
  clip_rects: Record<
    string,
    Record<string, Record<string, ClipRectValue | "unknown">>
  > | null;
  census: ClipCensus | null;
  ties: DrawIndexTie[] | null;
}

export interface Gate3Context {
  expected: Gate3Expected;
  now?: Date;
}

export async function readGroups(
  outDir: string,
): Promise<{ run: string[]; landed: string[] }> {
  const legs = await readJson<{ groups_run?: string[] }>(
    join(outDir, "legs.json"),
  );
  return { run: legs?.groups_run ?? [], landed: [...LANDED_GROUPS] };
}

function notRunCheck(group: string, detail: string): Gate3Check {
  return {
    id: `group-${group}`,
    criterion: `leg group ${group} ran`,
    passed: false,
    status: "not-run",
    detail,
    evidence: [],
  };
}

async function supportLeg(
  outDir: string,
  leg: (typeof G3A_SUPPORT_LEGS)[number],
) {
  const dir =
    leg === "import" ? join(outDir, "import", "fixture") : join(outDir, leg);
  const artifacts: string[] = [];
  for (const p of [
    "argv.txt",
    "env.txt",
    "stdout.log",
    "exit-code.txt",
    "steps.jsonl",
    "evidence/result.json",
    "evidence/counters.json",
    RECORDING_NAME,
  ])
    if (await fileExists(join(dir, p))) artifacts.push(join(dir, p));
  return {
    group: "g3a",
    expected_class: null,
    result_class: null,
    reasons: [] as string[],
    exit_code: await readExitCode(dir),
    artifacts,
  };
}

/** The import and rendered legs exit 0 (their absence fails the checks that read them). */
async function checkSupportLegsExit(outDir: string): Promise<Gate3Check> {
  const problems: string[] = [];
  for (const leg of G3A_SUPPORT_LEGS) {
    const dir =
      leg === "import" ? join(outDir, "import", "fixture") : join(outDir, leg);
    const code = await readExitCode(dir);
    if (code !== 0) problems.push(`${leg} exit ${code ?? "<none>"}`);
  }
  return check(
    "support-legs-exit",
    "the import, reference, reference-repeat and reference-armed legs exited 0",
    problems,
    `${G3A_SUPPORT_LEGS.length} support legs exited 0`,
    G3A_SUPPORT_LEGS.map((l) =>
      join(outDir, l === "import" ? "import/fixture" : l, "exit-code.txt"),
    ),
  );
}

export async function runGate3(
  outDir: string,
  ctx: Gate3Context,
): Promise<Gate3Report> {
  const groups = await readGroups(outDir);
  const notRun = groups.landed.filter((g) => !groups.run.includes(g));
  const checks: Gate3Check[] = [checkExpectedSelfConsistent(ctx.expected)];
  const legs: Gate3Report["legs"] = {};
  let checkpoints: Gate3Checkpoint[] = [];
  let probes: Gate3Report["probes"] = null;
  let clipRects: Gate3Report["clip_rects"] = null;
  let census: ClipCensus | null = null;
  let ties: DrawIndexTie[] | null = null;

  if (groups.run.includes("g3a")) {
    const capture = await evaluateCapture(outDir);
    const image = await checkExpectedImageReference(outDir, ctx.expected);
    checkpoints = image.checkpoints;
    const probeCheck = await checkProbesReference(outDir, ctx.expected);
    probes = { reference: probeCheck.tally };
    const derived = checkClipRectsDerived(
      ctx.expected,
      capture.full,
      capture.patch,
    );
    clipRects = { [ctx.expected.fixture]: derived.table };
    const censusCheck = await checkClipCallCensus(outDir, ctx.expected);
    census = censusCheck.census;
    const tieCheck = checkNoDrawIndexTies(capture.full);
    ties = tieCheck.ties;
    checks.push(
      fromGate0(
        await checkCaptureArmed(outDir, {
          captureResult: capture.captureResult,
          recording: capture.full,
        }),
      ),
      fromGate0(await checkHeadlessNoGpuGate0(outDir)),
      checkRecordingsDecode(capture.full, capture.patch),
      checkPatchResolvesToFull(capture.full, capture.patch),
      await checkStepAlignment(outDir, ctx.expected, capture.full),
      tieCheck.check,
      image.check,
      probeCheck.check,
      await checkReferenceRepeatBudget(outDir, ctx.expected),
      await checkArmedTransparent(outDir, ctx.expected),
      checkClipStateInvariants(ctx.expected, capture.full, capture.patch),
      derived.check,
      censusCheck.check,
      await checkSupportLegsExit(outDir),
      checkCaptureLegClass(capture),
    );
    legs.capture = {
      group: "g3a",
      expected_class: capture.expected_class,
      result_class: capture.result_class,
      reasons: capture.reasons,
      harmless_ties: capture.harmless_ties,
      exit_code: capture.exit_code,
      artifacts: capture.artifacts,
    };
    for (const leg of G3A_SUPPORT_LEGS)
      legs[leg] = await supportLeg(outDir, leg);
  } else {
    checks.push(
      notRunCheck("g3a", "g3a was not in --legs; its checks are not-run"),
    );
  }
  for (const group of notRun)
    if (group !== "g3a")
      checks.push(notRunCheck(group, `${group} was not in --legs`));

  const binary = await readJson<{ path?: string; sha256?: string }>(
    join(outDir, "binary.json"),
  );
  return {
    schema: "render-stream-gate3-report/1",
    generated_at: (ctx.now ?? new Date()).toISOString(),
    binary: { path: binary?.path ?? null, sha256: binary?.sha256 ?? null },
    gate_passed:
      checks.length > 1 &&
      checks.every((c) => c.status === "pass") &&
      notRun.length === 0,
    groups: { run: groups.run, landed: groups.landed, not_run: notRun },
    legs,
    checks,
    checkpoints,
    probes,
    clip_rects: clipRects,
    census,
    ties,
  };
}
