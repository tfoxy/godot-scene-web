import {
  asNumber,
  asResourceRef,
  asString,
  type GodotVariant,
} from "@godot-scene-web/core";
import type { GodotSceneTreeNode } from "@godot-scene-web/layout";
import { colorCss, round } from "./css-values";
import { normalizeResource, sourceNodeForLayout } from "./resources";
import type { GodotHtmlRenderOptions, GodotResolvedResource } from "./types";

export function assignPanelStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  node: GodotSceneTreeNode,
  options: GodotHtmlRenderOptions,
): void {
  const source = sourceNodeForLayout(node);
  const stylebox =
    resolveStyleBox(props["theme_override_styles/panel"], node, options) ??
    resolveStyleBox(options.resolveTheme?.(source, "panel"), node, options);
  applyStyleBox(style, attributes, stylebox, "panel");
}

export function assignInputStyleBoxStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  node: GodotSceneTreeNode,
  options: GodotHtmlRenderOptions,
): void {
  const source = sourceNodeForLayout(node);
  const stylebox =
    resolveStyleBox(props["theme_override_styles/normal"], node, options) ??
    resolveStyleBox(options.resolveTheme?.(source, "normal"), node, options);
  applyStyleBox(style, attributes, stylebox, "normal");
}

function resolveStyleBox(
  value: GodotVariant | undefined,
  node: GodotSceneTreeNode,
  options: GodotHtmlRenderOptions,
): GodotResolvedResource | undefined {
  const ref = asResourceRef(value);
  return ref
    ? normalizeResource(
        options.resolveResource?.(ref, sourceNodeForLayout(node)),
      )
    : normalizeResource(value);
}

function applyStyleBox(
  style: Record<string, string>,
  attributes: Record<string, string>,
  resource: GodotResolvedResource | undefined,
  slot: string,
): void {
  const document = resource?.document;
  const type = resource?.type ?? asString(document?.header?.attributes.type);
  if (!type) {
    return;
  }
  attributes[`data-godot-stylebox-${slot}`] = type;
  if (type === "StyleBoxEmpty") {
    style.background = "transparent";
    style.border = "0";
    return;
  }
  if (type !== "StyleBoxFlat" || !document) {
    return;
  }
  const props = document.properties;
  const bg = colorCss(props.bg_color);
  const borderColor = colorCss(props.border_color);
  if (bg) {
    style.background = bg;
  }
  if (borderColor) {
    style["border-color"] = borderColor;
  }
  style["border-style"] = "solid";
  const widths = [
    asNumber(props.border_width_top) ?? asNumber(props.border_width_all) ?? 0,
    asNumber(props.border_width_right) ?? asNumber(props.border_width_all) ?? 0,
    asNumber(props.border_width_bottom) ??
      asNumber(props.border_width_all) ??
      0,
    asNumber(props.border_width_left) ?? asNumber(props.border_width_all) ?? 0,
  ];
  if (widths.some((width) => width !== 0)) {
    style["border-width"] = widths
      .map((width) => `${round(width)}px`)
      .join(" ");
  }
  const radii = [
    asNumber(props.corner_radius_top_left) ??
      asNumber(props.corner_radius_all) ??
      0,
    asNumber(props.corner_radius_top_right) ??
      asNumber(props.corner_radius_all) ??
      0,
    asNumber(props.corner_radius_bottom_right) ??
      asNumber(props.corner_radius_all) ??
      0,
    asNumber(props.corner_radius_bottom_left) ??
      asNumber(props.corner_radius_all) ??
      0,
  ];
  if (radii.some((radius) => radius !== 0)) {
    style["border-radius"] = radii
      .map((radius) => `${round(radius)}px`)
      .join(" ");
  }
  const margins = [
    asNumber(props.content_margin_top),
    asNumber(props.content_margin_right),
    asNumber(props.content_margin_bottom),
    asNumber(props.content_margin_left),
  ];
  if (margins.some((margin) => margin !== undefined)) {
    style.padding = margins
      .map((margin) => `${round(margin ?? 0)}px`)
      .join(" ");
  }
}

export interface StyleBoxMetrics {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function panelStyleBoxMetrics(
  node: GodotSceneTreeNode,
  options: GodotHtmlRenderOptions,
): StyleBoxMetrics {
  const source = sourceNodeForLayout(node);
  return styleBoxMetrics(
    resolveStyleBox(
      node.properties["theme_override_styles/panel"],
      node,
      options,
    ) ??
      resolveStyleBox(options.resolveTheme?.(source, "panel"), node, options),
  );
}

function styleBoxMetrics(
  resource: GodotResolvedResource | undefined,
): StyleBoxMetrics {
  const document = resource?.document;
  const type = resource?.type ?? asString(document?.header?.attributes.type);
  if (!type || type === "StyleBoxEmpty") {
    return { left: 0, top: 0, right: 0, bottom: 0 };
  }
  const props = document?.properties ?? {};
  if (type === "StyleBoxFlat") {
    const borders = {
      left:
        asNumber(props.border_width_left) ??
        asNumber(props.border_width_all) ??
        0,
      top:
        asNumber(props.border_width_top) ??
        asNumber(props.border_width_all) ??
        0,
      right:
        asNumber(props.border_width_right) ??
        asNumber(props.border_width_all) ??
        0,
      bottom:
        asNumber(props.border_width_bottom) ??
        asNumber(props.border_width_all) ??
        0,
    };
    return {
      left: styleBoxMargin(props, "left", borders.left),
      top: styleBoxMargin(props, "top", borders.top),
      right: styleBoxMargin(props, "right", borders.right),
      bottom: styleBoxMargin(props, "bottom", borders.bottom),
    };
  }
  return {
    left: Math.max(
      0,
      asNumber(props.content_margin_left) ??
        asNumber(props.content_margin_all) ??
        0,
    ),
    top: Math.max(
      0,
      asNumber(props.content_margin_top) ??
        asNumber(props.content_margin_all) ??
        0,
    ),
    right: Math.max(
      0,
      asNumber(props.content_margin_right) ??
        asNumber(props.content_margin_all) ??
        0,
    ),
    bottom: Math.max(
      0,
      asNumber(props.content_margin_bottom) ??
        asNumber(props.content_margin_all) ??
        0,
    ),
  };
}

function styleBoxMargin(
  props: Record<string, GodotVariant>,
  side: "left" | "top" | "right" | "bottom",
  fallback: number,
): number {
  const value =
    asNumber(props[`content_margin_${side}`]) ??
    asNumber(props.content_margin_all);
  return value !== undefined && value >= 0 ? value : fallback;
}
