#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for G7r's pure pieces (never a browser, a host or a Godot run):
//
//  1. g7rLegs (lib/gate7r-checks.ts) lists, per receiver kind, exactly the legs run-gate7.sh's
//     G7R_LEGS_<kind> asks run-gate6.sh for, and lib/gate6c-legs.sh knows every one of them.
//  2. phaseClass: good at a mean credit RTT <= 1.1 host frames, bad at >= 1.9, between otherwise.
//  3. G6c's as-built bound holds in either phase: a bad-phase run (RTT 2 frames, ~30/s published)
//     passes rate-achieved because its credit capacity is ~30/s, and a host that sat on credit
//     (published below 0.95 x capacity) fails it.
//  4. evaluateMismatch60Recv30 names each bound on its own line, and sabotageProblems accepts
//     exactly {credit-from-paced-loop, rate-mismatch on its upper bound}, refusing a missing or
//     extra failure, a lower-bound failure and a mismatch failure that is not the upper bound.
//  5. gswPhaseFreeHolds takes only rAF-sent acks (rAF timestamp to the ack).
//     fetchTail/fetchTailCause name a missed sub-host-rate target as the receiver's fetch tail
//     only when the long holds waited for slow GETs.
//  6. HttpExchangeObserver (throttle-proxy.ts) pairs OPTIONS with its 204 as a preflight and GET
//     with its 200, and stops observing a connection after a 101 (WebSocket frames follow).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ConnRates,
  evaluateMismatch60Recv30,
  evaluateRateAchieved,
  type G6cMeasure,
  MISMATCH_LOWER_BOUND,
  MISMATCH_UPPER_BOUND,
} from "../lib/gate6c-checks";
import {
  fetchTail,
  fetchTailCause,
  G7R_KINDS,
  g7rLegs,
  gswPhaseFreeHolds,
  phaseClass,
  sabotageProblems,
} from "../lib/gate7r-checks";
import { HttpExchangeObserver } from "../throttle-proxy";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `: ${detail}`}`,
  );
}

// 1. The leg lists against run-gate7.sh and gate6c-legs.sh.
const runner = readFileSync(join(SCRIPTS, "run-gate7.sh"), "utf8");
const shellVar = (name: string): string => {
  const m = new RegExp(`^${name}="?([^"\\n]*)"?$`, "m").exec(runner);
  if (!m) throw new Error(`run-gate7.sh has no ${name}`);
  return m[1].replace(/\$([A-Z0-9_]+)/g, (_, v: string) => shellVar(v));
};
const legsSh = readFileSync(join(SCRIPTS, "lib", "gate6c-legs.sh"), "utf8");
for (const kind of G7R_KINDS) {
  const want = shellVar(`G7R_LEGS_${kind}`).split(",");
  const got = g7rLegs(kind).map((d) => d.leg);
  expect(
    `g7rLegs(${kind}) equals run-gate7.sh G7R_LEGS_${kind}`,
    JSON.stringify(got) === JSON.stringify(want),
    `${got.join(",")} vs ${want.join(",")}`,
  );
  const unknown = got.filter(
    (l) =>
      !legsSh.includes(`g6c_wanted ${l};`) &&
      !legsSh.includes(`g6c_wanted "${l.replace(/\d+$/, "")}$run"`) &&
      !legsSh.includes(`g6c_wanted "rate-$leg"`) &&
      !/^rate-(15|30|60)$/.test(l),
  );
  expect(
    `gate6c-legs.sh runs every ${kind} leg`,
    unknown.length === 0,
    unknown.join(","),
  );
}
expect(
  "native runs no browser receiver; dual-native's receiver-b stays native",
  g7rLegs("native").every((d) => d.browser_receivers.length === 0) &&
    JSON.stringify(
      g7rLegs("web").find((d) => d.leg === "dual-native")?.browser_receivers,
    ) === JSON.stringify(["receiver-a"]),
);
expect(
  "a browser rate leg is rAF-bound (max_fps 0) where native runs at 60",
  g7rLegs("gsw").find((d) => d.leg === "rate-60")?.receivers[0].max_fps === 0 &&
    g7rLegs("native").find((d) => d.leg === "phase-60-r1")?.receivers[0]
      .max_fps === 60 &&
    g7rLegs("gsw").find((d) => d.leg === "sabotage-ack-on-receipt")
      ?.receivers[0].max_fps === 30,
);

// 2. Phase classes.
expect(
  "phaseClass thresholds",
  phaseClass(1.02) === "good" &&
    phaseClass(1.1) === "good" &&
    phaseClass(1.5) === "between" &&
    phaseClass(1.9) === "bad" &&
    phaseClass(2.09) === "bad",
);

// 3./4. Synthetic measures.
const conn = (published: number, frames: number, blocked = 0): ConnRates => {
  const sent = Math.round(published * 19);
  return {
    connection: 1,
    published,
    received: published,
    applied: published,
    submitted: published,
    credits: sent,
    sent,
    acks: [sent, sent, sent],
    ticks_credit_blocked: blocked,
    bytes_per_s: 0,
    credit_rtt_mean_us: frames * 16_667,
    credit_rtt_mean_frames: frames,
  };
};
const measure = (c: ConnRates, receiverFrame: number): G6cMeasure => ({
  leg: "x",
  window: {
    start_frame: 360,
    start_t_us: 0,
    end_t_us: 20e6,
    first: { t_us: 0, frame: 360, connections: [] },
    last: { t_us: 19e6, frame: 1500, connections: [] },
    seconds: 19,
  },
  window_problem: null,
  host_frame: 60,
  conns: [c],
  receivers: [
    {
      dir: "receiver",
      max_fps: 0,
      connection: 1,
      receiver_frame: receiverFrame,
      frame_interval_p50_us: null,
      gpu_render_p50_us: null,
      cpu_render_p50_us: null,
      hold_p50_us: null,
      hold_p95_us: null,
    },
  ],
  frame_interval_p95_us: 17_360,
  callback_p50_us: 300,
  snapshot_count: 1,
  callback_count: 1,
});
expect(
  "a good-phase run passes G6c's bound",
  evaluateRateAchieved(measure(conn(59.1, 1.02), 60), 60, {
    appliedChecks: true,
  }).length === 0,
);
expect(
  "a bad-phase run (2 host frames, ~30/s) passes G6c's as-built bound",
  evaluateRateAchieved(measure(conn(29.6, 2.03), 60), 60, {
    appliedChecks: true,
  }).length === 0,
);
expect(
  "a host that sat on credit (published below 0.95 x capacity) fails it",
  evaluateRateAchieved(measure(conn(20, 2.0), 60), 60, {
    appliedChecks: true,
  }).length === 1,
);
const upper = evaluateMismatch60Recv30(measure(conn(58, 1.03, 0), 30));
expect(
  "mismatch: an ack-on-receipt host (58/s at a 30 fps receiver, never blocked) fails the upper bound and the blocked ticks, never the lower bound",
  upper.some((p) => p.startsWith(MISMATCH_UPPER_BOUND)) &&
    !upper.some((p) => p.startsWith(MISMATCH_LOWER_BOUND)) &&
    upper.length === 2,
  upper.join(" | "),
);
const lower = evaluateMismatch60Recv30(measure(conn(20, 2.0, 30), 30));
expect(
  "mismatch: a host below 0.95 x min(60, capacity) fails the lower bound only",
  lower.length === 1 && lower[0].startsWith(MISMATCH_LOWER_BOUND),
  lower.join(" | "),
);
expect(
  "mismatch: an honest 30 fps receiver passes",
  evaluateMismatch60Recv30(measure(conn(28.8, 2.08, 600), 30)).length === 0,
);
const sab = (entries: [string, string[]][]) =>
  sabotageProblems(new Map(entries));
expect(
  "sabotage: exactly credit-from-paced-loop and rate-mismatch's upper bound passes",
  sab([
    ["credit-from-paced-loop", ["seq 3: submitted from onmessage"]],
    ["rate-mismatch", upper],
  ]).length === 0,
);
expect(
  "sabotage: rate-mismatch missing fails",
  sab([["credit-from-paced-loop", ["x"]]]).length === 1,
);
expect(
  "sabotage: an extra failing check fails",
  sab([
    ["credit-from-paced-loop", ["x"]],
    ["rate-mismatch", upper],
    ["final-latest-state", ["12 px"]],
  ]).length === 1,
);
expect(
  "sabotage: rate-mismatch on blocked ticks only (not the upper bound) fails",
  sab([
    ["credit-from-paced-loop", ["x"]],
    ["rate-mismatch", ["no tick was credit-blocked inside the window"]],
  ]).length === 1,
);
expect(
  "sabotage: a lower-bound failure fails",
  sab([
    ["credit-from-paced-loop", ["x"]],
    ["rate-mismatch", [...upper, ...lower]],
  ]).length === 1,
);

// 5. GSW's phase-free hold.
const holds = gswPhaseFreeHolds([
  {
    paced: {
      submitted_from: "raf",
      applied_raf_ts_ms: 1000,
      submitted_ack_ms: 1003.5,
    },
  },
  {
    paced: {
      submitted_from: "onmessage",
      applied_raf_ts_ms: null,
      submitted_ack_ms: 1010,
    },
  },
  { paced: { submitted_from: null } },
]);
expect(
  "gswPhaseFreeHolds: rAF acks only, rAF timestamp to the ack",
  holds.length === 1 && Math.abs(holds[0] - 3500) < 1e-6,
  JSON.stringify(holds),
);

// 5b. The fetch tail names a missed sub-host-rate target only when the long holds are fetches.
const tx = (hold: number, fetched: number) => ({
  received_us: 0,
  submitted_us: hold,
  resources: { fetched },
});
const tailOf = (fetchUs: number, txs: ReturnType<typeof tx>[]) =>
  fetchTail({
    transactions: txs,
    fetches: [0, 1, 2].map(() => ({ start_us: 0, end_us: fetchUs })),
  });
const rate15 = g7rLegs("web").find((d) => d.leg === "rate-15");
const rate60 = g7rLegs("web").find((d) => d.leg === "rate-60");
const webTail = tailOf(66_000, [tx(2000, 0), tx(70_000, 2), tx(68_000, 1)]);
expect(
  "fetchTailCause: a 66 ms GET behind every long hold explains rate-15's miss",
  rate15 !== undefined &&
    webTail.long_holds === 2 &&
    fetchTailCause(rate15, webTail, 60) !== undefined,
  JSON.stringify(webTail),
);
expect(
  "fetchTailCause: never at the host's own rate, never for fast GETs, never for non-fetch holds",
  rate15 !== undefined &&
    rate60 !== undefined &&
    fetchTailCause(rate60, webTail, 60) === undefined &&
    fetchTailCause(rate15, tailOf(16_600, [tx(70_000, 1)]), 60) === undefined &&
    fetchTailCause(
      rate15,
      tailOf(66_000, [tx(70_000, 0), tx(70_000, 0)]),
      60,
    ) === undefined,
);

// 6. The proxy's HTTP observer.
const sink = { preflight: [] as number[], get: [] as number[] };
const http = new HttpExchangeObserver(sink);
const b = (t: string) => Buffer.from(t, "latin1");
http.request(b("OPTIONS /resources/ab HTTP/1.1\r\n"), 100);
http.response(b("HTTP/1.1 204 No Content\r\n"), 165);
http.request(b("GET /resources/ab HTTP/1.1\r\n"), 170);
http.response(b("HTTP/1.1 200 OK\r\n"), 250);
http.response(b("\x89PNG body bytes"), 260);
const ws = new HttpExchangeObserver(sink);
ws.request(b("GET /render-stream HTTP/1.1\r\n"), 0);
ws.response(b("HTTP/1.1 101 Switching Protocols\r\n"), 70);
ws.request(b("GET looks-like-a-frame"), 80);
ws.response(b("HTTP/1.1 200 inside a frame"), 90);
expect(
  "HttpExchangeObserver: one 65 ms preflight, one 80 ms GET, nothing after a 101",
  JSON.stringify(sink) === JSON.stringify({ preflight: [65], get: [80] }),
  JSON.stringify(sink),
);

console.log(
  failures === 0
    ? "self-test-gate7r: all checks correct"
    : `self-test-gate7r: ${failures} FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
