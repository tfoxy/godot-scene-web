#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8re checks (lib/gate8-rearm-checks.ts, LS3) on fabricated evidence, each
// with a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-rearm.ts
//
// 1. rearmCompare: run A and B's arm 2 with other ids, other origins and other versions are equal;
//    a changed transform at one frame, a transaction only one side published, a texture whose
//    content differs and an extra unsupported entry each fail.
// 2. stepSchedule: a step in arm 1 and one while disarmed pass; none while disarmed fails.
// 3. cyclePhases / instanceRound / disarmRound on a two-arm round: the honest round passes; a
//    changed instance id (in the fixture's dumps, or in arm 2's viewer row), a leaked callable
//    after a disarm, a missing callable while armed, v2_watched_after_off 1 and teardown
//    filter_watches 1 each fail; missing evidence fails.
//
// Exits non-zero if any assertion fails.

import type { Dump, IdLine, OracleLine } from "../lib/gate8-id14-checks";
import {
  type CycleLine,
  cyclePhases,
  disarmRound,
  instanceRound,
  rearmCompare,
  reentryRound,
  stepSchedule,
  type TeardownItemMeta,
} from "../lib/gate8-rearm-checks";
import type {
  ResolvedItem,
  ResolvedRecording,
  ResolvedTransaction,
} from "../lib/render-stream-2";

let assertions = 0;
let failures = 0;
function assert(condition: boolean, what: string): void {
  assertions++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

type State = ResolvedTransaction["state"];

// ------------------------------------------------------------------------------ 1. rearmCompare

function item(id: number, over: Partial<ResolvedItem> = {}): ResolvedItem {
  return {
    id,
    origin: "adopted",
    parent: { kind: "canvas", id: 1 },
    children: [],
    visible: true,
    draw_index: 0,
    z_index: 0,
    z_relative: true,
    behind: false,
    clip: false,
    custom_rect: false,
    visibility_layer: 1,
    texture_filter: "default",
    texture_repeat: "default",
    material: null,
    use_parent_material: false,
    instance_params: [],
    content_version: 1,
    xform: [1, 0, 0, 1, 0, 0],
    modulate: [1, 1, 1, 1],
    self_modulate: [1, 1, 1, 1],
    custom_rect_rect: [0, 0, 0, 0],
    commands: [],
    ...over,
  } as ResolvedItem;
}

/** Two items, the second drawing texture `tex` (hash `hash`); `base` offsets every id. */
function state(
  base: number,
  x: number,
  hash = "h-plain",
  origin = "adopted",
): State {
  const tex = base + 50;
  return {
    status: "ok",
    failures: [],
    unsupported: [{ op: "root_viewport_size", reason: "degenerate-host-size" }],
    default_texture_filter: "linear",
    default_texture_repeat: "disabled",
    canvases: [
      {
        id: base + 1,
        origin: "root-query",
        role: "root",
        attached: true,
        layer: 0,
        sublayer: 0,
        items: [base + 2, base + 3],
        xform: [1, 0, 0, 1, 0, 0],
        modulate: [1, 1, 1, 1],
      },
    ],
    items: [
      item(base + 2, {
        origin: origin as ResolvedItem["origin"],
        parent: { kind: "canvas", id: base + 1 },
        xform: [1, 0, 0, 1, x, 0],
        commands: [
          {
            op: "add_rect",
            aa: false,
            rect: [0, 0, 4, 4],
            color: [1, 0, 0, 1],
          },
        ] as ResolvedItem["commands"],
      }),
      item(base + 3, {
        origin: origin as ResolvedItem["origin"],
        parent: { kind: "canvas", id: base + 1 },
        draw_index: base,
        content_version: base + 1,
        commands: [
          {
            op: "add_texture_rect",
            tex,
            rect: [0, 0, 8, 8],
            modulate: [1, 1, 1, 1],
          },
        ] as unknown as ResolvedItem["commands"],
      }),
    ],
    textures: [
      {
        id: tex,
        origin,
        adopted_content: "current",
        kind: "image",
        status: "ok",
        reason: null,
        version: base + 1,
        hash,
        format: "RGBA8",
        source_format: null,
        width: 8,
        height: 8,
        mipmaps: false,
        payload_bytes: 100,
        canvas: null,
      },
    ],
  } as unknown as State;
}

function recording(
  frames: number[],
  mk: (f: number) => State,
): ResolvedRecording {
  return {
    schema: "render-stream-8-resolved/1",
    transactions: frames.map((frame, seq) => ({
      seq,
      frame,
      encoding: "full",
      state: mk(frame),
    })),
  } as unknown as ResolvedRecording;
}

const K2 = 20;
const frames = [20, 21, 22, 25, 30];
const once = recording(frames, (f) => state(0, f >= 25 ? 10 : 0));
{
  // B's arm 2: other ids, other draw-index values, other versions; the same content
  const honest = recording(frames, (f) =>
    state(100, f >= 25 ? 10 : 0, "h-plain", "created"),
  );
  const r = rearmCompare(once, honest, K2);
  assert(
    r.problems.length === 0,
    `honest arm 2 passes (${r.problems.slice(0, 3).join("; ")})`,
  );
  assert(
    r.frames === 11 && r.transactions === 5,
    `honest: 11 frames, 5 transactions (${r.frames}, ${r.transactions})`,
  );

  const moved = recording(frames, (f) => state(100, f >= 22 ? 10 : 0));
  const m = rearmCompare(once, moved, K2);
  assert(
    m.problems.some((p) => p.startsWith("frame 22:") && p.includes("xform")),
    `a transform that differs at frame 22 fails (${m.problems[0]})`,
  );

  const extra = recording([20, 21, 22, 24, 25, 30], (f) =>
    state(100, f >= 25 ? 10 : 0),
  );
  assert(
    rearmCompare(once, extra, K2).problems.some((p) =>
      p.startsWith("transaction frames differ"),
    ),
    "a transaction only arm 2 published fails",
  );

  const late = recording([21, 22, 25, 30], (f) => state(100, f >= 25 ? 10 : 0));
  assert(
    rearmCompare(once, late, K2).problems.some((p) =>
      p.includes("expected K2"),
    ),
    "arm 2 starting after K2 fails",
  );

  const otherTex = recording(frames, (f) =>
    state(100, f >= 25 ? 10 : 0, f >= 30 ? "h-other" : "h-plain"),
  );
  const t = rearmCompare(once, otherTex, K2);
  assert(
    t.problems.some((p) => p.startsWith("frame 30:")) &&
      t.problems.some((p) => p.includes("resources differ")),
    `a texture with other content fails, by its draw and by the table (${t.problems.slice(0, 2).join("; ")})`,
  );

  const unsupported = recording(frames, (f) => {
    const s = state(100, f >= 25 ? 10 : 0);
    if (f === 21)
      s.unsupported.push({
        op: "canvas_item_add_texture_rect_region",
        reason: "unknown-texture",
      } as State["unsupported"][number]);
    return s;
  });
  assert(
    rearmCompare(once, unsupported, K2).problems.some((p) =>
      p.startsWith("frame 21: unsupported"),
    ),
    "an unsupported entry only arm 2 has fails (no refused-texture exception between two arms)",
  );
}

// ------------------------------------------------------------------------------ 2. stepSchedule
{
  const steps = [
    { step: 0, applied_frame: 1 },
    { step: 1, applied_frame: 31 },
  ];
  const ok = stepSchedule(steps, 1, 21, 36);
  assert(
    ok.problems.length === 0 && ok.arm1.length === 1 && ok.gap.length === 1,
    "a step in arm 1 and one while disarmed pass",
  );
  const none = stepSchedule(steps, 1, 21, 30);
  assert(
    none.problems.some((p) => p.includes("while disarmed")),
    "no step while disarmed fails",
  );
  const noArm1 = stepSchedule(steps, 5, 21, 36);
  assert(
    noArm1.problems.some((p) => p.includes("inside arm 1")),
    "no step inside arm 1 fails",
  );
}

// ---------------------------------------------------------------- 3. the re-arm round's checks

const cycle: CycleLine[] = [
  {
    cycle: 0,
    phase: "armed",
    arm_index: 1,
    start_frame: 10,
    end_frame: 110,
    process_frame: 109,
  },
  {
    cycle: 1,
    phase: "idle",
    arm_index: 1,
    start_frame: 112,
    end_frame: 172,
    process_frame: 171,
  },
  {
    cycle: 1,
    phase: "armed",
    arm_index: 2,
    start_frame: 173,
    end_frame: 273,
    process_frame: 272,
  },
  {
    cycle: 2,
    phase: "idle",
    arm_index: 2,
    start_frame: 275,
    end_frame: 335,
    process_frame: 334,
  },
];
// two Controls (rids 7, 8, instance ids 1007, 1008) and a Node2D (rid 9); dumps at capture
// frames 60 (arm 1), 140 (idle 1), 220 (arm 2), 340 (after disarm 2)
function dump(cf: number, plc: number, iid8 = "1008"): OracleLine {
  return {
    frame: cf + 12,
    process_frames: cf - 1,
    nodes: [
      {
        rid: "7",
        class: "Control",
        path: "A",
        instance_id: "1007",
        mouse_filter: 0,
        plc_custom: plc,
        groups: [],
        meta: {},
      },
      {
        rid: "8",
        class: "Control",
        path: "B",
        instance_id: iid8,
        mouse_filter: 1,
        plc_custom: plc,
        groups: [],
        meta: {},
      },
      {
        rid: "9",
        class: "Node2D",
        path: "C",
        instance_id: "1009",
        mouse_filter: null,
        plc_custom: null,
        groups: [],
        meta: {},
      },
    ],
  } as OracleLine;
}
const oracle = [dump(60, 1), dump(140, 0), dump(220, 1), dump(340, 0)];
// arm 1 numbers the rids 1..3, arm 2 (a fresh mirror) 4,5,1
const ids: IdLine[] = [
  { id: 1, rid: "7", stamp: 12, node: true, copy: false },
  { id: 2, rid: "8", stamp: 12, node: true, copy: false },
  { id: 3, rid: "9", stamp: 12, node: true, copy: false },
  { id: 4, rid: "7", stamp: 175, node: true, copy: false },
  { id: 5, rid: "8", stamp: 175, node: true, copy: false },
  { id: 1, rid: "9", stamp: 175, node: true, copy: false },
];
function viewer(rows: Record<string, string>): Dump {
  const seen: Record<string, unknown> = {};
  for (const [id, iid] of Object.entries(rows))
    seen[id] = {
      class: "Control",
      script: null,
      scene: null,
      path: "x",
      instance_id: iid,
      mouse_filter: 0,
      groups: 0,
      meta: {},
    };
  return { grant: null, seen, rows: {}, full_records: 1, delta_records: 0 };
}
const v1 = viewer({ "1": "1007", "2": "1008", "3": "1009" });
const v2 = viewer({ "4": "1007", "5": "1008", "1": "1009" });
const ph = cyclePhases(cycle, 2);
assert(
  ph.problems.length === 0 && ph.offset === -1,
  `cyclePhases reads two arms (offset ${ph.offset}, ${ph.problems.join("; ")})`,
);
assert(
  ph.arms[1].start === 173 && ph.idles[0].start === 112,
  "cyclePhases: arm 2 starts at 173, idle 1 at 112",
);
assert(
  cyclePhases(cycle.slice(0, 2), 2).problems.some((p) => p.includes("arm 2")),
  "cyclePhases: a missing arm 2 is a problem",
);
{
  const r = instanceRound(oracle, ids, ph, [v1, v2]);
  assert(
    r.problems.length === 0,
    `instanceRound: the honest round passes (${r.problems.join("; ")})`,
  );
  assert(
    r.detail.includes("3 nodes in both arms"),
    `instanceRound: 3 nodes in both arms (${r.detail})`,
  );

  const changed = [
    dump(60, 1),
    dump(140, 0),
    dump(220, 1, "2008"),
    dump(340, 0, "2008"),
  ];
  assert(
    instanceRound(changed, ids, ph, [v1, v2]).problems.some((p) =>
      p.includes("rid 8"),
    ),
    "instanceRound: a node whose instance id changes across the arms fails",
  );
  const v2bad = viewer({ "4": "1007", "5": "2008", "1": "1009" });
  assert(
    instanceRound(oracle, ids, ph, [v1, v2bad]).problems.some((p) =>
      p.includes("arm 2 row 5"),
    ),
    "instanceRound: an arm-2 row with another instance id fails",
  );
  // arm 2's row 1 read through arm 1's id log (rid 7) would be wrong: the split by stamp matters
  assert(
    instanceRound(oracle, ids.slice(0, 3), ph, [v1, v2]).problems.some((p) =>
      p.includes("arm 2 row"),
    ),
    "instanceRound: arm 2 rows without arm 2's id lines fail",
  );
  assert(
    instanceRound(oracle, ids, ph, [v1, null]).problems.some((p) =>
      p.includes("no viewer dump"),
    ),
    "instanceRound: a missing viewer fails",
  );
}
{
  const stats = [{ v2_watched_after_off: 0 }, { v2_watched_after_off: 0 }];
  const td: TeardownItemMeta[] = [
    { arm_index: 1, item_meta: { host_held: 0, filter_watches: 0 } },
    { arm_index: 2, item_meta: { host_held: 0, filter_watches: 0 } },
  ];
  const r = disarmRound(oracle, ids, ph, stats, td);
  assert(
    r.problems.length === 0,
    `disarmRound: the honest round passes (${r.problems.join("; ")})`,
  );

  const leaked = [dump(60, 1), dump(140, 1), dump(220, 1), dump(340, 0)];
  assert(
    disarmRound(leaked, ids, ph, stats, td).problems.some((p) =>
      p.startsWith("after disarm 1"),
    ),
    "disarmRound: a callable left after disarm 1 fails",
  );
  const leaked2 = [dump(60, 1), dump(140, 0), dump(220, 1), dump(340, 2)];
  assert(
    disarmRound(leaked2, ids, ph, stats, td).problems.some((p) =>
      p.startsWith("after disarm 2"),
    ),
    "disarmRound: callables left after disarm 2 fail",
  );
  const unwatched = [dump(60, 1), dump(140, 0), dump(220, 0), dump(340, 0)];
  assert(
    disarmRound(unwatched, ids, ph, stats, td).problems.some((p) =>
      p.startsWith("arm 2 (frame"),
    ),
    "disarmRound: a resolved Control with no callable while arm 2 is armed fails",
  );
  assert(
    disarmRound(
      oracle,
      ids,
      ph,
      [stats[0], { v2_watched_after_off: 1 }],
      td,
    ).problems.some((p) => p.includes("v2_watched_after_off 1")),
    "disarmRound: v2_watched_after_off 1 fails",
  );
  assert(
    disarmRound(oracle, ids, ph, stats, [
      td[0],
      { arm_index: 2, item_meta: { host_held: 0, filter_watches: 1 } },
    ]).problems.some((p) => p.includes("filter_watches 1")),
    "disarmRound: teardown filter_watches 1 fails",
  );
  assert(
    disarmRound(oracle, ids, ph, stats, [
      { arm_index: 1, item_meta: { host_held: 3, filter_watches: 0 } },
      td[1],
    ]).problems.some((p) => p.includes("host_held 3")),
    "disarmRound: teardown host_held 3 fails",
  );
  assert(
    disarmRound(oracle, ids, ph, [stats[0], null], [td[0], null]).problems.some(
      (p) => p.includes("no item-meta.json"),
    ),
    "disarmRound: missing arm-2 evidence fails",
  );
  assert(
    disarmRound([dump(60, 1), dump(220, 1)], ids, ph, stats, td).problems.some(
      (p) => p.includes("no fixture dump after"),
    ),
    "disarmRound: no dump after a disarm fails",
  );
}

{
  const marked = structuredClone(oracle);
  marked[0].nodes[0].meta.rs_tag = "rearm-entry-1";
  marked[2].nodes[0].meta.rs_tag = "rearm-entry-2";
  const logs = [...ids, { ...ids[0], stamp: 50 }, { ...ids[3], stamp: 210 }];
  const views = [structuredClone(v1), structuredClone(v2)];
  (views[0].seen["1"] as { meta: Record<string, string> }).meta.rs_tag =
    "rearm-entry-1";
  (views[1].seen["4"] as { meta: Record<string, string> }).meta.rs_tag =
    "rearm-entry-2";
  const stats = [{ reentry_rows: 1 }, { reentry_rows: 1 }];
  assert(
    reentryRound(marked, logs, ph, views, stats).problems.length === 0,
    "reentryRound: metadata refresh and stable instance across arms pass",
  );
  assert(
    reentryRound(marked, ids, ph, views, stats).problems.length > 0,
    "reentryRound: missing repeated identity reads fail",
  );
  const stale = structuredClone(views);
  (stale[1].seen["4"] as { meta: Record<string, string> }).meta.rs_tag =
    "rearm-entry-1";
  assert(
    reentryRound(marked, logs, ph, stale, stats).problems.length > 0,
    "reentryRound: stale metadata on arm 2 fails",
  );
  const duplicate = structuredClone(marked);
  duplicate[2].nodes[0].plc_custom = 2;
  assert(
    reentryRound(duplicate, logs, ph, views, stats).problems.length > 0,
    "reentryRound: duplicate connection after re-entry fails",
  );
  assert(
    reentryRound(marked, logs, ph, views, [stats[0], { reentry_rows: 0 }])
      .problems.length > 0,
    "reentryRound: missing arm-2 re-entry accounting fails",
  );
}

if (failures > 0) {
  console.error(
    `self-test-gate8-rearm: ${failures} of ${assertions} assertions failed`,
  );
  process.exit(1);
}
console.log(`self-test-gate8-rearm: ${assertions} passed, 0 failed`);
