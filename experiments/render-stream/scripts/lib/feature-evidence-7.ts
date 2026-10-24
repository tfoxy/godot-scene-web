// Gate 7 group G7z (protocol/gate7-design.md "Q11. Feature manifests: `render-stream-features/2`"):
// the per-receiver evidence map behind protocol/features/render-stream-7/{native,web-export,
// gsw-canvas}.json. scripts/make-features.ts --receiver <kind> is the generator; this file is its
// editorial content, as lib/feature-evidence.ts is for the /1 manifest.
//
// Every /2 file has the same entry ids: render-stream-6.json's 115 (the /7 live wire carries the /6
// feature lists unchanged: G7w, "/7 is live-transport-only") plus the /7 entries below
// (`G7_ENTRIES`). The three files differ in status, exactness, tolerance and evidence:
//
// - native: the /1 entry with its gate 6 / gate 5.5 evidence (receiver_kind "native"), plus the /7
//   live evidence of g7-r@native.
// - web-export and gsw-canvas: each /1 evidence reference is translated to the browser's OWN leg
//   and check (`BROWSER_EVIDENCE`), never kept as the native one (Q11 manifest-no-substitution).
//   A /1 reference with no browser leg makes a supported entry `declared-unverified` for that
//   browser, with the gap named in `notes`.
//
// Evidence references name a group (`gate`: "gate6", "gate5.5" for the native gate reports,
// "g7-0".."g7-k" for gate 7's; `<group>-live` is a group's live run, `g7-r-w1` g7-r at window 1), a leg and the real check id that group's report writes (memory
// rs-g6z-manifest-check-id-suffix: copy ids from a result.json, never from the design prose). Which
// run each group@kind is quoted from is `EVIDENCE_RUNS`; lib/gate7z-checks.ts's
// manifest-evidence re-reads that run and requires the check to have passed there.
//
// Device targets (Q11 `limits.receiver.device_targets`, D25) are not editorial: make-features.ts
// --collect derives them from the g31 runs in `DEVICE_RUNS` into
// protocol/features/render-stream-7/collected.json, which generation reads. G7z's amendment
// (2026-10-23, protocol/gate7/g7z.md) removed the g86 entries: the user descoped that phone, so
// each browser file has six targets (the g31's), not twelve.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FEATURE_ENTRIES,
  type FeatureEntry,
  type FeatureKind,
} from "./feature-evidence";

export type ReceiverKind = "native" | "web-export" | "gsw-canvas";
/** The receiver kind's short form, the `@<kind>` suffix of gate 7 check ids. */
export type ShortKind = "native" | "web" | "gsw";
export const RECEIVER_KINDS: readonly ReceiverKind[] = [
  "native",
  "web-export",
  "gsw-canvas",
];
export const SHORT_KIND: Record<ReceiverKind, ShortKind> = {
  native: "native",
  "web-export": "web",
  "gsw-canvas": "gsw",
};
export const MANIFEST_FILE: Record<ReceiverKind, string> = {
  native: "native.json",
  "web-export": "web-export.json",
  "gsw-canvas": "gsw-canvas.json",
};

export type FeatureStatus2 =
  | "supported"
  | "typed-unsupported"
  | "receiver-typed"
  | "unobserved"
  | "declared-unverified";
export type FeatureExactness2 =
  | "exact"
  | "delta1"
  | "band"
  | "repeat-budget"
  | null;

export interface EvidenceRef2 {
  gate: string;
  fixture: string;
  leg: string;
  check: string;
  receiver_kind: ReceiverKind;
}

export interface FeatureEntry2 {
  id: string;
  kind: FeatureKind;
  name: string;
  status: FeatureStatus2;
  reason: string | null;
  exactness: FeatureExactness2;
  tolerance: string | null;
  evidence: EvidenceRef2[];
  owner: string | null;
  notes: string | null;
}

/** Reasons a receiver itself types (Q11 `receiver-typed`); every other refusal reason a
 * receiver records is the wire's (the host typed it) or a sabotage's. `gsw-msdf` and
 * `gsw-hairline` were retired by G7tm and G7t and must never be observed again. */
export const RECEIVER_TYPED_REASONS: readonly string[] = [
  "gsw-shader-transpile",
  "cache-budget-unsupported",
  "gsw-msdf",
  "gsw-hairline",
];

// -------------------------------------------------------------------------------------------
// The quoted runs. Paths are relative to the evidence root (default
// <main checkout>/artifacts/render-stream/gate7). `build` is the commit the run was made from.
// Every row is G7z's closing run (g7z.md "Pass"): one build, main at 6a454065 (G7rf landed, so
// G7kh 0fc739f7, G7w2c d78be95f and G7kr 099a92f9 are in it), run locally from one worktree into
// gate7/g7z/. The paths were fixed before the live runs, because every live hello carries the
// sha256 of the file these rows are part of (manifest-matches-hello); a rerun replaces a run in
// place. Outcomes, reruns and labelled failures are in results/gate7/g7z.md, not here.
// -------------------------------------------------------------------------------------------

export interface EvidenceRun {
  /** "<group>@<short kind>" this run is quoted for. */
  key: string;
  /** a run directory holding result.json, or a result.json file itself */
  path: string;
  build: string;
  note: string;
}

export const PRIMARY_BUILD = "6a454065";
const VA = "g7z/va";
const LIVE = "g7z/live";

export const EVIDENCE_RUNS: readonly EvidenceRun[] = [
  // native: gates 6 and 5.5 from the closing run's full native tier, and the /7 rate group
  {
    key: "gate6@native",
    path: "g7z/vg6/native-rust-gate6/run",
    build: PRIMARY_BUILD,
    note: "G7z closing run, native gate 6 (every group incl. g6z, sabotage legs, recordings kept for g7-z)",
  },
  {
    key: "gate5.5@native",
    path: `${VA}/native-rust-gate55/run`,
    build: PRIMARY_BUILD,
    note: "G7z closing run, native gate 5.5 (sabotage legs)",
  },
  {
    key: "g7-r@native",
    path: `${LIVE}/native-g7-r/run`,
    build: PRIMARY_BUILD,
    note: "G7z closing run, g7-r native at credit window 2 (real time, --manifest-hello)",
  },
  {
    key: "g7-r-w1@native",
    path: `${LIVE}/native-g7-r-w1/run`,
    build: PRIMARY_BUILD,
    note: "G7z closing run, g7-r native at --credit-window 1 (dual-native, late-poll, ack-on-receipt)",
  },
  // browsers, file groups: the closing run's full tier, locally (per-check reports kept)
  ...["g7-0", "g7-1", "g7-2", "g7-3", "g7-4", "g7-5", "g7-55", "g7-6"].flatMap(
    (g): EvidenceRun[] => [
      {
        key: `${g}@gsw`,
        path: `${VA}/g7-gsw/run`,
        build: PRIMARY_BUILD,
        note: "G7z closing run, gsw file legs g7-0..g7-6 (full tier, local)",
      },
      {
        key: `${g}@web`,
        path: `${VA}/g7-web-rust/run`,
        build: PRIMARY_BUILD,
        note: "G7z closing run, web/rust file legs g7-0..g7-6 (full tier, local)",
      },
    ],
  ),
  // browsers, live groups, every run with --manifest-hello at credit window 2 unless named
  ...(["gsw", "web"] as const).flatMap((k): EvidenceRun[] => [
    ...["g7-1", "g7-5", "g7-55"].map(
      (g): EvidenceRun => ({
        key: `${g}-live@${k}`,
        path: `${LIVE}/${k}-corr/run`,
        build: PRIMARY_BUILD,
        note: `G7z closing run, live g7-1/g7-5/g7-55 ${k} (fast frames, --manifest-hello)`,
      }),
    ),
    {
      key: `g7-2-live@${k}`,
      path: `${LIVE}/${k}-g7-2/run`,
      build: PRIMARY_BUILD,
      note: `G7z closing run, live g7-2 ${k} (fast frames, --manifest-hello)`,
    },
    ...["g7-6", "g7-lc", "g7-k"].map(
      (g): EvidenceRun => ({
        key: g === "g7-6" ? `g7-6-live@${k}` : `${g}@${k}`,
        path: `${LIVE}/${k}-timing/run`,
        build: PRIMARY_BUILD,
        note: `G7z closing run, live g7-6/g7-lc/g7-k ${k} (real time, --manifest-hello; g7-lc's real-suspension device rows typed unavailable)`,
      }),
    ),
    {
      key: `g7-r@${k}`,
      path: `${LIVE}/${k}-g7-r/run`,
      build: PRIMARY_BUILD,
      note: `G7z closing run, g7-r ${k} at credit window 2 (real time, --manifest-hello)`,
    },
    {
      key: `g7-r-w1@${k}`,
      path: `${LIVE}/${k}-g7-r-w1/run`,
      build: PRIMARY_BUILD,
      note: `G7z closing run, g7-r ${k} at --credit-window 1 (dual-native, late-poll, ack-on-receipt)`,
    },
  ]),
];

/** The g31 runs device targets are derived from (make-features.ts --collect). `window` limits
 * which windows a run is quoted for; the newest run per (kind, window) wins. */
export interface DeviceRun {
  kind: ShortKind;
  device: "g31";
  path: string;
  build: string;
  windows: (1 | 2)[];
  note: string;
}
export const DEVICE_RUNS: readonly DeviceRun[] = [
  {
    kind: "gsw",
    device: "g31",
    path: "g7z/g31-gsw/run",
    build: PRIMARY_BUILD,
    windows: [2],
    note: "G7z closing run, g31 gsw at credit window 2 (G7V_WINDOWS=2)",
  },
  {
    kind: "web",
    device: "g31",
    path: "g7z/g31-web/run",
    build: PRIMARY_BUILD,
    windows: [2],
    note: "G7z closing run, g31 web/rust at credit window 2 (G7V_WINDOWS=2)",
  },
  // Window 1 was not rerun on the closing build (window 2 is the default, F1); G7v's runs are
  // quoted, so these targets are `unverified` on this build and name G7v's own verdict.
  {
    kind: "gsw",
    device: "g31",
    path: "g7v/g7v-g31-gsw",
    build: "c9026a06+G7v",
    windows: [1],
    note: "G7v, g31 gsw window 1 (not rerun on the closing build: window 2 is the default)",
  },
  {
    kind: "web",
    device: "g31",
    path: "g7v/g7v-g31-web",
    build: "c9026a06+G7v",
    windows: [1],
    note: "G7v, g31 web window 1 (not rerun on the closing build: window 2 is the default)",
  },
];

// -------------------------------------------------------------------------------------------
// Exactness. GSW's comes from fixtures/gsw-tolerance.json (Q7): a gate whose masks have
// undecided pixels or a synthesized raster is `band` with that gate's tolerance id, one with
// delta1 regions only is `delta1`, one with neither is `exact`. The web export's comes from G7b's
// band (readback rounding ∪ delta1, at most one level per channel): exact on gates 0, 1 and 3,
// whose 0.2-grid values give the same byte both ways, delta1 elsewhere.
// -------------------------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..", "..");
export const GSW_TOLERANCE_PATH = join(
  EXPERIMENT_DIR,
  "fixtures",
  "gsw-tolerance.json",
);

interface ToleranceDoc {
  gates: Record<
    string,
    {
      raster?: unknown;
      steps: { delta1?: unknown[]; undecided?: unknown[] }[];
    }
  >;
}

let toleranceCache: ToleranceDoc | null = null;
function tolerance(): ToleranceDoc {
  toleranceCache ??= JSON.parse(
    readFileSync(GSW_TOLERANCE_PATH, "utf8"),
  ) as ToleranceDoc;
  return toleranceCache;
}

export function toleranceIds(): string[] {
  return Object.keys(tolerance().gates);
}

/** The gsw-tolerance.json gate a browser evidence reference is judged under. */
function toleranceKey(group: string, leg: string): string | null {
  switch (group) {
    case "g7-0":
      return "gate0";
    case "g7-1":
      return "gate1";
    case "g7-2":
      return "gate2";
    case "g7-3":
      return leg.includes("xform") ? "gate3-xform" : "gate3";
    case "g7-4":
      for (const v of ["layout", "rich", "i18n", "msdf"])
        if (leg.includes(v)) return `gate4-${v}`;
      return "gate4";
    case "g7-5":
      if (leg.startsWith("mesh/")) return "gate5-mesh";
      if (leg.startsWith("style/")) return "gate5-style";
      return "gate5";
    case "g7-55":
      if (leg.startsWith("cim-modulate/")) return "gate55-cim-modulate";
      if (leg.startsWith("cim/")) return "gate55-cim";
      return "gate55-shader";
    case "g7-6":
      if (leg.startsWith("hd/receiver-native")) return "gate6-hd-native";
      if (leg.startsWith("hd/")) return "gate6-hd-half";
      if (leg.startsWith("refused/")) return "gate6-refused";
      if (leg.startsWith("animate/")) return "gate6-animate";
      return "gate6";
    default:
      return null;
  }
}

const EXACTNESS_RANK: Record<string, number> = {
  exact: 0,
  delta1: 1,
  band: 2,
};

function gswExactness(ref: EvidenceRef2): {
  exactness: FeatureExactness2;
  tolerance: string | null;
} {
  const key = toleranceKey(ref.gate, ref.leg);
  if (!key) return { exactness: null, tolerance: null };
  const gate = tolerance().gates[key];
  if (!gate)
    throw new Error(`feature-evidence-7: no gsw-tolerance gate ${key}`);
  const undecided = gate.steps.some((s) => (s.undecided?.length ?? 0) > 0);
  const delta1 = gate.steps.some((s) => (s.delta1?.length ?? 0) > 0);
  if (undecided || gate.raster !== undefined)
    return { exactness: "band", tolerance: key };
  return { exactness: delta1 ? "delta1" : "exact", tolerance: key };
}

function webExactness(ref: EvidenceRef2): FeatureExactness2 {
  if (!ref.gate.startsWith("g7-") || toleranceKey(ref.gate, ref.leg) === null)
    return null;
  return ["g7-0", "g7-1", "g7-3"].includes(ref.gate) ? "exact" : "delta1";
}

/** The loosest exactness over an entry's image evidence (an entry is only as exact as its
 * weakest leg); `repeat-budget` and null pass through from the /1 entry. */
function browserExactness(
  kind: "web-export" | "gsw-canvas",
  base: FeatureEntry,
  refs: readonly EvidenceRef2[],
): { exactness: FeatureExactness2; tolerance: string | null } {
  if (base.exactness === null || base.exactness === "repeat-budget")
    return { exactness: base.exactness, tolerance: null };
  let best: { exactness: FeatureExactness2; tolerance: string | null } = {
    exactness: null,
    tolerance: null,
  };
  for (const ref of refs) {
    const e =
      kind === "gsw-canvas"
        ? gswExactness(ref)
        : { exactness: webExactness(ref), tolerance: null };
    if (e.exactness === null) continue;
    if (
      best.exactness === null ||
      EXACTNESS_RANK[e.exactness] > EXACTNESS_RANK[best.exactness]
    )
      best = e;
  }
  return best;
}

// -------------------------------------------------------------------------------------------
// The /1 -> browser evidence translation, keyed by the /1 reference's "<leg>|<check>". Each
// value lists the browser's own (group, leg, check base); the check id is `<base>@<short>` for
// groups that suffix (every g7 group but g7-k). An empty list is "no browser leg replays this".
// -------------------------------------------------------------------------------------------

type BrowserRef = [group: string, leg: string, check: string];

const BROWSER_EVIDENCE: Record<string, BrowserRef[]> = {
  "capture-scene|scene-census": [
    ["g7-6", "scene/receiver", "receiver-vs-reference"],
  ],
  "receiver-scene|receiver-vs-reference": [
    ["g7-6", "scene/receiver", "receiver-vs-reference"],
  ],
  "receiver-hd-native|receiver-vs-reference": [
    ["g7-6", "hd/receiver-native", "hd-receiver-vs-reference"],
  ],
  "receiver-hd-half|canvas-stacking-parity": [
    ["g7-6", "hd/receiver-half", "receiver-vs-reference-half"],
    [
      "g7-6",
      "scene/sabotage-receiver-ignore-canvas-stacking",
      "leg-class-sabotage-receiver-ignore-canvas-stacking",
    ],
  ],
  "receiver-hd-half|stylebox-aa-scale": [
    ["g7-6", "hd/receiver-half", "receiver-vs-reference-half"],
  ],
  "receiver-hd-half-at-logical|presentation-hazard-measured": [
    ["g7-6", "hd/receiver-half-at-logical", "presentation-hazard-measured"],
  ],
  "capture-hd-half|presentation-declared": [
    ["g7-6", "hd/receiver-half", "presentation-check"],
  ],
  "capture-refused|leg-class-capture-refused": [
    ["g7-6", "refused/receiver", "leg-class-receiver-refused"],
    ["g7-6", "refused/receiver", "receiver-typed-clean"],
  ],
  "capture-scene|recordings-decode": [
    ["g7-2", "receiver-cold", "upload-accounting"],
    ["g7-2", "receiver-inline", "leg-class-receiver-inline"],
  ],
  "capture-scene-inline|recordings-decode": [
    ["g7-2", "unsupported-textures/receiver", "unsupported-regions"],
  ],
  "capture-snap|snap-typed": [],
  "constrained|host-unperturbed-constrained": [
    ["g7-r", "constrained", "host-unperturbed-constrained"],
  ],
  "dual-60-15|dual-independent-dual-60-15": [
    ["g7-r-w1", "dual-native", "dual-independent-dual-native"],
  ],
  "rate-60|rate-achieved-rate-60": [
    ["g7-r", "phase-60-r1", "rate-achieved-phase-60-r1"],
  ],
  "soak-scene|g6s-cache-budget-respected-soak-scene": [
    ["g7-k", "soak-scene", "g6s-cache-budget-respected-soak-scene"],
  ],
  "receiver-scene|atlas-parity": [
    ["g7-4", "receiver", "receiver-vs-reference"],
  ],
  "receiver-scene|scroll-parity": [
    ["g7-6", "scene/receiver", "receiver-vs-reference"],
  ],
  "reference-scene-repeat|reference-repeat-budget": [
    ["g7-6", "scene/receiver", "source-run-valid"],
  ],
  "capture-policy-exclude|shader-policy-respected": [
    ["g7-55", "shader-refused/receiver", "leg-class-receiver-refused"],
  ],
  "capture-policy-params|shader-policy-respected": [
    [
      "g7-55",
      "shader-policy-params/receiver-nolib",
      "leg-class-receiver-params-nolib",
    ],
  ],
  "receiver-params-nolib|shader-policy-respected": [
    [
      "g7-55",
      "shader-policy-params/receiver-nolib",
      "leg-class-receiver-params-nolib",
    ],
    ["g7-55", "shader/receiver", "shader-receiver-typed"],
  ],
};

/** Extra browser evidence per entry id and short kind, beyond the translation. */
const BROWSER_EXTRA: Record<
  string,
  Partial<Record<"web" | "gsw", BrowserRef[]>>
> = {
  "text.rasterization-and-atlas": {
    gsw: [
      // glyph-boxes-exact@gsw is report-only (P-G2's prediction), so it is not evidence.
      ["g7-4", "receiver", "atlas-upload-parity"],
    ],
  },
};

const GROUP_CHECK_SUFFIXED = (group: string): boolean => group !== "g7-k";

function browserRef(
  kind: "web-export" | "gsw-canvas",
  fixture: string,
  [group, leg, check]: BrowserRef,
): EvidenceRef2 {
  const short = SHORT_KIND[kind];
  return {
    gate: group,
    fixture,
    leg,
    check: GROUP_CHECK_SUFFIXED(group) ? `${check}@${short}` : check,
    receiver_kind: kind,
  };
}

function nativeEntry(base: FeatureEntry): FeatureEntry2 {
  return {
    id: base.id,
    kind: base.kind,
    name: base.name,
    status: base.status,
    reason: base.reason,
    exactness: base.exactness,
    tolerance: null,
    evidence: base.evidence.map((e) => ({ ...e, receiver_kind: "native" })),
    owner: base.owner,
    notes: base.notes,
  };
}

function browserEntry(
  kind: "web-export" | "gsw-canvas",
  base: FeatureEntry,
): FeatureEntry2 {
  const short = SHORT_KIND[kind] as "web" | "gsw";
  const refs: EvidenceRef2[] = [];
  const missing: string[] = [];
  for (const e of base.evidence) {
    const key = `${e.leg}|${e.check}`;
    const mapped = BROWSER_EVIDENCE[key];
    if (mapped === undefined)
      throw new Error(
        `feature-evidence-7: no browser translation for ${base.kind}:${base.id}'s /1 evidence ${key}`,
      );
    if (mapped.length === 0) missing.push(key);
    for (const m of mapped) refs.push(browserRef(kind, e.fixture, m));
  }
  for (const m of BROWSER_EXTRA[base.id]?.[short] ?? [])
    refs.push(browserRef(kind, "gate6-scene", m));
  const evidence = dedupe(refs);
  let status: FeatureStatus2 = base.status;
  let notes = base.notes;
  if (base.status === "supported" && evidence.length === 0) {
    status = "declared-unverified";
    notes = joinNotes(
      notes,
      `no ${kind} leg replays the /1 evidence (${missing.join(", ")}); the wire carries it as for native`,
    );
  }
  const ex =
    status === "supported"
      ? browserExactness(kind, base, evidence)
      : { exactness: null, tolerance: null };
  return {
    id: base.id,
    kind: base.kind,
    name: base.name,
    status,
    reason: base.reason,
    exactness: ex.exactness,
    tolerance: ex.tolerance,
    evidence,
    owner: base.owner,
    notes,
  };
}

function dedupe(refs: EvidenceRef2[]): EvidenceRef2[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.gate}|${r.leg}|${r.check}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function joinNotes(a: string | null, b: string): string {
  return a ? `${a} ${b}` : b;
}

// -------------------------------------------------------------------------------------------
// /1 entries whose meaning changes with the receiver kind (gate 7 was their owner).
// -------------------------------------------------------------------------------------------

type Override = (kind: ReceiverKind, e: FeatureEntry2) => FeatureEntry2;

const BROWSER_PROOF: BrowserRef[] = [
  ["g7-0", "receiver", "receiver-vs-reference"],
  ["g7-6", "scene/receiver", "receiver-vs-reference"],
  ["g7-1-live", "live", "live-vs-reference"],
  ["g7-6", "scene/receiver", "browser-provenance"],
];

const OVERRIDES: Record<string, Override> = {
  "control.browser-receivers": (kind, e) =>
    kind === "native"
      ? {
          ...e,
          owner: "gate 7 (G7z): each browser receiver has its own file",
          notes:
            "Not a native capability. web-export.json and gsw-canvas.json record each browser receiver separately (D1); neither substitutes for the other.",
        }
      : {
          ...e,
          status: "supported",
          exactness: kind === "web-export" ? "exact" : "band",
          tolerance: kind === "web-export" ? null : "gate6",
          evidence: BROWSER_PROOF.map((r) =>
            browserRef(kind, "gate6-scene", r),
          ),
          owner: null,
          notes:
            kind === "web-export"
              ? "The Godot 4.5.1 web export (web_dlink_nothreads, Rust core as a side module) under the pinned Chromium; its own legs only (D1)."
              : "The GSW canvas receiver (rs-core wasm + canvas-items) under the pinned Chromium; its own legs only (D1).",
        },
  "delivery.presented_timing": (_kind, e) => ({
    ...e,
    owner: "post gate 7: no receiver reads presentation feedback",
    notes:
      "Q12: `presented` is `unavailable` for every receiver, the phones included (`content_update_hz` is the compositor's activation rate, never called presented).",
  }),
  "viewport.presentation-size-negotiation": (_kind, e) => ({
    ...e,
    owner: "post gate 7: one presentation size per session",
    notes:
      "Gate 7 kept one host evaluation per session; a receiver at another size types presentation-mismatch (Q4).",
  }),
};

// -------------------------------------------------------------------------------------------
// The /7 entries: live-transport capabilities gate 7 added. Same ids in every file.
// -------------------------------------------------------------------------------------------

interface G7Spec {
  id: string;
  kind: FeatureKind;
  name: string;
  native: Partial<FeatureEntry2> & { status: FeatureStatus2 };
  browser: (short: "web" | "gsw") => Partial<FeatureEntry2> & {
    status: FeatureStatus2;
    refs?: BrowserRef[];
  };
}

function nativeRef(
  gate: string,
  fixture: string,
  leg: string,
  check: string,
): EvidenceRef2 {
  return { gate, fixture, leg, check, receiver_kind: "native" };
}

const G7_SPECS: readonly G7Spec[] = [
  {
    id: "delivery.live_credit_window",
    kind: "delivery",
    name: "render-stream/7 negotiated credit window (1, or 2 by default since G7wd)",
    native: {
      status: "supported",
      evidence: [
        nativeRef(
          "g7-r",
          "gate6-scene",
          "phase-60-r1",
          "rate-achieved-phase-60-r1@native",
        ),
        nativeRef(
          "g7-r",
          "gate6-scene",
          "phase-60-r1",
          "phase-window2-rate-phase-60-r1@native",
        ),
      ],
      notes:
        "F1 resolved twice: window 2 opt-in (2026-10-14), then the default (G7wd 2431d26f, 2026-10-22). Window 1 stays explicit (--credit-window 1, GRC_LIVE_CREDIT_WINDOW_MAX=1, RS_RECEIVER_CREDIT_WINDOW=1).",
    },
    browser: () => ({
      status: "supported",
      refs: [
        ["g7-r", "phase-60-r1", "rate-achieved-phase-60-r1"],
        ["g7-r", "phase-60-r1", "phase-window2-rate-phase-60-r1"],
        ["g7-r-w1", "phase-60-r1", "rate-achieved-phase-60-r1"],
      ],
      notes:
        "Window 2 is the default (G7wd); window 1 is explicit and its g7-r list (late-poll, ack-on-receipt) passed in G7w2c's addendum.",
    }),
  },
  {
    id: "delivery.live_token_and_origin",
    kind: "delivery",
    name: "/7 hello token, HTTP token and Origin allowlist",
    native: {
      status: "declared-unverified",
      notes:
        "The native receiver sends the same /7 hello (receiver.gd hello_v7), but no native live leg runs the auth sabotages; g7-2's are browser legs.",
    },
    browser: () => ({
      status: "supported",
      refs: [
        ["g7-2-live", "live-auth", "leg-class-live-auth"],
        ["g7-2-live", "origin-refused", "origin-refused"],
        ["g7-2-live", "live", "token-not-logged"],
      ],
    }),
  },
  {
    id: "delivery.page_lifecycle",
    kind: "delivery",
    name: "page suspension (hidden, frozen), reload, close and WebGL context loss",
    native: {
      status: "unobserved",
      owner: "not applicable: a native receiver has no page lifecycle",
      notes:
        "g7-lc runs browser receivers only (run-gate7.sh refuses --receiver native).",
    },
    browser: () => ({
      status: "supported",
      refs: [
        ["g7-lc", "sim-hidden-30s", "leg-class@SHORT:sim-hidden-30s"],
        ["g7-lc", "sim-frozen-30s", "leg-class@SHORT:sim-frozen-30s"],
        ["g7-lc", "reload", "reload-pixels@SHORT:reload"],
        ["g7-lc", "context-loss", "context-pixels@SHORT:context-loss"],
      ],
      notes:
        "Desktop suspensions are simulated (page-side rAF pause, G7u fork 2026-10-18); the real hidden/frozen rows need the g31 and are typed `unavailable` on the desktop (G7u e7c8235f passed them on the g31).",
    }),
  },
  {
    id: "delivery.soak_memory_bounded",
    kind: "delivery",
    name: "a 300-s live soak with bounded receiver memory",
    native: {
      status: "supported",
      evidence: [
        nativeRef(
          "gate6",
          "gate6-scene",
          "soak-scene",
          "g6s-residency-bounded-soak-scene",
        ),
      ],
    },
    browser: (short) => ({
      status: "supported",
      refs: [
        ["g7-k", "soak-scene", "g6s-residency-bounded-soak-scene"],
        [
          "g7-k",
          "soak-scene",
          short === "gsw"
            ? "g7k-soak-scene-js-heap-bounded"
            : "g7k-soak-scene-wasm-heap-bounded",
        ],
        ["g7-k", "soak-scene", "g7k-soak-scene-gpu-mem-bounded"],
        ...(short === "gsw"
          ? ([
              ["g7-k", "soak-scene", "g7k-soak-scene-rss-bounded-renderer"],
            ] as BrowserRef[])
          : []),
      ],
      notes:
        short === "gsw"
          ? "G7kr 099a92f9: rss-bounded-renderer judges the receiver page's own renderer (found by a 128 MiB touch probe) on post-GC samples, against Q10's bound plus 5 KiB per payload GET (the harness's CDP Network-domain record, not receiver state)."
          : "rss-bounded-renderer is report-only on the web export, typed known-shortfall (G7kr 099a92f9, owner G7kw2): the page renderer grows about 7-10 MB/min post-GC against Q10's 2 MiB/min (the engine's GL-id tables plus about 6 MB/min of PartitionAlloc no one-factor control explains). It is not cited as evidence; the other three bounds are.",
    }),
  },
  {
    id: "delivery.startup",
    kind: "delivery",
    name: "cold and warm startup to the first submitted frame",
    native: {
      status: "unobserved",
      owner: "not measured: gate 7's startup legs are browser legs (D15)",
      notes: "G7k's startup legs run the browser receivers only.",
    },
    browser: () => ({
      status: "supported",
      refs: [
        ["g7-k", "startup-warm-r1", "g7k-startup-complete-startup-warm-r1"],
        ["g7-k", "startup-cold-r1", "g7k-startup-complete-startup-cold-r1"],
      ],
    }),
  },
  {
    id: "delivery.disk_cache_budget",
    kind: "delivery",
    name: "a receiver disk-cache budget with LRU eviction (G6s)",
    native: {
      status: "supported",
      evidence: [
        nativeRef(
          "gate6",
          "gate6-scene",
          "soak-scene",
          "g6s-cache-budget-respected-soak-scene",
        ),
      ],
    },
    browser: (short) =>
      short === "web"
        ? {
            status: "receiver-typed",
            reason: "cache-budget-unsupported",
            owner:
              "gate7-design.md D16: the browser HTTP cache cannot evict; D16 measures the profile's disk use instead",
            refs: [
              ["g7-k", "soak-scene", "g6s-cache-budget-respected-soak-scene"],
            ],
            notes:
              "receiver.gd types a disk budget on the web (applied.json `unsupported`, name `cache`); the memory budget is honoured.",
          }
        : {
            status: "declared-unverified",
            reason: "cache-budget-unsupported",
            notes:
              "GSW has no disk cache (memory + the browser HTTP cache). Its file mode types a disk budget cache-budget-unsupported (web/gsw-receiver/main.ts), but no gsw leg sets one, so the refusal is declared, not observed.",
          },
  },
  {
    id: "material.shader-outside-transpile-subset",
    kind: "material",
    name: "a ShaderMaterial the wire carries but GSW's transpiler does not cover",
    native: {
      status: "declared-unverified",
      notes:
        "The engine compiles every shader the wire carries; no gate leg carries one outside GSW's subset (TIME is wire-typed unsupported-material).",
    },
    browser: (short) =>
      short === "web"
        ? {
            status: "declared-unverified",
            notes:
              "The web export compiles shaders in the engine, as native; no gate leg carries a shader outside GSW's subset.",
          }
        : {
            status: "declared-unverified",
            reason: "gsw-shader-transpile",
            notes:
              "G7s: vertex(), varyings, screen/SDF built-ins, global and matrix uniforms, TEXTURE_PIXEL_SIZE, uvec/bvec and non-literal defaults are typed gsw-shader-transpile (programs.ts). Every gate 5.5 shader the wire does not refuse transpiles (shader-transpile-set@gsw), so no leg observes the refusal.",
          },
  },
  {
    id: "material.shader-transpile-subset",
    kind: "material",
    name: "ShaderMaterial fragment code inside GSW's transpile subset",
    native: {
      status: "supported",
      exactness: "exact",
      evidence: [
        nativeRef(
          "gate5.5",
          "gate55-shader",
          "receiver",
          "shader-expected-image-reference",
        ),
      ],
    },
    browser: (short) => ({
      status: "supported",
      refs: [
        ["g7-55", "shader/receiver", "shader-receiver-vs-reference"],
        ...(short === "gsw"
          ? ([
              ["g7-55", "shader/receiver", "shader-transpile-set"],
            ] as BrowserRef[])
          : []),
      ],
    }),
  },
];

function g7Entry(kind: ReceiverKind, spec: G7Spec): FeatureEntry2 {
  const base: FeatureEntry2 = {
    id: spec.id,
    kind: spec.kind,
    name: spec.name,
    status: "unobserved",
    reason: null,
    exactness: null,
    tolerance: null,
    evidence: [],
    owner: null,
    notes: null,
  };
  if (kind === "native") return { ...base, ...spec.native };
  const short = SHORT_KIND[kind] as "web" | "gsw";
  const { refs, ...rest } = spec.browser(short);
  const evidence = (refs ?? []).map(([g, leg, check]) =>
    browserRef(kind, "gate6-scene", [
      g,
      leg,
      check.replace("@SHORT", `@${short}`),
    ]),
  );
  // g7-lc's check ids carry their own `@<kind>:<leg>` suffix.
  for (const ev of evidence)
    if (ev.gate === "g7-lc")
      ev.check = ev.check.replace(new RegExp(`@${short}$`), "");
  const entry: FeatureEntry2 = { ...base, ...rest, evidence };
  if (entry.status === "supported" && entry.exactness === null) {
    const ex = browserExactness(
      kind,
      {
        ...FEATURE_ENTRIES[0],
        exactness: spec.kind === "delivery" ? null : "exact",
      },
      evidence,
    );
    entry.exactness = ex.exactness;
    entry.tolerance = ex.tolerance;
  }
  return entry;
}

/** One receiver kind's entries, unsorted (make-features.ts sorts). */
export function receiverFeatureEntries(kind: ReceiverKind): FeatureEntry2[] {
  const out: FeatureEntry2[] = [];
  for (const base of FEATURE_ENTRIES) {
    let e = kind === "native" ? nativeEntry(base) : browserEntry(kind, base);
    const o = OVERRIDES[base.id];
    if (o) e = o(kind, e);
    out.push(e);
  }
  for (const spec of G7_SPECS) out.push(g7Entry(kind, spec));
  return out;
}

/** Q11's per-status shape rules for /2 (pure). */
export function validateEntries2(entries: readonly FeatureEntry2[]): string[] {
  const problems: string[] = [];
  const tol = new Set(toleranceIds());
  for (const e of entries) {
    const key = `${e.kind}:${e.id}`;
    if (e.status === "supported" && e.evidence.length === 0)
      problems.push(`${key}: supported needs evidence`);
    if (e.status === "receiver-typed" && (!e.reason || !e.owner))
      problems.push(`${key}: receiver-typed needs reason and owner`);
    if (
      e.status === "receiver-typed" &&
      e.reason &&
      !RECEIVER_TYPED_REASONS.includes(e.reason)
    )
      problems.push(
        `${key}: receiver-typed reason ${e.reason} is not a receiver's own reason`,
      );
    if (e.status === "typed-unsupported" && (!e.reason || !e.owner))
      problems.push(`${key}: typed-unsupported needs reason and owner`);
    if (e.status === "unobserved" && (!e.owner || !e.notes))
      problems.push(`${key}: unobserved needs owner and notes`);
    if (e.status === "declared-unverified" && !e.notes)
      problems.push(`${key}: declared-unverified needs notes`);
    if (e.exactness === "band" && (!e.tolerance || !tol.has(e.tolerance)))
      problems.push(
        `${key}: band needs a tolerance id in fixtures/gsw-tolerance.json`,
      );
  }
  return problems;
}
