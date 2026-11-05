// The transport seam (mirror-client-design.md "Transport seam"): the protocol loop sees only this
// interface. The default is a WebSocket (binaryType arraybuffer) for the stream and `fetch` for the
// resource GETs, with `Authorization: Bearer` when a token is set. A later WebTransport or WebRTC
// data-channel transport implements the same interface; the hello, credit and records do not change.

import { type RenderStreamEndpoint, webSocketUrl } from "./endpoint";

export interface RenderStreamTransport {
  /** Which carrier this transport is (CAR8); absent on a custom transport. */
  readonly carrier?: "websocket" | "webtransport";
  /** One control message (JSON text: the hello, an ack, a resync). */
  send(text: string): void;
  close(code: number, reason: string): void;
  /** `GET resourceBase + path`; `body` is null when the response had none. */
  fetchResource(
    path: string,
    init: { token: string | null; signal: AbortSignal },
  ): Promise<{ status: number; body: ArrayBuffer | null }>;
}

export interface RenderStreamTransportEvents {
  open(): void;
  message(data: ArrayBuffer | string): void;
  close(code: number, reason: string): void;
}

export type RenderStreamTransportFactory = (
  endpoint: RenderStreamEndpoint,
  subprotocol: string,
  on: RenderStreamTransportEvents,
) => RenderStreamTransport;

/** The default transport: a WebSocket on the descriptor's URL offering only `subprotocol`, and
 * `fetch` under its `resourceBase` (default cache mode, so the browser's HTTP cache answers a
 * reconnect's repeated GETs; no credentials). A socket that cannot be created throws here. */
export const webSocketTransport: RenderStreamTransportFactory = (
  endpoint,
  subprotocol,
  on,
) => {
  const ws = new WebSocket(webSocketUrl(endpoint.url, location.href), [
    subprotocol,
  ]);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => on.open();
  ws.onmessage = (ev: MessageEvent) =>
    on.message(ev.data as ArrayBuffer | string);
  // Every handler is dropped once the socket closed: a socket the browser still holds must not
  // keep the client (and its wasm instance) reachable after a dispose.
  ws.onclose = (ev: CloseEvent) => {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    on.close(ev.code, ev.reason);
  };
  ws.onerror = () => {};
  return {
    carrier: "websocket",
    send(text) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close(code, reason) {
      // Nothing more is read once the client closes (the close event still arrives).
      ws.onopen = null;
      ws.onmessage = null;
      if (ws.readyState === WebSocket.CLOSED) return;
      try {
        ws.close(code, reason);
      } catch {
        ws.close();
      }
    },
    async fetchResource(path, init) {
      const headers: Record<string, string> = {};
      if (init.token !== null) headers.Authorization = `Bearer ${init.token}`;
      const res = await fetch(`${endpoint.resourceBase}${path}`, {
        headers,
        signal: init.signal,
        cache: "default",
        credentials: "omit",
      });
      return { status: res.status, body: await res.arrayBuffer() };
    },
  };
};

// ------------------------------------------------------------------------------------------
// CAR5: carrier selection. The WebTransport code (`./webtransport`: framing, resource streams,
// the resource cache) is a separate chunk, loaded by dynamic import only when the descriptor
// offers `webTransport` and the page can open one, so a WebSocket-only page never loads it.

/** `auto`: how long a WebTransport attempt (its chunk load included) may take to open before
 * WebSocket is tried. */
const DEFAULT_OPEN_TIMEOUT_MS = 3000;

/** Whether this page can open a WebTransport session: the API exists and the context is secure
 * (an https page, or http on loopback). */
export function webTransportAvailable(): boolean {
  return (
    typeof (globalThis as { WebTransport?: unknown }).WebTransport ===
      "function" && globalThis.isSecureContext === true
  );
}

export type RenderStreamCarrier = "auto" | "websocket" | "webtransport";

export interface CarrierDeps {
  websocket?: RenderStreamTransportFactory;
  /** The WebTransport factory (default: `createWebTransportTransport()` from the lazily imported
   * `./webtransport`, one cache per carrier). */
  webtransport?: () => Promise<RenderStreamTransportFactory>;
  /** `auto`: ms a WebTransport attempt may take to open (default 3000). */
  openTimeoutMs?: number;
}

/** CAR5 (D14): the transport factory for a `carrier` option, one per client (the sticky fallback
 * and the WebTransport cache live in it). `auto` uses WebTransport when the descriptor offers it
 * and the page can open one, and WebSocket otherwise; if the WebTransport attempt closes before
 * `open` (or takes `openTimeoutMs`, or its chunk fails to load), the same connect attempt is
 * retried over WebSocket and every later connect of this factory stays on WebSocket. A failure
 * after `open` is an ordinary close. `webtransport` never falls back: a failure is a close
 * without `open`. */
export function carrierTransport(
  carrier: RenderStreamCarrier,
  deps: CarrierDeps = {},
): RenderStreamTransportFactory {
  const ws = deps.websocket ?? webSocketTransport;
  if (carrier === "websocket") return ws;
  let loaded: Promise<RenderStreamTransportFactory> | null = null;
  const load = () =>
    (loaded ??= deps.webtransport
      ? deps.webtransport()
      : import("./webtransport").then((m) => m.createWebTransportTransport()));
  const auto = carrier === "auto";
  let sticky = false;
  return (endpoint, subprotocol, on) => {
    if (auto && (sticky || !endpoint.webTransport || !webTransportAvailable()))
      return ws(endpoint, subprotocol, on);
    let current: RenderStreamTransport | null = null;
    let attempt: RenderStreamTransport | null = null;
    let abandoned = false;
    let opened = false;
    let userClosed = false;
    let ended = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const end = (code: number, reason: string) => {
      if (ended) return;
      ended = true;
      on.close(code, reason);
    };
    const failed = (code: number, reason: string) => {
      if (!auto || opened || userClosed || abandoned) return end(code, reason);
      // Fall back: the same connect attempt over WebSocket, for good.
      clear();
      sticky = true;
      abandoned = true;
      const dead = current;
      current = null;
      try {
        dead?.close(1000, "fallback");
      } catch {
        // already gone
      }
      try {
        current = ws(endpoint, subprotocol, on);
      } catch (e) {
        end(1006, `cannot connect: ${String(e)}`);
      }
    };
    load().then(
      (factory) => {
        if (abandoned || userClosed) return;
        try {
          attempt = factory(endpoint, subprotocol, {
            // Events of an abandoned attempt are dropped by the identity check.
            open() {
              if (current !== attempt || abandoned) return;
              opened = true;
              clear();
              on.open();
            },
            message(d) {
              if (current === attempt && !abandoned) on.message(d);
            },
            close(code, reason) {
              if (current !== attempt || abandoned) return;
              if (opened || userClosed || !auto) end(code, reason);
              else failed(code, reason);
            },
          });
          current = attempt;
        } catch (e) {
          failed(1006, `cannot connect: ${String(e)}`);
        }
      },
      (e: unknown) => failed(1006, `webtransport unavailable: ${String(e)}`),
    );
    if (auto)
      timer = setTimeout(() => {
        if (!opened && !userClosed && !abandoned) failed(1006, "open timeout");
      }, deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
    return {
      get carrier() {
        return current?.carrier;
      },
      send: (t) => current?.send(t),
      close(code, reason) {
        userClosed = true;
        clear();
        if (current) current.close(code, reason);
        else end(code, reason);
      },
      fetchResource: (path, init) =>
        (current as RenderStreamTransport).fetchResource(path, init),
    };
  };
}
