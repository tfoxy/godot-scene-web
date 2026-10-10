// Gate 2 group g2f (OPT-IN): the headless CanvasTexture shim experiment
// (protocol/canvas-texture-headless.md "Recommendation and next experiment" (a), and its
// "Experiment (a) result"; GRC_HEADLESS_CANVAS_TEXTURE=synthesize). Its legs (run-gate2.sh
// "run_g2f"), every one its own process:
//   reference-canvas                  rendered fixture, `canvas` variant, extension absent
//   shim-headless                     headless capture (strace), `canvas`, the opt-in, + a
//                                     rendered receiver                       -> success
//   shim-sabotage-omit-canvas-filter  as shim-headless, omit-op canvas_texture_set_texture_filter
//                                     from step 11's frame, + a rendered receiver
//                                                                             -> pixel-mismatch {11}
//   shim-off                          headless capture, GRC_HEADLESS_CANVAS_TEXTURE=off, + a
//                                     headless receiver      -> unsupported (canvas-texture-headless)
//   shim-refused-rendered             rendered capture host with the opt-in   -> refused, typed
//   shim-invalid                      headless, GRC_HEADLESS_CANVAS_TEXTURE=bogus -> refused, typed
//
// The checks map onto the doc's pass criteria 1-4 (criterion 5, the target game, is out of scope
// here): shim-receiver-vs-reference (1), shim-private-rids and shim-stdout-clean (2),
// shim-refuses-off-headless (3), shim-off-is-default (4, in-group; group g2d's canvas-headless is
// the default-path evidence), plus shim-wire (what the headless stream now carries) and the leg
// classes.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkHeadlessNoGpu,
  decodePngRgba,
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import { diffRgba, readExitCode } from "./gate0-checks";
import {
  type Gate2Expected,
  gate2Regions,
  synthesizeGate2,
} from "./gate2-expected";
import {
  type CaptureEvidence,
  checkCanvasTextureWire,
  checkLegClass,
  classifyG2bLeg,
  type G2bCheck,
  type G2bCheckpoint,
  type G2bClass,
  type G2bLegExpectation,
  loadCapture,
  loadReceiver,
  type ReceiverEvidence,
  receiverCheckpoints,
} from "./gate2b-checks";
import { evaluateCapture } from "./gate3-checks";
import type { Gate5Expected } from "./gate5-expected";
import { evaluateCaptureCanvas } from "./gate5d-checks";

const GATE5_EXPECTED = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/gate5/expected.json",
);

/** run-gate2.sh's CAPTURE_QUIT_FRAME (shim-headless runs to it, for the strace /proc sample). */
const SHIM_CAPTURE_QUIT_FRAME = 400;

/** rs_canvas_texture_shim.h: private RIDs are TAG << 32 | (2^31 + n). */
export const SHIM_TAG = 0x47524354n;
export const SHIM_INDEX_BASE = 0x80000000n;
const HEADLESS_REFUSAL = "canvas-texture-headless";

export function ridIndex(rid: bigint): bigint {
  return rid & 0xffffffffn;
}

export function isSyntheticRid(rid: bigint): boolean {
  return rid >> 32n === SHIM_TAG && ridIndex(rid) >= SHIM_INDEX_BASE;
}

function check(
  id: string,
  criterion: string,
  problems: string[],
  okDetail: string,
  evidence: string[],
): G2bCheck {
  return {
    id,
    criterion,
    passed: problems.length === 0,
    status: problems.length === 0 ? "pass" : "fail",
    detail: problems.length === 0 ? okDetail : problems.slice(0, 8).join("; "),
    evidence,
  };
}

/** evidence/canvas-texture-shim.json (render-stream-canvas-texture-shim/1). */
export interface ShimEvidence {
  schema?: string;
  mode?: string;
  state?: string;
  reason?: string | null;
  display_server?: string | null;
  engine_allocated?: number;
  foreign_frees?: number;
  synthesized?: Array<{
    rid: string;
    index: number;
    created_frame: number;
    freed_frame: number | null;
    frees: number;
  }>;
}

interface ShimResultJson {
  status?: string;
  reason?: string | null;
  vptr_written?: boolean;
  display_server?: string;
  stream?: { status?: string; transactions?: number };
  canvas_texture_shim?: {
    env?: string;
    state?: string;
    reason?: string | null;
    synthesized?: number;
  };
}

interface CountersJson {
  captured?: Record<string, Array<{ rid?: string }>>;
  captured_dropped?: Record<string, number>;
}

async function shimEvidence(dir: string): Promise<ShimEvidence | undefined> {
  return readJson<ShimEvidence>(
    join(dir, "evidence", "canvas-texture-shim.json"),
  );
}

async function resultJson(dir: string): Promise<ShimResultJson | undefined> {
  return readJson<ShimResultJson>(join(dir, "evidence", "result.json"));
}

/** Region sc of a step-11 shot against synthesizeGate2 (nearest, repeat enabled): mismatching
 * pixels, or null when unreadable. */
async function regionScMismatch(
  expected: Gate2Expected,
  path: string,
): Promise<number | null> {
  const got = await decodePngRgba(path);
  const want = synthesizeGate2(expected, 11);
  const sc = gate2Regions(expected, 11).sc;
  if (!got || !sc || got.width !== want.width || got.height !== want.height)
    return null;
  return diffRgba(want.rgba, got.data, want.width, want.height, sc)
    .mismatched_pixels;
}

function sessionOf(c: CaptureEvidence): Record<string, unknown> | null {
  const m = c.full.metas[0];
  return m && m.type === "session" ? m : null;
}

/** reference-canvas: Godot's own rendering of the `canvas` variant (no extension). Every step shot
 * exists and step 11's region sc equals synthesizeGate2 (SC's CanvasTexture: nearest, repeat
 * enabled), so the reference itself carries the CanvasTexture's override. */
export async function checkReferenceCanvas(
  expected: Gate2Expected,
  outDir: string,
): Promise<G2bCheck> {
  const dir = join(outDir, "reference-canvas");
  const problems: string[] = [];
  const exit = await readExitCode(dir);
  if (exit !== 0) problems.push(`reference-canvas exit ${exit}`);
  for (const s of expected.steps)
    if (!(await fileExists(join(dir, "shots", `step-${s.step}.png`))))
      problems.push(`reference-canvas step-${s.step}.png missing`);
  const sc = await regionScMismatch(
    expected,
    join(dir, "shots", "step-11.png"),
  );
  if (sc !== 0)
    problems.push(
      `reference-canvas step 11 region sc: ${sc ?? "unreadable"} px differ from synthesizeGate2`,
    );
  return check(
    "shim-reference-canvas",
    "reference-canvas (the rendered fixture's `canvas` variant, extension absent) shot every step, and its step-11 region sc equals synthesizeGate2 (nearest, repeat enabled) exactly",
    problems,
    `${expected.steps.length} shots, region sc exact`,
    [join(dir, "shots", "step-11.png")],
  );
}

/** Criterion 1: shim-headless's rendered receiver equals reference-canvas byte for byte at every
 * step's settle seq, full frame (region sc of step 11 included), and its step-11 region sc equals
 * synthesizeGate2 too. */
export async function checkShimReceiverVsReference(
  expected: Gate2Expected,
  cps: readonly G2bCheckpoint[],
  rx: ReceiverEvidence,
): Promise<G2bCheck> {
  const problems: string[] = [];
  if (cps.length !== expected.steps.length)
    problems.push(
      `${cps.length} checkpoints, expected ${expected.steps.length}`,
    );
  for (const c of cps)
    if (c.mismatched_pixels !== 0)
      problems.push(
        `step ${c.step} (seq ${c.seq}): ${c.mismatched_pixels ?? "unreadable"} px differ (max ${c.max_channel_delta ?? "?"})`,
      );
  const c11 = cps.find((c) => c.step === 11);
  if (c11?.regions.sc !== 0)
    problems.push(
      `step 11 region sc: ${c11?.regions.sc ?? "absent"} px differ`,
    );
  const seq11 = rx.settle.get(11);
  const model = await regionScMismatch(
    expected,
    join(rx.dir, "shots", `seq-${seq11}.png`),
  );
  if (model !== 0)
    problems.push(
      `step 11 region sc vs synthesizeGate2: ${model ?? "unreadable"} px differ`,
    );
  return check(
    "shim-receiver-vs-reference",
    "criterion 1: the rendered receiver of shim-headless (a --headless capture host with GRC_HEADLESS_CANVAS_TEXTURE=synthesize) equals reference-canvas byte for byte at every step's settle seq, full frame, and its step-11 region sc (SC drawn through the CanvasTexture) is exact both against reference-canvas and against synthesizeGate2",
    problems,
    `${cps.length} shots byte-exact, step-11 region sc 0 px`,
    cps.map((c) => c.shot),
  );
}

/** What the headless stream carries with the shim on: the session declares canvas_texture
 * supported (no unsupported_resources), every canvas_texture_* hook line is ok with an id and a
 * private RID, nothing is refused as canvas-texture-headless, and CT's wire entry at step 11 is
 * kind canvas, diffuse A, nearest/enabled, version > 1 (checkCanvasTextureWire, which G2d could
 * only run on a rendered host). */
export function checkShimWire(
  expected: Gate2Expected,
  cap: CaptureEvidence,
): G2bCheck {
  const problems: string[] = [];
  const session = sessionOf(cap);
  const engine = (session?.engine ?? {}) as { display_server?: string };
  const features = (session?.features ?? {}) as {
    resources?: string[];
    unsupported_resources?: unknown[];
  };
  if (engine.display_server !== "headless")
    problems.push(`display_server ${engine.display_server}, expected headless`);
  if (
    !(features.resources ?? []).includes("canvas_texture") ||
    (features.unsupported_resources ?? []).length !== 0
  )
    problems.push(
      `features resources ${JSON.stringify(features.resources)} unsupported_resources ${JSON.stringify(features.unsupported_resources)}`,
    );
  const ct = cap.hook.lines.filter((l) => l.op.startsWith("canvas_texture_"));
  if (!ct.some((l) => l.op === "canvas_texture_create"))
    problems.push("no canvas_texture_create hook line");
  for (const l of ct)
    if (
      l.status !== "ok" ||
      l.id === null ||
      l.rid === null ||
      !isSyntheticRid(BigInt(l.rid))
    )
      problems.push(
        `hook line ${l.op} @${l.frame}: ${l.status}/${l.reason} id ${l.id} rid ${l.rid}`,
      );
  if (cap.hook.lines.some((l) => l.reason === HEADLESS_REFUSAL))
    problems.push("a hook line refuses canvas-texture-headless");
  for (const t of cap.full.recording?.transactions ?? []) {
    if (
      t.state.unsupported.length > 0 ||
      t.state.items.some((it) =>
        it.commands.some((c) => c.op === "unsupported"),
      )
    ) {
      problems.push(`seq ${t.seq}: an unsupported entry or command`);
      break;
    }
  }
  if (!cap.full.recording) problems.push("recording did not resolve");
  const wire = checkCanvasTextureWire(expected, cap);
  if (!wire.passed) problems.push(`CT wire: ${wire.detail}`);
  return check(
    "shim-wire",
    "shim-headless's session (display_server headless) declares canvas_texture supported with no unsupported_resources; every canvas_texture_* hook line is ok with an id and a private RID; no hook line, command or entry is refused (canvas-texture-headless or otherwise); CT's step-11 wire entry is kind canvas, status ok, diffuse A, filter nearest, repeat enabled, version > 1",
    problems,
    `${ct.length} canvas_texture_* calls captured with private RIDs; CT correct on a headless host`,
    [cap.hook.path, cap.full.path],
  );
}

/** Creator ops whose results counters.json logs ("all hooked creators"). */
export function isCreatorOp(op: string): boolean {
  return op.includes("create");
}

/** Criterion 2: every private RID has index >= 2^31; across the run no private RID equals any RID
 * an engine creator returned (every hooked creator logged, none dropped); the canvas_texture_create
 * log names exactly the private RIDs; every private RID was freed exactly once (the CanvasTexture
 * destructor's free reached the hook, then the engine) and the shim saw no foreign frees. */
export async function checkShimPrivateRids(
  cap: CaptureEvidence,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const shim = await shimEvidence(cap.dir);
  const countersPath = join(cap.dir, "evidence", "counters.json");
  const counters = await readJson<CountersJson>(countersPath);
  const synthetic = new Set<bigint>();
  if (shim?.schema !== "render-stream-canvas-texture-shim/1")
    problems.push("canvas-texture-shim.json missing or of another schema");
  if (shim?.state !== "armed" || shim?.mode !== "synthesize")
    problems.push(
      `shim ${shim?.mode}/${shim?.state}, expected synthesize/armed`,
    );
  if ((shim?.engine_allocated ?? -1) !== 0)
    problems.push(`engine_allocated ${shim?.engine_allocated}, expected 0`);
  if ((shim?.foreign_frees ?? -1) !== 0)
    problems.push(`foreign_frees ${shim?.foreign_frees}, expected 0`);
  for (const s of shim?.synthesized ?? []) {
    const rid = BigInt(s.rid);
    if (!isSyntheticRid(rid) || BigInt(s.index) !== ridIndex(rid))
      problems.push(
        `private RID ${s.rid} index ${s.index} is not tag<<32|>=2^31`,
      );
    if (s.frees !== 1 || s.freed_frame === null)
      problems.push(`private RID ${s.rid} freed ${s.frees} times`);
    synthetic.add(rid);
  }
  if (synthetic.size === 0) problems.push("no private RID was synthesized");
  const captured = counters?.captured ?? {};
  const dropped = counters?.captured_dropped ?? {};
  const engine = new Set<bigint>();
  const ctLogged = new Set<bigint>();
  let creators = 0;
  for (const [op, entries] of Object.entries(captured)) {
    if (!isCreatorOp(op)) continue;
    creators++;
    if ((dropped[op] ?? 0) !== 0)
      problems.push(`${op}: ${dropped[op]} log entries dropped`);
    for (const e of entries) {
      if (e.rid === undefined) continue;
      const rid = BigInt(e.rid);
      if (op === "canvas_texture_create") ctLogged.add(rid);
      else engine.add(rid);
    }
  }
  if (creators === 0) problems.push("counters.json logs no creator");
  for (const rid of engine) {
    if (synthetic.has(rid))
      problems.push(`engine RID ${rid} equals a private RID`);
    if (ridIndex(rid) >= SHIM_INDEX_BASE)
      problems.push(`engine RID ${rid} has index >= 2^31`);
  }
  if (
    ctLogged.size !== synthetic.size ||
    [...ctLogged].some((r) => !synthetic.has(r))
  )
    problems.push(
      `canvas_texture_create logged ${[...ctLogged].join(",")}, private ${[...synthetic].join(",")}`,
    );
  const freed = new Set(
    (captured.free ?? [])
      .filter((e) => e.rid !== undefined)
      .map((e) => BigInt(e.rid as string)),
  );
  if ((dropped.free ?? 0) !== 0) problems.push("free log entries dropped");
  for (const rid of synthetic)
    if (!freed.has(rid))
      problems.push(`private RID ${rid} never reached free()`);
  return check(
    "shim-private-rids",
    "criterion 2: every private RID is tag<<32 | index >= 2^31; no private RID equals any RID an engine creator returned (every hooked creator logged in counters.json, none dropped, every engine index < 2^31); the canvas_texture_create log names exactly the private RIDs; each was freed once through the hooked free() (the CanvasTexture destructor) and the shim saw no foreign frees",
    problems,
    `${synthetic.size} private RID(s) vs ${engine.size} engine RIDs from ${creators} creators: disjoint, all freed`,
    [join(cap.dir, "evidence", "canvas-texture-shim.json"), countersPath],
  );
}

/** The ERROR/WARNING lines of a Godot stdout.log (the engine's own error channel). */
export function engineErrorLines(log: string): string[] {
  return log
    .split("\n")
    .filter((l) => /^(ERROR|WARNING|SCRIPT ERROR):/.test(l))
    .map((l) => l.trim());
}

/** Criterion 2 (free with no engine error): shim-headless's engine ERROR/WARNING lines are exactly
 * shim-off's (the same fixture and variant with the shim off: the exit-time leak reports both
 * runs share), and none names a canvas texture or a private RID. */
export async function checkShimStdoutClean(
  outDir: string,
  cap: CaptureEvidence,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const on = (await readTextOrUndefined(join(cap.dir, "stdout.log"))) ?? "";
  const offPath = join(outDir, "shim-off", "capture", "stdout.log");
  const off = (await readTextOrUndefined(offPath)) ?? "";
  if (on === "" || off === "") problems.push("a stdout.log is missing");
  const a = engineErrorLines(on).sort();
  const b = engineErrorLines(off).sort();
  if (JSON.stringify(a) !== JSON.stringify(b))
    problems.push(
      `shim-headless engine lines ${JSON.stringify(a)} differ from shim-off's ${JSON.stringify(b)}`,
    );
  const shim = await shimEvidence(cap.dir);
  for (const l of a) {
    if (/canvas.?texture/i.test(l))
      problems.push(`engine line names a canvas texture: ${l}`);
    for (const s of shim?.synthesized ?? [])
      if (l.includes(s.rid))
        problems.push(`engine line names private RID ${s.rid}: ${l}`);
  }
  return check(
    "shim-stdout-clean",
    "criterion 2: shim-headless's engine ERROR/WARNING lines equal shim-off's exactly (the shared exit-time leak reports), and none names a canvas texture or a private RID: freeing the private RIDs raised no engine error",
    problems,
    `${a.length} engine line(s), identical to shim-off`,
    [join(cap.dir, "stdout.log"), offPath],
  );
}

/** Criterion 3: on a rendered host (gamescope, display server X11) the opt-in refuses the whole
 * capture, typed (canvas-texture-shim-not-headless), before anything is hooked: no vptr write, no
 * private RID, no stream; the fixture still renders SC correctly. An invalid value refuses too
 * (canvas-texture-shim-invalid). */
export async function checkShimRefusesOffHeadless(
  expected: Gate2Expected,
  outDir: string,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const evidence: string[] = [];
  const legs: Array<[string, string, boolean]> = [
    ["shim-refused-rendered", "canvas-texture-shim-not-headless", false],
    ["shim-invalid", "canvas-texture-shim-invalid", true],
  ];
  for (const [leg, reason, headless] of legs) {
    const dir = join(outDir, leg, "capture");
    evidence.push(join(dir, "evidence", "result.json"));
    const r = await resultJson(dir);
    const s = await shimEvidence(dir);
    if (r?.status !== "refused" || r?.reason !== reason)
      problems.push(
        `${leg}: status ${r?.status} (${r?.reason}), expected refused (${reason})`,
      );
    if (r?.vptr_written !== false)
      problems.push(`${leg}: vptr_written ${r?.vptr_written}`);
    if ((r?.display_server === "headless") !== headless)
      problems.push(`${leg}: display_server ${r?.display_server}`);
    if (
      r?.canvas_texture_shim?.state !== "refused" ||
      r.canvas_texture_shim.reason !== reason
    )
      problems.push(
        `${leg}: result.canvas_texture_shim ${JSON.stringify(r?.canvas_texture_shim)}`,
      );
    if (s?.state !== "refused" || (s?.synthesized ?? [null]).length !== 0)
      problems.push(
        `${leg}: canvas-texture-shim.json ${s?.state}, ${s?.synthesized?.length} synthesized`,
      );
    if (await fileExists(join(dir, "recording.rs2")))
      problems.push(`${leg}: a recording was written`);
    if ((await readExitCode(dir)) !== 0)
      problems.push(`${leg}: exit ${await readExitCode(dir)}`);
  }
  const shot = join(
    outDir,
    "shim-refused-rendered",
    "capture",
    "shots",
    "step-11.png",
  );
  evidence.push(shot);
  const sc = await regionScMismatch(expected, shot);
  if (sc !== 0)
    problems.push(
      `shim-refused-rendered's own step-11 region sc: ${sc ?? "unreadable"} px differ from synthesizeGate2`,
    );
  return check(
    "shim-refuses-off-headless",
    "criterion 3: with GRC_HEADLESS_CANVAS_TEXTURE=synthesize a rendered capture host (gamescope, not `headless`) refuses the capture typed (canvas-texture-shim-not-headless) before hooking anything -- no vptr write, no private RID, no recording -- and still renders SC correctly; an invalid value refuses typed (canvas-texture-shim-invalid) on a headless host",
    problems,
    "rendered host refused (not-headless), invalid value refused (invalid), no private RID anywhere",
    evidence,
  );
}

/** Criterion 4 (in-group): GRC_HEADLESS_CANVAS_TEXTURE=off is exactly the default: the shim is
 * off, no private RID exists, the session lists canvas_texture under unsupported_resources
 * (canvas-texture-headless), and every canvas_texture_* hook line is the typed refusal with no
 * id. */
export async function checkShimOffIsDefault(
  off: CaptureEvidence,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const r = await resultJson(off.dir);
  const s = await shimEvidence(off.dir);
  if (r?.status !== "armed") problems.push(`status ${r?.status}`);
  if (
    r?.canvas_texture_shim?.state !== "off" ||
    r.canvas_texture_shim.synthesized !== 0
  )
    problems.push(
      `result.canvas_texture_shim ${JSON.stringify(r?.canvas_texture_shim)}`,
    );
  if (s?.state !== "off" || (s?.synthesized ?? [null]).length !== 0)
    problems.push(
      `canvas-texture-shim.json ${s?.state}, ${s?.synthesized?.length} synthesized`,
    );
  const features = (sessionOf(off)?.features ?? {}) as {
    resources?: string[];
    unsupported_resources?: Array<{ resource: string; reason: string }>;
  };
  if (
    (features.resources ?? []).includes("canvas_texture") ||
    JSON.stringify(features.unsupported_resources ?? null) !==
      JSON.stringify([{ resource: "canvas_texture", reason: HEADLESS_REFUSAL }])
  )
    problems.push(
      `features resources ${JSON.stringify(features.resources)} unsupported_resources ${JSON.stringify(features.unsupported_resources)}`,
    );
  const ct = off.hook.lines.filter((l) => l.op.startsWith("canvas_texture_"));
  if (ct.length === 0) problems.push("no canvas_texture_* hook line");
  for (const l of ct)
    if (
      l.status !== "unsupported" ||
      l.reason !== HEADLESS_REFUSAL ||
      l.id !== null
    )
      problems.push(
        `hook line ${l.op} @${l.frame}: ${l.status}/${l.reason} id ${l.id}`,
      );
  return check(
    "shim-off-is-default",
    "criterion 4 (in-group): GRC_HEADLESS_CANVAS_TEXTURE=off behaves exactly as the default -- the shim is off with no private RID, the session lists canvas_texture under unsupported_resources (canvas-texture-headless), and every canvas_texture_* hook line is the typed refusal with no id",
    problems,
    `${ct.length} canvas_texture_* calls refused typed, as without the variable`,
    [off.hook.path, join(off.dir, "evidence", "result.json")],
  );
}

/** Gate 5's D11 under the shim: fixtures/gate5's `canvas` variant (a CanvasTexture created in
 * _ready, never drawn) captured headless with the opt-in. Without the shim gate 5's
 * `capture-canvas` refuses every RID() geometry draw (expected.json predictions[capture-canvas]);
 * with it the capture classifies success with no unsupported entry, every settle frame's commands
 * are the main fixture's expected /4 commands (`tex: null` on the untextured geometry), and the
 * shim synthesized exactly one private RID (the CanvasTexture's). */
export async function checkShimGate5Canvas(
  outDir: string,
  gate5: Gate5Expected,
): Promise<{
  check: G2bCheck;
  result_class: string;
  exit_code: number | null;
}> {
  const capture = await evaluateCapture(outDir, {
    legDir: "shim-gate5-canvas",
    expectedClass: "success",
  });
  const relaxed: Gate5Expected = {
    ...gate5,
    predictions: {
      ...gate5.predictions,
      "capture-canvas": {
        class: "success",
        reason: "canvas-texture-headless",
        entries: [],
      },
    },
  };
  const evaluation = evaluateCaptureCanvas(relaxed, capture);
  const problems = [...evaluation.problems];
  const shim = await shimEvidence(join(outDir, "shim-gate5-canvas"));
  const synthesized = shim?.synthesized ?? [];
  if (shim?.state !== "armed" || synthesized.length !== 1)
    problems.push(
      `shim ${shim?.state}, ${synthesized.length} private RID(s), expected armed with 1`,
    );
  for (const s of synthesized)
    if (!isSyntheticRid(BigInt(s.rid)))
      problems.push(`private RID ${s.rid} is not tag<<32|>=2^31`);
  return {
    check: check(
      "shim-gate5-canvas",
      "gate 5's D11 under the shim: fixtures/gate5's canvas variant captured headless with GRC_HEADLESS_CANVAS_TEXTURE=synthesize classifies success with no unsupported entry, every settle frame's commands equal the main fixture's expected /4 commands (RID() geometry stays tex null instead of canvas-texture-headless), and the CanvasTexture got one private RID",
      problems,
      `${capture.result_class}, ${synthesized.length} private RID, no RID() geometry refused`,
      capture.artifacts,
    ),
    result_class: capture.result_class,
    exit_code: capture.exit_code,
  };
}

export const G2F_LEGS: readonly G2bLegExpectation[] = [
  { leg: "shim-headless", expected_class: "success" },
  {
    leg: "shim-sabotage-omit-canvas-filter",
    expected_class: "pixel-mismatch",
    steps: [11],
  },
  {
    leg: "shim-off",
    expected_class: "unsupported",
    reason: HEADLESS_REFUSAL,
  },
];

export interface G2fLegReport {
  group: "g2f";
  expected_class: G2bClass | null;
  result_class: G2bClass | null;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface G2fResult {
  checks: G2bCheck[];
  legs: Record<string, G2fLegReport>;
  checkpoints: G2bCheckpoint[];
}

export async function runG2f(
  outDir: string,
  expected: Gate2Expected,
): Promise<G2fResult> {
  const quit = expected.quit_frame_default;
  const shim = await loadCapture(
    outDir,
    "shim-headless",
    "shim-headless/capture",
    SHIM_CAPTURE_QUIT_FRAME,
  );
  const sabotage = await loadCapture(
    outDir,
    "shim-sabotage-omit-canvas-filter",
    "shim-sabotage-omit-canvas-filter/capture",
    quit,
  );
  const off = await loadCapture(outDir, "shim-off", "shim-off/capture", quit);
  const shimRx = await loadReceiver(
    outDir,
    "shim-headless",
    "shim-headless/receiver",
    shim,
    expected,
  );
  const sabotageRx = await loadReceiver(
    outDir,
    "shim-sabotage-omit-canvas-filter",
    "shim-sabotage-omit-canvas-filter/receiver",
    sabotage,
    expected,
  );
  const offRx = await loadReceiver(
    outDir,
    "shim-off",
    "shim-off/receiver",
    off,
    expected,
  );
  const reference = join(outDir, "reference-canvas");
  const cpShim = await receiverCheckpoints(expected, shimRx, reference);
  const cpSabotage = await receiverCheckpoints(expected, sabotageRx, reference);

  const noGpu = await checkHeadlessNoGpu(outDir, "shim-headless/capture");
  const checks: G2bCheck[] = [
    {
      id: "shim-headless-no-gpu",
      criterion: noGpu.description,
      passed: noGpu.status === "pass",
      status: noGpu.status === "pass" ? "pass" : "fail",
      detail: noGpu.detail ?? "",
      evidence: noGpu.evidence.split(", "),
    },
    await checkReferenceCanvas(expected, outDir),
    await checkShimReceiverVsReference(expected, cpShim, shimRx),
    checkShimWire(expected, shim),
    await checkShimPrivateRids(shim),
    await checkShimStdoutClean(outDir, shim),
    await checkShimRefusesOffHeadless(expected, outDir),
    await checkShimOffIsDefault(off),
  ];
  const gate5 = JSON.parse(
    await readFile(GATE5_EXPECTED, "utf8"),
  ) as Gate5Expected;
  const d11 = await checkShimGate5Canvas(outDir, gate5);
  checks.push(d11.check);
  const inputs: Record<
    string,
    {
      capture: CaptureEvidence;
      receiver: ReceiverEvidence;
      checkpoints: G2bCheckpoint[];
    }
  > = {
    "shim-headless": { capture: shim, receiver: shimRx, checkpoints: cpShim },
    "shim-sabotage-omit-canvas-filter": {
      capture: sabotage,
      receiver: sabotageRx,
      checkpoints: cpSabotage,
    },
    "shim-off": { capture: off, receiver: offRx, checkpoints: [] },
  };
  const legs: Record<string, G2fLegReport> = {};
  for (const e of G2F_LEGS) {
    const input = inputs[e.leg];
    const c = await classifyG2bLeg({ ...input, expected });
    const artifacts = [
      join(input.receiver.dir, "applied.json"),
      join(input.receiver.dir, "stdout.log"),
    ];
    checks.push(checkLegClass(e, c, [], artifacts));
    legs[e.leg] = {
      group: "g2f",
      expected_class: e.expected_class,
      result_class: c.result_class,
      reasons: c.reasons,
      exit_code: input.receiver.exit,
      artifacts,
    };
  }
  legs["shim-gate5-canvas"] = {
    group: "g2f",
    expected_class: "success",
    result_class: d11.result_class as G2bClass,
    reasons: [],
    exit_code: d11.exit_code,
    artifacts: d11.check.evidence,
  };
  for (const support of [
    "reference-canvas",
    "shim-refused-rendered/capture",
    "shim-invalid/capture",
  ])
    legs[support.replace("/capture", "")] = {
      group: "g2f",
      expected_class: null,
      result_class: null,
      reasons: [],
      exit_code: await readExitCode(join(outDir, support)),
      artifacts: [join(outDir, support, "stdout.log")],
    };
  return { checks, legs, checkpoints: [...cpShim, ...cpSabotage] };
}
