#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 8's g8id checks (lib/gate8-id-checks.ts, runG8id): a fabricated g8id tree --
// an oracle grid modelled from fixtures/tag-scene pick.gd's layout in Godot's pick order, and the
// client grids each leg would read -- on which every check passes, then mutations that must fail
// each check id (pick-oracle, pick-drawn-default, sabotage-pick-*-caught), and a tier-skipped
// sabotage leg (not-run).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-id.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hit1Expected,
  NEVER,
  PICK_GRID,
  PICKED,
  type PickOracle,
  pointAt,
  poolIdFromStream,
  poolTransitionProblem,
  runG8id,
} from "../lib/gate8-id-checks";

import { MAGIC_V13 } from "../lib/render-stream-2";

let failures = 0;
let assertions = 0;
function expect(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

type R = [number, number, number, number];
const SIZE: [number, number] = [640, 360];
const inside = (x: number, y: number, r: R) =>
  x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
/** pick.gd's Rot: 80x50 at (360, 200), rotated 30 degrees about its origin. */
const inRot = (x: number, y: number) => {
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const [dx, dy] = [x - 360, y - 200];
  const [lx, ly] = [c * dx + s * dy, -s * dx + c * dy];
  return lx >= 0 && ly >= 0 && lx < 80 && ly < 50;
};
/** pick.gd's pickable rects in Godot's order: layer 1, TopKid (a root after Pick), Pick's
 * children last first (each child's children first), layer -1. */
const ORDER: [string, (x: number, y: number) => boolean][] = [
  ["PoolHitbox", (x, y) => inside(x, y, [70, 111, 160, 48])],
  ["Over", (x, y) => inside(x, y, [385, 110, 70, 60])],
  ["TopKid", (x, y) => inside(x, y, [65, 225, 90, 60])],
  ["VeilButton", (x, y) => inside(x, y, [470, 290, 100, 50])],
  ["Ghost", (x, y) => inside(x, y, [300, 290, 80, 50])],
  ["UnderGhost", (x, y) => inside(x, y, [290, 280, 120, 70])],
  ["UnderHidden", (x, y) => inside(x, y, [480, 195, 100, 70])],
  ["Rot", inRot],
  ["Button", (x, y) => inside(x, y, [195, 185, 100, 60])],
  ["Late", (x, y) => inside(x, y, [95, 245, 80, 70])],
  ["TopParent", (x, y) => inside(x, y, [5, 185, 110, 80])],
  ["Spill", (x, y) => inside(x, y, [480, 15, 35, 40])],
  ["ClipBox", (x, y) => inside(x, y, [435, 5, 80, 90])],
  ["Hitbox", (x, y) => inside(x, y, [315, 15, 90, 130])],
  ["BChild", (x, y) => inside(x, y, [190, 25, 70, 50])],
  ["BParent", (x, y) => inside(x, y, [165, 5, 120, 90])],
  ["ZLow", (x, y) => inside(x, y, [60, 5, 90, 90])],
  ["ZHigh", (x, y) => inside(x, y, [5, 5, 90, 90])],
  ["Back", (x, y) => inside(x, y, [0, 175, 640, 185])],
  ["Under", (x, y) => inside(x, y, [530, 5, 105, 90])],
];
const CELLS = PICK_GRID[0] * PICK_GRID[1];
const grid = (f: (x: number, y: number, k: number) => string | null) =>
  Array.from({ length: CELLS }, (_, k) => {
    const [x, y] = pointAt(k, SIZE);
    return f(x, y, k);
  });
const ORACLE = grid((x, y) => ORDER.find(([, hit]) => hit(x, y))?.[0] ?? null);
const FILTERS: Record<string, string> = Object.fromEntries([
  ...ORDER.map(([n]) => [n, n === "Back" ? "pass" : "stop"]),
  ...NEVER.map((n) => [n, "ignore"]),
]);
/** HIT1's reading on the fixture (the no-node art is item #77). */
const DEFAULT = grid((x, y, k) => {
  // Pool has no drawn commands; pin this independently of the expected-answer helper.
  if (ORACLE[k] === "PoolHitbox") return null;
  const e = hit1Expected(ORACLE[k], x, y);
  return e.want === "nodeless" ? "#77" : e.want;
});
/** The clip-less client: Spill wherever its rect reaches, unless something above answers. */
const NO_CLIP = grid((x, y, k) => {
  const spill = inside(x, y, [480, 15, 100, 40]);
  const above = ORDER.slice(
    0,
    ORDER.findIndex(([n]) => n === "Spill"),
  ).some(([, hit]) => hit(x, y));
  return spill && !above ? "Spill" : ORACLE[k];
});

interface Tree {
  [leg: string]: {
    oracle?: (string | null)[] | null;
    page?: (string | null)[] | null;
    filters?: Record<string, string>;
    skip?: boolean;
    rows?: { id: number; node: boolean; stamp: number }[];
    poolTag?: string;
  };
}
const healthy = (): Tree => ({
  pick: { page: ORACLE },
  "pick-default": { page: DEFAULT },
  "sabotage-no-reentry": {
    page: ORACLE.map((n) => (n === "PoolHitbox" ? null : n)),
  },
  "sabotage-pick-draw-order": { page: DEFAULT },
  "sabotage-pick-no-rect": {
    page: ORACLE.map((n) => (n === "Hitbox" ? null : n)),
  },
  "sabotage-pick-no-clip": { page: NO_CLIP },
});

function write(root: string, tree: Tree): void {
  for (const [leg, t] of Object.entries(tree)) {
    const d = join(root, leg);
    mkdirSync(join(d, "host"), { recursive: true });
    mkdirSync(join(d, "page"), { recursive: true });
    const meta = Buffer.from(
      JSON.stringify({
        type: "item_meta",
        form: "full",
        grant: {
          fields: ["path"],
          groups: [],
          meta_keys: ["rs_pick", "rs_mf"],
        },
        strings_from: 0,
        strings: ["path", t.poolTag ?? "PoolHitbox", "stop"],
        items: [[42, 0, 1, 2]],
        blocks: [],
      }),
    );
    const rec = Buffer.alloc(meta.length + 12);
    rec.writeUInt32LE(meta.length + 8, 0);
    rec.writeUInt32LE(meta.length, 4);
    meta.copy(rec, 8);
    mkdirSync(join(d, "host", "tap"), { recursive: true });
    writeFileSync(
      join(d, "host", "tap", "stream-1.rs2"),
      Buffer.concat([MAGIC_V13, rec]),
    );
    const rows = t.rows ?? [
      { id: 42, node: false, stamp: 182 },
      { id: 42, node: true, stamp: 210 },
    ];
    writeFileSync(
      join(d, "host", "ids.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    if (t.skip) writeFileSync(join(d, "skipped-by-tier.txt"), "smoke\n");
    const oracle = t.oracle === undefined ? ORACLE : t.oracle;
    if (oracle !== null) {
      const o: PickOracle = {
        frame: 80,
        size: SIZE,
        grid: [...PICK_GRID],
        filters: FILTERS,
        points: oracle,
      };
      writeFileSync(
        join(d, "host", "pick-oracle.json"),
        `${JSON.stringify(o)}\n`,
      );
    }
    const report = {
      ended: true,
      first_frame: true,
      statuses: [{ kind: "streaming", firstFrame: true }, { kind: "ended" }],
      pick:
        t.page === null
          ? null
          : {
              seq: 140,
              frames: 80,
              grid: [...PICK_GRID],
              size: SIZE,
              named: 27,
              filters: t.filters ?? FILTERS,
              points: t.page,
            },
    };
    writeFileSync(join(d, "page", "client-ext.json"), JSON.stringify(report));
  }
}

const IDS = [
  "pick-oracle",
  "pick-pool-renode",
  "sabotage-no-reentry-caught",
  "pick-drawn-default",
  "sabotage-pick-draw-order-caught",
  "sabotage-pick-no-rect-caught",
  "sabotage-pick-no-clip-caught",
];

async function run(tree: Tree) {
  const root = mkdtempSync(join(tmpdir(), "self-test-gate8-id-"));
  try {
    write(root, tree);
    return await runG8id(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // The model reaches every case the checker asks of the oracle.
  const seen = new Set(ORACLE);
  for (const n of PICKED) expect(seen.has(n), `model oracle picks ${n}`);
  for (const n of NEVER) expect(!seen.has(n), `model oracle never picks ${n}`);

  const good = await run(healthy());
  for (const id of IDS) {
    const c = good.find((x) => x.id === id);
    expect(
      c?.passed === true && c.status === "pass",
      `healthy: ${id} passes (${c?.detail})`,
    );
  }

  const fails = async (what: string, id: string, edit: (t: Tree) => void) => {
    const t = healthy();
    edit(t);
    const c = (await run(t)).find((x) => x.id === id);
    expect(
      c !== undefined && !c.passed && c.status === "fail",
      `${what}: ${id} fails (${c?.status})`,
    );
  };
  await fails("missing null-node history", "pick-pool-renode", (t) => {
    t.pick.rows = [{ id: 42, node: true, stamp: 210 }];
  });
  await fails("history belongs to another id", "pick-pool-renode", (t) => {
    t.pick.rows = [
      { id: 43, node: false, stamp: 182 },
      { id: 43, node: true, stamp: 210 },
    ];
  });
  await fails("reversed identity history", "pick-pool-renode", (t) => {
    t.pick.rows = [
      { id: 42, node: true, stamp: 182 },
      { id: 42, node: false, stamp: 210 },
    ];
  });
  await fails("wrong stream meta tag", "pick-pool-renode", (t) => {
    t.pick.poolTag = "Other";
  });
  await fails("no-reentry not caught", "sabotage-no-reentry-caught", (t) => {
    t["sabotage-no-reentry"].page = ORACLE;
  });
  expect(
    poolTransitionProblem(
      [
        { id: 42, node: false, stamp: 1 },
        { id: 42, node: true, stamp: 1 },
      ],
      42,
    ) !== null,
    "same-frame history cannot prove a pooled wait",
  );
  let rejected = false;
  try {
    poolIdFromStream(new Uint8Array());
  } catch {
    rejected = true;
  }
  expect(rejected, "missing stream is rejected");
  const flip = (pts: (string | null)[], from: string, to: string | null) =>
    pts.map((n) => (n === from ? to : n));
  await fails("one point wrong", "pick-oracle", (t) => {
    const p = [...ORACLE];
    p[100] = p[100] === "Back" ? null : "Back";
    t.pick.page = p;
  });
  await fails("hitbox missed", "pick-oracle", (t) => {
    t.pick.page = flip(ORACLE, "Hitbox", null);
  });
  await fails("oracle never reaches Ghost", "pick-oracle", (t) => {
    const o = flip(ORACLE, "Ghost", "UnderGhost");
    t.pick.oracle = o;
    t.pick.page = o;
  });
  await fails("no oracle", "pick-oracle", (t) => {
    t.pick.oracle = null;
  });
  await fails("no page grid", "pick-oracle", (t) => {
    t.pick.page = null;
  });
  await fails("filters not stated", "pick-oracle", (t) => {
    t.pick.filters = { ...FILTERS, Hitbox: "ignore" };
  });
  await fails("default flipped to tree", "pick-drawn-default", (t) => {
    t["pick-default"].page = ORACLE;
  });
  expect(
    hit1Expected("PoolHitbox", 120, 123.75).want === null,
    "the undrawn Pool has no HIT1 draw-order answer",
  );
  await fails(
    "default wrongly picks the undrawn Pool",
    "pick-drawn-default",
    (t) => {
      t["pick-default"].page = DEFAULT.map((n, k) =>
        ORACLE[k] === "PoolHitbox" ? "PoolHitbox" : n,
      );
    },
  );
  await fails("default wrong at a ghost point", "pick-drawn-default", (t) => {
    t["pick-default"].page = DEFAULT.map((n, k) =>
      ORACLE[k] === "Ghost" ? "Ghost" : n,
    );
  });
  await fails(
    "draw-order not caught",
    "sabotage-pick-draw-order-caught",
    (t) => {
      t["sabotage-pick-draw-order"].page = ORACLE;
    },
  );
  await fails("no-rect not caught", "sabotage-pick-no-rect-caught", (t) => {
    t["sabotage-pick-no-rect"].page = ORACLE;
  });
  await fails("no-clip not caught", "sabotage-pick-no-clip-caught", (t) => {
    t["sabotage-pick-no-clip"].page = ORACLE;
  });
  await fails("no-clip leg unhealthy", "sabotage-pick-no-clip-caught", (t) => {
    t["sabotage-pick-no-clip"].oracle = null;
  });
  {
    const t = healthy();
    t["sabotage-pick-no-rect"].skip = true;
    const c = (await run(t)).find(
      (x) => x.id === "sabotage-pick-no-rect-caught",
    );
    expect(
      c?.status === "not-run" && c.gating === false,
      `skipped sabotage is not-run (${c?.status})`,
    );
  }
  {
    const cs = await run({});
    for (const id of IDS) {
      const c = cs.find((x) => x.id === id);
      expect(
        c !== undefined && !c.passed,
        `empty tree: ${id} fails (${c?.status})`,
      );
    }
  }

  if (failures > 0) {
    console.error(
      `self-test-gate8-id: ${failures} of ${assertions} assertion(s) failed`,
    );
    process.exit(1);
  }
  console.log(
    `self-test-gate8-id: ${assertions}/${assertions} assertions passed`,
  );
}

await main();
