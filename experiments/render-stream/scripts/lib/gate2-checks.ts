// Gate 2 checks and leg classification (protocol/gate2-design.md "Q7", "G2a" and "G2b2").
//
// Everything here reads an evidence directory written by run-gate2.sh, or is pure over values
// already read from one, so scripts/test/self-test-gate2.ts can drive it with fabricated trees.
// Nothing launches a process. Classification never reads `session.sabotage`.
//
// Group g2a: the evidence of what happened to textures is the capture's hook log,
// evidence/resources.jsonl (render-stream-resource-log/1, capture/src/rs_resource_log.h), checked
// against the fixture's own texture log (RS_FIXTURE_TEXTURE_LOG, hashed by fixtures/gate2/
// payload.gd) and against expected.json's census. Since G2b2 the recordings are render-stream/2:
// texture draws are real commands, so the capture leg classifies success. Group g2b
// (receivers, store, inline, live inline, sabotages) lives in gate2b-checks.ts.
//
// Evidence layout under <out>/ (see scripts/README.md "Gate 2"):
//   legs.json, binary.json
//   import/fixture/                editor --import of fixtures/gate2
//   capture/                       400-frame capture host, GRC_ROOT_SIZE=enforce-min-size:
//                                  evidence/ (result, counters, root, resources.jsonl, ...),
//                                  recording.rs2, recording-patch.rs2, store/, steps.jsonl,
//                                  textures.jsonl, strace.txt, maps.txt
//   capture-unsupported/           the same with RS_FIXTURE_VARIANT=unsupported (default quit)
//   reference/, reference-repeat/  rendered fixture, extension absent: shots/step-<k>.png,
//                                  steps.jsonl, textures.jsonl
//   reference-armed/               rendered fixture, extension armed with a full-sink stream:
//                                  the same plus evidence/, recording.rs2 and store/

import { join } from "node:path";
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
  diffRgba,
  firstTransactionWithRectColor,
  type Gate0Check,
  loadRecording,
  parseStepLog,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
  type StepLine,
} from "./gate0-checks";
import {
  type Gate2Expected,
  gate2Regions,
  type Rect4,
  stepFrames2,
  stepOfFrame,
  synthesizeGate2,
} from "./gate2-expected";
import { type G2bCheckpoint, type G2bResources, runG2b } from "./gate2b-checks";
import {
  type AnimateCounts,
  type G2cCheckpoint,
  type G2cHostNumbers,
  runG2c,
} from "./gate2c-checks";

// ---------------------------------------------------------------------------------------------
// Constants of the contract
// ---------------------------------------------------------------------------------------------

/** The capture leg's quit frame: one transaction per frame, so 400 transactions. */
export const G2A_CAPTURE_QUIT_FRAME = 400;

/** gate2-design.md Q7 "Class precedence": gate 1's classes plus resource-violation. */
export type Gate2Class =
  | "capture-failure"
  | "unsupported"
  | "replay-failure"
  | "delivery-violation"
  | "resource-violation"
  | "pixel-mismatch"
  | "success";

export const GATE2_CLASS_PRECEDENCE: readonly Gate2Class[] = [
  "capture-failure",
  "unsupported",
  "replay-failure",
  "delivery-violation",
  "resource-violation",
  "pixel-mismatch",
  "success",
];

export const ALL_GROUPS = ["g2a", "g2b", "g2c", "g2d", "g2e"] as const;
export const LANDED_GROUPS: readonly string[] = ["g2a", "g2b", "g2c"];

/** Legs with an expected class. G2a has one: the capture, which since G2b2 (render-stream/2)
 * carries its texture draws as real commands and classifies success. */
export const G2A_CLASSIFIED_LEGS = ["capture"] as const;
export type G2aLeg = (typeof G2A_CLASSIFIED_LEGS)[number];

export const G2A_SUPPORT_LEGS = [
  "import",
  "capture-unsupported",
  "reference",
  "reference-repeat",
  "reference-armed",
] as const;

/** The two texture-rect draws the gate 2 fixture makes (render-stream/2 commands since G2b2). */
export const TEXTURE_DRAW_OPS: readonly string[] = [
  "canvas_item_add_texture_rect",
  "canvas_item_add_texture_rect_region",
];

/** RenderingServer texture calls the hook log records (Q3 "Hook log"). */
export const RESOURCE_LOG_OPS: readonly string[] = [
  "canvas_item_set_default_texture_filter",
  "canvas_item_set_default_texture_repeat",
  "canvas_texture_create",
  "canvas_texture_set_channel",
  "canvas_texture_set_texture_filter",
  "canvas_texture_set_texture_repeat",
  "free",
  "texture_2d_create",
  "texture_2d_placeholder_create",
  "texture_2d_update",
  "texture_replace",
  "viewport_set_default_canvas_item_texture_filter",
  "viewport_set_default_canvas_item_texture_repeat",
];

/** Exact key order of a render-stream-resource-log/1 line (the contract's keys, then G2a's). Since
 * G2b2 a sabotage's own line appends `sabotage` (and `omitted` for an op the omit-op sabotage
 * dropped from the capture), and the publisher writes `store` / `inline` lines. */
export const RESOURCE_LINE_KEYS: readonly string[] = [
  "frame",
  "t_us",
  "thread",
  "op",
  "id",
  "by_id",
  "rid",
  "version",
  "kind",
  "status",
  "reason",
  "format",
  "width",
  "height",
  "mipmaps",
  "data_bytes",
  "payload_bytes",
  "hash",
  "copy_ns",
  "hash_ns",
  "conn",
  "http_status",
  "target",
  "ref_id",
  "value",
  "layer",
  "root_viewport",
];

// Viewport.DefaultCanvasItemTextureFilter / _Repeat scene enums (root.json texture_defaults), and
// the RS enums the viewport setters carry (servers/rendering_server.h:925-942).
const SCENE_FILTER: Record<string, number> = {
  nearest: 0,
  linear: 1,
  linear_mipmaps: 2,
  nearest_mipmaps: 3,
};
const SCENE_REPEAT: Record<string, number> = {
  disabled: 0,
  enabled: 1,
  mirror: 2,
};

// ---------------------------------------------------------------------------------------------
// Evidence types and parsing
// ---------------------------------------------------------------------------------------------

/** One line of evidence/resources.jsonl. */
export interface ResourceLine {
  frame: number;
  t_us: number;
  thread: "main" | "other";
  op: string;
  id: number | null;
  by_id: number | null;
  rid: string | null;
  version: number | null;
  kind: string | null;
  status: string | null;
  reason: string | null;
  format: string | null;
  width: number | null;
  height: number | null;
  mipmaps: boolean | null;
  data_bytes: number | null;
  payload_bytes: number | null;
  hash: string | null;
  copy_ns: number | null;
  hash_ns: number | null;
  conn: number | null;
  http_status: number | null;
  target: string | null;
  ref_id: number | null;
  value: number | null;
  layer: number | null;
  root_viewport: boolean | null;
  /** G2b2: a sabotage's own line; `omitted` for an op the omit-op sabotage dropped */
  sabotage?: boolean;
  omitted?: boolean;
}

/** A hook-log line that is a RenderingServer call the engine made: not a publisher event and not
 * a sabotage's own line (census and the copy checks count only these). */
export function engineCall(line: ResourceLine): boolean {
  return !PUBLISHER_LOG_OPS.includes(line.op) && line.sabotage !== true;
}

/** One line of the fixture's RS_FIXTURE_TEXTURE_LOG. */
export interface FixtureTextureLine {
  step: number;
  frame: number;
  op: string;
  name: string;
  thread: "main" | "other";
  format: string | null;
  width: number | null;
  height: number | null;
  mipmaps: boolean | null;
  data_bytes: number | null;
  payload_sha256: string | null;
}

/** Parsed JSONL, or the problem that stopped it (an empty file is an empty list). */
export function parseJsonl<T>(
  text: string | undefined,
  validate: (value: unknown) => string | null,
): { lines: T[]; problem: string | null } {
  if (text === undefined) return { lines: [], problem: "missing" };
  const lines: T[] = [];
  const raw = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = 0; i < raw.length; i++) {
    let value: unknown;
    try {
      value = JSON.parse(raw[i]);
    } catch {
      return { lines, problem: `line ${i + 1} is not JSON` };
    }
    const why = validate(value);
    if (why) return { lines, problem: `line ${i + 1}: ${why}` };
    lines.push(value as T);
  }
  return { lines, problem: null };
}

/** The publisher's own hook-log ops (G2b2: store, inline; G2c2: the live serving lines pin,
 * retire and http-get): not RenderingServer calls, never in a census. */
export const PUBLISHER_LOG_OPS: readonly string[] = [
  "store",
  "inline",
  "pin",
  "retire",
  "http-get",
];

export function validateResourceLine(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "not an object";
  const keys = Object.keys(value);
  const trailing = keys.slice(RESOURCE_LINE_KEYS.length);
  if (
    keys.slice(0, RESOURCE_LINE_KEYS.length).join(",") !==
      RESOURCE_LINE_KEYS.join(",") ||
    !["", "sabotage", "sabotage,omitted"].includes(trailing.join(","))
  )
    return `keys ${keys.join(",")} are not render-stream-resource-log/1's, in order`;
  const v = value as ResourceLine;
  if (!Number.isInteger(v.frame) || v.frame < 1) return "frame";
  if (v.thread !== "main" && v.thread !== "other") return "thread";
  if (!RESOURCE_LOG_OPS.includes(v.op) && !PUBLISHER_LOG_OPS.includes(v.op))
    return `unknown op ${v.op}`;
  if (v.hash !== null && !/^[0-9a-f]{64}$/.test(v.hash)) return "hash";
  return null;
}

export function validateFixtureLine(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "not an object";
  const v = value as FixtureTextureLine;
  if (!Number.isInteger(v.step) || !Number.isInteger(v.frame))
    return "step/frame";
  if (typeof v.op !== "string" || typeof v.name !== "string") return "op/name";
  if (v.thread !== "main" && v.thread !== "other") return "thread";
  if (v.payload_sha256 !== null && !/^[0-9a-f]{64}$/.test(v.payload_sha256))
    return "payload_sha256";
  return null;
}

export async function loadResourceLog(dir: string) {
  const path = join(dir, "evidence", "resources.jsonl");
  return {
    path,
    ...parseJsonl<ResourceLine>(
      await readTextOrUndefined(path),
      validateResourceLine,
    ),
  };
}

export async function loadFixtureLog(dir: string) {
  const path = join(dir, "textures.jsonl");
  return {
    path,
    ...parseJsonl<FixtureTextureLine>(
      await readTextOrUndefined(path),
      validateFixtureLine,
    ),
  };
}

/** The census key of a hook-log line: the op, `@other` off the main thread. */
export function censusKey(line: Pick<ResourceLine, "op" | "thread">): string {
  return line.thread === "main" ? line.op : `${line.op}@other`;
}

export interface CensusResult {
  per_step: Record<string, Record<string, number>>;
  /** lines after the quit frame (scene teardown at exit), by op */
  after_quit: Record<string, number>;
}

/** Counts hook-log lines per step window ([applied_k, applied_{k+1}), the last through quit). */
export function censusOf(
  lines: readonly ResourceLine[],
  expected: Gate2Expected,
  quit: number,
): CensusResult {
  const per_step: Record<string, Record<string, number>> = {};
  for (const s of expected.steps) per_step[s.step] = {};
  const after_quit: Record<string, number> = {};
  for (const line of lines) {
    if (!engineCall(line)) continue;
    const step = stepOfFrame(expected, line.frame, quit);
    const key = censusKey(line);
    const bucket = step < 0 ? after_quit : per_step[step];
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
  const sorted = (r: Record<string, number>) =>
    Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    per_step: Object.fromEntries(
      Object.entries(per_step).map(([k, v]) => [k, sorted(v)]),
    ),
    after_quit: sorted(after_quit),
  };
}

/** A step's expected census, with a variant's extras added (a null extra is one per frame of the
 * step's window). */
export function expectedCensus(
  expected: Gate2Expected,
  step: number,
  quit: number,
  variant?: "animate" | "unsupported",
): Record<string, number> {
  const out: Record<string, number> = {
    ...(expected.steps.find((s) => s.step === step)?.census ?? {}),
  };
  if (variant) {
    const extra =
      expected.variants[variant].steps.find((s) => s.step === step)
        ?.census_extra ?? {};
    const from = stepFrames2(expected, step).applied;
    const to =
      step < expected.last_step
        ? stepFrames2(expected, step + 1).applied - 1
        : quit;
    for (const [op, count] of Object.entries(extra)) {
      out[op] = (out[op] ?? 0) + (count ?? to - from + 1);
    }
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

export type Gate2Check = Gate0Check & { status: "pass" | "fail" | "not-run" };

export function check(
  id: string,
  criterion: string,
  problems: string[],
  okDetail: string,
  evidence: string[],
): Gate2Check {
  return {
    id,
    criterion,
    passed: problems.length === 0,
    status: problems.length === 0 ? "pass" : "fail",
    detail: problems.length === 0 ? okDetail : problems.join("; "),
    evidence,
  };
}

function fromGate0(c: Gate0Check, criterion?: string): Gate2Check {
  return {
    ...c,
    criterion: criterion ?? c.criterion,
    status: c.passed ? "pass" : "fail",
  };
}

const LEVELS = new Set([0, 51, 102, 153, 204, 255]);

function inside(r: readonly number[], outer: readonly number[]): boolean {
  return (
    r[0] >= outer[0] &&
    r[1] >= outer[1] &&
    r[0] + r[2] <= outer[0] + outer[2] &&
    r[1] + r[3] <= outer[1] + outer[3]
  );
}

function overlaps(a: readonly number[], b: readonly number[]): boolean {
  return (
    a[0] < b[0] + b[2] &&
    b[0] < a[0] + a[2] &&
    a[1] < b[1] + b[3] &&
    b[1] < a[1] + a[3]
  );
}

/** expected.json obeys its own rules (gate2-design.md Q6 "Colour rule", layout, timeline). */
export function checkExpectedSelfConsistent(
  expected: Gate2Expected,
): Gate2Check {
  const problems: string[] = [];
  const [w, h] = expected.viewport ?? [];
  if (expected.schema !== "render-stream-gate2-expected/1")
    problems.push(`schema=${JSON.stringify(expected.schema)}`);
  if (w !== 640 || h !== 360)
    problems.push(`viewport=${JSON.stringify(expected.viewport)}`);
  const S = expected.start_frame_default;
  const N = expected.step_frames_default;
  const last = expected.last_step;
  if (expected.settle_offset !== 7) problems.push("settle_offset is not 7");
  if (!(N > expected.settle_offset))
    problems.push("step_frames_default <= settle_offset");
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
  // Texture contents: every texel component is k*51; alpha is 0 or 1 unless a draw sampling it
  // lies in an excluded region.
  const partialAlpha = new Set<string>();
  for (const [name, t] of Object.entries(expected.textures ?? {})) {
    const colors = [
      ...(t.fill ? [t.fill] : []),
      ...(t.rects ?? []).map((r) => r.slice(4, 8)),
      ...(t.checker ? [t.checker.even, t.checker.odd] : []),
      ...(t.frame_fill ?? []),
    ];
    if (colors.length === 0) problems.push(`texture ${name} has no content`);
    for (const c of colors) {
      if (c.length !== 4 || !c.every((v) => LEVELS.has(v)))
        problems.push(
          `texture ${name} colour ${c.join(",")} breaks the colour rule`,
        );
      if (c[3] !== 0 && c[3] !== 255) partialAlpha.add(name);
    }
  }
  const markerColors = new Set<string>();
  const otherColors = new Set<string>();
  for (const step of steps) {
    const regions = step.regions ?? {};
    for (const name of step.synth_exclude ?? [])
      if (!(name in regions))
        problems.push(
          `step ${step.step}: synth_exclude names unknown region ${name}`,
        );
    const excluded = (step.synth_exclude ?? [])
      .map((n) => regions[n])
      .filter(Boolean);
    for (const d of step.draws) {
      const r = d.rect_px;
      if (!Object.values(regions).some((reg) => inside(r, reg)))
        problems.push(
          `step ${step.step}: ${d.name} ${r.join(",")} lies outside every region`,
        );
      if (overlaps(r, expected.empty_region))
        problems.push(
          `step ${step.step}: ${d.name} draws in ${expected.empty_region.join(",")}`,
        );
      if (d.rgba8) {
        if (!d.rgba8.every((v) => LEVELS.has(v)) || d.rgba8[3] !== 255)
          problems.push(
            `step ${step.step}: ${d.name} rgba8 ${d.rgba8.join(",")} breaks the colour rule`,
          );
        (d.name === "Marker" ? markerColors : otherColors).add(
          d.rgba8.join(","),
        );
      } else if (d.sample) {
        const s = d.sample;
        if (!(s.texture in (expected.textures ?? {})))
          problems.push(
            `step ${step.step}: ${d.name} samples unknown texture ${s.texture}`,
          );
        if (!s.modulate.every((v) => v === 0 || v === 255))
          problems.push(
            `step ${step.step}: ${d.name} modulate ${s.modulate.join(",")} is not 0/1`,
          );
        if (
          partialAlpha.has(s.texture) &&
          !excluded.some((reg) => inside(r, reg))
        )
          problems.push(
            `step ${step.step}: ${d.name} samples semi-transparent ${s.texture} outside synth_exclude`,
          );
      } else {
        problems.push(
          `step ${step.step}: ${d.name} has neither sample nor rgba8`,
        );
      }
    }
    const markers = step.draws.filter((d) => d.name === "Marker");
    if (
      markers.length !== 1 ||
      markers[0].rgba8?.join(",") !== step.marker_rgba8.join(",")
    )
      problems.push(
        `step ${step.step}: the Marker draw does not carry marker_rgba8`,
      );
    for (const [op, count] of Object.entries(step.census ?? {})) {
      const base = op.replace(/@other$/, "");
      if (
        !RESOURCE_LOG_OPS.includes(base) ||
        !Number.isInteger(count) ||
        count < 1
      )
        problems.push(`step ${step.step}: census ${op}=${count}`);
    }
    for (const inv of step.invariants ?? []) {
      const textures = [
        ...("texture" in inv ? [inv.texture] : []),
        ...("textures" in inv ? inv.textures : []),
      ];
      for (const t of textures)
        if (
          !(t in (expected.texture_objects ?? {})) &&
          !expected.items_at_ready.includes(t)
        )
          problems.push(
            `step ${step.step}: invariant names unknown texture ${t}`,
          );
      if ("item" in inv && !expected.items_at_ready.includes(inv.item))
        problems.push(
          `step ${step.step}: invariant names unknown item ${inv.item}`,
        );
    }
  }
  if (markerColors.size !== steps.length)
    problems.push(
      `${markerColors.size} distinct marker colours for ${steps.length} steps`,
    );
  for (const c of markerColors)
    if (otherColors.has(c))
      problems.push(`marker colour ${c} is also drawn by another add_rect`);
  return check(
    "expected-self-consistent",
    `expected.json obeys its rules: 640x360, steps 0..${last}, every texel and flat colour component in {0,51,..,255}, modulates 0/1, semi-transparent contents only inside synth_exclude, every synth_exclude a named region, every draw inside a region and none in ${JSON.stringify(expected.empty_region)}, one distinct marker colour per step that no other flat draw uses, census ops known`,
    problems,
    `${steps.length} steps, ${steps.reduce((n, s) => n + s.draws.length, 0)} draws, ${Object.keys(expected.textures ?? {}).length} texture contents, ${steps.reduce((n, s) => n + Object.values(s.census).reduce((a, b) => a + b, 0), 0)} census calls consistent`,
    [],
  );
}

export async function checkStepAlignment(
  outDir: string,
  expected: Gate2Expected,
  recording: RecordingSummary,
): Promise<Gate2Check> {
  const want: StepLine[] = expected.steps.map((s) => {
    const f = stepFrames2(expected, s.step);
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
    const applied = stepFrames2(expected, s.step).applied;
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

/** Pixels that differ outside `excluded`, and the largest channel delta among them. */
function diffOutside(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  excluded: readonly Rect4[],
): {
  mismatched_pixels: number;
  max_channel_delta: number;
  first: string | null;
} {
  let mismatched = 0;
  let maxDelta = 0;
  let first: string | null = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (
        excluded.some(
          ([rx, ry, rw, rh]) =>
            x >= rx && x < rx + rw && y >= ry && y < ry + rh,
        )
      )
        continue;
      const i = (y * width + x) * 4;
      let d = 0;
      for (let c = 0; c < 4; c++)
        d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
      if (d > 0) {
        mismatched++;
        maxDelta = Math.max(maxDelta, d);
        first ??= `(${x},${y}) ${[...a.subarray(i, i + 4)].join(",")} vs ${[...b.subarray(i, i + 4)].join(",")}`;
      }
    }
  }
  return { mismatched_pixels: mismatched, max_channel_delta: maxDelta, first };
}

export interface Gate2Checkpoint {
  leg: string;
  step: number;
  shot: string;
  /** pixels differing from synthesizeGate2 outside synth_exclude; null when unreadable */
  mismatched_pixels: number | null;
  max_channel_delta: number | null;
  excluded: string[];
}

export async function checkExpectedImageReference(
  outDir: string,
  expected: Gate2Expected,
): Promise<{ check: Gate2Check; checkpoints: Gate2Checkpoint[] }> {
  const problems: string[] = [];
  const checkpoints: Gate2Checkpoint[] = [];
  const paths: string[] = [];
  for (const s of expected.steps) {
    const shot = join(outDir, "reference", "shots", `step-${s.step}.png`);
    paths.push(shot);
    const got = await decodePngRgba(shot);
    const want = synthesizeGate2(expected, s.step);
    const regions = gate2Regions(expected, s.step);
    const cp: Gate2Checkpoint = {
      leg: "reference",
      step: s.step,
      shot,
      mismatched_pixels: null,
      max_channel_delta: null,
      excluded: s.synth_exclude,
    };
    checkpoints.push(cp);
    if (!got) {
      problems.push(`step ${s.step}: ${shot} missing or unreadable`);
      continue;
    }
    if (got.width !== want.width || got.height !== want.height) {
      problems.push(
        `step ${s.step}: ${got.width}x${got.height}, expected ${want.width}x${want.height}`,
      );
      continue;
    }
    const d = diffOutside(
      want.rgba,
      got.data,
      want.width,
      want.height,
      s.synth_exclude.map((n) => regions[n]),
    );
    cp.mismatched_pixels = d.mismatched_pixels;
    cp.max_channel_delta = d.max_channel_delta;
    if (d.mismatched_pixels > 0)
      problems.push(
        `step ${s.step}: ${d.mismatched_pixels} pixels differ from synthesizeGate2 outside synth_exclude (max channel delta ${d.max_channel_delta}; first ${d.first})`,
      );
  }
  return {
    check: check(
      "expected-image-reference",
      `each reference/shots/step-<k>.png (k = 0..${expected.last_step}) equals synthesizeGate2(k) exactly (maxChannelDelta 0) everywhere outside the step's synth_exclude regions`,
      problems,
      `${paths.length} reference shots match exactly outside ${expected.steps.reduce((n, s) => n + s.synth_exclude.length, 0)} excluded step-regions`,
      paths,
    ),
    checkpoints,
  };
}

export interface RegionBudget {
  step: number;
  region: string;
  max_channel_delta: number;
  mismatched_pixels: number;
}

/** reference vs reference-repeat, per region per step. The measured maxima are the budget the
 * synth_exclude regions get from G2b on (expected 0: same build, GPU and driver). */
export async function checkReferenceRepeatBudget(
  outDir: string,
  expected: Gate2Expected,
): Promise<{ check: Gate2Check; budget: RegionBudget[] }> {
  const problems: string[] = [];
  const budget: RegionBudget[] = [];
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
    const regions = gate2Regions(expected, s.step);
    for (const [name, rect] of Object.entries(regions)) {
      const d = diffRgba(ia.data, ib.data, ia.width, ia.height, rect);
      budget.push({
        step: s.step,
        region: name,
        max_channel_delta: d.max_channel_delta,
        mismatched_pixels: d.mismatched_pixels,
      });
    }
    // Outside the synth_exclude regions any difference would be a failure of the synthesis
    // check too; the budget only ever covers excluded regions.
    const outside = diffOutside(
      ia.data,
      ib.data,
      ia.width,
      ia.height,
      s.synth_exclude.map((n) => regions[n]),
    );
    if (outside.mismatched_pixels > 0)
      problems.push(
        `step ${s.step}: reference and reference-repeat differ outside synth_exclude in ${outside.mismatched_pixels} pixels (first ${outside.first})`,
      );
  }
  const nonZero = budget.filter((b) => b.mismatched_pixels > 0);
  return {
    check: check(
      "reference-repeat-budget",
      "reference vs reference-repeat (same build, GPU, driver): identical outside synth_exclude; inside, the measured per-region maximum channel delta and pixel count are recorded as the budget later increments use unchanged (expected 0)",
      problems,
      nonZero.length === 0
        ? `budget 0 everywhere (${budget.length} step-regions identical)`
        : `non-zero budget in ${nonZero.map((b) => `step ${b.step} ${b.region} (${b.mismatched_pixels} px, max ${b.max_channel_delta})`).join(", ")}`,
      paths,
    ),
    budget,
  };
}

export async function checkArmedTransparent(
  outDir: string,
  expected: Gate2Expected,
): Promise<Gate2Check> {
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
    "reference-armed (extension armed, stream on, copy and hash at the hook active) armed with its stream closed, and every shot equals reference's exactly (full frame): the hooks forward untouched",
    problems,
    `${expected.steps.length} armed shots byte-identical to the reference`,
    paths,
  );
}

interface LogEvidence {
  leg: string;
  quit: number;
  log: Awaited<ReturnType<typeof loadResourceLog>>;
}

async function hookLogs(
  outDir: string,
  expected: Gate2Expected,
): Promise<LogEvidence[]> {
  return [
    {
      leg: "capture",
      quit: G2A_CAPTURE_QUIT_FRAME,
      log: await loadResourceLog(join(outDir, "capture")),
    },
    {
      leg: "reference-armed",
      quit: expected.quit_frame_default,
      log: await loadResourceLog(join(outDir, "reference-armed")),
    },
  ];
}

export async function checkCensus(
  outDir: string,
  expected: Gate2Expected,
): Promise<{ check: Gate2Check; census: Record<string, CensusResult> }> {
  const problems: string[] = [];
  const census: Record<string, CensusResult> = {};
  const logs = await hookLogs(outDir, expected);
  for (const { leg, quit, log } of logs) {
    if (log.problem) {
      problems.push(`${leg} resources.jsonl ${log.problem}`);
      continue;
    }
    const got = censusOf(log.lines, expected, quit);
    census[leg] = got;
    for (const s of expected.steps) {
      const want = expectedCensus(expected, s.step, quit);
      const have = got.per_step[s.step] ?? {};
      if (JSON.stringify(have) !== JSON.stringify(want))
        problems.push(
          `${leg} step ${s.step}: census ${JSON.stringify(have)}, expected ${JSON.stringify(want)}`,
        );
    }
    // After the quit frame only the scene teardown's frees may appear.
    for (const op of Object.keys(got.after_quit))
      if (op !== "free") problems.push(`${leg}: ${op} after the quit frame`);
  }
  const capture = census.capture;
  return {
    check: check(
      "census",
      "per step (frame windows [S+N*k, S+N*(k+1)), the last through the quit frame), the hook log's texture calls -- op, count and thread, the item filter/repeat calls on tree entry included -- equal expected.json census exactly, in the capture and in reference-armed; after the quit frame only teardown frees",
      problems,
      capture
        ? `${expected.steps.map((s) => `${s.step}:${Object.values(capture.per_step[s.step] ?? {}).reduce((a, b) => a + b, 0)}`).join(" ")} calls per step; teardown ${JSON.stringify(capture.after_quit)}`
        : "",
      logs.map((l) => l.log.path),
    ),
    census,
  };
}

/** Hook creates/updates that carry content, with the fixture or engine line each one matches. */
export async function checkHookBytesExact(
  outDir: string,
  expected: Gate2Expected,
): Promise<Gate2Check> {
  const problems: string[] = [];
  const evidence: string[] = [];
  let matched = 0;
  for (const leg of ["capture", "reference-armed"]) {
    const hooks = await loadResourceLog(join(outDir, leg));
    const fixture = await loadFixtureLog(join(outDir, leg));
    evidence.push(hooks.path, fixture.path);
    if (hooks.problem || fixture.problem) {
      problems.push(
        `${leg}: resources.jsonl ${hooks.problem ?? "ok"}, textures.jsonl ${fixture.problem ?? "ok"}`,
      );
      continue;
    }
    const contentOps = new Set(["texture_2d_create", "texture_2d_update"]);
    const hookLines = hooks.lines.filter(
      (l) => contentOps.has(l.op) && engineCall(l),
    );
    const fixtureLines = fixture.lines.filter(
      (l) =>
        contentOps.has(l.op) &&
        l.format !== null &&
        expected.permitted_formats.includes(l.format),
    );
    const used = new Set<number>();
    for (const f of fixtureLines) {
      const i = hookLines.findIndex(
        (h, j) =>
          !used.has(j) &&
          h.op === f.op &&
          h.frame === f.frame &&
          h.thread === f.thread &&
          h.hash === f.payload_sha256,
      );
      if (i < 0) {
        problems.push(
          `${leg}: ${f.op} ${f.name} at frame ${f.frame} (${f.thread}, ${f.format} ${f.width}x${f.height}) has no hook line with hash ${f.payload_sha256}`,
        );
        continue;
      }
      used.add(i);
      matched++;
      const h = hookLines[i];
      if (
        h.status !== "ok" ||
        h.format !== f.format ||
        h.width !== f.width ||
        h.height !== f.height ||
        h.mipmaps !== f.mipmaps ||
        h.data_bytes !== f.data_bytes
      )
        problems.push(
          `${leg}: ${f.name}@${f.frame} hook shape/status differs: ${JSON.stringify(h)}`,
        );
    }
    // Every other hook line with content is an engine texture expected.json names.
    const engine = [...(expected.engine_textures ?? [])];
    hookLines.forEach((h, j) => {
      if (used.has(j)) return;
      const k = engine.findIndex(
        (e) =>
          e.op === h.op &&
          stepOfFrame(expected, h.frame, Number.MAX_SAFE_INTEGER) === e.step &&
          e.thread === h.thread &&
          e.format === h.format &&
          e.width === h.width &&
          e.height === h.height &&
          e.mipmaps === h.mipmaps,
      );
      if (k < 0) {
        problems.push(
          `${leg}: hook ${h.op} id ${h.id} at frame ${h.frame} (${h.format} ${h.width}x${h.height}) matches no fixture or engine texture`,
        );
        return;
      }
      engine.splice(k, 1);
      if (h.status !== "ok" || h.hash === null)
        problems.push(
          `${leg}: engine texture ${h.format} ${h.width}x${h.height} was not copied (${h.reason})`,
        );
    });
    for (const e of engine)
      problems.push(`${leg}: engine texture ${e.name} never appeared`);
  }
  return check(
    "hook-bytes-exact",
    "every texture_2d_create/_update the fixture made in a permitted format has a hook-log line at the same frame and thread whose SHA-256 (C++, copied at the hook) equals the fixture's payload_sha256 (GDScript, payload.gd) with the same shape, C's being its pre-fill content; every other content line is an engine texture expected.json declares, copied ok -- in the capture and in reference-armed",
    problems,
    `${matched} creates/updates hash-identical across the two encoders, plus ${(expected.engine_textures ?? []).length} engine texture(s) per leg`,
    evidence,
  );
}

export async function checkWorkerThreadCreate(
  outDir: string,
): Promise<Gate2Check> {
  const problems: string[] = [];
  const hooks = await loadResourceLog(join(outDir, "capture"));
  const fixture = await loadFixtureLog(join(outDir, "capture"));
  const d = fixture.lines.find(
    (l) => l.name === "D" && l.op === "texture_2d_create",
  );
  const others = hooks.lines.filter(
    (l) => l.thread === "other" && engineCall(l),
  );
  if (!d) problems.push("the fixture log has no D create");
  else if (d.thread !== "other")
    problems.push(`the fixture logged D's create on ${d.thread}`);
  if (others.length !== 1)
    problems.push(
      `${others.length} hook-log lines off the main thread, expected exactly D's create`,
    );
  const h = others[0];
  if (h && d) {
    if (h.op !== "texture_2d_create")
      problems.push(`the off-main line is ${h.op}`);
    if (h.frame !== d.frame)
      problems.push(
        `D's hook line is at frame ${h.frame}, the fixture's at ${d.frame}`,
      );
    if (h.hash !== d.payload_sha256 || h.status !== "ok")
      problems.push(
        `D's hook hash ${h.hash} (${h.status}) != fixture ${d.payload_sha256}`,
      );
  }
  return check(
    "worker-thread-create",
    "D's texture_2d_create (made on a worker Thread) is the hook log's only line with thread \"other\", at the fixture's frame, copied ok with the fixture's payload SHA-256",
    problems,
    h
      ? `D: id ${h.id}, frame ${h.frame}, thread other, copy ${h.copy_ns} ns, hash ${h.hash_ns} ns`
      : "",
    [hooks.path, fixture.path],
  );
}

export async function checkReplaceRetiresTemp(
  outDir: string,
): Promise<Gate2Check> {
  const problems: string[] = [];
  const hooks = await loadResourceLog(join(outDir, "capture"));
  const lines = hooks.lines;
  const replaces = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.op === "texture_replace" && engineCall(l));
  const notes: string[] = [];
  for (const { l, i } of replaces) {
    const by = l.target;
    const create = lines
      .slice(0, i)
      .reverse()
      .find((c) => c.op === "texture_2d_create" && c.rid === by);
    if (!create)
      problems.push(
        `replace at frame ${l.frame}: by-texture ${by} was never created`,
      );
    else if (create.frame !== l.frame)
      problems.push(
        `replace at frame ${l.frame}: by-texture created at frame ${create.frame}, not the same frame`,
      );
    if (create && l.by_id !== create.id)
      problems.push(
        `replace at frame ${l.frame}: by_id ${l.by_id} != the create's id ${create?.id}`,
      );
    const earlier = lines
      .slice(0, i)
      .reverse()
      .find(
        (c) => c.rid === l.rid && c.id === l.id && c.op !== "texture_replace",
      );
    if (!earlier || l.id === null)
      problems.push(`replace at frame ${l.frame}: target ${l.rid} unknown`);
    else if (
      !(
        l.version !== null &&
        earlier.version !== null &&
        l.version > earlier.version
      )
    )
      problems.push(
        `replace at frame ${l.frame}: version ${l.version} not above ${earlier.version}`,
      );
    if (create && (l.hash !== create.hash || l.status !== create.status))
      problems.push(
        `replace at frame ${l.frame}: the target did not take the by-texture's content`,
      );
    const reused = lines
      .slice(i + 1)
      .find((c) => c.rid === by || c.target === by);
    if (reused)
      problems.push(
        `the retired by-texture ${by} reappears: ${reused.op} at frame ${reused.frame}`,
      );
    notes.push(`${l.frame}: id ${l.id} v${l.version} <- id ${l.by_id}`);
  }
  if (replaces.length !== 3)
    problems.push(
      `${replaces.length} texture_replace lines, expected 3 (A, B at step 7; P2 at step 9)`,
    );
  return check(
    "replace-retires-temp",
    "each texture_replace follows a texture_2d_create of its by-texture in the same frame; the target keeps its id, bumps its version and takes the new content; the by-texture's RID never appears in the hook log again",
    problems,
    notes.join(", "),
    [hooks.path],
  );
}

export async function checkViewportDefaults(
  outDir: string,
  expected: Gate2Expected,
): Promise<Gate2Check> {
  const problems: string[] = [];
  const evidence: string[] = [];
  const wantFilter = SCENE_FILTER[expected.root_texture_defaults.filter];
  const wantRepeat = SCENE_REPEAT[expected.root_texture_defaults.repeat];
  const s4 = stepFrames2(expected, 4).applied;
  const s5 = stepFrames2(expected, 5).applied;
  for (const leg of ["capture", "reference-armed"]) {
    const rootPath = join(outDir, leg, "evidence", "root.json");
    evidence.push(rootPath);
    const root = await readJson<{
      texture_defaults?: { filter?: number; repeat?: number };
    }>(rootPath);
    if (
      root?.texture_defaults?.filter !== wantFilter ||
      root?.texture_defaults?.repeat !== wantRepeat
    )
      problems.push(
        `${leg} root.json texture_defaults=${JSON.stringify(root?.texture_defaults)}, expected filter ${wantFilter} (${expected.root_texture_defaults.filter}) and repeat ${wantRepeat} (${expected.root_texture_defaults.repeat})`,
      );
    const hooks = await loadResourceLog(join(outDir, leg));
    evidence.push(hooks.path);
    const filters = hooks.lines
      .filter((l) => l.op === "viewport_set_default_canvas_item_texture_filter")
      .map((l) => ({ frame: l.frame, value: l.value, root: l.root_viewport }));
    const want = [
      { frame: s4, value: 2, root: true },
      { frame: s5, value: 1, root: true },
    ];
    if (JSON.stringify(filters) !== JSON.stringify(want))
      problems.push(
        `${leg} viewport filter calls ${JSON.stringify(filters)}, expected ${JSON.stringify(want)}`,
      );
    const repeats = hooks.lines.filter(
      (l) => l.op === "viewport_set_default_canvas_item_texture_repeat",
    );
    if (repeats.length > 0)
      problems.push(
        `${leg}: ${repeats.length} viewport repeat call(s), expected none`,
      );
  }
  return check(
    "viewport-defaults",
    "the arm-time Viewport query reads the root's default filter Nearest and repeat Disabled (root.json texture_defaults), and the only viewport default calls are step 4's and step 5's viewport_set_default_canvas_item_texture_filter on the root viewport, carrying LINEAR (2) and then NEAREST (1)",
    problems,
    `filter ${expected.root_texture_defaults.filter}/repeat ${expected.root_texture_defaults.repeat} at arm; root LINEAR@${s4}, NEAREST@${s5}`,
    evidence,
  );
}

interface TextureRectCapture {
  texture?: string;
  first_frame?: number;
  calls?: number;
}

/** Texture RIDs the captured texture-rect draws name (counters.json), and dropped entries. */
async function drawnTextureRids(dir: string) {
  const counters = await readJson<{
    captured?: Record<string, TextureRectCapture[]>;
    captured_dropped?: Record<string, number>;
  }>(join(dir, "evidence", "counters.json"));
  const rids = new Set<string>();
  let dropped = 0;
  for (const op of TEXTURE_DRAW_OPS) {
    for (const e of counters?.captured?.[op] ?? [])
      if (e.texture) rids.add(e.texture);
    dropped += counters?.captured_dropped?.[op] ?? 0;
  }
  return { rids, dropped, present: counters !== undefined };
}

export interface UnknownRidReport {
  leg: string;
  drawn: number;
  unknown: string[];
}

/** Texture RIDs drawn that the hook log never saw created (`unknown-texture` from G2b2 on). */
async function unknownRids(
  dir: string,
  leg: string,
  problems: string[],
): Promise<UnknownRidReport> {
  const drawn = await drawnTextureRids(dir);
  const hooks = await loadResourceLog(dir);
  if (!drawn.present) problems.push(`${leg}: counters.json missing`);
  if (drawn.dropped > 0)
    problems.push(`${leg}: ${drawn.dropped} texture-rect captures dropped`);
  const known = new Set(
    hooks.lines
      .flatMap((l) => [l.rid, l.target])
      .filter((r): r is string => r !== null),
  );
  return {
    leg,
    drawn: drawn.rids.size,
    unknown: [...drawn.rids].filter((r) => r !== "0" && !known.has(r)).sort(),
  };
}

export async function checkUnsupportedVariant(
  outDir: string,
  expected: Gate2Expected,
): Promise<{
  check: Gate2Check;
  unknown: UnknownRidReport[];
  census: CensusResult | null;
}> {
  const problems: string[] = [];
  const dir = join(outDir, "capture-unsupported");
  const result = await readJson<CaptureResultJson>(
    join(dir, "evidence", "result.json"),
  );
  if (result?.status !== "armed" || result?.stream?.status !== "closed")
    problems.push(
      `capture-unsupported status=${result?.status} stream=${result?.stream?.status}`,
    );
  const hooks = await loadResourceLog(dir);
  if (hooks.problem)
    problems.push(`capture-unsupported resources.jsonl ${hooks.problem}`);
  const u1 = hooks.lines.filter(
    (l) => l.op === "texture_2d_create" && l.format === "RGBAF",
  );
  if (
    u1.length !== 1 ||
    u1[0].status !== "unsupported" ||
    u1[0].reason !== "unsupported-format" ||
    u1[0].hash !== null ||
    u1[0].copy_ns !== null ||
    u1[0].payload_bytes !== 0
  )
    problems.push(
      `U1's create ${JSON.stringify(u1)} is not one uncopied unsupported-format line`,
    );
  const unknown = [
    await unknownRids(join(outDir, "capture"), "capture", problems),
    await unknownRids(dir, "capture-unsupported", problems),
  ];
  if (unknown[0].unknown.length !== 0)
    problems.push(
      `capture draws texture RIDs it never saw created: ${unknown[0].unknown.join(",")}`,
    );
  if (unknown[1].unknown.length !== 1)
    problems.push(
      `capture-unsupported draws ${unknown[1].unknown.length} unknown texture RIDs (${unknown[1].unknown.join(",")}), expected exactly PRE's`,
    );
  let census: CensusResult | null = null;
  if (!hooks.problem) {
    census = censusOf(hooks.lines, expected, expected.quit_frame_default);
    for (const s of expected.steps) {
      const want = expectedCensus(
        expected,
        s.step,
        expected.quit_frame_default,
        "unsupported",
      );
      const have = census.per_step[s.step] ?? {};
      if (JSON.stringify(have) !== JSON.stringify(want))
        problems.push(
          `step ${s.step}: census ${JSON.stringify(have)}, expected ${JSON.stringify(want)}`,
        );
    }
  }
  return {
    check: check(
      "unsupported-variant",
      "capture-unsupported (RS_FIXTURE_VARIANT=unsupported): U1 (RGBAF) is logged as an uncopied unsupported-format texture; exactly one drawn texture RID (PRE, made before arming) was never seen created, against none in the main capture; the census is the main fixture's plus the variant's extras",
      problems,
      `U1 unsupported-format, unknown drawn RIDs: capture ${unknown[0].unknown.length}/${unknown[0].drawn}, capture-unsupported ${unknown[1].unknown.length}/${unknown[1].drawn} (${unknown[1].unknown.join(",")})`,
      [hooks.path, join(dir, "evidence", "counters.json")],
    ),
    unknown,
    census,
  };
}

// ---------------------------------------------------------------------------------------------
// The capture leg's class
// ---------------------------------------------------------------------------------------------

export interface Gate2LegEvaluation {
  leg: G2aLeg;
  expected_class: Gate2Class;
  result_class: Gate2Class;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
  recording: RecordingSummary;
  captureResult: CaptureResultJson | undefined;
}

export async function evaluateCapture(
  outDir: string,
): Promise<Gate2LegEvaluation> {
  const dir = join(outDir, "capture");
  const captureResult = await readJson<CaptureResultJson>(
    join(dir, "evidence", "result.json"),
  );
  const recording = await loadRecording(join(dir, RECORDING_NAME));
  const c = classifyLeg({ captureResult, recording, checkpoints: [] });
  const artifacts: string[] = [];
  for (const p of [
    "argv.txt",
    "env.txt",
    "stdout.log",
    "exit-code.txt",
    "evidence/result.json",
    "evidence/resources.jsonl",
    "evidence/root.json",
    RECORDING_NAME,
    "steps.jsonl",
    "textures.jsonl",
    "strace.txt",
  ])
    if (await fileExists(join(dir, p))) artifacts.push(join(dir, p));
  return {
    leg: "capture",
    expected_class: "success",
    result_class: c.result_class as Gate2Class,
    reasons: c.reasons,
    exit_code: await readExitCode(dir),
    artifacts,
    recording,
    captureResult,
  };
}

/** The ops a recording carries as unsupported (commands and item-level entries). */
export function unsupportedOps(recording: RecordingSummary): string[] {
  const ops = new Set<string>();
  for (const t of recording.transactions) {
    for (const u of t.meta.unsupported) ops.add(u.op);
    for (const item of t.meta.items)
      for (const c of item.commands)
        if (c.op === "unsupported") ops.add(c.name ?? "?");
  }
  return [...ops].sort();
}

export function checkCaptureLegClass(e: Gate2LegEvaluation): Gate2Check {
  const problems: string[] = [];
  if (e.result_class !== e.expected_class)
    problems.push(
      `class ${e.result_class}, expected ${e.expected_class}: ${e.reasons.slice(0, 2).join(" | ")}`,
    );
  const ops = unsupportedOps(e.recording);
  if (ops.length > 0)
    problems.push(`the recording carries unsupported ${ops.join(",")}`);
  // render-stream/2 carries the texture draws as commands (render-stream-2.md "Commands").
  const drawn = new Set<string>();
  for (const t of e.recording.transactions)
    for (const item of t.meta.items)
      for (const c of item.commands) drawn.add(c.op);
  for (const op of ["add_texture_rect", "add_texture_rect_region"])
    if (!drawn.has(op)) problems.push(`no ${op} command in the recording`);
  return check(
    "leg-class-capture",
    "the capture leg classifies as success on render-stream/2: no unsupported entry or command, and the fixture's texture draws are add_texture_rect / add_texture_rect_region commands; the recording decodes",
    problems,
    `${e.result_class}: commands ${[...drawn].sort().join(", ")}`,
    e.artifacts,
  );
}

// ---------------------------------------------------------------------------------------------
// Copy and hash costs (README "Gate 2a result")
// ---------------------------------------------------------------------------------------------

export interface Stat {
  min: number;
  median: number;
  max: number;
  n: number;
}

export function stat(values: number[]): Stat | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    min: s[0],
    median: s[Math.floor((s.length - 1) / 2)],
    max: s[s.length - 1],
    n: s.length,
  };
}

export interface CopyCost {
  shape: string;
  payload_bytes: number;
  copy_ns: Stat | null;
  hash_ns: Stat | null;
}

export function copyCosts(lines: readonly ResourceLine[]): {
  copy_ns: Stat | null;
  hash_ns: Stat | null;
  by_shape: CopyCost[];
} {
  // Creates and updates only: a replace line repeats its by-texture's payload fields.
  const copied = lines.filter(
    (l) =>
      (l.op === "texture_2d_create" || l.op === "texture_2d_update") &&
      l.copy_ns !== null &&
      l.hash_ns !== null,
  );
  const shapes = new Map<string, ResourceLine[]>();
  for (const l of copied) {
    const shape = `${l.format} ${l.width}x${l.height}${l.mipmaps ? " mipmaps" : ""}`;
    shapes.set(shape, [...(shapes.get(shape) ?? []), l]);
  }
  return {
    copy_ns: stat(copied.map((l) => l.copy_ns as number)),
    hash_ns: stat(copied.map((l) => l.hash_ns as number)),
    by_shape: [...shapes.entries()]
      .map(([shape, ls]) => ({
        shape,
        payload_bytes: ls[0].payload_bytes ?? 0,
        copy_ns: stat(ls.map((l) => l.copy_ns as number)),
        hash_ns: stat(ls.map((l) => l.hash_ns as number)),
      }))
      .sort((a, b) => a.payload_bytes - b.payload_bytes),
  };
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export interface Gate2Report {
  schema: "render-stream-gate2-report/1";
  generated_at: string;
  binary: { path: string | null; sha256: string | null };
  gate_passed: boolean;
  groups: { run: string[]; landed: string[]; not_run: string[] };
  legs: Record<
    string,
    {
      group: string;
      expected_class: Gate2Class | null;
      result_class: Gate2Class | null;
      reasons: string[];
      exit_code: number | null;
      artifacts: string[];
    }
  >;
  checks: Gate2Check[];
  checkpoints: Gate2Checkpoint[];
  /** g2b: receiver shots against the references */
  receiver_checkpoints: G2bCheckpoint[] | null;
  /** g2c: live receiver shots against the reference (and the animate synthesis) */
  live_checkpoints: G2cCheckpoint[] | null;
  /** g2c: live-animate's ANIM updates against the versions and hashes on the wire */
  live_animate: AnimateCounts | null;
  census: Record<string, CensusResult> | null;
  repeat_budget: RegionBudget[] | null;
  unknown_rids: UnknownRidReport[] | null;
  /** per leg: the copy and hash costs at the hook (G2a); the store, the receivers' traffic per
   * step and the host's resource bytes (G2b2); the live hosts' HTTP serving, pins and the
   * receivers' fetch latencies (G2c2) */
  resources: Record<
    string,
    {
      store: G2bResources["store"];
      receiver: G2bResources["receiver"];
      per_step: G2bResources["per_step"];
      host:
        | (Partial<ReturnType<typeof copyCosts>> &
            Partial<NonNullable<G2bResources["host"]>> &
            Partial<G2cHostNumbers> & {
              retained_max: number | null;
              http_gets: number | null;
              http_bytes: number | null;
            })
        | null;
    }
  > | null;
}

export interface Gate2Context {
  expected: Gate2Expected;
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

function notRunCheck(group: string, detail: string): Gate2Check {
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
  leg: (typeof G2A_SUPPORT_LEGS)[number],
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
    "textures.jsonl",
    "evidence/result.json",
    "evidence/resources.jsonl",
    "evidence/counters.json",
    RECORDING_NAME,
  ])
    if (await fileExists(join(dir, p))) artifacts.push(join(dir, p));
  return {
    group: "g2a",
    expected_class: null,
    result_class: null,
    reasons: [] as string[],
    exit_code: await readExitCode(dir),
    artifacts,
  };
}

export async function runGate2(
  outDir: string,
  ctx: Gate2Context,
): Promise<Gate2Report> {
  const groups = await readGroups(outDir);
  const notRun = groups.landed.filter((g) => !groups.run.includes(g));
  const checks: Gate2Check[] = [checkExpectedSelfConsistent(ctx.expected)];
  const legs: Gate2Report["legs"] = {};
  let checkpoints: Gate2Checkpoint[] = [];
  let census: Gate2Report["census"] = null;
  let repeatBudget: RegionBudget[] | null = null;
  let unknown: UnknownRidReport[] | null = null;
  let resources: Gate2Report["resources"] = null;
  let receiverCheckpoints: G2bCheckpoint[] | null = null;
  let liveCheckpoints: G2cCheckpoint[] | null = null;
  let liveAnimate: AnimateCounts | null = null;

  if (groups.run.includes("g2a")) {
    const capture = await evaluateCapture(outDir);
    const image = await checkExpectedImageReference(outDir, ctx.expected);
    checkpoints = image.checkpoints;
    const repeat = await checkReferenceRepeatBudget(outDir, ctx.expected);
    repeatBudget = repeat.budget;
    const censusCheck = await checkCensus(outDir, ctx.expected);
    census = censusCheck.census;
    const variant = await checkUnsupportedVariant(outDir, ctx.expected);
    unknown = variant.unknown;
    if (variant.census) census["capture-unsupported"] = variant.census;
    checks.push(
      fromGate0(await checkCaptureArmed(outDir, capture)),
      fromGate0(await checkHeadlessNoGpuGate0(outDir)),
      fromGate0(checkRecordingDecodes(capture.recording)),
      await checkStepAlignment(outDir, ctx.expected, capture.recording),
      image.check,
      repeat.check,
      await checkArmedTransparent(outDir, ctx.expected),
      censusCheck.check,
      await checkHookBytesExact(outDir, ctx.expected),
      await checkWorkerThreadCreate(outDir),
      await checkReplaceRetiresTemp(outDir),
      await checkViewportDefaults(outDir, ctx.expected),
      variant.check,
      checkCaptureLegClass(capture),
    );
    legs.capture = {
      group: "g2a",
      expected_class: capture.expected_class,
      result_class: capture.result_class,
      reasons: capture.reasons,
      exit_code: capture.exit_code,
      artifacts: capture.artifacts,
    };
    for (const leg of G2A_SUPPORT_LEGS)
      legs[leg] = await supportLeg(outDir, leg);
    resources = {};
    for (const leg of ["capture", "reference-armed", "capture-unsupported"]) {
      const log = await loadResourceLog(join(outDir, leg));
      resources[leg] = {
        store: null,
        receiver: null,
        per_step: null,
        host: {
          ...copyCosts(log.lines.filter(engineCall)),
          retained_max: null,
          retained_bytes_max: null,
          http_gets: null,
          http_bytes: null,
        },
      };
    }
  } else {
    checks.push(
      notRunCheck("g2a", "g2a was not in --legs; its checks are not-run"),
    );
  }
  if (groups.run.includes("g2b")) {
    const g2b = await runG2b(outDir, ctx.expected, G2A_CAPTURE_QUIT_FRAME);
    checks.push(...g2b.checks);
    Object.assign(legs, g2b.legs);
    receiverCheckpoints = g2b.checkpoints;
    resources ??= {};
    for (const [leg, r] of Object.entries(g2b.resources)) {
      const prior = resources[leg];
      resources[leg] = {
        store: r.store,
        receiver: r.receiver,
        per_step: r.per_step,
        host:
          prior?.host || r.host
            ? {
                ...(prior?.host ?? {}),
                ...(r.host ?? {}),
                retained_max: null,
                http_gets: null,
                http_bytes: null,
              }
            : null,
      };
    }
  }
  if (groups.run.includes("g2c")) {
    const g2c = await runG2c(outDir, ctx.expected);
    checks.push(...g2c.checks);
    Object.assign(legs, g2c.legs);
    liveCheckpoints = g2c.checkpoints;
    liveAnimate = g2c.animate;
    resources ??= {};
    for (const [leg, n] of Object.entries(g2c.numbers)) {
      const prior = resources[leg];
      resources[leg] = {
        store: prior?.store ?? null,
        receiver: prior?.receiver ?? null,
        per_step: prior?.per_step ?? null,
        host: { ...(prior?.host ?? {}), ...n },
      };
    }
  }
  for (const group of notRun)
    if (group !== "g2a")
      checks.push(notRunCheck(group, `${group} was not in --legs`));

  const binary = await readJson<{ path?: string; sha256?: string }>(
    join(outDir, "binary.json"),
  );
  return {
    schema: "render-stream-gate2-report/1",
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
    receiver_checkpoints: receiverCheckpoints,
    live_checkpoints: liveCheckpoints,
    live_animate: liveAnimate,
    census,
    repeat_budget: repeatBudget,
    unknown_rids: unknown,
    resources,
  };
}
