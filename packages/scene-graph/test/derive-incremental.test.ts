import type { SceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import { createSceneGraphNodeMemo, deriveSceneGraph } from "../src/index";
import { sceneNodesFromState } from "../src/scene-index";

// Pins the per-document memoization contracts: re-deriving an unchanged document
// reuses the expensive per-node products BY IDENTITY (props records, resourceRefs,
// scale/pivot), while everything option-scoped (prop/type overrides, inclusion)
// stays fresh per call and never poisons or reads the shared caches.

function nodeOf(graph: SceneGraph, path: string) {
  const node = graph.nodes.find((candidate) => candidate.path === path);
  if (!node) {
    throw new Error(`missing node ${path}`);
  }
  return node;
}

const plainScene = () =>
  parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://icon.png" id="1"]
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 100
[node name="Icon" type="TextureRect" parent="."]
texture = ExtResource("1")
scale = Vector2(2, 2)
[node name="Centered" type="Control" parent="."]
anchors_preset = 8
`);

describe("per-document derive memoization", () => {
  it("keeps properties identity-stable across derives of the same document", () => {
    const scene = plainScene();
    const first = deriveSceneGraph(scene);
    const second = deriveSceneGraph(scene);
    for (const node of first.nodes) {
      expect(nodeOf(second, node.path).properties).toBe(node.properties);
    }
    // The anchors_preset expansion is part of the cached record, not re-spread.
    expect(nodeOf(second, "Centered").properties.anchor_left).toBe(0.5);
  });

  it("reuses resourceRefs, scale, and pivotOffset by identity across derives", () => {
    const scene = plainScene();
    const first = nodeOf(deriveSceneGraph(scene), "Icon");
    const second = nodeOf(deriveSceneGraph(scene), "Icon");
    expect(first.resourceRefs.length).toBeGreaterThan(0);
    expect(second.resourceRefs).toBe(first.resourceRefs);
    expect(second.scale).toBe(first.scale);
    expect(second.pivotOffset).toBe(first.pivotOffset);
  });

  it("computes overridden props fresh without poisoning the base cache", () => {
    const scene = plainScene();
    const plain = deriveSceneGraph(scene);
    const overridden = deriveSceneGraph(scene, {
      overrideNodeProps: (_node, path) =>
        path === "Icon" ? { visible: false } : undefined,
    });
    const overriddenIcon = nodeOf(overridden, "Icon");
    expect(overriddenIcon.visible).toBe(false);
    expect(overriddenIcon.properties).not.toBe(
      nodeOf(plain, "Icon").properties,
    );
    // Untouched nodes still share the cached record with the plain derive.
    expect(nodeOf(overridden, ".").properties).toBe(
      nodeOf(plain, ".").properties,
    );
    // A later plain derive gets the original cached record back.
    const plainAgain = deriveSceneGraph(scene);
    expect(nodeOf(plainAgain, "Icon").properties).toBe(
      nodeOf(plain, "Icon").properties,
    );
  });

  it("expands anchor presets fresh on the override path", () => {
    const scene = plainScene();
    const overridden = deriveSceneGraph(scene, {
      overrideNodeProps: (_node, path) =>
        path === "Icon" ? { anchors_preset: 15 } : undefined,
    });
    expect(nodeOf(overridden, "Icon").properties.anchor_right).toBe(1);
    const plain = deriveSceneGraph(scene);
    expect(nodeOf(plain, "Icon").properties.anchor_right).toBeUndefined();
  });

  it("treats an empty override object as the cached fast path", () => {
    const scene = plainScene();
    const options = { overrideNodeProps: () => ({}) };
    const first = deriveSceneGraph(scene, options);
    const second = deriveSceneGraph(scene, options);
    expect(nodeOf(second, "Icon").properties).toBe(
      nodeOf(first, "Icon").properties,
    );
  });

  it("reuses the override merge by identity when the override object is stable (Stage E.1)", () => {
    const scene = plainScene();
    // A host that returns the SAME override object each call (the spirectl per-path identity cache,
    // Stage E.1). The merge is then cached by (base record, override object) → an identity-stable
    // props record, which lets the cross-render node memo's identity fast-path reuse the node and
    // skip propsSignature. (Contrast the fresh-override case above, which merges fresh per call.)
    const stableOverride = { visible: false };
    const options = {
      overrideNodeProps: (_node: unknown, path: string) =>
        path === "Icon" ? stableOverride : undefined,
    };
    const first = nodeOf(deriveSceneGraph(scene, options), "Icon");
    const second = nodeOf(deriveSceneGraph(scene, options), "Icon");
    expect(second.properties).toBe(first.properties);
    expect(first.properties.visible).toBe(false);
    // A DIFFERENT override object (a value change) still merges fresh — only unchanged paths reuse.
    const changed = nodeOf(
      deriveSceneGraph(scene, {
        overrideNodeProps: (_node: unknown, path: string) =>
          path === "Icon" ? { visible: true } : undefined,
      }),
      "Icon",
    );
    expect(changed.properties).not.toBe(first.properties);
    expect(changed.properties.visible).toBe(true);
  });

  it("reuses mounted-subtree records across derives and mount sites", () => {
    const host = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://button.tscn" id="1"]
[node name="Root" type="Control"]
[node name="ButtonA" parent="." instance=ExtResource("1")]
[node name="Label" parent="ButtonA"]
text = "Override"
[node name="ButtonB" parent="." instance=ExtResource("1")]
`);
    const mounted = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="ButtonScene" type="Control"]
[node name="Label" type="Label" parent="."]
text = "Base"
[node name="Plain" type="Control" parent="."]
visible = false
`);
    const options = {
      mountExternalScene: (ref: { id?: string }) =>
        ref.id === "1" ? mounted : undefined,
    };
    const first = deriveSceneGraph(host, options);
    const second = deriveSceneGraph(host, options);
    // Un-overridden mounted nodes share one record across derives AND mount sites.
    const plainA = nodeOf(first, "ButtonA/Plain");
    expect(nodeOf(second, "ButtonA/Plain").properties).toBe(plainA.properties);
    expect(nodeOf(first, "ButtonB/Plain").properties).toBe(plainA.properties);
    expect(nodeOf(first, "ButtonB/Label").properties).toBe(
      nodeOf(second, "ButtonB/Label").properties,
    );
    // The instance-site override still merges fresh and wins.
    expect(nodeOf(first, "ButtonA/Label").properties.text).toBe("Override");
    expect(nodeOf(first, "ButtonA/Label").properties).not.toBe(
      nodeOf(first, "ButtonB/Label").properties,
    );
    expect(nodeOf(first, "ButtonB/Label").properties.text).toBe("Base");
  });

  it("does not leak option-scoped retypes or inclusion across callers", () => {
    const scene = plainScene();
    const optionsB = {
      overrideNodeType: (_node: unknown, path: string) =>
        path === "Icon" ? "ColorRect" : undefined,
      includeNode: (_node: unknown, path: string) => path !== "Centered",
    };
    const a1 = deriveSceneGraph(scene);
    const b = deriveSceneGraph(scene, optionsB);
    const a2 = deriveSceneGraph(scene);
    expect(nodeOf(a1, "Icon").type).toBe("TextureRect");
    expect(nodeOf(b, "Icon").type).toBe("ColorRect");
    expect(nodeOf(a2, "Icon").type).toBe("TextureRect");
    expect(b.nodes.some((node) => node.path === "Centered")).toBe(false);
    expect(a2.nodes.some((node) => node.path === "Centered")).toBe(true);
    // The shared base records are option-independent.
    expect(nodeOf(b, "Icon").properties).toBe(nodeOf(a1, "Icon").properties);
    expect(nodeOf(a2, ".").properties).toBe(nodeOf(a1, ".").properties);
  });

  it("memoizes sceneNodesFromState per document", () => {
    const sceneA = plainScene();
    const sceneB = plainScene();
    expect(sceneNodesFromState(sceneA)).toBe(sceneNodesFromState(sceneA));
    expect(sceneNodesFromState(sceneA)).not.toBe(sceneNodesFromState(sceneB));
  });
});

// Phase 3.1: a per-view memo preserves the SceneGraphNode OBJECT identity of unchanged
// nodes across derives (the per-document caches above preserve props/scale/resourceRefs,
// but a fresh SceneGraphNode is built each call without this) — the prerequisite for the
// downstream html/render memos to bail out.
describe("cross-render node memo", () => {
  const visibleOverride = (value: boolean) => ({
    overrideNodeProps: (_node: unknown, path: string) =>
      path === "Icon" ? { visible: value } : undefined,
  });

  it("without a memo, each derive builds fresh SceneGraphNode objects", () => {
    const scene = plainScene();
    expect(nodeOf(deriveSceneGraph(scene), "Icon")).not.toBe(
      nodeOf(deriveSceneGraph(scene), "Icon"),
    );
  });

  it("reuses every unchanged node by identity across derives (identity fast-path)", () => {
    const scene = plainScene();
    const memo = createSceneGraphNodeMemo();
    const first = deriveSceneGraph(scene, {}, memo);
    const second = deriveSceneGraph(scene, {}, memo);
    for (const node of first.nodes) {
      expect(nodeOf(second, node.path)).toBe(node);
    }
  });

  it("reuses an overridden node when its override content is unchanged (content fast-path)", () => {
    const scene = plainScene();
    // The override branch rebuilds a fresh props record every call (no per-document cache),
    // so the identity fast-path cannot apply — confirm that first…
    const noMemoA = nodeOf(
      deriveSceneGraph(scene, visibleOverride(true)),
      "Icon",
    );
    const noMemoB = nodeOf(
      deriveSceneGraph(scene, visibleOverride(true)),
      "Icon",
    );
    expect(noMemoB.properties).not.toBe(noMemoA.properties);
    // …then the content signature still lets the memo reuse the SceneGraphNode object.
    const memo = createSceneGraphNodeMemo();
    const first = nodeOf(
      deriveSceneGraph(scene, visibleOverride(true), memo),
      "Icon",
    );
    const second = nodeOf(
      deriveSceneGraph(scene, visibleOverride(true), memo),
      "Icon",
    );
    expect(second).toBe(first);
  });

  it("builds a fresh node when its props change, keeping unaffected siblings identical", () => {
    const scene = plainScene();
    const memo = createSceneGraphNodeMemo();
    const first = deriveSceneGraph(scene, visibleOverride(true), memo);
    const second = deriveSceneGraph(scene, visibleOverride(false), memo);
    expect(nodeOf(second, "Icon")).not.toBe(nodeOf(first, "Icon")); // changed → fresh
    expect(nodeOf(second, "Icon").visible).toBe(false);
    expect(nodeOf(second, "Centered")).toBe(nodeOf(first, "Centered")); // unaffected → reused
  });

  it("invalidates name/type/order changes via the structure guards", () => {
    const scene = plainScene();
    const memo = createSceneGraphNodeMemo();
    const first = nodeOf(deriveSceneGraph(scene, {}, memo), "Icon");
    const retyped = deriveSceneGraph(
      scene,
      {
        overrideNodeType: (_n: unknown, p: string) =>
          p === "Icon" ? "ColorRect" : undefined,
      },
      memo,
    );
    expect(nodeOf(retyped, "Icon")).not.toBe(first); // type change → fresh
    expect(nodeOf(retyped, "Icon").type).toBe("ColorRect");
  });

  it("invalidates a z_as_relative child when its parent's z_index changes", () => {
    const scene = plainScene();
    const memo = createSceneGraphNodeMemo();
    const first = deriveSceneGraph(scene, {}, memo);
    const firstIcon = nodeOf(first, "Icon");
    expect(firstIcon.zAsRelative).toBe(true);
    expect(firstIcon.zIndex).toBe(0);
    const second = deriveSceneGraph(
      scene,
      {
        overrideNodeProps: (_n: unknown, p: string) =>
          p === "." ? { z_index: 5 } : undefined,
      },
      memo,
    );
    expect(nodeOf(second, ".")).not.toBe(nodeOf(first, ".")); // parent props changed
    expect(nodeOf(second, "Icon")).not.toBe(firstIcon); // child parentZIndex changed → fresh
    expect(nodeOf(second, "Icon").zIndex).toBe(5); // 5 (parent) + 0 (own)
  });

  it("reuses unchanged mounted-subtree nodes across derives", () => {
    const host = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://button.tscn" id="1"]
[node name="Root" type="Control"]
[node name="ButtonA" parent="." instance=ExtResource("1")]
`);
    const mounted = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="ButtonScene" type="Control"]
[node name="Plain" type="Control" parent="."]
`);
    const options = {
      mountExternalScene: (ref: { id?: string }) =>
        ref.id === "1" ? mounted : undefined,
    };
    const memo = createSceneGraphNodeMemo();
    const first = deriveSceneGraph(host, options, memo);
    const second = deriveSceneGraph(host, options, memo);
    // A mounted node's wrapper is freshly allocated each pass, but its props record is
    // preserved → the identity fast-path still reuses the SceneGraphNode object.
    expect(nodeOf(second, "ButtonA/Plain")).toBe(
      nodeOf(first, "ButtonA/Plain"),
    );
  });
});
