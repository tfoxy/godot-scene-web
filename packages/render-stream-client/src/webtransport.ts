import type { RenderStreamTransportFactory } from "./transport";

// ------------------------------------------------------------------------------------------
// CAR5: the WebTransport carrier (`render-stream-wt/1`, carrier-design.md Q4). The same messages,
// byte for byte, on one QUIC session: stream type 0x00 is the live stream (length-prefixed
// messages), 0x01 a resource GET (one stream per request). The hello, credit and records do not
// change.

const STREAM_LIVE = 0;
const STREAM_RESOURCE = 1;
/** CAR10 (Q4.3a): a client unidirectional stream holding one batch of client-to-host messages. */
const STREAM_UPLINK = 0x10;
const KIND_BINARY = 0;
const KIND_TEXT = 1;
/** Host to client: at most `max_queued_bytes` per message (Q4.3). */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** WebSocket's close-reason limit, shared by both carriers (Q4.5). */
const MAX_REASON_BYTES = 123;
const MAX_PATH_BYTES = 1024;
/** F3: the default bound of a client's in-memory resource cache. */
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
/** How long a reset live stream waits for the session's own close before it counts as 1006. */
const STREAM_RESET_GRACE_MS = 100;
/** CAR10: an uplink batch whose stream has not closed after this is sent again on a new stream;
 * the wait doubles per attempt (100, 200, 400, 800, 1600, 3200 ms), and a batch still
 * unconfirmed after the last one closes the session `uplink-stalled` (about 6.3 s). On the g31 a
 * healthy batch's close settles within ~60 ms (14 548 streams), and a wedged one never does. A
 * close that is merely slow costs a duplicate, which the host drops. */
const UPLINK_RESEND_MS = 100;
const UPLINK_ATTEMPTS = 6;
/** The largest batch the client builds (the host accepts 64 KiB). */
const UPLINK_MAX_BATCH = 32 * 1024;
/** transport.ts's `UPLINK_STALLED`, spelled out: importing a value from `./transport` would
 * split it into a chunk shared with the main entry (a cost to every WebSocket-only page). */
const UPLINK_STALLED = "uplink-stalled";
/** The stream error a host that predates uplink streams stops them with (Q4.2). */
const UNKNOWN_STREAM_TYPE = 1;
/** How long a client close waits for the live stream's FIN before closing the session anyway (a
 * wedged stream never finishes). */
const CLOSE_FIN_WAIT_MS = 500;

export interface WebTransportTransportOptions {
  /** F3: the bound of the in-memory, content-addressed LRU of fetched resource bodies, owned by
   * the factory (so by one client). 0 turns it off. Default 64 MiB. */
  cacheBytes?: number;
  /** F1: also offer the subprotocol through WebTransport protocol negotiation (the constructor's
   * `protocols`) and require the host to agree. Default false: the `?protocol=` query only. */
  negotiate?: boolean;
  /** CAR10: how client-to-host messages after the hello travel. `streams` (default): one
   * unidirectional uplink stream per batch (Q4.3a), confirmed by its close and sent again when
   * the close does not come, because Chrome on Android can wedge a long-lived stream's send side
   * for good while its writes keep resolving. `live`: on the live stream, as before CAR10. A host
   * that refuses uplink streams (one that predates them) turns `streams` into `live` for the
   * session. */
  uplink?: "streams" | "live";
}

/** A violation of the live framing by the host (the session is closed with `code`). */
class FramingError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Splits the live stream's byte chunks into messages, whatever the chunk boundaries. A body is
 * allocated once at its length and filled in place, so a large message is copied once. */
class FrameParser {
  private readonly head = new Uint8Array(5);
  private headLen = 0;
  private body: Uint8Array | null = null;
  private bodyLen = 0;
  private kind = 0;

  push(chunk: Uint8Array, emit: (data: ArrayBuffer | string) => void): void {
    let i = 0;
    while (i < chunk.length) {
      if (this.body === null) {
        const n = Math.min(5 - this.headLen, chunk.length - i);
        this.head.set(chunk.subarray(i, i + n), this.headLen);
        this.headLen += n;
        i += n;
        if (this.headLen < 5) break;
        this.headLen = 0;
        this.kind = this.head[0];
        const len = new DataView(this.head.buffer).getUint32(1, true);
        if (this.kind !== KIND_BINARY && this.kind !== KIND_TEXT)
          throw new FramingError(1002, `unknown message kind ${this.kind}`);
        if (len > MAX_MESSAGE_BYTES)
          throw new FramingError(1009, `message of ${len} bytes`);
        if (len === 0) {
          this.finish(new Uint8Array(0), emit);
          continue;
        }
        this.body = new Uint8Array(len);
        this.bodyLen = 0;
      } else {
        const n = Math.min(this.body.length - this.bodyLen, chunk.length - i);
        this.body.set(chunk.subarray(i, i + n), this.bodyLen);
        this.bodyLen += n;
        i += n;
        if (this.bodyLen === this.body.length) {
          const b = this.body;
          this.body = null;
          this.finish(b, emit);
        }
      }
    }
  }

  private finish(
    body: Uint8Array,
    emit: (data: ArrayBuffer | string) => void,
  ): void {
    emit(
      this.kind === KIND_TEXT
        ? new TextDecoder().decode(body)
        : (body.buffer as ArrayBuffer),
    );
  }
}

/** One client-to-host live message (Q4.3): kind 1, length, UTF-8. */
function frameText(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const buf = new Uint8Array(5 + body.length);
  buf[0] = KIND_TEXT;
  new DataView(buf.buffer).setUint32(1, body.length, true);
  buf.set(body, 5);
  return buf;
}

function concat(parts: Uint8Array[], lead = 0): Uint8Array {
  const out = new Uint8Array(lead + parts.reduce((n, p) => n + p.length, 0));
  let at = lead;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `reason` cut to `MAX_REASON_BYTES` of UTF-8 at a character boundary. */
function truncateReason(reason: string): string {
  const enc = new TextEncoder().encode(reason);
  if (enc.length <= MAX_REASON_BYTES) return reason;
  let end = MAX_REASON_BYTES;
  while (end > 0 && (enc[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(enc.subarray(0, end));
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

async function readAll(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    total += r.value.length;
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function gunzip(body: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  w.write(body).catch(() => {});
  w.close().catch(() => {});
  return await new Response(ds.readable).arrayBuffer();
}

/** F3: a byte-bounded LRU of immutable, content-addressed bodies (a path names one hash). */
class ResourceCache {
  private readonly map = new Map<string, ArrayBuffer>();
  private bytes = 0;
  constructor(private readonly cap: number) {}
  get(path: string): ArrayBuffer | null {
    const v = this.map.get(path);
    if (v === undefined) return null;
    this.map.delete(path);
    this.map.set(path, v);
    // A copy: the caller may transfer or detach what it gets.
    return v.slice(0);
  }
  set(path: string, body: ArrayBuffer): void {
    if (body.byteLength > this.cap) return;
    const old = this.map.get(path);
    if (old) {
      this.bytes -= old.byteLength;
      this.map.delete(path);
    }
    this.map.set(path, body.slice(0));
    this.bytes += body.byteLength;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.cap) break;
      this.map.delete(k);
      this.bytes -= v.byteLength;
    }
  }
}

/** The WebTransport carrier as a transport factory (carrier-design.md Q4/Q5). It reads
 * `endpoint.webTransport` (throws when absent), opens `url?protocol=<subprotocol>` with
 * `allowPooling: false` and the descriptor's `certificateHashes` as `serverCertificateHashes`,
 * and maps the session as the WebSocket would be: `open` once the live stream (type 0x00) is
 * created, one `message` per framed message (text as string, binary as ArrayBuffer), one `close`
 * per session. A clean session close reports its code (0 becomes 1005); a transport error, idle
 * timeout or reset stream reports 1006; a framing violation by the host closes the session 1002
 * or 1009. `fetchResource` opens a resource stream per GET with the token in the request.
 * Each factory owns one resource cache (F3), so make one per client. */
export function createWebTransportTransport(
  options: WebTransportTransportOptions = {},
): RenderStreamTransportFactory {
  const cache = new ResourceCache(options.cacheBytes ?? DEFAULT_CACHE_BYTES);
  return (endpoint, subprotocol, on) => {
    const cfg = endpoint.webTransport;
    if (!cfg) throw new Error("the descriptor has no webTransport");
    const url = new URL(cfg.url);
    url.searchParams.set("protocol", subprotocol);
    const init: WebTransportOptions = { allowPooling: false };
    if (cfg.certificateHashes)
      init.serverCertificateHashes = cfg.certificateHashes.map((h) => ({
        algorithm: "sha-256",
        value: hexBytes(h),
      }));
    if (options.negotiate) init.protocols = [subprotocol];
    const wt = new WebTransport(url.href, init);

    let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    let clientClosing = false;
    let emitted = false;
    /** Why this side ended the session, when it did for its own reasons. */
    let forced: { code: number; reason: string } | null = null;
    const fail = (code: number, reason: string): void => {
      if (clientClosing) return;
      forced ??= { code, reason };
      wt.close({ closeCode: code, reason: truncateReason(reason) });
    };

    // CAR10 uplink (Q4.3a). The first message (the hello) goes on the live stream; later ones are
    // gathered per task and sent as numbered batches on uplink streams until confirmed.
    let helloSent = false;
    let inband = options.uplink === "live";
    let gathering: Uint8Array[] | null = null;
    let gatheredBytes = 0;
    let nextBatch = 0;
    /** Batches sent and not yet confirmed, in batch order. */
    const unconfirmed = new Map<number, Uint8Array>();
    const toLive = (bytes: Uint8Array): void => {
      writer?.write(bytes).catch(() => {});
    };
    const toInband = (): void => {
      if (inband) return;
      inband = true;
      if (gathering) flushGathered();
      for (const frames of unconfirmed.values()) toLive(frames);
      unconfirmed.clear();
    };
    const sendBatch = async (
      n: number,
      frames: Uint8Array,
      attempt: number,
    ): Promise<void> => {
      if (inband || clientClosing || sessionEnded || !unconfirmed.has(n))
        return;
      let w: WritableStreamDefaultWriter<Uint8Array>;
      try {
        w = (await wt.createUnidirectionalStream()).getWriter();
      } catch {
        return; // the session is ending
      }
      const head = concat([frames], 5);
      head[0] = STREAM_UPLINK;
      new DataView(head.buffer).setUint32(1, n, true);
      w.write(head).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        w.close().then(
          () => "ok",
          (e: unknown) =>
            (e as { streamErrorCode?: number } | null)?.streamErrorCode ===
            UNKNOWN_STREAM_TYPE
              ? "refused"
              : "lost",
        ),
        new Promise<string>((r) => {
          timer = setTimeout(() => r("lost"), UPLINK_RESEND_MS * 2 ** attempt);
        }),
      ]);
      clearTimeout(timer);
      if (outcome === "ok") {
        unconfirmed.delete(n);
        return;
      }
      if (outcome === "refused") return toInband();
      if (inband || clientClosing || sessionEnded) return;
      w.abort().catch(() => {});
      if (attempt + 1 >= UPLINK_ATTEMPTS)
        return fail(
          1006,
          `${UPLINK_STALLED}: batch ${n} unconfirmed after ${attempt + 1} streams`,
        );
      return sendBatch(n, frames, attempt + 1);
    };
    const flushGathered = (): void => {
      const parts = gathering;
      gathering = null;
      gatheredBytes = 0;
      if (!parts || parts.length === 0) return;
      const frames = concat(parts);
      if (inband) {
        toLive(frames);
        return;
      }
      const n = nextBatch++;
      unconfirmed.set(n, frames);
      void sendBatch(n, frames, 0);
    };
    const gather = (f: Uint8Array): void => {
      if (gathering && gatheredBytes + f.length > UPLINK_MAX_BATCH)
        flushGathered();
      if (!gathering) {
        gathering = [];
        queueMicrotask(flushGathered);
      }
      gathering.push(f);
      gatheredBytes += f.length;
    };

    let sessionEnded = false;
    let reading = false;
    const sessionEnd = wt.closed.then(
      () => {
        sessionEnded = true;
      },
      () => {
        sessionEnded = true;
      },
    );
    const live = (async () => {
      await wt.ready;
      if (
        options.negotiate &&
        (wt as { protocol?: string }).protocol !== subprotocol
      )
        throw new FramingError(1002, "the host did not agree the subprotocol");
      const stream = await wt.createBidirectionalStream();
      writer = stream.writable.getWriter();
      writer.write(Uint8Array.of(STREAM_LIVE)).catch(() => {});
      if (clientClosing) return;
      on.open();
      reading = true;
      const reader = stream.readable.getReader();
      const parser = new FrameParser();
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        if (clientClosing) continue;
        parser.push(r.value, (data) => {
          try {
            on.message(data);
          } catch (e) {
            // a product handler's error is not the stream's
            setTimeout(() => {
              throw e;
            });
          }
        });
      }
    })().catch(async (e: unknown) => {
      if (e instanceof FramingError || !reading)
        return e instanceof FramingError
          ? fail(e.code, e.message)
          : fail(1006, `webtransport: ${String(e)}`);
      // A reset live stream is usually the session ending (the host closed it, or the network
      // dropped): let the session's own end decide the code. A stream reset under a session that
      // stays up is a 1006 close.
      await Promise.race([
        sessionEnd,
        new Promise<void>((r) => setTimeout(r, STREAM_RESET_GRACE_MS)),
      ]);
      if (!sessionEnded && !emitted) fail(1006, `webtransport: ${String(e)}`);
    });

    // The session's end is the connection's end. Messages the live stream still had to deliver
    // are read first: a host closes the session only after finishing the stream (Q4.5).
    const ended = (code: number, reason: string): void => {
      if (emitted) return;
      emitted = true;
      on.close(code, reason);
    };
    wt.closed.then(
      async (info) => {
        await live;
        if (forced) return ended(forced.code, forced.reason);
        const c = info?.closeCode ?? 0;
        ended(c === 0 ? 1005 : c, info?.reason ?? "");
      },
      async (e: unknown) => {
        await live;
        if (forced) return ended(forced.code, forced.reason);
        ended(1006, `webtransport: ${String(e)}`);
      },
    );

    return {
      carrier: "webtransport",
      send(text) {
        if (writer === null || clientClosing) return;
        const f = frameText(text);
        if (!helloSent || inband) {
          helloSent = true;
          return toLive(f);
        }
        gather(f);
      },
      close(code, reason) {
        if (clientClosing) return;
        clientClosing = true;
        const closeInfo = { closeCode: code, reason: truncateReason(reason) };
        const w = writer as WritableStreamDefaultWriter<Uint8Array> | null;
        // Finish the live stream first, so what was written is not reset by the session close;
        // a wedged stream never finishes, so the session closes after CLOSE_FIN_WAIT_MS anyway.
        if (w === null) wt.close(closeInfo);
        else {
          let done = false;
          const closeSession = () => {
            if (done) return;
            done = true;
            wt.close(closeInfo);
          };
          w.close().then(closeSession, closeSession);
          setTimeout(closeSession, CLOSE_FIN_WAIT_MS);
        }
      },
      async fetchResource(path, req) {
        const hit = cache.get(path);
        if (hit !== null) return { status: 200, body: hit };
        const p = new TextEncoder().encode(path);
        if (p.length > MAX_PATH_BYTES)
          throw new Error("resource path too long");
        if (req.token !== null && !/^[0-9a-f]{64}$/.test(req.token))
          throw new Error("resource token is not 64 lowercase hex");
        if (req.signal.aborted) throw new Error("aborted");
        await wt.ready;
        const stream = await wt.createBidirectionalStream();
        const w = stream.writable.getWriter();
        const r = stream.readable.getReader();
        const abort = () => {
          r.cancel().catch(() => {});
          w.abort().catch(() => {});
        };
        req.signal.addEventListener("abort", abort, { once: true });
        try {
          const gz = typeof DecompressionStream === "function";
          const t =
            req.token === null ? new Uint8Array(0) : hexAscii(req.token);
          const buf = new Uint8Array(1 + 1 + 2 + p.length + 1 + t.length);
          buf[0] = STREAM_RESOURCE;
          buf[1] = gz ? 1 : 0;
          new DataView(buf.buffer).setUint16(2, p.length, true);
          buf.set(p, 4);
          buf[4 + p.length] = t.length;
          buf.set(t, 5 + p.length);
          await w.write(buf);
          await w.close();
          const res = await readAll(r);
          if (req.signal.aborted) throw new Error("aborted");
          if (res.length < 7)
            throw new Error("resource-unavailable: truncated response");
          const dv = new DataView(res.buffer, res.byteOffset, res.byteLength);
          const status = dv.getUint16(0, true);
          const coding = res[2];
          const len = dv.getUint32(3, true);
          if (res.length !== 7 + len)
            throw new Error(
              `resource-unavailable: body of ${res.length - 7} bytes, header says ${len}`,
            );
          if (status !== 200) {
            if (coding !== 0)
              throw new Error("resource-unavailable: coded error body");
            return { status, body: len === 0 ? null : res.slice(7).buffer };
          }
          const raw = res.slice(7);
          let body: ArrayBuffer;
          if (coding === 0) body = raw.buffer;
          else if (coding === 1 && gz) body = await gunzip(raw);
          else
            throw new Error(
              `resource-unavailable: unrequested coding ${coding}`,
            );
          cache.set(path, body);
          return { status, body };
        } finally {
          req.signal.removeEventListener("abort", abort);
          r.releaseLock();
          w.releaseLock();
        }
      },
    };
  };
}

function hexAscii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** The default WebTransport transport, without a resource cache (use
 * `createWebTransportTransport` for one cache per client). */
export const webTransportTransport: RenderStreamTransportFactory =
  createWebTransportTransport({ cacheBytes: 0 });
