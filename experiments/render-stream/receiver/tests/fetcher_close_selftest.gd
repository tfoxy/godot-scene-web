extends SceneTree
## A local relay-shaped HTTP stub, plus a keep-alive control and premature EOF cases.
## No capture host, credentials, renderer or external server is required.

var _server := TCPServer.new()
var _peer: StreamPeerTCP
var _request := PackedByteArray()
var _response := PackedByteArray()
var _sent: int = 0
var _served: int = 0
var _failures: int = 0
var _checks: int = 0
var _body := PackedByteArray()
var _mode: String = "length"


func _initialize() -> void:
	if _server.listen(0, "127.0.0.1") != OK:
		print("[fetcher-close-selftest] FAIL: cannot listen on loopback")
		quit(1)
		return
	for i: int in 131101:
		_body.append(i % 251)
	_run.call_deferred()


func _process(_delta: float) -> bool:
	if _peer == null and _server.is_connection_available():
		_peer = _server.take_connection()
		_request.clear()
		_response.clear()
		_sent = 0
	if _peer == null:
		return false
	_peer.poll()
	if _response.is_empty():
		var available: int = _peer.get_available_bytes()
		if available > 0:
			var got: Array = _peer.get_partial_data(available)
			var bytes: PackedByteArray = got[1]
			_request.append_array(bytes)
		if not _request.get_string_from_ascii().contains("\r\n\r\n"):
			return false
		var data: PackedByteArray = _body.compress(FileAccess.COMPRESSION_GZIP) if _mode == "gzip" else _body
		var framing: String = "Content-Length: %d\r\n" % data.size()
		if _mode == "chunked" or _mode == "truncated-chunked":
			framing = "Transfer-Encoding: chunked\r\n"
			data = ("%x\r\n" % data.size()).to_ascii_buffer() + data + "\r\n0\r\n\r\n".to_ascii_buffer()
			if _mode == "truncated-chunked":
				data = data.slice(0, data.size() - 5)
		elif _mode == "eof":
			framing = ""
		elif _mode == "truncated":
			framing = "Content-Length: %d\r\n" % (data.size() + 100)
		elif _mode == "empty":
			framing = "Content-Length: 0\r\n"
			data = PackedByteArray()
		if _mode == "gzip":
			framing += "Content-Encoding: gzip\r\n"
		var connection: String = "keep-alive" if _mode == "keep-alive" else "close"
		_response = ("HTTP/1.1 200 OK\r\nConnection: " + connection + "\r\n" + framing + "\r\n").to_ascii_buffer() + data
	var wrote: Array = _peer.put_partial_data(_response.slice(_sent))
	_sent += RsWire.as_int(wrote[1])
	if _sent == _response.size():
		_served += 1
		if _mode == "keep-alive":
			_request.clear()
			_response.clear()
			_sent = 0
		else:
			_peer.disconnect_from_host()
			_peer = null
	return false


func _check(label: String, ok: bool, detail: String = "") -> void:
	_checks += 1
	if not ok:
		_failures += 1
		print("[fetcher-close-selftest] FAIL: %s %s" % [label, detail])


## HTTPClientWeb ends even complete chunked bodies in DISCONNECTED. Inject that platform
## and terminal state without a browser; the socket cases below exercise HTTPClientTCP.
func _check_disconnected_body() -> void:
	for web: bool in [false, true]:
		for framing: String in ["chunked", "length", "truncated-length"]:
			var label: String = ("web " if web else "native ") + framing
			# Delay issuing so the test supplies the completed response without opening a socket.
			var fetcher := RsResourceFetcher.new("127.0.0.1", 0, "/resources/sha256/", 5000, 10000)
			fetcher._httpclient_web = web
			fetcher.start(["a".repeat(64)])
			fetcher._phase = "body"
			fetcher._current["status"] = 200
			fetcher._current["data"] = _body
			fetcher._current["chunked"] = framing == "chunked"
			fetcher._current["body_length"] = -1 if framing == "chunked" else _body.size() + (1 if framing == "truncated-length" else 0)
			fetcher._read_body(HTTPClient.STATUS_DISCONNECTED)
			var truncated: bool = framing == "truncated-length" or (framing == "chunked" and not web)
			_check(label + " completes queue", fetcher.done() and fetcher.results.size() == 1)
			if truncated:
				_check(label + " refuses truncation", fetcher.error.begins_with("resource-unavailable") and fetcher.error.contains("truncated response body"), fetcher.error)
			else:
				_check(label + " succeeds", fetcher.error == "", fetcher.error)
				for row: Dictionary in fetcher.results:
					var exact: bool = row["error"] == "" and row["data"] == _body and row["bytes"] == _body.size()
					_check(label + " exact body", exact)
			fetcher.cancel()


func _run() -> void:
	_check_disconnected_body()
	for mode: String in ["length", "chunked", "gzip", "empty", "eof", "truncated", "truncated-chunked", "keep-alive"]:
		_mode = mode
		_served = 0
		var fetcher := RsResourceFetcher.new("127.0.0.1", _server.get_local_port(), "/resources/sha256/", 5000, 0)
		var hashes: Array[String] = ["a".repeat(64), "b".repeat(64)]
		fetcher.start(hashes)
		while not fetcher.done():
			await process_frame
			fetcher.poll()
		if mode.begins_with("truncated"):
			_check(mode + " is refused", fetcher.error.begins_with("resource-unavailable"), fetcher.error)
			_check(mode + " stops queue", fetcher.results.size() == 1 and _served == 1)
		else:
			_check(mode + " succeeds", fetcher.error == "", fetcher.error)
			var expected_connects: int = 1 if mode == "keep-alive" else 2
			_check(mode + " connection count", fetcher.results.size() == 2 and fetcher.connects() == expected_connects and _served == 2)
			for row: Dictionary in fetcher.results:
				var expected: PackedByteArray = PackedByteArray() if mode == "empty" else _body
				var exact: bool = row["error"] == "" and row["data"] == expected
				_check(mode + " exact body", exact)
		fetcher.cancel()
		if _peer != null:
			_peer.disconnect_from_host()
			_peer = null
	_server.stop()
	print("[fetcher-close-selftest] %d checks, %d failed" % [_checks, _failures])
	quit(0 if _failures == 0 else 1)
