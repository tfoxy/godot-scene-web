// PHN: the render-stream client package as a REAL live viewer on a phone. The
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
// Pacing proof: --protocol 18|19 --pacing fidelity|balanced|saver --one-way-ms 0|24
//   --gpu-load-hz none|N --gpu-load-mode coupled|always (default coupled)
//   --main-s 180 --remounts 0 --attrib-s 0 --core <prebuilt dir>.
// --device desktop uses pinned local Chromium without adb. Phone-only conditions,
// cpufreq and thermal fields are null, and PSS checks are non-gating there.
// Saver runs also write saver-trace.jsonl beside client-device.json.
// Coupled GPU load runs after stream draws only; always submits a heavy pass every rAF.
// --pacing excludes explicitly supplied --window and --credit-stage. GPU-load calibration
// runs before the first connection. --one-way-ms delays stream messages both ways, not GETs.
// The pacing report uses an independent page rAF draw recorder over the main measured window.
// Probe cadence groups all page rAF callbacks by timestamp. Callback cost sums each frame's
// stream-client apply/lower/GL submission, GPU-load and recorder callbacks (synchronous wall time).
// Balanced trial/after-fallback rates split that window at the first observed fallback.
// Explicit submitted windows w1..w8 use --credit-stage submitted --window 1..8.
// --remounts 0 mounts once; --attrib-s 0 skips all three attribution windows.
//
// --credit-stage and --apply-on pass the client's pacing options; omitted,
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
//   rate-60 (reported)  main-window applies/s >= 58 (the 60 fps bar at the panel's refresh rate)

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
import type { CDPSession, Page } from "@playwright/test";
import { build } from "esbuild";
import {
  buildThreadIndex,
  computeCpu,
} from "../../../packages/perf-harness/src/analyze";
import {
  CdpClient,
  type CdpParams,
  type SendOptions,
} from "../../../packages/perf-harness/src/cdp";
import {
  readTraceEvents,
  startTracing,
  stopTracing,
  traceCategoriesFor,
} from "../../../packages/perf-harness/src/trace";
import type {
  RenderStreamClient,
  RenderStreamEndpoint,
} from "../../../packages/render-stream-client/src/index";
import { pacingTrial } from "../web/client-phone/pacing-trial";
import type { PresentationTrace } from "../web/client-phone/presentation-trace";
import {
  dist,
  pct,
  summarize,
  type Taken,
} from "../web/client-phone/probe-summary";
import {
  BACKGROUND_THROTTLING_ARGS,
  BROWSER_LAUNCH_ARGS,
  checkBrowserProvenance,
  checkDeviceProvenance,
  DEVICE_PAGE_FACTS_EXPRESSION,
  type DeviceHarness,
  type DeviceId,
  type DevicePageFacts,
  HarnessServer,
  launchHarnessBrowser,
  loadDeviceTable,
  openHarnessDevice,
  withAttachedSerial,
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
  if (
    out["gpu-load-mode"] !== undefined &&
    !["always", "coupled"].includes(out["gpu-load-mode"])
  )
    throw new Error("client-device-check: --gpu-load-mode always|coupled");
  if (out.pacing !== undefined) {
    if (!["fidelity", "balanced", "saver"].includes(out.pacing))
      throw new Error("client-device-check: --pacing fidelity|balanced|saver");
    if (out.window !== undefined || out["credit-stage"] !== undefined)
      throw new Error(
        "client-device-check: --pacing excludes --window/--credit-stage",
      );
  }
  for (const key of ["one-way-ms", "attrib-s", "remounts"]) {
    if (
      out[key] !== undefined &&
      (!Number.isFinite(Number(out[key])) || Number(out[key]) < 0)
    )
      throw new Error(`client-device-check: --${key} must be nonnegative`);
  }
  if (out.remounts !== undefined && !Number.isInteger(Number(out.remounts)))
    throw new Error("client-device-check: --remounts must be an integer");
  for (const key of ["main-s", "cycle-s", "gpu-load-hz"]) {
    if (
      out[key] !== undefined &&
      !(key === "gpu-load-hz" && out[key] === "none") &&
      (!Number.isFinite(Number(out[key])) || Number(out[key]) <= 0)
    )
      throw new Error(`client-device-check: --${key} must be positive`);
  }
  if (
    out.protocol !== undefined &&
    ![11, 12, 18, 19].includes(Number(out.protocol))
  )
    throw new Error("client-device-check: --protocol 11|12|18|19");
  if (
    out.window !== undefined &&
    (!Number.isInteger(Number(out.window)) ||
      Number(out.window) < 1 ||
      Number(out.window) > 8)
  )
    throw new Error("client-device-check: --window 1..8");
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

type Stats = ReturnType<RenderStreamClient["stats"]> & { t: number };
interface Recording {
  t: number;
  mountAt: number;
  drawTimes: number[];
  firstFrameAt: number | null;
  fallbackAt: number | null;
  calibration: unknown;
  presentation: PresentationTrace;
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
    const kind = f.startsWith("(")
      ? f
      : url.endsWith(".wasm") ||
          /^\$|wasm-function/.test(f) ||
          url.startsWith("wasm://")
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
  return {
    total_ms: r1(total),
    by_kind: rows(kinds, 20),
    top_self: rows(self, 25),
  };
}

/** Adapt the pinned desktop browser's two CDP targets to the phone driver's interface. */
class DesktopCdp extends CdpClient {
  private readonly listeners = new Map<
    string,
    ((params: CdpParams, sessionId?: string) => void)[]
  >();
  constructor(
    private readonly pageSession: CDPSession,
    private readonly browserSession: CDPSession,
  ) {
    super();
  }
  override async send<T = Record<string, unknown>>(
    method: string,
    params: CdpParams = {},
    options: SendOptions = {},
  ): Promise<T> {
    const session = options.flat ? this.browserSession : this.pageSession;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        session.send(method as never, params as never) as Promise<T>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`CDP timeout: ${method}`)),
            options.timeoutMs ?? 60000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  override on(
    method: string,
    fn: (params: CdpParams, sessionId?: string) => void,
  ) {
    const session = method.startsWith("Tracing.")
      ? this.browserSession
      : this.pageSession;
    session.on(method as never, fn as never);
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn]);
  }
  override off(method: string) {
    const session = method.startsWith("Tracing.")
      ? this.browserSession
      : this.pageSession;
    for (const fn of this.listeners.get(method) ?? [])
      session.removeListener(method as never, fn as never);
    this.listeners.delete(method);
  }
}

async function main(): Promise<number> {
  const a = args();
  const dir = resolve(a.dir);
  const desktop = a.device === "desktop";
  const deviceId = (a.device ?? "g31") as DeviceId;
  const mainS = Number(a["main-s"] ?? 180);
  const remounts = Number(a.remounts ?? 3);
  const cycleS = Number(a["cycle-s"] ?? 20);
  const attribS = Number(a["attrib-s"] ?? 10);
  const backingScale = Number(a["backing-scale"] ?? 1);
  const tolerance = Number(a.tolerance ?? 0.15);
  const protocol = Number(a.protocol ?? 12) as RenderStreamEndpoint["protocol"];
  const creditWindow = Number(a.window ?? 2) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  const pacing = a.pacing as "fidelity" | "balanced" | "saver" | undefined;
  const oneWayMs = Number(a["one-way-ms"] ?? 0);
  const gpuLoadHz =
    a["gpu-load-hz"] === undefined || a["gpu-load-hz"] === "none"
      ? undefined
      : Number(a["gpu-load-hz"]);
  const gpuLoadMode = (a["gpu-load-mode"] ?? "coupled") as "always" | "coupled";
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
      [
        join(ROOT, "packages/render-stream-client/scripts/build-web.sh"),
        coreDir,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  }
  for (const f of [
    "build.json",
    "rs_gsw_wasm_bg.wasm",
    "rs_gsw_wasm_client.js",
  ])
    copyFileSync(join(coreDir, f), join(staticDir, "core", f));
  const coreBuild = JSON.parse(
    readFileSync(join(coreDir, "build.json"), "utf8"),
  );
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
  const tableEntry = table[deviceId];
  if (!desktop && !tableEntry)
    throw new Error(`client-device-check: no device ${deviceId}`);
  // ANDROID_SERIAL names the attached phone (the table's serials are placeholders).
  const entry = desktop ? undefined : withAttachedSerial(tableEntry);
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
    credit_window: pacing ? null : creditWindow,
    credit_stage: pacing ? null : (creditStage ?? "default"),
    apply_on: applyOn ?? "default",
    backing_scale: backingScale,
    core_build: coreBuild,
    expected_tree: expectedTree,
    page_inputs: inputs.length,
    page_harness_inputs: inputs.filter((p) => p.includes("gsw-receiver/")),
    host_load_start: readFileSync("/proc/loadavg", "utf8").trim(),
  };
  const log = (m: string) => console.log(`client-device-check: ${m}`);
  let harness: DeviceHarness | undefined;
  let launched: Awaited<ReturnType<typeof launchHarnessBrowser>> | undefined;
  let desktopPage: Page | undefined;
  let lease: Awaited<
    ReturnType<DeviceHarness["browser"]["targets"]["acquire"]>
  > | null = null;
  let code = 1;
  const mounts: Record<string, unknown>[] = [];
  report.mounts = mounts;
  try {
    let client: CdpClient;
    if (desktop) {
      launched = await launchHarnessBrowser();
      desktopPage = await launched.browser.newPage({
        viewport: { width: 1280, height: 720 },
      });
      desktopPage.on("pageerror", (error) =>
        log(`page error: ${error.message}`),
      );
      client = new DesktopCdp(
        await desktopPage.context().newCDPSession(desktopPage),
        await launched.browser.newBrowserCDPSession(),
      );
    } else {
      harness = await openHarnessDevice({
        id: deviceId,
        entry: entry!,
        serverPort: Number(a.port),
        extraReversePorts: [hostPort],
        onProgress: (m) => log(`device: ${m}`),
      });
      client = harness.browser.client;
    }
    const browser = harness?.browser;
    const adb = browser?.adb;
    report.conditions_before = browser ? await browser.conditions() : null;
    report.cpufreq_before =
      adb && entry ? await readCpuFreqs(adb, entry.cpu_clusters ?? []) : null;
    const procsBefore = await client
      .send<{ processInfo: { type: string; id: number }[] }>(
        "SystemInfo.getProcessInfo",
        {},
        { flat: true, timeoutMs: 10_000 },
      )
      .then((r) => r.processInfo)
      .catch(() => []);
    if (browser && entry)
      lease = await browser.targets.acquire({
        width: entry.screen_css_px[0],
        height: entry.screen_css_px[1],
      });
    const ev = <T>(expr: string, timeoutMs = 20_000) =>
      client.evaluate<T>(expr, { timeoutMs });
    await client.send("Page.navigate", { url: `${origin}/index.html` });
    for (let i = 0; ; i++) {
      const ok = await ev<boolean>(
        "!!(window.__rsc && window.__rsc.ready)",
      ).catch(() => false);
      if (ok) break;
      if (i > 150) throw new Error("the page never exposed __rsc");
      await sleep(200);
    }
    const prov =
      desktopPage && launched
        ? await checkBrowserProvenance(
            desktopPage,
            launched,
            [...BROWSER_LAUNCH_ARGS, ...BACKGROUND_THROTTLING_ARGS],
            { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
          )
        : checkDeviceProvenance(
            entry!,
            await harness!.facts({
              evaluate: (e, o) => client.evaluate(e, o),
              facts: () =>
                client.evaluate<DevicePageFacts>(DEVICE_PAGE_FACTS_EXPRESSION, {
                  timeoutMs: 10000,
                }),
              close: async () => {},
            }),
          );
    const chromeVersion =
      "chromeVersion" in prov ? prov.chromeVersion : prov.version;
    report.provenance = { ...prov, chrome: chromeVersion };
    report.cross_origin_isolated = await ev<boolean>(
      "self.crossOriginIsolated",
    );
    log(
      `provenance ${prov.ok ? "ok" : `FAILED ${prov.reasons.join("; ")}`}, isolated ${report.cross_origin_isolated}`,
    );

    const processes = async () =>
      client
        .send<{ processInfo: { type: string; id: number }[] }>(
          "SystemInfo.getProcessInfo",
          {},
          { flat: true, timeoutMs: 10_000 },
        )
        .then((r) => r.processInfo)
        .catch(() => [] as { type: string; id: number }[]);
    const beforeRenderers = new Set(
      procsBefore.filter((p) => p.type === "renderer").map((p) => p.id),
    );
    report.renderers_before_tab = [...beforeRenderers];
    const memory = async (label: string) => {
      const ps = await processes();
      const rows: Record<string, unknown>[] = [];
      for (const p of ps.filter(
        (x) => x.type === "renderer" || x.type === "GPU",
      )) {
        if (!adb) continue;
        const text = await adb
          .shell(`dumpsys meminfo ${p.id}`)
          .catch((e: Error) => e.message);
        rows.push({
          type: p.type,
          pid: p.id,
          new_with_tab: p.type === "renderer" && !beforeRenderers.has(p.id),
          ...parseMeminfo(text),
        });
      }
      const heap = await client
        .send<{ usedSize: number; totalSize: number }>(
          "Runtime.getHeapUsage",
          {},
        )
        .catch(() => null);
      const out = {
        label,
        t: Date.now(),
        js_heap_used_mib: heap ? r1(heap.usedSize / 2 ** 20) : null,
        js_heap_total_mib: heap ? r1(heap.totalSize / 2 ** 20) : null,
        processes: rows,
      };
      log(
        `memory ${label}: ${rows.map((r) => `${r.type}:${r.pid}${r.new_with_tab ? "*" : ""} pss ${r.pss_mib} rss ${r.rss_mib}`).join(", ")}; js ${out.js_heap_used_mib} MiB`,
      );
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
      for (let i = 0; i < 300 && !existsSync(a["token-file"]); i++)
        await sleep(100);
      token = readFileSync(a["token-file"], "utf8").trim();
    }
    const endpoint = {
      url: a.ws,
      resourceBase: a.http,
      token,
      protocol,
      presentation: [1920, 1080],
    };
    const core = {
      glueUrl: "/core/rs_gsw_wasm_client.js",
      wasmUrl: "/core/rs_gsw_wasm_bg.wasm",
      expectedTree,
    };
    const stats = () => ev<Stats | null>("window.__rsc.stats()");
    const take = () => ev<Taken>("window.__rsc.probe.take()", 60_000);

    for (let m = 1; m <= 1 + remounts; m++) {
      const t0 = Date.now();
      const box = await client.evaluate<unknown>(
        `window.__rsc.mount(${JSON.stringify({ endpoint, core, ...(pacing ? { pacing } : { creditWindow, creditStage }), applyOn, backingScale, oneWayMs, gpuLoadHz, gpuLoadMode })})`,
        { timeoutMs: 120_000, awaitPromise: true },
      );
      const waitFirstAt = Date.now();
      let firstFrameMs: number | null = null;
      let firstStats: Stats | null = null;
      for (;;) {
        const s = await stats();
        if (s && s.applied > 0) {
          firstFrameMs = Date.now() - t0;
          firstStats = s;
          break;
        }
        if (Date.now() - waitFirstAt > 60_000) break;
        await sleep(50);
      }
      // The page's own clock: mount() to the status `streaming` firstFrame.
      const pageFirst = await ev<number | null>(
        `(() => { const s = window.__rsc.statuses.find(x => x.mount === ${m} && x.kind === "streaming" && x.firstFrame); return s ? s.t - window.__rsc.mountAt[${m}] : null; })()`,
      );
      log(
        `mount ${m}: first frame ${firstFrameMs} ms (page ${pageFirst === null ? null : Math.round(pageFirst)} ms)`,
      );
      const windowS = m === 1 ? mainS : cycleS;
      await take();
      const perSec: {
        t: number;
        applied: number;
        aps: number;
        rtt: number | null;
        heap: number;
        starvedCycleShare: number | null;
        pacingFallback: boolean;
        creditWindowGranted: number | null;
        draws: number;
      }[] = [];
      const freqs: unknown[] = [];
      const pageWindowStart = await ev<number>("performance.now()");
      // Linux steady_clock and Node hrtime share CLOCK_MONOTONIC; the summary can
      // select host sends/timeline samples from the same measured window.
      const hostWindowStartUs = Number(process.hrtime.bigint() / 1000n);
      const w0 = Date.now();
      let nextFreq = w0;
      while (Date.now() - w0 < windowS * 1000) {
        const s = await stats();
        if (s)
          perSec.push({
            t: Date.now() - w0,
            applied: s.applied,
            aps: s.appliesPerSec,
            rtt: s.creditRttMsP50,
            heap: s.heapBytes,
            starvedCycleShare: s.starvedCycleShare ?? null,
            pacingFallback: s.pacingFallback ?? false,
            creditWindowGranted: s.creditWindowGranted ?? null,
            draws: s.draws ?? 0,
          });
        if (adb && entry && m === 1 && Date.now() >= nextFreq) {
          freqs.push({
            t: Date.now() - w0,
            cpus: await readCpuFreqs(adb, entry.cpu_clusters ?? []),
          });
          nextFreq += 15_000;
        }
        await sleep(1000 - ((Date.now() - w0) % 1000));
      }
      const hostWindowEndUs = Number(process.hrtime.bigint() / 1000n);
      const end = await ev<{
        recording: Recording;
        stats: Stats;
        statuses: unknown[];
      }>(
        "({recording: window.__rsc.recording(), stats: window.__rsc.stats(), statuses: window.__rsc.statuses})",
      );
      const rec = end.recording;
      const drawTimes = rec.drawTimes.filter(
        (t) => t >= pageWindowStart && t <= rec.t,
      );
      const drawIntervals = drawTimes.slice(1).map((t, i) => t - drawTimes[i]);
      const median = pct(drawIntervals, 50);
      const pacingReport = {
        preset: pacing ?? null,
        page_window_start_ms: pageWindowStart,
        page_window_end_ms: rec.t,
        saver_summary: { k: end.stats.saverDivisor ?? null },
        ...pacingTrial(
          pacing,
          drawTimes,
          pageWindowStart,
          rec.t,
          rec.fallbackAt,
        ),
        one_way_ms: oneWayMs,
        gpu_load: {
          mode: gpuLoadMode,
          target_hz: gpuLoadHz ?? null,
          calibration: rec.calibration,
        },
        window_s: (rec.t - pageWindowStart) / 1000,
        host_window_start_us: hostWindowStartUs,
        host_window_end_us: hostWindowEndUs,
        draws: drawTimes.length,
        draws_per_s: (drawTimes.length * 1000) / (rec.t - pageWindowStart),
        draw_interval_ms: dist(drawIntervals),
        stutter_share:
          median === null
            ? null
            : drawIntervals.filter((t) => t > 1.5 * median).length /
              drawIntervals.length,
        // Keep the original alias (since first frame) for existing report readers.
        fallback_at_mount_ms:
          rec.fallbackAt === null ? null : rec.fallbackAt - rec.mountAt,
        fallback_at_first_frame_ms:
          rec.fallbackAt === null || rec.firstFrameAt === null
            ? null
            : rec.fallbackAt - rec.firstFrameAt,
        fallback_at_ms:
          rec.fallbackAt === null || rec.firstFrameAt === null
            ? null
            : rec.fallbackAt - rec.firstFrameAt,
        starvedCycleShare: end.stats.starvedCycleShare ?? null,
        creditWindowGranted: end.stats.creditWindowGranted ?? null,
        creditStage: end.stats.creditStage ?? null,
        connections_seen: end.statuses.filter(
          (s) => (s as { kind: string }).kind === "connecting",
        ).length,
        statuses: end.statuses,
      };
      if (m === 1) {
        report.pacing = pacingReport;
        writeFileSync(
          join(dir, "saver-trace.jsonl"),
          `${rec.presentation.map((row) => JSON.stringify(row)).join("\n")}\n`,
        );
      }
      const wSecs = (Date.now() - w0) / 1000;
      const probes = summarize(await take(), wSecs);
      const applied0 = perSec[0]?.applied ?? 0;
      const appliedN = perSec[perSec.length - 1]?.applied ?? 0;
      const tN = (perSec[perSec.length - 1]?.t ?? 0) - (perSec[0]?.t ?? 0);
      const row: Record<string, unknown> = {
        mount: m,
        box,
        pacing: pacingReport,
        first_frame_ms: firstFrameMs,
        first_frame_page_ms: pageFirst === null ? null : Math.round(pageFirst),
        first_stats: firstStats,
        window_s: r1(wSecs),
        applies_per_s: tN > 0 ? r1(((appliedN - applied0) * 1000) / tN) : null,
        applies_per_s_sampled: dist(perSec.slice(1).map((x) => x.aps)),
        credit_rtt_p50_ms_sampled: dist(
          perSec.filter((x) => x.rtt !== null).map((x) => x.rtt as number),
        ),
        heap_mib: dist(perSec.map((x) => x.heap / 2 ** 20)),
        heap_start_bytes: await ev<number | null>(
          `window.__rsc.heapAtStart[${m}] ?? null`,
        ),
        probes,
        per_second: perSec,
        cpufreq: desktop ? null : m === 1 ? freqs : undefined,
        host_load: readFileSync("/proc/loadavg", "utf8").trim(),
      };
      log(
        `mount ${m}: ${row.applies_per_s} applies/s, rAF ${probes.raf_per_s}/s, frame p95 ${probes.frame_interval_ms.p95} ms, all-page rAF callbacks/frame p95 ${probes.raf_callback_ms.p95} ms (stream + GPU load + recorder), onmessage ${probes.onmessage_busy_ms_per_s} ms/s, ${probes.message_kb_per_s} KB/s`,
      );
      row.streaming_memory = await memory(`mount ${m} streaming`);

      if (m === 1 && attribS > 0) {
        const attrib: Record<string, unknown> = {};
        // 1. The GL probe: every WebGL2 call timed.
        await ev("window.__rsc.probe.gl(true)");
        await take();
        await sleep(attribS * 1000);
        const glTaken = await take();
        const gl = await ev<{
          ms: number;
          calls: number;
          byName: { name: string; calls: number; ms: number }[];
        }>("window.__rsc.probe.gl(false)");
        attrib.gl_probe = {
          probes: summarize(glTaken, attribS),
          gl_ms_per_s: r1(gl.ms / attribS),
          gl_calls_per_s: r1(gl.calls / attribS),
          top: gl.byName.slice(0, 20).map((x) => ({ ...x, ms: r1(x.ms) })),
        };
        log(
          `gl probe: ${r1(gl.ms / attribS)} ms/s in ${r1(gl.calls / attribS)} calls/s`,
        );
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
          const xs = events.filter(
            (e) => e.ph === "X" && typeof e.ts === "number",
          );
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
          log(
            `trace: ${events.length} events, by process ${JSON.stringify(Object.fromEntries(Object.entries(cpu.byProcess).map(([k, v]) => [k, r2(v.coreRatio)])))}`,
          );
        } catch (e) {
          attrib.trace = { error: e instanceof Error ? e.message : String(e) };
        }
        // 3. A CDP CPU profile of the page.
        try {
          await client.send("Profiler.enable", {});
          await client.send("Profiler.setSamplingInterval", { interval: 500 });
          await client.send("Profiler.start", {});
          await sleep(attribS * 1000);
          const { profile } = await client.send<{
            profile: Parameters<typeof profileSummary>[0];
          }>("Profiler.stop", {}, { timeoutMs: 60_000 });
          await client.send("Profiler.disable", {});
          writeFileSync(join(dir, "cpu-profile.json"), JSON.stringify(profile));
          attrib.cpu_profile = profileSummary(profile);
          log(
            `profile: ${JSON.stringify((attrib.cpu_profile as ReturnType<typeof profileSummary>).by_kind.slice(0, 6))}`,
          );
        } catch (e) {
          attrib.cpu_profile = {
            error: e instanceof Error ? e.message : String(e),
          };
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
    report.conditions_after = browser ? await browser.conditions() : null;
    report.cpufreq_after =
      adb && entry ? await readCpuFreqs(adb, entry.cpu_clusters ?? []) : null;

    // Checks.
    type Mem = {
      processes: {
        type: string;
        new_with_tab: boolean;
        pid: number;
        pss_mib: number | null;
      }[];
    };
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
    const pid = rows[0]
      ? (pageRenderer(rows[0].streaming_memory)?.pid ?? null)
      : null;
    const pssOf = (mem: Mem) =>
      mem.processes.find((p) => p.pid === pid)?.pss_mib ?? null;
    report.page_renderer_pid = pid;
    const checks: {
      id: string;
      passed: boolean;
      detail: string;
      gating?: boolean;
    }[] = [];
    const failed = rows.filter(
      (r) =>
        r.statuses.some((s) => s.kind === "failed") ||
        !r.statuses.some(
          (s) => s.kind === "streaming" && s.firstFrame === true,
        ),
    );
    checks.push({
      id: "mounts-streamed",
      passed: failed.length === 0 && rows.length === 1 + remounts,
      detail: `${rows.length - failed.length}/${1 + remounts} mounts drew a first frame with no failure`,
    });
    const drops = rows.map((r) => {
      const live = pssOf(r.streaming_memory);
      const after = pssOf(r.after_dispose_memory);
      return { live, after, heap: r.heap_mib.max ?? 0 };
    });
    checks.push({
      id: "instance-released",
      gating: !desktop,
      passed:
        pid !== null &&
        drops.every(
          (d) =>
            d.live !== null &&
            d.after !== null &&
            d.live - d.after >= 0.8 * d.heap,
        ),
      detail: `page renderer (pid ${pid}) PSS streaming -> after dispose + GC: ${drops.map((d) => `${d.live} -> ${d.after}`).join(", ")} MiB vs each instance's wasm heap ${drops.map((d) => r1(d.heap)).join(", ")} MiB`,
    });
    const held0 = drops[0]?.after ?? null;
    checks.push({
      id: "remount-no-growth",
      gating: !desktop,
      passed:
        held0 !== null &&
        drops.every(
          (d) => d.after !== null && d.after <= held0 * (1 + tolerance),
        ),
      detail: `page renderer PSS after each dispose + GC ${drops.map((d) => d.after).join(", ")} MiB, each within ${tolerance * 100}% of the first`,
    });
    const base = rows[0]?.heap_start_bytes ?? null;
    checks.push({
      id: "heap-baseline",
      passed: base !== null && rows.every((r) => r.heap_start_bytes === base),
      detail: `wasm heap at each mount's start: ${rows.map((r) => r.heap_start_bytes).join(", ")}`,
    });
    checks.push({
      id: "device-provenance",
      passed: prov.ok,
      detail: prov.ok
        ? `${prov.renderer} ${chromeVersion}`
        : prov.reasons.join("; "),
    });
    const aps = rows[0]?.applies_per_s ?? 0;
    checks.push({
      id: "rate-60",
      gating: false,
      passed: aps >= 58,
      detail: `mount 1 applied ${aps}/s over its ${mainS} s window (bar 58/s)`,
    });
    report.checks = checks;
    for (const c of checks)
      log(
        `${c.passed ? "pass" : c.gating === false ? "fail (reported)" : "FAIL"} ${c.id}: ${c.detail}`,
      );
    code = checks.every((c) => c.passed || c.gating === false) ? 0 : 1;
  } finally {
    report.host_load_end = readFileSync("/proc/loadavg", "utf8").trim();
    writeFileSync(
      join(dir, "client-device.json"),
      `${JSON.stringify(report, null, 1)}\n`,
    );
    if (lease) await lease.release().catch(() => {});
    await harness?.close().catch(() => {});
    await launched?.browser.close().catch(() => {});
    await server.stop().catch(() => {});
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(
      `client-device-check: ${e instanceof Error ? e.stack : String(e)}`,
    );
    process.exit(2);
  },
);
