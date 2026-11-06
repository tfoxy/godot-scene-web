// TRK4 (protocol/tracks-design.md Q1, Q10): the client end of one `render-stream-track/1`
// connection. One `openTrack` is one track: it connects through the same transport seam as the view
// connection (transport.ts), says `track-hello`, waits for `track-ready` or `track-error`, then
// carries payload texts both ways with keepalives, an idle watchdog and a reconnect policy that
// follows Q1.4's last column. A refusal is a typed close, never a throw; only a mistake in the
// options (including the view token passed as a credential) throws.
//
// This module imports `endpoint.ts` and `transport.ts` only: never the view loop, the wasm core or
// the extension host, so the pure client's bundle is unchanged by it and a page that only sends
// input pays for nothing it does not use.

import { type RenderStreamEndpoint, validateEndpoint } from "./endpoint";
import {
  carrierTransport,
  type RenderStreamCarrier,
  type RenderStreamTransport,
  type RenderStreamTransportFactory,
} from "./transport";

/** The `Sec-WebSocket-Protocol` token (and the WebTransport `?protocol=` value) of a track. */
export const TRACK_SUBPROTOCOL = "render-stream-track.1";
/** The hello's and the ready's `protocol` member. */
export const TRACK_PROTOCOL = "render-stream-track/1";

/** The largest client text the host accepts (Q1.1), hence the hello's own cap. */
const HELLO_MAX_BYTES = 4096;
/** Q1.4: a `track-rate` close is retried after at least this long. */
const RATE_RETRY_MIN_MS = 1000;
/** Q1.3: nothing received for this many keepalive periods is `track-idle`. */
const IDLE_PERIODS = 3;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT = { initialMs: 250, maxMs: 5000 } as const;

const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const FORMAT = /^[a-z][a-z0-9.-]{0,47}\/([1-9][0-9]{0,4})$/;
const CLIENT_LABEL = /^[A-Za-z0-9._:-]{0,64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** The exact bytes a host writes at the start of a `track-error` (rs_tracks.cpp `error_json`). */
const ERROR_PREFIX = '{"type":"track-error"';

/** Where a track host is. `url` is the `ws(s)` URL of the host's `/render-stream`, absolute or
 * page-relative, as in `RenderStreamEndpoint`; `webTransport` is the optional WebTransport
 * carrier (used only through a transport that can open it). */
export interface TrackEndpoint {
  url: string;
  webTransport?: { url: string; certificateHashes?: string[] };
  /** The view token, when the caller has it. Never sent on a track: it is here only so that
   * `openTrack` can refuse a credential equal to it (the wrong token wired in). */
  token?: string | null;
}

/** What `track-ready` granted, in the client's spelling (the wire's `snake_case` is not exposed). */
export interface TrackReady {
  /** The host's id for this track connection. */
  source: number;
  kind: string;
  /** The negotiated up format: the first entry of `formats` the receiver declared. */
  format: string;
  /** The negotiated down format, or null (a missing down format never refuses the track). */
  downFormat: string | null;
  keepaliveMs: number;
  /** The most one `send` may carry, in UTF-8 bytes. */
  maxMessageBytes: number;
  rate: { messagesPerSecond: number; burst: number };
}

export type TrackState = "connecting" | "open" | "reconnecting" | "closed";

/** Why a connection ended, typed. `reason` is the host's close reason (Q1.4) when `by` is `host`,
 * the client's own token when `by` is `client` (`client-close`, `track-idle`, `track-protocol`,
 * `track-binary`, `track-ready-timeout`) and the transport's text (or "") when `by` is `transport`. */
export interface TrackCloseInfo {
  code: number;
  reason: string;
  /** `track-error`'s `detail` (for example `view-token`, `wrong`), when the host sent one. */
  detail: string | null;
  by: "host" | "client" | "transport";
  /** Whether `track-ready` had been received on this connection (false: a handshake refusal or a
   * connect failure). */
  opened: boolean;
  willReconnect: boolean;
  /** When `willReconnect`, the delay before the next attempt. */
  reconnectInMs: number | null;
}

export interface TrackClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  /** In [0, 1); the reconnect delay's jitter. */
  random(): number;
}

export interface OpenTrackOptions {
  kind: string;
  formats: readonly string[];
  downFormats?: readonly string[];
  /** The kind's credential. Never the view token: that throws `track-credential-is-view-token`. */
  credential: string;
  /** A label for the host's logs and the receiver (`[A-Za-z0-9._:-]{0,64}`). */
  client?: string;
  /** The view connection's session record, advisory (the host never checks it). */
  view?: { stream_id: string; connection: number } | null;
  /** As the main client; `auto` (default) uses WebTransport only when the endpoint offers it and
   * the page can open one, and WebSocket otherwise. Ignored when `transport` is set. */
  carrier?: RenderStreamCarrier;
  /** A consumer's own carrier, as the main client's `transport` option. */
  transport?: RenderStreamTransportFactory;
  /** `false`: never reconnect. Default `{ initialMs: 250, maxMs: 5000 }`, doubling, with jitter. */
  reconnect?: false | { initialMs?: number; maxMs?: number };
  /** Local limit on waiting for `track-ready` after the hello (default 10 s), then close
   * `track-ready-timeout`. */
  readyTimeoutMs?: number;
  onOpen?(ready: TrackReady): void;
  /** One down payload, verbatim. Keepalives and `track-error` never arrive here. */
  onMessage?(text: string): void;
  onClose?(info: TrackCloseInfo): void;
  onState?(state: TrackState): void;
  clock?: Partial<TrackClock>;
}

export interface TrackStats {
  /** Payloads handed to the transport. */
  sent: number;
  /** Down payloads delivered to `onMessage`. */
  received: number;
  keepalivesSent: number;
  dropped: {
    notOpen: number;
    empty: number;
    tooLarge: number;
    /** Over the host's advertised rate: dropping beats a `track-rate` close and a reconnect. */
    rate: number;
  };
  /** Connections started, the first included. */
  connections: number;
}

export interface TrackSink {
  readonly state: TrackState;
  /** The last `track-ready`, while open; null otherwise. */
  readonly ready: TrackReady | null;
  /** Sends one payload. False, and nothing queued, when not open, empty (the empty text is the
   * keepalive, which this layer sends), over `maxMessageBytes`, or over the host's rate. */
  send(text: string): boolean;
  /** Ends the track and every reconnect (idempotent). `code` is 1000 or 3000-4999. */
  close(code?: number, reason?: string): void;
  /** Settles with the last connection's close when the sink reaches `closed`. */
  readonly finished: Promise<TrackCloseInfo>;
  stats(): TrackStats;
}

export type TrackErrorCode =
  | "track-credential-is-view-token"
  | "track-options-invalid";

/** A mistake in `openTrack`'s arguments (never a host refusal). */
export class RenderStreamTrackError extends Error {
  override name = "RenderStreamTrackError";
  constructor(
    readonly code: TrackErrorCode,
    message: string,
  ) {
    super(`render-stream track: ${message}`);
  }
}

// ------------------------------------------------------------------------------------------
// Q1.4: what a close means for the next connection.

export interface TrackDisposition {
  retry: boolean;
  /** The least delay before a retry. */
  minDelayMs: number;
}

const RETRY: TrackDisposition = { retry: true, minDelayMs: 0 };
const NO_RETRY: TrackDisposition = { retry: false, minDelayMs: 0 };

const BY_REASON: Record<string, TrackDisposition> = {
  "track-protocol": NO_RETRY,
  "track-utf8": NO_RETRY,
  "track-hello-timeout": RETRY,
  "track-kind-refused": NO_RETRY,
  "track-unauthorized": NO_RETRY,
  "track-no-receiver": RETRY,
  "track-format-refused": NO_RETRY,
  "track-rate": { retry: true, minDelayMs: RATE_RETRY_MIN_MS },
  "track-idle": RETRY,
  "track-receiver-gone": RETRY,
  "stream-ended": RETRY,
  // The carrier's own inbound rules (Q1.4 last rows) are the client's fault.
  "message-too-large": NO_RETRY,
};

/** Q1.4's "Client reconnects" column. A reason this client does not know (the `/1` wire may add
 * one) falls back to its close code: a client-fault code is final, anything else is retried. */
export function trackDisposition(
  code: number,
  reason: string,
): TrackDisposition {
  if (reason === "track-closed") return code === 1000 ? RETRY : NO_RETRY;
  // A WebTransport session whose uplink stalled (CAR10) writes a reason with a detail suffix.
  if (reason.startsWith("uplink-stalled")) return RETRY;
  const known = BY_REASON[reason];
  if (known) return known;
  if (code >= 4000 && code <= 4999) return NO_RETRY;
  switch (code) {
    case 1002:
    case 1003:
    case 1007:
    case 1008:
    case 1009:
    case 1010:
      return NO_RETRY;
    default:
      return RETRY;
  }
}

// ------------------------------------------------------------------------------------------

const REAL_CLOCK: TrackClock = {
  now: () => performance.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

const utf8Length = (s: string): number =>
  // Every UTF-16 unit is at most three UTF-8 bytes (a lone surrogate is sent as U+FFFD).
  s.length * 3 <= 256 ? s.length * 3 : new TextEncoder().encode(s).length;

/** The close code to write on the wire: browsers can send only 1000 and 3000-4999. */
const wireCode = (code: number): number =>
  code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;

const invalid = (why: string): never => {
  throw new RenderStreamTrackError("track-options-invalid", why);
};

function checkFormats(
  name: string,
  list: readonly string[],
  min: number,
): void {
  if (!Array.isArray(list) || list.length < min || list.length > 8)
    invalid(`${name} must be ${min}..8 formats`);
  for (const f of list) {
    const m = typeof f === "string" ? FORMAT.exec(f) : null;
    if (m === null || Number(m[1]) > 65535)
      invalid(`${name}: ${JSON.stringify(f)} is not <name>/<N>`);
  }
  if (new Set(list).size !== list.length) invalid(`${name} has a duplicate`);
}

interface Resolved {
  endpoint: RenderStreamEndpoint;
  hello: string;
}

function resolve(endpoint: TrackEndpoint, o: OpenTrackOptions): Resolved {
  if (typeof o.kind !== "string" || !KIND.test(o.kind))
    invalid(`kind must match ${KIND.source}`);
  checkFormats("formats", o.formats, 1);
  const down = o.downFormats ?? [];
  checkFormats("downFormats", down, 0);
  if (typeof o.credential !== "string" || o.credential === "")
    invalid("credential must be a non-empty string");
  if (endpoint.token != null && endpoint.token === o.credential)
    throw new RenderStreamTrackError(
      "track-credential-is-view-token",
      "the credential equals the view token (a track has its own credential per kind)",
    );
  if (o.client !== undefined && !CLIENT_LABEL.test(o.client))
    invalid(`client must match ${CLIENT_LABEL.source}`);
  if (o.view != null) {
    if (
      !HEX32.test(o.view.stream_id) ||
      !Number.isInteger(o.view.connection) ||
      o.view.connection < 1
    )
      invalid("view must be { stream_id: 32 lowercase hex, connection >= 1 }");
  }
  if (endpoint.token != null && !HEX64.test(endpoint.token))
    invalid("endpoint.token must be 64 lowercase hex");
  // The transport seam speaks `RenderStreamEndpoint`; only `url` and `webTransport` mean anything
  // to a track (no resources, no view token, no wire version).
  const ep = validateEndpoint({
    url: endpoint.url,
    resourceBase: "",
    token: null,
    protocol: 13,
    ...(endpoint.webTransport ? { webTransport: endpoint.webTransport } : {}),
  });
  const hello = JSON.stringify({
    type: "track-hello",
    protocol: TRACK_PROTOCOL,
    kind: o.kind,
    formats: o.formats,
    down_formats: down,
    credential: o.credential,
    ...(o.client !== undefined ? { client: o.client } : {}),
    ...(o.view != null ? { view: o.view } : {}),
  });
  if (new TextEncoder().encode(hello).length > HELLO_MAX_BYTES)
    invalid(`the hello is over ${HELLO_MAX_BYTES} bytes`);
  return { endpoint: ep, hello };
}

const isPosInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;
const isPosNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** `track-ready`, validated against what this client offered; null when it is not one. */
function parseReady(
  text: string,
  o: OpenTrackOptions,
):
  | { ready: TrackReady }
  | { error: { reason: string; detail: string | null } }
  | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  if (m.type === "track-error") {
    if (typeof m.reason !== "string") return null;
    return {
      error: {
        reason: m.reason,
        detail:
          typeof m.detail === "string" && m.detail !== "" ? m.detail : null,
      },
    };
  }
  if (m.type !== "track-ready" || m.protocol !== TRACK_PROTOCOL) return null;
  const rate = m.rate as Record<string, unknown> | null;
  const down = o.downFormats ?? [];
  if (
    !isPosInt(m.source) ||
    m.kind !== o.kind ||
    typeof m.format !== "string" ||
    !o.formats.includes(m.format) ||
    !(
      m.down_format === null ||
      (typeof m.down_format === "string" && down.includes(m.down_format))
    ) ||
    !isPosInt(m.keepalive_ms) ||
    !isPosInt(m.max_message_bytes) ||
    typeof rate !== "object" ||
    rate === null ||
    !isPosNum(rate.messages_per_second) ||
    !isPosNum(rate.burst)
  )
    return null;
  return {
    ready: {
      source: m.source,
      kind: m.kind,
      format: m.format,
      downFormat: m.down_format as string | null,
      keepaliveMs: m.keepalive_ms,
      maxMessageBytes: m.max_message_bytes,
      rate: {
        messagesPerSecond: rate.messages_per_second as number,
        burst: rate.burst as number,
      },
    },
  };
}

interface Attempt {
  transport: RenderStreamTransport | null;
  opened: boolean;
  readyTimer: unknown;
  keepaliveTimer: unknown;
  idleTimer: unknown;
  /** The `track-error` text of this connection: its detail (and the reason if no close says it). */
  pending: { reason: string; detail: string | null } | null;
  lastSend: number;
  lastRecv: number;
  tokens: number;
  tokensAt: number;
  done: boolean;
}

/**
 * Opens one track: connects, says hello with `kind`, `formats` and the credential, and reports
 * through the callbacks. It returns at once (state `connecting`); the connection is made
 * asynchronously, so there is nothing to await and nothing to catch for a refusal.
 */
export function openTrack(
  endpoint: TrackEndpoint,
  options: OpenTrackOptions,
): TrackSink {
  const { endpoint: ep, hello } = resolve(endpoint, options);
  const clock: TrackClock = { ...REAL_CLOCK, ...options.clock };
  const factory: RenderStreamTransportFactory =
    options.transport ?? carrierTransport(options.carrier ?? "auto");
  const reconnect =
    options.reconnect === false
      ? null
      : {
          initialMs:
            options.reconnect?.initialMs ?? DEFAULT_RECONNECT.initialMs,
          maxMs: options.reconnect?.maxMs ?? DEFAULT_RECONNECT.maxMs,
        };
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  let state: TrackState = "connecting";
  let ready: TrackReady | null = null;
  let attempt: Attempt | null = null;
  let failures = 0;
  let retryTimer: unknown = null;
  let lastClose: TrackCloseInfo | null = null;
  const stats: TrackStats = {
    sent: 0,
    received: 0,
    keepalivesSent: 0,
    dropped: { notOpen: 0, empty: 0, tooLarge: 0, rate: 0 },
    connections: 0,
  };
  let settle!: (info: TrackCloseInfo) => void;
  const finished = new Promise<TrackCloseInfo>((r) => {
    settle = r;
  });

  // A consumer's callback that throws must not break the connection: surface it to the page's
  // error handler instead of swallowing it.
  const call = <A extends unknown[]>(
    fn: ((...a: A) => void) | undefined,
    ...a: A
  ): void => {
    if (!fn) return;
    try {
      fn(...a);
    } catch (e) {
      queueMicrotask(() => {
        throw e;
      });
    }
  };
  const setState = (s: TrackState): void => {
    if (state === s) return;
    state = s;
    call(options.onState, s);
  };
  const clearTimers = (a: Attempt): void => {
    for (const k of ["readyTimer", "keepaliveTimer", "idleTimer"] as const) {
      if (a[k] !== null) clock.clearTimeout(a[k]);
      a[k] = null;
    }
  };

  /** Ends `a` (once): detaches it, closes its transport and reports. `wire` is what to write to the
   * host, or null when the connection is already closed. */
  const finish = (
    a: Attempt,
    info: Pick<TrackCloseInfo, "code" | "reason" | "detail" | "by">,
    wire: { code: number; reason: string } | null,
  ): void => {
    if (a.done) return;
    a.done = true;
    if (attempt === a) attempt = null;
    clearTimers(a);
    if (wire !== null) {
      try {
        a.transport?.close(wireCode(wire.code), wire.reason.slice(0, 100));
      } catch {
        // already gone
      }
    }
    const wasOpen = a.opened;
    ready = null;
    const userClosed = state === "closed";
    const d = trackDisposition(info.code, info.reason);
    let delay: number | null = null;
    if (!userClosed && reconnect !== null && d.retry) {
      const base = Math.min(
        reconnect.maxMs,
        reconnect.initialMs * 2 ** Math.min(failures, 30),
      );
      const jittered = base * (0.8 + 0.4 * clock.random());
      delay = Math.round(Math.max(jittered, d.minDelayMs));
      failures++;
    }
    const full: TrackCloseInfo = {
      ...info,
      opened: wasOpen,
      willReconnect: delay !== null,
      reconnectInMs: delay,
    };
    lastClose = full;
    if (!userClosed) {
      if (delay !== null) {
        setState("reconnecting");
        retryTimer = clock.setTimeout(() => {
          retryTimer = null;
          connect();
        }, delay);
      } else {
        setState("closed");
      }
    }
    call(options.onClose, full);
    if (state === "closed") settle(full);
  };

  /** A violation by the host or the transport that this client ends itself. */
  const abort = (
    a: Attempt,
    code: number,
    reason: string,
    by: "client" | "host" = "client",
    detail: string | null = null,
  ): void => finish(a, { code, reason, detail, by }, { code, reason });

  const armKeepalive = (a: Attempt, r: TrackReady): void => {
    const wait = Math.max(1, r.keepaliveMs - (clock.now() - a.lastSend));
    a.keepaliveTimer = clock.setTimeout(() => {
      if (a.done) return;
      if (clock.now() - a.lastSend >= r.keepaliveMs) {
        a.lastSend = clock.now();
        stats.keepalivesSent++;
        try {
          a.transport?.send("");
        } catch {
          // a send on a closing transport: the close event follows
        }
      }
      armKeepalive(a, r);
    }, wait);
  };
  const armIdle = (a: Attempt, r: TrackReady): void => {
    const limit = r.keepaliveMs * IDLE_PERIODS;
    const wait = Math.max(1, limit - (clock.now() - a.lastRecv));
    a.idleTimer = clock.setTimeout(() => {
      if (a.done) return;
      if (clock.now() - a.lastRecv >= limit) abort(a, 1001, "track-idle");
      else armIdle(a, r);
    }, wait);
  };

  const onText = (a: Attempt, text: string): void => {
    a.lastRecv = clock.now();
    if (!a.opened) {
      const p = parseReady(text, options);
      if (p === null) {
        abort(a, 1002, "track-protocol");
        return;
      }
      if ("error" in p) {
        // The close follows with the same reason; keep the detail for it.
        a.pending = p.error;
        return;
      }
      a.opened = true;
      if (a.readyTimer !== null) clock.clearTimeout(a.readyTimer);
      a.readyTimer = null;
      ready = p.ready;
      failures = 0;
      a.tokens = p.ready.rate.burst;
      a.tokensAt = clock.now();
      a.lastSend = clock.now();
      setState("open");
      armKeepalive(a, p.ready);
      armIdle(a, p.ready);
      call(options.onOpen, p.ready);
      return;
    }
    if (text === "") return;
    // Q1.4: a host close of an open track writes `track-error` first. It is the one text of the
    // payload phase this layer keeps back.
    if (text.startsWith(ERROR_PREFIX)) {
      const p = parseReady(text, options);
      if (p !== null && "error" in p) {
        a.pending = p.error;
        return;
      }
    }
    stats.received++;
    call(options.onMessage, text);
  };

  const connect = (): void => {
    setState("connecting");
    stats.connections++;
    const a: Attempt = {
      transport: null,
      opened: false,
      readyTimer: null,
      keepaliveTimer: null,
      idleTimer: null,
      pending: null,
      lastSend: clock.now(),
      lastRecv: clock.now(),
      tokens: 0,
      tokensAt: 0,
      done: false,
    };
    attempt = a;
    try {
      a.transport = factory(ep, TRACK_SUBPROTOCOL, {
        open() {
          if (a.done) return;
          a.lastRecv = clock.now();
          a.readyTimer = clock.setTimeout(() => {
            if (a.done) return;
            if (a.pending)
              return abort(a, 1008, a.pending.reason, "host", a.pending.detail);
            abort(a, 1001, "track-ready-timeout");
          }, readyTimeoutMs);
          try {
            a.transport?.send(hello);
          } catch {
            // the close event follows
          }
        },
        message(data) {
          if (a.done) return;
          if (typeof data !== "string") return abort(a, 1003, "track-binary");
          onText(a, data);
        },
        close(code, reason) {
          if (a.done) return;
          // The host's close reason is the authority; its `track-error` text adds the detail (and
          // names the reason when the close frame carried none).
          const pending = a.pending;
          const reasonText = reason !== "" ? reason : (pending?.reason ?? "");
          const detail =
            pending !== null && (reason === "" || pending.reason === reason)
              ? pending.detail
              : null;
          finish(
            a,
            {
              code,
              reason: reasonText,
              detail,
              by: code === 1006 || code === 1005 ? "transport" : "host",
            },
            null,
          );
        },
      });
    } catch (e) {
      // A socket that cannot be created is a transport failure like any other.
      finish(
        a,
        {
          code: 1006,
          reason: `cannot connect: ${String(e)}`,
          detail: null,
          by: "transport",
        },
        null,
      );
    }
  };

  const sink: TrackSink = {
    get state() {
      return state;
    },
    get ready() {
      return ready;
    },
    finished,
    send(text) {
      const a = attempt;
      const r = ready;
      if (state !== "open" || a === null || r === null || !a.opened) {
        stats.dropped.notOpen++;
        return false;
      }
      if (text === "") {
        stats.dropped.empty++;
        return false;
      }
      if (utf8Length(text) > r.maxMessageBytes) {
        stats.dropped.tooLarge++;
        return false;
      }
      const now = clock.now();
      a.tokens = Math.min(
        r.rate.burst,
        a.tokens + ((now - a.tokensAt) / 1000) * r.rate.messagesPerSecond,
      );
      a.tokensAt = now;
      if (a.tokens < 1) {
        stats.dropped.rate++;
        return false;
      }
      try {
        a.transport?.send(text);
      } catch {
        stats.dropped.notOpen++;
        return false;
      }
      a.tokens -= 1;
      a.lastSend = now;
      stats.sent++;
      return true;
    },
    close(code = 1000, reason = "client-close") {
      if (state === "closed") return;
      if (retryTimer !== null) clock.clearTimeout(retryTimer);
      retryTimer = null;
      const a = attempt;
      const wasReconnecting = state === "reconnecting";
      state = "closed";
      call(options.onState, "closed");
      if (a !== null && !a.done) {
        finish(
          a,
          { code, reason, detail: null, by: "client" },
          { code, reason },
        );
      } else if (lastClose !== null && wasReconnecting) {
        // The last connection's close was already reported; the sink just stops retrying.
        lastClose = { ...lastClose, willReconnect: false, reconnectInMs: null };
      }
      settle(
        lastClose ?? {
          code,
          reason,
          detail: null,
          by: "client",
          opened: false,
          willReconnect: false,
          reconnectInMs: null,
        },
      );
    },
    stats: () => ({ ...stats, dropped: { ...stats.dropped } }),
  };

  // The first connection starts in a microtask, not here: a transport that fails at once reports
  // through `onClose`, which must not run before the caller holds the `sink`.
  queueMicrotask(() => {
    if (state === "connecting" && attempt === null) connect();
  });
  return sink;
}
