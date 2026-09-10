import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  asString,
  type GodotNode,
  type GodotResourceRefValue,
  type GodotSceneState,
} from "@godot-scene-web/core";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import { flattenSceneGraphNodes, resolveGodotSceneTree } from "../src/index";

const fixturesRoot = resolve("fixtures");
const SOURCE_SCENE_PATH_ATTRIBUTE =
  "metadata/godot_scene_web/source_scene_path";

// `flattenSceneGraphNodes` promises the exact node membership of the rect cascade
// without running it. Pin that equivalence (paths + per-path structural fields)
// against every fixture scene and against synthetic invisible-children cases.
function expectMembershipParity(
  scene: GodotSceneState,
  options: Parameters<typeof deriveSceneGraph>[1] = {},
  label?: string,
): void {
  const graph = deriveSceneGraph(scene, options);
  const treeNodes = resolveGodotSceneTree(graph, options).nodes;
  const flatNodes = flattenSceneGraphNodes(graph);

  expect([...flatNodes.map((node) => node.path)].sort(), label).toEqual(
    [...treeNodes.map((node) => node.path)].sort(),
  );

  const flatByPath = new Map(flatNodes.map((node) => [node.path, node]));
  for (const treeNode of treeNodes) {
    const flat = flatByPath.get(treeNode.path);
    expect(flat, `${label ?? ""} ${treeNode.path}`).toBeDefined();
    expect(flat?.drawOrder, `${label ?? ""} ${treeNode.path} drawOrder`).toBe(
      treeNode.drawOrder,
    );
    expect(flat?.type, `${label ?? ""} ${treeNode.path} type`).toBe(
      treeNode.type,
    );
    expect(flat?.source, `${label ?? ""} ${treeNode.path} source`).toBe(
      treeNode.source,
    );
  }
}

describe("flattenSceneGraphNodes", () => {
  it("matches the rect cascade's membership for every fixture scene", () => {
    const scenePaths = fixtureFiles(".tscn");
    expect(scenePaths.length).toBeGreaterThan(0);

    for (const scenePath of scenePaths) {
      const scene = parseSceneFile(scenePath);
      expectMembershipParity(
        scene,
        {
          mountExternalScene: (ref: GodotResourceRefValue, node: GodotNode) => {
            const sourceScene = sceneForNode(scene, node) ?? scene;
            const resource =
              ref.type === "ExtResource"
                ? sourceScene.extResources.find(
                    (candidate) => candidate.id === ref.id,
                  )
                : undefined;
            return resource?.path?.endsWith(".tscn")
              ? parseSceneFile(resourcePath(resource.path))
              : undefined;
          },
        },
        relative(fixturesRoot, scenePath),
      );
    }
  });

  it("drops invisible Box/Grid/Flow children (and subtrees), keeps all others", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1280
offset_bottom = 720
[node name="Box" type="VBoxContainer" parent="."]
[node name="HiddenInBox" type="Control" parent="Box"]
visible = false
[node name="HiddenInBoxChild" type="Label" parent="Box/HiddenInBox"]
text = "dropped with parent"
[node name="VisibleInBox" type="Control" parent="Box"]
[node name="Grid" type="GridContainer" parent="."]
[node name="HiddenInGrid" type="Control" parent="Grid"]
visible = false
[node name="Flow" type="HFlowContainer" parent="."]
[node name="HiddenInFlow" type="Control" parent="Flow"]
visible = false
[node name="Margin" type="MarginContainer" parent="."]
[node name="HiddenInMargin" type="Control" parent="Margin"]
visible = false
[node name="HiddenInPlain" type="Control" parent="."]
visible = false
[node name="KeptUnderHidden" type="Label" parent="HiddenInPlain"]
text = "kept: plain parents lay out all children"
`);
    expectMembershipParity(scene);

    const paths = new Set(
      flattenSceneGraphNodes(deriveSceneGraph(scene)).map((node) => node.path),
    );
    expect(paths.has("Box/HiddenInBox")).toBe(false);
    expect(paths.has("Box/HiddenInBox/HiddenInBoxChild")).toBe(false);
    expect(paths.has("Box/VisibleInBox")).toBe(true);
    expect(paths.has("Grid/HiddenInGrid")).toBe(false);
    expect(paths.has("Flow/HiddenInFlow")).toBe(false);
    expect(paths.has("Margin/HiddenInMargin")).toBe(true);
    expect(paths.has("HiddenInPlain")).toBe(true);
    expect(paths.has("HiddenInPlain/KeptUnderHidden")).toBe(true);
  });
});

function fixtureFiles(extension: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else if (path.endsWith(extension)) {
        result.push(path);
      }
    }
  };
  visit(fixturesRoot);
  return result.sort();
}

function parseSceneFile(path: string): GodotSceneState {
  const scene = parseGodotTextScene(readFileSync(path, "utf8"), { path });
  const relativePath = relative(resolve("."), resolve(path))
    .split("\\")
    .join("/");
  for (const node of scene.nodes) {
    node.properties.push({
      name: SOURCE_SCENE_PATH_ATTRIBUTE,
      value: `res://${relativePath}`,
    });
  }
  return scene;
}

function sceneForNode(
  rootScene: GodotSceneState,
  node: GodotNode,
): GodotSceneState | undefined {
  const sourcePath = asString(node.properties[SOURCE_SCENE_PATH_ATTRIBUTE]);
  return sourcePath ? parseSceneFile(resourcePath(sourcePath)) : rootScene;
}

function resourcePath(path: string): string {
  if (!path.startsWith("res://fixtures/")) {
    throw new Error(`Fixture resource must be under res://fixtures/: ${path}`);
  }
  return resolve(path.replace(/^res:\/\//, ""));
}
