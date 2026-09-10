import {
  asBoolean,
  asNumber,
  type GodotVariant,
  isColorValue,
} from "@godot-scene-web/core";
import type { GodotSceneTreeNode } from "@godot-scene-web/layout";
import { clamp, colorAlpha, colorCss, round } from "./css-values";
import type { GodotHtmlPositioning } from "./types";

export function assignPositionStyle(
  style: Record<string, string>,
  node: GodotSceneTreeNode,
): GodotHtmlPositioning {
  if (node.parentPath === null) {
    style.position = "relative";
    delete style.left;
    delete style.top;
    return "root";
  } else {
    style.position = "absolute";
    return "absolute";
  }
}

export function assignZIndexStyle(
  style: Record<string, string>,
  node: GodotSceneTreeNode,
): void {
  if (node.zIndex !== 0) {
    style["z-index"] = String(node.zIndex);
  }
}

export function assignBackgroundColor(
  style: Record<string, string>,
  props: Record<string, GodotVariant>,
  nodeType?: string,
): void {
  // A particle node's `color` is the PER-PARTICLE modulate (CPUParticles2D.color,
  // multiplied into every particle's color in cpu_particles_2d.cpp) — never a
  // CanvasItem rect fill. Painting it as a background filled the emitter's
  // visibility-rect-sized box with a translucent color wash (e.g. the Neow
  // background's `stars` emitter tinting the whole scene warm yellow). The
  // particle preview/runtime already applies it per particle.
  if (nodeType === "CPUParticles2D" || nodeType === "GPUParticles2D") {
    return;
  }
  // A ColorRect's fill defaults to Godot's white and is tinted by the node's
  // (self_)modulate RGB (e.g. an authored-white fullscreen Backstop modulated
  // black). Modulate alpha is applied separately by `assignOpacity`, so only the
  // RGB channels fold into the fill here.
  let color = props.color;
  if (nodeType === "ColorRect") {
    if (!isColorValue(color)) {
      color = { type: "Color", args: [1, 1, 1, 1] };
    }
    const [r = 0, g = 0, b = 0, a = 1] = color.args as number[];
    let [tr, tg, tb] = [r, g, b];
    for (const tint of [props.modulate, props.self_modulate]) {
      if (!isColorValue(tint)) {
        continue;
      }
      const [mr = 1, mg = 1, mb = 1] = tint.args as number[];
      tr *= clamp(mr, 0, 1);
      tg *= clamp(mg, 0, 1);
      tb *= clamp(mb, 0, 1);
    }
    color = { type: "Color", args: [tr, tg, tb, a] };
  }
  const background = colorCss(color);
  if (background) {
    style.background = background;
  }
}

// Godot control types whose default mouse_filter is IGNORE. Scenes omit mouse_filter on
// these decorations, so without this the renderer would leave them inheriting
// pointer-events:auto — and an oversized one (e.g. an event button's BlueFlash
// confirmation flash, anchored centre and overflowing far past the button) would wrongly
// become a click target. Honouring the class default makes them pointer-events:none,
// matching the game's per-control-rect picking. NinePatchRect's IGNORE default is
// established by the shipped game's event buttons working with these children unset
// (STOP would block the button; PASS would bubble overflow clicks to it) and confirmed
// end-to-end on the live render; Label is the documented Godot 4 default. Types whose
// scenes set mouse_filter explicitly (TextureRect, RichTextLabel) are deliberately left
// off — explicit values already drive them, and they aren't broadened here.
const MOUSE_FILTER_IGNORE_DEFAULT_TYPES = new Set(["NinePatchRect", "Label"]);

export function assignPointerEvents(
  style: Record<string, string>,
  props: Record<string, GodotVariant>,
  nodeType?: string,
): void {
  // Godot mouse_filter: 0=STOP (consumes input), 1=PASS (handles, then bubbles to
  // the parent), 2=IGNORE. STOP must be an explicit `auto` — pointer-events
  // inherits, so a STOP node inside an IGNORE subtree (a fullscreen overlay's
  // backstop under a mouse_filter=2 global UI layer) would otherwise stay
  // hit-transparent. PASS is left unmapped: it neither blocks nor needs to
  // override an inherited value for parity.
  //
  // When the scene omits mouse_filter, fall back to the node type's Godot default:
  // IGNORE-by-default decorations map to pointer-events:none so they don't become
  // spurious click targets (everything else stays unmapped/inherited as before).
  let filter = asNumber(props.mouse_filter);
  if (
    filter === undefined &&
    nodeType &&
    MOUSE_FILTER_IGNORE_DEFAULT_TYPES.has(nodeType)
  ) {
    filter = 2;
  }
  if (filter === 2) {
    style["pointer-events"] = "none";
  } else if (filter === 0) {
    style["pointer-events"] = "auto";
  }
}

export function assignOpacity(
  style: Record<string, string>,
  selfStyle: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
): void {
  const modulate = colorCss(props.modulate);
  const selfModulate = colorCss(props.self_modulate);
  if (modulate) {
    attributes["data-godot-modulate"] = modulate;
  }
  if (selfModulate) {
    attributes["data-godot-self-modulate"] = selfModulate;
  }
  const modulateAlpha = colorAlpha(props.modulate);
  const selfModulateAlpha = colorAlpha(props.self_modulate);
  if (modulateAlpha < 1) {
    style.opacity = String(round(modulateAlpha));
  }
  if (selfModulateAlpha < 1) {
    selfStyle.opacity = String(round(selfModulateAlpha));
  }
}

export function assignTransform(
  style: Record<string, string>,
  node: GodotSceneTreeNode,
  props: Record<string, GodotVariant>,
): void {
  // NOTE: `flip_h`/`flip_v` are deliberately NOT folded into this outer-element
  // transform. In Godot they mirror only the node's OWN texture, never its child
  // nodes, but a CSS transform on the outer element cascades to children. The flip
  // is applied to the self-layer instead — see `assignSelfLayerFlip`.
  const scaleX = node.scale.x;
  const scaleY = node.scale.y;
  const rotation = asNumber(props.rotation) ?? asNumber(props.rotation_degrees);
  const rotationUnit = asNumber(props.rotation) !== undefined ? "rad" : "deg";
  const skew = asNumber(props.skew);
  const transforms: string[] = [];
  if (rotation !== undefined && rotation !== 0) {
    transforms.push(`rotate(${round(rotation)}${rotationUnit})`);
  }
  if (skew !== undefined && skew !== 0) {
    transforms.push(`skewX(${round(skew)}rad)`);
  }
  if (scaleX !== 1 || scaleY !== 1) {
    transforms.push(`scale(${round(scaleX)}, ${round(scaleY)})`);
  }
  if (transforms.length > 0) {
    style.transform = transforms.join(" ");
    // Godot Control scales/rotates around `pivot_offset`, whose default is
    // (0,0) = top-left. A genuine non-identity `node.scale` must therefore grow
    // from the pivot (top-left by default) to agree with `renderedRect`/live
    // `get_global_rect()`. Rotation/skew keep the legacy center default when no
    // explicit pivot is set.
    const hasGenuineScale = node.scale.x !== 1 || node.scale.y !== 1;
    if (node.pivotOffset.x !== 0 || node.pivotOffset.y !== 0) {
      style["transform-origin"] =
        `${round(node.pivotOffset.x)}px ${round(node.pivotOffset.y)}px`;
    } else if (hasGenuineScale) {
      style["transform-origin"] = "0px 0px";
    } else {
      style["transform-origin"] = "50% 50%";
    }
  }
}

// Applies a `flip_h`/`flip_v` mirror to a node's self-layer style (the element that
// paints the node's own texture, a sibling of the node's child elements). Keeping the
// flip on the self-layer mirrors only the texture — matching Godot, where TextureRect/
// Sprite flips never affect child nodes — instead of cascading to children via the
// outer element transform. Composes with any pre-existing self-layer transform.
export function assignSelfLayerFlip(
  selfStyle: Record<string, string>,
  props: Record<string, GodotVariant>,
): void {
  const flipX = asBoolean(props.flip_h) === true;
  const flipY = asBoolean(props.flip_v) === true;
  if (!flipX && !flipY) {
    return;
  }
  const flip = `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})`;
  selfStyle.transform = selfStyle.transform
    ? `${selfStyle.transform} ${flip}`
    : flip;
  if (!selfStyle["transform-origin"]) {
    selfStyle["transform-origin"] = "50% 50%";
  }
}

export function assignDrawAttributes(
  attributes: Record<string, string>,
  node: GodotSceneTreeNode,
  props: Record<string, GodotVariant>,
): void {
  attributes["data-godot-draw-order"] = String(node.drawOrder);
  attributes["data-godot-z-index"] = String(node.zIndex);
  if (node.zAsRelative === false) {
    attributes["data-godot-z-as-relative"] = "false";
  }
  if (node.showBehindParent) {
    attributes["data-godot-show-behind-parent"] = "true";
  }
  if (asBoolean(props.flip_h) === true) {
    attributes["data-godot-flip-h"] = "true";
  }
  if (asBoolean(props.flip_v) === true) {
    attributes["data-godot-flip-v"] = "true";
  }
}

export function assignRangeStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
): void {
  const min = asNumber(props.min_value) ?? 0;
  const max = asNumber(props.max_value) ?? 100;
  const value = asNumber(props.value) ?? min;
  const percent =
    max > min ? clamp((value - min) / (max - min), 0, 1) * 100 : 0;
  attributes["data-godot-range-min"] = String(min);
  attributes["data-godot-range-max"] = String(max);
  attributes["data-godot-range-value"] = String(value);
  if (asNumber(props.step) !== undefined) {
    attributes["data-godot-range-step"] = String(asNumber(props.step));
  }
  style["--godot-range-percent"] = `${round(percent)}%`;
}
