// The GSW canvas receiver (gate7-design.md Q5, Q14c, D29/D30, G7a): a TypeScript shell over
// `rs-gsw-wasm`, the render-stream core and the canvas-items executor in ONE wasm module. Decode,
// validation, resolve, D7's applier and the GL draws are Rust; this file owns the configuration,
// the sources, the fetcher, the rAF loop, the timers and the evidence.
//
// File mode replays a recording as the native receiver does (receiver.gd "File mode"): the whole
// recording is read and framed first, the session is applied at start, then one record per
// animation frame. A transaction whose payloads are not held waits, unapplied, until the fetcher
// has read each from the store and wasm has verified it (Q5 "Fetch"). After the frame that drew a
// requested seq, its state is dumped and its shot read back from the RGB10_A2 target. A clean end
// record writes applied.json with status `ok` and exits 0; a failure writes it with status
// `replay-failure` and exits 3; a usage error writes nothing and exits 2. Live mode (/7, credit,
// G7l) is live.ts's.
//
// The page's fragment (`#token=<hex>`, G7l) is read and removed before anything else runs, so the
// bearer token never reaches the address bar, a log line or any evidence.
//
// The harness reads `window.__rsShell` (the web export shell's contract, gate7-web-legs.ts): the
// printed lines, the exit, a page error, and whether the WebGL context was lost.

import {
  ACCEPT_END,
  ACCEPT_NEEDS_PAYLOADS,
  ACCEPT_RESOURCE,
  ACCEPT_TRANSACTION,
  failWith,
  finish,
  type GswRs,
  hex,
  loadModule,
  log,
  nextFrame,
  nowUs,
  ReplayFailure,
  type SessionMeta,
  setUpCanvas,
  shell,
  statsReader,
  viewportReport,
} from "./common";
import {
  type ReceiverConfig,
  readConfig,
  relativeToOut,
  underOut,
} from "./config";
import {
  appliedJson,
  encodePng,
  put,
  type Report,
  type RustParts,
  type ShellTx,
} from "./evidence";
import { runLive, takeToken } from "./live";
import { type FrameSample, Perf } from "./perf";
import { ProgramError, resolvePrograms } from "./programs";
import { readRecording, SourceError, StoreFetcher } from "./source";

// Before anything else: the fragment's token, then the fragment is gone (G7l, token-not-logged).
const token = takeToken();

async function run(): Promise<void> {
  let cfg: ReceiverConfig;
  try {
    cfg = readConfig(location.search, token);
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    finish(2);
    return;
  }

  const canvas = setUpCanvas(cfg);
  if (cfg.mode === "live") {
    await runLive(cfg, canvas);
    return;
  }

  const report: Report = {
    cfg,
    recording: { path: cfg.recording, sha256: null, bytes: null },
    mode: "file",
    sessionId: null,
    streams: [],
    status: "replay-failure",
    failure: null,
    endSeen: false,
    viewport: {
      display_server: "web",
      size: [0, 0],
      size_check: null,
      logical_size: [0, 0],
      canvas_transform: [],
      presentation_size: null,
      window_size: null,
      oversampling: null,
      presentation_check: null,
      stretch_applied: false,
    },
    shots: [],
    shotsMissed: [],
    sessionUnsupported: [],
    rust: null,
    shell: new Map<string, ShellTx>(),
    fetches: [],
    distinctFetched: 0,
    live: null,
    entries: null,
    protocol: "render-stream/6",
    creditWindow: null,
  };
  let fileStream: Record<string, unknown> | null = null;
  if (cfg.cacheBudgetBytes !== null && cfg.cacheBudgetBytes > 0)
    report.sessionUnsupported.push({
      seq: null,
      item: null,
      name: "cache",
      reason: "cache-budget-unsupported",
    });
  log(
    `mode file, recording ${cfg.recording}, out ${cfg.out}, shot seqs ${cfg.shotSeqs.join(",")}, state seqs ${cfg.stateSeqs.join(",")}, display web, sabotage ${cfg.sabotage.join(",") || "none"}`,
  );

  const perf = new Perf();
  const fetcher = new StoreFetcher(
    cfg.store,
    cfg.fetchDelayMs,
    cfg.log === "full",
  );
  let gs: GswRs | null = null;
  let memory: WebAssembly.Memory | null = null;
  const statePaths = new Map<number, string>();
  let lastAppliedSeq = 0;
  let lastTxSeq = 0;
  let exitCode = 3;

  const writeReport = async (): Promise<void> => {
    if (gs) {
      gs.digest();
      try {
        report.rust = JSON.parse(gs.applied_json_parts()) as RustParts;
      } catch {
        report.rust = null;
      }
    }
    report.fetches = fetcher.fetches;
    report.distinctFetched = fetcher.distinct.size;
    const doc = appliedJson(report);
    if (cfg.perfOut) {
      const perfRel = relativeToOut(cfg, cfg.perfOut);
      await put(
        cfg,
        perfRel,
        `${JSON.stringify(
          perf.report({
            wasm_heap_bytes: memory?.buffer.byteLength ?? null,
            gsw: gs ? JSON.parse(gs.evidence_json()) : null,
          }),
          null,
          2,
        )}\n`,
      );
      await put(
        cfg,
        perfRel.replace(/[^/]*$/, "perf-timeline.jsonl"),
        perf.timeline(),
      );
    }
    // G7s `shader-param-parity` evidence: every item-space binding's uniform values whenever they
    // changed (written whenever any binding existed).
    if (gs) {
      const params = gs.shader_params_jsonl();
      if (params !== "") await put(cfg, "gsw/shader-params.jsonl", params);
    }
    // applied.json last: the harness takes its compositor screenshot while this PUT is held, and
    // the canvas still shows the last drawn frame.
    await put(
      cfg,
      relativeToOut(cfg, cfg.out),
      `${JSON.stringify(doc, null, 2)}\n`,
    );
  };

  try {
    // Step 1 (Q14c): the module, then the recording into wasm memory once, outside every timer.
    const loaded = await loadModule();
    const mod = loaded.mod;
    memory = loaded.memory;
    const mem = memory;

    const data = await readRecording(cfg.recording).catch((e: unknown) => {
      if (e instanceof SourceError)
        throw new ReplayFailure(null, e.reason, e.message);
      throw e;
    });
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>),
    );
    report.recording = {
      path: cfg.recording,
      sha256: hex(digest),
      bytes: data.length,
    };
    fileStream = {
      stream_id: null,
      connection: null,
      received_path: cfg.recording,
      received_sha256: hex(digest),
      received_bytes: data.length,
      end_seen: false,
      closed_by: null,
      close_code: null,
    };
    report.streams.push(fileStream);

    try {
      gs = new mod.GswRs(
        canvas,
        JSON.stringify({
          digest: "deferred",
          sabotage: cfg.sabotage,
          format: "rgb10a2",
        }),
      );
    } catch (e) {
      // An unknown RS_RECEIVER_SABOTAGE is a usage error natively (exit 2, nothing written).
      log(`error: ${String(e)}`);
      finish(2);
      return;
    }
    const g = gs;
    const ptr = g.alloc_recording(data.length);
    new Uint8Array(mem.buffer, ptr, data.length).set(data);
    const recordCount = g.load(data.length);
    if (recordCount < 0) throw failWith(null, g.error());
    if (g.start() < 0) {
      const err = g.error();
      throw failWith(
        null,
        err.includes(": ") ? err : `missing-session: ${err}`,
      );
    }
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    // The session (receiver.gd `_begin_session`): ids, viewport, presentation.
    const session = JSON.parse(g.session_meta()) as SessionMeta;
    report.sessionId = session.session_id ?? null;
    fileStream.stream_id = session.stream?.stream_id ?? null;
    fileStream.connection = session.stream?.connection ?? null;
    const vr = viewportReport(cfg, canvas, session);
    const logical = vr.logical;
    report.sessionUnsupported.push(...vr.unsupported);
    report.viewport = vr.viewport;
    log(
      `session ${report.sessionId} stream ${fileStream.stream_id} (${logical[0]}x${logical[1]}, target ${canvas.width}x${canvas.height}) applied`,
    );
    performance.mark("rs-session-applied");

    // Stats view, re-derived whenever memory grew (Q14c step 5).
    const stats = statsReader(g, mem);

    const shotSeqs = new Set(cfg.shotSeqs);
    const stateSeqs = new Set(cfg.stateSeqs);
    let inlinePending = 0;
    let rafCount = 0;
    let fenceDrawEnd = -1;
    let ended = false;

    for (let i = 1; i < recordCount; i++) {
      const ts = await nextFrame();
      rafCount++;
      perf.raf(ts);
      if (fenceDrawEnd >= 0 && g.poll_fence() === 1) {
        perf.gpuComplete.push(performance.now() - fenceDrawEnd);
        fenceDrawEnd = -1;
      }
      const a = nowUs();
      let code = g.accept(i);
      let decodeUs = nowUs() - a;
      if (code < 0) {
        const err = g.error();
        // receiver.gd: a record that fails is a transaction's (meta seq, else last seq + 1)
        // unless it is a resource record's, which carries no seq.
        throw failWith(err.startsWith("resource-") ? null : lastTxSeq + 1, err);
      }
      if (code === ACCEPT_RESOURCE) {
        inlinePending++;
        continue;
      }
      if (code === ACCEPT_END) {
        ended = true;
        break;
      }
      const st0 = stats();
      const seq = st0.seq;
      lastTxSeq = seq;
      const shellTx: ShellTx = {
        fetched: 0,
        fetched_bytes: 0,
        fetch_us: 0,
        inline_received: inlinePending,
        shader_payload_fetches: 0,
        process_frame: rafCount,
      };
      inlinePending = 0;
      let provideUs = 0;
      if (code === ACCEPT_NEEDS_PAYLOADS) {
        // Q5 "Fetch": one at a time; the transaction waits, unapplied, across frames.
        const n = g.needed_count();
        const hashes = new Uint8Array(
          mem.buffer,
          g.needed_ptr(),
          32 * n,
        ).slice();
        const kinds = new Uint8Array(
          mem.buffer,
          g.needed_kinds_ptr(),
          n,
        ).slice();
        const fetched: { hash: string; bytes: Uint8Array }[] = [];
        for (let k = 0; k < n; k++) {
          const hash = hex(hashes.subarray(32 * k, 32 * k + 32));
          let got: { bytes: Uint8Array; us: number };
          try {
            got = await fetcher.fetch(seq, hash, kinds[k]);
          } catch (e) {
            if (e instanceof SourceError)
              throw new ReplayFailure(seq, e.reason, e.message);
            throw e;
          }
          shellTx.fetched++;
          shellTx.fetched_bytes += got.bytes.length;
          shellTx.fetch_us += got.us;
          if (kinds[k] === 2) shellTx.shader_payload_fetches++;
          perf.fetchUs.push(got.us);
          fetched.push({ hash, bytes: got.bytes });
        }
        await nextFrame();
        rafCount++;
        shellTx.process_frame = rafCount;
        const p0 = nowUs();
        for (const { hash, bytes } of fetched) {
          const pp = g.alloc_payload(bytes.length);
          new Uint8Array(mem.buffer, pp, bytes.length).set(bytes);
          if (g.provide(bytes.length) < 0) {
            // The native cache's codes for a store payload (rs_resource_cache.gd obtain).
            const err = g.error();
            const reason = err.startsWith("resource-hash")
              ? "resource-hash-mismatch"
              : "resource-invalid";
            throw new ReplayFailure(seq, reason, err);
          }
          fetcher.verified(hash);
        }
        provideUs = nowUs() - p0;
        code = ACCEPT_TRANSACTION;
      }
      // G7s: programs for custom shaders this transaction names (once per code hash).
      const q0 = nowUs();
      const programs = await resolvePrograms(
        g,
        mem,
        cfg.shaderLibrary,
        (line) => log(`seq ${seq}: ${line}`),
      ).catch((e: unknown) => {
        if (e instanceof ProgramError)
          throw new ReplayFailure(seq, e.reason, e.message);
        throw e;
      });
      const programUs = nowUs() - q0;
      perf.programs.defined += programs.defined;
      perf.programs.refused += programs.refused;
      perf.programs.library_reads += programs.library_reads;
      const b = nowUs();
      if (g.apply() < 0) throw failWith(seq, g.error());
      const c = nowUs();
      if (g.draw() < 0) throw failWith(seq, g.error());
      const d = nowUs();
      fenceDrawEnd = performance.now();
      const totalUs = decodeUs + provideUs + programUs + (d - b);
      // D31: the deferred record digest, after the frame's timed window.
      const e0 = nowUs();
      g.digest();
      const evidenceUs = nowUs() - e0;
      const st = stats();
      perf.samples.push({
        seq,
        frame: st.frame,
        t_ms: performance.now(),
        decode_us: decodeUs,
        provide_us: provideUs,
        program_us: programUs,
        apply_us: c - b,
        draw_us: d - c,
        total_us: totalUs,
        evidence_hash_us: evidenceUs,
        structural: st.structural,
        relowered: st.relowered,
        rows_written: st.rows_written,
        executed_calls: st.executed_calls,
        texture_upload_bytes: st.texture_upload_bytes,
        item_bytes: st.item_bytes,
        vertex_bytes: st.vertex_bytes,
      } satisfies FrameSample);
      decodeUs = 0;
      report.shell.set(`1:${seq}`, shellTx);
      lastAppliedSeq = seq;

      // Evidence for this seq, after its frame (receiver.gd `_record_transaction`).
      if (stateSeqs.has(seq)) {
        const rel = `state/seq-${seq}.json`;
        await put(cfg, rel, g.state_dump());
        statePaths.set(seq, underOut(cfg, rel));
        log(`state seq ${seq} -> ${underOut(cfg, rel)}`);
      }
      if (shotSeqs.has(seq)) {
        const sp = g.shot();
        if (sp === 0) throw new ReplayFailure(seq, "shot-failed", g.error());
        const w = g.target_width();
        const h = g.target_height();
        const rgba = new Uint8Array(mem.buffer, sp, w * h * 4).slice();
        const rel = `shots/seq-${seq}.png`;
        await put(cfg, rel, await encodePng(rgba, w, h));
        report.shots.push({
          stream: 1,
          seq,
          step: null,
          path: underOut(cfg, rel),
          state_path: statePaths.get(seq) ?? null,
          process_frame: rafCount,
          applied_through: lastAppliedSeq,
        });
        log(
          `shot seq ${seq} -> ${underOut(cfg, rel)} (applied through ${lastAppliedSeq})`,
        );
      }
    }
    if (!ended)
      throw new ReplayFailure(
        null,
        "recording-incomplete",
        "the recording ended before its end record",
      );
    report.endSeen = true;
    fileStream.end_seen = true;
    for (const seq of cfg.shotSeqs)
      if (!report.shots.some((s) => s.seq === seq))
        throw new ReplayFailure(
          seq,
          "shot-unavailable",
          `no transaction seq ${seq} was applied`,
        );
    for (const seq of cfg.stateSeqs)
      if (!statePaths.has(seq))
        throw new ReplayFailure(
          seq,
          "state-unavailable",
          `no transaction seq ${seq} was applied`,
        );
    // D31 record-digest-complete: every accepted record has its digest before the evidence.
    g.digest();
    const pending = stats().digests_pending;
    if (pending > 0)
      throw new ReplayFailure(
        null,
        "record-digest-incomplete",
        `${pending} accepted record(s) without a digest`,
      );
    report.status = "ok";
    exitCode = 0;
  } catch (e) {
    const f =
      e instanceof ReplayFailure
        ? e
        : new ReplayFailure(
            null,
            "receiver-error",
            e instanceof Error ? `${e.message}` : String(e),
          );
    report.failure = { seq: f.seq, reason: f.reason, detail: f.message };
    log(`replay-failure: seq ${f.seq ?? "<null>"} ${f.reason}: ${f.message}`);
    exitCode = 3;
  }
  try {
    await writeReport();
    const parts = report.rust;
    if (exitCode === 0)
      log(
        `ok: ${parts?.transactions.length ?? 0} transactions applied, ${report.shots.length} shots, ${statePaths.size} state dumps, ${(parts?.unsupported.length ?? 0) + report.sessionUnsupported.length} unsupported`,
      );
    for (const u of parts?.unsupported ?? [])
      log(`seq ${u.seq}: unsupported ${u.name} item ${u.item} (${u.reason})`);
  } catch (e) {
    shell.error = `evidence: ${e instanceof Error ? e.message : String(e)}`;
    log(`error: ${shell.error}`);
    exitCode = 3;
  }
  finish(exitCode);
}

run().catch((e: unknown) => {
  shell.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(shell.error);
});
