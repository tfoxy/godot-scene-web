// Self-test for gate 6 group g6p (lib/gate6p-checks.ts, sample-rate.ts), driven from
// self-test-gate6.ts's main: the matrix's scenario registry, the `unarmed` arm's wall-clock slope
// and its bespoke repeat builder, each with a passing and a failing case.
//
//  1. G6P_SCENARIOS: Q7g's 20 scenarios, unique ids, counted per fixture/presentation, exactly one
//     with hook_log "on" (D15's input) and one dual-receiver scenario.
//  2. slopeFramesPerSecond: a clean 60 fps step log gives ~60; fewer than two points, and a flat
//     (zero-slope) log, both refuse with a reason instead of fabricating a rate.
//  3. unarmedRepeatOf: with a wall-rate.json present, rates.host_frame is measured from it and
//     every receiver-dependent field is not-applicable/unavailable; without one, host_frame is
//     unavailable with wall-rate.json's own reason. Both repeats validate inside a minimal
//     render-stream-report/1 scenario.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  G6P_DELTAS_SCENARIO,
  G6P_SCENARIOS,
  unarmedRepeatOf,
} from "../lib/gate6p-checks";
import {
  aggregate,
  type ReportRepeat,
  validate,
} from "../lib/render-stream-report";
import { slopeFramesPerSecond } from "../sample-rate";
import type { SelfTestHooks } from "./self-test-gate6l";

function minimalReport(repeats: unknown[]): unknown {
  const repeat = {
    run_dir: "/x",
    window_s: 20,
    rates: Object.fromEntries(
      [
        "requested",
        "host_frame",
        "published",
        "received",
        "applied",
        "submitted",
        "receiver_frame",
      ].map((k) => [
        k,
        {
          value: null,
          unit: "1/s",
          status: "not-applicable",
          source: null,
          reason: "x",
        },
      ]),
    ),
    stages: {},
    cpu: {
      host_main_thread_s: 0,
      host_io_thread_s: 0,
      host_process_s: 0,
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
      transaction: {
        status: "not-applicable",
        unit: "bytes",
        count: 0,
        min: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        max: 0,
        mean: 0,
        source: null,
      },
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
      host_rss_start: 0,
      host_rss_end: 0,
      host_rss_slope_bytes_per_min: 0,
      host_vmhwm: 0,
      recv_rss_start: 0,
      recv_rss_end: 0,
      recv_rss_slope_bytes_per_min: 0,
      recv_vmhwm: 0,
    },
  };
  for (const dist of [
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
    "recv_gpu_render_ms",
  ]) {
    (repeat.stages as Record<string, unknown>)[dist] = {
      status: "not-applicable",
      unit: "us",
      count: 0,
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      mean: 0,
      source: null,
    };
  }
  const naDist = {
    status: "not-applicable",
    unit: "us",
    count: 0,
    min: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    max: 0,
    mean: 0,
    source: null,
  };
  (repeat.stages as Record<string, unknown>).credit_rtt_us = {
    applied: naDist,
    submitted: naDist,
  };
  (repeat.stages as Record<string, unknown>).staleness_us = {
    submitted: naDist,
  };
  const merged = repeats.map(
    (r) => ({ ...repeat, ...(r as object) }) as unknown as ReportRepeat,
  );
  return {
    schema: "render-stream-report/1",
    run: {
      id: "x",
      started_utc: new Date().toISOString(),
      runner: "self-test",
      args: [],
      git: { commit: "x", dirty: false },
    },
    provenance: {
      engine: { sha256: "x", template: "linux_release" },
      capture: { library_sha256: "x", calibrator_version: 9 },
      receiver: {
        project_sha256: "x",
        rendering_method: "gl_compatibility",
        adapter: {},
      },
      protocol: "render-stream/6",
      host: { logical_cpus: 1, ram_bytes: 1 },
      display: { compositor: "gamescope" },
      timing: { hook_log: "off" },
    },
    scenarios: [
      {
        id: "scene-unarmed",
        fixture: "gate6-scene",
        variant: "animate",
        arm: "unarmed",
        warmup: { run_dir: "/x/warmup", discarded: true },
        repeats: merged,
        aggregate: merged.length === 5 ? aggregate(merged) : null,
      },
    ],
    optimizations: null,
  };
}

export async function selfTestGate6p(hooks: SelfTestHooks): Promise<void> {
  const { assert } = hooks;

  // 1. The scenario registry.
  const ids = G6P_SCENARIOS.map((s) => s.id);
  assert(
    "g6p G6P_SCENARIOS: 20 scenarios, unique ids",
    ids.length === 20 && new Set(ids).size === 20,
    `${ids.length} scenarios, ${new Set(ids).size} unique`,
  );
  assert(
    "g6p G6P_SCENARIOS: 11 on gate6-scene, 8 gate6-hd native, 1 gate6-hd half",
    G6P_SCENARIOS.filter((s) => s.fixture === "gate6-scene").length === 11 &&
      G6P_SCENARIOS.filter(
        (s) => s.fixture === "gate6-hd" && s.presentation === "native",
      ).length === 8 &&
      G6P_SCENARIOS.filter(
        (s) => s.fixture === "gate6-hd" && s.presentation === "half",
      ).length === 1,
  );
  assert(
    "g6p G6P_SCENARIOS: exactly one hook_log=on scenario, matching G6P_DELTAS_SCENARIO",
    G6P_SCENARIOS.filter((s) => s.hook_log === "on").length === 1 &&
      G6P_SCENARIOS.find((s) => s.hook_log === "on")?.id ===
        G6P_DELTAS_SCENARIO,
  );
  assert(
    "g6p G6P_SCENARIOS: exactly one dual-receiver scenario",
    G6P_SCENARIOS.filter((s) => s.receivers.length === 2).length === 1,
  );
  assert(
    "g6p G6P_SCENARIOS: exactly two unarmed and two armed-idle (no receiver, every fixture)",
    G6P_SCENARIOS.filter((s) => s.arm === "unarmed").length === 2 &&
      G6P_SCENARIOS.filter((s) => s.arm === "armed-idle").length === 2 &&
      G6P_SCENARIOS.filter((s) => s.arm !== "streaming").every(
        (s) => s.receivers.length === 0,
      ),
  );

  // 2. slopeFramesPerSecond.
  const clean = Array.from({ length: 10 }, (_, i) => ({
    t_ms: i * 1000,
    step: i + 1,
    frame: 6 + i * 60,
  }));
  const good = slopeFramesPerSecond(clean);
  assert(
    "g6p slopeFramesPerSecond: a clean 60 fps step log gives ~60/s",
    good.rate !== null && Math.abs(good.rate - 60) < 1,
    `rate ${good.rate}`,
  );
  const tooFew = slopeFramesPerSecond([{ t_ms: 0, step: 1, frame: 6 }]);
  assert(
    "g6p slopeFramesPerSecond: fewer than two points refuses with a reason",
    tooFew.rate === null && !!tooFew.reason,
  );
  const flat = slopeFramesPerSecond([
    { t_ms: 1000, step: 1, frame: 6 },
    { t_ms: 1000, step: 2, frame: 66 },
  ]);
  assert(
    "g6p slopeFramesPerSecond: a zero-time span refuses with a reason, not Infinity",
    flat.rate === null && !!flat.reason,
  );

  // 3. unarmedRepeatOf.
  const dir = await mkdtemp(join(tmpdir(), "rs-g6p-selftest-"));
  try {
    const hostDir = join(dir, "measured", "host");
    await mkdir(hostDir, { recursive: true });
    await writeFile(
      join(hostDir, "wall-rate.json"),
      JSON.stringify({
        schema: "render-stream-wall-rate/1",
        host_frame_rate: 59.7,
        samples: 10,
        window_seconds: 9,
        reason: null,
        method: "test",
      }),
    );
    await writeFile(
      join(hostDir, "proc-samples.jsonl"),
      `${JSON.stringify({
        tsMs: 0,
        status: { vmRssBytes: 100_000_000, vmHwmBytes: 100_000_000 },
        threadCpu: [{ tid: 1, comm: "godot", cpuSeconds: 1.5 }],
      })}\n${JSON.stringify({
        tsMs: 1000,
        status: { vmRssBytes: 101_000_000, vmHwmBytes: 101_000_000 },
        threadCpu: [{ tid: 1, comm: "godot", cpuSeconds: 2.1 }],
      })}\n`,
    );
    const measured = await unarmedRepeatOf(join(dir, "measured"));
    assert(
      "g6p unarmedRepeatOf: host_frame measured from wall-rate.json",
      measured.rates.host_frame.status === "measured" &&
        measured.rates.host_frame.value === 59.7,
    );
    assert(
      "g6p unarmedRepeatOf: published/applied/receiver_frame are not-applicable (no receiver)",
      measured.rates.published.status === "not-applicable" &&
        measured.rates.applied.status === "not-applicable" &&
        measured.rates.receiver_frame.status === "not-applicable",
    );
    assert(
      "g6p unarmedRepeatOf: host CPU/RSS come from the /proc sampler, not zeroed",
      measured.cpu.host_process_s > 0 && measured.memory.host_rss_end > 0,
    );
    const r5 = minimalReport(Array.from({ length: 5 }, () => measured));
    const errors = validate(r5, { repeats: 5 });
    assert(
      "g6p unarmedRepeatOf: validates inside a minimal 5-repeat render-stream-report/1",
      errors.length === 0,
      errors.join(" | "),
    );

    const noWallRateDir = join(dir, "no-wall-rate", "host");
    await mkdir(noWallRateDir, { recursive: true });
    const missing = await unarmedRepeatOf(join(dir, "no-wall-rate"));
    assert(
      "g6p unarmedRepeatOf: no wall-rate.json -> host_frame unavailable with a reason, not a fabricated rate",
      missing.rates.host_frame.status === "unavailable" &&
        missing.rates.host_frame.value === null &&
        !!missing.rates.host_frame.reason,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
