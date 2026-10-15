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

import { decodePngRgba } from "./gate-minus1-checks";
import { loadRecording, RECORDING_NAME } from "./gate0-checks";
import type { Gate3xExpected } from "./gate3x-expected";
import type { Gate7Check, SourceProvenance } from "./gate7-adapters";
import { buildQ7View, stepsOf } from "./gate7-q7";
import type { WebLegSpec } from "./gate7-web-legs";

export type GswGate = "gate0" | "gate1" | "gate2" | "gate3";
export const GSW_GROUP_OF: Record<GswGate, string> = {
  gate0: "g7-0",
  gate1: "g7-1",
  gate2: "g7-2",
  gate3: "g7-3",
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
};

/** Each gate's checks that judge receiver legs (kept `@gsw`), and those not applicable. */
export const GSW_RECEIVER_CHECKS: Record<
  GswGate,
  { judged: string[]; notApplicable: Record<string, string> }
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

/** Which gsw legs are judged under Q7 masks, against which reference (gsw-tolerance.json key). */
export function q7Plan(
  gate: GswGate,
  leg: string,
): { key: string; reference: string; live: boolean } | null {
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
    const plan = q7Plan(gate, d.leg);
    if (!plan) continue;
    const viewDir = join(input.gswRoot, "..", "gsw-q7", d.leg);
    const steps = await stepsOf(
      join(input.sourceDir, d.leg),
      plan.live
        ? join(input.sourceDir, "live", "receiver", "applied.json")
        : undefined,
    );
    q7[d.leg] = await buildQ7View(
      {
        gswDir: join(input.gswRoot, d.leg),
        viewDir,
        key: plan.key,
        steps,
        referenceDir: join(input.sourceDir, plan.reference, "shots"),
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
  const byId = new Map(report.checks.map((c) => [c.id, c]));
  const checks: Gate7Check[] = [];
  const spec = GSW_RECEIVER_CHECKS[gate];
  for (const id of spec.judged) {
    const c = byId.get(id);
    checks.push(
      c
        ? {
            id: `${id}@gsw`,
            criterion: c.criterion,
            passed: c.passed,
            gating: true,
            detail: c.detail,
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
    const result = await readJson<{ gate_passed?: boolean }>(
      join(input.sourceDir, "result.json"),
    );
    if (!result) problems.push("source result.json missing");
    else if (result.gate_passed !== true)
      problems.push("source gate_passed is not true");
    const src = await readJson<SourceProvenance>(
      join(input.sourceDir, "gate7-source.json"),
    );
    if (!src) problems.push("source gate7-source.json missing");
    else
      for (const key of [
        "git_commit",
        "git_dirty_digest",
        "extension_sha256",
        "template_sha256",
      ] as const)
        if (src[key] !== input.current[key])
          problems.push(`${key} ${src[key]} != current ${input.current[key]}`);
    checks.push(
      mk(
        "source-run-valid@gsw",
        `D21: the source ${gate} run passed and was made on this build`,
        problems,
        "source run valid, same build",
      ),
    );
  }

  const specs = gswLegSpecs(gate, input.sourceDir, input.gswRoot);
  const prov: string[] = [];
  const consoleBad: string[] = [];
  const missing: string[] = [];
  for (const s of specs) {
    const p = await readJson<{ ok?: boolean; reasons?: string[] }>(
      join(s.webDir, "provenance.json"),
    );
    if (!p?.ok)
      prov.push(`${s.leg}: ${p?.reasons?.join(", ") ?? "no provenance.json"}`);
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
      "Q6/D9: every gsw leg's browser names ANGLE, NVIDIA and Vulkan, holds no Wayland fd, had DISPLAY/WAYLAND_DISPLAY unset and is the recorded chromium-1223 binary",
      prov,
      `${specs.length} legs on the pinned hardware Chromium`,
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
    const e =
      report.legs[d.leg] ?? report.legs[d.leg.replace(/\/receiver$/, "")];
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
