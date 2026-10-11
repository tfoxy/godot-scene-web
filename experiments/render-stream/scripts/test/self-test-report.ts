#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for G6t's measurement tooling (../../protocol/gate6-design.md "G6t"): the
// render-stream-report/1 schema and validator (../lib/render-stream-report.ts), the throttle
// proxy (../throttle-proxy.ts), the /proc sampler (../lib/proc-sampler.ts), provenance helpers
// (../lib/provenance.ts) and the deltas analyzer (../analyze-deltas.ts), plus a build+validate
// round trip through ../report-gate6.ts.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-report.ts
//
// 1. A fabricated passing render-stream-report/1 (one scenario, five repeats) validates clean,
//    then one perturbation per `validate()` rule each fails with its expected code.
// 2. aggregate() computed by hand against five known values (median/min/max/cov), and a metric
//    with one unavailable repeat dropped from the result entirely.
// 3. The throttle proxy measured against a real loopback echo: a saturating stream stays within
//    5% of its configured rate; discrete low-rate messages stay within 2ms of its configured
//    delay (both read from the proxy's own stats.json, loopback-only, two live TCP servers).
// 4. The /proc sampler against a real spawned child process: VmRSS > 0, at least one thread, and
//    its one thread's CPU time increases after it does CPU work.
// 5. provenance.ts's host probe and sha256File against a real temp file.
// 6. analyze-deltas.ts against fabricated resources.jsonl lines: hash-at-publish supersession,
//    mesh region-update deltas (exact, no estimation), texture whole-equals-delta, and parameter
//    bytes per frame.
// 7. report-gate6.ts's build() assembling a report from a fabricated run-set directory that then
//    validates clean.
//
// Exits non-zero if any assertion fails.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeParamBytesPerFrame,
  analyzeResourceDeltas,
  analyzeSupersededVersions,
  computeOptimizations,
  type DeltaHookLine,
  parseHookLog,
} from "../analyze-deltas";
import { readProcStatus, readTaskStats, sampleOnce } from "../lib/proc-sampler";
import { probeHostProvenance, sha256File } from "../lib/provenance";
import {
  aggregate,
  type RenderStreamReport,
  type ReportDist,
  type ReportProvenance,
  type ReportRate,
  type ReportRepeat,
  validate,
} from "../lib/render-stream-report";
import { buildReport } from "../report-gate6";
import { startThrottleProxy, THROTTLE_PROFILES } from "../throttle-proxy";

let assertions = 0;
let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  assertions++;
  if (ok) console.log(`[SELF-TEST OK] ${name}`);
  else {
    failures++;
    console.error(`[SELF-TEST FAIL] ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ======================================================================================
// 1-2. render-stream-report/1: validate() and aggregate()
// ======================================================================================

function measuredRate(value: number, source = "perf.json"): ReportRate {
  return { value, unit: "1/s", status: "measured", source, reason: null };
}
function unavailableRate(reason: string): ReportRate {
  return {
    value: null,
    unit: "1/s",
    status: "unavailable",
    source: null,
    reason,
  };
}
function measuredDist(p50: number, source = "perf.json"): ReportDist {
  return {
    status: "measured",
    unit: "us",
    count: 100,
    min: p50 * 0.5,
    p50,
    p95: p50 * 1.5,
    p99: p50 * 1.8,
    max: p50 * 2,
    mean: p50,
    source,
  };
}
function naDist(
  status: "unavailable" | "not-applicable" = "not-applicable",
): ReportDist {
  return {
    status,
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

function makeRepeat(seed: number): ReportRepeat {
  return {
    run_dir: `artifacts/render-stream/gate6/fake/repeat-${seed}`,
    window_s: 20,
    rates: {
      requested: measuredRate(60),
      host_frame: measuredRate(60 + seed * 0.01),
      published: measuredRate(60),
      received: measuredRate(60),
      applied: measuredRate(60),
      submitted: measuredRate(60),
      receiver_frame: measuredRate(60),
      presented: unavailableRate("no-presentation-feedback"),
    },
    stages: {
      host_frame_interval_us: measuredDist(16600 + seed),
      host_callback_us: measuredDist(500 + seed),
      snapshot_us: measuredDist(50),
      diff_us: measuredDist(20),
      encode_us: measuredDist(30),
      enqueue_us: measuredDist(5),
      texture_copy_us: measuredDist(10),
      texture_hash_us: measuredDist(10),
      mesh_copy_us: measuredDist(5),
      mesh_hash_us: measuredDist(5),
      shader_copy_us: measuredDist(2),
      param_decode_us: measuredDist(1),
      http_serve_us: measuredDist(100),
      credit_rtt_us: {
        applied: measuredDist(2000),
        submitted: measuredDist(2500),
      },
      staleness_us: { submitted: measuredDist(3000) },
      recv_decode_us: measuredDist(200),
      recv_apply_us: measuredDist(300),
      recv_upload_us: measuredDist(400),
      recv_fetch_us: measuredDist(500),
      recv_frame_interval_us: measuredDist(16600),
      recv_gpu_render_ms: naDist(),
    },
    cpu: {
      host_main_thread_s: 5 + seed * 0.01,
      host_io_thread_s: 1,
      host_process_s: 6,
      receiver_process_s: 6,
    },
    queues: {
      max_in_flight: 1,
      max_pending: 1,
      pending_episodes: 0,
      max_pending_age_us: 1000,
      coalesced: 0,
      ticks_credit_blocked: 0,
      max_queued_bytes: 2000,
    },
    bytes: {
      transaction: measuredDist(4000),
      wire_bytes_per_s: 240_000,
      resource_bytes: 1000,
      http_bytes: 500,
      fetches: 2,
    },
    resources: {
      host_retained_max: 10,
      host_retained_bytes_max: 100_000,
      host_pins_max: 5,
      recv_cache_entries_max: 10,
      recv_cache_bytes_max: 100_000,
      recv_evictions: 0,
      recv_rids_max: 20,
      recv_texture_mem_max: 1_000_000,
      recv_video_mem_max: 2_000_000,
      recv_pipeline_compilations: 3,
    },
    memory: {
      host_rss_start: 50_000_000,
      host_rss_end: 50_100_000,
      host_rss_slope_bytes_per_min: 10,
      host_vmhwm: 51_000_000,
      recv_rss_start: 40_000_000,
      recv_rss_end: 40_050_000,
      recv_rss_slope_bytes_per_min: 5,
      recv_vmhwm: 41_000_000,
    },
  };
}

function makeHeadlessProvenance(): ReportProvenance {
  return {
    engine: {
      version_string: "Godot v4.5.1.stable",
      sha256: "a".repeat(64),
      template: "linux_release",
    },
    capture: {
      library_sha256: "b".repeat(64),
      calibrator_version: 9,
      hooks_planned: 79,
    },
    receiver: {
      project_sha256: "c".repeat(64),
      rendering_method: "gl_compatibility",
      adapter: { vendor: "", name: "", api_version: "" },
    },
    protocol: "render-stream/6",
    host: {
      cpu_model: "fake cpu",
      logical_cpus: 8,
      ram_bytes: 16_000_000_000,
      kernel: "fake",
      cpu_governor: null,
    },
    display: {
      compositor: "gamescope",
      version: "3.16.19",
      sizes: [[640, 360]],
    },
    timing: {
      host_clock: "steady_clock",
      receiver_clock: "Time.get_ticks_usec",
      rates_clock: "host",
      screenshots: "outside-measured-window",
      hook_log: "off",
    },
  };
}

function makeReport(): RenderStreamReport {
  const repeats = [1, 2, 3, 4, 5].map(makeRepeat);
  return {
    schema: "render-stream-report/1",
    run: {
      id: "fake-run",
      started_utc: "2026-10-11T00:00:00Z",
      runner: "self-test-report",
      args: [],
      git: { commit: "0".repeat(40), dirty: false },
    },
    provenance: makeHeadlessProvenance(),
    scenarios: [
      {
        id: "gate6-scene-streaming-60",
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
            aspect: "keep",
            scale_mode: "fractional",
          },
          font_oversampling: 1,
        },
        config: {
          target_fps: 60,
          host_max_fps: 60,
          receiver_max_fps: 60,
          credit_stage: "applied",
          transport: "loopback",
          cache: "warm",
          delivery: "websocket",
          connections: 1,
          time: "realtime",
        },
        warmup: {
          run_dir: "artifacts/render-stream/gate6/fake/warmup",
          discarded: true,
        },
        repeats,
        aggregate: aggregate(repeats),
      },
    ],
    optimizations: null,
  };
}

function reportCases(): void {
  const good = makeReport();
  const goodErrors = validate(good);
  assert(
    "a fabricated report validates clean",
    goodErrors.length === 0,
    goodErrors.join(" | "),
  );

  const failsWith = (name: string, broken: unknown, code: string) => {
    const errors = validate(broken);
    assert(
      `${name} fails with ${code}`,
      errors.some((e) => e.startsWith(`${code}:`)),
      errors.length === 0 ? "no errors reported" : errors.join(" | "),
    );
  };

  const badSchema = clone(good);
  (badSchema as unknown as { schema: string }).schema =
    "render-stream-report/0";
  failsWith("bad schema string", badSchema, "bad-schema");

  const noRunId = clone(good);
  (noRunId.run as unknown as { id: string }).id = "";
  failsWith("missing run.id", noRunId, "run-entry");

  const fourRepeats = clone(good);
  fourRepeats.scenarios[0].repeats = fourRepeats.scenarios[0].repeats.slice(
    0,
    4,
  );
  failsWith("only 4 repeats", fourRepeats, "repeat-count");

  const warmupNotDiscarded = clone(good);
  (
    warmupNotDiscarded.scenarios[0].warmup as unknown as { discarded: boolean }
  ).discarded = false;
  failsWith("warmup.discarded false", warmupNotDiscarded, "scenario-entry");

  const presentedMeasured = clone(good);
  presentedMeasured.scenarios[0].repeats[0].rates.presented = measuredRate(60);
  failsWith("presented reported as measured", presentedMeasured, "rate-entry");

  const gpuMeasuredOnHeadless = clone(good);
  gpuMeasuredOnHeadless.scenarios[0].repeats[0].stages.recv_gpu_render_ms =
    measuredDist(5);
  failsWith(
    "recv_gpu_render_ms measured on a headless receiver",
    gpuMeasuredOnHeadless,
    "dist-entry",
  );

  const nullButMeasured = clone(good);
  nullButMeasured.scenarios[0].repeats[0].rates.host_frame = {
    value: null,
    unit: "1/s",
    status: "measured",
    source: "x",
    reason: null,
  };
  failsWith(
    "rate value null but status measured",
    nullButMeasured,
    "rate-entry",
  );

  const badMemory = clone(good);
  (
    nullButMeasured.scenarios[0].repeats[0].memory as unknown as {
      host_rss_start: unknown;
    }
  ).host_rss_start = "x";
  (
    badMemory.scenarios[0].repeats[0].memory as unknown as {
      host_rss_start: unknown;
    }
  ).host_rss_start = "lots";
  failsWith("memory field not a number", badMemory, "memory-entry");

  const badAggregate = clone(good);
  badAggregate.scenarios[0].aggregate["rates.host_frame.value"] = {
    median: -1,
    min: -1,
    max: -1,
    cov: -1,
  };
  failsWith(
    "aggregate does not match a fresh recomputation",
    badAggregate,
    "aggregate-mismatch",
  );

  const badOptimizations = clone(good);
  (badOptimizations as unknown as { optimizations: unknown }).optimizations = {
    schema: "nope",
  };
  failsWith(
    "optimizations has the wrong schema",
    badOptimizations,
    "optimizations-entry",
  );
}

function aggregateCases(): void {
  const repeats = [1, 2, 3, 4, 5].map((seed) => {
    const r = makeRepeat(seed);
    r.rates.host_frame = measuredRate(seed); // 1,2,3,4,5
    return r;
  });
  const agg = aggregate(repeats);
  const entry = agg["rates.host_frame.value"];
  assert(
    "aggregate median of 1..5 is 3",
    entry !== undefined && entry.median === 3,
    JSON.stringify(entry),
  );
  assert("aggregate min of 1..5 is 1", entry?.min === 1);
  assert("aggregate max of 1..5 is 5", entry?.max === 5);
  // sample stdev of [1..5] is sqrt(2.5) ~= 1.58114; mean 3; cov ~= 0.52705
  assert(
    "aggregate cov of 1..5 is ~0.527",
    entry !== undefined && close(entry.cov, 0.52705, 1e-3),
    String(entry?.cov),
  );

  const withOneUnavailable = [1, 2, 3, 4, 5].map((seed) => {
    const r = makeRepeat(seed);
    r.rates.host_frame =
      seed === 3 ? unavailableRate("flaky") : measuredRate(seed);
    return r;
  });
  const agg2 = aggregate(withOneUnavailable);
  assert(
    "a metric unavailable in any one repeat is dropped from aggregate entirely",
    agg2["rates.host_frame.value"] === undefined,
  );
}

// ======================================================================================
// 3. throttle-proxy.ts, measured against real loopback servers
// ======================================================================================

async function throttleProxyRateCase(): Promise<void> {
  const chunk = Buffer.alloc(16384, 7);
  const echo = createServer((sock) => {
    sock.on("data", () => {});
    const timer = setInterval(() => {
      if (!sock.destroyed) sock.write(chunk);
    }, 5);
    sock.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const echoPort = (echo.address() as { port: number }).port;

  const handle = await startThrottleProxy({
    targetHost: "127.0.0.1",
    targetPort: echoPort,
    profile: THROTTLE_PROFILES.constrained,
  });
  const client = netConnect({ host: "127.0.0.1", port: handle.port });
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  client.on("data", () => {});
  await new Promise((r) => setTimeout(r, 4000));
  client.destroy();
  const stats = await handle.stop();
  echo.close();

  const target = THROTTLE_PROFILES.constrained.rateBytesPerSec;
  const ratio = stats.server_to_client.achieved_bytes_per_s / target;
  assert(
    "throttle proxy achieved rate is within 5% of the configured constrained rate",
    ratio >= 0.95 && ratio <= 1.05,
    `achieved ${stats.server_to_client.achieved_bytes_per_s} B/s vs target ${target} B/s (ratio ${ratio.toFixed(3)})`,
  );
}

async function throttleProxyDelayCase(): Promise<void> {
  const echo = createServer((sock) =>
    sock.on("data", (chunk) => sock.write(chunk)),
  );
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const echoPort = (echo.address() as { port: number }).port;

  const handle = await startThrottleProxy({
    targetHost: "127.0.0.1",
    targetPort: echoPort,
    profile: THROTTLE_PROFILES.constrained,
  });
  const client = netConnect({ host: "127.0.0.1", port: handle.port });
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  client.on("data", () => {});
  // Small, infrequent messages: well under the token bucket's rate, so the measured latency
  // isolates the fixed delay rather than queueing behind a saturated bucket.
  for (let i = 0; i < 20; i++) {
    client.write(Buffer.from([i]));
    await new Promise((r) => setTimeout(r, 120));
  }
  await new Promise((r) => setTimeout(r, 200));
  client.destroy();
  const stats = await handle.stop();
  echo.close();

  const delayMs = THROTTLE_PROFILES.constrained.delayMs;
  assert(
    "throttle proxy client->server latency is within 2ms of the configured delay",
    stats.client_to_server.latency_ms.count > 0 &&
      close(stats.client_to_server.latency_ms.mean_ms, delayMs, 2),
    JSON.stringify(stats.client_to_server.latency_ms),
  );
  assert(
    "throttle proxy server->client latency is within 2ms of the configured delay",
    stats.server_to_client.latency_ms.count > 0 &&
      close(stats.server_to_client.latency_ms.mean_ms, delayMs, 2),
    JSON.stringify(stats.server_to_client.latency_ms),
  );
}

// ======================================================================================
// 4. proc-sampler.ts against a real child process
// ======================================================================================

async function procSamplerCase(): Promise<void> {
  // The contract's own wording (Q7f's "Checks"): "the sampler reads its own process." A spawned
  // child (below) is the stronger test -- it lets CPU time be driven up by known work -- but this
  // covers the literal case too.
  const self = sampleOnce(process.pid);
  assert(
    "sampleOnce reads this very process (its own pid, positive VmRSS, at least one thread)",
    self.status.pid === process.pid &&
      self.status.vmRssBytes > 0 &&
      self.threadCpu.length >= 1,
    JSON.stringify(self.status),
  );

  const child = spawn(process.execPath, [
    "-e",
    "const start = Date.now(); while (Date.now() - start < 1500) { Math.sqrt(Math.random()); }",
  ]);
  await new Promise((r) => setTimeout(r, 200)); // let it actually start running

  const status = readProcStatus(child.pid as number);
  assert(
    "readProcStatus reads a positive VmRSS for a real child",
    status.vmRssBytes > 0,
    String(status.vmRssBytes),
  );
  assert(
    "readProcStatus reports at least one thread",
    status.threads >= 1,
    String(status.threads),
  );

  const before = readTaskStats(child.pid as number);
  const beforeCpu = before.reduce((a, t) => a + t.cpuSeconds, 0);
  await new Promise((r) => setTimeout(r, 900));
  const after = readTaskStats(child.pid as number);
  const afterCpu = after.reduce((a, t) => a + t.cpuSeconds, 0);
  assert(
    "a busy child's total thread CPU time increases over ~900ms of work",
    afterCpu > beforeCpu,
    `before ${beforeCpu}s after ${afterCpu}s`,
  );

  const sample = sampleOnce(child.pid as number);
  assert(
    "sampleOnce returns a status and thread list together",
    sample.status.pid === child.pid && sample.threadCpu.length >= 1,
  );

  child.kill();
  await new Promise((r) => setTimeout(r, 100));
}

// ======================================================================================
// 5. provenance.ts
// ======================================================================================

async function provenanceCases(tmpDir: string): Promise<void> {
  const host = probeHostProvenance();
  assert(
    "probeHostProvenance reports at least one logical cpu",
    host.logical_cpus > 0,
    String(host.logical_cpus),
  );
  assert(
    "probeHostProvenance reports positive ram_bytes",
    host.ram_bytes > 0,
    String(host.ram_bytes),
  );
  assert(
    "probeHostProvenance reports a non-empty kernel string",
    host.kernel.length > 0,
  );

  const file = join(tmpDir, "hash-me.txt");
  await writeFile(file, "render-stream g6t\n");
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256")
    .update("render-stream g6t\n")
    .digest("hex");
  const got = sha256File(file);
  assert(
    "sha256File matches an independently computed digest",
    got === expected,
    `${got} vs ${expected}`,
  );
  assert(
    "sha256File returns 64 lowercase hex chars",
    /^[0-9a-f]{64}$/.test(got),
    got,
  );
}

// ======================================================================================
// 6. analyze-deltas.ts against fabricated resources.jsonl lines
// ======================================================================================

function deltaLines(): void {
  const lines: DeltaHookLine[] = [
    // texture id 1: two version-creating ops, both same frame (0) -> the first is superseded.
    {
      frame: 0,
      op: "texture_2d_create",
      kind: "texture",
      id: 1,
      version: 1,
      payload_bytes: 1000,
      hash_ns: 50,
      copy_ns: 20,
    },
    {
      frame: 0,
      op: "texture_2d_update",
      kind: "texture",
      id: 1,
      version: 2,
      payload_bytes: 1000,
      hash_ns: 55,
      copy_ns: 22,
    },
    // a later, separate-frame update: not superseded.
    {
      frame: 10,
      op: "texture_2d_update",
      kind: "texture",
      id: 1,
      version: 3,
      payload_bytes: 1000,
      hash_ns: 60,
      copy_ns: 25,
    },
    // an omitted sabotage line must not count as a version-creating op at all.
    {
      frame: 10,
      op: "texture_2d_update",
      kind: "texture",
      id: 1,
      version: 3,
      payload_bytes: 1000,
      omitted: true,
    },
    // mesh id 1: a create with no byte size, then two region updates with an exact delta.
    { frame: 1, op: "mesh_add_surface", kind: "mesh", id: 1, version: 1 },
    {
      frame: 5,
      op: "mesh_surface_update_region",
      kind: "mesh",
      id: 1,
      version: 2,
      buffer: "vertex",
      offset: 0,
      bytes: 100,
    },
    {
      frame: 8,
      op: "mesh_surface_update_region",
      kind: "mesh",
      id: 1,
      version: 3,
      buffer: "vertex",
      offset: 0,
      bytes: 100,
    },
    // material param lines: one with a real byte size, one with only an element count.
    {
      frame: 2,
      op: "material_set_param",
      kind: "material",
      id: 1,
      param: "tint",
      payload_bytes: 16,
    },
    {
      frame: 2,
      op: "material_set_param",
      kind: "material",
      id: 1,
      param: "count",
      n: 1,
    },
    {
      frame: 3,
      op: "material_set_param",
      kind: "material",
      id: 1,
      param: "tint",
      payload_bytes: 16,
    },
  ];

  const superseded = analyzeSupersededVersions(lines);
  assert(
    "one texture version is superseded within a frame",
    superseded.texture?.superseded_versions === 1,
    JSON.stringify(superseded.texture),
  );
  assert(
    "the superseded version's own bytes/hash_ns/copy_ns are summed, not the later one's",
    superseded.texture?.superseded_payload_bytes === 1000 &&
      superseded.texture?.superseded_hash_ns === 50 &&
      superseded.texture?.superseded_copy_ns === 20,
    JSON.stringify(superseded.texture),
  );
  assert(
    "mesh has no same-frame supersession in this fixture",
    superseded.mesh !== undefined && superseded.mesh.superseded_versions === 0,
    JSON.stringify(superseded.mesh),
  );

  const deltas = analyzeResourceDeltas(lines);
  assert(
    "texture: delta equals whole (no partial update path), savings 0",
    deltas.texture?.whole_version_bytes_total === 3000 &&
      deltas.texture?.delta_bytes_total === 3000 &&
      deltas.texture?.delta_bytes_available === false &&
      deltas.texture?.savings_bytes === 0,
    JSON.stringify(deltas.texture),
  );
  assert(
    "mesh: whole bytes unavailable (no payload_bytes ever logged), delta is the exact region sum",
    deltas.mesh?.whole_version_bytes_available === false &&
      deltas.mesh?.whole_version_bytes_total === null &&
      deltas.mesh?.delta_bytes_total === 200 &&
      deltas.mesh?.delta_bytes_available === true &&
      deltas.mesh?.savings_bytes === null,
    JSON.stringify(deltas.mesh),
  );
  assert(
    "mesh has exactly one resource and three version-creating ops",
    deltas.mesh?.resources === 1 && deltas.mesh?.version_creating_ops === 3,
  );

  const params = analyzeParamBytesPerFrame(lines);
  assert(
    "param bytes per frame sums frame 2 (16 bytes + 1 element) and frame 3 (16 bytes)",
    params.frames === 2 && params.total === 33 && params.unit === "mixed",
    JSON.stringify(params),
  );

  const optimizations = computeOptimizations(lines);
  assert(
    "computeOptimizations merges superseded + delta data per kind",
    optimizations.by_kind.texture?.superseded_versions === 1 &&
      optimizations.by_kind.mesh?.delta_bytes_total === 200,
    JSON.stringify(optimizations.by_kind),
  );
  assert(
    "computeOptimizations carries param_bytes_per_frame through",
    optimizations.param_bytes_per_frame.total === 33,
  );

  const parsed = parseHookLog('{"a":1}\nnot json\n{"b":2}\n\n');
  assert(
    "parseHookLog parses two good lines and skips one bad one",
    parsed.lines.length === 2 && parsed.skipped === 1,
    JSON.stringify(parsed),
  );
}

// ======================================================================================
// 7. report-gate6.ts build() + validate() round trip
// ======================================================================================

async function buildReportCase(tmpDir: string): Promise<void> {
  const runSet = join(tmpDir, "run-set");
  await mkdir(join(runSet, "scenarios", "s1"), { recursive: true });
  await writeFile(
    join(runSet, "run.json"),
    JSON.stringify({
      id: "r1",
      started_utc: "2026-10-11T00:00:00Z",
      runner: "self-test-report",
      args: [],
      git: { commit: "0".repeat(40), dirty: false },
    }),
  );
  await writeFile(
    join(runSet, "provenance.json"),
    JSON.stringify(makeHeadlessProvenance()),
  );

  const good = makeReport();
  const scenario = good.scenarios[0];
  await writeFile(
    join(runSet, "scenarios", "s1", "meta.json"),
    JSON.stringify({ ...scenario, repeats: undefined, aggregate: undefined }),
  );
  await mkdir(join(runSet, "scenarios", "s1", "warmup"), { recursive: true });
  await writeFile(
    join(runSet, "scenarios", "s1", "warmup", "repeat.json"),
    JSON.stringify({ run_dir: "warmup" }),
  );
  for (let i = 1; i <= 5; i++) {
    await mkdir(join(runSet, "scenarios", "s1", `repeat-${i}`), {
      recursive: true,
    });
    await writeFile(
      join(runSet, "scenarios", "s1", `repeat-${i}`, "repeat.json"),
      JSON.stringify(scenario.repeats[i - 1]),
    );
  }

  const built = await buildReport(runSet);
  const errors = validate(built);
  assert(
    "report-gate6 build() assembles a report that validates clean",
    errors.length === 0,
    errors.join(" | "),
  );
  assert(
    "the built scenario's aggregate was computed, not left empty",
    Object.keys(built.scenarios[0].aggregate).length > 0,
  );
}

// ======================================================================================

async function main(): Promise<void> {
  reportCases();
  aggregateCases();
  deltaLines();
  await throttleProxyRateCase();
  await throttleProxyDelayCase();
  await procSamplerCase();

  const tmpDir = await mkdtemp(join(tmpdir(), "rs-g6t-selftest-"));
  try {
    await provenanceCases(tmpDir);
    await buildReportCase(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  console.log(
    `\nself-test-report: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
