// Self-test for gate 6b (run from self-test-gate6.ts): the pure g6b checks of lib/gate6b-checks.ts
// on synthetic sessions, hook-log lines, wire states, triangle arrays and applied.json, and on the
// committed fixtures/gate6-hd/expected.json, each with a passing and a failing case.
//
// 1. evaluateSessionDeclared: a half session passes; a wrong oversampling, a degenerate status, a
//    rate publication and an identity final transform each fail.
// 2. evaluateSessionEntries: snap-2d in every transaction passes; a transaction without it fails.
// 3. canvasLogState + evaluateCanvasCommands: a HUD stacked in its attach frame and re-stacked
//    passes; a wire layer that lags the hook log, a first publication at (0,0) and a stacking tie
//    each fail.
// 4. evaluateStackingParity against oracle HUDs.
// 5. modelTriangleArrays + compareTriangleArrays on the committed half op lists: identical arrays
//    pass, a point 3 ulp off and a missing array fail, 2 ulp passes using the allowance.
// 6. evaluateAppliedViewport / receiverTyped.
// 7. hazardKinds on the committed expected.json, and evaluateHazard.
// 8. PRES-A: stretchVisibleSize (the engine's float32 expand floors, keep stays logical) and
//    evaluateWideSession (a 2520x1080 expand session passes; a logical visible rect and a keep aspect
//    fail).

import type { RecordingSummary } from "../lib/gate0-checks";
import type { ResourceLine } from "../lib/gate2-checks";
import {
  canvasLogState,
  compareTriangleArrays,
  evaluateAppliedViewport,
  evaluateCanvasCommands,
  evaluateHazard,
  evaluateSessionDeclared,
  evaluateSessionEntries,
  evaluateStackingParity,
  hazardKinds,
  modelTriangleArrays,
  receiverTyped,
  styleboxItemsHd,
} from "../lib/gate6b-checks";
import { evaluateWideSession } from "../lib/gate6b-wide-checks";
import type { Gate6HdExpected } from "../lib/gate6h-checks";
import { stretchVisibleSize } from "../lib/render-stream-2";
import type { Wire5 } from "../lib/gate55-wire";

type Assert = (name: string, ok: boolean, detail?: string) => void;

export function selfTestGate6b(assert: Assert, hd: Gate6HdExpected): void {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const passes = (name: string, problems: string[]) =>
    assert(
      `g6b: ${name} passes`,
      problems.length === 0,
      problems.slice(0, 3).join(" | "),
    );
  const fails = (name: string, problems: string[], needle?: string) =>
    assert(
      `g6b: ${name} fails`,
      problems.length > 0 &&
        (!needle || problems.some((p) => p.includes(needle))),
      problems.length === 0
        ? "no problem reported"
        : `problems: ${problems.slice(0, 2).join(" | ")}`,
    );

  // 1. Sessions.
  const halfSession = {
    protocol: "render-stream/6",
    viewport: {
      logical_size: [1920, 1080],
      stretch: {
        mode: "canvas_items",
        aspect: "keep",
        scale_mode: "fractional",
      },
      root_size_policy: "presentation",
      presentation_size: [960, 540],
      host_size_status: "match",
      host_window_size: [960, 540],
      font_oversampling: 0.5,
      snap_2d: { transforms: false, vertices: false },
    },
    publication: { mode: "every-frame", target_fps: null },
  };
  const recording = (session: unknown, final = [0.5, 0, 0, 0.5, 0, 0]) =>
    ({
      present: true,
      session,
      session_blocks: [
        [0.2, 0.2, 0.4, 1],
        [1, 0, 0, 1, 0, 0],
        [0, 0, 1920, 1080],
        final,
        [1],
      ],
    }) as unknown as RecordingSummary;
  const want = {
    label: "half",
    logical_size: [1920, 1080] as [number, number],
    stretch_mode: "canvas_items",
    root_size_policy: "presentation",
    presentation_size: [960, 540] as [number, number],
    host_window_size: [960, 540] as [number, number],
    font_oversampling: 0.5,
    snap_2d: { transforms: false, vertices: false },
    host_final_xform: [0.5, 0, 0, 0.5, 0, 0],
  };
  passes(
    "a half session",
    evaluateSessionDeclared(recording(halfSession), want),
  );
  {
    const s = clone(halfSession);
    s.viewport.font_oversampling = 1;
    fails(
      "oversampling 1 at half",
      evaluateSessionDeclared(recording(s), want),
      "viewport",
    );
  }
  {
    const s = clone(halfSession);
    s.viewport.host_size_status = "degenerate-window";
    fails(
      "a degenerate status",
      evaluateSessionDeclared(recording(s), want),
      "viewport",
    );
  }
  {
    const s = clone(halfSession) as unknown as { publication: unknown };
    s.publication = { mode: "rate", target_fps: 30 };
    fails(
      "a rate publication on a file sink",
      evaluateSessionDeclared(recording(s), want),
      "publication",
    );
  }
  fails(
    "an identity final transform at half",
    evaluateSessionDeclared(recording(halfSession, [1, 0, 0, 1, 0, 0]), want),
    "host_final_xform",
  );

  // 2. Session-level entries.
  {
    const snap = ["viewport_set_snap_2d_transforms_to_pixel", "snap-2d"] as [
      string,
      string,
    ];
    const tx = (seq: number, u: unknown[]) => ({
      meta: { seq, unsupported: u },
    });
    const entry = { op: snap[0], item: null, reason: snap[1] };
    const good = {
      present: true,
      transactions: [tx(1, [entry]), tx(2, [entry])],
    } as unknown as RecordingSummary;
    passes(
      "snap-2d in every transaction",
      evaluateSessionEntries(good, [snap], "snap"),
    );
    const bad = {
      present: true,
      transactions: [tx(1, [entry]), tx(2, [])],
    } as unknown as RecordingSummary;
    fails(
      "a transaction without snap-2d",
      evaluateSessionEntries(bad, [snap], "snap"),
      "seq 2",
    );
  }

  // 3. canvas-commands.
  const line = (frame: number, op: string, layer?: number, sublayer?: number) =>
    ({
      kind: "canvas",
      op,
      rid: "77",
      frame,
      layer: layer ?? null,
      sublayer: sublayer ?? null,
    }) as unknown as ResourceLine;
  const canvases = (attached: boolean, layer: number, sublayer = 30) => [
    { id: 1, attached: true, layer: 0, sublayer: 0 },
    { id: 2, attached, layer, sublayer },
  ];
  const wireOf = (
    states: { frame: number; canvases: unknown[]; unsupported?: unknown[] }[],
  ) =>
    ({
      transactions: states.map((s, k) => ({
        seq: k + 1,
        frame: s.frame,
        state: { canvases: s.canvases, unsupported: s.unsupported ?? [] },
      })),
    }) as unknown as Pick<Wire5, "transactions">;
  const log = canvasLogState([
    line(1, "viewport_set_canvas_stacking", 1, 30),
    line(91, "viewport_set_canvas_stacking", -1, 30),
    line(101, "viewport_set_canvas_stacking", 1, 30),
    line(130, "viewport_remove_canvas"),
  ]);
  const good = wireOf([
    { frame: 1, canvases: canvases(true, 1) },
    { frame: 91, canvases: canvases(true, -1) },
    { frame: 101, canvases: canvases(true, 1) },
  ]);
  passes(
    "a HUD stacked in its attach frame",
    evaluateCanvasCommands(good, log, 122, "w").problems,
  );
  fails(
    "a wire layer lagging the hook log",
    evaluateCanvasCommands(
      wireOf([
        { frame: 1, canvases: canvases(true, 1) },
        { frame: 91, canvases: canvases(true, 1) },
      ]),
      log,
      122,
      "w",
    ).problems,
    "hook log (-1,30)",
  );
  fails(
    "a first publication at the attach default",
    evaluateCanvasCommands(
      wireOf([
        { frame: 1, canvases: canvases(true, 0, 0) },
        { frame: 2, canvases: canvases(true, 1) },
      ]),
      log,
      122,
      "w",
    ).problems,
    "attach default",
  );
  fails(
    "a canvas-stacking-tie entry",
    evaluateCanvasCommands(
      wireOf([
        {
          frame: 1,
          canvases: canvases(true, 1),
          unsupported: [
            {
              op: "viewport_set_canvas_stacking",
              item: null,
              reason: "canvas-stacking-tie",
            },
          ],
        },
      ]),
      log,
      122,
      "w",
    ).problems,
    "canvas-stacking-tie",
  );

  // 4. canvas-stacking-parity.
  {
    const steps = [
      { step: 0, settle_frame: 1 },
      { step: 9, settle_frame: 91 },
    ];
    const huds = (step: number) => [
      { layer: step === 9 ? -1 : 1, sublayer: 30 },
    ];
    passes(
      "wire stacking equals the oracle's",
      evaluateStackingParity(steps, huds, good, "w").problems,
    );
    fails(
      "a wire layer the oracle does not read",
      evaluateStackingParity(
        steps,
        () => [{ layer: 2, sublayer: 30 }],
        good,
        "w",
      ).problems,
      "oracle (2,30)",
    );
  }

  // 5. Triangle arrays on the committed half op lists.
  {
    const shot = hd.shots[0];
    const items = styleboxItemsHd(hd, shot, "half");
    const name = "c0.BT";
    const ops = items.get(name) ?? [];
    const want = modelTriangleArrays(ops);
    assert(
      "g6b: c0.BT lowers to triangle arrays at half",
      want.length > 0 && want.every((w) => w.points.length > 0),
      `${want.length} arrays`,
    );
    const asWire = want.map((w) => ({
      op: "add_triangle_array",
      points: w.points.map((p) => p.map((v) => Math.fround(v))),
      colors: w.colors.map((c) => c.map((v) => Math.fround(v))),
      indices: [...w.indices],
    }));
    passes(
      "identical triangle arrays",
      compareTriangleArrays(want, asWire, 2, name).problems,
    );
    const nudge = (ulps: number) => {
      const copy = clone(asWire);
      const buf = new DataView(new ArrayBuffer(4));
      buf.setFloat32(0, copy[0].points[0][0], true);
      buf.setInt32(0, buf.getInt32(0, true) + ulps, true);
      copy[0].points[0][0] = buf.getFloat32(0, true);
      return copy;
    };
    const two = compareTriangleArrays(want, nudge(2), 2, name);
    assert(
      "g6b: a point 2 ulp off passes using the allowance",
      two.problems.length === 0 && two.ulpUsed === 1,
      two.problems.join(" | "),
    );
    fails(
      "a point 3 ulp off",
      compareTriangleArrays(want, nudge(3), 2, name).problems,
      "ulp",
    );
    fails(
      "a missing array",
      compareTriangleArrays(want, asWire.slice(1), 2, name).problems,
      "triangle arrays",
    );
    const native = modelTriangleArrays(
      styleboxItemsHd(hd, shot, "native").get(name) ?? [],
    );
    fails(
      "the native lowering against the half model",
      compareTriangleArrays(
        want,
        native.map((w) => ({ op: "add_triangle_array", ...w })),
        2,
        name,
      ).problems,
    );
  }

  // 6. applied.json viewport block.
  {
    const applied = {
      schema: "render-stream-receiver-applied/6",
      viewport: {
        presentation_size: [960, 540],
        window_size: [960, 540],
        oversampling: 0.5,
        presentation_check: "ok",
        stretch_applied: true,
      },
      unsupported: [],
    };
    const w = {
      leg: "r",
      check: "ok" as const,
      stretch: true,
      presentation: [960, 540] as [number, number],
      oversampling: 0.5,
      typed: [],
    };
    passes(
      "a clean half receiver",
      evaluateAppliedViewport(applied as never, w),
    );
    const typed = clone(applied);
    (typed.unsupported as unknown[]).push({
      seq: null,
      item: null,
      name: "viewport",
      reason: "presentation-mismatch",
    });
    fails(
      "a typed presentation-mismatch",
      evaluateAppliedViewport(typed as never, w),
      "receiver-typed",
    );
    assert(
      "g6b: receiverTyped reads the receiver's own entries",
      JSON.stringify(receiverTyped(typed as never)) ===
        JSON.stringify(["presentation-mismatch"]),
    );
    const noStretch = clone(applied);
    noStretch.viewport.stretch_applied = false;
    fails(
      "a receiver that did not adopt the stretch",
      evaluateAppliedViewport(noStretch as never, w),
      "stretch_applied",
    );
  }

  // 7. The hazard.
  {
    const kinds = hazardKinds(hd);
    assert(
      "g6b: hazard kinds: TR flat, RT text, HB aa, BT text+aa",
      kinds.TR === "flat" &&
        kinds.RT === "text" &&
        kinds.HB === "aa" &&
        kinds.BT === "text+aa",
      JSON.stringify(kinds),
    );
    passes(
      "text and aa differ, flat equal",
      evaluateHazard({ RT: 5, HB: 3, BT: 9 }, kinds),
    );
    fails(
      "a flat region differs",
      evaluateHazard({ RT: 5, HB: 3, TR: 1 }, kinds),
      "flat region TR",
    );
    fails(
      "no aa-only region differs",
      evaluateHazard({ RT: 5 }, kinds),
      "antialiased",
    );
  }

  // 8. PRES-A.
  {
    const expand = { mode: "canvas_items", aspect: "expand" };
    const hdSize: [number, number] = [1920, 1080];
    const floors: number[] = [];
    for (let w = 1920; w <= 2600; w += 2)
      if (stretchVisibleSize(expand, hdSize, [w, 1080])[0] !== w) floors.push(w);
    assert(
      "stretchVisibleSize: the float32 W-1 floors at H 1080",
      JSON.stringify(floors) === "[1940,2234,2260,2382,2504,2530]",
      JSON.stringify(floors),
    );
    assert(
      "stretchVisibleSize: 1170x540 under expand is 2340x1080; keep stays logical",
      JSON.stringify(stretchVisibleSize(expand, hdSize, [1170, 540])) ===
        "[2340,1080]" &&
        JSON.stringify(
          stretchVisibleSize(
            { mode: "canvas_items", aspect: "keep" },
            hdSize,
            [2520, 1080],
          ),
        ) === "[1920,1080]",
    );
    const wide = {
      present: true,
      session: {
        viewport: {
          logical_size: [1920, 1080],
          stretch: {
            mode: "canvas_items",
            aspect: "expand",
            scale_mode: "fractional",
          },
          root_size_policy: "presentation",
          presentation_size: [2520, 1080],
          host_size_status: "match",
          host_window_size: [2520, 1080],
          font_oversampling: 1,
        },
      },
      session_blocks: [[], [], [0, 0, 2520, 1080], [1, 0, 0, 1, 0, 0], [1]],
    } as unknown as RecordingSummary;
    passes(
      "evaluateWideSession: a 2520x1080 expand session",
      evaluateWideSession(wide, [2520, 1080], "w"),
    );
    const logicalVisible = clone(wide);
    (logicalVisible.session_blocks as number[][])[2] = [0, 0, 1920, 1080];
    fails(
      "evaluateWideSession: a logical visible rect",
      evaluateWideSession(logicalVisible, [2520, 1080], "w"),
      "host_visible_rect",
    );
    const keep = clone(wide);
    (
      keep.session as unknown as { viewport: { stretch: { aspect: string } } }
    ).viewport.stretch.aspect = "keep";
    fails(
      "evaluateWideSession: aspect keep",
      evaluateWideSession(keep, [2520, 1080], "w"),
      "viewport",
    );
  }
}
