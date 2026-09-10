# Fixtures

These fixtures are small, generic Godot scenes that document the currently supported parser, layout, HTML, and Vue surface. Keep them product-neutral and focused on one behavior per file where possible.

## Coverage Map

- `anchors/full-rect.tscn`: anchors, offsets, grow behavior, `ColorRect`.
- `offsets/basic.tscn`: fixed offsets.
- `visibility/hidden.tscn`: `visible = false`.
- `text-alignment/blocks.tscn`: horizontal label alignment.
- `text-alignment/rich-theme.tscn`: `RichTextLabel`, BBCode, vertical alignment, font/color/shadow/outline theme overrides.
- `text-alignment/rich-theme-roboto.tscn`: `RichTextLabel` theme overrides backed by Roboto font files. Its `.parity.json` sidecar requires Godot screenshot diff.
- `containers/hbox.tscn`: basic `HBoxContainer` separation.
- `containers/box-expand-alignment.tscn`: box expansion space with size flags.
- `containers/flow.tscn`: `HFlowContainer` wrapping and `h_separation` / `v_separation`.
- `containers/vflow.tscn`: `VFlowContainer` vertical wrapping and child order.
- `containers/box-base.tscn`: base `BoxContainer` with `vertical = true`.
- `containers/flow-base.tscn`: base `FlowContainer` with `vertical = true`.
- `containers/aspect-ratio.tscn`: `AspectRatioContainer` fit sizing and center alignment.
- `containers/panel-container.tscn`: `PanelContainer` stylebox content margins.
- `containers/scroll-container.tscn`: `ScrollContainer` normal-flow content and overflow.
- `instances/host.tscn`: `PackedScene` instance mounting and inherited child overrides.
- `instances/button.tscn`: mounted scene target for `instances/host.tscn`.
- `instances/nested-host.tscn`: recursive `PackedScene` instance mounting and mounted-scene resource resolution.
- `instances/nested-child.tscn`: intermediate mounted scene target for `instances/nested-host.tscn`.
- `instances/nested-leaf.tscn`: nested mounted scene target with its own texture resource.
- `images/texture-and-ninepatch.tscn`: `TextureRect`, `NinePatchRect`, texture refs, patch margins, pointer events, modulation.
- `images/texture-region-repeat.tscn`: direct texture regions, flips, repeat/filter/expand metadata, modulation, and nine-patch axis stretch.
- `resources/atlas-panel.tres`: `AtlasTexture` resource shape.
- `resources/glyph-font.tres`: `FontVariation` resource shape.
- `resources/roboto-*.tres`: `FontVariation` resources backed by `FontFile` wrappers for Roboto font files under `assets/fonts/roboto/`. Those TTFs are not committed — they are downloaded on demand by `scripts/ensure-roboto-fonts.ts` (invoked from the parity flow and the fixture tests).
- `resources/noto-sans-sc*.tres`: the CJK font the text-rendering benchmark measures, as a `FontFile` wrapper plus a `FontVariation`. Backed by `assets/fonts/noto-sans-sc/NotoSansSC-bench.ttf`, which is not committed: `scripts/ensure-cjk-font.ts` downloads upstream `NotoSansSC[wght].ttf` (17.7 MB) and subsets it to the benchmark charset — ASCII plus 3000 contiguous Han codepoints from U+4E00 — with the variable `wght` axis pinned to its default, producing ~800 KB. The subset is a pure function of that charset, so it regenerates byte-identically; the same file is loaded by Godot, a CSS `@font-face`, canvas2d and harfbuzz so all four rasterize the same outlines.
- `parser/multiline-editable.tscn`: multiline quoted text and `[editable]` metadata.
- `parser/spriteframes-stringname.tscn`: multiline arrays/dictionaries, `SpriteFrames`, and `StringName` literals.
- `rendering/panel-input-styleboxes.tscn`: `Panel`, `LineEdit`, `TextEdit`, `StyleBoxFlat`, and `StyleBoxEmpty`.
- `transforms/scale-pivot.tscn`: vector `scale` and `pivot_offset`.
- `visual-2d/animated-sprite2d.tscn`: `AnimatedSprite2D` selected animation/frame, centered offset, and static texture bounds parity.
- `visual-2d/sprite2d.tscn`: `Sprite2D` region, frame, and texture filter parity.
- `visual-2d/line2d.tscn`: `Line2D` bounds plus cap, joint, texture mode, and gradient metadata.
- `visual-2d/particles2d.tscn`: simple bounded `GPUParticles2D` static preview parity.

Non-Control/pass-through rendering for `CanvasLayer`, `CanvasGroup`, `Node`, `Node2D`, `Range`, `AnimatedSprite2D`, and VFX placeholders is covered by targeted unit tests. Focused parity fixtures cover simple `AnimatedSprite2D`, `Sprite2D`, `Line2D`, and `GPUParticles2D` bounds.

Generated parity artifacts for these fixtures belong under `artifacts/` and must not be committed.
