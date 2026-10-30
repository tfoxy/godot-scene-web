// PHN (results/p3/phn.md): the render-stream client package as a REAL live viewer on a phone. The
// phone's Chrome (adb, the gate 7 device table's entry) opens web/client-phone/ -- a page that mounts
// @godot-scene-web/render-stream-client full screen at the device pixel ratio and nothing of the
// harness receiver -- served from this machine through `adb reverse`, against a live host on this
// machine (also reached through `adb reverse`). It is client-live-check.ts's phone edition, run the
// same way, as bench-live-scale.sh's host-only receiver:
//
//   RS_BENCH_PORT=<host port> RS_BENCH_PAGE_PORT=<page port> bash .../bench-live-scale.sh \
//     --extension EXT --receiver host-only --protocol 12 --window 2 --frames N --out OUT \
//     --rx-cmd 'mise exec -- pnpm exec tsx --conditions=development \
//       experiments/render-stream/scripts/client-device-check.ts --dir "$RS_BENCH_RX_DIR" \
//       --port "$RS_BENCH_PAGE_PORT" --ws "$RS_BENCH_WS_URL" --http "$RS_BENCH_HTTP_ORIGIN" \
//       --token-file "$RS_BENCH_TOKEN_FILE" --protocol 12 --window 2 --core <build-web.sh out> \
//       [--device g31] [--main-s 180] [--remounts 3] [--cycle-s 20] [--attrib-s 10] [--backing-scale 1] \
//       [--credit-stage submitted|applied] [--apply-on frame|message]' \
//     -- GRC_LIVE_AUTH=token
//
// --credit-stage and --apply-on (PH3, results/p3/ph3.md) pass the client's pacing options; omitted,
// the package's defaults.
//
// Mount 1 streams for --main-s after its first frame (the measured window: per-second stats(), the
// page probes of web/client-phone/probe.ts, cpufreq every 15 s; no dumpsys in the window), then the
// attribution windows of --attrib-s each, in order: the GL probe (every WebGL2 call timed), a CDP
// trace (renderer / GPU / browser process CPU), a CDP CPU profile. Then dispose and --remounts more
// mount/dispose cycles of --cycle-s each. After every dispose: two CDP `HeapProfiler.collectGarbage`
// passes and `dumpsys meminfo` of every Chrome renderer and the GPU process. Battery, temperature
// and thermal status before and after. The tab it opened is closed and every adb forward/reverse
// and session setting it made is undone on every exit path. Writes <dir>/client-device.json (and
// trace.json.gz, cpu-profile.json beside it). Checks (exit 1 when a gating one fails):
//   mounts-streamed     every mount drew its first frame and never reported `failed`
//   instance-released   each dispose dropped the page renderer's PSS by >= 80% of the instance's
//                       wasm heap
//   remount-no-growth   the page renderer's PSS after each dispose + GC within --tolerance of the
//                       first dispose's
//   heap-baseline       every mount's wasm heap starts at the first mount's
//   device-provenance   the tab's facts match the device table (model, GPU, orientation)
//   rate-60 (reported)  main-window applies/s >= 58 (the 60 fps bar at the g31's 58.8 Hz panel)

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  buildThreadIndex,
  computeCpu,
} from "../../../packages/perf-harness/src/analyze";
import {
  readTraceEvents,
  startTracing,
  stopTracing,
  traceCategoriesFor,
} from "../../../packages/perf-harness/src/trace";
import {
  checkDeviceProvenance,
  DEVICE_PAGE_FACTS_EXPRESSION,
  type DeviceId,
  type DevicePageFacts,
  HarnessServer,
  loadDeviceTable,
  openHarnessDevice,
} from "./lib/browser-harness";
import { readCpuFreqs } from "./lib/device-sampler";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const PAGE_DIR = join(HERE, "..", "web", "client-phone");

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    if (!a[i].startsWith("--") || a[i + 1] === undefined)
      throw new Error(`client-device-check: bad argument ${a[i]}`);
    out[a[i].slice(2)] = a[i + 1];
  }
  for (const k of ["dir", "port", "ws", "http"])
    if (!out[k]) throw new Error(`client-device-check: --${k} is required`);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

function pct(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function dist(xs: readonly number[]) {
  const mean = xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  const f = (v: number | null) => (v === null ? null : r2(v));
  return {
    n: xs.length,
    mean: f(mean),
    p50: f(pct(xs, 50)),
    p95: f(pct(xs, 95)),
    p99: f(pct(xs, 99)),
    max: f(xs.length ? xs.reduce((m, x) => (x > m ? x : m), -Infinity) : null),
  };
}

interface Stats {
  applied: number;
  appliesPerSec: number;
  creditRttMsP50: number | null;
  heapBytes: number;
  t: number;
}
interface Taken {
  frames: { a: number[]; b: number[]; dropped: number };
  frameGl: { a: number[]; b: number[]; dropped: number };
  messages: { a: number[]; b: number[]; dropped: number };
  fetches: { a: number[]; b: number[]; dropped: number };
  longTasks: { a: number[]; b: number[]; dropped: number };
}

/** The probes over one window: frame time, per-frame callback cost, receive and GET cost. */
function summarize(t: Taken, seconds: number) {
  const ts = t.frames.a;
  const intervals: number[] = [];
  for (let i = 1; i < ts.length; i++) intervals.push(ts[i] - ts[i - 1]);
  const tp = pct(intervals, 50) ?? 16.7;
  const bytes = t.messages.a.reduce((s, x) => s + x, 0);
  return {
    seconds,
    raf_per_s: r1(ts.length / seconds),
    frame_interval_ms: dist(intervals),
    frames_over_1_5_tp: intervals.filter((x) => x > 1.5 * tp).length,
    raf_callback_ms: dist(t.frames.b),
    raf_callback_busy_ms_per_s: r1(t.frames.b.reduce((s, x) => s + x, 0) / seconds),
    messages_per_s: r1(t.messages.a.length / seconds),
    message_kb_per_s: r1(bytes / 1024 / seconds),
    message_bytes: dist(t.messages.a),
    onmessage_ms: dist(t.messages.b),
    onmessage_busy_ms_per_s: r1(t.messages.b.reduce((s, x) => s + x, 0) / seconds),
    fetches: t.fetches.a.length,
    fetch_ms: dist(t.fetches.b),
    long_tasks: t.longTasks.a.length,
    long_task_ms: dist(t.longTasks.b),
    gl_ms_in_raf: t.frameGl.a.length ? dist(t.frameGl.a) : null,
    gl_calls_in_raf: t.frameGl.b.length ? dist(t.frameGl.b) : null,
    dropped: t.frames.dropped + t.messages.dropped,
  };
}

/** `dumpsys meminfo <pid>`: TOTAL PSS / TOTAL RSS (KiB) and the process name. */
function parseMeminfo(text: string) {
  const header = /\*\* MEMINFO in pid (\d+) \[([^\]]*)\]/.exec(text);
  const pss = /TOTAL PSS:\s*(\d+)/.exec(text);
  const rss = /TOTAL RSS:\s*(\d+)/.exec(text);
  const gl = /^\s*GL mtrack\s+(\d+)/m.exec(text);
  const egl = /^\s*EGL mtrack\s+(\d+)/m.exec(text);
  const native = /^\s*Native Heap\s+(\d+)/m.exec(text);
  const other = /^\s*Other mmap\s+(\d+)/m.exec(text);
  const unknown = /^\s*Unknown\s+(\d+)/m.exec(text);
  const mib = (m: RegExpExecArray | null) =>
    m ? r1(Number(m[1]) / 1024) : null;
  return {
    process: header?.[2] ?? null,
    pss_mib: mib(pss),
    rss_mib: mib(rss),
    native_heap_pss_mib: mib(native),
    gl_mtrack_mib: mib(gl),
    egl_mtrack_mib: mib(egl),
    other_mmap_pss_mib: mib(other),
    unknown_pss_mib: mib(unknown),
  };
}

/** CPU profile self time by function (and by kind: wasm, the glue, the package, V8's own rows). */
function profileSummary(profile: {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
  }[];
  samples: number[];
  timeDeltas: number[];
}) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  const kinds = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
    if (!n) continue;
    total += dt;
    const { functionName: f, url } = n.callFrame;
    const file = url.split("/").pop() ?? "";
    const key = `${f || "(anonymous)"} ${file}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    const kind =
      f.startsWith("(")
        ? f
        : url.endsWith(".wasm") || /^\$|wasm-function/.test(f) || url.startsWith("wasm://")
          ? "wasm"
          : file.startsWith("rs_gsw_wasm_client")
            ? "glue (wasm-bindgen JS, incl. its WebGL calls)"
            : file === "page.js"
              ? "page bundle (package + probes)"
              : `other ${file}`;
    kinds.set(kind, (kinds.get(kind) ?? 0) + dt);
  }
  const rows = (m: Map<string, number>, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => ({ name: k, ms: r1(v), share: r2(v / (total || 1)) }));
  return { total_ms: r1(total), by_kind: rows(kinds, 20), top_self: rows(self, 25) };
}

async function main(): Promise<number> {
  const a = args();
  const dir = resolve(a.dir);
  const deviceId = (a.device ?? "g31") as DeviceId;
  const mainS = Number(a["main-s"] ?? 180);
  const remounts = Number(a.remounts ?? 3);
  const cycleS = Number(a["cycle-s"] ?? 20);
  const attribS = Number(a["attrib-s"] ?? 10);
  const backingScale = Number(a["backing-scale"] ?? 1);
  const tolerance = Number(a.tolerance ?? 0.15);
  const protocol = Number(a.protocol ?? 12) as 11 | 12;
  const creditWindow = Number(a.window ?? 2) as 1 | 2;
  // PH3: the client's pacing options (omitted: the package's defaults).
  const creditStage = a["credit-stage"] as "submitted" | "applied" | undefined;
  const applyOn = a["apply-on"] as "frame" | "message" | undefined;
  const hostPort = Number(new URL(a.http).port);
  const staticDir = join(dir, "static");
  mkdirSync(join(staticDir, "core"), { recursive: true });

  let coreDir = a.core ? resolve(a.core) : join(dir, "core");
  if (!existsSync(join(coreDir, "build.json"))) {
    coreDir = join(dir, "core");
    execFileSync(
      "bash",
      [join(ROOT, "packages/render-stream-client/scripts/build-web.sh"), coreDir],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  }
  for (const f of ["build.json", "rs_gsw_wasm_bg.wasm", "rs_gsw_wasm_client.js"])
    copyFileSync(join(coreDir, f), join(staticDir, "core", f));
  const coreBuild = JSON.parse(readFileSync(join(coreDir, "build.json"), "utf8"));
  const expectedTree = execFileSync(
    "bash",
    [join(ROOT, "packages/render-stream-client/scripts/core-tree.sh"), ROOT],
    { encoding: "utf8" },
  ).trim();

  copyFileSync(join(PAGE_DIR, "index.html"), join(staticDir, "index.html"));
  const bundle = await build({
    entryPoints: [join(PAGE_DIR, "page.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"],
    outfile: join(staticDir, "page.js"),
    metafile: true,
    logLevel: "warning",
  });
  const inputs = Object.keys(bundle.metafile?.inputs ?? {});

  const table = loadDeviceTable();
  const entry = table[deviceId];
  if (!entry) throw new Error(`client-device-check: no device ${deviceId}`);
  const server = new HarnessServer({
    staticRoot: staticDir,
    evidenceRoot: join(dir, "evidence"),
    allowedLegNonces: [],
  });
  const { origin } = await server.start(Number(a.port));
  const report: Record<string, unknown> = {
    schema: "render-stream-client-device-check/1",
    device: deviceId,
    origin,
    ws: a.ws,
    protocol,
    credit_window: creditWindow,
    credit_stage: creditStage ?? "default",
    apply_on: applyOn ?? "default",
    backing_scale: backingScale,
    core_build: coreBuild,
    expected_tree: expectedTree,
    page_inputs: inputs.length,
    page_harness_inputs: inputs.filter((p) => p.includes("gsw-receiver/")),
    host_load_start: readFileSync("/proc/loadavg", "utf8").trim(),
  };
  const log = (m: string) => console.log(`client-device-check: ${m}`);
  const harness = await openHarnessDevice({
    id: deviceId,
    entry,
    serverPort: Number(a.port),
    extraReversePorts: [hostPort],
    onProgress: (m) => log(`device: ${m}`),
  });
  const browser = harness.browser;
  const client = browser.client;
  const adb = browser.adb;
  let lease: Awaited<ReturnType<typeof browser.targets.acquire>> | null = null;
  let code = 1;
  const mounts: Record<string, unknown>[] = [];
  report.mounts = mounts;
  try {
    report.conditions_before = await browser.conditions();
    report.cpufreq_before = await readCpuFreqs(adb, entry.cpu_clusters ?? []);
    const procsBefore = await client
      .send<{ processInfo: { type: string; id: number }[] }>(
        "SystemInfo.getProcessInfo",
        {},
        { flat: true, timeoutMs: 10_000 },
      )
      .then((r) => r.processInfo)
      .catch(() => []);
    lease = await browser.targets.acquire({
      width: entry.screen_css_px[0],
      height: entry.screen_css_px[1],
    });
    const ev = <T>(expr: string, timeoutMs = 20_000) =>
      client.evaluate<T>(expr, { timeoutMs });
    await client.send("Page.navigate", { url: `${origin}/index.html` });
    for (let i = 0; ; i++) {
      const ok = await ev<boolean>("!!(window.__rsc && window.__rsc.ready)").catch(() => false);
      if (ok) break;
      if (i > 150) throw new Error("the page never exposed __rsc");
      await sleep(200);
    }
    const facts = await harness.facts({
      evaluate: (e, o) => client.evaluate(e, o),
      facts: () => client.evaluate<DevicePageFacts>(DEVICE_PAGE_FACTS_EXPRESSION, { timeoutMs: 10_000 }),
      close: async () => {},
    });
    const prov = checkDeviceProvenance(entry, facts);
    report.provenance = { ok: prov.ok, reasons: prov.reasons, notes: prov.notes, renderer: prov.renderer, chrome: prov.chromeVersion, facts: prov.facts };
    report.cross_origin_isolated = await ev<boolean>("self.crossOriginIsolated");
    log(`provenance ${prov.ok ? "ok" : `FAILED ${prov.reasons.join("; ")}`}, isolated ${report.cross_origin_isolated}`);

    const processes = async () =>
      client
        .send<{ processInfo: { type: string; id: number }[] }>(
          "SystemInfo.getProcessInfo",
          {},
          { flat: true, timeoutMs: 10_000 },
        )
        .then((r) => r.processInfo)
        .catch(() => [] as { type: string; id: number }[]);
    const beforeRenderers = new Set(procsBefore.filter((p) => p.type === "renderer").map((p) => p.id));
    report.renderers_before_tab = [...beforeRenderers];
    const memory = async (label: string) => {
      const ps = await processes();
      const rows: Record<string, unknown>[] = [];
      for (const p of ps.filter((x) => x.type === "renderer" || x.type === "GPU")) {
        const text = await adb.shell(`dumpsys meminfo ${p.id}`).catch((e: Error) => e.message);
        rows.push({ type: p.type, pid: p.id, new_with_tab: p.type === "renderer" && !beforeRenderers.has(p.id), ...parseMeminfo(text) });
      }
      const heap = await client
        .send<{ usedSize: number; totalSize: number }>("Runtime.getHeapUsage", {})
        .catch(() => null);
      const out = {
        label,
        t: Date.now(),
        js_heap_used_mib: heap ? r1(heap.usedSize / 2 ** 20) : null,
        js_heap_total_mib: heap ? r1(heap.totalSize / 2 ** 20) : null,
        processes: rows,
      };
      log(`memory ${label}: ${rows.map((r) => `${r.type}:${r.pid}${r.new_with_tab ? "*" : ""} pss ${r.pss_mib} rss ${r.rss_mib}`).join(", ")}; js ${out.js_heap_used_mib} MiB`);
      return out;
    };
    const gc = async () => {
      await client.send("HeapProfiler.collectGarbage", {}).catch(() => {});
      await sleep(500);
      await client.send("HeapProfiler.collectGarbage", {}).catch(() => {});
      await sleep(1000);
    };
    await gc();
    report.pre_mount = await memory("pre-mount");

    let token: string | null = null;
    if (a["token-file"]) {
      for (let i = 0; i < 300 && !existsSync(a["token-file"]); i++) await sleep(100);
      token = readFileSync(a["token-file"], "utf8").trim();
    }
    const endpoint = { url: a.ws, resourceBase: a.http, token, protocol, presentation: [1920, 1080] };
    const core = { glueUrl: "/core/rs_gsw_wasm_client.js", wasmUrl: "/core/rs_gsw_wasm_bg.wasm", expectedTree };
    const stats = () => ev<Stats | null>("window.__rsc.stats()");
    const take = () => ev<Taken>("window.__rsc.probe.take()", 60_000);

    for (let m = 1; m <= 1 + remounts; m++) {
      const t0 = Date.now();
      const box = await ev<unknown>(
        `window.__rsc.mount(${JSON.stringify({ endpoint, core, creditWindow, creditStage, applyOn, backingScale })})`,
      );
      let firstFrameMs: number | null = null;
      let firstStats: Stats | null = null;
      for (;;) {
        const s = await stats();
        if (s && s.applied > 0) {
          firstFrameMs = Date.now() - t0;
          firstStats = s;
          break;
        }
        if (Date.now() - t0 > 60_000) break;
        await sleep(50);
      }
      // The page's own clock: mount() to the status `streaming` firstFrame.
      const pageFirst = await ev<number | null>(
        `(() => { const s = window.__rsc.statuses.find(x => x.mount === ${m} && x.kind === "streaming" && x.firstFrame); return s ? s.t - window.__rsc.mountAt[${m}] : null; })()`,
      );
      log(`mount ${m}: first frame ${firstFrameMs} ms (page ${pageFirst === null ? null : Math.round(pageFirst)} ms)`);
      const windowS = m === 1 ? mainS : cycleS;
      await take();
      const perSec: { t: number; applied: number; aps: number; rtt: number | null; heap: number }[] = [];
      const freqs: unknown[] = [];
      const w0 = Date.now();
      let nextFreq = w0;
      while (Date.now() - w0 < windowS * 1000) {
        const s = await stats();
        if (s) perSec.push({ t: Date.now() - w0, applied: s.applied, aps: s.appliesPerSec, rtt: s.creditRttMsP50, heap: s.heapBytes });
        if (m === 1 && Date.now() >= nextFreq) {
          freqs.push({ t: Date.now() - w0, cpus: await readCpuFreqs(adb, entry.cpu_clusters ?? []) });
          nextFreq += 15_000;
        }
        await sleep(1000 - ((Date.now() - w0) % 1000));
      }
      const wSecs = (Date.now() - w0) / 1000;
      const probes = summarize(await take(), wSecs);
      const applied0 = perSec[0]?.applied ?? 0;
      const appliedN = perSec[perSec.length - 1]?.applied ?? 0;
      const tN = (perSec[perSec.length - 1]?.t ?? 0) - (perSec[0]?.t ?? 0);
      const row: Record<string, unknown> = {
        mount: m,
        box,
        first_frame_ms: firstFrameMs,
        first_frame_page_ms: pageFirst === null ? null : Math.round(pageFirst),
        first_stats: firstStats,
        window_s: r1(wSecs),
        applies_per_s: tN > 0 ? r1(((appliedN - applied0) * 1000) / tN) : null,
        applies_per_s_sampled: dist(perSec.slice(1).map((x) => x.aps)),
        credit_rtt_p50_ms_sampled: dist(perSec.filter((x) => x.rtt !== null).map((x) => x.rtt as number)),
        heap_mib: dist(perSec.map((x) => x.heap / 2 ** 20)),
        heap_start_bytes: await ev<number | null>(`window.__rsc.heapAtStart[${m}] ?? null`),
        probes,
        per_second: m === 1 ? perSec : undefined,
        cpufreq: m === 1 ? freqs : undefined,
        host_load: readFileSync("/proc/loadavg", "utf8").trim(),
      };
      log(`mount ${m}: ${row.applies_per_s} applies/s, rAF ${probes.raf_per_s}/s, frame p95 ${probes.frame_interval_ms.p95} ms, rAF cb p95 ${probes.raf_callback_ms.p95} ms, onmessage ${probes.onmessage_busy_ms_per_s} ms/s, ${probes.message_kb_per_s} KB/s`);
      row.streaming_memory = await memory(`mount ${m} streaming`);

      if (m === 1 && attribS > 0) {
        const attrib: Record<string, unknown> = {};
        // 1. The GL probe: every WebGL2 call timed.
        await ev("window.__rsc.probe.gl(true)");
        await take();
        await sleep(attribS * 1000);
        const glTaken = await take();
        const gl = await ev<{ ms: number; calls: number; byName: { name: string; calls: number; ms: number }[] }>(
          "window.__rsc.probe.gl(false)",
        );
        attrib.gl_probe = {
          probes: summarize(glTaken, attribS),
          gl_ms_per_s: r1(gl.ms / attribS),
          gl_calls_per_s: r1(gl.calls / attribS),
          top: gl.byName.slice(0, 20).map((x) => ({ ...x, ms: r1(x.ms) })),
        };
        log(`gl probe: ${r1(gl.ms / attribS)} ms/s in ${r1(gl.calls / attribS)} calls/s`);
        // 2. A CDP trace: CPU by process and thread.
        try {
          await startTracing(client, traceCategoriesFor(true));
          await take();
          await sleep(attribS * 1000);
          const traceTaken = await take();
          const stopped = await stopTracing(client);
          const path = join(dir, "trace.json.gz");
          writeFileSync(path, stopped.bytes);
          const events = await readTraceEvents(path);
          const xs = events.filter((e) => e.ph === "X" && typeof e.ts === "number");
          // No spread: a busy page's trace has more events than the call stack holds arguments.
          let start = Infinity;
          let end = -Infinity;
          for (const e of xs) {
            if (e.ts < start) start = e.ts;
            if (e.ts > end) end = e.ts;
          }
          const cpu = computeCpu(events, buildThreadIndex(events), {
            windowStart: start,
            windowEnd: end,
            windowMs: (end - start) / 1000,
          });
          attrib.trace = {
            data_loss: stopped.dataLoss,
            events: events.length,
            window_ms: r1((end - start) / 1000),
            probes: summarize(traceTaken, attribS),
            cpu_coverage: r2(cpu.cpuCoverage),
            by_process: cpu.byProcess,
            by_thread: cpu.byThread.slice(0, 15),
          };
          log(`trace: ${events.length} events, by process ${JSON.stringify(Object.fromEntries(Object.entries(cpu.byProcess).map(([k, v]) => [k, r2(v.coreRatio)])))}`);
        } catch (e) {
          attrib.trace = { error: e instanceof Error ? e.message : String(e) };
        }
        // 3. A CDP CPU profile of the page.
        try {
          await client.send("Profiler.enable", {});
          await client.send("Profiler.setSamplingInterval", { interval: 500 });
          await client.send("Profiler.start", {});
          await sleep(attribS * 1000);
          const { profile } = await client.send<{ profile: Parameters<typeof profileSummary>[0] }>("Profiler.stop", {}, { timeoutMs: 60_000 });
          await client.send("Profiler.disable", {});
          writeFileSync(join(dir, "cpu-profile.json"), JSON.stringify(profile));
          attrib.cpu_profile = profileSummary(profile);
          log(`profile: ${JSON.stringify((attrib.cpu_profile as ReturnType<typeof profileSummary>).by_kind.slice(0, 6))}`);
        } catch (e) {
          attrib.cpu_profile = { error: e instanceof Error ? e.message : String(e) };
        }
        attrib.after = await stats();
        row.attribution = attrib;
      }

      await ev("window.__rsc.dispose()");
      await gc();
      await sleep(2000);
      row.after_dispose_memory = await memory(`mount ${m} after dispose + GC`);
      row.statuses = await ev<unknown[]>(
        `window.__rsc.statuses.filter(s => s.mount === ${m}).map(({kind, reason, detail, firstFrame, t}) => ({kind, reason, detail, firstFrame, t: Math.round(t)}))`,
      );
      mounts.push(row);
    }
    report.conditions_after = await browser.conditions();
    report.cpufreq_after = await readCpuFreqs(adb, entry.cpu_clusters ?? []);

    // Checks.
    type Mem = { processes: { type: string; new_with_tab: boolean; pid: number; pss_mib: number | null }[] };
    type Row = {
      mount: number;
      heap_start_bytes: number | null;
      heap_mib: { max: number | null };
      streaming_memory: Mem;
      after_dispose_memory: Mem;
      statuses: { kind: string; firstFrame?: boolean }[];
      applies_per_s: number | null;
    };
    const rows = mounts as unknown as Row[];
    // The page's renderer: the renderer that is new with the tab and heaviest while streaming.
    const pageRenderer = (mem: Mem) =>
      mem.processes
        .filter((p) => p.type === "renderer" && p.new_with_tab)
        .sort((x, y) => (y.pss_mib ?? 0) - (x.pss_mib ?? 0))[0] ?? null;
    const pid = rows[0] ? pageRenderer(rows[0].streaming_memory)?.pid ?? null : null;
    const pssOf = (mem: Mem) => mem.processes.find((p) => p.pid === pid)?.pss_mib ?? null;
    report.page_renderer_pid = pid;
    const checks: { id: string; passed: boolean; detail: string; gating?: boolean }[] = [];
    const failed = rows.filter(
      (r) => r.statuses.some((s) => s.kind === "failed") || !r.statuses.some((s) => s.kind === "streaming" && s.firstFrame === true),
    );
    checks.push({ id: "mounts-streamed", passed: failed.length === 0 && rows.length === 1 + remounts, detail: `${rows.length - failed.length}/${1 + remounts} mounts drew a first frame with no failure` });
    const drops = rows.map((r) => {
      const live = pssOf(r.streaming_memory);
      const after = pssOf(r.after_dispose_memory);
      return { live, after, heap: r.heap_mib.max ?? 0 };
    });
    checks.push({
      id: "instance-released",
      passed: pid !== null && drops.every((d) => d.live !== null && d.after !== null && d.live - d.after >= 0.8 * d.heap),
      detail: `page renderer (pid ${pid}) PSS streaming -> after dispose + GC: ${drops.map((d) => `${d.live} -> ${d.after}`).join(", ")} MiB vs each instance's wasm heap ${drops.map((d) => r1(d.heap)).join(", ")} MiB`,
    });
    const held0 = drops[0]?.after ?? null;
    checks.push({
      id: "remount-no-growth",
      passed: held0 !== null && drops.every((d) => d.after !== null && d.after <= held0 * (1 + tolerance)),
      detail: `page renderer PSS after each dispose + GC ${drops.map((d) => d.after).join(", ")} MiB, each within ${tolerance * 100}% of the first`,
    });
    const base = rows[0]?.heap_start_bytes ?? null;
    checks.push({ id: "heap-baseline", passed: base !== null && rows.every((r) => r.heap_start_bytes === base), detail: `wasm heap at each mount's start: ${rows.map((r) => r.heap_start_bytes).join(", ")}` });
    checks.push({ id: "device-provenance", passed: prov.ok, detail: prov.ok ? `${prov.renderer} ${prov.chromeVersion}` : prov.reasons.join("; ") });
    const aps = rows[0]?.applies_per_s ?? 0;
    checks.push({ id: "rate-60", gating: false, passed: aps >= 58, detail: `mount 1 applied ${aps}/s over its ${mainS} s window (bar 58/s)` });
    report.checks = checks;
    for (const c of checks)
      log(`${c.passed ? "pass" : c.gating === false ? "fail (reported)" : "FAIL"} ${c.id}: ${c.detail}`);
    code = checks.every((c) => c.passed || c.gating === false) ? 0 : 1;
  } finally {
    report.host_load_end = readFileSync("/proc/loadavg", "utf8").trim();
    writeFileSync(join(dir, "client-device.json"), `${JSON.stringify(report, null, 1)}\n`);
    if (lease) await lease.release().catch(() => {});
    await harness.close().catch(() => {});
    await server.stop().catch(() => {});
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`client-device-check: ${e instanceof Error ? e.stack : String(e)}`);
    process.exit(2);
  },
);
