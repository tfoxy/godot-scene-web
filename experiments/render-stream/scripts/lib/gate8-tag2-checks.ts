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
//   pointer-map           INP1: on the `inp` legs (Card1 lifted, Card2 scaled 1.24, Card4 plain; 16:9 and
//                         21:9 presentations in a 700x500 CSS box): a tap at a raised item's drawn point
//                         reaches the item's game point, a scaled item's likewise, a plain item maps to
//                         itself, the spot a raised card left maps to itself and hits no part of it, and
//                         the drawn point holds the item's pixels in the shot
//   pointer-letterbox     INP1: points on the bars and outside the box map to null, the picture's corners
//                         map to the presentation's, and presentationToCss lays an item's rect on the page
//   inverse-skip-caught   INP1 sabotage inverse-skip (the point returned unmapped) fails pointer-map
//   override-sabotage-*   override-no-inherit and override-fast-path-miss fail override-oracle on
//                         moved; override-no-damage fails override-redraw's last frame

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodePngRgba } from "./gate-minus1-checks";
import { type G8aCheck, skipped } from "./gate8-adopt-checks";

const INP_LEGS = ["inp", "inp-wide"] as const;
/** Card.tscn's Art ColorRect colour (0.8, 0.3, 0.2) as the client's canvas shows it. */
const ART_RGB = [204, 77, 51] as const;
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
  probe?: Probe | null;
  mounts?: {
    extension: string;
    renderer_rss_mib: number;
    overrides?: number;
  }[];
}

type Pt = [number, number];
interface ProbeCase {
  name: string;
  missing?: boolean;
  slot?: number;
  item?: number;
  overridden?: boolean;
  game?: Pt;
  drawn?: Pt;
  got?: {
    item: number | null;
    itemSlot: string | null;
    itemPath: string | null;
    point: Pt;
    drawn: Pt;
  } | null;
  cssToPresentation?: Pt | null;
  hitTest?: number | null;
}
interface Probe {
  presentation: Pt;
  css: Pt;
  scale: number;
  cases: ProbeCase[];
  vacated: {
    missing?: boolean;
    game?: Pt;
    got?: { item: number | null; itemSlot: string | null; point: Pt } | null;
  };
  letterbox: {
    name: string;
    inBox: boolean;
    cssToPresentation: unknown;
    clientToGame: unknown;
  }[];
  corners: {
    a: { x: number; y: number } | null;
    b: { x: number; y: number } | null;
  };
  overlay: {
    got: { x: number; y: number; w: number; h: number } | null;
    want: { x: number; y: number; w: number; h: number } | null;
  };
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

  // INP1: pointer mapping.
  const EPS = 0.02;
  const near = (a: Pt, b: Pt, e = EPS) =>
    Math.abs(a[0] - b[0]) <= e && Math.abs(a[1] - b[1]) <= e;
  const pixel = (sh: Shot, p: Pt): [number, number, number] => {
    const x = Math.min(sh.width - 1, Math.max(0, Math.floor(p[0])));
    const y = Math.min(sh.height - 1, Math.max(0, Math.floor(p[1])));
    const i = (y * sh.width + x) * 4;
    return [sh.data[i], sh.data[i + 1], sh.data[i + 2]];
  };
  const isArt = (c: [number, number, number]) =>
    c.every((v, k) => Math.abs(v - ART_RGB[k]) <= 6);
  /** pointer-map's problems on one leg. */
  const pointerMap = async (leg: string): Promise<string[]> => {
    const r = report(leg);
    const out = health(leg, r);
    const pr = r?.probe;
    if (!pr) return [...out, `${leg}: no probe`];
    const sh = await shot(leg);
    if (!sh) out.push(`${leg}: no shot`);
    for (const want of [
      "raised-art-centre",
      "raised-panel-bottom",
      "scaled-art-corner",
      "plain-art-centre",
    ])
      if (!pr.cases.some((c) => c.name === want && !c.missing))
        out.push(`${leg}: case ${want} is missing`);
    for (const c of pr.cases) {
      if (c.missing || !c.game || !c.drawn || !c.item) continue;
      const tag = `${leg} ${c.name}`;
      if (!c.got) {
        out.push(`${tag}: toGame gave null`);
        continue;
      }
      if (c.overridden && near(c.game, c.drawn))
        out.push(
          `${tag}: the override moved nothing (${c.game} -> ${c.drawn})`,
        );
      if (!c.overridden && !near(c.game, c.drawn))
        out.push(`${tag}: a plain item drawn off its game position`);
      if (c.got.item !== c.item)
        out.push(`${tag}: hit item ${c.got.item}, want ${c.item}`);
      if (c.hitTest !== c.item)
        out.push(`${tag}: query.hitTest ${c.hitTest}, want ${c.item}`);
      if (!near(c.got.point, c.game))
        out.push(`${tag}: game point ${c.got.point}, want ${c.game}`);
      if (!near(c.got.drawn, c.drawn))
        out.push(`${tag}: presentation point ${c.got.drawn}, want ${c.drawn}`);
      if (c.cssToPresentation && !near(c.cssToPresentation, c.drawn))
        out.push(
          `${tag}: cssToPresentation ${c.cssToPresentation}, want ${c.drawn}`,
        );
      if (c.got.itemSlot !== String(c.slot))
        out.push(`${tag}: the hit is in card ${c.got.itemSlot}`);
      if (
        (sh && c.name.endsWith("art-centre")) ||
        c.name === "scaled-art-corner"
      )
        if (sh && !isArt(pixel(sh, c.drawn)))
          out.push(
            `${tag}: the shot at ${c.drawn} is ${pixel(sh, c.drawn)}, not Art`,
          );
    }
    const v = pr.vacated;
    if (v.missing || !v.game || !v.got) out.push(`${leg}: no vacated probe`);
    else {
      if (v.got.itemSlot === "1") out.push(`${leg} vacated: still hits card 1`);
      if (!near(v.got.point, v.game))
        out.push(`${leg} vacated: ${v.got.point}, want ${v.game} unmapped`);
      if (sh && isArt(pixel(sh, v.game)))
        out.push(`${leg} vacated: the shot still shows Art at ${v.game}`);
    }
    return out;
  };
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const leg of INP_LEGS) {
      problems.push(...(await pointerMap(leg)));
      const pr = report(leg)?.probe;
      if (pr)
        notes.push(
          `${leg}: ${pr.presentation.join("x")} in ${pr.css.join("x")} (scale ${pr.scale.toFixed(3)}), ${pr.cases.length} taps`,
        );
    }
    mk(
      "pointer-map",
      "INP1: a tap at a raised item's drawn point maps to its game position, a scaled item's likewise, a non-overridden item maps to itself, and the spot a raised card left holds nothing of it; the hit is the item drawn there (query.hitTest) and its pixels are in the shot; at 16:9 and 21:9 presentations in a CSS box of another aspect",
      problems,
      notes.join("; "),
    );
  }
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const leg of INP_LEGS) {
      const pr = report(leg)?.probe;
      if (!pr) {
        problems.push(`${leg}: no probe`);
        continue;
      }
      let bars = 0;
      for (const b of pr.letterbox) {
        if (b.cssToPresentation !== null || b.clientToGame !== null)
          problems.push(
            `${leg} ${b.name}: mapped (${JSON.stringify(b.cssToPresentation)})`,
          );
        if (b.inBox && b.name !== "outside-box") bars++;
      }
      if (bars < 2)
        problems.push(`${leg}: only ${bars} bar probes inside the box`);
      const [a, c] = [pr.corners.a, pr.corners.b];
      if (!a || !c) problems.push(`${leg}: a picture corner mapped to null`);
      else if (
        !near([a.x, a.y], [0.5, 0.5], 0.05) ||
        !near(
          [c.x, c.y],
          [pr.presentation[0] - 0.5, pr.presentation[1] - 0.5],
          0.05,
        )
      )
        problems.push(`${leg}: corners ${JSON.stringify([a, c])}`);
      const o = pr.overlay;
      if (!o.got || !o.want) problems.push(`${leg}: no overlay rect`);
      else if (
        !near([o.got.x, o.got.y], [o.want.x, o.want.y], 0.05) ||
        !near([o.got.w, o.got.h], [o.want.w, o.want.h], 0.05)
      )
        problems.push(
          `${leg}: presentationToCss ${JSON.stringify(o.got)}, want ${JSON.stringify(o.want)}`,
        );
      notes.push(`${leg}: ${bars} bar probes null`);
    }
    mk(
      "pointer-letterbox",
      "INP1: a point on a letterbox bar or outside the canvas's box maps to null, the picture's corners map to the presentation's, and presentationToCss lays an item's rect on the page by the same layout",
      problems,
      notes.join("; "),
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
    "inverse-skip",
    "INP1 sabotage inverse-skip (toGame returns the point unmapped): fails pointer-map's raised and scaled taps",
    async () =>
      (await pointerMap("sabotage-inverse-skip")).filter((p) =>
        p.includes("game point"),
      ),
  );
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
