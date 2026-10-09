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
