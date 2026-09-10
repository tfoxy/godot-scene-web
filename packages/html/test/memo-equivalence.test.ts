// The hot pure builders (HSV color matrix, SVG/atlas crop data URLs, layered BBCode) are memoized
// behind module-scoped LRUs. The contract is PURE EQUIVALENCE: a cache hit must be indistinguishable
// from a fresh compute, so every test here compares a warm result against a cold one (the memos
// expose `__reset…ForTest` hooks precisely so a test can force the cold path).
import { resolveGodotSceneTree as resolveSceneTreeFromGraph } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetAtlasDataUrlCacheForTest,
  atlasTextureDataUrl,
} from "../src/atlas";
import type { ColorMatrix } from "../src/css-values";
import { renderSceneToHtmlModel as renderTreeToHtmlModel } from "../src/index";
import {
  __resetHsvColorMatrixCacheForTest,
  hsvColorMatrix,
} from "../src/material";
import {
  __resetRichTextLayeredCacheForTest,
  richTextLayeredHtml,
} from "../src/text";
import { __resetSvgImageDataUrlCacheForTest } from "../src/textures";

function resetAllMemos(): void {
  __resetHsvColorMatrixCacheForTest();
  __resetAtlasDataUrlCacheForTest();
  __resetSvgImageDataUrlCacheForTest();
  __resetRichTextLayeredCacheForTest();
}

beforeEach(resetAllMemos);

// ---- hsvColorMatrix --------------------------------------------------------------------------

const HSV_TRIPLES: Array<[number, number, number]> = [
  [1, 1, 1],
  [1, 1, 0.9],
  [0.5, 1, 1],
  [0, 0, 0],
  [0.25, 0.75, 1.5],
  [1.0000001, 1, 1],
];

describe("hsvColorMatrix memo", () => {
  it("returns byte-identical rows warm and cold", () => {
    for (const [h, s, v] of HSV_TRIPLES) {
      resetAllMemos();
      const cold = hsvColorMatrix(h, s, v);
      const coldJson = JSON.stringify(cold);
      const warm = hsvColorMatrix(h, s, v);
      expect(JSON.stringify(warm)).toBe(coldJson);
      // Recomputed from scratch after a reset: still byte-identical.
      resetAllMemos();
      expect(JSON.stringify(hsvColorMatrix(h, s, v))).toBe(coldJson);
    }
  });

  it("serves a repeat call from the cache (same instance) and a fresh one after reset", () => {
    const first = hsvColorMatrix(0.3, 0.6, 0.9);
    expect(hsvColorMatrix(0.3, 0.6, 0.9)).toBe(first);
    __resetHsvColorMatrixCacheForTest();
    const afterReset = hsvColorMatrix(0.3, 0.6, 0.9);
    expect(afterReset).not.toBe(first);
    expect(afterReset).toEqual(first);
  });

  it("keeps every triple distinct past the LRU cap (an evicted key recomputes correctly)", () => {
    const probe = hsvColorMatrix(0.11, 0.22, 0.33);
    const probeJson = JSON.stringify(probe);
    // 200 distinct triples on a cap of 64 → the probe is long evicted.
    for (let i = 0; i < 200; i += 1) {
      hsvColorMatrix(i / 200, 1, 1);
    }
    const again = hsvColorMatrix(0.11, 0.22, 0.33);
    expect(again).not.toBe(probe); // evicted, so genuinely recomputed
    expect(JSON.stringify(again)).toBe(probeJson);
  });

  it("does not collide -0 with 0 (they are different inputs)", () => {
    const positive = hsvColorMatrix(1, 1, 0);
    const negative = hsvColorMatrix(1, 1, -0);
    expect(negative).not.toBe(positive);
    resetAllMemos();
    expect(JSON.stringify(hsvColorMatrix(1, 1, -0))).toBe(
      JSON.stringify(negative),
    );
  });
});

// ---- atlasTextureDataUrl ---------------------------------------------------------------------

const TINT: ColorMatrix = {
  rows: [
    [0.5, 0, 0],
    [0, 0.25, 0],
    [0, 0, 1],
  ],
};

describe("atlasTextureDataUrl memo", () => {
  const atlasSize = { width: 256, height: 128 };
  const region = { x: 16, y: 32, width: 48, height: 24 };
  const margin = { x: 2, y: 3, width: 4, height: 5 };

  it("returns the identical string warm and cold, tinted and untinted", () => {
    for (const tint of [undefined, TINT]) {
      resetAllMemos();
      const cold = atlasTextureDataUrl(
        "res://atlas.png",
        atlasSize,
        region,
        margin,
        tint,
      );
      expect(
        atlasTextureDataUrl("res://atlas.png", atlasSize, region, margin, tint),
      ).toBe(cold);
      resetAllMemos();
      expect(
        atlasTextureDataUrl("res://atlas.png", atlasSize, region, margin, tint),
      ).toBe(cold);
    }
  });

  it("keys on every input — a change in any of them yields a different URL", () => {
    const base = atlasTextureDataUrl(
      "res://a.png",
      atlasSize,
      region,
      margin,
      undefined,
    );
    const variants = [
      atlasTextureDataUrl("res://b.png", atlasSize, region, margin, undefined),
      atlasTextureDataUrl(
        "res://a.png",
        { width: 512, height: 128 },
        region,
        margin,
        undefined,
      ),
      atlasTextureDataUrl(
        "res://a.png",
        atlasSize,
        { ...region, x: 17 },
        margin,
        undefined,
      ),
      atlasTextureDataUrl(
        "res://a.png",
        atlasSize,
        region,
        { ...margin, width: 9 },
        undefined,
      ),
      atlasTextureDataUrl("res://a.png", atlasSize, region, margin, TINT),
    ];
    for (const variant of variants) expect(variant).not.toBe(base);
  });

  it("cannot alias when a url contains the key separator", () => {
    // The url is the LAST key field for exactly this reason.
    const a = atlasTextureDataUrl(
      "res://x|0,0,1,1|.png",
      atlasSize,
      region,
      margin,
      undefined,
    );
    const b = atlasTextureDataUrl(
      "res://x",
      atlasSize,
      region,
      margin,
      undefined,
    );
    expect(a).not.toBe(b);
    resetAllMemos();
    expect(
      atlasTextureDataUrl(
        "res://x|0,0,1,1|.png",
        atlasSize,
        region,
        margin,
        undefined,
      ),
    ).toBe(a);
  });
});

// ---- richTextLayeredHtml ---------------------------------------------------------------------

const BBCODE_CASES = [
  "plain text",
  "[center][b]Deal[/b] [color=#ff0000]6[/color] damage[/center]",
  "line one\nline two",
  "[wave]shaky[/wave] and [font_size=24]big[/font_size]",
  "literal | pipe and [unknown] brackets",
];

describe("richTextLayeredHtml memo", () => {
  it("returns identical html warm and cold for every context shape", () => {
    const contexts = [
      undefined,
      {},
      { textScale: true },
      { customTags: { red: { kind: "color" as const, value: "#f00" } } },
      {
        textScale: true,
        customTags: { red: { kind: "color" as const, value: "#f00" } },
      },
    ];
    for (const value of BBCODE_CASES) {
      for (const ctx of contexts) {
        resetAllMemos();
        const cold = richTextLayeredHtml(value, ctx);
        expect(richTextLayeredHtml(value, ctx)).toBe(cold);
        resetAllMemos();
        expect(richTextLayeredHtml(value, ctx)).toBe(cold);
      }
    }
  });

  it("keys on textScale and on the custom-tag CONTENT (a rebuilt equal table still hits)", () => {
    const value = "[red]burn[/red] for [font_size=20]3[/font_size]";
    const red = { red: { kind: "color" as const, value: "#f00" } };
    const blue = { red: { kind: "color" as const, value: "#00f" } };
    const withRed = richTextLayeredHtml(value, { customTags: red });
    expect(richTextLayeredHtml(value, { customTags: blue })).not.toBe(withRed);
    // A different OBJECT with the same content is the same key.
    expect(
      richTextLayeredHtml(value, {
        customTags: { red: { kind: "color", value: "#f00" } },
      }),
    ).toBe(withRed);
    expect(
      richTextLayeredHtml(value, { customTags: red, textScale: true }),
    ).not.toBe(withRed);
  });

  it("never memoizes an [img] string (resolveImage is an opaque, time-varying host callback)", () => {
    const value = "hit [img]res://icon.png[/img] hard";
    const first = richTextLayeredHtml(value, {
      resolveImage: () => ({ path: "res://icon.png", url: "/early.png" }),
    });
    // Same bbcode, same (absent) textScale/customTags — a naive key would serve the stale answer.
    const second = richTextLayeredHtml(value, {
      resolveImage: () => ({ path: "res://icon.png", url: "/late.png" }),
    });
    expect(first).toContain("/early.png");
    expect(second).toContain("/late.png");
  });
});

// ---- whole-scene transparency ----------------------------------------------------------------

// An embedded (`data:`) texture: the SVG crop/tint bake (svgImageDataUrl) only runs for these.
const EMBEDDED_PNG = "data:image/png;base64,iVBORw0KGgo=";

const SCENE = `
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://icon.png" id="1"]
[node name="Root" type="Control"]
offset_right = 200.0
offset_bottom = 200.0
[node name="Tinted" type="TextureRect" parent="."]
texture = ExtResource("1")
modulate = Color(0.5, 0.25, 1, 1)
offset_right = 64.0
offset_bottom = 64.0
[node name="Rich" type="RichTextLabel" parent="."]
bbcode_enabled = true
text = "[center][b]Deal[/b] [color=#ff0000]6[/color] damage[/center]"
offset_top = 80.0
offset_right = 200.0
offset_bottom = 140.0
`;

function renderScene() {
  const scene = parseGodotTextScene(SCENE);
  expect(scene.diagnostics).toEqual([]);
  const resolveResource = () => ({
    path: "res://icon.png",
    url: EMBEDDED_PNG,
    size: { width: 64, height: 64 },
  });
  const options = { resolveResource };
  return renderTreeToHtmlModel(
    resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options),
    options,
  );
}

describe("scene render is byte-identical warm and cold", () => {
  it("produces the same model with an empty and a populated memo set", () => {
    const cold = renderScene();
    // Sanity: the render really did exercise the SVG tint bake and the layered BBCode.
    const tinted = cold.nodes.find((node) => node.path === "Tinted");
    expect(tinted?.selfAttributes["data-godot-texture-tint"]).toBe(
      "svg-color-matrix",
    );
    const rich = cold.nodes.find((node) => node.path === "Rich");
    expect(rich?.html).toContain("godot-rich-stack");

    const warm = renderScene(); // every memo now populated
    expect(warm).toEqual(cold);

    resetAllMemos();
    expect(renderScene()).toEqual(cold);
  });
});
