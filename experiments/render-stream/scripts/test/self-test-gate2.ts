#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the gate 2 checker (lib/gate2-checks.ts, lib/gate2b-checks.ts, gate2c-checks.ts,
// gate2e-checks.ts and lib/gate2-expected.ts, groups g2a-g2e). Proves that every check can fail as
// well as pass.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate2.ts
//
// 1. Pure cases: synthesizeGate2's sampling (flips, transpose, tile, mirror, clamp, binary and
//    partial alpha) against hand-computed texels, the step windows, the census helpers, the hook
//    log's line validation, and checkExpectedSelfConsistent on the committed expected.json and on
//    broken copies of it.
// 2. Evidence-tree scenarios: a fabricated passing g2a-g2e tree (gate2b-fixture.ts: one model of
//    the fixture's texture calls writes every hook log, fixture log, render-stream/2 recording,
//    store, cache and simulated receiver; PNGs are synthesized from fixtures/gate2/expected.json;
//    gate2c-fixture.ts adds the live hosts and receivers of g2c and g2e),
//    then perturbations: every check and every leg class is failed by at least one of them. Each
//    scenario runs the real runGate2 and asserts that exactly the checks it targets fail and every
//    other check still passes.
//
// Exits non-zero if any assertion fails.

import {
  appendFile,
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GATE0_HOOKS } from "../lib/gate0-checks";
import {
  censusOf,
  checkExpectedSelfConsistent,
  expectedCensus,
  type Gate2Report,
  parseJsonl,
  RESOURCE_LINE_KEYS,
  type ResourceLine,
  runGate2,
  validateResourceLine,
} from "../lib/gate2-checks";
import {
  type Gate2Draw,
  type Gate2Expected,
  sampleAt,
  stepFrames2,
  stepOfFrame,
  synthesizeGate2,
} from "../lib/gate2-expected";
import {
  buildModel,
  buildTree,
  CAPTURE_QUIT,
  CONTENT,
  encodeSink,
  INLINE_RESOURCES,
  jsonl,
  line,
  type Model,
  PRE_RID,
  shotPng,
  texRid,
  writeBytes,
  writeCounters,
  writeJson,
  writeText,
} from "./gate2b-fixture";
import {
  buildG2cTree,
  buildG2eTree,
  g2eToken,
  HTTP_RESOURCES,
} from "./gate2c-fixture";
import { texturePayload } from "./rs2-test-encoder";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "../..");

let assertions = 0;
let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  assertions++;
  if (ok) {
    console.log(`[SELF-TEST OK] ${name}`);
  } else {
    failures++;
    console.error(`[SELF-TEST FAIL] ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

let EXPECTED: Gate2Expected;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---------------------------------------------------------------------------------------------
// 1. Pure cases
// ---------------------------------------------------------------------------------------------

function pixel(
  frame: { width: number; rgba: Uint8Array },
  x: number,
  y: number,
): string {
  const i = (y * frame.width + x) * 4;
  return [...frame.rgba.subarray(i, i + 4)].join(",");
}

function pureCases(): void {
  const e = EXPECTED;
  const draw = (
    sample: Partial<NonNullable<Gate2Draw["sample"]>>,
    rect = [0, 0, 32, 32],
  ): Gate2Draw & {
    sample: NonNullable<Gate2Draw["sample"]>;
  } => ({
    name: "T",
    rect_px: rect as [number, number, number, number],
    sample: {
      texture: "A0",
      src_px: [0, 0, 16, 16],
      flip_h: false,
      flip_v: false,
      transpose: false,
      tile: false,
      repeat: "disabled",
      modulate: [255, 255, 255, 255],
      ...sample,
    },
  });
  const red = "255,0,0,255";
  const green = "0,255,0,255";
  const blue = "0,0,255,255";
  const white = "255,255,255,255";
  const at = (d: ReturnType<typeof draw>, x: number, y: number) =>
    sampleAt(e, d, x, y).join(",");
  assert(
    "sample: plain 2x, top-left is A0's red quadrant",
    at(draw({}), 0, 0) === red,
  );
  assert("sample: plain 2x, top-right is green", at(draw({}), 31, 0) === green);
  assert(
    "sample: flip_h mirrors: top-left shows green",
    at(draw({ flip_h: true }), 0, 0) === green,
  );
  assert(
    "sample: flip_v mirrors: top-left shows blue",
    at(draw({ flip_v: true }), 0, 0) === blue,
  );
  assert(
    "sample: transpose swaps axes: top-right shows blue, bottom-left green",
    at(draw({ transpose: true }), 31, 0) === blue &&
      at(draw({ transpose: true }), 0, 31) === green,
  );
  assert(
    "sample: transpose + flip_h is S3's 90-degree turn: top-left blue, top-right red",
    at(draw({ transpose: true, flip_h: true }), 0, 0) === blue &&
      at(draw({ transpose: true, flip_h: true }), 31, 0) === red,
  );
  assert(
    "sample: region (4,4,8,8) at 4x straddles the four quadrants",
    at(draw({ src_px: [4, 4, 8, 8] }), 0, 0) === red &&
      at(draw({ src_px: [4, 4, 8, 8] }), 16, 0) === green &&
      at(draw({ src_px: [4, 4, 8, 8] }), 31, 31) === white,
  );
  const tile = draw(
    { src_px: [0, 0, 48, 32], tile: true, repeat: "enabled" },
    [0, 0, 48, 32],
  );
  assert(
    "sample: tile wraps modulo the texture: x 16 is red again",
    at(tile, 16, 0) === red,
  );
  const mirror = draw({ src_px: [0, 0, 32, 32], repeat: "mirror" });
  assert(
    "sample: mirror reflects: x 16 repeats texel 15 (green), x 31 texel 0 (red)",
    at(mirror, 16, 0) === green && at(mirror, 31, 0) === red,
  );
  const clamp = draw({ src_px: [0, 0, 32, 32], repeat: "disabled" });
  assert(
    "sample: disabled clamps to the edge: x 31 is texel 15 (green)",
    at(clamp, 31, 0) === green,
  );
  const b0 = draw({ texture: "B0", src_px: [0, 0, 4, 4] });
  assert(
    "sample: LA8 checker samples (L,L,L,A): even texel white opaque, odd transparent",
    at(b0, 0, 0) === white && at(b0, 8, 0) === "0,0,0,0",
  );

  // Synthesis: SB's binary alpha over BG at step 0; RAW1 white from step 8; S3 shows C from 8.
  const f0 = synthesizeGate2(e, 0);
  assert(
    "synth step 0: SB's transparent texel shows BG's red",
    pixel(f0, 384, 40) === "204,51,51,255",
  );
  assert(
    "synth step 0: SB's opaque texel is white",
    pixel(f0, 376, 40) === white,
  );
  assert(
    "synth step 0: the clear colour at 0,0",
    pixel(f0, 0, 0) === "51,51,102,255",
  );
  const f8 = synthesizeGate2(e, 8);
  assert(
    "synth step 8: RAW1 draws the default white",
    pixel(f8, 440, 50) === white,
  );
  assert(
    "synth step 8: S3 shows C's pre-fill content (no black)",
    pixel(f8, 320, 40) !== "0,0,0,255" && pixel(f8, 351, 71) !== "0,0,0,255",
  );
  const f7 = synthesizeGate2(e, 7);
  const sb = pixel(f7, 376, 40).split(",").map(Number);
  assert(
    "synth step 7: SB's alpha .4 white blends over BG's red",
    sb[0] === Math.round((255 * 102 + 204 * 153) / 255) &&
      sb[1] === Math.round((255 * 102 + 51 * 153) / 255),
    sb.join(","),
  );
  const fa = synthesizeGate2(e, 3, { variant: "animate", frame: 32 });
  assert(
    "synth animate: ANIM at frame 32 is k = 2",
    pixel(fa, 280, 120) === "102,153,102,255",
  );

  // Windows and census helpers.
  const quitDefault = e.quit_frame_default;
  assert(
    "stepOfFrame: windows [S+N*k, S+N*(k+1)), the last through quit",
    stepOfFrame(e, 1, quitDefault) === 0 &&
      stepOfFrame(e, 10, quitDefault) === 0 &&
      stepOfFrame(e, 11, quitDefault) === 1 &&
      stepOfFrame(e, quitDefault, quitDefault) === e.last_step &&
      stepOfFrame(e, quitDefault + 1, quitDefault) === -1,
  );
  const lines = [
    { frame: 1, thread: "main", op: "texture_2d_create" },
    { frame: 81, thread: "other", op: "texture_2d_create" },
    { frame: 401, thread: "main", op: "free" },
  ] as ResourceLine[];
  const c = censusOf(lines, e, 400);
  assert(
    "censusOf: per-step counts with @other, teardown after quit",
    c.per_step[0].texture_2d_create === 1 &&
      c.per_step[8]["texture_2d_create@other"] === 1 &&
      c.after_quit.free === 1,
    JSON.stringify(c),
  );
  assert(
    "expectedCensus: the unsupported variant adds U1's create and two items' calls at step 0",
    expectedCensus(e, 0, quitDefault, "unsupported").texture_2d_create ===
      e.steps[0].census.texture_2d_create + 1 &&
      expectedCensus(e, 0, quitDefault, "unsupported")
        .canvas_item_set_default_texture_filter ===
        e.items_at_ready.length + 2,
  );
  assert(
    "expectedCensus: animate's per-frame updates fill the window (10 at step 1, 12 in the last)",
    expectedCensus(e, 1, quitDefault, "animate").texture_2d_update === 10 &&
      expectedCensus(e, e.last_step, quitDefault, "animate")
        .texture_2d_update === 12,
    JSON.stringify(expectedCensus(e, e.last_step, quitDefault, "animate")),
  );

  const good = Object.fromEntries(
    RESOURCE_LINE_KEYS.map((k) => [k, null]),
  ) as Record<string, unknown>;
  Object.assign(good, { frame: 1, t_us: 0, thread: "main", op: "free" });
  assert(
    "validateResourceLine: a well-formed line",
    validateResourceLine(good) === null,
  );
  const reordered = { thread: "main", frame: 1, ...good };
  assert(
    "validateResourceLine: key order matters",
    validateResourceLine(reordered) !== null,
  );
  assert(
    "validateResourceLine: unknown op",
    validateResourceLine({ ...good, op: "texture_3d_create" }) !== null,
  );
  assert(
    "parseJsonl: a broken line stops parsing",
    parseJsonl<ResourceLine>(`${JSON.stringify(good)}\n{`, validateResourceLine)
      .problem === "line 2 is not JSON",
  );

  // checkExpectedSelfConsistent on the committed file and on broken copies.
  assert(
    "expected-self-consistent passes on expected.json",
    checkExpectedSelfConsistent(e).passed,
  );
  const broken = (edit: (x: Gate2Expected) => void, name: string) => {
    const x = clone(e);
    edit(x);
    const r = checkExpectedSelfConsistent(x);
    assert(`expected-self-consistent fails: ${name}`, !r.passed, r.detail);
  };
  broken((x) => {
    x.textures.A0.fill = [50, 0, 0, 255];
  }, "a texel off the colour rule");
  broken((x) => {
    x.steps[2].synth_exclude.push("nowhere");
  }, "synth_exclude names an unknown region");
  broken((x) => {
    x.steps[1].draws[0].rect_px = [8, 8, 32, 32];
  }, "a draw outside every region, in the empty corner");
  broken((x) => {
    x.steps[7].synth_exclude = x.steps[7].synth_exclude.filter(
      (n) => n !== "sb",
    );
  }, "semi-transparent B1 sampled outside synth_exclude");
  broken((x) => {
    x.steps[3].census.texture_3d_create = 1;
  }, "an unknown census op");
  broken((x) => {
    x.steps[4].marker_rgba8 = x.steps[3].marker_rgba8;
    const m = x.steps[4].draws.find((d) => d.name === "Marker");
    if (m) m.rgba8 = x.steps[3].marker_rgba8;
  }, "two steps share a marker colour");
}

// ---------------------------------------------------------------------------------------------
// 2. Evidence-tree scenarios
// ---------------------------------------------------------------------------------------------

const H = (tag: string): string => tag.repeat(64 / tag.length).slice(0, 64);

/** The checks a passing tree reports, in order: G2a's (gate2-checks.ts), then G2b's (runG2b). */
const G2A_CHECKS = [
  "expected-self-consistent",
  "capture-armed",
  "headless-no-gpu",
  "recording-decodes",
  "step-alignment",
  "expected-image-reference",
  "reference-repeat-budget",
  "armed-transparent",
  "census",
  "hook-bytes-exact",
  "worker-thread-create",
  "replace-retires-temp",
  "viewport-defaults",
  "unsupported-variant",
  "leg-class-capture",
];
const G2B_LEGS = [
  "receiver-cold",
  "receiver-warm",
  "receiver-patch",
  "receiver-inline",
  "live-inline",
  "unsupported-textures",
  "sabotage-omit-update",
  "sabotage-omit-replace",
  "sabotage-stale-texture",
  "sabotage-wrong-hash",
  "sabotage-spurious-update",
  "sabotage-receiver-reupload",
  "sabotage-receiver-ignore-cache",
  "canvas-headless",
  "canvas-host",
  "canvas-normal",
  "sabotage-omit-canvas-filter",
];
const G2B_CHECKS = [
  "recordings-decode-2",
  "patch-resolves-to-full",
  "store-complete",
  "inline-equals-store",
  "texture-versions-current",
  "texture-invariants",
  "receiver-vs-reference",
  "expected-image-receiver",
  "transform-only-no-resource-traffic",
  "upload-accounting",
  "warm-cache",
  "fresh-cache",
  "freed-draws-default",
  "copy-at-hook",
  "unsupported-regions",
  "canvas-texture-headless-refused",
  "canvas-texture-override",
  "canvas-texture-wire",
  "canvas-normal-region",
  "live-inline",
  "receiver-consumed-stream",
  "receiver-never-loaded-fixture",
  "receiver-typed-clean",
  ...G2B_LEGS.map((leg) => `leg-class-${leg}`),
];

const G2C_LEGS = [
  "live",
  "live-warm",
  "live-replay",
  "live-headless",
  "live-stall",
  "live-reconnect",
  "live-animate",
  "sabotage-unpin",
  "sabotage-drop-resource",
  "sabotage-wrong-hash-live",
];
const G2C_CHECKS = [
  "live-tap-equals-received",
  "live-resolves-to-recording",
  "live-credit-bounded",
  "live-acks-staged",
  "live-vs-reference",
  "live-replay-equals-live",
  "http-gets-match-fetches",
  "gets-advertised",
  "fetch-before-applied",
  "pins-bounded",
  "obsolete-retired",
  "stall-newest-texture",
  "reconnect-no-refetch",
  "transform-only-no-resource-traffic-live",
  "warm-host-no-gets",
  ...G2C_LEGS.map((leg) => `leg-class-${leg}`),
];

const G2E_LEGS = ["live-auth", "sabotage-no-token", "sabotage-bad-http-token"];
const G2E_CHECKS = [
  ...G2E_LEGS.map((leg) => `leg-class-${leg}`),
  "auth-required",
  "token-not-logged",
];

/** applied.json /3, as far as the scenarios edit it. */
interface AppliedEdit {
  status: string;
  failure: { seq: number; reason: string; detail?: string } | null;
  end_seen: boolean;
  transactions: Array<{
    seq: number;
    record_sha256: string;
    rs_calls: number;
    resources: Record<string, number> | null;
  }>;
  fetches: unknown[];
  uploads: Array<{ seq: number; id: number; hash: string | null; op: string }>;
  unsupported: Array<{ reason: string }>;
  cache: { mode: string };
  resources_summary: { distinct_fetched: number };
}

async function editText(
  path: string,
  edit: (text: string) => string,
): Promise<void> {
  await writeFile(path, edit(await readFile(path, "utf8")));
}
async function editJson<T>(
  path: string,
  edit: (value: T) => void,
): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as T;
  edit(value);
  await writeJson(path, value);
}
async function editLog(
  path: string,
  edit: (lines: ResourceLine[]) => ResourceLine[],
): Promise<void> {
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l)
    .map((l) => JSON.parse(l) as ResourceLine);
  await writeText(path, jsonl(edit(lines).sort((a, b) => a.frame - b.frame)));
}

async function run(out: string): Promise<Gate2Report> {
  return runGate2(out, { expected: EXPECTED, now: new Date(0) });
}

function verdicts(report: Gate2Report): Map<string, string> {
  return new Map(report.checks.map((c) => [c.id, c.status]));
}

/** Check ids some scenario proved can fail. */
const targeted = new Set<string>();

async function scenario(
  root: string,
  good: string,
  name: string,
  perturb: (out: string) => Promise<void>,
  failing: string[],
): Promise<void> {
  const out = join(root, name);
  await cp(good, out, { recursive: true });
  await perturb(out);
  const report = await run(out);
  const v = verdicts(report);
  for (const id of failing) {
    const c = report.checks.find((x) => x.id === id);
    assert(
      `${name}: ${id} fails (${c?.detail.slice(0, 140)})`,
      v.get(id) === "fail",
      c?.detail,
    );
    if (v.get(id) === "fail") targeted.add(id);
  }
  const unexpected = report.checks.filter(
    (c) => !failing.includes(c.id) && c.status !== "pass",
  );
  assert(
    `${name}: every other check passes`,
    unexpected.length === 0,
    unexpected.map((c) => `${c.id}: ${c.detail}`).join(" | "),
  );
  assert(`${name}: the gate fails`, !report.gate_passed);
  await rm(out, { recursive: true, force: true });
}

async function main(): Promise<void> {
  EXPECTED = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate2", "expected.json"),
      "utf8",
    ),
  ) as Gate2Expected;
  pureCases();

  const MAIN: Model = buildModel(EXPECTED, { quit: CAPTURE_QUIT });
  const VARIANT: Model = buildModel(EXPECTED, {
    quit: EXPECTED.quit_frame_default,
    variant: "unsupported",
  });
  assert(
    "model: wire ids as in the real run (A=1 Atwin=2 B=3 M=4 P1=5 P2=6 hue 7, temporaries 8 9, C=10 D=11 E=12)",
    JSON.stringify([
      MAIN.ids.A,
      MAIN.ids.Atwin,
      MAIN.ids.B,
      MAIN.ids.M,
      MAIN.ids.P1,
      MAIN.ids.P2,
      MAIN.ids.HUE,
      MAIN.ids.tA,
      MAIN.ids.tB,
      MAIN.ids.C,
      MAIN.ids.D,
      MAIN.ids.E,
    ]) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    JSON.stringify(MAIN.ids),
  );
  assert(
    "model: the capture's tables name ten payloads (nine fixture contents and the hue strip)",
    MAIN.stores.length === 10,
    MAIN.stores.map((c) => c.name).join(","),
  );

  const root = await mkdtemp(join(tmpdir(), "self-test-gate2-"));
  try {
    const good = join(root, "good");
    await buildTree(good, EXPECTED);
    await buildG2cTree(good, EXPECTED);
    await buildG2eTree(good, EXPECTED);
    const report = await run(good);
    const bad = report.checks.filter((c) => c.status !== "pass");
    assert(
      "good tree: every check passes and the gate passes",
      report.gate_passed && bad.length === 0,
      bad.map((c) => `${c.id}: ${c.detail}`).join(" | "),
    );
    assert(
      "good tree: the checks are the G2a set, then the G2b set (with G2d's), then the G2c set, then the G2e set",
      [...G2A_CHECKS, ...G2B_CHECKS, ...G2C_CHECKS, ...G2E_CHECKS].join(",") ===
        report.checks.map((c) => c.id).join(","),
      report.checks.map((c) => c.id).join(","),
    );
    const misclassified = [...G2B_LEGS, ...G2C_LEGS, ...G2E_LEGS].filter(
      (leg) =>
        report.legs[leg]?.result_class !== report.legs[leg]?.expected_class,
    );
    assert(
      "good tree: the capture leg is success and every g2b, g2c, g2d and g2e leg lands in its expected class",
      report.legs.capture?.result_class === "success" &&
        misclassified.length === 0 &&
        Object.keys(report.legs).length ===
          1 + 5 + G2B_LEGS.length + 3 + G2C_LEGS.length + G2E_LEGS.length,
      `${misclassified.join(",")}; ${Object.keys(report.legs).length} legs`,
    );
    assert(
      "good tree: copy costs per shape, the store and the receivers' traffic reported",
      (report.resources?.capture?.host?.by_shape?.length ?? 0) >= 5 &&
        report.resources?.capture?.store?.hashes === 10 &&
        report.resources?.["receiver-cold"]?.receiver?.distinct_fetched === 9 &&
        report.resources?.["receiver-warm"]?.receiver?.cache_hits === 9 &&
        report.resources?.["live-inline"]?.host?.resource_records === 10,
      JSON.stringify({
        shapes: report.resources?.capture?.host?.by_shape?.length,
        store: report.resources?.capture?.store,
        cold: report.resources?.["receiver-cold"]?.receiver,
      }),
    );

    const capLog = (out: string) =>
      join(out, "capture", "evidence", "resources.jsonl");
    const armedLog = (out: string) =>
      join(out, "reference-armed", "evidence", "resources.jsonl");
    const applied = (out: string, rel: string) =>
      join(out, rel, "applied.json");
    const shot = (out: string, rel: string, step: number) =>
      join(out, rel, "shots", `seq-${stepFrames2(EXPECTED, step).settle}.png`);
    const f = (k: number) => stepFrames2(EXPECTED, k).applied;
    const tx = (a: AppliedEdit, seq: number) =>
      a.transactions.find(
        (t) => t.seq === seq,
      ) as AppliedEdit["transactions"][number];

    // ---- g2a ----------------------------------------------------------------------------
    await scenario(
      root,
      good,
      "census-transform-only-step",
      async (out) => {
        await editLog(armedLog(out), (ls) => [
          ...ls,
          line({
            frame: f(2),
            op: "texture_2d_update",
            id: 1,
            rid: texRid(1),
            version: 9,
            status: "ok",
          }),
        ]);
      },
      ["census", "hook-bytes-exact"],
    );
    await scenario(
      root,
      good,
      "census-after-quit",
      async (out) => {
        await editLog(capLog(out), (ls) => [
          ...ls,
          line({
            frame: CAPTURE_QUIT + 1,
            op: "texture_2d_placeholder_create",
          }),
        ]);
      },
      ["census"],
    );
    await scenario(
      root,
      good,
      "worker-create-on-main",
      async (out) => {
        await editLog(capLog(out), (ls) =>
          ls.map((l) => (l.thread === "other" ? { ...l, thread: "main" } : l)),
        );
      },
      // texture-invariants matches D's fixture create by thread, so D loses its id.
      [
        "census",
        "hook-bytes-exact",
        "worker-thread-create",
        "texture-invariants",
      ],
    );
    await scenario(
      root,
      good,
      "hash-mismatch-c",
      async (out) => {
        await editLog(armedLog(out), (ls) =>
          ls.map((l) =>
            l.hash === CONTENT.C.hash ? { ...l, hash: H("cf") } : l,
          ),
        );
      },
      ["hook-bytes-exact"],
    );
    await scenario(
      root,
      good,
      "engine-texture-missing",
      async (out) => {
        await editLog(armedLog(out), (ls) => ls.filter((l) => l.width !== 800));
      },
      ["census", "hook-bytes-exact"],
    );
    await scenario(
      root,
      good,
      "unexpected-content-line",
      async (out) => {
        await editLog(capLog(out), (ls) =>
          ls.map((l) => (l.width === 800 ? { ...l, width: 801 } : l)),
        );
      },
      ["hook-bytes-exact"],
    );
    await scenario(
      root,
      good,
      "replace-temp-reused",
      async (out) => {
        await editLog(capLog(out), (ls) => [
          ...ls,
          line({
            frame: f(9),
            op: "canvas_item_set_default_texture_filter",
            target: texRid(MAIN.ids.tA),
            value: 1,
          }),
        ]);
      },
      ["census", "replace-retires-temp"],
    );
    await scenario(
      root,
      good,
      "replace-by-texture-unknown",
      async (out) => {
        await editLog(capLog(out), (ls) =>
          ls.map((l) =>
            l.op === "texture_replace" && l.id === MAIN.ids.A
              ? { ...l, target: "4242" }
              : l,
          ),
        );
      },
      ["replace-retires-temp"],
    );
    await scenario(
      root,
      good,
      "viewport-default-read-wrong",
      async (out) => {
        await writeJson(join(out, "capture", "evidence", "root.json"), {
          texture_defaults: { filter: 1, repeat: 0 },
        });
      },
      ["viewport-defaults"],
    );
    await scenario(
      root,
      good,
      "viewport-call-not-root",
      async (out) => {
        await editLog(capLog(out), (ls) =>
          ls.map((l) =>
            l.op === "viewport_set_default_canvas_item_texture_filter" &&
            l.value === 2
              ? { ...l, root_viewport: false }
              : l,
          ),
        );
      },
      ["viewport-defaults"],
    );
    await scenario(
      root,
      good,
      "reference-pixel-off",
      async (out) => {
        await writeBytes(
          join(out, "reference", "shots", "step-6.png"),
          await shotPng(EXPECTED, 6, { perturb: [50, 250] }),
        );
      },
      // Every receiver is held to the reference: the faithful ones now mismatch at step 6, and
      // omit-replace's mismatching steps grow to {6,7,8,9,10}. canvas-normal and
      // sabotage-omit-canvas-filter also check their pre-step-11 checkpoints against this same
      // shared reference dir (gate2b-checks.ts's `reference` var), so step 6 catches them too.
      [
        "expected-image-reference",
        "reference-repeat-budget",
        "armed-transparent",
        "receiver-vs-reference",
        "leg-class-receiver-cold",
        "leg-class-receiver-warm",
        "leg-class-receiver-patch",
        "leg-class-receiver-inline",
        "leg-class-sabotage-omit-replace",
        // g2c: every rendered live receiver is held to the same reference.
        "live-vs-reference",
        "stall-newest-texture",
        "leg-class-live",
        "leg-class-live-warm",
        "leg-class-live-replay",
        "leg-class-live-stall",
        "leg-class-live-reconnect",
        "leg-class-live-animate",
        "canvas-normal-region",
        "leg-class-canvas-host",
        "leg-class-sabotage-omit-canvas-filter",
      ],
    );
    await scenario(
      root,
      good,
      "armed-pixel-off",
      async (out) => {
        await writeBytes(
          join(out, "reference-armed", "shots", "step-2.png"),
          await shotPng(EXPECTED, 2, { perturb: [100, 300] }),
        );
      },
      ["armed-transparent"],
    );
    await scenario(
      root,
      good,
      "repeat-pixel-off-outside-exclusions",
      async (out) => {
        await writeBytes(
          join(out, "reference-repeat", "shots", "step-0.png"),
          await shotPng(EXPECTED, 0, { perturb: [210, 50] }),
        );
      },
      ["reference-repeat-budget"],
    );
    await scenario(
      root,
      good,
      "variant-no-unknown-rid",
      async (out) => {
        await writeCounters(
          join(out, "capture-unsupported"),
          EXPECTED.quit_frame_default,
          {
            rect: VARIANT.drawn.rect,
            region: VARIANT.drawn.region.filter((r) => r !== PRE_RID),
          },
        );
      },
      ["unsupported-variant"],
    );
    await scenario(
      root,
      good,
      "variant-u1-copied",
      async (out) => {
        await editLog(
          join(out, "capture-unsupported", "evidence", "resources.jsonl"),
          (ls) =>
            ls.map((l) =>
              l.format === "RGBAF" ? { ...l, copy_ns: 1, hash_ns: 1 } : l,
            ),
        );
      },
      ["unsupported-variant"],
    );
    await scenario(
      root,
      good,
      "capture-draws-unknown-rid",
      async (out) => {
        await writeCounters(join(out, "capture"), CAPTURE_QUIT, {
          rect: [...MAIN.drawn.rect, "4242"],
          region: MAIN.drawn.region,
        });
      },
      ["unsupported-variant"],
    );
    await scenario(
      root,
      good,
      "capture-no-texture-rect",
      async (out) => {
        // A whole tree whose fixture draws no add_texture_rect, every leg consistent with it.
        await rm(out, { recursive: true, force: true });
        await buildTree(out, EXPECTED, { noTextureRect: true });
        await buildG2cTree(out, EXPECTED);
        await buildG2eTree(out, EXPECTED);
      },
      ["leg-class-capture"],
    );
    await scenario(
      root,
      good,
      "capture-hook-omitted",
      async (out) => {
        await writeBytes(
          join(out, "capture", "recording.rs2"),
          encodeSink(MAIN.states, "full", {
            hooksPlanned: GATE0_HOOKS.filter((h) => h !== "texture_replace"),
          }),
        );
      },
      ["capture-armed"],
    );
    await scenario(
      root,
      good,
      "capture-recording-without-end",
      async (out) => {
        await writeBytes(
          join(out, "capture", "recording.rs2"),
          encodeSink(MAIN.states, "full", { noEnd: true }),
        );
      },
      // Every leg replaying the capture's full sink classifies capture-failure.
      [
        "recording-decodes",
        "recordings-decode-2",
        "leg-class-capture",
        "leg-class-receiver-cold",
        "leg-class-receiver-warm",
        "leg-class-sabotage-receiver-reupload",
        "leg-class-sabotage-receiver-ignore-cache",
      ],
    );
    await scenario(
      root,
      good,
      "capture-holds-gpu-fd",
      async (out) => {
        await appendFile(
          join(out, "capture", "fd.txt"),
          "lrwx------ 1 u u 64 Oct  9 10:00 9 -> /dev/dri/renderD128\n",
        );
      },
      ["headless-no-gpu"],
    );
    await scenario(
      root,
      good,
      "step-log-shifted",
      async (out) => {
        await editText(join(out, "reference-armed", "steps.jsonl"), (t) =>
          t.replace('"applied_frame":31', '"applied_frame":32'),
        );
      },
      ["step-alignment"],
    );
    await scenario(
      root,
      good,
      "resource-log-key-order",
      async (out) => {
        await editText(capLog(out), (t) =>
          t.replace('{"frame":1,"t_us":1000,', '{"t_us":1000,"frame":1,'),
        );
      },
      [
        "census",
        "hook-bytes-exact",
        "worker-thread-create",
        "replace-retires-temp",
        "viewport-defaults",
        "unsupported-variant",
      ],
    );

    // ---- g2b: captures, store, inline ---------------------------------------------------
    await scenario(
      root,
      good,
      "inline-patch-without-end",
      async (out) => {
        await writeBytes(
          join(out, "capture-inline", "recording-patch.rs2"),
          encodeSink(MAIN.states, "patch", {
            resources: INLINE_RESOURCES,
            noEnd: true,
          }),
        );
      },
      ["recordings-decode-2"],
    );
    await scenario(
      root,
      good,
      "patch-sink-diverges",
      async (out) => {
        await writeBytes(
          join(out, "capture-unsupported", "recording-patch.rs2"),
          encodeSink(VARIANT.states, "patch", {
            mutatePatch: (seq, s) =>
              seq === 50
                ? {
                    ...s,
                    items: s.items.map((it) =>
                      it.id === 1 ? { ...it, modulate: [1, 1, 1, 0.5] } : it,
                    ),
                  }
                : s,
          }),
        );
      },
      ["patch-resolves-to-full"],
    );
    await scenario(
      root,
      good,
      "store-file-corrupt",
      async (out) => {
        const path = join(
          out,
          "capture",
          "store",
          "sha256",
          `${CONTENT.A1.hash}.grt`,
        );
        const bytes = await readFile(path);
        bytes[bytes.length - 1] ^= 0xff;
        await writeFile(path, bytes);
      },
      // capture-inline's payload of that hash no longer equals the store's file either.
      ["store-complete", "inline-equals-store"],
    );
    await scenario(
      root,
      good,
      "store-holds-a-stray-payload",
      async (out) => {
        const stray = texturePayload(
          "RGBA8",
          1,
          1,
          false,
          new Uint8Array([1, 2, 3, 4]),
        );
        const { createHash } = await import("node:crypto");
        const hash = createHash("sha256").update(stray).digest("hex");
        await writeBytes(
          join(out, "capture-unsupported", "store", "sha256", `${hash}.grt`),
          stray,
        );
      },
      ["store-complete"],
    );
    await scenario(
      root,
      good,
      "store-index-short",
      async (out) => {
        await editText(join(out, "capture", "store", "index.jsonl"), (t) =>
          t.split("\n").slice(1).join("\n"),
        );
      },
      ["store-complete"],
    );
    await scenario(
      root,
      good,
      "store-index-wrong-bytes",
      async (out) => {
        await editText(join(out, "capture", "store", "index.jsonl"), (t) =>
          t.replace(/"bytes":(\d+)/, (_m, n) => `"bytes":${Number(n) + 1}`),
        );
      },
      ["store-complete"],
    );
    await scenario(
      root,
      good,
      "store-index-duplicate-line",
      async (out) => {
        await editText(join(out, "capture", "store", "index.jsonl"), (t) => {
          const lines = t.split("\n").filter((l) => l !== "");
          return `${[lines[0], ...lines].join("\n")}\n`;
        });
      },
      ["store-complete"],
    );
    await scenario(
      root,
      good,
      "live-host-recording-truncated",
      async (out) => {
        const path = join(out, "live-inline", "host", "recording.rs2");
        const bytes = await readFile(path);
        await writeFile(path, bytes.subarray(0, bytes.length - 3));
      },
      // A recording that no longer resolves also fails every check that reads its states.
      [
        "recordings-decode-2",
        "patch-resolves-to-full",
        "texture-versions-current",
        "live-inline",
        "leg-class-live-inline",
      ],
    );
    await scenario(
      root,
      good,
      "warm-cache-another-dir",
      async (out) => {
        await editJson<{ cache: { dir: string } }>(
          join(out, "receiver-warm", "applied.json"),
          (a) => {
            a.cache.dir = a.cache.dir.replace(
              "receiver-cold",
              "receiver-other",
            );
          },
        );
      },
      ["warm-cache"],
    );
    await scenario(
      root,
      good,
      "inline-capture-wrote-a-store",
      async (out) => {
        await writeText(
          join(out, "capture-inline", "store", "index.jsonl"),
          "",
        );
      },
      ["inline-equals-store"],
    );
    await scenario(
      root,
      good,
      "texture-version-off-the-log",
      async (out) => {
        const bumped = VARIANT.states.map((s) => ({
          ...s,
          textures: s.textures?.map((t) =>
            t.id === VARIANT.ids.HUE ? { ...t, version: 2 } : t,
          ),
        }));
        const dir = join(out, "capture-unsupported");
        await writeBytes(
          join(dir, "recording.rs2"),
          encodeSink(bumped, "full"),
        );
        await writeBytes(
          join(dir, "recording-patch.rs2"),
          encodeSink(bumped, "patch"),
        );
      },
      // The unsupported leg's capture now diverges from its hook log: capture-failure.
      ["texture-versions-current", "leg-class-unsupported-textures"],
    );
    await scenario(
      root,
      good,
      "fixture-log-loses-atwin",
      async (out) => {
        await editText(join(out, "capture", "textures.jsonl"), (t) =>
          t.replaceAll('"name":"Atwin"', '"name":"Atwin2"'),
        );
      },
      ["texture-invariants"],
    );

    // ---- g2b: receivers -----------------------------------------------------------------
    await scenario(
      root,
      good,
      "receiver-inline-pixel-off",
      async (out) => {
        await writeBytes(
          shot(out, "receiver-inline", 3),
          await shotPng(EXPECTED, 3, { perturb: [600, 300] }),
        );
      },
      ["receiver-vs-reference", "leg-class-receiver-inline"],
    );
    await scenario(
      root,
      good,
      "receiver-cold-pixel-off-the-synthesis",
      async (out) => {
        await writeBytes(
          shot(out, "receiver-cold", 0),
          await shotPng(EXPECTED, 0, { perturb: [210, 50] }),
        );
      },
      [
        "receiver-vs-reference",
        "expected-image-receiver",
        "warm-cache",
        "leg-class-receiver-cold",
      ],
    );
    await scenario(
      root,
      good,
      "receiver-warm-uploads-in-a-transform-only-window",
      async (out) => {
        await editJson<AppliedEdit>(applied(out, "receiver-warm"), (a) => {
          const r = tx(a, f(2) + 4).resources as Record<string, number>;
          r.updated = 1;
          r.upload_bytes = 1024;
        });
      },
      ["transform-only-no-resource-traffic", "leg-class-receiver-warm"],
    );
    await scenario(
      root,
      good,
      "patch-sink-resends-textures-in-a-transform-only-window",
      async (out) => {
        await writeBytes(
          join(out, "capture", "recording-patch.rs2"),
          encodeSink(MAIN.states, "patch", { fullAt: [f(2) + 4] }),
        );
      },
      // Every leg on the capture sees the traffic; receiver-patch also replayed other records.
      [
        "transform-only-no-resource-traffic",
        "leg-class-receiver-cold",
        "leg-class-receiver-warm",
        "leg-class-receiver-patch",
      ],
    );
    await scenario(
      root,
      good,
      "receiver-patch-misses-a-create",
      async (out) => {
        await editJson<AppliedEdit>(applied(out, "receiver-patch"), (a) => {
          (tx(a, f(9)).resources as Record<string, number>).created = 0;
        });
      },
      ["upload-accounting"],
    );
    await scenario(
      root,
      good,
      "receiver-warm-rs-calls-differ",
      async (out) => {
        await editJson<AppliedEdit>(applied(out, "receiver-warm"), (a) => {
          tx(a, 5).rs_calls += 1;
        });
      },
      ["warm-cache"],
    );
    await scenario(
      root,
      good,
      "receiver-warm-fetches",
      async (out) => {
        const cold = JSON.parse(
          await readFile(applied(out, "receiver-cold"), "utf8"),
        ) as AppliedEdit;
        await editJson<AppliedEdit>(applied(out, "receiver-warm"), (a) => {
          a.fetches = cold.fetches;
          a.resources_summary.distinct_fetched = 9;
        });
      },
      ["warm-cache", "leg-class-receiver-warm"],
    );
    await scenario(
      root,
      good,
      "receiver-cold-cache-file-missing",
      async (out) => {
        const dir = join(out, "receiver-cold", "cache", "sha256");
        await unlink(join(dir, (await readdir(dir))[0]));
      },
      ["fresh-cache"],
    );
    await scenario(
      root,
      good,
      "freed-p1-not-white",
      async (out) => {
        await writeBytes(
          shot(out, "receiver-cold", 8),
          await shotPng(EXPECTED, 8, { perturb: [440, 50] }),
        );
      },
      [
        "freed-draws-default",
        "receiver-vs-reference",
        "expected-image-receiver",
        "warm-cache",
        "leg-class-receiver-cold",
      ],
    );
    await scenario(
      root,
      good,
      "s3-not-c-pre-fill",
      async (out) => {
        await writeBytes(
          shot(out, "receiver-cold", 8),
          await shotPng(EXPECTED, 8, { perturb: [320, 40] }),
        );
      },
      [
        "copy-at-hook",
        "receiver-vs-reference",
        "expected-image-receiver",
        "warm-cache",
        "leg-class-receiver-cold",
      ],
    );
    await scenario(
      root,
      good,
      "unsupported-receiver-draws-u1-u2",
      async (out) => {
        await writeBytes(
          shot(out, join("unsupported-textures", "receiver"), 4),
          await shotPng(EXPECTED, 4, { variant: "unsupported" }),
        );
      },
      ["unsupported-regions"],
    );
    await scenario(
      root,
      good,
      "live-summary-miscounts",
      async (out) => {
        await editJson<{ connections: Array<{ resource_records: number }> }>(
          join(out, "live-inline", "host", "evidence", "live-summary.json"),
          (s) => {
            s.connections[0].resource_records -= 1;
          },
        );
      },
      ["live-inline"],
    );
    await scenario(
      root,
      good,
      "trace-receiver-copy-differs",
      async (out) => {
        await appendFile(
          join(out, "receiver-headless-trace", "recording.rs2"),
          Buffer.from([0]),
        );
      },
      ["receiver-consumed-stream"],
    );
    await scenario(
      root,
      good,
      "trace-receiver-opens-the-fixture",
      async (out) => {
        await appendFile(
          join(out, "receiver-headless-trace", "strace.txt"),
          '7 10:00:01.000000 openat(AT_FDCWD, "/repo/experiments/render-stream/fixtures/gate2/gate2.tscn", O_RDONLY) = 9\n',
        );
      },
      ["receiver-never-loaded-fixture"],
    );
    await scenario(
      root,
      good,
      "receiver-script-error",
      async (out) => {
        await appendFile(
          join(out, "sabotage-stale-texture", "receiver", "stdout.log"),
          "SCRIPT ERROR: Invalid call. Nonexistent function 'apply'.\n",
        );
      },
      ["receiver-typed-clean"],
    );

    // ---- g2b: leg classes ---------------------------------------------------------------
    await scenario(
      root,
      good,
      "receiver-cold-reuploads",
      async (out) => {
        await editJson<AppliedEdit>(applied(out, "receiver-cold"), (a) => {
          const u = a.uploads.find(
            (x) => x.seq === f(6) && x.op === "update",
          ) as AppliedEdit["uploads"][number];
          a.uploads.splice(a.uploads.indexOf(u) + 1, 0, {
            ...u,
            seq: f(6) + 1,
          });
        });
      },
      ["leg-class-receiver-cold", "warm-cache"],
    );
    await scenario(
      root,
      good,
      "receiver-patch-record-hash-differs",
      async (out) => {
        await editJson<AppliedEdit>(applied(out, "receiver-patch"), (a) => {
          tx(a, 10).record_sha256 = H("ab");
        });
      },
      ["leg-class-receiver-patch"],
    );
    await scenario(
      root,
      good,
      "receiver-inline-replay-failure",
      async (out) => {
        await editJson<AppliedEdit>(applied(out, "receiver-inline"), (a) => {
          a.status = "replay-failure";
          a.failure = { seq: CAPTURE_QUIT, reason: "meta-json" };
        });
      },
      ["leg-class-receiver-inline"],
    );
    await scenario(
      root,
      good,
      "live-receiver-end-not-seen",
      async (out) => {
        await editJson<AppliedEdit>(
          applied(out, join("live-inline", "receiver")),
          (a) => {
            a.end_seen = false;
          },
        );
      },
      ["leg-class-live-inline"],
    );
    await scenario(
      root,
      good,
      "unsupported-receiver-no-unsupported-texture",
      async (out) => {
        await editJson<AppliedEdit>(
          applied(out, join("unsupported-textures", "receiver")),
          (a) => {
            a.unsupported = a.unsupported.filter(
              (u) => u.reason !== "unsupported-texture",
            );
          },
        );
      },
      ["leg-class-unsupported-textures"],
    );
    await scenario(
      root,
      good,
      "omit-update-mismatches-at-step-7-too",
      async (out) => {
        await writeBytes(
          shot(out, join("sabotage-omit-update", "receiver"), 7),
          await shotPng(EXPECTED, 7, { perturb: [600, 300] }),
        );
      },
      ["leg-class-sabotage-omit-update"],
    );
    await scenario(
      root,
      good,
      "omit-replace-matches-at-step-10",
      async (out) => {
        await writeBytes(
          shot(out, join("sabotage-omit-replace", "receiver"), 10),
          await shotPng(EXPECTED, 10),
        );
      },
      ["leg-class-sabotage-omit-replace"],
    );
    await scenario(
      root,
      good,
      "stale-texture-capture-agrees-with-its-log",
      async (out) => {
        // The hook log marks A's update as dropped: the stale table no longer diverges.
        await editLog(
          join(
            out,
            "sabotage-stale-texture",
            "capture",
            "evidence",
            "resources.jsonl",
          ),
          (ls) =>
            ls.map((l) =>
              l.op === "texture_2d_update" && l.id === MAIN.ids.A
                ? { ...l, sabotage: true, omitted: true }
                : l,
            ),
        );
      },
      ["leg-class-sabotage-stale-texture"],
    );
    await scenario(
      root,
      good,
      "wrong-hash-fails-at-another-seq",
      async (out) => {
        await editJson<AppliedEdit>(
          applied(out, join("sabotage-wrong-hash", "receiver")),
          (a) => {
            (a.failure as { seq: number }).seq = f(6) + 1;
          },
        );
      },
      ["leg-class-sabotage-wrong-hash"],
    );
    await scenario(
      root,
      good,
      "spurious-update-not-logged",
      async (out) => {
        await editLog(
          join(
            out,
            "sabotage-spurious-update",
            "capture",
            "evidence",
            "resources.jsonl",
          ),
          (ls) => ls.filter((l) => l.sabotage !== true),
        );
      },
      ["leg-class-sabotage-spurious-update"],
    );
    await scenario(
      root,
      good,
      "reupload-receiver-uploads-once",
      async (out) => {
        await cp(
          applied(out, "receiver-cold"),
          applied(out, join("sabotage-receiver-reupload", "receiver")),
        );
      },
      ["leg-class-sabotage-receiver-reupload"],
    );
    await scenario(
      root,
      good,
      "ignore-cache-receiver-has-a-fresh-cache",
      async (out) => {
        await editJson<AppliedEdit>(
          applied(out, join("sabotage-receiver-ignore-cache", "receiver")),
          (a) => {
            a.cache.mode = "fresh";
          },
        );
      },
      ["leg-class-sabotage-receiver-ignore-cache"],
    );

    // ---- g2c: live resources over HTTP ---------------------------------------------------
    const liveApplied = (out: string, leg: string) =>
      leg === "live-replay"
        ? join(out, leg, "applied.json")
        : join(out, leg, "receiver", "applied.json");
    type LiveAppliedEdit = {
      status: string;
      failure: { seq: number; reason: string; detail?: string } | null;
      end_seen: boolean;
      transactions: Array<{
        stream: number;
        seq: number;
        frame: number;
        received_us: number | null;
        applied_us: number | null;
        resources: Record<string, number> | null;
      }>;
      fetches: Array<{
        stream: number;
        seq: number;
        hash: string;
        end_us: number;
        headers: Record<string, string>;
      }>;
      live: { stall: { after_frame: number } | null };
    };
    const editLive = (
      out: string,
      leg: string,
      edit: (a: LiveAppliedEdit) => void,
    ) => editJson<LiveAppliedEdit>(liveApplied(out, leg), edit);
    const hostLog = (out: string, leg: string) =>
      join(out, leg, "host", "evidence", "resources.jsonl");
    await scenario(
      root,
      good,
      "live-received-short",
      async (out) => {
        const path = join(out, "live", "receiver", "received.rs2");
        const bytes = await readFile(path);
        await writeBytes(path, bytes.subarray(0, bytes.length - 10));
      },
      ["live-tap-equals-received", "leg-class-live"],
    );
    await scenario(
      root,
      good,
      "live-tap-not-the-recording",
      async (out) => {
        // The tap (and what the receiver read) carries, at one frame, a state the host's full
        // recording does not hold there: the marker one step early.
        const model = buildModel(EXPECTED, {
          quit: EXPECTED.quit_frame_default,
        });
        const sends = Array.from(
          { length: EXPECTED.quit_frame_default - 4 },
          (_, i) => i + 5,
        );
        const states = sends.map((f) => model.states[f - 1]);
        states[25] = { ...model.states[40], frame: states[25].frame };
        const tap = encodeSink(states, "patch", {
          sessionId: "0123456789abcdef0123456789abc0de",
          transport: "websocket",
          connection: 1,
          resources: HTTP_RESOURCES,
        });
        await writeBytes(join(out, "live", "host", "tap", "stream-1.rs2"), tap);
        await writeBytes(join(out, "live", "receiver", "received.rs2"), tap);
      },
      ["live-resolves-to-recording", "leg-class-live"],
    );
    await scenario(
      root,
      good,
      "live-two-in-flight",
      async (out) => {
        await editText(join(out, "live", "host", "tap", "live-1.jsonl"), (t) =>
          t
            .split("\n")
            .filter(
              (l) => !(l.includes('"event":"ack"') && l.includes('"seq":10,')),
            )
            .join("\n"),
        );
      },
      ["live-credit-bounded", "leg-class-live"],
    );
    await scenario(
      root,
      good,
      "live-acks-unordered",
      async (out) => {
        await editLive(out, "live", (a) => {
          const t = a.transactions[19];
          t.applied_us = (t.received_us ?? 0) - 1;
        });
      },
      ["live-acks-staged"],
    );
    await scenario(
      root,
      good,
      "live-get-unadvertised",
      async (out) => {
        await editLog(hostLog(out, "live"), (ls) => [
          ...ls,
          line({
            frame: 15,
            thread: "other",
            op: "http-get",
            hash: CONTENT.E.hash,
            payload_bytes: CONTENT.E.payload.length,
            conn: 1,
            http_status: 200,
          }),
        ]);
      },
      ["http-gets-match-fetches", "gets-advertised", "leg-class-live"],
    );
    await scenario(
      root,
      good,
      "live-fetch-after-applied",
      async (out) => {
        await editLive(out, "live", (a) => {
          const f = a.fetches[0];
          const t = a.transactions.find((x) => x.seq === f.seq);
          f.end_us = (t?.applied_us ?? 0) + 1;
        });
      },
      ["fetch-before-applied"],
    );
    await scenario(
      root,
      good,
      "live-cache-control-wrong",
      async (out) => {
        await editLive(out, "live", (a) => {
          a.fetches[0].headers["Cache-Control"] = "no-cache";
        });
      },
      ["http-gets-match-fetches"],
    );
    await scenario(
      root,
      good,
      "live-pin-missing",
      async (out) => {
        await editLog(hostLog(out, "live"), (ls) =>
          ls.filter((l) => !(l.op === "pin" && l.hash === CONTENT.A1.hash)),
        );
      },
      ["pins-bounded"],
    );
    await scenario(
      root,
      good,
      "live-never-retired",
      async (out) => {
        await editLog(hostLog(out, "live"), (ls) =>
          ls.filter((l) => !(l.op === "retire" && l.hash === CONTENT.A1.hash)),
        );
      },
      ["pins-bounded", "obsolete-retired"],
    );
    await scenario(
      root,
      good,
      "live-stall-misses-step-6",
      async (out) => {
        await editLive(out, "live-stall", (a) => {
          if (a.live.stall)
            a.live.stall.after_frame = stepFrames2(EXPECTED, 6).applied + 1;
        });
      },
      ["stall-newest-texture"],
    );
    await scenario(
      root,
      good,
      "live-reconnect-refetches",
      async (out) => {
        await editLive(out, "live-reconnect", (a) => {
          const first = a.transactions.find((t) => t.stream === 2);
          if (first?.resources) first.resources.fetched = 1;
        });
      },
      ["reconnect-no-refetch"],
    );
    await scenario(
      root,
      good,
      "live-transform-only-hit",
      async (out) => {
        await editLive(out, "live", (a) => {
          const t = a.transactions.find(
            (x) => x.frame === stepFrames2(EXPECTED, 2).applied + 3,
          );
          if (t?.resources) t.resources.cache_hits = 1;
        });
      },
      ["transform-only-no-resource-traffic-live", "leg-class-live"],
    );
    await scenario(
      root,
      good,
      "live-warm-host-gets",
      async (out) => {
        await editLog(hostLog(out, "live-warm"), (ls) => [
          ...ls,
          line({
            frame: 7,
            thread: "other",
            op: "http-get",
            hash: CONTENT.A0.hash,
            payload_bytes: CONTENT.A0.payload.length,
            conn: 1,
            http_status: 200,
          }),
        ]);
      },
      ["http-gets-match-fetches", "warm-host-no-gets"],
    );
    await scenario(
      root,
      good,
      "live-replay-state-differs",
      async (out) => {
        const shot = (
          JSON.parse(await readFile(liveApplied(out, "live"), "utf8")) as {
            shots: Array<{ seq: number }>;
          }
        ).shots[3];
        await writeText(
          join(out, "live-replay", "state", `seq-${shot.seq}.json`),
          "{}",
        );
      },
      ["live-replay-equals-live"],
    );
    await scenario(
      root,
      good,
      "live-replay-fails",
      async (out) => {
        await editLive(out, "live-replay", (a) => {
          a.status = "replay-failure";
          a.failure = { seq: 3, reason: "resource-unavailable" };
        });
      },
      ["live-vs-reference", "live-replay-equals-live", "leg-class-live-replay"],
    );
    await scenario(
      root,
      good,
      "live-headless-fails",
      async (out) => {
        await editLive(out, "live-headless", (a) => {
          a.status = "replay-failure";
          a.failure = { seq: 9, reason: "resource-invalid" };
        });
      },
      ["leg-class-live-headless"],
    );
    await scenario(
      root,
      good,
      "live-animate-anim-off",
      async (out) => {
        const a = JSON.parse(
          await readFile(liveApplied(out, "live-animate"), "utf8"),
        ) as { shots: Array<{ seq: number; step: number }> };
        const s = a.shots[2];
        const tx = (
          JSON.parse(
            await readFile(liveApplied(out, "live-animate"), "utf8"),
          ) as {
            transactions: Array<{ seq: number; frame: number }>;
          }
        ).transactions.find((t) => t.seq === s.seq);
        // The ANIM content of the next frame: right everywhere except the anim region.
        await writeBytes(
          join(out, "live-animate", "receiver", "shots", `seq-${s.seq}.png`),
          await shotPng(EXPECTED, s.step, {
            variant: "animate",
            frame: (tx?.frame ?? 0) + 1,
          }),
        );
      },
      ["live-vs-reference", "leg-class-live-animate"],
    );
    await scenario(
      root,
      good,
      "sabotage-unpin-served",
      async (out) => {
        await editLive(out, "sabotage-unpin", (a) => {
          a.failure = { seq: 1, reason: "resource-invalid" };
        });
      },
      ["leg-class-sabotage-unpin"],
    );
    await scenario(
      root,
      good,
      "sabotage-drop-resource-late",
      async (out) => {
        await editLive(out, "sabotage-drop-resource", (a) => {
          if (a.failure) a.failure.seq += 1;
        });
      },
      ["fetch-before-applied", "leg-class-sabotage-drop-resource"],
    );
    await scenario(
      root,
      good,
      "sabotage-wrong-hash-live-unavailable",
      async (out) => {
        await editLive(out, "sabotage-wrong-hash-live", (a) => {
          if (a.failure) a.failure.reason = "resource-unavailable";
        });
      },
      ["leg-class-sabotage-wrong-hash-live"],
    );

    // ---- g2d: CanvasTexture (gate2-design.md G2d) ----------------------------------------
    await scenario(
      root,
      good,
      "canvas-override-pixel-off",
      async (out) => {
        // A pixel inside region sc of canvas-host's own rendered step-11 frame (shifted by step
        // 10's canvas_transform, never reset): only canvas-texture-override reads that frame.
        await writeBytes(
          join(out, "canvas-host", "capture", "shots", "step-11.png"),
          await shotPng(EXPECTED, 11, { perturb: [220, 140] }),
        );
      },
      ["canvas-texture-override"],
    );
    await scenario(
      root,
      good,
      "canvas-wire-ct-unresolvable",
      async (out) => {
        // textureIdsByName can no longer resolve "CT" on canvas-host: isolated to
        // canvas-texture-wire, since no other check reads canvas-host's fixture log by name.
        await editText(
          join(out, "canvas-host", "capture", "textures.jsonl"),
          (t) =>
            t
              .split("\n")
              .filter((l) => !l.includes('"name":"CT"'))
              .join("\n"),
        );
      },
      ["canvas-texture-wire"],
    );
    await scenario(
      root,
      good,
      "canvas-headless-receiver-silent",
      async (out) => {
        // The headless receiver drew nothing for SC but reported nothing either: the refusal
        // must be visible on the receiver side too. The recording still refuses, so the leg
        // stays unsupported.
        await editJson<{ unsupported: unknown[] }>(
          join(out, "canvas-headless", "receiver", "applied.json"),
          (a) => {
            a.unsupported = [];
          },
        );
      },
      ["canvas-texture-headless-refused"],
    );
    await scenario(
      root,
      good,
      "canvas-headless-hook-line-ok",
      async (out) => {
        // A canvas_texture_create hook line that claims success on a headless host.
        await editLog(
          join(
            out,
            "canvas-headless",
            "capture",
            "evidence",
            "resources.jsonl",
          ),
          (ls) =>
            ls.map((l) =>
              l.op === "canvas_texture_create"
                ? { ...l, status: "ok", reason: null }
                : l,
            ),
        );
      },
      ["canvas-texture-headless-refused"],
    );
    await scenario(
      root,
      good,
      "canvas-headless-capture-not-armed",
      async (out) => {
        await editJson<{ status: string }>(
          join(out, "canvas-headless", "capture", "evidence", "result.json"),
          (r) => {
            r.status = "disarmed";
          },
        );
      },
      ["leg-class-canvas-headless"],
    );
    await scenario(
      root,
      good,
      "canvas-host-pixel-off",
      async (out) => {
        await writeBytes(
          shot(out, join("canvas-host", "receiver"), 5),
          await shotPng(EXPECTED, 5, { perturb: [210, 130] }),
        );
      },
      ["leg-class-canvas-host"],
    );
    await scenario(
      root,
      good,
      "canvas-normal-mismatches-before-step-11",
      async (out) => {
        // A pixel well outside region sc, before SC has a texture at all: canvas-normal-region
        // expects 0 px differ for every step < 11, so this is isolated to it alone --
        // leg-class-canvas-normal's checkpoints are [] (gate2b-checks.ts's "canvas-normal" input),
        // so a pixel-mismatch here never reaches classification.
        await writeBytes(
          shot(out, join("canvas-normal", "receiver"), 5),
          await shotPng(EXPECTED, 5, { perturb: [600, 300] }),
        );
      },
      ["canvas-normal-region"],
    );
    await scenario(
      root,
      good,
      "canvas-normal-capture-not-armed",
      async (out) => {
        // canvas-normal's "unsupported" class comes from the recording's own unsupported entry
        // (SC's draw), not applied.json (which carries none here, unlike unsupported-textures'
        // receiver-side one) -- so flip the one thing that outranks it in G2B_PRECEDENCE instead:
        // capture-failure. No other check reads this leg's own capture evidence.
        await editJson<{ status: string }>(
          join(out, "canvas-normal", "capture", "evidence", "result.json"),
          (r) => {
            r.status = "disarmed";
          },
        );
      },
      ["leg-class-canvas-normal"],
    );
    await scenario(
      root,
      good,
      "omit-canvas-filter-matches-at-step-11",
      async (out) => {
        // Same pattern as omit-replace-matches-at-step-10: replace the one step where the
        // sabotage is supposed to show with the unperturbed reference, so the predicted
        // mismatching step set {11} no longer holds.
        await writeBytes(
          shot(out, join("sabotage-omit-canvas-filter", "receiver"), 11),
          await shotPng(EXPECTED, 11),
        );
      },
      ["leg-class-sabotage-omit-canvas-filter"],
    );

    // ---- g2e: bearer-token authorization (gate2-design.md G2e) ---------------------------
    await scenario(
      root,
      good,
      "g2e-token-logged",
      async (out) => {
        await appendFile(
          join(out, "live-auth", "receiver", "stdout.log"),
          `[receiver] token ${g2eToken("live-auth")}\n`,
        );
      },
      ["token-not-logged"],
    );
    await scenario(
      root,
      good,
      "g2e-token-file-missing",
      async (out) => {
        await unlink(
          join(out, "sabotage-no-token", "host", "evidence", "live-token"),
        );
      },
      ["token-not-logged"],
    );
    await scenario(
      root,
      good,
      "g2e-upgrade-not-refused",
      async (out) => {
        // The receiver still reports live-connect-failed, but the host never logged the 401.
        await writeText(
          join(out, "sabotage-no-token", "host", "stdout.log"),
          "[fixture] gate2 ready\n",
        );
      },
      ["auth-required"],
    );
    await scenario(
      root,
      good,
      "g2e-live-auth-get-401",
      async (out) => {
        await editLog(hostLog(out, "live-auth"), (ls) => [
          ...ls,
          line({
            frame: 7,
            thread: "other",
            op: "http-get",
            hash: CONTENT.A0.hash,
            payload_bytes: 0,
            conn: 1,
            http_status: 401,
          }),
        ]);
      },
      ["auth-required"],
    );
    await scenario(
      root,
      good,
      "g2e-live-auth-fails",
      async (out) => {
        await editLive(out, "live-auth", (a) => {
          a.status = "replay-failure";
          a.failure = { seq: 3, reason: "resource-unavailable" };
        });
      },
      ["leg-class-live-auth"],
    );
    await scenario(
      root,
      good,
      "g2e-no-token-connects",
      async (out) => {
        await editLive(out, "sabotage-no-token", (a) => {
          a.status = "ok";
          a.failure = null;
          a.end_seen = true;
        });
      },
      ["leg-class-sabotage-no-token"],
    );
    await scenario(
      root,
      good,
      "g2e-bad-http-token-wrong-reason",
      async (out) => {
        await editLive(out, "sabotage-bad-http-token", (a) => {
          if (a.failure) a.failure.reason = "resource-hash-mismatch";
        });
      },
      ["leg-class-sabotage-bad-http-token"],
    );

    // Every check of a passing tree is failed by some scenario (expected-self-consistent by
    // the pure cases).
    const never = report.checks
      .map((c) => c.id)
      .filter((id) => id !== "expected-self-consistent" && !targeted.has(id));
    assert(
      "every check and leg class is failed by at least one scenario",
      never.length === 0,
      never.join(", "),
    );

    // Groups not run: their checks are not-run and the gate fails.
    const g2aOnly = join(root, "g2a-only");
    await cp(good, g2aOnly, { recursive: true });
    const LATER = ["group-g2b", "group-g2c", "group-g2d", "group-g2e"];
    await writeJson(join(g2aOnly, "legs.json"), {
      groups_run: ["g2a"],
      groups_landed: ["g2a", "g2b", "g2c", "g2d", "g2e"],
    });
    const onlyA = await run(g2aOnly);
    assert(
      "g2b-g2e not run: group-g2b..group-g2e are not-run, the g2a checks pass and the gate fails",
      !onlyA.gate_passed &&
        LATER.every((id) =>
          onlyA.checks.some((c) => c.id === id && c.status === "not-run"),
        ) &&
        onlyA.checks
          .filter((c) => !LATER.includes(c.id))
          .map((c) => `${c.id}:${c.status}`)
          .join(",") === G2A_CHECKS.map((id) => `${id}:pass`).join(","),
      onlyA.checks.map((c) => `${c.id}:${c.status}`).join(","),
    );
    // g2b without g2d: G2d's legs and canvas-normal-region are not judged at all, every g2b
    // check passes, and group-g2d is not-run.
    const noG2d = join(root, "no-g2d");
    await cp(good, noG2d, { recursive: true });
    for (const leg of [
      "canvas-headless",
      "canvas-host",
      "canvas-normal",
      "sabotage-omit-canvas-filter",
    ])
      await rm(join(noG2d, leg), { recursive: true, force: true });
    await writeJson(join(noG2d, "legs.json"), {
      groups_run: ["g2a", "g2b", "g2c", "g2e"],
      groups_landed: ["g2a", "g2b", "g2c", "g2d", "g2e"],
    });
    const withoutD = await run(noG2d);
    const g2dIds = [
      "canvas-texture-headless-refused",
      "canvas-texture-override",
      "canvas-texture-wire",
      "canvas-normal-region",
      "leg-class-canvas-headless",
      "leg-class-canvas-host",
      "leg-class-canvas-normal",
      "leg-class-sabotage-omit-canvas-filter",
    ];
    assert(
      "g2d not run: only group-g2d is not-run, G2d's checks are absent, every other check passes",
      !withoutD.gate_passed &&
        withoutD.checks
          .filter((c) => c.status !== "pass")
          .map((c) => `${c.id}:${c.status}`)
          .join(",") === "group-g2d:not-run" &&
        !withoutD.checks.some((c) => g2dIds.includes(c.id)) &&
        withoutD.legs["canvas-normal"] === undefined,
      withoutD.checks
        .filter((c) => c.status !== "pass")
        .map((c) => `${c.id}:${c.status}: ${c.detail.slice(0, 200)}`)
        .join(" | "),
    );
    await rm(noG2d, { recursive: true, force: true });
    await writeJson(join(g2aOnly, "legs.json"), {
      groups_run: [],
      groups_landed: ["g2a", "g2b", "g2c", "g2d", "g2e"],
    });
    const notRun = await run(g2aOnly);
    assert(
      "nothing run: group-g2a..group-g2e are not-run and the gate fails",
      !notRun.gate_passed &&
        ["group-g2a", ...LATER].every((id) =>
          notRun.checks.some((c) => c.id === id && c.status === "not-run"),
        ),
      notRun.checks.map((c) => `${c.id}:${c.status}`).join(","),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    `\nself-test-gate2: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
