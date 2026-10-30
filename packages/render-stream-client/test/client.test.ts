import { describe, expect, it } from "vitest";
import {
  createRenderStreamClient,
  RenderStreamEndpointError,
} from "../src/index";
import type { RenderStreamStatus } from "../src/loop";

const endpoint = {
  url: "ws://127.0.0.1:1/render-stream",
  resourceBase: "",
  token: null,
  protocol: 12 as const,
};
const core = {
  glueUrl: "/core/rs_gsw_wasm_client.js",
  wasmUrl: "/core/rs_gsw_wasm_bg.wasm",
};

describe("createRenderStreamClient", () => {
  it("refuses bad extensions (TAG2), a bad credit window and a bad descriptor", () => {
    const canvas = document.createElement("canvas");
    // An extension that wants identities needs /13; ids are unique and non-empty.
    expect(() =>
      createRenderStreamClient({
        canvas,
        core,
        endpoint,
        extensions: [{ id: "x", wants: { groups: ["g"] } }],
      }),
    ).toThrow(/protocol 13/);
    expect(() =>
      createRenderStreamClient({
        canvas,
        core,
        endpoint,
        extensions: [{ id: "x" }, { id: "x" }],
      }),
    ).toThrow(/unique/);
    createRenderStreamClient({
      canvas,
      core,
      endpoint,
      extensions: [{ id: "x" }],
    }).dispose();
    expect(() =>
      createRenderStreamClient({
        canvas,
        core,
        endpoint,
        creditWindow: 3 as never,
      }),
    ).toThrow(/creditWindow/);
    expect(() =>
      createRenderStreamClient({
        canvas,
        core,
        endpoint: { ...endpoint, protocol: 9 as never },
      }),
    ).toThrow(RenderStreamEndpointError);
  });

  it("dispose is idempotent, before or after connect, and silences the client", async () => {
    const canvas = document.createElement("canvas");
    const statuses: RenderStreamStatus[] = [];
    const a = createRenderStreamClient({
      canvas,
      core,
      endpoint,
      onStatus: (s) => statuses.push(s),
    });
    a.dispose();
    a.dispose();
    a.connect();
    expect(statuses).toEqual([]);
    expect(a.stats()).toEqual({
      applied: 0,
      appliesPerSec: 0,
      creditRttMsP50: null,
      heapBytes: 0,
    });

    const b = createRenderStreamClient({
      canvas,
      core,
      endpoint,
      onStatus: (s) => statuses.push(s),
    });
    b.connect(); // the core load is in flight (and fails in jsdom)
    b.dispose();
    b.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(statuses).toEqual([{ kind: "connecting" }]);
  });

  it("reports a core that cannot load as core-load-failed", async () => {
    const canvas = document.createElement("canvas");
    const statuses: RenderStreamStatus[] = [];
    const c = createRenderStreamClient({
      canvas,
      core,
      endpoint,
      onStatus: (s) => statuses.push(s),
    });
    c.connect();
    await new Promise((r) => setTimeout(r, 20));
    expect(statuses.at(-1)).toMatchObject({
      kind: "failed",
      reason: "core-load-failed",
    });
    c.dispose();
  });
});
