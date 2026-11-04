#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 8's g8tag2 checks (lib/gate8-tag2-checks.ts, runG8tag2): a fabricated g8tag2
// tree (client-ext.json reports + PNG shots per leg) on which every check passes, then mutations
// that must fail each check id (override-oracle, identity-override, frz-holds, override-redraw,
// override-dispose-rss, pointer-map, pointer-letterbox, and the sabotage-*-caught checks), an
// entirely empty tree (every gating check fails), and a tier-skipped sabotage leg (not-run).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-tag2.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import { runG8tag2 } from "../lib/gate8-tag2-checks";

let failures = 0;
let assertions = 0;
function expect(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

const W = 400;
const H = 225;
type Img = Uint8Array;
const gray = (): Img => {
  const d = new Uint8Array(W * H * 4);
  for (let i = 0; i < d.length; i += 4) d.set([50, 50, 50, 255], i);
  return d;
};
const paint = (d: Img, x: number, y: number, w: number, h: number, rgb: number[]) => {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) d.set([...rgb, 255], (yy * W + xx) * 4);
};
const ART = [204, 77, 51];
const POINTS: Record<string, [number, number]> = {
  "raised-art-centre": [100, 80],
  "scaled-art-corner": [210, 95],
  "plain-art-centre": [300, 100],
};
const baseShot = (): Img => {
  const d = gray();
  for (const p of Object.values(POINTS)) paint(d, p[0] - 2, p[1] - 2, 5, 5, ART);
  return d;
};
// Each variant makes a distinct change to the base picture.
const VARIANT_AT: Record<string, [number, number, number[]]> = {
  moved: [10, 10, [255, 0, 0]],
  scaled: [30, 10, [0, 255, 0]],
  hidden: [50, 10, [0, 0, 255]],
  tinted: [70, 10, [255, 255, 0]],
};
const variantShot = (v: string): Img => {
  const d = baseShot();
  const [x, y, rgb] = VARIANT_AT[v];
  paint(d, x, y, 8, 8, rgb);
  return d;
};

const counters = (o: Record<string, unknown> = {}) => ({
  overridesSet: 6,
  beforeDraws: 100,
  nullFrames: 0,
  sessions: ["s1"],
  itemMetaRows: 10,
  anim: { startedAt: null, steps: 0, endedAt: null, binaryDuring: 0, acksDuring: 0 },
  ...o,
});
const rep = (o: Record<string, unknown> = {}): Record<string, any> => ({
  ended: true,
  first_frame: true,
  statuses: [],
  counters: counters(),
  ...o,
});
const animCounters = () =>
  counters({
    nullFrames: 20,
    anim: { startedAt: 100, steps: 20, endedAt: 400, binaryDuring: 0, acksDuring: 0 },
  });

function probe(): Record<string, any> {
  const mk = (
    name: string,
    slot: number,
    item: number,
    game: [number, number],
    drawn: [number, number],
    overridden: boolean,
  ) => ({
    name,
    slot,
    item,
    overridden,
    game,
    drawn,
    got: { item, itemSlot: String(slot), itemPath: "x", point: game, drawn },
    cssToPresentation: drawn,
    hitTest: item,
  });
  return {
    presentation: [W, H],
    css: [700, 500],
    scale: 1.2,
    cases: [
      mk("raised-art-centre", 1, 11, [100, 100], POINTS["raised-art-centre"], true),
      mk("raised-panel-bottom", 1, 12, [100, 150], [100, 130], true),
      mk("scaled-art-corner", 2, 21, [200, 100], POINTS["scaled-art-corner"], true),
      mk("plain-art-centre", 4, 41, POINTS["plain-art-centre"], POINTS["plain-art-centre"], false),
    ],
    vacated: {
      game: [100, 110],
      got: { item: null, itemSlot: "0", point: [100, 110] },
    },
    letterbox: [
      { name: "bar-left", inBox: true, cssToPresentation: null, clientToGame: null },
      { name: "bar-right", inBox: true, cssToPresentation: null, clientToGame: null },
      { name: "outside-box", inBox: false, cssToPresentation: null, clientToGame: null },
    ],
    corners: { a: { x: 0.5, y: 0.5 }, b: { x: W - 0.5, y: H - 0.5 } },
    overlay: {
      got: { x: 10, y: 20, w: 30, h: 40 },
      want: { x: 10, y: 20, w: 30, h: 40 },
    },
  };
}

interface Tree {
  reports: Record<string, Record<string, any> | null>;
  shots: Record<string, Img | null>;
  markers: Record<string, string>;
}

function good(): Tree {
  const t: Tree = { reports: {}, shots: {}, markers: {} };
  t.reports["variant-base"] = rep();
  t.shots["variant-base"] = baseShot();
  for (const v of Object.keys(VARIANT_AT)) {
    t.reports[`variant-${v}`] = rep();
    t.shots[`variant-${v}`] = variantShot(v);
    t.reports[`ext-${v}`] = rep();
    t.shots[`ext-${v}`] = variantShot(v);
  }
  t.reports.identity = rep({ counters: counters({ overridesSet: 6 }) });
  t.shots.identity = baseShot();
  // ext-frz holds Hand's move, so it differs from the base.
  t.reports["ext-frz"] = rep({ counters: counters({ overridesSet: 1 }) });
  t.shots["ext-frz"] = variantShot("moved");
  t.reports.redraw = rep({ counters: animCounters() });
  t.shots.redraw = variantShot("moved");
  t.reports.dispose = rep({
    mounts: [
      { extension: "none", renderer_rss_mib: 100, overrides: 0 },
      { extension: "moved", renderer_rss_mib: 105, overrides: 3 },
      { extension: "moved", renderer_rss_mib: 110, overrides: 3 },
    ],
  });
  for (const leg of ["inp", "inp-wide"]) {
    t.reports[leg] = rep({ probe: probe() });
    t.shots[leg] = baseShot();
  }
  // Sabotage legs: each draws wrong where its check looks.
  const wrongMoved = variantShot("moved");
  paint(wrongMoved, 200, 200, 20, 20, [9, 9, 9]);
  for (const s of ["override-no-inherit", "override-fast-path-miss"]) {
    t.reports[`sabotage-${s}`] = rep();
    t.shots[`sabotage-${s}`] = wrongMoved;
  }
  const sabProbe = probe();
  for (const c of sabProbe.cases)
    if (c.overridden) c.got.point = c.drawn; // returned unmapped
  t.reports["sabotage-inverse-skip"] = rep({ probe: sabProbe });
  t.shots["sabotage-inverse-skip"] = baseShot();
  t.reports["sabotage-override-no-damage"] = rep({ counters: animCounters() });
  t.shots["sabotage-override-no-damage"] = baseShot(); // never reached the move
  t.reports["sabotage-frozen-still-applies"] = rep({ counters: counters({ overridesSet: 1 }) });
  t.shots["sabotage-frozen-still-applies"] = baseShot(); // the move applied == base? see below
  return t;
}

async function write(t: Tree): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "self-test-gate8-tag2-"));
  const put = (p: string, c: string | Buffer) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  };
  for (const [leg, r] of Object.entries(t.reports))
    if (r !== null) put(join(root, leg, "page", "client-ext.json"), JSON.stringify(r));
  for (const [leg, d] of Object.entries(t.shots))
    if (d !== null)
      put(
        join(root, leg, "page", "shot.png"),
        await sharp(Buffer.from(d), { raw: { width: d.length / 4 / H, height: H, channels: 4 } })
          .png()
          .toBuffer(),
      );
  for (const [leg, m] of Object.entries(t.markers)) put(join(root, leg, m), "x\n");
  return root;
}

async function run(t: Tree) {
  const root = await write(t);
  try {
    return await runG8tag2(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const IDS = [
  "override-oracle",
  "identity-override",
  "frz-holds",
  "override-redraw",
  "override-dispose-rss",
  "pointer-map",
  "pointer-letterbox",
  "sabotage-inverse-skip-caught",
  "sabotage-override-no-inherit-caught",
  "sabotage-override-fast-path-miss-caught",
  "sabotage-override-no-damage-caught",
  "sabotage-frozen-still-applies-caught",
];

const goodTree = () => {
  const t = good();
  // frozen-still-applies: the sabotage applies Hand's move, so its shot equals variant-base's
  // (was not held); the honest ext-frz differs from base. Already so: sabotage shot == base.
  return t;
};

async function main() {
  const base = await run(goodTree());
  for (const id of IDS) {
    const c = base.find((x) => x.id === id);
    expect(c?.passed === true && c.status === "pass", `good tree: ${id} passes (${c?.detail})`);
  }
  expect(
    base.find((x) => x.id === "sabotage-frozen-sweeps-caught")?.status === "not-run",
    "frozen-sweeps is a not-run constant",
  );
  expect(base.every((c) => c.passed), "good tree: nothing fails");

  const bad = async (
    what: string,
    id: string,
    mutate: (t: Tree) => void,
    match?: RegExp,
  ) => {
    const t = goodTree();
    mutate(t);
    const cs = await run(t);
    const c = cs.find((x) => x.id === id);
    expect(
      c !== undefined && !c.passed && c.status === "fail" && c.gating === true,
      `${what}: ${id} fails (${c?.status} ${c?.detail})`,
    );
    if (match) expect(match.test(c?.detail ?? ""), `${what}: detail names ${match} (${c?.detail})`);
  };

  // override-oracle
  const oracle = "override-oracle";
  await bad("ext-moved shot beyond 1", oracle, (t) => {
    const d = variantShot("moved");
    paint(d, 150, 150, 4, 4, [0, 0, 0]);
    t.shots["ext-moved"] = d;
  });
  await bad("ext-tinted missing shot", oracle, (t) => (t.shots["ext-tinted"] = null), /shot is missing/);
  await bad("ext-hidden missing report", oracle, (t) => (t.reports["ext-hidden"] = null), /no client-ext/);
  await bad("ext-moved sets no override", oracle, (t) => (t.reports["ext-moved"] = rep({ counters: counters({ overridesSet: 0 }) })), /no override set/);
  await bad("ext-moved has no item_meta grant", oracle, (t) => (t.reports["ext-moved"] = rep({ counters: counters({ sessions: [null] }) })), /grant/);
  await bad("ext-moved report without counters", oracle, (t) => delete t.reports["ext-moved"]!.counters, /no counters/);
  await bad("ext-moved did not end", oracle, (t) => (t.reports["ext-moved"] = rep({ ended: false })), /did not end/);
  await bad("variant-hidden draws the base scene", oracle, (t) => {
    t.shots["variant-hidden"] = baseShot();
    t.shots["ext-hidden"] = baseShot();
  }, /made no change/);
  await bad("variant-base of another size", oracle, (t) => {
    // a size mismatch makes the variant-vs-base diff null, which is no evidence
    t.shots["variant-base"] = new Uint8Array(40 * H * 4);
  });
  await bad("ext-moved of another size", oracle, (t) => (t.shots["ext-moved"] = new Uint8Array(40 * H * 4)));
  await bad("whole scaled pair differs with no text", oracle, (t) => {
    const d = variantShot("scaled");
    paint(d, 150, 150, 4, 4, [0, 0, 0]); // dark pixels: no ink
    t.shots["ext-scaled"] = d;
  }, /glyph band/);
  {
    // scaled: differences inside the ink box that agree within 1px pass the glyph band.
    const t = goodTree();
    const mk = (inner: number) => {
      const d = variantShot("scaled");
      paint(d, 150, 150, 10, 10, [220, 220, 220]);
      d.set([inner, inner, inner, 255], (155 * W + 155) * 4);
      return d;
    };
    t.shots["variant-scaled"] = mk(255);
    t.shots["ext-scaled"] = mk(100);
    const c = (await run(t)).find((x) => x.id === oracle);
    expect(c?.passed === true, `scaled glyph pixels inside the ink band pass (${c?.detail})`);
    // ... but an ink box off by more than 1px per edge fails.
    const t2 = goodTree();
    const a = variantShot("scaled");
    paint(a, 150, 150, 10, 10, [220, 220, 220]);
    const b = variantShot("scaled");
    paint(b, 150, 150, 14, 10, [220, 220, 220]);
    t2.shots["variant-scaled"] = a;
    t2.shots["ext-scaled"] = b;
    const c2 = (await run(t2)).find((x) => x.id === oracle);
    expect(c2?.passed === false, `scaled ink boxes off by 4px fail (${c2?.detail})`);
  }

  // identity-override
  const ident = "identity-override";
  await bad("identity shot off by 1", ident, (t) => {
    const d = baseShot();
    d[0] = 51;
    t.shots.identity = d;
  });
  await bad("identity sets 4 overrides", ident, (t) => (t.reports.identity = rep({ counters: counters({ overridesSet: 4 }) })), /only 4/);
  await bad("identity report missing", ident, (t) => (t.reports.identity = null), /no client-ext/);
  await bad("identity shot missing", ident, (t) => (t.shots.identity = null), /shot is missing/);
  await bad("identity report has no counters", ident, (t) => delete t.reports.identity!.counters, /no counters/);

  // frz-holds
  const frz = "frz-holds";
  await bad("ext-frz draws variant-base", frz, (t) => (t.shots["ext-frz"] = baseShot()), /not held/);
  await bad("ext-frz sets no override", frz, (t) => (t.reports["ext-frz"] = rep({ counters: counters({ overridesSet: 0 }) })), /no override set/);
  await bad("ext-frz report missing", frz, (t) => (t.reports["ext-frz"] = null), /no client-ext/);
  await bad("ext-frz shot missing", frz, (t) => (t.shots["ext-frz"] = null), /missing/);
  await bad("ext-frz report has no counters", frz, (t) => delete t.reports["ext-frz"]!.counters, /no counters/);
  await bad("ext-frz of another size", frz, (t) => (t.shots["ext-frz"] = new Uint8Array(40 * H * 4)));

  // override-redraw
  const rd = "override-redraw";
  const redrawWith = (o: Record<string, unknown>, anim: Record<string, unknown> = {}) => (t: Tree) => {
    const c = animCounters();
    Object.assign(c, o);
    Object.assign(c.anim, anim);
    t.reports.redraw = rep({ counters: c });
  };
  await bad("19 animation steps", rd, redrawWith({}, { steps: 19 }), /19 animation steps/);
  await bad("a binary message during the animation", rd, redrawWith({}, { binaryDuring: 1 }), /binary/);
  await bad("an ack during the animation", rd, redrawWith({}, { acksDuring: 1 }), /acks/);
  await bad("19 redraws", rd, redrawWith({ nullFrames: 19 }), /19 redraws/);
  await bad("animation never ran", rd, redrawWith({}, { startedAt: null }), /never ran/);
  await bad("no counters at all", rd, (t) => delete t.reports.redraw!.counters, /never ran/);
  await bad("last frame differs from variant-moved", rd, (t) => (t.shots.redraw = baseShot()), /last frame/);
  await bad("redraw shot missing", rd, (t) => (t.shots.redraw = null), /missing/);
  await bad("redraw report missing", rd, (t) => (t.reports.redraw = null), /no client-ext/);

  // override-dispose-rss
  const ds = "override-dispose-rss";
  await bad("two mounts", ds, (t) => t.reports.dispose!.mounts.pop(), /2 mounts/);
  await bad("no mounts field", ds, (t) => delete t.reports.dispose!.mounts, /0 mounts/);
  await bad("dispose report missing", ds, (t) => (t.reports.dispose = null), /0 mounts/);
  await bad("rss beyond 15 %", ds, (t) => (t.reports.dispose!.mounts[2].renderer_rss_mib = 116), /15 %/);
  await bad("a mount sets no override", ds, (t) => (t.reports.dispose!.mounts[1].overrides = 0), /no override/);

  // pointer-map
  const pm = "pointer-map";
  const both = (f: (p: any, t: Tree, leg: string) => void) => (t: Tree) => f(t.reports.inp!.probe, t, "inp");
  await bad("no probe", pm, (t) => delete t.reports.inp!.probe, /no probe/);
  await bad("report missing", pm, (t) => (t.reports["inp-wide"] = null), /no client-ext/);
  await bad("no cases", pm, both((p) => (p.cases = [])), /is missing/);
  await bad("a required case flagged missing", pm, both((p) => (p.cases[0].missing = true)), /raised-art-centre is missing/);
  await bad("a required case without item/game/drawn", pm, both((p) => {
    delete p.cases[3].item;
  }), /plain-art-centre is missing/);
  await bad("wrong item hit", pm, both((p) => (p.cases[0].got.item = 99)), /hit item/);
  await bad("hitTest wrong", pm, both((p) => (p.cases[0].hitTest = 99)), /hitTest/);
  await bad("toGame gave null", pm, both((p) => (p.cases[0].got = null)), /null/);
  await bad("game point unmapped", pm, both((p) => (p.cases[0].got.point = p.cases[0].drawn)), /game point/);
  await bad("override moved nothing", pm, both((p) => (p.cases[0].drawn = p.cases[0].game)), /moved nothing/);
  await bad("shot lacks Art at drawn point", pm, (t) => (t.shots.inp = gray()), /not Art/);
  await bad("no shot", pm, (t) => (t.shots.inp = null), /no shot/);
  await bad("no vacated probe", pm, both((p) => (p.vacated = { missing: true })), /no vacated/);
  await bad("vacated still hits card 1", pm, both((p) => (p.vacated.got.itemSlot = "1")), /still hits card 1/);
  await bad("vacated spot still Art", pm, (t) => {
    const d = baseShot();
    paint(d, 98, 108, 5, 5, ART);
    t.shots.inp = d;
  }, /still shows Art/);

  // pointer-letterbox
  const lb = "pointer-letterbox";
  await bad("no probe", lb, (t) => delete t.reports["inp-wide"]!.probe, /no probe/);
  await bad("bar point mapped", lb, both((p) => (p.letterbox[0].cssToPresentation = [1, 1])), /mapped/);
  await bad("no bar probes", lb, both((p) => (p.letterbox = [])), /only 0 bar/);
  await bad("a corner null", lb, both((p) => (p.corners.a = null)), /corner/);
  await bad("corners off", lb, both((p) => (p.corners.b = { x: 10, y: 10 })), /corners/);
  await bad("no overlay rect", lb, both((p) => (p.overlay.got = null)), /no overlay/);
  await bad("overlay off", lb, both((p) => (p.overlay.got.w = 99)), /presentationToCss/);

  // sabotage-*-caught: a sabotage that is not caught fails; so does an unhealthy or absent leg.
  const sabs: [string, (t: Tree) => void][] = [
    ["inverse-skip", (t) => (t.reports["sabotage-inverse-skip"] = rep({ probe: probe() }))],
    ["override-no-inherit", (t) => (t.shots["sabotage-override-no-inherit"] = variantShot("moved"))],
    ["override-fast-path-miss", (t) => (t.shots["sabotage-override-fast-path-miss"] = variantShot("moved"))],
    ["override-no-damage", (t) => (t.shots["sabotage-override-no-damage"] = variantShot("moved"))],
    ["frozen-still-applies", (t) => (t.shots["sabotage-frozen-still-applies"] = variantShot("moved"))],
  ];
  for (const [name, notCaught] of sabs) {
    const id = `sabotage-${name}-caught`;
    await bad(`${name} not caught`, id, notCaught, /not caught/);
    await bad(`${name} report missing`, id, (t) => (t.reports[`sabotage-${name}`] = null), /no client-ext/);
    await bad(`${name} did not end`, id, (t) => (t.reports[`sabotage-${name}`]!.ended = false), /did not end/);
    // A leg skipped by tier is a non-gating not-run, never a fail.
    const t = goodTree();
    t.markers[`sabotage-${name}`] = "skipped-by-tier.txt";
    t.reports[`sabotage-${name}`] = null;
    const c = (await run(t)).find((x) => x.id === id);
    expect(c?.status === "not-run" && c.gating === false, `${name} tier-skipped: not-run (${c?.status})`);
  }

  // An empty evidence tree fails every gating check.
  {
    const cs = await run({ reports: {}, shots: {}, markers: {} });
    for (const id of IDS) {
      const c = cs.find((x) => x.id === id);
      expect(c !== undefined && !c.passed, `empty tree: ${id} fails (${c?.status})`);
    }
  }

  if (failures > 0) {
    console.error(`self-test-gate8-tag2: ${failures} of ${assertions} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`self-test-gate8-tag2: ${assertions}/${assertions} assertions passed`);
}

await main();
