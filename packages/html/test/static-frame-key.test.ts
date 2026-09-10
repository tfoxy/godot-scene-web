import { describe, expect, it } from "vitest";

import {
  invalidateStaticFrameKey,
  type NodeBinding,
  syncCanvasSizeForTest,
} from "../src/webgl/runtime";
import {
  memoStaticFrameKey,
  parseAtlasRegion,
  staticFrameKey,
} from "../src/webgl/shader-backend";

// The key is deliberately renderer-agnostic.  Keep its mutation audit here rather than behind a
// WebGL context: WebGL uses it to address a bitmap cache and WebGPU uses the exact same name to
// prove a captured frozen surface is stable.
function binding(): NodeBinding {
  return {
    shaderKey: "res://shader|with-delimiters.gdshader",
    fit: "cover",
    textureUrl: "res://page|one.png",
    textureRepeat: false,
    textureRegion: { x: 1, y: 2, width: 32, height: 16 },
    texture: { width: 64, height: 64, loaded: true, listeners: new Set() },
    modulateKey: "1,1,1,1",
    samplers: [
      {
        name: "noise|sampler",
        unit: 1,
        frameIdentity: ["url", "res://noise|one.png", false],
        entry: { width: 16, height: 16, loaded: true, listeners: new Set() },
      },
    ],
    windowKey: "0,0,1,1",
    paramsKey: '{"amount":0.25}',
    paramKindsKey: '{"amount":"float"}',
    staticKeyEpoch: 0,
    staticKeyMemo: null,
  } as unknown as NodeBinding;
}

describe("staticFrameKey", () => {
  it("uses unambiguous framing and canonical atlas-region values", () => {
    const a = binding();
    const b = binding();
    // These are the same parsed atlas rectangle (`Number("1.0")`, whitespace and -0 all normalize
    // before reaching the binding), so they share one frozen frame.
    a.textureRegion = parseAtlasRegion(" 1.0, 2, 32, 16 ");
    b.textureRegion = parseAtlasRegion("1, 2.00, 32.0, 16");

    const key = staticFrameKey(a, 100, 50, 1);
    expect(key).toBe(staticFrameKey(b, 100, 50, 1));
    expect(JSON.parse(key)[0]).toBe("gsw-static-frame/v2");

    // The old delimiter format could not distinguish strings containing `|`; JSON framing can.
    b.textureUrl = "res://page";
    b.samplers[0].frameIdentity = ["url", "one.png|noise|sampler", false];
    expect(staticFrameKey(b, 100, 50, 1)).not.toBe(key);
  });

  it("changes for every visual input, including same-size source replacements", () => {
    const base = binding();
    const baseline = staticFrameKey(base, 100, 50, 1);
    const mutations: Array<(value: NodeBinding) => void> = [
      (value) => {
        value.shaderKey = "res://other.gdshader";
      },
      (value) => {
        value.fit = "contain";
      },
      (value) => {
        value.textureUrl = "res://other-page.png";
      },
      (value) => {
        value.textureRepeat = true;
      },
      // Same atlas size, different crop: dimensions alone cannot distinguish this frame.
      (value) => {
        value.textureRegion = { x: 2, y: 2, width: 32, height: 16 };
      },
      (value) => {
        value.texture.width = 63;
      },
      (value) => {
        value.modulateKey = "0.5,1,1,1";
      },
      (value) => {
        value.samplers[0].name = "other";
      },
      // Same sampler dimensions, a different URL must miss.
      (value) => {
        value.samplers[0].frameIdentity = [
          "url",
          "res://other-noise.png",
          false,
        ];
      },
      // Repeat changes sampling even when the source and dimensions do not.
      (value) => {
        value.samplers[0].frameIdentity = ["url", "res://noise|one.png", true];
      },
      (value) => {
        value.samplers[0].frameIdentity = [
          "bake",
          '{"kind":"gradient","width":16}',
          false,
        ];
      },
      (value) => {
        value.samplers[0].entry.height = 15;
      },
      (value) => {
        value.windowKey = "0.01,0,1,1";
      },
      (value) => {
        value.paramsKey = '{"amount":0.5}';
      },
      (value) => {
        value.paramKindsKey = '{"amount":"int"}';
      },
    ];

    for (const mutate of mutations) {
      const candidate = binding();
      mutate(candidate);
      expect(staticFrameKey(candidate, 100, 50, 1)).not.toBe(baseline);
    }
    // Render-call coordinates are inputs too: resize / density reallocation and a different frozen
    // TIME cannot reuse the memo or the frame cache.
    expect(staticFrameKey(base, 101, 50, 1)).not.toBe(baseline);
    expect(staticFrameKey(base, 100, 50, 2)).not.toBe(baseline);
  });

  it("memoizes only within an epoch and invalidates every settled/write path through one helper", () => {
    const value = binding();
    const first = memoStaticFrameKey(value, 100, 50, 1.001);
    const firstMemo = value.staticKeyMemo;
    // The key rounds TIME to hundredths, so the memo must use that same coordinate. Capturing the
    // object proves this is a memo hit rather than a coincidentally equal re-serialized string.
    expect(memoStaticFrameKey(value, 100, 50, 1.004)).toBe(first);
    expect(value.staticKeyMemo).toBe(firstMemo);

    // A same-size decode/source settlement changes the actual sampled pixels but not necessarily
    // dimensions. Runtime texture listeners call this helper for node and sampler settlements.
    value.samplers[0].frameIdentity = ["url", "res://settled.png", false];
    expect(memoStaticFrameKey(value, 100, 50, 1)).toBe(first);
    invalidateStaticFrameKey(value);
    const settled = memoStaticFrameKey(value, 100, 50, 1);
    expect(settled).not.toBe(first);

    // Canvas sizing has the same invalidation path; dimensions also form explicit memo coordinates
    // so a ratio/ResizeObserver reallocation cannot accidentally share a previous frame.
    const canvas = document.createElement("canvas");
    Object.assign(value, {
      canvas,
      selfLayer: document.createElement("div"),
      boxMeasured: true,
      boxW: 100,
      boxH: 50,
      window: [0, 0, 1, 1],
      pixelRatioScale: 2,
    });
    const beforeResizeEpoch = value.staticKeyEpoch;
    syncCanvasSizeForTest(value, 1);
    expect(value.staticKeyEpoch).toBe(beforeResizeEpoch + 1);
    expect(memoStaticFrameKey(value, 200, 100, 1)).not.toBe(settled);
  });
});
