// CAR10: the pieces shared by scripts/test/wt-impaired-chromium.ts (desktop Chromium through
// lib/udp-impair-proxy.ts) and scripts/test/wt-phone-lockstep.ts (Chrome on an adb device over
// Wi-Fi): the rs-net-lockstep host and the page that acks like the client package.
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const RS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT = resolve(RS, "../..");
export const LOCKSTEP = join(RS, "rs-net/target/release/rs-net-lockstep");

/** The client package's WebTransport transport as an IIFE exposing `RSWT`. */
export async function bundleTransport(): Promise<string> {
  const out = await build({
    entryPoints: [
      join(ROOT, "packages/render-stream-client/src/webtransport.ts"),
    ],
    bundle: true,
    format: "iife",
    globalName: "RSWT",
    write: false,
    target: "es2022",
  });
  return out.outputFiles[0].text;
}

export interface PageState {
  opened: boolean;
  received: number;
  acksSent: number;
  lastSeq: number;
  maxGapMs: number;
  wedged: number;
  uniStreams: number;
  close: { code: number; reason: string } | null;
  writes: {
    issued: number;
    resolved: number;
    rejected: number;
    desired: number | null;
  };
}

/** Reads the page's state (call through page.evaluate). */
export function readPageState(): PageState {
  const w = window as unknown as {
    __lockState: Record<string, unknown>;
    __writes: unknown;
  };
  return { ...w.__lockState, writes: w.__writes } as unknown as PageState;
}

/** The page: the client package's WebTransport transport, acking as the client loop does.
 * `window.lockstep(url, certHex, opts)` starts one session; opts: `uplink` ("streams", the
 * default, or "live", the pre-CAR10 path) and `wedge` (per-write probability, 0 = off) with
 * `seed`. The wedge injector models the CAR10 defect of Chrome on Android in any Chromium: once a
 * stream wedges, its writes still resolve, nothing more reaches the wire and its close never
 * settles (for a unidirectional stream the wedging write itself gets through half the time, as
 * the g31 showed). */
export function pageHtml(bundle: string): string {
  return `<!doctype html><meta charset="utf-8"><title>wt lockstep</title><script>
// Diagnostics: every stream write the page issues, and how many settled.
window.__writes = { issued: 0, resolved: 0, rejected: 0, desired: null };
{
  const proto = WritableStreamDefaultWriter.prototype;
  const write = proto.write;
  proto.write = function (chunk) {
    window.__writes.issued++;
    window.__writes.desired = this.desiredSize;
    const p = write.call(this, chunk);
    p.then(() => window.__writes.resolved++, () => window.__writes.rejected++);
    return p;
  };
}
</script><script>${bundle}</script><script>
window.lockstep = (url, certHex, opts) => {
  opts = opts || {};
  const s = { opened: false, received: 0, acksSent: 0, lastSeq: -1, close: null, lastAt: 0, maxGapMs: 0, wedged: 0 };
  window.__lockState = s;
  if (opts.wedge > 0) {
    let a = (opts.seed || 1) >>> 0;
    const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const wrap = (real, uni) => {
      const w = real.getWriter();
      let wedged = false;
      return new WritableStream({
        write(c) {
          if (wedged) return;
          if (rnd() < opts.wedge) { wedged = true; s.wedged++; if (!uni || rnd() < 0.5) return; }
          return w.write(c);
        },
        close() { return wedged ? new Promise(() => {}) : w.close(); },
        abort(r) { return w.abort(r); },
      });
    };
    const bidi = WebTransport.prototype.createBidirectionalStream;
    WebTransport.prototype.createBidirectionalStream = async function (o) {
      const st = await bidi.call(this, o);
      return { readable: st.readable, writable: wrap(st.writable, false) };
    };
    const uni = WebTransport.prototype.createUnidirectionalStream;
    WebTransport.prototype.createUnidirectionalStream = async function (o) { return wrap(await uni.call(this, o), true); };
  }
  {
    // Every uplink stream opened (minus the host's batch count: the re-sends).
    s.uniStreams = 0;
    const open = WebTransport.prototype.createUnidirectionalStream;
    WebTransport.prototype.createUnidirectionalStream = function (o) { s.uniStreams++; return open.call(this, o); };
  }
  const undrawn = [];
  const ack = (seq, stage) => {
    t.send(JSON.stringify({ type: "ack", stream_id: "0123456789abcdef0123456789abcdef", seq, stage, t_us: Math.round(performance.now() * 1000) }));
    s.acksSent++;
  };
  const factory = RSWT.createWebTransportTransport({ cacheBytes: 0, uplink: opts.uplink || "streams" });
  const t = factory(
    { url: "ws://127.0.0.1:1/unused", resourceBase: null, token: null, protocol: "render-stream/13", webTransport: { url, certificateHashes: [certHex] } },
    "render-stream.13",
    {
      open() {
        s.opened = true;
        t.send(JSON.stringify({ type: "hello", protocol: "render-stream/13", credit_window: 2, credit_stage: "applied" }));
      },
      message(d) {
        if (typeof d === "string") return;
        const seq = new DataView(d).getUint32(0, true);
        const now = performance.now();
        if (s.lastAt) s.maxGapMs = Math.max(s.maxGapMs, now - s.lastAt);
        s.lastAt = now; s.received++; s.lastSeq = seq;
        ack(seq, "received");
        ack(seq, "applied");
        undrawn.push(seq);
      },
      close(code, reason) { s.close = { code, reason }; },
    },
  );
  const frame = () => { while (undrawn.length) ack(undrawn.shift(), "submitted"); if (!s.close) requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  return true;
};
</script>`;
}

export interface LockstepResult {
  ok: boolean;
  why: string;
  sent: number;
  credited: number;
  texts: number;
  seconds: number;
  credits_per_s: number;
}

export async function runHost(
  messages: number,
  log: string[],
  extra: string[] = [],
): Promise<{
  proc: ChildProcess;
  port: number;
  cert: string;
  result: Promise<LockstepResult | null>;
}> {
  const proc = spawn(LOCKSTEP, ["--messages", String(messages), ...extra], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  createInterface({ input: proc.stderr! }).on("line", (l) => log.push(l));
  const got: Record<string, string> = {};
  let resolveResult: (r: LockstepResult | null) => void = () => {};
  const result = new Promise<LockstepResult | null>((r) => {
    resolveResult = r;
  });
  proc.on("exit", () => resolveResult(null));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(
      () => rej(new Error("rs-net-lockstep did not print its port")),
      15000,
    );
    createInterface({ input: proc.stdout! }).on("line", (l) => {
      const m = /^(LOCKSTEP_[A-Z]+) (.+)$/.exec(l);
      if (!m) return;
      got[m[1]] = m[2];
      if (m[1] === "LOCKSTEP_PROGRESS") log.push(l);
      if (m[1] === "LOCKSTEP_RESULT")
        resolveResult(JSON.parse(m[2]) as LockstepResult);
      if (got.LOCKSTEP_PORT && got.LOCKSTEP_CERT && m[1] === "LOCKSTEP_CERT") {
        clearTimeout(t);
        res();
      }
    });
  });
  return {
    proc,
    port: Number(got.LOCKSTEP_PORT),
    cert: got.LOCKSTEP_CERT,
    result,
  };
}
