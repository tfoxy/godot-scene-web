#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 5.5b: lib/geometry-raster.ts's blend modes on hand cases and the g55b checks
// of lib/gate55-checks.ts on synthetic values, each with a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate55b.ts
//
// 1. The blend modes on hand-computed bytes (gate5_5-design.md Q1c, D13): add, sub, mul and
//    premul_alpha over a known destination, disabled writing its own alpha on an 8-bit and a 2-bit
//    target, a light_only (alpha 0) rect painting and covering nothing, and mix unchanged.
// 2. checkExpectedSelfConsistent55 on the committed expected.json and on broken copies.
// 3. The image checks on frames built from the raster itself, and on frames perturbed where each
//    must notice: the contract's α 153 for BD's disabled strip, a mul pixel off by 2.
// 4. material-census on synthetic counters and hook logs, before and after calibrator 8.
// 5. leg-class-capture on a synthetic render-stream/5 recording (success, every item naming
//    CimSim's material), and with the class, a typed entry, RI's step-4 material, UC's
//    use_parent_material, the marker's colour or UC's content_version wrong.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Gate3CaptureEvaluation } from "../lib/gate3-checks";
import {
  compareLegs5,
  evaluateExpectedImage5,
  evaluateFreshness5,
  evaluatePresence5,
  type Frame,
  type Shots,
} from "../lib/gate5-checks";
import type { Gate5Item, Gate5Op, Rgba } from "../lib/gate5-expected";
import {
  censusKeyOf,
  checkExpectedSelfConsistent55,
  evaluateCimCapture5,
  evaluateMaterialCensus,
  legName,
  type MaterialLogLine,
  rectCommandsByStep,
} from "../lib/gate55b-checks";
import {
  asGate5,
  expectedItemMaterials,
  type Gate55Expected,
  type Gate55Variant,
  rasters55,
} from "../lib/gate55b-expected";
import { type Gate5Raster, rasterizeItems } from "../lib/geometry-raster";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "../..");

let assertions = 0;
let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  assertions++;
  if (ok) console.log(`[SELF-TEST OK] ${name}`);
  else {
    failures++;
    console.error(`[SELF-TEST FAIL] ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const passes = (name: string, problems: string[]) =>
  assert(
    `${name} passes`,
    problems.length === 0,
    problems.slice(0, 3).join(" | "),
  );
const fails = (name: string, problems: string[], needle?: string) =>
  assert(
    `${name} fails`,
    problems.length > 0 &&
      (!needle || problems.some((p) => p.includes(needle))),
    problems.length === 0
      ? "no problem reported"
      : `no problem mentions ${JSON.stringify(needle)}: ${problems.slice(0, 2).join(" | ")}`,
  );

// ---------------------------------------------------------------------------------------------
// 1. Blend modes on hand-computed bytes
// ---------------------------------------------------------------------------------------------

/** A 4x1 viewport, clear `clear`, one 4x1 rect at x 0..4 in colour `c` with `blend`. */
function one(
  c: Rgba,
  blend: string | undefined,
  clear = [51, 51, 102, 255],
  alphaBits?: number,
): Gate5Raster {
  const shape: Gate5Op = {
    name: "R",
    kind: "mesh",
    vertices: [
      [0, 0],
      [4, 0],
      [4, 1],
      [0, 1],
    ],
    triangles: [
      [0, 1, 2],
      [0, 2, 3],
    ],
    colors: [c],
    ...(blend ? { blend: blend as "add" } : {}),
  };
  const item: Gate5Item = {
    name: "I",
    region: "R",
    xform: [1, 0, 0, 1, 0, 0],
    clip_px: null,
    ops: "I",
  };
  return rasterizeItems({
    viewport: [4, 1],
    clear: clear as [number, number, number, number],
    textures: {},
    opLists: { I: [shape] },
    items: [item],
    targetAlphaBits: alphaBits,
  });
}
const px = (r: Gate5Raster) => [...r.rgba.subarray(4, 8)].join(",");
const overlay: Rgba = [0.4, 0.2, 0.6, 1];
const strip: Rgba = [0.4, 0.2, 0.6, 0.6];
const underlay = [102, 153, 51, 255];

{
  // add (SRC_ALPHA, ONE): (.4,.2,.6) + (.2,.2,.4) = (.6,.4,1).
  const r = one(overlay, "add");
  assert(
    "add over the clear colour is (153,102,255,255), exact",
    px(r) === "153,102,255,255" && r.delta[1] === 0,
    `${px(r)} delta ${r.delta[1]}`,
  );
  // sub (REVERSE_SUBTRACT): (.4,.6,.2) - (.4,.2,.6) clamps to (0,.4,0).
  const s = one(overlay, "sub", underlay);
  assert(
    "sub over the underlay is (0,102,0,255), exact",
    px(s) === "0,102,0,255" && s.delta[1] === 0,
    px(s),
  );
  // mul (DST_COLOR, ZERO): (.4*.4, .6*.2, .2*.6) = (.16,.12,.12) -> 40.8, 30.6, 30.6.
  const m = one(overlay, "mul", underlay);
  assert(
    "mul over the underlay is (41,31,31,255) with delta 1",
    px(m) === "41,31,31,255" && m.delta[1] === 1,
    `${px(m)} delta ${m.delta[1]}`,
  );
  // premul_alpha (ONE, ONE_MINUS_SRC_ALPHA) at .6: (.4+.2*.4, .2+.2*.4, .6+.4*.4) = (.48,.28,.76).
  const p = one(strip, "premul_alpha");
  assert(
    "premul_alpha .6 over the clear colour is (122,71,194,255) with delta 1",
    px(p) === "122,71,194,255" && p.delta[1] === 1,
    `${px(p)} delta ${p.delta[1]}`,
  );
  // add at .6: (.24+.2, .12+.2, .36+.4) = (.44,.32,.76) -> 112.2, 81.6, 193.8.
  const a6 = one(strip, "add");
  assert(
    "add .6 over the clear colour is (112,82,194,255) with delta 1",
    px(a6) === "112,82,194,255" && a6.delta[1] === 1,
    px(a6),
  );
  // disabled: the fragment, alpha included; 2 alpha bits: round(.6*3)/3 -> 170.
  const d8 = one(strip, "disabled");
  const d2 = one(strip, "disabled", undefined, 2);
  assert(
    "disabled .6 writes (102,51,153,153) on an 8-bit target",
    px(d8) === "102,51,153,153" && d8.delta[1] === 0,
    px(d8),
  );
  assert(
    "disabled .6 writes (102,51,153,170) on the 2-bit-alpha target, exact",
    px(d2) === "102,51,153,170" && d2.delta[1] === 0,
    px(d2),
  );
  // mix is unchanged by the blend support: opaque exact, .6 straight alpha with delta 1.
  const mx = one(strip, undefined, underlay);
  assert(
    "mix .6 over the underlay is (102,92,112,255) with delta 1",
    px(mx) === "102,92,112,255" && mx.delta[1] === 1,
    px(mx),
  );
  // light_only: alpha 0 under mix paints nothing and covers nothing.
  const lo = one([0.6, 0.4, 1, 0], undefined);
  assert(
    "an alpha-0 mix rect paints nothing and covers nothing",
    px(lo) === "51,51,102,255" &&
      lo.shapes[0].covered === 0 &&
      lo.shapes[0].area.length === 0,
    `${px(lo)} covered ${lo.shapes[0].covered}`,
  );
  const la = one([0.6, 0.4, 1, 0], "add");
  assert(
    "an alpha-0 add rect paints nothing and covers nothing",
    px(la) === "51,51,102,255" && la.shapes[0].covered === 0,
  );
  const lm = one([0.6, 0.4, 1, 0], "mul");
  assert(
    "an alpha-0 mul rect still multiplies and covers its pixels",
    px(lm) === "31,20,102,255" && lm.shapes[0].covered === 4,
    `${px(lm)} covered ${lm.shapes[0].covered}`,
  );
}

// ---------------------------------------------------------------------------------------------
// 2. expected-self-consistent
// ---------------------------------------------------------------------------------------------

const expected = JSON.parse(
  await readFile(
    join(EXPERIMENT_DIR, "fixtures", "gate55-cim", "expected.json"),
    "utf8",
  ),
) as Gate55Expected;
const rasters = {
  base: rasters55(expected, "base"),
  modulate: rasters55(expected, "modulate"),
} as Record<Gate55Variant, Map<number, Gate5Raster>>;

{
  const ok = checkExpectedSelfConsistent55(expected, rasters);
  assert(
    "expected-self-consistent passes on the committed expected.json",
    ok.passed,
    ok.detail,
  );

  const probe = clone(expected);
  probe.variants.base.steps[0].probes[0][2] += 1;
  fails(
    "expected-self-consistent on a probe off by 1",
    checkExpectedSelfConsistent55(probe, rasters).passed
      ? []
      : [checkExpectedSelfConsistent55(probe, rasters).detail ?? ""],
    "Python",
  );

  const freshCopy = clone(expected);
  freshCopy.variants.modulate.steps[3].fresh.LO = true;
  const fr = checkExpectedSelfConsistent55(freshCopy, rasters);
  fails(
    "expected-self-consistent on a wrong fresh flag",
    fr.passed ? [] : [fr.detail ?? ""],
    "LO fresh=true",
  );

  const censusCopy = clone(expected);
  censusCopy.hook_census.base.material_set_shader += 1;
  const ce = checkExpectedSelfConsistent55(censusCopy, rasters);
  fails(
    "expected-self-consistent on a census cell",
    ce.passed ? [] : [ce.detail ?? ""],
    "hook_census",
  );

  const grid = clone(expected);
  const firstKey = Object.keys(grid.op_lists)[0];
  const shape = grid.op_lists[firstKey][0];
  if ("kind" in shape && shape.kind === "mesh") shape.colors[0][0] = 0.5;
  const gr = checkExpectedSelfConsistent55(grid, rasters);
  fails(
    "expected-self-consistent on an off-grid colour",
    gr.passed ? [] : [gr.detail ?? ""],
    "off the 0.2 grid",
  );

  const overlap = clone(expected);
  overlap.regions.BA = [100, 16, 192, 96];
  const ov = checkExpectedSelfConsistent55(overlap, rasters);
  fails(
    "expected-self-consistent on overlapping regions",
    ov.passed ? [] : [ov.detail ?? ""],
    "overlap",
  );

  const typedCopy = clone(expected);
  typedCopy.variants.base.steps[4].typed_entries.push("RI");
  const ty = checkExpectedSelfConsistent55(typedCopy, rasters);
  fails(
    "expected-self-consistent on typed_entries naming an item without a material",
    ty.passed ? [] : [ty.detail ?? ""],
    "typed_entries",
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Image checks on frames built from the raster
// ---------------------------------------------------------------------------------------------

function framesOf(r: Map<number, Gate5Raster>): Shots {
  const out: Shots = new Map();
  for (const [k, ras] of r)
    out.set(k, {
      width: ras.width,
      height: ras.height,
      rgba: new Uint8Array(ras.rgba),
    } as Frame);
  return out;
}
function findPixel(r: Gate5Raster, region: number[], rgba: number[]): number {
  for (let y = region[1]; y < region[3]; y++)
    for (let x = region[0]; x < region[2]; x++) {
      const i = y * r.width + x;
      if (rgba.every((v, c) => r.rgba[i * 4 + c] === v)) return i;
    }
  return -1;
}

for (const variant of ["base", "modulate"] as const) {
  const e5 = asGate5(expected, variant);
  const shots = framesOf(rasters[variant]);
  const label = legName("reference", variant);
  passes(
    `${variant}: expected-image on the raster's own frames`,
    evaluateExpectedImage5(e5, label, shots, rasters[variant]).problems,
  );
  passes(
    `${variant}: presence on the raster's own frames`,
    evaluatePresence5(e5, label, shots, rasters[variant]).problems,
  );
  passes(
    `${variant}: freshness on the raster's own frames`,
    evaluateFreshness5(e5, label, shots).problems,
  );
  passes(
    `${variant}: leg comparison of identical frames`,
    compareLegs5(e5, shots, framesOf(rasters[variant]), rasters[variant], [
      "a",
      "b",
    ]).problems,
  );
}
{
  const e5 = asGate5(expected, "base");
  const r0 = rasters.base.get(0) as Gate5Raster;
  // The contract's prediction for BD's disabled strip (alpha 153) must fail: the target is RGB10_A2.
  const bd = expected.regions.BD;
  const strip = findPixel(r0, bd, [102, 51, 153, 170]);
  assert("the raster puts BD's disabled strip at (102,51,153,170)", strip >= 0);
  const shots = framesOf(rasters.base);
  (shots.get(0) as Frame).rgba[strip * 4 + 3] = 153;
  fails(
    "expected-image on the disabled strip at alpha 153",
    evaluateExpectedImage5(e5, "reference", shots, rasters.base).problems,
    "BD",
  );
  // A mul pixel may differ by 1, not by 2.
  const bu = expected.regions.BU;
  const mul = findPixel(r0, bu, [41, 31, 31, 255]);
  assert(
    "the raster puts BU's opaque mul at (41,31,31,255)",
    mul >= 0 && r0.delta[mul] === 1,
  );
  const by1 = framesOf(rasters.base);
  (by1.get(0) as Frame).rgba[mul * 4] = 42;
  passes(
    "expected-image with a mul pixel off by 1",
    evaluateExpectedImage5(e5, "reference", by1, rasters.base).problems,
  );
  const by2 = framesOf(rasters.base);
  (by2.get(0) as Frame).rgba[mul * 4] = 43;
  fails(
    "expected-image with a mul pixel off by 2",
    evaluateExpectedImage5(e5, "reference", by2, rasters.base).problems,
    "BU",
  );
  // An exact add pixel may not differ at all.
  const add = findPixel(r0, expected.regions.BA, [153, 102, 255, 255]);
  const addShots = framesOf(rasters.base);
  (addShots.get(0) as Frame).rgba[add * 4 + 1] = 103;
  fails(
    "expected-image with an exact add pixel off by 1",
    evaluateExpectedImage5(e5, "reference", addShots, rasters.base).problems,
    "BA",
  );
  // UC ignoring use_parent_material at step 6: UP stale, freshness and image fail.
  const stale = framesOf(rasters.base);
  const up = expected.regions.UP;
  for (let y = up[1]; y < up[3]; y++)
    for (let x = up[0]; x < up[2]; x++) {
      const i = y * 640 + x;
      (stale.get(6) as Frame).rgba.set(
        (stale.get(5) as Frame).rgba.subarray(i * 4, i * 4 + 4),
        i * 4,
      );
    }
  fails(
    "freshness when UC does not follow its parent's material at 6",
    evaluateFreshness5(e5, "reference", stale).problems,
    "UP",
  );
  // light_only shown as normal (LO visible at step 0).
  const lo = framesOf(rasters.base);
  const lr = expected.regions.LO;
  const ln = expected.regions.LN;
  for (let y = lr[1]; y < lr[3]; y++)
    for (let x = lr[0]; x < lr[2]; x++) {
      const i = y * 640 + x;
      const j = y * 640 + x - (lr[0] - ln[0]);
      (lo.get(0) as Frame).rgba.set(
        (lo.get(0) as Frame).rgba.subarray(j * 4, j * 4 + 4),
        i * 4,
      );
    }
  fails(
    "expected-image with LO drawn as normal at step 0",
    evaluateExpectedImage5(e5, "reference", lo, rasters.base).problems,
    "LO",
  );
  // A repeat differing in one alpha byte.
  const rep = framesOf(rasters.base);
  (rep.get(2) as Frame).rgba[strip * 4 + 3] = 0;
  fails(
    "leg comparison with one alpha byte differing",
    compareLegs5(e5, framesOf(rasters.base), rep, rasters.base, ["a", "b"])
      .problems,
    "step 2",
  );
}
{
  // The modulate variant: unshaded LU ignores the modulate, so it equals the base variant's LU at
  // step 0; LN does not.
  const b0 = rasters.base.get(0) as Gate5Raster;
  const m0 = rasters.modulate.get(0) as Gate5Raster;
  const at = (r: Gate5Raster, region: number[]) => {
    const i = (region[1] + 40) * 640 + region[0] + 40;
    return [...r.rgba.subarray(i * 4, i * 4 + 4)].join(",");
  };
  assert(
    "modulate: LU (unshaded) equals the base variant's",
    at(b0, expected.regions.LU) === at(m0, expected.regions.LU) &&
      at(m0, expected.regions.LU) === "153,102,255,255",
    at(m0, expected.regions.LU),
  );
  assert(
    "modulate: LN is (153,102,0) under (1,1,0)",
    at(m0, expected.regions.LN) === "153,102,0,255",
    at(m0, expected.regions.LN),
  );
}

// ---------------------------------------------------------------------------------------------
// 4. material-census
// ---------------------------------------------------------------------------------------------

const BEFORE8 = [
  "canvas_item_add_rect",
  "texture_2d_create",
  ...expected.hooked_before_calibrator8,
];
function counters(variant: Gate55Variant, planned: string[]) {
  const counts: Record<string, number> = { canvas_item_add_mesh: 0 };
  for (const op of planned) counts[op] = expected.hook_census[variant][op] ?? 0;
  // counters.json counts every free (items, textures, teardown): never part of this census.
  counts.free = 40;
  return { counts, hooks_planned: [...planned, "free"] };
}
/** One hook-log line per predicted call at each step's applied frame, plus unrelated lines. */
function hookLog(variant: Gate55Variant): MaterialLogLine[] {
  const lines: MaterialLogLine[] = [
    { frame: 1, op: "texture_2d_create", kind: "image" },
  ];
  for (const s of expected.variants[variant].steps)
    for (const c of s.rs_material_calls)
      lines.push({
        frame: s.applied_frame + (s.step === 0 ? 0 : 0),
        op: c.call,
        kind:
          c.call === "free"
            ? (c.kind as string)
            : c.call.startsWith("shader")
              ? "shader"
              : c.call.startsWith("material")
                ? "material"
                : "item-material",
      });
  lines.push(
    { frame: 401, op: "free", kind: "image" },
    { frame: 401, op: "free", kind: "material" },
  );
  return lines;
}
{
  const before = evaluateMaterialCensus(
    expected,
    "base",
    counters("base", BEFORE8),
    undefined,
    400,
  );
  passes("material-census before calibrator 8", before.problems);
  assert(
    "material-census reports calibrator 8's ops unhooked",
    before.calibrator8 === "unhooked" &&
      before.measured.material_create === "unhooked",
  );
  const wrong = counters("base", BEFORE8);
  wrong.counts.material_set_param = 33;
  fails(
    "material-census with material_set_param 33 (step 5's three missing)",
    evaluateMaterialCensus(expected, "base", wrong, undefined, 400).problems,
    "material_set_param",
  );
  const all = [...BEFORE8, ...expected.calibrator8_ops];
  const withLog = evaluateMaterialCensus(
    expected,
    "modulate",
    counters("modulate", all),
    hookLog("modulate"),
    400,
  );
  passes(
    "material-census after calibrator 8 on a matching hook log (teardown frees after quit ignored)",
    withLog.problems,
  );
  assert(
    "material-census counts canvas_set_modulate 3 in the modulate variant",
    withLog.measured.canvas_set_modulate === 3,
    JSON.stringify(withLog.measured),
  );
  const moved = hookLog("base");
  const idx = moved.findIndex(
    (l) => l.op === "shader_create" && l.frame === 31,
  );
  moved[idx] = { ...moved[idx], frame: 41 };
  fails(
    "material-census with step 3's shader_create logged in step 4's window",
    evaluateMaterialCensus(expected, "base", counters("base", all), moved, 400)
      .problems,
    "step 3",
  );
  const omitted = hookLog("base").map((l) =>
    l.op === "material_set_shader" && l.frame === 21
      ? { ...l, omitted: true, sabotage: true }
      : l,
  );
  fails(
    "material-census when step 2's material_set_shader is an omitted (sabotage) line",
    evaluateMaterialCensus(
      expected,
      "base",
      counters("base", all),
      omitted,
      400,
    ).problems,
    "step 2",
  );
  fails(
    "material-census with calibrator 8 half planned",
    evaluateMaterialCensus(
      expected,
      "base",
      counters("base", [...BEFORE8, "material_create"]),
      hookLog("base"),
      400,
    ).problems,
    "partially",
  );
  assert(
    "censusKeyOf splits free by kind and ignores textures",
    censusKeyOf({ frame: 1, op: "free", kind: "shader" }) === "free:shader" &&
      censusKeyOf({ frame: 1, op: "free", kind: "image" }) === null &&
      censusKeyOf({ frame: 1, call: "material_create", kind: "material" }) ===
        "material_create",
  );
}

// ---------------------------------------------------------------------------------------------
// 5. leg-class-capture on a synthetic render-stream/5 recording
// ---------------------------------------------------------------------------------------------

/** Wire material ids deliberately offset from CimSim's (100 + sim id): the check pairs them by
 * ascending order, never by value. */
const WIRE_MATERIAL = (sim: number) => 100 + sim;

function syntheticCapture(
  variant: Gate55Variant,
): Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full"> {
  const v = expected.variants[variant];
  const typed = rectCommandsByStep(expected, variant);
  const own = expectedItemMaterials(expected, variant);
  const idOf = new Map(v.creation_order.map((n, j) => [n, j + 2]));
  const transactions = v.steps.map((s, k) => {
    const items = v.creation_order.map((name) => {
      const m = own.get(s.step)?.get(name);
      return {
        id: idOf.get(name) as number,
        material:
          m?.material == null ? null : WIRE_MATERIAL(m.material as number),
        use_parent_material: m?.use_parent ?? false,
        content_version: name === "Marker" ? 2 + s.step : 2,
        commands: (typed.get(s.step)?.get(name) ?? []).map((c) => ({ ...c })),
      };
    });
    return {
      meta: { seq: k + 1, frame: s.settle_frame, items, unsupported: [] },
      sha256: "",
    };
  });
  return {
    result_class: "success",
    reasons: [],
    full: {
      path: "synthetic",
      present: true,
      sha256: null,
      bytes: 0,
      errors: [],
      transactions,
    } as unknown as Gate3CaptureEvaluation["full"],
  };
}
for (const variant of ["base", "modulate"] as const) {
  const r = evaluateCimCapture5(expected, variant, syntheticCapture(variant));
  passes(
    `${variant}: leg-class-capture on a matching synthetic /5 recording`,
    r.problems,
  );
}
{
  const base = expected.variants.base;
  const idOf = (name: string) => 2 + base.creation_order.indexOf(name);
  const unsupported = {
    ...syntheticCapture("base"),
    result_class: "unsupported" as const,
  };
  fails(
    "leg-class-capture when the capture classifies unsupported",
    evaluateCimCapture5(expected, "base", unsupported).problems,
    "class unsupported",
  );
  const entry = syntheticCapture("base");
  entry.full.transactions[2].meta.unsupported.push({
    op: "canvas_item_set_material",
    item: idOf("RI"),
    reason: "unsupported-material",
  } as never);
  fails(
    "leg-class-capture with an unsupported-material entry",
    evaluateCimCapture5(expected, "base", entry).problems,
    "none expected on /5",
  );
  const ri = syntheticCapture("base");
  const ri4 = ri.full.transactions[4].meta.items.find(
    (i) => i.id === idOf("RI"),
  ) as { material: number | null } | undefined;
  if (ri4) ri4.material = WIRE_MATERIAL(11);
  fails(
    "leg-class-capture when RI still names its freed material at step 4",
    evaluateCimCapture5(expected, "base", ri).problems,
    "step 4 RI",
  );
  const uc = syntheticCapture("base");
  const uc6 = uc.full.transactions[6].meta.items.find(
    (i) => i.id === idOf("UC"),
  ) as { use_parent_material: boolean } | undefined;
  if (uc6) uc6.use_parent_material = false;
  fails(
    "leg-class-capture when UC does not use its parent's material at step 6",
    evaluateCimCapture5(expected, "base", uc).problems,
    "step 6 UC",
  );
  const mod = syntheticCapture("modulate");
  const marker = mod.full.transactions[0].meta.items.find(
    (i) =>
      i.id === 2 + expected.variants.modulate.creation_order.indexOf("Marker"),
  );
  if (marker?.commands[0]?.color) marker.commands[0].color = [0, 0, 0, 1];
  fails(
    "leg-class-capture when the marker's command carries the modulated colour",
    evaluateCimCapture5(expected, "modulate", mod).problems,
    "Marker",
  );
  const redraw = syntheticCapture("base");
  const ucItem = redraw.full.transactions[6].meta.items.find(
    (i) => i.id === idOf("UC"),
  );
  if (ucItem) ucItem.content_version = 3;
  fails(
    "leg-class-capture when UC's content_version moves (a redraw)",
    evaluateCimCapture5(expected, "base", redraw).problems,
    "UC's content_version",
  );
}

console.log(
  `\nself-test-gate55b: ${assertions - failures}/${assertions} assertions passed`,
);
if (failures > 0) process.exitCode = 1;
