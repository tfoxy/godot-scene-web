// CAR10 (closes CAR0's F4 gap for UDP): a UDP
// forwarder that impairs a QUIC path the way Wi-Fi does: per-datagram loss, a base one-way delay
// plus uniform jitter (which reorders), and optional loss bursts. One client at a time, as a
// WebTransport session is one 4-tuple: the client sends to the proxy's port, the proxy forwards
// to `target` from a socket of its own and returns the answers. QUIC accepts the forwarder
// because the certificate is pinned by hash, not by address. Seeded, so a profile is repeatable
// up to timer scheduling.

import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

export interface ImpairProfile {
  /** Per-datagram drop probability, 0..1, each direction. */
  loss: number;
  /** One-way base delay and uniform jitter on top of it, ms. Jitter > the packet spacing reorders. */
  delayMs: number;
  jitterMs: number;
  /** A loss burst: with this probability per datagram, that direction drops everything for
   * `burstMs` (a Wi-Fi fade). Time-based, not a datagram count: QUIC's probe timeout backs off
   * exponentially, so a count-based burst would black-hole a quiet sender for many seconds. */
  burst?: number;
  burstMs?: number;
  seed?: number;
}

export interface ImpairCounts {
  up: { forwarded: number; dropped: number };
  down: { forwarded: number; dropped: number };
  /** Every client source port seen, in order (a QUIC client may migrate to a new port). */
  clientPorts: number[];
  /** Date.now() of the last datagram each way, forwarded or not. */
  lastUpAt: number;
  lastDownAt: number;
}

export interface ImpairProxy {
  port: number;
  counts: ImpairCounts;
  close(): Promise<void>;
}

/** mulberry32: a small seeded PRNG in [0, 1). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const IMPAIR_PROFILES: Record<string, ImpairProfile> = {
  /** No impairment: the forwarder alone (the control leg). */
  clean: { loss: 0, delayMs: 0, jitterMs: 0 },
  /** A busy home Wi-Fi link as a phone sees one: 2% loss with short bursts, 3 ms +- 8 ms. */
  wifi: { loss: 0.02, delayMs: 3, jitterMs: 8, burst: 0.004, burstMs: 60 },
};

export function parseProfile(spec: string): ImpairProfile {
  const named = IMPAIR_PROFILES[spec];
  if (named) return named;
  // loss=0.02,delay=3,jitter=8,burst=0.004,burstMs=60,seed=7
  const p: ImpairProfile = { loss: 0, delayMs: 0, jitterMs: 0 };
  for (const kv of spec.split(",")) {
    const [k, v] = kv.split("=");
    const n = Number(v);
    if (!Number.isFinite(n))
      throw new Error(`impair profile: ${kv} is not key=number`);
    if (k === "loss") p.loss = n;
    else if (k === "delay") p.delayMs = n;
    else if (k === "jitter") p.jitterMs = n;
    else if (k === "burst") p.burst = n;
    else if (k === "burstMs") p.burstMs = n;
    else if (k === "seed") p.seed = n;
    else throw new Error(`impair profile: unknown key ${k}`);
  }
  return p;
}

export async function startImpairProxy(
  target: { host: string; port: number },
  profile: ImpairProfile,
): Promise<ImpairProxy> {
  const front: Socket = createSocket("udp4");
  const back: Socket = createSocket("udp4");
  const counts: ImpairCounts = {
    up: { forwarded: 0, dropped: 0 },
    down: { forwarded: 0, dropped: 0 },
    clientPorts: [],
    lastUpAt: 0,
    lastDownAt: 0,
  };
  let client: RemoteInfo | null = null;
  const seed = profile.seed ?? 0xc0ffee;
  const lane = (r: () => number) => {
    let blackoutUntil = 0;
    return (): boolean => {
      const now = Date.now();
      if (now < blackoutUntil) return false;
      if (profile.burst && r() < profile.burst) {
        blackoutUntil = now + (profile.burstMs ?? 50);
        return false;
      }
      return !(r() < profile.loss);
    };
  };
  const upR = rng(seed);
  const downR = rng(seed ^ 0x9e3779b9);
  const upPass = lane(upR);
  const downPass = lane(downR);
  const delay = (r: () => number) => profile.delayMs + r() * profile.jitterMs;
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, f: () => void) => {
    if (ms <= 0) return f();
    const t = setTimeout(() => {
      timers.delete(t);
      f();
    }, ms);
    timers.add(t);
  };
  front.on("message", (msg, rinfo) => {
    client = rinfo;
    counts.lastUpAt = Date.now();
    if (counts.clientPorts[counts.clientPorts.length - 1] !== rinfo.port)
      counts.clientPorts.push(rinfo.port);
    if (!upPass()) {
      counts.up.dropped++;
      return;
    }
    counts.up.forwarded++;
    later(delay(upR), () => back.send(msg, target.port, target.host));
  });
  back.on("message", (msg) => {
    const c = client;
    if (c === null) return;
    counts.lastDownAt = Date.now();
    if (!downPass()) {
      counts.down.dropped++;
      return;
    }
    counts.down.forwarded++;
    later(delay(downR), () => front.send(msg, c.port, c.address));
  });
  await new Promise<void>((r) => front.bind(0, "127.0.0.1", r));
  await new Promise<void>((r) => back.bind(0, "127.0.0.1", r));
  return {
    port: front.address().port,
    counts,
    close: async () => {
      for (const t of timers) clearTimeout(t);
      await Promise.all([
        new Promise<void>((r) => front.close(() => r())),
        new Promise<void>((r) => back.close(() => r())),
      ]);
    },
  };
}
