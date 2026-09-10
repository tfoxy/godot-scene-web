import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import { resolveGodotSceneTree as resolveSceneTreeFromGraph } from "../src/index";

// Test shim: the rect engine now takes a SceneGraph (browser-native split moved
// structural indexing into deriveSceneGraph); keep the scene-taking call shape.
function resolveGodotSceneTree(scene, options) {
  return resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
}

const rectOf = (scene: string, path: string) =>
  resolveGodotSceneTree(parseGodotTextScene(scene)).nodes.find(
    (node) => node.path === path,
  )?.rect;

describe("anchors_preset resolution", () => {
  it("fills the parent for a full-rect preset with no explicit anchors", () => {
    const scene = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1280
offset_bottom = 720
[node name="Full" type="ColorRect" parent="."]
layout_mode = 1
anchors_preset = 15
grow_horizontal = 2
grow_vertical = 2
`;
    expect(rectOf(scene, "Full")).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });

  it("anchors a bottom-wide preset strip to the bottom edge", () => {
    const scene = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1280
offset_bottom = 720
[node name="Strip" type="Control" parent="."]
layout_mode = 1
anchors_preset = 12
offset_top = -120.0
grow_horizontal = 2
grow_vertical = 0
`;
    expect(rectOf(scene, "Strip")).toEqual({
      x: 0,
      y: 600,
      width: 1280,
      height: 120,
    });
  });

  it("centers a center-preset node", () => {
    const scene = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1000
offset_bottom = 1000
[node name="Mid" type="Control" parent="."]
layout_mode = 1
anchors_preset = 8
offset_left = -100.0
offset_top = -50.0
offset_right = 100.0
offset_bottom = 50.0
grow_horizontal = 2
grow_vertical = 2
`;
    expect(rectOf(scene, "Mid")).toEqual({
      x: 400,
      y: 450,
      width: 200,
      height: 100,
    });
  });

  it("does not override explicit anchors when both are present", () => {
    const scene = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1280
offset_bottom = 720
[node name="Panel" type="ColorRect" parent="."]
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
offset_left = 10
offset_top = 20
offset_right = -30
offset_bottom = -40
`;
    expect(rectOf(scene, "Panel")).toEqual({
      x: 10,
      y: 20,
      width: 1240,
      height: 660,
    });
  });

  it("applies override layout props before solving a bottom anchored child", () => {
    const scene = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1920
offset_bottom = 1080
[node name="ContentContainer" type="Control" parent="."]
anchors_preset = 7
anchor_left = 0.5
anchor_top = 1.0
anchor_right = 0.5
anchor_bottom = 1.0
offset_left = -580.0
offset_top = -760.0
offset_right = 580.0
offset_bottom = -40.0
grow_horizontal = 2
grow_vertical = 0
[node name="Content" type="VBoxContainer" parent="ContentContainer"]
anchors_preset = 7
anchor_left = 0.5
anchor_top = 1.0
anchor_right = 0.5
anchor_bottom = 1.0
offset_left = -500.0
offset_right = 500.0
offset_bottom = 298.0
grow_horizontal = 2
grow_vertical = 0
`;
    const tree = resolveGodotSceneTree(parseGodotTextScene(scene), {
      overrideNodeProps: (_node, path) =>
        path === "ContentContainer/Content"
          ? {
              offset_top: -370,
              offset_bottom: 2,
              size_width: 1000,
              size_height: 372,
            }
          : undefined,
      viewport: { width: 1920, height: 1080 },
    });
    expect(
      tree.nodes.find((node) => node.path === "ContentContainer/Content")?.rect,
    ).toEqual({
      x: 460,
      y: 670,
      width: 1000,
      height: 372,
    });
  });
});
