import {
  type ColorMatrix,
  colorMatrixFeValues,
  escapeAttribute,
  round,
} from "./css-values";
import { createStringLru } from "./lru";

export interface AtlasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AtlasSize {
  width: number;
  height: number;
}

export function zeroAtlasMargin(): AtlasRect {
  return { x: 0, y: 0, width: 0, height: 0 };
}

export function hasAtlasMargin(
  margin: AtlasRect | undefined,
): margin is AtlasRect {
  return (
    !!margin &&
    (margin.x !== 0 ||
      margin.y !== 0 ||
      margin.width !== 0 ||
      margin.height !== 0)
  );
}

export function atlasTextureMetrics(
  region: { width: number; height: number },
  margin: { width: number; height: number } | undefined,
): AtlasSize {
  return {
    width: region.width + (margin?.width ?? 0),
    height: region.height + (margin?.height ?? 0),
  };
}

/**
 * Crop an atlas region (plus its transparent margin) into a standalone SVG data
 * URL. Producing a self-contained image lets every downstream consumer treat an
 * AtlasTexture sprite exactly like a plain Texture2D (stretch modes, nine-patch,
 * modulate tint) instead of re-deriving Godot's atlas draw rect via CSS offsets.
 *
 * When a `tint` is given, the color matrix is baked onto the raster image inside
 * this single SVG (alpha-preserving `feColorMatrix`). Doing the crop and the tint
 * in ONE flat SVG avoids wrapping the cropped SVG in a second SVG `<image>` — a
 * nested SVG-data-URI that browsers refuse to rasterize as a CSS background.
 */
export function atlasTextureDataUrl(
  imageUrl: string,
  atlasSize: AtlasSize,
  region: AtlasRect,
  margin: AtlasRect,
  tint?: ColorMatrix,
): string {
  const key = atlasDataUrlKey(imageUrl, atlasSize, region, margin, tint);
  const hit = atlasDataUrlCache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const url = buildAtlasTextureDataUrl(
    imageUrl,
    atlasSize,
    region,
    margin,
    tint,
  );
  atlasDataUrlCache.set(key, url);
  return url;
}

// Memo for the atlas crop URLs (module-scoped LRU). WHY: every atlas sprite rebuilds the same
// SVG markup + `encodeURIComponent` on every render, and a card burst re-renders hundreds of
// them from a handful of distinct crops. Pure string→string, so a hit is byte-identical.
const ATLAS_DATA_URL_CACHE_LIMIT = 200;
const atlasDataUrlCache = createStringLru<string>(ATLAS_DATA_URL_CACHE_LIMIT);

// Full input signature. Fixed-arity numeric fields FIRST and the (unbounded, arbitrary-content)
// image url LAST, so a url containing the separator can never alias another key's fields.
function atlasDataUrlKey(
  imageUrl: string,
  atlasSize: AtlasSize,
  region: AtlasRect,
  margin: AtlasRect,
  tint: ColorMatrix | undefined,
): string {
  const tintKey = tint ? tint.rows.map((row) => row.join(",")).join(";") : "";
  return (
    `${atlasSize.width},${atlasSize.height}` +
    `|${region.x},${region.y},${region.width},${region.height}` +
    `|${margin.x},${margin.y},${margin.width},${margin.height}` +
    `|${tintKey}|${imageUrl}`
  );
}

/** TEST-ONLY: clear the atlas data-URL memo so a test starts from an empty cache. */
export function __resetAtlasDataUrlCacheForTest(): void {
  atlasDataUrlCache.clear();
}

function buildAtlasTextureDataUrl(
  imageUrl: string,
  atlasSize: AtlasSize,
  region: AtlasRect,
  margin: AtlasRect,
  tint?: ColorMatrix,
): string {
  const texture = atlasTextureMetrics(region, margin);
  const source = {
    x: region.x - margin.x,
    y: region.y - margin.y,
    width: texture.width,
    height: texture.height,
  };
  const left = Math.max(region.x, source.x);
  const top = Math.max(region.y, source.y);
  const right = Math.min(region.x + region.width, source.x + source.width);
  const bottom = Math.min(region.y + region.height, source.y + source.height);
  const clipped = {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
  const dest = {
    x: clipped.x - source.x,
    y: clipped.y - source.y,
    width: clipped.width,
    height: clipped.height,
  };
  const filterId = "godot-texture-tint";
  const defs = tint
    ? `<defs><filter id="${filterId}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${colorMatrixFeValues(tint)}"/></filter></defs>`
    : "";
  const filterAttr = tint ? ` filter="url(#${filterId})"` : "";
  const image =
    clipped.width > 0 && clipped.height > 0
      ? `<svg x="${round(dest.x)}" y="${round(dest.y)}" width="${round(dest.width)}" height="${round(dest.height)}" viewBox="${round(clipped.x)} ${round(clipped.y)} ${round(clipped.width)} ${round(clipped.height)}" preserveAspectRatio="none">${defs}<image href="${escapeAttribute(imageUrl)}" x="0" y="0" width="${round(atlasSize.width)}" height="${round(atlasSize.height)}"${filterAttr}/></svg>`
      : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${round(texture.width)}" height="${round(texture.height)}" viewBox="0 0 ${round(texture.width)} ${round(texture.height)}">${image}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
