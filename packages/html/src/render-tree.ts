import { contentScaleStageStyle } from "./content-scale";
import { cssUrl, escapeHtml, styleAttribute } from "./css-values";
import { godotDefaultFontFace } from "./default-font";
import {
  FRAME_CLASS,
  partitionChildren,
  SELF_LAYER_CLASS,
  STAGE_CLASS,
  tintFilterDefsMarkup,
} from "./render-structure";
import type { GodotHtmlFontFace, GodotHtmlModel, GodotHtmlNode } from "./types";

// A framework-agnostic description of one rendered element. The three renderers
// (DOM, HTML string, Vue) all build the SAME `RenderElement` tree from a
// `GodotHtmlModel` and then emit it to their target, so the scene structure —
// node element + self-layer + behind/self/normal child order, the stage/frame
// wrappers, the tint-filter defs, the font/base-css `<style>` — is decided in
// ONE place. Drift bugs (a renderer forgetting the tint defs, or wrapping rich
// text in an extra span) can no longer happen per-target.
//
// Exactly one content form is used: `children` (element children), `rawHtml`
// (assigned verbatim as innerHTML — rich text, the tint-defs SVG, `<style>` CSS),
// or `text` (escaped/`textContent`). `sourceNode` is set on per-node elements so
// a target that exposes a per-node hook (the Vue `#node` slot) can recover the
// model node; it is absent on scaffolding (stage/frame/self-layer/defs/style).
//
// `kind: "comment"` (with `tag: "#comment"` so stabilization's tag/key/text
// equality works unchanged) marks a hidden-placeholder node: every target emits
// it as a comment node carrying `text` — the v-if pattern.
export interface RenderElement {
  tag: string;
  kind?: "comment";
  className?: string;
  attributes?: Record<string, string>;
  style?: Record<string, string>;
  children?: RenderElement[];
  rawHtml?: string;
  text?: string;
  key?: string;
  sourceNode?: GodotHtmlNode;
}

// `@font-face` rules mapping each resolved font family to its font-file URL. Shared by
// every renderer so all register fonts identically (without it a node's `font-family`
// resolves to a name the browser can't load -> fallback). Lives here (not in the
// string renderer) so the shared `<style>` builder can reuse it without a cycle.
export function renderFontFaceCss(fontFaces: GodotHtmlFontFace[]): string {
  return [godotDefaultFontFace, ...fontFaces]
    .map(
      (face) =>
        `@font-face { font-family: "${cssFontString(face.fontFamily)}"; src: url("${cssUrl(face.url)}") format("${face.url.startsWith("data:font/woff2") || /\\.woff2(?:$|[?#])/i.test(face.url) ? "woff2" : "truetype"}"); font-style: ${face.style}; font-weight: ${face.weight}; }`,
    )
    .join("\n");
}

// CSS string escaping for `@font-face` family/url literals (quotes/backslashes).
function cssFontString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

// One model node -> its outer element with `[behind, self-layer, normal]`
// children (the paint order Godot uses around a node's own draw). The self-layer
// carries the node's paint/text; `node.html` (rich text) becomes its DIRECT
// innerHTML and `node.text` its text content.
export function buildNodePresentation(
  node: GodotHtmlNode,
  behind: RenderElement[] = [],
  normal: RenderElement[] = [],
): RenderElement {
  if (node.kind === "hidden-placeholder") {
    // An effectively-hidden subtree renders as a single comment in the node's
    // sibling slot (no element, no descendants) — what Vue emits for `v-if`.
    return {
      tag: "#comment",
      kind: "comment",
      key: node.path,
      text: `godot:hidden ${node.path} (${node.type})`,
    };
  }
  const selfLayer: RenderElement = {
    tag: "div",
    className: SELF_LAYER_CLASS,
    attributes: node.selfAttributes,
    style: node.selfStyle,
    ...(node.html !== null
      ? { rawHtml: node.html }
      : node.text !== null
        ? { text: node.text }
        : {}),
  };
  return {
    tag: "div",
    className: node.className,
    // `node.attributes` already carries `data-godot-path` (set in the model).
    attributes: node.attributes,
    style: node.style,
    key: node.path,
    sourceNode: node,
    children: [...behind, selfLayer, ...normal],
  };
}

export function buildNodeElement(
  node: GodotHtmlNode,
  nodeByPath: Map<string, GodotHtmlNode>,
): RenderElement {
  if (node.kind === "hidden-placeholder") return buildNodePresentation(node);
  const { behind, normal } = partitionChildren(node, nodeByPath);
  return buildNodePresentation(
    node,
    behind.map((child) => buildNodeElement(child, nodeByPath)),
    normal.map((child) => buildNodeElement(child, nodeByPath)),
  );
}

// The stage element (`STAGE_CLASS`) with the scene roots as children. Tint defs
// and the font/base-css `<style>` are composed alongside it by `buildSceneFragment`
// so a full-document target can hoist them into `<head>` if it prefers.
export function buildStageElement(
  model: GodotHtmlModel,
  options: { debug?: boolean; background?: string } = {},
): RenderElement {
  const nodeByPath = new Map(model.nodes.map((node) => [node.path, node]));
  const roots = model.nodes.filter((node) => node.parentPath === null);
  const style: Record<string, string> = model.contentScale
    ? { ...contentScaleStageStyle(model.contentScale) }
    : {
        width: `${model.viewport.width}px`,
        height: `${model.viewport.height}px`,
      };
  if (options.background) {
    style.background = options.background;
  }
  return {
    tag: "div",
    className: options.debug ? `${STAGE_CLASS} godot-scene-debug` : STAGE_CLASS,
    attributes: { "data-godot-stage": "true" },
    style,
    children: roots.map((root) => buildNodeElement(root, nodeByPath)),
  };
}

// Wrap the stage in the content-scale frame (`FRAME_CLASS`) when the model is
// content-scaled; otherwise return the stage unchanged. The transform-technique
// runtime scaling (ResizeObserver / `contentScaleScript`) is a per-target
// lifecycle concern and stays in each renderer.
export function buildFrameElement(
  model: GodotHtmlModel,
  stage: RenderElement,
  options: { background?: string } = {},
): RenderElement {
  if (!model.contentScale) {
    return stage;
  }
  const background = model.contentScale.background ?? options.background;
  return {
    tag: "div",
    className: FRAME_CLASS,
    style: background ? { background } : {},
    children: [stage],
  };
}

// The hidden `<svg><defs>` of color-matrix `<filter>` tints referenced by
// external textures, wrapped in a zero-size host div. `undefined` when the model
// registered no tints.
export function buildTintDefsElement(
  model: Pick<GodotHtmlModel, "tintFilters">,
): RenderElement | undefined {
  const markup = tintFilterDefsMarkup(model.tintFilters);
  if (!markup) {
    return undefined;
  }
  return {
    tag: "div",
    key: "godot-tint-defs",
    attributes: { "aria-hidden": "true" },
    style: {
      position: "absolute",
      width: "0",
      height: "0",
      overflow: "hidden",
    },
    rawHtml: markup,
  };
}

// A `<style>` element carrying `@font-face` rules (always) plus, when
// `includeBaseCss`, the model's base CSS. Lets a fragment-mounting target
// (DOM / Vue) self-contain its styling instead of relying on the host to inject
// it. `undefined` when there is nothing to emit.
export function buildStyleElement(
  model: Pick<GodotHtmlModel, "fontFaces" | "css">,
  options: { includeBaseCss?: boolean } = {},
): RenderElement | undefined {
  const parts: string[] = [];
  if (model.fontFaces.length > 0) {
    parts.push(renderFontFaceCss(model.fontFaces));
  }
  if (options.includeBaseCss) {
    parts.push(model.css);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return { tag: "style", key: "godot-style", rawHtml: parts.join("\n") };
}

export interface SceneFragmentOptions {
  debug?: boolean;
  background?: string;
  // Emit the `<style>` element (fonts + optional base css) as the fragment's
  // first child. Fragment-mounting targets (DOM/Vue) want this so the render is
  // self-contained; a full-document target (HTML string) hoists styles into
  // `<head>` itself and passes `false`.
  includeStyle?: boolean;
  includeBaseCss?: boolean;
}

// The ordered top-level elements of a rendered scene: an optional `<style>`
// (fonts + optional base css), an optional tint-defs element, and the stage
// (wrapped in a frame when content-scaled). Every renderer builds this and emits
// it to its target.
export function buildSceneFragment(
  model: GodotHtmlModel,
  options: SceneFragmentOptions = {},
): RenderElement[] {
  const fragment: RenderElement[] = [];
  if (options.includeStyle ?? true) {
    const style = buildStyleElement(model, {
      includeBaseCss: options.includeBaseCss ?? false,
    });
    if (style) {
      fragment.push(style);
    }
  }
  const tintDefs = buildTintDefsElement(model);
  if (tintDefs) {
    fragment.push(tintDefs);
  }
  const stage = buildStageElement(model, {
    debug: options.debug,
    background: options.background,
  });
  fragment.push(
    buildFrameElement(model, stage, { background: options.background }),
  );
  return fragment;
}

// ---- target emitters --------------------------------------------------------

// A comment payload must not contain `--` (it would close or malform the
// comment) nor end with `-` against the closing delimiter.
function escapeCommentText(value: string): string {
  return value.replaceAll("--", "- -").replace(/-$/, "- ");
}

// Emit a `RenderElement` tree as an HTML string (the static document renderer).
export function renderElementToHtml(element: RenderElement): string {
  if (element.kind === "comment") {
    return `<!--${escapeCommentText(element.text ?? "")}-->`;
  }
  const attrs: Record<string, string> = {
    ...(element.className ? { class: element.className } : {}),
    ...element.attributes,
  };
  const attrString = Object.entries(attrs)
    .map(([name, value]) => `${escapeHtml(name)}="${escapeHtml(value)}"`)
    .join(" ");
  const styleString =
    element.style && Object.keys(element.style).length > 0
      ? ` style="${escapeHtml(styleAttribute(element.style))}"`
      : "";
  const open = attrString
    ? `<${element.tag} ${attrString}${styleString}>`
    : `<${element.tag}${styleString}>`;
  const content =
    element.rawHtml !== undefined
      ? element.rawHtml
      : element.text !== undefined
        ? escapeHtml(element.text)
        : (element.children ?? [])
            .map((child) => renderElementToHtml(child))
            .join("");
  return `${open}${content}</${element.tag}>`;
}

// Emit a `RenderElement` tree as live DOM (the mount renderer).
export function renderElementToDom(
  element: RenderElement,
): HTMLElement | Comment {
  if (element.kind === "comment") {
    return document.createComment(element.text ?? "");
  }
  const node = document.createElement(element.tag);
  if (element.className) {
    node.className = element.className;
  }
  for (const [name, value] of Object.entries(element.attributes ?? {})) {
    node.setAttribute(name, value);
  }
  for (const [name, value] of Object.entries(element.style ?? {})) {
    node.style.setProperty(name, value);
  }
  if (element.rawHtml !== undefined) {
    node.innerHTML = element.rawHtml;
  } else if (element.text !== undefined) {
    node.textContent = element.text;
  } else {
    for (const child of element.children ?? []) {
      node.appendChild(renderElementToDom(child));
    }
  }
  return node;
}
