// Gate 3c checks: the rotated/scaled fixture fixtures/gate3-xform (protocol/gate3-design.md "Q6d"
// and "G3c"). Everything here reads an evidence directory written by run-gate3.sh, or is pure
// over values already read from one, so scripts/test/self-test-gate3.ts can drive it.
//
// The engine's clip model is checked against three plausible alternatives (`semantic-probes`).
// Every image comparison is exact outside the `band` (pixels whose centre lies within 1 px of a
// rotated draw edge inside its scissor; lib/gate3x-expected.ts). Inside the band, reference and
// receiver are compared under the budget that reference-xform vs reference-xform-repeat measures
// (`band-budget`, D8).
//
// Evidence layout under <out>/ (scripts/README.md "Gate 3"):
//   import-xform/{fixture,receiver}/       editor --import of fixtures/gate3-xform and the receiver
//   capture-xform/                         headless capture, both sinks, enforce-min-size, quit 52
//   reference-xform{,-repeat,-armed}/      rendered fixture: shots/step-<k>.png, steps.jsonl
//   receiver-xform{,-patch}/               rendered receiver on capture-xform's full / patch sink
//   sabotage-xform-perturb/{capture,receiver}/
//   sabotage-xform-receiver-ignore-clip/   rendered receiver, RS_RECEIVER_SABOTAGE=ignore-clip

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  decodePngRgba,
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type AppliedJson,
  type CaptureResultJson,
  type Checkpoint,
  classifyLeg,
  firstTransactionWithRectColor,
  joinSettleSeqs,
  loadRecording,
  PATCH_RECORDING_NAME,
  parseStepLog,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
  type StepJoin,
  type StepLine,
} from "./gate0-checks";
import { classifyGate1, patchDivergence, statesOf } from "./gate1-checks";
import type { Gate2Class } from "./gate2-checks";
import {
  check,
  derivedOwnerTable,
  evaluateClipInvariants,
  type Gate3Check,
  type Gate3Checkpoint,
  mapNames3,
  type ProbeTally,
  unsupportedOps,
} from "./gate3-checks";
import {
  type ClipRectValue,
  clipValueEqual,
  formatClip,
  type Gate3Expected,
  pixelAt,
  type Rgba8,
  stepFrames3,
} from "./gate3-expected";
import {
  CLIP_MODELS,
  drawBounds,
  type Gate3xExpected,
  type SynthesizedFrameX,
  synthesizeGate3x,
} from "./gate3x-expected";

export const G3C_SUPPORT_LEGS = [
  "import-xform",
  "reference-xform",
  "reference-xform-repeat",
  "reference-xform-armed",
] as const;

export const G3C_CLASSIFIED_LEGS = [
  "capture-xform",
  "receiver-xform",
  "receiver-xform-patch",
  "sabotage-xform-perturb",
  "sabotage-xform-receiver-ignore-clip",
] as const;
export type G3cLeg = (typeof G3C_CLASSIFIED_LEGS)[number];

/** The contract's step sets (gate3-design.md "G3c" legs); make_expected.py's predictions must
 * say the same (expected-self-consistent-xform). */
export const G3C_EXPECTATIONS: Record<
  G3cLeg,
  { class: Gate2Class; steps?: number[] }
> = {
  "capture-xform": { class: "success" },
  "receiver-xform": { class: "success" },
  "receiver-xform-patch": { class: "success" },
  "sabotage-xform-perturb": { class: "pixel-mismatch", steps: [1, 2, 3, 4] },
  "sabotage-xform-receiver-ignore-clip": {
    class: "pixel-mismatch",
    steps: [0, 1, 2, 3, 4],
  },
};

const LEVELS = new Set([0, 51, 102, 153, 204, 255]);
const asGate3 = (e: Gate3xExpected): Gate3Expected =>
  e as unknown as Gate3Expected;

export interface G3cLayout {
  captureDir: string;
  receiverDir?: string;
  recordingName: string;
}

export function g3cLayout(outDir: string, leg: G3cLeg): G3cLayout {
  const capture = join(outDir, "capture-xform");
  switch (leg) {
    case "capture-xform":
      return { captureDir: capture, recordingName: RECORDING_NAME };
    case "receiver-xform":
      return {
        captureDir: capture,
        receiverDir: join(outDir, leg),
        recordingName: RECORDING_NAME,
      };
    case "receiver-xform-patch":
      return {
        captureDir: capture,
        receiverDir: join(outDir, leg),
        recordingName: PATCH_RECORDING_NAME,
      };
    case "sabotage-xform-perturb":
      return {
        captureDir: join(outDir, leg, "capture"),
        receiverDir: join(outDir, leg, "receiver"),
        recordingName: RECORDING_NAME,
      };
    case "sabotage-xform-receiver-ignore-clip":
      return {
        captureDir: capture,
        receiverDir: join(outDir, leg),
        recordingName: RECORDING_NAME,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Band-aware comparison
// ---------------------------------------------------------------------------------------------

export interface BandBudget {
  /** band pixels that may differ */
  pixels: number;
  max_channel_delta: number;
}

export interface BandDiff {
  outside: { mismatched_pixels: number; max_channel_delta: number };
  band: { mismatched_pixels: number; max_channel_delta: number };
}

/** a vs b, split into pixels outside the band and inside it, optionally inside [x, y, w, h]. */
export function bandDiff(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  band: Uint8Array,
  rect?: readonly number[],
): BandDiff {
  const [x0, y0, w, h] = rect ?? [0, 0, width, height];
  const out = {
    outside: { mismatched_pixels: 0, max_channel_delta: 0 },
    band: { mismatched_pixels: 0, max_channel_delta: 0 },
  };
  for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * 4;
      let delta = 0;
      for (let c = 0; c < 4; c++)
        delta = Math.max(delta, Math.abs(a[i + c] - b[i + c]));
      if (delta === 0) continue;
      const side = band[y * width + x] ? out.band : out.outside;
      side.mismatched_pixels++;
      side.max_channel_delta = Math.max(side.max_channel_delta, delta);
    }
  return out;
}

/** Mismatching pixels under a budget: every pixel outside the band, plus every band pixel when
 * the band's differences exceed the budget (count or delta). */
export function overBudget(
  d: BandDiff,
  budget: BandBudget,
): { mismatched_pixels: number; max_channel_delta: number } {
  const bandOver =
    d.band.mismatched_pixels > budget.pixels ||
    d.band.max_channel_delta > budget.max_channel_delta;
  return {
    mismatched_pixels:
      d.outside.mismatched_pixels + (bandOver ? d.band.mismatched_pixels : 0),
    max_channel_delta: Math.max(
      d.outside.max_channel_delta,
      bandOver ? d.band.max_channel_delta : 0,
    ),
  };
}

const synthCache = new WeakMap<
  Gate3xExpected,
  Map<number, SynthesizedFrameX>
>();
function synth(expected: Gate3xExpected, step: number): SynthesizedFrameX {
  let m = synthCache.get(expected);
  if (!m) {
    m = new Map();
    synthCache.set(expected, m);
  }
  let f = m.get(step);
  if (!f) {
    f = synthesizeGate3x(expected, step);
    m.set(step, f);
  }
  return f;
}

// ---------------------------------------------------------------------------------------------
// expected.json
// ---------------------------------------------------------------------------------------------

const sameNums = (a: readonly number[] | undefined, b: readonly number[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/** gate3-xform's expected.json obeys its own rules (Q6a colour rule, Q6c probe rule, Q6d). */
export function checkExpectedSelfConsistentX(
  expected: Gate3xExpected,
): Gate3Check {
  const problems: string[] = [];
  if (expected.schema !== "render-stream-gate3-expected/1")
    problems.push(`schema=${JSON.stringify(expected.schema)}`);
  if (expected.fixture !== "gate3-xform")
    problems.push(`fixture=${JSON.stringify(expected.fixture)}`);
  if (!sameNums(expected.viewport, [640, 360]))
    problems.push(`viewport=${JSON.stringify(expected.viewport)}`);
  const S = expected.start_frame_default;
  const N = expected.step_frames_default;
  const last = expected.last_step;
  if (last !== 4) problems.push(`last_step ${last}, expected 4`);
  if (expected.quit_frame_default !== S + N * last + 11)
    problems.push(`quit_frame_default ${expected.quit_frame_default}`);
  const steps = expected.steps ?? [];
  if (
    steps.map((s) => s.step).join(",") !== [...Array(last + 1).keys()].join(",")
  )
    problems.push(`steps are ${steps.map((s) => s.step).join(",")}`);
  const names = new Set(expected.creation_order);
  const regions = Object.values(expected.regions ?? {});
  const empty = expected.empty_region;
  const markers = new Set<string>();
  const others = new Set<string>();
  const colourOf = new Map<string, string>([
    ["clear", expected.clear_rgba8.join(",")],
  ]);
  for (const step of steps) {
    const frame = synthesizeGate3x(expected, step.step);
    const unclipped = synthesizeGate3x(expected, step.step, { clips: false });
    if (frame.bandPixels !== step.band_pixels)
      problems.push(
        `step ${step.step}: synthesizeGate3x's band has ${frame.bandPixels} pixels, expected.json says ${step.band_pixels}`,
      );
    for (const d of step.draws) {
      if (!names.has(d.name))
        problems.push(`step ${step.step}: unknown draw ${d.name}`);
      if (!d.rgba8.every((v) => LEVELS.has(v)) || d.rgba8[3] !== 255)
        problems.push(
          `step ${step.step}: ${d.name} rgba8 ${d.rgba8.join(",")} breaks the colour rule`,
        );
      if (!d.rect_px === !d.quad)
        problems.push(
          `step ${step.step}: ${d.name} needs exactly one of rect_px and quad`,
        );
      (d.name === "Marker" ? markers : others).add(d.rgba8.join(","));
      if (d.name !== "Marker") colourOf.set(d.name, d.rgba8.join(","));
      if (d.clip_px && !d.clip_px.every((v) => Number.isInteger(v)))
        problems.push(`step ${step.step}: ${d.name} has a fractional scissor`);
      // The painted extent: bounds inside the scissor and the viewport.
      const [bx, by, bw, bh] = drawBounds(d);
      const c = d.clip_px ?? [0, 0, 640, 360];
      const vis = [
        Math.max(bx, c[0], 0),
        Math.max(by, c[1], 0),
        Math.min(bx + bw, c[2], 640),
        Math.min(by + bh, c[3], 360),
      ];
      if (vis[2] <= vis[0] || vis[3] <= vis[1]) continue;
      if (
        !regions.some(
          (r) =>
            vis[0] >= r[0] &&
            vis[1] >= r[1] &&
            vis[2] <= r[0] + r[2] &&
            vis[3] <= r[1] + r[3],
        )
      )
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
    }
    const m = step.draws.filter((d) => d.name === "Marker");
    if (m.length !== 1 || m[0].rgba8.join(",") !== step.marker_rgba8.join(","))
      problems.push(
        `step ${step.step}: the Marker draw does not carry marker_rgba8`,
      );
    const hand = expected.hand_clip_rects?.[String(step.step)];
    for (const owner of expected.owners)
      if (!hand || !clipValueEqual(hand[owner], step.clip_rects?.[owner]))
        problems.push(
          `step ${step.step}: ${owner} derived ${formatClip(step.clip_rects?.[owner])}, hand table ${formatClip(hand?.[owner])}`,
        );
    // Probe pairs: 1 px apart across the owner's edge, outside the band, colours synthesized.
    const byPair = new Map<string, typeof step.probes>();
    for (const p of step.probes) {
      const k = /^(.+)\.(left|right|top|bottom)\.(inside|outside)\.(\d+)$/.exec(
        p.name,
      );
      if (!k || k[1] !== p.owner || k[2] !== p.edge || k[3] !== p.side)
        problems.push(`step ${step.step}: probe name ${p.name} is malformed`);
      const key = `${p.owner}.${p.edge}.${k?.[4] ?? "?"}`;
      byPair.set(key, [...(byPair.get(key) ?? []), p]);
      if (frame.band[p.xy[1] * 640 + p.xy[0]])
        problems.push(`step ${step.step}: probe ${p.name} lies in the band`);
      if (pixelAt(frame, p.xy[0], p.xy[1]).join(",") !== p.rgba8.join(","))
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
    for (const [key, pair] of byPair) {
      const i = pair.find((p) => p.side === "inside");
      const o = pair.find((p) => p.side === "outside");
      if (pair.length !== 2 || !i || !o) {
        problems.push(`step ${step.step}: probe pair ${key} is incomplete`);
        continue;
      }
      const want = {
        left: [-1, 0],
        right: [1, 0],
        top: [0, -1],
        bottom: [0, 1],
      }[i.edge];
      if (o.xy[0] - i.xy[0] !== want[0] || o.xy[1] - i.xy[1] !== want[1])
        problems.push(
          `step ${step.step}: probe pair ${key} is not 1 px apart across its ${i.edge} edge`,
        );
      const r = step.clip_rects?.[i.owner];
      const onEdge =
        Array.isArray(r) &&
        ((i.edge === "left" && i.xy[0] === r[0]) ||
          (i.edge === "right" && i.xy[0] === r[2] - 1) ||
          (i.edge === "top" && i.xy[1] === r[1]) ||
          (i.edge === "bottom" && i.xy[1] === r[3] - 1));
      if (!onEdge)
        problems.push(
          `step ${step.step}: probe pair ${key}'s inside pixel is not on ${i.owner}'s ${i.edge} edge`,
        );
      const decisive = o.unclipped_rgba8.join(",") !== o.rgba8.join(",");
      if (i.decisive !== decisive || o.decisive !== decisive)
        problems.push(
          `step ${step.step}: probe pair ${key} decisive flag is not (outside unclipped != outside)`,
        );
    }
  }
  // Decisive coverage (Q6c).
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
          `${key} is decisive at ${covered.size} step(s) and not listed`,
        );
      if (covered.size >= 2 && listed.has(key))
        problems.push(`${key} is listed non-decisive but is decisive`);
    }
  if (markers.size !== steps.length)
    problems.push(
      `${markers.size} distinct marker colours for ${steps.length} steps`,
    );
  for (const c of markers)
    if (others.has(c))
      problems.push(`marker colour ${c} is also drawn by another add_rect`);
  // Semantic probes (D7): the engine column is the synthesized pixel; the derivation equals the
  // contract's hand table; each alternative differs from the engine somewhere.
  const sem = expected.semantic_probes ?? [];
  if (sem.length !== 6)
    problems.push(`${sem.length} semantic probes, expected 6`);
  for (const p of sem) {
    const frame = synth(expected, p.step);
    if (frame.band[p.xy[1] * 640 + p.xy[0]])
      problems.push(`semantic probe ${p.name} lies in the band`);
    if (
      pixelAt(frame, p.xy[0], p.xy[1]).join(",") !== p.models.engine?.join(",")
    )
      problems.push(
        `semantic probe ${p.name}: the engine model is not the synthesized pixel`,
      );
    for (const m of CLIP_MODELS)
      if (colourOf.get(p.hand?.[m]) !== p.models[m]?.join(","))
        problems.push(
          `semantic probe ${p.name}: ${m} derives ${p.models[m]?.join(",")}, the hand table says ${p.hand?.[m]}`,
        );
  }
  for (const m of CLIP_MODELS.slice(1))
    if (!sem.some((p) => p.models[m]?.join(",") !== p.models.engine?.join(",")))
      problems.push(`${m} agrees with the engine at every semantic probe`);
  for (const leg of [
    "sabotage-xform-perturb",
    "sabotage-xform-receiver-ignore-clip",
  ] as const)
    if (
      !sameNums(
        expected.predictions?.[leg]?.steps,
        G3C_EXPECTATIONS[leg].steps ?? [],
      )
    )
      problems.push(
        `predictions.${leg}.steps ${JSON.stringify(expected.predictions?.[leg]?.steps)} != the contract's ${JSON.stringify(G3C_EXPECTATIONS[leg].steps)}`,
      );
  const probes = steps.reduce((n, s) => n + s.probes.length, 0);
  return check(
    "expected-self-consistent-xform",
    "fixtures/gate3-xform/expected.json obeys its rules: 640x360, steps 0..4, the colour rule, every painted extent inside a region and none in the empty region, one marker colour per step; the derived scissors equal gate3-design.md Q6d's hand table; every probe pair 1 px apart across its owner's edge, outside the band, with colours equal to the synthesized and unclipped frames; decisive coverage; the band size equal to synthesizeGate3x's; the six semantic probes' derived colours equal Q6d's hand table, each alternative model differing from the engine at one probe or more; the sabotage step sets equal the contract's",
    problems,
    `${steps.length} steps, ${probes} probes, bands ${steps.map((s) => s.band_pixels).join("/")} px, ${sem.length} semantic probes, hand tables match`,
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// Reference legs
// ---------------------------------------------------------------------------------------------

const shotOf = (outDir: string, leg: string, step: number) =>
  join(outDir, leg, "shots", `step-${step}.png`);

export async function checkStepAlignmentX(
  outDir: string,
  expected: Gate3xExpected,
  recording: RecordingSummary,
): Promise<Gate3Check> {
  const want: StepLine[] = expected.steps.map((s) => {
    const f = stepFrames3(expected, s.step);
    return { step: s.step, applied_frame: f.applied, settle_frame: f.settle };
  });
  const problems: string[] = [];
  const paths: string[] = [];
  for (const leg of [
    "capture-xform",
    "reference-xform",
    "reference-xform-repeat",
    "reference-xform-armed",
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
    firsts.push(`${s.step}@${t?.meta.frame ?? "none"}`);
    if (t?.meta.frame !== stepFrames3(expected, s.step).applied)
      problems.push(
        `step ${s.step}: marker colour first published at frame ${t?.meta.frame ?? "<none>"}`,
      );
  }
  return check(
    "step-alignment-xform",
    "capture-xform and every reference-xform steps.jsonl list steps 0..4 at S+N*k (settle +7), and each step's marker colour first appears in the capture transaction of its applied frame",
    problems,
    `marker colours first published at ${firsts.join(", ")}`,
    [...paths, recording.path],
  );
}

/** One leg's shots (reference layout) against synthesizeGate3x, exact outside the band. */
export async function compareWithSynthX(
  shots: { step: number; path: string }[],
  leg: string,
  expected: Gate3xExpected,
): Promise<{
  problems: string[];
  checkpoints: Gate3Checkpoint[];
  bandDiffs: number[];
}> {
  const problems: string[] = [];
  const checkpoints: Gate3Checkpoint[] = [];
  const bandDiffs: number[] = [];
  for (const { step, path } of shots) {
    const cp: Gate3Checkpoint = {
      leg,
      step,
      shot: path,
      mismatched_pixels: null,
      max_channel_delta: null,
      regions: [],
    };
    checkpoints.push(cp);
    const got = await decodePngRgba(path);
    const want = synth(expected, step);
    if (!got || got.width !== want.width || got.height !== want.height) {
      problems.push(`step ${step}: ${path} missing, unreadable or mis-sized`);
      continue;
    }
    const d = bandDiff(want.rgba, got.data, want.width, want.height, want.band);
    cp.mismatched_pixels = d.outside.mismatched_pixels;
    cp.max_channel_delta = d.outside.max_channel_delta;
    bandDiffs.push(d.band.mismatched_pixels);
    for (const [name, rect] of Object.entries(expected.regions)) {
      const r = bandDiff(
        want.rgba,
        got.data,
        want.width,
        want.height,
        want.band,
        rect,
      );
      cp.regions.push({ name, ...r.outside });
    }
    if (d.outside.mismatched_pixels > 0)
      problems.push(
        `step ${step}: ${d.outside.mismatched_pixels} pixels outside the band differ from synthesizeGate3x (max delta ${d.outside.max_channel_delta}; regions ${
          cp.regions
            .filter((r) => r.mismatched_pixels > 0)
            .map((r) => `${r.name} ${r.mismatched_pixels}`)
            .join(", ") || "none"
        })`,
      );
  }
  return { problems, checkpoints, bandDiffs };
}

export async function checkExpectedImageReferenceX(
  outDir: string,
  expected: Gate3xExpected,
): Promise<{ check: Gate3Check; checkpoints: Gate3Checkpoint[] }> {
  const shots = expected.steps.map((s) => ({
    step: s.step,
    path: shotOf(outDir, "reference-xform", s.step),
  }));
  const r = await compareWithSynthX(shots, "reference-xform", expected);
  return {
    check: check(
      "expected-image-reference-xform",
      "each reference-xform/shots/step-<k>.png (k = 0..4) equals synthesizeGate3x(k) exactly outside the band (pixel-centre coverage of every quad inside its integer scissor), full frame and every region",
      r.problems,
      `${shots.length} shots exact outside the band; band pixels differing from pixel-centre synthesis: ${r.bandDiffs.join("/")}`,
      shots.map((s) => s.path),
    ),
    checkpoints: r.checkpoints,
  };
}

/** reference-xform vs reference-xform-repeat: identical outside the band; the band's measured
 * differences (count and delta, maximum over steps) become the budget. */
export async function checkBandBudget(
  outDir: string,
  expected: Gate3xExpected,
): Promise<{ check: Gate3Check; budget: BandBudget; perStep: number[] }> {
  const problems: string[] = [];
  const paths: string[] = [];
  const budget: BandBudget = { pixels: 0, max_channel_delta: 0 };
  const perStep: number[] = [];
  for (const s of expected.steps) {
    const a = shotOf(outDir, "reference-xform", s.step);
    const b = shotOf(outDir, "reference-xform-repeat", s.step);
    paths.push(a, b);
    const ia = await decodePngRgba(a);
    const ib = await decodePngRgba(b);
    if (!ia || !ib || ia.width !== ib.width || ia.height !== ib.height) {
      problems.push(`step ${s.step}: a shot is missing or mis-sized`);
      continue;
    }
    const band = synth(expected, s.step).band;
    const d = bandDiff(ia.data, ib.data, ia.width, ia.height, band);
    perStep.push(d.band.mismatched_pixels);
    budget.pixels = Math.max(budget.pixels, d.band.mismatched_pixels);
    budget.max_channel_delta = Math.max(
      budget.max_channel_delta,
      d.band.max_channel_delta,
    );
    if (d.outside.mismatched_pixels > 0)
      problems.push(
        `step ${s.step}: reference and repeat differ in ${d.outside.mismatched_pixels} pixels outside the band`,
      );
  }
  return {
    check: check(
      "band-budget",
      "reference-xform vs reference-xform-repeat (same build, GPU and driver): identical outside the band at every step; the band's measured differing-pixel count and maximum channel delta become the budget receiver-vs-reference-xform applies there (D8, expected 0)",
      problems,
      `budget ${budget.pixels} px, max channel delta ${budget.max_channel_delta} (band sizes ${expected.steps.map((s) => s.band_pixels).join("/")} px; differing per step ${perStep.join("/")})`,
      paths,
    ),
    budget,
    perStep,
  };
}

export async function checkArmedTransparentX(
  outDir: string,
  expected: Gate3xExpected,
): Promise<Gate3Check> {
  const problems: string[] = [];
  const paths: string[] = [];
  const result = await readJson<CaptureResultJson>(
    join(outDir, "reference-xform-armed", "evidence", "result.json"),
  );
  if (result?.status !== "armed")
    problems.push(`result.json status=${JSON.stringify(result?.status)}`);
  if (result?.stream?.status !== "closed")
    problems.push(`stream.status=${JSON.stringify(result?.stream?.status)}`);
  for (const s of expected.steps) {
    const a = await decodePngRgba(shotOf(outDir, "reference-xform", s.step));
    const bPath = shotOf(outDir, "reference-xform-armed", s.step);
    paths.push(bPath);
    const b = await decodePngRgba(bPath);
    if (!a || !b || a.width !== b.width || a.height !== b.height) {
      problems.push(`step ${s.step}: a shot is missing or mis-sized`);
      continue;
    }
    const band = synth(expected, s.step).band;
    const d = bandDiff(a.data, b.data, a.width, a.height, band);
    if (d.outside.mismatched_pixels + d.band.mismatched_pixels > 0)
      problems.push(
        `step ${s.step}: ${d.outside.mismatched_pixels} pixels outside and ${d.band.mismatched_pixels} inside the band differ`,
      );
  }
  return check(
    "armed-transparent-xform",
    "reference-xform-armed (extension armed, stream on) armed with its stream closed, and every shot equals reference-xform's byte for byte, band included",
    problems,
    `${expected.steps.length} armed shots byte-identical to the reference`,
    paths,
  );
}

/** The reference at each D7 probe equals the engine model, and each alternative misses one. */
export async function checkSemanticProbes(
  outDir: string,
  expected: Gate3xExpected,
): Promise<{
  check: Gate3Check;
  table: { name: string; xy: number[]; measured: Rgba8 | null }[];
}> {
  const problems: string[] = [];
  const table: { name: string; xy: number[]; measured: Rgba8 | null }[] = [];
  const paths = new Set<string>();
  const measured = new Map<string, string>();
  for (const p of expected.semantic_probes) {
    const path = shotOf(outDir, "reference-xform", p.step);
    paths.add(path);
    const img = await decodePngRgba(path);
    const px = img
      ? pixelAt({ width: img.width, rgba: img.data }, p.xy[0], p.xy[1])
      : null;
    table.push({ name: p.name, xy: p.xy, measured: px });
    measured.set(p.name, px?.join(",") ?? "<none>");
    if (px?.join(",") !== p.models.engine.join(","))
      problems.push(
        `${p.name} (${p.xy.join(",")}): reference ${px?.join(",") ?? "<none>"}, engine model ${p.models.engine.join(",")}`,
      );
  }
  const refuted: string[] = [];
  for (const m of CLIP_MODELS.slice(1)) {
    const misses = expected.semantic_probes.filter(
      (p) => p.models[m].join(",") !== measured.get(p.name),
    );
    if (misses.length === 0)
      problems.push(`${m} agrees with the reference at every semantic probe`);
    else refuted.push(`${m} at ${misses.map((p) => p.name).join(",")}`);
  }
  return {
    check: check(
      "semantic-probes",
      "at every D7 semantic probe the reference equals the engine model (rounded bounding-box scissor, position and size rounded separately), and each alternative -- rotated-exact, edge-round, pixel-centre -- differs from the reference at one probe or more",
      problems,
      `the reference matches the engine model at ${expected.semantic_probes.length} probes; refuted: ${refuted.join("; ")}`,
      [...paths],
    ),
    table,
  };
}

/** Every probe of every step against a set of shots. */
export async function probeTallyX(
  shots: { step: number; path: string | null }[],
  expected: Gate3xExpected,
): Promise<{ tally: Record<string, ProbeTally>; problems: string[] }> {
  const tally: Record<string, ProbeTally> = {};
  const problems: string[] = [];
  for (const { step, path } of shots) {
    const s = expected.steps.find((x) => x.step === step);
    if (!s) continue;
    const t: ProbeTally = {
      total: s.probes.length,
      decisive: s.probes.filter((p) => p.decisive && p.side === "outside")
        .length,
      failed: [],
    };
    tally[step] = t;
    const img = path ? await decodePngRgba(path) : undefined;
    if (!img) {
      problems.push(`step ${step}: ${path ?? "<no shot>"} missing`);
      t.failed = s.probes.map((p) => p.name);
      continue;
    }
    const frame = { width: img.width, rgba: img.data };
    for (const p of s.probes)
      if (pixelAt(frame, p.xy[0], p.xy[1]).join(",") !== p.rgba8.join(","))
        t.failed.push(p.name);
    if (t.failed.length > 0)
      problems.push(
        `step ${step}: ${t.failed.length} probe(s) differ: ${t.failed.slice(0, 6).join(", ")}${t.failed.length > 6 ? ", ..." : ""}`,
      );
  }
  return { tally, problems };
}

export async function checkProbesReferenceX(
  outDir: string,
  expected: Gate3xExpected,
): Promise<{ check: Gate3Check; tally: Record<string, ProbeTally> }> {
  const shots = expected.steps.map((s) => ({
    step: s.step,
    path: shotOf(outDir, "reference-xform", s.step),
  }));
  const r = await probeTallyX(shots, expected);
  const total = Object.values(r.tally).reduce((n, t) => n + t.total, 0);
  return {
    check: check(
      "probes-reference-xform",
      "every named probe (1 px inside and outside each scissor edge, every step) has exactly its expected colour in the reference-xform shots",
      r.problems,
      `${total} probes exact over ${expected.steps.length} steps`,
      shots.map((s) => s.path),
    ),
    tally: r.tally,
  };
}

// ---------------------------------------------------------------------------------------------
// Capture-side state
// ---------------------------------------------------------------------------------------------

export function checkClipStateInvariantsX(
  expected: Gate3xExpected,
  full: RecordingSummary,
  patch: RecordingSummary,
): Gate3Check {
  const problems: string[] = [];
  let evaluated = 0;
  for (const [sink, rec] of [
    ["full", full],
    ["patch", patch],
  ] as const) {
    const states = statesOf(rec);
    const names = mapNames3(asGate3(expected), states);
    const r = evaluateClipInvariants(asGate3(expected), states, names);
    problems.push(
      ...[...names.problems, ...r.problems].map((p) => `${sink}: ${p}`),
    );
    evaluated += r.evaluated;
  }
  return check(
    "clip-state-invariants-xform",
    "every gate3-xform expected.json invariant -- clip, custom_rect, command counts, content_version unchanged or bumped, the canvas transform -- holds on its settle transaction of both capture-xform sinks: no content change at steps 1, 3 and 4 but the marker, and RQ bumps at step 2 (its scale redraws it) with clip still true",
    problems,
    `${evaluated} invariants hold over ${expected.steps.length} settle transactions x 2 sinks`,
    [full.path, patch.path],
  );
}

export function checkClipRectsDerivedX(
  expected: Gate3xExpected,
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
    const names = mapNames3(asGate3(expected), statesOf(rec));
    problems.push(...names.problems.map((p) => `${sink}: ${p}`));
    const mask = Number(rec.session?.viewport?.canvas_cull_mask ?? 0xffffffff);
    for (const step of expected.steps) {
      const frame = stepFrames3(expected, step.step).settle;
      const tx = rec.transactions.find((t) => t.meta.frame === frame);
      if (!tx) {
        problems.push(`${sink} step ${step.step}: no settle transaction`);
        continue;
      }
      const got = derivedOwnerTable(asGate3(expected), tx.meta, names, mask);
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
      "clip-rects-derived-xform",
      "deriveClipRects over each settle transaction of both capture-xform sinks -- rotation (RQ, RQ2 under OA), half rounding (SQ) and the 0.75 px sliver (SR), and a negative scale (FQ) -- equals expected.json clip_rects for every owner and step",
      problems,
      `${expected.steps.length} steps x ${expected.owners.length} owners x 2 sinks derive exactly`,
      [full.path, patch.path],
    ),
    table,
  };
}

// ---------------------------------------------------------------------------------------------
// Classified legs
// ---------------------------------------------------------------------------------------------

export interface G3cLegEvaluation {
  leg: G3cLeg;
  layout: G3cLayout;
  expected_class: Gate2Class;
  result_class: Gate2Class;
  reasons: string[];
  mismatching_steps: number[];
  harmless_ties: string[];
  exit_code: number | null;
  artifacts: string[];
  full: RecordingSummary;
  patch: RecordingSummary;
  recording: RecordingSummary;
  captureResult: CaptureResultJson | undefined;
  stepJoin?: StepJoin;
  checkpoints: (Checkpoint & {
    leg: string;
    band_mismatched_pixels: number | null;
  })[];
  /** receiver legs: the shot of each step (null when absent) */
  shots: { step: number; path: string | null }[];
}

async function shotSeqs(dir: string): Promise<number[]> {
  try {
    return (await readdir(join(dir, "shots")))
      .map((n) => /^seq-(\d+)\.png$/.exec(n)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);
  } catch {
    return [];
  }
}

/** One leg: gate 0's classifyLeg plus gate 1's patch and root-size rules, with checkpoints
 * against reference-xform that are exact outside the band and within `budget` inside it. */
export async function evaluateLegX(
  outDir: string,
  leg: G3cLeg,
  expected: Gate3xExpected,
  budget: BandBudget,
): Promise<G3cLegEvaluation> {
  const layout = g3cLayout(outDir, leg);
  const captureResult = await readJson<CaptureResultJson>(
    join(layout.captureDir, "evidence", "result.json"),
  );
  const full = await loadRecording(join(layout.captureDir, RECORDING_NAME));
  const patch = await loadRecording(
    join(layout.captureDir, PATCH_RECORDING_NAME),
  );
  const recording = layout.recordingName === RECORDING_NAME ? full : patch;
  let stepJoin: StepJoin | undefined;
  let receiver: Parameters<typeof classifyLeg>[0]["receiver"];
  const checkpoints: G3cLegEvaluation["checkpoints"] = [];
  const shots: G3cLegEvaluation["shots"] = [];
  if (layout.receiverDir) {
    stepJoin = joinSettleSeqs(
      parseStepLog(
        await readTextOrUndefined(join(layout.captureDir, "steps.jsonl")),
      ),
      recording.transactions,
    );
    let applied = await readJson<AppliedJson>(
      join(layout.receiverDir, "applied.json"),
    );
    if (
      applied !== undefined &&
      (applied === null || typeof applied !== "object")
    )
      applied = undefined;
    receiver = {
      applied,
      requestedShotSeqs: stepJoin.entries
        .map((e) => e.seq)
        .filter((s): s is number => s !== null),
      shotFiles: await shotSeqs(layout.receiverDir),
    };
    for (const e of stepJoin.entries) {
      const receiverPng =
        e.seq === null
          ? null
          : join(layout.receiverDir, "shots", `seq-${e.seq}.png`);
      shots.push({ step: e.step, path: receiverPng });
      const referencePng = shotOf(outDir, "reference-xform", e.step);
      const ref = await decodePngRgba(referencePng);
      const got = receiverPng ? await decodePngRgba(receiverPng) : undefined;
      const base = {
        leg,
        step: e.step,
        settle_frame: e.settle_frame,
        seq: e.seq,
        reference_png: referencePng,
        receiver_png: receiverPng,
        diff_png: null,
      };
      if (
        !ref ||
        !got ||
        ref.width !== got.width ||
        ref.height !== got.height ||
        !expected.steps.some((s) => s.step === e.step)
      ) {
        checkpoints.push({
          ...base,
          mismatched_pixels: null,
          max_channel_delta: null,
          band_mismatched_pixels: null,
          regions: Object.entries(expected.regions).map(([name, r]) => ({
            name,
            rect_px: [...r],
            mismatched_pixels: null,
            max_channel_delta: null,
          })),
        });
        continue;
      }
      const band = synth(expected, e.step).band;
      const d = bandDiff(ref.data, got.data, ref.width, ref.height, band);
      checkpoints.push({
        ...base,
        ...overBudget(d, budget),
        band_mismatched_pixels: d.band.mismatched_pixels,
        regions: Object.entries(expected.regions).map(([name, r]) => ({
          name,
          rect_px: [...r],
          ...overBudget(
            bandDiff(ref.data, got.data, ref.width, ref.height, band, r),
            budget,
          ),
        })),
      });
    }
  }
  const base = classifyLeg({
    captureResult,
    recording,
    stepJoin,
    receiver,
    checkpoints,
  });
  const c = classifyGate1(
    base,
    recording.session,
    patchDivergence(full, patch),
  );
  const dirs = [
    layout.captureDir,
    ...(layout.receiverDir ? [layout.receiverDir] : []),
  ];
  const artifacts: string[] = [];
  for (const dir of dirs)
    for (const p of [
      "argv.txt",
      "env.txt",
      "stdout.log",
      "exit-code.txt",
      "evidence/result.json",
      RECORDING_NAME,
      PATCH_RECORDING_NAME,
      "steps.jsonl",
      "applied.json",
    ])
      if (await fileExists(join(dir, p))) artifacts.push(join(dir, p));
  return {
    leg,
    layout,
    expected_class: G3C_EXPECTATIONS[leg].class,
    result_class: c.result_class as Gate2Class,
    reasons: c.reasons,
    mismatching_steps: c.mismatching_steps,
    harmless_ties: c.harmless_ties,
    exit_code: await readExitCode(layout.receiverDir ?? layout.captureDir),
    artifacts: [...new Set(artifacts)],
    full,
    patch,
    recording,
    captureResult,
    stepJoin,
    checkpoints,
    shots,
  };
}

/** The leg's class, and for pixel-mismatch legs its exact step set; ignore-clip's failing probes
 * (outside the unclipped band) must equal make_expected.py's prediction. */
export async function checkLegClassX(
  e: G3cLegEvaluation,
  expected: Gate3xExpected,
): Promise<Gate3Check> {
  const problems: string[] = [];
  const want = G3C_EXPECTATIONS[e.leg];
  if (e.result_class !== want.class)
    problems.push(
      `class ${e.result_class}, expected ${want.class}: ${e.reasons.slice(0, 2).join(" | ")}`,
    );
  if (want.class === "success") {
    const ops = unsupportedOps(e.recording);
    if (ops.length > 0)
      problems.push(`the recording carries unsupported ${ops.join(",")}`);
  }
  if (want.steps && !sameNums(e.mismatching_steps, want.steps))
    problems.push(
      `mismatching steps {${e.mismatching_steps.join(",")}}, expected {${want.steps.join(",")}}`,
    );
  let probeDetail = "";
  if (e.leg === "sabotage-xform-receiver-ignore-clip") {
    const pred = expected.predictions[e.leg] as {
      probes?: string[];
      probes_in_band?: string[];
    };
    const skip = new Set(pred.probes_in_band ?? []);
    const r = await probeTallyX(e.shots, expected);
    const failed = Object.entries(r.tally)
      .flatMap(([step, t]) => t.failed.map((n) => `${step}:${n}`))
      .filter((n) => !skip.has(n))
      .sort();
    const wanted = [...(pred.probes ?? [])].sort();
    const extra = failed.filter((n) => !wanted.includes(n));
    const missing = wanted.filter((n) => !failed.includes(n));
    if (extra.length + missing.length > 0)
      problems.push(
        `failing probes differ from the prediction: ${extra.length} unexpected (${extra.slice(0, 4).join(", ")}), ${missing.length} missing (${missing.slice(0, 4).join(", ")})`,
      );
    probeDetail = `; ${failed.length} failing probes = prediction (${skip.size} in the unclipped band left out)`;
  }
  return check(
    `leg-class-${e.leg}`,
    want.class === "success"
      ? `the ${e.leg} leg classifies as success (no unsupported entry or command; receivers exact outside the band and within the band budget inside it)`
      : `the ${e.leg} leg classifies as ${want.class} at exactly steps {${want.steps?.join(",")}}${e.leg === "sabotage-xform-receiver-ignore-clip" ? ", with exactly the predicted failing probes" : ""}`,
    problems,
    `${e.result_class}${want.steps ? ` at steps {${e.mismatching_steps.join(",")}}` : ""}${probeDetail}`,
    e.artifacts,
  );
}

/** receiver-xform and receiver-xform-patch against the reference: exact outside the band and
 * within the budget inside it, at every step. */
export function checkReceiverVsReferenceX(
  evals: readonly G3cLegEvaluation[],
  budget: BandBudget,
): Gate3Check {
  const problems: string[] = [];
  const bandSeen: string[] = [];
  for (const e of evals) {
    if (e.checkpoints.length !== 5)
      problems.push(
        `${e.leg}: ${e.checkpoints.length} checkpoints, expected 5`,
      );
    for (const c of e.checkpoints) {
      if (c.mismatched_pixels === null)
        problems.push(`${e.leg} step ${c.step}: no comparable shot`);
      else if (c.mismatched_pixels > 0)
        problems.push(
          `${e.leg} step ${c.step}: ${c.mismatched_pixels} pixels over budget (max delta ${c.max_channel_delta}; ${c.regions
            .filter((r) => (r.mismatched_pixels ?? 0) > 0)
            .map((r) => `${r.name} ${r.mismatched_pixels}`)
            .join(", ")})`,
        );
      bandSeen.push(`${c.band_mismatched_pixels ?? "?"}`);
    }
  }
  return check(
    "receiver-vs-reference-xform",
    `receiver-xform and receiver-xform-patch shots equal reference-xform's exactly outside the band and within the band budget (${budget.pixels} px, delta ${budget.max_channel_delta}) inside it, at every step`,
    problems,
    `${evals.length} receivers x 5 steps match; band pixels differing ${bandSeen.join("/")}`,
    evals.flatMap((e) => e.checkpoints.map((c) => c.receiver_png ?? "")),
  );
}

export async function checkExpectedImageReceiverX(
  evals: readonly G3cLegEvaluation[],
  expected: Gate3xExpected,
): Promise<Gate3Check> {
  const problems: string[] = [];
  const paths: string[] = [];
  for (const e of evals) {
    const shots = e.shots.flatMap((s) =>
      s.path ? [{ step: s.step, path: s.path }] : [],
    );
    if (shots.length !== expected.steps.length)
      problems.push(`${e.leg}: ${shots.length} shots`);
    paths.push(...shots.map((s) => s.path));
    const r = await compareWithSynthX(shots, e.leg, expected);
    problems.push(...r.problems.map((p) => `${e.leg} ${p}`));
  }
  return check(
    "expected-image-receiver-xform",
    "each receiver-xform and receiver-xform-patch shot equals synthesizeGate3x exactly outside the band, full frame and every region",
    problems,
    `${paths.length} receiver shots exact outside the band`,
    paths,
  );
}

export async function checkProbesReceiverX(
  evals: readonly G3cLegEvaluation[],
  expected: Gate3xExpected,
): Promise<{
  check: Gate3Check;
  tallies: Record<string, Record<string, ProbeTally>>;
}> {
  const problems: string[] = [];
  const tallies: Record<string, Record<string, ProbeTally>> = {};
  for (const e of evals) {
    const r = await probeTallyX(e.shots, expected);
    tallies[e.leg] = r.tally;
    problems.push(...r.problems.map((p) => `${e.leg} ${p}`));
    if (e.shots.length !== expected.steps.length)
      problems.push(`${e.leg}: ${e.shots.length} shots`);
  }
  return {
    check: check(
      "probes-receiver-xform",
      "every named probe has exactly its expected colour in the receiver-xform and receiver-xform-patch shots",
      problems,
      `${evals.length} receivers: every probe exact`,
      evals.flatMap((e) => e.shots.map((s) => s.path ?? "")),
    ),
    tallies,
  };
}

async function checkSupportLegsExitX(outDir: string): Promise<Gate3Check> {
  const dirs = [
    join(outDir, "import-xform", "fixture"),
    join(outDir, "import-xform", "receiver"),
    ...G3C_SUPPORT_LEGS.slice(1).map((l) => join(outDir, l)),
  ];
  const problems: string[] = [];
  for (const dir of dirs) {
    const code = await readExitCode(dir);
    if (code !== 0)
      problems.push(`${dir.slice(outDir.length + 1)} exit ${code ?? "<none>"}`);
  }
  return check(
    "support-legs-exit-xform",
    "import-xform (fixture and receiver), reference-xform, reference-xform-repeat and reference-xform-armed exited 0",
    problems,
    `${dirs.length} support processes exited 0`,
    dirs.map((d) => join(d, "exit-code.txt")),
  );
}

// ---------------------------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------------------------

export interface G3cResult {
  checks: Gate3Check[];
  legs: Record<
    string,
    {
      group: string;
      expected_class: Gate2Class | null;
      result_class: Gate2Class | null;
      reasons: string[];
      harmless_ties?: string[];
      exit_code: number | null;
      artifacts: string[];
    }
  >;
  checkpoints: Gate3Checkpoint[];
  probes: Record<string, Record<string, ProbeTally>>;
  clip_rects: Record<string, Record<string, ClipRectValue | "unknown">>;
  band: {
    budget: BandBudget;
    band_pixels: number[];
    repeat_band_diffs: number[];
  };
  semantic_probes: { name: string; xy: number[]; measured: Rgba8 | null }[];
}

export async function runG3c(
  outDir: string,
  expected: Gate3xExpected,
): Promise<G3cResult> {
  const checks: Gate3Check[] = [checkExpectedSelfConsistentX(expected)];
  const bb = await checkBandBudget(outDir, expected);
  const evals = new Map<G3cLeg, G3cLegEvaluation>();
  for (const leg of G3C_CLASSIFIED_LEGS)
    evals.set(leg, await evaluateLegX(outDir, leg, expected, bb.budget));
  const capture = evals.get("capture-xform") as G3cLegEvaluation;
  const receivers = [
    evals.get("receiver-xform"),
    evals.get("receiver-xform-patch"),
  ] as G3cLegEvaluation[];
  const image = await checkExpectedImageReferenceX(outDir, expected);
  const probesRef = await checkProbesReferenceX(outDir, expected);
  const probesRecv = await checkProbesReceiverX(receivers, expected);
  const semantic = await checkSemanticProbes(outDir, expected);
  const derived = checkClipRectsDerivedX(expected, capture.full, capture.patch);
  checks.push(
    await checkStepAlignmentX(outDir, expected, capture.full),
    image.check,
    bb.check,
    semantic.check,
    probesRef.check,
    await checkArmedTransparentX(outDir, expected),
    checkClipStateInvariantsX(expected, capture.full, capture.patch),
    derived.check,
    checkReceiverVsReferenceX(receivers, bb.budget),
    await checkExpectedImageReceiverX(receivers, expected),
    probesRecv.check,
    await checkSupportLegsExitX(outDir),
  );
  for (const leg of G3C_CLASSIFIED_LEGS)
    checks.push(
      await checkLegClassX(evals.get(leg) as G3cLegEvaluation, expected),
    );
  const legs: G3cResult["legs"] = {};
  for (const [leg, e] of evals)
    legs[leg] = {
      group: "g3c",
      expected_class: e.expected_class,
      result_class: e.result_class,
      reasons: e.reasons,
      harmless_ties: e.harmless_ties,
      exit_code: e.exit_code,
      artifacts: e.artifacts,
    };
  for (const leg of G3C_SUPPORT_LEGS) {
    const dir =
      leg === "import-xform" ? join(outDir, leg, "fixture") : join(outDir, leg);
    legs[leg] = {
      group: "g3c",
      expected_class: null,
      result_class: null,
      reasons: [],
      exit_code: await readExitCode(dir),
      artifacts: [join(dir, "stdout.log")],
    };
  }
  const receiverCheckpoints: Gate3Checkpoint[] = receivers.flatMap((e) =>
    e.checkpoints.map((c) => ({
      leg: e.leg,
      step: c.step,
      shot: c.receiver_png ?? "",
      mismatched_pixels: c.mismatched_pixels,
      max_channel_delta: c.max_channel_delta,
      regions: c.regions.map((r) => ({
        name: r.name,
        mismatched_pixels: r.mismatched_pixels ?? -1,
        max_channel_delta: r.max_channel_delta ?? -1,
      })),
    })),
  );
  return {
    checks,
    legs,
    checkpoints: [...image.checkpoints, ...receiverCheckpoints],
    probes: { "reference-xform": probesRef.tally, ...probesRecv.tallies },
    clip_rects: derived.table,
    band: {
      budget: bb.budget,
      band_pixels: expected.steps.map((s) => s.band_pixels),
      repeat_band_diffs: bb.perStep,
    },
    semantic_probes: semantic.table,
  };
}
