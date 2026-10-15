// Gate 6 group g6p (protocol/gate6-design.md "G6p", Q7g): the measurement matrix, deltas analysis
// (D15) and a validated `render-stream-report/1` over every Q7g scenario.
//
// Pure over an evidence directory `run-gate6.sh`'s run_g6p (lib/gate6p-legs.sh) wrote, built from
// gate6c-checks.ts's own evidence loader/measurer/single-repeat-report plumbing ("the plumbing
// G6p reuses for its five repeats", that file's header) -- `loadG6cLeg`, `measureLeg`, `repeatOf`
// and `finalLatestState` are called once per repeat, for every scenario whose arm loads the
// capture extension (`armed-idle`, `streaming`). The `unarmed` arm (D11: "no extension: host
// simulation alone") writes none of that evidence -- no perf.json, no perf-timeline.jsonl, no
// live-summary.json -- so its two scenarios build a bespoke, mostly-`unavailable`/`not-applicable`
// repeat from `scripts/sample-rate.ts`'s wall-clock step-log slope (the only host-rate signal
// available with no extension loaded) and the runner's `/proc` sampler.
//
// report-gate6.ts's `buildReport`/`validate` do the rest: every scenario's `meta.json` and five
// `repeat-N/repeat.json` files land in report-gate6.ts's own run-set directory convention, so one
// `buildReport(setDir, {repeats: 5, deltasPath})` call assembles and aggregates the whole
// render-stream-report/1 (Q7g: "`scripts/analyze-deltas.ts` adds `optimizations` (D15)" -- wired
// through `buildReport`'s existing `deltasPath` option, fed the one scenario that runs with
// `GRC_HOOK_LOG=on`).

import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
// report-gate6.ts imports this file's sibling (gate6c-checks.ts) already; importing it back here
// is the same "report-gate6.ts build wiring" G6c's own writeLegReport uses.
import { buildReport } from "../report-gate6";
import type { WallRateResult } from "../sample-rate";
import { readJson, readTextOrUndefined } from "./gate-minus1-checks";
import { readExitCode } from "./gate0-checks";
import { check } from "./gate5-checks";
import type { Gate6Check } from "./gate6a-checks";
import {
  cpuOf,
  dist,
  exactDist,
  finalLatestState,
  type G6cLeg,
  type G6cLegEvidence,
  gamescopeVersion,
  gitInfo,
  loadG6cLeg,
  measureLeg,
  memoryOf,
  type ProcSampleLine,
  type ProvenanceInput,
  parseJsonl,
  rate,
  repeatOf,
} from "./gate6c-checks";
import {
  type RateName,
  type ReportRate,
  type ReportRepeat,
  type ReportScenario,
  validate,
} from "./render-stream-report";

// ---------------------------------------------------------------------------------------------
// The matrix (Q7g)
// ---------------------------------------------------------------------------------------------

export type G6pCache = "warm" | "cold";
export type G6pArm = "unarmed" | "armed-idle" | "streaming";

export interface G6pScenario {
  id: string;
  fixture: "gate6-scene" | "gate6-hd";
  presentation: "native" | "half";
  arm: G6pArm;
  /** null: uncapped (GRC_PUBLISH_FPS unset) */
  target_fps: number | null;
  host_max_fps: number;
  receivers: { dir: string; max_fps: number }[];
  transport: "loopback" | "constrained";
  cache: G6pCache;
  hook_log: "on" | "off";
}

const unarmed = (
  id: string,
  fixture: "gate6-scene" | "gate6-hd",
): G6pScenario => ({
  id,
  fixture,
  presentation: "native",
  arm: "unarmed",
  target_fps: null,
  host_max_fps: 60,
  receivers: [],
  transport: "loopback",
  cache: "warm",
  hook_log: "off",
});

const armedIdle = (
  id: string,
  fixture: "gate6-scene" | "gate6-hd",
): G6pScenario => ({
  id,
  fixture,
  presentation: "native",
  arm: "armed-idle",
  target_fps: null,
  host_max_fps: 60,
  receivers: [],
  transport: "loopback",
  cache: "warm",
  hook_log: "off",
});

const streaming = (
  id: string,
  fixture: "gate6-scene" | "gate6-hd",
  presentation: "native" | "half",
  target: number | null,
  hostFps: number,
  recvFps: number | null,
  extra: Partial<G6pScenario> = {},
): G6pScenario => ({
  id,
  fixture,
  presentation,
  arm: "streaming",
  target_fps: target,
  host_max_fps: hostFps,
  receivers: recvFps === null ? [] : [{ dir: "receiver", max_fps: recvFps }],
  transport: "loopback",
  cache: "warm",
  hook_log: "off",
  ...extra,
});

/** Q7g's matrix: 9 gate6-scene scenarios, 8 gate6-hd native, 1 gate6-hd half, plus constrained and
 * dual (both on gate6-scene) -- 20 in all. The one scenario with `hook_log: "on"` feeds D15. */
export const G6P_SCENARIOS: readonly G6pScenario[] = [
  unarmed("scene-unarmed", "gate6-scene"),
  armedIdle("scene-armed-idle", "gate6-scene"),
  streaming("scene-rate-15", "gate6-scene", "native", 15, 60, 60),
  streaming("scene-rate-30", "gate6-scene", "native", 30, 60, 60),
  streaming("scene-rate-60", "gate6-scene", "native", 60, 60, 60),
  streaming(
    "scene-rate-uncapped-host60",
    "gate6-scene",
    "native",
    null,
    60,
    60,
  ),
  streaming("scene-rate-uncapped", "gate6-scene", "native", null, 0, 0),
  streaming("scene-rate-60-cold", "gate6-scene", "native", 60, 60, 60, {
    cache: "cold",
  }),
  streaming("scene-rate-60-hooklog", "gate6-scene", "native", 60, 60, 60, {
    hook_log: "on",
  }),
  unarmed("hd-native-unarmed", "gate6-hd"),
  armedIdle("hd-native-armed-idle", "gate6-hd"),
  streaming("hd-native-rate-15", "gate6-hd", "native", 15, 60, 60),
  streaming("hd-native-rate-30", "gate6-hd", "native", 30, 60, 60),
  streaming("hd-native-rate-60", "gate6-hd", "native", 60, 60, 60),
  streaming(
    "hd-native-rate-uncapped-host60",
    "gate6-hd",
    "native",
    null,
    60,
    60,
  ),
  streaming("hd-native-rate-uncapped", "gate6-hd", "native", null, 0, 0),
  streaming("hd-native-rate-60-cold", "gate6-hd", "native", 60, 60, 60, {
    cache: "cold",
  }),
  streaming("hd-half-rate-60", "gate6-hd", "half", 60, 60, 60),
  streaming("scene-constrained-60", "gate6-scene", "native", 60, 60, 60, {
    transport: "constrained",
  }),
  streaming("scene-dual-60-15", "gate6-scene", "native", null, 60, null, {
    receivers: [
      { dir: "receiver-a", max_fps: 60 },
      { dir: "receiver-b", max_fps: 15 },
    ],
  }),
];

export const G6P_DELTAS_SCENARIO = "scene-rate-60-hooklog";
export const G6P_DIR = "matrix";
export const G6P_REPEATS = 5;

function toG6cLeg(scn: G6pScenario, leg: string): G6cLeg {
  return {
    leg,
    kind: scn.arm === "armed-idle" ? "baseline" : "rate",
    fixture: scn.fixture,
    variant: "animate",
    target_fps: scn.target_fps,
    host_max_fps: scn.host_max_fps,
    receivers: scn.receivers,
    transport: scn.transport,
    connections: scn.receivers.length,
    hook_log: scn.hook_log,
    delivery: "http",
    expected_class: "success",
  };
}

function fixtureResolution(
  fixture: "gate6-scene" | "gate6-hd",
): [number, number] {
  return fixture === "gate6-hd" ? [1920, 1080] : [640, 360];
}

function buildMeta(
  scn: G6pScenario,
  scenarioDir: string,
): Omit<ReportScenario, "repeats" | "aggregate"> {
  const logical = fixtureResolution(scn.fixture);
  const presentation: [number, number] =
    scn.presentation === "half" ? [960, 540] : logical;
  const hd = scn.fixture === "gate6-hd";
  return {
    id: scn.id,
    fixture: scn.fixture,
    variant: "animate",
    arm: scn.arm,
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
      target_fps: scn.target_fps,
      host_max_fps: scn.host_max_fps,
      receiver_max_fps: scn.receivers[0]?.max_fps ?? 0,
      credit_stage: "submitted",
      transport: scn.transport,
      cache: scn.cache,
      delivery: "http",
      connections: scn.receivers.length,
      time: "realtime",
    },
    warmup: { run_dir: join(scenarioDir, "warmup"), discarded: true },
  };
}

// ---------------------------------------------------------------------------------------------
// The `unarmed` repeat (no extension: everything but host_frame/cpu/memory is unavailable)
// ---------------------------------------------------------------------------------------------

/** A repeat from an `unarmed` run's evidence: `sample-rate.ts`'s wall-clock slope
 * (host/wall-rate.json) and the runner's `/proc` sampler (host/proc-samples.jsonl) are the only
 * signals available with no capture extension loaded (D11). Every other field the schema
 * requires carries 0/not-applicable and is named in `unavailable`. */
export async function unarmedRepeatOf(
  repeatDir: string,
): Promise<ReportRepeat & { unavailable: string[] }> {
  const wallRate = await readJson<WallRateResult>(
    join(repeatDir, "host", "wall-rate.json"),
  );
  const samples = parseJsonl<ProcSampleLine>(
    await readTextOrUndefined(join(repeatDir, "host", "proc-samples.jsonl")),
  );
  const hostMem = memoryOf(samples);

  const rates = {} as Record<RateName, ReportRate>;
  rates.requested = rate(null, "", "unarmed: no publication (D11)");
  rates.host_frame =
    wallRate?.host_frame_rate != null
      ? rate(
          wallRate.host_frame_rate,
          join(repeatDir, "host", "wall-rate.json"),
        )
      : {
          value: null,
          unit: "1/s",
          status: "unavailable",
          source: null,
          reason: wallRate?.reason ?? "no wall-rate.json written",
        };
  rates.published = rate(null, "", "unarmed: no extension, no publication");
  rates.received = rate(null, "", "unarmed: no receiver");
  rates.applied = rate(null, "", "unarmed: no receiver");
  rates.submitted = rate(null, "", "unarmed: no receiver");
  rates.receiver_frame = rate(null, "", "unarmed: no receiver");
  rates.presented = {
    value: null,
    unit: "1/s",
    status: "unavailable",
    source: null,
    reason: "Godot exposes no presentation feedback (D9)",
  };

  const na = dist(undefined, "us", "", {
    notApplicable: "unarmed: no extension instrumentation (D11)",
  });
  const stages = {
    host_frame_interval_us: na,
    host_callback_us: na,
    snapshot_us: na,
    diff_us: na,
    encode_us: na,
    enqueue_us: na,
    texture_copy_us: na,
    texture_hash_us: na,
    mesh_copy_us: na,
    mesh_hash_us: na,
    shader_copy_us: na,
    param_decode_us: na,
    http_serve_us: na,
    credit_rtt_us: { applied: na, submitted: na },
    staleness_us: { submitted: na },
    recv_decode_us: na,
    recv_apply_us: na,
    recv_upload_us: na,
    recv_fetch_us: na,
    recv_frame_interval_us: na,
    recv_gpu_render_ms: na,
  } as unknown as ReportRepeat["stages"];

  return {
    run_dir: repeatDir,
    window_s: wallRate?.window_seconds ?? 0,
    rates,
    stages,
    cpu: {
      host_main_thread_s: 0,
      host_io_thread_s: 0,
      host_process_s: cpuOf(samples),
      receiver_process_s: 0,
    },
    queues: {
      max_in_flight: 0,
      max_pending: 0,
      pending_episodes: 0,
      max_pending_age_us: 0,
      coalesced: 0,
      ticks_credit_blocked: 0,
      max_queued_bytes: 0,
    },
    bytes: {
      transaction: exactDist([], "bytes", ""),
      wire_bytes_per_s: 0,
      resource_bytes: 0,
      http_bytes: 0,
      fetches: 0,
    },
    resources: {
      host_retained_max: 0,
      host_retained_bytes_max: 0,
      host_pins_max: 0,
      recv_cache_entries_max: 0,
      recv_cache_bytes_max: 0,
      recv_evictions: 0,
      recv_rids_max: 0,
      recv_texture_mem_max: 0,
      recv_video_mem_max: 0,
      recv_pipeline_compilations: 0,
    },
    memory: {
      host_rss_start: hostMem.start,
      host_rss_end: hostMem.end,
      host_rss_slope_bytes_per_min: hostMem.slope,
      host_vmhwm: hostMem.hwm,
      recv_rss_start: 0,
      recv_rss_end: 0,
      recv_rss_slope_bytes_per_min: 0,
      recv_vmhwm: 0,
    },
    unavailable: [
      "cpu.host_main_thread_s",
      "cpu.host_io_thread_s",
      "cpu.receiver_process_s",
      "resources.host_retained_max",
      "resources.host_retained_bytes_max",
      "resources.host_pins_max",
      "resources.recv_cache_entries_max",
      "resources.recv_cache_bytes_max",
      "resources.recv_evictions",
      "resources.recv_rids_max",
      "resources.recv_texture_mem_max",
      "resources.recv_video_mem_max",
      "resources.recv_pipeline_compilations",
      "memory.recv_rss_start",
      "memory.recv_rss_end",
      "memory.recv_rss_slope_bytes_per_min",
      "memory.recv_vmhwm",
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------------------------

export interface G6pLegEntry {
  group: "g6p";
  scenario_id: string;
  arm: G6pArm;
  repeats_written: number;
  // Mirrors the other groups' leg-entry shape (check-gate6.ts prints every leg generically): a
  // matrix scenario has no single pass/fail class of its own, so these are fixed placeholders.
  expected_class: "measured";
  result_class: "measured" | "incomplete";
  pixel_verdict?: string;
  expected_pixel_verdict?: string;
  exit_code: null;
}

export interface G6pResult {
  checks: Gate6Check[];
  legs: Record<string, G6pLegEntry>;
  matrix: {
    report_path: string | null;
    scenario_summary: Record<string, string>;
  };
}

async function buildTopLevel(matrixDir: string, setDir: string): Promise<void> {
  const input = await readJson<ProvenanceInput>(
    join(matrixDir, "provenance-input.json"),
  );
  await writeFile(
    join(setDir, "run.json"),
    JSON.stringify({
      id: `g6p/${Date.now()}`,
      started_utc: new Date().toISOString(),
      runner: "run-gate6.sh --legs g6p",
      args: ["--legs", "g6p"],
      git: gitInfo(),
    }),
  );
  const calibration = input?.calibration
    ? await readJson<{
        engine?: { version_string?: string };
        slots?: Record<string, number>;
        calibrator?: { version?: string };
      }>(input.calibration)
    : undefined;
  // Any streaming scenario's first repeat's receiver provenance speaks for the whole report
  // (every receiver here is the same committed project, same rendering method).
  let adapter: { vendor?: string; name?: string; api_version?: string } = {};
  let renderingMethod = "gl_compatibility";
  for (const scn of G6P_SCENARIOS) {
    if (scn.receivers.length === 0) continue;
    const perf = await readJson<{
      rendering_method?: string;
      adapter?: { vendor?: string; name?: string; api_version?: string };
    }>(join(matrixDir, scn.id, "1", scn.receivers[0].dir, "perf.json"));
    if (perf?.adapter?.name) {
      adapter = perf.adapter;
      renderingMethod = perf.rendering_method ?? renderingMethod;
      break;
    }
  }
  await writeFile(
    join(setDir, "provenance.json"),
    JSON.stringify({
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
      receiver: {
        project_sha256: input?.receiver_project_sha256 ?? "unknown",
        rendering_method: renderingMethod,
        adapter: {
          vendor: adapter.vendor ?? "",
          name: adapter.name ?? "",
          api_version: adapter.api_version ?? "",
        },
      },
      protocol: "render-stream/6",
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
        receiver_clock: "Time.get_ticks_usec",
        rates_clock: "host",
        screenshots: "outside-measured-window",
        hook_log: "off",
      },
    }),
  );
}

export async function runGate6p(out: string): Promise<G6pResult> {
  const matrixDir = join(out, G6P_DIR);
  const setDir = join(matrixDir, "report-set");
  const checks: Gate6Check[] = [];
  const legs: Record<string, G6pLegEntry> = {};
  const scenarioSummary: Record<string, string> = {};
  const afterWindowProblems: string[] = [];
  const exitProblems: string[] = [];
  let deltasPath: string | undefined;

  for (const scn of G6P_SCENARIOS) {
    const scenarioDir = join(matrixDir, scn.id);
    const reportScenarioDir = join(setDir, "scenarios", scn.id);
    await mkdir(join(reportScenarioDir, "warmup"), { recursive: true });
    await writeFile(
      join(reportScenarioDir, "warmup", "repeat.json"),
      JSON.stringify({ run_dir: join(scenarioDir, "warmup") }),
    );
    const meta = buildMeta(scn, scenarioDir);
    await writeFile(join(reportScenarioDir, "meta.json"), JSON.stringify(meta));

    let written = 0;
    const summaryBits: string[] = [];
    for (let i = 1; i <= G6P_REPEATS; i++) {
      const label = String(i);
      const repeatDir = join(scenarioDir, label);
      let repeat: ReportRepeat & { unavailable?: string[] };
      if (scn.arm === "unarmed") {
        repeat = await unarmedRepeatOf(repeatDir);
        if (i === 1 && repeat.rates.host_frame.value != null)
          summaryBits.push(
            `host_frame ${repeat.rates.host_frame.value.toFixed(1)}/s`,
          );
        const hostExit = await readExitCode(join(repeatDir, "host"));
        if (hostExit !== 0)
          exitProblems.push(`${scn.id}/${label} host: exit ${hostExit}`);
      } else {
        const def = toG6cLeg(scn, label);
        const ev: G6cLegEvidence = await loadG6cLeg(scenarioDir, def);
        const m = measureLeg(ev);
        repeat = repeatOf(ev, m);
        if (i === 1) {
          summaryBits.push(`host_frame ${fmt(m.host_frame)}/s`);
          const published = m.conns[0]?.published;
          if (published !== undefined)
            summaryBits.push(`published ${fmt(published)}/s`);
        }
        if (ev.host_exit !== 0)
          exitProblems.push(`${scn.id}/${label} host: exit ${ev.host_exit}`);
        for (const r of ev.receivers) {
          if (r.exit !== 0)
            exitProblems.push(
              `${scn.id}/${label} ${r.dir.split("/").pop()}: exit ${r.exit}`,
            );
        }
        if (scn.receivers.length > 0) {
          const f = await finalLatestState(ev);
          if (f.problems.length > 0)
            afterWindowProblems.push(
              `${scn.id}/${label}: ${f.problems.join("; ")}`,
            );
        }
        if (scn.id === G6P_DELTAS_SCENARIO && i === 1) {
          deltasPath = join(repeatDir, "host", "evidence", "resources.jsonl");
        }
      }
      await mkdir(join(reportScenarioDir, `repeat-${i}`), { recursive: true });
      await writeFile(
        join(reportScenarioDir, `repeat-${i}`, "repeat.json"),
        JSON.stringify(repeat),
      );
      written++;
    }
    legs[scn.id] = {
      group: "g6p",
      scenario_id: scn.id,
      arm: scn.arm,
      repeats_written: written,
      expected_class: "measured",
      result_class: written === G6P_REPEATS ? "measured" : "incomplete",
      exit_code: null,
    };
    scenarioSummary[scn.id] = summaryBits.join(", ") || "(no summary)";
  }

  await buildTopLevel(matrixDir, setDir);

  checks.push(
    check(
      "clean-exit",
      "every host and receiver process of every repeat exited 0 (a schema-valid repeat can still carry mostly-unavailable fields from a crashed process, so this is the matrix's own crash detector)",
      exitProblems,
      exitProblems.length === 0 ? "every process exited 0" : "",
      [matrixDir],
    ),
  );

  checks.push(
    check(
      "after-window-shots",
      "every streaming scenario's repeat final shot equals the reference's step 11, whole frame, budget 0",
      afterWindowProblems,
      afterWindowProblems.length === 0
        ? "0 px differ on every repeat with a receiver"
        : "",
      [matrixDir],
    ),
  );

  // A missing deltas input must never fail the whole matrix report -- buildReport's own
  // parseHookLog reads it eagerly, so an absent file (G6P_DELTAS_SCENARIO did not run, or wrote
  // no resources.jsonl for any reason) would otherwise abort every scenario's build, not just
  // D15's optimizations block.
  let deltasProblem: string | null = null;
  if (deltasPath) {
    try {
      await access(deltasPath);
    } catch {
      deltasProblem = `${G6P_DELTAS_SCENARIO}: no resources.jsonl at ${deltasPath}; optimizations will be null`;
      deltasPath = undefined;
    }
  } else {
    deltasProblem = `${G6P_DELTAS_SCENARIO} did not write a repeat-1 host/evidence directory; optimizations will be null`;
  }

  checks.push(
    check(
      "deltas-input",
      `${G6P_DELTAS_SCENARIO}'s repeat-1 resources.jsonl feeds analyze-deltas.ts (D15)`,
      deltasProblem ? [deltasProblem] : [],
      deltasPath ?? "",
      deltasPath ? [deltasPath] : [],
    ),
  );

  let reportPath: string | null = null;
  let validateProblems: string[] = [];
  let scenarioIds: string[] = [];
  try {
    const built = await buildReport(setDir, { repeats: 5, deltasPath });
    scenarioIds = built.scenarios.map((s) => s.id);
    validateProblems = validate(built, { repeats: 5 });
    reportPath = join(out, "render-stream-report.json");
    await writeFile(reportPath, `${JSON.stringify(built, null, 2)}\n`);

    checks.push(
      check(
        "report-valid",
        "the matrix's render-stream-report/1 validates (schema plus internal consistency)",
        validateProblems,
        `${built.scenarios.length} scenarios, 5 repeats each, valid`,
        [reportPath],
      ),
    );

    const missing = G6P_SCENARIOS.filter((s) => !scenarioIds.includes(s.id));
    checks.push(
      check(
        "report-complete",
        "every Q7g scenario is present with five repeats and a discarded warmup",
        missing.length > 0
          ? [`missing: ${missing.map((s) => s.id).join(", ")}`]
          : [],
        `${scenarioIds.length}/${G6P_SCENARIOS.length} scenarios present`,
        [reportPath],
      ),
    );

    const findings: string[] = [];
    const brokenAggregate: string[] = [];
    for (const rs of built.scenarios) {
      if (!rs.aggregate) {
        brokenAggregate.push(rs.id);
        continue;
      }
      for (const [path, entry] of Object.entries(rs.aggregate)) {
        if (entry.cov > 0.1)
          findings.push(
            `${rs.id} ${path}: CoV ${(entry.cov * 100).toFixed(1)}%`,
          );
      }
    }
    checks.push(
      check(
        "repeat-stability",
        "every scenario's per-metric CoV across its 5 repeats is recorded; any above 10% is named here, never silently averaged",
        brokenAggregate.map((id) => `${id}: no aggregate block`),
        findings.length > 0
          ? `${findings.length} metric(s) above 10% CoV: ${findings.slice(0, 25).join("; ")}${findings.length > 25 ? "; ..." : ""}`
          : "every metric's CoV is <= 10% on every scenario",
        [reportPath],
      ),
    );
  } catch (error) {
    checks.push(
      check(
        "report-valid",
        "the matrix's render-stream-report/1 validates (schema plus internal consistency)",
        [`build failed: ${String(error)}`],
        "",
        [setDir],
      ),
    );
    checks.push(
      check(
        "report-complete",
        "every Q7g scenario is present with five repeats and a discarded warmup",
        ["report build failed, see report-valid"],
        "",
        [setDir],
      ),
    );
    checks.push(
      check(
        "repeat-stability",
        "every scenario's per-metric CoV across its 5 repeats is recorded; any above 10% is named here, never silently averaged",
        ["report build failed, see report-valid"],
        "",
        [setDir],
      ),
    );
  }

  return {
    checks,
    legs,
    matrix: { report_path: reportPath, scenario_summary: scenarioSummary },
  };
}

function fmt(v: number | null | undefined, d = 1): string {
  return v === null || v === undefined ? "?" : v.toFixed(d);
}
