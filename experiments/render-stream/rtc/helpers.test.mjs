import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { serve } from "./serve.mjs";

const page = await readFile(
  new URL("./page/index.html", import.meta.url),
  "utf8",
);
const scope = {
  window: {},
  crypto: webcrypto,
  TextEncoder,
  Uint8Array,
  atob,
  btoa,
};
vm.runInNewContext(
  page.split("<script>")[1].split("// END PURE HELPERS")[0],
  scope,
);
const { credentials, answer, decodeFingerprint } = scope.window.rtcHelpers;
const fp = Uint8Array.from({ length: 32 }, (_, i) => i);
test("credential vector is shared with Rust", async () => {
  const got = await credentials(fp);
  assert.equal(got.ufrag, "LifiPYYP");
  assert.equal(got.pwd, "+LPHUKvgAC73FqV/esyr2EUG");
});
test("base64url fingerprint decodes raw bytes and rejects malformed input", () => {
  assert.deepEqual(
    decodeFingerprint(Buffer.from(fp).toString("base64url")),
    fp,
  );
  assert.throws(() => decodeFingerprint("bad"));
});
test("fabricated answer retains offer mid and uses CRLF", async () => {
  const sdp = answer(
    "v=0\r\na=mid:application42\r\n",
    "192.0.2.1",
    45000,
    fp,
    await credentials(fp),
  );
  assert.ok(sdp.endsWith("\r\na=end-of-candidates\r\n"));
  assert.ok(!sdp.replaceAll("\r\n", "").includes("\n"));
  for (const line of [
    "a=group:BUNDLE application42",
    "a=mid:application42",
    "a=ice-lite",
    "a=setup:passive",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
    "a=candidate:1 1 udp 2130706431 192.0.2.1 45000 typ host",
    "a=ice-pwd:+LPHUKvgAC73FqV/esyr2EUG",
    "m=application 45000 UDP/DTLS/SCTP webrtc-datachannel",
  ])
    assert.ok(sdp.split("\r\n").includes(line), line);
  assert.ok(
    sdp.includes(
      "a=fingerprint:sha-256 " +
        Array.from(fp, (b) =>
          b.toString(16).padStart(2, "0").toUpperCase(),
        ).join(":"),
    ),
  );
  assert.throws(() => answer("v=0", "192.0.2.1", 45000, fp, {}));
});
test("static server serves the standalone page only", async () => {
  const { server, url } = await serve();
  try {
    assert.equal(await (await fetch(`${url}?h=example`)).text(), page);
    assert.equal((await fetch(`${url}missing`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
