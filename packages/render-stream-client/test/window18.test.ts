// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeRecording,
  resolveRecording,
  validateRecording,
  wireVersionOf,
} from "../../../experiments/render-stream/scripts/lib/render-stream-2";
import { validateEndpoint } from "../src/endpoint";
import { clientHello, clientProtocol } from "../src/hello";
import { StreamLoop } from "../src/loop";
import { ENDPOINT, FakeClock, FakeCore, FakeTransport } from "./fakes";

const dir = join(process.cwd(), "experiments/render-stream/protocol/golden-18");
const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
  valid: { file: string }[];
  invalid: { file: string; version: number; code: string }[];
};
const bytes = (file: string) => new Uint8Array(readFileSync(join(dir, file)));

describe("render-stream/18 credit range", () => {
  it.each(index.valid)("accepts and resolves $file", ({ file }) => {
    const data = bytes(file);
    expect(wireVersionOf(data)).toBe(18);
    expect(validateRecording(data, 18)).toEqual([]);
    expect(decodeRecording(data, 18).schema).toBe("render-stream-18-decoded/1");
    expect(resolveRecording(data, 18).schema).toBe(
      "render-stream-18-resolved/1",
    );
  });
  it.each(index.invalid)("rejects $file with $code", ({
    file,
    version,
    code,
  }) => {
    expect(
      validateRecording(
        bytes(file),
        version as Parameters<typeof validateRecording>[1],
      )[0],
    ).toMatch(new RegExp(`^${code}:`));
  });
  it("offers /18 without an upgrade or downgrade and preserves the hello's key order", () => {
    expect(
      validateEndpoint({
        url: "/render-stream",
        resourceBase: "",
        token: null,
        protocol: 18,
      }).protocol,
    ).toBe(18);
    expect(clientProtocol(18, undefined, false)).toBe(18);
    expect(clientProtocol(18, undefined, true)).toBe(18);
    const facts = {
      creditWindow: 2 as const,
      token: null,
      backing: [640, 360] as [number, number],
      css: [640, 360] as [number, number],
      dprMilli: 1000,
      gpuFormats: "none",
    };
    const old = clientHello({ ...facts, protocol: 16 });
    const hello = clientHello({ ...facts, protocol: 18, creditWindow: 8 });
    expect(Object.keys(hello)).toEqual(Object.keys(old));
    expect(hello).toEqual({
      ...old,
      protocol: "render-stream/18",
      credit_window: 8,
    });
    expect(() =>
      clientHello({ ...facts, protocol: 16, creditWindow: 3 }),
    ).toThrow(/creditWindow/);
  });
  it("requires an explicit /19 endpoint for material playback", () => {
    expect(validateEndpoint({ ...ENDPOINT, protocol: 19 }).protocol).toBe(19);
    for (const protocol of [17, 18, 19] as const) {
      for (const enabled of [false, true]) {
        expect(clientProtocol(protocol, undefined, true, enabled)).toBe(
          protocol,
        );
        const hello = clientHello({
          protocol,
          clientTweens: enabled,
          creditWindow: 2,
          token: null,
          backing: [640, 360],
          css: [640, 360],
          dprMilli: 1000,
          gpuFormats: "none",
        });
        expect(hello.protocol).toBe(`render-stream/${protocol}`);
        expect(hello.client_tweens).toBe(enabled ? true : undefined);
        if (enabled) expect(Object.keys(hello).at(-1)).toBe("client_tweens");
      }
    }
  });
  it("carries the last tween hello key on /18 and forbids tween downgrades", () => {
    expect(clientProtocol(18, undefined, false, true)).toBe(18);
    expect(clientProtocol(17, undefined, false, true)).toBe(17);
    expect(() => clientProtocol(16, undefined, false, true)).toThrow(
      /clientTweens/,
    );
    const facts = {
      protocol: 18 as const,
      creditWindow: 8 as const,
      token: null,
      backing: [640, 360] as [number, number],
      css: [640, 360] as [number, number],
      dprMilli: 1000,
      gpuFormats: "none",
      clientTweens: true,
    };
    const hello = clientHello(facts);
    expect(hello.client_tweens).toBe(true);
    expect(hello.credit_window).toBe(8);
    expect(Object.keys(hello).at(-1)).toBe("client_tweens");
    expect(() => clientHello({ ...facts, protocol: 17 })).toThrow(
      /creditWindow/,
    );
    expect(() =>
      clientHello({ ...facts, protocol: 16, creditWindow: 2 }),
    ).toThrow(/clientTweens/);
  });
  it.each([
    17, 18, 19,
  ] as const)("sends the default window with tweens on /%i", (protocol) => {
    let transport: FakeTransport | undefined;
    const loop = new StreamLoop({
      core: new FakeCore(),
      clock: new FakeClock(),
      endpoint: { ...ENDPOINT, protocol },
      clientTweens: true,
      onStatus: () => {},
      canvas: () => ({
        backing: [640, 360],
        css: [640, 360],
        dprMilli: 1000,
        gpuFormats: "none",
      }),
      transport: (_endpoint, sub, on) =>
        (transport = new FakeTransport(sub, on)),
    });
    loop.connect();
    transport!.on.open();
    expect(transport!.sent[0]).toMatchObject({
      protocol: `render-stream/${protocol}`,
      credit_window: protocol >= 18 ? 8 : 2,
      client_tweens: true,
    });
    loop.dispose();
  });
});
