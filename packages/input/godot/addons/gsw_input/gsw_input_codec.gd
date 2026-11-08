class_name GswInputCodec
extends RefCounted
## gsw-input/1 validator (docs/input.md "Validation"), a port of packages/input/src/codec.ts.
##
## The field tables below are in CHECK order, the order of the TypeScript tables: the first failing
## check picks the `code` and `path`, so the order is part of the contract, and every vector in
## packages/input/conformance/v1/codec must give the same `ok`, `code`, `path` and `skipped` here
## (tests/codec_selftest.gd). Change a table here only together with codec.ts.
##
## `parse(text)` returns a Dictionary:
##   {ok = true, message = Dictionary, skipped = int}
##   {ok = false, code = String, path = String ("" when the error names no member), detail = String}
## An accepted message holds only the known members, with integers as `int`, numbers as `float`,
## vectors as `[float, float]` and records as Dictionaries; a record's absent optional fields stay
## absent (the reader applies Godot's defaults).

const FORMAT: String = "gsw-input/1"
const MAX_MESSAGE_BYTES: int = 4096
const MAX_EVENTS: int = 64
const MAX_TARGET_HANDLE: int = 1023
const MAX_KINDS: int = 32

const _MAX_COORD: int = 1000000
const _MAX_SAFE: int = 9007199254740991
const _U32_MAX: int = 4294967295
## Key values without modifier masks (core/os/keyboard.h, KeyModifierMask::CODE_MASK).
const _KEY_MAX: int = 0x7FFFFF

# Field types.
const _INT: int = 0
const _NUM: int = 1
const _BOOL: int = 2
const _VEC2: int = 3
const _PATTERN: int = 4
## Free text: UTF-8 length 1..max bytes, no C0 control characters or DEL.
const _TEXT: int = 5
## Nonzero u64 ObjectID carried as decimal text, never converted to float.
const _INSTANCE_ID: int = 6

# Patterns (the TypeScript regexes, spelled out as character classes).
const _PAT_SOURCE: int = 0 # [A-Za-z0-9._:-]{1,64}
const _PAT_KIND: int = 1 # [a-z][a-z0-9_]{0,31}
const _PAT_CODE: int = 2 # [A-Za-z0-9]{1,32}
const _PAT_CLASS: int = 3 # [A-Za-z_][A-Za-z0-9_]{0,63}

# A field is [name, type, min, max, required]; for _PATTERN `min` is the pattern, for _TEXT `max`
# is the byte limit.
const _MODIFIERS: Array = [
	["shift_pressed", _BOOL, 0, 0, false],
	["ctrl_pressed", _BOOL, 0, 0, false],
	["alt_pressed", _BOOL, 0, 0, false],
	["meta_pressed", _BOOL, 0, 0, false],
]
const _TARGET_FIELDS: Array = [
	["target", _INT, 0, MAX_TARGET_HANDLE, false],
	["local", _VEC2, -_MAX_COORD, _MAX_COORD, false],
	["frame", _INT, 0, _MAX_SAFE, false],
]

const _KEY: Array = [
	["physical_keycode", _INT, 0, _KEY_MAX, false],
	["keycode", _INT, 0, _KEY_MAX, false],
	["key_label", _INT, 0, _KEY_MAX, false],
	["unicode", _INT, 0, 0x10FFFF, false],
	["location", _INT, 0, 2, false],
	["pressed", _BOOL, 0, 0, true],
	["echo", _BOOL, 0, 0, false],
]
const _KEY_TAIL: Array = [["code", _PATTERN, _PAT_CODE, 0, false]]
const _JOYPAD_BUTTON: Array = [
	["device", _INT, 0, 15, false],
	["button_index", _INT, 0, 127, false],
	["pressed", _BOOL, 0, 0, true],
]
const _JOYPAD_MOTION: Array = [
	["device", _INT, 0, 15, false],
	["axis", _INT, 0, 9, false],
	["axis_value", _NUM, -1, 1, false],
]
const _MOUSE_BUTTON: Array = [
	["button_index", _INT, 1, 9, true],
	["pressed", _BOOL, 0, 0, true],
	["position", _VEC2, -_MAX_COORD, _MAX_COORD, true],
	["button_mask", _INT, 0, 511, false],
	["double_click", _BOOL, 0, 0, false],
	["canceled", _BOOL, 0, 0, false],
	["factor", _NUM, 0, 10000, false],
]
const _MOUSE_MOTION: Array = [
	["position", _VEC2, -_MAX_COORD, _MAX_COORD, true],
	["relative", _VEC2, -_MAX_COORD, _MAX_COORD, false],
	["button_mask", _INT, 0, 511, false],
	["pressure", _NUM, 0, 1, false],
	["tilt", _VEC2, -1, 1, false],
	["pen_inverted", _BOOL, 0, 0, false],
]
const _SCREEN_TOUCH: Array = [
	["index", _INT, 0, 31, false],
	["pressed", _BOOL, 0, 0, true],
	["position", _VEC2, -_MAX_COORD, _MAX_COORD, true],
	["canceled", _BOOL, 0, 0, false],
	["double_tap", _BOOL, 0, 0, false],
]
const _SCREEN_DRAG: Array = [
	["index", _INT, 0, 31, false],
	["position", _VEC2, -_MAX_COORD, _MAX_COORD, true],
	["relative", _VEC2, -_MAX_COORD, _MAX_COORD, false],
	["pressure", _NUM, 0, 1, false],
	["tilt", _VEC2, -1, 1, false],
	["pen_inverted", _BOOL, 0, 0, false],
]
const _MAGNIFY_GESTURE: Array = [
	["position", _VEC2, -_MAX_COORD, _MAX_COORD, true],
	["factor", _NUM, 0, 10000, false],
]
const _PAN_GESTURE: Array = [
	["position", _VEC2, -_MAX_COORD, _MAX_COORD, true],
	["delta", _VEC2, -_MAX_COORD, _MAX_COORD, false],
]
const _ACTION: Array = [
	["action", _TEXT, 0, 128, true],
	["pressed", _BOOL, 0, 0, true],
	["strength", _NUM, 0, 1, false],
]
const _TARGET: Array = [
	["handle", _INT, 1, MAX_TARGET_HANDLE, true],
	["path", _TEXT, 0, 1024, false],
	["scene", _TEXT, 0, 512, false],
	["class", _PATTERN, _PAT_CLASS, 0, false],
	["item", _INT, 0, _MAX_SAFE, false],
	["instance_id", _INSTANCE_ID, 0, 0, false],
]

const _EPOCH: Array = ["epoch", _INT, 0, _U32_MAX, true]
const _SEQ: Array = ["seq", _INT, 0, _MAX_SAFE, true]
const _REASON: Array = ["reason", _PATTERN, _PAT_SOURCE, 0, false]

const SCOPES: Array[String] = ["keyboard", "joypad", "pointer"]
const _WHEEL_FIRST: int = 4
const _WHEEL_LAST: int = 7

static var _record_fields: Dictionary = {}
static var _message_fields: Dictionary = {}
static var _held_kinds: Dictionary = {}


static func _tables() -> void:
	if not _record_fields.is_empty():
		return
	_record_fields = {
		"key": _KEY + _MODIFIERS + _KEY_TAIL,
		"joypad_button": _JOYPAD_BUTTON,
		"joypad_motion": _JOYPAD_MOTION,
		"mouse_button": _MOUSE_BUTTON + _MODIFIERS + _TARGET_FIELDS,
		"mouse_motion": _MOUSE_MOTION + _MODIFIERS + _TARGET_FIELDS,
		"screen_touch": _SCREEN_TOUCH + _TARGET_FIELDS,
		"screen_drag": _SCREEN_DRAG + _TARGET_FIELDS,
		"magnify_gesture": _MAGNIFY_GESTURE + _MODIFIERS,
		"pan_gesture": _PAN_GESTURE + _MODIFIERS,
		"action": _ACTION,
		"target": _TARGET,
	}
	_message_fields = {
		"hello": [["source", _PATTERN, _PAT_SOURCE, 0, true], _EPOCH, ["seq", _INT, 0, _MAX_SAFE, false]],
		"events": [_EPOCH, _SEQ],
		"sync": [_EPOCH, _SEQ],
		"reset": [_EPOCH, _SEQ, _REASON],
		"bye": [_EPOCH, _SEQ, _REASON],
		"heartbeat": [_EPOCH, _SEQ],
	}
	_held_kinds = {
		"keyboard": ["key"],
		"joypad": ["joypad_button", "joypad_motion"],
		"pointer": ["target", "mouse_button", "mouse_motion", "screen_touch"],
	}


## True when `kind` is a record kind gsw-input/1 knows.
static func is_known_kind(kind: String) -> bool:
	_tables()
	return _record_fields.has(kind)


## Parse and validate one message text: UTF-8 byte limit first, then JSON, then fields.
static func parse(text: String) -> Dictionary:
	if text.to_utf8_buffer().size() > MAX_MESSAGE_BYTES:
		return _fail("too-large", "", "message exceeds %d bytes" % MAX_MESSAGE_BYTES)
	var parsed: Array = GswInputJson.parse(text)
	var ok: bool = parsed[0]
	if not ok:
		return _fail("malformed", "", "not JSON")
	return validate(parsed[1])


## Validate an already-parsed JSON value (numbers may be float or int). It cannot see the text, so
## the byte limit is the caller's: use `parse` whenever the carrier hands you text.
static func validate(value: Variant) -> Dictionary:
	_tables()
	var checker := GswInputCodec.new()
	var message: Dictionary = checker._check_message(value)
	if checker._code != "":
		return _fail(checker._code, checker._path, checker._detail)
	return {"ok": true, "message": message, "skipped": checker._skipped}


static func _fail(code: String, path: String, detail: String) -> Dictionary:
	return {"ok": false, "code": code, "path": path, "detail": detail}


# The first failure; once set, every check returns early.
var _code: String = ""
var _path: String = ""
var _detail: String = ""
var _skipped: int = 0


func _reject(code: String, path: String, detail: String) -> void:
	if _code == "":
		_code = code
		_path = path
		_detail = detail


func _bad(path: String, detail: String) -> void:
	_reject("bad-field", path, detail)


static func _is_number(value: Variant) -> bool:
	var t: int = typeof(value)
	return t == TYPE_FLOAT or t == TYPE_INT


static func _finite_in(value: Variant, lo: float, hi: float) -> bool:
	if not _is_number(value):
		return false
	var number: float = value
	return is_finite(number) and number >= lo and number <= hi


static func _char_in(c: int, lower: bool, upper: bool, digit: bool, extra: String) -> bool:
	if lower and c >= 0x61 and c <= 0x7A:
		return true
	if upper and c >= 0x41 and c <= 0x5A:
		return true
	if digit and c >= 0x30 and c <= 0x39:
		return true
	return not extra.is_empty() and extra.contains(String.chr(c))


static func _matches(text: String, pattern: int) -> bool:
	var n: int = text.length()
	match pattern:
		_PAT_SOURCE:
			if n < 1 or n > 64:
				return false
			for i: int in n:
				if not _char_in(text.unicode_at(i), true, true, true, "._:-"):
					return false
			return true
		_PAT_KIND:
			if n < 1 or n > 32 or not _char_in(text.unicode_at(0), true, false, false, ""):
				return false
			for i: int in range(1, n):
				if not _char_in(text.unicode_at(i), true, false, true, "_"):
					return false
			return true
		_PAT_CODE:
			if n < 1 or n > 32:
				return false
			for i: int in n:
				if not _char_in(text.unicode_at(i), true, true, true, ""):
					return false
			return true
		_PAT_CLASS:
			if n < 1 or n > 64 or not _char_in(text.unicode_at(0), true, true, false, "_"):
				return false
			for i: int in range(1, n):
				if not _char_in(text.unicode_at(i), true, true, true, "_"):
					return false
			return true
	return false


static func _pattern_source(pattern: int) -> String:
	match pattern:
		_PAT_SOURCE:
			return "^[A-Za-z0-9._:-]{1,64}$"
		_PAT_KIND:
			return "^[a-z][a-z0-9_]{0,31}$"
		_PAT_CODE:
			return "^[A-Za-z0-9]{1,32}$"
	return "^[A-Za-z_][A-Za-z0-9_]{0,63}$"


static func _has_control(text: String) -> bool:
	for i: int in text.length():
		var c: int = text.unicode_at(i)
		if c < 0x20 or c == 0x7F:
			return true
	return false


static func _is_instance_id(value: Variant) -> bool:
	if typeof(value) != TYPE_STRING:
		return false
	var text: String = value
	var n: int = text.length()
	if n < 1 or n > 20 or text.unicode_at(0) == 0x30:
		return false
	for i: int in n:
		var c: int = text.unicode_at(i)
		if c < 0x30 or c > 0x39:
			return false
	return n < 20 or text <= "18446744073709551615"


## Check one present field; returns the value to keep.
func _check_field(value: Variant, field: Array, path: String) -> Variant:
	var type: int = field[1]
	var lo: int = field[2]
	var hi: int = field[3]
	match type:
		_INT:
			if not _finite_in(value, lo, hi):
				_bad(path, "integer %d..%d expected" % [lo, hi])
				return null
			var number: float = value
			if number != floorf(number):
				_bad(path, "integer %d..%d expected" % [lo, hi])
				return null
			var whole: int = int(number)
			return whole
		_NUM:
			if not _finite_in(value, lo, hi):
				_bad(path, "number %d..%d expected" % [lo, hi])
				return null
			var number: float = value
			return number
		_INSTANCE_ID:
			if not _is_instance_id(value):
				_bad(path, "nonzero u64 decimal string expected")
				return null
			return value
		_BOOL:
			if typeof(value) != TYPE_BOOL:
				_bad(path, "boolean expected")
				return null
			return value
		_VEC2:
			if typeof(value) != TYPE_ARRAY:
				_bad(path, "[x, y] with |v| <= %d expected" % hi)
				return null
			var pair: Array = value
			if pair.size() != 2 or not _finite_in(pair[0], lo, hi) or not _finite_in(pair[1], lo, hi):
				_bad(path, "[x, y] with |v| <= %d expected" % hi)
				return null
			var x: float = pair[0]
			var y: float = pair[1]
			return [x, y]
		_PATTERN:
			if typeof(value) != TYPE_STRING:
				_bad(path, "string matching %s expected" % _pattern_source(lo))
				return null
			var text: String = value
			if not _matches(text, lo):
				_bad(path, "string matching %s expected" % _pattern_source(lo))
				return null
			return text
		_TEXT:
			var ok: bool = typeof(value) == TYPE_STRING
			if ok:
				var text: String = value
				ok = not text.is_empty() and text.to_utf8_buffer().size() <= hi and not _has_control(text)
			if not ok:
				_bad(path, "string of 1..%d UTF-8 bytes without control characters expected" % hi)
				return null
			return value
	return null


## Check `fields` of `source` in table order, copying the present ones into `into`.
func _check_fields(source: Dictionary, fields: Array, prefix: String, into: Dictionary) -> void:
	for item: Variant in fields:
		var field: Array = item
		var name: String = field[0]
		var path: String = prefix + name
		if not source.has(name):
			var required: bool = field[4]
			if required:
				_bad(path, "required")
				return
			continue
		var checked: Variant = _check_field(source[name], field, path)
		if _code != "":
			return
		into[name] = checked


## Validate one record. Returns null for an unknown kind (skipped) or a failure (`_code` set).
func _check_record(value: Variant, path: String) -> Variant:
	if typeof(value) != TYPE_DICTIONARY:
		_bad(path, "object expected")
		return null
	var record: Dictionary = value
	var kind_value: Variant = record.get("event")
	if typeof(kind_value) != TYPE_STRING:
		_bad(path + ".event", "string expected")
		return null
	var kind: String = kind_value
	if not _record_fields.has(kind):
		return null
	var out: Dictionary = {"event": kind}
	var prefix: String = path + "."
	var fields: Array = _record_fields[kind]
	_check_fields(record, fields, prefix, out)
	if _code != "":
		return null

	# Cross-field rules, after every field passed, in this order.
	if kind == "key":
		if out.get("echo", false) == true and out.get("pressed") != true:
			_bad(prefix + "echo", "echo needs pressed: true")
			return null
		if out.get("physical_keycode", 0) == 0 and out.get("keycode", 0) == 0 and out.get("key_label", 0) == 0:
			_bad(prefix + "keycode", "one of physical_keycode, keycode, key_label must be nonzero")
			return null
	elif kind == "target":
		if out.has("scene") and not out.has("path"):
			_bad(prefix + "scene", "scene needs path")
			return null
		if not out.has("path") and not out.has("item"):
			_bad(prefix + "path", "a target needs path or item")
			return null
	elif out.has("target") or out.has("local") or out.has("frame"):
		var nonzero: bool = out.get("target", 0) != 0
		if (not out.has("local")) if nonzero else out.has("local"):
			_bad(prefix + "local", "local is required with a nonzero target and forbidden otherwise")
			return null
		if out.has("frame") and not out.has("target"):
			_bad(prefix + "frame", "frame needs target")
			return null
	return out


## sync: which known kinds a scope's `held` may list and what they must say.
func _check_held(record: Dictionary, scope: String, device: int, path: String) -> void:
	var kind: String = record["event"]
	var allowed: Array = _held_kinds[scope]
	if not allowed.has(kind):
		_bad(path + ".event", "%s is not held state of scope %s" % [kind, scope])
		return
	if record.has("pressed") and record["pressed"] != true:
		_bad(path + ".pressed", "held state is pressed: true")
		return
	if kind == "key" and record.get("echo", false) == true:
		_bad(path + ".echo", "held state is not an echo")
		return
	if scope == "joypad" and record.get("device", 0) != device:
		_bad(path + ".device", "held state must match the sync device")
		return
	if kind == "mouse_button":
		var button: int = record["button_index"]
		if button >= _WHEEL_FIRST and button <= _WHEEL_LAST:
			_bad(path + ".button_index", "a wheel button is never held")


func _check_records(value: Variant, path: String, min_count: int, scope: String, device: int) -> Array[Dictionary]:
	var records: Array[Dictionary] = []
	if typeof(value) != TYPE_ARRAY:
		_bad(path, "array expected")
		return records
	var items: Array = value
	if items.size() < min_count:
		_bad(path, "at least %d record expected" % min_count)
		return records
	if items.size() > MAX_EVENTS:
		_reject("too-many-events", path, "at most %d records" % MAX_EVENTS)
		return records
	for index: int in items.size():
		var item_path: String = "%s[%d]" % [path, index]
		var checked: Variant = _check_record(items[index], item_path)
		if _code != "":
			return records
		if checked == null:
			_skipped += 1
			continue
		var record: Dictionary = checked
		if scope != "":
			_check_held(record, scope, device, item_path)
			if _code != "":
				return records
		records.append(record)
	return records


func _check_message(value: Variant) -> Dictionary:
	var out: Dictionary = {}
	if typeof(value) != TYPE_DICTIONARY:
		_reject("malformed", "", "a JSON object expected")
		return out
	var message: Dictionary = value
	var type_value: Variant = message.get("type")
	if typeof(type_value) != TYPE_STRING:
		_reject("malformed", "", "type must be a string")
		return out
	var kind: String = type_value
	if not _message_fields.has(kind):
		_reject("unknown-type", "type", "unknown message type %s" % kind)
		return out
	out["type"] = kind

	if kind == "hello":
		if not message.has("format"):
			_bad("format", "required")
			return out
		if typeof(message["format"]) != TYPE_STRING:
			_bad("format", "string expected")
			return out
		var format: String = message["format"]
		if format != FORMAT:
			_reject("unsupported-format", "format", "format %s is not %s" % [format, FORMAT])
			return out
		out["format"] = FORMAT
	var fields: Array = _message_fields[kind]
	_check_fields(message, fields, "", out)
	if _code != "":
		return out

	if kind == "hello" and message.has("kinds"):
		var kinds_ok: bool = typeof(message["kinds"]) == TYPE_ARRAY
		var kinds: Array = message["kinds"] if kinds_ok else []
		if not kinds_ok or kinds.size() > MAX_KINDS:
			_bad("kinds", "array of at most %d kinds expected" % MAX_KINDS)
			return out
		var names: Array[String] = []
		for index: int in kinds.size():
			var name: Variant = kinds[index]
			var name_ok: bool = typeof(name) == TYPE_STRING
			if name_ok:
				var text: String = name
				name_ok = _matches(text, _PAT_KIND)
				names.append(text)
			if not name_ok:
				_bad("kinds[%d]" % index, "a record kind name expected")
				return out
		out["kinds"] = names
	elif kind == "events":
		if not message.has("events"):
			_bad("events", "required")
			return out
		out["events"] = _check_records(message["events"], "events", 1, "", -1)
	elif kind == "sync":
		if not message.has("scope"):
			_bad("scope", "required")
			return out
		var scope_value: Variant = message["scope"]
		if typeof(scope_value) != TYPE_STRING or not SCOPES.has(scope_value):
			_bad("scope", "one of keyboard, joypad, pointer expected")
			return out
		var scope: String = scope_value
		out["scope"] = scope
		var device: int = -1
		if scope == "joypad":
			if not message.has("device"):
				_bad("device", "required for joypad")
				return out
			var checked: Variant = _check_field(message["device"], ["device", _INT, 0, 15, true], "device")
			if _code != "":
				return out
			device = checked
			out["device"] = device
		elif message.has("device"):
			_bad("device", "only a joypad sync has a device")
			return out
		if not message.has("held"):
			_bad("held", "required")
			return out
		out["held"] = _check_records(message["held"], "held", 0, scope, device)
	return out
