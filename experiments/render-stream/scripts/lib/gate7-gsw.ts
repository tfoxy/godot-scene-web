// Gate 7's GSW canvas receiver legs and adapters for gates 0 to 3 (gate7-design.md Q8, Q7, G7a).
//
// A gsw leg is derived from a native file-mode receiver leg of a source run (D21), exactly as a web
// leg is (lib/gate7-web-legs.ts mapNativeLeg, `kind: "gsw"`), and written to
// `<out>/<gate>/gsw/<leg>`. Each gate's own checker judges them WITHOUT a fork: the adapter builds
// a VIEW of the source run (`<out>/<gate>/gsw-view/`, every entry a symlink to the source except
// each replaced receiver leg, which links to its gsw leg), runs the gate's `runGate<N>` on it,
// and keeps that gate's receiver checks, suffixed `@gsw`. Checks that judge the source run
// (capture, reference, host sabotages' captures) are not repeated (D11, D21).
//
// Not applicable to a browser (reported, never gating): legs a native receiver runs `--headless`
// only to trace file opens (`receiver-headless-trace`) or typecheck GDScript
// (`receiver-typecheck`), and the cache-directory checks (`fresh-cache`, `warm-cache`, the
// `ignore-cache` sabotage): the GSW receiver has no cache directory, the browser's HTTP cache
// stands in for it as it does for the web export (Q4).
//
// Gate 7's own checks are added per group (Q8): browser-provenance, source-run-valid,
// no-source-scene, console-clean, evidence-complete, and the group's G7a checks (G7a "Checks").

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ciRendererAllowance,
  type LegProvenance,
  legProvenanceProblems,
  provenanceCriterion,
  provenancePassDetail,
} from "./browser-renderer";
import { decodePngRgba } from "./gate-minus1-checks";
import { loadRecording, RECORDING_NAME } from "./gate0-checks";
import type { Gate3xExpected } from "./gate3x-expected";
import {
  type Gate7Check,
  type SourceProvenance,
  sourceProvenanceProblems,
} from "./gate7-adapters";
import {
  GATE55_LEGS,
  GATE55_NOT_APPLICABLE,
  GATE55_RECEIVER_CHECKS,
  gate55LegKey,
  gate55Q7Plan,
} from "./gate7-gsw-55";
import {
  GATE6_LEGS,
  GATE6_NOT_APPLICABLE,
  GATE6_RECEIVER_CHECKS,
  gate6Q7Plan,
} from "./gate7-gsw-g6";
import {
  earlySteps,
  G45_LEGS,
  G45_NOT_APPLICABLE,
  G45_RECEIVER_CHECKS,
  type G45Gate,
  g45Q7Plan,
  type TypedCheck,
} from "./gate7-gsw-g45";
import { buildQ7View, stepsOf } from "./gate7-q7";
import type { WebLegSpec } from "./gate7-web-legs";

/** R3: the CI-only software-renderer allowance this checker runs under (null: the NVIDIA default). */
const ciAllowance = ciRendererAllowance();

export type GswGate =
  | "gate0"
  | "gate1"
  | "gate2"
  | "gate3"
  | "gate55"
  | "gate6"
  | G45Gate;
export const GSW_GROUP_OF: Record<GswGate, string> = {
  gate0: "g7-0",
  gate1: "g7-1",
  gate2: "g7-2",
  gate3: "g7-3",
  gate55: "g7-55",
  gate4: "g7-4",
  gate5: "g7-5",
  gate6: "g7-6",
};

/** One gsw leg: a native receiver leg replayed, or a GSW-only sabotage derived from one. */
export interface GswLegDef {
  /** The leg's id: the native leg's own path, or a GSW-only leg's name. */
  leg: string;
  /** The native leg it is derived from (default: `leg`). */
  from?: string;
  /** Extra or overriding RS_RECEIVER_* values (a GSW-only sabotage). */
  env?: Record<string, string>;
  /** Q7's shell sabotage. */
  shell?: "css-opacity";
  compositor?: boolean;
  /** true: the leg replaces the native leg in the gate checker's view. */
  replaces: boolean;
}

/** Native receiver legs a gsw leg does not run, with the reason (reported, never gating). */
export interface NotApplicable {
  leg: string;
  reason: string;
}

const PERF = { RS_RECEIVER_PERF_OUT: "@leg/perf.json" };

const TRACE_NA: NotApplicable = {
  leg: "receiver-headless-trace",
  reason:
    "a native --headless leg that exists to strace the receiver's file opens; a browser always renders and opens nothing (D11); no-source-scene@gsw replaces receiver-never-loaded-fixture",
};
const TYPECHECK_NA: NotApplicable = {
  leg: "receiver-typecheck",
  reason: "GDScript typecheck of the native receiver: not a GSW concern",
};

export const GSW_LEGS: Record<GswGate, GswLegDef[]> = {
  gate0: [
    { leg: "receiver", replaces: true, compositor: true },
    { leg: "preexisting-skip/receiver", replaces: true },
    { leg: "sabotage-freeze/receiver", replaces: true },
    { leg: "sabotage-omit/receiver", replaces: true },
    { leg: "sabotage-perturb/receiver", replaces: true },
    { leg: "unsupported/receiver", replaces: true },
    { leg: "corrupt", replaces: true },
    {
      leg: "sabotage-css-opacity",
      from: "receiver",
      shell: "css-opacity",
      compositor: true,
      replaces: false,
    },
  ],
  gate1: [
    { leg: "receiver", replaces: true, compositor: true },
    { leg: "sabotage-omit-modulate/receiver", replaces: true },
    { leg: "sabotage-omit-transform/receiver", replaces: true },
    { leg: "sabotage-omit-order/receiver", replaces: true },
    { leg: "sabotage-omit-visibility/receiver", replaces: true },
    { leg: "root-size-observe/receiver", replaces: true },
    { leg: "receiver-patch", replaces: true },
    { leg: "sabotage-omit-free/receiver", replaces: true },
    { leg: "sabotage-omit-visible/receiver", replaces: true },
    { leg: "sabotage-patch-drop/receiver", replaces: true },
    { leg: "tie-overlap/receiver", replaces: true },
    { leg: "live-replay", replaces: true },
    {
      leg: "sabotage-gsw-ignore-z",
      from: "receiver",
      env: { RS_RECEIVER_SABOTAGE: "ignore-z" },
      replaces: false,
    },
  ],
  gate2: [
    { leg: "receiver-cold", replaces: true, compositor: true },
    { leg: "receiver-warm", replaces: true },
    { leg: "receiver-patch", replaces: true },
    { leg: "receiver-inline", replaces: true },
    { leg: "unsupported-textures/receiver", replaces: true },
    { leg: "sabotage-omit-update/receiver", replaces: true },
    { leg: "sabotage-omit-replace/receiver", replaces: true },
    { leg: "sabotage-wrong-hash/receiver", replaces: true },
    { leg: "sabotage-stale-texture/receiver", replaces: true },
    { leg: "sabotage-spurious-update/receiver", replaces: true },
    { leg: "sabotage-receiver-reupload/receiver", replaces: true },
    { leg: "live-replay", replaces: true },
    { leg: "canvas-headless/receiver", replaces: true },
    { leg: "canvas-host/receiver", replaces: true },
    { leg: "canvas-normal/receiver", replaces: true },
    { leg: "sabotage-omit-canvas-filter/receiver", replaces: true },
    {
      leg: "sabotage-gsw-premultiplied-upload",
      from: "receiver-cold",
      env: { RS_RECEIVER_SABOTAGE: "premultiplied-upload" },
      replaces: false,
    },
  ],
  gate3: [
    { leg: "receiver", replaces: true, compositor: true },
    { leg: "receiver-patch", replaces: true },
    { leg: "sabotage-receiver-ignore-clip", replaces: true },
    { leg: "sabotage-receiver-clip-before-clear", replaces: true },
    { leg: "sabotage-freeze/receiver", replaces: true },
    { leg: "sabotage-perturb/receiver", replaces: true },
    { leg: "sabotage-omit-clip/receiver", replaces: true },
    { leg: "sabotage-omit-custom-rect/receiver", replaces: true },
    { leg: "root-size-observe/receiver", replaces: true },
    { leg: "receiver-xform", replaces: true },
    { leg: "receiver-xform-patch", replaces: true },
    { leg: "sabotage-xform-perturb/receiver", replaces: true },
    { leg: "sabotage-xform-receiver-ignore-clip", replaces: true },
    { leg: "receiver-clip-ignore", replaces: true },
  ],
  gate55: GATE55_LEGS,
  // G7t: gates 4 and 5 (lib/gate7-gsw-g45.ts).
  ...G45_LEGS,
  // G7g: gate 6 (lib/gate7-gsw-g6.ts).
  gate6: GATE6_LEGS,
};

export const GSW_NOT_APPLICABLE: Record<GswGate, NotApplicable[]> = {
  gate0: [TRACE_NA, TYPECHECK_NA],
  gate1: [TRACE_NA, TYPECHECK_NA],
  gate2: [
    TRACE_NA,
    {
      leg: "sabotage-receiver-ignore-cache/receiver",
      reason:
        "the sabotage skips cache-directory reads; the GSW receiver has no cache directory (the browser's HTTP cache stands in, Q4), so it has nothing to skip",
    },
  ],
  gate3: [TRACE_NA],
  gate55: GATE55_NOT_APPLICABLE,
  ...G45_NOT_APPLICABLE,
  gate6: GATE6_NOT_APPLICABLE,
};

/** Each gate's checks that judge receiver legs (kept `@gsw`), and those not applicable. */
export const GSW_RECEIVER_CHECKS: Record<
  GswGate,
  {
    judged: string[];
    notApplicable: Record<string, string>;
    /** G7t: checks the gate's checker fails only because GSW types an op (Q7's last row). */
    typed?: Record<string, TypedCheck>;
  }
> = {
  gate0: {
    judged: [
      "expected-image-receiver",
      "receiver-vs-reference",
      "receiver-consumed-stream",
      "preexisting-skip-receiver",
      "preexisting-skip-excluded-region",
      "leg-class-receiver",
      "leg-class-sabotage-freeze",
      "leg-class-sabotage-omit",
      "leg-class-sabotage-perturb",
      "leg-class-unsupported",
      "leg-class-preexisting-skip",
      "leg-class-corrupt",
    ],
    notApplicable: {
      "receiver-never-loaded-fixture":
        "strace of a --headless native leg; replaced by no-source-scene@gsw (Q8)",
      "receiver-typed-clean": "GDScript typecheck legs (native only)",
    },
  },
  gate1: {
    judged: [
      "expected-image-receiver",
      "receiver-vs-reference",
      "receiver-consumed-stream",
      "leg-class-receiver",
      "leg-class-sabotage-omit-modulate",
      "leg-class-sabotage-omit-transform",
      "leg-class-sabotage-omit-order",
      "leg-class-sabotage-omit-visibility",
      "leg-class-root-size-observe",
      "patch-vs-full-pixels",
      "patch-vs-full-receiver-state",
      "tie-frame-pixels",
      "leg-class-receiver-patch",
      "leg-class-sabotage-omit-free",
      "leg-class-sabotage-omit-visible",
      "leg-class-sabotage-patch-drop",
      "leg-class-tie-overlap",
      "live-replay-equals-live",
      "leg-class-live-replay",
    ],
    notApplicable: {
      "receiver-never-loaded-fixture":
        "strace of a --headless native leg; replaced by no-source-scene@gsw (Q8)",
      "receiver-typed-clean": "GDScript typecheck legs (native only)",
    },
  },
  gate2: {
    judged: [
      "expected-image-receiver",
      "receiver-vs-reference",
      "receiver-consumed-stream",
      "upload-accounting",
      "transform-only-no-resource-traffic",
      "freed-draws-default",
      "copy-at-hook",
      "unsupported-regions",
      "canvas-texture-headless-refused",
      "canvas-normal-region",
      "live-replay-equals-live",
      "leg-class-receiver-cold",
      "leg-class-receiver-warm",
      "leg-class-receiver-patch",
      "leg-class-receiver-inline",
      "leg-class-unsupported-textures",
      "leg-class-sabotage-omit-update",
      "leg-class-sabotage-omit-replace",
      "leg-class-sabotage-wrong-hash",
      "leg-class-sabotage-stale-texture",
      "leg-class-sabotage-spurious-update",
      "leg-class-sabotage-receiver-reupload",
      "leg-class-live-replay",
      "leg-class-canvas-headless",
      "leg-class-canvas-host",
      "leg-class-canvas-normal",
      "leg-class-sabotage-omit-canvas-filter",
    ],
    notApplicable: {
      "warm-cache":
        "compares the native cache directory's cold and warm use; the GSW receiver has no cache directory (the browser's HTTP cache stands in, Q4)",
      "fresh-cache":
        "counts the native cache directory's files; the GSW receiver has no cache directory",
      "leg-class-sabotage-receiver-ignore-cache":
        "the sabotage skips cache-directory reads, which the GSW receiver does not have",
      "receiver-never-loaded-fixture":
        "strace of a --headless native leg; replaced by no-source-scene@gsw (Q8)",
      "receiver-typed-clean": "GDScript script-error markers in native logs",
    },
  },
  gate3: {
    judged: [
      "expected-image-receiver",
      "receiver-vs-reference",
      "probes-receiver",
      "receiver-consumed-stream",
      "clip-rects-derived",
      "leg-class-receiver",
      "leg-class-receiver-patch",
      "leg-class-sabotage-freeze",
      "leg-class-sabotage-perturb",
      "leg-class-sabotage-omit-clip",
      "leg-class-sabotage-omit-custom-rect",
      "leg-class-sabotage-receiver-ignore-clip",
      "leg-class-sabotage-receiver-clip-before-clear",
      "leg-class-root-size-observe",
      "expected-image-receiver-xform",
      "receiver-vs-reference-xform",
      "probes-receiver-xform",
      "leg-class-receiver-xform",
      "leg-class-receiver-xform-patch",
      "leg-class-sabotage-xform-perturb",
      "leg-class-sabotage-xform-receiver-ignore-clip",
      "leg-class-receiver-clip-ignore",
    ],
    notApplicable: {
      "receiver-never-loaded-fixture":
        "strace of a --headless native leg; replaced by no-source-scene@gsw (Q8)",
      "receiver-typed-clean": "GDScript script-error markers in native logs",
    },
  },
  gate55: GATE55_RECEIVER_CHECKS,
  ...G45_RECEIVER_CHECKS,
  gate6: GATE6_RECEIVER_CHECKS,
};

/** The leg specs of a gate for runWebLegs (`kind: "gsw"`). */
export function gswLegSpecs(
  gate: GswGate,
  sourceDir: string,
  gswRoot: string,
): WebLegSpec[] {
  return GSW_LEGS[gate].map((d) => ({
    leg: d.leg,
    nativeDir: join(sourceDir, d.from ?? d.leg),
    webDir: join(gswRoot, d.leg),
    compositor: d.compositor,
    sabotage: d.shell,
    extraEnv: { ...PERF, ...(d.env ?? {}) },
  }));
}

/** A view of `sourceDir` in `viewDir`: every entry linked, the replaced legs linked to theirs. */
export async function buildView(
  sourceDir: string,
  replaced: ReadonlyMap<string, string>,
  viewDir: string,
): Promise<void> {
  await mkdir(viewDir, { recursive: true });
  const walk = async (rel: string): Promise<void> => {
    const src = rel === "" ? sourceDir : join(sourceDir, rel);
    const dst = rel === "" ? viewDir : join(viewDir, rel);
    for (const entry of readdirSync(src)) {
      if (rel === "" && entry === "result.json") continue;
      const r = rel === "" ? entry : `${rel}/${entry}`;
      const target = replaced.get(r);
      const at = join(dst, entry);
      if (existsSync(at) || lstatExists(at)) continue;
      if (target !== undefined) {
        symlinkSync(target, at);
        continue;
      }
      const inside = [...replaced.keys()].some((k) => k.startsWith(`${r}/`));
      if (inside && statSync(join(src, entry)).isDirectory()) {
        await mkdir(at, { recursive: true });
        await walk(r);
      } else {
        symlinkSync(join(src, entry), at);
      }
    }
  };
  await walk("");
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function filesUnder(root: string, prefix = ""): string[] {
  if (!existsSync(join(root, prefix))) return [];
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** tier-verdict.py's verdict on a source run (run-gate7.sh writes it as remote-skip-verdict.json). */
export interface RemoteSkipVerdict {
  verdict?: string;
  skipped_by_tier?: string[];
  skipped_remote_groups?: string[];
}

/** R3: which of a source run's failing check ids its remote timing-group skip excuses. Only under
 * RS_SKIP_TIMING_GROUPS (a remote run), only when tier-verdict.py passed the source with at least
 * one group skipped remotely, and only the ids it excused by those skipped legs: anything else
 * stays failing. Empty locally, so the local source-run-valid is unchanged. */
export function remoteSkipExcused(
  failing: readonly string[],
  verdict: RemoteSkipVerdict | null | undefined,
  skipEnv: string | undefined,
): Set<string> {
  if (!skipEnv || verdict?.verdict !== "pass") return new Set();
  if ((verdict.skipped_remote_groups ?? []).length === 0) return new Set();
  const excused = new Set(verdict.skipped_by_tier ?? []);
  return new Set(failing.filter((id) => excused.has(id)));
}

export function mk(
  id: string,
  criterion: string,
  problems: string[],
  ok: string,
  gating = true,
): Gate7Check {
  return {
    id,
    criterion,
    passed: problems.length === 0,
    gating,
    detail: problems.length === 0 ? ok : problems.slice(0, 12).join("; "),
  };
}

/** Native-only files a gsw leg does not reproduce (the cache directory, diff images, strace). */
function nativeOnly(rel: string): boolean {
  return (
    rel.startsWith("cache/") ||
    rel.startsWith("warm-cache/") ||
    rel.startsWith("diff/") ||
    rel === "display-ownership.json" ||
    rel.startsWith("strace") ||
    rel === "shot-seqs.txt" ||
    rel === "step-join.log" ||
    rel === "corrupt-tool.log"
  );
}

/** Which gsw legs are judged under Q7 masks, against which reference (gsw-tolerance.json key);
 * `refs` names a shot's reference file when it is not `step-<k>.png` (G7t: gate 4's early shots). */
export function q7Plan(
  gate: GswGate,
  leg: string,
  sourceDir = "",
): {
  key: string;
  reference: string;
  live: boolean;
  refs?: Map<number, string>;
  /** G7g: shot seq -> the tolerance doc's step (gate 6: the model shot's index). */
  steps?: Map<number, number>;
  pair?: string;
  /** G7g: leave undecided pixels as drawn (gate 6's presentation hazard). */
  keepUndecided?: boolean;
} | null {
  if (gate === "gate6") {
    const plan = gate6Q7Plan(
      leg,
      sourceDir,
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures"),
    );
    return plan ? { ...plan, live: false } : null;
  }
  if (gate === "gate4" || gate === "gate5") {
    const plan = g45Q7Plan(gate, leg, sourceDir);
    return plan ? { ...plan, live: false } : null;
  }
  if (gate === "gate2")
    return {
      key: "gate2",
      reference:
        leg === "unsupported-textures/receiver"
          ? "reference-unsupported"
          : "reference",
      live: leg === "live-replay",
    };
  if (gate === "gate3" && /xform/.test(leg))
    return { key: "gate3-xform", reference: "reference-xform", live: false };
  if (gate === "gate55") return gate55Q7Plan(leg);
  return null;
}

export interface GswGroupInput {
  gate: GswGate;
  sourceDir: string;
  gswRoot: string;
  viewDir: string;
  bundleDir: string;
  current: SourceProvenance;
  /** Runs the gate's own checker on a run directory. */
  runChecker: (dir: string) => Promise<{
    checks: {
      id: string;
      criterion: string;
      passed: boolean;
      detail: string;
      status?: string;
    }[];
    legs: Record<
      string,
      { result_class?: string | null; expected_class?: string | null }
    >;
    gate_passed?: boolean;
  }>;
  /** The group's own G7a checks (ordering-model, clip-parity, ...), run after the view. */
  extra?: () => Promise<Gate7Check[]>;
}

export interface GswGroupResult {
  group: string;
  kind: "gsw";
  passed: boolean;
  checks: Gate7Check[];
  not_applicable: { id: string; reason: string }[];
  legs: Record<
    string,
    { result_class: string | null; expected_class: string | null }
  >;
}

/** The report check a gsw `judged` id stands for (R3). A gate's checker can report one id twice:
 * gate 5 pushes g5d's file-leg `receiver-vs-reference` (receiver, receiver-patch) and then folds in
 * g5f's live `receiver-vs-reference` (live-mesh, live-mesh-warm, live-mesh-stall). The judged lists
 * mean the gate's own (first) check: the later one is a sub-gate's check of legs the gsw group does
 * not run (G45_NOT_APPLICABLE: g5f is G7l's, judged by the g7-5 live group), whose evidence in the
 * view is the native source's. A last-wins map used to judge g5f's check in its place, so gsw's
 * file-leg comparison was never reported, and a remote run (g5f skipped, RS_SKIP_TIMING_GROUPS)
 * had to excuse the whole check. */
export function judgedCheck<C extends { id: string }>(
  checks: readonly C[],
  id: string,
): { check: C | undefined; shadowed: number } {
  const same = checks.filter((c) => c.id === id);
  return { check: same[0], shadowed: Math.max(0, same.length - 1) };
}

/** Gate 7's checks for one gate's gsw legs (Q8). */
export async function checkGswGroup(
  input: GswGroupInput,
): Promise<GswGroupResult> {
  const { gate } = input;
  const defs = GSW_LEGS[gate];
  const replaced = new Map<string, string>(
    defs
      .filter((d) => d.replaces)
      .map((d) => [d.leg, join(input.gswRoot, d.leg)]),
  );
  // Q7 (gate7-lib gate7-q7.ts): legs whose gate has delta1/undecided masks are judged through
  // a Q7 view of their shots.
  const q7: Record<string, unknown> = {};
  for (const d of defs.filter((x) => x.replaces)) {
    const plan = q7Plan(gate, d.leg, input.sourceDir);
    if (!plan) continue;
    const viewDir = join(input.gswRoot, "..", "gsw-q7", d.leg);
    const steps =
      plan.steps ??
      (await stepsOf(
        join(input.sourceDir, d.leg),
        plan.live
          ? join(input.sourceDir, "live", "receiver", "applied.json")
          : undefined,
      ));
    if (plan.refs && !plan.steps)
      for (const [seq, k] of earlySteps(plan.refs)) steps.set(seq, k);
    q7[d.leg] = await buildQ7View(
      {
        gswDir: join(input.gswRoot, d.leg),
        viewDir,
        key: plan.key,
        steps,
        referenceDir: join(input.sourceDir, plan.reference, "shots"),
        refs: plan.refs,
        keepUndecided: plan.keepUndecided,
        pair: plan.pair
          ? {
              gswDir: join(input.gswRoot, plan.pair),
              viewDir: join(input.gswRoot, "..", "gsw-q7", plan.pair),
            }
          : undefined,
      },
      plan.key === "gate3-xform"
        ? (JSON.parse(
            readFileSync(
              join(
                dirname(fileURLToPath(import.meta.url)),
                "..",
                "..",
                "fixtures",
                "gate3-xform",
                "expected.json",
              ),
              "utf8",
            ),
          ) as Gate3xExpected)
        : undefined,
    );
    replaced.set(d.leg, viewDir);
  }
  await buildView(input.sourceDir, replaced, input.viewDir);
  await writeFile(
    join(input.viewDir, "..", "gsw-q7.json"),
    `${JSON.stringify(q7, null, 2)}\n`,
  );
  const report = await input.runChecker(input.viewDir);
  await writeFile(
    join(input.viewDir, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const checks: Gate7Check[] = [];
  const spec = GSW_RECEIVER_CHECKS[gate];
  for (const id of spec.judged) {
    const { check: c, shadowed } = judgedCheck(report.checks, id);
    checks.push(
      c
        ? {
            id: `${id}@gsw`,
            criterion: c.criterion,
            passed: c.passed,
            gating: true,
            detail:
              shadowed > 0
                ? `${c.detail} (the gate's own ${id}; ${shadowed} later same-id sub-gate check${shadowed > 1 ? "s" : ""} not judged here)`
                : c.detail,
          }
        : {
            id: `${id}@gsw`,
            criterion: `gate ${gate.slice(4)}'s own check`,
            passed: false,
            gating: true,
            detail: "the gate's checker did not report it",
          },
    );
  }
  // G7t: checks failed only by a typed refusal (gate 4e's MSDF legs): the gate's checker must
  // class each leg `unsupported`, and its applied.json must type exactly the expected reasons.
  for (const [id, t] of Object.entries(spec.typed ?? {})) {
    const problems: string[] = [];
    for (const [i, leg] of t.legs.entries()) {
      const cls = report.legs[leg]?.result_class ?? null;
      if (cls !== "unsupported")
        problems.push(`${leg}: class ${cls}, expected unsupported`);
      const applied = await readJson<{
        unsupported?: { item?: number | null; reason?: string }[];
      }>(join(input.gswRoot, t.dirs[i], "applied.json"));
      const typed = [
        ...new Set(
          (applied?.unsupported ?? [])
            .filter((u) => u.item === null && u.reason?.startsWith("gsw-"))
            .map((u) => u.reason as string),
        ),
      ].sort();
      const others = (applied?.unsupported ?? []).filter(
        (u) => !(u.item === null && u.reason?.startsWith("gsw-")),
      );
      if (JSON.stringify(typed) !== JSON.stringify([...t.reasons].sort()))
        problems.push(
          `${t.dirs[i]}: receiver-typed {${typed.join(", ")}}, expected {${t.reasons.join(", ")}}`,
        );
      if (others.length > 0)
        problems.push(
          `${t.dirs[i]}: ${others.length} other unsupported entries (${others[0].reason})`,
        );
    }
    checks.push({
      id: `${id}@gsw`,
      criterion: `Q7/Q8: the gate's leg-class check, typed: ${t.legs.join(", ")} class unsupported with exactly the receiver-typed reasons {${t.reasons.join(", ")}}`,
      passed: problems.length === 0,
      gating: true,
      detail:
        problems.length === 0
          ? `unsupported, typed exactly {${t.reasons.join(", ")}}`
          : problems.join("; "),
    });
  }
  const notApplicable = [
    ...Object.entries(spec.notApplicable).map(([id, reason]) => ({
      id: `${id}@gsw`,
      reason,
    })),
    ...GSW_NOT_APPLICABLE[gate].map((n) => ({
      id: `leg:${n.leg}@gsw`,
      reason: n.reason,
    })),
  ];

  // D21 source-run-valid: the source passed and was made on this build.
  {
    const problems: string[] = [];
    const result = await readJson<{
      gate_passed?: boolean;
      checks?: { id: string; passed?: boolean; status?: string }[];
    }>(join(input.sourceDir, "result.json"));
    // G7s: a source made with only some leg groups (G7b's file-leg sources, gate 5.5 without its
    // live g55f) is valid when every check of the groups it ran passed: only `not-run` group
    // checks may fail.
    let failing = (result?.checks ?? []).filter(
      (c) => c.passed !== true && c.status !== "not-run",
    );
    // R3: a remote source run skips its timing groups (RS_SKIP_TIMING_GROUPS, lib/legs.sh), so no
    // wall-clock check gates a gate 7 verdict on a shared VM. Only the checks tier-verdict.py
    // excuses by those skipped legs are dropped here (run-gate7.sh writes its verdict beside the
    // source); every other failing check still fails the source.
    let excusedTiming: string[] = [];
    if (result && failing.length > 0) {
      const ex = remoteSkipExcused(
        failing.map((c) => c.id),
        await readJson<RemoteSkipVerdict>(
          join(input.sourceDir, "remote-skip-verdict.json"),
        ),
        process.env.RS_SKIP_TIMING_GROUPS,
      );
      excusedTiming = failing.filter((c) => ex.has(c.id)).map((c) => c.id);
      failing = failing.filter((c) => !ex.has(c.id));
    }
    if (!result) problems.push("source result.json missing");
    else if (result.gate_passed !== true && failing.length > 0)
      problems.push(
        `source gate_passed is not true: ${failing
          .slice(0, 4)
          .map((c) => c.id)
          .join(", ")}`,
      );
    const src = await readJson<SourceProvenance>(
      join(input.sourceDir, "gate7-source.json"),
    );
    if (!src) problems.push("source gate7-source.json missing");
    else problems.push(...sourceProvenanceProblems(src, input.current));
    checks.push(
      mk(
        "source-run-valid@gsw",
        `D21: the source ${gate} run passed and was made on this build`,
        problems,
        excusedTiming.length > 0
          ? `source run valid, same build; ${excusedTiming.length} checks of its remote-skipped timing groups excused (RS_SKIP_TIMING_GROUPS=${process.env.RS_SKIP_TIMING_GROUPS})`
          : "source run valid, same build",
      ),
    );
  }

  const specs = gswLegSpecs(gate, input.sourceDir, input.gswRoot);
  const prov: string[] = [];
  const consoleBad: string[] = [];
  const missing: string[] = [];
  for (const s of specs) {
    const p = await readJson<LegProvenance>(join(s.webDir, "provenance.json"));
    const pp = legProvenanceProblems(p, ciAllowance);
    if (pp.length) prov.push(`${s.leg}: ${pp.join(", ")}`);
    let text = "";
    try {
      text = readFileSync(join(s.webDir, "console.jsonl"), "utf8");
    } catch {
      consoleBad.push(`${s.leg}: console.jsonl missing`);
    }
    for (const line of text.split("\n").filter(Boolean)) {
      const m = JSON.parse(line) as { type: string; text: string };
      if (m.type === "pageerror" || /SHADER ERROR|WebGL: /.test(m.text))
        consoleBad.push(`${s.leg}: ${m.type}: ${m.text.slice(0, 160)}`);
    }
    for (const f of filesUnder(s.nativeDir).filter((x) => !nativeOnly(x)))
      if (!existsSync(join(s.webDir, f))) missing.push(`${s.leg}/${f}`);
  }
  checks.push(
    mk(
      "browser-provenance@gsw",
      provenanceCriterion("gsw", ciAllowance),
      prov,
      provenancePassDetail(specs.length, ciAllowance),
    ),
  );
  checks.push(
    mk(
      "console-clean@gsw",
      "Q6: no gsw leg logged a SHADER ERROR, a `WebGL: ` error or an uncaught page error",
      consoleBad,
      `${specs.length} legs clean`,
    ),
  );
  checks.push(
    mk(
      "evidence-complete@gsw",
      "Q8: every file a native receiver leg writes (applied.json, shots, state dumps, logs, exit code) exists for its gsw leg by the same name (the cache directory, diff images and strace are native only)",
      missing,
      `${specs.length} legs complete`,
    ),
  );
  checks.push(await noSourceScene(input.bundleDir));

  const legs: GswGroupResult["legs"] = {};
  for (const d of defs.filter((x) => x.replaces)) {
    const key55 = gate === "gate55" ? gate55LegKey(d.leg) : undefined;
    const e =
      (key55 !== undefined ? report.legs[key55] : undefined) ??
      report.legs[d.leg] ??
      report.legs[d.leg.replace(/\/receiver$/, "")];
    legs[d.leg] = {
      result_class: e?.result_class ?? null,
      expected_class: e?.expected_class ?? null,
    };
  }
  if (input.extra) checks.push(...(await input.extra()));
  return {
    group: GSW_GROUP_OF[gate],
    kind: "gsw",
    passed: checks.every((c) => c.passed || !c.gating),
    checks,
    not_applicable: notApplicable,
    legs,
  };
}

/** Q8 `no-source-scene@gsw`: the bundle's esbuild metafile inputs hold nothing under fixtures/. */
export async function noSourceScene(bundleDir: string): Promise<Gate7Check> {
  const build = await readJson<{ inputs?: string[] }>(
    join(bundleDir, "build.json"),
  );
  const inputs = build?.inputs ?? [];
  const problems: string[] = [];
  if (inputs.length === 0) problems.push("build.json lists no esbuild inputs");
  for (const p of inputs)
    if (p.startsWith("fixtures/") || p.includes("/fixtures/"))
      problems.push(`${p} is under fixtures/`);
  return mk(
    "no-source-scene@gsw",
    "Q8: the GSW bundle's esbuild metafile inputs contain nothing under fixtures/ (the wasm module is built from rs-core, the canvas crates and web/gsw-rs only)",
    problems,
    `${inputs.length} bundle inputs, none under fixtures/`,
  );
}

/** Q7 compositor-equals-readback for a gsw leg: the CDP screenshot taken while the applied.json PUT
 * was held equals the leg's last shot, when that shot is of the last applied transaction's frame
 * and opaque. */
export async function compositorProblems(legDir: string): Promise<string[]> {
  const applied = await readJson<{
    shots?: { seq?: number }[];
    transactions?: { seq?: number }[];
  }>(join(legDir, "applied.json"));
  const screenshot = join(legDir, "compositor", "screenshot.png");
  if (!applied) return [`${legDir}: applied.json missing`];
  if (!existsSync(screenshot)) return [`${legDir}: no compositor screenshot`];
  const shots = applied.shots ?? [];
  const last = shots[shots.length - 1];
  const tx = applied.transactions ?? [];
  const lastSeq = tx[tx.length - 1]?.seq;
  if (!last?.seq || !lastSeq) return [`${legDir}: no shot or no transaction`];
  // The canvas shows the LAST applied transaction while the PUT is held: the comparison is of the
  // same frame only when that transaction's resolved state equals the last shot's (compared from
  // the recording itself, as gate7-adapters.ts does for the web export).
  const recording = await loadRecording(join(legDir, RECORDING_NAME));
  const stateOf = (seq: number): string | undefined => {
    const meta = recording.transactions[seq - 1]?.meta as unknown as
      | Record<string, unknown>
      | undefined;
    if (!meta) return undefined;
    const { seq: _s, frame: _f, encoding: _e, base_seq: _b, ...state } = meta;
    return JSON.stringify(state);
  };
  const shotState = stateOf(last.seq);
  if (shotState === undefined || shotState !== stateOf(lastSeq))
    return [
      `${legDir}: the last shot (seq ${last.seq}) is not of the state the canvas shows at exit (seq ${lastSeq})`,
    ];
  const shot = await decodePngRgba(
    join(legDir, "shots", `seq-${last.seq}.png`),
  );
  const comp = await decodePngRgba(screenshot);
  if (!shot || !comp) return [`${legDir}: unreadable shot or screenshot`];
  if (shot.width !== comp.width || shot.height !== comp.height)
    return [
      `${legDir}: screenshot ${comp.width}x${comp.height} vs shot ${shot.width}x${shot.height}`,
    ];
  for (let i = 3; i < shot.data.length; i += 4)
    if (shot.data[i] !== 255) return [`${legDir}: the last shot is not opaque`];
  let diff = 0;
  let max = 0;
  for (let i = 0; i < shot.data.length; i += 4) {
    let px = 0;
    for (let k = 0; k < 4; k++)
      px = Math.max(px, Math.abs(shot.data[i + k] - comp.data[i + k]));
    if (px > 0) diff++;
    max = Math.max(max, px);
  }
  return diff === 0
    ? []
    : [
        `${relative(process.cwd(), legDir)}: ${diff} px differ (max channel delta ${max})`,
      ];
}
