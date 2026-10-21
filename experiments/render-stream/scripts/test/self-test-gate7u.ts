#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for G7u's checker (lib/gate7u-checks.ts): every pure evaluator driven with synthetic
// values (never a browser, a host or a Godot run), each with an honest case and the failures it
// must name:
//
//  1. the leg table: desktop/device names, the real legs, the sabotage exact sets, and every leg
//     name known to run-gate6.sh.
//  2. evaluateTookEffect: a simulated desktop window, a real hide and a real freeze pass; an untrue
//     real hide (no hidden event, rAF running), a harness claim the page contradicts, a device leg
//     that ran the shim and a short window fail. demoteUntrusted turns every suspension check of
//     an untrusted leg `unavailable` (failing, gating), and unavailableRealLegs types each real leg
//     `unavailable` when no device run exists: neither ever passes.
//  3. synthesiseStall: gsw maps the page window through the acks' receiver clock (honest: the
//     stalled seq's credit spans it, nothing else sent inside); the ack-while-hidden sabotage
//     shows credit flowing inside the window; web takes the largest credit gap.
//  4. evaluatePendingBounded, hostCadence/evaluateHostUnperturbed/timelineCadence,
//     evaluateSocketKept, evaluateResumeNoBurst, evaluateStallLatest, evaluateRafStopped.
//  5. compositorDiff (exact), snapInBand/bandedLoader (Q7's band only).
//  6. evaluateReloadReconnect, evaluateWarmReload (preflights measured or typed unavailable),
//     evaluateGswContextLoss, evaluateCreditResumes.
//  7. lcSabotageProblems: each sabotage passes only on its exact failing set; the ack-while-hidden
//     sabotage's evidence fails exactly pending-bounded and credit-from-paced-loop.
//  8. D14 as amended: transportLost, evaluateLossReconnect (a lost socket recovered by gate 1d's
//     reconnect passes; no reconnect, an early loss, a host close, a reused stream, a patch start,
//     a leaky dispose and a reload fail), evaluateLossPendingBounded, evaluateNewestFirst and
//     resume-no-burst on connection 2.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DeliveryReport, LiveLogLine } from "../lib/gate1-live-checks";
import type { Frame6 } from "../lib/gate6a-checks";
import { pacedLoopProblems } from "../lib/gate7-live";
import {
  bandedLoader,
  compositorDiff,
  demoteUntrusted,
  deviceHelloProblems,
  evaluateCreditResumes,
  evaluateGswContextLoss,
  evaluateHostUnperturbed,
  evaluateLossPendingBounded,
  evaluateLossReconnect,
  evaluateNewestFirst,
  evaluatePendingBounded,
  evaluateRafStopped,
  evaluateReloadReconnect,
  evaluateResumeNoBurst,
  evaluateSocketKept,
  evaluateStallLatest,
  evaluateTookEffect,
  evaluateWarmReload,
  fetchWindowStart,
  G7U_LEGS,
  G7U_SABOTAGE_FAILS,
  hostCadence,
  hostFrameRange,
  type LcPage,
  type Lifecycle,
  lc,
  lcSabotageProblems,
  legDef,
  legsFor,
  type ResumeFold,
  rafInside,
  realLegs,
  resumeFoldAhead,
  snapInBand,
  synthesiseStall,
  texaFetchedIn,
  texaFreedIn,
  timelineCadence,
  transportLost,
  unavailableRealLegs,
} from "../lib/gate7u-checks";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let count = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  count++;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `: ${detail}`}`,
  );
}
const some = (p: readonly string[], re: RegExp) => p.some((x) => re.test(x));

// 1. The leg table.
expect(
  "desktop gsw legs",
  JSON.stringify(legsFor("gsw", "desktop")) ===
    JSON.stringify([
      "sim-hidden-2s",
      "sim-hidden-30s",
      "sim-frozen-30s",
      "reload",
      "close",
      "context-loss",
      "sabotage-ack-while-hidden",
      "sabotage-css-opacity",
    ]),
  legsFor("gsw", "desktop").join(","),
);
expect(
  "device web legs (no sabotage, no sim-)",
  JSON.stringify(legsFor("web", "device")) ===
    JSON.stringify([
      "hidden-2s",
      "hidden-30s",
      "frozen-30s",
      "reload",
      "close",
      "context-loss",
    ]),
);
expect(
  "real legs: gsw hidden/frozen + the device sabotage",
  realLegs("gsw")
    .map((d) => d.device)
    .join(",") === "hidden-2s,hidden-30s,frozen-30s,sabotage-ack-while-hidden",
);
expect(
  "every desktop suspension leg is sim-* or a sabotage",
  G7U_LEGS.filter((d) => d.action === "suspend").every(
    (d) => d.desktop === null || d.desktop.startsWith("sim-") || d.sabotage,
  ),
);
expect(
  "sabotage sets",
  JSON.stringify(G7U_SABOTAGE_FAILS["ack-while-hidden"]) ===
    JSON.stringify(["credit-from-paced-loop", "pending-bounded"]) &&
    JSON.stringify(G7U_SABOTAGE_FAILS["css-opacity"]) ===
      JSON.stringify(["compositor-equals-readback"]),
);
expect(
  "legDef by environment",
  legDef("device", "hidden-30s")?.ms === 30000 &&
    legDef("desktop", "hidden-30s") === undefined &&
    legDef("desktop", "sim-frozen-30s")?.suspend_kind === "frozen",
);
let runner = "";
try {
  runner = readFileSync(join(SCRIPTS, "run-gate6.sh"), "utf8");
} catch {
  runner = "";
}
const unknown = G7U_LEGS.flatMap((d) => [d.desktop, d.device]).filter(
  (l): l is string => l !== null && !runner.includes(l),
);
expect(
  "run-gate6.sh names every lc leg",
  runner.includes("G7U_LEGS") && unknown.length === 0,
  `missing ${unknown.join(",")}`,
);

// 2. took-effect.
const simPage: LcPage = {
  trigger: { step: 2, seq: 290, frame: 427, t: 7000 },
  window: { requested_t: 7000, start_t: 7000, end_t: 9005 },
  raf: { total: 900, during: 0, held: 1, first_after_t: 9010 },
  timers_during: 40,
  visibility: [],
  lifecycle_events: [],
};
const simLc: Lifecycle = {
  schema: "render-stream-lifecycle/1",
  simulated: true,
  mechanism: "simulated-suspension",
  pages: [simPage],
  took_effect: true,
};
const hiddenDef = {
  action: "suspend" as const,
  suspend_kind: "hidden" as const,
  ms: 2000,
};
const frozenDef = {
  action: "suspend" as const,
  suspend_kind: "frozen" as const,
  ms: 30000,
};
let t = evaluateTookEffect(simLc, hiddenDef, "desktop");
expect(
  "simulated desktop window: trusted, labelled simulated-suspension",
  t.problems.length === 0 && t.evidence === "simulated-suspension",
  t.problems.join("; "),
);
t = evaluateTookEffect(
  { ...simLc, pages: [{ ...simPage, window: { start_t: 7000, end_t: 8000 } }] },
  hiddenDef,
  "desktop",
);
expect("a short simulated window fails", some(t.problems, /under 0.9/));
t = evaluateTookEffect(simLc, hiddenDef, "device");
expect(
  "a device leg that ran the shim is never real",
  t.evidence === "simulated-suspension" &&
    some(t.problems, /cannot answer a real requirement/),
);
const realPage: LcPage = {
  ...simPage,
  window: { requested_t: 6900, start_t: 7000, end_t: 9100 },
  raf: { total: 900, during: 0, held: 0, first_after_t: 9120 },
  visibility: [
    { t: 7000, state: "hidden" },
    { t: 9100, state: "visible" },
  ],
};
const realLc: Lifecycle = {
  schema: "render-stream-lifecycle/1",
  simulated: false,
  mechanism: "real-hidden:new-foreground-tab",
  pages: [realPage],
  took_effect: true,
};
t = evaluateTookEffect(realLc, hiddenDef, "device");
expect(
  "a real hide: trusted, evidence real",
  t.problems.length === 0 && t.evidence === "real",
  t.problems.join("; "),
);
const untrue: Lifecycle = {
  ...realLc,
  pages: [
    {
      ...realPage,
      visibility: [],
      raf: { total: 900, during: 120, held: 0, first_after_t: 9120 },
    },
  ],
};
t = evaluateTookEffect(untrue, hiddenDef, "device");
expect(
  "an untrue real hide (no hidden event, rAF ran) fails",
  some(t.problems, /did not take effect/) && some(t.problems, /120 rAF/),
  t.problems.join("; "),
);
t = evaluateTookEffect({ ...untrue, took_effect: false }, hiddenDef, "device");
expect(
  "a harness 'not taken' is a problem too",
  some(t.problems, /harness says it did not take effect/),
);
t = evaluateTookEffect(
  {
    ...realLc,
    mechanism: "real-frozen:Page.setWebLifecycleState",
    pages: [
      {
        ...realPage,
        window: { start_t: 7000, end_t: 37100 },
        visibility: [],
        lifecycle_events: [
          { t: 7001, type: "freeze" },
          { t: 37100, type: "resume" },
        ],
      },
    ],
  },
  frozenDef,
  "device",
);
expect(
  "a real freeze by its events",
  t.problems.length === 0,
  t.problems.join("; "),
);
t = evaluateTookEffect(
  {
    ...realLc,
    mechanism: "real-frozen:Page.setWebLifecycleState",
    pages: [
      {
        ...realPage,
        window: { start_t: 7000, end_t: 37100 },
        timers_during: 0,
        lifecycle_events: [],
      },
    ],
  },
  frozenDef,
  "device",
);
expect(
  "a real freeze by stopped rAF and timers",
  t.problems.length === 0,
  t.problems.join("; "),
);
t = evaluateTookEffect(
  {
    ...realLc,
    mechanism: "real-frozen:Page.setWebLifecycleState",
    pages: [
      {
        ...realPage,
        window: { start_t: 7000, end_t: 37100 },
        timers_during: 12,
        lifecycle_events: [],
      },
    ],
  },
  frozenDef,
  "device",
);
expect(
  "a freeze with timers ticking and no events fails",
  some(t.problems, /freeze did not take effect/),
);
t = evaluateTookEffect(undefined, hiddenDef, "device");
expect("no lifecycle.json fails", some(t.problems, /no lifecycle.json/));

// Part D: a new-foreground-tab hide runs a few rAF callbacks right after `hidden` (g31 probe):
// within REAL_EDGE_MS of the window's start they are reported, never counted; one later is.
{
  const edgePage: LcPage = {
    ...realPage,
    raf: {
      total: 900,
      during: 3,
      held: 0,
      first_after_t: 9120,
      during_t: [7004, 7020, 7040],
    },
  };
  const e = evaluateTookEffect(
    { ...realLc, pages: [edgePage] },
    hiddenDef,
    "device",
  );
  const r = evaluateRafStopped(edgePage);
  expect(
    "a real tab hide's start-edge rAFs: reported, not counted (took-effect, raf-stopped pass)",
    e.problems.length === 0 &&
      r.problems.length === 0 &&
      /3 at the window's start edge/.test(r.detail) &&
      rafInside(edgePage).edge === 3,
    `${e.problems.join("; ")} | ${r.problems.join("; ")} | ${r.detail}`,
  );
  const lateRaf: LcPage = {
    ...edgePage,
    raf: { ...edgePage.raf, during: 4, during_t: [7004, 7020, 7040, 8000] },
  };
  const e2 = evaluateTookEffect(
    { ...realLc, pages: [lateRaf] },
    hiddenDef,
    "device",
  );
  expect(
    "a rAF strictly inside a real hide fails took-effect and raf-stopped",
    some(e2.problems, /1 rAF callbacks ran while hidden/) &&
      some(evaluateRafStopped(lateRaf).problems, /^1 rAF callbacks ran/),
    `${e2.problems.join("; ")}`,
  );
  expect(
    "a desktop record (no during_t) counts every callback in the window",
    rafInside({ ...simPage, raf: { during: 2 } }).inside === 2,
  );
}

// Part D: the device hello's presentation integers are the phone's.
{
  const pageCfg = { url: "http://127.0.0.1:1/x", env: {}, canvas: [640, 360] };
  const base = {
    connection: 1,
    version: 7,
    receiver_kind: "gsw-canvas",
    credit_window: 1,
    credit_window_requested: 1,
    manifest_sha256: null,
    origin: "http://127.0.0.1:1",
    presentation_backing_w: 640,
    presentation_backing_h: 360,
    presentation_css_w: 640,
    presentation_css_h: 360,
    dpr_milli: 2625,
  };
  const prov = {
    kind: "device-provenance",
    ok: true,
    facts: { page: { devicePixelRatio: 2.625 } },
  };
  expect(
    "device hello (gsw): DPR 2625, backing == CSS == canvas passes",
    deviceHelloProblems(base, pageCfg as never, "gsw-canvas", "gsw", prov)
      .length === 0,
    deviceHelloProblems(base, pageCfg as never, "gsw-canvas", "gsw", prov).join(
      "; ",
    ),
  );
  expect(
    "device hello (gsw): the desktop's DPR 1000 fails",
    some(
      deviceHelloProblems(
        { ...base, dpr_milli: 1000 },
        pageCfg as never,
        "gsw-canvas",
        "gsw",
        prov,
      ),
      /dpr_milli=1000/,
    ),
  );
  const webHello = {
    ...base,
    receiver_kind: "web-export",
    presentation_css_w: 243,
    presentation_css_h: 137,
  };
  expect(
    "device hello (web): Godot's CSS = backing x 1000 / dpr_milli (243x137) passes; the canvas CSS fails web, and 243x137 fails gsw",
    deviceHelloProblems(webHello, pageCfg as never, "web-export", "web", prov)
      .length === 0 &&
      some(
        deviceHelloProblems(
          { ...base, receiver_kind: "web-export" },
          pageCfg as never,
          "web-export",
          "web",
          prov,
        ),
        /presentation_css_w=640/,
      ) &&
      some(
        deviceHelloProblems(
          { ...webHello, receiver_kind: "gsw-canvas" },
          pageCfg as never,
          "gsw-canvas",
          "gsw",
          prov,
        ),
        /presentation_css_w=243/,
      ),
  );
  expect(
    "device hello: no provenance DPR is a problem",
    some(
      deviceHelloProblems(
        base,
        pageCfg as never,
        "gsw-canvas",
        "gsw",
        undefined,
      ),
      /devicePixelRatio/,
    ),
  );
}

const legChecks = [
  lc("took-effect@gsw-g31:hidden-2s", "x", ["no hidden"], "", "real"),
  lc("console-clean@gsw-g31:hidden-2s", "x", [], "clean", "real"),
  lc("raf-stopped@gsw-g31:hidden-2s", "x", [], "0", "real"),
  lc("stall-latest@gsw-g31:hidden-2s", "x", [], "ok", "real"),
];
const demoted = demoteUntrusted(legChecks, ["no hidden visibilitychange"]);
expect(
  "an untrusted real leg: its suspension checks are unavailable, never pass",
  demoted.filter((c) => c.status === "unavailable").length === 2 &&
    demoted.every((c) =>
      c.id.startsWith("console-clean") ? c.passed : !c.passed,
    ) &&
    demoted.every((c) => c.status !== "unavailable" || c.gating),
);
expect(
  "a trusted leg is left as it is",
  demoteUntrusted(legChecks, []).every((c, i) => c === legChecks[i]),
);
const un = unavailableRealLegs("web", "no device run");
expect(
  "no device run: every real web leg unavailable, failing, gating; the result fails",
  un.checks.length === 3 &&
    un.checks.every(
      (c) =>
        c.status === "unavailable" &&
        !c.passed &&
        c.gating &&
        c.evidence === "real" &&
        c.detail.includes("no device run"),
    ) &&
    !un.passed,
);

// 3. synthesiseStall.
/** A host log: frames from 10 at 60 fps (t0 + 16667 us/frame), a send each `period` frames
 * credited `rtt` frames later, except that sends inside the suspension wait for its end. */
function hostLog(opts: {
  frames: number;
  suspend?: [number, number];
  ackWhileHidden?: boolean;
  offsetUs?: number;
}): LiveLogLine[] {
  const out: LiveLogLine[] = [];
  const t0 = 1_000_000_000;
  const off = opts.offsetUs ?? t0 - 0; // host - receiver clock
  const tf = (f: number) => t0 + Math.round(f * 16_667);
  let seq = 0;
  let inflight: { seq: number; creditAt: number } | null = null;
  for (let f = 10; f < opts.frames; f++) {
    if (inflight && f >= inflight.creditAt) {
      const ct = tf(f) - 100;
      out.push({
        frame: f,
        t_us: ct,
        event: "ack",
        seq: inflight.seq,
        stage: "submitted",
        credited: true,
        receiver_t_us: ct - off - 500,
      } as LiveLogLine);
      inflight = null;
    }
    const line: LiveLogLine = {
      frame: f,
      t_us: tf(f),
      state: "streaming",
      credit: inflight === null,
      pending: inflight !== null,
      coalesced: 0,
      queued_bytes: 0,
      sent: null,
    };
    if (!inflight) {
      seq++;
      line.sent = { seq, encoding: seq === 1 ? "full" : "patch", bytes: 1000 };
      let creditAt = f + 2;
      const s = opts.suspend;
      if (s && !opts.ackWhileHidden) {
        const tsHost = s[0] * 1000 + off;
        const teHost = s[1] * 1000 + off;
        // the stalled seq: sent inside the window (receiver held), credited one frame after its end
        if (tf(f) >= tsHost - 20_000 && tf(creditAt) > tsHost && tf(f) < teHost)
          creditAt = Math.ceil((teHost - t0) / 16_667) + 1;
      }
      inflight = { seq, creditAt };
    }
    out.push(line);
  }
  return out;
}
const OFF = 1_000_000_000 - 2_000_000; // receiver clock starts 2 s after the host's t0
const sus: [number, number] = [5000, 7000]; // page ms
const page = {
  ...simPage,
  trigger: { step: 2, seq: 20 },
  window: { start_t: sus[0], end_t: sus[1] },
};
const honestLog = hostLog({ frames: 600, suspend: sus, offsetUs: OFF });
const sg = synthesiseStall(
  "gsw",
  honestLog,
  page,
  { step: 2, ms: 2000 },
  "simulated-suspension",
);
expect(
  "gsw stall: receiver-clock mapping, a stalled seq, nothing else sent inside",
  sg.problems.length === 0 &&
    sg.method === "receiver-clock" &&
    sg.stall !== null &&
    sg.sends_in_window.length === 0 &&
    (sg.credit_gap_us ?? 0) > 1_800_000 &&
    Math.abs((sg.offset_us ?? 0) - (OFF + 500)) < 1000,
  JSON.stringify({ ...sg, stall: sg.stall?.after_seq }),
);
expect(
  "gsw stall carries G1d's live.stall shape",
  sg.stall?.step === 2 &&
    sg.stall.ms === 2000 &&
    sg.stall.start_us === 5_000_000 &&
    sg.stall.end_us === 7_000_000 &&
    sg.stall.injected === true,
);
const sabLog = hostLog({
  frames: 600,
  suspend: sus,
  ackWhileHidden: true,
  offsetUs: OFF,
});
const ss = synthesiseStall(
  "gsw",
  sabLog,
  page,
  { step: 2, ms: 2000 },
  "simulated-suspension",
);
expect(
  "ack-while-hidden: credit flowed inside the window",
  ss.sends_in_window.length > 30,
  `${ss.sends_in_window.length} in window`,
);
const sw = synthesiseStall(
  "web",
  honestLog,
  page,
  { step: 2, ms: 2000 },
  "simulated-suspension",
);
expect(
  "web stall: the largest credit gap, the same seq as the receiver-clock mapping",
  sw.method === "host-credit-gap" &&
    sw.stall?.after_seq === sg.stall?.after_seq &&
    sw.problems.length === 0,
  JSON.stringify(sw.problems),
);
const sw2 = synthesiseStall(
  "web",
  sabLog,
  page,
  { step: 2, ms: 2000 },
  "simulated-suspension",
);
expect(
  "web: no credit gap spans the suspension -> named",
  some(sw2.problems, /under half/),
);
expect(
  "no window -> named",
  some(
    synthesiseStall(
      "gsw",
      honestLog,
      { ...simPage, window: null },
      { step: 2, ms: 2000 },
      "x",
    ).problems,
    /no suspension window/,
  ),
);

// 4. pending-bounded and friends.
const dHonest: DeliveryReport = {
  credit_stage: "submitted",
  window: 1,
  frame_lines: 590,
  sends: 100,
  dropped: 0,
  max_in_flight: 1,
  in_flight_violations: [],
  sent_without_credit: [],
  max_queued_bytes: 2000,
  queued_limit: 100_000,
  queued_violations: [],
  stale_states: [],
  compared_states: 100,
  send_gaps: [],
};
const stHonest = {
  send_frame: 307,
  credit_frame: 430,
  sends_during: 0,
  max_pending: 1,
  max_queued_bytes_during: 1000,
  coalesced_delta: 120,
} as unknown as Parameters<typeof evaluatePendingBounded>[2];
let pb = evaluatePendingBounded(
  dHonest,
  { max_in_flight: 1, max_pending: 1 },
  stHonest,
  sg,
);
expect(
  "pending-bounded: honest",
  pb.problems.length === 0,
  pb.problems.join("; "),
);
pb = evaluatePendingBounded(
  dHonest,
  { max_in_flight: 1, max_pending: 1 },
  stHonest,
  ss,
);
expect(
  "pending-bounded: ack-while-hidden fails on credit inside the window",
  some(pb.problems, /inside the suspension/),
);
pb = evaluatePendingBounded(
  { ...dHonest, max_in_flight: 2 },
  { max_in_flight: 2, max_pending: 2 },
  {
    ...stHonest,
    sends_during: 3,
    max_queued_bytes_during: 200_000,
  } as typeof stHonest,
  sg,
);
expect(
  "pending-bounded: in flight 2, pending 2, sends during and queued over the window all named",
  some(pb.problems, /max in flight 2/) &&
    some(pb.problems, /max pending 2/) &&
    some(pb.problems, /3 transactions sent between/) &&
    some(pb.problems, /queued 200000/),
  pb.problems.join("; "),
);
pb = evaluatePendingBounded(dHonest, undefined, null, sg);
expect(
  "pending-bounded: an invisible stall fails",
  some(pb.problems, /not visible/),
);
// G7q, credit window 2: the stalled seq (40)'s free slot lets seq 41 out inside the suspension;
// seq 42 would have needed a credit from the suspended page.
const dW2 = { ...dHonest, window: 2, max_in_flight: 2 };
const stW2 = {
  ...stHonest,
  stalled_seq: 40,
  sends_during: 1,
} as typeof stHonest;
pb = evaluatePendingBounded(dW2, { max_in_flight: 2, max_pending: 1 }, stW2, {
  sends_in_window: [41],
  problems: [],
});
expect(
  "pending-bounded (window 2): the stalled seq's one in-window send passes",
  pb.problems.length === 0,
  pb.problems.join("; "),
);
pb = evaluatePendingBounded(
  dW2,
  { max_in_flight: 2, max_pending: 1 },
  { ...stW2, sends_during: 2 } as typeof stHonest,
  { sends_in_window: [41, 42], problems: [] },
);
expect(
  "pending-bounded (window 2): a send before the stalled seq inside the suspension still fails",
  some(
    evaluatePendingBounded(dW2, { max_in_flight: 2, max_pending: 1 }, stW2, {
      sends_in_window: [39, 41],
      problems: [],
    }).problems,
    /seqs 39\)/,
  ),
);
expect(
  "pending-bounded (window 2): a second send inside the suspension fails",
  some(pb.problems, /2 transactions sent between/) &&
    some(pb.problems, /seqs 42/),
  pb.problems.join("; "),
);

const steady = hostLog({ frames: 600 });
const before = hostCadence(steady, 40, 300);
const during = hostCadence(steady, 301, 500);
let hu = evaluateHostUnperturbed(before, during);
expect(
  "host-unperturbed: steady 60 fps passes",
  hu.problems.length === 0 && Math.abs((before.rate_hz ?? 0) - 60) < 0.1,
  hu.detail,
);
const slow = steady.map((l) =>
  l.frame > 300 ? { ...l, t_us: l.t_us + (l.frame - 300) * 2000 } : l,
);
hu = evaluateHostUnperturbed(
  hostCadence(slow, 40, 300),
  hostCadence(slow, 301, 500),
);
expect(
  "host-unperturbed: a 12 % slower host fails rate and p95",
  some(hu.problems, /host frame rate/) && some(hu.problems, /p95/),
  hu.problems.join("; "),
);
hu = evaluateHostUnperturbed(hostCadence(steady, 40, 300), {
  frames: 0,
  rate_hz: null,
  p95_us: null,
});
expect("host-unperturbed: no measurement is a failure", hu.problems.length > 0);
const tl = timelineCadence(
  Array.from({ length: 18 }, (_, i) => ({
    t_us: 1e9 + i * 1e6,
    frame: 1 + i * 60,
  })),
  600,
);
hu = evaluateHostUnperturbed(tl.before, tl.after, "rate only");
expect(
  "timelineCadence: close leg rate-only passes at 60/s",
  hu.problems.length === 0 && Math.abs((tl.after.rate_hz ?? 0) - 60) < 0.01,
  hu.detail,
);
const tlSlow = timelineCadence(
  Array.from({ length: 18 }, (_, i) => ({
    t_us: 1e9 + i * 1e6,
    frame: i < 10 ? 1 + i * 60 : 541 + (i - 9) * 50,
  })),
  600,
);
expect(
  "timelineCadence: a host that slowed after the close fails",
  evaluateHostUnperturbed(tlSlow.before, tlSlow.after, "rate only").problems
    .length === 1,
);

let sk = evaluateSocketKept(
  [{ n: 1, stream_id: "aa" }],
  [{ stream_id: "aa" }],
  1,
  null,
);
expect("socket-kept: honest", sk.problems.length === 0, sk.problems.join("; "));
sk = evaluateSocketKept(
  [
    { n: 1, stream_id: "aa" },
    { n: 2, stream_id: "bb" },
  ],
  [{ stream_id: "aa" }, { stream_id: "bb" }],
  2,
  { step: 2 },
);
expect(
  "socket-kept: a reconnect fails",
  sk.problems.length === 4,
  sk.problems.join("; "),
);
sk = evaluateSocketKept(
  [{ n: 1, stream_id: "aa" }],
  [{ stream_id: "aa" }],
  1,
  null,
  {
    reason: "live-disconnected",
    detail: 'the connection closed (code 1006 "") without an end record',
  },
);
expect(
  "socket-kept: a lost socket (the g31's real freeze, 1006) fails on one connection",
  sk.problems.length === 1 && /socket was lost/.test(sk.problems[0]),
  sk.problems.join("; "),
);

const rtx = (
  seq: number,
  key: number,
  applied = true,
  skipped: string | null = null,
) => ({ stream: 1, seq, applied, skipped, frame_key: key });
let rn = evaluateResumeNoBurst(
  [rtx(9, 1), rtx(10, 50), rtx(11, 52), rtx(12, 53)],
  10,
  [9, 10, 11, 12],
);
expect(
  "resume-no-burst: one apply in the first resumed frame",
  rn.problems.length === 0 && rn.first_frame_applies === 1,
  rn.problems.join("; "),
);
rn = evaluateResumeNoBurst(
  [rtx(10, 50), rtx(11, 50), rtx(12, 50)],
  10,
  [10, 11, 12],
);
expect(
  "resume-no-burst: three in one frame fails",
  some(rn.problems, /3 transactions applied/),
);
rn = evaluateResumeNoBurst(
  [rtx(10, 50), rtx(11, 0, false), rtx(12, 51)],
  10,
  [10, 11, 12, 13],
);
expect(
  "resume-no-burst: a silent skip and a lost seq fail",
  some(rn.problems, /seq 11 was neither/) &&
    some(rn.problems, /not in applied.json \(13\)/),
  rn.problems.join("; "),
);
rn = evaluateResumeNoBurst(
  [rtx(10, 50), rtx(11, 0, false, "stale"), rtx(12, 51)],
  10,
  [10, 11, 12],
);
expect(
  "resume-no-burst: a typed skip is fine",
  rn.problems.length === 0,
  rn.problems.join("; "),
);

const rec = {
  seq: 12,
  frame: 440,
  encoding: "patch",
  base_seq: 11,
  bytes: 100,
  stale_from: null,
  frames_after_credit: 0,
  state_equals_full: true,
  credit_to_send_us: 100,
  credit_to_applied_ack_us: 30_000,
  credit_to_submitted_ack_us: 31_000,
};
const stl = { stalled_seq: 11, recovery: rec };
const cps = [
  { stream: 1, seq: 12, frame: 440, vs_frame: 0, vs_frame_regions: [] },
];
let sl = evaluateStallLatest(
  stl,
  [
    { stream: 1, seq: 11 },
    { stream: 1, seq: 12 },
  ],
  cps,
);
expect(
  "stall-latest: honest",
  sl.problems.length === 0,
  sl.problems.join("; "),
);
// G7q, credit window 2: seq 12 went out in the stalled seq 11's free slot, the recovery is 13,
// folded into 14 (one apply, 14 shot).
{
  const st2 = {
    stalled_seq: 11,
    sends_during: 1,
    recovery: { ...rec, seq: 13, base_seq: 12 },
  };
  const tx2 = [
    { stream: 1, seq: 11 },
    { stream: 1, seq: 12 },
    { stream: 1, seq: 13, coalesced_into: 14 },
    { stream: 1, seq: 14 },
  ];
  const cp14 = [{ ...cps[0], seq: 14, frame: 441 }];
  const w2 = evaluateStallLatest(st2, tx2, cp14, 1080, 2);
  expect(
    "stall-latest (window 2): the recovery after the in-window send, folded and shot as 14",
    w2.problems.length === 0,
    w2.problems.join("; "),
  );
  expect(
    "stall-latest (window 1 rule on window-2 evidence): seq 12 is not the recovery",
    some(evaluateStallLatest(st2, tx2, cp14, 1080, 1).problems, /is seq 12/),
  );
  // An honest window-2 resume folds the stalled seq into its one in-window send: no fold ahead.
  const facts = (seq: number) => ({
    frame: 430 + seq,
    stale_from: null,
    state_equals_full: true,
  });
  const honest = [
    { stream: 1, seq: 11, coalesced_into: 12 },
    { stream: 1, seq: 12 },
    ...tx2.slice(2),
  ];
  expect(
    "resumeFoldAhead: honest window-2 resume (11 into 12) is no fold ahead",
    resumeFoldAhead(11, 2, honest, 13, facts) === null,
  );
  expect(
    "resumeFoldAhead: window 1 never folds ahead",
    resumeFoldAhead(11, 1, honest, 13, facts) === null,
  );
}
// G7q, credit window 2, ack-while-hidden: credit kept flowing, so the page held 11..20 at resume
// and folded them into 20 (shot), before the recovery 21 (applied alone, unshot).
{
  const facts = (seq: number) => ({
    frame: 430 + seq,
    stale_from: null,
    state_equals_full: true,
  });
  const txs = [
    ...Array.from({ length: 9 }, (_, i) => ({
      stream: 1,
      seq: 11 + i,
      coalesced_into: 20,
    })),
    { stream: 1, seq: 20 },
    { stream: 1, seq: 21 },
  ];
  const st = {
    stalled_seq: 11,
    sends_during: 9,
    recovery: { ...rec, seq: 21, frame: 455, base_seq: 20 },
  };
  const cp20 = [{ ...cps[0], seq: 20, frame: 450 }];
  const fold = resumeFoldAhead(11, 2, txs, 21, facts);
  expect(
    "resumeFoldAhead: a held queue folded past the in-window send is the resume apply",
    fold?.seq === 20 && fold.frame === 450 && fold.past_window === 8,
    JSON.stringify(fold),
  );
  expect(
    "resumeFoldAhead: a fold target at or past the recovery is none",
    resumeFoldAhead(11, 2, txs, 20, facts) === null,
  );
  const w = evaluateStallLatest(st, txs, cp20, 1080, 2, fold);
  expect(
    "stall-latest (window 2, fold ahead): judged by the resume apply's shot",
    w.problems.length === 0 && /resume apply/.test(w.detail),
    w.problems.join("; "),
  );
  expect(
    "stall-latest (window 2, no fold given): the unshot recovery fails as before",
    some(evaluateStallLatest(st, txs, cp20, 1080, 2).problems, /was not shot/),
  );
  expect(
    "stall-latest (window 2, fold ahead): the resume apply unshot fails",
    some(
      evaluateStallLatest(st, txs, [], 1080, 2, fold).problems,
      /resume apply's seq 20 was not shot/,
    ),
  );
  const bad = evaluateStallLatest(
    st,
    txs,
    [{ ...cp20[0], vs_frame: 7, vs_frame_regions: ["MS"] }],
    1080,
    2,
    { ...(fold as ResumeFold), stale_from: 3, state_equals_full: false },
  );
  expect(
    "stall-latest (window 2, fold ahead): a stale, unequal, mismatching resume apply fails thrice",
    bad.problems.length === 3,
    bad.problems.join("; "),
  );
  expect(
    "stall-latest (window 2, fold ahead): the recovery's own state checks stand",
    some(
      evaluateStallLatest(
        { ...st, recovery: { ...st.recovery, state_equals_full: false } },
        txs,
        cp20,
        1080,
        2,
        fold,
      ).problems,
      /recovery seq 21 .* is not the host's state/,
    ),
  );
}
sl = evaluateStallLatest(
  stl,
  [
    { stream: 1, seq: 11 },
    { stream: 1, seq: 12 },
  ],
  [],
);
expect(
  "stall-latest: an unshot recovery inside the windows fails",
  some(sl.problems, /was not shot/),
);
sl = evaluateStallLatest(
  { ...stl, recovery: { ...rec, frame: 2240 } },
  [
    { stream: 1, seq: 11 },
    { stream: 1, seq: 12 },
  ],
  [],
);
expect(
  "stall-latest: a recovery after the last window is judged by state alone",
  sl.problems.length === 0 && /after the last shot window/.test(sl.detail),
);
sl = evaluateStallLatest(
  { ...stl, recovery: { ...rec, stale_from: 300, state_equals_full: false } },
  [
    { stream: 1, seq: 11 },
    { stream: 1, seq: 13 },
  ],
  [{ ...cps[0], vs_frame: 9, vs_frame_regions: ["MS"] }],
);
expect(
  "stall-latest: stale, unequal, not first and mismatching all fail",
  sl.problems.length === 4,
  sl.problems.join("; "),
);

expect(
  "raf-stopped: 0 passes",
  evaluateRafStopped(simPage).problems.length === 0,
);
expect(
  "raf-stopped: 3 fails",
  some(
    evaluateRafStopped({ ...simPage, raf: { during: 3 } }).problems,
    /3 rAF/,
  ),
);
expect(
  "raf-stopped: no record fails",
  evaluateRafStopped(undefined).problems.length === 1,
);

// 5. compositor and band.
const img = (w: number, h: number, fill: number[]) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width: w, height: h, data };
};
const a = img(4, 4, [10, 20, 30, 255]);
expect(
  "compositor: identical passes",
  compositorDiff(a, img(4, 4, [10, 20, 30, 255])).problems.length === 0,
);
const op = img(4, 4, [10, 20, 30, 255]);
op.data[0] = 9; // css opacity 0.99 over black: a level off
expect(
  "compositor: one level off fails (exact)",
  some(compositorDiff(a, op).problems, /1 px differ/),
);
expect(
  "compositor: not opaque fails",
  some(compositorDiff(img(4, 4, [1, 2, 3, 250]), a).problems, /not opaque/),
);
expect(
  "compositor: size mismatch fails",
  some(compositorDiff(a, img(2, 2, [0, 0, 0, 255])).problems, /2x2/),
);
expect(
  "compositor: a missing screenshot fails",
  compositorDiff(a, null).problems.length === 1,
);
const ref = new Uint8Array([10, 10, 10, 255, 10, 10, 10, 255, 10, 10, 10, 255]);
const got = new Uint8Array([11, 9, 10, 255, 12, 10, 10, 255, 11, 10, 10, 254]);
const snap = snapInBand(got, ref);
expect(
  "band: delta1 snapped, delta2 and alpha kept",
  snap.snapped === 1 &&
    snap.rgba[0] === 10 &&
    snap.rgba[4] === 12 &&
    snap.rgba[8] === 11,
);
{
  const frames = new Map<string, Frame6>([
    ["shot", { width: 3, height: 1, rgba: got }],
    ["ref", { width: 3, height: 1, rgba: ref }],
  ]);
  const snapped = new Map<string, number>();
  const load = bandedLoader(
    new Map([["shot", "ref"]]),
    async (p) => frames.get(p) ?? null,
    snapped,
  );
  const shown = await load("shot");
  const plain = await load("ref");
  expect(
    "bandedLoader: the shot is shown banded against its own frame",
    shown?.rgba[0] === 10 &&
      shown.rgba[4] === 12 &&
      snapped.get("shot") === 1 &&
      plain?.rgba === ref,
  );
}

// 6. reload, warm cache, context loss.
const conns = [
  {
    n: 1,
    summary: { stream_id: "aaaa", closed_by: "receiver", close_code: 1001 },
    first: { seq: 1, encoding: "full" },
  },
  {
    n: 2,
    summary: { stream_id: "bbbb", closed_by: "host", close_code: 1000 },
    first: { seq: 1, encoding: "full" },
  },
];
const pages2 = [
  { navigation: 1, time_origin: 1000, trigger: { step: 5 } },
  { navigation: 2, time_origin: 11000, trigger: null },
];
let rr = evaluateReloadReconnect(conns, pages2, 5);
expect(
  "reconnect: honest reload",
  rr.problems.length === 0,
  rr.problems.join("; "),
);
rr = evaluateReloadReconnect(
  [
    conns[0],
    {
      ...conns[1],
      summary: { stream_id: "aaaa", closed_by: "host", close_code: 1000 },
      first: { seq: 7, encoding: "patch" },
    },
  ],
  [pages2[0]],
  5,
);
expect(
  "reconnect: old stream, not seq 1 full, one document all fail",
  rr.problems.length === 3,
  rr.problems.join("; "),
);
expect(
  "reconnect: one connection fails",
  evaluateReloadReconnect([conns[0]], pages2, 5).problems.length === 1,
);
const hook = [
  { op: "http-get", frame: 10, hash: "h1" },
  { op: "http-get", frame: 10, hash: "h1", method: "OPTIONS" },
  { op: "http-get", frame: 400, hash: "h2" },
  { op: "http-get", frame: 700, hash: "h3" },
  { op: "http-get", frame: 700, hash: "h1", method: "OPTIONS" },
];
let wr = evaluateWarmReload(hook, 600);
expect(
  "warm reload: no repeated GET, preflights measured",
  wr.problems.length === 0 &&
    wr.gets_after === 1 &&
    wr.preflights.status === "measured" &&
    wr.preflights.after === 1,
  wr.detail,
);
wr = evaluateWarmReload(
  [...hook, { op: "http-get", frame: 701, hash: "h2" }],
  600,
);
expect(
  "warm reload: a repeated GET fails",
  wr.repeated.length === 1 && wr.problems.length === 1,
);
wr = evaluateWarmReload(
  hook.filter((l) => !l.method),
  600,
);
expect(
  "warm reload: no OPTIONS line -> preflights typed unavailable",
  wr.preflights.status === "unavailable" &&
    typeof wr.preflights.reason === "string" &&
    wr.problems.length === 0,
);
const ctx = {
  lost_us: 10_000_000,
  restored_us: 10_500_000,
  resident: { textures: 7, meshes: 1 },
  uploads_after_restore: { textures: 7, meshes: 1 },
  refetched: 0,
  redraw_us: 10_520_000,
  first_tx_after_restore: 640,
};
expect(
  "context loss (gsw): uploads equal resident",
  evaluateGswContextLoss(ctx).problems.length === 0,
);
expect(
  "context loss (gsw): a missing texture upload fails",
  some(
    evaluateGswContextLoss({
      ...ctx,
      uploads_after_restore: { textures: 6, meshes: 1 },
    }).problems,
    /6 texture uploads/,
  ),
);
expect(
  "context loss (gsw): an extra mesh upload fails",
  some(
    evaluateGswContextLoss({
      ...ctx,
      uploads_after_restore: { textures: 7, meshes: 2 },
    }).problems,
    /2 mesh uploads/,
  ),
);
expect(
  "context loss (gsw): no record fails",
  evaluateGswContextLoss(undefined).problems.length === 1,
);
const credLog = hostLog({ frames: 300, offsetUs: OFF });
let cr = evaluateCreditResumes(credLog, 2_500_000);
expect(
  "credit-resumes: credits and sends after the restore",
  cr.problems.length === 0 && cr.credits_after > 10,
  cr.detail,
);
cr = evaluateCreditResumes(credLog, 99_000_000);
expect(
  "credit-resumes: none after fails",
  some(cr.problems, /no credited ack/),
);

// 7. Sabotage exact sets.
const f = (ids: string[]) =>
  new Map(ids.map((i): [string, string[]] => [i, ["x"]]));
expect(
  "ack-while-hidden: exactly its set passes",
  lcSabotageProblems(
    f(["pending-bounded", "credit-from-paced-loop"]),
    G7U_SABOTAGE_FAILS["ack-while-hidden"],
  ).length === 0,
);
expect(
  "ack-while-hidden: one missing fails",
  lcSabotageProblems(
    f(["pending-bounded"]),
    G7U_SABOTAGE_FAILS["ack-while-hidden"],
  ).length === 1,
);
expect(
  "ack-while-hidden: an extra failure fails",
  lcSabotageProblems(
    f(["pending-bounded", "credit-from-paced-loop", "stall-latest"]),
    G7U_SABOTAGE_FAILS["ack-while-hidden"],
  ).length === 1,
);
expect(
  "css-opacity: exactly compositor passes",
  lcSabotageProblems(
    f(["compositor-equals-readback"]),
    G7U_SABOTAGE_FAILS["css-opacity"],
  ).length === 0,
);
expect(
  "css-opacity: nothing failing fails",
  lcSabotageProblems(f([]), G7U_SABOTAGE_FAILS["css-opacity"]).length === 1,
);
// The ack-while-hidden evidence itself: pending-bounded (credit inside the window) and the paced
// loop (acks from onmessage) fail; the rest of a suspension's evaluators are untouched by it.
const sabApplied = {
  receiver: { kind: "gsw-canvas" },
  transactions: [
    {
      seq: 5,
      submitted_us: 1,
      paced: {
        submitted_from: "onmessage",
        applied_raf: 3,
        drawn_raf: 3,
        drawn_ms: 1,
        submitted_ack_ms: 0.5,
      },
    },
  ],
};
const honestApplied = {
  receiver: { kind: "gsw-canvas" },
  transactions: [
    {
      seq: 5,
      submitted_us: 1,
      paced: {
        submitted_from: "raf",
        applied_raf: 3,
        drawn_raf: 3,
        drawn_ms: 1,
        submitted_ack_ms: 1.2,
      },
    },
  ],
};
const sabFailing = new Map<string, string[]>();
const pbSab = evaluatePendingBounded(
  dHonest,
  { max_in_flight: 1, max_pending: 1 },
  stHonest,
  ss,
).problems;
if (pbSab.length > 0) sabFailing.set("pending-bounded", pbSab);
const pacedSab = pacedLoopProblems("sabotage-ack-while-hidden", sabApplied);
if (pacedSab.length > 0) sabFailing.set("credit-from-paced-loop", pacedSab);
expect(
  "ack-while-hidden evidence fails exactly its set; the honest leg's passes both",
  lcSabotageProblems(sabFailing, G7U_SABOTAGE_FAILS["ack-while-hidden"])
    .length === 0 &&
    pacedLoopProblems("sim-hidden-2s", honestApplied).length === 0 &&
    evaluatePendingBounded(
      dHonest,
      { max_in_flight: 1, max_pending: 1 },
      stHonest,
      sg,
    ).problems.length === 0,
);

// The suspension's host-frame range comes from the window, not from where a credit landed: the
// sabotage's stall model has a 1-frame credit gap but a 120-frame window.
{
  const r = hostFrameRange(sabLog, ss.window_host_us);
  const rh = hostFrameRange(honestLog, sg.window_host_us);
  expect(
    "hostFrameRange: ~120 frames for a 2-s window, honest and sabotage alike",
    r !== null &&
      rh !== null &&
      Math.abs(r[1] - r[0] - 120) <= 1 &&
      Math.abs(rh[1] - rh[0] - 120) <= 1,
    JSON.stringify({ r, rh }),
  );
  expect(
    "hostFrameRange: no window -> null",
    hostFrameRange(sabLog, null) === null,
  );
  expect(
    "fetchWindowStart: G6l's stalled send near the window start, else the window's first frame",
    fetchWindowStart(429, 427) === 429 &&
      fetchWindowStart(546, 427) === 427 &&
      fetchWindowStart(null, 427) === 427 &&
      fetchWindowStart(429, null) === 429,
  );
  // A 30-s suspension outlives TEXA (freed at frame 840): G6l's "exactly one" becomes "none".
  const texaLines = [
    { op: "texture_2d_create", id: 7, hash: "t0", frame: 1 },
    { op: "texture_2d_update", id: 7, hash: "t420", frame: 420 },
    { op: "texture_2d_update", id: 7, hash: "t450", frame: 450 },
    { op: "free", id: 7, hash: "sh", frame: 540, kind: "shader" },
    { op: "texture_2d_update", id: 7, hash: "t810", frame: 810 },
    { op: "free", id: 7, hash: "", frame: 840 },
    { op: "texture_2d_update", id: 9, hash: "other", frame: 500 },
  ];
  const gone = texaFreedIn(texaLines, "t0", 427, 2230);
  expect(
    "texaFreedIn: TEXA freed inside the suspension lists only its in-window versions",
    gone?.freed_frame === 840 && gone.versions.join(",") === "t450,t810",
    JSON.stringify(gone),
  );
  expect(
    "texaFreedIn: TEXA still live at the recovery is G6l's case (null)",
    texaFreedIn(texaLines, "t0", 427, 600) === null,
  );
  expect(
    "texaFetchedIn: a fetch of an in-suspension version is a problem, other hashes are not",
    texaFetchedIn(
      [
        { seq: 153, hash: "t810", source: "http" },
        { seq: 153, hash: "other", source: "http" },
      ],
      ["t450", "t810"],
    ).length === 1 &&
      texaFetchedIn(
        [{ seq: 153, hash: "other", source: "http" }],
        ["t450", "t810"],
      ).length === 0,
  );
}

// 8. D14 as amended (G7u finisher): a frozen leg's lost socket and its gate 1d recovery.
{
  expect(
    "transportLost: one connection and no failure is kept",
    !transportLost(1, null, undefined) && !transportLost(1, null, []),
  );
  expect(
    "transportLost: a second connection, a live-disconnected failure or a loss reconnect is lost",
    transportLost(2, null, undefined) &&
      transportLost(1, { reason: "live-disconnected" }, undefined) &&
      transportLost(1, null, [{ connection: 1 }]),
  );
  expect(
    "transportLost: host connection 1 closed 1001 (a receiver that failed first) is lost; 1000 is kept",
    transportLost(1, { reason: "resource-unavailable" }, undefined, 1001) &&
      !transportLost(1, null, undefined, 1000),
  );
  const skClose = evaluateSocketKept(
    [{ n: 1, stream_id: "aa" }],
    [{ stream_id: "aa" }],
    1,
    null,
    null,
    1001,
  );
  expect(
    "socket-kept: an abnormal host close (1001) fails even with one connection and no failure",
    skClose.problems.length === 1 && /closed 1001/.test(skClose.problems[0]),
    skClose.problems.join("; "),
  );
  const conn = (
    n: number,
    sid: string,
    open: number,
    close: number | null,
    closedBy: string,
    code: number,
    first: { seq: number; encoding: string } | null = null,
  ) => ({
    n,
    summary: { stream_id: sid, closed_by: closedBy, close_code: code },
    open_frame: open,
    close_frame: close,
    first,
  });
  const honestConns = [
    conn(1, "aa", 30, 2252, "receiver", 1001),
    conn(2, "bb", 2262, 3200, "receiver", 1000, { seq: 1, encoding: "full" }),
  ];
  const honestRecv = {
    status: "ok",
    failure: null,
    streams: [
      { stream_id: "aa", end_seen: false },
      { stream_id: "bb", end_seen: true },
    ],
    reconnect: null,
    loss_reconnects: [
      {
        connection: 1,
        code: 1006,
        connect_attempts: 1,
        leftover_rids: 0,
        opened_us: 39000000,
      },
    ],
  };
  let lr = evaluateLossReconnect(honestConns, honestRecv, 1, 437, 30000);
  expect(
    "loss-reconnect: lost at the resume, reconnected seq 1 full, clean dispose, one document",
    lr.problems.length === 0,
    lr.problems.join("; "),
  );
  lr = evaluateLossReconnect(
    [conn(1, "aa", 30, 2252, "receiver", 1001)],
    {
      ...honestRecv,
      status: "replay-failure",
      failure: { reason: "live-disconnected" },
      streams: [{ stream_id: "aa" }],
      loss_reconnects: [],
    },
    1,
    437,
    30000,
  );
  expect(
    "loss-reconnect: a lost socket with no reconnect fails (one connection, the failure, no loss record)",
    lr.problems.length >= 3 &&
      lr.problems.some((p) => /1 host connections/.test(p)) &&
      lr.problems.some((p) => /replay-failure/.test(p)),
    lr.problems.join("; "),
  );
  lr = evaluateLossReconnect(
    [conn(1, "aa", 30, 500, "receiver", 1001), honestConns[1]],
    honestRecv,
    1,
    437,
    30000,
  );
  expect(
    "loss-reconnect: a loss before half the suspension is not the suspension's",
    lr.problems.length === 1 && /before half/.test(lr.problems[0]),
    lr.problems.join("; "),
  );
  lr = evaluateLossReconnect(
    [
      conn(1, "aa", 30, 2252, "host", 1011),
      conn(2, "aa", 2262, 3200, "receiver", 1000, {
        seq: 5,
        encoding: "patch",
      }),
    ],
    honestRecv,
    1,
    437,
    30000,
  );
  expect(
    "loss-reconnect: a host close, a reused stream_id and a patch start each fail",
    lr.problems.length === 4,
    lr.problems.join("; "),
  );
  lr = evaluateLossReconnect(
    honestConns,
    {
      ...honestRecv,
      loss_reconnects: [{ connection: 1, leftover_rids: 3, opened_us: 1 }],
    },
    2,
    437,
    30000,
  );
  expect(
    "loss-reconnect: a leaky dispose and a reload instead of a reconnect fail",
    lr.problems.length === 2,
    lr.problems.join("; "),
  );

  const delivery = (o: Partial<DeliveryReport>): DeliveryReport => ({
    ...dHonest,
    ...o,
  });
  const dOk = delivery({ max_in_flight: 1 });
  let lp = evaluateLossPendingBounded(
    [dOk, dOk],
    [
      { max_in_flight: 1, max_pending: 1 },
      { max_in_flight: 1, max_pending: 1 },
    ],
    [
      { seq: 121, t_us: 1000 },
      { seq: 122, t_us: 7_300_000 },
    ],
    7_350_000,
    37_400_000,
  );
  expect(
    "loss-pending-bounded: the in-flight send precedes the window, nothing inside",
    lp.problems.length === 0 && lp.sends_during.length === 0,
    lp.problems.join("; "),
  );
  lp = evaluateLossPendingBounded(
    [
      dOk,
      delivery({
        max_in_flight: 2,
        in_flight_violations: ["seq 3 sent with 2 in flight"],
      }),
    ],
    [
      { max_in_flight: 1, max_pending: 1 },
      { max_in_flight: 2, max_pending: 2 },
    ],
    [
      { seq: 122, t_us: 7_300_000 },
      { seq: 123, t_us: 9_000_000 },
    ],
    7_350_000,
    37_400_000,
  );
  expect(
    "loss-pending-bounded: a send inside the frozen window and a connection-2 window breach fail",
    lp.sends_during.join(",") === "123" && lp.problems.length === 4,
    lp.problems.join("; "),
  );
  lp = evaluateLossPendingBounded([dOk], [undefined], [], null, null);
  expect(
    "loss-pending-bounded: no host-clock window is a problem",
    lp.problems.length === 1,
    lp.problems.join("; "),
  );

  const t = (
    stream: number,
    seq: number,
    frame: number,
    encoding: string,
    applied: number | null,
  ) => ({ stream, seq, frame, encoding, applied_us: applied });
  let nf = evaluateNewestFirst(
    [
      t(1, 121, 437, "patch", 7_000),
      t(1, 122, 449, "patch", 38_559),
      t(2, 1, 2263, "full", 40_000),
      t(2, 2, 2264, "patch", 40_020),
    ],
    2262,
  );
  expect(
    "newest-first: connection 2's seq 1 full, formed after its open",
    nf.problems.length === 0 && nf.first?.seq === 1,
    nf.problems.join("; "),
  );
  nf = evaluateNewestFirst(
    [t(2, 1, 2200, "full", 40_000), t(1, 122, 449, "patch", 41_000)],
    2262,
  );
  expect(
    "newest-first: an old state, and connection 1 applied after the reconnect, fail",
    nf.problems.length === 2,
    nf.problems.join("; "),
  );
  nf = evaluateNewestFirst([t(1, 122, 449, "patch", 38_559)], 2262);
  expect(
    "newest-first: nothing applied on connection 2 fails",
    nf.problems.length === 1 && /nothing applied/.test(nf.problems[0]),
    nf.problems.join("; "),
  );
  const rn2 = evaluateResumeNoBurst(
    [
      { stream: 1, seq: 122, applied: true, skipped: null, frame_key: 326 },
      { stream: 2, seq: 1, applied: true, skipped: null, frame_key: 400 },
      { stream: 2, seq: 2, applied: true, skipped: null, frame_key: 401 },
    ],
    1,
    [1, 2],
    2,
  );
  expect(
    "resume-no-burst (stream 2): judged from connection 2's seq 1",
    rn2.problems.length === 0 && rn2.first_frame_applies === 1,
    rn2.problems.join("; "),
  );
}

console.log(`self-test-gate7u: ${count - failures}/${count} passed`);
if (failures > 0) process.exitCode = 1;
