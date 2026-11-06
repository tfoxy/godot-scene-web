// TRK5 (protocol/tracks-design.md "As built (TRK5)"): the capability golden vectors and the
// reference minter (scripts/lib/track-cap.ts). Pure, no host.
//
// Checks:
//   vectors-reproduce  protocol/track-cap-vectors.json is byte for byte what the minter builds now
//                      (the C++ side, rs_track_test, judges every vector against `expect`)
//   hmac-rfc4231       node:crypto's HMAC-SHA256 against RFC 4231 cases 1, 2 and 6, the same
//                      cases rs_track_test checks the capture's own HMAC with
//   mint-shape         a minted capability is cap1.<base64url JSON>.<43-char MAC>, its payload's
//                      members in the order v, kind, sub, exp, nonce, and a random nonce per call
//   mint-refuses       the minter throws for a key that is not 32 bytes, a sub outside the
//                      grammar, exp in milliseconds-as-float or a ttl over a day
//   key-file           capKeyFromHex accepts 64 lowercase hex (with a trailing newline) only
// Usage: mise exec -- pnpm exec tsx --conditions=development \
//          experiments/render-stream/scripts/test/self-test-track-caps.ts [--write]
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTrackCapVectors,
  CAP_MAX_LIFETIME_S,
  capKeyFromHex,
  mintTrackCap,
  mintTrackCapFor,
} from "../lib/track-cap";

const RS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = join(RS, "protocol/track-cap-vectors.json");
const text = `${JSON.stringify(buildTrackCapVectors(), null, 2)}\n`;

if (process.argv.includes("--write")) {
  writeFileSync(FILE, text);
  console.log(`wrote ${FILE}`);
  process.exit(0);
}

let failed = 0;
const note = (name: string, ok: boolean, why = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${why ? ` (${why})` : ""}`);
};
const throws = (f: () => unknown): boolean => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

{
  let onDisk = "";
  try {
    onDisk = readFileSync(FILE, "utf8");
  } catch {
    // missing: reported below
  }
  note(
    "vectors-reproduce",
    onDisk === text,
    onDisk === ""
      ? "file missing"
      : onDisk === text
        ? `${buildTrackCapVectors().vectors.length} vectors`
        : "regenerate with --write and review the diff",
  );
}

{
  const cases: [Buffer, Buffer, string][] = [
    [
      Buffer.alloc(20, 0x0b),
      Buffer.from("Hi There"),
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    ],
    [
      Buffer.from("Jefe"),
      Buffer.from("what do ya want for nothing?"),
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    ],
    [
      Buffer.alloc(131, 0xaa),
      Buffer.from("Test Using Larger Than Block-Size Key - Hash Key First"),
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    ],
  ];
  note(
    "hmac-rfc4231",
    cases.every(
      ([k, m, want]) =>
        createHmac("sha256", k).update(m).digest("hex") === want,
    ),
  );
}

{
  const key = Buffer.alloc(32, 7);
  const a = mintTrackCap(key, {
    kind: "input",
    sub: "viewer-1",
    exp: 1767225900,
  });
  const b = mintTrackCap(key, {
    kind: "input",
    sub: "viewer-1",
    exp: 1767225900,
  });
  const parts = a.split(".");
  const payload =
    parts.length === 3
      ? Buffer.from(parts[1], "base64url").toString("utf8")
      : "";
  let keys: string[] = [];
  try {
    keys = Object.keys(JSON.parse(payload) as object);
  } catch {
    // reported below
  }
  note(
    "mint-shape",
    parts.length === 3 &&
      parts[0] === "cap1" &&
      /^[A-Za-z0-9_-]{43}$/.test(parts[2]) &&
      keys.join(",") === "v,kind,sub,exp,nonce" &&
      a !== b,
    payload,
  );
  note(
    "mint-refuses",
    throws(() =>
      mintTrackCap(Buffer.alloc(16), { kind: "input", sub: "v", exp: 1 }),
    ) &&
      throws(() => mintTrackCap(key, { kind: "input", sub: "a b", exp: 1 })) &&
      throws(() =>
        mintTrackCap(key, { kind: "input", sub: "v", exp: Date.now() + 0.5 }),
      ) &&
      throws(() =>
        mintTrackCapFor(key, "input", "v", CAP_MAX_LIFETIME_S + 1),
      ) &&
      !throws(() => mintTrackCapFor(key, "input", "v", CAP_MAX_LIFETIME_S)),
  );
}

note(
  "key-file",
  capKeyFromHex(`${"ab".repeat(32)}\n`).length === 32 &&
    throws(() => capKeyFromHex("AB".repeat(32))) &&
    throws(() => capKeyFromHex("ab".repeat(31))),
);

console.log(
  failed === 0
    ? "self-test-track-caps: PASS"
    : `self-test-track-caps: FAIL (${failed})`,
);
process.exit(failed === 0 ? 0 : 1);
