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
import { type G2cFetch, getsVsFetches, httpGets } from "./gate2c-checks";

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
  /** G8kz: or one of these texts (a refusal that has more than one right code) */
  reason_any?: readonly string[];
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

/** G8kz (texture-delivery-design.md D2): the HTTP content-coding legs, each a fresh live host and
 * a headless receiver on the live timeline. `coding-gzip`: GRC_HTTP_ENCODING=gzip. `coding-off`:
 * GRC_HTTP_ENCODING=off. `coding-receiver-off` (native receivers only; a browser always asks):
 * the default host, and a native receiver with RS_RECEIVER_ACCEPT_ENCODING=off.
 * `sabotage-corrupt-coded-body`: the host flips one byte of every coded body it sends, and the
 * receiver must refuse it (the body no longer decodes, or decodes to bytes whose SHA-256 is not
 * the hash), never apply it. The default host (zstd) is judged on live-auth. */
export const G2E_CODING_LEGS: readonly G2eLegExpectation[] = [
  { leg: "coding-gzip", expected_class: "success" },
  { leg: "coding-off", expected_class: "success" },
  { leg: "coding-receiver-off", expected_class: "success" },
  {
    leg: "sabotage-corrupt-coded-body",
    expected_class: "replay-failure",
    reason_any: [
      "resource-invalid",
      "resource-hash-mismatch",
      "resource-unavailable",
    ],
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
  if (
    e.reason_any &&
    !c.reasons.some(
      (r) =>
        r.startsWith(`${e.expected_class}:`) &&
        (e.reason_any as readonly string[]).some((t) => r.includes(t)),
    )
  )
    problems.push(
      `no ${e.expected_class} reason mentions any of ${e.reason_any.join(", ")}`,
    );
  return check(
    `leg-class-${e.leg}`,
    `${e.leg} classifies as ${e.expected_class}${e.reason ? ` (${e.reason})` : ""}${e.reason_any ? ` (${e.reason_any.join(" or ")})` : ""}`,
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
  /** G7l: connection 1 of the host's live-summary.json (null when absent) */
  connection: HostConnection | null;
}

/** The live-summary.json fields G7l's /7 auth reading needs (render-stream-7.md, G7n). */
interface HostConnection {
  version?: number;
  token_ok?: boolean | null;
  close_code?: number | null;
  close_reason?: string | null;
  closed_by?: string | null;
  origin?: string | null;
  http_gets?: number;
}

/** G7l: whether a leg's connection spoke render-stream/7 (a browser receiver; the token then
 * travels in the hello, so a missing or wrong one is an `unauthorized` hello rejection, close 1008,
 * instead of a 401 upgrade). A native /6 run never has one, so its checks are unchanged. */
function isV7(e: HostAuthEvidence): boolean {
  return e.connection?.version === 7;
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
  const summaryText = await readTextOrUndefined(
    join(hostDir, "evidence", "live-summary.json"),
  );
  let connection: HostConnection | null = null;
  try {
    const summary = JSON.parse(summaryText ?? "null") as {
      connections?: Array<HostConnection & { connection?: number }>;
    } | null;
    connection = summary?.connections?.find((c) => c.connection === 1) ?? null;
  } catch {
    connection = null;
  }
  return { wsAuthRejected401s, httpGet401s, connection };
}

/** G7l: the /7 reading of one leg's hello outcome: a rejection is token_ok false with error
 * `unauthorized` and close 1008 by the host; an accepted hello is token_ok true. */
function v7HelloProblems(
  leg: string,
  e: HostAuthEvidence,
  rejected: boolean,
): string[] {
  const c = e.connection;
  const problems: string[] = [];
  if (rejected) {
    if (
      c?.token_ok !== false ||
      c.close_code !== 1008 ||
      c.close_reason !== "unauthorized" ||
      c.closed_by !== "host"
    )
      problems.push(
        `${leg}: expected the /7 hello rejected (token_ok false, closed by the host 1008 unauthorized), host summary has token_ok ${c?.token_ok} close ${c?.closed_by} ${c?.close_code} ${c?.close_reason}`,
      );
  } else if (c?.token_ok !== true) {
    problems.push(
      `${leg}: expected the /7 hello's token accepted (token_ok true), host summary has ${c?.token_ok}`,
    );
  }
  return problems;
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
    if (isV7(e)) {
      // G7l: at /7 the upgrade never carries the token, so no leg may show a 401 upgrade;
      // sabotage-no-token's refusal is the hello's (`unauthorized`, close 1008), and the GET
      // rule is /6's.
      notes.push(
        `${leg} (/7): hello token_ok ${e.connection?.token_ok}, close ${e.connection?.close_code} ${e.connection?.close_reason ?? ""}, upgrade-401 ${e.wsAuthRejected401s}, GET-401 ${e.httpGet401s}`,
      );
      problems.push(...v7HelloProblems(leg, e, expectUpgrade401[leg]));
      if (e.wsAuthRejected401s > 0)
        problems.push(
          `${leg}: a /7 connection never sends the token on the upgrade, yet the host log shows ${e.wsAuthRejected401s} 401 upgrade rejection(s)`,
        );
    } else {
      notes.push(
        `${leg}: upgrade-401 ${e.wsAuthRejected401s}, GET-401 ${e.httpGet401s}`,
      );
    }
    if (isV7(e)) {
      // the upgrade rules above replace /6's
    } else if (expectUpgrade401[leg] && e.wsAuthRejected401s < 1)
      problems.push(
        `${leg}: expected a 401 upgrade rejection in the host log, found none`,
      );
    if (!isV7(e) && !expectUpgrade401[leg] && e.wsAuthRejected401s > 0)
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
    "the host log shows 401s exactly for the sabotage requests (an upgrade rejection for sabotage-no-token, a resource GET rejection for sabotage-bad-http-token) and none for live-auth; on a render-stream/7 connection (G7l, a browser receiver) sabotage-no-token's rejection is instead the hello's (token_ok false, error and close 1008 `unauthorized`), live-auth's and sabotage-bad-http-token's hellos have token_ok true, and no upgrade is ever 401",
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

/** G7l (gate7-design.md Q8 g7-2): the two legs only a browser receiver runs (run-gate2.sh under
 * GATE7_LIVE_KIND). Judged only when live-auth's connection spoke /7, so a native /6 run of gate 2
 * is unchanged. */
export const G2E_V7_LEGS: readonly G2eLegExpectation[] = [
  {
    leg: "origin-refused",
    expected_class: "replay-failure",
    reason: "live-connect-failed",
  },
  {
    leg: "sabotage-no-cors",
    expected_class: "replay-failure",
    reason: "resource-unavailable",
  },
];

interface HookGet {
  hash?: string;
  http_status?: number;
  method?: string;
}

async function hookGets(hostDir: string): Promise<HookGet[]> {
  const text = await readTextOrUndefined(
    join(hostDir, "evidence", "resources.jsonl"),
  );
  const out: HookGet[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as HookGet & { op?: string };
      if (parsed.op === "http-get") out.push(parsed);
    } catch {
      // recordings-decode's problem
    }
  }
  return out;
}

/** origin-refused: the page's origin (page-config.json) is not in the host's allowlist
 * (live.json), the host logged `live: 403 origin <that origin>` (OriginRejected) and counted it,
 * no connection ever opened, and the receiver failed live-connect-failed. */
export async function checkOriginRefused(outDir: string): Promise<G2bCheck> {
  const problems: string[] = [];
  const hostDir = join(outDir, "origin-refused", "host");
  const receiverDir = join(outDir, "origin-refused", "receiver");
  const page = JSON.parse(
    (await readTextOrUndefined(join(receiverDir, "page-config.json"))) ??
      "null",
  ) as { origin?: string } | null;
  const live = JSON.parse(
    (await readTextOrUndefined(join(hostDir, "evidence", "live.json"))) ??
      "null",
  ) as { allowed_origins?: string[] } | null;
  const summary = JSON.parse(
    (await readTextOrUndefined(
      join(hostDir, "evidence", "live-summary.json"),
    )) ?? "null",
  ) as {
    connections?: unknown[];
    resources?: { origin_rejected?: number };
  } | null;
  const stdoutLog =
    (await readTextOrUndefined(join(hostDir, "stdout.log"))) ?? "";
  const origin = page?.origin;
  if (!origin) problems.push("the receiver's page-config.json names no origin");
  else if ((live?.allowed_origins ?? []).includes(origin))
    problems.push(`the page origin ${origin} is in the host's allowlist`);
  const rejected = origin
    ? stdoutLog
        .split("\n")
        .filter((l) => l.includes(`live: 403 origin ${origin}`))
    : [];
  if (rejected.length < 1)
    problems.push(
      `no "live: 403 origin ${origin}" line in the host's stdout.log`,
    );
  const counted = summary?.resources?.origin_rejected ?? 0;
  if (counted < 1)
    problems.push(
      `live-summary.json resources.origin_rejected is ${counted}, expected >= 1`,
    );
  if ((summary?.connections ?? []).length > 0)
    problems.push(
      `the host opened ${(summary?.connections ?? []).length} connection(s) for a refused origin`,
    );
  return check(
    "origin-refused",
    "origin-refused (G7l): a page served from an origin the host does not allow is refused on the WebSocket upgrade with 403 (OriginRejected logged as `live: 403 origin <origin>` and counted in live-summary.json), no connection opens, and the receiver fails live-connect-failed",
    problems,
    `${rejected.length} rejection line(s) for ${origin} (allowed: ${(live?.allowed_origins ?? []).join(", ")}), origin_rejected ${counted}, 0 connections`,
    [
      join(hostDir, "stdout.log"),
      join(hostDir, "evidence", "live-summary.json"),
      join(receiverDir, "page-config.json"),
    ],
  );
}

/** sabotage-no-cors: the host served the receiver's first GET (hook-log http-get 200, an Origin
 * request) without any Access-Control-* header, and the receiver failed resource-unavailable at
 * seq 1 (the browser withheld the response). */
export async function checkNoCors(outDir: string): Promise<G2bCheck> {
  const problems: string[] = [];
  const hostDir = join(outDir, "sabotage-no-cors", "host");
  const receiverDir = join(outDir, "sabotage-no-cors", "receiver");
  const live = JSON.parse(
    (await readTextOrUndefined(join(hostDir, "evidence", "live.json"))) ??
      "null",
  ) as { listener_sabotage?: string | null } | null;
  const applied = JSON.parse(
    (await readTextOrUndefined(join(receiverDir, "applied.json"))) ?? "null",
  ) as { failure?: { seq?: number | null; reason?: string } | null } | null;
  const gets = (await hookGets(hostDir)).filter(
    (g) => (g.method ?? "GET") === "GET",
  );
  const served = gets.filter((g) => g.http_status === 200);
  if (live?.listener_sabotage !== "no-cors")
    problems.push(
      `live.json listener_sabotage is ${live?.listener_sabotage}, expected no-cors`,
    );
  if (served.length < 1)
    problems.push("the host's hook log shows no GET it served (http-get 200)");
  if (
    applied?.failure?.reason !== "resource-unavailable" ||
    applied.failure.seq !== 1
  )
    problems.push(
      `the receiver's failure is ${JSON.stringify(applied?.failure ?? null)}, expected resource-unavailable at seq 1`,
    );
  return check(
    "no-cors-withheld",
    "sabotage-no-cors (G7l): with every Access-Control-* header omitted, the host still served the receiver's GET (http-get 200 in its hook log), and the browser withheld it: the receiver fails resource-unavailable at seq 1",
    problems,
    `${served.length} GET(s) served (${gets.length} logged); receiver ${applied?.failure?.reason} at seq ${applied?.failure?.seq}`,
    [
      join(hostDir, "evidence", "resources.jsonl"),
      join(receiverDir, "applied.json"),
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// G8kz: HTTP content coding
// ---------------------------------------------------------------------------------------------

interface CodingLegEvidence {
  gets: ReturnType<typeof httpGets>;
  httpEncoding: string | null;
  listenerSabotage: string | null;
  summary: {
    http_gets?: number;
    http_bytes?: number;
    http_coded_bytes?: number;
    http_encoding?: string;
    coded_made?: number;
  } | null;
  fetches: G2cFetch[];
  cacheMode: string | null;
  failure: { seq: number | null; reason: string } | null | undefined;
  hostDir: string;
  receiverDir: string;
}

async function loadCodingLeg(
  outDir: string,
  leg: string,
): Promise<CodingLegEvidence> {
  const hostDir = join(outDir, leg, "host");
  const receiverDir = join(outDir, leg, "receiver");
  const host = await loadCapture(
    outDir,
    leg,
    join(leg, "host"),
    LIVE_QUIT_FRAME,
  );
  const live = JSON.parse(
    (await readTextOrUndefined(join(hostDir, "evidence", "live.json"))) ??
      "null",
  ) as { http_encoding?: string; listener_sabotage?: string | null } | null;
  const summary = JSON.parse(
    (await readTextOrUndefined(
      join(hostDir, "evidence", "live-summary.json"),
    )) ?? "null",
  ) as { resources?: CodingLegEvidence["summary"] } | null;
  const applied = JSON.parse(
    (await readTextOrUndefined(join(receiverDir, "applied.json"))) ?? "null",
  ) as {
    fetches?: G2cFetch[];
    cache?: { mode?: string };
    failure?: { seq: number | null; reason: string } | null;
  } | null;
  return {
    gets: httpGets(host.hook.lines).filter((l) => l.method === undefined),
    httpEncoding: live?.http_encoding ?? null,
    listenerSabotage: live?.listener_sabotage ?? null,
    summary: summary?.resources ?? null,
    fetches: applied?.fetches ?? [],
    cacheMode: applied?.cache?.mode ?? null,
    failure: applied?.failure,
    hostDir,
    receiverDir,
  };
}

/** What one leg's 200 GETs must look like for the host's coding `want` ("zstd", "gzip", "off") or
 * a receiver that asked for none (`identityOnly`). A coded line is strictly smaller than the
 * identity body (the host otherwise serves identity); every line carries the pair of fields when
 * the host offers a coding, and none when it is off. */
function codingProblems(
  leg: string,
  e: CodingLegEvidence,
  want: "zstd" | "gzip" | "off",
  identityOnly: boolean,
): { problems: string[]; note: string } {
  const problems: string[] = [];
  const served = e.gets.filter((g) => g.http_status === 200);
  if (e.httpEncoding !== want)
    problems.push(
      `${leg}: live.json http_encoding is ${e.httpEncoding}, expected ${want}`,
    );
  if (served.length < 1) problems.push(`${leg}: the host served no GET`);
  let coded = 0;
  let savedIdentity = 0;
  let savedCoded = 0;
  for (const g of served) {
    const id = (g.hash ?? "").slice(0, 12);
    if (want === "off") {
      if (g.coding !== undefined || g.coded_bytes !== undefined)
        problems.push(`${leg}: ${id} carries a coding though the host is off`);
      continue;
    }
    if (g.coding === undefined || g.coded_bytes === undefined) {
      problems.push(`${leg}: ${id} has no coding/coded_bytes`);
      continue;
    }
    if (identityOnly || g.coding === "identity") {
      if (g.coding !== "identity" || g.coded_bytes !== g.payload_bytes)
        problems.push(
          `${leg}: ${id} was ${g.coding} (${g.coded_bytes} of ${g.payload_bytes} B), expected identity`,
        );
    } else {
      coded++;
      savedIdentity += g.payload_bytes ?? 0;
      savedCoded += g.coded_bytes;
      if (g.coding !== want)
        problems.push(`${leg}: ${id} was ${g.coding}, expected ${want}`);
      if (g.coded_bytes >= (g.payload_bytes ?? 0))
        problems.push(
          `${leg}: ${id} coded ${g.coded_bytes} B is not smaller than ${g.payload_bytes} B`,
        );
    }
  }
  if (!identityOnly && want !== "off" && coded < 1)
    problems.push(`${leg}: no GET went out ${want}-coded`);
  const s = e.summary;
  const sumCoded = served.reduce((n, g) => n + (g.coded_bytes ?? 0), 0);
  if (want !== "off" && s?.http_coded_bytes !== sumCoded)
    problems.push(
      `${leg}: live-summary http_coded_bytes ${s?.http_coded_bytes} != the log's ${sumCoded}`,
    );
  if (want === "off" && s?.http_coded_bytes !== s?.http_bytes)
    problems.push(
      `${leg}: live-summary http_coded_bytes ${s?.http_coded_bytes} != http_bytes ${s?.http_bytes} while off`,
    );
  // The receiver side: every fetch matches the host's account (Content-Length, ETag, coding),
  // and was verified after decoding (getsVsFetches' `verified`).
  if (e.failure === null || e.failure === undefined)
    problems.push(
      ...getsVsFetches(
        e.gets.filter((g) => g.http_status === 200),
        e.fetches,
        e.cacheMode,
      ).map((p) => `${leg}: ${p}`),
    );
  return {
    problems,
    note: `${leg}: ${served.length} GETs, ${coded} ${want}-coded (${savedIdentity} B -> ${savedCoded} B), ${e.fetches.length} receiver fetches`,
  };
}

/** http-content-coding (G8kz): the default host (live-auth) offers zstd and codes the compressible
 * payloads smaller; gzip and off hosts do the same for their codings and nothing; a native
 * receiver that asks for none gets identity; every receiver fetch matches the host's account
 * byte for byte and is verified on the decoded bytes. */
export async function checkHttpContentCoding(
  outDir: string,
  native: boolean,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const notes: string[] = [];
  const cases: Array<[string, "zstd" | "gzip" | "off", boolean]> = [
    ["live-auth", "zstd", false],
    ["coding-gzip", "gzip", false],
    ["coding-off", "off", false],
  ];
  if (native) cases.push(["coding-receiver-off", "zstd", true]);
  for (const [leg, want, identityOnly] of cases) {
    const r = codingProblems(
      leg,
      await loadCodingLeg(outDir, leg),
      want,
      identityOnly,
    );
    problems.push(...r.problems);
    notes.push(r.note);
  }
  return check(
    "http-content-coding",
    "HTTP content coding (G8kz, texture-delivery-design.md D2): the default host (live-auth) answers GRT1 payloads zstd-coded, smaller than the identity body, with per-coding ETags and Content-Length = the logged coded_bytes; GRC_HTTP_ENCODING=gzip codes with gzip and =off logs no coding at all; a native receiver with RS_RECEIVER_ACCEPT_ENCODING=off gets identity; on every one the receiver's fetches match the host's GET log (coding, wire bytes, Content-Length, ETag) and are verified against their hash on the decoded bytes",
    problems,
    notes.join("; "),
    cases.map(([leg]) =>
      join(outDir, leg, "host", "evidence", "resources.jsonl"),
    ),
  );
}

/** corrupt-coded-body (G8kz): the host sent coded bodies with a byte flipped (hook log: coded
 * GETs, the sabotage in live.json) and the receiver refused with one of the typed failures,
 * never applying past the first coded GET. */
export async function checkCorruptCodedBody(outDir: string): Promise<G2bCheck> {
  const leg = "sabotage-corrupt-coded-body";
  const e = await loadCodingLeg(outDir, leg);
  const problems: string[] = [];
  const coded = e.gets.filter(
    (g) =>
      g.http_status === 200 &&
      g.coding !== undefined &&
      g.coding !== "identity",
  );
  if (e.listenerSabotage !== "corrupt-coded-body")
    problems.push(
      `live.json listener_sabotage is ${e.listenerSabotage}, expected corrupt-coded-body`,
    );
  if (coded.length < 1)
    problems.push("the host sent no coded body, so nothing was corrupted");
  const reason = e.failure?.reason ?? "";
  if (
    ![
      "resource-invalid",
      "resource-hash-mismatch",
      "resource-unavailable",
    ].includes(reason)
  )
    problems.push(
      `the receiver's failure is ${JSON.stringify(e.failure ?? null)}, expected a typed refusal of the body`,
    );
  const verified = e.fetches.filter(
    (f) => f.verified === true && f.status === 200,
  );
  const corruptedHashes = new Set<string | null | undefined>(
    coded.map((g) => g.hash),
  );
  for (const f of verified)
    if (corruptedHashes.has(f.hash) && f.content_encoding !== "unknown")
      problems.push(
        `${f.hash?.slice(0, 12)}: a corrupted coded body was verified`,
      );
  return check(
    "corrupt-coded-body",
    "sabotage corrupt-coded-body (G8kz): the host flips one byte of every coded body it sends (identity bytes, hash and ETag stay right), and the receiver refuses it with resource-invalid (the body does not decode), resource-hash-mismatch (it decodes to other bytes) or resource-unavailable (a browser's fetch failed to decode it) instead of applying it",
    problems,
    `${coded.length} coded GET(s) sent corrupted; receiver ${reason} at seq ${e.failure?.seq}`,
    [
      join(e.hostDir, "evidence", "resources.jsonl"),
      join(e.receiverDir, "applied.json"),
    ],
  );
}

export async function runG2e(
  outDir: string,
  expected: Gate2Expected,
): Promise<{ checks: G2bCheck[]; legs: Record<string, G2eLegReport> }> {
  const checks: G2bCheck[] = [];
  const legs: Record<string, G2eLegReport> = {};
  const v7 = isV7(await hostAuthEvidence(outDir, "live-auth"));
  const codingLegs = G2E_CODING_LEGS.filter(
    (l) => !(v7 && l.leg === "coding-receiver-off"),
  );
  for (const e of [
    ...(v7 ? [...G2E_LEGS, ...G2E_V7_LEGS] : G2E_LEGS),
    ...codingLegs,
  ]) {
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
  checks.push(await checkHttpContentCoding(outDir, !v7));
  checks.push(await checkCorruptCodedBody(outDir));
  if (v7) {
    checks.push(await checkOriginRefused(outDir));
    checks.push(await checkNoCors(outDir));
  }
  return { checks, legs };
}
