# Gate -1 spike fixture

A small, fixed Godot 4.5 project used to prove a GDExtension can interpose on
`RenderingServer` inside an **unmodified official 4.5.1 Linux release export template**, under
`--headless`. This project does not know about the capture library: it runs identically whether
`GRC_EXTENSION` is set or not, and prints what happened either way. See
`../../scripts/README.md` for the runner that drives it and `expected.json` for the exact values
it draws.

## Running a loose project directory under the RELEASE TEMPLATE needs one prior step

The release template at
`~/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64` is an **export**
template: it expects to run a packed `.pck`/embedded-data build, not a bare project directory of
`.tscn`/`.gd` text files. Measured directly (see `scripts/README.md` for the reproduction):

- `linux_release.x86_64 --headless --path fixtures/spike` against a **freshly checked-out**
  project (no `.godot/` yet) fails immediately with
  `ERROR: Could not load global script cache.` (`core/config/project_settings.cpp:1341`), and then
  **idles forever** in the main loop without ever reaching `_ready()` -- it does not exit
  non-zero, it just never starts, which makes the failure easy to miss if you only check the exit
  code.
- The fix is **not** `--export-pack`. A single editor **import pass** is enough:
  ```bash
  mise exec -- godot --headless --path fixtures/spike --import
  ```
  This populates `fixtures/spike/.godot/` (global script cache, global class list, import
  metadata) and does not require `--export-pack`, a `.pck`, or any export preset. Once `.godot/`
  exists, the plain release template runs the directory directly and correctly:
  `linux_release.x86_64 --headless --path fixtures/spike` loads `spike.tscn`, runs the autoload
  and main scene, and exits 0 at frame 400.
- `.godot/` is already covered by the repo-root `.gitignore` (`.godot/`, `*.import`, `*.uid`), so
  it is never committed; every runner invocation re-imports before launching the template (cheap:
  well under a second for this fixture, and idempotent).

`scripts/run-gate-minus1.sh` and `scripts/lib/gamescope.sh` both run the import step
(`mise exec -- godot --headless --path <project> --import`) before every launch of the release
template, for both the headless legs and the rendered gamescope legs.

## What's in the scene

- `project.godot`: Compatibility renderer (`gl_compatibility`, desktop and mobile), a fixed
  640x360 viewport with stretch disabled and no MSAA, `rendering/viewport/hdr_2d=false`, a fixed
  clear color (`Color(0.1, 0.1, 0.12, 1)`), vsync disabled (deterministic frame pacing, no need to
  wait on a real display refresh), and the `GrcLoader` autoload. Typed-GDScript discipline: see
  "GDScript warning levels" below.
- `loader.gd` (`GrcLoader` autoload): if `GRC_EXTENSION` (absolute path to a `.gdextension` file)
  is set, loads it via `GDExtensionManager.load_extension()` in `_enter_tree()` -- autoloads enter
  the tree before `run/main_scene`, so this always runs before the main scene's first frame.
  Prints `[fixture] extension load status=<NAME> (<int>) path=<path>`, or
  `[fixture] extension load status=skipped (GRC_EXTENSION not set)` when unset. The extension is
  loaded in **mod mode** by this fixture, not declared in `project.godot`'s own extension list --
  that matches the capture library's runtime contract (owned by the sibling `capture/` work, not
  this directory).
- `spike.tscn` / `spike.gd`: a `ColorRect` at `(40, 40)` size `(120, 80)`, color
  `Color(0.875, 0.25, 0.125, 1)`; a `Label` at `(40, 160)`, font size 32, default font, text
  `"Spike Ag"`; the scene root (`Node2D`, script `spike.gd`) draws a rectangle and a triangle
  directly through `RenderingServer` in its own `_draw()`. Every frame: `queue_redraw()`, and
  `draw_count` is incremented in `_draw()`. At frame 30 the Label's text changes to
  `"Spike Ag Qz!"` (new glyphs `Q`, `z`, `!` -> a font atlas texture update). At frame
  `GRC_SCREENSHOT_FRAME` (env, default 60), if `GRC_SCREENSHOT` (env, absolute PNG path) is set,
  it awaits `RenderingServer.frame_post_draw` and saves
  `get_viewport().get_texture().get_image()` to that path -- **rendered legs only**; under
  `--headless` (`DisplayServer.get_name() == "headless"`) this is skipped with a log line instead
  of awaiting a signal a truly headless run may never fire. At frame 400 it calls
  `get_tree().quit(0)`, printing `[fixture] draws=<n> frames=<n>`.
- Calibrator-2 draw paths, added for gate −0.25. Every literal is exactly
  representable in float32. The exact values are in `expected.json`
  `draw_paths`. The canvas items are:
  - a `Panel` at (500, 20) with a rounded `StyleBoxFlat`, drawn natively through
    `canvas_item_add_triangle_array`. In `_ready()` it is given a `modulate` and
    a `ShaderMaterial`. That material's shader is created from code, then
    re-coded, and gets a white `tint` parameter, so the pixels do not change.
  - a `NinePatchRect` at (520, 140) on a 4×4 RGBA8 `ImageTexture` that
    `_ready()` creates, drawn natively through `canvas_item_add_nine_patch`.

  `_draw()` adds direct `RenderingServer` calls:
  - `canvas_item_add_triangle_array` (indexed quad with colours and UVs)
  - `canvas_item_add_nine_patch` (on the same texture, with tile and tile-fit
    modes, `draw_center = false` and a modulate)
  - `canvas_item_add_primitive`, `_line`, `_polyline`
  - `canvas_item_add_mesh` and `canvas_item_add_multimesh` of an `ArrayMesh`
  - `canvas_item_add_set_transform`, followed by `canvas_item_add_circle` in the
    shifted space

  The `ArrayMesh` has 3 `Vector2` vertices and colours, with
  `ARRAY_FLAG_USE_DYNAMIC_UPDATE`. This is the shape spine-godot's `SpineMesh2D`
  uses. Every `_process()` rewrites vertex 1 with
  `mesh_surface_update_vertex_region` and vertex 2's colour with
  `mesh_surface_update_attribute_region`, then sets a custom AABB. A scratch mesh
  is created and cleared (`mesh_clear`). A `Node2D` added in `_ready()` creates a
  canvas item after the capture armed. The scene's own items already exist
  before the extension loads.

- Calibrator-3 state hooks, added for gate 0. Nothing here draws, so the pixels
  do not change:
  - the post-arm `Node2D` gets `z_index = 1` (`canvas_item_set_z_index`) and a
    non-white `self_modulate` (`canvas_item_set_self_modulate`). The colour is
    not `Color.WHITE` because `CanvasItem::set_self_modulate` returns early on an
    unchanged value (`scene/main/canvas_item.cpp:556`) and would never reach the
    `RenderingServer`. The node draws nothing, so its self-modulate is invisible.
  - an empty `CanvasLayer` added in `_ready()`: `canvas_create` in its
    constructor, then `viewport_attach_canvas` and
    `viewport_set_canvas_transform` when it enters the tree.
  - the scene's own nodes enter the tree after arming (the autoload arms first),
    which calls `canvas_item_set_parent`, `_set_visibility_layer`, `_set_visible`
    and the deferred `_set_draw_index`. Each `Control` redraw calls
    `canvas_item_set_custom_rect` and `_set_clip` (`scene/gui/control.cpp:3899-3901`).

- Calibrator-4 state hooks, added for gate 1 G1e (`canvas_item_set_z_as_relative_to_parent`,
  `canvas_item_set_draw_behind_parent`). Nothing here draws either, so the pixels do not change:
  the same post-arm `Node2D` also gets `z_as_relative = false` and `show_behind_parent = true`.
  Neither is left at its default (`z_relative` true, `behind` false), because
  `CanvasItem::set_z_as_relative` and `set_draw_behind_parent` return early on an unchanged value
  (`scene/main/canvas_item.cpp:655-661`, `:1155-1161`) and would never reach the RenderingServer.

- Calibrator-5 texture hooks, added for gate 2 G2a (`gate2-design.md` Q2), all with non-default
  values and none reaching the screen: the post-arm `Node2D` gets `texture_filter = NEAREST` and
  `texture_repeat = ENABLED` (`canvas_item_set_default_texture_filter`/`_repeat`; the setters
  return early on an unchanged value, `canvas_item.cpp:1626`, `:1680`); a raw placeholder is
  replaced by a 2x2 image and freed (`texture_2d_placeholder_create`, `texture_replace`); a raw
  `viewport_create()` viewport that is never attached gets NEAREST and ENABLED
  (`viewport_set_default_canvas_item_texture_filter`/`_repeat`); a `CanvasTexture` no item uses
  gets the nine-patch texture as diffuse, NEAREST and ENABLED (`canvas_texture_create`,
  `_set_channel`, `_set_texture_filter`, `_set_texture_repeat`); and an LCD text rect lands on a
  raw canvas item that has no parent canvas (`canvas_item_add_lcd_texture_rect_region`). Gate −1
  then plans 55 hooks with every optional counter positive, and `armed.png == unarmed.png`.

- `expected.json`: the exact rect/color/polygon values above (plus float32 hex bits) in the shape
  the capture library's `counters.json` captures them, and which counters must be positive. See
  its own `"description"` fields for the Godot-source citations (`color_rect.cpp`,
  `canvas_item.cpp`, `rendering_server.h`) backing each expected value.

## GDScript warning levels

`project.godot`'s `[debug]` section sets `gdscript/warnings/{untyped_declaration,
unsafe_property_access, unsafe_method_access, unsafe_cast, unsafe_call_argument} = 2` (2 ==
`GDScriptWarning::ERROR`). `inferred_declaration` is deliberately left at the engine default
(`IGNORE`) -- the repo prefers `:=`, and erroring on inferred types would fight that.

There is **no** `debug/gdscript/warnings/treat_warnings_as_errors` setting in Godot 4.5.1: it was
not found in `modules/gdscript/gdscript.cpp`, `modules/gdscript/gdscript_warning.{h,cpp}`, or
`core/config/project_settings.cpp` in the local 4.5.1 source. Every individual warning has its own
per-code settings path instead (`GDScriptWarning::get_settings_path_from_code`, i.e.
`"debug/gdscript/warnings/" + <code name, lowercased>`), each independently levelable
`IGNORE`/`WARN`/`ERROR` (`gdscript_warning.h`'s `WarnLevel` enum) -- so each warning this fixture
cares about is raised to `ERROR` by name, and there is nothing to set as a single global switch.

These warnings only run in `DEBUG_ENABLED` builds (the `#ifdef DEBUG_ENABLED` guard around their
registration in `gdscript.cpp`): the mise-managed editor binary (`godot --version` ->
`4.5.1.stable.mono.official.f62fdbde1`) has them; the official release export template does not
produce GDScript warnings/errors for this at all (it isn't a debug build), so the clean-load proof
below is checked against the editor binary, not the template.

Verified clean (zero warnings, zero errors) with:

```bash
mise exec -- godot --headless --path fixtures/spike --import
mise exec -- godot --headless --path fixtures/spike
# -> "[fixture] extension load status=skipped (GRC_EXTENSION not set)"
# -> "[fixture] draws=400 frames=400"
# exit 0, no SCRIPT ERROR / WARNING lines
```

One fixture-authoring note this surfaced: a `const` cannot be initialized from a
`PackedVector2Array`/`PackedColorArray` built from an array of `Vector2()`/`Color()` constructor
calls -- the GDScript parser rejects that as "isn't a constant expression" (only `Rect2()`/
`Color()` _scalar_ literals qualify). `spike.gd` uses typed `var _polygon_points` /
`_polygon_colors` for those two instead, set once and never reassigned.
