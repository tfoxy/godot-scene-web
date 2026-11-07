// Gate 8 g8id's checks:
// the GSW client's Godot tree-order pick, judged on run-gate8.sh run_g8id's legs (under
// g8id/; each leg's host/pick-oracle.json is fixtures/tag-scene pick.gd's own pick -- Godot's
// `gui_get_hovered_control()` after a pushed mouse motion -- on a 24x16 grid, and page/client-ext.json
// holds the grid the client's `query.hitTest` read during the last frame, by the items' `rs_pick`
// names):
//
//   pick-oracle               `pick` (the fixture's filters stated, pickOrder("tree")): every grid
//                             point names what Godot picked. The oracle itself must reach every case
//                             (each pickable name appears, no IGNORE, hidden or non-Control name does)
//   pick-drawn-default        `pick-default` (the same filters, no pickOrder: ID-D8's no-flip): every
//                             point is HIT1's draw-order answer, modelled from the fixture: the oracle's
//                             name except ZHigh over ZLow (z_index 5), BParent over BChild (behind),
//                             the card's no-node art inside the card and UnderGhost under Ghost (alpha
//                             0, culled from the draw); each of those four differs at one point at least
//   sabotage-pick-*-caught    pick-draw-order (HIT1's reading under "tree") fails pick-oracle at the
//                             z_index and behind points; pick-no-rect (drawn content rects only) at the
//                             Hitbox points; pick-no-clip (children outside a clip) at the clipped points

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type G8aCheck, skipped } from "./gate8-adopt-checks";

export const PICK_GRID = [24, 16] as const;

/** pick.gd's oracle line. */
export interface PickOracle {
  frame: number;
  size: [number, number];
  grid: [number, number];
  filters: Record<string, string>;
  points: (string | null)[];
}

/** client-ext-check.ts's report.pick (web/client-ext-check/page.ts PickProbe). */
export interface PickProbe {
  seq: number;
  frames: number;
  grid: [number, number];
  size: [number, number];
  named: number;
  filters: Record<string, string>;
  points: (string | null)[];
  /** Mean µs per hitTest in the page (evidence, not judged). */
  usPerPick?: number;
}

interface LegReport {
  ended?: boolean;
  first_frame?: boolean;
  statuses?: { kind: string; reason?: string; detail?: string }[];
  pick?: PickProbe | null;
}

/** Every name pick.gd's cases must make Godot pick somewhere on the grid. */
export const PICKED = [
  "Back",
  "ZHigh",
  "ZLow",
  "BParent",
  "BChild",
  "Hitbox",
  "ClipBox",
  "Spill",
  "Under",
  "Over",
  "TopParent",
  "TopKid",
  "Late",
  "Button",
  "Rot",
  "UnderHidden",
  "UnderGhost",
  "Ghost",
  "VeilButton",
] as const;
/** Names Godot never picks: IGNORE Controls, hidden ones and CanvasItems that are not Controls. */
export const NEVER = [
  "Pick",
  "ZRoot",
  "Card",
  "Face",
  "Decor",
  "Hidden",
  "HiddenKid",
  "Veil",
] as const;

/** A point's presentation coordinates (the cell's centre). */
export function pointAt(k: number, size: [number, number]): [number, number] {
  const [gw, gh] = PICK_GRID;
  return [
    ((k % gw) + 0.5) * (size[0] / gw),
    (Math.floor(k / gw) + 0.5) * (size[1] / gh),
  ];
}

const inside = (x: number, y: number, r: [number, number, number, number]) =>
  x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
/** pick.gd's Card (presentation space) and the layer-1 Over above part of it. */
const CARD: [number, number, number, number] = [305, 5, 110, 150];
const OVER: [number, number, number, number] = [385, 110, 70, 60];
/** ZHigh's rect: where it is drawn over ZLow. */
const ZHIGH: [number, number, number, number] = [5, 5, 90, 90];

/** The answer class HIT1's draw-order reading gives at a point, from the oracle's name. */
export type Hit1Case = "z" | "behind" | "card" | "ghost" | null;

export function hit1Expected(
  oracle: string | null,
  x: number,
  y: number,
): { want: string | null | "nodeless"; case: Hit1Case } {
  if (oracle === "Over" || inside(x, y, OVER))
    return { want: oracle, case: null };
  // The card's art is an item with no node, drawn over Face and the undrawn Hitbox: unstated, it
  // counts as drawn (HIT1).
  if (inside(x, y, CARD)) return { want: "nodeless", case: "card" };
  if (oracle === "ZLow" && inside(x, y, ZHIGH))
    return { want: "ZHigh", case: "z" };
  if (oracle === "BChild") return { want: "BParent", case: "behind" };
  // Ghost (modulate alpha 0) is culled from the draw.
  if (oracle === "Ghost") return { want: "UnderGhost", case: "ghost" };
  return { want: oracle, case: null };
}

const show = (v: string | null) => (v === null ? "none" : v);

/** Points where `got` differs from `want`, as "(x, y) want/got" strings. */
export function mismatches(
  oracle: PickOracle,
  got: (string | null)[],
  only: (k: number) => boolean = () => true,
): string[] {
  const out: string[] = [];
  for (let k = 0; k < oracle.points.length; k++) {
    if (!only(k) || got[k] === oracle.points[k]) continue;
    const [x, y] = pointAt(k, oracle.size);
    out.push(
      `(${x.toFixed(1)}, ${y.toFixed(1)}) godot ${show(oracle.points[k])}, client ${show(got[k] ?? null)}`,
    );
  }
  return out;
}

export async function runG8id(g: string): Promise<G8aCheck[]> {
  const checks: G8aCheck[] = [];
  const legDir = (leg: string) => join(g, leg);
  const report = (leg: string): LegReport | null => {
    const p = join(legDir(leg), "page", "client-ext.json");
    return existsSync(p)
      ? (JSON.parse(readFileSync(p, "utf8")) as LegReport)
      : null;
  };
  const oracleOf = (leg: string): PickOracle | null => {
    const p = join(legDir(leg), "host", "pick-oracle.json");
    if (!existsSync(p)) return null;
    const line = readFileSync(p, "utf8").trim().split("\n")[0] ?? "";
    return line === "" ? null : (JSON.parse(line) as PickOracle);
  };
  const cells = PICK_GRID[0] * PICK_GRID[1];
  /** A leg's health: it streamed and ended, both grids are whole and on one size, and the client
   * stated the fixture's own filters. */
  const health = (
    leg: string,
  ): { problems: string[]; o: PickOracle | null; p: PickProbe | null } => {
    const r = report(leg);
    const o = oracleOf(leg);
    const problems: string[] = [];
    if (r === null) problems.push(`${leg}: no client-ext.json`);
    else {
      if (!r.first_frame) problems.push(`${leg}: no first frame`);
      if (!r.ended) {
        const f = r.statuses?.find((s) => s.kind === "failed");
        problems.push(
          `${leg}: did not end${f ? ` (failed: ${f.reason} ${f.detail})` : ""}`,
        );
      }
    }
    const p = r?.pick ?? null;
    if (o === null) problems.push(`${leg}: no host/pick-oracle.json`);
    else if (o.points.length !== cells)
      problems.push(`${leg}: the oracle has ${o.points.length} points`);
    if (p === null) problems.push(`${leg}: the page read no pick grid`);
    else if (p.points.length !== cells)
      problems.push(`${leg}: the page read ${p.points.length} points`);
    if (o !== null && p !== null) {
      if (o.size[0] !== p.size[0] || o.size[1] !== p.size[1])
        problems.push(
          `${leg}: the oracle's viewport ${o.size.join("x")} is not the presentation ${p.size.join("x")}`,
        );
      const names = Object.keys(o.filters);
      const missing = names.filter((n) => p.filters[n] !== o.filters[n]);
      if (missing.length > 0)
        problems.push(
          `${leg}: the client did not state the fixture's filters for ${missing.join(", ")}`,
        );
    }
    return { problems, o, p };
  };
  const mk = (
    id: string,
    criterion: string,
    problems: string[],
    detail: string,
  ) =>
    checks.push({
      id,
      criterion,
      passed: problems.length === 0,
      status: problems.length === 0 ? "pass" : "fail",
      detail:
        problems.length === 0 ? detail : `${problems.join("; ")} (${detail})`,
      gating: true,
    });
  const notRun = (id: string, criterion: string, why: string) =>
    checks.push({
      id,
      criterion,
      passed: true,
      status: "not-run",
      detail: why,
      gating: false,
    });
  const cap = (xs: string[], n = 6) =>
    xs.length <= n ? xs : [...xs.slice(0, n), `${xs.length - n} more`];

  // pick-oracle
  {
    const id = "pick-oracle";
    const criterion =
      "ID2: with the fixture's own mouse filters stated and pickOrder(\"tree\"), the client's pick names Godot's pick (gui_get_hovered_control after a pushed motion) at every point of a 24x16 grid over pick.gd's cases (z_index, show_behind_parent, an undrawn Hitbox over a no-node item, clip_contents, CanvasLayers -1 and 1, top_level, Node2D decor, rotation, hidden, alpha 0, a transparent IGNORE veil)";
    const why = skipped(legDir("pick"));
    if (why !== null) notRun(id, criterion, why);
    else {
      const { problems, o, p } = health("pick");
      if (o !== null && p !== null && problems.length === 0) {
        const seen = new Set(o.points);
        const unreached = PICKED.filter((n) => !seen.has(n));
        if (unreached.length > 0)
          problems.push(`the oracle never picks ${unreached.join(", ")}`);
        const wrong = NEVER.filter((n) => seen.has(n));
        if (wrong.length > 0)
          problems.push(`the oracle picks ${wrong.join(", ")}`);
        problems.push(...cap(mismatches(o, p.points)));
      }
      mk(
        id,
        criterion,
        problems,
        o && p
          ? `${cells} points, ${new Set(o.points).size} distinct answers, ${p.named} named items, oracle frame ${o.frame}, page seq ${p.seq}, ${(p.usPerPick ?? 0).toFixed(2)} us per pick`
          : "no grid",
      );
    }
  }

  // pick-drawn-default
  {
    const id = "pick-drawn-default";
    const criterion =
      "ID2 (ID-D8): with the same filters and no pickOrder call, every point is HIT1's draw-order answer (the oracle's, except ZHigh over ZLow, BParent over BChild, the no-node art inside the card and UnderGhost under the alpha-0 Ghost), and each of those four cases differs from Godot's pick at a point at least";
    const why = skipped(legDir("pick-default"));
    if (why !== null) notRun(id, criterion, why);
    else {
      const { problems, o, p } = health("pick-default");
      const counts: Record<string, number> = {};
      if (o !== null && p !== null && problems.length === 0) {
        const bad: string[] = [];
        for (let k = 0; k < cells; k++) {
          const [x, y] = pointAt(k, o.size);
          const e = hit1Expected(o.points[k], x, y);
          const got = p.points[k] ?? null;
          const ok =
            e.want === "nodeless"
              ? typeof got === "string" && /^#\d+$/.test(got)
              : got === e.want;
          if (!ok)
            bad.push(
              `(${x.toFixed(1)}, ${y.toFixed(1)}) HIT1 ${show(e.want)}, client ${show(got)}`,
            );
          if (e.case !== null && got !== o.points[k])
            counts[e.case] = (counts[e.case] ?? 0) + 1;
        }
        problems.push(...cap(bad));
        const quiet = ["z", "behind", "card", "ghost"].filter(
          (c) => (counts[c] ?? 0) === 0,
        );
        if (quiet.length > 0)
          problems.push(
            `the default reading equals Godot's at every ${quiet.join(", ")} point (the leg cannot see a flip)`,
          );
      }
      mk(
        id,
        criterion,
        problems,
        `differs from Godot's pick at ${Object.entries(counts)
          .map(([c, n]) => `${n} ${c}`)
          .join(", ")} points, ${(p?.usPerPick ?? 0).toFixed(2)} us per pick`,
      );
    }
  }

  // sabotages: each must fail pick-oracle at its own points.
  const sab = (
    name: string,
    criterion: string,
    at: (o: PickOracle, p: PickProbe, k: number) => boolean,
  ) => {
    const leg = `sabotage-${name}`;
    const id = `${leg}-caught`;
    const why = skipped(legDir(leg));
    if (why !== null) {
      notRun(id, criterion, why);
      return;
    }
    const { problems, o, p } = health(leg);
    const failures =
      o !== null && p !== null
        ? mismatches(o, p.points, (k) => at(o, p, k))
        : [];
    mk(
      id,
      criterion,
      problems.length > 0
        ? problems
        : failures.length > 0
          ? []
          : [`${leg} was not caught`],
      cap(failures, 3).join("; "),
    );
  };
  sab(
    "pick-draw-order",
    'ID2 sabotage pick-draw-order (HIT1\'s draw reading under pickOrder("tree")): fails pick-oracle at the z_index and show_behind_parent points',
    (o, _p, k) => {
      const [x, y] = pointAt(k, o.size);
      const c = hit1Expected(o.points[k], x, y).case;
      return c === "z" || c === "behind";
    },
  );
  sab(
    "pick-no-rect",
    "ID2 sabotage pick-no-rect (drawn content rects only, never a Control's custom rect): fails pick-oracle at the undrawn Hitbox's points",
    (o, _p, k) => o.points[k] === "Hitbox",
  );
  sab(
    "pick-no-clip",
    "ID2 sabotage pick-no-clip (a clipping Control's children visited outside it): fails pick-oracle where Spill reaches outside ClipBox",
    (o, p, k) => p.points[k] === "Spill" && o.points[k] !== "Spill",
  );
  return checks;
}
