# track-inject-addon fixture

`../track-inject` beside a project copy of the gsw-input addon: `project.godot`, `loader.gd`,
`track_inject.gd` and `track_inject.tscn` are symbolic links to that fixture's files, and
`addons/gsw_input` is a symbolic link to `packages/input/godot/addons/gsw_input` (as
`../track-input`). The project therefore has the global classes `GswInputInjector`, `GswInputCodec`
and the rest. The capture's embedded injector names its classes `RsBuiltin*`, so it must load beside
them with no "hides a global script class" error, while the project's own injector still
constructs. `g8l-trk-inject-addon` judges that. Import once with the editor (`--import`) before a
run; the leg does.
