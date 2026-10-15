class_name RsConfig
extends RefCounted
## The receiver's one configuration reader (gate7-design.md Q4 "rs_config.gd", G7e). Every
## RS_RECEIVER_* value is read through get_env(): the process environment first, then
## `--rs-env=NAME=VALUE` from OS.get_cmdline_user_args() (the words after `--` on the command
## line). Natively the environment is what every runner sets, so native behaviour is unchanged.
## A web export has only the second: OS_Web's environment is emscripten's synthetic one, with no
## RS_* variable (gate7-design.md Q1a "Environment"), so receiver/web/shell.html turns the page's
## `?env=` query into `--rs-env=` words after `--`.
##
## A name given twice in --rs-env keeps its last value. An empty environment value counts as
## unset (the receiver already treats "" as unset everywhere), so --rs-env can supply it.

const ARG_PREFIX: String = "--rs-env="

static var _args: Dictionary[String, String] = {}
static var _parsed: bool = false


## The value of `variable`: environment first, then --rs-env, else "".
static func get_env(variable: String) -> String:
	var value: String = OS.get_environment(variable)
	if value != "":
		return value
	_parse_args()
	var given: String = _args.get(variable, "")
	return given


## Whether this process is a web export (OS.has_feature("web")): rs_io.gd's sources and sinks
## switch on it, and rs_perf.gd's RSS and render-time statuses.
static func is_web() -> bool:
	return OS.has_feature("web")


## The --rs-env names given, sorted (for the receiver's own log line).
static func arg_names() -> Array[String]:
	_parse_args()
	var names: Array[String] = []
	for name: String in _args:
		names.append(name)
	names.sort()
	return names


static func _parse_args() -> void:
	if _parsed:
		return
	_parsed = true
	for arg: String in OS.get_cmdline_user_args():
		if not arg.begins_with(ARG_PREFIX):
			continue
		var pair: String = arg.substr(ARG_PREFIX.length())
		var equals: int = pair.find("=")
		if equals <= 0:
			continue
		_args[pair.substr(0, equals)] = pair.substr(equals + 1)
