// CAR3 interop (protocol/carrier-design.md CAR3 "Checks", D2, D13, Q4): one live host, two
// carriers, one scene. capture/build/rs_live_host runs the production Hub over the CarrierSet
// with `ws` (rs_ws) and `wt` (the net module, librender_stream_net.so); a Node WebSocket client
// and the wtransport probe (rs-net/target/release/rs-net-probe) each send a /7 hello and read
// until the host shuts down. Within that one run:
//   - each connection's received bytes equal the hub tap's stream-<n>.rs2 for it, byte for byte
//     (the tap is carrier-blind, so this is the byte-identity witness across carriers);
//   - both connections got the same number of messages, the session record first and the end
//     record last, and the same close code (CLOSE_WEBTRANSPORT_SESSION maps 1:1, Q4.5);
//   - a resource stream (gzip accepted) answers 200 with the served body;
//   - live-carriers.json records both carriers, wt on udp with the certificate's SHA-256.
// Sabotages, each of which must fail its check: a wrong certificate hash (the handshake fails),
// GRC_NET_FAULT=len-off-by-one (the probe's framing check fails), GRC_NET_FAULT=no-drain-close
// (the probe loses the end record the tap holds).
//
// Builds the module and the probe first (scripts/build-rs-net.sh --no-test; a no-op when fresh).
// Usage: mise exec -- pnpm exec tsx --conditions=development \
//          experiments/render-stream/scripts/test/self-test-wt-interop.ts [--keep]
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const RS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = join(RS, "capture/build/rs_live_host");
const MODULE = join(RS, "capture/build/librender_stream_net.so");
const PROBE = join(RS, "rs-net/target/release/rs-net-probe");
const HASH = "1".repeat(64);
const keep = process.argv.includes("--keep");

let failed = 0;
function ok(cond: boolean, what: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
}

function hello7(): string {
  return JSON.stringify({
    type: "hello",
    protocol: "render-stream/7",
    receiver: "wt-interop",
    receiver_kind: "gsw-canvas",
    credit_stage: "submitted",
    credit_window: 1,
    inbound_buffer_bytes: 16777216,
    token: null,
    manifest_sha256: null,
    presentation_backing_w: 640,
    presentation_backing_h: 360,
    presentation_css_w: 640,
    presentation_css_h: 360,
    dpr_milli: 1000,
  });
}

interface Host {
  proc: ChildProcess;
  wsPort: number;
  wtPort: number;
  cert: string;
  exited: Promise<number | null>;
}

async function startHost(dir: string, env: Record<string, string> = {}, extra: string[] = []): Promise<Host> {
  const proc = spawn(
    HOST,
    [
      ...extra,
      "--carriers=ws,wt",
      `--net-module=${MODULE}`,
      `--tap-dir=${join(dir, "tap")}`,
      `--evidence-dir=${dir}`,
      `--summary=${join(dir, "live-summary.json")}`,
    ],
    { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
  const lines = createInterface({ input: proc.stdout! });
  const got: Record<string, string> = {};
  proc.stderr!.on("data", () => {});
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("rs_live_host did not print its ports")), 15000);
    lines.on("line", (l) => {
      const m = /^(RS_LIVE_HOST_[A-Z0-9_]+) (\S+)$/.exec(l);
      if (m) got[m[1]] = m[2];
      if (got.RS_LIVE_HOST_PORT && got.RS_LIVE_HOST_WT_PORT && got.RS_LIVE_HOST_CERT_SHA256) {
        clearTimeout(t);
        res();
      }
    });
    proc.on("exit", (c) => rej(new Error(`rs_live_host exited ${c} before listening`)));
  });
  return {
    proc,
    wsPort: Number(got.RS_LIVE_HOST_PORT),
    wtPort: Number(got.RS_LIVE_HOST_WT_PORT),
    cert: got.RS_LIVE_HOST_CERT_SHA256,
    exited,
  };
}

interface WsResult {
  messages: Uint8Array[];
  close: { code: number; reason: string } | null;
}

function wsClient(port: number): { opened: Promise<void>; done: Promise<WsResult> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/render-stream`, "render-stream.7");
  ws.binaryType = "arraybuffer";
  const messages: Uint8Array[] = [];
  let resolveOpen: () => void = () => {};
  const opened = new Promise<void>((r) => {
    resolveOpen = r;
  });
  const done = new Promise<WsResult>((res) => {
    ws.onopen = () => {
      ws.send(hello7());
      resolveOpen();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") messages.push(new Uint8Array(e.data as ArrayBuffer));
    };
    ws.onclose = (e) => res({ messages, close: { code: e.code, reason: e.reason } });
    ws.onerror = () => {};
  });
  return { opened, done };
}

interface ProbeResult {
  exit: number | null;
  stdout: string;
  summary: {
    messages: number;
    close: { code: number; reason: string } | null;
    framing_error: string | null;
    texts: string[];
    resources: { status?: number; coding?: number; bytes?: number; error?: string }[];
    connect_ms: number;
    first_message_ms: number | null;
  } | null;
  received: Buffer | null;
}

function probe(host: Host, out: string, cert = host.cert): { opened: Promise<boolean>; done: Promise<ProbeResult> } {
  const proc = spawn(
    PROBE,
    [
      "--url",
      `https://127.0.0.1:${host.wtPort}/render-stream?protocol=render-stream.7`,
      "--cert-sha256",
      cert,
      "--out",
      out,
      "--hello",
      hello7(),
      "--fetch",
      `/resources/sha256/${HASH}`,
      "--gzip",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let resolveOpen: (v: boolean) => void = () => {};
  const opened = new Promise<boolean>((r) => {
    resolveOpen = r;
  });
  proc.stdout!.on("data", (d) => {
    stdout += String(d);
    if (stdout.includes("PROBE_OPEN")) resolveOpen(true);
    if (stdout.includes("PROBE_CONNECT_FAILED")) resolveOpen(false);
  });
  proc.stderr!.on("data", () => {});
  const done = new Promise<ProbeResult>((res) =>
    proc.on("exit", (exit) => {
      resolveOpen(false);
      const sp = join(out, "probe.json");
      const rp = join(out, "received.rs2");
      res({
        exit,
        stdout,
        summary: existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : null,
        received: existsSync(rp) ? readFileSync(rp) : null,
      });
    }),
  );
  return { opened, done };
}

/** tap/live-<n>.jsonl's `open` line names the carrier (D13); returns carrier -> tap bytes. */
function tapByCarrier(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const tap = join(dir, "tap");
  if (!existsSync(tap)) return out;
  for (const f of readdirSync(tap)) {
    const m = /^live-(\d+)\.jsonl$/.exec(f);
    if (!m) continue;
    for (const line of readFileSync(join(tap, f), "utf8").split("\n")) {
      if (!line.includes('"open"')) continue;
      const rec = JSON.parse(line) as { carrier?: string; event?: string; type?: string };
      if (rec.carrier) {
        const s = join(tap, `stream-${m[1]}.rs2`);
        out.set(rec.carrier, existsSync(s) ? readFileSync(s) : Buffer.alloc(0));
      }
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function honest(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wt-interop-"));
  try {
    const host = await startHost(dir);
    ok(host.wtPort > 0 && host.cert.length === 64, `host on ws ${host.wsPort} and wt udp ${host.wtPort}`);
    const ws = wsClient(host.wsPort);
    const wt = probe(host, join(dir, "probe"));
    await ws.opened;
    ok(await wt.opened, "the probe's WebTransport session opened");
    await sleep(1500);
    host.proc.kill("SIGTERM");
    const [wsr, pr, code] = await Promise.all([ws.done, wt.done, host.exited]);
    ok(code === 0, `rs_live_host exited 0 (got ${code})`);
    ok(pr.exit === 0 && pr.summary !== null && pr.summary.framing_error === null, "the probe's framing held");
    const taps = tapByCarrier(dir);
    ok(taps.has("ws") && taps.has("wt"), `one tap per carrier (${[...taps.keys()].join(",")})`);
    const wsBytes = Buffer.concat(wsr.messages);
    ok(wsBytes.length > 0 && wsBytes.equals(taps.get("ws") ?? Buffer.alloc(0)), `ws received == tap (${wsBytes.length} bytes)`);
    ok(
      pr.received !== null && pr.received.length > 0 && pr.received.equals(taps.get("wt") ?? Buffer.alloc(1)),
      `wt received == tap (${pr.received?.length ?? 0} bytes)`,
    );
    const n = pr.summary?.messages ?? -1;
    ok(n >= 3 && n === wsr.messages.length, `same message count on both carriers (ws ${wsr.messages.length}, wt ${n})`);
    ok(
      wsr.close !== null && pr.summary?.close?.code === wsr.close.code && pr.summary?.close?.reason === wsr.close.reason,
      `same close on both carriers (ws ${JSON.stringify(wsr.close)}, wt ${JSON.stringify(pr.summary?.close)})`,
    );
    const r = pr.summary?.resources[0];
    ok(r?.status === 200 && r?.coding === 0 && r?.bytes === 1024, `resource stream 200 identity 1024 (got ${JSON.stringify(r)})`);
    const carriers = JSON.parse(readFileSync(join(dir, "live-carriers.json"), "utf8")) as {
      carriers: { name: string; status: string; transport: string; cert_sha256: string | null; sessions: number; resource_gets: number }[];
    };
    const wtc = carriers.carriers.find((c) => c.name === "wt");
    ok(
      wtc?.transport === "udp" && wtc.cert_sha256 === host.cert && wtc.sessions === 1 && wtc.resource_gets === 1,
      `live-carriers.json wt: ${JSON.stringify(wtc)}`,
    );
    ok(readFileSync(join(dir, "live-cert-sha256"), "utf8") === `${host.cert}\n`, "evidence live-cert-sha256");
    console.log(
      `measure: wt connect ${pr.summary?.connect_ms?.toFixed(2)} ms, first message ${pr.summary?.first_message_ms?.toFixed(2)} ms after connect start`,
    );
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
    else console.log(`kept ${dir}`);
  }
}

async function sabotage(
  name: string,
  env: Record<string, string>,
  check: (pr: ProbeResult, tap: Buffer | undefined) => boolean,
  wrongCert = false,
  extra: string[] = [],
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wt-interop-sab-"));
  try {
    const host = await startHost(dir, env, extra);
    const wt = probe(host, join(dir, "probe"), wrongCert ? "0".repeat(64) : host.cert);
    await wt.opened;
    await sleep(800);
    host.proc.kill("SIGTERM");
    const [pr] = await Promise.all([wt.done, host.exited]);
    ok(check(pr, tapByCarrier(dir).get("wt")), `sabotage ${name} fails its check`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const b = spawnSync("bash", [join(RS, "scripts/build-rs-net.sh"), "--no-test"], { stdio: ["ignore", "ignore", "inherit"] });
  if (b.status !== 0 || !existsSync(HOST)) {
    console.error(`self-test-wt-interop: build-rs-net.sh failed (${b.status}) or ${HOST} is missing (build-capture.sh)`);
    process.exit(1);
  }
  await honest();
  await sabotage("wrong-cert-hash", {}, (pr) => pr.exit === 3 && pr.stdout.includes("PROBE_CONNECT_FAILED"), true);
  await sabotage("len-off-by-one", { GRC_NET_FAULT: "len-off-by-one" }, (pr) => pr.exit === 4);
  // The hub's unauthorized answer is a text and a close in one frame callback: the case the
  // drain-before-close rule (Q4.5) exists for. Honest: both arrive, the close as 1008.
  const unauthorized = (pr: ProbeResult) =>
    (pr.summary?.texts ?? []).some((t) => t.includes('"unauthorized"')) && pr.summary?.close?.code === 1008;
  {
    const dir = mkdtempSync(join(tmpdir(), "wt-interop-auth-"));
    try {
      const host = await startHost(dir, {}, [`--token=${"ab".repeat(32)}`]);
      const pr = await probe(host, join(dir, "probe")).done;
      host.proc.kill("SIGTERM");
      await host.exited;
      ok(unauthorized(pr), `a null hello token: the error text, then close 1008 (${JSON.stringify(pr.summary?.close)})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Without the drain the session is closed at once, ahead of the queued text: no capsule ever.
  await sabotage(
    "no-drain-close",
    { GRC_NET_FAULT: "no-drain-close" },
    (pr) => !unauthorized(pr) && pr.summary?.close === null,
    false,
    [`--token=${"ab".repeat(32)}`],
  );
  console.log(failed === 0 ? "self-test-wt-interop: all passed" : `self-test-wt-interop: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
