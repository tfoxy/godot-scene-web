import { renderSceneGraphToHtmlModel } from "@godot-scene-web/html";
import type { GodotAnchorMap } from "@godot-scene-web/layout/anchors";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";

// The run GlobalUi shape: the player container is declared BEFORE the relic
// inventory (it must paint under it), and the catalog anchors it below however
// many relic rows exist: `from: contentBottomLeft, to: topLeft, offset {y: 4}`.
const GLOBAL_UI_SCENE = `[gd_scene format=3]

[node name="GlobalUi" type="Control"]
anchors_preset = 15

[node name="PlayerContainer" type="VBoxContainer" parent="."]
offset_left = 16.0
offset_top = 90.0
offset_right = 216.0
offset_bottom = 150.0

[node name="RelicInventory" type="HFlowContainer" parent="."]
offset_left = 16.0
offset_top = 86.0
offset_right = 900.0
offset_bottom = 160.0

[node name="Relic1" type="TextureRect" parent="RelicInventory"]
custom_minimum_size = Vector2(60, 60)

[node name="Relic2" type="TextureRect" parent="RelicInventory"]
custom_minimum_size = Vector2(60, 60)

[node name="HiddenRelic" type="TextureRect" parent="RelicInventory"]
visible = false
custom_minimum_size = Vector2(60, 60)
`;

function browserModel(sceneText: string, anchorsByPath?: GodotAnchorMap) {
  const scene = parseGodotTextScene(sceneText);
  return renderSceneGraphToHtmlModel(deriveSceneGraph(scene), {
    viewport: { width: 1920, height: 1080 },
    anchorsByPath,
  });
}

describe("renderSceneGraphToHtmlModel (CSS anchor positioning)", () => {
  it("anchors a node below a flow container's content rows (MultiplayerPlayerContainer)", () => {
    const model = browserModel(GLOBAL_UI_SCENE, {
      PlayerContainer: {
        anchorTo: "RelicInventory",
        from: "contentBottomLeft",
        to: "topLeft",
        offset: { y: 4 },
      },
    });
    const byPath = new Map(model.nodes.map((node) => [node.path, node]));
    const self = byPath.get("PlayerContainer");
    const target = byPath.get("RelicInventory");
    const root = byPath.get(".");

    // The target was an abs-pos LATER sibling — unacceptable as a CSS anchor —
    // so the positioned node moved directly after it in the child order.
    expect(root?.children.indexOf("RelicInventory")).toBeLessThan(
      root?.children.indexOf("PlayerContainer") ?? -1,
    );

    // The target's VISIBLE children carry indexed anchor names; the hidden one
    // is excluded (matching the computed resolver's content extent).
    expect(target?.style["anchor-name"]).toBe("--gswa0");
    expect(byPath.get("RelicInventory/Relic1")?.style["anchor-name"]).toBe(
      "--gswa0c0",
    );
    expect(byPath.get("RelicInventory/Relic2")?.style["anchor-name"]).toBe(
      "--gswa0c1",
    );
    expect(
      byPath.get("RelicInventory/HiddenRelic")?.style["anchor-name"],
    ).toBeUndefined();

    // contentBottom → max over children bottoms (+ the catalog offset);
    // contentLeft → min over children lefts. The static insets are replaced.
    expect(self?.style.top).toBe(
      "calc(max(anchor(--gswa0c0 bottom), anchor(--gswa0c1 bottom)) + 4px)",
    );
    expect(self?.style.left).toBe(
      "min(anchor(--gswa0c0 left), anchor(--gswa0c1 left))",
    );
    expect(self?.style.bottom).toBeUndefined();
    expect(self?.style.right).toBeUndefined();
    expect(self?.style.position).toBe("absolute");
  });

  it("anchors plain corner edges without content names (tooltip append shape)", () => {
    const model = browserModel(GLOBAL_UI_SCENE, {
      PlayerContainer: {
        anchorTo: "RelicInventory",
        from: "topLeft",
        to: "topLeft",
        offset: { x: 8, y: 12 },
      },
    });
    const byPath = new Map(model.nodes.map((node) => [node.path, node]));
    const self = byPath.get("PlayerContainer");
    expect(self?.style.top).toBe("calc(anchor(--gswa0 top) + 12px)");
    expect(self?.style.left).toBe("calc(anchor(--gswa0 left) + 8px)");
    // No content edges requested → children carry no anchor names.
    expect(
      byPath.get("RelicInventory/Relic1")?.style["anchor-name"],
    ).toBeUndefined();
  });

  it("falls back to the target's own top-left for content edges with no visible children", () => {
    const scene = `[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Panel" type="Control" parent="."]
offset_top = 50.0
offset_bottom = 90.0

[node name="Empty" type="HFlowContainer" parent="."]
offset_top = 10.0
offset_bottom = 40.0
`;
    const model = browserModel(scene, {
      Panel: { anchorTo: "Empty", from: "contentBottomLeft", to: "topLeft" },
    });
    const panel = model.nodes.find((node) => node.path === "Panel");
    // Zero content collapses to the node's own origin (its top/left), matching
    // the computed resolver's zero-size-box fallback.
    expect(panel?.style.top).toBe("anchor(--gswa0 top)");
    expect(panel?.style.left).toBe("anchor(--gswa0 left)");
  });

  it("writes bottom/right insets (negating the offset direction) for bottomRight 'to' edges", () => {
    const model = browserModel(GLOBAL_UI_SCENE, {
      PlayerContainer: {
        anchorTo: "RelicInventory",
        from: "topLeft",
        to: "bottomRight",
        offset: { x: 8, y: 12 },
      },
    });
    const self = model.nodes.find((node) => node.path === "PlayerContainer");
    // `bottom`/`right` insets grow opposite the catalog's +y-down/+x-right.
    expect(self?.style.bottom).toBe("calc(anchor(--gswa0 top) - 12px)");
    expect(self?.style.right).toBe("calc(anchor(--gswa0 left) - 8px)");
    expect(self?.style.top).toBeUndefined();
    expect(self?.style.left).toBeUndefined();
  });

  it("emits diagnostics for missing targets and unsupported edges", () => {
    const model = browserModel(GLOBAL_UI_SCENE, {
      PlayerContainer: {
        anchorTo: "Nope",
        from: "topLeft",
        to: "topLeft",
      },
      RelicInventory: {
        anchorTo: "PlayerContainer",
        from: "topLeft",
        to: "contentTopLeft",
      },
    });
    const codes = model.diagnostics.map((diagnostic) => diagnostic.code).sort();
    expect(codes).toEqual(["anchor-edge-unsupported", "anchor-target-missing"]);
    // Nothing was emitted for the failed entries.
    const self = model.nodes.find((node) => node.path === "PlayerContainer");
    expect(self?.style.top).toBe("90px");
  });

  it("skips container-managed anchored nodes with a diagnostic", () => {
    const scene = `[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Box" type="VBoxContainer" parent="."]

[node name="Item" type="Label" parent="Box"]
text = "flowed"

[node name="Target" type="Control" parent="."]
offset_bottom = 40.0
`;
    const model = browserModel(scene, {
      "Box/Item": { anchorTo: "Target", from: "bottomLeft", to: "topLeft" },
    });
    expect(model.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "anchor-order-unresolvable",
    ]);
  });

  it("does not reorder when the target already precedes the positioned node", () => {
    const scene = `[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Target" type="Control" parent="."]
offset_bottom = 40.0

[node name="Tip" type="Control" parent="."]
offset_top = 100.0
offset_bottom = 140.0
`;
    const model = browserModel(scene, {
      Tip: { anchorTo: "Target", from: "bottomLeft", to: "topLeft" },
    });
    const root = model.nodes.find((node) => node.parentPath === null);
    expect(root?.children).toEqual(["Target", "Tip"]);
  });
});
