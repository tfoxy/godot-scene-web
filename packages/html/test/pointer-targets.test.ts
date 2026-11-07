// htmlPointerTargetResolver: the closest [data-godot-path] under a point, `local` scaled from
// the element's client rect to the Control's model size (px and the container technique's cq
// units), the scene option, the root filter and model getters.

import { resolveGodotSceneTree } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import {
  type GodotHtmlModel,
  type GodotHtmlRenderOptions,
  htmlPointerTargetResolver,
  mountHtmlScene,
  renderSceneToHtmlModel as renderTree,
} from "../src/index";

function renderSceneToHtmlModel(
  source: ReturnType<typeof parseGodotTextScene>,
  options: GodotHtmlRenderOptions = {},
) {
  return renderTree(
    resolveGodotSceneTree(deriveSceneGraph(source, {}), {}),
    options,
  );
}

const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 400
offset_bottom = 200
[node name="Pad" type="Button" parent="."]
offset_left = 100
offset_top = 50
offset_right = 180
offset_bottom = 90
[node name="Label" type="Label" parent="Pad"]
offset_right = 20
offset_bottom = 10
`);

/** Mount, then give the Pad and its Label client rects as if drawn at half size from (10, 20). */
function mounted(model: GodotHtmlModel) {
  const host = document.createElement("div");
  document.body.append(host);
  mountHtmlScene(host, model);
  const el = (path: string) =>
    host.querySelector(`[data-godot-path="${path}"]`) as HTMLElement;
  const rect = (element: Element, x: number, y: number, w: number, h: number) =>
    Object.defineProperty(element, "getBoundingClientRect", {
      value: () => ({ left: x, top: y, width: w, height: h }),
    });
  rect(el("Pad"), 60, 45, 40, 20);
  rect(el("Pad/Label"), 60, 45, 10, 5);
  let under: Element | null = null;
  const doc = { elementFromPoint: () => under };
  return {
    host,
    el,
    doc,
    over(element: Element | null) {
      under = element;
    },
  };
}

describe("htmlPointerTargetResolver", () => {
  it("names the closest godot node and measures local in its model px", () => {
    const model = renderSceneToHtmlModel(scene);
    const m = mounted(model);
    const resolve = htmlPointerTargetResolver(model, {
      document: m.doc,
      scene: "res://ui.tscn",
    });
    // A child element inside the Pad (its self layer) resolves to the Pad.
    m.over(m.el("Pad").querySelector('[data-godot-self-layer="true"]'));
    expect(resolve(70, 50)).toEqual({
      key: "Pad",
      identity: { path: "Pad", class: "Button", scene: "res://ui.tscn" },
      local: { x: 20, y: 10 },
    });
    m.over(m.el("Pad/Label"));
    expect(resolve(65, 47.5)).toEqual({
      key: "Pad/Label",
      identity: { path: "Pad/Label", class: "Label", scene: "res://ui.tscn" },
      local: { x: 10, y: 5 },
    });
    m.host.remove();
  });

  it("is null off any node, outside the root, and without a document", () => {
    const model = renderSceneToHtmlModel(scene);
    const m = mounted(model);
    const outside = document.createElement("div");
    outside.setAttribute("data-godot-path", "Pad");
    const resolve = htmlPointerTargetResolver(model, {
      document: m.doc,
      root: m.host,
    });
    m.over(null);
    expect(resolve(1, 1)).toBeNull();
    m.over(outside);
    expect(resolve(1, 1)).toBeNull();
    m.over(document.body);
    expect(resolve(1, 1)).toBeNull();
    m.host.remove();
  });

  it("reads the container technique's cq lengths and follows a model getter", () => {
    const scaled = renderSceneToHtmlModel(scene, {
      contentScale: { aspect: "keep" },
    });
    const plain = renderSceneToHtmlModel(scene);
    let current = plain;
    const m = mounted(plain);
    const resolve = htmlPointerTargetResolver(() => current, {
      document: m.doc,
    });
    m.over(m.el("Pad"));
    expect(resolve(70, 50)?.local).toEqual({ x: 20, y: 10 });
    current = scaled;
    const width = scaled.nodes.find((n) => n.path === "Pad")?.style.width;
    expect(scaled.contentScale?.technique).toBe("container");
    expect(width).toMatch(/cqw/);
    expect(resolve(70, 50)?.local).toEqual({ x: 20, y: 10 });
    m.host.remove();
  });
});
