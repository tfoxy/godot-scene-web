import { contentScaleScript } from "./content-scale";
import {
  buildNodeElement,
  buildSceneFragment,
  renderElementToHtml,
  renderFontFaceCss,
} from "./render-tree";
import type { GodotHtmlModel, GodotHtmlNode } from "./types";

// Default Godot editor viewport gray, used as the stage/page background when a
// caller (e.g. the parity harness) screenshots the rendered scene.
const DEFAULT_VIEWPORT_BACKGROUND = "rgb(76, 76, 76)";

// Server-side string form of one node: the shared structural element rendered to
// HTML text. Kept as a named export for callers that render a single node.
export function renderGodotNodeHtml(
  node: GodotHtmlNode,
  nodeByPath: Map<string, GodotHtmlNode>,
): string {
  return renderElementToHtml(buildNodeElement(node, nodeByPath));
}

// Full standalone `<!doctype html>` document. A thin emitter over the shared
// structural tree: `@font-face` + base CSS are hoisted into `<head>` (the
// full-document convention), and the body is the shared scene fragment (tint defs
// + stage/frame) rendered to a string.
export function renderGodotSceneHtml(
  model: GodotHtmlModel,
  options: {
    viewport: { width: number; height: number };
    background?: string;
  },
): string {
  const background = options.background ?? DEFAULT_VIEWPORT_BACKGROUND;
  const fontFaceCss = renderFontFaceCss(model.fontFaces);
  // The document hoists styles into `<head>`, so the body fragment omits its own
  // `<style>` (`includeStyle: false`).
  const fragment = buildSceneFragment(model, {
    includeStyle: false,
    background,
  });
  const bodyInner = fragment
    .map((element) => renderElementToHtml(element))
    .join("\n");
  const body =
    model.contentScale?.technique === "transform"
      ? `${bodyInner}\n${contentScaleScript(model.contentScale.base)}`
      : bodyInner;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
${fontFaceCss}
${model.css}
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: ${background}; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
