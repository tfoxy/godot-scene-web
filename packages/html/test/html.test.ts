import type { GodotSceneState } from "@godot-scene-web/core";
import {
  type GodotLayoutOptions,
  type GodotSceneTree,
  isGodotSceneTree,
  resolveGodotSceneTree as resolveSceneTreeFromGraph,
} from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";

// Test shim: the rect engine now takes a SceneGraph (browser-native split moved
// structural indexing into deriveSceneGraph); keep the scene-taking call shape.
function resolveGodotSceneTree(scene, options) {
  return resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
}

import {
  parseGodotResource,
  parseGodotTextScene,
} from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import {
  applyTextAutoFit,
  type GodotHtmlRenderOptions,
  godotSceneBaseCss,
  metricFitPredicate,
  mountHtmlScene,
  renderGodotSceneHtml,
  renderSceneToHtmlModel as renderTreeToHtmlModel,
  resolveTextAutoFitFontSize,
} from "../src/index";

// An embedded (`data:`) texture URL: the engine bakes crops/tints/nine-patch
// slices into inline `<image>` SVGs only for these (an external URL can't be
// loaded from a CSS-background SVG, so it uses plain CSS + a `filter` color
// matrix instead). Tests that assert the SVG-baking paths use this so the bytes
// are self-contained.
const EMBEDDED_PNG = "data:image/png;base64,iVBORw0KGgo=";

function renderSceneToHtmlModel(
  scene: GodotSceneState | GodotSceneTree,
  options: GodotLayoutOptions & GodotHtmlRenderOptions = {},
) {
  const tree = isGodotSceneTree(scene)
    ? scene
    : resolveGodotSceneTree(scene, options);
  return renderTreeToHtmlModel(tree, options);
}

function withMockTextMeasurement(
  measure: (element: HTMLElement) => { width: number; height: number },
  run: () => void,
) {
  const scrollWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth",
  );
  const scrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return measure(this).width;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return measure(this).height;
    },
  });
  try {
    run();
  } finally {
    if (scrollWidth) {
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
    }
    if (scrollHeight) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        scrollHeight,
      );
    }
  }
}

function measuredFontSize(element: HTMLElement): number {
  const selfLayer = element.closest<HTMLElement>(
    '[data-godot-self-layer="true"]',
  );
  return Number.parseFloat(
    element.style.fontSize ||
      selfLayer?.style.getPropertyValue("--godot-rich-normal-font-size") ||
      "16",
  );
}

describe("html renderer", () => {
  it("reports pending and failed resource descriptors without throwing", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://pending.png" id="pending"]
[ext_resource type="FontFile" path="res://failed.tres" id="failed"]
[node name="Root" type="Control"]
[node name="Icon" type="TextureRect" parent="."]
texture = ExtResource("pending")
[node name="Label" type="Label" parent="."]
theme_override_fonts/font = ExtResource("failed")
text = "Fallback"
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) =>
        ref.id === "pending"
          ? { status: "pending", path: "res://pending.png" }
          : {
              status: "error",
              path: "res://failed.tres",
              message: "not found",
            },
    });

    expect(model.nodes.find((node) => node.path === "Icon")).toBeTruthy();
    expect(model.nodes.find((node) => node.path === "Label")?.text).toBe(
      "Fallback",
    );
    expect(model.resourceStatuses).toEqual([
      {
        kind: "resource",
        status: "pending",
        nodePath: "Icon",
        path: "res://pending.png",
        ref: { type: "ExtResource", id: "pending" },
        message: undefined,
      },
      {
        kind: "resource",
        status: "error",
        nodePath: "Label",
        path: "res://failed.tres",
        ref: { type: "ExtResource", id: "failed" },
        message: "not found",
      },
    ]);
  });

  it("keeps direct image and font URL rendering unchanged", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://icon.png" id="tex"]
[ext_resource type="FontFile" path="res://title.woff2" id="font"]
[node name="Root" type="Control"]
[node name="Icon" type="TextureRect" parent="."]
texture = ExtResource("tex")
[node name="Label" type="Label" parent="."]
theme_override_fonts/font = ExtResource("font")
theme_override_font_sizes/font_size = 20
text = "Title"
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) =>
        ref.id === "tex"
          ? { path: "res://icon.png", url: "/assets/icon.png" }
          : {
              path: "res://title.woff2",
              url: "/assets/title.woff2",
              fontUrl: "/assets/title.woff2",
              fontFamily: "title",
            },
    });

    expect(
      model.nodes.find((node) => node.path === "Icon")?.selfStyle[
        "background-image"
      ],
    ).toBe('url("/assets/icon.png")');
    expect(model.fontFaces).toEqual([
      {
        fontFamily: "title",
        style: "normal",
        weight: "400",
        url: "/assets/title.woff2",
      },
    ]);
    expect(model.resourceStatuses).toEqual([]);
  });

  it("renders stable Godot data attributes and absolute rect styles", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Panel" type="ColorRect" parent="."]
offset_left = 10
offset_top = 20
offset_right = 60
offset_bottom = 70
color = Color(1, 0, 0, 1)
`);
    const model = renderSceneToHtmlModel(scene);
    const layout = resolveGodotSceneTree(scene);
    const injectedTree = {
      ...layout,
      nodes: layout.nodes.map((node) => {
        const { source: _source, ...resolvedNode } = node;
        return resolvedNode;
      }),
    };
    const injectedModel = renderSceneToHtmlModel(injectedTree);
    const root = model.nodes.find((node) => node.path === ".");
    const panel = model.nodes.find((node) => node.path === "Panel");
    const injectedPanel = injectedModel.nodes.find(
      (node) => node.path === "Panel",
    );
    expect(root?.positioning).toBe("root");
    expect(root?.attributes["data-godot-positioning"]).toBe("root");
    expect(panel?.positioning).toBe("absolute");
    expect(panel?.attributes["data-godot-positioning"]).toBe("absolute");
    expect(panel?.attributes["data-godot-path"]).toBe("Panel");
    expect(panel?.style).toMatchObject({
      left: "10px",
      top: "20px",
      width: "50px",
      height: "50px",
    });
    expect(panel?.selfAttributes["data-godot-self-layer"]).toBe("true");
    expect(panel?.selfStyle.background).toBe("rgba(255, 0, 0, 1)");
    expect(injectedPanel?.attributes).toMatchObject(panel?.attributes ?? {});
    expect(injectedPanel?.style).toMatchObject(panel?.style ?? {});
    expect(injectedPanel?.selfStyle).toMatchObject(panel?.selfStyle ?? {});
  });

  it("mounts a nested dom tree", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Child" type="Control" parent="."]
offset_right = 10
offset_bottom = 10
`);
    const host = document.createElement("div");
    mountHtmlScene(host, renderSceneToHtmlModel(scene));
    expect(host.querySelector('[data-godot-path="."]')).not.toBeNull();
    expect(host.querySelector('[data-godot-path="Child"]')).not.toBeNull();
  });

  it("binary searches the largest fitting auto-fit font size and clamps to the minimum", () => {
    expect(
      resolveTextAutoFitFontSize(
        {
          minFontSizePx: 8,
          maxFontSizePx: 20,
          fitWidth: true,
          fitHeight: true,
        },
        (size) => size <= 13,
      ),
    ).toBe(13);
    expect(
      resolveTextAutoFitFontSize(
        {
          minFontSizePx: 8,
          maxFontSizePx: 20,
          fitWidth: true,
          fitHeight: false,
        },
        () => false,
      ),
    ).toBe(8);
  });

  it("assigns Label font size from an auto-fit directive", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Text" type="Label" parent="."]
offset_right = 100
offset_bottom = 40
text = "Tight label"
`);
    const host = document.createElement("div");
    mountHtmlScene(
      host,
      renderSceneToHtmlModel(scene, {
        textAutoFitByPath: {
          Text: {
            minFontSizePx: 8,
            maxFontSizePx: 20,
            fitWidth: true,
            fitHeight: false,
          },
        },
      }),
    );
    withMockTextMeasurement(
      (element) => ({ width: measuredFontSize(element) * 10, height: 10 }),
      () => {
        expect(applyTextAutoFit(host)).toBe(1);
      },
    );
    const selfLayer = host.querySelector<HTMLElement>(
      '[data-godot-path="Text"] > [data-godot-self-layer="true"]',
    );
    expect(selfLayer?.style.fontSize).toBe("10px");
  });

  it("auto-fits RichTextLabel through the rich-text font-size correction", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 100
offset_bottom = 40
bbcode_enabled = true
text = "[gold]Tight rich text[/gold]"
`);
    const host = document.createElement("div");
    mountHtmlScene(
      host,
      renderSceneToHtmlModel(scene, {
        bbcodeTags: { gold: { kind: "color", value: "#efc851" } },
        textAutoFitByPath: {
          Text: {
            minFontSizePx: 8,
            maxFontSizePx: 20,
            fitWidth: true,
            fitHeight: false,
          },
        },
      }),
    );
    withMockTextMeasurement(
      (element) => ({ width: measuredFontSize(element) * 10, height: 10 }),
      () => {
        expect(applyTextAutoFit(host)).toBe(1);
      },
    );
    const selfLayer = host.querySelector<HTMLElement>(
      '[data-godot-path="Text"] > [data-godot-self-layer="true"]',
    );
    expect(
      selfLayer?.style.getPropertyValue("--godot-rich-normal-font-size"),
    ).toBe("9.6px");
  });

  it("fits from host-engine nominal metrics, keeping the max when it fits the box height", () => {
    // Ancient-option case: a vertically-bound paragraph Godot measured at the
    // nominal 24px as ~441x62 inside an 830x74 box. Height fits, so keep 24 —
    // without touching the DOM.
    const directive = {
      minFontSizePx: 12,
      maxFontSizePx: 24,
      nominalFontSizePx: 24,
      fitWidth: false,
      fitHeight: true,
      nominalMetrics: { contentWidthPx: 441, contentHeightPx: 62 },
    };
    const fits = metricFitPredicate(directive, { width: 830, height: 74 });
    expect(fits).not.toBeNull();
    expect(resolveTextAutoFitFontSize(directive, fits!)).toBe(24);
  });

  it("ignores over-wide nominal content when only height is bound", () => {
    const directive = {
      minFontSizePx: 12,
      maxFontSizePx: 24,
      nominalFontSizePx: 24,
      fitWidth: false,
      fitHeight: true,
      nominalMetrics: { contentWidthPx: 441, contentHeightPx: 62 },
    };
    // A box far narrower than the 441px paragraph still keeps 24 because width
    // is unbound...
    expect(
      resolveTextAutoFitFontSize(
        directive,
        metricFitPredicate(directive, { width: 120, height: 74 })!,
      ),
    ).toBe(24);
    // ...whereas binding width forces a smaller size for the same narrow box.
    const widthBound = { ...directive, fitWidth: true };
    expect(
      resolveTextAutoFitFontSize(
        widthBound,
        metricFitPredicate(widthBound, { width: 120, height: 74 })!,
      ),
    ).toBeLessThan(24);
  });

  it("returns no metric predicate when nominal metrics are unavailable", () => {
    expect(
      metricFitPredicate(
        {
          minFontSizePx: 12,
          maxFontSizePx: 24,
          nominalFontSizePx: 24,
          fitWidth: false,
          fitHeight: true,
        },
        { width: 830, height: 74 },
      ),
    ).toBeNull();
    expect(
      metricFitPredicate(
        {
          minFontSizePx: 12,
          maxFontSizePx: 24,
          fitWidth: false,
          fitHeight: true,
          nominalMetrics: { contentWidthPx: 441, contentHeightPx: 62 },
        },
        { width: 830, height: 74 },
      ),
    ).toBeNull();
  });

  it("auto-fits a RichTextLabel across all rich font-size roles from nominal metrics", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 830
offset_bottom = 74
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 830
offset_bottom = 74
bbcode_enabled = true
theme_override_constants/line_separation = 0
text = "[b]Bold[/b] body text"
`);
    const host = document.createElement("div");
    mountHtmlScene(
      host,
      renderSceneToHtmlModel(scene, {
        textAutoFitByPath: {
          Text: {
            minFontSizePx: 12,
            maxFontSizePx: 24,
            nominalFontSizePx: 24,
            fitWidth: false,
            fitHeight: true,
            nominalMetrics: { contentWidthPx: 441, contentHeightPx: 62 },
          },
        },
      }),
    );
    // Metric-first: no DOM measurement mock needed.
    expect(applyTextAutoFit(host)).toBe(1);
    const selfLayer = host.querySelector<HTMLElement>(
      '[data-godot-path="Text"] > [data-godot-self-layer="true"]',
    );
    // No explicit font URL => the .8 MSDF fallback scale applies (24 -> 19.2),
    // but every rich role is resized together (not just normal).
    for (const role of [
      "--godot-rich-normal-font-size",
      "--godot-rich-bold-font-size",
      "--godot-rich-italic-font-size",
      "--godot-rich-bold-italic-font-size",
    ]) {
      expect(selfLayer?.style.getPropertyValue(role)).toBe("19.2px");
    }
    // line_separation = 0 => line-height tracks the fitted logical size.
    expect(selfLayer?.style.lineHeight).toBe("24px");
  });

  it("fits against the logical box, not a transform-scaled getBoundingClientRect", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 830
offset_bottom = 74
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 830
offset_bottom = 74
bbcode_enabled = true
text = "[b]Bold[/b] body text"
`);
    const host = document.createElement("div");
    mountHtmlScene(
      host,
      renderSceneToHtmlModel(scene, {
        textAutoFitByPath: {
          Text: {
            minFontSizePx: 12,
            maxFontSizePx: 24,
            nominalFontSizePx: 24,
            fitWidth: false,
            fitHeight: true,
            nominalMetrics: { contentWidthPx: 441, contentHeightPx: 62 },
          },
        },
      }),
    );
    const el = host.querySelector<HTMLElement>('[data-godot-path="Text"]');
    const selfLayer = el?.querySelector<HTMLElement>(
      ':scope > [data-godot-self-layer="true"]',
    );
    // Simulate a stage scaled to ~0.65 (viewport fit): getBoundingClientRect
    // reports scaled px (74 -> 47.8), but style stays logical (74px). The fit must
    // use the logical 74 (=> keep 24), not the scaled 47.8 (=> would shrink to ~18).
    const scaled = {
      width: 536,
      height: 47.8,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 536,
      bottom: 47.8,
      toJSON() {},
    } as DOMRect;
    el!.getBoundingClientRect = () => scaled;
    selfLayer!.getBoundingClientRect = () => scaled;
    expect(applyTextAutoFit(host)).toBe(1);
    // Fit picked 24 (scale .8 with no font => 19.2), not 18 (=> would be 14.4).
    expect(
      selfLayer?.style.getPropertyValue("--godot-rich-normal-font-size"),
    ).toBe("19.2px");
  });

  it("still falls back to DOM measurement when no nominal metrics are present", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 100
offset_bottom = 40
bbcode_enabled = true
text = "[gold]Tight rich text[/gold]"
`);
    const host = document.createElement("div");
    mountHtmlScene(
      host,
      renderSceneToHtmlModel(scene, {
        bbcodeTags: { gold: { kind: "color", value: "#efc851" } },
        textAutoFitByPath: {
          Text: {
            minFontSizePx: 8,
            maxFontSizePx: 20,
            fitWidth: true,
            fitHeight: false,
          },
        },
      }),
    );
    withMockTextMeasurement(
      (element) => ({ width: measuredFontSize(element) * 10, height: 10 }),
      () => {
        expect(applyTextAutoFit(host)).toBe(1);
      },
    );
    const selfLayer = host.querySelector<HTMLElement>(
      '[data-godot-path="Text"] > [data-godot-self-layer="true"]',
    );
    expect(
      selfLayer?.style.getPropertyValue("--godot-rich-normal-font-size"),
    ).toBe("9.6px");
  });

  it("renders the same data attributes from a GodotSceneState input", () => {
    const state = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Panel" type="ColorRect" parent="."]
offset_left = 10
offset_top = 20
offset_right = 60
offset_bottom = 70
`);
    const panel = renderSceneToHtmlModel(state).nodes.find(
      (node) => node.path === "Panel",
    );

    expect(panel?.attributes).toMatchObject({
      "data-godot-path": "Panel",
      "data-godot-type": "ColorRect",
      "data-godot-name": "Panel",
    });
    expect(panel?.style).toMatchObject({
      left: "10px",
      top: "20px",
      width: "50px",
      height: "50px",
    });
  });

  it("fills a ColorRect with Godot's default white tinted by modulate", () => {
    // A ColorRect with no authored `color` paints Godot's default white, and
    // the fill is tinted by the node's modulate RGB (alpha goes to opacity) —
    // e.g. an authored-white fullscreen Backstop modulated black.
    const state = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Backstop" type="ColorRect" parent="."]
modulate = Color(0, 0, 0, 0.9)
offset_right = 200
offset_bottom = 100
`);
    const backstop = renderSceneToHtmlModel(state).nodes.find(
      (node) => node.path === "Backstop",
    );

    expect(backstop?.selfStyle?.background).toBe("rgba(0, 0, 0, 1)");
    expect(backstop?.style?.opacity).toBe("0.9");
  });

  it("uses CSS flex layout for HBoxContainer direct children", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 300
offset_bottom = 80
theme_override_constants/separation = 10
[node name="Left" type="ColorRect" parent="."]
custom_minimum_size = Vector2(100, 40)
[node name="Right" type="ColorRect" parent="."]
custom_minimum_size = Vector2(50, 40)
`);
    const model = renderSceneToHtmlModel(scene);
    const root = model.nodes.find((node) => node.path === ".");
    const left = model.nodes.find((node) => node.path === "Left");
    const right = model.nodes.find((node) => node.path === "Right");
    expect(root?.style).toMatchObject({
      position: "relative",
      display: "flex",
      "flex-direction": "row",
      gap: "10px",
    });
    expect(left?.style).toMatchObject({
      position: "relative",
      flex: "0 0 100px",
      width: "100px",
      height: "80px",
    });
    expect(left?.style.left).toBeUndefined();
    expect(left?.style.top).toBeUndefined();
    expect(right?.style).toMatchObject({
      position: "relative",
      flex: "0 0 50px",
      width: "50px",
      height: "80px",
    });
    expect(right?.style.left).toBeUndefined();
    expect(right?.style.top).toBeUndefined();
  });

  it("uses CSS layout for supported container children", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 260
[node name="Column" type="VBoxContainer" parent="."]
offset_right = 80
offset_bottom = 80
theme_override_constants/separation = 4
[node name="ColumnChild" type="Control" parent="Column"]
custom_minimum_size = Vector2(20, 10)
[node name="Flow" type="HFlowContainer" parent="."]
offset_top = 90
offset_right = 180
offset_bottom = 150
theme_override_constants/h_separation = 8
theme_override_constants/v_separation = 6
[node name="FlowChild" type="Control" parent="Flow"]
custom_minimum_size = Vector2(80, 24)
[node name="Grid" type="GridContainer" parent="."]
offset_top = 160
offset_right = 100
offset_bottom = 220
columns = 2
[node name="GridA" type="Control" parent="Grid"]
custom_minimum_size = Vector2(20, 10)
[node name="GridB" type="Control" parent="Grid"]
custom_minimum_size = Vector2(30, 12)
[node name="Center" type="CenterContainer" parent="."]
offset_left = 120
offset_top = 160
offset_right = 220
offset_bottom = 220
[node name="Centered" type="Control" parent="Center"]
custom_minimum_size = Vector2(20, 10)
[node name="Margin" type="MarginContainer" parent="."]
offset_left = 230
offset_top = 160
offset_right = 300
offset_bottom = 220
theme_override_constants/margin_left = 3
theme_override_constants/margin_top = 4
[node name="Inset" type="Control" parent="Margin"]
`);
    const model = renderSceneToHtmlModel(scene);
    expect(
      model.nodes.find((node) => node.path === "Column")?.style,
    ).toMatchObject({
      display: "flex",
      "flex-direction": "column",
      gap: "4px",
    });
    expect(
      model.nodes.find((node) => node.path === "Column/ColumnChild")?.style
        .left,
    ).toBeUndefined();
    expect(
      model.nodes.find((node) => node.path === "Flow")?.style,
    ).toMatchObject({
      display: "flex",
      "flex-wrap": "wrap",
      "column-gap": "8px",
      "row-gap": "6px",
    });
    expect(
      model.nodes.find((node) => node.path === "Flow/FlowChild")?.style
        .position,
    ).toBe("relative");
    expect(
      model.nodes.find((node) => node.path === "Grid")?.style.display,
    ).toBe("grid");
    expect(
      model.nodes.find((node) => node.path === "Grid/GridA")?.style[
        "grid-column"
      ],
    ).toBe("1");
    expect(
      model.nodes.find((node) => node.path === "Center")?.style,
    ).toMatchObject({
      display: "grid",
      "place-items": "center",
    });
    expect(
      model.nodes.find((node) => node.path === "Center/Centered")?.style[
        "grid-area"
      ],
    ).toBe("1 / 1");
    expect(
      model.nodes.find((node) => node.path === "Margin")?.style,
    ).toMatchObject({
      display: "grid",
      padding: "4px 0px 0px 3px",
    });
    expect(
      model.nodes.find((node) => node.path === "Margin/Inset")?.style.left,
    ).toBeUndefined();
  });

  it("offsets MarginContainer children outward for negative margins (CSS padding cannot be negative)", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 180
[node name="NegMargin" type="MarginContainer" parent="."]
offset_left = 100
offset_top = 50
offset_right = 160
offset_bottom = 130
theme_override_constants/margin_left = -9
theme_override_constants/margin_top = -3
theme_override_constants/margin_right = -7
[node name="Child" type="Control" parent="NegMargin"]
`);
    const model = renderSceneToHtmlModel(scene);
    // Negative Godot margins must not become negative CSS padding (which the
    // browser drops); the inset is clamped to 0 and the child carries the offset.
    expect(
      model.nodes.find((node) => node.path === "NegMargin")?.style,
    ).toMatchObject({
      display: "grid",
      padding: "0px 0px 0px 0px",
    });
    // The child is shifted outward by the full negative margin via its own
    // (negative-capable) CSS margin, so it overflows the container as in Godot.
    expect(
      model.nodes.find((node) => node.path === "NegMargin/Child")?.style,
    ).toMatchObject({
      position: "relative",
      "grid-area": "1 / 1",
      "margin-left": "-9px",
      "margin-top": "-3px",
    });
  });

  it("uses normal-flow CSS for VFlowContainer and base Box/Flow containers", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 180
[node name="VFlow" type="VFlowContainer" parent="."]
offset_right = 100
offset_bottom = 50
theme_override_constants/h_separation = 5
theme_override_constants/v_separation = 2
[node name="First" type="Control" parent="VFlow"]
custom_minimum_size = Vector2(20, 30)
[node name="Second" type="Control" parent="VFlow"]
custom_minimum_size = Vector2(30, 30)
[node name="Box" type="BoxContainer" parent="."]
offset_top = 70
offset_right = 100
offset_bottom = 130
vertical = true
theme_override_constants/separation = 6
[node name="BoxChild" type="Control" parent="Box"]
custom_minimum_size = Vector2(20, 10)
[node name="Flow" type="FlowContainer" parent="."]
offset_left = 120
offset_top = 70
offset_right = 220
offset_bottom = 130
vertical = true
[node name="FlowChild" type="Control" parent="Flow"]
custom_minimum_size = Vector2(20, 10)
`);
    const model = renderSceneToHtmlModel(scene);
    expect(
      model.nodes.find((node) => node.path === "VFlow")?.style,
    ).toMatchObject({
      display: "flex",
      "flex-direction": "column",
      "flex-wrap": "wrap",
      "column-gap": "5px",
      "row-gap": "2px",
    });
    expect(
      model.nodes.find((node) => node.path === "VFlow/First")?.style,
    ).toMatchObject({
      position: "relative",
      flex: "0 0 30px",
      width: "20px",
      height: "30px",
    });
    expect(
      model.nodes.find((node) => node.path === "VFlow/First")?.style.left,
    ).toBeUndefined();
    expect(
      model.nodes.find((node) => node.path === "Box")?.style,
    ).toMatchObject({
      display: "flex",
      "flex-direction": "column",
      gap: "6px",
    });
    expect(
      model.nodes.find((node) => node.path === "Box/BoxChild")?.style.position,
    ).toBe("relative");
    expect(
      model.nodes.find((node) => node.path === "Flow")?.style["flex-direction"],
    ).toBe("column");
    expect(
      model.nodes.find((node) => node.path === "Flow/FlowChild")?.style.left,
    ).toBeUndefined();
    expect(model.nodes.find((node) => node.path === "VFlow")?.children).toEqual(
      ["VFlow/First", "VFlow/Second"],
    );
  });

  it("uses normal-flow CSS and metadata for AspectRatioContainer children", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="AspectRatioContainer"]
offset_right = 160
offset_bottom = 100
ratio = 2.0
[node name="Child" type="ColorRect" parent="."]
color = Color(0, 1, 0, 1)
`);
    const model = renderSceneToHtmlModel(scene);
    const root = model.nodes.find((node) => node.path === ".");
    const child = model.nodes.find((node) => node.path === "Child");
    expect(root?.containerLayout).toBe("aspect-ratio");
    expect(root?.attributes).toMatchObject({
      "data-godot-container-layout": "aspect-ratio",
      "data-godot-aspect-ratio": "2",
      "data-godot-stretch-mode": "2",
      "data-godot-alignment-horizontal": "1",
      "data-godot-alignment-vertical": "1",
    });
    expect(root?.style).toMatchObject({
      position: "relative",
      display: "grid",
      "justify-items": "start",
      "align-items": "start",
    });
    expect(child?.positioning).toBe("container-managed");
    expect(child?.attributes["data-godot-positioning"]).toBe(
      "container-managed",
    );
    expect(child?.style).toMatchObject({
      position: "relative",
      width: "160px",
      height: "80px",
      "grid-area": "1 / 1",
      "margin-top": "10px",
    });
    expect(child?.selfStyle.background).toBe("rgba(0, 255, 0, 1)");
    expect(child?.style.left).toBeUndefined();
    expect(child?.style.top).toBeUndefined();
  });

  it("uses panel and scroll container CSS while keeping direct children in normal flow", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[sub_resource type="StyleBoxFlat" id="panel"]
bg_color = Color(0.1, 0.2, 0.3, 1)
border_width_left = 2
border_width_top = 3
border_width_right = 4
border_width_bottom = 5
content_margin_left = 8
content_margin_top = 7
content_margin_right = 6
content_margin_bottom = 5
[sub_resource type="StyleBoxEmpty" id="empty"]
[node name="Root" type="Control"]
offset_right = 260
offset_bottom = 140
[node name="Panel" type="PanelContainer" parent="."]
offset_right = 100
offset_bottom = 60
theme_override_styles/panel = SubResource("panel")
[node name="PanelChild" type="Control" parent="Panel"]
[node name="Scroll" type="ScrollContainer" parent="."]
offset_left = 120
offset_right = 220
offset_bottom = 60
horizontal_scroll_mode = 2
vertical_scroll_mode = 0
theme_override_styles/panel = SubResource("empty")
[node name="Content" type="Control" parent="Scroll"]
custom_minimum_size = Vector2(160, 90)
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => {
        const resource = scene.subResources.find(
          (candidate) => candidate.id === ref.id,
        );
        return resource
          ? {
              type: resource.type,
              document: {
                kind: "resource",
                header: {
                  section: "gd_resource",
                  attributes: { type: resource.type ?? "" },
                },
                extResources: [],
                subResources: [],
                nodes: [],
                connections: [],
                editables: [],
                properties: resource.properties,
                diagnostics: [],
              },
            }
          : undefined;
      },
    });
    expect(
      model.nodes.find((node) => node.path === "Panel")?.style,
    ).toMatchObject({
      display: "grid",
      padding: "7px 6px 5px 8px",
    });
    expect(
      model.nodes.find((node) => node.path === "Panel")?.selfStyle,
    ).toMatchObject({
      background: "rgba(26, 51, 77, 1)",
    });
    const panelChild = model.nodes.find(
      (node) => node.path === "Panel/PanelChild",
    );
    expect(panelChild?.style).toMatchObject({
      position: "relative",
      width: "86px",
      height: "48px",
      "grid-area": "1 / 1",
    });
    expect(panelChild?.style.left).toBeUndefined();
    expect(panelChild?.style.top).toBeUndefined();

    expect(
      model.nodes.find((node) => node.path === "Scroll")?.style,
    ).toMatchObject({
      display: "block",
      "overflow-x": "scroll",
      "overflow-y": "hidden",
    });
    const content = model.nodes.find((node) => node.path === "Scroll/Content");
    expect(content?.style).toMatchObject({
      position: "relative",
      width: "160px",
      height: "90px",
    });
    expect(content?.style.left).toBeUndefined();
    expect(content?.style.top).toBeUndefined();
  });

  it("keeps default z-index as metadata without emitting CSS z-index", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Default" type="Control" parent="."]
offset_right = 20
offset_bottom = 20
[node name="Raised" type="Control" parent="."]
offset_left = 10
offset_top = 10
offset_right = 30
offset_bottom = 30
z_index = 2
[node name="Absolute" type="Control" parent="Raised"]
offset_right = 10
offset_bottom = 10
z_index = 5
z_as_relative = false
`);
    const model = renderSceneToHtmlModel(scene);
    const root = model.nodes.find((node) => node.path === ".");
    const defaultNode = model.nodes.find((node) => node.path === "Default");
    const raised = model.nodes.find((node) => node.path === "Raised");
    const absolute = model.nodes.find(
      (node) => node.path === "Raised/Absolute",
    );
    expect(root?.attributes["data-godot-z-index"]).toBe("0");
    expect(root?.style["z-index"]).toBeUndefined();
    expect(defaultNode?.attributes["data-godot-z-index"]).toBe("0");
    expect(defaultNode?.style["z-index"]).toBeUndefined();
    expect(raised?.attributes["data-godot-z-index"]).toBe("2");
    expect(raised?.style["z-index"]).toBe("2");
    expect(absolute?.attributes["data-godot-z-index"]).toBe("5");
    expect(absolute?.attributes["data-godot-z-as-relative"]).toBe("false");
    expect(absolute?.style["z-index"]).toBe("5");
  });

  it("renders show_behind_parent children before the parent self layer", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://parent.png" id="1"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Parent" type="TextureRect" parent="."]
offset_right = 40
offset_bottom = 40
texture = ExtResource("1")
[node name="Outline" type="ColorRect" parent="Parent"]
offset_right = 40
offset_bottom = 40
show_behind_parent = true
[node name="Normal" type="ColorRect" parent="Parent"]
offset_left = 4
offset_top = 4
offset_right = 20
offset_bottom = 20
z_index = 3
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://parent.png",
        url: "/parent.png",
        size: { width: 40, height: 40 },
      }),
    });
    const parent = model.nodes.find((node) => node.path === "Parent");
    const outline = model.nodes.find((node) => node.path === "Parent/Outline");
    const normal = model.nodes.find((node) => node.path === "Parent/Normal");
    expect(parent?.style["background-image"]).toBeUndefined();
    expect(parent?.selfStyle["background-image"]).toBe('url("/parent.png")');
    expect(outline?.attributes["data-godot-show-behind-parent"]).toBe("true");
    expect(outline?.style["z-index"]).toBeUndefined();
    expect(normal?.style["z-index"]).toBe("3");

    const host = document.createElement("div");
    mountHtmlScene(host, model);
    const parentElement = host.querySelector<HTMLElement>(
      '[data-godot-path="Parent"]',
    );
    const order = [...(parentElement?.children ?? [])].map((child) =>
      child.getAttribute("data-godot-self-layer") === "true"
        ? "self"
        : child.getAttribute("data-godot-path"),
    );
    expect(order).toEqual(["Parent/Outline", "self", "Parent/Normal"]);
  });

  it("keeps TextureRect without a texture as a stable node", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="EmptyTexture" type="TextureRect" parent="."]
offset_left = 5
offset_top = 6
offset_right = 25
offset_bottom = 26
`);
    const model = renderSceneToHtmlModel(scene);
    const texture = model.nodes.find((node) => node.path === "EmptyTexture");
    expect(model.diagnostics).toEqual([]);
    expect(texture?.attributes).toMatchObject({
      "data-godot-path": "EmptyTexture",
      "data-godot-type": "TextureRect",
    });
    expect(texture?.style).toMatchObject({
      left: "5px",
      top: "6px",
      width: "20px",
      height: "20px",
    });
    expect(texture?.attributes["data-godot-resource-kind"]).toBeUndefined();
    expect(texture?.selfStyle["background-image"]).toBeUndefined();
  });

  it("maps mouse_filter to pointer-events (STOP=auto, IGNORE=none, unset=inherit)", () => {
    const scene = parseGodotTextScene(`
[gd_scene format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 120
[node name="Stop" type="ColorRect" parent="."]
offset_right = 50
offset_bottom = 50
mouse_filter = 0
[node name="Ignore" type="ColorRect" parent="."]
offset_right = 50
offset_bottom = 50
mouse_filter = 2
[node name="Unset" type="ColorRect" parent="."]
offset_right = 50
offset_bottom = 50
`);
    const model = renderSceneToHtmlModel(scene);
    const styleOf = (name: string) =>
      model.nodes.find((node) => node.path === name)?.style["pointer-events"];
    expect(styleOf("Stop")).toBe("auto");
    expect(styleOf("Ignore")).toBe("none");
    expect(styleOf("Unset")).toBeUndefined();
  });

  it("applies the Godot per-type default mouse_filter when unset (IGNORE-default decorations)", () => {
    // NinePatchRect/Label default to IGNORE in Godot, so a scene that omits mouse_filter
    // must still render them pointer-events:none — otherwise an oversized decoration (an
    // event button's BlueFlash) becomes a spurious click target. Explicit values win, and
    // types that default to STOP (e.g. ColorRect) keep inheriting when unset.
    const scene = parseGodotTextScene(`
[gd_scene format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 120
[node name="UnsetPatch" type="NinePatchRect" parent="."]
offset_right = 50
offset_bottom = 50
[node name="UnsetLabel" type="Label" parent="."]
offset_right = 50
offset_bottom = 50
[node name="PatchStopOverride" type="NinePatchRect" parent="."]
offset_right = 50
offset_bottom = 50
mouse_filter = 0
[node name="UnsetColorRect" type="ColorRect" parent="."]
offset_right = 50
offset_bottom = 50
`);
    const model = renderSceneToHtmlModel(scene);
    const styleOf = (name: string) =>
      model.nodes.find((node) => node.path === name)?.style["pointer-events"];
    expect(styleOf("UnsetPatch")).toBe("none");
    expect(styleOf("UnsetLabel")).toBe("none");
    // An explicit mouse_filter still overrides the type default.
    expect(styleOf("PatchStopOverride")).toBe("auto");
    // A STOP-default type stays inherited when unset.
    expect(styleOf("UnsetColorRect")).toBeUndefined();
  });

  it("renders texture, nine-patch, and text theme styles", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://panel.png" id="1"]
[ext_resource type="FontFile" path="res://font.ttf" id="2"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 120
[node name="Image" type="TextureRect" parent="."]
offset_right = 32
offset_bottom = 32
texture = ExtResource("1")
stretch_mode = 5
mouse_filter = 2
self_modulate = Color(1, 1, 1, 0.5)
[node name="Patch" type="NinePatchRect" parent="."]
offset_top = 40
offset_right = 100
offset_bottom = 80
texture = ExtResource("1")
patch_margin_left = 4
patch_margin_top = 5
patch_margin_right = 6
patch_margin_bottom = 7
[node name="Text" type="RichTextLabel" parent="."]
offset_top = 90
offset_right = 200
offset_bottom = 120
bbcode_enabled = true
text = "[b]Hello[/b] [i]world[/i]"
theme_override_colors/default_color = Color(1, 0, 0, 1)
theme_override_colors/font_shadow_color = Color(0, 0, 0, 0.5)
theme_override_constants/shadow_offset_x = 2
theme_override_constants/shadow_offset_y = 3
theme_override_font_sizes/normal_font_size = 20
theme_override_fonts/normal_font = ExtResource("2")
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) =>
        ref.id === "1"
          ? { path: "res://panel.png", url: "/assets/panel.png" }
          : { path: "res://font.ttf", fontFamily: "GodotFont" },
    });
    const image = model.nodes.find((node) => node.path === "Image");
    expect(image?.selfAttributes["data-godot-resource-path"]).toBe(
      "res://panel.png",
    );
    expect(image?.selfStyle["background-image"]).toBe(
      'url("/assets/panel.png")',
    );
    expect(image?.style["pointer-events"]).toBe("none");
    expect(image?.style.opacity).toBeUndefined();
    expect(image?.selfStyle.opacity).toBe("0.5");

    const patch = model.nodes.find((node) => node.path === "Patch");
    expect(patch?.selfStyle["border-image-source"]).toBe(
      'url("/assets/panel.png")',
    );
    expect(patch?.selfStyle["border-image-slice"]).toBe("5 6 7 4 fill");

    const text = model.nodes.find((node) => node.path === "Text");
    expect(text?.html).toContain('data-godot-rich-layer="shadow-outline"');
    expect(text?.html).toContain('data-godot-rich-layer="shadow-fill"');
    expect(text?.html).toContain('data-godot-rich-layer="outline"');
    expect(text?.html).toContain('data-godot-rich-layer="fill"');
    expect(text?.html?.match(/data-godot-rich-layer=/g)).toHaveLength(4);
    expect(text?.html).toContain(
      '<strong class="godot-rich-bold">Hello</strong><span class="godot-rich-normal"> </span><em class="godot-rich-italic">world</em>',
    );
    expect(text?.selfAttributes["data-godot-font-family"]).toBe("GodotFont");
    expect(text?.selfStyle).toMatchObject({
      color: "rgba(255, 0, 0, 1)",
      "--godot-rich-text-color": "rgba(255, 0, 0, 1)",
      "--godot-rich-outline-color": "rgba(0, 0, 0, 1)",
      "--godot-rich-outline-size": "0px",
      "--godot-rich-shadow-color": "rgba(0, 0, 0, 0.5)",
      "--godot-rich-shadow-x": "2px",
      "--godot-rich-shadow-y": "3px",
      "--godot-rich-shadow-outline-size": "0.5px",
      "--godot-rich-normal-font-size": "16px",
    });
    expect(text?.selfStyle["font-size"]).toBeUndefined();
    expect(text?.selfStyle["--godot-rich-bold-font-size"]).toBeUndefined();
    expect(text?.selfStyle["--godot-rich-italic-font-size"]).toBeUndefined();
    expect(text?.selfStyle["text-shadow"]).toBeUndefined();
  });

  it("keeps texture aspect for STRETCH_KEEP_ASPECT (4) TextureRects, stretching only for SCALE (0)", () => {
    // STRETCH_KEEP_ASPECT must fit the texture while preserving its aspect (background-size:
    // contain), not distort it to the box. SCALE (the default) keeps "100% 100%".
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://icon.png" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 200
[node name="KeepAspect" type="TextureRect" parent="."]
offset_right = 60
offset_bottom = 90
texture = ExtResource("1")
stretch_mode = 4
[node name="Scale" type="TextureRect" parent="."]
offset_right = 60
offset_bottom = 90
texture = ExtResource("1")
stretch_mode = 0
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://icon.png",
        url: "/assets/icon.png",
      }),
    });
    const keepAspect = model.nodes.find((node) => node.path === "KeepAspect");
    expect(keepAspect?.selfStyle["background-size"]).toBe("contain");
    const scale = model.nodes.find((node) => node.path === "Scale");
    expect(scale?.selfStyle["background-size"]).toBe("100% 100%");
  });

  it("maps autowrap_mode to white-space so non-wrapping labels do not reflow", () => {
    const scene = parseGodotTextScene(`[gd_scene format=3]
[node name="Root" type="Control"]
[node name="NoWrapRich" type="RichTextLabel" parent="."]
offset_right = 120
offset_bottom = 40
autowrap_mode = 0
text = "stays on one line"
[node name="WrapRich" type="RichTextLabel" parent="."]
offset_top = 40
offset_right = 120
offset_bottom = 80
text = "this one wraps"
[node name="PlainLabel" type="Label" parent="."]
offset_top = 80
offset_right = 120
offset_bottom = 120
text = "label off by default"
`);
    const model = renderSceneToHtmlModel(scene);
    const ws = (name: string) =>
      model.nodes.find((node) => node.path === name)?.selfStyle["white-space"];
    // AUTOWRAP_OFF (0) on a RichTextLabel → `pre` (no reflow, keeps newlines).
    expect(ws("NoWrapRich")).toBe("pre");
    // RichTextLabel default is WORD_SMART (wraps) → keeps the inherited pre-wrap.
    expect(ws("WrapRich")).toBeUndefined();
    // A Label defaults to AUTOWRAP_OFF → `pre` (single line).
    expect(ws("PlainLabel")).toBe("pre");
  });

  it("clamps nine-patch source slices when patch margins overflow the texture", () => {
    // event_button.png is 284x110 yet ships 192px left/right margins (192 + 192 =
    // 384 > 284). `border-image-slice` collapses its `fill` center when opposing
    // slices overlap, dropping the stretched middle (caps render, button body does
    // not). Clamp the SOURCE slices to keep a >=1px center while leaving the
    // authored margins as the destination `border-width` geometry.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://button.png" id="1"]
[node name="Root" type="Control"]
offset_right = 800
offset_bottom = 200
[node name="Overflow" type="NinePatchRect" parent="."]
offset_right = 800
offset_bottom = 100
texture = ExtResource("1")
patch_margin_left = 192
patch_margin_top = 50
patch_margin_right = 192
patch_margin_bottom = 50
[node name="Fits" type="NinePatchRect" parent="."]
offset_top = 100
offset_right = 800
offset_bottom = 200
texture = ExtResource("1")
patch_margin_left = 40
patch_margin_top = 20
patch_margin_right = 40
patch_margin_bottom = 20
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://button.png",
        url: "/assets/button.png",
        size: { width: 284, height: 110 },
      }),
    });

    const overflow = model.nodes.find((node) => node.path === "Overflow");
    // Left+right (192+192) scaled down proportionally to fit 284 with a 1px center;
    // top+bottom (50+50) already fit 110 and stay untouched.
    expect(overflow?.selfStyle["border-image-slice"]).toBe(
      "50 141 50 141 fill",
    );
    // Destination border geometry keeps the authored margins.
    expect(overflow?.selfStyle["border-width"]).toBe("50px 192px 50px 192px");
    expect(overflow?.selfAttributes["data-godot-patch-slice-clamped"]).toBe(
      "50,141,50,141",
    );

    const fits = model.nodes.find((node) => node.path === "Fits");
    // Non-overflowing margins are left exactly as authored (no clamp marker).
    expect(fits?.selfStyle["border-image-slice"]).toBe("20 40 20 40 fill");
    expect(
      fits?.selfAttributes["data-godot-patch-slice-clamped"],
    ).toBeUndefined();
  });

  it("marks an external nine-patch unclamped when the texture size is unknown", () => {
    // couch-coop serves external `/res/` textures whose intrinsic size is NOT known at
    // string-render time, so the inline clamp can't run: the slices stay at the raw margins
    // (the `fill` center would then drop for an overlapping-margin texture — caps but no
    // middle) and the node is marked for the post-mount `clampExternalNinePatchSlices` pass.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://button.png" id="1"]
[node name="Root" type="Control"]
offset_right = 800
offset_bottom = 100
[node name="Overflow" type="NinePatchRect" parent="."]
offset_right = 800
offset_bottom = 100
texture = ExtResource("1")
patch_margin_left = 192
patch_margin_top = 50
patch_margin_right = 192
patch_margin_bottom = 50
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://button.png",
        url: "/assets/button.png",
        // no `size` — external texture, intrinsic dimensions unknown at render time.
      }),
    });

    const overflow = model.nodes.find((node) => node.path === "Overflow");
    // Slices stay at the raw (unclamped) margins, and there's no inline clamp marker…
    expect(overflow?.selfStyle["border-image-slice"]).toBe(
      "50 192 50 192 fill",
    );
    expect(
      overflow?.selfAttributes["data-godot-patch-slice-clamped"],
    ).toBeUndefined();
    // …instead the node is flagged for the post-mount re-clamp, carrying the raw
    // [top,right,bottom,left] margins.
    expect(overflow?.selfAttributes["data-godot-nine-patch-unclamped"]).toBe(
      "50,192,50,192",
    );
  });

  it("applies non-white texture modulate as a masked multiply tint", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=4 format=3]
[ext_resource type="Texture2D" path="res://panel.png" id="1"]
[ext_resource type="Texture2D" path="res://missing-size.png" id="2"]
[ext_resource type="Texture2D" path="res://full-margin-mask.png" id="3"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 360
[node name="TintedImage" type="TextureRect" parent="."]
offset_right = 40
offset_bottom = 20
texture = ExtResource("1")
modulate = Color(0.5, 0.25, 1, 0.6)
self_modulate = Color(0.5, 1, 0.25, 0.5)
[node name="WhiteImage" type="TextureRect" parent="."]
offset_top = 25
offset_right = 40
offset_bottom = 45
texture = ExtResource("1")
self_modulate = Color(1, 1, 1, 0.5)
[node name="TintedPatch" type="NinePatchRect" parent="."]
offset_top = 50
offset_right = 80
offset_bottom = 90
texture = ExtResource("1")
patch_margin_left = 4
patch_margin_top = 4
patch_margin_right = 4
patch_margin_bottom = 4
self_modulate = Color(0.158, 0.272, 0.31, 1)
[node name="TintedStretchPatch" type="NinePatchRect" parent="."]
offset_top = 95
offset_right = 80
offset_bottom = 135
texture = ExtResource("1")
patch_margin_left = 4
patch_margin_top = 4
patch_margin_right = 4
patch_margin_bottom = 4
axis_stretch_horizontal = 2
axis_stretch_vertical = 1
self_modulate = Color(0.5, 0.25, 1, 1)
[node name="WhitePatch" type="NinePatchRect" parent="."]
offset_top = 140
offset_right = 80
offset_bottom = 180
texture = ExtResource("1")
patch_margin_left = 4
patch_margin_top = 4
patch_margin_right = 4
patch_margin_bottom = 4
[node name="MissingSizePatch" type="NinePatchRect" parent="."]
offset_top = 185
offset_right = 80
offset_bottom = 225
texture = ExtResource("2")
patch_margin_left = 4
patch_margin_top = 4
patch_margin_right = 4
patch_margin_bottom = 4
self_modulate = Color(0.5, 0.25, 1, 1)
[node name="ClipOnlyPatch" type="NinePatchRect" parent="."]
offset_top = 230
offset_right = 80
offset_bottom = 270
texture = ExtResource("1")
patch_margin_left = 4
patch_margin_top = 4
patch_margin_right = 4
patch_margin_bottom = 4
clip_children = 1
[node name="MaskedChild" type="ColorRect" parent="ClipOnlyPatch"]
offset_right = 80
offset_bottom = 40
color = Color(1, 0, 0, 1)
[node name="ClipDrawPatch" type="NinePatchRect" parent="."]
offset_top = 275
offset_right = 80
offset_bottom = 315
texture = ExtResource("1")
patch_margin_left = 4
patch_margin_top = 4
patch_margin_right = 4
patch_margin_bottom = 4
clip_children = 2
[node name="FullMarginClipOnlyPatch" type="NinePatchRect" parent="."]
offset_top = 320
offset_right = 80
offset_bottom = 360
texture = ExtResource("3")
patch_margin_left = 4
patch_margin_right = 4
clip_children = 1
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => {
        if (ref.id === "1") {
          return {
            path: "res://panel.png",
            url: EMBEDDED_PNG,
            size: { width: 64, height: 64 },
          };
        }
        if (ref.id === "3") {
          return {
            path: "res://full-margin-mask.png",
            url: EMBEDDED_PNG,
            size: { width: 8, height: 8 },
          };
        }
        return {
          path: "res://missing-size.png",
          url: EMBEDDED_PNG,
        };
      },
    });

    const tintedImage = model.nodes.find((node) => node.path === "TintedImage");
    // Plain TextureRect modulate bakes into an alpha-preserving feColorMatrix
    // (combined modulate*self_modulate RGB = 0.5*0.5, 0.25*1, 1*0.25 = 0.25 each)
    // rather than a background-color multiply, so edges keep the texture alpha.
    expect(tintedImage?.selfAttributes["data-godot-texture-tint"]).toBe(
      "svg-color-matrix",
    );
    expect(tintedImage?.selfStyle["background-color"]).toBeUndefined();
    expect(tintedImage?.selfStyle["background-blend-mode"]).toBeUndefined();
    expect(
      decodeURIComponent(tintedImage?.selfStyle["background-image"] ?? ""),
    ).toContain('values="0.25 0 0 0 0 0 0.25 0 0 0 0 0 0.25 0 0 0 0 0 1 0"');
    expect(tintedImage?.style.opacity).toBe("0.6");
    expect(tintedImage?.selfStyle.opacity).toBe("0.5");

    const whiteImage = model.nodes.find((node) => node.path === "WhiteImage");
    expect(
      whiteImage?.selfAttributes["data-godot-texture-tint"],
    ).toBeUndefined();
    expect(whiteImage?.selfStyle["background-blend-mode"]).toBeUndefined();
    expect(whiteImage?.selfStyle["background-image"]).toBe(
      `url("${EMBEDDED_PNG}")`,
    );
    expect(whiteImage?.style.opacity).toBeUndefined();
    expect(whiteImage?.selfStyle.opacity).toBe("0.5");

    const tintedPatch = model.nodes.find((node) => node.path === "TintedPatch");
    expect(tintedPatch?.selfAttributes["data-godot-texture-tint"]).toBe(
      "svg-color-matrix",
    );
    expect(tintedPatch?.selfStyle["border-image-source"]).toContain(
      'url("data:image/svg+xml,',
    );
    expect(
      decodeURIComponent(tintedPatch?.selfStyle["border-image-source"] ?? ""),
    ).toContain('values="0.158 0 0 0 0 0 0.272 0 0 0 0 0 0.31 0 0 0 0 0 1 0"');
    expect(tintedPatch?.selfStyle["border-image-slice"]).toBe("4 4 4 4 fill");
    expect(tintedPatch?.html).toBeNull();

    const tintedStretchPatch = model.nodes.find(
      (node) => node.path === "TintedStretchPatch",
    );
    expect(
      tintedStretchPatch?.selfStyle["border-image-source"],
    ).toBeUndefined();
    expect(tintedStretchPatch?.selfAttributes["data-godot-texture-tint"]).toBe(
      "svg-color-matrix",
    );
    expect(
      tintedStretchPatch?.html?.match(/data-godot-nine-patch-slice/g),
    ).toHaveLength(9);
    expect(decodeURIComponent(tintedStretchPatch?.html ?? "")).toContain(
      'values="0.5 0 0 0 0 0 0.25 0 0 0 0 0 1 0 0 0 0 0 1 0"',
    );
    expect(tintedStretchPatch?.html).not.toContain(
      "background-blend-mode:multiply",
    );
    expect(tintedStretchPatch?.html).not.toContain("mask-image");

    const whitePatch = model.nodes.find((node) => node.path === "WhitePatch");
    expect(whitePatch?.selfStyle["border-image-source"]).toBe(
      `url("${EMBEDDED_PNG}")`,
    );
    expect(whitePatch?.selfStyle["border-image-slice"]).toBe("4 4 4 4 fill");
    expect(whitePatch?.html).toBeNull();

    const missingSizePatch = model.nodes.find(
      (node) => node.path === "MissingSizePatch",
    );
    expect(missingSizePatch?.selfAttributes["data-godot-texture-tint"]).toBe(
      "missing-image-size",
    );
    expect(missingSizePatch?.selfStyle["border-image-source"]).toBe(
      `url("${EMBEDDED_PNG}")`,
    );
    expect(missingSizePatch?.html).toBeNull();

    const clipOnlyPatch = model.nodes.find(
      (node) => node.path === "ClipOnlyPatch",
    );
    // The clip-children alpha mask masks the node's CHILDREN, so it must live on
    // the outer element (`style`/`attributes`) — the self-layer is a sibling of
    // the children and a mask there would never clip them.
    expect(clipOnlyPatch?.attributes["data-godot-clip-mask"]).toBe(
      "nine-patch-alpha",
    );
    expect(clipOnlyPatch?.selfStyle["mask-image"]).toBeUndefined();
    expect(clipOnlyPatch?.selfStyle["border-image-source"]).toBeUndefined();
    expect(clipOnlyPatch?.selfStyle["background-image"]).toBeUndefined();
    expect(clipOnlyPatch?.html).toBeNull();
    expect(clipOnlyPatch?.style["mask-image"]).toContain(
      'url("data:image/svg+xml,',
    );
    expect(clipOnlyPatch?.style["mask-mode"]).toBe("alpha");
    expect(clipOnlyPatch?.style.overflow).toBe("hidden");
    expect(clipOnlyPatch?.style["-webkit-mask-image"]).toBe(
      clipOnlyPatch?.style["mask-image"],
    );
    const decodedMask = decodeURIComponent(
      clipOnlyPatch?.style["mask-image"] ?? "",
    );
    expect(decodedMask).toContain('viewBox="0 0 80 40"');
    expect(decodedMask).toContain(`href="${EMBEDDED_PNG}"`);

    const clipDrawPatch = model.nodes.find(
      (node) => node.path === "ClipDrawPatch",
    );
    expect(
      clipDrawPatch?.selfAttributes["data-godot-clip-mask"],
    ).toBeUndefined();
    expect(clipDrawPatch?.selfStyle["border-image-source"]).toBe(
      `url("${EMBEDDED_PNG}")`,
    );
    expect(clipDrawPatch?.html).toBeNull();

    const fullMarginClipOnlyPatch = model.nodes.find(
      (node) => node.path === "FullMarginClipOnlyPatch",
    );
    const decodedFullMarginMask = decodeURIComponent(
      fullMarginClipOnlyPatch?.style["mask-image"] ?? "",
    );
    expect(fullMarginClipOnlyPatch?.attributes["data-godot-clip-mask"]).toBe(
      "nine-patch-alpha",
    );
    expect(decodedFullMarginMask).toContain('x="4" y="0" width="72"');
    expect(decodedFullMarginMask).toContain('viewBox="4 0 1 8"');
  });

  it("keeps children visible when self_modulate only hides a TextureRect's own paint", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://mask.png" id="mask"]
[ext_resource type="Texture2D" path="res://child.png" id="child"]
[node name="Root" type="Control"]
offset_right = 128
offset_bottom = 128
[node name="TransparentContainer" type="TextureRect" parent="."]
offset_right = 128
offset_bottom = 128
self_modulate = Color(1, 1, 1, 0)
texture = ExtResource("mask")
[node name="ChildImage" type="TextureRect" parent="TransparentContainer"]
offset_right = 32
offset_bottom = 32
texture = ExtResource("child")
[node name="ChildParticles" type="GPUParticles2D" parent="TransparentContainer"]
position = Vector2(64, 64)
visibility_rect = Rect2(-16, -16, 32, 32)
amount = 1
texture = ExtResource("child")
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => ({
        path: ref.id === "mask" ? "res://mask.png" : "res://child.png",
        url: ref.id === "mask" ? "/mask.png" : "/child.png",
        size: { width: 32, height: 32 },
      }),
    });

    const container = model.nodes.find(
      (node) => node.path === "TransparentContainer",
    );
    expect(container?.style.opacity).toBeUndefined();
    expect(container?.selfStyle.opacity).toBe("0");
    expect(container?.selfStyle["background-image"]).toBe('url("/mask.png")');

    const childImage = model.nodes.find(
      (node) => node.path === "TransparentContainer/ChildImage",
    );
    expect(childImage?.style.opacity).toBeUndefined();
    expect(childImage?.selfStyle.opacity).toBeUndefined();
    expect(childImage?.selfStyle["background-image"]).toBe('url("/child.png")');

    const particles = model.nodes.find(
      (node) => node.path === "TransparentContainer/ChildParticles",
    );
    expect(particles?.style.opacity).toBeUndefined();
    expect(particles?.html).toContain(
      "background-image:url(&quot;/child.png&quot;)",
    );
  });

  it("masks clip-children nine-patch capsule symmetrically and on the child-hosting element", () => {
    // Mirrors the STS2 HP-bar capsule: a `clip_children = CLIP_CHILDREN_ONLY`
    // NinePatchRect (`Mask`) whose rounded texture clips a rectangular tinted
    // fill child to the capsule shape — both ends rounded identically.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://capsule.png" id="1"]
[ext_resource type="Texture2D" path="res://fill.png" id="2"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 10
[node name="Mask" type="NinePatchRect" parent="."]
clip_children = 1
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
texture = ExtResource("1")
patch_margin_left = 6
patch_margin_right = 6
[node name="Fill" type="NinePatchRect" parent="Mask"]
self_modulate = Color(0.945, 0.216, 0.243, 1)
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
texture = ExtResource("2")
patch_margin_left = 6
patch_margin_right = 6
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) =>
        ref.id === "1"
          ? {
              path: "res://capsule.png",
              url: EMBEDDED_PNG,
              size: { width: 12, height: 10 },
            }
          : {
              path: "res://fill.png",
              url: EMBEDDED_PNG,
              size: { width: 12, height: 10 },
            },
    });

    const mask = model.nodes.find((node) => node.path === "Mask");
    // The mask must be on the outer element (which hosts `Fill`), never on the
    // self-layer — otherwise it would not clip the child at all.
    expect(mask?.attributes["data-godot-clip-mask"]).toBe("nine-patch-alpha");
    expect(mask?.style["mask-mode"]).toBe("alpha");
    expect(mask?.style.overflow).toBe("hidden");
    expect(mask?.selfStyle["mask-image"]).toBeUndefined();

    const decoded = decodeURIComponent(mask?.style["mask-image"] ?? "");
    // Left cap slice draws source x∈[0,6] into dest x=0; right cap draws the
    // mirrored source x∈[6,12] into dest x=W-6 — symmetric rounded ends.
    expect(decoded).toContain(
      '<svg x="0" y="0" width="6" height="10" viewBox="0 0 6 10"',
    );
    expect(decoded).toContain(
      '<svg x="94" y="0" width="6" height="10" viewBox="6 0 6 10"',
    );

    // The masked child keeps its modulate multiply tint (red onto a white fill).
    const fill = model.nodes.find((node) => node.path === "Mask/Fill");
    expect(fill?.selfAttributes["data-godot-texture-tint"]).toBe(
      "svg-color-matrix",
    );
    expect(
      decodeURIComponent(fill?.selfStyle["border-image-source"] ?? ""),
    ).toContain('values="0.945 0 0 0 0 0 0.216 0 0 0 0 0 0.243 0 0 0 0 0 1 0"');
  });

  it("clips an EXTERNAL clip-children nine-patch via mask-border, not a drawn border-image", () => {
    // The STS2 HP-bar capsule `Mask` (clip_children=CLIP_CHILDREN_ONLY) again, but
    // with an EXTERNAL texture URL (the presentation pipeline never inlines image
    // bytes). The `data:` SVG mask can't load an external href, so the children must
    // be clipped with a native nine-patch mask (`-webkit-mask-box-image`/`mask-border`)
    // and the capsule texture must NOT be drawn (no white fill over the dark track).
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://capsule.png" id="1"]
[ext_resource type="Texture2D" path="res://fill.png" id="2"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 10
[node name="Mask" type="NinePatchRect" parent="."]
clip_children = 1
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
texture = ExtResource("1")
patch_margin_left = 6
patch_margin_right = 6
[node name="Fill" type="NinePatchRect" parent="Mask"]
self_modulate = Color(0.945, 0.216, 0.243, 1)
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
texture = ExtResource("2")
patch_margin_left = 6
patch_margin_right = 6
`);
    const CAPSULE_URL = "https://assets.example/capsule.png";
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) =>
        ref.id === "1"
          ? {
              path: "res://capsule.png",
              url: CAPSULE_URL,
              size: { width: 12, height: 10 },
            }
          : {
              path: "res://fill.png",
              url: EMBEDDED_PNG,
              size: { width: 12, height: 10 },
            },
    });

    const mask = model.nodes.find((node) => node.path === "Mask");
    // Native nine-patch mask on the outer (child-hosting) element — clips children,
    // paints nothing. Slices clamped so the 12px-wide / 6+6-margin capsule keeps a
    // `fill` center (0 5 0 5), widths stay the authored margins (0 6 0 6).
    expect(mask?.attributes["data-godot-clip-mask"]).toBe("nine-patch-border");
    expect(mask?.style.overflow).toBe("hidden");
    expect(mask?.style["mask-border-slice"]).toBe("0 5 0 5 fill");
    expect(mask?.style["mask-border-width"]).toBe("0px 6px 0px 6px");
    expect(mask?.style["mask-border-mode"]).toBe("alpha");
    expect(mask?.style["-webkit-mask-box-image"]).toBe(
      `url("${CAPSULE_URL}") 0 5 0 5 fill / 0px 6px 0px 6px / 0 stretch stretch`,
    );
    // The capsule texture is NEVER drawn (no white border-image), neither on the
    // outer element nor the self-layer; the mask lives on the outer element only.
    expect(mask?.style["border-image-source"]).toBeUndefined();
    expect(mask?.selfStyle["border-image-source"]).toBeUndefined();
    expect(mask?.selfStyle["-webkit-mask-box-image"]).toBeUndefined();
  });

  it("renders RichTextLabel text literally when bbcode_enabled is unset", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 200
offset_bottom = 100
text = "[b]Hello[/b] [i]world[/i]"
`);
    const model = renderSceneToHtmlModel(scene);
    const text = model.nodes.find((node) => node.path === "Text");
    expect(text?.text).toBe("[b]Hello[/b] [i]world[/i]");
    expect(text?.html ?? "").not.toContain("data-godot-rich-layer");
    expect(text?.html ?? "").not.toContain("godot-rich-bold");
  });

  it("keeps RichTextLabel layers inside the stable Godot node element", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 200
offset_bottom = 100
bbcode_enabled = true
text = "[b]Layered[/b]"
theme_override_colors/default_color = Color(1, 0.95, 0.8, 1)
theme_override_colors/font_shadow_color = Color(0, 0, 0, 0.35)
theme_override_colors/font_outline_color = Color(0.1, 0.12, 0.16, 1)
theme_override_constants/shadow_offset_x = 2
theme_override_constants/shadow_offset_y = 3
theme_override_constants/outline_size = 2
`);
    const host = document.createElement("div");
    mountHtmlScene(host, renderSceneToHtmlModel(scene));
    const text = host.querySelector<HTMLElement>('[data-godot-path="Text"]');
    expect(text?.dataset.godotType).toBe("RichTextLabel");
    expect(
      [...(text?.querySelectorAll("[data-godot-rich-layer]") ?? [])].map(
        (layer) => layer.getAttribute("data-godot-rich-layer"),
      ),
    ).toEqual(["shadow-outline", "shadow-fill", "outline", "fill"]);
    expect(
      text?.querySelector('[data-godot-rich-layer="fill"] strong')?.textContent,
    ).toBe("Layered");
  });

  it("keeps BBCode colors and backgrounds out of non-fill RichTextLabel layers", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 240
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 240
offset_bottom = 100
bbcode_enabled = true
text = "[color=#e05252]Red [b][gold]Gold[/gold][/b][/color] [bgcolor=#112233]Back[/bgcolor]"
theme_override_colors/default_color = Color(1, 1, 1, 1)
theme_override_colors/font_shadow_color = Color(0, 0, 0, 0.5)
theme_override_colors/font_outline_color = Color(0, 0, 0, 1)
theme_override_constants/shadow_offset_x = 2
theme_override_constants/shadow_offset_y = 3
theme_override_constants/outline_size = 2
`);
    const model = renderSceneToHtmlModel(scene, {
      bbcodeTags: {
        gold: { kind: "color", value: "#f6c453" },
      },
    });
    const host = document.createElement("div");
    const style = document.createElement("style");
    style.textContent = model.css;
    document.head.appendChild(style);
    document.body.appendChild(host);
    mountHtmlScene(host, model);

    try {
      const text = host.querySelector<HTMLElement>('[data-godot-path="Text"]');
      const layers = [
        ...(text?.querySelectorAll<HTMLElement>("[data-godot-rich-layer]") ??
          []),
      ];
      expect(layers.map((layer) => layer.dataset.godotRichLayer)).toEqual([
        "shadow-outline",
        "shadow-fill",
        "outline",
        "fill",
      ]);

      const layer = (name: string) =>
        text?.querySelector<HTMLElement>(`[data-godot-rich-layer="${name}"]`);
      const colorSpan = (root: HTMLElement | null | undefined, value: string) =>
        root?.querySelector<HTMLElement>(
          `.godot-rich-color[data-godot-bbcode-color="${value}"]`,
        );
      const bgSpan = (root: HTMLElement | null | undefined) =>
        root?.querySelector<HTMLElement>(".godot-rich-bgcolor");

      expect(
        getComputedStyle(colorSpan(layer("shadow-outline"), "#e05252")!).color,
      ).toBe("rgba(0, 0, 0, 0)");
      expect(
        getComputedStyle(colorSpan(layer("outline"), "#e05252")!).color,
      ).toBe("rgba(0, 0, 0, 0)");
      expect(
        getComputedStyle(colorSpan(layer("shadow-fill"), "#e05252")!).color,
      ).not.toBe("rgb(224, 82, 82)");
      expect(
        getComputedStyle(colorSpan(layer("shadow-fill"), "#f6c453")!).color,
      ).not.toBe("rgb(246, 196, 83)");

      for (const name of ["shadow-outline", "shadow-fill", "outline"]) {
        expect(getComputedStyle(bgSpan(layer(name))!).backgroundColor).toBe(
          "rgba(0, 0, 0, 0)",
        );
      }

      expect(getComputedStyle(colorSpan(layer("fill"), "#e05252")!).color).toBe(
        "rgb(224, 82, 82)",
      );
      expect(getComputedStyle(colorSpan(layer("fill"), "#f6c453")!).color).toBe(
        "rgb(246, 196, 83)",
      );
      expect(getComputedStyle(bgSpan(layer("fill"))!).backgroundColor).toBe(
        "rgb(17, 34, 51)",
      );
    } finally {
      host.remove();
      style.remove();
    }
  });

  it("scales explicit RichTextLabel outline theme values for non-MSDF fonts", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="FontFile" path="res://font.ttf" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 200
offset_bottom = 100
text = "Outlined"
theme_override_constants/outline_size = 2
theme_override_constants/line_separation = -2
theme_override_font_sizes/normal_font_size = 24
theme_override_fonts/normal_font = ExtResource("1")
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://font.ttf",
        fontFamily: "GodotFont",
        fontUrl: "/font.ttf",
      }),
    });
    const text = model.nodes.find((node) => node.path === "Text");
    expect(text?.selfStyle["font-size"]).toBeUndefined();
    expect(text?.selfStyle["line-height"]).toBe("22px");
    expect(text?.selfStyle["--godot-rich-outline-size"]).toBe("1px");
    expect(text?.selfStyle["--godot-rich-shadow-outline-size"]).toBe("0.5px");
    expect(text?.selfStyle["--godot-rich-normal-font-size"]).toBe("24px");
    expect(text?.selfStyle["--godot-rich-bold-font-weight"]).toBeUndefined();
    expect(text?.selfStyle["font-variation-settings"]).toBeUndefined();
  });

  it("keeps RichTextLabel outline theme values unscaled for MSDF fonts", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="FontFile" path="res://font.tres" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 200
offset_bottom = 100
text = "Outlined"
theme_override_constants/outline_size = 2
theme_override_font_sizes/normal_font_size = 24
theme_override_fonts/normal_font = ExtResource("1")
`);
    const fontFile = parseGodotResource(`
[gd_resource type="FontFile" load_steps=1 format=3]
[resource]
font_path = "res://font.ttf"
multichannel_signed_distance_field = true
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://font.tres",
        url: "/font.ttf",
        document: fontFile,
      }),
    });
    const text = model.nodes.find((node) => node.path === "Text");
    expect(text?.selfStyle["--godot-rich-outline-size"]).toBe("2px");
    expect(text?.selfStyle["--godot-rich-shadow-outline-size"]).toBe("1px");
  });

  it("scales Label outline theme values for non-MSDF browser strokes", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Text" type="Label" parent="."]
offset_right = 200
offset_bottom = 100
text = "Outlined"
theme_override_colors/font_outline_color = Color(0.1, 0.12, 0.16, 1)
theme_override_constants/outline_size = 2
`);
    const model = renderSceneToHtmlModel(scene);
    const text = model.nodes.find((node) => node.path === "Text");
    expect(text?.selfStyle["-webkit-text-stroke"]).toBe(
      "1px rgba(26, 31, 41, 1)",
    );
    expect(text?.selfStyle["paint-order"]).toBe("stroke fill");
  });

  it("uses RichTextLabel font sizes per BBCode style", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 200
offset_bottom = 100
bbcode_enabled = true
text = "[b]Bold[/b] [i]italic[/i] [b][i]both[/i][/b] normal"
theme_override_font_sizes/normal_font_size = 24
theme_override_font_sizes/bold_font_size = 18
theme_override_font_sizes/italics_font_size = 20
theme_override_font_sizes/bold_italics_font_size = 22
`);
    const model = renderSceneToHtmlModel(scene);
    const text = model.nodes.find((node) => node.path === "Text");
    expect(text?.selfStyle["font-size"]).toBeUndefined();
    expect(text?.selfStyle["--godot-rich-normal-font-size"]).toBe("19.2px");
    expect(text?.selfStyle["--godot-rich-bold-font-size"]).toBe("14.4px");
    expect(text?.selfStyle["--godot-rich-italic-font-size"]).toBe("16px");
    expect(text?.selfStyle["--godot-rich-bold-italic-font-size"]).toBe(
      "17.6px",
    );
  });

  it("does not inherit RichTextLabel normal font size into styled runs", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 200
offset_bottom = 100
bbcode_enabled = true
text = "[b]Bold[/b] [i]italic[/i] normal"
theme_override_font_sizes/normal_font_size = 24
`);
    const model = renderSceneToHtmlModel(scene);
    const text = model.nodes.find((node) => node.path === "Text");
    expect(text?.selfStyle["--godot-rich-normal-font-size"]).toBe("19.2px");
    expect(text?.selfStyle["--godot-rich-bold-font-size"]).toBeUndefined();
    expect(text?.selfStyle["--godot-rich-italic-font-size"]).toBeUndefined();
    expect(
      text?.selfStyle["--godot-rich-bold-italic-font-size"],
    ).toBeUndefined();
  });

  it("applies a per-role bold font family to RichTextLabel bold runs", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[ext_resource type="FontFile" path="res://fonts/kreon_regular.ttf" id="1"]
[ext_resource type="FontVariation" path="res://themes/kreon_bold.tres" id="2"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 200
offset_bottom = 100
bbcode_enabled = true
text = "[b]Bold[/b] normal"
theme_override_fonts/normal_font = ExtResource("1")
theme_override_fonts/bold_font = ExtResource("2")
`);
    const boldVariation = parseGodotResource(`
[gd_resource type="FontVariation" load_steps=2 format=3]
[ext_resource type="FontFile" path="res://fonts/kreon_bold.ttf" id="base"]
[resource]
base_font = ExtResource("base")
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => {
        if (ref.id === "1") {
          return {
            path: "res://fonts/kreon_regular.ttf",
            fontFamily: "kreon_regular",
            fontUrl: "/kreon_regular.ttf",
          };
        }
        if (ref.id === "2") {
          return { document: boldVariation };
        }
        if (ref.id === "base") {
          return {
            path: "res://fonts/kreon_bold.ttf",
            fontFamily: "kreon_bold",
            fontUrl: "/kreon_bold.ttf",
          };
        }
        return undefined;
      },
    });
    const text = model.nodes.find((node) => node.path === "Text");
    // The node-wide family stays the normal font; the bold run gets its own var
    // so `.godot-rich-bold` overrides the inherited normal family.
    expect(text?.attributes["data-godot-font-family"]).toBe("kreon_regular");
    expect(text?.selfStyle["--godot-rich-bold-font-family"]).toBe("kreon_bold");
    // No italics override -> no var, so italic runs fall back to inherit.
    expect(text?.selfStyle["--godot-rich-italic-font-family"]).toBeUndefined();
    expect(model.fontFaces).toContainEqual({
      fontFamily: "kreon_bold",
      url: "/kreon_bold.ttf",
      style: "normal",
      weight: "400",
    });
  });

  it("exposes a per-role letter-spacing var for each RichTextLabel role", () => {
    // Consuming contract for producers that know each role font's glyph spacing.
    // Unset roles fall back to what they render with today, so this is additive.
    expect(godotSceneBaseCss).toContain(
      "letter-spacing: var(--godot-rich-bold-letter-spacing, var(--godot-rich-letter-spacing, 0.25px));",
    );
    expect(godotSceneBaseCss).toContain(
      "letter-spacing: var(--godot-rich-italic-letter-spacing, calc(var(--godot-rich-letter-spacing, 0.25px) * 0.7));",
    );
    expect(godotSceneBaseCss).toContain(
      "letter-spacing: var(--godot-rich-bold-italic-letter-spacing, calc(var(--godot-rich-letter-spacing, 0.25px) * 0.7));",
    );
  });

  it("uses Godot default white text color for text controls", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Plain" type="Label" parent="."]
offset_right = 100
offset_bottom = 30
text = "Label"
[node name="Rich" type="RichTextLabel" parent="."]
offset_top = 40
offset_right = 100
offset_bottom = 80
text = "Rich"
`);
    const model = renderSceneToHtmlModel(scene);
    expect(
      model.nodes.find((node) => node.path === "Plain")?.selfStyle.color,
    ).toBe("rgba(255, 255, 255, 1)");
    const rich = model.nodes.find((node) => node.path === "Rich");
    expect(rich?.selfStyle.color).toBe("rgba(255, 255, 255, 1)");
    expect(rich?.selfStyle["--godot-rich-text-color"]).toBe(
      "rgba(255, 255, 255, 1)",
    );
  });

  it("orders DOM children by the explicit node index", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 200
[node name="A" type="ColorRect" parent="."]
offset_right = 20
offset_bottom = 20
[node name="B" type="ColorRect" parent="."]
offset_right = 20
offset_bottom = 20
[node name="C" type="ColorRect" parent="." index="0"]
offset_right = 20
offset_bottom = 20
`);
    const host = document.createElement("div");
    mountHtmlScene(host, renderSceneToHtmlModel(scene));
    const root = host.querySelector<HTMLElement>('[data-godot-path="."]');
    const order = [...(root?.children ?? [])].map((child) =>
      child.getAttribute("data-godot-self-layer") === "true"
        ? "self"
        : child.getAttribute("data-godot-path"),
    );
    expect(order).toEqual(["self", "C", "A", "B"]);
  });

  it("keeps generic Node placeholders and nests renderable descendants", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="System" type="Node" parent="."]
[node name="Panel" type="ColorRect" parent="System"]
offset_right = 20
offset_bottom = 20
`);
    const model = renderSceneToHtmlModel(scene);
    const system = model.nodes.find((node) => node.path === "System");
    expect(system?.attributes).toMatchObject({
      "data-godot-type": "Node",
      "data-godot-placeholder": "true",
      "data-godot-resource-kind": "Node",
    });
    expect(
      model.nodes.find((node) => node.path === "System/Panel")?.parentPath,
    ).toBe("System");
  });

  it("resolves AtlasTexture and FontVariation resource documents", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://icon.tres" id="1"]
[ext_resource type="FontVariation" path="res://font.tres" id="2"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Icon" type="TextureRect" parent="."]
offset_right = 20
offset_bottom = 20
texture = ExtResource("1")
[node name="Text" type="Label" parent="."]
offset_top = 30
offset_right = 100
offset_bottom = 60
text = "Hi"
theme_override_fonts/font = ExtResource("2")
`);
    const atlas = parseGodotResource(`
[gd_resource type="AtlasTexture" load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://atlas.png" id="atlas"]
[resource]
atlas = ExtResource("atlas")
region = Rect2(4, 5, 16, 17)
`);
    const fontVariation = parseGodotResource(`
[gd_resource type="FontVariation" load_steps=2 format=3]
[ext_resource type="FontFile" path="res://font.ttf" id="base"]
[resource]
base_font = ExtResource("base")
variation_opentype = { 2003265652: 700.0 }
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => {
        if (ref.id === "1") {
          return { document: atlas };
        }
        if (ref.id === "atlas") {
          return {
            path: "res://atlas.png",
            url: EMBEDDED_PNG,
            size: { width: 64, height: 64 },
          };
        }
        if (ref.id === "2") {
          return { document: fontVariation };
        }
        if (ref.id === "base") {
          return {
            path: "res://font.ttf",
            fontFamily: "Kreon",
            fontUrl: "/font.ttf",
          };
        }
        return undefined;
      },
    });
    const icon = model.nodes.find((node) => node.path === "Icon");
    // AtlasTexture sprites resolve to a standalone cropped image, so the region
    // is baked into the texture rather than re-derived via CSS background offsets.
    expect(icon?.attributes["data-godot-atlas-region"]).toBeUndefined();
    expect(icon?.attributes["data-godot-resource-path"]).toBe(
      "res://atlas.png",
    );
    expect(icon?.selfStyle["background-position"]).toBe("center");
    expect(icon?.selfStyle["background-size"]).toBe("100% 100%");
    const iconImage = icon?.selfStyle["background-image"] ?? "";
    expect(iconImage).toContain("data:image/svg+xml");
    const iconSvg = decodeURIComponent(
      iconImage.replace(/^url\("data:image\/svg\+xml,/, "").replace(/"\)$/, ""),
    );
    expect(iconSvg).toContain('width="16" height="17"');
    expect(iconSvg).toContain('viewBox="4 5 16 17"');
    expect(iconSvg).toContain(`href="${EMBEDDED_PNG}"`);
    expect(
      model.nodes.find((node) => node.path === "Text")?.attributes[
        "data-godot-font-family"
      ],
    ).toBe("Kreon");
    expect(model.fontFaces).toEqual([
      { fontFamily: "Kreon", url: "/font.ttf", style: "normal", weight: "700" },
    ]);
  });

  it("honors AtlasTexture margin for keep-aspect-centered TextureRects", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://icon.tres" id="1"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Icon" type="TextureRect" parent="."]
offset_right = 40
offset_bottom = 40
texture = ExtResource("1")
stretch_mode = 5
`);
    const atlas = parseGodotResource(`
[gd_resource type="AtlasTexture" load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://atlas.png" id="atlas"]
[resource]
atlas = ExtResource("atlas")
region = Rect2(10, 20, 16, 10)
margin = Rect2(-2, -3, 4, 6)
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => {
        if (ref.id === "1") {
          return { document: atlas };
        }
        if (ref.id === "atlas") {
          return {
            path: "res://atlas.png",
            url: EMBEDDED_PNG,
            size: { width: 64, height: 64 },
          };
        }
        return undefined;
      },
    });
    const icon = model.nodes.find((node) => node.path === "Icon");
    // The region+margin are pre-cropped into the standalone texture, so the
    // atlas-region/atlas-margin debug attributes are no longer emitted.
    expect(icon?.attributes["data-godot-atlas-region"]).toBeUndefined();
    expect(icon?.attributes["data-godot-atlas-margin"]).toBeUndefined();
    expect(icon?.selfStyle["background-size"]).toBe("contain");
    expect(icon?.selfStyle["background-position"]).toBe("center");
    const imageUrl = icon?.selfStyle["background-image"] ?? "";
    expect(imageUrl).toContain("data:image/svg+xml");
    const svg = decodeURIComponent(
      imageUrl.replace(/^url\("data:image\/svg\+xml,/, "").replace(/"\)$/, ""),
    );
    expect(svg).toContain('width="20" height="16"');
    expect(svg).toContain('x="0" y="0" width="14" height="7"');
    expect(svg).toContain('viewBox="12 23 14 7"');
  });

  it("renders flipped texture metadata, tint metadata, nine-patch axis data, and draw metadata", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://panel.png" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Image" type="TextureRect" parent="."]
offset_right = 40
offset_bottom = 20
texture = ExtResource("1")
region_rect = Rect2(4, 5, 16, 17)
flip_h = true
self_modulate = Color(1, 1, 1, 0.5)
modulate = Color(0.8, 0.9, 1, 0.75)
show_behind_parent = true
[node name="Patch" type="NinePatchRect" parent="."]
offset_left = 50
offset_right = 100
offset_bottom = 30
texture = ExtResource("1")
patch_margin_left = 3
patch_margin_top = 4
patch_margin_right = 5
patch_margin_bottom = 6
axis_stretch_horizontal = 2
axis_stretch_vertical = 1
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://panel.png",
        url: EMBEDDED_PNG,
        size: { width: 64, height: 64 },
      }),
    });
    const image = model.nodes.find((node) => node.path === "Image");
    expect(image?.attributes["data-godot-region-rect"]).toBeUndefined();
    expect(image?.attributes["data-godot-modulate"]).toBe(
      "rgba(204, 230, 255, 0.75)",
    );
    expect(image?.attributes["data-godot-self-modulate"]).toBe(
      "rgba(255, 255, 255, 0.5)",
    );
    expect(image?.attributes["data-godot-flip-h"]).toBe("true");
    expect(image?.attributes["data-godot-show-behind-parent"]).toBe("true");
    // flip_h mirrors only the node's own texture (self-layer), never the outer
    // element — so it cannot cascade to child nodes.
    expect(image?.style.transform).toBeUndefined();
    expect(image?.selfStyle.transform).toBe("scale(-1, 1)");
    expect(image?.selfStyle["transform-origin"]).toBe("50% 50%");
    expect(image?.style.opacity).toBe("0.75");
    expect(image?.selfStyle.opacity).toBe("0.5");
    expect(image?.style["z-index"]).toBeUndefined();

    const patch = model.nodes.find((node) => node.path === "Patch");
    expect(patch?.attributes["data-godot-patch-margins"]).toBe("3,4,5,6");
    expect(patch?.attributes["data-godot-axis-stretch-horizontal"]).toBe("2");
    expect(patch?.selfStyle["border-image-repeat"]).toBeUndefined();
    expect(patch?.html?.match(/data-godot-nine-patch-slice/g)).toHaveLength(9);
  });

  it("clamps overflow per-slice while keeping authored nine-patch region geometry", () => {
    // The dialogue Bubble authors a 116x85 region over a 114x82 texture. Godot
    // keeps the authored region for all geometry (tile widths, corner sizes, dest
    // positions) and only edge-clamps the 2px/3px texture overflow. The slicer
    // must do the same: clamp each slice's SOURCE to the texture (so it never
    // samples past the image, no transparent overflow) while leaving the segment
    // partitioning and dest from the authored region untouched.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://bubble.png" id="1"]
[node name="Root" type="Control"]
offset_right = 400
offset_bottom = 200
[node name="Overflow" type="NinePatchRect" parent="."]
offset_right = 200
offset_bottom = 150
texture = ExtResource("1")
region_rect = Rect2(0, 0, 116, 85)
patch_margin_left = 27
patch_margin_top = 28
patch_margin_right = 27
patch_margin_bottom = 28
axis_stretch_horizontal = 1
axis_stretch_vertical = 1
[node name="InBounds" type="NinePatchRect" parent="."]
offset_right = 200
offset_bottom = 150
texture = ExtResource("1")
region_rect = Rect2(0, 0, 100, 70)
patch_margin_left = 27
patch_margin_top = 28
patch_margin_right = 27
patch_margin_bottom = 28
axis_stretch_horizontal = 1
axis_stretch_vertical = 1
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://bubble.png",
        url: EMBEDDED_PNG,
        size: { width: 114, height: 82 },
      }),
    });

    const overflow = model.nodes.find((node) => node.path === "Overflow");
    const overflowHtml = decodeURIComponent(overflow?.html ?? "");
    // Center TILE keeps the authored 116 - 27 - 27 = 62px source width (sampled
    // at the authored start x=27) — NOT the prior whole-region clamp's 60px.
    expect(overflowHtml).toContain('viewBox="0 0 62 28"');
    expect(overflowHtml).toContain('x="-27"');
    // Right column: dest stays at the authored boxW - right = 200 - 27 = 173,
    // sampled from the authored start x=89, but the SOURCE is clamped to the
    // texture (89 + 25 = 114) so it never reads past the image.
    expect(overflowHtml).toContain("left:173px");
    expect(overflowHtml).toContain('viewBox="0 0 25 28"');
    expect(overflowHtml).toContain('x="-89"');
    // Bottom row: source clamped to texture height (57 + 25 = 82), sampled from
    // the authored start y=57.
    expect(overflowHtml).toContain('viewBox="0 0 27 25"');
    expect(overflowHtml).toContain('y="-57"');
    // Not the prior whole-region truncation (60px tile / edges pulled inward).
    expect(overflowHtml).not.toContain('viewBox="0 0 60 ');
    expect(overflowHtml).not.toContain('x="-87"');
    expect(overflowHtml).not.toContain('y="-54"');

    const inBounds = model.nodes.find((node) => node.path === "InBounds");
    const inBoundsHtml = decodeURIComponent(inBounds?.html ?? "");
    // No-op for an in-bounds region (100x70 < 114x82): right column sampled at
    // 100 - 27 = 73 with the full unclamped 27x28 corner; bottom row at
    // 70 - 28 = 42.
    expect(inBoundsHtml).toContain('x="-73"');
    expect(inBoundsHtml).toContain('viewBox="0 0 27 28"');
    expect(inBoundsHtml).toContain('y="-42"');
  });

  it("edge-clamps a small region overflow per-slice (TILE) while keeping all nine slices", () => {
    // A 66x66 region over a 64x64 texture (2px overflow), margins 16, TILE both.
    // The authored region drives the geometry; only the trailing right/bottom
    // slices clamp their SOURCE to the texture edge. No slice is dropped, and the
    // tinted panel stays fully painted.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://np64.png" id="1"]
[node name="Root" type="Control"]
offset_right = 480
offset_bottom = 200
[node name="Panel" type="NinePatchRect" parent="."]
offset_right = 360
offset_bottom = 140
texture = ExtResource("1")
region_rect = Rect2(0, 0, 66, 66)
patch_margin_left = 16
patch_margin_top = 16
patch_margin_right = 16
patch_margin_bottom = 16
axis_stretch_horizontal = 1
axis_stretch_vertical = 1
self_modulate = Color(0.16, 0.27, 0.31, 1)
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://np64.png",
        url: EMBEDDED_PNG,
        size: { width: 64, height: 64 },
      }),
    });
    const panel = model.nodes.find((node) => node.path === "Panel");
    const html = decodeURIComponent(panel?.html ?? "");
    expect(panel?.html?.match(/data-godot-nine-patch-slice/g)).toHaveLength(9);
    // Center TILE keeps the authored 66 - 16 - 16 = 34px source (sampled at x=16).
    expect(html).toContain('viewBox="0 0 34 34"');
    // Trailing right/bottom slices clamp their SOURCE to the texture edge
    // (50 + 16 = 66 -> 64, a 14px strip), sampled from the authored start x/y=50.
    expect(html).toContain('viewBox="0 0 14 34"');
    expect(html).toContain('viewBox="0 0 34 14"');
    expect(html).toContain('viewBox="0 0 14 14"');
    expect(html).toContain('x="-50"');
    expect(html).toContain('y="-50"');
    // The self_modulate diagonal is baked per-slice (alpha-preserving matrix).
    expect(html).toContain("feColorMatrix");
    // No collapsed/NaN geometry reaches the TILE background-size.
    expect(html).not.toContain("NaN");
    expect(html).not.toMatch(/background-size:\s*0px/);
  });

  it("edge-clamps a large region overflow to a 1px strip instead of dropping trailing slices", () => {
    // A 100x100 region over a 64x64 texture, margins 32, TILE both, pushes the
    // right column and bottom row fully past the texture edge. Before the fix
    // those slices clamped to width/height 0 and were dropped (only 4 of 9 drew,
    // losing the right/bottom caps and corner). They must instead clamp to the
    // 1px boundary texel (CLAMP_TO_EDGE) and still paint.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://np64.png" id="1"]
[node name="Root" type="Control"]
offset_right = 240
offset_bottom = 240
[node name="Panel" type="NinePatchRect" parent="."]
offset_right = 200
offset_bottom = 200
texture = ExtResource("1")
region_rect = Rect2(0, 0, 100, 100)
patch_margin_left = 32
patch_margin_top = 32
patch_margin_right = 32
patch_margin_bottom = 32
axis_stretch_horizontal = 1
axis_stretch_vertical = 1
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://np64.png",
        url: EMBEDDED_PNG,
        size: { width: 64, height: 64 },
      }),
    });
    const panel = model.nodes.find((node) => node.path === "Panel");
    const html = decodeURIComponent(panel?.html ?? "");
    // All nine slices survive — the trailing ones as 1px edge strips, not dropped.
    expect(panel?.html?.match(/data-godot-nine-patch-slice/g)).toHaveLength(9);
    expect(html).toContain('viewBox="0 0 1 32"'); // right column edge strip
    expect(html).toContain('viewBox="0 0 32 1"'); // bottom row edge strip
    expect(html).toContain('viewBox="0 0 1 1"'); // bottom-right corner texel
    expect(html).toContain('x="-63"'); // sampled at the last in-bounds column
    expect(html).toContain('y="-63"');
    // No divide-by-zero / NaN from a zero-width TILE source.
    expect(html).not.toContain("NaN");
    expect(html).not.toMatch(/background-size:\s*0px/);
  });

  it("scales genuinely-scaled zero-pivot nodes around the top-left, but flips around center", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://panel.png" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Scaled" type="TextureRect" parent="."]
offset_right = 40
offset_bottom = 20
texture = ExtResource("1")
scale = Vector2(1.01, 1.01)
[node name="Flipped" type="TextureRect" parent="."]
offset_right = 40
offset_bottom = 20
texture = ExtResource("1")
flip_h = true
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://panel.png",
        url: "/panel.png",
        size: { width: 64, height: 64 },
      }),
    });
    const scaled = model.nodes.find((node) => node.path === "Scaled");
    expect(scaled?.style.transform).toBe("scale(1.01, 1.01)");
    expect(scaled?.style["transform-origin"]).toBe("0px 0px");

    const flipped = model.nodes.find((node) => node.path === "Flipped");
    expect(flipped?.style.transform).toBeUndefined();
    expect(flipped?.selfStyle.transform).toBe("scale(-1, 1)");
    expect(flipped?.selfStyle["transform-origin"]).toBe("50% 50%");
  });

  it("keeps a flipped TextureRect's child nodes un-mirrored", () => {
    // A TextureRect used as a flipped frame/mask must not mirror the nodes mounted
    // inside it (regression: the rewards screen's RewardContainerMask flips its
    // texture but the reward list rendered upside-down because the flip was a CSS
    // transform on the outer element, cascading to children).
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://mask.png" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 200
[node name="Mask" type="TextureRect" parent="."]
offset_right = 100
offset_bottom = 100
texture = ExtResource("1")
flip_h = true
flip_v = true
[node name="Child" type="Label" parent="Mask"]
offset_right = 50
offset_bottom = 20
text = "Reward"
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://mask.png",
        url: "/mask.png",
        size: { width: 64, height: 64 },
      }),
    });
    const mask = model.nodes.find((node) => node.path === "Mask");
    // The flip lives on the mask's own texture layer...
    expect(mask?.style.transform).toBeUndefined();
    expect(mask?.selfStyle.transform).toBe("scale(-1, -1)");
    // ...and the child carries no inherited mirror transform.
    const child = model.nodes.find((node) => node.path === "Mask/Child");
    expect(child?.style.transform).toBeUndefined();
    expect(child?.selfStyle.transform).toBeUndefined();
  });

  it("renders generic Range, LineEdit, TextEdit, and pass-through canvas nodes", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Canvas" type="CanvasLayer"]
[node name="Group" type="CanvasGroup" parent="."]
[node name="Slider" type="Range" parent="Group"]
offset_right = 100
offset_bottom = 10
min_value = -10
max_value = 30
value = 10
step = 0.5
[node name="Name" type="LineEdit" parent="Group"]
offset_top = 20
offset_right = 140
offset_bottom = 50
placeholder_text = "Name"
[node name="Notes" type="TextEdit" parent="Group"]
offset_top = 60
offset_right = 140
offset_bottom = 120
text = "Line one\\nLine two"
`);
    const model = renderSceneToHtmlModel(scene);
    expect(model.nodes.find((node) => node.path === ".")?.type).toBe(
      "CanvasLayer",
    );
    expect(model.nodes.find((node) => node.path === "Group")?.type).toBe(
      "CanvasGroup",
    );
    const slider = model.nodes.find((node) => node.path === "Group/Slider");
    expect(slider?.attributes).toMatchObject({
      "data-godot-range-min": "-10",
      "data-godot-range-max": "30",
      "data-godot-range-value": "10",
      "data-godot-range-step": "0.5",
    });
    expect(slider?.selfStyle["--godot-range-percent"]).toBe("50%");
    const lineEdit = model.nodes.find((node) => node.path === "Group/Name");
    expect(lineEdit?.text).toBe("Name");
    expect(lineEdit?.attributes["data-godot-placeholder"]).toBe("Name");
    expect(model.nodes.find((node) => node.path === "Group/Notes")?.text).toBe(
      "Line one\nLine two",
    );
  });

  it("renders Panel and input StyleBoxFlat/StyleBoxEmpty styles", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[sub_resource type="StyleBoxFlat" id="panel"]
bg_color = Color(0.1, 0.2, 0.3, 0.75)
border_width_left = 1
border_width_top = 2
border_width_right = 3
border_width_bottom = 4
border_color = Color(1, 0, 0, 1)
corner_radius_top_left = 5
content_margin_left = 8
[sub_resource type="StyleBoxEmpty" id="empty"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Panel" type="Panel" parent="."]
offset_right = 100
offset_bottom = 50
theme_override_styles/panel = SubResource("panel")
[node name="Input" type="LineEdit" parent="."]
offset_top = 60
offset_right = 100
offset_bottom = 90
theme_override_styles/normal = SubResource("empty")
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => {
        const resource = scene.subResources.find(
          (candidate) => candidate.id === ref.id,
        );
        return resource
          ? {
              type: resource.type,
              document: {
                kind: "resource",
                header: {
                  section: "gd_resource",
                  attributes: { type: resource.type ?? "" },
                },
                extResources: [],
                subResources: [],
                nodes: [],
                connections: [],
                editables: [],
                properties: resource.properties,
                diagnostics: [],
              },
            }
          : undefined;
      },
    });
    const panel = model.nodes.find((node) => node.path === "Panel");
    expect(panel?.attributes["data-godot-stylebox-panel"]).toBe("StyleBoxFlat");
    expect(panel?.selfStyle).toMatchObject({
      background: "rgba(26, 51, 77, 0.75)",
      "border-color": "rgba(255, 0, 0, 1)",
      "border-width": "2px 3px 4px 1px",
      "border-radius": "5px 0px 0px 0px",
      padding: "0px 0px 0px 8px",
    });
  });

  it("applies rotation, skew, texture metadata, and AnimatedSprite2D first frame styles", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=4 format=3]
[ext_resource type="Texture2D" path="res://frame.png" id="frame"]
[sub_resource type="SpriteFrames" id="frames"]
animations = [{
"frames": [{"duration": 1.0, "texture": ExtResource("frame")}],
"name": &"default"
}]
[node name="Root" type="Node2D"]
[node name="Sprite" type="AnimatedSprite2D" parent="."]
position = Vector2(10, 20)
size = Vector2(30, 40)
rotation = 1.5708
skew = 0.25
sprite_frames = SubResource("frames")
[node name="Texture" type="TextureRect" parent="."]
offset_top = 50
offset_right = 40
offset_bottom = 90
texture = ExtResource("frame")
texture_repeat = 1
texture_filter = 1
expand_mode = 1
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => {
        if (ref.type === "SubResource") {
          const resource = scene.subResources.find(
            (candidate) => candidate.id === ref.id,
          );
          return resource
            ? {
                type: resource.type,
                document: {
                  kind: "resource",
                  header: {
                    section: "gd_resource",
                    attributes: { type: resource.type ?? "" },
                  },
                  extResources: scene.extResources,
                  subResources: [],
                  nodes: [],
                  connections: [],
                  editables: [],
                  properties: resource.properties,
                  diagnostics: [],
                },
              }
            : undefined;
        }
        return { path: "res://frame.png", url: "/frame.png" };
      },
    });
    const sprite = model.nodes.find((node) => node.path === "Sprite");
    expect(sprite?.style.transform).toBe("rotate(1.571rad) skewX(0.25rad)");
    expect(sprite?.selfStyle["background-image"]).toBe('url("/frame.png")');
    expect(sprite?.attributes["data-godot-sprite-frame"]).toBe("0");
    const texture = model.nodes.find((node) => node.path === "Texture");
    expect(texture?.attributes["data-godot-texture-repeat"]).toBe("1");
    expect(texture?.attributes["data-godot-texture-filter"]).toBe("1");
    expect(texture?.attributes["data-godot-expand-mode"]).toBe("1");
    expect(texture?.selfStyle["background-repeat"]).toBe("repeat");
    expect(texture?.selfStyle["image-rendering"]).toBe("pixelated");
  });

  it("selects deterministic AnimatedSprite2D frames from SpriteFrames resources", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=6 format=3]
[ext_resource type="Texture2D" path="res://idle0.png" id="idle0"]
[ext_resource type="Texture2D" path="res://run0.png" id="run0"]
[ext_resource type="Texture2D" path="res://run1.png" id="run1"]
[sub_resource type="SpriteFrames" id="frames"]
animations = [{
"frames": [{"duration": 1.0, "texture": ExtResource("idle0")}],
"loop": true,
"name": &"idle",
"speed": 5.0
}, {
"frames": [{"duration": 1.0, "texture": ExtResource("run0")}, {"duration": 1.0, "texture": ExtResource("run1")}],
"loop": true,
"name": &"run",
"speed": 12.0
}]
[node name="Root" type="Node2D"]
[node name="Selected" type="AnimatedSprite2D" parent="."]
position = Vector2(50, 60)
offset = Vector2(3, -2)
animation = "run"
frame = 99
sprite_frames = SubResource("frames")
[node name="StringNameSelected" type="AnimatedSprite2D" parent="."]
position = Vector2(10, 12)
centered = false
animation = &"idle"
frame = 0
sprite_frames = SubResource("frames")
[node name="MissingAnimation" type="AnimatedSprite2D" parent="."]
position = Vector2(80, 90)
animation = &"missing"
frame = 0
sprite_frames = SubResource("frames")
`);
    const sizes: Record<string, { width: number; height: number }> = {
      idle0: { width: 8, height: 6 },
      run0: { width: 11, height: 7 },
      run1: { width: 24, height: 10 },
    };
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => {
        if (ref.type === "SubResource") {
          const resource = scene.subResources.find(
            (candidate) => candidate.id === ref.id,
          );
          return resource
            ? {
                type: resource.type,
                path: "res://frames.tres",
                document: {
                  kind: "resource" as const,
                  header: {
                    section: "gd_resource",
                    attributes: { type: resource.type ?? "" },
                  },
                  extResources: scene.extResources,
                  subResources: [],
                  nodes: [],
                  connections: [],
                  editables: [],
                  properties: resource.properties,
                  diagnostics: [],
                },
              }
            : undefined;
        }
        const size = sizes[ref.id];
        return { path: `res://${ref.id}.png`, url: `/${ref.id}.png`, size };
      },
    });

    const selected = model.nodes.find((node) => node.path === "Selected");
    expect(selected?.attributes).toMatchObject({
      "data-godot-resource-kind": "AnimatedSprite2D",
      "data-godot-sprite-frames-path": "res://frames.tres",
      "data-godot-sprite-animation": "run",
      "data-godot-sprite-frame": "1",
      "data-godot-sprite-frame-count": "2",
      "data-godot-resource-path": "res://run1.png",
    });
    expect(selected?.style).toMatchObject({
      left: "41px",
      top: "53px",
      width: "24px",
      height: "10px",
    });
    expect(selected?.selfStyle).toMatchObject({
      "background-image": 'url("/run1.png")',
      "background-size": "100% 100%",
      "background-position": "center",
    });
    expect(selected?.selfStyle["background-image"]).not.toContain("run0");
    expect(selected?.selfStyle["background-image"]).not.toContain("idle0");

    const stringNameSelected = model.nodes.find(
      (node) => node.path === "StringNameSelected",
    );
    expect(stringNameSelected?.attributes["data-godot-sprite-animation"]).toBe(
      "idle",
    );
    expect(stringNameSelected?.attributes["data-godot-sprite-frame"]).toBe("0");
    expect(stringNameSelected?.style).toMatchObject({
      left: "10px",
      top: "12px",
      width: "8px",
      height: "6px",
    });
    expect(stringNameSelected?.selfStyle).toMatchObject({
      "background-image": 'url("/idle0.png")',
    });

    const missingAnimation = model.nodes.find(
      (node) => node.path === "MissingAnimation",
    );
    expect(missingAnimation?.attributes["data-godot-sprite-animation"]).toBe(
      "idle",
    );
    expect(missingAnimation?.attributes["data-godot-sprite-frame-count"]).toBe(
      "1",
    );
    expect(missingAnimation?.selfStyle["background-image"]).toBe(
      'url("/idle0.png")',
    );
  });

  it("renders static 2D visual nodes and placeholders", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=4 format=3]
[ext_resource type="Texture2D" path="res://sprite.png" id="tex"]
[sub_resource type="ParticleProcessMaterial" id="pmat"]
scale_min = 0.5
scale_max = 1.5
[sub_resource type="Gradient" id="grad"]
offsets = PackedFloat32Array(0, 1)
colors = PackedColorArray(1, 0, 0, 1, 0, 1, 0, 1)
[node name="Root" type="Node2D"]
[node name="Sprite" type="Sprite2D" parent="."]
position = Vector2(40, 50)
offset = Vector2(2, -3)
texture = ExtResource("tex")
region_enabled = true
region_rect = Rect2(4, 2, 8, 6)
hframes = 2
vframes = 1
frame = 1
texture_repeat = 1
texture_filter = 1
flip_h = true
modulate = Color(1, 1, 1, 0.5)
[node name="Line" type="Line2D" parent="."]
position = Vector2(10, 20)
points = PackedVector2Array(0, 0, 20, 10, 30, -5)
width = 4
default_color = Color(1, 0, 0, 1)
gradient = SubResource("grad")
texture_mode = 2
joint_mode = 1
begin_cap_mode = 2
end_cap_mode = 2
antialiased = true
[node name="Particles" type="GPUParticles2D" parent="."]
position = Vector2(70, 80)
visibility_rect = Rect2(-5, -6, 20, 30)
texture = ExtResource("tex")
process_material = SubResource("pmat")
amount = 6
amount_ratio = 0.5
[node name="Button" type="Button" parent="."]
offset_top = 100
offset_right = 120
offset_bottom = 130
text = "Click"
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => {
        if (ref.type === "SubResource") {
          const resource = scene.subResources.find(
            (candidate) => candidate.id === ref.id,
          );
          return resource
            ? {
                type: resource.type,
                document: {
                  kind: "resource",
                  header: {
                    section: "gd_resource",
                    attributes: { type: resource.type ?? "" },
                  },
                  extResources: [],
                  subResources: [],
                  nodes: [],
                  connections: [],
                  editables: [],
                  properties: resource.properties,
                  diagnostics: [],
                },
              }
            : undefined;
        }
        return {
          path: "res://sprite.png",
          url: "/sprite.png",
          size: { width: 16, height: 10 },
        };
      },
    });
    const sprite = model.nodes.find((node) => node.path === "Sprite");
    expect(sprite?.attributes).toMatchObject({
      "data-godot-resource-kind": "Sprite2D",
      "data-godot-resource-path": "res://sprite.png",
      "data-godot-flip-h": "true",
      "data-godot-modulate": "rgba(255, 255, 255, 0.5)",
      "data-godot-region-enabled": "true",
      "data-godot-region-rect": "4,2,8,6",
      "data-godot-hframes": "2",
      "data-godot-vframes": "1",
      "data-godot-frame": "1",
      "data-godot-source-rect": "8,2,4,6",
      "data-godot-texture-repeat": "1",
      "data-godot-texture-filter": "1",
    });
    expect(sprite?.style).toMatchObject({
      left: "40px",
      top: "44px",
      width: "4px",
      height: "6px",
      opacity: "0.5",
    });
    // flip_h rides on the self-layer (texture only), not the outer element.
    expect(sprite?.style.transform).toBeUndefined();
    expect(sprite?.selfStyle).toMatchObject({
      "background-image": 'url("/sprite.png")',
      "background-position": "-8px -2px",
      "background-repeat": "repeat",
      "image-rendering": "pixelated",
      transform: "scale(-1, 1)",
      "transform-origin": "50% 50%",
    });

    const line = model.nodes.find((node) => node.path === "Line");
    expect(line?.attributes).toMatchObject({
      "data-godot-resource-kind": "Line2D",
      "data-godot-gradient-ref": "SubResource:grad",
      "data-godot-gradient-type": "Gradient",
      "data-godot-texture-mode": "2",
      "data-godot-joint-mode": "1",
      "data-godot-begin-cap-mode": "2",
      "data-godot-end-cap-mode": "2",
      "data-godot-antialiased": "true",
    });
    expect(line?.style).toMatchObject({
      left: "8px",
      top: "13px",
      width: "34px",
      height: "19px",
    });
    expect(line?.html).toContain("data-godot-line2d");
    expect(line?.html).toContain("linearGradient");
    expect(line?.html).toContain('stroke-linecap="round"');
    expect(line?.html).toContain('stroke-linejoin="bevel"');

    const particles = model.nodes.find((node) => node.path === "Particles");
    expect(particles?.attributes).toMatchObject({
      "data-godot-resource-kind": "GPUParticles2D",
      "data-godot-static-preview": "true",
      "data-godot-resource-path": "res://sprite.png",
      "data-godot-process-material-ref": "SubResource:pmat",
      "data-godot-process-material-type": "ParticleProcessMaterial",
      "data-godot-process-material-scale-min": "0.5",
      "data-godot-process-material-scale-max": "1.5",
      "data-godot-particle-amount": "6",
      "data-godot-particle-amount-ratio": "0.5",
      "data-godot-particle-preview-count": "3",
      "data-godot-particle-scale-range": "0.5,1.5",
    });
    expect(particles?.style).toMatchObject({
      left: "65px",
      top: "74px",
      width: "20px",
      height: "30px",
    });
    expect(particles?.html).toContain("data-godot-particle");

    const button = model.nodes.find((node) => node.path === "Button");
    expect(button?.type).toBe("Button");
    expect(button?.text).toBe("Click");
  });

  it("scales Sprite2D around the authored sprite origin", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://sprite.png" id="tex"]
[node name="Root" type="Node2D"]
[node name="Centered" type="Sprite2D" parent="."]
position = Vector2(100, 200)
scale = Vector2(2, 3)
offset = Vector2(4, -2)
texture = ExtResource("tex")
[node name="UncenteredFlipped" type="Sprite2D" parent="."]
position = Vector2(50, 60)
scale = Vector2(-1, 2)
centered = false
offset = Vector2(5, 7)
texture = ExtResource("tex")
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: () => ({
        path: "res://sprite.png",
        url: "/sprite.png",
        size: { width: 20, height: 10 },
      }),
    });

    const centered = model.nodes.find((node) => node.path === "Centered");
    expect(centered?.style).toMatchObject({
      left: "94px",
      top: "193px",
      width: "20px",
      height: "10px",
      transform: "scale(2, 3)",
      "transform-origin": "6px 7px",
    });
    expect(centered?.selfStyle["background-image"]).toBe('url("/sprite.png")');

    const uncentered = model.nodes.find(
      (node) => node.path === "UncenteredFlipped",
    );
    expect(uncentered?.style).toMatchObject({
      left: "55px",
      top: "67px",
      width: "20px",
      height: "10px",
      transform: "scale(-1, 2)",
      "transform-origin": "-5px -7px",
    });
    expect(uncentered?.selfStyle["background-image"]).toBe(
      'url("/sprite.png")',
    );
  });

  it("sizes textured particle previews from the texture and overlays material tint", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=5 format=3]
[ext_resource type="Texture2D" path="res://particle.png" id="tex"]
[sub_resource type="Gradient" id="grad"]
offsets = PackedFloat32Array(0, 1)
colors = PackedColorArray(1, 0, 0, 1, 0, 0, 1, 1)
[sub_resource type="GradientTexture1D" id="ramp"]
gradient = SubResource("grad")
[sub_resource type="ParticleProcessMaterial" id="pmat"]
scale_min = 0.5
scale_max = 0.5
color = Color(0.25, 0.5, 0.75, 0.4)
color_ramp = SubResource("ramp")
[node name="Root" type="Node2D"]
[node name="Textured" type="GPUParticles2D" parent="."]
visibility_rect = Rect2(-100, -100, 200, 200)
texture = ExtResource("tex")
process_material = SubResource("pmat")
amount = 1
use_fixed_seed = true
seed = 7
[node name="Dots" type="GPUParticles2D" parent="."]
visibility_rect = Rect2(-20, -20, 40, 40)
process_material = SubResource("pmat")
amount = 1
use_fixed_seed = true
seed = 7
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => {
        if (ref.type === "SubResource") {
          const resource = scene.subResources.find(
            (candidate) => candidate.id === ref.id,
          );
          return resource
            ? {
                type: resource.type,
                document: {
                  kind: "resource" as const,
                  header: {
                    section: "gd_resource",
                    attributes: { type: resource.type ?? "" },
                  },
                  extResources: scene.extResources,
                  subResources: scene.subResources,
                  nodes: [],
                  connections: [],
                  editables: [],
                  properties: resource.properties,
                  diagnostics: [],
                },
              }
            : undefined;
        }
        return {
          path: "res://particle.png",
          url: "/particle.png",
          size: { width: 64, height: 32 },
        };
      },
    });

    const textured = model.nodes.find((node) => node.path === "Textured");
    expect(textured?.attributes).toMatchObject({
      "data-godot-process-material-color": "rgba(64, 128, 191, 0.4)",
      "data-godot-particle-color-ramp-stops":
        "0:rgba(255, 0, 0, 1)|1:rgba(0, 0, 255, 1)",
      "data-godot-particle-scale-range": "0.5,0.5",
      "data-godot-particle-texture-tint": "multiply",
    });
    expect(textured?.html).toContain("width:32px;height:16px");
    expect(textured?.html).toContain(
      "background-image:url(&quot;/particle.png&quot;)",
    );
    // A textured particle folds its color_ramp into the tint (Godot draws texture × ramp(life) ×
    // modulate), so the preview shows the sampled ramp color (red→blue at u≈0.14) × the texture
    // tint, not the flat modulate alone.
    expect(textured?.html).toContain(
      "opacity:0.3;background-color:rgba(11, 0, 3, 1)",
    );
    expect(textured?.html).toContain("background-color:rgba(11, 0, 3, 1)");
    expect(textured?.html).toContain("background-blend-mode:multiply");
    expect(textured?.html).toContain(
      "mask-image:url(&quot;/particle.png&quot;)",
    );
    expect(textured?.html).toContain(
      "-webkit-mask-image:url(&quot;/particle.png&quot;)",
    );
    expect(textured?.html).toContain('data-godot-particle-tint="multiply"');
    expect(textured?.html).toContain(
      "background-color:transparent;opacity:1;pointer-events:none",
    );
    expect(textured?.html).toContain("opacity:1;pointer-events:none");
    expect(textured?.html).not.toContain("background-color:rgba(255, 0, 0, 1)");
    expect(textured?.style.overflow).toBe("visible");

    const dots = model.nodes.find((node) => node.path === "Dots");
    expect(
      dots?.attributes["data-godot-particle-texture-tint"],
    ).toBeUndefined();
    expect(dots?.html).toContain("width:3px;height:3px");
    expect(dots?.html).toContain("border-radius:999px");
    expect(dots?.html).toContain("background-color:rgba(");
    expect(dots?.html).not.toContain(
      "opacity:0.4;background-color:transparent",
    );
    expect(dots?.html).not.toContain("data-godot-particle-tint");
    expect(dots?.style.overflow).toBe("hidden");
  });

  it("renders deterministic shape-aware particle previews and metadata", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=7 format=3]
[sub_resource type="Gradient" id="grad"]
offsets = PackedFloat32Array(0, 1)
colors = PackedColorArray(1, 0, 0, 1, 0, 0, 1, 0.5)
[sub_resource type="GradientTexture1D" id="ramp"]
gradient = SubResource("grad")
[sub_resource type="ParticleProcessMaterial" id="box"]
emission_shape = 3
emission_shape_offset = Vector3(4, -2, 0)
emission_shape_scale = Vector3(2, 1, 1)
emission_box_extents = Vector3(20, 10, 0)
scale_min = 0.25
scale_max = 2
color = Color(0.2, 0.4, 0.6, 0.8)
color_ramp = SubResource("ramp")
initial_velocity_min = 3
initial_velocity_max = 9
gravity = Vector3(0, 98, 0)
particle_flag_disable_z = true
spread = 22
[sub_resource type="ParticleProcessMaterial" id="sphere"]
emission_shape = 2
emission_sphere_radius = 12
[sub_resource type="ParticleProcessMaterial" id="ring"]
emission_shape = 6
emission_ring_radius = 18
emission_ring_inner_radius = 6
emission_ring_height = 10
[node name="Root" type="Node2D"]
[node name="Point" type="GPUParticles2D" parent="."]
position = Vector2(20, 20)
visibility_rect = Rect2(-20, -20, 40, 40)
amount = 4
use_fixed_seed = true
seed = 42
emitting = false
one_shot = true
lifetime = 2
preprocess = 0.5
speed_scale = 1.25
explosiveness = 0.75
randomness = 0.1
fixed_fps = 20
local_coords = true
fract_delta = false
trail_enabled = true
trail_lifetime = 0.4
trail_sections = 3
trail_section_subdivisions = 2
[node name="Box" type="GPUParticles2D" parent="."]
position = Vector2(100, 100)
amount = 200
amount_ratio = 0.75
process_material = SubResource("box")
use_fixed_seed = true
seed = 99
[node name="Sphere" type="GPUParticles2D" parent="."]
position = Vector2(200, 100)
amount = 8
process_material = SubResource("sphere")
[node name="Ring" type="GPUParticles2D" parent="."]
position = Vector2(300, 100)
amount = 8
process_material = SubResource("ring")
[node name="Cpu" type="CPUParticles2D" parent="."]
position = Vector2(400, 100)
amount = 5
emission_shape = 3
emission_rect_extents = Vector2(12, 6)
scale_amount_min = 0.5
scale_amount_max = 1.5
color_ramp = SubResource("grad")
`);
    const resolveResource = (ref: {
      type: "ExtResource" | "SubResource";
      id: string;
    }) => {
      const resource = scene.subResources.find(
        (candidate) => candidate.id === ref.id,
      );
      return resource
        ? {
            type: resource.type,
            document: {
              kind: "resource" as const,
              header: {
                section: "gd_resource",
                attributes: { type: resource.type ?? "" },
              },
              extResources: scene.extResources,
              subResources: [],
              nodes: [],
              connections: [],
              editables: [],
              properties: resource.properties,
              diagnostics: [],
            },
          }
        : undefined;
    };
    const first = renderSceneToHtmlModel(scene, { resolveResource });
    const second = renderSceneToHtmlModel(scene, { resolveResource });

    const point = first.nodes.find((node) => node.path === "Point");
    expect(point?.attributes).toMatchObject({
      "data-godot-particle-emitting": "false",
      "data-godot-particle-one-shot": "true",
      "data-godot-particle-lifetime": "2",
      "data-godot-particle-preprocess": "0.5",
      "data-godot-particle-speed-scale": "1.25",
      "data-godot-particle-explosiveness": "0.75",
      "data-godot-particle-randomness": "0.1",
      "data-godot-particle-fixed-fps": "20",
      "data-godot-particle-local-coords": "true",
      "data-godot-particle-fract-delta": "false",
      "data-godot-particle-trail-enabled": "true",
      "data-godot-particle-trail-lifetime": "0.4",
      "data-godot-particle-trail-sections": "3",
      "data-godot-particle-trail-section-subdivisions": "2",
      "data-godot-particle-preview-seed": "42",
      "data-godot-particle-preview-seed-source": "fixed",
      "data-godot-particle-emission-shape-name": "point",
    });
    expect(point?.html?.match(/left:17px;top:17px/g)).toHaveLength(4);

    const box = first.nodes.find((node) => node.path === "Box");
    expect(box?.attributes).toMatchObject({
      "data-godot-particle-preview-count": "64",
      "data-godot-process-material-emission-shape": "3",
      "data-godot-process-material-emission-shape-offset": "4,-2",
      "data-godot-process-material-emission-shape-scale": "2,1",
      "data-godot-process-material-emission-box-extents": "20,10",
      "data-godot-process-material-color": "rgba(51, 102, 153, 0.8)",
      "data-godot-process-material-initial-velocity-min": "3",
      "data-godot-process-material-initial-velocity-max": "9",
      "data-godot-process-material-gravity": "0,98",
      "data-godot-process-material-particle-flag-disable-z": "true",
      "data-godot-process-material-spread": "22",
      "data-godot-particle-emission-shape-bounds": "-36,-12,80,20",
      "data-godot-particle-color-ramp-stops":
        "0:rgba(255, 0, 0, 1)|1:rgba(0, 0, 255, 0.5)",
      "data-godot-particle-scale-range": "0.25,2",
    });
    expect(box?.html).toBe(
      second.nodes.find((node) => node.path === "Box")?.html,
    );
    expect(box?.html?.match(/data-godot-particle/g)).toHaveLength(64);
    expect(box?.html).toContain("background-color:rgba(");

    expect(
      first.nodes.find((node) => node.path === "Sphere")?.attributes,
    ).toMatchObject({
      "data-godot-particle-emission-shape-name": "sphere-surface",
      "data-godot-particle-emission-shape-bounds": "-12,-12,24,24",
    });
    expect(
      first.nodes.find((node) => node.path === "Ring")?.attributes,
    ).toMatchObject({
      "data-godot-particle-emission-shape-name": "ring",
      "data-godot-particle-emission-shape-bounds": "-18,-23,36,46",
    });
    const cpu = first.nodes.find((node) => node.path === "Cpu");
    expect(cpu?.attributes).toMatchObject({
      "data-godot-resource-kind": "CPUParticles2D",
      "data-godot-particle-emission-shape-name": "box",
      "data-godot-particle-emission-shape-bounds": "-12,-6,24,12",
      "data-godot-particle-emission-rect-extents": "12,6",
      "data-godot-particle-scale-range": "0.5,1.5",
      "data-godot-particle-color-ramp-stops":
        "0:rgba(255, 0, 0, 1)|1:rgba(0, 0, 255, 0.5)",
    });
    expect(cpu?.style).toMatchObject({
      left: "380px",
      top: "86px",
      width: "40px",
      height: "28px",
    });
  });

  it("preserves material and shader metadata as stable data attributes", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=4 format=3]
[ext_resource type="Shader" path="res://hsv.gdshader" id="shader"]
[sub_resource type="ShaderMaterial" id="shader_mat"]
shader = ExtResource("shader")
shader_parameter/h = 0.5
shader_parameter/s = 1.25
[sub_resource type="CanvasItemMaterial" id="blend_mat"]
blend_mode = 1
[sub_resource type="CanvasItemMaterial" id="mix_mat"]
blend_mode = 0
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Tinted" type="ColorRect" parent="."]
offset_right = 20
offset_bottom = 20
material = SubResource("shader_mat")
[node name="Additive" type="ColorRect" parent="."]
offset_top = 30
offset_right = 20
offset_bottom = 50
material = SubResource("blend_mat")
[node name="Mixed" type="ColorRect" parent="."]
offset_top = 60
offset_right = 20
offset_bottom = 80
material = SubResource("mix_mat")
`);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref) => {
        if (ref.type === "SubResource") {
          const resource = scene.subResources.find(
            (candidate) => candidate.id === ref.id,
          );
          return resource
            ? {
                type: resource.type,
                document: {
                  kind: "resource",
                  header: {
                    section: "gd_resource",
                    attributes: { type: resource.type ?? "" },
                  },
                  extResources: scene.extResources,
                  subResources: [],
                  nodes: [],
                  connections: [],
                  editables: [],
                  properties: resource.properties,
                  diagnostics: [],
                },
              }
            : undefined;
        }
        return scene.extResources.find((resource) => resource.id === ref.id);
      },
    });
    const tinted = model.nodes.find((node) => node.path === "Tinted");
    const additive = model.nodes.find((node) => node.path === "Additive");
    const mixed = model.nodes.find((node) => node.path === "Mixed");

    expect(tinted?.attributes).toMatchObject({
      "data-godot-material-type": "ShaderMaterial",
      "data-godot-shader-ref": "ExtResource:shader",
      "data-godot-shader-path": "res://hsv.gdshader",
      "data-godot-shader-param-h": "0.5",
      "data-godot-shader-param-s": "1.25",
    });
    expect(additive?.attributes).toMatchObject({
      "data-godot-material-type": "CanvasItemMaterial",
      "data-godot-material-blend-mode": "1",
      "data-godot-material-blend-mode-name": "add",
    });
    // BLEND_MODE_ADD composites additively (on the outer element, so its own
    // transform/z-index cannot isolate the blend from the node's backdrop).
    expect(additive?.style["mix-blend-mode"]).toBe("plus-lighter");
    expect(mixed?.attributes).toMatchObject({
      "data-godot-material-type": "CanvasItemMaterial",
      "data-godot-material-blend-mode": "0",
      "data-godot-material-blend-mode-name": "mix",
    });
    expect(mixed?.style["mix-blend-mode"]).toBeUndefined();
    expect(tinted?.style["mix-blend-mode"]).toBeUndefined();
  });

  it("renders official RichTextLabel BBCode alignment, colors, nested styles, and effects", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 240
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 240
offset_bottom = 100
bbcode_enabled = true
text = "[center][color=#f6c453][b]Title[/b][/color]\\n[i]Body[/i] [wave]wavy[/wave][/center]"
`);
    const text = renderSceneToHtmlModel(scene).nodes.find(
      (node) => node.path === "Text",
    );
    expect(text?.html).toContain('data-godot-bbcode-align="center"');
    expect(text?.html).toContain('data-godot-bbcode-color="#f6c453"');
    expect(text?.html).toContain("color: #f6c453");
    expect(text?.html).toContain(
      '<strong class="godot-rich-bold">Title</strong>',
    );
    expect(text?.html).toContain('<em class="godot-rich-italic">Body</em>');
    expect(text?.html).toContain('data-godot-bbcode-effect="wave"');
    expect(text?.html).toContain("godot-rich-effect-wave");
  });

  it("groups a [center] region with inline tags into one alignment block per layer", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 240
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 240
offset_bottom = 100
bbcode_enabled = true
text = "[center]Obtienes 5 de [color=#efc851]bloqueo[/color].[/center]"
`);
    const text = renderSceneToHtmlModel(scene).nodes.find(
      (node) => node.path === "Text",
    );
    // A contiguous alignment region is ONE block (per shadow/outline layer): the
    // inline color run and the trailing period stay inside it so they wrap as a
    // unit, instead of each run becoming its own `display: block` line.
    const layerCount = (text?.html?.match(/data-godot-rich-layer="/g) ?? [])
      .length;
    const alignCount = (text?.html?.match(/class="godot-rich-align"/g) ?? [])
      .length;
    expect(layerCount).toBeGreaterThan(0);
    expect(alignCount).toBe(layerCount);
    expect(text?.html).toContain('data-godot-bbcode-align="center"');
    expect(text?.html).not.toContain("display: block; text-align");
  });

  it("splits a hard newline inside a [center] region into separate paragraph blocks", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 240
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 240
offset_bottom = 100
bbcode_enabled = true
text = "[center]Deal 6 damage.\\nDeals 3 additional damage for each card in your [color=#efc851]Exhaust Pile[/color].[/center]"
`);
    const text = renderSceneToHtmlModel(scene).nodes.find(
      (node) => node.path === "Text",
    );
    const layerCount = (text?.html?.match(/data-godot-rich-layer="/g) ?? [])
      .length;
    const alignCount = (text?.html?.match(/class="godot-rich-align"/g) ?? [])
      .length;
    const blockCount = (
      text?.html?.match(/class="godot-rich-paragraph"/g) ?? []
    ).length;
    // Still ONE aligned `<p>` per layer, but the explicit `\n` yields TWO
    // paragraph blocks per layer (pre-newline + post-newline runs).
    expect(layerCount).toBeGreaterThan(0);
    expect(alignCount).toBe(layerCount);
    expect(blockCount).toBe(layerCount * 2);
    // The `\n` itself is consumed (block boundary), never left as literal text.
    expect(text?.html).not.toContain("Deal 6 damage.\nDeals");
    // Inline color run survives inside the second block.
    expect(text?.html).toContain('data-godot-bbcode-color="#efc851"');
    // The blocks read the tunable spacing custom properties (defaults keep the
    // plain flow), exposed via CSS rather than inline styles.
    expect(text?.html).not.toContain("display: block");
  });

  it("wraps a single-segment [center] region in one paragraph block and keeps inline images", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 240
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 240
offset_bottom = 100
bbcode_enabled = true
text = "[center]Lose 3 HP.\\nGain [img]res://icon.png[/img][img]res://icon.png[/img].[/center]"
`);
    const text = renderSceneToHtmlModel(scene, {
      resolveResourcePath: (path) => ({ path, url: "/res/icon.png" }),
    }).nodes.find((node) => node.path === "Text");
    const layerCount = (text?.html?.match(/data-godot-rich-layer="/g) ?? [])
      .length;
    const blockCount = (
      text?.html?.match(/class="godot-rich-paragraph"/g) ?? []
    ).length;
    // Two segments (Lose 3 HP. / Gain <orbs>.) → two blocks per layer.
    expect(blockCount).toBe(layerCount * 2);
    // Both energy orbs render as inline <img> inside the second block.
    const imgCount = (text?.html?.match(/<img class="godot-rich-img"/g) ?? [])
      .length;
    expect(imgCount).toBe(layerCount * 2);
    expect(text?.html).toContain('src="/res/icon.png"');
  });

  it("emits no alignment block when the text has no alignment tag", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 240
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 240
offset_bottom = 100
bbcode_enabled = true
text = "Obtienes 5 de [color=#efc851]bloqueo[/color]."
`);
    const text = renderSceneToHtmlModel(scene).nodes.find(
      (node) => node.path === "Text",
    );
    expect(text?.html).not.toContain("godot-rich-align");
    expect(text?.html).toContain('data-godot-bbcode-color="#efc851"');
  });

  it("ignores non-official BBCode tags unless supplied via bbcodeTags", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 240
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 240
offset_bottom = 100
bbcode_enabled = true
text = "[red]nope[/red]"
`);
    const text = renderSceneToHtmlModel(scene).nodes.find(
      (node) => node.path === "Text",
    );
    // Unknown tags fall through as literal text, not as a color span.
    expect(text?.html).not.toContain("data-godot-bbcode-color");
    expect(text?.html).toContain("[red]nope[/red]");
  });

  it("renders externally-fed custom color and per-character effect tags", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 240
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 240
offset_bottom = 100
bbcode_enabled = true
text = "[red]Hi[/red] [thinky_dots]ok[/thinky_dots]"
`);
    const text = renderSceneToHtmlModel(scene, {
      bbcodeTags: {
        red: { kind: "color", value: "var(--sts-color-red)" },
        thinky_dots: {
          kind: "effect",
          perChar: true,
          className: "sts-text-thinky_dots",
        },
      },
    }).nodes.find((node) => node.path === "Text");
    expect(text?.html).toContain(
      'data-godot-bbcode-color="var(--sts-color-red)"',
    );
    expect(text?.html).toContain("color: var(--sts-color-red)");
    expect(text?.html).toContain('data-godot-bbcode-effect="thinky_dots"');
    expect(text?.html).toContain("godot-rich-effect-thinky_dots");
    expect(text?.html).toContain("sts-text-thinky_dots");
    // Per-character effects split text into word/char spans with a stagger index.
    expect(text?.html).toContain('<span class="godot-rich-word">');
    expect(text?.html).toContain(
      '<span class="godot-rich-char" style="--i: 0">',
    );
    expect(text?.html).toContain('style="--i: 1"');
  });

  it("closes [font_size] without leaking the style to the end of the string", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 240
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 240
offset_bottom = 100
bbcode_enabled = true
text = "[font_size=22]Big[/font_size]Small"
`);
    const text = renderSceneToHtmlModel(scene).nodes.find(
      (node) => node.path === "Text",
    );
    expect(text?.html).toContain('data-godot-bbcode-font-size="22"');
    // The closing tag must not render literally, and Small must be unstyled.
    expect(text?.html).not.toContain("[/font_size]");
    expect(text?.html).toContain(
      '<span class="godot-rich-normal">Small</span>',
    );
  });

  const imgScene = (text: string) =>
    parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 240
offset_bottom = 100
[node name="Text" type="RichTextLabel" parent="."]
offset_right = 240
offset_bottom = 100
bbcode_enabled = true
text = "${text}"
`);

  it("renders a resolved [img] as an <img> and consumes the path", () => {
    const scene = imgScene("before [img]res://icon.png[/img] after");
    const text = renderSceneToHtmlModel(scene, {
      resolveResourcePath: (path) => ({ path, url: "/icon.png" }),
    }).nodes.find((node) => node.path === "Text");
    expect(text?.html).toContain('<img class="godot-rich-img"');
    expect(text?.html).toContain('src="/icon.png"');
    expect(text?.html).toContain('data-godot-bbcode-img="res://icon.png"');
    expect(text?.html).toContain('data-godot-resource-path="res://icon.png"');
    // The path content and closing tag must not leak as literal text.
    expect(text?.html).not.toContain("res://icon.png</");
    expect(text?.html).not.toContain("[/img]");
    expect(text?.html).not.toContain("[img]");
  });

  it("applies [img] width/height from the value and named options", () => {
    const resolveResourcePath = () => ({ url: "/icon.png" });
    const single = renderSceneToHtmlModel(
      imgScene("[img=40]res://icon.png[/img]"),
      {
        resolveResourcePath,
      },
    ).nodes.find((node) => node.path === "Text");
    expect(single?.html).toContain("width:40px");
    expect(single?.html).toContain('data-godot-bbcode-img-width="40"');

    const both = renderSceneToHtmlModel(
      imgScene("[img=40x30]res://icon.png[/img]"),
      {
        resolveResourcePath,
      },
    ).nodes.find((node) => node.path === "Text");
    expect(both?.html).toContain("width:40px");
    expect(both?.html).toContain("height:30px");

    const named = renderSceneToHtmlModel(
      imgScene("[img width=40 height=40]res://icon.png[/img]"),
      { resolveResourcePath },
    ).nodes.find((node) => node.path === "Text");
    expect(named?.html).toContain("width:40px");
    expect(named?.html).toContain("height:40px");
  });

  it("maps [img=top] to vertical-align and defaults to middle", () => {
    const resolveResourcePath = () => ({ url: "/icon.png" });
    const top = renderSceneToHtmlModel(
      imgScene("[img=top]res://icon.png[/img]"),
      {
        resolveResourcePath,
      },
    ).nodes.find((node) => node.path === "Text");
    expect(top?.html).toContain("vertical-align:top");
    expect(top?.html).toContain('data-godot-bbcode-img-valign="top"');

    const def = renderSceneToHtmlModel(imgScene("[img]res://icon.png[/img]"), {
      resolveResourcePath,
    }).nodes.find((node) => node.path === "Text");
    expect(def?.html).toContain("vertical-align:middle");
  });

  it("nudges the default-centered [img] up to Godot's line-box center, but not [img=top]/[img=bottom]", () => {
    // Godot's [img] default is InlineAlignment.Center (image center on the text
    // line-box midpoint), which sits higher than CSS `vertical-align: middle`
    // (x-height midpoint). The default case gets a layout-neutral relative nudge
    // up by the font-metric delta; explicit top/bottom keep their own alignment.
    const resolveResourcePath = () => ({ url: "/icon.png" });
    const def = renderSceneToHtmlModel(imgScene("[img]res://icon.png[/img]"), {
      resolveResourcePath,
    }).nodes.find((node) => node.path === "Text");
    expect(def?.html).toContain("position:relative");
    expect(def?.html).toContain("top:-0.094em");

    for (const valign of ["top", "bottom"]) {
      const explicit = renderSceneToHtmlModel(
        imgScene(`[img=${valign}]res://icon.png[/img]`),
        { resolveResourcePath },
      ).nodes.find((node) => node.path === "Text");
      expect(explicit?.html).toContain(`vertical-align:${valign}`);
      expect(explicit?.html).not.toContain("top:-0.094em");
    }
  });

  it("applies the center nudge to an [img region=...] crop too", () => {
    const text = renderSceneToHtmlModel(
      imgScene("[img region=0,0,16,16]res://atlas.png[/img]"),
      {
        resolveResourcePath: () => ({
          url: "/atlas.png",
          size: { width: 64, height: 64 },
        }),
      },
    ).nodes.find((node) => node.path === "Text");
    expect(text?.html).toContain('<span class="godot-rich-img"');
    expect(text?.html).toContain("position:relative");
    expect(text?.html).toContain("top:-0.094em");
  });

  it("renders an [img region=...] crop as a positioned background span", () => {
    const scene = imgScene("[img region=0,0,16,16]res://atlas.png[/img]");
    const text = renderSceneToHtmlModel(scene, {
      resolveResourcePath: () => ({
        url: "/atlas.png",
        size: { width: 64, height: 64 },
      }),
    }).nodes.find((node) => node.path === "Text");
    expect(text?.html).toContain('<span class="godot-rich-img"');
    expect(text?.html).toContain('data-godot-bbcode-img-region="0,0,16,16"');
    expect(text?.html).toContain("background-image");
    expect(text?.html).toContain("background-size:64px 64px");
  });

  it("keeps [img] content out of the text when no resolver is supplied", () => {
    const scene = imgScene("[img]res://icon.png[/img]done");
    const text = renderSceneToHtmlModel(scene).nodes.find(
      (node) => node.path === "Text",
    );
    // A placeholder carries the path; nothing leaks as literal text.
    expect(text?.html).toContain('<span class="godot-rich-img"');
    expect(text?.html).toContain('data-godot-bbcode-img="res://icon.png"');
    expect(text?.html).not.toContain("[img]");
    expect(text?.html).not.toContain("[/img]");
    expect(text?.html).not.toContain("res://icon.png</");
    expect(text?.html).toContain("done");
  });
});

describe("hidden node pruning", () => {
  const HIDDEN_SCENE = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Before" type="ColorRect" parent="."]
offset_right = 10
offset_bottom = 10
[node name="Hidden" type="Control" parent="."]
visible = false
offset_right = 50
offset_bottom = 50
[node name="Inner" type="ColorRect" parent="Hidden"]
offset_right = 20
offset_bottom = 20
[node name="After" type="ColorRect" parent="."]
offset_top = 60
offset_right = 70
offset_bottom = 70
`;

  it("prunes an effectively hidden subtree to one placeholder node", () => {
    const model = renderSceneToHtmlModel(parseGodotTextScene(HIDDEN_SCENE));
    const byPath = new Map(model.nodes.map((node) => [node.path, node]));
    // Topmost hidden node stays as a placeholder in its sibling slot...
    const hidden = byPath.get("Hidden");
    expect(hidden?.kind).toBe("hidden-placeholder");
    expect(hidden?.style).toEqual({});
    expect(hidden?.children).toEqual([]);
    // ...its visible=true descendant is dropped entirely (effective visibility)...
    expect(byPath.has("Hidden/Inner")).toBe(false);
    // ...and sibling order is preserved.
    expect(byPath.get(".")?.children).toEqual(["Before", "Hidden", "After"]);
    // The attribute is gone everywhere: visibility is expressed by pruning.
    for (const node of model.nodes) {
      expect(node.attributes["data-godot-visible"]).toBeUndefined();
    }
  });

  it("renders the placeholder as a comment between its siblings (HTML string)", () => {
    const model = renderSceneToHtmlModel(parseGodotTextScene(HIDDEN_SCENE));
    const html = renderGodotSceneHtml(model, { viewport: model.viewport });
    expect(html).toContain("<!--godot:hidden Hidden (Control)-->");
    expect(html).not.toContain('data-godot-path="Hidden"');
    expect(html).not.toContain('data-godot-path="Hidden/Inner"');
    expect(html).not.toContain("data-godot-visible");
    // The comment sits in the hidden node's sibling slot.
    const before = html.indexOf('data-godot-path="Before"');
    const comment = html.indexOf("<!--godot:hidden Hidden (Control)-->");
    const after = html.indexOf('data-godot-path="After"');
    expect(before).toBeGreaterThan(-1);
    expect(comment).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(comment);
  });

  it("mounts the placeholder as a DOM comment node", () => {
    const model = renderSceneToHtmlModel(parseGodotTextScene(HIDDEN_SCENE));
    const host = document.createElement("div");
    mountHtmlScene(host, model);
    expect(host.querySelector('[data-godot-path="Hidden"]')).toBeNull();
    expect(host.querySelector('[data-godot-path="Hidden/Inner"]')).toBeNull();
    const root = host.querySelector('[data-godot-path="."]');
    const slots = [...(root?.childNodes ?? [])].map((node) =>
      node.nodeType === Node.COMMENT_NODE
        ? `comment:${node.textContent}`
        : ((node as HTMLElement).dataset?.godotPath ?? "self"),
    );
    expect(slots).toEqual([
      "self",
      "Before",
      "comment:godot:hidden Hidden (Control)",
      "After",
    ]);
  });

  it("escapes '--' in comment payloads so a node name cannot break the comment", () => {
    const model = renderSceneToHtmlModel(
      parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Bad--Name" type="ColorRect" parent="."]
visible = false
offset_right = 10
offset_bottom = 10
`),
    );
    const html = renderGodotSceneHtml(model, { viewport: model.viewport });
    expect(html).toContain("<!--godot:hidden Bad- -Name (ColorRect)-->");
    expect(html).not.toContain("Bad--Name");
  });
});
