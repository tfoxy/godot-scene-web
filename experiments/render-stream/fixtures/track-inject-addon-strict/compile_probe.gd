extends SceneTree
## HYG2 compile probe (fixtures/track-inject-addon-strict/README.md).
##
## GDScript warnings exist only in a debug-enabled engine (DEBUG_ENABLED): the pinned release
## template that the capture arms on compiles none, so a leg on it cannot show that a warning is
## or is not an error. This script runs under the repo's 4.5.1 editor binary (`mise exec -- godot
## --headless --path <this project> --script res://compile_probe.gd`), where the project's strict
## settings are live (override.cfg: exclude_addons=false, plus ../track-inject's untyped_declaration
## and unsafe_* errors), and reports what the engine did with:
##
##   - the project's own copy of the gsw_input addon (res://addons/, held to the warnings because
##     exclude_addons is false), and
##   - the capture's embedded injector: capture/build/generated/rs_track_inject_script.gd, the
##     script the capture compiles with GDScript.new() / set_source_code() / reload(), as generated
##     and with one deliberate warning appended. A dynamic script has no res://addons/ path, so
##     only its `@warning_ignore_start(<every warning>)` head protects it.
##     RS_PROBE_STRIP_WARNING_HEAD=1 removes that head first (the sabotage).
##
## Environment: RS_PROBE_SCRIPT (the generated script), RS_PROBE_OUT (the JSON this writes) and
## RS_PROBE_STRIP_WARNING_HEAD. Gate 8's g8l/inject/strict-compile legs judge the JSON and the
## engine log (`Warning treated as error`) in scripts/lib/gate8-track-checks.ts.

const ADDON_DIR: String = "res://addons/gsw_input/"
const ADDON_INJECTOR: String = "res://addons/gsw_input/gsw_input_injector.gd"
const HEAD: String = "@warning_ignore_start("
const TAINT: String = "\nvar hyg2_untyped_member = 1\n"


func _init() -> void:
	var report: Dictionary = {}
	var info: Dictionary = Engine.get_version_info()
	report["godot"] = str(info.get("string", ""))
	report["debug_build"] = OS.is_debug_build()
	report["exclude_addons"] = ProjectSettings.get_setting("debug/gdscript/warnings/exclude_addons", true)
	report["untyped_declaration_level"] = ProjectSettings.get_setting("debug/gdscript/warnings/untyped_declaration", 0)
	report["unsafe_call_argument_level"] = ProjectSettings.get_setting("debug/gdscript/warnings/unsafe_call_argument", 0)
	report["project_addon"] = _probe_project_addon()
	report["embedded"] = _probe_embedded()
	var path: String = OS.get_environment("RS_PROBE_OUT")
	if path != "":
		var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
		if file != null:
			file.store_string(JSON.stringify(report, "\t", true))
			file.close()
	print("[compile-probe] ", JSON.stringify(report, "", true))
	quit(0)


## The project's own addon: global class registered, every script in it loads (a warning-as-error
## in one nulls its load), and the injector instantiates and has its entry point.
func _probe_project_addon() -> Dictionary:
	var global_class: bool = false
	for entry: Dictionary in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) == "GswInputInjector":
			global_class = true
	var files: Dictionary = {}
	var names: PackedStringArray = DirAccess.get_files_at(ADDON_DIR)
	names.sort()
	for file_name: String in names:
		if file_name.ends_with(".gd"):
			var script: GDScript = load(ADDON_DIR + file_name) as GDScript
			files[file_name] = script != null and script.can_instantiate()
	var constructs: bool = false
	if ResourceLoader.exists(ADDON_INJECTOR):
		var injector: GDScript = load(ADDON_INJECTOR) as GDScript
		if injector != null and injector.can_instantiate():
			var own: Object = injector.new()
			constructs = own != null and own.has_method("receive")
	return {"global_class": global_class, "files": files, "constructs": constructs}


## The embedded injector, compiled the way the capture compiles it: as generated (`clean`), and
## with one deliberate warning appended (`covered`: an untyped member, an error under this
## project's settings). Only the head can excuse that line, so `covered` compiling is what shows
## the head works, and it is what the sabotage (head stripped from both) must break.
func _probe_embedded() -> Dictionary:
	var path: String = OS.get_environment("RS_PROBE_SCRIPT")
	var source: String = FileAccess.get_file_as_string(path) if path != "" else ""
	var head_before: bool = source.find(HEAD) >= 0
	var stripped: bool = false
	if OS.get_environment("RS_PROBE_STRIP_WARNING_HEAD") == "1":
		var start: int = source.find(HEAD)
		var end: int = source.find(")\n", start) if start >= 0 else -1
		if end >= 0:
			source = source.erase(start, end + 2 - start)
			stripped = true
	return {
		"source_bytes": source.length(),
		"head_before": head_before,
		"head_after": source.find(HEAD) >= 0,
		"stripped": stripped,
		"clean": _compile(source),
		"covered": _compile(source + TAINT),
	}


## reload() the source as a dynamic script (no res:// path) and construct it once.
func _compile(source: String) -> Dictionary:
	var script: GDScript = GDScript.new()
	script.source_code = source
	var reload_error: int = script.reload(false)
	var constructs: bool = false
	var has_setup: bool = false
	if reload_error == OK and script.can_instantiate():
		var node: Object = script.new()
		if node != null:
			constructs = true
			has_setup = node.has_method("setup")
			if node is Node:
				(node as Node).free()
	return {"reload_error": reload_error, "constructs": constructs, "has_setup": has_setup}
