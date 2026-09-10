# Layout

`@godot-scene-web/layout` interprets a small Godot `Control` subset into rectangles.

## V1 Node Coverage

- `Control`
- `Node`, `Node2D`, `CanvasLayer`, `CanvasGroup`
- `Panel`
- `ColorRect`
- `TextureRect`
- `NinePatchRect`
- `Sprite2D`
- `Line2D`
- `AnimatedSprite2D`
- `CPUParticles2D`, `GPUParticles2D`
- `Label`
- `RichTextLabel`
- `Button`
- `LineEdit`
- `TextEdit`
- `AspectRatioContainer`
- `BoxContainer`
- `HBoxContainer`
- `VBoxContainer`
- `FlowContainer`
- `HFlowContainer`
- `VFlowContainer`
- `PanelContainer`
- `ScrollContainer`
- `MarginContainer`
- `CenterContainer`
- `GridContainer`
- `SubViewportContainer`

Runtime-heavy 2D, custom/plugin, audio, viewport, and 3D-adjacent nodes are either omitted or preserved as stable placeholder DOM nodes with `data-godot-*` metadata when no browser-equivalent renderer is implemented. Parser output still preserves unknown node types and raw properties so consumers can replace project-specific nodes outside the core renderer.

## V1 Property Coverage

The current implementation covers anchors, offsets, position, size, custom minimum size, grow direction, visibility, z-index, relative z-index, clipping, scale/pivot, basic text alignment, aspect-ratio container stretch/alignment, box separation and expansion, shrink-center/shrink-end cross-axis flags, horizontal and vertical flow wrapping, panel stylebox content margins, basic scroll container content sizing, margin/center containers, grid columns, recursive mounted scene instances, static Sprite2D textures with regions/frames, static Line2D polylines with cap/joint/gradient metadata, and bounded static previews for 2D particle nodes.

## Known Gaps

- Container behavior is intentionally partial and focused on rectangle parity for common UI scenes.
- Theme resolution is hook-based and not complete.
- `anchors_preset` is not interpreted unless corresponding `anchor_*` and `offset_*` properties are present.
- Font metrics and image filtering are out of scope for rectangle parity.
