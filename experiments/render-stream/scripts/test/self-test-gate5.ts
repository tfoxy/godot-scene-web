#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 5b and 5d: lib/geometry-raster.ts on hand cases, the g5b checks of
// lib/gate5-checks.ts and the g5d evaluators of lib/gate5d-checks.ts and lib/clip-derive.ts on
// synthetic values, each with a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate5.ts
//
// 1. The rasterizer on hand-computed cases (gate5-design.md Q6c): a tie-free triangle (coverage
//    and the 1/16 px decision rule from the edge equation, typed in here), a near-edge pixel, a
//    set-transform that replaces rather than composes (D9), a clip-ignore span (D10), a gradient
//    and a blend (delta 1), nine-patch axis mapping (stretch, tile, tile_fit, a hollow centre), a
//    thin line and an antialiased band, and a closed strip whose seam is welded.
// 2. checkExpectedSelfConsistent on the committed expected.json and on broken copies.
// 3. The image checks (expected-image, presence, freshness, leg comparison) on frames built from
//    the raster itself, and on frames perturbed where each check must notice.
// 4. geometry-hook-census and the capture's render-stream/4 classification (success, every op a
//    command in order; G5d) on synthetic counters and recordings.
// 5. (G5d) geometry-commands (float32-exact passthroughs, 2-ulp computed values, texture ids),
//    lowering-predictions, the per-region sabotage classification, capture-canvas (D11), and
//    clip-derive's D9 (a set_transform replaces, never composes, the draw transform of later
//    commands' rects) and D10 (clip-ignore spans) with clip-rects-derived.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clipIgnoredCommands,
  type DeriveInput,
  deriveClipRects,
  itemRect,
} from "../lib/clip-derive";
import type { Checkpoint, RecordingSummary } from "../lib/gate0-checks";
import type { Gate3CaptureEvaluation } from "../lib/gate3-checks";
import {
  checkExpectedSelfConsistent,
  compareLegs5,
  evaluateCaptureLegClass5,
  evaluateExpectedImage5,
  evaluateFreshness5,
  evaluateGeometryHookCensus,
  evaluatePresence5,
  type Frame,
  rastersOf,
  type Shots,
} from "../lib/gate5-checks";
import type {
  Gate5Expected,
  Gate5Item,
  Gate5Op,
  Gate5Texture,
  Rgba8,
} from "../lib/gate5-expected";
import {
  evaluateCaptureCanvas,
  evaluateClipRectsDerived,
  evaluateGeometryCommands,
  evaluateLegClass5,
  evaluateLoweringPredictions,
  expectedCommandsByStep,
  ulpDistance,
  type WireCommand,
} from "../lib/gate5d-checks";
import {
  type Gate5Raster,
  mapNinePatchAxis,
  meshTopology,
  rasterizeItems,
} from "../lib/geometry-raster";

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
      : problems.slice(0, 2).join(" | "),
  );

// ---------------------------------------------------------------------------------------------
// 1. The rasterizer on hand cases
// ---------------------------------------------------------------------------------------------

const BLACK: Rgba8 = [0, 0, 0, 255];
const WHITE = [1, 1, 1, 1] as [number, number, number, number];

function scene(
  size: [number, number],
  items: {
    ops: Gate5Op[];
    xform?: number[];
    clip?: [number, number, number, number] | null;
  }[],
  textures: Record<string, Gate5Texture> = {},
): Gate5Raster {
  const opLists: Record<string, Gate5Op[]> = {};
  const list: Gate5Item[] = items.map((it, k) => {
    opLists[`i${k}`] = it.ops;
    return {
      name: `i${k}`,
      region: "r",
      xform: (it.xform ?? [1, 0, 0, 1, 0, 0]) as Gate5Item["xform"],
      clip_px: it.clip ?? null,
      ops: `i${k}`,
    };
  });
  return rasterizeItems({
    viewport: size,
    clear: BLACK,
    textures,
    opLists,
    items: list,
  });
}

const rect = (
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  c = WHITE,
): Gate5Op => ({
  name,
  kind: "mesh",
  vertices: [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ],
  triangles: [
    [0, 1, 2],
    [0, 2, 3],
  ],
  colors: [c],
});

const px = (r: Gate5Raster, x: number, y: number) =>
  [...r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)].join(
    ",",
  );
const at = (r: Gate5Raster, x: number, y: number) => y * r.width + x;

function rasterCases(): void {
  // A tie-free triangle (0,0) (8,0) (0,7): the hypotenuse 7x + 8y = 56 has dx + dy = 15 odd, so
  // no centre lies on it. A centre is inside iff 7cx + 8cy < 56, and decided iff its distance
  // |7cx + 8cy - 56| / sqrt(113) is at least 1/16.
  const tri = scene(
    [10, 10],
    [
      {
        ops: [
          {
            name: "T",
            kind: "mesh",
            vertices: [
              [0, 0],
              [8, 0],
              [0, 7],
            ],
            triangles: [[0, 1, 2]],
            colors: [WHITE],
          },
        ],
      },
    ],
  );
  let coverOk = true;
  let decideOk = true;
  let covered = 0;
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 10; x++) {
      const e = 7 * (x + 0.5) + 8 * (y + 0.5) - 56;
      const decided = Math.abs(e) / Math.sqrt(113) >= 1 / 16;
      if (decided !== Boolean(tri.exact[at(tri, x, y)])) decideOk = false;
      if (e < 0) covered++;
      if (decided && e < 0 !== (px(tri, x, y) === "255,255,255,255"))
        coverOk = false;
    }
  assert("raster: tie-free triangle covers by pixel centre", coverOk);
  assert(
    "raster: tie-free triangle decides at 1/16 px from its hypotenuse",
    decideOk,
  );
  assert(
    "raster: tie-free triangle reports its covered centres",
    tri.shapes[0]?.covered === covered,
    `${tri.shapes[0]?.covered} vs ${covered}`,
  );
  // Centre (0.5, 6.5): 3.5 + 52 - 56 = -0.5, distance 0.047 px: inside but undecided.
  assert(
    "raster: a near-edge pixel is undecided",
    tri.exact[at(tri, 0, 6)] === 0,
  );
  assert(
    "raster: pixel (0,5) is decided and covered",
    tri.exact[at(tri, 0, 5)] === 1 && px(tri, 0, 5) === "255,255,255,255",
  );

  // D9: set_transform replaces. A at (4,0) by translate(4,0); B by translate(0,4) alone, at (0,4),
  // not at (4,4).
  const red = [1, 0, 0, 1] as [number, number, number, number];
  const green = [0, 1, 0, 1] as [number, number, number, number];
  const st = scene(
    [10, 10],
    [
      {
        ops: [
          { op: "set_transform", transform: [1, 0, 0, 1, 4, 0] },
          rect("A", 0, 0, 2, 2, red),
          { op: "set_transform", transform: [1, 0, 0, 1, 0, 4] },
          rect("B", 0, 0, 2, 2, green),
        ],
        xform: [1, 0, 0, 1, 1, 1],
      },
    ],
  );
  assert(
    "raster: set_transform applies to later shapes",
    px(st, 5, 1) === "255,0,0,255",
    px(st, 5, 1),
  );
  assert(
    "raster: set_transform replaces, never composes",
    px(st, 1, 5) === "0,255,0,255" && px(st, 5, 5) === "0,0,0,255",
  );

  // D10: clip-ignore span. Clip [0,0,4,4]; X fills it; Y (4,4)+2 drawn unclipped; Z clipped away.
  const ci = scene(
    [10, 10],
    [
      {
        ops: [
          rect("X", 0, 0, 8, 8, red),
          { op: "clip_ignore", ignore: true },
          rect("Y", 4, 4, 2, 2, green),
          { op: "clip_ignore", ignore: false },
          rect("Z", 6, 0, 2, 2, WHITE),
        ],
        clip: [0, 0, 4, 4],
      },
    ],
  );
  assert(
    "raster: the scissor confines clipped shapes",
    px(ci, 3, 3) === "255,0,0,255" && px(ci, 5, 1) === "0,0,0,255",
  );
  assert(
    "raster: a clip-ignored shape draws outside the scissor",
    px(ci, 5, 5) === "0,255,0,255",
  );
  assert(
    "raster: clip_ignore(false) restores the scissor",
    px(ci, 7, 1) === "0,0,0,255",
  );

  // A gradient (per-vertex colours) and a .6 blend carry delta 1; flat colours delta 0.
  const grad = scene(
    [8, 4],
    [
      {
        ops: [
          {
            name: "G",
            kind: "mesh",
            vertices: [
              [0, 0],
              [8, 0],
              [8, 4],
              [0, 4],
            ],
            triangles: [
              [0, 1, 2],
              [0, 2, 3],
            ],
            colors: [
              [0, 0, 0, 1],
              [1, 1, 1, 1],
              [1, 1, 1, 1],
              [0, 0, 0, 1],
            ],
          },
        ],
      },
    ],
  );
  // Centre x = 4.5 of 8: 0.5625 * 255 = 143.4 -> 143.
  assert(
    "raster: a gradient interpolates by barycentrics",
    px(grad, 4, 1) === "143,143,143,255",
    px(grad, 4, 1),
  );
  assert("raster: a gradient allows delta 1", grad.delta[at(grad, 4, 1)] === 1);
  const blend = scene(
    [4, 4],
    [
      {
        ops: [
          rect("W", 0, 0, 4, 4, WHITE),
          rect("T", 0, 0, 2, 4, [0.2, 0.4, 1, 0.6]),
        ],
      },
    ],
  );
  // 0.2*.6 + 1*.4 = .52 -> 133; .4*.6 + .4 = .64 -> 163; 1 -> 255.
  assert(
    "raster: straight-alpha blending in float",
    px(blend, 0, 0) === "133,163,255,255",
    px(blend, 0, 0),
  );
  assert(
    "raster: a blend allows delta 1, flat stays 0",
    blend.delta[at(blend, 0, 0)] === 1 && blend.delta[at(blend, 3, 0)] === 0,
  );

  // Nine-patch axis mapping (canvas.glsl:521-558) on a 12-texel axis with 4-texel margins.
  const s = mapNinePatchAxis(28.5, 56, 12, 4, 4, "stretch", 1 / 16);
  assert(
    "nine-patch: stretch maps the centre by ratio",
    Math.abs(s.texel - (4 + (24.5 / 48) * 4)) < 1e-12 && s.centre,
  );
  const t = mapNinePatchAxis(9.5, 56, 12, 4, 4, "tile", 1 / 16);
  assert(
    "nine-patch: tile wraps by the centre's texel width",
    Math.abs(t.texel - 5.5) < 1e-12,
  );
  const tf = mapNinePatchAxis(9.5, 24, 12, 4, 4, "tile_fit", 1 / 16);
  // src 16, dst 4: scale round(4) = 4; ratio (5.5/16)*4 = 1.375 -> .375 -> 4 + 1.5 = 5.5.
  assert(
    "nine-patch: tile_fit repeats a whole number of times",
    Math.abs(tf.texel - 5.5) < 1e-12,
    String(tf.texel),
  );
  const r = mapNinePatchAxis(54.5, 56, 12, 4, 4, "stretch", 1 / 16);
  assert(
    "nine-patch: the end margin maps 1:1 from the texture's end",
    Math.abs(r.texel - 10.5) < 1e-12 && !r.centre,
  );
  const hex = (c: number[]) =>
    c.map((v) => v.toString(16).padStart(2, "0")).join("");
  let tex9 = "";
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 12; x++)
      tex9 += hex(
        x >= 4 && x < 8 && y >= 4 && y < 8
          ? [102, 51, 204, 255]
          : [255, 255, 153, 255],
      );
  const np = (centre: boolean) =>
    scene(
      [64, 48],
      [
        {
          ops: [
            {
              name: "N",
              kind: "nine_patch",
              rect: [0, 0, 56, 40],
              texture: "T9",
              margins: [4, 4, 4, 4],
              x_axis: "stretch",
              y_axis: "stretch",
              draw_center: centre,
              modulate: WHITE,
            },
          ],
        },
      ],
      { T9: { width: 12, height: 12, rgba8_hex: tex9 } },
    );
  const full = np(true);
  const hollow = np(false);
  assert(
    "nine-patch: margins sample the border",
    px(full, 1, 1) === "255,255,153,255" &&
      px(full, 54, 20) === "255,255,153,255",
  );
  assert(
    "nine-patch: the stretched centre samples the centre",
    px(full, 28, 20) === "102,51,204,255",
  );
  assert(
    "nine-patch: a centre pixel 0.04 texel from a border texel is undecided",
    full.exact[at(full, 4, 20)] === 0,
  );
  assert(
    "nine-patch: draw_center=false leaves the centre unpainted",
    px(hollow, 28, 20) === "0,0,0,255" &&
      hollow.exact[at(hollow, 28, 20)] === 1,
  );
  assert(
    "nine-patch: a hollow centre is not covered",
    hollow.shapes[0].covered === 56 * 40 - 48 * 32 &&
      full.shapes[0].covered === 56 * 40,
    `${hollow.shapes[0].covered}/${full.shapes[0].covered}`,
  );

  // Band classes: a thin line marks centres within 1 px; an antialiased rect marks 2.25 px each
  // side of its boundary and synthesizes only its interior.
  const thin = scene(
    [12, 6],
    [
      {
        ops: [
          {
            name: "L",
            kind: "thin_line",
            from: [1, 2.5],
            to: [11, 2.5],
            colors: [WHITE],
            band_px: 1,
          },
        ],
      },
    ],
  );
  assert(
    "raster: a thin line is band within 1 px",
    thin.band[at(thin, 5, 1)] === 1 &&
      thin.band[at(thin, 5, 2)] === 1 &&
      thin.band[at(thin, 5, 4)] === 0,
  );
  assert(
    "raster: a thin line covers its length",
    thin.shapes[0].covered === 10,
  );
  const aa = scene(
    [20, 20],
    [
      {
        ops: [
          { ...(rect("R", 4, 4, 12, 12) as object), band_px: 2.25 } as Gate5Op,
        ],
      },
    ],
  );
  assert(
    "raster: an antialiased rect's feather is band",
    aa.band[at(aa, 2, 10)] === 1 && aa.band[at(aa, 5, 10)] === 1,
  );
  assert(
    "raster: an antialiased rect's interior is exact",
    aa.exact[at(aa, 10, 10)] === 1 && px(aa, 10, 10) === "255,255,255,255",
  );
  assert(
    "raster: far outside a feather stays exact background",
    aa.exact[at(aa, 0, 10)] === 1 && px(aa, 0, 10) === "0,0,0,255",
  );

  // A closed strip repeats its first pair through another float path: welded, the seam is no
  // boundary.
  const loop = meshTopology(
    [
      [0, 0],
      [1, 1],
      [4, 0],
      [3, 1],
      [0.0000001, 0],
      [1, 1.0000001],
    ],
    [
      [0, 1, 2],
      [1, 2, 3],
      [2, 3, 4],
      [3, 4, 5],
    ],
  );
  const seam = loop.boundary.some(
    ([a, b]) => (a === 0 && b === 1) || (a === 1 && b === 0),
  );
  assert(
    "raster: a welded seam is not a boundary edge",
    !seam,
    JSON.stringify(loop.boundary),
  );
}

// ---------------------------------------------------------------------------------------------
// 2. expected-self-consistent
// ---------------------------------------------------------------------------------------------

function selfConsistentCases(
  expected: Gate5Expected,
  rasters: Map<number, Gate5Raster>,
): void {
  const ok = checkExpectedSelfConsistent(expected, rasters);
  assert(
    "expected-self-consistent passes on the committed file",
    ok.passed,
    ok.detail,
  );
  const offGrid = clone(expected);
  const g1 = offGrid.op_lists["PG@0"].find(
    (o) => "name" in o && o.name === "G1",
  ) as { colors: number[][] };
  g1.colors[0][0] = 0.5;
  fails(
    "expected-self-consistent (off-grid colour)",
    checkExpectedSelfConsistent(offGrid, rasters).passed ? [] : ["x"],
  );
  const overlap = clone(expected);
  overlap.regions.PL = [160, 16, 320, 100];
  fails(
    "expected-self-consistent (overlapping regions)",
    checkExpectedSelfConsistent(overlap, rasters).passed ? [] : ["x"],
  );
  const tie = clone(expected);
  const g1v = tie.op_lists["PG@0"].find(
    (o) => "name" in o && o.name === "G1",
  ) as { vertices: number[][] };
  g1v.vertices[3] = [64, 24]; // (40,8)-(64,24): dx + dy = 40, a centre on the edge
  const tieCheck = checkExpectedSelfConsistent(tie, rastersOf(tie));
  assert(
    "expected-self-consistent fails (an even-parity edge)",
    !tieCheck.passed && tieCheck.detail.includes("even dx+dy"),
    tieCheck.detail.slice(0, 200),
  );
  const census = clone(expected);
  census.hook_census.canvas_item_add_line = 14;
  fails(
    "expected-self-consistent (census column)",
    checkExpectedSelfConsistent(census, rasters).passed ? [] : ["x"],
  );
  const fresh = clone(expected);
  fresh.steps[3].fresh.L2 = true;
  const freshCheck = checkExpectedSelfConsistent(fresh, rasters);
  assert(
    "expected-self-consistent fails (fresh disagrees with the raster)",
    !freshCheck.passed && freshCheck.detail.includes("L2 fresh=true"),
    freshCheck.detail.slice(0, 200),
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Image checks on raster-built frames
// ---------------------------------------------------------------------------------------------

/** A plausible reference: the raster, with every band-class shape's area painted in its colour
 * (the raster leaves band pixels at whatever lay beneath). */
function shotsFromRasters(
  expected: Gate5Expected,
  rasters: Map<number, Gate5Raster>,
): Shots {
  const out: Shots = new Map();
  for (const s of expected.steps) {
    const r = rasters.get(s.step) as Gate5Raster;
    const rgba = new Uint8Array(r.rgba);
    for (const c of r.shapes)
      if (c.band_class)
        for (const i of c.area)
          if (!r.exact[i]) rgba.set([255, 0, 255, 255], i * 4);
    out.set(s.step, { width: r.width, height: r.height, rgba });
  }
  return out;
}

function cloneShots(shots: Shots): Shots {
  const out: Shots = new Map();
  for (const [k, f] of shots)
    out.set(k, f ? { ...f, rgba: new Uint8Array(f.rgba) } : null);
  return out;
}

function imageCases(
  expected: Gate5Expected,
  rasters: Map<number, Gate5Raster>,
): void {
  const shots = shotsFromRasters(expected, rasters);
  passes(
    "expected-image-reference",
    evaluateExpectedImage5(expected, "ref", shots, rasters).problems,
  );
  const r0 = rasters.get(0) as Gate5Raster;
  const find = (pred: (i: number) => boolean) => {
    for (let i = 0; i < r0.width * r0.height; i++) if (pred(i)) return i;
    return -1;
  };
  const exactPx = find(
    (i) =>
      r0.exact[i] === 1 &&
      r0.delta[i] === 0 &&
      r0.rgba[i * 4] === 51 &&
      i > 640 * 20,
  );
  const deltaPx = find(
    (i) => r0.exact[i] === 1 && r0.delta[i] === 1 && r0.rgba[i * 4] < 250,
  );
  const bandPx = find((i) => r0.band[i] === 1);
  const bump = (i: number, by: number) => {
    const s = cloneShots(shots);
    const f = s.get(0) as Frame;
    f.rgba[i * 4 + 1] =
      f.rgba[i * 4 + 1] + by > 255
        ? f.rgba[i * 4 + 1] - by
        : f.rgba[i * 4 + 1] + by;
    return s;
  };
  fails(
    "expected-image-reference (an exact pixel off by 1)",
    evaluateExpectedImage5(expected, "ref", bump(exactPx, 1), rasters).problems,
    "step 0",
  );
  passes(
    "expected-image-reference (a delta-1 pixel off by 1)",
    evaluateExpectedImage5(expected, "ref", bump(deltaPx, 1), rasters).problems,
  );
  fails(
    "expected-image-reference (a delta-1 pixel off by 2)",
    evaluateExpectedImage5(expected, "ref", bump(deltaPx, 2), rasters).problems,
  );
  passes(
    "expected-image-reference (a band pixel changed)",
    evaluateExpectedImage5(expected, "ref", bump(bandPx, 7), rasters).problems,
  );

  const presence = evaluatePresence5(expected, "ref", shots, rasters);
  passes("presence-reference", presence.problems);
  // Erase G1 at step 0 back to what lies beneath it.
  const erased = cloneShots(shots);
  const g1 = r0.shapes.find((c) => c.shape === "G1");
  if (g1)
    for (let k = 0; k < g1.area.length; k++)
      (erased.get(0) as Frame).rgba.set(
        g1.underlay.subarray(k * 4, k * 4 + 4),
        g1.area[k] * 4,
      );
  fails(
    "presence-reference (G1 missing)",
    evaluatePresence5(expected, "ref", erased, rasters).problems,
    "PG/G1",
  );
  // Erase the thin line L4 (band only).
  const noThin = cloneShots(shots);
  const l4 = r0.shapes.find((c) => c.shape === "L4");
  if (l4)
    for (let k = 0; k < l4.area.length; k++)
      (noThin.get(0) as Frame).rgba.set(
        l4.underlay.subarray(k * 4, k * 4 + 4),
        l4.area[k] * 4,
      );
  fails(
    "presence-reference (thin line missing)",
    evaluatePresence5(expected, "ref", noThin, rasters).problems,
    "LN/L4",
  );

  passes(
    "freshness-reference",
    evaluateFreshness5(expected, "ref", shots).problems,
  );
  const stale = cloneShots(shots);
  stale.set(3, stale.get(2) ?? null);
  fails(
    "freshness-reference (step 3 repeats step 2)",
    evaluateFreshness5(expected, "ref", stale).problems,
    "PL did not change",
  );
  const extra = cloneShots(shots);
  const l2 = expected.regions.L2;
  (extra.get(3) as Frame).rgba[(l2[1] * 640 + l2[0]) * 4] ^= 1;
  fails(
    "freshness-reference (L2 changes at step 3)",
    evaluateFreshness5(expected, "ref", extra).problems,
    "L2 changed",
  );

  const same = compareLegs5(expected, shots, cloneShots(shots), rasters, [
    "a",
    "b",
  ]);
  passes("reference-repeat-budget", same.problems);
  assert(
    "reference-repeat-budget reports per region and class",
    same.budgets.some(
      (b) => b.region === "CI" && b.class === "band" && b.pixels > 0,
    ),
  );
  const differ = compareLegs5(expected, shots, bump(bandPx, 3), rasters, [
    "a",
    "b",
  ]);
  fails(
    "reference-repeat-budget (a band pixel differs)",
    differ.problems,
    "1 pixels differ",
  );
  assert(
    "reference-repeat-budget measures the band maximum",
    differ.budgets.some(
      (b) =>
        b.class === "band" &&
        b.max_channel_delta === 3 &&
        b.mismatched_pixels === 1,
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// 4. geometry-hook-census and the capture's typed commands
// ---------------------------------------------------------------------------------------------

function censusCases(expected: Gate5Expected): void {
  const planned = [
    ...Object.keys(expected.hook_census).filter(
      (op) => op !== "canvas_item_add_multiline",
    ),
    "texture_2d_create",
    "canvas_item_add_mesh",
  ];
  const counts: Record<string, number> = {
    canvas_item_add_mesh: 0,
    texture_2d_create: 3,
  };
  for (const [op, n] of Object.entries(expected.hook_census))
    if (op !== "canvas_item_add_multiline") counts[op] = n;
  const good = evaluateGeometryHookCensus(expected, {
    counts,
    hooks_planned: planned,
  });
  passes("geometry-hook-census", good.problems);
  assert(
    "geometry-hook-census reports multiline unhooked before calibrator 7",
    good.unhooked.join() === "canvas_item_add_multiline",
  );
  const g5a = evaluateGeometryHookCensus(expected, {
    counts: { ...counts, canvas_item_add_multiline: 3 },
    hooks_planned: [...planned, "canvas_item_add_multiline"],
  });
  passes("geometry-hook-census (calibrator 7 hooks multiline)", g5a.problems);
  fails(
    "geometry-hook-census (a count off)",
    evaluateGeometryHookCensus(expected, {
      counts: { ...counts, canvas_item_add_line: 14 },
      hooks_planned: planned,
    }).problems,
    "add_line",
  );
  fails(
    "geometry-hook-census (multiline hooked, not counted)",
    evaluateGeometryHookCensus(expected, {
      counts,
      hooks_planned: [...planned, "canvas_item_add_multiline"],
    }).problems,
    "multiline",
  );
  fails(
    "geometry-hook-census (an unexpected draw op)",
    evaluateGeometryHookCensus(expected, {
      counts: { ...counts, canvas_item_add_mesh: 1 },
      hooks_planned: planned,
    }).problems,
    "add_mesh",
  );
  fails(
    "geometry-hook-census (texture creates)",
    evaluateGeometryHookCensus(expected, {
      counts: { ...counts, texture_2d_create: 2 },
      hooks_planned: planned,
    }).problems,
    "texture_2d_create",
  );
}

/** Wire ids the synthetic recordings give the fixture textures (the hue strip is 1). */
const TEX_IDS = new Map([
  ["TEX16", 2],
  ["TEX9", 3],
]);

/** A /4 recording whose settle transactions carry exactly expected.json's calls as commands
 * (ids 2.. by creation order), the three textures, no unsupported entry, and every item's
 * content_version bumped at each of its redraws. */
function syntheticCapture(
  expected: Gate5Expected,
): Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full"> {
  const byStep = expectedCommandsByStep(expected, TEX_IDS);
  const versions = new Map<string, number>();
  const textures = [
    { id: 1, kind: "image", status: "ok", width: 800, height: 6 },
    ...[...TEX_IDS].map(([name, id]) => ({
      id,
      kind: "image",
      status: "ok",
      width: expected.textures[name].width,
      height: expected.textures[name].height,
    })),
  ];
  const transactions = expected.steps.map((s, k) => {
    for (const name of s.redraws)
      versions.set(name, (versions.get(name) ?? 0) + 2);
    const items = expected.creation_order.map((name, j) => ({
      id: j + 2,
      content_version: versions.get(name) ?? 0,
      commands: clone(
        (byStep.get(s.step)?.get(name) ?? []).map((c) => c.command),
      ),
    }));
    return {
      meta: {
        seq: k + 1,
        frame: s.settle_frame,
        items,
        unsupported: [],
        textures,
      },
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
    } as unknown as RecordingSummary,
  };
}

/** The commands of fixture item `name` at transaction `k` of a synthetic capture. */
function commandsOf(
  expected: Gate5Expected,
  rec: RecordingSummary,
  k: number,
  name: string,
): WireCommand[] {
  return rec.transactions[k].meta.items[expected.creation_order.indexOf(name)]
    .commands as unknown as WireCommand[];
}

/** Command `index` of commandsOf(...), viewed as `T` (test mutation only). */
function commandAt<T>(
  expected: Gate5Expected,
  rec: RecordingSummary,
  k: number,
  name: string,
  index: number,
): T {
  return commandsOf(expected, rec, k, name)[index] as unknown as T;
}

function captureCases(expected: Gate5Expected): void {
  const good = syntheticCapture(expected);
  passes(
    "leg-class-capture (/4: success, every op a command)",
    evaluateCaptureLegClass5(expected, good).problems,
  );
  fails(
    "leg-class-capture (class unsupported)",
    evaluateCaptureLegClass5(expected, {
      ...good,
      result_class: "unsupported",
    }).problems,
    "class unsupported",
  );
  const typed = clone(syntheticCapture(expected));
  commandsOf(expected, typed.full, 0, "ST")[1] = {
    op: "unsupported",
    name: "canvas_item_add_set_transform",
    reason: "unsupported-op",
  };
  fails(
    "leg-class-capture (a set_transform still typed unsupported)",
    evaluateCaptureLegClass5(expected, typed).problems,
    "unsupported canvas_item_add_set_transform",
  );
  const reordered = clone(syntheticCapture(expected));
  // LN's ops (four lines, a multiline, a line) are not a palindrome, so reversing reorders them.
  commandsOf(expected, reordered.full, 0, "LN").reverse();
  fails(
    "leg-class-capture (commands out of order)",
    evaluateCaptureLegClass5(expected, reordered).problems,
    "step 0 LN",
  );
}

/** The next float32 above `v`, `n` times. */
function ulpsUp(v: number, n: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, v, true);
  view.setInt32(0, view.getInt32(0, true) + (v >= 0 ? n : -n), true);
  return view.getFloat32(0, true);
}

function geometryCommandCases(expected: Gate5Expected): void {
  const good = syntheticCapture(expected);
  const sinks = (full: RecordingSummary) => [
    { label: "full", recording: full },
    { label: "patch", recording: good.full },
  ];
  const r = evaluateGeometryCommands(expected, sinks(good.full));
  passes("geometry-commands (expected calls as /4 commands)", r.problems);
  assert(
    "geometry-commands compares every command of both sinks",
    r.compared > 100 && r.ulpUsed === 0,
    `${r.compared} compared, ${r.ulpUsed} within ulp`,
  );
  assert(
    "ulpDistance counts float32 steps across zero",
    ulpDistance(1, ulpsUp(1, 2)) === 2 &&
      ulpDistance(-0, 0) === 0 &&
      ulpDistance(ulpsUp(0, 1), -ulpsUp(0, 1)) === 2,
  );
  // ST's first set_transform is computed (draw_set_transform: ulp 2).
  const stIndex = 1;
  const within = clone(good.full);
  const st = commandAt<{ transform: number[] }>(
    expected,
    within,
    0,
    "ST",
    stIndex,
  );
  st.transform[0] = ulpsUp(st.transform[0], 2);
  const w = evaluateGeometryCommands(expected, sinks(within));
  assert(
    "geometry-commands: a computed value 2 ulp off passes, counted",
    w.problems.length === 0 && w.ulpUsed === 1,
    w.problems.slice(0, 2).join(" | "),
  );
  const beyond = clone(good.full);
  commandAt<{ transform: number[] }>(
    expected,
    beyond,
    0,
    "ST",
    stIndex,
  ).transform[0] = ulpsUp(2, 3);
  fails(
    "geometry-commands (a computed value 3 ulp off)",
    evaluateGeometryCommands(expected, sinks(beyond)).problems,
    "full step 0 ST command 1",
  );
  const passthrough = clone(good.full);
  commandAt<{ from: number[] }>(expected, passthrough, 0, "LN", 0).from[0] =
    ulpsUp(8, 1);
  fails(
    "geometry-commands (a passthrough argument 1 ulp off)",
    evaluateGeometryCommands(expected, sinks(passthrough)).problems,
    "full step 0 LN command 0",
  );
  const dropped = clone(good.full);
  commandsOf(expected, dropped, 0, "CG").splice(1, 1);
  fails(
    "geometry-commands (a clip_ignore missing)",
    evaluateGeometryCommands(expected, sinks(dropped)).problems,
    "full step 0 CG: 4 commands",
  );
  const wrongTex = clone(good.full);
  commandAt<{ tex: number }>(expected, wrongTex, 0, "NP", 0).tex = 2;
  fails(
    "geometry-commands (a nine-patch naming the wrong texture)",
    evaluateGeometryCommands(expected, sinks(wrongTex)).problems,
    "full step 0 NP command 0",
  );

  passes(
    "lowering-predictions",
    evaluateLoweringPredictions(expected, good.full).problems,
  );
  const l2 = clone(good.full);
  commandAt<{ points: number[][] }>(expected, l2, 3, "L2", 0).points[0][0] = 9;
  fails(
    "lowering-predictions (Line2D's bytes change at step 3)",
    evaluateLoweringPredictions(expected, l2).problems,
    "L2's commands differ",
  );
  const dash = clone(good.full);
  commandAt<{ points: number[][] }>(expected, dash, 0, "LN", 4).points.pop();
  fails(
    "lowering-predictions (a dash missing)",
    evaluateLoweringPredictions(expected, dash).problems,
    "L5 step 0: points 15",
  );
}

/** Checkpoints over the gate 5 regions where `bad` (step -> regions) mismatch by one pixel. */
function regionCheckpoints(
  expected: Gate5Expected,
  bad: Record<number, string[]>,
): Checkpoint[] {
  return expected.steps.map((s) => {
    const regions = Object.entries(expected.regions).map(([name, r]) => ({
      name,
      rect_px: [r[0], r[1], r[2] - r[0], r[3] - r[1]],
      mismatched_pixels: (bad[s.step] ?? []).includes(name) ? 1 : 0,
      max_channel_delta: (bad[s.step] ?? []).includes(name) ? 9 : 0,
    }));
    const n = regions.reduce((a, r) => a + r.mismatched_pixels, 0);
    return {
      step: s.step,
      settle_frame: s.settle_frame,
      seq: s.step + 1,
      reference_png: "",
      receiver_png: "",
      diff_png: null,
      mismatched_pixels: n,
      max_channel_delta: n > 0 ? 9 : 0,
      regions,
    };
  });
}

function legClassCases(expected: Gate5Expected): void {
  const pv = expected.predictions["sabotage-perturb-vertex"];
  const bad: Record<number, string[]> = {};
  for (const [region, steps] of Object.entries(pv.regions ?? {}))
    for (const k of steps) bad[k] = [...(bad[k] ?? []), region];
  const mismatch = { result_class: "pixel-mismatch" as const, reasons: [] };
  passes(
    "leg-class (perturb-vertex's predicted regions)",
    evaluateLegClass5(mismatch, regionCheckpoints(expected, bad), {
      class: "pixel-mismatch",
      regions: pv.regions,
    }).problems,
  );
  fails(
    "leg-class (a region the prediction does not name)",
    evaluateLegClass5(
      mismatch,
      regionCheckpoints(expected, { ...bad, 9: [...(bad[9] ?? []), "NP"] }),
      { class: "pixel-mismatch", regions: pv.regions },
    ).problems,
    "step 9",
  );
  fails(
    "leg-class (a predicted region that matches)",
    evaluateLegClass5(
      mismatch,
      regionCheckpoints(expected, { ...bad, 2: [] }),
      { class: "pixel-mismatch", regions: pv.regions },
    ).problems,
    "step 2",
  );
  const freeze = expected.predictions["sabotage-freeze"].steps ?? [];
  passes(
    "leg-class (freeze: exactly its steps)",
    evaluateLegClass5(
      mismatch,
      regionCheckpoints(
        expected,
        Object.fromEntries(freeze.map((k) => [k, ["Marker"]])),
      ),
      { class: "pixel-mismatch", steps: freeze },
    ).problems,
  );
  fails(
    "leg-class (success expected, one region differs)",
    evaluateLegClass5(
      { result_class: "success", reasons: [] },
      regionCheckpoints(expected, { 4: ["ST"] }),
      { class: "success" },
    ).problems,
    "step 4",
  );
}

/** The canvas variant: the predicted (item, op) pairs typed canvas-texture-headless in place. */
function syntheticCanvas(
  expected: Gate5Expected,
): Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full"> {
  const good = syntheticCapture(expected);
  const entries = (
    expected.predictions["capture-canvas"] as {
      entries: [string, string][];
    }
  ).entries;
  const refused = new Set(entries.map(([i, op]) => `${i}:${op}`));
  const byStep = expectedCommandsByStep(expected, TEX_IDS);
  good.full.transactions.forEach((t, k) => {
    const step = expected.steps[k].step;
    for (const name of expected.creation_order) {
      const list = byStep.get(step)?.get(name) ?? [];
      const item = t.meta.items[expected.creation_order.indexOf(name)];
      item.commands = list.map((c) =>
        refused.has(`${name}:${c.call.op}`) && c.call.texture === null
          ? {
              op: "unsupported",
              name: c.call.op,
              reason: "canvas-texture-headless",
            }
          : clone(c.command),
      ) as unknown as typeof item.commands;
    }
    t.meta.unsupported = entries.map(([name, op]) => ({
      op,
      item: expected.creation_order.indexOf(name) + 2,
      reason: "canvas-texture-headless",
    })) as unknown as typeof t.meta.unsupported;
  });
  return { ...good, result_class: "unsupported" };
}

function canvasCases(expected: Gate5Expected): void {
  const good = syntheticCanvas(expected);
  passes(
    "capture-canvas (D11)",
    evaluateCaptureCanvas(expected, good).problems,
  );
  const plain = syntheticCapture(expected);
  fails(
    "capture-canvas (RID() drawn as tex null)",
    evaluateCaptureCanvas(expected, { ...plain, result_class: "unsupported" })
      .problems,
    "unsupported entries",
  );
  const textured = clone(syntheticCanvas(expected));
  // G3 (TEX16) must stay a command; a refusal of it is a wrong D11 rule.
  commandsOf(expected, textured.full, 0, "PG")[2] = {
    op: "unsupported",
    name: "canvas_item_add_polygon",
    reason: "canvas-texture-headless",
  };
  fails(
    "capture-canvas (a textured polygon refused)",
    evaluateCaptureCanvas(expected, textured).problems,
    "step 0 PG",
  );
}

type DItem = DeriveInput["items"][number];
const ditem = (
  id: number,
  commands: unknown[],
  extra: Partial<DItem> = {},
): DItem =>
  ({
    id,
    children: [],
    visible: true,
    visibility_layer: 1,
    clip: false,
    custom_rect: false,
    custom_rect_rect: [0, 0, 0, 0],
    xform: [1, 0, 0, 1, 0, 0],
    modulate: [1, 1, 1, 1],
    commands,
    ...extra,
  }) as DItem;

/** One flat state per step: every item top-level under its final transform, CG clipping with its
 * 64x48 custom rect, every item's expected /4 commands. */
function syntheticStates(expected: Gate5Expected): {
  states: Map<number, DeriveInput>;
  ids: Map<string, number>;
} {
  const byStep = expectedCommandsByStep(expected, TEX_IDS);
  const ids = new Map(expected.creation_order.map((n, j) => [n, j + 2]));
  const states = new Map<number, DeriveInput>();
  for (const s of expected.steps)
    states.set(s.step, {
      canvases: [
        {
          id: 1,
          role: "root",
          items: s.items.map((i) => ids.get(i.name) ?? 0),
          xform: [1, 0, 0, 1, 0, 0],
        },
      ],
      items: s.items.map((i) =>
        ditem(
          ids.get(i.name) ?? 0,
          (byStep.get(s.step)?.get(i.name) ?? []).map((c) => c.command),
          i.name === "CG"
            ? {
                clip: true,
                custom_rect: true,
                custom_rect_rect: [0, 0, 64, 48],
                xform: i.xform,
              }
            : { xform: i.xform },
        ),
      ),
    });
  return { states, ids };
}

function clipDeriveCases(expected: Gate5Expected): void {
  // D9: replaced, not composed; the rect of every later command goes through the last one.
  const rect = (r: number[]) => ({
    op: "add_rect",
    aa: false,
    rect: r,
    color: [1, 1, 1, 1],
  });
  const st = (t: number[]) => ({ op: "add_set_transform", transform: t });
  const r = itemRect(
    ditem(1, [
      rect([0, 0, 10, 10]),
      st([2, 0, 0, 2, 32, 0]),
      rect([2, 2, 8, 8]),
      st([1, 0, 0, 1, 0, 40]),
      rect([0, 0, 4, 4]),
    ]),
  );
  assert(
    "clip-derive D9: rects after a set_transform go through it, the second replaces the first",
    JSON.stringify(r) === JSON.stringify([0, 0, 52, 44]),
    JSON.stringify(r),
  );
  const composed = itemRect(
    ditem(1, [
      st([2, 0, 0, 2, 32, 0]),
      st([1, 0, 0, 1, 0, 40]),
      rect([0, 0, 4, 4]),
    ]),
  );
  assert(
    "clip-derive D9: two set_transforms do not compose",
    JSON.stringify(composed) === JSON.stringify([0, 40, 4, 4]),
    JSON.stringify(composed),
  );
  const line = itemRect(
    ditem(1, [
      {
        op: "add_line",
        aa: false,
        from: [8, 20],
        to: [136, 20],
        colour: [1, 1, 1, 1],
        width: 2,
      },
    ]),
  );
  assert(
    "clip-derive: a wide line's rect is its quad",
    JSON.stringify(line) === JSON.stringify([8, 19, 128, 2]),
    JSON.stringify(line),
  );
  assert(
    "clip-derive: an antialiased line or a circle leaves the rect unknown",
    itemRect(
      ditem(1, [
        {
          op: "add_circle",
          aa: false,
          position: [0, 0],
          radius: 4,
          colour: [1, 1, 1, 1],
        },
      ]),
    ) === null,
  );
  // D10.
  const ci = (ignore: boolean) => ({ op: "add_clip_ignore", ignore });
  const cmds = [
    rect([0, 0, 1, 1]),
    ci(true),
    rect([0, 0, 1, 1]),
    st([1, 0, 0, 1, 0, 0]),
    rect([0, 0, 1, 1]),
    ci(false),
    rect([0, 0, 1, 1]),
  ];
  assert(
    "clip-derive D10: the commands between add_clip_ignore(true) and (false)",
    JSON.stringify(clipIgnoredCommands(ditem(1, cmds))) === "[2,4]",
  );
  const owned = deriveClipRects(
    {
      canvases: [
        { id: 1, role: "root", items: [1, 2], xform: [1, 0, 0, 1, 0, 0] },
      ],
      items: [
        ditem(1, cmds, {
          clip: true,
          custom_rect: true,
          custom_rect_rect: [0, 0, 10, 10],
        }),
        ditem(2, cmds),
      ],
    },
    [640, 360],
  );
  const o1 = owned.get(1);
  const o2 = owned.get(2);
  assert(
    "clip-derive D10: reported on an item with a clip owner, not on one without",
    typeof o1 === "object" &&
      JSON.stringify(o1.ignored) === "[2,4]" &&
      typeof o2 === "object" &&
      o2.ignored === undefined,
  );

  const { states, ids } = syntheticStates(expected);
  passes(
    "clip-rects-derived (expected.json's scissors and CG's clip-ignore span)",
    evaluateClipRectsDerived(expected, "synthetic", states, ids).problems,
  );
  const noIgnore = new Map(
    [...states].map(([k, v]) => [
      k,
      {
        ...v,
        items: v.items.map((i) =>
          i.id === ids.get("CG")
            ? {
                ...i,
                commands: i.commands.filter((c) => c.op !== "add_clip_ignore"),
              }
            : i,
        ),
      },
    ]),
  );
  fails(
    "clip-rects-derived (CG without its add_clip_ignore pair)",
    evaluateClipRectsDerived(expected, "synthetic", noIgnore, ids).problems,
    "clip-ignored commands",
  );
}

async function main(): Promise<void> {
  const expected = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate5", "expected.json"),
      "utf8",
    ),
  ) as Gate5Expected;
  const rasters = rastersOf(expected);
  rasterCases();
  selfConsistentCases(expected, rasters);
  imageCases(expected, rasters);
  censusCases(expected);
  captureCases(expected);
  geometryCommandCases(expected);
  legClassCases(expected);
  canvasCases(expected);
  clipDeriveCases(expected);
  console.log(
    `\nself-test-gate5: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
