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
  type GodotHtmlRenderOptions,
  mountHtmlScene,
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

const SCENE = `
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://particle.png" id="tex"]
[sub_resource type="ParticleProcessMaterial" id="pmat"]
emission_shape = 1
emission_sphere_radius = 12.0
initial_velocity_min = 20.0
initial_velocity_max = 40.0
[node name="Root" type="Node2D"]
[node name="Particles" type="GPUParticles2D" parent="."]
texture = ExtResource("tex")
amount = 8
lifetime = 1.0
process_material = SubResource("pmat")
`;

// biome-ignore lint/suspicious/noExplicitAny: test resolver shim
const resolveResource = (scene: GodotSceneState): any => {
  return (ref: { type: string; id?: string }) => {
    if (ref.type === "SubResource") {
      const resource = scene.subResources.find((c) => c.id === ref.id);
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
};

describe("particle runtime DOM mount (no-WebGL fallback)", () => {
  it("mounts without throwing and keeps the static preview when WebGL is unavailable", () => {
    // jsdom has no WebGL2, so the persistent particle runtime is a no-op and the
    // static `<span>` preview must remain visible (the documented fallback).
    const scene = parseGodotTextScene(SCENE);
    const model = renderSceneToHtmlModel(scene, {
      enableParticles: true,
      particleIds: ["*"],
      resolveResource: resolveResource(scene),
    });
    const host = document.createElement("div");
    expect(() =>
      mountHtmlScene(host, model, { enableParticles: true }),
    ).not.toThrow();

    const outer = host.querySelector(
      '[data-godot-particle-runtime="1"]:not([data-godot-self-layer])',
    );
    expect(outer).not.toBeNull();

    const spans = host.querySelectorAll<HTMLElement>("[data-godot-particle]");
    expect(spans.length).toBeGreaterThan(0);
    // No GL => preview never hidden.
    for (const span of spans) {
      expect(span.style.display).not.toBe("none");
    }
    // No particle canvas was inserted (runtime no-opped).
    expect(host.querySelector("[data-godot-particle-canvas]")).toBeNull();
  });

  it("re-mounting the same container does not throw (disposer runs)", () => {
    const scene = parseGodotTextScene(SCENE);
    const model = renderSceneToHtmlModel(scene, {
      enableParticles: true,
      particleIds: ["*"],
      resolveResource: resolveResource(scene),
    });
    const host = document.createElement("div");
    mountHtmlScene(host, model, { enableParticles: true });
    expect(() =>
      mountHtmlScene(host, model, { enableParticles: true }),
    ).not.toThrow();
  });
});
