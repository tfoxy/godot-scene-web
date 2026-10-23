class_name RsResourceFetcher
extends RefCounted
## The live receiver's HTTP fetcher for out-of-band texture payloads (gate2-design.md Q5 "Apply
## order per transaction" step 2, G2c2; render-stream-2.md "HTTP (live)"): `GET <http_path><hash>`
## on the WebSocket's own loopback host and port, sequentially, on ONE keep-alive HTTPClient
## (core/io/http_client_tcp.h:73, read chunk 65536), polled from the receiver's _process so the
## rendered loop keeps presenting the previous state while a fetch runs.
##
## start(hashes) queues one transaction's misses; poll() advances them; done() is true once every
## queued hash has a result or one failed. Each result is {hash, status, bytes, data, start_us,
## end_us, delay_us, headers, error}: `start_us` is when the request was issued (after the injected
## delay), `end_us` when the body was complete, `headers` the response's Content-Type,
## Content-Length, Cache-Control and ETag. A non-200 status, a connection that cannot be made or
## that drops, and a fetch that is not complete within `timeout_ms` of its request are
## `resource-unavailable` errors; the first error stops the queue. Verification, decoding and the
## cache are RsResourceCache's (add_fetched), never this class's.
##
## G8kz (render-stream-2.md "HTTP (live)", texture-delivery-design.md D2): a native fetcher sends
## `Accept-Encoding: <accept_encoding>` ("zstd, gzip" by default; "" sends none) and decodes a
## 200 whose `Content-Encoding` is zstd or gzip with PackedByteArray.decompress_dynamic
## (FileAccess.COMPRESSION_ZSTD / COMPRESSION_GZIP; core/io/compression.cpp). Godot's HTTPClient
## decodes nothing itself (only HTTPRequest does, and only gzip/deflate). `bytes` is the decoded
## (identity) length, `wire_bytes` the body as it crossed the wire, `content_encoding` what the
## response named ("identity" when none), `decode_us` the decode time. A body that does not decode,
## or a coding the receiver did not ask for, is `resource-invalid`; the hash is verified by the
## cache on the decoded bytes, as for any payload. A browser (web fetch, or HTTPClientWeb) sends
## Accept-Encoding itself and hands over decoded bytes: `wire_bytes` is then the response's
## Content-Length (the coded length, a CORS-safelisted header) when present.
##
## Two Godot 4.5.1 HTTPClient facts this relies on (memory: godot-httpclient-framing-gotchas):
## request() needs its headers argument passed explicitly, and a bodyless response is framed by
## its explicit Content-Length: 0 (rs_ws always sends one), so the next GET on the same connection
## frames correctly.
##
## `delay_ms` (RS_RECEIVER_FETCH_DELAY_MS) is an injected wait before each fetch, timed against
## Time.get_ticks_msec(), never a blocked main loop. Nothing here touches the RenderingServer.
##
## `auth_token` (G2e, gate2-design.md D13), when non-empty, is sent as
## "Authorization: Bearer <auth_token>" on every GET. A missing or wrong token gets HTTP 401 from
## the host, which falls straight through the existing "non-200 status" rule above into
## resource-unavailable -- no separate handling needed.
##
## G7wf (protocol/gate7/g7wf.md): with `web_fetch` (the web export's default, RS_RECEIVER_WEB_FETCH
## unset or `fetch`) each GET is the browser's own fetch() through JavaScriptBridge instead of
## HTTPClient: Godot's web HTTPClient resolves each of its states on a later main-loop iteration
## (about 66 ms, four frames, per GET; G7r). The request is the one HTTPClientWeb made (GET, the
## same URL, `Authorization: Bearer` only with a token, so a token-less GET stays a CORS simple
## request; default credentials and cache). The page's promise callback records the result between
## frames (`end_us` is the body's arrival) and issues the next queued GET at once; poll() only
## enforces the timeout and the injected delay. The body reaches GDScript as one PackedByteArray
## copied straight from the response's ArrayBuffer (JavaScriptBridge.js_buffer_to_packed_byte_array),
## with no chunk appends. Results, errors and the queue rules are the HTTPClient path's.
##
## G7u (gate7-design.md D14 as amended): on the web the timeout counts only time while the page
## runs. The web main loop is rAF-driven, so a hidden or frozen page polls nothing; a gap between
## two polls of a running GET longer than SUSPEND_GAP_MS is a suspension, and the deadline moves
## by that gap. Without this a GET in flight across a 30-s freeze timed out on the first poll after
## `resume`, before its promise callback ran (the g31's frozen-30s leg). Native receivers keep the
## wall-clock deadline.

const READ_CHUNK: int = 65536
## A bound on the polls one poll() call makes (each one non-blocking).
const MAX_POLLS_PER_CALL: int = 64
## The largest decoded body a coded response may declare (a bound on a hostile frame header).
const MAX_DECODED_BYTES: int = 1 << 30
const KEPT_HEADERS: Array[String] = ["Content-Type", "Content-Length", "Cache-Control", "ETag", "Content-Encoding", "Vary"]
## A running web page polls every frame; a longer gap is the page hidden or frozen.
const SUSPEND_GAP_MS: int = 1000

var host: String = ""
var port: int = 0
var path_prefix: String = "/resources/sha256/"
var timeout_ms: int = 10000
var delay_ms: int = 0
var auth_token: String = ""
## G8kz: the Accept-Encoding value sent by the native HTTPClient path ("" = none).
var accept_encoding: String = "zstd, gzip"

var results: Array[Dictionary] = []
var error: String = ""

var _client: HTTPClient = null
## G7wf: the browser fetch path (web only) and its JavaScriptBridge objects.
var web_fetch: bool = false
var _js: JavaScriptObject = null
var _js_done: JavaScriptObject = null
var _js_abort: JavaScriptObject = null
## Bumped by cancel() and each issue, so a late promise callback of a dropped GET is ignored.
var _generation: int = 0
var _issue_frame: int = 0
var _queue: Array[String] = []
var _phase: String = "idle"  # idle | delay | connecting | requesting | body
var _current: Dictionary = {}
var _delay_until_msec: int = 0
var _deadline_msec: int = 0
var _connects: int = 0
## The last poll() of the running GET (web): the suspension rule's clock.
var _last_poll_msec: int = 0
## Suspension time not counted toward timeouts (web), in total and as gaps.
var suspended_ms: int = 0
var suspended_gaps: int = 0
## The suspension rule is in force (the web export; tests/fetcher_suspend_selftest.gd sets it).
var count_running_time_only: bool = false


func _init(target_host: String, target_port: int, prefix: String, timeout: int, delay: int, token: String = "", use_web_fetch: bool = false) -> void:
	host = target_host
	port = target_port
	path_prefix = prefix
	timeout_ms = timeout
	delay_ms = delay
	auth_token = token
	web_fetch = use_web_fetch
	count_running_time_only = RsConfig.is_web()
	if web_fetch:
		_js = _web_helper()
		_js_done = JavaScriptBridge.create_callback(_on_web_done)


## G7wf: the page's fetch helper, defined once per page. `start(url, token, gen, done)` starts one
## GET and returns its AbortController; `done(gen, status, headers_json, body, error, times_json)`
## runs in the promise's completion: status 0 and a non-empty error when fetch() rejected
## (network, CORS, abort), else the HTTP status, the kept headers under their KEPT_HEADERS
## spelling, and the body as a Uint8Array over the response's ArrayBuffer. `times_json` is the
## page clock's view of the GET, in ms after the fetch() call: `headers_ms` (the response),
## `body_ms` (the whole body) and `callback_ms` (this call), which the result keeps as `browser`.
static func _web_helper() -> JavaScriptObject:
	JavaScriptBridge.eval("""
	if (!window.__rsFetch) {
		window.__rsFetch = {
			start: function (url, token, gen, done) {
				const abort = new AbortController();
				const headers = [];
				if (token !== '') headers.push(['Authorization', 'Bearer ' + token]);
				const kept = ['Content-Type', 'Content-Length', 'Cache-Control', 'ETag', 'Content-Encoding', 'Vary'];
				const t0 = performance.now();
				let tHeaders = -1;
				let tBody = -1;
				const times = function () {
					return JSON.stringify({ headers_ms: tHeaders < 0 ? null : tHeaders - t0, body_ms: tBody < 0 ? null : tBody - t0, callback_ms: performance.now() - t0 });
				};
				fetch(url, { method: 'GET', headers: headers, signal: abort.signal })
					.then(function (res) {
						tHeaders = performance.now();
						const got = {};
						for (const name of kept) {
							const v = res.headers.get(name);
							if (v !== null) got[name] = v;
						}
						return res.arrayBuffer().then(function (buf) {
							tBody = performance.now();
							return [res.status, JSON.stringify(got), new Uint8Array(buf)];
						});
					})
					.then(function (r) { done(gen, r[0], r[1], r[2], '', times()); },
						function (err) { done(gen, 0, '{}', null, String((err && err.name) || err) + ': ' + String((err && err.message) || ''), times()); });
				return abort;
			},
		};
	}
	""", true)
	return JavaScriptBridge.get_interface("__rsFetch")


## Queues `hashes` (fetched in this order). Clears the previous results.
func start(hashes: Array[String]) -> void:
	results.clear()
	error = ""
	_queue = hashes.duplicate()
	_next()


## True when nothing is queued or running (every result is in, or an error stopped the queue).
func done() -> bool:
	return _phase == "idle"


## TCP connections made so far (1 while keep-alive holds).
func connects() -> int:
	return _connects


## Drops whatever is running or queued (a reconnect starts a fresh session).
func cancel() -> void:
	_queue.clear()
	_current = {}
	_phase = "idle"
	_web_abort()
	if _client != null:
		_client.close()
		_client = null


func _next() -> void:
	if error != "" or _queue.is_empty():
		_phase = "idle"
		return
	var hash: String = _queue.pop_front()
	_current = {
		"hash": hash, "status": null, "bytes": 0, "data": PackedByteArray(), "start_us": 0,
		"end_us": 0, "delay_us": 0, "headers": {}, "error": "",
		"wire_bytes": 0, "content_encoding": "identity", "decode_us": 0,
	}
	if delay_ms > 0:
		_delay_until_msec = Time.get_ticks_msec() + delay_ms
		_current["delay_us"] = delay_ms * 1000
		_phase = "delay"
	else:
		_issue()


func _fail(detail: String) -> void:
	_current["end_us"] = Time.get_ticks_usec()
	_current["error"] = RsWire.err("resource-unavailable", detail)
	error = _current["error"]
	results.append(_current)
	_current = {}
	_queue.clear()
	_phase = "idle"
	_web_abort()
	if _client != null:
		_client.close()
		_client = null


## Starts the current fetch: on the open connection if it is still connected, else a new one.
func _issue() -> void:
	_current["start_us"] = Time.get_ticks_usec()
	_deadline_msec = Time.get_ticks_msec() + timeout_ms
	_last_poll_msec = Time.get_ticks_msec()
	if web_fetch:
		_web_issue()
		return
	if _client != null:
		_client.poll()
		if _client.get_status() == HTTPClient.STATUS_CONNECTED:
			_request()
			return
		_client.close()
	_client = HTTPClient.new()
	_client.read_chunk_size = READ_CHUNK
	var err: Error = _client.connect_to_host(host, port)
	_connects += 1
	if err != OK:
		_fail("connect_to_host(%s:%d): %s" % [host, port, error_string(err)])
		return
	_phase = "connecting"


func _request() -> void:
	var hash: String = _current["hash"]
	# The headers argument is not optional in 4.5.1 (a parse error without it).
	var headers := PackedStringArray()
	if auth_token != "":
		headers.append("Authorization: Bearer " + auth_token)
	# A browser owns Accept-Encoding (a forbidden request header) and decodes the body itself.
	if accept_encoding != "" and not RsConfig.is_web():
		headers.append("Accept-Encoding: " + accept_encoding)
	var err: Error = _client.request(HTTPClient.METHOD_GET, path_prefix + hash, headers)
	if err != OK:
		_fail("GET %s%s: request() %s" % [path_prefix, hash, error_string(err)])
		return
	_phase = "requesting"


## Advances the running fetch; call once per _process. Within one call it keeps polling while that
## makes progress without waiting (a body chunk read, a response completed, the next GET issued on
## the open connection), and stops at the first poll that has to wait for the network or the
## delay, so a fetch costs about one frame, not one frame per HTTPClient state. Returns done().
func poll() -> bool:
	account_suspension(Time.get_ticks_msec())
	for _i: int in MAX_POLLS_PER_CALL:
		var before: String = "%s/%d/%d/%d" % [_phase, results.size(), _current_size(), _queue.size()]
		_poll_once()
		var after: String = "%s/%d/%d/%d" % [_phase, results.size(), _current_size(), _queue.size()]
		if done() or before == after:
			break
	return done()


## The suspension rule, once per poll(): a running GET's poll gap over SUSPEND_GAP_MS moves its
## deadline by the gap. Returns the gap counted as suspension (0 when none).
func account_suspension(now_msec: int) -> int:
	if not count_running_time_only or _phase == "idle" or _phase == "delay":
		return 0
	var gap: int = now_msec - _last_poll_msec
	_last_poll_msec = now_msec
	if gap <= SUSPEND_GAP_MS:
		return 0
	_deadline_msec += gap
	suspended_ms += gap
	suspended_gaps += 1
	print("[receiver] fetch: GET %s%s spanned a %d ms suspension (no poll); its timeout counts only running time" % [path_prefix, _current.get("hash", "?"), gap])
	return gap


func _current_size() -> int:
	if _current.is_empty():
		return -1
	var data: PackedByteArray = _current["data"]
	return data.size()


func _poll_once() -> bool:
	if _phase == "idle":
		return true
	if _phase == "delay":
		if Time.get_ticks_msec() >= _delay_until_msec:
			_issue()
		return done()
	if Time.get_ticks_msec() > _deadline_msec:
		_fail("GET %s%s: no complete response within %d ms (RS_RECEIVER_FETCH_TIMEOUT_MS)" % [path_prefix, _current["hash"], timeout_ms])
		return true
	if web_fetch:
		# The GET completes in its promise callback (_on_web_done), between frames.
		return done()
	_client.poll()
	var status: HTTPClient.Status = _client.get_status()
	match _phase:
		"connecting":
			if status == HTTPClient.STATUS_CONNECTED:
				_request()
			elif status != HTTPClient.STATUS_CONNECTING and status != HTTPClient.STATUS_RESOLVING:
				_fail("cannot connect to %s:%d (HTTPClient status %d)" % [host, port, status])
		"requesting":
			if status == HTTPClient.STATUS_BODY or status == HTTPClient.STATUS_CONNECTED:
				_headers_ready()
				_phase = "body"
				_read_body(status)
			elif status != HTTPClient.STATUS_REQUESTING:
				_fail("GET %s%s: connection lost while requesting (HTTPClient status %d)" % [path_prefix, _current["hash"], status])
		"body":
			_read_body(status)
	return done()


func _headers_ready() -> void:
	_current["status"] = _client.get_response_code()
	var all: Dictionary = _client.get_response_headers_as_dictionary()
	# Header names are case-insensitive: the web's HTTPClient (fetch()) reports them lowercased
	# (G7l), so each kept header is found by name in any case and recorded under KEPT_HEADERS'
	# spelling, which is what rs_ws sends natively.
	var by_lower: Dictionary = {}
	for key: Variant in all:
		var text: String = str(key)
		by_lower[text.to_lower()] = all[key]
	var kept: Dictionary = {}
	for name: String in KEPT_HEADERS:
		if all.has(name):
			kept[name] = all[name]
		elif by_lower.has(name.to_lower()):
			kept[name] = by_lower[name.to_lower()]
	_current["headers"] = kept


func _read_body(status: HTTPClient.Status) -> void:
	if status == HTTPClient.STATUS_BODY:
		var chunk: PackedByteArray = _client.read_response_body_chunk()
		if chunk.size() > 0:
			var data: PackedByteArray = _current["data"]
			data.append_array(chunk)
			_current["data"] = data
		return
	if status != HTTPClient.STATUS_CONNECTED and status != HTTPClient.STATUS_DISCONNECTED:
		_fail("GET %s%s: connection lost while reading the body (HTTPClient status %d)" % [path_prefix, _current["hash"], status])
		return
	# The response is complete (a server that closes after it leaves STATUS_DISCONNECTED; the next
	# fetch then connects again).
	var data: PackedByteArray = _current["data"]
	_current["bytes"] = data.size()
	_current["wire_bytes"] = data.size()
	_current["end_us"] = Time.get_ticks_usec()
	var code: int = _current["status"]
	if code != 200:
		_fail("GET %s%s answered HTTP %d" % [path_prefix, _current["hash"], code])
		return
	if not RsConfig.is_web() and not _decode_content_encoding():
		return
	results.append(_current)
	_current = {}
	_next()


## G8kz: decodes the current 200's body per its Content-Encoding (the native HTTPClient path).
## Returns false after _fail() when the coding is not one this fetcher asked for or the body does
## not decode.
func _decode_content_encoding() -> bool:
	var headers: Dictionary = _current["headers"]
	var coding: String = str(headers.get("Content-Encoding", "")).strip_edges().to_lower()
	if coding == "" or coding == "identity":
		return true
	var mode: int = -1
	if coding == "zstd" and accept_encoding.contains("zstd"):
		mode = FileAccess.COMPRESSION_ZSTD
	elif coding == "gzip" and accept_encoding.contains("gzip"):
		mode = FileAccess.COMPRESSION_GZIP
	var hash: String = _current["hash"]
	_current["content_encoding"] = coding
	if mode < 0:
		_fail_invalid("GET %s%s: Content-Encoding %s, which this receiver did not ask for (Accept-Encoding: %s)" % [path_prefix, hash, coding, accept_encoding])
		return false
	var start_us: int = Time.get_ticks_usec()
	var coded: PackedByteArray = _current["data"]
	var plain: PackedByteArray = PackedByteArray()
	if mode == FileAccess.COMPRESSION_ZSTD:
		var size: int = zstd_content_size(coded)
		if size > 0 and size <= MAX_DECODED_BYTES:
			plain = coded.decompress(size, mode)
			if plain.size() != size:
				plain = PackedByteArray()
	else:
		plain = coded.decompress_dynamic(MAX_DECODED_BYTES, mode)
	_current["decode_us"] = Time.get_ticks_usec() - start_us
	if plain.is_empty():
		_fail_invalid("GET %s%s: the Content-Encoding %s body (%d B) does not decode" % [path_prefix, hash, coding, coded.size()])
		return false
	_current["data"] = plain
	_current["bytes"] = plain.size()
	return true


## The Frame_Content_Size of a zstd frame (RFC 8878 3.1.1.1), or -1 when the bytes are not a zstd
## frame or its header names none.
static func zstd_content_size(frame: PackedByteArray) -> int:
	if frame.size() < 6 or frame[0] != 0x28 or frame[1] != 0xB5 or frame[2] != 0x2F or frame[3] != 0xFD:
		return -1
	var descriptor: int = frame[4]
	var single_segment: bool = (descriptor >> 5) & 1 == 1
	var field: int = descriptor >> 6
	var offset: int = 5 + (0 if single_segment else 1) + [0, 1, 2, 4][descriptor & 3]
	if field == 0 and not single_segment:
		return -1
	var width: int = 1 if field == 0 else [1, 2, 4, 8][field]
	if frame.size() < offset + width:
		return -1
	match width:
		1:
			return frame.decode_u8(offset)
		2:
			return frame.decode_u16(offset) + 256
		4:
			return frame.decode_u32(offset)
	var wide: int = frame.decode_s64(offset)
	return wide if wide > 0 else -1


## G8kz: _fail() with the resource-invalid code (a body that arrived but cannot be used).
func _fail_invalid(detail: String) -> void:
	_fail(detail)
	var failed: Dictionary = results[results.size() - 1]
	failed["error"] = RsWire.err("resource-invalid", detail)
	error = failed["error"]


## G7wf: issues the current GET through the page's fetch(). The URL is the one HTTPClientWeb built
## (http://<host>:<port><path>, an IPv6 literal bracketed).
func _web_issue() -> void:
	_generation += 1
	_issue_frame = Engine.get_process_frames()
	var hash: String = _current["hash"]
	var authority: String = ("[%s]" % host if host.contains(":") else host) + ":%d" % port
	_js_abort = _js.call("start", "http://" + authority + path_prefix + hash, auth_token, _generation, _js_done)
	_phase = "requesting"


## G7wf: aborts the GET in flight, if any; its callback is then ignored (a stale generation).
func _web_abort() -> void:
	if not web_fetch:
		return
	_generation += 1
	if _js_abort != null:
		_js_abort.call("abort")
		_js_abort = null


## G7wf: the promise callback of one GET: [gen, status, headers_json, body, error, times_json].
func _on_web_done(args: Array) -> void:
	if args.size() < 6 or RsWire.as_int(args[0]) != _generation or _phase != "requesting" or _current.is_empty():
		return
	_js_abort = null
	var end_us: int = Time.get_ticks_usec()
	var times: Variant = JSON.parse_string(str(args[5]))
	if times is Dictionary:
		var browser: Dictionary = times
		# Main-loop iterations begun between the fetch() call and this callback.
		browser["process_frames"] = Engine.get_process_frames() - _issue_frame
		_current["browser"] = browser
	var failure: String = str(args[4])
	if failure != "":
		_fail("GET %s%s: fetch() rejected (%s)" % [path_prefix, _current["hash"], failure])
		return
	var code: int = RsWire.as_int(args[1])
	_current["status"] = code
	var parsed: Variant = JSON.parse_string(str(args[2]))
	_current["headers"] = parsed if parsed is Dictionary else {}
	var data := PackedByteArray()
	var body: Variant = args[3]
	if body is JavaScriptObject:
		var js_body: JavaScriptObject = body
		data = JavaScriptBridge.js_buffer_to_packed_byte_array(js_body)
	_current["data"] = data
	_current["bytes"] = data.size()
	_current["end_us"] = end_us
	var headers_seen: Dictionary = _current["headers"]
	# The browser decoded the body already: the coding is not exposed cross-origin ("unknown"),
	# the Content-Length header (CORS-safelisted) is the coded length.
	_current["content_encoding"] = str(headers_seen["Content-Encoding"]).to_lower() if headers_seen.has("Content-Encoding") else "unknown"
	_current["wire_bytes"] = str(headers_seen["Content-Length"]).to_int() if headers_seen.has("Content-Length") and str(headers_seen["Content-Length"]).is_valid_int() else data.size()
	if code != 200:
		_fail("GET %s%s answered HTTP %d" % [path_prefix, _current["hash"], code])
		return
	results.append(_current)
	_current = {}
	_next()
