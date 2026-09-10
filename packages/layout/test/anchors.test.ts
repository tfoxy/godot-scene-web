import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import type { GodotAnchorMap } from "../src/index";
import { resolveGodotSceneTree as resolveSceneTreeFromGraph } from "../src/index";

// Test shim: the rect engine now takes a SceneGraph (browser-native split moved
// structural indexing into deriveSceneGraph); keep the scene-taking call shape.
function resolveGodotSceneTree(scene, options) {
  return resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
}

const rectsOf = (scene: string, anchorsByPath?: GodotAnchorMap) => {
  const tree = resolveGodotSceneTree(parseGodotTextScene(scene), {
    viewport: { width: 1000, height: 1000 },
    anchorsByPath,
  });
  return (path: string) => tree.nodes.find((node) => node.path === path);
};

// A flow container that wraps fixed 100x40 children into rows at a 250px width
// (two children per row), plus a sibling box authored at an arbitrary offset.
const SCENE = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1000
offset_bottom = 1000
[node name="Flow" type="HFlowContainer" parent="."]
offset_left = 10.0
offset_top = 20.0
offset_right = 260.0
offset_bottom = 900.0
theme_override_constants/h_separation = 0
theme_override_constants/v_separation = 0
[node name="A" type="ColorRect" parent="Flow"]
custom_minimum_size = Vector2(100, 40)
[node name="B" type="ColorRect" parent="Flow"]
custom_minimum_size = Vector2(100, 40)
[node name="C" type="ColorRect" parent="Flow"]
custom_minimum_size = Vector2(100, 40)
[node name="Panel" type="Control" parent="."]
offset_left = 500.0
offset_top = 500.0
offset_right = 700.0
offset_bottom = 560.0
`;

describe("declarative anchors", () => {
  it("places a node's top-left at a flow container's content bottom-left", () => {
    const find = rectsOf(SCENE, {
      Panel: {
        anchorTo: "Flow",
        from: "contentBottomLeft",
        to: "topLeft",
      },
    });
    const flow = find("Flow")!;
    const panel = find("Panel")!;
    // Three 100x40 children at width 250 wrap to two rows -> content height 80.
    expect(panel.rect.x).toBe(flow.rect.x);
    expect(panel.rect.y).toBe(flow.rect.y + 80);
    // Width/height are untouched by the anchor.
    expect(panel.rect.width).toBe(200);
    expect(panel.rect.height).toBe(60);
  });

  it("applies an extra offset after aligning edges", () => {
    const find = rectsOf(SCENE, {
      Panel: {
        anchorTo: "Flow",
        from: "contentBottomLeft",
        to: "topLeft",
        offset: { x: 5, y: 7 },
      },
    });
    const flow = find("Flow")!;
    const panel = find("Panel")!;
    expect(panel.rect.x).toBe(flow.rect.x + 5);
    expect(panel.rect.y).toBe(flow.rect.y + 80 + 7);
  });

  it("collapses content edges to the node origin when it has no children", () => {
    const scene = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1000
offset_bottom = 1000
[node name="Flow" type="HFlowContainer" parent="."]
offset_left = 10.0
offset_top = 20.0
offset_right = 260.0
offset_bottom = 900.0
[node name="Panel" type="Control" parent="."]
offset_left = 500.0
offset_top = 500.0
offset_right = 700.0
offset_bottom = 560.0
`;
    const find = rectsOf(scene, {
      Panel: { anchorTo: "Flow", from: "contentBottomLeft", to: "topLeft" },
    });
    const flow = find("Flow")!;
    const panel = find("Panel")!;
    expect(panel.rect.x).toBe(flow.rect.x);
    expect(panel.rect.y).toBe(flow.rect.y);
  });

  it("moves the anchored node's descendants rigidly with it", () => {
    const scene = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1000
offset_bottom = 1000
[node name="Flow" type="HFlowContainer" parent="."]
offset_left = 10.0
offset_top = 20.0
offset_right = 260.0
offset_bottom = 900.0
theme_override_constants/h_separation = 0
theme_override_constants/v_separation = 0
[node name="A" type="ColorRect" parent="Flow"]
custom_minimum_size = Vector2(100, 40)
[node name="Panel" type="Control" parent="."]
offset_left = 500.0
offset_top = 500.0
offset_right = 700.0
offset_bottom = 560.0
[node name="Child" type="ColorRect" parent="Panel"]
offset_left = 10.0
offset_top = 10.0
offset_right = 30.0
offset_bottom = 30.0
`;
    const find = rectsOf(scene, {
      Panel: { anchorTo: "Flow", from: "contentBottomLeft", to: "topLeft" },
    });
    const panel = find("Panel")!;
    const child = find("Panel/Child")!;
    // Child keeps its 10px inset relative to the moved Panel.
    expect(child.rect.x).toBe(panel.rect.x + 10);
    expect(child.rect.y).toBe(panel.rect.y + 10);
  });

  it("warns and leaves the node unmoved when the target is missing", () => {
    const tree = resolveGodotSceneTree(parseGodotTextScene(SCENE), {
      viewport: { width: 1000, height: 1000 },
      anchorsByPath: {
        Panel: { anchorTo: "DoesNotExist", from: "bottomLeft", to: "topLeft" },
      },
    });
    const panel = tree.nodes.find((node) => node.path === "Panel")!;
    expect(panel.rect.x).toBe(500);
    expect(panel.rect.y).toBe(500);
    expect(
      tree.diagnostics.some((d) => d.code === "anchor-target-missing"),
    ).toBe(true);
  });
});
