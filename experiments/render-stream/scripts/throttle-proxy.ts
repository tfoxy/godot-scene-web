#!/usr/bin/env -S pnpm exec tsx --conditions=development

// A runner-side TCP proxy that constrains the transport between a receiver and the host's single
// listener (D12, Q7d `constrained` leg, ../protocol/gate6-design.md). Node standard library only
// (`node:net`), so it needs no root and sits in front of both the WebSocket and every HTTP fetch
// without being protocol-aware: it is an L4 byte-stream shaper, not an HTTP or WebSocket proxy.
//
// Per direction (client -> server, server -> client) it applies:
//   1. A fixed one-way delay: a byte that arrives at time T cannot leave before T + delayMs.
//   2. A token bucket (capacity `burstBytes`, refill `rateBytesPerSec`/s): bytes can only leave
//      once the bucket holds enough tokens, so sustained throughput is capped at the configured
//      rate however bursty the source is.
// The two constraints combine as "whichever makes a byte wait longest": `DirectionShaper` always
// waits out the delay floor first, then the token bucket, in a loop (a chunk arriving while the
// bucket is still refilling for an earlier chunk waits behind it, FIFO, one shaper per direction).
//
// Profile `constrained` (D12): 500_000 B/s (4 Mbit/s) per direction, 64 KiB burst, 30 ms delay.
// `unlimited` is a passthrough (rate 0 means "no limit" here, not "stalled") used by the proxy's
// own self-test as a baseline and by anything that wants the stats.json bookkeeping without the
// shaping.
//
// CLI:
//   mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/throttle-proxy.ts \
//     --target-host 127.0.0.1 --target-port <port> [--listen-port <port>] \
//     [--profile constrained|unlimited] [--rate-bytes-per-s N] [--burst-bytes N] [--delay-ms N] \
//     [--duration-s N] [--stats-out <file>]
// Prints `{"listening_port":<port>}` as its first stdout line once bound, so a parent process
// that asked for an ephemeral port (`--listen-port 0`, the default) can read it back. Stops and
// writes `--stats-out` (default stdout) on SIGINT/SIGTERM, or after `--duration-s` if given.

import { writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";

export interface ThrottleProfile {
  rateBytesPerSec: number; // 0 = unlimited
  burstBytes: number;
  delayMs: number;
}

export const THROTTLE_PROFILES: Record<string, ThrottleProfile> = {
  constrained: { rateBytesPerSec: 500_000, burstBytes: 65_536, delayMs: 30 },
  unlimited: { rateBytesPerSec: 0, burstBytes: 0, delayMs: 0 },
};

const SUBCHUNK_BYTES = 8192;

// ----------------------------------------------------------------------------------- token bucket

class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly ratePerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    if (this.ratePerSec <= 0) return;
    const now = Date.now();
    const elapsedS = (now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedS * this.ratePerSec,
    );
    this.lastRefillMs = now;
  }

  tryTake(n: number): boolean {
    if (this.ratePerSec <= 0) return true;
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Milliseconds until `n` tokens will be available, assuming no other consumer. 0 when
   * unlimited or already available. */
  msUntil(n: number): number {
    if (this.ratePerSec <= 0) return 0;
    this.refill();
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.ratePerSec) * 1000);
  }
}

// -------------------------------------------------------------------------------- latency stats

interface RunningStats {
  count: number;
  sum: number;
  min: number;
  max: number;
}

function newRunningStats(): RunningStats {
  return { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0 };
}

function record(stats: RunningStats, value: number): void {
  stats.count++;
  stats.sum += value;
  stats.min = Math.min(stats.min, value);
  stats.max = Math.max(stats.max, value);
}

function summarize(stats: RunningStats): {
  count: number;
  mean_ms: number;
  min_ms: number;
  max_ms: number;
} {
  return {
    count: stats.count,
    mean_ms: stats.count > 0 ? stats.sum / stats.count : 0,
    min_ms: stats.count > 0 ? stats.min : 0,
    max_ms: stats.max,
  };
}

// ---------------------------------------------------------------------------------- direction shaper

/** Forwards chunks from one socket to another, FIFO, honoring a fixed one-way delay plus a
 * shared token bucket. One instance per direction per connection; the bucket may be shared
 * across every connection of a direction (the proxy constrains the LINK, not each stream), which
 * is why it is passed in rather than owned. */
class DirectionShaper {
  private queue: Promise<void> = Promise.resolve();
  bytesForwarded = 0;
  readonly latencyMs = newRunningStats();

  constructor(
    private readonly dst: Socket,
    private readonly bucket: TokenBucket,
    private readonly delayMs: number,
  ) {}

  push(chunk: Buffer): void {
    const arrivalMs = Date.now();
    this.queue = this.queue.then(() => this.forward(chunk, arrivalMs));
  }

  /** Resolves once every chunk pushed so far has been written out (or the destination closed). */
  drained(): Promise<void> {
    return this.queue;
  }

  private async forward(chunk: Buffer, arrivalMs: number): Promise<void> {
    const availableSinceMs = arrivalMs + this.delayMs;
    let offset = 0;
    while (offset < chunk.length) {
      if (this.dst.destroyed) return;
      const take = Math.min(SUBCHUNK_BYTES, chunk.length - offset);
      await this.waitUntilReady(availableSinceMs, take);
      if (this.dst.destroyed) return;
      const piece = chunk.subarray(offset, offset + take);
      const sentAtMs = Date.now();
      record(this.latencyMs, sentAtMs - arrivalMs);
      if (!this.dst.write(piece)) {
        await new Promise<void>((resolve) => this.dst.once("drain", resolve));
      }
      this.bytesForwarded += piece.length;
      offset += take;
    }
  }

  private waitUntilReady(
    availableSinceMs: number,
    take: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      const attempt = () => {
        const now = Date.now();
        if (now < availableSinceMs) {
          setTimeout(attempt, availableSinceMs - now);
          return;
        }
        if (this.bucket.tryTake(take)) {
          resolve();
          return;
        }
        setTimeout(attempt, Math.max(1, this.bucket.msUntil(take)));
      };
      attempt();
    });
  }
}

// --------------------------------------------------------------------------------------- proxy

export interface ThrottleProxyStats {
  schema: "render-stream-throttle-proxy-stats/1";
  rate_bytes_per_s: number;
  burst_bytes: number;
  delay_ms: number;
  duration_s: number;
  connections: number;
  client_to_server: {
    bytes_total: number;
    achieved_bytes_per_s: number;
    latency_ms: ReturnType<typeof summarize>;
  };
  server_to_client: {
    bytes_total: number;
    achieved_bytes_per_s: number;
    latency_ms: ReturnType<typeof summarize>;
  };
}

export interface ThrottleProxyHandle {
  readonly port: number;
  stop(): Promise<ThrottleProxyStats>;
}

export interface ThrottleProxyOptions {
  targetHost: string;
  targetPort: number;
  listenHost?: string;
  listenPort?: number;
  profile?: ThrottleProfile;
}

export function startThrottleProxy(
  opts: ThrottleProxyOptions,
): Promise<ThrottleProxyHandle> {
  const profile = opts.profile ?? THROTTLE_PROFILES.constrained;
  const listenHost = opts.listenHost ?? "127.0.0.1";
  const startedAtMs = Date.now();
  let connections = 0;

  // Shared buckets: the link's capacity is shaped as a whole, not per connection (D13 gate 6
  // proves two receivers at once; the proxy constrains the wire between them and the host).
  const clientToServerBucket = new TokenBucket(
    profile.burstBytes || 1,
    profile.rateBytesPerSec,
  );
  const serverToClientBucket = new TokenBucket(
    profile.burstBytes || 1,
    profile.rateBytesPerSec,
  );
  const clientToServerStats = { bytes: 0, latency: newRunningStats() };
  const serverToClientStats = { bytes: 0, latency: newRunningStats() };
  const openSockets = new Set<Socket>();

  return new Promise((resolveStart, rejectStart) => {
    const server = createServer((client) => {
      connections++;
      openSockets.add(client);
      const upstream = connect({
        host: opts.targetHost,
        port: opts.targetPort,
      });
      openSockets.add(upstream);

      const toUpstream = new DirectionShaper(
        upstream,
        clientToServerBucket,
        profile.delayMs,
      );
      const toClient = new DirectionShaper(
        client,
        serverToClientBucket,
        profile.delayMs,
      );

      client.on("data", (chunk: Buffer) => toUpstream.push(chunk));
      upstream.on("data", (chunk: Buffer) => toClient.push(chunk));

      const closeBoth = () => {
        openSockets.delete(client);
        openSockets.delete(upstream);
        if (!client.destroyed) client.destroy();
        if (!upstream.destroyed) upstream.destroy();
      };
      client.on("close", closeBoth);
      upstream.on("close", closeBoth);
      client.on("error", closeBoth);
      upstream.on("error", closeBoth);

      // Drain the shapers' queues into the running totals as chunks finish, rather than only at
      // stop() -- a long-lived connection (the whole point of this proxy) must not wait until
      // close to be reflected in stats.json if a caller inspects it mid-run.
      const poll = setInterval(() => {
        clientToServerStats.bytes = toUpstream.bytesForwarded;
        serverToClientStats.bytes = toClient.bytesForwarded;
        clientToServerStats.latency.count = toUpstream.latencyMs.count;
        clientToServerStats.latency.sum = toUpstream.latencyMs.sum;
        clientToServerStats.latency.min = Math.min(
          clientToServerStats.latency.min,
          toUpstream.latencyMs.min,
        );
        clientToServerStats.latency.max = Math.max(
          clientToServerStats.latency.max,
          toUpstream.latencyMs.max,
        );
        serverToClientStats.latency.count = toClient.latencyMs.count;
        serverToClientStats.latency.sum = toClient.latencyMs.sum;
        serverToClientStats.latency.min = Math.min(
          serverToClientStats.latency.min,
          toClient.latencyMs.min,
        );
        serverToClientStats.latency.max = Math.max(
          serverToClientStats.latency.max,
          toClient.latencyMs.max,
        );
      }, 200);
      client.on("close", () => clearInterval(poll));
    });

    server.on("error", rejectStart);
    server.listen(opts.listenPort ?? 0, listenHost, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolveStart({
        port,
        stop: () =>
          new Promise<ThrottleProxyStats>((resolveStop) => {
            for (const s of openSockets) if (!s.destroyed) s.destroy();
            server.close(() => {
              const durationS = Math.max(
                0.001,
                (Date.now() - startedAtMs) / 1000,
              );
              resolveStop({
                schema: "render-stream-throttle-proxy-stats/1",
                rate_bytes_per_s: profile.rateBytesPerSec,
                burst_bytes: profile.burstBytes,
                delay_ms: profile.delayMs,
                duration_s: durationS,
                connections,
                client_to_server: {
                  bytes_total: clientToServerStats.bytes,
                  achieved_bytes_per_s: clientToServerStats.bytes / durationS,
                  latency_ms: summarize(clientToServerStats.latency),
                },
                server_to_client: {
                  bytes_total: serverToClientStats.bytes,
                  achieved_bytes_per_s: serverToClientStats.bytes / durationS,
                  latency_ms: summarize(serverToClientStats.latency),
                },
              });
            });
          }),
      });
    });
  });
}

// ------------------------------------------------------------------------------------------- CLI

function parseArgs(argv: string[]): {
  targetHost: string;
  targetPort: number;
  listenPort: number;
  profile: ThrottleProfile;
  durationS: number | undefined;
  statsOut: string | undefined;
} {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args.set(argv[i].slice(2), argv[i + 1]);
      i++;
    }
  }
  const targetPort = Number(args.get("target-port"));
  if (!args.get("target-port") || Number.isNaN(targetPort)) {
    throw new Error("throttle-proxy: --target-port <port> is required");
  }
  const profileName = args.get("profile") ?? "constrained";
  const base = THROTTLE_PROFILES[profileName];
  if (!base)
    throw new Error(`throttle-proxy: unknown --profile ${profileName}`);
  const profile: ThrottleProfile = {
    rateBytesPerSec: args.has("rate-bytes-per-s")
      ? Number(args.get("rate-bytes-per-s"))
      : base.rateBytesPerSec,
    burstBytes: args.has("burst-bytes")
      ? Number(args.get("burst-bytes"))
      : base.burstBytes,
    delayMs: args.has("delay-ms") ? Number(args.get("delay-ms")) : base.delayMs,
  };
  return {
    targetHost: args.get("target-host") ?? "127.0.0.1",
    targetPort,
    listenPort: args.has("listen-port") ? Number(args.get("listen-port")) : 0,
    profile,
    durationS: args.has("duration-s")
      ? Number(args.get("duration-s"))
      : undefined,
    statsOut: args.get("stats-out"),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const handle = await startThrottleProxy({
    targetHost: opts.targetHost,
    targetPort: opts.targetPort,
    listenPort: opts.listenPort,
    profile: opts.profile,
  });
  console.log(JSON.stringify({ listening_port: handle.port }));

  let stopping = false;
  const stopAndReport = async () => {
    if (stopping) return;
    stopping = true;
    const stats = await handle.stop();
    const text = JSON.stringify(stats, null, 2);
    if (opts.statsOut) writeFileSync(opts.statsOut, text);
    else console.log(text);
    process.exit(0);
  };
  process.on("SIGINT", stopAndReport);
  process.on("SIGTERM", stopAndReport);
  if (opts.durationS !== undefined)
    setTimeout(stopAndReport, opts.durationS * 1000);
}

// Only run the CLI when this file is the entry point -- the self-test imports startThrottleProxy
// directly and must not also spin up this module's own server.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
