// G7n's interop checks (gate7-design.md "G7n", Q2, Q3, D2, D3, D4), driven by self-test-rs-ws.ts:
// the render-stream/7 live listener -- two subprotocols on one listener, the hello token, the
// Origin allowlist and CORS -- against a real host over loopback.
//
// Two hosts are supported, with the same checks:
//   - "live-host": capture/build/rs_live_host, the production rs_ws listener and rs_live hub
//     around a fixed one-item scene (no engine; seconds per run; the default).
//   - "capture": the real capture library in a headless Godot 4.5.1 release template on
//     fixtures/gate1 (self-test-rs-ws.ts --capture). This also covers entry.cpp's wiring: the
//     environment (GRC_LIVE_ALLOWED_ORIGINS, GRC_LIVE_CREDIT_WINDOW_MAX, GRC_LIVE_AUTH=token and its
//     evidence/live-token, the GRC_SABOTAGE listener sabotages), evidence/live.json,
//     evidence/live-summary.json, stdout.log's `live: 403 origin ...` lines and the hook log's
//     preflight line. Headless only: nothing is rendered, so no gamescope is involved.
//
// Every host is launched with every inherited GRC_* and RS_* variable stripped (the runners'
// GS_STRIP_VARS rule), and the capture host also without DISPLAY / WAYLAND_DISPLAY.
//
// Checks (named, so a sabotage's failing set is compared exactly):
//   both-versions        a /6 and a /7 WebSocket open on one listener at once; offering both
//                        subprotocols chooses /7; each stream validates as its own version (GRS6 /
//                        GRS7, ending with its end record); the /7 session declares
//                        publication.credit_window 1 for a hello asking 2 under
//                        GRC_LIVE_CREDIT_WINDOW_MAX=2; live-summary.json records both versions.
// and, on a bearer host (GRC_LIVE_AUTH=token / --token) with an Origin allowlist:
//   v7-upgrade-without-bearer, v6-upgrade-keeps-bearer, token-right, token-wrong, token-null,
//   origin-403-upgrade, origin-403-get, origin-403-options, origin-allowed-upgrade, cors-get,
//   preflight-exact, origin-403-logged, preflight-counted, summary-versions, summary-token,
//   summary-no-token, and on the capture host also live-json, wire-no-sabotage and
//   preflight-hooklog.
// Sabotages: the bearer checks run again on hosts with each listener sabotage and must fail
// exactly: token-ignored {summary-token, token-null, token-wrong}; accept-any-origin
// {origin-403-get, origin-403-logged, origin-403-options, origin-403-upgrade}; no-cors {cors-get,
// preflight-exact}.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { validateResourceLine } from "../lib/gate2-checks";
import { decodeRecording, validateRecording } from "../lib/render-stream-2";

type Ok = (condition: boolean, what: string) => void;

const ORIGIN = "http://127.0.0.1:5173";
const FOREIGN = "http://evil.example:80";
const HASH = "1".repeat(64); // rs_live_host's one servable resource; unknown to the capture

export interface CapturePaths {
  binary: string;
  extension: string;
  calibration: string;
  fixtureDir: string;
  /** Keep each capture host's directory here (evidence, stdout.log); a temp dir otherwise. */
  outDir?: string;
}

export function defaultCapturePaths(experimentDir: string): CapturePaths {
  return {
    binary:
      process.env.RS_G7N_BINARY ??
      join(
        homedir(),
        ".cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64",
      ),
    extension:
      process.env.RS_G7N_EXTENSION ??
      join(experimentDir, "capture/build/render_stream_capture.gdextension"),
    calibration:
      process.env.RS_G7N_CALIBRATION ??
      join(experimentDir, "calibration/godot-4.5.1-stable-linux-release.json"),
    fixtureDir: join(experimentDir, "fixtures/gate1"),
    outDir: process.env.RS_G7N_OUT,
  };
}

export type HostSpec =
  | { kind: "live-host"; binary: string }
  | { kind: "capture"; paths: CapturePaths };

interface LiveSummary {
  connections: Array<Record<string, unknown>>;
  resources?: Record<string, unknown>;
}

interface Host {
  port: number;
  token: string | null;
  /** The status a GET of HASH answers with the right bearer token (200 live-host, 404 capture). */
  getStatus: number;
  output: () => string;
  stop: () => Promise<void>;
  summary: () => LiveSummary | null;
  liveJson: () => Record<string, unknown> | null;
  hookLog: () => string | null;
  cleanup: () => void;
}

interface HostOptions {
  bearer: boolean;
  sabotage: string | null;
  creditWindowMax?: number;
  maxConnections: number;
  label: string;
}

function strippedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(GRC|RS)_/.test(k)) out[k] = v;
  }
  return out;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

const LIVE_HOST_TOKEN = "c".repeat(64);

async function startHost(spec: HostSpec, opts: HostOptions): Promise<Host> {
  const env = strippedEnv();
  if (opts.sabotage !== null) env.GRC_SABOTAGE = opts.sabotage;
  if (opts.creditWindowMax !== undefined)
    env.GRC_LIVE_CREDIT_WINDOW_MAX = String(opts.creditWindowMax);
  if (opts.bearer) env.GRC_LIVE_ALLOWED_ORIGINS = ORIGIN;
  const keep = spec.kind === "capture" && spec.paths.outDir !== undefined;
  const base = keep
    ? (spec as { paths: CapturePaths }).paths.outDir!
    : tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = keep
    ? join(base, opts.label)
    : mkdtempSync(join(base, "rs-ws-g7n-"));
  mkdirSync(dir, { recursive: true });
  const evidence = join(dir, "evidence");
  let args: string[];
  let binary: string;
  if (spec.kind === "live-host") {
    binary = spec.binary;
    args = [
      "--port=0",
      `--summary=${join(dir, "live-summary.json")}`,
      `--max-clients=${opts.maxConnections}`,
    ];
    if (opts.bearer) args.push(`--token=${LIVE_HOST_TOKEN}`);
  } else {
    binary = spec.paths.binary;
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    mkdirSync(evidence, { recursive: true });
    Object.assign(env, {
      GRC_EXTENSION: spec.paths.extension,
      GRC_CALIBRATION: spec.paths.calibration,
      GRC_MODE: "arm",
      GRC_EVIDENCE_DIR: evidence,
      GRC_ROOT_SIZE: "enforce-min-size",
      GRC_LIVE_LISTEN: "127.0.0.1:0",
      GRC_LIVE_TAP_DIR: join(dir, "tap"),
      GRC_LIVE_MAX_CONNECTIONS: String(opts.maxConnections),
      // fixtures/gate1 quits at this frame; every check finishes well before it (--max-fps 60).
      RS_FIXTURE_QUIT_FRAME: "900",
      RS_FIXTURE_STEP_LOG: join(dir, "steps.jsonl"),
    });
    if (opts.bearer) env.GRC_LIVE_AUTH = "token";
    args = ["--headless", "--max-fps", "60", "--path", spec.paths.fixtureDir];
  }
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  let done = false;
  const exited = new Promise<void>((res) =>
    child.on("exit", () => {
      done = true;
      res();
    }),
  );
  let port = 0;
  let token: string | null = null;
  if (spec.kind === "live-host") {
    await waitFor(() => /RS_LIVE_HOST_PORT (\d+)/.test(out) || done, 5000);
    port = Number(out.match(/RS_LIVE_HOST_PORT (\d+)/)?.[1] ?? 0);
    token = opts.bearer ? LIVE_HOST_TOKEN : null;
  } else {
    const liveJson = join(evidence, "live.json");
    await waitFor(
      () =>
        done || readJson<{ status?: string }>(liveJson)?.status !== undefined,
      30000,
    );
    const live = readJson<{ status: string; port: number | null }>(liveJson);
    port = live?.status === "listening" && live.port !== null ? live.port : 0;
    if (opts.bearer && port !== 0)
      token = readFileSync(join(evidence, "live-token"), "utf8").trim();
  }
  const stop = async () => {
    if (spec.kind === "live-host") child.kill("SIGTERM");
    // The capture host quits by itself at RS_FIXTURE_QUIT_FRAME (its end records, linger and
    // live-summary.json are the normal shutdown path).
    const timeout = spec.kind === "live-host" ? 8000 : 40000;
    await Promise.race([exited, new Promise((r) => setTimeout(r, timeout))]);
    if (!done) {
      child.kill("SIGKILL");
      await exited;
    }
    if (keep) writeFileSync(join(dir, "stdout.log"), out);
  };
  if (port === 0) {
    await stop();
    throw new Error(
      `${opts.label}: the host never listened:\n${out.slice(-2000)}`,
    );
  }
  const summaryPath =
    spec.kind === "live-host"
      ? join(dir, "live-summary.json")
      : join(evidence, "live-summary.json");
  return {
    port,
    token,
    getStatus: spec.kind === "live-host" ? 200 : 404,
    output: () => out,
    stop,
    summary: () => readJson<LiveSummary>(summaryPath),
    liveJson: () =>
      spec.kind === "capture"
        ? readJson<Record<string, unknown>>(join(evidence, "live.json"))
        : null,
    hookLog: () => {
      const path = join(evidence, "resources.jsonl");
      return spec.kind === "capture" && existsSync(path)
        ? readFileSync(path, "utf8")
        : null;
    },
    cleanup: () => {
      if (!keep) rmSync(dir, { recursive: true, force: true });
    },
  };
}

function hello6(): string {
  return JSON.stringify({
    type: "hello",
    protocol: "render-stream/6",
    receiver: "node-self-test",
    credit_stage: "submitted",
    inbound_buffer_bytes: 16777216,
  });
}

function hello7(token: string | null, creditWindow = 1): string {
  return JSON.stringify({
    type: "hello",
    protocol: "render-stream/7",
    receiver: "node-self-test",
    receiver_kind: "gsw-canvas",
    credit_stage: "submitted",
    credit_window: creditWindow,
    inbound_buffer_bytes: 16777216,
    token,
    manifest_sha256: null,
    presentation_backing_w: 640,
    presentation_backing_h: 360,
    presentation_css_w: 640,
    presentation_css_h: 360,
    dpr_milli: 1000,
  });
}

interface RawResponse {
  status: number;
  upgraded: boolean;
  /** Every response header, lowercased name and value, in the order sent. */
  headers: [string, string][];
}

// One request on its own connection with Node's raw `http` (the only way to put an Origin, or
// any header, on an upgrade from Node). A 101 is reported as `upgraded`, and the socket dropped.
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<RawResponse> {
  const pairs = (raw: string[]): [string, string][] => {
    const out: [string, string][] = [];
    for (let i = 0; i + 1 < raw.length; i += 2)
      out.push([raw[i].toLowerCase(), raw[i + 1]]);
    return out;
  };
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method, headers, agent: false },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            upgraded: false,
            headers: pairs(res.rawHeaders),
          }),
        );
      },
    );
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolvePromise({
        status: res.statusCode ?? 0,
        upgraded: true,
        headers: pairs(res.rawHeaders),
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function upgradeHeaders(
  subprotocols: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Protocol": subprotocols,
    ...extra,
  };
}

function header(r: RawResponse, name: string): string | undefined {
  return r.headers.find(([k]) => k === name)?.[1];
}

/** A WebSocket client that records everything it receives (Node's WebSocket sends no Origin). */
class WsClient {
  readonly ws: WebSocket;
  readonly texts: string[] = [];
  readonly binary: Uint8Array[] = [];
  readonly opened: Promise<boolean>;
  readonly closed: Promise<{ code: number; reason: string }>;
  private isClosed = false;
  constructor(port: number, protocols: string[]) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/render-stream`, protocols);
    this.ws.binaryType = "arraybuffer";
    this.opened = new Promise((res) => {
      this.ws.addEventListener("open", () => res(true), { once: true });
      this.ws.addEventListener("error", () => res(false), { once: true });
    });
    this.closed = new Promise((res) => {
      this.ws.addEventListener(
        "close",
        (e) => {
          this.isClosed = true;
          res({
            code: (e as CloseEvent).code,
            reason: (e as CloseEvent).reason,
          });
        },
        { once: true },
      );
    });
    this.ws.addEventListener("message", (e) => {
      const data = (e as MessageEvent).data;
      if (typeof data === "string") this.texts.push(data);
      else this.binary.push(new Uint8Array(data as ArrayBuffer));
    });
  }
  /** Resolves once `n` binary messages arrived or the socket closed, or after `ms`. */
  async waitBinary(n: number, ms = 5000): Promise<void> {
    await waitFor(() => this.binary.length >= n || this.isClosed, ms);
  }
  async closeAndWait(
    ms = 3000,
  ): Promise<{ code: number; reason: string } | null> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, "done");
    return Promise.race([
      this.closed,
      new Promise<null>((r) => setTimeout(() => r(null), ms)),
    ]);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.binary.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of this.binary) {
      out.set(b, at);
      at += b.length;
    }
    return out;
  }
}

const MAGIC6 = [0x47, 0x52, 0x53, 0x36, 0x0d, 0x0a, 0x1a, 0x0a];
const MAGIC7 = [0x47, 0x52, 0x53, 0x37, 0x0d, 0x0a, 0x1a, 0x0a];
function startsWith(bytes: Uint8Array | undefined, magic: number[]): boolean {
  return bytes !== undefined && magic.every((b, i) => bytes[i] === b);
}

/** "/6 and /7 on one listener at once", on a host with no token. */
async function testBothVersions(
  spec: HostSpec,
  ok: Ok,
  tag: string,
): Promise<void> {
  const host = await startHost(spec, {
    bearer: false,
    sabotage: null,
    creditWindowMax: 2,
    maxConnections: 2,
    label: "both-versions",
  });
  try {
    const c6 = new WsClient(host.port, ["render-stream.6"]);
    const c7 = new WsClient(host.port, ["render-stream.6", "render-stream.7"]);
    const [o6, o7] = await Promise.all([c6.opened, c7.opened]);
    ok(
      o6 && o7,
      `${tag} both-versions: a /6 and a /7 WebSocket are open on one listener at once`,
    );
    ok(
      c6.ws.protocol === "render-stream.6" &&
        c7.ws.protocol === "render-stream.7",
      `${tag} both-versions: /6 alone -> ${c6.ws.protocol}, both offered -> ${c7.ws.protocol}`,
    );
    c6.ws.send(hello6());
    c7.ws.send(hello7(null, 2));
    await Promise.all([c6.waitBinary(2), c7.waitBinary(2)]);
    ok(
      c6.binary.length >= 2 && c7.binary.length >= 2,
      `${tag} both-versions: each gets its session and seq 1 (${c6.binary.length}, ${c7.binary.length})`,
    );
    // Shutdown: the host sends each its end record and closes after the linger.
    await host.stop();
    await Promise.all([c6.closeAndWait(), c7.closeAndWait()]);
    const b6 = c6.bytes();
    const b7 = c7.bytes();
    ok(
      startsWith(b6, MAGIC6) && startsWith(b7, MAGIC7),
      `${tag} both-versions: GRS6 on /6, GRS7 on /7`,
    );
    const e6 = validateRecording(b6, 6);
    const e7 = validateRecording(b7, 7);
    ok(
      e6.length === 0,
      `${tag} both-versions: the /6 bytes validate as render-stream/6 ${e6.join("; ")}`,
    );
    ok(
      e7.length === 0,
      `${tag} both-versions: the /7 bytes validate as render-stream/7 ${e7.join("; ")}`,
    );
    if (e6.length === 0 && e7.length === 0) {
      const d6 = decodeRecording(b6, 6);
      const d7 = decodeRecording(b7, 7);
      const s7 = d7.records[0].meta as unknown as {
        protocol: string;
        publication: { credit_window: number };
      };
      const last = (d: typeof d7) =>
        (d.records[d.records.length - 1].meta as unknown as { type: string })
          .type;
      ok(
        s7.protocol === "render-stream/7" && s7.publication.credit_window === 1,
        `${tag} both-versions: the /7 session declares credit_window ${s7.publication.credit_window} for a hello asking 2 (GRC_LIVE_CREDIT_WINDOW_MAX=2; host window 1 before G7q)`,
      );
      ok(
        last(d6) === "end" && last(d7) === "end",
        `${tag} both-versions: both streams end with their end record`,
      );
    }
    const summary = host.summary();
    const versions = (summary?.connections ?? []).map((c) => c.version).sort();
    const v7 = summary?.connections.find((c) => c.version === 7);
    ok(
      versions.join(",") === "6,7" &&
        v7?.receiver_kind === "gsw-canvas" &&
        v7?.credit_window === 1 &&
        v7?.credit_window_requested === 2 &&
        v7?.presentation_backing_w === 640 &&
        v7?.token_ok === null,
      `${tag} both-versions: live-summary.json versions [${versions}] and the /7 hello's fields`,
    );
  } finally {
    await host.stop();
    host.cleanup();
  }
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** The bearer-host checks, named so a sabotage's failing set can be compared. */
async function runBearerChecks(
  spec: HostSpec,
  sabotage: string | null,
): Promise<Check[]> {
  const host = await startHost(spec, {
    bearer: true,
    sabotage,
    maxConnections: 4,
    label: `bearer-${sabotage ?? "honest"}`,
  });
  const token = host.token ?? "";
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) =>
    checks.push({ name, pass, detail });
  const resource = `/resources/sha256/${HASH}`;
  const bearer = { Authorization: `Bearer ${token}` };
  let preflights204 = 0;
  let sessionMeta: Record<string, unknown> | null = null;
  try {
    // --- upgrades: /7 carries its token in the hello, /6 keeps the bearer header -------------
    const up7 = await rawRequest(
      host.port,
      "GET",
      "/render-stream",
      upgradeHeaders("render-stream.7"),
    );
    add(
      "v7-upgrade-without-bearer",
      up7.upgraded && up7.status === 101,
      `status ${up7.status}`,
    );
    const up6 = await rawRequest(
      host.port,
      "GET",
      "/render-stream",
      upgradeHeaders("render-stream.6"),
    );
    add(
      "v6-upgrade-keeps-bearer",
      !up6.upgraded && up6.status === 401,
      `status ${up6.status}`,
    );

    // --- the /7 hello token --------------------------------------------------------------------
    const right = new WsClient(host.port, ["render-stream.7"]);
    await right.opened;
    right.ws.send(hello7(token));
    await right.waitBinary(2);
    add(
      "token-right",
      right.binary.length >= 2 &&
        startsWith(right.binary[0], MAGIC7) &&
        right.texts.length === 0,
      `${right.binary.length} binary, ${right.texts.length} text`,
    );
    if (right.binary.length > 0) {
      try {
        const head = decodeRecording(right.binary[0], 7);
        sessionMeta = head.records[0].meta as unknown as Record<
          string,
          unknown
        >;
      } catch {
        sessionMeta = null;
      }
    }
    await right.closeAndWait();
    for (const [name, wrong] of [
      ["token-wrong", "f".repeat(64)],
      ["token-null", null],
    ] as const) {
      const c = new WsClient(host.port, ["render-stream.7"]);
      await c.opened;
      c.ws.send(hello7(wrong));
      await c.waitBinary(2, 3000);
      const closed = await c.closeAndWait();
      const errors = c.texts.map(
        (t) => JSON.parse(t) as { type: string; reason: string },
      );
      add(
        name,
        c.binary.length === 0 &&
          errors.length === 1 &&
          errors[0].type === "error" &&
          errors[0].reason === "unauthorized" &&
          closed?.code === 1008 &&
          closed?.reason === "unauthorized",
        `${c.binary.length} binary, texts ${JSON.stringify(c.texts)}, close ${closed?.code} "${closed?.reason}"`,
      );
    }

    // --- Origin: 403 on all three routes for a foreign one; an allowed upgrade is unchanged ----
    const fUp = await rawRequest(
      host.port,
      "GET",
      "/render-stream",
      upgradeHeaders("render-stream.7", { Origin: FOREIGN }),
    );
    add(
      "origin-403-upgrade",
      !fUp.upgraded && fUp.status === 403,
      `status ${fUp.status}`,
    );
    const fGet = await rawRequest(host.port, "GET", resource, {
      ...bearer,
      Origin: FOREIGN,
    });
    add("origin-403-get", fGet.status === 403, `status ${fGet.status}`);
    const fOpt = await rawRequest(host.port, "OPTIONS", resource, {
      Origin: FOREIGN,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization",
    });
    if (fOpt.status === 204) preflights204++;
    add("origin-403-options", fOpt.status === 403, `status ${fOpt.status}`);
    const aUp = await rawRequest(
      host.port,
      "GET",
      "/render-stream",
      upgradeHeaders("render-stream.7", { Origin: ORIGIN }),
    );
    add(
      "origin-allowed-upgrade",
      aUp.upgraded &&
        aUp.status === 101 &&
        !aUp.headers.some(([k]) => k.startsWith("access-control-")),
      `status ${aUp.status}`,
    );

    // --- CORS on GET, and the preflight ---------------------------------------------------------
    const aGet = await rawRequest(host.port, "GET", resource, {
      ...bearer,
      Origin: ORIGIN,
    });
    const plainGet = await rawRequest(host.port, "GET", resource, bearer);
    add(
      "cors-get",
      aGet.status === host.getStatus &&
        header(aGet, "access-control-allow-origin") === ORIGIN &&
        header(aGet, "vary") === "Origin" &&
        plainGet.status === host.getStatus &&
        header(plainGet, "access-control-allow-origin") === undefined &&
        header(plainGet, "vary") === undefined,
      `allowed: ${aGet.status} ACAO ${header(aGet, "access-control-allow-origin")} Vary ${header(aGet, "vary")}; no Origin: ${plainGet.status} ACAO ${header(plainGet, "access-control-allow-origin")}`,
    );
    const pre = await rawRequest(host.port, "OPTIONS", resource, {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization",
    });
    if (pre.status === 204) preflights204++;
    // Exactly these, in this order (Connection aside: it answers the request's own).
    const want: [string, string][] = [
      ["access-control-allow-origin", ORIGIN],
      ["access-control-allow-methods", "GET"],
      ["access-control-allow-headers", "authorization"],
      ["access-control-max-age", "7200"],
      ["vary", "Origin"],
    ];
    add(
      "preflight-exact",
      pre.status === 204 &&
        JSON.stringify(pre.headers.filter(([k]) => k !== "connection")) ===
          JSON.stringify(want),
      `${pre.status} ${JSON.stringify(pre.headers)}`,
    );
  } finally {
    await host.stop();
  }

  // --- the host's own evidence, after its shutdown ----------------------------------------------
  const log = host.output();
  const logged403 = log
    .split("\n")
    .filter((l) => l.includes(`live: 403 origin ${FOREIGN} `));
  const summary = host.summary() ?? { connections: [] };
  add(
    "origin-403-logged",
    logged403.length === 3 && summary.resources?.origin_rejected === 3,
    `${logged403.length} log lines, origin_rejected ${summary.resources?.origin_rejected}`,
  );
  add(
    "preflight-counted",
    summary.resources?.preflights === preflights204,
    `preflights ${summary.resources?.preflights}, 204s answered ${preflights204}`,
  );
  const conns = summary.connections;
  add(
    "summary-versions",
    conns.length > 0 &&
      conns.every((c) => c.version === 7) &&
      conns.some((c) => c.origin === ORIGIN) &&
      conns.some(
        (c) => c.token_ok === true && c.receiver_kind === "gsw-canvas",
      ),
    `${conns.length} connections: ${JSON.stringify(conns.map((c) => [c.version, c.origin, c.token_ok]))}`,
  );
  const refused = conns.filter((c) => c.token_ok === false);
  add(
    "summary-token",
    refused.length === 2 &&
      refused.every(
        (c) =>
          c.close_code === 1008 &&
          c.error_sent === "unauthorized" &&
          c.sent === 0,
      ),
    `${refused.length} token_ok:false, closes ${refused.map((c) => c.close_code)}`,
  );
  add(
    "summary-no-token",
    token.length === 64 &&
      conns.length > 0 &&
      !JSON.stringify(summary).includes(token) &&
      !log.includes(token),
    "the token reaches neither the summary nor the host's log",
  );
  if (spec.kind === "capture") {
    const live = host.liveJson();
    add(
      "live-json",
      live !== null &&
        JSON.stringify(live.allowed_origins) === JSON.stringify([ORIGIN]) &&
        live.credit_window_max === 1 &&
        live.listener_sabotage === sabotage,
      JSON.stringify(live),
    );
    add(
      "wire-no-sabotage",
      sessionMeta !== null &&
        sessionMeta.sabotage === null &&
        (sessionMeta.resources as { auth?: string } | undefined)?.auth ===
          "bearer",
      `session sabotage ${JSON.stringify(sessionMeta?.sabotage)}`,
    );
    const lines = (host.hookLog() ?? "")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const preflightLines = lines.filter(
      (l) => l.op === "http-get" && l.method === "OPTIONS",
    );
    const getLines = lines.filter(
      (l) => l.op === "http-get" && l.method === undefined,
    );
    const invalid = lines
      .map((l) => validateResourceLine(l))
      .filter((e) => e !== null);
    add(
      "preflight-hooklog",
      host.hookLog() !== null &&
        invalid.length === 0 &&
        preflightLines.length === preflights204 &&
        preflightLines.every((l) => l.http_status === 204) &&
        getLines.length >= 2,
      `${preflightLines.length} OPTIONS lines (want ${preflights204}), ${getLines.length} GET lines, ${invalid.length} invalid lines ${invalid.slice(0, 2).join("; ")}`,
    );
  }
  host.cleanup();
  return checks;
}

export async function testG7n(spec: HostSpec, ok: Ok): Promise<void> {
  const tag = spec.kind === "live-host" ? "G7n" : "G7n@capture";
  const binary = spec.kind === "live-host" ? spec.binary : spec.paths.binary;
  if (!existsSync(binary)) {
    ok(false, `${tag}: ${binary} exists (run scripts/build-capture.sh)`);
    return;
  }
  if (spec.kind === "capture") {
    for (const p of [spec.paths.extension, spec.paths.calibration]) {
      if (!existsSync(p)) {
        ok(false, `${tag}: ${p} exists`);
        return;
      }
    }
    if (!existsSync(join(spec.paths.fixtureDir, ".godot"))) {
      ok(
        false,
        `${tag}: ${spec.paths.fixtureDir} has been imported (.godot; run gate 1 or --import it once)`,
      );
      return;
    }
  }
  await testBothVersions(spec, ok, tag);

  for (const c of await runBearerChecks(spec, null))
    ok(c.pass, `${tag} ${c.name}: ${c.detail}`);

  // G7n "Sabotages": each listener sabotage fails exactly its predicted checks and nothing else.
  const predicted: Record<string, string[]> = {
    "token-ignored": ["summary-token", "token-null", "token-wrong"],
    "accept-any-origin": [
      "origin-403-get",
      "origin-403-logged",
      "origin-403-options",
      "origin-403-upgrade",
    ],
    "no-cors": ["cors-get", "preflight-exact"],
  };
  for (const [sabotage, want] of Object.entries(predicted)) {
    const results = await runBearerChecks(spec, sabotage);
    const failed = results
      .filter((c) => !c.pass)
      .map((c) => c.name)
      .sort();
    ok(
      failed.join(",") === want.join(","),
      `${tag} sabotage ${sabotage} fails exactly [${want.join(", ")}] (failed [${failed.join(", ")}])`,
    );
  }
}
