// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { itemMetaRequestProblem } from "../../../experiments/render-stream/scripts/lib/render-stream-2";
import { mergeWants } from "../src/extensions";
import {
  clientHello,
  clientProtocol,
  clientTextureEncodings,
  coreStartOptions,
} from "../src/hello";

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
      // Block families stated: the game's own block bytes are welcome (F2).
      texture_encodings: "block,decoded",
    });
  });

  it.each([
    ["s3tc,bptc,rgtc", "block,decoded"],
    ["etc2,astc", "block,decoded"],
    ["bptc", "block,decoded"],
    ["none", "decoded"],
    ["", "decoded"],
  ])("offers %s as texture_encodings %s, never uastc (F2)", (gpuFormats, enc) => {
    const hello = clientHello({
      protocol: 13,
      creditWindow: 2,
      token: null,
      backing: [640, 360],
      css: [640, 360],
      dprMilli: 1000,
      gpuFormats,
    });
    expect(hello.texture_encodings).toBe(enc);
    expect(hello.texture_encodings).not.toContain("uastc");
    expect(clientTextureEncodings(gpuFormats)).toBe(enc);
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
  it("damage redraw is opt-in and composes with transparent clear", () => {
    expect(coreStartOptions(16, true, false, false)).toBe(coreStartOptions(16));
    expect(JSON.parse(coreStartOptions(16, false, true, true))).toMatchObject({
      damage_redraw: true,
      transparent_clear: true,
      viewports: false,
    });
  });

  it("keeps the default options identical and adds transparent_clear only when enabled", () => {
    for (const protocol of [12, 13, 16]) {
      for (const viewports of [true, false]) {
        const original = coreStartOptions(protocol, viewports);
        expect(coreStartOptions(protocol, viewports, false)).toBe(original);
        expect(original).not.toContain("transparent_clear");
        expect(coreStartOptions(protocol, viewports, true)).toBe(
          `${original.replace('"rgb10a2"', '"rgba8"').slice(0, -1)},"transparent_clear":true}`,
        );
      }
    }
  });

  it("asks the core for no record digests, at the endpoint's protocol", () => {
    for (const protocol of [11, 12, 13, 14, 15, 16]) {
      const o = JSON.parse(coreStartOptions(protocol));
      expect(o).toEqual({
        digest: "none",
        sabotage: [],
        format: "rgb10a2",
        texture_encodings: "block,decoded",
        live_protocol: protocol,
        log: "summary",
      });
    }
    // rs-gsw-wasm reads the option as the exact text `"digest":"none"` (parse_options).
    expect(coreStartOptions(12)).toContain('"digest":"none"');
  });

  it("adds viewports:false only when asked (render-stream/16 D3)", () => {
    expect(coreStartOptions(16, true)).toBe(coreStartOptions(16));
    expect(JSON.parse(coreStartOptions(16, false))).toEqual({
      ...JSON.parse(coreStartOptions(16)),
      viewports: false,
    });
    // rs-gsw-wasm reads the option as the exact text `"viewports":false` (parse_options).
    expect(coreStartOptions(16, false)).toContain('"viewports":false');
    expect(coreStartOptions(16)).not.toContain("viewports");
  });
});

describe("clientProtocol and resource hints (render-stream/15)", () => {
  const v1 = { fields: ["node_path"], groups: [], meta_keys: [] };
  const v2 = { fields: ["instance_id"], groups: [], meta_keys: [] };

  it("without resourceHints offers what it offered before /15", () => {
    for (const p of [11, 12, 13, 14] as const) {
      expect(clientProtocol(p, null)).toBe(p);
      expect(clientProtocol(p, null, false)).toBe(p);
    }
    expect(clientProtocol(13, v1)).toBe(13);
    expect(clientProtocol(13, v2)).toBe(14);
    expect(clientProtocol(14, v1)).toBe(14);
  });

  it("speaks /13 (or /14 for v2 wants) to a /15 endpoint without resourceHints", () => {
    expect(clientProtocol(15, null)).toBe(13);
    expect(clientProtocol(15, v1)).toBe(13);
    expect(clientProtocol(15, v2)).toBe(14);
  });

  it("offers /15 with resourceHints from protocol 13 up, item_meta v2 included", () => {
    for (const p of [13, 14, 15] as const) {
      expect(clientProtocol(p, null, true)).toBe(15);
      expect(clientProtocol(p, v2, true)).toBe(15);
    }
    expect(() => clientProtocol(12, null, true)).toThrow(/13/);
    expect(() => clientProtocol(11, null, true)).toThrow(/13/);
  });

  it("offers exactly /16 to a /16 endpoint: no upgrade, no fallback, hints and v2 wants included", () => {
    expect(clientProtocol(16, null)).toBe(16);
    expect(clientProtocol(16, null, false)).toBe(16);
    expect(clientProtocol(16, null, true)).toBe(16);
    expect(clientProtocol(16, v1)).toBe(16);
    expect(clientProtocol(16, v2)).toBe(16);
    expect(clientProtocol(16, v2, true)).toBe(16);
    expect(() => clientProtocol(16, v1)).not.toThrow();
  });

  it("states /16 in a hello that is otherwise /15's", () => {
    const facts = {
      creditWindow: 2,
      token: null,
      backing: [640, 360],
      css: [640, 360],
      dprMilli: 1000,
      gpuFormats: "none",
      itemMeta: v2,
    } as const;
    const h15 = clientHello({ ...facts, protocol: 15 });
    const h16 = clientHello({ ...facts, protocol: 16 });
    expect(Object.keys(h16)).toEqual(Object.keys(h15));
    expect(h16).toEqual({ ...h15, protocol: "render-stream/16" });
  });

  it("states /15 in a hello that is otherwise /14's, v2 fields allowed", () => {
    const facts = {
      creditWindow: 2,
      token: null,
      backing: [640, 360],
      css: [640, 360],
      dprMilli: 1000,
      gpuFormats: "none",
      itemMeta: v2,
    } as const;
    const h14 = clientHello({ ...facts, protocol: 14 });
    const h15 = clientHello({ ...facts, protocol: 15 });
    expect(Object.keys(h15)).toEqual(Object.keys(h14));
    expect(h15).toEqual({ ...h14, protocol: "render-stream/15" });
    expect(h15.item_meta).toEqual(v2);
  });
});
