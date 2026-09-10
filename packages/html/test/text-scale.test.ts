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

import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import {
  type GodotHtmlModel,
  type GodotHtmlRenderOptions,
  renderSceneToHtmlModel as renderTreeToHtmlModel,
  resolveTextScale,
  textScaleLength,
} from "../src/index";

function render(
  scene: GodotSceneState | GodotSceneTree,
  options: GodotLayoutOptions & GodotHtmlRenderOptions = {},
): GodotHtmlModel {
  const tree = isGodotSceneTree(scene)
    ? scene
    : resolveGodotSceneTree(scene, options);
  return renderTreeToHtmlModel(tree, options);
}

function node(model: GodotHtmlModel, path: string) {
  const found = model.nodes.find((candidate) => candidate.path === path);
  if (!found) {
    throw new Error(`node not found: ${path}`);
  }
  return found;
}

// A Label carrying a font size plus the font-derived decorations (outline +
// shadow + line separation) so every scaled property is exercised.
const DECORATED_LABEL = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Child" type="Label" parent="."]
offset_left = 10
offset_right = 110
offset_bottom = 40
theme_override_font_sizes/font_size = 24
theme_override_constants/line_separation = 5
theme_override_constants/outline_size = 4
theme_override_colors/font_outline_color = Color( 0, 0, 0, 1 )
theme_override_colors/font_shadow_color = Color( 0, 0, 0, 1 )
theme_override_constants/shadow_offset_x = 2
theme_override_constants/shadow_offset_y = 3
text = "Hi"
`;

describe("resolveTextScale / textScaleLength", () => {
  it("resolves the enable forms and the exempt flag", () => {
    expect(resolveTextScale(undefined)).toBeNull();
    expect(resolveTextScale(false)).toBeNull();
    expect(resolveTextScale(true)).toEqual({ exemptAutoFit: false });
    expect(resolveTextScale({})).toEqual({ exemptAutoFit: false });
    expect(resolveTextScale({ exemptAutoFit: true })).toEqual({
      exemptAutoFit: true,
    });
  });

  it("wraps a px length only when enabled", () => {
    expect(textScaleLength(24, true)).toBe(
      "calc(24px * var(--godot-text-scale, 1))",
    );
    expect(textScaleLength(24, false)).toBe("24px");
  });
});

describe("renderSceneToHtmlModel text scale", () => {
  it("leaves text as plain px by default", () => {
    const child = node(render(parseGodotTextScene(DECORATED_LABEL)), "Child");
    expect(child.selfStyle["font-size"]).toBe("24px");
    expect(child.attributes["data-godot-text-scale"]).toBeUndefined();
  });

  it("scales font size, line height, and decorations when enabled", () => {
    const child = node(
      render(parseGodotTextScene(DECORATED_LABEL), { textScale: true }),
      "Child",
    );
    const wrap = (px: number) => `calc(${px}px * var(--godot-text-scale, 1))`;
    expect(child.selfStyle["font-size"]).toBe(wrap(24));
    expect(child.selfStyle["line-height"]).toBe(wrap(29));
    // outline_size 4 renders at 0.5x for a non-MSDF font.
    expect(child.selfStyle["-webkit-text-stroke"]).toBe(
      `${wrap(2)} rgba(0, 0, 0, 1)`,
    );
    expect(child.selfStyle["text-shadow"]).toBe(
      `${wrap(2)} ${wrap(3)} 0 rgba(0, 0, 0, 1)`,
    );
    expect(child.attributes["data-godot-text-scale"]).toBe("true");
  });

  it("scales rich-text font-size vars and [font_size] bbcode runs", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Rich" type="RichTextLabel" parent="."]
offset_right = 200
offset_bottom = 60
bbcode_enabled = true
theme_override_font_sizes/normal_font_size = 20
text = "[font_size=30]Big[/font_size]"
`);
    const rich = node(render(scene, { textScale: true }), "Rich");
    // normal_font_size 20 renders at 0.8x => 16.
    expect(rich.selfStyle["--godot-rich-normal-font-size"]).toBe(
      "calc(16px * var(--godot-text-scale, 1))",
    );
    expect(rich.html).toContain("calc(30px * var(--godot-text-scale, 1))");
  });

  it("exempts auto-fit text but still scales its siblings", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Auto" type="Label" parent="."]
offset_right = 100
offset_bottom = 40
theme_override_font_sizes/font_size = 24
text = "Fit"
[node name="Plain" type="Label" parent="."]
offset_top = 40
offset_right = 100
offset_bottom = 80
theme_override_font_sizes/font_size = 24
text = "Plain"
`);
    const model = render(scene, {
      textScale: { exemptAutoFit: true },
      textAutoFitByPath: {
        Auto: {
          minFontSizePx: 8,
          maxFontSizePx: 40,
          fitWidth: true,
          fitHeight: false,
        },
      },
    });
    const auto = node(model, "Auto");
    const plain = node(model, "Plain");
    expect(auto.selfStyle["font-size"]).toBe("24px");
    expect(auto.attributes["data-godot-text-scale"]).toBeUndefined();
    expect(plain.selfStyle["font-size"]).toBe(
      "calc(24px * var(--godot-text-scale, 1))",
    );
    expect(plain.attributes["data-godot-text-scale"]).toBe("true");
  });

  it("composes with the content-scale container rewrite", () => {
    const child = node(
      render(parseGodotTextScene(DECORATED_LABEL), {
        viewport: { width: 1000, height: 500 },
        contentScale: { aspect: "keep" },
        textScale: true,
      }),
      "Child",
    );
    expect(child.selfStyle["font-size"]).toBe(
      "calc(min(2.4cqw, 4.8cqh) * var(--godot-text-scale, 1))",
    );
  });
});
