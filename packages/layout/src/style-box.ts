import {
  asResourceRef,
  asString,
  type GodotResource,
  type GodotVariant,
} from "@godot-scene-web/core";
import { normalizeRect, numeric } from "./rects";
import type { GodotLayoutOptions, GodotRect, IndexedNode } from "./types";

export interface StyleBoxMetrics {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function contentRectForStyleBox(
  rect: GodotRect,
  metrics: StyleBoxMetrics,
): GodotRect {
  return normalizeRect({
    x: rect.x + metrics.left,
    y: rect.y + metrics.top,
    width: rect.width - metrics.left - metrics.right,
    height: rect.height - metrics.top - metrics.bottom,
  });
}

export function panelStyleBoxMetrics(
  indexed: IndexedNode,
  options: GodotLayoutOptions,
): StyleBoxMetrics {
  const stylebox =
    resolveStyleBox(
      indexed.props["theme_override_styles/panel"],
      indexed,
      options,
    ) ??
    resolveStyleBox(
      options.resolveTheme?.(indexed.node, "panel"),
      indexed,
      options,
    );
  return styleBoxMetrics(stylebox);
}

export function resolveStyleBox(
  value: GodotVariant | undefined,
  indexed: IndexedNode,
  options: GodotLayoutOptions,
): unknown {
  const ref = asResourceRef(value);
  return ref ? options.resolveResource?.(ref, indexed.node) : value;
}

function styleBoxMetrics(resource: unknown): StyleBoxMetrics {
  const { type, properties } = resourceDocument(resource);
  if (!type || type === "StyleBoxEmpty") {
    return { left: 0, top: 0, right: 0, bottom: 0 };
  }
  const props = properties ?? {};
  if (type === "StyleBoxFlat") {
    const borders = {
      left:
        numeric(props, "border_width_left") ??
        numeric(props, "border_width_all") ??
        0,
      top:
        numeric(props, "border_width_top") ??
        numeric(props, "border_width_all") ??
        0,
      right:
        numeric(props, "border_width_right") ??
        numeric(props, "border_width_all") ??
        0,
      bottom:
        numeric(props, "border_width_bottom") ??
        numeric(props, "border_width_all") ??
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
      numeric(props, "content_margin_left") ??
        numeric(props, "content_margin_all") ??
        0,
    ),
    top: Math.max(
      0,
      numeric(props, "content_margin_top") ??
        numeric(props, "content_margin_all") ??
        0,
    ),
    right: Math.max(
      0,
      numeric(props, "content_margin_right") ??
        numeric(props, "content_margin_all") ??
        0,
    ),
    bottom: Math.max(
      0,
      numeric(props, "content_margin_bottom") ??
        numeric(props, "content_margin_all") ??
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
    numeric(props, `content_margin_${side}`) ??
    numeric(props, "content_margin_all");
  return value !== undefined && value >= 0 ? value : fallback;
}

function resourceDocument(resource: unknown): {
  type?: string;
  properties?: Record<string, GodotVariant>;
} {
  if (!resource || typeof resource !== "object") {
    return {};
  }
  const record = resource as Record<string, unknown>;
  const directDocument = record.document;
  const document =
    directDocument &&
    typeof directDocument === "object" &&
    !Array.isArray(directDocument)
      ? (directDocument as GodotResource)
      : undefined;
  const properties =
    document?.properties ??
    (record.properties &&
    typeof record.properties === "object" &&
    !Array.isArray(record.properties)
      ? (record.properties as Record<string, GodotVariant>)
      : undefined);
  return {
    type:
      asString(document?.header?.attributes.type) ??
      (typeof record.type === "string" ? record.type : undefined),
    properties,
  };
}
