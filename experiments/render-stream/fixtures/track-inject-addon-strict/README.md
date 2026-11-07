# track-inject-addon-strict fixture

`../track-inject-addon` (the project ships the gsw-input addon) with GDScript warnings treated as
errors for the addon as well. `project.godot`, `loader.gd`, `track_inject.gd`, `track_inject.tscn`
and `addons/gsw_input` are symbolic links as in `../track-inject-addon`. Its own files:

- `override.cfg` sets `debug/gdscript/warnings/exclude_addons=false` on top of `../track-inject`'s
  `untyped_declaration=2` and `unsafe_*=2`, so `res://addons/` scripts are held to those warnings.
  The observer logs the effective values in its `contract` event.
- `compile_probe.gd` (a `SceneTree` script).

**Two legs, because GDScript warnings exist only in a debug-enabled engine.** The release template
the capture arms on compiles none (`DEBUG_ENABLED` only), so a capture leg there can show that
the strict project still loads and delivers (`g8l/inject/addon-strict`, `g8l-trk-inject-strict`)
but never a warning being, or not being, an error. `compile_probe.gd` runs under the repo's
4.5.1 editor binary (`env -C <repo> mise exec -- godot --headless --path . --script
res://compile_probe.gd`), where the warnings are live, and reports (`g8l/inject/strict-compile`,
`g8l-trk-inject-strict-compile`):

- every script of the project's own `gsw_input` addon compiles, and the injector constructs;
- the capture's embedded injector (`capture/build/generated/rs_track_inject_script.gd`, compiled
  as the capture does: `GDScript.new()`, `source_code`, `reload()`) compiles and constructs, and
  so does the same script with one deliberate warning appended (an untyped member). A dynamic
  script has no `res://addons/` path, so `exclude_addons` never excused it: only its
  `@warning_ignore_start(<every warning>)` head does.

The sabotage `g8l/inject/sabotage-warnings` (`RS_PROBE_STRIP_WARNING_HEAD=1`) strips that head
before both compiles: the script with the deliberate warning must then fail `reload()` with
`Warning treated as error` (`g8l-trk-inject-sabotage-warnings`). The unmodified embedded script
still compiles without its head, because the addon is warning-clean; the head is the
guard against the next warning, not a fix for a current one. Import once with the editor
(`--import`) before a run; the leg does.
