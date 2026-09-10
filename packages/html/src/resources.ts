import {
  asBoolean,
  asNumber,
  asRect2,
  asResourceRef,
  asString,
  type GodotNode,
  type GodotResource,
  type GodotVariant,
} from "@godot-scene-web/core";
import type { GodotSceneTreeNode } from "@godot-scene-web/layout";
import {
  atlasTextureDataUrl,
  atlasTextureMetrics,
  hasAtlasMargin,
  zeroAtlasMargin,
} from "./atlas";
import { isEmbeddedAssetUrl } from "./css-values";
import type {
  GodotHtmlFontFace,
  GodotHtmlRenderOptions,
  GodotResolvedResource,
} from "./types";

export function resolveFont(
  value: GodotVariant | undefined,
  node: GodotSceneTreeNode,
  options: GodotHtmlRenderOptions,
): GodotResolvedResource | undefined {
  const fontRef = asResourceRef(value);
  if (!fontRef) {
    return undefined;
  }
  const source = sourceNodeForLayout(node);
  return fontResource(
    normalizeResource(options.resolveResource?.(fontRef, source)),
    options,
    source,
  );
}

export function sourceNodeForLayout(node: GodotSceneTreeNode): GodotNode {
  return (
    node.source ?? {
      name: node.name,
      type: node.type,
      parent: node.parentPath ?? undefined,
      attributes: {},
      properties: node.properties,
    }
  );
}

export function registerFontFace(
  fontFaces: GodotHtmlFontFace[],
  font: GodotResolvedResource | undefined,
): void {
  if (!font?.fontFamily || !font.fontUrl) {
    return;
  }
  fontFaces.push({
    fontFamily: font.fontFamily,
    url: font.fontUrl,
    style: font.fontStyle ?? "normal",
    weight: String(font.fontWeight ?? "400"),
  });
}

export function uniqueFontFaces(
  fontFaces: GodotHtmlFontFace[],
): GodotHtmlFontFace[] {
  const byKey = new Map<string, GodotHtmlFontFace>();
  for (const face of fontFaces) {
    byKey.set(
      `${face.fontFamily}\n${face.url}\n${face.style}\n${face.weight}`,
      face,
    );
  }
  return [...byKey.values()];
}

export function normalizeResource(
  value: unknown,
): GodotResolvedResource | undefined {
  if (typeof value === "string") {
    return { path: value, url: value };
  }
  if (isResourceDocument(value)) {
    return { type: asString(value.header?.attributes.type), document: value };
  }
  if (value && typeof value === "object") {
    return value as GodotResolvedResource;
  }
  return undefined;
}

export function imageResource(
  resource: GodotResolvedResource | undefined,
  options: GodotHtmlRenderOptions,
  source: GodotNode,
): GodotResolvedResource {
  if (!resource) {
    return {};
  }
  const document = resource.document;
  if (
    document &&
    asString(document.header?.attributes.type) === "AtlasTexture"
  ) {
    const region = asRect2(document.properties.region);
    const margin = asRect2(document.properties.margin) ?? zeroAtlasMargin();
    const atlasRef = asResourceRef(document.properties.atlas);
    const atlas =
      resource.atlas ??
      (atlasRef
        ? normalizeResource(options.resolveResource?.(atlasRef, source))
        : undefined);
    // Resolve AtlasTexture sprites to a standalone cropped image so downstream
    // rendering treats them like any plain Texture2D (stretch modes, nine-patch,
    // tint) rather than re-deriving Godot's atlas draw rect from region/margin.
    if (resource.url) {
      // The host already provides a directly-usable sprite image (e.g. a
      // pre-cropped raster); use it as-is rather than re-embedding the atlas.
      return {
        ...resource,
        atlas,
        region: undefined,
        margin: undefined,
        size:
          resource.size ??
          (region ? atlasTextureMetrics(region, margin) : undefined),
      };
    }
    if (atlas?.url && atlas?.size && region && isEmbeddedAssetUrl(atlas.url)) {
      // Crop the region (+margin) out of the atlas into a standalone image.
      // Keep the crop inputs in `atlasCrop` so a later tint can re-bake the crop
      // and the color matrix into one flat SVG (see `assignTextureTintStyles`).
      // ONLY for an EMBEDDED (`data:`) atlas: an SVG `<image>` can rasterize its own
      // bytes but NOT an external URL (browsers load CSS-image SVGs in a restricted
      // mode that blocks external refs — see `isEmbeddedAssetUrl`). An external atlas
      // `.tres` sprite must fall through to the raw-atlas branch below and paint the
      // region via CSS `background-position`/`-size`, else it renders blank.
      return {
        ...resource,
        atlas,
        url: atlasTextureDataUrl(atlas.url, atlas.size, region, margin),
        atlasCrop: { region, margin },
        path: atlas.path ?? resource.path,
        region: undefined,
        margin: undefined,
        size: atlasTextureMetrics(region, margin),
      };
    }
    // Fall back to the raw atlas when its size is unknown: keep region/margin so
    // the texture layer can still paint the region via CSS offsets.
    return {
      ...resource,
      atlas,
      url: atlas?.url,
      path: atlas?.path ?? resource.path,
      region: resource.region ?? region,
      margin: resource.margin ?? (hasAtlasMargin(margin) ? margin : undefined),
      size:
        resource.size ??
        (region ? atlasTextureMetrics(region, margin) : undefined),
    };
  }
  return resource;
}

export function fontResource(
  resource: GodotResolvedResource | undefined,
  options: GodotHtmlRenderOptions,
  source: GodotNode,
): GodotResolvedResource {
  if (!resource) {
    return {};
  }
  const document = resource.document;
  if (
    document &&
    asString(document.header?.attributes.type) === "FontVariation"
  ) {
    const baseRef = asResourceRef(document.properties.base_font);
    const baseResource = baseRef
      ? normalizeResource(options.resolveResource?.(baseRef, source))
      : undefined;
    const base =
      baseResource?.path !== resource.path
        ? fontResource(baseResource, options, source)
        : {};
    const fontMsdf = asBoolean(
      document.properties.multichannel_signed_distance_field,
    );
    return {
      ...base,
      ...resource,
      fontFamily: resource.fontFamily ?? base.fontFamily,
      fontUrl: resource.fontUrl ?? base.fontUrl,
      fontStyle: resource.fontStyle ?? base.fontStyle,
      fontWeight:
        resource.fontWeight ??
        fontWeightFromVariation(document) ??
        base.fontWeight,
      glyphSpacing:
        resource.glyphSpacing ??
        asNumber(document.properties.spacing_glyph) ??
        base.glyphSpacing,
      fontMsdf: resource.fontMsdf ?? fontMsdf ?? base.fontMsdf,
      path: resource.path ?? base.path,
      url: resource.url ?? base.url,
    };
  }
  if (document && asString(document.header?.attributes.type) === "FontFile") {
    const fontPath = asString(document.properties.font_path);
    if (fontPath) {
      const fontUrlValue =
        resource.fontUrl ??
        (resource.url && !resource.url.startsWith("res://")
          ? resource.url
          : undefined);
      return {
        ...resource,
        fontFamily:
          resource.fontFamily ??
          fontPath
            .split("/")
            .at(-1)
            ?.replace(/\.[^.]+$/, ""),
        fontUrl: fontUrlValue,
        fontStyle: resource.fontStyle ?? fontStyleFromPath(fontPath),
        fontWeight: resource.fontWeight ?? "400",
        fontMsdf:
          resource.fontMsdf ??
          asBoolean(document.properties.multichannel_signed_distance_field),
      };
    }
  }
  return {
    ...resource,
    fontFamily:
      resource.fontFamily ??
      resource.path
        ?.split("/")
        .at(-1)
        ?.replace(/\.[^.]+$/, ""),
    fontUrl: resource.fontUrl ?? fontUrl(resource),
    fontStyle: resource.fontStyle ?? fontStyleFromPath(resource.path),
    fontWeight: resource.fontWeight ?? "400",
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

function fontUrl(resource: GodotResolvedResource): string | undefined {
  if (!resource.url || resource.url.startsWith("res://")) {
    return undefined;
  }
  return /\.(?:ttf|otf|woff2?|ttc)(?:$|[?#])/i.test(resource.url)
    ? resource.url
    : undefined;
}

function fontStyleFromPath(
  path: string | undefined,
): "normal" | "italic" | undefined {
  return path && /italic/i.test(path) ? "italic" : undefined;
}

function isResourceDocument(value: unknown): value is GodotResource {
  return Boolean(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      "properties" in value,
  );
}
