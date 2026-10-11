// Self-test for gate 6h (run from self-test-gate6.ts): the g6h checks of lib/gate6h-checks.ts on
// the committed fixtures/gate6-hd/expected.json and on synthetic frames, oracle lines and
// recordings, each with a passing and a failing case.
//
// 1. evaluateExpectedStaticHd on the committed expected.json, then on broken copies (overlapping
//    regions, an odd region edge, a phase off D6, the focus on two cells, a shared HUD layer).
// 2. hdItems: half composes scale(0.5) onto transforms and scissors and draws ops_half.
// 3. The half rasters of steps 0 and 1: nothing but BG panels, the clear colour or band outside
//    the regions (a painted BG pixel fails), and `fresh` as the rasters say (a flipped flag fails).
// 4. diffFramesHd, hudExclusionProblems and pixelVerdictHd on synthetic 960x540 frames: the HUD
//    panels inside HU pass, a missing panel fails, a difference outside HU is a mismatch.
// 5. The oracle checks on lines made from expected.json (pass), with a cell moved, the half
//    oversampling at 1, PB's value off and the repeat's bytes differing (each fails).
// 6. evaluateHdSession and evaluateNoTiesHd on synthetic recordings.

import type { RecordingSummary } from "../lib/gate0-checks";
import type { Frame6 } from "../lib/gate6a-checks";
import {
  changedRegionsHd,
  diffFramesHd,
  evaluateCellOracle,
  evaluateExpectedStaticHd,
  evaluateGridLayout,
  evaluateHdSession,
  evaluateNoTiesHd,
  evaluateOversampling,
  evaluateRasterOutsideHd,
  excludedRegionsHd,
  freshnessProblems,
  type Gate6HdExpected,
  type HdOracleLine,
  type HdOracleLog,
  hdItems,
  hudExclusionProblems,
  type Presentation,
  pixelVerdictHd,
  rasterOfShotHd,
  regionIndexHd,
  undecidedContentHd,
} from "../lib/gate6h-checks";

type Assert = (name: string, ok: boolean, detail?: string) => void;

export function selfTestGate6h(
  assert: Assert,
  expected: Gate6HdExpected,
): void {
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
        : `problems: ${problems.slice(0, 2).join(" | ")}`,
    );
  const e = expected;

  // 1. The static rules.
  passes(
    "hd: committed expected.json static rules",
    evaluateExpectedStaticHd(e).problems,
  );
  {
    const b = clone(e);
    b.shots[0].regions["c1.SC"] = [...b.shots[0].regions["c0.SC"]];
    fails(
      "hd: overlapping regions",
      evaluateExpectedStaticHd(b).problems,
      "overlap",
    );
  }
  {
    const b = clone(e);
    b.shots[2].regions["c4.TR"][0] += 1;
    fails(
      "hd: an odd region edge",
      evaluateExpectedStaticHd(b).problems,
      "odd edge",
    );
  }
  {
    const b = clone(e);
    b.steps[3].cells[2].sm.phase = (b.steps[3].cells[2].sm.phase + 1) % 6;
    fails(
      "hd: SM phase off D6 at the cell's phase",
      evaluateExpectedStaticHd(b).problems,
      "SM phase",
    );
  }
  {
    const b = clone(e);
    b.steps[5].cells[0].le_focus = true;
    fails(
      "hd: LineEdit focus on two cells",
      evaluateExpectedStaticHd(b).problems,
      "le_focus",
    );
  }
  {
    const b = clone(e);
    b.steps[9].cells[1].hud.layer = b.steps[9].cells[0].hud.layer;
    fails(
      "hd: two cells sharing a HUD layer",
      evaluateExpectedStaticHd(b).problems,
      "not distinct",
    );
  }

  // 2. The presentation transform.
  {
    const shot = e.shots[0];
    const k = shot.items.findIndex(
      (i) => i.ops_half !== undefined && i.clip_px !== null,
    );
    const any =
      k >= 0 ? k : shot.items.findIndex((i) => i.ops_half !== undefined);
    const item = shot.items[any];
    const half = hdItems(e, shot, "half")[any];
    const native = hdItems(e, shot, "native")[any];
    assert(
      "hd: half draws ops_half under scale(0.5), native the items as written",
      item !== undefined &&
        half.ops === item.ops_half &&
        native.ops === item.ops &&
        JSON.stringify(half.xform) ===
          JSON.stringify(item.xform.map((v) => v * 0.5)) &&
        JSON.stringify(native.xform) === JSON.stringify(item.xform) &&
        (item.clip_px === null ||
          JSON.stringify(half.clip_px) ===
            JSON.stringify(item.clip_px.map((v) => v * 0.5))),
      item?.name,
    );
  }

  // 3. The half rasters of steps 0 and 1.
  {
    const pres: Presentation = "half";
    const [w, h] = e.presentations.half.size;
    const s0 = e.shots[0];
    const s1 = e.shots[1];
    const r0 = rasterOfShotHd(e, s0, pres);
    const r1 = rasterOfShotHd(e, s1, pres);
    const ri0 = regionIndexHd(s0.regions, w, h, 0.5);
    passes(
      "hd: half step-0 raster outside the regions",
      evaluateRasterOutsideHd(e, s0, r0, ri0, pres),
    );
    // A BG pixel between two cells' panels (the clear strip at y in [344, 360) of cell 0 is
    // pixel rows 172..179 at half): paint one.
    const bad = { ...r0, rgba: new Uint8Array(r0.rgba) };
    const i = 175 * w + 10;
    bad.rgba[i * 4] = 200;
    fails(
      "hd: a painted BG pixel",
      evaluateRasterOutsideHd(e, s0, bad, ri0, pres),
      "bottom strips",
    );
    const changed = changedRegionsHd(
      { regions: s0.regions, raster: r0, content: undecidedContentHd(e, s0) },
      { regions: s1.regions, raster: r1, content: undecidedContentHd(e, s1) },
      0.5,
    );
    passes(
      "hd: half step-1 fresh as the rasters say",
      freshnessProblems("model half", 1, e.steps[1].fresh, changed),
    );
    const flipped = {
      ...e.steps[1].fresh,
      "c4.TR": !e.steps[1].fresh["c4.TR"],
    };
    fails(
      "hd: a flipped fresh flag",
      freshnessProblems("model half", 1, flipped, changed),
      "c4.TR",
    );
  }

  // 4. Frames against frames.
  {
    const pres: Presentation = "half";
    const [w, h] = e.presentations.half.size;
    const shot = e.shots[0];
    const ri = regionIndexHd(shot.regions, w, h, 0.5);
    const blank = (): Frame6 => ({
      width: w,
      height: h,
      rgba: new Uint8Array(w * h * 4),
    });
    const a = blank();
    const b = blank();
    const paint = (f: Frame6, box: number[]) => {
      for (let y = box[1]; y < box[3]; y++)
        for (let x = box[0]; x < box[2]; x++) f.rgba[(y * w + x) * 4] = 9;
    };
    for (const c of e.cells)
      paint(
        b,
        [456, 88, 624, 116].map((v, k) => (v + c.origin[k % 2]) / 2),
      );
    // render-stream/5's per-cell HU exclusion (kept for hudExclusionProblems); since G6b
    // excludedRegionsHd is empty and every HU is compared.
    const exclude = new Set(e.cells.map((cell) => `c${cell.cell}.HU`));
    assert("hd: on /6 nothing is excluded", excludedRegionsHd(e).size === 0);
    assert(
      "hd: on /6 a missing HUD panel is a mismatch",
      pixelVerdictHd([
        {
          shot: shot.id,
          diff: diffFramesHd(a, b, ri, excludedRegionsHd(e)),
        },
      ]).verdict === "pixel-mismatch",
    );
    const d = diffFramesHd(a, b, ri, exclude);
    passes(
      "hd: each cell's HU differs in exactly its HUD panel",
      hudExclusionProblems(e, "synthetic", shot, d, pres),
    );
    assert(
      "hd: the HUD panels are not compared",
      pixelVerdictHd([{ shot: shot.id, diff: d }]).verdict === "success",
    );
    const c = blank();
    for (const cell of e.cells.slice(1))
      paint(
        c,
        [456, 88, 624, 116].map((v, k) => (v + cell.origin[k % 2]) / 2),
      );
    fails(
      "hd: cell 0's HUD panel missing",
      hudExclusionProblems(
        e,
        "synthetic",
        shot,
        diffFramesHd(a, c, ri, exclude),
        pres,
      ),
      "c0.HU",
    );
    paint(b, [5, 5, 8, 8]);
    const v = pixelVerdictHd([
      { shot: shot.id, diff: diffFramesHd(a, b, ri, exclude) },
    ]);
    assert(
      "hd: a difference outside HU is a mismatch",
      v.verdict === "pixel-mismatch" && v.table[shot.id].includes("c0.SC"),
      JSON.stringify(v.table),
    );
    assert(
      "hd: a missing shot is incomplete",
      pixelVerdictHd([{ shot: shot.id, diff: null }]).verdict === "incomplete",
    );
  }

  // 5. The oracle.
  {
    const line = (pres: Presentation, k: number): HdOracleLine => {
      const s = e.steps[k];
      const p = e.presentations[pres];
      return {
        schema: "render-stream-gate6-hd-oracle/1",
        step: s.step,
        frame: s.settle_frame,
        oversampling: p.oversampling,
        viewport: {
          window_size: p.size,
          visible_size: [1920, 1080],
          stretch_scale: [p.scale, p.scale],
          canvas_transform: s.canvas_transform,
        },
        grid: { position: [0, 0], size: [1920, 1080] },
        cells: s.cells.map((c, i) => ({
          cell: i,
          position: e.cells[i].origin,
          size: [640, 360],
          scene_global_position: e.cells[i].origin,
          scroll: {
            v_scroll: c.v_scroll,
            content_position: c.content_position,
          },
          canvas_layers: [
            {
              name: "HUD",
              layer: c.hud.layer,
              sublayer: 18,
              visible: c.hud.visible,
            },
          ],
          materials: {
            SM: {
              shader_sha256: c.sm.shader_sha256,
              params: [
                { name: "phase", type: "int", value: c.sm.phase },
                { name: "tint", type: "color", value: c.sm.tint },
              ],
            },
            CM: { blend_mode: c.cm_blend_mode },
          },
          pb_value: c.pb_value,
          rich_text: c.rich_text,
          line_edit: {
            text: "edit me",
            text_height: 23,
            selection: [],
            carets: [],
          },
          le_focus: c.le_focus,
        })),
        pages: [],
      };
    };
    const log = (
      leg: string,
      pres: Presentation,
      edit?: (l: HdOracleLine[]) => void,
    ): HdOracleLog => {
      const lines = e.steps.map((_, k) => line(pres, k));
      edit?.(lines);
      return {
        leg,
        path: leg,
        text: lines.map((l) => JSON.stringify(l)).join("\n"),
        lines,
        problem: null,
      };
    };
    const n = log("native", "native");
    const nr = log("native-repeat", "native");
    const hf = log("half", "half");
    passes(
      "hd: grid layout of synthetic oracle lines",
      evaluateGridLayout(e, [n, hf]).problems,
    );
    fails(
      "hd: a cell out of the grid",
      evaluateGridLayout(e, [
        log("moved", "native", (l) => {
          l[4].cells[5].position = [600, 360];
        }),
      ]).problems,
      "cell 5 position",
    );
    passes(
      "hd: oversampling 1 native, 0.5 half",
      evaluateOversampling(e, [
        { pres: "native", log: n },
        { pres: "half", log: hf },
      ]).problems,
    );
    fails(
      "hd: half read at oversampling 1",
      evaluateOversampling(e, [{ pres: "half", log: log("half-1", "native") }])
        .problems,
      "oversampling",
    );
    passes(
      "hd: every cell's oracle view",
      evaluateCellOracle(e, [n, hf], [[n, nr]]).problems,
    );
    fails(
      "hd: PB's value off in one cell",
      evaluateCellOracle(
        e,
        [
          log("pb", "native", (l) => {
            l[2].cells[7].pb_value += 0.01;
          }),
        ],
        [],
      ).problems,
      "pb_value",
    );
    fails(
      "hd: the repeat's bytes differ",
      evaluateCellOracle(e, [n], [[n, { ...nr, text: `${nr.text} ` }]])
        .problems,
      "differ",
    );
  }

  // 6. Session and ties.
  {
    const rec = (window: number[], final: number[]) =>
      ({
        path: "r",
        present: true,
        errors: [],
        session: {
          viewport: {
            logical_size: [1920, 1080],
            stretch: {
              mode: "canvas_items",
              aspect: "keep",
              scale_mode: "fractional",
            },
            root_size_policy: "enforce-min-size",
            host_size_status:
              window[0] === 1920 ? "match" : "degenerate-window",
            host_window_size: window,
          },
        },
        session_blocks: [
          [0.2, 0.2, 0.4, 1],
          [1, 0, 0, 1, 0, 0],
          [0, 0, 1920, 1080],
          final,
          [1],
        ],
        transactions: [],
      }) as unknown as RecordingSummary;
    passes(
      "hd: session at the logical window",
      evaluateHdSession([
        { label: "full", recording: rec([1920, 1080], [1, 0, 0, 1, 0, 0]) },
      ]).problems,
    );
    fails(
      "hd: a 64x64 host window",
      evaluateHdSession([
        { label: "full", recording: rec([64, 64], [30, 0, 0, 30, 0, 0]) },
      ]).problems,
      "session viewport",
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
    const ids = [1, ...[...Array(9).keys()].map((c) => 20 + c)];
    const tl = (indices: number[]) =>
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
                  items: ids,
                  xform: [1, 0, 0, 1, 0, 0],
                },
              ],
              items: ids.map((id, k) =>
                item(
                  id,
                  indices[k],
                  k === 0
                    ? [0, 0, 1920, 1080]
                    : [
                        600 + 640 * ((k - 1) % 3),
                        344 + 360 * Math.floor((k - 1) / 3),
                        16,
                        16,
                      ],
                ),
              ),
            },
          },
        ],
      }) as unknown as RecordingSummary;
    const names = new Map<string, number>([
      ["Grid", 1],
      ...[...Array(9).keys()].map(
        (c) => [`c${c}.TL`, 20 + c] as [string, number],
      ),
    ]);
    passes(
      "hd: Grid and nine TLs at distinct draw indices",
      evaluateNoTiesHd(
        [{ label: "full", recording: tl(ids.map((_, k) => k)) }],
        names,
      ).problems,
    );
    fails(
      "hd: two TLs tied at frame 1",
      evaluateNoTiesHd(
        [{ label: "full", recording: tl([0, 1, 2, 2, 4, 5, 6, 7, 8, 9]) }],
        names,
      ).problems,
      "distinct",
    );
  }
}
