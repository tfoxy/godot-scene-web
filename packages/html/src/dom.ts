import { observeContentScale } from "./content-scale";
import { FRAME_CLASS, STAGE_CLASS } from "./render-structure";
import { buildSceneFragment, renderElementToDom } from "./render-tree";
import { createHtmlEffectsHost } from "./runtime";
import type { GodotHtmlMountOptions } from "./runtime-options";
import type { GodotHtmlModel } from "./types";

const disposers = new WeakMap<HTMLElement, () => void>();

// Mount a model as live DOM. A thin emitter over the shared structural tree
// (`buildSceneFragment` -> `renderElementToDom`): the node/self-layer/stage/frame
// structure, the tint-filter defs, and the font + base-css `<style>` all come
// from the shared builder, so this renderer can't drift from the HTML-string or
// Vue ones. Returns the stage element. Pass `options` to opt into the live WebGL
// shader runtime (`enableWebglShaders`).
export function mountHtmlScene(
  container: HTMLElement,
  model: GodotHtmlModel,
  options?: GodotHtmlMountOptions,
): HTMLElement {
  disposers.get(container)?.();
  disposers.delete(container);
  let disposeScale: (() => void) | undefined;
  container.replaceChildren();
  // Tint defs + stage/frame. Base CSS and fonts are injected by the host (the
  // historical mount contract — `container.firstElementChild` is the tint defs or
  // the stage), so the style element is omitted here.
  const fragment = buildSceneFragment(model, { includeStyle: false });
  for (const element of fragment) {
    container.appendChild(renderElementToDom(element));
  }
  // Transform-technique content scale needs the live frame size; drive
  // `--godot-scale` from a ResizeObserver on the frame.
  if (model.contentScale?.technique === "transform") {
    const frame = container.querySelector<HTMLElement>(`.${FRAME_CLASS}`);
    if (frame) {
      disposeScale = observeContentScale(frame, model.contentScale.base);
    }
  }
  const stage = container.querySelector<HTMLElement>(
    `.${STAGE_CLASS}`,
  ) as HTMLElement;
  const host = createHtmlEffectsHost(stage, options);
  host.reconcile();
  disposers.set(container, () => {
    host.dispose();
    disposeScale?.();
  });
  return stage;
}

/** Release a mounted scene's observers and effect bindings before removing its DOM. */
export function unmountHtmlScene(container: HTMLElement): void {
  disposers.get(container)?.();
  disposers.delete(container);
  container.replaceChildren();
}
