import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSceneToHtmlModel } from "@godot-scene-web/html";
import { resolveGodotSceneTree as resolveSceneTreeFromGraph } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";

// Test shim: the rect engine now takes a SceneGraph (browser-native split moved
// structural indexing into deriveSceneGraph); keep the scene-taking call shape.
function resolveGodotSceneTree(scene, options) {
  return resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
}

import { GodotSceneView } from "@godot-scene-web/vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createGodotProjectResolver } from "../src/node";

describe("createGodotProjectResolver", () => {
  it("loads scenes, recursively mounts packed scenes, and resolves mounted resources", async () => {
    const projectRoot = join(
      tmpdir(),
      `godot-scene-web-project-${process.pid}-${Date.now()}`,
    );
    await mkdir(projectRoot, { recursive: true });
    try {
      await writeFile(
        join(projectRoot, "host.tscn"),
        `
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://child.tscn" id="1"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Host" parent="." instance=ExtResource("1")]
offset_right = 100
offset_bottom = 100
`,
        "utf8",
      );
      await writeFile(
        join(projectRoot, "child.tscn"),
        `
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://icon.png" id="tex"]
[node name="ChildRoot" type="Control"]
[node name="Icon" type="TextureRect" parent="."]
offset_right = 20
offset_bottom = 20
texture = ExtResource("tex")
`,
        "utf8",
      );

      const resolver = createGodotProjectResolver({
        projectRoot,
        assetBaseUrl: "/assets",
      });
      const scene = resolver.loadScene("res://host.tscn");
      const model = renderSceneToHtmlModel(
        resolveGodotSceneTree(scene, resolver.sceneOptions(scene)),
        resolver.sceneOptions(scene),
      );

      expect(model.nodes.find((node) => node.path === "Host")?.type).toBe(
        "Control",
      );
      const icon = model.nodes.find((node) => node.path === "Host/Icon");
      expect(icon?.attributes["data-godot-resource-path"]).toBe(
        "res://icon.png",
      );
      expect(icon?.selfStyle["background-image"]).toBe(
        'url("/assets/icon.png")',
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("passes project sceneOptions through Vue with generic path/name overrides", async () => {
    const projectRoot = join(
      tmpdir(),
      `godot-scene-web-project-vue-${process.pid}-${Date.now()}`,
    );
    await mkdir(projectRoot, { recursive: true });
    try {
      await writeFile(
        join(projectRoot, "host.tscn"),
        `
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://child.tscn" id="1"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Host" parent="." instance=ExtResource("1")]
offset_right = 100
offset_bottom = 100
`,
        "utf8",
      );
      await writeFile(
        join(projectRoot, "child.tscn"),
        `
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://icon-a.png" id="tex_a"]
[ext_resource type="Texture2D" path="res://icon-b.png" id="tex_b"]
[node name="ChildRoot" type="Control"]
[node name="Icon" type="TextureRect" parent="."]
offset_right = 20
offset_bottom = 20
texture = ExtResource("tex_a")
[node name="Count" type="Label" parent="."]
offset_top = 24
offset_right = 40
offset_bottom = 44
text = "0"
[node name="HiddenByName" type="Label" parent="."]
offset_top = 48
offset_right = 80
offset_bottom = 68
text = "visible"
`,
        "utf8",
      );

      const resolver = createGodotProjectResolver({
        projectRoot,
        assetBaseUrl: "/assets",
      });
      const scene = resolver.loadScene("res://host.tscn");
      const wrapper = mount(GodotSceneView, {
        props: {
          scene,
          options: resolver.sceneOptions(scene),
          nodeOverrides: {
            "Host/Icon": { texture: { type: "ExtResource", id: "tex_b" } },
            "Host/Count": { text: "7" },
          },
          nodeNameOverrides: {
            HiddenByName: { visible: false },
          },
        },
      });

      expect(
        wrapper
          .find('[data-godot-path="Host/Icon"]')
          .attributes("data-godot-resource-path"),
      ).toBe("res://icon-b.png");
      expect(wrapper.find('[data-godot-path="Host/Count"]').text()).toBe("7");
      // The name-overridden hidden node is pruned to a comment placeholder.
      expect(
        wrapper.find('[data-godot-path="Host/HiddenByName"]').exists(),
      ).toBe(false);
      expect(wrapper.html()).toContain(
        "<!--godot:hidden Host/HiddenByName (Label)-->",
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("resolves atlas textures, image sizes, and chained FontVariation resources", async () => {
    const projectRoot = join(
      tmpdir(),
      `godot-scene-web-project-resources-${process.pid}-${Date.now()}`,
    );
    await mkdir(join(projectRoot, "fonts"), { recursive: true });
    try {
      await writeFile(
        join(projectRoot, "host.tscn"),
        `
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://atlas_icon.tres" id="tex"]
[ext_resource type="FontVariation" path="res://font_gap.tres" id="font"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Icon" type="TextureRect" parent="."]
texture = ExtResource("tex")
[node name="Label" type="Label" parent="."]
offset_top = 10
offset_right = 80
offset_bottom = 30
theme_override_fonts/font = ExtResource("font")
theme_override_font_sizes/font_size = 18
theme_override_constants/outline_size = 2
text = "Atlas"
`,
        "utf8",
      );
      await writeFile(
        join(projectRoot, "atlas_icon.tres"),
        `
[gd_resource type="AtlasTexture" load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://atlas.png" id="1"]
[resource]
atlas = ExtResource("1")
region = Rect2(4, 5, 6, 7)
`,
        "utf8",
      );
      await writeFile(
        join(projectRoot, "font_gap.tres"),
        `
[gd_resource type="FontVariation" load_steps=2 format=3]
[ext_resource type="FontVariation" path="res://font_shared.tres" id="base"]
[resource]
base_font = ExtResource("base")
spacing_glyph = 2
`,
        "utf8",
      );
      await writeFile(
        join(projectRoot, "font_shared.tres"),
        `
[gd_resource type="FontVariation" load_steps=2 format=3]
[ext_resource type="FontFile" path="res://font_file.tres" id="base"]
[resource]
base_font = ExtResource("base")
`,
        "utf8",
      );
      await writeFile(
        join(projectRoot, "font_file.tres"),
        `
[gd_resource type="FontFile" format=3]
[resource]
font_path = "res://fonts/example_bold.ttf"
multichannel_signed_distance_field = true
`,
        "utf8",
      );
      await writeFile(join(projectRoot, "fonts/example_bold.ttf"), "", "utf8");
      await writeFile(join(projectRoot, "atlas.png"), pngHeader(16, 8));

      const resolver = createGodotProjectResolver({
        projectRoot,
        assetBaseUrl: "/assets",
      });
      const scene = resolver.loadScene("res://host.tscn");
      const model = renderSceneToHtmlModel(
        resolveGodotSceneTree(scene, resolver.sceneOptions(scene)),
        resolver.sceneOptions(scene),
      );
      const icon = model.nodes.find((node) => node.path === "Icon");
      const label = model.nodes.find((node) => node.path === "Label");

      expect(icon?.attributes["data-godot-resource-path"]).toBe(
        "res://atlas.png",
      );
      // An EXTERNAL atlas page (`/assets/atlas.png`) can't be embedded in a CSS-image
      // SVG (browsers block external `<image href>` refs there → blank), so the region
      // is painted by shifting the CSS viewport over the stable atlas URL instead of
      // baking a standalone SVG sprite. Keep the region for the offset math.
      expect(icon?.attributes["data-godot-atlas-region"]).toBe("4,5,6,7");
      const iconImage = icon?.selfStyle["background-image"] ?? "";
      expect(iconImage).toContain("/assets/atlas.png");
      expect(iconImage).not.toContain("data:image/svg");
      expect(icon?.selfStyle["background-position"]).toBe("-4px -5px");
      expect(icon?.style.width).toBe("6px");
      expect(icon?.style.height).toBe("7px");
      expect(label?.attributes["data-godot-font-family"]).toBe("example_bold");
      expect(label?.selfStyle["--godot-rich-letter-spacing"]).toBe("1.5px");
      expect(label?.selfStyle["-webkit-text-stroke"]).toBe(
        "2px rgba(0, 0, 0, 1)",
      );
      expect(model.fontFaces).toEqual([
        {
          fontFamily: "example_bold",
          style: "normal",
          weight: "700",
          url: "/assets/fonts/example_bold.ttf",
        },
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
