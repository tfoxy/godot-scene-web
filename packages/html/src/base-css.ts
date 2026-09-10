export const godotSceneBaseCss = `
.godot-scene-stage {
  position: relative;
  overflow: hidden;
  background: transparent;
  transform-origin: top left;
}
.godot-scene-frame {
  container-type: size;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.godot-scene-frame > .godot-scene-stage {
  flex: 0 0 auto;
  transform-origin: center center;
}
.godot-scene-node {
  box-sizing: border-box;
  position: absolute;
  min-width: 0;
  min-height: 0;
}
.godot-scene-self-layer {
  box-sizing: border-box;
}
.godot-scene-node.godot-type-Label > .godot-scene-self-layer,
.godot-scene-node.godot-type-Button > .godot-scene-self-layer,
.godot-scene-node.godot-type-RichTextLabel > .godot-scene-self-layer {
  display: flex;
  font-family: "Godot Default", sans-serif;
  font-synthesis: none;
  white-space: pre-wrap;
}
.godot-scene-node.godot-type-Label > .godot-scene-self-layer {
  letter-spacing: var(--godot-label-letter-spacing, 0.25px);
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-normal {
  letter-spacing: var(--godot-rich-letter-spacing, 0.25px);
  font-size: var(--godot-rich-normal-font-size, 1em);
  font-style: normal;
  font-weight: var(--godot-rich-normal-font-weight, 400);
  font-variation-settings: inherit;
}
/* Each styled role can carry its own letter-spacing (a Godot font's glyph spacing
   is a per-font-file property, so the bold/italic faces may space differently from
   the normal one). Every role var falls back to the value that role renders with
   today: the generic spacing for bold, and the italic 0.7 factor for the italic
   roles, so a consumer that sets nothing lays out exactly as before. */
.godot-scene-node.godot-type-RichTextLabel .godot-rich-bold {
  font-family: var(--godot-rich-bold-font-family, inherit);
  letter-spacing: var(--godot-rich-bold-letter-spacing, var(--godot-rich-letter-spacing, 0.25px));
  font-size: var(--godot-rich-bold-font-size, 1em);
  font-style: normal;
  font-weight: var(--godot-rich-bold-font-weight, 700);
  font-variation-settings: inherit;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-italic {
  font-family: var(--godot-rich-italic-font-family, inherit);
  letter-spacing: var(--godot-rich-italic-letter-spacing, calc(var(--godot-rich-letter-spacing, 0.25px) * 0.7));
  font-size: var(--godot-rich-italic-font-size, 1em);
  font-style: italic;
  font-weight: var(--godot-rich-normal-font-weight, 400);
  font-variation-settings: inherit;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-bold .godot-rich-italic {
  font-family: var(--godot-rich-bold-italic-font-family, inherit);
  letter-spacing: var(--godot-rich-bold-italic-letter-spacing, calc(var(--godot-rich-letter-spacing, 0.25px) * 0.7));
  font-size: var(--godot-rich-bold-italic-font-size, 1em);
  font-style: italic;
  font-weight: var(--godot-rich-bold-font-weight, 700);
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-stack {
  display: grid;
  width: 100%;
  position: relative;
  /* No transform here: a translateZ(0) permanently promotes every rich label to its own
     compositor layer, whose raster goes stale (blurry) after ancestor transform animations. */
  isolation: isolate;
  white-space: inherit;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-align {
  margin: 0;
}
/* One block per hard-newline-separated Godot paragraph inside an aligned region.
   WRAPPED lines within a block share --godot-rich-line-height; the gap between
   consecutive blocks (an explicit newline) is --godot-rich-paragraph-spacing.
   Both default to the plain flow (normal / 0), so only a consumer that sets the
   custom properties (e.g. CouchCoop's card DescriptionLabel) changes spacing;
   every other aligned label lays out exactly as before. */
.godot-scene-node.godot-type-RichTextLabel .godot-rich-paragraph {
  display: block;
  line-height: var(--godot-rich-line-height, normal);
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-paragraph + .godot-rich-paragraph {
  margin-top: var(--godot-rich-paragraph-spacing, 0);
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-layer {
  grid-area: 1 / 1;
  pointer-events: none;
  white-space: inherit;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-shadow-outline {
  color: transparent;
  -webkit-text-stroke: var(--godot-rich-shadow-outline-size, 0px) var(--godot-rich-shadow-color, rgba(0, 0, 0, 0));
  paint-order: stroke fill;
  transform: translate(var(--godot-rich-shadow-x, 0px), var(--godot-rich-shadow-y, 0px));
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-shadow-fill {
  color: var(--godot-rich-shadow-color, rgba(0, 0, 0, 0));
  transform: translate(var(--godot-rich-shadow-x, 0px), var(--godot-rich-shadow-y, 0px));
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-outline {
  color: transparent;
  -webkit-text-stroke: var(--godot-rich-outline-size, 0px) var(--godot-rich-outline-color, rgba(0, 0, 0, 0));
  paint-order: stroke fill;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-fill {
  color: var(--godot-rich-text-color, currentColor);
  position: relative;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-layer:not(.godot-rich-fill) * {
  color: inherit !important;
  background-color: transparent !important;
}
.godot-scene-node.godot-type-LineEdit > .godot-scene-self-layer,
.godot-scene-node.godot-type-TextEdit > .godot-scene-self-layer {
  display: flex;
  align-items: center;
  font-family: "Godot Default", sans-serif;
  white-space: pre-wrap;
}
.godot-scene-node.godot-type-TextEdit > .godot-scene-self-layer {
  align-items: flex-start;
  overflow: hidden;
}
.godot-scene-node.godot-type-Range > .godot-scene-self-layer {
  background: rgba(255, 255, 255, 0.14);
}
.godot-scene-node.godot-type-Range > .godot-scene-self-layer::before {
  content: "";
  display: block;
  width: var(--godot-range-percent, 0%);
  height: 100%;
  background: currentColor;
  opacity: 0.55;
}
.godot-scene-debug .godot-scene-node {
  outline: 1px solid rgba(0, 255, 255, 0.35);
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-code {
  font-family: ui-monospace, "Cascadia Code", "Source Code Pro", monospace;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-hr {
  border: none;
  border-top: 1px solid currentColor;
  opacity: 0.5;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-img {
  display: inline-block;
  vertical-align: middle;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-layer:not(.godot-rich-fill) .godot-rich-img {
  visibility: hidden;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-word {
  display: inline-block;
  white-space: nowrap;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-char {
  display: inline-block;
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-effect-wave .godot-rich-char {
  animation: godot-rich-wave 1.6s ease-in-out infinite;
  animation-delay: calc(var(--i, 0) * 0.06s);
}
@keyframes godot-rich-wave {
  0%, 100% { transform: translateY(0); }
  25% { transform: translateY(-0.18em); }
  75% { transform: translateY(0.18em); }
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-effect-shake .godot-rich-char {
  animation: godot-rich-shake 0.3s steps(2, end) infinite;
  animation-delay: calc(var(--i, 0) * -0.05s);
}
@keyframes godot-rich-shake {
  0% { transform: translate(0, 0); }
  25% { transform: translate(0.04em, -0.04em); }
  50% { transform: translate(-0.04em, 0.04em); }
  75% { transform: translate(0.04em, 0.04em); }
  100% { transform: translate(0, 0); }
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-effect-tornado .godot-rich-char {
  animation: godot-rich-tornado 2s linear infinite;
  animation-delay: calc(var(--i, 0) * 0.1s);
}
@keyframes godot-rich-tornado {
  0% { transform: translate(0.12em, 0); }
  25% { transform: translate(0, 0.12em); }
  50% { transform: translate(-0.12em, 0); }
  75% { transform: translate(0, -0.12em); }
  100% { transform: translate(0.12em, 0); }
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-fill .godot-rich-effect-rainbow .godot-rich-char {
  animation: godot-rich-rainbow 4s linear infinite;
  animation-delay: calc(var(--i, 0) * -0.08s);
}
@keyframes godot-rich-rainbow {
  0% { color: hsl(0, 80%, 65%); }
  100% { color: hsl(360, 80%, 65%); }
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-effect-pulse {
  animation: godot-rich-pulse 1s ease-in-out infinite;
}
@keyframes godot-rich-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.godot-scene-node.godot-type-RichTextLabel .godot-rich-effect-fade .godot-rich-char {
  animation: godot-rich-fade 2s ease-in-out infinite;
  animation-delay: calc(var(--i, 0) * 0.08s);
}
@keyframes godot-rich-fade {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}
`.trim();
