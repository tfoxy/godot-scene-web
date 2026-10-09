extends SceneTree
## WebSocketPeer interop self-test for rs_ws (capture/src/rs_ws.h), against the
## test-only echo server capture/test/rs_ws_echo.cpp (protocol/gate1-design.md
## G1c1 "Pass criteria", Godot interop).
##
##   RS_WS_ECHO_PORT=<port> mise exec -- godot --headless \
##     --path experiments/render-stream/receiver --script res://tests/ws_selftest.gd
##
## rs_ws_echo's tiny test protocol (not part of render-stream/1): a text
## message that is all ASCII digits requests a binary push of that many
## bytes, deterministic as byte[i] = i % 256; anything else is echoed back
## as text verbatim.
##
## Two connections, run one after the other as a per-frame state machine
## (connecting and receiving a multi-megabyte message both take more than
## one frame):
##   1. inbound_buffer_size raised to 16 MiB *before* connect_to_url: a text
##      echo, then an 8 MiB binary push checked byte-exact.
##   2. inbound_buffer_size left at its default 65535
##      (modules/websocket/wsl_peer.cpp:70-71): a 1 MiB push closes the
##      connection with 1009, recording the engine's own limit
##      (wsl_peer.cpp:405-410).
##
## Prints "[ws-selftest] ok" and quits 0, or prints each failure and quits 1.

const SUBPROTOCOL: String = "render-stream.1"
const PATH: String = "/render-stream"
const LARGE_INBOUND_BUFFER: int = 16 * 1024 * 1024
const BIG_PUSH_BYTES: int = 8 * 1024 * 1024
const OVERSIZE_PUSH_BYTES: int = 1 * 1024 * 1024
const CONNECT_TIMEOUT_MS: int = 10000
const REPLY_TIMEOUT_MS: int = 20000

var _failures: Array[String] = []
var _port: int = 0
var _state: String = "start"
var _deadline_msec: int = 0
var _peer: WebSocketPeer = null


func _initialize() -> void:
	var port_str: String = OS.get_environment("RS_WS_ECHO_PORT")
	if port_str == "" or not port_str.is_valid_int():
		_fail_now("RS_WS_ECHO_PORT must be set to rs_ws_echo's bound port (got %s)" % port_str)
		return
	_port = port_str.to_int()
	process_frame.connect(_tick)


func _check(condition: Variant, what: String) -> void:
	if not condition:
		_failures.append(what)


func _fail_now(what: String) -> void:
	_failures.append(what)
	_finish()


func _finish() -> void:
	if _failures.is_empty():
		print("[ws-selftest] ok")
		quit(0)
	else:
		for failure: String in _failures:
			print("[ws-selftest] FAIL: " + failure)
		print("[ws-selftest] %d failure(s)" % _failures.size())
		quit(1)


func _new_peer(inbound_buffer_size: int) -> WebSocketPeer:
	var peer := WebSocketPeer.new()
	if inbound_buffer_size > 0:
		peer.inbound_buffer_size = inbound_buffer_size
	peer.supported_protocols = PackedStringArray([SUBPROTOCOL])
	var url: String = "ws://127.0.0.1:%d%s" % [_port, PATH]
	var err: Error = peer.connect_to_url(url)
	_check(err == OK, "connect_to_url(%s) returned OK (got %s)" % [url, error_string(err)])
	return peer


func _expected_byte(i: int) -> int:
	return i % 256


func _check_deterministic_payload(data: PackedByteArray, expected_len: int, what: String) -> void:
	_check(data.size() == expected_len, "%s: length %d, expected %d" % [what, data.size(), expected_len])
	var mismatches: int = 0
	var first_bad: int = -1
	var n: int = mini(data.size(), expected_len)
	for i: int in n:
		if data[i] != _expected_byte(i):
			mismatches += 1
			if first_bad == -1:
				first_bad = i
	_check(mismatches == 0, "%s: byte-exact (first mismatch at %d, %d total mismatches)" % [what, first_bad, mismatches])


## Advances the state machine by one frame. Each state polls its peer, checks
## whatever became available, and either stays (waiting for more), advances,
## or fails on timeout.
func _tick() -> void:
	match _state:
		"start":
			_peer = _new_peer(LARGE_INBOUND_BUFFER)
			_deadline_msec = Time.get_ticks_msec() + CONNECT_TIMEOUT_MS
			_state = "connecting_1"
		"connecting_1":
			_peer.poll()
			var ready_state: int = _peer.get_ready_state()
			if ready_state == WebSocketPeer.STATE_OPEN:
				_check(_peer.get_selected_protocol() == SUBPROTOCOL,
					"connection 1 subprotocol (got %s)" % _peer.get_selected_protocol())
				_check(_peer.send_text("hello from godot") == OK, "connection 1 send_text(hello) == OK")
				_deadline_msec = Time.get_ticks_msec() + REPLY_TIMEOUT_MS
				_state = "await_text_echo"
			elif ready_state == WebSocketPeer.STATE_CLOSED:
				_fail_now("connection 1 closed while connecting (code %d)" % _peer.get_close_code())
			elif Time.get_ticks_msec() > _deadline_msec:
				_fail_now("connection 1 did not open within %d ms" % CONNECT_TIMEOUT_MS)
		"await_text_echo":
			_peer.poll()
			if _peer.get_available_packet_count() > 0:
				var packet: PackedByteArray = _peer.get_packet()
				var was_text: bool = _peer.was_string_packet()
				_check(was_text, "text echo arrives as a text packet")
				_check(packet.get_string_from_utf8() == "hello from godot",
					"text echoed verbatim (got %s)" % packet.get_string_from_utf8())
				_check(_peer.send_text(str(BIG_PUSH_BYTES)) == OK, "connection 1 request big push == OK")
				_deadline_msec = Time.get_ticks_msec() + REPLY_TIMEOUT_MS
				_state = "await_big_push"
			elif Time.get_ticks_msec() > _deadline_msec:
				_fail_now("no text echo within %d ms" % REPLY_TIMEOUT_MS)
		"await_big_push":
			_peer.poll()
			if _peer.get_available_packet_count() > 0:
				var packet: PackedByteArray = _peer.get_packet()
				var was_text: bool = _peer.was_string_packet()
				_check(not was_text, "big push arrives as a binary packet")
				_check_deterministic_payload(packet, BIG_PUSH_BYTES, "8 MiB push on a 16 MiB inbound buffer")
				_peer.close(1000, "self-test done")
				_deadline_msec = Time.get_ticks_msec() + REPLY_TIMEOUT_MS
				_state = "closing_1"
			elif _peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
				_fail_now("connection 1 closed before the 8 MiB push arrived (code %d)" % _peer.get_close_code())
			elif Time.get_ticks_msec() > _deadline_msec:
				_fail_now("8 MiB push did not arrive within %d ms" % REPLY_TIMEOUT_MS)
		"closing_1":
			_peer.poll()
			if _peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
				_peer = _new_peer(0)  # leave inbound_buffer_size at its 65535 default.
				_deadline_msec = Time.get_ticks_msec() + CONNECT_TIMEOUT_MS
				_state = "connecting_2"
			elif Time.get_ticks_msec() > _deadline_msec:
				_fail_now("connection 1 did not reach STATE_CLOSED within %d ms" % REPLY_TIMEOUT_MS)
		"connecting_2":
			_peer.poll()
			var ready_state: int = _peer.get_ready_state()
			if ready_state == WebSocketPeer.STATE_OPEN:
				_check(_peer.get_inbound_buffer_size() == 65535,
					"connection 2 kept the engine default inbound_buffer_size (got %d)" % _peer.get_inbound_buffer_size())
				_check(_peer.send_text(str(OVERSIZE_PUSH_BYTES)) == OK, "connection 2 request oversize push == OK")
				_deadline_msec = Time.get_ticks_msec() + REPLY_TIMEOUT_MS
				_state = "await_oversize_close"
			elif ready_state == WebSocketPeer.STATE_CLOSED:
				_fail_now("connection 2 closed while connecting (code %d)" % _peer.get_close_code())
			elif Time.get_ticks_msec() > _deadline_msec:
				_fail_now("connection 2 did not open within %d ms" % CONNECT_TIMEOUT_MS)
		"await_oversize_close":
			_peer.poll()
			if _peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
				_check(_peer.get_close_code() == 1009,
					"a message over the default inbound_buffer_size closes with 1009 (got %d)" % _peer.get_close_code())
				_finish()
			elif Time.get_ticks_msec() > _deadline_msec:
				_fail_now("connection 2 did not close within %d ms of the oversize push" % REPLY_TIMEOUT_MS)
		_:
			_fail_now("unknown state %s" % _state)
