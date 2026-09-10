import { asNumber } from "@godot-scene-web/core";
import { numeric } from "./rects";
import type { GodotLayoutOptions, IndexedNode } from "./types";

/**
 * Godot's built-in default theme constants for container nodes, mirroring
 * `scene/theme/default_theme.cpp` (4.5.1, `set_constant(..., Math::round(4 *
 * scale))` at scale 1). A node that does not carry an explicit
 * `theme_override_constants/*` (and whose project theme provides nothing) still
 * inherits these from the default theme, so the layout engine must fall back to
 * them rather than to 0 — e.g. an HBoxContainer with no separation override lays
 * its children out 4px apart, not flush. MarginContainer margins default to 0 in
 * the default theme, so they intentionally have no entry here.
 */
const DEFAULT_THEME_CONSTANTS: Record<string, Record<string, number>> = {
  BoxContainer: { separation: 4 },
  HBoxContainer: { separation: 4 },
  VBoxContainer: { separation: 4 },
  GridContainer: { h_separation: 4, v_separation: 4 },
  FlowContainer: { h_separation: 4, v_separation: 4 },
  HFlowContainer: { h_separation: 4, v_separation: 4 },
  VFlowContainer: { h_separation: 4, v_separation: 4 },
};

function defaultThemeConstant(
  indexed: IndexedNode,
  name: string,
): number | undefined {
  const type = indexed.node.type;
  if (!type) {
    return undefined;
  }
  return DEFAULT_THEME_CONSTANTS[type]?.[name];
}

export function themeNumber(
  indexed: IndexedNode,
  name: string,
  options: GodotLayoutOptions,
): number | undefined {
  return (
    numeric(indexed.props, `theme_override_constants/${name}`) ??
    numeric(indexed.props, `theme_constant_${name}`) ??
    asNumber(options.resolveTheme?.(indexed.node, name)) ??
    defaultThemeConstant(indexed, name)
  );
}
