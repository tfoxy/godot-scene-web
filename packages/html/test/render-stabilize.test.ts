import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import {
  buildSceneFragment,
  type RenderElement,
  renderElementToHtml,
  renderSceneGraphToHtmlModel,
  stabilizeRenderElements,
} from "../src/index";

const SCENE = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 1280
offset_bottom = 720
[node name="Left" type="Control" parent="."]
[node name="LeftLabel" type="Label" parent="Left"]
text = "left"
[node name="Right" type="Control" parent="."]
[node name="RightLabel" type="Label" parent="Right"]
text = "right"
`;

function fragmentFor(sceneText: string): RenderElement[] {
  const scene = parseGodotTextScene(sceneText);
  const model = renderSceneGraphToHtmlModel(deriveSceneGraph(scene), {});
  return buildSceneFragment(model, { includeStyle: true });
}

function findByPath(
  elements: RenderElement[],
  path: string,
): RenderElement | undefined {
  for (const element of elements) {
    if (element.attributes?.["data-godot-path"] === path) {
      return element;
    }
    const inChildren = findByPath(element.children ?? [], path);
    if (inChildren) {
      return inChildren;
    }
  }
  return undefined;
}

describe("stabilizeRenderElements", () => {
  it("preserves identity for an unchanged fragment, end to end", () => {
    const previous = fragmentFor(SCENE);
    const next = fragmentFor(SCENE);
    expect(next[0]).not.toBe(previous[0]); // fresh build: all-new objects

    const stabilized = stabilizeRenderElements(previous, next);
    expect(stabilized).toHaveLength(previous.length);
    for (let i = 0; i < stabilized.length; i++) {
      expect(stabilized[i]).toBe(previous[i]);
    }
  });

  it("keeps unchanged sibling subtrees identical when one node changes", () => {
    const previous = fragmentFor(SCENE);
    const next = fragmentFor(SCENE.replace('text = "right"', 'text = "RIGHT"'));
    const stabilized = stabilizeRenderElements(previous, next);

    // The untouched Left subtree keeps full identity.
    expect(findByPath(stabilized, "Left")).toBe(findByPath(previous, "Left"));
    expect(findByPath(stabilized, "Left/LeftLabel")).toBe(
      findByPath(previous, "Left/LeftLabel"),
    );
    // The changed node and its ancestors are fresh.
    expect(findByPath(stabilized, "Right/RightLabel")).not.toBe(
      findByPath(previous, "Right/RightLabel"),
    );
    expect(findByPath(stabilized, "Right")).not.toBe(
      findByPath(previous, "Right"),
    );
    expect(stabilized[stabilized.length - 1]).not.toBe(
      previous[previous.length - 1],
    );

    // Stabilization never changes the rendered output.
    const fresh = fragmentFor(
      SCENE.replace('text = "right"', 'text = "RIGHT"'),
    );
    expect(stabilized.map(renderElementToHtml).join("")).toBe(
      fresh.map(renderElementToHtml).join(""),
    );
  });

  it("matches moved keyed elements by key, not position", () => {
    // Hand-built: a real model rebuild re-numbers draw-order attributes on any
    // structural change, so identical-content moves only occur for plain elements.
    const child = (key: string): RenderElement => ({
      tag: "div",
      key,
      className: `c-${key}`,
      children: [{ tag: "span", text: key }],
    });
    const previous: RenderElement[] = [child("a"), child("b"), child("c")];
    const next: RenderElement[] = [
      child("inserted"),
      child("a"),
      child("c"),
      child("b"),
    ];

    const stabilized = stabilizeRenderElements(previous, next);
    expect(stabilized[1]).toBe(previous[0]); // a, shifted
    expect(stabilized[2]).toBe(previous[2]); // c, index-matched by luck of key check
    expect(stabilized[3]).toBe(previous[1]); // b, moved
    expect(stabilized[0].key).toBe("inserted");
    expect(stabilized[0]).not.toBe(previous[0]);
  });

  it("treats elements differing only in sourceNode identity as unchanged", () => {
    const previous = fragmentFor(SCENE);
    const next = fragmentFor(SCENE);
    const node = findByPath(next, "Left");
    expect(node?.sourceNode).toBeDefined();
    expect(node?.sourceNode).not.toBe(findByPath(previous, "Left")?.sourceNode);

    const stabilized = stabilizeRenderElements(previous, next);
    expect(findByPath(stabilized, "Left")).toBe(findByPath(previous, "Left"));
  });

  it("stays stable across generations", () => {
    const first = fragmentFor(SCENE);
    const second = stabilizeRenderElements(first, fragmentFor(SCENE));
    const third = stabilizeRenderElements(second, fragmentFor(SCENE));
    expect(third[third.length - 1]).toBe(first[first.length - 1]);
  });
});
