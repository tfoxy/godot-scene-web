// Gate 7's GSW canvas receiver legs for gates 4 and 5 (gate7-design.md "G7t", Q5, Q7, Q8): text
// (glyph atlases, outlines, fallbacks, rich spans, i18n, MSDF), geometry (lines, polylines,
// circles, polygons, primitives, triangle arrays, nine-patches, feathers, hairlines), meshes and
// styleboxes. lib/gate7-gsw.ts runs these legs and judges them with each gate's own checker on a
// view of the source run, exactly as for gates 0 to 3 (G7a); this module holds what is gate 4/5
// specific: the leg tables, the receiver checks each gate keeps `@gsw` (found by emptying every
// receiver leg of a source run and seeing which checks change, scripts/test/probe-receiver-checks
// .ts), the Q7 plans, and the checks G7t adds (lib/gate7-gsw-checks.ts calls `g45ExtraChecks`).
//
// Typed refusals (Q7's last row): a leg whose op GSW types is judged as typed: the gate's checker
// must class the leg `unsupported`, and the leg's applied.json receiver-typed reasons must be
// exactly the listed ones. G7t typed gate 4e's MSDF legs `gsw-msdf`; G7tm draws MSDF text with
// canvas.glsl's MSDF branch, so every gate 4e check is a receiver check again and no gate 4 or 5
// leg is typed.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GswLegDef, NotApplicable } from "./gate7-gsw";

export type G45Gate = "gate4" | "gate5";

const TRACE = (leg: string): NotApplicable => ({
  leg,
  reason:
    "a native --headless leg that exists to strace the receiver's file opens; a browser always renders and opens nothing (D11); no-source-scene@gsw replaces receiver-never-loaded-fixture",
});

export const G45_LEGS: Record<G45Gate, GswLegDef[]> = {
  gate4: [
    // g4b: fixtures/gate4 (Latin grayscale).
    { leg: "receiver", replaces: true, compositor: true },
    { leg: "receiver-patch", replaces: true },
    { leg: "sabotage-freeze/receiver", replaces: true },
    { leg: "sabotage-perturb/receiver", replaces: true },
    { leg: "sabotage-omit-atlas/receiver", replaces: true },
    // g4c: fixtures/gate4-layout (sizes, wrapping, outlines, shadows, subpixel, LCD).
    { leg: "layout/receiver", replaces: true, compositor: true },
    { leg: "layout/receiver-patch", replaces: true },
    { leg: "layout/sabotage-omit-atlas/receiver", replaces: true },
    { leg: "layout/lcd/receiver", replaces: true },
    // g4d: fixtures/gate4-rich (RichTextLabel spans, underline).
    { leg: "rich-receiver", replaces: true, compositor: true },
    { leg: "rich-receiver-patch", replaces: true },
    { leg: "rich-underline/receiver", replaces: true },
    // g4e: fixtures/gate4-msdf (MSDF text, G7tm) and the grayscale perturb-glyph sabotage.
    { leg: "msdf/receiver", replaces: true },
    { leg: "msdf/receiver-patch", replaces: true },
    { leg: "msdf/sabotage-perturb-glyph/receiver", replaces: true },
    { leg: "msdf/sabotage-receiver-drop/receiver", replaces: true },
    { leg: "msdf/sabotage-gray-perturb-glyph/receiver", replaces: true },
    // G7tm's MSDF sabotages (protocol/gate7/g7tm.md "Sabotages"): each must change exactly the
    // MSDF text regions drawn at each settle step, against the honest gsw leg.
    {
      leg: "msdf/sabotage-gsw-msdf-no-median",
      from: "msdf/receiver",
      env: { RS_RECEIVER_SABOTAGE: "msdf-no-median" },
      replaces: false,
    },
    {
      leg: "msdf/sabotage-gsw-msdf-px-range",
      from: "msdf/receiver",
      env: { RS_RECEIVER_SABOTAGE: "msdf-px-range" },
      replaces: false,
    },
    // g4f: fixtures/gate4-i18n (scripts, fallbacks, bidi).
    { leg: "i18n/receiver", replaces: true, compositor: true },
    { leg: "i18n/receiver-patch", replaces: true },
    { leg: "i18n/sabotage-omit-atlas/receiver", replaces: true },
  ],
  gate5: [
    // g5d: fixtures/gate5 (lines, polylines, polygons, primitives, circles, transforms, clip
    // ignore, nine-patches, feathers, hairlines, blends).
    { leg: "receiver", replaces: true, compositor: true },
    { leg: "receiver-patch", replaces: true },
    { leg: "sabotage-freeze/receiver", replaces: true },
    { leg: "sabotage-perturb-vertex/receiver", replaces: true },
    { leg: "sabotage-omit-polygon/receiver", replaces: true },
    { leg: "sabotage-receiver-ignore-set-transform", replaces: true },
    { leg: "sabotage-receiver-ignore-clip-ignore", replaces: true },
    // g5e: fixtures/gate5-mesh (GRM1 meshes).
    { leg: "mesh/receiver", replaces: true, compositor: true },
    { leg: "mesh/receiver-patch", replaces: true },
    { leg: "mesh/receiver-inline", replaces: true },
    { leg: "mesh/sabotage-mesh-freeze/receiver", replaces: true },
    { leg: "mesh/sabotage-mesh-omit-vertex-region/receiver", replaces: true },
    { leg: "mesh/sabotage-mesh-perturb-vertex/receiver", replaces: true },
    { leg: "mesh/sabotage-mesh-receiver-drop-surface", replaces: true },
    { leg: "mesh/sabotage-mesh-receiver-stale", replaces: true },
    // g5g: fixtures/gate5-style (nine-patch modes, StyleBoxFlat).
    { leg: "style/receiver", replaces: true, compositor: true },
    { leg: "style/receiver-patch", replaces: true },
    { leg: "style/sabotage-receiver-ignore-axis", replaces: true },
    // G7t's lowering sabotage (G7t "Sabotages"): a reversed triangle fan for add_polygon must
    // fail exactly gate 5b's polygon regions.
    {
      leg: "sabotage-gsw-polygon-winding",
      from: "receiver",
      env: { RS_RECEIVER_SABOTAGE: "polygon-winding" },
      replaces: false,
    },
  ],
};

export const G45_NOT_APPLICABLE: Record<G45Gate, NotApplicable[]> = {
  gate4: [
    TRACE("receiver-headless-trace"),
    TRACE("layout/receiver-headless-trace"),
    TRACE("msdf/receiver-headless-trace"),
    TRACE("i18n/receiver-headless-trace"),
  ],
  gate5: [
    TRACE("receiver-headless-trace"),
    TRACE("mesh/receiver-headless-trace"),
    TRACE("style/receiver-headless-trace"),
    ...[
      "mesh/live-mesh",
      "mesh/live-mesh-warm",
      "mesh/live-mesh-stall",
      "mesh/sabotage-mesh-stale-coalesce",
    ].map((leg) => ({
      leg,
      reason:
        "a g5f live leg: the GSW receiver's live mode (the /7 client and credit) is G7l's (gate7-design.md \"G7l\"); G7t lands file legs only",
    })),
  ],
};

/** A check the gate's checker fails only because GSW types an op: the gsw check passes when the
 * gate's checker classes each named leg `unsupported` and its applied.json carries exactly
 * `reasons` as receiver-typed (item null) entries. */
export interface TypedCheck {
  /** the gate report's leg names */
  legs: string[];
  /** the leg directories (relative to the gsw root) */
  dirs: string[];
  reasons: string[];
}

export interface G45ReceiverChecks {
  judged: string[];
  notApplicable: Record<string, string>;
  typed: Record<string, TypedCheck>;
}

const NEVER_LOADED =
  "strace of a --headless native leg; replaced by no-source-scene@gsw (Q8)";
const TYPED_CLEAN = "GDScript script-error markers in native logs";

export const G45_RECEIVER_CHECKS: Record<G45Gate, G45ReceiverChecks> = {
  gate4: {
    judged: [
      // g4b
      "leg-class-receiver",
      "leg-class-receiver-patch",
      "receiver-vs-reference",
      "expected-image-receiver",
      "expected-text-receiver",
      "ink-presence-receiver",
      "resource-quiet",
      "receiver-consumed-stream",
      "leg-class-sabotage-freeze",
      "leg-class-sabotage-perturb",
      "leg-class-sabotage-omit-atlas",
      // g4c
      "leg-class-receiver-layout",
      "leg-class-receiver-layout-patch",
      "receiver-vs-reference-layout",
      "expected-image-receiver-layout",
      "expected-text-receiver-layout",
      "ink-presence-receiver-layout",
      "resource-quiet-layout",
      "leg-class-sabotage-layout-omit-atlas",
      "sabotage-layout-omit-atlas-regions",
      "leg-class-receiver-lcd",
      "receiver-consumed-stream-layout",
      // g4e (G7tm: drawn, no longer typed gsw-msdf)
      "leg-class-receiver-msdf",
      "leg-class-receiver-msdf-patch",
      "leg-class-sabotage-msdf-perturb-glyph",
      "ink-presence-receiver-msdf",
      "sabotage-msdf-perturb-glyph-regions",
      "receiver-vs-reference-msdf",
      "expected-image-receiver-msdf",
      "receiver-msdf-commands",
      "resource-quiet-msdf",
      "leg-class-sabotage-msdf-receiver-drop",
      "sabotage-msdf-receiver-drop-regions",
      "leg-class-sabotage-gray-perturb-glyph",
      "sabotage-gray-perturb-glyph-regions",
      "receiver-consumed-stream-msdf",
      // g4f
      "leg-class-receiver-i18n",
      "leg-class-receiver-i18n-patch",
      "receiver-vs-reference-i18n",
      "expected-image-receiver-i18n",
      "expected-text-receiver-i18n",
      "ink-presence-receiver-i18n",
      "resource-quiet-i18n",
      "leg-class-sabotage-i18n-omit-atlas",
      "sabotage-i18n-omit-atlas-regions",
      "receiver-consumed-stream-i18n",
      // g4d
      "leg-class-rich-receiver",
      "leg-class-rich-receiver-patch",
      "rich-receiver-vs-reference",
      "rich-expected-image-receiver",
      "rich-ink-presence-receiver",
      "rich-resource-quiet",
      "leg-class-rich-underline-receiver",
      "rich-underline-receiver-vs-reference",
    ],
    notApplicable: {
      "receiver-never-loaded-fixture": NEVER_LOADED,
      "receiver-never-loaded-fixture-layout": NEVER_LOADED,
      "receiver-never-loaded-fixture-msdf": NEVER_LOADED,
      "receiver-never-loaded-fixture-i18n": NEVER_LOADED,
      "receiver-typed-clean": TYPED_CLEAN,
      "receiver-typed-clean-layout": TYPED_CLEAN,
      "receiver-typed-clean-msdf": TYPED_CLEAN,
      "receiver-typed-clean-i18n": TYPED_CLEAN,
    },
    typed: {},
  },
  gate5: {
    judged: [
      // g5d
      "leg-class-receiver",
      "leg-class-receiver-patch",
      "receiver-vs-reference",
      "expected-image-receiver",
      "presence-receiver",
      "clip-rects-derived",
      "leg-class-sabotage-freeze",
      "leg-class-sabotage-perturb-vertex",
      "leg-class-sabotage-omit-polygon",
      "leg-class-sabotage-receiver-ignore-set-transform",
      "leg-class-sabotage-receiver-ignore-clip-ignore",
      // g5g
      "leg-class-receiver-style",
      "leg-class-receiver-style-patch",
      "receiver-vs-reference-style",
      "expected-image-receiver-style",
      "presence-receiver-style",
      "clip-rects-derived-style",
      "leg-class-sabotage-style-receiver-ignore-axis",
      // g5e
      "leg-class-receiver-mesh",
      "leg-class-receiver-mesh-patch",
      "leg-class-receiver-mesh-inline",
      "receiver-vs-reference-mesh",
      "receiver-mesh-uploads",
      "fresh-without-redraw-receiver",
      "receiver-state-dumps-mesh",
      "leg-class-sabotage-mesh-freeze",
      "leg-class-sabotage-mesh-omit-vertex-region",
      "leg-class-sabotage-mesh-perturb-vertex",
      "leg-class-sabotage-mesh-receiver-drop-surface",
      "leg-class-sabotage-mesh-receiver-stale",
    ],
    notApplicable: {
      "receiver-never-loaded-fixture": NEVER_LOADED,
      "receiver-never-loaded-fixture-style": NEVER_LOADED,
      "receiver-never-loaded-fixture-mesh": NEVER_LOADED,
      "receiver-typed-clean": TYPED_CLEAN,
      "receiver-typed-clean-style": TYPED_CLEAN,
      "receiver-typed-clean-mesh": TYPED_CLEAN,
    },
    typed: {},
  },
};

/** The gate 4/5 Q7 plan of a replaced leg: the tolerance key and the reference directory, and
 * for gate 4's legs with early shots, the reference file of each early seq. */
export function g45Q7Plan(
  gate: G45Gate,
  leg: string,
  sourceDir: string,
): {
  key: string;
  reference: string;
  refs?: Map<number, string>;
  pair?: string;
} | null {
  const plan = g45Q7PlanOf(gate, leg, sourceDir);
  const pair = honestPairOf(gate, leg);
  return plan && pair ? { ...plan, pair } : plan;
}

/** A sabotage leg's honest gsw leg (the Q7 view's `pair`): the honest receiver of the same
 * fixture, whose shots share the sabotage leg's settle seqs. */
function honestPairOf(gate: G45Gate, leg: string): string | undefined {
  if (!/sabotage/.test(leg)) return undefined;
  if (gate === "gate5") {
    if (leg.startsWith("mesh/")) return "mesh/receiver";
    if (leg.startsWith("style/")) return "style/receiver";
    return "receiver";
  }
  if (leg.startsWith("layout/")) return "layout/receiver";
  if (leg.startsWith("i18n/")) return "i18n/receiver";
  if (leg === "msdf/sabotage-gray-perturb-glyph/receiver") return "receiver";
  if (leg.startsWith("msdf/")) return "msdf/receiver";
  return "receiver";
}

function g45Q7PlanOf(
  gate: G45Gate,
  leg: string,
  sourceDir: string,
): { key: string; reference: string; refs?: Map<number, string> } | null {
  const fixtures = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "fixtures",
  );
  const early = (fixture: string, reference: string) =>
    earlyRefs(
      join(sourceDir, leg),
      join(sourceDir, reference),
      join(fixtures, fixture, "expected.json"),
    );
  if (gate === "gate4") {
    // The drop-msdf sabotage draws no MSDF: judged raw, so its predicted MSDF regions show.
    if (leg === "msdf/sabotage-receiver-drop/receiver") return null;
    if (leg === "msdf/sabotage-gray-perturb-glyph/receiver")
      return { key: "gate4", reference: "reference" };
    if (leg.startsWith("layout/lcd/"))
      return { key: "gate4-layout", reference: "layout/lcd/reference" };
    for (const [prefix, key, fixture] of [
      ["layout/", "gate4-layout", "gate4-layout"],
      ["msdf/", "gate4-msdf", "gate4-msdf"],
      ["i18n/", "gate4-i18n", "gate4-i18n"],
    ] as const)
      if (leg.startsWith(prefix)) {
        const reference = `${prefix}reference`;
        return { key, reference, refs: early(fixture, reference) };
      }
    if (leg.startsWith("rich-underline/"))
      return { key: "gate4-rich", reference: "rich-underline/reference" };
    if (leg.startsWith("rich-"))
      return { key: "gate4-rich", reference: "rich-reference" };
    return {
      key: "gate4",
      reference: "reference",
      refs: early("gate4", "reference"),
    };
  }
  if (leg.startsWith("mesh/"))
    return { key: "gate5-mesh", reference: "mesh/reference" };
  if (leg.startsWith("style/"))
    return { key: "gate5-style", reference: "style/reference" };
  return { key: "gate5", reference: "reference" };
}

/** A gate 4 receiver leg's early shots (RS_RECEIVER_SHOT_SEQS beyond its settle seqs): the shot
 * of frame S + N·k + 1 (one frame after step k's upload) compares with `early-<k>.png` under step
 * k's masks. Seqs are frames in these fixtures' file recordings (one transaction per frame). */
function earlyRefs(
  sourceLegDir: string,
  referenceDir: string,
  expectedPath: string,
): Map<number, string> {
  const out = new Map<number, string>();
  let env = "";
  try {
    env = readFileSync(join(sourceLegDir, "env.txt"), "utf8");
  } catch {
    return out;
  }
  const all = (/^RS_RECEIVER_SHOT_SEQS=(.*)$/m.exec(env)?.[1] ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number);
  const settle = new Set(
    (existsSync(join(sourceLegDir, "shot-seqs.txt"))
      ? readFileSync(join(sourceLegDir, "shot-seqs.txt"), "utf8")
      : ""
    )
      .trim()
      .split(",")
      .filter(Boolean)
      .map(Number),
  );
  const e = JSON.parse(readFileSync(expectedPath, "utf8")) as {
    start_frame_default: number;
    step_frames_default: number;
  };
  for (const seq of all) {
    if (settle.has(seq)) continue;
    const k = (seq - e.start_frame_default - 1) / e.step_frames_default;
    if (!Number.isInteger(k) || k < 0) continue;
    if (existsSync(join(referenceDir, "shots", `early-${k}.png`)))
      out.set(seq, `early-${k}.png`);
  }
  return out;
}

/** The step of each early seq (`earlyRefs`'s keys), for the Q7 view's seq -> step map. */
export function earlySteps(refs: Map<number, string>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [seq, file] of refs) {
    const k = Number(/^early-(\d+)\.png$/.exec(file)?.[1] ?? Number.NaN);
    if (Number.isInteger(k)) out.set(seq, k);
  }
  return out;
}
