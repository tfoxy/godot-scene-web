import { resolveGodotSceneTree as resolveSceneTreeFromGraph } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";

// Test shim: the rect engine now takes a SceneGraph (browser-native split moved
// structural indexing into deriveSceneGraph); keep the scene-taking call shape.
function resolveGodotSceneTree(scene, options) {
  return resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
}

import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import {
  type GodotHtmlModel,
  mountHtmlScene,
  renderGodotSceneHtml,
  renderSceneToHtmlModel,
  STAGE_CLASS,
} from "../src/index";

// A scene exercising every structural axis the renderers must agree on: a Label
// (text content), a RichTextLabel (bbcode -> node.html), and a parent whose
// children include a `show_behind_parent` sibling plus nested children (paint
// order around the self-layer).
const SCENE = `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 160
[node name="Back" type="ColorRect" parent="."]
offset_right = 200
offset_bottom = 160
show_behind_parent = true
[node name="Label" type="Label" parent="."]
offset_right = 120
offset_bottom = 30
text = "Hello world"
[node name="Rich" type="RichTextLabel" parent="."]
offset_top = 40
offset_right = 120
offset_bottom = 90
bbcode_enabled = true
text = "a [b]bold[/b] and [i]italic[/i] run"
[node name="Group" type="Control" parent="."]
offset_top = 100
offset_right = 120
offset_bottom = 160
[node name="GroupChild" type="ColorRect" parent="Group"]
offset_right = 60
offset_bottom = 40
[node name="Hidden" type="ColorRect" parent="Group"]
offset_right = 60
offset_bottom = 40
visible = false
`;

function buildModel(): GodotHtmlModel {
  const tree = resolveGodotSceneTree(parseGodotTextScene(SCENE));
  return renderSceneToHtmlModel(tree);
}

// Compare the structural contract shared by every renderer. Inline `style`
// strings are deliberately ignored (jsdom normalizes them and they do not
// affect DOM structure); only element children are walked, so whitespace text
// nodes from the string renderer's joins are irrelevant.
function expectSameStructure(actual: Element, expected: Element, path: string) {
  expect(actual.tagName, `${path} tagName`).toBe(expected.tagName);
  expect(actual.className, `${path} className`).toBe(expected.className);
  expect(attributeMap(actual), `${path} attributes`).toEqual(
    attributeMap(expected),
  );
  const actualChildren = [...actual.children];
  const expectedChildren = [...expected.children];
  expect(actualChildren.length, `${path} child count`).toBe(
    expectedChildren.length,
  );
  if (expectedChildren.length === 0) {
    expect(actual.textContent, `${path} text`).toBe(expected.textContent);
    return;
  }
  expectedChildren.forEach((expectedChild, index) => {
    const actualChild = actualChildren[index];
    expect(actualChild, `${path} child ${index}`).toBeDefined();
    expectSameStructure(
      actualChild as Element,
      expectedChild,
      `${path} > ${expectedChild.tagName.toLowerCase()}[${index}]`,
    );
  });
}

function attributeMap(element: Element): Record<string, string> {
  const map: Record<string, string> = {};
  for (const attribute of element.attributes) {
    if (attribute.name !== "style") {
      map[attribute.name] = attribute.value;
    }
  }
  return map;
}

describe("HTML string vs DOM renderer structural parity", () => {
  it("renderGodotSceneHtml matches mountHtmlScene structure", () => {
    const model = buildModel();

    const host = document.createElement("div");
    mountHtmlScene(host, model);
    const domStage = host.querySelector(`.${STAGE_CLASS}`);

    const stringDoc = new DOMParser().parseFromString(
      renderGodotSceneHtml(model, { viewport: model.viewport }),
      "text/html",
    );
    const stringStage = stringDoc.querySelector(`.${STAGE_CLASS}`);

    expect(domStage, "DOM stage").not.toBeNull();
    expect(stringStage, "string stage").not.toBeNull();
    expectSameStructure(
      stringStage as Element,
      domStage as Element,
      STAGE_CLASS,
    );

    // The hidden node renders as the SAME comment in both targets (the
    // element-only walk above already proves neither renders it as an element).
    expect(countHiddenComments(domStage as Element)).toBe(1);
    expect(countHiddenComments(stringStage as Element)).toBe(1);
  });
});

function countHiddenComments(root: Element): number {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_COMMENT,
  );
  let count = 0;
  while (walker.nextNode()) {
    if (
      walker.currentNode.textContent === "godot:hidden Group/Hidden (ColorRect)"
    ) {
      count += 1;
    }
  }
  return count;
}
