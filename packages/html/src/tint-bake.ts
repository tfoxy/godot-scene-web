// Post-mount pass that replaces `filter: url(#godot-tint-N)` texture tints with
// the SAME color transform baked into the bitmap itself.
//
// Why: a CSS `filter` is a paint boundary — the browser rasterizes the filtered
// layer axis-aligned and a ROTATED ancestor then resamples that raster, visibly
// blurring the texture (the fanned combat-hand cards). Embedded (data-URI)
// textures already avoid this by baking the matrix into an SVG `<image>` at
// render time; EXTERNAL urls can't (SVG-as-CSS-background loads in secure static
// mode, which refuses external references), so they fall back to the CSS filter
// (`data-godot-texture-tint="css-filter"`). This pass closes that gap in live
// DOM hosts: it loads the external texture, applies the exposed color matrix
// per-pixel on a canvas, swaps the painted url for the tinted data URL, and
// strips the filter reference — pixel-identical output, no raster boundary.
//
// The html-string renderer never runs this (no DOM); it keeps the CSS filter.

import { clampNinePatchSlices } from "./textures";

const BAKED_CACHE = new Map<string, Promise<string | null>>();
const NATURAL_SIZE_CACHE = new Map<
  string,
  Promise<{ width: number; height: number } | null>
>();

export type TintBakeImageLoader = (
  url: string,
) => Promise<CanvasImageSource & { width: number; height: number }>;

const defaultLoadImage: TintBakeImageLoader = (url) =>
  new Promise((resolvePromise, rejectPromise) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolvePromise(image);
    image.onerror = () => rejectPromise(new Error(`image load failed: ${url}`));
    image.src = url;
  });

/**
 * Apply a row-major 3×3 linear RGB transform to RGBA pixel bytes in place
 * (sRGB byte domain, alpha untouched) — the per-pixel equivalent of the
 * `feColorMatrix` emitted with `color-interpolation-filters="sRGB"`.
 */
export function applyColorMatrixToPixels(
  pixels: Uint8ClampedArray,
  rows: readonly number[],
): void {
  if (rows.length !== 9) {
    return;
  }
  const [r0, r1, r2, g0, g1, g2, b0, b1, b2] = rows;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    pixels[i] = r0 * r + r1 * g + r2 * b;
    pixels[i + 1] = g0 * r + g1 * g + g2 * b;
    pixels[i + 2] = b0 * r + b1 * g + b2 * b;
  }
}

function parseMatrix(value: string | null): readonly number[] | undefined {
  if (!value) {
    return undefined;
  }
  const rows = value.trim().split(/\s+/).map(Number);
  return rows.length === 9 && rows.every(Number.isFinite) ? rows : undefined;
}

// The painted url lives either in `background-image` (TextureRect) or
// `border-image-source` (external NinePatchRect). Returns the style property
// that carries it plus the bare url.
function paintedUrl(
  element: HTMLElement,
):
  | { property: "background-image" | "border-image-source"; url: string }
  | undefined {
  for (const property of ["background-image", "border-image-source"] as const) {
    const value = element.style.getPropertyValue(property);
    const match = /^url\((["']?)(.*)\1\)$/.exec(value.trim());
    if (match?.[2] && !match[2].startsWith("data:")) {
      return { property, url: match[2] };
    }
  }
  return undefined;
}

function bakedTintUrl(
  url: string,
  rows: readonly number[],
  loadImage: TintBakeImageLoader,
): Promise<string | null> {
  const key = `${rows.join(",")}|${url}`;
  let pending = BAKED_CACHE.get(key);
  if (!pending) {
    pending = (async () => {
      const image = await loadImage(url);
      const width = Number(image.width);
      const height = Number(image.height);
      if (!width || !height) {
        return null;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return null;
      }
      context.drawImage(image, 0, 0);
      // Throws on a tainted canvas (cross-origin without CORS) — caught by the
      // caller, which keeps the CSS filter as the fallback.
      const imageData = context.getImageData(0, 0, width, height);
      applyColorMatrixToPixels(imageData.data, rows);
      context.putImageData(imageData, 0, 0);
      return canvas.toDataURL("image/png");
    })().catch(() => null);
    BAKED_CACHE.set(key, pending);
  }
  return pending;
}

// Remove exactly this tint's `url(#id)` token from the inline filter (it may be
// composed with other refs, and serializers may quote the fragment); drop the
// property when nothing remains.
function stripTintFilterRef(element: HTMLElement, filterId: string): void {
  const escaped = filterId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ref = new RegExp(`#${escaped}["')]`);
  const tokens = (element.style.filter ?? "")
    .split(/\s+(?=url\()/)
    .filter((token) => token.length > 0 && !ref.test(token));
  if (tokens.length) {
    element.style.filter = tokens.join(" ");
  } else {
    element.style.removeProperty("filter");
  }
}

/**
 * Upgrade every `data-godot-texture-tint="css-filter"` element under `root` to
 * a baked tinted bitmap (see module comment). Idempotent: upgraded elements are
 * re-marked `baked-bitmap`; failures (image load, tainted canvas) keep the CSS
 * filter. Resolves once every candidate settled; returns the upgraded count.
 */
export async function bakeExternalTextureTints(
  root: ParentNode,
  loadImage: TintBakeImageLoader = defaultLoadImage,
): Promise<number> {
  const candidates = [
    ...root.querySelectorAll<HTMLElement>(
      '[data-godot-texture-tint="css-filter"][data-godot-tint-matrix]',
    ),
  ];
  const results = await Promise.all(
    candidates.map(async (element) => {
      const rows = parseMatrix(element.getAttribute("data-godot-tint-matrix"));
      const filterId = element.getAttribute("data-godot-tint-filter-id");
      const painted = paintedUrl(element);
      if (!rows || !filterId || !painted) {
        return false;
      }
      const baked = await bakedTintUrl(painted.url, rows, loadImage);
      // The element may have been re-rendered/replaced while the bitmap loaded.
      if (
        baked === null ||
        !element.isConnected ||
        element.getAttribute("data-godot-texture-tint") !== "css-filter"
      ) {
        return false;
      }
      element.style.setProperty(painted.property, `url("${baked}")`);
      stripTintFilterRef(element, filterId);
      element.setAttribute("data-godot-texture-tint", "baked-bitmap");
      return true;
    }),
  );
  return results.filter(Boolean).length;
}

// Size-only loader: reading an image's NATURAL dimensions never needs a clean (CORS)
// canvas (unlike the tint bake), so don't set `crossOrigin` — that would needlessly fail
// the load for a cross-origin texture served without CORS headers, whose size is still
// readable. (Same-origin `/res/` textures — the couch-coop case — load either way.)
const defaultSizeLoader: TintBakeImageLoader = (url) =>
  new Promise((resolvePromise, rejectPromise) => {
    const image = new Image();
    image.onload = () => resolvePromise(image);
    image.onerror = () => rejectPromise(new Error(`image load failed: ${url}`));
    image.src = url;
  });

function naturalImageSize(
  url: string,
  loadImage: TintBakeImageLoader,
): Promise<{ width: number; height: number } | null> {
  let pending = NATURAL_SIZE_CACHE.get(url);
  if (!pending) {
    pending = loadImage(url)
      .then((image) => {
        const width = Number(image.width);
        const height = Number(image.height);
        return width && height ? { width, height } : null;
      })
      .catch(() => null);
    NATURAL_SIZE_CACHE.set(url, pending);
  }
  return pending;
}

/**
 * Re-clamp external nine-patch `border-image-slice` once the texture's natural size is
 * known. The string renderer can't size an EXTERNAL texture, so it leaves the source slices
 * at the raw patch margins and marks the element `data-godot-nine-patch-unclamped` (carrying
 * those `top,right,bottom,left` margins). For a texture whose opposing margins meet/overlap
 * in the SOURCE, the browser drops the `border-image` `fill` center (the slanted end-caps
 * paint but the stretched middle does not — e.g. the HP-bar fill). Clamping the source slices
 * to keep a >=1px center restores it — the same fix `clampNinePatchSlices` applies inline when
 * the size IS known (embedded data-URI textures). Idempotent: an image-load failure leaves the
 * marker for a later pass; a successful pass clears it. Returns the count whose slices changed.
 */
export async function clampExternalNinePatchSlices(
  root: ParentNode,
  loadImage: TintBakeImageLoader = defaultSizeLoader,
): Promise<number> {
  const candidates = [
    ...root.querySelectorAll<HTMLElement>("[data-godot-nine-patch-unclamped]"),
  ];
  const results = await Promise.all(
    candidates.map(async (element) => {
      const raw = element.getAttribute("data-godot-nine-patch-unclamped");
      const margins = raw?.split(",").map(Number);
      const painted = paintedUrl(element);
      if (
        margins?.length !== 4 ||
        margins.some((value) => !Number.isFinite(value)) ||
        !painted
      ) {
        return false;
      }
      const size = await naturalImageSize(painted.url, loadImage);
      // The element may have been re-rendered/replaced while the image loaded; a failed
      // load (null) keeps the marker so a later pass can retry.
      if (
        !size ||
        !element.isConnected ||
        !element.hasAttribute("data-godot-nine-patch-unclamped")
      ) {
        return false;
      }
      const source = margins as [number, number, number, number];
      const clamped = clampNinePatchSlices(source, size);
      element.removeAttribute("data-godot-nine-patch-unclamped");
      if (clamped === source) {
        return false; // margins fit the source — no center-drop to fix
      }
      element.style.setProperty(
        "border-image-slice",
        `${clamped.join(" ")} fill`,
      );
      return true;
    }),
  );
  return results.filter(Boolean).length;
}
