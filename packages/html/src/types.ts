import type {
  GodotNode,
  GodotResource,
  GodotResourceRefValue,
  GodotVariant,
} from "@godot-scene-web/core";
import type { GodotBlendMode } from "@godot-scene-web/effects/shaders";
import type { GodotSceneTreeDiagnostic } from "@godot-scene-web/layout";
import type { GodotAnchorMap } from "@godot-scene-web/layout/anchors";
import type {
  GodotResourceLoadStatus,
  GodotResourceStatus,
} from "@godot-scene-web/scene-graph";
import type { GodotContentScale, ResolvedContentScale } from "./content-scale";
import type { GodotTextScaleOption } from "./text-scale";

/**
 * A `<filter>` referenced by a self-layer's `filter: url(#id)` (an external
 * texture's color-matrix tint, or a consumer-supplied shader-fallback effect).
 * `markup` is the filter's inner SVG (e.g. a `feColorMatrix`, or a
 * luminance→band→flood chain). Emitted once per render into a hidden
 * `<svg><defs>` by every renderer.
 */
export interface GodotHtmlTintFilter {
  id: string;
  markup: string;
}

export interface GodotHtmlModel {
  viewport: { width: number; height: number };
  nodes: GodotHtmlNode[];
  fontFaces: GodotHtmlFontFace[];
  tintFilters: GodotHtmlTintFilter[];
  diagnostics: GodotSceneTreeDiagnostic[];
  resourceStatuses: GodotResourceStatus[];
  css: string;
  // Resolved Window content-scale framing, or `null` when the scene renders at a
  // fixed size (the default). Carried on the model so the DOM, Vue, and HTML
  // string renderers all build the same `.godot-scene-frame` wrapper.
  contentScale: ResolvedContentScale | null;
}

export type GodotHtmlPositioning = "root" | "absolute" | "container-managed";
export type GodotHtmlContainerLayout =
  | "box"
  | "flow"
  | "grid"
  | "center"
  | "margin"
  | "panel"
  | "scroll"
  | "aspect-ratio";

export interface GodotHtmlNode {
  // Discriminator for pruned subtrees: an effectively-hidden node (own
  // `visible = false`, or any ancestor hidden) is kept IN POSITION among its
  // siblings as a minimal placeholder — every renderer emits it as a comment
  // (`<!--godot:hidden <path> (<Type>)-->`) instead of an element, and its
  // descendants are dropped from the model entirely. Absent = regular node.
  kind?: "hidden-placeholder";
  path: string;
  name: string;
  type: string;
  parentPath: string | null;
  children: string[];
  positioning: GodotHtmlPositioning;
  containerLayout: GodotHtmlContainerLayout | null;
  attributes: Record<string, string>;
  className: string;
  style: Record<string, string>;
  selfAttributes: Record<string, string>;
  selfStyle: Record<string, string>;
  text: string | null;
  html: string | null;
}

export interface GodotResolvedResource {
  status?: GodotResourceLoadStatus;
  type?: string;
  path?: string;
  url?: string;
  document?: GodotResource;
  atlas?: GodotResolvedResource;
  shader?: GodotResolvedResource;
  region?: { x: number; y: number; width: number; height: number };
  margin?: { x: number; y: number; width: number; height: number };
  // An AtlasTexture is resolved to a standalone cropped image (`url`) with
  // `region`/`margin` cleared so consumers treat it like a plain Texture2D. This
  // preserves the original atlas crop inputs so a later tint can re-bake the crop
  // and the color matrix into ONE flat SVG (instead of nesting SVG data URIs).
  atlasCrop?: {
    region: { x: number; y: number; width: number; height: number };
    margin: { x: number; y: number; width: number; height: number };
  };
  size?: { width: number; height: number };
  fontFamily?: string;
  fontUrl?: string;
  fontStyle?: "normal" | "italic";
  fontWeight?: number | string;
  glyphSpacing?: number;
  fontMsdf?: boolean;
  message?: string;
}

export interface GodotHtmlFontFace {
  fontFamily: string;
  url: string;
  style: "normal" | "italic";
  weight: string;
}

export interface GodotTextAutoFitNominalMetrics {
  contentWidthPx: number;
  contentHeightPx: number;
  lines?: { widthPx?: number; heightPx?: number }[];
  metricSource?: string;
}

export interface GodotTextAutoFitDirective {
  minFontSizePx: number;
  maxFontSizePx: number;
  nominalFontSizePx?: number;
  /**
   * Paragraph geometry the host engine (Godot) measured at `nominalFontSizePx`.
   * When present, auto-fit scales these by `candidate / nominalFontSizePx` to pick
   * a size that matches the engine, instead of measuring the live DOM (which drifts
   * before web fonts resolve). Absent => fall back to DOM measurement.
   */
  nominalMetrics?: GodotTextAutoFitNominalMetrics;
  fitWidth: boolean;
  fitHeight: boolean;
  wrapMode?: string;
  textOverrunBehavior?: string;
}

export interface GodotShaderLoadingFallback {
  background: string;
  clipPath?: string;
  borderRadius?: string;
}

export type GodotBbcodeTagDescriptor =
  | { kind: "color"; value: string }
  | { kind: "style"; css: Record<string, string> }
  | {
      kind: "effect";
      perChar?: boolean;
      perWord?: boolean;
      className?: string;
    };
export interface GodotHtmlRenderOptions {
  classPrefix?: string;
  textAutoFitByPath?: Record<string, GodotTextAutoFitDirective>;
  resolveResource?: (ref: GodotResourceRefValue, node: GodotNode) => unknown;
  resolveResourcePath?: (path: string, node: GodotNode) => unknown;
  resolveTheme?: (node: GodotNode, name: string) => GodotVariant | undefined;
  bbcodeTags?: Record<string, GodotBbcodeTagDescriptor>;
  // Opt-in Window content-scale (e.g. `{ aspect: "keep" }`). Absent => fixed-size
  // render, byte-identical to before.
  contentScale?: GodotContentScale;
  // Opt-in player text scaling. `true` (or `{}`) expresses text sizes as
  // `calc(<px> * var(--godot-text-scale, 1))`; absent => plain px, unchanged.
  textScale?: GodotTextScaleOption;
  // Prefix for the shared color-matrix `<filter>` ids (`${prefix}${n}`). The
  // `filter: url(#id)` references and their `<svg><defs>` live in the same
  // document, so two renders sharing a document (a dev harness showing two
  // stages, or couch-coop's per-player live views) MUST use distinct prefixes or
  // a later render's `url(#godot-tint-2)` resolves to an earlier render's filter.
  // Defaults to `"godot-tint-"`, keeping single-render output (and goldens)
  // byte-identical; live renderers pass a per-instance prefix.
  tintFilterIdPrefix?: string;
  // Declarative node anchors (same map the computed pipeline resolves with
  // `resolveAnchors`). In the browser-native model they are emitted as CSS
  // Anchor Positioning so the browser tracks the target's rendered geometry.
  anchorsByPath?: GodotAnchorMap;
  // Opt-in WebGL shader runtime (live DOM/Vue only). When set, `material.ts` flags
  // ShaderMaterial nodes (`data-godot-shader-webgl`) and the live renderers attach
  // a per-node canvas that runs the ACTUAL shader (transpiled to GLSL). Absent =>
  // the CSS/SVG approximation, byte-identical to before (the static html-string
  // renderer never sets this, so goldens keep the SVG fallback).
  enableWebglShaders?: boolean;
  // Optional, generic pre-WebGL loading paint keyed by rendered node path. This
  // is emitted into the initial HTML model before the runtime attaches, then
  // cleared after the first successful shader render. Consumers own the color and
  // shape; godot-scene-web treats this as renderer metadata, not a Godot prop.
  shaderLoadingFallbacksByPath?: Record<string, GodotShaderLoadingFallback>;
  // Optional generic WebGL shader activation controls. `enableWebglShaders`
  // makes the runtime available; these opt specific rendered nodes or shader
  // identities into that runtime. `shaderLoadingFallbacksByPath` also opts its
  // node in, since a loading fallback only makes sense for a WebGL shader node.
  webglShaderNodesByPath?: Record<string, boolean>;
  // Shader identities to run on the WebGL runtime. Each entry is an exact resource
  // path (`res://….gdshader`) or uid (`uid://…`), a directory-prefix glob ending in
  // `/*` (matches any shader path under that directory — e.g. a shader family), or
  // the bare `"*"` wildcard (every shader-bearing node). Same matching as the other
  // `*ShaderIds` lists below.
  webglShaderIds?: string[];
  // Rendered node paths whose static (non-WebGL) shader paint should be SUPPRESSED:
  // the raw TextureRect/background is hidden (`data-godot-shader-raw-fallback`) so a
  // WebGL canvas the consumer activates isn't doubled by the underlying texture.
  // Consumer-driven (godot-scene-web has no concept of which shaders fully repaint).
  hiddenRawShaderFallbacksByPath?: Record<string, boolean>;
  // Same suppression keyed by shader identity (exact path / uid / `/*` glob / `"*"`)
  // instead of node path — so a whole shader family (e.g. card-affliction overlays)
  // is covered by one entry without enumerating every mounted node.
  hiddenRawShaderFallbackShaderIds?: string[];
  // Shader-ids (exact path / uid / `/*` glob / `"*"`) whose color effect is a linear
  // HSV adjust (the standard `h`/`s`/`v` uniform color matrix). godot-scene-web bakes
  // it to an `feColorMatrix` tint on the static path from the node's `shader_parameter`
  // values. Generic color primitive; the consumer names which shaders use it.
  hsvAdjustShaderIds?: string[];
  // Consumer-supplied static (non-WebGL) fallback SVG filter keyed by rendered node
  // path. Each value is the INNER filter markup (the `feColorMatrix`/`feFlood`/…
  // primitives); godot-scene-web registers it in its shared filter `<defs>` (wrapping
  // it in `<filter id="…" color-interpolation-filters="sRGB">…</filter>`) and applies
  // `filter: url(#id)` to the node. Lets a consumer approximate an un-runnable shader
  // (e.g. an animated glow) without godot-scene-web hardcoding the effect.
  shaderFallbackFiltersByPath?: Record<string, string>;
  // Opt-in live 2D particle runtime (live DOM/Vue only). When set, `visual-2d.ts`
  // flags opted-in CPU/GPUParticles2D nodes (`data-godot-particle-runtime`) with a
  // serialized config (`data-godot-particle-specs`), and the live renderers attach a
  // per-node canvas that runs a deterministic CPU simulation drawn via WebGL. Absent
  // (or no node opted in) => the static `<span>` preview, byte-identical to before
  // (the static html-string renderer never sets this, so goldens keep the preview).
  enableParticles?: boolean;
  // Opt specific rendered node paths into the particle runtime.
  particleNodesByPath?: Record<string, boolean>;
  // Particle identities to run on the runtime. Each entry is an exact process-material
  // or texture resource path / uid, a directory-prefix glob ending in `/*`, or the bare
  // `"*"` wildcard (every particle node). Same matching as `webglShaderIds`. Inline
  // sub-resource process materials have no stable id, so use `particleNodesByPath` or
  // `"*"` for those.
  particleIds?: string[];
  // Which Godot rendering backend this render should imitate. Defaults to `"forward_plus"`,
  // Godot's own default for a new project. Its only effect today is `ParticleProcessMaterial.color`:
  // the two RendererRD backends run it through `Color::srgb_to_linear()` at UBO-upload time and then
  // write the result into a non-linear canvas without undoing it, so a browser render must apply the
  // same curve to match a Forward+/Mobile capture; `"gl_compatibility"` does not and is an exact
  // no-op. Full derivation, the Godot 4.5.1 line references, and the `hdr_2d` limitation:
  // core's `particles/godot-renderer.ts` (canonical type: `GodotRendererBackend`).
  godotRenderer?: "forward_plus" | "mobile" | "gl_compatibility";
}

/**
 * What the effect runtimes know about the frame they just presented/handled, handed to
 * `GodotHtmlRenderOptions.onBindingRendered` alongside the node and its canvas.
 *
 * ADDITIVE, and it stays that way because of how TypeScript reads a callback: a
 * consumer that declares `(node, canvas) => …` still satisfies the option, so the
 * two-argument callers that existed before this parameter are untouched.
 *
 * WHY THESE THREE. A consumer that COMPOSITES the canvas itself — rather than
 * leaving it in the DOM where the runtime placed it — has to reproduce two things
 * the runtime otherwise expresses through CSS, and refuse a third:
 *
 * - `blend` is the shader's Godot `render_mode`. The runtime writes it onto the
 *   node as a `mix-blend-mode` (see `blendToMixBlendMode`), which only means
 *   anything while the canvas is painted by the page's compositor; a consumer
 *   drawing the same pixels into its own surface needs the mode itself.
 * - `usesScreenTexture` says the frame was shaded against a capture of what the
 *   page had already painted BEHIND the node. That capture is a DOM composite
 *   (see `enableScreenTextureCapture`), so it describes the page's stacking — not
 *   a consumer's own surface — and a consumer whose scene is somewhere else
 *   should treat the frame as content it cannot reproduce faithfully.
 * - `usesScreenUv` is the weaker twin: the shader read SCREEN_UV, so its output
 *   depends on where the node sits in the viewport, and moving the pixels
 *   elsewhere moves what they mean.
 *
 * The PARTICLE runtime reports a constant (`"mix"`, neither screen flag): a
 * particle system's own additive mode is resolved INSIDE its canvas, whose
 * finished pixels are premultiplied and composite source-over like any other.
 *
 * …AND A FOURTH, `staticKey`, which is about identity rather than about how to
 * composite one frame: see its own note below.
 */
export interface GodotEffectRenderInfo {
  /** The shader sampled SCREEN_TEXTURE. Always false for particles. */
  usesScreenTexture: boolean;
  /** The shader read SCREEN_UV. Always false for particles. */
  usesScreenUv: boolean;
  /** The shader's `render_mode` blend; always `"mix"` for particles. */
  blend: GodotBlendMode;
  /**
   * The NAME OF THE FRAME this canvas now holds — the runtime's own static-frame
   * key — or null when the frame is not content-addressed at all (live/animating
   * mode, a screen-space shader, textures still decoding, a particle state the
   * live loop has stepped, a blank that ends a burst).
   *
   * WHAT IT PROMISES: the frame is a PURE FUNCTION of this string. It is the same
   * key the static-frame cache stores the bitmap under and the same one the image
   * swap dedupes by, and it is what licenses those two to hand ONE binding's
   * pixels to another. So two canvases reporting one key hold the same picture,
   * and a host that uploads these canvases into its own renderer can upload ONE
   * texture and point every twin at it — which on a hand of identical card glows
   * is one upload instead of seven, of a surface that can be megabytes.
   *
   * A null key means "assume nothing": that frame may be unique to this binding,
   * and a host must key it privately (its node id) as it always did.
   */
  staticKey: string | null;
}
