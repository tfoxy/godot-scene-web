class_name RsLiveClient
extends RefCounted
## The receiver's side of render-stream/6 live transport (render-stream-6.md, since G6b;
## render-stream-5.md from G55d; render-stream-4.md "Live transport" from G5d; render-stream-3.md "Live transport" from G4e2;
## render-stream-2.md "Live transport"; gate1-design.md "Q2f", "Q5. Receiver", "G1c2"): a WebSocketPeer client, the control messages it
## sends (hello, ack, resync) and the one the host may send (error). Since G7l it also speaks
## render-stream/7 (render-stream-7.md, gate7-design.md Q2/Q4): `open(..., wire_version = 7)` offers
## subprotocol render-stream.7 and hello_v7 carries the token, the credit window, the manifest and
## the presentation integers. The receiver picks the version (RS_RECEIVER_PROTOCOL; a web export
## speaks only /7); every /6 byte is unchanged. G8g: `wire_version` 8 is render-stream/8's live
## transport (render-stream-8.md "Live transport"): /7's, with subprotocol render-stream.8 and the
## hello's protocol "render-stream/8"; a gate 8 host offers only .8.
##
## Two engine facts this class exists to get right:
## - The inbound buffer is allocated at handshake time and is also wslay's maximum message length
##   (modules/websocket/wsl_peer.cpp:405-410), so `inbound_buffer_size` is set BEFORE
##   connect_to_url, and the same value is announced in `hello` so the host never sends more.
## - WebSocketPeer.was_string_packet() describes the packet most recently returned by get_packet(),
##   not the next one: take_packets() calls get_packet() first and only then asks.
##
## Control messages are compact JSON with the documented key order (JSON.stringify with
## sort_keys false); the host accepts any order. Nothing here touches the RenderingServer.

const SUBPROTOCOL: String = "render-stream.6"
const PROTOCOL: String = "render-stream/6"
## render-stream/7 (G7l, gate7-design.md Q2/Q4 "Live client"): the subprotocol and the hello of a
## /7 connection. A /7 client offers only "render-stream.7" and carries its token in the hello,
## never in an Authorization header on the upgrade (a browser's WebSocket cannot set one).
const SUBPROTOCOL_V7: String = "render-stream.7"
const PROTOCOL_V7: String = "render-stream/7"
## render-stream/9 (G8kp, render-stream-9.md "Live transport"): /7's transport and hello plus the
## two delivery keys.
const SUBPROTOCOL_V9: String = "render-stream.9"
const PROTOCOL_V9: String = "render-stream/9"
## render-stream/10 (CG1, render-stream-10.md "Live transport"): /9's transport and hello under
## protocol render-stream/10.
const SUBPROTOCOL_V10: String = "render-stream.10"
const PROTOCOL_V10: String = "render-stream/10"
## W11d: render-stream/11 (render-stream-11.md "Live transport"): /10's transport under .11.
const SUBPROTOCOL_V11: String = "render-stream.11"
const PROTOCOL_V11: String = "render-stream/11"
## PM5: render-stream/12 (render-stream-12.md "Opt-in and version policy"): /11's transport (W11t's
## coding included) under .12.
const SUBPROTOCOL_V12: String = "render-stream.12"
const PROTOCOL_V12: String = "render-stream/12"
## W13d: render-stream/13 (render-stream-13.md "As built (W13a)"): /12's transport and hello under
## .13 and "render-stream/13".
const SUBPROTOCOL_V13: String = "render-stream.13"
const PROTOCOL_V13: String = "render-stream/13"
const SUBPROTOCOL_V8: String = "render-stream.8"
const PROTOCOL_V8: String = "render-stream/8"
const CREDIT_STAGES: Array[String] = ["submitted", "applied"]
const ACK_STAGES: Array[String] = ["received", "applied", "submitted"]

var peer: WebSocketPeer = null
var url: String = ""
var inbound_buffer_bytes: int = 0
## 6 to 13: the subprotocol offered and the hello sent (RS_RECEIVER_PROTOCOL).
var version: int = 6


## Starts connecting. `token` (G2e, gate2-design.md D13), when non-empty, is sent as
## "Authorization: Bearer <token>" on the upgrade request (WebSocketPeer.handshake_headers,
## modules/websocket/wsl_peer.cpp:551-552), set before connect_to_url like inbound_buffer_size --
## both are fixed at handshake time. A missing or wrong token gets HTTP 401 from the host, which
## this peer surfaces only as never reaching STATE_OPEN (Godot's WebSocketPeer exposes no HTTP
## status for a failed handshake); the caller's existing connect-timeout handling already covers
## that as replay-failure live-connect-failed. Returns connect_to_url()'s error.
##
## `wire_version` 7 (G7l) offers only "render-stream.7" and never sends the header: the /7 token
## travels in the hello (hello_v7), and a null or wrong one is answered with error `unauthorized`
## and close 1008 after the upgrade (render-stream-7.md, G7n).
func open(target_url: String, inbound_bytes: int, token: String = "", wire_version: int = 6) -> Error:
	url = target_url
	inbound_buffer_bytes = inbound_bytes
	version = wire_version
	peer = WebSocketPeer.new()
	# Before connect_to_url: the buffer (and wslay's message cap) is fixed at handshake time.
	peer.inbound_buffer_size = inbound_bytes
	if version == 7:
		peer.supported_protocols = PackedStringArray([SUBPROTOCOL_V7])
	elif version == 8:
		# G8g: a /8 client offers only render-stream.8 (a gate 8 policy host offers only .8); /7's transport.
		peer.supported_protocols = PackedStringArray([SUBPROTOCOL_V8])
	elif version == 9:
		# G8kp: a /9 client (texture delivery) offers only render-stream.9; /7's transport.
		peer.supported_protocols = PackedStringArray([SUBPROTOCOL_V9])
	elif version == 10:
		# CG1: a /10 client offers only render-stream.10; /9's transport.
		peer.supported_protocols = PackedStringArray([SUBPROTOCOL_V10])
	elif version == 11:
		# W11d: a /11 client offers only render-stream.11; /10's transport.
		peer.supported_protocols = PackedStringArray([SUBPROTOCOL_V11])
	elif version == 12:
		# PM5: a /12 client offers only render-stream.12; /11's transport.
		peer.supported_protocols = PackedStringArray([SUBPROTOCOL_V12])
	elif version == 13:
		# W13d: a /13 client offers only render-stream.13; /12's transport.
		peer.supported_protocols = PackedStringArray([SUBPROTOCOL_V13])
	else:
		peer.supported_protocols = PackedStringArray([SUBPROTOCOL])
		if token != "":
			peer.handshake_headers = PackedStringArray(["Authorization: Bearer " + token])
	return peer.connect_to_url(target_url)


func poll() -> void:
	if peer != null:
		peer.poll()


func state() -> WebSocketPeer.State:
	if peer == null:
		return WebSocketPeer.STATE_CLOSED
	return peer.get_ready_state()


## Every packet available now, in order: {binary: bool, data: PackedByteArray}.
func take_packets() -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	if peer == null:
		return out
	while peer.get_available_packet_count() > 0:
		var data: PackedByteArray = peer.get_packet()
		# was_string_packet() refers to the packet get_packet() just returned.
		var is_text: bool = peer.was_string_packet()
		out.append({"binary": not is_text, "data": data})
	return out


## Sends one control message as a text frame.
func send(message: Dictionary) -> Error:
	if peer == null or peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return ERR_CONNECTION_ERROR
	return peer.send_text(encode(message))


func close(code: int, reason: String) -> void:
	if peer != null and peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
		peer.close(code, reason)


func close_code() -> int:
	return peer.get_close_code() if peer != null else -1


func close_reason() -> String:
	return peer.get_close_reason() if peer != null else ""


static func encode(message: Dictionary) -> String:
	return JSON.stringify(message, "", false)


static func hello(receiver: String, credit_stage: String, inbound_bytes: int) -> Dictionary:
	return {
		"type": "hello",
		"protocol": PROTOCOL,
		"receiver": receiver,
		"credit_stage": credit_stage,
		"inbound_buffer_bytes": inbound_bytes,
	}


## The /7 hello (render-stream-7.md "Hello", gate7-design.md Q2), in the documented key order.
## `token` and `manifest_sha256` are "" for JSON null.
## `protocol` (G8g) is PROTOCOL_V8 on a render-stream.8 connection; the keys are /7's.
static func hello_v7(receiver: String, receiver_kind: String, credit_stage: String, credit_window: int, inbound_bytes: int, token: String, manifest_sha256: String, backing: Vector2i, css: Vector2i, dpr_milli: int, protocol: String = PROTOCOL_V7) -> Dictionary:
	return {
		"type": "hello",
		"protocol": protocol,
		"receiver": receiver,
		"receiver_kind": receiver_kind,
		"credit_stage": credit_stage,
		"credit_window": credit_window,
		"inbound_buffer_bytes": inbound_bytes,
		"token": null if token == "" else token,
		"manifest_sha256": null if manifest_sha256 == "" else manifest_sha256,
		"presentation_backing_w": backing.x,
		"presentation_backing_h": backing.y,
		"presentation_css_w": css.x,
		"presentation_css_h": css.y,
		"dpr_milli": dpr_milli,
	}


## Whether `text` is exactly 64 lowercase hex digits (a /7 token or a manifest sha256).
static func is_hex64(text: String) -> bool:
	if text.length() != 64:
		return false
	for i: int in text.length():
		var c: String = text[i]
		if not ((c >= "0" and c <= "9") or (c >= "a" and c <= "f")):
			return false
	return true


static func ack(stream_id: String, seq: int, stage: String, t_us: int) -> Dictionary:
	return {"type": "ack", "stream_id": stream_id, "seq": seq, "stage": stage, "t_us": t_us}


static func resync(stream_id: String, seq: int, reason: String) -> Dictionary:
	return {"type": "resync", "stream_id": stream_id, "seq": seq, "reason": reason}


## A host text message: {ok: bool, reason: String, detail: String}. ok is true only for a
## well-formed {"type":"error","reason":<str>,"detail":<str>} (the only text the host sends).
static func parse_host_text(text: String) -> Dictionary:
	var out: Dictionary = {"ok": false, "reason": "", "detail": text}
	var json := JSON.new()
	if json.parse(text) != OK or typeof(json.data) != TYPE_DICTIONARY:
		return out
	var message: Dictionary = json.data
	if message.size() != 3 or message.get("type") != "error":
		return out
	var reason: Variant = message.get("reason")
	var detail: Variant = message.get("detail")
	if typeof(reason) != TYPE_STRING or typeof(detail) != TYPE_STRING:
		return out
	out["ok"] = true
	out["reason"] = reason
	out["detail"] = detail
	return out


## G8kp: the /9 hello (render-stream-9.md "Live transport"): /7's fourteen keys under protocol
## render-stream/9, then texture_encodings and gpu_formats (texture-delivery-design.md D3, Q3).
## CG1: `protocol` "render-stream/10" gives /10's hello (render-stream-10.md "Live transport": /9's
## fifteen keys under protocol render-stream/10).
static func hello_v9(v7: Dictionary, texture_encodings: String, gpu_formats: String, protocol: String = PROTOCOL_V9) -> Dictionary:
	var out: Dictionary = v7.duplicate()
	out["protocol"] = protocol
	out["texture_encodings"] = texture_encodings
	out["gpu_formats"] = gpu_formats
	return out
