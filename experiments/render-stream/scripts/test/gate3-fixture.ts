// A fabricated gate 3 (g3a) evidence tree for scripts/test/self-test-gate3.ts: an independent TS
// model of fixtures/gate3/gate3.gd's RenderingServer calls (gate3-design.md Q6b, Q1a) turned into
// render-stream/2 states, both capture sinks, the capture's evidence and counters, and rendered
// shots synthesized from fixtures/gate3/expected.json. It shares nothing with make_expected.py
// but the scene's numbers, so the passing tree's clip-state-invariants, clip-rects-derived and
// clip-call-census are a cross-check of the two models as well as of the checker.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import { GATE0_HOOKS } from "../lib/gate0-checks";
import {
  type Gate3Expected,
  stepFrames3,
  synthesizeGate3,
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
