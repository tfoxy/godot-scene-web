import { renderSceneGraphToHtmlModel } from "@godot-scene-web/html";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";

function browserModel(sceneText: string) {
  const scene = parseGodotTextScene(sceneText);
  return renderSceneGraphToHtmlModel(deriveSceneGraph(scene), {
    viewport: { width: 1920, height: 1080 },
  });
}

describe("renderSceneGraphToHtmlModel (browser-native layout)", () => {
  it("flows VBox children so a no-min-size label sizes to its own text", () => {
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Box" type="VBoxContainer" parent="."]

[node name="Desc" type="RichTextLabel" parent="Box"]
text = "the ironclad"

[node name="Relic" type="Panel" parent="Box"]
custom_minimum_size = Vector2(0, 100)
`);
    const byPath = new Map(model.nodes.map((node) => [node.path, node]));
    const box = byPath.get("Box");
    const desc = byPath.get("Box/Desc");
    const relic = byPath.get("Box/Relic");

    // The VBox becomes a flex column — the browser, not gsw, stacks the children.
    expect(box?.style.display).toBe("flex");
    expect(box?.style["flex-direction"]).toBe("column");
    expect(box?.containerLayout).toBe("box");

    // The description label flows (container-managed) with NO fixed height, so its
    // real DOM text gives it height and the next sibling can't overlap it — the
    // bug a missing measureLabelText used to cause is gone by construction.
    expect(desc?.positioning).toBe("container-managed");
    expect(desc?.style.position).toBe("relative");
    expect(desc?.style.height).toBeUndefined();
    expect(desc?.style.top).toBeUndefined();
    // Its text/paint self-layer is IN-FLOW (relative), not an absolute overlay, so
    // the text contributes content height to the outer element.
    expect(desc?.selfStyle.position).toBe("relative");
    expect(desc?.text).toBe("the ironclad");

    // The relic carries custom_minimum_size as a CSS min-height (still flows).
    expect(relic?.positioning).toBe("container-managed");
    expect(relic?.style["min-height"]).toBe("100px");
  });

  it("preserves a Line2D's self-computed box (points bbox) instead of resetting it to the parent origin", () => {
    // Line2D is a Node2D, not a Control: `assignLine2DStyles` sizes its outer box to the points'
    // bounding box (the SVG polyline). It has no anchors/offsets, so the pass-1 anchor recompute
    // would otherwise delete that box and reset it to 0,0 at 0×0 (offsets default 0) — drawing the
    // stroke at the parent origin instead of its real position. Regression for the map-drawing
    // strokes (a data-bound `points` Line2D) rendering at the top-left in the browser-native path.
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Line" type="Line2D" parent="."]
points = PackedVector2Array(100, 200, 160, 240, 220, 180)
width = 6
default_color = Color(0.2, 0.6, 0.86, 1)
`);
    const line = model.nodes.find((node) => node.path === "Line");
    // bbox minX=100 minY=180 maxX=220 maxY=240, pad=max(1,width=6)=6 → left/top = min - pad/2,
    // width/height = (max-min)+pad. The box hugs the stroke, NOT the parent origin.
    expect(line?.style).toMatchObject({
      position: "absolute",
      left: "97px",
      top: "177px",
      width: "126px",
      height: "66px",
    });
    expect(line?.positioning).toBe("absolute");
    expect(line?.html).toContain("data-godot-line2d");
    expect(line?.html).toContain('stroke="rgba(51, 153, 219, 1)"');
  });

  it("translates a Node2D by its position, keeping its own-origin box (GPUParticles2D)", () => {
    // A Node2D has no anchors/offsets: its placement is its own canvas transform —
    // `position`, then rotation/skew/scale around the node origin (Node2D::get_transform).
    // The anchor recompute used to delete the visibility-rect box `assignParticle2DStyles`
    // computed and reset every Node2D to the parent origin (left/top 0%), which parked the
    // Neow background's below-frame fog emitters mid-frame as a bright veil.
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Fog" type="GPUParticles2D" parent="."]
position = Vector2(1088, 1302)
amount = 5
lifetime = 10.0
visibility_rect = Rect2(-1000, -1000, 2000, 2000)

[node name="Rotated" type="GPUParticles2D" parent="."]
position = Vector2(1088, 1302)
rotation = 0.5
visibility_rect = Rect2(-1000, -1000, 2000, 2000)
`);
    const fog = model.nodes.find((node) => node.path === "Fog");
    // Box = position + visibility_rect offset (1088-1000, 1302-1000), at the rect's size —
    // the emitter origin stays at (1088, 1302) inside it (mostly below a 1080p viewport).
    expect(fog?.style).toMatchObject({
      position: "absolute",
      left: "88px",
      top: "302px",
      width: "2000px",
      height: "2000px",
    });
    expect(fog?.positioning).toBe("absolute");

    // Rotation pivots around the NODE ORIGIN (Godot rotates a Node2D about its own
    // origin), which sits at -rect.x/-rect.y in box-local coordinates — not the box
    // corner or its center.
    const rotated = model.nodes.find((node) => node.path === "Rotated");
    expect(rotated?.style.transform).toBe("rotate(0.5rad)");
    expect(rotated?.style["transform-origin"]).toBe("1000px 1000px");
  });

  it("keeps a Node2D child of a container out of the flow (containers only sort Controls)", () => {
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Box" type="VBoxContainer" parent="."]

[node name="Sprite" type="Sprite2D" parent="Box"]
position = Vector2(300, 400)

[node name="Label" type="Label" parent="Box"]
text = "flows"
`);
    const sprite = model.nodes.find((node) => node.path === "Box/Sprite");
    // Godot's Container::_sort_children lays out only Control children; the Sprite2D
    // keeps its own canvas transform instead of becoming a flow item.
    expect(sprite?.positioning).toBe("absolute");
    expect(sprite?.style.position).toBe("absolute");
    expect(sprite?.style.left).toBe("300px");
    expect(sprite?.style.top).toBe("400px");
    const label = model.nodes.find((node) => node.path === "Box/Label");
    expect(label?.positioning).toBe("container-managed");
  });

  it("does not paint a particle node's color as a box fill", () => {
    // CPUParticles2D.color is the PER-PARTICLE modulate (multiplied into each particle in
    // cpu_particles_2d.cpp), not a CanvasItem rect fill. Painting it as a background washed
    // the emitter's whole visibility-rect box in translucent color once Node2D boxes gained
    // their real (often screen-sized) geometry.
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Stars" type="CPUParticles2D" parent="."]
position = Vector2(1003, 590)
amount = 8
color = Color(0.886, 0.733, 0.278, 0.443)
visibility_rect = Rect2(-852, -368, 1704, 736)
`);
    const stars = model.nodes.find((node) => node.path === "Stars");
    expect(stars?.selfStyle.background).toBeUndefined();
    expect(stars?.selfStyle["background-color"]).toBeUndefined();
    // The color still reaches the particle preview/runtime as the per-particle tint.
    expect(stars?.attributes["data-godot-particle-color"]).toBe(
      "rgba(226, 187, 71, 0.443)",
    );
  });

  it("pins a point-anchored container to its definite width so a wrapping child wraps", () => {
    // The event-room VBoxContainer: anchored at 0.5/0.5 with offsets giving an 800px
    // definite width, holding a wrapping (autowrap) RichTextLabel. Godot keeps the
    // container at 800 and the label wraps; a `max-content` width measured the label
    // UNWRAPPED (the whole paragraph on one line) and blew the box far past 800. The
    // floor stays a `min-width` and the hug uses `min-content` (Godot's child MINIMUM
    // = longest word for a wrapping label), so the box resolves to its 800px width and
    // the label wraps inside it.
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="VBox" type="VBoxContainer" parent="."]
anchor_left = 0.5
anchor_right = 0.5
offset_left = -38.0
offset_top = 255.0
offset_right = 762.0
offset_bottom = 295.0
grow_horizontal = 2

[node name="Desc" type="RichTextLabel" parent="VBox"]
text = "a very long event description paragraph that must wrap to the box"
`);
    const vbox = model.nodes.find((node) => node.path === "VBox");
    expect(vbox?.style["min-width"]).toBe("800px");
    // min-content (hug the child MINIMUM), never max-content (the unwrapped paragraph).
    expect(vbox?.style.width).toBe("min-content");
    // grow BOTH centers via the translate longhand.
    expect(vbox?.style.left).toBe("calc(50% + 362px)");
    expect(vbox?.style.translate).toBe("-50% 0");
  });

  it("grows a point-anchored box to custom_minimum_size per its grow flags", () => {
    // Godot's Control::_size_changed inflates an offset-derived box to its
    // custom_minimum_size (the inspect-relic FrameBg: 40px offsets, 300px min,
    // grow BOTH keeps it centered). Offsets and the minimum are static doc
    // values, so the browser-native path emits the grown box directly.
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="FrameBg" type="TextureRect" parent="."]
custom_minimum_size = Vector2(300, 300)
anchor_left = 0.5
anchor_top = 0.5
anchor_right = 0.5
anchor_bottom = 0.5
offset_left = -20.0
offset_top = -20.0
offset_right = 20.0
offset_bottom = 20.0
grow_horizontal = 2
grow_vertical = 2

[node name="EndGrow" type="Control" parent="."]
custom_minimum_size = Vector2(100, 0)
offset_left = 10.0
offset_top = 10.0
offset_right = 50.0
offset_bottom = 50.0
`);
    const byPath = new Map(model.nodes.map((node) => [node.path, node]));
    const frameBg = byPath.get("FrameBg");
    // grow BOTH: centered — left shifts back by half the growth.
    expect(frameBg?.style.left).toBe("calc(50% - 150px)");
    expect(frameBg?.style.top).toBe("calc(50% - 150px)");
    expect(frameBg?.style.width).toBe("300px");
    expect(frameBg?.style.height).toBe("300px");

    const endGrow = byPath.get("EndGrow");
    // grow END (default): the start edge stays, the box extends forward; the
    // un-grown axis keeps its offset-derived size.
    expect(endGrow?.style.left).toBe("10px");
    expect(endGrow?.style.width).toBe("100px");
    expect(endGrow?.style.height).toBe("40px");
  });

  it("maps a FULL_RECT Control to inset:0 (fills its parent)", () => {
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]

[node name="Bg" type="ColorRect" parent="."]
anchors_preset = 15
`);
    const bg = model.nodes.find((node) => node.path === "Bg");
    expect(bg?.style.position).toBe("absolute");
    expect(bg?.style.left).toBe("0%");
    expect(bg?.style.right).toBe("0%");
    expect(bg?.style.top).toBe("0%");
    expect(bg?.style.bottom).toBe("0%");
    // A non-text node's self-layer fills the box so its paint covers it.
    expect(bg?.selfStyle.position).toBe("absolute");
    expect(bg?.selfStyle.width).toBe("100%");
  });

  it("derives a point-anchored Control's size from its offsets", () => {
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]

[node name="Btn" type="Button" parent="."]
offset_left = 40.0
offset_top = 20.0
offset_right = 240.0
offset_bottom = 80.0
`);
    const btn = model.nodes.find((node) => node.path === "Btn");
    expect(btn?.style.left).toBe("40px");
    expect(btn?.style.top).toBe("20px");
    expect(btn?.style.width).toBe("200px");
    expect(btn?.style.height).toBe("60px");
    expect(btn?.style.right).toBeUndefined();
  });

  it("maps a centered Box container's alignment to justify-content", () => {
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Row" type="HBoxContainer" parent="."]
alignment = 1
offset_right = 475.0
offset_bottom = 154.0

[node name="Btn" type="Control" parent="Row"]
custom_minimum_size = Vector2(100, 148)

[node name="Plain" type="VBoxContainer" parent="."]
`);
    const byPath = new Map(model.nodes.map((node) => [node.path, node]));
    const row = byPath.get("Row");
    const plain = byPath.get("Plain");

    // alignment=1 (CENTER) packs children to the main-axis center: the char-select
    // button row no longer left-aligns and overflows.
    expect(row?.style.display).toBe("flex");
    expect(row?.style["flex-direction"]).toBe("row");
    expect(row?.style["justify-content"]).toBe("center");
    // A container with no `alignment` keeps the flex default (no justify-content).
    expect(plain?.style["justify-content"]).toBeUndefined();
  });

  it("fills the self-layer of stretch-anchored text so vertical_alignment applies", () => {
    // The lobby nameplate: two stretch-anchored, bottom-aligned Labels stacked in a
    // bare Control. Their outer boxes overlap by design; Godot keeps the text apart
    // by bottom-aligning within each box. The self-layer must be full-height for that.
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Plate" type="Control" parent="."]
offset_left = 75.0
offset_top = 3.0
offset_right = 242.0
offset_bottom = 33.0

[node name="Name" type="Label" parent="Plate"]
anchors_preset = 15
offset_right = 187.0
offset_bottom = 3.0
vertical_alignment = 2
text = "Test Host"

[node name="Character" type="Label" parent="Plate"]
anchors_preset = 15
offset_top = 19.0
offset_bottom = 22.0
vertical_alignment = 2
text = "The Ironclad"
`);
    const byPath = new Map(model.nodes.map((node) => [node.path, node]));
    const name = byPath.get("Plate/Name");
    const character = byPath.get("Plate/Character");

    // Both labels are stretch-anchored (top AND bottom insets) → definite height →
    // their text self-layer fills the box and bottom-aligns (no top-aligned overlap).
    expect(name?.style.top).toBe("0%");
    expect(name?.style.bottom).toBe("-3px");
    expect(name?.style.height).toBeUndefined();
    expect(name?.selfStyle.height).toBe("100%");
    expect(name?.selfStyle["align-items"]).toBe("flex-end");

    expect(character?.style.top).toBe("19px");
    expect(character?.style.bottom).toBe("-22px");
    expect(character?.selfStyle.height).toBe("100%");
    expect(character?.selfStyle["align-items"]).toBe("flex-end");
  });

  it("keeps an auto-height self-layer for flowed / point-anchored text (InfoPanel)", () => {
    // A container-flowed label with no definite height must keep text-drives-height
    // so a missing measureLabelText cannot collapse it (the Phase-12 fix).
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Box" type="VBoxContainer" parent="."]

[node name="Desc" type="RichTextLabel" parent="Box"]
text = "the ironclad"
`);
    const desc = model.nodes.find((node) => node.path === "Box/Desc");
    expect(desc?.selfStyle.position).toBe("relative");
    // No definite outer height → self-layer height stays auto (text drives it).
    expect(desc?.selfStyle.height).toBeUndefined();
    expect(desc?.style.height).toBeUndefined();
  });

  it("centers a min-height flow Label's text (TopBar HpLabel)", () => {
    // The run TopBar: an HBox row whose Label gets its 80px box from
    // custom_minimum_size and centers its text via vertical_alignment. The
    // self-layer cannot use height:100% (percentages don't resolve against a
    // min-height-only parent) — the min-height is mirrored instead so
    // align-items:center has room while longer text can still grow the box.
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="TopBarHp" type="HBoxContainer" parent="."]

[node name="HpLabel" type="Label" parent="TopBarHp"]
custom_minimum_size = Vector2(120, 80)
vertical_alignment = 1
text = "80/80"
`);
    const label = model.nodes.find((node) => node.path === "TopBarHp/HpLabel");
    expect(label?.style["min-height"]).toBe("80px");
    expect(label?.selfStyle["min-height"]).toBe("80px");
    expect(label?.selfStyle.height).toBeUndefined();
    expect(label?.selfStyle["align-items"]).toBe("center");
  });

  it("centers a min-height flow RichTextLabel's text (event option Text)", () => {
    // The ancient-event option row: HBox > RichTextLabel with a 74px minimum and
    // centered vertical alignment (a MegaRichTextLabel property).
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Row" type="HBoxContainer" parent="."]

[node name="Text" type="RichTextLabel" parent="Row"]
custom_minimum_size = Vector2(830, 74)
vertical_alignment = 1
text = "This is some event option text."
`);
    const text = model.nodes.find((node) => node.path === "Row/Text");
    expect(text?.style["min-height"]).toBe("74px");
    expect(text?.selfStyle["min-height"]).toBe("74px");
    expect(text?.selfStyle.height).toBeUndefined();
    expect(text?.selfStyle["align-items"]).toBe("center");
  });

  it("fills a MarginContainer text child's self-layer so vertical_alignment centers (reward label)", () => {
    // The rewards-screen row: a definite-height Control > LabelContainer (MarginContainer,
    // fits its child to the content rect) > RichTextLabel with centered vertical alignment.
    // The grid cell is definite, so the fill child gets height:100% and the self-layer
    // fills it — giving `align-items:center` room to vertically center the text (otherwise
    // the auto-height self-layer pins it to the top).
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Btn" type="Control" parent="."]
custom_minimum_size = Vector2(402, 86)

[node name="LabelContainer" type="MarginContainer" parent="Btn"]
anchors_preset = 15

[node name="Label" type="RichTextLabel" parent="Btn/LabelContainer"]
vertical_alignment = 1
text = "30 de oro"
`);
    const label = model.nodes.find(
      (node) => node.path === "Btn/LabelContainer/Label",
    );
    expect(label?.style["grid-area"]).toBe("1 / 1");
    expect(label?.style.height).toBe("100%");
    expect(label?.selfStyle.height).toBe("100%");
    expect(label?.selfStyle["align-items"]).toBe("center");
  });

  it("prunes invisible nodes to comment placeholders that take no flow space", () => {
    // A hidden container child must NOT keep a layout box — Godot containers skip
    // invisible children. (The lobby VFlowContainer's hidden SoloLabel/InviteButton
    // otherwise push the players into a second column.) The model keeps the node
    // in its sibling slot as a hidden-placeholder (rendered as a comment), with
    // no styles for any geometry pass to act on.
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Box" type="VBoxContainer" parent="."]

[node name="Hidden" type="Label" parent="Box"]
visible = false
text = "hidden"

[node name="Shown" type="Label" parent="Box"]
text = "shown"
`);
    const byPath = new Map(model.nodes.map((node) => [node.path, node]));
    const hidden = byPath.get("Box/Hidden");
    expect(hidden?.kind).toBe("hidden-placeholder");
    expect(hidden?.style).toEqual({});
    const shown = byPath.get("Box/Shown");
    expect(shown?.kind).toBeUndefined();
    expect(shown?.style.display).not.toBe("none");
    // The placeholder keeps the sibling order for stable keying across toggles.
    expect(byPath.get("Box")?.children).toEqual(["Box/Hidden", "Box/Shown"]);
  });

  it("flows a FlowContainer with vertical=true as a column", () => {
    // `vertical` is a boolean, not a number — the player-list FlowContainer must stack
    // its items down a column (then wrap), not across a row.
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="List" type="FlowContainer" parent="."]
vertical = true

[node name="A" type="Control" parent="List"]
custom_minimum_size = Vector2(192, 68)
`);
    const list = model.nodes.find((node) => node.path === "List");
    expect(list?.style.display).toBe("flex");
    expect(list?.style["flex-direction"]).toBe("column");
    expect(list?.style["flex-wrap"]).toBe("wrap");
  });

  it("overlaps MarginContainer children (grid cell) instead of splitting them", () => {
    // The char-select button's MarginContainer holds Control (shadow/outlines) + Mask
    // (masked art); Godot fits BOTH to the full content rect (overlap), so neither may
    // take half the height — a column flex would split them vertically.
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="Btn" type="Control" parent="."]
custom_minimum_size = Vector2(100, 148)

[node name="MarginContainer" type="MarginContainer" parent="Btn"]
anchors_preset = 15
theme_override_constants/margin_left = 6
theme_override_constants/margin_top = 9
theme_override_constants/margin_right = 6
theme_override_constants/margin_bottom = 9

[node name="Control" type="Control" parent="Btn/MarginContainer"]

[node name="Mask" type="TextureRect" parent="Btn/MarginContainer"]
`);
    const byPath = new Map(model.nodes.map((node) => [node.path, node]));
    const margin = byPath.get("Btn/MarginContainer");
    const control = byPath.get("Btn/MarginContainer/Control");
    const mask = byPath.get("Btn/MarginContainer/Mask");

    // The MarginContainer is a single-cell grid (not a column flex that would split).
    expect(margin?.style.display).toBe("grid");
    expect(margin?.style["grid-template-rows"]).toBe("minmax(0, 1fr)");
    expect(margin?.style["flex-direction"]).toBeUndefined();
    expect(margin?.style.padding).toBe("9px 6px 9px 6px");

    // Both children occupy the SAME cell (overlap + fill), with no splitting flex.
    expect(control?.style["grid-area"]).toBe("1 / 1");
    expect(mask?.style["grid-area"]).toBe("1 / 1");
    expect(control?.style.flex).toBeUndefined();
    expect(mask?.style.flex).toBeUndefined();
  });

  it("grows a content-driven overlay MarginContainer (and its nested overlay) to a non-wrapping child, but not a definite one", () => {
    // The card-pile/deck `BottomText`: a point-anchored MarginContainer (content-driven,
    // width:min-content) holding a ColorRect backdrop + an inner MarginContainer > a
    // non-wrapping RichTextLabel. The label's text lives in an out-of-flow self-layer, so
    // only the overlay grid's column track can carry its width up. `minmax(0, 1fr)`'s 0
    // floor blocks that (collapsing the backdrop to the 124px box); a content-driven
    // overlay must use `minmax(min-content, 1fr)` so the child's full-line minimum grows
    // it — on BOTH the point-anchored container and the auto-width inner one. A DEFINITE
    // (stretched FULL_RECT) overlay keeps `minmax(0, 1fr)` so a wide child can't force it.
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15

[node name="BottomText" type="MarginContainer" parent="."]
anchor_left = 0.5
anchor_top = 1.0
anchor_right = 0.5
anchor_bottom = 1.0
offset_left = -62.0
offset_top = -57.0
offset_right = 62.0
offset_bottom = -17.0
grow_horizontal = 2

[node name="ColorRect" type="ColorRect" parent="BottomText"]
color = Color(0, 0, 0, 0.752941)

[node name="Inner" type="MarginContainer" parent="BottomText"]
theme_override_constants/margin_left = 16
theme_override_constants/margin_right = 16

[node name="Label" type="RichTextLabel" parent="BottomText/Inner"]
autowrap_mode = 0
text = "a long single line that must not wrap"

[node name="Fixed" type="MarginContainer" parent="."]
anchors_preset = 15

[node name="FixedLabel" type="RichTextLabel" parent="Fixed"]
autowrap_mode = 0
text = "anything"
`);
    const byPath = new Map(model.nodes.map((node) => [node.path, node]));
    const bottom = byPath.get("BottomText");
    const inner = byPath.get("BottomText/Inner");
    const fixed = byPath.get("Fixed");

    // Content-driven (point-anchored) → its column grows to the child min-content;
    // rows are unchanged (the bug is horizontal), width stays the content-hugging keyword.
    expect(bottom?.style.width).toBe("min-content");
    expect(bottom?.style["grid-template-columns"]).toBe(
      "minmax(min-content, 1fr)",
    );
    expect(bottom?.style["grid-template-rows"]).toBe("minmax(0, 1fr)");
    // The nested auto-width overlay grows too, so the label's width propagates up.
    expect(inner?.style["grid-template-columns"]).toBe(
      "minmax(min-content, 1fr)",
    );
    // A definite (stretched FULL_RECT) overlay keeps the 0 floor — no regression.
    expect(fixed?.style["grid-template-columns"]).toBe("minmax(0, 1fr)");
  });

  it("sizes the root to the viewport and keeps the same model shape", () => {
    const model = browserModel(`[gd_scene format=3]

[node name="Root" type="Control"]
`);
    const root = model.nodes.find((node) => node.parentPath === null);
    expect(root?.style.position).toBe("relative");
    expect(root?.style.width).toBe("1920px");
    expect(root?.style.height).toBe("1080px");
    // Same GodotHtmlModel surface the computed renderer returns.
    expect(model.viewport).toEqual({ width: 1920, height: 1080 });
    expect(Array.isArray(model.fontFaces)).toBe(true);
    expect(Array.isArray(model.nodes)).toBe(true);
  });
});
