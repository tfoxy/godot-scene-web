import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type GodotSceneStateNode,
  isGodotSceneState,
} from "@godot-scene-web/core";
import { describe, expect, it } from "vitest";
import {
  parseGodotResource,
  parseGodotTextScene,
  parseGodotValue,
} from "../src/index";

function propertyMap(
  node: GodotSceneStateNode | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    (node?.properties ?? []).map((property) => [property.name, property.value]),
  );
}

describe("parseGodotTextScene", () => {
  it("preserves Godot-like node properties without deriving layout", () => {
    const state = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]

[ext_resource type="Texture2D" path="res://ui/panel.png" id="1"]

[node name="Root" type="Control"]
anchor_right = 1.0
anchor_bottom = 1.0

[node name="Panel" type="ColorRect" parent="."]
layout_mode = 1
anchors_preset = 15
offset_left = 10.0
offset_top = 20.0
color = Color(1, 0, 0, 1)
texture = ExtResource("1")
`);

    expect(state.kind).toBe("scene");
    expect(state.extResources[0]).toMatchObject({
      id: "1",
      type: "Texture2D",
      path: "res://ui/panel.png",
    });
    expect(state.nodes).toHaveLength(2);
    expect(propertyMap(state.nodes[1])).toMatchObject({
      layout_mode: 1,
      anchors_preset: 15,
      offset_left: 10,
      offset_top: 20,
      color: { type: "Color", args: [1, 0, 0, 1] },
      texture: { type: "ExtResource", id: "1" },
    });
    expect(propertyMap(state.nodes[1])).not.toHaveProperty("anchor_right");
  });

  it("emits a checked GodotSceneState golden with ordered raw properties", () => {
    const state = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]

[ext_resource type="Texture2D" path="res://ui/panel.png" id="1"]
[ext_resource type="PackedScene" path="res://button.tscn" id="Scene"]

[sub_resource type="StyleBoxFlat" id="PanelStyle"]
bg_color = Color(0.1, 0.2, 0.3, 1)

[node name="Root" type="Control"]
layout_mode = 3
anchors_preset = 15

[node name="Panel" type="ColorRect" parent="." owner="." groups=["ui", "debug"]]
offset_left = 10
offset_top = 20
color = Color(1, 0, 0, 1)
texture = ExtResource("1")

[node name="Instanced" parent="." instance=ExtResource("Scene") instance_placeholder="res://placeholder.tscn"]
text = "Hello"

[connection signal="pressed" from="Panel" to="." method="_on_pressed" flags=1 binds=[NodePath("Panel")] unbinds=0]
`);
    const expected = JSON.parse(
      readFileSync(
        resolve("packages/tscn-parser/test/goldens/basic-scene-state.json"),
        "utf8",
      ),
    );

    expect(isGodotSceneState(state)).toBe(true);
    expect(state).toEqual(expected);
    expect(state.nodes[1]?.properties.map((property) => property.name)).toEqual(
      ["offset_left", "offset_top", "color", "texture"],
    );
  });

  it("parses shared Godot values", () => {
    expect(
      parseGodotValue(
        `{"a": Vector2(1, 2), "b": [NodePath("../X"), SubResource("A")]}`,
      ),
    ).toEqual({
      a: { type: "Vector2", args: [1, 2] },
      b: [
        { type: "NodePath", args: ["../X"] },
        { type: "SubResource", id: "A" },
      ],
    });
  });

  it("parses resource sections for tres files", () => {
    const resource = parseGodotValue('ExtResource("1")');
    expect(resource).toEqual({ type: "ExtResource", id: "1" });

    const document = parseGodotResource(`
[gd_resource type="AtlasTexture" load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://atlas.png" id="1"]
[resource]
atlas = ExtResource("1")
region = Rect2(1, 2, 30, 40)
`);
    expect(document.type).toBe("AtlasTexture");
    expect(document.diagnostics).toEqual([]);
    expect(document.properties).toMatchObject({
      atlas: { type: "ExtResource", id: "1" },
      region: { type: "Rect2", args: [1, 2, 30, 40] },
    });
  });

  it("preserves multiline quoted strings and editable metadata", () => {
    const state = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
[node name="Text" type="RichTextLabel" parent="."]
text = "[b]Line one[/b]
Line two"
[editable path="Text"]
`);
    expect(state.diagnostics).toEqual([]);
    expect(propertyMap(state.nodes[1]).text).toBe("[b]Line one[/b]\nLine two");
    expect(state.editableInstances).toEqual(["Text"]);
  });

  it("parses multiline SpriteFrames arrays with StringName literals", () => {
    const state = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://frame.png" id="1"]
[sub_resource type="SpriteFrames" id="SpriteFrames_demo"]
animations = [{
"frames": [{
"duration": 1.0,
"texture": ExtResource("1")
}],
"loop": true,
"name": &"default",
"speed": 10.0
}]
[node name="Root" type="Control"]
`);
    expect(state.diagnostics).toEqual([]);
    expect(state.subResources[0]?.properties.animations).toEqual([
      {
        frames: [{ duration: 1, texture: { type: "ExtResource", id: "1" } }],
        loop: true,
        name: { type: "StringName", args: ["default"] },
        speed: 10,
      },
    ]);
  });

  it("parses StringName dictionary keys and typed array constructors", () => {
    const state = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
libraries = {
&"": SubResource("AnimationLibrary_empty"),
&"idle": SubResource("Animation_idle")
}
accessibility_controls_nodes = Array[NodePath]([])
`);
    expect(state.diagnostics).toEqual([]);
    expect(propertyMap(state.nodes[0]).libraries).toEqual({
      "": { type: "SubResource", id: "AnimationLibrary_empty" },
      idle: { type: "SubResource", id: "Animation_idle" },
    });
    expect(propertyMap(state.nodes[0]).accessibility_controls_nodes).toEqual({
      type: "Array[NodePath]",
      args: [[]],
    });
  });

  it("parses recovered VFX arrays without consuming closing brackets", () => {
    const state = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
particles = [NodePath("shiv"), NodePath("speck_burst"), null, null, null]
minion_textures = Array[Texture2D]([ExtResource("101_5usk3"), ExtResource("103_373df"), ExtResource("104_oiudl")])
minion_animations = Array[String](["idle", "rotating", "punch"])
points = PackedVector2Array(20, -135, 600, -150)
colors = PackedColorArray(1, 1, 1, 0, 1, 1, 1, 1)
`);
    expect(state.diagnostics).toEqual([]);
    const props = propertyMap(state.nodes[0]);
    expect(props.particles).toEqual([
      { type: "NodePath", args: ["shiv"] },
      { type: "NodePath", args: ["speck_burst"] },
      null,
      null,
      null,
    ]);
    expect(props.minion_textures).toEqual({
      type: "Array[Texture2D]",
      args: [
        [
          { type: "ExtResource", id: "101_5usk3" },
          { type: "ExtResource", id: "103_373df" },
          { type: "ExtResource", id: "104_oiudl" },
        ],
      ],
    });
    expect(props.minion_animations).toEqual({
      type: "Array[String]",
      args: [["idle", "rotating", "punch"]],
    });
    expect(props.points).toEqual({
      type: "PackedVector2Array",
      args: [20, -135, 600, -150],
    });
    expect(props.colors).toEqual({
      type: "PackedColorArray",
      args: [1, 1, 1, 0, 1, 1, 1, 1],
    });
  });
});
