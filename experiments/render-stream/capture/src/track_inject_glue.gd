extends Node
## Built-in `input` track receiver (TRK6, protocol/tracks-design.md Q6 "Built-in injection").
##
## GENERATED INTO ONE SCRIPT by cmake/embed_gsw_input.cmake: this file is the head, and the
## gsw-input/1 reference injector (packages/input/godot/addons/gsw_input/*.gd) follows as inner
## classes named RsBuiltin*, so a project that ships the addon itself never collides with it. The
## capture creates one instance with GDScript.new() when GRC_LIVE_TRACK_INPUT_INJECT=reference
## and emits `opened`, `message` and `closed` on it from its frame callback, exactly as a
## RenderStreamTrack would; this node does what the design's script receiver does:
##
##   message -> injector.receive(source, text)
##   closed  -> injector.close_channel(source)    # releases everything the source held
##
## The injector node (ticking, focus loss, release on leaving the tree) is a child. Everything is
## in the tree under the root as `RsTrackInputInjector`; freeing it ends the receiver (open tracks
## close `track-receiver-gone`). `received` is a diagnostic: gate 8's fixture listens to it.

## A dynamically created script has no `res://addons/` path, so a project that treats warnings as
## errors (debug/gdscript/warnings/*) would refuse the embedded injector. Every warning is off for
## this script; the addon itself is held to its own rules by packages/input's tests.
@warning_ignore_start(
	"assert_always_false",
	"assert_always_true",
	"confusable_capture_reassignment",
	"confusable_identifier",
	"confusable_local_declaration",
	"confusable_local_usage",
	"deprecated_keyword",
	"empty_file",
	"enum_variable_without_default",
	"get_node_default_without_onready",
	"incompatible_ternary",
	"inference_on_variant",
	"inferred_declaration",
	"int_as_enum_without_cast",
	"int_as_enum_without_match",
	"integer_division",
	"missing_tool",
	"narrowing_conversion",
	"native_method_override",
	"onready_with_export",
	"redundant_await",
	"redundant_static_unload",
	"return_value_discarded",
	"shadowed_global_identifier",
	"shadowed_variable",
	"shadowed_variable_base_class",
	"standalone_expression",
	"standalone_ternary",
	"static_called_on_instance",
	"unassigned_variable",
	"unassigned_variable_op_assign",
	"unreachable_code",
	"unreachable_pattern",
	"unsafe_call_argument",
	"unsafe_cast",
	"unsafe_method_access",
	"unsafe_property_access",
	"unsafe_void_return",
	"untyped_declaration",
	"unused_local_constant",
	"unused_parameter",
	"unused_private_class_variable",
	"unused_signal",
	"unused_variable"
)

## SHA-256 of the addon's *.gd files (the embed's inputs), concatenated in name order.
const ADDON_SHA256: String = "@@ADDON_SHA256@@"

signal opened(source: int, info: Dictionary)
signal message(source: int, text: String)
signal closed(source: int, code: int, reason: String)
## One `message` after the injector handled it: `result` is its code ("" = applied).
signal received(source: int, bytes: int, result: String)

var injector: RsBuiltinInputInjector
## "no-release": `closed` does not release (GRC_SABOTAGE=track-inject-no-release).
var sabotage: String = ""


func _init() -> void:
	name = "RsTrackInputInjector"
	process_mode = Node.PROCESS_MODE_ALWAYS
	var host: RsBuiltinInputInjectorNode = RsBuiltinInputInjectorNode.new()
	host.name = "InjectorNode"
	injector = host.injector
	add_child(host)
	message.connect(_on_message)
	closed.connect(_on_closed)


## `config_json` is GRC_LIVE_TRACK_INPUT_CONFIG: "" or a JSON object for injector.configure().
## False when it is not an object or configure() refuses a key or a type.
func setup(config_json: String, sabotage_mode: String) -> bool:
	sabotage = sabotage_mode
	if config_json == "":
		return true
	var parsed: Variant = JSON.parse_string(config_json)
	if typeof(parsed) != TYPE_DICTIONARY:
		return false
	var config: Dictionary = parsed
	return injector.configure(config)


## Adds this node under the root. False when there is no tree yet.
func attach() -> bool:
	var tree: SceneTree = Engine.get_main_loop() as SceneTree
	if tree == null or tree.root == null:
		return false
	if get_parent() == null:
		tree.root.add_child.call_deferred(self)
	return true


func _on_message(source: int, text: String) -> void:
	var result: String = injector.receive(source, text)
	received.emit(source, text.to_utf8_buffer().size(), result)


func _on_closed(source: int, _code: int, _reason: String) -> void:
	if sabotage != "no-release":
		injector.close_channel(source)
