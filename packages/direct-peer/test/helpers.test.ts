// @vitest-environment node
import { readFileSync } from "node:fs";
import {
  buildLiteAnswer,
  DirectPeerError,
  deriveIceCredentials,
  formatFingerprintHex,
  ICE_CREDENTIAL_PREFIX,
  parseFingerprint,
} from "@godot-scene-web/direct-peer";
import { describe, expect, it } from "vitest";

const fp = Uint8Array.from({ length: 32 }, (_, i) => i);
const base64url = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const hex =
  "00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F";
const credentials = { ufrag: "LifiPYYP", pwd: "+LPHUKvgAC73FqV/esyr2EUG" };
const options = { ip: "192.0.2.1", port: 45000, fingerprint: fp, credentials };

describe("fingerprints and credentials", () => {
  it("pins the shared G0/Rust/C# known-answer vector", async () => {
    expect(ICE_CREDENTIAL_PREFIX).toBe("couch-tunnel/1 ice");
    expect(parseFingerprint(base64url)).toEqual(fp);
    expect(await deriveIceCredentials(fp)).toEqual(credentials);
  });
  it("supports a generic credential domain override", async () => {
    expect(await deriveIceCredentials(fp, "another protocol")).toEqual({
      ufrag: "mbIo+CXG",
      pwd: "OQ3fgY4ny+YwCZkkRTU4G2DS",
    });
  });
  it("parses uppercase and lowercase colon hex and formats uppercase", () => {
    expect(parseFingerprint(hex)).toEqual(fp);
    expect(parseFingerprint(hex.toLowerCase())).toEqual(fp);
    expect(formatFingerprintHex(fp)).toBe(hex);
  });
  it.each([
    "",
    "bad",
    `${base64url}=`,
    base64url.replace(/8$/, "9"),
    hex.slice(3),
    `${"gg:".repeat(31)}gg`,
    ` ${base64url}`,
  ])("rejects malformed fingerprint %s", (text) => {
    expect(() => parseFingerprint(text)).toThrow(DirectPeerError);
    expect(() => parseFingerprint(text)).toThrow(
      expect.objectContaining({ code: "invalid-fingerprint" }),
    );
  });
  it("rejects raw fingerprints with the wrong digest length", async () => {
    expect(() => formatFingerprintHex(new Uint8Array(31))).toThrow(
      DirectPeerError,
    );
    await expect(
      deriveIceCredentials(new Uint8Array(33)),
    ).rejects.toMatchObject({ code: "invalid-fingerprint" });
  });
});

// Chromium and WebKit fixtures are unmodified local createOffer() captures (no ICE gathering).
const captured = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/${name}-offer.json`, import.meta.url),
      "utf8",
    ),
  ) as string;
// Firefox-shaped sample; Firefox is not installed locally. Its data m-section uses a named mid.
const firefox = [
  "v=0",
  "o=mozilla...THIS_IS_SDPARTA-99.0 123456789 0 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE sdparta_0",
  "a=ice-options:trickle",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=mid:sdparta_0",
  "a=ice-ufrag:sample",
  "a=ice-pwd:samplePasswordForTesting",
  `a=fingerprint:sha-256 ${hex}`,
  "a=setup:actpass",
  "a=sctp-port:5000",
  "a=max-message-size:1073741823",
  "",
].join("\r\n");

describe("ICE-lite answer", () => {
  it.each([
    ["Chromium", captured("chromium"), "0"],
    ["Safari/WebKit", captured("webkit"), "0"],
    ["Firefox-shaped", firefox, "sdparta_0"],
  ])("answers a %s offer with the exact G0 shape", (_, offer, mid) => {
    expect(buildLiteAnswer(offer, options)).toBe(
      [
        "v=0",
        "o=- 123456789 2 IN IP4 127.0.0.1",
        "s=-",
        "t=0 0",
        `a=group:BUNDLE ${mid}`,
        "a=ice-lite",
        "m=application 45000 UDP/DTLS/SCTP webrtc-datachannel",
        "c=IN IP4 192.0.2.1",
        `a=mid:${mid}`,
        "a=ice-ufrag:LifiPYYP",
        "a=ice-pwd:+LPHUKvgAC73FqV/esyr2EUG",
        `a=fingerprint:sha-256 ${hex}`,
        "a=setup:passive",
        "a=sctp-port:5000",
        "a=max-message-size:262144",
        "a=candidate:1 1 udp 2130706431 192.0.2.1 45000 typ host",
        "a=end-of-candidates",
        "",
      ].join("\r\n"),
    );
  });
  it("selects the application mid rather than an earlier media mid", () => {
    const offer = `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\n${firefox.slice(firefox.indexOf("m=application"))}`;
    expect(buildLiteAnswer(offer, options)).toContain(
      "a=group:BUNDLE sdparta_0\r\n",
    );
  });
  it("supports IPv6 and an explicit maximum message size", () => {
    const answer = buildLiteAnswer(firefox, {
      ...options,
      ip: "2001:db8::1",
      maxMessageSize: 65536,
    });
    expect(answer).toContain("c=IN IP6 2001:db8::1\r\n");
    expect(answer).toContain(
      "a=candidate:1 1 udp 2130706431 2001:db8::1 45000 typ host\r\n",
    );
    expect(answer).toContain("a=max-message-size:65536\r\n");
    expect(answer.replaceAll("\r\n", "")).not.toContain("\n");
  });
  it.each([
    "v=0\r\na=mid:session\r\n",
    "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\n",
    "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
    "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\n",
  ])("rejects offers lacking an application section with its own mid", (offer) => {
    expect(() => buildLiteAnswer(offer, options)).toThrow(
      expect.objectContaining({ code: "invalid-offer" }),
    );
  });
});
