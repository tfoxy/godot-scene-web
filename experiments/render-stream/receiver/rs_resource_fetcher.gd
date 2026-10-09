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

const READ_CHUNK: int = 65536
## A bound on the polls one poll() call makes (each one non-blocking).
const MAX_POLLS_PER_CALL: int = 64
const KEPT_HEADERS: Array[String] = ["Content-Type", "Content-Length", "Cache-Control", "ETag"]

var host: String = ""
var port: int = 0
var path_prefix: String = "/resources/sha256/"
var timeout_ms: int = 10000
var delay_ms: int = 0
var auth_token: String = ""

var results: Array[Dictionary] = []
var error: String = ""

var _client: HTTPClient = null
var _queue: Array[String] = []
var _phase: String = "idle"  # idle | delay | connecting | requesting | body
var _current: Dictionary = {}
var _delay_until_msec: int = 0
var _deadline_msec: int = 0
var _connects: int = 0


func _init(target_host: String, target_port: int, prefix: String, timeout: int, delay: int, token: String = "") -> void:
	host = target_host
	port = target_port
	path_prefix = prefix
	timeout_ms = timeout
	delay_ms = delay
	auth_token = token


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
	}
	if delay_ms > 0:
		_delay_until_msec = Time.get_ticks_msec() + delay_ms
		_current["delay_us"] = delay_ms * 1000
		_phase = "delay"
	else:
		_issue()


func _fail(detail: String) -> void:
	_current["end_us"] = Time.get_ticks_usec()
	_current["error"] = Rs2Decoder.err("resource-unavailable", detail)
	error = _current["error"]
	results.append(_current)
	_current = {}
	_queue.clear()
	_phase = "idle"
	if _client != null:
		_client.close()
		_client = null


## Starts the current fetch: on the open connection if it is still connected, else a new one.
func _issue() -> void:
	_current["start_us"] = Time.get_ticks_usec()
	_deadline_msec = Time.get_ticks_msec() + timeout_ms
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
	for _i: int in MAX_POLLS_PER_CALL:
		var before: String = "%s/%d/%d/%d" % [_phase, results.size(), _current_size(), _queue.size()]
		_poll_once()
		var after: String = "%s/%d/%d/%d" % [_phase, results.size(), _current_size(), _queue.size()]
		if done() or before == after:
			break
	return done()


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
	var kept: Dictionary = {}
	for name: String in KEPT_HEADERS:
		if all.has(name):
			kept[name] = all[name]
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
	_current["end_us"] = Time.get_ticks_usec()
	var code: int = _current["status"]
	if code != 200:
		_fail("GET %s%s answered HTTP %d" % [path_prefix, _current["hash"], code])
		return
	results.append(_current)
	_current = {}
	_next()
