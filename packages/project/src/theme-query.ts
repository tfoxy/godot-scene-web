import {
  asString,
  type GodotResource,
  type GodotVariant,
} from "@godot-scene-web/core";

// Theme item names that resolve to Godot's "font_sizes" data category and, absent a
// type/variation-specific entry, fall back to the theme-wide `default_font_size`.
const FONT_SIZE_ITEMS = new Set([
  "font_size",
  "normal_font_size",
  "bold_font_size",
  "italics_font_size",
  "bold_italics_font_size",
  "mono_font_size",
  "title_font_size",
]);

/**
 * Resolve a single theme item for a node from a parsed Theme resource document,
 * following Godot's lookup cascade: the node's `theme_type_variation` (then that
 * variation's `base_type`), then the node's own type, then the theme-wide default.
 *
 * A parsed Theme `.tres` flattens its entries to keys like `default_font_size`,
 * `Label/colors/font_color`, `RichTextLabel/font_sizes/normal_font_size`, and
 * `<Variation>/base_type` — so the lookup is plain property access by composed key.
 *
 * v1 covers FONT SIZES only — the gap that left themed labels (e.g. a RichTextLabel whose
 * size lives in its theme's `default_font_size`, not an inline `theme_override`) rendering
 * at the renderer's 1em fallback. Every other item kind returns `undefined`, so colors,
 * fonts and constants keep their current behavior (inline overrides + renderer defaults).
 */
export function queryTheme(
  themeDoc: GodotResource,
  nodeType: string | undefined,
  themeTypeVariation: string | undefined,
  name: string,
): GodotVariant | undefined {
  if (!FONT_SIZE_ITEMS.has(name)) return undefined;
  const props = themeDoc.properties;
  const inType = (type: string | undefined): GodotVariant | undefined =>
    type ? props[`${type}/font_sizes/${name}`] : undefined;

  const variationValue = inType(themeTypeVariation);
  if (variationValue !== undefined) return variationValue;
  if (themeTypeVariation) {
    const baseValue = inType(
      asString(props[`${themeTypeVariation}/base_type`]),
    );
    if (baseValue !== undefined) return baseValue;
  }
  const typeValue = inType(nodeType);
  if (typeValue !== undefined) return typeValue;
  // Theme-wide default size (Godot `Theme.default_font_size`).
  return props.default_font_size;
}
