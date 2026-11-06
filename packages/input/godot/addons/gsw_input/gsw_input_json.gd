class_name GswInputJson
extends RefCounted
## Strict JSON reader for gsw-input/1 (docs/input.md "Envelope"): the grammar of ECMAScript
## `JSON.parse` (RFC 8259), so the GDScript validator sees the same values the TypeScript codec
## does.
##
## Why not Godot's `JSON`: its number reader (`built_in_strtod`, core/string/ustring.cpp) is not
## correctly rounded -- `9007199254740991` (2^53-1, the largest legal `seq`) reads as 2^53 and
## would be rejected -- and it is more lenient than `JSON.parse` (any char <= 32 is whitespace,
## `01`, `1.` and `-` are numbers, raw control characters are allowed in strings) and refuses
## lone UTF-16 surrogates that `JSON.parse` keeps. This reader is iterative (no recursion limit,
## as in V8) and returns numbers as floats like Godot's: an integer literal of up to 18 digits is
## read exactly through `String.to_int()` and converted with round-to-nearest, which is what
## `JSON.parse` yields; a fraction or exponent goes through `String.to_float()` (exact to within
## an ulp, which no range check in gsw-input/1 can observe).
##
## Duplicate member names keep the last value, as `JSON.parse` does. A lone surrogate escape
## becomes U+FFFD: it is 3 UTF-8 bytes either way and matches none of the ASCII patterns, so no
## gsw-input/1 check can tell the two apart.

const _QUOTE: int = 0x22
const _BACKSLASH: int = 0x5C


static func _is_ws(c: int) -> bool:
	return c == 0x20 or c == 0x09 or c == 0x0A or c == 0x0D


static func _is_digit(c: int) -> bool:
	return c >= 0x30 and c <= 0x39


static func _hex(c: int) -> int:
	if c >= 0x30 and c <= 0x39:
		return c - 0x30
	if c >= 0x61 and c <= 0x66:
		return c - 0x61 + 10
	if c >= 0x41 and c <= 0x46:
		return c - 0x41 + 10
	return -1


## Parses `text`. Returns `[true, value]` or `[false, null]`. Objects are Dictionaries, arrays
## Arrays, numbers floats.
static func parse(text: String) -> Array:
	var reader := GswInputJson.new()
	var ok: bool = reader._run(text)
	return [ok, reader._root if ok else null]


var _text: String = ""
var _len: int = 0
var _pos: int = 0
var _root: Variant = null
## The value just read by `_read_string` / `_read_number`.
var _value: Variant = null


func _peek() -> int:
	return _text.unicode_at(_pos) if _pos < _len else -1


func _skip_ws() -> void:
	while _pos < _len and _is_ws(_text.unicode_at(_pos)):
		_pos += 1


func _run(text: String) -> bool:
	_text = text
	_len = text.length()
	_pos = 0
	# Containers being filled, and for each open object the key its next value belongs to.
	var stack: Array = []
	var keys: Array[String] = []
	_skip_ws()
	while true:
		# Read one value; a container is pushed and, unless empty, its first value read next.
		var value: Variant = null
		var c: int = _peek()
		if c == 0x7B: # {
			_pos += 1
			_skip_ws()
			if _peek() == 0x7D:
				_pos += 1
				value = {}
			else:
				if not _read_key():
					return false
				keys.append(_value)
				stack.append({})
				_skip_ws()
				continue
		elif c == 0x5B: # [
			_pos += 1
			_skip_ws()
			if _peek() == 0x5D:
				_pos += 1
				value = []
			else:
				stack.append([])
				continue
		elif c == _QUOTE:
			if not _read_string():
				return false
			value = _value
		elif c == 0x2D or _is_digit(c):
			if not _read_number():
				return false
			value = _value
		elif _text.substr(_pos, 4) == "true":
			_pos += 4
			value = true
		elif _text.substr(_pos, 5) == "false":
			_pos += 5
			value = false
		elif _text.substr(_pos, 4) == "null":
			_pos += 4
			value = null
		else:
			return false
		# Store the value, closing every container it completes.
		while true:
			if stack.is_empty():
				_skip_ws()
				_root = value
				return _pos == _len
			var top: Variant = stack.back()
			if top is Dictionary:
				var object: Dictionary = top
				object[keys.pop_back()] = value
			else:
				var array: Array = top
				array.append(value)
			_skip_ws()
			var next: int = _peek()
			var is_object: bool = top is Dictionary
			if next == 0x2C: # ,
				_pos += 1
				_skip_ws()
				if is_object:
					if not _read_key():
						return false
					keys.append(_value)
					_skip_ws()
				break
			if (is_object and next == 0x7D) or (not is_object and next == 0x5D):
				_pos += 1
				value = stack.pop_back()
				continue
			return false
	return false


## Reads `"key"` then `:`; the key lands in `_value`.
func _read_key() -> bool:
	if _peek() != _QUOTE or not _read_string():
		return false
	_skip_ws()
	if _peek() != 0x3A: # :
		return false
	_pos += 1
	_skip_ws()
	return true


func _read_string() -> bool:
	_pos += 1 # opening quote
	var out: String = ""
	var run_start: int = _pos
	while true:
		if _pos >= _len:
			return false
		var c: int = _text.unicode_at(_pos)
		if c == _QUOTE:
			out += _text.substr(run_start, _pos - run_start)
			_pos += 1
			_value = out
			return true
		if c < 0x20:
			return false
		if c != _BACKSLASH:
			_pos += 1
			continue
		out += _text.substr(run_start, _pos - run_start)
		if _pos + 1 >= _len:
			return false
		var e: int = _text.unicode_at(_pos + 1)
		_pos += 2
		match e:
			0x22, 0x5C, 0x2F:
				out += String.chr(e)
			0x62:
				out += "\b"
			0x66:
				out += "\f"
			0x6E:
				out += "\n"
			0x72:
				out += "\r"
			0x74:
				out += "\t"
			0x75:
				var unit: int = _read_hex4()
				if unit < 0:
					return false
				if unit >= 0xD800 and unit <= 0xDBFF and _text.substr(_pos, 2) == "\\u":
					var saved: int = _pos
					_pos += 2
					var low: int = _read_hex4()
					if low >= 0xDC00 and low <= 0xDFFF:
						out += String.chr(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00))
					else:
						# Not a pair: the high half is lone, the next escape is read on its own.
						_pos = saved
						out += String.chr(0xFFFD)
				elif unit >= 0xD800 and unit <= 0xDFFF:
					out += String.chr(0xFFFD)
				else:
					out += String.chr(unit)
			_:
				return false
		run_start = _pos
	return false


func _read_hex4() -> int:
	if _pos + 4 > _len:
		return -1
	var unit: int = 0
	for i: int in 4:
		var digit: int = _hex(_text.unicode_at(_pos + i))
		if digit < 0:
			return -1
		unit = unit * 16 + digit
	_pos += 4
	return unit


func _read_number() -> bool:
	var start: int = _pos
	var negative: bool = _peek() == 0x2D
	if negative:
		_pos += 1
	var int_start: int = _pos
	if _peek() == 0x30:
		_pos += 1
	elif _is_digit(_peek()):
		while _is_digit(_peek()):
			_pos += 1
	else:
		return false
	var int_digits: int = _pos - int_start
	var fraction: bool = false
	var mantissa_zero: bool = _text.substr(int_start, int_digits).lstrip("0").is_empty()
	if _peek() == 0x2E: # .
		_pos += 1
		if not _is_digit(_peek()):
			return false
		var frac_start: int = _pos
		while _is_digit(_peek()):
			_pos += 1
		fraction = true
		if not _text.substr(frac_start, _pos - frac_start).lstrip("0").is_empty():
			mantissa_zero = false
	var exponent: int = 0
	var has_exponent: bool = false
	var c: int = _peek()
	if c == 0x65 or c == 0x45: # e E
		_pos += 1
		var exp_negative: bool = false
		if _peek() == 0x2B or _peek() == 0x2D:
			exp_negative = _peek() == 0x2D
			_pos += 1
		if not _is_digit(_peek()):
			return false
		var exp_start: int = _pos
		while _is_digit(_peek()):
			_pos += 1
		has_exponent = true
		# Clamp before converting: only the magnitude class matters past 400.
		var exp_text: String = _text.substr(exp_start, _pos - exp_start).lstrip("0")
		exponent = 9999 if exp_text.length() > 4 else (exp_text.to_int() if not exp_text.is_empty() else 0)
		if exp_negative:
			exponent = -exponent
	var literal: String = _text.substr(start, _pos - start)
	if not fraction and not has_exponent and int_digits <= 18:
		var exact: int = literal.to_int()
		_value = float(exact)
	elif mantissa_zero:
		_value = -0.0 if negative else 0.0
	elif exponent > 400:
		# Beyond any double; `String.to_float()` would warn "Exponent too high".
		_value = -INF if negative else INF
	elif exponent < -400:
		_value = -0.0 if negative else 0.0
	else:
		_value = literal.to_float()
	return true
