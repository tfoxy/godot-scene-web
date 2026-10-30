// Gate 8 g8tag2's checks (TAG2, protocol/client-extensions-design.md §6 and "As built (TAG2)"):
// the GSW client's extension API and override table, judged on run-gate8.sh run_g8tag2's legs
// (under g8tag2/; each leg's page/ holds client-ext-check.ts's client-ext.json and shot.png, the
// client's drawing buffer after the host ended):
//
//   override-oracle       for moved, scaled, hidden and tinted: the base scene plus an extension that
//                         makes the change by tag (ext-<v>) draws what the game's own change draws
//                         (variant-<v>), both through the same client: no pixel beyond 1 per channel
//                         (the GSW band of one executor against itself) -- except `scaled`'s glyph
//                         pixels, which Godot re-rasterizes at the new size while the override
//                         resamples the 1x atlas: there the differences must lie inside the text's
//                         ink box, and the two ink boxes agree within 1 px (glyphBand); each
//                         variant differs from the base scene, and the extension got its grant and
//                         set an override
//   identity-override     an identity override on every tagged item draws the base scene exactly
//   override-redraw       redraw: a 20-frame animated lift with no transaction drew 20 redraws
//                         (beforeDraw with seq null), carried no binary message and sent no ack in
//                         its window, and its last frame is variant-moved's (as override-oracle)
//   override-dispose-rss  dispose: the renderer RSS after disposing a client with overrides set is
//                         within MIR-1's 15 % of the RSS after disposing a client with none
//   override-sabotage-*   override-no-inherit and override-fast-path-miss fail override-oracle on
//                         moved; override-no-damage fails override-redraw's last frame

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodePngRgba } from "./gate-minus1-checks";
import { type G8aCheck, skipped } from "./gate8-adopt-checks";

const VARIANTS = ["moved", "scaled", "hidden", "tinted"] as const;
const RSS_TOLERANCE = 0.15;

interface LegReport {
  ended?: boolean;
  first_frame?: boolean;
  statuses?: { kind: string; reason?: string; detail?: string }[];
  counters?: {
    overridesSet: number;
    beforeDraws: number;
    nullFrames: number;
    sessions: (string | null)[];
    itemMetaRows: number;
    anim: {
      startedAt: number | null;
      steps: number;
      endedAt: number | null;
      binaryDuring: number;
      acksDuring: number;
    };
  };
  mounts?: {
    extension: string;
    renderer_rss_mib: number;
    overrides?: number;
  }[];
}

interface Shot {
  width: number;
  height: number;
  data: Uint8Array;
}

interface Diff {
  /** Pixels with any channel different. */
  differ: number;
  /** Pixels with a channel beyond 1. */
  beyond: number;
  max: number;
}

function diff(a: Shot, b: Shot): Diff | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  let differ = 0;
  let beyond = 0;
  let max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let m = 0;
    for (let c = 0; c < 4; c++)
      m = Math.max(m, Math.abs(a.data[i + c] - b.data[i + c]));
    if (m > 0) differ++;
    if (m > 1) beyond++;
    max = Math.max(max, m);
  }
  return { differ, beyond, max };
}

type Box = [number, number, number, number];

/** The bounding box (x0, y0, x1, y1, inclusive) of the pixels where `f` holds, or null. */
function bbox(s: Shot, f: (i: number) => boolean, within?: Box): Box | null {
  const [x0, y0, x1, y1] = within ?? [0, 0, s.width - 1, s.height - 1];
  let b: Box | null = null;
  for (let y = Math.max(0, y0); y <= Math.min(s.height - 1, y1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(s.width - 1, x1); x++) {
      if (!f((y * s.width + x) * 4)) continue;
      b = b
        ? [
            Math.min(b[0], x),
            Math.min(b[1], y),
            Math.max(b[2], x),
            Math.max(b[3], y),
          ]
        : [x, y, x, y];
    }
  return b;
}

/**
 * `scaled`'s band (client-extensions-design.md §3.2 "Pixel meaning"): Godot re-rasterizes a scaled
 * Label's glyphs at the new size, while an override resamples the atlas glyphs drawn at 1x, so the
 * glyph pixels themselves cannot match. Everything else must: every pixel beyond 1 lies inside the
 * text's ink box (the bright glyph pixels, grown by 1), and the two ink boxes -- where the text sits
 * and how big it is -- agree within 1 px per edge.
 */
function glyphBand(a: Shot, b: Shot): { ok: boolean; note: string } {
  const beyond = (i: number) => {
    let m = 0;
    for (let c = 0; c < 4; c++)
      m = Math.max(m, Math.abs(a.data[i + c] - b.data[i + c]));
    return m > 1;
  };
  const d = bbox(a, beyond);
  if (d === null) return { ok: true, note: "no pixel beyond 1" };
  const grow = (x: Box, n: number): Box => [
    x[0] - n,
    x[1] - n,
    x[2] + n,
    x[3] + n,
  ];
  const ink = (s: Shot) => (i: number) =>
    Math.max(s.data[i], s.data[i + 1], s.data[i + 2]) > 128;
  const ia = bbox(a, ink(a), grow(d, 6));
  const ib = bbox(b, ink(b), grow(d, 6));
  if (ia === null || ib === null)
    return { ok: false, note: `differences at ${d} hold no text` };
  const inside = (x: Box, o: Box) =>
    x[0] >= o[0] && x[1] >= o[1] && x[2] <= o[2] && x[3] <= o[3];
  const edges = ia.map((v, k) => Math.abs(v - ib[k]));
  const ok = inside(d, grow(ib, 1)) && edges.every((e) => e <= 1);
  return {
    ok,
    note: `differences in ${JSON.stringify(d)}, ink ${JSON.stringify(ia)} (override) vs ${JSON.stringify(ib)} (game), edges off by ${JSON.stringify(edges)}`,
  };
}

const fmt = (d: Diff | null) =>
  d === null
    ? "size mismatch"
    : `${d.differ} px differ, ${d.beyond} beyond 1, max ${d.max}`;

export async function runG8tag2(g: string): Promise<G8aCheck[]> {
  const checks: G8aCheck[] = [];
  const legDir = (leg: string) => join(g, leg);
  const report = (leg: string): LegReport | null => {
    const p = join(legDir(leg), "page", "client-ext.json");
    return existsSync(p)
      ? (JSON.parse(readFileSync(p, "utf8")) as LegReport)
      : null;
  };
  const shots = new Map<string, Shot | null>();
  const shot = async (leg: string): Promise<Shot | null> => {
    if (!shots.has(leg)) {
      const img = await decodePngRgba(join(legDir(leg), "page", "shot.png"));
      shots.set(leg, img ?? null);
    }
    return shots.get(leg) ?? null;
  };
  /** A leg's own health: it streamed, ended, and drew. */
  const health = (leg: string, r: LegReport | null): string[] => {
    if (r === null) return [`${leg}: no client-ext.json`];
    const out: string[] = [];
    if (!r.first_frame) out.push(`${leg}: no first frame`);
    if (!r.ended) {
      const f = r.statuses?.find((s) => s.kind === "failed");
      out.push(
        `${leg}: did not end${f ? ` (failed: ${f.reason} ${f.detail})` : ""}`,
      );
    }
    return out;
  };
  const mk = (
    id: string,
    criterion: string,
    problems: string[],
    detail: string,
    gating = true,
  ) =>
    checks.push({
      id,
      criterion,
      passed: problems.length === 0,
      status: problems.length === 0 ? "pass" : "fail",
      detail:
        problems.length === 0 ? detail : `${problems.join("; ")} (${detail})`,
      gating,
    });
  const skip = (leg: string) => skipped(legDir(leg));

  /** ext leg vs variant leg: problems (empty: equal within the band). */
  const oracle = async (
    extLeg: string,
    v: string,
    problems: string[],
    notes: string[],
  ) => {
    const r = report(extLeg);
    problems.push(
      ...health(extLeg, r),
      ...health(`variant-${v}`, report(`variant-${v}`)),
    );
    const c = r?.counters;
    if (c && c.overridesSet < 1) problems.push(`${extLeg}: no override set`);
    if (c && !c.sessions.some((s) => s !== null))
      problems.push(`${extLeg}: no item_meta grant`);
    const [a, b, base] = [
      await shot(extLeg),
      await shot(`variant-${v}`),
      await shot("variant-base"),
    ];
    if (!a || !b || !base) {
      problems.push(`${extLeg}/variant-${v}/variant-base: a shot is missing`);
      return;
    }
    const d = diff(a, b);
    if (v === "scaled" && d !== null && d.beyond > 0) {
      const g = glyphBand(a, b);
      notes.push(`${extLeg} vs variant-${v}: ${fmt(d)}; glyph band: ${g.note}`);
      if (!g.ok)
        problems.push(
          `${extLeg} vs variant-${v}: outside the glyph band (${g.note})`,
        );
    } else {
      notes.push(`${extLeg} vs variant-${v}: ${fmt(d)}`);
      if (d === null || d.beyond > 0)
        problems.push(`${extLeg} vs variant-${v}: ${fmt(d)}`);
    }
    const dv = diff(b, base);
    if (dv !== null && dv.differ === 0)
      problems.push(
        `variant-${v} draws the base scene (the variant made no change)`,
      );
  };

  // override-oracle
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const v of VARIANTS) await oracle(`ext-${v}`, v, problems, notes);
    mk(
      "override-oracle",
      "TAG2: for moved, scaled, hidden and tinted, the base scene plus an extension making the change by tag (an override on the tagged item, composed in cull and move_rec, inherited by its subtree) draws what the game's own change draws: no pixel beyond 1 per channel, through the same client",
      problems,
      notes.join("; "),
    );
  }

  // identity-override
  {
    const problems: string[] = [...health("identity", report("identity"))];
    const c = report("identity")?.counters;
    if (c && c.overridesSet < 5)
      problems.push(`identity: only ${c.overridesSet} overrides set`);
    const [a, b] = [await shot("identity"), await shot("variant-base")];
    let note = "";
    if (!a || !b) problems.push("identity/variant-base: a shot is missing");
    else {
      const d = diff(a, b);
      note = `identity vs variant-base: ${fmt(d)}, ${c?.overridesSet ?? 0} overrides`;
      if (d === null || d.differ > 0) problems.push(note);
    }
    mk(
      "identity-override",
      "TAG2: an identity override on every tagged item draws exactly what no override draws",
      problems,
      note,
    );
  }

  // override-redraw (and its sabotage)
  const redraw = async (leg: string) => {
    const problems: string[] = [];
    const r = report(leg);
    problems.push(
      ...health(leg, r),
      ...health("variant-moved", report("variant-moved")),
    );
    const a = r?.counters?.anim;
    const nulls = r?.counters?.nullFrames ?? 0;
    if (!a || a.startedAt === null || a.endedAt === null)
      problems.push(`${leg}: the animation never ran`);
    else {
      if (a.steps !== 20) problems.push(`${leg}: ${a.steps} animation steps`);
      if (a.binaryDuring !== 0)
        problems.push(
          `${leg}: ${a.binaryDuring} binary messages during the animation`,
        );
      if (a.acksDuring !== 0)
        problems.push(`${leg}: ${a.acksDuring} acks during the animation`);
    }
    if (nulls < 20)
      problems.push(`${leg}: ${nulls} redraws (beforeDraw with seq null)`);
    const [s, v] = [await shot(leg), await shot("variant-moved")];
    const d = s && v ? diff(s, v) : null;
    if (!s || !v) problems.push(`${leg}/variant-moved: a shot is missing`);
    else if (d === null || d.beyond > 0)
      problems.push(`${leg} last frame vs variant-moved: ${fmt(d)}`);
    const note = `${a?.steps ?? 0} steps, ${nulls} redraws, ${a?.binaryDuring ?? "?"} binary and ${a?.acksDuring ?? "?"} acks during the animation (${a && a.endedAt !== null && a.startedAt !== null ? Math.round(a.endedAt - a.startedAt) : "?"} ms); last frame vs variant-moved: ${fmt(d)}`;
    return { problems, note, d };
  };
  {
    const { problems, note } = await redraw("redraw");
    mk(
      "override-redraw",
      "TAG2: a 20-frame animated translate with no transaction redraws 20 times (requestRedraw, beforeDraw with seq null), carries no message and acks nothing, and its last frame equals the game's own move (variant-moved)",
      problems,
      note,
    );
  }

  // override-dispose-rss
  {
    const problems: string[] = [];
    const r = report("dispose");
    const m = r?.mounts ?? [];
    let note = "";
    if (r === null || m.length !== 3)
      problems.push(`dispose: ${m.length} mounts`);
    else {
      const ref = m[0].renderer_rss_mib;
      note = m
        .map(
          (x) =>
            `${x.extension}: ${x.renderer_rss_mib} MiB (${x.overrides ?? 0} overrides)`,
        )
        .join(", ");
      for (const x of m.slice(1)) {
        if ((x.overrides ?? 0) < 1)
          problems.push(`dispose: the ${x.extension} mount set no override`);
        if (x.renderer_rss_mib > ref * (1 + RSS_TOLERANCE))
          problems.push(
            `dispose: ${x.renderer_rss_mib} MiB > ${ref} MiB + 15 %`,
          );
      }
    }
    mk(
      "override-dispose-rss",
      "TAG2: disposing a client with overrides set leaves the renderer RSS (after GC and a pressure purge) within MIR-1's 15 % of disposing one with none",
      problems,
      note,
    );
  }

  // sabotages: each must fail its check.
  const sab = async (
    name: string,
    criterion: string,
    judge: () => Promise<string[]>,
  ) => {
    const leg = `sabotage-${name}`;
    const why = skip(leg);
    if (why !== null) {
      checks.push({
        id: `${leg}-caught`,
        criterion,
        passed: true,
        status: "not-run",
        detail: why,
        gating: false,
      });
      return;
    }
    const failures = await judge();
    const healthy = health(leg, report(leg));
    const caught = healthy.length === 0 && failures.length > 0;
    mk(
      `${leg}-caught`,
      criterion,
      caught
        ? []
        : [healthy.length > 0 ? healthy.join("; ") : `${leg} was not caught`],
      failures.join("; "),
    );
  };
  const oracleFails = async (leg: string) => {
    const problems: string[] = [];
    const notes: string[] = [];
    await oracle(leg, "moved", problems, notes);
    return problems.filter((p) => p.startsWith(`${leg} vs`));
  };
  await sab(
    "override-no-inherit",
    "TAG2 sabotage override-no-inherit (the override composed into the item's own row only, as write_row would): fails override-oracle on moved's children",
    () => oracleFails("sabotage-override-no-inherit"),
  );
  await sab(
    "override-fast-path-miss",
    "TAG2 sabotage override-fast-path-miss (move_rec ignores the table): fails override-oracle on moved after the transform-only frame (Hand's move at step 80)",
    () => oracleFails("sabotage-override-fast-path-miss"),
  );
  await sab(
    "override-no-damage",
    "TAG2 sabotage override-no-damage (the redraw path marks no row dirty): fails override-redraw's last frame",
    async () =>
      (await redraw("sabotage-override-no-damage")).problems.filter((p) =>
        p.includes("last frame"),
      ),
  );
  return checks;
}
