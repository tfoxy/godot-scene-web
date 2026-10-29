// The transport seam (mirror-client-design.md "Transport seam"): the protocol loop sees only this
// interface. The default is a WebSocket (binaryType arraybuffer) for the stream and `fetch` for the
// resource GETs, with `Authorization: Bearer` when a token is set. A later WebTransport or WebRTC
// data-channel transport implements the same interface; the hello, credit and records do not change.

import { type RenderStreamEndpoint, webSocketUrl } from "./endpoint";

export interface RenderStreamTransport {
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
