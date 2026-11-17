#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 8's g8vp checks (lib/gate8-vp-checks.ts) on synthetic evidence: the canonical
// viewport form and vp-equivalence on fabricated born/late resolved recordings (equal modulo the
// declared exceptions: ids, origin, raw active_seq, an adopted viewport's once_seq; and failing on
// a wrong sibling order, a proxy bound to the wrong viewport, a field, a created viewport's
// once_seq, a viewport's items, an unresolved proxy, a missing viewport); vp-account on fabricated
// result.json against expected.json (every honest leg passes; no-adjacency and no-node-route fail,
// wrong-order passes); vp-off on fabricated off/v15 legs; vp-sabotage's judgement; vp-validate on
// golden-16 and golden-15 vectors through the leg reader; and the group on an empty and on a partial
// tree (every check fails where evidence is missing, nothing throws).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-vp.ts

import "../lib/node-hash";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountProblems,
  canonicalVpState,
  compareVpStates,
  HONEST_LEGS,
  offProblems,
  readLeg,
  runG8vp,
  SUBWINDOW_RESIDUE_LAYER,
  sabotageProblems,
  sessionModuloVp,
  VIEWPORT_FAMILY,
  VP_EXCEPTIONS,
  VP_LEGS,
  VP_SABOTAGES,
  type VpExpected,
  type VpLegFacts,
  type VpResult,
  validateProblems,
  viewportKeys,
  vpEquivalence,
} from "../lib/gate8-vp-checks";
import type {
  ResolvedCanvas,
  ResolvedItem,
  ResolvedRecording,
  ResolvedTexture,
  ResolvedTransaction,
  ResolvedViewport,
} from "../lib/render-stream-2";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = join(SCRIPT_DIR, "..", "..");

let failures = 0;
let assertions = 0;
function expect(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}
const some = (ps: string[], re: RegExp) => ps.some((p) => re.test(p));

const ex = JSON.parse(
  readFileSync(
    join(EXPERIMENT_DIR, "fixtures/viewport-scene/expected.json"),
    "utf8",
  ),
) as VpExpected;

type State = ResolvedTransaction["state"];
const ID: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
const WHITE: [number, number, number, number] = [1, 1, 1, 1];

// ------------------------------------------------------------------------------- the builders

function item(
  id: number,
  draw_index: number,
  commands: Record<string, unknown>[],
): ResolvedItem {
  return {
    id,
    origin: "created",
    parent: null,
    children: [],
    visible: true,
    draw_index,
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
    xform: ID,
    modulate: WHITE,
    self_modulate: WHITE,
    custom_rect_rect: [0, 0, 0, 0],
    commands: commands as unknown as ResolvedItem["commands"],
  };
}

function canvas(id: number, items: number[], root = false): ResolvedCanvas {
  return {
    id,
    origin: root ? "root-query" : "created",
    role: root ? "root" : null,
    attached: root,
    layer: 0,
    sublayer: 0,
    items,
    xform: ID,
    modulate: WHITE,
  };
}

function tex(
  id: number,
  kind: ResolvedTexture["kind"],
  extra: Partial<ResolvedTexture>,
  origin: "created" | "adopted" = "created",
): ResolvedTexture {
  return {
    id,
    origin,
    adopted_content: origin === "adopted" ? "current" : null,
    kind,
    status: "ok",
    reason: null,
    version: 1,
    hash: null,
    format: null,
    source_format: null,
    width: 0,
    height: 0,
    mipmaps: false,
    payload_bytes: 0,
    variants: [],
    canvas: null,
    ...extra,
  };
}

function vp(
  id: number,
  parent: number | null,
  size: [number, number],
  active_seq: number,
  canvases: Array<[number, number, number]>,
  extra: Partial<ResolvedViewport> = {},
): ResolvedViewport {
  return {
    id,
    origin: "created",
    parent,
    active: true,
    active_seq,
    size,
    transparent: true,
    update: "always",
    once_seq: 0,
    clear: "always",
    clear_seq: 0,
    disable_2d: false,
    renders_3d: false,
    hdr_2d: false,
    msaa_2d: 0,
    canvas_cull_mask: 4294967295,
    default_texture_filter: "linear",
    default_texture_repeat: "disabled",
    snap_2d: [false, false],
    canvases,
    floats: {
      global_xform: [...ID],
      canvas_xforms: canvases.map(() => [...ID]),
    },
    ...extra,
  };
}

/** One synthetic scene, with every id shifted by `o` (late: 100) so only the bijection can match.
 * A (48x48, once) and B (32x32) under the root, C (16x16) nested in A; the root's two items show
 * A's and B's default proxies, A's canvas holds a rect, B's an image. */
interface SceneOpts {
  o: number;
  adopted: boolean;
  seqA: number;
  seqB: number;
  seqC: number;
  onceA: number;
  onceB?: number;
  proxyB?: "A" | "B" | "unresolved";
  transparentB?: boolean;
  rectA?: number[];
  dropC?: boolean;
}
function scene(s: SceneOpts): State {
  const o = s.o;
  const origin = s.adopted ? "adopted" : "created";
  const textures: ResolvedTexture[] = [
    tex(o + 50, "viewport", { viewport: o + 1 }, origin),
    tex(o + 51, "viewport", { viewport: o + 2 }, origin),
    tex(o + 53, "proxy", { target: o + 50 }, origin),
    s.proxyB === "unresolved"
      ? tex(
          o + 54,
          "proxy",
          { target: null, status: "unsupported", reason: "proxy-unresolved" },
          origin,
        )
      : tex(
          o + 54,
          "proxy",
          { target: s.proxyB === "A" ? o + 50 : o + 51 },
          origin,
        ),
    tex(o + 55, "image", {
      hash: "ab".repeat(32),
      format: "RGBA8",
      width: 4,
      height: 4,
      payload_bytes: 64,
    }),
  ];
  const viewports = [
    vp(o + 1, 0, [48, 48], s.seqA, [[o + 2, 0, 0]], {
      origin,
      update: "once",
      once_seq: s.onceA,
    }),
    vp(o + 2, 0, [32, 32], s.seqB, [[o + 3, 0, 0]], {
      origin,
      transparent: s.transparentB ?? true,
      once_seq: s.onceB ?? 0,
    }),
  ];
  if (!s.dropC) {
    textures.push(tex(o + 52, "viewport", { viewport: o + 3 }));
    viewports.push(vp(o + 3, o + 1, [16, 16], s.seqC, []));
  }
  return {
    status: "ok",
    failures: [],
    unsupported: [
      { op: "viewport_attach_camera", item: null, reason: "viewport-3d" },
    ],
    default_texture_filter: "linear",
    default_texture_repeat: "disabled",
    canvases: [
      canvas(o + 1, [o + 10, o + 11], true),
      canvas(o + 2, [o + 20]),
      canvas(o + 3, [o + 30]),
    ],
    items: [
      item(o + 10, 0, [
        {
          op: "add_texture_rect",
          tex: o + 53,
          rect: [0, 0, 48, 48],
          modulate: WHITE,
        },
      ]),
      item(o + 11, 1, [
        {
          op: "add_texture_rect",
          tex: o + 54,
          rect: [50, 0, 32, 32],
          modulate: WHITE,
        },
      ]),
      item(o + 20, 0, [
        { op: "add_rect", rect: s.rectA ?? [1, 1, 10, 10], color: WHITE },
      ]),
      item(o + 30, 0, [
        {
          op: "add_texture_rect",
          tex: o + 55,
          rect: [0, 0, 8, 8],
          modulate: WHITE,
        },
      ]),
    ],
    textures,
    meshes: [],
    shaders: [],
    materials: [],
    viewports,
  };
}

const BORN: SceneOpts = {
  o: 0,
  adopted: false,
  seqA: 1,
  seqB: 2,
  seqC: 3,
  onceA: 3,
};
// late: other ids, adopted origins, other raw active_seq values in the same sibling order, an
// adopted once viewport's once_seq 1 (born counted 3 switches before the arm)
const LATE: SceneOpts = {
  o: 100,
  adopted: true,
  seqA: 5,
  seqB: 6,
  seqC: 9,
  onceA: 1,
};

function cmp(late: Partial<SceneOpts>, born: Partial<SceneOpts> = {}) {
  return compareVpStates(
    canonicalVpState(scene({ ...BORN, ...born })),
    canonicalVpState(scene({ ...LATE, ...late })),
  );
}

// ------------------------------------------------------------------------------- canonical form
{
  const keys = viewportKeys(scene(BORN).viewports ?? []);
  expect(
    keys.get(1) === "root/48x48" &&
      keys.get(2) === "root/32x32" &&
      keys.get(3) === "root/48x48/16x16",
    `viewport keys by parent chain and size (${[...keys.values()]})`,
  );
  const twins = viewportKeys([
    vp(1, 0, [8, 8], 1, []),
    vp(2, 0, [8, 8], 2, [], { transparent: false }),
  ]);
  expect(
    new Set(twins.values()).size === 2,
    "same-size siblings get distinct keys",
  );
  const c = canonicalVpState(scene(BORN));
  expect(
    c.proxies.join(",") ===
      "proxy->viewport:root/32x32,proxy->viewport:root/48x48",
    `proxies name their target viewport (${c.proxies})`,
  );
  expect(
    c.viewports.get("root/48x48")?.canvases.length === 1,
    "a viewport's canvas rows are canonicalized",
  );
  expect(
    VP_EXCEPTIONS.length === 6 &&
      VP_EXCEPTIONS.some((e) => e.includes("active_seq")) &&
      VP_EXCEPTIONS.some((e) => e.includes("once_seq")),
    "the exception list names active_seq and once_seq",
  );
}

// ------------------------------------------------------------------------------- compareVpStates
{
  const r = cmp({});
  expect(
    r.problems.length === 0 && r.residue === 0,
    `late equals born modulo ids, origin, active_seq and adopted once_seq (${r.problems.slice(0, 3)})`,
  );
  // wrong-order: adoption activated B before A
  const wo = cmp({ seqA: 6, seqB: 5 });
  expect(
    some(wo.problems, /sibling order under root/),
    `wrong sibling order is caught (${wo.problems.slice(0, 2)})`,
  );
  expect(
    wo.problems.every((p) => /sibling order/.test(p)),
    `wrong sibling order is the only difference (${wo.problems})`,
  );
  const wrongProxy = cmp({ proxyB: "A" });
  expect(
    some(wrongProxy.problems, /proxies/) &&
      some(wrongProxy.problems, /commands/),
    `a proxy bound to the wrong viewport is caught (${wrongProxy.problems.slice(0, 2)})`,
  );
  const unresolved = cmp({ proxyB: "unresolved" });
  expect(
    some(unresolved.problems, /proxy:proxy-unresolved/),
    `an unresolved proxy is caught (${unresolved.problems.slice(0, 2)})`,
  );
  const field = cmp({ transparentB: false });
  expect(
    some(field.problems, /viewport root\/32x32: transparent/),
    `a viewport field difference is caught (${field.problems.slice(0, 2)})`,
  );
  // once_seq raw differences on a created viewport are not excused...
  const createdOnce = compareVpStates(
    canonicalVpState(scene({ ...BORN, onceB: 2 })),
    canonicalVpState(scene({ ...LATE, adopted: false, onceB: 1 })),
  );
  expect(
    some(createdOnce.problems, /once_seq 2 vs 1/),
    `a created viewport's once_seq is compared raw (${createdOnce.problems.slice(0, 2)})`,
  );
  // ...while an adopted one compares its advance from the first compared frame
  const base = {
    born: new Map([["root/48x48", 3]]),
    late: new Map([["root/48x48", 1]]),
  };
  const advanced = compareVpStates(
    canonicalVpState(scene({ ...BORN, onceA: 4 })),
    canonicalVpState(scene({ ...LATE, onceA: 2 })),
    base,
  );
  expect(
    advanced.problems.length === 0,
    `an adopted once viewport advancing in step passes (${advanced.problems})`,
  );
  const stuck = compareVpStates(
    canonicalVpState(scene({ ...BORN, onceA: 4 })),
    canonicalVpState(scene({ ...LATE, onceA: 1 })),
    base,
  );
  expect(
    some(stuck.problems, /once_seq advanced 1 vs 0/),
    `an adopted once viewport that does not advance is caught (${stuck.problems})`,
  );
  const items = cmp({ rectA: [2, 2, 10, 10] });
  expect(
    some(items.problems, /viewport root\/48x48: .*commands/),
    `a difference inside a viewport's canvas is caught (${items.problems.slice(0, 2)})`,
  );
  const missing = cmp({ dropC: true });
  expect(
    some(missing.problems, /viewport root\/48x48\/16x16: only in born/),
    `a viewport missing in late is caught (${missing.problems.slice(0, 2)})`,
  );
}

// ------------------------------------------------------------------------------- subwindow residue
/** `s` plus the root's subwindow canvas at `layer` holding one item with `commands` (the embedded
 * Window's texture-rect draw of A's default proxy by default). */
function withSubwindow(
  st: State,
  o: number,
  layer: number,
  commands?: Record<string, unknown>[],
): State {
  const c: ResolvedCanvas = {
    ...canvas(o + 4, [o + 40]),
    attached: true,
    layer,
  };
  return {
    ...st,
    canvases: [...st.canvases, c],
    items: [
      ...st.items,
      item(
        o + 40,
        0,
        commands ?? [
          {
            op: "add_texture_rect",
            tex: o + 53,
            rect: [500, 270, 48, 48],
            modulate: WHITE,
          },
        ],
      ),
    ],
  };
}
{
  const L = SUBWINDOW_RESIDUE_LAYER;
  const late = canonicalVpState(scene(LATE));
  const run = (born: State, lateState = late, layer: number | null = L) =>
    compareVpStates(
      canonicalVpState(born),
      lateState,
      undefined,
      layer ?? undefined,
    );
  const ok = run(withSubwindow(scene(BORN), 0, L));
  expect(
    ok.problems.length === 0 && ok.subwindow_excused === 1,
    `born's subwindow canvas at layer 1024 drawing an adopted viewport's proxy is excused (${ok.problems})`,
  );
  const off = run(withSubwindow(scene(BORN), 0, L), late, null);
  expect(
    some(off.problems, /root: canvas attached#1: only in born/),
    `without the declared residue it fails (${off.problems})`,
  );
  const otherLayer = run(withSubwindow(scene(BORN), 0, 1000));
  expect(
    some(otherLayer.problems, /only in born/) &&
      otherLayer.subwindow_excused === 0,
    `a born-only canvas at another layer is not excused (${otherLayer.problems})`,
  );
  const extra = run(
    withSubwindow(scene(BORN), 0, L, [
      { op: "add_texture_rect", tex: 53, rect: [0, 0, 8, 8], modulate: WHITE },
      { op: "add_rect", rect: [0, 0, 4, 4], color: WHITE },
    ]),
  );
  expect(
    some(extra.problems, /only in born/) && extra.subwindow_excused === 0,
    `anything else on the subwindow canvas is not excused (${extra.problems})`,
  );
  const notAdopted = compareVpStates(
    canonicalVpState(withSubwindow(scene(BORN), 0, L)),
    canonicalVpState(scene({ ...LATE, adopted: false })),
    undefined,
    L,
  );
  expect(
    some(notAdopted.problems, /only in born/),
    `a window viewport the late capture created (not adopted) is not excused (${notAdopted.problems})`,
  );
  const lateOnly = compareVpStates(
    canonicalVpState(scene(BORN)),
    canonicalVpState(withSubwindow(scene(LATE), 100, L)),
    undefined,
    L,
  );
  expect(
    some(lateOnly.problems, /only in late/),
    `a subwindow canvas present only in late still fails (${lateOnly.problems})`,
  );
  expect(
    ex.equivalence.subwindow_residue === true &&
      VP_EXCEPTIONS.some((e) => e.includes("1024")),
    "expected.json declares the residue and the exception list names it",
  );
}

// ------------------------------------------------------------------------------- vpEquivalence
function recording(states: [number, State][]): ResolvedRecording {
  return {
    schema: "render-stream-16-resolved/1",
    session_id: "0".repeat(32),
    stream_id: "1".repeat(32),
    transactions: states.map(([frame, state], i) => ({
      seq: i + 1,
      frame,
      encoding: "full",
      state,
    })),
    resources: [],
  };
}
{
  const born = recording([
    [1, scene(BORN)],
    [12, scene(BORN)],
    [14, scene({ ...BORN, onceA: 4 })],
    [20, scene({ ...BORN, onceA: 4 })],
  ]);
  const late = recording([
    [12, scene(LATE)],
    [14, scene({ ...LATE, onceA: 2 })],
    [20, scene({ ...LATE, onceA: 2 })],
  ]);
  const e = vpEquivalence(born, late, 12, 0);
  expect(
    e.problems.length === 0 && e.frames === 9 && e.viewports === 3,
    `vpEquivalence passes over frames 12..20 (${e.frames} frames, ${e.viewports} viewports: ${e.problems.slice(0, 3)})`,
  );
  expect(
    e.sibling_parents === 1,
    `one parent with ordered siblings (${e.sibling_parents})`,
  );
  const wrong = recording([
    [12, scene({ ...LATE, seqA: 6, seqB: 5 })],
    [20, scene({ ...LATE, seqA: 6, seqB: 5 })],
  ]);
  const w = vpEquivalence(born, wrong, 12, 0);
  expect(
    w.problems.length > 0 && some(w.problems, /sibling order/),
    "vpEquivalence catches the wrong-order sabotage",
  );
  const early = vpEquivalence(born, late, 10, 0);
  expect(
    some(early.problems, /late has no transaction yet/),
    "vpEquivalence before the late recording starts is a problem",
  );
  const none = vpEquivalence(recording([]), recording([]), 12, 0);
  expect(
    some(none.problems, /no frame compared/),
    "empty recordings compare nothing (a problem)",
  );
}

// ------------------------------------------------------------------------------- accountProblems
function resultFor(
  leg: keyof typeof ex.account,
  over: Record<string, number | string | boolean> = {},
  stats: Record<string, number> = {},
): VpResult {
  const a = ex.account[leg];
  const viewports: Record<string, number | string | boolean> = {
    proxies: 0,
    proxies_bound_rid: 0,
    proxies_bound_adjacency: 0,
    proxies_bound_texture: 0,
    proxies_bound_node_route: 0,
    proxies_adopted: 0,
    proxies_unresolved: 0,
    node_route_tried: 0,
    unresolved_now: 0,
    // the evidence is written after the scene's teardown freed every viewport (as on the host)
    freed: Number(a.viewports.created ?? 0) + Number(a.viewports.adopted ?? 0),
    ...a.viewports,
    ...Object.fromEntries(Object.entries(a.min ?? {})),
    ...over,
  };
  return {
    stream: {
      status: "ok",
      gate8: {
        viewports,
        adopt_stats: { ran: true, ...(a.adopt_stats ?? {}), ...stats },
      },
    },
  };
}
function finalState(n: number, unresolved = 0): State {
  const s = scene(BORN);
  return {
    ...s,
    viewports: Array.from({ length: n }, (_, i) =>
      vp(i + 1, 0, [i + 1, 1], i + 1, []),
    ),
    textures: [
      ...s.textures,
      ...Array.from({ length: unresolved }, (_, i) =>
        tex(900 + i, "proxy", {
          status: "unsupported",
          reason: "proxy-unresolved",
          target: null,
        }),
      ),
    ],
  };
}
const liveCount = (leg: keyof typeof ex.account) =>
  Number(ex.account[leg].viewports.created ?? 0) +
  Number(ex.account[leg].viewports.adopted ?? 0);
{
  for (const leg of HONEST_LEGS) {
    const spec = VP_LEGS[leg];
    const p = accountProblems(
      resultFor(leg),
      ex.account[leg],
      finalState(liveCount(leg)),
      spec.host === "headless",
    );
    expect(p.length === 0, `vp-account passes on a fabricated ${leg} (${p})`);
  }
  // no-adjacency: born's constructor proxies bind by nothing (on the dummy they stay unresolved)
  const noAdj = accountProblems(
    resultFor("born", { proxies_bound_adjacency: 0 }),
    ex.account.born,
    finalState(13, 13),
    true,
  );
  expect(
    some(noAdj, /proxies_bound_adjacency 0, expected >= 13/) &&
      some(noAdj, /13 proxy-unresolved entries in the final/),
    `vp-account catches no-adjacency (${noAdj})`,
  );
  const noAdjHidden = accountProblems(
    resultFor("born", { proxies_bound_adjacency: 0 }),
    ex.account.born,
    finalState(13),
    true,
  );
  expect(
    noAdjHidden.length === 1,
    `the adjacency floor alone catches no-adjacency (${noAdjHidden})`,
  );
  const noNode = accountProblems(
    resultFor("late", { proxies_bound_node_route: 0 }),
    ex.account.late,
    finalState(13, 1),
    true,
  );
  expect(
    some(noNode, /proxies_bound_node_route 0, expected >= 1/) &&
      some(noNode, /1 proxy-unresolved entry/),
    `vp-account catches no-node-route (${noNode})`,
  );
  const wrongOrder = accountProblems(
    resultFor("late"),
    ex.account.late,
    finalState(13),
    true,
  );
  expect(
    wrongOrder.length === 0,
    `vp-account passes the wrong-order sabotage's account (${wrongOrder})`,
  );
  const notAdopted = accountProblems(
    resultFor("late", {}, { non_root_viewports: 11, viewports_adopted: 0 }),
    ex.account.late,
    finalState(13),
    true,
  );
  expect(
    some(notAdopted, /adopt_stats.non_root_viewports 11/) &&
      some(notAdopted, /adopt_stats.viewports_adopted 0/),
    `vp-account catches viewports the walk did not adopt (${notAdopted})`,
  );
  const table = accountProblems(
    resultFor("born"),
    ex.account.born,
    finalState(12),
    true,
  );
  expect(
    some(table, /final viewport table holds 12, created \+ adopted = 13/),
    `vp-account checks the final resolved table against created + adopted (${table})`,
  );
  const freedNone = accountProblems(
    resultFor("born", { freed: 0 }),
    ex.account.born,
    finalState(13),
    true,
  );
  expect(
    freedNone.length === 0,
    `freed is not expected to be 0 or 13, only bounded (${freedNone})`,
  );
  const freedTooMany = accountProblems(
    resultFor("born", { freed: 14 }),
    ex.account.born,
    finalState(13),
    true,
  );
  expect(
    some(freedTooMany, /viewports.freed 14, expected 0..13/),
    `freed beyond created + adopted fails (${freedTooMany})`,
  );
  const rendered = accountProblems(
    resultFor("born-rendered", { proxies_bound_rid: 0 }),
    ex.account["born-rendered"],
    finalState(13, 2),
    false,
  );
  expect(
    rendered.length === 1 && some(rendered, /proxies_bound_rid 0/),
    `rendered legs need RID binding, not zero unresolved (${rendered})`,
  );
  expect(
    some(
      accountProblems({}, ex.account.born, undefined, true),
      /no stream.gate8.viewports/,
    ),
    "a result.json without stream.gate8.viewports fails",
  );
  expect(
    some(
      accountProblems(resultFor("off"), undefined, undefined, true),
      /no expectation/,
    ),
    "a leg without expectations fails",
  );
}

// ------------------------------------------------------------------------------- offProblems
function stripVp(s: State): State {
  const { viewports: _v, ...rest } = s;
  return {
    ...rest,
    textures: s.textures.filter((t) => t.kind === "image"),
    unsupported: [
      { op: "viewport_attach_canvas", item: null, reason: "non-root-viewport" },
    ],
  };
}
function legFacts(
  leg: "off" | "v15",
  states: [number, State][],
  over: Partial<VpLegFacts> = {},
): VpLegFacts {
  const rec = recording(states);
  const family = [...VIEWPORT_FAMILY];
  return {
    leg,
    ran: true,
    exit_code: "0",
    errors: [],
    session: {
      type: "session",
      protocol: leg === "off" ? "render-stream/16" : "render-stream/15",
      session_id: leg === "off" ? "a".repeat(32) : "b".repeat(32),
      stream: { stream_id: leg, transport: "file" },
      capture: {
        hooks_planned: ["canvas_create", ...(leg === "v15" ? family : [])],
        hooks_omitted: [],
      },
      ...(leg === "off" ? { viewports: "off" } : {}),
    },
    metas: rec.transactions.map((t) => ({
      type: "transaction",
      seq: t.seq,
      textures: t.state.textures,
      unsupported: t.state.unsupported,
    })),
    rec,
    result: null,
    arm: [],
    ...over,
  };
}
{
  const s1 = stripVp(scene(BORN));
  const s2 = stripVp(scene({ ...BORN, rectA: [3, 3, 9, 9] }));
  const off = legFacts("off", [
    [1, s1],
    [5, s2],
  ]);
  const v15 = legFacts("v15", [
    [1, s1],
    [5, s2],
  ]);
  const ok = offProblems(off, v15);
  expect(ok.length === 0, `vp-off passes on equal off and v15 legs (${ok})`);
  expect(
    JSON.stringify(sessionModuloVp(off.session)) ===
      JSON.stringify(sessionModuloVp(v15.session)),
    "the sessions are equal modulo protocol, viewports, ids and the viewport hook family",
  );
  const withKey = offProblems(
    {
      ...off,
      metas: [...off.metas, { type: "transaction", seq: 3, viewports: [] }],
    },
    v15,
  );
  expect(
    some(withKey, /transaction key viewports/),
    "vp-off catches a viewports key",
  );
  const withKind = offProblems(
    {
      ...off,
      metas: [
        ...off.metas,
        { type: "transaction", seq: 4, textures: [{ kind: "proxy" }] },
      ],
    },
    v15,
  );
  expect(some(withKind, /a proxy texture/), "vp-off catches a proxy texture");
  const withReason = offProblems(
    {
      ...off,
      metas: [
        {
          type: "transaction",
          seq: 1,
          unsupported: [
            { op: "viewport_attach_camera", item: null, reason: "viewport-3d" },
          ],
        },
      ],
    },
    v15,
  );
  expect(
    some(withReason, /unsupported viewport-3d/) &&
      some(withReason, /no session-level non-root-viewport/),
    `vp-off catches a viewport-* reason and the missing /15 typing (${withReason})`,
  );
  const drift = offProblems(
    legFacts("off", [
      [1, s1],
      [5, s1],
    ]),
    v15,
  );
  expect(
    some(drift, /frame 5: the resolved state differs/),
    `vp-off catches a resolved state that differs from v15's (${drift})`,
  );
  const sessionDrift = offProblems(
    {
      ...off,
      session: {
        ...(off.session ?? {}),
        capture: {
          hooks_planned: ["canvas_create", "mesh_create"],
          hooks_omitted: [],
        },
      },
    },
    v15,
  );
  expect(
    some(
      sessionDrift,
      /session differs from v15's beyond protocol\/viewports: capture/,
    ),
    `vp-off catches a session difference outside the viewport family (${sessionDrift})`,
  );
  const notOff = offProblems(
    { ...off, session: { ...(off.session ?? {}), viewports: "on" } },
    v15,
  );
  expect(
    some(notOff, /off session viewports "on"/),
    "vp-off needs viewports off",
  );
  expect(
    some(
      offProblems({ ...off, ran: false }, v15),
      /g8vp\/off\/capture did not run/,
    ),
    "vp-off without the off leg fails",
  );
}

// ------------------------------------------------------------------------------- sabotageProblems
{
  const fail = ["x"];
  for (const kind of Object.keys(
    VP_SABOTAGES,
  ) as (keyof typeof VP_SABOTAGES)[]) {
    const s = VP_SABOTAGES[kind];
    const caught: Record<string, string[]> = { [s.target]: fail };
    for (const id of s.must_pass) caught[id] = [];
    expect(
      sabotageProblems(kind, caught).length === 0,
      `${kind}: caught by ${s.target} and passing ${s.must_pass}: detected`,
    );
    const missed: Record<string, string[]> = { ...caught, [s.target]: [] };
    expect(
      some(sabotageProblems(kind, missed), /passed on the sabotage leg/),
      `${kind}: ${s.target} passing is a problem`,
    );
    const collateral: Record<string, string[]> = {
      ...caught,
      [s.must_pass[0]]: ["broken"],
    };
    expect(
      some(sabotageProblems(kind, collateral), /failed too/),
      `${kind}: ${s.must_pass[0]} failing too is a problem`,
    );
  }
  expect(
    VP_SABOTAGES["no-adjacency"].target === "vp-account" &&
      VP_SABOTAGES["no-node-route"].target === "vp-account" &&
      VP_SABOTAGES["wrong-order"].target === "vp-equivalence",
    "each sabotage's target check",
  );
}

// ------------------------------------------------------------------------------- the leg reader + vp-validate
const tmp = mkdtempSync(join(tmpdir(), "self-test-gate8-vp-"));
try {
  const g = join(tmp, "g8vp");
  const put = (leg: string, golden: string, name: string, arm?: object[]) => {
    const dir = join(g, leg, "capture");
    mkdirSync(join(dir, "evidence"), { recursive: true });
    copyFileSync(join(EXPERIMENT_DIR, "protocol", golden), join(dir, name));
    writeFileSync(join(dir, "exit-code.txt"), "0\n");
    if (arm)
      writeFileSync(
        join(dir, "arm.jsonl"),
        arm.map((a) => JSON.stringify(a)).join("\n"),
      );
  };
  put("born", "golden-16/viewports.rs16", "recording.rs16");
  put("v15", "golden-15/full.rs15", "recording.rs15");
  put("late", "golden-16/viewports.rs16", "recording.rs16", [
    {
      event: "arm-call",
      frame: 1,
      code: 0,
      state_before: "standby",
      state_after: "arming",
    },
    { event: "armed", frame: 1 },
  ]);
  put(
    "born-rendered",
    "golden-16/invalid/proxy-target-dangling.rs16",
    "recording.rs16",
  );
  put("late-rendered", "golden-16/viewports.rs16", "recording.rs16", [
    { event: "arm-call", frame: 3, code: 2, state_before: "armed" },
  ]);

  const born = await readLeg(g, "born");
  const pb = validateProblems(born, VP_LEGS.born, 12);
  expect(
    pb.length === 0 && (born.rec?.transactions.length ?? 0) > 0,
    `vp-validate passes golden-16/viewports.rs16 as a born leg (${pb})`,
  );
  const v15 = await readLeg(g, "v15");
  const pv = validateProblems(v15, VP_LEGS.v15, 12);
  expect(
    pv.length === 0,
    `vp-validate passes golden-15/full.rs15 as the v15 leg (${pv})`,
  );
  const asOff = validateProblems(born, VP_LEGS.off, 12);
  expect(
    some(asOff, /session viewports "on", want "off"/),
    "vp-validate needs viewports off on the off leg",
  );
  const late = await readLeg(g, "late");
  const pl = validateProblems(late, VP_LEGS.late, 1);
  expect(
    pl.length === 0,
    `vp-validate passes a late leg armed through the API (${pl})`,
  );
  const lateWrongK = validateProblems(late, VP_LEGS.late, 12);
  expect(
    some(lateWrongK, /arm\(\) called at frame 1, want 12/) &&
      some(lateWrongK, /first transaction at frame 1/),
    `vp-validate checks the API arm frame (${lateWrongK})`,
  );
  const bad = await readLeg(g, "born-rendered");
  expect(
    some(validateProblems(bad, VP_LEGS["born-rendered"], 12), /proxy-target/),
    "vp-validate reports a validator failure",
  );
  const lr = await readLeg(g, "late-rendered");
  const plr = validateProblems(lr, VP_LEGS["late-rendered"], 3);
  expect(
    some(plr, /arm\(\) returned 2/) &&
      some(plr, /from state armed/) &&
      some(plr, /no armed signal/),
    `vp-validate catches a refused API arm (${plr})`,
  );
  const off = await readLeg(g, "off");
  expect(
    !off.ran && some(validateProblems(off, VP_LEGS.off, 12), /did not run/),
    "a leg that did not run fails vp-validate",
  );

  // the group on this partial tree and on an empty one: every check fails, nothing throws
  writeFileSync(
    join(tmp, "legs.json"),
    JSON.stringify({ groups_run: ["g8vp"] }),
  );
  const partial = await runG8vp(tmp, ex);
  const ids = partial.checks.map((c) => c.id).join(",");
  expect(
    ids === "vp-validate,vp-equivalence,vp-account,vp-off,vp-sabotage",
    `the group emits its five checks (${ids})`,
  );
  expect(
    partial.checks.every((c) => !c.passed),
    `every check fails on a partial tree (${partial.checks.filter((c) => c.passed).map((c) => c.id)})`,
  );
  const empty = mkdtempSync(join(tmpdir(), "self-test-gate8-vp-empty-"));
  try {
    const r = await runG8vp(empty, ex);
    expect(
      r.checks.length === 5 && r.checks.every((c) => c.status === "fail"),
      "every check fails on an empty tree",
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// expected.json's own shape: the legs it accounts are the honest legs, the viewports add up
{
  expect(
    HONEST_LEGS.every((l) => ex.account[l] !== undefined),
    "expected.json accounts every honest leg",
  );
  const pre = Object.keys(ex.viewports.pre_arm).length;
  const post = Object.keys(ex.viewports.post_arm).length;
  expect(
    ex.account.born.viewports.created === pre + post &&
      ex.account.late.viewports.adopted === pre &&
      ex.account.late.viewports.created === post,
    "born creates every viewport; late adopts the pre-arm ones and creates the rest",
  );
  const sizes = [
    ...Object.values(ex.viewports.pre_arm),
    ...Object.values(ex.viewports.post_arm),
  ].map((s) => s.join("x"));
  expect(
    new Set(sizes).size === sizes.length,
    "every fixture viewport has its own size (the equivalence key)",
  );
  expect(
    ex.checkpoints.length === 4 && ex.arm_frame === 12,
    "four checkpoints, K = 12",
  );
}

if (failures > 0) {
  console.error(
    `self-test-gate8-vp: ${failures} of ${assertions} assertion(s) failed`,
  );
  process.exitCode = 1;
} else {
  console.log(`self-test-gate8-vp: ${assertions} assertions passed`);
}
