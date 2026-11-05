extends Node
## CAR6 (protocol/carrier-design.md "The RenderStreamCarrier class"): a GDScript consumer carrier
## and its one peer, in one script. It registers carrier RS_CARRIER_PEER_NAME (default `gdpeer`)
## before the capture arms, and once the carrier `started` it opens connection 1 with the hub's
## first subprotocol, sends the hello, and keeps every binary message the hub sends. A hub close
## is answered with closed(), as a WebSocket peer echoes a close. Results go to
## RS_CARRIER_PEER_OUT: peer.json and received.bin (the binary messages, concatenated), which the
## g8l/ext checker compares with the hub's tap of the connection.
##
## Also recorded, for the checker: a duplicate registration of the same name (-1), a registered
## carrier GRC_LIVE_CARRIERS does not list (`gdunlisted`: never started, destroyed at the arm), a
## registration after live started (`gdlate`: -1), a second connection beyond
## GRC_LIVE_MAX_CONNECTIONS (refused), a lookup of an unknown resource (empty), and the class's
## library_path().
##
## RS_CARRIER_PEER_SABOTAGE=drop-one keeps every binary message but the second, which the checker's
## byte comparison must catch.

const CLASS_NAME: String = "RenderStreamCarrier"

var _carrier: Object = null
var _unlisted: Object = null
var _out_dir: String = ""
var _sabotage: String = ""
var _received: PackedByteArray = PackedByteArray()
var _messages: int = 0
var _texts: Array[String] = []
var _result: Dictionary = {}
var _frame: int = 0
var _quit_frame: int = 200
var _written: bool = false


func _enter_tree() -> void:
	_out_dir = OS.get_environment("RS_CARRIER_PEER_OUT")
	_sabotage = OS.get_environment("RS_CARRIER_PEER_SABOTAGE")
	var quit: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME")
	if quit.is_valid_int():
		_quit_frame = quit.to_int()
	var carrier_name: String = OS.get_environment("RS_CARRIER_PEER_NAME")
	if carrier_name == "":
		carrier_name = "gdpeer"
	_result["name"] = carrier_name
	_result["sabotage"] = _sabotage
	_result["class"] = ClassDB.class_exists(CLASS_NAME)
	if not ClassDB.class_exists(CLASS_NAME):
		_write()
		return
	_carrier = ClassDB.instantiate(CLASS_NAME)
	_result["status_before"] = _carrier.call("status")
	var index: int = _carrier.call("register", carrier_name)
	_result["index"] = index
	_result["register_error"] = _carrier.call("last_error")
	_result["status_registered"] = _carrier.call("status")
	var duplicate: Object = ClassDB.instantiate(CLASS_NAME)
	_result["duplicate"] = duplicate.call("register", carrier_name)
	_result["duplicate_error"] = duplicate.call("last_error")
	_unlisted = ClassDB.instantiate(CLASS_NAME)
	_result["unlisted_index"] = _unlisted.call("register", "gdunlisted")
	_result["library_path"] = ClassDB.class_call_static(CLASS_NAME, "library_path")
	_carrier.connect("started", _on_started)
	_carrier.connect("stopped", _on_stopped)
	_carrier.connect("send_binary", _on_send_binary)
	_carrier.connect("send_text", _on_send_text)
	_carrier.connect("close", _on_close)


func _on_started() -> void:
	_result["started_frame"] = _frame
	var offered: String = _carrier.call("config", "subprotocols")
	_result["offered"] = offered
	var subprotocol: String = offered.split(",")[0]
	_result["subprotocol"] = subprotocol
	var opened: bool = _carrier.call("opened", 1, subprotocol, "")
	_result["opened"] = opened
	var version: String = subprotocol.trim_prefix("render-stream.")
	var hello: Dictionary = {
		"type": "hello",
		"protocol": "render-stream/" + version,
		"receiver": "carrier-ext-peer",
		"receiver_kind": "gsw-canvas",
		"credit_stage": "submitted",
		"credit_window": 1,
		"inbound_buffer_bytes": 16777216,
		"token": null,
		"manifest_sha256": null,
		"presentation_backing_w": 640,
		"presentation_backing_h": 360,
		"presentation_css_w": 640,
		"presentation_css_h": 360,
		"dpr_milli": 1000,
	}
	_carrier.call("text", 1, JSON.stringify(hello, "", false))
	# Live has started: a registration now is carrier-late.
	var late: Object = ClassDB.instantiate(CLASS_NAME)
	_result["late"] = late.call("register", "gdlate")
	_result["late_error"] = late.call("last_error")
	# GRC_LIVE_MAX_CONNECTIONS (default 1) is a total across carriers: a second connection waits.
	_result["second_open"] = _carrier.call("opened", 2, subprotocol, "")
	var missing: PackedByteArray = _carrier.call("lookup_resource", "0".repeat(64))
	_result["lookup_missing_bytes"] = missing.size()
	_result["unlisted_status"] = _unlisted.call("status")


func _on_send_binary(local: int, data: PackedByteArray) -> void:
	_messages += 1
	if local != 1:
		_result["foreign_local"] = local
		return
	if _sabotage == "drop-one" and _messages == 2:
		return
	_received.append_array(data)


func _on_send_text(_local: int, text: String) -> void:
	_texts.append(text)


func _on_close(local: int, code: int, reason: String) -> void:
	_result["close_code"] = code
	_result["close_reason"] = reason
	_result["close_frame"] = _frame
	_carrier.call("closed", local, code, reason)


func _on_stopped() -> void:
	_result["stopped"] = true
	_result["stopped_frame"] = _frame
	_result["status_stopped"] = _carrier.call("status")
	_write()


func _process(_delta: float) -> void:
	_frame += 1
	if _frame == _quit_frame:
		_write()
		get_tree().quit()


func _write() -> void:
	if _written or _out_dir == "":
		return
	_written = true
	_result["messages"] = _messages
	_result["bytes"] = _received.size()
	_result["texts"] = _texts
	if _unlisted != null:
		_result["unlisted_final_status"] = _unlisted.call("status")
	DirAccess.make_dir_recursive_absolute(_out_dir)
	var bin: FileAccess = FileAccess.open(_out_dir.path_join("received.bin"), FileAccess.WRITE)
	if bin != null:
		bin.store_buffer(_received)
		bin.close()
	var json: FileAccess = FileAccess.open(_out_dir.path_join("peer.json"), FileAccess.WRITE)
	if json != null:
		json.store_string(JSON.stringify(_result, "  ", true) + "\n")
		json.close()
	print("[carrier-peer] wrote %s (%d messages, %d bytes)" % [_out_dir, _messages, _received.size()])
