class_name RsPerf
extends RefCounted
## Receiver perf instrumentation (gate6-design.md Q3d, Q5 "Perf (G6r)"), gated by
## RS_RECEIVER_PERF_OUT: writes `render-stream-receiver-perf/1` -- histograms for `decode_us`
## (RsRustApplier.accept: the core's decode and patch resolution, combined; `resolve_us` is not
## split out), `apply_us` (RsRustApplier.apply_state: apply and upload, combined; `upload_us` is likewise not split, though upload
## bytes are already in applied.json's resources_summary and are not duplicated here),
## `fetch_us` (reusing the fetch stage's own existing start_us/end_us, never re-timed) and
## `frame_interval_us`; counts of received/applied/submitted transactions (from the caller's own
## _acks_sent, not re-tracked here); `gpu_render_ms`/`cpu_render_ms` with a status (`measured` on
## a rendered desktop-GL viewport with RenderingServer.viewport_set_measure_render_time enabled,
## `skipped-headless` under --headless, matching receiver.gd's own existing headless-detection
## vocabulary at _viewport_report.size_check); and a one-line-per-second timeline carrying RSS
## (read directly from /proc/self/statm through FileAccess, D9: process RSS, never an engine
## counter), RenderingServer.get_rendering_info's texture/buffer/video memory, the disk cache's
## entry count and bytes (RsResourceCache.entries()/bytes()) and, since G6s (gate6-design.md Q7e
## "residency-bounded"), the memory cache's entry count and bytes (RsResourceCache.
## memory_entries()/memory_bytes()) and live RIDs per kind (RsRustApplier.resident_items()/
## resident_textures()/resident_meshes()/resident_shaders()/resident_materials(), all pre-existing
## read accessors no increment needed to add).
##
## G6c adds, still only with RS_RECEIVER_PERF_OUT: per-frame `gpu_render_us`/`cpu_render_us`
## histograms (the measured render time sampled every frame, for Q7d's `separation`), `frames`
## (frames drawn) on every timeline line (the receiver frame rate of any window), and the video
## adapter and rendering method (render-stream-report/1's provenance.receiver).
##
## Pipeline compilation counts stay declared `unavailable` rather than guessed: nothing here
## measures them yet.

const SCHEMA: String = "render-stream-receiver-perf/1"

## A fixed-size log-linear histogram (16 sub-buckets per octave, 25 octaves -> 400 buckets,
## covering integer microsecond samples up to 2^25 - 1 before the top bucket clamps), the same
## bucket scheme as capture/src/rs_histogram.h (Q3d), reimplemented here since the receiver is a
## separate GDScript process with no access to the C++ library.
class Histogram:
	const OCTAVES: int = 25
	const SUB_BUCKETS: int = 16
	const BUCKET_COUNT: int = OCTAVES * SUB_BUCKETS  # 400

	var buckets: Array[int] = []
	var count: int = 0
	var sum: int = 0
	var minimum: int = -1
	var maximum: int = 0

	func _init() -> void:
		buckets.resize(BUCKET_COUNT)
		buckets.fill(0)

	## octave = floor(log2(value)) (clamped to OCTAVES - 1); sub = floor(16 * (value/2^octave - 1))
	## within that octave (clamped to SUB_BUCKETS - 1). Values 0 and 1 both land in bucket 0.
	static func bucket_index(value: int) -> int:
		if value <= 1:
			return 0
		var value_f: float = float(value)
		var log2_value: float = log(value_f) / log(2.0)
		var octave_f: float = floor(log2_value)
		var octave: int = int(octave_f)
		if octave >= OCTAVES:
			return BUCKET_COUNT - 1
		var base: int = 1 << octave
		# A value exactly on a power-of-two boundary can round `octave` up by float error.
		if base > value:
			octave -= 1
			base = 1 << octave
		elif (base << 1) <= value:
			octave += 1
			if octave >= OCTAVES:
				return BUCKET_COUNT - 1
			base = 1 << octave
		var remainder: int = value - base
		var sub_numerator: int = remainder * SUB_BUCKETS
		var sub: int = sub_numerator / base
		if sub >= SUB_BUCKETS:
			sub = SUB_BUCKETS - 1
		return octave * SUB_BUCKETS + sub

	static func bucket_lower_bound(index: int) -> int:
		var octave: int = index / SUB_BUCKETS
		var sub: int = index % SUB_BUCKETS
		var base: int = 1 << octave
		var numerator: int = base * sub
		return base + numerator / SUB_BUCKETS

	func add(value: int) -> void:
		if value < 0:
			value = 0
		count += 1
		sum += value
		minimum = value if minimum < 0 else min(minimum, value)
		maximum = max(maximum, value)
		buckets[bucket_index(value)] += 1

	func to_dict() -> Dictionary:
		var bucket_pairs: Array = []
		for i in range(BUCKET_COUNT):
			if buckets[i] > 0:
				bucket_pairs.append([bucket_lower_bound(i), buckets[i]])
		return {
			"count": count,
			"sum": sum,
			"min": 0 if minimum < 0 else minimum,
			"max": maximum,
			"mean": (float(sum) / count) if count > 0 else 0.0,
			"buckets": bucket_pairs,
		}


var decode_us := Histogram.new()
var apply_us := Histogram.new()
var fetch_us := Histogram.new()
var frame_interval_us := Histogram.new()
## G6c (gate6-design.md Q7d `separation`): the viewport's measured render time, sampled once per
## frame (microseconds of RenderingServer.viewport_get_measured_render_time_gpu/_cpu, which read
## the GL timer queries two frames late, g3u.cpp:324-358); rendered receivers only, frames whose
## value is still 0 (nothing measured yet) skipped.
var gpu_render_us := Histogram.new()
var cpu_render_us := Histogram.new()
## G7o2 (D31): the web export's deferred record digests, once per frame after its draw; written
## only when any were taken (the native receiver digests inline, inside decode_us).
var evidence_hash_us := Histogram.new()
## G7o3: payload verification on arrival (outside decode_us and apply_us), and the Rust core's
## apply_us split: the provide loop, the core's planner, the op stream's RenderingServer calls and
## the stats Variant tree. Written only when sampled.
var payload_verify_us := Histogram.new()
var provide_us := Histogram.new()
var plan_us := Histogram.new()
var execute_us := Histogram.new()
var stats_us := Histogram.new()
## G7o3: RS_RECEIVER_PERF_SAMPLES=1's per-transaction timings (receiver.gd), and the Rust core's
## payload counters (receiver.gd _note_payload_counters()).
var samples: Array[Dictionary] = []
var payloads: Dictionary = {}

var _last_frame_us: int = -1
var _start_ms: int = 0
var _last_timeline_second: int = -1
var _timeline: Array[Dictionary] = []
## Set once, the first time a render-time query is attempted (Godot's own
## viewport_set_measure_render_time must run before the first measured frame).
var _measure_enabled: bool = false
var _measure_viewport: RID = RID()

const BYTES_PER_PAGE_STATM_UNIT: int = 4096  # overridden by the actual page size, below


func _init() -> void:
	_start_ms = Time.get_ticks_msec()


## Call once per _process/_process_live callback, before anything else this frame does.
func record_frame_interval() -> void:
	var now_us: int = Time.get_ticks_usec()
	if _last_frame_us >= 0:
		frame_interval_us.add(now_us - _last_frame_us)
	_last_frame_us = now_us


## Enables render-time measurement on `viewport_rid`, once. A no-op (and the eventual query stays
## at its default 0.0) under a dummy/headless rendering method; receiver.gd gates the resulting
## status on DisplayServer.get_name(), matching its own existing headless vocabulary.
func enable_render_time_measurement(viewport_rid: RID) -> void:
	if _measure_enabled:
		return
	_measure_enabled = true
	_measure_viewport = viewport_rid
	RenderingServer.viewport_set_measure_render_time(viewport_rid, true)


## G6c: one gpu_render_us/cpu_render_us sample per frame, once measurement is on (rendered only).
func record_render_time(headless: bool) -> void:
	if headless or not _measure_enabled:
		return
	var gpu_ms: float = RenderingServer.viewport_get_measured_render_time_gpu(_measure_viewport)
	var cpu_ms: float = RenderingServer.viewport_get_measured_render_time_cpu(_measure_viewport)
	if gpu_ms > 0.0:
		gpu_render_us.add(roundi(gpu_ms * 1000.0))
	if cpu_ms > 0.0:
		cpu_render_us.add(roundi(cpu_ms * 1000.0))


## {"status", "value"} for one of the two measured_render_time getters. `headless` is
## DisplayServer.get_name() == "headless" (receiver.gd's own check, reused rather than
## reintroduced here).
func render_time(viewport_rid: RID, headless: bool, gpu: bool) -> Dictionary:
	if headless:
		return {"status": "skipped-headless", "value": null}
	var ms: float = (RenderingServer.viewport_get_measured_render_time_gpu(viewport_rid) if gpu
		else RenderingServer.viewport_get_measured_render_time_cpu(viewport_rid))
	# G7e (gate7-design.md Q4 "rs_perf.gd on the web"): WebGL 2 reports whatever the engine
	# measures there; a nonzero value is `measured`, zero is `unavailable`, never a guessed 0 ms.
	if RsConfig.is_web() and ms <= 0.0:
		return {"status": "unavailable", "value": null}
	return {"status": "measured", "value": ms}


## RSS in bytes, read directly from /proc/self/statm (field 2, in pages; D9: process RSS, never
## an engine memory counter). 0 when unreadable (e.g. not on Linux).
static func read_rss_bytes() -> int:
	var file: FileAccess = FileAccess.open("/proc/self/statm", FileAccess.READ)
	if file == null:
		return 0
	var line: String = file.get_line()
	file.close()
	var parts: PackedStringArray = line.split(" ", false)
	if parts.size() < 2 or not parts[1].is_valid_int():
		return 0
	# /proc/self/statm's unit is the kernel page size, almost always 4096 on x86-64 Linux; there
	# is no portable GDScript getpagesize(), so this is declared, not guessed, as a known
	# approximation rather than silently assumed exact.
	return parts[1].to_int() * BYTES_PER_PAGE_STATM_UNIT


## Appends one timeline entry at most once per whole second since this RsPerf was created.
## `cache_entries_memory`/`cache_bytes_memory` (G6s, RsResourceCache.memory_entries()/
## memory_bytes()) default to -1 (recorded as null) for a caller that does not pass them, so an
## older call site keeps today's "unavailable" shape rather than silently reporting 0.
## `live_rids` (G6s, RsRustApplier.resident_items()/resident_textures()/resident_meshes()/
## resident_shaders()/resident_materials(), gate6-design.md Q7e "residency-bounded"): null for a
## caller with no applier yet (before the session record).
func sample_timeline(cache_entries_disk: int, cache_bytes_disk: int, cache_entries_memory: int = -1, cache_bytes_memory: int = -1, live_rids: Variant = null) -> void:
	var elapsed_s: int = (Time.get_ticks_msec() - _start_ms) / 1000
	if elapsed_s <= _last_timeline_second:
		return
	_last_timeline_second = elapsed_s
	_timeline.append({
		"t_us": Time.get_ticks_usec(),
		# G6c: frames drawn so far (D9's receiver frame rate counts frame_post_draw).
		"frames": Engine.get_frames_drawn(),
		# G7e: /proc is absent on the web (gate7-design.md Q1a "Files"), so RSS is null there and
		# D16 measures the browser's processes from outside instead.
		"rss_bytes": null if RsConfig.is_web() else read_rss_bytes(),
		"texture_mem_bytes": RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_TEXTURE_MEM_USED),
		"buffer_mem_bytes": RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_BUFFER_MEM_USED),
		"video_mem_bytes": RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_VIDEO_MEM_USED),
		"cache_entries_disk": cache_entries_disk,
		"cache_bytes_disk": cache_bytes_disk,
		"cache_entries_memory": null if cache_entries_memory < 0 else cache_entries_memory,
		"cache_bytes_memory": null if cache_bytes_memory < 0 else cache_bytes_memory,
		"live_rids": live_rids,
		# Declared, not guessed (D9): pipeline compilations would need a new RenderingServer/
		# RsRustApplier accessor this increment's file list does not add.
		"pipeline_compilations": null,
	})


## The full render-stream-receiver-perf/1 document. `counts` is the caller's own
## {"received", "applied", "submitted"} (receiver.gd's _acks_sent, not duplicated here), or null
## in file mode, which has no acks (D9: declared, not guessed, rather than a misleading all-zero).
func to_dict(viewport_rid: RID, headless: bool, counts: Variant) -> Dictionary:
	var histograms: Dictionary = {
		"decode_us": decode_us.to_dict(),
		"apply_us": apply_us.to_dict(),
		"fetch_us": fetch_us.to_dict(),
		"frame_interval_us": frame_interval_us.to_dict(),
		"gpu_render_us": gpu_render_us.to_dict(),
		"cpu_render_us": cpu_render_us.to_dict(),
	}
	if evidence_hash_us.count > 0:
		histograms["evidence_hash_us"] = evidence_hash_us.to_dict()
	var g7o3: Dictionary = {
		"payload_verify_us": payload_verify_us, "provide_us": provide_us, "plan_us": plan_us,
		"execute_us": execute_us, "stats_us": stats_us,
	}
	for key: String in g7o3:
		var histogram: Histogram = g7o3[key]
		if histogram.count > 0:
			histograms[key] = histogram.to_dict()
	var doc: Dictionary = {
		"schema": SCHEMA,
		"histograms": histograms,
		"unavailable_stages": [
			{"stage": "resolve_us", "reason": "combined with decode_us inside RsRustApplier.accept, which G6r does not split"},
			{"stage": "upload_us", "reason": "combined with apply_us inside RsRustApplier.apply_state, which G6r does not split (upload bytes are in resources_summary)"},
		],
		"render_time": {
			"cpu_render_ms": render_time(viewport_rid, headless, false),
			"gpu_render_ms": render_time(viewport_rid, headless, true),
		},
		"counts": counts,
		# G6c: render-stream-report/1's provenance.receiver (empty adapter strings when headless).
		"rendering_method": RenderingServer.get_current_rendering_method(),
		"adapter": {
			"vendor": RenderingServer.get_video_adapter_vendor(),
			"name": RenderingServer.get_video_adapter_name(),
			"api_version": RenderingServer.get_video_adapter_api_version(),
		},
		"timeline": _timeline,
	}
	# G7o3: only when there is something to say (an unsampled run writes no samples).
	if not payloads.is_empty():
		doc["payloads"] = payloads
	if not samples.is_empty():
		doc["samples"] = samples
	return doc
