import type {
  GodotResourceRefValue,
  GodotVariant,
} from "@godot-scene-web/core";
import { resolveGodotSceneTree as resolveSceneTreeFromGraph } from "@godot-scene-web/layout";
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
import { colorMatrixFeValues } from "../src/css-values";
import type {
  GodotHtmlModel,
  GodotHtmlNode,
  GodotShaderLoadingFallback,
} from "../src/index";
import { renderSceneToHtmlModel as renderTreeToHtmlModel } from "../src/index";
import { applyHsv, hsvColorMatrix } from "../src/material";

// An external (non-`data:`) texture is tinted via a CSS `filter: url(#id)` color
// matrix rather than a baked `<image>` SVG (which browsers won't rasterize from a
// CSS background). This reads back the feColorMatrix values the node references —
// these scenes model the live presentation glue, whose `/api/asset` URLs are
// external — so it is the analogue of the old "values baked into the SVG" check.
function tintFilterValues(
  model: GodotHtmlModel,
  node: GodotHtmlNode | undefined,
): string | undefined {
  const id = node?.selfStyle.filter?.match(/url\(#([^)]+)\)/)?.[1];
  const markup = model.tintFilters.find((filter) => filter.id === id)?.markup;
  return markup?.match(/values="([^"]+)"/)?.[1];
}

const HSV_SCENE = `
[gd_scene load_steps=6 format=3]
[ext_resource type="Shader" path="res://shaders/hsv.gdshader" id="shader"]
[ext_resource type="Texture2D" path="res://icon.png" id="tex"]
[sub_resource type="ShaderMaterial" id="dim"]
shader = ExtResource("shader")
shader_parameter/h = 1.0
shader_parameter/s = 1.0
shader_parameter/v = 0.9
[sub_resource type="ShaderMaterial" id="identity"]
shader = ExtResource("shader")
shader_parameter/h = 1.0
shader_parameter/s = 1.0
shader_parameter/v = 1.0
[sub_resource type="ShaderMaterial" id="hue"]
shader = ExtResource("shader")
shader_parameter/h = 0.5
shader_parameter/s = 1.0
shader_parameter/v = 1.0
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Dim" type="TextureRect" parent="."]
offset_right = 64
offset_bottom = 64
material = SubResource("dim")
texture = ExtResource("tex")
[node name="Identity" type="TextureRect" parent="."]
offset_top = 64
offset_right = 64
offset_bottom = 128
material = SubResource("identity")
texture = ExtResource("tex")
[node name="Hue" type="TextureRect" parent="."]
offset_top = 128
offset_right = 64
offset_bottom = 192
material = SubResource("hue")
texture = ExtResource("tex")
`;

// A shader whose ExtResource carries only a uid (no path) — exercising uid-based
// identification of hsv.gdshader.
const HSV_UID_SCENE = `
[gd_scene load_steps=3 format=3]
[ext_resource type="Shader" uid="uid://c66gb6g7tup3n" id="shader"]
[ext_resource type="Texture2D" path="res://icon.png" id="tex"]
[sub_resource type="ShaderMaterial" id="dim"]
shader = ExtResource("shader")
shader_parameter/v = 0.9
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Dim" type="TextureRect" parent="."]
offset_right = 64
offset_bottom = 64
material = SubResource("dim")
texture = ExtResource("tex")
`;

// `shaderResolves: false` reproduces the live presentation glue, where a Shader
// ExtResource resolves to `undefined` (shaders are not bundled assets) so the
// only signal is the material document's ext-resource table.
function renderScene(
  sceneText = HSV_SCENE,
  {
    shaderResolves = true,
    enableWebglShaders = false,
    overrideNodeProps,
    shaderLoadingFallbacksByPath,
    webglShaderIds,
    hsvAdjustShaderIds,
    hiddenRawShaderFallbacksByPath,
    hiddenRawShaderFallbackShaderIds,
    shaderFallbackFiltersByPath,
  }: {
    shaderResolves?: boolean;
    enableWebglShaders?: boolean;
    overrideNodeProps?: (
      node: unknown,
      path: string,
    ) => Record<string, GodotVariant> | undefined;
    shaderLoadingFallbacksByPath?: Record<string, GodotShaderLoadingFallback>;
    webglShaderIds?: string[];
    hsvAdjustShaderIds?: string[];
    hiddenRawShaderFallbacksByPath?: Record<string, boolean>;
    hiddenRawShaderFallbackShaderIds?: string[];
    shaderFallbackFiltersByPath?: Record<string, string>;
  } = {},
) {
  const scene = parseGodotTextScene(sceneText);
  const resolveResource = (ref: GodotResourceRefValue) => {
    if (ref.type === "ExtResource") {
      const ext = scene.extResources.find(
        (candidate) => candidate.id === ref.id,
      );
      if (ext?.type === "Texture2D") {
        return {
          path: ext.path ?? "res://icon.png",
          url:
            ext.id === "noise1"
              ? "/noise1.png"
              : ext.id === "noise2"
                ? "/noise2.png"
                : "/icon.png",
          size: { width: 64, height: 64 },
        };
      }
      if (ext?.type === "Shader") {
        return shaderResolves ? ext : undefined;
      }
      return ext;
    }
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
  const tree = resolveGodotSceneTree(scene, {
    resolveResource,
    overrideNodeProps,
  });
  return renderTreeToHtmlModel(tree, {
    resolveResource,
    enableWebglShaders,
    shaderLoadingFallbacksByPath,
    webglShaderIds,
    hsvAdjustShaderIds,
    hiddenRawShaderFallbacksByPath,
    hiddenRawShaderFallbackShaderIds,
    shaderFallbackFiltersByPath,
  });
}

// The HSV color-adjust shader id the test scenes use (path + uid). Threaded as
// `hsvAdjustShaderIds` so godot-scene-web bakes the static feColorMatrix tint — it
// no longer hardcodes the shader name.
const HSV_ADJUST_IDS = ["res://shaders/hsv.gdshader", "uid://c66gb6g7tup3n"];

function renderHsvScene() {
  return renderScene(HSV_SCENE, { hsvAdjustShaderIds: HSV_ADJUST_IDS });
}

describe("hsv.gdshader material tint", () => {
  it("renders h=1,s=1,v=0.9 as an alpha-preserving feColorMatrix tint on a TextureRect", () => {
    const model = renderHsvScene();
    const dim = model.nodes.find((node) => node.path === "Dim");
    expect(dim?.selfAttributes["data-godot-shader-tint"]).toBe("hsv");
    // feColorMatrix (not background-color + multiply): a per-channel RGB scale
    // that preserves the texture's alpha, so anti-aliased edges do not get a gray
    // halo. The diagonal dims every channel to 0.9 (~10% darker). The external
    // `/icon.png` URL is tinted via a `filter: url(#id)` color matrix on the self
    // layer, leaving the plain background-image untouched.
    expect(dim?.selfAttributes["data-godot-texture-tint"]).toBe("css-filter");
    expect(dim?.selfStyle["background-blend-mode"]).toBeUndefined();
    expect(dim?.selfStyle["background-color"]).toBeUndefined();
    expect(dim?.selfStyle["background-image"]).toBe('url("/icon.png")');
    const expected = colorMatrixFeValues(hsvColorMatrix(1, 1, 0.9));
    expect(expected).toBe("0.9 0 0 0 0 0 0.9 0 0 0 0 0 0.9 0 0 0 0 0 1 0");
    expect(tintFilterValues(model, dim)).toBe(expected);
  });

  it("leaves the identity material (v=1.0) untouched (guards ControllerIcon)", () => {
    const model = renderHsvScene();
    const identity = model.nodes.find((node) => node.path === "Identity");
    expect(identity?.selfAttributes["data-godot-shader-tint"]).toBeUndefined();
    expect(identity?.selfAttributes["data-godot-texture-tint"]).toBeUndefined();
    expect(identity?.selfStyle["background-blend-mode"]).toBeUndefined();
    expect(identity?.selfStyle["background-color"]).toBeUndefined();
    expect(identity?.selfStyle["background-image"]).toBe('url("/icon.png")');
  });

  it("bakes a non-diagonal hue shift into an SVG feColorMatrix", () => {
    const model = renderHsvScene();
    const hue = model.nodes.find((node) => node.path === "Hue");
    expect(hue?.selfAttributes["data-godot-shader-tint"]).toBe("hsv");
    expect(hue?.selfAttributes["data-godot-texture-tint"]).toBe("css-filter");
    expect(hue?.selfStyle["background-blend-mode"]).toBeUndefined();
    expect(hue?.selfStyle["background-image"]).toBe('url("/icon.png")');
    // The rendered matrix must equal an independent evaluation of the GLSL port.
    const expected = colorMatrixFeValues(hsvColorMatrix(0.5, 1, 1));
    expect(tintFilterValues(model, hue)).toBe(expected);
  });
});

// Regression for the live presentation glue: a Shader ExtResource resolves to
// `undefined` there (shaders are not bundled assets), so the shader must be
// identified from the material document's ext-resource table (path or uid).
describe("hsv.gdshader identification without a resolvable shader resource", () => {
  const dimValues = colorMatrixFeValues(hsvColorMatrix(1, 1, 0.9));

  it("recognizes the shader via the ext-resource path when resolveResource returns nothing", () => {
    const model = renderScene(HSV_SCENE, {
      shaderResolves: false,
      hsvAdjustShaderIds: HSV_ADJUST_IDS,
    });
    const dim = model.nodes.find((node) => node.path === "Dim");
    expect(dim?.selfAttributes["data-godot-shader-tint"]).toBe("hsv");
    expect(dim?.selfAttributes["data-godot-texture-tint"]).toBe("css-filter");
    expect(tintFilterValues(model, dim)).toBe(dimValues);
  });

  it("recognizes the shader via uid when the ext-resource has no path", () => {
    const model = renderScene(HSV_UID_SCENE, {
      shaderResolves: false,
      hsvAdjustShaderIds: HSV_ADJUST_IDS,
    });
    const dim = model.nodes.find((node) => node.path === "Dim");
    expect(dim?.selfAttributes["data-godot-shader-tint"]).toBe("hsv");
    expect(dim?.selfAttributes["data-godot-texture-tint"]).toBe("css-filter");
    expect(tintFilterValues(model, dim)).toBe(dimValues);
  });

  // "Run every shader on WebGL" (`webglShaderIds: ["*"]`) must NOT drag the HSV family onto the WebGL
  // runtime — HSV stays the sanctioned feColorMatrix tint. Otherwise an HSV node gets a double paint (a
  // WebGL canvas AND the feColorMatrix filter). This is what lets a consumer enable every shader generically.
  it("keeps an HSV shader on the feColorMatrix path even under a webglShaderIds wildcard", () => {
    const model = renderScene(HSV_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
      hsvAdjustShaderIds: HSV_ADJUST_IDS,
    });
    const dim = model.nodes.find((node) => node.path === "Dim");
    expect(dim?.selfAttributes["data-godot-shader-webgl"]).toBeUndefined();
    expect(dim?.selfAttributes["data-godot-shader-tint"]).toBe("hsv");
  });
});

// A TextureRect of a card-silhouette SDF with a `card_ripple.gdshader` material and
// a cyan `modulate` — a representative ShaderMaterial node. gsw treats it generically:
// it activates the WebGL runtime when the shader is opted in (`webglShaderIds`) and
// applies a consumer-supplied static fallback filter (`shaderFallbackFiltersByPath`)
// otherwise. gsw no longer hardcodes this shader's name, blend, or glow.
const CARD_RIPPLE_SCENE = `
[gd_scene load_steps=3 format=3]
[ext_resource type="Shader" path="res://shaders/card_ripple.gdshader" id="shader"]
[ext_resource type="Texture2D" path="res://icon.png" id="tex"]
[sub_resource type="ShaderMaterial" id="ripple"]
shader = ExtResource("shader")
shader_parameter/width = 0.075
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Highlight" type="TextureRect" parent="."]
offset_right = 64
offset_bottom = 64
modulate = Color(0, 0.957, 0.988, 0.98)
material = SubResource("ripple")
texture = ExtResource("tex")
`;

// As above but the Shader ExtResource carries only a uid (no path), matching the
// live glue where shaders are not bundled assets.
const CARD_RIPPLE_UID_SCENE = `
[gd_scene load_steps=3 format=3]
[ext_resource type="Shader" uid="uid://bikvsfwlbp43n" id="shader"]
[ext_resource type="Texture2D" path="res://icon.png" id="tex"]
[sub_resource type="ShaderMaterial" id="ripple"]
shader = ExtResource("shader")
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Highlight" type="TextureRect" parent="."]
offset_right = 64
offset_bottom = 64
modulate = Color(0, 0.957, 0.988, 0.98)
material = SubResource("ripple")
texture = ExtResource("tex")
`;

const SCRY_REVEAL_SCENE = `
[gd_scene load_steps=5 format=3]
[ext_resource type="Shader" path="res://shaders/scry_reveal.gdshader" id="shader"]
[ext_resource type="Texture2D" path="res://images/vfx/crystal_sphere_noise.png" id="noise1"]
[ext_resource type="Texture2D" path="res://images/vfx/scry_voronoi_noise.png" id="noise2"]
[sub_resource type="ShaderMaterial" id="scry"]
shader = ExtResource("shader")
shader_parameter/noiseTex1 = ExtResource("noise1")
shader_parameter/noiseTex2 = ExtResource("noise2")
shader_parameter/colors = PackedColorArray(0.12549, 0.0431373, 0.411765, 1, 0.164706, 0.0980392, 0.745098, 1, 0.305882, 0.243137, 0.882353, 1, 0.313726, 0.286275, 0.929412, 1, 0.396078, 0.337255, 0.972549, 1, 0.541176, 0.556863, 0.980392, 1, 0.839216, 0.870588, 0.980392, 1, 0.952941, 1, 1, 1)
shader_parameter/circleData = PackedVector4Array(0, 1.04, 0.065, 0.315, 0.495, 0.3, 0.2, 0.42)
shader_parameter/gridFadeParams = PackedVector3Array(0, 0, 0, 0, 0, 0, 0, 0, 0)
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Sphere" type="ColorRect" parent="."]
offset_right = 64
offset_bottom = 64
material = SubResource("scry")
`;

const UNSUPPORTED_COLORRECT_SHADER_SCENE = `
[gd_scene load_steps=3 format=3]
[ext_resource type="Shader" path="res://shaders/unknown.gdshader" id="shader"]
[sub_resource type="ShaderMaterial" id="mat"]
shader = ExtResource("shader")
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Panel" type="ColorRect" parent="."]
offset_right = 64
offset_bottom = 64
material = SubResource("mat")
`;

const AFFLICTION_SHADER_SCENE = `
[gd_scene load_steps=8 format=3]
[ext_resource type="Shader" path="res://shaders/vfx/ui/card/afflictions/galvanized/vfx_ui_card_affliction_galvanized_main_shader.gdshader" id="shader"]
[ext_resource type="Texture2D" path="res://images/vfx/ui/card/afflictions/galvanized/ui_card_galvanized_main.png" id="tex"]
[sub_resource type="Gradient" id="Gradient_lut"]
colors = PackedColorArray(0.23, 0.8075, 1, 0, 0.82, 0.964, 1, 0.2509804)
[sub_resource type="GradientTexture1D" id="GradientTexture_lut"]
gradient = SubResource("Gradient_lut")
[sub_resource type="ShaderMaterial" id="affliction"]
shader = ExtResource("shader")
shader_parameter/blink_st = Vector4(0, 1, 0.6, 0)
shader_parameter/blink_smoothstep = Vector2(0.625, 0.25)
shader_parameter/lut = SubResource("GradientTexture_lut")
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 422
[node name="Affliction" type="TextureRect" parent="."]
offset_right = 300
offset_bottom = 422
texture_repeat = 2
texture = ExtResource("tex")
material = SubResource("affliction")
expand_mode = 2
stretch_mode = 5
`;

const AFFLICTION_BOUND_SHADER_SCENE = `
[gd_scene load_steps=5 format=3]
[ext_resource type="Shader" path="res://shaders/vfx/ui/card/afflictions/bound/vfx_ui_card_affliction_bound_main_shader.gdshader" id="shader"]
[ext_resource type="Texture2D" path="res://images/vfx/ui/card/afflictions/bound/ui_card_bound_main.png" id="tex"]
[sub_resource type="ShaderMaterial" id="bound"]
shader = ExtResource("shader")
shader_parameter/bright_st = Vector4(0, 0, 0.5, 0)
shader_parameter/bright_energy = 1.5
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 422
[node name="BoundMain" type="TextureRect" parent="."]
offset_right = 300
offset_bottom = 422
texture_repeat = 2
texture = ExtResource("tex")
material = SubResource("bound")
expand_mode = 1
stretch_mode = 5
`;

const AFFLICTION_ENTANGLED_MAIN_SHADER_SCENE = `
[gd_scene load_steps=8 format=3]
[ext_resource type="Shader" path="res://shaders/vfx/ui/card/afflictions/entangled/vfx_ui_card_affliction_entangled_main_shader.gdshader" id="shader"]
[ext_resource type="Texture2D" path="res://images/vfx/ui/card/afflictions/entangled/ui_card_entangled_main.png" id="tex"]
[sub_resource type="Gradient" id="Gradient_vine"]
offsets = PackedFloat32Array(0, 1)
colors = PackedColorArray(0, 0, 0, 1, 0.047058824, 0.57254905, 0.50980395, 1)
[sub_resource type="GradientTexture1D" id="GradientTexture_vine"]
gradient = SubResource("Gradient_vine")
[sub_resource type="ShaderMaterial" id="entangled"]
shader = ExtResource("shader")
shader_parameter/distortion_st = Vector4(1, 1, 0, 0.175)
shader_parameter/distortion_intensity = 0.018
shader_parameter/vine_lut = SubResource("GradientTexture_vine")
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 422
[node name="EntangledMain" type="TextureRect" parent="."]
offset_right = 300
offset_bottom = 422
texture_repeat = 2
texture = ExtResource("tex")
material = SubResource("entangled")
expand_mode = 1
stretch_mode = 5
`;

const AFFLICTION_ENTANGLED_LEAF_PARTICLE_SCENE = `
[gd_scene load_steps=5 format=3]
[ext_resource type="Shader" path="res://shaders/vfx/ui/card/afflictions/entangled/vfx_ui_card_affliction_entangled_leaf_shader.gdshader" id="shader"]
[ext_resource type="Texture2D" path="res://images/vfx/ui/card/afflictions/entangled/ui_card_entangled_leaf.png" id="tex"]
[sub_resource type="ShaderMaterial" id="leaf"]
shader = ExtResource("shader")
shader_parameter/pivot_offset = Vector2(0, -0.3)
shader_parameter/rotation_offset = Vector2(0.5, 0.8)
shader_parameter/rotation_st = Vector4(0, 0, 0, 0.1)
shader_parameter/rotation_range = 0.35
[node name="Root" type="Control"]
offset_right = 128
offset_bottom = 128
[node name="EntangledLeaf" type="GPUParticles2D" parent="."]
material = SubResource("leaf")
amount = 1
texture = ExtResource("tex")
lifetime = 600.0
fixed_fps = 60
`;

const AFFLICTION_RINGING_SAMPLER_SCENE = `
[gd_scene load_steps=8 format=3]
[ext_resource type="Shader" path="res://shaders/vfx/ui/card/afflictions/ringing/vfx_ui_card_affliction_ringing_main_shader.gdshader" id="shader"]
[ext_resource type="Texture2D" path="res://images/vfx/ui/card/afflictions/ringing/ui_card_ringing_main.png" id="tex"]
[sub_resource type="Curve" id="Curve_x"]
_data = [Vector2(0, 0.1), 0.0, 0.0, 0, 0, Vector2(1, 0.3), 0.0, 0.0, 0, 0]
point_count = 2
[sub_resource type="Curve" id="Curve_y"]
_data = [Vector2(0, 0.2), 0.0, 0.0, 0, 0, Vector2(1, 0.4), 0.0, 0.0, 0, 0]
point_count = 2
[sub_resource type="Curve" id="Curve_z"]
_data = [Vector2(0, 0.3), 0.0, 0.0, 0, 0, Vector2(1, 0.5), 0.0, 0.0, 0, 0]
point_count = 2
[sub_resource type="CurveXYZTexture" id="CurveXYZTexture_alpha"]
curve_x = SubResource("Curve_x")
curve_y = SubResource("Curve_y")
curve_z = SubResource("Curve_z")
[sub_resource type="ShaderMaterial" id="ringing"]
shader = ExtResource("shader")
shader_parameter/ring_base_alpha = SubResource("CurveXYZTexture_alpha")
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 422
[node name="Ringing" type="TextureRect" parent="."]
offset_right = 300
offset_bottom = 422
texture = ExtResource("tex")
material = SubResource("ringing")
expand_mode = 2
stretch_mode = 4
`;

const TEXTURE_RECT_CLIP_CHILDREN_SCENE = `
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://images/vfx/ui/ui_card_mask.png" id="mask"]
[ext_resource type="Texture2D" path="res://icon.png" id="child"]
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 422
[node name="Mask" type="TextureRect" parent="."]
clip_children = 1
offset_right = 300
offset_bottom = 422
texture = ExtResource("mask")
expand_mode = 1
stretch_mode = 4
[node name="Child" type="TextureRect" parent="Mask"]
offset_right = 300
offset_bottom = 422
texture = ExtResource("child")
`;

function glowFilterMarkup(
  model: GodotHtmlModel,
  node: GodotHtmlNode | undefined,
): string | undefined {
  const id = node?.selfStyle.filter?.match(/url\(#([^)]+)\)/)?.[1];
  return model.tintFilters.find((filter) => filter.id === id)?.markup;
}

describe("WebGL ShaderMaterial activation + consumer static-fallback filter", () => {
  it("flags the node + emits the live WebGL runtime inputs only under enableWebglShaders", () => {
    // Off by default: no WebGL attributes (the static fallback path is unchanged).
    const off = renderScene(CARD_RIPPLE_SCENE);
    const offNode = off.nodes.find((node) => node.path === "Highlight");
    expect(offNode?.attributes["data-godot-shader-webgl"]).toBeUndefined();

    // On: the node is flagged, params carry the material's `width`, the modulate is
    // the cyan glow color, and the self-layer exposes the RAW texture url for the
    // runtime. (gsw no longer knows this shader by name — it is opted in by id.)
    const on = renderScene(CARD_RIPPLE_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
    });
    const node = on.nodes.find((n) => n.path === "Highlight");
    expect(node?.attributes["data-godot-shader-webgl"]).toBe("1");
    expect(node?.attributes["data-godot-shader-path"]).toContain("card_ripple");
    const params = JSON.parse(
      node?.attributes["data-godot-shader-params"] ?? "{}",
    );
    expect(params).toMatchObject({ width: 0.075 });
    expect(node?.attributes["data-godot-shader-modulate"]).toBe(
      "0,0.957,0.988,0.98",
    );
    expect(node?.selfAttributes["data-godot-shader-texture-url"]).toBe(
      "/icon.png",
    );
  });

  // Regression: neow's `water_reflection` quads — a Sprite2D whose shader is on the
  // consumer's hidden-raw-fallback list. Hiding the raw fallback deletes the
  // self-layer `background-image`, which used to be the runtime's ONLY texture
  // source: after the shader canvas mounted (which also clears that background), a
  // reconcile re-read yielded null and `TEXTURE` silently rebound to the solid-WHITE
  // placeholder. Every texture-gated term then saturated (light.png's radial
  // falloff gate read 1.0 everywhere) and the additive shader flooded the whole
  // ~3200×3072 quad with a hard-edged teal wash — visible rotated seams across the
  // frame. The Sprite2D path must therefore ALWAYS publish
  // `data-godot-shader-texture-url`, which the runtime prefers over the (deleted)
  // background-image.
  it("keeps the Sprite2D TEXTURE url when the raw shader fallback is hidden", () => {
    const WATER_REFLECTION_SCENE = `
[gd_scene load_steps=3 format=3]
[ext_resource type="Shader" path="res://shaders/vfx/vfx_stepped_shader_fire_add.tres" id="shader"]
[ext_resource type="Texture2D" path="res://images/vfx/light.png" id="tex"]
[sub_resource type="ShaderMaterial" id="water"]
shader = ExtResource("shader")
shader_parameter/InvertNoiseMask = true
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="water_reflection2" type="Sprite2D" parent="."]
position = Vector2(268, 878)
rotation = -0.47473
scale = Vector2(12.5, 12)
material = SubResource("water")
texture = ExtResource("tex")
`;
    const model = renderScene(WATER_REFLECTION_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
      hiddenRawShaderFallbackShaderIds: [
        "res://shaders/vfx/vfx_stepped_shader_fire_add.tres",
      ],
    });
    const node = model.nodes.find((n) => n.path === "water_reflection2");
    expect(node?.attributes["data-godot-shader-webgl"]).toBe("1");
    // The critical contract: the raw texture url survives the hidden fallback, so
    // the runtime binds light.png (the radial gate) instead of solid white.
    expect(node?.selfAttributes["data-godot-shader-texture-url"]).toBe(
      "/icon.png",
    );
    expect(node?.selfAttributes["data-godot-shader-raw-fallback"]).toBe(
      "hidden",
    );
    expect(node?.selfStyle["background-image"]).toBeUndefined();
  });

  // Regression: a `uniform bool` shader param (neow's water_reflection
  // `InvertNoiseMask = true`) is authored as a boolean, which `shaderParams` used to
  // DROP (numbers only) — the runtime then uploaded the 0 fallback, silently flipping
  // the toggle and turning the thin masked shimmer into a full-quad additive wash.
  it("serializes boolean shader params as 0/1 in data-godot-shader-params", () => {
    const BOOL_PARAM_SCENE = `
[gd_scene load_steps=3 format=3]
[ext_resource type="Shader" path="res://shaders/vfx/vfx_stepped_shader_fire_add.tres" id="shader"]
[ext_resource type="Texture2D" path="res://images/vfx/light.png" id="tex"]
[sub_resource type="ShaderMaterial" id="water"]
shader = ExtResource("shader")
shader_parameter/InvertNoiseMask = true
shader_parameter/UseOuterColor = false
shader_parameter/Noise1Strength = 1.0
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Reflection" type="TextureRect" parent="."]
offset_right = 64
offset_bottom = 64
material = SubResource("water")
texture = ExtResource("tex")
`;
    const model = renderScene(BOOL_PARAM_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
    });
    const node = model.nodes.find((n) => n.path === "Reflection");
    expect(node?.attributes["data-godot-shader-webgl"]).toBe("1");
    const params = JSON.parse(
      node?.attributes["data-godot-shader-params"] ?? "{}",
    );
    expect(params.InvertNoiseMask).toBe(1);
    expect(params.UseOuterColor).toBe(0);
    expect(params.Noise1Strength).toBe(1);
  });

  it("applies a consumer-supplied static fallback filter via shaderFallbackFiltersByPath", () => {
    // The consumer owns the SVG primitives + any baked colors (e.g. an animated
    // glow approximating an un-runnable shader); godot-scene-web just registers the
    // inner markup in its shared filter defs and references it on the node.
    const markup =
      '<feColorMatrix type="luminanceToAlpha" result="sdf"/>' +
      '<feFlood flood-color="rgba(0, 244, 252, 0.98)" result="ink"/>' +
      '<feComposite in="ink" in2="sdf" operator="in"/>';
    const model = renderScene(CARD_RIPPLE_SCENE, {
      shaderFallbackFiltersByPath: { Highlight: markup },
    });
    const node = model.nodes.find((n) => n.path === "Highlight");
    expect(node?.selfAttributes["data-godot-texture-tint"]).toBe(
      "shader-fallback-filter",
    );
    expect(node?.selfStyle["background-image"]).toBe('url("/icon.png")');
    expect(node?.selfStyle.filter).toMatch(/url\(#[^)]+\)/);
    // The consumer's inner markup is emitted verbatim in the shared filter defs and
    // referenced by the node's `filter: url(#id)`.
    expect(glowFilterMarkup(model, node)).toBe(markup);
  });
});

describe("generic WebGL ShaderMaterial rendering", () => {
  it("does not activate ShaderMaterial nodes unless they are explicitly opted in", () => {
    const model = renderScene(SCRY_REVEAL_SCENE, { enableWebglShaders: true });
    const sphere = model.nodes.find((node) => node.path === "Sphere");

    expect(sphere?.attributes["data-godot-shader-webgl"]).toBeUndefined();
    expect(sphere?.selfAttributes["data-godot-shader-colorrect-fallback"]).toBe(
      "transparent",
    );
  });

  it("activates WebGL, preserves packed array metadata, loads ExtResource samplers, and avoids white ColorRect fallback", () => {
    const model = renderScene(SCRY_REVEAL_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
    });
    const sphere = model.nodes.find((node) => node.path === "Sphere");

    expect(sphere?.attributes["data-godot-shader-webgl"]).toBe("1");
    expect(sphere?.attributes["data-godot-shader-path"]).toContain(
      "scry_reveal",
    );
    expect(sphere?.selfAttributes["data-godot-shader-colorrect-fallback"]).toBe(
      "transparent",
    );
    expect(sphere?.selfStyle.background).toBeUndefined();

    const params = JSON.parse(
      sphere?.attributes["data-godot-shader-params"] ?? "{}",
    );
    expect(params.colors).toHaveLength(8 * 4);
    expect(params.circleData).toHaveLength(8);
    expect(params.gridFadeParams).toHaveLength(9);

    const kinds = JSON.parse(
      sphere?.attributes["data-godot-shader-param-kinds"] ?? "{}",
    );
    expect(kinds.colors).toBe("PackedColorArray");
    expect(kinds.circleData).toBe("PackedVector4Array");
    expect(kinds.gridFadeParams).toBe("PackedVector3Array");

    const samplerUrls = JSON.parse(
      sphere?.attributes["data-godot-shader-sampler-urls"] ?? "{}",
    );
    expect(samplerUrls).toEqual({
      noiseTex1: "/noise1.png",
      noiseTex2: "/noise2.png",
    });
  });

  // Regression: a sampler bound to an external texture whose ExtResource id lives in
  // a SEPARATE material .tres (not the scene). Resolving the bare id against the
  // node's scene fails — the id indexes the material document's own ext-resource
  // table — so the URL must be looked up via that table's path first. Mirrors the
  // smog affliction's card-shape `mask` sampler, which was dropped (left unbound and
  // reading texture unit 0, painting an opaque rect over the card).
  it("emits sampler URLs for material-internal ExtResource textures (separate .tres)", () => {
    const MASK_PATH =
      "res://images/vfx/ui/card/afflictions/smog/ui_card_smog_mask.png";
    const SHADER_PATH =
      "res://shaders/vfx/ui/card/afflictions/smog/smog_main.gdshader";
    const SMOG_SCENE = `
[gd_scene load_steps=3 format=3]
[ext_resource type="Material" path="res://materials/smog.tres" id="mat"]
[ext_resource type="Texture2D" path="res://images/vfx/noise/vfx_noise_1.png" id="tex"]
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 422
[node name="SmogMain" type="TextureRect" parent="."]
offset_right = 300
offset_bottom = 422
material = ExtResource("mat")
texture = ExtResource("tex")
`;
    const resolveResource = (ref: GodotResourceRefValue) => {
      if (ref.type !== "ExtResource") return undefined;
      // The material is a separate .tres carrying its OWN ext-resource table.
      if (ref.id === "mat" || ref.path === "res://materials/smog.tres") {
        return {
          type: "ShaderMaterial",
          path: "res://materials/smog.tres",
          document: {
            kind: "resource" as const,
            header: {
              section: "gd_resource",
              attributes: { type: "ShaderMaterial" },
            },
            extResources: [
              {
                id: "1_shader",
                type: "Shader",
                path: SHADER_PATH,
                attributes: {},
                properties: {},
              },
              {
                id: "2_mask",
                type: "Texture2D",
                path: MASK_PATH,
                attributes: {},
                properties: {},
              },
            ],
            subResources: [],
            nodes: [],
            connections: [],
            editables: [],
            properties: {
              shader: { type: "ExtResource" as const, id: "1_shader" },
              "shader_parameter/mask": {
                type: "ExtResource" as const,
                id: "2_mask",
              },
            },
            diagnostics: [],
          },
        };
      }
      // The node's own TEXTURE (noise) — a scene-level ext resource.
      if (ref.id === "tex") {
        return {
          path: "res://images/vfx/noise/vfx_noise_1.png",
          url: "/noise.png",
          size: { width: 64, height: 64 },
        };
      }
      // The mask resolves ONLY by its path — the material-internal id ("2_mask") is
      // unknown to the scene, so the fix must attach the path before resolving.
      if (ref.path === MASK_PATH) {
        return {
          path: MASK_PATH,
          url: "/smog-mask.png",
          size: { width: 300, height: 422 },
        };
      }
      // Shaders are not bundled assets (like the live glue).
      return undefined;
    };
    const scene = parseGodotTextScene(SMOG_SCENE);
    const tree = resolveGodotSceneTree(scene, { resolveResource });
    const model = renderTreeToHtmlModel(tree, {
      resolveResource,
      enableWebglShaders: true,
      webglShaderIds: ["*"],
    });
    const node = model.nodes.find((n) => n.path === "SmogMain");

    expect(node?.attributes["data-godot-shader-webgl"]).toBe("1");
    const samplerUrls = JSON.parse(
      node?.attributes["data-godot-shader-sampler-urls"] ?? "{}",
    );
    expect(samplerUrls).toEqual({ mask: "/smog-mask.png" });
  });

  it("emits generic path-keyed shader loading fallback styles into the initial model", () => {
    const model = renderScene(SCRY_REVEAL_SCENE, {
      enableWebglShaders: true,
      shaderLoadingFallbacksByPath: {
        Sphere: {
          background: "radial-gradient(circle, #111 0%, #222 100%)",
          clipPath: "circle(50% at 50% 50%)",
          borderRadius: "50%",
        },
      },
    });
    const sphere = model.nodes.find((node) => node.path === "Sphere");

    expect(sphere?.selfAttributes["data-godot-shader-loading-fallback"]).toBe(
      "1",
    );
    expect(sphere?.selfAttributes["data-godot-shader-loading"]).toBe("1");
    expect(sphere?.selfStyle.background).toBe(
      "radial-gradient(circle, #111 0%, #222 100%)",
    );
    expect(sphere?.selfStyle["clip-path"]).toBe("circle(50% at 50% 50%)");
    expect(sphere?.selfStyle["border-radius"]).toBe("50%");
  });

  it("uses node shader parameter overrides for live packed vector uniforms", () => {
    const model = renderScene(SCRY_REVEAL_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
      overrideNodeProps: (_node, path) =>
        path === "Sphere"
          ? {
              "shader_parameter/gridFadeParams": [0, 1, 0, 1, 0.5, 0, 0, 0, 0],
            }
          : undefined,
    });
    const sphere = model.nodes.find((node) => node.path === "Sphere");

    const params = JSON.parse(
      sphere?.attributes["data-godot-shader-params"] ?? "{}",
    );
    expect(params.gridFadeParams).toEqual([0, 1, 0, 1, 0.5, 0, 0, 0, 0]);

    const kinds = JSON.parse(
      sphere?.attributes["data-godot-shader-param-kinds"] ?? "{}",
    );
    expect(kinds.gridFadeParams).toBe("PackedVector3Array");
  });

  it("does not paint default white for unsupported ShaderMaterial ColorRects under WebGL mode", () => {
    const model = renderScene(UNSUPPORTED_COLORRECT_SHADER_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
    });
    const panel = model.nodes.find((node) => node.path === "Panel");

    expect(panel?.attributes["data-godot-shader-webgl"]).toBe("1");
    expect(panel?.selfAttributes["data-godot-shader-colorrect-fallback"]).toBe(
      "transparent",
    );
    expect(panel?.selfStyle.background).toBeUndefined();
  });
});

describe("webglShaderIds activation matching (exact / uid / dir glob)", () => {
  const webglOf = (
    model: {
      nodes: Array<{ path: string; attributes: Record<string, unknown> }>;
    },
    path: string,
  ) =>
    model.nodes.find((node) => node.path === path)?.attributes[
      "data-godot-shader-webgl"
    ];

  it("activates a node whose shader resource path is listed exactly", () => {
    const model = renderScene(SCRY_REVEAL_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["res://shaders/scry_reveal.gdshader"],
    });
    expect(webglOf(model, "Sphere")).toBe("1");
  });

  it("activates a node matched by shader uid", () => {
    const model = renderScene(CARD_RIPPLE_UID_SCENE, {
      enableWebglShaders: true,
      shaderResolves: false,
      webglShaderIds: ["uid://bikvsfwlbp43n"],
    });
    expect(webglOf(model, "Highlight")).toBe("1");
  });

  it("activates a whole shader family via a trailing `/*` directory glob", () => {
    const model = renderScene(AFFLICTION_SHADER_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["res://shaders/vfx/ui/card/afflictions/*"],
    });
    // The galvanized shader lives under the globbed directory.
    expect(webglOf(model, "Affliction")).toBe("1");
  });

  it("does not activate a node whose shader is neither listed nor under a glob", () => {
    const exact = renderScene(SCRY_REVEAL_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["res://shaders/card_ripple.gdshader"],
    });
    expect(webglOf(exact, "Sphere")).toBeUndefined();

    // The affliction glob must not match a shader outside that directory.
    const glob = renderScene(SCRY_REVEAL_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["res://shaders/vfx/ui/card/afflictions/*"],
    });
    expect(webglOf(glob, "Sphere")).toBeUndefined();
  });
});

describe("card affliction shader overlays", () => {
  it("activates WebGL and hides the raw TextureRect fallback", () => {
    const model = renderScene(AFFLICTION_SHADER_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
      hiddenRawShaderFallbacksByPath: { Affliction: true },
    });
    const overlay = model.nodes.find((node) => node.path === "Affliction");

    expect(overlay?.attributes["data-godot-shader-webgl"]).toBe("1");
    expect(overlay?.attributes["data-godot-shader-path"]).toContain(
      "shaders/vfx/ui/card/afflictions/galvanized",
    );
    expect(overlay?.selfAttributes["data-godot-shader-texture-url"]).toBe(
      "/icon.png",
    );
    expect(overlay?.selfAttributes["data-godot-shader-raw-fallback"]).toBe(
      "hidden",
    );
    expect(overlay?.selfStyle["background-image"]).toBeUndefined();
  });

  it("activates WebGL for Bound chain and Entangled vine TextureRects", () => {
    // The whole affliction shader family is raw-hidden by ONE shader-id glob entry
    // (no per-node path enumeration), matching how the catalog opts the family in.
    const afflictionGlob = ["res://shaders/vfx/ui/card/afflictions/*"];
    const bound = renderScene(AFFLICTION_BOUND_SHADER_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
      hiddenRawShaderFallbackShaderIds: afflictionGlob,
    }).nodes.find((node) => node.path === "BoundMain");
    expect(bound?.attributes["data-godot-shader-webgl"]).toBe("1");
    expect(bound?.attributes["data-godot-shader-path"]).toContain(
      "shaders/vfx/ui/card/afflictions/bound",
    );
    expect(bound?.selfAttributes["data-godot-shader-texture-url"]).toBe(
      "/icon.png",
    );
    expect(bound?.selfAttributes["data-godot-shader-raw-fallback"]).toBe(
      "hidden",
    );
    expect(bound?.selfStyle["background-image"]).toBeUndefined();

    const entangled = renderScene(AFFLICTION_ENTANGLED_MAIN_SHADER_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
      hiddenRawShaderFallbackShaderIds: afflictionGlob,
    }).nodes.find((node) => node.path === "EntangledMain");
    expect(entangled?.attributes["data-godot-shader-webgl"]).toBe("1");
    expect(entangled?.attributes["data-godot-shader-path"]).toContain(
      "shaders/vfx/ui/card/afflictions/entangled",
    );
    expect(entangled?.selfAttributes["data-godot-shader-raw-fallback"]).toBe(
      "hidden",
    );
    const samplers = JSON.parse(
      entangled?.attributes["data-godot-shader-samplers"] ?? "{}",
    );
    expect(samplers.vine_lut).toMatchObject({ kind: "gradient" });
  });

  it("keeps Entangled leaf particle previews visible when their shader is runtime-unsupported", () => {
    const leaf = renderScene(AFFLICTION_ENTANGLED_LEAF_PARTICLE_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
    }).nodes.find((node) => node.path === "EntangledLeaf");

    expect(leaf?.attributes["data-godot-resource-kind"]).toBe("GPUParticles2D");
    expect(leaf?.attributes["data-godot-shader-webgl"]).toBe("1");
    expect(leaf?.attributes["data-godot-shader-path"]).toContain(
      "shaders/vfx/ui/card/afflictions/entangled",
    );
    expect(
      leaf?.selfAttributes["data-godot-shader-raw-fallback"],
    ).toBeUndefined();
    expect(leaf?.html).toContain("data-godot-particle");
    expect(leaf?.html).toContain("background-image:url(&quot;/icon.png&quot;)");
  });

  it("serializes CurveXYZTexture sampler specs for ringing alpha ramps", () => {
    const model = renderScene(AFFLICTION_RINGING_SAMPLER_SCENE, {
      enableWebglShaders: true,
      webglShaderIds: ["*"],
    });
    const overlay = model.nodes.find((node) => node.path === "Ringing");

    expect(overlay?.attributes["data-godot-shader-webgl"]).toBe("1");
    const samplers = JSON.parse(
      overlay?.attributes["data-godot-shader-samplers"] ?? "{}",
    );
    expect(samplers.ring_base_alpha).toMatchObject({
      kind: "curve",
      width: 256,
      channels: [
        [
          { x: 0, y: 0.1 },
          { x: 1, y: 0.3 },
        ],
        [
          { x: 0, y: 0.2 },
          { x: 1, y: 0.4 },
        ],
        [
          { x: 0, y: 0.3 },
          { x: 1, y: 0.5 },
        ],
      ],
    });
  });
});

describe("TextureRect clip_children masks", () => {
  it("clips children with the texture alpha without painting the mask texture itself", () => {
    const model = renderScene(TEXTURE_RECT_CLIP_CHILDREN_SCENE);
    const mask = model.nodes.find((node) => node.path === "Mask");

    expect(mask?.attributes["data-godot-clip-mask"]).toBe("texture-alpha");
    expect(mask?.style["mask-image"]).toBe('url("/icon.png")');
    expect(mask?.style["mask-size"]).toBe("contain");
    expect(mask?.style.overflow).toBe("hidden");
    expect(mask?.selfStyle["background-image"]).toBeUndefined();
  });
});

// Regression: an AtlasTexture sub-region tinted by an hsv ShaderMaterial (the
// real "settings gear": AtlasTexture region + hsv v=0.9) with an EXTERNAL atlas
// image (`/atlas128.png`, as the live presentation glue serves it). Baking the
// crop into an `<image>` SVG is impossible for an external URL (browsers won't
// load it from a CSS-background SVG → the sprite rendered blank), so the region
// is cropped with plain CSS background offsets and the tint applied via a
// `filter: url(#id)` color matrix on the self layer.
const ATLAS_SHADER_SCENE = `
[gd_scene load_steps=4 format=3]
[ext_resource type="Shader" path="res://shaders/hsv.gdshader" id="shader"]
[ext_resource type="Texture2D" path="res://atlas128.tres" id="atlasrect"]
[sub_resource type="ShaderMaterial" id="dim"]
shader = ExtResource("shader")
shader_parameter/h = 1.0
shader_parameter/s = 1.0
shader_parameter/v = 0.9
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 200
[node name="Dim" type="TextureRect" parent="."]
offset_right = 64
offset_bottom = 64
texture = ExtResource("atlasrect")
material = SubResource("dim")
expand_mode = 1
stretch_mode = 5
[node name="Plain" type="TextureRect" parent="."]
offset_top = 70
offset_right = 64
offset_bottom = 134
texture = ExtResource("atlasrect")
expand_mode = 1
stretch_mode = 5
`;

const ATLAS_TEXTURE_DOC = `
[gd_resource type="AtlasTexture" load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://atlas128.png" id="png"]
[resource]
atlas = ExtResource("png")
region = Rect2(32, 32, 64, 64)
`;

function renderAtlasShaderScene() {
  const scene = parseGodotTextScene(ATLAS_SHADER_SCENE);
  const atlasDoc = parseGodotResource(ATLAS_TEXTURE_DOC);
  const resolveResource = (ref: GodotResourceRefValue) => {
    if (ref.type === "ExtResource") {
      if (ref.id === "atlasrect") {
        return { document: atlasDoc };
      }
      if (ref.id === "png") {
        return {
          path: "res://atlas128.png",
          url: "/atlas128.png",
          size: { width: 128, height: 128 },
        };
      }
      return scene.extResources.find((candidate) => candidate.id === ref.id);
    }
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
  const tree = resolveGodotSceneTree(scene, { resolveResource });
  return renderTreeToHtmlModel(tree, {
    resolveResource,
    hsvAdjustShaderIds: HSV_ADJUST_IDS,
  });
}

describe("AtlasTexture sub-region + hsv ShaderMaterial", () => {
  it("crops the region with CSS offsets and tints via a filter (no SVG)", () => {
    const model = renderAtlasShaderScene();
    const dim = model.nodes.find((node) => node.path === "Dim");
    expect(dim?.selfAttributes["data-godot-shader-tint"]).toBe("hsv");
    expect(dim?.selfAttributes["data-godot-texture-tint"]).toBe("css-filter");
    // The external atlas image is painted as a plain CSS background (no SVG to
    // block), the sub-region is selected with background offsets, and the tint
    // (alpha-preserving feColorMatrix dimming to 0.9) is a self-layer filter.
    expect(dim?.selfStyle["background-image"]).toBe('url("/atlas128.png")');
    expect(dim?.selfStyle["background-image"]).not.toContain("svg+xml");
    expect(dim?.selfAttributes["data-godot-atlas-region"]).toBe("32,32,64,64");
    expect(dim?.selfStyle["background-position"]).toBeDefined();
    expect(dim?.selfStyle["background-size"]).toBeDefined();
    expect(tintFilterValues(model, dim)).toBe(
      colorMatrixFeValues(hsvColorMatrix(1, 1, 0.9)),
    );
  });

  it("renders the same atlas region untinted when there is no material", () => {
    const model = renderAtlasShaderScene();
    const plain = model.nodes.find((node) => node.path === "Plain");
    expect(plain?.selfAttributes["data-godot-shader-tint"]).toBeUndefined();
    expect(plain?.selfAttributes["data-godot-texture-tint"]).toBeUndefined();
    expect(plain?.selfStyle.filter).toBeUndefined();
    expect(plain?.selfStyle["background-image"]).toBe('url("/atlas128.png")');
    expect(plain?.selfStyle["background-image"]).not.toContain("svg+xml");
    expect(plain?.selfAttributes["data-godot-atlas-region"]).toBe(
      "32,32,64,64",
    );
    expect(plain?.selfStyle["background-position"]).toBeDefined();
    expect(plain?.selfStyle["background-size"]).toBeDefined();
  });
});

describe("applyHsv GLSL port parity", () => {
  it("collapses to a uniform value scale when h=1, s=1 (YIQ round-trips)", () => {
    const out = applyHsv([0.5, 0.25, 1], 1, 1, 0.9);
    expect(out[0]).toBeCloseTo(0.45, 6);
    expect(out[1]).toBeCloseTo(0.225, 6);
    expect(out[2]).toBeCloseTo(0.9, 6);
  });

  it("is the identity transform at h=1, s=1, v=1", () => {
    const matrix = hsvColorMatrix(1, 1, 1);
    expect(matrix.rows[0]).toEqual(
      expect.arrayContaining([expect.closeTo(1, 6)]),
    );
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        expect(matrix.rows[i][j]).toBeCloseTo(i === j ? 1 : 0, 6);
      }
    }
  });

  it("matches the basis-probe matrix column-for-column", () => {
    const h = 0.3;
    const s = 1.4;
    const v = 0.8;
    const matrix = hsvColorMatrix(h, s, v);
    const columns = [
      applyHsv([1, 0, 0], h, s, v),
      applyHsv([0, 1, 0], h, s, v),
      applyHsv([0, 0, 1], h, s, v),
    ];
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        expect(matrix.rows[row][col]).toBeCloseTo(columns[col][row], 9);
      }
    }
  });
});

// The RUNTIME scene producer shape (a live bridge dumping a loaded scene): the
// Highlight's scene-embedded ShaderMaterial arrives as a path-first ExtResource ref
// (`res://….tscn::ShaderMaterial_x`) with EMPTY ext/sub tables; the material is
// fetched as a JSON resource document whose `shader` is itself a path-first ref
// (again, no tables). The shader identity must come from the ref's own path.
describe("card_ripple via a runtime producer (path-first refs, no tables)", () => {
  const runtimeScene = {
    kind: "scene",
    nodes: [
      { index: 0, name: "Root", type: "Control", groups: [], properties: [] },
      {
        index: 1,
        name: "Highlight",
        type: "TextureRect",
        parent: ".",
        groups: [],
        properties: [
          { name: "offset_right", value: 64 },
          { name: "offset_bottom", value: 64 },
          {
            name: "modulate",
            value: { type: "Color", args: [0, 0.957, 0.988, 0.98] },
          },
          {
            name: "material",
            value: {
              type: "ExtResource",
              path: "res://scenes/cards/card.tscn::ShaderMaterial_7ivyc",
            },
          },
          {
            name: "texture",
            value: {
              type: "ExtResource",
              path: "res://images/packed/card_template/card_frame_sdf.exr",
            },
          },
        ],
      },
    ],
    connections: [],
    extResources: [],
    subResources: [],
    editableInstances: [],
    diagnostics: [],
  } as never;

  const resolveResource = (ref: GodotResourceRefValue) => {
    if (ref.path?.includes("::")) {
      return {
        type: "ShaderMaterial",
        document: {
          kind: "resource" as const,
          type: "ShaderMaterial",
          header: {
            section: "gd_resource",
            attributes: { type: "ShaderMaterial" },
          },
          extResources: [],
          subResources: [],
          properties: {
            shader: {
              type: "ExtResource" as const,
              path: "res://shaders/card_ripple.gdshader",
            },
            "shader_parameter/width": 0.075,
          },
          diagnostics: [],
        },
      };
    }
    if (ref.path?.endsWith(".exr")) {
      return {
        path: ref.path,
        url: "/sdf.png",
        size: { width: 64, height: 64 },
      };
    }
    // Shaders are not bundled assets — the live glue resolves them to undefined.
    return undefined;
  };

  function renderRuntimeScene(enableWebglShaders = false) {
    const tree = resolveGodotSceneTree(runtimeScene, { resolveResource });
    return renderTreeToHtmlModel(tree, {
      resolveResource,
      enableWebglShaders,
      webglShaderIds: enableWebglShaders ? ["*"] : undefined,
    });
  }

  it("recognizes the shader from the path-first ref without hardcoding it", () => {
    const model = renderRuntimeScene();
    const highlight = model.nodes.find((node) => node.path === "Highlight");
    expect(highlight?.attributes["data-godot-material-type"]).toBe(
      "ShaderMaterial",
    );
    expect(highlight?.attributes["data-godot-shader-path"]).toContain(
      "card_ripple",
    );
    // gsw no longer knows this shader by name: no name-specific blend attribute or
    // glow tint is emitted (the glow is now a consumer-supplied fallback filter).
    expect(highlight?.attributes["data-godot-shader-blend"]).toBeUndefined();
    expect(highlight?.selfAttributes["data-godot-texture-tint"]).not.toBe(
      "card-ripple-glow",
    );
  });

  it("feeds the live shader params to the WebGL runtime when enabled", () => {
    const model = renderRuntimeScene(true);
    const highlight = model.nodes.find((node) => node.path === "Highlight");
    expect(highlight?.attributes["data-godot-shader-webgl"]).toBe("1");
    const params = JSON.parse(
      highlight?.attributes["data-godot-shader-params"] ?? "{}",
    );
    expect(params).toMatchObject({ width: 0.075 });
    expect(highlight?.attributes["data-godot-shader-modulate"]).toBe(
      "0,0.957,0.988,0.98",
    );
  });
});
