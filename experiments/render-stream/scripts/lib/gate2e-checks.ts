// Gate 2 group g2e (G2e): bearer-token authorization on the WebSocket upgrade and on every
// resource GET (protocol/gate2-design.md D13, G2e). Three legs, each a fresh live host (the live
// timeline, S = 300, N = 60, quit 971, as g2c's) plus one live receiver:
//   live-auth                 GRC_LIVE_AUTH=token; the receiver gets the host's own
//                             evidence/live-token (RS_RECEIVER_TOKEN_FILE) -> success
//   sabotage-no-token         same host; the receiver sends no token at all -> replay-failure
//                             (live-connect-failed: the upgrade never reaches STATE_OPEN, HTTP
//                             401 on the host side)
//   sabotage-bad-http-token   same host; the receiver's WebSocket upgrade uses the correct
//                             token but every resource GET uses a deliberately wrong one
//                             (RS_RECEIVER_SABOTAGE=wrong-http-token) -> replay-failure
//                             (resource-unavailable: every GET answers HTTP 401)
//
// Unlike g2c's live legs, g2e's own classification does not compare pixels or resource-traffic
// counts against a per-step budget: gate2-design.md G2e's "Checks" list is exactly
// auth-required, token-not-logged and leg-class-*, nothing pixel- or fetch-count-specific.
// classifyG2eLeg below is a narrower cousin of gate2b-checks.ts's classifyLive: host health
// (armed, stream closed cleanly, no texture-log-divergence) and the receiver's own applied.json
// status are enough to place a leg in gate2-design.md Q7's class precedence.
//
// Evidence layout under <out>/ for g2e (run-gate2.sh "run_g2e"):
//   <leg>/host/       a live host as g2c's, plus evidence/live-token (mode 0600) and, for the
//                     sabotage legs, a "401 unauthorized upgrade" line in stdout.log
//                     (sabotage-no-token) or an http-get 401 line in evidence/resources.jsonl
//                     (sabotage-bad-http-token)
//   <leg>/receiver/   its live receiver: applied.json, stdout.log (headless, credit stage
//                     applied, for the sabotages; rendered with the live shot windows for
//                     live-auth)

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { readTextOrUndefined } from "./gate-minus1-checks";
import { readExitCode } from "./gate0-checks";
import type { Gate2Expected } from "./gate2-expected";
import {
  type CaptureEvidence,
  G2B_PRECEDENCE,
  type G2bCheck,
  type G2bClass,
  loadCapture,
  loadReceiver,
  type ReceiverEvidence,
  textureLogDivergence,
} from "./gate2b-checks";

/** run-gate2.sh's live timeline: S = 300, N = 60, quit S + N*11 + 11 (steps 0..11; as
 * gate2b-checks.ts's live-inline leg and gate2c-checks.ts's live legs). */
const LIVE_QUIT_FRAME = 971;

function check(
  id: string,
  criterion: string,
  problems: string[],
  okDetail: string,
  evidence: string[],
): G2bCheck {
  return {
    id,
    criterion,
    passed: problems.length === 0,
    status: problems.length === 0 ? "pass" : "fail",
    detail: problems.length === 0 ? okDetail : problems.join("; "),
    evidence,
  };
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export interface G2eLegExpectation {
  leg: string;
  expected_class: G2bClass;
  /** some reason of the expected class must contain this text */
  reason?: string;
}

export const G2E_LEGS: readonly G2eLegExpectation[] = [
  { leg: "live-auth", expected_class: "success" },
  {
    leg: "sabotage-no-token",
    expected_class: "replay-failure",
    reason: "live-connect-failed",
  },
  {
    leg: "sabotage-bad-http-token",
    expected_class: "replay-failure",
    reason: "resource-unavailable",
  },
];

export interface G2eClassification {
  result_class: G2bClass;
  reasons: string[];
}

/** Host health plus the receiver's own applied.json status -- no pixel or resource-traffic
 * comparison (gate2-design.md G2e's "Checks" list does not ask for either). */
export function classifyG2eLeg(
  host: CaptureEvidence,
  receiver: ReceiverEvidence,
): G2eClassification {
  const fired = new Map<G2bClass, string[]>();
  const fire = (cls: G2bClass, reason: string) =>
    fired.set(cls, [...(fired.get(cls) ?? []), `${cls}: ${reason}`]);

  const res = host.result;
  if (
    res?.status !== "armed" ||
    res?.stream?.status !== "closed" ||
    res?.stream?.reason
  )
    fire(
      "capture-failure",
      `host status ${res?.status} stream ${res?.stream?.status} ${res?.stream?.reason ?? ""}`,
    );
  for (const r of [host.full, host.patch])
    if (r.errors.length > 0)
      fire("capture-failure", `${r.path}: ${r.errors[0]}`);
  if (host.full.recording && !host.hook.problem) {
    const d = textureLogDivergence(host.hook.lines, host.full.recording);
    if (d.length > 0)
      fire("capture-failure", `texture-log-divergence: ${d[0]}`);
  } else if (host.hook.problem) {
    fire("capture-failure", `resources.jsonl ${host.hook.problem}`);
  }

  const a = receiver.applied;
  if (a?.status !== "ok" || a.end_seen !== true)
    fire(
      "replay-failure",
      `applied status ${a?.status} ${JSON.stringify(a?.failure ?? null)}`,
    );

  const result_class =
    G2B_PRECEDENCE.find((cls) => fired.has(cls)) ?? "success";
  return {
    result_class,
    reasons: G2B_PRECEDENCE.flatMap((cls) => fired.get(cls) ?? []),
  };
}

export function checkG2eLegClass(
  e: G2eLegExpectation,
  c: G2eClassification,
  extra: string[] = [],
  evidence: string[] = [],
): G2bCheck {
  const problems: string[] = [...extra];
  if (c.result_class !== e.expected_class)
    problems.push(
      `class ${c.result_class}, expected ${e.expected_class}: ${c.reasons.slice(0, 3).join(" | ")}`,
    );
  if (
    e.reason &&
    !c.reasons.some(
      (r) =>
        r.startsWith(`${e.expected_class}:`) && r.includes(e.reason as string),
    )
  )
    problems.push(`no ${e.expected_class} reason mentions ${e.reason}`);
  return check(
    `leg-class-${e.leg}`,
    `${e.leg} classifies as ${e.expected_class}${e.reason ? ` (${e.reason})` : ""}`,
    problems,
    `${c.result_class}: ${c.reasons[0] ?? "no reason fired"}`,
    evidence,
  );
}

// ---------------------------------------------------------------------------------------------
// auth-required, token-not-logged
// ---------------------------------------------------------------------------------------------

interface HostAuthEvidence {
  wsAuthRejected401s: number;
  httpGet401s: number;
}

/** Counts, for one leg's host: "401 unauthorized upgrade" lines in stdout.log (entry.cpp's
 * live_drain() logs rs_ws's AuthRejected event there, never into resources.jsonl) and http-get
 * lines with http_status 401 in evidence/resources.jsonl (the existing hook-log path, unchanged
 * for G2e). */
async function hostAuthEvidence(
  outDir: string,
  leg: string,
): Promise<HostAuthEvidence> {
  const hostDir = join(outDir, leg, "host");
  const stdoutLog =
    (await readTextOrUndefined(join(hostDir, "stdout.log"))) ?? "";
  const wsAuthRejected401s = (
    stdoutLog.match(/401 unauthorized upgrade/g) ?? []
  ).length;
  const hookText = await readTextOrUndefined(
    join(hostDir, "evidence", "resources.jsonl"),
  );
  let httpGet401s = 0;
  for (const line of (hookText ?? "").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as { op?: string; http_status?: number };
      if (parsed.op === "http-get" && parsed.http_status === 401) httpGet401s++;
    } catch {
      // A malformed hook-log line is recordings-decode's problem, not this check's.
    }
  }
  return { wsAuthRejected401s, httpGet401s };
}

/** D12/G2e "Checks": the host log shows 401s exactly for the sabotage requests -- an upgrade
 * rejection for sabotage-no-token, a resource-GET rejection for sabotage-bad-http-token -- and
 * none at all for live-auth. */
export async function checkAuthRequired(outDir: string): Promise<G2bCheck> {
  const problems: string[] = [];
  const notes: string[] = [];
  const expectUpgrade401: Record<string, boolean> = {
    "live-auth": false,
    "sabotage-no-token": true,
    "sabotage-bad-http-token": false,
  };
  const expectGet401: Record<string, boolean> = {
    "live-auth": false,
    "sabotage-no-token": false,
    "sabotage-bad-http-token": true,
  };
  for (const { leg } of G2E_LEGS) {
    const e = await hostAuthEvidence(outDir, leg);
    notes.push(
      `${leg}: upgrade-401 ${e.wsAuthRejected401s}, GET-401 ${e.httpGet401s}`,
    );
    if (expectUpgrade401[leg] && e.wsAuthRejected401s < 1)
      problems.push(
        `${leg}: expected a 401 upgrade rejection in the host log, found none`,
      );
    if (!expectUpgrade401[leg] && e.wsAuthRejected401s > 0)
      problems.push(
        `${leg}: expected no 401 upgrade rejection, host log shows ${e.wsAuthRejected401s}`,
      );
    if (expectGet401[leg] && e.httpGet401s < 1)
      problems.push(
        `${leg}: expected a 401 resource GET in the hook log, found none`,
      );
    if (!expectGet401[leg] && e.httpGet401s > 0)
      problems.push(
        `${leg}: expected no 401 resource GET, hook log shows ${e.httpGet401s}`,
      );
  }
  return check(
    "auth-required",
    "the host log shows 401s exactly for the sabotage requests (an upgrade rejection for sabotage-no-token, a resource GET rejection for sabotage-bad-http-token) and none for live-auth",
    problems,
    notes.join("; "),
    G2E_LEGS.map((l) => join(outDir, l.leg, "host", "stdout.log")),
  );
}

/** Every file under <leg>/ (recursively) that is not `exclude` itself, whose bytes contain
 * `token`. A raw byte search (Buffer.includes), so it catches the token inside a binary
 * recording or PNG just as reliably as inside a text log. */
async function grepTreeForToken(
  root: string,
  token: string,
  exclude: string,
): Promise<string[]> {
  const hits: string[] = [];
  let entries: string[];
  try {
    entries = (await readdir(root, { recursive: true })) as string[];
  } catch {
    return hits;
  }
  const needle = Buffer.from(token, "utf8");
  for (const rel of entries) {
    const full = join(root, rel);
    if (full === exclude) continue;
    let buf: Buffer;
    try {
      buf = await readFile(full);
    } catch {
      continue; // a directory entry (readdir recursive lists directories too), or unreadable.
    }
    if (buf.includes(needle)) hits.push(full);
  }
  return hits;
}

/** G2e "Checks": the token string appears in no evidence or log file except evidence/live-token
 * itself. Checked per leg, against that leg's own host-generated token (every g2e leg's host
 * runs with GRC_LIVE_AUTH=token, sabotage-no-token's included -- its receiver just never sends
 * it). */
export async function checkTokenNotLogged(outDir: string): Promise<G2bCheck> {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const { leg } of G2E_LEGS) {
    const tokenPath = join(outDir, leg, "host", "evidence", "live-token");
    const token = (await readTextOrUndefined(tokenPath))?.trim();
    if (!token) {
      problems.push(`${leg}: no evidence/live-token to check against`);
      continue;
    }
    const hits = await grepTreeForToken(join(outDir, leg), token, tokenPath);
    if (hits.length > 0)
      problems.push(`${leg}: the token appears in ${hits.join(", ")}`);
    else
      notes.push(
        `${leg}: clean (${token.length}-char token, evidence/live-token only)`,
      );
  }
  return check(
    "token-not-logged",
    "the bearer token string appears in no evidence or log file under <leg>/ except evidence/live-token itself",
    problems,
    notes.join("; "),
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// The g2e group
// ---------------------------------------------------------------------------------------------

export interface G2eLegReport {
  group: "g2e";
  expected_class: G2bClass | null;
  result_class: G2bClass | null;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
}

export async function runG2e(
  outDir: string,
  expected: Gate2Expected,
): Promise<{ checks: G2bCheck[]; legs: Record<string, G2eLegReport> }> {
  const checks: G2bCheck[] = [];
  const legs: Record<string, G2eLegReport> = {};
  for (const e of G2E_LEGS) {
    const host = await loadCapture(
      outDir,
      e.leg,
      join(e.leg, "host"),
      LIVE_QUIT_FRAME,
    );
    const receiver = await loadReceiver(
      outDir,
      e.leg,
      join(e.leg, "receiver"),
      null,
      expected,
    );
    const c = classifyG2eLeg(host, receiver);
    const artifacts = [
      join(receiver.dir, "applied.json"),
      join(receiver.dir, "stdout.log"),
      join(host.dir, "evidence", "result.json"),
      join(host.dir, "stdout.log"),
    ];
    checks.push(checkG2eLegClass(e, c, [], artifacts));
    legs[e.leg] = {
      group: "g2e",
      expected_class: e.expected_class,
      result_class: c.result_class,
      reasons: c.reasons,
      exit_code: await readExitCode(receiver.dir),
      artifacts,
    };
  }
  checks.push(await checkAuthRequired(outDir));
  checks.push(await checkTokenNotLogged(outDir));
  return { checks, legs };
}
