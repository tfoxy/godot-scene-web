// G7g's gate-7 checks on gate 6's browser legs (protocol/gate7/g7g.md "Checks"), shared by both
// browser receivers and by the file (g6a/g6h/g6b) and live (g6l) legs:
//
//   presentation-check@<kind>  each browser's canvas backing store equals the session's
//     presentation_size (the size gate 6's host declares and the native receiver's root window
//     has), at DPR 1, and every shot the receiver read back is that size. The presentation hazard
//     (`hd/receiver-half-at-logical`: a 960x540 window for a 1920x1080 presentation) is the one
//     leg whose backing store is its window instead, and whose applied.json says
//     presentation_check `mismatch`; ignore-presentation's says `mismatch` too (its oversampling).
//     Every other leg says `ok`.
//
// The backing store is read by the harness from the page at exit (timings.json `backing_store`,
// lib/gate7-web-legs.ts and lib/gate7-live-legs.ts), never from the receiver's own report.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodePngRgba } from "./gate-minus1-checks";
import { TEXT_REGIONS } from "./gate6b-wide-checks";
import type { Gate7Check } from "./gate7-adapters";
import type { BackingStore } from "./gate7-web-legs";

/** Legs whose applied.json must say presentation_check `mismatch` (gate6-design.md G6b As built 2
 * and 3); the hazard is also the one leg whose backing store is its window, not the presentation. */
const MISMATCH_LEGS = new Set([
  "hd/receiver-half-at-logical",
  "hd/sabotage-receiver-ignore-presentation",
  "wide/sabotage-receiver-ignore-presentation",
]);
const WINDOW_LEGS = new Set(["hd/receiver-half-at-logical"]);

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** One browser leg directory's problems; `leg` is its gate 6 leg path (for the two exceptions). */
export async function presentationProblems(
  leg: string,
  dir: string,
): Promise<{ problems: string[]; summary: string | null }> {
  const problems: string[] = [];
  const timings = readJson<{ backing_store?: BackingStore | null }>(
    join(dir, "timings.json"),
  );
  const applied = readJson<{
    viewport?: {
      presentation_size?: [number, number] | null;
      presentation_check?: string | null;
    };
  }>(join(dir, "applied.json"));
  const page = readJson<{ canvas?: [number, number] }>(
    join(dir, "page-config.json"),
  );
  const bs = timings?.backing_store ?? null;
  const pres = applied?.viewport?.presentation_size ?? null;
  if (!bs)
    return {
      problems: [`${leg}: no timings.json backing_store`],
      summary: null,
    };
  if (!pres)
    return {
      problems: [`${leg}: applied.json declares no presentation_size`],
      summary: null,
    };
  if (bs.canvases.length !== 1)
    problems.push(
      `${leg}: ${bs.canvases.length} canvases on the page, expected 1`,
    );
  const c = bs.canvases[0];
  if (bs.device_pixel_ratio !== 1)
    problems.push(`${leg}: devicePixelRatio ${bs.device_pixel_ratio}`);
  const want = WINDOW_LEGS.has(leg) ? (page?.canvas ?? null) : pres;
  if (!want) problems.push(`${leg}: no page-config canvas (the window)`);
  if (c && want && (c.width !== want[0] || c.height !== want[1]))
    problems.push(
      `${leg}: backing store ${c.width}x${c.height}, expected ${want[0]}x${want[1]}${WINDOW_LEGS.has(leg) ? " (the window)" : " (presentation_size)"}`,
    );
  if (
    WINDOW_LEGS.has(leg) &&
    want &&
    want[0] === pres[0] &&
    want[1] === pres[1]
  )
    problems.push(
      `${leg}: the hazard's window equals its presentation ${pres.join("x")}`,
    );
  const check = applied?.viewport?.presentation_check ?? null;
  const wantCheck = MISMATCH_LEGS.has(leg) ? "mismatch" : "ok";
  if (check !== wantCheck)
    problems.push(`${leg}: presentation_check ${check}, expected ${wantCheck}`);
  const shotsDir = join(dir, "shots");
  let shots = 0;
  if (c && existsSync(shotsDir))
    for (const f of readdirSync(shotsDir).filter((x) => x.endsWith(".png"))) {
      const img = await decodePngRgba(join(shotsDir, f));
      shots++;
      if (!img || img.width !== c.width || img.height !== c.height)
        problems.push(
          `${leg}: shot ${f} is ${img ? `${img.width}x${img.height}` : "unreadable"}, backing store ${c.width}x${c.height}`,
        );
    }
  return {
    problems,
    summary: c
      ? `${leg} ${c.width}x${c.height} (${shots} shots, ${check})`
      : null,
  };
}

/** One Q7-judged gate 6 leg for the per-region report: its gsw shots, the reference shot of each
 * seq, the model shot index, the tolerance key and the model's regions in shot pixels. */
export interface G6RegionLeg {
  leg: string;
  dir: string;
  key: string;
  referenceDir: string;
  steps: ReadonlyMap<number, number>;
  refs: ReadonlyMap<number, string>;
}

/** q7-regions-g6@gsw (report): per presentation size, the differing pixels of every Q7 class and
 * their max channel delta, and per region (HU included; HD cells folded into their base region)
 * the differing pixels and max delta, against the rendered reference. Gating only through
 * q7-pixel-policy@gsw (decided exact, delta1 within 1); this lists what the masks hold. */
export async function q7RegionsReport(
  legs: readonly G6RegionLeg[],
  regionsOf: (key: string, step: number) => Record<string, number[]> | null,
  classOf: (
    key: string,
    step: number,
    w: number,
    h: number,
  ) => Uint8Array | null,
): Promise<Gate7Check> {
  type Acc = { px: number; max: number };
  const bySize = new Map<
    string,
    { shots: number; cls: Acc[]; regions: Map<string, Acc> }
  >();
  const add = (a: Acc, d: number) => {
    a.px++;
    a.max = Math.max(a.max, d);
  };
  for (const l of legs) {
    for (const [seq, step] of l.steps) {
      const got = await decodePngRgba(join(l.dir, "shots", `seq-${seq}.png`));
      const ref = await decodePngRgba(
        join(l.referenceDir, l.refs.get(seq) ?? ""),
      );
      if (!got || !ref || got.width !== ref.width) continue;
      const cls = classOf(l.key, step, got.width, got.height);
      const regions = regionsOf(l.key, step);
      if (!cls || !regions) continue;
      const size = `${got.width}x${got.height}`;
      const s = bySize.get(size) ?? {
        shots: 0,
        cls: [0, 1, 2, 3].map(() => ({ px: 0, max: 0 })),
        regions: new Map<string, Acc>(),
      };
      bySize.set(size, s);
      s.shots++;
      const boxes = Object.entries(regions);
      for (let y = 0; y < got.height; y++)
        for (let x = 0; x < got.width; x++) {
          const i = (y * got.width + x) * 4;
          let d = 0;
          for (let c = 0; c < 4; c++)
            d = Math.max(d, Math.abs(got.data[i + c] - ref.data[i + c]));
          if (d === 0) continue;
          add(s.cls[cls[y * got.width + x]], d);
          const hit = boxes.find(
            ([, b]) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3],
          );
          const name = (hit?.[0] ?? "BG").replace(/^c\d+\./, "");
          const r = s.regions.get(name) ?? { px: 0, max: 0 };
          s.regions.set(name, r);
          add(r, d);
        }
    }
  }
  const parts = [...bySize].map(
    ([size, s]) =>
      `${size} (${s.shots} shots): decided ${s.cls[0].px} px, delta1 ${s.cls[1].px} px (max ${s.cls[1].max}), undecided ${s.cls[2].px} px (max ${s.cls[2].max}); by region ${[
        ...s.regions,
      ]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([n, r]) => `${n} ${r.px}/${r.max}`)
        .join(" ")}`,
  );
  return {
    id: "q7-regions-g6@gsw",
    criterion:
      "Q7 (report): gate 6's honest gsw legs against the rendered reference, per presentation size: differing pixels and max channel delta per Q7 class, and per region (HU included, HD cells folded into their base region) as px/max",
    passed: [...bySize.values()].every((s) => s.cls[0].px === 0),
    gating: false,
    detail: parts.join(" | "),
  };
}

/** presentation-check@<kind> over a set of browser leg directories (`leg` -> dir). */
export async function presentationCheck(
  kind: string,
  legs: ReadonlyMap<string, string>,
): Promise<Gate7Check> {
  const problems: string[] = [];
  const sizes = new Map<string, number>();
  for (const [leg, dir] of legs) {
    if (!existsSync(dir)) {
      problems.push(`${leg}: no leg directory`);
      continue;
    }
    const r = await presentationProblems(leg, dir);
    problems.push(...r.problems);
    const size = /(\d+x\d+)/.exec(r.summary ?? "")?.[1];
    if (size) sizes.set(size, (sizes.get(size) ?? 0) + 1);
  }
  return {
    id: `presentation-check@${kind}`,
    criterion:
      "G7g: each browser leg's canvas backing store (read from the page at exit, DPR 1) equals the session's presentation_size, and every shot it read back is that size; the presentation hazard's is its 960x540 window; applied.json presentation_check is ok on every leg but the hazard and ignore-presentation (mismatch)",
    passed: problems.length === 0,
    gating: true,
    detail:
      problems.length === 0
        ? `${legs.size} legs: ${[...sizes].map(([s, n]) => `${n} at ${s}`).join(", ")}`
        : problems.slice(0, 12).join("; "),
  };
}

/**
 * PRES-A: wide-composition@<kind>. A browser's wide legs (g6b's wide/: the HD fixture under aspect
 * expand) have no Q7 model, so their verdict is composed from what is judged elsewhere:
 *   - each wide shot's columns [0, base width) equal, pixel for pixel, the same browser's shot of the
 *     same seq on the 16:9 leg of the same scale (wide/receiver-2340x1080 and -2520x1080 against
 *     hd/receiver-native, wide/receiver-1170x540 against hd/receiver-half), which Q7 judges against
 *     its reference (q7-pixel-policy@<kind>);
 *   - its remaining columns equal the wide reference's (wide/reference-<P>) raw;
 *   - and the source run's wide-reference-extends-native shows the wide reference's left columns are
 *     the native reference.
 * So the browser's wide frame is the 16:9 one plus exactly the reference's added columns.
 */
export async function wideCompositionCheck(
  kind: string,
  sourceDir: string,
  legDir: (leg: string) => string,
): Promise<Gate7Check> {
  const problems: string[] = [];
  const parts: string[] = [];
  const legs: { leg: string; base: string; size: [number, number] }[] = [
    {
      leg: "receiver-2340x1080",
      base: "hd/receiver-native",
      size: [2340, 1080],
    },
    {
      leg: "receiver-2520x1080",
      base: "hd/receiver-native",
      size: [2520, 1080],
    },
    { leg: "receiver-1170x540", base: "hd/receiver-half", size: [1170, 540] },
  ];
  const seqOfFrame = (dir: string): Map<number, number> => {
    const a = readJson<{ transactions?: { frame?: number; seq?: number }[] }>(
      join(dir, "applied.json"),
    );
    const m = new Map<number, number>();
    for (const t of a?.transactions ?? [])
      if (typeof t.frame === "number" && typeof t.seq === "number")
        m.set(t.frame, t.seq);
    return m;
  };
  const shotsDoc = readJson<{
    shots: { id: string; frame: number; regions: Record<string, number[]> }[];
  }>(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "fixtures",
      "gate6-hd",
      "expected.json",
    ),
  );
  for (const l of legs) {
    const dir = legDir(`wide/${l.leg}`);
    const baseDir = legDir(l.base);
    const refDir = join(
      sourceDir,
      "wide",
      `reference-${l.size[0]}x${l.size[1]}`,
      "shots",
    );
    const baseW = l.base === "hd/receiver-half" ? 960 : 1920;
    // Shots are named by seq; seqs come from the native (source) leg's frame map, which the browser
    // leg shares (the same recording).
    const seqs = seqOfFrame(join(sourceDir, "wide", l.leg));
    let left = 0;
    let right = 0;
    let text = 0;
    let band = 0;
    let n = 0;
    for (const shot of shotsDoc?.shots ?? []) {
      const seq = seqs.get(shot.frame);
      if (seq === undefined) continue;
      const scale = l.size[1] / 1080;
      const textBoxes = Object.entries(shot.regions)
        .filter(([n]) => TEXT_REGIONS.has(n.replace(/^c\d+\./, "")))
        .map(([, b]) => b.map((v) => v * scale));
      const inText = (x: number, y: number) =>
        textBoxes.some((b) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3]);
      const wide = await decodePngRgba(join(dir, "shots", `seq-${seq}.png`));
      const base = await decodePngRgba(
        join(baseDir, "shots", `seq-${seq}.png`),
      );
      const ref = await decodePngRgba(join(refDir, `${shot.id}.png`));
      if (!wide || !base || !ref) {
        problems.push(
          `${l.leg} ${shot.id}: a shot is missing (wide ${!!wide}, base ${!!base}, ref ${!!ref})`,
        );
        continue;
      }
      if (
        wide.width !== l.size[0] ||
        wide.height !== l.size[1] ||
        ref.width !== l.size[0]
      ) {
        problems.push(
          `${l.leg} ${shot.id}: ${wide.width}x${wide.height}, ref ${ref.width}x${ref.height}`,
        );
        continue;
      }
      n++;
      for (let y = 0; y < wide.height; y++)
        for (let x = 0; x < wide.width; x++) {
          const i = (y * wide.width + x) * 4;
          let other: Uint8Array;
          let j: number;
          if (x < baseW) {
            other = base.data;
            j = (y * base.width + x) * 4;
          } else {
            other = ref.data;
            j = i;
          }
          let d = 0;
          for (let c = 0; c < 4; c++)
            d = Math.max(d, Math.abs(wide.data[i + c] - other[j + c]));
          if (d === 0) continue;
          // As the native wide-reference-extends-native: a wider target's raster is not
          // bit-stable (the projection divides by the target width), so the base columns may
          // differ by one level (Q7's delta1): glyph edges on NVIDIA, interpolated colours too on
          // llvmpipe. Counted, split text regions vs elsewhere.
          if (x < baseW && d <= 1) {
            if (inText(x, y)) text++;
            else band++;
            continue;
          }
          if (x < baseW) left++;
          else right++;
        }
    }
    if (n === 0) problems.push(`${l.leg}: no shot compared`);
    if (left > 0)
      problems.push(
        `${l.leg}: ${left} px of the left ${baseW} columns differ from ${l.base}`,
      );
    if (right > 0)
      problems.push(
        `${l.leg}: ${right} px of the added columns differ from the wide reference`,
      );
    parts.push(
      `${l.leg} ${n} shots (${text} px within 1 in text regions, ${band} elsewhere)`,
    );
  }
  return {
    id: `wide-composition@${kind}`,
    criterion:
      "PRES-A: each browser wide shot (aspect expand at 2340x1080, 2520x1080, 1170x540) equals the same browser's 16:9 shot of the same seq (hd/receiver-native, hd/receiver-half: Q7-judged) in the base columns (within one level per channel, Q7's delta1: a wider target's raster is not bit-stable; counted) and the wide reference in the added columns, raw; with wide-reference-extends-native, the wide frame is the judged 16:9 frame plus exactly the reference's added columns",
    passed: problems.length === 0,
    gating: true,
    detail:
      problems.length === 0
        ? parts.join(", ")
        : problems.slice(0, 8).join("; "),
  };
}
