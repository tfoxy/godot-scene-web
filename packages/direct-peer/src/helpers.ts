/** Default wire-compatible domain separator; supply another prefix for another protocol. */
export const ICE_CREDENTIAL_PREFIX = "couch-tunnel/1 ice";

export type DirectPeerErrorCode =
  | "invalid-fingerprint"
  | "invalid-offer"
  | "unavailable"
  | "timeout"
  | "aborted"
  | "connection-failed"
  | "negotiation-failed"
  | "channel-failed"
  | "closed";

export class DirectPeerError extends Error {
  override readonly name = "DirectPeerError";
  constructor(
    readonly code: DirectPeerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function checkFingerprint(fp: Uint8Array): void {
  if (fp.length !== 32)
    throw new DirectPeerError(
      "invalid-fingerprint",
      "Expected a SHA-256 fingerprint (32 bytes)",
    );
}

export function parseFingerprint(text: string): Uint8Array {
  if (/^(?:[\da-f]{2}:){31}[\da-f]{2}$/i.test(text))
    return Uint8Array.from(text.split(":"), (byte) =>
      Number.parseInt(byte, 16),
    );
  // The last base64 digit contains four significant bits and two zero padding bits.
  if (/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(text))
    return Uint8Array.from(
      atob(`${text.replace(/-/g, "+").replace(/_/g, "/")}=`),
      (c) => c.charCodeAt(0),
    );
  throw new DirectPeerError(
    "invalid-fingerprint",
    "Expected unpadded base64url or colon hex SHA-256 fingerprint",
  );
}

export function formatFingerprintHex(fp: Uint8Array): string {
  checkFingerprint(fp);
  return Array.from(fp, (b) =>
    b.toString(16).padStart(2, "0").toUpperCase(),
  ).join(":");
}

export interface IceCredentials {
  ufrag: string;
  pwd: string;
}

export async function deriveIceCredentials(
  fingerprint: Uint8Array,
  prefix = ICE_CREDENTIAL_PREFIX,
): Promise<IceCredentials> {
  checkFingerprint(fingerprint);
  const domain = new TextEncoder().encode(prefix);
  const input = new Uint8Array(domain.length + fingerprint.length);
  input.set(domain);
  input.set(fingerprint, domain.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const b64 = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
  return { ufrag: b64(hash.slice(0, 6)), pwd: b64(hash.slice(6, 24)) };
}

export interface LiteAnswerOptions {
  ip: string;
  port: number;
  fingerprint: Uint8Array;
  credentials: IceCredentials;
  maxMessageSize?: number;
}

/** Fabricate an ICE-lite answer for the offer's application m-section, without rewriting the offer. */
export function buildLiteAnswer(
  offerSdp: string,
  options: LiteAnswerOptions,
): string {
  const sections = offerSdp.split(/(?=^m=)/m);
  const application = sections.find((section) =>
    section.startsWith("m=application "),
  );
  const mid = application && /^a=mid:([^\r\n]+)\r?$/m.exec(application)?.[1];
  if (!mid)
    throw new DirectPeerError(
      "invalid-offer",
      "Offer has no application m-section with a mid",
    );
  const {
    ip,
    port,
    fingerprint,
    credentials,
    maxMessageSize = 262144,
  } = options;
  const family = ip.includes(":") ? "IP6" : "IP4";
  return [
    "v=0",
    "o=- 123456789 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    `a=group:BUNDLE ${mid}`,
    "a=ice-lite",
    `m=application ${port} UDP/DTLS/SCTP webrtc-datachannel`,
    `c=IN ${family} ${ip}`,
    `a=mid:${mid}`,
    `a=ice-ufrag:${credentials.ufrag}`,
    `a=ice-pwd:${credentials.pwd}`,
    `a=fingerprint:sha-256 ${formatFingerprintHex(fingerprint)}`,
    "a=setup:passive",
    "a=sctp-port:5000",
    `a=max-message-size:${maxMessageSize}`,
    `a=candidate:1 1 udp 2130706431 ${ip} ${port} typ host`,
    "a=end-of-candidates",
    "",
  ].join("\r\n");
}
