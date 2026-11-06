// TRK5 (protocol/tracks-design.md Q2, "As built (TRK5)"): the reference minter for per-viewer
// track capabilities, the server-side half of GRC_LIVE_TRACK_CAPS=hmac. The capture verifies
// (capture/src/rs_track_caps.{h,cpp}); a consumer's server mints with the key the capture wrote to
// evidence/live-track-cap-key and hands one capability to each page allowed to open a track.
//
//   cap1.<payload>.<mac>
//   payload = base64url(JSON {"v":1,"kind":"input","sub":"viewer-1","exp":<unix s>,"nonce":"..."})
//   mac     = base64url(HMAC-SHA256(key, "cap1." + payload))
//
// Node only (node:crypto): the key must never reach a browser. A consumer server in another
// language implements the four lines above and checks itself against
// protocol/track-cap-vectors.json, which this module generates (self-test-track-caps.ts).
//
// CLI: tsx --conditions=development experiments/render-stream/scripts/lib/track-cap.ts \
//        mint --key-file <evidence>/live-track-cap-key --sub <viewer> [--kind input] [--ttl 300]
// prints one capability (default lifetime 300 s; the host refuses one over a day).
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CAP_PREFIX = "cap1.";
/** The host accepts a capability while now <= exp + CAP_SKEW_S (rs_track_caps.h). */
export const CAP_SKEW_S = 30;
/** The host refuses exp > now + CAP_MAX_LIFETIME_S + CAP_SKEW_S (`exp-too-far`). */
export const CAP_MAX_LIFETIME_S = 86400;
export const CAP_KEY_BYTES = 32;

const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const SUB = /^[A-Za-z0-9._:@-]{1,64}$/;
const NONCE = /^[A-Za-z0-9_-]{0,32}$/;

export interface TrackCapClaims {
  kind: string;
  /** The viewer id the receiver gets as the track's `subject`. */
  sub: string;
  /** Unix seconds (not milliseconds). */
  exp: number;
  /** Optional; omitted from the payload when empty. Default: 16 random base64url characters. */
  nonce?: string;
}

/** The key file's text (64 lowercase hex) to its 32 bytes. */
export function capKeyFromHex(hex: string): Buffer {
  const t = hex.trim();
  if (!/^[0-9a-f]{64}$/.test(t))
    throw new Error("a track capability key is 64 lowercase hex");
  return Buffer.from(t, "hex");
}

export function readCapKeyFile(path: string): Buffer {
  return capKeyFromHex(readFileSync(path, "utf8"));
}

/** cap1.<base64url(payloadJson)>.<mac> over any payload text (the vectors sign bad ones). */
export function signTrackCapPayload(
  key: Uint8Array,
  payloadJson: string,
): string {
  const signed =
    CAP_PREFIX + Buffer.from(payloadJson, "utf8").toString("base64url");
  const mac = createHmac("sha256", key)
    .update(signed, "utf8")
    .digest("base64url");
  return `${signed}.${mac}`;
}

/** The canonical capability: members in the order v, kind, sub, exp, nonce. */
export function mintTrackCap(key: Uint8Array, claims: TrackCapClaims): string {
  if (key.length !== CAP_KEY_BYTES)
    throw new Error(`the key is ${CAP_KEY_BYTES} bytes`);
  const nonce = claims.nonce ?? randomBytes(12).toString("base64url");
  if (!KIND.test(claims.kind))
    throw new Error(`kind must match ${KIND.source}`);
  if (!SUB.test(claims.sub)) throw new Error(`sub must match ${SUB.source}`);
  if (!NONCE.test(nonce)) throw new Error(`nonce must match ${NONCE.source}`);
  if (!Number.isSafeInteger(claims.exp) || claims.exp < 1)
    throw new Error("exp is a positive integer of Unix seconds");
  const payload: Record<string, unknown> = {
    v: 1,
    kind: claims.kind,
    sub: claims.sub,
    exp: claims.exp,
  };
  if (nonce !== "") payload.nonce = nonce;
  return signTrackCapPayload(key, JSON.stringify(payload));
}

/** mintTrackCap with exp = now + ttlS (default 300 s, at most CAP_MAX_LIFETIME_S). */
export function mintTrackCapFor(
  key: Uint8Array,
  kind: string,
  sub: string,
  ttlS = 300,
  nowS = Math.floor(Date.now() / 1000),
): string {
  if (!Number.isSafeInteger(ttlS) || ttlS < 1 || ttlS > CAP_MAX_LIFETIME_S)
    throw new Error(`ttl is 1..${CAP_MAX_LIFETIME_S} s`);
  return mintTrackCap(key, { kind, sub, exp: nowS + ttlS });
}

// ----------------------------------------------------------------------------- golden vectors

export interface TrackCapVector {
  name: string;
  /** The hello's `kind`. */
  kind: string;
  credential: string;
  /** "ok" or the `track-unauthorized` detail the host must answer. */
  expect: string;
  subject?: string;
}

export interface TrackCapVectors {
  schema: "render-stream-track-cap-vectors/1";
  note: string;
  key_hex: string;
  now: number;
  skew_s: number;
  max_lifetime_s: number;
  vectors: TrackCapVector[];
}

/** protocol/track-cap-vectors.json, built from this minter (deterministic: fixed key and nonces). */
export function buildTrackCapVectors(): TrackCapVectors {
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const other = Buffer.alloc(32, 0xff);
  const now = 1767225600; // 2026-01-01T00:00:00Z
  const v: TrackCapVector[] = [];
  const mint = (c: TrackCapClaims, k: Uint8Array = key) => mintTrackCap(k, c);
  const raw = (json: string) => signTrackCapPayload(key, json);
  const add = (
    name: string,
    credential: string,
    expect: string,
    subject?: string,
    kind = "input",
  ) =>
    v.push({ name, kind, credential, expect, ...(subject ? { subject } : {}) });

  const ok = mint({
    kind: "input",
    sub: "viewer-1",
    exp: now + 300,
    nonce: "n1",
  });
  add("ok", ok, "ok", "viewer-1");
  add(
    "ok-no-nonce",
    mint({ kind: "input", sub: "alice@example.com", exp: now + 60, nonce: "" }),
    "ok",
    "alice@example.com",
  );
  const sub64 = "Seat_2.couch:tv-01".padEnd(64, "x");
  add(
    "ok-sub-64",
    mint({ kind: "input", sub: sub64, exp: now + 1, nonce: "N".repeat(32) }),
    "ok",
    sub64,
  );
  add(
    "ok-skew-edge",
    mint({ kind: "input", sub: "v", exp: now - 30, nonce: "s" }),
    "ok",
    "v",
  );
  add(
    "expired",
    mint({ kind: "input", sub: "v", exp: now - 31, nonce: "s" }),
    "expired",
  );
  add(
    "expired-long-ago",
    mint({ kind: "input", sub: "v", exp: 1, nonce: "s" }),
    "expired",
  );
  add(
    "ok-lifetime-edge",
    mint({ kind: "input", sub: "v", exp: now + 86400 + 30, nonce: "l" }),
    "ok",
    "v",
  );
  add(
    "exp-too-far",
    mint({ kind: "input", sub: "v", exp: now + 86400 + 31, nonce: "l" }),
    "exp-too-far",
  );
  add(
    "exp-milliseconds",
    mint({ kind: "input", sub: "v", exp: (now + 300) * 1000, nonce: "m" }),
    "exp-too-far",
  );
  add(
    "wrong-kind",
    mint({ kind: "clipboard", sub: "v", exp: now + 300, nonce: "k" }),
    "wrong-kind",
  );
  add("wrong-kind-other-hello", ok, "wrong-kind", undefined, "data");
  add(
    "ok-reordered-whitespace",
    raw(`{ "exp": ${now + 300}, "sub": "viewer-2", "kind": "input", "v": 1 }`),
    "ok",
    "viewer-2",
  );

  // Forgeries: the MAC never matches.
  const [, okPayload, okMac] = ok.split(".");
  const tampered = Buffer.from(
    JSON.stringify({
      v: 1,
      kind: "input",
      sub: "viewer-9",
      exp: now + 300,
      nonce: "n1",
    }),
  ).toString("base64url");
  add("bad-mac-tampered-payload", `cap1.${tampered}.${okMac}`, "bad-mac");
  add(
    "bad-mac-other-key",
    mint(
      { kind: "input", sub: "viewer-1", exp: now + 300, nonce: "n1" },
      other,
    ),
    "bad-mac",
  );
  const flipped = (okMac[0] === "A" ? "B" : "A") + okMac.slice(1);
  add("bad-mac-flipped", `cap1.${okPayload}.${flipped}`, "bad-mac");
  add(
    "bad-mac-hex-key-as-text",
    signTrackCapPayloadWithTextKey(key.toString("hex"), okPayload),
    "bad-mac",
  );

  // Not a capability at all.
  add("malformed-shared-credential", "9f".repeat(32), "malformed");
  add("malformed-prefix-only", "cap1.", "malformed");
  add("malformed-no-mac", `cap1.${okPayload}`, "malformed");
  add("malformed-empty-payload", raw(""), "malformed");
  add("malformed-version", `cap2.${okPayload}.${okMac}`, "malformed");
  add("malformed-padded-mac", `cap1.${okPayload}.${okMac}=`, "malformed");
  add(
    "malformed-short-mac",
    `cap1.${okPayload}.${okMac.slice(1)}`,
    "malformed",
  );
  add("malformed-extra-part", `cap1.${okPayload}.${okMac}.x`, "malformed");
  add("malformed-base64-std", `cap1.${okPayload}+.${okMac}`, "malformed");
  // The last character of a 2-mod-4 payload spelling carries 4 unused bits; a non-canonical one is
  // refused before the MAC (one spelling per payload).
  add("malformed-noncanonical-payload", nonCanonical(key), "malformed");

  // Authentic but outside the payload grammar: a minter bug.
  const e = now + 300;
  const bad: [string, string][] = [
    ["v-2", `{"v":2,"kind":"input","sub":"v","exp":${e}}`],
    ["v-string", `{"v":"1","kind":"input","sub":"v","exp":${e}}`],
    ["v-float", `{"v":1.0,"kind":"input","sub":"v","exp":${e}}`],
    ["v-missing", `{"kind":"input","sub":"v","exp":${e}}`],
    ["sub-missing", `{"v":1,"kind":"input","exp":${e}}`],
    ["sub-empty", `{"v":1,"kind":"input","sub":"","exp":${e}}`],
    ["sub-65", `{"v":1,"kind":"input","sub":"${"s".repeat(65)}","exp":${e}}`],
    ["sub-space", `{"v":1,"kind":"input","sub":"a b","exp":${e}}`],
    ["sub-number", `{"v":1,"kind":"input","sub":7,"exp":${e}}`],
    ["kind-upper", `{"v":1,"kind":"Input","sub":"v","exp":${e}}`],
    ["exp-float", `{"v":1,"kind":"input","sub":"v","exp":${e}.5}`],
    ["exp-exponent", `{"v":1,"kind":"input","sub":"v","exp":1.7e9}`],
    ["exp-string", `{"v":1,"kind":"input","sub":"v","exp":"${e}"}`],
    ["exp-negative", `{"v":1,"kind":"input","sub":"v","exp":-5}`],
    ["exp-zero", `{"v":1,"kind":"input","sub":"v","exp":0}`],
    [
      "exp-over-2-53",
      `{"v":1,"kind":"input","sub":"v","exp":9007199254740992}`,
    ],
    ["exp-missing", `{"v":1,"kind":"input","sub":"v"}`],
    [
      "nonce-33",
      `{"v":1,"kind":"input","sub":"v","exp":${e},"nonce":"${"n".repeat(33)}"}`,
    ],
    ["nonce-null", `{"v":1,"kind":"input","sub":"v","exp":${e},"nonce":null}`],
    [
      "unknown-member",
      `{"v":1,"kind":"input","sub":"v","exp":${e},"nbf":${now}}`,
    ],
    ["duplicate-sub", `{"v":1,"kind":"input","sub":"v","sub":"w","exp":${e}}`],
    ["array", `[1]`],
    ["not-json", `hello`],
  ];
  for (const [name, json] of bad)
    add(`cap-invalid-${name}`, raw(json), "cap-invalid");

  return {
    schema: "render-stream-track-cap-vectors/1",
    note:
      "Generated by experiments/render-stream/scripts/test/self-test-track-caps.ts --write from " +
      "scripts/lib/track-cap.ts; checked by capture/test/rs_track_test.cpp. key = bytes 0x00..0x1f; " +
      "each vector is a hello of `kind` presenting `credential` at wall clock `now`.",
    key_hex: key.toString("hex"),
    now,
    skew_s: CAP_SKEW_S,
    max_lifetime_s: CAP_MAX_LIFETIME_S,
    vectors: v,
  };
}

// A consumer that keyed HMAC with the key file's hex text instead of its bytes.
function signTrackCapPayloadWithTextKey(
  hexText: string,
  payloadB64: string,
): string {
  const signed = `${CAP_PREFIX}${payloadB64}`;
  return `${signed}.${createHmac("sha256", Buffer.from(hexText, "utf8")).update(signed).digest("base64url")}`;
}

// A payload spelling whose last character has a non-zero unused bit, signed over that spelling.
function nonCanonical(key: Uint8Array): string {
  for (let pad = 0; pad < 3; pad++) {
    const json = `{"v":1,"kind":"input","sub":"v","exp":1767225900${" ".repeat(pad)}}`;
    const b64 = Buffer.from(json).toString("base64url");
    if (b64.length % 4 !== 2) continue;
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(b64[b64.length - 1]);
    const spelled = b64.slice(0, -1) + alphabet[last | 1];
    const signed = `${CAP_PREFIX}${spelled}`;
    return `${signed}.${createHmac("sha256", key).update(signed).digest("base64url")}`;
  }
  throw new Error("no 2-mod-4 payload spelling");
}

// ----------------------------------------------------------------------------- CLI

function cli(argv: string[]): number {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv[0] !== "mint" || !arg("key-file") || !arg("sub")) {
    console.error(
      "usage: track-cap.ts mint --key-file <live-track-cap-key> --sub <viewer> [--kind input] [--ttl 300]",
    );
    return 2;
  }
  const key = readCapKeyFile(arg("key-file")!);
  console.log(
    mintTrackCapFor(
      key,
      arg("kind") ?? "input",
      arg("sub")!,
      Number(arg("ttl") ?? 300),
    ),
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(cli(process.argv.slice(2)));
}
