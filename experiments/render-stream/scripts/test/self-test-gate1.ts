#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the gate 1 checker (lib/gate1-checks.ts and lib/gate1-live-checks.ts, groups
// g1a, g1b and g1c). Proves that every
// check can fail as well as pass, and that classifyGate1 adds gate 1's rules (the session's root
// size declaration, patch divergence) to gate 0's precedence.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate1.ts
//
// 1. classifyGate1 unit cases (pure): no session / patch divergence -> capture-failure; a
//    degenerate host -> unsupported (degenerate-host-size); precedence against gate 0's classes;
//    synthesizeGate1 and the invariant / tie helpers on the model's resolved states.
// 2. Evidence-tree scenarios: a fabricated passing g1a+g1b tree (recordings encoded in
//    render-stream/1, both sinks, by rs1-test-encoder.ts from a model of the fixture's retained
//    state, PNGs synthesized from fixtures/gate1/expected.json), then one perturbation per failure
//    mode. Each scenario runs the real runGate1 and asserts the verdict of the checks and leg
//    classes it targets.
//
// Exits non-zero if any assertion fails.

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import {
  classifyLeg,
  expectedReceiverUnsupported,
  GATE0_HOOKS,
  type RecordingSummary,
  summarizeRecording,
} from "../lib/gate0-checks";
import {
  classifyGate1,
  evaluateInvariants,
  G1A_CLASSIFIED_LEGS,
  G1A_EXPECTATIONS,
  G1A_SUPPORT_LEGS,
  G1B_CLASSIFIED_LEGS,
  G1B_EXPECTATIONS,
  GATE1_EXPECTATIONS,
  type Gate1Class,
  type Gate1Context,
  type Gate1Leg,
  type Gate1Report,
  mapNames,
  type RootEvidence,
  recordingTies,
  runGate1,
  statesOf,
} from "../lib/gate1-checks";
import {
  type Gate1Expected,
  paintRect,
  stepFrames,
  synthesizeGate1,
} from "../lib/gate1-expected";
import {
  G1C_CLASSIFIED_LEGS,
  G1C_EXPECTATIONS,
} from "../lib/gate1-live-checks";
import { splitRecords, validateRecording } from "../lib/render-stream-1";
import {
  encodeRs1Recording,
  type TItem,
  type TState,
} from "./rs1-test-encoder";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "../..");
const GOLDEN_DIR = join(EXPERIMENT_DIR, "protocol", "golden-1");

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

let EXPECTED: Gate1Expected;
const S = 1;
const N = 10;
const CAPTURE_QUIT = 400;
const SHORT_QUIT = 112;

// ---------------------------------------------------------------------------------------------
// A model of the fixture's retained canvas state (what the mirror publishes), step by step.
// ---------------------------------------------------------------------------------------------

interface MItem {
  id: number;
  parent: { kind: "canvas" | "item"; id: number } | null;
  children: number[];
  visible: boolean;
  draw_index: number;
  z_index: number;
  layer: number;
  version: number;
  xform: number[];
  modulate: number[];
  self_modulate: number[];
  rects: number[][]; // [x, y, w, h, r, g, b, a]
}
interface MState {
  canvasItems: number[];
  canvasXform: number[];
  items: Map<number, MItem>;
}

interface ModelOptions {
  /** step 3 does not swap Q1/Q2's draw indices */
  noSwap?: boolean;
  /** Q2 takes Q1's draw index at step 3 (a tie) */
  tie?: boolean;
  /** step 10 does not move the canvas */
  noCanvasShift?: boolean;
  /** step 10 also bumps every item's content version */
  redrawAtShift?: boolean;
  /** T (step 1) overlaps P instead of sitting alone (RS_FIXTURE_TIE=overlap) */
  tieOverlap?: boolean;
  /** T is never raised, so its tie with P lasts */
  noTieRaise?: boolean;
  /** step 2 also redraws P (a content change where only a transform should be) */
  redrawP2?: boolean;
}

const W = [1, 1, 1, 1];
const c = (r: number, g: number, b: number): number[] => [r, g, b, 1];
const MARKER = [
  c(0, 0, 0),
  c(1, 1, 0),
  c(0, 1, 1),
  c(0.4, 0, 0.4),
  c(0, 0.4, 0),
  c(0.4, 0, 0),
  c(0, 0, 0.4),
  c(0.8, 0.4, 0.8),
  c(0.4, 0.6, 0.8),
  c(0.8, 0.6, 0.4),
  c(0.2, 0.6, 0.2),
];

function initialState(): MState {
  const items = new Map<number, MItem>();
  const add = (
    id: number,
    parent: MItem["parent"],
    children: number[],
    di: number,
    pos: [number, number],
    rects: number[][],
    layer = 1,
  ): void => {
    items.set(id, {
      id,
      parent,
      children,
      visible: true,
      draw_index: di,
      z_index: 0,
      layer,
      version: 1 + rects.length,
      xform: [1, 0, 0, 1, pos[0], pos[1]],
      modulate: [...W],
      self_modulate: [...W],
      rects,
    });
  };
  const cv = { kind: "canvas" as const, id: 1 };
  const it = (id: number) => ({ kind: "item" as const, id });
  add(1, cv, [2], 0, [80, 80], [[0, 0, 64, 64, ...W]]);
  add(2, it(1), [3], 0, [80, 0], [[0, 0, 48, 48, ...W]]);
  add(3, it(2), [], 0, [0, 56], [[0, 0, 32, 32, ...c(0.6, 0.6, 0.6)]]);
  add(4, cv, [5, 6], 1, [288, 80], []);
  add(5, it(4), [], 0, [0, 0], [[0, 0, 64, 64, ...c(1, 0.4, 0)]]);
  add(6, it(4), [], 1, [32, 32], [[0, 0, 64, 64, ...c(0, 0.6, 1)]]);
  add(7, cv, [8], 2, [400, 80], []);
  add(8, it(7), [], 0, [0, 0], [[0, 0, 48, 48, ...c(0.4, 0.8, 0.4)]]);
  add(9, cv, [10], 3, [80, 216], [[0, 0, 64, 64, ...c(0.2, 0.8, 0.2)]]);
  add(10, it(9), [], 0, [80, 0], [[0, 0, 48, 48, ...c(0.8, 0.2, 0.2)]]);
  add(
    11,
    cv,
    [],
    4,
    [240, 216],
    [
      [0, 0, 32, 32, ...c(1, 0.6, 0)],
      [40, 0, 32, 32, ...c(0.6, 0, 1)],
    ],
  );
  add(12, cv, [], 5, [360, 216], [[0, 0, 32, 32, ...c(1, 1, 0.2)]]);
  add(13, cv, [14], 6, [400, 216], [[0, 0, 32, 32, ...c(0.6, 0.2, 1)]]);
  add(14, it(13), [], 0, [0, 40], [[0, 0, 16, 16, ...c(1, 0.6, 0.2)]]);
  add(15, cv, [], 7, [440, 216], [[0, 0, 32, 32, ...c(0.2, 1, 1)]]);
  add(16, cv, [], 8, [608, 328], [[0, 0, 32, 32, ...c(0.8, 0.8, 0.2)]]);
  add(17, cv, [], 9, [592, 16], [[0, 0, 32, 32, ...MARKER[0]]]);
  add(
    18,
    cv,
    [19],
    1000,
    [480, 216],
    [[0, 0, 32, 32, ...c(1, 0.2, 0.6)]],
    0xffffffff,
  );
  add(
    19,
    it(18),
    [],
    0,
    [0, 0],
    [[0, 40, 16, 16, ...c(0.4, 0.4, 1)]],
    0xffffffff,
  );
  return {
    canvasItems: [1, 4, 7, 9, 11, 12, 13, 15, 16, 17, 18],
    canvasXform: [1, 0, 0, 1, 0, 0],
    items,
  };
}

function redraw(item: MItem, rects: number[][]): void {
  item.rects = rects;
  item.version += 1 + rects.length;
}

function applyStep(state: MState, step: number, opts: ModelOptions): void {
  const g = (id: number): MItem => state.items.get(id) as MItem;
  switch (step) {
    case 1:
      g(1).modulate = [1, 0, 1, 1];
      g(2).self_modulate = [0, 1, 1, 1];
      // T enters the canvas at runtime with the RS default index 0, tying with P (index 0)
      // until the deferred raise next frame (afterStep).
      state.items.set(20, {
        id: 20,
        parent: { kind: "canvas", id: 1 },
        children: [],
        visible: true,
        draw_index: 0,
        z_index: 0,
        layer: 1,
        version: 2,
        xform: [1, 0, 0, 1, ...(opts.tieOverlap ? [112, 112] : [80, 304])],
        modulate: [...W],
        self_modulate: [...W],
        rects: [[0, 0, opts.tieOverlap ? 224 : 32, 32, ...c(0.6, 1, 0.4)]],
      });
      state.canvasItems = [...state.canvasItems, 20];
      break;
    case 2:
      g(1).xform = [1, 0, 0, 1, 80, 96];
      g(2).xform = [0, 1, -1, 0, 160, 0];
      redraw(g(8), [[0, 0, 48, 48, ...c(0.8, 0.8, 0)]]);
      if (opts.redrawP2) redraw(g(1), g(1).rects);
      break;
    case 3:
      if (opts.tie) {
        g(6).draw_index = 0;
      } else if (!opts.noSwap) {
        g(5).draw_index = 1;
        g(6).draw_index = 0;
      }
      break;
    case 4:
      g(6).z_index = 1;
      break;
    case 5:
      g(4).children = [6];
      g(6).draw_index = 0;
      g(7).children = [8, 5];
      g(5).parent = { kind: "item", id: 7 };
      g(5).draw_index = 1;
      redraw(g(5), g(5).rects);
      break;
    case 6:
      g(9).visible = false;
      g(10).visible = false;
      redraw(g(11), [[0, 0, 72, 32, ...c(0.4, 0.4, 0.4)]]);
      break;
    case 7:
      g(9).visible = true;
      g(10).visible = true;
      redraw(g(9), g(9).rects);
      redraw(g(10), g(10).rects);
      g(10).layer = 0;
      redraw(g(11), []);
      break;
    case 8:
      for (const id of [12, 13, 14, 18]) state.items.delete(id);
      // remove_child(D) re-raises the remaining top-level items without resetting the counter
      // (step 1's raise left it at 11).
      [1, 4, 7, 9, 11, 16, 17, 20].forEach((id, i) => {
        g(id).draw_index = 11 + i;
      });
      g(19).parent = null;
      g(15).parent = null;
      state.canvasItems = state.canvasItems.filter(
        (id) => ![12, 13, 15, 18].includes(id),
      );
      redraw(g(11), [
        [0, 0, 16, 16, ...c(1, 0, 0)],
        [24, 0, 16, 16, ...c(0, 1, 0)],
        [48, 0, 16, 16, ...c(0, 0, 1)],
      ]);
      break;
    case 9: {
      state.items.set(21, {
        id: 21,
        parent: { kind: "canvas", id: 1 },
        children: [],
        visible: true,
        draw_index: 7,
        z_index: 0,
        layer: 1,
        version: 2,
        // (top-level indices are reassigned below)
        xform: [1, 0, 0, 1, 360, 216],
        modulate: [...W],
        self_modulate: [...W],
        rects: [[0, 0, 32, 32, ...c(0.2, 0.4, 1)]],
      });
      g(15).parent = { kind: "canvas", id: 1 };
      redraw(g(15), g(15).rects);
      state.canvasItems = [...state.canvasItems, 21, 15];
      // add_child resets the sort index: every top-level item is raised again in tree order.
      [1, 4, 7, 9, 11, 16, 17, 20, 21, 15].forEach((id, i) => {
        g(id).draw_index = i;
      });
      state.items.delete(19);
      g(7).children = [5, 8];
      g(5).draw_index = 0;
      g(8).draw_index = 1;
      redraw(g(8), g(8).rects);
      break;
    }
    case 10:
      if (!opts.noCanvasShift) state.canvasXform = [1, 0, 0, 1, 8, 4];
      if (opts.redrawAtShift) {
        for (const item of state.items.values()) redraw(item, item.rects);
      }
      break;
  }
  redraw(g(17), [[0, 0, 32, 32, ...MARKER[step]]]);
}

/** The deferred top-level raise, one frame after a step (scene/main/scene_tree.cpp:644, :708-709):
 * T, added at step 1 with the RS default index 0, gets 10 (P..Marker keep 0..9). */
function afterStep(state: MState, step: number, opts: ModelOptions): void {
  if (step === 1 && !opts.noTieRaise) {
    (state.items.get(20) as MItem).draw_index = 10;
  }
}

// ---------------------------------------------------------------------------------------------
// Recordings: the model, frame by frame, encoded in render-stream/1 (rs1-test-encoder.ts)
// ---------------------------------------------------------------------------------------------

interface RecordingOptions extends ModelOptions {
  quit: number;
  /** the fixture timeline (RS_FIXTURE_START_FRAME / _STEP_FRAMES); default S, N */
  start?: number;
  stepFrames?: number;
  sabotage?: { kind: string; frame: number; op?: string | null } | null;
  hooksPlanned?: string[];
  /** publish step `step`'s change `frames` frames late */
  delay?: { step: number; frames: number };
  noEnd?: boolean;
  /** root-size policy; observe declares the 64x64 headless host (degenerate-visible) */
  policy?: "observe" | "enforce-min-size";
  /** enforce-min-size that failed: the root-size-enforce-failed failure, degenerate-window */
  enforceFailed?: boolean;
  /** the patch sink keeps the Marker's previous entry at this frame (patch-drop-item) */
  dropMarkerAt?: number;
  /** the patch sink writes these seqs as full transactions */
  patchFullAt?: number[];
}

/** Invariant 9's entries for a state: one per container group of >= 2 drawing siblings. */
function tieEntries(
  state: TState,
): { op: string; item: number; reason: string }[] {
  const byId = new Map(state.items.map((i) => [i.id, i]));
  const lists = [
    ...state.canvases.map((c) => c.items),
    ...state.items.map((i) => i.children),
  ];
  const out: { op: string; item: number; reason: string }[] = [];
  for (const list of lists) {
    const groups = new Map<number, number[]>();
    for (const id of list) {
      const it = byId.get(id);
      if (!it || (it.commands.length === 0 && it.children.length === 0))
        continue;
      groups.set(it.draw_index, [...(groups.get(it.draw_index) ?? []), id]);
    }
    for (const g of groups.values())
      if (g.length >= 2)
        out.push({
          op: "canvas_item_set_draw_index",
          item: Math.min(...g),
          reason: "draw-index-tie",
        });
  }
  return out.sort((a, b) => a.item - b.item);
}

function modelStates(opts: RecordingOptions): TState[] {
  const state = initialState();
  const states: TState[] = [];
  let applied = 0;
  const appliedAt = (k: number) =>
    (opts.start ?? S) +
    (opts.stepFrames ?? N) * k +
    (opts.delay?.step === k ? opts.delay.frames : 0);
  for (let frame = 1; frame <= opts.quit; frame++) {
    if (applied >= 1 && frame === appliedAt(applied) + 1)
      afterStep(state, applied, opts);
    for (let k = applied + 1; k <= 10; k++) {
      if (appliedAt(k) === frame) {
        applyStep(state, k, opts);
        applied = k;
      }
    }
    const items: TItem[] = [...state.items.keys()]
      .sort((a, b) => a - b)
      .map((id) => {
        const it = state.items.get(id) as MItem;
        return {
          id,
          parent: it.parent,
          children: [...it.children],
          visible: it.visible,
          draw_index: it.draw_index,
          z_index: it.z_index,
          visibility_layer: it.layer,
          content_version: it.version,
          xform: [...it.xform],
          modulate: [...it.modulate],
          self_modulate: [...it.self_modulate],
          custom_rect: id === 16,
          commands: it.rects.map((r) => ({
            op: "add_rect" as const,
            rect: r.slice(0, 4),
            color: r.slice(4, 8),
          })),
        };
      });
    const t: TState = {
      frame,
      failures: opts.enforceFailed
        ? [
            {
              reason: "root-size-enforce-failed",
              detail: "degenerate-window: window 64x64, visible 640x360",
            },
          ]
        : [],
      canvases: [
        { id: 1, items: [...state.canvasItems], xform: [...state.canvasXform] },
      ],
      items,
    };
    const degenerate = opts.policy === "observe" || opts.enforceFailed === true;
    t.unsupported = [
      ...(degenerate
        ? [
            {
              op: "root_viewport_size",
              item: null,
              reason: "degenerate-host-size",
            },
          ]
        : []),
      ...tieEntries(t),
    ];
    states.push(t);
  }
  return states;
}

function sessionFor(opts: RecordingOptions, encoding: "full" | "patch") {
  const observe = opts.policy === "observe";
  return {
    encoding,
    hooksPlanned: opts.hooksPlanned ?? [...GATE0_HOOKS],
    sabotage: opts.sabotage ?? null,
    noEnd: opts.noEnd,
    policy: opts.policy ?? "enforce-min-size",
    hostSizeStatus: observe
      ? ("degenerate-visible" as const)
      : opts.enforceFailed
        ? ("degenerate-window" as const)
        : ("match" as const),
    hostWindowSize: (observe || opts.enforceFailed ? [64, 64] : [640, 360]) as [
      number,
      number,
    ],
    hostVisibleRect: observe ? [0, 0, 64, 64] : [0, 0, 640, 360],
  };
}

function encodeRecording(opts: RecordingOptions): Buffer {
  return encodeRs1Recording(modelStates(opts), sessionFor(opts, "full"));
}

function encodePatchRecording(opts: RecordingOptions): Buffer {
  const states = modelStates(opts);
  return encodeRs1Recording(states, {
    ...sessionFor(opts, "patch"),
    fullAt: opts.patchFullAt,
    mutatePatch:
      opts.dropMarkerAt === undefined
        ? undefined
        : (seq, st) => {
            if (st.frame !== opts.dropMarkerAt) return st;
            const prev = states[seq - 2];
            const marker = prev.items.find((i) => i.id === 17);
            return {
              ...st,
              items: st.items.map((i) => (i.id === 17 && marker ? marker : i)),
            };
          },
  });
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
async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
async function editJson<T>(
  path: string,
  edit: (value: T) => void,
): Promise<void> {
  const value = await readJsonFile<T>(path);
  edit(value);
  await writeJson(path, value);
}

/** synthesizeGate1(step), optionally with the Corner where a 64x64 host lays it out and one
 * flipped pixel. */
async function writePng(
  path: string,
  step: number,
  opts: { perturb?: [number, number]; degenerateCorner?: boolean } = {},
): Promise<void> {
  const { width, height, rgba } = synthesizeGate1(EXPECTED, step);
  if (opts.degenerateCorner) {
    const shift = step === 10 ? [8, 4] : [0, 0];
    const corner = EXPECTED.steps[step].draws.find((d) => d.name === "Corner");
    paintRect(rgba, width, height, [600, 320, 40, 40], EXPECTED.clear_rgba8);
    paintRect(
      rgba,
      width,
      height,
      [32 + shift[0], 32 + shift[1], 32, 32],
      corner?.rgba8 ?? [0, 0, 0, 255],
    );
  }
  const buf = Buffer.from(rgba);
  if (opts.perturb)
    buf[(opts.perturb[1] * width + opts.perturb[0]) * 4] ^= 0x10;
  await mkdir(dirname(path), { recursive: true });
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(path);
}

async function writeProcess(
  dir: string,
  argv: string[],
  env: string[],
  stdout: string,
  exitCode: number,
): Promise<void> {
  await writeText(join(dir, "argv.txt"), `${argv.join("\n")}\n`);
  await writeText(join(dir, "env.txt"), `${env.join("\n")}\n`);
  await writeText(join(dir, "stdout.log"), stdout);
  await writeText(join(dir, "exit-code.txt"), `${exitCode}\n`);
}

function stepLog(start = S, span = N): string {
  return `${EXPECTED.steps
    .map((s) => {
      const f = stepFrames(EXPECTED, s.step, start, span);
      return JSON.stringify({
        step: s.step,
        applied_frame: f.applied,
        settle_frame: f.settle,
      });
    })
    .join("\n")}\n`;
}

function rootLog(
  displayServer: string,
  size: [number, number] = [640, 360],
): string {
  return `${EXPECTED.steps
    .map((s) =>
      JSON.stringify({
        step: s.step,
        frame: stepFrames(EXPECTED, s.step).settle,
        display_server: displayServer,
        window_size: size,
        visible_rect: [0, 0, ...size],
        canvas_transform: s.canvas_transform,
        final_transform: [1, 0, 0, 1, 0, 0],
        content_scale_size: [640, 360],
        content_scale_mode: 0,
      }),
    )
    .join("\n")}\n`;
}

function rootEvidence(policy: "observe" | "enforce-min-size"): RootEvidence {
  const before = {
    window_size: [64, 64],
    visible_rect: [0, 0, 64, 64],
    canvas_transform: [1, 0, 0, 1, 0, 0],
    final_transform: [1, 0, 0, 1, 0, 0],
  };
  const enforce = policy === "enforce-min-size";
  return {
    schema: "render-stream-root-geometry/1",
    policy,
    logical_size: [640, 360],
    stretch: { mode: "disabled", aspect: "keep", scale_mode: "fractional" },
    content_scale_factor: 1,
    before,
    after: enforce
      ? { ...before, window_size: [640, 360], visible_rect: [0, 0, 640, 360] }
      : before,
    host_size_status: enforce ? "match" : "degenerate-visible",
    enforce: { called: enforce, ok: true, detail: null },
  };
}

function settleSeqs(): number[] {
  // One transaction per frame, seq == frame.
  return EXPECTED.steps.map((s) => stepFrames(EXPECTED, s.step).settle);
}

/** The fixture's one tie frame (expected.json draw_index_ties: step 1's applied frame). */
const TIE_FRAME = S + N * 1;

/** A receiver's RenderingServer calls per seq: any deterministic function of the resolved state
 * will do, as long as the full and patch receivers agree. */
const rsCallsOf = (seq: number): number => (seq * 7) % 13;

function resolvedState(summary: RecordingSummary, seq: number): unknown {
  const t = summary.transactions.find((x) => x.meta.seq === seq)?.meta;
  return (
    t && {
      status: t.status,
      failures: t.failures,
      unsupported: t.unsupported,
      canvases: t.canvases,
      items: t.items,
    }
  );
}

function appliedFor(
  recordingPath: string,
  bytes: Buffer,
  shotSeqs: number[],
  stateSeqs: number[],
  dir: string,
): Record<string, unknown> {
  const summary = summarizeRecording(recordingPath, new Uint8Array(bytes));
  return {
    schema: "render-stream-receiver-applied/2",
    mode: "file",
    recording: {
      path: recordingPath,
      sha256: summary.sha256,
      bytes: bytes.length,
    },
    session_id: "0123456789abcdef0123456789abcdef",
    status: "ok",
    failure: null,
    end_seen: true,
    viewport: {
      display_server: shotSeqs.length > 0 ? "X11" : "headless",
      size: shotSeqs.length > 0 ? [640, 360] : [64, 64],
      size_check: shotSeqs.length > 0 ? "ok" : "skipped-headless",
      logical_size: [640, 360],
      canvas_transform: [1, 0, 0, 1, 8, 4],
    },
    transactions: summary.transactions.map((t, i) => ({
      stream: 1,
      seq: t.meta.seq,
      frame: t.meta.frame,
      encoding: t.meta.encoding,
      record_sha256: t.sha256,
      process_frame: i + 2,
      created: 0,
      freed: 0,
      reparented: 0,
      commands_replayed: 0,
      rs_calls: rsCallsOf(t.meta.seq),
    })),
    shots: shotSeqs.map((seq) => ({
      stream: 1,
      seq,
      step: null,
      path: join(dir, "shots", `seq-${seq}.png`),
      state_path: stateSeqs.includes(seq)
        ? join(dir, "state", `seq-${seq}.json`)
        : null,
      process_frame: seq + 2,
      applied_through: seq,
    })),
    shots_missed: [],
    unsupported: expectedReceiverUnsupported(summary),
    live: null,
  };
}

interface Projects {
  receiverProjectDir: string;
  fixtureProjectDir: string;
}

function projectsUnder(root: string): Projects {
  return {
    fixtureProjectDir: join(
      root,
      "experiments",
      "render-stream",
      "fixtures",
      "gate1",
    ),
    receiverProjectDir: join(root, "experiments", "render-stream", "receiver"),
  };
}

async function writeProjects(root: string): Promise<Projects> {
  const p = projectsUnder(root);
  await writeText(
    join(p.fixtureProjectDir, "project.godot"),
    'config/name="gate1 fixture"\n',
  );
  await writeText(
    join(p.fixtureProjectDir, "gate1.gd"),
    "extends Node\n# fixture\n",
  );
  await writeText(
    join(p.receiverProjectDir, "project.godot"),
    'config/name="receiver"\n',
  );
  await writeText(
    join(p.receiverProjectDir, "receiver.gd"),
    "extends Node\n# receiver\n",
  );
  return p;
}

async function writeCaptureLeg(
  dir: string,
  opts: RecordingOptions,
  extra: { trace?: boolean } = {},
): Promise<{ full: Buffer; patch: Buffer }> {
  const full = encodeRecording(opts);
  const patch = encodePatchRecording(opts);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "recording.rs1"), full);
  await writeFile(join(dir, "recording-patch.rs1"), patch);
  await writeJson(join(dir, "evidence", "result.json"), {
    schema: "render-stream-capture-result/1",
    status: "armed",
    reason: null,
    vptr_written: true,
    disarmed: true,
    display_server: "headless",
    rendering_driver: "opengl3",
    rendering_method: "gl_compatibility",
    stream: {
      path: join(dir, "recording.rs1"),
      patch_path: join(dir, "recording-patch.rs1"),
      status: "closed",
      reason: null,
      transactions: opts.quit,
    },
  });
  await writeJson(join(dir, "evidence", "counters.json"), {
    schema: "render-stream-gate-minus1-counters/1",
    frames_total: opts.quit,
    hooks_planned: [...GATE0_HOOKS],
    hooks_omitted: [],
  });
  const policy = opts.policy ?? "enforce-min-size";
  await writeJson(join(dir, "evidence", "root.json"), rootEvidence(policy));
  await writeText(join(dir, "evidence", "armed.marker"), "");
  await writeText(join(dir, "steps.jsonl"), stepLog());
  await writeText(
    join(dir, "root.jsonl"),
    rootLog("headless", policy === "observe" ? [64, 64] : [640, 360]),
  );
  await writeProcess(
    dir,
    ["/tpl/linux_release.x86_64", "--headless", "--path", "/fixture"],
    ["GRC_MODE=arm"],
    "[fixture] gate1 ready\n",
    0,
  );
  if (extra.trace) {
    await writeText(
      join(dir, "strace.txt"),
      [
        '42 10:00:00.000000 openat(AT_FDCWD, "/usr/lib/x86_64-linux-gnu/libc.so.6", O_RDONLY|O_CLOEXEC) = 3',
        `42 10:00:00.200000 openat(AT_FDCWD, "${join(dir, "evidence", "armed.marker")}", O_WRONLY|O_CREAT, 0666) = 7`,
        "",
      ].join("\n"),
    );
    await writeText(
      join(dir, "maps.txt"),
      "55d000000000-55d000001000 r-xp 00000000 103:09 1 /tpl/linux_release.x86_64\n",
    );
    await writeText(
      join(dir, "fd.txt"),
      "lrwx------ 1 u u 64 Oct  9 10:00 0 -> /dev/null\n",
    );
  }
  return { full, patch };
}

/** A receiver process directory on `bytes` (copied to recording.rs1), with applied.json and, for
 * `stateSeqs`, state/seq-<n>.json holding the resolved state. Shots are written separately. */
async function writeReceiverProcess(
  dir: string,
  projects: Projects,
  bytes: Buffer,
  shotSeqs: number[],
  rendered: boolean,
  stateSeqs: number[] = [],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "recording.rs1"), bytes);
  await writeJson(
    join(dir, "applied.json"),
    appliedFor(join(dir, "recording.rs1"), bytes, shotSeqs, stateSeqs, dir),
  );
  const summary = summarizeRecording("r", new Uint8Array(bytes));
  for (const seq of stateSeqs)
    await writeJson(
      join(dir, "state", `seq-${seq}.json`),
      resolvedState(summary, seq),
    );
  await writeProcess(
    dir,
    rendered
      ? [
          "/tpl/linux_release.x86_64",
          "--path",
          projects.receiverProjectDir,
          "--rendering-driver",
          "opengl3",
        ]
      : [
          "/tpl/linux_release.x86_64",
          "--headless",
          "--path",
          projects.receiverProjectDir,
        ],
    [`RS_RECEIVER_RECORDING=${join(dir, "recording.rs1")}`],
    "[receiver] ok\n",
    0,
  );
}

async function writeTraceStrace(
  out: string,
  projects: Projects,
): Promise<void> {
  const leg = join(out, "receiver-headless-trace");
  await writeText(
    join(leg, "strace.txt"),
    [
      `42 10:00:00.000000 openat(AT_FDCWD, "${projects.receiverProjectDir}/project.godot", O_RDONLY|O_CLOEXEC) = 3`,
      `42 10:00:00.200000 openat(AT_FDCWD, "${join(leg, "recording.rs1")}", O_RDONLY|O_CLOEXEC) = 4`,
      "",
    ].join("\n"),
  );
  const argvPath = join(leg, "argv.txt");
  await writeText(
    argvPath,
    `${["/tpl/linux_release.x86_64", "--headless", "--path", projects.receiverProjectDir].join("\n")}\n`,
  );
}

/** Sabotage legs: the receiver shows a wrong pixel inside a region at exactly the predicted
 * steps; each capture declares its sabotage in the session (which the classifier never reads). */
const SABOTAGE: Record<
  string,
  { bad: number[]; sabotage: { kind: string; frame: number; op?: string } }
> = {
  "sabotage-omit-modulate": {
    bad: G1A_EXPECTATIONS["sabotage-omit-modulate"].mismatchSteps ?? [],
    sabotage: { kind: "omit-update", frame: 11 },
  },
  "sabotage-omit-transform": {
    bad: G1A_EXPECTATIONS["sabotage-omit-transform"].mismatchSteps ?? [],
    sabotage: { kind: "omit-update", frame: 21 },
  },
  "sabotage-omit-order": {
    bad: G1A_EXPECTATIONS["sabotage-omit-order"].mismatchSteps ?? [],
    sabotage: { kind: "omit-update", frame: 31 },
  },
  "sabotage-omit-visibility": {
    bad: G1A_EXPECTATIONS["sabotage-omit-visibility"].mismatchSteps ?? [],
    sabotage: { kind: "omit-update", frame: 71 },
  },
  "sabotage-omit-free": {
    bad: G1B_EXPECTATIONS["sabotage-omit-free"].mismatchSteps ?? [],
    sabotage: { kind: "omit-op", frame: 81, op: "free" },
  },
  "sabotage-omit-visible": {
    bad: G1B_EXPECTATIONS["sabotage-omit-visible"].mismatchSteps ?? [],
    sabotage: { kind: "omit-op", frame: 61, op: "canvas_item_set_visible" },
  },
};

async function writeShots(dir: string, seqs: number[], bad: number[] = []) {
  for (const [k, seq] of seqs.entries())
    await writePng(
      join(dir, "shots", `seq-${seq}.png`),
      k,
      bad.includes(k) ? { perturb: [100, 100] } : {},
    );
}

async function buildGoodTree(out: string, projects: Projects): Promise<void> {
  await writeJson(join(out, "binary.json"), {
    path: "/tpl/linux_release.x86_64",
    sha256: "54cc",
  });
  await writeJson(join(out, "legs.json"), {
    groups_run: ["g1a", "g1b", "g1c"],
    groups_landed: ["g1a", "g1b", "g1c"],
  });
  for (const p of ["fixture", "receiver"]) {
    await writeProcess(
      join(out, "import", p),
      ["godot", "--import"],
      [],
      "import ok\n",
      0,
    );
  }
  await writeProcess(
    join(out, "receiver-typecheck", "selftest"),
    ["godot", "--script", "res://tests/codec1_selftest.gd"],
    [],
    "[rs1-selftest] ok\n",
    0,
  );
  const minimalDir = join(out, "receiver-typecheck", "minimal");
  const minimal = await readFile(join(GOLDEN_DIR, "full.rs1"));
  await mkdir(minimalDir, { recursive: true });
  await writeFile(join(minimalDir, "recording.rs1"), minimal);
  await writeJson(join(minimalDir, "applied.json"), {
    schema: "render-stream-receiver-applied/2",
    status: "ok",
    end_seen: true,
    unsupported: expectedReceiverUnsupported(
      summarizeRecording("golden", new Uint8Array(minimal)),
    ),
  });
  await writeProcess(
    minimalDir,
    ["godot", "--headless"],
    [],
    "[receiver] ok\n",
    0,
  );

  const seqs = settleSeqs();
  const capture = await writeCaptureLeg(
    join(out, "capture"),
    { quit: CAPTURE_QUIT },
    { trace: true },
  );
  await writeReceiverProcess(
    join(out, "receiver"),
    projects,
    capture.full,
    [...seqs, TIE_FRAME],
    true,
    seqs,
  );
  await writeShots(join(out, "receiver"), seqs);
  await writePng(join(out, "receiver", "shots", `seq-${TIE_FRAME}.png`), 1);
  await writeReceiverProcess(
    join(out, "receiver-patch"),
    projects,
    capture.patch,
    [...seqs, TIE_FRAME],
    true,
    seqs,
  );
  await writeShots(join(out, "receiver-patch"), seqs);
  await writePng(
    join(out, "receiver-patch", "shots", `seq-${TIE_FRAME}.png`),
    1,
  );
  await writeReceiverProcess(
    join(out, "receiver-headless-trace"),
    projects,
    capture.full,
    [],
    false,
  );
  await writeTraceStrace(out, projects);

  const ref = join(out, "reference");
  for (const s of EXPECTED.steps)
    await writePng(join(ref, "shots", `step-${s.step}.png`), s.step);
  await writePng(join(ref, "shots", `frame-${TIE_FRAME}.png`), 1);
  await writeText(join(ref, "steps.jsonl"), stepLog());
  await writeText(join(ref, "root.jsonl"), rootLog("x11"));
  await writeProcess(
    ref,
    ["/tpl/linux_release.x86_64", "--path", projects.fixtureProjectDir],
    [],
    "[fixture] shot\n",
    0,
  );

  for (const [leg, { bad, sabotage }] of Object.entries(SABOTAGE)) {
    const bytes = await writeCaptureLeg(join(out, leg, "capture"), {
      quit: SHORT_QUIT,
      sabotage,
    });
    await writeReceiverProcess(
      join(out, leg, "receiver"),
      projects,
      bytes.full,
      seqs,
      true,
    );
    await writeShots(join(out, leg, "receiver"), seqs, bad);
  }

  // The patch sink drops the Marker's step-5 entry, so it resolves to a stale Marker until step 6.
  const drop = await writeCaptureLeg(
    join(out, "sabotage-patch-drop", "capture"),
    {
      quit: SHORT_QUIT,
      sabotage: { kind: "patch-drop-item", frame: S + N * 5 },
      dropMarkerAt: S + N * 5,
    },
  );
  await writeReceiverProcess(
    join(out, "sabotage-patch-drop", "receiver"),
    projects,
    drop.patch,
    seqs,
    true,
  );
  await writeShots(join(out, "sabotage-patch-drop", "receiver"), seqs);

  // tie-overlap: the same tie, with T over P; the tie frame is shot on both sides (measured).
  const overlap = await writeCaptureLeg(join(out, "tie-overlap", "capture"), {
    quit: SHORT_QUIT,
    tieOverlap: true,
  });
  await writeReceiverProcess(
    join(out, "tie-overlap", "receiver"),
    projects,
    overlap.full,
    [...seqs, TIE_FRAME, TIE_FRAME + 1],
    true,
  );
  await writeShots(join(out, "tie-overlap", "receiver"), seqs);
  for (const frame of [TIE_FRAME, TIE_FRAME + 1]) {
    // Stand-ins: the measurement is reported, not gated.
    await writePng(
      join(out, "tie-overlap", "receiver", "shots", `seq-${frame}.png`),
      1,
    );
    await writePng(
      join(out, "tie-overlap", "reference", "shots", `frame-${frame}.png`),
      1,
      frame === TIE_FRAME ? { perturb: [120, 120] } : {},
    );
  }

  const observe = await writeCaptureLeg(
    join(out, "root-size-observe", "capture"),
    { quit: SHORT_QUIT, policy: "observe" },
  );
  await writeReceiverProcess(
    join(out, "root-size-observe", "receiver"),
    projects,
    observe.full,
    seqs,
    true,
  );
  for (const [k, seq] of seqs.entries()) {
    await writePng(
      join(out, "root-size-observe", "receiver", "shots", `seq-${seq}.png`),
      k,
      { degenerateCorner: true },
    );
  }

  await buildLiveLegs(out, projects);
}

// ---------------------------------------------------------------------------------------------
// g1c (G1c2): fabricated live legs
// ---------------------------------------------------------------------------------------------

/** The live timeline of the fabricated hosts: S = 30, N = 10, quit S + 11 N (the runner uses 300,
 * 60 and 960; the checker derives everything from steps.jsonl and the evidence). */
const LS = 30;
const LN = 10;
const LQUIT = LS + LN * 11;
/** The receiver joins at host frame 5; with credit returning in one frame, the host sends every
 * second frame (5, 7, 9, ...). */
const LFIRST = 5;
const LIVE_PORT = 41234;
const LIVE_SESSION = "0123456789abcdef0123456789abcdef";
const LIVE_STREAM = "1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c";
/** sabotage-drop-message: the transaction formed at this frame is dropped. */
const LDROP_FRAME = 71;

interface LiveOptions {
  rendered: boolean;
  /** the frame whose transaction is formed but not sent */
  dropFrame?: number;
  /** first frame with a send (default LFIRST) */
  first?: number;
  /** relabel: the tap's transaction at this frame carries the previous send's state */
  staleAt?: number;
  /** encode these live seqs as full transactions */
  fullAt?: number[];
  /** the tap only: a stream id other than the one the receiver got */
  tapStreamId?: string;
}

interface LiveSend {
  seq: number;
  frame: number;
  dropped: boolean;
}

function liveSends(opts: LiveOptions): LiveSend[] {
  const out: LiveSend[] = [];
  let seq = 1;
  let frame = opts.first ?? LFIRST;
  while (frame <= LQUIT) {
    const dropped = frame === opts.dropFrame;
    out.push({ seq, frame, dropped });
    seq++;
    // A dropped transaction keeps its credit: the next one goes out on the next frame.
    frame += dropped ? 1 : 2;
  }
  return out;
}

/** Shots: the first send inside each step window [S + N k + 7, S + N (k + 1) - 1] (the last ending
 * at the quit frame), up to the receiver's failure seq when there is one. */
function liveShots(sends: LiveSend[], stopSeq?: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of EXPECTED.steps) {
    const k = s.step;
    const from = LS + LN * k + 7;
    const to = k === 10 ? LQUIT : LS + LN * (k + 1) - 1;
    const hit = sends.find(
      (x) =>
        !x.dropped &&
        x.frame >= from &&
        x.frame <= to &&
        (stopSeq === undefined || x.seq < stopSeq),
    );
    if (hit) out.set(k, hit.seq);
  }
  return out;
}

interface LiveFiles {
  tap: Buffer;
  received: Buffer;
  sends: LiveSend[];
  /** the seq the receiver fails at (drop leg) */
  failSeq?: number;
}

function liveStreams(opts: LiveOptions): LiveFiles {
  const states = modelStates({ quit: LQUIT, start: LS, stepFrames: LN });
  const sends = liveSends(opts);
  const formed = sends.map((s, i) => {
    let state = states[s.frame - 1];
    if (opts.staleAt === s.frame && i > 0)
      state = { ...states[sends[i - 1].frame - 1], frame: s.frame };
    return state;
  });
  const session = {
    ...sessionFor({ quit: LQUIT }, "patch"),
    sessionId: LIVE_SESSION,
    streamId: LIVE_STREAM,
    transport: "websocket" as const,
    connection: 1,
  };
  const dropIndex = sends.findIndex((s) => s.dropped);
  if (dropIndex < 0) {
    const received = encodeRs1Recording(formed, {
      ...session,
      fullAt: opts.fullAt,
    });
    const tap = opts.tapStreamId
      ? encodeRs1Recording(formed, {
          ...session,
          fullAt: opts.fullAt,
          streamId: opts.tapStreamId,
        })
      : received;
    return { tap, received, sends };
  }
  // The receiver fails at the seq after the dropped one and closes: no end record anywhere.
  const kept = formed.slice(0, dropIndex + 2);
  const tap = encodeRs1Recording(kept, { ...session, noEnd: true });
  const split = splitRecords(new Uint8Array(tap));
  const dropped = split.records[1 + dropIndex];
  const received = Buffer.concat([
    tap.subarray(0, dropped.offset),
    tap.subarray(dropped.offset + dropped.byte_length),
  ]);
  return {
    tap,
    received,
    sends: sends.slice(0, dropIndex + 2),
    failSeq: sends[dropIndex + 1].seq,
  };
}

function liveLogLines(files: LiveFiles, opts: LiveOptions): string[] {
  const stage = opts.rendered ? "submitted" : "applied";
  const stages = opts.rendered
    ? ["received", "applied", "submitted"]
    : ["received", "applied"];
  const first = files.sends[0].frame;
  let t = 1_000_000;
  const at = () => (t += 1000);
  const lines: Record<string, unknown>[] = [
    {
      frame: first - 1,
      t_us: at(),
      event: "open",
      connection: 1,
      stream_id: LIVE_STREAM,
    },
    {
      frame: first - 1,
      t_us: at(),
      state: "await-hello",
      credit: false,
      in_flight: null,
      pending: false,
      coalesced: 0,
      queued_bytes: 0,
      sent: null,
    },
    {
      frame: first,
      t_us: at(),
      event: "hello",
      receiver: "gate1-receiver",
      credit_stage: stage,
      inbound_buffer_bytes: 16777216,
      max_message_bytes: 16777216,
    },
  ];
  const tapSummary = summarizeRecording("tap", new Uint8Array(files.tap));
  const bytesOf = (seq: number) =>
    tapSummary.transactions.find((x) => x.meta.seq === seq)?.bytes ?? 0;
  const bySendFrame = new Map(files.sends.map((s) => [s.frame, s]));
  const last = files.sends[files.sends.length - 1];
  let inFlight: number | null = null;
  const end = files.failSeq !== undefined ? last.frame : LQUIT;
  for (let frame = first; frame <= end; frame++) {
    const send = bySendFrame.get(frame);
    if (send && inFlight !== null) {
      for (const st of stages)
        lines.push({
          frame,
          t_us: at(),
          event: "ack",
          seq: inFlight,
          stream_id: LIVE_STREAM,
          stage: st,
          receiver_t_us: t,
          credited: st === stage,
          ignored: null,
        });
      inFlight = null;
    }
    const credit = send !== undefined;
    lines.push({
      frame,
      t_us: at(),
      state: "streaming",
      credit,
      in_flight: send && !send.dropped ? send.seq : inFlight,
      pending: false,
      coalesced: 0,
      queued_bytes: send && !send.dropped ? bytesOf(send.seq) : 0,
      sent: send
        ? {
            seq: send.seq,
            encoding: send.seq === 1 ? "full" : "patch",
            bytes: bytesOf(send.seq),
            ...(send.dropped ? { dropped: true } : {}),
          }
        : null,
    });
    if (send && !send.dropped) inFlight = send.seq;
  }
  if (files.failSeq !== undefined) {
    lines.push({
      frame: end,
      t_us: at(),
      event: "close",
      code: 1000,
      reason: "replay-failure",
      closed_by: "receiver",
    });
    return lines.map((l) => JSON.stringify(l));
  }
  lines.push({
    frame: LQUIT,
    t_us: at(),
    event: "end",
    reason: "shutdown",
    transactions: files.sends.length,
    bytes: 200,
  });
  if (inFlight !== null)
    for (const st of stages)
      lines.push({
        frame: LQUIT,
        t_us: at(),
        event: "ack",
        seq: inFlight,
        stream_id: LIVE_STREAM,
        stage: st,
        receiver_t_us: t,
        credited: st === stage,
        ignored: null,
      });
  lines.push({
    frame: LQUIT,
    t_us: at(),
    event: "close",
    code: 1000,
    reason: "end seen",
    closed_by: "receiver",
  });
  return lines.map((l) => JSON.stringify(l));
}

function liveSummary(
  files: LiveFiles,
  opts: LiveOptions,
): Record<string, unknown> {
  const sent = files.sends.filter((s) => !s.dropped).length;
  const failed = files.failSeq !== undefined;
  const acked = failed ? sent - 1 : sent;
  const lat = {
    count: acked,
    min: 9000,
    median: 11000,
    p95: 12000,
    max: 15000,
  };
  return {
    schema: "render-stream-live-summary/1",
    connections: [
      {
        connection: 1,
        stream_id: LIVE_STREAM,
        receiver: "gate1-receiver",
        credit_stage: opts.rendered ? "submitted" : "applied",
        inbound_buffer_bytes: 16777216,
        max_message_bytes: 16777216,
        frames_offered: LQUIT - files.sends[0].frame + 1,
        transactions: files.sends.length,
        sent,
        dropped: files.sends.length - sent,
        full: 1,
        patch: files.sends.length - 1,
        coalesced: 0,
        max_in_flight: 1,
        max_queued_bytes: 8000,
        max_message_sent: 8000,
        bytes_sent: files.received.length,
        resyncs: 0,
        credits: acked,
        acks: {
          received: acked,
          applied: acked,
          submitted: opts.rendered ? acked : 0,
        },
        acks_ignored: 0,
        end_sent: !failed,
        close_code: 1000,
        closed_by: "receiver",
        close_reason: failed ? "replay-failure" : "end seen",
        error_sent: null,
        ack_latency_us: {
          received: lat,
          applied: lat,
          submitted: opts.rendered ? lat : null,
        },
        credit_rtt_us: lat,
        credit_rtt_frames: { count: acked, min: 1, median: 2, p95: 2, max: 2 },
      },
    ],
  };
}

async function writeLiveHost(
  dir: string,
  files: LiveFiles,
  opts: LiveOptions,
): Promise<void> {
  const { full, patch } = await writeCaptureLeg(dir, {
    quit: LQUIT,
    start: LS,
    stepFrames: LN,
  });
  void full;
  void patch;
  await writeText(join(dir, "steps.jsonl"), stepLog(LS, LN));
  await editJson<Record<string, unknown>>(
    join(dir, "evidence", "result.json"),
    (r) => {
      r.live = {
        status: "closed",
        listen: "127.0.0.1:0",
        address: "127.0.0.1",
        port: LIVE_PORT,
        reason: null,
        connections: 1,
      };
    },
  );
  await writeJson(join(dir, "evidence", "live.json"), {
    schema: "render-stream-live/1",
    status: "listening",
    address: "127.0.0.1",
    port: LIVE_PORT,
    reason: null,
  });
  await writeJson(
    join(dir, "evidence", "live-summary.json"),
    liveSummary(files, opts),
  );
  await mkdir(join(dir, "tap"), { recursive: true });
  await writeFile(join(dir, "tap", "stream-1.rs1"), files.tap);
  await writeText(
    join(dir, "tap", "live-1.jsonl"),
    `${liveLogLines(files, opts).join("\n")}\n`,
  );
}

function liveApplied(
  dir: string,
  files: LiveFiles,
  opts: LiveOptions,
  shots: Map<number, number>,
): Record<string, unknown> {
  const summary = summarizeRecording(
    "received",
    new Uint8Array(files.received),
  );
  const failed = files.failSeq !== undefined;
  const tx = summary.transactions.filter(
    (t) => !failed || t.meta.seq < (files.failSeq as number),
  );
  const acks = {
    received: tx.length,
    applied: tx.length,
    submitted: opts.rendered ? tx.length : 0,
  };
  return {
    schema: "render-stream-receiver-applied/2",
    mode: "live",
    recording: {
      path: join(dir, "received.rs1"),
      sha256: summary.sha256,
      bytes: files.received.length,
    },
    session_id: LIVE_SESSION,
    streams: [
      {
        stream_id: LIVE_STREAM,
        connection: 1,
        received_path: join(dir, "received.rs1"),
        received_sha256: summary.sha256,
        received_bytes: files.received.length,
        end_seen: !failed,
        closed_by: "receiver",
        close_code: 1000,
      },
    ],
    status: failed ? "replay-failure" : "ok",
    failure: failed
      ? {
          seq: files.failSeq,
          reason: "seq-gap",
          detail: `transaction has seq ${files.failSeq}, expected ${(files.failSeq as number) - 1}`,
        }
      : null,
    end_seen: !failed,
    viewport: {
      display_server: opts.rendered ? "X11" : "headless",
      size: opts.rendered ? [640, 360] : [64, 64],
      size_check: opts.rendered ? "ok" : "skipped-headless",
      logical_size: [640, 360],
      canvas_transform: [1, 0, 0, 1, 8, 4],
    },
    transactions: tx.map((t, i) => ({
      stream: 1,
      seq: t.meta.seq,
      frame: t.meta.frame,
      encoding: t.meta.encoding,
      record_sha256: t.sha256,
      process_frame: i + 2,
      created: 0,
      freed: 0,
      reparented: 0,
      commands_replayed: 0,
      rs_calls: rsCallsOf(t.meta.seq),
      received_us: 1000 * t.meta.seq,
      applied_us: 1000 * t.meta.seq + 300,
      submitted_us: opts.rendered ? 1000 * t.meta.seq + 600 : null,
      skipped: null,
    })),
    shots: [...shots.entries()].map(([step, seq]) => ({
      stream: 1,
      seq,
      step,
      path: join(dir, "shots", `seq-${seq}.png`),
      state_path: join(dir, "state", `seq-${seq}.json`),
      process_frame: seq + 2,
      applied_through: seq,
    })),
    shots_missed: opts.rendered
      ? EXPECTED.steps.map((s) => s.step).filter((k) => !shots.has(k))
      : [],
    unsupported: expectedReceiverUnsupported({ transactions: tx }),
    live: {
      url: `ws://127.0.0.1:${LIVE_PORT}/render-stream`,
      credit_stage: opts.rendered ? "submitted" : "applied",
      inbound_buffer_bytes: 16777216,
      presented: "unavailable",
      acks_sent: acks,
      stall: null,
      reconnect: null,
      resync: null,
    },
  };
}

async function writeLiveReceiver(
  dir: string,
  projects: Projects,
  files: LiveFiles,
  opts: LiveOptions,
): Promise<Map<number, number>> {
  const shots = opts.rendered
    ? liveShots(files.sends, files.failSeq)
    : new Map<number, number>();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "received.rs1"), files.received);
  await writeJson(
    join(dir, "applied.json"),
    liveApplied(dir, files, opts, shots),
  );
  const summary = summarizeRecording("r", new Uint8Array(files.received));
  for (const [step, seq] of shots) {
    await writePng(join(dir, "shots", `seq-${seq}.png`), step);
    await writeJson(
      join(dir, "state", `seq-${seq}.json`),
      resolvedState(summary, seq),
    );
  }
  await writeProcess(
    dir,
    opts.rendered
      ? [
          "/tpl/linux_release.x86_64",
          "--path",
          projects.receiverProjectDir,
          "--rendering-driver",
          "opengl3",
          "--max-fps",
          "60",
        ]
      : [
          "/tpl/linux_release.x86_64",
          "--headless",
          "--max-fps",
          "60",
          "--path",
          projects.receiverProjectDir,
        ],
    [
      "RS_RECEIVER_MODE=live",
      `RS_RECEIVER_URL=ws://127.0.0.1:${LIVE_PORT}/render-stream`,
    ],
    `[receiver] connected to ws://127.0.0.1:${LIVE_PORT}/render-stream (subprotocol render-stream.1); hello sent\n[receiver] ok\n`,
    files.failSeq !== undefined ? 3 : 0,
  );
  if (!opts.rendered) await writeLiveTrace(dirname(dir), projects);
  return shots;
}

/** The headless live receiver's strace and argv, naming this tree's own paths (rewritten per
 * scenario, since the template tree is copied). */
async function writeLiveTrace(
  legDir: string,
  projects: Projects,
): Promise<void> {
  const dir = join(legDir, "receiver");
  await writeText(
    join(dir, "strace.txt"),
    [
      `42 10:00:00.000000 openat(AT_FDCWD, "${projects.receiverProjectDir}/project.godot", O_RDONLY|O_CLOEXEC) = 3`,
      `42 10:00:00.200000 openat(AT_FDCWD, "${join(dir, "received.rs1")}", O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0644) = 5`,
      "",
    ].join("\n"),
  );
  await writeText(
    join(dir, "argv.txt"),
    `${["/tpl/linux_release.x86_64", "--headless", "--max-fps", "60", "--path", projects.receiverProjectDir].join("\n")}\n`,
  );
}

/** live-replay: a file-mode receiver on live/receiver/received.rs1 at the live shots' seqs. */
async function writeLiveReplay(
  out: string,
  projects: Projects,
  received: Buffer,
  shots: Map<number, number>,
): Promise<void> {
  const dir = join(out, "live-replay");
  const seqs = [...shots.values()];
  await writeReceiverProcess(dir, projects, received, seqs, true, seqs);
  for (const [step, seq] of shots)
    await writePng(join(dir, "shots", `seq-${seq}.png`), step);
}

/** The whole g1c group: live, live-replay, live-headless, sabotage-drop-message. */
async function buildLiveLegs(
  out: string,
  projects: Projects,
  overrides: Partial<
    Record<
      "live" | "live-headless" | "sabotage-drop-message",
      Partial<LiveOptions>
    >
  > = {},
): Promise<void> {
  const legs = {
    live: { rendered: true, ...overrides.live },
    "live-headless": { rendered: false, ...overrides["live-headless"] },
    "sabotage-drop-message": {
      rendered: true,
      dropFrame: LDROP_FRAME,
      ...overrides["sabotage-drop-message"],
    },
  } as const;
  for (const [leg, opts] of Object.entries(legs)) {
    const files = liveStreams(opts);
    await writeLiveHost(join(out, leg, "host"), files, opts);
    const shots = await writeLiveReceiver(
      join(out, leg, "receiver"),
      projects,
      files,
      opts,
    );
    if (leg === "live")
      await writeLiveReplay(out, projects, files.received, shots);
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

interface Scenario {
  name: string;
  mutate?: (out: string, projects: Projects) => Promise<void>;
  expected?: (e: Gate1Expected) => Gate1Expected;
  checks?: Record<string, boolean>;
  classes?: Partial<
    Record<Gate1Leg | (typeof G1C_CLASSIFIED_LEGS)[number], Gate1Class>
  >;
  report?: (report: Gate1Report) => void;
  gatePassed?: boolean;
}

const ALL_LEGS = [...G1A_CLASSIFIED_LEGS, ...G1B_CLASSIFIED_LEGS];

const ALL_CHECK_IDS = [
  "expected-self-consistent",
  "capture-armed",
  "headless-no-gpu",
  "recording-decodes",
  "manifest-present",
  "step-alignment",
  "expected-image-reference",
  "expected-image-receiver",
  "receiver-vs-reference",
  "retained-invariants",
  "root-geometry",
  "receiver-consumed-stream",
  "receiver-never-loaded-fixture",
  "receiver-typed-clean",
  "patch-resolves-to-full",
  "patch-first-full",
  "patch-transform-only",
  "patch-vs-full-pixels",
  "patch-vs-full-receiver-state",
  "patch-bytes",
  "draw-index-ties",
  "tie-frame-pixels",
  ...ALL_LEGS.map((leg) => `leg-class-${leg}`),
];

/** Rewrites the main capture (both sinks) and keeps both receivers consistent with it, so only
 * the targeted checks move. */
const rewriteCapture =
  (opts: RecordingOptions) => async (out: string, projects: Projects) => {
    const full = encodeRecording(opts);
    const patch = encodePatchRecording(opts);
    await writeFile(join(out, "capture", "recording.rs1"), full);
    await writeFile(join(out, "capture", "recording-patch.rs1"), patch);
    const shots = [...settleSeqs(), TIE_FRAME];
    await writeReceiverProcess(
      join(out, "receiver"),
      projects,
      full,
      shots,
      true,
      settleSeqs(),
    );
    await writeReceiverProcess(
      join(out, "receiver-patch"),
      projects,
      patch,
      shots,
      true,
      settleSeqs(),
    );
  };

/** Rewrites one live leg (host and receiver; live also rewrites live-replay). */
async function rewriteLiveLeg(
  out: string,
  projects: Projects,
  leg: "live" | "live-headless" | "sabotage-drop-message",
  opts: LiveOptions,
): Promise<void> {
  await rm(join(out, leg), { recursive: true, force: true });
  const files = liveStreams(opts);
  await writeLiveHost(join(out, leg, "host"), files, opts);
  const shots = await writeLiveReceiver(
    join(out, leg, "receiver"),
    projects,
    files,
    opts,
  );
  if (leg === "live") {
    await rm(join(out, "live-replay"), { recursive: true, force: true });
    await writeLiveReplay(out, projects, files.received, shots);
  }
}

/** Rewrites the lines of a live host's log. */
async function editLiveLog(
  out: string,
  leg: string,
  edit: (lines: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<void> {
  const path = join(out, leg, "host", "tap", "live-1.jsonl");
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  await writeText(
    path,
    `${edit(lines)
      .map((l) => JSON.stringify(l))
      .join("\n")}\n`,
  );
}

const G1C_CHECK_IDS = [
  "live-listening",
  "live-handshake",
  "live-tap-equals-received",
  "live-decodes",
  "live-first-full-then-patch",
  "live-resolves-to-recording",
  "live-replay-equals-live",
  "live-vs-reference",
  "live-credit-bounded",
  "live-acks-staged",
  "live-receiver-late",
  "receiver-never-loaded-fixture-live",
  ...G1C_CLASSIFIED_LEGS.map((leg) => `leg-class-${leg}`),
];

/** The live leg's applied.json shots, step -> seq. */
async function liveShotSeqs(out: string): Promise<Map<number, number>> {
  const applied = await readJsonFile<{
    shots: { step: number; seq: number }[];
  }>(join(out, "live", "receiver", "applied.json"));
  return new Map(applied.shots.map((s) => [s.step, s.seq]));
}

const liveScenarios: Scenario[] = [
  {
    name: "g1c: a send while the previous transaction still holds the credit is delivery-violation",
    mutate: (out) =>
      // Drop the credit-returning acks of one seq: the next send then has two in flight.
      editLiveLog(out, "live", (lines) =>
        lines.filter((l) => !(l.event === "ack" && l.seq === 10)),
      ),
    checks: { "live-credit-bounded": false },
    classes: { live: "delivery-violation" },
  },
  {
    name: "g1c: a send logged without credit is delivery-violation",
    mutate: (out) =>
      editLiveLog(out, "live", (lines) =>
        lines.map((l) =>
          (l.sent as { seq?: number } | null)?.seq === 20
            ? { ...l, credit: false }
            : l,
        ),
      ),
    checks: { "live-credit-bounded": false },
    classes: { live: "delivery-violation" },
  },
  {
    name: "g1c: queued bytes above the largest message + 4096 are delivery-violation",
    mutate: (out) =>
      editLiveLog(out, "live-headless", (lines) =>
        lines.map((l) =>
          l.frame === 21 && l.state !== undefined
            ? { ...l, queued_bytes: 999999 }
            : l,
        ),
      ),
    checks: { "live-credit-bounded": false },
    classes: { "live-headless": "delivery-violation" },
  },
  {
    name: "g1c: a live transaction carrying an earlier frame's state is stale-state",
    mutate: (out, projects) =>
      rewriteLiveLeg(out, projects, "live", {
        rendered: true,
        staleAt: LS + LN * 2 + 1,
      }),
    checks: {
      "live-resolves-to-recording": false,
      "live-credit-bounded": true,
      "live-vs-reference": true,
    },
    classes: { live: "delivery-violation", "live-replay": "success" },
    report: (r) =>
      assert(
        "report: the stale live transaction is named",
        r.legs.live.reasons.some((x) => x.includes("stale-state")),
        r.legs.live.reasons.join(" | "),
      ),
  },
  {
    name: "g1c: received bytes that differ from the host's tap are replay-failure",
    mutate: (out, projects) =>
      rewriteLiveLeg(out, projects, "live", {
        rendered: true,
        tapStreamId: "2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d",
      }),
    checks: {
      "live-tap-equals-received": false,
      "live-decodes": true,
      "live-credit-bounded": true,
    },
    classes: { live: "replay-failure" },
  },
  {
    name: "g1c: a receiver that joined after step 0 settled is late",
    mutate: (out, projects) =>
      rewriteLiveLeg(out, projects, "live", { rendered: true, first: LS + 7 }),
    checks: { "live-receiver-late": false, "live-vs-reference": true },
    classes: { live: "replay-failure" },
  },
  {
    name: "g1c: a step window without a shot is replay-failure and fails live-vs-reference",
    mutate: async (out) => {
      const applied = join(out, "live", "receiver", "applied.json");
      await editJson<{ shots: { step: number }[]; shots_missed: number[] }>(
        applied,
        (a) => {
          a.shots = a.shots.filter((s) => s.step !== 3);
          a.shots_missed = [3];
        },
      );
    },
    checks: { "live-vs-reference": false },
    classes: { live: "replay-failure", "live-replay": "replay-failure" },
  },
  {
    name: "g1c: a live shot that differs from the reference is pixel-mismatch",
    mutate: async (out) => {
      const seq = (await liveShotSeqs(out)).get(4) as number;
      await writePng(
        join(out, "live", "receiver", "shots", `seq-${seq}.png`),
        4,
        { perturb: [100, 100] },
      );
    },
    checks: { "live-vs-reference": false, "live-replay-equals-live": false },
    classes: { live: "pixel-mismatch", "live-replay": "success" },
  },
  {
    name: "g1c: a replay shot that differs from the live one fails live-replay-equals-live",
    mutate: async (out) => {
      const seq = (await liveShotSeqs(out)).get(5) as number;
      await writePng(join(out, "live-replay", "shots", `seq-${seq}.png`), 5, {
        perturb: [101, 101],
      });
    },
    checks: { "live-replay-equals-live": false, "live-vs-reference": true },
    classes: { "live-replay": "pixel-mismatch", live: "success" },
  },
  {
    name: "g1c: a transaction never acked submitted fails live-acks-staged",
    mutate: (out) =>
      editJson<{ transactions: { submitted_us: number | null }[] }>(
        join(out, "live", "receiver", "applied.json"),
        (a) => {
          a.transactions[3].submitted_us = null;
        },
      ),
    checks: { "live-acks-staged": false },
  },
  {
    name: "g1c: a connection the host closed (not the receiver after its end record) fails live-handshake",
    mutate: (out) =>
      editJson<{ connections: { closed_by: string }[] }>(
        join(out, "live", "host", "evidence", "live-summary.json"),
        (s) => {
          s.connections[0].closed_by = "host";
        },
      ),
    checks: { "live-handshake": false },
  },
  {
    name: "g1c: a listener on a non-loopback address fails live-listening",
    mutate: (out) =>
      editJson<{ address: string }>(
        join(out, "live-headless", "host", "evidence", "live.json"),
        (l) => {
          l.address = "0.0.0.0";
        },
      ),
    checks: { "live-listening": false },
  },
  {
    name: "g1c: a drop-message leg whose receiver never saw a gap fails its leg class",
    mutate: (out, projects) =>
      rewriteLiveLeg(out, projects, "sabotage-drop-message", {
        rendered: true,
      }),
    checks: { "leg-class-sabotage-drop-message": false },
    classes: { "sabotage-drop-message": "success" },
  },
  {
    name: "g1c: the headless live receiver opening a fixture file fails receiver-never-loaded-fixture-live",
    mutate: async (out, projects) => {
      const path = join(out, "live-headless", "receiver", "strace.txt");
      const text = await readFile(path, "utf8");
      await writeText(
        path,
        `${text}42 10:00:01.000000 openat(AT_FDCWD, "${projects.fixtureProjectDir}/gate1.gd", O_RDONLY|O_CLOEXEC) = 9\n`,
      );
    },
    checks: { "receiver-never-loaded-fixture-live": false },
  },
  {
    name: "g1c: a live stream with a full transaction after seq 1 fails live-first-full-then-patch",
    mutate: (out, projects) =>
      rewriteLiveLeg(out, projects, "live-headless", {
        rendered: false,
        fullAt: [3],
      }),
    checks: { "live-first-full-then-patch": false, "live-decodes": true },
  },
  {
    name: "g1c: a received stream cut before its end record fails live-decodes",
    mutate: async (out) => {
      const path = join(out, "live-headless", "receiver", "received.rs1");
      const bytes = new Uint8Array(await readFile(path));
      const split = splitRecords(bytes);
      const end = split.records[split.records.length - 1];
      await writeFile(path, bytes.subarray(0, end.offset));
    },
    checks: { "live-decodes": false, "live-tap-equals-received": false },
    classes: { "live-headless": "replay-failure" },
  },
  {
    name: "g1c: a run without g1c reports not-run and fails the gate",
    mutate: (out) =>
      writeJson(join(out, "legs.json"), {
        groups_run: ["g1a", "g1b"],
        groups_landed: ["g1a", "g1b", "g1c"],
      }),
    gatePassed: false,
    report: (r) =>
      assert(
        "report: g1c not_run, its group check not-run, live null",
        r.groups.not_run.join() === "g1c" &&
          r.checks.some(
            (c) => c.id === "group-g1c" && c.status === "not-run",
          ) &&
          r.live === null,
      ),
  },
  {
    name: "g1c without g1a fails the gate",
    mutate: (out) =>
      writeJson(join(out, "legs.json"), {
        groups_run: ["g1c"],
        groups_landed: ["g1a", "g1b", "g1c"],
      }),
    gatePassed: false,
    report: (r) =>
      assert(
        "report: a failed g1c group check",
        r.checks.some((c) => c.id === "group-g1c" && c.status === "fail"),
      ),
  },
];

const scenarios: Scenario[] = [
  {
    name: "the good tree passes every check, every leg at its expected class",
    checks: Object.fromEntries(
      [...ALL_CHECK_IDS, ...G1C_CHECK_IDS].map((id) => [id, true]),
    ),
    classes: {
      ...Object.fromEntries(
        ALL_LEGS.map((leg) => [leg, GATE1_EXPECTATIONS[leg].class]),
      ),
      ...Object.fromEntries(
        G1C_CLASSIFIED_LEGS.map((leg) => [leg, G1C_EXPECTATIONS[leg].class]),
      ),
    },
    gatePassed: true,
    report: (r) => {
      assert("report: schema", r.schema === "render-stream-gate1-report/1");
      assert(
        "report: groups",
        r.groups.run.join() === "g1a,g1b,g1c" && r.groups.not_run.length === 0,
      );
      assert(
        "report: every leg present, support legs null-classed",
        [...ALL_LEGS, ...G1C_CLASSIFIED_LEGS, ...G1A_SUPPORT_LEGS].every(
          (l) => l in r.legs,
        ) && G1A_SUPPORT_LEGS.every((l) => r.legs[l].expected_class === null),
      );
      assert(
        "report: 143 checkpoints (13 shooting receiver legs x 11 steps, live, live-replay and the drop leg included), each with leg, stream and 9 regions",
        r.checkpoints.length === 143 &&
          r.checkpoints.every(
            (c) => c.regions.length === 9 && typeof c.leg === "string",
          ) &&
          r.checkpoints.filter((c) => c.stream === "patch").length === 55,
        `${r.checkpoints.length}`,
      );
      assert(
        "report: stream.full and stream.patch from the capture end records",
        r.stream.full.transactions === CAPTURE_QUIT &&
          r.stream.patch?.patch_transactions === CAPTURE_QUIT - 1 &&
          r.stream.patch?.full_transactions === 1,
      );
      assert(
        "report: patch_bytes recorded",
        (r.patch_bytes?.patch.bytes_total ?? 0) > 0 &&
          (r.patch_bytes?.patch.bytes_total ?? 0) <
            (r.patch_bytes?.full.bytes_total ?? 0),
      );
      assert(
        "report: the capture's one harmless tie at frame 11 between P (1) and T (20)",
        r.ties?.capture.length === 1 &&
          r.ties.capture[0].frame === TIE_FRAME &&
          r.ties.capture[0].members.join() === "1,20" &&
          r.ties.capture[0].harmless === true &&
          r.ties.tie_overlap.length === 1 &&
          r.ties.tie_overlap[0].harmless === false,
        JSON.stringify(r.ties),
      );
      assert(
        "report: tie_overlap_pixels measured at frames 11 and 12 (receiver vs reference 1 and 0 px, the reference's frames 1 px apart)",
        JSON.stringify(r.ties?.tie_overlap_pixels?.frames) === "[11,12]" &&
          JSON.stringify(r.ties?.tie_overlap_pixels?.receiver_vs_reference) ===
            "[1,0]" &&
          r.ties?.tie_overlap_pixels?.reference_tie_vs_next === 1,
        JSON.stringify(r.ties?.tie_overlap_pixels),
      );
      assert(
        "report: the capture leg lists its harmless tie",
        (r.legs.capture.harmless_ties ?? []).join() === `${TIE_FRAME}:1`,
      );
      assert(
        "report: root_geometry has the session declaration, 11 equal per-step transforms",
        r.root_geometry?.status === "match" &&
          r.root_geometry.per_step.length === 11 &&
          r.root_geometry.per_step.every((p) => p.equal),
      );
      assert(
        "report: root-size-observe reasons name degenerate-host-size and its pixel mismatch",
        r.legs["root-size-observe"].reasons.some((x) =>
          x.startsWith("unsupported: degenerate-host-size"),
        ) &&
          r.legs["root-size-observe"].reasons.some((x) =>
            x.startsWith("pixel-mismatch:"),
          ),
      );
      assert(
        "report: every quoted image path is under the run directory",
        r.checkpoints.every(
          (c) =>
            c.reference_png.includes("/out/") &&
            (c.receiver_png ?? "/out/").includes("/out/"),
        ),
      );
    },
  },
  {
    name: "a draw colour off the 51-step grid fails expected-self-consistent",
    expected: (e) => {
      const copy = JSON.parse(JSON.stringify(e)) as Gate1Expected;
      copy.steps[2].draws[0].rgba8 = [250, 0, 255, 255];
      return copy;
    },
    checks: { "expected-self-consistent": false },
  },
  {
    name: "a marker colour reused by another item fails expected-self-consistent",
    expected: (e) => {
      const copy = JSON.parse(JSON.stringify(e)) as Gate1Expected;
      copy.steps[0].draws[0].rgba8 = [...copy.steps[4].marker_rgba8];
      return copy;
    },
    checks: { "expected-self-consistent": false },
  },
  {
    name: "counters.json omitting a hook fails capture-armed",
    mutate: (out) =>
      editJson<{ hooks_omitted: string[] }>(
        join(out, "capture", "evidence", "counters.json"),
        (c) => {
          c.hooks_omitted = ["canvas_item_set_z_index"];
        },
      ),
    checks: { "capture-armed": false },
  },
  {
    name: "a GPU library in the capture host's maps fails headless-no-gpu",
    mutate: (out) =>
      writeText(
        join(out, "capture", "maps.txt"),
        "7f00-7f01 r-xp 0 0:0 3 /usr/lib/x86_64-linux-gnu/libGLX_nvidia.so.0\n",
      ),
    checks: { "headless-no-gpu": false },
  },
  {
    name: "a recording without its end record fails recording-decodes and makes capture capture-failure",
    mutate: (out) =>
      writeFile(
        join(out, "capture", "recording.rs1"),
        encodeRecording({ quit: CAPTURE_QUIT, noEnd: true }),
      ),
    checks: {
      "recording-decodes": false,
      "leg-class-capture": false,
      "patch-resolves-to-full": false,
    },
    classes: { capture: "capture-failure" },
  },
  {
    name: "a capture session with sabotage set fails manifest-present (the classifier ignores it)",
    mutate: rewriteCapture({
      quit: CAPTURE_QUIT,
      sabotage: { kind: "omit-update", frame: 21 },
    }),
    checks: { "manifest-present": false, "leg-class-capture": true },
    classes: { capture: "success" },
  },
  {
    name: "a marker colour published one frame late fails step-alignment",
    mutate: rewriteCapture({
      quit: CAPTURE_QUIT,
      delay: { step: 6, frames: 1 },
    }),
    checks: { "step-alignment": false, "recording-decodes": true },
  },
  {
    name: "a reference steps.jsonl with a wrong settle frame fails step-alignment",
    mutate: (out) =>
      writeText(
        join(out, "reference", "steps.jsonl"),
        stepLog().replace('"settle_frame":48', '"settle_frame":49'),
      ),
    checks: { "step-alignment": false },
  },
  {
    name: "one changed reference pixel fails expected-image-reference and receiver-vs-reference",
    mutate: (out) =>
      writePng(join(out, "reference", "shots", "step-5.png"), 5, {
        perturb: [300, 100],
      }),
    checks: {
      "expected-image-reference": false,
      "receiver-vs-reference": false,
      "expected-image-receiver": true,
      "leg-class-receiver": false,
      "patch-vs-full-pixels": false,
    },
    classes: { receiver: "pixel-mismatch", "receiver-patch": "pixel-mismatch" },
  },
  {
    name: "one changed receiver pixel in the lifetime region fails expected-image-receiver and receiver-vs-reference",
    mutate: (out) =>
      writePng(
        join(out, "receiver", "shots", `seq-${settleSeqs()[8]}.png`),
        8,
        { perturb: [450, 220] },
      ),
    checks: {
      "expected-image-receiver": false,
      "receiver-vs-reference": false,
      "leg-class-receiver": false,
      "patch-vs-full-pixels": false,
    },
    report: (r) =>
      assert(
        "report: step 8's lifetime region holds the 1-pixel mismatch, no other region does",
        r.checkpoints
          .filter((c) => c.leg === "receiver")[8]
          .regions.every((x) =>
            x.name === "lifetime"
              ? x.mismatched_pixels === 1
              : x.mismatched_pixels === 0,
          ),
      ),
  },
  {
    name: "a step 3 that never swaps the draw indices fails retained-invariants",
    mutate: rewriteCapture({ quit: CAPTURE_QUIT, noSwap: true }),
    checks: { "retained-invariants": false, "draw-index-ties": true },
  },
  {
    name: "a canvas move that also redraws every item fails retained-invariants and patch-transform-only",
    mutate: rewriteCapture({ quit: CAPTURE_QUIT, redrawAtShift: true }),
    checks: { "retained-invariants": false, "patch-transform-only": false },
  },
  {
    name: "overlapping siblings Q1/Q2 at one draw_index: an undeclared, overlapping tie -> draw-index-ties fails, capture unsupported",
    mutate: rewriteCapture({ quit: CAPTURE_QUIT, tie: true }),
    checks: {
      "draw-index-ties": false,
      "retained-invariants": false,
      "leg-class-capture": false,
      "leg-class-receiver": false,
    },
    classes: { capture: "unsupported", receiver: "unsupported" },
  },
  {
    name: "a T that is never raised keeps its harmless tie: draw-index-ties fails (undeclared frames), the capture is still success",
    mutate: rewriteCapture({ quit: CAPTURE_QUIT, noTieRaise: true }),
    checks: {
      "draw-index-ties": false,
      "leg-class-capture": true,
      "retained-invariants": false,
    },
    classes: { capture: "success" },
  },
  {
    name: "a T overlapping P in the main capture: draw-index-ties fails (not harmless) and the capture is unsupported",
    mutate: rewriteCapture({ quit: CAPTURE_QUIT, tieOverlap: true }),
    checks: { "draw-index-ties": false, "leg-class-capture": false },
    classes: { capture: "unsupported" },
  },
  {
    name: "a step 2 that also redraws P fails patch-transform-only",
    mutate: rewriteCapture({ quit: CAPTURE_QUIT, redrawP2: true }),
    checks: { "patch-transform-only": false, "patch-resolves-to-full": true },
  },
  {
    name: "a capture recording without step 10's canvas move fails root-geometry",
    mutate: rewriteCapture({ quit: CAPTURE_QUIT, noCanvasShift: true }),
    checks: { "root-geometry": false, "retained-invariants": false },
  },
  {
    name: "a host root.jsonl with the 64x64 window fails root-geometry",
    mutate: (out) =>
      writeText(
        join(out, "capture", "root.jsonl"),
        rootLog("headless", [64, 64]),
      ),
    checks: { "root-geometry": false },
  },
  {
    name: "a capture session declared degenerate under observe fails root-geometry and manifest-present and classifies capture unsupported",
    mutate: rewriteCapture({ quit: CAPTURE_QUIT, policy: "observe" }),
    checks: {
      "root-geometry": false,
      "manifest-present": false,
      "leg-class-capture": false,
      "leg-class-receiver": false,
    },
    classes: { capture: "unsupported", receiver: "unsupported" },
  },
  {
    name: "a failed enforcement (root-size-enforce-failed) classifies capture-failure",
    mutate: rewriteCapture({ quit: CAPTURE_QUIT, enforceFailed: true }),
    checks: { "root-geometry": false, "leg-class-capture": false },
    classes: { capture: "capture-failure", receiver: "capture-failure" },
  },
  {
    name: "a sabotage capture without its recording classifies capture-failure",
    mutate: (out) =>
      rm(join(out, "sabotage-omit-order", "capture", "recording.rs1")),
    checks: { "leg-class-sabotage-omit-order": false },
    classes: { "sabotage-omit-order": "capture-failure" },
  },
  {
    name: "a changed record_sha256 fails receiver-consumed-stream and classifies replay-failure",
    mutate: (out) =>
      editJson<{ transactions: { record_sha256: string }[] }>(
        join(out, "receiver", "applied.json"),
        (a) => {
          a.transactions[7].record_sha256 = "0".repeat(64);
        },
      ),
    checks: { "receiver-consumed-stream": false, "leg-class-receiver": false },
    classes: { receiver: "replay-failure" },
  },
  {
    name: "a receiver-patch that echoes the full sink's hashes classifies replay-failure",
    mutate: async (out) => {
      const full = await readJsonFile<{
        transactions: { record_sha256: string }[];
      }>(join(out, "receiver", "applied.json"));
      await editJson<{ transactions: { record_sha256: string }[] }>(
        join(out, "receiver-patch", "applied.json"),
        (a) => {
          a.transactions = full.transactions;
        },
      );
    },
    checks: { "leg-class-receiver-patch": false },
    classes: { "receiver-patch": "replay-failure" },
  },
  {
    name: "a successful openat under fixtures/ fails receiver-never-loaded-fixture",
    mutate: async (out, projects) => {
      const path = join(out, "receiver-headless-trace", "strace.txt");
      const text = await readFile(path, "utf8");
      await writeText(
        path,
        `${text}42 10:00:00.300000 openat(AT_FDCWD, "${projects.fixtureProjectDir}/gate1.tscn", O_RDONLY|O_CLOEXEC) = 5\n`,
      );
    },
    checks: { "receiver-never-loaded-fixture": false },
  },
  {
    name: "a [fixture] line in a g1b receiver log fails receiver-never-loaded-fixture",
    mutate: (out) =>
      writeText(
        join(out, "receiver-patch", "stdout.log"),
        "[fixture] gate1 ready\n",
      ),
    checks: { "receiver-never-loaded-fixture": false },
  },
  {
    name: "a SCRIPT WARNING in the receiver self-test fails receiver-typed-clean",
    mutate: (out) =>
      writeText(
        join(out, "receiver-typecheck", "selftest", "stdout.log"),
        "[rs1-selftest] ok\nSCRIPT WARNING: unsafe\n",
      ),
    checks: { "receiver-typed-clean": false },
  },
  {
    name: "a golden replay that misses an unsupported entry fails receiver-typed-clean",
    mutate: (out) =>
      editJson<{ unsupported: unknown[] }>(
        join(out, "receiver-typecheck", "minimal", "applied.json"),
        (a) => {
          a.unsupported = a.unsupported.slice(1);
        },
      ),
    checks: { "receiver-typed-clean": false },
  },
  {
    name: "a sabotage receiver also wrong at step 4 fails leg-class-sabotage-omit-order",
    mutate: (out) =>
      writePng(
        join(
          out,
          "sabotage-omit-order",
          "receiver",
          "shots",
          `seq-${settleSeqs()[4]}.png`,
        ),
        4,
        { perturb: [300, 100] },
      ),
    checks: { "leg-class-sabotage-omit-order": false },
    classes: { "sabotage-omit-order": "pixel-mismatch" },
  },
  {
    name: "a sabotage receiver that matches at its first sabotaged step fails leg-class-sabotage-omit-visibility",
    mutate: (out) =>
      writePng(
        join(
          out,
          "sabotage-omit-visibility",
          "receiver",
          "shots",
          `seq-${settleSeqs()[7]}.png`,
        ),
        7,
      ),
    checks: { "leg-class-sabotage-omit-visibility": false },
  },
  {
    name: "an omit-free receiver that matches at step 9 fails leg-class-sabotage-omit-free",
    mutate: (out) =>
      writePng(
        join(
          out,
          "sabotage-omit-free",
          "receiver",
          "shots",
          `seq-${settleSeqs()[9]}.png`,
        ),
        9,
      ),
    checks: { "leg-class-sabotage-omit-free": false },
    classes: { "sabotage-omit-free": "pixel-mismatch" },
  },
  {
    name: "an omit-visible receiver also wrong at step 7 fails leg-class-sabotage-omit-visible",
    mutate: (out) =>
      writePng(
        join(
          out,
          "sabotage-omit-visible",
          "receiver",
          "shots",
          `seq-${settleSeqs()[7]}.png`,
        ),
        7,
        { perturb: [100, 230] },
      ),
    checks: { "leg-class-sabotage-omit-visible": false },
  },
  {
    name: "a root-size-observe receiver wrong outside the corner regions fails its leg class",
    mutate: (out) =>
      writePng(
        join(
          out,
          "root-size-observe",
          "receiver",
          "shots",
          `seq-${settleSeqs()[2]}.png`,
        ),
        2,
        {
          degenerateCorner: true,
          perturb: [10, 300],
        },
      ),
    checks: { "leg-class-root-size-observe": false },
    classes: { "root-size-observe": "unsupported" },
  },
  {
    name: "a root-size-observe host whose session declares match (pixels still degenerate) classifies pixel-mismatch",
    mutate: async (out, projects) => {
      const bytes = encodeRecording({ quit: SHORT_QUIT });
      await writeFile(
        join(out, "root-size-observe", "capture", "recording.rs1"),
        bytes,
      );
      await writeFile(
        join(out, "root-size-observe", "capture", "recording-patch.rs1"),
        encodePatchRecording({ quit: SHORT_QUIT }),
      );
      await writeReceiverProcess(
        join(out, "root-size-observe", "receiver"),
        projects,
        bytes,
        settleSeqs(),
        true,
      );
    },
    checks: { "leg-class-root-size-observe": false },
    classes: { "root-size-observe": "pixel-mismatch" },
  },
  {
    name: "a main capture whose patch sink diverges fails patch-resolves-to-full and classifies capture-failure (patch-divergence)",
    mutate: async (out) => {
      await writeFile(
        join(out, "capture", "recording-patch.rs1"),
        encodePatchRecording({ quit: CAPTURE_QUIT, dropMarkerAt: 41 }),
      );
    },
    checks: {
      "patch-resolves-to-full": false,
      "leg-class-capture": false,
      "leg-class-receiver-patch": false,
    },
    classes: {
      capture: "capture-failure",
      "receiver-patch": "capture-failure",
    },
    report: (r) =>
      assert(
        "report: the capture leg's reasons name patch-divergence",
        r.legs.capture.reasons.some((x) => x.includes("patch-divergence")),
      ),
  },
  {
    name: "a patch sink with a full transaction mid-stream fails patch-first-full (it still resolves to the full sink)",
    mutate: async (out) => {
      await writeFile(
        join(out, "capture", "recording-patch.rs1"),
        encodePatchRecording({ quit: CAPTURE_QUIT, patchFullAt: [50] }),
      );
    },
    checks: { "patch-first-full": false, "patch-resolves-to-full": true },
  },
  {
    name: "a receiver-patch shot that differs at step 4 fails patch-vs-full-pixels and its leg class",
    mutate: (out) =>
      writePng(
        join(out, "receiver-patch", "shots", `seq-${settleSeqs()[4]}.png`),
        4,
        { perturb: [300, 100] },
      ),
    checks: {
      "patch-vs-full-pixels": false,
      "leg-class-receiver-patch": false,
      "receiver-vs-reference": true,
    },
    classes: { "receiver-patch": "pixel-mismatch" },
  },
  {
    name: "a receiver-patch state dump that differs fails patch-vs-full-receiver-state",
    mutate: (out) =>
      editJson<{ items: { draw_index: number }[] }>(
        join(out, "receiver-patch", "state", `seq-${settleSeqs()[3]}.json`),
        (s) => {
          s.items[0].draw_index += 1;
        },
      ),
    checks: { "patch-vs-full-receiver-state": false },
  },
  {
    name: "a missing receiver state dump fails patch-vs-full-receiver-state",
    mutate: (out) =>
      rm(join(out, "receiver", "state", `seq-${settleSeqs()[0]}.json`)),
    checks: { "patch-vs-full-receiver-state": false },
  },
  {
    name: "receivers that made different RS calls for one seq fail patch-vs-full-receiver-state",
    mutate: (out) =>
      editJson<{ transactions: { rs_calls: number }[] }>(
        join(out, "receiver-patch", "applied.json"),
        (a) => {
          a.transactions[30].rs_calls += 1;
        },
      ),
    checks: { "patch-vs-full-receiver-state": false },
  },
  {
    name: "a reference tie-frame shot that differs from the receivers' fails tie-frame-pixels",
    mutate: (out) =>
      writePng(join(out, "reference", "shots", `frame-${TIE_FRAME}.png`), 1, {
        perturb: [90, 310],
      }),
    checks: { "tie-frame-pixels": false },
  },
  {
    name: "a missing receiver tie-frame shot fails tie-frame-pixels",
    mutate: (out) =>
      rm(join(out, "receiver-patch", "shots", `seq-${TIE_FRAME}.png`)),
    checks: { "tie-frame-pixels": false },
  },
  {
    name: "a tie-overlap capture whose T does not overlap classifies success and fails its leg class",
    mutate: async (out, projects) => {
      const full = encodeRecording({ quit: SHORT_QUIT });
      await writeFile(
        join(out, "tie-overlap", "capture", "recording.rs1"),
        full,
      );
      await writeFile(
        join(out, "tie-overlap", "capture", "recording-patch.rs1"),
        encodePatchRecording({ quit: SHORT_QUIT }),
      );
      await writeReceiverProcess(
        join(out, "tie-overlap", "receiver"),
        projects,
        full,
        [...settleSeqs(), TIE_FRAME],
        true,
      );
    },
    checks: { "leg-class-tie-overlap": false },
    classes: { "tie-overlap": "success" },
  },
  {
    name: "a sabotage-patch-drop whose patch sink is faithful is not capture-failure and fails its leg class",
    mutate: async (out) => {
      await writeFile(
        join(out, "sabotage-patch-drop", "capture", "recording-patch.rs1"),
        encodePatchRecording({ quit: SHORT_QUIT }),
      );
    },
    checks: { "leg-class-sabotage-patch-drop": false },
  },
  {
    name: "a run with g1b but without g1a fails the gate",
    mutate: (out) =>
      writeJson(join(out, "legs.json"), {
        groups_run: ["g1b"],
        groups_landed: ["g1a", "g1b", "g1c"],
      }),
    gatePassed: false,
    report: (r) =>
      assert(
        "report: g1a and g1c not_run and a failed g1b group check",
        r.groups.not_run.join() === "g1a,g1c" &&
          r.checks.some((c) => c.id === "group-g1b" && c.status === "fail"),
      ),
  },
  {
    name: "a run without g1a or g1b reports not-run and fails the gate",
    mutate: (out) =>
      writeJson(join(out, "legs.json"), {
        groups_run: [],
        groups_landed: ["g1a", "g1b", "g1c"],
      }),
    gatePassed: false,
    report: (r) =>
      assert(
        "report: g1a, g1b and g1c not_run, checks not-run",
        r.groups.not_run.join() === "g1a,g1b,g1c" &&
          r.checks.filter((c) => c.status === "not-run").length === 3,
      ),
  },
];

scenarios.push(...liveScenarios);

async function runScenarios(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gate1-self-test-"));
  try {
    const templateProjects = await writeProjects(join(root, "template"));
    await buildGoodTree(join(root, "template", "out"), templateProjects);
    for (const name of ["recording.rs1", "recording-patch.rs1"]) {
      const errors = validateRecording(
        new Uint8Array(
          await readFile(join(root, "template", "out", "capture", name)),
        ),
      );
      assert(
        `the fabricated capture ${name} validates`,
        errors.length === 0,
        errors.join("; "),
      );
    }
    for (const [index, scenario] of scenarios.entries()) {
      const caseRoot = join(root, `case-${index}`);
      await cp(join(root, "template"), caseRoot, { recursive: true });
      const projects = projectsUnder(caseRoot);
      const out = join(caseRoot, "out");
      await writeTraceStrace(out, projects);
      await writeLiveTrace(join(out, "live-headless"), projects);
      if (scenario.mutate) await scenario.mutate(out, projects);
      const ctx: Gate1Context = {
        expected: scenario.expected ? scenario.expected(EXPECTED) : EXPECTED,
        ...projects,
        now: new Date(0),
      };
      const report = await runGate1(out, ctx);
      const byId = new Map(report.checks.map((c) => [c.id, c]));
      for (const [id, want] of Object.entries(scenario.checks ?? {})) {
        const got = byId.get(id);
        assert(
          `${scenario.name}: ${id} ${want ? "passes" : "fails"}`,
          got?.passed === want,
          got ? got.detail : "check not produced",
        );
      }
      for (const [leg, want] of Object.entries(scenario.classes ?? {})) {
        const got = report.legs[leg]?.result_class;
        assert(
          `${scenario.name}: ${leg} is ${want}`,
          got === want,
          `got ${got} (${report.legs[leg]?.reasons.slice(0, 3).join(" | ")})`,
        );
      }
      if (scenario.gatePassed !== undefined) {
        assert(
          `${scenario.name}: gate_passed ${scenario.gatePassed}`,
          report.gate_passed === scenario.gatePassed,
        );
      }
      if (scenario.checks && Object.values(scenario.checks).some((v) => !v)) {
        assert(
          `${scenario.name}: gate_passed false`,
          report.gate_passed === false,
        );
      }
      scenario.report?.(report);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Pure unit cases
// ---------------------------------------------------------------------------------------------

function classifyUnitCases(): void {
  const okResult = { status: "armed", stream: { status: "closed" } };
  const rec = { present: true, errors: [] as string[], transactions: [] };
  const base = classifyLeg({
    captureResult: okResult,
    recording: rec,
    checkpoints: [],
  });
  const session = (status: string) =>
    ({
      type: "session",
      viewport: {
        host_size_status: status,
        logical_size: [640, 360],
        host_window_size: status === "match" ? [640, 360] : [64, 64],
      },
    }) as unknown as Parameters<typeof classifyGate1>[1];
  const matching = session("match");
  const degenerate = session("degenerate-visible");
  assert(
    "classifyGate1: a matching host with an equivalent patch sink is success",
    classifyGate1(base, matching, []).result_class === "success",
  );
  assert(
    "classifyGate1: no session is capture-failure",
    classifyGate1(base, undefined, []).result_class === "capture-failure",
  );
  const div = classifyGate1(base, matching, ["frame 51: differs"]);
  assert(
    "classifyGate1: patch divergence is capture-failure (patch-divergence)",
    div.result_class === "capture-failure" &&
      div.reasons[0].includes("patch-divergence"),
  );
  const u = classifyGate1(base, degenerate, []);
  assert(
    "classifyGate1: a degenerate session is unsupported (degenerate-host-size)",
    u.result_class === "unsupported" &&
      u.reasons[0].includes("degenerate-host-size"),
  );
  const pm = classifyLeg({
    captureResult: okResult,
    recording: rec,
    receiver: {
      applied: {
        status: "ok",
        end_seen: true,
        transactions: [],
        shots: [],
        unsupported: [],
      },
      requestedShotSeqs: [],
      shotFiles: [],
    },
    checkpoints: [
      {
        step: 0,
        settle_frame: 8,
        seq: 8,
        reference_png: "r",
        receiver_png: "g",
        diff_png: null,
        mismatched_pixels: 3,
        max_channel_delta: 9,
        regions: [],
      },
    ],
  });
  const both = classifyGate1(pm, degenerate, []);
  assert(
    "classifyGate1: unsupported outranks pixel-mismatch and both reasons are kept",
    both.result_class === "unsupported" &&
      both.reasons.some((r) => r.startsWith("pixel-mismatch:")) &&
      both.mismatching_steps.join() === "0",
  );
  assert(
    "classifyGate1: pixel-mismatch alone on a matching host",
    classifyGate1(pm, matching, []).result_class === "pixel-mismatch",
  );
  assert(
    "classifyGate1: a divergent patch sink outranks degenerate-host-size",
    classifyGate1(base, degenerate, ["x"]).result_class === "capture-failure",
  );
  const capFail = classifyLeg({
    captureResult: { status: "refused" },
    recording: rec,
    checkpoints: [],
  });
  assert(
    "classifyGate1: gate 0's capture-failure outranks degenerate-host-size",
    classifyGate1(capFail, degenerate, []).result_class === "capture-failure",
  );
}

function helperCases(): void {
  const s0 = synthesizeGate1(EXPECTED, 0);
  const px = (x: number, y: number) =>
    Array.from(s0.rgba.slice((y * 640 + x) * 4, (y * 640 + x) * 4 + 4)).join(
      ",",
    );
  assert(
    "synthesizeGate1: clear colour outside the draws",
    px(5, 5) === "51,51,102,255",
  );
  assert(
    "synthesizeGate1: Q2 painted over Q1 at step 0",
    px(330, 120) === "0,153,255,255",
  );
  const s3 = synthesizeGate1(EXPECTED, 3);
  assert(
    "synthesizeGate1: Q1 painted over Q2 at step 3",
    Array.from(
      s3.rgba.slice((120 * 640 + 330) * 4, (120 * 640 + 330) * 4 + 4),
    ).join(",") === "255,102,0,255",
  );
  assert(
    "synthesizeGate1: T painted from step 1",
    Array.from(
      s3.rgba.slice((320 * 640 + 90) * 4, (320 * 640 + 90) * 4 + 4),
    ).join(",") === "153,255,102,255",
  );
  const s10 = synthesizeGate1(EXPECTED, 10);
  assert(
    "synthesizeGate1: step 10's Corner clipped at the viewport edge",
    Array.from(
      s10.rgba.slice((359 * 640 + 639) * 4, (359 * 640 + 639) * 4 + 4),
    ).join(",") === "204,204,51,255",
  );

  const model = summarizeRecording(
    "model",
    new Uint8Array(encodeRecording({ quit: SHORT_QUIT })),
  );
  const states = statesOf(model);
  const names = mapNames(EXPECTED, states);
  assert(
    "mapNames: 21 ids in creation order (T = 20, L2 = 21), colours cross-checked",
    names.problems.length === 0 &&
      names.byName.get("T") === 20 &&
      names.byName.get("L2") === 21 &&
      names.byName.get("Corner") === 16,
    names.problems.join("; "),
  );
  const inv = evaluateInvariants(EXPECTED, states, names);
  assert(
    "evaluateInvariants: the model satisfies every invariant",
    inv.problems.length === 0 && inv.evaluated > 40,
    inv.problems.join("; "),
  );
  const ties = recordingTies(model);
  assert(
    "recordingTies: the model's only tie is T with P at frame 11, harmless",
    ties.length === 1 &&
      ties[0].frame === TIE_FRAME &&
      ties[0].members.join() === "1,20" &&
      ties[0].harmless,
    JSON.stringify(ties),
  );
  const overlap = recordingTies(
    summarizeRecording(
      "overlap",
      new Uint8Array(encodeRecording({ quit: SHORT_QUIT, tieOverlap: true })),
    ),
  );
  assert(
    "recordingTies: with T over P the same tie is not harmless",
    overlap.length === 1 && overlap[0].harmless === false,
    JSON.stringify(overlap),
  );
  const tied = recordingTies(
    summarizeRecording(
      "tied",
      new Uint8Array(encodeRecording({ quit: SHORT_QUIT, tie: true })),
    ),
  );
  assert(
    "recordingTies: a step 3 tie under Q (item 4) is found, overlapping",
    tied.some((t) => t.container === "item:4" && !t.harmless),
  );
  const patch = summarizeRecording(
    "patch",
    new Uint8Array(encodePatchRecording({ quit: SHORT_QUIT })),
  );
  assert(
    "the model's patch recording validates and resolves to the full one",
    patch.errors.length === 0 &&
      patch.transactions.every(
        (t, i) =>
          JSON.stringify(t.meta.items) ===
          JSON.stringify(model.transactions[i].meta.items),
      ),
    patch.errors.join("; "),
  );
}

async function main(): Promise<void> {
  EXPECTED = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate1", "expected.json"),
      "utf8",
    ),
  ) as Gate1Expected;
  classifyUnitCases();
  helperCases();
  await runScenarios();
  console.log(
    `\nself-test-gate1: ${assertions - failures}/${assertions} assertions correct (${scenarios.length} evidence scenarios)`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
