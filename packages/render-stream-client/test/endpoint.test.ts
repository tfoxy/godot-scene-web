import { describe, expect, it } from "vitest";
import {
  RenderStreamEndpointError,
  sameEndpoint,
  validateEndpoint,
  webSocketUrl,
} from "../src/endpoint";

const ok = {
  url: "ws://127.0.0.1:13831/render-stream",
  resourceBase: "http://127.0.0.1:13831",
  token: null,
  protocol: 12,
};

describe("validateEndpoint", () => {
  it("accepts a descriptor and freezes a copy", () => {
    const e = validateEndpoint({
      ...ok,
      token: "0".repeat(64),
      presentation: [1920, 1080],
    });
    expect(e).toEqual({
      ...ok,
      token: "0".repeat(64),
      presentation: [1920, 1080],
    });
    expect(Object.isFrozen(e)).toBe(true);
    expect(
      validateEndpoint({ ...ok, url: "/render-stream", resourceBase: "" }).url,
    ).toBe("/render-stream");
  });

  it.each([
    ["not an object", null],
    ["unknown key", { ...ok, extra: 1 }],
    ["empty url", { ...ok, url: " " }],
    ["bad scheme", { ...ok, url: "ftp://x/render-stream" }],
    ["trailing slash", { ...ok, resourceBase: "http://h/" }],
    ["uppercase token", { ...ok, token: "A".repeat(64) }],
    ["short token", { ...ok, token: "a".repeat(63) }],
    ["protocol 10", { ...ok, protocol: 10 }],
    ["protocol 14", { ...ok, protocol: 14 }],
    ["protocol string", { ...ok, protocol: "12" }],
    ["presentation 0", { ...ok, presentation: [0, 1] }],
    ["presentation shape", { ...ok, presentation: [1] }],
  ])("refuses %s", (_why, value) => {
    expect(() => validateEndpoint(value)).toThrow(RenderStreamEndpointError);
  });

  const wtOk = { url: "https://127.0.0.1:4433/render-stream" };
  it.each([
    ["webTransport not an object", "https://h/x"],
    ["webTransport array", []],
    ["webTransport without url", {}],
    ["webTransport http url", { url: "http://h/x" }],
    ["webTransport wss url", { url: "wss://h/x" }],
    ["webTransport relative url", { url: "/render-stream" }],
    ["webTransport unknown key", { ...wtOk, protocols: [] }],
    ["empty hash list", { ...wtOk, certificateHashes: [] }],
    [
      "five hashes",
      { ...wtOk, certificateHashes: Array(5).fill("a".repeat(64)) },
    ],
    ["uppercase hash", { ...wtOk, certificateHashes: ["A".repeat(64)] }],
    ["short hash", { ...wtOk, certificateHashes: ["a".repeat(63)] }],
    ["hash not a string", { ...wtOk, certificateHashes: [1] }],
    ["hashes not an array", { ...wtOk, certificateHashes: "a".repeat(64) }],
  ])("refuses %s", (_why, webTransport) => {
    expect(() => validateEndpoint({ ...ok, webTransport })).toThrow(
      RenderStreamEndpointError,
    );
  });

  it("accepts a webTransport key, frozen, and compares it by value", () => {
    const hashes = ["a".repeat(64), "b".repeat(64)];
    const e = validateEndpoint({
      ...ok,
      webTransport: { ...wtOk, certificateHashes: hashes },
    });
    expect(e.webTransport).toEqual({ ...wtOk, certificateHashes: hashes });
    expect(Object.isFrozen(e.webTransport)).toBe(true);
    expect(
      validateEndpoint({ ...ok, webTransport: wtOk }).webTransport,
    ).toEqual(wtOk);
    expect(validateEndpoint(ok).webTransport).toBeUndefined();
    expect("webTransport" in validateEndpoint(ok)).toBe(false);
    expect(
      sameEndpoint(
        e,
        validateEndpoint({
          ...ok,
          webTransport: { ...wtOk, certificateHashes: [...hashes] },
        }),
      ),
    ).toBe(true);
    expect(sameEndpoint(e, validateEndpoint(ok))).toBe(false);
    expect(
      sameEndpoint(e, validateEndpoint({ ...ok, webTransport: wtOk })),
    ).toBe(false);
    expect(
      sameEndpoint(
        validateEndpoint({ ...ok, webTransport: wtOk }),
        validateEndpoint({
          ...ok,
          webTransport: { url: "https://h:1/render-stream" },
        }),
      ),
    ).toBe(false);
  });

  it("accepts render-stream/13 (W13c), opt-in beside the default 12", () => {
    expect(validateEndpoint({ ...ok, protocol: 13 }).protocol).toBe(13);
  });

  it("compares descriptors by value", () => {
    const a = validateEndpoint(ok);
    expect(sameEndpoint(a, validateEndpoint({ ...ok }))).toBe(true);
    expect(sameEndpoint(a, validateEndpoint({ ...ok, protocol: 11 }))).toBe(
      false,
    );
    expect(
      sameEndpoint(a, validateEndpoint({ ...ok, presentation: [2, 2] })),
    ).toBe(false);
  });

  it("maps a page-relative url onto the page's ws(s) origin", () => {
    expect(webSocketUrl("/render-stream", "http://127.0.0.1:5190/app/")).toBe(
      "ws://127.0.0.1:5190/render-stream",
    );
    expect(webSocketUrl("/rs", "https://h.example/")).toBe(
      "wss://h.example/rs",
    );
    expect(webSocketUrl("ws://a:1/render-stream", "https://h/")).toBe(
      "ws://a:1/render-stream",
    );
  });
});
