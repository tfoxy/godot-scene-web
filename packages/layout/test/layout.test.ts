import type { GodotSceneState } from "@godot-scene-web/core";
import { isGodotSceneTree } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import { resolveGodotSceneTree as resolveSceneTreeFromGraph } from "../src/index";

// Test shim: the rect engine now takes a SceneGraph (browser-native split moved
// structural indexing into deriveSceneGraph); keep the scene-taking call shape.
function resolveGodotSceneTree(scene, options) {
  return resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
}

describe("resolveGodotSceneTree", () => {
  it("returns GodotSceneTree contracts from a GodotSceneState", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 120
offset_bottom = 80
`);
    const tree = resolveGodotSceneTree(scene);

    expect(isGodotSceneTree(tree)).toBe(true);
  });

  it("rejects malformed tree-shaped values", () => {
    expect(isGodotSceneTree({ viewport: {}, nodes: [] })).toBe(false);
    expect(
      isGodotSceneTree({
        viewport: { x: 0, y: 0, width: 1, height: 1 },
        nodes: [{}],
      }),
    ).toBe(false);
  });

  it("computes layout directly from a GodotSceneState contract", () => {
    const state = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 120
offset_bottom = 80
[node name="Panel" type="ColorRect" parent="."]
offset_left = 10
offset_top = 20
offset_right = 60
offset_bottom = 70
`);
    expect(
      resolveGodotSceneTree(state).nodes.find((node) => node.path === "Panel")
        ?.rect,
    ).toEqual({
      x: 10,
      y: 20,
      width: 50,
      height: 50,
    });
  });

  it("uses anchors and offsets without relying on anchors_preset", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1280
offset_bottom = 720
[node name="Panel" type="ColorRect" parent="."]
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
offset_left = 10
offset_top = 20
offset_right = -30
offset_bottom = -40
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "Panel")?.rect).toEqual({
      x: 10,
      y: 20,
      width: 1240,
      height: 660,
    });
  });

  it("applies grow direction when minimum size exceeds rect", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 200
[node name="Both" type="Control" parent="."]
offset_left = 50
offset_top = 50
offset_right = 60
offset_bottom = 60
custom_minimum_size = Vector2(50, 50)
grow_horizontal = 2
grow_vertical = 2
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "Both")?.rect).toEqual({
      x: 30,
      y: 30,
      width: 50,
      height: 50,
    });
  });

  it("uses TextureRect texture size as its default minimum size", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://panel.svg" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Icon" type="TextureRect" parent="."]
offset_left = 10
offset_top = 10
offset_right = 42
offset_bottom = 42
texture = ExtResource("1")
`);
    const layout = resolveGodotSceneTree(scene, {
      resolveResource: () => ({
        path: "res://panel.svg",
        size: { width: 64, height: 64 },
      }),
    });
    expect(layout.nodes.find((node) => node.path === "Icon")?.rect).toEqual({
      x: 10,
      y: 10,
      width: 64,
      height: 64,
    });
  });

  it("ignores TextureRect texture size when expand_mode is ignore size", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://panel.svg" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Icon" type="TextureRect" parent="."]
offset_left = 10
offset_top = 10
offset_right = 42
offset_bottom = 42
texture = ExtResource("1")
expand_mode = 1
`);
    const layout = resolveGodotSceneTree(scene, {
      resolveResource: () => ({
        path: "res://panel.svg",
        size: { width: 64, height: 64 },
      }),
    });
    expect(layout.nodes.find((node) => node.path === "Icon")?.rect).toEqual({
      x: 10,
      y: 10,
      width: 32,
      height: 32,
    });
  });

  it("lays out hbox children by minimum size and separation", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 300
offset_bottom = 80
theme_override_constants/separation = 10
[node name="A" type="ColorRect" parent="."]
custom_minimum_size = Vector2(100, 40)
[node name="B" type="ColorRect" parent="."]
custom_minimum_size = Vector2(50, 40)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "A")?.rect).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 80,
    });
    expect(layout.nodes.find((node) => node.path === "B")?.rect).toEqual({
      x: 110,
      y: 0,
      width: 50,
      height: 80,
    });
  });

  it("uses combined minimum size when laying out hbox siblings", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 300
offset_bottom = 80
theme_override_constants/separation = 6
[node name="A" type="Control" parent="."]
custom_minimum_size = Vector2(0, 80)
combined_minimum_width = 14
combined_minimum_height = 80
[node name="B" type="ColorRect" parent="."]
custom_minimum_size = Vector2(44, 80)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "A")?.rect).toEqual({
      x: 0,
      y: 0,
      width: 14,
      height: 80,
    });
    expect(layout.nodes.find((node) => node.path === "B")?.rect.x).toBe(20);
  });

  it("grows a text Label to its measured content size (resolveTextContentSize)", () => {
    // A Label with custom_minimum_size.x = 0 collapses to 0 width unless its text
    // content is measured. `resolveTextContentSize` is the text analogue of a
    // TextureRect's intrinsic texture size — it gives the floor-number label "1"
    // its 14px paragraph width, which then pushes its HBox sibling.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 300
offset_bottom = 80
theme_override_constants/separation = 6
[node name="FloorNumLabel" type="Label" parent="."]
custom_minimum_size = Vector2(0, 80)
text = "1"
[node name="B" type="ColorRect" parent="."]
custom_minimum_size = Vector2(44, 80)
`);
    const layout = resolveGodotSceneTree(scene, {
      resolveTextContentSize: (node) =>
        node.name === "FloorNumLabel" ? { width: 14, height: 40 } : undefined,
    });
    expect(
      layout.nodes.find((node) => node.path === "FloorNumLabel")?.rect,
    ).toEqual({ x: 0, y: 0, width: 14, height: 80 });
    expect(layout.nodes.find((node) => node.path === "B")?.rect.x).toBe(20);
  });

  it("keeps custom_minimum_size when it exceeds the measured text content", () => {
    // HP/Gold labels have an explicit custom_minimum_size wider/taller than the
    // text box; combinedMinimum takes the max, so measurement must not shrink them.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 300
offset_bottom = 80
[node name="HpLabel" type="Label" parent="."]
custom_minimum_size = Vector2(120, 80)
text = "67/80"
`);
    const layout = resolveGodotSceneTree(scene, {
      resolveTextContentSize: () => ({ width: 94, height: 39 }),
    });
    expect(layout.nodes.find((node) => node.path === "HpLabel")?.rect).toEqual({
      x: 0,
      y: 0,
      width: 120,
      height: 80,
    });
  });

  it("shrink-centers a text Label on the cross axis (size_flags_vertical=4)", () => {
    // The live MegaLabel sets SHRINK_CENTER at runtime, so it uses its 80px min
    // height centered in the 83px container row rather than filling to 83.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 300
offset_bottom = 83
[node name="HpLabel" type="Label" parent="."]
custom_minimum_size = Vector2(120, 80)
size_flags_vertical = 4
text = "67/80"
`);
    const layout = resolveGodotSceneTree(scene, {
      resolveTextContentSize: () => ({ width: 94, height: 39 }),
    });
    const rect = layout.nodes.find((node) => node.path === "HpLabel")?.rect;
    expect(rect?.height).toBe(80);
    expect(rect?.y).toBeCloseTo(1.5, 5);
  });

  it("spaces hbox children by Godot's default theme separation when no override", () => {
    // Godot's built-in default theme sets BoxContainer separation to 4 (see
    // scene/theme/default_theme.cpp). A container with no override inherits it,
    // so B starts at A.width + 4, not flush at A.width.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 300
offset_bottom = 80
[node name="A" type="ColorRect" parent="."]
custom_minimum_size = Vector2(100, 40)
[node name="B" type="ColorRect" parent="."]
custom_minimum_size = Vector2(50, 40)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "B")?.rect.x).toBe(104);
  });

  it("packs hbox children flush when separation is explicitly overridden to 0", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 300
offset_bottom = 80
theme_override_constants/separation = 0
[node name="A" type="ColorRect" parent="."]
custom_minimum_size = Vector2(100, 40)
[node name="B" type="ColorRect" parent="."]
custom_minimum_size = Vector2(50, 40)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "B")?.rect.x).toBe(100);
  });

  it("skips invisible children when positioning box container siblings", () => {
    // A hidden control takes no space in a Godot container, so B should sit
    // immediately after A (separation 0), not after a gap for the invisible Mid.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 300
offset_bottom = 80
theme_override_constants/separation = 0
[node name="A" type="ColorRect" parent="."]
custom_minimum_size = Vector2(100, 40)
[node name="Mid" type="ColorRect" parent="."]
visible = false
custom_minimum_size = Vector2(50, 40)
[node name="B" type="ColorRect" parent="."]
custom_minimum_size = Vector2(50, 40)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "B")?.rect.x).toBe(100);
  });

  it("fits margin container children to the content rect honoring size flags", () => {
    // Godot's MarginContainer fit_child_in_rect fills the content rect (rect minus
    // margins) per axis by size flags: vertical default FILL fills the height,
    // horizontal SHRINK_CENTER (4) keeps the min width centered. The child's own
    // custom_minimum_size must not pin it below the content height. The negative
    // margin_top mirrors the top-bar RoomIconResizer/RoomIcon shape (row 80 -> 84).
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="MarginContainer"]
offset_right = 52
offset_bottom = 80
theme_override_constants/margin_left = 5
theme_override_constants/margin_top = -4
theme_override_constants/margin_right = 3
[node name="Child" type="Control" parent="."]
custom_minimum_size = Vector2(44, 44)
size_flags_horizontal = 4
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "Child")?.rect).toEqual({
      x: 5,
      y: -4,
      width: 44,
      height: 84,
    });
  });

  it("mounts external scene instances and applies inherited child overrides", () => {
    const host = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://button.tscn" id="1"]
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 100
[node name="Button" parent="." instance=ExtResource("1")]
offset_left = 10
offset_top = 20
offset_right = 110
offset_bottom = 60
[node name="Label" parent="Button"]
text = "Override"
`);
    const mounted = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="ButtonScene" type="Control"]
[node name="Label" type="Label" parent="."]
offset_right = 50
offset_bottom = 20
text = "Base"
`);
    const layout = resolveGodotSceneTree(host, {
      mountExternalScene: (ref) => (ref.id === "1" ? mounted : undefined),
    });
    expect(layout.nodes.find((node) => node.path === "Button")?.type).toBe(
      "Control",
    );
    expect(layout.nodes.find((node) => node.path === "Button")?.rect).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 40,
    });
    expect(
      layout.nodes.find((node) => node.path === "Button/Label")?.properties
        .text,
    ).toBe("Override");
  });

  it("expands an instance nested under another mount's added-child subtree", () => {
    // Deck-view sort-button shape: instance B (the sorter) is authored under an
    // ADDED child of instance A's (the card grid) mounted subtree — so B is BOTH a
    // mount-root AND an override-child of A's mount. B's internals must still expand
    // and the override on a B-internal path must apply.
    const host = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[ext_resource type="PackedScene" path="res://a.tscn" id="1"]
[ext_resource type="PackedScene" path="res://b.tscn" id="2"]
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 200
[node name="A" parent="." instance=ExtResource("1")]
[node name="Added" type="Control" parent="A/Inner"]
[node name="B" parent="A/Inner/Added" instance=ExtResource("2")]
`);
    const a = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="AScene" type="Control"]
[node name="Inner" type="Control" parent="."]
`);
    const b = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="BScene" type="Control"]
[node name="Label" type="Label" parent="."]
text = "Base"
`);
    const layout = resolveGodotSceneTree(host, {
      mountExternalScene: (ref) =>
        ref.id === "1" ? a : ref.id === "2" ? b : undefined,
      overrideNodeProps: (_node, path) =>
        path === "A/Inner/Added/B/Label" ? { text: "Override" } : undefined,
    });
    // The sorter root resolves, AND its internal Label expands at the assembled path...
    expect(layout.nodes.some((node) => node.path === "A/Inner/Added/B")).toBe(
      true,
    );
    expect(
      layout.nodes.find((node) => node.path === "A/Inner/Added/B/Label")
        ?.properties.text,
    ).toBe("Override");
  });

  it("does not resolve lazy external scenes for hidden hosts or hidden ancestors", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://child.tscn" id="1"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="HiddenHost" parent="." instance=ExtResource("1")]
visible = false
[node name="HiddenParent" type="Control" parent="."]
visible = false
[node name="ChildHost" parent="HiddenParent" instance=ExtResource("1")]
`);
    const calls: string[] = [];
    const layout = resolveGodotSceneTree(scene, {
      resolveExternalScene: ({ nodePath }) => {
        calls.push(nodePath);
        return { status: "pending", path: "res://child.tscn" };
      },
    });
    expect(calls).toEqual([]);
    expect(layout.resourceStatuses).toEqual([]);
    expect(layout.nodes.some((node) => node.path === "HiddenHost")).toBe(true);
  });

  it("applies override visibility before resolving lazy external scenes", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://child.tscn" id="1"]
[node name="Root" type="Control"]
[node name="Host" parent="." instance=ExtResource("1")]
`);
    let calls = 0;
    resolveGodotSceneTree(scene, {
      overrideNodeProps: (_node, path) =>
        path === "Host" ? { visible: false } : undefined,
      resolveExternalScene: () => {
        calls += 1;
        return { status: "pending", path: "res://child.tscn" };
      },
    });
    expect(calls).toBe(0);
  });

  it("retypes a node via overrideNodeType without mutating the source", () => {
    const scene = parseGodotTextScene(`
[gd_scene format=3]
[node name="Root" type="Control"]
[node name="Portrait" type="SpineSprite" parent="."]
`);
    const layout = resolveGodotSceneTree(scene, {
      overrideNodeType: (_node, path) =>
        path === "Portrait" ? "TextureRect" : undefined,
    });
    expect(layout.nodes.find((node) => node.path === "Portrait")?.type).toBe(
      "TextureRect",
    );
    // Source scene is untouched (override applies during indexing only).
    expect(scene.nodes.find((node) => node.name === "Portrait")?.type).toBe(
      "SpineSprite",
    );
  });

  it("omits included-out lazy external scene subtrees before resolving", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://child.tscn" id="1"]
[node name="Root" type="Control"]
[node name="Host" parent="." instance=ExtResource("1")]
[node name="Override" parent="Host"]
`);
    let calls = 0;
    const layout = resolveGodotSceneTree(scene, {
      includeNode: (_node, path) => path !== "Host",
      resolveExternalScene: () => {
        calls += 1;
        return { status: "pending", path: "res://child.tscn" };
      },
    });
    expect(calls).toBe(0);
    expect(layout.nodes.some((node) => node.path === "Host")).toBe(false);
    expect(layout.nodes.some((node) => node.path === "Host/Override")).toBe(
      false,
    );
  });

  it("keeps lazy external scene hosts and reports pending or failed mounts", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[ext_resource type="PackedScene" path="res://pending.tscn" id="pending"]
[ext_resource type="PackedScene" path="res://failed.tscn" id="failed"]
[node name="Root" type="Control"]
[node name="Pending" parent="." instance=ExtResource("pending")]
[node name="PendingOverride" parent="Pending"]
[node name="Failed" parent="." instance=ExtResource("failed")]
`);
    const layout = resolveGodotSceneTree(scene, {
      resolveExternalScene: ({ ref }) =>
        ref.id === "failed"
          ? {
              status: "error",
              path: "res://failed.tscn",
              message: "network failed",
            }
          : { status: "pending", path: "res://pending.tscn" },
    });
    expect(layout.nodes.some((node) => node.path === "Pending")).toBe(true);
    expect(layout.nodes.some((node) => node.path === "PendingOverride")).toBe(
      false,
    );
    expect(layout.nodes.some((node) => node.path === "Failed")).toBe(true);
    expect(layout.resourceStatuses).toEqual([
      {
        kind: "external-scene",
        status: "pending",
        nodePath: "Pending",
        path: "res://pending.tscn",
        ref: { type: "ExtResource", id: "pending" },
        message: undefined,
      },
      {
        kind: "external-scene",
        status: "error",
        nodePath: "Failed",
        path: "res://failed.tscn",
        ref: { type: "ExtResource", id: "failed" },
        message: "network failed",
      },
    ]);
  });

  it("wraps hflow children and expands hbox children with size flags", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 120
offset_bottom = 100
[node name="Flow" type="HFlowContainer" parent="."]
offset_right = 120
offset_bottom = 100
theme_override_constants/h_separation = 5
theme_override_constants/v_separation = 2
[node name="A" type="Control" parent="Flow"]
custom_minimum_size = Vector2(70, 10)
[node name="B" type="Control" parent="Flow"]
custom_minimum_size = Vector2(70, 20)
[node name="Row" type="HBoxContainer" parent="."]
offset_top = 50
offset_right = 120
offset_bottom = 80
theme_override_constants/separation = 0
[node name="Fill" type="Control" parent="Row"]
custom_minimum_size = Vector2(20, 10)
size_flags_horizontal = 3
[node name="Fixed" type="Control" parent="Row"]
custom_minimum_size = Vector2(20, 10)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "Flow/B")?.rect).toEqual({
      x: 0,
      y: 12,
      width: 70,
      height: 20,
    });
    expect(
      layout.nodes.find((node) => node.path === "Row/Fill")?.rect.width,
    ).toBe(100);
    expect(layout.nodes.find((node) => node.path === "Row/Fixed")?.rect.x).toBe(
      100,
    );
  });

  it("wraps vflow children into columns", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="VFlowContainer"]
offset_right = 120
offset_bottom = 50
theme_override_constants/h_separation = 5
theme_override_constants/v_separation = 2
[node name="A" type="Control" parent="."]
custom_minimum_size = Vector2(20, 30)
[node name="B" type="Control" parent="."]
custom_minimum_size = Vector2(30, 30)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "A")?.rect).toEqual({
      x: 0,
      y: 0,
      width: 20,
      height: 30,
    });
    expect(layout.nodes.find((node) => node.path === "B")?.rect).toEqual({
      x: 25,
      y: 0,
      width: 30,
      height: 30,
    });
  });

  it("uses base BoxContainer and FlowContainer vertical properties", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 150
[node name="Box" type="BoxContainer" parent="."]
offset_right = 100
offset_bottom = 80
vertical = true
theme_override_constants/separation = 6
[node name="BoxA" type="Control" parent="Box"]
custom_minimum_size = Vector2(20, 20)
[node name="BoxB" type="Control" parent="Box"]
custom_minimum_size = Vector2(20, 10)
[node name="Flow" type="FlowContainer" parent="."]
offset_top = 90
offset_right = 120
offset_bottom = 140
vertical = true
theme_override_constants/h_separation = 4
theme_override_constants/v_separation = 3
[node name="FlowA" type="Control" parent="Flow"]
custom_minimum_size = Vector2(20, 30)
[node name="FlowB" type="Control" parent="Flow"]
custom_minimum_size = Vector2(25, 30)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "Box/BoxA")?.rect).toEqual(
      { x: 0, y: 0, width: 100, height: 20 },
    );
    expect(layout.nodes.find((node) => node.path === "Box/BoxB")?.rect).toEqual(
      { x: 0, y: 26, width: 100, height: 10 },
    );
    expect(
      layout.nodes.find((node) => node.path === "Flow/FlowB")?.rect,
    ).toEqual({ x: 24, y: 90, width: 25, height: 30 });
  });

  it("lays out AspectRatioContainer children from ratio, stretch mode, alignment, and minimum size", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 500
offset_bottom = 260
[node name="Fit" type="AspectRatioContainer" parent="."]
offset_right = 160
offset_bottom = 100
ratio = 2.0
[node name="FitChild" type="Control" parent="Fit"]
[node name="CoverEnd" type="AspectRatioContainer" parent="."]
offset_left = 180
offset_right = 340
offset_bottom = 100
ratio = 2.0
stretch_mode = 3
alignment_horizontal = 2
[node name="CoverChild" type="Control" parent="CoverEnd"]
[node name="WidthControlsHeight" type="AspectRatioContainer" parent="."]
offset_top = 120
offset_right = 150
offset_bottom = 200
ratio = 3.0
stretch_mode = 0
alignment_vertical = 2
[node name="WidthChild" type="Control" parent="WidthControlsHeight"]
[node name="HeightControlsWidth" type="AspectRatioContainer" parent="."]
offset_left = 180
offset_top = 120
offset_right = 330
offset_bottom = 200
ratio = 3.0
stretch_mode = 1
alignment_horizontal = 0
[node name="HeightChild" type="Control" parent="HeightControlsWidth"]
[node name="Minimum" type="AspectRatioContainer" parent="."]
offset_left = 350
offset_right = 510
offset_bottom = 100
ratio = 2.0
[node name="MinimumChild" type="Control" parent="Minimum"]
custom_minimum_size = Vector2(180, 90)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(
      layout.nodes.find((node) => node.path === "Fit/FitChild")?.rect,
    ).toEqual({ x: 0, y: 10, width: 160, height: 80 });
    expect(
      layout.nodes.find((node) => node.path === "CoverEnd/CoverChild")?.rect,
    ).toEqual({ x: 140, y: 0, width: 200, height: 100 });
    expect(
      layout.nodes.find(
        (node) => node.path === "WidthControlsHeight/WidthChild",
      )?.rect,
    ).toEqual({ x: 0, y: 150, width: 150, height: 50 });
    expect(
      layout.nodes.find(
        (node) => node.path === "HeightControlsWidth/HeightChild",
      )?.rect,
    ).toEqual({ x: 180, y: 120, width: 240, height: 80 });
    // The container's minimum size is its child's (180, 90), so it grows its
    // own width 160 -> 180 (grow END, no reposition) per Control::_size_changed,
    // and the child centers within the grown container at x = 350.
    expect(
      layout.nodes.find((node) => node.path === "Minimum/MinimumChild")?.rect,
    ).toEqual({ x: 350, y: 5, width: 180, height: 90 });
  });

  it("fits PanelContainer children inside stylebox content margins", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[sub_resource type="StyleBoxFlat" id="panel"]
border_width_left = 2
border_width_top = 3
border_width_right = 4
border_width_bottom = 5
content_margin_left = 8
content_margin_top = 7
content_margin_right = 6
content_margin_bottom = 5
[node name="Root" type="PanelContainer"]
offset_right = 100
offset_bottom = 60
theme_override_styles/panel = SubResource("panel")
[node name="Child" type="Control" parent="."]
`);
    const layout = resolveGodotSceneTree(scene, {
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
    expect(layout.nodes.find((node) => node.path === "Child")?.rect).toEqual({
      x: 8,
      y: 7,
      width: 86,
      height: 48,
    });
  });

  it("positions ScrollContainer content using child minimum size and scroll offsets", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="ScrollContainer"]
offset_right = 80
offset_bottom = 40
scroll_horizontal = 10
scroll_vertical = 5
[node name="Content" type="Control" parent="."]
custom_minimum_size = Vector2(120, 90)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "Content")?.rect).toEqual({
      x: -10,
      y: -5,
      width: 120,
      height: 90,
    });
  });

  it("uses expansion space without resizing when fill is not set", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 120
offset_bottom = 40
theme_override_constants/separation = 10
[node name="A" type="Control" parent="."]
custom_minimum_size = Vector2(20, 20)
[node name="Spacer" type="Control" parent="."]
custom_minimum_size = Vector2(20, 20)
size_flags_horizontal = 2
[node name="B" type="Control" parent="."]
custom_minimum_size = Vector2(20, 20)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(
      layout.nodes.find((node) => node.path === "Spacer")?.rect,
    ).toMatchObject({ x: 30, width: 20 });
    expect(layout.nodes.find((node) => node.path === "B")?.rect.x).toBe(100);
  });

  it("tracks vertical text alignment and vector transforms", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Text" type="Label" parent="."]
offset_right = 100
offset_bottom = 40
vertical_alignment = 1
scale = Vector2(0.5, 2)
pivot_offset = Vector2(10, 20)
`);
    const node = resolveGodotSceneTree(scene).nodes.find(
      (candidate) => candidate.path === "Text",
    );
    expect(node?.textVerticalAlign).toBe("center");
    expect(node?.scale).toEqual({ x: 0.5, y: 2 });
    expect(node?.pivotOffset).toEqual({ x: 10, y: 20 });
  });

  it("treats clip_children as clipping and applies shrink flags on the cross axis", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 200
offset_bottom = 100
clip_children = 1
theme_override_constants/separation = 0
[node name="Centered" type="Control" parent="."]
custom_minimum_size = Vector2(40, 20)
size_flags_vertical = 4
[node name="Ended" type="Control" parent="."]
custom_minimum_size = Vector2(40, 20)
size_flags_vertical = 8
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === ".")?.clipContents).toBe(
      true,
    );
    expect(layout.nodes.find((node) => node.path === "Centered")?.rect).toEqual(
      { x: 0, y: 40, width: 40, height: 20 },
    );
    expect(layout.nodes.find((node) => node.path === "Ended")?.rect).toEqual({
      x: 40,
      y: 80,
      width: 40,
      height: 20,
    });
  });

  it("lays out grid children by columns and preserves draw order metadata", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="GridContainer"]
offset_right = 100
offset_bottom = 100
columns = 2
theme_override_constants/h_separation = 5
theme_override_constants/v_separation = 7
[node name="A" type="Control" parent="."]
custom_minimum_size = Vector2(20, 10)
[node name="B" type="Control" parent="."]
custom_minimum_size = Vector2(30, 12)
[node name="C" type="Control" parent="."]
custom_minimum_size = Vector2(10, 8)
z_index = 2
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "B")?.rect).toEqual({
      x: 25,
      y: 0,
      width: 30,
      height: 12,
    });
    expect(layout.nodes.find((node) => node.path === "C")?.rect).toEqual({
      x: 0,
      y: 19,
      width: 20,
      height: 8,
    });
    expect(layout.nodes.find((node) => node.path === "C")?.zIndex).toBe(2);
    expect(
      layout.nodes.find((node) => node.path === "C")?.drawOrder,
    ).toBeGreaterThan(
      layout.nodes.find((node) => node.path === "A")?.drawOrder ?? -1,
    );
  });

  it("recursively mounts packed scene instances", () => {
    const host = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://a.tscn" id="A"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="AHost" parent="." instance=ExtResource("A")]
offset_right = 80
offset_bottom = 80
`);
    const sceneA = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://b.tscn" id="B"]
[node name="AScene" type="Control"]
[node name="BHost" parent="." instance=ExtResource("B")]
offset_right = 40
offset_bottom = 40
`);
    const sceneB = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="BScene" type="Control"]
[node name="Leaf" type="Label" parent="."]
offset_right = 10
offset_bottom = 10
text = "Nested"
`);
    const layout = resolveGodotSceneTree(host, {
      mountExternalScene: (ref) =>
        ref.id === "A" ? sceneA : ref.id === "B" ? sceneB : undefined,
    });
    expect(layout.nodes.find((node) => node.path === "AHost/BHost")?.type).toBe(
      "Control",
    );
    expect(
      layout.nodes.find((node) => node.path === "AHost/BHost/Leaf")?.properties
        .text,
    ).toBe("Nested");
  });

  it("passes mounted-scene child overrides into nested packed scene mounts", () => {
    const host = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://a.tscn" id="A"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="AHost" parent="." instance=ExtResource("A")]
offset_right = 80
offset_bottom = 80
`);
    const sceneA = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://b.tscn" id="B"]
[node name="AScene" type="Control"]
[node name="BHost" parent="." instance=ExtResource("B")]
offset_right = 40
offset_bottom = 40
[node name="HpBackground" parent="BHost"]
offset_left = 7
offset_top = 9
offset_right = 57
offset_bottom = 19
`);
    const sceneB = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="BScene" type="Control"]
[node name="HpBackground" type="ColorRect" parent="."]
offset_right = 100
offset_bottom = 20
`);
    const layout = resolveGodotSceneTree(host, {
      mountExternalScene: (ref) =>
        ref.id === "A" ? sceneA : ref.id === "B" ? sceneB : undefined,
    });
    const hpBackground = layout.nodes.find(
      (node) => node.path === "AHost/BHost/HpBackground",
    );
    expect(hpBackground?.type).toBe("ColorRect");
    expect(hpBackground?.rect).toEqual({
      x: 7,
      y: 9,
      width: 50,
      height: 10,
    });
    expect(
      layout.nodes.filter((node) => node.path === "AHost/BHost/HpBackground"),
    ).toHaveLength(1);
  });

  it("grafts a NEW child added under a nested instanced scene", () => {
    // A scene can add a brand-new child to an instance it mounts (Godot "added
    // children", not an override of an existing instance node). When that instance is
    // itself nested inside another mounted scene, the added child must still graft at
    // the fully host-remapped path. Regression: the final added-child loop in
    // addMountedSceneNodes used the node's RAW scene path ("BHost/Badge") instead of
    // the remapped key ("AHost/BHost/Badge"), so the node was orphaned and dropped —
    // exactly the relic counter `Relic/AmountLabel` (added under the relic.tscn
    // instance) vanishing from the rest-site render.
    const host = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://a.tscn" id="A"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="AHost" parent="." instance=ExtResource("A")]
offset_right = 80
offset_bottom = 80
`);
    const sceneA = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://b.tscn" id="B"]
[node name="AScene" type="Control"]
[node name="BHost" parent="." instance=ExtResource("B")]
offset_right = 40
offset_bottom = 40
[node name="Badge" type="Label" parent="BHost"]
offset_left = 8
offset_top = 8
offset_right = 40
offset_bottom = 40
text = "0"
`);
    const sceneB = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="BScene" type="Control"]
[node name="Icon" type="ColorRect" parent="."]
offset_right = 40
offset_bottom = 40
`);
    const layout = resolveGodotSceneTree(host, {
      mountExternalScene: (ref) =>
        ref.id === "A" ? sceneA : ref.id === "B" ? sceneB : undefined,
    });
    // The inner instance's own content still renders (sanity).
    expect(layout.nodes.some((node) => node.path === "AHost/BHost/Icon")).toBe(
      true,
    );
    // The ADDED child grafts at the host-remapped path, linked to its instanced parent.
    const badge = layout.nodes.find(
      (node) => node.path === "AHost/BHost/Badge",
    );
    expect(badge?.type).toBe("Label");
    expect(badge?.properties.text).toBe("0");
    expect(badge?.parentPath).toBe("AHost/BHost");
    expect(
      layout.nodes.find((node) => node.path === "AHost/BHost")?.children,
    ).toContain("AHost/BHost/Badge");
    // It is NOT left at the un-remapped raw path (the orphaned-and-dropped form).
    expect(layout.nodes.some((node) => node.path === "BHost/Badge")).toBe(
      false,
    );
    expect(
      layout.nodes.filter((node) => node.path === "AHost/BHost/Badge"),
    ).toHaveLength(1);
  });

  it("sizes a bottom-anchored vbox to its children and grows it upward", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 200
[node name="VBox" type="VBoxContainer" parent="."]
anchor_top = 1.0
anchor_bottom = 1.0
grow_vertical = 0
theme_override_constants/separation = 0
[node name="A" type="ColorRect" parent="VBox"]
custom_minimum_size = Vector2(120, 30)
[node name="B" type="ColorRect" parent="VBox"]
custom_minimum_size = Vector2(120, 50)
`);
    const layout = resolveGodotSceneTree(scene);
    expect(layout.nodes.find((node) => node.path === "VBox")?.rect).toEqual({
      x: 0,
      y: 120,
      width: 120,
      height: 80,
    });
    expect(layout.nodes.find((node) => node.path === "VBox/A")?.rect).toEqual({
      x: 0,
      y: 120,
      width: 120,
      height: 30,
    });
    expect(layout.nodes.find((node) => node.path === "VBox/B")?.rect).toEqual({
      x: 0,
      y: 150,
      width: 120,
      height: 50,
    });
  });

  it("grows a bottom-anchored vbox by its instanced packed scene children", () => {
    const host = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://row.tscn" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 200
[node name="VBox" type="VBoxContainer" parent="."]
anchor_left = 0.0
anchor_top = 1.0
anchor_right = 1.0
anchor_bottom = 1.0
grow_vertical = 0
theme_override_constants/separation = 0
[node name="Row1" parent="VBox" instance=ExtResource("1")]
[node name="Row2" parent="VBox" instance=ExtResource("1")]
custom_minimum_size = Vector2(120, 50)
`);
    const row = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Row" type="Control"]
custom_minimum_size = Vector2(120, 30)
`);
    const layout = resolveGodotSceneTree(host, {
      mountExternalScene: (ref) => (ref.id === "1" ? row : undefined),
    });
    expect(layout.nodes.find((node) => node.path === "VBox")?.rect).toEqual({
      x: 0,
      y: 120,
      width: 200,
      height: 80,
    });
    expect(
      layout.nodes.find((node) => node.path === "VBox/Row1")?.rect,
    ).toEqual({
      x: 0,
      y: 120,
      width: 200,
      height: 30,
    });
    expect(
      layout.nodes.find((node) => node.path === "VBox/Row2")?.rect,
    ).toEqual({
      x: 0,
      y: 150,
      width: 200,
      height: 50,
    });
  });

  it("converges a content-sized panel to its wrapped hflow height", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 200
[node name="Panel" type="PanelContainer" parent="."]
[node name="Flow" type="HFlowContainer" parent="Panel"]
custom_minimum_size = Vector2(100, 0)
theme_override_constants/h_separation = 0
theme_override_constants/v_separation = 0
[node name="A" type="ColorRect" parent="Panel/Flow"]
custom_minimum_size = Vector2(60, 20)
[node name="B" type="ColorRect" parent="Panel/Flow"]
custom_minimum_size = Vector2(60, 20)
`);
    const layout = resolveGodotSceneTree(scene);
    // At width 100 the two 60-wide children wrap to two lines: the iterative
    // fixpoint feeds the resolved flow width back so the panel/flow size to the
    // wrapped height (40), not the single-line floor (20).
    expect(layout.nodes.find((node) => node.path === "Panel")?.rect).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 40,
    });
    expect(
      layout.nodes.find((node) => node.path === "Panel/Flow")?.rect,
    ).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 40,
    });
    expect(
      layout.nodes.find((node) => node.path === "Panel/Flow/A")?.rect,
    ).toEqual({
      x: 0,
      y: 0,
      width: 60,
      height: 20,
    });
    expect(
      layout.nodes.find((node) => node.path === "Panel/Flow/B")?.rect,
    ).toEqual({
      x: 0,
      y: 20,
      width: 60,
      height: 20,
    });
  });

  it("reorders siblings and draw order to honor an explicit node index", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 200
[node name="VBox" type="VBoxContainer" parent="."]
offset_right = 200
offset_bottom = 200
theme_override_constants/separation = 0
[node name="A" type="ColorRect" parent="VBox"]
custom_minimum_size = Vector2(50, 20)
[node name="B" type="ColorRect" parent="VBox"]
custom_minimum_size = Vector2(50, 30)
[node name="C" type="ColorRect" parent="VBox" index="0"]
custom_minimum_size = Vector2(50, 40)
`);
    const layout = resolveGodotSceneTree(scene);
    // C declares index="0" so it moves ahead of A and B (append-then-move_child).
    expect(layout.nodes.find((node) => node.path === "VBox")?.children).toEqual(
      ["VBox/C", "VBox/A", "VBox/B"],
    );
    expect(layout.nodes.find((node) => node.path === "VBox/C")?.rect.y).toBe(0);
    expect(layout.nodes.find((node) => node.path === "VBox/A")?.rect.y).toBe(
      40,
    );
    expect(layout.nodes.find((node) => node.path === "VBox/B")?.rect.y).toBe(
      60,
    );
    const drawOrder = (path: string) =>
      layout.nodes.find((node) => node.path === path)?.drawOrder ?? -1;
    expect(drawOrder("VBox/C")).toBeLessThan(drawOrder("VBox/A"));
    expect(drawOrder("VBox/A")).toBeLessThan(drawOrder("VBox/B"));
  });

  it("applies an index override to a child of a mounted packed scene", () => {
    const host = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://menu.tscn" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 200
[node name="Menu" parent="." instance=ExtResource("1")]
[node name="Third" parent="Menu" index="0"]
`);
    const menu = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Menu" type="VBoxContainer"]
offset_right = 200
offset_bottom = 200
theme_override_constants/separation = 0
[node name="First" type="ColorRect" parent="."]
custom_minimum_size = Vector2(50, 10)
[node name="Second" type="ColorRect" parent="."]
custom_minimum_size = Vector2(50, 10)
[node name="Third" type="ColorRect" parent="."]
custom_minimum_size = Vector2(50, 10)
`);
    const layout = resolveGodotSceneTree(host, {
      mountExternalScene: (ref) => (ref.id === "1" ? menu : undefined),
    });
    expect(layout.nodes.find((node) => node.path === "Menu")?.children).toEqual(
      ["Menu/Third", "Menu/First", "Menu/Second"],
    );
    expect(
      layout.nodes.find((node) => node.path === "Menu/Third")?.rect.y,
    ).toBe(0);
  });
});

describe("renderedRect (scale-aware global rect)", () => {
  it("equals rect when the node has no scale", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1920
offset_bottom = 1080
[node name="Panel" type="ColorRect" parent="."]
offset_left = 10
offset_top = 20
offset_right = 60
offset_bottom = 70
`);
    const node = resolveGodotSceneTree(scene).nodes.find(
      (n) => n.path === "Panel",
    );
    expect(node?.renderedRect).toEqual(node?.rect);
  });

  it("bakes a node's own scale at pivot 0 (size grows, position fixed)", () => {
    // TextureRect with scale 1.01 and default pivot (0,0): Godot's
    // get_global_rect() keeps the top-left and scales the size, matching the
    // renderer's CSS transform. rect stays pre-scale for child layout.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1920
offset_bottom = 1080
[node name="BgImage" type="TextureRect" parent="."]
offset_left = -328
offset_top = -1
offset_right = 2232
offset_bottom = 99
scale = Vector2(1.01, 1.01)
`);
    const node = resolveGodotSceneTree(scene).nodes.find(
      (n) => n.path === "BgImage",
    );
    expect(node?.rect).toEqual({ x: -328, y: -1, width: 2560, height: 100 });
    expect(node?.renderedRect.x).toBeCloseTo(-328, 4);
    expect(node?.renderedRect.y).toBeCloseTo(-1, 4);
    expect(node?.renderedRect.width).toBeCloseTo(2585.6, 4);
    expect(node?.renderedRect.height).toBeCloseTo(101, 4);
  });

  it("scales around a centered pivot (AncientBgContainer 16:9 case)", () => {
    // Full-bleed Control scaled 0.89 around its center pivot (960,540), with a
    // (0,40) position offset: reproduces NAncientBgContainer's runtime transform.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1920
offset_bottom = 1080
[node name="AncientBgContainer" type="Control" parent="."]
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
offset_top = 40
offset_bottom = 40
scale = Vector2(0.89, 0.89)
pivot_offset = Vector2(960, 540)
`);
    const node = resolveGodotSceneTree(scene).nodes.find(
      (n) => n.path === "AncientBgContainer",
    );
    expect(node?.rect).toEqual({ x: 0, y: 40, width: 1920, height: 1080 });
    // top-left = pos + pivot·(1 − scale) = (0,40) + (960,540)·0.11
    expect(node?.renderedRect.x).toBeCloseTo(105.6, 3);
    expect(node?.renderedRect.y).toBeCloseTo(99.4, 3);
    expect(node?.renderedRect.width).toBeCloseTo(1708.8, 3);
    expect(node?.renderedRect.height).toBeCloseTo(961.2, 3);
  });

  it("bakes a scaled ancestor's transform into a child's renderedRect", () => {
    // A child rect lives in the parent's unscaled local space; the parent's CSS
    // `transform: scale()` cascades to it, so the child's renderedRect must match
    // the live game's `get_global_rect()` = the parent's scale-about-pivot applied
    // to the child's own rect (the Neow cave TextureRect under AncientBgContainer).
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1920
offset_bottom = 1080
[node name="AncientBgContainer" type="Control" parent="."]
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
offset_top = 40
offset_bottom = 40
scale = Vector2(0.89, 0.89)
pivot_offset = Vector2(960, 540)
[node name="Cave" type="TextureRect" parent="AncientBgContainer"]
offset_left = -330
offset_top = -49
offset_right = 2252
offset_bottom = 1172
`);
    const cave = resolveGodotSceneTree(scene).nodes.find(
      (n) => n.path === "AncientBgContainer/Cave",
    );
    // Unscaled global rect: parent y-origin (40) + local offset (-49) = -9.
    expect(cave?.rect).toEqual({ x: -330, y: -9, width: 2582, height: 1221 });
    // Parent scales 0.89 about global pivot (960, 580): matches live get_global_rect.
    expect(cave?.renderedRect.x).toBeCloseTo(-188.1, 1);
    expect(cave?.renderedRect.y).toBeCloseTo(55.8, 1);
    expect(cave?.renderedRect.width).toBeCloseTo(2298.0, 1);
    expect(cave?.renderedRect.height).toBeCloseTo(1086.7, 1);
  });

  it("leaves a node's OWN rotation out of its own renderedRect (visual-only)", () => {
    // A node's own rotation is applied by the renderer as a CSS transform; it must
    // NOT move/resize the node's own renderedRect (preserving self-rotation parity
    // that the hand-card fan relies on). pivot 0 → get_global_rect keeps origin/size.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1920
offset_bottom = 1080
[node name="Card" type="TextureRect" parent="."]
offset_left = 100
offset_top = 200
offset_right = 300
offset_bottom = 500
rotation = -0.14
`);
    const node = resolveGodotSceneTree(scene).nodes.find(
      (n) => n.path === "Card",
    );
    expect(node?.renderedRect).toEqual(node?.rect);
    expect(node?.rect).toEqual({ x: 100, y: 200, width: 200, height: 300 });
  });

  it("rotates a child's renderedRect through a rotated parent (90deg)", () => {
    // Parent rotated +90deg about its origin (pivot 0). A child at local (100,0)
    // maps to global (0,100): rotate90·(100,0) = (0,100). Size is unchanged (the
    // parent has no scale). This is the foliage failure mode in miniature — ancestor
    // rotation must reach the child's origin.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1920
offset_bottom = 1080
[node name="Spin" type="Control" parent="."]
offset_right = 1920
offset_bottom = 1080
rotation = 1.5707963267948966
[node name="Leaf" type="TextureRect" parent="Spin"]
offset_left = 100
offset_top = 0
offset_right = 150
offset_bottom = 50
`);
    const leaf = resolveGodotSceneTree(scene).nodes.find(
      (n) => n.path === "Spin/Leaf",
    );
    // Unscaled local rect (parent origin 0 + offset): (100,0,50,50).
    expect(leaf?.rect).toEqual({ x: 100, y: 0, width: 50, height: 50 });
    // Parent's +90deg rotation about (0,0) carries the origin to (0,100); size kept.
    expect(leaf?.renderedRect.x).toBeCloseTo(0, 4);
    expect(leaf?.renderedRect.y).toBeCloseTo(100, 4);
    expect(leaf?.renderedRect.width).toBeCloseTo(50, 4);
    expect(leaf?.renderedRect.height).toBeCloseTo(50, 4);
  });

  it("resolves nested nodes whose parents use the live `./` NodePath form", () => {
    // A live producer reading `GetNodePath(…, for_parent=true)` emits parents with a
    // leading `./` (`./Panel`, `./Panel/Flow`) rather than the bare `.tscn` form. Before
    // normalization these never matched the parent's computed bare `path`, so the whole
    // nested subtree was silently dropped. The full tree must resolve.
    const state: GodotSceneState = {
      kind: "scene",
      nodes: [
        {
          index: 0,
          name: "Root",
          type: "Control",
          groups: [],
          properties: [
            { name: "offset_right", value: 200 },
            { name: "offset_bottom", value: 200 },
          ],
        },
        {
          index: 1,
          name: "Panel",
          type: "VBoxContainer",
          parent: ".",
          groups: [],
          properties: [],
        },
        {
          index: 2,
          name: "Flow",
          type: "VBoxContainer",
          parent: "./Panel",
          groups: [],
          properties: [],
        },
        {
          index: 3,
          name: "A",
          type: "ColorRect",
          parent: "./Panel/Flow",
          groups: [],
          properties: [
            {
              name: "custom_minimum_size",
              value: { type: "Vector2", args: [40, 30] },
            },
          ],
        },
      ],
      connections: [],
      extResources: [],
      subResources: [],
      editableInstances: [],
      diagnostics: [],
    };
    const tree = resolveGodotSceneTree(state);
    const paths = tree.nodes.map((node) => node.path);
    expect(paths).toContain("Panel");
    expect(paths).toContain("Panel/Flow");
    expect(paths).toContain("Panel/Flow/A");
    // The deepest node is attached to (not orphaned from) its computed parent.
    expect(
      tree.nodes.find((node) => node.path === "Panel/Flow/A")?.parentPath,
    ).toBe("Panel/Flow");
  });
});
