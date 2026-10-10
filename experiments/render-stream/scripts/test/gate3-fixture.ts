// A fabricated gate 3 (g3a) evidence tree for scripts/test/self-test-gate3.ts: an independent TS
// model of fixtures/gate3/gate3.gd's RenderingServer calls (gate3-design.md Q6b, Q1a) turned into
// render-stream/2 states, both capture sinks, the capture's evidence and counters, and rendered
// shots synthesized from fixtures/gate3/expected.json. It shares nothing with make_expected.py
// but the scene's numbers, so the passing tree's clip-state-invariants, clip-rects-derived and
// clip-call-census are a cross-check of the two models as well as of the checker.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import {
  expectedReceiverUnsupported,
  GATE0_HOOKS,
  summarizeRecording,
} from "../lib/gate0-checks";
import { resolvedStateOf } from "../lib/gate1-checks";
import {
  type Gate3Expected,
  stepFrames3,
  synthesizeGate3,
  withExtraDraws,
} from "../lib/gate3-expected";
import {
  encodeRs2Recording,
  type RecordingEncodeOptions,
  type TCommand,
  type TItem,
  type TState,
} from "./rs2-test-encoder";

export const CAPTURE_QUIT = 400;

// ---------------------------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------------------------

type Rgba = [number, number, number, number];
const c = (r: number, g: number, b: number): Rgba => [r, g, b, 1];

interface Node {
  parent: string | null;
  index: number;
  pos: [number, number];
  size: [number, number];
  clip: boolean;
  color: Rgba | null;
  z: number;
  /** CU's own draw */
  draw?: { rect: number[]; color: Rgba };
}

export const NAMES = [
  "A",
  "AF",
  "S1",
  "B",
  "BF",
  "N",
  "NF",
  "C",
  "CF",
  "BZ",
  "D",
  "DF",
  "CU",
  "AN",
  "ANF",
  "Marker",
  "RC",
  "RCF",
] as const;
export type Name = (typeof NAMES)[number];
export const ID = Object.fromEntries(NAMES.map((n, i) => [n, i + 1])) as Record<
  Name,
  number
>;
const CONTROLS: Name[] = [
  "A",
  "AF",
  "S1",
  "B",
  "BF",
  "N",
  "NF",
  "C",
  "CF",
  "BZ",
  "D",
  "DF",
  "CU",
  "AN",
  "ANF",
];

const MARKERS: Rgba[] = [
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
];

function scene(step: number): Record<string, Node> {
  const n = (
    parent: string | null,
    index: number,
    pos: [number, number],
    size: [number, number],
    o: Partial<Node> = {},
  ): Node => ({
    parent,
    index,
    pos,
    size,
    clip: false,
    color: null,
    z: 0,
    ...o,
  });
  const nodes: Record<string, Node> = {
    A: n(null, 0, [96, 88], [160, 120], { clip: step !== 4 }),
    AF: n("A", 0, [-16, -16], [192, 152], { color: c(1, 0.6, 0) }),
    S1: n("A", 1, step >= 1 ? [148, 8] : [20, 8], [24, 24], {
      color: c(1, 1, 1),
    }),
    B: n(
      "A",
      2,
      step >= 2 ? [80, 50] : [100, 60],
      step >= 3 ? [60, 50] : [100, 80],
      {
        clip: true,
      },
    ),
    BF: n("B", 0, step >= 2 ? [0, -10] : [-20, -20], [140, 120], {
      color: c(0, 0.6, 1),
    }),
    N: n("B", 1, [-60, 30], [10, 10]),
    NF: n("N", 0, [0, 0], [200, 16], { color: c(0.6, 1, 0.2) }),
    C: n("B", 2, [40, 40], [40, 40], { clip: true }),
    CF: n("C", 0, [-8, -8], [56, 56], { color: c(1, 0.2, 0.6) }),
    BZ: n("B", 3, [40, -10], [40, 30], { color: c(0.2, 1, 0.8), z: 1 }),
    D: n(null, 1, [344, 88], [64, 48], {
      clip: true,
      color: step >= 5 ? c(0.6, 0.2, 0.2) : c(0.2, 0.6, 0.2),
    }),
    DF: n("D", 0, [32, -12], [48, 72], { color: c(0.8, 0.8, 0.2) }),
    CU: n(null, 2, step >= 2 ? [-40, 264] : [-48, 264], [40, 40], {
      draw: { rect: [56, 0, 32, 32], color: c(0.6, 0.4, 1) },
    }),
    // anchors (0, 1, 1, 1), offsets (88, -40, -24, -16) on a 640x360 root
    AN: n(null, 3, [88, 320], [528, 24], { clip: true }),
    ANF: n("AN", 0, [-8, -4], [544, 32], { color: c(0.8, 0.4, 0.6) }),
  };
  return nodes;
}

type Call =
  | { op: "clear"; item: Name }
  | { op: "custom_rect"; item: Name; enabled: boolean; rect: number[] }
  | { op: "clip"; item: Name; value: boolean }
  | { op: "rect"; item: Name; rect: number[]; color: Rgba };

const REDRAWS: Record<number, Name[]> = {
  0: CONTROLS,
  3: ["B"],
  4: ["A"],
  5: ["A", "D"],
};

/** The clip-relevant RS calls of one step, in order (Q1a for Controls, the scripted raw calls). */
export function callsAt(step: number): Call[] {
  const nodes = scene(step);
  const out: Call[] = [];
  for (const name of REDRAWS[step] ?? []) {
    const nd = nodes[name];
    out.push(
      { op: "clear", item: name },
      {
        op: "custom_rect",
        item: name,
        enabled: true,
        rect: [0, 0, ...nd.size],
      },
      { op: "clip", item: name, value: nd.clip },
    );
    if (nd.color)
      out.push({
        op: "rect",
        item: name,
        rect: [0, 0, ...nd.size],
        color: nd.color,
      });
    if (nd.draw)
      out.push({
        op: "rect",
        item: name,
        rect: nd.draw.rect,
        color: nd.draw.color,
      });
  }
  const rcRect = { rect: [8, 8, 16, 16], color: c(1, 1, 0.2) };
  if (step === 0)
    out.push(
      { op: "custom_rect", item: "RC", enabled: true, rect: [0, 0, 64, 48] },
      { op: "clip", item: "RC", value: true },
      {
        op: "rect",
        item: "RCF",
        rect: [-16, -8, 96, 64],
        color: c(0.4, 0.2, 0.8),
      },
    );
  if (step === 6)
    out.push(
      { op: "clear", item: "RC" },
      { op: "rect", item: "RC", ...rcRect },
    );
  if (step === 7)
    out.push(
      { op: "clear", item: "RC" },
      { op: "rect", item: "RC", ...rcRect },
      { op: "custom_rect", item: "RC", enabled: false, rect: [0, 0, 0, 0] },
      { op: "clip", item: "RC", value: true },
    );
  if (step === 8)
    out.push(
      { op: "clear", item: "RC" },
      { op: "clip", item: "RC", value: true },
    );
  out.push(
    { op: "clear", item: "Marker" },
    { op: "rect", item: "Marker", rect: [0, 0, 32, 32], color: MARKERS[step] },
  );
  return out;
}

interface ItemState {
  clip: boolean;
  custom: boolean;
  customRect: number[];
  commands: TCommand[];
  cv: number;
}

export interface ModelOptions {
  /** the pre-gate-3 mirror: canvas_item_clear keeps the clip flag */
  clearKeepsClip?: boolean;
}

/** Item states after each step's calls, by step. */
export function itemStates(o: ModelOptions = {}): Record<Name, ItemState>[] {
  const st = Object.fromEntries(
    NAMES.map((n) => [
      n,
      {
        clip: false,
        custom: false,
        customRect: [0, 0, 0, 0],
        commands: [],
        cv: 0,
      },
    ]),
  ) as unknown as Record<Name, ItemState>;
  const out: Record<Name, ItemState>[] = [];
  for (let step = 0; step <= 9; step++) {
    for (const call of callsAt(step)) {
      const it = st[call.item];
      if (call.op === "clear") {
        it.commands = [];
        if (!o.clearKeepsClip) it.clip = false;
        it.cv++;
      } else if (call.op === "clip") it.clip = call.value;
      else if (call.op === "custom_rect") {
        it.custom = call.enabled;
        it.customRect = [...call.rect];
      } else {
        it.commands = [
          ...it.commands,
          {
            op: "add_rect",
            rect: [...call.rect],
            color: [...call.color],
            aa: false,
          },
        ];
        it.cv++;
      }
    }
    out.push(JSON.parse(JSON.stringify(st)));
  }
  return out;
}

/** The step whose window holds `frame` (step 0 from frame 1). */
export function stepAtFrame(e: Gate3Expected, frame: number): number {
  let step = 0;
  for (const s of e.steps)
    if (stepFrames3(e, s.step).applied <= frame) step = s.step;
  return step;
}

/** One render-stream/2 state per frame 1..quit. */
export function buildStates(
  e: Gate3Expected,
  quit = CAPTURE_QUIT,
  o: ModelOptions = {},
): TState[] {
  const perStep = itemStates(o);
  const states: TState[] = [];
  for (let frame = 1; frame <= quit; frame++) {
    const step = stepAtFrame(e, frame);
    const nodes = scene(step);
    const its = perStep[step];
    const items: TItem[] = NAMES.map((name) => {
      const it = its[name];
      const nd = nodes[name];
      const base = {
        id: ID[name],
        visible: true,
        z_index: 0,
        visibility_layer: 1,
        content_version: it.cv,
        modulate: [1, 1, 1, 1],
        self_modulate: [1, 1, 1, 1],
        commands: it.commands,
        clip: it.clip,
        custom_rect: it.custom,
        custom_rect_rect: it.customRect,
      };
      if (name === "Marker")
        return {
          ...base,
          parent: { kind: "canvas", id: 1 },
          children: [],
          draw_index: 4,
          xform: [1, 0, 0, 1, 592, 16],
        };
      if (name === "RC")
        return {
          ...base,
          parent: { kind: "canvas", id: 1 },
          children: [ID.RCF],
          draw_index: 1000,
          xform: [1, 0, 0, 1, 464, 88],
        };
      if (name === "RCF")
        return {
          ...base,
          parent: { kind: "item", id: ID.RC },
          children: [],
          draw_index: 0,
          xform: [1, 0, 0, 1, 0, 0],
        };
      const children = NAMES.filter((k) => nodes[k]?.parent === name).map(
        (k) => ID[k],
      );
      return {
        ...base,
        parent: nd.parent
          ? { kind: "item", id: ID[nd.parent as Name] }
          : { kind: "canvas", id: 1 },
        children,
        draw_index: nd.index,
        z_index: nd.z,
        xform: [1, 0, 0, 1, ...nd.pos],
      };
    });
    const shift = step >= 9 ? [8, 4] : [0, 0];
    states.push({
      frame,
      canvases: [
        {
          id: 1,
          origin: "root-query",
          role: "root",
          items: [ID.A, ID.D, ID.CU, ID.AN, ID.Marker, ID.RC],
          xform: [1, 0, 0, 1, ...shift],
        },
      ],
      items,
    });
  }
  return states;
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export const jsonl = (rows: readonly object[]): string =>
  `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeProcess(dir: string, exit = 0): Promise<void> {
  await writeText(join(dir, "argv.txt"), "/tpl/linux_release.x86_64\n");
  await writeText(join(dir, "env.txt"), "GRC_MODE=arm\n");
  await writeText(join(dir, "stdout.log"), "[fixture] gate3 ready\n");
  await writeText(join(dir, "exit-code.txt"), `${exit}\n`);
}

/** G3b: a receiver's own process files -- distinct from writeProcess's fixture-side "[fixture]"
 * stdout line, which receiver-never-loaded-fixture would otherwise flag on a receiver leg. */
async function writeReceiverProcess(dir: string, exit = 0): Promise<void> {
  await writeText(join(dir, "argv.txt"), "/tpl/linux_release.x86_64\n");
  await writeText(
    join(dir, "env.txt"),
    `RS_RECEIVER_RECORDING=${join(dir, "recording.rs2")}\n`,
  );
  await writeText(join(dir, "stdout.log"), "[receiver] ok\n");
  await writeText(join(dir, "exit-code.txt"), `${exit}\n`);
}

export function stepLog(e: Gate3Expected): string {
  return jsonl(
    e.steps.map((s) => {
      const f = stepFrames3(e, s.step);
      return { step: s.step, applied_frame: f.applied, settle_frame: f.settle };
    }),
  );
}

/** counters.json's clip / custom-rect / clear tables from the call model (one entry per distinct
 * (item, value), as hooks.cpp keeps them). */
export function counters(o: { quit?: number; extraClipTrue?: number } = {}) {
  const clip = new Map<
    string,
    { item: string; clip: boolean; calls: number }
  >();
  const custom = new Map<
    string,
    { item: string; custom_rect: boolean; rect: number[]; calls: number }
  >();
  let clears = 0;
  for (let step = 0; step <= 9; step++)
    for (const call of callsAt(step)) {
      const item = String(4096 + ID[call.item]);
      if (call.op === "clip") {
        const k = `${item}/${call.value}`;
        const e = clip.get(k) ?? { item, clip: call.value, calls: 0 };
        e.calls++;
        clip.set(k, e);
      } else if (call.op === "custom_rect") {
        const k = `${item}/${call.enabled}/${call.rect.join(",")}`;
        const e = custom.get(k) ?? {
          item,
          custom_rect: call.enabled,
          rect: call.rect,
          calls: 0,
        };
        e.calls++;
        custom.set(k, e);
      } else if (call.op === "clear") clears++;
    }
  const clipEntries = [...clip.values()];
  if (o.extraClipTrue) clipEntries[0].calls += o.extraClipTrue;
  const clipTotal = clipEntries.reduce((n, e) => n + e.calls, 0);
  const customEntries = [...custom.values()];
  return {
    schema: "render-stream-gate-minus1-counters/1",
    frames_total: o.quit ?? CAPTURE_QUIT,
    hooks_planned: [...GATE0_HOOKS],
    hooks_omitted: [] as string[],
    counts: {
      canvas_item_clear: clears,
      canvas_item_set_clip: clipTotal,
      canvas_item_set_custom_rect: customEntries.reduce(
        (n, e) => n + e.calls,
        0,
      ),
    },
    captured: {
      canvas_item_set_clip: clipEntries,
      canvas_item_set_custom_rect: customEntries,
    },
    captured_dropped: {
      canvas_item_clear: 0,
      canvas_item_set_clip: 0,
      canvas_item_set_custom_rect: 0,
    },
  };
}

const PNGS = new Map<string, Promise<Buffer>>();

/** A rendered shot of step `step`: synthesizeGate3, optionally with one pixel recoloured. */
export function shotPng(
  e: Gate3Expected,
  step: number,
  perturb?: { x: number; y: number; rgba?: number[] },
): Promise<Buffer> {
  const key = JSON.stringify([step, perturb]);
  let png = PNGS.get(key);
  if (!png) {
    const { width, height, rgba } = synthesizeGate3(e, step);
    const buf = Buffer.from(rgba);
    if (perturb) {
      const i = (perturb.y * width + perturb.x) * 4;
      if (perturb.rgba) buf.set(perturb.rgba, i);
      else buf[i] ^= 0x10;
    }
    png = sharp(buf, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    PNGS.set(key, png);
  }
  return png;
}

export async function writeShots(dir: string, e: Gate3Expected): Promise<void> {
  for (const s of e.steps) {
    const path = join(dir, "shots", `step-${s.step}.png`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await shotPng(e, s.step));
  }
}

export interface CaptureOptions extends ModelOptions {
  quit?: number;
  full?: Partial<RecordingEncodeOptions>;
  patch?: Partial<RecordingEncodeOptions>;
  /** edits the frame states both sinks encode */
  states?: (states: TState[]) => TState[];
}

export async function writeCaptureDir(
  dir: string,
  e: Gate3Expected,
  o: CaptureOptions = {},
): Promise<void> {
  const quit = o.quit ?? CAPTURE_QUIT;
  let states = buildStates(e, quit, o);
  if (o.states) states = o.states(states);
  const hooksPlanned = [...GATE0_HOOKS];
  const full = encodeRs2Recording(states, {
    encoding: "full",
    hooksPlanned,
    ...o.full,
  });
  const patch = encodeRs2Recording(states, {
    encoding: "patch",
    hooksPlanned,
    ...o.patch,
  });
  await writeProcess(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "recording.rs2"), full);
  await writeFile(join(dir, "recording-patch.rs2"), patch);
  await writeJson(join(dir, "evidence", "result.json"), {
    schema: "render-stream-capture-result/1",
    status: "armed",
    reason: null,
    vptr_written: true,
    disarmed: true,
    display_server: "headless",
    stream: {
      path: join(dir, "recording.rs2"),
      patch_path: join(dir, "recording-patch.rs2"),
      status: "closed",
      reason: null,
      transactions: quit,
    },
  });
  await writeJson(join(dir, "evidence", "counters.json"), counters({ quit }));
  await writeJson(join(dir, "evidence", "root.json"), {
    schema: "render-stream-root-geometry/1",
  });
  await writeText(join(dir, "evidence", "armed.marker"), "");
  await writeText(join(dir, "steps.jsonl"), stepLog(e));
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

export async function writeReference(
  dir: string,
  e: Gate3Expected,
  armed = false,
): Promise<void> {
  await writeProcess(dir);
  await writeShots(dir, e);
  await writeText(join(dir, "steps.jsonl"), stepLog(e));
  if (armed)
    await writeJson(join(dir, "evidence", "result.json"), {
      schema: "render-stream-capture-result/1",
      status: "armed",
      display_server: "x11",
      stream: { status: "closed", transactions: e.quit_frame_default },
    });
}

/** A passing g3a evidence tree. */
export async function buildTree(
  out: string,
  e: Gate3Expected,
  o: CaptureOptions = {},
): Promise<void> {
  await writeJson(join(out, "legs.json"), {
    groups_run: ["g3a"],
    groups_landed: ["g3a"],
  });
  await writeJson(join(out, "binary.json"), {
    path: "/tpl/linux_release.x86_64",
    sha256: "54cc",
  });
  await writeProcess(join(out, "import", "fixture"));
  await writeCaptureDir(join(out, "capture"), e, o);
  await writeReference(join(out, "reference"), e);
  await writeReference(join(out, "reference-repeat"), e);
  await writeReference(join(out, "reference-armed"), e, true);
}

// ---------------------------------------------------------------------------------------------
// g3b: a fabricated receiver on each leg's capture (gate3-design.md "G3b"). Shots are synthesized
// from the SAME expected.json the checker reads, so a passing leg is pixel-identical to
// synthesizeGate3 by construction; a sabotage leg's "wrong" pixel (or, for ignore-clip, the whole
// unclipped frame) is placed at exactly the steps/colours expected.json `predictions[leg]` says,
// so these fixtures cross-check the *checking* code, not the engine.
// ---------------------------------------------------------------------------------------------

/** applied.json /3's per-transaction resource counters for a receiver that fetches and uploads
 * nothing (nothing in the gate 3 fixture draws a texture). */
const G3B_NO_RESOURCES = {
  fetched: 0,
  fetched_bytes: 0,
  cache_hits: 0,
  inline_received: 0,
  created: 0,
  updated: 0,
  replaced: 0,
  freed: 0,
  upload_bytes: 0,
  fetch_us: 0,
  skipped_commands: 0,
};

/** A receiver's applied.json (render-stream-receiver-applied/3), derived from the recording
 * bytes it actually replayed (self-test-gate1.ts's appliedFor): every transaction 1..N, and a
 * shot (plus, when `stateSeqs` names it, a resolved-state dump) at each of `shotSeqs`. */
function g3bAppliedFor(
  recordingPath: string,
  bytes: Buffer,
  shotSeqs: number[],
  stateSeqs: number[],
  dir: string,
): Record<string, unknown> {
  const summary = summarizeRecording(recordingPath, new Uint8Array(bytes));
  return {
    schema: "render-stream-receiver-applied/3",
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
      display_server: "x11",
      size: [640, 360],
      size_check: "ok",
      logical_size: [640, 360],
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
      rs_calls: 1,
      resources: G3B_NO_RESOURCES,
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
    cache: {
      dir: join(dir, "cache"),
      mode: "fresh",
      entries_before: 0,
      entries_after: 0,
      bytes_after: 0,
    },
    fetches: [],
    uploads: [],
    resources_summary: {
      distinct_fetched: 0,
      fetched_bytes: 0,
      cache_hits: 0,
      uploads: 0,
      upload_bytes: 0,
    },
  };
}

/** How a g3b receiver leg's shots diverge from the correct `shotPng`: `normal` (every step
 * correct), `bad-pixel` (one recoloured pixel at exactly `steps`, a sabotage's predicted
 * mismatch), or `unclipped` (every step rendered with every clip off -- `sabotage-receiver-
 * ignore-clip`'s actual, faithful effect, not a stand-in). */
export type G3bShotMode =
  | { kind: "normal" }
  | { kind: "bad-pixel"; steps: readonly number[]; xy?: [number, number] }
  | { kind: "unclipped" };

async function g3bShotPng(
  e: Gate3Expected,
  step: number,
  mode: G3bShotMode,
): Promise<Buffer> {
  if (mode.kind === "unclipped") {
    const { width, height, rgba } = synthesizeGate3(e, step, {
      clips: false,
    });
    return sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
  }
  if (mode.kind === "bad-pixel" && mode.steps.includes(step)) {
    const [x, y] = mode.xy ?? [10, 10];
    return shotPng(e, step, { x, y, rgba: [0, 0, 0, 255] });
  }
  return shotPng(e, step);
}

export interface WriteReceiverLegOptions {
  mode?: G3bShotMode;
  /** also write state/seq-<n>.json resolved-state dumps (receiver-patch's clip-rects-derived
   * input). */
  withState?: boolean;
}

/** A g3b receiver leg replaying `captureDir/recordingName`: applied.json plus shots/seq-<n>.png
 * at every settled step (joined through the capture's own recording, as the real receiver's
 * shots are named). */
export async function writeReceiverLeg(
  dir: string,
  e: Gate3Expected,
  captureDir: string,
  recordingName: string,
  o: WriteReceiverLegOptions = {},
): Promise<void> {
  const mode = o.mode ?? { kind: "normal" };
  const recordingPath = join(captureDir, recordingName);
  const bytes = await readFile(recordingPath);
  const summary = summarizeRecording(recordingPath, new Uint8Array(bytes));
  const shotSeqs: number[] = [];
  for (const s of e.steps) {
    const frame = stepFrames3(e, s.step).settle;
    const tx = summary.transactions.find((t) => t.meta.frame === frame);
    const seq = tx?.meta.seq ?? frame;
    shotSeqs.push(seq);
    const path = join(dir, "shots", `seq-${seq}.png`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await g3bShotPng(e, s.step, mode));
    if (o.withState && tx) {
      await writeJson(
        join(dir, "state", `seq-${seq}.json`),
        resolvedStateOf(tx.meta),
      );
    }
  }
  await writeJson(
    join(dir, "applied.json"),
    g3bAppliedFor(
      recordingPath,
      bytes,
      shotSeqs,
      o.withState ? shotSeqs : [],
      dir,
    ),
  );
  await writeReceiverProcess(dir);
}

/** receiver-headless-trace: a successful openat of its own recording and (the positive control a
 * real strace carries) of the receiver project's own project.godot, and nothing under
 * fixtureProjectDir -- self-test-gate1.ts's writeTraceStrace. */
async function writeReceiverTrace(
  dir: string,
  receiverProjectDir: string,
): Promise<void> {
  const recordingPath = join(dir, "recording.rs2");
  await writeText(
    join(dir, "strace.txt"),
    [
      `42 10:00:00.000000 openat(AT_FDCWD, "${receiverProjectDir}/project.godot", O_RDONLY|O_CLOEXEC) = 3`,
      `42 10:00:00.200000 openat(AT_FDCWD, "${recordingPath}", O_RDONLY|O_CLOEXEC) = 4`,
      "",
    ].join("\n"),
  );
  await writeText(
    join(dir, "argv.txt"),
    `${["/tpl/linux_release.x86_64", "--headless", "--path", receiverProjectDir].join("\n")}\n`,
  );
}

export interface G3bProjects {
  receiverProjectDir: string;
  fixtureProjectDir: string;
}

/** Tiny, distinct stand-ins for the real receiver/ and fixtures/gate3/ projects
 * (receiver-never-loaded-fixture hashes every file under both and fails if any pair matches). */
export async function writeG3bProjects(root: string): Promise<G3bProjects> {
  const fixtureProjectDir = join(root, "_projects", "fixtures", "gate3");
  const receiverProjectDir = join(root, "_projects", "receiver");
  await writeText(
    join(fixtureProjectDir, "project.godot"),
    'config/name="gate3 fixture"\n',
  );
  await writeText(
    join(fixtureProjectDir, "gate3.gd"),
    "extends Node\n# fixture\n",
  );
  await writeText(
    join(receiverProjectDir, "project.godot"),
    'config/name="receiver"\n',
  );
  await writeText(
    join(receiverProjectDir, "receiver.gd"),
    "extends Node\n# receiver\n",
  );
  return { fixtureProjectDir, receiverProjectDir };
}

/** The five legs that capture their own fresh recording (gate3-design.md "G3b" leg table):
 * freeze-frame, perturb-transform and the two omit-op host sabotages reuse /1's sabotages
 * unmodified (their effect is stood in for here by a bad pixel at the predicted steps, since
 * only the *checking* code is under test); root-size-observe declares a non-"match" host size. */
const G3B_OWN_CAPTURE_LEGS = [
  "sabotage-freeze",
  "sabotage-perturb",
  "sabotage-omit-clip",
  "sabotage-omit-custom-rect",
  "root-size-observe",
] as const;

/** A full, passing g3b evidence tree on top of a g3a tree already written at `out` (buildTree):
 * receiver and receiver-patch on the g3a capture, a headless trace, the four host-sabotage legs
 * and root-size-observe each on their own fresh capture, and the two receiver sabotages on the
 * g3a capture -- every leg's predicted mismatch (expected.json `predictions[leg]`) reproduced
 * exactly, so the whole tree classifies and checks exactly as gate3-design.md Q7 says. */
export async function writeG3bTree(
  out: string,
  e: Gate3Expected,
  projects: G3bProjects,
): Promise<void> {
  const g3aCapture = join(out, "capture");

  await writeReceiverLeg(join(out, "receiver"), e, g3aCapture, "recording.rs2");
  await writeReceiverLeg(
    join(out, "receiver-patch"),
    e,
    g3aCapture,
    "recording-patch.rs2",
    { withState: true },
  );

  const traceDir = join(out, "receiver-headless-trace");
  await writeReceiverLeg(traceDir, e, g3aCapture, "recording.rs2");
  await writeReceiverTrace(traceDir, projects.receiverProjectDir);

  for (const leg of G3B_OWN_CAPTURE_LEGS) {
    const legDir = join(out, leg);
    const prediction = e.predictions[leg];
    const rootSize = leg === "root-size-observe";
    await writeCaptureDir(join(legDir, "capture"), e, {
      quit: e.quit_frame_default,
      ...(rootSize
        ? {
            full: { hostSizeStatus: "degenerate-visible" },
            patch: { hostSizeStatus: "degenerate-visible" },
          }
        : {}),
    });
    await writeReceiverLeg(
      join(legDir, "receiver"),
      e,
      join(legDir, "capture"),
      "recording.rs2",
      {
        mode: {
          kind: "bad-pixel",
          steps: prediction.steps ?? [],
          xy: rootSize ? [100, 320] : undefined,
        },
      },
    );
  }

  await writeReceiverLeg(
    join(out, "sabotage-receiver-ignore-clip"),
    e,
    g3aCapture,
    "recording.rs2",
    { mode: { kind: "unclipped" } },
  );
  await writeReceiverLeg(
    join(out, "sabotage-receiver-clip-before-clear"),
    e,
    g3aCapture,
    "recording.rs2",
    {
      mode: {
        kind: "bad-pixel",
        steps: e.predictions["sabotage-receiver-clip-before-clear"].steps ?? [],
      },
    },
  );
}

/** A passing g3a + g3b evidence tree: buildTree, then writeG3bTree, with legs.json updated to
 * both groups. */
export async function buildFullTree(
  out: string,
  e: Gate3Expected,
  o: CaptureOptions = {},
): Promise<G3bProjects> {
  await buildTree(out, e, o);
  const projects = await writeG3bProjects(out);
  await writeG3bTree(out, e, projects);
  await writeJson(join(out, "legs.json"), {
    groups_run: ["g3a", "g3b"],
    groups_landed: ["g3a", "g3b"],
  });
  return projects;
}

// ---------------------------------------------------------------------------------------------
// Group g3d: calibrator 6, canvas_item_add_clip_ignore (gate3-design.md "G3d")
// ---------------------------------------------------------------------------------------------

/** RI's wire id: the 19th item created (after RCF, id 18), as the real fixture's variant. */
export const ID_RI = ID.RCF + 1;

function riItem(): TItem {
  return {
    id: ID_RI,
    parent: { kind: "canvas", id: 1 },
    children: [],
    visible: true,
    draw_index: 1002,
    z_index: 0,
    visibility_layer: 1,
    content_version: 4,
    xform: [1, 0, 0, 1, 472, 184],
    modulate: [1, 1, 1, 1],
    self_modulate: [1, 1, 1, 1],
    clip: true,
    custom_rect: true,
    custom_rect_rect: [0, 0, 48, 32],
    // Since G5d (gate5-design.md D10, render-stream/4) both add_clip_ignore calls are real
    // commands; on /3 they were unsupported commands with an item-level unsupported-op entry.
    commands: [
      { op: "add_rect", rect: [0, 0, 48, 32], color: [0.4, 0.8, 0.4, 1] },
      { op: "add_clip_ignore", ignore: true },
      { op: "add_rect", rect: [32, 16, 32, 32], color: [1, 0.4, 0, 1] },
      { op: "add_clip_ignore", ignore: false },
    ],
  };
}

/** `buildStates` plus the variant's static raw item RI (gate3-design.md Q6b "Variant
 * clip-ignore"), present in every frame unmodified. Since G5d RI carries no unsupported entry. */
export function buildStatesWithRI(
  e: Gate3Expected,
  quit = CAPTURE_QUIT,
  o: ModelOptions = {},
): TState[] {
  const ri = riItem();
  return buildStates(e, quit, o).map((s) => ({
    ...s,
    canvases: s.canvases.map((c) =>
      c.id === 1 ? { ...c, items: [...c.items, ID_RI] } : c,
    ),
    items: [...s.items, ri],
  }));
}

export async function writeClipIgnoreCaptureDir(
  dir: string,
  e: Gate3Expected,
  o: CaptureOptions = {},
): Promise<void> {
  const quit = o.quit ?? CAPTURE_QUIT;
  let states = buildStatesWithRI(e, quit, o);
  if (o.states) states = o.states(states);
  const hooksPlanned = [...GATE0_HOOKS];
  const full = encodeRs2Recording(states, {
    encoding: "full",
    hooksPlanned,
    ...o.full,
  });
  const patch = encodeRs2Recording(states, {
    encoding: "patch",
    hooksPlanned,
    ...o.patch,
  });
  await writeProcess(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "recording.rs2"), full);
  await writeFile(join(dir, "recording-patch.rs2"), patch);
  await writeJson(join(dir, "evidence", "result.json"), {
    schema: "render-stream-capture-result/1",
    status: "armed",
    reason: null,
    vptr_written: true,
    disarmed: true,
    display_server: "headless",
    stream: {
      path: join(dir, "recording.rs2"),
      patch_path: join(dir, "recording-patch.rs2"),
      status: "closed",
      reason: null,
      transactions: quit,
    },
  });
  await writeJson(join(dir, "evidence", "counters.json"), counters({ quit }));
  await writeJson(join(dir, "evidence", "root.json"), {
    schema: "render-stream-root-geometry/1",
  });
  await writeText(join(dir, "evidence", "armed.marker"), "");
  await writeText(join(dir, "steps.jsonl"), stepLog(e));
}

export async function writeClipIgnoreReference(
  dir: string,
  e: Gate3Expected,
): Promise<void> {
  await writeProcess(dir);
  const vci = e.variant_clip_ignore;
  const withRi = withExtraDraws(e, (step) => vci?.reference_draws[step] ?? []);
  for (const s of e.steps) {
    const path = join(dir, "shots", `step-${s.step}.png`);
    await mkdir(dirname(path), { recursive: true });
    const { width, height, rgba } = synthesizeGate3(withRi, s.step);
    const png = await sharp(Buffer.from(rgba), {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toBuffer();
    await writeFile(path, png);
  }
  await writeText(join(dir, "steps.jsonl"), stepLog(e));
}

/** A receiver on capture-clip-ignore's recording: a shot per settle step, named by seq (`==
 * frame`, since `buildStates` publishes one transaction per frame), synthesized with that step's
 * RI receiver draws. Since G5d (render-stream/4, gate5-design.md D10) the receiver replays both
 * `add_clip_ignore` commands, so those draws equal the reference's (second rect unclipped) and
 * applied.json -- derived from the bytes of `recordingPath` (capture-clip-ignore's full sink), as
 * g3b's receivers are, so the classification reaches `success` -- lists nothing unsupported.
 * Gate 3b's receiver apply-order fix is what makes every step comparable: RI never redraws, so it
 * was never the blocker; the base scene's own clipping Controls were. */
export async function writeClipIgnoreReceiver(
  dir: string,
  e: Gate3Expected,
  recordingPath: string,
): Promise<void> {
  await writeProcess(dir);
  const vci = e.variant_clip_ignore;
  const withRi = withExtraDraws(e, (step) => vci?.receiver_draws[step] ?? []);
  const shotSeqs: number[] = [];
  for (const s of e.steps) {
    const seq = stepFrames3(e, s.step).settle;
    const path = join(dir, "shots", `seq-${seq}.png`);
    await mkdir(dirname(path), { recursive: true });
    const { width, height, rgba } = synthesizeGate3(withRi, s.step);
    const png = await sharp(Buffer.from(rgba), {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toBuffer();
    await writeFile(path, png);
    shotSeqs.push(seq);
  }
  const bytes = await readFile(recordingPath);
  await writeJson(
    join(dir, "applied.json"),
    g3bAppliedFor(recordingPath, bytes, shotSeqs, [], dir),
  );
}

/** A passing g3d evidence tree alongside g3a's: capture-clip-ignore, reference-clip-ignore and a
 * rendered receiver-clip-ignore on the capture's recording (gate3-design.md "G3d"). */
export async function buildG3dTree(
  out: string,
  e: Gate3Expected,
  o: CaptureOptions = {},
): Promise<void> {
  await writeClipIgnoreCaptureDir(join(out, "capture-clip-ignore"), e, o);
  await writeClipIgnoreReference(join(out, "reference-clip-ignore"), e);
  await writeClipIgnoreReceiver(
    join(out, "receiver-clip-ignore"),
    e,
    join(out, "capture-clip-ignore", "recording.rs2"),
  );
}

/** A passing g3a + g3b + g3d evidence tree: every group this experiment's branch has landed. */
export async function buildFullTreeWithG3d(
  out: string,
  e: Gate3Expected,
  o: CaptureOptions = {},
): Promise<G3bProjects> {
  const projects = await buildFullTree(out, e, o);
  await buildG3dTree(out, e, o);
  await writeJson(join(out, "legs.json"), {
    groups_run: ["g3a", "g3b", "g3d"],
    groups_landed: ["g3a", "g3b", "g3d"],
  });
  return projects;
}
