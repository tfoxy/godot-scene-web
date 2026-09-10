import { round } from "./css-values";

// Godot Window content-scale settings (`Window.content_scale_*` /
// `display/window/stretch/*`). Only `keep` is interpreted today; the rest of the
// enum is accepted so callers can pass real Godot values without a type error and
// so the aspect-specific math has a single place to grow.
export interface GodotContentScaleSize {
  width: number;
  height: number;
}

export type GodotContentScaleAspect =
  | "ignore"
  | "keep"
  | "keep_width"
  | "keep_height"
  | "expand";

export type GodotContentScaleTechnique = "container" | "transform";

export interface GodotContentScale {
  /** Godot `content_scale_aspect`. Only `"keep"` is implemented for now. */
  aspect: GodotContentScaleAspect;
  /**
   * How the uniform scale is realized in the DOM:
   * - `"container"` (default): CSS-only, every length in the stage subtree is
   *   expressed in container-query units. No JavaScript; identical in Vue and the
   *   static HTML document.
   * - `"transform"`: the stage keeps its px layout and is scaled with
   *   `transform: scale(var(--godot-scale))`; the factor is set by JS on resize.
   */
  technique?: GodotContentScaleTechnique;
  /** Base/reference resolution (Godot `content_scale_size`). Defaults to the model viewport. */
  baseSize?: GodotContentScaleSize;
  /** Letterbox/pillarbox bar color painted by the frame around the centered stage. */
  background?: string;
}

export interface ResolvedContentScale {
  aspect: GodotContentScaleAspect;
  technique: GodotContentScaleTechnique;
  base: GodotContentScaleSize;
  background?: string;
}

// Resolve user options against the model viewport. Returns `null` (no framing,
// today's behavior) when content-scale is absent, the base size is degenerate, or
// the aspect is one we don't model yet.
export function resolveContentScale(
  contentScale: GodotContentScale | undefined,
  viewport: GodotContentScaleSize,
): ResolvedContentScale | null {
  if (!contentScale) {
    return null;
  }
  // Only `keep` (uniform fit + letterbox) is interpreted for now. Other aspects
  // fall through to the unscaled render rather than guessing.
  if (contentScale.aspect !== "keep") {
    return null;
  }
  const base = contentScale.baseSize ?? viewport;
  if (!(base.width > 0) || !(base.height > 0)) {
    return null;
  }
  return {
    aspect: contentScale.aspect,
    technique: contentScale.technique ?? "container",
    base: { width: base.width, height: base.height },
    background: contentScale.background,
  };
}

// Matches a CSS px length token (`120px`, `-8px`, `.5px`, `0.25px`). The
// `(?![\w.])` lookahead keeps it from biting into identifiers/filenames such as
// `icon20px.png` or base64 data, so it is safe to run over whole HTML/CSS strings.
const PX_TOKEN = /(-?(?:\d+\.?\d*|\.\d+))px(?![\w.])/g;

// Rewrite every px length in `text` into the container-query form for a uniform
// "Keep" fit of a `base` (A×B) box: scale `s = min(W/A, H/B)`, so a length `p`
// becomes `p·s = min(p·100/A cqw, p·100/B cqh)` for `p >= 0`, and `max(...)` for
// `p < 0` (multiplying by a negative flips the comparison). `cqw`/`cqh` resolve
// against the nearest `.godot-scene-frame` (which sets `container-type: size`).
export function rewritePxLengths(
  text: string,
  base: GodotContentScaleSize,
): string {
  return text.replace(PX_TOKEN, (_match, raw: string) => {
    const px = Number.parseFloat(raw);
    if (!Number.isFinite(px) || px === 0) {
      return "0";
    }
    const widthShare = round((px * 100) / base.width);
    const heightShare = round((px * 100) / base.height);
    const fn = px < 0 ? "max" : "min";
    return `${fn}(${widthShare}cqw, ${heightShare}cqh)`;
  });
}

// Rewrite every px value of a style record in place (container technique).
export function scaleStyleRecord(
  style: Record<string, string>,
  base: GodotContentScaleSize,
): void {
  for (const [name, value] of Object.entries(style)) {
    const rewritten = rewritePxLengths(value, base);
    if (rewritten !== value) {
      style[name] = rewritten;
    }
  }
}

// Inline style merged onto the `.godot-scene-stage` element so the base canvas
// fits the frame while preserving aspect ratio.
export function contentScaleStageStyle(
  resolved: ResolvedContentScale,
): Record<string, string> {
  const { base } = resolved;
  if (resolved.technique === "transform") {
    return {
      width: `${round(base.width)}px`,
      height: `${round(base.height)}px`,
      transform: "scale(var(--godot-scale, 1))",
    };
  }
  // Container technique: the fitted box is `base · s` expressed in cq units.
  const widthAspect = round((base.width / base.height) * 100);
  const heightAspect = round((base.height / base.width) * 100);
  return {
    width: `min(100cqw, ${widthAspect}cqh)`,
    height: `min(${heightAspect}cqw, 100cqh)`,
  };
}

// Live-DOM (Vue / `mountHtmlScene`) scale driver for the transform technique.
// Sets `--godot-scale` on the frame and keeps it in sync on resize. Returns a
// disposer.
export function observeContentScale(
  frame: HTMLElement,
  base: GodotContentScaleSize,
): () => void {
  const fit = (): void => {
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const scale = Math.min(rect.width / base.width, rect.height / base.height);
    frame.style.setProperty("--godot-scale", String(scale));
  };
  fit();
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => observer.disconnect();
  }
  if (typeof window !== "undefined") {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }
  return () => {};
}

// Self-contained `<script>` for the static HTML document (transform technique):
// the string-renderer equivalent of `observeContentScale`, applied to every
// `.godot-scene-frame` on the page.
export function contentScaleScript(base: GodotContentScaleSize): string {
  const a = round(base.width);
  const b = round(base.height);
  return `<script>(function(){var A=${a},B=${b};function fit(f){var r=f.getBoundingClientRect();if(r.width<=0||r.height<=0)return;f.style.setProperty("--godot-scale",String(Math.min(r.width/A,r.height/B)));}var frames=document.querySelectorAll(".godot-scene-frame");var ro=typeof ResizeObserver!=="undefined"?new ResizeObserver(function(es){for(var i=0;i<es.length;i++)fit(es[i].target);}):null;for(var i=0;i<frames.length;i++){fit(frames[i]);if(ro)ro.observe(frames[i]);}if(!ro)window.addEventListener("resize",function(){for(var i=0;i<frames.length;i++)fit(frames[i]);});})();</script>`;
}
