// Gate 7 GSW bench page logic (G7d; protocol/gate7-design.md Q13e "The bench", Q13a/Q13b device
// probes). Bundled for the browser by scripts/gate7-bench.ts (esbuild, platform "browser"), over
// G7j's browser-loadable decoder: render-stream-2.ts's incremental RecordingValidator (decode,
// validate and resolve per record, exactly what validateRecording does per record) with the pure
// TypeScript SHA-256.
//
// ?mode=bench&input=<url>&name=<input>&nonce=<leg nonce>&warmup=1&repeats=5
//   Each repeat replays the whole recording, ONE RECORD PER rAF, as a live receiver applies them.
//   Timers wrap only accept(): decode_us (decodeRecord, hashing included), hash_us (every SHA-256,
//   through the injected hash), resolve_us (applyTransaction), and validate_us = total - decode -
//   resolve. The applier does not exist before G7a, so nothing is drawn but one clear per frame
//   (outside the timers) that keeps the page producing real frames.
// ?mode=probe&nonce=<leg nonce>&hold=<seconds>
//   WebGL facts, timer-query exposure, RGB10_A2 renderable/readable, rAF T_p, the viewport, timer
//   resolution, WebSocket echo RTT (100 B, 813 KB) and throughput against the harness's /echo, and
//   the 60 Hz hold drift against its /tick (arrival to the next rAF callback, p50 per 5-s window).
// window.__bench = { state: "running" | "done" | "error", ... } is the driver's progress channel;
// the results are PUT to /evidence/<nonce>/ (D10).

import {
  createRecordingValidator,
  decodeRecord,
  MAGIC,
  MAGIC_V3,
  MAGIC_V4,
  MAGIC_V5,
  MAGIC_V6,
  type RawRecord,
  setHashImpl,
  setValidatorPhaseTimer,
  splitRecords,
  type ValidatorPhaseTimer,
} from "../../scripts/lib/render-stream-2";
import { setHashImpl as setMeshHashImpl } from "../../scripts/lib/render-stream-mesh";
import { setHashImpl as setShaderHashImpl } from "../../scripts/lib/render-stream-shader";
import { sha256Hex } from "../../scripts/lib/sha256";

type Version = 2 | 3 | 4 | 5 | 6;

interface BenchState {
  state: "running" | "done" | "error";
  detail: string;
  error?: string;
}

declare global {
  interface Window {
    __bench?: BenchState;
  }
}

const params = new URLSearchParams(location.search);
const statusEl = document.getElementById("status");
const canvas = document.getElementById("frame") as HTMLCanvasElement;
const gl = canvas.getContext("webgl2", {
  antialias: false,
  preserveDrawingBuffer: false,
});

function setState(state: BenchState): void {
  window.__bench = state;
  if (statusEl) statusEl.textContent = `${state.state}: ${state.detail}`;
}

const nowUs = (): number => performance.now() * 1000;
const nextFrame = (): Promise<number> =>
  new Promise((res) => requestAnimationFrame(res));

function clearFrame(k: number): void {
  if (!gl) return;
  gl.clearColor((k % 64) / 64, 0.2, 0.4, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

async function putEvidence(nonce: string, name: string, body: unknown) {
  const res = await fetch(`/evidence/${nonce}/${name}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${name}: ${res.status}`);
}

function versionOf(data: Uint8Array): Version {
  const same = (m: Uint8Array) => m.every((b, i) => data[i] === b);
  if (same(MAGIC_V6)) return 6;
  if (same(MAGIC_V5)) return 5;
  if (same(MAGIC_V4)) return 4;
  if (same(MAGIC_V3)) return 3;
  if (same(MAGIC)) return 2;
  throw new Error("bad-magic: not a render-stream/2..6 recording");
}

/** The bench's watchdog evidence (browser-harness.ts `WatchdogSample`). */
function makeWatchdog() {
  let hiddenMs = 0;
  let hides = 0;
  let hiddenSince: number | null =
    document.visibilityState === "visible" ? null : performance.now();
  const onChange = () => {
    if (document.visibilityState !== "visible") {
      hides++;
      hiddenSince = performance.now();
    } else if (hiddenSince !== null) {
      hiddenMs += performance.now() - hiddenSince;
      hiddenSince = null;
    }
  };
  document.addEventListener("visibilitychange", onChange);
  return {
    stop(): { hiddenMs: number; hides: number } {
      document.removeEventListener("visibilitychange", onChange);
      const open = hiddenSince === null ? 0 : performance.now() - hiddenSince;
      return { hiddenMs: hiddenMs + open, hides };
    },
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

/** The smallest positive step performance.now() takes, in microseconds. */
function timerResolutionUs(): number {
  let best = Number.POSITIVE_INFINITY;
  let last = performance.now();
  for (let i = 0; i < 20000; i++) {
    const t = performance.now();
    if (t > last) {
      best = Math.min(best, t - last);
      last = t;
    }
  }
  return Math.round(best * 1000 * 1000) / 1000;
}

// ------------------------------------------------------------------------------------------ bench

interface RecordSample {
  index: number;
  kind: string;
  seq: number | null;
  bytes: number;
  total_us: number;
  decode_us: number;
  hash_us: number;
  resolve_us: number;
  validate_us: number;
}

async function runBench(): Promise<void> {
  const input = params.get("input");
  const name = params.get("name") ?? "input";
  const nonce = params.get("nonce") ?? "";
  const warmup = Number(params.get("warmup") ?? "1");
  const repeats = Number(params.get("repeats") ?? "5");
  if (!input || !nonce) throw new Error("bench needs ?input= and ?nonce=");
  setState({ state: "running", detail: `fetching ${input}` });
  const res = await fetch(input);
  if (!res.ok) throw new Error(`GET ${input}: ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const version = versionOf(data);
  const split = splitRecords(data, version);
  if (split.errors.length > 0) throw new Error(split.errors[0]);
  const records: RawRecord[] = split.records;
  // Each record's type and seq, decoded once up front, outside every timer.
  const kinds = records.map((raw) => {
    const meta = decodeRecord(raw, version).record?.meta;
    return {
      kind: meta?.type ?? "undecodable",
      seq: meta?.type === "transaction" ? meta.seq : null,
    };
  });

  let hashUs = 0;
  const timedHash = (bytes: Uint8Array): string => {
    const t = nowUs();
    const h = sha256Hex(bytes);
    hashUs += nowUs() - t;
    return h;
  };
  setHashImpl(timedHash);
  setMeshHashImpl(timedHash);
  setShaderHashImpl(timedHash);
  const timer: ValidatorPhaseTimer = {
    now: nowUs,
    decode_us: 0,
    resolve_us: 0,
  };
  setValidatorPhaseTimer(timer);

  const repeatResults: unknown[] = [];
  for (let r = 0; r < warmup + repeats; r++) {
    const isWarmup = r < warmup;
    setState({
      state: "running",
      detail: `${name} ${isWarmup ? "warmup" : "repeat"} ${isWarmup ? r + 1 : r - warmup + 1}`,
    });
    await nextFrame();
    const watchdog = makeWatchdog();
    const t0 = performance.now();
    const sessionT0 = nowUs();
    const validator = createRecordingValidator(records, version);
    const sessionUs = nowUs() - sessionT0;
    if (validator.errors) throw new Error(validator.errors[0]);
    const samples: RecordSample[] = [];
    const rafTimes: number[] = [];
    const longGaps: { gapMs: number; prevWorkMs: number }[] = [];
    let prevWorkMs = 0;
    let lastRaf = -1;
    let error: string | null = null;
    for (let i = 1; i < records.length; i++) {
      const ts = await nextFrame();
      const cbStart = performance.now();
      if (lastRaf >= 0 && ts - lastRaf > 250)
        longGaps.push({ gapMs: ts - lastRaf, prevWorkMs });
      if (lastRaf >= 0) rafTimes.push(ts - lastRaf);
      lastRaf = ts;
      hashUs = 0;
      timer.decode_us = 0;
      timer.resolve_us = 0;
      const a = nowUs();
      const errors = validator.accept(i);
      const total = nowUs() - a;
      if (errors) {
        error = `record ${i}: ${errors[0]}`;
        break;
      }
      const raw = records[i];
      samples.push({
        index: i,
        kind: kinds[i].kind,
        seq: kinds[i].seq,
        bytes: raw.byte_length,
        total_us: total,
        decode_us: timer.decode_us,
        hash_us: hashUs,
        resolve_us: timer.resolve_us,
        validate_us: total - timer.decode_us - timer.resolve_us,
      });
      clearFrame(i);
      prevWorkMs = performance.now() - cbStart;
    }
    if (!error) {
      const fin = validator.finish();
      if (fin.length > 0) error = fin[0];
    }
    const vis = watchdog.stop();
    repeatResults.push({
      repeat: r,
      warmup: isWarmup,
      error,
      session_us: sessionUs,
      wall_ms: performance.now() - t0,
      raf: {
        tp_ms: median(rafTimes),
        p95_ms: percentile(rafTimes, 0.95),
        max_ms: rafTimes.length ? Math.max(...rafTimes) : 0,
        intervals: rafTimes.length,
      },
      watchdog: {
        hiddenMs: vis.hiddenMs,
        hides: vis.hides,
        longGaps,
        tpMs: median(rafTimes),
      },
      samples,
    });
    if (error) break;
  }
  setHashImpl(sha256Hex);
  setMeshHashImpl(sha256Hex);
  setShaderHashImpl(sha256Hex);
  setValidatorPhaseTimer(null);
  setState({ state: "running", detail: "uploading results" });
  await putEvidence(nonce, `bench-${name}.json`, {
    schema: "render-stream-gate7-gsw-bench/1",
    input: {
      url: input,
      name,
      bytes: data.length,
      records: records.length,
      version,
    },
    page: {
      userAgent: navigator.userAgent,
      crossOriginIsolated: self.crossOriginIsolated === true,
      timer_resolution_us: timerResolutionUs(),
      devicePixelRatio: window.devicePixelRatio,
    },
    warmup,
    repeats,
    results: repeatResults,
  });
  setState({ state: "done", detail: `${name}: ${repeatResults.length} runs` });
}

// ------------------------------------------------------------------------------------------ probes

function glProbe(): Record<string, unknown> {
  const c = document.createElement("canvas");
  const g = c.getContext("webgl2");
  if (!g) return { webgl2: false };
  const dbg = g.getExtension("WEBGL_debug_renderer_info");
  const out: Record<string, unknown> = {
    webgl2: true,
    renderer: dbg ? String(g.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null,
    vendor: dbg ? String(g.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null,
    version: String(g.getParameter(g.VERSION)),
    shading: String(g.getParameter(g.SHADING_LANGUAGE_VERSION)),
    max_texture_size: g.getParameter(g.MAX_TEXTURE_SIZE),
    extensions: g.getSupportedExtensions() ?? [],
  };
  out.timer_query = (out.extensions as string[]).includes(
    "EXT_disjoint_timer_query_webgl2",
  );
  // RGB10_A2: renderable (a complete framebuffer) and readable (readPixels in the format the
  // implementation reports, or RGBA/UNSIGNED_INT_2_10_10_10_REV), with the value read back.
  const tex = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, tex);
  g.texStorage2D(g.TEXTURE_2D, 1, g.RGB10_A2, 4, 4);
  const fbo = g.createFramebuffer();
  g.bindFramebuffer(g.FRAMEBUFFER, fbo);
  g.framebufferTexture2D(
    g.FRAMEBUFFER,
    g.COLOR_ATTACHMENT0,
    g.TEXTURE_2D,
    tex,
    0,
  );
  const status = g.checkFramebufferStatus(g.FRAMEBUFFER);
  const renderable = status === g.FRAMEBUFFER_COMPLETE;
  let readable = false;
  let readFormat: unknown = null;
  let readValue: number[] | null = null;
  let readError: number | null = null;
  if (renderable) {
    g.clearColor(0.5, 0.25, 1, 1);
    g.clear(g.COLOR_BUFFER_BIT);
    const fmt = g.getParameter(g.IMPLEMENTATION_COLOR_READ_FORMAT);
    const type = g.getParameter(g.IMPLEMENTATION_COLOR_READ_TYPE);
    readFormat = { format: fmt, type };
    while (g.getError() !== g.NO_ERROR) {}
    const px = new Uint32Array(1);
    g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_INT_2_10_10_10_REV, px);
    readError = g.getError();
    if (readError === g.NO_ERROR) {
      readable = true;
      const v = px[0];
      readValue = [v & 1023, (v >> 10) & 1023, (v >> 20) & 1023, v >>> 30];
    }
  }
  out.rgb10a2 = {
    renderable,
    framebuffer_status: status,
    readable,
    read_format: readFormat,
    read_error: readError,
    read_value: readValue,
    expected_value: [512, 256, 1023, 3],
  };
  g.getExtension("WEBGL_lose_context")?.loseContext();
  return out;
}

async function rafProbe(warmMs: number, windowMs: number) {
  const start = performance.now();
  while (performance.now() - start < warmMs) await nextFrame();
  const intervals: number[] = [];
  let last = await nextFrame();
  const t0 = last;
  while (last - t0 < windowMs) {
    const ts = await nextFrame();
    intervals.push(ts - last);
    last = ts;
  }
  return {
    tp_ms: median(intervals),
    p95_ms: percentile(intervals, 0.95),
    max_ms: intervals.length ? Math.max(...intervals) : 0,
    callbacks: intervals.length,
    window_ms: windowMs,
  };
}

function openSocket(path: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://${location.host}${path}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error(`WebSocket ${path} failed`));
  });
}

async function rttProbe(): Promise<Record<string, unknown>> {
  const ws = await openSocket("/echo");
  const roundTrip = (payload: Uint8Array<ArrayBuffer>): Promise<number> =>
    new Promise((res) => {
      const t = performance.now();
      ws.onmessage = () => res(performance.now() - t);
      ws.send(payload);
    });
  const series = async (bytes: number, count: number) => {
    const payload = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) payload[i] = i & 0xff;
    await roundTrip(payload); // warm
    const rtts: number[] = [];
    for (let i = 0; i < count; i++) rtts.push(await roundTrip(payload));
    return {
      bytes,
      count,
      p50_ms: median(rtts),
      p95_ms: percentile(rtts, 0.95),
      max_ms: Math.max(...rtts),
      jitter_ms: percentile(rtts, 0.95) - percentile(rtts, 0.05),
    };
  };
  const small = await series(100, 50);
  const large = await series(813_000, 10);
  // Throughput: 24 pipelined 813-KB messages echoed back (both directions over the tunnel).
  const n = 24;
  const big = new Uint8Array(813_000);
  const thr = await new Promise<number>((res) => {
    let got = 0;
    const t = performance.now();
    ws.onmessage = () => {
      got++;
      if (got === n) res(performance.now() - t);
    };
    for (let i = 0; i < n; i++) ws.send(big);
  });
  ws.close();
  return {
    small,
    large,
    throughput: {
      messages: n,
      bytes_each: big.length,
      ms: thr,
      echoed_mb_per_s: (2 * n * big.length) / 1e6 / (thr / 1000),
    },
  };
}

async function holdProbe(seconds: number): Promise<Record<string, unknown>> {
  if (seconds <= 0) return { skipped: true };
  const ws = await openSocket("/tick");
  const arrivals: number[] = [];
  const holds: { t: number; hold: number }[] = [];
  ws.onmessage = () => arrivals.push(performance.now());
  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    await nextFrame();
    const cb = performance.now();
    while (arrivals.length > 0) {
      const a = arrivals.shift() as number;
      holds.push({ t: a - t0, hold: cb - a });
    }
  }
  ws.close();
  const windows: { from_s: number; hold_p50_ms: number; count: number }[] = [];
  for (let w = 0; w < seconds; w += 5) {
    const h = holds
      .filter((x) => x.t >= w * 1000 && x.t < (w + 5) * 1000)
      .map((x) => x.hold);
    windows.push({ from_s: w, hold_p50_ms: median(h), count: h.length });
  }
  const p50s = windows.filter((w) => w.count > 0).map((w) => w.hold_p50_ms);
  // The phase step: consecutive arrivals one host frame apart move against the rAF grid by
  // T_p - H per message (a wrap jumps by about a whole tick, so steps over 4 ms are wraps). Two
  // clocks at the same rate give ~0; the wrap period is how long one run keeps one phase (Q13c).
  const steps: number[] = [];
  let wraps = 0;
  for (let i = 1; i < holds.length; i++) {
    const d = holds[i].hold - holds[i - 1].hold;
    if (Math.abs(d) < 4) steps.push(d);
    else wraps++;
  }
  const step = median(steps);
  return {
    phase_step_p50_ms: step,
    phase_wraps: wraps,
    phase_wrap_period_s:
      Math.abs(step) > 1e-3 ? 16.667 / Math.abs(step) / 60 : null,
    seconds,
    host_hz: 60,
    messages: holds.length,
    hold_p50_ms: median(holds.map((x) => x.hold)),
    hold_p95_ms: percentile(
      holds.map((x) => x.hold),
      0.95,
    ),
    windows,
    drift_ms_per_s:
      p50s.length >= 2
        ? (p50s[p50s.length - 1] - p50s[0]) / ((windows.length - 1) * 5 || 1)
        : null,
  };
}

async function runProbes(): Promise<void> {
  const nonce = params.get("nonce") ?? "";
  const hold = Number(params.get("hold") ?? "0");
  if (!nonce) throw new Error("probe needs ?nonce=");
  setState({ state: "running", detail: "gl" });
  const glFacts = glProbe();
  setState({ state: "running", detail: "rAF" });
  const raf = await rafProbe(500, 3000);
  setState({ state: "running", detail: "rtt" });
  const rtt = await rttProbe().catch((e: Error) => ({ error: e.message }));
  setState({ state: "running", detail: `hold drift (${hold}s)` });
  const holdDrift = await holdProbe(hold).catch((e: Error) => ({
    error: e.message,
  }));
  await putEvidence(nonce, "page-probes.json", {
    schema: "render-stream-gate7-page-probes/1",
    gl: glFacts,
    raf,
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      orientation: screen.orientation ? screen.orientation.type : null,
      screen: [screen.width, screen.height],
      visualViewport: window.visualViewport
        ? [window.visualViewport.width, window.visualViewport.height]
        : null,
    },
    timer: {
      crossOriginIsolated: self.crossOriginIsolated === true,
      resolution_us: timerResolutionUs(),
    },
    userAgent: navigator.userAgent,
    rtt,
    hold_drift: holdDrift,
  });
  setState({ state: "done", detail: "probes" });
}

const mode = params.get("mode") ?? "bench";
// `idle`: the provenance page (the harness only reads DEVICE_PAGE_FACTS_EXPRESSION from it).
(mode === "idle"
  ? Promise.resolve(setState({ state: "done", detail: "idle" }))
  : mode === "probe"
    ? runProbes()
    : runBench()
).catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  setState({ state: "error", detail: message, error: message });
});
