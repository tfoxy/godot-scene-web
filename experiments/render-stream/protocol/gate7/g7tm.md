### G7tm — GSW MSDF text: gate 4e (opus)

G7t typed gate 4e's MSDF text `gsw-msdf` and drew none of it. Gate 6's scene draws Kreon as
MSDF, so G7g needs it drawn. G7tm adds the MSDF branch of Godot 4.5.1's GLES3 canvas shader to the
GSW receiver. The web export and the native reference both draw through GLES3, so that shader is
the oracle.

- **What Godot does** (4.5.1, all GLES3):
  - `modules/text_server_adv/text_server_adv.cpp:4025,4167`: a glyph of an MSDF font is
    `canvas_item_add_msdf_texture_rect_region(rect, page, uv_rect, modulate, outline_size,
    msdf_range, size / msdf_source_size)`. Outline 0 for the fill pass, the Label's `outline_size`
    for the outline pass.
  - `servers/rendering/renderer_canvas_cull.cpp:1544-1576`: a `TYPE_RECT` with
    `CANVAS_RECT_REGION | CANVAS_RECT_MSDF`, the region flips, and
    `outline = (float)p_outline_size / p_scale / 4.0`, `px_range = p_px_range`.
  - `drivers/gles3/rasterizer_canvas_gles3.cpp:999-1004`: `INSTANCE_FLAGS_USE_MSDF` and
    `msdf[0..1] = {px_range, outline}`, which alias `ninepatch_margins`
    (`rasterizer_canvas_gles3.h:214-215`).
  - `drivers/gles3/shaders/canvas.glsl:562-564` (`msdf_median`) and `601-618` (the branch):
    `px_size = max(0.5·dot(px_range / textureSize, 1 / fwidth(uv)), 1)`, `d` the median of RGB.
    With an outline, `cr = clamp(outline, 0, px_range/2 − 1) / px_range`, `d = min(d, a)` and the
    coverage is `clamp((d − 0.5 + cr)·px_size)`; without one it is `clamp((d − 0.5)·px_size + 0.5)`.
    The coverage multiplies `color.a`, where `color` is `color_interp` (vertex colour ×
    modulation, line 181/229, 266). The texel's colour is never multiplied in. The canvas modulate
    follows at line 716.
- **Files**:
  - `gsw-canvas-draw-list`: `DRAW_MSDF` (a `Draw::flags` bit) and `Draw::msdf: [px_range,
    outline]`. They are generic MSDF parameters with no render-stream concept (D6, D30). `Draw`
    grows from 44 to 52 bytes. `mergeable` compares the parameters of MSDF draws. `PDL1` version
    2 carries 52-byte draws, and `encode` writes version 1 unless a draw is MSDF, so earlier dumps
    are unchanged.
  - `canvas-items`: the builtin program's MSDF variant (`VERT` + `msdf_fragment`) and the same
    branch in `item_program_fragment` (canvas.glsl runs it before the shader's fragment code). The
    shared GLSL is `MSDF_COVERAGE`, written statement for statement from canvas.glsl.
  - `render-stream-core`'s lowering: `add_msdf_texture_rect_region` lowers as a region with the
    draw's `msdf` set. `Shortcut::MsdfSkipped` and the `gsw-msdf` typed reason are retired.
  - Gate scripts: the gate 4e receiver checks are judged `@gsw` again, the gate 4e glyph boxes are
    `delta1` like gate 4's others, and the sabotage legs and their checks are added.
- **Checks**: every gate 4e receiver check `@gsw` (`leg-class-receiver-msdf{,-patch}`,
  `receiver-vs-reference-msdf`, `ink-presence-receiver-msdf`, the perturb-glyph and drop sabotages
  with their native predicted sets). Q7: decided pixels exact, glyph boxes `delta1`.
  `atlas-upload-parity` already covers `msdf/receiver{,-patch}` (one upload per wire version, the
  same census). The package pixel suite `canvasItemsProgramPixel` gets the MSDF cases against a
  hand model.
- **Sabotages** (GSW-only, each against the honest gsw leg; prediction from gate 4e's
  `expected.json`): at every settle step the shot must differ in exactly that step's MSDF text
  regions, and in no pixel outside them.
  - `msdf-no-median` (executor): the smallest of the three distances instead of the median.
    The minimum never exceeds the median, so coverage only falls, and only where the honest leg
    drew ink, which lies inside the text regions (`expected-image-receiver-msdf`).
  - `msdf-px-range` (lowering): half the wire's `px_range`.

  The package suite also runs `msdf-no-median` against its own arithmetic.
- **Re-runs**: the Rust-crate and `packages/canvas/rust-*` rows of gate7-design.md's Re-runs
  table, plus every landed `g7-*` GSW group.
- **As built (G7tm, 2026-10-17)**, details in [results/gate7/g7tm.md](../../results/gate7/g7tm.md).
  `g7-4` passes for `gsw` (69/69 gating checks), and so do `g7-0` to `g7-5` and `g7-55`: 282/282
  over the seven groups, on sources made on this build.
  - **Gate 4e is `delta1`, as predicted.** Every decided pixel is exact. Every MSDF glyph box is
    within 1: 13 525 px over 10 settle shots per receiver leg, 0 outside the glyph boxes, none at
    delta 2 or more. All but 22 lie on partially covered pixels, Q7's translucent-blend cause.
    No MSDF glyph box is byte-exact (0/50 per leg).
  - **Sabotages** fail exactly as predicted. `msdf-no-median` changes 11 417 px and
    `msdf-px-range` 59 693 px, each in exactly every step's text regions and nowhere else. The
    first `msdf-no-median` took the maximum, which spills ink into the distance field's padding
    outside the glyph boxes. It became the minimum, whose effect the prediction bounds.
  - **The draw list**: `Draw` is 52 bytes (`msdf`, flag `DRAW_MSDF` = 2). `PDL1` version 1 is
    written whenever no draw is MSDF, and version 2 otherwise.
  - **Default exports unchanged**: `build-web.sh` gives wasm `d810e2a3…` and JS `fed168e4…`, the
    same bytes as main.
