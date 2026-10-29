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
