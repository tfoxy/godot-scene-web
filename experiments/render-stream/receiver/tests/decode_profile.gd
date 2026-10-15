extends SceneTree
## Receiver decode profile (2026-10-14): where `RsApplier.accept_record`'s per-transaction time
## goes -- the `decode_us` histogram of RS_RECEIVER_PERF_OUT. A benchmark, not a self-test: it
## changes nothing in the receiver and calls the production functions themselves (rs2_decoder.gd's
## static helpers and `Stream` methods). Only three short loops are replicas, marked below.
##
##   RS_PROFILE_RECORDING  absolute path of a render-stream/6 recording (full or patch sink)
##   RS_PROFILE_REPEATS    timed passes after one warmup pass (default 5)
##   RS_PROFILE_OUT        optional absolute path for the JSON result
##   RS_PROFILE_OP_SAMPLE  every Nth transaction is used for the per-op pass (default 10)
##   RS_PROFILE_STORE_DIR  the capture's resource store: enables pass 5 (apply)
##   RS_PROFILE_CACHE_DIR  an empty scratch directory for pass 5's fresh caches (one per repeat)
##   RS_PROFILE_PASSES     comma list of passes to run (default all: production,stages,per_op,
##                         candidates,apply)
##
## Passes, each over every transaction record, one warmup plus RS_PROFILE_REPEATS timed:
##   1. production: `RsApplier.accept_record` alone, exactly as receiver.gd times decode_us.
##   2. stages: the same work split into decode_record's steps (frame, record sha256, meta slice
##      and ASCII check, JSON.parse, Schema.transaction, block conversion) and Stream.accept's
##      (id lists and ordering, patch rules, offset walks, lifting, the real accept, then
##      _check_resolved_invariants on the state accept just resolved). Read-only pieces run
##      against the same Stream the real accept advances, so they see the state it saw.
##   3. per op: Schema.transaction, _lift_item and JSON.parse on copies of sampled metas whose
##      commands keep one op only, minus the same with no commands -- microseconds per command.
##   4. candidate: add_triangle_array lifted to packed arrays by the engine's own conversions
##      (PackedByteArray.to_vector2_array/to_color_array, PackedInt32Array.slice) against
##      production _lift_item's per-vertex Arrays, per command (a G7o tier-1 candidate).
##   5. apply: per transaction, accept_record, then needed() and the cache's obtain() for what
##      it names, then apply_state() on an instrumented copy of rs_applier.gd compiled at run time
##      (the production source with `_prof_mark()` lines inserted at apply_state()'s own numbered
##      steps, nothing else changed), so each step's time is attributed. Headless: the dummy
##      rasterizer, so RenderingServer's CPU-side command recording is in the numbers and GPU
##      uploads are not.
##
## Each stage's per-transaction value is the median over the timed repeats; tables report the
## mean over transactions (and p50). Run pinned to one core on a release template:
##   taskset -c 11 <linux_release.x86_64> --headless --path experiments/render-stream/receiver \
##     --script res://tests/decode_profile.gd

const DECODE_STAGES: Array[String] = [
	"frame", "record_sha256", "meta_ascii", "json_parse", "schema", "blocks",
]
const ACCEPT_STAGES: Array[String] = [
	"id_lists_order", "patch_rules", "offset_walks", "lift", "accept_rest", "resolved_invariants",
]

var _data: PackedByteArray
var _tx_offsets: Array[int] = []
var _session_offset: int = 8
var _repeats: int = 5
var _op_sample: int = 10
var _store_dir: String = ""
var _cache_dir: String = ""
var _passes: PackedStringArray = PackedStringArray(["production", "stages", "per_op", "candidates", "apply"])

## apply_state()'s steps, in order: each name is the time since the previous mark.
const APPLY_MARKS: Array[String] = [
	"textures", "meshes", "shaders_materials", "defaults_order", "free_vanished", "create",
	"canvases", "parent_pass", "order_pass", "item_setters", "content_replay", "root_canvas",
]


func _initialize() -> void:
	var path: String = OS.get_environment("RS_PROFILE_RECORDING")
	var out_path: String = OS.get_environment("RS_PROFILE_OUT")
	var repeats_text: String = OS.get_environment("RS_PROFILE_REPEATS")
	if repeats_text != "":
		_repeats = maxi(1, repeats_text.to_int())
	var sample_text: String = OS.get_environment("RS_PROFILE_OP_SAMPLE")
	if sample_text != "":
		_op_sample = maxi(1, sample_text.to_int())
	_store_dir = OS.get_environment("RS_PROFILE_STORE_DIR")
	_cache_dir = OS.get_environment("RS_PROFILE_CACHE_DIR")
	var passes_text: String = OS.get_environment("RS_PROFILE_PASSES")
	if passes_text != "":
		_passes = passes_text.split(",")
	if path == "" or not FileAccess.file_exists(path):
		printerr("[decode-profile] RS_PROFILE_RECORDING must name a recording (got %s)" % JSON.stringify(path))
		quit(2)
		return
	_data = FileAccess.get_file_as_bytes(path)
	var split: Dictionary = Rs2Decoder.split_records(_data)
	var split_errors: PackedStringArray = split["errors"]
	if split_errors.size() > 0:
		printerr("[decode-profile] %s" % split_errors[0])
		quit(2)
		return
	var records: Array[Dictionary] = split["records"]
	for raw: Dictionary in records:
		var offset: int = Rs2Decoder.as_int(raw["offset"])
		var probe: Dictionary = Rs2Decoder.decode_record(_data, offset)
		var meta: Dictionary = probe["meta"]
		if meta.get("type") == "transaction":
			_tx_offsets.append(offset)
		elif meta.get("type") == "resource":
			printerr("[decode-profile] resource records are not profiled (offset %d)" % offset)
	_session_offset = Rs2Decoder.as_int(records[0]["offset"])
	print("[decode-profile] %s: %d bytes, %d records, %d transactions, %d repeats" % [path, _data.size(), records.size(), _tx_offsets.size(), _repeats])

	var counts: Dictionary = _counts()
	var production: Dictionary = _production_pass() if _passes.has("production") else {}
	var stages: Dictionary = _stage_pass() if _passes.has("stages") else {}
	var per_op: Dictionary = _per_op_pass() if _passes.has("per_op") else {}
	var floor_us: Dictionary = _floors()
	var candidates: Dictionary = _candidate_pass() if _passes.has("candidates") else {}
	var apply: Dictionary = {}
	if _passes.has("apply") and _store_dir != "" and _cache_dir != "":
		apply = _apply_pass()
	var result: Dictionary = {
		"schema": "receiver-decode-profile/1", "recording": path, "bytes": _data.size(),
		"transactions": _tx_offsets.size(), "repeats": _repeats,
		"engine": Engine.get_version_info()["string"], "debug_build": OS.is_debug_build(),
		"counts": counts, "production": production, "stages": stages, "per_op": per_op,
		"floors": floor_us, "candidates": candidates, "apply": apply,
	}
	_print_report(result)
	if out_path != "":
		var file := FileAccess.open(out_path, FileAccess.WRITE)
		file.store_string(JSON.stringify(result, "  ", false))
		file.close()
		print("[decode-profile] wrote %s" % out_path)
	quit(0)


# ----------------------------------------------------------------------------------- statistics


static func _median(values: PackedInt64Array) -> float:
	var sorted := values.duplicate()
	sorted.sort()
	var n: int = sorted.size()
	if n == 0:
		return 0.0
	if n % 2 == 1:
		return float(sorted[n / 2])
	return (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0


static func _medianf(values: PackedFloat64Array) -> float:
	var sorted := values.duplicate()
	sorted.sort()
	var n: int = sorted.size()
	if n == 0:
		return 0.0
	if n % 2 == 1:
		return sorted[n / 2]
	return (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0


## samples[tx] = Array of the timed repeats' ints -> {mean, p50, p95} over per-tx medians.
## (Plain Arrays, not packed ones: a packed array read out of an Array is a copy-on-write value,
## so appending to it in place would be lost.)
static func _summary(samples: Array[Array]) -> Dictionary:
	var per_tx := PackedFloat64Array()
	for s: Array in samples:
		per_tx.append(_median(PackedInt64Array(s)))
	var total: float = 0.0
	for v: float in per_tx:
		total += v
	var sorted := per_tx.duplicate()
	sorted.sort()
	var p95: float = sorted[mini(sorted.size() - 1, int(sorted.size() * 0.95))] if sorted.size() > 0 else 0.0
	return {"mean_us": total / maxf(1.0, per_tx.size()), "p50_us": _medianf(per_tx), "p95_us": p95}


func _new_samples() -> Array[Array]:
	var out: Array[Array] = []
	for i: int in _tx_offsets.size():
		out.append([])
	return out


func _fresh_stream() -> Rs2Decoder.Stream:
	var stream := Rs2Decoder.Stream.new()
	var session: Dictionary = Rs2Decoder.decode_record(_data, _session_offset)
	var errors: PackedStringArray = stream.accept(_data, session)
	assert(errors.is_empty())
	return stream


# ----------------------------------------------------------------------------------- counts


func _counts() -> Dictionary:
	var stream := _fresh_stream()
	var ops: Dictionary = {}
	var op_floats: Dictionary = {}
	var sums: Dictionary = {
		"record_bytes": 0, "meta_bytes": 0, "item_f32_bytes": 0, "canvas_f32_bytes": 0,
		"cmd_f32_bytes": 0, "cmd_i32_bytes": 0, "mesh_f32_bytes": 0, "param_f64_bytes": 0,
		"items": 0, "items_with_commands": 0, "commands": 0, "canvases": 0, "textures": 0,
		"meshes": 0, "shaders": 0, "materials": 0, "unsupported": 0, "resolved_items": 0,
		"resolved_commands": 0, "resolved_textures": 0, "full": 0, "patch": 0,
	}
	var block_keys: Array[String] = ["item_f32_bytes", "canvas_f32_bytes", "cmd_f32_bytes", "cmd_i32_bytes", "mesh_f32_bytes", "param_f64_bytes"]
	for offset: int in _tx_offsets:
		var record: Dictionary = Rs2Decoder.decode_record(_data, offset)
		var frame: Dictionary = Rs2Decoder._frame(_data, offset)
		var meta: Dictionary = record["meta"]
		sums["record_bytes"] += Rs2Decoder.as_int(record["byte_length"])
		sums["meta_bytes"] += Rs2Decoder.as_int(frame["meta_len"])
		var spans: Array = frame["blocks"]
		for i: int in mini(spans.size(), block_keys.size()):
			var span: Array = spans[i]
			sums[block_keys[i]] += Rs2Decoder.as_int(span[1])
		var encoding: String = meta["encoding"]
		sums[encoding] += 1
		var items_meta: Array = meta["items"]
		sums["items"] += items_meta.size()
		for value: Variant in items_meta:
			var item: Dictionary = value
			if item["commands"] == null:
				continue
			sums["items_with_commands"] += 1
			var commands: Array = item["commands"]
			sums["commands"] += commands.size()
			for cvalue: Variant in commands:
				var command: Dictionary = cvalue
				var op: String = command["op"]
				ops[op] = Rs2Decoder.as_int(ops.get(op, 0)) + 1
				op_floats[op] = Rs2Decoder.as_int(op_floats.get(op, 0)) + Rs2Decoder._command_float_count(command)
		for key: String in ["canvases", "textures", "meshes", "shaders", "materials", "unsupported"]:
			var list: Array = meta[key]
			sums[key] += list.size()
		var errors: PackedStringArray = stream.accept(_data, record)
		assert(errors.is_empty())
		sums["resolved_items"] += stream.items.size()
		sums["resolved_textures"] += stream.textures.size()
		for id: int in stream.items:
			var resolved: Dictionary = stream.items[id]
			var resolved_commands: Array = resolved["commands"]
			sums["resolved_commands"] += resolved_commands.size()
	var n: float = maxf(1.0, _tx_offsets.size())
	var per_tx: Dictionary = {}
	for key: String in sums:
		per_tx[key] = Rs2Decoder.as_int(sums[key]) / n
	var ops_per_tx: Dictionary = {}
	for op: String in ops:
		ops_per_tx[op] = {"per_tx": Rs2Decoder.as_int(ops[op]) / n, "floats_per_cmd": Rs2Decoder.as_int(op_floats[op]) / maxf(1.0, Rs2Decoder.as_int(ops[op]))}
	return {"per_tx": per_tx, "ops": ops_per_tx}


# ----------------------------------------------------------------------------------- pass 1


func _production_pass() -> Dictionary:
	var samples: Array[Array] = _new_samples()
	for repeat: int in _repeats + 1:
		var stream := _fresh_stream()
		for i: int in _tx_offsets.size():
			var t0: int = Time.get_ticks_usec()
			var result: Dictionary = RsApplier.accept_record(_data, _tx_offsets[i], stream)
			var t1: int = Time.get_ticks_usec()
			var errors: PackedStringArray = result["errors"]
			assert(errors.is_empty())
			if repeat > 0:
				var tx_samples: Array = samples[i]
				tx_samples.append(t1 - t0)
	return {"accept_record": _summary(samples)}


# ----------------------------------------------------------------------------------- pass 2


func _stage_pass() -> Dictionary:
	var names: Array[String] = []
	names.append_array(DECODE_STAGES)
	names.append("decode_record")
	names.append_array(ACCEPT_STAGES)
	names.append("accept")
	var samples: Dictionary = {}
	for name: String in names:
		samples[name] = _new_samples()
	for repeat: int in _repeats + 1:
		var stream := _fresh_stream()
		for i: int in _tx_offsets.size():
			var times: Dictionary = _stage_one(stream, _tx_offsets[i])
			if repeat > 0:
				for name: String in names:
					var list: Array[Array] = samples[name]
					var tx_samples: Array = list[i]
					tx_samples.append(Rs2Decoder.as_int(times[name]))
	var out: Dictionary = {}
	for name: String in names:
		var list: Array[Array] = samples[name]
		out[name] = _summary(list)
	return out


func _stage_one(stream: Rs2Decoder.Stream, offset: int) -> Dictionary:
	var times: Dictionary = {}
	# --- decode_record's steps, in its order, with its own calls.
	var t: int = Time.get_ticks_usec()
	var frame: Dictionary = Rs2Decoder._frame(_data, offset)
	var end: int = frame["end"]
	times["frame"] = Time.get_ticks_usec() - t

	t = Time.get_ticks_usec()
	var digest: String = Rs2Decoder.sha256_hex(_data.slice(offset, end))
	times["record_sha256"] = Time.get_ticks_usec() - t

	t = Time.get_ticks_usec()
	var meta_start: int = frame["meta_start"]
	var meta_len: int = frame["meta_len"]
	var meta_bytes: PackedByteArray = _data.slice(meta_start, meta_start + meta_len)
	var meta_text: String = meta_bytes.get_string_from_ascii()
	var bad_ascii: bool = meta_text.length() != meta_bytes.size() or Rs2Decoder._non_printable().search(meta_text) != null
	times["meta_ascii"] = Time.get_ticks_usec() - t
	assert(not bad_ascii and digest.length() == 64)

	t = Time.get_ticks_usec()
	var json := JSON.new()
	var parse_error: Error = json.parse(meta_text)
	var parsed_meta: Dictionary = json.data
	times["json_parse"] = Time.get_ticks_usec() - t
	assert(parse_error == OK)

	t = Time.get_ticks_usec()
	var check := Rs2Decoder.Schema.new("record at offset %d" % offset)
	check.transaction(parsed_meta, stream.version)
	times["schema"] = Time.get_ticks_usec() - t
	assert(check.ok)

	t = Time.get_ticks_usec()
	var declared: Array = parsed_meta["blocks"]
	var spans: Array = frame["blocks"]
	var blocks: Array = []
	for b: int in spans.size():
		var span: Array = spans[b]
		var entry: Dictionary = declared[b]
		var start: int = span[0]
		var length: int = span[1]
		var block_type: String = entry["type"]
		if block_type == "f32":
			blocks.append(_data.slice(start, start + length).to_float32_array())
		elif block_type == "i32":
			blocks.append(_data.slice(start, start + length).to_int32_array())
		elif block_type == "f64":
			blocks.append(_data.slice(start, start + length).to_float64_array())
		else:
			blocks.append({"u8_bytes": length, "sha256": Rs2Decoder.sha256_hex(_data.slice(start, start + length))})
	times["blocks"] = Time.get_ticks_usec() - t

	# The production decode_record, timed whole (its sum check against the six steps above).
	t = Time.get_ticks_usec()
	var record: Dictionary = Rs2Decoder.decode_record(_data, offset, stream.version)
	times["decode_record"] = Time.get_ticks_usec() - t
	var meta: Dictionary = record["meta"]

	# --- Stream._accept_transaction's pieces, before the real accept (read-only on its state).
	t = Time.get_ticks_usec()
	var seq: int = Rs2Decoder.as_int(meta["seq"])
	var canvases_meta: Array = meta["canvases"]
	var items_meta: Array = meta["items"]
	var textures_meta: Array = meta["textures"]
	var meshes_meta: Array = meta["meshes"]
	var shaders_meta: Array = meta["shaders"]
	var materials_meta: Array = meta["materials"]
	var removed_canvases: Array[int] = Rs2Decoder.int_list(meta["removed_canvases"])
	var removed_items: Array[int] = Rs2Decoder.int_list(meta["removed_items"])
	var removed_textures: Array[int] = Rs2Decoder.int_list(meta["removed_textures"])
	var removed_meshes: Array[int] = Rs2Decoder.int_list(meta["removed_meshes"])
	var removed_shaders: Array[int] = Rs2Decoder.int_list(meta["removed_shaders"])
	var removed_materials: Array[int] = Rs2Decoder.int_list(meta["removed_materials"])
	var removed: Dictionary = {
		"removed_canvases": removed_canvases, "removed_items": removed_items,
		"removed_textures": removed_textures, "removed_meshes": removed_meshes,
		"removed_shaders": removed_shaders, "removed_materials": removed_materials,
	}
	var order_errors: String = ""
	order_errors += Rs2Decoder._check_id_ordering("canvases", canvases_meta, seq)
	order_errors += Rs2Decoder._check_id_ordering("items", items_meta, seq)
	order_errors += Rs2Decoder._check_id_ordering("textures", textures_meta, seq)
	order_errors += Rs2Decoder._check_id_ordering("meshes", meshes_meta, seq)
	order_errors += Rs2Decoder._check_id_ordering("shaders", shaders_meta, seq)
	order_errors += Rs2Decoder._check_id_ordering("materials", materials_meta, seq)
	for key: String in removed:
		var ids: Array[int] = removed[key]
		order_errors += Rs2Decoder._check_id_list_ascending(key, ids, seq)
	times["id_lists_order"] = Time.get_ticks_usec() - t
	assert(order_errors == "")

	t = Time.get_ticks_usec()
	var encoding: String = meta["encoding"]
	var patch_error: String = stream._check_patch_rules(encoding, seq, meta, removed_canvases, removed_items, removed_textures, removed_meshes, removed_shaders, removed_materials, canvases_meta, items_meta, textures_meta, meshes_meta, shaders_meta, materials_meta, true, true)
	times["patch_rules"] = Time.get_ticks_usec() - t
	assert(patch_error == "")

	# Replica of _accept_transaction's cmd-offset / mesh-offset walk (param-offset is empty on
	# gate6-scene: no materials).
	t = Time.get_ticks_usec()
	var running: int = 0
	var running_int: int = 0
	for value: Variant in items_meta:
		var item: Dictionary = value
		if item["commands"] == null:
			continue
		var commands: Array = item["commands"]
		for cvalue: Variant in commands:
			var command: Dictionary = cvalue
			var cmd_op: String = command["op"]
			if cmd_op == "unsupported" or cmd_op == "add_clip_ignore":
				continue
			var fcount: int = Rs2Decoder._command_float_count(command)
			var f: int = Rs2Decoder.as_int(command["f"])
			assert(f == running)
			running += fcount
			if cmd_op == "add_triangle_array":
				running_int += Rs2Decoder._command_int_count(command)
	var running_mesh: int = 0
	for value: Variant in meshes_meta:
		var m: Dictionary = value
		if m["f"] != null:
			running_mesh += 6
	times["offset_walks"] = Time.get_ticks_usec() - t

	# Replica of the lifting loop (the production static _lift_* functions, discarded results).
	t = Time.get_ticks_usec()
	var record_blocks: Array = record["blocks"]
	var item_f32: PackedFloat32Array = record_blocks[0]
	var canvas_f32: PackedFloat32Array = record_blocks[1]
	var cmd_f32: PackedFloat32Array = record_blocks[2]
	var cmd_i32: PackedInt32Array = record_blocks[3]
	var mesh_f32: PackedFloat32Array = record_blocks[4]
	var param_f64: PackedFloat64Array = record_blocks[5]
	var lifted_any: int = 0
	for c: int in canvases_meta.size():
		var canvas: Dictionary = canvases_meta[c]
		lifted_any += Rs2Decoder._lift_canvas(canvas, canvas_f32.slice(c * 10, (c + 1) * 10)).size()
	for value: Variant in materials_meta:
		var mat: Dictionary = value
		lifted_any += Rs2Decoder._lift_material(mat, param_f64).size()
	for k: int in items_meta.size():
		var item2: Dictionary = items_meta[k]
		lifted_any += Rs2Decoder._lift_item(item2, item_f32.slice(k * Rs2Decoder.ITEM_FLOATS, (k + 1) * Rs2Decoder.ITEM_FLOATS), cmd_f32, cmd_i32, param_f64).size()
	for value: Variant in meshes_meta:
		var m2: Dictionary = value
		lifted_any += Rs2Decoder._lift_mesh(m2, mesh_f32).size()
	for value: Variant in shaders_meta:
		var sh: Dictionary = value
		lifted_any += Rs2Decoder._lift_shader(sh).size()
	times["lift"] = Time.get_ticks_usec() - t
	assert(lifted_any >= 0 and running_int >= 0 and running_mesh >= 0)

	# --- The real accept (it repeats all of the above plus the rest), then the invariant pass it
	# ran, re-run on the identical resolved state it left.
	t = Time.get_ticks_usec()
	var errors: PackedStringArray = stream.accept(_data, record)
	times["accept"] = Time.get_ticks_usec() - t
	assert(errors.is_empty())

	t = Time.get_ticks_usec()
	var unsupported_meta: Array = meta["unsupported"]
	var invariant_error: String = stream._check_resolved_invariants(seq, unsupported_meta, true, true)
	times["resolved_invariants"] = Time.get_ticks_usec() - t
	assert(invariant_error == "")

	var measured: int = 0
	for name: String in ["id_lists_order", "patch_rules", "offset_walks", "lift", "resolved_invariants"]:
		measured += Rs2Decoder.as_int(times[name])
	times["accept_rest"] = maxi(0, Rs2Decoder.as_int(times["accept"]) - measured)
	return times


# ----------------------------------------------------------------------------------- pass 3


## A copy of `meta` whose items with commands keep only `op` ("" keeps none).
static func _filtered(meta: Dictionary, op: String) -> Dictionary:
	var copy: Dictionary = meta.duplicate(true)
	var items: Array = copy["items"]
	for value: Variant in items:
		var item: Dictionary = value
		if item["commands"] == null:
			continue
		var kept: Array = []
		if op != "":
			var commands: Array = item["commands"]
			for cvalue: Variant in commands:
				var command: Dictionary = cvalue
				if command["op"] == op:
					kept.append(command)
		item["commands"] = kept
	return copy


func _per_op_pass() -> Dictionary:
	var sampled: Array[Dictionary] = []
	var blocks_of: Array[Array] = []
	var ops: Dictionary = {}
	for i: int in range(0, _tx_offsets.size(), _op_sample):
		var record: Dictionary = Rs2Decoder.decode_record(_data, _tx_offsets[i])
		var meta: Dictionary = record["meta"]
		sampled.append(meta)
		blocks_of.append(record["blocks"])
		var items_meta: Array = meta["items"]
		for value: Variant in items_meta:
			var item: Dictionary = value
			if item["commands"] == null:
				continue
			var commands: Array = item["commands"]
			for cvalue: Variant in commands:
				var command: Dictionary = cvalue
				var op: String = command["op"]
				ops[op] = Rs2Decoder.as_int(ops.get(op, 0)) + 1
	var variants: Array[String] = [""]
	for op: String in ops:
		variants.append(op)
	var cost: Dictionary = {}
	for variant: String in variants:
		var schema_samples := PackedInt64Array()
		var lift_samples := PackedInt64Array()
		var json_samples := PackedInt64Array()
		var metas: Array[Dictionary] = []
		var texts: Array[String] = []
		for meta: Dictionary in sampled:
			var copy: Dictionary = _filtered(meta, variant)
			metas.append(copy)
			texts.append(JSON.stringify(copy, "", false))
		var text_bytes: int = 0
		for text: String in texts:
			text_bytes += text.length()
		for repeat: int in _repeats + 1:
			var schema_us: int = 0
			var lift_us: int = 0
			var json_us: int = 0
			for s: int in metas.size():
				var meta: Dictionary = metas[s]
				var t: int = Time.get_ticks_usec()
				var check := Rs2Decoder.Schema.new("profile")
				check.transaction(meta, 6)
				schema_us += Time.get_ticks_usec() - t
				var blocks: Array = blocks_of[s]
				var item_f32: PackedFloat32Array = blocks[0]
				var cmd_f32: PackedFloat32Array = blocks[2]
				var cmd_i32: PackedInt32Array = blocks[3]
				var param_f64: PackedFloat64Array = blocks[5]
				var items_meta: Array = meta["items"]
				t = Time.get_ticks_usec()
				for k: int in items_meta.size():
					var item: Dictionary = items_meta[k]
					Rs2Decoder._lift_item(item, item_f32.slice(k * 18, (k + 1) * 18), cmd_f32, cmd_i32, param_f64)
				lift_us += Time.get_ticks_usec() - t
				var json := JSON.new()
				t = Time.get_ticks_usec()
				json.parse(texts[s])
				json_us += Time.get_ticks_usec() - t
			if repeat > 0:
				schema_samples.append(schema_us)
				lift_samples.append(lift_us)
				json_samples.append(json_us)
		cost[variant] = {"schema_us": _median(schema_samples), "lift_us": _median(lift_samples), "json_us": _median(json_samples), "json_bytes": text_bytes}
	var base: Dictionary = cost[""]
	var out: Dictionary = {"sampled_transactions": sampled.size(), "ops": {}}
	var per_op: Dictionary = out["ops"]
	for op: String in ops:
		var count: int = Rs2Decoder.as_int(ops[op])
		var n: float = count
		var c: Dictionary = cost[op]
		var schema_us: float = c["schema_us"]
		var lift_us: float = c["lift_us"]
		var json_us: float = c["json_us"]
		var base_schema_us: float = base["schema_us"]
		var base_lift_us: float = base["lift_us"]
		var base_json_us: float = base["json_us"]
		per_op[op] = {
			"commands": count,
			"schema_us_per_cmd": (schema_us - base_schema_us) / n,
			"lift_us_per_cmd": (lift_us - base_lift_us) / n,
			"json_us_per_cmd": (json_us - base_json_us) / n,
			"json_bytes_per_cmd": (Rs2Decoder.as_int(c["json_bytes"]) - Rs2Decoder.as_int(base["json_bytes"])) / n,
		}
	var base_schema: float = base["schema_us"]
	var base_lift: float = base["lift_us"]
	var base_json: float = base["json_us"]
	var sampled_n: float = maxf(1.0, sampled.size())
	out["no_commands"] = {
		"schema_us_per_tx": base_schema / sampled_n,
		"lift_us_per_tx": base_lift / sampled_n,
		"json_us_per_tx": base_json / sampled_n,
	}
	return out


# ----------------------------------------------------------------------------------- pass 4


## Per add_triangle_array command: production _lift_item (an item holding only that command, minus
## the same item with none) against _lift_triangles_packed.
func _candidate_pass() -> Dictionary:
	var production_us: int = 0
	var packed_us: int = 0
	var count: int = 0
	for repeat: int in _repeats + 1:
		var prod_round: int = 0
		var packed_round: int = 0
		var round_count: int = 0
		for i: int in range(0, _tx_offsets.size(), _op_sample):
			var record: Dictionary = Rs2Decoder.decode_record(_data, _tx_offsets[i])
			var meta: Dictionary = record["meta"]
			var blocks: Array = record["blocks"]
			var item_f32: PackedFloat32Array = blocks[0]
			var cmd_f32: PackedFloat32Array = blocks[2]
			var cmd_i32: PackedInt32Array = blocks[3]
			var param_f64: PackedFloat64Array = blocks[5]
			var cmd_bytes: PackedByteArray = cmd_f32.to_byte_array()
			var items_meta: Array = meta["items"]
			for value: Variant in items_meta:
				var item: Dictionary = value
				if item["commands"] == null:
					continue
				var commands: Array = item["commands"]
				var triangles: Array = []
				for cvalue: Variant in commands:
					var command: Dictionary = cvalue
					if command["op"] == "add_triangle_array":
						triangles.append(command)
				if triangles.is_empty():
					continue
				var copy: Dictionary = item.duplicate()
				copy["commands"] = triangles
				var t: int = Time.get_ticks_usec()
				Rs2Decoder._lift_item(copy, item_f32.slice(0, 18), cmd_f32, cmd_i32, param_f64)
				prod_round += Time.get_ticks_usec() - t
				copy["commands"] = []
				t = Time.get_ticks_usec()
				Rs2Decoder._lift_item(copy, item_f32.slice(0, 18), cmd_f32, cmd_i32, param_f64)
				prod_round -= Time.get_ticks_usec() - t
				t = Time.get_ticks_usec()
				for cvalue: Variant in triangles:
					var command: Dictionary = cvalue
					_lift_triangles_packed(command, cmd_bytes, cmd_i32)
				packed_round += Time.get_ticks_usec() - t
				round_count += triangles.size()
		if repeat > 0:
			production_us += prod_round
			packed_us += packed_round
			count += round_count
	var n: float = maxf(1.0, count)
	return {"triangle_array_lift": {"commands": count / _repeats, "production_us_per_cmd": production_us / n, "packed_us_per_cmd": packed_us / n}}


## The candidate lift: the same resolved fields, as packed arrays converted natively from the
## command block's bytes (Vector2 and Color are float32 in this build, matching the wire).
static func _lift_triangles_packed(command: Dictionary, cmd_bytes: PackedByteArray, cmd_i32: PackedInt32Array) -> Dictionary:
	var f: int = Rs2Decoder.as_int(command["f"])
	var at: int = Rs2Decoder.as_int(command["i"])
	var n: int = Rs2Decoder.as_int(command["n"])
	var colors: int = Rs2Decoder.as_int(command["colors"])
	var uvs: int = Rs2Decoder.as_int(command["uvs"])
	var indices: int = Rs2Decoder.as_int(command["indices"])
	var p: int = 4 * f
	var points: PackedVector2Array = cmd_bytes.slice(p, p + 8 * n).to_vector2_array()
	p += 8 * n
	var color_list: PackedColorArray = cmd_bytes.slice(p, p + 16 * colors).to_color_array()
	p += 16 * colors
	var uv_list: PackedVector2Array = cmd_bytes.slice(p, p + 8 * uvs).to_vector2_array()
	return {
		"op": "add_triangle_array", "tex": command["tex"], "count": Rs2Decoder.as_int(command["count"]),
		"points": points, "colors": color_list, "uvs": uv_list, "indices": cmd_i32.slice(at, at + indices),
	}


# ----------------------------------------------------------------------------------- pass 5


## rs_applier.gd's own source with timing marks inserted at apply_state()'s numbered steps.
static func _instrumented_applier() -> GDScript:
	var text: String = FileAccess.get_file_as_string("res://rs_applier.gd")
	var edits: Array[Array] = [
		["class_name RsApplier\n", ""],
		["\nvar rs_calls: int = 0\n", "\nvar rs_calls: int = 0\nvar prof_us: Dictionary = {}\nvar _prof_t: int = 0\n"],
		["func apply_state(stream: Rs2Decoder.Stream, cache: RsResourceCache) -> Dictionary:\n", "func apply_state(stream: Rs2Decoder.Stream, cache: RsResourceCache) -> Dictionary:\n\t_prof_t = Time.get_ticks_usec()\n"],
		["\t# Meshes (gate5-design.md Q5 step 3b, G5e).\n", "\t_prof_mark(\"textures\")\n\t# Meshes (gate5-design.md Q5 step 3b, G5e).\n"],
		["\t# Shaders, then materials (", "\t_prof_mark(\"meshes\")\n\t# Shaders, then materials ("],
		["\t# The root viewport's defaults (", "\t_prof_mark(\"shaders_materials\")\n\t# The root viewport's defaults ("],
		["\t# 2. Free vanished items", "\t_prof_mark(\"defaults_order\")\n\t# 2. Free vanished items"],
		["\t# 3. Create new canvases", "\t_prof_mark(\"free_vanished\")\n\t# 3. Create new canvases"],
		["\t# 3b. (G6b", "\t_prof_mark(\"create\")\n\t# 3b. (G6b"],
		["\t# 4. Parent pass", "\t_prof_mark(\"canvases\")\n\t# 4. Parent pass"],
		["\t# 5. Order pass", "\t_prof_mark(\"parent_pass\")\n\t# 5. Order pass"],
		["\t# 6. Setters", "\t_prof_mark(\"order_pass\")\n\t# 6. Setters"],
		["\t\tvar version: int = Rs2Decoder.as_int(wire[\"content_version\"])\n", "\t\t_prof_mark(\"item_setters\")\n\t\tvar version: int = Rs2Decoder.as_int(wire[\"content_version\"])\n"],
		["\t\t\tstate.content_version = version\n", "\t\t\tstate.content_version = version\n\t\t_prof_mark(\"content_replay\")\n"],
		["\t# 8. Canvas 1 transform", "\t_prof_mark(\"item_setters\")\n\t# 8. Canvas 1 transform"],
		["\treturn {\n\t\t\"created\": created,", "\t_prof_mark(\"root_canvas\")\n\treturn {\n\t\t\"created\": created,"],
	]
	for edit: Array in edits:
		var anchor: String = edit[0]
		var replacement: String = edit[1]
		if text.count(anchor) != 1:
			printerr("[decode-profile] rs_applier.gd anchor not unique (%d): %s" % [text.count(anchor), JSON.stringify(anchor)])
			return null
		text = text.replace(anchor, replacement)
	text += "\n\nfunc _prof_mark(name: String) -> void:\n\tvar now: int = Time.get_ticks_usec()\n\tprof_us[name] = Rs2Decoder.as_int(prof_us.get(name, 0)) + now - _prof_t\n\t_prof_t = now\n"
	var script := GDScript.new()
	script.source_code = text
	if script.reload() != OK:
		printerr("[decode-profile] the instrumented rs_applier.gd copy does not compile")
		return null
	return script


func _apply_pass() -> Dictionary:
	var script: GDScript = _instrumented_applier()
	if script == null:
		return {"error": "instrumentation failed"}
	var names: Array[String] = ["decode", "needed", "obtain", "apply_state"]
	names.append_array(APPLY_MARKS)
	var samples: Dictionary = {}
	for name: String in names:
		samples[name] = _new_samples()
	var rs_calls: Array[Array] = _new_samples()
	var viewport: RID = get_root().get_viewport_rid()
	var root_canvas: RID = get_root().world_2d.canvas
	for repeat: int in _repeats + 1:
		var cache := RsResourceCache.new()
		var cache_error: String = cache.open(_cache_dir.path_join("profile-%d-%d" % [Time.get_ticks_usec(), repeat]), "fresh", _store_dir)
		if cache_error != "":
			return {"error": cache_error}
		var stream := Rs2Decoder.Stream.new()
		var session: Dictionary = Rs2Decoder.decode_record(_data, _session_offset)
		var session_errors: PackedStringArray = stream.accept(_data, session)
		assert(session_errors.is_empty())
		var applier: Object = script.new(viewport, root_canvas)
		applier.call("begin_session", session["meta"], session["blocks"])
		for i: int in _tx_offsets.size():
			var t: int = Time.get_ticks_usec()
			var accepted: Dictionary = RsApplier.accept_record(_data, _tx_offsets[i], stream)
			var decode_us: int = Time.get_ticks_usec() - t
			var accept_errors: PackedStringArray = accepted["errors"]
			if not accept_errors.is_empty():
				return {"error": accept_errors[0]}
			t = Time.get_ticks_usec()
			var need: Dictionary = applier.call("needed", stream.items, stream.textures, stream.meshes, stream.shaders, stream.materials)
			var hashes: Array = need["hashes"]
			var mesh_hashes: Array = need["mesh_hashes"]
			var shader_hashes: Array = need["shader_hashes"]
			cache.set_needed(hashes)
			var needed_us: int = Time.get_ticks_usec() - t
			t = Time.get_ticks_usec()
			for value: Variant in hashes:
				var hash: String = value
				if cache.has_in_memory(hash):
					continue
				var got: Dictionary = cache.obtain(hash, mesh_hashes.has(hash), shader_hashes.has(hash))
				var got_error: String = got["error"]
				if got_error != "":
					return {"error": got_error}
			var obtain_us: int = Time.get_ticks_usec() - t
			applier.set("prof_us", {})
			t = Time.get_ticks_usec()
			var stats: Dictionary = applier.call("apply_state", stream, cache)
			var apply_us: int = Time.get_ticks_usec() - t
			if repeat == 0:
				continue
			var marks: Dictionary = applier.get("prof_us")
			var times: Dictionary = {"decode": decode_us, "needed": needed_us, "obtain": obtain_us, "apply_state": apply_us}
			for mark: String in APPLY_MARKS:
				times[mark] = Rs2Decoder.as_int(marks.get(mark, 0))
			for name: String in names:
				var list: Array[Array] = samples[name]
				var tx_samples: Array = list[i]
				tx_samples.append(Rs2Decoder.as_int(times[name]))
			var call_samples: Array = rs_calls[i]
			call_samples.append(Rs2Decoder.as_int(stats["rs_calls"]))
		applier.call("dispose")
	var out: Dictionary = {}
	for name: String in names:
		var list: Array[Array] = samples[name]
		out[name] = _summary(list)
	out["rs_calls"] = _summary(rs_calls)
	return out


# ----------------------------------------------------------------------------------- floors


## What a single GDScript touch costs here, for scale: an empty loop over 100 000 elements, an
## indexed PackedFloat32Array read, a Dictionary key read, a 4-element Array literal and a small
## Dictionary literal, each in ns per operation.
func _floors() -> Dictionary:
	var n: int = 100000
	var floats := PackedFloat32Array()
	floats.resize(n + 8)
	var dict: Dictionary = {"op": "add_rect", "f": 12.0, "aa": false}
	var out: Dictionary = {}
	var sink: float = 0.0
	var t: int = Time.get_ticks_usec()
	for i: int in n:
		pass
	out["empty_loop_ns"] = (Time.get_ticks_usec() - t) * 1000.0 / n
	t = Time.get_ticks_usec()
	for i: int in n:
		sink += floats[i]
	out["packed_read_ns"] = (Time.get_ticks_usec() - t) * 1000.0 / n
	t = Time.get_ticks_usec()
	for i: int in n:
		var v: Variant = dict["f"]
		sink += 1.0 if v != null else 0.0
	out["dict_read_ns"] = (Time.get_ticks_usec() - t) * 1000.0 / n
	t = Time.get_ticks_usec()
	for i: int in n:
		var a: Array = [floats[i], floats[i + 1], floats[i + 2], floats[i + 3]]
		sink += a.size()
	out["array4_literal_ns"] = (Time.get_ticks_usec() - t) * 1000.0 / n
	t = Time.get_ticks_usec()
	for i: int in n:
		var d: Dictionary = {"op": "add_rect", "aa": false, "rect": null, "color": null}
		sink += d.size()
	out["dict4_literal_ns"] = (Time.get_ticks_usec() - t) * 1000.0 / n
	t = Time.get_ticks_usec()
	for i: int in n:
		var s: String = "%s.commands[%d]" % ["meta.items[3]", i]
		sink += s.length()
	out["path_format_ns"] = (Time.get_ticks_usec() - t) * 1000.0 / n
	out["sink"] = sink
	return out


# ----------------------------------------------------------------------------------- report


func _print_report(result: Dictionary) -> void:
	var counts: Dictionary = result["counts"]
	var per_tx: Dictionary = counts["per_tx"]
	var tx_n: float = Rs2Decoder.as_int(result["transactions"])
	var full_share: float = per_tx["full"]
	var patch_share: float = per_tx["patch"]
	var full_n: int = roundi(full_share * tx_n)
	var patch_n: int = roundi(patch_share * tx_n)
	print("[decode-profile] per transaction: %.0f B record, %.0f B meta, %.0f B cmd_f32, %.1f items (%.1f with commands), %.1f commands; resolved %.1f items / %.1f commands; %d full, %d patch" % [per_tx["record_bytes"], per_tx["meta_bytes"], per_tx["cmd_f32_bytes"], per_tx["items"], per_tx["items_with_commands"], per_tx["commands"], per_tx["resolved_items"], per_tx["resolved_commands"], full_n, patch_n])
	var production: Dictionary = result["production"]
	var total_mean: float = 1.0
	if not production.is_empty():
		var total: Dictionary = production["accept_record"]
		total_mean = total["mean_us"]
		print("[decode-profile] accept_record (production): mean %.1f us, p50 %.1f, p95 %.1f" % [total_mean, total["p50_us"], total["p95_us"]])
	var stages: Dictionary = result["stages"]
	for name: String in DECODE_STAGES + ["decode_record"] + ACCEPT_STAGES + ["accept"]:
		if not stages.has(name):
			continue
		var s: Dictionary = stages[name]
		var mean: float = s["mean_us"]
		print("[decode-profile]   %-20s mean %9.1f us  p50 %9.1f  %5.1f %%" % [name, mean, s["p50_us"], 100.0 * mean / maxf(1.0, total_mean)])
	var apply: Dictionary = result["apply"]
	if apply.has("apply_state"):
		var apply_total: Dictionary = apply["apply_state"]
		var apply_mean: float = apply_total["mean_us"]
		for name: String in ["decode", "needed", "obtain", "apply_state"] + APPLY_MARKS + ["rs_calls"]:
			var s: Dictionary = apply[name]
			var mean: float = s["mean_us"]
			print("[decode-profile]   apply %-16s mean %9.1f  p50 %9.1f  p95 %9.1f  %5.1f %%" % [name, mean, s["p50_us"], s["p95_us"], 100.0 * mean / maxf(1.0, apply_mean)])
	elif not apply.is_empty():
		print("[decode-profile] apply pass: %s" % JSON.stringify(apply))
	var per_op: Dictionary = result["per_op"]
	var ops: Dictionary = per_op.get("ops", {})
	for op: String in ops:
		var o: Dictionary = ops[op]
		print("[decode-profile]   op %-30s %6d cmds  json %.2f  schema %.2f  lift %.2f us/cmd  (%.0f B json)" % [op, o["commands"], o["json_us_per_cmd"], o["schema_us_per_cmd"], o["lift_us_per_cmd"], o["json_bytes_per_cmd"]])
	print("[decode-profile] floors (ns/op): %s" % JSON.stringify(result["floors"]))
	print("[decode-profile] candidates: %s" % JSON.stringify(result["candidates"]))
