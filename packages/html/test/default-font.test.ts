// @vitest-environment node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GODOT_DEFAULT_FONT_DATA_URL } from "../src/default-font-data";
import { godotSceneBaseCss, renderFontFaceCss } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const vendorDir = join(pkgDir, "vendor");
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("Godot default-theme font", () => {
  it("uses Godot 4.5.1's Open Sans SemiBold bytes for implicit text", async () => {
    const font = await readFile(join(vendorDir, "OpenSans_SemiBold.woff2"));
    expect(font.byteLength).toBe(46_392);
    expect(sha256(font)).toBe(
      "661e2d9975d3029aeb32bf37b1b963c31c7c3ce08ac1bab2c8ebe27e135c4ec2",
    );
    expect(GODOT_DEFAULT_FONT_DATA_URL).toBe(
      `data:font/woff2;base64,${font.toString("base64")}`,
    );
  });

  it("registers the default face while retaining explicit faces", () => {
    const css = renderFontFaceCss([
      {
        fontFamily: "Explicit FontFile",
        url: "/font.ttf",
        style: "italic",
        weight: "700",
      },
    ]);
    expect(css).toContain('font-family: "Godot Default"');
    expect(css).toContain('format("woff2")');
    expect(css).toContain('font-family: "Explicit FontFile"');
    expect(css).toContain('format("truetype")');
    expect(godotSceneBaseCss).toContain(
      'font-family: "Godot Default", sans-serif',
    );
  });

  it("ships the font, provenance, and license in the package", async () => {
    const manifest = JSON.parse(
      await readFile(join(pkgDir, "package.json"), "utf8"),
    ) as { files: string[] };
    expect(manifest.files).toContain("vendor");
    await expect(
      readFile(join(vendorDir, "VENDOR.md"), "utf8"),
    ).resolves.toContain("Apache License 2.0");
    await expect(
      readFile(join(vendorDir, "LICENSE-OpenSans"), "utf8"),
    ).resolves.toContain("Apache License");
  });
});
