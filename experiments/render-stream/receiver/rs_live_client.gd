class_name RsLiveClient
extends RefCounted
## The receiver's side of render-stream/2 live transport (render-stream-2.md "Live transport";
## gate1-design.md "Q2f", "Q5. Receiver", "G1c2"): a WebSocketPeer client, the control messages it
## sends (hello, ack, resync) and the one the host may send (error).
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

const SUBPROTOCOL: String = "render-stream.2"
const PROTOCOL: String = "render-stream/2"
const CREDIT_STAGES: Array[String] = ["submitted", "applied"]
const ACK_STAGES: Array[String] = ["received", "applied", "submitted"]

var peer: WebSocketPeer = null
var url: String = ""
var inbound_buffer_bytes: int = 0


## Starts connecting. `token` (G2e, gate2-design.md D13), when non-empty, is sent as
## "Authorization: Bearer <token>" on the upgrade request (WebSocketPeer.handshake_headers,
## modules/websocket/wsl_peer.cpp:551-552), set before connect_to_url like inbound_buffer_size --
## both are fixed at handshake time. A missing or wrong token gets HTTP 401 from the host, which
## this peer surfaces only as never reaching STATE_OPEN (Godot's WebSocketPeer exposes no HTTP
## status for a failed handshake); the caller's existing connect-timeout handling already covers
## that as replay-failure live-connect-failed. Returns connect_to_url()'s error.
func open(target_url: String, inbound_bytes: int, token: String = "") -> Error:
	url = target_url
	inbound_buffer_bytes = inbound_bytes
	peer = WebSocketPeer.new()
	# Before connect_to_url: the buffer (and wslay's message cap) is fixed at handshake time.
	peer.inbound_buffer_size = inbound_bytes
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
