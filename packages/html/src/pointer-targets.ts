// Pointer targets (docs/input.md "Pointer targets (opt-in)"): which Godot node a page point is
// over in a scene this package rendered. `htmlPointerTargetResolver(model)` is the html resolver for
// `@godot-scene-web/input/pointer`'s `resolveTarget`: `elementFromPoint`, the closest
// `[data-godot-path]`, and `local` from that element's client rect scaled to the Control's size in
// the model. It returns a structural hit and imports nothing from the input package.
//
// `elementFromPoint` honours `pointer-events`, and the model maps `mouse_filter = IGNORE` to
// `pointer-events: none`, so an ignoring Control is skipped as Godot's own GUI picking skips it.
// `local` is exact for unrotated Controls; a rotated one is measured against its bounding box.

import type { GodotHtmlModel, GodotHtmlNode } from "./types";

/** What a resolve returns: input's `PointerTargetHit`, structurally. */
export interface HtmlPointerTarget {
  /** The node path (the interning key: stable across re-renders of the same model). */
  readonly key: string;
  readonly identity: {
    readonly path: string;
    readonly class: string;
    readonly scene?: string;
  };
  /** The point in the Control's own px. */
  readonly local: { readonly x: number; readonly y: number };
}

export interface HtmlPointerTargetOptions {
  /**
   * The scene file (`res://…`) the model's paths are relative to, sent as the identity's
   * `scene` so the host resolves the path under that scene's instance. Absent: the host resolves
   * the path against its target root.
   */
  scene?: string;
  /** Only elements inside this one count (several scenes on a page). Default: any. */
  root?: { contains(other: unknown): boolean } | null;
  /** Where `elementFromPoint` runs (default `document`). */
  document?: { elementFromPoint(x: number, y: number): Element | null };
}

export type HtmlPointerTargetResolver = (
  clientX: number,
  clientY: number,
) => HtmlPointerTarget | null;

const PX = /^(-?\d+(?:\.\d+)?)px$/;
const CQ = /^(?:min|max)\((-?\d+(?:\.\d+)?)cqw,/;

/** A model length in px: plain `px`, or the container technique's `min(Xcqw, Ycqh)`. */
function lengthPx(value: string | undefined, model: GodotHtmlModel): number {
  if (value === undefined) return Number.NaN;
  const px = PX.exec(value);
  if (px) return Number.parseFloat(px[1]);
  const cq = CQ.exec(value);
  const base = model.contentScale?.base;
  if (cq && base) return (Number.parseFloat(cq[1]) * base.width) / 100;
  return Number.NaN;
}

/**
 * The html target resolver for `createPointerCapture({ targets, resolveTarget })`. `model` is
 * the rendered model, or a getter for the current one (read per resolve; a new model object
 * rebuilds the path index once).
 */
export function htmlPointerTargetResolver(
  model: GodotHtmlModel | (() => GodotHtmlModel),
  options: HtmlPointerTargetOptions = {},
): HtmlPointerTargetResolver {
  const read = typeof model === "function" ? model : () => model;
  let indexed: GodotHtmlModel | null = null;
  let byPath = new Map<string, GodotHtmlNode>();
  const scene = options.scene;
  return (clientX, clientY) => {
    const doc =
      options.document ??
      (globalThis as { document?: HtmlPointerTargetOptions["document"] })
        .document;
    if (!doc) return null;
    const current = read();
    if (current !== indexed) {
      indexed = current;
      byPath = new Map();
      for (const node of current.nodes)
        if (node.kind !== "hidden-placeholder") byPath.set(node.path, node);
    }
    const element = doc
      .elementFromPoint(clientX, clientY)
      ?.closest("[data-godot-path]");
    if (!element || (options.root && !options.root.contains(element)))
      return null;
    const path = element.getAttribute("data-godot-path");
    const node = path === null ? undefined : byPath.get(path);
    if (path === null || node === undefined) return null;
    const rect = element.getBoundingClientRect();
    const width = lengthPx(node.style.width, current);
    const height = lengthPx(node.style.height, current);
    const sx = rect.width > 0 && width > 0 ? width / rect.width : 1;
    const sy = rect.height > 0 && height > 0 ? height / rect.height : 1;
    const identity: { path: string; class: string; scene?: string } = {
      path,
      class: node.type,
    };
    if (scene !== undefined) identity.scene = scene;
    return {
      key: path,
      identity,
      local: { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy },
    };
  };
}
