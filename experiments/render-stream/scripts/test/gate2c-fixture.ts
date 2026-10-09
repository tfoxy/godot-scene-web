// Fabricated gate 2 group g2c evidence for self-test-gate2.ts (G2c2's layout: lib/gate2c-checks.ts
// header). Built on gate2b-fixture.ts' model of the fixture's texture calls (the main and the
// animate variant), on the fixture's default timeline (S=1, N=10, quit 112; the checks read each
// host's own steps.jsonl, so the real S=300, N=60 is not needed here).
//
// Every live leg gets a host directory -- both file sinks, the store, the hook log with the
// serving lines (pin and retire computed by gate2-design.md D7 from the model's tables and the
// connection's sends, http-get from the receiver's fetches), evidence/live.json and
// live-summary.json, a tap and a live log per connection -- and a receiver directory: the
// received stream(s), applied.json (mode live, http fetches with their headers, per-transaction
// ack times and resource counters, uploads, shots by step), PNG shots (synthesizeGate2) and
// state dumps. Receivers join at frame 5 and the host sends at every frame from then on, except
// where a leg says otherwise (the stall, the reconnect, a failing receiver).

import { join } from "node:path";
import { FILE_RESOURCES } from "../lib/gate0-checks";
import type { ResourceLine } from "../lib/gate2-checks";
import { type Gate2Expected, stepFrames2 } from "../lib/gate2-expected";
import {
  buildModel,
  CONTENT,
  contentOf,
  encodeSink,
  line,
  type Model,
  shotPng,
  simulateReceiver,
  stepLog,
  type Tx,
  transactionsOf,
  writeBytes,
  writeCapture,
  writeJson,
  writeText,
} from "./gate2b-fixture";
import { sha256Hex, type TState } from "./rs2-test-encoder";

export const HTTP_RESOURCES = {
  ...FILE_RESOURCES,
  fetch: "http",
  http_path: "/resources/sha256/",
};
export const CACHE_CONTROL = "private, max-age=31536000, immutable";
/** The frame every fabricated live receiver's first transaction is sent at. */
export const JOIN_FRAME = 5;
const US_PER_FRAME = 16667;

export interface ConnSpec {
  n: number;
  /** frames the host sent a transaction at (seq 1, 2, ...) */
  sends: number[];
  /** sends the receiver read (the rest are in the tap only; default all) */
  read?: number;
  /** the frame the connection closed at (null: the host's end record, after the quit) */
  closed: number | null;
  closedBy: "receiver" | "host";
}

export interface LegSpec {
  leg: string;
  model: Model;
  conns: ConnSpec[];
  rendered: boolean;
  /** the hashes the receiver's cache holds at its start (warm) */
  warm?: Set<string>;
  cacheDir?: string;
  /** the receiver fails at this seq of connection 1, at this fetched hash */
  failure?: { seq: number; hash: string; reason: string; status: number };
  sabotage?: "unpin" | "drop-resource" | "wrong-hash";
  sabotageFrame?: number;
  stall?: { afterSeq: number; afterFrame: number };
  /** the frames between a transaction's send and the callback that logs its GETs (default 1;
   * the next send, and the transaction's acks, come at the same callback) */
  getDelay?: number;
}

function okHashes(state: TState | undefined): Set<string> {
  const out = new Set<string>();
  for (const t of state?.textures ?? [])
    if (t.kind === "image" && t.status === "ok" && t.hash) out.add(t.hash);
  return out;
}

function stateAt(model: Model, frame: number): TState {
  return model.states[frame - 1];
}

/** One fetch the fabricated receiver makes over HTTP. */
export interface HttpFetch {
  stream: number;
  seq: number;
  hash: string;
  source: "http";
  status: number;
  bytes: number;
  start_us: number;
  end_us: number;
  verified: boolean;
  delay_us: number;
  headers: Record<string, string>;
  /** the host frame its GET is logged at */
  frame: number;
  conn: number;
}

export interface LegFiles {
  hostDir: string;
  receiverDir: string;
  taps: Buffer[];
  fetches: HttpFetch[];
  /** step -> {stream, seq} of the receiver's shots */
  shots: Map<number, { stream: number; seq: number; frame: number }>;
}

/** The D7 serving lines of a host: pin when a hash first becomes current, retire after the
 * frame callback at which neither the current state nor an open connection's base names it. */
function servingLines(
  spec: LegSpec,
  quit: number,
): { lines: ResourceLine[]; totals: Record<string, number | string | null> } {
  const lines: ResourceLine[] = [];
  const retained = new Map<string, number>();
  const seen = new Set<string>();
  let dropped: string | null = null;
  let pinned = 0;
  let retired = 0;
  let unpinned = 0;
  let maxN = 0;
  let maxB = 0;
  for (let f = 1; f <= quit; f++) {
    const current = okHashes(stateAt(spec.model, f));
    for (const h of current) {
      if (retained.has(h)) continue;
      const bytes = contentOf(h).payload.length;
      let sabotage = false;
      if (
        !seen.has(h) &&
        spec.sabotage === "drop-resource" &&
        f >= (spec.sabotageFrame ?? 0) &&
        dropped === null
      ) {
        dropped = h;
        sabotage = true;
      }
      seen.add(h);
      retained.set(h, bytes);
      pinned++;
      lines.push(
        line({
          frame: f,
          op: "pin",
          reason: "current",
          payload_bytes: bytes,
          hash: h,
          ...(sabotage ? { sabotage: true } : {}),
        }),
      );
    }
    const bases = new Set<string>();
    for (const c of spec.conns) {
      if (c.closed !== null && f >= c.closed) continue;
      const sent = c.sends.filter((x) => x <= f);
      if (sent.length > 0)
        for (const h of okHashes(stateAt(spec.model, sent[sent.length - 1])))
          bases.add(h);
    }
    const unpin = spec.sabotage === "unpin" && f >= (spec.sabotageFrame ?? 1);
    let bytes = 0;
    for (const v of retained.values()) bytes += v;
    maxN = Math.max(maxN, retained.size);
    maxB = Math.max(maxB, bytes);
    for (const h of [...retained.keys()]) {
      if (current.has(h) || (bases.has(h) && !unpin)) continue;
      retired++;
      if (bases.has(h)) unpinned++;
      lines.push(
        line({
          frame: f,
          op: "retire",
          reason: bases.has(h) ? "unpin" : "superseded",
          payload_bytes: retained.get(h) ?? 0,
          hash: h,
        }),
      );
      retained.delete(h);
    }
  }
  let end = 0;
  for (const v of retained.values()) end += v;
  return {
    lines,
    totals: {
      pinned,
      retired,
      retired_unpinned: unpinned,
      retained_max: maxN,
      retained_bytes_max: maxB,
      retained_end: retained.size,
      retained_bytes_end: end,
      budget_bytes: 536870912,
      dropped_hash: dropped,
      corrupted_hash: spec.sabotage === "wrong-hash" ? CONTENT.A1.hash : null,
    },
  };
}

/** The live log of one connection: open and hello, one frame line per callback from its first
 * send to its close (or the quit), the acks of each read transaction right before the next frame
 * line, and its close. */
function liveLog(
  c: ConnSpec,
  rendered: boolean,
  quit: number,
  streamId: string,
  sizes: number[],
  gets: HttpFetch[],
  failSeq: number | null,
): string {
  const rows: object[] = [];
  const first = c.sends[0];
  const read = c.read ?? c.sends.length;
  rows.push({
    frame: first,
    t_us: first * US_PER_FRAME - 2000,
    event: "open",
    connection: c.n,
    stream_id: streamId,
  });
  rows.push({
    frame: first,
    t_us: first * US_PER_FRAME - 1000,
    event: "hello",
    receiver: "gate1-receiver",
    credit_stage: rendered ? "submitted" : "applied",
    inbound_buffer_bytes: 16777216,
    max_message_bytes: 16777216,
  });
  const last = c.closed ?? quit;
  const stages = rendered
    ? ["received", "applied", "submitted"]
    : ["received", "applied"];
  const pendingAcks = new Map<number, object[]>();
  let inFlight: number | null = null;
  for (let f = first; f <= last; f++) {
    for (const row of pendingAcks.get(f) ?? []) {
      rows.push(row);
      inFlight = null;
    }
    for (const g of gets.filter((x) => x.frame === f && x.conn === c.n))
      rows.push({
        frame: f,
        t_us: f * US_PER_FRAME - 500,
        event: "http-get",
        hash: g.hash,
        status: g.status,
        bytes: g.status === 200 ? g.bytes : 0,
      });
    if (c.closed !== null && f === c.closed) {
      rows.push({
        frame: f,
        t_us: f * US_PER_FRAME,
        event: "close",
        code: 1000,
        reason: "receiver",
        closed_by: c.closedBy,
      });
      break;
    }
    const k = c.sends.indexOf(f);
    const credit = inFlight === null;
    let sent: object | null = null;
    if (k >= 0) {
      const seq = k + 1;
      sent = { seq, encoding: k === 0 ? "full" : "patch", bytes: sizes[k] };
      inFlight = seq;
      if (k < read) {
        const ackFrame = k + 1 < c.sends.length ? c.sends[k + 1] : f + 1;
        pendingAcks.set(
          ackFrame,
          (seq === failSeq ? ["received"] : stages).map((stage) => ({
            frame: ackFrame,
            t_us: ackFrame * US_PER_FRAME - 100,
            event: "ack",
            seq,
            stream_id: streamId,
            stage,
            receiver_t_us: 1,
            credited: stage === (rendered ? "submitted" : "applied"),
            ignored: null,
          })),
        );
      }
    }
    rows.push({
      frame: f,
      t_us: f * US_PER_FRAME,
      state: "streaming",
      credit,
      in_flight: inFlight,
      pending: false,
      pending_since: null,
      coalesced: 0,
      queued_bytes: 0,
      sent,
    });
  }
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

/** One live leg: its host and its receiver. */
export async function writeLiveLeg(
  out: string,
  e: Gate2Expected,
  spec: LegSpec,
): Promise<LegFiles> {
  const quit = spec.model.options.quit;
  const hostDir = join(out, spec.leg, "host");
  const receiverDir = join(out, spec.leg, "receiver");
  const sessionId = sha256Hex(Buffer.from(`session ${spec.leg}`)).slice(0, 32);
  await writeCapture(hostDir, e, spec.model, { sessionId });

  // The receiver's view first: what it fetched, when, and what it applied.
  const fetches: HttpFetch[] = [];
  const shots = new Map<
    number,
    { stream: number; seq: number; frame: number }
  >();
  const taps: Buffer[] = [];
  const appliedTx: object[] = [];
  const uploads: object[] = [];
  const streams: object[] = [];
  const memory = new Set<string>(spec.warm ?? []);
  const stateDumps = new Map<string, string>();
  let summaryUploads = 0;
  let uploadBytes = 0;
  let cacheHits = 0;
  const fetchedHashes = new Set<string>();
  let fetchedBytes = 0;
  let failed = false;
  const delay = spec.getDelay ?? 1;
  const connSummaries: object[] = [];
  const logs: string[] = [];
  for (const [index, c] of spec.conns.entries()) {
    const stream = index + 1;
    const streamId = sha256Hex(Buffer.from(`stream ${spec.leg} ${c.n}`)).slice(
      0,
      32,
    );
    const read = c.read ?? c.sends.length;
    const closedEarly = c.closedBy === "receiver" && c.closed !== null;
    const tap = encodeSink(
      c.sends.map((f) => stateAt(spec.model, f)),
      "patch",
      {
        sessionId,
        streamId,
        transport: "websocket",
        connection: c.n,
        resources: HTTP_RESOURCES,
        noEnd: closedEarly,
      },
    );
    taps.push(tap);
    const txs = transactionsOf(tap);
    // The receiver read `read` transactions (a prefix of the tap when it closed first).
    let received: Buffer = tap;
    if (read < c.sends.length) {
      const cut = encodeSink(
        c.sends.slice(0, read).map((f) => stateAt(spec.model, f)),
        "patch",
        {
          sessionId,
          streamId,
          transport: "websocket",
          connection: c.n,
          resources: HTTP_RESOURCES,
          noEnd: true,
        },
      );
      received = cut;
    }
    await writeBytes(join(hostDir, "tap", `stream-${c.n}.rs2`), tap);
    await writeBytes(
      join(receiverDir, c.n === 1 ? "received.rs2" : `received-${c.n}.rs2`),
      received,
    );
    // The resource traffic: gate2b's simulation over the transactions this connection read; a
    // reconnect starts with an empty memory, so what connection 1 fetched is a cache hit.
    const readTx: Tx[] = txs.slice(0, read);
    const sim = simulateReceiver(spec.model, readTx, "directory", memory);
    const fetchOrder = sim.fetches;
    const getsByFrame = new Map<number, number>();
    for (const x of fetchOrder) {
      const sentFrame = c.sends[x.seq - 1];
      const n = getsByFrame.get(sentFrame) ?? 0;
      getsByFrame.set(sentFrame, n + 1);
      // Every GET of a transaction reaches the host at the callback `delay` frames after its
      // send (one callback drains them all), never after the transaction's applied ack.
      const frame = sentFrame + delay;
      const failing =
        spec.failure &&
        stream === 1 &&
        x.seq === spec.failure.seq &&
        x.hash === spec.failure.hash;
      const status = failing ? (spec.failure?.status ?? 404) : 200;
      const bytes = status === 200 ? x.bytes : 0;
      const start = sentFrame * US_PER_FRAME + 1000 + n * 20000;
      fetches.push({
        stream,
        seq: x.seq,
        hash: x.hash,
        source: "http",
        status,
        bytes,
        start_us: start,
        end_us: start + 15000,
        verified: !failing,
        delay_us: 0,
        headers:
          status === 200
            ? {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(bytes),
                "Cache-Control": CACHE_CONTROL,
                ETag: `"${x.hash}"`,
              }
            : { "Content-Length": "0" },
        frame,
        conn: c.n,
      });
      if (failing) {
        failed = true;
        break;
      }
      fetchedHashes.add(x.hash);
      fetchedBytes += bytes;
    }
    for (const h of sim.acquired) memory.add(h);
    for (const tx of readTx) {
      const sentFrame = c.sends[tx.seq - 1];
      const r = sim.resources.get(tx.seq) as Record<string, number>;
      const failedHere = failed && stream === 1 && tx.seq === spec.failure?.seq;
      const after = failed && stream === 1 && tx.seq > (spec.failure?.seq ?? 0);
      if (after) break;
      const received_us = sentFrame * US_PER_FRAME + 500;
      const fetchEnd = Math.max(
        received_us,
        ...fetches
          .filter((x) => x.stream === stream && x.seq === tx.seq)
          .map((x) => x.end_us),
      );
      const applied_us = failedHere ? null : fetchEnd + 500;
      appliedTx.push({
        stream,
        seq: tx.seq,
        frame: tx.frame,
        encoding: tx.encoding,
        record_sha256: tx.sha256,
        process_frame: tx.frame + 2,
        rs_calls: 100,
        received_us,
        applied_us,
        submitted_us:
          spec.rendered && applied_us !== null ? applied_us + 5000 : null,
        skipped: null,
        resources: failedHere ? null : r,
      });
      if (failedHere) break;
      cacheHits += r.cache_hits;
      for (const u of sim.uploads.filter((x) => x.seq === tx.seq)) {
        uploads.push({ ...u, stream });
        if (u.op !== "placeholder") summaryUploads++;
        uploadBytes += u.data_bytes;
      }
      // The shot of each step: the first transaction in its window.
      if (spec.rendered)
        for (const s of e.steps) {
          const from = stepFrames2(e, s.step).settle;
          const to =
            s.step < e.last_step
              ? stepFrames2(e, s.step + 1).applied - 1
              : quit;
          if (tx.frame >= from && tx.frame <= to && !shots.has(s.step)) {
            shots.set(s.step, { stream, seq: tx.seq, frame: tx.frame });
            const name =
              stream > 1 ? `stream-${stream}-seq-${tx.seq}` : `seq-${tx.seq}`;
            const png = await shotPng(e, s.step, {
              variant:
                spec.model.options.variant === "animate"
                  ? "animate"
                  : undefined,
              frame: tx.frame,
            });
            await writeBytes(join(receiverDir, "shots", `${name}.png`), png);
            const dump = JSON.stringify({ seq: tx.seq, frame: tx.frame });
            stateDumps.set(name, dump);
            await writeText(join(receiverDir, "state", `${name}.json`), dump);
          }
        }
    }
    streams.push({
      stream_id: streamId,
      connection: c.n,
      received_path: join(
        receiverDir,
        c.n === 1 ? "received.rs2" : `received-${c.n}.rs2`,
      ),
      received_sha256: sha256Hex(received),
      received_bytes: received.length,
      end_seen: !closedEarly,
      closed_by:
        c.closedBy === "receiver" || !closedEarly ? "receiver" : "host",
      close_code: 1000,
    });
    const myGets = fetches.filter((x) => x.conn === c.n);
    connSummaries.push({
      connection: c.n,
      stream_id: streamId,
      receiver: "gate1-receiver",
      credit_stage: spec.rendered ? "submitted" : "applied",
      transactions: c.sends.length,
      sent: c.sends.length,
      acks: {
        received: Math.min(
          read,
          appliedTx.filter((t) => (t as { stream: number }).stream === stream)
            .length,
        ),
        applied: appliedTx.filter(
          (t) =>
            (t as { stream: number; applied_us: number | null }).stream ===
              stream &&
            (t as { applied_us: number | null }).applied_us !== null,
        ).length,
        submitted: spec.rendered
          ? appliedTx.filter(
              (t) =>
                (t as { stream: number }).stream === stream &&
                (t as { submitted_us: number | null }).submitted_us !== null,
            ).length
          : 0,
      },
      end_sent: !closedEarly,
      closed_by: closedEarly ? "receiver" : "receiver",
      close_code: 1000,
      http_gets: myGets.length,
      http_bytes: myGets.reduce(
        (n, x) => n + (x.status === 200 ? x.bytes : 0),
        0,
      ),
      http_errors: myGets.filter((x) => x.status !== 200).length,
    });
    const sizes = txs.map((t) => 100 + t.seq);
    logs.push(
      liveLog(
        c,
        spec.rendered,
        quit,
        streamId,
        sizes,
        fetches,
        stream === 1 ? (spec.failure?.seq ?? null) : null,
      ),
    );
  }

  // The host: its serving lines, the GETs, the summaries, the logs.
  const serving = servingLines(spec, quit);
  const gets = fetches.map((x) =>
    line({
      frame: x.frame,
      thread: "other",
      op: "http-get",
      payload_bytes: x.bytes,
      hash: x.hash,
      conn: x.conn,
      http_status: x.status,
    }),
  );
  const hook = [...spec.model.hook, ...serving.lines, ...gets].sort(
    (a, b) => a.frame - b.frame,
  );
  await writeText(
    join(hostDir, "evidence", "resources.jsonl"),
    `${hook.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  await writeJson(join(hostDir, "evidence", "live.json"), {
    schema: "render-stream-live/1",
    status: "listening",
    address: "127.0.0.1",
    port: 40000,
    reason: null,
  });
  await writeJson(join(hostDir, "evidence", "live-summary.json"), {
    schema: "render-stream-live-summary/1",
    connections: connSummaries,
    resources: {
      http_gets: fetches.length,
      http_bytes: fetches.reduce(
        (n, x) => n + (x.status === 200 ? x.bytes : 0),
        0,
      ),
      http_errors: fetches.filter((x) => x.status !== 200).length,
      ...serving.totals,
    },
  });
  for (const [i, c] of spec.conns.entries())
    await writeText(join(hostDir, "tap", `live-${c.n}.jsonl`), logs[i]);
  await writeText(join(hostDir, "steps.jsonl"), stepLog(e));

  // The receiver's applied.json.
  const failure = spec.failure
    ? {
        seq: spec.failure.seq,
        reason: spec.failure.reason,
        detail: `GET /resources/sha256/${spec.failure.hash} answered HTTP ${spec.failure.status}`,
      }
    : null;
  await writeText(join(receiverDir, "argv.txt"), "/tpl/linux_release.x86_64\n");
  await writeText(join(receiverDir, "env.txt"), "RS_RECEIVER_MODE=live\n");
  await writeText(join(receiverDir, "stdout.log"), "[receiver] ok\n");
  await writeText(join(receiverDir, "exit-code.txt"), failure ? "3\n" : "0\n");
  await writeJson(join(receiverDir, "applied.json"), {
    schema: "render-stream-receiver-applied/3",
    mode: "live",
    recording: null,
    session_id: sessionId,
    streams,
    status: failure ? "replay-failure" : "ok",
    failure,
    end_seen: !failure,
    viewport: {
      display_server: spec.rendered ? "X11" : "headless",
      size: [640, 360],
      size_check: spec.rendered ? "ok" : "skipped-headless",
      logical_size: [640, 360],
    },
    transactions: appliedTx,
    shots: [...shots.entries()].map(([step, at]) => ({
      stream: at.stream,
      seq: at.seq,
      step,
      path: "",
      state_path: null,
      applied_through: at.seq,
    })),
    shots_missed: spec.rendered
      ? e.steps.map((s) => s.step).filter((k) => !shots.has(k))
      : [],
    unsupported: [],
    live: {
      url: "ws://127.0.0.1:40000/render-stream",
      credit_stage: spec.rendered ? "submitted" : "applied",
      inbound_buffer_bytes: 16777216,
      presented: "unavailable",
      acks_sent: {
        received: appliedTx.length,
        applied: appliedTx.filter(
          (t) => (t as { applied_us: number | null }).applied_us !== null,
        ).length,
        submitted: spec.rendered
          ? appliedTx.filter(
              (t) =>
                (t as { submitted_us: number | null }).submitted_us !== null,
            ).length
          : 0,
      },
      stall: spec.stall
        ? {
            step: 5,
            ms: 1300,
            after_seq: spec.stall.afterSeq,
            after_frame: spec.stall.afterFrame,
            injected: true,
          }
        : null,
      reconnect:
        spec.conns.length > 1
          ? { step: 7, after_seq: spec.conns[0].read }
          : null,
      resync: null,
    },
    cache: {
      dir: spec.cacheDir ?? join(receiverDir, "cache"),
      mode: spec.warm ? "warm" : "fresh",
      entries_before: spec.warm?.size ?? 0,
      entries_after: (spec.warm?.size ?? 0) + fetchedHashes.size,
      bytes_after: fetchedBytes,
    },
    fetches: fetches.map(({ frame, conn, ...rest }) => rest),
    uploads,
    resources_summary: {
      distinct_fetched: fetchedHashes.size,
      fetched_bytes: fetchedBytes,
      cache_hits: cacheHits,
      uploads: summaryUploads,
      upload_bytes: uploadBytes,
    },
  });
  void stateDumps;
  return { hostDir, receiverDir, taps, fetches, shots };
}

/** Every send frame from the join to the quit. */
function everyFrame(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** The g2c legs: live, live-warm, live-replay, live-headless, live-stall, live-reconnect,
 * live-animate and the three sabotages. */
export async function buildG2cTree(
  out: string,
  e: Gate2Expected,
): Promise<void> {
  const quit = e.quit_frame_default;
  const main = buildModel(e, { quit });
  const animate = buildModel(e, { quit, variant: "animate" });
  const all = everyFrame(JOIN_FRAME, quit);
  const one = (sends: number[]): ConnSpec[] => [
    { n: 1, sends, closed: null, closedBy: "receiver" },
  ];

  const live = await writeLiveLeg(out, e, {
    leg: "live",
    model: main,
    conns: one(all),
    rendered: true,
  });
  const liveFetched = new Set(live.fetches.map((x) => x.hash));
  for (const h of liveFetched)
    await writeBytes(
      join(live.receiverDir, "cache", "sha256", `${h}.grt`),
      contentOf(h).payload,
    );
  await writeLiveLeg(out, e, {
    leg: "live-warm",
    model: main,
    conns: one(all),
    rendered: true,
    warm: liveFetched,
    cacheDir: join(live.receiverDir, "cache"),
  });
  await writeLiveLeg(out, e, {
    leg: "live-headless",
    model: main,
    conns: one(all),
    rendered: false,
  });
  // The stall: after step 5's shot (its settle frame) nothing is sent until step 6's window.
  const s5 = stepFrames2(e, 5).settle;
  const s6 = stepFrames2(e, 6).settle;
  const stallSends = all.filter((f) => f <= s5 || f >= s6);
  await writeLiveLeg(out, e, {
    leg: "live-stall",
    model: main,
    conns: one(stallSends),
    rendered: true,
    stall: { afterSeq: stallSends.indexOf(s5) + 1, afterFrame: s5 },
  });
  // The reconnect: after step 7's shot connection 1 sends one more transaction the receiver never
  // reads and closes; connection 2 starts at the next frame, before step 8.
  const s7 = stepFrames2(e, 7).settle;
  const c1 = everyFrame(JOIN_FRAME, s7 + 1);
  await writeLiveLeg(out, e, {
    leg: "live-reconnect",
    model: main,
    conns: [
      {
        n: 1,
        sends: c1,
        read: c1.length - 1,
        closed: s7 + 2,
        closedBy: "receiver",
      },
      {
        n: 2,
        sends: everyFrame(s7 + 2, quit),
        closed: null,
        closedBy: "receiver",
      },
    ],
    rendered: true,
  });
  await writeLiveLeg(out, e, {
    leg: "live-animate",
    model: animate,
    conns: one(all),
    rendered: true,
  });
  // The sabotages: the receiver fails at its first fetch of a hash the host no longer serves.
  const anim = CONTENT[`ANIM${JOIN_FRAME % 6}`].hash;
  await writeLiveLeg(out, e, {
    leg: "sabotage-unpin",
    model: animate,
    conns: [
      {
        n: 1,
        sends: [JOIN_FRAME],
        closed: JOIN_FRAME + 6,
        closedBy: "receiver",
      },
    ],
    rendered: true,
    sabotage: "unpin",
    sabotageFrame: 1,
    getDelay: 2,
    failure: {
      seq: 1,
      hash: anim,
      reason: "resource-unavailable",
      status: 404,
    },
  });
  const f6 = stepFrames2(e, 6).applied;
  const upTo6 = everyFrame(JOIN_FRAME, f6);
  for (const [leg, sabotage, reason, status] of [
    ["sabotage-drop-resource", "drop-resource", "resource-unavailable", 404],
    ["sabotage-wrong-hash-live", "wrong-hash", "resource-hash-mismatch", 200],
  ] as const)
    await writeLiveLeg(out, e, {
      leg,
      model: main,
      conns: [{ n: 1, sends: upTo6, closed: f6 + 3, closedBy: "receiver" }],
      rendered: false,
      sabotage,
      sabotageFrame: f6,
      failure: { seq: upTo6.length, hash: CONTENT.A1.hash, reason, status },
    });

  // live-replay: a file-mode receiver on live's received stream, live's cache as its store.
  const replayDir = join(out, "live-replay");
  const received = live.taps[0];
  await writeBytes(join(replayDir, "recording.rs2"), received);
  const txs = transactionsOf(received);
  const sim = simulateReceiver(main, txs, "directory");
  const shotSeqs = new Map([...live.shots.values()].map((s) => [s.seq, s]));
  for (const [step, s] of live.shots) {
    await writeBytes(
      join(replayDir, "shots", `seq-${s.seq}.png`),
      await shotPng(e, step),
    );
    await writeText(
      join(replayDir, "state", `seq-${s.seq}.json`),
      JSON.stringify({ seq: s.seq, frame: s.frame }),
    );
  }
  await writeText(join(replayDir, "exit-code.txt"), "0\n");
  await writeText(join(replayDir, "stdout.log"), "[receiver] ok\n");
  await writeJson(join(replayDir, "applied.json"), {
    schema: "render-stream-receiver-applied/3",
    mode: "file",
    status: "ok",
    failure: null,
    end_seen: true,
    transactions: txs.map((t) => ({
      stream: 1,
      seq: t.seq,
      frame: t.frame,
      encoding: t.encoding,
      record_sha256: t.sha256,
      resources: sim.resources.get(t.seq) ?? null,
    })),
    shots: [...shotSeqs.keys()].map((seq) => ({ stream: 1, seq, step: null })),
    unsupported: [],
    cache: {
      dir: join(replayDir, "cache"),
      mode: "fresh",
      entries_before: 0,
      entries_after: liveFetched.size,
      bytes_after: 0,
    },
    fetches: sim.fetches,
    uploads: sim.uploads,
    resources_summary: {
      distinct_fetched: new Set(sim.fetches.map((x) => x.hash)).size,
      fetched_bytes: sim.fetches.reduce((n, x) => n + x.bytes, 0),
      cache_hits: 0,
      uploads: sim.uploads.filter((u) => u.op !== "placeholder").length,
      upload_bytes: sim.uploads.reduce((n, u) => n + u.data_bytes, 0),
    },
  });
}
