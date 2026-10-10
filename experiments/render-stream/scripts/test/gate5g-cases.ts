// Gate 5g cases for scripts/test/self-test-gate5.ts: the nine-patch and stylebox fixture
// (fixtures/gate5-style) and lib/gate5g-checks.ts, each with a passing and a failing case.
//
// 1. Hand cases: `tile_fit` at NF's width (scale 6 over a 44 px centre, so the second repeat
//    starts at 4 + 44/6 px, typed in), and TabBar's flip (a box whose 6 px bottom border lands at
//    the top under set_transform (1, 0, 0, -1, 0, h)).
// 2. checkExpectedSelfConsistent on the committed style expected.json and on copies that lose the
//    theme exemption, the translucent shadow fill, or give a band ring alpha .75.
// 3. stylebox-lowering on the expected calls and on a dropped vertex and a missing item;
//    ignore-axis-prediction against the raster and on a wrong region set.
// 4. The /4 capture: an item that redraws with no call (the RichTextLabel losing focus) records an
//    empty list, so a capture that keeps the clip_ignore pair after step 4 fails; geometry-commands,
//    nine-patch-args (failing on NT drawn stretch), focus-clip-ignore, stylebox-lowering on the
//    wire, the census.
// 5. Image checks on raster-built frames: exact, delta 1 at the theme Panel, presence of the focus
//    box's rings, freshness of the resize.

import type { RecordingSummary } from "../lib/gate0-checks";
import type { Gate3CaptureEvaluation } from "../lib/gate3-checks";
import {
  checkExpectedSelfConsistent,
  evaluateCaptureLegClass5,
  evaluateExpectedImage5,
  evaluateFreshness5,
  evaluateGeometryHookCensus,
  evaluatePresence5,
  type Frame,
  type Shots,
} from "../lib/gate5-checks";
import type {
  Gate5Expected,
  Gate5Op,
  MeshShape,
  Rgba8,
} from "../lib/gate5-expected";
import {
  evaluateGeometryCommands,
  expectedCommandsByStep,
} from "../lib/gate5d-checks";
import {
  evaluateFocusClipIgnore,
  evaluateIgnoreAxisPrediction,
  evaluateNinePatchArgs,
  evaluateStyleboxLowering,
  expectedTriangleArrays,
  wireTriangleArrays,
} from "../lib/gate5g-checks";
import {
  type Gate5Raster,
  mapNinePatchAxis,
  rasterizeItems,
} from "../lib/geometry-raster";

type Assert = (name: string, ok: boolean, detail?: string) => void;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const problemsOf = (c: { passed: boolean; detail: string }) =>
  c.passed ? [] : [c.detail];

export function gate5gCases(
  assert: Assert,
  style: Gate5Expected,
  rasters: Map<number, Gate5Raster>,
): void {
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

  // 1. Hand cases.
  const edge = 1 / 16;
  const tileFit = (p: number) =>
    mapNinePatchAxis(p, 52, 16, 4, 4, "tile_fit", edge);
  // scale = max(1, floor(44 / 8 + 0.5)) = 6: a repeat is 44/6 = 7.333 px for 8 texels.
  assert(
    "g5g tile_fit at 52 px: pixel 4.5 samples texel 4 + 0.5 * 48/44",
    Math.abs(tileFit(4.5).texel - (4 + 24 / 44)) < 1e-9 && tileFit(4.5).centre,
  );
  assert(
    "g5g tile_fit at 52 px: the second repeat starts at 4 + 44/6 (pixel 11.5 samples texel 4 + 8 * (7.5 * 6/44 - 1))",
    Math.abs(tileFit(11.5).texel - (4 + 8 * ((7.5 * 6) / 44 - 1))) < 1e-9,
  );
  assert(
    "g5g tile_fit at 52 px: the end margin maps 1:1 from the texture's end (pixel 50.5 -> texel 14.5)",
    Math.abs(tileFit(50.5).texel - 14.5) < 1e-9 && !tileFit(50.5).centre,
  );
  const tileAt52 = mapNinePatchAxis(11.5, 52, 16, 4, 4, "tile", edge);
  assert(
    "g5g tile at 52 px differs from tile_fit at pixel 11.5 (texel 11.5 vs 4.18)",
    Math.abs(tileAt52.texel - 11.5) < 1e-9,
  );
  const quad = (
    name: string,
    x: number,
    y: number,
    w: number,
    h: number,
    c: number[],
  ): MeshShape => ({
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
    colors: [c as [number, number, number, number]],
  });
  // A modulated nine-patch of TEXN drawn 1:1 (16x16, margins 4): pixel (8,8) samples cell A
  // (.4,.2,.8); times (.6,.6,1) that is (.24,.12,.8) = 61.2, 30.6, 204 -- off the UNORM8 levels,
  // so delta 1 (G5g measured 30.6 -> 30); the border (1,1,.6) times it is (.6,.6,.6), on a level,
  // exact. Unmodulated, both are exact.
  const ninePatch = (modulate: [number, number, number, number]) =>
    rasterizeItems({
      viewport: [16, 16],
      clear: [0, 0, 0, 255] as Rgba8,
      textures: { TEXN: style.textures.TEXN },
      opLists: {
        n: [
          {
            name: "n",
            kind: "nine_patch",
            rect: [0, 0, 16, 16],
            texture: "TEXN",
            margins: [4, 4, 4, 4],
            x_axis: "stretch",
            y_axis: "stretch",
            draw_center: true,
            modulate,
          },
        ],
      },
      items: [
        {
          name: "n",
          region: "r",
          xform: [1, 0, 0, 1, 0, 0],
          clip_px: null,
          ops: "n",
        },
      ],
    });
  const modulated = ninePatch([0.6, 0.6, 1, 1]);
  const plain = ninePatch([1, 1, 1, 1]);
  const i88 = 8 * 16 + 8;
  const i11 = 1 * 16 + 1;
  assert(
    "g5g modulated texel off the UNORM8 levels is delta 1, on a level exact; unmodulated exact",
    [...modulated.rgba.subarray(i88 * 4, i88 * 4 + 3)].join(",") ===
      "61,31,204" &&
      modulated.exact[i88] === 1 &&
      modulated.delta[i88] === 1 &&
      [...modulated.rgba.subarray(i11 * 4, i11 * 4 + 3)].join(",") ===
        "153,153,153" &&
      modulated.delta[i11] === 0 &&
      plain.delta[i88] === 0 &&
      plain.exact[i88] === 1,
    `${[...modulated.rgba.subarray(i88 * 4, i88 * 4 + 4)]} d${modulated.delta[i88]} / d${modulated.delta[i11]} / d${plain.delta[i88]}`,
  );
  // A 10x10 box: bottom border rows 7..9 red, the rest green; flipped, the red rows are 0..2.
  const ops: Gate5Op[] = [
    { op: "set_transform", transform: [1, 0, 0, -1, 0, 10] },
    quad("fill", 0, 0, 10, 7, [0, 1, 0, 1]),
    quad("border", 0, 7, 10, 3, [1, 0, 0, 1]),
    { op: "set_transform", transform: [1, 0, 0, 1, 0, 0] },
    quad("after", 12, 0, 2, 2, [0, 0, 1, 1]),
  ];
  const flipped = rasterizeItems({
    viewport: [16, 12],
    clear: [0, 0, 0, 255] as Rgba8,
    textures: {},
    opLists: { f: ops },
    items: [
      {
        name: "f",
        region: "r",
        xform: [1, 0, 0, 1, 0, 0],
        clip_px: null,
        ops: "f",
      },
    ],
  });
  const px = (x: number, y: number) =>
    [...flipped.rgba.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 3)].join(
      ",",
    );
  assert(
    "g5g flipped box: the bottom border lands at rows 0..2, the fill at 3..9, the reset applies to later shapes",
    px(5, 0) === "255,0,0" &&
      px(5, 2) === "255,0,0" &&
      px(5, 3) === "0,255,0" &&
      px(5, 9) === "0,255,0" &&
      px(12, 0) === "0,0,255" &&
      px(12, 11) === "0,0,0",
    `${px(5, 0)} ${px(5, 2)} ${px(5, 3)} ${px(5, 9)} ${px(12, 0)} ${px(12, 11)}`,
  );

  // 2. expected-self-consistent on the style fixture.
  passes(
    "g5g expected-self-consistent",
    problemsOf(checkExpectedSelfConsistent(style, rasters)),
  );
  const noTheme = clone(style);
  noTheme.theme_shapes = [];
  fails(
    "g5g expected-self-consistent (the theme Panel not exempt)",
    problemsOf(checkExpectedSelfConsistent(noTheme, rasters)),
    "DP.fill",
  );
  const noTranslucent = clone(style);
  noTranslucent.translucent_shapes = [];
  fails(
    "g5g expected-self-consistent (the shadow fill not translucent)",
    problemsOf(checkExpectedSelfConsistent(noTranslucent, rasters)),
    "SS.shadow_fill",
  );
  const badRing = clone(style);
  const ring = badRing.op_lists["SR@0"].find(
    (op) => "name" in op && op.name === "SR.aa_fill",
  ) as MeshShape;
  ring.colors[1] = [1, 0.4, 0.4, 0.75];
  fails(
    "g5g expected-self-consistent (a ring alpha .75)",
    problemsOf(checkExpectedSelfConsistent(badRing, rasters)),
    "SR.aa_fill",
  );

  // 3. stylebox-lowering and ignore-axis-prediction.
  const arrays = expectedTriangleArrays(style);
  const lowering = evaluateStyleboxLowering(style, arrays);
  passes("g5g stylebox-lowering (expected calls)", lowering.problems);
  assert(
    "g5g stylebox-lowering sees 12 arrays over 8 boxes",
    arrays.length === 12 && Object.keys(lowering.seen).length === 8,
    JSON.stringify(lowering.seen),
  );
  const dropped = clone(arrays);
  const sr = dropped.find((a) => a.item === "SR");
  if (sr) {
    sr.points.pop();
    sr.colors.pop();
    sr.uvs.pop();
  }
  fails(
    "g5g stylebox-lowering (a vertex dropped)",
    evaluateStyleboxLowering(style, dropped).problems,
    "SR: 107 vertices",
  );
  fails(
    "g5g stylebox-lowering (no focus box drawn)",
    evaluateStyleboxLowering(
      style,
      arrays.filter((a) => a.item !== "RT"),
    ).problems,
    "RT: no triangle array",
  );
  passes(
    "g5g ignore-axis-prediction",
    evaluateIgnoreAxisPrediction(style, rasters).problems,
  );
  const wrongAxis = clone(style);
  const pred = wrongAxis.predictions["sabotage-style-receiver-ignore-axis"];
  if (pred?.regions) pred.regions.NS = [0];
  fails(
    "g5g ignore-axis-prediction (NS predicted)",
    evaluateIgnoreAxisPrediction(wrongAxis, rasters).problems,
  );

  // 4. The /4 capture: an item that redraws with no call records an empty list, so a capture that
  // keeps the clip_ignore pair after focus is lost fails; geometry-commands, nine-patch-args, the
  // focus pair, stylebox-lowering on the wire; the census.
  const byStep = expectedCommandsByStep(style, STYLE_TEX_IDS);
  assert(
    "g5g expected commands: RT carries the clip_ignore pair around its focus box until step 3, nothing from step 4",
    JSON.stringify(
      byStep
        .get(3)
        ?.get("RT")
        ?.map((c) => c.command?.op),
    ) ===
      JSON.stringify([
        "add_clip_ignore",
        "add_triangle_array",
        "add_clip_ignore",
      ]) &&
      JSON.stringify(byStep.get(4)?.get("RT")) === "[]" &&
      JSON.stringify(byStep.get(9)?.get("RT")) === "[]" &&
      JSON.stringify(byStep.get(0)?.get("RT_VScrollBar")) === "[]",
  );
  const capture = syntheticStyleCapture(style);
  passes(
    "g5g leg-class-capture (/4 success)",
    evaluateCaptureLegClass5(style, capture).problems,
  );
  const rtIndex = style.creation_order.indexOf("RT");
  const kept = syntheticStyleCapture(style);
  kept.full.transactions[4].meta.items[rtIndex].commands = clone(
    kept.full.transactions[3].meta.items[rtIndex].commands,
  );
  fails(
    "g5g leg-class-capture (the clip_ignore pair kept after focus is lost)",
    evaluateCaptureLegClass5(style, kept).problems,
    "step 4 RT",
  );
  const sinks = (c: typeof capture) => [{ label: "full", recording: c.full }];
  passes(
    "g5g geometry-commands",
    evaluateGeometryCommands(style, sinks(capture)).problems,
  );
  passes(
    "g5g nine-patch-args",
    evaluateNinePatchArgs(style, sinks(capture)).problems,
  );
  const tiled = syntheticStyleCapture(style);
  const ntIndex = style.creation_order.indexOf("NT");
  const nt = tiled.full.transactions[0].meta.items[ntIndex].commands[0] as {
    x_axis: string;
  };
  nt.x_axis = "stretch";
  fails(
    "g5g nine-patch-args (NT's x axis stretch)",
    evaluateNinePatchArgs(style, sinks(tiled)).problems,
    "step 0 NT",
  );
  const focus = evaluateFocusClipIgnore(style, capture.full);
  passes("g5g focus-clip-ignore", focus.problems);
  assert(
    "g5g focus-clip-ignore sees the pair at steps 0..3",
    focus.steps.join() === "0,1,2,3",
    focus.steps.join(),
  );
  fails(
    "g5g focus-clip-ignore (the pair kept at step 4)",
    evaluateFocusClipIgnore(style, kept.full).problems,
    "steps {0,1,2,3,4}",
  );
  passes(
    "g5g stylebox-lowering (wire)",
    evaluateStyleboxLowering(style, wireTriangleArrays(style, capture.full))
      .problems,
  );
  const counts: Record<string, number> = {
    ...style.hook_census,
    texture_2d_create: 2,
  };
  const planned = [...Object.keys(style.hook_census), "texture_2d_create"];
  passes(
    "g5g geometry-hook-census",
    evaluateGeometryHookCensus(style, { counts, hooks_planned: planned })
      .problems,
  );
  fails(
    "g5g geometry-hook-census (a second focus redraw)",
    evaluateGeometryHookCensus(style, {
      counts: { ...counts, canvas_item_add_triangle_array: 13 },
      hooks_planned: planned,
    }).problems,
    "add_triangle_array",
  );

  // 5. Image checks on raster-built frames (band areas painted magenta).
  const shots: Shots = new Map();
  for (const s of style.steps) {
    const r = rasters.get(s.step) as Gate5Raster;
    const rgba = new Uint8Array(r.rgba);
    for (const c of r.shapes)
      if (c.band_class)
        for (const i of c.area)
          if (!r.exact[i]) rgba.set([255, 0, 255, 255], i * 4);
    shots.set(s.step, { width: r.width, height: r.height, rgba });
  }
  const copyShots = (): Shots => {
    const out: Shots = new Map();
    for (const [k, f] of shots)
      out.set(k, f ? { ...f, rgba: new Uint8Array(f.rgba) } : null);
    return out;
  };
  passes(
    "g5g expected-image-reference",
    evaluateExpectedImage5(style, "ref", shots, rasters).problems,
  );
  const r0 = rasters.get(0) as Gate5Raster;
  const [dx0, dy0, dx1, dy1] = style.regions.DP;
  let panelPx = -1;
  for (let y = dy0; y < dy1 && panelPx < 0; y++)
    for (let x = dx0; x < dx1; x++) {
      const i = y * 640 + x;
      if (r0.exact[i] && r0.delta[i] === 1) {
        panelPx = i;
        break;
      }
    }
  const bumped = (by: number) => {
    const s = copyShots();
    (s.get(0) as Frame).rgba[panelPx * 4] += by;
    return s;
  };
  passes(
    "g5g expected-image-reference (the theme Panel's blend off by 1)",
    evaluateExpectedImage5(style, "ref", bumped(1), rasters).problems,
  );
  fails(
    "g5g expected-image-reference (the theme Panel's blend off by 2)",
    evaluateExpectedImage5(style, "ref", bumped(2), rasters).problems,
    "DP",
  );
  passes(
    "g5g presence-reference",
    evaluatePresence5(style, "ref", shots, rasters).problems,
  );
  const noFocus = copyShots();
  for (const c of r0.shapes)
    if (c.item === "RT")
      for (let k = 0; k < c.area.length; k++)
        (noFocus.get(0) as Frame).rgba.set(
          c.underlay.subarray(k * 4, k * 4 + 4),
          c.area[k] * 4,
        );
  fails(
    "g5g presence-reference (no focus box)",
    evaluatePresence5(style, "ref", noFocus, rasters).problems,
    "RT/RT.border",
  );
  passes(
    "g5g freshness-reference",
    evaluateFreshness5(style, "ref", shots).problems,
  );
  const stale = copyShots();
  stale.set(2, stale.get(1) ?? null);
  fails(
    "g5g freshness-reference (no resize at step 2)",
    evaluateFreshness5(style, "ref", stale).problems,
    "NF did not change",
  );
}

/** Wire ids the synthetic recording gives the fixture texture (the hue strip is 1). */
const STYLE_TEX_IDS = new Map([["TEXN", 2]]);

/** A /4 recording whose settle transactions carry exactly expected.json's calls as commands (ids
 * 2.. by creation order), the two textures and no unsupported entry. */
function syntheticStyleCapture(
  expected: Gate5Expected,
): Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full"> {
  const byStep = expectedCommandsByStep(expected, STYLE_TEX_IDS);
  const textures = [
    { id: 1, kind: "image", status: "ok", width: 800, height: 6 },
    { id: 2, kind: "image", status: "ok", width: 16, height: 16 },
  ];
  const transactions = expected.steps.map((s, k) => ({
    meta: {
      seq: k + 1,
      frame: s.settle_frame,
      items: expected.creation_order.map((name, j) => ({
        id: j + 2,
        commands: clone(
          (byStep.get(s.step)?.get(name) ?? []).map((c) => c.command),
        ),
      })),
      unsupported: [],
      textures,
    },
    sha256: "",
  }));
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
