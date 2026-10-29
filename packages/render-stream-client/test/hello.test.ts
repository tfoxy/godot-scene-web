// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientHello } from "../src/hello";

const golden = (v: 11 | 12) =>
  JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        `experiments/render-stream/protocol/golden-${v}/control/valid/hello-live-coding.json`,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;

describe("clientHello", () => {
  it.each([
    11, 12,
  ] as const)("has golden-%i's control hello keys in order", (v) => {
    const hello = clientHello({
      protocol: v,
      creditWindow: 2,
      token: null,
      backing: [640, 360],
      css: [640, 360],
      dprMilli: 1000,
      gpuFormats: "s3tc,bptc,rgtc",
    });
    const g = golden(v);
    expect(Object.keys(hello)).toEqual(Object.keys(g));
    expect(hello).toEqual({
      ...g,
      receiver: "gsw-render-stream-client",
      receiver_kind: "gsw-canvas",
      credit_window: 2,
      texture_encodings: "decoded",
    });
  });

  it("offers render-stream/13 with /12's hello under the /13 protocol (W13c)", () => {
    const facts = {
      creditWindow: 2,
      token: null,
      backing: [640, 360],
      css: [640, 360],
      dprMilli: 1000,
      gpuFormats: "s3tc,bptc,rgtc",
    } as const;
    const h13 = clientHello({ ...facts, protocol: 13 });
    const h12 = clientHello({ ...facts, protocol: 12 });
    expect(Object.keys(h13)).toEqual(Object.keys(h12));
    expect(h13).toEqual({ ...h12, protocol: "render-stream/13" });
  });

  it("carries the token only in the hello field", () => {
    const token = "a".repeat(64);
    const hello = clientHello({
      protocol: 12,
      creditWindow: 1,
      token,
      backing: [1920, 1080],
      css: [960, 540],
      dprMilli: 2000,
      gpuFormats: "none",
    });
    expect(hello.token).toBe(token);
    expect(hello.presentation_css_w).toBe(960);
    expect(hello.dpr_milli).toBe(2000);
    expect(hello.credit_window).toBe(1);
  });
});
