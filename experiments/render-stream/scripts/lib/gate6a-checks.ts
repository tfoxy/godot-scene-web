// Gate 6a checks (protocol/gate6-design.md "G6a", "Q6", "Q7b"): fixtures/gate6-scene, its scene
// oracle and the file legs on render-stream/5.
//
// Everything here reads an evidence directory written by run-gate6.sh's g6a group, or is pure over
// values already read from one, so scripts/test/self-test-gate6.ts can drive each check with
// synthetic values. Nothing launches a process. Classification never reads `session.sabotage`.
//
// Independent records of the scene meet here, none a replay of another (D7):
//   - make_expected.py's model: the coverage of every decided pixel (gate 5's lowering, gate 5g's
//     StyleBoxFlat port, the shader twin, nearest texels, the mesh formula), text left undecided,
//     the scroll and freshness tables, the resource census with predicted GRT1/GRP1 hashes, and
//     every sabotage's (shot, region) set;
//   - the rendered reference and its repeat, compared with the model per pixel class and with the
//     receivers on every pixel;
//   - the reference's scene oracle (scene_oracle.gd): atlas page hashes, scroll offsets, canvas
//     layers, material parameters, the RichTextLabel's line offsets and the LineEdit's selection
//     and caret rects, read back from the rendered engine;
//   - the capture: its classification, its hook log against the census, its wire against the
//     oracle (atlas, scroll, parameters, LineEdit rects).
//
// Before G6b the wire is render-stream/5, whose only answer to the HUD's CanvasLayer is the
// session-level `extra-canvas` (Q7b): every leg classifies `unsupported` with exactly that reason
// (the refused variant: exactly its reasons), and every pixel comparison with a receiver excludes
// HU (and RF in `refused`). The pixel verdict each leg must reach (success, or pixel-mismatch at
// exactly the predicted shots and regions) is judged on the remaining pixels.
//
// Evidence layout under <out>/ (see scripts/README.md "Gate 6"):
//   scene/import/{fixture,receiver}/  editor --import of fixtures/gate6-scene and receiver/
//   scene/capture/, scene/capture-inline/           400-frame captures (inline: no store)
//   scene/reference/, scene/reference-repeat/       rendered, oracle on: shots/<shot>.png,
//                                                   steps.jsonl, oracle.jsonl
//   scene/reference-armed/                          rendered, extension armed, oracle off
//   scene/receiver/, receiver-patch/, receiver-inline/  rendered receivers
//   scene/sabotage-{freeze,omit-transform,perturb-vertex,perturb-shader}/{capture,receiver}/
//   scene/sabotage-receiver-{ignore-clip,stale-texture}/
//   animate/{capture,reference,receiver}/, refused/{capture,reference,receiver}/

import { join } from "node:path";

import {
  decodePngRgba,
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type AppliedJson,
  type Checkpoint,
  checkHeadlessNoGpuGate0,
  classifyLeg,
  drawIndexTies,
  type Gate0Check,
  PATCH_RECORDING_NAME,
  parseStepLog,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
  type StepLine,
} from "./gate0-checks";
import {
  engineCall,
  loadResourceLog,
  parseJsonl,
  type ResourceLine,
} from "./gate2-checks";
import {
  checkPatchResolvesToFull,
  checkRecordingsDecode,
  evaluateCapture,
  type Gate3CaptureEvaluation,
} from "./gate3-checks";
import { check, type Gate5Check } from "./gate5-checks";
import type { Box } from "./gate5-expected";
import {
  type Gate6Expected,
  type Gate6Shot,
  rasterOfShot,
  refusedView,
  regionMap,
  undecidedContent,
} from "./gate6-expected";
import { loadWire5, txAt, type Wire5, type Wire5Tx } from "./gate55-wire";
import type { Gate5Raster } from "./geometry-raster";

export type Gate6Check = Gate5Check;

export const G6A_DIRS = {
  scene: "scene",
  animate: "animate",
  refused: "refused",
} as const;

/** Every classified g6a leg: its directory, the capture it replays (receivers) and what it must
 * reach. `pixel` is the verdict on the pixels outside HU (and RF): `success`, or
 * `pixel-mismatch` at expected.json `predictions[prediction]`. */
export interface G6aLeg {
  leg: string;
  kind: "capture" | "receiver";
  dir: string;
  capture?: string;
  sink?: string;
  variant: "" | "animate" | "refused";
  pixel?: "success" | "pixel-mismatch";
  prediction?: string;
}

export const G6A_LEGS: G6aLeg[] = [
  { leg: "capture-scene", kind: "capture", dir: "scene/capture", variant: "" },
  {
    leg: "capture-scene-inline",
    kind: "capture",
    dir: "scene/capture-inline",
    variant: "",
  },
  {
    leg: "capture-animate",
    kind: "capture",
    dir: "animate/capture",
    variant: "animate",
  },
  {
    leg: "capture-refused",
    kind: "capture",
    dir: "refused/capture",
    variant: "refused",
  },
  {
    leg: "receiver-scene",
    kind: "receiver",
    dir: "scene/receiver",
    capture: "scene/capture",
    sink: RECORDING_NAME,
    variant: "",
    pixel: "success",
  },
  {
    leg: "receiver-scene-patch",
    kind: "receiver",
    dir: "scene/receiver-patch",
    capture: "scene/capture",
    sink: PATCH_RECORDING_NAME,
    variant: "",
    pixel: "success",
  },
  {
    leg: "receiver-scene-inline",
    kind: "receiver",
    dir: "scene/receiver-inline",
    capture: "scene/capture-inline",
    sink: RECORDING_NAME,
    variant: "",
    pixel: "success",
  },
  {
    leg: "receiver-animate",
    kind: "receiver",
    dir: "animate/receiver",
    capture: "animate/capture",
    sink: RECORDING_NAME,
    variant: "animate",
    pixel: "success",
  },
  {
    leg: "receiver-refused",
    kind: "receiver",
    dir: "refused/receiver",
    capture: "refused/capture",
    sink: RECORDING_NAME,
    variant: "refused",
    pixel: "success",
  },
  ...(
    ["freeze", "omit-transform", "perturb-vertex", "perturb-shader"] as const
  ).map(
    (k): G6aLeg => ({
      leg: `sabotage-${k}`,
      kind: "receiver",
      dir: `scene/sabotage-${k}/receiver`,
      capture: `scene/sabotage-${k}/capture`,
      sink: RECORDING_NAME,
      variant: "",
      pixel: k === "perturb-shader" ? "success" : "pixel-mismatch",
      prediction: `sabotage-${k}`,
    }),
  ),
  ...(["ignore-clip", "stale-texture"] as const).map(
    (k): G6aLeg => ({
      leg: `sabotage-receiver-${k}`,
      kind: "receiver",
      dir: `scene/sabotage-receiver-${k}`,
      capture: "scene/capture",
      sink: RECORDING_NAME,
      variant: "",
      pixel: "pixel-mismatch",
      prediction: `sabotage-receiver-${k}`,
    }),
  ),
];

/** Regions never compared receiver against reference on /5 (the HUD layer is extra-canvas) and,
 * in `refused`, the refused region. */
/** The HUD panel's pixels (168x28): what a /5 receiver leaves out of HU while the HUD shows. */
export const HUD_PANEL_PIXELS = 168 * 28;

export function excludedRegions(variant: string): Set<string> {
  return new Set(variant === "refused" ? ["HU", "RF"] : ["HU"]);
}

// ---------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------

export interface Frame6 {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export type Shots6 = Map<string, Frame6 | null>;

async function loadPng(path: string): Promise<Frame6 | null> {
  const png = await decodePngRgba(path);
  return png ? { width: png.width, height: png.height, rgba: png.data } : null;
}

/** A reference leg's shots by shot id (shots/<id>.png). */
export async function loadReferenceShots6(
  dir: string,
  shots: readonly Gate6Shot[],
): Promise<Shots6> {
  const out: Shots6 = new Map();
  for (const s of shots)
    out.set(s.id, await loadPng(join(dir, "shots", `${s.id}.png`)));
  return out;
}

/** The seq each shot's frame was published at, in one recording. */
export function shotSeqs(
  shots: readonly Gate6Shot[],
  transactions: readonly { meta: { frame: number; seq: number } }[],
): Map<string, number> {
  const byFrame = new Map(transactions.map((t) => [t.meta.frame, t.meta.seq]));
  const out = new Map<string, number>();
  for (const s of shots) {
    const seq = byFrame.get(s.frame);
    if (seq !== undefined) out.set(s.id, seq);
  }
  return out;
}

/** A receiver leg's shots by shot id (shots/seq-<n>.png). */
export async function loadReceiverShots6(
  dir: string,
  shots: readonly Gate6Shot[],
  seqs: ReadonlyMap<string, number>,
): Promise<Shots6> {
  const out: Shots6 = new Map();
  for (const s of shots) {
    const seq = seqs.get(s.id);
    out.set(
      s.id,
      seq === undefined
        ? null
        : await loadPng(join(dir, "shots", `seq-${seq}.png`)),
    );
  }
  return out;
}

function maxDelta(
  a: Uint8Array,
  ai: number,
  b: Uint8Array,
  bi: number,
): number {
  let d = 0;
  for (let c = 0; c < 4; c++)
    d = Math.max(d, Math.abs(a[ai * 4 + c] - b[bi * 4 + c]));
  return d;
}

export interface FrameDiff {
  /** pixels compared (outside the excluded regions) */
  compared: number;
  mismatched: number;
  max_delta: number;
  /** mismatching pixels per region (excluded ones too, reported apart) */
  regions: Record<string, number>;
  excluded: Record<string, number>;
}

/** Pure: raw per-channel comparison of two frames, alpha included, attributing every pixel to its
 * region of `shot` (or "BG"). */
export function diffFrames6(
  a: Frame6,
  b: Frame6,
  regions: Record<string, Box>,
  exclude: ReadonlySet<string>,
): FrameDiff {
  const out: FrameDiff = {
    compared: 0,
    mismatched: 0,
    max_delta: 0,
    regions: {},
    excluded: {},
  };
  const map = regionMap(regions, a.width, a.height);
  for (let i = 0; i < a.width * a.height; i++) {
    const region = map[i];
    const d = maxDelta(a.rgba, i, b.rgba, i);
    if (exclude.has(region)) {
      if (d > 0) out.excluded[region] = (out.excluded[region] ?? 0) + 1;
      continue;
    }
    out.compared++;
    if (d === 0) continue;
    out.mismatched++;
    out.max_delta = Math.max(out.max_delta, d);
    out.regions[region] = (out.regions[region] ?? 0) + 1;
  }
  return out;
}

export interface LegShotDiff {
  shot: string;
  diff: FrameDiff | null;
}

/** Pure: a leg's shots against the reference's, shot by shot. */
export function compareShots6(
  shots: readonly Gate6Shot[],
  reference: Shots6,
  leg: Shots6,
  exclude: ReadonlySet<string>,
): LegShotDiff[] {
  return shots.map((s) => {
    const a = reference.get(s.id);
    const b = leg.get(s.id);
    return {
      shot: s.id,
      diff:
        a && b && a.width === b.width && a.height === b.height
          ? diffFrames6(a, b, s.regions, exclude)
          : null,
    };
  });
}

/** Pure: the pixel verdict of a leg: `success` when every compared pixel is equal, else
 * `pixel-mismatch`, and per shot the mismatching regions; problems when it differs from what the
 * leg must reach (exactly the predicted (shot, region) sets for a sabotage). */
export function evaluatePixelVerdict(
  diffs: readonly LegShotDiff[],
  want: "success" | "pixel-mismatch",
  predicted: Record<string, string[]> | undefined,
): {
  verdict: "success" | "pixel-mismatch" | "incomplete";
  table: Record<string, string[]>;
  problems: string[];
} {
  const problems: string[] = [];
  const table: Record<string, string[]> = {};
  let incomplete = false;
  let any = false;
  for (const d of diffs) {
    if (!d.diff) {
      incomplete = true;
      problems.push(`${d.shot}: shot missing`);
      continue;
    }
    const regions = Object.keys(d.diff.regions).sort();
    table[d.shot] = regions;
    if (regions.length > 0) any = true;
  }
  const verdict = incomplete
    ? "incomplete"
    : any
      ? "pixel-mismatch"
      : "success";
  if (verdict !== want && !incomplete)
    problems.push(`pixel verdict ${verdict}, expected ${want}`);
  if (want === "success") {
    for (const [shot, regions] of Object.entries(table))
      if (regions.length > 0)
        problems.push(
          `${shot}: ${regions.join(",")} differ from the reference`,
        );
  } else if (predicted) {
    for (const [shot, regions] of Object.entries(table)) {
      const p = [...(predicted[shot] ?? [])].sort();
      if (JSON.stringify(p) !== JSON.stringify(regions))
        problems.push(
          `${shot}: mismatching regions ${JSON.stringify(regions)} != predicted ${JSON.stringify(p)}`,
        );
    }
  }
  return { verdict, table, problems };
}

// ---------------------------------------------------------------------------------------------
// expected-self-consistent
// ---------------------------------------------------------------------------------------------

const LEVELS = new Set([0, 51, 102, 153, 204, 255]);
const THEME_PREFIXES = ["SCROLLBAR", "PB.", "BT.", "LE."];

/** Pure: expected.json obeys its own rules, recomputed here independently of make_expected.py's
 * asserts: 640x360; steps 0..11 at 1 + 10k (settle +7) with distinct marker colours; the shots
 * (twelve settle, three intermediate at 13, 53, 93); regions disjoint inside the viewport at every
 * shot; every scene colour on the 0.2 grid at alpha 1 (theme boxes and antialiasing feathers
 * exempt) and every texel on a grid level; outside every region only BG's panel or the clear
 * colour, or band; nothing but TL in the bottom strip y >= 344 before step 10; `fresh` as the
 * raster and the undecided boxes' content say; the oracle's continuous values as the D6 formulas
 * give them (SM's phase, PB's value). */
export function evaluateExpectedSelfConsistent(
  e: Gate6Expected,
  rasters: ReadonlyMap<string, Gate5Raster>,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const [W, H] = e.viewport;
  if (W !== 640 || H !== 360) problems.push(`viewport ${W}x${H}`);
  const steps = e.steps.map((s) => s.step);
  if (JSON.stringify(steps) !== JSON.stringify([...Array(12).keys()]))
    problems.push(`steps ${JSON.stringify(steps)}`);
  for (const s of e.steps) {
    const applied = s.step === 0 ? 1 : 1 + 10 * s.step;
    if (s.applied_frame !== applied || s.settle_frame !== 1 + 10 * s.step + 7)
      problems.push(
        `step ${s.step}: frames ${s.applied_frame}/${s.settle_frame}`,
      );
  }
  if (
    new Set(e.steps.map((s) => s.marker_rgba8.join())).size !== e.steps.length
  )
    problems.push("marker colours are not distinct per step");
  const shotIds = e.shots.map((s) => s.id);
  const want = [
    ...[...Array(12).keys()].map((k) => `step-${k}`),
    "frame-13",
    "frame-53",
    "frame-93",
  ];
  if (JSON.stringify(shotIds) !== JSON.stringify(want))
    problems.push(`shots ${JSON.stringify(shotIds)}`);
  for (const shot of e.shots) {
    const names = Object.keys(shot.regions);
    for (let i = 0; i < names.length; i++) {
      const a = shot.regions[names[i]];
      if (
        !(
          0 <= a[0] &&
          a[0] < a[2] &&
          a[2] <= W &&
          0 <= a[1] &&
          a[1] < a[3] &&
          a[3] <= H
        )
      )
        problems.push(
          `${shot.id}: region ${names[i]} is not inside the viewport`,
        );
      for (let j = i + 1; j < names.length; j++) {
        const b = shot.regions[names[j]];
        if (!(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]))
          problems.push(
            `${shot.id}: regions ${names[i]} and ${names[j]} overlap`,
          );
      }
    }
  }
  const onGrid = (v: number) =>
    [0, 0.2, 0.4, 0.6, 0.8, 1].some((g) => Math.abs(v - g) < 5e-4);
  for (const [key, ops] of Object.entries(e.op_lists))
    for (const op of ops) {
      if (!("kind" in op) || op.kind !== "mesh") continue;
      if (THEME_PREFIXES.some((p) => op.name.startsWith(p))) continue;
      for (const c of op.colors) {
        const band = op.band_px !== undefined && Math.abs(c[3]) < 1e-6;
        if (
          !c.slice(0, 3).every(onGrid) ||
          (!band && Math.abs(c[3] - 1) > 1e-6)
        ) {
          problems.push(`${key}/${op.name}: colour ${c} off the grid`);
          break;
        }
      }
    }
  for (const [name, t] of Object.entries(e.textures))
    for (let i = 0; i < t.rgba8_hex.length; i += 2)
      if (!LEVELS.has(Number.parseInt(t.rgba8_hex.slice(i, i + 2), 16))) {
        problems.push(`texture ${name}: texel byte off the grid`);
        break;
      }
  for (const shot of e.shots) {
    const r = rasters.get(shot.id);
    if (!r) continue;
    const map = regionMap(shot.regions, W, H);
    const shifted = shot.step >= 10;
    const [px, py] = shifted ? [8, 4] : [0, 0];
    let outside = 0;
    let strip = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!shifted && y >= 344 && map[i] !== "TL") {
          const clear = e.clear_rgba8;
          if (
            !r.exact[i] ||
            [0, 1, 2].some((c) => r.rgba[i * 4 + c] !== clear[c])
          )
            strip++;
        }
        if (map[i] !== "BG" || r.band[i]) continue;
        const inPanel = x >= px && x < 640 + px && y >= py && y < 344 + py;
        const want = inPanel ? [51, 51, 51] : e.clear_rgba8.slice(0, 3);
        if (!r.exact[i] || [0, 1, 2].some((c) => r.rgba[i * 4 + c] !== want[c]))
          outside++;
      }
    if (outside > 0)
      problems.push(
        `${shot.id}: ${outside} pixels outside every region are neither BG nor band`,
      );
    if (strip > 0)
      problems.push(
        `${shot.id}: ${strip} pixels of the bottom strip are not the clear colour`,
      );
  }
  // Freshness: a region is fresh exactly when its raster (pixels or decided-ness) or its undecided
  // content changes from the previous settle shot.
  const settle = e.shots.filter((s) => s.kind === "settle");
  for (let k = 1; k < settle.length; k++) {
    const a = settle[k - 1];
    const b = settle[k];
    const ra = rasters.get(a.id);
    const rb = rasters.get(b.id);
    if (!ra || !rb) continue;
    const ca = undecidedContent(e, a);
    const cb = undecidedContent(e, b);
    for (const [name, box] of Object.entries(b.regions)) {
      let changed = ca[name] !== cb[name];
      const boxA = a.regions[name] ?? box;
      const x0 = Math.min(box[0], boxA[0]);
      const y0 = Math.min(box[1], boxA[1]);
      const x1 = Math.max(box[2], boxA[2]);
      const y1 = Math.max(box[3], boxA[3]);
      for (let y = y0; y < y1 && !changed; y++)
        for (let x = x0; x < x1 && !changed; x++) {
          const i = y * W + x;
          if (ra.exact[i] !== rb.exact[i]) changed = true;
          for (let c = 0; c < 4; c++)
            if (ra.rgba[i * 4 + c] !== rb.rgba[i * 4 + c]) changed = true;
        }
      const fresh = e.steps[k]?.fresh[name];
      if (fresh !== undefined && changed !== fresh)
        problems.push(
          `step ${k}: ${name} fresh=${fresh} but its model ${changed ? "changes" : "does not change"}`,
        );
    }
  }
  // D6's formulas for the continuous values the oracle reads.
  for (const s of e.steps) {
    const f = s.settle_frame;
    const frozen = s.step >= 11;
    const phase = frozen ? 0 : Math.floor((f % 24) / 4);
    const v = ((f + e.time_offset_frames) % 300) / 3;
    const pb = frozen ? 40 : Math.floor(v / 0.01 + 0.5) * 0.01;
    if (s.oracle.sm.phase !== phase)
      problems.push(
        `step ${s.step}: SM phase ${s.oracle.sm.phase} != formula ${phase}`,
      );
    if (Math.abs(s.oracle.pb_value - pb) > 1e-9)
      problems.push(
        `step ${s.step}: PB value ${s.oracle.pb_value} != formula ${pb}`,
      );
  }
  return {
    problems,
    detail: `${e.steps.length} steps, ${e.shots.length} shots, ${Object.keys(e.regions).length} regions, ${Object.keys(e.op_lists).length} op lists`,
  };
}

// ---------------------------------------------------------------------------------------------
// The reference against the model
// ---------------------------------------------------------------------------------------------

export interface Gate6Checkpoint {
  leg: string;
  shot: string;
  path: string;
  compared: number | null;
  mismatched_pixels: number | null;
  max_channel_delta: number | null;
  delta1_used: number | null;
  regions: Record<string, number>;
}

/** Pure: each shot against its raster on every decided pixel (delta as the raster allows). */
export function evaluateExpectedImage6(
  _e: Pick<Gate6Expected, "viewport">,
  leg: string,
  shots: readonly Gate6Shot[],
  frames: Shots6,
  rasters: ReadonlyMap<string, Gate5Raster>,
  shotDir: string,
): { problems: string[]; checkpoints: Gate6Checkpoint[] } {
  const problems: string[] = [];
  const checkpoints: Gate6Checkpoint[] = [];
  for (const s of shots) {
    const frame = frames.get(s.id);
    const r = rasters.get(s.id);
    const path = join(shotDir, `${s.id}.png`);
    if (!frame || !r || frame.width !== r.width || frame.height !== r.height) {
      problems.push(`${leg} ${s.id}.png missing, unreadable or the wrong size`);
      checkpoints.push({
        leg,
        shot: s.id,
        path,
        compared: null,
        mismatched_pixels: null,
        max_channel_delta: null,
        delta1_used: null,
        regions: {},
      });
      continue;
    }
    const map = regionMap(s.regions, r.width, r.height);
    let compared = 0;
    let mismatched = 0;
    let maxD = 0;
    let used = 0;
    const regions: Record<string, number> = {};
    const examples: string[] = [];
    for (let i = 0; i < r.width * r.height; i++) {
      if (!r.exact[i]) continue;
      compared++;
      const d = maxDelta(frame.rgba, i, r.rgba, i);
      if (d > 0 && d <= r.delta[i]) used++;
      if (d <= r.delta[i]) continue;
      mismatched++;
      maxD = Math.max(maxD, d);
      regions[map[i]] = (regions[map[i]] ?? 0) + 1;
      if (examples.length < 3)
        examples.push(
          `(${i % r.width},${Math.floor(i / r.width)}) ${[...frame.rgba.subarray(i * 4, i * 4 + 4)]} vs ${[...r.rgba.subarray(i * 4, i * 4 + 4)]}`,
        );
    }
    checkpoints.push({
      leg,
      shot: s.id,
      path,
      compared,
      mismatched_pixels: mismatched,
      max_channel_delta: maxD,
      delta1_used: used,
      regions,
    });
    if (mismatched > 0)
      problems.push(
        `${leg} ${s.id}: ${mismatched} decided pixels differ from the model (max delta ${maxD}; ${Object.entries(
          regions,
        )
          .map(([g, n]) => `${g} ${n}`)
          .join(", ")}; e.g. ${examples.join(", ")})`,
      );
  }
  return { problems, checkpoints };
}

/** Pure: every sub-shape covers at least half its expected area with pixels that differ from what
 * lies beneath it in the model, in every shot. */
export function evaluatePresence6(
  leg: string,
  shots: readonly Gate6Shot[],
  frames: Shots6,
  rasters: ReadonlyMap<string, Gate5Raster>,
): { problems: string[]; shapes: number } {
  const problems: string[] = [];
  let shapes = 0;
  for (const s of shots) {
    const frame = frames.get(s.id);
    const r = rasters.get(s.id);
    if (!frame || !r) {
      problems.push(`${leg} ${s.id}: shot missing`);
      continue;
    }
    for (const c of r.shapes) {
      if (c.covered === 0) continue;
      shapes++;
      let present = 0;
      c.area.forEach((i, k) => {
        for (let ch = 0; ch < 4; ch++)
          if (frame.rgba[i * 4 + ch] !== c.underlay[k * 4 + ch]) {
            present++;
            return;
          }
      });
      if (present * 2 < c.covered)
        problems.push(
          `${leg} ${s.id} ${c.item}/${c.shape}: ${present} pixels present, expected at least ${Math.ceil(c.covered / 2)} of ${c.covered}`,
        );
    }
  }
  return { problems, shapes };
}

/** Pure: between consecutive settle shots a region's pixels change exactly when expected.json
 * says fresh. */
export function evaluateFreshness6(
  e: Pick<Gate6Expected, "steps">,
  leg: string,
  shots: readonly Gate6Shot[],
  frames: Shots6,
  exclude: ReadonlySet<string> = new Set(),
): { problems: string[]; table: Record<string, string[]> } {
  const problems: string[] = [];
  const table: Record<string, string[]> = {};
  const settle = shots.filter((s) => s.kind === "settle");
  for (let k = 1; k < settle.length; k++) {
    const a = frames.get(settle[k - 1].id);
    const b = frames.get(settle[k].id);
    if (!a || !b) {
      problems.push(`${leg} step ${k}: shot missing`);
      continue;
    }
    const changed: string[] = [];
    for (const [name, box] of Object.entries(settle[k].regions)) {
      if (exclude.has(name)) continue;
      const boxA = settle[k - 1].regions[name] ?? box;
      let differs = false;
      for (
        let y = Math.min(box[1], boxA[1]);
        y < Math.max(box[3], boxA[3]) && !differs;
        y++
      )
        for (
          let x = Math.min(box[0], boxA[0]);
          x < Math.max(box[2], boxA[2]) && !differs;
          x++
        ) {
          const i = y * b.width + x;
          if (maxDelta(a.rgba, i, b.rgba, i) > 0) differs = true;
        }
      if (differs) changed.push(name);
      const fresh = e.steps[k]?.fresh[name];
      if (fresh !== undefined && differs !== fresh)
        problems.push(
          `${leg} step ${k}: ${name} ${differs ? "changed" : "did not change"}, expected fresh=${fresh}`,
        );
    }
    table[String(k)] = changed;
  }
  return { problems, table };
}

export interface RegionBudget6 {
  region: string;
  class: "exact" | "delta1" | "band" | "undecided";
  pixels: number;
  mismatched_pixels: number;
  max_channel_delta: number;
}

/** Pure: leg against leg per region and pixel class over every shot (any difference is a problem:
 * one build on one GPU must agree everywhere; this is the measured budget, D13/Q6g). */
export function compareLegsBudget6(
  shots: readonly Gate6Shot[],
  a: Shots6,
  b: Shots6,
  rasters: ReadonlyMap<string, Gate5Raster>,
  labels: [string, string],
): { problems: string[]; budgets: RegionBudget6[] } {
  const problems: string[] = [];
  const cells = new Map<string, RegionBudget6>();
  for (const s of shots) {
    const fa = a.get(s.id);
    const fb = b.get(s.id);
    const r = rasters.get(s.id);
    if (!fa || !fb || !r) {
      problems.push(`${s.id}: ${!fa ? labels[0] : labels[1]} shot missing`);
      continue;
    }
    const map = regionMap(s.regions, fa.width, fa.height);
    let n = 0;
    for (let i = 0; i < fa.width * fa.height; i++) {
      const cls = r.exact[i]
        ? r.delta[i] > 0
          ? "delta1"
          : "exact"
        : r.band[i]
          ? "band"
          : "undecided";
      const key = `${map[i]}/${cls}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          region: map[i],
          class: cls,
          pixels: 0,
          mismatched_pixels: 0,
          max_channel_delta: 0,
        };
        cells.set(key, cell);
      }
      cell.pixels++;
      const d = maxDelta(fa.rgba, i, fb.rgba, i);
      if (d === 0) continue;
      n++;
      cell.mismatched_pixels++;
      cell.max_channel_delta = Math.max(cell.max_channel_delta, d);
    }
    if (n > 0)
      problems.push(
        `${s.id}: ${n} pixels differ between ${labels[0]} and ${labels[1]}`,
      );
  }
  return { problems, budgets: [...cells.values()] };
}

// ---------------------------------------------------------------------------------------------
// The scene oracle
// ---------------------------------------------------------------------------------------------

export interface OraclePage {
  font_key: string;
  size: number;
  outline: number;
  index: number;
  width: number;
  height: number;
  format: string;
  sha256: string;
}

export interface OracleLine6 {
  schema: "render-stream-gate6-oracle/1";
  step: number;
  frame: number;
  oversampling: number;
  scroll: { v_scroll: number; content_position: [number, number] };
  canvas_layers: {
    name: string;
    layer: number;
    sublayer: number;
    visible: boolean;
  }[];
  materials: {
    SM: {
      shader_sha256: string;
      params: { name: string; type: string; value: unknown }[];
    };
    CM: { blend_mode: number };
  };
  pb_value: number;
  rich_text: {
    line_offsets: number[];
    content_height: number;
    v_scroll: number;
  };
  line_edit: {
    text: string;
    text_height: number;
    selection: number[][];
    carets: number[][];
  };
  pages: OraclePage[];
}

export function validateOracleLine6(value: unknown): string | null {
  if (value === null || typeof value !== "object") return "not an object";
  const v = value as Partial<OracleLine6>;
  if (v.schema !== "render-stream-gate6-oracle/1") return "schema";
  if (!Number.isInteger(v.step) || !Number.isInteger(v.frame))
    return "step/frame";
  if (
    !Array.isArray(v.pages) ||
    !v.scroll ||
    !v.materials ||
    !v.line_edit ||
    !v.rich_text
  )
    return "pages/scroll/materials/line_edit/rich_text";
  return null;
}

export interface OracleLog6 {
  leg: string;
  path: string;
  text: string | undefined;
  lines: OracleLine6[];
  problem: string | null;
}

export async function loadOracle6(
  dir: string,
  leg: string,
): Promise<OracleLog6> {
  const path = join(dir, "oracle.jsonl");
  const text = await readTextOrUndefined(path);
  const parsed = parseJsonl<OracleLine6>(text, validateOracleLine6);
  return { leg, path, text, lines: parsed.lines, problem: parsed.problem };
}

function oracleAt(log: OracleLog6, step: number): OracleLine6 | undefined {
  return log.lines.find((l) => l.step === step);
}

/** Pure: each oracle log has one line per step at its settle frame and reads back exactly the
 * model's view: oversampling 1, SC's v_scroll and content position (floored, Q1c), the HUD's
 * layer and visibility, PB's value, SM's phase, tint (float32 widened) and shader hash, CM's
 * blend mode, the RichTextLabel's line offsets, content height and scroll (the measured line
 * height and the scroll rule); `pairs` byte-identical. */
export function evaluateOracle6(
  e: Pick<Gate6Expected, "steps">,
  logs: readonly OracleLog6[],
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  const near = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  for (const log of logs) {
    if (log.problem) {
      problems.push(`${log.leg} oracle.jsonl: ${log.problem}`);
      continue;
    }
    if (log.lines.length !== e.steps.length)
      problems.push(
        `${log.leg}: ${log.lines.length} oracle lines, expected ${e.steps.length}`,
      );
    for (const s of e.steps) {
      const o = oracleAt(log, s.step);
      if (!o) {
        problems.push(`${log.leg} step ${s.step}: no oracle line`);
        continue;
      }
      const w = s.oracle;
      const bad = (what: string, got: unknown, want: unknown) =>
        problems.push(
          `${log.leg} step ${s.step}: ${what} ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
        );
      compared++;
      if (o.frame !== s.settle_frame) bad("frame", o.frame, s.settle_frame);
      if (o.oversampling !== w.oversampling)
        bad("oversampling", o.oversampling, w.oversampling);
      if (o.scroll.v_scroll !== w.v_scroll)
        bad("v_scroll", o.scroll.v_scroll, w.v_scroll);
      if (
        JSON.stringify(o.scroll.content_position) !==
        JSON.stringify(w.content_position)
      )
        bad("content_position", o.scroll.content_position, w.content_position);
      const hud = o.canvas_layers.find((c) => c.name === "HUD");
      if (!hud || hud.layer !== w.hud.layer || hud.visible !== w.hud.visible)
        bad("HUD layer/visible", hud, w.hud);
      if (!near(o.pb_value, w.pb_value))
        bad("pb_value", o.pb_value, w.pb_value);
      const phase = o.materials.SM.params.find((p) => p.name === "phase");
      const tint = o.materials.SM.params.find((p) => p.name === "tint");
      if (phase?.type !== "int" || phase.value !== w.sm.phase)
        bad("SM phase", phase, w.sm.phase);
      if (
        tint?.type !== "color" ||
        JSON.stringify(tint.value) !== JSON.stringify(w.sm.tint)
      )
        bad("SM tint", tint, w.sm.tint);
      if (o.materials.SM.shader_sha256 !== w.sm.shader_sha256)
        bad(
          "SM shader sha256",
          o.materials.SM.shader_sha256,
          w.sm.shader_sha256,
        );
      if (o.materials.CM.blend_mode !== w.cm_blend_mode)
        bad("CM blend_mode", o.materials.CM.blend_mode, w.cm_blend_mode);
      const rt = o.rich_text;
      const wrt = (w as unknown as { rich_text?: OracleLine6["rich_text"] })
        .rich_text;
      if (wrt) {
        if (
          JSON.stringify(rt.line_offsets) !== JSON.stringify(wrt.line_offsets)
        )
          bad("RT line offsets", rt.line_offsets, wrt.line_offsets);
        if (rt.content_height !== wrt.content_height)
          bad("RT content height", rt.content_height, wrt.content_height);
        if (rt.v_scroll !== wrt.v_scroll)
          bad("RT v_scroll", rt.v_scroll, wrt.v_scroll);
      }
    }
  }
  if (
    logs.length >= 2 &&
    logs[0].text !== undefined &&
    logs[0].text !== logs[1].text
  )
    problems.push(`${logs[0].leg} and ${logs[1].leg} oracle.jsonl differ`);
  return { problems, compared };
}

/** Pure: at every settle step each oracle page's sha256 is the hash of exactly one `ok` image
 * texture of the capture's settle transaction, and every `ok` image there of the atlas format is
 * an oracle page (headless rasterization is byte-identical to the rendered reference's). */
export function evaluateAtlasParity6(
  e: Pick<Gate6Expected, "steps" | "hook_census">,
  oracle: OracleLog6,
  wire: Pick<Wire5, "transactions" | "path">,
): { problems: string[]; pages: number; table: Record<string, number> } {
  const problems: string[] = [];
  const table: Record<string, number> = {};
  let pages = 0;
  for (const s of e.steps) {
    const line = oracleAt(oracle, s.step);
    const tx = txAt(wire.transactions, s.settle_frame);
    if (!line || !tx) {
      problems.push(
        `step ${s.step}: no ${line ? "settle transaction" : "oracle line"}`,
      );
      continue;
    }
    const ok = tx.state.textures.filter(
      (t) => t.kind === "image" && t.status === "ok",
    );
    for (const p of line.pages) {
      pages++;
      const hits = ok.filter((t) => t.hash === p.sha256);
      if (hits.length !== 1)
        problems.push(
          `step ${s.step}: page ${p.font_key}/${p.size}/${p.outline}#${p.index} (${p.sha256.slice(0, 12)}) is the hash of ${hits.length} wire textures`,
        );
    }
    const atlas = ok.filter((t) => t.format === e.hook_census.atlas_format);
    for (const t of atlas)
      if (!line.pages.some((p) => p.sha256 === t.hash))
        problems.push(
          `step ${s.step}: wire texture ${t.id} (${t.format} ${t.width}x${t.height}, ${t.hash?.slice(0, 12)}) is no oracle page`,
        );
    table[String(s.step)] = line.pages.length;
  }
  return { problems, pages, table };
}

/** Pure: the capture's LineEdit commands at every settle frame carry exactly the oracle's
 * selection rects (selection colour, theme (0.5,0.5,0.5,1)) and caret rects (caret colour, theme
 * (0.95,0.95,0.95,1)), float32-equal: "selection rect and caret exact in position" (Q6b). */
export function evaluateLineEditGeometry(
  e: Pick<Gate6Expected, "steps">,
  oracle: OracleLog6,
  wire: Pick<Wire5, "transactions">,
  leId: number | undefined,
): { problems: string[]; rects: number } {
  const problems: string[] = [];
  let rects = 0;
  const f32 = Math.fround;
  const key = (r: number[]) => r.map((v) => f32(v)).join(",");
  for (const s of e.steps) {
    const line = oracleAt(oracle, s.step);
    const tx = txAt(wire.transactions, s.settle_frame);
    const item = tx?.state.items.find((i) => i.id === leId);
    if (!line || !item) {
      problems.push(`step ${s.step}: no ${line ? "LE item" : "oracle line"}`);
      continue;
    }
    const sel: string[] = [];
    const caret: string[] = [];
    for (const c of item.commands as unknown as {
      op: string;
      rect?: number[];
      color?: number[];
    }[]) {
      if (c.op !== "add_rect" || !c.rect || !c.color) continue;
      if (c.color.every((v, k) => v === f32([0.5, 0.5, 0.5, 1][k])))
        sel.push(key(c.rect));
      else if (c.color.every((v, k) => v === f32([0.95, 0.95, 0.95, 1][k])))
        caret.push(key(c.rect));
    }
    const wantSel = line.line_edit.selection.map(key);
    const wantCaret = line.line_edit.carets.map(key);
    rects += sel.length + caret.length;
    if (JSON.stringify([...sel].sort()) !== JSON.stringify([...wantSel].sort()))
      problems.push(
        `step ${s.step}: selection rects ${JSON.stringify(sel)} != oracle ${JSON.stringify(wantSel)}`,
      );
    if (
      JSON.stringify([...caret].sort()) !==
      JSON.stringify([...wantCaret].sort())
    )
      problems.push(
        `step ${s.step}: caret rects ${JSON.stringify(caret)} != oracle ${JSON.stringify(wantCaret)}`,
      );
  }
  return { problems, rects };
}

// ---------------------------------------------------------------------------------------------
// The wire: names, scroll, parameters, ties
// ---------------------------------------------------------------------------------------------

/** Item name -> wire id: ids seen over the run ascending, paired with the creation order then the
 * created-later names. */
export function nameIds6(
  transactions: readonly Pick<Wire5Tx, "state">[],
  order: readonly string[],
): { ids: Map<string, number>; problems: string[] } {
  const seen = new Set<number>();
  for (const t of transactions) for (const i of t.state.items) seen.add(i.id);
  const sorted = [...seen].sort((a, b) => a - b);
  const problems: string[] = [];
  if (sorted.length !== order.length)
    problems.push(
      `${sorted.length} item ids on the wire, expected ${order.length}`,
    );
  const ids = new Map<string, number>();
  order.forEach((n, k) => {
    if (k < sorted.length) ids.set(n, sorted[k]);
  });
  return { ids, problems };
}

/** Pure: at every settle frame of a sink, the content Control's (Rows') wire transform is the
 * floored offset (0, -v_scroll) of expected.json `scroll`, SC's scissor flag is set, and the rows'
 * own content (R and L items) keeps one content_version across steps 1 and 5 (scrolling is a
 * transform, Q1c); the scrollbar redraws at steps 1 and 5. */
export function evaluateScrollWire(
  e: Pick<Gate6Expected, "steps" | "scroll">,
  wire: Pick<Wire5, "transactions">,
  ids: ReadonlyMap<string, number>,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const at = (frame: number, name: string) =>
    txAt(wire.transactions, frame)?.state.items.find(
      (i) => i.id === ids.get(name),
    );
  for (const s of e.scroll) {
    const frame = e.steps[s.step].settle_frame;
    const rows = at(frame, "Rows");
    const want = [1, 0, 0, 1, s.content_offset[0], s.content_offset[1]];
    if (!rows || JSON.stringify(rows.xform) !== JSON.stringify(want))
      problems.push(
        `step ${s.step}: Rows xform ${JSON.stringify(rows?.xform)} != ${JSON.stringify(want)}`,
      );
    const sc = at(frame, "SC");
    if (!sc?.clip) problems.push(`step ${s.step}: SC does not clip`);
  }
  for (const step of [1, 5]) {
    const before = e.steps[step - 1].settle_frame;
    const after = e.steps[step].settle_frame;
    for (const name of ["R0", "L0", "R3", "L3"]) {
      const a = at(before, name);
      const b = at(after, name);
      if (!a || !b || a.content_version !== b.content_version)
        problems.push(
          `step ${step}: ${name} content_version ${a?.content_version} -> ${b?.content_version}, expected unchanged`,
        );
    }
    const a = at(before, "SC_VScroll");
    const b = at(after, "SC_VScroll");
    if (!a || !b || a.content_version === b.content_version)
      problems.push(`step ${step}: SC_VScroll did not redraw`);
  }
  return {
    problems,
    detail: e.scroll.map((s) => `${s.step}:${s.v_scroll}`).join(" "),
  };
}

/** Pure: TR's pixels change at step 3 through its texture alone: TEXA keeps its id and gets a new
 * version and hash, and TR's commands stay identical (As built, G6a: Q6c's "no item redraw" does
 * not hold for TR: ImageTexture::update emits `changed` (image_texture.cpp:126-127) and
 * TextureRect queues a redraw on it (texture_rect.cpp:179-181), which re-records the same
 * add_texture_rect, so TR's content_version moves while its commands do not); and TL keeps one
 * content_version and transform until step 10's canvas shift. */
export function evaluateFreshWithoutRedraw6(
  e: Pick<Gate6Expected, "steps">,
  wire: Pick<Wire5, "transactions">,
  ids: ReadonlyMap<string, number>,
): { problems: string[] } {
  const problems: string[] = [];
  const at = (frame: number, name: string) =>
    txAt(wire.transactions, frame)?.state.items.find(
      (i) => i.id === ids.get(name),
    );
  const b3 = e.steps[2].settle_frame;
  const a3 = e.steps[3].settle_frame;
  const tr0 = at(b3, "TR");
  const tr1 = at(a3, "TR");
  if (
    !tr0 ||
    !tr1 ||
    JSON.stringify(tr0.commands) !== JSON.stringify(tr1.commands)
  )
    problems.push(
      `TR commands across step 3 ${JSON.stringify(tr0?.commands)} -> ${JSON.stringify(tr1?.commands)}, expected identical`,
    );
  const texOf = (frame: number) => {
    const t = txAt(wire.transactions, frame);
    const item = t?.state.items.find((i) => i.id === ids.get("TR"));
    const cmd = (
      item?.commands as unknown as { op: string; tex?: number }[] | undefined
    )?.find((c) => c.op === "add_texture_rect");
    return t?.state.textures.find((x) => x.id === cmd?.tex);
  };
  const v0 = texOf(b3);
  const v1 = texOf(a3);
  if (
    !v0 ||
    !v1 ||
    v0.id !== v1.id ||
    v0.version === v1.version ||
    v0.hash === v1.hash
  )
    problems.push(
      `TEXA through TR: ${JSON.stringify(v0 && { id: v0.id, version: v0.version })} -> ${JSON.stringify(v1 && { id: v1.id, version: v1.version })}, expected one id, a new version and hash`,
    );
  const tl0 = at(e.steps[0].settle_frame, "TL");
  for (const s of e.steps.slice(1, 10)) {
    const tl = at(s.settle_frame, "TL");
    if (
      !tl ||
      !tl0 ||
      tl.content_version !== tl0.content_version ||
      JSON.stringify(tl.xform) !== JSON.stringify(tl0.xform)
    )
      problems.push(
        `step ${s.step}: TL changed (content_version ${tl?.content_version}, xform ${JSON.stringify(tl?.xform)})`,
      );
  }
  return { problems };
}

/** Pure: at every settle frame of a sink SM's material carries `phase` (int) and `tint` (color,
 * float32) as the model has them, SM's shader entry is `ok` `payload` with the model's GRP1 hash,
 * and CM's material's shader is the builtin CanvasItemMaterial in the model's blend mode. */
export function evaluateParamWire(
  e: Pick<Gate6Expected, "steps">,
  wire: Pick<Wire5, "transactions">,
  ids: ReadonlyMap<string, number>,
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  for (const s of e.steps) {
    const tx = txAt(wire.transactions, s.settle_frame);
    if (!tx) {
      problems.push(`step ${s.step}: no settle transaction`);
      continue;
    }
    const sm = tx.state.items.find((i) => i.id === ids.get("SM"));
    const cmo = tx.state.items.find((i) => i.id === ids.get("CMO"));
    const mat = tx.state.materials?.find((m) => m.id === sm?.material);
    const shader = tx.state.shaders?.find((x) => x.id === mat?.shader);
    const phase = mat?.params.find((p) => p.name === "phase");
    const tint = mat?.params.find((p) => p.name === "tint");
    compared++;
    if (phase?.type !== "int" || phase.value !== s.oracle.sm.phase)
      problems.push(
        `step ${s.step}: SM phase ${JSON.stringify(phase)} != ${s.oracle.sm.phase}`,
      );
    if (
      tint?.type !== "color" ||
      JSON.stringify(tint.value) !==
        JSON.stringify(s.oracle.sm.tint.map((v) => Math.fround(v)))
    )
      problems.push(
        `step ${s.step}: SM tint ${JSON.stringify(tint)} != ${JSON.stringify(s.oracle.sm.tint)}`,
      );
    if (
      shader?.status !== "ok" ||
      shader.source !== "payload" ||
      shader.hash !== s.oracle.sm.shader_sha256
    )
      problems.push(
        `step ${s.step}: SM shader ${JSON.stringify(shader && { status: shader.status, source: shader.source, hash: shader.hash })}, expected ok payload ${s.oracle.sm.shader_sha256.slice(0, 12)}`,
      );
    const cm = tx.state.materials?.find((m) => m.id === cmo?.material);
    const cmShader = tx.state.shaders?.find((x) => x.id === cm?.shader);
    const want = { 1: "add", 2: "sub" }[s.oracle.cm_blend_mode];
    if (cmShader?.builtin?.blend_mode !== want)
      problems.push(
        `step ${s.step}: CM builtin ${JSON.stringify(cmShader?.builtin)}, expected blend ${want}`,
      );
  }
  return { problems, compared };
}

/** Pure: no transaction of any capture sink carries a draw-index-tie entry or a tie by
 * drawIndexTies, and at frame 1 the root canvas holds exactly Scene and TL with distinct draw
 * indices (As built, G6a: both enter before the first iteration, so their deferred top-level
 * raises land inside frame 1 and nothing ever ties). */
export function evaluateNoTies6(
  sinks: readonly { label: string; recording: RecordingSummary }[],
  ids: ReadonlyMap<string, number>,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  let detail = "";
  for (const { label, recording } of sinks) {
    for (const t of recording.transactions) {
      if (t.meta.unsupported.some((u) => u.reason === "draw-index-tie"))
        problems.push(`${label} frame ${t.meta.frame}: a draw-index-tie entry`);
      const ties = drawIndexTies(t.meta);
      if (ties.length > 0)
        problems.push(
          `${label} frame ${t.meta.frame}: ${ties.length} tie(s), e.g. ${JSON.stringify(ties[0].members)}`,
        );
      if (problems.length > 6) break;
    }
  }
  const first = sinks[0]?.recording.transactions[0];
  const root = first?.meta.canvases.find((c) => c.id === 1);
  const items = new Map(
    (first?.meta.items ?? []).map((i) => [i.id, i] as const),
  );
  const children = (root?.items ?? []).map(
    (id) => [id, items.get(id)?.draw_index] as const,
  );
  const want = [ids.get("Scene"), ids.get("TL")];
  if (
    JSON.stringify(children.map(([id]) => id)) !== JSON.stringify(want) ||
    new Set(children.map(([, d]) => d)).size !== children.length
  )
    problems.push(
      `frame 1 root canvas children ${JSON.stringify(children)}, expected Scene (${want[0]}) and TL (${want[1]}) with distinct draw indices`,
    );
  detail = `frame ${first?.meta.frame}: root canvas ${children.map(([id, d]) => `${id}@${d}`).join(" ")}`;
  return { problems, detail };
}

// ---------------------------------------------------------------------------------------------
// The hook log against the census
// ---------------------------------------------------------------------------------------------

export interface CensusCounters {
  counts?: Record<string, number>;
}

/** Pure: the capture's hook log (engine calls up to the quit frame) carries exactly the scene's own
 * resource calls: TEXN, TEXA and TEXB created at frame 1 with their predicted GRT1 hashes (in that
 * order), TEXA updated to TEXA(1) at step 3's frame and freed at step 9's; every other image is the
 * engine's hue strip or an atlas page (LA8); MS's mesh created at frame 1 with 16 vertices and 42
 * indices and one vertex-region update on every frame from 1 to step 11's; SM's shader created from
 * code at frame 1 with the predicted GRP1 hash and SM's parameter writes exactly as listed; CM's
 * builtin shaders add at frame 1 and sub at step 4's frame; the counters' canvas calls. */
export function evaluateSceneCensus(
  e: Pick<
    Gate6Expected,
    | "hook_census"
    | "texture_hashes"
    | "capture_quit_frame"
    | "creation_order"
    | "created_later"
  >,
  lines: readonly ResourceLine[],
  counters: CensusCounters | undefined,
  hudHidden: readonly number[],
  variant: "" | "animate" = "",
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const c = e.hook_census;
  const quit = e.capture_quit_frame;
  const calls = lines.filter((l) => engineCall(l) && l.frame <= quit);
  const fixtureHashes = new Map(
    Object.entries(e.texture_hashes).map(([k, v]) => [v, k] as const),
  );
  const images = calls.filter((l) => l.kind === "image");
  const creates = images.filter((l) => l.op === "texture_2d_create");
  const fixture = creates.filter(
    (l) => l.hash !== null && fixtureHashes.has(l.hash),
  );
  const wantCreates = c.textures.filter((t) => t.op === "texture_2d_create");
  if (
    JSON.stringify(fixture.map((l) => [l.frame, l.hash])) !==
    JSON.stringify(wantCreates.map((t) => [t.frame, t.hash]))
  )
    problems.push(
      `fixture texture creates ${JSON.stringify(fixture.map((l) => [l.frame, fixtureHashes.get(l.hash ?? "")]))} != ${JSON.stringify(wantCreates.map((t) => [t.frame, t.texture]))}`,
    );
  const texaId =
    fixture.find((l) => l.hash === e.texture_hashes.TEXA0)?.id ?? null;
  const texaLines = images.filter(
    (l) => l.id === texaId && l.op !== "texture_2d_create",
  );
  const wantTexa =
    variant === "animate"
      ? [
          ...c.animate_texa.map(
            ([f, , h]) => [f, "texture_2d_update", h] as const,
          ),
          [
            c.textures.find((t) => t.op === "free")?.frame ?? -1,
            "free",
            null,
          ] as const,
        ]
      : c.textures
          .filter((t) => t.texture === "TEXA" && t.op !== "texture_2d_create")
          .map((t) => [t.frame, t.op, t.hash] as const);
  const gotTexa = texaLines.map(
    (l) => [l.frame, l.op, l.op === "free" ? null : l.hash] as const,
  );
  if (JSON.stringify(gotTexa) !== JSON.stringify(wantTexa))
    problems.push(
      `TEXA after create ${JSON.stringify(gotTexa.map(([f, op, h]) => [f, op, h?.slice(0, 12) ?? null]))} != ${JSON.stringify(wantTexa.map(([f, op, h]) => [f, op, h?.slice(0, 12) ?? null]))}`,
    );
  for (const l of creates) {
    if (l.hash !== null && fixtureHashes.has(l.hash)) continue;
    const engine = c.engine_textures.some(
      (t) =>
        t.frame === l.frame &&
        t.format === l.format &&
        t.width === l.width &&
        t.height === l.height,
    );
    if (!engine && l.format !== c.atlas_format)
      problems.push(
        `texture ${l.id} created at ${l.frame} (${l.format} ${l.width}x${l.height}) is neither fixture, engine nor atlas`,
      );
  }
  for (const l of images.filter(
    (x) => x.op === "texture_2d_update" && x.id !== texaId,
  )) {
    const create = creates.find((x) => x.id === l.id);
    if (create?.format !== c.atlas_format)
      problems.push(
        `texture ${l.id} updated at ${l.frame} is not an atlas page`,
      );
  }
  const meshes = calls.filter((l) => l.kind === "mesh");
  const [f0, f1] = c.mesh.region_update_frames;
  const updates = meshes
    .filter((l) => l.op === "mesh_surface_update_vertex_region")
    .map((l) => l.frame);
  const wantUpdates = [...Array(f1 - f0 + 1).keys()].map((k) => f0 + k);
  if (JSON.stringify(updates) !== JSON.stringify(wantUpdates))
    problems.push(
      `MS vertex region updates at ${updates.length} frames (${updates.slice(0, 3).join(",")}..${updates.slice(-2).join(",")}), expected one per frame ${f0}..${f1}`,
    );
  const surface = meshes.find((l) => l.op === "mesh_add_surface");
  if (
    !meshes.some(
      (l) => l.op === "mesh_create" && l.frame === c.mesh.create_frame,
    ) ||
    surface?.vertex_count !== c.mesh.vertex_count ||
    surface?.index_count !== c.mesh.index_count
  )
    problems.push(
      `MS mesh create/add_surface ${JSON.stringify(surface && { frame: surface.frame, v: surface.vertex_count, i: surface.index_count })}`,
    );
  const others = meshes.filter(
    (l) =>
      ![
        "mesh_create",
        "mesh_add_surface",
        "mesh_surface_update_vertex_region",
      ].includes(l.op),
  );
  if (others.length > 0)
    problems.push(
      `unexpected mesh calls ${others.map((l) => `${l.op}@${l.frame}`).join(",")}`,
    );
  const shaders = calls.filter((l) => l.kind === "shader");
  const sm = shaders.find((l) => l.op === "shader_create_from_code");
  if (sm?.frame !== 1 || sm.hash !== c.sm.shader_sha256)
    problems.push(
      `SM shader_create_from_code ${JSON.stringify(sm && { frame: sm.frame, hash: sm.hash })}, expected frame 1 hash ${c.sm.shader_sha256.slice(0, 12)}`,
    );
  const smMaterial =
    calls.find((l) => l.op === "material_create_from_shader")?.id ?? null;
  const params = calls
    .filter(
      (l) =>
        l.kind === "material" &&
        l.op === "material_set_param" &&
        l.id === smMaterial,
    )
    .map((l) => [l.frame, l.param] as [number, string]);
  if (
    variant === "" &&
    JSON.stringify(params) !== JSON.stringify(c.sm.param_sets)
  )
    problems.push(
      `SM parameter writes ${JSON.stringify(params)} != ${JSON.stringify(c.sm.param_sets)}`,
    );
  const builtins = shaders
    .filter((l) => l.op === "shader_set_code" && l.builtin)
    .map((l) => [l.frame, l.builtin?.blend_mode] as [number, string]);
  if (JSON.stringify(builtins) !== JSON.stringify(c.cm.shaders))
    problems.push(
      `CM builtin shaders ${JSON.stringify(builtins)} != ${JSON.stringify(c.cm.shaders)}`,
    );
  const counts = counters?.counts ?? {};
  for (const op of [
    "canvas_create",
    "viewport_attach_canvas",
    "viewport_set_canvas_transform",
  ] as const)
    if (counts[op] !== c.canvas[op])
      problems.push(`counters ${op} ${counts[op]}, expected ${c.canvas[op]}`);
  const items = e.creation_order.length + e.created_later.length;
  if (counts.canvas_item_create !== items)
    problems.push(
      `counters canvas_item_create ${counts.canvas_item_create}, expected ${items}`,
    );
  const [h0, h1] = c.canvas.hud_hidden_frames;
  const wantHidden = [...Array(h1 - h0 + 1).keys()].map((k) => h0 + k);
  if (JSON.stringify(hudHidden) !== JSON.stringify(wantHidden))
    problems.push(
      `HUD panel hidden at ${hudHidden.length} frames (${hudHidden[0]}..${hudHidden[hudHidden.length - 1]}), expected ${h0}..${h1}`,
    );
  return {
    problems,
    detail: `${fixture.length} fixture textures, ${creates.length - fixture.length} engine/atlas textures, ${updates.length} MS region updates, ${params.length} SM parameter writes, CM ${builtins.map(([f, m]) => `${m}@${f}`).join(" ")}`,
  };
}

/** The frames at which the HUD panel item is invisible on a sink. */
export function hudHiddenFrames(
  wire: Pick<Wire5, "transactions">,
  hudId: number | undefined,
): number[] {
  const out: number[] = [];
  for (const t of wire.transactions) {
    const item = t.state.items.find((i) => i.id === hudId);
    if (item && !item.visible) out.push(t.frame);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

/** The `<op>/<reason>` pairs a recording carries as unsupported (entries and commands; a
 * command's reason is its own). */
export function unsupportedPairs(recording: RecordingSummary): string[] {
  const out = new Set<string>();
  for (const t of recording.transactions) {
    for (const u of t.meta.unsupported)
      if (u.reason !== "draw-index-tie") out.add(`${u.op}/${u.reason}`);
    for (const item of t.meta.items)
      for (const c of item.commands as unknown as {
        op: string;
        name?: string;
        reason?: string;
      }[])
        if (c.op === "unsupported")
          out.add(`${c.name}/${c.reason ?? "unsupported-op"}`);
  }
  return [...out].sort();
}

/** Pure: a classification is `unsupported` for exactly `want` (op/reason pairs) and nothing else
 * fired: no capture-failure, no replay-failure. */
export function evaluateUnsupportedClass(
  cls: { result_class: string; reasons: readonly string[] },
  pairs: readonly string[],
  want: readonly [string, string][],
): string[] {
  const problems: string[] = [];
  if (cls.result_class !== "unsupported")
    problems.push(`class ${cls.result_class}, expected unsupported`);
  const other = cls.reasons.filter(
    (r) => !r.startsWith("unsupported:") && !r.startsWith("pixel-mismatch:"),
  );
  if (other.length > 0)
    problems.push(`other classes fired: ${other.slice(0, 2).join(" | ")}`);
  const w = want.map(([op, reason]) => `${op}/${reason}`).sort();
  if (JSON.stringify(pairs) !== JSON.stringify(w))
    problems.push(
      `unsupported ${JSON.stringify(pairs)} != ${JSON.stringify(w)}`,
    );
  return problems;
}

/** The applied.json `unsupported` names/reasons as op/reason pairs. */
export function appliedPairs(applied: AppliedJson | undefined): string[] {
  const list =
    (
      applied as
        | { unsupported?: { name?: string; reason?: string }[] }
        | undefined
    )?.unsupported ?? [];
  return [...new Set(list.map((u) => `${u.name}/${u.reason}`))].sort();
}

export interface G6aLegEntry {
  group: "g6a";
  expected_class: string;
  result_class: string | null;
  pixel_verdict?: string;
  expected_pixel_verdict?: string;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface Gate6aResult {
  checks: Gate6Check[];
  legs: Record<string, G6aLegEntry>;
  checkpoints: Gate6Checkpoint[];
  budgets: Record<string, RegionBudget6[]>;
  freshness: Record<string, Record<string, string[]>>;
  mismatch_tables: Record<string, Record<string, string[]>>;
  census: Record<string, string>;
}

function fromGate0(c: Gate0Check, id: string): Gate6Check {
  return { ...c, id, status: c.passed ? "pass" : "fail" } as Gate6Check;
}

async function readStepLog(dir: string): Promise<StepLine[] | undefined> {
  return parseStepLog(await readTextOrUndefined(join(dir, "steps.jsonl")));
}

/** Pure: a leg's steps.jsonl lists steps 0..11 at the model's applied and settle frames. */
export function evaluateStepLog6(
  e: Pick<Gate6Expected, "steps">,
  leg: string,
  got: StepLine[] | undefined,
): string[] {
  const want = e.steps.map((s) => ({
    step: s.step,
    applied_frame: s.applied_frame,
    settle_frame: s.settle_frame,
  }));
  return JSON.stringify(got) === JSON.stringify(want)
    ? []
    : [`${leg} steps.jsonl ${JSON.stringify(got)?.slice(0, 120)} != expected`];
}

async function requestedSeqs6(dir: string): Promise<number[]> {
  const text = (await readTextOrUndefined(join(dir, "env.txt"))) ?? "";
  const line = text
    .split("\n")
    .find((l) => l.startsWith("RS_RECEIVER_SHOT_SEQS="));
  return line
    ? line
        .slice("RS_RECEIVER_SHOT_SEQS=".length)
        .split(",")
        .filter((s) => s !== "")
        .map(Number)
    : [];
}

async function shotFiles6(
  dir: string,
  seqs: readonly number[],
): Promise<number[]> {
  const out: number[] = [];
  for (const s of seqs)
    if (await fileExists(join(dir, "shots", `seq-${s}.png`))) out.push(s);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export async function runGate6a(
  out: string,
  e: Gate6Expected,
): Promise<Gate6aResult> {
  const checks: Gate6Check[] = [];
  const legs: Record<string, G6aLegEntry> = {};
  const checkpoints: Gate6Checkpoint[] = [];
  const budgets: Record<string, RegionBudget6[]> = {};
  const freshness: Record<string, Record<string, string[]>> = {};
  const mismatchTables: Record<string, Record<string, string[]>> = {};
  const census: Record<string, string> = {};
  const r = refusedView(e);
  const rasters = new Map<string, Gate5Raster>();
  for (const s of e.shots) rasters.set(s.id, rasterOfShot(e, s));
  const refusedRasters = new Map<string, Gate5Raster>();
  for (const s of r.shots) refusedRasters.set(s.id, rasterOfShot(r, s));
  const S = join(out, G6A_DIRS.scene);
  const A = join(out, G6A_DIRS.animate);
  const R = join(out, G6A_DIRS.refused);

  // expected-self-consistent
  {
    const a = evaluateExpectedSelfConsistent(e, rasters);
    const b = evaluateExpectedSelfConsistent(r, refusedRasters);
    checks.push(
      check(
        "expected-self-consistent",
        "fixtures/gate6-scene/expected.json obeys its rules (both variants): 640x360; steps 0..11 at 1 + 10k (settle +7) with distinct marker colours; twelve settle shots and the intermediate frames 13, 53, 93; regions disjoint inside the viewport at every shot; every scene colour and texel on the 0.2 grid (theme boxes and feathers exempt); outside the regions only BG's panel, the clear colour or band; nothing but TL in the bottom strip before step 10; `fresh` as the raster and the undecided content say; SM's phase and PB's value as D6's formulas give them",
        [...a.problems, ...b.problems.map((p) => `refused: ${p}`)].slice(0, 10),
        a.detail,
        [join("fixtures", "gate6-scene", "expected.json")],
      ),
    );
  }

  // Captures: classification, decoding, sinks, ties, step logs.
  const caps = new Map<string, Gate3CaptureEvaluation>();
  for (const leg of G6A_LEGS.filter((l) => l.kind === "capture")) {
    const ev = await evaluateCapture(out, {
      legDir: leg.dir,
      expectedClass: "unsupported",
    });
    caps.set(leg.dir, ev);
    const want = leg.variant === "refused" ? r.unsupported : e.unsupported;
    const pairs = unsupportedPairs(ev.full);
    const problems = evaluateUnsupportedClass(ev, pairs, want);
    checks.push(
      check(
        `leg-class-${leg.leg}`,
        `the ${leg.leg} leg classifies unsupported with exactly ${want.map((w) => w.join("/")).join(", ")} on render-stream/5 (before G6b the HUD's CanvasLayer is extra-canvas): armed, stream closed, both sinks valid and equivalent, host size match, no capture failure`,
        problems,
        `${ev.result_class}: ${pairs.join(", ")}`,
        ev.artifacts,
      ),
    );
    legs[leg.leg] = {
      group: "g6a",
      expected_class: "unsupported",
      result_class: ev.result_class,
      reasons: ev.reasons,
      exit_code: ev.exit_code,
      artifacts: ev.artifacts,
    };
  }
  for (const dir of [
    "scene/sabotage-freeze/capture",
    "scene/sabotage-omit-transform/capture",
    "scene/sabotage-perturb-vertex/capture",
    "scene/sabotage-perturb-shader/capture",
  ]) {
    caps.set(
      dir,
      await evaluateCapture(out, { legDir: dir, expectedClass: "unsupported" }),
    );
  }
  const main = caps.get("scene/capture") as Gate3CaptureEvaluation;
  checks.push(fromGate0(await checkHeadlessNoGpuGate0(S), "headless-no-gpu"));
  checks.push({
    ...checkRecordingsDecode(main.full, main.patch),
    id: "recordings-decode",
  });
  checks.push({
    ...checkPatchResolvesToFull(main.full, main.patch),
    id: "patch-resolves-to-full",
  });
  {
    const problems: string[] = [];
    for (const [dir, leg] of [
      ["scene/capture", "capture-scene"],
      ["animate/capture", "capture-animate"],
      ["refused/capture", "capture-refused"],
      ["scene/reference", "reference-scene"],
      ["scene/reference-repeat", "reference-scene-repeat"],
      ["scene/reference-armed", "reference-scene-armed"],
      ["animate/reference", "reference-animate"],
      ["refused/reference", "reference-refused"],
    ] as const)
      problems.push(
        ...evaluateStepLog6(e, leg, await readStepLog(join(out, dir))),
      );
    checks.push(
      check(
        "step-log",
        "every capture's and reference's steps.jsonl lists steps 0..11 at frame 1 and 1 + 10k, settled 7 frames later (the file timeline, Q6c)",
        problems,
        "steps 0..11 at the model's frames on every leg",
        [],
      ),
    );
  }

  const full5 = await loadWire5(join(S, "capture", RECORDING_NAME));
  const patch5 = await loadWire5(join(S, "capture", PATCH_RECORDING_NAME));
  const names = nameIds6(full5.transactions, [
    ...e.creation_order,
    ...e.created_later.map((c) => c.name),
  ]);
  {
    const sinks = [
      { label: "capture-scene full", recording: main.full },
      { label: "capture-scene patch", recording: main.patch },
    ];
    for (const dir of [
      "animate/capture",
      "refused/capture",
      "scene/capture-inline",
    ]) {
      const ev = caps.get(dir);
      if (ev) sinks.push({ label: dir, recording: ev.full });
    }
    const t = evaluateNoTies6(sinks, names.ids);
    checks.push(
      check(
        "draw-index-tie",
        "no draw-index tie anywhere (no draw-index-tie entry, no tie by drawIndexTies on any capture sink), and at frame 1 the root canvas holds exactly Scene and TL with distinct draw indices: Q6b's predicted frame-1 tie does not occur (As built, G6a: both enter before the first iteration, so the deferred top-level raises land inside frame 1)",
        [...names.problems, ...t.problems].slice(0, 8),
        t.detail,
        [main.full.path],
      ),
    );
  }

  // References: the model, presence, freshness, budgets, oracle.
  const ref = await loadReferenceShots6(join(S, "reference"), e.shots);
  const repeat = await loadReferenceShots6(
    join(S, "reference-repeat"),
    e.shots,
  );
  const armed = await loadReferenceShots6(join(S, "reference-armed"), e.shots);
  const refRefused = await loadReferenceShots6(join(R, "reference"), r.shots);
  const refAnimate = await loadReferenceShots6(join(A, "reference"), e.shots);
  {
    const a = evaluateExpectedImage6(
      e,
      "reference-scene",
      e.shots,
      ref,
      rasters,
      join(S, "reference", "shots"),
    );
    const b = evaluateExpectedImage6(
      r,
      "reference-refused",
      r.shots,
      refRefused,
      refusedRasters,
      join(R, "reference", "shots"),
    );
    checkpoints.push(...a.checkpoints, ...b.checkpoints);
    const compared = [...a.checkpoints, ...b.checkpoints].reduce(
      (n, c) => n + (c.compared ?? 0),
      0,
    );
    const used = [...a.checkpoints, ...b.checkpoints].reduce(
      (n, c) => n + (c.delta1_used ?? 0),
      0,
    );
    checks.push(
      check(
        "expected-image-reference",
        "every reference shot (twelve settle shots and frames 13, 53, 93; reference-scene and reference-refused) equals the model on every decided pixel: exact where the raster is exact, within 1 where it allows delta 1 (translucent theme boxes, gradients, off-level texel products); band and undecided pixels (text, RT, RF) excluded, never relaxed",
        [...a.problems, ...b.problems].slice(0, 10),
        `${compared} decided pixels match over ${a.checkpoints.length + b.checkpoints.length} shots (${used} use delta 1)`,
        [join(S, "reference", "shots"), join(R, "reference", "shots")],
      ),
    );
    const p = evaluatePresence6("reference-scene", e.shots, ref, rasters);
    checks.push(
      check(
        "presence-reference",
        "every modelled shape of every reference shot (band shapes included) covers at least half its area with pixels that differ from what lies beneath it in the model",
        p.problems.slice(0, 8),
        `${p.shapes} shape-shots present`,
        [join(S, "reference", "shots")],
      ),
    );
    const f = evaluateFreshness6(e, "reference-scene", e.shots, ref);
    freshness["reference-scene"] = f.table;
    const sw = evaluateScrollWire(e, full5, names.ids);
    const fw = evaluateFreshWithoutRedraw6(e, full5, names.ids);
    checks.push(
      check(
        "freshness-reference",
        "between consecutive settle shots of the reference a region's pixels change exactly when expected.json says fresh; on the wire SC's step 1 and 5 are a transform of the content (R/L content versions unchanged, the scrollbar redrawn), TR is fresh at 3 through TEXA's new version with its commands identical, TL never changes before step 10",
        [...f.problems, ...sw.problems, ...fw.problems].slice(0, 10),
        Object.entries(f.table)
          .map(([k, v]) => `${k}:${v.join("+")}`)
          .join(" "),
        [join(S, "reference", "shots"), full5.path],
      ),
    );
    const rep = compareLegsBudget6(e.shots, ref, repeat, rasters, [
      "reference-scene",
      "reference-scene-repeat",
    ]);
    budgets["reference-repeat"] = rep.budgets;
    checks.push(
      check(
        "reference-repeat-budget",
        "reference-scene-repeat equals reference-scene on every pixel of every shot, per region and pixel class (the receiver budget is this measurement: 0, Q6g)",
        rep.problems.slice(0, 6),
        `0 of ${rep.budgets.reduce((n, b) => n + b.pixels, 0)} pixel-shots differ`,
        [join(S, "reference-repeat", "shots")],
      ),
    );
    const arm = compareLegsBudget6(e.shots, ref, armed, rasters, [
      "reference-scene",
      "reference-scene-armed",
    ]);
    checks.push(
      check(
        "armed-transparent",
        "reference-scene-armed (the capture extension armed with a full-sink stream in the rendered reference) equals reference-scene on every pixel of every shot",
        arm.problems.slice(0, 6),
        `0 of ${arm.budgets.reduce((n, b) => n + b.pixels, 0)} pixel-shots differ`,
        [join(S, "reference-armed", "shots")],
      ),
    );
  }
  const oracle = await loadOracle6(join(S, "reference"), "reference-scene");
  const oracleRepeat = await loadOracle6(
    join(S, "reference-repeat"),
    "reference-scene-repeat",
  );
  {
    const o = evaluateOracle6(e, [oracle, oracleRepeat]);
    const sw = evaluateScrollWire(e, patch5, names.ids);
    checks.push(
      check(
        "scroll-parity",
        "the oracle's SC v_scroll and content position (floored) equal expected.json `scroll` at every settle step on both reference legs, the RichTextLabel's line offsets, content height and scroll equal the model (its measured line height and scroll rule), and on both capture sinks the content Control's wire transform is the floored offset (0, -v_scroll) with SC clipping",
        [...o.problems, ...sw.problems].slice(0, 10),
        `${o.compared} oracle lines; v_scroll ${e.scroll.map((s) => s.v_scroll).join(",")}`,
        [oracle.path, oracleRepeat.path, full5.path, patch5.path],
      ),
    );
    const atlas = evaluateAtlasParity6(e, oracle, full5);
    const atlasPatch = evaluateAtlasParity6(e, oracle, patch5);
    checks.push(
      check(
        "atlas-parity",
        "at every settle step each atlas page the reference's oracle reads back (font_get_texture_image as a render-stream-texture/1 payload) is the hash of exactly one ok image texture in the capture's settle transaction, and every ok LA8 image there is an oracle page, on both sinks: the headless host's glyph atlases are byte-identical to the rendered reference's",
        [
          ...atlas.problems,
          ...atlasPatch.problems.map((p) => `patch: ${p}`),
        ].slice(0, 10),
        `${atlas.pages} page cells (${Object.entries(atlas.table)
          .map(([k, n]) => `${k}:${n}`)
          .join(" ")})`,
        [oracle.path, full5.path, patch5.path],
      ),
    );
    const pw = evaluateParamWire(e, full5, names.ids);
    const pwp = evaluateParamWire(e, patch5, names.ids);
    checks.push(
      check(
        "param-parity",
        "SM's and CM's material state agrees three ways at every settle step: the oracle's material_get_param (phase int, tint float32), shader_get_code GRP1 hash and CM blend mode equal the model (checked in scroll-parity's oracle comparison), and on both capture sinks SM's material carries the same phase and tint, its shader the model's GRP1 hash (source payload), and CM's material the builtin CanvasItemMaterial shader in the model's blend mode (add, sub from step 4)",
        [...pw.problems, ...pwp.problems.map((p) => `patch: ${p}`)].slice(
          0,
          10,
        ),
        `${pw.compared + pwp.compared} settle transactions`,
        [full5.path, patch5.path],
      ),
    );
    const le = evaluateLineEditGeometry(e, oracle, full5, names.ids.get("LE"));
    checks.push(
      check(
        "line-edit-geometry",
        "at every settle step the capture's LineEdit commands carry exactly the selection rects and caret rects the oracle derives from the rendered reference's own TextServer shaping (le.cpp's formulas), float32-equal: Q6b's \"selection rect and caret exact in position\" (the content box itself stays undecided)",
        le.problems.slice(0, 8),
        `${le.rects} rects equal the oracle's`,
        [oracle.path, full5.path],
      ),
    );
  }
  {
    const log = await loadResourceLog(join(S, "capture"));
    const counters = await readJson<CensusCounters>(
      join(S, "capture", "evidence", "counters.json"),
    );
    const hidden = hudHiddenFrames(full5, names.ids.get("HUDPanel"));
    const c = evaluateSceneCensus(
      e,
      log.lines,
      counters,
      hidden.filter((f) => f <= e.capture_quit_frame),
    );
    census["capture-scene"] = c.detail;
    const animate5 = await loadWire5(join(A, "capture", RECORDING_NAME));
    const animateNames = nameIds6(animate5.transactions, [
      ...e.creation_order,
      ...e.created_later.map((x) => x.name),
    ]);
    const alog = await loadResourceLog(join(A, "capture"));
    const acounters = await readJson<CensusCounters>(
      join(A, "capture", "evidence", "counters.json"),
    );
    const ac = evaluateSceneCensus(
      e,
      alog.lines,
      acounters,
      hudHiddenFrames(animate5, animateNames.ids.get("HUDPanel")),
      "animate",
    );
    census["capture-animate"] = ac.detail;
    checks.push(
      check(
        "scene-census",
        "the capture's hook log carries exactly the scene's own resource calls (make_expected.py's census): TEXN, TEXA, TEXB created at frame 1 with their predicted GRT1 hashes, TEXA updated to TEXA(1) at 31 and freed at 91 (animate: TEXA(3) at 30, TEXA(1) at 31, TEXA(4) at 60, TEXA(5) at 90, freed at 91), every other image the hue strip or an LA8 atlas page; MS created with 16 vertices and 42 indices and one vertex-region update per frame 1..111; SM's shader created at 1 with the predicted GRP1 hash and its parameter writes at the listed frames; CM's builtin add at 1 and sub at 41; one canvas created and attached, two canvas transforms, every item created; the HUD panel hidden on the wire exactly over 81..90",
        [
          ...(log.problem ? [`resources.jsonl: ${log.problem}`] : []),
          ...c.problems,
          ...ac.problems.map((p) => `animate: ${p}`),
          ...animateNames.problems,
        ].slice(0, 10),
        c.detail,
        [log.path, alog.path],
      ),
    );
  }

  // Receivers and sabotages.
  const vsRef: string[] = [];
  const vsRefDetail: string[] = [];
  for (const leg of G6A_LEGS.filter((l) => l.kind === "receiver")) {
    const view = leg.variant === "refused" ? r : e;
    const reference =
      leg.variant === "refused"
        ? refRefused
        : leg.variant === "animate"
          ? refAnimate
          : ref;
    const dir = join(out, leg.dir);
    const cap = caps.get(leg.capture as string);
    const recording =
      leg.sink === PATCH_RECORDING_NAME ? cap?.patch : cap?.full;
    const seqs = shotSeqs(view.shots, recording?.transactions ?? []);
    const shots = await loadReceiverShots6(dir, view.shots, seqs);
    const exclude = excludedRegions(leg.variant);
    const diffs = compareShots6(view.shots, reference, shots, exclude);
    const applied = await readJson<AppliedJson>(join(dir, "applied.json"));
    const requested = await requestedSeqs6(dir);
    const cps: Checkpoint[] = diffs.map((d) => ({
      step: Number(d.shot.replace(/^\D+/, "")),
      settle_frame: view.shots.find((s) => s.id === d.shot)?.frame ?? 0,
      seq: seqs.get(d.shot) ?? null,
      reference_png: join(
        out,
        leg.variant === "refused"
          ? "refused"
          : leg.variant === "animate"
            ? "animate"
            : "scene",
        "reference",
        "shots",
        `${d.shot}.png`,
      ),
      receiver_png: join(dir, "shots", `seq-${seqs.get(d.shot)}.png`),
      diff_png: null,
      mismatched_pixels: d.diff?.mismatched ?? null,
      max_channel_delta: d.diff?.max_delta ?? null,
      regions: [],
    }));
    const cls = cap
      ? classifyLeg({
          captureResult: cap.captureResult,
          recording: recording as RecordingSummary,
          receiver: {
            applied,
            requestedShotSeqs: requested,
            shotFiles: await shotFiles6(dir, requested),
          },
          checkpoints: cps,
        })
      : {
          result_class: "capture-failure",
          reasons: ["no capture"],
          mismatching_steps: [],
          harmless_ties: [],
        };
    const want = leg.variant === "refused" ? r.unsupported : e.unsupported;
    const problems = evaluateUnsupportedClass(
      cls,
      recording ? unsupportedPairs(recording) : [],
      want,
    );
    const ap = appliedPairs(applied);
    const wantAp = want.map(([op, reason]) => `${op}/${reason}`).sort();
    if (JSON.stringify(ap) !== JSON.stringify(wantAp))
      problems.push(
        `applied.json unsupported ${JSON.stringify(ap)} != ${JSON.stringify(wantAp)}`,
      );
    const pv = evaluatePixelVerdict(
      diffs,
      leg.pixel ?? "success",
      leg.prediction ? e.predictions[leg.prediction]?.shots : undefined,
    );
    problems.push(...pv.problems);
    mismatchTables[leg.leg] = pv.table;
    const totalHu = diffs.reduce((n, d) => n + (d.diff?.excluded.HU ?? 0), 0);
    checks.push(
      check(
        `leg-class-${leg.leg}`,
        leg.pixel === "pixel-mismatch"
          ? `the ${leg.leg} leg classifies unsupported (exactly the capture's /5 reasons, also in applied.json) and, outside ${[...exclude].join(" and ")}, differs from the reference at exactly expected.json predictions["${leg.prediction}"]'s regions per shot`
          : `the ${leg.leg} leg (rendered receiver on ${leg.capture}/${leg.sink}) classifies unsupported with exactly the capture's /5 reasons (also in applied.json), applied every seq, and every pixel outside ${[...exclude].join(" and ")} of every shot equals the reference`,
        problems.slice(0, 8),
        `${cls.result_class}, pixels ${pv.verdict} (HU differs in ${totalHu} pixel-shots, not compared)`,
        [join(dir, "applied.json"), join(dir, "shots")],
      ),
    );
    legs[leg.leg] = {
      group: "g6a",
      expected_class: "unsupported",
      result_class: cls.result_class,
      pixel_verdict: pv.verdict,
      expected_pixel_verdict: leg.pixel,
      reasons: cls.reasons,
      exit_code: await readExitCode(dir),
      artifacts: [join(dir, "applied.json"), join(dir, "shots")],
    };
    if (leg.pixel === "success") {
      for (const d of diffs)
        if (d.diff && d.diff.mismatched > 0)
          vsRef.push(
            `${leg.leg} ${d.shot}: ${d.diff.mismatched} pixels (${Object.entries(
              d.diff.regions,
            )
              .map(([k, v]) => `${k} ${v}`)
              .join(", ")})`,
          );
        else if (!d.diff) vsRef.push(`${leg.leg} ${d.shot}: missing`);
      // What the exclusion hides is exactly the HUD layer the /5 receiver cannot draw: HU differs
      // in the HUD panel's 168x28 pixels while the HUD is visible above the root canvas, and
      // nowhere at steps 8 (hidden) and 9 (behind BG).
      for (const d of diffs) {
        const shot = view.shots.find((x) => x.id === d.shot);
        const hud = view.steps[shot?.step ?? 0]?.oracle.hud;
        const want = hud?.visible && hud.layer > 0 ? HUD_PANEL_PIXELS : 0;
        const got = d.diff?.excluded.HU ?? 0;
        if (d.diff && got !== want)
          vsRef.push(
            `${leg.leg} ${d.shot}: HU differs in ${got} pixels, expected exactly the HUD panel's ${want}`,
          );
      }
      vsRefDetail.push(
        `${leg.leg} ${diffs.reduce((n, d) => n + (d.diff?.compared ?? 0), 0)}`,
      );
    }
  }
  checks.push(
    check(
      "receiver-vs-reference",
      "receiver-scene, -patch, -inline, receiver-animate and receiver-refused: every pixel of every shot (settle and intermediate) equals its reference's, raw per channel with alpha, outside HU (the HUD's CanvasLayer is not carried before G6b) and, in refused, RF; budget 0 (Q6g); inside HU they differ in exactly the HUD panel's 168x28 pixels while the HUD shows above the root canvas and nowhere at steps 8 and 9",
      vsRef.slice(0, 10),
      `pixels compared: ${vsRefDetail.join(", ")}`,
      G6A_LEGS.filter((l) => l.pixel === "success").map((l) =>
        join(out, l.dir, "shots"),
      ),
    ),
  );

  return {
    checks,
    legs,
    checkpoints,
    budgets,
    freshness,
    mismatch_tables: mismatchTables,
    census,
  };
}
