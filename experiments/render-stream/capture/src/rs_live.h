// Live delivery (gate 1 G1c2 as rs1_live; render-stream/2 since gate 2 G2b2): per-connection
// credit-based delivery over a WebSocket transport, the receiver control-message parser, the
// per-connection live log and tap, and the live summary (protocol/gate1-design.md "Q4. Delivery
// model" and "G1c2"; protocol/render-stream-2.md "Live transport").
//
// Resources (G2b2, gate2-design.md "G2b2: Live before HTTP"): until G2c2 every live connection
// declares `delivery: "inline"` and `fetch: "none"` (the caller's session template says so) and
// carries every payload its transactions name as `resource` records: before a transaction goes
// out, each `ok` image hash of its snapshot that this connection has not carried yet is sent as
// one resource record per binary message, in the same credit window, in table (id) order. A
// resource record larger than the message cap is `message-too-large` like a transaction. A
// resync keeps what the connection already carried; a new connection carries everything again.
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
//
// Files, when a tap directory is configured (GRC_LIVE_TAP_DIR):
//   stream-<connection>.rs2   the exact bytes of every binary message formed for that connection
//                             (sent, or dropped by the sabotage), in order: a valid stream.
//   live-<connection>.jsonl   one line per frame callback while the connection exists, plus
//                             event lines (open, hello, ack, resync, close, error).
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
bool parse_control(const std::string &text, ControlMessage *out, std::string *error);

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

struct LiveConfig {
  std::uint64_t max_message_bytes = 16u << 20;  // GRC_LIVE_MAX_MESSAGE_BYTES
  std::uint64_t hello_timeout_ms = 5000;        // GRC_LIVE_HELLO_TIMEOUT_MS
  std::string tap_dir;                          // GRC_LIVE_TAP_DIR; empty: no tap, no log
  // Sabotage frames; 0 disables each.
  std::uint64_t drop_message_frame = 0;
  std::uint64_t ignore_credit_frame = 0;   // G1d
  std::uint64_t stale_coalesce_frame = 0;  // G1d
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
  std::uint64_t max_message_sent = 0;  // the largest binary message formed (magic + session incl.)
  std::uint64_t resyncs = 0;
  std::uint64_t acks[3] = {0, 0, 0};  // received, applied, submitted
  std::uint64_t acks_ignored = 0;     // stale seq or foreign stream_id
  std::uint64_t credits = 0;          // credit returns (acks at the credit stage + resyncs)
  std::uint64_t bytes_sent = 0;       // binary message bytes handed to the transport
  std::uint64_t resource_records = 0;  // G2b2: inline resource records sent (payloads carried)
  std::uint64_t resource_bytes = 0;    // G2b2: their payload bytes
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

  // True when on_frame needs a snapshot at callback `frame`: a connection holds a received
  // hello, or is streaming with credit (or, under the G1d sabotages, would send without credit
  // or keep a stale copy).
  bool wants_snapshot(std::uint64_t frame) const;

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
  std::string summary_json() const;
  std::size_t connections() const { return conns_.size(); }

 private:
  enum class State : std::uint8_t { AwaitHello, Streaming, Closed };
  struct Conn;

  Conn *find(std::uint32_t conn_id);
  void handle_text(Conn &c, const LiveEvent &event, std::uint64_t frame);
  void protocol_error(Conn &c, const std::string &detail, std::uint64_t frame, std::uint64_t t_ns);
  void host_close(Conn &c, std::uint16_t code, const std::string &reason);
  bool deliver(Conn &c, const std::vector<std::uint8_t> &message, bool send);
  // Forms, encodes and sends (or, under drop-message, only taps) the next transaction. Returns
  // the live log's `sent` object, or "null" when the connection was closed instead.
  // `stale_from` (stale-coalesce) is the frame the snapshot was taken at, 0 otherwise.
  std::string send_transaction(Conn &c, const rs::Captured &snapshot, std::uint64_t frame,
                               std::uint64_t now_ns, std::uint64_t epoch,
                               std::uint64_t snapshot_ns, bool first,
                               std::uint64_t stale_from = 0);
  void note_pending_age(Conn &c, std::uint64_t frame, std::uint64_t now_ns);
  void log_frame(Conn &c, std::uint64_t frame, std::uint64_t now_ns, bool credit_before,
                 const std::string &sent_json);
  void log_line(Conn &c, const std::string &line);
  void close_files(Conn &c);

  LiveTransport *transport_;
  LiveConfig config_;
  Session template_;
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
