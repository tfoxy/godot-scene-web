import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { GodotNode, GodotSceneState } from "@godot-scene-web/core";
import {
  type GodotHtmlModel,
  renderSceneToHtmlModel,
} from "@godot-scene-web/html";
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
import {
  createGodotProjectResolver,
  type GodotProjectResolver,
} from "../src/node";

const externalProject = process.env.GODOT_SCENE_WEB_EXTERNAL_PROJECT;
const externalScenesEnv = process.env.GODOT_SCENE_WEB_EXTERNAL_SCENES;
const externalScenes = (externalScenesEnv ?? "")
  .split(",")
  .map((scene) => scene.trim())
  .filter(Boolean);
const discoverAllScenes =
  externalProject && (!externalScenesEnv || externalScenesEnv === "all");

const describeExternal =
  externalProject && (discoverAllScenes || externalScenes.length > 0)
    ? describe
    : describe.skip;

describeExternal("external Godot project smoke", () => {
  it("loads and renders configured scenes without diagnostics", () => {
    expect(externalProject).toBeTruthy();
    expect(existsSync(externalProject as string), externalProject).toBe(true);

    const resolver = createGodotProjectResolver({
      projectRoot: externalProject as string,
      assetBaseUrl: "/assets",
    });
    const scenePaths = discoverAllScenes
      ? discoverSceneResourcePaths(externalProject as string)
      : externalScenes.map(normalizeResourcePath);
    expect(scenePaths.length, "external scenes").toBeGreaterThan(0);
    const results: Array<{
      resourcePath: string;
      scene: GodotSceneState;
      model: GodotHtmlModel;
    }> = [];

    for (const resourcePath of scenePaths) {
      const scene = resolver.loadScene(resourcePath);
      expect(scene.diagnostics, `${resourcePath} parser diagnostics`).toEqual(
        [],
      );

      const model = renderSceneToHtmlModel(
        resolveGodotSceneTree(scene, resolver.sceneOptions(scene)),
        resolver.sceneOptions(scene),
      );
      expect(
        model.diagnostics,
        `${resourcePath} layout/html diagnostics`,
      ).toEqual([]);
      expect(
        model.nodes.length,
        `${resourcePath} rendered nodes`,
      ).toBeGreaterThan(0);

      const wrapper = mount(GodotSceneView, {
        props: {
          scene,
          options: resolver.sceneOptions(scene),
        },
      });
      expect(
        wrapper.find("[data-godot-stage]").exists(),
        `${resourcePath} Vue stage`,
      ).toBe(true);

      results.push({ resourcePath, scene, model });
    }

    const fontFaces = results.flatMap((result) => result.model.fontFaces);
    expect(
      fontFaces.length,
      "expected configured scenes to exercise browser font faces",
    ).toBeGreaterThan(0);

    const pngAtlasNodes = results.flatMap((result) =>
      result.model.nodes.filter(
        (node) =>
          Boolean(node.attributes["data-godot-atlas-region"]) &&
          Boolean(
            node.attributes["data-godot-resource-path"]?.endsWith(".png"),
          ),
      ),
    );
    expect(
      pngAtlasNodes.length,
      "expected configured scenes to exercise PNG-backed AtlasTexture resources",
    ).toBeGreaterThan(0);

    const mountedInstanceHosts = results.flatMap((result) =>
      packedSceneInstancePaths(result.scene, resolver).filter((hostPath) =>
        result.model.nodes.some((node) => node.path.startsWith(`${hostPath}/`)),
      ),
    );
    expect(
      mountedInstanceHosts.length,
      "expected configured scenes to exercise mounted PackedScene children",
    ).toBeGreaterThan(0);

    if (discoverAllScenes) {
      const nodes = results.flatMap((result) => result.model.nodes);
      expect(
        nodes.some((node) => node.type === "Sprite2D"),
        "expected all-scenes smoke to exercise Sprite2D",
      ).toBe(true);
      expect(
        nodes.some(
          (node) =>
            node.type === "CPUParticles2D" || node.type === "GPUParticles2D",
        ),
        "expected all-scenes smoke to exercise particle previews",
      ).toBe(true);
      expect(
        nodes.some((node) => node.type === "Line2D"),
        "expected all-scenes smoke to exercise Line2D",
      ).toBe(true);
      expect(
        nodes.some((node) => node.type === "Button"),
        "expected all-scenes smoke to exercise Button",
      ).toBe(true);
    }
  }, 120000);
});

function normalizeResourcePath(scenePath: string): string {
  return scenePath.startsWith("res://")
    ? scenePath
    : `res://${scenePath.replace(/^\/+/, "")}`;
}

function packedSceneInstancePaths(
  scene: GodotSceneState,
  resolver: GodotProjectResolver,
): string[] {
  return scene.nodes
    .filter(
      (node) =>
        node.instance &&
        resolver.extResource(scene, node.instance)?.path?.endsWith(".tscn"),
    )
    .map(nodeScenePath);
}

function nodeScenePath(node: GodotNode): string {
  if (!node.parent) {
    return ".";
  }
  return node.parent === "." ? node.name : `${node.parent}/${node.name}`;
}

function discoverSceneResourcePaths(projectRoot: string): string[] {
  const scenesRoot = join(projectRoot, "scenes");
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else if (path.endsWith(".tscn")) {
        paths.push(
          `res://${relative(projectRoot, path).split("\\").join("/")}`,
        );
      }
    }
  };
  visit(scenesRoot);
  return paths.sort();
}
