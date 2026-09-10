import {
  asBoolean,
  asNumber,
  asRect2,
  asResourceRef,
  asString,
  asVector2,
  type GodotNode,
  type GodotResource,
  type GodotResourceRefValue,
  type GodotVariant,
} from "@godot-scene-web/core";
import { atlasTextureDataUrl, atlasTextureMetrics } from "./atlas";
import {
  type ColorMatrix,
  clamp,
  colorMatrixDiagonalCss,
  colorMatrixFeValues,
  colorMatrixIsDiagonal,
  composeColorMatrix,
  cssUrl,
  escapeAttribute,
  isEmbeddedAssetUrl,
  modulateTint,
  round,
  styleAttribute,
} from "./css-values";
import { createStringLru } from "./lru";
import {
  isHiddenRawShaderFallbackMaterial,
  isWebglShaderMaterialNode,
  materialColorMatrix,
} from "./material";
import { imageResource, normalizeResource } from "./resources";
import type { GodotHtmlRenderOptions, GodotResolvedResource } from "./types";

// The shared per-render `<filter>` table is keyed by each filter's inner SVG
// markup (so a tint and a glow with identical markup dedupe to one def) and maps
// to its emitted id. `model.ts` serializes it to `{ id, markup }` and every
// renderer emits the `<filter>` once (see `tintFilterDefsMarkup`).
function registerFilterMarkup(
  tintFilters: Map<string, string>,
  markup: string,
  idPrefix: string,
): string {
  let id = tintFilters.get(markup);
  if (id === undefined) {
    id = `${idPrefix}${tintFilters.size}`;
    tintFilters.set(markup, id);
  }
  return id;
}

function registerTintFilter(
  tintFilters: Map<string, string> | undefined,
  tint: ColorMatrix | undefined,
  idPrefix: string,
): string | undefined {
  if (!tintFilters || !tint) {
    return undefined;
  }
  return registerFilterMarkup(
    tintFilters,
    `<feColorMatrix type="matrix" values="${colorMatrixFeValues(tint)}"/>`,
    idPrefix,
  );
}

/**
 * Tint a node's self layer via a CSS `filter: url(#id)` color matrix,
 * registering the matrix in the shared per-render filter table so its
 * `<filter>` def is emitted once. Used when the texture URL is external (see
 * `isEmbeddedAssetUrl`).
 */
function applyTintFilterStyle(
  style: Record<string, string>,
  attributes: Record<string, string>,
  tintFilters: Map<string, string> | undefined,
  tint: ColorMatrix | undefined,
  idPrefix: string,
): boolean {
  const id = registerTintFilter(tintFilters, tint, idPrefix);
  if (id === undefined || !tint) {
    return false;
  }
  const ref = `url(#${id})`;
  style.filter = style.filter ? `${style.filter} ${ref}` : ref;
  attributes["data-godot-texture-tint"] = "css-filter";
  // A CSS filter forces an axis-aligned raster of the layer that a ROTATED
  // ancestor then resamples (visible blur on rotated combat cards). Expose the
  // matrix + filter id so a post-mount pass (`bakeExternalTextureTints`) can
  // bake the tint into the bitmap itself and drop the filter boundary.
  attributes["data-godot-tint-filter-id"] = id;
  attributes["data-godot-tint-matrix"] = tint.rows
    .flat()
    .map((value) => String(value))
    .join(" ");
  return true;
}

export function assignTextureStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
  ninePatch: boolean,
  // The node's *outer* element style/attributes. A `clip_children` nine-patch
  // masks the node's CHILDREN, which are siblings of the self-layer in the outer
  // element — so the alpha mask must be applied there, not on the self-layer
  // (`style`), which paints nothing for CLIP_CHILDREN_ONLY and never contains the
  // children. Defaults to the self-layer when a caller does not split the two.
  outerStyle: Record<string, string> = style,
  outerAttributes: Record<string, string> = attributes,
  // Shared per-render table of color-matrix `<filter>` defs, keyed by their
  // feColorMatrix values, used to tint external textures via `filter: url(#id)`.
  tintFilters?: Map<string, string>,
  nodePath?: string,
): string | undefined {
  const texture = asResourceRef(props.texture);
  if (!texture) {
    return undefined;
  }
  const resource = normalizeResource(
    options.resolveResource?.(texture, source),
  );
  const image = imageResource(resource, options, source);
  if (!image.url) {
    return undefined;
  }
  if (image.path) {
    attributes["data-godot-resource-path"] = image.path;
  }
  // For a WebGL-eligible shader node, also expose the RAW (untinted) texture url
  // so the runtime samples the source the shader expects, regardless of the CSS
  // tint/SVG glow OR nine-patch border-image on the self-layer below (which stays
  // the fallback when the shader can't run). Needed even for nodes with no
  // background-image (e.g. a NinePatchRect fill), where the runtime relies on this
  // attribute for `COLOR.a`. Harmless on non-activated shader nodes (the
  // runtime only acts on `[data-godot-shader-webgl]`).
  if (isWebglShaderMaterialNode(props, source, options, nodePath)) {
    attributes["data-godot-shader-texture-url"] = image.url;
  }
  attributes["data-godot-resource-kind"] = ninePatch
    ? "NinePatchRect"
    : "TextureRect";
  assignTextureMetadata(style, attributes, props);
  // `COLOR *= modulate_color` runs after the shader's color transform, so the
  // modulate diagonal is the OUTER factor: M = diag(modulate) · M_material.
  const textureTint = composeColorMatrix(
    modulateTint(props),
    materialColorMatrix(attributes, props, source, options),
  );
  const tintIdPrefix = options.tintFilterIdPrefix ?? "godot-tint-";
  const externalImage = !isEmbeddedAssetUrl(image.url);

  if (ninePatch) {
    const margins = patchMargins(props);
    attributes["data-godot-patch-margins"] =
      `${margins[3]},${margins[0]},${margins[1]},${margins[2]}`;
    const axisHorizontal = asNumber(props.axis_stretch_horizontal);
    const axisVertical = asNumber(props.axis_stretch_vertical);
    if (axisHorizontal !== undefined) {
      attributes["data-godot-axis-stretch-horizontal"] = String(axisHorizontal);
    }
    if (axisVertical !== undefined) {
      attributes["data-godot-axis-stretch-vertical"] = String(axisVertical);
    }
    // A CLIP_CHILDREN_ONLY node paints nothing and only clips its children to its
    // texture's alpha shape. The embedded path bakes that shape into an `<image>`
    // SVG mask, which a sandboxed `data:` URI can't load for an EXTERNAL URL — so
    // for external textures clip with a native nine-patch mask (`mask-border` /
    // `-webkit-mask-box-image`) referencing the URL directly instead.
    if (asNumber(props.clip_children) === 1) {
      if (externalImage) {
        assignNinePatchBorderMaskStyles(
          outerStyle,
          outerAttributes,
          image,
          margins,
          axisHorizontal,
          axisVertical,
        );
      } else {
        assignNinePatchClipMaskStyles(
          outerStyle,
          outerAttributes,
          style,
          props,
          image,
          margins,
          axisHorizontal,
          axisVertical,
        );
      }
      return undefined;
    }
    const hasAxisStretch =
      (axisHorizontal !== undefined && axisHorizontal !== 0) ||
      (axisVertical !== undefined && axisVertical !== 0);
    // Per-slice spans paint each slice through an `<image>` SVG, so they only
    // work for embedded URLs. External tiled patches fall to the border-image
    // path, whose `border-image-repeat` (round/repeat) tiles without any SVG.
    const html =
      hasAxisStretch && !externalImage
        ? ninePatchHtml(
            style,
            props,
            image,
            margins,
            axisHorizontal,
            axisVertical,
            textureTint,
          )
        : undefined;
    if (html) {
      if (textureTint) {
        attributes["data-godot-texture-tint"] = "svg-color-matrix";
      }
      style.overflow = "hidden";
      return html;
    }
    const tintViaFilter = externalImage && Boolean(textureTint);
    const borderSource = tintViaFilter
      ? (image.url ?? "")
      : ninePatchBorderImageUrl(image, textureTint, attributes);
    // `border-image-slice` drops the `fill` center when two opposing slices meet
    // or overlap in the SOURCE (margin_left + margin_right >= texture width — e.g.
    // event_button.png is 284px wide with 192px L/R margins), leaving the button
    // with caps but no stretched middle. Godot instead stretches the degenerate
    // center column, so clamp the SOURCE slices to keep a >=1px center for `fill`
    // while leaving the authored margins as the destination border geometry.
    const sliceMargins = clampNinePatchSlices(
      margins,
      image.atlas?.size ?? image.size,
    );
    style["border-style"] = "solid";
    style["border-width"] = `${margins.join("px ")}px`;
    style["border-image-source"] = `url("${cssUrl(borderSource)}")`;
    style["border-image-slice"] = `${sliceMargins.join(" ")} fill`;
    style["border-image-repeat"] =
      `${axisStretchRepeat(axisHorizontal)} ${axisStretchRepeat(axisVertical)}`;
    if (sliceMargins !== margins) {
      attributes["data-godot-patch-slice-clamped"] = sliceMargins.join(",");
    }
    // External textures have no intrinsic size at string-render time, so the
    // `clampNinePatchSlices` above is a no-op — and `border-image-slice ... fill` then
    // DROPS the center for a texture whose opposing patch margins meet/overlap in the
    // source (caps render, the stretched middle does not). Mark it so a post-mount pass
    // (`clampExternalNinePatchSlices`) re-clamps once the image's natural size is known.
    // Value is the raw [top,right,bottom,left] margins.
    const sourceSize = image.atlas?.size ?? image.size;
    if (externalImage && (!sourceSize?.width || !sourceSize.height)) {
      attributes["data-godot-nine-patch-unclamped"] = margins.join(",");
    }
    // For a WebGL-eligible nine-patch shader node, publish the fill nine-patch as a
    // ready-to-use `mask-box-image` (RAW texture alpha = the SHAPE, incl. the slanted
    // end caps). The runtime clips its full-node canvas to this so the live shader
    // fills the WHOLE segment — diagonal caps included — instead of the caps falling
    // back to a static border-image. Read from this STABLE attribute, not the live
    // border-image (which the runtime clears, so a re-read after DOM reuse sees none).
    if (
      image.url &&
      isWebglShaderMaterialNode(props, source, options, nodePath)
    ) {
      attributes["data-godot-shader-fill-mask"] =
        `url("${cssUrl(image.url)}") ${sliceMargins.join(" ")} fill / ` +
        `${margins.join("px ")}px / 0 ` +
        `${axisStretchRepeat(axisHorizontal)} ${axisStretchRepeat(axisVertical)}`;
    }
    if (tintViaFilter) {
      applyTintFilterStyle(
        style,
        attributes,
        tintFilters,
        textureTint,
        tintIdPrefix,
      );
    }
    return undefined;
  }

  if (asNumber(props.clip_children) === 1) {
    assignTextureRectClipMaskStyles(outerStyle, outerAttributes, image, props);
    return undefined;
  }

  style["background-image"] = `url("${cssUrl(image.url)}")`;
  style["background-repeat"] = textureRepeat(
    asNumber(props.texture_repeat),
    asNumber(props.stretch_mode),
  );
  const region =
    image.region ?? (ninePatch ? asRect2(props.region_rect) : undefined);
  if (region) {
    // AtlasTexture sprites are pre-cropped to standalone images in
    // `imageResource`, so `image.region` only survives when the atlas size was
    // unknown (raw fallback) or for a NinePatchRect `region_rect`.
    attributes[
      image.region ? "data-godot-atlas-region" : "data-godot-region-rect"
    ] = `${region.x},${region.y},${region.width},${region.height}`;
    const margin = image.region ? image.margin : undefined;
    assignRegionBackgroundStyles(
      style,
      region,
      image.atlas?.size,
      asNumber(props.stretch_mode),
      margin,
    );
  } else {
    style["background-size"] = stretchModeBackgroundSize(
      asNumber(props.stretch_mode),
    );
    style["background-position"] = "center";
  }
  if (isHiddenRawShaderFallbackMaterial(props, source, options, nodePath)) {
    delete style["background-image"];
    delete style.filter;
    delete attributes["data-godot-texture-tint"];
    attributes["data-godot-shader-raw-fallback"] = "hidden";
    return undefined;
  }
  // Consumer-supplied static-fallback filter (e.g. an animated glow approximating an
  // un-runnable shader). The consumer owns the SVG primitives + any baked colors; we
  // register the inner markup and reference it. See `shaderFallbackFiltersByPath`.
  const fallbackFilterMarkup = nodePath
    ? options.shaderFallbackFiltersByPath?.[nodePath]
    : undefined;
  if (fallbackFilterMarkup && tintFilters) {
    const filterId = registerFilterMarkup(
      tintFilters,
      fallbackFilterMarkup,
      tintIdPrefix,
    );
    const ref = `url(#${filterId})`;
    style.filter = style.filter ? `${style.filter} ${ref}` : ref;
    attributes["data-godot-texture-tint"] = "shader-fallback-filter";
    return undefined;
  }
  assignTextureTintStyles(
    style,
    attributes,
    image,
    textureTint,
    tintFilters,
    tintIdPrefix,
  );
  return undefined;
}

function assignTextureRectClipMaskStyles(
  outerStyle: Record<string, string>,
  outerAttributes: Record<string, string>,
  image: GodotResolvedResource,
  props: Record<string, GodotVariant>,
): void {
  if (!image.url) return;
  const url = `url("${cssUrl(image.url)}")`;
  outerStyle.overflow = "hidden";
  outerStyle["-webkit-mask-image"] = url;
  outerStyle["mask-image"] = url;
  outerStyle["-webkit-mask-repeat"] = "no-repeat";
  outerStyle["mask-repeat"] = "no-repeat";
  outerStyle["-webkit-mask-position"] = "center";
  outerStyle["mask-position"] = "center";
  const size = stretchModeBackgroundSize(asNumber(props.stretch_mode));
  outerStyle["-webkit-mask-size"] = size;
  outerStyle["mask-size"] = size;
  outerStyle["mask-mode"] = "alpha";
  outerAttributes["data-godot-clip-mask"] = "texture-alpha";
}

function ninePatchBorderImageUrl(
  image: GodotResolvedResource,
  tint: ColorMatrix | undefined,
  attributes: Record<string, string>,
): string {
  if (!tint || !image.url) {
    return image.url ?? "";
  }
  const textureSize = image.atlas?.size ?? image.size;
  if (!textureSize?.width || !textureSize.height) {
    attributes["data-godot-texture-tint"] = "missing-image-size";
    return image.url;
  }
  attributes["data-godot-texture-tint"] = "svg-color-matrix";
  return svgImageDataUrl(
    image.url,
    textureSize,
    { x: 0, y: 0, width: textureSize.width, height: textureSize.height },
    tint,
  );
}

// Clamp opposing nine-patch SOURCE slices [top, right, bottom, left] so they fit
// inside the texture with a >=1px center for the `border-image-slice` fill region.
// CSS collapses the fill center when a pair meets/overlaps (a + b >= dim); Godot
// keeps a (degenerate) stretched center instead, so scale an overflowing pair
// down proportionally. Returns the original tuple unchanged when nothing overflows
// or the texture size is unknown (preserving the prior border-image behavior).
export function clampNinePatchSlices(
  margins: [number, number, number, number],
  size: { width: number; height: number } | undefined,
): [number, number, number, number] {
  if (!size?.width || !size.height) {
    return margins;
  }
  const [top, right, bottom, left] = margins;
  const [clampedTop, clampedBottom] = clampSlicePair(top, bottom, size.height);
  const [clampedLeft, clampedRight] = clampSlicePair(left, right, size.width);
  if (
    clampedTop === top &&
    clampedRight === right &&
    clampedBottom === bottom &&
    clampedLeft === left
  ) {
    return margins;
  }
  return [clampedTop, clampedRight, clampedBottom, clampedLeft];
}

function clampSlicePair(a: number, b: number, dim: number): [number, number] {
  const total = a + b;
  const maxTotal = dim - 1; // leave >=1px center for the `fill` region
  if (total <= maxTotal || total <= 0) {
    return [a, b];
  }
  const scale = maxTotal / total;
  return [Math.floor(a * scale), Math.floor(b * scale)];
}

function assignNinePatchClipMaskStyles(
  // The element that hosts the node's children (the outer element); the alpha
  // mask is written here so it actually clips them.
  maskStyle: Record<string, string>,
  attributes: Record<string, string>,
  // The self-layer style, used only to read the node's box dimensions (it shares
  // the node rect with the outer element).
  boxStyle: Record<string, string>,
  props: Record<string, GodotVariant>,
  image: GodotResolvedResource,
  margins: [number, number, number, number],
  axisHorizontal: number | undefined,
  axisVertical: number | undefined,
): void {
  maskStyle.overflow = "hidden";
  const maskUrl = ninePatchMaskDataUrl(
    boxStyle,
    props,
    image,
    margins,
    axisHorizontal,
    axisVertical,
  );
  if (!maskUrl) {
    attributes["data-godot-clip-mask"] = "missing-image-size";
    return;
  }
  const imageValue = `url("${cssUrl(maskUrl)}")`;
  attributes["data-godot-clip-mask"] = "nine-patch-alpha";
  maskStyle["mask-image"] = imageValue;
  maskStyle["mask-size"] = "100% 100%";
  maskStyle["mask-repeat"] = "no-repeat";
  maskStyle["mask-position"] = "0 0";
  maskStyle["mask-mode"] = "alpha";
  maskStyle["-webkit-mask-image"] = imageValue;
  maskStyle["-webkit-mask-size"] = maskStyle["mask-size"];
  maskStyle["-webkit-mask-repeat"] = maskStyle["mask-repeat"];
  maskStyle["-webkit-mask-position"] = maskStyle["mask-position"];
  maskStyle["-webkit-mask-mode"] = maskStyle["mask-mode"];
}

// External-texture analogue of `assignNinePatchClipMaskStyles`: a `data:` SVG mask
// can't load an external `<image href>` (sandbox), so clip the children with a NATIVE
// nine-patch mask (`mask-border` / `-webkit-mask-box-image`) that references the URL
// directly. Mirrors the border-image slice/width geometry (so the rounded capsule is
// preserved), but masks — clips children, paints nothing — instead of drawing the
// texture, so a CLIP_CHILDREN_ONLY node (e.g. the health-bar capsule `Mask`) clips its
// fill to the rounded shape without rendering the white capsule itself.
function assignNinePatchBorderMaskStyles(
  // The child-hosting (outer) element style/attributes — the mask must live here to
  // clip the children, which are siblings of the (empty) self-layer.
  maskStyle: Record<string, string>,
  attributes: Record<string, string>,
  image: GodotResolvedResource,
  margins: [number, number, number, number],
  axisHorizontal: number | undefined,
  axisVertical: number | undefined,
): void {
  if (!image.url) {
    attributes["data-godot-clip-mask"] = "missing-image-size";
    return;
  }
  maskStyle.overflow = "hidden";
  // Clamp the SOURCE slices like the border-image path so a pair that meets/overlaps
  // (margin_left + margin_right >= texture width — e.g. the 12px-wide capsule with 6+6
  // margins) keeps a >=1px `fill` center instead of collapsing it.
  const sliceMargins = clampNinePatchSlices(
    margins,
    image.atlas?.size ?? image.size,
  );
  const source = `url("${cssUrl(image.url)}")`;
  const slice = `${sliceMargins.join(" ")} fill`;
  const width = `${margins.join("px ")}px`;
  const repeat = `${axisStretchRepeat(axisHorizontal)} ${axisStretchRepeat(axisVertical)}`;
  attributes["data-godot-clip-mask"] = "nine-patch-border";
  // `-webkit-mask-box-image` (Blink/WebKit, the renderer's targets — matching the
  // `-webkit-mask-*` already emitted above). Shorthand: source slice/width/outset repeat.
  maskStyle["-webkit-mask-box-image"] =
    `${source} ${slice} / ${width} / 0 ${repeat}`;
  // Standard longhands for forward-compat (`mask-border-mode` defaults to `alpha`; the
  // capsule texture's alpha is the clip shape).
  maskStyle["mask-border-source"] = source;
  maskStyle["mask-border-slice"] = slice;
  maskStyle["mask-border-width"] = width;
  maskStyle["mask-border-outset"] = "0";
  maskStyle["mask-border-repeat"] = repeat;
  maskStyle["mask-border-mode"] = "alpha";
}

function assignTextureTintStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  resolved: GodotResolvedResource,
  tint: ColorMatrix | undefined,
  tintFilters: Map<string, string> | undefined,
  idPrefix: string,
): void {
  if (!tint || !resolved.url) {
    return;
  }
  // External URLs can't be baked into an `<image>` SVG (see isEmbeddedAssetUrl);
  // the plain background-image is already set, so tint it via a CSS color-matrix
  // filter on the self layer instead.
  if (
    !isEmbeddedAssetUrl(resolved.url) &&
    applyTintFilterStyle(style, attributes, tintFilters, tint, idPrefix)
  ) {
    return;
  }
  // An AtlasTexture is pre-cropped into a standalone SVG (`imageResource`), so
  // routing it through `svgImageDataUrl` below would wrap that SVG inside another
  // SVG `<image>` — a nested SVG-data-URI that browsers refuse to rasterize as a
  // CSS background (the tinted sprite renders blank). Rebuild the crop and bake
  // the tint into ONE flat SVG instead (the `feColorMatrix` on the raster image,
  // exactly like the plain-texture path below), keeping the cropped intrinsic
  // size so the existing stretch background-size/position is unchanged.
  if (resolved.atlasCrop && resolved.atlas?.url && resolved.atlas.size) {
    const tinted = atlasTextureDataUrl(
      resolved.atlas.url,
      resolved.atlas.size,
      resolved.atlasCrop.region,
      resolved.atlasCrop.margin,
      tint,
    );
    style["background-image"] = `url("${cssUrl(tinted)}")`;
    attributes["data-godot-texture-tint"] = "svg-color-matrix";
    return;
  }
  // Bake the color matrix into the image via SVG `feColorMatrix`. This
  // multiplies RGB per-pixel and PRESERVES alpha — matching Godot's shader
  // (`col.rgb *= v` before the texture alpha) and `modulate`. The
  // `background-color` + `background-blend-mode: multiply` + alpha-mask recipe is
  // NOT equivalent: its opaque tint fills the whole element and is only clipped
  // by the texture alpha, so anti-aliased edges bleed a gray/colored halo. The
  // matrix is per-pixel, so the existing background-size/position (region
  // cropping, stretch) still applies — the SVG keeps the same intrinsic size as
  // the original url (`resolved.size`; the raw-atlas fallback keeps a region and
  // draws the whole atlas, so use the atlas size there).
  const naturalSize = resolved.region
    ? (resolved.atlas?.size ?? resolved.size)
    : resolved.size;
  if (naturalSize?.width && naturalSize.height) {
    const tinted = svgImageDataUrl(
      resolved.url,
      naturalSize,
      { x: 0, y: 0, width: naturalSize.width, height: naturalSize.height },
      tint,
    );
    style["background-image"] = `url("${cssUrl(tinted)}")`;
    attributes["data-godot-texture-tint"] = "svg-color-matrix";
    return;
  }
  // Fallback when the texture size is unknown (cannot build the SVG): a diagonal
  // tint can still be approximated with blend-multiply + alpha mask (a
  // non-diagonal matrix has no such fallback).
  if (!colorMatrixIsDiagonal(tint)) {
    attributes["data-godot-texture-tint"] = "missing-image-size";
    return;
  }
  const image = `url("${cssUrl(resolved.url)}")`;
  style["background-color"] = colorMatrixDiagonalCss(tint);
  style["background-blend-mode"] = "multiply";
  style["mask-image"] = image;
  style["mask-size"] = style["background-size"] ?? "auto";
  style["mask-repeat"] = style["background-repeat"] ?? "no-repeat";
  style["mask-position"] = style["background-position"] ?? "center";
  style["-webkit-mask-image"] = image;
  style["-webkit-mask-size"] = style["mask-size"];
  style["-webkit-mask-repeat"] = style["mask-repeat"];
  style["-webkit-mask-position"] = style["mask-position"];
  attributes["data-godot-texture-tint"] = "multiply";
}

// Pure region→CSS math: paint a sub-rect of a STABLE atlas image by shifting the CSS viewport
// (background-position/size) rather than swapping the image URL. Godot draws the `region` at `margin`'s
// position inside a box of `region.size + margin.size`. With no `box`/`atlasSize` the image renders at native
// pixels (`background-size: auto`); with both, it's scaled to the box per Godot's stretch mode. Exported so
// consumers that own their own element styling (e.g. the live-tree mirror) reuse the exact same crop math
// instead of re-deriving it — keeping atlas-animated sprites (intent icons) flicker-free with one URL.
export function regionBackgroundStyle(
  region: { x: number; y: number; width: number; height: number },
  options: {
    margin?: { x: number; y: number; width: number; height: number };
    atlasSize?: { width: number; height: number };
    box?: { width: number; height: number };
    stretchMode?: number;
  } = {},
): { backgroundPosition: string; backgroundSize: string } {
  const { margin, atlasSize, box, stretchMode } = options;
  const texture = atlasTextureMetrics(region, margin);
  if (
    !atlasSize ||
    !box ||
    !box.width ||
    !box.height ||
    texture.width <= 0 ||
    texture.height <= 0
  ) {
    return {
      backgroundPosition: `${-(region.x - (margin?.x ?? 0))}px ${-(region.y - (margin?.y ?? 0))}px`,
      backgroundSize: "auto",
    };
  }
  const draw = textureDrawRect(box, texture, stretchMode);
  return {
    backgroundPosition: `${round(draw.x - (region.x - (margin?.x ?? 0)) * draw.scaleX)}px ${round(draw.y - (region.y - (margin?.y ?? 0)) * draw.scaleY)}px`,
    backgroundSize: `${round(atlasSize.width * draw.scaleX)}px ${round(atlasSize.height * draw.scaleY)}px`,
  };
}

function assignRegionBackgroundStyles(
  style: Record<string, string>,
  region: { x: number; y: number; width: number; height: number },
  atlasSize: { width: number; height: number } | undefined,
  stretchMode: number | undefined,
  margin?: { x: number; y: number; width: number; height: number },
): void {
  const boxWidth = cssSize(style.width);
  const boxHeight = cssSize(style.height);
  const { backgroundPosition, backgroundSize } = regionBackgroundStyle(region, {
    margin,
    atlasSize,
    box: boxWidth && boxHeight ? { width: boxWidth, height: boxHeight } : undefined,
    stretchMode,
  });
  style["background-position"] = backgroundPosition;
  style["background-size"] = backgroundSize;
}

function textureDrawRect(
  box: { width: number; height: number },
  texture: { width: number; height: number },
  stretchMode: number | undefined,
): { x: number; y: number; scaleX: number; scaleY: number } {
  if (stretchMode === 2 || stretchMode === 3) {
    return {
      x: stretchMode === 3 ? (box.width - texture.width) / 2 : 0,
      y: stretchMode === 3 ? (box.height - texture.height) / 2 : 0,
      scaleX: 1,
      scaleY: 1,
    };
  }
  if (stretchMode === 4 || stretchMode === 5) {
    const scale = Math.min(
      box.width / texture.width,
      box.height / texture.height,
    );
    return {
      x: stretchMode === 5 ? (box.width - texture.width * scale) / 2 : 0,
      y: stretchMode === 5 ? (box.height - texture.height * scale) / 2 : 0,
      scaleX: scale,
      scaleY: scale,
    };
  }
  return {
    x: 0,
    y: 0,
    scaleX: box.width / texture.width,
    scaleY: box.height / texture.height,
  };
}

function cssSize(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ninePatchHtml(
  style: Record<string, string>,
  props: Record<string, GodotVariant>,
  image: GodotResolvedResource,
  margins: [number, number, number, number],
  axisHorizontal: number | undefined,
  axisVertical: number | undefined,
  tint: ColorMatrix | undefined,
): string | undefined {
  const patch = ninePatchLayers(
    style,
    props,
    image,
    margins,
    axisHorizontal,
    axisVertical,
  );
  if (!patch || !image.url) {
    return undefined;
  }
  return patch.layers
    .map((layer) =>
      ninePatchLayerHtml({
        imageUrl: image.url ?? "",
        atlasSize: patch.textureSize,
        source: layer.source,
        dest: layer.dest,
        modeX: layer.modeX,
        modeY: layer.modeY,
        tint,
      }),
    )
    .join("");
}

function ninePatchLayers(
  style: Record<string, string>,
  props: Record<string, GodotVariant>,
  image: GodotResolvedResource,
  margins: [number, number, number, number],
  axisHorizontal: number | undefined,
  axisVertical: number | undefined,
):
  | {
      box: { width: number; height: number };
      textureSize: { width: number; height: number };
      layers: Array<{
        source: { x: number; y: number; width: number; height: number };
        dest: { x: number; y: number; width: number; height: number };
        modeX: number;
        modeY: number;
      }>;
    }
  | undefined {
  const boxWidth = cssSize(style.width);
  const boxHeight = cssSize(style.height);
  const textureSize = image.atlas?.size ?? image.size;
  if (!boxWidth || !boxHeight || !textureSize?.width || !textureSize.height) {
    return undefined;
  }
  const region = image.region ?? asRect2(props.region_rect);
  // The authored `region_rect` drives ALL nine-patch geometry — tile widths,
  // corner sizes, and dest positions — exactly as Godot does, even when the
  // region overflows the texture (e.g. a 116x85 region over a 114x82 image).
  // The texture-edge clamp for the overflow is applied per-slice below.
  const source =
    region && region.width > 0 && region.height > 0
      ? region
      : { x: 0, y: 0, width: textureSize.width, height: textureSize.height };
  const [top, right, bottom, left] = margins;
  const centerSourceWidth = Math.max(0, source.width - left - right);
  const centerSourceHeight = Math.max(0, source.height - top - bottom);
  const centerSourceColumn = centerPatchSourceSegment(
    source.x + left,
    centerSourceWidth,
    source.x,
    source.width,
  );
  const centerSourceRow = centerPatchSourceSegment(
    source.y + top,
    centerSourceHeight,
    source.y,
    source.height,
  );
  const centerDestWidth = Math.max(0, boxWidth - left - right);
  const centerDestHeight = Math.max(0, boxHeight - top - bottom);
  const columns = [
    {
      sourceStart: source.x,
      sourceSize: left,
      destStart: 0,
      destSize: left,
      mode: 0,
    },
    {
      sourceStart: centerSourceColumn.start,
      sourceSize: centerSourceColumn.size,
      destStart: left,
      destSize: centerDestWidth,
      mode: axisHorizontal ?? 0,
    },
    {
      sourceStart: source.x + source.width - right,
      sourceSize: right,
      destStart: boxWidth - right,
      destSize: right,
      mode: 0,
    },
  ];
  const rows = [
    {
      sourceStart: source.y,
      sourceSize: top,
      destStart: 0,
      destSize: top,
      mode: 0,
    },
    {
      sourceStart: centerSourceRow.start,
      sourceSize: centerSourceRow.size,
      destStart: top,
      destSize: centerDestHeight,
      mode: axisVertical ?? 0,
    },
    {
      sourceStart: source.y + source.height - bottom,
      sourceSize: bottom,
      destStart: boxHeight - bottom,
      destSize: bottom,
      mode: 0,
    },
  ];
  const drawCenter = asBoolean(props.draw_center) ?? true;
  const layers: Array<{
    source: { x: number; y: number; width: number; height: number };
    dest: { x: number; y: number; width: number; height: number };
    modeX: number;
    modeY: number;
  }> = [];
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < columns.length; column += 1) {
      if (!drawCenter && row === 1 && column === 1) {
        continue;
      }
      const x = columns[column];
      const y = rows[row];
      if (
        !x ||
        !y ||
        x.sourceSize <= 0 ||
        y.sourceSize <= 0 ||
        x.destSize <= 0 ||
        y.destSize <= 0
      ) {
        continue;
      }
      // Clamp ONLY this slice's source rect to the texture (Godot's
      // CLAMP_TO_EDGE). The dest is left at the authored-region position, so the
      // dest/source scale in `ninePatchLayerHtml` stretches the valid edge pixels
      // to fill it instead of leaving the 2-3px texture overflow transparent. A
      // slice that sits fully past the edge (a large region overflow) clamps to
      // the 1px boundary texel rather than collapsing to 0, so the trailing
      // caps/center keep drawing (never blank) and TILE tiling never divides by a
      // zero slice width. A no-op for in-bounds slices (the common case and the
      // center tile).
      const source = clampSliceSourceToTexture(
        {
          x: x.sourceStart,
          y: y.sourceStart,
          width: x.sourceSize,
          height: y.sourceSize,
        },
        textureSize,
      );
      layers.push({
        source,
        dest: {
          x: x.destStart,
          y: y.destStart,
          width: x.destSize,
          height: y.destSize,
        },
        modeX: x.mode,
        modeY: y.mode,
      });
    }
  }
  return {
    box: { width: boxWidth, height: boxHeight },
    textureSize,
    layers,
  };
}

function clampSliceSourceToTexture(
  source: { x: number; y: number; width: number; height: number },
  textureSize: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  // Intersect the slice's source rect with the texture, but never let it
  // collapse below 1px. A slice fully past the texture edge (a large region
  // overflow) clamps to the boundary texel — Godot's CLAMP_TO_EDGE — so it still
  // paints (stretched/tiled to its authored dest) instead of being dropped, and
  // the TILE `background-size` / axis scale never see a zero source width. A
  // no-op for the in-bounds case (`x0 === source.x`, `width` unchanged).
  const x0 = Math.min(
    Math.max(source.x, 0),
    Math.max(0, textureSize.width - 1),
  );
  const y0 = Math.min(
    Math.max(source.y, 0),
    Math.max(0, textureSize.height - 1),
  );
  const x1 = Math.min(source.x + source.width, textureSize.width);
  const y1 = Math.min(source.y + source.height, textureSize.height);
  return {
    x: x0,
    y: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
  };
}

function centerPatchSourceSegment(
  start: number,
  size: number,
  sourceStart: number,
  sourceSize: number,
): { start: number; size: number } {
  if (size > 0) {
    return { start, size };
  }
  return {
    start: clamp(start, sourceStart, sourceStart + Math.max(0, sourceSize - 1)),
    size: 1,
  };
}

function ninePatchLayerHtml(options: {
  imageUrl: string;
  atlasSize: { width: number; height: number };
  source: { x: number; y: number; width: number; height: number };
  dest: { x: number; y: number; width: number; height: number };
  modeX: number;
  modeY: number;
  tint: ColorMatrix | undefined;
}): string {
  const scaleX = ninePatchAxisScale(
    options.dest.width,
    options.source.width,
    options.modeX,
  );
  const scaleY = ninePatchAxisScale(
    options.dest.height,
    options.source.height,
    options.modeY,
  );
  const repeatX = options.modeX === 1 || options.modeX === 2;
  const repeatY = options.modeY === 1 || options.modeY === 2;
  const sliceUrl = svgSliceDataUrl(
    options.imageUrl,
    options.atlasSize,
    options.source,
    options.tint,
  );
  const repeat = `${repeatX ? "repeat" : "no-repeat"} ${repeatY ? "repeat" : "no-repeat"}`;
  const backgroundSize = `${round(options.source.width * scaleX)}px ${round(options.source.height * scaleY)}px`;
  const sliceImage = `url("${cssUrl(sliceUrl)}")`;
  const layerStyle: Record<string, string> = {
    position: "absolute",
    left: `${round(options.dest.x)}px`,
    top: `${round(options.dest.y)}px`,
    width: `${round(options.dest.width)}px`,
    height: `${round(options.dest.height)}px`,
    overflow: "hidden",
    "background-image": sliceImage,
    "background-repeat": repeat,
    "background-size": backgroundSize,
  };
  return `<span aria-hidden="true" data-godot-nine-patch-slice="true" style="${escapeAttribute(styleAttribute(layerStyle))}"></span>`;
}

function ninePatchAxisScale(
  destSize: number,
  sourceSize: number,
  mode: number,
): number {
  if (sourceSize <= 0) {
    return 1;
  }
  if (mode === 1) {
    return 1;
  }
  if (mode === 2) {
    const count = Math.max(1, Math.round(destSize / sourceSize));
    return destSize / count / sourceSize;
  }
  return destSize / sourceSize;
}

function svgSliceDataUrl(
  imageUrl: string,
  atlasSize: { width: number; height: number },
  source: { x: number; y: number; width: number; height: number },
  tint: ColorMatrix | undefined,
): string {
  return svgImageDataUrl(imageUrl, atlasSize, source, tint);
}

function ninePatchMaskDataUrl(
  style: Record<string, string>,
  props: Record<string, GodotVariant>,
  image: GodotResolvedResource,
  margins: [number, number, number, number],
  axisHorizontal: number | undefined,
  axisVertical: number | undefined,
): string | undefined {
  if (!image.url) {
    return undefined;
  }
  const patch = ninePatchLayers(
    style,
    props,
    image,
    margins,
    axisHorizontal,
    axisVertical,
  );
  if (!patch) {
    return undefined;
  }
  const defs: string[] = [];
  const shapes = patch.layers
    .map((layer, index) =>
      ninePatchMaskLayerSvg({
        id: `godot-nine-patch-mask-${index}`,
        imageUrl: image.url ?? "",
        atlasSize: patch.textureSize,
        source: layer.source,
        dest: layer.dest,
        modeX: layer.modeX,
        modeY: layer.modeY,
        defs,
      }),
    )
    .join("");
  const defsSvg = defs.length > 0 ? `<defs>${defs.join("")}</defs>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${round(patch.box.width)}" height="${round(patch.box.height)}" viewBox="0 0 ${round(patch.box.width)} ${round(patch.box.height)}">${defsSvg}${shapes}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function ninePatchMaskLayerSvg(options: {
  id: string;
  imageUrl: string;
  atlasSize: { width: number; height: number };
  source: { x: number; y: number; width: number; height: number };
  dest: { x: number; y: number; width: number; height: number };
  modeX: number;
  modeY: number;
  defs: string[];
}): string {
  const scaleX = ninePatchAxisScale(
    options.dest.width,
    options.source.width,
    options.modeX,
  );
  const scaleY = ninePatchAxisScale(
    options.dest.height,
    options.source.height,
    options.modeY,
  );
  const repeatX = options.modeX === 1 || options.modeX === 2;
  const repeatY = options.modeY === 1 || options.modeY === 2;
  if (repeatX || repeatY) {
    const width = repeatX
      ? round(options.source.width * scaleX)
      : round(options.dest.width);
    const height = repeatY
      ? round(options.source.height * scaleY)
      : round(options.dest.height);
    options.defs.push(
      `<pattern id="${options.id}" patternUnits="userSpaceOnUse" x="${round(options.dest.x)}" y="${round(options.dest.y)}" width="${width}" height="${height}"><svg width="${width}" height="${height}" viewBox="${round(options.source.x)} ${round(options.source.y)} ${round(options.source.width)} ${round(options.source.height)}" preserveAspectRatio="none"><image href="${escapeAttribute(options.imageUrl)}" x="0" y="0" width="${round(options.atlasSize.width)}" height="${round(options.atlasSize.height)}"/></svg></pattern>`,
    );
    return `<rect x="${round(options.dest.x)}" y="${round(options.dest.y)}" width="${round(options.dest.width)}" height="${round(options.dest.height)}" fill="url(#${options.id})"/>`;
  }
  return `<svg x="${round(options.dest.x)}" y="${round(options.dest.y)}" width="${round(options.dest.width)}" height="${round(options.dest.height)}" viewBox="${round(options.source.x)} ${round(options.source.y)} ${round(options.source.width)} ${round(options.source.height)}" preserveAspectRatio="none"><image href="${escapeAttribute(options.imageUrl)}" x="0" y="0" width="${round(options.atlasSize.width)}" height="${round(options.atlasSize.height)}"/></svg>`;
}

// Memo for the SVG `<image>` crop/tint URLs (module-scoped LRU, mirroring `atlas.ts`'s). WHY:
// the same handful of sprites re-serialize the same SVG + `encodeURIComponent` on every render;
// this is one of the repeated tint-URL builds phone traces showed inside a play-a-card burst.
// Pure string→string, so a hit is byte-identical to a fresh build.
const SVG_IMAGE_DATA_URL_CACHE_LIMIT = 200;
const svgImageDataUrlCache = createStringLru<string>(
  SVG_IMAGE_DATA_URL_CACHE_LIMIT,
);

/** TEST-ONLY: clear the SVG image data-URL memo so a test starts from an empty cache. */
export function __resetSvgImageDataUrlCacheForTest(): void {
  svgImageDataUrlCache.clear();
}

function svgImageDataUrl(
  imageUrl: string,
  atlasSize: { width: number; height: number },
  source: { x: number; y: number; width: number; height: number },
  tint: ColorMatrix | undefined,
): string {
  // Fixed-arity numeric fields first, the arbitrary-content url last (see atlas.ts).
  const key =
    `${atlasSize.width},${atlasSize.height}` +
    `|${source.x},${source.y},${source.width},${source.height}` +
    `|${tint ? tint.rows.map((row) => row.join(",")).join(";") : ""}` +
    `|${imageUrl}`;
  const hit = svgImageDataUrlCache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const url = buildSvgImageDataUrl(imageUrl, atlasSize, source, tint);
  svgImageDataUrlCache.set(key, url);
  return url;
}

function buildSvgImageDataUrl(
  imageUrl: string,
  atlasSize: { width: number; height: number },
  source: { x: number; y: number; width: number; height: number },
  tint: ColorMatrix | undefined,
): string {
  const filterId = "godot-texture-tint";
  const filter = tint
    ? `<filter id="${filterId}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${colorMatrixFeValues(tint)}"/></filter>`
    : "";
  const defs = filter ? `<defs>${filter}</defs>` : "";
  const filterAttr = filter ? ` filter="url(#${filterId})"` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${round(source.width)}" height="${round(source.height)}" viewBox="0 0 ${round(source.width)} ${round(source.height)}">${defs}<image href="${escapeAttribute(imageUrl)}" x="${round(-source.x)}" y="${round(-source.y)}" width="${round(atlasSize.width)}" height="${round(atlasSize.height)}"${filterAttr}/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function assignTextureMetadata(
  style: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
): void {
  const repeat = asNumber(props.texture_repeat);
  const filter = asNumber(props.texture_filter);
  const expandMode = asNumber(props.expand_mode);
  if (repeat !== undefined) {
    attributes["data-godot-texture-repeat"] = String(repeat);
  }
  if (filter !== undefined) {
    attributes["data-godot-texture-filter"] = String(filter);
    if (filter === 1) {
      style["image-rendering"] = "pixelated";
    }
  }
  if (expandMode !== undefined) {
    attributes["data-godot-expand-mode"] = String(expandMode);
  }
}

export function assignAnimatedSpriteStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): void {
  attributes["data-godot-resource-kind"] = "AnimatedSprite2D";
  const framesRef = asResourceRef(props.sprite_frames);
  if (!framesRef) {
    return;
  }
  const frames = normalizeResource(
    options.resolveResource?.(framesRef, source),
  );
  if (frames?.path) {
    attributes["data-godot-sprite-frames-path"] = frames.path;
  }
  const selection = selectedSpriteFrame(frames?.document, props);
  if (!selection) {
    return;
  }
  attributes["data-godot-sprite-animation"] = selection.animation;
  attributes["data-godot-sprite-frame"] = String(selection.frame);
  attributes["data-godot-sprite-frame-count"] = String(selection.frameCount);
  const textureRef = spriteFrameTextureRef(selection.value);
  if (!textureRef) {
    return;
  }
  const image = imageResource(
    normalizeResource(options.resolveResource?.(textureRef, source)),
    options,
    source,
  );
  if (image.path) {
    attributes["data-godot-resource-path"] = image.path;
  }
  const size = animatedSpriteFrameSize(image);
  if (size) {
    const offset = asVector2(props.offset) ?? { x: 0, y: 0 };
    const centered = asBoolean(props.centered) ?? true;
    const left = cssSize(style.left) ?? 0;
    const top = cssSize(style.top) ?? 0;
    style.left = `${round(left + offset.x - (centered ? size.width / 2 : 0))}px`;
    style.top = `${round(top + offset.y - (centered ? size.height / 2 : 0))}px`;
    style.width = `${round(Math.max(1, size.width))}px`;
    style.height = `${round(Math.max(1, size.height))}px`;
  }
  if (!image.url) {
    return;
  }
  style["background-image"] = `url("${cssUrl(image.url)}")`;
  style["background-repeat"] = "no-repeat";
  if (image.region) {
    const textureSize = image.atlas?.size ?? image.size;
    attributes["data-godot-atlas-region"] =
      `${image.region.x},${image.region.y},${image.region.width},${image.region.height}`;
    style["background-position"] =
      `${round(-image.region.x)}px ${round(-image.region.y)}px`;
    style["background-size"] = textureSize
      ? `${round(textureSize.width)}px ${round(textureSize.height)}px`
      : "auto";
  } else {
    style["background-size"] = "100% 100%";
    style["background-position"] = "center";
  }
}

function selectedSpriteFrame(
  document: GodotResource | undefined,
  props: Record<string, GodotVariant>,
):
  | {
      animation: string;
      frame: number;
      frameCount: number;
      value: GodotVariant | undefined;
    }
  | undefined {
  const animations = spriteAnimations(document);
  if (animations.length === 0) {
    return undefined;
  }
  const requestedAnimation = stringOrStringName(props.animation) ?? "default";
  const animation =
    animations.find((candidate) => candidate.name === requestedAnimation) ??
    animations[0];
  if (!animation) {
    return undefined;
  }
  const frameCount = animation.frames.length;
  const rawFrame = Math.floor(asNumber(props.frame) ?? 0);
  const frame = frameCount > 0 ? clamp(rawFrame, 0, frameCount - 1) : 0;
  return {
    animation: animation.name,
    frame,
    frameCount,
    value: animation.frames[frame],
  };
}

function spriteAnimations(
  document: GodotResource | undefined,
): Array<{ name: string; frames: GodotVariant[] }> {
  const animations = document?.properties.animations;
  if (!Array.isArray(animations)) {
    return [];
  }
  return animations.flatMap((value) => {
    const animation = plainRecord(value);
    const name = stringOrStringName(animation?.name);
    const frames = animation?.frames;
    return name !== undefined && Array.isArray(frames)
      ? [{ name, frames }]
      : [];
  });
}

function spriteFrameTextureRef(
  value: GodotVariant | undefined,
): GodotResourceRefValue | undefined {
  const directRef = asResourceRef(value);
  if (directRef) {
    return directRef;
  }
  const frame = plainRecord(value);
  return frame ? asResourceRef(frame.texture) : undefined;
}

function animatedSpriteFrameSize(
  image: GodotResolvedResource,
): { width: number; height: number } | undefined {
  const size = image.region
    ? { width: image.region.width, height: image.region.height }
    : image.size;
  if (!size || size.width <= 0 || size.height <= 0) {
    return undefined;
  }
  return size;
}

function stringOrStringName(
  value: GodotVariant | undefined,
): string | undefined {
  const string = asString(value);
  if (string !== undefined) {
    return string;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("type" in value)
  ) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return record.type === "StringName" &&
    Array.isArray(record.args) &&
    typeof record.args[0] === "string"
    ? record.args[0]
    : undefined;
}

function plainRecord(
  value: GodotVariant | undefined,
): Record<string, GodotVariant> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    "type" in value
  ) {
    return undefined;
  }
  return value as Record<string, GodotVariant>;
}

function patchMargins(
  props: Record<string, GodotVariant>,
): [number, number, number, number] {
  return [
    asNumber(props.patch_margin_top) ?? 0,
    asNumber(props.patch_margin_right) ?? 0,
    asNumber(props.patch_margin_bottom) ?? 0,
    asNumber(props.patch_margin_left) ?? 0,
  ];
}

function stretchModeBackgroundSize(value: number | undefined): string {
  // STRETCH_KEEP_ASPECT (4) and STRETCH_KEEP_ASPECT_CENTERED (5) both fit the
  // texture while preserving its aspect ratio (Godot differs only in alignment,
  // top-left vs centered; background-position handles that). Without 4 here a
  // KEEP_ASPECT TextureRect fell through to "100% 100%" and stretched to its box.
  if (value === 4 || value === 5) {
    return "contain";
  }
  if (value === 6) {
    return "cover";
  }
  return "100% 100%";
}

function textureRepeat(
  textureRepeatValue: number | undefined,
  stretchMode: number | undefined,
): string {
  if (
    stretchMode === 1 ||
    textureRepeatValue === 1 ||
    textureRepeatValue === 2
  ) {
    return "repeat";
  }
  return "no-repeat";
}

function axisStretchRepeat(value: number | undefined): string {
  if (value === 1) {
    return "repeat";
  }
  if (value === 2) {
    return "round";
  }
  return "stretch";
}
