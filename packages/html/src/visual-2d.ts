import {
  asBoolean,
  asNumber,
  asRect2,
  asResourceRef,
  asString,
  asVector2,
  type GodotCallVariant,
  type GodotNode,
  type GodotVariant,
} from "@godot-scene-web/core";
import {
  linearizeParticleBaseColor,
  normalizeGodotRenderer,
} from "@godot-scene-web/effects/particles";
import {
  clamp,
  colorCss,
  cssSize,
  cssUrl,
  escapeAttribute,
  round,
  styleAttribute,
} from "./css-values";
import {
  isHiddenRawShaderFallbackMaterial,
  isWebglShaderMaterialNode,
  shaderIdListMatches,
} from "./material";
import type { ParticleSpecConfig } from "./particles/spec";
import { imageResource, normalizeResource } from "./resources";
import type { GodotHtmlRenderOptions, GodotResolvedResource } from "./types";
import type { CurvePoint, GradientStop } from "./webgl/bake-texture";

export function assignSprite2DStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
  nodePath?: string,
): void {
  const image = resolveTextureImage(
    attributes,
    props,
    source,
    options,
    "Sprite2D",
  );
  assignTextureMetadata(style, attributes, props);
  assignNumberAttribute(attributes, props, "hframes", "data-godot-hframes");
  assignNumberAttribute(attributes, props, "vframes", "data-godot-vframes");
  assignNumberAttribute(attributes, props, "frame", "data-godot-frame");
  assignVectorAttribute(
    attributes,
    props,
    "frame_coords",
    "data-godot-frame-coords",
  );
  assignBooleanAttribute(
    attributes,
    props,
    "region_enabled",
    "data-godot-region-enabled",
  );
  assignRectAttribute(
    attributes,
    props,
    "region_rect",
    "data-godot-region-rect",
  );
  if (!image.url) {
    return;
  }
  // For a WebGL-eligible shader sprite, expose the RAW texture url the runtime
  // must bind as `TEXTURE` — the same contract `assignTextureStyles` publishes for
  // TextureRect/NinePatchRect. The runtime's fallback (reading the self-layer's
  // `background-image`) is NOT stable: mounting the shader canvas clears that
  // background, so a later reconcile re-read yields null and silently rebinds
  // TEXTURE to solid WHITE — which broke every texture-gated shader term (the Neow
  // `water_reflection` stepped-fire glow lost its light.png radial falloff and
  // flooded the whole box).
  if (isWebglShaderMaterialNode(props, source, options, nodePath)) {
    attributes["data-godot-shader-texture-url"] = image.url;
  }
  const sourceRect = spriteSourceRect(props, image);
  const textureSize = image.atlas?.size ?? image.size;
  const width = sourceRect?.width ?? cssSize(style.width);
  const height = sourceRect?.height ?? cssSize(style.height);
  if (width && height) {
    const offset = asVector2(props.offset) ?? { x: 0, y: 0 };
    const centered = asBoolean(props.centered) ?? true;
    const left = cssSize(style.left) ?? 0;
    const top = cssSize(style.top) ?? 0;
    style.left = `${round(left + offset.x - (centered ? width / 2 : 0))}px`;
    style.top = `${round(top + offset.y - (centered ? height / 2 : 0))}px`;
    style.width = `${round(width)}px`;
    style.height = `${round(height)}px`;
    if (style.transform) {
      style["transform-origin"] =
        `${round((centered ? width / 2 : 0) - offset.x)}px ` +
        `${round((centered ? height / 2 : 0) - offset.y)}px`;
    }
  }
  if (sourceRect && image.region) {
    attributes["data-godot-atlas-region"] =
      `${image.region.x},${image.region.y},${image.region.width},${image.region.height}`;
  }
  if (sourceRect) {
    attributes["data-godot-source-rect"] =
      `${sourceRect.x},${sourceRect.y},${sourceRect.width},${sourceRect.height}`;
  }
  // Honor the consumer's hidden-raw-fallback list exactly like the
  // TextureRect/NinePatchRect path (`assignTextureStyles`): a listed shader's raw
  // texture must NEVER paint. In Godot the texture is only an input the shader
  // gates/reshapes (e.g. light.png's radial falloff feeding the stepped-fire
  // water_reflection glow); painting it raw stretches the untransformed texture
  // over the node's full (often huge, rotated) quad — a hard-edged sheet that
  // shows both during the async WebGL takeover and permanently when the shader
  // can't run. Suppressing the paint degrades a non-running shader to the
  // consumer's documented hidden state; the WebGL canvas repaints the node when
  // it activates. The geometry/attrs above still apply (the runtime needs the
  // atlas region + `data-godot-shader-texture-url` to bind TEXTURE correctly).
  if (isHiddenRawShaderFallbackMaterial(props, source, options, nodePath)) {
    attributes["data-godot-shader-raw-fallback"] = "hidden";
    return;
  }
  style["background-image"] = `url("${cssUrl(image.url)}")`;
  style["background-repeat"] = textureRepeat(asNumber(props.texture_repeat));
  if (sourceRect) {
    style["background-position"] =
      `${round(-sourceRect.x)}px ${round(-sourceRect.y)}px`;
    style["background-size"] = textureSize
      ? `${round(textureSize.width)}px ${round(textureSize.height)}px`
      : "auto";
  } else {
    style["background-size"] = "100% 100%";
    style["background-position"] = "center";
  }
}

export function assignLine2DStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): string | undefined {
  attributes["data-godot-resource-kind"] = "Line2D";
  resolveTextureImage(attributes, props, source, options, "Line2D");
  assignTextureMetadata(style, attributes, props);
  assignNumberAttribute(
    attributes,
    props,
    "texture_mode",
    "data-godot-texture-mode",
  );
  assignNumberAttribute(
    attributes,
    props,
    "joint_mode",
    "data-godot-joint-mode",
  );
  assignNumberAttribute(
    attributes,
    props,
    "begin_cap_mode",
    "data-godot-begin-cap-mode",
  );
  assignNumberAttribute(
    attributes,
    props,
    "end_cap_mode",
    "data-godot-end-cap-mode",
  );
  assignNumberAttribute(
    attributes,
    props,
    "sharp_limit",
    "data-godot-sharp-limit",
  );
  assignNumberAttribute(
    attributes,
    props,
    "round_precision",
    "data-godot-round-precision",
  );
  assignBooleanAttribute(attributes, props, "closed", "data-godot-closed");
  assignBooleanAttribute(
    attributes,
    props,
    "antialiased",
    "data-godot-antialiased",
  );
  assignResourceRefAttributes(
    attributes,
    props.gradient,
    source,
    options,
    "gradient",
  );
  assignResourceRefAttributes(
    attributes,
    props.width_curve,
    source,
    options,
    "width-curve",
  );
  const points = vector2Points(props.points);
  if (points.length < 2) {
    return undefined;
  }
  const width = asNumber(props.width) ?? 10;
  const closed = asBoolean(props.closed) ?? false;
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  const pad = Math.max(1, width);
  const left = cssSize(style.left) ?? 0;
  const top = cssSize(style.top) ?? 0;
  style.left = `${round(left + minX - pad / 2)}px`;
  style.top = `${round(top + minY - pad / 2)}px`;
  style.width = `${round(Math.max(1, maxX - minX + pad))}px`;
  style.height = `${round(Math.max(1, maxY - minY + pad))}px`;
  style.overflow = "visible";
  const color =
    colorCss(props.default_color) ??
    colorCss(props.modulate) ??
    "rgba(102, 128, 255, 1)";
  const gradient = lineGradient(props.gradient, source, options);
  const drawPoints = closed
    ? [...points, points[0]].filter(
        (point): point is { x: number; y: number } => Boolean(point),
      )
    : points;
  const svgPoints = drawPoints
    .map(
      (point) =>
        `${round(point.x - minX + pad / 2)},${round(point.y - minY + pad / 2)}`,
    )
    .join(" ");
  const viewWidth = round(Math.max(1, maxX - minX + pad));
  const viewHeight = round(Math.max(1, maxY - minY + pad));
  const svgStyle = styleAttribute({
    position: "absolute",
    inset: "0",
    overflow: "visible",
  });
  const defs = gradient
    ? `<defs><linearGradient id="${gradient.id}" x1="0" y1="0" x2="1" y2="0">${gradient.stops}</linearGradient></defs>`
    : "";
  const stroke = gradient ? `url(#${gradient.id})` : color;
  return `<svg aria-hidden="true" data-godot-line2d="true" width="100%" height="100%" viewBox="0 0 ${escapeAttribute(String(viewWidth))} ${escapeAttribute(String(viewHeight))}" style="${escapeAttribute(svgStyle)}">${defs}<polyline points="${escapeAttribute(svgPoints)}" fill="none" stroke="${escapeAttribute(stroke)}" stroke-width="${round(width)}" stroke-linecap="${lineCap(props, closed)}" stroke-linejoin="${lineJoin(props)}"/></svg>`;
}

export function assignParticle2DStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
  kind: "CPUParticles2D" | "GPUParticles2D",
  nodePath: string,
): string | undefined {
  attributes["data-godot-resource-kind"] = kind;
  attributes["data-godot-static-preview"] = "true";
  assignNumberAttribute(
    attributes,
    props,
    "amount",
    "data-godot-particle-amount",
  );
  assignNumberAttribute(
    attributes,
    props,
    "amount_ratio",
    "data-godot-particle-amount-ratio",
  );
  assignNumberAttribute(
    attributes,
    props,
    "draw_order",
    "data-godot-particle-draw-order",
  );
  assignBooleanAttribute(
    attributes,
    props,
    "emitting",
    "data-godot-particle-emitting",
  );
  assignParticleTimingMetadata(attributes, props);
  assignResourceRefAttributes(
    attributes,
    props.process_material,
    source,
    options,
    "process-material",
  );
  assignResourceRefAttributes(
    attributes,
    props.color_ramp,
    source,
    options,
    "color-ramp",
  );
  assignResourceRefAttributes(
    attributes,
    props.color_initial_ramp,
    source,
    options,
    "color-initial-ramp",
  );
  assignResourceRefAttributes(
    attributes,
    props.scale_amount_curve,
    source,
    options,
    "scale-amount-curve",
  );
  assignResourceRefAttributes(
    attributes,
    props.scale_curve_x,
    source,
    options,
    "scale-curve-x",
  );
  assignResourceRefAttributes(
    attributes,
    props.scale_curve_y,
    source,
    options,
    "scale-curve-y",
  );
  const processMaterial = resolvedResource(
    props.process_material,
    source,
    options,
  );
  const materialProps =
    processMaterial?.document?.properties ??
    (kind === "CPUParticles2D" ? props : undefined);
  assignParticleMaterialMetadata(
    attributes,
    materialProps,
    kind === "CPUParticles2D" ? "particle" : "process-material",
  );
  assignNestedResourceRefAttribute(
    attributes,
    processMaterial,
    "color_ramp",
    "process-material-color-ramp",
  );
  assignNestedResourceRefAttribute(
    attributes,
    processMaterial,
    "color_initial_ramp",
    "process-material-color-initial-ramp",
  );
  assignNestedResourceRefAttribute(
    attributes,
    processMaterial,
    "emission_point_texture",
    "process-material-emission-point-texture",
  );
  assignNestedResourceRefAttribute(
    attributes,
    processMaterial,
    "emission_color_texture",
    "process-material-emission-color-texture",
  );
  assignNestedResourceRefAttribute(
    attributes,
    processMaterial,
    "emission_normal_texture",
    "process-material-emission-normal-texture",
  );
  const image = resolveTextureImage(attributes, props, source, options, kind);
  assignTextureMetadata(style, attributes, props);
  const shape = particleShape(materialProps);
  assignParticleShapeMetadata(attributes, shape);
  const colorRamp =
    particleGradientStops(props.color_ramp, source, options) ??
    particleGradientStops(materialProps?.color_ramp, source, options);
  const colorInitialRamp =
    particleGradientStops(props.color_initial_ramp, source, options) ??
    particleGradientStops(materialProps?.color_initial_ramp, source, options);
  assignParticleRampMetadata(attributes, "color-ramp", colorRamp);
  assignParticleRampMetadata(
    attributes,
    "color-initial-ramp",
    colorInitialRamp,
  );
  const rect =
    asRect2(props.visibility_rect) ??
    asRect2(props.rect) ??
    particleFallbackRect(kind, image, shape);
  const left = cssSize(style.left) ?? 0;
  const top = cssSize(style.top) ?? 0;
  style.left = `${round(left + rect.x)}px`;
  style.top = `${round(top + rect.y)}px`;
  style.width = `${round(Math.max(1, rect.width))}px`;
  style.height = `${round(Math.max(1, rect.height))}px`;
  style.overflow = image.url ? "visible" : "hidden";
  const amount = Math.max(1, Math.round(asNumber(props.amount) ?? 8));
  const ratio = clamp(asNumber(props.amount_ratio) ?? 1, 0, 1);
  const count = Math.max(1, Math.min(64, Math.round(amount * ratio)));
  attributes["data-godot-particle-preview-count"] = String(count);
  const minScale =
    asNumber(props.scale_amount_min) ?? asNumber(materialProps?.scale_min) ?? 1;
  const maxScale =
    asNumber(props.scale_amount_max) ??
    asNumber(materialProps?.scale_max) ??
    asNumber(props.scale_amount_max) ??
    minScale;
  attributes["data-godot-particle-scale-range"] = `${minScale},${maxScale}`;
  const seed = particleSeed(props, attributes, kind);
  attributes["data-godot-particle-preview-seed"] = String(seed.value);
  attributes["data-godot-particle-preview-seed-source"] = seed.source;
  const materialColor = rgbaValue(materialProps?.color);
  const particleColor =
    materialColor ?? rgbaValue(props.color) ?? rgbaValue(props.modulate);
  // DELIBERATELY the raw sRGB value, NOT `baseColorRender`. `options.godotRenderer`'s
  // sRGB→linear correction is a RENDERED-PIXEL correction (see core's `particles/godot-renderer.ts`),
  // and this `color` — plus the `data-godot-*-color` attribute below — is the static `<span>`
  // preview and the value a consumer reads back. Both mirror what the Godot INSPECTOR shows for
  // `ParticleProcessMaterial.color`, which is the authored colour. Darkening them would make
  // the DOM lie about the scene, and would move goldens that have nothing to do with blending.
  const color = particleColor
    ? colorToCss(particleColor)
    : "rgba(255, 255, 255, 1)";
  if (materialColor) {
    attributes[
      `data-godot-${kind === "CPUParticles2D" ? "particle" : "process-material"}-color`
    ] = colorToCss(materialColor);
  }
  if (image.url && particleColor) {
    attributes["data-godot-particle-texture-tint"] = "multiply";
  }
  // Additive particles (CanvasItemMaterial.blend_mode = BLEND_MODE_ADD) glow: the WebGL runtime
  // draws them additively, and the static <span> fallback must composite `plus-lighter` too, else a
  // white spark (base white, no ramp) previews as a flat white box instead of a glow.
  const canvasMaterial = resolvedResource(props.material, source, options);
  const canvasMaterialType =
    canvasMaterial?.type ??
    asString(canvasMaterial?.document?.header?.attributes.type);
  const additiveBlend =
    canvasMaterialType === "CanvasItemMaterial" &&
    Math.round(
      asNumber(canvasMaterial?.document?.properties?.blend_mode) ?? 0,
    ) === 1;
  // Live runtime opt-in: when enabled for this node, emit the marker + the full
  // serialized simulation config. Gated so the static html-string renderer (which
  // never sets `enableParticles`) keeps the byte-identical `<span>` preview below,
  // which also stays as the no-JS / no-GL fallback.
  if (
    isParticleRuntimeEnabled(
      options,
      nodePath,
      processMaterial?.path,
      image.path,
    )
  ) {
    attributes["data-godot-particle-runtime"] = "1";
    attributes["data-godot-particle-specs"] = JSON.stringify(
      serializeParticleConfig({
        kind,
        props,
        materialProps,
        image,
        shape,
        rect,
        colorRamp,
        colorInitialRamp,
        baseColor: particleColor,
        seed: seed.value,
        source,
        options,
      }),
    );
  }
  return particlePreviewHtml(
    count,
    rect,
    image,
    color,
    minScale,
    maxScale,
    shape,
    colorInitialRamp ?? colorRamp,
    seed.value,
    particleColor,
    additiveBlend,
  );
}

export function assignPlaceholder2DStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
  kind: string,
): void {
  attributes["data-godot-resource-kind"] = kind;
  attributes["data-godot-placeholder"] = "true";
  assignResourceRefAttributes(
    attributes,
    props.process_material,
    source,
    options,
    "process-material",
  );
  assignResourceRefAttributes(attributes, props.mesh, source, options, "mesh");
  const image = resolveTextureImage(attributes, props, source, options, kind);
  const rect = asRect2(props.visibility_rect) ?? asRect2(props.rect);
  if (rect) {
    const left = cssSize(style.left) ?? 0;
    const top = cssSize(style.top) ?? 0;
    style.left = `${round(left + rect.x)}px`;
    style.top = `${round(top + rect.y)}px`;
    style.width = `${round(Math.max(1, rect.width))}px`;
    style.height = `${round(Math.max(1, rect.height))}px`;
  } else if (image.size) {
    style.width = `${round(Math.max(1, image.size.width))}px`;
    style.height = `${round(Math.max(1, image.size.height))}px`;
  } else if (cssSize(style.width) === 0 && cssSize(style.height) === 0) {
    style.width = "1px";
    style.height = "1px";
  }
}

function spriteSourceRect(
  props: Record<string, GodotVariant>,
  image: GodotResolvedResource,
): { x: number; y: number; width: number; height: number } | undefined {
  const regionEnabled = asBoolean(props.region_enabled) ?? false;
  const spriteRegion = regionEnabled ? asRect2(props.region_rect) : undefined;
  const baseX = image.region?.x ?? 0;
  const baseY = image.region?.y ?? 0;
  const baseWidth =
    spriteRegion?.width ?? image.region?.width ?? image.size?.width;
  const baseHeight =
    spriteRegion?.height ?? image.region?.height ?? image.size?.height;
  if (!baseWidth || !baseHeight) {
    return undefined;
  }
  const hframes = Math.max(1, Math.round(asNumber(props.hframes) ?? 1));
  const vframes = Math.max(1, Math.round(asNumber(props.vframes) ?? 1));
  const frame = spriteFrame(props, hframes, vframes);
  const frameWidth = baseWidth / hframes;
  const frameHeight = baseHeight / vframes;
  return {
    x: baseX + (spriteRegion?.x ?? 0) + (frame % hframes) * frameWidth,
    y:
      baseY +
      (spriteRegion?.y ?? 0) +
      Math.floor(frame / hframes) * frameHeight,
    width: frameWidth,
    height: frameHeight,
  };
}

function spriteFrame(
  props: Record<string, GodotVariant>,
  hframes: number,
  vframes: number,
): number {
  const explicitFrame = asNumber(props.frame);
  if (explicitFrame !== undefined) {
    return Math.max(
      0,
      Math.min(hframes * vframes - 1, Math.floor(explicitFrame)),
    );
  }
  const coords = asVector2(props.frame_coords);
  if (coords) {
    return Math.max(
      0,
      Math.min(
        hframes * vframes - 1,
        Math.floor(coords.y) * hframes + Math.floor(coords.x),
      ),
    );
  }
  return 0;
}

function assignTextureMetadata(
  style: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
): void {
  const repeat = asNumber(props.texture_repeat);
  const filter = asNumber(props.texture_filter);
  if (repeat !== undefined) {
    attributes["data-godot-texture-repeat"] = String(repeat);
  }
  if (filter !== undefined) {
    attributes["data-godot-texture-filter"] = String(filter);
    if (filter === 1) {
      style["image-rendering"] = "pixelated";
    }
  }
}

function textureRepeat(value: number | undefined): string {
  return value === 1 || value === 2 ? "repeat" : "no-repeat";
}

function lineCap(
  props: Record<string, GodotVariant>,
  closed: boolean,
): "butt" | "round" | "square" {
  if (closed) {
    return "butt";
  }
  const begin = asNumber(props.begin_cap_mode) ?? 0;
  const end = asNumber(props.end_cap_mode) ?? begin;
  if (begin === 2 || end === 2) {
    return "round";
  }
  if (begin === 1 || end === 1) {
    return "square";
  }
  return "butt";
}

function lineJoin(
  props: Record<string, GodotVariant>,
): "miter" | "bevel" | "round" {
  const joint = asNumber(props.joint_mode) ?? 0;
  if (joint === 1) {
    return "bevel";
  }
  if (joint === 2) {
    return "round";
  }
  return "miter";
}

function lineGradient(
  value: GodotVariant | undefined,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): { id: string; stops: string } | undefined {
  const resource = resolvedResource(value, source, options);
  const stops = gradientStops(resource, source, options);
  if (stops.length === 0) {
    return undefined;
  }
  return {
    id: `godot-line-gradient-${Math.abs(hashString(JSON.stringify(stops)))}`,
    stops: stops
      .map(
        (stop) =>
          `<stop offset="${round(stop.offset * 100)}%" stop-color="${escapeAttribute(stop.color)}"/>`,
      )
      .join(""),
  };
}

function gradientStops(
  resource: GodotResolvedResource | undefined,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): Array<{ offset: number; color: string }> {
  return gradientColorStops(resource, source, options).map((stop) => ({
    offset: stop.offset,
    color: colorToCss(stop.color),
  }));
}

type ParticleKind = "CPUParticles2D" | "GPUParticles2D";
type Vector2 = { x: number; y: number };
type Vector3 = { x: number; y: number; z: number };
type Rgba = { r: number; g: number; b: number; a: number };
type GradientColorStop = { offset: number; color: Rgba };
type ParticleShape = {
  shape: number;
  name: string;
  offset: Vector2;
  scale: Vector2;
  boxExtents: Vector2;
  sphereRadius: number;
  ringRadius: number;
  ringInnerRadius: number;
  ringHeight: number;
};

function gradientColorStops(
  resource: GodotResolvedResource | undefined,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): GradientColorStop[] {
  const props = resource?.document?.properties;
  if (!props) {
    return [];
  }
  const type =
    resource.type ?? asString(resource.document?.header?.attributes.type);
  if (type === "GradientTexture1D" || type === "GradientTexture2D") {
    const gradientRef = asResourceRef(props.gradient);
    if (!gradientRef) {
      return [];
    }
    return gradientColorStops(
      normalizeResource(options.resolveResource?.(gradientRef, source)),
      source,
      options,
    );
  }
  const colors = packedColorValues(props.colors);
  if (colors.length === 0) {
    return [];
  }
  const offsets = packedNumberArray(props.offsets);
  return colors.map((color, index) => ({
    offset: clamp(
      offsets[index] ?? (colors.length === 1 ? 0 : index / (colors.length - 1)),
      0,
      1,
    ),
    color,
  }));
}

function particleFallbackRect(
  kind: ParticleKind,
  image: GodotResolvedResource,
  shape: ParticleShape,
): { x: number; y: number; width: number; height: number } {
  const textureSize = image.region ?? image.size;
  const padX = Math.max(8, (textureSize?.width ?? 8) / 2);
  const padY = Math.max(8, (textureSize?.height ?? 8) / 2);
  const bounds = particleShapeBounds(shape);
  if (bounds) {
    return {
      x: bounds.x - padX,
      y: bounds.y - padY,
      width: Math.max(1, bounds.width + padX * 2),
      height: Math.max(1, bounds.height + padY * 2),
    };
  }
  const width = Math.max(
    32,
    (image.size?.width ?? image.region?.width ?? 16) * 4,
  );
  const height = Math.max(
    32,
    (image.size?.height ?? image.region?.height ?? 16) * 4,
  );
  if (kind === "GPUParticles2D") {
    return {
      x: -Math.max(100, width / 2),
      y: -Math.max(100, height / 2),
      width: Math.max(200, width),
      height: Math.max(200, height),
    };
  }
  return { x: -width / 2, y: -height / 2, width, height };
}

function particlePreviewHtml(
  count: number,
  rect: { x: number; y: number; width: number; height: number },
  image: GodotResolvedResource,
  color: string,
  minScale: number,
  maxScale: number,
  shape: ParticleShape,
  colorRamp: GradientColorStop[] | undefined,
  seed: number,
  textureTint: Rgba | undefined,
  additive: boolean,
): string {
  const textureSize = image.region ?? image.size;
  const isTextured = Boolean(image.url);
  const baseWidth = image.url
    ? (textureSize?.width ?? 6)
    : Math.max(3, Math.min(24, textureSize?.width ?? 6));
  const baseHeight = image.url
    ? (textureSize?.height ?? 6)
    : Math.max(3, Math.min(24, textureSize?.height ?? 6));
  const particles: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const sampled = sampleParticlePosition(shape, seed, index);
    const scale =
      minScale + (maxScale - minScale) * deterministicUnit(seed, index, 89);
    const width = Math.max(1, baseWidth * scale);
    const height = Math.max(1, baseHeight * scale);
    const left = sampled.x - rect.x - width / 2;
    const top = sampled.y - rect.y - height / 2;
    const previewOpacity = isTextured
      ? texturePreviewOpacity(textureTint)
      : round(0.55 + deterministicUnit(seed, index, 131) * 0.45);
    const particleStyle: Record<string, string> = {
      position: "absolute",
      left: `${round(isTextured ? left : clamp(left, 0, Math.max(0, rect.width - width)))}px`,
      top: `${round(isTextured ? top : clamp(top, 0, Math.max(0, rect.height - height)))}px`,
      width: `${round(width)}px`,
      height: `${round(height)}px`,
      opacity: `${previewOpacity}`,
      // Additive systems glow: composite the span onto the scene with `plus-lighter` (the CSS
      // analogue of BLEND_MODE_ADD) so bright sparks add light instead of painting flat over.
      ...(additive ? { "mix-blend-mode": "plus-lighter" } : {}),
      "background-color":
        colorRamp && colorRamp.length > 0
          ? sampleGradientCss(colorRamp, deterministicUnit(seed, index, 157))
          : color,
      "border-radius": "999px",
    };
    if (image.url) {
      particleStyle["background-image"] = `url("${cssUrl(image.url)}")`;
      particleStyle["background-size"] = "100% 100%";
      particleStyle["background-repeat"] = "no-repeat";
      particleStyle["border-radius"] = "0";
      // The live particle color is `color_ramp(life) × modulate`; the texture only supplies the
      // shape/luminance. Fold the sampled ramp into the tint so a ramped ember (white modulate,
      // red→black ramp) previews red/black instead of a flat base color — matching what the WebGL
      // runtime draws. Without a ramp this reduces to the plain texture modulate.
      const rampSample =
        colorRamp && colorRamp.length > 0
          ? sampleGradientRgba(colorRamp, deterministicUnit(seed, index, 157))
          : undefined;
      const tint = rampSample
        ? textureTint
          ? {
              r: rampSample.r * textureTint.r,
              g: rampSample.g * textureTint.g,
              b: rampSample.b * textureTint.b,
              a: 1,
            }
          : rampSample
        : textureTint;
      if (tint) {
        particleStyle["background-color"] = colorToCss(
          textureModulateTint(tint),
        );
        particleStyle["background-blend-mode"] = "multiply";
        particleStyle["mask-image"] = `url("${cssUrl(image.url)}")`;
        particleStyle["mask-size"] = "100% 100%";
        particleStyle["mask-repeat"] = "no-repeat";
        particleStyle["-webkit-mask-image"] = `url("${cssUrl(image.url)}")`;
        particleStyle["-webkit-mask-size"] = "100% 100%";
        particleStyle["-webkit-mask-repeat"] = "no-repeat";
      } else {
        particleStyle["background-color"] = "transparent";
      }
    }
    const overlay =
      image.url && textureTint
        ? `<span aria-hidden="true" data-godot-particle-tint="multiply" style="${escapeAttribute(
            styleAttribute({
              position: "absolute",
              inset: "0",
              "background-color": "transparent",
              opacity: "1",
              "pointer-events": "none",
            }),
          )}"></span>`
        : "";
    particles.push(
      `<span aria-hidden="true" data-godot-particle="true" style="${escapeAttribute(styleAttribute(particleStyle))}">${overlay}</span>`,
    );
  }
  return particles.join("");
}

function textureModulateTint(color: Rgba): Rgba {
  return {
    r: color.r * color.r,
    g: color.g * color.g,
    b: color.b * color.b,
    a: 1,
  };
}

function texturePreviewOpacity(color: Rgba | undefined): number {
  return round(clamp(color?.a ?? 1, 0, 1) * 0.75);
}

function sampleParticlePosition(
  shape: ParticleShape,
  seed: number,
  index: number,
): Vector2 {
  const a = deterministicUnit(seed, index, 17);
  const b = deterministicUnit(seed, index, 53);
  let point: Vector2;
  if (shape.shape === 0) {
    point = { x: 0, y: 0 };
  } else if (shape.shape === 1 || shape.shape === 2) {
    const angle = a * Math.PI * 2;
    const radius = shape.sphereRadius * (shape.shape === 2 ? 1 : Math.sqrt(b));
    point = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  } else if (shape.shape === 3) {
    point = {
      x: (a * 2 - 1) * shape.boxExtents.x,
      y: (b * 2 - 1) * shape.boxExtents.y,
    };
  } else if (shape.shape === 6) {
    const angle = a * Math.PI * 2;
    const outer = Math.max(shape.ringRadius, shape.ringInnerRadius, 0.001);
    const inner = Math.max(0, Math.min(shape.ringInnerRadius, outer));
    const radius = Math.sqrt(
      b * (outer * outer - inner * inner) + inner * inner,
    );
    const y =
      ((deterministicUnit(seed, index, 71) * 2 - 1) * shape.ringHeight) / 2;
    point = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius + y };
  } else {
    point = {
      x:
        (a * 2 - 1) *
        Math.max(
          16,
          shape.boxExtents.x || shape.sphereRadius || shape.ringRadius,
        ),
      y:
        (b * 2 - 1) *
        Math.max(
          16,
          shape.boxExtents.y || shape.sphereRadius || shape.ringRadius,
        ),
    };
  }
  return {
    x: point.x * shape.scale.x + shape.offset.x,
    y: point.y * shape.scale.y + shape.offset.y,
  };
}

function deterministicUnit(seed: number, index: number, salt: number): number {
  let value = (seed ^ (salt * 374761393) ^ ((index + 1) * 668265263)) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 2246822519) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 3266489917) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function assignParticleMaterialMetadata(
  attributes: Record<string, string>,
  props: Record<string, GodotVariant> | undefined,
  prefix: string,
): void {
  if (!props) {
    return;
  }
  for (const name of [
    "scale_min",
    "scale_max",
    "scale_amount_min",
    "scale_amount_max",
    "emission_shape",
    "emission_sphere_radius",
    "emission_ring_radius",
    "emission_ring_inner_radius",
    "emission_ring_height",
    "initial_velocity_min",
    "initial_velocity_max",
    "spread",
  ]) {
    const value = asNumber(props[name]);
    if (value !== undefined) {
      attributes[`data-godot-${prefix}-${name.replace(/_/g, "-")}`] =
        String(value);
    }
  }
  assignVectorValueAttribute(
    attributes,
    props,
    "emission_shape_offset",
    `data-godot-${prefix}-emission-shape-offset`,
  );
  assignVectorValueAttribute(
    attributes,
    props,
    "emission_shape_scale",
    `data-godot-${prefix}-emission-shape-scale`,
  );
  assignVectorValueAttribute(
    attributes,
    props,
    "emission_box_extents",
    `data-godot-${prefix}-emission-box-extents`,
  );
  assignVectorValueAttribute(
    attributes,
    props,
    "emission_rect_extents",
    `data-godot-${prefix}-emission-rect-extents`,
  );
  assignVectorValueAttribute(
    attributes,
    props,
    "gravity",
    `data-godot-${prefix}-gravity`,
  );
  for (const name of [
    "particle_flag_align_y",
    "particle_flag_rotate_y",
    "particle_flag_disable_z",
    "particle_flag_damping_as_friction",
  ]) {
    const value = asBoolean(props[name]);
    if (value !== undefined) {
      attributes[`data-godot-${prefix}-${name.replace(/_/g, "-")}`] =
        String(value);
    }
  }
}

function assignParticleTimingMetadata(
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
): void {
  for (const name of [
    "lifetime",
    "preprocess",
    "speed_scale",
    "explosiveness",
    "randomness",
    "fixed_fps",
    "seed",
    "trail_lifetime",
    "trail_sections",
    "trail_section_subdivisions",
  ]) {
    assignNumberAttribute(
      attributes,
      props,
      name,
      `data-godot-particle-${name.replace(/_/g, "-")}`,
    );
  }
  for (const name of [
    "one_shot",
    "local_coords",
    "fract_delta",
    "interpolate",
    "trail_enabled",
    "use_fixed_seed",
  ]) {
    assignBooleanAttribute(
      attributes,
      props,
      name,
      `data-godot-particle-${name.replace(/_/g, "-")}`,
    );
  }
}

function particleShape(
  props: Record<string, GodotVariant> | undefined,
): ParticleShape {
  const shape = Math.round(asNumber(props?.emission_shape) ?? 0);
  const offset = vector2FromAny(props?.emission_shape_offset) ?? { x: 0, y: 0 };
  const scale = vector2FromAny(props?.emission_shape_scale) ?? { x: 1, y: 1 };
  const boxExtents = vector2FromAny(props?.emission_box_extents) ??
    vector2FromAny(props?.emission_rect_extents) ?? { x: 0, y: 0 };
  const sphereRadius = Math.max(
    0,
    asNumber(props?.emission_sphere_radius) ?? 0,
  );
  const ringRadius = Math.max(0, asNumber(props?.emission_ring_radius) ?? 0);
  const ringInnerRadius = Math.max(
    0,
    asNumber(props?.emission_ring_inner_radius) ?? 0,
  );
  const ringHeight = Math.max(0, asNumber(props?.emission_ring_height) ?? 0);
  return {
    shape,
    name: particleShapeName(shape),
    offset,
    scale,
    boxExtents,
    sphereRadius,
    ringRadius,
    ringInnerRadius,
    ringHeight,
  };
}

function particleShapeName(shape: number): string {
  switch (shape) {
    case 0:
      return "point";
    case 1:
      return "sphere";
    case 2:
      return "sphere-surface";
    case 3:
      return "box";
    case 4:
      return "points";
    case 5:
      return "directed-points";
    case 6:
      return "ring";
    default:
      return "unknown";
  }
}

function assignParticleShapeMetadata(
  attributes: Record<string, string>,
  shape: ParticleShape,
): void {
  attributes["data-godot-particle-emission-shape"] = String(shape.shape);
  attributes["data-godot-particle-emission-shape-name"] = shape.name;
  attributes["data-godot-particle-emission-shape-offset"] =
    `${shape.offset.x},${shape.offset.y}`;
  attributes["data-godot-particle-emission-shape-scale"] =
    `${shape.scale.x},${shape.scale.y}`;
  const bounds = particleShapeBounds(shape);
  if (bounds) {
    attributes["data-godot-particle-emission-shape-bounds"] =
      `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  }
}

function particleShapeBounds(
  shape: ParticleShape,
): { x: number; y: number; width: number; height: number } | undefined {
  if (shape.shape === 0) {
    return { x: shape.offset.x, y: shape.offset.y, width: 0, height: 0 };
  }
  if (shape.shape === 1 || shape.shape === 2) {
    const radiusX = shape.sphereRadius * Math.abs(shape.scale.x);
    const radiusY = shape.sphereRadius * Math.abs(shape.scale.y);
    return {
      x: shape.offset.x - radiusX,
      y: shape.offset.y - radiusY,
      width: radiusX * 2,
      height: radiusY * 2,
    };
  }
  if (
    shape.shape === 3 &&
    (shape.boxExtents.x !== 0 || shape.boxExtents.y !== 0)
  ) {
    const extentX = Math.abs(shape.boxExtents.x * shape.scale.x);
    const extentY = Math.abs(shape.boxExtents.y * shape.scale.y);
    return {
      x: shape.offset.x - extentX,
      y: shape.offset.y - extentY,
      width: extentX * 2,
      height: extentY * 2,
    };
  }
  if (shape.shape === 6) {
    const radiusX =
      Math.max(shape.ringRadius, shape.ringInnerRadius) *
      Math.abs(shape.scale.x);
    const radiusY =
      (Math.max(shape.ringRadius, shape.ringInnerRadius) +
        shape.ringHeight / 2) *
      Math.abs(shape.scale.y);
    return {
      x: shape.offset.x - radiusX,
      y: shape.offset.y - radiusY,
      width: radiusX * 2,
      height: radiusY * 2,
    };
  }
  return undefined;
}

function particleGradientStops(
  value: GodotVariant | undefined,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): GradientColorStop[] | undefined {
  const resource = resolvedResource(value, source, options);
  const stops = gradientColorStops(resource, source, options);
  return stops.length > 0 ? stops : undefined;
}

function assignParticleRampMetadata(
  attributes: Record<string, string>,
  name: string,
  stops: GradientColorStop[] | undefined,
): void {
  if (!stops || stops.length === 0) {
    return;
  }
  attributes[`data-godot-particle-${name}-stops`] = stops
    .map((stop) => `${round(stop.offset)}:${colorToCss(stop.color)}`)
    .join("|");
}

function particleSeed(
  props: Record<string, GodotVariant>,
  attributes: Record<string, string>,
  kind: ParticleKind,
): { value: number; source: "fixed" | "derived" } {
  if (asBoolean(props.use_fixed_seed) === true) {
    return { value: Math.trunc(asNumber(props.seed) ?? 0), source: "fixed" };
  }
  const key = [
    attributes["data-godot-path"],
    kind,
    attributes["data-godot-texture-ref"],
    attributes["data-godot-process-material-ref"],
    attributes["data-godot-color-ramp-ref"],
    attributes["data-godot-color-initial-ramp-ref"],
  ]
    .filter(Boolean)
    .join("|");
  return { value: hashString(key || kind) >>> 0, source: "derived" };
}

// ---- runtime (live particle simulation) serialization ----------------------

function isParticleRuntimeEnabled(
  options: GodotHtmlRenderOptions,
  nodePath: string,
  materialPath: string | undefined,
  texturePath: string | undefined,
): boolean {
  if (!options.enableParticles) {
    return false;
  }
  if (nodePath && options.particleNodesByPath?.[nodePath]) {
    return true;
  }
  const ids = options.particleIds ?? [];
  if (ids.length === 0) {
    return false;
  }
  return (
    shaderIdListMatches(ids, materialPath, undefined) ||
    shaderIdListMatches(ids, texturePath, undefined)
  );
}

// Build the `data-godot-particle-specs` payload — the full simulation config from
// the node + its ParticleProcessMaterial (`materialProps`, which is the process
// material for GPU particles or the node itself for CPU particles), the resolved
// texture, the CanvasItemMaterial blend/flipbook, and the decoded ramps/curves.
function serializeParticleConfig(args: {
  kind: ParticleKind;
  props: Record<string, GodotVariant>;
  materialProps: Record<string, GodotVariant> | undefined;
  image: GodotResolvedResource;
  shape: ParticleShape;
  rect: { x: number; y: number; width: number; height: number };
  colorRamp: GradientColorStop[] | undefined;
  colorInitialRamp: GradientColorStop[] | undefined;
  baseColor: Rgba | undefined;
  seed: number;
  source: GodotNode;
  options: GodotHtmlRenderOptions;
}): ParticleSpecConfig {
  const {
    kind,
    props,
    materialProps: m,
    image,
    shape,
    rect,
    colorRamp,
    colorInitialRamp,
    baseColor,
    seed,
    source,
    options,
  } = args;
  const material = resolvedResource(props.material, source, options);
  const materialType =
    material?.type ?? asString(material?.document?.header?.attributes.type);
  const canvasItem =
    materialType === "CanvasItemMaterial"
      ? material?.document?.properties
      : undefined;
  const animEnabled = asBoolean(canvasItem?.particles_animation) ?? false;
  const hframes = animEnabled
    ? Math.max(
        1,
        Math.round(asNumber(canvasItem?.particles_anim_h_frames) ?? 1),
      )
    : 1;
  const vframes = animEnabled
    ? Math.max(
        1,
        Math.round(asNumber(canvasItem?.particles_anim_v_frames) ?? 1),
      )
    : 1;
  const texSize = image.region ?? image.size;
  // The base colour goes into the blob BOTH as authored (`baseColor`, raw sRGB) and as the
  // target backend uploads it (`baseColorRender`). `normalizeParticleConfig` recomputes the
  // latter from the former on parse, so the blob cannot carry a stale or lying value.
  const godotRenderer = normalizeGodotRenderer(options.godotRenderer);
  const baseColorRgba: [number, number, number, number] = baseColor
    ? [baseColor.r, baseColor.g, baseColor.b, baseColor.a]
    : [1, 1, 1, 1];
  // Only a real `ParticleProcessMaterial.color` takes the RD linearization. `m` is the
  // process material for GPUParticles2D and the NODE for CPUParticles2D, so the kind check
  // is what separates `ParticleProcessMaterial.color` from `CPUParticles2D.color`; a
  // GPUParticles2D with no process material falls back to `modulate`, which Godot also
  // leaves in sRGB.
  const baseColorFromProcessMaterial =
    kind === "GPUParticles2D" && rgbaValue(m?.color) !== undefined;
  return {
    kind,
    godotRenderer,
    amount: Math.max(1, Math.round(asNumber(props.amount) ?? 8)),
    amountRatio: clamp(asNumber(props.amount_ratio) ?? 1, 0, 1),
    lifetime: Math.max(0.01, asNumber(props.lifetime) ?? 1),
    lifetimeRandomness: clamp(
      asNumber(m?.lifetime_randomness) ??
        asNumber(props.lifetime_randomness) ??
        0,
      0,
      1,
    ),
    oneShot: asBoolean(props.one_shot) ?? false,
    emitting: asBoolean(props.emitting) ?? true,
    explosiveness: clamp(asNumber(props.explosiveness) ?? 0, 0, 1),
    randomness: clamp(asNumber(props.randomness) ?? 0, 0, 1),
    preprocess: Math.max(0, asNumber(props.preprocess) ?? 0),
    speedScale: asNumber(props.speed_scale) ?? 1,
    fixedFps: Math.max(0, Math.round(asNumber(props.fixed_fps) ?? 0)),
    localCoords: asBoolean(props.local_coords) ?? false,
    drawOrder: Math.round(asNumber(props.draw_order) ?? 0),
    seed,
    emissionShape: shape.shape,
    emissionOffset: [shape.offset.x, shape.offset.y],
    emissionScale: [shape.scale.x, shape.scale.y],
    emissionSphereRadius: shape.sphereRadius,
    emissionRingRadius: shape.ringRadius,
    emissionRingInnerRadius: shape.ringInnerRadius,
    emissionRingHeight: shape.ringHeight,
    emissionBoxExtents: [shape.boxExtents.x, shape.boxExtents.y],
    direction: vec2OrDefault(m?.direction, [1, 0]),
    spread: asNumber(m?.spread) ?? 45,
    initialVelocityMin: asNumber(m?.initial_velocity_min) ?? 0,
    initialVelocityMax: asNumber(m?.initial_velocity_max) ?? 0,
    angleMin: asNumber(m?.angle_min) ?? 0,
    angleMax: asNumber(m?.angle_max) ?? 0,
    angularVelocityMin: asNumber(m?.angular_velocity_min) ?? 0,
    angularVelocityMax: asNumber(m?.angular_velocity_max) ?? 0,
    gravity: vec2OrDefault(m?.gravity, [0, 980]),
    linearAccelMin: asNumber(m?.linear_accel_min) ?? 0,
    linearAccelMax: asNumber(m?.linear_accel_max) ?? 0,
    radialAccelMin: asNumber(m?.radial_accel_min) ?? 0,
    radialAccelMax: asNumber(m?.radial_accel_max) ?? 0,
    tangentialAccelMin: asNumber(m?.tangential_accel_min) ?? 0,
    tangentialAccelMax: asNumber(m?.tangential_accel_max) ?? 0,
    dampingMin: asNumber(m?.damping_min) ?? 0,
    dampingMax: asNumber(m?.damping_max) ?? 0,
    dampingAsFriction: asBoolean(m?.particle_flag_damping_as_friction) ?? false,
    orbitVelocityMin: asNumber(m?.orbit_velocity_min) ?? 0,
    orbitVelocityMax: asNumber(m?.orbit_velocity_max) ?? 0,
    scaleMin: asNumber(m?.scale_min) ?? asNumber(props.scale_amount_min) ?? 1,
    scaleMax:
      asNumber(m?.scale_max) ??
      asNumber(props.scale_amount_max) ??
      asNumber(m?.scale_min) ??
      1,
    hueVariationMin: asNumber(m?.hue_variation_min) ?? 0,
    hueVariationMax: asNumber(m?.hue_variation_max) ?? 0,
    alignY: asBoolean(m?.particle_flag_align_y) ?? false,
    baseColor: baseColorRgba,
    baseColorFromProcessMaterial,
    baseColorRender: linearizeParticleBaseColor(
      baseColorRgba,
      godotRenderer,
      baseColorFromProcessMaterial,
    ),
    // Draw-space origin for the runtime: a particle at simulation (0,0) — the emitter /
    // node origin — lands at the node's visual origin (canvas pixel `pad`, since the overlay
    // canvas is positioned symmetrically at `-pad`). Kept at 0: the per-particle emission
    // spread is baked into the simulated positions, and coupling the DRAW origin to `-rect`
    // shifted a point-emission burst OUTSIDE the sprite-extent-sized canvas (clipping).
    originX: 0,
    originY: 0,
    // Screen offset of the overlay CANVAS (not the draw origin): the CSS-`<span>` fallback
    // renders each particle at `self-layer + (sampled - rect)`, so its emission center sits
    // at `-rect.(x,y)` from the node-box corner — near screen-center for a background
    // emitter. The WebGL canvas otherwise centers emission on the node-box corner (0,0) →
    // top-left. Shifting the whole canvas by `-rect.(x,y)` moves the WebGL emission center to
    // the SAME place as the spans, in both layout paths, with no clipping (the canvas moves
    // with its particles). `rect` = the emitter's visibility/emission box (top-left ≈ −half-extent).
    boxOffsetX: -rect.x,
    boxOffsetY: -rect.y,
    textureUrl: image.url ?? null,
    textureWidth: texSize?.width ?? 0,
    textureHeight: texSize?.height ?? 0,
    hframes,
    vframes,
    animLoop: asBoolean(canvasItem?.particles_anim_loop) ?? false,
    animSpeedMin: asNumber(m?.anim_speed_min) ?? 0,
    animSpeedMax: asNumber(m?.anim_speed_max) ?? 0,
    animOffsetMin: asNumber(m?.anim_offset_min) ?? 0,
    animOffsetMax: asNumber(m?.anim_offset_max) ?? 0,
    blendMode: Math.round(asNumber(canvasItem?.blend_mode) ?? 0),
    colorRamp: rampToSpec(colorRamp),
    colorInitialRamp: rampToSpec(colorInitialRamp),
    scaleCurve: curvePoints(
      m?.scale_curve ?? m?.scale_amount_curve,
      source,
      options,
    ),
    scaleCurveX: curvePoints(m?.scale_curve_x, source, options),
    scaleCurveY: curvePoints(m?.scale_curve_y, source, options),
    alphaCurve: curvePoints(m?.alpha_curve, source, options),
    hueCurve: curvePoints(m?.hue_variation_curve, source, options),
  };
}

function vec2OrDefault(
  value: GodotVariant | undefined,
  fallback: [number, number],
): [number, number] {
  const vector = vector2FromAny(value);
  return vector ? [vector.x, vector.y] : fallback;
}

function rampToSpec(
  stops: GradientColorStop[] | undefined,
): GradientStop[] | undefined {
  if (!stops || stops.length === 0) {
    return undefined;
  }
  return stops.map((stop) => ({
    offset: stop.offset,
    color: [stop.color.r, stop.color.g, stop.color.b, stop.color.a] as [
      number,
      number,
      number,
      number,
    ],
  }));
}

// Decode a Curve / CurveTexture / CurveXYZTexture resource to its control points.
// Godot's `Curve._data` is a flat array of `[Vector2(x,y), left_tan, right_tan,
// left_mode, right_mode]` per point; the Vector2 entries (the only Vector2s in the
// array) are the points in order. Linear interpolation between them is the bar here.
function curvePoints(
  value: GodotVariant | undefined,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): CurvePoint[] | undefined {
  const resource = resolvedResource(value, source, options);
  if (!resource) {
    return undefined;
  }
  const type =
    resource.type ?? asString(resource.document?.header?.attributes.type);
  let curveProps = resource.document?.properties;
  if (type === "CurveTexture") {
    curveProps =
      resolvedResource(curveProps?.curve, source, options)?.document
        ?.properties ?? curveProps;
  } else if (type === "CurveXYZTexture") {
    curveProps =
      resolvedResource(
        curveProps?.curve_x ?? curveProps?.curve_y ?? curveProps?.curve_z,
        source,
        options,
      )?.document?.properties ?? curveProps;
  }
  const points = extractCurvePoints(curveProps?._data);
  return points.length > 0 ? points : undefined;
}

function extractCurvePoints(value: GodotVariant | undefined): CurvePoint[] {
  const items = Array.isArray(value)
    ? value
    : value && isCallValue(value)
      ? value.args
      : [];
  const points: CurvePoint[] = [];
  for (const item of items) {
    const point = asVector2(item as GodotVariant);
    if (point) {
      points.push({ x: point.x, y: point.y });
    }
  }
  return points;
}

function sampleGradientRgba(stops: GradientColorStop[], offset: number): Rgba {
  const ordered = [...stops].sort((left, right) => left.offset - right.offset);
  if (ordered.length === 1 || offset <= ordered[0].offset) {
    return ordered[0].color;
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const right = ordered[index];
    const left = ordered[index - 1];
    if (offset <= right.offset) {
      const span = Math.max(0.0001, right.offset - left.offset);
      const t = clamp((offset - left.offset) / span, 0, 1);
      return {
        r: left.color.r + (right.color.r - left.color.r) * t,
        g: left.color.g + (right.color.g - left.color.g) * t,
        b: left.color.b + (right.color.b - left.color.b) * t,
        a: left.color.a + (right.color.a - left.color.a) * t,
      };
    }
  }
  return ordered[ordered.length - 1].color;
}

function sampleGradientCss(stops: GradientColorStop[], offset: number): string {
  return colorToCss(sampleGradientRgba(stops, offset));
}

function colorToCss(color: Rgba): string {
  return `rgba(${Math.round(clamp(color.r, 0, 1) * 255)}, ${Math.round(clamp(color.g, 0, 1) * 255)}, ${Math.round(clamp(color.b, 0, 1) * 255)}, ${round(clamp(color.a, 0, 1))})`;
}

function vector2FromAny(value: GodotVariant | undefined): Vector2 | undefined {
  const vector2 = asVector2(value);
  if (vector2) {
    return vector2;
  }
  const vector3 = asVector3(value);
  return vector3 ? { x: vector3.x, y: vector3.y } : undefined;
}

function asVector3(value: GodotVariant | undefined): Vector3 | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("type" in value) ||
    (value.type !== "Vector3" && value.type !== "Vector3i") ||
    !Array.isArray(value.args)
  ) {
    return undefined;
  }
  const [x, y, z] = value.args as unknown[];
  return typeof x === "number" &&
    typeof y === "number" &&
    typeof z === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(z)
    ? { x, y, z }
    : undefined;
}

function assignVectorValueAttribute(
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  property: string,
  attribute: string,
): void {
  const vector = vector2FromAny(props[property]);
  if (vector) {
    attributes[attribute] = `${vector.x},${vector.y}`;
  }
}

function assignNestedResourceRefAttribute(
  attributes: Record<string, string>,
  resource: GodotResolvedResource | undefined,
  property: string,
  name: string,
): void {
  const ref = asResourceRef(resource?.document?.properties[property]);
  if (ref) {
    attributes[`data-godot-${name}-ref`] = `${ref.type}:${ref.id ?? ref.path}`;
  }
}

function resolveTextureImage(
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
  kind: string,
): GodotResolvedResource {
  attributes["data-godot-resource-kind"] = kind;
  const texture = asResourceRef(props.texture);
  if (!texture) {
    return {};
  }
  attributes["data-godot-texture-ref"] =
    `${texture.type}:${texture.id ?? texture.path}`;
  const image = imageResource(
    normalizeResource(options.resolveResource?.(texture, source)),
    options,
    source,
  );
  if (image.path) {
    attributes["data-godot-resource-path"] = image.path;
  }
  return image;
}

function assignResourceRefAttributes(
  attributes: Record<string, string>,
  value: GodotVariant | undefined,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
  name: string,
): void {
  const ref = asResourceRef(value);
  if (!ref) {
    return;
  }
  attributes[`data-godot-${name}-ref`] = `${ref.type}:${ref.id ?? ref.path}`;
  const resource = normalizeResource(options.resolveResource?.(ref, source));
  const type =
    resource?.type ?? asString(resource?.document?.header?.attributes.type);
  if (type) {
    attributes[`data-godot-${name}-type`] = type;
  }
  if (resource?.path) {
    attributes[`data-godot-${name}-path`] = resource.path;
  }
}

function resolvedResource(
  value: GodotVariant | undefined,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): GodotResolvedResource | undefined {
  const ref = asResourceRef(value);
  return ref
    ? normalizeResource(options.resolveResource?.(ref, source))
    : undefined;
}

function assignNumberAttribute(
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  property: string,
  attribute: string,
): void {
  const value = asNumber(props[property]);
  if (value !== undefined) {
    attributes[attribute] = String(value);
  }
}

function assignBooleanAttribute(
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  property: string,
  attribute: string,
): void {
  const value = asBoolean(props[property]);
  if (value !== undefined) {
    attributes[attribute] = String(value);
  }
}

function assignVectorAttribute(
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  property: string,
  attribute: string,
): void {
  const value = asVector2(props[property]);
  if (value) {
    attributes[attribute] = `${value.x},${value.y}`;
  }
}

function assignRectAttribute(
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  property: string,
  attribute: string,
): void {
  const value = asRect2(props[property]);
  if (value) {
    attributes[attribute] =
      `${value.x},${value.y},${value.width},${value.height}`;
  }
}

function vector2Points(
  value: GodotVariant | undefined,
): Array<{ x: number; y: number }> {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const point = asVector2(item);
      return point ? [point] : [];
    });
  }
  if (isCallValue(value) && value.type === "PackedVector2Array") {
    const points: Array<{ x: number; y: number }> = [];
    for (let index = 0; index + 1 < value.args.length; index += 2) {
      const x = value.args[index];
      const y = value.args[index + 1];
      if (typeof x === "number" && typeof y === "number") {
        points.push({ x, y });
      }
    }
    return points;
  }
  return [];
}

function packedNumberArray(value: GodotVariant | undefined): number[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "number" ? [item] : []));
  }
  if (value && isCallValue(value)) {
    return value.args.flatMap((item) =>
      typeof item === "number" ? [item] : [],
    );
  }
  return [];
}

function packedColorValues(value: GodotVariant | undefined): Rgba[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const color = rgbaValue(item);
      return color ? [color] : [];
    });
  }
  if (value && isCallValue(value)) {
    const colors: Rgba[] = [];
    for (let index = 0; index + 3 < value.args.length; index += 4) {
      const color = rgbaValue({
        type: "Color",
        args: value.args
          .slice(index, index + 4)
          .filter((item): item is number => typeof item === "number"),
      });
      if (color) {
        colors.push(color);
      }
    }
    return colors;
  }
  return [];
}

function rgbaValue(value: GodotVariant | undefined): Rgba | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("type" in value) ||
    value.type !== "Color" ||
    !Array.isArray(value.args)
  ) {
    return undefined;
  }
  const [r = 0, g = 0, b = 0, a = 1] = value.args;
  return typeof r === "number" &&
    typeof g === "number" &&
    typeof b === "number" &&
    typeof a === "number" &&
    Number.isFinite(r) &&
    Number.isFinite(g) &&
    Number.isFinite(b) &&
    Number.isFinite(a)
    ? { r, g, b, a }
    : undefined;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

// Variants whose `{ type, args }` shape is a known scalar — NOT an arbitrary
// constructor. Excluding these preserves the old `kind === "Call"` semantics
// (which only tagged unrecognized constructors like PackedVector2Array).
const SCALAR_VARIANT_TYPES = new Set([
  "Vector2",
  "Vector2i",
  "Vector3",
  "Vector3i",
  "Vector4",
  "Vector4i",
  "Color",
  "Rect2",
  "Rect2i",
  "NodePath",
  "StringName",
  "ExtResource",
  "SubResource",
]);

function isCallValue(value: GodotVariant): value is GodotCallVariant {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "type" in value &&
      typeof value.type === "string" &&
      !SCALAR_VARIANT_TYPES.has(value.type) &&
      "args" in value &&
      Array.isArray((value as GodotCallVariant).args),
  );
}
