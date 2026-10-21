// Gate 7 adapters (gate7-design.md Q8, G7e): one per gate, mapping that gate's own checker onto a
// browser receiver's legs WITHOUT forking it. G7e lands the gate 0 adapter for the web export
// (`web`); G7a adds `gsw`, and G7b the gates 1 to 6.
//
// The gate 0 adapter builds a VIEW of the source run (`<out>/gate0/web-view/`): every entry of the
// source run is a symlink to the source, except each receiver leg directory, which links to the
// web leg directory instead. lib/gate0-checks.ts's runGate0() then judges the view exactly as it
// judges a native run, and only its receiver checks are kept, suffixed `@web` (the capture,
// reference and support checks belong to the source run, D11/D21). Gate 7's own checks are added
// beside them: browser-provenance, source-run-valid, no-source-scene, console-clean,
// evidence-complete, applied-equals-native, compositor-equals-readback and the css-opacity
// sabotage; P-W1's web-vs-native shot triangulation is reported, not gated (Q7 "W vs N: report
// only").

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { decodePngRgba } from "./gate-minus1-checks";
import {
  diffRgba,
  type Gate0Check,
  type Gate0Expected,
  LEG_EXPECTATIONS,
  loadRecording,
  RECORDING_NAME,
  runGate0,
} from "./gate0-checks";
import type { WebLegSpec } from "./gate7-web-legs";
import { type SourceKeyInputs, sourceKey } from "./source-key";

export interface Gate7Check {
  id: string;
  criterion: string;
  passed: boolean;
  /** false: reported, never part of gate_passed (Q7's "report only" rows). */
  gating: boolean;
  detail: string;
}

/** Gate 0's receiver legs, by their path in a gate 0 run (lib/gate0-checks.ts legLayout()). */
export const GATE0_RECEIVER_LEGS = [
  "receiver",
  "preexisting-skip/receiver",
  "sabotage-freeze/receiver",
  "sabotage-omit/receiver",
  "sabotage-perturb/receiver",
  "unsupported/receiver",
  "corrupt",
] as const;

/** Q7's sabotage: the honest `receiver` leg replayed with the shell's `opacity: 0.99`. */
export const CSS_OPACITY_LEG = "sabotage-css-opacity";
/** Q4's render-time probe leg (report only). */
export const PERF_PROBE_LEG = "probe-render-time";

/** runGate0()'s receiver checks, the ones a web leg answers (the rest judge the source run). */
export const GATE0_WEB_CHECK_IDS = [
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
] as const;

/** The web leg specs for a gate 0 source run, under `<webRoot>` (= `<out>/gate0/web`). */
export function gate0WebLegSpecs(
  sourceDir: string,
  webRoot: string,
): WebLegSpec[] {
  const specs: WebLegSpec[] = GATE0_RECEIVER_LEGS.map((leg) => ({
    leg,
    nativeDir: join(sourceDir, leg),
    webDir: join(webRoot, leg),
    compositor: leg === "receiver",
  }));
  specs.push({
    leg: CSS_OPACITY_LEG,
    nativeDir: join(sourceDir, "receiver"),
    webDir: join(webRoot, CSS_OPACITY_LEG),
    sabotage: "css-opacity",
    compositor: true,
  });
  // Q4's rs_perf probe: the honest receiver leg once more with RS_RECEIVER_PERF_OUT, to read
  // what viewport_get_measured_render_time_* report on WebGL 2 (report only).
  specs.push({
    leg: PERF_PROBE_LEG,
    nativeDir: join(sourceDir, "receiver"),
    webDir: join(webRoot, PERF_PROBE_LEG),
    extraEnv: { RS_RECEIVER_PERF_OUT: "@leg/perf.json" },
  });
  return specs;
}

/** Builds `viewDir`: the source run with every gate 0 receiver leg replaced by its web leg. */
export async function buildGate0View(
  sourceDir: string,
  webRoot: string,
  viewDir: string,
): Promise<void> {
  await mkdir(viewDir, { recursive: true });
  const replaced = new Map<string, string>(
    GATE0_RECEIVER_LEGS.map((leg) => [leg, join(webRoot, leg)]),
  );
  const link = (target: string, path: string) => {
    if (!existsSync(path)) symlinkSync(target, path);
  };
  for (const entry of readdirSync(sourceDir)) {
    if (entry === "result.json") continue;
    const src = join(sourceDir, entry);
    const legsInside = [...replaced.keys()].filter((leg) =>
      leg.startsWith(`${entry}/`),
    );
    if (replaced.has(entry)) {
      link(replaced.get(entry) as string, join(viewDir, entry));
    } else if (legsInside.length > 0 && statSync(src).isDirectory()) {
      await mkdir(join(viewDir, entry), { recursive: true });
      for (const child of readdirSync(src)) {
        const leg = `${entry}/${child}`;
        link(
          replaced.get(leg) ?? join(src, child),
          join(viewDir, entry, child),
        );
      }
    } else {
      link(src, join(viewDir, entry));
    }
  }
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function filesUnder(root: string, prefix = ""): string[] {
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

/** Keys whose values are timings, process-local frame counters, evidence locations or the
 * receiver's own identity: applied-equals-native ignores them (G7e: "every field except
 * timings and `receiver`"; paths and frame counters are where and when, not what). `cache` is
 * Q4's declared difference (native: a fresh directory; web: the browser's HTTP cache), and
 * `display_server` names the platform (x11 / web). */
const IGNORED_KEYS = new Set([
  "receiver",
  "cache",
  "display_server",
  "path",
  "state_path",
  "received_path",
  "process_frame",
]);

/** applied.json with the ignored keys and every `*_us` timing removed (recursively). */
export function normalizeApplied(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeApplied);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (IGNORED_KEYS.has(k) || k.endsWith("_us")) continue;
      out[k] = normalizeApplied(v);
    }
    return out;
  }
  return value;
}

/** G7xw: the core that wrote an applied.json (`receiver.core`; absent before G7xn = gdscript). */
export function appliedCore(doc: unknown): string {
  const receiver = (doc as { receiver?: { core?: unknown } } | null)?.receiver;
  return typeof receiver?.core === "string" ? receiver.core : "gdscript";
}

/** G7xw: across cores (a `rust` web leg against a `gdscript` native leg: since G7gd only an
 * older source run's evidence, such as G7b's preserved g7b-r1, can be one), a failure's prose
 * `detail` is each decoder's own wording (results/gate7/g7xn.md "Same-source replay": gate 0's
 * `corrupt`), so only its `seq` and `reason` are compared. Mutates the normalized document. */
export function dropCrossCoreDetail(normalized: Record<string, unknown>): void {
  const failure = normalized.failure as
    | Record<string, unknown>
    | null
    | undefined;
  if (failure && typeof failure === "object") delete failure.detail;
}

/** The first differing JSON paths between two normalized documents (at most `limit`). */
export function jsonDiffPaths(
  a: unknown,
  b: unknown,
  path = "$",
  limit = 5,
  out: string[] = [],
): string[] {
  if (out.length >= limit) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      out.push(`${path}: length ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      jsonDiffPaths(a[i], b[i], `${path}[${i}]`, limit, out);
    return out;
  }
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      if (!(k in (a as object)) || !(k in (b as object))) {
        out.push(`${path}.${k}: present on one side only`);
        if (out.length >= limit) return out;
        continue;
      }
      jsonDiffPaths(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
        limit,
        out,
      );
    }
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b))
    out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return out;
}

/** Native-only runner and harness files a web leg is not expected to reproduce. */
export function nativeOnly(rel: string): boolean {
  return (
    rel.startsWith("cache/") ||
    rel.startsWith("diff/") ||
    rel === "display-ownership.json" ||
    rel.startsWith("strace") ||
    rel === "shot-seqs.txt" ||
    rel === "step-join.log" ||
    rel === "corrupt-tool.log"
  );
}

export interface SourceProvenance {
  schema?: string;
  /** GRT (schema /2): the content key over the source's inputs (lib/source-key.ts). */
  source_key?: string;
  source_inputs?: SourceKeyInputs;
  /** Where the run was made (or relocated to, by the source cache). */
  source_dir?: string;
  /** Informational since GRT: validity is the content key, not the commit. */
  git_commit?: string;
  git_dirty_digest?: string;
  extension_sha256?: string | null;
  template_sha256?: string;
  calibration_sha256?: string | null;
}

/** D21 as amended by GRT: why a source run's recorded provenance does not match the current
 * build. A schema /2 source must carry the same content key (lib/source-key.ts), naming each
 * input that differs; a schema /1 source (no key) keeps the old rule: same git commit and dirty
 * digest. Either way the capture library and template sha256 must match. Empty when valid. */
export function sourceProvenanceProblems(
  src: SourceProvenance,
  current: SourceProvenance,
): string[] {
  const problems: string[] = [];
  const keys: (keyof SourceProvenance)[] = [
    "extension_sha256",
    "template_sha256",
  ];
  if (src.source_key !== undefined) {
    if (src.source_key !== current.source_key) {
      const a = src.source_inputs;
      const b = current.source_inputs;
      const parts = (
        [
          "template_sha256",
          "extension_sha256",
          "calibration_sha256",
          "receiver_core",
          "files_digest",
        ] as const
      ).filter((k) => a?.[k] !== b?.[k]);
      problems.push(
        `source_key ${src.source_key} != current ${current.source_key} (differs in ${parts.join(", ") || "schema"})`,
      );
    }
  } else keys.unshift("git_commit", "git_dirty_digest");
  for (const key of keys)
    if (src[key] !== current[key])
      problems.push(`${key} ${src[key]} != current ${current[key]}`);
  return problems;
}

export interface Gate0WebInput {
  sourceDir: string;
  webRoot: string;
  viewDir: string;
  bundleDir: string;
  expected: Gate0Expected;
  fixtureProjectDir: string;
  receiverProjectDir: string;
  /** The current build's provenance, compared with `<source>/gate7-source.json` (D21). */
  current: SourceProvenance;
}

export interface Gate7GroupResult {
  group: string;
  kind: "web" | "gsw";
  passed: boolean;
  checks: Gate7Check[];
  pw1: { shots: number; identical: number; differing: string[] };
  startup: Record<string, unknown>[];
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
    detail: problems.length === 0 ? ok : problems.join("; "),
  };
}

/** Q7 compositor-equals-readback for one leg: the CDP screenshot of the canvas, taken while the
 * applied.json PUT was held, equals the receiver's last shot (channel 0), when that shot is of the
 * last applied transaction (so the canvas still shows its state) and the frame is opaque. */
async function compositorProblems(legDir: string): Promise<string[]> {
  const applied = await readJson<{
    shots?: { seq?: number; path?: string }[];
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
  // The canvas shows the LAST applied transaction while the PUT is held. The comparison is of
  // the same frame only when that transaction's resolved state equals the last shot's (gate 0's
  // capture publishes 400 transactions, and the scene stops changing at seq 41, before its last
  // settle shot): compared from the recording itself, never assumed.
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
  for (let i = 3; i < shot.data.length; i += 4) {
    if (shot.data[i] !== 255) return [`${legDir}: the last shot is not opaque`];
  }
  const d = diffRgba(shot.data, comp.data, shot.width, shot.height);
  return d.mismatched_pixels === 0
    ? []
    : [
        `${basename(legDir)}: ${d.mismatched_pixels} px differ (max channel delta ${d.max_channel_delta})`,
      ];
}

/** Gate 0's `g7-0@web` group. */
export async function checkGate0Web(
  input: Gate0WebInput,
): Promise<Gate7GroupResult> {
  const checks: Gate7Check[] = [];
  const specs = gate0WebLegSpecs(input.sourceDir, input.webRoot);
  await buildGate0View(input.sourceDir, input.webRoot, input.viewDir);
  const report = await runGate0(input.viewDir, {
    expected: input.expected,
    fixtureProjectDir: input.fixtureProjectDir,
    receiverProjectDir: input.receiverProjectDir,
  });
  const byId = new Map<string, Gate0Check>(report.checks.map((c) => [c.id, c]));
  for (const id of GATE0_WEB_CHECK_IDS) {
    const c = byId.get(id);
    checks.push(
      c
        ? {
            id: `${id}@web`,
            criterion: c.criterion,
            passed: c.passed,
            gating: true,
            detail: c.detail,
          }
        : {
            id: `${id}@web`,
            criterion: "gate 0's own check",
            passed: false,
            gating: true,
            detail: "runGate0 did not report it",
          },
    );
  }

  // D21 source-run-valid.
  {
    const problems: string[] = [];
    const result = await readJson<{
      gate_passed?: boolean;
      legs?: Record<string, { result_class?: string; expected_class?: string }>;
    }>(join(input.sourceDir, "result.json"));
    if (!result) problems.push("source result.json missing");
    for (const leg of [
      "receiver",
      "sabotage-freeze",
      "sabotage-omit",
      "sabotage-perturb",
      "unsupported",
      "preexisting-skip",
      "corrupt",
    ] as const) {
      const entry = result?.legs?.[leg];
      if (!entry || entry.result_class !== LEG_EXPECTATIONS[leg].class)
        problems.push(
          `source leg ${leg} is ${entry?.result_class ?? "missing"}, expected ${LEG_EXPECTATIONS[leg].class}`,
        );
    }
    if (result && result.gate_passed !== true)
      problems.push("source gate_passed is not true");
    const src = await readJson<SourceProvenance>(
      join(input.sourceDir, "gate7-source.json"),
    );
    if (!src)
      problems.push(
        "source gate7-source.json missing (make it with run-gate7.sh --make-sources)",
      );
    else problems.push(...sourceProvenanceProblems(src, input.current));
    checks.push(
      mk(
        "source-run-valid@web",
        "D21: the source gate 0 run passed (every native receiver leg in its expected class) and was made from the same inputs (content key: template, capture library, calibration, receiver core and the source-shaping files; lib/source-key.ts)",
        problems,
        "source run valid, same build",
      ),
    );
  }

  // browser-provenance, console-clean, evidence-complete, applied-equals-native per leg.
  const prov: string[] = [];
  const consoleBad: string[] = [];
  const missing: string[] = [];
  const appliedDiff: string[] = [];
  const pw1 = { shots: 0, identical: 0, differing: [] as string[] };
  const startup: Record<string, unknown>[] = [];
  for (const spec of specs) {
    const p = await readJson<{
      ok?: boolean;
      reasons?: string[];
      renderer?: string;
    }>(join(spec.webDir, "provenance.json"));
    if (!p?.ok)
      prov.push(
        `${spec.leg}: ${p?.reasons?.join(", ") ?? "no provenance.json"}`,
      );
    let consoleText = "";
    try {
      consoleText = readFileSync(join(spec.webDir, "console.jsonl"), "utf8");
    } catch {
      consoleBad.push(`${spec.leg}: console.jsonl missing`);
    }
    for (const line of consoleText.split("\n").filter(Boolean)) {
      const m = JSON.parse(line) as { type: string; text: string };
      if (m.type === "pageerror" || /SHADER ERROR|WebGL: /.test(m.text))
        consoleBad.push(`${spec.leg}: ${m.type}: ${m.text.slice(0, 160)}`);
    }
    const nativeFiles = filesUnder(spec.nativeDir).filter(
      (f) => !nativeOnly(f),
    );
    for (const f of nativeFiles) {
      if (!existsSync(join(spec.webDir, f))) missing.push(`${spec.leg}/${f}`);
    }
    if (spec.sabotage === undefined && spec.extraEnv === undefined) {
      const native = await readJson<unknown>(
        join(spec.nativeDir, "applied.json"),
      );
      const web = await readJson<unknown>(join(spec.webDir, "applied.json"));
      if (!native || !web)
        appliedDiff.push(
          `${spec.leg}: applied.json missing on ${native ? "web" : "native"}`,
        );
      else {
        // D11: a native leg that ran --headless (gate 0's corrupt and unsupported) has a
        // headless viewport block (size and presentation checks `skipped-headless`); a browser
        // always renders, so that block is the one declared difference there.
        const headless = readFileSync(join(spec.nativeDir, "argv.txt"), "utf8")
          .split("\n")
          .includes("--headless");
        const crossCore = appliedCore(native) !== appliedCore(web);
        const strip = (doc: unknown): unknown => {
          const n = normalizeApplied(doc) as Record<string, unknown>;
          if (headless) delete n.viewport;
          if (crossCore) dropCrossCoreDetail(n);
          return n;
        };
        const diffs = jsonDiffPaths(strip(native), strip(web));
        if (diffs.length > 0)
          appliedDiff.push(`${spec.leg}: ${diffs.join(" | ")}`);
      }
      for (const f of nativeFiles.filter(
        (x) => x.startsWith("shots/") && x.endsWith(".png"),
      )) {
        pw1.shots++;
        const a = join(spec.nativeDir, f);
        const b = join(spec.webDir, f);
        if (!existsSync(b)) {
          pw1.differing.push(`${spec.leg}/${f}: missing on web`);
          continue;
        }
        const na = await decodePngRgba(a);
        const wb = await decodePngRgba(b);
        if (!na || !wb || na.width !== wb.width || na.height !== wb.height) {
          pw1.differing.push(`${spec.leg}/${f}: unreadable or size differs`);
          continue;
        }
        const d = diffRgba(na.data, wb.data, na.width, na.height);
        if (d.mismatched_pixels === 0) pw1.identical++;
        else
          pw1.differing.push(
            `${spec.leg}/${f}: ${d.mismatched_pixels} px (max delta ${d.max_channel_delta})`,
          );
      }
    }
    const timings = await readJson<{
      marks?: { name: string; t: number }[];
      wall_ms?: number;
      wasm_heap_bytes?: number | null;
      exit?: { t: number } | null;
      lines?: { t: number; line: string }[];
    }>(join(spec.webDir, "timings.json"));
    if (timings) {
      // Navigation-relative (performance.now()) milliseconds, cold: one fresh browser per leg.
      const mark = (n: string) =>
        timings.marks?.find((m) => m.name === n)?.t ?? null;
      const line = (re: RegExp) =>
        timings.lines?.find((l) => re.test(l.line))?.t ?? null;
      startup.push({
        leg: spec.leg,
        engine_init_ms: mark("rs-engine-init-end"),
        start_game_ms: mark("rs-start-game-end"),
        receiver_first_line_ms: mark("rs-receiver-first-line"),
        sources_staged_ms: line(/^\[receiver\] web: \d+ sources staged/),
        session_applied_ms: line(/^\[receiver\] session .* applied \(/),
        finished_ms: line(/^\[receiver\] (ok|replay-failure):/),
        exit_ms: timings.exit?.t ?? null,
        wasm_heap_bytes: timings.wasm_heap_bytes ?? null,
        wall_ms: timings.wall_ms ?? null,
      });
    }
  }
  checks.push(
    mk(
      "browser-provenance@web",
      "Q6/D9: every web leg's browser names ANGLE, NVIDIA and Vulkan, holds no Wayland fd, had DISPLAY/WAYLAND_DISPLAY unset and is the recorded chromium-1223 binary",
      prov,
      `${specs.length} legs on the pinned hardware Chromium`,
    ),
  );
  checks.push(
    mk(
      "console-clean@web",
      "Q6: no web leg logged a SHADER ERROR, a `WebGL: ` error or an uncaught page error",
      consoleBad,
      `${specs.length} legs clean`,
    ),
  );
  checks.push(
    mk(
      "evidence-complete@web",
      "Q8: every file a native gate 0 receiver leg writes (applied.json, shots, logs, exit code) exists for its web leg by the same name",
      missing,
      `${specs.length} legs complete`,
    ),
  );
  checks.push(
    mk(
      "applied-equals-native@web",
      "G7e: each web leg's applied.json equals its native leg's on every field except timings (`*_us`, process frames), evidence paths, `receiver`, `cache` (Q4: the web's HTTP cache) and `viewport.display_server`",
      appliedDiff,
      `${GATE0_RECEIVER_LEGS.length} legs equal native`,
    ),
  );

  // no-source-scene (Q4 "Bundle provenance").
  {
    const problems: string[] = [];
    const build = await readJson<{ pck?: { files?: { path: string }[] } }>(
      join(input.bundleDir, "build.json"),
    );
    const files = build?.pck?.files?.map((f) => f.path) ?? [];
    if (files.length === 0) problems.push("build.json has no pck file list");
    const fixtureScripts = new Set(
      filesUnder(input.fixtureProjectDir.replace(/\/[^/]+$/, ""))
        .filter((f) => f.endsWith(".gd"))
        .map((f) => basename(f)),
    );
    const receiverScripts = new Set(
      filesUnder(input.receiverProjectDir)
        .filter((f) => f.endsWith(".gd"))
        .map((f) => basename(f)),
    );
    for (const f of files) {
      const rel = f.replace(/^res:\/\//, "");
      if (rel.startsWith("fixtures/") || rel.includes("/fixtures/"))
        problems.push(`${f} is under fixtures/`);
      if (
        rel.endsWith(".gd") &&
        fixtureScripts.has(basename(rel)) &&
        !receiverScripts.has(basename(rel))
      )
        problems.push(`${f} is a fixture script name`);
    }
    checks.push(
      mk(
        "no-source-scene@web",
        "Q4/Q8: the web .pck's file list (build.json) has no path under fixtures/ and no fixture script name",
        problems,
        `${files.length} pck entries, none from fixtures/`,
      ),
    );
  }

  // compositor-equals-readback on the honest receiver leg, and the css-opacity sabotage.
  {
    const honest = specs.find((s) => s.leg === "receiver") as WebLegSpec;
    checks.push(
      mk(
        "compositor-equals-readback@web",
        "Q7: the CDP screenshot of the canvas equals the receiver's own readback of the same opaque frame, channel 0",
        await compositorProblems(honest.webDir),
        "screenshot equals the last shot exactly",
      ),
    );
    const sab = specs.find((s) => s.leg === CSS_OPACITY_LEG) as WebLegSpec;
    const sabProblems: string[] = [];
    const comp = await compositorProblems(sab.webDir);
    if (comp.length === 0)
      sabProblems.push(
        "compositor-equals-readback passed on the css-opacity sabotage",
      );
    else if (!/px differ/.test(comp[0]))
      sabProblems.push(`it failed for another reason: ${comp[0]}`);
    // Everything else must still hold: its readback shots equal the honest web leg's exactly.
    for (const f of filesUnder(join(honest.webDir, "shots"))) {
      const a = await decodePngRgba(join(honest.webDir, "shots", f));
      const b = await decodePngRgba(join(sab.webDir, "shots", f));
      if (
        !a ||
        !b ||
        diffRgba(a.data, b.data, a.width, a.height).mismatched_pixels > 0
      )
        sabProblems.push(`shots/${f} differs from the honest web leg`);
    }
    const exit = readFileSync(join(sab.webDir, "exit-code.txt"), "utf8").trim();
    if (exit !== "0") sabProblems.push(`exit ${exit}`);
    checks.push(
      mk(
        "sabotage-css-opacity@web",
        "Q7: `opacity: 0.99` on the canvas fails exactly compositor-equals-readback (its readback shots still equal the honest leg's and it exits 0)",
        sabProblems,
        `fails exactly compositor-equals-readback (${comp[0] ?? ""})`,
      ),
    );
  }

  // Q4 "rs_perf.gd on the web" probe (report only): what the engine's measured render times and
  // the RSS field read on WebGL 2.
  {
    const probe = specs.find((s) => s.leg === PERF_PROBE_LEG) as WebLegSpec;
    const perf = await readJson<{
      render_time?: Record<string, { status?: string; value?: number | null }>;
      histograms?: Record<string, { count?: number; sum?: number }>;
      timeline?: { rss_bytes?: number | null }[];
    }>(join(probe.webDir, "perf.json"));
    const problems: string[] = [];
    let detail = "";
    if (!perf) problems.push("perf.json missing");
    else {
      const rt = perf.render_time ?? {};
      const h = perf.histograms ?? {};
      const fmt = (k: string) =>
        `${k} ${rt[k]?.status}${rt[k]?.value != null ? ` (${rt[k]?.value?.toFixed(3)} ms)` : ""}`;
      const samples = (k: string) => `${k} ${h[k]?.count ?? 0} samples`;
      const rss = (perf.timeline ?? []).map((t) => t.rss_bytes ?? null);
      detail = `${fmt("cpu_render_ms")}, ${fmt("gpu_render_ms")}; ${samples("cpu_render_us")}, ${samples("gpu_render_us")}; timeline rss_bytes ${rss.every((r) => r === null) ? "null" : "set"} on ${rss.length} lines`;
      if (rss.some((r) => r !== null))
        problems.push(`rss_bytes set on the web: ${detail}`);
    }
    checks.push(
      mk(
        "probe-render-time@web",
        "Q4 probe (report only): rs_perf.gd's render_time statuses on WebGL 2 (nonzero means `measured`) and RSS null",
        problems,
        detail,
        false,
      ),
    );
  }

  checks.push(
    mk(
      "pw1-web-equals-native@web",
      "Q7 P-W1 (report only): every web shot equals its native shot byte for byte",
      pw1.differing,
      `${pw1.identical}/${pw1.shots} shots identical`,
      false,
    ),
  );
  return {
    group: "g7-0",
    kind: "web",
    passed: checks.every((c) => c.passed || !c.gating),
    checks,
    pw1,
    startup,
  };
}

/** The current build's D21 provenance: the content key over the source's inputs (GRT,
 * lib/source-key.ts), the capture library's sha256 (the `linux.x86_64` library the .gdextension
 * names), the pinned template's and the calibration's sha256 and, informational only since GRT,
 * the git commit and a digest of the uncommitted state of the build's own paths. */
export function currentBuildProvenance(
  repoRoot: string,
  extension: string,
  template: string,
  calibration: string = join(
    repoRoot,
    "experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json",
  ),
): SourceProvenance {
  const git = (...args: string[]): string => {
    const r = spawnSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  // The build under test: the receiver (native and web), the capture library's source and the
  // fixtures that make every recording. Checker and runner edits do not invalidate a source run.
  const built = [
    "experiments/render-stream/receiver",
    "experiments/render-stream/capture",
    "experiments/render-stream/fixtures",
  ];
  const dirty = createHash("sha256")
    .update(git("status", "--porcelain=v1", "-uall", "--", ...built))
    .update(git("diff", "HEAD", "--", ...built))
    .digest("hex");
  let extensionSha: string | null = null;
  if (existsSync(extension)) {
    const m = /^linux\.x86_64\s*=\s*"([^"]+)"/m.exec(
      readFileSync(extension, "utf8"),
    );
    extensionSha = m && existsSync(m[1]) ? sha256File(m[1]) : null;
  }
  const inputs = sourceKey(repoRoot, { extension, template, calibration });
  return {
    schema: "render-stream-gate7-source/2",
    source_key: inputs.key,
    source_inputs: inputs,
    git_commit: git("rev-parse", "HEAD").trim(),
    git_dirty_digest: dirty,
    extension_sha256: extensionSha,
    template_sha256: existsSync(template) ? sha256File(template) : undefined,
    calibration_sha256: inputs.calibration_sha256,
  };
}
