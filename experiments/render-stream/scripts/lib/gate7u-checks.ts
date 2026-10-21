// Gate 7 group g7-lc (G7u; protocol/gate7/g7u.md, gate7-design.md D14, Q10's suspension and
// lifecycle bullets; the working contract is protocol/gate7/g7u-as-built.md): suspension,
// reload, close and WebGL context loss on the two browser receivers (the GSW canvas receiver and
// the Godot web export).
//
// G6l's group is reused, unforked: run-gate6.sh --legs g6l with G7U_LEGS runs the lifecycle legs
// on gate6-scene's live timeline into `<out>/gate6/lc-<kind>/live/<leg>/` (desktop, headless
// Chromium) or `<out>/gate6/lc-<kind>-<device>/live/<leg>/` (the phone's real Chrome), each with
// the harness's `receiver/lifecycle.json` (render-stream-lifecycle/1). This file judges each leg
// with G6l's own loader, classification, digest and stall checks (lib/gate6l-checks.ts):
//
//   - A suspension is a G6l stall. `applied.live.stall` is synthesised from lifecycle.json and the
//     host's log before `classifyG6lLeg`/`stallReport` read it (synthesiseStall): the stalled seq
//     is the send whose credit spans the suspension. GSW stamps its acks with performance.now()
//     (the shim's clock), so the page's window maps onto the host clock through the acks'
//     `receiver_t_us`; the web export's receiver clock is the engine's, so its stall is the
//     largest host-log credit gap after the trigger.
//   - Desktop legs (`sim-*`) are `simulated-suspension`: the shim holds the page's own rAF. Their
//     checks carry that label and their own ids; none satisfies a real hidden/frozen requirement.
//     Real legs are trusted only when the page's own evidence shows the suspension took effect
//     (evaluateTookEffect); when it did not, every other check of the leg is `unavailable`, never
//     a pass. No device run at all makes each real leg `unavailable` with that reason.
//   - Reload legs are judged over host connection 2 (the reloaded page's stream 1); close legs
//     have no applied.json and are judged from the host's evidence only.
//   - Browser shots are compared with the native reference frames under Q7's band (readback and
//     delta1: at most one level per RGB channel, alpha equal), pixel by pixel against the very
//     frame each shot claims (bandedLoader); compositor-equals-readback stays exact.
//
// Pure over the run directories (no process launched); scripts/test/self-test-gate7u.ts drives the
// evaluators with synthetic values.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { decodePngRgba, readTextOrUndefined } from "./gate-minus1-checks";
import { type StallReport, shotName } from "./gate1-g1d-checks";
import {
  type DeliveryReport,
  type LiveConnectionSummary,
  type LiveHostEvidence,
  type LiveLogLine,
  receivedFileName,
  stateKey,
} from "./gate1-live-checks";
import { type HookLine, loadResolved } from "./gate2b-checks";
import type { G2cHost } from "./gate2c-checks";
import type { Gate6Expected } from "./gate6-expected";
import type { Frame6, Gate6Check } from "./gate6a-checks";
import { finalShotPath } from "./gate6c-checks";
import {
  appliedTransactions,
  checkFetchLatestOnly,
  checkStallRecovery,
  classifyG6lLeg,
  compareAt,
  digestLeg,
  evaluateFetchLatestOnly,
  type FrameLoader,
  G6L_DEFAULT_START_FRAME,
  G6L_DIR,
  G6L_FRAME_US,
  G6L_QUIT_FRAME,
  type G6lApplied,
  type G6lCheckpoint,
  type G6lEvaluation,
  type G6lLeg,
  type G6lLegEvidence,
  liveAppliedFrame,
  loadFrame,
  loadG6lLeg,
  referenceFrame,
  setG6lStartFrame,
  texaId,
  wireFrameOf,
} from "./gate6l-checks";
import { type Gate7Check, readJson } from "./gate7-adapters";
import {
  browserLegProblems,
  helloProblems,
  type PageConfig,
  pacedLoopProblems,
  type SummaryConnection,
} from "./gate7-live";

// ---------------------------------------------------------------------------------------------
// Legs (g7u-as-built.md "Legs"; run-gate6.sh's G7U_LEGS)
// ---------------------------------------------------------------------------------------------

export type G7uKind = "gsw" | "web";
export const G7U_KINDS: readonly G7uKind[] = ["gsw", "web"];
export type G7uEnv = "desktop" | "device";
export type G7uEvidence = "simulated-suspension" | "real";
export type G7uStatus = "pass" | "fail" | "unavailable";
export type G7uAction = "suspend" | "reload" | "close" | "context-loss";

export interface G7uLegDef {
  /** the desktop (headless) leg, null when the leg is device-only */
  desktop: string | null;
  /** the device (real Chrome) leg, null when the leg is desktop-only */
  device: string | null;
  action: G7uAction;
  suspend_kind: "hidden" | "frozen" | null;
  step: number;
  ms: number;
  kinds: readonly G7uKind[];
  sabotage?: "ack-while-hidden" | "css-opacity";
}

export const G7U_LEGS: readonly G7uLegDef[] = [
  {
    desktop: "sim-hidden-2s",
    device: "hidden-2s",
    action: "suspend",
    suspend_kind: "hidden",
    step: 2,
    ms: 2000,
    kinds: ["gsw", "web"],
  },
  {
    desktop: "sim-hidden-30s",
    device: "hidden-30s",
    action: "suspend",
    suspend_kind: "hidden",
    step: 2,
    ms: 30000,
    kinds: ["gsw", "web"],
  },
  {
    desktop: "sim-frozen-30s",
    device: "frozen-30s",
    action: "suspend",
    suspend_kind: "frozen",
    step: 2,
    ms: 30000,
    kinds: ["gsw", "web"],
  },
  {
    desktop: "reload",
    device: "reload",
    action: "reload",
    suspend_kind: null,
    step: 5,
    ms: 0,
    kinds: ["gsw", "web"],
  },
  {
    desktop: "close",
    device: "close",
    action: "close",
    suspend_kind: null,
    step: 5,
    ms: 0,
    kinds: ["gsw", "web"],
  },
  {
    desktop: "context-loss",
    device: "context-loss",
    action: "context-loss",
    suspend_kind: null,
    step: 5,
    ms: 500,
    kinds: ["gsw", "web"],
  },
  {
    desktop: "sabotage-ack-while-hidden",
    device: "sabotage-ack-while-hidden",
    action: "suspend",
    suspend_kind: "hidden",
    step: 2,
    ms: 2000,
    kinds: ["gsw"],
    sabotage: "ack-while-hidden",
  },
  {
    desktop: "sabotage-css-opacity",
    device: null,
    action: "suspend",
    suspend_kind: "hidden",
    step: 2,
    ms: 2000,
    kinds: ["gsw"],
    sabotage: "css-opacity",
  },
];

/** Q10: each sabotage fails exactly these checks of its leg (and nothing else). */
export const G7U_SABOTAGE_FAILS: Readonly<Record<string, readonly string[]>> = {
  "ack-while-hidden": ["credit-from-paced-loop", "pending-bounded"],
  "css-opacity": ["compositor-equals-readback"],
};

/** The real requirements a device run answers: Q10's hidden/frozen legs (and the gsw sabotage). */
export function realLegs(kind: G7uKind): G7uLegDef[] {
  return G7U_LEGS.filter(
    (d) => d.kinds.includes(kind) && d.action === "suspend" && d.device,
  );
}

export function legsFor(kind: G7uKind, env: G7uEnv): string[] {
  return G7U_LEGS.filter((d) => d.kinds.includes(kind))
    .map((d) => (env === "desktop" ? d.desktop : d.device))
    .filter((l): l is string => l !== null);
}

export function legDef(env: G7uEnv, leg: string): G7uLegDef | undefined {
  return G7U_LEGS.find(
    (d) => (env === "desktop" ? d.desktop : d.device) === leg,
  );
}

/** A real leg's checks that do not depend on the suspension having taken effect (all others turn
 * `unavailable` when it did not). */
export const SUSPENSION_INDEPENDENT: readonly string[] = [
  "took-effect",
  "browser-provenance",
  "console-clean",
  "hello-recorded",
];

/** A real leg whose suspension did not take effect (`tookEffectProblems` non-empty) answers
 * nothing about suspension: each of its checks but SUSPENSION_INDEPENDENT's turns `unavailable`
 * (failing, gating), so an untrue hide can never pass (pure). */
export function demoteUntrusted(
  checks: readonly G7uCheck[],
  tookEffectProblems: readonly string[],
): G7uCheck[] {
  if (tookEffectProblems.length === 0) return [...checks];
  return checks.map((c) =>
    SUSPENSION_INDEPENDENT.includes(c.id.split("@")[0])
      ? c
      : unavailable(
          c.id,
          c.criterion,
          `the suspension did not take effect (${tookEffectProblems.slice(0, 2).join("; ")})`,
          c.evidence,
        ),
  );
}

/** G6l's leg definition every lifecycle leg is classified under (honest pixels, a stall). */
const G6L_LC_LEG: G6lLeg = {
  leg: "live-stall",
  expected_pixel: "success",
  stall: true,
  reconnect: false,
};

// ---------------------------------------------------------------------------------------------
// lifecycle.json (render-stream-lifecycle/1, g7u-as-built.md)
// ---------------------------------------------------------------------------------------------

export interface LcPage {
  time_origin?: number;
  navigation?: number | string;
  trigger?: {
    line?: string;
    step?: number;
    seq?: number;
    frame?: number;
    t?: number;
  } | null;
  window?: { requested_t?: number; start_t?: number; end_t?: number } | null;
  raf?: {
    total?: number;
    during?: number;
    held?: number;
    first_after_t?: number | null;
    after_intervals_ms?: number[];
    /** device: performance.now() of each callback inside the window (the shim's first 100) */
    during_t?: number[];
  };
  timers_during?: number;
  ws_events_deferred?: number;
  visibility?: { t: number; state: string }[];
  lifecycle_events?: { t: number; type: string }[];
  context?: { lost_t?: number; restored_t?: number } | null;
}

export interface Lifecycle {
  schema?: string;
  leg?: string;
  kind?: string;
  env?: string;
  spec?: {
    action?: string;
    suspend_kind?: string | null;
    step?: number;
    ms?: number;
    restore_ms?: number;
    mechanism_hint?: string | null;
  };
  simulated?: boolean;
  mechanism?: string;
  pages?: LcPage[];
  took_effect?: boolean;
  took_effect_detail?: string;
  harness?: {
    actions?: { wall_ms?: number; what?: string; detail?: string }[];
  };
  device?: {
    serial?: string;
    model?: string;
    chrome?: string;
    conditions_before?: unknown;
    conditions_after?: unknown;
    isolation?: string;
    fixture_start_frame?: number | null;
  } | null;
  compositor?: string | null;
}

export const LIFECYCLE_SCHEMA = "render-stream-lifecycle/1";

// ---------------------------------------------------------------------------------------------
// Checks: Gate7Check plus the evidence label and a typed status (`unavailable` is never a pass)
// ---------------------------------------------------------------------------------------------

export interface G7uCheck extends Gate7Check {
  evidence: G7uEvidence;
  status: G7uStatus;
}

export function lc(
  id: string,
  criterion: string,
  problems: readonly string[],
  ok: string,
  evidence: G7uEvidence,
  gating = true,
): G7uCheck {
  const passed = problems.length === 0;
  return {
    id,
    criterion,
    passed,
    gating,
    status: passed ? "pass" : "fail",
    detail: passed ? ok : problems.join("; "),
    evidence,
  };
}

/** A check no available mechanism could answer: failing and gating, typed with its reason. */
export function unavailable(
  id: string,
  criterion: string,
  reason: string,
  evidence: G7uEvidence,
): G7uCheck {
  return {
    id,
    criterion,
    passed: false,
    gating: true,
    status: "unavailable",
    detail: `unavailable: ${reason}`,
    evidence,
  };
}

function fromG6(
  c: Gate6Check,
  id: string,
  leg: string,
  evidence: G7uEvidence,
): G7uCheck {
  const rename = (s: string) => s.split("live-stall").join(leg);
  return {
    id,
    criterion: `${rename(c.criterion)} (G6l's ${c.id})`,
    passed: c.passed,
    gating: true,
    status: c.passed ? "pass" : "fail",
    detail: rename(c.detail),
    evidence,
  };
}

const fmt = (v: number | null | undefined, d = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "?" : v.toFixed(d);

// ---------------------------------------------------------------------------------------------
// Pure evaluators (self-tested)
// ---------------------------------------------------------------------------------------------

/**
 * took-effect (pure): whether the leg's suspension is trusted, from the page's own records (never
 * the CDP reply). A simulated suspension takes effect by construction but must be labelled so; a
 * real one needs, for hidden, a `hidden` visibility event inside the window and no rAF callback
 * run in it, and for frozen, `freeze`/`resume` events or no rAF and no timer tick in it. The
 * harness's own `took_effect` must agree.
 */
export function evaluateTookEffect(
  l: Lifecycle | undefined,
  def: Pick<G7uLegDef, "action" | "suspend_kind" | "ms">,
  env: G7uEnv,
): { evidence: G7uEvidence; problems: string[]; detail: string } {
  const problems: string[] = [];
  if (!l)
    return { evidence: "real", problems: ["no lifecycle.json"], detail: "" };
  const evidence: G7uEvidence =
    l.simulated === false ? "real" : "simulated-suspension";
  if (l.schema !== LIFECYCLE_SCHEMA)
    problems.push(
      `lifecycle.json schema ${l.schema}, want ${LIFECYCLE_SCHEMA}`,
    );
  if (typeof l.simulated !== "boolean")
    problems.push("lifecycle.json has no boolean `simulated`");
  const page = l.pages?.[0];
  const w = page?.window;
  if (def.action !== "suspend") {
    if (l.simulated !== false)
      problems.push(`a ${def.action} leg is labelled simulated`);
    return { evidence, problems, detail: l.mechanism ?? "" };
  }
  if (env === "desktop") {
    if (l.simulated !== true || l.mechanism !== "simulated-suspension")
      problems.push(
        `a desktop suspension must be simulated-suspension (simulated ${l.simulated}, mechanism ${l.mechanism})`,
      );
  } else {
    if (l.simulated !== false)
      problems.push(
        "a device leg ran a simulated suspension: it cannot answer a real requirement",
      );
    const want =
      def.suspend_kind === "frozen" ? "real-frozen:" : "real-hidden:";
    if (!l.mechanism?.startsWith(want))
      problems.push(`mechanism ${l.mechanism}, want ${want}*`);
  }
  if (
    !w ||
    typeof w.start_t !== "number" ||
    typeof w.end_t !== "number" ||
    w.end_t <= w.start_t
  ) {
    problems.push(
      `no suspension window on the page (${JSON.stringify(w ?? null)})`,
    );
    return { evidence, problems, detail: "" };
  }
  const dur = w.end_t - w.start_t;
  if (dur < 0.9 * def.ms)
    problems.push(
      `the window lasted ${fmt(dur, 0)} ms, under 0.9 x the requested ${def.ms} ms`,
    );
  const during =
    page?.raf?.during === undefined ? undefined : rafInside(page).inside;
  const edge = rafInside(page).edge;
  let detail = `window ${fmt(dur, 0)} ms (requested ${def.ms}), rAF during ${during ?? "?"}${edge > 0 ? ` (+${edge} at the start edge, not counted)` : ""}`;
  if (l.simulated === false) {
    const start = w.start_t;
    const end = w.end_t;
    if (def.suspend_kind === "hidden") {
      const hidden = (page?.visibility ?? []).find(
        (v) => v.state === "hidden" && v.t >= start - 50 && v.t <= end,
      );
      if (!hidden)
        problems.push(
          "the page logged no `hidden` visibilitychange inside its window: the hide did not take effect",
        );
      if (during !== 0)
        problems.push(`${during ?? "?"} rAF callbacks ran while hidden`);
      detail += hidden ? `, hidden at ${fmt(hidden.t, 0)} ms` : "";
    } else {
      const ev = page?.lifecycle_events ?? [];
      const freeze = ev.some(
        (e) => e.type === "freeze" && e.t >= start - 50 && e.t <= end,
      );
      const resume = ev.some((e) => e.type === "resume" && e.t >= start);
      const stopped = during === 0 && page?.timers_during === 0;
      if (!(freeze && resume) && !stopped)
        problems.push(
          `no freeze/resume events in the window and rAF ${during ?? "?"} / timer ticks ${page?.timers_during ?? "?"} during it: the freeze did not take effect`,
        );
      detail += `, freeze/resume ${freeze}/${resume}, timer ticks during ${page?.timers_during ?? "?"}`;
    }
  }
  if (l.took_effect !== true)
    problems.push(
      `the harness says it did not take effect (${l.took_effect_detail ?? "no detail"})`,
    );
  return { evidence, problems, detail };
}

/** A device leg's provenance.json (browser-harness.ts checkDeviceProvenance's verdict). */
export interface DeviceProvenanceJson {
  kind?: string;
  ok?: boolean;
  reasons?: string[];
  facts?: { page?: { devicePixelRatio?: number } | null };
}

/** The presentation keys of the /7 hello the phone answers differently from the desktop. */
const PRESENTATION_KEYS = [
  "presentation_backing_w",
  "presentation_backing_h",
  "presentation_css_w",
  "presentation_css_h",
  "dpr_milli",
];

/**
 * hello-recorded on a device leg (pure): G7l's hello expectations except the presentation
 * integers, which are the phone's: dpr_milli is the page's own devicePixelRatio (provenance.json
 * facts) and the backing store is the leg's canvas (both shells size it before the hello); the CSS
 * size is the canvas for gsw (the shell's rect) and, for the web export, Godot's own
 * `backing * 1000 / dpr_milli` (receiver.gd _hello_v7, integer division: 243x137 at 2625). At DPR 1
 * both rules give the desktop's expectations, which are untouched.
 */
export function deviceHelloProblems(
  c: SummaryConnection,
  page: Parameters<typeof helloProblems>[1],
  expectedKind: string,
  kind: G7uKind,
  prov: DeviceProvenanceJson | undefined,
): string[] {
  const out = helloProblems(c, page, expectedKind).filter(
    (p) => !PRESENTATION_KEYS.some((k) => p.startsWith(`${k}=`)),
  );
  const dpr = prov?.facts?.page?.devicePixelRatio;
  if (typeof dpr !== "number") {
    out.push("no page devicePixelRatio in provenance.json");
    return out;
  }
  const [w, h] = page?.canvas ?? [640, 360];
  const dprMilli = Math.round(dpr * 1000);
  const want: Record<string, unknown> = {
    dpr_milli: dprMilli,
    presentation_backing_w: w,
    presentation_backing_h: h,
    presentation_css_w: kind === "gsw" ? w : Math.floor((w * 1000) / dprMilli),
    presentation_css_h: kind === "gsw" ? h : Math.floor((h * 1000) / dprMilli),
  };
  for (const [k, v] of Object.entries(want))
    if ((c as unknown as Record<string, unknown>)[k] !== v)
      out.push(
        `${k}=${JSON.stringify((c as unknown as Record<string, unknown>)[k])} (want ${JSON.stringify(v)}, the phone's)`,
      );
  return out;
}

/** A real hide's start edge (g7u-as-built.md "Device facts"): Chrome on the g31 runs a few rAF
 * callbacks right after `hidden` when a new foreground tab hides the page. Callbacks within this
 * long of the window's start are reported as edge callbacks, never counted as run while hidden.
 * Measured on the g31: 6 callbacks at the 60-Hz cadence over 87 ms after `hidden` (dev-d-gsw1
 * hidden-2s; ~80 ms in the probe), then none until `visible`; so 150 ms. */
export const REAL_EDGE_MS = 150;

/** The window's rAF callbacks split into strictly inside (start_t + REAL_EDGE_MS, end_t) and the
 * start edge, from the device shim's `during_t`; without it (the desktop shim) all are inside
 * (pure). */
export function rafInside(page: LcPage | undefined): {
  inside: number;
  edge: number;
} {
  const r = page?.raf;
  const during = r?.during ?? 0;
  const start = page?.window?.start_t;
  if (!r?.during_t || typeof start !== "number")
    return { inside: during, edge: 0 };
  const edge = r.during_t.filter((t) => t <= start + REAL_EDGE_MS).length;
  return { inside: during - edge, edge };
}

/** raf-stopped (pure): no rAF callback ran while suspended (prediction 0); on a real leg the start
 * edge's callbacks (rafInside) are reported, not counted. */
export function evaluateRafStopped(page: LcPage | undefined): {
  problems: string[];
  detail: string;
} {
  const r = page?.raf;
  if (!page?.window || !r || typeof r.during !== "number")
    return {
      problems: ["no rAF record for the suspension window"],
      detail: "",
    };
  const { inside, edge } = rafInside(page);
  const edgeText =
    edge > 0
      ? `; ${edge} at the window's start edge (within ${REAL_EDGE_MS} ms of hidden/freeze), reported, not counted`
      : "";
  return {
    problems:
      inside === 0
        ? []
        : [`${inside} rAF callbacks ran while suspended${edgeText}`],
    detail: `0 rAF callbacks ran in the window (${r.held ?? 0} held, ${r.total ?? "?"} in all)${edgeText}`,
  };
}

export interface StallSynth {
  /** what applied.json's `live.stall` would have said (G1d's shape) */
  stall: NonNullable<NonNullable<G6lApplied["live"]>["stall"]> | null;
  method: "receiver-clock" | "host-credit-gap";
  /** host t_us minus receiver_t_us, the smallest over the acks (receiver-clock only) */
  offset_us: number | null;
  /** the suspension on the host clock */
  window_host_us: [number, number] | null;
  /** seqs sent inside the suspension, the stalled send excepted */
  sends_in_window: number[];
  /** the stalled seq's send -> its credit, host clock */
  credit_gap_us: number | null;
  problems: string[];
}

/** An ack line's receiver clock (µs), when the receiver stamped one. */
function receiverT(l: LiveLogLine): number | undefined {
  const v = (l as { receiver_t_us?: unknown }).receiver_t_us;
  return typeof v === "number" ? v : undefined;
}

interface SendLine {
  seq: number;
  frame: number;
  t_us: number;
}

function sendsOf(log: readonly LiveLogLine[]): SendLine[] {
  return log
    .filter((l) => l.event === undefined && l.sent && !l.sent.dropped)
    .map((l) => ({
      seq: (l.sent as { seq: number }).seq,
      frame: l.frame,
      t_us: l.t_us,
    }));
}

function creditTimes(log: readonly LiveLogLine[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const l of log)
    if (
      (l.event === "ack" || l.event === "resync") &&
      l.credited === true &&
      l.seq !== undefined &&
      !out.has(l.seq)
    )
      out.set(l.seq, l.t_us);
  return out;
}

/**
 * The suspension as G6l's stall (pure). gsw: the page window (performance.now() ms, the shim's
 * clock and GSW's receiver clock) maps onto the host clock by the acks' smallest
 * `t_us - receiver_t_us`; the stalled seq is the first send whose credit lands at or after the
 * window's end (less one host frame), and every other send inside the window is credit that
 * flowed to a suspended page. web: the stalled seq is the send after the trigger whose credit
 * took longest (the largest host-log credit gap).
 */
export function synthesiseStall(
  kind: G7uKind,
  log: readonly LiveLogLine[] | undefined,
  page: LcPage | undefined,
  spec: { step: number; ms: number },
  mechanism: string,
): StallSynth {
  const out: StallSynth = {
    stall: null,
    method: kind === "gsw" ? "receiver-clock" : "host-credit-gap",
    offset_us: null,
    window_host_us: null,
    sends_in_window: [],
    credit_gap_us: null,
    problems: [],
  };
  const w = page?.window;
  if (
    !w ||
    typeof w.start_t !== "number" ||
    typeof w.end_t !== "number" ||
    !log
  ) {
    out.problems.push(
      !log ? "no host live log" : "no suspension window on the page",
    );
    return out;
  }
  const sends = sendsOf(log);
  const credit = creditTimes(log);
  let stalled: SendLine | undefined;
  if (kind === "gsw") {
    const offsets = log
      .filter((l) => l.event === "ack" && receiverT(l) !== undefined)
      .map((l) => l.t_us - (receiverT(l) as number));
    if (offsets.length === 0) {
      out.problems.push("no ack carries receiver_t_us");
      return out;
    }
    const offset = Math.min(...offsets);
    out.offset_us = offset;
    const ws = w.start_t * 1000 + offset;
    const we = w.end_t * 1000 + offset;
    out.window_host_us = [ws, we];
    stalled = sends.find((s) => {
      const c = credit.get(s.seq);
      return c !== undefined && c >= we - G6L_FRAME_US;
    });
    if (stalled) {
      const c = credit.get(stalled.seq) as number;
      const st = stalled;
      out.sends_in_window = sends
        .filter(
          (s) => s.seq !== st.seq && s.t_us > ws && s.t_us < Math.min(we, c),
        )
        .map((s) => s.seq);
    }
  } else {
    const after = page?.trigger?.seq ?? 0;
    let best = -1;
    for (const s of sends) {
      if (s.seq < after) continue;
      const c = credit.get(s.seq);
      if (c === undefined) continue;
      if (c - s.t_us > best) {
        best = c - s.t_us;
        stalled = s;
      }
    }
    if (stalled) {
      const c = credit.get(stalled.seq) as number;
      out.window_host_us = [stalled.t_us, c];
      if (c - stalled.t_us < 0.5 * spec.ms * 1000)
        out.problems.push(
          `the largest credit gap after the trigger is ${fmt((c - stalled.t_us) / 1000, 0)} ms, under half the ${spec.ms} ms suspension`,
        );
    }
  }
  if (!stalled) {
    out.problems.push("no send's credit spans the suspension");
    return out;
  }
  const c = credit.get(stalled.seq) as number;
  out.credit_gap_us = c - stalled.t_us;
  out.stall = {
    step: spec.step,
    ms: spec.ms,
    after_seq: stalled.seq,
    after_frame: stalled.frame,
    start_us: Math.round(w.start_t * 1000),
    end_us: Math.round(w.end_t * 1000),
    injected: true,
    mechanism,
  };
  return out;
}

/** pending-bounded (pure): Q10's bound at the granted credit window w, over the suspension. G7q:
 * at window w the stalled seq's w - 1 free slots let that many sends out without any credit
 * (seqs stalled + 1 .. stalled + w - 1): those are neither sends "during the stall" beyond the
 * window nor credit that flowed to a suspended page. Any other send inside the suspension needed a
 * credit the suspended page returned. At window 1 the rule is the one it was. */
export function evaluatePendingBounded(
  d: DeliveryReport | undefined,
  s: LiveConnectionSummary | undefined,
  st: StallReport | null,
  synth: Pick<StallSynth, "sends_in_window" | "problems">,
): { problems: string[]; detail: string } {
  const problems: string[] = [...synth.problems];
  if (!d) return { problems: [...problems, "no delivery report"], detail: "" };
  for (const v of [
    ...d.in_flight_violations,
    ...d.sent_without_credit,
    ...d.queued_violations,
  ].slice(0, 3))
    problems.push(v);
  if (d.max_in_flight > d.window || (s?.max_in_flight ?? 0) > d.window)
    problems.push(
      `max in flight ${d.max_in_flight} (host ${s?.max_in_flight}) above the window (${d.window})`,
    );
  if ((s?.max_pending ?? 0) > 1 || (st?.max_pending ?? 0) > 1)
    problems.push(
      `max pending ${Math.max(s?.max_pending ?? 0, st?.max_pending ?? 0)}`,
    );
  const w = d.window;
  if (!st || st.send_frame === null || st.credit_frame === null)
    problems.push("the suspension is not visible in the host log");
  else if (st.sends_during > w - 1)
    problems.push(
      `${st.sends_during} transactions sent between the stalled seq and its credit${w > 1 ? ` (window ${w})` : ""}`,
    );
  const stalled = st?.stalled_seq ?? null;
  const credited = synth.sends_in_window.filter(
    (q) => stalled === null || q <= stalled || q > stalled + (w - 1),
  );
  if (credited.length > 0)
    problems.push(
      `${credited.length} transactions sent inside the suspension (credit kept flowing to a suspended page: seqs ${credited.slice(0, 6).join(",")})`,
    );
  if (
    st &&
    d.queued_limit !== null &&
    st.max_queued_bytes_during > d.queued_limit
  )
    problems.push(
      `queued ${st.max_queued_bytes_during} B during the suspension > ${d.queued_limit} B (one credit window + control)`,
    );
  return {
    problems,
    detail: `in flight <= ${d.max_in_flight}, pending <= ${Math.max(s?.max_pending ?? 0, st?.max_pending ?? 0)}, ${st?.sends_during ?? "?"} sends during (${synth.sends_in_window.length} inside the page window), queued during ${st?.max_queued_bytes_during ?? "?"} B <= ${d.queued_limit} B, coalesced during ${st?.coalesced_delta ?? "?"}`,
  };
}

export interface Cadence {
  frames: number;
  rate_hz: number | null;
  p95_us: number | null;
}

function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/** The host's frame cadence over [from, to] from its live log's frame lines (pure). */
export function hostCadence(
  lines: readonly Pick<LiveLogLine, "frame" | "t_us" | "event" | "state">[],
  from: number,
  to: number,
): Cadence {
  const f = lines
    .filter(
      (l) =>
        l.event === undefined &&
        l.state !== undefined &&
        l.frame >= from &&
        l.frame <= to,
    )
    .sort((a, b) => a.frame - b.frame);
  const intervals: number[] = [];
  for (let i = 1; i < f.length; i++)
    if (f[i].frame === f[i - 1].frame + 1)
      intervals.push(f[i].t_us - f[i - 1].t_us);
  const span = f.length > 1 ? f[f.length - 1].t_us - f[0].t_us : 0;
  return {
    frames: f.length,
    rate_hz:
      span > 0 ? ((f[f.length - 1].frame - f[0].frame) * 1e6) / span : null,
    p95_us: quantile(intervals, 0.95),
  };
}

/** The host frames whose frame lines fall inside `window` (host t_us): [last frame at or before
 * its start, last frame at or before its end] (pure). */
export function hostFrameRange(
  lines: readonly Pick<LiveLogLine, "frame" | "t_us" | "event" | "state">[],
  window: readonly [number, number] | null,
): [number, number] | null {
  if (!window) return null;
  let from: number | null = null;
  let to: number | null = null;
  for (const l of lines) {
    if (l.event !== undefined || l.state === undefined) continue;
    if (l.t_us <= window[0]) from = l.frame;
    if (l.t_us <= window[1]) to = l.frame;
  }
  return from !== null && to !== null && to > from ? [from, to] : null;
}

/** The host frame fetch-latest-only's in-stall versions start after (pure): the stalled send's
 * frame (G6l's) when it lies within `slack` frames of the suspension's first host frame, else that
 * first frame (a stalled send late in the window means credit kept flowing). */
export function fetchWindowStart(
  stalledSendFrame: number | null,
  windowFirstFrame: number | null,
  slack = 10,
): number | null {
  if (windowFirstFrame === null) return stalledSendFrame;
  if (stalledSendFrame === null) return windowFirstFrame;
  return stalledSendFrame <= windowFirstFrame + slack
    ? stalledSendFrame
    : windowFirstFrame;
}

/** host-unperturbed (pure, G6c's bounds): frame-interval p95 within 5 % and frame rate within 2 %
 * of the same leg's window before the suspension (or the close). A null p95 on either side is a
 * problem unless `p95Unmeasurable` names why it cannot be measured. */
export function evaluateHostUnperturbed(
  before: Cadence,
  during: Cadence,
  p95Unmeasurable?: string,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  if (before.rate_hz === null || during.rate_hz === null)
    problems.push(
      `no host frame rate (before ${before.frames} frames, during ${during.frames})`,
    );
  else {
    const rate = during.rate_hz / before.rate_hz - 1;
    if (Math.abs(rate) > 0.02)
      problems.push(
        `host frame rate ${fmt(during.rate_hz, 2)}/s vs ${fmt(before.rate_hz, 2)}/s before (${fmt(100 * rate)} %)`,
      );
  }
  if (p95Unmeasurable === undefined) {
    if (before.p95_us === null || during.p95_us === null)
      problems.push("no frame-interval p95 on one side");
    else {
      const p95 = during.p95_us / before.p95_us - 1;
      if (Math.abs(p95) > 0.05)
        problems.push(
          `frame-interval p95 ${fmt(during.p95_us, 0)} us vs ${fmt(before.p95_us, 0)} us before (${fmt(100 * p95)} %)`,
        );
    }
  }
  return {
    problems,
    detail: `rate ${fmt(during.rate_hz, 2)}/s vs ${fmt(before.rate_hz, 2)}/s before; frame-interval p95 ${p95Unmeasurable === undefined ? `${fmt(during.p95_us, 0)} us vs ${fmt(before.p95_us, 0)} us` : `not compared (${p95Unmeasurable})`} (${during.frames} vs ${before.frames} frames)`,
  };
}

/** The host frame rate before and after `frame` from perf-timeline.jsonl's once-a-second samples
 * (pure; a close leg's host log ends with the connection). The first second is skipped. */
export function timelineCadence(
  samples: readonly { t_us?: number; frame?: number }[],
  frame: number,
): { before: Cadence; after: Cadence } {
  const s = samples.filter(
    (x): x is { t_us: number; frame: number } =>
      typeof x.t_us === "number" && typeof x.frame === "number" && x.frame > 60,
  );
  const rate = (xs: { t_us: number; frame: number }[]): Cadence => ({
    frames: xs.length,
    rate_hz:
      xs.length > 1 && xs[xs.length - 1].t_us > xs[0].t_us
        ? ((xs[xs.length - 1].frame - xs[0].frame) * 1e6) /
          (xs[xs.length - 1].t_us - xs[0].t_us)
        : null,
    p95_us: null,
  });
  return {
    before: rate(s.filter((x) => x.frame <= frame)),
    after: rate(s.filter((x) => x.frame > frame)),
  };
}

/** socket-kept (pure): one host connection, the receiver's one stream is it, one document. */
export function evaluateSocketKept(
  hostConnections: readonly {
    n: number;
    stream_id: string | null | undefined;
  }[],
  receiverStreams: readonly { stream_id?: string | null }[] | undefined,
  pages: number,
  reconnect: unknown,
  /** applied.json `failure`: a `live-disconnected` one is the socket lost (the g31's real freeze:
   * both sockets close 1006 on `active`). */
  failure?: { reason?: string; detail?: string } | null,
  /** host connection 1's close code: a kept socket ends with the receiver's 1000 */
  hostClose1?: number | null,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  if (hostClose1 !== undefined && hostClose1 !== null && hostClose1 !== 1000)
    problems.push(
      `host connection 1 closed ${hostClose1}, not the receiver's 1000 after the end record`,
    );
  if (failure?.reason === "live-disconnected")
    problems.push(
      `the socket was lost: ${failure.reason} (${(failure.detail ?? "").slice(0, 120)})`,
    );
  if (hostConnections.length !== 1)
    problems.push(
      `${hostConnections.length} host connections, expected 1 (no reconnect)`,
    );
  const streams = receiverStreams ?? [];
  if (streams.length !== 1)
    problems.push(`the receiver recorded ${streams.length} streams`);
  const sid = hostConnections[0]?.stream_id ?? null;
  if (streams[0] && streams[0].stream_id !== sid)
    problems.push(
      `the receiver's stream_id ${streams[0].stream_id} is not the host's ${sid}`,
    );
  if (pages !== 1) problems.push(`${pages} documents (a reload)`);
  if (reconnect) problems.push("applied.json live.reconnect is set");
  return {
    problems,
    detail: `one connection, stream ${String(sid).slice(0, 8)} throughout, one document`,
  };
}

// ---------------------------------------------------------------------------------------------
// D14 as amended (G7u finisher): a frozen page may lose its transport. On the g31 a CDP freeze
// closes the page's WebSocket on `active` (the host sees 1001 from the receiver, the page 1006).
// Recovery is gate 1d's reconnect: a fresh session on a new connection whose first transaction is
// the host's newest state, no burst, pending state bounded; the host treats the dead connection as
// gate 1d's killed receiver. A frozen leg passes either with its socket kept or with that recovery,
// and fails with neither.
// ---------------------------------------------------------------------------------------------

/** One `live.loss_reconnects` entry (RS_RECEIVER_RECONNECT_ON_LOSS, both receivers). */
export interface LossReconnect {
  connection?: number;
  code?: number;
  reason?: string;
  after_seq?: number;
  lost_us?: number;
  opened_us?: number | null;
  connect_attempts?: number;
  owned_before_dispose?: number | null;
  freed_rids?: number | null;
  leftover_rids?: number | null;
}

/** The leg lost its socket (pure): a second host connection, a `live-disconnected` failure, or a
 * receiver-recorded loss reconnect. */
export function transportLost(
  hostConnections: number,
  failure: { reason?: string } | null | undefined,
  lossReconnects: readonly unknown[] | undefined,
  /** host connection 1's close code: anything but the receiver's 1000 after the end record is a
   * lost socket, even when the receiver failed for another reason first (a fetch timeout on
   * resume did, before the fetcher's suspension rule) */
  hostClose1?: number | null,
): boolean {
  return (
    hostConnections > 1 ||
    failure?.reason === "live-disconnected" ||
    (lossReconnects?.length ?? 0) > 0 ||
    (hostClose1 !== undefined && hostClose1 !== null && hostClose1 !== 1000)
  );
}

export interface LossConnection {
  n: number;
  summary:
    | Pick<LiveConnectionSummary, "stream_id" | "closed_by" | "close_code">
    | undefined;
  /** host frames of the connection's `open` and `close` log events */
  open_frame: number | null;
  close_frame: number | null;
  /** the host's first tapped transaction */
  first: { seq: number; encoding: string } | null;
}

/**
 * socket-kept-or-reconnected, the lost branch (pure): exactly two host connections; connection 1
 * closed by the page's side (never the host), at least half the suspension after the trigger (the
 * loss is the suspension's, not an earlier fault); connection 2 opened after that close with a new
 * stream_id and starts seq 1 full; the receiver ended `ok` with the end record on connection 2's
 * stream, one loss reconnect from connection 1 with a clean dispose (leftover 0), no scheduled
 * reconnect, and one document (the page reconnected itself, it did not reload).
 */
export function evaluateLossReconnect(
  c: readonly LossConnection[],
  receiver: {
    status?: string;
    failure?: { reason?: string; detail?: string } | null;
    streams?: readonly { stream_id?: string | null; end_seen?: boolean }[];
    reconnect?: unknown;
    loss_reconnects?: readonly LossReconnect[];
  },
  pages: number,
  triggerFrame: number | null,
  ms: number,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  if (c.length !== 2)
    problems.push(
      `${c.length} host connections, expected 2 (connection 1 lost, connection 2 its reconnect)`,
    );
  const [c1, c2] = c;
  if (c1) {
    if (c1.summary?.closed_by === "host")
      problems.push(
        `connection 1 closed by the host (${c1.summary.close_code}), not lost on the page's side`,
      );
    if (c1.close_frame === null)
      problems.push("connection 1 has no close event");
    else if (triggerFrame === null)
      problems.push("no trigger frame to place the loss after");
    else if (c1.close_frame - triggerFrame < (0.5 * ms * 60) / 1000)
      problems.push(
        `connection 1 closed at frame ${c1.close_frame}, ${c1.close_frame - triggerFrame} frames after the trigger (${triggerFrame}): before half the ${ms} ms suspension, so not the suspension's loss`,
      );
  }
  if (c1 && c2) {
    const s1 = c1.summary?.stream_id ?? null;
    const s2 = c2.summary?.stream_id ?? null;
    if (!s2 || s2 === s1)
      problems.push(
        `connection 2's stream_id ${s2} is not new (connection 1: ${s1})`,
      );
    if (
      c2.open_frame === null ||
      c1.close_frame === null ||
      c2.open_frame < c1.close_frame
    )
      problems.push(
        `connection 2 opened at frame ${c2.open_frame}, not after connection 1's close (${c1.close_frame})`,
      );
    if (c2.first?.seq !== 1 || c2.first.encoding !== "full")
      problems.push(
        `connection 2 starts with seq ${c2.first?.seq} ${c2.first?.encoding}, not seq 1 full`,
      );
    const streams = receiver.streams ?? [];
    if (streams.length !== 2)
      problems.push(
        `the receiver recorded ${streams.length} streams, expected 2`,
      );
    else {
      if (streams[1].stream_id !== s2)
        problems.push(
          `the receiver's second stream ${streams[1].stream_id} is not the host's connection 2 (${s2})`,
        );
      if (streams[1].end_seen !== true)
        problems.push("the receiver's second stream saw no end record");
    }
  }
  if (receiver.status !== "ok")
    problems.push(
      `receiver status ${receiver.status}${receiver.failure ? ` (${receiver.failure.reason}: ${(receiver.failure.detail ?? "").slice(0, 100)})` : ""}`,
    );
  const lr = receiver.loss_reconnects;
  if (!lr)
    problems.push(
      "applied.json has no live.loss_reconnects (RS_RECEIVER_RECONNECT_ON_LOSS not in force)",
    );
  else if (lr.length !== 1)
    problems.push(`${lr.length} loss reconnects recorded, expected 1`);
  else {
    if (lr[0].connection !== 1)
      problems.push(
        `the loss reconnect left connection ${lr[0].connection}, not 1`,
      );
    if (lr[0].leftover_rids !== 0)
      problems.push(
        `the lost connection's dispose left ${lr[0].leftover_rids} RIDs (expected 0)`,
      );
    if (lr[0].opened_us === null || lr[0].opened_us === undefined)
      problems.push("the loss reconnect never opened its connection");
  }
  if (receiver.reconnect) problems.push("applied.json live.reconnect is set");
  if (pages !== 1)
    problems.push(`${pages} documents (a reload, not a reconnect)`);
  return {
    problems,
    detail: `lost: connection 1 (${String(c1?.summary?.stream_id).slice(0, 8)}) closed ${c1?.summary?.close_code} by the ${c1?.summary?.closed_by} side at frame ${c1?.close_frame}; the receiver saw code ${lr?.[0]?.code}, reconnected in ${lr?.[0]?.connect_attempts ?? "?"} attempt(s) as connection 2 (${String(c2?.summary?.stream_id).slice(0, 8)}, opened at frame ${c2?.open_frame}, seq 1 full); dispose left ${lr?.[0]?.leftover_rids ?? "?"} RIDs; one document`,
  };
}

/**
 * pending-bounded, the lost branch (pure): every connection keeps the window (in flight <= 1,
 * nothing sent without credit, queued bytes within one window + control), pending <= 1, and
 * connection 1 sent nothing between the suspension's start and its close (credit did not flow to
 * a frozen page; what the page never acked was coalesced, and the close freed it).
 */
export function evaluateLossPendingBounded(
  deliveries: readonly (DeliveryReport | undefined)[],
  summaries: readonly (
    | Pick<LiveConnectionSummary, "max_in_flight" | "max_pending">
    | undefined
  )[],
  c1Sends: readonly { seq: number; t_us: number }[],
  suspensionStartUs: number | null,
  c1CloseUs: number | null,
): { problems: string[]; detail: string; sends_during: number[] } {
  const problems: string[] = [];
  deliveries.forEach((d, i) => {
    if (!d) {
      problems.push(`connection ${i + 1}: no delivery report`);
      return;
    }
    for (const v of [
      ...d.in_flight_violations,
      ...d.sent_without_credit,
      ...d.queued_violations,
    ].slice(0, 3))
      problems.push(`connection ${i + 1}: ${v}`);
    const s = summaries[i];
    if (d.max_in_flight > d.window || (s?.max_in_flight ?? 0) > d.window)
      problems.push(
        `connection ${i + 1}: max in flight ${d.max_in_flight} (host ${s?.max_in_flight}) above the window (${d.window})`,
      );
    if ((s?.max_pending ?? 0) > 1)
      problems.push(`connection ${i + 1}: max pending ${s?.max_pending}`);
  });
  let during: number[] = [];
  if (suspensionStartUs === null || c1CloseUs === null)
    problems.push(
      "the suspension's start or connection 1's close is not on the host clock",
    );
  else {
    // The send in flight at the freeze went out before the window opened.
    during = c1Sends
      .filter((s) => s.t_us > suspensionStartUs && s.t_us < c1CloseUs)
      .map((s) => s.seq);
    if (during.length > 0)
      problems.push(
        `${during.length} transactions sent on connection 1 inside the suspension (seqs ${during.slice(0, 6).join(",")})`,
      );
  }
  return {
    problems,
    sends_during: during,
    detail: `${deliveries.length} connections, in flight <= ${Math.max(0, ...deliveries.map((d) => d?.max_in_flight ?? 0))}, pending <= ${Math.max(0, ...summaries.map((s) => s?.max_pending ?? 0))}, ${during.length} sends on connection 1 inside the suspension`,
  };
}

/**
 * stall-latest, the lost branch (pure): the first transaction applied after the loss is connection
 * 2's seq 1, full, formed at or after connection 2 opened (the host's newest state, not a queued
 * old one), and nothing of connection 1 is applied after the reconnect's first apply.
 */
export function evaluateNewestFirst(
  tx: readonly {
    stream: number;
    seq: number;
    frame: number | null;
    encoding: string | null;
    applied_us: number | null;
  }[],
  c2OpenFrame: number | null,
): {
  problems: string[];
  detail: string;
  first: {
    seq: number;
    frame: number | null;
    applied_us: number | null;
  } | null;
} {
  const problems: string[] = [];
  const s2 = tx.filter((t) => t.stream === 2 && t.applied_us !== null);
  const first = s2[0] ?? null;
  if (!first) problems.push("nothing applied on connection 2");
  else {
    if (first.seq !== 1 || first.encoding !== "full")
      problems.push(
        `connection 2's first applied transaction is seq ${first.seq} ${first.encoding}, not seq 1 full`,
      );
    if (
      first.frame === null ||
      c2OpenFrame === null ||
      first.frame < c2OpenFrame
    )
      problems.push(
        `connection 2's first state is frame ${first.frame}, before its open (${c2OpenFrame}): not the newest`,
      );
    const late = tx.filter(
      (t) =>
        t.stream === 1 &&
        t.applied_us !== null &&
        (first.applied_us ?? 0) < t.applied_us,
    );
    if (late.length > 0)
      problems.push(
        `${late.length} connection 1 transactions applied after connection 2's first (seq ${late[0].seq})`,
      );
  }
  return {
    problems,
    first: first
      ? { seq: first.seq, frame: first.frame, applied_us: first.applied_us }
      : null,
    detail: first
      ? `connection 2's first apply is seq ${first.seq} ${first.encoding} at frame ${first.frame} (opened at ${c2OpenFrame}): the newest state, nothing older after it`
      : "",
  };
}

export interface ResumeTx {
  stream: number;
  seq: number;
  /** G7q (credit window >= 2): applied and drawn with this later seq (one apply) */
  coalesced_into?: number | null;
  applied: boolean;
  skipped: string | null;
  /** the receiver frame of the apply: GSW's rAF index, the web export's process frame */
  frame_key: number | null;
}

/** resume-no-burst (pure): at most two applies in the first resumed receiver frame, and none
 * skipped silently (every seq the host sent from the stalled one on is recorded, and each
 * recorded but unapplied transaction names why). G7q: an apply is counted once, however many
 * queued transactions it folded (`coalesced_into`; none at window 1). */
export function evaluateResumeNoBurst(
  tx: readonly ResumeTx[],
  stalledSeq: number | null,
  sentSeqs: readonly number[],
  /** the stream judged: 1, or 2 after a lost socket's reconnect (from its seq 1) */
  stream = 1,
): { problems: string[]; first_frame_applies: number | null; detail: string } {
  if (stalledSeq === null)
    return {
      problems: ["no stalled seq"],
      first_frame_applies: null,
      detail: "",
    };
  const problems: string[] = [];
  const after = tx.filter((t) => t.stream === stream && t.seq >= stalledSeq);
  const first = after.find((t) => t.applied);
  let n: number | null = null;
  if (!first) problems.push("nothing applied after the suspension");
  else if (first.frame_key === null)
    problems.push(`seq ${first.seq} has no receiver frame of its apply`);
  else {
    n = after.filter(
      (t) =>
        t.applied &&
        t.frame_key === first.frame_key &&
        (t.coalesced_into === undefined || t.coalesced_into === null),
    ).length;
    if (n > 2)
      problems.push(
        `${n} transactions applied in the first resumed frame (${first.frame_key}), more than 2`,
      );
  }
  for (const t of after)
    if (!t.applied && !t.skipped)
      problems.push(
        `seq ${t.seq} was neither applied nor skipped with a reason`,
      );
  const seen = new Set(after.map((t) => t.seq));
  const lost = sentSeqs.filter((s) => s >= stalledSeq && !seen.has(s));
  if (lost.length > 0)
    problems.push(
      `${lost.length} seqs the host sent are not in applied.json (${lost.slice(0, 6).join(",")})`,
    );
  return {
    problems: problems.slice(0, 8),
    first_frame_applies: n,
    detail: `${n ?? "?"} applied in the first resumed frame, ${after.filter((t) => !t.applied).length} typed skips, none silent`,
  };
}

/** The resume apply that came ahead of the recovery (G7q, credit window w >= 2). */
export interface ResumeFold {
  /** the fold target: the newest transaction the page held at resume */
  seq: number;
  /** its host frame */
  frame: number;
  /** held transactions it folded past the stalled seq's w - 1 in-window sends */
  past_window: number;
  stale_from: number | null;
  /** its resolved state equals the host's full recording at its frame */
  state_equals_full: boolean | null;
}

/**
 * The resume fold ahead of the recovery (pure; G7q). At credit window w the page holds, at
 * resume, the stalled seq and at most its w - 1 in-window sends, folds them into the newest
 * (`coalesced_into`), and the recovery (the first send after the stalled credit) is the first
 * post-resume picture. When credit kept flowing to the suspended page (the ack-while-hidden
 * sabotage, which pending-bounded fails), the page holds sends past those w - 1 and GSW folds the
 * whole held queue into its newest, which is applied, and shot, before the recovery arrives. That
 * apply is then the first post-resume picture, so stall-latest and fetch-latest-only judge it as
 * well. Null otherwise: at window 1 (nothing folds), when the stalled seq applies alone, or when
 * its fold target is within its w - 1 in-window sends (the honest window-w resume).
 */
export function resumeFoldAhead(
  stalledSeq: number | null,
  window: number,
  txs: readonly {
    stream?: number;
    seq?: number;
    frame?: number | null;
    coalesced_into?: number | null;
  }[],
  recoverySeq: number | null,
  facts: (seq: number) => {
    frame: number | null;
    stale_from: number | null;
    state_equals_full: boolean | null;
  },
): ResumeFold | null {
  if (window < 2 || stalledSeq === null || recoverySeq === null) return null;
  const into = txs.find(
    (t) => (t.stream ?? 1) === 1 && t.seq === stalledSeq,
  )?.coalesced_into;
  if (typeof into !== "number") return null;
  if (into <= stalledSeq + (window - 1) || into >= recoverySeq) return null;
  const f = facts(into);
  const frame =
    f.frame ??
    txs.find((t) => (t.stream ?? 1) === 1 && t.seq === into)?.frame ??
    null;
  if (frame === null) return null;
  return {
    seq: into,
    frame,
    past_window: into - stalledSeq - (window - 1),
    stale_from: f.stale_from,
    state_equals_full: f.state_equals_full,
  };
}

/** A send's host facts, as stallReport reads the recovery's: its frame, stale_from, and whether
 * its tap state equals the full recording's at its frame. */
export function sendFacts(
  host: Pick<LiveHostEvidence, "log" | "tap" | "full"> | undefined,
  seq: number,
): {
  frame: number | null;
  stale_from: number | null;
  state_equals_full: boolean | null;
} {
  const line = host?.log?.find(
    (l) => l.event === undefined && l.sent?.seq === seq && !l.sent?.dropped,
  );
  const tx = host?.tap.transactions.find((t) => t.meta.seq === seq);
  const full = host?.full.transactions.find(
    (t) => t.meta.frame === tx?.meta.frame,
  );
  return {
    frame: line?.frame ?? tx?.meta.frame ?? null,
    stale_from: line?.sent?.stale_from ?? null,
    state_equals_full: tx && full ? stateKey(tx) === stateKey(full) : null,
  };
}

/**
 * stall-latest (pure; G6l's rule): the first transaction applied after the stalled seq is the
 * host's recovery send, carries no stale_from, equals the host's mirror at its frame, and its shot
 * equals the reference. A recovery beyond the last shot window (a 30-s suspension, frame > `lastWindowTo`)
 * is not shot; then its state equality stands alone and the detail says so. G7q: given a resume
 * fold ahead of the recovery (`resumeFoldAhead`), that apply is the first post-resume picture: it
 * carries no stale_from, equals the host's mirror at its frame, and its shot (in the recovery's
 * place) equals the reference; the recovery's own checks stand unchanged.
 */
export function evaluateStallLatest(
  st:
    | (Pick<StallReport, "stalled_seq" | "recovery"> &
        Partial<Pick<StallReport, "sends_during">>)
    | null,
  applied: readonly {
    stream: number;
    seq: number;
    coalesced_into?: number | null;
  }[],
  checkpoints: readonly Pick<
    G6lCheckpoint,
    "stream" | "seq" | "frame" | "vs_frame" | "vs_frame_regions"
  >[],
  lastWindowTo: number = G6L_QUIT_FRAME,
  /** G7q: the granted credit window. The recovery follows the stalled seq's w - 1 in-window sends,
   * and its picture is the apply it was folded into (G6l's stall-latest at window w). */
  window = 1,
  /** G7q: the resume apply ahead of the recovery (null at window 1 and on an honest resume) */
  fold: ResumeFold | null = null,
): { problems: string[]; detail: string } {
  const r = st?.recovery;
  if (!st || !r)
    return { problems: ["no stall recovery evidence"], detail: "" };
  const problems: string[] = [];
  if (r.stale_from !== null)
    problems.push(
      `the recovery seq ${r.seq} carries stale_from ${r.stale_from}`,
    );
  if (r.state_equals_full !== true)
    problems.push(
      `the recovery seq ${r.seq} (frame ${r.frame}) is not the host's state at its frame`,
    );
  const inStall = window > 1 ? (st.sends_during ?? 0) : 0;
  const after = applied.find(
    (t) => t.stream === 1 && t.seq > (st.stalled_seq ?? 0) + inStall,
  );
  if (after?.seq !== r.seq)
    problems.push(
      `the first transaction applied after the stall${inStall > 0 ? ` and its ${inStall} in-window sends` : ""} is seq ${after?.seq}, not the recovery seq ${r.seq}`,
    );
  if (fold) {
    if (fold.stale_from !== null)
      problems.push(
        `the resume apply's seq ${fold.seq} carries stale_from ${fold.stale_from}`,
      );
    if (fold.state_equals_full !== true)
      problems.push(
        `the resume apply's seq ${fold.seq} (frame ${fold.frame}) is not the host's state at its frame`,
      );
  }
  const drawn = fold
    ? fold.seq
    : (applied.find((t) => t.stream === 1 && t.seq === r.seq)?.coalesced_into ??
      r.seq);
  const shotFrame = fold ? fold.frame : r.frame;
  const cp = checkpoints.find((c) => c.stream === 1 && c.seq === drawn);
  let shot = fold
    ? `the resume apply's shot (of seq ${drawn}) equals the reference`
    : `its shot${drawn !== r.seq ? ` (of seq ${drawn}, which it was folded into)` : ""} equals the reference`;
  if (!cp) {
    if (shotFrame > lastWindowTo)
      shot = `not shot (frame ${shotFrame} lies after the last shot window, ${lastWindowTo}): judged by its state alone`;
    else
      problems.push(
        fold
          ? `the resume apply's seq ${drawn} was not shot`
          : `the recovery seq ${r.seq}${drawn !== r.seq ? ` (folded into seq ${drawn})` : ""} was not shot`,
      );
  } else if (cp.vs_frame !== 0)
    problems.push(
      `the ${fold ? "resume apply's" : "recovery"} shot differs from the reference at frame ${cp.frame} in ${cp.vs_frame_regions.join(",")}`,
    );
  const foldText = fold
    ? `; first the resume apply: the stalled seq and the queue it held folded into seq ${fold.seq} at frame ${fold.frame} (${fold.past_window} past its ${window - 1} in-window send${window - 1 === 1 ? "" : "s"}: credit kept flowing), equal to the host's full recording there`
    : "";
  return {
    problems,
    detail: `stalled seq ${st.stalled_seq}, recovery seq ${r.seq} at frame ${r.frame} (${r.frames_after_credit} after the credit, ${r.encoding}), equals the host's full recording there${foldText}; ${shot}`,
  };
}

/** compositor-equals-readback (pure): the canvas's CDP screenshot at exit equals the final shot
 * (the receiver's own readback), exactly, on an opaque frame. */
export function compositorDiff(
  shot: { width: number; height: number; data: Uint8Array } | null,
  comp: { width: number; height: number; data: Uint8Array } | null,
): { problems: string[]; differing: number | null } {
  if (!shot || !comp)
    return {
      problems: [
        `${!shot ? "final shot" : "compositor screenshot"} missing or unreadable`,
      ],
      differing: null,
    };
  if (shot.width !== comp.width || shot.height !== comp.height)
    return {
      problems: [
        `screenshot ${comp.width}x${comp.height} vs final shot ${shot.width}x${shot.height}`,
      ],
      differing: null,
    };
  for (let i = 3; i < shot.data.length; i += 4)
    if (shot.data[i] !== 255)
      return { problems: ["the final shot is not opaque"], differing: null };
  let diff = 0;
  let max = 0;
  for (let i = 0; i < shot.data.length; i += 4) {
    let px = 0;
    for (let k = 0; k < 4; k++)
      px = Math.max(px, Math.abs(shot.data[i + k] - comp.data[i + k]));
    if (px > 0) diff++;
    max = Math.max(max, px);
  }
  return {
    problems:
      diff === 0 ? [] : [`${diff} px differ (max channel delta ${max})`],
    differing: diff,
  };
}

/** Q7's band (pure): every pixel of `got` within one level per RGB channel of `ref` with alpha
 * equal is set to `ref`'s value; the rest stay. Returns the snapped copy and how many moved. */
export function snapInBand(
  got: Uint8Array,
  ref: Uint8Array,
): { rgba: Uint8Array; snapped: number } {
  const out = new Uint8Array(got);
  let snapped = 0;
  for (let i = 0; i + 3 < out.length && i + 3 < ref.length; i += 4) {
    if (
      out[i] === ref[i] &&
      out[i + 1] === ref[i + 1] &&
      out[i + 2] === ref[i + 2]
    )
      continue;
    if (
      out[i + 3] === ref[i + 3] &&
      Math.abs(out[i] - ref[i]) <= 1 &&
      Math.abs(out[i + 1] - ref[i + 1]) <= 1 &&
      Math.abs(out[i + 2] - ref[i + 2]) <= 1
    ) {
      out[i] = ref[i];
      out[i + 1] = ref[i + 1];
      out[i + 2] = ref[i + 2];
      snapped++;
    }
  }
  return { rgba: out, snapped };
}

/** A FrameLoader that shows each browser shot in `pairs` (shot path -> the reference frame it
 * claims) under Q7's band against that frame; every other path loads as it is. */
export function bandedLoader(
  pairs: ReadonlyMap<string, string>,
  base: FrameLoader = loadFrame,
  snappedPx?: Map<string, number>,
): FrameLoader {
  const cache = new Map<string, Promise<Frame6 | null>>();
  return (path) => {
    const ref = pairs.get(path);
    if (ref === undefined) return base(path);
    let p = cache.get(path);
    if (!p) {
      p = (async () => {
        const got = await base(path);
        const r = await base(ref);
        if (!got || !r || got.width !== r.width || got.height !== r.height)
          return got;
        const s = snapInBand(got.rgba, r.rgba);
        snappedPx?.set(path, s.snapped);
        return { width: got.width, height: got.height, rgba: s.rgba };
      })();
      cache.set(path, p);
    }
    return p;
  };
}

/** reconnect (pure) for a reload: connection 2 is a new stream starting seq 1 full, connection
 * 1 was closed by the receiver, and the page is a second document. */
export function evaluateReloadReconnect(
  c: readonly {
    n: number;
    summary:
      | Pick<LiveConnectionSummary, "stream_id" | "closed_by" | "close_code">
      | undefined;
    first: { seq: number; encoding: string } | null;
  }[],
  pages: readonly Pick<LcPage, "navigation" | "trigger" | "time_origin">[],
  step: number,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  if (c.length !== 2)
    return {
      problems: [
        `${c.length} host connections, expected 2 (the reload's reconnect)`,
      ],
      detail: "",
    };
  const [c1, c2] = c;
  const s1 = c1.summary?.stream_id ?? null;
  const s2 = c2.summary?.stream_id ?? null;
  if (!s2 || s2 === s1)
    problems.push(
      `connection 2's stream_id ${s2} is not new (connection 1: ${s1})`,
    );
  if (c1.summary?.closed_by !== "receiver")
    problems.push(
      `connection 1 closed by ${c1.summary?.closed_by} (${c1.summary?.close_code}), not the unloading page`,
    );
  if (c2.first?.seq !== 1 || c2.first.encoding !== "full")
    problems.push(
      `connection 2 starts with seq ${c2.first?.seq} ${c2.first?.encoding}, not seq 1 full`,
    );
  if (pages.length !== 2)
    problems.push(`${pages.length} documents, expected 2`);
  else {
    // `navigation` is the shim's document ordinal (1, 2, ...; sessionStorage-carried), and the
    // second document's time origin must be the later one.
    const nav = pages[1].navigation;
    if (nav !== 2)
      problems.push(
        `the second document's navigation ordinal is ${JSON.stringify(nav)}, not 2`,
      );
    const t0 = pages[0].time_origin;
    const t1 = pages[1].time_origin;
    if (typeof t0 !== "number" || typeof t1 !== "number" || t1 <= t0)
      problems.push(
        `the second document's time origin ${t1} is not after the first's ${t0}`,
      );
  }
  if (pages[0]?.trigger?.step !== step)
    problems.push(
      `reloaded after step ${pages[0]?.trigger?.step}, expected ${step}`,
    );
  return {
    problems,
    detail: `connection 1 (${String(s1).slice(0, 8)}) closed by the receiver (${c1.summary?.close_code}); connection 2 ${String(s2).slice(0, 8)} starts seq 1 full; a second document (navigation ${pages[1]?.navigation})`,
  };
}

/** reload-warm-cache (pure): over the host's http-get lines, the GETs after the reload for hashes
 * GET before it (predicted 0: the page's HTTP cache serves them), and the CORS preflights, per
 * hash, on each side (recorded, or typed unavailable when the log names none). */
export function evaluateWarmReload(
  lines: readonly (Pick<HookLine, "op" | "frame" | "hash"> & {
    method?: string;
  })[],
  reloadFrame: number,
): {
  problems: string[];
  repeated: string[];
  gets_after: number;
  preflights: {
    status: "measured" | "unavailable";
    before: number;
    after: number;
    per_hash_after: number | null;
    reason?: string;
  };
  detail: string;
} {
  const gets = lines.filter(
    (l) => l.op === "http-get" && l.method !== "OPTIONS",
  );
  const pre = lines.filter(
    (l) => l.op === "http-get" && l.method === "OPTIONS",
  );
  const before = new Set(
    gets
      .filter((l) => l.frame < reloadFrame && l.hash)
      .map((l) => l.hash as string),
  );
  const after = gets.filter((l) => l.frame >= reloadFrame);
  const repeated = after
    .filter((l) => l.hash && before.has(l.hash))
    .map((l) => l.hash as string);
  const preAfter = pre.filter((l) => l.frame >= reloadFrame);
  const preHashes = new Set(preAfter.map((l) => l.hash ?? ""));
  const preflights =
    pre.length === 0
      ? {
          status: "unavailable" as const,
          before: 0,
          after: 0,
          per_hash_after: null,
          reason:
            "the host's hook log names no OPTIONS request (no CORS preflight reached it)",
        }
      : {
          status: "measured" as const,
          before: pre.length - preAfter.length,
          after: preAfter.length,
          per_hash_after:
            preHashes.size > 0 ? preAfter.length / preHashes.size : 0,
        };
  return {
    problems:
      repeated.length === 0
        ? []
        : [
            `${repeated.length} GETs after the reload repeat a hash fetched before it (${repeated
              .slice(0, 4)
              .map((h) => h.slice(0, 12))
              .join(",")})`,
          ],
    repeated,
    gets_after: after.length,
    preflights,
    detail: `${after.length} GETs after the reload, 0 repeated; preflights ${preflights.status === "measured" ? `${preflights.before} before, ${preflights.after} after (${fmt(preflights.per_hash_after, 2)} per hash)` : `unavailable (${preflights.reason})`}`,
  };
}

export interface GswContextLoss {
  lost_us?: number;
  restored_us?: number;
  resident?: { textures?: number; meshes?: number };
  uploads_after_restore?: { textures?: number; meshes?: number };
  refetched?: number;
  redraw_us?: number;
  first_tx_after_restore?: number | null;
}

/** context-restored (pure, gsw): restored in place, every resident texture and mesh uploaded
 * again (no more, no fewer), and a draw after the restore. */
export function evaluateGswContextLoss(c: GswContextLoss | null | undefined): {
  problems: string[];
  detail: string;
} {
  if (!c)
    return { problems: ["applied.json live.context_loss missing"], detail: "" };
  const problems: string[] = [];
  if (typeof c.lost_us !== "number" || typeof c.restored_us !== "number")
    problems.push("lost_us / restored_us missing");
  else if (c.restored_us <= c.lost_us)
    problems.push(
      `restored at ${c.restored_us} us, not after the loss at ${c.lost_us}`,
    );
  const rt = c.resident?.textures;
  const rm = c.resident?.meshes;
  const ut = c.uploads_after_restore?.textures;
  const um = c.uploads_after_restore?.meshes;
  if (typeof rt !== "number" || rt <= 0)
    problems.push(`resident textures ${rt}`);
  if (ut !== rt)
    problems.push(`${ut} texture uploads after the restore, ${rt} resident`);
  if (um !== rm)
    problems.push(`${um} mesh uploads after the restore, ${rm} resident`);
  if (typeof c.redraw_us !== "number" || (c.restored_us ?? 0) > c.redraw_us)
    problems.push(`no redraw after the restore (redraw_us ${c.redraw_us})`);
  return {
    problems,
    detail: `lost -> restored ${fmt(((c.restored_us ?? 0) - (c.lost_us ?? 0)) / 1000)} ms, redrawn ${fmt(((c.redraw_us ?? 0) - (c.restored_us ?? 0)) / 1000)} ms later; ${ut} textures + ${um} meshes uploaded = resident ${rt} + ${rm}; ${c.refetched ?? 0} refetched; first transaction after it seq ${c.first_tx_after_restore ?? "?"}`,
  };
}

/** credit-resumes (pure): credited acks after the restore (receiver clock), with sends after it. */
export function evaluateCreditResumes(
  log: readonly LiveLogLine[] | undefined,
  restoredUs: number | undefined,
): { problems: string[]; detail: string; credits_after: number } {
  if (!log || typeof restoredUs !== "number")
    return {
      problems: ["no host log or no restore time"],
      detail: "",
      credits_after: 0,
    };
  const after = log.filter(
    (l) =>
      l.event === "ack" &&
      l.credited === true &&
      (receiverT(l) ?? Number.NEGATIVE_INFINITY) > restoredUs,
  );
  const lastCredit = after[0]?.t_us;
  const sends =
    lastCredit === undefined
      ? 0
      : sendsOf(log).filter((s) => s.t_us > lastCredit).length;
  const problems: string[] = [];
  if (after.length === 0) problems.push("no credited ack after the restore");
  else if (sends === 0)
    problems.push("the host sent nothing after the restore's first credit");
  return {
    problems,
    credits_after: after.length,
    detail: `${after.length} credited acks after the restore, ${sends} sends after the first`,
  };
}

/** Q10's sabotage rule (pure): the leg fails exactly `expected`. */
export function lcSabotageProblems(
  failing: ReadonlyMap<string, readonly string[]>,
  expected: readonly string[],
): string[] {
  const ids = [...failing.keys()].sort();
  const want = [...expected].sort();
  return JSON.stringify(ids) === JSON.stringify(want)
    ? []
    : [
        `failing ${ids.join(", ") || "nothing"}, expected exactly ${want.join(", ")}`,
      ];
}

// ---------------------------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------------------------

function readLines<T>(path: string): T[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

/** Every shot of a leg's applied.json (window shots and the final one) with its local path and
 * the reference frame it claims, for the banded loader. */
function shotPairs(
  ev: G6lLegEvidence,
  liveDir: string,
): { pairs: Map<string, string>; final: G6lCheckpoint | null } {
  const pairs = new Map<string, string>();
  let final: G6lCheckpoint | null = null;
  const host = ev.host;
  if (!host) return { pairs, final };
  for (const s of ev.applied?.shots ?? []) {
    if (!Number.isInteger(s.seq)) continue;
    const stream = s.stream ?? 1;
    const w = wireFrameOf(host, stream, s.seq as number);
    if (w.wire === null) continue;
    const isFinal = (s as { final?: boolean }).final === true;
    const path = isFinal
      ? finalShotPath(
          ev.receiverDir,
          (s as { path?: string }).path ?? "final.png",
        )
      : join(ev.receiverDir, "shots", shotName(stream, s.seq as number));
    pairs.set(path, referenceFrame(liveDir, w.wire));
    if (isFinal)
      final = {
        leg: ev.leg,
        stream,
        seq: s.seq as number,
        window: -1,
        frame: w.frame,
        wire: w.wire,
        wire_equals_full: w.equals_full,
        shot: path,
        vs_wire: null,
        vs_wire_regions: [],
        vs_frame: null,
        vs_frame_regions: [],
      };
  }
  return { pairs, final };
}

async function judgeFinal(
  e: Pick<Gate6Expected, "shots">,
  cp: G6lCheckpoint | null,
  liveDir: string,
  load: FrameLoader,
): Promise<G6lCheckpoint | null> {
  if (!cp || cp.wire === null) return cp;
  const r = compareAt(
    e,
    await load(referenceFrame(liveDir, cp.wire)),
    await load(cp.shot),
    cp.wire,
  );
  cp.vs_wire = r.mismatched;
  cp.vs_wire_regions = r.regions;
  cp.vs_frame = r.mismatched;
  cp.vs_frame_regions = r.regions;
  return cp;
}

/** The leg as connection 2 alone, renumbered 1: the reloaded page's evidence (its stream 1). */
async function connection2View(ev: G6lLegEvidence): Promise<G6lLegEvidence> {
  const host = ev.host;
  const c2 = host?.connections.find((c) => c.n === 2);
  if (!host || !c2)
    return { ...ev, host: host ? { ...host, connections: [] } : null };
  const r = await loadResolved(
    join(ev.receiverDir, receivedFileName(ev.receiverDir, 1)),
  );
  const view: G2cHost = {
    ...host,
    connections: [{ ...c2, n: 1, received: r.present ? r : null }],
  };
  return { ...ev, host: view };
}

function quitFrames(stdout: string | undefined): {
  ready: number | null;
  quit: number | null;
} {
  const ready = /\[fixture\] gate6-scene ready:.* quit=(\d+)/.exec(
    stdout ?? "",
  );
  const quit = /\[fixture\] quitting frame=(\d+)/.exec(stdout ?? "");
  return {
    ready: ready ? Number(ready[1]) : null,
    quit: quit ? Number(quit[1]) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// One run (a receiver kind in one environment)
// ---------------------------------------------------------------------------------------------

export interface G7uLegSummary {
  leg: string;
  action: G7uAction;
  evidence: G7uEvidence;
  mechanism: string | null;
  result_class: string | null;
  recovered?: "reload";
  checks: Record<string, G7uStatus>;
  measures: Record<string, unknown>;
  device?: Lifecycle["device"];
}

export interface G7uRunResult {
  group: "g7-lc";
  kind: G7uKind;
  env: G7uEnv;
  device: string | null;
  live: true;
  passed: boolean;
  run_dir: string | null;
  checks: G7uCheck[];
  legs: G7uLegSummary[];
}

interface RunInput {
  out: string;
  kind: G7uKind;
  env: G7uEnv;
  device: string | null;
  runDir: string;
  e: Gate6Expected;
}

/** S as the run's hosts ran it: the first leg's host steps.jsonl (step 0's settle frame less the
 * settle offset), or null when no host logged steps. */
export function runStartFrame(liveDir: string): number | null {
  let legs: string[] = [];
  try {
    legs = readdirSync(liveDir).sort();
  } catch {
    return null;
  }
  for (const leg of legs) {
    let text = "";
    try {
      text = readFileSync(join(liveDir, leg, "host", "steps.jsonl"), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as { step?: number; settle_frame?: number };
        if (s.step === 0 && typeof s.settle_frame === "number")
          return s.settle_frame - 7;
      } catch {
        // not a step line
      }
    }
  }
  return null;
}

/** A device run's S: the hosts' (runStartFrame) must be what the daemon recorded for every leg
 * (lifecycle.json device.fixture_start_frame; null = 300). */
function startFrameProblems(
  liveDir: string,
  legs: readonly string[],
  s: number | null,
): string[] {
  if (s === null) return ["no host steps.jsonl: S unknown"];
  const out: string[] = [];
  for (const leg of legs) {
    try {
      const l = JSON.parse(
        readFileSync(join(liveDir, leg, "receiver", "lifecycle.json"), "utf8"),
      ) as Lifecycle;
      const recorded = l.device?.fixture_start_frame ?? G6L_DEFAULT_START_FRAME;
      if (recorded !== s)
        out.push(
          `${leg}: lifecycle.json records S ${recorded}, the hosts ran S ${s}`,
        );
    } catch {
      // a missing lifecycle.json is the leg's own took-effect failure
    }
  }
  return out;
}

/** One run of a kind (header). A device run may have raised S (run-gate6.sh G7U_START_FRAME):
 * its G6l frames are judged at the S its hosts logged, then S is restored to 300. */
export async function checkG7uRun(i: RunInput): Promise<G7uRunResult> {
  const s = i.env === "device" ? runStartFrame(join(i.runDir, G6L_DIR)) : null;
  if (s === null || s === G6L_DEFAULT_START_FRAME) return checkG7uRunAt(i, s);
  const previous = setG6lStartFrame(s);
  try {
    return await checkG7uRunAt(i, s);
  } finally {
    setG6lStartFrame(previous);
  }
}

async function checkG7uRunAt(
  i: RunInput,
  startFrame: number | null,
): Promise<G7uRunResult> {
  const { kind, env, device, runDir, e } = i;
  const liveDir = join(runDir, G6L_DIR);
  const at = (id: string, leg: string) =>
    `${id}@${kind}${device ? `-${device}` : ""}:${leg}`;
  const checks: G7uCheck[] = [];
  const legs: G7uLegSummary[] = [];
  const want = legsFor(kind, env);
  const present = want.filter((l) => existsSync(join(liveDir, l)));
  const missing = want.filter((l) => !present.includes(l));
  checks.push(
    lc(
      `g7u-run@${kind}${device ? `-${device}` : ""}`,
      `G7u: run-gate6.sh --legs g6l with G7U_LEGS ran every ${env} lifecycle leg of this receiver kind into ${liveDir}`,
      [
        ...missing.map((l) => `leg ${l} not run`),
        ...(env === "device"
          ? startFrameProblems(liveDir, present, startFrame)
          : []),
      ],
      `${present.length} legs${env === "device" ? `, S ${startFrame ?? "?"}` : ""}`,
      env === "desktop" ? "simulated-suspension" : "real",
    ),
  );
  const expectedKind = kind === "web" ? "web-export" : "gsw-canvas";

  for (const leg of present) {
    const def = legDef(env, leg) as G7uLegDef;
    const legChecks: G7uCheck[] = [];
    const ev = await loadG6lLeg(liveDir, leg);
    const lcJson = await readJson<Lifecycle>(
      join(ev.receiverDir, "lifecycle.json"),
    );
    const took = evaluateTookEffect(lcJson, def, env);
    const evidence = took.evidence;
    const real = evidence === "real";
    const add = (
      id: string,
      criterion: string,
      problems: readonly string[],
      ok: string,
    ) =>
      legChecks.push(
        lc(at(id, leg), `${leg}: ${criterion}`, problems, ok, evidence),
      );
    const summary: G7uLegSummary = {
      leg,
      action: def.action,
      evidence,
      mechanism: lcJson?.mechanism ?? null,
      result_class: null,
      checks: {},
      measures: {},
      device: lcJson?.device ?? null,
    };
    const pages = lcJson?.pages ?? [];
    const page = pages[0];
    const host = ev.host;
    const c1 = host?.connections[0];

    // Browser basics: provenance, console, hello per connection, and the web export's core.
    const page_ = await readJson<PageConfig>(
      join(ev.receiverDir, "page-config.json"),
    );
    const basics = await browserLegProblems(ev.receiverDir, leg);
    const consoleBad =
      def.action === "context-loss"
        ? basics.console.filter(
            (m) => !/CONTEXT_LOST_WEBGL|context lost/i.test(m),
          )
        : basics.console;
    const provKindBad =
      env === "device" &&
      (
        await readJson<DeviceProvenanceJson>(
          join(ev.receiverDir, "provenance.json"),
        )
      )?.kind !== "device-provenance"
        ? ["provenance.json is not a device-provenance verdict"]
        : [];
    add(
      "browser-provenance",
      env === "device"
        ? "Q13b device-provenance verdict (provenance.json: serial, model, GPU, thermal none, battery >= 20 %, the tab in front, landscape)"
        : "Q6 provenance.json verdict",
      [...basics.provenance, ...provKindBad],
      "provenance ok",
    );
    add(
      "console-clean",
      `no SHADER ERROR, \`WebGL: \` error or uncaught page error${def.action === "context-loss" ? " (the loss's own CONTEXT_LOST_WEBGL lines excepted)" : ""}`,
      consoleBad,
      "console clean",
    );
    const hello: string[] = [];
    const devProv =
      env === "device"
        ? await readJson<DeviceProvenanceJson>(
            join(ev.receiverDir, "provenance.json"),
          )
        : undefined;
    for (const c of host?.connections ?? []) {
      const s = c.summary as SummaryConnection | undefined;
      if (!s) hello.push(`connection ${c.n}: no host summary`);
      else {
        const bad =
          env === "device"
            ? deviceHelloProblems(s, page_, expectedKind, kind, devProv)
            : helloProblems(s, page_, expectedKind);
        if (bad.length > 0) hello.push(`connection ${c.n}: ${bad.join(", ")}`);
      }
    }
    if (!host) hello.push("no host evidence");
    add(
      "hello-recorded",
      "Q8: each connection's host summary shows the /7 hello",
      hello,
      `${host?.connections.length ?? 0} connections`,
    );

    if (def.action === "suspend") {
      // Real legs: trusted only when the page shows the suspension took effect.
      if (real || env === "device")
        add(
          "took-effect",
          `the ${def.suspend_kind} suspension took effect, from the page's own records (${def.suspend_kind === "hidden" ? "a hidden visibilitychange in the window and no rAF" : "freeze/resume, or no rAF and no timer tick"})`,
          took.problems,
          took.detail,
        );
      else
        add(
          "simulated-window",
          `the shim's simulated ${def.suspend_kind} suspension ran as specified (labelled simulated-suspension, a window of at least 0.9 x ${def.ms} ms); it never answers a real ${def.suspend_kind} requirement`,
          took.problems,
          took.detail,
        );
      // D14 as amended: a frozen page may lose its socket (a CDP freeze closes it on `active`).
      // Then the leg is judged as gate 1d's reconnect after the loss, under the same check ids.
      const appliedX = ev.applied as
        | (G6lApplied & {
            failure?: { reason?: string; detail?: string } | null;
            status?: string;
            streams?: { stream_id?: string | null; end_seen?: boolean }[];
          })
        | undefined;
      const lossList = (
        ev.applied?.live as { loss_reconnects?: LossReconnect[] } | undefined
      )?.loss_reconnects;
      const lost =
        def.suspend_kind === "frozen" &&
        transportLost(
          host?.connections.length ?? 0,
          appliedX?.failure,
          lossList,
          c1?.summary?.close_code,
        );
      const socketId =
        def.suspend_kind === "frozen"
          ? "socket-kept-or-reconnected"
          : "socket-kept";
      summary.measures.transport =
        def.suspend_kind !== "frozen" ? "kept" : lost ? "lost" : "kept";
      if (lost) {
        const pr = shotPairs(ev, liveDir);
        const snapped = new Map<string, number>();
        const load = bandedLoader(pr.pairs, loadFrame, snapped);
        const g = await classifyG6lLeg(
          e,
          ev,
          { ...G6L_LC_LEG, stall: false, reconnect: true },
          liveDir,
          load,
        );
        g.digest = digestLeg(e, g) ?? undefined;
        const fin = await judgeFinal(e, pr.final, liveDir, load);
        summary.result_class = g.result_class;
        add(
          "leg-class",
          "kept: class success over the synthesised stall; lost (D14 as amended): class success over both connections (G6l's classification: connection 1 a prefix of its tap, connection 2 to its end record)",
          g.result_class === "success"
            ? []
            : [`class ${g.result_class}: ${g.reasons.slice(0, 3).join("; ")}`],
          "success (lost socket, reconnected)",
        );
        const rs = evaluateRafStopped(page);
        add(
          "raf-stopped",
          "no rAF callback ran while suspended (prediction 0)",
          rs.problems,
          rs.detail,
        );
        const conns = host?.connections ?? [];
        const lc1 = conns.find((c) => c.n === 1);
        const lc2 = conns.find((c) => c.n === 2);
        const eventLine = (
          c: (typeof conns)[number] | undefined,
          name: string,
        ) => c?.host.log?.find((l) => l.event === name);
        const close1 = eventLine(lc1, "close");
        const open2 = eventLine(lc2, "open");
        const c1Sends = lc1?.host.log ? sendsOf(lc1.host.log) : [];
        const lastSend1 = c1Sends.at(-1) ?? null;
        // The suspension's start on the host clock: gsw maps the page window through its acks'
        // receiver clock (as synthesiseStall); the web export's clock is the engine's, so the
        // window is bounded by connection 1's close, less half the suspension.
        const synth = synthesiseStall(
          kind,
          lc1?.host.log,
          page,
          { step: def.step, ms: def.ms },
          lcJson?.mechanism ?? "?",
        );
        const closeUs = close1?.t_us ?? null;
        const startUs =
          kind === "gsw"
            ? (synth.window_host_us?.[0] ?? null)
            : closeUs === null
              ? null
              : closeUs - 0.5 * def.ms * 1000;
        const pb = evaluateLossPendingBounded(
          [g.delivery[0], g.delivery[1]],
          [lc1?.summary, lc2?.summary],
          c1Sends,
          startUs,
          closeUs,
        );
        add(
          "pending-bounded",
          "max_in_flight <= window (1), max_pending <= 1, nothing sent inside the suspension, queued bytes at most one credit window + control (lost: on both connections, and connection 1 sends nothing between the suspension's start and its close)",
          pb.problems,
          pb.detail,
        );
        // host-unperturbed over connection 1's suspension: gsw the mapped page window, web the
        // last send (in flight at the freeze) to the close.
        const hw: [number, number] | null =
          closeUs === null
            ? null
            : kind === "gsw" && synth.window_host_us
              ? [
                  synth.window_host_us[0],
                  Math.min(synth.window_host_us[1], closeUs),
                ]
              : lastSend1
                ? [lastSend1.t_us, closeUs]
                : null;
        const range = lc1?.host.log ? hostFrameRange(lc1.host.log, hw) : null;
        let hu: { problems: string[]; detail: string } = {
          problems: ["the suspension is not visible in the host log"],
          detail: "",
        };
        if (range && lc1?.host.log) {
          const [sf, cf] = range;
          const len = cf - sf;
          const firstStreaming =
            lc1.host.log.find((l) => l.state === "streaming")?.frame ?? 0;
          const before = hostCadence(
            lc1.host.log,
            Math.max(firstStreaming + 30, sf - len),
            sf,
          );
          const during = hostCadence(lc1.host.log, sf + 1, cf);
          hu = evaluateHostUnperturbed(before, during);
          summary.measures.host_cadence = { before, during };
        }
        add(
          "host-unperturbed",
          "frame-interval p95 within 5 % and frame rate within 2 % of the same leg's window before the suspension",
          hu.problems,
          hu.detail,
        );
        const tap2 = lc2?.tap.recording?.transactions[0];
        const lr = evaluateLossReconnect(
          conns.map((c) => ({
            n: c.n,
            summary: c.summary,
            open_frame: eventLine(c, "open")?.frame ?? null,
            close_frame: eventLine(c, "close")?.frame ?? null,
            first:
              c.n === 2 && tap2
                ? { seq: tap2.seq, encoding: tap2.encoding }
                : null,
          })),
          {
            status: appliedX?.status,
            failure: appliedX?.failure,
            streams: appliedX?.streams,
            reconnect: ev.applied?.live?.reconnect,
            loss_reconnects: lossList,
          },
          pages.length,
          page?.trigger?.frame ?? null,
          def.ms,
        );
        add(
          socketId,
          "D14 as amended: kept, the same stream_id throughout with no reconnect and no abnormal close; or lost on the page's side during the suspension and recovered by gate 1d's reconnect (a new connection, a new stream_id, seq 1 full, a clean dispose, one document, the end record seen)",
          lr.problems,
          lr.detail,
        );
        const txs = (ev.applied?.transactions ?? []).map((t) => {
          const x = t as Record<string, unknown>;
          return {
            stream: (x.stream as number | undefined) ?? 1,
            seq: (x.seq as number | undefined) ?? 0,
            frame: (x.frame as number | undefined) ?? null,
            encoding: (x.encoding as string | undefined) ?? null,
            applied_us:
              typeof x.applied_us === "number" && !x.skipped
                ? (x.applied_us as number)
                : null,
          };
        });
        const nf = evaluateNewestFirst(txs, open2?.frame ?? null);
        add(
          "stall-latest",
          "kept: the first post-resume applied state is the host's recovery send and equals its mirror at that frame (G6l's stall-latest); lost: the first state applied after the loss is connection 2's seq 1 full, formed after connection 2 opened (the newest), and nothing of connection 1 is applied after it",
          nf.problems,
          nf.detail,
        );
        // fetch-latest-only over the loss: TEXA's versions that landed between the suspension's
        // start and connection 2's first state; TEXA is freed inside a 30-s suspension, so none.
        const sf = range?.[0] ?? null;
        const recFrame = nf.first?.frame ?? null;
        const texaGone =
          host && sf !== null && recFrame !== null
            ? texaFreedIn(host.hook.lines, e.texture_hashes.TEXA0, sf, recFrame)
            : null;
        const fetches = ev.applied?.fetches ?? [];
        if (texaGone)
          add(
            "fetch-latest-only",
            "TEXA was freed inside the suspension, so none of its versions that landed there is fetched (lost: up to connection 2's first state)",
            texaFetchedIn(fetches, texaGone.versions),
            `TEXA freed at frame ${texaGone.freed_frame} (connection 2's first state at frame ${recFrame}); ${texaGone.versions.length} versions landed in frames ${(sf ?? 0) + 1}..${texaGone.freed_frame}, none fetched`,
          );
        else {
          const versions = g.digest?.texa_versions ?? null;
          const fr =
            versions && sf !== null && recFrame !== null
              ? evaluateFetchLatestOnly(
                  versions,
                  fetches
                    .filter((f) => (f as { stream?: number }).stream === 2)
                    .map((f) => ({ ...f, stream: 1 })),
                  sf,
                  recFrame,
                  { seq: 1, frame: recFrame },
                )
              : null;
          add(
            "fetch-latest-only",
            "of TEXA's versions that landed inside the suspension (lost: up to connection 2's first state), exactly one is fetched, the one current at the recovery",
            fr ? fr.problems : ["no TEXA versions or no recovery frame"],
            fr
              ? `${fr.in_stall.length} versions in the suspension; ${fr.current?.slice(0, 12)} fetched for connection 2's seq 1`
              : "",
          );
        }
        const resumeTx: ResumeTx[] = (ev.applied?.transactions ?? []).map(
          (t) => {
            const x = t as Record<string, unknown> & {
              paced?: { applied_raf?: number };
            };
            return {
              stream: (x.stream as number | undefined) ?? 1,
              seq: (x.seq as number | undefined) ?? 0,
              coalesced_into:
                (x.coalesced_into as number | null | undefined) ?? null,
              applied: typeof x.applied_us === "number" && !x.skipped,
              skipped: (x.skipped as string | null | undefined) ?? null,
              frame_key:
                kind === "gsw"
                  ? (x.paced?.applied_raf ?? null)
                  : ((x.process_frame as number | undefined) ?? null),
            };
          },
        );
        const rn = evaluateResumeNoBurst(
          resumeTx,
          1,
          (lc2?.host.log ? sendsOf(lc2.host.log) : []).map((s) => s.seq),
          2,
        );
        // Connection 1's tail lost with the socket: sent, never recorded. At most the window.
        const seen1 = new Set(
          resumeTx.filter((t) => t.stream === 1).map((t) => t.seq),
        );
        const lostTail = c1Sends
          .filter((s) => !seen1.has(s.seq))
          .map((s) => s.seq);
        add(
          "resume-no-burst",
          "at most two applies in the first resumed frame, none skipped silently (lost: on connection 2 from its seq 1; connection 1's sends lost with the socket at most the credit window, 1)",
          [
            ...rn.problems,
            ...(lostTail.length > 1
              ? [
                  `${lostTail.length} connection 1 sends lost with the socket (${lostTail.slice(0, 6).join(",")}), more than the window`,
                ]
              : []),
          ],
          `${rn.detail}; connection 1 lost ${lostTail.length} in-flight send(s) with the socket${lostTail.length ? ` (seq ${lostTail.join(",")})` : ""}`,
        );
        if (fin) g.checkpoints.push(fin);
        const after2 = g.checkpoints.filter((c) => c.stream === 2 || c === fin);
        const badAfter = after2.filter((c) => c.vs_frame !== 0);
        add(
          "stall-recovery",
          "kept: every shot after the stall equals the reference (G6l's stall-recovery); lost: every shot of connection 2 and the final shot equal the reference at their frames (Q7's band)",
          [
            ...(after2.length === 0 ? ["no shot after the reconnect"] : []),
            ...badAfter
              .slice(0, 6)
              .map(
                (c) =>
                  `stream ${c.stream} seq ${c.seq} (frame ${c.frame}): ${c.vs_frame ?? "unreadable"} px differ in ${c.vs_frame_regions.join(",")}`,
              ),
          ],
          `${after2.length} shots after the reconnect equal the reference`,
        );
        const firstCredit2 = lc2?.host.log?.find(
          (l) => l.event === "ack" && l.credited,
        )?.t_us;
        const first2Applied = nf.first?.applied_us ?? null;
        const visibleAfter = (page?.visibility ?? []).find(
          (v) => v.state === "visible" && v.t >= (page?.window?.end_t ?? 0),
        );
        Object.assign(summary.measures, {
          suspension_ms:
            page?.window?.end_t !== undefined &&
            page?.window?.start_t !== undefined
              ? page.window.end_t - page.window.start_t
              : null,
          loss_code_page: lossList?.[0]?.code ?? null,
          loss_close_host: lc1?.summary?.close_code ?? null,
          connect_attempts: lossList?.[0]?.connect_attempts ?? null,
          // Chrome closes a frozen page's socket on `active`: the host's close is the resume.
          resume_to_newest_host_us:
            closeUs !== null && firstCredit2 !== undefined
              ? firstCredit2 - closeUs
              : null,
          loss_to_reconnect_open_ms:
            closeUs !== null && open2 ? (open2.t_us - closeUs) / 1000 : null,
          // GSW's receiver clock is the page's: the freeze's `resume` -> connection 2's first apply.
          resume_to_newest_page_ms:
            kind === "gsw" &&
            first2Applied !== null &&
            typeof page?.window?.end_t === "number"
              ? first2Applied / 1000 - page.window.end_t
              : null,
          // The g31 page stays hidden after `active` until the harness's HOME + am start round
          // trip, and draws nothing until visible: the share of resume -> newest that is the
          // receiver's own (gsw: the page clock).
          resume_to_visible_page_ms:
            visibleAfter && typeof page?.window?.end_t === "number"
              ? visibleAfter.t - page.window.end_t
              : null,
          visible_to_newest_page_ms:
            kind === "gsw" && first2Applied !== null && visibleAfter
              ? first2Applied / 1000 - visibleAfter.t
              : null,
          resume_to_first_raf_page_ms:
            typeof page?.raf?.first_after_t === "number" &&
            typeof page?.window?.end_t === "number"
              ? page.raf.first_after_t - page.window.end_t
              : null,
          sends_during: pb.sends_during.length,
          lost_in_flight: lostTail,
          max_in_flight: Math.max(
            0,
            ...g.delivery.map((d) => d?.max_in_flight ?? 0),
          ),
          max_pending: Math.max(
            0,
            ...conns.map((c) => c.summary?.max_pending ?? 0),
          ),
          coalesced_during: lc1?.summary?.coalesced ?? null,
          first_resumed_frame_applies: rn.first_frame_applies,
          raf_held: page?.raf?.held ?? null,
          band_snapped_px: [...snapped.values()].reduce((a, b) => a + b, 0),
        });
      } else {
        const synth = synthesiseStall(
          kind,
          c1?.host.log,
          page,
          { step: def.step, ms: def.ms },
          lcJson?.mechanism ?? "?",
        );
        if (ev.applied && synth.stall)
          ev.applied = {
            ...ev.applied,
            live: { ...(ev.applied.live ?? {}), stall: synth.stall },
          };
        const pr = shotPairs(ev, liveDir);
        const snapped = new Map<string, number>();
        const load = bandedLoader(pr.pairs, loadFrame, snapped);
        const g = await classifyG6lLeg(e, ev, G6L_LC_LEG, liveDir, load);
        g.digest = digestLeg(e, g) ?? undefined;
        const fin = await judgeFinal(e, pr.final, liveDir, load);
        summary.result_class = g.result_class;
        add(
          "leg-class",
          "class success (G6l's classification over the synthesised stall)",
          g.result_class === "success"
            ? []
            : [`class ${g.result_class}: ${g.reasons.slice(0, 3).join("; ")}`],
          "success",
        );
        const rs = evaluateRafStopped(page);
        add(
          "raf-stopped",
          "no rAF callback ran while suspended (prediction 0)",
          rs.problems,
          rs.detail,
        );
        const st = g.stall;
        const pb = evaluatePendingBounded(
          g.delivery[0],
          c1?.summary,
          st,
          synth,
        );
        add(
          "pending-bounded",
          "max_in_flight <= the granted window w (1 by default), max_pending <= 1, nothing sent inside the suspension but the stalled seq's w - 1 in-window sends, queued bytes during it at most w credit windows + control",
          pb.problems,
          pb.detail,
        );
        // The suspension on the host clock (gsw: the page window mapped; web: the credit gap) as a
        // host-frame range, so the cadence never depends on where a credit happened to land.
        const range = c1?.host.log
          ? hostFrameRange(c1.host.log, synth.window_host_us)
          : null;
        const sf = range?.[0] ?? null;
        const cf = range?.[1] ?? null;
        let hu: { problems: string[]; detail: string } = {
          problems: ["the suspension is not visible in the host log"],
          detail: "",
        };
        if (sf !== null && cf !== null && c1?.host.log) {
          const len = cf - sf;
          const firstStreaming =
            c1.host.log.find((l) => l.state === "streaming")?.frame ?? 0;
          const before = hostCadence(
            c1.host.log,
            Math.max(firstStreaming + 30, sf - len),
            sf,
          );
          const during = hostCadence(c1.host.log, sf + 1, cf);
          hu = evaluateHostUnperturbed(before, during);
          summary.measures.host_cadence = { before, during };
        }
        add(
          "host-unperturbed",
          "frame-interval p95 within 5 % and frame rate within 2 % of the same leg's window before the suspension",
          hu.problems,
          hu.detail,
        );
        const sk = evaluateSocketKept(
          (host?.connections ?? []).map((c) => ({
            n: c.n,
            stream_id: c.summary?.stream_id,
          })),
          (
            ev.applied as
              | { streams?: { stream_id?: string | null }[] }
              | undefined
          )?.streams,
          pages.length,
          ev.applied?.live?.reconnect,
          (
            ev.applied as {
              failure?: { reason?: string; detail?: string } | null;
            }
          )?.failure,
          c1?.summary?.close_code,
        );
        add(
          socketId,
          def.suspend_kind === "frozen"
            ? "D14 as amended: kept, the same stream_id throughout with no reconnect and no abnormal close; or lost on the page's side during the suspension and recovered by gate 1d's reconnect (a new connection, a new stream_id, seq 1 full, a clean dispose, one document, the end record seen)"
            : "the same stream_id throughout, with no reconnect and no abnormal close",
          sk.problems,
          sk.detail,
        );
        const evals = new Map<string, G6lEvaluation>([["live-stall", g]]);
        // G7q: a resume fold ahead of the recovery (credit flowed to the suspended page past the
        // stalled seq's w - 1 in-window sends) is the first post-resume picture; stall-latest and
        // fetch-latest-only judge it as well (null at window 1 and on an honest resume).
        const fold = resumeFoldAhead(
          st?.stalled_seq ?? null,
          g.delivery[0]?.window ?? 1,
          (ev.applied?.transactions ?? []) as {
            stream?: number;
            seq?: number;
            frame?: number | null;
            coalesced_into?: number | null;
          }[],
          st?.recovery?.seq ?? null,
          (seq) => sendFacts(c1?.host, seq),
        );
        const sl = evaluateStallLatest(
          st,
          appliedTransactions(ev.applied),
          g.checkpoints,
          G6L_QUIT_FRAME,
          g.delivery[0]?.window ?? 1,
          fold,
        );
        add(
          "stall-latest",
          "the first post-resume applied state is the host's recovery send and equals its mirror at that frame (G6l's stall-latest)",
          sl.problems,
          sl.detail,
        );
        // G6l's rule over the suspension: its TEXA versions are those landing after the stalled
        // send, unless that send came late in the window (credit kept flowing: the ack-while-hidden
        // sabotage), when they are those landing after the window's first frame.
        const fetchFrom = fetchWindowStart(st?.send_frame ?? null, sf);
        // A 30-s suspension outlives TEXA itself: the scene frees it at step 9 (frame 840), so the
        // recovery's state holds no TEXA and G6l's "exactly one version fetched" becomes "none".
        const texaGone =
          st?.recovery && host && fetchFrom !== null
            ? texaFreedIn(
                host.hook.lines,
                e.texture_hashes.TEXA0,
                fetchFrom,
                fold?.frame ?? st.recovery.frame,
              )
            : null;
        if (texaGone)
          add(
            "fetch-latest-only",
            `TEXA was freed inside the suspension, so none of its versions that landed there is fetched (G6l's rule, which needs TEXA live at the recovery)`,
            texaFetchedIn(ev.applied?.fetches ?? [], texaGone.versions),
            `TEXA freed at frame ${texaGone.freed_frame} (recovery frame ${st?.recovery?.frame}); ${texaGone.versions.length} versions landed in frames ${(fetchFrom ?? 0) + 1}..${texaGone.freed_frame}, none fetched`,
          );
        else
          legChecks.push(
            fromG6(
              checkFetchLatestOnly(
                new Map([
                  [
                    "live-stall",
                    st && fetchFrom !== null
                      ? {
                          ...g,
                          stall: {
                            ...st,
                            send_frame: fetchFrom,
                            recovery:
                              fold && st.recovery
                                ? {
                                    ...st.recovery,
                                    seq: fold.seq,
                                    frame: fold.frame,
                                  }
                                : st.recovery,
                          },
                        }
                      : g,
                  ],
                ]),
              ),
              at("fetch-latest-only", leg),
              leg,
              evidence,
            ),
          );
        const resumeTx: ResumeTx[] = (ev.applied?.transactions ?? []).map(
          (t) => {
            const x = t as Record<string, unknown> & {
              paced?: { applied_raf?: number };
            };
            return {
              stream: (x.stream as number | undefined) ?? 1,
              seq: (x.seq as number | undefined) ?? 0,
              coalesced_into:
                (x.coalesced_into as number | null | undefined) ?? null,
              applied: typeof x.applied_us === "number" && !x.skipped,
              skipped: (x.skipped as string | null | undefined) ?? null,
              frame_key:
                kind === "gsw"
                  ? (x.paced?.applied_raf ?? null)
                  : ((x.process_frame as number | undefined) ?? null),
            };
          },
        );
        const rn = evaluateResumeNoBurst(
          resumeTx,
          st?.stalled_seq ?? null,
          (c1?.host.log ? sendsOf(c1.host.log) : []).map((s) => s.seq),
        );
        add(
          "resume-no-burst",
          "at most two applies in the first resumed frame, none skipped silently",
          rn.problems,
          rn.detail,
        );
        if (fin) g.checkpoints.push(fin);
        legChecks.push(
          fromG6(
            checkStallRecovery(evals),
            at("stall-recovery", leg),
            leg,
            evidence,
          ),
        );
        // Measures.
        const visible = (page?.visibility ?? []).find(
          (v) => v.state === "visible" && v.t >= (page?.window?.start_t ?? 0),
        );
        // A real freeze resumes at its `resume` event (the window's end): on the g31 the page runs
        // rAF after `resume` while still reporting hidden until the HOME + am start round trip.
        const resumedAt =
          real && def.suspend_kind === "hidden"
            ? visible?.t
            : page?.window?.end_t;
        Object.assign(summary.measures, {
          suspension_ms:
            page?.window?.end_t !== undefined &&
            page?.window?.start_t !== undefined
              ? page.window.end_t - page.window.start_t
              : null,
          stall_method: synth.method,
          stalled_seq: st?.stalled_seq ?? null,
          credit_gap_ms:
            synth.credit_gap_us === null ? null : synth.credit_gap_us / 1000,
          resume_to_newest_host_us:
            st?.recovery?.credit_to_applied_ack_us ?? null,
          resume_to_first_raf_page_ms:
            typeof page?.raf?.first_after_t === "number" &&
            typeof resumedAt === "number"
              ? page.raf.first_after_t - resumedAt
              : null,
          coalesced_during: st?.coalesced_delta ?? null,
          sends_during: (st?.sends_during ?? 0) + synth.sends_in_window.length,
          max_in_flight: g.delivery[0]?.max_in_flight ?? null,
          max_pending: Math.max(
            c1?.summary?.max_pending ?? 0,
            st?.max_pending ?? 0,
          ),
          queued_bytes_during: st?.max_queued_bytes_during ?? null,
          queued_bytes_max: g.delivery[0]?.max_queued_bytes ?? null,
          first_resumed_frame_applies: rn.first_frame_applies,
          raf_held: page?.raf?.held ?? null,
          band_snapped_px: [...snapped.values()].reduce((a, b) => a + b, 0),
        });
      }
      add(
        "credit-from-paced-loop",
        "Q9: every submitted ack follows the rAF callback that applied and drew that seq",
        ev.applied
          ? pacedLoopProblems(leg, ev.applied)
          : ["applied.json missing"],
        "every ack from the paced loop",
      );
      if (kind === "gsw" && env === "device") {
        // A compositor capture on the phone is at its DPR (2.625 on the g31), never the 640x360
        // readback's pixel grid, so the exact comparison has no device mechanism.
        legChecks.push(
          unavailable(
            at("compositor-equals-readback", leg),
            `${leg}: Q7: the canvas's screenshot at exit equals shots/final.png exactly`,
            `a device compositor capture is at the phone's DPR (${summary.device ? "lifecycle.json device block" : "no device block"}; hello dpr_milli ${host?.connections[0]?.summary ? (host.connections[0].summary as SummaryConnection).dpr_milli : "?"}), so it cannot equal the ${page_?.canvas?.join("x") ?? "640x360"} readback pixel for pixel; the desktop legs answer it`,
            evidence,
          ),
        );
      } else if (kind === "gsw") {
        const comp = await decodePngRgba(
          join(
            ev.receiverDir,
            lcJson?.compositor ?? join("compositor", "screenshot.png"),
          ),
        );
        const shot = await decodePngRgba(
          join(ev.receiverDir, "shots", "final.png"),
        );
        const cd = compositorDiff(
          shot
            ? { width: shot.width, height: shot.height, data: shot.data }
            : null,
          comp
            ? { width: comp.width, height: comp.height, data: comp.data }
            : null,
        );
        add(
          "compositor-equals-readback",
          "Q7: the canvas's screenshot at exit equals shots/final.png exactly",
          cd.problems,
          "identical",
        );
      }
      // An untrusted real suspension answers nothing: every other check of the leg is unavailable.
      if (env === "device")
        legChecks.splice(
          0,
          legChecks.length,
          ...demoteUntrusted(legChecks, took.problems),
        );
    } else if (
      def.action === "reload" ||
      (def.action === "context-loss" && kind === "web")
    ) {
      const view = await connection2View(ev);
      const pr = shotPairs(view, liveDir);
      const snapped = new Map<string, number>();
      const load = bandedLoader(pr.pairs, loadFrame, snapped);
      const g = await classifyG6lLeg(
        e,
        view,
        { ...G6L_LC_LEG, stall: false },
        liveDir,
        load,
      );
      const fin = await judgeFinal(e, pr.final, liveDir, load);
      // The full host (both connections) for the pins and the summaries.
      const gFull = { ...g, ev, leg: { ...G6L_LC_LEG, stall: false } };
      const dg = digestLeg(e, gFull);
      summary.result_class = g.result_class;
      if (def.action === "context-loss") summary.recovered = "reload";
      const name = def.action === "reload" ? "reload" : "context-loss";
      add(
        "leg-class",
        `the reloaded page's evaluation (host connection 2) is class success${def.action === "context-loss" ? ", recovered: reload" : ""}`,
        g.result_class === "success"
          ? []
          : [`class ${g.result_class}: ${g.reasons.slice(0, 3).join("; ")}`],
        "success",
      );
      if (def.action === "context-loss") {
        const stub = await readJson<{ schema?: string; t_ms?: number }>(
          join(ev.receiverDir, "context-lost.json"),
        );
        add(
          "context-lost-recorded",
          "the shell recorded the loss (context-lost.json, render-stream-context-lost/1) and reloaded",
          [
            ...(stub?.schema === "render-stream-context-lost/1"
              ? []
              : [
                  `context-lost.json ${stub ? `schema ${stub.schema}` : "missing"}`,
                ]),
            ...(pages.length === 2
              ? []
              : [`${pages.length} documents, expected 2 (the shell's reload)`]),
          ],
          `lost at ${fmt(stub?.t_ms)} ms, reloaded`,
        );
      }
      // Connection 2's first transaction as the host tapped it (the receiver's copy is judged by
      // leg-class: received equals the tap).
      const tap2 = view.host?.connections[0]?.tap.recording?.transactions[0];
      const rc = evaluateReloadReconnect(
        (dg?.connections ?? []).map((c) => ({
          n: c.n,
          summary: c.summary,
          first:
            c.n === 2
              ? tap2
                ? { seq: tap2.seq, encoding: tap2.encoding }
                : null
              : c.first_received,
        })),
        pages,
        def.step,
      );
      const pins = dg?.resources?.pins;
      const freed = pins
        ? [...pins.late, ...pins.early, ...pins.missing].slice(0, 3)
        : ["no pins report"];
      add(
        "reconnect",
        "connection 2: a new stream_id, seq 1 full; connection 1 closed by the unloading page and its state freed (pins retired)",
        [...rc.problems, ...freed],
        `${rc.detail}; pins ok (${pins?.retirements ?? 0} retirements)`,
      );
      const hookLines = ev.host?.hook.lines ?? [];
      const reloadFrame =
        ev.host?.connections
          .find((c) => c.n === 2)
          ?.host.log?.find((l) => l.event === "open")?.frame ??
        Number.POSITIVE_INFINITY;
      const wr = evaluateWarmReload(
        hookLines as (HookLine & { method?: string })[],
        reloadFrame,
      );
      add(
        "reload-warm-cache",
        "0 repeated GETs after the reload; preflights per hash recorded or typed unavailable",
        wr.problems,
        wr.detail,
      );
      if (fin) g.checkpoints.push(fin);
      const bad = g.checkpoints.filter((c) => c.vs_frame !== 0);
      add(
        `${name === "reload" ? "reload" : "context"}-pixels`,
        "every post-reload shot equals the reference at its frame (Q7's band)",
        [
          ...(g.checkpoints.length === 0 ? ["no post-reload shot"] : []),
          ...bad
            .slice(0, 6)
            .map(
              (c) =>
                `seq ${c.seq} (frame ${c.frame}): ${c.vs_frame ?? "unreadable"} px differ in ${c.vs_frame_regions.join(",")}`,
            ),
        ],
        `${g.checkpoints.length} shots equal the reference`,
      );
      add(
        "credit-from-paced-loop",
        "Q9: every submitted ack (the reloaded page's) follows the paced loop",
        ev.applied
          ? pacedLoopProblems(leg, ev.applied)
          : ["applied.json missing"],
        "every ack from the paced loop",
      );
      const log1 = ev.host?.connections.find((c) => c.n === 1)?.host.log ?? [];
      const log2 = ev.host?.connections.find((c) => c.n === 2)?.host.log ?? [];
      const lastCredit1 = [...log1]
        .reverse()
        .find((l) => l.event === "ack" && l.credited)?.t_us;
      const firstCredit2 = log2.find(
        (l) => l.event === "ack" && l.credited,
      )?.t_us;
      Object.assign(summary.measures, {
        gap_host_ms:
          lastCredit1 !== undefined && firstCredit2 !== undefined
            ? (firstCredit2 - lastCredit1) / 1000
            : null,
        repeated_gets: wr.repeated.length,
        gets_after_reload: wr.gets_after,
        preflights: wr.preflights,
        band_snapped_px: [...snapped.values()].reduce((a, b) => a + b, 0),
      });
    } else if (def.action === "close") {
      // Host evidence only: the page is gone.
      const s1 = c1?.summary;
      const closeLine = c1?.host.log?.find((l) => l.event === "close");
      const stdout = await readTextOrUndefined(
        join(liveDir, leg, "host", "stdout.log"),
      );
      const q = quitFrames(stdout);
      const cs: string[] = [];
      if (!host) cs.push("no host evidence");
      if ((host?.connections.length ?? 0) !== 1)
        cs.push(
          `${host?.connections.length ?? 0} host connections, expected 1`,
        );
      if (s1?.closed_by !== "receiver")
        cs.push(
          `connection 1 closed by ${s1?.closed_by} (${s1?.close_code}), not the receiver's tab`,
        );
      if (!closeLine) cs.push("no close event in the host log");
      else if (closeLine.frame < liveAppliedFrame(def.step))
        cs.push(`closed at frame ${closeLine.frame}, before step ${def.step}`);
      if (host?.exit !== 0) cs.push(`host exit ${host?.exit}`);
      if (q.ready === null || q.ready !== q.quit)
        cs.push(
          `the fixture did not reach its quit frame (ready ${q.ready}, quitting ${q.quit})`,
        );
      for (const r of host ? [host.full, host.patch] : [])
        if (!r.present) cs.push(`${r.path} missing`);
        else if (r.errors.length > 0) cs.push(`${r.path}: ${r.errors[0]}`);
      add(
        "close-seen",
        "the host saw the tab's close, kept running to its quit frame, and exited 0 with both sinks complete",
        cs,
        `closed (${s1?.close_code} ${s1?.close_reason ?? ""}) at frame ${closeLine?.frame}; fixture quit at ${q.quit}`,
      );
      const g = {
        ev,
        leg: G6L_LC_LEG,
        checkpoints: [],
        stall: null,
        delivery: [],
        expected_missed: [],
        result_class: "success",
        reasons: [],
        pixel_verdict: "incomplete",
        unsupported_pairs: [],
      } as unknown as G6lEvaluation;
      const dg = digestLeg(e, g);
      const pins = dg?.resources?.pins;
      const closeFrame = closeLine?.frame ?? Number.POSITIVE_INFINITY;
      const retiredAfter = (host?.hook.lines ?? []).filter(
        (l) => l.op === "retire" && l.frame >= closeFrame,
      ).length;
      add(
        "close-pins-retired",
        "after the close the host retires the connection's pins: nothing servable but the mirror's payloads (G2c's pins replay)",
        pins
          ? [...pins.late, ...pins.early, ...pins.missing].slice(0, 4)
          : ["no pins report"],
        `${pins?.pins ?? 0} pins, ${pins?.retirements ?? 0} retirements (${retiredAfter} at or after the close frame ${closeLine?.frame}), none late`,
      );
      const samples = readLines<{ t_us?: number; frame?: number }>(
        join(liveDir, leg, "host", "evidence", "perf-timeline.jsonl"),
      );
      const tc = timelineCadence(samples, closeLine?.frame ?? 0);
      const hu = evaluateHostUnperturbed(
        tc.before,
        tc.after,
        "the connection's live log ends at the close and perf-timeline.jsonl samples once a second: only the rate is compared",
      );
      add(
        "host-unperturbed",
        "the host's frame rate after the close within 2 % of before it",
        hu.problems,
        hu.detail,
      );
      Object.assign(summary.measures, {
        close_frame: closeLine?.frame ?? null,
        close_code: s1?.close_code ?? null,
        host_cadence: tc,
      });
      summary.result_class = null;
    } else {
      // context-loss on gsw: recovered in place.
      const pr = shotPairs(ev, liveDir);
      const snapped = new Map<string, number>();
      const load = bandedLoader(pr.pairs, loadFrame, snapped);
      const g = await classifyG6lLeg(
        e,
        ev,
        { ...G6L_LC_LEG, stall: false },
        liveDir,
        load,
      );
      const fin = await judgeFinal(e, pr.final, liveDir, load);
      summary.result_class = g.result_class;
      add(
        "leg-class",
        "class success: recovered in place",
        g.result_class === "success"
          ? []
          : [`class ${g.result_class}: ${g.reasons.slice(0, 3).join("; ")}`],
        "success",
      );
      const cl = (
        ev.applied?.live as { context_loss?: GswContextLoss } | undefined
      )?.context_loss;
      const cr = evaluateGswContextLoss(cl);
      const pctx = page?.context;
      if (
        !pctx ||
        typeof pctx.lost_t !== "number" ||
        typeof pctx.restored_t !== "number"
      )
        cr.problems.push("the page recorded no webglcontextlost/restored pair");
      add(
        "context-restored",
        "restored in place: uploads after the restore equal the resident textures and meshes",
        cr.problems,
        cr.detail,
      );
      const crd = evaluateCreditResumes(c1?.host.log, cl?.restored_us);
      add(
        "credit-resumes",
        "credit resumes after the restore",
        crd.problems,
        crd.detail,
      );
      if (fin) g.checkpoints.push(fin);
      const bad = g.checkpoints.filter((c) => c.vs_frame !== 0);
      add(
        "context-pixels",
        "every shot equals the reference at its frame (Q7's band), those after the restore included",
        [
          ...(g.checkpoints.length === 0 ? ["no shot"] : []),
          ...bad
            .slice(0, 6)
            .map(
              (c) =>
                `seq ${c.seq} (frame ${c.frame}): ${c.vs_frame ?? "unreadable"} px differ in ${c.vs_frame_regions.join(",")}`,
            ),
        ],
        `${g.checkpoints.length} shots equal the reference`,
      );
      add(
        "credit-from-paced-loop",
        "Q9: every submitted ack follows the paced loop",
        ev.applied
          ? pacedLoopProblems(leg, ev.applied)
          : ["applied.json missing"],
        "every ack from the paced loop",
      );
      Object.assign(summary.measures, {
        gap_ms:
          cl &&
          typeof cl.redraw_us === "number" &&
          typeof cl.lost_us === "number"
            ? (cl.redraw_us - cl.lost_us) / 1000
            : null,
        page_lost_to_restored_ms:
          pctx &&
          typeof pctx.restored_t === "number" &&
          typeof pctx.lost_t === "number"
            ? pctx.restored_t - pctx.lost_t
            : null,
        refetched: cl?.refetched ?? null,
        credits_after_restore: crd.credits_after,
        band_snapped_px: [...snapped.values()].reduce((a, b) => a + b, 0),
      });
    }
    // Release the leg's decoded host evidence before the next leg.
    ev.host = null;

    for (const c of legChecks) summary.checks[c.id.split("@")[0]] = c.status;
    if (def.sabotage) {
      // The exact set is over checks that FAILED; an `unavailable` one (device: the compositor
      // comparison) answers nothing either way, so it is listed, never counted -- unless the
      // sabotage needs it to fail, which then leaves the sabotage unproven.
      const failing = new Map(
        legChecks
          .filter((c) => !c.passed && c.status !== "unavailable")
          .map((c): [string, string[]] => [c.id.split("@")[0], [c.detail]]),
      );
      const expected = G7U_SABOTAGE_FAILS[def.sabotage];
      const unprovable = legChecks
        .filter(
          (c) =>
            c.status === "unavailable" && expected.includes(c.id.split("@")[0]),
        )
        .map(
          (c) =>
            `${c.id.split("@")[0]} is unavailable: the sabotage cannot be shown to trip it`,
        );
      const each = legChecks
        .map(
          (c) =>
            `${c.id.split("@")[0]} ${c.status}${c.passed ? "" : ` (${c.detail.slice(0, 240)})`}`,
        )
        .join(", ");
      const p = [...unprovable, ...lcSabotageProblems(failing, expected)];
      checks.push(
        lc(
          at("sabotage", leg),
          `${leg}: must fail exactly ${expected.join(" and ")}`,
          p.length > 0 ? [...p, each] : [],
          each,
          evidence,
        ),
      );
    } else checks.push(...legChecks);
    legs.push(summary);
  }
  return {
    group: "g7-lc",
    kind,
    env,
    device,
    live: true,
    passed: checks.every((c) => c.passed || !c.gating),
    run_dir: runDir,
    checks,
    legs,
  };
}

/** Each real leg of `kind` typed unavailable: no device run exists. */
export function unavailableRealLegs(
  kind: G7uKind,
  reason: string,
): G7uRunResult {
  const checks = realLegs(kind).map((d) =>
    unavailable(
      `real-suspension@${kind}-device:${d.device}`,
      `${d.device}: Q10's ${d.suspend_kind} checks (took-effect, raf-stopped, pending-bounded, host-unperturbed, socket-kept, stall-latest, fetch-latest-only, resume-no-burst, stall-recovery, credit-from-paced-loop${kind === "gsw" ? ", compositor-equals-readback" : ""}) on a real ${d.suspend_kind} page; a simulated suspension never answers them`,
      reason,
      "real",
    ),
  );
  return {
    group: "g7-lc",
    kind,
    env: "device",
    device: null,
    live: true,
    passed: false,
    run_dir: null,
    checks,
    legs: [],
  };
}

/** The device runs of a kind: `<out>/gate6/lc-<kind>-<device>/`. */
export function deviceRuns(out: string, kind: G7uKind): string[] {
  const dir = join(out, "gate6");
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  // Directories only: run-gate7.sh writes each run's log beside it (`lc-<kind>-<id>.log`).
  return entries
    .filter((n) => n.startsWith(`lc-${kind}-`))
    .filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((n) => n.slice(`lc-${kind}-`.length))
    .sort();
}

/** g7-lc over every run present (desktop and device, per kind), and `<out>/g7u-summary.json`. */
export async function checkG7u(
  out: string,
  e: Gate6Expected,
  opts: { receiver?: string },
): Promise<G7uRunResult[]> {
  const results: G7uRunResult[] = [];
  for (const kind of G7U_KINDS) {
    if (opts.receiver && opts.receiver !== kind) continue;
    const desktop = join(out, "gate6", `lc-${kind}`);
    const devices = deviceRuns(out, kind);
    if (!existsSync(desktop) && devices.length === 0) {
      if (opts.receiver === kind)
        throw new Error(
          `check-gate7: --live g7-lc@${kind}: no ${desktop} and no lc-${kind}-<device>/`,
        );
      continue;
    }
    if (existsSync(desktop))
      results.push(
        await checkG7uRun({
          out,
          kind,
          env: "desktop",
          device: null,
          runDir: desktop,
          e,
        }),
      );
    for (const device of devices)
      results.push(
        await checkG7uRun({
          out,
          kind,
          env: "device",
          device,
          runDir: join(out, "gate6", `lc-${kind}-${device}`),
          e,
        }),
      );
    if (devices.length === 0)
      results.push(
        unavailableRealLegs(
          kind,
          `no device run (<out>/gate6/lc-${kind}-<device>/ absent): headless=new Chromium has no occlusion or freeze model (G7h Finding 1), so only the phone's real Chrome can hide or freeze the page`,
        ),
      );
  }
  if (results.length === 0)
    throw new Error(
      "check-gate7: --live g7-lc: no <out>/gate6/lc-<kind>[-<device>]/",
    );
  const section = (ev: G7uEvidence) =>
    results.flatMap((r) =>
      r.legs
        .filter((l) => l.evidence === ev)
        .map((l) => ({ kind: r.kind, env: r.env, device: r.device, ...l })),
    );
  await writeFile(
    join(out, "g7u-summary.json"),
    `${JSON.stringify(
      {
        schema: "render-stream-g7u-summary/1",
        real: section("real"),
        simulated: section("simulated-suspension"),
        unavailable: results.flatMap((r) =>
          r.checks
            .filter((c) => c.status === "unavailable")
            .map((c) => ({ id: c.id, reason: c.detail })),
        ),
        runs: results.map((r) => ({
          kind: r.kind,
          env: r.env,
          device: r.device,
          run_dir: r.run_dir ? basename(r.run_dir) : null,
          passed: r.passed,
        })),
      },
      null,
      2,
    )}\n`,
  ).catch(() => {});
  return results;
}

/** TEXA's versions after `from` and its free in (from, recovery] (pure; null when it is still
 * live at the recovery, which is G6l's case). */
export function texaFreedIn(
  lines: readonly Pick<HookLine, "op" | "id" | "hash" | "frame">[],
  texa0: string,
  from: number,
  recoveryFrame: number,
): { freed_frame: number; versions: string[] } | null {
  const id = texaId(lines, texa0);
  if (id === null) return null;
  const mine = lines.filter((l) => l.id === id);
  const freed = mine.find(
    (l) =>
      l.op === "free" &&
      // ids are per kind: a shader may share TEXA's numeric id (gate6-scene frees one at 540)
      ((l as { kind?: string }).kind ?? "image") === "image" &&
      l.frame > from &&
      l.frame <= recoveryFrame,
  );
  if (!freed) return null;
  const versions = mine
    .filter(
      (l) =>
        (l.op === "texture_2d_update" || l.op === "texture_2d_create") &&
        l.frame > from &&
        l.frame <= freed.frame &&
        typeof l.hash === "string",
    )
    .map((l) => l.hash as string);
  return { freed_frame: freed.frame, versions };
}

/** The HTTP fetches of any of `versions` (pure): each one is a problem. */
export function texaFetchedIn(
  fetches: readonly {
    stream?: number;
    seq?: number;
    hash?: string;
    source?: string;
  }[],
  versions: readonly string[],
): string[] {
  const set = new Set(versions);
  return fetches
    .filter(
      (f) => f.source === "http" && f.hash !== undefined && set.has(f.hash),
    )
    .map(
      (f) =>
        `seq ${f.seq} fetched in-suspension TEXA version ${f.hash?.slice(0, 12)}`,
    );
}
