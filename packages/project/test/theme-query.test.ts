import type { GodotResource } from "@godot-scene-web/core";
import { describe, expect, it } from "vitest";
import { queryTheme } from "../src/theme-query";

function themeDoc(properties: Record<string, unknown>): GodotResource {
  return {
    header: null,
    extResources: [],
    subResources: [],
    properties: properties as GodotResource["properties"],
    diagnostics: [],
  };
}

describe("queryTheme", () => {
  it("falls back to the theme-wide default_font_size", () => {
    const doc = themeDoc({ default_font_size: 32 });
    expect(
      queryTheme(doc, "RichTextLabel", undefined, "normal_font_size"),
    ).toBe(32);
    expect(queryTheme(doc, "Label", undefined, "font_size")).toBe(32);
  });

  it("prefers a node-type-specific font size over the default", () => {
    const doc = themeDoc({
      default_font_size: 32,
      "Label/font_sizes/font_size": 20,
    });
    expect(queryTheme(doc, "Label", undefined, "font_size")).toBe(20);
    // No RichTextLabel-specific entry -> still the default.
    expect(queryTheme(doc, "RichTextLabel", undefined, "font_size")).toBe(32);
  });

  it("prefers a type-variation, then its base_type, then default", () => {
    const doc = themeDoc({
      default_font_size: 10,
      "Label/font_sizes/font_size": 20,
      "Big/base_type": "Label",
      "Big/font_sizes/font_size": 40,
    });
    // Variation's own entry wins.
    expect(queryTheme(doc, "Label", "Big", "font_size")).toBe(40);
    // No variation entry -> resolve via the variation's base_type (Label).
    const viaBase = themeDoc({
      default_font_size: 10,
      "Label/font_sizes/font_size": 20,
      "Big/base_type": "Label",
    });
    expect(queryTheme(viaBase, "Control", "Big", "font_size")).toBe(20);
  });

  it("returns undefined for non-font-size items (v1 scope)", () => {
    const doc = themeDoc({
      default_font_size: 32,
      "Label/colors/font_color": { type: "Color", args: [1, 1, 1, 1] },
    });
    expect(queryTheme(doc, "Label", undefined, "font_color")).toBeUndefined();
    expect(
      queryTheme(doc, "Label", undefined, "line_separation"),
    ).toBeUndefined();
  });
});
