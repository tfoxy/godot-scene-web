// Live delivery (gate 1 G1c2 as rs1_live; render-stream/2 since gate 2 G2b2): per-connection
// credit-based delivery over a WebSocket transport, the receiver control-message parser, the
// per-connection live log and tap, and the live summary (protocol/gate1-design.md "Q4. Delivery
// model" and "G1c2"; protocol/render-stream-2.md "Live transport").
//
// Resources (G2b2 inline, G2c2 over HTTP; gate2-design.md Q4): every live connection declares the
// configured policy (the caller's session template): payloads of at most `inline_max_bytes` go
// in band as `resource` records -- before a transaction goes out, each `ok` image hash of its
// snapshot that this connection has not carried yet and that is small enough is sent as one
// resource record per binary message, in the same credit window, in table (id) order; a resource
// record larger than the message cap is `message-too-large` like a transaction; a resync keeps
// what the connection already carried, a new connection carries everything again -- and every
// larger payload is fetched by the receiver over HTTP (`fetch: "http"`) from the same listener.
// `carried` is never pruned: render-stream-2.md's resource-duplicate rule ("each hash at most
// once" per stream) makes that a correctness requirement, not an oversight (confirmed the hard
// way, gate6-design.md G6s: a hash that recurs, such as a mesh surface's periodic pose, must
// never be carried a second time), so a long-running connection's set holds one entry per
// distinct hash it has ever sent, for its whole life.
// The hub does not serve HTTP itself: it reports what each connection pins (the payloads of its
// base, the last transaction sent on it; base_payloads()) so the caller's ServedResources
// (rs_resource_store.h) keeps them servable until the next transaction, and it attributes every
// GET the server answered to the connection streaming at the time (on_http_get).
//
// Engine-free and transport-agnostic: the Hub drives an abstract LiveTransport (production:
// ServerTransport over grc::live::Server, rs_ws.h; tests: a fake), and takes snapshots that the
// caller already formed (entry.cpp: the publisher's one published copy per frame). Everything
// here runs on the main thread, at the frame callback; nothing blocks on a socket (the transport
// only enqueues).
//
// Delivery, per connection (Q4 "Per-connection state", "Frame callback"):
//   await-hello  nothing is sent before the receiver's `hello`; at the first frame callback after
//                it, the magic + session record (one message) and seq 1 (full) go out.
//                No hello within the hello timeout -> error `hello-timeout`, close 1002.
//   streaming    one transaction in flight at most: a transaction is formed and sent only at a
//                frame callback that holds credit, as a patch against the last one sent (or full
//                after a resync). Credit returns when an `ack` with the declared credit stage and
//                the in-flight seq arrives, or a `resync` for the in-flight seq (which also makes
//                the next transaction full). Other acks feed timing only. Without credit, a
//                mirror change since the last send marks the connection `pending` and counts one
//                `coalesced` callback; the pending target is the mirror itself, never a queued
//                copy, so obsolete targets are never serialized. At most one target is pending
//                per connection (`pending` is a flag, not a queue); the frame and time it became
//                pending are kept, so the log and the summary carry the oldest pending target's
//                age (G1d). When credit returns, the next transaction is formed from the
//                newest state at that callback.
//   closed       after a close from either side; nothing more is sent or logged.
// A transaction larger than min(hello.inbound_buffer_bytes, max_message_bytes) is the error
// `message-too-large` and close 1009. A malformed or out-of-order control message is the error
// `protocol` and close 1002 (the close reason repeats the error's reason, since a Godot client may
// never read a text message that arrives together with the close frame). At finish (shutdown or
// disarm) every streaming connection gets its end record whether or not it holds credit; the
// receiver closes after reading it, and close_open() closes whatever is left with 1000.
//
// Rate control (gate6-design.md D8, Q3c, G6r): GRC_PUBLISH_FPS configures LiveConfig::
// publish_period_ns (0 = uncapped, today's behaviour: a transaction at every frame callback that
// holds credit). With a target, connection c publishes at tick k, due at t0 + k*P (P = the
// period, t0 the connection's first send). A due tick without credit stays due (never advances
// the schedule) and is counted in ticks_credit_blocked; a due tick with credit sends and advances
// the schedule to the next tick after "now" (skipping any missed ticks -- never bursting to catch
// up); a callback with credit but no tick due counts as frames_rate_idle and sends nothing. File
// sinks are untouched by this: they are a separate Publisher (entry.cpp), not a Hub connection.
//
// Multi-connection admission (D13, G6r): GRC_LIVE_MAX_CONNECTIONS (entry.cpp, ServerConfig::
// max_clients) is the actual admission limit -- a connection beyond it never reaches the Hub (the
// transport refuses the WebSocket upgrade with 503). The Hub already keeps every connection's
// delivery state independently (conns_, a map), so nothing here changes for N > 1 connections
// except GET attribution (on_http_get): with more than one connection open, a resource GET is
// not attributable to a specific receiver (D13 "HTTP GETs are counted per host, not attributed"),
// so it is counted at the host level only (the caller's ServingSummary) and no connection's
// summary or live log gains a line for it.
//
// Sabotages handled here:
//   drop-message    the first transaction formed at a frame >= the sabotage frame is encoded,
//                   logged and written to the tap but not sent, and its credit is restored at
//                   once, so the next transaction reaches the receiver with a seq gap. (The
//                   contract says "at exactly that frame"; a transaction is only formed at a
//                   frame that holds credit, so "exactly" would make the sabotage depend on the
//                   credit phase. See gate1-design.md G1c2 "As built".)
//   ignore-credit   (G1d) from the sabotage frame on, a transaction is formed and sent at every
//                   frame callback while streaming, credit or not: several in flight at once.
//   stale-coalesce  (G1d) from the sabotage frame on, the first missed target (the snapshot of
//                   the first callback that coalesced since the last send) is kept, and when
//                   credit returns that copy is sent instead of the newest state, labelled with
//                   the current frame. The next transaction patches from it to the newest state.
//                   At window w >= 2 (G7q) a send made while that stale send still holds its slot
//                   repeats the stale copy (labelled stale_from too), so a receiver that folds
//                   them into one apply still draws the stale state, as at window 1; the next
//                   send after its credit patches to the newest state.
//   window-overrun  (G7q, a listener sabotage: entry.cpp, LiveConfig::window_overrun_frame) from
//                   the sabotage frame on, a connection whose window is full still sends at every
//                   due tick (rate control still applies, unlike ignore-credit): the third in
//                   flight at window 2, and every one after. Each such send counts in
//                   sent_without_credit and takes the newest window slot from the oldest seq.
//
// Files, when a tap directory is configured (GRC_LIVE_TAP_DIR):
//   stream-<connection>.rs2   the exact bytes of every binary message formed for that connection
//                             (sent, or dropped by the sabotage), in order: a valid stream.
//   live-<connection>.jsonl   one line per frame callback while the connection exists, plus
//                             event lines (open, hello, ack, resync, close, error, resource and,
//                             since G2c2, http-get).
// render-stream/7 (gate7-design.md D2, D3, D4, Q2, Q3; G7n): every connection speaks the version
// its WebSocket subprotocol chose (LiveEvent::subprotocol): `render-stream.7` makes it a /7
// connection, anything else the template's version (/6 in production). Its version drives its
// session record (magic, protocol string, `publication.credit_window`), the protocol its hello must
// announce, and the hello's shape (parse_control). One published snapshot per frame still serves
// every connection; records past the session are byte-identical between /6 and /7. On a /7
// connection:
//   - token: when LiveConfig::auth_token is set (a `resources.auth: "bearer"` session; the
//     upgrade itself is not bearer-checked at /7, rs_ws.h), a hello whose `token` is null or
//     differs (constant time) is the error `unauthorized` and close 1008 with reason
//     `unauthorized`; nothing was sent before it and nothing is after. The hello line of the live
//     log carries every hello key except `token`, plus `token_ok`. The token-ignored sabotage
//     (LiveConfig::token_ignored) skips the refusal; `token_ok` still records the comparison.
//   - window: the host grants w = min(credit_window, LiveConfig::credit_window_max,
//     kHostCreditWindow) and declares it as the session's `publication.credit_window`.
//     GRC_LIVE_CREDIT_WINDOW_MAX defaults to 2 (fork F1 resolved, G7wd); window 1 is explicit.
//   - window w (G7q; render-stream-7.md "Credit with window w"): up to w sent transactions hold a
//     window slot each; a callback with a free slot (and, under rate control, a due tick) sends.
//     Each transaction is still a patch against the last one sent, so a receiver applies them in
//     order, possibly several in one frame. Each slot returns on its own seq's credit-stage ack
//     (acks are per seq, as at window 1), or on a resync for it, which also frees every later
//     slot (the receiver ignores patches until the full transaction the resync forces; the live
//     log's resync line lists them as `discarded`). Pins cover every in-flight transaction's
//     payloads (base_payloads), not only the last sent's. A window-2 connection's frame lines
//     add `in_flight_seqs` (every slot, oldest first; `in_flight` stays the newest). Window 1 is
//     byte for byte the delivery above (test/rs_live_window_test.cpp's pinned transcripts).
// A /6 connection is byte for byte what it was before G7n.
#ifndef GRC_RS_LIVE_H
#define GRC_RS_LIVE_H

#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "rs2_snapshot.h"
#include "rs_captured.h"
#include "rs_histogram.h"

namespace grc {

namespace live {
class Server;
struct Event;
}  // namespace live

namespace rs2 {

// ----------------------------------------------------------------------------- control messages

enum class AckStage : std::uint8_t { Received, Applied, Submitted };
const char *to_wire(AckStage stage);

enum class ControlType : std::uint8_t { Hello, Ack, Resync, Error };

// One parsed control message (render-stream-1.md "Live transport", unchanged at /2 except for the
// hello's protocol string). Only the fields of `type`
// are meaningful.
struct ControlMessage {
  ControlType type = ControlType::Hello;
  // hello
  std::string protocol;
  std::string receiver;
  AckStage credit_stage = AckStage::Submitted;  // received is never a valid credit stage
  std::uint64_t inbound_buffer_bytes = 0;
  // hello, /7 only (render-stream-7.md "Hello", gate7-design.md Q2). Parsing only -- no Hub
  // behaviour reads these yet (G7n).
  std::string receiver_kind;  // "native" | "web-export" | "gsw-canvas"
  std::uint64_t credit_window = 1;
  bool has_token = false;  // false -> the hello's "token" was null
  std::string token;       // 64 lowercase hex when has_token
  bool has_manifest_sha256 = false;
  std::string manifest_sha256;  // 64 lowercase hex when has_manifest_sha256
  std::uint64_t presentation_backing_w = 0;
  std::uint64_t presentation_backing_h = 0;
  std::uint64_t presentation_css_w = 0;
  std::uint64_t presentation_css_h = 0;
  std::uint64_t dpr_milli = 0;
  // ack, resync
  std::string stream_id;
  std::uint64_t seq = 0;
  // ack
  AckStage stage = AckStage::Received;
  std::uint64_t t_us = 0;
  // resync, error
  std::string reason;
  // error
  std::string detail;
};

// Parses one control message: a flat JSON object (no nesting, no arrays, no booleans, no null,
// no floats), whose keys -- in any order, each exactly once -- are exactly the documented keys of
// its `type`; numbers are non-negative integers <= 2^53 - 1. Whitespace between tokens is
// allowed. `stream_id` is 32 lowercase hex; `seq` >= 1; `credit_stage` is submitted or applied;
// `stage` is received, applied or submitted. Accepts the host's own `error` too (so the golden
// error message parses), although the host treats one arriving from a receiver as a protocol
// error. Returns false with *error set on anything else.
// `version` (G4e2) selects the hello protocol a receiver must announce: "render-stream/2" (the
// default, golden-2's control vectors), "render-stream/3" (render-stream-3.md "Live transport")
// or "render-stream/4" (render-stream-4.md "Live transport"; what the capture speaks since G5d).
// At ProtocolVersion::V7 the hello has nine more keys (render-stream-7.md "Hello", gate7-design.md
// Q2): `receiver_kind`, `credit_window`, `token`, `manifest_sha256` and five presentation
// integers; `token`/`manifest_sha256` may be JSON `null`, the only place this parser accepts it.
bool parse_control(const std::string &text, ControlMessage *out, std::string *error,
                   ProtocolVersion version = ProtocolVersion::V2);

// {"type":"error","reason":<reason>,"detail":<detail>}, compact, keys in that order.
std::string encode_error(const std::string &reason, const std::string &detail);

// ----------------------------------------------------------------------------- transport

// What the Hub needs from a WebSocket server. Every call must return without blocking.
class LiveTransport {
 public:
  virtual ~LiveTransport() = default;
  virtual bool send_binary(std::uint32_t conn, std::vector<std::uint8_t> message) = 0;
  virtual bool send_text(std::uint32_t conn, std::string message) = 0;
  virtual void close(std::uint32_t conn, std::uint16_t code, std::string reason) = 0;
  // Bytes enqueued and not yet written to the socket, and the connection's high-water mark.
  virtual std::uint64_t queued_bytes(std::uint32_t conn) const = 0;
  virtual std::uint64_t max_queued_bytes(std::uint32_t conn) const = 0;
};

// The production transport: grc::live::Server (rs_ws.h).
class ServerTransport : public LiveTransport {
 public:
  explicit ServerTransport(live::Server *server) : server_(server) {}
  bool send_binary(std::uint32_t conn, std::vector<std::uint8_t> message) override;
  bool send_text(std::uint32_t conn, std::string message) override;
  void close(std::uint32_t conn, std::uint16_t code, std::string reason) override;
  std::uint64_t queued_bytes(std::uint32_t conn) const override;
  std::uint64_t max_queued_bytes(std::uint32_t conn) const override;

 private:
  live::Server *server_;
};

// ----------------------------------------------------------------------------- hub

// The largest credit window the host implements (render-stream-7.md "Publication"; G7q, fork F1).
// The grant is also capped by GRC_LIVE_CREDIT_WINDOW_MAX, default 2 (G7wd); a hello asking 1 is still granted 1.
inline constexpr std::uint64_t kHostCreditWindow = 2;

// The subprotocol that makes a connection /7 (render-stream-7.md "Live transport").
inline constexpr const char *kSubprotocolV7 = "render-stream.7";

struct LiveConfig {
  std::uint64_t max_message_bytes = 16u << 20;  // GRC_LIVE_MAX_MESSAGE_BYTES
  std::uint64_t hello_timeout_ms = 5000;        // GRC_LIVE_HELLO_TIMEOUT_MS
  std::string tap_dir;                          // GRC_LIVE_TAP_DIR; empty: no tap, no log
  // GRC_PUBLISH_FPS (D8, Q3c, G6r): 0 = uncapped (every frame callback that holds credit, today's
  // behaviour, byte for byte); otherwise the steady-clock period between ticks, 1e9 / target_fps
  // ns (target_fps 1..240). Live connections only -- a Publisher file sink never rate-limits.
  std::uint64_t publish_period_ns = 0;
  std::uint64_t publish_target_fps = 0;  // 0 when uncapped; reported in the summary only
  // Sabotage frames; 0 disables each.
  std::uint64_t drop_message_frame = 0;
  std::uint64_t ignore_credit_frame = 0;   // G1d
  std::uint64_t stale_coalesce_frame = 0;  // G1d
  std::uint64_t window_overrun_frame = 0;  // G7q (a listener sabotage, rs_live.h header)
  // G7n: GRC_LIVE_CREDIT_WINDOW_MAX (1..2, default 2); every grant is also capped at
  // kHostCreditWindow.
  std::uint64_t credit_window_max = 2;
  // G7n: the session's bearer token (GRC_LIVE_AUTH=token), checked against a /7 hello's `token`;
  // empty: no session auth, a /7 hello's token is not checked (`token_ok` null).
  std::string auth_token;
  bool token_ignored = false;  // G7n sabotage token-ignored: a wrong /7 token is not refused.
};

// One connection's transport-level event, as the caller drains it from the server. `t_ns` is
// steady_clock nanoseconds when the I/O thread observed it.
struct LiveEvent {
  enum Kind { Opened, Text, Closed } kind = Opened;
  std::uint32_t conn = 0;
  std::string text;
  std::uint16_t code = 0;
  std::string reason;
  std::uint64_t t_ns = 0;
  // Opened only (G7n): the subprotocol the upgrade chose ("" in tests that predate G7n: the
  // template's version) and the upgrade's Origin ("" when it carried none).
  std::string subprotocol;
  std::string origin;
};
LiveEvent to_live_event(const live::Event &event);

// min / median / p95 / max of a sample set, in microseconds; count 0 means empty.
struct LatencyStats {
  std::uint64_t count = 0;
  std::uint64_t min = 0;
  std::uint64_t median = 0;
  std::uint64_t p95 = 0;
  std::uint64_t max = 0;
};
LatencyStats latency_stats(std::vector<std::uint64_t> samples_us);

// The per-connection summary (gate1-design.md Q7 report `live.connections[]`, plus the delivery
// counters gate 1c reports).
struct ConnectionSummary {
  std::uint32_t connection = 0;
  std::string stream_id;  // empty until the hello
  std::string receiver;
  std::string credit_stage;  // "" until the hello
  std::uint64_t inbound_buffer_bytes = 0;
  // G7n (gate7-design.md Q3 "Evidence"). `version`: the connection's protocol (2..7, from its
  // subprotocol). The rest come from a /7 hello and stay unset ("" / has_hello7 false) on a /6
  // connection or before the hello: receiver_kind, the requested and granted credit window,
  // manifest_sha256 ("" for null), the five presentation integers. `credit_window` is the grant
  // (1 on every /6 connection: one transaction in flight). `origin` is the upgrade's Origin ("" =
  // none). `token_checked`/`token_ok`: whether a token was checked (a bearer session) and the
  // result; a /6 connection on a bearer session passed the upgrade's bearer check, so it is
  // checked and ok. `preflights`: CORS preflights answered while this connection was the only
  // one open (attributed as GETs are, on_http_get).
  std::uint32_t version = 0;
  bool has_hello7 = false;
  std::string receiver_kind;
  std::uint64_t credit_window_requested = 0;
  std::uint64_t credit_window = 1;
  std::string manifest_sha256;
  std::uint64_t presentation_backing_w = 0;
  std::uint64_t presentation_backing_h = 0;
  std::uint64_t presentation_css_w = 0;
  std::uint64_t presentation_css_h = 0;
  std::uint64_t dpr_milli = 0;
  std::string origin;
  bool token_checked = false;
  bool token_ok = false;
  std::uint64_t preflights = 0;
  std::uint64_t max_message_bytes = 0;
  std::uint64_t frames_offered = 0;  // frame callbacks while streaming (each offers a target)
  std::uint64_t transactions = 0;    // formed: sent + dropped
  std::uint64_t sent = 0;
  std::uint64_t dropped = 0;
  std::uint64_t full = 0;
  std::uint64_t patch = 0;
  std::uint64_t coalesced = 0;
  // Pending targets (G1d): at most one per connection at any time (`max_pending` is 0 or 1); how
  // many times a target became pending, and the oldest a pending target got before a send
  // replaced it, in host frames and in microseconds of the frame callback's clock.
  std::uint64_t max_pending = 0;
  std::uint64_t pending_episodes = 0;
  std::uint64_t max_pending_frames = 0;
  std::uint64_t max_pending_age_us = 0;
  // Sabotage evidence (G1d): sends made without credit (ignore-credit) and stale copies sent
  // (stale-coalesce). Both stay 0 without the sabotage.
  std::uint64_t sent_without_credit = 0;
  std::uint64_t stale_sent = 0;
  std::uint64_t max_in_flight = 0;  // sent seqs whose credit-stage ack had not arrived
  std::uint64_t max_queued_bytes = 0;
  // Rate-control counters (D8, Q3c, G6r); all 0 under the default GRC_PUBLISH_FPS=uncapped.
  std::uint64_t ticks_due = 0;             // callbacks where the schedule had a tick due
  std::uint64_t ticks_sent = 0;             // due ticks that sent (a subset of `sent`)
  std::uint64_t ticks_credit_blocked = 0;   // due ticks with no credit
  std::uint64_t frames_rate_idle = 0;       // callbacks with credit but no tick due yet
  std::uint64_t max_message_sent = 0;  // the largest binary message formed (magic + session incl.)
  std::uint64_t resyncs = 0;
  std::uint64_t acks[3] = {0, 0, 0};  // received, applied, submitted
  std::uint64_t acks_ignored = 0;     // stale seq or foreign stream_id
  std::uint64_t credits = 0;          // credit returns (acks at the credit stage + resyncs)
  std::uint64_t bytes_sent = 0;       // binary message bytes handed to the transport
  std::uint64_t resource_records = 0;  // G2b2: inline resource records sent (payloads carried)
  std::uint64_t resource_bytes = 0;    // G2b2: their payload bytes
  // G6s (gate6-design.md Q7e "soak-inline"): the connection's carried-hash set's CURRENT size
  // (not accumulated -- Hub::summaries() fills this fresh from Conn::carried each call), for the
  // perf timeline's first-third/last-third residency comparison.
  std::uint64_t carried_size = 0;
  // G2c2: resource GETs answered while this connection was the one streaming (on_http_get), the
  // bytes of the 200 bodies, and how many were not 200.
  std::uint64_t http_gets = 0;
  std::uint64_t http_bytes = 0;
  std::uint64_t http_errors = 0;
  bool end_sent = false;
  std::int64_t close_code = -1;  // -1: still open
  std::string closed_by;         // "host" | "receiver" | ""
  std::string close_reason;
  std::string error_sent;  // the reason of the one error message sent, if any
  // Host-side ack latency per stage: from the send of a seq to the I/O thread's receipt of that
  // seq's ack; and the credit round trip (send -> credit-returning message).
  LatencyStats ack_latency_us[3];
  LatencyStats credit_rtt_us;
  // Host frames between a send and the frame callback that consumed its credit.
  LatencyStats credit_rtt_frames;
  // G6c: running totals of the two above (count, sum of microseconds, sum of host frames), so a
  // per-second timeline gives the mean credit round trip of any window.
  std::uint64_t credit_rtt_count = 0;
  std::uint64_t credit_rtt_sum_us = 0;
  std::uint64_t credit_rtt_frames_sum = 0;
};

// The live host's HTTP serving totals (G2c2), for the summary's `resources` object: every GET
// the server answered (attributed or not), and the ServedResources totals.
struct ServingSummary {
  std::uint64_t http_gets = 0;
  std::uint64_t http_bytes = 0;
  std::uint64_t http_errors = 0;
  std::uint64_t preflights = 0;       // G7n: OPTIONS answered 204 (not counted in http_gets)
  std::uint64_t origin_rejected = 0;  // G7n: 403s for a foreign Origin, every route
  std::uint64_t pinned = 0;
  std::uint64_t retired = 0;
  std::uint64_t retired_unpinned = 0;
  std::uint64_t retained_max = 0;
  std::uint64_t retained_bytes_max = 0;
  std::uint64_t retained_end = 0;
  std::uint64_t retained_bytes_end = 0;
  std::uint64_t budget_bytes = 0;
  std::string dropped_hash;
  std::string corrupted_hash;
};

class Hub {
 public:
  // `session_template` is the session every connection's stream starts with; the hub fills
  // `stream` (fresh stream_id, connection n, transport websocket, encoding patch).
  Hub(LiveTransport *transport, LiveConfig config, Session session_template);
  ~Hub();
  Hub(const Hub &) = delete;
  Hub &operator=(const Hub &) = delete;

  // Feeds one transport event, at frame callback `frame` (the caller drains every event first,
  // then calls on_frame for the same callback).
  void on_event(const LiveEvent &event, std::uint64_t frame);

  // True when on_frame needs a snapshot at callback `frame`/`now_ns`: a connection holds a
  // received hello, or is streaming with credit and (under rate control, G6r) a tick due at
  // `now_ns` (or, under the G1d sabotages, would send without credit or keep a stale copy).
  // `now_ns` is unused when every connection is uncapped (GRC_PUBLISH_FPS=uncapped, the default).
  bool wants_snapshot(std::uint64_t frame, std::uint64_t now_ns) const;

  // One frame callback. `snapshot` is the published state for `frame` (required when
  // wants_snapshot() was true; may be null otherwise); `epoch` the mirror's mutation epoch read
  // before it was copied; `snapshot_ns` its copy time (added to each sending stream's stats).
  void on_frame(std::uint64_t frame, std::uint64_t now_ns, const rs::Captured *snapshot,
                std::uint64_t epoch, std::uint64_t snapshot_ns);

  // Shutdown / disarm: the end record to every streaming connection, credit or not. It does NOT
  // close them: Godot's WebSocketPeer drops every message that arrives in the same poll() as a
  // close frame (wsl_peer.cpp: get_available_packet_count() is 0 once the state is not OPEN, and
  // a clean close clears in_buffer), so a close right behind the end record would hide it. The
  // caller lingers (feeding Closed events) until the receivers close after reading their end
  // record, then close_open() closes the rest with 1000. A connection still awaiting its hello is
  // closed at once. Only the first call does anything; afterwards only Closed events are taken.
  void finish(EndReason reason, std::uint64_t frame, std::uint64_t now_ns);
  // Connections not closed yet.
  std::size_t open_connections() const;
  // Closes every connection still open with 1000 and the finish reason (the end of the linger).
  void close_open(std::uint64_t frame);

  std::vector<ConnectionSummary> summaries() const;
  // render-stream-live-summary/1: {"schema", "connections":[...]} (pretty-printed).
  // `resources`, when given, is written as the summary's `resources` object (G2c2: the host's
  // serving totals, entry.cpp). `publication` (G6r) is always written: {"mode", "target_fps"}
  // from the hub's own LiveConfig (evidence form; not itself a wire field until G6b).
  std::string summary_json(const ServingSummary *resources = nullptr) const;
  std::size_t connections() const { return conns_.size(); }

  // Cross-connection histograms for perf.json (Q3d, G6r): the diff and encode costs measured in
  // send_transaction(), and the credit round trip and host-clock staleness (index 1 = applied,
  // index 2 = submitted; index 0 is never populated -- received is never a credit stage).
  const Histogram &diff_histogram() const { return diff_hist_; }
  const Histogram &encode_histogram() const { return encode_hist_; }
  const Histogram &enqueue_histogram() const { return enqueue_hist_; }
  const Histogram &credit_rtt_histogram(AckStage stage) const {
    return credit_rtt_hist_[static_cast<std::size_t>(stage)];
  }
  const Histogram &staleness_histogram(AckStage stage) const {
    return staleness_hist_[static_cast<std::size_t>(stage)];
  }

  // G2c2 pins (gate2-design.md D7): the payloads of the last transaction sent on every connection
  // that is not closed (its base), and of every stale-coalesce copy a connection may still send.
  std::vector<const rs::PayloadMap *> base_payloads() const;
  std::vector<const rs::PayloadMap *> held_payloads() const;
  // G2c2: one resource GET the server answered. It is attributed to the connection streaming at
  // the time (one receiver at a time), counted in its summary and logged as an `http-get` event
  // line in its live log. Returns that connection's number, or 0 when none was streaming.
  // `preflight` (G7n): an OPTIONS preflight instead, counted in `preflights` (never `http_gets`)
  // and logged as a `preflight` event line.
  std::uint32_t on_http_get(const std::string &hash, std::uint16_t status, std::uint64_t bytes,
                            std::uint64_t t_ns, std::uint64_t frame, bool preflight = false);

 private:
  enum class State : std::uint8_t { AwaitHello, Streaming, Closed };
  struct Conn;

  Conn *find(std::uint32_t conn_id);
  void handle_text(Conn &c, const LiveEvent &event, std::uint64_t frame);
  void protocol_error(Conn &c, const std::string &detail, std::uint64_t frame, std::uint64_t t_ns);
  // G7n: error `reason` with `detail`, logged, then close `code` with `reason` as its reason.
  void error_close(Conn &c, const std::string &reason, const std::string &detail,
                   std::uint16_t code, std::uint64_t frame, std::uint64_t t_ns);
  void host_close(Conn &c, std::uint16_t code, const std::string &reason);
  bool deliver(Conn &c, const std::vector<std::uint8_t> &message, bool send);
  // Forms, encodes and sends (or, under drop-message, only taps) the next transaction. Returns
  // the live log's `sent` object, or "null" when the connection was closed instead.
  // `stale_from` (stale-coalesce) is the frame the snapshot was taken at, 0 otherwise.
  // `capture_ns` (G6r Q3c "Staleness") is the frame callback's time the snapshot was captured at
  // -- `now_ns` for a fresh send, or the earlier time it was set aside for a stale-coalesce send.
  std::string send_transaction(Conn &c, const rs::Captured &snapshot, std::uint64_t frame,
                               std::uint64_t now_ns, std::uint64_t epoch,
                               std::uint64_t snapshot_ns, bool first, std::uint64_t capture_ns,
                               std::uint64_t stale_from = 0);
  void note_pending_age(Conn &c, std::uint64_t frame, std::uint64_t now_ns);
  void log_frame(Conn &c, std::uint64_t frame, std::uint64_t now_ns, bool credit_before,
                 const std::string &sent_json);
  void log_line(Conn &c, const std::string &line);
  void close_files(Conn &c);

  // Returns true when `now_ns` is at or past a connection's next due tick (G6r); always true
  // under GRC_PUBLISH_FPS=uncapped (config_.publish_period_ns == 0) or before its schedule has
  // started (its very first send, right after the hello, is never rate-gated).
  bool tick_due(const Conn &c, std::uint64_t now_ns) const;
  // Starts (first send) or advances (every later send) a connection's schedule after it sends at
  // `now_ns`. No-op under GRC_PUBLISH_FPS=uncapped.
  void advance_schedule(Conn &c, std::uint64_t now_ns);

  LiveTransport *transport_;
  LiveConfig config_;
  Session template_;
  Histogram diff_hist_;
  Histogram encode_hist_;
  Histogram enqueue_hist_;
  Histogram credit_rtt_hist_[3];
  Histogram staleness_hist_[3];
  std::map<std::uint32_t, std::unique_ptr<Conn>> conns_;  // by transport connection id
  std::uint32_t next_connection_ = 1;
  bool drop_done_ = false;
  bool finished_ = false;
  std::string finish_reason_;
  std::uint64_t frame_ = 0;  // the frame callback being processed (for log lines)
};

}  // namespace rs2
}  // namespace grc

#endif  // GRC_RS_LIVE_H
