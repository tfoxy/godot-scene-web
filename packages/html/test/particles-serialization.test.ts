import type { GodotSceneState } from "@godot-scene-web/core";
import type { ParticleSpecConfig } from "@godot-scene-web/html/runtime";
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
  type GodotHtmlRenderOptions,
  renderSceneToHtmlModel as renderTreeToHtmlModel,
} from "../src/index";

function renderSceneToHtmlModel(
  scene: GodotSceneState | GodotSceneTree,
  options: GodotLayoutOptions & GodotHtmlRenderOptions = {},
) {
  const tree = isGodotSceneTree(scene)
    ? scene
    : resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
  return renderTreeToHtmlModel(tree, options);
}

// A particle scene exercising the common-core serialization: sphere emission,
// over-life color ramp (GradientTexture1D -> Gradient) and scale curve (CurveTexture
// -> Curve), a CanvasItemMaterial with additive blend + flipbook, and a one-shot
// burst. The `resolveResource` resolves SubResources by id and the texture ExtResource.
const SCENE = `
[gd_scene load_steps=8 format=3]
[ext_resource type="Texture2D" path="res://particle.png" id="tex"]
[sub_resource type="CanvasItemMaterial" id="cim"]
blend_mode = 1
particles_animation = true
particles_anim_h_frames = 4
particles_anim_v_frames = 1
particles_anim_loop = false
[sub_resource type="Gradient" id="grad"]
offsets = PackedFloat32Array(0, 1)
colors = PackedColorArray(1, 0, 0, 1, 0, 0, 1, 0)
[sub_resource type="GradientTexture1D" id="gradtex"]
gradient = SubResource("grad")
[sub_resource type="Curve" id="curve"]
_data = [Vector2(0, 0), 0.0, 8.0, 0, 0, Vector2(1, 1), 0.0, 0.0, 0, 0]
point_count = 2
[sub_resource type="CurveTexture" id="curvetex"]
curve = SubResource("curve")
[sub_resource type="ParticleProcessMaterial" id="pmat"]
emission_shape = 2
emission_sphere_radius = 17.0
direction = Vector3(0, -1, 0)
spread = 30.0
initial_velocity_min = 50.0
initial_velocity_max = 100.0
angular_velocity_min = -90.0
angular_velocity_max = 90.0
gravity = Vector3(0, 0, 0)
damping_min = 2.0
damping_max = 4.0
scale_min = 0.25
scale_max = 0.5
scale_curve = SubResource("curvetex")
color_ramp = SubResource("gradtex")
[node name="Root" type="Node2D"]
[node name="Particles" type="GPUParticles2D" parent="."]
material = SubResource("cim")
texture = ExtResource("tex")
amount = 12
lifetime = 0.5
one_shot = true
explosiveness = 1.0
process_material = SubResource("pmat")
`;

function resolveResource(scene: GodotSceneState) {
  return (ref: { type: string; id?: string; path?: string }) => {
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
      path: "res://particle.png",
      url: "/particle.png",
      size: { width: 8, height: 8 },
    };
  };
}

describe("particle runtime serialization", () => {
  it("emits the runtime marker + config when opted in via particleIds", () => {
    const scene = parseGodotTextScene(SCENE);
    const model = renderSceneToHtmlModel(scene, {
      enableParticles: true,
      particleIds: ["*"],
      // biome-ignore lint/suspicious/noExplicitAny: test resolver shim
      resolveResource: resolveResource(scene) as any,
    });
    const particles = model.nodes.find((node) => node.path === "Particles");
    expect(particles?.attributes["data-godot-particle-runtime"]).toBe("1");
    // The static preview is preserved as the no-JS / no-GL fallback.
    expect(particles?.html).toContain("data-godot-particle");

    const specs = particles?.attributes["data-godot-particle-specs"];
    expect(specs).toBeTypeOf("string");
    const config = JSON.parse(specs as string) as ParticleSpecConfig;

    expect(config).toMatchObject({
      kind: "GPUParticles2D",
      amount: 12,
      lifetime: 0.5,
      oneShot: true,
      explosiveness: 1,
      emissionShape: 2,
      emissionSphereRadius: 17,
      direction: [0, -1],
      spread: 30,
      initialVelocityMin: 50,
      initialVelocityMax: 100,
      angularVelocityMin: -90,
      angularVelocityMax: 90,
      gravity: [0, 0],
      dampingMin: 2,
      dampingMax: 4,
      scaleMin: 0.25,
      scaleMax: 0.5,
      blendMode: 1,
      hframes: 4,
      vframes: 1,
      textureUrl: "/particle.png",
    });

    // Color ramp decoded from GradientTexture1D -> Gradient (red -> transparent blue).
    expect(config.colorRamp).toEqual([
      { offset: 0, color: [1, 0, 0, 1] },
      { offset: 1, color: [0, 0, 1, 0] },
    ]);
    // Scale curve decoded from CurveTexture -> Curve control points.
    expect(config.scaleCurve).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
  });

  it("serializes boxOffset as -rect (the emitter's visibility-rect corner) while draw origin stays 0", () => {
    // A visibility_rect whose top-left corner is offset from the node origin: the CSS-<span>
    // fallback renders emission centered at `-rect.(x,y)`, so the WebGL canvas must carry the
    // same offset (via boxOffset) to land in the same place. Draw origin stays 0 (no clipping).
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[sub_resource type="ParticleProcessMaterial" id="pmat"]
emission_shape = 3
emission_box_extents = Vector3(800, 500, 0)
[node name="Root" type="Node2D"]
[node name="Particles" type="GPUParticles2D" parent="."]
amount = 8
visibility_rect = Rect2(-100, -60, 200, 120)
process_material = SubResource("pmat")
`);
    const model = renderSceneToHtmlModel(scene, {
      enableParticles: true,
      particleIds: ["*"],
      // biome-ignore lint/suspicious/noExplicitAny: test resolver shim
      resolveResource: resolveResource(scene) as any,
    });
    const particles = model.nodes.find((node) => node.path === "Particles");
    const specs = particles?.attributes["data-godot-particle-specs"];
    const config = JSON.parse(specs as string) as ParticleSpecConfig;
    // rect = visibility_rect (-100,-60) → boxOffset = -rect.(x,y) = (100, 60).
    expect(config.boxOffsetX).toBe(100);
    expect(config.boxOffsetY).toBe(60);
    // The draw origin is untouched (kept 0 so a point burst isn't drawn outside the canvas).
    expect(config.originX).toBe(0);
    expect(config.originY).toBe(0);
  });

  it("resolves an EXTERNAL .tres CanvasItemMaterial ref to the blend mode + flipbook", () => {
    // The Neow lights: `material = ExtResource("res://themes/canvas_item_material_additive_shared.tres")`
    // (not an inline SubResource). The resolver returns the parsed resource DOCUMENT
    // (the live fetch resolver does this once the .tres settles); the serializer must
    // read blend_mode/particles_animation from it exactly like an inline sub-resource —
    // dropping it renders the additive glow as normal-blend opaque discs.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Material" path="res://themes/canvas_item_material_additive_shared.tres" id="mat"]
[ext_resource type="Texture2D" path="res://light.png" id="tex"]
[node name="Root" type="Node2D"]
[node name="light" type="CPUParticles2D" parent="."]
material = ExtResource("mat")
texture = ExtResource("tex")
amount = 2
lifetime = 3
color = Color(0.07, 0.54, 0.77, 0.26)
`);
    const externalResolver = (ref: {
      type: string;
      id?: string;
      path?: string;
    }) => {
      const target =
        ref.path ??
        scene.extResources.find((candidate) => candidate.id === ref.id)?.path;
      if (target === "res://themes/canvas_item_material_additive_shared.tres") {
        return {
          type: "CanvasItemMaterial",
          path: target,
          url: "/res/themes/canvas_item_material_additive_shared.tres",
          document: {
            kind: "resource",
            header: {
              section: "gd_resource",
              attributes: { type: "CanvasItemMaterial" },
            },
            extResources: [],
            subResources: [],
            properties: { blend_mode: 1, light_mode: 0 },
            diagnostics: [],
          },
        };
      }
      return { path: "res://light.png", url: "/light.png" };
    };
    const model = renderSceneToHtmlModel(scene, {
      enableParticles: true,
      particleIds: ["*"],
      // biome-ignore lint/suspicious/noExplicitAny: test resolver shim
      resolveResource: externalResolver as any,
    });
    const particles = model.nodes.find((node) => node.path === "light");
    const specs = particles?.attributes["data-godot-particle-specs"];
    expect(specs).toBeTypeOf("string");
    const config = JSON.parse(specs as string) as ParticleSpecConfig;
    expect(config.blendMode).toBe(1);
    // No particles_animation on the material => single-frame sprite.
    expect(config.hframes).toBe(1);
    expect(config.vframes).toBe(1);
    expect(config.baseColor[3]).toBeCloseTo(0.26, 5);
  });

  it("omits the runtime marker + config when not opted in (golden safety)", () => {
    const scene = parseGodotTextScene(SCENE);
    const model = renderSceneToHtmlModel(scene, {
      // No enableParticles.
      // biome-ignore lint/suspicious/noExplicitAny: test resolver shim
      resolveResource: resolveResource(scene) as any,
    });
    const particles = model.nodes.find((node) => node.path === "Particles");
    expect(
      particles?.attributes["data-godot-particle-runtime"],
    ).toBeUndefined();
    expect(particles?.attributes["data-godot-particle-specs"]).toBeUndefined();
    // Static preview still rendered.
    expect(particles?.html).toContain("data-godot-particle");
  });

  it("does not opt a node in unless its id/path matches", () => {
    const scene = parseGodotTextScene(SCENE);
    const model = renderSceneToHtmlModel(scene, {
      enableParticles: true,
      particleIds: ["res://other/*"],
      // biome-ignore lint/suspicious/noExplicitAny: test resolver shim
      resolveResource: resolveResource(scene) as any,
    });
    const particles = model.nodes.find((node) => node.path === "Particles");
    expect(
      particles?.attributes["data-godot-particle-runtime"],
    ).toBeUndefined();
  });
});
