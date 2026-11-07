extends SceneTree
## GswInputJson reads what ECMAScript `JSON.parse` reads, where Godot's own `JSON` does not:
## exact integers up to 2^53-1, out-of-range exponents, lone surrogates, strict grammar, no depth
## limit. Expectations come from `JSON.parse` (Node 24).
##
## Prints "[json-selftest] ok N checks" and quits 0, or prints each failure and quits 1.

const TAG: String = "[json-selftest]"

var _checks: int = 0
var _failures: int = 0


func _expect(name: String, ok: Variant, detail: String = "") -> void:
	_checks += 1
	if ok != true:
		_failures += 1
		print("%s FAIL: %s %s" % [TAG, name, detail])


func _value(text: String) -> Variant:
	var parsed: Array = GswInputJson.parse(text)
	_expect("parses: %s" % text.c_escape(), parsed[0])
	return parsed[1]


func _initialize() -> void:
	var a: Dictionary = _value('{"a":9007199254740991}')
	var safe: float = a["a"]
	_expect("2^53-1 is exact (Godot's JSON reads 2^53)", safe == float(9007199254740991) and safe != float(9007199254740992))
	var extremes: Array = _value("[1e400,-1e999,1e-400]")
	var big: float = extremes[0]
	var small: float = extremes[1]
	var tiny: float = extremes[2]
	_expect("1e400 is +inf, -1e999 is -inf, 1e-400 is 0", big == INF and small == -INF and tiny == 0.0)
	_expect("a surrogate pair is one code point", _value('"\\ud83d\\ude00"') == String.chr(0x1F600))
	_expect("a lone high surrogate is U+FFFD", _value('"\\ud800"') == String.chr(0xFFFD))
	_expect("a high surrogate before a non-low escape", _value('"\\ud800\\u0041"') == String.chr(0xFFFD) + "A")
	_expect("duplicate members keep the last", _value('{"a":1,"a":2}') == {"a": 2.0})
	_expect("-0 is zero", _value("-0") == 0.0)
	var fraction: float = _value("0.5e-1")
	_expect("exponents", _value("1E2") == 100.0 and is_equal_approx(fraction, 0.05))
	_expect("JSON whitespace", _value(" \t\n\r[ 1 , 2 ] ") == [1.0, 2.0])
	_expect("escapes", _value('"\\/\\b\\f\\n\\r\\t\\\\\\""') == "/\b\f\n\r\t\\\"")
	_expect("empty containers", _value('{"a":{},"b":[[]]}') == {"a": {}, "b": [[]]})
	_expect("numbers are floats", typeof(_value("87")) == TYPE_FLOAT)
	var deep: String = '{"type":"heartbeat","epoch":1,"seq":1,"x":%s%s}' % ["[".repeat(2000), "]".repeat(2000)]
	var deep_result: Dictionary = GswInputCodec.parse(deep)
	_expect("2000-deep nesting is a valid message (Godot's JSON stops at 1024)", deep_result["ok"])

	var invalid: Array[String] = [
		"01", "1.", "-", ".5", "+1", "-01", "1e", "1e+", "[1,]", '{"a":1,}', '"a%sb"' % String.chr(1),
		"{'a':1}", "tru", "nul", "[1]x", "%s1" % String.chr(0xA0), "%s1" % String.chr(0x0C), '"\\x"',
		'"\\u12"', "", '{"a" 1}', "[1 2]", "NaN", "Infinity", '{"a":1', '"abc',
	]
	for text: String in invalid:
		var parsed: Array = GswInputJson.parse(text)
		_expect("rejects: %s" % text.c_escape(), not parsed[0])

	if _failures == 0:
		print("%s ok %d checks" % [TAG, _checks])
	quit(1 if _failures > 0 else 0)
