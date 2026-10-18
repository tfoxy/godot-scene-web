// Gate 7 group g7-r (G7r; protocol/gate7/g7r.md, gate7-design.md D4, Q9, Q13c): publication
// rates, the 60/60 clock-phase study and dual receivers at credit window 1, on the three
// receivers: the native Godot receiver, the Godot web export and the GSW canvas receiver.
//
// G6c's group is reused, unforked: run-gate7.sh --live --legs g7-r runs run-gate6.sh --legs g6c
// once per receiver kind with G6C_LEGS naming that kind's legs (lib/gate6c-legs.sh with receiver
// kinds) into `<out>/gate6/rates-<kind>/`, and this file judges each run with G6c's own loaders,
// measures and evaluators (lib/gate6c-checks.ts). What G7r adds:
//
//   - `phase-60-r1..r5` (and `phase-60-late-poll-r1..r5`, native and web): rate-60's configuration
//     five times. Each run must pass G6c's as-built bound (`rate-achieved`, decided). Each is also
//     classified (`phase-classified`): good when the window's mean credit RTT is at most 1.1 host
//     frames, bad at 1.9 or more, and named `between` otherwise; its published/s, that mean and
//     the receiver hold p50/p95 are reported. The prediction (about half bad on every receiver,
//     fewer with late poll and GSW's in-rAF ack) is reported, never gated.
//   - The receiver hold is G6c's: `received_us` to `submitted_us`. Its meaning differs by
//     receiver, and both are reported. The native and web receivers stamp `received_us` when
//     their main-loop iteration reads the socket, so their hold is the phase-free work from read
//     to ack. GSW stamps it in `onmessage` (arrival), so its hold includes the wait for the next
//     rAF (Q13c's hold), and its phase-free part is the rAF timestamp of the applying callback
//     to the ack (`paced`). dual-independent compares phase-free holds.
//   - `dual-native`: one host (uncapped, --max-fps 60, two connections), receiver-a the run's
//     receiver (a browser on render-stream/7), receiver-b the native receiver on /6.
//     `dual-independent` as G6c built it (A is the browser, its phase-free hold p95 within 10 %
//     of the same kind's rate-uncapped-host60), plus the two connections' versions (7 and 6).
//   - Browser pixels: `final-latest-state` judges a browser's final shot against the native
//     reference under Q7's band (every differing pixel `readback` or `delta1`, G7b's classes);
//     the native receiver's stays exact (budget 0).
//   - Browser legs: Q6's provenance and console, Q8's hello, Q9's `credit-from-paced-loop` (every
//     leg but the sabotage), and the web export's `receiver-core`; the native receivers' core.
//   - `late-poll-active`: each late-poll leg's receiver ran with RS_RECEIVER_LATE_POLL (its
//     applied.json `live.late_poll`), and no other leg did.
//   - `constrained`: G6c's criteria, plus the proxy's observed CORS preflight latency (reported).
//   - `sabotage-ack-on-receipt` (gsw): GRC_PUBLISH_FPS=60 against a GSW receiver at 30 that acks
//     `submitted` from `onmessage`. It must fail exactly `credit-from-paced-loop` and
//     `rate-mismatch`, the latter on its upper bound (published above 1.05 x the receiver's frame
//     rate: credit no longer follows the paced loop, so the host outruns the receiver).
//
// Pure over the run directories (no process launched), so scripts/test/self-test-gate7r.ts
// drives the evaluators with synthetic values.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import {
  connectionOf,
  connRatesOf,
  creditCapacity,
  evaluateCreditRtt,
  evaluateDual,
  evaluateHostUnperturbed,
  evaluateLimitedBy,
  evaluateMismatch60Recv30,
  evaluatePendingBounded,
  evaluatePublishedVsHost,
  evaluateQueueBounded,
  evaluateRateAchieved,
  finalLatestState,
  finalShotPath,
  G6C_DIR,
  G6C_LEGS,
  type G6cLeg,
  type G6cLegEvidence,
  type G6cMeasure,
  legClass,
  limitedBy,
  linkRttUs,
  loadG6cLeg,
  MISMATCH_LOWER_BOUND,
  MISMATCH_UPPER_BOUND,
  measureLeg,
} from "./gate6c-checks";
import { type Gate7Check, mk, readJson } from "./gate7-adapters";
import {
  browserLegProblems,
  fetchImplProblems,
  grepTree,
  helloProblems,
  type PageConfig,
  pacedLoopProblems,
  receiverCoreProblems,
  type SummaryConnection,
} from "./gate7-live";
import { classifyShot } from "./gate7b-adapters";

export type G7rKind = "native" | "web" | "gsw";
export const G7R_KINDS: readonly G7rKind[] = ["native", "web", "gsw"];
export const G7R_PHASE_RUNS = 5;
/** Q9 `phase-classified`: mean credit RTT in host frames. */
export const G7R_GOOD_MAX_FRAMES = 1.1;
export const G7R_BAD_MIN_FRAMES = 1.9;
export const G7R_SABOTAGE_LEG = "sabotage-ack-on-receipt";
/** dual-independent: A's hold p95 also passes within 1 ms of the reference (evaluateDual): GSW's
 * phase-free hold is about 1 ms, ten browser clock quanta (performance.now() is clamped to
 * 100 µs without cross-origin isolation), so 10 % of it is no measurement. */
export const DUAL_HOLD_SLACK_US = 1000;
/** Q9 + g7r.md: the sabotage fails exactly these (rate-mismatch on its upper bound). */
export const G7R_SABOTAGE_FAILS: readonly string[] = [
  "credit-from-paced-loop",
  "rate-mismatch",
];

// ---------------------------------------------------------------------------------------------
// Legs (lib/gate6c-legs.sh with receiver kinds; run-gate7.sh's G7R_LEGS_<kind>)
// ---------------------------------------------------------------------------------------------

export type G7rVariant = "phase" | "late-poll";

export interface G7rLeg extends G6cLeg {
  /** phase-60 runs: which variant, and the run number */
  phase?: { variant: G7rVariant; run: number };
  /** where the receivers are browsers (`a`: receiver-a only, dual-native) */
  browser_receivers: readonly string[];
}

const g6c = (leg: string): G6cLeg => {
  const def = G6C_LEGS.find((d) => d.leg === leg);
  if (!def) throw new Error(`gate7r: no g6c leg ${leg}`);
  return def;
};

/** The receiver's --max-fps where G6c's native receiver runs at 60 (lib/gate6c-legs.sh
 * G6C_RECV60): rAF-bound (0) in a browser. */
const recv60 = (kind: G7rKind): number => (kind === "native" ? 60 : 0);

function withKind(def: G6cLeg, kind: G7rKind): G7rLeg {
  return {
    ...def,
    receivers: def.receivers.map((r) => ({
      ...r,
      max_fps: r.max_fps === 60 ? recv60(kind) : r.max_fps,
    })),
    browser_receivers: kind === "native" ? [] : def.receivers.map((r) => r.dir),
  };
}

function phaseLeg(kind: G7rKind, variant: G7rVariant, run: number): G7rLeg {
  const name =
    variant === "phase" ? `phase-60-r${run}` : `phase-60-late-poll-r${run}`;
  return {
    ...withKind(g6c("rate-60"), kind),
    leg: name,
    phase: { variant, run },
  };
}

/** Each kind's legs, in run order (run-gate7.sh G7R_LEGS_<kind>). */
export function g7rLegs(kind: G7rKind): G7rLeg[] {
  const out: G7rLeg[] = [withKind(g6c("rate-baseline"), kind)];
  if (kind !== "native")
    for (const leg of [
      "rate-15",
      "rate-30",
      "rate-60",
      "rate-uncapped-host60",
      "rate-uncapped",
      "mismatch-60-recv30",
    ])
      out.push(withKind(g6c(leg), kind));
  for (let r = 1; r <= G7R_PHASE_RUNS; r++)
    out.push(phaseLeg(kind, "phase", r));
  if (kind !== "gsw")
    for (let r = 1; r <= G7R_PHASE_RUNS; r++)
      out.push(phaseLeg(kind, "late-poll", r));
  if (kind !== "native") {
    out.push({
      ...withKind(g6c("dual-60-15"), kind),
      leg: "dual-native",
      receivers: [
        { dir: "receiver-a", max_fps: recv60(kind) },
        { dir: "receiver-b", max_fps: 60 },
      ],
      browser_receivers: ["receiver-a"],
    });
    out.push(withKind(g6c("constrained"), kind));
  }
  if (kind === "gsw")
    out.push({
      ...withKind(g6c("mismatch-60-recv30"), kind),
      leg: G7R_SABOTAGE_LEG,
      receivers: [{ dir: "receiver", max_fps: 30 }],
    });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Phase classification and holds
// ---------------------------------------------------------------------------------------------

export type PhaseClass = "good" | "bad" | "between";

/** Q9: good at a window mean credit RTT <= 1.1 host frames, bad at >= 1.9, else between. */
export function phaseClass(meanFrames: number): PhaseClass {
  if (meanFrames <= G7R_GOOD_MAX_FRAMES) return "good";
  if (meanFrames >= G7R_BAD_MIN_FRAMES) return "bad";
  return "between";
}

interface PacedTx {
  seq?: number;
  received_us?: number | null;
  submitted_us?: number | null;
  paced?: {
    applied_raf_ts_ms?: number | null;
    submitted_ack_ms?: number | null;
    submitted_from?: string | null;
  };
}

function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

/** GSW's phase-free hold per acked transaction (µs): the applying rAF callback's timestamp to
 * the `submitted` ack sent from it. Empty for any other receiver. */
export function gswPhaseFreeHolds(transactions: readonly PacedTx[]): number[] {
  const out: number[] = [];
  for (const t of transactions) {
    const p = t.paced;
    if (
      p?.submitted_from === "raf" &&
      typeof p.submitted_ack_ms === "number" &&
      typeof p.applied_raf_ts_ms === "number"
    )
      out.push(Math.max(0, (p.submitted_ack_ms - p.applied_raf_ts_ms) * 1000));
  }
  return out;
}

export interface PhaseRow {
  kind: G7rKind;
  /** native, native-late-poll, web, web-late-poll, gsw */
  variant: string;
  leg: string;
  run: number;
  published: number | null;
  host_frame: number | null;
  credit_rtt_mean_frames: number | null;
  credit_rtt_mean_us: number | null;
  credit_capacity: number | null;
  /** G6c's hold: received_us to submitted_us (GSW: from onmessage) */
  hold_p50_us: number | null;
  hold_p95_us: number | null;
  /** GSW only: applying rAF timestamp to the submitted ack */
  phase_free_hold_p50_us: number | null;
  phase_free_hold_p95_us: number | null;
  receiver_frame: number | null;
  class: PhaseClass | null;
  /** the connection's whole-run median credit RTT in host frames (live-summary.json) and the
   * class it gives: robust to a tail of fetch-holding transactions, which moves the mean */
  credit_rtt_frames_median: number | null;
  class_median: PhaseClass | null;
  rate_achieved: boolean;
}

// ---------------------------------------------------------------------------------------------
// The fetch tail (why a rate below the host's frame rate can miss its target)
// ---------------------------------------------------------------------------------------------

interface FetchTx {
  received_us?: number | null;
  submitted_us?: number | null;
  resources?: { fetched?: number } | null;
}

export interface FetchTail {
  /** each payload GET's duration in the receiver (applied.json `fetches`), p50/p95 µs */
  fetch_p50_us: number | null;
  fetch_p95_us: number | null;
  fetches: number;
  /** transactions whose hold (received to submitted) exceeded two host frames, and how many of
   * those waited for a fetch */
  long_holds: number;
  long_holds_fetching: number;
}

/** The receiver's fetch tail: a transaction that needs a payload holds its credit for the GET. */
export function fetchTail(
  applied:
    | {
        transactions?: FetchTx[] | null;
        fetches?: { start_us?: number; end_us?: number }[] | null;
      }
    | undefined,
  hostFrameUs = 16_667,
): FetchTail {
  const d = (applied?.fetches ?? [])
    .filter(
      (f) => typeof f.start_us === "number" && typeof f.end_us === "number",
    )
    .map((f) => (f.end_us ?? 0) - (f.start_us ?? 0));
  const long = (applied?.transactions ?? []).filter(
    (t) =>
      typeof t.submitted_us === "number" &&
      typeof t.received_us === "number" &&
      t.submitted_us - t.received_us > 2 * hostFrameUs,
  );
  return {
    fetch_p50_us: quantile(d, 0.5),
    fetch_p95_us: quantile(d, 0.95),
    fetches: d.length,
    long_holds: long.length,
    long_holds_fetching: long.filter((t) => (t.resources?.fetched ?? 0) > 0)
      .length,
  };
}

/** A rate leg below its host's frame rate (target period P > 1 callback) that missed G6c's bound
 * only because of the receiver's fetch tail: at least 90 % of its long holds waited for a GET and
 * the median GET took more than the period minus one callback, so a fetching transaction's credit
 * returns after the next due tick. The verdict stays FAILING (D1: the receiver did not achieve the
 * rate); this names the measured cause. */
export function fetchTailCause(
  def: G6cLeg,
  tail: FetchTail,
  hostFrame: number | null,
): string | undefined {
  const target = def.target_fps;
  if (!target || !hostFrame || target >= hostFrame) return undefined;
  const periodUs = 1e6 / target - 1e6 / hostFrame;
  if (
    tail.long_holds > 0 &&
    tail.long_holds_fetching >= 0.9 * tail.long_holds &&
    (tail.fetch_p50_us ?? 0) > periodUs
  )
    return `the receiver's fetch tail: ${tail.long_holds_fetching} of ${tail.long_holds} holds over two host frames waited for a payload GET, and a GET took ${fmt((tail.fetch_p50_us ?? 0) / 1000, 1)} ms (p50), more than the ${fmt(periodUs / 1000, 1)} ms a ${fmt(1000 / target, 1)} ms publication period leaves after its own callback, so each such transaction's credit returns after the next due tick`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Pixels under Q7's band
// ---------------------------------------------------------------------------------------------

/** final-latest-state for a browser receiver: its final shot against the native reference, every
 * differing pixel `readback` or `delta1` (G7b's band); the frame must be at or after step 11. */
export async function bandedFinalState(
  ev: G6cLegEvidence,
  receiverIndex: number,
): Promise<{ problems: string[]; detail: string }> {
  const r = ev.receivers[receiverIndex];
  const name = basename(r.dir);
  const step11 = ev.steps.find((s) => s.step === 11);
  if (!step11) return { problems: ["the host logged no step 11"], detail: "" };
  const shot = (r.applied?.shots ?? []).find((s) => s.final === true);
  if (!shot?.path) return { problems: [`${name}: no final shot`], detail: "" };
  const problems: string[] = [];
  if ((shot.frame ?? -1) < step11.applied_frame)
    problems.push(
      `${name}: the final shot is of frame ${shot.frame}, before step 11 at ${step11.applied_frame}`,
    );
  const ref = await decodePngRgba(ev.reference_shot);
  const got = await decodePngRgba(finalShotPath(r.dir, shot.path));
  if (!ref || !got)
    return {
      problems: [
        ...problems,
        `${name}: the final shot or reference is unreadable`,
      ],
      detail: "",
    };
  if (ref.width !== got.width || ref.height !== got.height)
    return {
      problems: [
        ...problems,
        `${name}: ${got.width}x${got.height} vs reference ${ref.width}x${ref.height}`,
      ],
      detail: "",
    };
  const c = classifyShot(ref.data, got.data);
  if (c.other > 0)
    problems.push(
      `${name}: ${c.other} px beyond Q7's band (max channel delta ${c.other_max_delta})`,
    );
  return {
    problems,
    detail: `${name} seq ${shot.seq} frame ${shot.frame} (step 11 at ${step11.applied_frame}): ${c.identical} identical, ${c.readback} readback, ${c.delta1} delta1, ${c.other} other of ${c.pixels}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The sabotage
// ---------------------------------------------------------------------------------------------

/** g7r.md: the ack-on-receipt sabotage fails exactly credit-from-paced-loop and rate-mismatch,
 * and rate-mismatch on its upper bound, never its lower one. `failing` maps each failing check
 * id to its problems. */
export function sabotageProblems(
  failing: ReadonlyMap<string, readonly string[]>,
): string[] {
  const p: string[] = [];
  const ids = [...failing.keys()].sort();
  if (JSON.stringify(ids) !== JSON.stringify([...G7R_SABOTAGE_FAILS].sort()))
    p.push(
      `failing ${ids.join(", ") || "nothing"}, expected exactly ${G7R_SABOTAGE_FAILS.join(", ")}`,
    );
  const mismatch = failing.get("rate-mismatch") ?? [];
  if (
    failing.has("rate-mismatch") &&
    !mismatch.some((m) => m.startsWith(MISMATCH_UPPER_BOUND))
  )
    p.push("rate-mismatch failed, but not on its upper bound");
  if (mismatch.some((m) => m.startsWith(MISMATCH_LOWER_BOUND)))
    p.push(
      "rate-mismatch failed its lower bound (the host did not stay prompt)",
    );
  return p;
}

// ---------------------------------------------------------------------------------------------
// One kind's run
// ---------------------------------------------------------------------------------------------

export interface G7rKindResult {
  group: "g7-r";
  kind: G7rKind;
  live: true;
  passed: boolean;
  run_dir: string;
  checks: Gate7Check[];
  phase: PhaseRow[];
  /** per leg: G6c's rate numbers for the result doc */
  rates: Record<string, Record<string, unknown>>;
}

interface ReceiverKindJson {
  kind?: string;
  web_core?: string;
  native_core?: string;
}

const fmt = (v: number | null | undefined, d = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "?" : v.toFixed(d);

function variantName(kind: G7rKind, v: G7rVariant): string {
  return v === "phase" ? kind : `${kind}-late-poll`;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The measure of a leg with receiver i's hold p95 replaced by its phase-free one (GSW). */
function phaseFreeMeasure(
  m: G6cMeasure,
  ev: G6cLegEvidence,
  kind: G7rKind,
  i: number,
): G6cMeasure {
  if (kind !== "gsw") return m;
  const tx = (ev.receivers[i]?.applied?.transactions ?? []) as PacedTx[];
  const p95 = quantile(gswPhaseFreeHolds(tx), 0.95);
  return {
    ...m,
    receivers: m.receivers.map((r, j) =>
      j === i ? { ...r, hold_p95_us: p95 } : r,
    ),
  };
}

export async function checkG7rKind(
  out: string,
  kind: G7rKind,
  expectedWebCore: "gdscript" | "rust",
  /** G7wf: the web export's expected payload GET mechanism (run-gate7.sh --web-fetch). */
  expectedWebFetch: "fetch" | "httpclient" = "fetch",
): Promise<G7rKindResult> {
  const runDir = join(out, "gate6", `rates-${kind}`);
  const ratesDir = join(runDir, G6C_DIR);
  const checks: Gate7Check[] = [];
  const phase: PhaseRow[] = [];
  const rates: Record<string, Record<string, unknown>> = {};
  const at = (id: string) => `${id}@${kind}`;
  const defs = g7rLegs(kind);
  const legsRun = readText(join(ratesDir, "legs-run.txt"))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const rk = await readJson<ReceiverKindJson>(
    join(ratesDir, "receiver-kind.json"),
  );
  const runProblems: string[] = [];
  if (!existsSync(ratesDir)) runProblems.push(`no ${ratesDir}`);
  if (rk?.kind !== kind)
    runProblems.push(`receiver-kind.json kind ${rk?.kind}, want ${kind}`);
  for (const d of defs)
    if (!legsRun.includes(d.leg)) runProblems.push(`leg ${d.leg} not run`);
  checks.push(
    mk(
      at("g7r-run"),
      "G7r: run-gate6.sh --legs g6c ran every leg of this receiver kind (lib/gate6c-legs.sh with receiver kinds)",
      runProblems,
      `${defs.length} legs in ${runDir}`,
    ),
  );

  const evs = new Map<string, G6cLegEvidence>();
  const ms = new Map<string, G6cMeasure>();
  for (const def of defs) {
    if (!legsRun.includes(def.leg)) continue;
    const ev = await loadG6cLeg(ratesDir, def);
    evs.set(def.leg, ev);
    ms.set(def.leg, measureLeg(ev));
  }
  const base = ms.get("rate-baseline");
  const uncappedHost60 = ms.get("rate-uncapped-host60");
  const uncappedHost60Ev = evs.get("rate-uncapped-host60");
  const refHoldP95 =
    uncappedHost60 && uncappedHost60Ev
      ? (phaseFreeMeasure(uncappedHost60, uncappedHost60Ev, kind, 0)
          .receivers[0]?.hold_p95_us ?? null)
      : null;

  // Gate 7's per-browser-leg checks, and the core and late-poll checks, over every receiver dir.
  const prov: string[] = [];
  const consoleBad: string[] = [];
  const hello: string[] = [];
  const paced: string[] = [];
  const coreBad: string[] = [];
  const fetchBad: string[] = [];
  let fetchLegs = 0;
  let fetchGets = 0;
  const latePoll: string[] = [];
  let helloConnections = 0;
  let pacedLegs = 0;
  let sabotagePaced: string[] = [];
  const expectedKind = kind === "web" ? "web-export" : "gsw-canvas";
  const nativeCore = rk?.native_core ?? "gdscript";

  for (const def of defs) {
    const ev = evs.get(def.leg);
    const m = ms.get(def.leg);
    if (!ev || !m) continue;
    const L = def.leg;
    const own: [string, string, string[]][] = [];
    const linkRtt = linkRttUs(ev, m, ms.get("rate-60"));
    const cls = legClass(ev);
    checks.push(
      mk(
        at(`leg-class-${L}`),
        `${L}: ${def.expected_class}`,
        cls.cls === def.expected_class
          ? []
          : [`class ${cls.cls}: ${cls.reasons.join("; ")}`],
        cls.cls,
      ),
    );
    const c0 = connRatesOf(m, 0);
    const summary0 = ev.receivers[0]
      ? connectionOf(ev.receivers[0], ev.summary)
      : undefined;
    rates[L] = {
      requested: def.target_fps,
      host_frame: m.host_frame,
      published: ev.receivers.map(
        (_, i) => connRatesOf(m, i)?.published ?? null,
      ),
      applied: ev.receivers.map((_, i) => connRatesOf(m, i)?.applied ?? null),
      submitted: ev.receivers.map(
        (_, i) => connRatesOf(m, i)?.submitted ?? null,
      ),
      receiver_frame: m.receivers.map((r) => r.receiver_frame),
      credit_rtt_mean_frames: ev.receivers.map(
        (_, i) => connRatesOf(m, i)?.credit_rtt_mean_frames ?? null,
      ),
      credit_capacity: ev.receivers.map((_, i) =>
        creditCapacity(m, connRatesOf(m, i)),
      ),
      credit_rtt_us: ev.receivers.map(
        (r) => connectionOf(r, ev.summary)?.credit_rtt_us ?? null,
      ),
      hold_p50_us: m.receivers.map((r) => r.hold_p50_us),
      hold_p95_us: m.receivers.map((r) => r.hold_p95_us),
      ticks_credit_blocked: ev.receivers.map(
        (_, i) => connRatesOf(m, i)?.ticks_credit_blocked ?? null,
      ),
      host_frame_interval_p95_us: m.frame_interval_p95_us,
      window_s: m.window?.seconds ?? null,
      presented: "unavailable",
    };
    if (kind === "gsw") {
      const perf = ev.receivers.map(
        (r) =>
          r.perf as unknown as {
            histograms?: Record<string, { p50?: number; p95?: number }>;
          },
      );
      rates[L].gsw = ev.receivers.map((r, i) => {
        const tx = (r.applied?.transactions ?? []) as PacedTx[];
        const pf = gswPhaseFreeHolds(tx);
        const h = perf[i]?.histograms ?? {};
        return {
          phase_free_hold_p50_us: quantile(pf, 0.5),
          phase_free_hold_p95_us: quantile(pf, 0.95),
          raf_after_submit_us: {
            p50: h.raf_after_submit_us?.p50 ?? null,
            p95: h.raf_after_submit_us?.p95 ?? null,
          },
          gpu_complete_us: {
            p50: h.gpu_complete_us?.p50 ?? null,
            p95: h.gpu_complete_us?.p95 ?? null,
          },
        };
      });
    }
    switch (def.kind) {
      case "baseline": {
        const p: string[] = m.window
          ? []
          : [`no measured window: ${m.window_problem}`];
        if (!m.frame_interval_p95_us || !m.callback_p50_us)
          p.push("perf.json lacks frame_interval_us or frame_callback_us");
        own.push([
          "baseline-recorded",
          "rate-baseline records host frame interval and callback time (the host-unperturbed reference)",
          p,
        ]);
        break;
      }
      case "rate": {
        const target = def.target_fps ?? 0;
        const problems = evaluateRateAchieved(m, target, {
          appliedChecks: true,
        });
        const tail = fetchTail(
          ev.receivers[0]?.applied as Parameters<typeof fetchTail>[0],
        );
        rates[L].fetch_tail = tail;
        const cause =
          problems.length > 0
            ? fetchTailCause(def, tail, m.host_frame)
            : undefined;
        if (cause) problems.push(`known: ${cause}`);
        own.push([
          "rate-achieved",
          `published in [0.95 x min(${target}, credit capacity), 1.02 x ${target}]; applied within 2 % of published; submitted = applied +- 1; receiver frame rate in [57, 61] (G6c as built)`,
          problems,
        ]);
        if (def.phase) {
          const frames = c0?.credit_rtt_mean_frames ?? null;
          const pf =
            kind === "gsw"
              ? gswPhaseFreeHolds(
                  (ev.receivers[0]?.applied?.transactions ?? []) as PacedTx[],
                )
              : [];
          const median =
            (summary0 as SummaryConnection | undefined)?.credit_rtt_frames
              ?.median ?? null;
          const row: PhaseRow = {
            kind,
            variant: variantName(kind, def.phase.variant),
            leg: L,
            run: def.phase.run,
            published: c0?.published ?? null,
            host_frame: m.host_frame,
            credit_rtt_mean_frames: frames,
            credit_rtt_mean_us: c0?.credit_rtt_mean_us ?? null,
            credit_capacity: creditCapacity(m, c0),
            hold_p50_us: m.receivers[0]?.hold_p50_us ?? null,
            hold_p95_us: m.receivers[0]?.hold_p95_us ?? null,
            phase_free_hold_p50_us: quantile(pf, 0.5),
            phase_free_hold_p95_us: quantile(pf, 0.95),
            receiver_frame: m.receivers[0]?.receiver_frame ?? null,
            class: frames === null ? null : phaseClass(frames),
            credit_rtt_frames_median: median,
            class_median: median === null ? null : phaseClass(median),
            rate_achieved: problems.length === 0,
          };
          phase.push(row);
          own.push([
            "phase-classified",
            `Q9: published/s, the window's mean credit RTT in host frames and the receiver hold p50/p95 reported; good at <= ${G7R_GOOD_MAX_FRAMES} frames, bad at >= ${G7R_BAD_MIN_FRAMES}, between named`,
            frames === null ? ["no credit round trip inside the window"] : [],
          ]);
        }
        break;
      }
      case "uncapped-host60":
        own.push([
          "published-vs-host",
          "uncapped at --max-fps 60: published >= 0.95 x min(host frame rate, credit capacity)",
          evaluatePublishedVsHost(m),
        ]);
        break;
      case "uncapped": {
        const l = limitedBy(m, 0, linkRtt);
        rates[L].limited_by = l;
        own.push([
          "limited-by",
          "uncapped, --max-fps 0 (the receiver rAF-bound): limited_by reported with its evidence; published >= 0.95 x min(host frame rate, credit capacity)",
          evaluateLimitedBy(m, l),
        ]);
        checks.push(
          mk(
            at(`limited-by-predicted-${L}`),
            `${L}: Q9's prediction, limited_by credit (rAF-bound); reported, not gating`,
            l.limited_by === "credit" ? [] : [`limited_by ${l.limited_by}`],
            `limited_by ${l.limited_by} (published ${fmt(l.published)}/s, host ${fmt(l.host_frame, 0)}/s, credit capacity ${fmt(l.credit_capacity)}/s, RTT mean ${fmt(l.credit_rtt_mean_us, 0)} us)`,
            false,
          ),
        );
        break;
      }
      case "mismatch-60-recv30":
        own.push([
          "rate-mismatch",
          "target 60, receiver 30: published in [0.95 x min(60, credit capacity), 1.05 x receiver frame rate]; ticks_credit_blocked > 0",
          evaluateMismatch60Recv30(m),
        ]);
        own.push([
          "host-unperturbed",
          "host frame-interval p95 within 5 % and frame rate within 2 % of rate-baseline",
          evaluateHostUnperturbed(m, base),
        ]);
        break;
      case "dual": {
        const mA = phaseFreeMeasure(m, ev, kind, 0);
        const p = evaluateDual(mA, refHoldP95, DUAL_HOLD_SLACK_US);
        const conns = ev.receivers.map(
          (r) => connectionOf(r, ev.summary) as SummaryConnection | undefined,
        );
        const versions = conns.map((c) => c?.version ?? null);
        if (versions[0] !== 7 || versions[1] !== 6)
          p.push(
            `connection versions ${JSON.stringify(versions)} (receiver-a, receiver-b), want [7, 6]`,
          );
        rates[L].versions = versions;
        own.push([
          "dual-independent",
          `G6c's dual-independent with A the ${kind} receiver (/7) and B native (/6), both at 60: each served promptly, B never above its frame rate, A's ${kind === "gsw" ? "phase-free " : ""}hold p95 within 10 % (or 1 ms) of rate-uncapped-host60's, one snapshot copy per host frame; the two connections on versions 7 and 6`,
          p,
        ]);
        break;
      }
      case "constrained": {
        rates[L].proxy = ev.proxy;
        own.push([
          "credit-rtt",
          "constrained: credit RTT p50 >= 60 ms",
          evaluateCreditRtt(summary0),
        ]);
        own.push([
          "pending-bounded",
          "max_pending <= 1, max_in_flight <= 1, queued bytes <= one transaction + control frames",
          evaluatePendingBounded(summary0),
        ]);
        own.push([
          "queue-bounded",
          "host max_queued_bytes <= largest message + 64 KiB",
          evaluateQueueBounded(summary0),
        ]);
        own.push([
          "host-unperturbed",
          "host frame-interval p95 within 5 % and frame rate within 2 % of rate-baseline",
          evaluateHostUnperturbed(m, base),
        ]);
        const http = (
          ev.proxy as
            | { http?: Record<string, Record<string, number | null>> }
            | undefined
        )?.http;
        const pre = http?.preflight;
        checks.push(
          mk(
            at(`preflight-latency-${L}`),
            `${L}: Q9 "plus preflight latency reported": the CORS preflights the proxy saw (OPTIONS to its 204 delivered, the link's delay both ways included) beside the plain GETs; reported, not gating`,
            pre ? [] : ["the proxy's stats.json has no http block"],
            pre
              ? `preflights ${pre.count}: p50 ${fmt(pre.p50_ms, 1)} ms, p95 ${fmt(pre.p95_ms, 1)} ms, max ${fmt(pre.max_ms, 1)} ms; GETs ${http?.get?.count}: p50 ${fmt(http?.get?.p50_ms, 1)} ms, p95 ${fmt(http?.get?.p95_ms, 1)} ms; host preflights ${(summary0 as { preflights?: number } | undefined)?.preflights ?? "?"}`
              : "",
            false,
          ),
        );
        break;
      }
      default:
        break;
    }
    // final-latest-state: banded for a browser receiver, exact (G6c) for a native one.
    if (ev.receivers.length > 0) {
      const p: string[] = [];
      const detail: string[] = [];
      for (let i = 0; i < ev.receivers.length; i++) {
        const dirName = basename(ev.receivers[i].dir);
        if (def.browser_receivers.includes(dirName)) {
          const b = await bandedFinalState(ev, i);
          p.push(...b.problems);
          if (b.detail) detail.push(b.detail);
        } else {
          const one: G6cLegEvidence = {
            ...ev,
            receivers: [ev.receivers[i]],
          };
          const f = await finalLatestState(one);
          p.push(...f.problems);
          detail.push(...f.detail);
        }
      }
      rates[L].final_state = detail;
      own.push([
        "final-latest-state",
        "the final shot (after step 11's freeze) equals the reference's step 11 with the host's leftovers: exact for a native receiver, within Q7's band (readback/delta1) for a browser",
        [...p, ...(p.length > 0 ? detail : [])],
      ]);
    }

    // Per receiver directory: browser basics, hello, paced loop, core and late poll.
    let legPaced: string[] = [];
    for (let i = 0; i < ev.receivers.length; i++) {
      const r = ev.receivers[i];
      const dirName = basename(r.dir);
      const rel = `${L}/${dirName}`;
      const applied = await readJson<{
        receiver?: { kind?: string; core?: string };
        live?: { late_poll?: boolean };
      }>(join(r.dir, "applied.json"));
      const wantLate = def.phase?.variant === "late-poll";
      if ((applied?.live?.late_poll === true) !== wantLate)
        latePoll.push(
          `${rel}: applied.json live.late_poll ${applied?.live?.late_poll ?? "absent"}, want ${wantLate}`,
        );
      if (def.browser_receivers.includes(dirName)) {
        const basics = await browserLegProblems(r.dir, rel);
        prov.push(...basics.provenance);
        consoleBad.push(...basics.console);
        if (kind === "web") {
          coreBad.push(
            ...(await receiverCoreProblems(r.dir, rel, expectedWebCore)),
          );
          const f = await fetchImplProblems(r.dir, rel, expectedWebFetch);
          fetchBad.push(...f.problems);
          if (f.judged) fetchLegs++;
          fetchGets += f.fetches;
        }
        const page = await readJson<PageConfig>(
          join(r.dir, "page-config.json"),
        );
        const conn = connectionOf(r, ev.summary) as
          | SummaryConnection
          | undefined;
        if (!conn) hello.push(`${rel}: no host connection summary`);
        else {
          helloConnections++;
          const bad = helloProblems(conn, page, expectedKind);
          if (bad.length > 0)
            hello.push(`${rel} conn ${conn.connection}: ${bad.join(", ")}`);
        }
        if (applied)
          legPaced = [...legPaced, ...pacedLoopProblems(rel, applied)];
      } else if (applied && applied.receiver?.core !== nativeCore) {
        coreBad.push(
          `${rel}: native applied.json receiver.core ${applied.receiver?.core}, want ${nativeCore}`,
        );
      }
    }
    if (def.browser_receivers.length > 0) {
      if (L === G7R_SABOTAGE_LEG) sabotagePaced = legPaced;
      else {
        pacedLegs++;
        paced.push(...legPaced);
      }
    }

    if (L === G7R_SABOTAGE_LEG) {
      const all: [string, string[]][] = [
        ["leg-class", cls.cls === def.expected_class ? [] : [cls.cls]],
        ...own.map(([id, , p]): [string, string[]] => [id, p]),
        ["credit-from-paced-loop", sabotagePaced],
      ];
      const failing = new Map(all.filter(([, p]) => p.length > 0));
      checks.push(
        mk(
          at(`sabotage-${L}`),
          `${L}: GSW acks submitted from onmessage at a 30 fps receiver against a 60/s host; must fail exactly ${G7R_SABOTAGE_FAILS.join(" and ")} (rate-mismatch on its upper bound)`,
          sabotageProblems(failing),
          all
            .map(
              ([id, p]) =>
                `${id} ${p.length > 0 ? `FAIL (${p.slice(0, 2).join("; ").slice(0, 300)})` : "pass"}`,
            )
            .join("; "),
        ),
      );
      continue;
    }
    for (const [id, criterion, problems] of own)
      checks.push(
        mk(
          at(`${id}-${L}`),
          `${L}: ${criterion}`,
          problems,
          describeLeg(id, m, rates[L]),
        ),
      );
  }

  if (kind !== "native") {
    checks.push(
      mk(
        at("browser-provenance"),
        "Q6: every browser leg ran the pinned Chromium with D9's flags, the real GPU, no Wayland FD",
        prov,
        "every browser leg",
      ),
    );
    checks.push(
      mk(
        at("console-clean"),
        "Q6: no browser leg logged a SHADER ERROR, a `WebGL: ` error or an uncaught page error",
        consoleBad,
        "every browser leg clean",
      ),
    );
    checks.push(
      mk(
        at("hello-recorded"),
        "Q8: each browser connection's host summary shows the /7 hello (version 7, the receiver kind, window 1 granted, the presentation integers at DPR 1, the harness origin)",
        helloConnections === 0 ? ["no browser connection recorded"] : hello,
        `${helloConnections} browser connections`,
      ),
    );
    checks.push(
      mk(
        at("credit-from-paced-loop"),
        "Q9: every `submitted` ack follows the rAF callback that applied that seq and drew (every leg but the ack-on-receipt sabotage)",
        pacedLegs === 0 ? ["no browser leg"] : paced,
        `${pacedLegs} legs`,
      ),
    );
  }
  if (kind !== "native") {
    // token-not-logged (G2e/Q8) over the whole run: every host token (the constrained leg's).
    const tokens: { leg: string; token: string; path: string }[] = [];
    for (const leg of existsSync(ratesDir) ? readdirSync(ratesDir) : []) {
      const path = join(ratesDir, leg, "host", "evidence", "live-token");
      if (existsSync(path))
        tokens.push({ leg, token: readText(path).trim(), path });
    }
    const hits: string[] = [];
    const exclude = new Set(tokens.map((t) => t.path));
    for (const t of tokens) {
      if (t.token === "") continue;
      for (const hit of await grepTree(runDir, t.token, exclude))
        hits.push(`${t.leg}'s token in ${hit}`);
    }
    checks.push(
      mk(
        at("token-not-logged"),
        "Q8/G2e: no host token appears in any file of the run but its own evidence/live-token (the browser profiles excluded)",
        tokens.length === 0
          ? [
              "no leg ran with a token (constrained runs with GRC_LIVE_AUTH=token)",
            ]
          : hits,
        `${tokens.length} tokens, none logged`,
      ),
    );
  }
  checks.push(
    mk(
      at("receiver-core"),
      kind === "web"
        ? `G7xwl/D34: every web leg decoded and applied through the ${expectedWebCore} core, and every native receiver (dual-native's /6 one) through ${nativeCore}`
        : `D34 (amended): every native receiver decoded and applied through ${nativeCore} (applied.json receiver.core)`,
      coreBad,
      kind === "web"
        ? `web ${expectedWebCore}, native ${nativeCore}`
        : nativeCore,
    ),
  );
  if (kind === "web")
    checks.push(
      mk(
        at("fetch-impl"),
        expectedWebFetch === "fetch"
          ? "G7wf: every web leg fetched its payloads with the browser's fetch() (applied.json live.fetch_impl browser-fetch)"
          : "G7wf (the A/B's pre-G7wf arm): every web leg fetched its payloads with Godot's web HTTPClient (live.fetch_impl httpclient)",
        fetchLegs === 0 ? ["no web leg wrote applied.json live"] : fetchBad,
        `${fetchLegs} web receivers, ${fetchGets} GETs`,
      ),
    );
  if (kind !== "gsw")
    checks.push(
      mk(
        at("late-poll-active"),
        "Q4 Late poll: every phase-60-late-poll run's receiver ran with RS_RECEIVER_LATE_POLL=1 (applied.json live.late_poll), and no other receiver did",
        latePoll,
        `${defs.filter((d) => d.phase?.variant === "late-poll").length} late-poll runs`,
      ),
    );
  // The variants' phase summary (reported; Q9's prediction is never gated).
  for (const variant of [...new Set(phase.map((r) => r.variant))]) {
    const rows = phase.filter((r) => r.variant === variant);
    const n = (c: PhaseClass) => rows.filter((r) => r.class === c).length;
    const line = `${n("good")} good, ${n("bad")} bad, ${n("between")} between of ${rows.length}: ${rows.map((r) => `r${r.run} ${fmt(r.published, 1)}/s mean ${fmt(r.credit_rtt_mean_frames)}f ${r.class} (median ${fmt(r.credit_rtt_frames_median)}f ${r.class_median})`).join(", ")}`;
    checks.push(
      mk(
        at(`phase-summary-${variant}`),
        `Q9 phase-60 ${variant}: good/bad/between over ${rows.length} runs; window 1 holds 60/60 on every phase only when all are good (reported, not gating)`,
        n("good") === rows.length ? [] : [line],
        line,
        false,
      ),
    );
  }
  await writeFile(
    join(runDir, "g7r-summary.json"),
    `${JSON.stringify({ schema: "render-stream-g7r-summary/1", kind, phase, rates }, null, 2)}\n`,
  ).catch(() => {});
  return {
    group: "g7-r",
    kind,
    live: true,
    passed: checks.every((c) => c.passed || !c.gating),
    run_dir: runDir,
    checks,
    phase,
    rates,
  };
}

function describeLeg(
  id: string,
  m: G6cMeasure,
  row: Record<string, unknown>,
): string {
  const arr = (k: string) =>
    ((row[k] as (number | null)[] | undefined) ?? [])
      .map((v) => fmt(v))
      .join("/");
  const base = `host ${fmt(m.host_frame)}/s, published ${arr("published")}/s, receiver frame ${arr("receiver_frame")}/s, credit RTT mean ${arr("credit_rtt_mean_frames")} frames, hold p50 ${arr("hold_p50_us")} us p95 ${arr("hold_p95_us")} us over ${fmt(m.window?.seconds, 1)} s`;
  if (id === "final-latest-state")
    return ((row.final_state as string[] | undefined) ?? []).join("; ");
  if (id === "host-unperturbed")
    return `frame-interval p95 ${fmt(m.frame_interval_p95_us, 0)} us, host ${fmt(m.host_frame)}/s`;
  if (id === "rate-mismatch")
    return `${base}; ${arr("ticks_credit_blocked")} credit-blocked ticks`;
  return base;
}
