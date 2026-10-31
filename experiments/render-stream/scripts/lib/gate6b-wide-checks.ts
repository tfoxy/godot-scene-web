// PRES-A (gate6-design.md "Amendment (PRES-A)"; client-extensions-design.md §6 PRES-A): g6b's
// viewer-aspect presentation legs under <out>/wide/ (lib/gate6b-legs.sh run_g6b_wide). The HD
// fixture (logical 1920x1080, canvas_items) with display/window/stretch/aspect="expand" is captured
// at GRC_ROOT_SIZE=presentation:<P> for P = 1920x1080 (16:9), 2340x1080 and 2520x1080 (stretch
// scale 1: the visible rect widens to P) and 1170x540 (the 2340-wide frame at scale 0.5), and
// replayed by rendered receivers at P against a rendered reference of the same copy at P.
//
//   wide-presentation-declared   each wide capture classifies success and its session (both sinks)
//     declares policy presentation, presentation_size and host_window_size P, host_size_status
//     match, stretch canvas_items/expand/fractional, logical 1920x1080, font_oversampling and the
//     host_final_xform at P's scale, and host_visible_rect the stretch's visible size for P
//     (render-stream-2.ts stretchVisibleSize; 2340x1080 for 1170x540)
//   wide-16x9-byte-identical      capture-1920x1080 (expand at 16:9) equals g6h's capture-native
//     (keep, enforce-min-size) record for record on both sinks; the session differs only in
//     viewport.stretch.aspect and viewport.root_size_policy (cmp-rec.ts)
//   wide-reference-extends-native  reference-2340x1080/-2520x1080: the reference oracle's visible
//     rect is P, and every shot's left 1920 columns equal g6h's reference-native shot exactly (the
//     grid keeps its cells at their minimum width; the expand only adds columns)
//   leg-class-receiver-wide-<P>   each receiver classifies success: stretch adopted, presentation
//     and oversampling checks ok, nothing typed, every seq applied, every pixel of every shot equals
//     reference-<P> (budget 0)
//   receiver-vs-reference-wide    the three receivers' pixels, summed
//   leg-class-sabotage-receiver-ignore-presentation-wide  ignore-presentation at 1170x540 differs
//     from reference-1170x540 at every shot and is typed oversampling-mismatch
//   ignore-presentation-at-scale-1  (report) the same sabotage at 2340x1080 draws reference-2340x1080
//     exactly: a disabled stretch of a 2340x1080 window IS the expand presentation at scale 1, so
//     ignore-presentation is no sabotage there (why the gating leg is at 1170x540)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readJson } from "./gate-minus1-checks";
import {
  type AppliedJson,
  type Checkpoint,
  classifyLeg,
  PATCH_RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
} from "./gate0-checks";
import { evaluateCapture, type Gate3CaptureEvaluation } from "./gate3-checks";
import { check } from "./gate5-checks";
import {
  evaluateUnsupportedClass,
  type Frame6,
  type Gate6Check,
  shotSeqs,
  unsupportedPairs,
  wantedClass,
} from "./gate6a-checks";
import type { G6bLegEntry } from "./gate6b-checks";
import { evaluateAppliedViewport } from "./gate6b-checks";
import {
  type Gate6HdExpected,
  loadFrame,
  requestedSeqs,
  shotFiles,
} from "./gate6h-checks";
import { stretchVisibleSize } from "./render-stream-2";

const HERE = dirname(fileURLToPath(import.meta.url));

export const WIDE_DIR = "wide";
/** The receiver presentations (gate6b-legs.sh G6B_WIDE_SIZES) and the 16:9 control capture. */
export const WIDE_SIZES: [number, number][] = [
  [2340, 1080],
  [2520, 1080],
  [1170, 540],
];
export const WIDE_HALF: [number, number] = [1170, 540];
const WIDE_CONTROL: [number, number] = [1920, 1080];
const LOGICAL: [number, number] = [1920, 1080];
/** gate6-scene regions that draw text (fixtures/gate6-scene/README.md "Layout": undecided text). */
export const TEXT_REGIONS = new Set(["SC", "RT", "HU", "PB", "BT", "LE", "LB"]);

export const sizeName = (p: [number, number]) => `${p[0]}x${p[1]}`;

/** The gate 7 GSW legs of the wide group (lib/gate7-gsw-g6.ts GATE6_LEGS). */
export const WIDE_GSW_LEGS = [
  ...WIDE_SIZES.map((p) => `${WIDE_DIR}/receiver-${sizeName(p)}`),
  `${WIDE_DIR}/sabotage-receiver-ignore-presentation`,
];

interface ViewportMeta {
  logical_size?: number[];
  stretch?: { mode?: string; aspect?: string; scale_mode?: string };
  root_size_policy?: string;
  presentation_size?: number[];
  host_size_status?: string;
  host_window_size?: number[];
  font_oversampling?: number;
}

/** Pure: one wide recording's session declares presentation `p` under expand. */
export function evaluateWideSession(
  recording: Pick<RecordingSummary, "session" | "session_blocks" | "present">,
  p: [number, number],
  label: string,
): string[] {
  if (!recording.present) return [`${label}: recording missing`];
  const v = (recording.session as unknown as { viewport?: ViewportMeta })
    ?.viewport;
  const scale = p[1] / LOGICAL[1];
  const got = {
    logical_size: v?.logical_size,
    stretch: v?.stretch,
    root_size_policy: v?.root_size_policy,
    presentation_size: v?.presentation_size,
    host_size_status: v?.host_size_status,
    host_window_size: v?.host_window_size,
    font_oversampling: v?.font_oversampling,
  };
  const want = {
    logical_size: LOGICAL,
    stretch: {
      mode: "canvas_items",
      aspect: "expand",
      scale_mode: "fractional",
    },
    root_size_policy: "presentation",
    presentation_size: p,
    host_size_status: "match",
    host_window_size: p,
    font_oversampling: scale,
  };
  const problems: string[] = [];
  if (JSON.stringify(got) !== JSON.stringify(want))
    problems.push(
      `${label}: viewport ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
    );
  const visible = stretchVisibleSize(want.stretch, LOGICAL, p);
  const blocks = recording.session_blocks ?? [];
  if (
    JSON.stringify(blocks[2]) !== JSON.stringify([0, 0, visible[0], visible[1]])
  )
    problems.push(
      `${label}: host_visible_rect ${JSON.stringify(blocks[2])}, expected [0,0,${visible[0]},${visible[1]}]`,
    );
  if (JSON.stringify(blocks[3]) !== JSON.stringify([scale, 0, 0, scale, 0, 0]))
    problems.push(
      `${label}: host_final_xform ${JSON.stringify(blocks[3])}, expected scale ${scale}`,
    );
  return problems;
}

interface Diff {
  compared: number;
  mismatched: number;
  maxDelta: number;
}

/** Pure: raw RGBA comparison of `a` against `b` over columns [x0, x1) of both (rows all). */
export function diffColumns(
  a: Frame6,
  b: Frame6,
  x0 = 0,
  x1 = Math.min(a.width, b.width),
): Diff {
  const out: Diff = { compared: 0, mismatched: 0, maxDelta: 0 };
  const h = Math.min(a.height, b.height);
  for (let y = 0; y < h; y++)
    for (let x = x0; x < x1; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 4; c++)
        d = Math.max(d, Math.abs(a.rgba[ia + c] - b.rgba[ib + c]));
      out.compared++;
      if (d > 0) {
        out.mismatched++;
        out.maxDelta = Math.max(out.maxDelta, d);
      }
    }
  return out;
}

/** cmp-rec.ts --json on two recordings (its main exits, so it runs as a child). */
function cmpRec(
  a: string,
  b: string,
  allow: string[],
): { identical: boolean; detail: string } {
  const script = resolve(HERE, "..", "cmp-rec.ts");
  const r = spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "--conditions=development",
      script,
      "--json",
      "--allow-session",
      allow.join(","),
      a,
      b,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: resolve(HERE, "..") },
  );
  const text = (r.stdout ?? "").trim();
  let detail = text.slice(0, 400);
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    detail = JSON.stringify(j).slice(0, 400);
  } catch {
    detail = `${detail} ${(r.stderr ?? "").slice(0, 200)}`;
  }
  return { identical: r.status === 0, detail };
}

export async function runGate6bWide(
  out: string,
  hd: Gate6HdExpected,
): Promise<{
  checks: Gate6Check[];
  legs: Record<string, G6bLegEntry>;
} | null> {
  const X = join(out, WIDE_DIR);
  if (!existsSync(X)) return null;
  const H = join(out, "hd");
  const checks: Gate6Check[] = [];
  const legs: Record<string, G6bLegEntry> = {};
  const scaleOf = (p: [number, number]) => p[1] / LOGICAL[1];

  // Captures.
  const caps = new Map<string, Gate3CaptureEvaluation>();
  {
    const problems: string[] = [];
    const detail: string[] = [];
    for (const p of [WIDE_CONTROL, ...WIDE_SIZES]) {
      const name = `capture-${sizeName(p)}`;
      const ev = await evaluateCapture(X, {
        legDir: name,
        expectedClass: wantedClass(hd.unsupported),
      });
      caps.set(sizeName(p), ev);
      problems.push(
        ...evaluateUnsupportedClass(ev, unsupportedPairs(ev.full), []).map(
          (x) => `${name}: ${x}`,
        ),
        ...evaluateWideSession(ev.full, p, `${name} full`),
        ...evaluateWideSession(ev.patch, p, `${name} patch`),
      );
      detail.push(`${sizeName(p)} ${ev.result_class}`);
      legs[`capture-wide-${sizeName(p)}`] = {
        group: "g6b",
        expected_class: "success",
        result_class: ev.result_class,
        reasons: ev.reasons,
        exit_code: ev.exit_code,
        artifacts: ev.artifacts,
      };
    }
    checks.push(
      check(
        "wide-presentation-declared",
        "PRES-A: the HD fixture under stretch aspect expand, captured at GRC_ROOT_SIZE=presentation:<P> for P in 1920x1080, 2340x1080, 2520x1080 and 1170x540, classifies success, and each session (both sinks) declares root_size_policy presentation, presentation_size and host_window_size P, host_size_status match (the amended rule: the visible rect is the stretch's visible size for P), stretch canvas_items/expand/fractional, logical_size 1920x1080, font_oversampling P.h/1080, host_final_xform scale P.h/1080, and host_visible_rect [0,0] + that visible size (2340x1080 for both 2340x1080 and 1170x540, 2520x1080, 1920x1080)",
        problems.slice(0, 10),
        detail.join(", "),
        [...caps.values()].map((c) => c.full.path),
      ),
    );
  }

  // 16:9 under expand changes nothing but two declared session keys.
  {
    const problems: string[] = [];
    const detail: string[] = [];
    for (const sink of ["recording.rs2", PATCH_RECORDING_NAME]) {
      const a = join(H, "capture-native", sink);
      const b = join(X, `capture-${sizeName(WIDE_CONTROL)}`, sink);
      if (!existsSync(a) || !existsSync(b)) {
        problems.push(`${sink}: recording missing`);
        continue;
      }
      const r = cmpRec(a, b, [
        "viewport.stretch.aspect",
        "viewport.root_size_policy",
      ]);
      if (!r.identical) problems.push(`${sink}: ${r.detail}`);
      detail.push(`${sink} ${r.identical ? "identical" : "differs"}`);
    }
    checks.push(
      check(
        "wide-16x9-byte-identical",
        "PRES-A: capture-1920x1080 (aspect expand, presentation:1920x1080) equals g6h's capture-native (aspect keep, enforce-min-size) record for record on both sinks (cmp-rec.ts: every transaction, resource and end record byte-identical); its session differs only in viewport.stretch.aspect and viewport.root_size_policy, so a 16:9 viewer of an expand seat gets today's stream",
        problems,
        detail.join(", "),
        [join(X, `capture-${sizeName(WIDE_CONTROL)}`)],
      ),
    );
  }

  // The references: a superset of the native frame.
  {
    const problems: string[] = [];
    let compared = 0;
    let textPx = 0;
    let bandPx = 0;
    let otherPx = 0;
    for (const p of WIDE_SIZES.filter((s) => s[1] === LOGICAL[1])) {
      const dir = join(X, `reference-${sizeName(p)}`);
      const oracleText = existsSync(join(dir, "oracle.jsonl"))
        ? readFileSync(join(dir, "oracle.jsonl"), "utf8")
        : "";
      const visibles = new Set<string>();
      for (const line of oracleText.split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as {
            viewport?: { visible_size?: number[]; window_size?: number[] };
          };
          visibles.add(
            JSON.stringify([o.viewport?.visible_size, o.viewport?.window_size]),
          );
        } catch {
          problems.push(`${sizeName(p)}: unparseable oracle line`);
        }
      }
      const wantVisible = JSON.stringify([p, p]);
      if (visibles.size !== 1 || !visibles.has(wantVisible))
        problems.push(
          `${sizeName(p)}: oracle [visible_size, window_size] ${[...visibles].join(" ") || "none"}, expected ${wantVisible}`,
        );
      for (const shot of hd.shots) {
        const wide = await loadFrame(join(dir, "shots", `${shot.id}.png`));
        const nat = await loadFrame(
          join(H, "reference-native", "shots", `${shot.id}.png`),
        );
        if (!wide || !nat) {
          problems.push(`${sizeName(p)} ${shot.id}: shot missing`);
          continue;
        }
        if (wide.width !== p[0] || wide.height !== p[1]) {
          problems.push(
            `${sizeName(p)} ${shot.id}: ${wide.width}x${wide.height}`,
          );
          continue;
        }
        // The engine's own raster of a wider target is not bit-stable (the projection divides by
        // the target width): pixels may differ by one level (Q7's delta1). On NVIDIA only glyph
        // edges in the regions that draw text move (gate 6's undecided RT and LB, and the text of
        // SC, HU, PB, BT and LE); on llvmpipe interpolated colours too. Counted per kind.
        const undecided = Object.entries(
          shot.regions as Record<string, number[]>,
        )
          .filter(([n]) => TEXT_REGIONS.has(n.replace(/^c\d+\./, "")))
          .map(([, b]) => b);
        const inUndecided = (x: number, y: number) =>
          undecided.some((b) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3]);
        for (let y = 0; y < LOGICAL[1]; y++)
          for (let x = 0; x < LOGICAL[0]; x++) {
            const ia = (y * wide.width + x) * 4;
            const ib = (y * nat.width + x) * 4;
            let dd = 0;
            for (let c = 0; c < 4; c++)
              dd = Math.max(dd, Math.abs(wide.rgba[ia + c] - nat.rgba[ib + c]));
            compared++;
            if (dd === 0) continue;
            if (dd <= 1) {
              if (inUndecided(x, y)) textPx++;
              else bandPx++;
              continue;
            }
            otherPx++;
            if (otherPx <= 4)
              problems.push(
                `${sizeName(p)} ${shot.id}: (${x},${y}) differs from reference-native by ${dd}${inUndecided(x, y) ? " in a text region" : ""}`,
              );
          }
      }
    }
    checks.push(
      check(
        "wide-reference-extends-native",
        "PRES-A: reference-2340x1080 and -2520x1080 (the expand copy rendered at that window) lay out a visible size and window of exactly P (the HD oracle's viewport block at every settle step), and every shot's left 1920 columns equal g6h's reference-native shot within one level per channel (Q7's delta1: a wider target's raster is not bit-stable, the projection divides by the target width; on NVIDIA only glyph edges move, on llvmpipe interpolated mesh colours too; counted, split text regions vs elsewhere): Godot's expand re-layout only adds columns to the right of a grid whose cells keep their minimum width",
        problems.slice(0, 10),
        `pixels compared: ${compared}; ${textPx} px differ by 1 inside text regions and ${bandPx} elsewhere, ${otherPx} by more`,
        WIDE_SIZES.map((p) => join(X, `reference-${sizeName(p)}`, "shots")),
      ),
    );
  }

  // Receivers.
  const classify = async (
    dir: string,
    cap: Gate3CaptureEvaluation,
    seqs: Map<string, number>,
    refDir: string,
    diffs: { shot: string; diff: Diff | null }[],
  ) => {
    const applied = await readJson<AppliedJson>(join(dir, "applied.json"));
    const requested = await requestedSeqs(dir);
    const cps: Checkpoint[] = diffs.map((d) => ({
      step: Number(d.shot.replace(/^\D+/, "")),
      settle_frame: hd.shots.find((s) => s.id === d.shot)?.frame ?? 0,
      seq: seqs.get(d.shot) ?? null,
      reference_png: join(refDir, "shots", `${d.shot}.png`),
      receiver_png: join(dir, "shots", `seq-${seqs.get(d.shot)}.png`),
      diff_png: null,
      mismatched_pixels: d.diff?.mismatched ?? null,
      max_channel_delta: d.diff?.maxDelta ?? null,
      regions: [],
    }));
    const cls = classifyLeg({
      captureResult: cap.captureResult,
      recording: cap.full,
      receiver: {
        applied,
        requestedShotSeqs: requested,
        shotFiles: await shotFiles(dir, requested),
      },
      checkpoints: cps,
    });
    return { applied, cls };
  };
  const diffLeg = async (
    dir: string,
    refDir: string,
    seqs: Map<string, number>,
  ) => {
    const outDiffs: { shot: string; diff: Diff | null }[] = [];
    for (const shot of hd.shots) {
      const seq = seqs.get(shot.id);
      const ref = await loadFrame(join(refDir, "shots", `${shot.id}.png`));
      const got =
        seq === undefined
          ? null
          : await loadFrame(join(dir, "shots", `seq-${seq}.png`));
      outDiffs.push({
        shot: shot.id,
        diff:
          ref && got && ref.width === got.width && ref.height === got.height
            ? diffColumns(ref, got)
            : null,
      });
    }
    return outDiffs;
  };

  const vsRef: string[] = [];
  const vsDetail: string[] = [];
  for (const p of WIDE_SIZES) {
    const name = sizeName(p);
    const leg = `receiver-wide-${name}`;
    const dir = join(X, `receiver-${name}`);
    const refDir = join(X, `reference-${name}`);
    const cap = caps.get(name) as Gate3CaptureEvaluation;
    const seqs = shotSeqs(
      hd.shots as unknown as Parameters<typeof shotSeqs>[0],
      cap.full.transactions,
    );
    const diffs = await diffLeg(dir, refDir, seqs);
    const { applied, cls } = await classify(dir, cap, seqs, refDir, diffs);
    const problems = evaluateUnsupportedClass(
      cls,
      unsupportedPairs(cap.full),
      [],
    );
    problems.push(
      ...evaluateAppliedViewport(applied, {
        leg,
        check: "ok",
        stretch: true,
        presentation: p,
        oversampling: scaleOf(p),
        typed: [],
      }),
    );
    let missing = false;
    let any = false;
    for (const x of diffs) {
      if (!x.diff) {
        missing = true;
        vsRef.push(`${leg} ${x.shot}: shot missing`);
      } else if (x.diff.mismatched > 0) {
        any = true;
        vsRef.push(
          `${leg} ${x.shot}: ${x.diff.mismatched} px differ (max ${x.diff.maxDelta})`,
        );
      }
    }
    const verdict = missing ? "incomplete" : any ? "pixel-mismatch" : "success";
    if (verdict !== "success") problems.push(`pixels ${verdict}`);
    vsDetail.push(
      `${name} ${diffs.reduce((n, x) => n + (x.diff?.compared ?? 0), 0)}`,
    );
    checks.push(
      check(
        `leg-class-${leg}`,
        `PRES-A: the ${leg} leg (a rendered ${name} receiver on capture-${name}'s full sink) classifies success: it adopted the session's canvas_items/expand stretch (logical 1920x1080 at window ${name}), its visible rect is the host's, its presentation and oversampling checks are ok, it typed nothing, applied every seq, and every pixel of every shot equals reference-${name} (budget 0)`,
        problems.slice(0, 8),
        `${cls.result_class}, pixels ${verdict}`,
        [join(dir, "applied.json"), join(dir, "shots")],
      ),
    );
    legs[leg] = {
      group: "g6b",
      expected_class: "success",
      result_class: cls.result_class,
      pixel_verdict: verdict,
      expected_pixel_verdict: "success",
      reasons: cls.reasons,
      exit_code: await readExitCode(dir),
      artifacts: [join(dir, "applied.json"), join(dir, "shots")],
    };
  }
  checks.push(
    check(
      "receiver-vs-reference-wide",
      "PRES-A: receiver-wide-2340x1080, -2520x1080 and -1170x540: every pixel of every shot (settle and intermediate) equals the reference rendered at the same window, raw per channel with alpha; budget 0: a host evaluated at a viewer-aspect presentation under expand plus a receiver adopting the session's stretch reproduce Godot's own widescreen re-layout exactly",
      vsRef.slice(0, 10),
      `pixels compared: ${vsDetail.join(", ")}`,
      WIDE_SIZES.map((p) => join(X, `receiver-${sizeName(p)}`, "shots")),
    ),
  );

  // ignore-presentation at the wide half (gating) and at 2340x1080 (report).
  for (const [p, leg, gating] of [
    [WIDE_HALF, "sabotage-receiver-ignore-presentation", true],
    [
      [2340, 1080] as [number, number],
      "sabotage-receiver-ignore-presentation-2340x1080",
      false,
    ],
  ] as [[number, number], string, boolean][]) {
    const name = sizeName(p);
    const dir = join(X, leg);
    const refDir = join(X, `reference-${name}`);
    const cap = caps.get(name) as Gate3CaptureEvaluation;
    const seqs = shotSeqs(
      hd.shots as unknown as Parameters<typeof shotSeqs>[0],
      cap.full.transactions,
    );
    const diffs = await diffLeg(dir, refDir, seqs);
    const { applied, cls } = await classify(dir, cap, seqs, refDir, diffs);
    const problems: string[] = [];
    let differing = 0;
    let px = 0;
    for (const x of diffs) {
      if (!x.diff) problems.push(`${x.shot}: shot missing`);
      else if (x.diff.mismatched > 0) {
        differing++;
        px += x.diff.mismatched;
      }
    }
    if (gating) {
      if (cls.result_class !== "unsupported")
        problems.push(
          `class ${cls.result_class}, expected unsupported (oversampling-mismatch)`,
        );
      problems.push(
        ...evaluateAppliedViewport(applied, {
          leg,
          check: "mismatch",
          stretch: false,
          presentation: p,
          typed: ["oversampling-mismatch"],
        }),
      );
      if (differing !== hd.shots.length)
        problems.push(
          `${hd.shots.length - differing} shots equal reference-${name}`,
        );
      checks.push(
        check(
          "leg-class-sabotage-receiver-ignore-presentation-wide",
          `PRES-A: RS_RECEIVER_SABOTAGE=ignore-presentation (a ${name} receiver that keeps stretch disabled whatever the session says) on capture-${name} (the 2340-wide frame at scale 0.5) differs from reference-${name} at every shot (it presents the top-left of the logical frame at scale 1), and is typed oversampling-mismatch (its own 1 against the declared 0.5) with presentation_check mismatch`,
          problems.slice(0, 8),
          `${cls.result_class}; ${differing} of ${hd.shots.length} shots differ (${px} px)`,
          [join(dir, "applied.json"), join(dir, "shots")],
        ),
      );
      legs[leg + "-wide"] = {
        group: "g6b",
        expected_class: "unsupported",
        result_class: cls.result_class,
        pixel_verdict:
          differing === hd.shots.length ? "pixel-mismatch" : "incomplete",
        expected_pixel_verdict: "pixel-mismatch",
        reasons: cls.reasons,
        exit_code: await readExitCode(dir),
        artifacts: [join(dir, "applied.json"), join(dir, "shots")],
      };
    } else {
      if (differing !== 0)
        problems.push(
          `${differing} shots differ from reference-${name} (${px} px)`,
        );
      // A report: it always passes, and its detail says whether the no-op held.
      checks.push(
        check(
          "ignore-presentation-at-scale-1",
          `PRES-A (report, always passes): ignore-presentation at ${name} (stretch scale 1) is expected to draw reference-${name} exactly and type nothing: a disabled stretch of a ${name} window is the expand presentation itself, so the sabotage is a no-op at scale 1 and is judged at 1170x540 instead`,
          [],
          `${cls.result_class}; ${differing} of ${hd.shots.length} shots differ (${px} px)${problems.length ? `; ${problems.join("; ")}` : ""}`,
          [join(dir, "shots")],
        ),
      );
    }
  }

  return { checks, legs };
}
