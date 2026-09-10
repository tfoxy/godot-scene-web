import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  asBoolean,
  asNumber,
  asRect2,
  asResourceRef,
  asString,
  type GodotExtResource,
  type GodotNode,
  type GodotResource,
  type GodotResourceRefValue,
  type GodotSceneState,
  type GodotVariant,
} from "@godot-scene-web/core";
import {
  SOURCE_SCENE_PATH_ATTRIBUTE,
  tagSceneNodes,
} from "@godot-scene-web/scene-graph";
import {
  parseGodotResource,
  parseGodotTextScene,
} from "@godot-scene-web/tscn-parser";
import type { GodotProjectResolvedResource } from "./shared";
import { queryTheme } from "./theme-query";

export type { GodotProjectResolvedResource } from "./shared";
export { queryTheme } from "./theme-query";

export interface GodotProjectResolverOptions {
  projectRoot: string;
  assetBaseUrl?: string | ((resourcePath: string) => string);
}

export interface GodotProjectSceneOptions {
  resolveResource: (
    ref: GodotResourceRefValue,
    node: GodotNode,
  ) => GodotProjectResolvedResource | undefined;
  resolveResourcePath: (
    path: string,
    node: GodotNode,
  ) => GodotProjectResolvedResource | undefined;
  mountExternalScene: (
    ref: GodotResourceRefValue,
    node: GodotNode,
  ) => GodotSceneState | undefined;
  /**
   * Resolve a theme item (e.g. a font size) for a node from its assigned `theme`
   * resource (type-variation -> type -> default cascade). Optional: absent ⇒ the
   * renderer keeps its built-in fallbacks.
   */
  resolveTheme?: (node: GodotNode, name: string) => GodotVariant | undefined;
}

export interface GodotProjectResolver {
  projectRoot: string;
  resourcePathToFilePath: (resourcePath: string) => string;
  resourcePathToUrl: (resourcePath: string) => string;
  loadScene: (resourcePath: string) => GodotSceneState;
  loadResource: (resourcePath: string) => GodotResource;
  extResource: (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
  ) => GodotExtResource | undefined;
  resolveResource: (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
    node?: GodotNode,
  ) => GodotProjectResolvedResource | undefined;
  mountExternalScene: (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
    node?: GodotNode,
  ) => GodotSceneState | undefined;
  sceneOptions: (scene: GodotSceneState) => GodotProjectSceneOptions;
}

export function createGodotProjectResolver(
  options: GodotProjectResolverOptions,
): GodotProjectResolver {
  const projectRoot = resolve(options.projectRoot);
  const sceneCache = new Map<string, GodotSceneState>();
  const resourceCache = new Map<string, GodotResource>();
  const imageSizeCache = new Map<
    string,
    { width: number; height: number } | undefined
  >();

  const resourcePathToFilePath = (resourcePath: string): string => {
    assertResourcePath(resourcePath);
    return resolve(projectRoot, resourcePath.replace(/^res:\/\//, ""));
  };

  const resourcePathToUrl = (resourcePath: string): string => {
    assertResourcePath(resourcePath);
    if (typeof options.assetBaseUrl === "function") {
      return options.assetBaseUrl(resourcePath);
    }
    const relativePath = resourcePath
      .replace(/^res:\/\//, "")
      .split("/")
      .join("/");
    const base = options.assetBaseUrl ?? "/";
    return `${base.replace(/\/?$/, "/")}${relativePath}`;
  };

  const loadScene = (resourcePath: string): GodotSceneState => {
    const cached = sceneCache.get(resourcePath);
    if (cached) {
      return cached;
    }
    const scene = parseGodotTextScene(
      readFileSync(resourcePathToFilePath(resourcePath), "utf8"),
      {
        path: resourcePath,
      },
    );
    tagSceneNodes(scene, resourcePath);
    sceneCache.set(resourcePath, scene);
    return scene;
  };

  const loadResource = (resourcePath: string): GodotResource => {
    const cached = resourceCache.get(resourcePath);
    if (cached) {
      return cached;
    }
    const document = parseGodotResource(
      readFileSync(resourcePathToFilePath(resourcePath), "utf8"),
      {
        path: resourcePath,
      },
    );
    resourceCache.set(resourcePath, document);
    return document;
  };

  const extResource = (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
  ): GodotExtResource | undefined =>
    ref.type === "ExtResource" && ref.id !== undefined
      ? scene.extResources.find((resource) => resource.id === ref.id)
      : undefined;

  // Resolve an ExtResource ref to a res:// path (+ table type when known).
  // Path-first (runtime producers supply `ref.path`), id-fallback (text
  // producers supply a scene-local `id` we look up in the table).
  const extTarget = (
    extResources: GodotExtResource[],
    ref: GodotResourceRefValue,
  ): { path: string; type?: string } | undefined => {
    if (ref.type !== "ExtResource") {
      return undefined;
    }
    if (ref.path) {
      return { path: ref.path };
    }
    const resource = extResources.find((candidate) => candidate.id === ref.id);
    return resource?.path
      ? { path: resource.path, type: resource.type }
      : undefined;
  };

  const resolveResource = (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
    _node?: GodotNode,
  ): GodotProjectResolvedResource | undefined => {
    if (ref.type === "SubResource") {
      const resource = scene.subResources.find(
        (candidate) => candidate.id === ref.id,
      );
      return resource
        ? { type: resource.type, document: subResourceDocument(resource) }
        : undefined;
    }
    const target = extTarget(scene.extResources, ref);
    if (!target) {
      return undefined;
    }
    return resolvePathResource(target.path, target.type);
  };

  const mountExternalScene = (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
    _node?: GodotNode,
  ): GodotSceneState | undefined => {
    const target = extTarget(scene.extResources, ref);
    if (
      !target?.path.endsWith(".tscn") ||
      !existsSync(resourcePathToFilePath(target.path))
    ) {
      return undefined;
    }
    return loadScene(target.path);
  };

  const sceneOptions = (scene: GodotSceneState): GodotProjectSceneOptions => ({
    resolveResource: (ref, node) =>
      resolveResource(sceneForNode(scene, node) ?? scene, ref, node),
    resolveResourcePath: (path) => resolvePathResource(path),
    mountExternalScene: (ref, node) =>
      mountExternalScene(sceneForNode(scene, node) ?? scene, ref, node),
    resolveTheme: (node, name) => {
      const themeRef = asResourceRef(node.properties?.theme);
      if (!themeRef) return undefined;
      const doc = resolveResource(
        sceneForNode(scene, node) ?? scene,
        themeRef,
        node,
      )?.document;
      return doc
        ? queryTheme(
            doc,
            node.type,
            asString(node.properties?.theme_type_variation),
            name,
          )
        : undefined;
    },
  });

  const resolveDocumentResource = (
    document: GodotResource,
    ref: GodotResourceRefValue,
    seen: Set<string>,
  ): GodotProjectResolvedResource | undefined => {
    if (ref.type === "SubResource") {
      const resource = document.subResources.find(
        (candidate) => candidate.id === ref.id,
      );
      return resource
        ? { type: resource.type, document: subResourceDocument(resource) }
        : undefined;
    }
    const target = extTarget(document.extResources, ref);
    return target
      ? resolvePathResource(target.path, target.type, seen)
      : undefined;
  };

  const resolvePathResource = (
    resourcePath: string,
    type?: string,
    seen: Set<string> = new Set(),
  ): GodotProjectResolvedResource | undefined => {
    if (seen.has(resourcePath)) {
      return { type, path: resourcePath, url: resourcePathToUrl(resourcePath) };
    }
    const nextSeen = new Set(seen).add(resourcePath);
    if (resourcePath.endsWith(".tscn")) {
      loadScene(resourcePath);
      return { type, path: resourcePath, url: resourcePathToUrl(resourcePath) };
    }
    if (resourcePath.endsWith(".tres") || resourcePath.endsWith(".res")) {
      const document = loadResource(resourcePath);
      const resourceType = asString(document.header?.attributes.type) ?? type;
      const baseResource = {
        type: resourceType,
        path: resourcePath,
        url: resourcePathToUrl(resourcePath),
        document,
      };
      if (resourceType === "AtlasTexture") {
        const region = asRect2(document.properties.region);
        const atlasRef = asResourceRef(document.properties.atlas);
        const atlas = atlasRef
          ? resolveDocumentResource(document, atlasRef, nextSeen)
          : undefined;
        return {
          ...baseResource,
          // An AtlasTexture has no directly renderable image of its own; its
          // pixels come from the atlas, so don't expose the .tres path as `url`.
          url: undefined,
          atlas,
          region,
          size: region
            ? { width: region.width, height: region.height }
            : atlas?.size,
        };
      }
      if (resourceType === "FontVariation") {
        const baseRef = asResourceRef(document.properties.base_font);
        const base = baseRef
          ? resolveDocumentResource(document, baseRef, nextSeen)
          : undefined;
        const variationWeight = fontWeightFromVariation(document);
        const glyphSpacing = asNumber(document.properties.spacing_glyph);
        const fontMsdf = asBoolean(
          document.properties.multichannel_signed_distance_field,
        );
        return {
          ...base,
          ...baseResource,
          fontFamily:
            base?.fontFamily ?? fontMetadataFromPath(resourcePath).fontFamily,
          fontUrl: base?.fontUrl,
          fontStyle: base?.fontStyle,
          fontWeight: variationWeight ?? base?.fontWeight,
          glyphSpacing: glyphSpacing ?? base?.glyphSpacing,
          fontMsdf: fontMsdf ?? base?.fontMsdf,
        };
      }
      if (resourceType === "FontFile") {
        const fontPath = asString(document.properties.font_path);
        const metadata = fontPath
          ? fontMetadataFromPath(fontPath)
          : fontMetadataFromPath(resourcePath);
        return {
          ...baseResource,
          fontUrl:
            fontPath && isFontPath(fontPath)
              ? resourcePathToUrl(fontPath)
              : undefined,
          fontMsdf: asBoolean(
            document.properties.multichannel_signed_distance_field,
          ),
          ...metadata,
        };
      }
      if (resourceType === "ShaderMaterial") {
        const shaderRef = asResourceRef(document.properties.shader);
        return {
          ...baseResource,
          shader: shaderRef
            ? resolveDocumentResource(document, shaderRef, nextSeen)
            : undefined,
        };
      }
      const fontPath = asString(document.properties.font_path);
      return {
        type: resourceType,
        path: resourcePath,
        url: resourcePathToUrl(resourcePath),
        fontUrl:
          fontPath && isFontPath(fontPath)
            ? resourcePathToUrl(fontPath)
            : undefined,
        document,
        ...fontMetadataFromPath(resourcePath),
      };
    }
    return {
      type,
      path: resourcePath,
      url: resourcePathToUrl(resourcePath),
      size: imageSize(resourcePath),
      fontUrl: isFontPath(resourcePath)
        ? resourcePathToUrl(resourcePath)
        : undefined,
      ...fontMetadataFromPath(resourcePath),
    };
  };

  const imageSize = (
    resourcePath: string,
  ): { width: number; height: number } | undefined => {
    if (!isImagePath(resourcePath)) {
      return undefined;
    }
    if (imageSizeCache.has(resourcePath)) {
      return imageSizeCache.get(resourcePath);
    }
    let size: { width: number; height: number } | undefined;
    try {
      size = readImageSize(
        readFileSync(resourcePathToFilePath(resourcePath)),
        resourcePath,
      );
    } catch {
      size = undefined;
    }
    imageSizeCache.set(resourcePath, size);
    return size;
  };

  const sceneForNode = (
    _scene: GodotSceneState,
    node: GodotNode,
  ): GodotSceneState | undefined => {
    const sourcePath = asString(node.properties[SOURCE_SCENE_PATH_ATTRIBUTE]);
    return sourcePath ? loadScene(sourcePath) : undefined;
  };

  return {
    projectRoot,
    resourcePathToFilePath,
    resourcePathToUrl,
    loadScene,
    loadResource,
    extResource,
    resolveResource,
    mountExternalScene,
    sceneOptions,
  };
}

function assertResourcePath(resourcePath: string): void {
  if (!resourcePath.startsWith("res://")) {
    throw new Error(
      `Expected a Godot resource path starting with res://, got ${resourcePath}`,
    );
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

function isFontPath(path: string): boolean {
  return /\.(?:ttf|otf|woff2?|ttc)$/i.test(path);
}

function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|webp|svg)$/i.test(path);
}

function fontMetadataFromPath(
  path: string,
): Partial<GodotProjectResolvedResource> {
  if (!isFontPath(path)) {
    return {};
  }
  return {
    fontFamily: path
      .split("/")
      .at(-1)
      ?.replace(/\.[^.]+$/, ""),
    fontStyle: /italic/i.test(path) ? "italic" : "normal",
    fontWeight: /bold/i.test(path) ? "700" : "400",
  };
}

function fontWeightFromVariation(document: GodotResource): number | undefined {
  const variation = document.properties.variation_opentype;
  if (
    !variation ||
    typeof variation !== "object" ||
    Array.isArray(variation) ||
    "type" in variation
  ) {
    return undefined;
  }
  return asNumber((variation as Record<string, GodotVariant>)["2003265652"]);
}

function readImageSize(
  buffer: Buffer,
  path: string,
): { width: number; height: number } | undefined {
  if (isPng(buffer)) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (/\.jpe?g$/i.test(path)) {
    return jpegSize(buffer);
  }
  if (/\.webp$/i.test(path)) {
    return webpSize(buffer);
  }
  if (/\.svg$/i.test(path)) {
    return svgSize(buffer.toString("utf8"));
  }
  return undefined;
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

function jpegSize(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      return undefined;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return undefined;
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return undefined;
}

function svgSize(
  content: string,
): { width: number; height: number } | undefined {
  const tag = content.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) {
    return undefined;
  }
  const width = svgLength(tag.match(/\bwidth=["']?([0-9.]+)/i)?.[1]);
  const height = svgLength(tag.match(/\bheight=["']?([0-9.]+)/i)?.[1]);
  if (width !== undefined && height !== undefined) {
    return { width, height };
  }
  const viewBox = tag
    .match(/\bviewBox=["']?([0-9.\s-]+)/i)?.[1]
    ?.trim()
    .split(/\s+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    return { width: viewBox[2] ?? 0, height: viewBox[3] ?? 0 };
  }
  return undefined;
}

function svgLength(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function extResourcePath(
  scene: GodotSceneState,
  ref: GodotResourceRefValue,
): string | undefined {
  if (ref.type !== "ExtResource") {
    return undefined;
  }
  return (
    ref.path ??
    scene.extResources.find((resource) => resource.id === ref.id)?.path
  );
}

export function extResourceRef(
  value: unknown,
): GodotResourceRefValue | undefined {
  return asResourceRef(value as GodotVariant | undefined);
}
