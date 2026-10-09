#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the gate 3 checker (lib/gate3-checks.ts, lib/gate3-expected.ts and
// lib/clip-derive.ts, group g3a). Proves that every check can fail as well as pass.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate3.ts
//
// 1. Pure cases: deriveClipRects on hand cases (nesting, a non-clipping intermediate, the
//    zero-area skip, half rounding, negative scale, rotation, the command-bounds rect, unknown
//    bounds, an invisible subtree), synthesizeGate3 and the probes against expected.json, the
//    prediction for the ignore-clip receiver, and checkExpectedSelfConsistent on the committed
//    expected.json and on broken copies of it.
// 2. Evidence-tree scenarios: a fabricated passing g3a tree (gate3-fixture.ts: an independent
//    model of the fixture's RS calls writes both sinks, the evidence and the counters; PNGs are
//    synthesized from fixtures/gate3/expected.json), then perturbations: every check and the
//    capture's class are failed by at least one of them. Each scenario runs the real runGate3 and
//    asserts that exactly the checks it targets fail and every other check still passes.
//
// Exits non-zero if any assertion fails.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type DeriveInput,
  deriveClipRects,
  itemRect,
  ownerClip,
  roundHalfAway,
} from "../lib/clip-derive";
import {
  checkExpectedSelfConsistent,
  type Gate3Report,
  runGate3,
} from "../lib/gate3-checks";
import {
  type Gate3Expected,
  pixelAt,
  probesOf,
  synthesizeGate3,
} from "../lib/gate3-expected";
import {
  buildTree,
  type CaptureOptions,
  counters,
  ID,
  itemStates,
  shotPng,
  writeCaptureDir,
  writeJson,
  writeText,
} from "./gate3-fixture";
import type { TState } from "./rs2-test-encoder";

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

let EXPECTED: Gate3Expected;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---------------------------------------------------------------------------------------------
// 1. Pure cases
// ---------------------------------------------------------------------------------------------

type HandItem = DeriveInput["items"][number];

function item(id: number, o: Partial<HandItem> = {}): HandItem {
  return {
    id,
    children: [],
    visible: true,
    visibility_layer: 1,
    clip: false,
    custom_rect: false,
    custom_rect_rect: [0, 0, 0, 0],
    xform: [1, 0, 0, 1, 0, 0],
    modulate: [1, 1, 1, 1],
    commands: [],
    ...o,
  };
}

function derive(
  items: HandItem[],
  roots: number[],
  xform = [1, 0, 0, 1, 0, 0],
) {
  return deriveClipRects(
    {
      canvases: [{ id: 1, role: "root", items: roots, xform: xform as never }],
      items,
    },
    [640, 360],
  );
}

const box = (x: number, y: number, w: number, h: number) => ({
  custom_rect: true,
  custom_rect_rect: [x, y, w, h] as [number, number, number, number],
});
const at = (
  x: number,
  y: number,
): [number, number, number, number, number, number] => [1, 0, 0, 1, x, y];
const show = (v: unknown) => JSON.stringify(v);

function deriveCases(): void {
  // Nesting with a non-clipping intermediate: P clips, M does not, K clips inside both.
  {
    const d = derive(
      [
        item(1, {
          ...box(0, 0, 100, 80),
          clip: true,
          xform: at(10, 20),
          children: [2],
        }),
        item(2, { xform: at(50, 40), children: [3] }),
        item(3, { ...box(0, 0, 100, 100), clip: true, xform: at(-10, 0) }),
      ],
      [1],
    );
    assert(
      "derive: a clipping parent's scissor is its global custom rect",
      show(ownerClip(d, 1)) === show([10, 20, 110, 100]),
      show(ownerClip(d, 1)),
    );
    assert(
      "derive: a non-clipping intermediate inherits its parent's owner and scissor",
      show(d.get(2)) === show({ owner: 1, rect: [10, 20, 110, 100] }),
      show(d.get(2)),
    );
    assert(
      "derive: a nested clip intersects the ancestor's scissor",
      show(ownerClip(d, 3)) === show([50, 60, 110, 100]),
      show(ownerClip(d, 3)),
    );
  }
  // Zero-area skip: no overlap with the ancestor, and an empty command list without custom rect.
  {
    const d = derive(
      [
        item(1, { ...box(0, 0, 50, 50), clip: true, children: [2, 4] }),
        item(2, { ...box(60, 0, 10, 10), clip: true, children: [3] }),
        item(3, { commands: [{ op: "add_rect", rect: [0, 0, 5, 5] }] }),
        item(4, { clip: true, xform: at(5, 5) }),
      ],
      [1],
    );
    assert(
      "derive: a clip that misses its ancestor is skipped with its subtree",
      d.get(2) === "skipped" && d.get(3) === "skipped",
      `${show(d.get(2))} ${show(d.get(3))}`,
    );
    assert(
      "derive: a clip with no commands and no custom rect is zero-area, skipped",
      d.get(4) === "skipped",
      show(d.get(4)),
    );
  }
  // Half rounding: position and size separately, half away from zero.
  {
    const d = derive(
      [item(1, { ...box(0, 0, 10.5, 3.5), clip: true, xform: at(10.5, 2.5) })],
      [1],
    );
    assert(
      "derive: position and size round separately half away (10.5,2.5,10.5,3.5 -> [11,3,22,7))",
      show(ownerClip(d, 1)) === show([11, 3, 22, 7]),
      show(ownerClip(d, 1)),
    );
    assert(
      "derive: roundHalfAway(-2.5) = -3, (2.5) = 3, (0.49) = 0",
      roundHalfAway(-2.5) === -3 &&
        roundHalfAway(2.5) === 3 &&
        roundHalfAway(0.49) === 0,
    );
    const thin = derive(
      [item(1, { ...box(0, 0, 0.4, 10), clip: true, xform: at(5, 5) })],
      [1],
    );
    assert(
      "derive: below 0.5 px wide is skipped",
      thin.get(1) === "skipped",
      show(thin.get(1)),
    );
  }
  // Negative scale and rotation: the axis-aligned bounding box.
  {
    const flip = derive(
      [
        item(1, {
          ...box(8, 8, 64, 48),
          clip: true,
          xform: [-1, 0, 0, 1, 520, 200],
        }),
      ],
      [1],
    );
    assert(
      "derive: a negative x scale normalizes the box (FQ: [448,208,512,256))",
      show(ownerClip(flip, 1)) === show([448, 208, 512, 256]),
      show(ownerClip(flip, 1)),
    );
    const rot = derive(
      [
        item(1, {
          ...box(0, 0, 40, 20),
          clip: true,
          xform: [0, 1, -1, 0, 100, 100],
        }),
      ],
      [1],
    );
    assert(
      "derive: a 90 degree rotation's scissor is the rotated box ([80,100,100,140))",
      show(ownerClip(rot, 1)) === show([80, 100, 100, 140]),
      show(ownerClip(rot, 1)),
    );
    const c30 = Math.cos(Math.PI / 6);
    const s30 = Math.sin(Math.PI / 6);
    const r30 = derive(
      [
        item(1, {
          children: [2],
          xform: [c30, s30, -s30, c30, 128, 120],
        }),
        item(2, { ...box(0, 0, 80, 40), clip: true, xform: at(-40, -20) }),
      ],
      [1],
    );
    assert(
      "derive: gate3-xform's RQ at 30 degrees is [83,83,172,158) (the bounding box, rounded)",
      show(ownerClip(r30, 2)) === show([83, 83, 172, 158]),
      show(ownerClip(r30, 2)),
    );
  }
  // The rect without a custom rect: command bounds, texture flips and transpose.
  {
    const r = itemRect(
      item(1, {
        commands: [
          { op: "add_rect", rect: [10, 10, 5, 5] },
          { op: "add_texture_rect", rect: [0, 0, -8, 4], transpose: true },
        ],
      }),
    );
    assert(
      "derive: command bounds merge add_rect and a flipped, transposed texture rect",
      show(r) === show([0, 0, 15, 15]),
      show(r),
    );
    const u = derive(
      [
        item(1, {
          clip: true,
          commands: [{ op: "unsupported", name: "canvas_item_add_circle" }],
          children: [2],
        }),
        item(2),
      ],
      [1],
    );
    assert(
      "derive: an unsupported command makes an uncustomized clip unknown, with its subtree",
      u.get(1) === "unknown" && u.get(2) === "unknown",
      `${show(u.get(1))} ${show(u.get(2))}`,
    );
    const hidden = derive(
      [
        item(1, {
          ...box(0, 0, 10, 10),
          clip: true,
          visible: false,
          children: [2],
        }),
        item(2),
      ],
      [1],
    );
    assert(
      "derive: an invisible item and its subtree are not visited",
      !hidden.has(1) && !hidden.has(2),
    );
    const shifted = derive(
      [item(1, { ...box(0, 0, 10, 10), clip: true, xform: at(5, 5) })],
      [1],
      [1, 0, 0, 1, 8, 4],
    );
    assert(
      "derive: the canvas transform is the outermost factor",
      show(ownerClip(shifted, 1)) === show([13, 9, 23, 19]),
      show(ownerClip(shifted, 1)),
    );
  }
}

function synthesisCases(): void {
  const e = EXPECTED;
  const s0 = synthesizeGate3(e, 0);
  const s4 = synthesizeGate3(e, 4);
  assert(
    "synthesize: step 0 (300,250) is the clear colour",
    pixelAt(s0, 300, 250).join(",") === e.clear_rgba8.join(","),
  );
  assert(
    "synthesize: AF is clipped by A at step 0 ((90,100) clear) and whole at step 4 (AF)",
    pixelAt(s0, 90, 100).join(",") === e.clear_rgba8.join(",") &&
      pixelAt(s4, 90, 100).join(",") === "255,153,0,255",
    `${pixelAt(s0, 90, 100)} ${pixelAt(s4, 90, 100)}`,
  );
  assert(
    "synthesize: CF wins over NF inside C at step 0 ((240,190))",
    pixelAt(s0, 240, 190).join(",") === "255,51,153,255",
    pixelAt(s0, 240, 190).join(","),
  );
  const s6 = synthesizeGate3(e, 6);
  const s7 = synthesizeGate3(e, 7);
  const s8 = synthesizeGate3(e, 8);
  assert(
    "synthesize: RCF whole at step 6, only [472,96,488,112) at 7, gone at 8",
    pixelAt(s6, 450, 82).join(",") === "102,51,204,255" &&
      pixelAt(s7, 450, 82).join(",") === e.clear_rgba8.join(",") &&
      pixelAt(s7, 480, 100).join(",") === "102,51,204,255" &&
      pixelAt(s8, 480, 100).join(",") === e.clear_rgba8.join(","),
  );
  for (const s of e.steps) {
    const frame = synthesizeGate3(e, s.step);
    const bad = probesOf(e, s.step).filter(
      (p) => pixelAt(frame, p.xy[0], p.xy[1]).join(",") !== p.rgba8.join(","),
    );
    if (bad.length > 0)
      assert(
        `probes: step ${s.step} probe colours equal the synthesis`,
        false,
        bad[0].name,
      );
  }
  assert("probes: every step's probe colours equal the synthesis", true);
  // The ignore-clip receiver: every decisive outside probe fails (plus the inside probes that a
  // later descendant confined by an inner owner -- BF, BZ, CF -- covers once unclipped).
  const failing = new Set(
    EXPECTED.predictions["sabotage-receiver-ignore-clip"].probes ?? [],
  );
  const decisive = e.steps.flatMap((s) =>
    s.probes
      .filter((p) => p.decisive && p.side === "outside")
      .map((p) => `${s.step}:${p.name}`),
  );
  assert(
    "predictions: ignore-clip fails every decisive outside probe",
    decisive.every((p) => failing.has(p)),
    decisive
      .filter((p) => !failing.has(p))
      .slice(0, 3)
      .join(","),
  );
  assert(
    "predictions: omit-clip pins D3 ({3..9}); clip-before-clear {3..9}; omit-custom-rect {7,8,9}",
    show(e.predictions["sabotage-omit-clip"].steps) ===
      show([3, 4, 5, 6, 7, 8, 9]) &&
      show(e.predictions["sabotage-receiver-clip-before-clear"].steps) ===
        show([3, 4, 5, 6, 7, 8, 9]) &&
      show(e.predictions["sabotage-omit-custom-rect"].steps) ===
        show([7, 8, 9]) &&
      show(e.predictions["root-size-observe"].regions) === show(["anchored"]),
  );
  // The TS call model and make_expected.py agree on the census.
  const c = counters();
  const byValue = (key: "clip" | "custom_rect", list: { calls: number }[]) => {
    const out = { false: 0, true: 0 };
    for (const entry of list as unknown as Record<string, unknown>[])
      out[entry[key] ? "true" : "false"] += entry.calls as number;
    return out;
  };
  assert(
    "model: the TS call model's census equals expected.json census_totals",
    show(byValue("clip", c.captured.canvas_item_set_clip)) ===
      show(e.census_totals.canvas_item_set_clip) &&
      show(byValue("custom_rect", c.captured.canvas_item_set_custom_rect)) ===
        show(e.census_totals.canvas_item_set_custom_rect) &&
      c.counts.canvas_item_clear === e.census_totals.canvas_item_clear,
    show(c.counts),
  );
  const states = itemStates();
  assert(
    "model: the mirror clear fix leaves RC unclipped after step 6's clear",
    states[6].RC.clip === false &&
      itemStates({ clearKeepsClip: true })[6].RC.clip === true,
  );
}

function selfConsistentCases(): void {
  const ok = checkExpectedSelfConsistent(EXPECTED);
  assert(
    "expected-self-consistent passes on the committed expected.json",
    ok.passed,
    ok.detail,
  );
  const broken: [string, (e: Gate3Expected) => void][] = [
    [
      "a hand-table scissor off by one",
      (e) => {
        e.hand_clip_rects["3"].B = [176, 138, 237, 188];
      },
    ],
    [
      "a probe colour that is not the synthesized pixel",
      (e) => {
        e.steps[2].probes[0].rgba8 = [0, 0, 0, 255];
      },
    ],
    [
      "a non-decisive edge that is not listed",
      (e) => {
        e.non_decisive_edges = [];
      },
    ],
    [
      "a colour off the 0.2 grid",
      (e) => {
        e.steps[0].draws[1].rgba8 = [128, 0, 0, 255];
      },
    ],
    [
      "a probe pair 2 px apart",
      (e) => {
        const p = e.steps[0].probes.find((q) => q.side === "outside");
        if (p) p.xy = [p.xy[0] + 1, p.xy[1]];
      },
    ],
    [
      "a marker colour reused",
      (e) => {
        e.steps[3].marker_rgba8 = e.steps[2].marker_rgba8;
      },
    ],
  ];
  for (const [what, edit] of broken) {
    const e = clone(EXPECTED);
    edit(e);
    const c = checkExpectedSelfConsistent(e);
    assert(
      `expected-self-consistent fails on ${what}`,
      !c.passed,
      c.detail.slice(0, 160),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Evidence-tree scenarios
// ---------------------------------------------------------------------------------------------

const G3A_CHECKS = [
  "expected-self-consistent",
  "capture-armed",
  "headless-no-gpu",
  "recording-decodes",
  "patch-resolves-to-full",
  "step-alignment",
  "no-draw-index-ties",
  "expected-image-reference",
  "probes-reference",
  "reference-repeat-budget",
  "armed-transparent",
  "clip-state-invariants",
  "clip-rects-derived",
  "clip-call-census",
  "support-legs-exit",
  "leg-class-capture",
];

async function run(out: string, expected = EXPECTED): Promise<Gate3Report> {
  return runGate3(out, { expected, now: new Date(0) });
}

const verdicts = (r: Gate3Report) =>
  new Map(r.checks.map((c) => [c.id, c.status]));
const targeted = new Set<string>();

async function scenario(
  root: string,
  good: string,
  name: string,
  perturb: (out: string) => Promise<void>,
  failing: string[],
  expected = EXPECTED,
): Promise<void> {
  const out = join(root, name);
  await cp(good, out, { recursive: true });
  await perturb(out);
  const report = await run(out, expected);
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
    unexpected.map((c) => `${c.id}: ${c.detail.slice(0, 200)}`).join(" | "),
  );
  assert(`${name}: the gate fails`, !report.gate_passed);
  await rm(out, { recursive: true, force: true });
}

/** Rewrites the capture with other model options (both sinks, evidence, counters). */
function recapture(o: CaptureOptions) {
  return async (out: string) => {
    await rm(join(out, "capture"), { recursive: true, force: true });
    await writeCaptureDir(join(out, "capture"), EXPECTED, o);
  };
}

async function shot(
  out: string,
  leg: string,
  step: number,
  perturb: { x: number; y: number; rgba?: number[] },
) {
  await writeFile(
    join(out, leg, "shots", `step-${step}.png`),
    await shotPng(EXPECTED, step, perturb),
  );
}

/** Edits item `id` from frame `from` on, in every state. */
function editItem(
  id: number,
  from: number,
  edit: (it: TState["items"][number]) => void,
) {
  return (states: TState[]) =>
    states.map((s) => {
      if (s.frame < from) return s;
      const c = clone(s);
      const it = c.items.find((i) => i.id === id);
      if (it) edit(it);
      return c;
    });
}

async function scenarios(root: string): Promise<void> {
  const good = join(root, "good");
  await buildTree(good, EXPECTED);
  const report = await run(good);
  const notPass = report.checks.filter((c) => c.status !== "pass");
  assert(
    `passing tree: all ${report.checks.length} checks pass`,
    report.gate_passed && notPass.length === 0,
    notPass.map((c) => `${c.id}: ${c.detail.slice(0, 300)}`).join(" | "),
  );
  assert(
    "passing tree: the checks are exactly G3a's",
    report.checks.map((c) => c.id).join(",") === G3A_CHECKS.join(","),
    report.checks.map((c) => c.id).join(","),
  );
  assert(
    "passing tree: the capture classifies success",
    report.legs.capture?.result_class === "success",
    report.legs.capture?.reasons.join(" | "),
  );
  assert(
    "passing tree: the report carries the clip-derive table and the probe tally",
    JSON.stringify(report.clip_rects?.gate3?.["8"]?.RC) === '"skipped"' &&
      Object.values(report.probes?.reference ?? {}).reduce(
        (n, t) => n + t.total,
        0,
      ) === EXPECTED.steps.reduce((n, s) => n + s.probes.length, 0),
  );

  {
    const out = join(root, "not-run-check");
    await cp(good, out, { recursive: true });
    await writeJson(join(out, "legs.json"), {
      groups_run: [],
      groups_landed: ["g3a"],
    });
    const r = await run(out);
    assert(
      "not-run: g3a's checks are a not-run entry and the gate fails",
      r.checks.some((c) => c.id === "group-g3a" && c.status === "not-run") &&
        !r.gate_passed,
    );
    await rm(out, { recursive: true, force: true });
  }

  // expected-self-consistent through runGate3: a broken expected.json.
  {
    const e = clone(EXPECTED);
    e.hand_clip_rects["0"].A = [96, 88, 256, 209];
    await scenario(
      root,
      good,
      "bad-hand-table",
      async () => {},
      ["expected-self-consistent"],
      e,
    );
  }
  await scenario(
    root,
    good,
    "hook-omitted",
    async (out) => {
      const path = join(out, "capture", "evidence", "counters.json");
      const c = JSON.parse(await readFile(path, "utf8"));
      c.hooks_omitted = ["canvas_item_set_clip"];
      await writeJson(path, c);
    },
    ["capture-armed"],
  );
  await scenario(
    root,
    good,
    "gpu-opened",
    async (out) => {
      await writeText(
        join(out, "capture", "strace.txt"),
        '42 10:00:00.100000 openat(AT_FDCWD, "/dev/dri/renderD128", O_RDWR|O_CLOEXEC) = 9\n',
      );
    },
    ["headless-no-gpu"],
  );
  await scenario(root, good, "401-transactions", recapture({ quit: 401 }), [
    "recording-decodes",
  ]);
  await scenario(
    root,
    good,
    "patch-diverges",
    recapture({
      patch: {
        mutatePatch: (seq, s) => {
          if (seq !== 300) return s;
          const c = clone(s);
          const it = c.items.find((i) => i.id === ID.B);
          if (it) it.clip = false;
          return c;
        },
      },
    }),
    ["patch-resolves-to-full", "leg-class-capture"],
  );
  await scenario(
    root,
    good,
    "repeat-steps-shifted",
    async (out) => {
      const path = join(out, "reference-repeat", "steps.jsonl");
      const text = await readFile(path, "utf8");
      await writeText(
        path,
        text.replace('"settle_frame":18', '"settle_frame":19'),
      );
    },
    ["step-alignment"],
  );
  await scenario(
    root,
    good,
    "overlapping-tie",
    recapture({
      states: (states) =>
        states.map((s) => {
          if (s.frame !== 200) return s;
          const c = clone(s);
          const d = c.items.find((i) => i.id === ID.D);
          if (d) {
            d.draw_index = 0;
            d.xform = [1, 0, 0, 1, 100, 100];
          }
          c.unsupported = [
            {
              op: "canvas_item_set_draw_index",
              item: ID.A,
              reason: "draw-index-tie",
            },
          ];
          return c;
        }),
    }),
    ["no-draw-index-ties", "leg-class-capture"],
  );
  await scenario(
    root,
    good,
    "reference-pixel-off",
    async (out) => {
      for (const leg of ["reference", "reference-repeat", "reference-armed"])
        await shot(out, leg, 3, { x: 300, y: 250 });
    },
    ["expected-image-reference"],
  );
  {
    const p = EXPECTED.steps[5].probes.find(
      (q) => q.decisive && q.side === "outside",
    );
    await scenario(
      root,
      good,
      "probe-pixel-off",
      async (out) => {
        if (!p) return;
        for (const leg of ["reference", "reference-repeat", "reference-armed"])
          await shot(out, leg, 5, {
            x: p.xy[0],
            y: p.xy[1],
            rgba: p.unclipped_rgba8,
          });
      },
      ["expected-image-reference", "probes-reference"],
    );
  }
  await scenario(
    root,
    good,
    "repeat-differs",
    async (out) => shot(out, "reference-repeat", 7, { x: 10, y: 10 }),
    ["reference-repeat-budget"],
  );
  await scenario(
    root,
    good,
    "armed-differs",
    async (out) => shot(out, "reference-armed", 9, { x: 10, y: 10 }),
    ["armed-transparent"],
  );
  // The pre-gate-3 mirror: clear keeps clip, so RC still clips after step 6's clear.
  await scenario(
    root,
    good,
    "clear-keeps-clip",
    recapture({ clearKeepsClip: true }),
    ["clip-state-invariants", "clip-rects-derived"],
  );
  await scenario(
    root,
    good,
    "content-bump-on-move",
    recapture({
      states: editItem(ID.S1, 11, (it) => {
        it.content_version += 1;
      }),
    }),
    ["clip-state-invariants"],
  );
  await scenario(
    root,
    good,
    "b-off-by-one",
    recapture({
      states: editItem(ID.B, 21, (it) => {
        it.xform = [1, 0, 0, 1, it.xform[4] + 1, it.xform[5]];
      }),
    }),
    ["clip-rects-derived"],
  );
  await scenario(
    root,
    good,
    "census-extra-clip",
    async (out) => {
      await writeJson(
        join(out, "capture", "evidence", "counters.json"),
        counters({ extraClipTrue: 1 }),
      );
    },
    ["clip-call-census"],
  );
  await scenario(
    root,
    good,
    "census-dropped",
    async (out) => {
      const path = join(out, "capture", "evidence", "counters.json");
      const c = JSON.parse(await readFile(path, "utf8"));
      c.captured_dropped.canvas_item_set_custom_rect = 2;
      await writeJson(path, c);
    },
    ["clip-call-census"],
  );
  await scenario(
    root,
    good,
    "reference-exit-1",
    async (out) => writeText(join(out, "reference", "exit-code.txt"), "1\n"),
    ["support-legs-exit"],
  );
  await scenario(
    root,
    good,
    "degenerate-host",
    recapture({
      full: { hostSizeStatus: "degenerate-window", hostWindowSize: [64, 64] },
      patch: { hostSizeStatus: "degenerate-window", hostWindowSize: [64, 64] },
    }),
    ["leg-class-capture"],
  );

  for (const id of G3A_CHECKS)
    assert(`coverage: some scenario fails ${id}`, targeted.has(id));
}

async function main(): Promise<void> {
  EXPECTED = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate3", "expected.json"),
      "utf8",
    ),
  ) as Gate3Expected;
  deriveCases();
  synthesisCases();
  selfConsistentCases();
  const root = await mkdtemp(join(tmpdir(), "self-test-gate3-"));
  try {
    await scenarios(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log(
    `\nself-test-gate3: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
