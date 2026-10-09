#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the gate 2 checker (lib/gate2-checks.ts and lib/gate2-expected.ts, group g2a).
// Proves that every check can fail as well as pass.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate2.ts
//
// 1. Pure cases: synthesizeGate2's sampling (flips, transpose, tile, mirror, clamp, binary and
//    partial alpha) against hand-computed texels, the step windows, the census helpers, the hook
//    log's line validation, and checkExpectedSelfConsistent on the committed expected.json and on
//    broken copies of it.
// 2. Evidence-tree scenarios: a fabricated passing g2a tree (a render-stream/1 capture recording
//    encoded by rs1-test-encoder.ts, hook logs and fixture texture logs from a model of the
//    fixture's texture calls, PNGs synthesized from fixtures/gate2/expected.json), then one
//    perturbation per failure mode. Each scenario runs the real runGate2 and asserts the verdict
//    of the checks it targets, and that every other check still passes.
//
// Exits non-zero if any assertion fails.

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
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
  encodeRs1Recording,
  type TItem,
  type TState,
} from "./rs1-test-encoder";

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
const CAPTURE_QUIT = 400;
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
  assert(
    "stepOfFrame: windows [S+N*k, S+N*(k+1)), the last through quit",
    stepOfFrame(e, 1, 112) === 0 &&
      stepOfFrame(e, 10, 112) === 0 &&
      stepOfFrame(e, 11, 112) === 1 &&
      stepOfFrame(e, 112, 112) === 10 &&
      stepOfFrame(e, 113, 112) === -1,
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
    expectedCensus(e, 0, 112, "unsupported").texture_2d_create ===
      e.steps[0].census.texture_2d_create + 1 &&
      expectedCensus(e, 0, 112, "unsupported")
        .canvas_item_set_default_texture_filter ===
        e.items_at_ready.length + 2,
  );
  assert(
    "expectedCensus: animate's per-frame updates fill the window (10 at step 1, 12 in the last, frames 101..112)",
    expectedCensus(e, 1, 112, "animate").texture_2d_update === 10 &&
      expectedCensus(e, 10, 112, "animate").texture_2d_update === 12,
    JSON.stringify(expectedCensus(e, 10, 112, "animate")),
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
// 2. A model of the fixture's texture calls (what the hook log and the fixture log record)
// ---------------------------------------------------------------------------------------------

const H = (tag: string): string => tag.repeat(64 / tag.length).slice(0, 64);
const HASH = {
  A0: H("a0"),
  B0: H("b0"),
  M: H("4d"),
  HUE: H("e1"),
  A1: H("a1"),
  A2: H("a2"),
  B1: H("b1"),
  C: H("c0"),
  D: H("d0"),
  E: H("e0"),
};

interface LogModelOptions {
  variant?: "unsupported";
  quit: number;
}

function line(
  partial: Partial<ResourceLine> & Pick<ResourceLine, "frame" | "op">,
): ResourceLine {
  const base = Object.fromEntries(
    RESOURCE_LINE_KEYS.map((k) => [k, null]),
  ) as unknown as ResourceLine;
  return { ...base, t_us: partial.frame * 1000, thread: "main", ...partial };
}

function image(
  frame: number,
  op: "texture_2d_create" | "texture_2d_update" | "texture_replace",
  id: number,
  rid: string,
  version: number,
  format: string,
  w: number,
  h: number,
  hash: string | null,
  extra: Partial<ResourceLine> = {},
): ResourceLine {
  const bytes = format === "LA8" ? 2 : format === "RGBAF" ? 16 : 4;
  const ok = hash !== null;
  return line({
    frame,
    op,
    id,
    rid,
    version,
    kind: "image",
    status: ok ? "ok" : "unsupported",
    reason: ok ? null : "unsupported-format",
    format,
    width: w,
    height: h,
    mipmaps: w === 64,
    data_bytes: w === 64 ? 21844 : w * h * bytes,
    payload_bytes: ok ? 100 + w * h * bytes : 0,
    hash,
    copy_ns: ok ? 500 : null,
    hash_ns: ok ? 4000 : null,
    layer: op === "texture_2d_update" ? 0 : null,
    ...extra,
  });
}

function itemCalls(
  frame: number,
  op: string,
  count: number,
  firstRid: number,
  value: number,
) {
  return [...Array(count).keys()].map((i) =>
    line({ frame, op, target: String(firstRid + i), value }),
  );
}

function hookLog(opts: LogModelOptions): ResourceLine[] {
  const f = (k: number) => stepFrames2(EXPECTED, k).applied;
  const items = EXPECTED.items_at_ready.length + (opts.variant ? 2 : 0);
  const out: ResourceLine[] = [
    image(1, "texture_2d_create", 1, "1001", 1, "RGBA8", 16, 16, HASH.A0),
    image(1, "texture_2d_create", 2, "1002", 1, "RGBA8", 16, 16, HASH.A0),
    image(1, "texture_2d_create", 3, "1003", 1, "LA8", 4, 4, HASH.B0),
    image(1, "texture_2d_create", 4, "1004", 1, "RGBA8", 64, 64, HASH.M),
    line({
      frame: 1,
      op: "texture_2d_placeholder_create",
      id: 5,
      rid: "1005",
      version: 1,
      kind: "placeholder",
      status: "ok",
    }),
    line({
      frame: 1,
      op: "texture_2d_placeholder_create",
      id: 6,
      rid: "1006",
      version: 1,
      kind: "placeholder",
      status: "ok",
    }),
  ];
  if (opts.variant)
    out.push(image(1, "texture_2d_create", 7, "1013", 1, "RGBAF", 4, 4, null));
  out.push(
    ...itemCalls(1, "canvas_item_set_default_texture_filter", items, 2001, 0),
    ...itemCalls(1, "canvas_item_set_default_texture_repeat", items, 2001, 0),
    image(1, "texture_2d_create", 8, "1007", 1, "RGBA8", 800, 6, HASH.HUE),
    line({
      frame: f(3),
      op: "canvas_item_set_default_texture_filter",
      target: "2003",
      value: 2,
    }),
    line({
      frame: f(4),
      op: "viewport_set_default_canvas_item_texture_filter",
      target: "3000",
      value: 2,
      root_viewport: true,
    }),
    line({
      frame: f(5),
      op: "viewport_set_default_canvas_item_texture_filter",
      target: "3000",
      value: 1,
      root_viewport: true,
    }),
    line({
      frame: f(5),
      op: "canvas_item_set_default_texture_repeat",
      target: "2005",
      value: 3,
    }),
    image(f(6), "texture_2d_update", 1, "1001", 2, "RGBA8", 16, 16, HASH.A1),
    image(f(7), "texture_2d_create", 9, "1008", 1, "RGBA8", 32, 32, HASH.A2),
    image(f(7), "texture_replace", 1, "1001", 3, "RGBA8", 32, 32, HASH.A2, {
      by_id: 9,
      target: "1008",
      ref_id: 9,
    }),
    image(f(7), "texture_2d_create", 10, "1009", 1, "RGBA8", 4, 4, HASH.B1),
    image(f(7), "texture_replace", 3, "1003", 2, "RGBA8", 4, 4, HASH.B1, {
      by_id: 10,
      target: "1009",
      ref_id: 10,
    }),
    image(f(8), "texture_2d_create", 11, "1010", 1, "RGBA8", 16, 16, HASH.C),
    line({
      frame: f(8),
      op: "free",
      id: 2,
      rid: "1002",
      version: 1,
      kind: "image",
      status: "freed",
    }),
    image(f(8), "texture_2d_create", 12, "1011", 1, "RGBA8", 16, 16, HASH.D, {
      thread: "other",
    }),
    line({
      frame: f(8),
      op: "free",
      id: 5,
      rid: "1005",
      version: 1,
      kind: "placeholder",
      status: "freed",
    }),
    image(f(9), "texture_2d_create", 13, "1012", 1, "RGBA8", 4, 4, HASH.E),
    image(f(9), "texture_replace", 6, "1006", 2, "RGBA8", 4, 4, HASH.E, {
      by_id: 13,
      target: "1012",
      ref_id: 13,
    }),
    line({
      frame: f(9),
      op: "canvas_item_set_default_texture_filter",
      target: "2010",
      value: 4,
    }),
    line({
      frame: opts.quit + 1,
      op: "free",
      id: 1,
      rid: "1001",
      version: 3,
      kind: "image",
      status: "freed",
    }),
  );
  // The replace lines were built through image(); fix their op-specific fields.
  for (const l of out) {
    if (l.op === "texture_replace") {
      l.layer = null;
    }
  }
  return out.sort((a, b) => a.frame - b.frame);
}

function fixtureLog(): object[] {
  const f = (k: number) => stepFrames2(EXPECTED, k).applied;
  const entry = (
    step: number,
    op: string,
    name: string,
    hash: string | null,
    shape: [string, number, number] | null,
    thread = "main",
  ) => ({
    step,
    frame: step === 0 ? 1 : f(step),
    op,
    name,
    thread,
    format: shape?.[0] ?? null,
    width: shape?.[1] ?? null,
    height: shape?.[2] ?? null,
    mipmaps: shape ? shape[1] === 64 : null,
    data_bytes: shape
      ? shape[1] === 64
        ? 21844
        : shape[1] * shape[2] * (shape[0] === "LA8" ? 2 : 4)
      : null,
    payload_sha256: hash,
  });
  return [
    entry(0, "texture_2d_create", "A", HASH.A0, ["RGBA8", 16, 16]),
    entry(0, "texture_2d_create", "Atwin", HASH.A0, ["RGBA8", 16, 16]),
    entry(0, "texture_2d_create", "B", HASH.B0, ["LA8", 4, 4]),
    entry(0, "texture_2d_create", "M", HASH.M, ["RGBA8", 64, 64]),
    entry(0, "texture_2d_placeholder_create", "P1", null, null),
    entry(0, "texture_2d_placeholder_create", "P2", null, null),
    entry(6, "texture_2d_update", "A", HASH.A1, ["RGBA8", 16, 16]),
    entry(7, "texture_2d_create", "A", HASH.A2, ["RGBA8", 32, 32]),
    entry(7, "texture_replace", "A", null, null),
    entry(7, "texture_2d_create", "B", HASH.B1, ["RGBA8", 4, 4]),
    entry(7, "texture_replace", "B", null, null),
    entry(8, "texture_2d_create", "C", HASH.C, ["RGBA8", 16, 16]),
    entry(8, "free", "Atwin", null, null),
    entry(8, "texture_2d_create", "D", HASH.D, ["RGBA8", 16, 16], "other"),
    entry(8, "free", "P1", null, null),
    entry(9, "texture_2d_create", "E", HASH.E, ["RGBA8", 4, 4]),
    entry(9, "texture_replace", "P2", null, null),
  ];
}

const jsonl = (rows: readonly object[]) =>
  `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

// ---------------------------------------------------------------------------------------------
// The capture recording: the Marker's colour per step, plus the two texture draws as
// unsupported commands, one transaction per frame.
// ---------------------------------------------------------------------------------------------

function captureStates(quit: number, extraOp?: string): TState[] {
  const states: TState[] = [];
  let step = 0;
  for (let frame = 1; frame <= quit; frame++) {
    for (let k = step + 1; k <= EXPECTED.last_step; k++)
      if (stepFrames2(EXPECTED, k).applied === frame) step = k;
    const marker = EXPECTED.steps[step].marker_rgba8.map((v) => v / 255);
    const base = {
      parent: { kind: "canvas" as const, id: 1 },
      children: [],
      visible: true,
      z_index: 0,
      visibility_layer: 1,
      xform: [1, 0, 0, 1, 0, 0],
      modulate: [1, 1, 1, 1],
      self_modulate: [1, 1, 1, 1],
    };
    const items: TItem[] = [
      {
        ...base,
        id: 1,
        draw_index: 0,
        content_version: 1,
        commands: [
          { op: "unsupported", name: "canvas_item_add_texture_rect_region" },
        ],
      },
      {
        ...base,
        id: 2,
        draw_index: 1,
        content_version: 1 + step,
        commands: [{ op: "add_rect", rect: [0, 0, 32, 32], color: marker }],
      },
      {
        ...base,
        id: 3,
        draw_index: 1000,
        content_version: 1,
        commands: [
          { op: "unsupported", name: "canvas_item_add_texture_rect" },
          ...(extraOp ? [{ op: "unsupported" as const, name: extraOp }] : []),
        ],
      },
    ];
    states.push({
      frame,
      failures: [],
      unsupported: [
        {
          op: "canvas_item_add_texture_rect_region",
          item: 1,
          reason: "unsupported-op",
        },
        ...(extraOp
          ? [{ op: extraOp, item: 3, reason: "unsupported-op" }]
          : []),
        {
          op: "canvas_item_add_texture_rect",
          item: 3,
          reason: "unsupported-op",
        },
      ].sort((a, b) => a.item - b.item || (a.op < b.op ? -1 : 1)),
      canvases: [{ id: 1, items: [1, 2, 3], xform: [1, 0, 0, 1, 0, 0] }],
      items,
    });
  }
  return states;
}

// ---------------------------------------------------------------------------------------------
// Evidence-tree writers
// ---------------------------------------------------------------------------------------------

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}
async function editText(
  path: string,
  edit: (text: string) => string,
): Promise<void> {
  await writeFile(path, edit(await readFile(path, "utf8")));
}
async function editLog(
  path: string,
  edit: (lines: ResourceLine[]) => ResourceLine[],
): Promise<void> {
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l)
    .map((l) => JSON.parse(l) as ResourceLine);
  await writeText(path, jsonl(edit(lines)));
}

async function writePng(
  path: string,
  step: number,
  perturb?: [number, number],
): Promise<void> {
  const { width, height, rgba } = synthesizeGate2(EXPECTED, step);
  const buf = Buffer.from(rgba);
  if (perturb) buf[(perturb[1] * width + perturb[0]) * 4] ^= 0x10;
  await mkdir(dirname(path), { recursive: true });
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(path);
}

async function writeProcess(dir: string, exitCode = 0): Promise<void> {
  await writeText(join(dir, "argv.txt"), "/tpl/linux_release.x86_64\n");
  await writeText(join(dir, "env.txt"), "GRC_MODE=arm\n");
  await writeText(join(dir, "stdout.log"), "[fixture] gate2 ready\n");
  await writeText(join(dir, "exit-code.txt"), `${exitCode}\n`);
}

function stepLog(): string {
  return jsonl(
    EXPECTED.steps.map((s) => {
      const f = stepFrames2(EXPECTED, s.step);
      return { step: s.step, applied_frame: f.applied, settle_frame: f.settle };
    }),
  );
}

async function writeEvidence(
  dir: string,
  quit: number,
  drawn: string[],
): Promise<void> {
  await writeJson(join(dir, "evidence", "result.json"), {
    schema: "render-stream-capture-result/1",
    status: "armed",
    reason: null,
    vptr_written: true,
    disarmed: true,
    display_server: "headless",
    stream: {
      path: join(dir, "recording.rs1"),
      patch_path: null,
      status: "closed",
      reason: null,
      transactions: quit,
    },
  });
  await writeJson(join(dir, "evidence", "counters.json"), {
    schema: "render-stream-gate-minus1-counters/1",
    frames_total: quit,
    hooks_planned: [...GATE0_HOOKS],
    hooks_omitted: [],
    captured: {
      canvas_item_add_texture_rect: drawn
        .slice(0, 2)
        .map((texture) => ({ item: "7", texture })),
      canvas_item_add_texture_rect_region: drawn
        .slice(2)
        .map((texture) => ({ item: "8", texture })),
    },
    captured_dropped: {
      canvas_item_add_texture_rect: 0,
      canvas_item_add_texture_rect_region: 0,
    },
  });
  await writeJson(join(dir, "evidence", "root.json"), {
    schema: "render-stream-root-geometry/1",
    texture_defaults: { filter: 0, repeat: 0 },
  });
  await writeText(join(dir, "evidence", "armed.marker"), "");
}

const DRAWN = ["1005", "1006", "1001", "1002", "1003", "1010", "1011"];

async function buildGoodTree(out: string): Promise<void> {
  await writeJson(join(out, "legs.json"), {
    groups_run: ["g2a"],
    groups_landed: ["g2a"],
  });
  await writeJson(join(out, "binary.json"), {
    path: "/tpl/linux_release.x86_64",
    sha256: "54cc",
  });
  await writeProcess(join(out, "import", "fixture"));

  const capture = join(out, "capture");
  await writeProcess(capture);
  await writeFile(
    join(capture, "recording.rs1"),
    encodeRs1Recording(captureStates(CAPTURE_QUIT), {
      encoding: "full",
      hooksPlanned: [...GATE0_HOOKS],
    }),
  );
  await writeEvidence(capture, CAPTURE_QUIT, DRAWN);
  await writeText(
    join(capture, "evidence", "resources.jsonl"),
    jsonl(hookLog({ quit: CAPTURE_QUIT })),
  );
  await writeText(join(capture, "textures.jsonl"), jsonl(fixtureLog()));
  await writeText(join(capture, "steps.jsonl"), stepLog());
  await writeText(
    join(capture, "strace.txt"),
    [
      '42 10:00:00.000000 openat(AT_FDCWD, "/usr/lib/x86_64-linux-gnu/libc.so.6", O_RDONLY|O_CLOEXEC) = 3',
      `42 10:00:00.200000 openat(AT_FDCWD, "${join(capture, "evidence", "armed.marker")}", O_WRONLY|O_CREAT, 0666) = 7`,
      "",
    ].join("\n"),
  );
  await writeText(
    join(capture, "maps.txt"),
    "55d000000000-55d000001000 r-xp 00000000 103:09 1 /tpl/linux_release.x86_64\n",
  );
  await writeText(
    join(capture, "fd.txt"),
    "lrwx------ 1 u u 64 Oct  9 10:00 0 -> /dev/null\n",
  );

  const unsupported = join(out, "capture-unsupported");
  await writeProcess(unsupported);
  await writeEvidence(unsupported, EXPECTED.quit_frame_default, [
    ...DRAWN,
    "1013",
    "999",
  ]);
  await writeText(
    join(unsupported, "evidence", "resources.jsonl"),
    jsonl(
      hookLog({ quit: EXPECTED.quit_frame_default, variant: "unsupported" }),
    ),
  );

  for (const leg of ["reference", "reference-repeat", "reference-armed"]) {
    const dir = join(out, leg);
    await writeProcess(dir);
    await writeText(join(dir, "steps.jsonl"), stepLog());
    await writeText(join(dir, "textures.jsonl"), jsonl(fixtureLog()));
    for (const s of EXPECTED.steps)
      await writePng(join(dir, "shots", `step-${s.step}.png`), s.step);
  }
  const armed = join(out, "reference-armed");
  await writeEvidence(armed, EXPECTED.quit_frame_default, DRAWN);
  await writeText(
    join(armed, "evidence", "resources.jsonl"),
    jsonl(hookLog({ quit: EXPECTED.quit_frame_default })),
  );
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

async function run(out: string): Promise<Gate2Report> {
  return runGate2(out, { expected: EXPECTED, now: new Date(0) });
}

function verdicts(report: Gate2Report): Map<string, string> {
  return new Map(report.checks.map((c) => [c.id, c.status]));
}

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
    assert(`${name}: ${id} fails`, v.get(id) === "fail", c?.detail);
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
}

async function main(): Promise<void> {
  EXPECTED = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate2", "expected.json"),
      "utf8",
    ),
  ) as Gate2Expected;
  pureCases();

  const root = await mkdtemp(join(tmpdir(), "self-test-gate2-"));
  try {
    const good = join(root, "good");
    await buildGoodTree(good);
    const report = await run(good);
    const bad = report.checks.filter((c) => c.status !== "pass");
    assert(
      "good tree: every check passes and the gate passes",
      report.gate_passed && bad.length === 0,
      bad.map((c) => `${c.id}: ${c.detail}`).join(" | "),
    );
    assert(
      "good tree: the checks are the G2a set",
      [
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
      ].join(",") === report.checks.map((c) => c.id).join(","),
      report.checks.map((c) => c.id).join(","),
    );
    assert(
      "good tree: the capture leg is unsupported, the five support legs reported",
      report.legs.capture?.result_class === "unsupported" &&
        Object.keys(report.legs).length === 6,
    );
    assert(
      "good tree: copy costs reported per shape",
      (report.resources?.capture.host.by_shape.length ?? 0) >= 5,
      JSON.stringify(
        report.resources?.capture.host.by_shape.map((s) => s.shape),
      ),
    );

    const capLog = (out: string) =>
      join(out, "capture", "evidence", "resources.jsonl");
    const f = (k: number) => stepFrames2(EXPECTED, k).applied;

    await scenario(
      root,
      good,
      "census-transform-only-step",
      async (out) => {
        await editLog(capLog(out), (ls) =>
          [
            ...ls,
            line({
              frame: f(2),
              op: "texture_2d_update",
              id: 1,
              rid: "1001",
              version: 9,
              status: "ok",
            }),
          ].sort((a, b) => a.frame - b.frame),
        );
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
      ["census", "hook-bytes-exact", "worker-thread-create"],
    );
    await scenario(
      root,
      good,
      "hash-mismatch-c",
      async (out) => {
        await editLog(capLog(out), (ls) =>
          ls.map((l) => (l.hash === HASH.C ? { ...l, hash: H("cf") } : l)),
        );
      },
      ["hook-bytes-exact"],
    );
    await scenario(
      root,
      good,
      "engine-texture-missing",
      async (out) => {
        await editLog(
          join(out, "reference-armed", "evidence", "resources.jsonl"),
          (ls) => ls.filter((l) => l.width !== 800),
        );
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
        await editLog(capLog(out), (ls) =>
          [
            ...ls,
            line({
              frame: f(9),
              op: "canvas_item_set_default_texture_filter",
              target: "1008",
              value: 1,
            }),
          ].sort((a, b) => a.frame - b.frame),
        );
      },
      ["census", "replace-retires-temp"],
    );
    await scenario(
      root,
      good,
      "replace-version-not-bumped",
      async (out) => {
        await editLog(capLog(out), (ls) =>
          ls.map((l) =>
            l.op === "texture_replace" && l.id === 1 ? { ...l, version: 2 } : l,
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
        await writePng(
          join(out, "reference", "shots", "step-6.png"),
          6,
          [50, 250],
        );
      },
      [
        "expected-image-reference",
        "reference-repeat-budget",
        "armed-transparent",
      ],
    );
    await scenario(
      root,
      good,
      "armed-pixel-off",
      async (out) => {
        await writePng(
          join(out, "reference-armed", "shots", "step-2.png"),
          2,
          [100, 300],
        );
      },
      ["armed-transparent"],
    );
    await scenario(
      root,
      good,
      "repeat-pixel-off-outside-exclusions",
      async (out) => {
        await writePng(
          join(out, "reference-repeat", "shots", "step-0.png"),
          0,
          [210, 50],
        );
      },
      ["reference-repeat-budget"],
    );
    await scenario(
      root,
      good,
      "variant-no-unknown-rid",
      async (out) => {
        await writeEvidence(
          join(out, "capture-unsupported"),
          EXPECTED.quit_frame_default,
          [...DRAWN, "1013"],
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
              l.format === "RGBAF"
                ? {
                    ...l,
                    status: "ok",
                    reason: null,
                    hash: H("ff"),
                    copy_ns: 1,
                    hash_ns: 1,
                  }
                : l,
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
        await writeEvidence(join(out, "capture"), CAPTURE_QUIT, [
          ...DRAWN,
          "4242",
        ]);
      },
      ["unsupported-variant"],
    );
    await scenario(
      root,
      good,
      "capture-extra-unsupported-op",
      async (out) => {
        await writeFile(
          join(out, "capture", "recording.rs1"),
          encodeRs1Recording(
            captureStates(CAPTURE_QUIT, "canvas_item_add_circle"),
            { encoding: "full", hooksPlanned: [...GATE0_HOOKS] },
          ),
        );
      },
      ["leg-class-capture"],
    );
    await scenario(
      root,
      good,
      "capture-hook-omitted",
      async (out) => {
        await writeFile(
          join(out, "capture", "recording.rs1"),
          encodeRs1Recording(captureStates(CAPTURE_QUIT), {
            encoding: "full",
            hooksPlanned: GATE0_HOOKS.filter((h) => h !== "texture_replace"),
          }),
        );
      },
      ["capture-armed"],
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

    // A run without g2a: its checks are not-run and the gate fails.
    const none = join(root, "not-run");
    await cp(good, none, { recursive: true });
    await writeJson(join(none, "legs.json"), {
      groups_run: [],
      groups_landed: ["g2a"],
    });
    const notRun = await run(none);
    assert(
      "g2a not run: group-g2a is not-run and the gate fails",
      !notRun.gate_passed &&
        notRun.checks.some(
          (c) => c.id === "group-g2a" && c.status === "not-run",
        ),
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
