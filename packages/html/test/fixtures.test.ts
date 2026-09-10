import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  asString,
  type GodotExtResource,
  type GodotNode,
  type GodotResource,
  type GodotResourceRefValue,
  type GodotSceneState,
} from "@godot-scene-web/core";
import {
  type GodotLayoutOptions,
  resolveGodotSceneTree as resolveSceneTreeFromGraph,
} from "@godot-scene-web/layout";
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
import { beforeAll, describe, expect, it } from "vitest";
import { ensureRobotoFonts } from "../../../scripts/ensure-roboto-fonts";
import {
  type GodotHtmlRenderOptions,
  renderSceneToHtmlModel as renderTreeToHtmlModel,
} from "../src/index";

const fixturesRoot = resolve("fixtures");
const SOURCE_SCENE_PATH_ATTRIBUTE =
  "metadata/godot_scene_web/source_scene_path";

function renderSceneToHtmlModel(
  scene: GodotSceneState,
  options: GodotLayoutOptions & GodotHtmlRenderOptions = {},
) {
  return renderTreeToHtmlModel(resolveGodotSceneTree(scene, options), options);
}

describe("fixtures", () => {
  beforeAll(async () => {
    await ensureRobotoFonts(resolve("."));
  });

  it("parse and render all fixture scenes without diagnostics", () => {
    const scenePaths = fixtureFiles(".tscn");
    expect(scenePaths.length).toBeGreaterThan(0);

    for (const scenePath of scenePaths) {
      const scene = parseSceneFile(scenePath);
      expect(scene.diagnostics, relative(fixturesRoot, scenePath)).toEqual([]);
      const model = renderSceneToHtmlModel(scene, {
        mountExternalScene: (ref, node) => {
          const sourceScene = sceneForNode(scene, node) ?? scene;
          const resource = extResource(sourceScene, ref);
          return resource?.path?.endsWith(".tscn")
            ? parseSceneFile(resourcePath(resource.path))
            : undefined;
        },
        resolveResource: (ref, node) =>
          resolveFixtureResource(scene, ref, node),
      });
      expect(model.diagnostics, relative(fixturesRoot, scenePath)).toEqual([]);
    }
  });

  it("parse all fixture resources without diagnostics", () => {
    for (const resourcePath of fixtureFiles(".tres")) {
      const document = parseResourceFile(resourcePath);
      expect(
        document.diagnostics,
        relative(fixturesRoot, resourcePath),
      ).toEqual([]);
    }
  });

  it("resolves FontFile wrapper resources to browser font metadata", () => {
    const scenePath = resolve("fixtures/text-alignment/rich-theme-roboto.tscn");
    const scene = parseSceneFile(scenePath);
    const model = renderSceneToHtmlModel(scene, {
      resolveResource: (ref, node) => resolveFixtureResource(scene, ref, node),
    });

    expect(model.fontFaces).toMatchObject([
      { fontFamily: "Roboto Fixture", style: "normal", weight: "400" },
      { fontFamily: "Roboto Fixture", style: "normal", weight: "700" },
      { fontFamily: "Roboto Fixture", style: "italic", weight: "400" },
      { fontFamily: "Roboto Fixture", style: "italic", weight: "700" },
    ]);
    expect(
      model.fontFaces.every((face) =>
        face.url.startsWith("data:font/ttf;base64,"),
      ),
    ).toBe(true);
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
  tagSceneNodes(scene, localResourcePath(path));
  return scene;
}

function parseResourceFile(path: string): GodotResource {
  return parseGodotResource(readFileSync(path, "utf8"), { path });
}

function resolveFixtureResource(
  scene: GodotSceneState,
  ref: GodotResourceRefValue,
  node: GodotNode,
): unknown {
  const sourceScene = sceneForNode(scene, node) ?? scene;
  if (ref.type === "SubResource") {
    const resource = sourceScene.subResources.find(
      (candidate) => candidate.id === ref.id,
    );
    return resource
      ? { type: resource.type, document: subResourceDocument(resource) }
      : undefined;
  }
  const resource = extResource(sourceScene, ref);
  if (!resource?.path) {
    return undefined;
  }
  if (resource.path.endsWith(".tres")) {
    const document = parseResourceFile(resourcePath(resource.path));
    if (document.header?.attributes.type === "FontVariation") {
      return fontVariationFixtureResource(resource.path, document);
    }
    if (document.header?.attributes.type === "FontFile") {
      return fontFixtureResource(resource.path);
    }
    return {
      path: resource.path,
      document,
    };
  }
  if (isFontPath(resource.path)) {
    return fontFileFixtureResource(resource.path);
  }
  return {
    path: resource.path,
    url: resource.path.replace(/^res:\/\//, "/"),
  };
}

function sceneForNode(
  rootScene: GodotSceneState,
  node: GodotNode,
): GodotSceneState | undefined {
  const sourcePath = asString(node.properties[SOURCE_SCENE_PATH_ATTRIBUTE]);
  return sourcePath ? parseSceneFile(resourcePath(sourcePath)) : rootScene;
}

function tagSceneNodes(
  scene: GodotSceneState,
  resourcePathValue: string,
): void {
  for (const node of scene.nodes) {
    const existing = node.properties.find(
      (property) => property.name === SOURCE_SCENE_PATH_ATTRIBUTE,
    );
    if (existing) {
      existing.value = resourcePathValue;
    } else {
      node.properties.push({
        name: SOURCE_SCENE_PATH_ATTRIBUTE,
        value: resourcePathValue,
      });
    }
  }
}

function subResourceDocument(resource: {
  type?: string;
  properties: Record<string, unknown>;
}): GodotResource {
  return {
    type: resource.type,
    header: resource.type
      ? { section: "gd_resource", attributes: { type: resource.type } }
      : null,
    extResources: [],
    subResources: [],
    properties: resource.properties as GodotResource["properties"],
    diagnostics: [],
  };
}

function fontVariationFixtureResource(
  resourcePathValue: string,
  document: GodotResource,
): unknown {
  const baseRef = document.properties.base_font;
  if (
    !baseRef ||
    typeof baseRef !== "object" ||
    !("type" in baseRef) ||
    baseRef.type !== "ExtResource"
  ) {
    return { path: resourcePathValue, document };
  }
  const base = document.extResources.find(
    (candidate) => candidate.id === baseRef.id,
  );
  if (!base?.path) {
    return { path: resourcePathValue, document };
  }
  const baseResource = fontFixtureResource(base.path);
  if (!baseResource) {
    return { path: resourcePathValue, document };
  }
  return {
    ...baseResource,
    path: resourcePathValue,
    document,
    fontWeight:
      fontWeightFromVariationDocument(document) ??
      fontWeightFromPath(resourcePathValue),
    fontStyle: baseResource.fontStyle ?? fontStyleFromPath(base.path),
  };
}

function fontFixtureResource(resourcePathValue: string) {
  if (isFontPath(resourcePathValue)) {
    return fontFileFixtureResource(resourcePathValue);
  }
  if (!resourcePathValue.endsWith(".tres")) {
    return undefined;
  }
  const document = parseResourceFile(resourcePath(resourcePathValue));
  if (document.header?.attributes.type !== "FontFile") {
    return undefined;
  }
  const fontPath =
    typeof document.properties.font_path === "string"
      ? document.properties.font_path
      : undefined;
  if (!fontPath || !isFontPath(fontPath)) {
    return undefined;
  }
  return {
    ...fontFileFixtureResource(fontPath),
    path: resourcePathValue,
    document,
  };
}

function fontFileFixtureResource(resourcePath: string) {
  const url = fontDataUrl(resourcePath);
  return {
    path: resourcePath,
    url,
    fontUrl: url,
    fontFamily: fontFamilyFromPath(resourcePath),
    fontStyle: fontStyleFromPath(resourcePath),
    fontWeight: fontWeightFromPath(resourcePath),
  };
}

function fontDataUrl(path: string): string {
  const content = readFileSync(resourcePath(path));
  return `data:${fontMimeType(path)};base64,${content.toString("base64")}`;
}

function fontMimeType(path: string): string {
  if (/\.otf$/i.test(path)) {
    return "font/otf";
  }
  if (/\.woff2$/i.test(path)) {
    return "font/woff2";
  }
  if (/\.woff$/i.test(path)) {
    return "font/woff";
  }
  return "font/ttf";
}

function isFontPath(path: string): boolean {
  return /\.(?:ttf|otf|woff2?|ttc)$/i.test(path);
}

function fontFamilyFromPath(path: string): string {
  return path.includes("/roboto/") || /roboto/i.test(path)
    ? "Roboto Fixture"
    : (path
        .split("/")
        .at(-1)
        ?.replace(/\.[^.]+$/, "") ?? "Godot Fixture Font");
}

function fontStyleFromPath(path: string): "normal" | "italic" {
  return /italic/i.test(path) ? "italic" : "normal";
}

function fontWeightFromPath(path: string): string {
  return /bold/i.test(path) ? "700" : "400";
}

function fontWeightFromVariationDocument(
  document: GodotResource,
): string | undefined {
  const variation = document.properties.variation_opentype;
  if (
    !variation ||
    typeof variation !== "object" ||
    Array.isArray(variation) ||
    "type" in variation
  ) {
    return undefined;
  }
  const value = (variation as Record<string, unknown>)["2003265652"];
  return typeof value === "number" ? String(value) : undefined;
}

function extResource(
  scene: GodotSceneState,
  ref: GodotResourceRefValue,
): GodotExtResource | undefined {
  return ref.type === "ExtResource"
    ? scene.extResources.find((resource) => resource.id === ref.id)
    : undefined;
}

function resourcePath(path: string): string {
  if (!path.startsWith("res://fixtures/")) {
    throw new Error(`Fixture resource must be under res://fixtures/: ${path}`);
  }
  return resolve(path.replace(/^res:\/\//, ""));
}

function localResourcePath(path: string): string {
  const relativePath = relative(resolve("."), resolve(path))
    .split("\\")
    .join("/");
  if (!relativePath.startsWith("fixtures/")) {
    throw new Error(`Fixture file must be under fixtures/: ${path}`);
  }
  return `res://${relativePath}`;
}
