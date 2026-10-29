// The endpoint descriptor (mirror-client-design.md "API"): where a render-stream host's live
// listener and its resource GETs are, the token, and the wire version the host streams. A product
// receives it from its own control channel; the client validates it before it connects.

/** The live protocol versions this client speaks (render-stream/11 and /12, W11t live coding). */
export type RenderStreamProtocol = 11 | 12;

export interface RenderStreamEndpoint {
  /** ws(s) URL of the host's `/render-stream`, absolute or page-relative (an http(s) page URL's
   * scheme is mapped to ws(s)). */
  url: string;
  /** URL prefix of the resource GETs, no trailing slash: GET `resourceBase + http_path + hash`
   * (the session names `http_path`). "" is the page's own origin. */
  resourceBase: string;
  /** 64 lowercase hex, or null for a host with `GRC_LIVE_AUTH=none`. Sent in the hello and as
   * `Authorization: Bearer` on every GET; never logged. */
  token: string | null;
  /** The host's `GRC_STREAM_VERSION`; the only subprotocol offered. */
  protocol: RenderStreamProtocol;
  /** The expected presentation size (the session confirms it). When set, the canvas's backing
   * store starts at this size before the hello. */
  presentation?: [number, number];
}

const KEYS = new Set([
  "url",
  "resourceBase",
  "token",
  "protocol",
  "presentation",
]);

/** A descriptor that cannot be used, and why. */
export class RenderStreamEndpointError extends Error {
  override name = "RenderStreamEndpointError";
}

/** Checks a descriptor and returns a frozen copy of it (throws `RenderStreamEndpointError`). */
export function validateEndpoint(value: unknown): RenderStreamEndpoint {
  const fail = (why: string): never => {
    throw new RenderStreamEndpointError(`render-stream endpoint: ${why}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("not an object");
  const e = value as Record<string, unknown>;
  for (const k of Object.keys(e))
    if (!KEYS.has(k)) fail(`unknown key ${JSON.stringify(k)}`);
  if (typeof e.url !== "string" || e.url.trim() === "")
    fail("url must be a non-empty string");
  const url = e.url as string;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined && !["ws", "wss", "http", "https"].includes(scheme))
    fail(`url scheme ${scheme}: is not ws, wss, http or https`);
  if (typeof e.resourceBase !== "string") fail("resourceBase must be a string");
  const resourceBase = e.resourceBase as string;
  if (resourceBase.endsWith("/"))
    fail("resourceBase must not end with a slash");
  const token = e.token;
  if (
    token !== null &&
    (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token))
  )
    fail("token must be 64 lowercase hex or null");
  if (e.protocol !== 11 && e.protocol !== 12)
    fail(`protocol must be 11 or 12 (got ${JSON.stringify(e.protocol)})`);
  let presentation: [number, number] | undefined;
  if (e.presentation !== undefined) {
    const p = e.presentation;
    if (
      !Array.isArray(p) ||
      p.length !== 2 ||
      !p.every((n) => Number.isInteger(n) && n > 0 && n <= 16384)
    )
      fail("presentation must be [width, height], integers in 1..16384");
    presentation = [(p as number[])[0], (p as number[])[1]];
  }
  return Object.freeze({
    url,
    resourceBase,
    token: token as string | null,
    protocol: e.protocol as RenderStreamProtocol,
    ...(presentation ? { presentation } : {}),
  });
}

/** Whether two descriptors name the same connection (a changed one reconnects). */
export function sameEndpoint(
  a: RenderStreamEndpoint,
  b: RenderStreamEndpoint,
): boolean {
  return (
    a.url === b.url &&
    a.resourceBase === b.resourceBase &&
    a.token === b.token &&
    a.protocol === b.protocol &&
    a.presentation?.[0] === b.presentation?.[0] &&
    a.presentation?.[1] === b.presentation?.[1]
  );
}

/** The descriptor's WebSocket URL, resolved against `base` (the page's URL), with an http(s)
 * scheme mapped to ws(s). */
export function webSocketUrl(url: string, base: string): string {
  const u = new URL(url, base);
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  return u.href;
}
