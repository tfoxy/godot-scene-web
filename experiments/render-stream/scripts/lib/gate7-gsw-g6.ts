// Gate 7's GSW canvas receiver legs for gate 6 (G7g; protocol/gate7/g7g.md, gate7-design.md Q5,
// Q7, Q8): the declared 2D scene (ScrollContainer, RichTextLabel, CanvasLayers, StyleBoxFlat,
// ShaderMaterial, CanvasItemMaterial, a mesh, a moving sprite, top_level) at 640x360, and the HD
// fixture's nine cells at the `native` (1920x1080, canvas_items identity) and `half` (960x540,
// stretch 0.5, font oversampling 0.5) presentations. lib/gate7-gsw.ts runs these legs and judges
// them with gate 6's own checker (check-gate6.ts buildGate6Report) on a view of the source run,
// exactly as for gates 0 to 5 (G7a, G7t); this module holds what is gate 6 specific: the leg table,
// the receiver checks kept `@gsw` (G7b's mechanical classification of the same source groups:
// a check whose verdict changes when every receiver leg is emptied), and the Q7 plans.
//
// Q7 (gsw-tolerance.ts `gate6*` keys): one raster of gate 6's own model per shot (the scene's
// default and refused variants, the HD fixture at each presentation), so the moving AN sprite,
// the MS mesh and the PB bar are masked where they are at that frame. A receiver shot maps to its
// model shot through the native leg's applied.json (`frame` -> `seq`, as gate6a's seqsForShots),
// and is compared with the reference's `<shot id>.png`.
//
// The presentation hazard (`hd/receiver-half-at-logical`) is judged under the half model with its
// undecided (text) pixels left as drawn: its point is that they differ. The ignore-presentation
// sabotage is judged raw (every region must differ anyway). `animate` takes the default model
// with the regions its continuous writes change in `delta1` (gsw-tolerance.ts `gate6-animate`).
// Sabotages are paired with their honest gsw leg (G7t), so a mask never hides a sabotage's own
// change.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { GswLegDef, NotApplicable } from "./gate7-gsw";

export const GATE6_LEGS: GswLegDef[] = [
  // g6a: fixtures/gate6-scene, 640x360, stretch disabled.
  { leg: "scene/receiver", replaces: true, compositor: true },
  { leg: "scene/receiver-patch", replaces: true },
  { leg: "scene/receiver-inline", replaces: true },
  { leg: "animate/receiver", replaces: true, compositor: true },
  { leg: "refused/receiver", replaces: true, compositor: true },
  { leg: "scene/sabotage-freeze/receiver", replaces: true },
  { leg: "scene/sabotage-omit-transform/receiver", replaces: true },
  { leg: "scene/sabotage-perturb-vertex/receiver", replaces: true },
  { leg: "scene/sabotage-perturb-shader/receiver", replaces: true },
  { leg: "scene/sabotage-receiver-ignore-clip", replaces: true },
  { leg: "scene/sabotage-receiver-stale-texture", replaces: true },
  // g6b: the scene's CanvasLayers attached without stacking.
  { leg: "scene/sabotage-receiver-ignore-canvas-stacking", replaces: true },
  // g6h: fixtures/gate6-hd at `native` (1920x1080 backing store).
  { leg: "hd/receiver-native", replaces: true, compositor: true },
  { leg: "hd/receiver-native-patch", replaces: true },
  // g6b: `half` (960x540 backing store), the hazard, and ignore-presentation.
  { leg: "hd/receiver-half", replaces: true, compositor: true },
  { leg: "hd/receiver-half-patch", replaces: true },
  { leg: "hd/receiver-half-inline", replaces: true },
  { leg: "hd/receiver-half-at-logical", replaces: true },
  { leg: "hd/sabotage-receiver-ignore-presentation", replaces: true },
];

export const GATE6_NOT_APPLICABLE: NotApplicable[] = [
  ...[
    "live/live-scene",
    "live/live-scene-warm",
    "live/live-stall",
    "live/live-reconnect",
    "live/sabotage-live-stale-coalesce",
  ].map((leg) => ({
    leg,
    reason:
      "a g6l live leg: judged by run-gate7.sh --live (lib/gate7-live.ts), which runs gate 6's own runner with GATE7_LIVE_KIND (G7g)",
  })),
];

/** gate 6's checks that read a receiver leg of g6a/g6h/g6b (G7b's classification.json of the same
 * source groups lists exactly these as the web's; the gsw view replaces the same legs). */
export const GATE6_RECEIVER_CHECKS = {
  judged: [
    "leg-class-receiver-scene",
    "leg-class-receiver-scene-patch",
    "leg-class-receiver-scene-inline",
    "leg-class-receiver-animate",
    "leg-class-receiver-refused",
    "leg-class-sabotage-freeze",
    "leg-class-sabotage-omit-transform",
    "leg-class-sabotage-perturb-vertex",
    "leg-class-sabotage-perturb-shader",
    "leg-class-sabotage-receiver-ignore-clip",
    "leg-class-sabotage-receiver-stale-texture",
    "receiver-vs-reference",
    "leg-class-receiver-hd-native",
    "leg-class-receiver-hd-native-patch",
    "hd-receiver-vs-reference",
    "leg-class-receiver-hd-half",
    "leg-class-receiver-hd-half-patch",
    "leg-class-receiver-hd-half-inline",
    "receiver-vs-reference-half",
    "presentation-hazard-measured",
    "leg-class-sabotage-receiver-ignore-presentation",
    "leg-class-sabotage-receiver-ignore-canvas-stacking",
    "receiver-typed-clean",
  ],
  notApplicable: {} as Record<string, string>,
};

/** The leg's model (gsw-tolerance.json key) and reference directory, or null (judged raw). */
function planOf(
  leg: string,
): { key: string; reference: string; keepUndecided?: boolean } | null {
  if (leg === "hd/sabotage-receiver-ignore-presentation") return null;
  // The hazard against reference-hd-half under the half model, its undecided pixels (text, which
  // the hazard rasterizes at oversampling 1) left as drawn: presentation-hazard-measured needs
  // them to differ, and only the delta1 class's one-level differences are Q7's.
  if (leg === "hd/receiver-half-at-logical")
    return {
      key: "gate6-hd-half",
      reference: "hd/reference-half",
      keepUndecided: true,
    };
  if (leg.startsWith("hd/receiver-native"))
    return { key: "gate6-hd-native", reference: "hd/reference-native" };
  if (leg.startsWith("hd/"))
    return { key: "gate6-hd-half", reference: "hd/reference-half" };
  if (leg.startsWith("refused/"))
    return { key: "gate6-refused", reference: "refused/reference" };
  if (leg.startsWith("animate/"))
    return { key: "gate6-animate", reference: "animate/reference" };
  return { key: "gate6", reference: "scene/reference" };
}

function honestPairOf(leg: string): string | undefined {
  if (!/sabotage/.test(leg)) return undefined;
  return leg.startsWith("hd/") ? "hd/receiver-half" : "scene/receiver";
}

interface ShotsDoc {
  shots: { id: string; frame: number }[];
}

/** Gate 6's Q7 plan of a replaced leg: the tolerance key, the reference directory, and per
 * receiver shot seq its model shot index (`steps`) and reference file (`refs`). */
export function gate6Q7Plan(
  leg: string,
  sourceDir: string,
  fixturesDir: string,
): {
  key: string;
  reference: string;
  steps: Map<number, number>;
  refs: Map<number, string>;
  pair?: string;
  keepUndecided?: boolean;
} | null {
  const plan = planOf(leg);
  if (!plan) return null;
  const expected = JSON.parse(
    readFileSync(
      join(
        fixturesDir,
        plan.key.startsWith("gate6-hd") ? "gate6-hd" : "gate6-scene",
        "expected.json",
      ),
      "utf8",
    ),
  ) as ShotsDoc & { variants?: { refused?: ShotsDoc } };
  const shots =
    plan.key === "gate6-refused"
      ? (expected.variants?.refused?.shots ?? [])
      : expected.shots;
  let applied: { transactions?: { frame?: number; seq?: number }[] } = {};
  try {
    applied = JSON.parse(
      readFileSync(join(sourceDir, leg, "applied.json"), "utf8"),
    );
  } catch {
    // no native applied.json: no mapping, the view links the raw shots
  }
  const seqOfFrame = new Map<number, number>();
  for (const t of applied.transactions ?? [])
    if (typeof t.frame === "number" && typeof t.seq === "number")
      seqOfFrame.set(t.frame, t.seq);
  const steps = new Map<number, number>();
  const refs = new Map<number, string>();
  for (const [i, s] of shots.entries()) {
    const seq = seqOfFrame.get(s.frame);
    if (seq === undefined) continue;
    steps.set(seq, i);
    refs.set(seq, `${s.id}.png`);
  }
  const pair = honestPairOf(leg);
  return { ...plan, steps, refs, ...(pair ? { pair } : {}) };
}
