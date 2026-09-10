import type { GodotSceneState } from "@godot-scene-web/core";
import {
  type GodotLayoutOptions,
  type GodotSceneTree,
  isGodotSceneTree,
  resolveGodotSceneTree as resolveSceneTreeFromGraph,
} from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import {
  type GodotHtmlModel,
  type GodotHtmlRenderOptions,
  renderSceneToHtmlModel as renderTreeToHtmlModel,
} from "../src/index";

function render(
  scene: GodotSceneState | GodotSceneTree,
  options: GodotLayoutOptions & GodotHtmlRenderOptions = {},
): GodotHtmlModel {
  const tree = isGodotSceneTree(scene)
    ? scene
    : resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
  return renderTreeToHtmlModel(tree, options);
}

function node(model: GodotHtmlModel, path: string) {
  const found = model.nodes.find((candidate) => candidate.path === path);
  if (!found) throw new Error(`node not found: ${path}`);
  return found;
}

// A RichTextLabel whose size is NOT inline — it must come from the node's theme via
// resolveTheme. Mirrors the combat SelectionHeader ("Elige una carta para descartar").
const RICH_NO_INLINE = `
[gd_scene load_steps=2 format=3]
[ext_resource type="Theme" path="res://themes/t.tres" id="1"]
[node name="Root" type="Control"]
offset_right = 400
offset_bottom = 200
[node name="Label" type="RichTextLabel" parent="."]
offset_right = 400
offset_bottom = 60
theme = ExtResource("1")
bbcode_enabled = true
text = "Hola"
`;

const PLAIN_LABEL = `
[gd_scene load_steps=2 format=3]
[ext_resource type="Theme" path="res://themes/t.tres" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="L" type="Label" parent="."]
offset_right = 200
offset_bottom = 40
theme = ExtResource("1")
text = "Hi"
`;

describe("resolveTheme font sizes", () => {
  it("sizes a RichTextLabel from its theme when there is no inline override", () => {
    const resolveTheme = (_n: unknown, name: string) =>
      name === "normal_font_size" || name === "font_size" ? 32 : undefined;
    const label = node(
      render(parseGodotTextScene(RICH_NO_INLINE), { resolveTheme }),
      "Label",
    );
    // RichTextLabel sizes render at 0.8x (no explicit font file): 32 * 0.8 = 25.6.
    expect(label.selfStyle["--godot-rich-normal-font-size"]).toBe("25.6px");
  });

  it("prefers an inline rich-text override over the theme", () => {
    const withOverride = RICH_NO_INLINE.replace(
      'text = "Hola"',
      'theme_override_font_sizes/normal_font_size = 50\ntext = "Hola"',
    );
    const resolveTheme = () => 32;
    const label = node(
      render(parseGodotTextScene(withOverride), { resolveTheme }),
      "Label",
    );
    expect(label.selfStyle["--godot-rich-normal-font-size"]).toBe("40px"); // 50 * 0.8
  });

  it("sizes a plain Label from its theme (no 0.8 rich-text scaling)", () => {
    const resolveTheme = (_n: unknown, name: string) =>
      name === "font_size" ? 28 : undefined;
    const label = node(
      render(parseGodotTextScene(PLAIN_LABEL), { resolveTheme }),
      "L",
    );
    expect(label.selfStyle["font-size"]).toBe("28px");
  });

  it("leaves text at the 1em fallback when no resolveTheme is provided", () => {
    const label = node(render(parseGodotTextScene(RICH_NO_INLINE)), "Label");
    expect(label.selfStyle["--godot-rich-normal-font-size"]).toBeUndefined();
  });
});
