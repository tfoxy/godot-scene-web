// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { itemMetaRequestProblem } from "../../../experiments/render-stream/scripts/lib/render-stream-2";
import { mergeWants } from "../src/extensions";
import { clientHello, coreStartOptions } from "../src/hello";

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

  it("pins the /13 pure and TAG1 hello bytes", () => {
    const facts = {
      protocol: 13,
      creditWindow: 2,
      token: null,
      backing: [640, 360],
      css: [640, 360],
      dprMilli: 1000,
      gpuFormats: "none",
    } as const;
    const pure =
      '{"type":"hello","protocol":"render-stream/13","receiver":"gsw-render-stream-client","receiver_kind":"gsw-canvas","credit_stage":"submitted","credit_window":2,"inbound_buffer_bytes":16777216,"token":null,"manifest_sha256":null,"presentation_backing_w":640,"presentation_backing_h":360,"presentation_css_w":640,"presentation_css_h":360,"dpr_milli":1000,"texture_encodings":"decoded","gpu_formats":"none","live_coding":"zstd-base,zstd"}';
    const tag1 =
      pure.slice(0, -1) +
      ',"item_meta":{"fields":["class","scene","path"],"groups":["cards"],"meta_keys":["key"]}}';
    const encoded = (s: string) => new TextEncoder().encode(s);
    expect(
      encoded(
        JSON.stringify(clientHello({ ...facts, itemMeta: mergeWants([]) })),
      ),
    ).toEqual(encoded(pure));
    expect(
      encoded(
        JSON.stringify(
          clientHello({
            ...facts,
            itemMeta: mergeWants([
              {
                id: "tag1",
                wants: {
                  fields: ["path", "class", "scene"],
                  groups: ["cards"],
                  metaKeys: ["key"],
                },
              },
            ]),
          }),
        ),
      ),
    ).toEqual(encoded(tag1));
  });

  it.each([
    "instance_id",
    "mouse_filter",
  ] as const)("accepts %s only in /14 hellos and grants", (field) => {
    const request = { fields: [field], groups: [], meta_keys: [] };
    const facts = {
      protocol: 14,
      creditWindow: 2,
      token: null,
      backing: [640, 360],
      css: [640, 360],
      dprMilli: 1000,
      gpuFormats: "none",
      itemMeta: request,
    } as const;
    expect(clientHello(facts).item_meta).toEqual(request);
    expect(() => clientHello({ ...facts, protocol: 13 })).toThrow(/14/);
    expect(itemMetaRequestProblem(request, 14)).toBeNull();
    expect(itemMetaRequestProblem(request, 13)).not.toBeNull();
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

describe("coreStartOptions (PH2)", () => {
  it("asks the core for no record digests, at the endpoint's protocol", () => {
    for (const protocol of [11, 12, 13, 14]) {
      const o = JSON.parse(coreStartOptions(protocol));
      expect(o).toEqual({
        digest: "none",
        sabotage: [],
        format: "rgb10a2",
        texture_encodings: "decoded",
        live_protocol: protocol,
        log: "summary",
      });
    }
    // rs-gsw-wasm reads the option as the exact text `"digest":"none"` (parse_options).
    expect(coreStartOptions(12)).toContain('"digest":"none"');
  });
});
