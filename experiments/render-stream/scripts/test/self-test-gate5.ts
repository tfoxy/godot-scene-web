#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 5b: lib/geometry-raster.ts on hand cases and the g5b checks of
// lib/gate5-checks.ts on synthetic values, each with a passing and a failing case.
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
// 4. geometry-hook-census and the capture's typed-command classification on synthetic counters and
//    recordings.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RecordingSummary } from "../lib/gate0-checks";
import type { Gate3CaptureEvaluation } from "../lib/gate3-checks";
import {
  checkExpectedSelfConsistent,
  compareLegs5,
  evaluateCaptureTyped,
  evaluateExpectedImage5,
  evaluateFreshness5,
  evaluateGeometryHookCensus,
  evaluatePresence5,
  type Frame,
  rastersOf,
  type Shots,
  typedCommandsByStep,
} from "../lib/gate5-checks";
import type {
  Gate5Expected,
  Gate5Item,
  Gate5Op,
  Gate5Texture,
  Rgba8,
} from "../lib/gate5-expected";
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

/** A recording whose settle transactions carry exactly the typed commands, ids 2.. by creation
 * order, and one unsupported-op entry per typed op. */
function syntheticCapture(
  expected: Gate5Expected,
  hooked: Set<string>,
): Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full"> {
  const typed = typedCommandsByStep(expected, hooked);
  const transactions = expected.steps.map((s, k) => {
    const items = expected.creation_order.map((name, j) => ({
      id: j + 2,
      commands: (typed.get(s.step)?.get(name) ?? []).map((c) => ({ ...c })),
    }));
    const unsupported = [
      ...new Set(
        items.flatMap((i) =>
          i.commands.filter((c) => c?.op === "unsupported").map((c) => c?.name),
        ),
      ),
    ].map((op) => ({ op, item: 2, reason: "unsupported-op" }));
    return {
      meta: { seq: k + 1, frame: s.settle_frame, items, unsupported },
      sha256: "",
    };
  });
  return {
    result_class: "unsupported",
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

function captureCases(expected: Gate5Expected): void {
  const hooked = new Set([
    ...Object.keys(expected.hook_census).filter(
      (op) => op !== "canvas_item_add_multiline",
    ),
  ]);
  const planned = [...hooked];
  const good = syntheticCapture(expected, hooked);
  passes(
    "leg-class-capture",
    evaluateCaptureTyped(expected, good, planned).problems,
  );
  const g5a = syntheticCapture(
    expected,
    new Set([...hooked, "canvas_item_add_multiline"]),
  );
  passes(
    "leg-class-capture (calibrator 7 types multiline)",
    evaluateCaptureTyped(expected, g5a, [
      ...planned,
      "canvas_item_add_multiline",
    ]).problems,
  );
  fails(
    "leg-class-capture (multiline hooked but not typed)",
    evaluateCaptureTyped(expected, good, [
      ...planned,
      "canvas_item_add_multiline",
    ]).problems,
    "unsupported ops",
  );
  const success = { ...good, result_class: "success" as const };
  fails(
    "leg-class-capture (class success)",
    evaluateCaptureTyped(expected, success, planned).problems,
    "class success",
  );
  const wrongRect = clone(syntheticCapture(expected, hooked));
  const st =
    wrongRect.full.transactions[0].meta.items[
      expected.creation_order.indexOf("ST")
    ];
  (st.commands[0] as { rect: number[] }).rect = [4, 4, 24, 17];
  fails(
    "leg-class-capture (an add_rect argument off)",
    evaluateCaptureTyped(
      expected,
      { ...wrongRect, full: wrongRect.full },
      planned,
    ).problems,
    "step 0 ST",
  );
  const reordered = clone(syntheticCapture(expected, hooked));
  const cg =
    reordered.full.transactions[0].meta.items[
      expected.creation_order.indexOf("CG")
    ];
  cg.commands.reverse();
  fails(
    "leg-class-capture (commands out of order)",
    evaluateCaptureTyped(
      expected,
      { ...reordered, full: reordered.full },
      planned,
    ).problems,
    "step 0 CG",
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
  console.log(
    `\nself-test-gate5: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
