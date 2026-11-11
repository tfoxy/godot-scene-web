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

import {
  type EvictEvidence,
  type HtrStats,
  noImageTextureReleaseProblems,
} from "../lib/gate8-htr-checks";
import type { Dump, IdLine, OracleLine } from "../lib/gate8-id14-checks";
import {
  type CycleLine,
  cyclePhases,
  disarmRound,
  evictRearmProblems,
  type FloatHoldOracle,
  faultHoldOffProblems,
  faultReloadOffCaught,
  faultSkipRestoreCaught,
  faultSkipVerifyCaught,
  faultWarmOffProblems,
  floatHoldArmProblems,
  floatHoldCellProblems,
  floatHoldCellTable,
  floatHoldSchedule,
  holdAccountingProblems,
  imageTextureProbe,
  imageTextureRestored,
  instanceRound,
  offmainProblems,
  published,
  publishedOneByOne,
  rearmCompare,
  reentryRound,
  reloadCensus,
  reloadIdleBeforeArm,
  reloadMismatchTyped,
  reloadNo1x1,
  reloadSourcesBalanced,
  reloadTyped,
  stepSchedule,
  type TeardownItemMeta,
  type TextureEvent,
  type TextureReloadEvidence,
  type TextureTeardown,
  textureEvictExpected,
  type WarmEvidence,
  warmCompleteProblems,
  warmInvalidationProblems,
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

// Source conservation includes both ways an unused source can be released.
{
  const honest = {
    final: true,
    sources_balanced: true,
    reloaded: 13,
    adopted_from_reload: 12,
    dropped_unreferenced: 0,
    dropped_freed: 1,
    dropped_stale: 0,
  };
  assert(
    reloadSourcesBalanced(honest).length === 0,
    "reload sources: freed source balances",
  );
  assert(
    reloadSourcesBalanced({
      ...honest,
      dropped_freed: 0,
      dropped_unreferenced: 1,
    }).length === 0,
    "reload sources: unreferenced source balances",
  );
  assert(
    reloadSourcesBalanced({ ...honest, dropped_freed: 0, dropped_stale: 1 })
      .length === 0,
    "reload sources: stale source balances",
  );
  for (const bad of [
    { ...honest, dropped_stale: 1 },
    { ...honest, dropped_stale: -1, dropped_freed: 2 },
    null,
    { ...honest, final: false },
    { ...honest, sources_balanced: false },
    { ...honest, dropped_freed: 0 },
    { ...honest, dropped_freed: 2 },
    { ...honest, dropped_unreferenced: -1, dropped_freed: 2 },
    { ...honest, reloaded: Number.NaN },
  ])
    assert(
      reloadSourcesBalanced(bad).length > 0,
      "reload sources: invalid evidence fails",
    );
}

// Texture reload judges: every assertion has a failing evidence shape.
{
  const shape = { format: "DXT1", width: 64, height: 64, mipmaps: false };
  const entry = {
    path: "/fixture/swap.ctex",
    adopted: true,
    code: null,
    record: shape,
    loaded: shape,
  };
  const honest: TextureReloadEvidence = {
    final: true,
    sources_balanced: true,
    skipped: null,
    candidates: { released: 6, evicted: 7, residual: 0, total: 13 },
    reloaded: 13,
    adopted_from_reload: 12,
    dropped_unreferenced: 0,
    dropped_freed: 1,
    dropped_stale: 0,
    refused: {
      reload_unsafe: 0,
      released_no_path: 0,
      reload_mismatch: 0,
      reload_failed: 0,
      evicted_unverifiable: 0,
      evicted_mid_arm: 0,
      total: 0,
    },
    released_no_path: 0,
    temp_outlived: 0,
    scope_anomalies: 0,
    verify_skipped: 0,
    entries: [entry],
  };
  const td: TextureTeardown = {
    reload_sources_held: 0,
    htr_restore: {
      candidates: 1,
      restored: 1,
      unavailable: 0,
      mismatch: 0,
      not_placeholder: 0,
      skipped_fault: 0,
    },
  };
  const probe: TextureEvent = {
    event: "imagetexture-probe",
    frame: 32,
    expected: { ...shape, format: 17, sha256: "a".repeat(64) },
    got: { ...shape, format: 17, sha256: "a".repeat(64) },
  };
  const rec = recording([20, 21], () => state(0, 0));
  const dummy = structuredClone(rec);
  for (const t of dummy.transactions) {
    t.state.textures[0].width = t.state.textures[0].height = 1;
    (t.state.items[1].commands[0] as unknown as { rect: number[] }).rect = [
      0, 0, 64, 64,
    ];
  }
  const pass = (p: string[], name: string) => assert(p.length === 0, name);
  const fail = (p: string[], name: string) => assert(p.length > 0, name);
  pass(
    reloadIdleBeforeArm([{ event: "idle-action", frame: 19 }], 20),
    "idle before arm passes",
  );
  fail(reloadIdleBeforeArm([], 20), "missing idle fails");
  fail(
    reloadIdleBeforeArm([{ event: "idle-action", frame: 20 }], 20),
    "idle at arm fails",
  );
  pass(reloadNo1x1(rec, honest), "whole textures pass");
  assert(publishedOneByOne(dummy), "dummy table detected");
  for (const r of [null, dummy])
    fail(reloadNo1x1(r, honest), "missing or dummy recording fails");
  for (const r of [
    null,
    { ...honest, final: false },
    { ...honest, entries: [{ ...entry, loaded: null }] },
  ])
    fail(reloadNo1x1(rec, r), "missing/final/loaded reload failure");
  for (const [key, value] of Object.entries({
    format: "RGBA8",
    width: 1,
    height: 1,
    mipmaps: true,
  }))
    fail(
      reloadNo1x1(rec, {
        ...honest,
        entries: [{ ...entry, loaded: { ...shape, [key]: value } }],
      }),
      `adopted ${key} mismatch fails`,
    );
  pass(reloadCensus([rec, rec, rec]), "honest census passes");
  fail(reloadCensus([rec, dummy, rec]), "dummy census fails");
  fail(reloadCensus([null]), "missing census fails");
  pass(reloadTyped(honest, true, [td, td]), "B typed reload passes");
  pass(
    reloadTyped(
      {
        ...honest,
        candidates: { released: 0, evicted: 7, residual: 0, total: 7 },
        reloaded: 7,
        adopted_from_reload: 6,
      },
      false,
      [td],
    ),
    "A typed reload passes",
  );
  pass(
    reloadTyped(honest, true, []),
    "no emitted teardown needs no invented record",
  );
  fail(reloadTyped(null, true, [td]), "missing typed evidence fails");
  for (const key of Object.keys(honest.candidates))
    fail(
      reloadTyped(
        { ...honest, candidates: { ...honest.candidates, [key]: 99 } },
        true,
        [td],
      ),
      `candidate ${key} fails`,
    );
  for (const key of [
    "reloaded",
    "adopted_from_reload",
    "released_no_path",
    "temp_outlived",
    "scope_anomalies",
    "dropped_freed",
  ])
    fail(
      reloadTyped({ ...honest, [key]: 99 }, true, [td]),
      `typed ${key} fails`,
    );
  for (const key of Object.keys(honest.refused))
    fail(
      reloadTyped(
        { ...honest, refused: { ...honest.refused, [key]: 1 } },
        true,
        [td],
      ),
      `refusal ${key} fails`,
    );
  fail(
    reloadTyped({ ...honest, final: false }, true, [td]),
    "nonfinal typed fails",
  );
  for (const t of [[null], [{ ...td, reload_sources_held: 1 }]])
    fail(reloadTyped(honest, true, t), "missing/held teardown fails");
  // The always pair uses the same shape, census and restore judges as the on pair.
  for (const rearm of [true, false]) {
    const expected = textureEvictExpected(rearm);
    const r = { ...honest, ...expected };
    pass(reloadTyped(r, rearm, [td], expected), "evict typed reload passes");
    if (rearm)
      assert(
        reloadTyped(r, true, [null], expected).includes("reload_sources_held"),
        "evict typed reload rejects missing rearm teardown",
      );
    for (const key of Object.keys(expected.candidates))
      fail(
        reloadTyped(
          { ...r, candidates: { ...r.candidates, [key]: 99 } },
          rearm,
          [td],
          expected,
        ),
        `evict candidate ${key} fails`,
      );
    for (const key of ["reloaded", "adopted_from_reload"])
      fail(
        reloadTyped({ ...r, [key]: 99 }, rearm, [td], expected),
        `evict outcome ${key} fails`,
      );
    pass(reloadNo1x1(rec, r), "evict no-1x1 passes");
    fail(reloadNo1x1(dummy, r), "evict no-1x1 reads released state");
    pass(reloadCensus([rec, rec, rec]), "evict census passes");
    fail(reloadCensus([rec, dummy, rec]), "evict census reads released state");
    pass(imageTextureRestored(probe, td, r), "evict restore passes");
    fail(
      imageTextureRestored(
        probe,
        { ...td, htr_restore: { ...td.htr_restore, restored: 0 } },
        r,
      ),
      "evict restore failure caught",
    );
    const evict = {
      final: true,
      released: rearm ? 4 : 8,
      noted: 16,
      released_armed: 0,
      pending: 0,
      parked: 0,
      evict_balanced: true,
      skipped: { already_released: rearm ? 6 : 0 },
    } as EvictEvidence;
    if (!rearm) {
      const e = {
        ...evict,
        releases: [{ path: "res://texture.ctex" }],
      } as EvictEvidence;
      const htr = { released: 1 } as HtrStats;
      pass(
        noImageTextureReleaseProblems(probe, htr, e, false),
        "once-arm ImageTexture keeps its content after arming",
      );
      fail(
        noImageTextureReleaseProblems(
          { ...probe, got: { ...probe.got!, width: 1, height: 1, format: 0 } },
          htr,
          e,
          false,
        ),
        "once-arm probe reads released state",
      );
      fail(
        noImageTextureReleaseProblems(
          probe,
          htr,
          { ...e, releases: [{ ...e.releases[0], path: "res://image.png" }] },
          false,
        ),
        "once-arm eviction path must end .ctex",
      );
    }
    const reloads = rearm ? [r, r] : [r];
    pass(evictRearmProblems(evict, rearm, reloads), "evict rearm passes");
    fail(evictRearmProblems(null, rearm, reloads), "missing evict fails");
    for (const key of [
      "released",
      "noted",
      "released_armed",
      "pending",
      "parked",
    ])
      fail(
        evictRearmProblems({ ...evict, [key]: 99 }, rearm, reloads),
        `evict ${key} fails`,
      );
    for (const key of ["final", "evict_balanced"])
      fail(
        evictRearmProblems({ ...evict, [key]: false }, rearm, reloads),
        `evict ${key} fails`,
      );
    if (rearm)
      fail(
        evictRearmProblems(
          { ...evict, skipped: { ...evict.skipped, already_released: 0 } },
          rearm,
          reloads,
        ),
        "evict already released fails",
      );
    fail(evictRearmProblems(evict, rearm, []), "missing reload arms fails");
    fail(
      evictRearmProblems(evict, rearm, [null, ...reloads]),
      "null reload fails",
    );
    fail(
      evictRearmProblems(evict, rearm, [
        { ...r, released_no_path: 1 },
        ...reloads,
      ]),
      "evict missing path fails",
    );
    fail(
      evictRearmProblems(evict, rearm, [
        { ...r, refused: { ...r.refused, released_no_path: 1 } },
        ...reloads,
      ]),
      "evict refused missing path fails",
    );
  }
  pass(imageTextureRestored(probe, td, honest), "restore passes");
  fail(imageTextureProbe(null), "missing probe fails");
  for (const [key, value] of Object.entries({
    format: 0,
    width: 1,
    height: 1,
    mipmaps: true,
    sha256: "b".repeat(64),
  }))
    fail(
      imageTextureProbe({ ...probe, got: { ...probe.got!, [key]: value } }),
      `probe ${key} fails`,
    );
  fail(imageTextureProbe({ ...probe, got: null }), "null probe image fails");
  for (const key of [
    "candidates",
    "restored",
    "unavailable",
    "mismatch",
    "not_placeholder",
  ])
    fail(
      imageTextureRestored(
        probe,
        { ...td, htr_restore: { ...td.htr_restore, [key]: 99 } },
        honest,
      ),
      `restore ${key} fails`,
    );
  fail(
    imageTextureRestored(probe, null, honest),
    "missing restore teardown fails",
  );
  fail(imageTextureRestored(probe, td, null), "missing restore reload fails");
  fail(
    imageTextureRestored(probe, td, { ...honest, released_no_path: 1 }),
    "unrestored path fails",
  );
  const mismatch = {
    ...honest,
    refused: { ...honest.refused, reload_mismatch: 1, total: 1 },
    entries: [{ ...entry, adopted: false, code: "reload-mismatch" }],
  };
  pass(reloadMismatchTyped(mismatch), "typed swap refusal passes");
  for (const r of [
    null,
    { ...mismatch, final: false },
    { ...mismatch, entries: [] },
    { ...mismatch, entries: [{ ...mismatch.entries[0], adopted: true }] },
    { ...mismatch, entries: [{ ...mismatch.entries[0], path: "x.ctex" }] },
  ])
    fail(reloadMismatchTyped(r), "bad swap refusal fails");
  for (const key of Object.keys(mismatch.refused))
    fail(
      reloadMismatchTyped({
        ...mismatch,
        refused: { ...mismatch.refused, [key]: 99 },
      }),
      `swap refusal ${key} fails`,
    );
  pass(
    faultReloadOffCaught(dummy, { ...honest, skipped: "fault-reload-off" }),
    "reload-off caught",
  );
  fail(
    faultReloadOffCaught(rec, { ...honest, skipped: "fault-reload-off" }),
    "whole negative recording fails",
  );
  fail(faultReloadOffCaught(dummy, honest), "wrong skip fails");
  const skipped = {
    ...honest,
    verify_skipped: 1,
    entries: [{ ...entry, loaded: { ...shape, width: 32 } }],
  };
  pass(faultSkipVerifyCaught(skipped), "skip verify caught");
  for (const r of [
    null,
    { ...skipped, verify_skipped: 0 },
    { ...skipped, entries: [entry] },
    { ...skipped, entries: [{ ...skipped.entries[0], adopted: false }] },
    { ...skipped, entries: [{ ...skipped.entries[0], path: "x.ctex" }] },
  ])
    fail(faultSkipVerifyCaught(r), "uncaught skip verify fails");
  const badProbe = {
    ...probe,
    got: { format: 0, width: 1, height: 1, mipmaps: false },
  };
  const skippedTd = {
    ...td,
    htr_restore: { ...td.htr_restore, skipped_fault: 1 },
  };
  const noPath = { ...honest, released_no_path: 1 };
  pass(
    faultSkipRestoreCaught(badProbe, skippedTd, noPath),
    "skip restore caught",
  );
  fail(
    faultSkipRestoreCaught(probe, skippedTd, noPath),
    "restored negative probe fails",
  );
  fail(
    faultSkipRestoreCaught(badProbe, td, noPath),
    "missing restore fault count fails",
  );
  fail(
    faultSkipRestoreCaught(badProbe, skippedTd, honest),
    "missing no-path refusal fails",
  );
  for (const [key, value] of Object.entries({
    width: 2,
    height: 2,
    mipmaps: true,
  }))
    fail(
      faultSkipRestoreCaught(
        { ...badProbe, got: { ...badProbe.got, [key]: value } },
        skippedTd,
        noPath,
      ),
      `placeholder ${key} fails`,
    );
  for (const [key, value] of Object.entries({
    width: 32,
    height: 32,
    mipmaps: true,
    sha256: "short",
  })) {
    const invalid = { ...probe.expected!, [key]: value };
    fail(
      imageTextureProbe({ ...probe, expected: invalid, got: invalid }),
      `invalid expected ${key} fails`,
    );
  }
  const undrawn = structuredClone(dummy);
  for (const tx of undrawn.transactions) tx.state.items = [];
  fail(reloadNo1x1(undrawn, honest), "undrawn published dummy still fails");
  pass(
    reloadNo1x1(rec, {
      ...honest,
      entries: [{ ...entry, adopted: false, loaded: null }],
    }),
    "unadopted refused source need not match",
  );
  fail(
    faultSkipRestoreCaught(
      { ...badProbe, got: { ...badProbe.got, format: 17 } },
      skippedTd,
      noPath,
    ),
    "non-L8 negative probe fails",
  );
}

// Warm judges: an honest shape and a negative shape for every predicate.
{
  const honest: WarmEvidence = {
    final: true,
    skipped: null,
    warm_balanced: true,
    held_entries: 0,
    decode_at_reference: 0,
    discarded_stale: 0,
    mispredicts: 0,
    reload_sources_left: 0,
    from_reload: 13,
    served_reload: 12,
    warm_complete: true,
    jobs: 18,
    arm_to_warm_complete_ms: 8,
    reload_us: 2000,
    discarded_superseded: 1,
    discarded_freed: 1,
    queued: 20,
  };
  const reload = {
    final: true,
    sources_balanced: true,
    reloaded: 13,
    adopted_from_reload: 12,
    dropped_freed: 1,
    dropped_unreferenced: 0,
    dropped_stale: 0,
  };
  assert(
    warmCompleteProblems(honest, [13, 12], true).length === 0,
    "warm workers pass",
  );
  assert(
    warmCompleteProblems(
      { ...honest, from_reload: 7, served_reload: 6 },
      [7, 6],
    ).length === 0,
    "warm once passes",
  );
  for (const bad of [
    null,
    ...[
      { skipped: "fault-warm-off" },
      { final: false },
      { warm_balanced: false },
      { held_entries: 1 },
      { decode_at_reference: 1 },
      { discarded_stale: 1 },
      { mispredicts: 1 },
      { reload_sources_left: 1 },
      { from_reload: 12 },
      { served_reload: 11 },
      { warm_complete: false },
      { jobs: 0 },
      { jobs: Number.NaN },
      { arm_to_warm_complete_ms: null },
      { arm_to_warm_complete_ms: Number.NaN },
      { arm_to_warm_complete_ms: 1 },
      { reload_us: Number.NaN },
      { reload_us: -1 },
    ].map((patch) => ({ ...honest, ...patch })),
  ])
    assert(
      warmCompleteProblems(bad, [13, 12], true).length > 0,
      "invalid warm completion fails",
    );
  assert(
    warmCompleteProblems({
      ...honest,
      warm_complete: false,
      jobs: 0,
      arm_to_warm_complete_ms: null,
    }).length === 0,
    "non-worker arm needs no worker completion",
  );
  const events = [{ event: "warm-probe", frame: 45 }];
  assert(
    warmInvalidationProblems(honest, events, 45).length === 0,
    "probe at K2 passes",
  );
  assert(
    warmInvalidationProblems(honest, events, 44).length === 0,
    "probe after K2 passes",
  );
  for (const bad of [
    null,
    ...[
      { final: false },
      { discarded_superseded: 0 },
      { discarded_superseded: 2 },
      { discarded_freed: 0 },
      { discarded_freed: Number.NaN },
      { discarded_stale: 1 },
    ].map((patch) => ({ ...honest, ...patch })),
  ])
    assert(
      warmInvalidationProblems(bad, events, 45).length > 0,
      "invalid warm discard fails",
    );
  for (const bad of [
    [],
    [{ event: "warm-probe", frame: 44 }],
    [{ event: "other", frame: 45 }],
    [{ event: "warm-probe", frame: Number.NaN }],
  ])
    assert(
      warmInvalidationProblems(honest, bad, 45).length > 0,
      "missing/early probe fails",
    );
  for (const k2 of [null, Number.NaN])
    assert(
      warmInvalidationProblems(honest, events, k2).length > 0,
      "missing K2 fails",
    );
  const off = {
    ...honest,
    skipped: "fault-warm-off",
    queued: 0,
    decode_at_reference: 12,
  };
  assert(
    faultWarmOffProblems(off, reload).length === 0,
    "warm-off caught by decode count",
  );
  for (const bad of [
    null,
    ...[
      { final: false },
      { skipped: null },
      { queued: 1 },
      { decode_at_reference: 11 },
      { decode_at_reference: Number.NaN },
    ].map((patch) => ({ ...off, ...patch })),
  ])
    assert(
      faultWarmOffProblems(bad, reload).length > 0,
      "invalid warm-off evidence fails",
    );
  for (const bad of [
    null,
    { ...reload, adopted_from_reload: 11, dropped_freed: 2 },
    { ...reload, sources_balanced: false },
    { ...reload, dropped_freed: 0 },
  ])
    assert(
      faultWarmOffProblems(off, bad).length > 0,
      "invalid warm-off reload fails",
    );
}

// Texture content identifies the cells independently of item order or node names.
{
  const names = [
    "curve_rf",
    "curve_xyz",
    "curve_rgb",
    "img_rh",
    "img_rgbah",
    "grad_hdr",
    "off_curve",
    "off_grad",
    "off_curve2",
    "off_grad2",
    "img_rgf",
    "img_rgh",
    "img_rgbh",
    "img_rgbaf_mip",
    "img_rf_odd",
    "hdr_bptc",
    "hdr_astc",
  ];
  const oracle: FloatHoldOracle[] = names.flatMap((name) =>
    [0, 1].map((step) => ({ name, step, payload_sha256: `${name}-${step}` })),
  );
  const s = state(0, 0);
  s.materials = [];
  s.textures = [];
  for (const [id, o] of oracle.entries()) {
    s.textures.push({ ...state(0, 0).textures[0], id, hash: o.payload_sha256 });
    s.materials.push({
      id,
      origin: "adopted",
      status: "ok",
      reason: null,
      version: 1,
      shader: null,
      params: [{ name: "src", type: "rid", value: { tex: id } }],
    });
  }
  assert(published(s, "curve_rf-0"), "published supported material texture");
  for (const mutate of [
    (x: State) => {
      x.materials![0].status = "unsupported";
    },
    (x: State) => {
      x.materials![0].params = [];
    },
    (x: State) => {
      x.textures[0].status = "unsupported";
    },
    (x: State) => {
      x.textures[0].hash = "other";
    },
  ]) {
    const bad = structuredClone(s);
    mutate(bad);
    assert(
      !published(bad, "curve_rf-0"),
      "unpublished unsupported/missing/stale texture",
    );
  }
  assert(!published(null, "h"), "missing published state fails");
  const tables = [1, 2, 3].map((k) => floatHoldCellTable(s, oracle, k)!);
  const faults = tables.map((t) =>
    Object.fromEntries(
      Object.entries(t).map(([cell, ns]) => [
        cell,
        Object.fromEntries(
          Object.keys(ns).map((name) => [name, cell === "control"]),
        ),
      ]),
    ),
  );
  for (const k of [1, 2, 3]) {
    assert(
      floatHoldCellProblems(tables[k - 1], k, "published").length === 0,
      "honest cell table passes",
    );
    assert(
      floatHoldCellProblems(faults[k - 1], k, "fault").length === 0,
      "fault cell table passes",
    );
    for (const mode of ["published", "fault"] as const) {
      assert(
        floatHoldCellProblems(null, k, mode).length > 0,
        "missing cell state fails",
      );
      for (const [cell, ns] of Object.entries(tables[k - 1]))
        for (const name of Object.keys(ns)) {
          const bad = structuredClone(
            mode === "published" ? tables[k - 1] : faults[k - 1],
          );
          bad[cell][name] = !bad[cell][name];
          assert(
            floatHoldCellProblems(bad, k, mode).length > 0,
            `${mode} ${cell}.${name} mutation caught`,
          );
          bad[cell][name] = null;
          assert(
            floatHoldCellProblems(bad, k, mode).length > 0,
            `${mode} missing oracle caught`,
          );
        }
    }
  }
  assert(floatHoldCellTable(null, oracle, 1) === null, "missing state table");
  assert(floatHoldCellTable(s, null, 1) === null, "missing oracle table");
  assert(
    floatHoldCellProblems(floatHoldCellTable(s, [], 1), 1, "published").length >
      0,
    "empty oracle fails",
  );
  const arms = [
    { first: 32, last: 62 },
    { first: 95, last: 125 },
    { first: 158, last: 188 },
  ];
  const steps = [
    { step: 0, applied_frame: 1, settle_frame: 8 },
    { step: 1, applied_frame: 77, settle_frame: 84 },
  ];
  assert(
    floatHoldSchedule(steps, arms).length === 0,
    "honest float hold schedule",
  );
  for (const bad of [
    null,
    [],
    [{ ...steps[0], settle_frame: 32 }, steps[1]],
    [steps[0], { ...steps[1], applied_frame: 62 }],
    [steps[0], { ...steps[1], settle_frame: 95 }],
    [steps[0], { step: 1, applied_frame: 77 }],
  ])
    assert(floatHoldSchedule(bad, arms).length > 0, "bad fill window fails");
  for (const bad of [null, [], [arms[0], arms[1], { first: 125, last: 188 }]])
    assert(floatHoldSchedule(steps, bad).length > 0, "bad arm window fails");
  const pending = {
    caps: { entries: 16, bytes: 262144 },
    taken: 15,
    taken_bytes: 21400,
    moved: 4,
    moved_bytes: 5120,
    dropped: { freed: 5, updated: 4, replaced: 2, recreated: 0 },
    dropped_bytes: 16280,
    evicted: 0,
    evicted_bytes: 0,
    skipped: {
      unregistered: 0,
      not_texture2d: 0,
      vram_format: 0,
      no_image: 0,
      size_unknown: 0,
      over_texture_cap: 0,
    },
    live: { entries: 0, bytes: 0 },
    peak: { entries: 9, bytes: 14744 },
    pending_balanced: true,
  };
  const h = {
    schema: "render-stream-hold/1",
    final: true,
    state: "active",
    reason: null,
    fault: "none",
    caps: { texture_max_bytes: 65535, total_max_bytes: 4194304 },
    live: { entries: 0, bytes: 0 },
    peak: { entries: 10, bytes: 18944 },
    taken: { total: 16, update: 10, replace: 6, bytes: 30720 },
    skipped: {
      unregistered: 0,
      not_texture2d: 0,
      offmain_replace: 0,
      released_source: 0,
      vram_format: 0,
      no_image: 0,
      size_unknown: 0,
      shape_mismatch: 0,
      over_texture_cap: 0,
      over_total_cap: 0,
    },
    dropped: {
      superseded: 6,
      unheld: 0,
      freed: 10,
      recreated: 0,
      replaced_away: 0,
      fault: 0,
    },
    dropped_bytes: 30720,
    hold_balanced: true,
    pending,
  };
  const fh = structuredClone(h);
  fh.fault = "hold-off";
  fh.peak = { entries: 8, bytes: 15360 };
  fh.dropped = {
    superseded: 3,
    unheld: 0,
    freed: 0,
    recreated: 0,
    replaced_away: 0,
    fault: 13,
  };
  const td = [
    { hold_entries: 7, hold_bytes: 13312 },
    { hold_entries: 10, hold_bytes: 17920 },
    { hold_entries: 10, hold_bytes: 17920 },
  ];
  const ftd = [
    { hold_entries: 2, hold_bytes: 2560 },
    { hold_entries: 0, hold_bytes: 0 },
    { hold_entries: 0, hold_bytes: 0 },
  ];
  // Change every required leaf individually, keeping other evidence honest.
  function mutations(value: unknown): unknown[] {
    if (value === null) return ["missing"];
    if (typeof value === "number") return [value + 1];
    if (typeof value === "boolean") return [!value];
    if (typeof value === "string") return ["wrong"];
    if (typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, v]) =>
      mutations(v).map((bad) => ({ ...value, [key]: bad })),
    );
  }
  for (const [leg, hold, teardown] of [
    ["standby", h, td],
    ["fault-hold-off", fh, ftd],
  ] as const) {
    assert(
      holdAccountingProblems(hold, [...teardown], leg).length === 0,
      `${leg} honest accounting`,
    );
    for (const bad of [null, ...mutations(hold)])
      assert(
        holdAccountingProblems(bad, [...teardown], leg).length > 0,
        `${leg} every accounting leaf mutation fails`,
      );
    for (const bad of [
      null,
      [],
      ...teardown.map((_, i) => teardown.map((t, j) => (i === j ? null : t))),
    ])
      assert(
        holdAccountingProblems(hold, bad, leg).length > 0,
        "missing teardown fails",
      );
    for (const bad of mutations(teardown[0]))
      assert(
        holdAccountingProblems(hold, [bad, ...teardown.slice(1)], leg).length >
          0,
        "teardown count mutation fails",
      );
  }
  for (const bad of [
    { ...h, live: { entries: 0, bytes: 4194305 } },
    { ...h, pending: { ...pending, live: { entries: 17, bytes: 262145 } } },
  ])
    assert(
      holdAccountingProblems(bad, td, "standby").length > 0,
      "above cap fails",
    );
  const warm = (k: number, fault: boolean) => {
    const tuple = fault
      ? k === 1
        ? [0, 0, 5, 0, 11, 11, 10, 0, 0, 0, 4, 14, 10, 4, 1, 1]
        : [0, 0, k === 2 ? 8 : 0, 0, 8, 8, 7, 0, 0, 0, 9, 16, 7, 9, 1, 1]
      : k === 1
        ? [5, 10752, 0, 5, 11, 16, 15, 5, 0, 0, 0, 15, 15, 0, 0, 0]
        : [10, 17920, 0, 10, 8, 18, 17, 10, 0, 0, 0, 17, 17, 0, 0, 0];
    const [
      held_at_arm,
      held_bytes_at_arm,
      hold_dropped_fault,
      from_hold,
      from_registry,
      queued,
      served,
      served_hold,
      lazy_from_hold,
      decode_at_reference,
      updated,
      adopted,
      current,
      creation,
      refused,
      refused_no_image,
    ] = tuple;
    return {
      schema: "render-stream-warm/1",
      final: true,
      arm_index: k,
      held_at_arm,
      held_bytes_at_arm,
      hold_dropped_fault,
      from_hold,
      from_registry,
      queued,
      served,
      served_hold,
      lazy_from_hold,
      decode_at_reference,
      lazy_at_reference: { updated },
      textures: { adopted, current, creation, refused, refused_no_image },
      scanned: { registered_2d: k === 1 ? 16 : 18 },
      dropped_unreferenced: 1,
      warm_balanced: true,
    };
  };
  for (const k of [1, 2, 3]) {
    const input = {
      equivalenceProblems: [],
      warm: warm(k, false),
      teardown: td[k - 1],
      oracleLines: oracle,
      state: s,
    };
    assert(
      floatHoldArmProblems(k, input, "standby").length === 0,
      "honest hold arm passes",
    );
    assert(
      floatHoldArmProblems(k, null, "standby").length > 0,
      "missing arm fails",
    );
    for (const key of Object.keys(input))
      assert(
        floatHoldArmProblems(k, { ...input, [key]: null }, "standby").length >
          0,
        `missing ${key} fails`,
      );
    for (const bad of mutations(input.warm))
      assert(
        floatHoldArmProblems(k, { ...input, warm: bad }, "standby").length > 0,
        "every warm leaf mutation fails",
      );
    assert(
      floatHoldArmProblems(
        k,
        { ...input, equivalenceProblems: ["different"] },
        "standby",
      ).length > 0,
      "nonempty equivalence fails honest arm",
    );
  }
  const fwarms = [1, 2, 3].map((k) => warm(k, true));
  const eqs = [["different"], ["different"], ["different"]];
  assert(
    faultHoldOffProblems(eqs, fwarms, fh, faults, "fault-hold-off").length ===
      0,
    "honest fault judge passes",
  );
  for (const [problems, warms, hold, tables] of [
    [null, fwarms, fh, faults],
    [eqs, null, fh, faults],
    [eqs, fwarms, null, faults],
    [eqs, fwarms, fh, null],
  ] as const)
    assert(
      faultHoldOffProblems(problems, warms, hold, tables, "fault-hold-off")
        .length > 0,
      "missing fault judge input fails",
    );
  for (let i = 0; i < 3; i++) {
    assert(
      faultHoldOffProblems(
        eqs.map((p, j) => (i === j ? [] : p)),
        fwarms,
        fh,
        faults,
        "fault-hold-off",
      ).length > 0,
      "fault must fail every arm",
    );
    for (const bad of mutations(fwarms[i]))
      assert(
        faultHoldOffProblems(
          eqs,
          fwarms.map((w, j) => (i === j ? bad : w)),
          fh,
          faults,
          "fault-hold-off",
        ).length > 0,
        "every fault warm leaf mutation fails",
      );
    assert(
      faultHoldOffProblems(
        eqs,
        fwarms,
        fh,
        faults.map((t, j) => (i === j ? null : t)),
        "fault-hold-off",
      ).length > 0,
      "missing fault arm state fails",
    );
  }
  const lines = [
    {
      event: "offmain-fill",
      variant: 1,
      frame: 0,
      off_main: true,
      thread_id: 2,
      main_thread_id: 1,
    },
    {
      event: "offmain-fill",
      variant: 2,
      frame: 45,
      off_main: true,
      thread_id: 3,
      main_thread_id: 1,
    },
  ];
  const off = { standby: lines, born: lines, arms };
  assert(offmainProblems(off, h, tables).length === 0, "honest offmain passes");
  for (const bad of [
    null,
    { ...off, standby: null },
    { ...off, born: null },
    { ...off, arms: null },
    { ...off, standby: lines.slice(0, 1) },
    { ...off, standby: [lines[0], { ...lines[1], frame: 95 }] },
    { ...off, standby: [{ ...lines[0], off_main: false }, lines[1]] },
    { ...off, born: [lines[0], { ...lines[1], thread_id: 1 }] },
  ])
    assert(
      offmainProblems(bad, h, tables).length > 0,
      "bad offmain proof fails",
    );
  assert(
    offmainProblems(off, null, tables).length > 0,
    "missing offmain hold fails",
  );
  assert(
    offmainProblems(off, h, null).length > 0,
    "missing offmain cells fails",
  );
  for (const bad of mutations(pending))
    assert(
      offmainProblems(off, { ...h, pending: bad }, tables).length > 0,
      "every pending leaf mutation fails offmain",
    );
  assert(
    offmainProblems(
      off,
      { ...h, skipped: { ...h.skipped, offmain_replace: 1 } },
      tables,
    ).length > 0,
    "offmain skip fails",
  );
}

if (failures > 0) {
  console.error(
    `self-test-gate8-rearm: ${failures} of ${assertions} assertions failed`,
  );
  process.exit(1);
}
console.log(`self-test-gate8-rearm: ${assertions} passed, 0 failed`);
