// Gate 7x Rust-arm bench page (G7x; protocol/gate7-design.md "G7x", Q14c). The `gsw-rs` and
// `gsw-rs-inline` arms of gate7-bench.ts: one recording replayed through `rs-gsw-wasm` (the
// render-stream core and the canvas-items executor in ONE wasm module), one transaction per rAF,
// exactly as web/bench/bench.ts replays it through the TypeScript decoder (`gsw-ts`).
//
// ?mode=bench&arm=gsw-rs|gsw-rs-inline&input=<url>&store=<dir url>&name=<input>&nonce=<leg nonce>
//   &warmup=1&repeats=1[&shot-frames=10,60,...][&sabotage=drop-draws,...]
// Per transaction (Q14c): the whole recording is in wasm memory before the loop (step 1, outside
// every timer); then
//   decode_us   accept(i): framing, meta, validation, resolve, payload references (the record
//               digest too for gsw-rs-inline, D31);
//   provide_us  each payload the transaction needs, copied once into wasm and SHA-256-verified
//               (`provide`): the fetcher's work, prefetched bytes so no I/O is timed;
//   apply_us    apply(): the retained state to the packed list's dirty ranges;
//   draw_us     draw(): texture ops, dirty uploads, the GL draws and the blit, until it returns;
//   total_us    one wall timer over all of the above (the JS↔wasm boundary included);
//   evidence_hash_us  gsw-rs only: the deferred record digest (D31), right after the frame's timed
//               window, outside total_us.
// Report-only: gpu_complete_ms, a fenceSync after the blit polled on later frames (no timer query
// on the g31). Per repeat: T_p (rAF median), the wasm heap, the watchdog. shot-frames reads the
// RGB10_A2 target back (RGBA/UNSIGNED_BYTE) after the transaction of each listed host frame and
// PUTs the raw bytes (`shot-<name>-f<frame>.rgba`, W×H×4, rows top-down) for the pace checks.

export {};

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

/** The wasm-bindgen surface of `rs-gsw-wasm` (experiments/render-stream/web/gsw-rs/src/lib.rs). */
interface GswRs {
  alloc_recording(len: number): number;
  load(len: number): number;
  reset(): number;
  start(): number;
  accept(index: number): number;
  needed_count(): number;
  needed_ptr(): number;
  alloc_payload(len: number): number;
  provide(len: number): number;
  apply(): number;
  draw(): number;
  stats_ptr(): number;
  digest(): number;
  poll_fence(): number;
  shot(): number;
  target_width(): number;
  target_height(): number;
  error(): string;
  evidence_json(): string;
  free(): void;
}

interface GswRsModule {
  default(init: {
    module_or_path: BufferSource;
  }): Promise<{ memory: WebAssembly.Memory }>;
  GswRs: { new (canvas: HTMLCanvasElement, options: string): GswRs };
}

/** accept() codes (lib.rs `ACCEPT_*`). */
const ACCEPT_TRANSACTION = 0;
const ACCEPT_RESOURCE = 1;
const ACCEPT_END = 2;
const ACCEPT_NEEDS_PAYLOADS = 3;

/** The stats block's u32 slots (lib.rs `Stats`, `#[repr(C)]`, all u32). */
const STAT_FIELDS = [
  "status",
  "seq",
  "frame",
  "needed",
  "structural",
  "relowered",
  "rows_written",
  "lowered_draws",
  "assembly_skips",
  "emitted_draws",
  "expected_calls",
  "executed_calls",
  "merged_draws",
  "texture_uploads",
  "texture_upload_bytes",
  "item_bytes",
  "vertex_bytes",
  "index_bytes",
  "parity_violations",
  "accepted_records",
  "digests_pending",
  "vertices",
  "indices",
  "draws",
] as const;
type StatName = (typeof STAT_FIELDS)[number];

const params = new URLSearchParams(location.search);
const statusEl = document.getElementById("status");
const canvas = document.getElementById("frame") as HTMLCanvasElement;

function setState(state: BenchState): void {
  window.__bench = state;
  if (statusEl) statusEl.textContent = `${state.state}: ${state.detail}`;
}

const nowUs = (): number => performance.now() * 1000;
const nextFrame = (): Promise<number> =>
  new Promise((res) => requestAnimationFrame(res));

async function put(nonce: string, name: string, body: BodyInit): Promise<void> {
  const res = await fetch(`/evidence/${nonce}/${name}`, {
    method: "PUT",
    body,
  });
  if (!res.ok) throw new Error(`PUT ${name}: ${res.status}`);
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

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Every payload of a store directory, by hash (prefetched: no I/O inside a timer). */
async function prefetchStore(store: string): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const res = await fetch(`${store}/index.jsonl`);
  if (!res.ok) return out;
  const ext: Record<string, string> = {
    "texture-2d": "grt",
    "mesh-surface": "grm",
    "shader-code": "grp",
  };
  const lines = (await res.text()).split("\n").filter(Boolean);
  await Promise.all(
    lines.map(async (line) => {
      const entry = JSON.parse(line) as { hash: string; type?: string };
      const e = ext[entry.type ?? "texture-2d"] ?? "grt";
      const r = await fetch(`${store}/sha256/${entry.hash}.${e}`);
      if (r.ok) out.set(entry.hash, new Uint8Array(await r.arrayBuffer()));
    }),
  );
  return out;
}

interface Sample {
  index: number;
  kind: string;
  seq: number;
  frame: number;
  total_us: number;
  decode_us: number;
  provide_us: number;
  apply_us: number;
  draw_us: number;
  evidence_hash_us: number;
  provided: number;
  structural: number;
  executed_calls: number;
  expected_calls: number;
  lowered_draws: number;
  assembly_skips: number;
  merged_draws: number;
  item_bytes: number;
  vertex_bytes: number;
  index_bytes: number;
  texture_upload_bytes: number;
}

async function runBench(): Promise<void> {
  const arm = params.get("arm") ?? "gsw-rs";
  if (arm !== "gsw-rs" && arm !== "gsw-rs-inline")
    throw new Error(`arm must be gsw-rs or gsw-rs-inline (got ${arm})`);
  const input = params.get("input");
  const store = params.get("store");
  const name = params.get("name") ?? "input";
  const nonce = params.get("nonce") ?? "";
  const warmup = Number(params.get("warmup") ?? "1");
  const repeats = Number(params.get("repeats") ?? "1");
  const sabotage = (params.get("sabotage") ?? "").split(",").filter(Boolean);
  const shotFrames = new Set(
    (params.get("shot-frames") ?? "").split(",").filter(Boolean).map(Number),
  );
  const shotSeqs = new Set(
    (params.get("shot-seqs") ?? "").split(",").filter(Boolean).map(Number),
  );
  if (!input || !nonce) throw new Error("bench needs ?input= and ?nonce=");

  setState({ state: "running", detail: "loading rs-gsw-wasm" });
  const mod = (await import(
    /* @vite-ignore */ `${location.origin}/gsw-rs/rs_gsw_wasm.js`
  )) as GswRsModule;
  const wasmBytes = await (
    await fetch("/gsw-rs/rs_gsw_wasm_bg.wasm")
  ).arrayBuffer();
  const exports = await mod.default({ module_or_path: wasmBytes });
  const memory = exports.memory;

  setState({ state: "running", detail: `fetching ${input}` });
  const data = new Uint8Array(await (await fetch(input)).arrayBuffer());
  const payloads = store ? await prefetchStore(store) : new Map();

  const gs = new mod.GswRs(
    canvas,
    JSON.stringify({
      digest: arm === "gsw-rs-inline" ? "inline" : "deferred",
      sabotage,
      format: "rgb10a2",
    }),
  );
  // Step 1 (Q14c, file mode): the recording enters wasm memory ONCE, outside every timer.
  const ptr = gs.alloc_recording(data.length);
  new Uint8Array(memory.buffer, ptr, data.length).set(data);
  const recordCount = gs.load(data.length);
  if (recordCount < 0) throw new Error(`load: ${gs.error()}`);

  // Re-derived whenever memory grew (growth detaches views, Q14c step 5).
  let statsView: Uint32Array | null = null;
  let statsBuffer: ArrayBuffer | null = null;
  const stats = (): Record<StatName, number> => {
    if (statsBuffer !== memory.buffer || !statsView) {
      statsBuffer = memory.buffer;
      statsView = new Uint32Array(
        memory.buffer,
        gs.stats_ptr(),
        STAT_FIELDS.length,
      );
    }
    const out = {} as Record<StatName, number>;
    STAT_FIELDS.forEach((k, i) => {
      out[k] = (statsView as Uint32Array)[i];
    });
    return out;
  };

  const repeatResults: unknown[] = [];
  for (let r = 0; r < warmup + repeats; r++) {
    const isWarmup = r < warmup;
    setState({
      state: "running",
      detail: `${name} ${arm} ${isWarmup ? "warmup" : "repeat"} ${isWarmup ? r + 1 : r - warmup + 1}`,
    });
    if (gs.reset() < 0) throw new Error(`reset: ${gs.error()}`);
    if (gs.start() < 0) throw new Error(`start: ${gs.error()}`);
    await nextFrame();
    const watchdog = makeWatchdog();
    const t0 = performance.now();
    const samples: Sample[] = [];
    const rafTimes: number[] = [];
    const longGaps: { gapMs: number; prevWorkMs: number }[] = [];
    const gpuComplete: number[] = [];
    let fenceDrawEnd = -1;
    let prevWorkMs = 0;
    let lastRaf = -1;
    let error: string | null = null;
    let parityViolations = 0;
    const shots: { frame: number; seq: number; path: string }[] = [];
    for (let i = 1; i < recordCount; i++) {
      const ts = await nextFrame();
      const cbStart = performance.now();
      if (lastRaf >= 0 && ts - lastRaf > 250)
        longGaps.push({ gapMs: ts - lastRaf, prevWorkMs });
      if (lastRaf >= 0) rafTimes.push(ts - lastRaf);
      lastRaf = ts;
      // gpu_complete (report-only): the previous frame's fence, polled before this frame's work.
      if (fenceDrawEnd >= 0 && gs.poll_fence() === 1) {
        gpuComplete.push(performance.now() - fenceDrawEnd);
        fenceDrawEnd = -1;
      }

      const a = nowUs();
      let code = gs.accept(i);
      const decodeUs = nowUs() - a;
      let provideUs = 0;
      let provided = 0;
      if (code === ACCEPT_NEEDS_PAYLOADS) {
        const p0 = nowUs();
        const n = gs.needed_count();
        const hashes = new Uint8Array(
          memory.buffer,
          gs.needed_ptr(),
          32 * n,
        ).slice();
        for (let k = 0; k < n; k++) {
          const h = hex(hashes.subarray(32 * k, 32 * k + 32));
          const bytes = payloads.get(h);
          if (!bytes) {
            error = `record ${i}: payload ${h} not in the store`;
            break;
          }
          const pp = gs.alloc_payload(bytes.length);
          new Uint8Array(memory.buffer, pp, bytes.length).set(bytes);
          if (gs.provide(bytes.length) < 0) {
            error = `record ${i}: provide ${h}: ${gs.error()}`;
            break;
          }
          provided++;
        }
        provideUs = nowUs() - p0;
        if (error) break;
        code = ACCEPT_TRANSACTION;
      }
      if (code < 0) {
        error = `record ${i}: ${gs.error()}`;
        break;
      }
      let applyUs = 0;
      let drawUs = 0;
      if (code === ACCEPT_TRANSACTION) {
        const b = nowUs();
        if (gs.apply() < 0) {
          error = `record ${i}: apply: ${gs.error()}`;
          break;
        }
        const c = nowUs();
        if (gs.draw() < 0) {
          error = `record ${i}: draw: ${gs.error()}`;
          break;
        }
        const d = nowUs();
        applyUs = c - b;
        drawUs = d - c;
        fenceDrawEnd = performance.now();
      }
      const total = nowUs() - a;
      // D31: the deferred record digest, after the frame's timed window, once per frame.
      let evidenceUs = 0;
      if (arm === "gsw-rs") {
        const e0 = nowUs();
        gs.digest();
        evidenceUs = nowUs() - e0;
      }
      const st = stats();
      if (
        code === ACCEPT_TRANSACTION &&
        st.executed_calls !== st.expected_calls
      )
        parityViolations++;
      if (
        code === ACCEPT_TRANSACTION &&
        (shotFrames.has(st.frame) || shotSeqs.has(st.seq)) &&
        !isWarmup
      ) {
        const sp = gs.shot();
        const w = gs.target_width();
        const h = gs.target_height();
        const path = `shot-${name}-f${st.frame}.rgba`;
        await put(
          nonce,
          path,
          new Uint8Array(memory.buffer, sp, w * h * 4).slice(),
        );
        shots.push({ frame: st.frame, seq: st.seq, path });
      }
      samples.push({
        index: i,
        kind:
          code === ACCEPT_TRANSACTION
            ? "transaction"
            : code === ACCEPT_RESOURCE
              ? "resource"
              : code === ACCEPT_END
                ? "end"
                : String(code),
        seq: st.seq,
        frame: st.frame,
        total_us: total,
        decode_us: decodeUs,
        provide_us: provideUs,
        apply_us: applyUs,
        draw_us: drawUs,
        evidence_hash_us: evidenceUs,
        provided,
        structural: st.structural,
        executed_calls: st.executed_calls,
        expected_calls: st.expected_calls,
        lowered_draws: st.lowered_draws,
        assembly_skips: st.assembly_skips,
        merged_draws: st.merged_draws,
        item_bytes: st.item_bytes,
        vertex_bytes: st.vertex_bytes,
        index_bytes: st.index_bytes,
        texture_upload_bytes: st.texture_upload_bytes,
      });
      prevWorkMs = performance.now() - cbStart;
    }
    // record-digest-complete (D31): every accepted record has its digest before evidence.
    let digestPending = 0;
    if (!error) {
      gs.digest();
      digestPending = stats().digests_pending;
      if (digestPending > 0)
        error = `record-digest-complete: ${digestPending} accepted record(s) without a digest`;
    }
    const vis = watchdog.stop();
    repeatResults.push({
      repeat: r,
      warmup: isWarmup,
      error,
      wall_ms: performance.now() - t0,
      heap_bytes: memory.buffer.byteLength,
      parity_violations: parityViolations,
      digest_pending: digestPending,
      raf: {
        tp_ms: median(rafTimes),
        p95_ms: percentile(rafTimes, 0.95),
        max_ms: rafTimes.length ? Math.max(...rafTimes) : 0,
        intervals: rafTimes.length,
      },
      gpu_complete_ms: {
        count: gpuComplete.length,
        p50: median(gpuComplete),
        p95: percentile(gpuComplete, 0.95),
      },
      watchdog: {
        hiddenMs: vis.hiddenMs,
        hides: vis.hides,
        longGaps,
        tpMs: median(rafTimes),
      },
      shots,
      evidence: isWarmup ? null : JSON.parse(gs.evidence_json()),
      samples,
    });
    if (error) break;
  }
  setState({ state: "running", detail: "uploading results" });
  await put(
    nonce,
    `bench-${name}-${arm}.json`,
    JSON.stringify({
      schema: "render-stream-gate7x-rs-bench/1",
      arm,
      input: { url: input, name, bytes: data.length, records: recordCount },
      page: {
        userAgent: navigator.userAgent,
        crossOriginIsolated: self.crossOriginIsolated === true,
        timer_resolution_us: timerResolutionUs(),
        devicePixelRatio: window.devicePixelRatio,
        // The browser build's architecture and bitness (a 32-bit renderer runs wasm i64 as pairs).
        architecture: await (
          navigator as Navigator & {
            userAgentData?: {
              getHighEntropyValues(h: string[]): Promise<unknown>;
            };
          }
        ).userAgentData
          ?.getHighEntropyValues(["architecture", "bitness", "platformVersion"])
          .catch(() => null),
      },
      warmup,
      repeats,
      sabotage,
      results: repeatResults,
    }),
  );
  gs.free();
  setState({
    state: "done",
    detail: `${name} ${arm}: ${repeatResults.length} runs`,
  });
}

runBench().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  setState({ state: "error", detail: message, error: message });
});
