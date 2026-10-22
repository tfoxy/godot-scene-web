#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for G7p (lib/gate7p-checks.ts, lib/gate7p-device.ts, render-stream-report/2 in
// lib/render-stream-report.ts), driven with synthetic values only. Each check has a passing case and
// the failing case a sabotage would produce:
//
//  1. report-valid: a complete /2 report validates; each of these breaks it, naming the rule: no
//     provenance.env, a native receiver with a browser block, a wrong receiver_clock, gpu_complete
//     "measured" on the web export, presented measured, a missing /2 stage, a device row built on
//     another bundle (stale-build, D28), a device row without env.device, an invalid repeat averaged
//     into its row's summary, and an unknown schema.
//  2. report-complete: g7pScenarios lists Q12's matrix per kind and window (window 2: scene-rate-60
//     only; native has no hd or constrained scenario).
//  3. repeat-stability: covFindings names every metric above 10 % CoV, and a scenario with no
//     aggregate is a failure.
//  4. device-rows-present: deviceRowProblems passes a complete g31 set; fails on a missing row, a
//     missing control row (pace, scene), a wrong build sha, a missing env.device block, and when every
//     row was omitted; an omission that names a missing row satisfies it.
//  5. lib/gate7p-device.ts: the Q13b watchdog marks hidden time, a rAF gap over 250 ms and a warm phone
//     invalid; loadDeviceRows takes rows from a g7v-summary.json, builds env.device from the legs, pairs
//     the control run, and omits and names a row whose build is not the report's.
//  6. after-window-shots: bandedFinalState passes an identical shot, and fails a shot of a frame before
//     step 11 and one with a pixel beyond Q7's band.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";

import {
  covFindings,
  deviceRowProblems,
  g7pScenarios,
  histDist,
} from "../lib/gate7p-checks";
import { loadDeviceRows, watchdogReason } from "../lib/gate7p-device";
import { bandedFinalState } from "../lib/gate7r-checks";
import {
  aggregate,
  type DeviceRow,
  deviceRowSummary,
  type ReportRepeat,
  validate,
} from "../lib/render-stream-report";

let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

const distOf = (status = "measured", p50 = 10) => ({
  status,
  unit: "us",
  count: status === "measured" ? 100 : 0,
  min: status === "measured" ? p50 : 0,
  p50: status === "measured" ? p50 : 0,
  p95: status === "measured" ? p50 : 0,
  p99: status === "measured" ? p50 : 0,
  max: status === "measured" ? p50 : 0,
  mean: status === "measured" ? p50 : 0,
  source: status === "measured" ? "x" : null,
});

type Kind = "native" | "web-export" | "gsw-canvas";

function repeat(kind: Kind, jitter = 0): Record<string, unknown> {
  const rate = (v: number) => ({
    value: v + jitter,
    unit: "1/s",
    status: "measured",
    source: "x",
    reason: null,
  });
  const rates: Record<string, unknown> = {};
  for (const k of [
    "requested",
    "host_frame",
    "published",
    "received",
    "applied",
    "submitted",
    "receiver_frame",
  ])
    rates[k] = rate(60);
  rates.presented = {
    value: null,
    unit: "1/s",
    status: "unavailable",
    source: null,
    reason: "x",
  };
  const stages: Record<string, unknown> = {};
  for (const k of [
    "host_frame_interval_us",
    "host_callback_us",
    "snapshot_us",
    "diff_us",
    "encode_us",
    "enqueue_us",
    "texture_copy_us",
    "texture_hash_us",
    "mesh_copy_us",
    "mesh_hash_us",
    "shader_copy_us",
    "param_decode_us",
    "http_serve_us",
    "recv_decode_us",
    "recv_apply_us",
    "recv_upload_us",
    "recv_fetch_us",
    "recv_frame_interval_us",
  ])
    stages[k] = distOf("measured", 100 + jitter);
  stages.credit_rtt_us = {
    applied: distOf("not-applicable"),
    submitted: distOf("measured"),
  };
  stages.staleness_us = { submitted: distOf("measured") };
  stages.recv_gpu_render_ms = distOf("unavailable");
  stages.recv_raf_interval_us = distOf("measured", 16700);
  stages.recv_raf_after_submit_us = distOf("unavailable");
  stages.recv_gpu_complete_us =
    kind === "gsw-canvas" ? distOf("measured", 17000) : distOf("unavailable");
  stages.recv_hold_us = distOf("measured", 900);
  stages.recv_preflight_us = distOf("unavailable");
  const zeros = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, 0]));
  return {
    run_dir: "/x",
    window_s: 20,
    rates,
    stages,
    startup: null,
    cpu: zeros([
      "host_main_thread_s",
      "host_io_thread_s",
      "host_process_s",
      "receiver_process_s",
    ]),
    queues: zeros([
      "max_in_flight",
      "max_pending",
      "pending_episodes",
      "max_pending_age_us",
      "coalesced",
      "ticks_credit_blocked",
      "max_queued_bytes",
    ]),
    bytes: {
      transaction: distOf("measured", 500),
      ...zeros(["wire_bytes_per_s", "resource_bytes", "http_bytes", "fetches"]),
    },
    resources: zeros([
      "host_retained_max",
      "host_retained_bytes_max",
      "host_pins_max",
      "recv_cache_entries_max",
      "recv_cache_bytes_max",
      "recv_evictions",
      "recv_rids_max",
      "recv_texture_mem_max",
      "recv_video_mem_max",
      "recv_pipeline_compilations",
    ]),
    memory: zeros([
      "host_rss_start",
      "host_rss_end",
      "host_rss_slope_bytes_per_min",
      "host_vmhwm",
      "recv_rss_start",
      "recv_rss_end",
      "recv_rss_slope_bytes_per_min",
      "recv_vmhwm",
    ]),
  };
}

const BUNDLE = "a".repeat(64);
const devBlock = {
  model: "moto g31",
  androidRelease: "12",
  chrome: "Chrome/154",
};

function deviceRepeat(run: number, drawn = 55): Record<string, unknown> {
  return {
    run,
    stages: { drawn_hz: drawn },
    phase_class: null,
    device: { hidden_ms: 0, max_raf_gap_ms: 40 },
    startup: null,
  };
}

function row(
  workload: string,
  window: 1 | 2,
  kind: Kind = "gsw-canvas",
  extra: Partial<DeviceRow> = {},
): DeviceRow {
  const repeats = [1, 2, 3, 4, 5].map((r) =>
    deviceRepeat(r),
  ) as unknown as DeviceRow["repeats"];
  return {
    device_id: "g31",
    receiver_kind: kind as "gsw-canvas",
    credit_window: window,
    workload,
    env: { kind: "device", device_id: "g31", device: devBlock, panel: null },
    build: { bundle_sha256: BUNDLE, source: "x" },
    repeats,
    summary: deviceRowSummary(repeats),
    control:
      workload === "hd"
        ? null
        : {
            env: {
              kind: "desktop",
              device_id: null,
              device: null,
              panel: null,
            },
            repeats,
          },
    ...extra,
  };
}

function report(
  kind: Kind,
  rows: DeviceRow[] = [],
  omitted: unknown[] = [],
): Record<string, unknown> {
  const reps = [0, 0, 0, 0, 0].map(
    () => repeat(kind) as unknown as ReportRepeat,
  );
  const browser = kind !== "native";
  return {
    schema: "render-stream-report/2",
    run: {
      id: "x",
      started_utc: "x",
      runner: "x",
      args: [],
      git: { commit: "c", dirty: false },
    },
    provenance: {
      engine: { version_string: "v", sha256: "e", template: "linux_release" },
      capture: { library_sha256: "l", calibrator_version: 1, hooks_planned: 1 },
      receiver: {
        project_sha256: "p",
        rendering_method: "gl_compatibility",
        adapter: { vendor: "v", name: "n", api_version: "a" },
        kind,
        browser: browser
          ? {
              product: "Chromium",
              version: "148",
              revision: "chromium-1223",
              sha256: "s",
              args: [],
              renderer: "ANGLE",
              extensions_hash: "h",
            }
          : null,
        bundle: browser ? { sha256: BUNDLE, bytes: 10 } : null,
      },
      protocol: "render-stream/7",
      host: {
        cpu_model: "c",
        logical_cpus: 12,
        ram_bytes: 1,
        kernel: "k",
        cpu_governor: null,
      },
      display: { compositor: "gamescope", version: "3", sizes: [[640, 360]] },
      timing: {
        host_clock: "steady_clock",
        receiver_clock: browser ? "performance.now" : "Time.get_ticks_usec",
        rates_clock: "host",
        screenshots: "outside-measured-window",
        hook_log: "off",
      },
      env: { kind: "desktop", device_id: null, device: null, panel: null },
    },
    scenarios: [
      {
        id: "scene-rate-60",
        fixture: "gate6-scene",
        variant: "animate",
        arm: "streaming",
        resolution: { logical: [640, 360], presentation: [640, 360] },
        profile: {
          rendering_method: "gl_compatibility",
          msaa_2d: 0,
          hdr_2d: false,
          stretch: {
            mode: "disabled",
            aspect: "ignore",
            scale_mode: "fractional",
          },
          font_oversampling: 1,
        },
        config: {
          target_fps: 60,
          host_max_fps: 60,
          receiver_max_fps: 0,
          credit_stage: "submitted",
          transport: "loopback",
          cache: browser ? "warm-http" : "warm",
          delivery: "http",
          connections: 1,
          time: "realtime",
          receiver_kind: kind,
          credit_window: 1,
          late_poll: false,
          fetch_concurrency: 1,
        },
        warmup: { run_dir: "/w", discarded: true },
        repeats: reps,
        aggregate: aggregate(reps),
      },
    ],
    optimizations: null,
    device_rows: rows,
    omitted_device_rows: omitted,
  };
}

const has = (errs: string[], re: RegExp) => errs.some((e) => re.test(e));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// 1. report-valid
const okRows = [row("pace", 1), row("scene", 1), row("hd", 1)];
expect(
  "report/2: gsw with device rows validates",
  validate(report("gsw-canvas", okRows), { repeats: 5 }).length === 0,
  validate(report("gsw-canvas", okRows), { repeats: 5 }).join("; "),
);
expect(
  "report/2: native validates",
  validate(report("native"), { repeats: 5 }).length === 0,
  validate(report("native"), { repeats: 5 }).join("; "),
);
expect(
  "report/2: web validates",
  validate(report("web-export"), { repeats: 5 }).length === 0,
  validate(report("web-export"), { repeats: 5 }).join("; "),
);
{
  const r = clone(report("gsw-canvas")) as any;
  delete r.provenance.env;
  expect(
    "report/2 sabotage: no provenance.env",
    has(validate(r, { repeats: 5 }), /env-entry: provenance\.env/),
  );
}
{
  const r = clone(report("native")) as any;
  r.provenance.receiver.browser = { product: "x" };
  expect(
    "report/2 sabotage: native with a browser block",
    has(validate(r, { repeats: 5 }), /native receiver has browser: null/),
  );
}
{
  const r = clone(report("web-export")) as any;
  r.provenance.timing.receiver_clock = "Time.get_ticks_usec";
  expect(
    "report/2 sabotage: browser with the engine clock",
    has(validate(r, { repeats: 5 }), /receiver_clock/),
  );
}
{
  const r = clone(report("web-export")) as any;
  for (const s of r.scenarios[0].repeats)
    s.stages.recv_gpu_complete_us = distOf("measured", 5);
  expect(
    "report/2 sabotage: gpu_complete measured on the web export",
    has(
      validate(r, { repeats: 5 }),
      /gpu_complete fence exists only for gsw-canvas/,
    ),
  );
}
{
  const r = clone(report("gsw-canvas")) as any;
  r.scenarios[0].repeats[0].rates.presented = {
    value: 59,
    unit: "1/s",
    status: "measured",
    source: "x",
    reason: null,
  };
  expect(
    "report/2 sabotage: presented measured",
    validate(r, { repeats: 5 }).length > 0,
  );
}
{
  const r = clone(report("gsw-canvas")) as any;
  delete r.scenarios[0].repeats[2].stages.recv_hold_us;
  expect(
    "report/2 sabotage: missing /2 stage",
    has(validate(r, { repeats: 5 }), /recv_hold_us is missing/),
  );
}
{
  const r = clone(
    report("gsw-canvas", [
      row("pace", 1, "gsw-canvas", {
        build: { bundle_sha256: "b".repeat(64), source: "x" },
      }),
    ]),
  ) as any;
  expect(
    "report/2 sabotage: device row from another bundle",
    has(validate(r, { repeats: 5 }), /stale-build/),
  );
}
{
  const bad = row("pace", 1);
  (bad.env as any).device = null;
  expect(
    "report/2 sabotage: device row without env.device",
    has(
      validate(report("gsw-canvas", [bad]) as never, { repeats: 5 }),
      /device row|env.device is missing/,
    ),
  );
}
{
  const bad = row("pace", 1);
  (bad.repeats[0] as any).invalid = { reason: "rAF gap 289 ms" };
  // summary still counts it as valid: it was averaged in
  expect(
    "report/2 sabotage: invalid repeat averaged in",
    has(
      validate(report("gsw-canvas", [bad]) as never, { repeats: 5 }),
      /invalid-averaged/,
    ),
  );
  bad.summary = deviceRowSummary(bad.repeats);
  expect(
    "report/2: an invalid repeat is carried and excluded",
    validate(report("gsw-canvas", [bad]) as never, { repeats: 5 }).length ===
      0 &&
      bad.summary.invalid_repeats === 1 &&
      bad.summary.valid_repeats === 4,
  );
}
{
  const r = clone(report("gsw-canvas")) as any;
  r.schema = "render-stream-report/3";
  expect(
    "report/2 sabotage: unknown schema",
    has(validate(r, { repeats: 5 }), /bad-schema/),
  );
}
{
  const r = clone(report("gsw-canvas")) as any;
  r.schema = "render-stream-report/1";
  delete r.device_rows;
  delete r.omitted_device_rows;
  delete r.provenance.env;
  for (const s of r.scenarios[0].repeats)
    for (const k of [
      "recv_raf_interval_us",
      "recv_raf_after_submit_us",
      "recv_gpu_complete_us",
      "recv_hold_us",
      "recv_preflight_us",
    ])
      delete s.stages[k];
  r.scenarios[0].aggregate = aggregate(r.scenarios[0].repeats);
  expect(
    "report/1 still validates (validate accepts both)",
    validate(r, { repeats: 5 }).length === 0,
    validate(r, { repeats: 5 }).join("; "),
  );
}

// 1b. GSW's summary-form histograms: G6c's bucket reader would report p50 0
{
  const d = histDist(
    { count: 10, min: 1, max: 9, mean: 4, p50: 3, p95: 8 },
    "us",
    "perf.json",
  );
  expect(
    "histDist: a summary keeps its p50 and p95 (never 0)",
    d.status === "measured" && d.p50 === 3 && d.p95 === 8,
    JSON.stringify(d),
  );
  expect(
    "histDist: a summary's p99 is its p95, and the source says so",
    d.p99 === 8 && /p99 is reported as p95/.test(d.source ?? ""),
  );
  expect(
    "histDist: a summary dist validates as measured (finite fields, source)",
    d.count === 10 && typeof d.source === "string",
  );
  expect(
    "histDist: an empty histogram is unavailable",
    histDist({ count: 0 }, "us", "x").status === "unavailable",
  );
  expect(
    "histDist: a bucket histogram goes through G6c's reader",
    histDist(
      { count: 4, min: 100, max: 100, mean: 100, buckets: [[100, 4]] },
      "us",
      "x",
    ).p50 > 0,
  );
}

// 2. report-complete
{
  const ids = (k: "native" | "web" | "gsw", w: (1 | 2)[]) =>
    g7pScenarios(k, w).map((s) => s.id);
  expect(
    "matrix: native window 1 has no hd or constrained",
    ids("native", [1]).join() ===
      "scene-rate-15,scene-rate-30,scene-rate-60,scene-rate-uncapped-host60,scene-rate-60-cold",
  );
  expect(
    "matrix: web window 1 adds hd native/half and constrained",
    ids("web", [1]).slice(5).join() ===
      "hd-native-rate-60,hd-half-rate-60,scene-constrained-60",
  );
  expect(
    "matrix: window 2 is scene-rate-60 only, suffixed",
    ids("gsw", [2]).join() === "scene-rate-60-w2",
  );
  expect(
    "matrix: native receivers run at 60, browsers rAF-bound",
    g7pScenarios("native", [1])[0].base.receivers[0].max_fps === 60 &&
      g7pScenarios("gsw", [1])[0].base.receivers[0].max_fps === 0,
  );
}

// 3. repeat-stability
{
  const reps = [0, 1, 2, 3, 4].map(
    (i) => repeat("gsw-canvas", i * 30) as unknown as ReportRepeat,
  );
  const steady = [0, 0, 0, 0, 0].map(
    () => repeat("gsw-canvas") as unknown as ReportRepeat,
  );
  const f = covFindings([
    { id: "noisy", aggregate: aggregate(reps) } as never,
    { id: "steady", aggregate: aggregate(steady) } as never,
    { id: "none", aggregate: null } as never,
  ]);
  expect(
    "stability: a noisy scenario's metrics are named with their CoV",
    f.named.some((n) => /^noisy rates\.published\.value: CoV \d+\.\d%/.test(n)),
    f.named.slice(0, 2).join("; "),
  );
  expect(
    "stability: a steady scenario names nothing",
    !f.named.some((n) => n.startsWith("steady ")),
  );
  expect(
    "stability: a scenario with no aggregate fails",
    f.broken.length === 1 && /none: no aggregate/.test(f.broken[0]),
  );
}

// 4. device-rows-present
{
  const all = [1, 2].flatMap((w) =>
    ["pace", "scene", "hd"].map((wl) => row(wl, w as 1 | 2)),
  );
  const rep = (rows: DeviceRow[], omitted: unknown[] = []) =>
    ({
      provenance: (report("gsw-canvas") as any).provenance,
      device_rows: rows,
      omitted_device_rows: omitted,
    }) as never;
  expect(
    "device rows: complete set passes",
    deviceRowProblems(rep(all), "gsw", [1, 2]).problems.length === 0,
    deviceRowProblems(rep(all), "gsw", [1, 2]).problems.join("; "),
  );
  expect(
    "device rows sabotage: missing row",
    deviceRowProblems(rep(all.slice(1)), "gsw", [1, 2]).problems.some((p) =>
      /w?1? ?pace|window 1 pace: neither a row nor an omission/.test(p),
    ),
  );
  const named = deviceRowProblems(
    rep(all.slice(1), [
      {
        device_id: "g31",
        receiver_kind: "gsw-canvas",
        credit_window: 1,
        workload: "pace",
        build_sha256: "b",
        reason: "older build",
      },
    ]),
    "gsw",
    [1, 2],
  );
  expect(
    "device rows: an omission that names the row satisfies it",
    named.problems.length === 0 && /omitted and named/.test(named.detail),
    named.problems.join("; "),
  );
  const noCtl = all.map((r, i) => (i === 0 ? { ...r, control: null } : r));
  expect(
    "device rows sabotage: no desktop control row",
    deviceRowProblems(rep(noCtl), "gsw", [1, 2]).problems.some((p) =>
      /no desktop control row/.test(p),
    ),
  );
  const stale = all.map((r, i) =>
    i === 1
      ? { ...r, build: { bundle_sha256: "c".repeat(64), source: "x" } }
      : r,
  );
  expect(
    "device rows sabotage: build differs from the report's",
    deviceRowProblems(rep(stale), "gsw", [1, 2]).problems.some((p) =>
      /is not the report's/.test(p),
    ),
  );
  const noEnv = all.map((r, i) =>
    i === 2 ? { ...r, env: { ...r.env, device: null } } : r,
  );
  expect(
    "device rows sabotage: no env.device block",
    deviceRowProblems(rep(noEnv), "gsw", [1, 2]).problems.some((p) =>
      /no env.device block/.test(p),
    ),
  );
  const allOmitted = ["pace", "scene", "hd"].flatMap((wl) =>
    [1, 2].map((w) => ({
      device_id: "g31",
      receiver_kind: "gsw-canvas",
      credit_window: w,
      workload: wl,
      build_sha256: "b",
      reason: "older build",
    })),
  );
  expect(
    "device rows sabotage: every row omitted fails (the build moved)",
    deviceRowProblems(rep([], allOmitted), "gsw", [1, 2]).problems.some((p) =>
      /re-run the g31 rows/.test(p),
    ),
  );
  const wrongDev = all.map((r, i) =>
    i === 0 ? { ...r, device_id: "g86" as never } : r,
  );
  expect(
    "device rows sabotage: wrong device_id",
    deviceRowProblems(rep(wrongDev), "gsw", [1, 2]).problems.some((p) =>
      /device_id g86/.test(p),
    ),
  );
}

// 5. gate7p-device
expect(
  "watchdog: clean repeat",
  watchdogReason(
    {
      hidden_ms: 0,
      max_raf_gap_ms: 150,
      thermal_before: "none",
      thermal_after: "none",
    },
    true,
  ) === null,
);
expect(
  "watchdog: hidden time",
  /hidden 40 ms/.test(
    watchdogReason({ hidden_ms: 40, max_raf_gap_ms: 20 }, true) ?? "",
  ),
);
expect(
  "watchdog: rAF gap over 250 ms",
  /rAF gap 289 ms/.test(
    watchdogReason({ hidden_ms: 0, max_raf_gap_ms: 289 }, true) ?? "",
  ),
);
expect(
  "watchdog: a warm phone",
  /thermal_after light/.test(
    watchdogReason(
      {
        hidden_ms: 0,
        max_raf_gap_ms: 20,
        thermal_before: "none",
        thermal_after: "light",
      },
      true,
    ) ?? "",
  ),
);
expect(
  "watchdog: a desktop control is not judged on thermals",
  watchdogReason(
    { hidden_ms: 0, max_raf_gap_ms: 20, thermal_after: null },
    false,
  ) === null,
);

const tmp = await mkdtemp(join(tmpdir(), "g7p-self-"));
try {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  async function leg(
    dir: string,
    name: string,
    sha: string,
    window: number,
  ): Promise<void> {
    const r = join(
      dir,
      "gate6",
      `dev-g31-gsw-w${window}`,
      "rates",
      name,
      "receiver",
    );
    await mkdir(r, { recursive: true });
    await writeFile(
      join(r, "page-config.json"),
      JSON.stringify({
        url: `http://x/gsw-bundle/receiver.html?env=${b64({ env: { RS_RECEIVER_BUILD_SHA256: sha, RS_RECEIVER_CREDIT_WINDOW: String(window) } })}`,
      }),
    );
    await writeFile(
      join(r, "provenance.json"),
      JSON.stringify({
        facts: {
          serial: "S",
          model: "moto g31",
          manufacturer: "motorola",
          androidRelease: "12",
          chromeVersion: "Chrome/154",
          conditions: { batteryPct: 100, thermalStatus: "none" },
          page: { innerWidth: 828, innerHeight: 330, devicePixelRatio: 2.625 },
        },
      }),
    );
    await writeFile(
      join(r, "device.json"),
      JSON.stringify({
        isolation: "browser-context",
        conditions_before: { batteryPct: 100, thermalStatus: "none" },
        conditions_after: { batteryPct: 100, thermalStatus: "none" },
      }),
    );
  }
  const srow = (
    leg_: string,
    run: number,
    window: number,
    extra: Record<string, unknown> = {},
  ) => ({
    provenance_env: {
      kind: leg_.startsWith("ctl") ? "desktop" : "device",
      device_id: leg_.startsWith("ctl") ? null : "g31",
      panel: { raf_interval_p50_us: 17000, mode_hz: 59, mode_source: "raf" },
    },
    receiver_kind: "gsw-canvas",
    credit_window: window,
    leg: leg_,
    run,
    stages: { drawn_hz: 55 },
    phase_class: null,
    device: {
      hidden_ms: 0,
      max_raf_gap_ms: 40,
      thermal_before: "none",
      thermal_after: "none",
      ...extra,
    },
    startup: null,
  });
  const dev = join(tmp, "g7v-dev");
  const ctl = join(tmp, "g7v-ctl");
  await mkdir(dev, { recursive: true });
  await mkdir(ctl, { recursive: true });
  const rows = [1, 2, 3].map((r) =>
    srow("dev-g31:pace", r, 1, r === 3 ? { max_raf_gap_ms: 289 } : {}),
  );
  rows.push(srow("dev-g31:startup-warm", 1, 1) as never);
  await writeFile(
    join(dev, "g7v-summary.json"),
    JSON.stringify({ schema: "x", device_rows: rows }),
  );
  for (let r = 1; r <= 3; r++) await leg(dev, `dev-pace-r${r}`, BUNDLE, 1);
  await writeFile(
    join(ctl, "g7v-summary.json"),
    JSON.stringify({ schema: "x", device_rows: [srow("ctl:pace", 1, 1)] }),
  );
  const loaded = await loadDeviceRows([dev, ctl], () => BUNDLE);
  const lr = loaded.rows[0];
  expect(
    "loadDeviceRows: one row, device g31, env.device from the legs",
    loaded.rows.length === 1 &&
      lr.device_id === "g31" &&
      (lr.env.device as any)?.model === "moto g31" &&
      (lr.env.device as any)?.viewport === "828x330@2.625",
    JSON.stringify(loaded.rows.map((r) => r.env)),
  );
  expect(
    "loadDeviceRows: build sha taken from the legs",
    lr.build.bundle_sha256 === BUNDLE,
  );
  expect(
    "loadDeviceRows: the watchdog repeat is invalid and not averaged",
    lr.repeats[2].invalid !== undefined &&
      lr.summary.valid_repeats === 2 &&
      lr.summary.invalid_repeats === 1,
  );
  expect(
    "loadDeviceRows: the desktop control row is paired",
    lr.control?.env.kind === "desktop" && lr.control.repeats.length === 1,
  );
  expect(
    "loadDeviceRows: startup legs are not rows",
    loaded.startup.length === 1 &&
      loaded.rows.every((r) => !r.workload.startsWith("startup")),
  );
  const other = await loadDeviceRows(
    [dev, ctl],
    () => "d".repeat(64),
    "g31",
    "web-export",
  );
  expect(
    "loadDeviceRows: rows of another receiver kind are neither shown nor reported omitted",
    other.rows.length === 0 && other.omitted.length === 0,
    JSON.stringify(other.omitted),
  );
  const moved = await loadDeviceRows([dev, ctl], () => "d".repeat(64));
  expect(
    "loadDeviceRows sabotage: a moved build omits and names the row (D28)",
    moved.rows.length === 0 &&
      moved.omitted.length === 1 &&
      /older build/.test(moved.omitted[0].reason) &&
      moved.omitted[0].build_sha256 === BUNDLE,
    JSON.stringify(moved.omitted),
  );

  // 6. after-window-shots
  async function png(path: string, perturb?: number): Promise<void> {
    const w = 8,
      h = 8;
    const buf = Buffer.alloc(w * h * 4, 100);
    for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
    if (perturb) buf[0] += perturb;
    await mkdir(join(path, ".."), { recursive: true });
    await sharp(buf, { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toFile(path);
  }
  const shotDir = join(tmp, "shots");
  await png(join(shotDir, "ref.png"));
  await png(join(shotDir, "receiver", "shots", "final-same.png"));
  await png(join(shotDir, "receiver", "shots", "final-off.png"), 40);
  const ev = (shot: string, frame: number) =>
    ({
      steps: [{ step: 11, applied_frame: 500 }],
      reference_shot: join(shotDir, "ref.png"),
      receivers: [
        {
          dir: join(shotDir, "receiver"),
          applied: { shots: [{ final: true, path: shot, frame, seq: 9 }] },
        },
      ],
    }) as never;
  expect(
    "after-window-shots: an identical final shot passes",
    (await bandedFinalState(ev("final-same.png", 520), 0)).problems.length ===
      0,
  );
  expect(
    "after-window-shots sabotage: a shot of a frame before step 11 fails",
    (await bandedFinalState(ev("final-same.png", 400), 0)).problems.some((p) =>
      /before step 11/.test(p),
    ),
  );
  expect(
    "after-window-shots sabotage: a pixel beyond Q7's band fails",
    (await bandedFinalState(ev("final-off.png", 520), 0)).problems.some((p) =>
      /beyond Q7's band/.test(p),
    ),
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`self-test-gate7p: ${failures} failure(s)`);
  process.exit(1);
}
console.log("self-test-gate7p: all passed");
