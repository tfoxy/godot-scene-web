extends SceneTree
## HTTPClient interop self-test for rs_ws's HTTP GET resource serving
## (capture/src/rs_ws.h, protocol/gate2-design.md G2c1), against the same
## test-only echo server capture/test/rs_ws_echo.cpp that ws_selftest.gd
## drives (its header documents the fixed test hashes used below -- labels
## for a handful of deterministic bodies, not real content hashes of them).
##
##   RS_WS_ECHO_PORT=<port> mise exec -- godot --headless \
##     --path experiments/render-stream/receiver --script res://tests/http_selftest.gd
##
## Three sequential GETs on one HTTPClient connection (proving keep-alive,
## gate2-design.md G2c1 "Pass criteria"): the 1 MiB resource, the 8 MiB one,
## then a well-formed but unregistered hash. For each 200, checks
## Content-Type, Cache-Control, ETag, that the body arrives byte-exact
## against rs_ws_echo's byte[i] = i % 251 pattern, and that the body's own
## SHA-256 (via HashingContext) matches the SHA-256 of that same
## independently-generated pattern -- a second, independent way to show the
## bytes are exactly right, not just the same length. The third request
## checks 404 with an empty body.
##
## Prints "[http-selftest] ok" and quits 0, or prints each failure and quits 1.

const RESOURCE_PREFIX: String = "/resources/sha256/"
const ONE_MIB: int = 1 * 1024 * 1024
const EIGHT_MIB: int = 8 * 1024 * 1024
const CONNECT_TIMEOUT_MS: int = 10000
const REQUEST_TIMEOUT_MS: int = 30000

var _failures: Array[String] = []
var _port: int = 0
var _state: String = "start"
var _deadline_msec: int = 0
var _http: HTTPClient = null
var _body: PackedByteArray = PackedByteArray()

var _step_hashes: Array[String] = []
var _step_lengths: Array[int] = []
var _step_expected_status: Array[int] = []
var _step_index: int = 0


func _initialize() -> void:
	var port_str: String = OS.get_environment("RS_WS_ECHO_PORT")
	if port_str == "" or not port_str.is_valid_int():
		_fail_now("RS_WS_ECHO_PORT must be set to rs_ws_echo's bound port (got %s)" % port_str)
		return
	_port = port_str.to_int()

	var hash_1mib: String = "1".repeat(64)
	var hash_8mib: String = "8".repeat(63) + "a"
	var hash_unknown: String = "f".repeat(64)
	_step_hashes = [hash_1mib, hash_8mib, hash_unknown]
	_step_lengths = [ONE_MIB, EIGHT_MIB, 0]
	_step_expected_status = [200, 200, 404]

	process_frame.connect(_tick)


func _check(condition: Variant, what: String) -> void:
	if not condition:
		_failures.append(what)


func _fail_now(what: String) -> void:
	_failures.append(what)
	_finish()


func _finish() -> void:
	if _failures.is_empty():
		print("[http-selftest] ok")
		quit(0)
	else:
		for failure: String in _failures:
			print("[http-selftest] FAIL: " + failure)
		print("[http-selftest] %d failure(s)" % _failures.size())
		quit(1)


static func _resource_pattern(length: int) -> PackedByteArray:
	var out := PackedByteArray()
	out.resize(length)
	for i: int in length:
		out[i] = i % 251
	return out


static func _sha256_hex(bytes: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	return ctx.finish().hex_encode()


func _begin_request() -> void:
	var step_hash: String = _step_hashes[_step_index]
	var err: Error = _http.request(HTTPClient.METHOD_GET, RESOURCE_PREFIX + step_hash, PackedStringArray())
	_check(err == OK, "step %d request() returned OK (got %s)" % [_step_index, error_string(err)])
	_body = PackedByteArray()
	_deadline_msec = Time.get_ticks_msec() + REQUEST_TIMEOUT_MS
	_state = "requesting"


func _on_headers_ready() -> void:
	_check(_http.has_response(), "step %d has a response" % _step_index)
	var code: int = _http.get_response_code()
	var expected_code: int = _step_expected_status[_step_index]
	_check(code == expected_code, "step %d status %d (got %d)" % [_step_index, expected_code, code])
	if code == 200:
		var headers: Dictionary = _http.get_response_headers_as_dictionary()
		_check(headers.get("Content-Type", "") == "application/octet-stream",
			"step %d Content-Type (got %s)" % [_step_index, headers.get("Content-Type", "")])
		_check(headers.get("Cache-Control", "") == "private, max-age=31536000, immutable",
			"step %d Cache-Control (got %s)" % [_step_index, headers.get("Cache-Control", "")])
		var step_hash: String = _step_hashes[_step_index]
		var want_etag: String = "\"%s\"" % step_hash
		_check(headers.get("ETag", "") == want_etag,
			"step %d ETag (got %s, want %s)" % [_step_index, headers.get("ETag", ""), want_etag])
	_deadline_msec = Time.get_ticks_msec() + REQUEST_TIMEOUT_MS


func _on_body_complete() -> void:
	var expected_len: int = _step_lengths[_step_index]
	_check(_body.size() == expected_len,
		"step %d body length (got %d, want %d)" % [_step_index, _body.size(), expected_len])
	if _step_expected_status[_step_index] == 200:
		var expected: PackedByteArray = _resource_pattern(expected_len)
		_check(_body == expected, "step %d body byte-exact against byte[i] = i %% 251" % _step_index)
		var got_hash: String = _sha256_hex(_body)
		var want_hash: String = _sha256_hex(expected)
		_check(got_hash == want_hash,
			"step %d SHA-256 via HashingContext matches (got %s, want %s)" % [_step_index, got_hash, want_hash])
	else:
		_check(_body.is_empty(), "step %d (%d) body is empty" % [_step_index, _step_expected_status[_step_index]])

	_step_index += 1
	if _step_index >= _step_hashes.size():
		_http.close()
		_finish()
	else:
		# Same HTTPClient instance, same TCP connection: status is STATUS_CONNECTED right now
		# (that is why this branch runs), and HTTPClient.request() only accepts that status --
		# this is the keep-alive proof (gate2-design.md G2c1 "two requests on one keep-alive
		# connection"), run here across all three steps rather than just two.
		_begin_request()


func _tick() -> void:
	match _state:
		"start":
			_http = HTTPClient.new()
			var err: Error = _http.connect_to_host("127.0.0.1", _port)
			_check(err == OK, "connect_to_host returned OK (got %s)" % error_string(err))
			_deadline_msec = Time.get_ticks_msec() + CONNECT_TIMEOUT_MS
			_state = "connecting"
		"connecting":
			_http.poll()
			var status: HTTPClient.Status = _http.get_status()
			if status == HTTPClient.STATUS_CONNECTED:
				_begin_request()
			elif status == HTTPClient.STATUS_CONNECTING or status == HTTPClient.STATUS_RESOLVING:
				if Time.get_ticks_msec() > _deadline_msec:
					_fail_now("did not connect within %d ms" % CONNECT_TIMEOUT_MS)
			else:
				_fail_now("unexpected status while connecting: %d" % status)
		"requesting":
			_http.poll()
			var status: HTTPClient.Status = _http.get_status()
			if status == HTTPClient.STATUS_REQUESTING:
				if Time.get_ticks_msec() > _deadline_msec:
					_fail_now("step %d: request did not complete within %d ms" % [_step_index, REQUEST_TIMEOUT_MS])
			elif status == HTTPClient.STATUS_BODY or status == HTTPClient.STATUS_CONNECTED:
				_on_headers_ready()
				_state = "body"
			else:
				_fail_now("step %d: unexpected status after request: %d" % [_step_index, status])
		"body":
			_http.poll()
			var status: HTTPClient.Status = _http.get_status()
			if status == HTTPClient.STATUS_BODY:
				var chunk: PackedByteArray = _http.read_response_body_chunk()
				if chunk.size() > 0:
					_body.append_array(chunk)
				if Time.get_ticks_msec() > _deadline_msec:
					_fail_now("step %d: body did not complete within %d ms" % [_step_index, REQUEST_TIMEOUT_MS])
			elif status == HTTPClient.STATUS_CONNECTED:
				_on_body_complete()
			else:
				_fail_now("step %d: unexpected status while reading body: %d" % [_step_index, status])
		_:
			_fail_now("unknown state %s" % _state)
