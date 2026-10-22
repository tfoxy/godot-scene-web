// G7v self-test (protocol/gate7/g7v.md): lib/gate7v-checks.ts's measures and Q13d's decided checks
// over synthetic evidence, the harness words lib/gate7-live-legs.ts maps (RS_RECEIVER_DEV_*), the
// dev probe's FIT switch, and the runner's leg family (lib/gate6c-legs.sh "G7v"). No phone, no
// browser, no Godot.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TimelineLine } from "../lib/gate6c-checks";
import { devProbeScript, mapBrowserLeg } from "../lib/gate7-live-legs";
import {
  acceptance,
  type DevLegEvidence,
  type DevRepeat,
  type DevRunResult,
  devCadenceProblems,
  devHostWindow,
  devMainThreadProblems,
  devRateProblems,
  devUnthrottledProblems,
  measureDevRepeat,
  newFrames,
  ticksPerHostFrame,
} from "../lib/gate7v-checks";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `: ${detail}`}`);
}

// --- synthetic evidence ------------------------------------------------------------------------
// A host at 60 Hz for 40 s; the connection appears at t = 2 s; one transaction per host frame
// published while `everyOther` is false (else every other frame); the receiver draws each one
// the next panel tick (T_p 17 ms, the g31's), clock offset 1 000 000 us.
function synth(opts: {
  kind: "gsw" | "web";
  everyOther?: boolean;
  workMs?: number;
  hiddenMs?: number;
  fold?: boolean;
}): DevLegEvidence {
  const H = 1e6 / 60;
  const timeline: TimelineLine[] = [];
  let sent = 0;
  const tx: Record<string, unknown>[] = [];
  const samples: { seq: number; raf_ts_ms: number; total_us: number; t_ms: number }[] = [];
  const raf: number[] = [];
  const ws: number[] = [];
  const offset = 1e6;
  const tp = 17;
  let seq = 0;
  for (let f = 0; f < 60 * 40; f++) {
    const t = f * H;
    const connected = t >= 2e6;
    const publish = connected && (!opts.everyOther || f % 2 === 0);
    if (publish) {
      sent++;
      seq++;
      const recv = t + offset + 3000;
      const drawMs = Math.ceil(recv / 1000 / tp) * tp;
      const folded = opts.fold && seq % 10 === 0;
      tx.push({
        seq,
        frame: f,
        received_us: recv,
        submitted_us: drawMs * 1000 + 500,
        submitted_process_frame: Math.round(drawMs / tp),
        process_frame: Math.round(drawMs / tp),
        ...(folded ? { coalesced_into: seq + 1 } : {}),
      });
      if (!folded) samples.push({ seq, raf_ts_ms: drawMs, total_us: 2000, t_ms: drawMs + 2 });
    }
    if (f % 60 === 0)
      timeline.push({
        t_us: t,
        frame: f,
        connections: connected
          ? [
              {
                connection: 1,
                sent,
                credits: sent,
                coalesced: 0,
                ticks_credit_blocked: 0,
                max_pending_age_us: 0,
                bytes_sent: sent * 100,
                acks: [sent, sent, sent],
                credit_rtt_count: sent,
                credit_rtt_sum_us: sent * 12000,
                credit_rtt_frames_sum: sent * (opts.everyOther ? 2 : 1),
              },
            ]
          : [],
      });
  }
  // the page clock: rAF every 17 ms from 0 to 40 s; the first message at 2 s + 3 ms.
  const firstWs = 2003;
  for (let ts = 0; ts < 40_000; ts += tp) raf.push(ts, ts + 0.2, opts.workMs ?? 2);
  for (let t = firstWs; t < 40_000; t += 1000 / 60) ws.push(t, 0.3);
  return {
    dir: "/nonexistent",
    leg: {
      leg: "dev-scene-r1",
      base: "scene",
      run: 1,
      workload: "scene",
      time_offset_s: 12,
      soak: false,
      soak_s: 600,
      receiver_max_fps: 0,
      env: "device",
      receiver_words: "",
    },
    steps: [],
    timeline,
    summary: { connections: [{ connection: 1, stream_id: "s1" }] } as never,
    applied: { streams: [{ stream_id: "s1" }], transactions: tx } as never,
    perf: { histograms: { gpu_complete_us: { count: 10, p95: 9000 } } },
    samples: opts.kind === "gsw" ? samples : [],
    probe: {
      schema: "render-stream-gate7-dev-probe/1",
      raf,
      ws,
      mem: [],
      first_ws_ms: firstWs,
      hidden_ms: opts.hiddenMs ?? 0,
    },
    device: { conditions_before: { thermalStatus: "none" }, conditions_after: { thermalStatus: "none" } },
    provenance: { ok: true },
    refused: null,
    timings: { marks: [{ name: "rs-first-submitted", t: 1234 }] },
    exitCode: "0",
  };
}

// The window.
const good = synth({ kind: "gsw" });
const w = devHostWindow(good.timeline, 1, 6, 20);
expect(
  "devHostWindow: anchored at the connection's first line + 6 s, 20 s long",
  typeof w !== "string" && Math.abs(w.start_t_us - 8e6) < 1 && Math.abs(w.end_t_us - 28e6) < 1,
  JSON.stringify(w),
);
expect(
  "devHostWindow: refuses a connection that never appears",
  typeof devHostWindow(good.timeline, 7, 6, 20) === "string",
);

// A good repeat on each receiver.
for (const kind of ["gsw", "web"] as const) {
  const m = measureDevRepeat(kind, synth({ kind }));
  expect(`${kind}: good repeat measures ~60/s published and drawn`, (m.published ?? 0) > 59 && (m.drawn ?? 0) > 57, `${m.published} ${m.drawn}`);
  expect(`${kind}: T_p is the probe's median rAF interval (17 ms)`, Math.abs((m.tp_ms ?? 0) - 17) < 0.01, `${m.tp_ms}`);
  expect(`${kind}: good repeat passes dev-rate, dev-cadence, dev-main-thread, dev-unthrottled`,
    devRateProblems(m).length === 0 && devCadenceProblems(m).length === 0 && devMainThreadProblems(m).length === 0 && devUnthrottledProblems(m, true).length === 0,
    JSON.stringify([devRateProblems(m), devCadenceProblems(m), devMainThreadProblems(m)]));
  expect(`${kind}: good phase class at window 1`, m.phase_class === "good", `${m.phase_class}`);
}

// A bad-phase repeat: ~30/s, 33-ms intervals -> dev-rate and dev-cadence fail.
{
  const m = measureDevRepeat("gsw", synth({ kind: "gsw", everyOther: true }));
  expect("bad phase: published ~30/s fails dev-rate", devRateProblems(m).some((p) => p.includes("published")), devRateProblems(m).join("; "));
  expect("bad phase: 34-ms intervals fail dev-cadence", devCadenceProblems(m).length > 0, devCadenceProblems(m).join("; "));
  expect("bad phase class", m.phase_class === "bad", `${m.phase_class}`);
}
// Heavy main thread: 10 ms per callback > 0.5 * 17.
{
  const m = measureDevRepeat("web", synth({ kind: "web", workMs: 10 }));
  expect("10-ms callbacks fail dev-main-thread", devMainThreadProblems(m).some((p) => p.includes("p95")), devMainThreadProblems(m).join("; "));
}
// Hidden time invalidates (watchdog).
{
  const m = measureDevRepeat("gsw", synth({ kind: "gsw", hiddenMs: 120 }));
  expect("hidden time fails dev-unthrottled", devUnthrottledProblems(m, true).some((p) => p.includes("hidden")));
}
// Folded transactions count as multi-apply ticks (phase-alias's evidence).
{
  const ev = synth({ kind: "gsw", fold: true });
  const nf = newFrames("gsw", ev);
  const m = measureDevRepeat("gsw", ev);
  expect("gsw: a callback that folded a seq is a multi-apply tick", nf.some((f) => f.seqs === 2) && m.multi_apply_ticks > 0, `${m.multi_apply_ticks}`);
}
expect("ticksPerHostFrame: 1 at 60 Hz, 2 at 90 and 120 Hz", ticksPerHostFrame(17) === 1 && ticksPerHostFrame(11.1) === 2 && ticksPerHostFrame(8.3) === 2);

// The acceptance statement.
{
  const pass = (id: string) => ({ id, criterion: "", passed: true, gating: true, detail: "" });
  const fail = (id: string) => ({ ...pass(id), passed: false });
  const leg = (base: string, workload: string, checks: ReturnType<typeof pass>[]) => ({
    base, workload, required: true, report_only: false, repeats: [] as DevRepeat[], checks, presence_detail: [],
  });
  const run = (window: number, ok: boolean): DevRunResult => ({
    group: "g7-dev", kind: "gsw", live: true, arm: "dev-g31", device: "g31", window, run_dir: "", passed: ok,
    checks: [],
    legs: [
      leg("pace", "pace", [ok ? pass("dev-rate@gsw:pace") : fail("dev-rate@gsw:pace")]),
      leg("scene", "scene", [pass("dev-rate@gsw:scene")]),
      leg("gpu-headroom-pace", "pace", [pass("dev-gpu-headroom@gsw:x")]),
      leg("gpu-headroom-scene", "scene", [pass("dev-gpu-headroom@gsw:x")]),
      ...(window === 1 ? [leg("startup-warm", "scene", [pass("dev-startup@gsw")])] : [leg("soak-scene", "scene", [pass("dev-soak@gsw")])]),
    ],
  });
  const a = acceptance([run(1, false), run(2, true)], ["pace", "scene"]);
  expect("acceptance: failing at window 1, passing at window 2 -> met at window 2 only",
    a[0]?.statement === "met at window 2 only (opt-in, F1)", JSON.stringify(a));
  const b = acceptance([run(1, false), run(2, false)], ["pace", "scene"]);
  expect("acceptance: failing at both -> not met, with the failing checks", b[0]?.statement === "not met" && JSON.stringify(b).includes("dev-rate@gsw:pace"), JSON.stringify(b));
}

// Harness words.
{
  const m = mapBrowserLeg(
    "/static",
    [
      ["RS_RECEIVER_MODE", "live"],
      ["RS_RECEIVER_OUT", "/static/x/applied.json"],
      ["RS_RECEIVER_DEV_PROBE", "fit"],
      ["RS_RECEIVER_DEV_SAMPLE", "soak"],
      ["RS_RECEIVER_DEV_KEEP_TAB", "1"],
      ["RS_RECEIVER_DRAW_REPEAT", "2"],
    ],
    ["godot", "--max-fps", "0"],
  );
  expect("mapBrowserLeg: the dev harness words are dropped from the page env and mapped",
    m.devProbe === "fit" && m.devSample === "soak" && m.devTab.keep && !m.devTab.warm &&
      !("RS_RECEIVER_DEV_PROBE" in m.env) && m.env.RS_RECEIVER_DRAW_REPEAT === "2",
    JSON.stringify(m));
  let threw = false;
  try {
    mapBrowserLeg("/static", [["RS_RECEIVER_OUT", "/static/a.json"], ["RS_RECEIVER_DEV_PROBE", "yes"]], ["godot"]);
  } catch {
    threw = true;
  }
  expect("mapBrowserLeg: refuses a bad RS_RECEIVER_DEV_PROBE", threw);
}
expect("devProbeScript: FIT switch set only for `fit`",
  devProbeScript("fit").includes("const FIT = true") && devProbeScript("plain").includes("const FIT = false"));

// The leg family against the runner.
{
  const legs = readFileSync(join(SCRIPTS, "lib", "gate6c-legs.sh"), "utf8");
  const runner = readFileSync(join(SCRIPTS, "run-gate7.sh"), "utf8");
  for (const base of ["pace | scene | hd", "gpu-headroom-*", "maxfps60-scene", "sabotage-ack-on-receipt-scene", "sabotage-draw-repeat-8-*", "soak-* | sabotage-soak-leak-gl-textures-*", "startup-cold | startup-warm"])
    expect(`gate6c-legs.sh g6c_dev_leg handles ${base}`, legs.includes(`\t${base})`));
  expect("run-gate7.sh runs g7-dev's live legs through run-gate6.sh --legs g6c", runner.includes('G6C_LEGS="$g7v_legs"'));
}

console.log(failures === 0 ? "self-test-gate7v: all checks correct" : `self-test-gate7v: ${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
