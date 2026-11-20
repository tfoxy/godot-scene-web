import {
  DirectPeerError,
  openDirectPeer,
  parseFingerprint,
} from "@godot-scene-web/direct-peer";
import { probeWorkerFetch } from "./worker-fetch.mjs";

const query = new URLSearchParams(location.search);
const result = {
  userAgent: navigator.userAgent,
  knobs: Object.fromEntries(query),
  phases: {},
  ok: true,
};
const skip = new Set((query.get("skip") || "").split(","));
const num = (key, fallback) => {
  const value = query.has(key) ? Number(query.get(key)) : fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`invalid ${key}`);
  return value;
};
const timeout = (promise, ms, what) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error(`${what} timeout (${ms} ms)`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
async function phase(name, run) {
  if (skip.has(name)) {
    result.phases[name] = { skipped: true };
    return;
  }
  const start = performance.now();
  try {
    result.phases[name] = {
      ok: true,
      ...(await run()),
      wallMs: performance.now() - start,
    };
  } catch (error) {
    result.ok = false;
    result.phases[name] = {
      ok: false,
      error: String(error),
      wallMs: performance.now() - start,
    };
  }
  document.getElementById("result").textContent = JSON.stringify(
    result,
    null,
    2,
  );
}
function channel(dc, createdMs) {
  // Optional per-channel evidence uses milliseconds since page navigation.
  const trace =
    query.get("trace") === "1"
      ? {
          createdMs,
          openMs: performance.now(),
          id: dc.id,
          messages: 0,
          bytes: 0,
        }
      : undefined;
  if (trace) {
    result.channels ??= [];
    result.channels.push(trace);
  }
  const messages = [],
    waiters = [];
  let failure;
  dc.onmessage = (event) => {
    if (trace) {
      trace.lastMessageMs = performance.now();
      trace.messages++;
      trace.bytes +=
        typeof event.data === "string"
          ? new TextEncoder().encode(event.data).length
          : event.data.byteLength;
      if (typeof event.data === "string") trace.lastText = event.data;
    }
    const next = waiters.shift();
    if (next) next.resolve(event.data);
    else messages.push(event.data);
  };
  const fail = (error) => {
    failure = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  const closed = new Promise((resolve) => {
    dc.onclose = () => {
      if (trace) trace.closeEventMs = performance.now();
      fail(Error("channel closed"));
      resolve();
    };
  });
  dc.onerror = () => fail(Error("channel error"));
  return {
    dc,
    closed,
    next: () =>
      timeout(
        messages.length
          ? Promise.resolve(messages.shift())
          : failure
            ? Promise.reject(failure)
            : new Promise((resolve, reject) =>
                waiters.push({ resolve, reject }),
              ),
        30000,
        "message",
      ),
    close: async () => {
      if (trace) trace.closeRequestMs = performance.now();
      dc.close();
      try {
        await timeout(closed, 10000, "close");
      } catch (error) {
        if (trace) {
          trace.closeTimeoutMs = performance.now();
          trace.readyState = dc.readyState;
        }
        throw error;
      }
    },
  };
}
async function open(peer) {
  const createdMs = performance.now();
  const dc = await timeout(peer.openChannel("couch-tunnel/1"), 15000, "open");
  return channel(dc, createdMs);
}
async function echo(ch, bytes) {
  ch.dc.send(bytes);
  const received = await ch.next();
  if (!(received instanceof ArrayBuffer)) throw Error("echo was not binary");
  const got = new Uint8Array(received);
  if (got.length !== bytes.length || got.some((b, i) => b !== bytes[i]))
    throw Error("echo mismatch");
}
async function get(ch, n, c) {
  const start = performance.now();
  ch.dc.send(JSON.stringify({ t: "get", n, c }));
  let received = 0;
  for (;;) {
    const message = await ch.next();
    if (typeof message === "string") {
      const end = JSON.parse(message);
      if (end.t !== "end" || end.n !== n || received !== n)
        throw Error(`invalid end: ${message}, received=${received}`);
      break;
    }
    const bytes = new Uint8Array(message);
    if (bytes.length !== Math.min(c, n - received))
      throw Error("chunk length mismatch");
    for (let i = 0; i < bytes.length; i++)
      if (bytes[i] !== ((received + i) & 255))
        throw Error("GET pattern mismatch");
    received += bytes.length;
  }
  const ms = performance.now() - start;
  return { bytes: received, chunkBytes: c, ms, MBps: received / 1000 / ms };
}
async function main() {
  let peer;
  try {
    if (query.get("neg") !== "1")
      await phase("workerFetch", () => probeWorkerFetch());
    const host = /^([^:]+):(\d+)$/.exec(query.get("h") || "");
    if (!host)
      throw Error("expected ?h=<LAN IPv4>:<port>&f=<base64url SHA-256>");
    const fp = parseFingerprint(query.get("f") || "");
    const negative = query.get("neg") === "1";
    if (negative) fp[0] ^= 1;
    await phase("connect", async () => {
      const start = performance.now();
      const timeoutMs = negative ? 8000 : 15000;
      try {
        peer = await openDirectPeer({
          host: host[1],
          port: Number(host[2]),
          fingerprint: fp,
          timeoutMs,
        });
      } catch (error) {
        if (
          negative &&
          error instanceof DirectPeerError &&
          ["timeout", "connection-failed"].includes(error.code)
        )
          return { rejected: true, deadlineMs: timeoutMs, code: error.code };
        throw error;
      }
      if (negative) throw Error("wrong fingerprint connected");
      return { ms: performance.now() - start };
    });
    if (query.get("neg") === "1") return;
    if (!peer) return;
    for (const [name, run] of [
      [
        "rtt",
        async () => {
          const ch = await open(peer),
            samples = [];
          try {
            for (let i = 0; i < 200; i++) {
              const start = performance.now();
              await echo(ch, new Uint8Array(1024).fill(i));
              samples.push(performance.now() - start);
            }
          } finally {
            await ch.close();
          }
          samples.sort((a, b) => a - b);
          return {
            count: 200,
            bytes: 1024,
            p50Ms: samples[99],
            p95Ms: samples[189],
            maxMs: samples[199],
          };
        },
      ],
      ...[16384, 65536].map((c) => [
        `get${c}`,
        async () => {
          const ch = await open(peer);
          try {
            return await get(ch, num("get", 8 * 1024 * 1024), c);
          } finally {
            await ch.close();
          }
        },
      ]),
      [
        "sequential",
        async () => {
          const count = num("seq", 2000);
          for (let i = 0; i < count; i++) {
            const ch = await open(peer);
            try {
              await echo(ch, new Uint8Array(64).fill(i & 255));
            } finally {
              await ch.close();
            }
          }
          return { count };
        },
      ],
      [
        "concurrent",
        async () => {
          const count = num("conc", 64);
          const transfers = await Promise.all(
            Array.from({ length: count }, async () => {
              const ch = await open(peer);
              try {
                return await get(ch, 256 * 1024, 16384);
              } finally {
                await ch.close();
              }
            }),
          );
          return {
            count,
            bytes: transfers.reduce((n, t) => n + t.bytes, 0),
          };
        },
      ],
    ])
      await phase(name, run);
    await phase("stats", async () => {
      const ch = await open(peer);
      try {
        ch.dc.send(JSON.stringify({ t: "stats" }));
        const stats = JSON.parse(await ch.next());
        // The probe rejects the package's generic negotiation label; only this channel remains.
        if (stats.t !== "stats" || stats.open !== 1)
          throw Error(`unexpected stats: ${JSON.stringify(stats)}`);
        return stats;
      } finally {
        await ch.close();
      }
    });
    await phase("transport", async () => {
      const transports = [];
      (await peer.connection.getStats()).forEach((s) => {
        if (s.type === "transport")
          transports.push({
            dtlsState: s.dtlsState,
            dtlsCipher: s.dtlsCipher,
            dtlsRole: s.dtlsRole,
            tlsVersion: s.tlsVersion,
            selectedCandidatePairId: s.selectedCandidatePairId,
          });
      });
      return { transports };
    });
  } catch (error) {
    result.ok = false;
    result.phases.setup = { ok: false, error: String(error) };
  } finally {
    peer?.close();
    window.__rtcResult = result;
    document.getElementById("result").textContent = JSON.stringify(
      result,
      null,
      2,
    );
  }
}
main();
