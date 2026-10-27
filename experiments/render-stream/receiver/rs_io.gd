class_name RsIo
extends RefCounted
## The receiver's sources and sinks (gate7-design.md Q4 "rs_io.gd", G7e). Natively both are
## no-ops: the recording, the store and the shader library are read from their paths, and
## applied.json, shots, state dumps, perf.json and received.rs2 are written to theirs, exactly as
## before G7e. On a web export (RsConfig.is_web()):
##
## - Sources. RS_RECEIVER_RECORDING (a file), RS_RECEIVER_STORE_DIR and RS_RECEIVER_SHADER_LIBRARY
##   (directories) are same-origin URL paths on the page's harness (RS_RECEIVER_PAGE_ORIGIN, which
##   the shell sets from `location.origin`). prepare_sources() fetches each through HTTPClient
##   (one fetch per file, HTTPClientWeb has no keep-alive), before _ready applies the session,
##   into emscripten's in-memory filesystem at the SAME absolute path, so every FileAccess read
##   the receiver makes is unchanged: a store read still counts as a fetch from the origin, as it
##   does natively. A directory's file list comes from the harness's `GET <dir>/?list` (a JSON
##   array of relative paths).
## - Sinks. Every write the receiver makes lands in the same in-memory filesystem. finish() then
##   PUTs every file under RS_RECEIVER_OUT's directory (the sink root), except the sources it
##   fetched, to RS_RECEIVER_EVIDENCE_URL + "/" + its path relative to that root, and only then
##   quits with the receiver's exit code (which the shell's onExit reports). So no PUT and no
##   PNG upload ever runs inside a timed window (D10), and a sink path outside the sink root
##   (RS_RECEIVER_PERF_OUT, RS_RECEIVER_RECEIVED_OUT) is refused by check_sink_paths().
##
## WX (results/p3/wx.md): file replay's store is lazy by default on the web (RS_RECEIVER_WEB_STORE
## unset or `lazy`). prepare_sources() then neither lists nor stages RS_RECEIVER_STORE_DIR: the
## receiver fetches each payload a transaction needs when that transaction needs it
## (start_store_fetch()/poll_store_fetch(): `GET <store>/sha256/<file>`, the browser's own fetch()
## through RsResourceFetcher's JavaScriptBridge path, as live mode's GETs, CONCURRENCY at a time)
## and drops it once it is uploaded. The recording is fetched the same way, once, straight into
## memory (recording_bytes), with no in-memory file copy: the receiver frames the whole recording
## before its first RenderingServer call, so it keeps it whole. `staged` is the pre-WX path: every
## source, the store included, fetched into the in-memory filesystem before _ready applies.
## The shader library (RS_RECEIVER_SHADER_LIBRARY) is staged in both modes, and live mode is
## unchanged (it has no recording or store).
##
## The cache directory (RS_RECEIVER_CACHE_DIR) is native only: on the web the "disk cache" is the
## browser's HTTP cache (gate7-design.md Q4), which receiver.gd declares as cache mode
## `http-cache`.

## How many fetches or PUTs run at once on the web (each one is one fetch() in the page).
const CONCURRENCY: int = 8
## WX: a recording GET's timeout (a large recording on the loopback harness).
const RECORDING_TIMEOUT_MS: int = 600000
const SOURCE_FILES: Array[String] = ["RS_RECEIVER_RECORDING"]
const SOURCE_DIRS: Array[String] = ["RS_RECEIVER_STORE_DIR", "RS_RECEIVER_SHADER_LIBRARY"]

## Totals for the receiver's log line.
var source_files: int = 0
var source_bytes: int = 0
var source_ms: int = 0
var sink_files: int = 0
var sink_bytes: int = 0

## WX: the web file replay's store is fetched per transaction (RS_RECEIVER_WEB_STORE=lazy, the
## default), not staged up front. Set by receiver.gd before prepare_sources().
var lazy_store: bool = false
## WX: the recording, fetched straight into memory under lazy_store (has_recording()).
var recording_bytes: PackedByteArray = PackedByteArray()
var _recording_fetched: bool = false
## WX: the store GETs made and their bytes, and the results of the running batch, by index.
var store_gets: int = 0
var store_bytes: int = 0
var store_results: Array[Dictionary] = []
var _store_pool: Array[RsResourceFetcher] = []
var _store_batch: Array[String] = []
var _store_prefix: String = ""

var _host: String = ""
var _port: int = 0
## Absolute in-memory paths prepare_sources() wrote (never PUT back).
var _sources: Dictionary[String, bool] = {}


## Web only: fetches every configured source into the in-memory filesystem. Returns "" or a
## "<code>: <detail>" error (recording-unreadable for the recording, resource-unavailable for a
## store or library file). Natively returns "" at once.
func prepare_sources(tree: SceneTree) -> String:
	if not RsConfig.is_web():
		return ""
	var origin_error: String = _parse_origin()
	if origin_error != "":
		return origin_error
	var start_ms: int = Time.get_ticks_msec()
	var wanted: Array[Dictionary] = []
	for variable: String in SOURCE_FILES:
		var path: String = RsConfig.get_env(variable).strip_edges()
		if path == "":
			continue
		if lazy_store and variable == "RS_RECEIVER_RECORDING":
			var recording_error: String = await _fetch_recording(tree, path)
			if recording_error != "":
				return recording_error
			continue
		wanted.append({"variable": variable, "path": path})
	for variable: String in SOURCE_DIRS:
		var dir: String = RsConfig.get_env(variable).strip_edges()
		if dir == "":
			continue
		if lazy_store and variable == "RS_RECEIVER_STORE_DIR":
			if not dir.is_absolute_path():
				return "resource-unavailable: %s must be an absolute same-origin path on the web (got %s)" % [variable, JSON.stringify(dir)]
			_store_prefix = _url_path(dir.trim_suffix("/").path_join(RsResourceCache.CACHE_SUBDIR)) + "/"
			continue
		if not dir.is_absolute_path():
			return "resource-unavailable: %s must be an absolute same-origin path on the web (got %s)" % [variable, JSON.stringify(dir)]
		var listing: Array[Dictionary] = [_request(HTTPClient.METHOD_GET, _url_path(dir.trim_suffix("/") + "/") + "?list", PackedByteArray())]
		await _run(tree, listing)
		var listed: Dictionary = listing[0]
		if listed["code"] != 200:
			return "resource-unavailable: listing %s for %s answered %s" % [dir, variable, str(listed["code"])]
		var listing_body: PackedByteArray = listed["body"]
		var names: Variant = JSON.parse_string(listing_body.get_string_from_utf8())
		if not (names is Array):
			return "resource-unavailable: listing %s for %s is not a JSON array" % [dir, variable]
		var name_list: Array = names
		for value: Variant in name_list:
			var relative: String = str(value)
			wanted.append({"variable": variable, "path": dir.trim_suffix("/").path_join(relative)})
	var requests: Array[Dictionary] = []
	for entry: Dictionary in wanted:
		var path: String = entry["path"]
		if not path.is_absolute_path():
			return "recording-unreadable: %s must be an absolute same-origin path on the web (got %s)" % [entry["variable"], JSON.stringify(path)]
		var request: Dictionary = _request(HTTPClient.METHOD_GET, _url_path(path), PackedByteArray())
		request["path"] = path
		request["variable"] = entry["variable"]
		requests.append(request)
	await _run(tree, requests)
	for request: Dictionary in requests:
		var path: String = request["path"]
		if request["code"] != 200:
			var code: String = "recording-unreadable" if request["variable"] == "RS_RECEIVER_RECORDING" else "resource-unavailable"
			return "%s: GET %s answered %s %s" % [code, path, str(request["code"]), request["error"]]
		var body: PackedByteArray = request["body"]
		var made: Error = DirAccess.make_dir_recursive_absolute(path.get_base_dir())
		var file: FileAccess = FileAccess.open(path, FileAccess.WRITE) if made == OK else null
		if file == null:
			return "resource-unavailable: cannot stage %s in memory: %s" % [path, error_string(FileAccess.get_open_error())]
		file.store_buffer(body)
		file.close()
		_sources[path] = true
		source_files += 1
		source_bytes += body.size()
	source_ms = Time.get_ticks_msec() - start_ms
	return ""


## Web only: "" or the usage error for a sink path outside RS_RECEIVER_OUT's directory, and for a
## missing RS_RECEIVER_EVIDENCE_URL or RS_RECEIVER_PAGE_ORIGIN.
func check_sink_paths(out_path: String, other_paths: Array[String]) -> String:
	if not RsConfig.is_web():
		return ""
	if RsConfig.get_env("RS_RECEIVER_EVIDENCE_URL").strip_edges() == "":
		return "RS_RECEIVER_EVIDENCE_URL is required on the web (the evidence PUT prefix)"
	var origin_error: String = _parse_origin()
	if origin_error != "":
		return origin_error
	var root: String = out_path.get_base_dir()
	for path: String in other_paths:
		if path != "" and not path.begins_with(root + "/"):
			return "%s is outside RS_RECEIVER_OUT's directory %s, so it cannot be uploaded" % [path, root]
	return ""


## Calls `before_quit` and quits with `code`. On the web, first PUTs every file under
## `out_path`'s directory (except the fetched sources) to RS_RECEIVER_EVIDENCE_URL -- the last
## applied state is still drawn meanwhile, which is the frame the harness's compositor screenshot
## sees -- then calls `before_quit` and quits; a failed PUT is logged and changes nothing else (the
## harness's evidence-complete check sees the missing file).
func finish(tree: SceneTree, out_path: String, code: int, before_quit: Callable) -> void:
	if not RsConfig.is_web() or out_path == "" or _host == "":
		before_quit.call()
		tree.quit(code)
		return
	var root: String = out_path.get_base_dir()
	var evidence: String = RsConfig.get_env("RS_RECEIVER_EVIDENCE_URL").strip_edges().trim_suffix("/")
	var requests: Array[Dictionary] = []
	for path: String in _files_under(root):
		if _sources.has(path):
			continue
		var body: PackedByteArray = FileAccess.get_file_as_bytes(path)
		var request: Dictionary = _request(HTTPClient.METHOD_PUT, evidence + "/" + _url_encode_path(path.substr(root.length() + 1)), body)
		request["path"] = path
		requests.append(request)
	await _run(tree, requests)
	for request: Dictionary in requests:
		if request["code"] != 200:
			print("[receiver] error: PUT of %s answered %s %s" % [request["path"], str(request["code"]), request["error"]])
			continue
		sink_files += 1
		var body: PackedByteArray = request["body_out"]
		sink_bytes += body.size()
	print("[receiver] web io: %d sources (%d bytes, %d ms), %d evidence files uploaded (%d bytes), exit %d" % [source_files, source_bytes, source_ms, sink_files, sink_bytes, code])
	before_quit.call()
	tree.quit(code)


## WX: whether prepare_sources() fetched the recording into recording_bytes (lazy_store).
func has_recording() -> bool:
	return _recording_fetched


## WX: hands over the fetched recording (the receiver keeps the only copy).
func take_recording() -> PackedByteArray:
	var data: PackedByteArray = recording_bytes
	recording_bytes = PackedByteArray()
	return data


## WX: starts the GETs of `files` (store file names, `<hash>.grt` and the like) under the lazy
## store's `sha256/` directory, CONCURRENCY at a time (one at a time with a fetch delay, which
## then precedes each GET as it does each store read natively). store_results then holds one
## RsResourceFetcher result per file, by index, once poll_store_fetch() is true (a file after a
## failed one on the same fetcher has none).
func start_store_fetch(files: Array[String], timeout_ms: int, delay_ms: int) -> void:
	var lanes: int = 1 if delay_ms > 0 else CONCURRENCY
	while _store_pool.size() < lanes:
		_store_pool.append(RsResourceFetcher.new(_host, _port, _store_prefix, timeout_ms, delay_ms, "", true))
	_store_batch = files.duplicate()
	store_results.clear()
	for lane: int in range(_store_pool.size()):
		var fetcher: RsResourceFetcher = _store_pool[lane]
		fetcher.timeout_ms = timeout_ms
		fetcher.delay_ms = delay_ms
		var mine: Array[String] = []
		if lane < lanes:
			for index: int in range(lane, files.size(), lanes):
				mine.append(_url_encode_path(files[index]))
		fetcher.start(mine)


## WX: advances the running store batch (call once per _process). True once every lane is done;
## store_results then holds the batch's results in file order.
func poll_store_fetch() -> bool:
	var done: bool = true
	for fetcher: RsResourceFetcher in _store_pool:
		if not fetcher.poll():
			done = false
	if not done:
		return false
	var by_file: Dictionary[String, Dictionary] = {}
	for fetcher: RsResourceFetcher in _store_pool:
		for result: Dictionary in fetcher.results:
			by_file[str(result["hash"])] = result
		fetcher.results.clear()
	store_results.clear()
	for file: String in _store_batch:
		var key: String = _url_encode_path(file)
		var result: Dictionary = by_file.get(key, {})
		store_results.append(result)
		if not result.is_empty():
			store_gets += 1
			store_bytes += RsWire.as_int(result["bytes"])
	_store_batch.clear()
	return true


## WX: the lazy store's recording: one GET of `path` through the page's fetch(), kept in memory.
func _fetch_recording(tree: SceneTree, path: String) -> String:
	if not path.is_absolute_path():
		return "recording-unreadable: RS_RECEIVER_RECORDING must be an absolute same-origin path on the web (got %s)" % JSON.stringify(path)
	var fetcher := RsResourceFetcher.new(_host, _port, _url_path(path.get_base_dir()).trim_suffix("/") + "/", RECORDING_TIMEOUT_MS, 0, "", true)
	var name: String = path.get_file().uri_encode()
	fetcher.start([name])
	while not fetcher.poll():
		await tree.process_frame
	var result: Dictionary = fetcher.results[0] if not fetcher.results.is_empty() else {}
	var status: Variant = result.get("status")
	if result.is_empty() or str(result.get("error", "")) != "":
		if status is int and RsWire.as_int(status) != 200:
			return "recording-unreadable: GET %s answered %s" % [path, str(status)]
		return "recording-unreadable: GET %s failed: %s" % [path, str(result.get("error", "no result"))]
	recording_bytes = result["data"]
	result["data"] = PackedByteArray()
	_recording_fetched = true
	source_files += 1
	source_bytes += recording_bytes.size()
	return ""


# --------------------------------------------------------------------------------- internals


func _parse_origin() -> String:
	if _host != "":
		return ""
	var origin: String = RsConfig.get_env("RS_RECEIVER_PAGE_ORIGIN").strip_edges()
	if not origin.begins_with("http://"):
		return "recording-unreadable: RS_RECEIVER_PAGE_ORIGIN must be the page's http:// origin (got %s)" % JSON.stringify(origin)
	var authority: String = origin.substr("http://".length()).trim_suffix("/")
	var colon: int = authority.rfind(":")
	if colon <= 0 or not authority.substr(colon + 1).is_valid_int():
		return "recording-unreadable: RS_RECEIVER_PAGE_ORIGIN has no explicit port (got %s)" % JSON.stringify(origin)
	_host = authority.substr(0, colon)
	_port = authority.substr(colon + 1).to_int()
	return ""


## A path for an HTTP request line: every segment percent-encoded, "/" kept.
static func _url_path(path: String) -> String:
	return "/" + _url_encode_path(path.trim_prefix("/"))


static func _url_encode_path(path: String) -> String:
	var parts: PackedStringArray = path.split("/")
	var encoded := PackedStringArray()
	for part: String in parts:
		encoded.append(part.uri_encode())
	return "/".join(encoded)


## Every file under `root` in the in-memory filesystem, sorted, as absolute paths.
static func _files_under(root: String) -> Array[String]:
	var out: Array[String] = []
	if not DirAccess.dir_exists_absolute(root):
		return out
	for name: String in DirAccess.get_files_at(root):
		out.append(root.path_join(name))
	for name: String in DirAccess.get_directories_at(root):
		out.append_array(_files_under(root.path_join(name)))
	out.sort()
	return out


func _request(method: HTTPClient.Method, path: String, body: PackedByteArray) -> Dictionary:
	return {
		"method": method, "url": path, "body_out": body, "client": null, "phase": "new",
		"code": null, "body": PackedByteArray(), "error": "",
	}


## Runs `requests` to completion, CONCURRENCY at a time, polling each once per frame (a fetch in
## the page completes only when the browser's event loop runs, so this must yield every frame).
func _run(tree: SceneTree, requests: Array[Dictionary]) -> void:
	var next: int = 0
	var active: Array[Dictionary] = []
	while next < requests.size() or not active.is_empty():
		while active.size() < CONCURRENCY and next < requests.size():
			var started: Dictionary = requests[next]
			next += 1
			_start(started)
			if started["phase"] != "done":
				active.append(started)
		var still: Array[Dictionary] = []
		for request: Dictionary in active:
			_poll(request)
			if request["phase"] != "done":
				still.append(request)
		active = still
		if not active.is_empty():
			await tree.process_frame


func _start(request: Dictionary) -> void:
	var client := HTTPClient.new()
	request["client"] = client
	var err: Error = client.connect_to_host(_host, _port)
	if err != OK:
		_done(request, "connect_to_host(%s:%d): %s" % [_host, _port, error_string(err)])
		return
	request["phase"] = "connecting"


func _poll(request: Dictionary) -> void:
	var client: HTTPClient = request["client"]
	client.poll()
	var status: HTTPClient.Status = client.get_status()
	match request["phase"]:
		"connecting":
			if status == HTTPClient.STATUS_CONNECTED:
				var headers := PackedStringArray()
				var body: PackedByteArray = request["body_out"]
				var method: HTTPClient.Method = request["method"]
				if method == HTTPClient.METHOD_PUT:
					headers.append("Content-Type: application/octet-stream")
				var url: String = request["url"]
				var err: Error = client.request_raw(method, url, headers, body)
				if err != OK:
					_done(request, "request(%s): %s" % [url, error_string(err)])
					return
				request["phase"] = "requesting"
			elif status != HTTPClient.STATUS_CONNECTING and status != HTTPClient.STATUS_RESOLVING:
				_done(request, "cannot connect (HTTPClient status %d)" % status)
		"requesting":
			if status == HTTPClient.STATUS_BODY or status == HTTPClient.STATUS_CONNECTED or status == HTTPClient.STATUS_DISCONNECTED:
				request["code"] = client.get_response_code()
				request["phase"] = "body"
				_read(request, status)
			elif status != HTTPClient.STATUS_REQUESTING:
				_done(request, "connection lost while requesting (HTTPClient status %d)" % status)
		"body":
			_read(request, status)


func _read(request: Dictionary, status: HTTPClient.Status) -> void:
	var client: HTTPClient = request["client"]
	while status == HTTPClient.STATUS_BODY:
		var chunk: PackedByteArray = client.read_response_body_chunk()
		if chunk.is_empty():
			return
		var body: PackedByteArray = request["body"]
		body.append_array(chunk)
		request["body"] = body
		client.poll()
		status = client.get_status()
	if status == HTTPClient.STATUS_CONNECTED or status == HTTPClient.STATUS_DISCONNECTED:
		_done(request, "")
	else:
		_done(request, "connection lost while reading the body (HTTPClient status %d)" % status)


func _done(request: Dictionary, error: String) -> void:
	request["error"] = error
	request["phase"] = "done"
	var client: Variant = request["client"]
	if client is HTTPClient:
		var http: HTTPClient = client
		http.close()
	request["client"] = null
