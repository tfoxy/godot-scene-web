#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 6a: the g6a checks of lib/gate6a-checks.ts on the committed
// fixtures/gate6-scene/expected.json and on synthetic frames, oracle lines, wire states and hook
// logs, each with a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate6.ts
//
// 1. evaluateExpectedSelfConsistent on the committed expected.json (both variants), then on broken
//    copies (an off-grid colour, a wrong `fresh`, overlapping regions, a phase off D6's formula).
// 2. The rasterizer's undecided box (geometry-raster.ts UndecidedShape): pixels inside become
//    undecided, a later opaque rect decides them again, a translucent one does not.
// 3. diffFrames6, compareShots6 and evaluatePixelVerdict: equal frames are success; a sabotage
//    whose mismatching regions equal the prediction passes, an extra or a missing region fails; a
//    difference inside HU is never compared.
// 4. evaluateOracle6 on oracle lines made from expected.json (passes), with one value off (fails),
//    and with the repeat's bytes differing (fails).
// 5. evaluateAtlasParity6 and evaluateLineEditGeometry on synthetic wire states.
// 6. evaluateSceneCensus on a hook log synthesized from the census (passes), then with TEXA's update
//    missing, a hash off, an extra mesh call or the HUD hidden one frame too long (each fails).
// 7. evaluateUnsupportedClass and evaluateNoTies6.
// 8. Gate 6h: test/self-test-gate6h.ts on the committed fixtures/gate6-hd/expected.json.
// 9. Group g6l: self-test-gate6l.ts's cases for lib/gate6l-checks.ts.
// 10. Group g6s: self-test-gate6s.ts's cases for lib/gate6s-checks.ts.
// 11. Gate 6b: test/self-test-gate6b.ts (the pure g6b checks) on synthetic values and the HD file.
// 12. Group g6c: self-test-gate6c.ts's cases for lib/gate6c-checks.ts.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RecordingSummary } from "../lib/gate0-checks";
import type { ResourceLine } from "../lib/gate2-checks";
import {
  type Gate6Expected,
  rasterOfShot,
  refusedView,
} from "../lib/gate6-expected";
import {
  compareShots6,
  diffFrames6,
  evaluateAtlasParity6,
  evaluateExpectedSelfConsistent,
  evaluateLineEditGeometry,
  evaluateNoTies6,
  evaluateOracle6,
  evaluatePixelVerdict,
  evaluateSceneCensus,
  evaluateUnsupportedClass,
  type Frame6,
  type OracleLine6,
  type OracleLog6,
  type Shots6,
} from "../lib/gate6a-checks";
import type { Gate6HdExpected } from "../lib/gate6h-checks";
import type { Wire5Tx } from "../lib/gate55-wire";
import { rasterizeItems } from "../lib/geometry-raster";
import { selfTestGate6b } from "./self-test-gate6b";
import { selfTestGate6c } from "./self-test-gate6c";
import { selfTestGate6h } from "./self-test-gate6h";
import { selfTestG6l } from "./self-test-gate6l";
import { selfTestG6s } from "./self-test-gate6s";

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

function rasters(e: Gate6Expected) {
  const out = new Map<string, ReturnType<typeof rasterOfShot>>();
  for (const s of e.shots) out.set(s.id, rasterOfShot(e, s));
  return out;
}

function frame(w: number, h: number, fill: number[]): Frame6 {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(fill, i * 4);
  return { width: w, height: h, rgba };
}

function oracleLines(e: Gate6Expected): OracleLine6[] {
  return e.steps.map((s) => ({
    schema: "render-stream-gate6-oracle/1",
    step: s.step,
    frame: s.settle_frame,
    oversampling: s.oracle.oversampling,
    scroll: {
      v_scroll: s.oracle.v_scroll,
      content_position: s.oracle.content_position,
    },
    canvas_layers: [
      {
        name: "HUD",
        layer: s.oracle.hud.layer,
        sublayer: 30,
        visible: s.oracle.hud.visible,
      },
    ],
    materials: {
      SM: {
        shader_sha256: s.oracle.sm.shader_sha256,
        params: [
          { name: "phase", type: "int", value: s.oracle.sm.phase },
          { name: "tint", type: "color", value: s.oracle.sm.tint },
        ],
      },
      CM: { blend_mode: s.oracle.cm_blend_mode },
    },
    pb_value: s.oracle.pb_value,
    rich_text: (s.oracle as unknown as { rich_text: OracleLine6["rich_text"] })
      .rich_text,
    line_edit: {
      text: "edit me",
      text_height: 23,
      selection: [[4, 4, 30, 23]],
      carets: [
        [4, 22, 1, 0],
        [4, 4, 1, 23],
      ],
    },
    pages: [
      {
        font_key: "default",
        size: 16,
        outline: 0,
        index: 0,
        width: 256,
        height: 256,
        format: "LA8",
        sha256: "a".repeat(64),
      },
    ],
  }));
}

function log(lines: OracleLine6[], leg = "reference"): OracleLog6 {
  return {
    leg,
    path: `${leg}/oracle.jsonl`,
    text: lines.map((l) => JSON.stringify(l)).join("\n"),
    lines,
    problem: null,
  };
}

async function main(): Promise<void> {
  const e = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate6-scene", "expected.json"),
      "utf8",
    ),
  ) as Gate6Expected;
  const r = refusedView(e);

  // 1. Self-consistency.
  const ra = rasters(e);
  passes(
    "expected-self-consistent (default)",
    evaluateExpectedSelfConsistent(e, ra).problems,
  );
  passes(
    "expected-self-consistent (refused)",
    evaluateExpectedSelfConsistent(r, rasters(r)).problems,
  );
  {
    const b = clone(e);
    const key = Object.keys(b.op_lists).find((k) =>
      k.startsWith("CD@"),
    ) as string;
    const op = b.op_lists[key].find(
      (o) => "kind" in o && o.kind === "mesh",
    ) as { colors: number[][] };
    op.colors[0] = [0.5, 0.5, 0.5, 1];
    fails(
      "an off-grid CD colour",
      evaluateExpectedSelfConsistent(b, rasters(b)).problems,
      "off the grid",
    );
  }
  {
    const b = clone(e);
    b.steps[4].fresh.TR = true;
    fails(
      "TR fresh at step 4",
      evaluateExpectedSelfConsistent(b, ra).problems,
      "TR fresh=true",
    );
  }
  {
    const b = clone(e);
    b.shots[0].regions.TR = [380, 8, 456, 72];
    fails(
      "TR overlapping RT",
      evaluateExpectedSelfConsistent(b, ra).problems,
      "overlap",
    );
  }
  {
    const b = clone(e);
    b.steps[3].oracle.sm.phase = (b.steps[3].oracle.sm.phase + 1) % 6;
    fails(
      "SM phase off D6's formula",
      evaluateExpectedSelfConsistent(b, ra).problems,
      "SM phase",
    );
  }

  // 2. The undecided box.
  {
    const scene = (ops: string[]) =>
      rasterizeItems({
        viewport: [8, 8],
        clear: [0, 0, 0, 255],
        textures: {},
        opLists: {
          u: [
            {
              name: "u",
              kind: "undecided",
              rect: [2, 2, 4, 4],
              content: "text",
            },
          ],
          o: [
            {
              name: "o",
              kind: "mesh",
              vertices: [
                [0, 0],
                [8, 0],
                [8, 8],
                [0, 8],
              ],
              triangles: [
                [0, 1, 2],
                [0, 2, 3],
              ],
              colors: [[1, 0, 0, 1]],
            },
          ],
          t: [
            {
              name: "t",
              kind: "mesh",
              vertices: [
                [0, 0],
                [8, 0],
                [8, 8],
                [0, 8],
              ],
              triangles: [
                [0, 1, 2],
                [0, 2, 3],
              ],
              colors: [[1, 0, 0, 0.6]],
            },
          ],
        },
        items: ops.map((k) => ({
          name: k,
          region: "R",
          xform: [1, 0, 0, 1, 0, 0],
          clip_px: null,
          ops: k,
        })),
      });
    const a = scene(["u"]);
    assert(
      "undecided box: inside undecided",
      a.exact[3 * 8 + 3] === 0 &&
        a.exact[1 * 8 + 1] === 1 &&
        a.exact[5 * 8 + 5] === 0 &&
        a.exact[6 * 8 + 6] === 1,
    );
    const b = scene(["u", "o"]);
    assert(
      "undecided box: an opaque rect decides it again",
      b.exact[3 * 8 + 3] === 1 && b.rgba[(3 * 8 + 3) * 4] === 255,
    );
    const c = scene(["u", "t"]);
    assert(
      "undecided box: a translucent rect does not",
      c.exact[3 * 8 + 3] === 0 && c.exact[0] === 1,
    );
    assert("undecided box: covers nothing for presence", a.shapes.length === 0);
  }

  // 3. Pixel verdicts.
  {
    const shot = { ...e.shots[1], regions: e.shots[1].regions };
    const ref = frame(640, 360, [51, 51, 51, 255]);
    const same = frame(640, 360, [51, 51, 51, 255]);
    const d0 = diffFrames6(ref, same, shot.regions, new Set(["HU"]));
    assert(
      "diffFrames6: equal frames",
      d0.mismatched === 0 &&
        d0.compared === 640 * 360 - (624 - 400) * (116 - 84),
    );
    const hu = frame(640, 360, [51, 51, 51, 255]);
    hu.rgba.set([255, 0, 0, 255], (90 * 640 + 450) * 4);
    const d1 = diffFrames6(ref, hu, shot.regions, new Set(["HU"]));
    assert(
      "diffFrames6: a difference inside HU is not compared",
      d1.mismatched === 0 && d1.excluded.HU === 1,
    );
    const tr = frame(640, 360, [51, 51, 51, 255]);
    tr.rgba.set([255, 0, 0, 255], (20 * 640 + 400) * 4);
    tr.rgba.set([255, 0, 0, 255], (2 * 640 + 2) * 4);
    const refs: Shots6 = new Map([[shot.id, ref]]);
    const legs: Shots6 = new Map([[shot.id, tr]]);
    const diffs = compareShots6([shot], refs, legs, new Set(["HU"]));
    passes(
      "pixel verdict: the predicted sabotage regions",
      evaluatePixelVerdict(diffs, "pixel-mismatch", { [shot.id]: ["BG", "TR"] })
        .problems,
    );
    fails(
      "pixel verdict: one predicted region missing",
      evaluatePixelVerdict(diffs, "pixel-mismatch", {
        [shot.id]: ["BG", "TR", "NP"],
      }).problems,
      "predicted",
    );
    fails(
      "pixel verdict: an unpredicted region",
      evaluatePixelVerdict(diffs, "pixel-mismatch", { [shot.id]: ["TR"] })
        .problems,
      "predicted",
    );
    fails(
      "pixel verdict: an honest leg that differs",
      evaluatePixelVerdict(diffs, "success", undefined).problems,
      "differ",
    );
    passes(
      "pixel verdict: an honest leg equal outside HU",
      evaluatePixelVerdict(
        compareShots6([shot], refs, new Map([[shot.id, hu]]), new Set(["HU"])),
        "success",
        undefined,
      ).problems,
    );
    fails(
      "pixel verdict: a missing shot",
      evaluatePixelVerdict(
        compareShots6(
          [shot],
          refs,
          new Map([[shot.id, null]]),
          new Set(["HU"]),
        ),
        "success",
        undefined,
      ).problems,
      "missing",
    );
  }

  // 4. The oracle.
  {
    const lines = oracleLines(e);
    passes(
      "oracle lines from expected.json",
      evaluateOracle6(e, [log(lines), log(lines, "repeat")]).problems,
    );
    const off = clone(lines);
    off[5].scroll.v_scroll = 75;
    fails(
      "oracle v_scroll off by one",
      evaluateOracle6(e, [log(off)]).problems,
      "v_scroll",
    );
    const tint = clone(lines);
    (tint[4].materials.SM.params[1].value as number[])[1] = 0.5;
    fails(
      "oracle SM tint off",
      evaluateOracle6(e, [log(tint)]).problems,
      "SM tint",
    );
    const rt = clone(lines);
    rt[0].rich_text.line_offsets[3] = 109;
    fails(
      "oracle RT line offset off the measured line height",
      evaluateOracle6(e, [log(rt)]).problems,
      "RT line offsets",
    );
    const repeat = clone(lines);
    repeat[2].pb_value = lines[2].pb_value;
    const repeatLog = log(repeat, "repeat");
    repeatLog.text = `${repeatLog.text} `;
    fails(
      "oracle repeat bytes differ",
      evaluateOracle6(e, [log(lines), repeatLog]).problems,
      "differ",
    );
  }

  // 5. Atlas parity and the LineEdit's rects.
  {
    const lines = oracleLines(e);
    const tex = (id: number, hash: string, format = "LA8") => ({
      id,
      origin: "created" as const,
      kind: "image" as const,
      status: "ok" as const,
      reason: null,
      version: 1,
      hash,
      format,
      width: 256,
      height: 256,
      mipmaps: false,
      payload_bytes: 1,
      canvas: null,
    });
    const wire = (
      textures: ReturnType<typeof tex>[],
      leRects: { rect: number[]; color: number[] }[] = [],
    ) => ({
      path: "w",
      transactions: e.steps.map(
        (s) =>
          ({
            seq: s.settle_frame,
            frame: s.settle_frame,
            state: {
              textures,
              items: [
                {
                  id: 41,
                  commands: leRects.map((c) => ({
                    op: "add_rect",
                    aa: false,
                    ...c,
                  })),
                },
              ],
            },
          }) as unknown as Wire5Tx,
      ),
    });
    passes(
      "atlas parity",
      evaluateAtlasParity6(
        e,
        log(lines),
        wire([tex(5, "a".repeat(64)), tex(1, "b".repeat(64), "RGBA8")]),
      ).problems,
    );
    fails(
      "atlas parity: the page missing on the wire",
      evaluateAtlasParity6(e, log(lines), wire([tex(5, "c".repeat(64))]))
        .problems,
      "is the hash of 0",
    );
    fails(
      "atlas parity: an LA8 wire texture no oracle page",
      evaluateAtlasParity6(
        e,
        log(lines),
        wire([tex(5, "a".repeat(64)), tex(6, "d".repeat(64))]),
      ).problems,
      "no oracle page",
    );
    const sel = { rect: [4, 4, 30, 23], color: [0.5, 0.5, 0.5, 1] };
    const c0 = {
      rect: [4, 22, 1, 0],
      color: [0.95, 0.95, 0.95, 1].map(Math.fround),
    };
    const c1 = {
      rect: [4, 4, 1, 23],
      color: [0.95, 0.95, 0.95, 1].map(Math.fround),
    };
    passes(
      "line-edit geometry",
      evaluateLineEditGeometry(e, log(lines), wire([], [sel, c0, c1]), 41)
        .problems,
    );
    fails(
      "line-edit geometry: the selection one pixel short",
      evaluateLineEditGeometry(
        e,
        log(lines),
        wire([], [{ ...sel, rect: [4, 4, 29, 23] }, c0, c1]),
        41,
      ).problems,
      "selection",
    );
    fails(
      "line-edit geometry: a caret missing",
      evaluateLineEditGeometry(e, log(lines), wire([], [sel, c1]), 41).problems,
      "caret",
    );
  }

  // 6. The census.
  {
    const c = e.hook_census;
    const base = {
      t_us: 0,
      thread: "main",
      by_id: null,
      rid: null,
      version: null,
      status: "ok",
      reason: null,
      width: null,
      height: null,
      mipmaps: null,
      data_bytes: null,
      payload_bytes: null,
      hash: null,
      copy_ns: null,
      hash_ns: null,
      conn: null,
      http_status: null,
      target: null,
      ref_id: null,
      value: null,
      layer: null,
      root_viewport: null,
      surface: null,
      buffer: null,
      offset: null,
      bytes: null,
      primitive: null,
      vertex_count: null,
      index_count: null,
      outcome: "applied",
      mode: null,
      source: null,
      builtin: null,
      uses: null,
      scan_ns: null,
      param: null,
      type: null,
      n: null,
      decode_ns: null,
      format: null,
    } as const;
    const L = (o: Partial<ResourceLine>): ResourceLine =>
      ({
        ...base,
        frame: 1,
        op: "",
        id: null,
        kind: null,
        ...o,
      }) as ResourceLine;
    const lines: ResourceLine[] = [];
    let id = 0;
    const fixtureId: Record<string, number> = {};
    for (const t of c.textures.filter((x) => x.op === "texture_2d_create")) {
      fixtureId[t.texture] = ++id;
      lines.push(
        L({
          frame: t.frame,
          op: t.op,
          id,
          kind: "image",
          hash: t.hash,
          format: "RGBA8",
          width: 64,
          height: 64,
        }),
      );
    }
    lines.push(
      L({
        frame: 1,
        op: "texture_2d_create",
        id: ++id,
        kind: "image",
        hash: "e".repeat(64),
        format: "RGBA8",
        width: 800,
        height: 6,
      }),
    );
    lines.push(
      L({
        frame: 1,
        op: "texture_2d_create",
        id: ++id,
        kind: "image",
        hash: "f".repeat(64),
        format: "LA8",
        width: 256,
        height: 256,
      }),
    );
    lines.push(
      L({
        frame: 9,
        op: "texture_2d_update",
        id,
        kind: "image",
        hash: "9".repeat(64),
        format: "LA8",
        width: 256,
        height: 256,
      }),
    );
    for (const t of c.textures.filter((x) => x.op !== "texture_2d_create"))
      lines.push(
        L({
          frame: t.frame,
          op: t.op,
          id: fixtureId[t.texture],
          kind: "image",
          hash: t.hash,
        }),
      );
    lines.push(L({ frame: 1, op: "mesh_create", id: 1, kind: "mesh" }));
    lines.push(
      L({
        frame: 1,
        op: "mesh_add_surface",
        id: 1,
        kind: "mesh",
        vertex_count: 16,
        index_count: 42,
      }),
    );
    for (
      let f = c.mesh.region_update_frames[0];
      f <= c.mesh.region_update_frames[1];
      f++
    )
      lines.push(
        L({
          frame: f,
          op: "mesh_surface_update_vertex_region",
          id: 1,
          kind: "mesh",
        }),
      );
    lines.push(
      L({
        frame: 1,
        op: "shader_create_from_code",
        id: 1,
        kind: "shader",
        hash: c.sm.shader_sha256,
      }),
    );
    lines.push(
      L({
        frame: 1,
        op: "material_create_from_shader",
        id: 1,
        kind: "material",
      }),
    );
    for (const [f, p] of c.sm.param_sets)
      lines.push(
        L({
          frame: f,
          op: "material_set_param",
          id: 1,
          kind: "material",
          param: p,
        }),
      );
    for (const [f, mode] of c.cm.shaders)
      lines.push(
        L({
          frame: f,
          op: "shader_set_code",
          id: 2,
          kind: "shader",
          builtin: {
            kind: "canvas_item_material",
            blend_mode: mode,
            light_mode: "normal",
            particles_animation: false,
          },
        }),
      );
    lines.push(
      L({ frame: 401, op: "free", id: fixtureId.TEXN, kind: "image" }),
    );
    lines.sort((a, b) => a.frame - b.frame);
    const counters = {
      counts: {
        canvas_create: 1,
        viewport_attach_canvas: 1,
        viewport_set_canvas_transform: 2,
        canvas_item_create: e.creation_order.length + e.created_later.length,
      },
    };
    const hidden = [...Array(10).keys()].map((k) => 81 + k);
    passes(
      "scene census from the census itself",
      evaluateSceneCensus(e, lines, counters, hidden).problems,
    );
    fails(
      "scene census: TEXA's update missing",
      evaluateSceneCensus(
        e,
        lines.filter(
          (l) => !(l.op === "texture_2d_update" && l.id === fixtureId.TEXA),
        ),
        counters,
        hidden,
      ).problems,
      "TEXA",
    );
    fails(
      "scene census: TEXB's hash off",
      evaluateSceneCensus(
        e,
        lines.map((l) =>
          l.id === fixtureId.TEXB && l.kind === "image"
            ? { ...l, hash: "0".repeat(64) }
            : l,
        ),
        counters,
        hidden,
      ).problems,
      "fixture texture creates",
    );
    fails(
      "scene census: an extra mesh call",
      evaluateSceneCensus(
        e,
        [
          ...lines,
          L({ frame: 50, op: "mesh_set_custom_aabb", id: 1, kind: "mesh" }),
        ],
        counters,
        hidden,
      ).problems,
      "unexpected mesh",
    );
    fails(
      "scene census: the HUD hidden one frame too long",
      evaluateSceneCensus(e, lines, counters, [...hidden, 91]).problems,
      "HUD panel hidden",
    );
  }

  // 7. Classification and ties.
  {
    const want: [string, string][] = [
      ["viewport_attach_canvas", "extra-canvas"],
    ];
    passes(
      "success class with nothing typed (render-stream/6's default scene)",
      evaluateUnsupportedClass(
        { result_class: "success", reasons: [] },
        [],
        [],
      ),
    );
    fails(
      "unsupported class where nothing is wanted",
      evaluateUnsupportedClass(
        { result_class: "unsupported", reasons: ["unsupported: x"] },
        ["viewport_set_canvas_stacking/canvas-stacking-tie"],
        [],
      ),
      "expected success",
    );
    passes(
      "a sabotage receiver: pixel-mismatch with nothing typed",
      evaluateUnsupportedClass(
        { result_class: "pixel-mismatch", reasons: ["pixel-mismatch: s"] },
        [],
        [],
        true,
      ),
    );
    passes(
      "unsupported class with exactly extra-canvas",
      evaluateUnsupportedClass(
        { result_class: "unsupported", reasons: ["unsupported: x"] },
        ["viewport_attach_canvas/extra-canvas"],
        want,
      ),
    );
    fails(
      "unsupported class with a second reason",
      evaluateUnsupportedClass(
        { result_class: "unsupported", reasons: [] },
        [
          "canvas_light_attach_to_canvas/canvas-light",
          "viewport_attach_canvas/extra-canvas",
        ],
        want,
      ),
      "unsupported",
    );
    fails(
      "a replay failure beside unsupported",
      evaluateUnsupportedClass(
        { result_class: "unsupported", reasons: ["replay-failure: status"] },
        ["viewport_attach_canvas/extra-canvas"],
        want,
      ),
      "other classes",
    );
    const item = (id: number, draw_index: number, rect: number[]) => ({
      id,
      origin: "created",
      parent: { kind: "canvas", id: 1 },
      children: [],
      visible: true,
      draw_index,
      z_index: 0,
      z_relative: true,
      behind: false,
      clip: false,
      custom_rect: false,
      visibility_layer: 1,
      texture_filter: "parent_node",
      texture_repeat: "parent_node",
      content_version: 1,
      xform: [1, 0, 0, 1, 0, 0],
      modulate: [1, 1, 1, 1],
      self_modulate: [1, 1, 1, 1],
      custom_rect_rect: [0, 0, 0, 0],
      commands: [{ op: "add_rect", aa: false, rect, color: [1, 1, 1, 1] }],
    });
    const rec = (indices: [number, number]) =>
      ({
        path: "r",
        present: true,
        errors: [],
        transactions: [
          {
            meta: {
              seq: 1,
              frame: 1,
              unsupported: [],
              canvases: [
                {
                  id: 1,
                  origin: "root",
                  role: "root",
                  attached: true,
                  items: [1, 20],
                  xform: [1, 0, 0, 1, 0, 0],
                },
              ],
              items: [
                item(1, indices[0], [0, 0, 640, 344]),
                item(20, indices[1], [600, 344, 16, 16]),
              ],
            },
          },
        ],
      }) as unknown as RecordingSummary;
    const ids = new Map([
      ["Scene", 1],
      ["TL", 20],
    ]);
    passes(
      "no ties, Scene and TL distinct at frame 1",
      evaluateNoTies6([{ label: "full", recording: rec([0, 1]) }], ids)
        .problems,
    );
    fails(
      "Scene and TL tied at frame 1",
      evaluateNoTies6([{ label: "full", recording: rec([0, 0]) }], ids)
        .problems,
      "tie",
    );
  }

  // 8. Gate 6h.
  const hdExpected = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate6-hd", "expected.json"),
      "utf8",
    ),
  ) as Gate6HdExpected;
  selfTestGate6h(assert, hdExpected);
  // 9. Group g6l (self-test-gate6l.ts).
  selfTestG6l(e, { assert, passes, fails });
  // 10. Group g6s (self-test-gate6s.ts).
  selfTestG6s({ assert, passes, fails });

  // 11. Gate 6b (test/self-test-gate6b.ts).
  selfTestGate6b(assert, hdExpected);

  // 12. Group g6c (self-test-gate6c.ts).
  selfTestGate6c({ assert, passes, fails });

  console.log(
    `\nself-test-gate6: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
