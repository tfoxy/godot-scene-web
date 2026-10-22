// Gate 7 group g7-p (G7p; protocol/gate7/g7p.md, gate7-design.md Q12 "Matrix (G7p)"): the measurement
// matrix on the three receivers and one `render-stream-report/2` per receiver kind.
//
// G6p's group is reused unforked: run-gate7.sh --live --legs g7-p runs run-gate6.sh --legs g6p once
// per receiver kind and credit window with G7P_MATRIX=1 (lib/gate6p-legs.sh run_g7p) into
// `<out>/gate6/matrix-<kind>-w<window>/<scenario>/{warmup,1..5}/`. This file judges each run with
// G6c's own loaders and measures (`loadG6cLeg`, `measureLeg`, `repeatOf`), adds Q12's browser stages to
// each repeat, assembles the report set, builds and validates the report (report-gate7.ts), and
// attaches the g31's device rows from G7v's run directories (lib/gate7p-device.ts).
//
// Checks (G6p's, with the /2 ones added):
//   clean-exit          every host and receiver process of every repeat exited 0
//   after-window-shots  every repeat's final shot equals the reference's step 11: exact for the native
//                       receiver, within Q7's band (readback/delta1, G7b) for a browser
//   report-valid        the built render-stream-report/2 validates
//   report-complete     every scenario of the kind's matrix is present with five repeats and a warmup
//   repeat-stability    every scenario's per-metric CoV is recorded; any above 10 % is named, never
//                       silently averaged; a scenario with no aggregate fails
//   device-rows-present (web and gsw) the g31's rows: each with its device_id, env.device block, a
//                       build sha equal to the report's and (pace, scene) its desktop control row; a
//                       row from an older build is omitted and named (D28), and a kind with none left
//                       fails
//
// `fetch_concurrency` 4 (Q12) is not in the matrix: GSW's fetcher is one `fetch` at a time and has no
// such option, and adding it would move the bundle the g31 rows were measured on (D28). The report
// carries `fetch_concurrency: 1` everywhere.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildReport2 } from "../report-gate7";
import { readJson } from "./gate-minus1-checks";
import {
  dist,
  exactDist,
  finalLatestState,
  type G6cLeg,
  type G6cLegEvidence,
  gamescopeVersion,
  gitInfo,
  loadG6cLeg,
  measureLeg,
  type ProvenanceInput,
  repeatOf,
} from "./gate6c-checks";
import { G6P_SCENARIOS, type G6pScenario } from "./gate6p-checks";
import { type Gate7Check, mk } from "./gate7-adapters";
import { type LoadedDeviceEvidence, loadDeviceRows } from "./gate7p-device";
import { bandedFinalState } from "./gate7r-checks";
import {
  type ReceiverKind,
  type RenderStreamReport,
  type ReportDist,
  type ReportEnv,
  type ReportRepeat,
  type ReportScenario,
  validate,
} from "./render-stream-report";

export type G7pKind = "native" | "web" | "gsw";
export const G7P_KINDS: readonly G7pKind[] = ["native", "web", "gsw"];
export const G7P_REPEATS = 5;
export const G7P_COV_NAMED = 0.1;

export const RECEIVER_KIND: Record<G7pKind, ReceiverKind> = {
  native: "native",
  web: "web-export",
  gsw: "gsw-canvas",
};

/** The device rows a browser kind must carry or name: Q12's `pace`, `scene`, `hd`, windows 1 and 2. */
export const DEVICE_WORKLOADS = ["pace", "scene", "hd"] as const;
/** Workloads whose desktop control row G7v measured (`ctl:pace`, `ctl:scene`); `hd` has none. */
export const CONTROL_WORKLOADS = ["pace", "scene"] as const;

// ---------------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------------

export interface G7pScenario {
  /** the report's scenario id (`-w2` suffix at credit window 2) */
  id: string;
  /** the scenario's directory name under the run (G6p's id) */
  dir_id: string;
  window: 1 | 2;
  base: G6pScenario;
}

const COMMON = [
  "scene-rate-15",
  "scene-rate-30",
  "scene-rate-60",
  "scene-rate-uncapped-host60",
  "scene-rate-60-cold",
];
const BROWSER_EXTRA = [
  "hd-native-rate-60",
  "hd-half-rate-60",
  "scene-constrained-60",
];

/** The scenarios Q12's matrix asks of a kind at a window (run-gate7.sh G7P / lib/gate6p-legs.sh
 * run_g7p): window 1 the common list plus the browsers' extras, window 2 `scene-rate-60` only. */
export function g7pScenarios(
  kind: G7pKind,
  windows: readonly (1 | 2)[] = [1, 2],
): G7pScenario[] {
  const out: G7pScenario[] = [];
  for (const window of windows) {
    const ids =
      window === 2
        ? ["scene-rate-60"]
        : kind === "native"
          ? COMMON
          : [...COMMON, ...BROWSER_EXTRA];
    for (const dir_id of ids) {
      const g6p = G6P_SCENARIOS.find((s) => s.id === dir_id);
      if (!g6p) throw new Error(`gate7p: no G6P_SCENARIOS entry ${dir_id}`);
      const recv = kind === "native" ? 60 : 0;
      out.push({
        id: window === 2 ? `${dir_id}-w2` : dir_id,
        dir_id,
        window,
        base: {
          ...g6p,
          receivers: g6p.receivers.length
            ? [{ dir: "receiver", max_fps: recv }]
            : [],
        },
      });
    }
  }
  return out;
}

export function matrixDir(out: string, kind: G7pKind, window: 1 | 2): string {
  return join(out, "gate6", `matrix-${kind}-w${window}`, "matrix");
}

function toLeg(s: G7pScenario, label: string): G6cLeg {
  return {
    leg: label,
    kind: "rate",
    fixture: s.base.fixture,
    variant: "animate",
    target_fps: s.base.target_fps,
    host_max_fps: s.base.host_max_fps,
    receivers: s.base.receivers,
    transport: s.base.transport,
    connections: s.base.receivers.length,
    hook_log: s.base.hook_log,
    delivery: "http",
    expected_class: "success",
  };
}

// ---------------------------------------------------------------------------------------------
// Q12's stages
// ---------------------------------------------------------------------------------------------

/** A receiver's perf.json histogram in either shape: the native and web receivers write log-linear
 * buckets (G6c's `dist`), GSW writes a summary with `p50` and `p95` only. A summary has no p99, so
 * the p99 of a summary-form dist is its p95, and its `source` says so; no zero is ever reported for
 * a percentile the receiver did not record. */
interface SummaryHist {
  count?: number;
  min?: number;
  max?: number;
  mean?: number;
  p50?: number;
  p95?: number;
  buckets?: [number, number][];
}

export function histDist(
  h: SummaryHist | undefined,
  unit: string,
  source: string,
  opts: { unavailable?: string; notApplicable?: string } = {},
): ReportDist {
  if (opts.unavailable || !h?.count || h.buckets || typeof h.p50 !== "number")
    return dist(h as never, unit, source, opts);
  const p95 = typeof h.p95 === "number" ? h.p95 : h.p50;
  return {
    status: "measured",
    unit,
    count: h.count,
    min: h.min ?? h.p50,
    p50: h.p50,
    p95,
    p99: p95,
    max: h.max ?? p95,
    mean: h.mean ?? h.p50,
    source: `${source} (summary p50/p95 only; p99 is reported as p95)`,
  };
}

function unavailableDist(unit: string, why: string): ReportDist {
  void why;
  return dist(undefined, unit, "", { unavailable: why });
}

/** Adds Q12's browser stages to a G6c repeat (`recv_raf_interval_us`, `recv_raf_after_submit_us`,
 * `recv_gpu_complete_us` -- gsw only --, `recv_hold_us`, `recv_preflight_us`) and `startup`. */
export function addV2Stages(
  repeat: ReportRepeat,
  ev: G6cLegEvidence,
  kind: G7pKind,
): ReportRepeat {
  const r0 = ev.receivers[0];
  const h = r0?.perf?.histograms as Record<string, never> | undefined;
  const perf = r0 ? `${r0.dir.slice(ev.dir.length + 1)}/perf.json` : "";
  const holds = (r0?.applied?.transactions ?? [])
    .filter(
      (t) =>
        typeof t.submitted_us === "number" && typeof t.received_us === "number",
    )
    .map((t) => (t.submitted_us ?? 0) - (t.received_us ?? 0));
  const browser = kind !== "native";
  repeat.stages.recv_raf_interval_us = browser
    ? histDist(h?.frame_interval_us, "us", perf, {
        notApplicable: "no receiver",
      })
    : unavailableDist(
        "us",
        "native: no rAF; recv_frame_interval_us is its frame interval",
      );
  repeat.stages.recv_raf_after_submit_us =
    kind === "gsw"
      ? histDist(h?.raf_after_submit_us, "us", perf, {
          unavailable: h?.raf_after_submit_us ? undefined : "not recorded",
        })
      : unavailableDist(
          "us",
          `${kind}: only GSW's paced loop records the rAF after a submit`,
        );
  repeat.stages.recv_gpu_complete_us =
    kind === "gsw"
      ? histDist(h?.gpu_complete_us, "us", perf, {
          unavailable: h?.gpu_complete_us ? undefined : "not recorded",
        })
      : unavailableDist(
          "us",
          `${kind}: a gpu_complete fence exists only for gsw-canvas`,
        );
  repeat.stages.recv_hold_us = exactDist(
    holds,
    "us",
    r0 ? `${r0.dir.slice(ev.dir.length + 1)}/applied.json` : "",
  );
  repeat.stages.recv_preflight_us = unavailableDist(
    "us",
    "per-fetch preflight cost is read from the proxy's stats (constrained scenario), not per repeat",
  );
  // GSW's summary-form histograms: G6c's bucket reader would report p50 0 for them.
  const st = repeat.stages as unknown as Record<string, ReportDist>;
  for (const [out, src] of [
    ["recv_decode_us", "decode_us"],
    ["recv_apply_us", "apply_us"],
    ["recv_fetch_us", "fetch_us"],
    ["recv_frame_interval_us", "frame_interval_us"],
  ] as const) {
    const hh = h?.[src] as SummaryHist | undefined;
    if (hh?.count && !hh.buckets && typeof hh.p50 === "number")
      st[out] = histDist(hh, "us", perf);
  }
  repeat.startup = null;
  return repeat;
}

// ---------------------------------------------------------------------------------------------
// Report set
// ---------------------------------------------------------------------------------------------

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function dirBytes(dir: string): number {
  let n = 0;
  if (!existsSync(dir)) return 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return n;
}

function buildMeta(
  kind: G7pKind,
  s: G7pScenario,
  scenarioDir: string,
): Omit<ReportScenario, "repeats" | "aggregate"> {
  const b = s.base;
  const hd = b.fixture === "gate6-hd";
  const logical: [number, number] = hd ? [1920, 1080] : [640, 360];
  const presentation: [number, number] =
    b.presentation === "half" ? [960, 540] : logical;
  const browser = kind !== "native";
  return {
    id: s.id,
    fixture: b.fixture,
    variant: "animate",
    arm: "streaming",
    resolution: { logical, presentation },
    profile: {
      rendering_method: "gl_compatibility",
      msaa_2d: 0,
      hdr_2d: false,
      stretch: hd
        ? { mode: "canvas_items", aspect: "keep", scale_mode: "fractional" }
        : { mode: "disabled", aspect: "ignore", scale_mode: "fractional" },
      font_oversampling: presentation[0] / logical[0],
    },
    config: {
      target_fps: b.target_fps,
      host_max_fps: b.host_max_fps,
      receiver_max_fps: b.receivers[0]?.max_fps ?? 0,
      credit_stage: "submitted",
      transport: b.transport,
      cache: b.cache === "cold" ? "cold" : browser ? "warm-http" : "warm",
      delivery: "http",
      connections: b.receivers.length,
      time: "realtime",
      receiver_kind: RECEIVER_KIND[kind],
      credit_window: s.window,
      late_poll: false,
      fetch_concurrency: 1,
    },
    warmup: { run_dir: join(scenarioDir, "warmup"), discarded: true },
  };
}

interface PageEnv {
  RS_RECEIVER_BUILD_SHA256?: string;
}

async function pageEnv(receiverDir: string): Promise<PageEnv> {
  const cfg = await readJson<{ url?: string }>(
    join(receiverDir, "page-config.json"),
  );
  const m = cfg?.url?.match(/[?&]env=([^&]+)/);
  if (!m) return {};
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    return (
      JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
        env: PageEnv;
      }
    ).env;
  } catch {
    return {};
  }
}

async function buildProvenance(
  out: string,
  kind: G7pKind,
  firstRun: string,
  scenarios: G7pScenario[],
): Promise<Record<string, unknown>> {
  const matrix = join(firstRun, "matrix");
  const input = await readJson<ProvenanceInput>(
    join(matrix, "provenance-input.json"),
  );
  const calibration = input?.calibration
    ? await readJson<{
        engine?: { version_string?: string };
        slots?: Record<string, number>;
        calibrator?: { version?: string };
      }>(input.calibration)
    : undefined;
  const first = scenarios[0];
  const rdir = join(matrix, first.dir_id, "1", "receiver");
  const perf = await readJson<{
    rendering_method?: string;
    adapter?: { vendor?: string; name?: string; api_version?: string };
  }>(join(rdir, "perf.json"));
  const browser = kind !== "native";
  const bprov = browser
    ? await readJson<Record<string, unknown>>(join(rdir, "provenance.json"))
    : undefined;
  const env = browser ? await pageEnv(rdir) : {};
  const bundleDir = join(
    firstRun,
    kind === "web" ? "web-bundle" : "gsw-bundle",
  );
  const exts = ((bprov?.extensions as string[] | undefined) ?? [])
    .slice()
    .sort();
  const exe = String(bprov?.executablePath ?? "");
  const receiver: Record<string, unknown> = {
    project_sha256: browser
      ? (env.RS_RECEIVER_BUILD_SHA256 ?? "unknown")
      : (input?.receiver_project_sha256 ?? "unknown"),
    rendering_method: perf?.rendering_method ?? "gl_compatibility",
    adapter: {
      vendor:
        perf?.adapter?.vendor ?? (bprov?.vendor as string | undefined) ?? "",
      name:
        perf?.adapter?.name ?? (bprov?.renderer as string | undefined) ?? "",
      api_version: perf?.adapter?.api_version ?? (browser ? "WebGL 2.0" : ""),
    },
    kind: RECEIVER_KIND[kind],
    browser: browser
      ? {
          product: "Chromium",
          version: String(bprov?.version ?? "unknown"),
          revision: exe.match(/chromium-\d+/)?.[0] ?? "unknown",
          sha256: String(bprov?.binarySha256 ?? "unknown"),
          args: (bprov?.args as string[] | undefined) ?? [],
          renderer: String(bprov?.renderer ?? "unknown"),
          extensions_hash: sha256(JSON.stringify(exts)),
        }
      : null,
    bundle: browser
      ? {
          sha256: env.RS_RECEIVER_BUILD_SHA256 ?? "unknown",
          bytes: dirBytes(bundleDir),
        }
      : null,
  };
  const desktop: ReportEnv = {
    kind: "desktop",
    device_id: null,
    device: null,
    panel: null,
  };
  return {
    engine: {
      version_string:
        calibration?.engine?.version_string ?? "Godot Engine v4.5.1.stable",
      sha256: input?.engine_sha256 ?? "unknown",
      template: "linux_release",
    },
    capture: {
      library_sha256: input?.library_sha256 ?? "unknown",
      calibrator_version: Number(calibration?.calibrator?.version ?? 0),
      hooks_planned: Object.keys(calibration?.slots ?? {}).length,
    },
    receiver,
    protocol: "render-stream/7",
    display: {
      compositor: "gamescope",
      version: gamescopeVersion(),
      sizes: input?.gamescope_sizes ?? [
        [640, 360],
        [1920, 1080],
        [960, 540],
      ],
    },
    timing: {
      host_clock: "steady_clock",
      receiver_clock: browser ? "performance.now" : "Time.get_ticks_usec",
      rates_clock: "host",
      screenshots: "outside-measured-window",
      hook_log: "off",
    },
    env: desktop,
    _out: out,
  };
}

// ---------------------------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------------------------

export interface G7pKindResult {
  group: "g7-p";
  kind: G7pKind;
  live: true;
  passed: boolean;
  run_dir: string;
  checks: Gate7Check[];
  report_path: string | null;
  scenario_summary: Record<string, string>;
}

export interface G7pOptions {
  windows?: readonly (1 | 2)[];
  /** The report ids the run declares it ran (`--g7p-scenarios`); unset: the kind's whole matrix.
   * `report-complete` judges the declared list and names the scenarios of the full matrix it leaves
   * out, so a reduced run says so in its own verdict. */
  declared?: readonly string[];
  /** G7v run directories holding g7v-summary.json (the g31's rows, and the desktop control run) */
  deviceEvidence?: readonly string[];
}

const fmt = (v: number | null | undefined, d = 1): string =>
  v === null || v === undefined ? "?" : v.toFixed(d);

export function covFindings(scenarios: readonly ReportScenario[]): {
  named: string[];
  broken: string[];
} {
  const named: string[] = [];
  const broken: string[] = [];
  for (const rs of scenarios) {
    if (!rs.aggregate) {
      broken.push(`${rs.id}: no aggregate block`);
      continue;
    }
    for (const [path, entry] of Object.entries(rs.aggregate))
      if (entry.cov > G7P_COV_NAMED)
        named.push(`${rs.id} ${path}: CoV ${(entry.cov * 100).toFixed(1)}%`);
  }
  return { named, broken };
}

/** device-rows-present's problems and detail over a built report (pure; self-tested). */
export function deviceRowProblems(
  report: Pick<
    RenderStreamReport,
    "device_rows" | "omitted_device_rows" | "provenance"
  >,
  kind: G7pKind,
  windows: readonly (1 | 2)[],
  deviceId = "g31",
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const rk = RECEIVER_KIND[kind];
  const rows = (report.device_rows ?? []).filter((r) => r.receiver_kind === rk);
  const omitted = report.omitted_device_rows ?? [];
  const reportSha = report.provenance.receiver.bundle?.sha256;
  for (const w of windows) {
    for (const wl of DEVICE_WORKLOADS) {
      const row = rows.find((r) => r.credit_window === w && r.workload === wl);
      const named = omitted.find(
        (o) =>
          o.receiver_kind === rk && o.credit_window === w && o.workload === wl,
      );
      if (!row && !named) {
        problems.push(
          `${deviceId} ${rk} window ${w} ${wl}: neither a row nor an omission naming it`,
        );
        continue;
      }
      if (!row) continue;
      if (row.device_id !== deviceId)
        problems.push(`${rk} w${w} ${wl}: device_id ${row.device_id}`);
      const d = row.env?.device as Record<string, unknown> | null | undefined;
      if (
        !d ||
        typeof d.model !== "string" ||
        typeof d.androidRelease !== "string" ||
        typeof d.chrome !== "string"
      )
        problems.push(
          `${rk} w${w} ${wl}: no env.device block (model, androidRelease, chrome)`,
        );
      if (row.env?.device_id !== row.device_id)
        problems.push(
          `${rk} w${w} ${wl}: env.device_id differs from device_id`,
        );
      if (!row.build?.bundle_sha256 || row.build.bundle_sha256 !== reportSha)
        problems.push(
          `${rk} w${w} ${wl}: build ${String(row.build?.bundle_sha256).slice(0, 12)} is not the report's ${String(reportSha).slice(0, 12)}`,
        );
      if ((CONTROL_WORKLOADS as readonly string[]).includes(wl) && !row.control)
        problems.push(`${rk} w${w} ${wl}: no desktop control row`);
    }
  }
  if (rows.length === 0)
    problems.push(
      `no ${deviceId} row for ${rk} survives (${omitted.filter((o) => o.receiver_kind === rk).length} omitted as an older build or without a build sha, D28); re-run the g31 rows unattended`,
    );
  const named = omitted.filter((o) => o.receiver_kind === rk);
  return {
    problems,
    detail: `${rows.length} ${deviceId} row(s) for ${rk} (${rows
      .map(
        (r) =>
          `w${r.credit_window}:${r.workload}${r.summary.invalid_repeats ? `(${r.summary.invalid_repeats} invalid)` : ""}`,
      )
      .join(
        ", ",
      )})${named.length ? `; omitted and named: ${named.map((o) => `w${o.credit_window}:${o.workload} (${o.reason})`).join("; ")}` : ""}`,
  };
}

export async function checkG7pKind(
  out: string,
  kind: G7pKind,
  opts: G7pOptions = {},
): Promise<G7pKindResult> {
  const windows = opts.windows ?? [1, 2];
  const scenarios = g7pScenarios(kind, windows);
  // `--g7p-scenarios` items are report ids; `gsw:hd-half-rate-60` names one for that kind only.
  const declared = opts.declared?.flatMap((d) => {
    const m = d.match(/^(native|web|gsw):(.+)$/);
    return m ? (m[1] === kind ? [m[2]] : []) : [d];
  });
  const expected = declared
    ? scenarios.filter((s) => declared.includes(s.id))
    : scenarios;
  const setDir = join(out, "gate6", `g7p-${kind}`, "report-set");
  const exitProblems: string[] = [];
  const shotProblems: string[] = [];
  const summary: Record<string, string> = {};
  const missingDirs: string[] = [];
  const checks: Gate7Check[] = [];

  await mkdir(join(setDir, "scenarios"), { recursive: true });
  const present: G7pScenario[] = [];
  for (const s of scenarios) {
    const runRoot = join(out, "gate6", `matrix-${kind}-w${s.window}`);
    const sdir = join(matrixDir(out, kind, s.window), s.dir_id);
    if (!existsSync(sdir)) {
      if (!declared || declared.includes(s.id))
        missingDirs.push(`${s.id}: no ${sdir}`);
      continue;
    }
    present.push(s);
    const rs = join(setDir, "scenarios", s.id);
    await mkdir(join(rs, "warmup"), { recursive: true });
    await writeFile(
      join(rs, "warmup", "repeat.json"),
      JSON.stringify({ run_dir: join(sdir, "warmup") }),
    );
    await writeFile(
      join(rs, "meta.json"),
      JSON.stringify(buildMeta(kind, s, sdir)),
    );
    const bits: string[] = [];
    for (let i = 1; i <= G7P_REPEATS; i++) {
      const label = String(i);
      const ev = await loadG6cLeg(sdir, toLeg(s, label));
      if (!ev.present) {
        exitProblems.push(
          `${s.id}/${label}: no host steps (the repeat did not run)`,
        );
        continue;
      }
      const m = measureLeg(ev);
      const repeat = addV2Stages(repeatOf(ev, m), ev, kind);
      if (i === 1) {
        bits.push(`host_frame ${fmt(m.host_frame)}/s`);
        const p = m.conns[0]?.published;
        if (p !== undefined) bits.push(`published ${fmt(p)}/s`);
        const a = m.conns[0]?.applied;
        if (a !== undefined) bits.push(`applied ${fmt(a)}/s`);
      }
      if (ev.host_exit !== 0)
        exitProblems.push(`${s.id}/${label} host: exit ${ev.host_exit}`);
      for (const r of ev.receivers) {
        if (r.exit !== 0)
          exitProblems.push(
            `${s.id}/${label} ${r.dir.split("/").pop()}: exit ${r.exit}`,
          );
      }
      if (s.base.receivers.length > 0) {
        const f =
          kind === "native"
            ? await finalLatestState(ev)
            : await bandedFinalState(ev, 0);
        if (f.problems.length > 0)
          shotProblems.push(`${s.id}/${label}: ${f.problems.join("; ")}`);
      }
      await mkdir(join(rs, `repeat-${i}`), { recursive: true });
      await writeFile(
        join(rs, `repeat-${i}`, "repeat.json"),
        JSON.stringify(repeat),
      );
    }
    summary[s.id] = bits.join(", ") || "(no summary)";
    void runRoot;
  }

  checks.push(
    mk(
      "clean-exit",
      "every host and receiver process of every repeat exited 0",
      exitProblems,
      exitProblems.length === 0 ? "every process exited 0" : "",
    ),
  );
  checks.push(
    mk(
      "after-window-shots",
      kind === "native"
        ? "every repeat's final shot equals the reference's step 11, whole frame, budget 0"
        : "every repeat's final shot equals the reference's step 11 within Q7's band (every differing pixel readback or delta1)",
      shotProblems,
      shotProblems.length === 0
        ? "every repeat's final shot is at or after step 11 and inside the band"
        : "",
    ),
  );

  // The report.
  let reportPath: string | null = null;
  let report: RenderStreamReport | undefined;
  const reportProblems: string[] = [];
  const firstWindow = present[0]?.window;
  if (present.length === 0 || firstWindow === undefined) {
    reportProblems.push(
      `no matrix run under ${join(out, "gate6", `matrix-${kind}-w*`)}`,
    );
  } else {
    try {
      const firstRun = join(out, "gate6", `matrix-${kind}-w${firstWindow}`);
      const prov = await buildProvenance(
        out,
        kind,
        firstRun,
        present.filter((p) => p.window === firstWindow),
      );
      delete prov._out;
      await writeFile(
        join(setDir, "run.json"),
        JSON.stringify({
          id: `g7p/${kind}/${Date.now()}`,
          started_utc: new Date().toISOString(),
          runner: "run-gate7.sh --live --legs g7-p",
          args: ["--legs", "g7-p"],
          git: gitInfo(),
        }),
      );
      await writeFile(join(setDir, "provenance.json"), JSON.stringify(prov));
      let ev: LoadedDeviceEvidence = {
        rows: [],
        omitted: [],
        startup: [],
        sources: [],
      };
      if (kind !== "native" && opts.deviceEvidence?.length) {
        const sha =
          (prov.receiver as { bundle?: { sha256?: string } }).bundle?.sha256 ??
          null;
        ev = await loadDeviceRows(
          opts.deviceEvidence,
          () => sha,
          "g31",
          RECEIVER_KIND[kind] as "web-export" | "gsw-canvas",
        );
      }
      await writeFile(
        join(setDir, "device-rows.json"),
        JSON.stringify({
          rows: ev.rows,
          omitted: ev.omitted,
          startup: ev.startup,
        }),
      );
      report = await buildReport2(setDir, { repeats: 5 });
      reportProblems.push(...validate(report, { repeats: 5 }));
      reportPath = join(out, `render-stream-report-${kind}.json`);
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      reportProblems.push(`build failed: ${String(error)}`);
    }
  }
  checks.push(
    mk(
      "report-valid",
      "the kind's render-stream-report/2 validates (schema plus internal consistency)",
      reportProblems,
      report
        ? `${report.scenarios.length} scenarios, 5 repeats each, ${report.device_rows?.length ?? 0} device rows, valid`
        : "",
    ),
  );
  const have = new Set(report?.scenarios.map((s) => s.id) ?? []);
  const missing = expected.filter((s) => !have.has(s.id)).map((s) => s.id);
  const notDeclared = scenarios
    .filter((s) => !expected.includes(s))
    .map((s) => s.id);
  checks.push(
    mk(
      "report-complete",
      "every scenario of Q12's matrix for this receiver is present with five repeats and a discarded warmup (fetch_concurrency 4 is not run: GSW's fetcher has no such option)",
      [
        ...missingDirs,
        ...(report ? [] : ["report build failed, see report-valid"]),
        ...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
      ],
      declared
        ? `${expected.length - missing.length}/${expected.length} declared scenarios present (a reduced matrix: ${scenarios.length - expected.length} of the full ${scenarios.length} not declared: ${notDeclared.join(", ") || "none"}); ${[...have].filter((id) => !expected.some((e) => e.id === id)).length} further scenario(s) present and reported`
        : `${have.size}/${scenarios.length} scenarios present`,
    ),
  );
  const cov = report
    ? covFindings(report.scenarios)
    : { named: [], broken: ["report build failed, see report-valid"] };
  checks.push(
    mk(
      "repeat-stability",
      "every scenario's per-metric CoV across its 5 repeats is recorded; any above 10 % is named here, never silently averaged",
      cov.broken,
      cov.named.length > 0
        ? `${cov.named.length} metric(s) above 10 % CoV: ${cov.named.slice(0, 25).join("; ")}${cov.named.length > 25 ? "; ..." : ""}`
        : "every metric's CoV is <= 10 % on every scenario",
    ),
  );
  if (kind === "native") {
    checks.push(
      mk(
        "device-rows-present",
        "the g31's device rows (browser kinds only)",
        [],
        "native: no phone rows (the phone runs the browser receivers)",
      ),
    );
  } else if (!report) {
    checks.push(
      mk(
        "device-rows-present",
        "the g31's rows, each with device_id, env.device, a build sha equal to the report's and its desktop control row",
        ["report build failed, see report-valid"],
        "",
      ),
    );
  } else if (!opts.deviceEvidence?.length) {
    checks.push(
      mk(
        "device-rows-present",
        "the g31's rows, each with device_id, env.device, a build sha equal to the report's and its desktop control row",
        [
          "no --device-evidence given: the g31's rows come from G7v's run directories, or a re-run with run-gate7.sh --env device --device g31",
        ],
        "",
      ),
    );
  } else {
    const d = deviceRowProblems(report, kind, windows);
    checks.push(
      mk(
        "device-rows-present",
        "the g31's rows, each with device_id, env.device, a build sha equal to the report's and its desktop control row; an older build's row is omitted and named (D28)",
        d.problems,
        d.detail,
      ),
    );
  }

  return {
    group: "g7-p",
    kind,
    live: true,
    passed: checks.every((c) => c.passed || !c.gating),
    run_dir: out,
    checks,
    report_path: reportPath,
    scenario_summary: summary,
  };
}
