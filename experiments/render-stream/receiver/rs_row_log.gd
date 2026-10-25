class_name RsRowLog
extends RefCounted
## P3-HX: an append-only list of evidence rows (Dictionaries) kept as var_to_bytes() blobs in one
## PackedByteArray instead of as live Dictionaries, plus the report writer that streams them.
##
## receiver.gd's `fetches`, `uploads` and `mesh_uploads` evidence grows with every transaction. As
## Dictionaries each row costs about 2 KB (STS2 spine churn: 100 fetch rows and 200 mesh rows per
## transaction, 2.1 GB of the 3.6 GB RSS after 4,960 transactions); as bytes a row is 0.2-0.4 KB.
## A row decodes to an equal Dictionary (same keys in the same order, same value types), so
## applied.json is byte for byte what it was.
##
## write_report_json() writes the report with JSON.stringify's own layout (indent "  ", keys in
## insertion order, `JSON.stringify(report, "  ", false) + "\n"`), one row at a time for the logs,
## so the whole report is never one String either (Godot Strings are UTF-32: a 237 MB applied.json
## is a 1 GB String).

var _bytes: PackedByteArray = PackedByteArray()
var _ends: PackedInt64Array = PackedInt64Array()


func append(row: Dictionary) -> void:
	_bytes.append_array(var_to_bytes(row))
	_ends.append(_bytes.size())


func size() -> int:
	return _ends.size()


## The i-th row, decoded.
func at(index: int) -> Dictionary:
	var start: int = 0 if index == 0 else _ends[index - 1]
	var value: Variant = bytes_to_var(_bytes.slice(start, _ends[index]))
	var row: Dictionary = value
	return row


## Every row as an Array (a test aid; the report writer streams instead).
func to_array() -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for index: int in size():
		out.append(at(index))
	return out


## `value` as JSON.stringify(value, "  ", false) would write it nested one level deep (every line
## after the first indented by `pad`).
static func _nested(value: Variant, pad: String) -> String:
	# An empty Dictionary prints as "{\n\n<indent>}": its blank line stays blank.
	return JSON.stringify(value, "  ", false).replace("\n", "\n" + pad).replace("\n" + pad + "\n", "\n\n")


func _write_array(file: FileAccess, pad: String) -> void:
	if size() == 0:
		file.store_string("[]")
		return
	var inner: String = pad + "  "
	file.store_string("[")
	for index: int in size():
		file.store_string(("\n" if index == 0 else ",\n") + inner + _nested(at(index), inner))
	file.store_string("\n" + pad + "]")


## Writes `JSON.stringify(report, "  ", false) + "\n"` to `file`, with any RsRowLog value written
## row by row. `report` is a Dictionary of Variants (RsRowLog values allowed at the top level).
static func write_report_json(file: FileAccess, report: Dictionary) -> void:
	if report.is_empty():
		file.store_string(JSON.stringify(report, "  ", false) + "\n")
		return
	file.store_string("{")
	var first: bool = true
	for key: Variant in report:
		file.store_string(("\n" if first else ",\n") + "  " + JSON.stringify(key) + ": ")
		first = false
		var value: Variant = report[key]
		if value is RsRowLog:
			var log: RsRowLog = value
			log._write_array(file, "  ")
		else:
			file.store_string(_nested(value, "  "))
	file.store_string("\n}\n")
